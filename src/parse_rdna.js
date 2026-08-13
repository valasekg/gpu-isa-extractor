'use strict';

/**
 * The one RDNA line parser, the counterpart of `parse.js` for AMD listings.
 *
 * It returns the IDENTICAL shape `parse.js` returns, using the IDENTICAL `kind` vocabulary on
 * each token. That is the whole reason `semantic.js`, `hover.js` and `symbols.js` needed no
 * changes to serve a second ISA: they are tables over that vocabulary, not over an instruction
 * set. A dialect that invented its own kinds would have to be special-cased in all three.
 *
 * An RGA-emitted line, which is what this reads:
 *
 *     _amdgpu_ps_main:
 *     \ts_mov_b64 s[0:1], exec                        // 000000000200: BE80017E
 *     \tv_interp_p10_f32 v9, v3, v0, v3 wait_exp:5    // 00000000022C: CD000509 040E0103
 *     \tv_mul_f32_e64 v8, 0x3f13cd3b, v8 clamp        // 0000000002CC: D5088008 000210FF 3F13CD3B
 *     \tbuffer_load_b32 v1, v0, s[0:3], null offen    // 000000000034: C405007C 40800001 00000000
 *     \ts_delay_alu instid0(VALU_DEP_2) | instskip(SKIP_1) | instid1(VALU_DEP_3)
 *
 * Four differences from SASS that the code below has to take seriously, rather than four
 * spellings of the same thing:
 *
 *   The address is a TRAILING comment, not a leading `/*0010*\/`, and it carries the
 *   instruction's encoding after it. Both are read; the encoding is what makes an instruction's
 *   length visible, which matters because
 *
 *   RDNA instructions are 4, 8 or 12 bytes. Nothing here may compute an instruction index by
 *   dividing an address, which is why `address` is reported and `INSTRUCTION_BYTES` is not.
 *
 *   Modifiers are trailing WORDS (`clamp`, `done`, `offen`) and named values
 *   (`wait_exp:5`), not `.DOT` suffixes, and the encoding suffix `_e32`/`_e64` is part of the
 *   mnemonic rather than a modifier. Splitting it off would make `v_mul_f32_e32` and
 *   `v_mul_f32_e64` look like one opcode when they are two encodings with different operand
 *   rules.
 *
 *   There is no per-instruction guard predicate. Divergence is the EXEC mask, manipulated by
 *   ordinary instructions, so `guard` is always null and the lane-masking is visible as code.
 */

/** The trailing `// <address>: <dword> <dword>` an RGA listing puts on every instruction. */
const ENCODING_RE = /\/\/\s*([0-9A-Fa-f]{8,16})\s*:\s*([0-9A-Fa-f ]+?)\s*$/;

/** A label on its own line: `_amdgpu_ps_main:`, `_L0:`. */
const LABEL_LINE_RE = /^\s*([A-Za-z_.$][\w.$]*)\s*:\s*$/;

/** The mnemonic. Underscored and lowercase, unlike SASS's dotted uppercase. */
const OPCODE_RE = /^([a-z][a-z0-9_]*)(?=[\s]|$)/;

/**
 * Operand-region tokens, most specific first.
 *
 * Ranges come before singles so `s[0:3]` is never read as `s` followed by numbers, and the
 * named-value modifier comes before the bare identifier so `wait_exp:5` stays one token.
 */
const TOKEN_RE = new RegExp([
  // `instid0(VALU_DEP_2)`, `instskip(SKIP_1)` - s_delay_alu's arguments.
  '(?<delayArg>\\b(?:instid0|instid1|instskip)\\([A-Z0-9_]+\\))',
  // `wait_exp:5`, `wait_va_vdst:15`, `offset:16`, `format:[BUF_FMT_32_FLOAT]`
  '(?<namedMod>\\b[a-z][a-z0-9_]*:(?:\\[[^\\]]*\\]|-?\\w+))',
  '(?<vectorRange>\\bv\\[\\d+:\\d+\\])',
  '(?<uniformRange>\\bs\\[\\d+:\\d+\\])',
  '(?<special>\\b(?:exec_lo|exec_hi|exec|vcc_lo|vcc_hi|vcc|scc|m0|null|' +
    'flat_scratch(?:_lo|_hi)?|xnack_mask(?:_lo|_hi)?|ttmp\\d+|shared_base|shared_limit)\\b)',
  // Export targets and interpolant slots read as named locations rather than registers.
  '(?<exportTarget>\\b(?:mrtz|mrt\\d+|pos\\d+|param\\d+|prim|dual_src_blend\\d+)\\b)',
  '(?<attribute>\\battr\\d+(?:\\.[xyzw])?)',
  '(?<vector>\\bv\\d+\\b)',
  '(?<uniform>\\bs\\d+\\b)',
  // Branch targets and the entry symbol.
  '(?<label>\\b_L\\d+\\b|\\b_amdgpu_\\w+\\b)',
  '(?<immediate>[-+]?0[xX][0-9a-fA-F]+|[-+]?\\d+\\.\\d+(?:[eE][-+]?\\d+)?|' +
    '[-+]?\\d+(?:[eE][-+]?\\d+)?|\\b(?:0\\.5|1\\.0|2\\.0|4\\.0)\\b)',
  // A bare trailing word is a modifier: clamp, done, offen, idxen, glc, nt, div:2 ...
  '(?<operandMod>\\b[a-z][a-z0-9_]*\\b)',
  '(?<punct>[,\\[\\]()|])',
  '(?<other>\\S)'
].join('|'), 'gy');

