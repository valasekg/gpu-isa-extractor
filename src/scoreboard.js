'use strict';

/**
 * Follow a scoreboard back to the instructions that armed it.
 *
 * This is what the decoded control column is *for*. A wait like `[B--2---:...]` says "do not
 * issue until scoreboard 2 has drained", and the interesting question is always the same one:
 * drained of what? Which earlier instructions armed it, and how many are still outstanding?
 *
 * Scoreboards are counters, not flags. Every instruction that names a scoreboard in its read
 * or write field increments it; the increment is retired when that instruction's operands
 * have been read or its result written back. A wait blocks until the count reaches zero, so
 * one wait can drain several arms at once - two loads arming the same scoreboard and a single
 * wait covering both is ordinary compiler output, not a special case.
 *
 * The analysis is a backward scan from the wait:
 *
 *     for each earlier instruction, nearest first
 *       if it arms this scoreboard        -> it is one of the arms we are waiting on
 *       if it *waits* on this scoreboard  -> stop: everything before it was already drained
 *
 * The order inside a single instruction matters and is why the arm test comes first: an
 * instruction waits at issue and arms at issue, so an instruction that both waits on and arms
 * scoreboard 2 leaves exactly its own arm outstanding.
 *
 * **Where this stops being exact.** The scan is linear, and real code branches. An arm that
 * sits above a label may not have executed on the path that reached the wait, and an arm
 * inside a loop may have executed many times. Nothing here can know which. So the scan
 * records the first label and the first branch it crosses, and every caller is expected to
 * say so rather than present a count as certain. Within one straight-line run - which is
 * where the compiler does almost all of its scoreboard scheduling - it is exact.
 *
 * One consequence is worth handling rather than merely disclaiming. At a branch target the
 * instructions immediately above belong to the path that jumps *over* this one, so a strict
 * scan stops at their drain and reports that nothing armed the scoreboard. A compiler does
 * not emit a wait for nothing, so that result is a tell: the branches naming this
 * instruction's address are found, and the scoreboard is read as it stood when each jumped.
 * Measured on real output, this is what separates 82% of waits resolving from 100%.
 */

const { parseLine } = require('./parse');

/** How far back to look before giving up. Bounds the cost of a hover on a huge listing. */
const DEFAULT_LIMIT = 4000;

/** A branch target: control can arrive here from somewhere the scan cannot see. */
const LABEL_RE = /^\s*(\.?[A-Za-z_][\w.$]*)\s*:\s*$/;

/**
 * Instructions that move control somewhere other than the next address.
 *
 * Only real transfers belong here. `BSSY` merely records where divergent paths will
 * reconverge, and `KILL`, `YIELD` and `BPT` do not redirect control at all - counting any of
 * them would make ordinary straight-line code report itself as uncertain and point the reader
 * at an instruction that branches nowhere.
 */
const BRANCH_OPCODES = new Set([
  'BRA', 'BRX', 'BRXU', 'JMP', 'JMX', 'JMXU', 'CALL', 'RET', 'EXIT', 'BREAK', 'BSYNC'
]);

/** A branch and the address it names, on one listing line. */
const BRANCH_TARGET_RE = /\b(?:BRA|BRX|JMP|JMX|CALL)\b[^;]*?0x([0-9a-fA-F]+)/;
const ADDRESS_RE = /\/\*([0-9a-fA-F]+)\*\//;

const NO_SCOREBOARD = '-';

/**
 * The scoreboards an instruction waits on and arms.
 * @returns {?{wait:Set<number>, read:?number, write:?number, era:string}}
 */
function controlOf(text) {
  let parsed;
  try {
    parsed = parseLine(text);
  } catch (e) {
    return null;
  }
  if (!parsed || !parsed.controlCode || parsed.controlCode.era !== 'volta') return null;

  const byName = {};
  for (const f of parsed.controlCode.fields) byName[f.name] = f.text;

  const wait = new Set();
  const mask = byName.wait || '';
  // `B0-2---`: one slot per scoreboard, each showing its own number when armed.
  for (let slot = 0; slot < 6; slot++) {
    if (mask[slot + 1] && mask[slot + 1] !== NO_SCOREBOARD) wait.add(slot);
  }

  const digit = field => {
    const ch = (byName[field] || '')[1];
    return ch && ch !== NO_SCOREBOARD ? Number(ch) : null;
  };

  return { wait, read: digit('read'), write: digit('write'), era: 'volta', parsed };
}

