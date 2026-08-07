#!/usr/bin/env python3
"""Read a SPIR-V module's descriptor bindings and its stage interface.

Two things have to be known about a shader before a Vulkan pipeline can be created for it,
and neither is guessable:

  - **the descriptor layout**, because a wrong one silently changes the generated code. Measured
    on this machine over one byte-identical VS/FS pair: the exact layout gives pixel
    e2d27b236f6d, substituting UNIFORM_BUFFER_DYNAMIC for UNIFORM_BUFFER gives de06f203bf3b at
    40 instructions instead of 48, and merely adding four bindings the shader never touches
    gives 0a206c89ea37 at the *same* 48. A superset is not a safe over-approximation.
  - **the stage interface**, because a fragment shader cannot be compiled without a producer,
    and a producer whose outputs do not match the consumer's inputs is a different pipeline.

Everything here is refusal-first. A construct this cannot map exactly raises `ReflectError`
rather than falling back to a default, because a plausible-but-wrong layout produces a
plausible-but-wrong listing and nothing downstream can detect it.

    py spirv_reflect.py <module.spv> [--json]

Standard library only, to keep the same no-dependency contract as `nvrtc_compile.py`.
"""

import json
import os
import struct
import sys

MAGIC = 0x07230203

# ------------------------------------------------------------------ the subset that matters

OP_NAME = 5
OP_ENTRY_POINT = 15
OP_TYPE_VOID = 19
OP_TYPE_BOOL = 20
OP_TYPE_INT = 21
OP_TYPE_FLOAT = 22
OP_TYPE_VECTOR = 23
OP_TYPE_MATRIX = 24
OP_TYPE_IMAGE = 25
OP_TYPE_SAMPLER = 26
OP_TYPE_SAMPLED_IMAGE = 27
OP_TYPE_ARRAY = 28
OP_TYPE_RUNTIME_ARRAY = 29
OP_TYPE_STRUCT = 30
OP_TYPE_POINTER = 32
OP_CONSTANT = 43
OP_VARIABLE = 59
OP_TYPE_ACCELERATION_STRUCTURE = 5341

DEC_BLOCK = 2
DEC_BUFFER_BLOCK = 3
DEC_BUILTIN = 11
DEC_LOCATION = 30
DEC_BINDING = 33
DEC_DESCRIPTOR_SET = 34
OP_DECORATE = 71

SC_UNIFORM_CONSTANT = 0
SC_INPUT = 1
SC_UNIFORM = 2
SC_OUTPUT = 3
SC_PUSH_CONSTANT = 9
SC_STORAGE_BUFFER = 12

DIM_BUFFER = 5
DIM_SUBPASS_DATA = 6

# VkDescriptorType, as integers because that is what a pipeline harness takes. Naming them
# here would add a table to keep in sync with Vulkan's for no gain.
SAMPLER = 0
COMBINED_IMAGE_SAMPLER = 1
SAMPLED_IMAGE = 2
STORAGE_IMAGE = 3
UNIFORM_TEXEL_BUFFER = 4
STORAGE_TEXEL_BUFFER = 5
UNIFORM_BUFFER = 6
STORAGE_BUFFER = 7
INPUT_ATTACHMENT = 10
ACCELERATION_STRUCTURE = 1000150000

DESCRIPTOR_NAMES = {
    SAMPLER: "SAMPLER", COMBINED_IMAGE_SAMPLER: "COMBINED_IMAGE_SAMPLER",
    SAMPLED_IMAGE: "SAMPLED_IMAGE", STORAGE_IMAGE: "STORAGE_IMAGE",
    UNIFORM_TEXEL_BUFFER: "UNIFORM_TEXEL_BUFFER", STORAGE_TEXEL_BUFFER: "STORAGE_TEXEL_BUFFER",
    UNIFORM_BUFFER: "UNIFORM_BUFFER", STORAGE_BUFFER: "STORAGE_BUFFER",
    INPUT_ATTACHMENT: "INPUT_ATTACHMENT", ACCELERATION_STRUCTURE: "ACCELERATION_STRUCTURE",
}

