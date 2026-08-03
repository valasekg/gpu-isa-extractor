'use strict';

/**
 * The Shader Objects view and the commands behind it, against a stubbed VS Code.
 *
 * The tree is the part of this extension with the least margin for a silent mistake: a bad
 * node id costs you your expansion state, a missing `getParent` makes reveal throw, and a
 * command that resolves the wrong file just does the wrong thing quietly. None of that shows
 * up in a manifest check, so it is exercised here.
 *
 * The most important case in the file is `resolveTarget` from a tab: a binary file has no
 * TextDocument at all, so the obvious `window.activeTextEditor` route silently does nothing.
 *
 *   ELECTRON_RUN_AS_NODE=1 Code.exe tools/test_browser.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

let checks = 0;
let failures = 0;

function check(condition, what, detail = '') {
  checks++;
  if (condition) return;
  failures++;
  console.log(`  FAIL  ${what}`);
  if (detail) console.log(`        ${String(detail).split('\n').slice(0, 6).join('\n        ')}`);
}

function section(title) { console.log(`\n${title}`); }

/* --------------------------------------------------------- the vscode stub --- */

const settings = {
  nvIsaExtractor: {
    nvdisasmPath: '', arch: 'auto', minCodeBytes: 0, glcacheMode: 'auto',
    decodeControlCodes: true, keepRawMicrocode: false,
    'output.location': 'temp', 'output.retentionDays': 30,
    'tree.maxBlobs': 8, 'tree.sortBy': 'size', 'tree.autoGroupThreshold': 200,
    'tree.pageSize': 500, 'batch.confirmAboveBytes': 268435456
  },
  nvidiaSass: { semanticHighlighting: true, semanticMaxLines: 100000 }
};

const contextKeys = {};
let activeTab = null;
let openDialogResult = null;
let dialogCalls = 0;

class ThemeIcon { constructor(id, color) { this.id = id; this.color = color; } }
class ThemeColor { constructor(id) { this.id = id; } }
class MarkdownString {
  constructor(v) { this.value = v || ''; }
  appendMarkdown(v) { this.value += v; return this; }
}
class TreeItem {
  constructor(label, collapsibleState) {
    this.label = label;
    this.collapsibleState = collapsibleState;
  }
}

const vscodeStub = {
  version: '0.0.0-test',
  Uri: { file: p => ({ fsPath: p, scheme: 'file', path: p.replace(/\\/g, '/') }) },
  ProgressLocation: { Notification: 15, Window: 10 },
  TreeItem,
  ThemeIcon,
  ThemeColor,
  MarkdownString,
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  EventEmitter: class {
    constructor() {
      this._ls = new Set();
      this.event = l => { this._ls.add(l); return { dispose: () => this._ls.delete(l) }; };
    }
    fire(v) { for (const l of this._ls) l(v); }
    dispose() { this._ls.clear(); }
  },
  workspace: {
    textDocuments: [],
    getConfiguration(sectionName) {
      const bag = settings[sectionName] || {};
      return { get: (key, fallback) => (key in bag ? bag[key] : fallback) };
    },
    async openTextDocument(uri) { return { uri, languageId: 'nvidia-sass' }; },
    onDidChangeConfiguration() { return { dispose() {} }; }
  },
  window: {
    activeTextEditor: undefined,
    visibleTextEditors: [],
    tabGroups: {
      get activeTabGroup() { return { activeTab }; },
      onDidChangeTabs() { return { dispose() {} }; }
    },
    async withProgress(_o, task) {
      return task({ report() {} }, {
        isCancellationRequested: false,
        onCancellationRequested() { return { dispose() {} }; }
      });
    },
    async showOpenDialog() { dialogCalls++; return openDialogResult; },
    async showTextDocument() {},
    showWarningMessage() { return Promise.resolve(undefined); },
    showErrorMessage() { return Promise.resolve(undefined); },
    showInformationMessage() { return Promise.resolve(undefined); },
    createOutputChannel() { return { appendLine() {}, clear() {}, show() {}, dispose() {} }; },
    onDidChangeActiveTextEditor() { return { dispose() {} }; }
  },
  languages: { async setTextDocumentLanguage() {} },
  extensions: { getExtension: () => null },
  commands: {
    registerCommand() { return { dispose() {} }; },
    async executeCommand(name, key, value) {
      if (name === 'setContext') contextKeys[key] = value;
      return undefined;
    }
  }
};

const realResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'vscode') return 'vscode';
  return realResolve.call(this, request, ...rest);
};
require.cache.vscode = { id: 'vscode', filename: 'vscode', loaded: true, exports: vscodeStub };

const tree = require(path.join(__dirname, '..', 'src', 'tree.js'));
const browser = require(path.join(__dirname, '..', 'src', 'browser.js'));
const blobstore = require(path.join(__dirname, '..', 'src', 'blobstore.js'));
const review = require(path.join(__dirname, '..', 'src', 'review.js'));

/* ------------------------------------------------------------- fake records --- */

const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'nvisa-browser-'));
const context = { globalStorageUri: { fsPath: storage } };

const memento = {};
review.load({
  get: k => memento[k],
  update: (k, v) => { memento[k] = v; return Promise.resolve(); }
});

/** A record shaped exactly as blobstore.open produces one, without touching a real cache. */
function fakeRecord(name, objects, extra = {}) {
  const source = path.join(storage, name);
  return {
    key: blobstore.keyFor(source),
    source,
    backend: 'vk',
    label: 'GLCache blob',
    scanned: false,
    minCode: 0,
    objects,
    stats: {},
    frames: objects.length,
    stamp: '1:1',
    stale: false,
    error: null,
    ...extra
  };
}

function fakeObject(i, { name = null, codeBytes = 4096, sha1 = null, offset = null } = {}) {
  const hash = sha1 || `${String(i).padStart(2, '0')}`.repeat(20).slice(0, 40);
  return {
    source: 'x.bin', offset: offset === null ? i * 1000 : offset, backend: 'vk',
    name, microcode: null, codeBytes,
    instructions: Math.floor(codeBytes / 16), sha1: hash, warnings: []
  };
}

/**
 * A stand-in for the blobstore holding whatever records a test wants.
 *
 * Both the provider and the command handlers take their record source as a parameter, so the
 * view can be driven over shapes that would need a very particular shader cache to produce -
 * ten thousand objects, a file that failed to read, a shader stored at three offsets.
 */
const fakeStore = {
  records: [],
  listeners: new Set(),
  all() { return this.records; },
  get(p) { return this.records.find(r => r.key === blobstore.keyFor(p)); },
  close(p) { this.records = this.records.filter(r => r.key !== blobstore.keyFor(p)); },
  closeAll() { this.records = []; },
  async open() { return this.records[0]; },
  async checkStamps() { return false; },
  async withBuffer(record, fn) { return fn({ buf: Buffer.alloc(0), ...record }); },
  onDidChange(l) { this.listeners.add(l); return { dispose: () => this.listeners.delete(l) }; }
};

function loadRecords(records) {
  fakeStore.records = records;
  for (const l of fakeStore.listeners) l();
}

