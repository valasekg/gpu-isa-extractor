'use strict';

/**
 * The one SASS line parser. Every provider goes through this, so the semantic highlighter,
 * the hovers and the outline can never disagree about what a line contains.
 *
 * A SASS instruction, per the ISA grammar:
 *
 *     [guard pred] opcode[.modifiers] dst, [dst pred], src0, ...
 *
 * wrapped in one of four line formats:
 *
 *     /*0010*​/   MOV R1, c[0x0][0x28] ;             nvdisasm
 *     /*0010*​/   MOV ... ;   /* 0x00...f00 *​/       cuobjdump -sass
 *     0x0000000300000000  MOV R1, c[0x0][0x28]      Nsight SASS export
 *     MOV R1, c[0x0][0x28]                          bare (lecture notes, hand-written)
 *
 * Offsets are tracked by an incremental scanner rather than by one large regex, because
 * every consumer needs exact character ranges and repeated substrings make index-of
 * arithmetic on a combined match quietly wrong.
 */

/**
 * Maxwell-style leading control column.
 *
 * The printed columns run `wait:read:write:yield:stall` - the reverse of the bitfield
 * order the lecture notes list ("stall : yield : write barrier : read barrier : wait
 * barrier"). Decoding the notes' own examples settles it: in
 * `06:-:-:-:1  SEL ... // Wait Dep 2,3` the leading `06` is the mask of barriers 1 and 2,
 * and in `01:-:-:Y:d  ISETP ... // Wait Dep 1  Stall 13` the trailing `d` is 13 while the
 * leading `01` is the barrier-1 wait - which also puts the `Y` in the yield slot, where it
 * belongs.
 */
const CONTROL_COLUMN_RE =
  /^([-0-9a-f]{1,2}):([-0-7]):([-0-7]):([-Yy]):([-0-9a-f]{1,2})(?=\s)/;

/**
 * Volta+ bracketed control column, as emitted by this extension's disassembly pipeline.
 *
 * Same five fields in the same printed order as the Maxwell column, but each is tagged with
 * its own letter and the whole column is bracketed, so it can sit between the address and
 * the opcode without being mistaken for operands: `[B--2---:R-:W0:Y:S04]`.
 *
 * The two eras count differently and must never be described in the same words. Maxwell's
 * wait field is a hex *mask* over barriers renumbered 1-6 by maxas; this one is *positional*
 * over the raw scoreboards 0-5, one character per scoreboard, so `B--2---` is a wait on
 * scoreboard 2 alone. The stall is decimal here and hex there. `src/ctrl.js` owns the
 * encoding; this regex is the contract between it and the language layer.
 */
const CONTROL_COLUMN_VOLTA_RE =
  /^\[(B[0-5-]{6}):(R[0-5-]):(W[0-5-]):([Y-]):(S\d\d)\]/;

const ADDRESS_COMMENT_RE = /^\/\*\s*([0-9a-fA-F]+)\s*\*\//;
const ADDRESS_HEX_RE = /^(0x[0-9a-fA-F]{8,})(?=\s)/;
const GUARD_RE = /^(@)(!)?([A-Za-z_]\w*)/;
const OPCODE_RE = /^([A-Z][A-Z0-9_]*)((?:\.[A-Za-z0-9_]+)*)(?=[\s;]|$)/;

