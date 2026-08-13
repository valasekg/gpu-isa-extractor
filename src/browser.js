'use strict';

/**
 * The command handlers behind the Shader Objects view.
 *
 * `extension.js` stays a thin registry; every body lives here.
 */

const path = require('path');
const vscode = require('vscode');

const isa = require('./isa');
const blobstore = require('./blobstore');
const pipeline = require('./pipeline');
const output = require('./output');
const review = require('./review');
const tree = require('./tree');

const CACHE_FILE_RE = /\.(bin|toc|nvph)$/i;

let ctx = null;
let provider = null;
let view = null;
let log = () => {};
let showLog = () => {};
let store = blobstore;
/** The shader the walk is on, which is not always the one the tree has selected. */
let walkCursor = null;

function init(options) {
  ctx = options.context;
  provider = options.provider;
  view = options.view;
  log = options.log || (() => {});
  showLog = options.showLog || (() => {});
  // Defaults to the real store; taken as a parameter so the commands can be exercised
  // against fabricated records.
  store = options.store || blobstore;
  walkCursor = null;

  // Clicking a row is the other way the walk gets repositioned.
  if (view && typeof view.onDidChangeSelection === 'function') {
    view.onDidChangeSelection(e => {
      const first = e && e.selection && e.selection.length ? e.selection[0] : null;
      if (first && first.kind === 'nvObject') walkCursor = first.id;
    });
  }
}

// --------------------------------------------------------------------------- target

/**
 * Which file a command should act on.
 *
 * This is what makes the extension reachable from a file that is already open, and it takes
 * three steps because a binary file has no text editor. Opening a `.bin` in VS Code produces
 * a placeholder editor and no `TextDocument` at all, so `window.activeTextEditor` is
 * undefined, `visibleTextEditors` is empty, and the file never appears in
 * `workspace.textDocuments`. The tab is still there though, and it reports its `Uri` - that
 * is the handle worth having.
 */
async function resolveTarget(arg) {
  // 1. An explorer right-click or an editor-title button hands over the resource directly.
  //    Validate it rather than duck-typing: a tree node arrives here too, from menus.
  if (arg && typeof arg.fsPath === 'string' && arg.scheme === 'file') return arg;

  // 2. The active tab, whatever kind of editor is showing it.
  const tab = vscode.window.tabGroups &&
    vscode.window.tabGroups.activeTabGroup &&
    vscode.window.tabGroups.activeTabGroup.activeTab;
  if (tab && tab.input) {
    const input = tab.input;
    // `Tab.input` is deliberately loosely typed and is undefined for editor kinds VS Code
    // does not model, so check for the uri rather than assuming a class.
    const uri = input.uri && typeof input.uri.fsPath === 'string' ? input.uri : null;
    if (uri && uri.scheme === 'file' && CACHE_FILE_RE.test(uri.fsPath)) return uri;
  }

  // 3. Ask.
  return pickFile();
}

async function pickFile() {
  const nvidia = process.env.LOCALAPPDATA
    ? vscode.Uri.file(path.join(process.env.LOCALAPPDATA, 'NVIDIA'))
    : undefined;
  const picked = await vscode.window.showOpenDialog({
    title: 'Select a shader-cache file',
    defaultUri: nvidia,
    canSelectMany: false,
    openLabel: 'Open',
    filters: { 'NVIDIA shader cache': ['bin', 'toc', 'nvph'], 'All files': ['*'] }
  });
  return picked && picked.length ? picked[0] : null;
}

/** True when the active tab looks like a cache file - drives the welcome content. */
function activeTabIsBlob() {
  const tab = vscode.window.tabGroups &&
    vscode.window.tabGroups.activeTabGroup &&
    vscode.window.tabGroups.activeTabGroup.activeTab;
  const input = tab && tab.input;
  const uri = input && input.uri && typeof input.uri.fsPath === 'string' ? input.uri : null;
  return !!(uri && CACHE_FILE_RE.test(uri.fsPath));
}

