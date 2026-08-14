'use strict';

/**
 * Driving RGA, in two halves.
 *
 * The first half needs nothing installed: it checks the CSV reader and the mode tables against
 * captured output. The second needs an RGA on this machine and SKIPS rather than fails without
 * one, following `test_gfx.js`, whose second half skips without an NVIDIA GPU for the same
 * reason - a machine that cannot run a check has not failed it.
 *
 * The skip axes are three rather than one, because "RGA is installed" is not sufficient:
 *
 *   (a) rga resolves at all
 *   (b) the target this asserts against appears in THIS rga's `--list-asics`
 *   (c) the fixtures to feed it exist
 *
 * (b) matters because the list shrinks between releases - 2.14.2 dropped every gfx9 and gfx10
 * target an earlier version accepted. A digest pinned against a target this RGA cannot build
 * would fail for a reason that is not a regression, so those checks name what is missing and
 * skip. The relational checks - "the same input twice is identical", "paired differs from
 * alone" - run against whatever target IS available, because they assert a relationship rather
 * than a value.
 *
 *   ELECTRON_RUN_AS_NODE=1 Code.exe tools/test_rga.js
 */

const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const rga = require(path.join(__dirname, '..', 'src', 'rga.js'));

const FIXTURES = path.join(__dirname, 'fixtures', 'rdna');
const SPV = path.join(__dirname, 'fixtures', 'gfx');

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

