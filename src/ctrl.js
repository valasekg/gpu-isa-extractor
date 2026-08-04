'use strict';

/**
 * Decode the per-instruction scheduling control fields and print them as a column.
 *
 * NVIDIA's compiler schedules SASS statically: instead of interlocks, each instruction
 * carries the scheduling decisions the compiler already made - how long to hold the warp,
 * which scoreboards to wait on, which to arm. `nvdisasm` does not print any of it, so this
 * reads the bits out of the raw instruction words and merges a column into its output:
 *
 *     /*0000*\/ [B------:R-:W0:Y:S04]  S2R R0, SR_CTAID.X ;
 *
 * Layout, Volta through Blackwell, bits [105,126) of the 128-bit instruction - which is bits
 * [41,62) of the high 64-bit word:
 *
 *     [41:45)  stall count, 0-15 cycles
 *     [45]     yield hint
 *     [46:49)  write scoreboard armed, 7 = none
 *     [49:52)  read scoreboard armed, 7 = none
 *     [52:58)  wait mask over scoreboards 0-5
 *     [58:62)  reuse flags, one per source operand slot
 *
 * Scoreboards are counters, not flags: several in-flight instructions can arm the same one,
 * and a wait blocks until it drains to zero. They are numbered 0-5 exactly as encoded here -
 * Maxwell-era listings and maxas renumber them 1-6 and print a hex mask instead, which is
 * why the two column formats must never be described in the same words.
 *
 * This is reverse-engineered (field layout per arXiv:1903.07486 and community decoders such
 * as CuAssembler), so it ships with a tripwire. The reuse nibble sits directly above the
 * fields we care about, and `nvdisasm` prints `.reuse` suffixes from its own independent
 * decoding of the same instruction, so comparing the two catches a window that has moved -
 * a real possibility on an architecture this has not been checked against.
 *
 * The two directions of disagreement do not mean the same thing, and conflating them makes
 * the tripwire cry wolf:
 *
 *   printed > decoded   nvdisasm found a reuse flag at a bit we did not read. There is no
 *                       benign explanation; the window is wrong. Any occurrence is reported.
 *   decoded > printed   we read a set bit that nvdisasm did not print. Usually benign - the
 *                       flag marks an operand-collector slot, and when that slot holds
 *                       something other than a plain register (`IPA` reading attribute
 *                       space, `TEX` with its packed operands) there is nothing to attach a
 *                       `.reuse` suffix to. Reported only when it is widespread, since a
 *                       genuinely misplaced window scatters bits across every instruction
 *                       rather than a handful.
 *
 * Measured on this machine (RTX A4500, SM86, driver 596.72): zero disagreements in either
 * direction across 1,498,016 instructions of compiled compute kernels, and 2 of the benign
 * kind in 55,424 instructions across a spread of graphics shaders - both on instructions
 * whose reused slot holds no printed register.
 */

const INSTRUCTION_BYTES = 16;

/** The format this emits; `src/parse.js` and the grammar match the same shape. */
const COLUMN_RE = /^\[(B[0-5-]{6}):(R[0-5-]):(W[0-5-]):([Y-]):(S\d\d)\]/;

const SCOREBOARD_COUNT = 6;
const NO_SCOREBOARD = 7;

/** nvdisasm's own line format: leading address comment, then the instruction. */
const ADDRESS_LINE_RE = /^(\s*)\/\*([0-9a-fA-F]+)\*\/(\s*)(\S.*)$/;

/**
 * Decode the control fields from the high word of one instruction.
 * @param {bigint} hi  little-endian u64 at instruction offset +8
 */
function decodeControl(hi) {
  return {
    stall: Number((hi >> 41n) & 0xfn),
    yield: Number((hi >> 45n) & 1n),
    writeSB: Number((hi >> 46n) & 7n),
    readSB: Number((hi >> 49n) & 7n),
    waitMask: Number((hi >> 52n) & 0x3fn),
    reuse: Number((hi >> 58n) & 0xfn)
  };
}

/** Decode instruction `index` out of a microcode buffer. */
function decodeAt(microcode, index) {
  const at = index * INSTRUCTION_BYTES;
  if (at + INSTRUCTION_BYTES > microcode.length) return null;
  return decodeControl(microcode.readBigUInt64LE(at + 8));
}

function scoreboardChar(sb) {
  return sb === NO_SCOREBOARD || sb >= SCOREBOARD_COUNT ? '-' : String(sb);
}

/**
 * Render decoded fields as the bracketed column.
 *
 * The wait mask is positional - one slot per scoreboard, showing its own number - so a
 * reader never has to convert a hex mask in their head, and the column stays a fixed width
 * whatever it contains.
 */