// --------------------------------------------------------------------------- context keys

function setContext(key, value) {
  return vscode.commands.executeCommand('setContext', `nvIsaExtractor.${key}`, value);
}

async function syncContext() {
  const records = store.all();
  await Promise.all([
    setContext('hasBlob', records.length > 0),
    setContext('blobCount', records.length),
    setContext('activeBlob', activeTabIsBlob()),
    setContext('filterActive', !!provider.filter)
  ]);
}

let busy = false;
async function withBusy(fn) {
  busy = true;
  await setContext('busy', true);
  try {
    return await fn();
  } finally {
    busy = false;
    await setContext('busy', false);
  }
}

async function refreshListingIndex() {
  // The architecture decides which listings count as this shader's, so resolve it if we can.
  // It is cached after the first call, and a failure only means matching stays arch-agnostic.
  let arch = null;
  try {
    arch = (await pipeline.resolveArch()).arch;
  } catch (e) { /* no GPU and no override; fall back to matching on the hash alone */ }
  provider.setListings(await output.listingIndex(ctx), arch);
}

function updateViewChrome() {
  const records = store.all();
  if (!records.length) {
    view.description = undefined;
    view.message = undefined;
    view.badge = undefined;
    return;
  }
  view.description = records.length === 1
    ? path.basename(records[0].source)
    : `${records.length} files`;

  const distinct = records.flatMap(r => (r.error ? [] : tree.distinctObjects(r)));
  const counts = review.counts(distinct);
  const outstanding = counts.total - counts.reviewed;
  view.badge = outstanding > 0
    ? { value: outstanding, tooltip: `${outstanding} shader(s) not yet reviewed` }
    : undefined;

  if (provider.filter) {
    const shown = provider.visibleObjects().length;
    view.message = `Filter "${provider.filter}" — ${shown} of ${counts.total} shaders`;
  } else {
    view.message = undefined;
  }
}

// --------------------------------------------------------------------------- open a blob

async function openBlob(uri, options = {}) {
  try {
    return await openBlobInner(uri, options);
  } catch (e) {
    log(`open failed: ${e && e.stack ? e.stack : e}`);
    const choice = await vscode.window.showErrorMessage(
      `Could not open that shader cache: ${e && e.message ? e.message.split('\n')[0] : e}`,
      'Show details');
    if (choice === 'Show details') showLog();
    return null;
  }
}

async function openBlobInner(uri, { force = false } = {}) {
  const target = await resolveTarget(uri);
  if (!target) return null;

  return withBusy(async () => {
    log(`--- open ${target.fsPath}`);
    const sweep = (progress, token) => store.open(target.fsPath, { progress, token, log, force });

    let record;
    try {
      record = await vscode.window.withProgress(
        { location: { viewId: tree.VIEW_ID }, cancellable: true }, sweep);
    } catch (e) {
      // Only a bad progress location is worth retrying - it means this extension named a view
      // that does not exist, which should degrade rather than break the command. Anything else
      // came out of the sweep and must be reported as itself, not silently attempted twice.
      if (!/progress location/i.test(e && e.message ? e.message : '')) throw e;
      log(`progress in the view failed (${e.message}); falling back to a notification`);
      record = await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: `Scanning ${path.basename(target.fsPath)}`,
        cancellable: true
      }, sweep);
    }

    if (record.cancelled) {
      log('the scan was cancelled; nothing was kept');
      await syncContext();
      updateViewChrome();
      return record;
    }

    await refreshListingIndex();
    await syncContext();
    updateViewChrome();

    if (record.error) {
      vscode.window.showErrorMessage(
        `${path.basename(target.fsPath)} could not be read: ${record.error}`);
      return record;
    }

    log(`${record.objects.length} object(s) in ${record.frames} frame(s)` +
      (record.scanned ? ' (magic scan)' : ''));

    const fileNode = provider.getChildren().find(n => n.record === record) ||
      provider.getChildren()[0];
    if (fileNode) {
      try {
        await view.reveal(fileNode, { select: true, focus: false, expand: true });
      } catch (e) { /* the view may be hidden; the tree is still correct */ }
    }

    // One object is not a list. Go straight to it, as the command always has.
    const distinct = record.objects.length ? tree.distinctObjects(record) : [];
    if (distinct.length === 1) {
      await openObject({ kind: 'nvObject', object: distinct[0], record });
    } else if (!distinct.length) {
      vscode.window.showWarningMessage(
        `No shader objects in ${path.basename(target.fsPath)} ` +
        `(${record.frames} compressed frame(s) examined). The view lists what to try next.`);
    }
    return record;
  });
}

