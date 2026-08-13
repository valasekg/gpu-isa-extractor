'use strict';

/**
 * The RDNA line parser, against real RGA output.
 *
 * The fixtures under `tools/fixtures/rdna/` are genuine `rga -s vk-spv-offline -c gfx1201`
 * listings, produced from the SPIR-V already in `tools/fixtures/gfx/`. They are captured
 * rather than constructed, which is the opposite of what `test_ctrl.js` argues for - and for
 * the opposite reason. `ctrl.js` DECODES a bitfield, so a constructed vector points at the
 * decoder; this parser READS a third party's text format, so the only vector worth having is
 * the text that party really emitted. A constructed sample here would prove the parser agrees
 * with my idea of RGA's output, which is precisely the thing in doubt.
 *
 * Re-record with:
 *   rga -s vk-spv-offline -c gfx1201 --isa out\isa.txt --vert vs.spv --frag fs.spv
 *
 * The parser must return the shape `parse.js` returns, with the same `kind` vocabulary, or
 * `semantic.js` and `hover.js` silently stop colouring a dialect they think they understand.
 *
 *   ELECTRON_RUN_AS_NODE=1 Code.exe tools/test_rdna_parse.js
 */

const fs = require('fs');
const path = require('path');

const rdna = require(path.join(__dirname, '..', 'src', 'parse_rdna.js'));
const sass = require(path.join(__dirname, '..', 'src', 'parse.js'));

const FIXTURES = path.join(__dirname, 'fixtures', 'rdna');

let checks = 0;
let failures = 0;

function check(condition, what, detail = '') {
  checks++;
  if (condition) return;
  failures++;
  console.log(`  FAIL  ${what}`);
  if (detail) console.log(String(detail).split('\n').map(l => `        ${l}`).join('\n'));
}

function section(title) {
  console.log(`\n${title}`);
}

/** The token of `kind` covering `text`, or undefined. */
function tokenFor(parsed, text) {
  return parsed.tokens.find(t => t.text === text);
}

/* ------------------------------------------------------ 1. the shared shape --- */

section('1. The same shape the SASS parser returns');

const SHAPE = ['controlCode', 'address', 'guard', 'opcode', 'modifiers', 'operands', 'tokens'];
const oneRdna = rdna.parseLine(
  '\ts_mov_b64 s[0:1], exec                                     // 000000000200: BE80017E');
const oneSass = sass.parseLine('        /*0000*/ [B------:R-:W0:Y:S04]  S2R R0, SR_CTAID.X ;');

check(oneRdna !== null, 'an instruction line parses');
for (const field of SHAPE) {
  check(field in oneRdna, `the result carries \`${field}\`, as the SASS parser's does`);
}
check(SHAPE.every(f => f in oneSass),
  'the SASS parser still carries all of them, so the contract is shared and not merely copied');

// The vocabulary is the load-bearing part: semantic.js KIND_TO_TYPE is a table over it.
const RDNA_KINDS = new Set();
for (const name of fs.readdirSync(FIXTURES).filter(f => f.endsWith('.isa'))) {
  for (const line of fs.readFileSync(path.join(FIXTURES, name), 'utf8').split(/\r?\n/)) {
    const parsed = rdna.parseLine(line);
    if (parsed) for (const t of parsed.tokens) RDNA_KINDS.add(t.kind);
  }
}
const SASS_KINDS = new Set(['vector', 'uniform', 'predicate', 'uniformPredicate', 'special',
  'barrier', 'scoreboard', 'const', 'descriptor', 'attribute', 'immediate', 'label',
  'operandMod', 'reuse', 'symbol', 'relocation', 'predFile']);
const invented = [...RDNA_KINDS].filter(k => !SASS_KINDS.has(k));
check(invented.length === 0,
  'every kind the RDNA parser emits is one the SASS parser already emits',
  `invented: ${invented.join(', ')}`);

/* ------------------------------------------------------------ 2. registers --- */

section('2. Registers, ranges and named locations');

const vgpr = rdna.parseLine('\tv_mul_f32_e32 v10, v3, v3   // 00000000025C: 10140703');
check(tokenFor(vgpr, 'v10').kind === 'vector', 'a VGPR is a vector register');
check(tokenFor(vgpr, 'v10').role === 'dst', 'and the first operand of a VALU op is written');
check(tokenFor(vgpr, 'v3').role === 'src', 'while the rest are read');

const range = rdna.parseLine('\ts_and_saveexec_b64 s[0:1], vcc   // 00000000003C: BE80216A');
check(tokenFor(range, 's[0:1]') && tokenFor(range, 's[0:1]').kind === 'uniform',
  'an SGPR range is one uniform-register token, not three',
  range.tokens.map(t => `${t.kind}:${t.text}`).join(' '));
check(tokenFor(range, 'vcc').kind === 'special', 'vcc is a special register');

const attr = rdna.parseLine('\tds_param_load v2, attr0.x wait_va_vdst:15   // 00000000020C: CE8F0002');
check(tokenFor(attr, 'attr0.x').kind === 'attribute', 'an interpolant slot is an attribute');
check(tokenFor(attr, 'wait_va_vdst:15').kind === 'operandMod',
  'a named wait value is a modifier, not two tokens',
  attr.tokens.map(t => `${t.kind}:${t.text}`).join(' '));

const exp = rdna.parseLine('\texport mrt0, v1, v4, v2, v0 done   // 000000000380: F800080F 00020401');
check(tokenFor(exp, 'mrt0').kind === 'special', 'an export target is a named location');
check(tokenFor(exp, 'v1').role === 'src',
  'and an export writes nothing an operand can see, so its operands are all reads',
  tokenFor(exp, 'v1').role);

