'use strict';

/**
 * The editor side of compiling a shader: the command bodies, and the correlation UI.
 *
 * Everything that can be tested without an editor lives in `compile.js`, `cubin.js` and
 * `correlate.js`; this module is settings, progress, and decorations.
 *
 * ## Why the listing stays a plain text document
 *
 * A webview could draw a prettier two-pane view, and would throw away every feature this
 * extension already has: the grammar, the semantic tokens, the opcode hovers, the scoreboard
 * following, `F12`, find-in-file, and the ability to save the thing and mail it. The listing
 * is therefore an ordinary `.nvsass` document, and correlation is added on top of it with
 * decorations - which is also what `highlight.js` concluded, for the same reason, after the
 * DocumentHighlight approach failed.
 *
 * The correlation UI reads the markers back out of the *document text* rather than out of
 * anything the compile kept in memory, so it works on a listing reopened weeks later.
 */

const fs = require('fs');
const path = require('path');
const vscode = require('vscode');

const compile = require('./compile');
const correlate = require('./correlate');
const ctrl = require('./ctrl');
const isa = require('./isa');
const isaEntry = require('./isa_entry');
const output = require('./output');
const rga = require('./rga');
const pipeline = require('./pipeline');
const spawn = require('./spawn');
const stats = require('./stats');

const CONFIG = 'gpuIsaExtractor';

/** Source files with a compile in progress, keyed by scratch-directory tag. */
const inFlight = new Set();

let context = null;
let log = () => {};
let showLog = () => {};

function init(deps) {
  context = deps.context;
  log = deps.log || log;
  showLog = deps.showLog || showLog;
}

function config() {
  return vscode.workspace.getConfiguration(CONFIG);
}

// --------------------------------------------------------------------------- tools

function exists(file) {
  try { return !!file && fs.existsSync(file); } catch (e) { return false; }
}

/** The first of a list of candidate paths that is on disk, or null. */
function firstExisting(candidates) {
  for (const candidate of candidates) if (exists(candidate)) return candidate;
  return null;
}

function cudaRoots() {
  const roots = [];
  for (const key of ['CUDA_PATH', 'CUDA_HOME']) {
    if (process.env[key]) roots.push(process.env[key]);
  }
  return roots;
}

/** slangc ships with the Vulkan SDK, which is where most people already have one. */
function slangRoots() {
  return process.env.VULKAN_SDK ? [process.env.VULKAN_SDK] : [];
}

function exe(name) {
  return process.platform === 'win32' ? `${name}.exe` : name;
}

/**
 * Locate every tool the compile path needs.
 *
 * Each is looked for in the same order the extension already uses for nvdisasm: the explicit
 * setting, then PATH, then the CUDA toolkit. A missing one is reported by name rather than as
 * a generic failure, because the fix differs for each - slangc comes with the Vulkan SDK,
 * ptxas with the CUDA Toolkit, and Python is only needed for the nvrtc backend.
 */
let toolCache = null;

/** Forget the probed tool paths, after a setting that would change them. */
function resetToolCache() {
  toolCache = null;
}

async function resolveTools() {
  // Probing costs up to five process launches, each with a 15 s timeout, and nothing about
  // the answer changes between compiles - `pipeline.resolveArch` caches its probe for the
  // same reason. Invalidated from `extension.js` when a compile.*Path setting changes.
  if (toolCache) return toolCache;
  const settings = config();
  const roots = cudaRoots();
  const inToolkit = name => roots.map(r => path.join(r, 'bin', exe(name)));

  const configured = {
    slangc: (settings.get('compile.slangcPath') || '').trim(),
    ptxas: (settings.get('compile.ptxasPath') || '').trim(),
    python: (settings.get('compile.pythonPath') || '').trim(),
    nvrtc: (settings.get('compile.nvrtcPath') || '').trim()
  };

  // A tool that is not on PATH is an answer, not an exception. `spawn.text` REJECTS when the
  // process cannot be started at all - ENOENT arrives on the child's `error` event, before any
  // `close` - so a bare await here threw straight out of resolveTools and took the whole
  // command with it: a .cubin that needs no tools failed at the nvcc probe, the `py` ->
  // `python` fallback below never reached its second operand, and `doctor.diagnose` aborted on
  // exactly the incomplete machines it exists to describe.
  const onPath = async (bare, args) => {
    try {
      const probe = await compile.run(bare, args, { timeout: 15000 });
      return probe.failed && probe.code === -1 ? null : bare;
    } catch (e) {
      return null;
    }
  };

  const tools = {
    slangc: configured.slangc ||
      firstExisting(slangRoots().map(r => path.join(r, 'Bin', exe('slangc')))) ||
      await onPath(exe('slangc'), ['-v']),
    ptxas: configured.ptxas || firstExisting(inToolkit('ptxas')) ||
      await onPath(exe('ptxas'), ['--version']),
    nvcc: firstExisting(inToolkit('nvcc')) || await onPath(exe('nvcc'), ['--version']),
    python: configured.python ||
      await onPath(process.platform === 'win32' ? 'py' : 'python3', ['--version']) ||
      await onPath('python', ['--version']),
    nvrtc: configured.nvrtc || null,
    // The AMD road's only tool. Located through `rga.js` so the search order and the "not
    // bundled, here is where to get it" message live beside everything else about RGA.
    rga: await rga.resolve((settings.get('compile.rgaPath') || '').trim(), compile.run)
      .then(found => found.path, () => null),
    gfx: (settings.get('compile.gfx') || '').trim() || null,
    nvrtcHelper: path.join(__dirname, 'nvrtc_compile.py'),
    vkHelper: path.join(__dirname, 'vk_compile.py'),
    reflectHelper: path.join(__dirname, 'spirv_reflect.py')
  };
  toolCache = tools;
  return tools;
}

/**
 * What each target could actually do here, for `isa.resolveTarget` to choose between.
 *
 * Passed in rather than probed inside the registry, because probing costs process launches and
 * this has already paid for them. `nvidiaDevice` is the Vulkan probe's answer and is only
 * consulted for a graphics stage - the road that IS the local driver. It is left undefined
 * rather than false when nothing has asked, so "not probed" and "probed, found nothing" stay
 * different answers.
 */
async function targetAvailability(tools) {
  return {
    nvidia: !!tools.ptxas || !!tools.python,
    amd: !!tools.rga,
    // Undefined unless the doctor's Vulkan probe has run. Resolving a graphics stage on a
    // machine with no NVIDIA device is the case this exists for, and guessing it from the
    // absence of a tool would get it wrong in both directions.
    nvidiaDevice: tools.nvidiaDevice
  };
}

