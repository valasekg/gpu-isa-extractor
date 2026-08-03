'use strict';

/**
 * The memory invariant, measured against a real cache file.
 *
 * The claim this suite exists to defend: browsing a cache file costs its object records, not
 * its bytes. It is easy to write a browser that quietly retains a 167 MB buffer per listed
 * file and only discovers it when the editor starts swapping, so the numbers are asserted
 * here rather than reasoned about.
 *
 * Skips cleanly where there is no cache to read.
 *
 *   ELECTRON_RUN_AS_NODE=1 Code.exe tools/test_blobstore.js
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

function note(what) { console.log(`        ${what}`); }
function skip(what) { skipped++; console.log(`  skip  ${what}`); }
function section(title) { console.log(`\n${title}`); }

/* --------------------------------------------------------- the vscode stub --- */

const settings = {
  nvIsaExtractor: {
    nvdisasmPath: '', arch: 'auto', minCodeBytes: 0, glcacheMode: 'auto',
    decodeControlCodes: true, keepRawMicrocode: false,
    'output.location': 'temp', 'output.retentionDays': 30, 'tree.maxBlobs': 8
  },
  nvidiaSass: { semanticHighlighting: true, semanticMaxLines: 100000 }
};

const globalStateBacking = {};

const vscodeStub = {
  version: '0.0.0-test',
  Uri: { file: p => ({ fsPath: p, scheme: 'file' }) },
  ProgressLocation: { Notification: 15, Window: 10 },
  EventEmitter: class {
    constructor() { this._ls = new Set(); this.event = l => { this._ls.add(l); return { dispose: () => this._ls.delete(l) }; }; }
    fire(v) { for (const l of this._ls) l(v); }
    dispose() { this._ls.clear(); }
  },
  workspace: {
    textDocuments: [],
    getConfiguration(sectionName) {
      const bag = settings[sectionName] || {};
      return { get: (key, fallback) => (key in bag ? bag[key] : fallback) };
    }
  },
  window: { showWarningMessage() {}, createOutputChannel() { return { appendLine() {}, dispose() {} }; } },
  languages: {},
  extensions: { getExtension: () => null },
  commands: { registerCommand() { return { dispose() {} }; } }
};

const realResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'vscode') return 'vscode';
  return realResolve.call(this, request, ...rest);
};
require.cache.vscode = { id: 'vscode', filename: 'vscode', loaded: true, exports: vscodeStub };

const blobstore = require(path.join(__dirname, '..', 'src', 'blobstore.js'));
const review = require(path.join(__dirname, '..', 'src', 'review.js'));
const pipeline = require(path.join(__dirname, '..', 'src', 'pipeline.js'));
const nvcache = require(path.join(__dirname, '..', 'src', 'nvcache.js'));

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
  return out.map(p => ({ p, size: fs.statSync(p).size })).sort((a, b) => b.size - a.size);
}

const MB = 1024 * 1024;
const rssMB = () => process.memoryUsage().rss / MB;

