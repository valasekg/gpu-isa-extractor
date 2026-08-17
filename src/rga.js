'use strict';

/**
 * Driving the Radeon GPU Analyzer, which is how a Slang shader becomes RDNA ISA.
 *
 * RGA is a third-party requirement located the way `nvdisasm` and `slangc` are - the setting,
 * then PATH, then the usual install roots - and never bundled. It is ~227 MB and MIT-licensed;
 * size alone settles it.
 *
 * ## What is measured here, and why it is not read from the documentation
 *
 * Everything below was established by running RGA 2.14.2.7 rather than by reading it, because
 * its own bundled README is wrong about the part that matters most: it documents the mode
 * strings as `vk-offline-spv` and `vk-offline-spv-txt`, and `rga -h` reports the real names as
 * `vk-spv-offline` and `vk-spv-txt-offline`. A tool driven by the documented spelling fails
 * with "invalid source kind" on every invocation.
 *
 * ## Exit codes do not mean what they should
 *
 * This is the single most important thing about driving RGA, and it shapes `run` below. Three
 * demonstrated cases, all exit 0:
 *
 *   - A raytracing `.spv` passed as a bare input: `Building for gfx1201... succeeded.` and no
 *     output file written at all.
 *   - `--comp` given SPIR-V that is not a compute shader: prints `Error: unable to detect
 *     merged stage for cs shader.` and THEN `succeeded.`, with no output.
 *   - An unsupported target (`-c gfx1030` on 2.14.2): silently not built, no diagnostic.
 *
 * So the only trustworthy success test is that the expected output files exist and parse. That
 * is the same conclusion `spirvToCache`/`carveCache` reached about the NVIDIA driver, and it is
 * enforced here in the same place and for the same reason.
 *
 * ## Two roads, both of which work with no AMD hardware
 *
 *   vk-spv-offline   a static compiler. No driver, no GPU, any listed target.
 *   vulkan           the real AMD driver - RGA ships AMDVLK and falls back to it, so this too
 *                    runs on a machine with no AMD adapter. It is the accurate road, and it
 *                    warns when given no pipeline state.
 *
 * That inverts the NVIDIA graphics road's central constraint: there, the local driver IS the
 * compiler, so the GPU must be present. Here neither road needs one, which is why the doctor
 * says so rather than repeating the NVIDIA caveat.
 */

const fs = require('fs');
const path = require('path');

const spawn = require('./spawn');

/**
 * The offline mode: a static compiler, SPIR-V binary in.
 *
 * `vk-spv-offline`, not the README's `vk-offline-spv`. See the header.
 */
const MODE_OFFLINE = 'vk-spv-offline';

/** The live-driver mode, which reaches AMD's real compiler through the bundled AMDVLK. */
const MODE_DRIVER = 'vulkan';

/**
 * The stage flags each mode accepts, measured from `rga -h -s <mode>`.
 *
 * They differ, and the difference is not documented anywhere else: the offline mode takes mesh
 * and task shaders and the live-driver mode does not. RGA's own GUI manual lists neither.
 * Neither mode has any raytracing stage option at all - `--rgen` is rejected with "Option
 * 'rgen' does not exist" - so those stages are refused by name rather than attempted.
 */
const STAGE_FLAGS = {
  [MODE_OFFLINE]: {
    vertex: '--vert',
    hull: '--tesc',
    domain: '--tese',
    geometry: '--geom',
    fragment: '--frag',
    compute: '--comp',
    mesh: '--mesh',
    amplification: '--task'
  },
  [MODE_DRIVER]: {
    vertex: '--vert',
    hull: '--tesc',
    domain: '--tese',
    geometry: '--geom',
    fragment: '--frag',
    compute: '--comp'
  }
};

/** RGA names its outputs `<asic>_<stem>_<stage>.<ext>`, and the stage word is its own. */
const OUTPUT_STAGE = {
  vertex: 'vert', hull: 'tesc', domain: 'tese', geometry: 'geom',
  fragment: 'frag', compute: 'comp', mesh: 'mesh', amplification: 'task'
};