/** A tool that is missing, phrased so the message says what to install. */
const WHERE_FROM = {
  slangc: 'slangc compiles Slang. It ships with the Vulkan SDK (Bin/slangc.exe) and with ' +
    'Slang\'s own releases. Set `gpuIsaExtractor.compile.slangcPath` to one.',
  ptxas: 'ptxas assembles PTX into a cubin. It ships with the CUDA Toolkit, next to ' +
    'nvdisasm. Set `gpuIsaExtractor.compile.ptxasPath` to one.',
  rga: 'rga is the Radeon GPU Analyzer, which compiles SPIR-V to RDNA ISA and reads AMD code ' +
    'objects. It is a free download from https://github.com/GPUOpen-Tools/radeon_gpu_analyzer ' +
    'and is not bundled with this extension. It needs no AMD GPU. Set ' +
    '`gpuIsaExtractor.compile.rgaPath` to one.',
  // Two roads need Python for different reasons, and only one of them has an escape hatch.
  // Offering `backend: nvcc` to someone compiling a fragment shader sends them in a circle:
  // the Vulkan harness and the SPIR-V reflector are Python scripts whatever the CUDA backend
  // is set to.
  python: 'Python drives NVRTC, which is the only CUDA front end that needs no host C++ ' +
    'compiler. Install Python 3, or set `gpuIsaExtractor.compile.backend` to `nvcc` if you ' +
    'have MSVC.',
  pythonGraphics: 'Python runs the Vulkan harness and the SPIR-V reflector, which is how a ' +
    'graphics or raytracing shader reaches the driver. Install Python 3, or set ' +
    '`gpuIsaExtractor.compile.pythonPath`. The `compile.backend` setting does not apply here - ' +
    'it chooses between NVRTC and nvcc on the CUDA road, and this shader does not take it.'
};

/**
 * Refuse, naming what to install.
 *
 * `road` picks between two explanations of the same missing interpreter: see WHERE_FROM.
 */
function requireTools(tools, needed, road) {
  const missing = needed.filter(name => !tools[name]);
  if (!missing.length) return;
  const why = name =>
    WHERE_FROM[name === 'python' && road === 'graphics' ? 'pythonGraphics' : name];
  throw new compile.CompileError(
    `${missing.join(' and ')} could not be found.\n` +
    missing.map(why).filter(Boolean).join('\n'));
}

// --------------------------------------------------------------------------- target

/**
 * The file to compile.
 *
 * The active editor is the obvious answer, and the tab is consulted the way
 * `browser.resolveTarget` does so the command still works from a file the editor is showing
 * without a text document behind it.
 */
function resolveTarget(uri) {
  if (uri && uri.fsPath) return uri;

  const editor = vscode.window.activeTextEditor;
  if (editor && compile.languageOf(editor.document.uri.fsPath)) return editor.document.uri;

  const tab = vscode.window.tabGroups.activeTabGroup &&
    vscode.window.tabGroups.activeTabGroup.activeTab;
  const input = tab && tab.input;
  if (input && input.uri && compile.languageOf(input.uri.fsPath)) return input.uri;
  return null;
}

// --------------------------------------------------------------------------- compiling

/**
 * The whole command: compile, disassemble, correlate, open.
 */
// `sourceUri`, not `target`. This function and `run` below used to call the file being
// compiled "the target", which was fine while it was the only thing that word could mean. It
// is not any more: a target is now a row in the ISA registry, and the two collided badly
// enough to be a parse error rather than a shadowed variable. The file keeps the name that
// says what it is.
/**
 * Compile, having asked which ISA to compile for.
 *
 * A separate command rather than a prompt inside the ordinary one: `chooseEntry` already
 * establishes the rule that a modal appears where there is a real ambiguity the user has not
 * resolved, and a dual-toolchain machine would otherwise get a dialog on every single compile.
 * Anyone who wants that has `compile.target: ask`; anyone who wants it once has this.
 */
async function compileForCommand(uri) {
  const picked = await vscode.window.showQuickPick(
    isa.list().map(t => ({
      label: `${t.vendor} ${t.isa}`,
      description: t.id,
      detail: describeTargetAvailability(t),
      id: t.id
    })),
    { title: 'Compile this shader for which ISA?', matchOnDescription: true });
  if (!picked) return;                                  // dismissed: not an error
  return compileCommand(uri, picked.id);
}

/** One line per target in the picker, so an unavailable one says why before it is chosen. */
function describeTargetAvailability(target) {
  const cached = toolCache;
  if (!cached) return '';
  if (target.id === 'amd') {
    return cached.rga
      ? 'rga found; no AMD GPU needed'
      : 'rga not found - install the Radeon GPU Analyzer, or set compile.rgaPath';
  }
  return cached.ptxas || cached.python
    ? 'CUDA toolchain found'
    : 'no CUDA toolchain found - install the CUDA Toolkit';
}

async function compileCommand(uri, requestedTarget) {
  const sourceUri = resolveTarget(uri);
  if (!sourceUri) {
    vscode.window.showErrorMessage(
      'Open a .slang, .cu, .ptx or .cubin file first - this command compiles the file you ' +
      'are looking at.');
    return;
  }

  try {
    await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: `Compiling ${path.basename(sourceUri.fsPath)}`,
      cancellable: true
    }, (progress, token) => run(sourceUri, progress, token, requestedTarget));
  } catch (e) {
    if (e && e.message === 'cancelled') return;
    log(`compile failed: ${e && e.message}`);
    if (e && e.log) log(e.log);
    const choice = await vscode.window.showErrorMessage(
      `${path.basename(sourceUri.fsPath)}: ${(e && e.message) || e}`.split('\n').slice(0, 3).join(' '),
      'Show Output');
    if (choice === 'Show Output') showLog();
  }
}

