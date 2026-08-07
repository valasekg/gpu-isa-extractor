'use strict';

/**
 * Compile a source file to a cubin, so a shader can be read as SASS without going near a
 * driver cache.
 *
 *     .slang --slangc--> .cu --nvrtc--> .ptx --ptxas--> .cubin --cubin.js--> microcode
 *     .cu ------------------nvrtc--> .ptx --ptxas--> .cubin --cubin.js--> microcode
 *
 * The last step is the point of the whole arrangement: `cubin.entryPoints` yields the same
 * shape `nvcache.carveAt` yields, so a compiled kernel travels the *existing* pipeline -
 * `nvdisasm --binary`, the control-code column, the scoreboard scan, the statistics - rather
 * than a parallel one that would drift out of step with it.
 *
 * ## Why nvrtc and not nvcc
 *
 * `nvcc` shells out to the host C++ compiler before it does anything else, so on a machine
 * with no MSVC it fails at `Cannot find compiler 'cl.exe' in PATH` for every mode, including
 * `-ptx` and `-E`. NVRTC has no host-compiler step at all. It is a DLL rather than an
 * executable, and this extension has no way to call one - no npm, no native modules - so it
 * is driven through a small Python helper next to this file. That makes Python a *runtime*
 * dependency of this feature only; everything that reads a cache still needs nothing but
 * nvdisasm. `doctor.js` reports which of the two backends is usable.
 *
 * `nvcc` is still preferred when it works: it is the documented front end, it accepts flags
 * users already know, and it handles `#include` of toolkit headers that nvrtc cannot.
 *
 * ## Stages
 *
 * Only compute entry points are supported, and the gate is deliberately before slangc rather
 * than after it:
 *
 *   - `slangc -stage fragment -target cuda` **crashes** (exit 0xC0000005, no diagnostic, no
 *     output). A gate afterwards would report a segfault instead of "graphics stages do not
 *     have a CUDA lowering".
 *   - Raytracing stages compile through slangc and through nvrtc, then die at `ptxas` with
 *     `Call to '_optix_trace_typed_32' requires call prototype`. OptiX device intrinsics are
 *     resolved by the OptiX pipeline linker inside the driver and never by ptxas, so there is
 *     no cubin at the end of that road however far it is followed.
 *
 * A graphics shader's SASS comes from the driver's graphics compiler, which is a different
 * backend from the CUDA one - so even where a lowering exists the answer would not be the
 * code the GPU runs when drawing. Reading it out of a cache, which this extension already
 * does, remains the only honest route for those.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const cubin = require('./cubin');
const spawn = require('./spawn');

/** What this feature can compile, and what it calls each thing. */
const LANGUAGES = {
  '.slang': 'slang',
  '.cu': 'cuda',
  '.cuh': 'cuda',
  '.ptx': 'ptx',
  '.cubin': 'cubin'
};

/**
 * The first-line escape hatch:
 *
 *     // nv-isa-extractor -O3 -use_fast_math -Xptxas -maxrregcount=32
 *     // nv-isa-extractor -I../common -I"C:\Program Files\shaders\inc"
 *
 * Flags belong with the code they change - a shader compiled `-use_fast_math` is a different
 * shader, and keeping that in the file means the listing can be reproduced by anyone who has
 * the file, without also having the settings that produced it. Include directories are the
 * same argument twice over: a shader that `import`s a module cannot be compiled at all
 * without knowing where the module is, and a relative one written here resolves against the
 * file rather than against whatever directory the editor was started in.
 */