/** Which scoreboard the character at `column` refers to, or null. */
function scoreboardAt(controlCode, column) {
  if (!controlCode || controlCode.era !== 'volta') return null;
  const field = controlCode.fields.find(f => column >= f.start && column < f.end);
  if (!field) return null;

  const offset = column - field.start;
  if (field.name === 'wait') {
    // Offset 0 is the `B` tag; the six slots follow it.
    if (offset < 1 || offset > 6) return null;
    const slot = offset - 1;
    return { sb: slot, role: 'wait', active: field.text[offset] !== NO_SCOREBOARD, field };
  }
  if (field.name === 'read' || field.name === 'write') {
    const ch = field.text[1];
    if (!ch || ch === NO_SCOREBOARD) {
      return { sb: null, role: field.name, active: false, field };
    }
    return { sb: Number(ch), role: field.name, active: true, field };
  }
  return null;
}

function lineText(document, lineNo) {
  return document.lineAt(lineNo).text;
}

function classify(text) {
  if (LABEL_RE.test(text)) return 'label';
  return null;
}

/**
 * The arms outstanding on `sb` at the instruction on `line`.
 *
 * @param {{lineCount:number, lineAt:function}} document
 * @param {number} line   the waiting instruction
 * @param {number} sb     scoreboard 0-5
 * @returns {{sb, waitLine, arms, value, drainLine, truncated, reachedStart, crossedLabel,
 *            crossedBranch, exact}}
 */
function armsFor(document, line, sb, { limit = DEFAULT_LIMIT } = {}) {
  const strict = scanBack(document, line, sb, limit);
  if (strict.arms.length || strict.drainLine === null) {
    return { ...strict, waitLine: line, alternatePath: false, pathJoin: null };
  }

  // A compiler does not emit a wait for nothing, so a wait that resolves to nothing means the
  // scan followed a path that never reaches it. That happens at a branch target: the
  // instructions immediately above are the tail of the path that jumps *over* this one, and
  // their drain is not ours.
  //
  // The arms have to be looked for where control actually came from. Simply resuming at the
  // drain is not good enough - anything armed between the branch and that drain belongs to
  // the path that was skipped, and reporting it would name arms outstanding on no path at
  // all. So find the branches that name this instruction's address and read the scoreboard as
  // it stood when each of them jumped.
  for (const source of branchSourcesTo(document, line, limit)) {
    const viaBranch = scanBack(document, source + 1, sb, limit);
    if (viaBranch.arms.length) {
      return {
        ...viaBranch,
        waitLine: line,
        alternatePath: true,
        pathJoin: source,
        exact: false
      };
    }
  }
  return { ...strict, waitLine: line, alternatePath: false, pathJoin: null };
}

/** The address in a line's `/*…*\/` comment, or null. */
function addressOf(text) {
  const m = ADDRESS_RE.exec(text);
  return m ? parseInt(m[1], 16) : null;
}

/**
 * Lines holding a branch that jumps to the instruction on `line`, nearest first.
 *
 * Bounded like every other scan here. Only looks backwards: a branch that skips a block jumps
 * forward, which is the shape that creates a join point. A loop header reached from below is
 * not resolved this way, and is reported as unresolved rather than guessed at.
 */
function branchSourcesTo(document, line, limit) {
  const target = addressOf(lineText(document, line));
  if (target === null) return [];

  const sources = [];
  let scanned = 0;
  for (let at = line - 1; at >= 0 && scanned < limit; at--) {
    const text = lineText(document, at);
    const m = BRANCH_TARGET_RE.exec(text);
    if (!m) continue;
    scanned++;
    if (parseInt(m[1], 16) === target) sources.push(at);
  }
  return sources;
}

