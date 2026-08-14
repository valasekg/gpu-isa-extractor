'use strict';

/**
 * Following a dependency through an RDNA listing: which memory operations a wait drains.
 *
 * The counterpart of `scoreboard.js`, and the same question asked of a different mechanism.
 * NVIDIA states dependencies in a bitfield inside every instruction; RDNA states them as
 * separate instructions between them. What both express is one relation - some instructions
 * put work in flight, a later one blocks until enough of it has landed - so this returns the
 * shape `scoreboard.js` returns and `highlight.js` needs no idea which it is talking to.
 *
 * ## The counters are in-order queues, which makes the analysis exact where SASS's is not
 *
 * A scoreboard is a counter with no identity: a wait on it drains whatever armed it, and
 * `scoreboard.js` must scan backwards guessing which arms are still outstanding. An RDNA
 * counter is a FIFO. `s_wait_loadcnt 2` means "at most two loads may still be outstanding",
 * and because loads retire in issue order that names exactly which ones have landed. So the
 * pass here is forward and exact within a straight-line run, and it can say *which* load a
 * partial wait was waiting for - something the NVIDIA side genuinely cannot.
 *
 * Two exceptions, both real and both reported rather than papered over. See `AMBIGUOUS` below.
 *
 * ## What was measured, and what is documented but unobserved
 *
 * Measured here, by compiling one shader with two SMEM loads, an LDS access and two vector
 * loads in flight for gfx1100 and gfx1201 and reading what RGA emitted:
 *
 *   An OMITTED counter is NOT waited on. gfx1100 emitted `s_waitcnt vmcnt(0)` at a point where
 *   three scalar loads were outstanding, and did not wait for them. This is the rule that
 *   matters most: read the other way round - "an omitted field means wait for zero" - every
 *   answer this module gives would be wrong, and wrong in the direction that looks plausible.
 *
 *   On gfx10/11 LDS and scalar memory SHARE `lgkmcnt`. The same run emitted one `lgkmcnt(0)`
 *   covering a `ds_store_b32` and three `s_buffer_load`/`s_load`s together, so a wait on that
 *   counter cannot be attributed to one kind of access.
 *
 *   On gfx12 they do not. The identical shader produced `s_wait_kmcnt`, `s_wait_dscnt` and
 *   `s_wait_loadcnt` as three separate instructions, each naming one queue. This answers the
 *   open question directly: gfx12 REMOVES the ambiguity rather than renaming it.
 *
 * Documented but NOT observed in that run, and therefore not asserted as fact anywhere a
 * reader could mistake it for one:
 *
 *   `flat_*` addressing may resolve to global or to LDS at run time, so it is documented to
 *   increment both `vmcnt` and `lgkmcnt`. Slang emitted `buffer_*` and `ds_*` and no `flat_*`,
 *   so this module treats a `flat_` operation as touching both queues AND marks any answer
 *   involving one as uncertain, rather than claiming a precision it has not checked.
 *
 *   A partial wait - `lgkmcnt(2)` rather than `lgkmcnt(0)` - did not appear. The FIFO reasoning
 *   above is what the ISA documents, but this run produced only full drains, so a partial wait
 *   is answered with the caveat that the rule behind it is unverified here.
 */

const parseRdna = require('./parse_rdna');

/**
 * Which queue an instruction puts work into, per generation.
 *
 * Two tables rather than one with exceptions, because gfx12 did not rename gfx11's counters -
 * it split them. A single table with aliases would have to encode "these two are the same
 * queue on one generation and different queues on another", which is the fact the split
 * exists to remove.
 */
const QUEUES = {
  // gfx10 and gfx11: four counters, two of them shared between unrelated kinds of access.
  legacy: {
    counters: ['vmcnt', 'lgkmcnt', 'expcnt', 'vscnt'],
    of(op) {
      if (/^flat_/.test(op)) return ['vmcnt', 'lgkmcnt'];
      if (/^(?:buffer|global|image|tbuffer)_store/.test(op)) return ['vscnt'];
      if (/^(?:buffer|global|image|tbuffer|scratch)_/.test(op)) return ['vmcnt'];
      if (/^ds_/.test(op)) return ['lgkmcnt'];
      if (/^s_(?:load|buffer_load|memtime|memrealtime)/.test(op)) return ['lgkmcnt'];
      if (/^(?:export|exp)\b/.test(op)) return ['expcnt'];
      return [];
    }
  },
  // gfx12: one counter per kind, which is what makes attribution unambiguous.
  split: {
    counters: ['loadcnt', 'storecnt', 'dscnt', 'kmcnt', 'bvhcnt', 'samplecnt', 'expcnt'],
    of(op) {
      if (/^flat_/.test(op)) return ['loadcnt', 'dscnt'];
      if (/^(?:buffer|global|image|tbuffer|scratch)_store/.test(op)) return ['storecnt'];
      if (/^image_sample/.test(op)) return ['samplecnt'];
      if (/^image_bvh/.test(op)) return ['bvhcnt'];
      if (/^(?:buffer|global|image|tbuffer|scratch)_/.test(op)) return ['loadcnt'];
      if (/^ds_/.test(op)) return ['dscnt'];
      if (/^s_(?:load|buffer_load)/.test(op)) return ['kmcnt'];
      if (/^(?:export|exp)\b/.test(op)) return ['expcnt'];
      return [];
    }
  }
};