/** The runner `rga.js` takes, in the shape `spawn.text` returns. */
function run(exe, args, { timeout = 60000 } = {}) {
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
  /* ------------------------------------------------ 1. what needs nothing --- */

  section('1. The statistics CSV, from captured output');

  const csv = fs.readFileSync(path.join(FIXTURES, 'gfx1201-fragment.csv'), 'utf8');
  const stats = rga.readStatistics(csv);
  check(stats !== null, 'the captured CSV parses');
  check(stats.USED_VGPRs === 12, 'VGPRs used is read', stats && stats.USED_VGPRs);
  check(stats.AVAILABLE_VGPRs === 256, 'and how many there were', stats && stats.AVAILABLE_VGPRs);
  check(stats.USED_SGPRs === 3, 'SGPRs used is read', stats && stats.USED_SGPRs);
  check(stats.ISA_SIZE === 392, 'the code size is read', stats && stats.ISA_SIZE);
  check(stats.VGPR_SPILLS === 0 && stats.SGPR_SPILLS === 0, 'spills are read as numbers');
  check(stats.DEVICE === 'gfx1201', 'the device is read as a string', stats && stats.DEVICE);

  // The OpenCL columns read 0 for every Vulkan shader measured, including a compute shader
  // with a declared workgroup size. Reporting them as 0 would state a measurement that was
  // never taken.
  for (const name of rga.ALWAYS_ZERO) {
    check(!(name in stats), `${name} is absent rather than zero`);
  }

  // The CSV is a contract with a third party, and the reader indexes it BY NAME - so a column
  // that is renamed or dropped between RGA releases silently turns a banner figure into
  // nothing, with no error anywhere. Pinning the header is what turns that into one loud
  // failure naming the column.
  const header = csv.trim().split(/\r?\n/)[0].split(',').map(s => s.trim());
  const EXPECTED = [
    'DEVICE', 'SCRATCH_MEM', 'THREADS_PER_WORKGROUP', 'WAVEFRONT_SIZE',
    'AVAILABLE_LDS_BYTES', 'USED_LDS_BYTES', 'AVAILABLE_SGPRs', 'USED_SGPRs', 'SGPR_SPILLS',
    'AVAILABLE_VGPRs', 'USED_VGPRs', 'VGPR_SPILLS',
    'CL_WORKGROUP_X_DIMENSION', 'CL_WORKGROUP_Y_DIMENSION', 'CL_WORKGROUP_Z_DIMENSION',
    'ISA_SIZE'
  ];
  check(header.length === 16, 'the statistics CSV has exactly 16 columns', header.length);
  check(header.join(',') === EXPECTED.join(','),
    'and they are the ones the banner reads, in order',
    `got:  ${header.join(',')}\nwant: ${EXPECTED.join(',')}`);

  // Every column the banner actually consumes, named here so dropping one from the reader is
  // as visible as dropping one from RGA.
  for (const name of ['USED_VGPRs', 'AVAILABLE_VGPRs', 'USED_SGPRs', 'AVAILABLE_SGPRs',
    'USED_LDS_BYTES', 'AVAILABLE_LDS_BYTES', 'SCRATCH_MEM', 'VGPR_SPILLS', 'SGPR_SPILLS',
    'ISA_SIZE']) {
    check(header.includes(name), `the banner's ${name} column exists`);
  }

  section('1b. The second opinion, and when it should speak');

  const amd = require(path.join(__dirname, '..', 'src', 'isa_amd.js'));
  const listing = fs.readFileSync(path.join(FIXTURES, 'gfx1201-fragment.isa'), 'utf8');
  const measured = amd.target.statsProfile.analyze(listing, { statistics: stats });

  check(measured.instructions > 30, 'the listing is measured, not guessed at',
    measured.instructions);
  check(measured.registers.maxVector >= 0 && measured.registers.maxVector < stats.USED_VGPRs,
    'the highest VGPR the code names sits below what RGA allocated',
    `code reaches v${measured.registers.maxVector}, RGA allocated ${stats.USED_VGPRs}`);
  check(measured.mix.length > 1, 'the mix has more than one encoding class',
    measured.mix.map(m => m.category).join(', '));

  // A fragment shader reads its interpolants with `ds_param_load`, out of LDS the RASTERIZER
  // wrote - so it consumes no LDS allocation, and RGA reporting zero is correct. Counting
  // those as LDS use made the cross-check fire on an ordinary fragment shader, which is the
  // crying-wolf failure that gets a check switched off.
  check(/ds_param_load/.test(listing), 'this fixture does read interpolants through DS');
  check(measured.usesLds === false,
    'and that is not counted as using the shader\'s own LDS allocation');
  check(amd.target.statsProfile.crossCheck(measured, null).length === 0,
    'so the two accounts agree and the banner says nothing',
    amd.target.statsProfile.crossCheck(measured, null).join('; '));

  // The cross-check must still fire when it should. `used > allocated` is the impossible
  // direction; equality is not expected, because an allocation legitimately rounds up.
  const impossible = amd.target.statsProfile.crossCheck(
    { ...measured, declared: { ...stats, USED_VGPRs: 1 } }, null);
  check(impossible.length > 0 && /being read wrong/.test(impossible[0]),
    'but a code that names more registers than RGA allocated is reported',
    impossible.join('; '));
  const rounded = amd.target.statsProfile.crossCheck(
    { ...measured, declared: { ...stats, USED_VGPRs: 64 } }, null);
  check(rounded.length === 0,
    'while an allocation ABOVE what the code touches is ordinary and stays quiet',
    rounded.join('; '));

  section('2. The mode tables say what RGA measurably accepts');

  const offline = rga.STAGE_FLAGS[rga.MODE_OFFLINE];
  const driver = rga.STAGE_FLAGS[rga.MODE_DRIVER];
  check(offline.mesh === '--mesh' && offline.amplification === '--task',
    'the offline mode takes mesh and amplification');
  check(!driver.mesh && !driver.amplification,
    'and the live-driver mode does not - measured, and contrary to RGA\'s own GUI manual');
  check(!offline.raygeneration && !driver.raygeneration,
    'neither mode has a raytracing stage, so those are refused rather than attempted');
  check(rga.MODE_OFFLINE === 'vk-spv-offline',
    'the offline mode string is the one `rga -h` reports, not the one its README documents',
    rga.MODE_OFFLINE);

  /* ------------------------------------------------- 3. what needs an RGA --- */

  section('3. Against a real RGA');

  // RGA_PATH for the same reason verify.py takes VSCODE_EXE: an unpacked archive is a
  // perfectly good RGA, and without this the whole section below skips on any machine that
  // has one but has not installed it - which is most machines that have one at all.
  let found = null;
  try {
    found = await rga.resolve(process.env.RGA_PATH || '', run);
  } catch (e) {
    found = null;
  }
  if (!found) {
    skip('rga is not installed here, so nothing below ran');
    return;
  }
  console.log(`        rga: ${found.path} (via ${found.from})`);
  console.log(`        ${await rga.version(found.path, run)}`);

  const listed = await rga.targets(found.path, run);
  check(listed.length > 0, 'it lists at least one target', `${listed.length} listed`);

  const asic = listed.length ? listed[0].codename : null;
  const haveSpv = fs.existsSync(path.join(SPV, 'vs.spv')) &&
    fs.existsSync(path.join(SPV, 'fs.spv'));
  if (!asic || !haveSpv) {
    skip(asic ? 'the SPIR-V fixtures are missing' : 'this rga lists no targets');
    return;
  }

  const outRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rga-test-'));
  try {
    const paired = await rga.compile({
      rga: found.path,
      asic,
      modules: { vertex: path.join(SPV, 'vs.spv'), fragment: path.join(SPV, 'fs.spv') },
      outDir: path.join(outRoot, 'paired'),
      run
    });
    check(!!paired.listings.fragment && !!paired.listings.vertex,
      `both stages produced ISA for ${asic}`,
      Object.keys(paired.listings).join(', '));
    check(/_amdgpu_\w+_main:/.test(paired.listings.fragment || ''),
      'the fragment listing opens with a hardware entry symbol');
    check(!!paired.statistics.fragment, 'and a statistics CSV came with it');

    // Deterministic: the same input twice must give the same text, or nothing downstream can
    // be pinned at all.
    const again = await rga.compile({
      rga: found.path,
      asic,
      modules: { vertex: path.join(SPV, 'vs.spv'), fragment: path.join(SPV, 'fs.spv') },
      outDir: path.join(outRoot, 'again'),
      run
    });
    check(again.listings.fragment === paired.listings.fragment,
      'the same SPIR-V compiled twice gives byte-identical ISA');

    // The measured reason `generateProducer` is not redundant on AMD: RGA accepts a lone
    // fragment shader, exits 0, and returns a DIFFERENT, larger shader.
    const alone = await rga.compile({
      rga: found.path,
      asic,
      modules: { fragment: path.join(SPV, 'fs.spv') },
      outDir: path.join(outRoot, 'alone'),
      run
    });
    check(!!alone.listings.fragment, 'a lone fragment shader is accepted by rga');
    check(alone.listings.fragment !== paired.listings.fragment,
      'and produces different code from the same shader compiled with its vertex shader - ' +
      'which is why a producer is synthesised rather than skipped');

    // The failure mode that matters: exit 0 with nothing written must be an error here.
    let refused = null;
    try {
      await rga.compile({
        rga: found.path,
        asic: 'gfx0000',
        modules: { fragment: path.join(SPV, 'fs.spv') },
        outDir: path.join(outRoot, 'bogus'),
        run
      });
    } catch (e) {
      refused = e.message;
    }
    check(refused !== null && /wrote no ISA/.test(refused),
      'an unsupported target is a refusal here, though rga itself reports success',
      refused === null ? 'it returned instead of throwing' : refused.split('\n')[0]);
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