async function openBlobDialog() {
  const picked = await pickFile();
  if (picked) await openBlob(picked);
}

async function refreshBlob(node) {
  const records = node && node.record ? [node.record] : store.all();
  if (!records.length) return;
  await withBusy(async () => {
    for (const record of records) {
      await vscode.window.withProgress({
        location: { viewId: tree.VIEW_ID }, cancellable: true
      }, (progress, token) => store.open(record.source, {
        progress, token, log, force: true
      }));
    }
    await refreshListingIndex();
    await syncContext();
    updateViewChrome();
  });
}

async function closeBlob(node) {
  if (node && node.record) store.close(node.record.source);
  else store.closeAll();
  await syncContext();
  updateViewChrome();
}

// --------------------------------------------------------------------------- disassemble

/** The object a node refers to, whichever kind of node it is. */
function objectOf(node) {
  if (!node) return null;
  if (node.kind === 'nvObject') return { object: node.object, record: node.record };
  if (node.kind === 'nvCopy') {
    return { object: { ...node.object, offset: node.copy.offset }, record: node.record };
  }
  return null;
}

/**
 * Disassemble one object using an already-loaded buffer, and write its listing.
 *
 * Takes a loaded record rather than acquiring one, so a batch reads the file once.
 */
async function runOne(loaded, object, token) {
  const result = await pipeline.disassemble(loaded, object, {
    token, log, scratchDir: output.scratchDir(ctx)
  });
  const file = await output.writeListing(ctx, result, loaded);
  return { result, file };
}

async function openObject(node, { preview = true } = {}) {
  const target = objectOf(node) || (node && node.object ? node : null);
  if (!target) return;
  const { object, record } = target.object ? target : { object: node.object, record: node.record };

  // A listing already on disk is the same bytes it would be regenerated as, and skipping
  // nvdisasm is the difference between stepping through shaders and waiting on each one.
  const existing = provider.hasListing(object) ? await findListing(object) : null;
  if (existing) {
    await output.showListing(existing, { preview, preserveFocus: false });
    return;
  }
  await disassembleObject(node, null, { preview });
}

async function findListing(object) {
  const names = await output.listingIndex(ctx);
  const name = tree.findListingName(names, object, provider.arch);
  return name ? path.join(output.listingDir(ctx), name) : null;
}

/**
 * Disassemble what the user pointed at: one object, everything selected, or everything under
 * a file or a group.
 */
async function disassembleObject(node, selection, { preview = false } = {}) {
  const selected = Array.isArray(selection) && selection.length > 1 ? selection : null;
  let targets = collectTargets(node, selected);
  if (!targets.length) targets = collectTargets(null, implicitNodes());
  if (!targets.length) {
    vscode.window.showInformationMessage(
      'Select a shader in the Shader Objects view to disassemble it.');
    return;
  }

  if (targets.length === 1) {
    return withBusy(async () => {
      const { object, record } = targets[0];
      await assertFresh(record);
      const done = await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: `Disassembling ${object.name || 'shader object'}`,
        cancellable: true
      }, async (progress, token) => {
        progress.report({ message: `${object.instructions.toLocaleString()} instructions` });
        return store.withBuffer(record, loaded => runOne(loaded, object, token));
      });

      await refreshListingIndex();
      await output.showListing(done.file, { preview, preserveFocus: false });
      reportAnnotation(done.result, record);
      return done;
    });
  }
  return runBatch(targets);
}

