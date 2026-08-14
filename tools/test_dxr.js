'use strict';

/**
 * Building a DXR library out of what slangc emits.
 *
 * Two halves, following `test_rga.js`. The first needs nothing installed and works from a
 * CAPTURED slangc output - `fixtures/rdna/raytracing-slangc.hlsl`, written by slangc
 * 2026.1-52-gc8ddf20bb from `fixtures/gfx/raytracing.slang`. That fixture is the point: the
 * merge is a text transform, and pinning it against real compiler output means the checks fail
 * when Slang changes its emission rather than when a machine lacks a tool.
 *
 * The second half feeds the result to a real RGA, because "the merge produced plausible HLSL"
 * and "DXC accepts it and AMD's compiler produces ISA" are different claims and only the
 * second one matters.
 *
 *   ELECTRON_RUN_AS_NODE=1 Code.exe tools/test_dxr.js
 */

const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dxr = require(path.join(__dirname, '..', 'src', 'dxr_library.js'));
const rga = require(path.join(__dirname, '..', 'src', 'rga.js'));

const FIXTURE = path.join(__dirname, 'fixtures', 'rdna', 'raytracing-slangc.hlsl');

let checks = 0;
let failures = 0;
let skipped = 0;

function check(condition, what, detail = '') {
  checks++;
  if (condition) return;
  failures++;
  console.log(`  FAIL  ${what}`);
  if (detail) console.log(String(detail).split('\n').map(l => `        ${l}`).join('\n'));
}

function skip(what) {
  skipped++;
  console.log(`  skip  ${what}`);
}

function section(title) {
  console.log(`\n${title}`);
}

function run(exe, args, { timeout = 300000 } = {}) {
  return new Promise(resolve => {
    cp.execFile(exe, args, { timeout, windowsHide: true, maxBuffer: 1 << 26 },
      (error, stdout, stderr) => {
        resolve({
          failed: !!error,
          code: error && typeof error.code === 'number' ? error.code : 0,
          stdout: stdout || '',
          stderr: stderr || '',
          argv: [exe, ...args]
        });
      });
  });
}