(async () => {
  section('1. resolveTarget - reaching an already-open file');
  {
    const blobPath = path.join(storage, 'cache.bin');
    fs.writeFileSync(blobPath, Buffer.alloc(16));

    // 1: an explicit resource, as the explorer and the editor title bar both pass.
    const fromArg = await browser.resolveTarget(vscodeStub.Uri.file(blobPath));
    check(fromArg && fromArg.fsPath === blobPath, 'an explicit resource is used as given');
    check(dialogCalls === 0, 'and no dialog is opened');

    // A tree node also arrives at these handlers. It must not be mistaken for a resource.
    activeTab = null;
    openDialogResult = null;
    const fromNode = await browser.resolveTarget({ kind: 'nvObject', object: {} });
    check(fromNode === null && dialogCalls === 1,
      'a tree node is not mistaken for a file and falls through to the dialog');

    // 2: THE case that matters. A .bin has no TextDocument, so activeTextEditor is undefined
    // and only the tab knows the file.
    dialogCalls = 0;
    activeTab = { input: { uri: vscodeStub.Uri.file(blobPath) } };
    vscodeStub.window.activeTextEditor = undefined;
    const fromTab = await browser.resolveTarget(undefined);
    check(fromTab && fromTab.fsPath === blobPath,
      'the active tab is used when no resource was passed - this is what makes an ' +
      'already-open binary file reachable');
    check(dialogCalls === 0, 'and still no dialog');

    // A tab holding something else must not be swept.
    activeTab = { input: { uri: vscodeStub.Uri.file(path.join(storage, 'notes.txt')) } };
    openDialogResult = null;
    const fromWrongTab = await browser.resolveTarget(undefined);
    check(fromWrongTab === null && dialogCalls === 1,
      'a tab holding an unrelated file falls through to the dialog');

    // Editor kinds VS Code does not model report no input at all.
    dialogCalls = 0;
    activeTab = { input: undefined };
    await browser.resolveTarget(undefined);
    check(dialogCalls === 1, 'a tab with no modelled input does not throw');

    activeTab = { input: { uri: vscodeStub.Uri.file(blobPath) } };
    check(browser.activeTabIsBlob() === true, 'a cache file in the active tab is recognised');
    activeTab = null;
    check(browser.activeTabIsBlob() === false, 'and no tab means no active blob');
  }

  section('2. The tree');
  const provider = new tree.ShaderObjectsProvider(context, fakeStore);
  const view = {
    selection: [], badge: undefined, description: undefined, message: undefined,
    async reveal() {}
  };
  browser.init({ context, provider, view, store: fakeStore, log: () => {} });

  {
    const objects = [
      fakeObject(1, { name: 'evalGridTex', codeBytes: 2 * 1024 * 1024 }),
      fakeObject(2, { name: 'colorize', codeBytes: 64 * 1024 }),
      fakeObject(3, { codeBytes: 4096 })
    ];
    loadRecords([fakeRecord('a.bin', objects)]);

    const roots = provider.getChildren();
    check(roots.length === 1 && roots[0].kind === 'nvFile', 'one loaded file, one root node');

    const fileItem = provider.getTreeItem(roots[0]);
    check(fileItem.label === 'a.bin', 'the root is labelled with the file name', fileItem.label);
    check(/3 shaders/.test(fileItem.description), 'and counts its shaders',
      fileItem.description);
    check(fileItem.contextValue === 'nvFile', 'with a context value the menus can match');

    const children = provider.getChildren(roots[0]);
    check(children.length === 3 && children.every(c => c.kind === 'nvObject'),
      'the file expands to its shaders', children.map(c => c.kind).join(','));
    check(children[0].object.codeBytes === 2 * 1024 * 1024,
      'largest first by default', String(children[0].object.codeBytes));

    const objItem = provider.getTreeItem(children[0]);
    check(objItem.label === 'evalGridTex', 'a shader is labelled with its entry point');
    check(/instr/.test(objItem.description), 'and described by size', objItem.description);
    check(objItem.command && objItem.command.command === 'nvIsaExtractor.openObject',
      'clicking a shader opens its listing');
    check(provider.getTreeItem(children[2]).label === '(unnamed)',
      'an unnamed shader still gets a label');

    // Ids must be stable and unique - VS Code loses expansion state without them.
    const ids = children.map(c => c.id);
    check(new Set(ids).size === ids.length, 'node ids are unique', ids.join(' '));
    check(ids.every(id => typeof id === 'string' && id.length),
      'and every node has one');
    const again = provider.getChildren(provider.getChildren()[0]).map(c => c.id);
    check(JSON.stringify(ids) === JSON.stringify(again),
      'and they are stable across rebuilds');

    check(provider.getParent(children[0]) === roots[0], 'getParent walks back up - reveal() needs it');

    const resolved = provider.resolveTreeItem(objItem, children[0]);
    check(resolved.tooltip && resolved.tooltip.value.includes(children[0].object.sha1),
      'the tooltip carries the full sha1');
    check(!/reviewed/i.test(resolved.tooltip.value),
      'and nothing mutable - tooltips resolve once and would go stale');
  }

  section('3. Duplicate copies');
  {
    const shared = 'ab'.repeat(20);
    const objects = [
      fakeObject(1, { name: 'shared', sha1: shared, offset: 100 }),
      fakeObject(2, { name: 'shared', sha1: shared, offset: 200 }),
      fakeObject(3, { name: 'shared', sha1: shared, offset: 300 }),
      fakeObject(4, { name: 'other' })
    ];
    loadRecords([fakeRecord('dup.bin', objects)]);

    const rows = provider.getChildren(provider.getChildren()[0]);
    check(rows.length === 2, 'identical shaders collapse to one row', String(rows.length));

    const dup = rows.find(r => r.object.copies.length > 1);
    check(dup && dup.object.copies.length === 3, 'which knows all its copies');
    const dupItem = provider.getTreeItem(dup);
    check(/×3/.test(dupItem.description), 'and says how many', dupItem.description);
    check(dupItem.contextValue.includes('.dup'), 'and marks itself as duplicated',
      dupItem.contextValue);

    const copies = provider.getChildren(dup);
    check(copies.length === 3 && copies.every(c => c.kind === 'nvCopy'),
      'expanding shows each offset');
    check(provider.getTreeItem(copies[0]).label.includes('100'),
      'labelled by where it sits', provider.getTreeItem(copies[0]).label);
    // Every offset must survive: they are the thing being browsed.
    const offsets = copies.map(c => c.copy.offset).sort((a, b) => a - b);
    check(JSON.stringify(offsets) === '[100,200,300]', 'no copy is discarded',
      JSON.stringify(offsets));
  }

  section('4. Review marks');
  {
    await review.clear();
    const objects = [fakeObject(1, { name: 'a' }), fakeObject(2, { name: 'b' })];
    loadRecords([fakeRecord('r.bin', objects)]);
    const rows = provider.getChildren(provider.getChildren()[0]);

    check(!provider.getTreeItem(rows[0]).contextValue.includes('reviewed'),
      'a shader starts unreviewed');
    await browser.toggleReviewed(rows[0]);
    check(provider.getTreeItem(rows[0]).contextValue.includes('.reviewed'),
      'marking one shows in its context value');
    check(provider.getTreeItem(rows[0]).iconPath.id === 'check',
      'and in its icon - mutable state lives here, not in the tooltip');

    browser.updateViewChrome();
    check(view.badge && view.badge.value === 1,
      'the badge counts what is left to review', JSON.stringify(view.badge));

    await browser.toggleReviewed(rows[0]);
    check(!provider.getTreeItem(rows[0]).contextValue.includes('reviewed'), 'and unmarking');

    // A mark follows the shader, not the offset - the driver moves objects constantly.
    await browser.toggleReviewed(rows[0]);
    const movedSha = rows[0].object.sha1;
    loadRecords([fakeRecord('r.bin', [
      fakeObject(9, { name: 'a', sha1: movedSha, offset: 999999 })
    ])]);
    const movedRows = provider.getChildren(provider.getChildren()[0]);
    check(provider.getTreeItem(movedRows[0]).contextValue.includes('.reviewed'),
      'a review mark survives the object moving to a new offset');
    await review.clear();
  }

  section('5. Grouping, paging and filtering at scale');
  {
    const many = [];
    for (let i = 0; i < 600; i++) {
      many.push(fakeObject(i, {
        name: i % 3 === 0 ? `ps_shader_${i}` : null,
        codeBytes: (i % 5 + 1) * 100 * 1024,
        // Distinct in their leading bytes, the way real hashes are - a zero-padded index
        // would give every object the same 8-character prefix and make a prefix filter
        // look broken when it is working.
        sha1: ((i * 2654435761) >>> 0).toString(16).padStart(8, '0').repeat(5)
      }));
    }
    loadRecords([fakeRecord('big.bin', many)]);
    settings.nvIsaExtractor['tree.autoGroupThreshold'] = 200;

    const groups = provider.getChildren(provider.getChildren()[0]);
    check(groups.every(g => g.kind === 'nvGroup'),
      'a file past the threshold groups into size buckets',
      groups.map(g => g.kind).join(','));
    check(groups.length >= 2 && groups.length <= tree.BUCKETS.length,
      'with empty buckets omitted', String(groups.length));
    const total = groups.reduce((n, g) => n + g.objects.length, 0);
    check(total === 600, 'and every shader lands in exactly one bucket', String(total));

    settings.nvIsaExtractor['tree.autoGroupThreshold'] = 1000;
    settings.nvIsaExtractor['tree.pageSize'] = 100;
    provider.refresh();
    const firstPage = provider.getChildren(provider.getChildren()[0]);
    check(firstPage.length === 101 && firstPage[100].kind === 'nvMore',
      'a long flat level is paged with a Load more row',
      `${firstPage.length} rows, last is ${firstPage[firstPage.length - 1].kind}`);
    check(/showing 100 of 600/.test(provider.getTreeItem(firstPage[100]).description),
      'that says how far it got', provider.getTreeItem(firstPage[100]).description);

    provider.loadMore(firstPage[100]);
    const secondPage = provider.getChildren(provider.getChildren()[0]);
    check(secondPage.length === 201, 'and loads another page on demand',
      String(secondPage.length));

    // Walking must not be limited by paging.
    check(provider.visibleObjects().length === 600,
      'the walk order covers every shader regardless of paging',
      String(provider.visibleObjects().length));

    provider.setFilter('ps_shader_1');
    const filtered = provider.visibleObjects();
    check(filtered.length > 0 && filtered.every(n => /ps_shader_1/.test(n.object.name || '')),
      'a name filter narrows the walk', String(filtered.length));

    provider.setFilter(String(many[7].offset));
    check(provider.visibleObjects().length === 1, 'an offset filter finds one shader',
      String(provider.visibleObjects().length));

    provider.setFilter(many[9].sha1.slice(0, 8));
    check(provider.visibleObjects().length === 1, 'and so does a sha1 prefix');

    provider.setFilter('nothing-matches-this');
    const empty = provider.getChildren(provider.getChildren()[0]);
    check(empty.length === 1 && empty[0].kind === 'nvDiag',
      'an empty filter result explains itself instead of showing nothing',
      empty.map(e => e.kind).join(','));

    provider.setFilter('');
    settings.nvIsaExtractor['tree.pageSize'] = 500;
    settings.nvIsaExtractor['tree.autoGroupThreshold'] = 200;
  }

  section('6. Sort order');
  {
    const objects = [
      fakeObject(1, { name: 'zeta', codeBytes: 1024, offset: 900 }),
      fakeObject(2, { name: 'alpha', codeBytes: 8192, offset: 100 }),
      fakeObject(3, { name: 'mid', codeBytes: 4096, offset: 500 })
    ];
    loadRecords([fakeRecord('sort.bin', objects)]);

    const names = () => provider.getChildren(provider.getChildren()[0])
      .map(n => n.object.name).join(',');

    settings.nvIsaExtractor['tree.sortBy'] = 'size';
    provider.refresh();
    check(names() === 'alpha,mid,zeta', 'size sorts largest first', names());

    settings.nvIsaExtractor['tree.sortBy'] = 'offset';
    provider.refresh();
    check(names() === 'alpha,mid,zeta', 'offset sorts in file order', names());

    settings.nvIsaExtractor['tree.sortBy'] = 'name';
    provider.refresh();
    check(names() === 'alpha,mid,zeta', 'name sorts alphabetically', names());

    settings.nvIsaExtractor['tree.sortBy'] = 'size';
  }

  section('7. Empty and broken files');
  {
    loadRecords([fakeRecord('empty.bin', [], { frames: 12, minCode: 65536 })]);
    const rows = provider.getChildren(provider.getChildren()[0]);
    check(rows.every(r => r.kind === 'nvDiag'), 'an empty sweep explains itself in the tree');
    check(rows.some(r => /size floor/.test(r.text)), 'naming the size floor as a cause',
      rows.map(r => r.text).join(' | '));
    const actionable = rows.find(r => r.action === 'minCode');
    check(actionable && provider.getTreeItem(actionable).command,
      'and offering to open the setting');

    loadRecords([fakeRecord('broken.bin', [], { error: 'held open by the driver' })]);
    const errRows = provider.getChildren(provider.getChildren()[0]);
    check(errRows.length === 1 && /held open/.test(errRows[0].text),
      'an unreadable file reports why');
    const errItem = provider.getTreeItem(provider.getChildren()[0]);
    check(errItem.contextValue === 'nvFile.error', 'and marks the file as failed',
      errItem.contextValue);
  }

  section('8. Context keys');
  {
    loadRecords([fakeRecord('ctx.bin', [fakeObject(1, { name: 'x' })])]);
    activeTab = null;
    await browser.syncContext();
    check(contextKeys['nvIsaExtractor.hasBlob'] === true, 'hasBlob tracks the loaded files');
    check(contextKeys['nvIsaExtractor.activeBlob'] === false, 'activeBlob tracks the tab');

    loadRecords([]);
    await browser.syncContext();
    check(contextKeys['nvIsaExtractor.hasBlob'] === false, 'and clears when nothing is loaded');
  }

  fs.rmSync(storage, { recursive: true, force: true });
  console.log(`\n${failures ? 'FAIL' : 'PASS'}  ${checks} checks, ${failures} failures`);
  process.exit(failures ? 1 : 0);
})().catch(e => {
  console.log(`\nFAIL  ${e && e.stack ? e.stack : e}`);
  process.exit(1);
});