async function run(sourceUri, progress, token, requestedTarget) {
  const file = sourceUri.fsPath;
  const settings = config();

  // The document as the editor has it, not as it is on disk: compiling what is on screen is
  // what makes this usable while editing. A dirty buffer is written to the scratch directory
  // under its own name so the compiler's diagnostics and the line markers still name a file
  // the user recognises.
  const doc = vscode.workspace.textDocuments.find(d => d.uri.fsPath === file);

  // A container is not read as text. `.cubin` and `.co` hold no entry-point declarations and
  // no `// gpu-isa-extractor` directive - nothing below wants their contents - and slurping one
  // as UTF-8 to find that out costs the whole file. A GLCache `.bin` sniffed as a code object
  // can be hundreds of megabytes.
  const isContainer = ['cubin', 'codeobject'].includes(compile.languageOf(file));
  const text = isContainer
    ? ''
    : (doc ? doc.getText() : await fs.promises.readFile(file, 'utf8'));

  const directive = compile.readDirective(text);
  const configured = settings.get('compile.flags') || '';
  const flags = compile.effectiveFlags(directive, configured);

  progress.report({ message: 'resolving tools' });
  const tools = await resolveTools();
  const language = compile.languageOf(file);
  const backend = settings.get('compile.backend') || 'auto';

  // Which tools are needed depends on the STAGE, and the stage is inside the file rather than
  // in its extension. A fragment `.slang` never touches ptxas or NVRTC, so demanding them
  // would refuse to compile it on a machine that could - naming two tools it does not want.
  // The routing decision therefore has to happen before the tools are required, not after.
  // Which target compiles this. The stage is read first, unrouted, because `auto` decides per
  // ROAD - and the road a stage takes is the thing being decided. The file's own directive
  // outranks the setting, which outranks the automatic answer, for the reason every other
  // compile flag works that way: a shader compiled for a particular ISA is a different
  // artefact, and keeping that in the file means the listing can be reproduced by anyone who
  // has the file.
  const declaredStage = language === 'slang'
    ? (compile.chooseSlangEntry(text, undefined, file, flags, isa.DEFAULT_TARGET) || {}).stage
    : compile.COMPUTE_STAGE;
  const { target, from: targetFrom, alternative } = isa.resolveTarget({
    stage: declaredStage,
    // Precedence: the command that was invoked, then the file's own directive, then the
    // setting. An explicit ask outranks a written default, which outranks a configured one.
    // A code object outranks all three: it is an AMDGPU ELF, which is not a preference to be
    // overridden but a fact about the file that was checked before getting here.
    requested: language === 'codeobject'
      ? 'amd'
      : (requestedTarget || flags.target || settings.get('compile.target') || 'auto'),
    available: await targetAvailability(tools)
  });
  log(`target ${target.vendor} ${target.isa}: ${targetFrom}` +
    (alternative ? ` (${alternative.vendor} also available)` : ''));

  let chosen = language === 'slang'
    ? compile.chooseSlangEntry(text, undefined, file, flags, target.id)
    : language === 'codeobject'
      // No entry point to choose and no stage to route: the container names its own stages,
      // and there may be several. `rga` rather than `target.roadFor(...)` because this road is
      // not reached by asking what road a stage takes - nothing was staged.
      ? { road: 'rga', lineage: 'rga' }
      : { road: target.roadFor(compile.COMPUTE_STAGE), lineage: 'cuda' };

  // A file holding entry points on both roads compiles one of them, and until now the other
  // was unreachable: the banner said to "name one with the entry-point argument" and no
  // command, setting or picker took one. Asking is the missing half of that sentence.
  let entry;
  if (chosen.alternatives && chosen.alternatives.length) {
    const picked = await vscode.window.showQuickPick([
      { label: chosen.entry || `${chosen.stage}`, description: `${chosen.stage} (default)`,
        name: chosen.entry },
      ...chosen.alternatives.map(a => ({ label: a.name, description: a.stage, name: a.name }))
    ], { title: `${path.basename(file)} declares entry points on both roads`,
      placeHolder: 'Which one should be compiled?' });
    if (!picked) return;                              // dismissed: not an error
    if (picked.name !== chosen.entry) {
      entry = picked.name;
      chosen = compile.chooseSlangEntry(text, entry, file, flags, target.id);
    }
  }

  const needed = [];
  if (language === 'slang') needed.push('slangc');
  if (language === 'codeobject') {
    // One tool, and none of the CUDA chain: nothing is compiled, so there is no front end to
    // demand. Listed first because the checks below are all about producing code.
    needed.push('rga');
  } else if (chosen.road === 'graphics') {
    needed.push('python');                       // the Vulkan helper, and the reflector
  } else if (chosen.road === 'rga' || chosen.road === 'dxr') {
    // The raytracing road runs slangc too, but for HLSL rather than SPIR-V, and `language ===
    // 'slang'` above has already asked for it.
    needed.push('rga');
  } else {
    if (language !== 'cubin') needed.push('ptxas');
    if ((language === 'slang' || language === 'cuda') && backend !== 'nvcc') needed.push('python');
  }
  requireTools(tools, needed, chosen.road);

  // The graphics road compiles on THIS machine's driver, so its bytes are this device's
  // architecture by construction and the `arch` setting must not speak for them. That setting
  // is for reading a cache written by a GPU that is not present - a use it still has for
  // every other path. A road that cross-compiles for a named architecture, as ptxas does, must
  // not probe: it would refuse to work on a machine with no GPU, which is the point of it.
  const archInfo = await target.resolveArch({ probed: chosen.road === 'graphics' });
  // One directory per source file. Every intermediate is named after the source's
  // basename, so a single shared directory means a/kernel.cu and b/kernel.cu overwrite
  // each other's .ptx and .cubin - and the banner's recorded command lines then point at
  // bytes belonging to the other file.
  // Tagged by target as well as by file. One source compiled for two targets writes two sets
  // of intermediates under the same basenames, so a shared directory would have each run
  // overwriting the other's - and the banner's recorded command lines would then name bytes
  // belonging to the other target. Separate directories also mean the two can run at once,
  // which is the reasonable thing to want when comparing them.
  const tag = `${target.id}-${sha1(Buffer.from(path.resolve(file).toLowerCase())).slice(0, 8)}`;
  const outDir = path.join(output.scratchDir(context), 'compile', tag);

  // Two compiles of the *same* file for the same target collide inside that directory, and the
  // loser would be disassembled from the winner's bytes. Claimed before anything is written,
  // including the copy of a dirty buffer below. Refused rather than serialised: the second
  // request is nearly always an impatient repeat of the first.
  if (inFlight.has(tag)) {
    throw new Error(
      `${path.basename(file)} is already being compiled for ${target.vendor}. ` +
      'Wait for that run to finish.');
  }
  inFlight.add(tag);
  try {
    let source = file;
    if (doc && doc.isDirty) {
      await fs.promises.mkdir(outDir, { recursive: true });
      source = path.join(outDir, path.basename(file));
      await fs.promises.writeFile(source, text, 'utf8');
    }
    await build({ file, source, tools, flags, archInfo, outDir, backend, directive,
      configured, progress, token, road: chosen.road, entry, target,
      controls: compile.pipelineControls(flags.vk, path.dirname(file)) });
  } finally {
    inFlight.delete(tag);
  }
}