function exe(name) {
  return process.platform === 'win32' ? `${name}.exe` : name;
}

/**
 * The executable behind a path that may name either it or the directory holding it.
 *
 * Both spellings arrive in practice and neither is a mistake: `compile.rgaPath` reads like a
 * path to rga, while `RGA_PATH` and the install roots read like the unpacked archive. Testing
 * `existsSync` alone accepted a DIRECTORY as the executable and returned it, and the failure
 * then surfaced three calls later as `version unknown` and an empty target list - a bad path
 * reported as an RGA that can build for nothing.
 *
 * @returns {?string} the executable, or null if this names neither one nor a directory holding one
 */
function asExecutable(candidate) {
  let stat;
  try {
    stat = fs.statSync(candidate);
  } catch (e) {
    return null;
  }
  if (!stat.isDirectory()) return candidate;
  const inside = path.join(candidate, exe('rga'));
  return fs.existsSync(inside) ? inside : null;
}

/**
 * Locate rga, in the same order every other tool here is located.
 *
 * Never bundled. RGA is MIT-licensed, so this is a size decision rather than a licence one -
 * the Windows archive is 227 MB, most of it DirectX and OpenCL back ends this road never
 * touches.
 */
async function resolve(configured, run) {
  const tried = [];

  if (configured) {
    const exact = asExecutable(configured);
    if (exact) return { path: exact, from: 'the rgaPath setting' };
    tried.push(`the rgaPath setting (${configured})`);
  }

  // Guarded, because the runner REJECTS when the process cannot be started at all - ENOENT
  // arrives on the child's `error` event rather than as a non-zero exit. Unguarded, a machine
  // with no rga on PATH threw out of `resolve` here, before the install roots below were ever
  // consulted: RGA_PATH and every install root were unreachable, and an RGA sitting in one of
  // them was reported as not installed. `compileview.resolveTools` records the same lesson
  // about the same runner.
  const bare = exe('rga');
  try {
    const probe = await run(bare, ['--version'], { timeout: 15000 });
    if (!probe.failed) return { path: bare, from: 'PATH' };
  } catch (e) {
    // Not startable is an answer, not an exception.
  }
  tried.push('PATH');

  for (const root of installRoots()) {
    const candidate = asExecutable(root);
    if (candidate) return { path: candidate, from: root };
    tried.push(root);
  }

  throw new Error(
    `rga not found. Looked in: ${tried.join(', ')}. The Radeon GPU Analyzer is a free ` +
    'download from https://github.com/GPUOpen-Tools/radeon_gpu_analyzer/releases and is not ' +
    'bundled with this extension; install it, or set `nvIsaExtractor.compile.rgaPath` to an ' +
    'existing rga executable or to the unpacked archive holding one.');
}

/**
 * Where an RGA archive is usually unpacked or installed.
 *
 * `RGA_PATH` is read here as a directory and by the test suites as an override handed to
 * `resolve` as `configured`. Both go through `asExecutable`, so it may be spelled either as the
 * unpacked archive or as the executable inside it; the only difference between the two
 * positions is precedence, and an explicit override outranking PATH is what a test harness
 * wants for the same reason `VSCODE_EXE` does.
 */
function installRoots() {
  const roots = [];
  if (process.env.RGA_PATH) roots.push(process.env.RGA_PATH);
  for (const key of ['ProgramFiles', 'ProgramFiles(x86)', 'LOCALAPPDATA']) {
    const base = process.env[key];
    if (base) roots.push(path.join(base, 'RGA'));
  }
  return roots;
}

/** The version string, for the banner and the doctor. */
async function version(rgaPath, run) {
  const probe = await run(rgaPath, ['--version'], { timeout: 15000 });
  const line = `${probe.stdout || ''}${probe.stderr || ''}`.split('\n')
    .map(s => s.trim()).find(s => /Radeon GPU Analyzer/i.test(s));
  return line || 'version unknown';
}

