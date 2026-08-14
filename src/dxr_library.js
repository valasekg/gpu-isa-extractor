'use strict';

/**
 * Turning Slang's HLSL output into a DXR library RGA will accept.
 *
 * The AMD raytracing road is
 *
 *     .slang --slangc -target hlsl--> HLSL --rga -s dxr--> RDNA ISA
 *
 * and neither end of that arrow means what it looks like. This module is the join, and every
 * decision in it was measured rather than reasoned about, because both ends surprised.
 *
 * ## What slangc actually emits
 *
 * `slangc file.slang -target hlsl`, with no `-entry` and no `-o`, writes to stdout - and what
 * it writes is not one file. It is one COMPLETE TRANSLATION UNIT PER ENTRY POINT, concatenated:
 * six `[shader(...)]` functions in the fixture here means six copies of the prologue, six
 * copies of every struct the entry touches, and six copies of the resource declarations. Fed
 * to DXC as-is it fails with `redefinition of 'Payload_0'` before it starts.
 *
 * ## Why they cannot simply be deduplicated
 *
 * Because Slang numbers identifiers PER ENTRY POINT, not per invocation. Measured, from a
 * single slangc run over one file:
 *
 *     struct Payload_0 { float3 colour_0; float hitT_0; };     // in some units
 *     struct Payload_0 { float3 colour_1; float hitT_0; };     // in others
 *
 * Same name, different body. Keeping the first copy and dropping the rest compiles, then fails
 * at `no member named 'colour_1' in 'Payload_0'` - the references in the other units still
 * spell it the other way. A textual merge that assumes one name means one thing is wrong, and
 * wrong in a way that only shows up on a file where two entry points share a struct.
 *
 * So: declarations that appear identically everywhere are emitted once, and any name that
 * comes out with more than one body gets a per-unit copy with its references rewritten. A DXR
 * payload type is per-shader anyway, so this is not a workaround so much as the right shape.
 *
 * ## What RGA needs that Slang has no reason to emit
 *
 * A DXR state object is built from SUBOBJECTS declared in the HLSL itself - a global root
 * signature, a shader config, a pipeline config, and a hit group. Slang emits none, and
 * without them RGA compiles the DXIL fine and then fails with "failed to create DXR state
 * object". They are synthesised here, and `assumptions()` reports every one that was a choice
 * rather than a reading, so the banner can print them instead of quietly standing behind them.
 */

/** Slang starts every translation unit with this. It is the only unit boundary there is. */
const UNIT_BOUNDARY = '#pragma pack_matrix';

/** `[shader("raygeneration")] void rayGen()` - the attribute and the function it names. */
const SHADER_ATTR = /\[shader\("(\w+)"\)\]\s*(?:void\s+)?(\w+)?/;

const STRUCT_NAME = /^\s*struct\s+(\w+)/m;

/** How many bytes an HLSL scalar or vector occupies, for sizing the shader config. */
const SCALAR_BYTES = { float: 4, int: 4, uint: 4, bool: 4, half: 2, double: 8 };

const normalise = text => text.replace(/\s+/g, ' ').trim();

/**
 * Split a translation unit into top-level declarations, in order.
 *
 * A brace-depth walk rather than a regex, because a struct body contains semicolons and a
 * function body contains braces. Preprocessor lines are dropped here and the prologue is
 * re-emitted once: `#line` markers name the .slang file and offsets that stop being true the
 * moment units are interleaved, so carrying them through would put confident, wrong source
 * locations into DXC's diagnostics.
 */
function declarations(text) {
  const out = [];
  let buf = [];
  let depth = 0;
  for (const line of text.split(/(?<=\n)/)) {
    const trimmed = line.trim();
    if (depth === 0 && trimmed.startsWith('#')) {
      if (buf.join('').trim()) out.push(buf.join(''));
      buf = [];
      continue;
    }
    buf.push(line);
    depth += (line.match(/\{/g) || []).length - (line.match(/\}/g) || []).length;
    if (depth <= 0 && (trimmed.endsWith(';') || trimmed.endsWith('}'))) {
      if (buf.join('').trim()) out.push(buf.join(''));
      buf = [];
      depth = 0;
    }
  }
  if (buf.join('').trim()) out.push(buf.join(''));
  return out;
}

/** The concatenated units slangc wrote, split back apart. */
function splitUnits(hlsl) {
  return hlsl.split(UNIT_BOUNDARY).slice(1).map(u => UNIT_BOUNDARY + u);
}