/** The compile itself, once the scratch directory is claimed. */
async function build({ file, source, tools, flags, archInfo, outDir, backend, directive,
  configured, progress, token, road, controls, entry: named, target }) {
  progress.report({ message: road === 'graphics' ? 'asking the driver' : 'compiling' });
  const started = Date.now();
  const built = await compile.compile(tools, source, {
    arch: archInfo.arch,
    outDir,
    flags,
    controls,
    token,
    // Where the file really lives, which is what an `import` or an `#include` beside it has
    // to resolve against. `source` is a copy in the scratch directory when the buffer is
    // dirty, and every sibling of the file is invisible from there.
    home: path.dirname(file),
    backend: backend === 'auto' ? undefined : backend,
    // Correlation costs a whole extra compiler run on the AMD road - amdllpc over the same
    // modules, because RGA will not emit debug info itself. Asking for it when the setting
    // says the map is not wanted is work whose result is thrown away, and the NVIDIA road
    // already skips its own second pass for the same reason.
    // `config()`, not a `settings` local: this is `build`, and the two functions that hold a
    // `settings` binding are `run` and `resolveTools`. Reading it here threw ReferenceError on
    // every compile, and nothing in the gate could see it - the module PARSES, and the suites
    // cannot load `compileview.js` because it imports `vscode`.
    correlate: (config().get('compile.correlationStyle') || 'banner') !== 'off',
    // The target `run()` resolved, not the one `compile()` would default to. Without this,
    // `chooseSlangEntry` inside `compile()` fell back to its own `'nvidia'` default and the
    // file was routed TWICE by two different answers: `run()`'s decided which tools to require
    // and whether to probe the architecture, `compile()`'s decided which road was actually
    // walked. They agree only while there is one target.
    targetId: target.id,
    // Set only when the user picked something other than the default, so a file with one road
    // is compiled exactly as it always was - `entry: undefined` is what lets slangc discover a
    // lone compute kernel by itself.
    entry: named
  });
  if (token.isCancellationRequested) throw new Error('cancelled');
  log(`compiled ${path.basename(file)} in ${Date.now() - started} ms: ` +
    `${built.entries.length} entry point(s), ${built.arch}`);
  for (const step of built.steps) log(`  ${step.command}`);

  const entry = await chooseEntry(built.entries, target);
  if (!entry) throw new Error('cancelled');

  progress.report({ message: `disassembling ${entry.name}` });
  const ctx = {
    built, source: file, compiledFrom: source, directive, configured,
    archInfo, token, outDir, target
  };
  const opened = await openEntry({ ...ctx, entry });

  // The rest of the pipeline, written but not shown. The driver has already compiled every
  // stage and `carveCache` has already carved them; all that is left is a disassembly and a
  // file each, which is why this is done eagerly rather than on demand - it costs one nvdisasm
  // run per sibling and it means `switchStage` opens a file instead of rebuilding a pipeline.
  await writeSiblings(file, built, ctx, entry, opened.file, progress);
  return opened.doc;
}

/**
 * One entry point compiles silently; several are worth asking about.
 *
 * A sibling stage is not one of the several. It is a stage of the pipeline that was built
 * around the shader that WAS asked for, and prompting about it would put a dialog in front of
 * every graphics compile - which is the thing `compileSourceFor`'s own comment says this
 * extension does not do. They are reached through `switchStage` instead.
 */
async function chooseEntry(entries, target) {
  const asked = entries.filter(e => !e.sibling);
  // `asked` is empty only if a road returns nothing but siblings, which no road does. Falling
  // back to the whole list rather than to nothing keeps that a display question rather than a
  // "cancelled" the user never asked for.
  const choices = asked.length ? asked : entries;
  if (choices.length === 1) return choices[0];
  const picked = await vscode.window.showQuickPick(
    choices.map(e => ({
      ...stagePick(e, choices),
      detail: [target.describeEntry(e), e.role].filter(Boolean).join(' - '),
      entry: e
    })),
    { title: 'Which entry point?', matchOnDescription: true });
  return picked && picked.entry;
}

/**
 * The two halves of a quick-pick line, and which of them leads.
 *
 * Which one leads depends on what distinguishes the choices. Several kernels in one cubin are
 * all compute, so the stage label says nothing and the function name says everything; the
 * stages of a pipeline are one entry point each, so the reverse. Leading with `Compute shader`
 * four times over would be a menu that cannot be read.
 *
 * Takes `{stage, name}` rather than an entry, so the pick that happens during a compile and the
 * one that happens hours later off a recorded path are laid out by the same rule - the record
 * keeps paths, not entries, and a second copy of this would be a second answer.
 */
function stagePick(what, among) {
  const stages = new Set((among || []).map(e => e.stage));
  const byStage = what.stage && stages.size > 1;
  const label = compile.stageLabel(what.stage);
  return {
    label: byStage ? label : what.name,
    description: byStage ? what.name : (what.stage ? label : '')
  };
}

// --------------------------------------------------------------------------- stage switching

/**
 * Which listing holds each stage of the pipeline last compiled from a source file.
 *
 * A graphics compile builds a whole pipeline and the driver writes out every stage of it, so
 * one command produces several listings and only one of them is shown. This is how the others
 * are found again - keyed by the source file, and reachable from any of the listings it wrote,
 * because the file the user is looking at when they want the vertex half is usually the
 * fragment listing rather than the shader.
 *
 * Paths only. The microcode is not kept: it is on disk in the listing, and holding a pipeline's
 * worth of buffers per compiled file for the rest of the session is a lot of memory to spend on
 * a menu.
 */
const stageListings = new Map();      // source key -> {source, target, stages: [...]}
const listingSource = new Map();      // listing key -> source key

/** Paths compare case-insensitively on Windows, and both maps are keyed on one. */
const pathKey = file => path.resolve(file).toLowerCase();

/** The record for a source file or for any listing compiled from one. */
function stagesOf(file) {
  if (!file) return null;
  const key = pathKey(file);
  return stageListings.get(key) || stageListings.get(listingSource.get(key)) || null;
}

/**
 * Write a listing for every other stage of the pipeline, and remember where they went.
 *
 * Not shown, and not optional. The alternative was to disassemble a stage when it is asked for,
 * which reads as cheaper and is not: the entries are in hand now, and re-deriving one later
 * means keeping the whole compile alive - or rebuilding the pipeline, which is a second driver
 * round trip that can disagree with the first.
 */
