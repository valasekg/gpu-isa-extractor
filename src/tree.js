'use strict';

/**
 * The Shader Objects view: every shader in every loaded cache file, as a tree.
 *
 * A cache file holds hundreds of compiled shaders and there is no index naming them, so
 * going through them one at a time was the thing the extension made hardest. This is the
 * surface that fixes it - the list persists while you read a listing, remembers which
 * shaders you have already been through, and lets you walk them in order.
 *
 * Node kinds:
 *
 *   nvFile    one loaded cache file
 *   nvGroup   a size bucket, only when a file holds more objects than are readable flat
 *   nvObject  one distinct shader (by microcode sha1)
 *   nvCopy    one of the several offsets an identical shader was stored at
 *   nvMore    the "Load More" sentinel that bounds a very long level
 *   nvDiag    why a sweep found nothing, and what to do about it
 *
 * Two rules worth stating because both have bitten:
 *
 * 1. Every node has an explicit, stable `id`. Without one VS Code derives item handles from
 *    labels, and expansion and selection are lost whenever a label changes - which here is
 *    every time a review mark flips.
 * 2. `resolveTreeItem` runs at most once per item, so a tooltip that mentions mutable state
 *    goes stale and stays stale. Tooltips therefore carry only immutable facts; everything
 *    that changes lives in the icon and the description.
 */

const path = require('path');
const vscode = require('vscode');

const blobstore = require('./blobstore');
const review = require('./review');
const nvcache = require('./nvcache');

const VIEW_ID = 'nvIsaExtractor.objects';

/** Size buckets, largest first. A file past the flat threshold is split across these. */
const BUCKETS = [
  { key: 'xl', min: 1024 * 1024, label: '1 MB and larger' },
  { key: 'l', min: 256 * 1024, label: '256 KB to 1 MB' },
  { key: 'm', min: 64 * 1024, label: '64 KB to 256 KB' },
  { key: 's', min: 8 * 1024, label: '8 KB to 64 KB' },
  { key: 'xs', min: 0, label: 'under 8 KB' }
];

/** Split a generated listing's filename into its sha1 and architecture fields, or null. */
const LISTING_NAME_RE = /^(.*)\.([0-9a-f]{8})\.([^.]+)\.nvsass$/i;

/**
 * The listing on disk for this shader, or null.
 * @param {Set<string>} names   filenames, as `output.listingIndex` returns them
 * @param {?string} arch        the architecture in use, when it is known
 */
function findListingName(names, obj, arch) {
  const wanted = obj.sha1.slice(0, 8).toLowerCase();
  let loose = null;
  for (const name of names) {
    const m = LISTING_NAME_RE.exec(name);
    if (!m || m[2].toLowerCase() !== wanted) continue;
    if (!arch || m[3].toLowerCase() === String(arch).toLowerCase()) return name;
    loose = loose || name;
  }
  // A listing for a different architecture is not this one, but saying so is the caller's
  // business - report nothing rather than the wrong file.
  return arch ? null : loose;
}

