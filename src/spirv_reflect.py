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

OP_CAPABILITY = 17
OP_EXTENSION = 10
OP_NAME = 5
OP_ENTRY_POINT = 15
OP_EXECUTION_MODE = 16
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
DEC_ARRAY_STRIDE = 6
DEC_MATRIX_STRIDE = 7
DEC_OFFSET = 35
OP_DECORATE = 71
OP_MEMBER_DECORATE = 72

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
              3: "geometry", 4: "fragment", 5: "compute",
              5313: "raygeneration", 5314: "intersection", 5315: "anyhit",
              5316: "closesthit", 5317: "miss", 5318: "callable",
              5364: "amplification", 5365: "mesh"}

# Slang spells these the HLSL way - hull and domain - and puts the whole set on the HULL
# shader, where GLSL would put most of them on the evaluation stage. A domain shader
# declares only its domain, which is why a generated hull shader can be derived from a
# domain shader but not the other way round without the modes below.
TESS_DOMAIN = {22: "triangles", 24: "quads", 25: "isolines"}
TESS_SPACING = {1: "equal", 2: "fractional_even", 3: "fractional_odd"}
TESS_WINDING = {4: "cw", 5: "ccw"}
EXEC_OUTPUT_VERTICES = 26

# How many tessellation factors each domain takes. A hull shader that writes the wrong
# number for its domain is not a hull shader for that domain.
TESS_FACTORS = {"triangles": (3, 1), "quads": (4, 2), "isolines": (2, 0)}