const DIRECTIVE_RE = /^\s*(?:\/\/|#)\s*nv-isa-extractor\b[:=]?\s*(.*)$/;

/** How many leading lines are searched for it. */
const DIRECTIVE_LINES = 5;

class CompileError extends Error {
  constructor(message, { tool, argv, log } = {}) {
    super(message);
    this.tool = tool;
    this.argv = argv;
    this.log = log;
  }
}

// --------------------------------------------------------------------------- flags

/**
 * Split a command line the way a shell would, minus the parts a flag list never needs.
 *
 * Quoting matters because a path with a space is ordinary on Windows and
 * `-I"C:\Program Files\..."` has to survive as one argument.
 */
function tokenize(text) {
  const out = [];
  let current = '';
  let quote = null;
  let has = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === quote) quote = null;
      else current += c;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; has = true; continue; }
    if (/\s/.test(c)) {
      if (has || current) { out.push(current); current = ''; has = false; }
      continue;
    }
    current += c;
  }
  if (has || current) out.push(current);
  return out;
}

/**
 * Read the compile flags out of a source file.
 *
 * @returns {{flags: string[], line: number, raw: string} | null}
 */
function readDirective(text) {
  // Split on either line ending. `DIRECTIVE_RE` ends in `(.*)$`, and JavaScript's `.` does
  // not match a carriage return, so a CRLF line leaves a `\r` that `$` can never reach and
  // the whole match fails - silently, and for every flag in the file. Windows is this
  // extension's primary platform and git is configured to check these files out as CRLF, so
  // that failure was one clone away from being the normal case.
  const lines = String(text || '').split(/\r?\n/, DIRECTIVE_LINES);
  for (let i = 0; i < lines.length; i++) {
    const m = DIRECTIVE_RE.exec(lines[i]);
    if (m) return { flags: tokenize(m[1].trim()), line: i, raw: m[1].trim() };
  }
  return null;
}

/**
 * Route flags to the tool each one is for.
 *
 * A bare flag goes to the compiler for the language the file is written in - slangc for
 * `.slang`, nvrtc or nvcc for `.cu`. That is the least surprising reading of a line that
 * says "compile this file with these flags", and it is where the flags people actually reach
 * for live: slangc has its own `-O<level>` and `-fp-mode`, and nvrtc has `-use_fast_math`
 * and `-ffp-contract`.
 *
 * The later stages are reached explicitly, in nvcc's own `-Xptxas` style rather than an
 * invented one, and both spellings nvcc accepts are taken (`-Xptxas -v` and `-Xptxas=-v`):
 *
 *     -Xptxas <flag>    the PTX assembler, for -maxrregcount, -O, --allow-expensive-optimizations
 *     -Xnvrtc <flag>    the CUDA front end, when the file being compiled is Slang
 *
 * `-Xnvrtc` has no meaning for a `.cu` file, where bare flags already go there; it is
 * accepted rather than rejected so that a directive can be moved between files unchanged.
 */
function routeFlags(flags) {
  const out = { primary: [], nvrtc: [], ptxas: [], vk: [] };
  const forward = {
    '-Xptxas': 'ptxas', '-Xnvrtc': 'nvrtc', '-Xslang': 'primary', '-Xvk': 'vk'
  };

  for (let i = 0; i < flags.length; i++) {
    const flag = flags[i];
    const eq = flag.indexOf('=');
    const head = eq > 0 ? flag.slice(0, eq) : flag;

    if (forward[head]) {
      const target = out[forward[head]];
      if (eq > 0) target.push(flag.slice(eq + 1));
      else if (i + 1 < flags.length) target.push(flags[++i]);
      continue;
    }
    out.primary.push(flag);
  }
  return out;
}

/** The flags in force for a file: the setting first, then the file's own, which win. */
function effectiveFlags(directive, configured) {
  return routeFlags([...tokenize(configured || ''), ...(directive ? directive.flags : [])]);
}

// --------------------------------------------------------------------------- pipeline

