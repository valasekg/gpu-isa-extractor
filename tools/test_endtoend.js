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

const settings = {
  nvIsaExtractor: {
    nvdisasmPath: '', arch: 'auto', minCodeBytes: 0, glcacheMode: 'auto',
    decodeControlCodes: true, keepRawMicrocode: false,
    'output.location': 'temp', 'output.retentionDays': 30
  },
  nvidiaSass: { semanticHighlighting: true, semanticMaxLines: 100000 }
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
  check(typeof require(path.join(__dirname, '..', 'extension.js')).activate === 'function',
    'extension.js loads and exports activate');

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

        const file = await output.openListing(context, result, swept);
        const written = fs.readFileSync(file, 'utf8');
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

  fs.rmSync(storage, { recursive: true, force: true });
  const tempDir = path.join(os.tmpdir(), 'nv-isa-extractor');
  fs.rmSync(tempDir, { recursive: true, force: true });

  console.log(`\n${failures ? 'FAIL' : 'PASS'}  ${checks} checks, ${failures} failures, ` +
    `${skipped} skipped`);
  process.exit(failures ? 1 : 0);
})().catch(e => {
  console.log(`\nFAIL  ${e && e.stack ? e.stack : e}`);
  process.exit(1);
});
