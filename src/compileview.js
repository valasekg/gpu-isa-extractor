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
const output = require('./output');
const pipeline = require('./pipeline');
const spawn = require('./spawn');
const stats = require('./stats');

const CONFIG = 'nvIsaExtractor';

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
    nvrtcHelper: path.join(__dirname, 'nvrtc_compile.py'),
    vkHelper: path.join(__dirname, 'vk_compile.py'),
    reflectHelper: path.join(__dirname, 'spirv_reflect.py')
  };
  toolCache = tools;
  return tools;
}

/** A tool that is missing, phrased so the message says what to install. */
const WHERE_FROM = {
  slangc: 'slangc compiles Slang. It ships with the Vulkan SDK (Bin/slangc.exe) and with ' +
    'Slang\'s own releases. Set `nvIsaExtractor.compile.slangcPath` to one.',
  ptxas: 'ptxas assembles PTX into a cubin. It ships with the CUDA Toolkit, next to ' +
    'nvdisasm. Set `nvIsaExtractor.compile.ptxasPath` to one.',
  // Two roads need Python for different reasons, and only one of them has an escape hatch.
  // Offering `backend: nvcc` to someone compiling a fragment shader sends them in a circle:
  // the Vulkan harness and the SPIR-V reflector are Python scripts whatever the CUDA backend
  // is set to.
  python: 'Python drives NVRTC, which is the only CUDA front end that needs no host C++ ' +
    'compiler. Install Python 3, or set `nvIsaExtractor.compile.backend` to `nvcc` if you ' +
    'have MSVC.',
  pythonGraphics: 'Python runs the Vulkan harness and the SPIR-V reflector, which is how a ' +
    'graphics or raytracing shader reaches the driver. Install Python 3, or set ' +
    '`nvIsaExtractor.compile.pythonPath`. The `compile.backend` setting does not apply here - ' +
    'it chooses between NVRTC and nvcc on the CUDA road, and this shader does not take it.'
};

/**
 * Refuse, naming what to install.
 *
 * `lineage` picks between two explanations of the same missing interpreter: see WHERE_FROM.
 */
function requireTools(tools, needed, lineage) {
  const missing = needed.filter(name => !tools[name]);
  if (!missing.length) return;
  const why = name =>
    WHERE_FROM[name === 'python' && lineage === 'graphics' ? 'pythonGraphics' : name];
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
async function compileCommand(uri) {
  const target = resolveTarget(uri);
  if (!target) {
    vscode.window.showErrorMessage(
      'Open a .slang, .cu, .ptx or .cubin file first - this command compiles the file you ' +
      'are looking at.');
    return;
  }

  try {
    await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: `Compiling ${path.basename(target.fsPath)}`,
      cancellable: true
    }, (progress, token) => run(target, progress, token));
  } catch (e) {
    if (e && e.message === 'cancelled') return;
    log(`compile failed: ${e && e.message}`);
    if (e && e.log) log(e.log);
    const choice = await vscode.window.showErrorMessage(
      `${path.basename(target.fsPath)}: ${(e && e.message) || e}`.split('\n').slice(0, 3).join(' '),
      'Show Output');
    if (choice === 'Show Output') showLog();
  }
}

async function run(target, progress, token) {
  const file = target.fsPath;
  const settings = config();

  // The document as the editor has it, not as it is on disk: compiling what is on screen is
  // what makes this usable while editing. A dirty buffer is written to the scratch directory
  // under its own name so the compiler's diagnostics and the line markers still name a file
  // the user recognises.
  const doc = vscode.workspace.textDocuments.find(d => d.uri.fsPath === file);
  const text = doc ? doc.getText() : await fs.promises.readFile(file, 'utf8');

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
  let chosen = language === 'slang'
    ? compile.chooseSlangEntry(text, undefined)
    : { lineage: 'cuda' };

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
      chosen = compile.chooseSlangEntry(text, entry);
    }
  }

  const needed = [];
  if (language === 'slang') needed.push('slangc');
  if (chosen.lineage === 'graphics') {
    needed.push('python');                       // the Vulkan helper, and the reflector
  } else {
    if (language !== 'cubin') needed.push('ptxas');
    if ((language === 'slang' || language === 'cuda') && backend !== 'nvcc') needed.push('python');
  }
  requireTools(tools, needed, chosen.lineage);

  // The graphics lineage compiles on THIS machine's driver, so its bytes are this device's
  // architecture by construction and the `arch` setting must not speak for them. That setting
  // is for reading a cache written by a GPU that is not present - a use it still has for
  // every other path.
  const archInfo = await pipeline.resolveArch({ probed: chosen.lineage === 'graphics' });
  // One directory per source file. Every intermediate is named after the source's
  // basename, so a single shared directory means a/kernel.cu and b/kernel.cu overwrite
  // each other's .ptx and .cubin - and the banner's recorded command lines then point at
  // bytes belonging to the other file.
  const tag = sha1(Buffer.from(path.resolve(file).toLowerCase())).slice(0, 8);
  const outDir = path.join(output.scratchDir(context), 'compile', tag);

  // Two compiles of the *same* file collide inside that directory, and the loser would be
  // disassembled from the winner's bytes. Claimed before anything is written, including the
  // copy of a dirty buffer below. Refused rather than serialised: the second request is
  // nearly always an impatient repeat of the first.
  if (inFlight.has(tag)) {
    throw new Error(
      `${path.basename(file)} is already being compiled. Wait for that run to finish.`);
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
      configured, progress, token, lineage: chosen.lineage, entry,
      controls: compile.pipelineControls(flags.vk, path.dirname(file)) });
  } finally {
    inFlight.delete(tag);
  }
}