/**
 * What a graphics shader is compiled *into*, which the shader alone cannot say.
 *
 * A vertex or fragment shader has no SASS of its own. It has SASS **for a pipeline** - and a
 * pipeline carries state the source file never mentions: which descriptor layout binds its
 * resources, and, for a fragment shader, which vertex shader feeds it. Both were measured to
 * matter, and to matter silently:
 *
 *   - Substituting `UNIFORM_BUFFER_DYNAMIC` for `UNIFORM_BUFFER` took one shader from 48
 *     instructions to 40. Adding four bindings it never touches changed the code at the *same*
 *     instruction count. Neither is detectable from the listing.
 *   - A producer whose interface does not match its consumer makes the pipeline undefined -
 *     and the driver compiles it anyway, exits zero, and yields code that looks right.
 *
 * The defaults are the honest general answer: reflect the layout out of the SPIR-V, generate a
 * producer that matches the consumer exactly, and render to one 8-bit target with no depth and
 * no multisampling - a configuration measured across 24 cells not to change the code. What the
 * defaults cannot know is how *your engine* binds the shader, and that is not guessable. So
 * the file can say, on the same line that already carries its compile flags:
 *
 *     // nv-isa-extractor -Xvk bind=0:0:8:1 -Xvk samples=4
 *     // nv-isa-extractor -Xvk producer=fullscreen.slang:vsMain
 *
 * Anything stated here is recorded in the listing's banner, because a listing that does not
 * say which pipeline it describes is claiming more than it knows.
 *
 *     bind=<set>:<binding>:<type>:<count>   a descriptor, in VkDescriptorType numbering;
 *                                           any `bind` at all replaces the reflected layout
 *     push=<bytes>                          a push-constant range the shader declares
 *     producer=<file>[:<entry>]             compile the fragment shader against this vertex
 *                                           shader instead of a generated one
 *     format=<name>  depth=<name>  samples=<n>       the render target it draws into
 */
const VK_CONTROLS = ['bind', 'push', 'producer', 'format', 'depth', 'samples'];

/**
 * Read the `-Xvk` controls into the shape `vk_compile.py` takes as its request.
 *
 * @returns {{state, layout, producer, errors: string[]}} `layout` is null when the file said
 *   nothing, which is the signal to reflect one rather than to use an empty one - those are
 *   very different pipelines and conflating them would silently drop every descriptor.
 */
function pipelineControls(flags, home) {
  const state = {};
  const bindings = [];
  const errors = [];
  let push = null;
  let producer = null;

  for (const flag of flags || []) {
    const eq = flag.indexOf('=');
    const key = eq > 0 ? flag.slice(0, eq) : flag;
    const value = eq > 0 ? flag.slice(eq + 1) : '';
    if (!VK_CONTROLS.includes(key)) {
      errors.push(`-Xvk ${flag}: not a pipeline control (have ${VK_CONTROLS.join(', ')})`);
      continue;
    }
    if (!value) { errors.push(`-Xvk ${key} needs a value, as ${key}=...`); continue; }

    if (key === 'bind') {
      // set:binding:type[:count], the type being VkDescriptorType's own numbering - the same
      // integers a reflector emits, so a value read out of one tool can be pasted into the
      // other without a translation table to keep in step.
      const parts = value.split(':').map(Number);
      if (parts.length < 3 || parts.length > 4 || parts.some(n => !Number.isInteger(n) || n < 0)) {
        errors.push(`-Xvk bind=${value}: expected set:binding:type[:count], all non-negative`);
        continue;
      }
      bindings.push([parts[0], parts[1], parts[2], parts.length === 4 ? parts[3] : 1]);
    } else if (key === 'push') {
      const bytes = Number(value);
      if (!Number.isInteger(bytes) || bytes < 0) errors.push(`-Xvk push=${value}: expected bytes`);
      else push = bytes;
    } else if (key === 'samples') {
      const n = Number(value);
      // Vulkan's sample counts are a bitmask, so only powers of two exist.
      if (!Number.isInteger(n) || n < 1 || (n & (n - 1))) {
        errors.push(`-Xvk samples=${value}: expected a power of two`);
      } else state.samples = n;
    } else if (key === 'producer') {
      const at = value.lastIndexOf(':');
      // A Windows path carries a colon after the drive letter, so only a colon past the
      // filename separates the entry point.
      const split = at > value.replace(/\\/g, '/').lastIndexOf('/') ? at : -1;
      const file = split > 0 ? value.slice(0, split) : value;
      producer = {
        file: path.resolve(home, file),
        entry: split > 0 ? value.slice(split + 1) : null
      };
    } else {
      state[key] = value;
    }
  }

  return {
    state,
    layout: bindings.length || push !== null
      ? { bindings, pushBytes: push || 0 }
      : null,
    producer,
    errors
  };
}