/** How a token kind maps onto the shared vocabulary `semantic.js` colours. */
const KIND_ALIAS = {
  vectorRange: 'vector',
  uniformRange: 'uniform',
  exportTarget: 'special',
  delayArg: 'operandMod',
  namedMod: 'operandMod'
};

/**
 * Instructions whose first operand is not a destination.
 *
 * Stores name the data or the address first; exports name the target; branches, waits and
 * `s_endpgm` write nothing an operand can see. `s_cmp_*` and `v_cmpx_*` do write - SCC and
 * EXEC respectively - but implicitly, so no operand is a destination.
 */
const STORE_RE = /^(?:ds_(?:write|store)|buffer_store|global_store|flat_store|scratch_store|image_store|tbuffer_store)/;
const NO_DST_RE = /^(?:s_endpgm|s_branch|s_cbranch|s_setpc|s_swappc|s_call|s_nop|s_sleep|s_barrier|s_wait|s_waitcnt|s_delay_alu|s_sethalt|s_trap|s_icache_inv|s_denorm_mode|s_round_mode|s_clause|s_cmp|s_bitcmp|v_cmpx|export|exp|s_sendmsg|s_set_)/;

/** Kinds that can hold a destination. */
const REGISTER_KINDS = new Set(['vector', 'uniform', 'special']);

/** Names that mean "throw the result away" in a destination slot. */
const DISCARD_NAMES = new Set(['null']);

/**
 * Split the operand region into tokens, tagging each with its comma-separated operand index.
 *
 * Bracket depth is tracked so a comma inside `s[0:3]` or `format:[...]` does not start a new
 * operand - the same reason `parse.js` tracks it.
 */
function tokenizeOperands(line, from, to) {
  const tokens = [];
  const region = line.slice(0, to);
  let operandIndex = 0;
  let depth = 0;
  let i = from;

  while (i < to) {
    const ch = region[i];
    if (ch === ' ' || ch === '\t') { i++; continue; }

    TOKEN_RE.lastIndex = i;
    const m = TOKEN_RE.exec(region);
    if (!m) { i++; continue; }

    const kind = Object.keys(m.groups).find(k => m.groups[k] !== undefined);
    const text = m[0];
    const start = i;
    i += text.length;

    if (kind === 'punct') {
      if (text === '[' || text === '(') depth++;
      else if (text === ']' || text === ')') depth = Math.max(0, depth - 1);
      else if (text === ',' && depth === 0) operandIndex++;
      continue;
    }
    if (kind === 'other') continue;

    tokens.push({
      kind: KIND_ALIAS[kind] || kind,
      text,
      start,
      end: start + text.length,
      operandIndex,
      role: null
    });
  }
  return tokens;
}

/** Retain each complete printed operand, for contextual explanations. */
function scanOperands(line, from, to) {
  const operands = [];
  let start = from;
  let depth = 0;

  const push = end => {
    let a = start;
    let b = end;
    while (a < b && (line[a] === ' ' || line[a] === '\t')) a++;
    while (b > a && (line[b - 1] === ' ' || line[b - 1] === '\t')) b--;
    if (a < b) operands.push({ start: a, end: b, text: line.slice(a, b) });
  };

  for (let i = from; i < to; i++) {
    const ch = line[i];
    if (ch === '[' || ch === '(') depth++;
    else if (ch === ']' || ch === ')') depth = Math.max(0, depth - 1);
    else if (ch === ',' && depth === 0) { push(i); start = i + 1; }
  }
  push(to);
  return operands;
}

/**
 * Which operands this instruction writes.
 *
 * Shape-based rather than a per-opcode signature table, for the reason `parse.js` gives: the
 * shapes are few and the opcode list is long and still growing, so a missing table entry would
 * silently mislabel a source as a destination.
 */