/**
 * Every target this RGA can build for IN A GIVEN MODE, as `{ codename, architecture }`.
 *
 * Asked rather than hardcoded, because the list SHRINKS between releases: 2.14.2's Vulkan
 * offline mode lists ten codenames, all RDNA3, RDNA3.5 and RDNA4, and dropped every gfx9/gfx10
 * target an earlier version accepted - while still shipping `isa_spec/amdgpu_isa_rdna1.xml`.
 * A pinned default would stop working on an upgrade, and an unsupported `-c` is silently
 * ignored rather than refused, so this is also what makes a bad target a refusal instead of an
 * empty output directory.
 *
 * Per mode, and not by tidiness: the same RGA offers DIFFERENT targets depending on `-s`.
 * Measured on 2.14.2 - the Vulkan offline mode lists 10, and the DXR mode lists 27, reaching
 * back to gfx900 (Vega) and including the RDNA1 and CDNA parts Vulkan has dropped. Asking one
 * mode about another's targets returns a confident wrong answer.
 */
async function targets(rgaPath, run, mode = MODE_OFFLINE) {
  const probe = await run(rgaPath, ['-s', mode, '--list-asics'], { timeout: 60000 });
  const out = `${probe.stdout || ''}${probe.stderr || ''}`;
  const found = [];
  for (const line of out.split('\n')) {
    const m = /^(gfx\w+)\s*\(([^)]*)\)/.exec(line.trim());
    if (m) found.push({ codename: m[1], architecture: m[2] });
  }
  return found;
}

/**
 * Compile SPIR-V modules to ISA.
 *
 * @param {object} options
 * @param {string} options.rga        the executable
 * @param {string} options.asic       a codename from `targets()`
 * @param {object} options.modules    stage -> .spv path
 * @param {string} options.outDir     where to write; emptied first
 * @param {string} [options.mode]     MODE_OFFLINE or MODE_DRIVER
 * @param {?string} [options.pso]     a .gpso/.cpso pipeline state file, live-driver mode only
 * @param {?string} [options.binary]  ask for the pipeline ELF here as well as the listings
 * @param {*} [options.token]         cancellation
 * @param {function} options.run      the process runner
 * @returns {Promise<{listings, statistics, binaryPath, argv, log, mode}>}
 *   `listings` is stage -> ISA text. Empty is a FAILURE, not an empty answer; see below.
 *   `binaryPath` is where the ELF really landed, which is NOT the path asked for - RGA
 *   prefixes the device onto the basename - or null if none was asked for or none appeared.
 */