/** The compile itself, once the scratch directory is claimed. */
async function build({ file, source, tools, flags, archInfo, outDir, backend, directive,
  configured, progress, token, lineage, controls, entry: named }) {
  progress.report({ message: lineage === 'graphics' ? 'asking the driver' : 'compiling' });
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
    // Set only when the user picked something other than the default, so a file with one road
    // is compiled exactly as it always was - `entry: undefined` is what lets slangc discover a
    // lone compute kernel by itself.
    entry: named
  });
  if (token.isCancellationRequested) throw new Error('cancelled');
  log(`compiled ${path.basename(file)} in ${Date.now() - started} ms: ` +
    `${built.entries.length} entry point(s), ${built.arch}`);
  for (const step of built.steps) log(`  ${step.command}`);

  const entry = await chooseEntry(built.entries);
  if (!entry) throw new Error('cancelled');

  progress.report({ message: `disassembling ${entry.name}` });
  await openEntry({
    built, entry, source: file, compiledFrom: source, directive, configured,
    archInfo, token, outDir
  });
}

/** One entry point compiles silently; several are worth asking about. */
async function chooseEntry(entries) {
  if (entries.length === 1) return entries[0];
  const picked = await vscode.window.showQuickPick(
    entries.map(e => ({
      label: e.name,
      description: `${e.instructions} instructions, ${e.codeBytes} bytes` +
        (e.registers ? `, ${e.registers} registers` : ''),
      entry: e
    })),
    { title: 'Which entry point?', matchOnDescription: true });
  return picked && picked.entry;
}

/**
 * Disassemble one entry point and open its listing.
 *
 * The disassembly itself is deliberately the same two calls the cache path makes -
 * `nvdisasm --binary` over raw microcode, then `ctrl.annotate` over the result - because the
 * `.text` section of a cubin is the same kind of thing a carve produces. Anything that only
 * worked here would drift out of step with the path that is used far more often.
 */