function humanBytes(n) {
  if (n >= 1024 * 1024 * 1024) return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(2)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

function settings() {
  return vscode.workspace.getConfiguration('nvIsaExtractor');
}

/** Distinct shaders in a file, each carrying every offset it was stored at. */
function distinctObjects(record) {
  const bySha = new Map();
  for (const obj of record.objects) {
    const existing = bySha.get(obj.sha1);
    if (existing) {
      existing.copies.push(obj);
      if (!existing.name && obj.name) existing.name = obj.name;
    } else {
      bySha.set(obj.sha1, { ...obj, copies: [obj] });
    }
  }
  return [...bySha.values()];
}

function sortObjects(objects) {
  const by = settings().get('tree.sortBy') || 'size';
  const sorted = [...objects];
  if (by === 'offset') sorted.sort((a, b) => a.offset - b.offset);
  else if (by === 'name') {
    sorted.sort((a, b) => (a.name || '￿').localeCompare(b.name || '￿') ||
      b.codeBytes - a.codeBytes);
  } else sorted.sort((a, b) => b.codeBytes - a.codeBytes || a.offset - b.offset);
  return sorted;
}

function matchesFilter(obj, filter) {
  if (!filter) return true;
  const needle = filter.toLowerCase();
  if (obj.name && obj.name.toLowerCase().includes(needle)) return true;
  if (obj.sha1.startsWith(needle)) return true;
  // A stage, by either its name or its short label - "pixel" and "ps" both work.
  const meta = obj.metadata;
  if (meta && meta.stage) {
    if (meta.stage === needle) return true;
    if ((nvcache.STAGE_LABELS[meta.stage] || '').toLowerCase() === needle) return true;
  }
  if (/^(0x)?[0-9a-f]+$/i.test(filter)) {
    const wanted = filter.toLowerCase().startsWith('0x')
      ? parseInt(filter, 16) : Number(filter);
    if (Number.isFinite(wanted) && obj.copies.some(c => c.offset === wanted)) return true;
  }
  return false;
}

class ShaderObjectsProvider {
  /**
   * @param {*} context  the extension context
   * @param {*} store    where loaded cache files come from; defaults to the real blobstore.
   *   Taking it as a parameter is what lets the view be exercised against fabricated records
   *   without a shader cache to hand.
   */
  constructor(context, store = blobstore) {
    this.context = context;
    this.store = store;
    this._onDidChangeTreeData = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChangeTreeData.event;

    this.filter = '';
    /** Which page each expandable level has been asked to show, keyed by node id. */
    this.pages = new Map();
    /** Listing filenames already on disk, refreshed with the tree. */
    this.listings = new Set();
    /** The architecture listings are being generated for, once something has resolved it. */
    this.arch = null;
    /** Node id -> node, so commands and reveal() can find a node again. */
    this.nodes = new Map();

    this.subscriptions = [
      // A different set of objects invalidates how far each level was paged.
      this.store.onDidChange(() => this.refresh()),
      // A review mark does not. Clearing the paging here would snap a level the user had
      // expanded with "Load more" back to its first page every time they marked a shader -
      // in the middle of exactly the pass this view exists to support.
      review.onDidChange(() => this.redraw())
    ];
  }

  dispose() {
    for (const s of this.subscriptions) s.dispose();
    this._onDidChangeTreeData.dispose();
  }

  /** Rebuild, discarding how far each level was paged. */
  refresh(node) {
    if (!node) this.pages.clear();
    this._onDidChangeTreeData.fire(node);
  }

  /** Re-render what is already there, keeping every level's paging. */
  redraw(node) {
    this._onDidChangeTreeData.fire(node);
  }

  setFilter(text) {
    this.filter = (text || '').trim();
    this.pages.clear();
    this._onDidChangeTreeData.fire();
  }

  setListings(names, arch) {
    this.listings = names || new Set();
    if (arch !== undefined) this.arch = arch;
    this.redraw();
  }

  /**
   * Whether a listing for this shader is already on disk.
   *
   * `listingName` is `<entry>.<sha1[0:8]>.<arch>.nvsass`, and an entry name may itself contain
   * dots - so the sha1 has to be matched as the second-to-last dotted field, not merely found
   * somewhere in the string. A shader called `vs_main.deadbeef.opt` would otherwise be
   * mistaken for the listing of any shader whose hash starts `deadbeef`, and clicking that
   * shader would open somebody else's disassembly.
   *
   * The architecture is matched too when it is known, so changing `nvIsaExtractor.arch` does
   * not keep serving listings built for the old one.
   */
  hasListing(obj) {
    return findListingName(this.listings, obj, this.arch) !== null;
  }

  getNode(id) {
    return this.nodes.get(id);
  }

  remember(node) {
    this.nodes.set(node.id, node);
    return node;
  }

  getParent(node) {
    return node ? node.parent || null : null;
  }

  // ------------------------------------------------------------------- children

  getChildren(node) {
    if (!node) return this.rootNodes();
    if (node.kind === 'nvFile') return this.fileChildren(node);
    if (node.kind === 'nvGroup') return this.paged(node, node.objects, node);
    if (node.kind === 'nvObject') return this.copyChildren(node);
    return [];
  }

  rootNodes() {
    this.nodes.clear();
    const records = this.store.all();
    return records.map(record => this.remember({
      kind: 'nvFile',
      id: `f:${record.key}`,
      record,
      parent: null
    }));
  }

  fileChildren(node) {
    const record = node.record;
    if (record.error) {
      return [this.remember({
        kind: 'nvDiag', id: `${node.id}/diag:error`, parent: node,
        text: record.error, action: null
      })];
    }

    const all = distinctObjects(record).filter(o => matchesFilter(o, this.filter));
    if (!all.length) return this.diagnoseEmpty(node, record);

    const sorted = sortObjects(all);
    const threshold = Number(settings().get('tree.autoGroupThreshold'));
    if (Number.isFinite(threshold) && threshold > 0 && sorted.length > threshold) {
      return this.bucketChildren(node, sorted);
    }
    return this.paged(node, sorted, node);
  }

  bucketChildren(node, objects) {
    const buckets = new Map();
    for (const obj of objects) {
      const bucket = BUCKETS.find(b => obj.codeBytes >= b.min) || BUCKETS[BUCKETS.length - 1];
      if (!buckets.has(bucket.key)) buckets.set(bucket.key, []);
      buckets.get(bucket.key).push(obj);
    }
    return BUCKETS.filter(b => buckets.has(b.key)).map(b => {
      const members = buckets.get(b.key);
      return this.remember({
        kind: 'nvGroup',
        id: `${node.id}/g:${b.key}`,
        parent: node,
        label: b.label,
        objects: members,
        record: node.record
      });
    });
  }

  copyChildren(node) {
    if (node.object.copies.length < 2) return [];
    return node.object.copies.map((copy, i) => this.remember({
      kind: 'nvCopy',
      id: `${node.id}/c:${copy.offset}`,
      parent: node,
      copy,
      index: i,
      total: node.object.copies.length,
      record: node.record,
      object: node.object
    }));
  }

  /**
   * One level of objects, bounded.
   *
   * The tree itself is virtualised, so a long level is not a rendering problem - but the
   * array crosses to the workbench in one message, and ten thousand items in one array is
   * worth avoiding. Past the page size the level ends in a "Load More" row, the same shape
   * VS Code's own Timeline view uses.
   */
  paged(node, objects, record) {
    const pageSize = Number(settings().get('tree.pageSize'));
    const shown = Number.isFinite(pageSize) && pageSize > 0
      ? Math.min(objects.length, (this.pages.get(node.id) || 1) * pageSize)
      : objects.length;

    const items = objects.slice(0, shown).map(obj => this.remember({
      kind: 'nvObject',
      id: `${node.id}/o:${obj.sha1}:${obj.offset}`,
      parent: node,
      object: obj,
      record: record.record || record
    }));

    if (shown < objects.length) {
      items.push(this.remember({
        kind: 'nvMore',
        id: `${node.id}/more`,
        parent: node,
        shown,
        total: objects.length,
        target: node
      }));
    }
    return items;
  }

  loadMore(node) {
    const target = node.target || node;
    this.pages.set(target.id, (this.pages.get(target.id) || 1) + 1);
    this._onDidChangeTreeData.fire(target.kind === 'nvFile' || target.kind === 'nvGroup'
      ? target : undefined);
  }

  diagnoseEmpty(node, record) {
    const out = [];
    const skips = nvcache.describeSkips(record.stats);
    if (this.filter) {
      out.push({ text: `Nothing matches "${this.filter}"`, action: 'clearFilter' });
    } else {
      out.push({
        text: `No shader objects in ${record.frames} compressed frame(s)`,
        action: null
      });
      if (record.minCode) {
        out.push({
          text: `The size floor is ${humanBytes(record.minCode)} - lower it to see smaller objects`,
          action: 'minCode'
        });
      }
      if (record.backend === 'vk' && !record.scanned) {
        out.push({ text: 'Try scan mode, which ignores the .toc index', action: 'glcacheMode' });
      }
      for (const skip of skips) out.push({ text: skip, action: null });
    }
    return out.map((d, i) => this.remember({
      kind: 'nvDiag', id: `${node.id}/diag:${i}`, parent: node, text: d.text, action: d.action
    }));
  }

  // ------------------------------------------------------------------ tree items

  getTreeItem(node) {
    switch (node.kind) {
      case 'nvFile': return this.fileItem(node);
      case 'nvGroup': return this.groupItem(node);
      case 'nvObject': return this.objectItem(node);
      case 'nvCopy': return this.copyItem(node);
      case 'nvMore': return this.moreItem(node);
      default: return this.diagItem(node);
    }
  }

  fileItem(node) {
    const record = node.record;
    const item = new vscode.TreeItem(path.basename(record.source),
      vscode.TreeItemCollapsibleState.Expanded);
    item.id = node.id;
    item.resourceUri = vscode.Uri.file(record.source);

    if (record.error) {
      item.description = 'could not be read';
      item.iconPath = new vscode.ThemeIcon('error', new vscode.ThemeColor('errorForeground'));
      item.contextValue = 'nvFile.error';
      item.tooltip = record.error;
      return item;
    }

    const distinct = distinctObjects(record);
    const counts = review.counts(distinct);
    const bytes = distinct.reduce((n, o) => n + o.codeBytes, 0);
    const parts = [`${counts.total} shader${counts.total === 1 ? '' : 's'}`];
    if (counts.reviewed) parts.push(`${counts.reviewed} reviewed`);
    parts.push(humanBytes(bytes));
    parts.push(record.scanned ? `${record.label}, scanned` : record.label);
    if (record.stale) parts.push('changed on disk');
    item.description = parts.join('  ·  ');

    item.iconPath = record.stale
      ? new vscode.ThemeIcon('warning', new vscode.ThemeColor('problemsWarningIcon.foreground'))
      : new vscode.ThemeIcon('file-binary');
    item.contextValue = record.stale ? 'nvFile.stale' : 'nvFile';
    item.tooltip = new vscode.MarkdownString(
      `**${path.basename(record.source)}**\n\n` +
      `${record.source}\n\n` +
      `${record.label}${record.scanned ? ', found by magic scan' : ''}  \n` +
      `${record.frames} compressed frame(s), ${record.objects.length} object record(s)`);
    return item;
  }

  groupItem(node) {
    const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Collapsed);
    item.id = node.id;
    const counts = review.counts(node.objects);
    const bytes = node.objects.reduce((n, o) => n + o.codeBytes, 0);
    item.description = `${node.objects.length} shaders  ·  ${humanBytes(bytes)}` +
      (counts.reviewed ? `  ·  ${counts.reviewed} reviewed` : '');
    item.iconPath = new vscode.ThemeIcon('layers');
    item.contextValue = 'nvGroup';
    return item;
  }

  objectItem(node) {
    const obj = node.object;
    const reviewed = review.isReviewed(obj.sha1);
    const listed = this.hasListing(obj);

    const item = new vscode.TreeItem(obj.name || '(unnamed)',
      obj.copies.length > 1 ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None);
    item.id = node.id;

    const meta = obj.metadata;
    const parts = [];
    if (meta && meta.stage) parts.push(nvcache.STAGE_LABELS[meta.stage] || meta.stage);
    parts.push(`${obj.instructions.toLocaleString()} instr`);
    if (meta && meta.registers !== null) parts.push(`${meta.registers} regs`);
    if (meta && meta.localBytes) parts.push(`${humanBytes(meta.localBytes)} local`);
    if (meta && meta.sharedBytes) parts.push(`${humanBytes(meta.sharedBytes)} shared`);
    parts.push(humanBytes(obj.codeBytes));
    if (obj.copies.length > 1) parts.push(`×${obj.copies.length}`);
    item.description = parts.join('  ·  ');

    if (reviewed) {
      item.iconPath = new vscode.ThemeIcon('check', new vscode.ThemeColor('charts.green'));
    } else if (obj.warnings && obj.warnings.length) {
      item.iconPath = new vscode.ThemeIcon('warning',
        new vscode.ThemeColor('problemsWarningIcon.foreground'));
    } else if (listed) {
      item.iconPath = new vscode.ThemeIcon('file-code');
    } else {
      item.iconPath = new vscode.ThemeIcon('symbol-method');
    }

    item.contextValue = 'nvObject' +
      (obj.copies.length > 1 ? '.dup' : '') +
      (reviewed ? '.reviewed' : '') +
      (listed ? '.listed' : '') +
      ((obj.warnings && obj.warnings.length) ? '.warn' : '');

    item.command = {
      command: 'nvIsaExtractor.openObject',
      title: 'Open Listing',
      arguments: [node]
    };
    return item;
  }

  /**
   * Tooltips are resolved lazily and only once per item, so everything here has to be a fact
   * that cannot change while the view is open. Review state and whether a listing exists are
   * both mutable, and both live in the icon instead.
   */
  resolveTreeItem(item, node) {
    if (node.kind !== 'nvObject') return item;
    const obj = node.object;
    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**${obj.name || '(unnamed shader)'}**\n\n`);
    md.appendMarkdown(`|   |   |\n|---|---|\n`);
    const meta = obj.metadata;
    if (meta) {
      if (meta.stage) md.appendMarkdown(`| stage | ${meta.stage} shader |\n`);
      if (meta.registers !== null) {
        md.appendMarkdown(`| registers | ${meta.registers} declared` +
          (meta.registerCap !== null ? `, cap ${meta.registerCap}` : '') + ' |\n');
      }
      if (meta.localBytes !== null) {
        md.appendMarkdown(`| local memory | ${meta.localBytes.toLocaleString()} bytes |\n`);
      }
      if (meta.sharedBytes !== null) {
        md.appendMarkdown(`| shared memory | ${meta.sharedBytes.toLocaleString()} bytes |\n`);
      }
      if (meta.killsPixels) md.appendMarkdown(`| discards pixels | yes |\n`);
    }
    md.appendMarkdown(`| microcode | ${obj.codeBytes.toLocaleString()} bytes |\n`);
    md.appendMarkdown(`| instructions | ${obj.instructions.toLocaleString()} |\n`);
    md.appendMarkdown(`| sha1 | \`${obj.sha1}\` |\n`);
    md.appendMarkdown(`| source | ${path.basename(obj.source)} |\n`);
    md.appendMarkdown(`| backend | ${obj.backend === 'dx' ? 'DXCache (D3D12)' : 'GLCache (Vulkan/GL)'} |\n`);
    if (obj.copies.length > 1) {
      md.appendMarkdown(`| stored at | ${obj.copies.length} offsets: ` +
        obj.copies.slice(0, 6).map(c => `\`${c.offset}\``).join(', ') +
        (obj.copies.length > 6 ? ', …' : '') + ' |\n');
    } else {
      md.appendMarkdown(`| offset | \`${obj.offset}\` |\n`);
    }
    for (const warning of obj.warnings || []) md.appendMarkdown(`\n\n⚠ ${warning}`);
    item.tooltip = md;
    return item;
  }

  copyItem(node) {
    const item = new vscode.TreeItem(`offset ${node.copy.offset}`,
      vscode.TreeItemCollapsibleState.None);
    item.id = node.id;
    item.description = `copy ${node.index + 1} of ${node.total}`;
    item.iconPath = new vscode.ThemeIcon('versions');
    item.contextValue = 'nvCopy';
    item.command = {
      command: 'nvIsaExtractor.openObject', title: 'Open Listing', arguments: [node]
    };
    return item;
  }

  moreItem(node) {
    const item = new vscode.TreeItem('Load more…', vscode.TreeItemCollapsibleState.None);
    item.id = node.id;
    item.description = `showing ${node.shown.toLocaleString()} of ${node.total.toLocaleString()}`;
    item.iconPath = new vscode.ThemeIcon('ellipsis');
    item.contextValue = 'nvMore';
    item.command = {
      command: 'nvIsaExtractor.loadMore', title: 'Load more', arguments: [node]
    };
    return item;
  }

  diagItem(node) {
    const item = new vscode.TreeItem(node.text, vscode.TreeItemCollapsibleState.None);
    item.id = node.id;
    item.iconPath = new vscode.ThemeIcon('info');
    item.contextValue = 'nvDiag';
    if (node.action === 'minCode') {
      item.command = {
        command: 'workbench.action.openSettings', title: 'Open the setting',
        arguments: ['nvIsaExtractor.minCodeBytes']
      };
    } else if (node.action === 'glcacheMode') {
      item.command = {
        command: 'workbench.action.openSettings', title: 'Open the setting',
        arguments: ['nvIsaExtractor.glcacheMode']
      };
    } else if (node.action === 'clearFilter') {
      item.command = { command: 'nvIsaExtractor.filter', title: 'Change the filter' };
    }
    return item;
  }

  /**
   * Every object node in the order the view shows them, which is what next/previous walk.
   * Grouping, sorting and the filter all apply; paging deliberately does not, so a walk can
   * run past a "Load more" boundary.
   */
  visibleObjects() {
    const out = [];
    for (const record of this.store.all()) {
      if (record.error) continue;
      const fileId = `f:${record.key}`;
      const all = sortObjects(distinctObjects(record).filter(o => matchesFilter(o, this.filter)));
      const threshold = Number(settings().get('tree.autoGroupThreshold'));
      if (Number.isFinite(threshold) && threshold > 0 && all.length > threshold) {
        const buckets = new Map();
        for (const obj of all) {
          const bucket = BUCKETS.find(b => obj.codeBytes >= b.min) || BUCKETS[BUCKETS.length - 1];
          if (!buckets.has(bucket.key)) buckets.set(bucket.key, []);
          buckets.get(bucket.key).push(obj);
        }
        for (const bucket of BUCKETS) {
          if (!buckets.has(bucket.key)) continue;
          const groupId = `${fileId}/g:${bucket.key}`;
          for (const obj of buckets.get(bucket.key)) {
            out.push({ kind: 'nvObject', id: `${groupId}/o:${obj.sha1}:${obj.offset}`, object: obj, record });
          }
        }
      } else {
        for (const obj of all) {
          out.push({ kind: 'nvObject', id: `${fileId}/o:${obj.sha1}:${obj.offset}`, object: obj, record });
        }
      }
    }
    return out;
  }

  /**
   * Build every level down to `id` and return the node this provider actually handed out,
   * or null.
   *
   * `reveal()` will only accept a node whose whole parent chain the editor has already been
   * given. The walk works from `visibleObjects()`, which describes rows that may sit inside a
   * collapsed group or past a "Load more" boundary and so have never been built - revealing
   * one of those fails, and fails *silently*, because the editor logs the rejection rather
   * than raising it. Walking the levels here is what makes the tree follow along.
   */
  materialize(id) {
    let level = this.getChildren();
    for (let depth = 0; depth < 8; depth++) {
      const exact = level.find(n => n.id === id);
      if (exact) return exact;
      const branch = level.find(n => id.startsWith(`${n.id}/`));
      if (!branch) return null;
      level = this.getChildren(branch);
    }
    return null;
  }

  /** Expand paging until `id` is actually rendered, so reveal() can find it. */
  ensureVisible(id) {
    const pageSize = Number(settings().get('tree.pageSize'));
    if (!Number.isFinite(pageSize) || pageSize <= 0) return;
    const parentId = id.slice(0, id.lastIndexOf('/o:'));
    const siblings = this.visibleObjects().filter(n => n.id.startsWith(`${parentId}/o:`));
    const index = siblings.findIndex(n => n.id === id);
    if (index < 0) return;
    const needed = Math.floor(index / pageSize) + 1;
    if ((this.pages.get(parentId) || 1) < needed) {
      this.pages.set(parentId, needed);
      this._onDidChangeTreeData.fire();
    }
  }
}

module.exports = {
  ShaderObjectsProvider, VIEW_ID, distinctObjects, humanBytes, BUCKETS, findListingName
};