/**
 * The size in bytes of a struct, from its declaration.
 *
 * Used for the shader config, where the numbers are MAXIMA - a payload larger than declared is
 * a compile failure, larger than needed is only waste - so this rounds up and never down, and
 * anything it cannot parse falls back to the caller's floor rather than to a smaller guess.
 * No packing rules are applied: DXR payloads are not cbuffers and the sum is the right answer
 * for the scalar and vector members Slang emits here.
 */
function structBytes(decl) {
  const body = /\{([\s\S]*)\}/.exec(decl);
  if (!body) return null;
  let total = 0;
  for (const member of body[1].split(';')) {
    const m = /^\s*(\w+?)(\d)?(?:x(\d))?\s+\w+\s*(?:\[\s*(\d+)\s*\])?\s*$/.exec(member);
    if (!m) {
      if (member.trim()) return null;            // something unmodelled: do not guess
      continue;
    }
    const scalar = SCALAR_BYTES[m[1]];
    if (!scalar) return null;
    const lanes = (Number(m[2]) || 1) * (Number(m[3]) || 1) * (Number(m[4]) || 1);
    total += scalar * lanes;
  }
  return total || null;
}

/**
 * A global root signature matching the registers the shader actually declares.
 *
 * Read out of Slang's own output rather than from reflection, because Slang has already
 * decided the bindings and written them down - `register(t0)` is not a guess about what the
 * shader wants, it is what the shader says.
 *
 * A texture cannot be a root descriptor, so UAVs and SRVs that are not acceleration structures
 * go in a descriptor table. An empty signature is spelled `RootFlags(0)`: DXC rejects `""`,
 * and a miss or callable shader that touches nothing but its payload genuinely binds nothing.
 */
function rootSignature(declarationText) {
  const parts = [];
  for (const line of declarationText.split('\n')) {
    const m = /register\(([btus])(\d+)\)/.exec(line);
    if (!m) continue;
    const [, kind, index] = m;
    if (kind === 'b') parts.push(`CBV(b${index})`);
    else if (kind === 't') {
      parts.push(/RaytracingAccelerationStructure/.test(line)
        ? `SRV(t${index})` : `DescriptorTable(SRV(t${index}))`);
    } else if (kind === 'u') parts.push(`DescriptorTable(UAV(u${index}))`);
  }
  return [...new Set(parts)].join(', ') || 'RootFlags(0)';
}

/**
 * Merge slangc's concatenated units into one DXR library, with the state RGA needs.
 *
 * @param {string} hlsl               everything slangc wrote to stdout
 * @param {object} [options]
 * @param {number} [options.recursion]  max trace recursion depth to declare
 * @returns {{source, stages, entries, assumptions, rootSignature, payloadBytes,
 *            attributeBytes, hitGroup}}
 */