# What a geometry shader declares it consumes, and the input-assembly topology that feeds it.
# A triangle-input geometry shader behind a point-list topology is not a pipeline, so this is
# read out of the module rather than assumed.
INPUT_PRIMITIVE = {
    19: ("points", "point_list", 1),
    20: ("lines", "line_list", 2),
    21: ("lines_adjacency", "line_list_with_adjacency", 4),
    22: ("triangles", "triangle_list", 3),
    23: ("triangles_adjacency", "triangle_list_with_adjacency", 6),
}


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
        self.member_decorations = {}             # struct id -> {member: {decoration: [ops]}}
        self.variables = []                      # (result_type_id, result_id, storage_class)
        self.entry_points = []                   # (stage, name)
        self.execution_modes = []                # (mode, [operands]), in declaration order
        self.capabilities = []                   # SPIR-V capability numbers
        self.extensions = []                     # SPIR-V extension names
        self._collect()

    def _collect(self):
        for op, w in self.instructions:
            if op == OP_NAME and len(w) >= 2:
                self.names[w[0]] = decode_string(w[1:])
            elif op == OP_ENTRY_POINT and len(w) >= 2:
                self.entry_points.append(
                    (EXEC_MODEL.get(w[0], "model%d" % w[0]), decode_string(w[2:])))
            elif op == OP_CAPABILITY and w:
                self.capabilities.append(w[0])
            elif op == OP_EXTENSION and w:
                self.extensions.append(decode_string(w))
            elif op == OP_EXECUTION_MODE and len(w) >= 2:
                self.execution_modes.append((w[1], list(w[2:])))
            elif op == OP_DECORATE and len(w) >= 2:
                self.decorations.setdefault(w[0], {})[w[1]] = list(w[2:])
            elif op == OP_MEMBER_DECORATE and len(w) >= 3:
                self.member_decorations.setdefault(w[0], {}) \
                    .setdefault(w[1], {})[w[2]] = list(w[3:])
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

    def type_bytes(self, type_id):
        """How many bytes a type occupies, or None where this cannot say.

        None is a real answer and the caller must treat it as one. A push-constant range that
        is too small is not a smaller range - it is an invalid pipeline, and on this driver an
        invalid pipeline compiles into microcode that looks exactly like the right answer. So
        anything not understood here refuses rather than estimating.
        """
        entry = self.types.get(type_id)
        if not entry:
            return None
        op, ops = entry

        if op in (OP_TYPE_INT, OP_TYPE_FLOAT) and ops:
            return ops[0] // 8
        if op == OP_TYPE_BOOL:
            return 4
        if op == OP_TYPE_VECTOR and len(ops) >= 2:
            inner = self.type_bytes(ops[0])
            return None if inner is None else inner * ops[1]
        if op == OP_TYPE_MATRIX and len(ops) >= 2:
            # The declared column stride wins where there is one: a float3x3 is laid out on
            # 16-byte columns, so counting the columns' own sizes under-reports it by 12.
            stride = self.decorations.get(type_id, {}).get(DEC_MATRIX_STRIDE)
            column = stride[0] if stride else self.type_bytes(ops[0])
            return None if column is None else column * ops[1]
        if op == OP_TYPE_ARRAY and len(ops) >= 2:
            if ops[1] not in self.constants:
                return None                      # a specialisation constant; not a fixed size
            stride = self.decorations.get(type_id, {}).get(DEC_ARRAY_STRIDE)
            element = stride[0] if stride else self.type_bytes(ops[0])
            return None if element is None else element * self.constants[ops[1]]
        if op == OP_TYPE_STRUCT:
            # Members are placed by explicit Offset decorations, so the struct ends where its
            # last member ends - which is not necessarily the one declared last.
            members = self.member_decorations.get(type_id, {})
            end = 0
            for index, member_type in enumerate(ops):
                offset = members.get(index, {}).get(DEC_OFFSET)
                size = self.type_bytes(member_type)
                if offset is None or size is None:
                    return None
                end = max(end, offset[0] + size)
            return end
        return None

    def push_constant_bytes(self):
        """The size of the push-constant range this module needs, or None if it needs none.

        Raises where a block is present but its size cannot be computed, because the two must
        not look alike: "no push constants" and "push constants of an unknown size" lead to
        opposite decisions, and only one of them can be guessed at safely.
        """
        total = None
        for tid, rid, sc in self.variables:
            if sc != SC_PUSH_CONSTANT:
                continue
            pointee = self.pointee(tid, rid)
            size = self.type_bytes(pointee) if pointee is not None else None
            if size is None:
                raise ReflectError(
                    "%s is a push-constant block whose size cannot be read out of this module. "
                    "State it with `-Xvk push=<bytes>`: a pipeline layout without the range "
                    "the shader uses is invalid, and this driver compiles it anyway."
                    % (self.names.get(rid, "a push-constant block")))
            total = size if total is None else max(total, size)
        return total

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

    def input_primitive(self):
        """What a geometry shader consumes: (name, topology, vertices per primitive).

        Refused rather than defaulted when absent. Guessing `triangles` for a shader that
        declares `lines` builds a pipeline the driver rejects, and guessing it for one that
        declares nothing at all means the module is not a geometry shader to begin with.
        """
        for mode, _operands in self.execution_modes:
            if mode in INPUT_PRIMITIVE:
                return INPUT_PRIMITIVE[mode]
        raise ReflectError(
            "this module declares no input primitive, so the topology that feeds it is not "
            "knowable; a geometry shader always declares one")

    def per_vertex_inputs(self):
        """A geometry shader's inputs with the per-vertex array dimension stripped.

        Every non-builtin input of a geometry shader is an array indexed by vertex - three
        elements for `triangle`, two for `line`. What the producer has to emit is the ELEMENT
        type, once, so the array is unwrapped here rather than being reported as a varying no
        vertex shader could possibly declare.
        """
        out = []
        for v in self.interface(SC_INPUT):
            spelling = v["type"]
            if "[" not in spelling:
                raise ReflectError(
                    "location %d is %s, which is not an array; a geometry shader's inputs are "
                    "indexed by vertex" % (v["location"], spelling))
            out.append({**v, "type": spelling[:spelling.index("[")]})
        return out

    def tessellation(self):
        """What a hull or domain shader declares about the tessellator.

        A hull shader carries the whole set - domain, spacing, winding and how many control
        points it outputs. A domain shader carries only the domain, because in HLSL (and so in
        Slang) the rest is the hull shader's to state. That asymmetry decides which direction
        can be synthesised from which: a hull shader is enough to derive a matching domain
        shader, and a domain shader is enough only because everything a hull shader needs
        beyond the domain has a defensible default.
        """
        out = {"domain": None, "spacing": None, "winding": None, "outputVertices": None}
        for mode, operands in self.execution_modes:
            if mode in TESS_DOMAIN:
                out["domain"] = TESS_DOMAIN[mode]
            elif mode in TESS_SPACING:
                out["spacing"] = TESS_SPACING[mode]
            elif mode in TESS_WINDING:
                out["winding"] = TESS_WINDING[mode]
            elif mode == EXEC_OUTPUT_VERTICES and operands:
                out["outputVertices"] = operands[0]
        if not out["domain"]:
            raise ReflectError(
                "this module declares no tessellation domain, so the patch it works on is not "
                "knowable; a hull or domain shader always declares one")
        out["factors"] = TESS_FACTORS[out["domain"]]
        return out

    def local_size(self):
        """The workgroup size the shader declares, as [x, y, z], or None.

        Read from the module rather than from the compiler's statistics on purpose. RGA's
        statistics CSV has THREADS_PER_WORKGROUP and CL_WORKGROUP_* columns, and every one of
        them reads 0 for a Vulkan shader - including a compute shader with a declared size -
        because they are OpenCL-mode fields. So the only honest source is what the shader
        itself says, and a banner printing this must label it as declared rather than as
        measured or reported.

        Both spellings are read. `LocalSize` carries literals; `LocalSizeId` carries constant
        ids, which is what a specialisation-constant workgroup size compiles to, and those are
        resolved through the constants already collected. An unresolvable id yields None rather
        than a guess - a specialisation constant genuinely has no value until it is specialised.
        """
        EM_LOCAL_SIZE = 17
        EM_LOCAL_SIZE_ID = 38
        for mode, operands in self.execution_modes:
            if mode == EM_LOCAL_SIZE and len(operands) >= 3:
                return [int(v) for v in operands[:3]]
            if mode == EM_LOCAL_SIZE_ID and len(operands) >= 3:
                resolved = [self.constants.get(o) for o in operands[:3]]
                if all(v is not None for v in resolved):
                    return [int(v) for v in resolved]
        return None

    def patch_size(self):
        """How many vertices are in the patch this stage reads.

        Every non-builtin input of a hull or domain shader is an array indexed by control
        point, so the array length IS the patch size. It is not an execution mode and there is
        no default worth guessing - a wrong one is a pipeline the driver accepts while
        tessellating something nobody wrote.
        """
        sizes = set()
        for v in self.interface(SC_INPUT):
            spelling = v["type"]
            if "[" in spelling:
                sizes.add(int(spelling[spelling.index("[") + 1:spelling.index("]")]))
        if len(sizes) > 1:
            raise ReflectError(
                "this module's inputs are arrays of differing lengths %s, so the patch size is "
                "ambiguous" % sorted(sizes))
        return sizes.pop() if sizes else None

    def per_control_point_inputs(self):
        """Inputs with the per-control-point array dimension stripped."""
        out = []
        for v in self.interface(SC_INPUT):
            spelling = v["type"]
            out.append({**v, "type": spelling.split("[")[0]})
        return out

    def per_control_point_outputs(self):
        out = []
        for v in self.interface(SC_OUTPUT):
            spelling = v["type"]
            out.append({**v, "type": spelling.split("[")[0]})
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