function collectTargets(node, selection) {
  const nodes = selection && selection.length ? selection : (node ? [node] : []);
  const out = [];
  const seen = new Set();

  const push = (object, record) => {
    if (seen.has(`${record.key}:${object.sha1}`)) return;
    seen.add(`${record.key}:${object.sha1}`);
    out.push({ object, record });
  };

  for (const n of nodes) {
    if (!n) continue;
    if (n.kind === 'nvObject' || n.kind === 'nvCopy') {
      const t = objectOf(n);
      if (t) push(t.object, t.record);
    } else if (n.kind === 'nvGroup') {
      for (const obj of n.objects) push(obj, n.record);
    } else if (n.kind === 'nvFile' && !n.record.error) {
      for (const obj of tree.distinctObjects(n.record)) push(obj, n.record);
    }
  }
  return out;
}

/** Measured on this machine: annotated listings run about 70 bytes per instruction, and
 *  nvdisasm gets through roughly 110,000 instructions a second. */
const BYTES_PER_INSTRUCTION = 70;
const INSTRUCTIONS_PER_SECOND = 110000;

async function runBatch(targets) {
  const pending = [];
  for (const t of targets) {
    if (!provider.hasListing(t.object)) pending.push(t);
  }
  const skipped = targets.length - pending.length;
  if (!pending.length) {
    vscode.window.showInformationMessage(
      `All ${targets.length} shader(s) already have listings.`);
    return;
  }

  const instructions = pending.reduce((n, t) => n + t.object.instructions, 0);
  const bytes = instructions * BYTES_PER_INSTRUCTION;
  const seconds = Math.ceil(instructions / INSTRUCTIONS_PER_SECOND);
  const threshold = Number(vscode.workspace.getConfiguration('nvIsaExtractor')
    .get('batch.confirmAboveBytes'));

  if (Number.isFinite(threshold) && threshold > 0 && bytes > threshold) {
    const proceed = await vscode.window.showWarningMessage(
      `Disassemble ${pending.length} shaders?`,
      {
        modal: true,
        detail: `${instructions.toLocaleString()} instructions, about ` +
          `${tree.humanBytes(bytes)} of listings, roughly ` +
          `${seconds < 90 ? `${seconds} seconds` : `${Math.round(seconds / 60)} minutes`}.` +
          (skipped ? `\n${skipped} already done and will be skipped.` : '')
      },
      'Disassemble');
    if (proceed !== 'Disassemble') return;
  }

  return withBusy(() => vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: `Disassembling ${pending.length} shaders`,
    cancellable: true
  }, async (progress, token) => {
    let done = 0;
    let failed = 0;
    const byRecord = new Map();
    for (const t of pending) {
      if (!byRecord.has(t.record)) byRecord.set(t.record, []);
      byRecord.get(t.record).push(t.object);
    }

    for (const [record, objects] of byRecord) {
      if (token.isCancellationRequested) break;
      // One read of the file for every object in it - the buffer slot is held once.
      await store.withBuffer(record, async loaded => {
        for (const object of objects) {
          if (token.isCancellationRequested) break;
          progress.report({
            message: `${done + 1} of ${pending.length} — ${object.name || '(unnamed)'}`,
            increment: 100 / pending.length
          });
          try {
            await runOne(loaded, object, token);
            done++;
          } catch (e) {
            if (e && e.message === 'cancelled') break;
            failed++;
            log(`batch: ${object.name || object.sha1.slice(0, 8)} failed: ${e && e.message}`);
          }
          // Flip icons to "already done" as they land, and let the host breathe.
          if (done % 10 === 0) {
            await refreshListingIndex();
            await new Promise(setImmediate);
          }
        }
      });
    }

    await refreshListingIndex();
    updateViewChrome();
    const note = `Disassembled ${done} shader(s)` +
      (skipped ? `, skipped ${skipped} already done` : '') +
      (failed ? `, ${failed} failed` : '') +
      (token.isCancellationRequested ? ' (cancelled)' : '') + '.';
    log(note);
    vscode.window.showInformationMessage(note);
  }));
}