// --------------------------------------------------------------------------- includes

/**
 * An include directory named on a flag list, in every spelling the compilers accept.
 *
 *     -I<dir>   -I <dir>                            slangc, nvrtc and nvcc all take both
 *     --include-path=<dir>   --include-path <dir>   nvrtc's and nvcc's long form
 *
 * All of them are read; only `-I<dir>` is ever written back. slangc refuses `-include-path`
 * outright - Slang 2024.13 documents `-I<path>` and `-I <path>` and nothing else - and the
 * directory is being rewritten to an absolute path regardless, so re-emitting one spelling
 * every tool takes as a single argument is less to get wrong than preserving four.
 *
 * @returns {{dir: string|null} | null}  null when this is not an include flag at all; `dir`
 *   is null when the directory is the *next* argument rather than part of this one.
 */
function includeFlag(flag) {
  const m = /^(?:-I|--?include-path)(?:=(.*))?$/.exec(flag);
  if (m) return { dir: m[1] === undefined ? null : m[1] };
  return /^-I./.test(flag) ? { dir: flag.slice(2) } : null;
}

/**
 * Take the include directories out of a flag list, each resolved against `home`.
 *
 * A relative directory resolves against the source file, not against the process's working
 * directory - which for an extension host is wherever the editor happened to be started and
 * has nothing to do with the shader. `-I../common` then means the same directory for whoever
 * opens the file, which is the only reading under which the directive travels with the code
 * the way the rest of it does.
 */
function splitIncludes(flags, home) {
  const rest = [];
  const dirs = [];
  for (let i = 0; i < flags.length; i++) {
    const found = includeFlag(flags[i]);
    if (!found) { rest.push(flags[i]); continue; }
    // A bare `-I` takes the next argument. A dangling one at the end of the list names
    // nothing, and is dropped rather than passed on to be read as an input file.
    const dir = found.dir === null ? flags[++i] : found.dir;
    if (dir) dirs.push(path.resolve(home, dir));
  }
  return { rest, dirs };
}

/** The same directories in the same order, each named once. */
function uniqueDirs(dirs) {
  const seen = new Set();
  const out = [];
  for (const dir of dirs) {
    // Windows paths differ in case without differing in meaning, which is how the file's own
    // directory and a directive's `-I.` end up looking like two. `correlate.samePath`
    // compares them the same way.
    const key = process.platform === 'win32' ? dir.toLowerCase() : dir;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(dir);
  }
  return out;
}

/**
 * What each tool in the chain is given, with the include path resolved.
 *
 * Two things happen here that a `-I` written by hand cannot do for itself.
 *
 * **The source file's own directory is always searched** - and it is the directory of the
 * file the user has open, not of the file handed to the compiler. Those differ whenever an
 * unsaved buffer is compiled: the text goes to a copy in the scratch directory, and
 * `import helpers;` or `#include "common.h"` then resolves against a directory holding
 * nothing but generated intermediates. slangc finds a sibling module because it knows which
 * file the import was written in; NVRTC finds a sibling header only because the program is
 * *named* by its absolute path. The copy defeats both, and a `-I` pointing at where the file
 * really lives is what restores them.
 *
 * **Directories reach the compiler for the language they were written for**, exactly as
 * every other bare flag does: slangc for a `.slang` file, the CUDA front end for a `.cu` one.
 * `-Xnvrtc -I<dir>` reaches the CUDA stage of a Slang compile, where the generated
 * intermediate is compiled. A Slang shader's own include path is not forwarded there as well:
 * nothing in the generated CUDA includes anything the user wrote, and under the nvcc backend -
 * where Slang's prelude does pull in host headers - it would put a directory the user controls
 * ahead of the toolkit's.
 *
 * @returns {{slang: string[], cuda: string[], ptxas: string[], dirs: string[]}}
 *   `dirs` is every directory that will be searched, for reporting.
 */