async function writeSiblings(sourceFile, built, ctx, opened, openedFile, progress) {
  const written = [{ entry: opened, file: openedFile }];
  for (const entry of built.entries) {
    if (entry === opened) continue;
    if (ctx.token && ctx.token.isCancellationRequested) break;
    try {
      progress.report({ message: `disassembling ${entry.name}` });
      const out = await openEntry({ ...ctx, entry, show: false });
      written.push({ entry, file: out.file });
    } catch (e) {
      if (e && e.message === 'cancelled') break;
      // A sibling that will not disassemble costs its own line in the menu, not the listing
      // the user actually asked for.
      log(`the ${entry.stage} stage could not be disassembled: ${(e && e.message) || e}`);
    }
  }

  const record = {
    source: sourceFile,
    target: ctx.target.id,
    // What the menu will say, resolved now while the entries are still in hand. The figures
    // especially: `describeEntry` is the target's, and the target is not carried on the record.
    stages: written.map(w => ({
      stage: w.entry.stage || null,
      name: w.entry.name,
      role: w.entry.role || null,
      detail: ctx.target.describeEntry(w.entry),
      file: w.file
    }))
  };
  const key = pathKey(sourceFile);
  stageListings.set(key, record);
  for (const s of record.stages) listingSource.set(pathKey(s.file), key);
  if (record.stages.length > 1) {
    log(`${record.stages.length} stages available: ` +
      record.stages.map(s => `${s.stage || s.name}`).join(', '));
  }
}

/**
 * Show another stage of the pipeline this listing came from.
 *
 * Reached from either end - the shader or one of its listings - because both are places the
 * question gets asked from. A file nobody has compiled yet is compiled rather than refused:
 * "there is nothing to switch between" is true and useless when the fix is the command next
 * to this one.
 */
async function switchStageCommand(uri) {
  const from = (uri && uri.fsPath) || activePath();
  let record = stagesOf(from);
  if (!record) {
    const sourceUri = resolveTarget(uri);
    if (!sourceUri) {
      vscode.window.showErrorMessage(
        'Open a shader or one of its listings first - this switches between the stages of a ' +
        'pipeline that was compiled from one file.');
      return;
    }
    await compileCommand(sourceUri);
    record = stagesOf(sourceUri.fsPath);
    if (!record) return;                     // the compile failed and has already said so
  }

  const name = path.basename(record.source);
  if (record.stages.length === 1) {
    const only = record.stages[0];
    vscode.window.showInformationMessage(
      `${name} compiled one thing: ${compile.stageLabel(only.stage).toLowerCase()} ` +
      `${only.name}. A compute shader is a pipeline by itself, and a graphics shader has as ` +
      'many stages as the pipeline built around it needed.');
    return;
  }

  const picked = await vscode.window.showQuickPick(
    record.stages.map(s => ({
      ...stagePick(s, record.stages),
      detail: [s.detail, s.role].filter(Boolean).join(' - '),
      stage: s
    })),
    { title: `Stages of the pipeline compiled from ${name}`,
      placeHolder: 'Which stage should be shown?', matchOnDescription: true });
  if (!picked) return;                       // dismissed: not an error

  // The listing may be gone - `clearOutput` deletes them, and so does the retention sweep.
  // Compiling again is what the user would do next anyway, and it is the only way to get the
  // bytes back: they came out of a scratch directory that no longer describes anything.
  if (!fs.existsSync(picked.stage.file)) {
    log(`${picked.stage.file} is gone; compiling ${name} again`);
    await compileCommand(vscode.Uri.file(record.source));
    const fresh = stagesOf(record.source);
    const again = fresh && fresh.stages.find(s => s.stage === picked.stage.stage);
    if (!again) return;
    picked.stage = again;
  }
  await output.showListing(picked.stage.file, {
    preview: false,
    viewColumn: vscode.ViewColumn.Active
  });
}

/** The file the editor is showing, whether or not it has a text document behind it. */
function activePath() {
  const editor = vscode.window.activeTextEditor;
  if (editor) return editor.document.uri.fsPath;
  const tab = vscode.window.tabGroups.activeTabGroup &&
    vscode.window.tabGroups.activeTabGroup.activeTab;
  const input = tab && tab.input;
  return (input && input.uri && input.uri.fsPath) || null;
}

/**
 * Disassemble one entry point and open its listing.
 *
 * The disassembly itself is deliberately the same two calls the cache path makes -
 * `nvdisasm --binary` over raw microcode, then `ctrl.annotate` over the result - because the
 * `.text` section of a cubin is the same kind of thing a carve produces. Anything that only
 * worked here would drift out of step with the path that is used far more often.
 */
/**
 * Every instruction address a listing actually contains.
 *
 * `correlate.addressIn` knows both dialects' spellings, so this works on either - but it is
 * only needed where a line table describes more code than the listing does, which is the AMD
 * road: one code object holds every stage of a pipeline and RGA writes one file per stage.
 */
function addressesIn(text) {
  const out = [];
  for (const line of text.split('\n')) {
    const address = correlate.addressIn(line);
    if (address !== null) out.push(address);
  }
  return out;
}