/** Operand-region tokens, most specific first. */
const TOKEN_RE = new RegExp([
  '(?<reuse>\\.reuse\\b)',
  '(?<constIdx>\\bcx\\[\\s*(?:URZ|UR\\d+)\\s*\\]\\[[^\\]]*\\])',
  '(?<constBank>\\bc\\[[^\\]]*\\]\\[[^\\]]*\\])',
  '(?<descriptor>\\bdesc\\[\\s*(?:URZ|UR\\d+)\\s*\\])',
  '(?<attribute>\\ba\\[[^\\]]*\\])',
  '(?<relocation>\\b(?:32|64)@(?:lo|hi)\\([^)]*\\))',
  // nvdisasm prints a label/function target as `(.L_x_0) - an opening backtick with no
  // closing one - so both that and a properly paired form have to be accepted.
  '(?<symbol>`\\([^)]*\\)|`[^`]*`)',
  '(?<special>\\bSRZ\\b|\\bSR_[A-Z0-9_]+(?:\\.[XYZW])?)',
  '(?<predFile>\\bPR\\b)',
  '(?<uniformPredicate>\\bUPT\\b|\\bUP\\d+\\b)',
  '(?<uniform>\\bURZ\\b|\\bUR\\d+\\b)',
  '(?<predicate>\\bPT\\b|\\bP\\d+\\b)',
  '(?<vector>\\bRZ\\b|\\bR\\d+\\b)',
  '(?<scoreboard>\\bSB\\d+\\b)',
  '(?<barrier>\\bB\\d+\\b)',
  '(?<label>\\.L_[\\w$]+|\\.L\\d+\\b)',
  '(?<operandMod>\\.[A-Za-z0-9_]+)',
  '(?<immediate>[-+]?0[xX][0-9a-fA-F]+|[-+]?\\d+\\.\\d+(?:[eE][-+]?\\d+)?|' +
    '[-+]?\\d+(?:[eE][-+]?\\d+)?|[-+]?(?:INF|QNAN|SNAN)\\b)',
  '(?<punct>[,\\[\\]()|!~])',
  '(?<other>\\S)'
].join('|'), 'gy');

/** Length of the leading identifier for bracketed operands, so tokens never overlap. */
const HEAD_LEN = { constIdx: 2, constBank: 1, descriptor: 4, attribute: 1 };

/** Operand 0 is an address or a stored value - these write no register at all. */
const STORE_OPCODES = new Set([
  'ST', 'STG', 'STS', 'STL', 'STT', 'STSM', 'STAS', 'AST', 'ASTS',
  'RED', 'URED', 'UTMASTG', 'SUST', 'SURED', 'LDGSTS', 'LDSTS', 'STGSTS'
]);

/** No destination operand at all. */
const NO_DST_OPCODES = new Set([
  'BRA', 'BRX', 'JMP', 'JMX', 'CALL', 'RET', 'EXIT', 'BSYNC', 'BREAK', 'WARPSYNC',
  'BAR', 'BARRIER', 'NOP', 'YIELD', 'MEMBAR', 'ERRBAR', 'DEPBAR', 'KILL', 'BPT',
  'PMTRIG', 'NANOSLEEP', 'SSY', 'PBK', 'PRET', 'PLONGJMP', 'CCTL', 'CCTLL', 'CCTLT',
  'OUT', 'SETCTAID', 'ENDCOLLECTIVE', 'RPCMOV', 'RTT', 'ACQBULK', 'ELECT'
]);

/** Token kinds that can hold a destination. */
const REGISTER_KINDS = new Set([
  'vector', 'uniform', 'predicate', 'uniformPredicate', 'barrier', 'scoreboard', 'predFile'
]);

const PREDICATE_KINDS = new Set(['predicate', 'uniformPredicate']);

/** Names that mean "throw the result away" when they land in a destination slot. */
const DISCARD_NAMES = new Set(['RZ', 'URZ', 'PT', 'UPT']);

/**
 * Split the operand region into tokens, tagging each with the index of the
 * comma-separated operand it belongs to.
 */