function toolFlags(routed, { home, language }) {
  const primary = splitIncludes(routed.primary || [], home);
  const nvrtc = splitIncludes(routed.nvrtc || [], home);

  // For a `.cu` file the two lists end up at the same tool, so their directories do too -
  // and are emitted once rather than once per list.
  const slangDirs = uniqueDirs([home, ...primary.dirs]);
  const cudaDirs = uniqueDirs(
    language === 'slang' ? [home, ...nvrtc.dirs] : [home, ...primary.dirs, ...nvrtc.dirs]);
  const asArgs = dirs => dirs.map(dir => `-I${dir}`);

  return {
    slang: [...primary.rest, ...asArgs(slangDirs)],
    cuda: language === 'slang'
      ? [...nvrtc.rest, ...asArgs(cudaDirs)]
      : [...primary.rest, ...nvrtc.rest, ...asArgs(cudaDirs)],
    ptxas: routed.ptxas || [],
    dirs: uniqueDirs(language === 'slang' ? [...slangDirs, ...cudaDirs] : cudaDirs)
  };
}

// --------------------------------------------------------------------------- stages

/** `[shader("compute")]` - the attribute; the function it decorates is found by scanning. */
const SHADER_ATTR_RE = /\[\s*shader\s*\(\s*"(\w+)"\s*\)\s*\]/g;

const COMPUTE_STAGE = 'compute';

/**
 * The entry points a Slang file declares, read from the source rather than from slangc.
 *
 * This exists because the check it feeds has to happen *before* slangc runs.
 * `slangc -stage fragment -target cuda` does not report that graphics stages have no CUDA
 * lowering - it crashes, exit 0xC0000005, no diagnostic and no output file. Asking it and
 * interpreting the wreckage afterwards would turn "this shader is not a compute shader" into
 * "the compiler crashed", which tells the user nothing about what to do next.
 *
 * A regex over the source is enough for the purpose: it is a gate on stages, not a parser,
 * and a file it reads wrongly ends up compiled by slangc's own discovery, which is where it
 * would have gone anyway.
 */
function slangEntryPoints(text) {
  const out = [];
  SHADER_ATTR_RE.lastIndex = 0;
  let m;
  while ((m = SHADER_ATTR_RE.exec(text))) {
    const name = functionAfter(text, m.index + m[0].length);
    if (name) out.push({ stage: m[1].toLowerCase(), name });
  }
  return out;
}

/**
 * The name of the function declared at `at`, having skipped whatever else decorates it.
 *
 * Written as a scan rather than one regex because the attributes between `[shader(...)]` and
 * the function are themselves calls - `[numthreads(64,1,1)]` - so any pattern that looks for
 * "an identifier followed by (" finds `numthreads` first and names the entry point after an
 * attribute. The function name is the last identifier before the parameter list.
 */
function functionAfter(text, at) {
  let i = at;
  for (;;) {
    while (i < text.length && /\s/.test(text[i])) i++;
    if (text[i] !== '[') break;
    const close = text.indexOf(']', i);
    if (close < 0) return null;
    i = close + 1;
  }
  // `void csMain(`, `float4 psMain(`, `matrix<float,4,4> f(` - take everything up to the
  // parameter list and keep the final identifier.
  const open = text.indexOf('(', i);
  if (open < 0) return null;
  const head = text.slice(i, open);
  if (/[;{}]/.test(head)) return null;                 // not a declaration after all
  const words = head.match(/[A-Za-z_]\w*/g);
  return words && words.length ? words[words.length - 1] : null;
}

/**
 * Decide what to hand slangc, or refuse with a reason.
 *
 * @returns {{entry: string|undefined, note: string|null}}
 */