async function assertFresh(record) {
  await store.checkStamps();
  if (record.stale) {
    const choice = await vscode.window.showWarningMessage(
      `${path.basename(record.source)} has changed on disk since it was scanned. The driver ` +
      'rewrites cache files as it compiles, so the offsets listed here may no longer be right.',
      'Rescan', 'Try Anyway');
    if (choice === 'Rescan') {
      await store.open(record.source, { log, force: true });
      throw new Error('cancelled');
    }
  }
}

function reportAnnotation(result, record) {
  const annotation = result.annotation;
  if (annotation && annotation.mismatchTotal) {
    log(`reuse tripwire: ${annotation.mismatchTotal} of ${annotation.annotated} instructions ` +
      `disagree with nvdisasm (${annotation.missing} missing, ${annotation.extra} extra)` +
      (annotation.suspect ? '' : ' - within the benign range, see the listing banner'));
  }
  if (annotation && annotation.suspect) {
    vscode.window.showWarningMessage(
      `Control codes may be wrong: on ${annotation.mismatchTotal} of ${annotation.annotated} ` +
      'instructions the decoded reuse flags disagree with what nvdisasm printed. The field ' +
      'layout may differ on this architecture.');
  } else if (result.object.warnings.length) {
    vscode.window.showWarningMessage(
      `${path.basename(record.source)}: ${result.object.warnings.join('; ')}`);
  }
}

// --------------------------------------------------------------------------- review

/**
 * What a command should act on when it was not invoked from a menu.
 *
 * A keybinding and a Command Palette entry both call their command with NO arguments, so a
 * handler that only reads its parameters does nothing at all when triggered that way - which
 * is exactly how the review shortcut is meant to be used. Fall back to what the user is
 * plainly looking at: the tree selection, or the listing open in front of them.
 */
function implicitNodes() {
  if (view && view.selection && view.selection.length) return [...view.selection];

  const editor = vscode.window.activeTextEditor;
  if (editor && editor.document.uri.scheme === 'file') {
    const sha1 = listingSha1(editor.document.uri.fsPath);
    if (sha1) {
      const match = provider.visibleObjects().find(n => n.object.sha1.startsWith(sha1));
      if (match) return [match];
    }
  }
  return [];
}

/** The sha1 prefix a generated listing carries in its filename, or null. */
function listingSha1(filePath) {
  // The same pattern `tree.js` matches names with - see `isa.LISTING_NAME_RE`. Both files used
  // to carry their own `.nvsass` literal, so a second dialect's listings would have been
  // indexed by `output.listingIndex` and then unrecognisable to everything that reads the index.
  const m = isa.LISTING_NAME_RE.exec(path.basename(filePath));
  return m ? m[2].toLowerCase() : null;
}

async function toggleReviewed(node, selection) {
  let targets = collectTargets(node, Array.isArray(selection) ? selection : null);
  if (!targets.length) targets = collectTargets(null, implicitNodes());
  if (!targets.length) {
    vscode.window.showInformationMessage(
      'Select a shader in the Shader Objects view, or open its listing, to mark it reviewed.');
    return;
  }
  // A mixed selection resolves one way: if anything is unreviewed, mark everything.
  const anyUnreviewed = targets.some(t => !review.isReviewed(t.object.sha1));
  await review.setMany(targets.map(t => t.object.sha1), anyUnreviewed);
  updateViewChrome();
}