/**
 * Counters whose queue holds more than one kind of access, so a wait on them cannot say which.
 *
 * Measured: a single `lgkmcnt(0)` covering a `ds_store` and three scalar loads. This is why
 * gfx12's split matters and why the caveat is generation-specific rather than universal.
 */
const AMBIGUOUS = {
  lgkmcnt: 'LDS and scalar memory share this counter on gfx10/11, and scalar loads may ' +
    'retire out of order, so a partial wait on it cannot name which access it is waiting ' +
    'for. gfx12 splits them into dscnt and kmcnt.'
};

/** `s_waitcnt vmcnt(0) lgkmcnt(0)` - the gfx10/11 form, one instruction naming a subset. */
const LEGACY_WAIT_RE = /\b(vmcnt|lgkmcnt|expcnt|vscnt)\s*\(\s*(\d+)\s*\)/g;

/** `s_wait_loadcnt 0x0` - the gfx12 form, one instruction per counter. */
const SPLIT_WAIT_RE = /^s_wait_(loadcnt|storecnt|dscnt|kmcnt|bvhcnt|samplecnt|expcnt)$/;

/** How far back or forward to look. Bounds the cost of a hover on a huge listing. */
const DEFAULT_LIMIT = 4000;

/** A label, which control can reach from somewhere the scan cannot see. */
const LABEL_RE = /^\s*([A-Za-z_.$][\w.$]*)\s*:\s*$/;

/** Instructions that move control somewhere other than the next address. */
const BRANCH_RE = /^s_(?:branch|cbranch|setpc|swappc|call)/;

/**
 * The generation a listing was built for, from the waits it contains.
 *
 * Read from the code rather than from the banner, because the code is what is being analysed:
 * a listing pasted into an issue with no banner still answers correctly. `s_wait_<counter>` is
 * gfx12 and `s_waitcnt` is gfx10/11, and the two never appear together.
 */
function generationOf(text) {
  if (/\bs_wait_(?:load|store|ds|km|bvh|sample|exp)cnt\b/.test(text)) return 'split';
  if (/\bs_waitcnt\b/.test(text)) return 'legacy';
  return null;
}

/** The waits one line performs, as `{counter, value, start, end}`. */
function waitsOn(line) {
  const parsed = parseRdna.parseLine(line);
  if (!parsed || !parsed.opcode) return [];
  const op = parsed.opcode.text;

  const split = SPLIT_WAIT_RE.exec(op);
  if (split) {
    // The counter is named by the opcode; the operand is how many may remain outstanding.
    const value = parsed.tokens.find(t => t.kind === 'immediate');
    return [{
      counter: split[1],
      value: value ? Number(value.text) : 0,
      start: parsed.opcode.start,
      end: parsed.opcode.end
    }];
  }

  if (op !== 's_waitcnt') return [];
  const out = [];
  LEGACY_WAIT_RE.lastIndex = 0;
  let m;
  while ((m = LEGACY_WAIT_RE.exec(line)) !== null) {
    out.push({ counter: m[1], value: Number(m[2]), start: m.index, end: m.index + m[0].length });
  }
  return out;
}

/** The queues one line puts work into, or []. */
function armsOn(line, queues) {
  const parsed = parseRdna.parseLine(line);
  if (!parsed || !parsed.opcode) return [];
  return queues.of(parsed.opcode.text);
}

function lineText(document, at) {
  return document.lineAt(at).text;
}

/**
 * The operations a wait drains.
 *
 * Backward from the wait, collecting everything that put work into this counter, stopping at a
 * previous wait on the same counter - because whatever was outstanding then has already been
 * drained to that wait's level.
 *
 * `value` is how many may REMAIN, so a wait of N leaves the N most recent outstanding and
 * drains the rest. Since the queue retires in order, the ones drained are the OLDEST - which
 * is what lets a partial wait name them.
 */
function producersFor(document, line, counter, queues, { limit = DEFAULT_LIMIT } = {}) {
  const wait = waitsOn(lineText(document, line)).find(w => w.counter === counter);
  const remaining = wait ? wait.value : 0;

  const producers = [];
  let crossedLabel = null;
  let crossedBranch = null;
  let truncated = false;
  let drainLine = null;
  let scanned = 0;

  let at = line - 1;
  for (; at >= 0; at--) {
    if (scanned >= limit) { truncated = true; break; }
    const text = lineText(document, at);
    if (LABEL_RE.test(text) && crossedLabel === null) crossedLabel = at;

    const parsed = parseRdna.parseLine(text);
    if (!parsed || !parsed.opcode) continue;
    scanned++;
    if (BRANCH_RE.test(parsed.opcode.text) && crossedBranch === null) crossedBranch = at;

    // A previous wait on this counter bounds the search: anything older was already drained.
    if (waitsOn(text).some(w => w.counter === counter)) { drainLine = at; break; }

    if (queues.of(parsed.opcode.text).includes(counter)) {
      producers.push({ line: at, opcode: parsed.opcode.text, flat: /^flat_/.test(parsed.opcode.text) });
    }
  }
  producers.reverse();                                   // issue order, oldest first

  // In-order retirement: a wait leaving `remaining` outstanding drains all but the newest
  // `remaining` of them.
  const drained = remaining > 0 ? producers.slice(0, Math.max(0, producers.length - remaining))
    : producers;
  const stillOutstanding = producers.slice(drained.length);

  return {
    counter,
    remaining,
    producers,
    drained,
    stillOutstanding,
    drainLine,
    truncated,
    crossedLabel,
    crossedBranch,
    reachedStart: at < 0,
    // The two places this cannot be exact, reported rather than smoothed over.
    ambiguous: AMBIGUOUS[counter] || null,
    involvesFlat: producers.some(p => p.flat),
    exact: crossedLabel === null && crossedBranch === null && !truncated &&
      !AMBIGUOUS[counter] && !producers.some(p => p.flat)
  };
}

