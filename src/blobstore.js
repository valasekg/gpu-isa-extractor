'use strict';

/**
 * The set of cache files the user is currently browsing, and the rule that keeps that from
 * eating the extension host.
 *
 * **No whole-file buffer is ever retained past the sweep that produced it, and at most one
 * exists at any instant.** A GLCache blob here is up to 167 MB; holding seven of them
 * measured at +560 MB resident, while holding only their object records measured at +30 MB
 * for ten thousand objects. Re-reading a file when a disassembly actually needs it costs
 * about 94 ms - roughly 2% of the 4.5 s that nvdisasm then spends on a large kernel. The
 * buffer is not worth keeping, and it cannot be trimmed instead of dropped: a DXCache live
 * prefix is a subarray of the whole preallocated bucket and pins all 256 MB of it.
 *
 * The single-slot queue matters as much as dropping the buffer. Two large files opening at
 * once would otherwise peak at the sum of their sizes; serialising them peaks at the larger.
 *
 * Freshness is checked lazily, from `mtime:size`, rather than with a FileSystemWatcher: the
 * driver rewrites these files continuously while anything is rendering, so a watcher on the
 * cache root would fire without pause and tell us nothing we cannot ask for when it matters.
 */

const fs = require('fs');
const path = require('path');
const vscode = require('vscode');

const nvcache = require('./nvcache');
const pipeline = require('./pipeline');

/** Records, most-recently-used last. Keyed by normalised path. */
const records = new Map();

const emitter = new vscode.EventEmitter();

/** Fired whenever the set of records, or any record's contents, changes. */
const onDidChange = emitter.event;

function fire(record) {
  emitter.fire(record || null);
}

function keyFor(filePath) {
  return path.normalize(filePath).toLowerCase();
}

async function stampOf(filePath) {
  try {
    const stat = await fs.promises.stat(filePath);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch (e) {
    return null;
  }
}

function maxBlobs() {
  const n = Number(vscode.workspace.getConfiguration(pipeline.CONFIG).get('tree.maxBlobs'));
  return Number.isFinite(n) && n >= 1 ? n : 8;
}

// --------------------------------------------------------------------------- the one slot

let slotBusy = false;
const slotWaiting = [];

function acquireSlot() {
  if (!slotBusy) {
    slotBusy = true;
    return Promise.resolve();
  }
  return new Promise(resolve => slotWaiting.push(resolve));
}

function releaseSlot() {
  const next = slotWaiting.shift();
  if (next) next();
  else slotBusy = false;
}

/**
 * Re-read a file and rebuild exactly what `pipeline.disassemble` and `output.banner` consume.
 *
 * Callers MUST release the slot when done, so this is only reachable through `withBuffer`.
 */
async function loadBuffer(record) {
  const raw = await fs.promises.readFile(record.source);
  const buf = record.backend === 'dx' ? (nvcache.dxLivePrefix(raw) || raw) : raw;
  return {
    buf,
    source: record.source,
    backend: record.backend,
    label: record.label,
    scanned: record.scanned
  };
}

/**
 * Run `fn` with the file's bytes loaded, holding the single buffer slot for its duration.
 *
 * A batch takes the slot once and carves every object inside one call rather than re-reading
 * per object.
 */
async function withBuffer(recordOrPath, fn) {
  const record = typeof recordOrPath === 'string' ? records.get(keyFor(recordOrPath))
    : recordOrPath;
  if (!record) throw new Error('that cache file is no longer loaded');

  await acquireSlot();
  try {
    const loaded = await loadBuffer(record);
    try {
      return await fn(loaded);
    } finally {
      // Drop the reference before the slot is handed on, so the next holder's allocation
      // does not overlap this one.
      loaded.buf = null;
    }
  } finally {
    releaseSlot();
  }
}

// --------------------------------------------------------------------------- records

/**
 * Sweep a file and remember its objects (never its bytes).
 *
 * Re-opening a file that is already loaded and unchanged returns the existing record without
 * re-sweeping; `force` re-sweeps regardless, which is what Refresh does.
 */
async function open(filePath, { progress, token, log, force = false, minCodeOverride } = {}) {
  const kind = pipeline.classify(filePath);
  const target = kind.redirect || filePath;
  const key = keyFor(target);
  const stamp = await stampOf(target);

  const existing = records.get(key);
  if (existing && !force && existing.stamp === stamp && !existing.error) {
    records.delete(key);
    records.set(key, existing);                        // touch for LRU
    if (log) log(`${path.basename(target)} is already loaded and unchanged`);
    return existing;
  }

  // Evict before sweeping, not after, so the outgoing record is gone while the new file is
  // being read rather than alongside it.
  records.delete(key);
  while (records.size >= maxBlobs()) {
    const oldest = records.keys().next().value;
    if (oldest === undefined) break;
    records.delete(oldest);
  }

  let record;
  try {
    const swept = await pipeline.sweep(target, {
      progress, token, log, keepBuffer: false, minCodeOverride
    });
    record = {
      key,
      source: swept.source,
      backend: swept.backend,
      label: swept.label,
      scanned: swept.scanned,
      minCode: swept.minCode,
      objects: swept.objects,
      stats: swept.stats,
      frames: swept.frames,
      stamp,
      stale: false,
      error: null
    };
  } catch (e) {
    record = {
      key,
      source: target,
      backend: kind.backend,
      label: kind.label,
      scanned: false,
      minCode: 0,
      objects: [],
      stats: {},
      frames: 0,
      stamp,
      stale: false,
      error: e && e.message ? e.message : String(e)
    };
  }

  records.set(key, record);
  fire(record);
  return record;
}

// `keyFor` is idempotent, so these accept either a path or an already-computed key. Taking
// the string as a key directly would look equivalent and quietly miss every unnormalised path.
function get(pathOrKey) {
  return records.get(keyFor(pathOrKey));
}

function all() {
  return [...records.values()];
}

function has(filePath) {
  return records.has(keyFor(filePath));
}

function close(pathOrKey) {
  const removed = records.delete(keyFor(pathOrKey));
  if (removed) fire(null);
  return removed;
}

function closeAll() {
  const had = records.size > 0;
  records.clear();
  if (had) fire(null);
  return had;
}

/**
 * Mark every record as needing a re-sweep, without doing one.
 *
 * A settings change that alters what a sweep would find should not silently re-read every
 * loaded file - it should say so and let the user refresh.
 */
function markStale() {
  let changed = false;
  for (const record of records.values()) {
    if (!record.stale) { record.stale = true; changed = true; }
  }
  if (changed) fire(null);
  return changed;
}

/**
 * Re-check every record against the file on disk. The driver rewrites cache files as it
 * compiles, so a record can go stale at any moment without anything else noticing.
 */
async function checkStamps() {
  let changed = false;
  for (const record of records.values()) {
    const stamp = await stampOf(record.source);
    const stale = stamp !== record.stamp;
    if (stale !== record.stale) { record.stale = stale; changed = true; }
  }
  if (changed) fire(null);
  return changed;
}

function dispose() {
  records.clear();
  emitter.dispose();
}

module.exports = {
  onDidChange,
  keyFor,
  open,
  get,
  all,
  has,
  close,
  closeAll,
  markStale,
  checkStamps,
  withBuffer,
  dispose
};