function tokenizeOperands(line, from) {
  const tokens = [];
  let operandIndex = 0;
  let depth = 0;
  let i = from;

  while (i < line.length) {
    const ch = line[i];
    if (ch === ' ' || ch === '\t') { i++; continue; }
    if (ch === ';') break;
    if (ch === '/' && (line[i + 1] === '*' || line[i + 1] === '/')) break;   // trailing comment

    TOKEN_RE.lastIndex = i;
    const m = TOKEN_RE.exec(line);
    if (!m) { i++; continue; }

    const kind = Object.keys(m.groups).find(k => m.groups[k] !== undefined);
    const text = m[0];
    const start = i;
    const end = i + text.length;
    i = end;

    if (kind === 'punct') {
      if (text === '[' || text === '(') depth++;
      else if (text === ']' || text === ')') depth = Math.max(0, depth - 1);
      else if (text === ',' && depth === 0) operandIndex++;
      continue;
    }
    if (kind === 'other') continue;

    const token = { kind, text, start, end, operandIndex, role: null };
    if (HEAD_LEN[kind] !== undefined) {
      token.head = { start, end: start + HEAD_LEN[kind] };
      token.indexed = kind === 'constIdx';
      if (kind === 'constIdx' || kind === 'constBank') token.kind = 'const';
    }
    if (PREDICATE_KINDS.has(kind) && line[start - 1] === '!') token.negated = true;
    tokens.push(token);

    // Registers nested inside a bracketed operand still deserve their own colour.
    if (kind === 'constIdx' || kind === 'descriptor') {
      const inner = /\bUR(?:Z|\d+)\b/.exec(text);
      if (inner) {
        tokens.push({
          kind: 'uniform', text: inner[0],
          start: start + inner.index, end: start + inner.index + inner[0].length,
          operandIndex, role: null, nested: true
        });
      }
    }
  }
  return tokens;
}

/**
 * Retain each complete printed operand for contextual explanations.
 *
 * Tokens are intentionally optimized for highlighting, so reconstructing an operand from
 * them loses value decorators such as `-R1`, `|R2|`, and address arithmetic. This scanner
 * keeps the exact trimmed source span while respecting commas inside brackets/parentheses.
 */
function scanOperands(line, from) {
  const operands = [];
  let start = from;
  let depth = 0;
  let i = from;

  const push = (end) => {
    let a = start;
    let b = end;
    while (a < b && (line[a] === ' ' || line[a] === '\t')) a++;
    while (b > a && (line[b - 1] === ' ' || line[b - 1] === '\t')) b--;
    if (a < b) operands.push({ start: a, end: b, text: line.slice(a, b) });
  };

  while (i < line.length) {
    const ch = line[i];
    if (ch === ';' || (ch === '/' && (line[i + 1] === '*' || line[i + 1] === '/'))) {
      push(i);
      return operands;
    }
    if (ch === '[' || ch === '(') depth++;
    else if (ch === ']' || ch === ')') depth = Math.max(0, depth - 1);
    else if (ch === ',' && depth === 0) {
      push(i);
      start = i + 1;
    }
    i++;
  }

  push(line.length);
  return operands;
}

/**
 * Decide which operands this instruction writes.
 *
 * Shape-based rather than a per-opcode signature table: the shapes are few, the opcode
 * list is 255 long and still growing, and a missing table entry would silently mislabel.
 * Order matters.
 */
function destinationOperands(opcode, tokens) {
  if (!opcode) return new Set();
  if (STORE_OPCODES.has(opcode) || NO_DST_OPCODES.has(opcode)) return new Set();

  const firstOf = idx => tokens.find(t => t.operandIndex === idx && !t.nested);
  const op0 = firstOf(0);
  if (!op0 || !REGISTER_KINDS.has(op0.kind) || op0.negated) return new Set();

  const dsts = new Set([0]);

  const op1 = firstOf(1);
  if (!op1 || !REGISTER_KINDS.has(op1.kind)) return dsts;

  const lastOperand = tokens.reduce((n, t) => Math.max(n, t.operandIndex), 0);

  if (PREDICATE_KINDS.has(op0.kind)) {
    // Predicate first: ISETP/FSETP/PLOP3 write "P0, PT"; LOP3 can write a predicate and a
    // register; SHFL writes "PT, Rd".
    dsts.add(1);
  } else if (PREDICATE_KINDS.has(op1.kind) && !op1.negated && lastOperand > 1) {
    // Register first, then a bare predicate that is not the trailing source slot:
    // a carry-out, as in `IADD3 R18, P0, R16, 0x10, RZ` or `VOTE.ALL R0, P1, PT`.
    dsts.add(1);
  }

  return dsts;
}

function operandSpan(tokens, operandIndex) {
  let from = Infinity;
  let to = -Infinity;
  for (const t of tokens) {
    if (t.operandIndex !== operandIndex) continue;
    from = Math.min(from, t.start);
    to = Math.max(to, t.end);
  }
  return from === Infinity ? null : { from, to };
}