/**
 * The wait that drains an operation, and what else it drains alongside it.
 *
 * Forward from the operation to the first wait on that counter which leaves fewer outstanding
 * than this one's position in the queue.
 */
function waitFor(document, line, counter, queues, { limit = DEFAULT_LIMIT } = {}) {
  let crossedLabel = null;
  let crossedBranch = null;
  let truncated = false;
  let scanned = 0;
  let waitLine = null;

  for (let at = line + 1; at < document.lineCount; at++) {
    if (scanned >= limit) { truncated = true; break; }
    const text = lineText(document, at);
    if (LABEL_RE.test(text) && crossedLabel === null) crossedLabel = at;

    const parsed = parseRdna.parseLine(text);
    if (!parsed || !parsed.opcode) continue;
    scanned++;
    if (BRANCH_RE.test(parsed.opcode.text) && crossedBranch === null) crossedBranch = at;

    const here = waitsOn(text).find(w => w.counter === counter);
    if (here) { waitLine = at; break; }
  }

  const siblings = waitLine === null ? []
    : producersFor(document, waitLine, counter, queues, { limit }).drained;

  return {
    counter,
    armLine: line,
    waitLine,
    siblings,
    truncated,
    crossedLabel,
    crossedBranch,
    ambiguous: AMBIGUOUS[counter] || null,
    exact: crossedLabel === null && crossedBranch === null && !truncated && !AMBIGUOUS[counter]
  };
}

/**
 * Everything worth knowing about the dependency under the cursor.
 *
 * Returns `scoreboard.analyzeAt`'s shape so `highlight.js` and its F12 provider work unchanged.
 * `sb` holds the counter NAME rather than a number - it is only ever compared against null and
 * printed, and a name is what an RDNA reader would recognise.
 */
function analyzeAt(document, line, column) {
  const text = lineText(document, line);
  const generation = generationOfDocument(document);
  if (!generation) return null;
  const queues = QUEUES[generation];

  // On a wait: which operations does it drain?
  for (const wait of waitsOn(text)) {
    if (column < wait.start || column >= wait.end) continue;
    const analysis = producersFor(document, line, wait.counter, queues);
    return {
      sb: wait.counter,
      role: 'wait',
      active: true,
      generation,
      field: { start: wait.start, end: wait.end },
      analysis,
      related: analysis.drained.map(p => p.line)
    };
  }

  // On an operation that puts work in flight: which wait drains it?
  const parsed = parseRdna.parseLine(text);
  if (parsed && parsed.opcode && column >= parsed.opcode.start && column < parsed.opcode.end) {
    const counters = queues.of(parsed.opcode.text);
    if (!counters.length) return null;
    // A flat_ access sits in two queues; the first is reported and the second named in the
    // caveat, rather than picking one silently.
    const analysis = waitFor(document, line, counters[0], queues);
    return {
      sb: counters[0],
      role: 'arm',
      active: true,
      generation,
      counters,
      field: { start: parsed.opcode.start, end: parsed.opcode.end },
      analysis,
      related: analysis.waitLine === null ? []
        : [analysis.waitLine, ...analysis.siblings.map(s => s.line).filter(l => l !== line)]
    };
  }

  return null;
}

/** The generation of a whole document, cached per version. */
const generationCache = new Map();

function generationOfDocument(document) {
  const key = document.uri ? `${document.uri.toString()}:${document.version}` : null;
  if (key && generationCache.has(key)) return generationCache.get(key);

  // Reading every line of a large listing to answer this would cost more than the analysis it
  // enables, and the waits appear early, so a bounded look is enough.
  let found = null;
  const limit = Math.min(document.lineCount, 2000);
  for (let i = 0; i < limit && !found; i++) {
    found = generationOf(document.lineAt(i).text);
  }
  if (key) {
    if (generationCache.size > 32) generationCache.clear();
    generationCache.set(key, found);
  }
  return found;
}

module.exports = {
  QUEUES,
  AMBIGUOUS,
  DEFAULT_LIMIT,
  generationOf,
  waitsOn,
  armsOn,
  producersFor,
  waitFor,
  analyzeAt
};