async function compile({ rga, asic, modules, outDir, mode = MODE_OFFLINE, pso, binary,
  token, run }) {
  const flags = STAGE_FLAGS[mode];
  const unsupported = Object.keys(modules).filter(stage => !flags[stage]);
  if (unsupported.length) {
    throw new Error(
      `${unsupported.join(' and ')} cannot be compiled in RGA's ${mode} mode. ` +
      (mode === MODE_DRIVER
        ? 'The live-driver mode takes vertex, tessellation, geometry, fragment and compute; ' +
          'mesh and amplification are offline-mode only.'
        : `This mode takes ${Object.keys(flags).join(', ')}.`));
  }

  // Emptied rather than merely created. RGA names its outputs from the stem it is given, so a
  // previous run's files for a stage this run does not build would be read back as this run's.
  await fs.promises.rm(outDir, { recursive: true, force: true });
  await fs.promises.mkdir(outDir, { recursive: true });

  const isaStem = path.join(outDir, 'isa.txt');
  const statsStem = path.join(outDir, 'stats.csv');
  const args = ['-s', mode, '-c', asic, '--isa', isaStem, '-a', statsStem];
  if (pso && mode === MODE_DRIVER) args.push('--pso', pso);
  // `-b` is the whole pipeline's ELF, one file rather than one per stage - which is why the
  // entries this road produces carry no per-stage microcode. Off unless asked for: it is
  // 36 KB for a two-stage pipeline whose listings are a few KB, and nothing needs it to read
  // the ISA. `disassembleCodeObject` is what makes it worth having at all.
  if (binary) args.push('-b', binary);
  for (const [stage, file] of Object.entries(modules)) args.push(flags[stage], file);

  const result = await run(rga, args, { timeout: 300000, token });
  if (result.cancelled) throw new Error('cancelled');
  const log = `${result.stdout || ''}${result.stderr || ''}`;

  // The exit code is not the test - see the header. What was actually written is.
  const listings = {};
  const statistics = {};
  for (const stage of Object.keys(modules)) {
    const isa = path.join(outDir, `${asic}_isa_${OUTPUT_STAGE[stage]}.txt`);
    const csv = path.join(outDir, `${asic}_stats_${OUTPUT_STAGE[stage]}.csv`);
    if (fs.existsSync(isa)) listings[stage] = await fs.promises.readFile(isa, 'utf8');
    if (fs.existsSync(csv)) statistics[stage] = await fs.promises.readFile(csv, 'utf8');
  }

  if (!Object.keys(listings).length) {
    throw new Error(
      `rga wrote no ISA for ${Object.keys(modules).join(', ')} and exited ${result.code}. ` +
      'Its exit code does not report failure - it prints "succeeded" for an unsupported ' +
      'target, an unrecognised stage, and a shader it declined to build - so an empty output ' +
      `directory is the only signal there is.${log.trim() ? `\n${log.trim()}` : ''}`);
  }

  // Where the ELF really landed. Asked for `pipeline.bin`, RGA writes `gfx1201_pipeline.bin`,
  // so the path handed in is not the path to read back.
  let binaryPath = null;
  if (binary) {
    const decorated = path.join(path.dirname(binary), `${asic}_${path.basename(binary)}`);
    if (fs.existsSync(decorated)) binaryPath = decorated;
    else if (fs.existsSync(binary)) binaryPath = binary;
  }

  return { listings, statistics, binaryPath, argv: result.argv, log, mode };
}

// ------------------------------------------------------------------------ raytracing

/** `-s dxr`. DirectX Raytracing, and the only road to RDNA raytracing ISA there is. */
const MODE_DXR = 'dxr';

/**
 * Compile a DXR library.
 *
 * `--offline` always. It means "assume no AMD display adapter is installed", and RGA then uses
 * the `amdxc64.dll` it ships with - measured working on a machine with only an NVIDIA adapter,
 * which is the same claim the Vulkan roads make and the reason this whole target needs no AMD
 * hardware. Passing it unconditionally costs nothing on a machine that does have one.
 *
 * The output names are `<asic>_<Stage>_<function>_isa.txt`, so the listings come back keyed by
 * the ENTRY POINT NAME rather than by stage - which is what a raytracing pipeline wants, since
 * a file can hold two miss shaders and "miss" would not say which.
 *
 * @param {string} options.source   the merged library text; written out here
 * @returns {Promise<{listings, statistics, argv, log, mode}>}
 */