def producer(inputs, extra=0, mistype=False, consumer="fragment"):
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
                "location %d is %s, which a generated producer cannot declare and fill; "
                "this %s shader needs a producer written by hand"
                % (v["location"], v["type"], consumer))
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


def tess_counterpart(stage, tess, varyings, patch_points):
    """The other half of a tessellation pair, as Slang source.

    Hull and domain shaders cannot exist apart: Vulkan rejects a pipeline carrying one without
    the other, so compiling either means supplying its counterpart. Unlike a vertex producer,
    this one is not free-form - the domain, the control-point count and the number of
    tessellation factors all have to agree with what the real shader declared, or the pipeline
    is rejected outright rather than silently tolerated.

    The generated hull shader writes its inside factors as a ONE-ELEMENT ARRAY even for a
    triangle domain, where the idiomatic HLSL spelling is a bare scalar. That is deliberate:
    slangc 2024.13 crashes with `assert failure: toStyle != TypeCastStyle::Unknown` on a
    scalar `SV_InsideTessFactor` in a `tri` domain, and the array form compiles. Generated
    code gets to sidestep a compiler bug that a user's own shader cannot.
    """
    outer, inner = tess["factors"]
    domain = {"triangles": "tri", "quads": "quad", "isolines": "isoline"}[tess["domain"]]
    fields = []
    assigns = []
    for i, v in enumerate(varyings):
        parsed = parse_type(v["type"])
        if not parsed:
            raise ReflectError(
                "location %d is %s, which a generated %s shader cannot declare"
                % (v["location"], v["type"], stage))
        base, components = parsed
        fields.append("    [[vk::location(%d)]] %s v%d : TEXCOORD%d;"
                      % (v["location"], v["type"], i, i))
        assigns.append((i, base, components))

    # Declared at the size of the BUILTIN, not of the domain. gl_TessLevelOuter is float[4] and
    # gl_TessLevelInner is float[2] in every SPIR-V module whatever the domain is, so a triangle
    # domain's `float edges[3]` compiled into an OpStore of a float[3] into a float[4] - which
    # spirv-val rejects (VUID-VkShaderModuleCreateInfo-pCode-08737) and which this driver builds
    # anyway. Only the quad case, whose 4 and 2 already match, was ever valid, and the fixtures
    # are quads, which is why nothing caught it.
    const_fields = ["    float edges[4] : SV_TessFactor;",
                    "    float inside[2] : SV_InsideTessFactor;"]

    common = [
        "// Generated: the other half of a tessellation pair. Hull and domain shaders cannot",
        "// exist apart, so compiling one means supplying the other.",
        "struct Patch",
        "{",
    ] + fields + [
        "};",
        "",
        "struct PatchConstants",
        "{",
    ] + const_fields + [
        "};",
        "",
    ]

    if stage == "hull":
        body = [
            "PatchConstants hsConst(InputPatch<Patch, %d> patch)" % patch_points,
            "{",
            "    PatchConstants c;",
        ] + ["    c.edges[%d] = %s;" % (k, "2.0f" if k < outer else "0.0f")
             for k in range(4)] \
          + ["    c.inside[%d] = %s;" % (k, "2.0f" if k < inner else "0.0f")
             for k in range(2)] + [
            "    return c;",
            "}",
            "",
            '[shader("hull")]',
            '[domain("%s")]' % domain,
            '[partitioning("%s")]' % (tess["spacing"] or "integer").replace("equal", "integer"),
            # `outputtopology` names a WINDING here, not an output primitive: Slang lowers
            # `triangle_cw` to `OpExecutionMode VertexOrderCw`, which is what a tessellator
            # takes. So it stays a triangle spelling even for an isoline domain, where winding
            # is meaningless and simply ignored - measured, because the obvious-looking
            # `outputtopology("line")` is worse than useless: Slang 2024.13 lowers it to
            # `OutputTrianglesEXT`, a MESH SHADER mode, and spirv-val then rejects the module
            # for declaring a capability it does not have. An isoline hull with this spelling
            # validates clean.
            '[outputtopology("%s")]' % ("triangle_cw" if tess["winding"] != "ccw"
                                        else "triangle_ccw"),
            "[outputcontrolpoints(%d)]" % (tess["outputVertices"] or patch_points),
            '[patchconstantfunc("hsConst")]',
            "Patch hsMain(InputPatch<Patch, %d> patch, uint i : SV_OutputControlPointID)"
            % patch_points,
            "{",
            "    return patch[i];",
            "}",
            "",
        ]
    elif stage == "domain":
        # A domain shader must write a position, or there is no pipeline. The varyings are
        # passed through from the first control point, which keeps every one of them live -
        # the conservative choice, matching what a full consumer does elsewhere.
        location = "float3 bary" if tess["domain"] == "triangles" else "float2 uv"
        body = [
            "struct DomainOut",
            "{",
            "    float4 pos : SV_Position;",
        ] + ["    [[vk::location(%d)]] %s v%d : TEXCOORD%d;"
             % (v["location"], v["type"], i, i) for i, v in enumerate(varyings)] + [
            "};",
            "",
            '[shader("domain")]',
            '[domain("%s")]' % domain,
            "DomainOut dsMain(PatchConstants constants, %s : SV_DomainLocation,"
            % location,
            "                 const OutputPatch<Patch, %d> patch)" % patch_points,
            "{",
            "    DomainOut o;",
            "    o.pos = float4(%s, 1.0f);"
            % ("bary" if tess["domain"] == "triangles" else "uv, 0.0f"),
        ] + ["    o.v%d = patch[0].v%d;" % (i, i) for i, _b, _c in assigns] + [
            "    return o;",
            "}",
            "",
        ]
    else:
        raise ReflectError("no counterpart is generated for a %s shader" % stage)

    return "\n".join(common + body)


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
    out = {
        "entryPoints": [{"stage": s, "name": n} for s, n in module.entry_points],
        # What the module says it needs. A capability declared but never enabled on the device
        # is an invalid pipeline that this driver builds anyway - measured three times now - so
        # the harness turns on what the modules ask for rather than a hardcoded set.
        "capabilities": sorted(set(module.capabilities)),
        "extensions": sorted(set(module.extensions)),
        "descriptors": module.descriptors(),
        "inputs": module.interface(SC_INPUT),
        "outputs": module.interface(SC_OUTPUT),
        "pushConstants": module.push_constant_blocks(),
        # The SIZE, not just the names. A pipeline layout that omits the range a module
        # statically uses is invalid, and nothing downstream of here can tell.
        "pushBytes": module.push_constant_bytes(),
    }
    # Only the stages that HAVE a workgroup. A vertex or fragment shader has none, and
    # reporting `null` for one is noise where reporting it for a compute shader is a fact.
    # `amplification` is what this reflector calls the stage Vulkan calls `task`; both spellings
    # are accepted so the condition does not depend on which name reaches it.
    if any(s in ("compute", "mesh", "amplification", "task")
           for s, _ in module.entry_points):
        out["localSize"] = module.local_size()
    if any(s == "geometry" for s, _ in module.entry_points):
        name, topology, vertices = module.input_primitive()
        out["primitive"] = {"name": name, "topology": topology, "vertices": vertices}
        out["perVertexInputs"] = module.per_vertex_inputs()
    if any(s.startswith("tessellation") for s, _ in module.entry_points):
        out["tessellation"] = module.tessellation()
        out["patchControlPoints"] = module.patch_size()
        out["perControlPointInputs"] = module.per_control_point_inputs()
        out["perControlPointOutputs"] = module.per_control_point_outputs()
    return out


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

    # `--counterpart <out.slang>` writes the other half of a tessellation pair: a domain
    # shader for a hull module, a hull shader for a domain one.
    counterpart_out = None
    if "--counterpart" in argv:
        at = argv.index("--counterpart")
        if at + 1 >= len(argv):
            sys.stderr.write("--counterpart needs a path to write the generated shader to\n")
            return 2
        counterpart_out = argv[at + 1]
        paths = [a for a in paths if a != counterpart_out]

    if counterpart_out:
        if len(paths) != 1:
            sys.stderr.write("--counterpart takes exactly one module to match\n")
            return 2
        try:
            with open(paths[0], "rb") as handle:
                module = Module(handle.read())
            stage = module.entry_points[0][0] if module.entry_points else ""
            tess = module.tessellation()
            points = module.patch_size()
            if stage == "tessellation_control":
                # The domain shader reads what the hull shader wrote.
                source = tess_counterpart("domain", tess, module.per_control_point_outputs(),
                                          tess["outputVertices"] or points)
                wanted = "domain"
            elif stage == "tessellation_evaluation":
                # The hull shader must produce what the domain shader reads.
                source = tess_counterpart("hull", tess, module.per_control_point_inputs(),
                                          points)
                wanted = "hull"
            else:
                sys.stderr.write("%s is a %s shader, which has no tessellation counterpart\n"
                                 % (paths[0], stage))
                return 2
        except ReflectError as e:
            sys.stderr.write("counterpart synthesis refused: %s\n" % e)
            return 1
        with open(counterpart_out, "w", encoding="utf-8") as handle:
            handle.write(source)
        sys.stderr.write("generated a %s shader for a %s domain, %d control point(s)\n"
                         % (wanted, tess["domain"], points or 0))
        return 0

    if producer_out:
        if len(paths) != 1:
            sys.stderr.write("--producer takes exactly one module to match\n")
            return 2
        try:
            with open(paths[0], "rb") as handle:
                module = Module(handle.read())
            stage = module.entry_points[0][0] if module.entry_points else "fragment"
            # Every stage that reads a PRIMITIVE reads its inputs as arrays indexed by vertex
            # or control point, and the producer emits one element of each, so the array
            # dimension comes off before matching. Only geometry was listed here, so a
            # tessellation-only file - a hull and domain pair with no vertex shader to feed
            # them - handed `float3[4]` to a synthesiser that can only declare scalars and
            # vectors, and refused a file that compiles perfectly well.
            per_primitive = ("geometry", "tessellation_control", "tessellation_evaluation")
            inputs = (module.per_vertex_inputs() if stage == "geometry"
                      else module.per_control_point_inputs() if stage in per_primitive
                      else module.interface(SC_INPUT))
            source = producer(inputs, extra=int(os.environ.get("NVISA_PRODUCER_EXTRA", 0) or 0),
                              mistype="--mistype" in argv,
                              # Named, so a refusal describes the shader it was handed rather
                              # than calling every stage a fragment shader.
                              consumer=stage)
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
        # The range every module in the set needs: one layout serves the whole pipeline,
        # so the largest wins rather than the last.
        push = [r["pushBytes"] for r in reflections if r["pushBytes"]]
        print(json.dumps({"modules": reflections, "layout": merged,
                          "pushBytes": max(push) if push else 0}, indent=2))
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
            print("  push       %s (%s bytes)" % (p, r["pushBytes"]))

    if len(paths) > 1:
        print("\nmerged layout:")
        for d in merge_descriptors(reflections):
            print("  --bind %d:%d:%d:%d" % (d["set"], d["binding"], d["type"], d["count"]))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