function build(hlsl, { recursion = 1 } = {}) {
  const units = splitUnits(hlsl);
  if (!units.length) {
    throw new Error(
      'slangc wrote no HLSL translation units. Its output is split on `' + UNIT_BOUNDARY +
      '`, which every unit it emits starts with, so either the compile produced nothing or ' +
      'the output shape has changed.');
  }

  // Which struct names come out with more than one body? Those, and only those, need copies.
  const bodies = new Map();
  const parsed = units.map(declarations);
  for (const unit of parsed) {
    for (const decl of unit) {
      const m = STRUCT_NAME.exec(decl);
      if (!m) continue;
      if (!bodies.has(m[1])) bodies.set(m[1], new Set());
      bodies.get(m[1]).add(normalise(decl));
    }
  }
  const conflicted = new Set([...bodies].filter(([, set]) => set.size > 1).map(([n]) => n));

  const shared = [];
  const entryDecls = [];
  const stages = [];
  const seen = new Set();

  parsed.forEach((unit, index) => {
    const rename = new Map();
    for (const decl of unit) {
      const m = STRUCT_NAME.exec(decl);
      if (m && conflicted.has(m[1])) rename.set(m[1], `${m[1]}_u${index}`);
    }
    const fix = text => {
      let out = text;
      for (const [from, to] of rename) out = out.replace(new RegExp(`\\b${from}\\b`, 'g'), to);
      return out;
    };

    for (const raw of unit) {
      const decl = fix(raw);
      if (!decl.trim()) continue;
      const attr = SHADER_ATTR.exec(decl);
      if (attr) {
        entryDecls.push(decl);
        stages.push({ stage: attr[1], name: attr[2] || null });
        continue;
      }
      const key = normalise(decl);
      if (seen.has(key)) continue;
      seen.add(key);
      shared.push(decl);
    }
  });

  const sharedText = shared.join('\n');
  const signature = rootSignature(sharedText);

  // The payload and attribute maxima, from the ENTRY SIGNATURES rather than from every struct
  // in the file.
  //
  // Taking the largest struct instead looks safer and is not. These are ceilings, so a ceiling
  // that is too high is only waste - except that DXR caps attributes at 32 bytes, and the
  // biggest struct in an ordinary raytracing file is the camera constant buffer. Sized that
  // way this file asked for 80, which is not a payload at all, and RGA answered "failed to
  // create DXR state object" with no mention of a number.
  //
  // A raytracing entry takes the payload first and the attributes second - `void anyHit(inout
  // Payload p, SphereAttr a)` - so the types are declared right there.
  const declared = new Map();
  for (const decl of [...shared, ...entryDecls]) {
    const m = STRUCT_NAME.exec(decl);
    if (m) declared.set(m[1], structBytes(decl));
  }
  const sizeOf = name => (typeof declared.get(name) === 'number' ? declared.get(name) : 0);

  const payloadTypes = [];
  const attributeTypes = [];
  for (const decl of entryDecls) {
    const sig = /\[shader\("(\w+)"\)\]\s*(?:void\s+)?\w+\s*\(([^)]*)\)/.exec(decl);
    if (!sig) continue;
    const params = sig[2].split(',').map(p => p.trim()).filter(Boolean);
    params.forEach((param, i) => {
      const type = /(?:inout|out|in)?\s*([A-Za-z_]\w*)\s+\w+/.exec(param);
      if (!type || !declared.has(type[1])) return;
      (i === 0 ? payloadTypes : attributeTypes).push(type[1]);
    });
  }

  const payloadBytes = Math.max(16, ...payloadTypes.map(sizeOf));
  // 32 is D3D12_RAYTRACING_MAX_ATTRIBUTE_SIZE_IN_BYTES. Asking for more is not a bigger
  // ceiling, it is a state object that will not build.
  const attributeBytes = Math.min(32, Math.max(8, ...attributeTypes.map(sizeOf)));

  const has = stage => stages.some(s => s.stage === stage);
  const named = stage => (stages.find(s => s.stage === stage) || {}).name || '';

  // Procedural when the file declares an intersection shader, triangles otherwise. This one is
  // read rather than assumed: an intersection shader is only reachable from a procedural hit
  // group, and a file that has one cannot have meant the other.
  const procedural = has('intersection');
  const hitGroup = (has('closesthit') || has('anyhit') || has('intersection'))
    ? `${procedural ? 'ProceduralPrimitiveHitGroup' : 'TriangleHitGroup'} hitGroup0 = ` +
      `{ "${named('anyhit')}", "${named('closesthit')}"` +
      `${procedural ? `, "${named('intersection')}"` : ''} };`
    : '';

  const assumptions = [];
  if (signature === 'RootFlags(0)') {
    assumptions.push('no resources are bound: the shaders declare none');
  } else {
    assumptions.push(`the root signature is ${signature}, read from the registers slangc emitted`);
  }
  assumptions.push(
    `the payload is at most ${payloadBytes} bytes and attributes at most ${attributeBytes}, ` +
    'taken as the largest struct in the file - these are ceilings, not measurements');
  assumptions.push(
    `trace recursion depth ${recursion}, which the source does not state and this cannot ` +
    'read - a deeper pipeline may allocate differently');
  if (hitGroup) {
    assumptions.push(`a single ${procedural ? 'procedural' : 'triangle'} hit group, because ` +
      `the file ${procedural ? 'declares an intersection shader' : 'declares none'}`);
  }

  const source = [
    '#pragma pack_matrix(column_major)',
    '#ifndef __DXC_VERSION_MAJOR',
    '#pragma warning(disable : 3557)',
    '#endif',
    '',
    sharedText,
    entryDecls.join('\n'),
    '',
    '// ---- state definition, synthesised: slangc emits no DXR subobjects ----',
    `GlobalRootSignature rgaGlobalRootSig = { "${signature}" };`,
    `RaytracingShaderConfig rgaShaderConfig = { ${payloadBytes}, ${attributeBytes} };`,
    `RaytracingPipelineConfig rgaPipelineConfig = { ${recursion} };`,
    hitGroup,
    ''
  ].join('\n');

  return {
    source,
    stages,
    entries: stages.length,
    assumptions,
    rootSignature: signature,
    payloadBytes,
    attributeBytes,
    hitGroup: hitGroup ? (procedural ? 'procedural' : 'triangles') : null
  };
}

module.exports = {
  UNIT_BOUNDARY,
  splitUnits,
  declarations,
  structBytes,
  rootSignature,
  build
};