async function compileDxr({ rga, asic, source, outDir, token, run }) {
  await fs.promises.rm(outDir, { recursive: true, force: true });
  await fs.promises.mkdir(outDir, { recursive: true });

  const hlsl = path.join(outDir, 'library.hlsl');
  await fs.promises.writeFile(hlsl, source, 'utf8');

  const args = ['-s', MODE_DXR, '--offline', '-c', asic, '--hlsl', hlsl,
    '--isa', path.join(outDir, 'isa.txt'), '-a', path.join(outDir, 'stats.csv')];

  const result = await run(rga, args, { timeout: 300000, token });
  if (result.cancelled) throw new Error('cancelled');
  const log = `${result.stdout || ''}${result.stderr || ''}`;

  const listings = {};
  const statistics = {};
  // `<asic>_<Stage>_<entry>_isa.txt`. The stage prefix is RGA's own capitalised spelling and
  // the entry name is the function's, so both are recovered rather than reconstructed.
  const NAME_RE = new RegExp(`^${asic}_([A-Za-z]+)_(\\w+)_(isa|stats)\\.(?:txt|csv)$`);
  for (const file of await fs.promises.readdir(outDir)) {
    const m = NAME_RE.exec(file);
    if (!m) continue;
    const [, , entry, kind] = m;
    const text = await fs.promises.readFile(path.join(outDir, file), 'utf8');
    (kind === 'isa' ? listings : statistics)[entry] = text;
  }

  if (!Object.keys(listings).length) {
    throw new Error(
      `rga built no raytracing ISA for ${asic} and exited ${result.code}. A DXR pipeline needs ` +
      'a raygeneration shader - it is the only stage a driver will start - and a state object ' +
      'it cannot build reports exactly like this.' +
      `${log.trim() ? `\n${log.trim()}` : ''}`);
  }

  return { listings, statistics, argv: result.argv, log, mode: MODE_DXR };
}

// --------------------------------------------------------------- reading a code object

/** `-s bin`. Not a compile: a reader over an ELF that already holds compiled code. */
const MODE_BINARY = 'bin';

const ELF_MAGIC = 0x464c457f;                  // "\x7fELF" little-endian
const EM_AMDGPU = 224;
const ELFOSABI_AMDGPU_HSA = 64;

/** RGA's output stage suffix back to the vocabulary the rest of this codebase uses. */
const STAGE_OF_OUTPUT = Object.fromEntries(
  Object.entries(OUTPUT_STAGE).map(([stage, suffix]) => [suffix, stage]));

/** `<device>_isa_<stage>.txt` / `<device>_stats_<stage>.csv`, whatever the device turns out to be. */
const OUTPUT_NAME_RE = /^(.+)_(isa|stats)_([a-z]+)\.(?:txt|csv)$/;

/**
 * Is this an AMD code object?
 *
 * Two independent markers rather than one, because `.bin` is a contested extension here - the
 * NVIDIA road's GLCache blobs use it too, and those are not ELF at all. `EI_OSABI` and
 * `e_machine` are set by different parts of the toolchain, so requiring both means a file has
 * to be an AMDGPU ELF on two separate accounts before this road claims it.
 *
 * Deliberately a pure buffer test, so the routing decision can be made without spawning RGA.
 */
function isCodeObject(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 64) return false;
  if (buf.readUInt32LE(0) !== ELF_MAGIC) return false;
  if (buf[4] !== 2 || buf[5] !== 1) return false;             // ELF64, little-endian
  return buf.readUInt16LE(18) === EM_AMDGPU &&
    buf[7] >= ELFOSABI_AMDGPU_HSA && buf[7] <= ELFOSABI_AMDGPU_HSA + 3;
}

/**
 * Disassemble an AMD code object, the counterpart of the cubin road.
 *
 * Two things make this different from `compile()` above, both measured rather than assumed:
 *
 *   1. **It takes no target.** `-s bin` reads the target out of the code object and says so -
 *      "Target GPU detected: gfx1201 (RDNA4)" - which is why there is no `asic` parameter to
 *      get wrong. Passing `-c` here would be inventing an answer the file already contains.
 *   2. **The output names are not predictable.** `compile()` can build the filenames it
 *      expects because it chose the device and the stages. Here BOTH come out of the ELF, so
 *      the directory is emptied first and then read back for whatever landed in it. Guessing
 *      the stem would mean knowing the answer before asking the question.
 *
 * Measured against the road that produced the ELF: the read-back listings are BYTE-IDENTICAL
 * to the ones `compile()` wrote in the same run, both stages of a pipeline recovered
 * separately from the single pipeline ELF. So this is a reader, not a second compiler, and
 * `test_rga.js` pins that.
 *
 * @param {string} options.rga      the executable
 * @param {string} options.co       path to the code object
 * @param {string} options.outDir   where to write; emptied first
 * @param {*} [options.token]       cancellation
 * @param {function} options.run    the process runner
 * @returns {Promise<{listings, statistics, device, stages, argv, log, mode}>}
 */