function formatColumn(c) {
  let wait = '';
  for (let b = 0; b < SCOREBOARD_COUNT; b++) wait += (c.waitMask & (1 << b)) ? String(b) : '-';
  const stall = String(c.stall).padStart(2, '0');
  return `[B${wait}:R${scoreboardChar(c.readSB)}:W${scoreboardChar(c.writeSB)}:` +
    `${c.yield ? 'Y' : '-'}:S${stall}]`;
}

function popcount(n) {
  let c = 0;
  for (; n; n >>= 1) c += n & 1;
  return c;
}

/**
 * Merge a decoded control column into a `nvdisasm` listing.
 *
 * Instruction lines are matched by their address comment, and the address *is* the index -
 * one instruction per 16 bytes - so no assumption is made about how many lines nvdisasm
 * emitted or in what order. Lines without an address (headers, labels, source correlation)
 * pass through untouched.
 *
 * @param {string} text        nvdisasm output, newlines normalised
 * @param {Buffer} microcode   the same bytes nvdisasm was given
 * @returns {{text, annotated, skipped, mismatches, mismatchTotal, missing, extra, suspect}}
 *   `mismatches` holds the first few tripwire hits for a diagnostic and `mismatchTotal` the
 *   honest count of all of them, so a caller never reports a capped sample as the whole
 *   story. `suspect` is the judgement: true when the disagreements are of a kind or a scale
 *   that says the decoded columns should not be trusted.
 */
function annotate(text, microcode, { maxExamples = 32, benignRate = 0.01 } = {}) {
  const mismatches = [];
  let mismatchTotal = 0;
  let missing = 0;
  let extra = 0;
  let annotated = 0;
  let skipped = 0;

  // Walked by hand rather than split/map/join: a large kernel runs to half a million lines,
  // and each of those steps would allocate an array that size. Slicing around the address
  // comment also avoids capturing the whole instruction just to paste it back.
  const out = [];
  let from = 0;
  while (from <= text.length) {
    let end = text.indexOf('\n', from);
    if (end < 0) end = text.length;
    const line = text.slice(from, end);
    from = end + 1;

    const open = line.indexOf('/*');
    const close = open < 0 ? -1 : line.indexOf('*/', open + 2);
    if (close < 0) { out.push(line); continue; }

    const addrHex = line.slice(open + 2, close);
    if (!HEX_RE.test(addrHex)) { out.push(line); continue; }

    // Whatever follows the address comment, minus the padding nvdisasm used to align it.
    let at = close + 2;
    while (at < line.length && (line[at] === ' ' || line[at] === '\t')) at++;
    if (at >= line.length) { out.push(line); continue; }

    const addr = parseInt(addrHex, 16);
    if (!Number.isFinite(addr) || addr % INSTRUCTION_BYTES !== 0) {
      skipped++; out.push(line); continue;
    }
    const control = decodeAt(microcode, addr / INSTRUCTION_BYTES);
    if (!control) { skipped++; out.push(line); continue; }

    // The tripwire: nvdisasm decoded `.reuse` from the same word, independently of us.
    const rest = line.slice(at);
    const printed = countReuse(rest);
    const decoded = popcount(control.reuse);
    if (printed !== decoded) {
      mismatchTotal++;
      if (printed > decoded) missing++;
      else extra++;
      if (mismatches.length < maxExamples) {
        mismatches.push({
          address: addrHex, printed, decoded,
          kind: printed > decoded ? 'missing' : 'extra'
        });
      }
    }

    annotated++;
    out.push(`${line.slice(0, close + 2)} ${formatColumn(control)}  ${rest}`);
  }

  const suspect = missing > 0 || extra > Math.max(8, annotated * benignRate);
  return { text: out.join('\n'), annotated, skipped, mismatches, mismatchTotal, missing, extra, suspect };
}

const HEX_RE = /^[0-9a-fA-F]+$/;

/** How many `.reuse` suffixes a line carries, without allocating a match array per line. */
function countReuse(text) {
  let n = 0;
  let at = text.indexOf('.reuse');
  while (at >= 0) {
    const after = text.charCodeAt(at + 6);
    // A word boundary: `.reuse` must not be the head of a longer postfix.
    if (Number.isNaN(after) || !(after === 95 ||
        (after >= 48 && after <= 57) || (after >= 65 && after <= 90) ||
        (after >= 97 && after <= 122))) n++;
    at = text.indexOf('.reuse', at + 6);
  }
  return n;
}

module.exports = {
  COLUMN_RE,
  INSTRUCTION_BYTES,
  NO_SCOREBOARD,
  decodeControl,
  decodeAt,
  formatColumn,
  annotate,
  popcount
};