function chooseSlangEntry(text, wanted) {
  const found = slangEntryPoints(text);
  const compute = found.filter(e => e.stage === COMPUTE_STAGE);

  if (wanted) {
    const match = found.find(e => e.name === wanted);
    if (match && match.stage !== COMPUTE_STAGE) {
      throw new CompileError(
        `${wanted} is a ${match.stage} entry point. ${stageRefusal()}`);
    }
    return { entry: wanted, note: null };
  }

  if (found.length && !compute.length) {
    const stages = [...new Set(found.map(e => e.stage))].sort().join(', ');
    throw new CompileError(
      `this file declares only ${stages} entry point(s). ${stageRefusal()}`);
  }

  // A file mixing compute and graphics entry points would have slangc discover all of them
  // and crash on the graphics ones, so name the compute entry explicitly to keep it away.
  if (compute.length && compute.length < found.length) {
    return {
      entry: compute[0].name,
      note: `compiling only ${compute[0].name}; ${found.length - compute.length} ` +
        'non-compute entry point(s) in this file cannot be compiled this way'
    };
  }
  return { entry: undefined, note: null };
}

function stageRefusal() {
  return 'Only compute entry points can be compiled to SASS this way. A graphics stage has ' +
    'no CUDA lowering, and the SASS a graphics shader really runs comes from the driver\'s ' +
    'graphics compiler - a different backend - so open its cache file instead. Raytracing ' +
    'stages reach ptxas and stop there: OptiX intrinsics are resolved by the driver\'s ' +
    'pipeline linker, never by ptxas.';
}

// --------------------------------------------------------------------------- running

/** The shared runner, with this module's default timeout. A compile is not interactive. */
function run(exe, args, options = {}) {
  return spawn.text(exe, args, { timeout: 120000, ...options });
}

const quote = spawn.quote;

function fail(step, result) {
  const detail = (result.stderr || result.stdout || '').trim();
  throw new CompileError(
    `${step} failed (exit ${result.code})${detail ? `:\n${detail.split('\n').slice(0, 12).join('\n')}` : ''}`,
    { tool: step, argv: result.argv, log: detail });
}

// --------------------------------------------------------------------------- steps

/**
 * Slang to CUDA C++.
 *
 * `-line-directive-mode standard` is what makes the whole correlation chain work: it puts
 * `#line N "shader.slang"` into the generated CUDA, nvrtc turns those into PTX `.loc`
 * records naming the .slang file, ptxas carries them into the cubin, and nvdisasm prints
 * them against the SASS. Without it the deepest a marker can point is the generated
 * intermediate, which is not a file the user wrote.
 */
async function slangToCuda(tools, source, outDir, { flags = [], entry }) {
  const out = path.join(outDir, `${path.basename(source, path.extname(source))}.cu`);
  // No `-entry`/`-stage` unless asked: slangc finds every entry point carrying a
  // `[shader("...")]` attribute by itself, and naming one suppresses the others. Passing
  // `-entry` with no name at all is what makes slangc look for `main` and fail on a file
  // that never claimed to have one.
  const args = [
    source,
    '-target', 'cuda',
    '-line-directive-mode', 'standard',
    ...(entry ? ['-entry', entry, '-stage', 'compute'] : []),
    ...flags,
    '-o', out
  ];
  const result = await run(tools.slangc, args);
  if (result.failed || !fs.existsSync(out)) fail('slangc', result);
  return { file: out, argv: result.argv, log: result.stderr || result.stdout };
}

/**
 * CUDA C++ to PTX through NVRTC, via the Python helper.
 *
 * The request goes in a file rather than on the command line: option lists routinely contain
 * quotes and include paths, and a JSON file has no quoting rules to get wrong between
 * Node, `py`, and Windows.
 */