(async () => {
  section('1. The review ledger');
  {
    review.load({
      get: k => globalStateBacking[k],
      update: (k, v) => { globalStateBacking[k] = v; return Promise.resolve(); }
    });
    check(review.isReviewed('abc') === false, 'nothing is reviewed to start with');
    await review.set('abc', true);
    check(review.isReviewed('abc') === true, 'a shader can be marked');
    await review.toggle('abc');
    check(review.isReviewed('abc') === false, 'and unmarked');

    await review.setMany(['a1', 'a2', 'a3'], true);
    const counted = review.counts([
      { sha1: 'a1' }, { sha1: 'a1' }, { sha1: 'a2' }, { sha1: 'zz' }
    ]);
    check(counted.total === 3 && counted.reviewed === 2,
      'counts treat identical copies as one shader', JSON.stringify(counted));

    // Marks key on content, so they survive the driver moving every object in a file.
    check(review.isReviewed('a1'), 'a mark is keyed on the shader, not on where it sat');

    let fired = 0;
    const sub = review.onDidChange(() => fired++);
    await review.set('a4', true);
    sub.dispose();
    check(fired === 1, 'a change notifies listeners once', String(fired));

    check(JSON.stringify(globalStateBacking[review.KEY] || {}).includes('a1'),
      'marks are persisted to the memento');

    await review.clear();
    check(review.size() === 0 && !review.isReviewed('a1'), 'clearing forgets everything');
  }

  section('2. Sweeping without keeping the bytes');
  const blobs = glBlobs();
  if (!blobs.length) {
    skip('no GLCache blobs on this machine');
  } else {
    const biggest = blobs[0];
    note(`largest blob: ${path.basename(biggest.p)}, ${(biggest.size / MB).toFixed(1)} MB`);

    const before = rssMB();
    const t0 = Date.now();
    const record = await blobstore.open(biggest.p);
    const sweepMs = Date.now() - t0;

    if (record.error) {
      skip(`the largest blob could not be read (${record.error})`);
    } else {
      note(`swept ${record.objects.length} objects in ${sweepMs} ms`);

      check(!('buf' in record), 'the stored record does not carry the file buffer',
        Object.keys(record).join(','));
      check(record.objects.length > 0, 'the sweep found objects');
      check(record.objects.every(o => o.microcode === null),
        'and no object carries its microcode');

      // Resident memory right after a large read is not a retention measurement - the
      // allocator has not handed the pages back yet and there is no reliable way to make it
      // from here (global.gc needs a flag this runner does not pass). What can be measured,
      // and what actually matters, is whether browsing MORE files costs more: if buffers were
      // retained, RSS would climb with the running total of file sizes. It should plateau.
      const readable = [];
      let bytes = biggest.size;
      for (const b of blobs.slice(1)) {
        const r = await blobstore.open(b.p);
        if (r.error) continue;
        readable.push(b);
        bytes += b.size;
        if (readable.length >= 5) break;
      }
      const after = rssMB();
      const swept = readable.length + 1;
      note(`swept ${swept} files totalling ${(bytes / MB).toFixed(1)} MB of blob`);
      note(`resident memory ${before.toFixed(1)} -> ${after.toFixed(1)} MB ` +
        `(delta ${(after - before).toFixed(1)} MB)`);

      if (swept < 2) {
        skip('only one readable blob - cannot show that browsing more costs no more');
      } else {
        // Retaining every buffer would put the delta near the running total. Not retaining
        // them puts it near the largest single file, whatever the total.
        check(after - before < bytes / MB * 0.75,
          'browsing several files costs far less than their combined size',
          `${(after - before).toFixed(1)} MB for ${(bytes / MB).toFixed(1)} MB of blob ` +
          `across ${swept} files`);
        check(blobstore.all().every(r => !('buf' in r)),
          'and not one loaded record holds a buffer');
      }
      for (const b of readable) blobstore.close(b.p);

      section('3. Materialising on demand');
      const target = [...record.objects].sort((a, b) => b.codeBytes - a.codeBytes)[0];
      const t1 = Date.now();
      const carved = await blobstore.withBuffer(record, async loaded => {
        check(!!loaded.buf && loaded.buf.length > 0, 'the file is re-read when needed');
        check(loaded.source === record.source && loaded.backend === record.backend &&
              loaded.label === record.label && 'scanned' in loaded,
          'the rebuilt record carries everything disassembly and the banner read',
          Object.keys(loaded).join(','));
        return nvcache.carveAt(loaded.buf, target.offset, {
          source: loaded.source, backend: loaded.backend
        });
      });
      const readCarveMs = Date.now() - t1;

      check(carved && carved.sha1 === target.sha1,
        're-reading and carving reproduces the object the sweep recorded',
        carved ? `${carved.sha1} vs ${target.sha1}` : 'null');
      note(`read + carve of the largest object (${target.codeBytes} B): ${readCarveMs} ms`);
      check(readCarveMs < 2000,
        'and is cheap next to the seconds nvdisasm then spends', `${readCarveMs} ms`);

      section('4. One buffer at a time');
      {
        // Two concurrent holders must not both have a buffer loaded.
        let concurrent = 0;
        let peak = 0;
        const hold = () => blobstore.withBuffer(record, async () => {
          concurrent++;
          peak = Math.max(peak, concurrent);
          await new Promise(r => setTimeout(r, 40));
          concurrent--;
        });
        await Promise.all([hold(), hold(), hold()]);
        check(peak === 1, 'concurrent requests serialise onto one buffer slot', `peak ${peak}`);
      }
      {
        // A thrown callback must not wedge the slot for everyone after it.
        let threw = false;
        try {
          await blobstore.withBuffer(record, async () => { throw new Error('boom'); });
        } catch (e) { threw = e.message === 'boom'; }
        check(threw, 'an error inside the callback propagates');
        const stillWorks = await blobstore.withBuffer(record, async l => l.buf.length > 0);
        check(stillWorks === true, 'and the slot is released, not wedged');
      }

      section('5. Records');
      {
        const again = await blobstore.open(biggest.p);
        check(again === record, 'opening an unchanged file reuses its record');

        check(blobstore.has(biggest.p), 'the file is listed');
        check(blobstore.all().length === 1, 'exactly one file is listed',
          String(blobstore.all().length));

        blobstore.markStale();
        check(blobstore.get(biggest.p).stale === true, 'settings changes mark records stale');

        await blobstore.checkStamps();
        check(blobstore.get(biggest.p).stale === false,
          'and a stamp check clears it when the file really is unchanged');

        blobstore.closeAll();
        check(blobstore.all().length === 0, 'closing everything empties the list');
      }

      section('6. A file that cannot be read');
      {
        const missing = path.join(os.tmpdir(), 'definitely-not-here.bin');
        const bad = await blobstore.open(missing);
        check(!!bad.error, 'a missing file produces a record carrying the error, not a throw',
          bad.error);
        check(bad.objects.length === 0, 'with no objects');
        blobstore.closeAll();
      }
    }
  }

  section('7. The list is bounded');
  {
    // Synthetic files, so this runs the same way on a machine with no cache at all. A file
    // that yields no objects still produces a record, which is all the LRU cares about.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nvisa-lru-'));
    const made = [];
    for (let i = 0; i < 4; i++) {
      const f = path.join(dir, `blob${i}.bin`);
      fs.writeFileSync(f, Buffer.alloc(64, i));
      made.push(f);
    }
    settings.nvIsaExtractor['tree.maxBlobs'] = 2;
    for (const f of made) await blobstore.open(f);

    check(blobstore.all().length === 2, 'no more than maxBlobs files stay loaded',
      String(blobstore.all().length));
    check(!blobstore.has(made[0]) && !blobstore.has(made[1]),
      'the least recently used were the ones evicted');
    check(blobstore.has(made[3]), 'the most recent is kept');

    // Touching a file must make it recent again, or the bound evicts what you are using.
    await blobstore.open(made[2]);
    await blobstore.open(made[0]);
    check(blobstore.has(made[2]) && blobstore.has(made[0]) && !blobstore.has(made[3]),
      're-opening a loaded file makes it recent again');

    settings.nvIsaExtractor['tree.maxBlobs'] = 8;
    blobstore.closeAll();
    fs.rmSync(dir, { recursive: true, force: true });
  }

  section('8. Sweep still keeps the buffer when asked');
  {
    // The existing single-shot command path relies on the default.
    const src = String(pipeline.sweep);
    check(/keepBuffer\s*=\s*true/.test(src), 'keepBuffer defaults to true for existing callers');
  }

  console.log(`\n${failures ? 'FAIL' : 'PASS'}  ${checks} checks, ${failures} failures, ` +
    `${skipped} skipped`);
  process.exit(failures ? 1 : 0);
})().catch(e => {
  console.log(`\nFAIL  ${e && e.stack ? e.stack : e}`);
  process.exit(1);
});