async function main() {
  section('1. What slangc actually emits');

  const emitted = fs.readFileSync(FIXTURE, 'utf8');
  const units = dxr.splitUnits(emitted);
  check(units.length === 6,
    'one file with six entry points comes back as six translation units, not one',
    `${units.length} units`);
  check(units.every(u => u.startsWith(dxr.UNIT_BOUNDARY)),
    'and every unit starts at the boundary the split relies on');

  // The reason a plain dedup cannot work, pinned. If this ever stops being true the merge is
  // doing unnecessary work - but silently keeping the first copy would be wrong TODAY.
  const payloads = new Set();
  for (const unit of units) {
    for (const decl of dxr.declarations(unit)) {
      if (/^\s*struct\s+Payload_0\b/.test(decl)) payloads.add(decl.replace(/\s+/g, ' ').trim());
    }
  }
  check(payloads.size > 1,
    'the same struct name comes back with more than one body, so names are not unique',
    [...payloads].join('\n'));

  section('2. The merge');

  const built = dxr.build(emitted);

  check(built.entries === 6, 'every entry point survives the merge', `${built.entries}`);
  const stages = built.stages.map(s => s.stage).sort();
  check(stages.join(',') === 'anyhit,callable,closesthit,intersection,miss,raygeneration',
    'and all six stages are named', stages.join(', '));
  check(built.stages.every(s => s.name),
    'each with the function name RGA will label its output with',
    built.stages.map(s => `${s.stage}:${s.name}`).join(' '));

  // The merge is only correct if the conflicting struct was COPIED rather than deduplicated.
  const copies = (built.source.match(/struct Payload_0(_u\d+)?\b/g) || []);
  check(copies.length > 1 && copies.some(c => /_u\d+/.test(c)),
    'the conflicting struct is copied per unit rather than merged into one',
    copies.join(', '));
  check(!/struct (\w+)[\s\S]*struct \1\b/.test(built.source.replace(/_u\d+/g, '')) ||
    copies.some(c => /_u\d+/.test(c)),
    'and nothing is left declared twice under one name');

  // A declaration that IS identical everywhere must appear once, or the library will not build.
  const scene = (built.source.match(/RaytracingAccelerationStructure/g) || []).length;
  check(scene === 1, 'a resource every unit declares identically appears exactly once',
    `${scene} times`);

  section('3. The state definition slangc does not emit');

  check(/GlobalRootSignature/.test(built.source) &&
    /RaytracingShaderConfig/.test(built.source) &&
    /RaytracingPipelineConfig/.test(built.source),
    'the three subobjects RGA refuses to build a state object without are present');
  check(built.rootSignature.includes('SRV(t0)'),
    'the acceleration structure is a root SRV', built.rootSignature);
  check(built.rootSignature.includes('DescriptorTable(UAV(u0))'),
    'while the output texture goes in a descriptor table, because a texture cannot be a ' +
    'root descriptor', built.rootSignature);
  check(built.hitGroup === 'procedural',
    'the hit group is procedural, because the file declares an intersection shader',
    String(built.hitGroup));
  check(/ProceduralPrimitiveHitGroup\s+\w+\s*=\s*\{\s*"anyHit",\s*"closestHit",\s*"sphereHit"\s*\}/
    .test(built.source),
    'and it names all three hit shaders in the order DXR expects');

  check(built.payloadBytes >= 16 && built.attributeBytes >= 8,
    'the config maxima clear the floors DXR requires',
    `payload ${built.payloadBytes}, attributes ${built.attributeBytes}`);
  check(built.assumptions.length >= 3,
    'and every synthesised choice is reported rather than hidden',
    built.assumptions.join('\n'));

  // A miss shader binds nothing, and DXC rejects an empty root signature string.
  check(dxr.rootSignature('void nothing() {}') === 'RootFlags(0)',
    'a shader that binds nothing gets RootFlags(0), not an empty string');

  section('3b. Struct sizing');

  check(dxr.structBytes('struct P { float3 colour_0; float hitT_0; };') === 16,
    'a float3 and a float come to 16 bytes');
  check(dxr.structBytes('struct A { float4x4 m; };') === 64, 'a float4x4 is 64');
  check(dxr.structBytes('struct B { float v[3]; };') === 12, 'an array multiplies');
  check(dxr.structBytes('struct C { SomeThing x; };') === null,
    'and something unmodelled returns null rather than a wrong number');

  section('4. Against a real RGA');

  let found = null;
  try {
    found = await rga.resolve(process.env.RGA_PATH || '', run);
  } catch (e) {
    found = null;
  }
  if (!found) {
    skip('rga is not installed here, so the library was never compiled');
    return;
  }

  const listed = await rga.targets(found.path, run, rga.MODE_DXR);
  const asic = listed.length ? listed[listed.length - 1].codename : null;
  if (!asic) {
    skip('this rga lists no DXR targets');
    return;
  }
  console.log(`        rga: ${found.path}, DXR target ${asic}`);

  const outRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dxr-test-'));
  try {
    const compiled = await rga.compileDxr({
      rga: found.path, asic, source: built.source,
      outDir: path.join(outRoot, 'dxr'), run
    });

    check(Object.keys(compiled.listings).length === 6,
      'all six stages compile to RDNA ISA through DXC and AMD\'s driver',
      Object.keys(compiled.listings).join(', '));
    for (const { stage, name } of built.stages) {
      check(!!compiled.listings[name] || !!compiled.listings[stage],
        `the ${stage} shader produced a listing`,
        Object.keys(compiled.listings).join(', '));
    }
    const anyText = Object.values(compiled.listings)[0] || '';
    check(/_amdgpu_\w+|^\w+:/m.test(anyText),
      'and it reads as RDNA ISA rather than as an error message',
      anyText.split('\n').slice(0, 2).join('\n'));
  } finally {
    fs.rmSync(outRoot, { recursive: true, force: true });
  }
}

main().then(() => {
  console.log(`\n${failures ? 'FAIL' : 'PASS'}  ${checks} checks, ${failures} failures` +
    (skipped ? `, ${skipped} skipped` : ''));
  process.exit(failures ? 1 : 0);
}).catch(e => {
  console.log(`\nFAIL  ${e && e.stack ? e.stack : e}`);
  process.exit(1);
});