function scanBack(document, line, sb, limit) {
  const arms = [];
  let drainLine = null;
  let crossedLabel = null;
  let crossedBranch = null;
  let truncated = false;
  let reachedStart = false;
  let scanned = 0;

  let at = line - 1;
  for (; at >= 0; at--) {
    if (scanned >= limit) { truncated = true; break; }

    const text = lineText(document, at);
    if (classify(text) === 'label' && crossedLabel === null) crossedLabel = at;

    const control = controlOf(text);
    if (!control) continue;
    scanned++;

    const opcode = control.parsed.opcode && control.parsed.opcode.text;
    if (opcode && BRANCH_OPCODES.has(opcode) && crossedBranch === null) crossedBranch = at;

    // The arm test comes first: an instruction that both waits on and arms this scoreboard
    // drains it and then leaves its own arm outstanding.
    if (control.read === sb) arms.push({ line: at, kind: 'read', opcode });
    if (control.write === sb) arms.push({ line: at, kind: 'write', opcode });

    if (control.wait.has(sb)) { drainLine = at; break; }
  }
  if (at < 0) reachedStart = true;

  arms.reverse();                                   // program order, earliest first
  return {
    sb,
    arms,
    value: arms.length,
    drainLine,
    truncated,
    reachedStart,
    crossedLabel,
    crossedBranch,
    exact: crossedLabel === null && crossedBranch === null && !truncated
  };
}

/**
 * The wait that drains an arm, and the other arms it drains alongside it.
 *
 * @returns {{sb, armLine, waitLine, siblings, truncated, crossedLabel, crossedBranch, exact}}
 */
function waitFor(document, line, sb, { limit = DEFAULT_LIMIT } = {}) {
  let waitLine = null;
  let crossedLabel = null;
  let crossedBranch = null;
  let truncated = false;
  let scanned = 0;

  for (let at = line + 1; at < document.lineCount; at++) {
    if (scanned >= limit) { truncated = true; break; }

    const text = lineText(document, at);
    if (classify(text) === 'label' && crossedLabel === null) crossedLabel = at;

    const control = controlOf(text);
    if (!control) continue;
    scanned++;

    const opcode = control.parsed.opcode && control.parsed.opcode.text;
    if (opcode && BRANCH_OPCODES.has(opcode) && crossedBranch === null) crossedBranch = at;

    if (control.wait.has(sb)) { waitLine = at; break; }
  }

  // Everything the draining wait covers, which is the context that makes an arm meaningful.
  const siblings = waitLine === null ? []
    : armsFor(document, waitLine, sb, { limit }).arms;

  return {
    sb,
    armLine: line,
    waitLine,
    siblings,
    truncated,
    crossedLabel,
    crossedBranch,
    exact: crossedLabel === null && crossedBranch === null && !truncated
  };
}

/**
 * Everything worth knowing about the scoreboard under the cursor, in one call.
 *
 * @returns {?{sb, role, active, analysis, related}} `related` is the set of lines a caller
 *   should highlight: the arms, for a wait; the draining wait and its other arms, for an arm.
 */
function analyzeAt(document, line, column) {
  const text = lineText(document, line);
  const control = controlOf(text);
  if (!control) return null;

  const hit = scoreboardAt(control.parsed.controlCode, column);
  if (!hit) return null;

  if (hit.role === 'wait') {
    if (!hit.active) return { ...hit, analysis: null, related: [] };
    const analysis = armsFor(document, line, hit.sb);
    return { ...hit, analysis, related: analysis.arms.map(a => a.line) };
  }

  if (!hit.active) return { ...hit, analysis: null, related: [] };
  const analysis = waitFor(document, line, hit.sb);
  const related = analysis.waitLine === null ? []
    : [analysis.waitLine, ...analysis.siblings.map(s => s.line).filter(l => l !== line)];
  return { ...hit, analysis, related };
}

module.exports = {
  DEFAULT_LIMIT,
  BRANCH_OPCODES,
  controlOf,
  scoreboardAt,
  armsFor,
  waitFor,
  analyzeAt
};
