'use strict';

/**
 * The whole pipeline against a real shader cache, with the VS Code API stubbed out.
 *
 * Everything from "a path to a cache file" to "the text of a listing" runs here: the sweep,
 * the QuickPick's input, the carve, nvdisasm, the control-code annotation and the provenance
 * banner. What is *not* covered is the widgets themselves - a progress notification and a
 * quick pick have to be looked at, and that is what the Extension Development Host is for.
 *
 * Skips cleanly when this machine has no shader cache or no CUDA toolkit, so it can sit in
 * the normal verification run.
 *
 *   ELECTRON_RUN_AS_NODE=1 Code.exe tools/test_endtoend.js
 */

const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

let checks = 0;
let failures = 0;
let skipped = 0;

function check(condition, what, detail = '') {
  checks++;
  if (condition) return;
  failures++;
  console.log(`  FAIL  ${what}`);
  if (detail) console.log(`        ${String(detail).split('\n').slice(0, 6).join('\n        ')}`);
}

function skip(what) {
  skipped++;
  console.log(`  skip  ${what}`);
}

function section(title) {
  console.log(`\n${title}`);
}

/* --------------------------------------------------------- the vscode stub --- */

// One bag, because the two namespaces merged into one. They were separate keys here, and
// leaving them that way after the rename made the second silently discard the first - a
// duplicate object literal key is not an error, it is the later value.
const settings = {
  gpuIsaExtractor: {
    nvdisasmPath: '', arch: 'auto', minCodeBytes: 0, glcacheMode: 'auto',
    decodeControlCodes: true, keepRawMicrocode: false,
    'output.location': 'temp', 'output.retentionDays': 30,
    semanticHighlighting: true, semanticMaxLines: 100000
  }
};

const opened = [];
const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'nvisa-e2e-'));

const vscodeStub = {
  version: '0.0.0-test',
  Uri: { file: p => ({ fsPath: p, scheme: 'file', toString: () => p }) },
  ProgressLocation: { Notification: 15, Window: 10 },
  workspace: {
    textDocuments: [],
    getConfiguration(sectionName) {
      const bag = settings[sectionName] || {};
      return { get: (key, fallback) => (key in bag ? bag[key] : fallback) };
    },
    async openTextDocument(uri) {
      opened.push(uri.fsPath);
      return { uri, languageId: 'nvidia-sass' };
    },
    onDidChangeConfiguration() { return { dispose() {} }; }
  },
  window: {
    async withProgress(_options, task) {
      return task({ report() {} }, { isCancellationRequested: false, onCancellationRequested() { return { dispose() {} }; } });
    },
    async showTextDocument() {},
    showWarningMessage() {},
    showErrorMessage() {},
    showInformationMessage() {},
    createOutputChannel() {
      return { appendLine() {}, clear() {}, show() {}, dispose() {} };
    },
    createTextEditorDecorationType: o => ({ o, dispose() {} }),
    onDidChangeTextEditorSelection: () => ({ dispose() {} }),
    onDidChangeActiveTextEditor: () => ({ dispose() {} }),
    visibleTextEditors: []
  },
  languages: { async setTextDocumentLanguage() {} },
  extensions: { getExtension: () => null },
  commands: { registerCommand() { return { dispose() {} }; } },
  SemanticTokensBuilder: class { build() { return {}; } },
  SemanticTokensLegend: class { constructor(types, mods) { this.types = types; this.mods = mods; } },
  Range: class { constructor(sl, sc, el, ec) { Object.assign(this, { sl, sc, el, ec }); } },
  Location: class { constructor(uri, range) { Object.assign(this, { uri, range }); } },
  ThemeColor: class { constructor(id) { this.id = id; } },
  OverviewRulerLane: { Center: 2 },
  EventEmitter: class {
    constructor() { this.event = () => ({ dispose() {} }); }
    fire() {}
    dispose() {}
  },
  SymbolKind: { Function: 11, Key: 19 }
};

const realResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'vscode') return 'vscode';
  return realResolve.call(this, request, ...rest);
};
require.cache.vscode = { id: 'vscode', filename: 'vscode', loaded: true, exports: vscodeStub };

const pipeline = require(path.join(__dirname, '..', 'src', 'pipeline.js'));
const output = require(path.join(__dirname, '..', 'src', 'output.js'));
const doctor = require(path.join(__dirname, '..', 'src', 'doctor.js'));
const ctrl = require(path.join(__dirname, '..', 'src', 'ctrl.js'));

const context = { globalStorageUri: { fsPath: storage } };

/* ----------------------------------------------------------- find a cache --- */

function glBlobs() {
  const root = process.env.LOCALAPPDATA &&
    path.join(process.env.LOCALAPPDATA, 'NVIDIA', 'GLCache');
  const out = [];
  const walk = dir => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith('.bin') && fs.existsSync(full.slice(0, -4) + '.toc')) out.push(full);
    }
  };
  if (root) walk(root);
  // Smallest readable blob first: the point is to exercise the path, not to be slow.
  return out.map(p => ({ p, size: fs.statSync(p).size })).sort((a, b) => a.size - b.size);
}

(async () => {
  section('1. Modules load');
  check(typeof pipeline.sweep === 'function', 'pipeline.js loads against the VS Code API');
  check(typeof output.openListing === 'function', 'output.js loads');
  check(typeof doctor.diagnose === 'function', 'doctor.js loads');
  // compileview builds its decoration types at module scope, so it fails to load rather than
  // failing at first use if the editor API it expects is not there.
  check(typeof require(path.join(__dirname, '..', 'src', 'compileview.js')).compileCommand
    === 'function', 'compileview.js loads against the VS Code API');
  check(typeof require(path.join(__dirname, '..', 'extension.js')).activate === 'function',
    'extension.js loads and exports activate');

  // Loading the module is not enough, and this file is the only place that can prove more.
  //
  // `compileview.build` assembles the options `compile.compile` runs on. Nothing else reaches
  // it without a real toolchain, so its body was never executed by any check - and it has
  // twice shipped a runtime error the gate structurally could not see. The first was a
  // SyntaxError, caught only because modules are parsed; the second was a `settings` reference
  // in a function that binds no such name, which took down EVERY compile with
  // "settings is not defined" while the gate read 85 passed, 0 failed.
  //
  // Driven with a file extension nothing can compile, so it builds its whole options object
  // and then fails inside `compile.compile` for a reason this check states exactly. Any
  // ReferenceError or TypeError escaping instead is a scope bug in `build`.
  await (async () => {
    const compileview = require(path.join(__dirname, '..', 'src', 'compileview.js'));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nvisa-build-'));
    let thrown = null;
    try {
      await compileview.build({
        file: path.join(dir, 'nothing.unknownext'),
        source: path.join(dir, 'nothing.unknownext'),
        tools: {}, flags: { primary: [], nvrtc: [], ptxas: [], slang: [], dirs: [] },
        archInfo: { arch: '86', from: 'test' }, outDir: dir, backend: 'auto',
        directive: null, configured: '', progress: { report: () => {} }, token: null,
        road: 'cuda', controls: null, entry: undefined,
        target: { id: 'nvidia', vendor: 'NVIDIA', isa: 'SASS' }
      });
    } catch (e) {
      thrown = e;
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    check(thrown !== null, 'compileview.build rejects on a file it cannot compile');
    check(thrown && !(thrown instanceof ReferenceError) && !(thrown instanceof TypeError),
      'and it gets far enough to REACH that refusal - no scope error while building its ' +
      'options, which is how "settings is not defined" reached a release',
      thrown ? `${thrown.constructor.name}: ${thrown.message}`.split('\n')[0] : '');
    check(thrown && /is not something this can compile/.test(thrown.message || ''),
      'the refusal is the one this input earns', thrown ? (thrown.message || '').split('\n')[0] : '');
  })();

  section('2. Naming and classification');
  check(output.listingName({ name: 'evalGridTex_2', sha1: 'abcdef0123456789' }, 'SM86')
    === 'evalGridTex_2.abcdef01.SM86.nvsass', 'a listing is named after its object',
    output.listingName({ name: 'evalGridTex_2', sha1: 'abcdef0123456789' }, 'SM86'));
  check(output.sanitize('con') === 'object' && output.sanitize('a/b\\c:d') === 'a_b_c_d' &&
    output.sanitize('') === 'object' && output.sanitize('x'.repeat(200)).length === 80,
    'entry names are made safe for a Windows filename');
  check(pipeline.classify('x.nvph').backend === 'dx' &&
    pipeline.classify('x.bin').backend === 'vk' &&
    pipeline.classify('x.BIN').backend === 'vk' &&
    pipeline.classify('x.dat').backend === 'raw',
    'cache files are classified by extension, case-insensitively');
  {
    let threw = null;
    try { pipeline.classify(path.join(storage, 'nothing.toc')); } catch (e) { threw = e; }
    check(threw && /only the index/.test(threw.message),
      'a .toc with no .bin beside it explains itself', threw && threw.message);
  }

  section('3. Doctor');
  {
    const findings = await doctor.diagnose(context);
    const rendered = doctor.render(findings, context);
    check(findings.length >= 6, 'the doctor reports on every dependency',
      String(findings.length));
    const zstdCheck = findings.find(f => /zstd/.test(f.title));
    check(zstdCheck && zstdCheck.level === 'ok',
      'the bundled decompressor passes its self-test',
      zstdCheck && JSON.stringify(zstdCheck));
    check(/environment check/.test(rendered.text) && rendered.text.includes('nvdisasm'),
      'the report renders');
    for (const f of findings) {
      console.log(`        ${f.level.padEnd(4)}  ${f.title}`);
    }
  }

  section('4. End to end on a real cache file');
  const blobs = glBlobs();
  if (!blobs.length) {
    skip('no GLCache blobs on this machine');
  } else {
    let nvdisasmAvailable = true;
    try { await pipeline.resolveNvdisasm(); await pipeline.resolveArch(); } catch (e) {
      nvdisasmAvailable = false;
      skip(`nvdisasm or GPU architecture unavailable: ${e.message}`);
    }

    // Walk from the smallest blob up until one yields an object; the driver holds some open.
    let swept = null;
    for (const { p } of blobs) {
      try {
        const result = await pipeline.sweep(p, { log: () => {} });
        if (result.objects.length) { swept = result; break; }
      } catch (e) { /* locked or empty; try the next */ }
    }

    if (!swept) {
      skip('no readable GLCache blob yielded an object');
    } else {
      check(swept.objects.length > 0, `swept ${path.basename(swept.source)}: ` +
        `${swept.objects.length} object(s) in ${swept.frames} frame(s)`);

      const collapsed = pipeline.collapse(swept.objects);
      check(collapsed.length > 0 && collapsed[0].codeBytes >= collapsed[collapsed.length - 1].codeBytes,
        'objects collapse by identity and sort largest first',
        collapsed.map(o => `${o.name}:${o.codeBytes}x${o.copies}`).slice(0, 3).join(' '));
      check(collapsed.every(o => o.sha1 && o.instructions * 16 === o.codeBytes),
        'every object has an identity and a whole number of instructions');

      if (nvdisasmAvailable) {
        // Pick the smallest so nvdisasm returns quickly.
        const chosen = collapsed[collapsed.length - 1];
        const result = await pipeline.disassemble(swept, chosen, {
          log: () => {}, scratchDir: output.scratchDir(context)
        });

        check(result.text.length > 0, `disassembled ${chosen.name || '(unnamed)'} ` +
          `(${chosen.instructions} instructions) to ${result.text.length} chars`);
        check(!result.text.includes('\r'), 'CRLF is normalised out of nvdisasm output');
        check(/^SM\d+$/.test(result.arch), 'the architecture is an SM string', result.arch);

        const ann = result.annotation;
        check(ann && ann.annotated === chosen.instructions,
          'every instruction got a control column',
          ann ? `${ann.annotated} of ${chosen.instructions}` : 'no annotation');
        // `missing` is the direction with no benign reading: nvdisasm found a reuse flag at a
        // bit this did not read. Any of those means the control window is wrong.
        check(ann && ann.missing === 0 && !ann.suspect,
          'the reuse tripwire clears this object',
          ann ? `${ann.missing} missing, ${ann.extra} extra of ${ann.annotated}` : '');

        // Every annotated line must satisfy the format contract the grammar matches.
        const columns = result.text.split('\n')
          .map(l => (l.match(/\[B[0-5-]{6}:R[0-5-]:W[0-5-]:[Y-]:S\d\d\]/) || [])[0])
          .filter(Boolean);
        check(columns.length === ann.annotated,
          'every column matches the format the grammar and parser expect',
          `${columns.length} of ${ann.annotated}`);

        // And the extension's own parser must read them back.
        const { parseLine } = require(path.join(__dirname, '..', 'src', 'parse.js'));
        const instructionLines = result.text.split('\n').filter(l => /\/\*[0-9a-f]+\*\//.test(l));
        const parsedOk = instructionLines.filter(l => {
          const p = parseLine(l);
          return p && p.controlCode && p.controlCode.era === 'volta' && p.opcode;
        });
        check(parsedOk.length === instructionLines.length,
          'the extension parses back every line it generated',
          `${parsedOk.length} of ${instructionLines.length}`);

        // What the container states about the shader, cross-checked against its own code.
        const meta = result.object.metadata;
        check(!!meta, 'the carved object carries the container\'s metadata');
        check(meta.stage !== null,
          `the shader stage is recorded: ${meta.stage} (code ${meta.stageCode})`,
          JSON.stringify(meta));
        check(meta.registers !== null && meta.registers > 0,
          `the register count is recorded: ${meta.registers} (cap ${meta.registerCap})`);

        // The declared count must cover every register the code actually touches. If it did
        // not, the field would be something else.
        let maxR = -1;
        const re = /\bR(\d+)\b/g;
        let m;
        while ((m = re.exec(result.text)) !== null) maxR = Math.max(maxR, Number(m[1]));
        check(meta.registers >= maxR + 1,
          'and it covers the highest register the disassembly uses',
          `${meta.registers} declared vs R${maxR} used`);

        // Local memory: the container's answer and the instruction mix must agree.
        const usesLocal = /\b(?:LDL|STL)\b/.test(result.text);
        check(usesLocal === (meta.localBytes !== null && meta.localBytes > 0),
          'the declared local memory agrees with whether the code spills',
          `declared ${meta.localBytes}, LDL/STL present: ${usesLocal}`);

        const file = await output.openListing(context, result, swept);
        const written = fs.readFileSync(file, 'utf8');
        check(/^\/\/ stage\s+: /m.test(written) && /^\/\/ local mem\s+: /m.test(written),
          'and all of it reaches the listing banner',
          written.split('\n').slice(0, 12).join('\n'));
        check(/^\/\/ instructions\s+: /m.test(written) && /^\/\/ scheduling\s+: /m.test(written),
          'along with what the code is made of',
          written.split('\n').slice(0, 20).join('\n'));
        // A generated listing should stay plain ASCII: it is read by whatever the user
        // opens it with, not only by an editor that knows it is UTF-8.
        const nonAscii = written.split('\n').filter(l => /[^\x00-\x7f]/.test(l));
        check(nonAscii.length === 0, 'and the listing is plain ASCII throughout',
          nonAscii.slice(0, 3).join('\n'));
        check(opened.includes(file), 'the listing is opened in an editor');
        check(written.includes(`sha1 ${result.object.sha1}`) &&
              written.includes(result.object.source),
          'the banner records where the object came from');
        check(written.includes(`EF_CUDA_${result.arch}`),
          'the banner carries the architecture token the hovers read');
        check(written.includes('NOT the'),
          'the banner warns that these scoreboards are not the Maxwell numbering');

        console.log(`\n        ${path.basename(file)}`);
        for (const line of written.split('\n').slice(0, 9)) console.log(`        ${line}`);
        console.log('        ...');
        for (const line of written.split('\n').filter(l => /\/\*[0-9a-f]+\*\/ \[B/.test(l)).slice(0, 4)) {
          console.log(`        ${line}`);
        }
      }
    }
  }

  section('5. Retention');
  {
    const dir = output.listingDir(context);
    fs.mkdirSync(dir, { recursive: true });
    const old = path.join(dir, 'stale.deadbeef.SM86.nvsass');
    fs.writeFileSync(old, '// old');
    const longAgo = Date.now() - 90 * 24 * 3600 * 1000;
    fs.utimesSync(old, longAgo / 1000, longAgo / 1000);
    const removed = await output.pruneListings(context, () => {});
    check(removed >= 1 && !fs.existsSync(old), 'listings past the retention window are pruned',
      String(removed));

    const keep = path.join(dir, 'fresh.deadbeef.SM86.nvsass');
    fs.writeFileSync(keep, '// new');
    await output.pruneListings(context, () => {});
    check(fs.existsSync(keep), 'recent listings are kept');

    // A listing open in an editor must survive the sweep.
    const openOne = path.join(dir, 'open.deadbeef.SM86.nvsass');
    fs.writeFileSync(openOne, '// open');
    fs.utimesSync(openOne, longAgo / 1000, longAgo / 1000);
    vscodeStub.workspace.textDocuments = [{ uri: { scheme: 'file', fsPath: openOne } }];
    await output.pruneListings(context, () => {});
    check(fs.existsSync(openOne), 'a listing open in an editor is not pruned under the user');
    vscodeStub.workspace.textDocuments = [];
  }

  section('6. Compiling a kernel to a listing');

  {
    // The compiled path against the real toolchain: nvrtc or nvcc, then ptxas, then the very
    // same nvdisasm invocation the cache path makes. It is skipped rather than failed where
    // the tools are absent, like every other check here that needs something installed.
    const compile = require(path.join(__dirname, '..', 'src', 'compile.js'));
    const compileview = require(path.join(__dirname, '..', 'src', 'compileview.js'));
    const correlate = require(path.join(__dirname, '..', 'src', 'correlate.js'));

    const tools = await compileview.resolveTools();
    if (!tools.ptxas || !(tools.python || tools.nvcc)) {
      skip('ptxas, or a CUDA front end, is not installed');
    } else {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nvisa-compile-'));
      const source = path.join(dir, 'k.cu');
      fs.writeFileSync(source,
        '// gpu-isa-extractor -use_fast_math -Xptxas -maxrregcount=32\n' +
        'extern "C" __global__ void saxpy(const float* x, float* y, float a, int n)\n' +
        '{\n' +
        '    int i = blockIdx.x * blockDim.x + threadIdx.x;\n' +
        '    if (i < n) y[i] = a * x[i] + y[i];\n' +
        '}\n');

      const directive = compile.readDirective(fs.readFileSync(source, 'utf8'));
      check(!!directive, 'the flag directive is read out of the file');
      const flags = compile.effectiveFlags(directive, '');
      check(flags.ptxas.includes('-maxrregcount=32'),
        '-Xptxas routes to the assembler', JSON.stringify(flags));

      let built = null;
      try {
        built = await compile.compile(tools, source, {
          arch: 'SM86', outDir: path.join(dir, 'out'), flags
        });
      } catch (e) {
        skip(`the toolchain could not compile a kernel here: ${e.message.split('\n')[0]}`);
      }

      if (built) {
        check(built.entries.length === 1, 'the kernel yields one entry point');
        const entry = built.entries[0];
        check(entry.name === 'saxpy', 'named after the __global__ function', entry.name);
        check(entry.codeBytes % 16 === 0,
          'its .text section is a whole number of instructions');
        check(built.arch === 'SM86', 'the cubin reports the architecture it was built for',
          built.arch);
        check(built.ptxasInfo('saxpy').registers > 0,
          'ptxas -v reports a register count for the banner to cross-check');

        // The point of the whole arrangement: the carved-microcode pipeline runs unchanged.
        const { path: nvdisasm } = await pipeline.resolveNvdisasm();
        const raw = path.join(dir, 'saxpy.raw');
        fs.writeFileSync(raw, entry.microcode);
        const sass = cp.execFileSync(
          nvdisasm, ['--binary', built.arch, '--no-dataflow', raw],
          { maxBuffer: 1 << 26 }).toString().replace(/\r\n/g, '\n');
        const annotated = ctrl.annotate(sass, entry.microcode);
        check(annotated.annotated > 0,
          'the control-code column decodes over a compiled kernel',
          JSON.stringify({ annotated: annotated.annotated, skipped: annotated.skipped }));
        check(!annotated.suspect,
          'and its reuse tripwire agrees with what nvdisasm printed',
          `${annotated.mismatchTotal} mismatch(es)`);

        // Correlation, from a second pass over the cubin.
        const g = cp.execFileSync(nvdisasm, ['-c', '-g', built.cubinPath],
          { maxBuffer: 1 << 26 }).toString().replace(/\r\n/g, '\n');
        const parsed = correlate.parse(g, entry.name);
        const records = parsed.entries.get(entry.name);
        check(!!records && records.length > 0,
          'nvdisasm -g yields source positions for a compiled kernel');
        if (records) {
          const merged = correlate.annotate(
            annotated.text, correlate.byAddress(records, entry.codeBytes),
            { labels: correlate.labelsFor(parsed.files) });
          check(merged.marked > 0, 'which merge into the listing as markers');
          check(merged.text.includes('//## k.cu:'),
            'naming the file the user actually wrote', parsed.files.join(' '));
          check(merged.unattributed === 0,
            'and every instruction carries a position',
            `${merged.unattributed} unattributed of ${annotated.annotated}`);

          // Generated listings stay plain ASCII, markers included.
          check(!/[^\x00-\x7f]/.test(merged.text),
            'the correlated listing is still plain ASCII');
        }
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  section('7. Includes and imports, from a file compiled somewhere else');

  {
    // The case the include path exists for. An unsaved buffer is compiled from a copy in the
    // scratch directory, so the header beside the *real* file - or the module it imports - is
    // invisible from where the compiler is actually reading. Each half here is run twice:
    // once as the extension runs it, and once without `home`, which is what the compiler can
    // do on its own. The second is what says the include path is load-bearing rather than
    // decorative.
    const compile = require(path.join(__dirname, '..', 'src', 'compile.js'));
    const compileview = require(path.join(__dirname, '..', 'src', 'compileview.js'));

    const tools = await compileview.resolveTools();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nvisa-include-'));
    const home = path.join(dir, 'src');           // where the user's files live
    const elsewhere = path.join(dir, 'scratch');  // where a dirty buffer is compiled from
    fs.mkdirSync(home);
    fs.mkdirSync(elsewhere);

    /** Compile `text` from a copy in `elsewhere`, exactly as a dirty buffer is compiled. */
    const fromCopy = async (name, text, options) => {
      const copy = path.join(elsewhere, name);
      fs.writeFileSync(copy, text);
      const outDir = fs.mkdtempSync(path.join(dir, 'out-'));
      try {
        return {
          outDir,
          built: await compile.compile(tools, copy, {
            arch: 'SM86',
            outDir,
            flags: compile.effectiveFlags(null, ''),
            ...options
          })
        };
      } catch (e) {
        return { outDir, error: e };
      }
    };

    /** The include directories the CUDA front end was actually given. */
    const cudaIncludes = (built, outDir) => {
      const step = built.steps.find(s => s.tool === 'nvrtc' || s.tool === 'nvcc');
      if (!step) return [];
      // NVRTC's options go in a request file rather than on the helper's command line - see
      // `cudaToPtx`, which put them there precisely because an include path is the kind of
      // argument that does not survive being quoted across Node, `py` and Windows.
      const argv = step.tool === 'nvcc'
        ? step.command.split(' ')
        : JSON.parse(fs.readFileSync(path.join(outDir, 'nvrtc-request.json'), 'utf8')).options;
      return argv.filter(a => a.startsWith('-I')).map(a => a.slice(2));
    };

    if (!tools.ptxas || !(tools.python || tools.nvcc)) {
      skip('ptxas, or a CUDA front end, is not installed');
    } else {
      fs.writeFileSync(path.join(home, 'scale.h'),
        '#pragma once\n' +
        '__device__ inline float scaled(float x) { return x * 3.0f; }\n');
      const cu =
        '#include "scale.h"\n' +
        'extern "C" __global__ void kern(const float* x, float* y, int n)\n' +
        '{\n' +
        '    int i = blockIdx.x * blockDim.x + threadIdx.x;\n' +
        '    if (i < n) y[i] = scaled(x[i]);\n' +
        '}\n';

      const found = await fromCopy('k.cu', cu, { home });
      check(!found.error, 'a .cu compiles against a header beside the file it came from',
        found.error && found.error.message);
      if (found.built) {
        check(found.built.entries.length === 1 && found.built.entries[0].name === 'kern',
          'and yields the kernel that used it');
        const dirs = cudaIncludes(found.built, found.outDir);
        check(dirs[0] === home,
          'because the front end was told to look where the file really lives, first',
          dirs.join(' '));
      }

      const lost = await fromCopy('k.cu', cu, {});
      check(!!lost.error && /scale\.h/.test(lost.error.message),
        'and without that directory the header is not found at all - NVRTC has no notion of ' +
        'a source directory, so this is the include path doing the work',
        lost.error ? lost.error.message.split('\n')[0] : 'it compiled');
    }

    if (!tools.slangc || !tools.ptxas || !(tools.python || tools.nvcc)) {
      skip('slangc, ptxas or a CUDA front end is not installed');
    } else {
      fs.writeFileSync(path.join(home, 'helpers.slang'),
        'module helpers;\n\n' +
        'public float weigh(float x, float w) { return x * w + 1.0f; }\n');
      const slang =
        'import helpers;\n\n' +
        'StructuredBuffer<float> src;\n' +
        'RWStructuredBuffer<float> dst;\n\n' +
        '[shader("compute")]\n' +
        '[numthreads(64,1,1)]\n' +
        'void csMain(uint3 tid : SV_DispatchThreadID)\n' +
        '{\n' +
        '    dst[tid.x] = weigh(src[tid.x], 2.0f);\n' +
        '}\n';

      const found = await fromCopy('k.slang', slang, { home });
      check(!found.error, 'a .slang compiles against a module beside the file it came from',
        found.error && found.error.message);
      if (found.built) {
        check(found.built.entries.length === 1 && found.built.entries[0].name === 'csMain',
          'and yields the entry point that imported it');
        const step = found.built.steps.find(s => s.tool === 'slangc');
        check(step && step.command.includes(`-I${home}`),
          'and slangc\'s recorded command line says where it was told to look',
          step && step.command);
      }

      const lost = await fromCopy('k.slang', slang, {});
      check(!!lost.error && /helpers/.test(lost.error.message),
        'and without that directory the import cannot be resolved',
        lost.error ? lost.error.message.split('\n')[0] : 'it compiled');
    }

    fs.rmSync(dir, { recursive: true, force: true });
  }

  fs.rmSync(storage, { recursive: true, force: true });
  const tempDir = path.join(os.tmpdir(), 'gpu-isa-extractor');
  fs.rmSync(tempDir, { recursive: true, force: true });

  console.log(`\n${failures ? 'FAIL' : 'PASS'}  ${checks} checks, ${failures} failures, ` +
    `${skipped} skipped`);
  process.exit(failures ? 1 : 0);
})().catch(e => {
  console.log(`\nFAIL  ${e && e.stack ? e.stack : e}`);
  process.exit(1);
});