/* ------------------------------------------------ 3. what has no destination --- */

section('3. Stores, branches and waits write no operand');

const store = rdna.parseLine(
  '\tbuffer_store_b32 v1, v0, s[0:3], null offen   // 000000000058: C406807C 40800001 00000000');
check(store.tokens.filter(t => t.role === 'dst').length === 0,
  'a store writes memory, so no operand is a destination',
  store.tokens.filter(t => t.role === 'dst').map(t => t.text).join(', '));

const branch = rdna.parseLine('\ts_cbranch_execz _L0   // 000000000040: BFA50011');
check(tokenFor(branch, '_L0').kind === 'label', 'a branch target is a label');
check(branch.tokens.every(t => t.role !== 'dst'), 'and a branch writes nothing');

const wait = rdna.parseLine('\ts_wait_loadcnt 0x0   // 000000000040: BFC00000');
check(wait.opcode.text === 's_wait_loadcnt', 'a gfx12 wait parses as an ordinary instruction');
check(wait.tokens.every(t => t.role !== 'dst'), 'and writes nothing');

const delay = rdna.parseLine(
  '\ts_delay_alu instid0(VALU_DEP_2) | instskip(SKIP_1) | instid1(VALU_DEP_3)// 00000000023C: BF8701A2');
check(delay.opcode.text === 's_delay_alu', 's_delay_alu parses');
check(tokenFor(delay, 'instid0(VALU_DEP_2)') !== undefined,
  'and each of its arguments is one token rather than a broken-up call',
  delay.tokens.map(t => t.text).join(' '));

/* -------------------------------------------- 4. address and variable length --- */

section('4. The address and the encoding, which is where instruction length lives');

check(vgpr.address.text === '00000000025C', 'the trailing comment yields the address',
  vgpr.address && vgpr.address.text);
check(vgpr.encoding.bytes === 4, 'a one-word instruction is 4 bytes', vgpr.encoding.bytes);

const twoWord = rdna.parseLine(
  '\tv_interp_p10_f32 v9, v3, v0, v3 wait_exp:5   // 00000000022C: CD000509 040E0103');
check(twoWord.encoding.bytes === 8, 'a two-word instruction is 8 bytes', twoWord.encoding.bytes);

const threeWord = rdna.parseLine(
  '\tv_mul_f32_e64 v8, 0x3f13cd3b, v8 clamp   // 0000000002CC: D5088008 000210FF 3F13CD3B');
check(threeWord.encoding.bytes === 12, 'a three-word instruction is 12 bytes',
  threeWord.encoding.bytes);

// The reason `correlate.byAddress` must not be handed this ISA: the addresses are not a
// multiple of any single stride, so stepping lands between instructions.
const addresses = [];
for (const line of fs.readFileSync(path.join(FIXTURES, 'gfx1201-fragment.isa'), 'utf8')
  .split(/\r?\n/)) {
  const parsed = rdna.parseLine(line);
  if (parsed && parsed.address) addresses.push(parseInt(parsed.address.text, 16));
}
const gaps = new Set();
for (let i = 1; i < addresses.length; i++) gaps.add(addresses[i] - addresses[i - 1]);
check(gaps.size > 1,
  'instruction addresses advance by more than one stride, so no fixed width exists',
  `observed gaps: ${[...gaps].sort((a, b) => a - b).join(', ')}`);

/* ------------------------------------------------------------- 5. the corpus --- */

section('5. Every line of every captured listing');

let parsed = 0;
let skipped = 0;
let noOpcode = 0;
const unparsedSample = [];
for (const name of fs.readdirSync(FIXTURES).filter(f => f.endsWith('.isa'))) {
  const text = fs.readFileSync(path.join(FIXTURES, name), 'utf8');
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) { skipped++; continue; }
    const one = rdna.parseLine(line);
    if (one === null) { skipped++; continue; }
    if (!one.opcode) { noOpcode++; if (unparsedSample.length < 5) unparsedSample.push(line); continue; }
    parsed++;
    // An instruction line always yields an address; if it does not, the encoding comment
    // moved and every figure derived from it is wrong.
    if (!one.address && unparsedSample.length < 5) unparsedSample.push(line);
  }
}
// A floor rather than the exact count, so re-recording the fixtures against a newer RGA does
// not fail this on an instruction-selection change. The three captured listings held 76, 67
// and 18 instructions when recorded.
check(parsed >= 150, 'the corpus parses into instructions', `${parsed} parsed`);
check(noOpcode === 0, 'no non-blank, non-label line failed to yield an opcode',
  unparsedSample.join('\n'));

const entry = rdna.entryLabel(
  fs.readFileSync(path.join(FIXTURES, 'gfx1201-fragment.isa'), 'utf8'));
check(entry === '_amdgpu_ps_main', 'the entry symbol is read out of the listing', entry);
// The vertex fixture is the merged-stage case: RGA writes a vertex shader under the NGG
// geometry entry, which is why a listing cannot be labelled from the stage that was asked for.
const vsEntry = rdna.entryLabel(
  fs.readFileSync(path.join(FIXTURES, 'gfx1201-vertex.isa'), 'utf8'));
check(vsEntry === '_amdgpu_gs_main',
  'a vertex shader really is emitted under the merged NGG entry', vsEntry);

console.log(`\n${failures ? 'FAIL' : 'PASS'}  ${checks} checks, ${failures} failures`);
process.exit(failures ? 1 : 0);