async function openEntry({ built, entry, source, compiledFrom, directive, configured,
  archInfo, token, outDir, target, show = true }) {
  const graphics = built.road === 'graphics';
  // Two roads can correlate, for different reasons, and neither is "not graphics".
  //
  //   - CUDA reads a line table out of the cubin with a second nvdisasm pass.
  //   - The AMD road cannot be asked twice: RGA's listing has no line table in it, so the
  //     table was obtained during the compile and travels on the result. See `rdnaCorrelation`
  //     in compile.js for why it needs a second compiler run and what it checks before
  //     trusting the answer.
  //
  // The graphics road has neither, and that is measured rather than assumed: across 3,340
  // cache objects the container carries no debug section, and SPIR-V built with `slangc -g`
  // produced a byte-identical object of exactly the same size. The driver strips it.
  const correlatable = built.road === 'cuda' || !!built.correlation;

  // The entry decides how it becomes text. Everything below this line works on the text and on
  // what the entry says about itself, and none of it names a disassembler - which is the whole
  // of what this restructuring buys.
  const compiled = isaEntry.normalize(entry, {
    target,
    origin: graphics ? 'driver' : 'compiled'
  });
  const emission = await compiled.emit({
    outDir,
    arch: built.arch,
    token,
    decodeColumn: config().get('decodeControlCodes') !== false,
    // Echoed back by a target whose compile already produced the listing.
    tool: built.tool,
    toolVersion: built.toolVersion || '',
    command: (built.steps.find(s => s.tool === 'rga') || {}).command || '',
    keepIntermediates: !!config().get('keepRawMicrocode')
  });
  const plain = emission.text;
  const annotation = emission.annotation;

  // Skipped outright when the road has no line table, rather than allowed to fail into the
  // catch below - which would log "source correlation unavailable" on every graphics compile
  // and read as a fault rather than as a property of the route.
  let correlation = null;
  let body = plain;
  const style = config().get('compile.correlationStyle') || 'banner';
  if (style !== 'off' && correlatable) {
    try {
      // Where the records come from is the road's business; what happens to them is not.
      // An unsaved buffer was compiled from a copy, so both sources go through
      // `rewriteSource`: the line table names the copy, and everything downstream must name
      // the file the user actually has open.
      const parsed = built.correlation
        ? correlate.rewriteSource(
          // Narrowed to THIS listing first. The line table covers the whole pipeline - every
          // hardware stage shares one `.text` - while the listing holds one stage, so the
          // unfiltered set puts runs in the banner at addresses the reader cannot find.
          { entries: new Map([[entry.name, require('./dwarf_line').forListing(
            built.correlation.records, addressesIn(plain))]]),
            files: built.correlation.files },
          compiledFrom, source)
        : correlate.rewriteSource(
          correlate.parse(await runTool(emission.tool, ['-c', '-g', built.cubinPath], token),
            entry.name),
          compiledFrom, source);
      const records = parsed.entries.get(entry.name);
      if (records && records.length) {
        const labels = correlate.labelsFor(parsed.files);
        // Keyed line-first so the separator can be a space: a path may contain spaces, a
        // line number may not, so the first token is always unambiguous. (This used to key
        // on a NUL, written as a literal byte rather than an escape, which made the whole
        // file binary to git and grep.)
        // Holes excluded: a run attributed to nothing is not a source line, and counting one
        // would report "correlated 47 runs over 13 source lines" where one of the thirteen is
        // the absence of a line.
        const positioned = records.filter(r => r.line !== null && r.file);
        const distinct = new Set(positioned.map(r => `${r.line} ${r.file}`)).size;
        // Runs are contiguous from the first record onward, so the only instructions with no
        // source position are those before it. Counting them does not need the per-address
        // Map expanded - which for a large kernel is one entry per instruction, built here
        // only to be thrown away in `banner` style.
        // The stride, from the target rather than from this module's own ctrl import - and
        // NULLABLE, because a fixed bytes-per-instruction is a property of the encoding rather
        // than of disassembly in general. `correlate.byAddress` walks a run by stepping, which
        // lands between instructions on a variable-length ISA and attributes a run to
        // addresses that do not exist, so a target without one does not get an expanded map at
        // all. Both figures below take it from the same place: reading the stride two ways in
        // one block is how they come to disagree.
        const stride = isa.strideFor(target);
        const unattributed = stride ? records[0].address / stride : null;

        // `banner` keeps the instruction stream clean and puts the map in the header;
        // `inline` is the older form, which travels better into a plain-text paste.
        // The per-address expansion is built only for the form that needs it.
        if (style === 'inline' && stride) {
          body = correlate.annotate(
            plain,
            correlate.byAddress(records, compiled.evidence.codeBytes, stride),
            { labels }).text;
        } else if (style === 'inline') {
          // Said rather than silently falling back, because the setting was set deliberately
          // and the reason it cannot be honoured is a property of the ISA. It DOES fall back
          // though - `map` below is built for this case too. Leaving it null wrote a banner
          // that announced a source map and then contained none, while the inline body
          // annotation had also been skipped: the setting turned correlation off entirely
          // rather than changing its shape.
          log(`inline correlation needs a fixed instruction width, which ${target.vendor} ` +
            `${target.isa} does not have; the map is in the banner instead`);
        }
        correlation = {
          // Runs that carry a position. The map below still holds the holes, because the
          // reader needs them to know where attribution stops - but "marked" is a count of
          // what was correlated, and a hole is the opposite of that.
          marked: positioned.length,
          lines: distinct,
          unattributed,
          files: parsed.files.map(f => [f, labels.get(f)]),
          // Written whenever the body was NOT annotated, which is the banner style and any
          // target the inline style cannot serve.
          map: (style === 'banner' || !stride) ? correlate.bannerLines(records, labels) : null
        };
        log(`correlated ${positioned.length} run(s) over ${distinct} source line(s)` +
          (records.length > positioned.length
            ? `, ${records.length - positioned.length} run(s) with no source position`
            : '') +
          (unattributed ? `, ${unattributed} instruction(s) unattributed` : '') +
          ` (${style})`);
      } else {
        log(built.correlation
          ? 'the line table holds no source positions for this entry point'
          : 'nvdisasm -g returned no source positions for this entry point');
      }
    } catch (e) {
      // A listing without correlation is still a listing. Losing the SASS because the line
      // table could not be read would be the wrong trade.
      log(`source correlation unavailable: ${e.message}`);
    }
  }

  const info = built.ptxasInfo(entry.name);
  // The CUDA road has to state these, because a cubin records almost none of them and
  // `stage: 'compute'` is true there by construction. The graphics road does not have to state
  // anything: its bytes came out of a real cache container, so the driver's own account of the
  // shader travels with them - the stage as a code rather than an assumption, and
  // `killsPixels`, which is meaningful for a fragment shader and meaningless for a kernel.
  // Hardcoding `compute` here would have quietly labelled every pixel shader wrong.
  compiled.metadata = graphics ? entry.metadata : {
    stage: 'compute',
    stageCode: null,
    // ptxas's own account of the kernel, which the banner then cross-checks against what the
    // code is measured to use - the same two-source comparison the cache path makes.
    registers: info.registers !== null ? info.registers : entry.registers,
    registerCap: null,
    localBytes: info.localBytes,
    sharedBytes: info.sharedBytes,
    killsPixels: null
  };

  // Flattened back to the shape `output.banner` and `stats` still read. That flattening is the
  // seam that disappears when they move onto the entry themselves; until then it lives in one
  // function rather than being open-coded here.
  const object = isaEntry.asObject(compiled, { source });

  const result = {
    text: plain,                       // banner and statistics read this: no markers in it
    correlated: body,                  // what gets written as the listing body
    object,
    target,
    arch: built.arch,
    archFrom: archInfo.from,
    // What produced the text, as the emission reported it. The field names still say
    // `nvdisasm` because that is what `output.banner`'s NVIDIA row reads; they become the
    // target's business when a second row needs different ones.
    nvdisasm: emission.tool,
    nvdisasmVersion: emission.toolVersion,
    command: emission.command,
    annotation,
    correlation,
    compile: {
      steps: built.steps,
      sources: built.sources,
      notes: built.notes,
      directive: directive ? directive.raw : null,
      configuredFlags: configured || null,
      device: built.device || null,
      // The entry's own account of the pipeline, which is not the same sentence for every
      // object the pipeline deposited: they are different stages of it, and one of them is the
      // one that was asked for. `built.pipeline` is the fallback for a road whose entries do
      // not describe themselves - the CUDA road, which has no pipeline to describe.
      pipeline: entry.pipeline || built.pipeline || null
    }
  };

  const file = await writeCompiledListing(result);
  if (!show) return { file, doc: null };
  const doc = await output.showListing(file, {
    preview: false,
    viewColumn: vscode.ViewColumn.Beside
  });
  refresh(vscode.window.activeTextEditor);
  return { file, doc };
}