async function openEntry({ built, entry, source, compiledFrom, directive, configured,
  archInfo, token, outDir }) {
  const { path: nvdisasm } = await pipeline.resolveNvdisasm();

  const rawPath = path.join(outDir, `${entry.name}.raw`);
  await fs.promises.writeFile(rawPath, entry.microcode);

  // The browse path's call, not a second spelling of it: it returns the command it really
  // ran, properly quoted.
  const disassembled = await pipeline.runNvdisasm(nvdisasm, built.arch, rawPath, token);
  const sass = disassembled.text;
  const annotation = config().get('decodeControlCodes') !== false
    ? ctrl.annotate(sass, entry.microcode)
    : null;
  const plain = annotation ? annotation.text : sass;

  // Same lifetime the browse path gives it - the setting means the same thing on both roads,
  // and without this every compiled entry left a .raw in the scratch directory.
  if (!config().get('keepRawMicrocode')) {
    fs.promises.unlink(rawPath).catch(() => {});
  }

  // Correlation comes from a second pass over the cubin, because line info lives in the ELF
  // and `--binary` has no ELF to read it from.
  //
  // The graphics lineage has no cubin and no line table to read one out of, and this is
  // measured rather than assumed: across 3,340 cache objects the container carries no debug
  // section at all, and SPIR-V built with `slangc -g` - `OpLine`, `OpSource`, the whole source
  // text embedded - produced a byte-identical object of exactly the same size. The driver
  // strips it. So the block is skipped outright rather than allowed to fail into its catch,
  // which would log "source correlation unavailable" on every graphics compile and read as a
  // fault rather than as a property of the route.
  const graphics = built.lineage === 'graphics';
  let correlation = null;
  let body = plain;
  const style = config().get('compile.correlationStyle') || 'banner';
  if (style !== 'off' && !graphics) {
    try {
      const g = await runTool(nvdisasm, ['-c', '-g', built.cubinPath], token);
      // An unsaved buffer was compiled from a copy; the line table names the copy, and
      // everything downstream must name the file the user actually has open.
      const parsed = correlate.rewriteSource(
        correlate.parse(g, entry.name), compiledFrom, source);
      const records = parsed.entries.get(entry.name);
      if (records && records.length) {
        const labels = correlate.labelsFor(parsed.files);
        // Keyed line-first so the separator can be a space: a path may contain spaces, a
        // line number may not, so the first token is always unambiguous. (This used to key
        // on a NUL, written as a literal byte rather than an escape, which made the whole
        // file binary to git and grep.)
        const distinct = new Set(records.map(r => `${r.line} ${r.file}`)).size;
        // Runs are contiguous from the first record onward, so the only instructions with no
        // source position are those before it. Counting them does not need the per-address
        // Map expanded - which for a large kernel is one entry per instruction, built here
        // only to be thrown away in `banner` style.
        const unattributed = records[0].address / ctrl.INSTRUCTION_BYTES;

        // `banner` keeps the instruction stream clean and puts the map in the header;
        // `inline` is the older form, which travels better into a plain-text paste.
        // The per-address expansion is built only for the form that needs it.
        if (style === 'inline') {
          body = correlate.annotate(
            plain, correlate.byAddress(records, entry.codeBytes), { labels }).text;
        }
        correlation = {
          marked: records.length,
          lines: distinct,
          unattributed,
          files: parsed.files.map(f => [f, labels.get(f)]),
          map: style === 'banner' ? correlate.bannerLines(records, labels) : null
        };
        log(`correlated ${records.length} run(s) over ${distinct} source line(s)` +
          (unattributed ? `, ${unattributed} instruction(s) unattributed` : '') +
          ` (${style})`);
      } else {
        log('nvdisasm -g returned no source positions for this entry point');
      }
    } catch (e) {
      // A listing without correlation is still a listing. Losing the SASS because the line
      // table could not be read would be the wrong trade.
      log(`source correlation unavailable: ${e.message}`);
    }
  }

  const info = built.ptxasInfo(entry.name);
  const object = {
    name: entry.name,
    source,
    offset: 0,
    codeBytes: entry.codeBytes,
    microcode: entry.microcode,
    // The carve already knows what this is; only the CUDA road, whose entries come out of a
    // cubin rather than a cache container, has no identity to forward.
    sha1: entry.sha1 || sha1(entry.microcode),
    origin: graphics ? 'driver' : 'compiled',
    warnings: [],
    // The CUDA road has to state these, because a cubin records almost none of them and
    // `stage: 'compute'` is true there by construction. The graphics road does not have to
    // state anything: its bytes came out of a real cache container, so the driver's own
    // account of the shader travels with them - the stage as a code rather than an assumption,
    // and `killsPixels`, which is meaningful for a fragment shader and meaningless for a
    // kernel. Hardcoding `compute` here would have quietly labelled every pixel shader wrong.
    metadata: graphics ? entry.metadata : {
      stage: 'compute',
      stageCode: null,
      // ptxas's own account of the kernel, which the banner then cross-checks against what
      // the code is measured to use - the same two-source comparison the cache path makes.
      registers: info.registers !== null ? info.registers : entry.registers,
      registerCap: null,
      localBytes: info.localBytes,
      sharedBytes: info.sharedBytes,
      killsPixels: null
    }
  };

  const result = {
    text: plain,                       // banner and statistics read this: no markers in it
    correlated: body,                  // what gets written as the listing body
    object,
    arch: built.arch,
    archFrom: archInfo.from,
    nvdisasm,
    nvdisasmVersion: await pipeline.nvdisasmVersion(nvdisasm),
    command: disassembled.command,
    annotation,
    correlation,
    compile: {
      steps: built.steps,
      sources: built.sources,
      notes: built.notes,
      directive: directive ? directive.raw : null,
      configuredFlags: configured || null,
      device: built.device || null,
      pipeline: built.pipeline || null
    }
  };

  const file = await writeCompiledListing(result);
  const doc = await output.showListing(file, {
    preview: false,
    viewColumn: vscode.ViewColumn.Beside
  });
  refresh(vscode.window.activeTextEditor);
  return doc;
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

  const tag = sha1(Buffer.from(path.resolve(result.object.source).toLowerCase())).slice(0, 6);
  const name = `${output.sanitize(result.object.name)}.${tag}.` +
    `${output.sanitize(result.arch, 'sm')}${output.LISTING_EXT}`;
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

function isListing(doc) {
  return doc && doc.languageId === output.LANGUAGE_ID;
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
  revealSource,
  markersFor,
  refresh,
  watch
};