async function clearReviewed(node) {
  const scope = node && node.record ? tree.distinctObjects(node.record).map(o => o.sha1) : null;
  const count = scope ? scope.length : review.size();
  if (!count) {
    vscode.window.showInformationMessage('Nothing is marked as reviewed.');
    return;
  }
  const proceed = await vscode.window.showWarningMessage(
    scope ? `Clear review marks for ${path.basename(node.record.source)}?`
      : `Clear all ${count} review mark(s)?`,
    { modal: true }, 'Clear');
  if (proceed !== 'Clear') return;
  await review.clear(scope || undefined);
  updateViewChrome();
}

// --------------------------------------------------------------------------- walking

/**
 * Where the walk currently is.
 *
 * Taken from the tree selection when the view has focus, otherwise from the listing being
 * read - its filename carries the object's sha1 prefix, so no file has to be opened to work
 * out which shader it is.
 */
function currentIndex(objects) {
  if (walkCursor) {
    const at = objects.findIndex(n => n.id === walkCursor);
    if (at >= 0) return at;
  }
  const selected = view && view.selection && view.selection.length ? view.selection[0] : null;
  if (selected && selected.kind === 'nvObject') {
    const at = objects.findIndex(n => n.id === selected.id);
    if (at >= 0) return at;
  }
  const editor = vscode.window.activeTextEditor;
  if (editor && editor.document.uri.scheme === 'file') {
    const sha1 = listingSha1(editor.document.uri.fsPath);
    if (sha1) {
      const at = objects.findIndex(n => n.object.sha1.startsWith(sha1));
      if (at >= 0) return at;
    }
  }
  return -1;
}

async function walk(step, { unreviewedOnly = false } = {}) {
  const objects = provider.visibleObjects();
  if (!objects.length) {
    vscode.window.showInformationMessage('No shader objects are listed.');
    return;
  }

  const count = objects.length;
  const from = currentIndex(objects);
  // With nowhere to start from, each direction begins at its own end, so "next" gives the
  // first shader and "previous" the last.
  let index = from < 0 ? (step > 0 ? 0 : count - 1) : (from + step + count) % count;

  for (let n = 0; n < count; n++, index = (index + step + count) % count) {
    const candidate = objects[index];
    if (!unreviewedOnly || !review.isReviewed(candidate.object.sha1)) {
      await goTo(candidate);
      return;
    }
  }
  vscode.window.showInformationMessage(unreviewedOnly
    ? 'Every listed shader has been reviewed.'
    : 'No shader objects are listed.');
}

async function goTo(node) {
  // Where the walk is, tracked independently of the tree selection. `reveal()` reports a
  // failure by logging it rather than rejecting, so a selection that did not move is
  // indistinguishable from one that did - and reading the position back off the selection
  // would then hand out the same shader on every press.
  walkCursor = node.id;

  provider.ensureVisible(node.id);
  const live = provider.materialize(node.id);
  if (live) {
    try {
      await view.reveal(live, { select: true, focus: false });
    } catch (e) { /* the view may be hidden; the listing still opens */ }
  }
  // preview: true replaces the listing tab instead of stacking one per shader.
  await openObject(node, { preview: true });
}

async function filterObjects() {
  const value = await vscode.window.showInputBox({
    title: 'Filter shader objects',
    prompt: 'Entry name, sha1 prefix, or an offset (decimal or 0x…). Empty clears the filter.',
    value: provider.filter
  });
  if (value === undefined) return;
  provider.setFilter(value);
  await syncContext();
  updateViewChrome();
}

function openSettings() {
  return vscode.commands.executeCommand('workbench.action.openSettings', 'nvIsaExtractor');
}

function loadMore(node) {
  provider.loadMore(node);
}

module.exports = {
  init,
  resolveTarget,
  activeTabIsBlob,
  syncContext,
  updateViewChrome,
  refreshListingIndex,
  openBlob,
  openBlobDialog,
  refreshBlob,
  closeBlob,
  openObject,
  disassembleObject,
  toggleReviewed,
  clearReviewed,
  walk,
  filterObjects,
  openSettings,
  loadMore
};