/**
 * Parse one line. Returns null for lines carrying no instruction and no control column
 * (directives, labels, banners, comments).
 */
function parseLine(line) {
  const result = {
    controlCode: null, address: null, guard: null,
    opcode: null, modifiers: [], operands: [], tokens: []
  };

  let i = 0;
  const skipWs = () => { while (i < line.length && (line[i] === ' ' || line[i] === '\t')) i++; };

  skipWs();

  const cc = CONTROL_COLUMN_RE.exec(line.slice(i));
  if (cc) {
    const names = ['wait', 'read', 'write', 'yield', 'stall'];
    const fields = [];
    let at = i;
    for (let f = 0; f < 5; f++) {
      const text = cc[f + 1];
      fields.push({ name: names[f], text, start: at, end: at + text.length });
      at += text.length + 1;                                  // + the ':' separator
    }
    result.controlCode = { start: i, end: at - 1, fields, era: 'maxwell' };
    i = at - 1;
    skipWs();
  }

  let m = ADDRESS_COMMENT_RE.exec(line.slice(i));
  if (m) {
    result.address = { start: i, end: i + m[0].length, text: m[1] };
    i += m[0].length;
    skipWs();
  } else if ((m = ADDRESS_HEX_RE.exec(line.slice(i)))) {
    result.address = { start: i, end: i + m[0].length, text: m[1] };
    i += m[0].length;
    skipWs();
  }

  // After the address, before the guard - the only place the bracketed column appears.
  if (!result.controlCode && (m = CONTROL_COLUMN_VOLTA_RE.exec(line.slice(i)))) {
    const names = ['wait', 'read', 'write', 'yield', 'stall'];
    const fields = [];
    let at = i + 1;                                             // past the '['
    for (let f = 0; f < 5; f++) {
      const text = m[f + 1];
      fields.push({ name: names[f], text, start: at, end: at + text.length });
      at += text.length + 1;                                    // + the ':' or the ']'
    }
    result.controlCode = { start: i, end: i + m[0].length, fields, era: 'volta' };
    i += m[0].length;
    skipWs();
  }

  m = GUARD_RE.exec(line.slice(i));
  if (m) {
    const regStart = i + m[1].length + (m[2] ? m[2].length : 0);
    result.guard = {
      start: i, end: i + m[0].length,
      negated: !!m[2], register: m[3],
      registerStart: regStart, registerEnd: regStart + m[3].length
    };
    i += m[0].length;
    skipWs();
  }

  m = OPCODE_RE.exec(line.slice(i));
  if (!m) return result.controlCode ? result : null;

  result.opcode = { start: i, end: i + m[1].length, text: m[1] };
  i += m[1].length;

  if (m[2]) {
    const run = m[2];
    let tier = 1;
    let p = 0;
    while (p < run.length) {
      const next = run.indexOf('.', p + 1);
      const piece = next === -1 ? run.slice(p) : run.slice(p, next);
      result.modifiers.push({
        start: i + p, end: i + p + piece.length,
        text: piece.slice(1), tier: Math.min(tier, 3)
      });
      tier++;
      if (next === -1) break;
      p = next;
    }
    i += run.length;
  }

  result.operands = scanOperands(line, i);
  result.tokens = tokenizeOperands(line, i);

  const dsts = destinationOperands(result.opcode.text, result.tokens);
  for (const t of result.tokens) {
    if (!REGISTER_KINDS.has(t.kind)) continue;
    const span = operandSpan(result.tokens, t.operandIndex);
    const isAddress = span && line.slice(span.from, span.to).includes('[');
    if (dsts.has(t.operandIndex) && !isAddress && !t.nested && !t.negated) {
      t.role = DISCARD_NAMES.has(t.text) ? 'discard' : 'dst';
    } else {
      t.role = 'src';
    }
  }

  return result;
}

module.exports = {
  parseLine,
  STORE_OPCODES,
  NO_DST_OPCODES,
  REGISTER_KINDS,
  PREDICATE_KINDS,
  DISCARD_NAMES
};