function sha1(buf) {
  return require('crypto').createHash('sha1').update(buf).digest('hex');
}

/**
 * Write a compiled listing.
 *
 * Not `output.writeListing`, and not named the way a cache listing is. That name is the
 * microcode's sha1, on the stated grounds that identical bytes make an identical listing -
 * true for a carve, false here. Two source files that differ only in a comment compile to
 * byte-identical `.text` and to *different* line markers, and the browser's "already
 * disassembled" shortcut would then serve the older file's line numbers against the newer
 * file's code. The source path goes into the name, and the file is always rewritten.
 */
async function writeCompiledListing(result) {
  const dir = output.listingDir(context);
  await fs.promises.mkdir(dir, { recursive: true });

  // The extension and the arch fallback both come from the dialect this target writes. They
  // are what decide whether the listing opens as the right language and what it is called when
  // the architecture is unusable as a filename component - `sm` is not a sensible stand-in for
  // a target whose architectures are named `gfx1201`.
  const dialect = isa.DIALECTS[(result.target || isa.get(isa.DEFAULT_TARGET)).dialectId];
  const tag = sha1(Buffer.from(path.resolve(result.object.source).toLowerCase())).slice(0, 6);
  const name = `${output.sanitize(result.object.name)}.${tag}.` +
    `${output.sanitize(result.arch, dialect.archFallback)}${dialect.listingExt}`;
  const file = path.join(dir, name);
  await fs.promises.writeFile(
    file, output.banner(result, null) + result.correlated, 'utf8');
  return file;
}

async function runTool(exePath, args, token) {
  const result = await spawn.text(exePath, args, { token });
  if (result.cancelled) throw new Error('cancelled');
  if (result.code !== 0) {
    throw new Error(
      `${path.basename(exePath)} exited ${result.code}:\n` +
      result.stderr.trim().split('\n').slice(0, 4).join('\n'));
  }
  return result.stdout;
}

// --------------------------------------------------------------------------- correlation UI

// `editor.rangeHighlightBackground` rather than `editor.selectionHighlightBackground`: the
// latter is the faint tint VS Code puts behind other occurrences of the selected word, it is
// deliberately almost invisible, and neither bundled theme defines it - so the highlight was
// being drawn in a colour that could not be seen. `rangeHighlightBackground` is the one every
// theme defines for "the editor is pointing at this", which is exactly what this is.
//
// The overview-ruler mark is not decoration: a source line's instructions are scattered
// through a listing that is usually taller than the window, so without a mark in the scrollbar
// the highlight for everything off-screen is invisible and the answer looks smaller than it is.
const HIGHLIGHT = {
  isWholeLine: true,
  backgroundColor: new vscode.ThemeColor('editor.rangeHighlightBackground'),
  overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.rangeHighlightForeground'),
  overviewRulerLane: vscode.OverviewRulerLane.Full
};

const listingDecoration = vscode.window.createTextEditorDecorationType(HIGHLIGHT);
const sourceDecoration = vscode.window.createTextEditorDecorationType(HIGHLIGHT);

/** `//               s.slang = C:\path\s.slang` in the banner. */
const SOURCE_MAP_RE = /^\/\/\s+(\S+)\s+=\s+(.+?)\s*$/;

const cache = new Map();                  // document uri -> {version, markers, files}

/**
 * The marker table for a listing, parsed from its own text and cached per version.
 *
 * Reading it back out of the document rather than remembering it from the compile is what
 * makes this work on a listing that was generated last month, or by someone else.
 */
function markersFor(doc) {
  const key = doc.uri.toString();
  const hit = cache.get(key);
  if (hit && hit.version === doc.version) return hit;

  const text = doc.getText();
  const parsed = correlate.readMarkers(text);
  const files = new Map();
  // The source map lives in the banner, above the first instruction.
  for (const line of text.split('\n', 400)) {
    if (!line.startsWith('//')) break;
    const m = SOURCE_MAP_RE.exec(line);
    if (m && !files.has(m[1])) files.set(m[1], m[2]);
  }
  const entry = { version: doc.version, ...parsed, files };
  cache.set(key, entry);
  return entry;
}

/**
 * Is this document one of our listings, in any dialect?
 *
 * A language-id lookup rather than a comparison against one constant. The correlation UI reads
 * markers back out of the document text, so what matters is that the document is a listing at
 * all - not which ISA it holds.
 */
function isListing(doc) {
  return isa.dialectFor(doc) !== null;
}

/**
 * Light up the other side of the correlation.
 *
 * Driven off the selection rather than off a hover or a word, for the reason `highlight.js`
 * records: a marker is not a word and the cursor is the only thing that reliably says which
 * instruction is being looked at.
 */
function refresh(editor) {
  if (!editor || config().get('compile.correlate') === false) return;

  if (isListing(editor.document)) return fromListing(editor);
  return fromSource(editor);
}

/**
 * Every line the cursor or the selection covers.
 *
 * `selections`, not `selection`: a multi-cursor is a perfectly ordinary way to ask about two
 * unrelated places at once, and reading only the primary would silently answer about one of
 * them. An empty selection is its cursor's line, which is what makes a plain click behave the
 * way it did before selections were considered at all.
 */
function selectedLines(editor) {
  const lines = new Set();
  for (const selection of editor.selections) {
    for (let line = selection.start.line; line <= selection.end.line; line++) lines.add(line);
  }
  return lines;
}