async function cudaToPtx(tools, source, outDir, { flags = [], arch }) {
  const out = path.join(outDir, `${path.basename(source, path.extname(source))}.ptx`);
  const request = path.join(outDir, 'nvrtc-request.json');

  // `compute_NN` is the virtual architecture PTX is generated for; ptxas then targets the
  // real `sm_NN`. Passing `sm_NN` here asks nvrtc for a cubin instead and loses the PTX.
  const options = [`--gpu-architecture=compute_${arch}`, '--generate-line-info', ...flags];

  await fs.promises.writeFile(request, JSON.stringify({
    source, output: out, options, nvrtc: tools.nvrtc || null
  }), 'utf8');

  const result = await run(tools.python, [tools.nvrtcHelper, request]);
  if (result.failed || !fs.existsSync(out)) fail('nvrtc', result);
  return { file: out, argv: result.argv, log: result.stdout + result.stderr };
}

/** CUDA C++ to PTX through nvcc, for machines that have a host compiler. */
async function cudaToPtxNvcc(tools, source, outDir, { flags = [], arch }) {
  const out = path.join(outDir, `${path.basename(source, path.extname(source))}.ptx`);
  const args = [
    '-ptx', `-arch=compute_${arch}`, '-lineinfo', ...flags, source, '-o', out
  ];
  const result = await run(tools.nvcc, args);
  if (result.failed || !fs.existsSync(out)) fail('nvcc', result);
  return { file: out, argv: result.argv, log: result.stderr || result.stdout };
}

/**
 * PTX to cubin.
 *
 * `-lineinfo` is codegen-neutral - the `.text` bytes are identical with and without it - so
 * the listing is what would have been produced anyway, with the line table added. `-G` is
 * not, which is why it is never passed implicitly; a user who asks for it gets debug codegen
 * and the banner says so.
 *
 * `-v` is always on because its register/shared/local numbers are the compiler's own account
 * of the kernel, and the banner cross-checks them against what the code actually uses.
 */
async function ptxToCubin(tools, source, outDir, { flags = [], arch }) {
  const out = path.join(outDir, `${path.basename(source, path.extname(source))}.cubin`);
  const args = ['-arch', `sm_${arch}`, '-lineinfo', '-v', ...flags, source, '-o', out];
  const result = await run(tools.ptxas, args);
  if (result.failed || !fs.existsSync(out)) fail('ptxas', result);
  return { file: out, argv: result.argv, log: result.stderr || result.stdout };
}

/**
 * What ptxas -v reports, in the shape `output.banner` already prints for a cache object.
 *
 * Having these from the compiler as well as from the code is what lets the banner's existing
 * cross-check work on a compiled kernel exactly as it does on a carved one.
 */