async function disassembleCodeObject({ rga, co, outDir, token, run }) {
  await fs.promises.rm(outDir, { recursive: true, force: true });
  await fs.promises.mkdir(outDir, { recursive: true });

  const args = ['-s', MODE_BINARY, '--co', co,
    '--isa', path.join(outDir, 'isa.txt'),
    '-a', path.join(outDir, 'stats.csv')];

  const result = await run(rga, args, { timeout: 300000, token });
  if (result.cancelled) throw new Error('cancelled');
  const log = `${result.stdout || ''}${result.stderr || ''}`;

  const listings = {};
  const statistics = {};
  const devices = new Set();
  for (const name of await fs.promises.readdir(outDir)) {
    const m = OUTPUT_NAME_RE.exec(name);
    if (!m) continue;
    const [, device, kind, suffix] = m;
    // An unknown suffix is kept under its own name rather than dropped. RGA grows stages
    // faster than this table does, and a listing nobody can read is still better than one
    // silently discarded.
    const stage = STAGE_OF_OUTPUT[suffix] || suffix;
    devices.add(device);
    const text = await fs.promises.readFile(path.join(outDir, name), 'utf8');
    (kind === 'isa' ? listings : statistics)[stage] = text;
  }

  if (!Object.keys(listings).length) {
    throw new Error(
      `rga wrote no ISA for ${path.basename(co)} and exited ${result.code}. Its exit code ` +
      'does not report failure, so an empty output directory is the only signal there is. ' +
      'A code object built for a target this RGA no longer supports fails exactly like ' +
      `this.${log.trim() ? `\n${log.trim()}` : ''}`);
  }

  // The device from the FILENAMES, not from the log. Both are RGA's word for it, but the
  // filenames are the ones the listings actually arrived under - parsing the human-readable
  // banner would be trusting prose over structure.
  return {
    listings,
    statistics,
    device: devices.size === 1 ? [...devices][0] : null,
    stages: Object.keys(listings),
    argv: result.argv,
    log,
    mode: MODE_BINARY
  };
}

/**
 * The statistics CSV as an object, or null.
 *
 * One header row and one data row. Four of the sixteen columns are OpenCL-mode fields that
 * read 0 for every Vulkan shader measured - including a compute shader with a declared
 * workgroup size - so they are reported as ABSENT rather than as zero. Printing
 * `wavefront size: 0` would be stating a measurement that was never taken.
 */
const ALWAYS_ZERO = new Set([
  'THREADS_PER_WORKGROUP', 'WAVEFRONT_SIZE',
  'CL_WORKGROUP_X_DIMENSION', 'CL_WORKGROUP_Y_DIMENSION', 'CL_WORKGROUP_Z_DIMENSION'
]);

function readStatistics(csv) {
  const lines = String(csv || '').trim().split(/\r?\n/);
  if (lines.length < 2) return null;
  const head = lines[0].split(',').map(s => s.trim());
  const row = lines[1].split(',').map(s => s.trim());

  const out = {};
  head.forEach((name, i) => {
    const raw = row[i];
    if (raw === undefined || raw === '') return;
    if (ALWAYS_ZERO.has(name)) return;
    const n = Number(raw);
    out[name] = Number.isFinite(n) ? n : raw;
  });
  return out;
}

module.exports = {
  MODE_OFFLINE,
  MODE_DRIVER,
  MODE_BINARY,
  MODE_DXR,
  STAGE_FLAGS,
  OUTPUT_STAGE,
  STAGE_OF_OUTPUT,
  ALWAYS_ZERO,
  asExecutable,
  resolve,
  version,
  targets,
  compile,
  compileDxr,
  isCodeObject,
  disassembleCodeObject,
  readStatistics,
  installRoots
};