function fromListing(editor) {
  const { byListingLine, files } = markersFor(editor.document);
  // Both are cleared whichever way the correlation is being driven. Only one side is an
  // answer at a time, and leaving the other lit means the pane the user is not looking at
  // keeps showing where the cursor used to be - which reads as a second, contradictory
  // answer rather than as a stale one.
  clear(sourceDecoration);
  clear(listingDecoration);
  if (!byListingLine.size) return;

  // A selection over a run of instructions asks "where did all of this come from", and the
  // answer is routinely several lines in several files - the scheduler interleaves, and
  // inlined code carries its own file. So this collects a set per file rather than a range.
  const perFile = correlate.sourcesFor(byListingLine, selectedLines(editor));
  if (!perFile.size) return;

  for (const other of vscode.window.visibleTextEditors) {
    if (other === editor) continue;
    let matched = null;
    for (const [label, lines] of perFile) {
      const file = files.get(label);
      if (file && correlate.samePath(other.document.uri.fsPath, file)) { matched = lines; break; }
    }
    if (!matched) continue;

    const last = other.document.lineCount - 1;
    const ranges = correlate.runs(matched.map(line => Math.min(Math.max(line - 1, 0), last)))
      .map(([from, to]) => new vscode.Range(from, 0, to, 0));
    other.setDecorations(sourceDecoration, ranges);
    if (ranges.length) {
      other.revealRange(ranges[0], vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    }
  }
}

function fromSource(editor) {
  const sourcePath = editor.document.uri.fsPath;
  if (!compile.languageOf(sourcePath)) return;
  clear(sourceDecoration);

  // Editor lines are 0-based and markers are 1-based, which is the one place these two
  // coordinate systems meet.
  const lines = [...selectedLines(editor)].map(line => line + 1);

  for (const other of vscode.window.visibleTextEditors) {
    if (!isListing(other.document)) continue;
    const { bySourceLine, files } = markersFor(other.document);

    let label = null;
    for (const [name, file] of files) {
      if (correlate.samePath(file, sourcePath)) { label = name; break; }
    }
    // Cleared rather than left alone when this listing has nothing for the selection: a
    // highlight that stops tracking reads as an answer, and the answer would be whichever
    // lines were selected last.
    const rows = correlate.rowsFor(bySourceLine, label, lines);
    const ranges = correlate.runs(rows).map(([from, to]) => new vscode.Range(from, 0, to, 0));
    other.setDecorations(listingDecoration, ranges);
    if (ranges.length) {
      other.revealRange(ranges[0], vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    }
    // Silence here used to be indistinguishable from the feature being broken, which is
    // exactly what happened: nothing lit up and there was no way to tell whether the listing
    // had no map, the map named a different path, or the decoration was invisible.
    if (!label) {
      trace(() => `no correlation: ${path.basename(other.document.uri.fsPath)} names ` +
        `[${[...files.keys()].join(', ')}], not ${path.basename(sourcePath)}`);
    } else if (!rows.length) {
      trace(() => `no instructions attributed to ${label}:${[...lines].join(',')}`);
    }
  }
}

/**
 * Diagnostics for the correlation, off unless asked for.
 *
 * Lazily formatted: this runs on every cursor move, and building a message that is then
 * thrown away is precisely the kind of per-keystroke work the listing size makes expensive.
 */
function trace(message) {
  if (config().get('compile.traceCorrelation') === true) log(message());
}

function clear(decoration) {
  for (const editor of vscode.window.visibleTextEditors) editor.setDecorations(decoration, []);
}

/**
 * Jump from an instruction to the line that produced it.
 *
 * Bound rather than left to a DocumentLink on the marker: the useful gesture is "where did
 * *this instruction* come from", and the instruction lines outnumber the markers.
 */
async function revealSource() {
  const editor = vscode.window.activeTextEditor;
  if (!editor || !isListing(editor.document)) {
    vscode.window.showInformationMessage(
      'This works inside a generated listing that carries source markers.');
    return;
  }
  const { byListingLine, files } = markersFor(editor.document);
  const at = byListingLine.get(editor.selection.active.line);
  if (!at) {
    vscode.window.showInformationMessage(
      byListingLine.size
        ? 'This instruction carries no source position.'
        : 'This listing has no source correlation - it was not produced by compiling a file.');
    return;
  }
  const file = files.get(at.label);
  if (!file) {
    vscode.window.showWarningMessage(
      `The banner does not say which file "${at.label}" is.`);
    return;
  }
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
  const shown = await vscode.window.showTextDocument(doc, {
    preview: false, viewColumn: vscode.ViewColumn.Beside
  });
  const line = Math.min(Math.max(at.line - 1, 0), doc.lineCount - 1);
  shown.selection = new vscode.Selection(line, 0, line, 0);
  shown.revealRange(new vscode.Range(line, 0, line, 0),
    vscode.TextEditorRevealType.InCenter);
}

/**
 * Ctrl+click a source line to land on the first instruction it produced.
 *
 * A DefinitionProvider rather than a command, because ctrl+click is the gesture people
 * already use for "take me to the thing this line means", and it costs no keybinding.
 *
 * It answers only for lines a listing actually attributes instructions to, so on a
 * declaration or a comment it stays out of the way and whatever language server owns the file
 * answers alone. Where both answer, VS Code shows both, which is the honest result: the
 * definition of the symbol and the code it compiled to are two different true answers.
 */
class SourceToSassDefinitionProvider {
  provideDefinition(document, position) {
    if (config().get('compile.clickToSass') === false) return null;
    if (!compile.languageOf(document.uri.fsPath)) return null;

    const line = position.line + 1;
    const out = [];
    for (const editor of vscode.window.visibleTextEditors) {
      if (!isListing(editor.document)) continue;
      const { bySourceLine, files } = markersFor(editor.document);

      let label = null;
      for (const [name, file] of files) {
        if (correlate.samePath(file, document.uri.fsPath)) { label = name; break; }
      }
      const rows = correlate.rowsFor(bySourceLine, label, [line]);
      if (!rows.length) continue;
      // The first instruction of the run. Every other row is highlighted by the selection
      // wiring, so jumping to the first is a starting point, not a claim that it is the only
      // one - under an optimising compiler a line's instructions are scattered.
      out.push(new vscode.Location(
        editor.document.uri, new vscode.Position(rows[0], 0)));
    }
    return out.length ? out : null;
  }
}

/** Registered from `extension.js` so the selection wiring is disposed with everything else. */
function watch() {
  // Registered for the source languages, not for `nvidia-sass`: this is the source -> SASS
  // direction. The other direction already has `revealSource` on a keybinding.
  const selector = Object.keys(compile.LANGUAGES)
    .map(ext => ({ scheme: 'file', pattern: `**/*${ext}` }));

  return [
    vscode.languages.registerDefinitionProvider(
      selector, new SourceToSassDefinitionProvider()),
    vscode.window.onDidChangeTextEditorSelection(e => refresh(e.textEditor)),
    vscode.window.onDidChangeActiveTextEditor(editor => refresh(editor)),
    vscode.workspace.onDidCloseTextDocument(doc => cache.delete(doc.uri.toString())),
    listingDecoration,
    sourceDecoration
  ];
}

module.exports = {
  init,
  resetToolCache,
  resolveTools,
  resolveTarget,
  compileCommand,
  compileForCommand,
  switchStageCommand,
  // Exported for `test_endtoend.js` alone. It assembles the options `compile.compile` is
  // driven with, it is unreachable from every other export without a real toolchain, and a
  // scope error in it took down every compile while the gate stayed green - twice now, this
  // module has shipped a runtime error the suites structurally could not see.
  build,
  revealSource,
  markersFor,
  refresh,
  watch
};