EXEC_MODEL = {0: "vertex", 1: "tessellation_control", 2: "tessellation_evaluation",
              3: "geometry", 4: "fragment", 5: "compute"}


class ReflectError(Exception):
    """Something in the module could not be mapped exactly. Never swallowed."""


def parse(data):
    """Split a SPIR-V binary into (opcode, [operand words]) pairs.

    Both endiannesses are accepted because a module can legitimately be produced on either,
    and reading one as the other yields nonsense rather than an error.
    """
    if len(data) < 20 or len(data) % 4:
        raise ReflectError("not a SPIR-V module: %d bytes is not a whole number of words"
                           % len(data))
    little = struct.unpack_from("<I", data, 0)[0] == MAGIC
    if not little and struct.unpack_from(">I", data, 0)[0] != MAGIC:
        raise ReflectError("not a SPIR-V module: no 0x07230203 magic")
    words = struct.unpack(("<" if little else ">") + "%dI" % (len(data) // 4), data)

    out = []
    i = 5                                        # past magic, version, generator, bound, schema
    while i < len(words):
        head = words[i]
        count = head >> 16
        if count == 0:
            raise ReflectError("zero-length instruction at word %d - module is corrupt" % i)
        if i + count > len(words):
            raise ReflectError("instruction at word %d runs past the end of the module" % i)
        out.append((head & 0xFFFF, words[i + 1:i + count]))
        i += count
    return out


class Module(object):
    def __init__(self, data):
        self.instructions = parse(data)
        self.types = {}                          # id -> (opcode, operands)
        self.constants = {}                      # id -> value
        self.names = {}                          # id -> debug name
        self.decorations = {}                    # id -> {decoration: [operands]}
        self.variables = []                      # (result_type_id, result_id, storage_class)
        self.entry_points = []                   # (stage, name)
        self._collect()

    def _collect(self):
        for op, w in self.instructions:
            if op == OP_NAME and len(w) >= 2:
                self.names[w[0]] = decode_string(w[1:])
            elif op == OP_ENTRY_POINT and len(w) >= 2:
                self.entry_points.append(
                    (EXEC_MODEL.get(w[0], "model%d" % w[0]), decode_string(w[2:])))
            elif op == OP_DECORATE and len(w) >= 2:
                self.decorations.setdefault(w[0], {})[w[1]] = list(w[2:])
            elif op == OP_CONSTANT and len(w) >= 3:
                self.constants[w[1]] = w[2]
            elif op == OP_VARIABLE and len(w) >= 3:
                self.variables.append((w[0], w[1], w[2]))
            elif op in (OP_TYPE_VOID, OP_TYPE_BOOL, OP_TYPE_INT, OP_TYPE_FLOAT, OP_TYPE_VECTOR,
                        OP_TYPE_MATRIX, OP_TYPE_IMAGE, OP_TYPE_SAMPLER, OP_TYPE_SAMPLED_IMAGE,
                        OP_TYPE_ARRAY, OP_TYPE_RUNTIME_ARRAY, OP_TYPE_STRUCT, OP_TYPE_POINTER,
                        OP_TYPE_ACCELERATION_STRUCTURE):
                self.types[w[0]] = (op, list(w[1:]))

    # ---------------------------------------------------------------- descriptors

    def descriptors(self):
        """Every descriptor the module declares, as {set, binding, type, count, name}.

        Ordered by (set, binding) so two modules of the same pipeline merge deterministically.
        """
        out = []
        for type_id, result_id, storage in self.variables:
            dec = self.decorations.get(result_id, {})
            if DEC_BINDING not in dec and DEC_DESCRIPTOR_SET not in dec:
                continue
            if DEC_BINDING not in dec or DEC_DESCRIPTOR_SET not in dec:
                raise ReflectError(
                    "%s carries only one of DescriptorSet/Binding; a half-decorated resource "
                    "cannot be placed in a layout" % self.label(result_id))

            pointee = self.pointee(type_id, result_id)
            count, inner = self.unwrap_array(pointee, result_id)
            out.append({
                "set": dec[DEC_DESCRIPTOR_SET][0],
                "binding": dec[DEC_BINDING][0],
                "type": self.descriptor_type(inner, storage, result_id),
                "count": count,
                "name": self.names.get(result_id, ""),
            })
        out.sort(key=lambda d: (d["set"], d["binding"]))
        self.check_collisions(out)
        return out

    def check_collisions(self, descriptors):
        seen = {}
        for d in descriptors:
            key = (d["set"], d["binding"])
            if key in seen and seen[key] != (d["type"], d["count"]):
                raise ReflectError(
                    "set %d binding %d is declared twice with different types (%s and %s)"
                    % (d["set"], d["binding"],
                       DESCRIPTOR_NAMES.get(seen[key][0], seen[key][0]),
                       DESCRIPTOR_NAMES.get(d["type"], d["type"])))
            seen[key] = (d["type"], d["count"])

    def pointee(self, type_id, who):
        entry = self.types.get(type_id)
        if not entry or entry[0] != OP_TYPE_POINTER:
            raise ReflectError("%s has no pointer type" % self.label(who))
        return entry[1][1]                        # (storage_class, pointee_type)

    def unwrap_array(self, type_id, who):
        """Descriptor count, and the element type underneath."""
        entry = self.types.get(type_id)
        if not entry:
            return 1, type_id
        if entry[0] == OP_TYPE_ARRAY:
            length_id = entry[1][1]
            if length_id not in self.constants:
                raise ReflectError(
                    "%s is an array whose length is a specialisation constant; the descriptor "
                    "count is not knowable from the module alone" % self.label(who))
            inner_count, inner = self.unwrap_array(entry[1][0], who)
            return self.constants[length_id] * inner_count, inner
        if entry[0] == OP_TYPE_RUNTIME_ARRAY:
            raise ReflectError(
                "%s is a runtime array (descriptor indexing); its count is decided at bind "
                "time and cannot be reflected" % self.label(who))
        return 1, type_id

    def descriptor_type(self, type_id, storage, who):
        entry = self.types.get(type_id)
        op = entry[0] if entry else None

        if storage == SC_UNIFORM_CONSTANT:
            if op == OP_TYPE_SAMPLER:
                return SAMPLER
            if op == OP_TYPE_SAMPLED_IMAGE:
                return COMBINED_IMAGE_SAMPLER
            if op == OP_TYPE_ACCELERATION_STRUCTURE:
                return ACCELERATION_STRUCTURE
            if op == OP_TYPE_IMAGE:
                # OpTypeImage: sampled-type, Dim, Depth, Arrayed, MS, Sampled, Format
                dim, sampled = entry[1][1], entry[1][5]
                if dim == DIM_SUBPASS_DATA:
                    return INPUT_ATTACHMENT
                if sampled == 1:
                    return UNIFORM_TEXEL_BUFFER if dim == DIM_BUFFER else SAMPLED_IMAGE
                if sampled == 2:
                    return STORAGE_TEXEL_BUFFER if dim == DIM_BUFFER else STORAGE_IMAGE
                raise ReflectError(
                    "%s is an image whose Sampled operand is %d (neither 1 nor 2), so it is "
                    "not knowably a sampled image or a storage image" % (self.label(who), sampled))
            raise ReflectError(
                "%s is in UniformConstant storage but is not a sampler, image or acceleration "
                "structure" % self.label(who))

        if storage == SC_UNIFORM:
            # The pre-1.3 spelling: Block is a UBO, BufferBlock an SSBO. The decoration is on
            # the struct type, not on the variable.
            dec = self.decorations.get(type_id, {})
            if DEC_BUFFER_BLOCK in dec:
                return STORAGE_BUFFER
            if DEC_BLOCK in dec:
                return UNIFORM_BUFFER
            raise ReflectError(
                "%s is in Uniform storage but its struct carries neither Block nor BufferBlock, "
                "so it is not knowably a uniform or a storage buffer" % self.label(who))

        if storage == SC_STORAGE_BUFFER:
            return STORAGE_BUFFER

        raise ReflectError(
            "%s has a descriptor decoration but storage class %d, which is not a descriptor "
            "storage class" % (self.label(who), storage))

    def push_constant_blocks(self):
        return [self.names.get(rid, "") for tid, rid, sc in self.variables
                if sc == SC_PUSH_CONSTANT]

    # ---------------------------------------------------------------- stage interface

    def interface(self, storage):
        """User-defined varyings in `storage`, as {location, type, name}.

        Built-ins are excluded deliberately: they carry no Location, they are matched by
        semantic rather than by slot, and a producer does not have to declare them to satisfy
        a consumer that reads them.
        """
        out = []
        for type_id, result_id, sc in self.variables:
            if sc != storage:
                continue
            dec = self.decorations.get(result_id, {})
            if DEC_BUILTIN in dec:
                continue
            if DEC_LOCATION not in dec:
                # A non-builtin varying with no Location cannot be matched to a slot.
                raise ReflectError(
                    "%s is a stage %s with no Location decoration" %
                    (self.label(result_id), "input" if storage == SC_INPUT else "output"))
            pointee = self.pointee(type_id, result_id)
            out.append({
                "location": dec[DEC_LOCATION][0],
                "type": self.slang_type(pointee, result_id),
                "name": self.names.get(result_id, ""),
            })
        out.sort(key=lambda v: v["location"])
        return out

    def slang_type(self, type_id, who):
        """The Slang spelling of a varying's type, or a refusal.

        Only the shapes a generated producer can declare and assign are mapped. Everything
        else raises: substituting an approximate type would change the interface, and the
        interface is exactly what is being matched.
        """
        entry = self.types.get(type_id)
        if not entry:
            raise ReflectError("%s has an unknown type" % self.label(who))
        op, w = entry

        if op == OP_TYPE_FLOAT:
            if w[0] == 32:
                return "float"
            if w[0] == 64:
                return "double"
            if w[0] == 16:
                return "half"
            raise ReflectError("%s is a %d-bit float" % (self.label(who), w[0]))
        if op == OP_TYPE_INT:
            if w[0] != 32:
                raise ReflectError("%s is a %d-bit integer" % (self.label(who), w[0]))
            return "int" if w[1] else "uint"
        if op == OP_TYPE_BOOL:
            raise ReflectError("%s is a bool, which has no interface representation"
                               % self.label(who))
        if op == OP_TYPE_VECTOR:
            return "%s%d" % (self.slang_type(w[0], who), w[1])
        if op == OP_TYPE_MATRIX:
            column = self.types.get(w[0])
            if not column or column[0] != OP_TYPE_VECTOR:
                raise ReflectError("%s is a matrix of something other than vectors"
                                   % self.label(who))
            return "%sx%d" % (self.slang_type(w[0], who), w[1])
        if op == OP_TYPE_ARRAY:
            if w[1] not in self.constants:
                raise ReflectError("%s is an array with a non-literal length" % self.label(who))
            return "%s[%d]" % (self.slang_type(w[0], who), self.constants[w[1]])
        if op == OP_TYPE_STRUCT:
            raise ReflectError(
                "%s is a struct varying; a generated producer would have to reproduce the whole "
                "type, which is not attempted" % self.label(who))
        raise ReflectError("%s has type opcode %d, which is not mapped" % (self.label(who), op))

    def label(self, result_id):
        name = self.names.get(result_id)
        return '"%s"' % name if name else "%%%d" % result_id


def decode_string(words):
    raw = b"".join(struct.pack("<I", w) for w in words)
    end = raw.find(b"\0")
    return raw[:end if end >= 0 else len(raw)].decode("utf-8", "replace")


# ------------------------------------------------------------------ producer synthesis

# The types a generated producer can declare AND assign a runtime value to. Anything outside
# this set is refused: a producer that declared a type it could not fill would either fail to
# compile or fill it with a constant the optimiser can propagate into the consumer - which
# changes the code being measured.
SCALARS = ("float", "half", "double", "int", "uint")


def parse_type(spelling):
    """(base, components) for a scalar or vector spelling, or None if it is neither."""
    for base in SCALARS:
        if spelling == base:
            return base, 1
        if spelling.startswith(base):
            tail = spelling[len(base):]
            if tail.isdigit() and 2 <= int(tail) <= 4:
                return base, int(tail)
    return None


def producer(inputs, extra=0, mistype=False):
    """Slang source for a vertex shader whose outputs match `inputs` exactly.

    A Vulkan graphics pipeline cannot be created from a fragment stage alone, so compiling a
    fragment shader on its own means supplying a vertex shader. The match has to be exact:
    measured on an RTX A4500, a producer whose vectors are wider than the consumer's, or that
    leaves a consumed location unwritten, violates VUID-RuntimeSpirv-maintenance4-06817 and
    VUID-RuntimeSpirv-OpEntryPoint-08743 - and the NVIDIA driver compiles it anyway, exits 0,
    and yields byte-identical fragment code. Only the validation layer objects. So nothing
    downstream can detect the mistake, and it has to be prevented here.

    Emitted as Slang rather than assembled as SPIR-V because slangc is already required and
    `[[vk::location(N)]]` states the slot outright.

    `extra` and `mistype` deliberately generate a WRONG producer. They exist for the test
    suite, which has to show the pairing is being checked rather than assumed.
    """
    fields, assigns = [], []
    for i, v in enumerate(inputs):
        parsed = parse_type(v["type"])
        if not parsed:
            raise ReflectError(
                "location %d is %s, which a generated producer cannot declare and fill; this "
                "fragment shader needs a producer written by hand" % (v["location"], v["type"]))
        base, components = parsed
        declared = v["type"]
        if mistype:
            components = 4 if components != 4 else 2
            declared = "%s%d" % (base, components)
        fields.append("    [[vk::location(%d)]] %s v%d : TEXCOORD%d;"
                      % (v["location"], declared, i, i))
        assigns.append("    o.v%d = %s;" % (i, _seed(base, components, i)))

    top = max([v["location"] for v in inputs] or [-1])
    for k in range(1, extra + 1):
        fields.append("    [[vk::location(%d)]] float4 x%d : TEXCOORD%d;" % (top + k, k, 90 + k))
        assigns.append("    o.x%d = float4(seed, seed, seed, seed);" % k)

    return "\n".join([
        "// Generated: the producer for a fragment shader compiled on its own. Outputs match",
        "// the consumer's inputs by location and type, and every value is derived from",
        "// SV_VertexID so none of it can be folded into the consumer.",
        "struct V2F",
        "{",
        "    float4 pos : SV_Position;",
    ] + fields + [
        "};",
        "",
        '[shader("vertex")]',
        "V2F vsMain(uint vid : SV_VertexID)",
        "{",
        "    float2 q = float2(float((vid << 1) & 2), float(vid & 2));",
        "    float seed = q.x + q.y;",
        "    V2F o;",
        "    o.pos = float4(q * 2.0f - 1.0f, 0.0f, 1.0f);",
    ] + assigns + [
        "    return o;",
        "}",
        "",
    ])


def _seed(base, components, index):
    scalar = ("seed + %d.0f" % index) if base == "float" \
        else ("(%s)(seed + %d.0f)" % (base, index))
    if components == 1:
        return scalar
    return "%s%d(%s)" % (base, components, ", ".join([scalar] * components))


def interfaces_match(producer_outputs, consumer_inputs):
    """None when the two interfaces agree slot for slot, else why they do not."""
    a = [(v["location"], v["type"]) for v in producer_outputs]
    b = [(v["location"], v["type"]) for v in consumer_inputs]
    if a == b:
        return None
    return ("the producer emits %s but the consumer reads %s"
            % (a or "nothing", b or "nothing"))


def reflect(path):
    with open(path, "rb") as handle:
        module = Module(handle.read())
    return {
        "entryPoints": [{"stage": s, "name": n} for s, n in module.entry_points],
        "descriptors": module.descriptors(),
        "inputs": module.interface(SC_INPUT),
        "outputs": module.interface(SC_OUTPUT),
        "pushConstants": module.push_constant_blocks(),
    }


def merge_descriptors(reflections):
    """One layout for a whole pipeline, from every stage that takes part in it.

    A resource declared by both stages is one binding, not two - so the merge is by
    (set, binding) and disagreeing declarations are a refusal rather than a last-writer-wins.
    """
    merged = {}
    for r in reflections:
        for d in r["descriptors"]:
            key = (d["set"], d["binding"])
            if key in merged:
                if (merged[key]["type"], merged[key]["count"]) != (d["type"], d["count"]):
                    raise ReflectError(
                        "set %d binding %d is %s[%d] in one stage and %s[%d] in another"
                        % (d["set"], d["binding"],
                           DESCRIPTOR_NAMES.get(merged[key]["type"]), merged[key]["count"],
                           DESCRIPTOR_NAMES.get(d["type"]), d["count"]))
                continue
            merged[key] = d
    return [merged[k] for k in sorted(merged)]


def main(argv):
    if len(argv) < 2:
        sys.stderr.write(__doc__)
        return 2
    as_json = "--json" in argv

    # `--producer <out.slang>` writes a vertex shader matching the module's inputs. The
    # output path is an argument to the flag, so it must not be read as another module.
    producer_out = None
    if "--producer" in argv:
        at = argv.index("--producer")
        if at + 1 >= len(argv):
            sys.stderr.write("--producer needs a path to write the generated shader to\n")
            return 2
        producer_out = argv[at + 1]
    paths = [a for i, a in enumerate(argv[1:], 1)
             if not a.startswith("--") and a != producer_out]

    if producer_out:
        if len(paths) != 1:
            sys.stderr.write("--producer takes exactly one module to match\n")
            return 2
        try:
            with open(paths[0], "rb") as handle:
                inputs = Module(handle.read()).interface(SC_INPUT)
            source = producer(inputs, extra=int(os.environ.get("NVISA_PRODUCER_EXTRA", 0) or 0),
                              mistype="--mistype" in argv)
        except ReflectError as e:
            sys.stderr.write("producer synthesis refused: %s\n" % e)
            return 1
        with open(producer_out, "w", encoding="utf-8") as handle:
            handle.write(source)
        sys.stderr.write("generated a producer for %d varying(s)\n" % len(inputs))
        return 0

    try:
        reflections = [reflect(p) for p in paths]
    except ReflectError as e:
        sys.stderr.write("reflection refused: %s\n" % e)
        return 1

    if as_json:
        merged = merge_descriptors(reflections)
        print(json.dumps({"modules": reflections, "layout": merged}, indent=2))
        return 0

    for path, r in zip(paths, reflections):
        print("%s" % path)
        for e in r["entryPoints"]:
            print("  entry      %s %s" % (e["stage"], e["name"]))
        for d in r["descriptors"]:
            print("  descriptor set %d binding %-2d %-22s x%d  %s"
                  % (d["set"], d["binding"], DESCRIPTOR_NAMES.get(d["type"], d["type"]),
                     d["count"], d["name"]))
        for v in r["inputs"]:
            print("  in         location %-2d %-10s %s" % (v["location"], v["type"], v["name"]))
        for v in r["outputs"]:
            print("  out        location %-2d %-10s %s" % (v["location"], v["type"], v["name"]))
        for p in r["pushConstants"]:
            print("  push       %s" % p)

    if len(paths) > 1:
        print("\nmerged layout:")
        for d in merge_descriptors(reflections):
            print("  --bind %d:%d:%d:%d" % (d["set"], d["binding"], d["type"], d["count"]))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
