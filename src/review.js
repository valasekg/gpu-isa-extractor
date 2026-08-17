'use strict';

/**
 * Which shaders you have already looked at.
 *
 * Going over every shader in a cache file is a job you interrupt and come back to, so the
 * "done" marks have to survive both a window reload and the driver rewriting the file
 * underneath you. That second one is why marks are keyed on the microcode **sha1** and not on
 * where the object sits: the driver recompiles and re-stores shaders constantly, so every
 * offset in a file can move between sessions while the shader you reviewed is unchanged. A
 * sha1-keyed mark stays on the same shader across a refresh that renumbers the whole file.
 *
 * Stored in `globalState` rather than `workspaceState` - these blobs live under
 * %LOCALAPPDATA%\NVIDIA and have nothing to do with whatever workspace happens to be open.
 */

const KEY = 'gpuIsaExtractor.reviewed';

/** This machine's caches hold ~7,900 distinct shaders; keep a couple of passes' worth. */
const MAX_ENTRIES = 5000;

let state = null;
let marks = new Map();

const listeners = new Set();

function fire() {
  for (const listener of listeners) {
    try { listener(); } catch (e) { /* a bad listener must not break the ledger */ }
  }
}

function load(memento) {
  state = memento;
  const stored = memento.get(KEY) || {};
  marks = new Map(Object.entries(stored).map(([sha1, at]) => [sha1, Number(at) || 0]));
}

function persist() {
  // Oldest marks go first when the ledger is full: a review pass is a moving window, and the
  // shaders you looked at months ago are the ones you care least about remembering.
  if (marks.size > MAX_ENTRIES) {
    const ordered = [...marks.entries()].sort((a, b) => a[1] - b[1]);
    for (const [sha1] of ordered.slice(0, marks.size - MAX_ENTRIES)) marks.delete(sha1);
  }
  return state ? state.update(KEY, Object.fromEntries(marks)) : Promise.resolve();
}

function isReviewed(sha1) {
  return marks.has(sha1);
}

function set(sha1, reviewed, when = Date.now()) {
  const had = marks.has(sha1);
  if (reviewed === had) return Promise.resolve(false);
  if (reviewed) marks.set(sha1, when);
  else marks.delete(sha1);
  fire();
  return persist().then(() => true);
}

function toggle(sha1) {
  return set(sha1, !marks.has(sha1));
}

async function setMany(sha1s, reviewed, when = Date.now()) {
  let changed = 0;
  for (const sha1 of sha1s) {
    if (reviewed) {
      if (!marks.has(sha1)) { marks.set(sha1, when); changed++; }
    } else if (marks.delete(sha1)) changed++;
  }
  if (changed) { fire(); await persist(); }
  return changed;
}

/** Forget the marks for these shaders, or for everything when given nothing. */
async function clear(sha1s) {
  if (!sha1s) {
    const had = marks.size;
    marks.clear();
    if (had) { fire(); await persist(); }
    return had;
  }
  return setMany(sha1s, false);
}

/** {reviewed, total} over a set of object records, counting each distinct shader once. */
function counts(objects) {
  const seen = new Set();
  let reviewed = 0;
  for (const obj of objects) {
    if (seen.has(obj.sha1)) continue;
    seen.add(obj.sha1);
    if (marks.has(obj.sha1)) reviewed++;
  }
  return { reviewed, total: seen.size };
}

function onDidChange(listener) {
  listeners.add(listener);
  return { dispose: () => listeners.delete(listener) };
}

function size() {
  return marks.size;
}

module.exports = {
  KEY,
  MAX_ENTRIES,
  load,
  isReviewed,
  set,
  toggle,
  setMany,
  clear,
  counts,
  onDidChange,
  size
};
