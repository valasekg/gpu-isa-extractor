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

/** What `rga.js` looks for inside a directory, spelled the same way it spells it. */
const RGA_EXE = process.platform === 'win32' ? 'rga.exe' : 'rga';

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

  section('2b. Resolution, which needs no RGA to be wrong');

  // A directory used to be returned AS the executable, because `existsSync` is true for one.
  // Nothing failed at that point: `version` then read "version unknown", `--list-asics` listed
  // nothing, and the doctor reported an RGA that could build for no target - a bad path
  // reported as a useless install. These use this repository's own tree as a directory that
  // certainly exists and certainly holds no rga.
  const notRga = path.join(__dirname, '..');
  check(rga.asExecutable(notRga) === null,
    'a directory with no rga in it resolves to nothing, rather than to itself');
  check(rga.asExecutable(path.join(notRga, 'no-such-thing-here')) === null,
    'and so does a path that does not exist');
  check(rga.asExecutable(__filename) === __filename,
    'while a file is taken as the executable it names');

  // The PATH probe rejects rather than returning `failed` when the executable cannot be
  // started at all, and unguarded that exception left `resolve` before it reached the install
  // roots - making RGA_PATH and every root below it unreachable. A runner that always throws
  // reproduces the machine that has no rga on PATH, which is most machines.
  //
  // The install roots are read from the environment, so they are emptied for the length of
  // this check rather than inherited: on a machine that HAS an RGA in one of them, `resolve`
  // rightly finds it, and the assertion would then be measuring this machine instead of the
  // code. The whole point here is the road taken when nothing is found anywhere.
  const throwing = () => Promise.reject(new Error('could not run rga.exe: spawn rga.exe ENOENT'));
  const ROOT_VARS = ['RGA_PATH', 'ProgramFiles', 'ProgramFiles(x86)', 'LOCALAPPDATA'];
  const saved = ROOT_VARS.map(name => [name, process.env[name]]);
  const planted = fs.mkdtempSync(path.join(os.tmpdir(), 'rga-root-'));
  for (const name of ROOT_VARS) delete process.env[name];
  try {
    let reached = false;
    try {
      await rga.resolve('', throwing);
    } catch (e) {
      reached = /Looked in: .*PATH/.test(e.message);
    }
    check(reached,
      'an unstartable rga on PATH is an answer, so the search continues past it',
      'resolve rethrew the spawn error instead of reporting where it looked');

    // The configured path is consulted BEFORE the probe, so it survives the same runner.
    const configured = await rga.resolve(notRga, throwing).then(f => f.from, () => null);
    check(configured === null,
      'a configured directory holding no rga falls through rather than being believed');

    // The half that was unreachable: a root IS consulted after the probe fails. Only the
    // name is needed, since `asExecutable` asks the filesystem and not the loader, so this
    // pins the road without a 227 MB download.
    fs.writeFileSync(path.join(planted, RGA_EXE), '');
    process.env.RGA_PATH = planted;
    check(rga.installRoots()[0] === planted, 'RGA_PATH is the first root consulted');
    const viaRoot = await rga.resolve('', throwing).then(f => f.path, () => null);
    check(viaRoot === path.join(planted, RGA_EXE),
      'and an rga sitting in it is found, which is what the failed probe used to prevent',
      String(viaRoot));

    // Same root, spelled as the executable rather than as the archive holding it.
    process.env.RGA_PATH = path.join(planted, RGA_EXE);
    const spelledExe = await rga.resolve('', throwing).then(f => f.path, () => null);
    check(spelledExe === path.join(planted, RGA_EXE),
      'and RGA_PATH means the same thing spelled either way');
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    fs.rmSync(planted, { recursive: true, force: true });
  }

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

    // Experiment 13, as a check rather than a note.
    //
    // The live driver given NO pipeline state uses one RGA invented, and that default is what
    // made live and offline disagree - not the two compilers. Given any pipeline state, even an
    // empty one, the live driver was measured byte-identical to the offline compiler. This is
    // what lets the banner say the offline listing IS what the driver produces rather than
    // hedging about both. If it ever stops being true, the banner is overclaiming and should
    // be caught here.
    const pso = path.join(outRoot, 'empty.gpso');
    // Deliberately empty - it carries no layout at all. That is the point: it is not that a
    // CORRECT state closes the gap, it is that ANY state does, because what the default state
    // was doing was not modelling your pipeline either.
    fs.writeFileSync(pso, JSON.stringify({
      VkGraphicsPipelineCreateInfo: { basePipelineIndex: -1 },
      VkPipelineLayoutCreateInfo: { setLayoutCount: 0, pSetLayouts: [] }
    }, null, 2), 'utf8');

    const liveDefault = await rga.compile({
      rga: found.path, asic, mode: rga.MODE_DRIVER,
      modules: { vertex: path.join(SPV, 'vs.spv'), fragment: path.join(SPV, 'fs.spv') },
      outDir: path.join(outRoot, 'live-default'), run
    }).catch(() => null);
    const liveStated = await rga.compile({
      rga: found.path, asic, mode: rga.MODE_DRIVER, pso,
      modules: { vertex: path.join(SPV, 'vs.spv'), fragment: path.join(SPV, 'fs.spv') },
      outDir: path.join(outRoot, 'live-stated'), run
    }).catch(() => null);

    if (!liveDefault || !liveStated) {
      skip('the live-driver mode did not run here, so the pipeline-state finding is unchecked');
    } else {
      check(liveStated.listings.fragment === paired.listings.fragment,
        'the live driver given a pipeline state is byte-identical to the offline compiler',
        liveStated.listings.fragment === paired.listings.fragment ? '' :
          'they differ, so the banner\'s claim that offline IS the driver\'s code is wrong');
      check(liveDefault.listings.fragment !== liveStated.listings.fragment,
        'while the same driver with NO state produces something else - which is the ' +
        'default RGA invents, and the reason the two ever looked like they disagreed');
    }

    // The binary road, against the road that made the file. `-s bin` is claimed to be a READER
    // rather than a second compiler, and the only way to hold it to that is to disassemble an
    // ELF whose listings are already in hand and require them to match exactly.
    const withElf = await rga.compile({
      rga: found.path, asic,
      modules: { vertex: path.join(SPV, 'vs.spv'), fragment: path.join(SPV, 'fs.spv') },
      outDir: path.join(outRoot, 'with-elf'),
      binary: path.join(outRoot, 'with-elf', 'pipeline.bin'),
      run
    });
    check(!!withElf.binaryPath && fs.existsSync(withElf.binaryPath),
      'asking for -b produces an ELF, and the path it really landed at is reported',
      `asked for pipeline.bin, got ${withElf.binaryPath}`);

    check(rga.isCodeObject(fs.readFileSync(withElf.binaryPath)),
      'and it sniffs as an AMD code object, on both e_machine and EI_OSABI');
    check(!rga.isCodeObject(fs.readFileSync(path.join(SPV, 'fs.spv'))),
      'while a SPIR-V module does not - it is not even an ELF');
    check(!rga.isCodeObject(Buffer.alloc(64)),
      'nor do 64 zero bytes, which are long enough to read but say nothing');

    const readBack = await rga.disassembleCodeObject({
      rga: found.path, co: withElf.binaryPath,
      outDir: path.join(outRoot, 'readback'), run
    });
    check(readBack.device === asic,
      'the target comes out of the code object rather than being supplied',
      `detected ${readBack.device}, compiled for ${asic}`);
    check(!readBack.argv.includes('-c'),
      'and no -c was passed, because the file already knows');
    check(readBack.stages.includes('vertex') && readBack.stages.includes('fragment'),
      'both stages are recovered separately from the one pipeline ELF',
      readBack.stages.join(', '));
    check(readBack.listings.fragment === paired.listings.fragment &&
      readBack.listings.vertex === paired.listings.vertex,
      'and every listing is BYTE-IDENTICAL to what the compile road wrote',
      'they differ, so -s bin is disassembling differently rather than reading back');

    // The whole road, through compile() rather than through rga.js - because the parts that
    // decide a .bin is a code object at all, and that a code object's banner says "read from"
    // rather than "compiled", live there and are not reached by the calls above.
    const compile = require(path.join(__dirname, '..', 'src', 'compile.js'));
    const amd = require(path.join(__dirname, '..', 'src', 'isa_amd.js'));

    check(await compile.detectLanguage(withElf.binaryPath) === 'codeobject',
      'a .bin whose header says AMDGPU is routed as a code object');
    check(await compile.detectLanguage(path.join(SPV, 'fs.spv')) === null,
      'while a .spv is not, and neither extension was consulted to decide it');
    check(await compile.detectLanguage('nowhere.slang') === 'slang',
      'and an ordinary source file still routes on its name');

    const built = await compile.compile({ rga: found.path }, withElf.binaryPath,
      { outDir: path.join(outRoot, 'via-compile') });
    check(built.road === 'rga' && built.asic === asic,
      'compile() takes the binary road and reports the detected target',
      `road=${built.road} asic=${built.asic}`);
    check(built.entries.length === 2,
      'both stages in the container become entries', `${built.entries.length} entries`);
    check(built.entries.every(e => e.origin === 'binary'),
      'each marked as read rather than compiled',
      built.entries.map(e => e.origin).join(', '));
    check(built.accuracy === null,
      'and no accuracy note, because this road compiled nothing to be accurate about');

    // The banner has to render for this origin. A provenance row that throws takes out the
    // whole listing, and `binary` is a row nothing else exercises.
    const rows = amd.target.provenance[built.entries[0].origin](
      { object: { source: withElf.binaryPath }, compile: built }, null,
      label => `// ${label.padEnd(14)}  `);
    check(rows.some(l => /read from/.test(l)) && rows.some(l => /detected in the code object/.test(l)),
      'the banner says where it was read from and that the target came out of the file',
      rows.join('\n'));
    check(!rows.some(l => /compiled/.test(l)),
      'and does not claim to have compiled anything');

    // A code object is not a SPIR-V module. Feeding it the wrong file must be a refusal.
    let notAnElf = null;
    try {
      await rga.disassembleCodeObject({
        rga: found.path, co: path.join(SPV, 'fs.spv'),
        outDir: path.join(outRoot, 'not-elf'), run
      });
    } catch (e) {
      notAnElf = e.message;
    }
    check(notAnElf !== null && /wrote no ISA/.test(notAnElf),
      'and a SPIR-V module handed to the binary road is refused rather than half-read',
      notAnElf === null ? 'it returned instead of throwing' : notAnElf.split('\n')[0]);

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