function parsePtxasInfo(log, entry) {
  const info = { registers: null, localBytes: null, sharedBytes: null, spillStores: null, spillLoads: null };
  if (!log) return info;

  // ptxas reports per function; keep only the block for the entry being disassembled.
  const blocks = log.split(/ptxas info\s*:\s*Compiling entry function '/).slice(1);
  const block = entry
    ? blocks.find(b => b.startsWith(`${entry}'`)) || blocks[0]
    : blocks[0];
  const text = block || log;

  const regs = /Used (\d+) registers/.exec(text);
  if (regs) info.registers = Number(regs[1]);
  const smem = /(\d+) bytes smem/.exec(text);
  if (smem) info.sharedBytes = Number(smem[1]);
  const stack = /(\d+) bytes stack frame/.exec(text);
  if (stack) info.localBytes = Number(stack[1]);
  const spills = /(\d+) bytes spill stores, (\d+) bytes spill loads/.exec(text);
  if (spills) { info.spillStores = Number(spills[1]); info.spillLoads = Number(spills[2]); }
  return info;
}

// --------------------------------------------------------------------------- driving

function languageOf(file) {
  return LANGUAGES[path.extname(file).toLowerCase()] || null;
}

/**
 * Compile a source file and return its entry points as disassemblable objects.
 *
 * @param {object} tools    resolved executables: slangc, nvcc, ptxas, python, nvrtcHelper
 * @param {string} file     the source file
 * @param {object} options  {arch: '86', outDir, flags, entry, backend, directive, home}
 *   `home` is the directory the source really lives in, which is *not* `dirname(file)` when
 *   an unsaved buffer is being compiled from a copy. It leads the include path.
 * @returns {{entries, cubinPath, arch, steps, ptxasInfo, sources}}
 */
async function compile(tools, file, options = {}) {
  const language = languageOf(file);
  if (!language) {
    throw new CompileError(
      `${path.basename(file)} is not something this can compile. ` +
      'Supported: .slang, .cu, .ptx and .cubin.');
  }

  const arch = String(options.arch || '86').replace(/^sm_?/i, '').replace(/^SM/i, '');
  const outDir = options.outDir;
  await fs.promises.mkdir(outDir, { recursive: true });

  const routed = options.flags || { primary: [], nvrtc: [], ptxas: [] };
  const home = path.resolve(options.home || path.dirname(path.resolve(file)));
  const flags = toolFlags(routed, { home, language });
  const steps = [];
  const sources = [file];
  const notes = [];
  let current = file;

  // A directory that is not there is searched in silence and reported much later as "cannot
  // open source file", naming the header rather than the mistyped `-I` that lost it.
  for (const dir of flags.dirs) {
    if (!fs.existsSync(dir)) notes.push(`include directory not found: ${dir}`);
  }

  if (language === 'slang') {
    const chosen = chooseSlangEntry(
      await fs.promises.readFile(file, 'utf8'), options.entry);
    if (chosen.note) notes.push(chosen.note);

    const step = await slangToCuda(tools, file, outDir, {
      flags: flags.slang,
      entry: chosen.entry
    });
    steps.push({ tool: 'slangc', command: quote(step.argv), log: step.log });
    current = step.file;
    sources.push(step.file);
  }

  if (language === 'slang' || language === 'cuda') {
    // Slang's generated CUDA is written for nvrtc - its prelude guards the host includes
    // behind `__CUDACC_RTC__` - so the nvrtc backend is the right default for both.
    const useNvcc = options.backend === 'nvcc' ||
      (options.backend !== 'nvrtc' && !tools.python && tools.nvcc);
    const step = useNvcc
      ? await cudaToPtxNvcc(tools, current, outDir, { flags: flags.cuda, arch })
      : await cudaToPtx(tools, current, outDir, { flags: flags.cuda, arch });
    steps.push({ tool: useNvcc ? 'nvcc' : 'nvrtc', command: quote(step.argv), log: step.log });
    current = step.file;
  }

  let ptxasLog = '';
  if (language !== 'cubin') {
    const step = await ptxToCubin(tools, current, outDir, { flags: flags.ptxas, arch });
    steps.push({ tool: 'ptxas', command: quote(step.argv), log: step.log });
    ptxasLog = step.log;
    current = step.file;
  }

  const buf = await fs.promises.readFile(current);
  const entries = cubin.entryPoints(buf);
  if (!entries.length) {
    throw new CompileError(
      `${path.basename(current)} holds no entry points. A kernel must be __global__ ` +
      '(or, in Slang, carry [shader("compute")]) to appear in a cubin.');
  }

  return {
    entries,
    cubinPath: current,
    arch: cubin.arch(buf) || `SM${arch}`,
    steps,
    ptxasLog,
    ptxasInfo: entry => parsePtxasInfo(ptxasLog, entry),
    sources,
    notes
  };
}

// --------------------------------------------------------------------------- provenance

module.exports = {
  LANGUAGES,
  DIRECTIVE_RE,
  COMPUTE_STAGE,
  CompileError,
  tokenize,
  readDirective,
  routeFlags,
  effectiveFlags,
  VK_CONTROLS,
  pipelineControls,
  includeFlag,
  splitIncludes,
  toolFlags,
  slangEntryPoints,
  chooseSlangEntry,
  languageOf,
  parsePtxasInfo,
  quote,
  compile,
  run
};