function destinationOperands(opcode, tokens) {
  if (!opcode) return new Set();
  if (STORE_RE.test(opcode) || NO_DST_RE.test(opcode)) return new Set();

  const op0 = tokens.find(t => t.operandIndex === 0);
  if (!op0 || !REGISTER_KINDS.has(op0.kind)) return new Set();

  const dsts = new Set([0]);
  // A VALU compare writing a lane mask names its destination first and its carry-out second:
  // `v_add_co_u32 v0, s[0:1], v1, v2`. Both are written.
  if (/^v_(?:add|sub|subrev)_co_/.test(opcode)) {
    const op1 = tokens.find(t => t.operandIndex === 1);
    if (op1 && REGISTER_KINDS.has(op1.kind)) dsts.add(1);
  }
  return dsts;
}

/**
 * Parse one line of an RGA ISA listing.
 *
 * @returns {?object} null for blank lines, comments and labels - lines carrying no
 *   instruction - matching `parse.js`, whose callers already handle null.
 */
function parseLine(line) {
  const result = {
    controlCode: null,          // RDNA states scheduling as instructions, not as a field
    address: null,
    guard: null,                // no per-instruction predicate; divergence is the EXEC mask
    opcode: null,
    modifiers: [],
    operands: [],
    tokens: [],
    encoding: null
  };

  if (LABEL_LINE_RE.test(line)) return null;

  // The trailing comment bounds the instruction. Everything to its left is code; the address
  // and the encoding words are read out of it rather than thrown away, because the encoding is
  // the only thing that says how long this instruction is.
  let end = line.length;
  const enc = ENCODING_RE.exec(line);
  if (enc) {
    end = enc.index;
    const addrAt = line.indexOf(enc[1], enc.index);
    result.address = { start: addrAt, end: addrAt + enc[1].length, text: enc[1] };
    const wordsAt = line.indexOf(enc[2], addrAt + enc[1].length);
    result.encoding = {
      start: wordsAt,
      end: wordsAt + enc[2].length,
      text: enc[2],
      bytes: enc[2].trim().split(/\s+/).length * 4
    };
  }

  let i = 0;
  while (i < end && (line[i] === ' ' || line[i] === '\t')) i++;

  const m = OPCODE_RE.exec(line.slice(i, end));
  if (!m) return null;

  result.opcode = { start: i, end: i + m[1].length, text: m[1] };
  i += m[1].length;

  result.operands = scanOperands(line, i, end);
  result.tokens = tokenizeOperands(line, i, end);

  // Trailing modifier words are reported as modifiers as well as tokens, so a hover over
  // `clamp` finds it the way it finds a SASS `.MOD`. Tier is always 1: RDNA modifiers do not
  // nest the way a dotted SASS suffix chain does.
  for (const token of result.tokens) {
    if (token.kind === 'operandMod') {
      result.modifiers.push({ start: token.start, end: token.end, text: token.text, tier: 1 });
    }
  }

  const dsts = destinationOperands(result.opcode.text, result.tokens);
  for (const token of result.tokens) {
    if (!REGISTER_KINDS.has(token.kind)) continue;
    if (dsts.has(token.operandIndex)) {
      token.role = DISCARD_NAMES.has(token.text) ? 'discard' : 'dst';
    } else {
      token.role = 'src';
    }
  }

  return result;
}

/** The entry-point symbol a listing declares, e.g. `_amdgpu_ps_main`, or null. */
function entryLabel(text) {
  for (const line of String(text || '').split(/\r?\n/, 40)) {
    const m = LABEL_LINE_RE.exec(line);
    if (m && m[1].startsWith('_amdgpu_')) return m[1];
  }
  return null;
}

/**
 * The architecture a listing was built for.
 *
 * The dialect's counterpart of `data.detectArchitecture`. An RGA listing does not state its
 * own target, so this reads the banner this extension writes above it - which is why the
 * `asic` field is spelled exactly this way there.
 */
function detectArchitecture(getLine, lineCount) {
  const limit = Math.min(lineCount, 200);
  for (let i = 0; i < limit; i++) {
    const m = /\bgfx(\d{3,4})\b/.exec(getLine(i));
    if (m) return `gfx${m[1]}`;
  }
  return null;
}

module.exports = {
  parseLine,
  entryLabel,
  detectArchitecture,
  ENCODING_RE,
  LABEL_LINE_RE,
  STORE_RE,
  NO_DST_RE,
  REGISTER_KINDS,
  DISCARD_NAMES
};
