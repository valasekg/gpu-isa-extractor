'use strict';

/**
 * Parser and data-coverage tests.
 *
 * Run through tools/verify.py, or directly:
 *
 *   ELECTRON_RUN_AS_NODE=1 "<VS Code>/Code.exe" tools/test_parse.js
 *
 * There is no Node on this machine, but VS Code ships one inside Electron, which is how
 * this runs. Only parse.js and data.js are exercised - they deliberately do not require
 * the `vscode` module, so they are testable outside the editor.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const { parseLine, REGISTER_KINDS } = require(path.join(ROOT, 'src', 'parse.js'));
const data = require(path.join(ROOT, 'src', 'data.js'));

let failures = 0;
let checks = 0;

function fail(what, detail) {
  failures++;
  console.log(`  FAIL  ${what}`);
  if (detail) console.log(`        ${detail}`);
}

function ok(what) {
  checks++;
  void what;
}

function check(cond, what, detail) {
  if (cond) ok(what);
  else fail(what, detail);
}

function section(title) {
  console.log(`\n${title}`);
}

/* ------------------------------------------------- 1. offset integrity ---- */

section('1. Offset integrity across the corpora');

const corpora = fs.readdirSync(path.join(ROOT, 'samples'))
  .filter(f => f.endsWith('.sass'))
  .map(f => path.join(ROOT, 'samples', f));

let totalLines = 0;
let instructionLines = 0;
let offsetProblems = 0;

for (const file of corpora) {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  totalLines += lines.length;

  lines.forEach((line, n) => {
    let parsed;
    try {
      parsed = parseLine(line);
    } catch (e) {
      offsetProblems++;
      fail(`${path.basename(file)}:${n + 1} threw`, e.message);
      return;
    }
    if (!parsed || !parsed.opcode) return;
    instructionLines++;

    const where = `${path.basename(file)}:${n + 1}`;
    if (line.slice(parsed.opcode.start, parsed.opcode.end) !== parsed.opcode.text) {
      offsetProblems++;
      fail(`${where} opcode offset`, line.trim());
    }
    for (const m of parsed.modifiers) {
      if (line.slice(m.start, m.end) !== '.' + m.text) {
        offsetProblems++;
        fail(`${where} modifier .${m.text} offset`, line.trim());
      }
    }
    for (const operand of parsed.operands) {
      if (line.slice(operand.start, operand.end) !== operand.text) {
        offsetProblems++;
        fail(`${where} operand ${operand.text} offset`, line.trim());
      }
    }
    for (const t of parsed.tokens) {
      if (line.slice(t.start, t.end) !== t.text) {
        offsetProblems++;
        fail(`${where} token ${t.text} offset`, line.trim());
      }
      if (REGISTER_KINDS.has(t.kind) && !t.role) {
        offsetProblems++;
        fail(`${where} register ${t.text} has no role`, line.trim());
      }
    }
    if (parsed.guard &&
        line.slice(parsed.guard.registerStart, parsed.guard.registerEnd) !== parsed.guard.register) {
      offsetProblems++;
      fail(`${where} guard offset`, line.trim());
    }
  });
}

check(offsetProblems === 0,
  `every token offset reproduces its source text (${instructionLines} instructions, ` +
  `${totalLines} lines, ${corpora.length} files)`);
console.log(`  parsed ${instructionLines} instructions from ${totalLines} lines in ` +
            `${corpora.map(f => path.basename(f)).join(', ')}`);

/* ------------------------------------------------ 2. operand roles -------- */

section('2. Operand roles');

/** [line, { operandText: expectedRole }] */
const ROLE_CASES = [
  // The canonical regression: a store's first operand is an address, not a destination.
  ['        /*4bf0*/              @!P4 STG.E.128.STRONG.SM [R19.U32+UR4], R0 ;',
    { R19: 'src', UR4: 'src', R0: 'src' }],
  ['        /*0130*/                   STG.E [R2.64], R12 ;',
    { R2: 'src', R12: 'src' }],
  // Loads do write their first operand.
  ['        /*0120*/              @!P5 LDG.E.STRONG.SM R11, [R12.U32+UR4] ;',
    { R11: 'dst', R12: 'src', UR4: 'src' }],
  // Two predicate destinations.
  ['        /*0080*/                   ISETP.GT.U32.AND P5, PT, R15, c[0x0][0x38], PT ;',
    { P5: 'dst', R15: 'src' }],
  // Predicate destination plus a discarded register destination.
  ['        /*4c10*/                   LOP3.LUT P3, RZ, R42, 0x40000, RZ, 0xc0, !PT ;',
    { P3: 'dst', R42: 'src' }],
  // Register destination plus a carry-out predicate.
  ['        /*00a0*/                   IADD3 R18, P0, R16, 0x10, RZ ;',
    { R18: 'dst', P0: 'dst', R16: 'src' }],
  // A trailing predicate is a source, not a carry-out.
  ['        /*0280*/                   FSEL R2, R3, 1, P0 ;',
    { R2: 'dst', R3: 'src', P0: 'src' }],
  // Branches and EXIT write nothing.
  ['        /*0300*/              @!P0 BRA 0x3a0 ;', {}],
  // BSSY writes its barrier.
  ['        /*0210*/                   BSSY B0, 0x45e0 ;', { B0: 'dst' }],
  // PR is the predicate file, a source here - it must not trigger the carry-out rule.
  ['        /*01f0*/                   P2R R42, PR, RZ, 0x1 ;', { R42: 'dst', PR: 'src' }],
  // Uniform datapath, carry-out into a uniform predicate.
  ['UIADD3 UR6, UP0, UR4, 0x100, URZ', { UR6: 'dst', UP0: 'dst', UR4: 'src' }],
  // Nested uniform register inside an indexed constant stays a source.
  ['IMAD.U32 R0, RZ, RZ, cx[UR4][0x8]', { R0: 'dst', UR4: 'src' }]
];

for (const [line, expected] of ROLE_CASES) {
  const parsed = parseLine(line);
  if (!parsed || !parsed.opcode) {
    fail('did not parse', line.trim());
    continue;
  }
  for (const [text, role] of Object.entries(expected)) {
    const token = parsed.tokens.find(t => t.text === text && REGISTER_KINDS.has(t.kind));
    if (!token) {
      fail(`${parsed.opcode.text}: token ${text} not found`, line.trim());
      continue;
    }
    check(token.role === role,
      `${parsed.opcode.text}: ${text} is ${role}`,
      `got "${token.role}" in: ${line.trim()}`);
  }
}

// Complete operand spans retain value decorators and nested address expressions for equations.
{
  const p = parseLine('FFMA.FTZ R38, -|R41|, c[0x0][0x20].reuse, 0.5 ;');
  const operands = p && p.operands ? p.operands.map(operand => operand.text) : [];
  check(JSON.stringify(operands) ===
        JSON.stringify(['R38', '-|R41|', 'c[0x0][0x20].reuse', '0.5']),
    'complete operand spans preserve decorators, constants, reuse hints, and literals',
    JSON.stringify(operands));
}

// RZ / PT in a destination slot must read as a deliberate discard.
{
  const p = parseLine('ISETP.GT.U32.AND P5, PT, R15, RZ, PT ;');
  const pt = p.tokens.find(t => t.text === 'PT');
  check(pt && pt.role === 'discard', 'PT in a destination slot is a discard',
    `got "${pt && pt.role}"`);
}

/* ----------------------------------------------- 3. control column -------- */

section('3. Control-code column');

{
  const p = parseLine('01:-:-:Y:d      ISETP.GE.AND P0, PT, R2, 128, PT;');
  check(!!p && !!p.controlCode, 'control column parses');
  if (p && p.controlCode) {
    const byName = Object.fromEntries(p.controlCode.fields.map(f => [f.name, f.text]));
    check(byName.wait === '01', 'wait mask is the leading column', JSON.stringify(byName));
    check(byName.yield === 'Y', 'yield flag lands in the yield column', JSON.stringify(byName));
    check(byName.stall === 'd', 'stall count is the trailing column', JSON.stringify(byName));
    check(!!p.opcode && p.opcode.text === 'ISETP',
      'the instruction after a control column still parses');
  }
}
{
  const p = parseLine('06:-:-:-:1      SEL R2, R1, R0, P0 ;');
  const byName = p && p.controlCode
    ? Object.fromEntries(p.controlCode.fields.map(f => [f.name, f.text])) : {};
  check(byName.wait === '06',
    'wait mask 06 decodes as barriers 1 and 2, matching "Wait Dep 2,3"',
    JSON.stringify(byName));
  check(p.controlCode.era === 'maxwell', 'a colon-separated column is tagged as Maxwell-era');
}
{
  const line = '        /*0020*/ [B--2---:R-:W0:Y:S04]  IMAD R2, R0, c[0x0][0x0], R3 ;';
  const p = parseLine(line);
  check(!!p && !!p.controlCode, 'Volta+ bracketed control column parses');
  if (p && p.controlCode) {
    const byName = Object.fromEntries(p.controlCode.fields.map(f => [f.name, f.text]));
    check(p.controlCode.era === 'volta', 'a bracketed column is tagged as Volta-era');
    check(byName.wait === 'B--2---' && byName.read === 'R-' && byName.write === 'W0' &&
          byName.yield === 'Y' && byName.stall === 'S04',
      'every bracketed field keeps its letter tag', JSON.stringify(byName));
    // Spans are what the hover highlights, so they have to land on the real characters.
    for (const f of p.controlCode.fields) {
      check(line.slice(f.start, f.end) === f.text,
        `the ${f.name} field's span covers exactly its text`,
        `${f.start}..${f.end} = ${JSON.stringify(line.slice(f.start, f.end))}`);
    }
    check(line.slice(p.controlCode.start, p.controlCode.end) === '[B--2---:R-:W0:Y:S04]',
      'the column span covers the brackets too');
    check(!!p.address && p.address.text === '0020',
      'the address before a bracketed column still parses');
    check(!!p.opcode && p.opcode.text === 'IMAD',
      'the instruction after a bracketed column still parses');
  }
}
{
  const p = parseLine('        /*0050*/ [B------:R-:W-:-:S01]  @!P0 BRA 0x30 ;');
  check(!!p && !!p.guard && p.guard.negated && p.guard.register === 'P0',
    'a guard predicate after a bracketed column still parses');
  check(!!p && !!p.opcode && p.opcode.text === 'BRA',
    'the opcode after a bracketed column and a guard still parses');
}
{
  // Operand brackets must not be mistaken for a control column, and vice versa.
  const p = parseLine('        /*0040*/                   STG.E [R19.U32+UR4], R0 ;');
  check(!!p && p.controlCode === null,
    'a bracketed operand is not mistaken for a control column');
}

/* ------------------------------------------- 4. line format coverage ------ */

section('4. All four dump formats');

const FORMAT_CASES = [
  ['nvdisasm', '        /*0000*/                   S2R R16, SR_CTAID.X ;', 'S2R', '0000'],
  ['Nsight export', '0x0000000300000000  MOV R1, c[0x0][0x28]', 'MOV', '0x0000000300000000'],
  ['bare', 'IMAD.MOV.U32 R0, RZ, RZ, 0x3f800000', 'IMAD', null],
  ['guarded bare', '@P0  MUFU.COS R0, R6', 'MUFU', null]
];

for (const [name, line, opcode, address] of FORMAT_CASES) {
  const p = parseLine(line);
  check(!!p && !!p.opcode && p.opcode.text === opcode, `${name} format yields ${opcode}`,
    p && p.opcode ? p.opcode.text : 'no opcode');
  if (address !== null) {
    check(!!p && !!p.address && p.address.text === address, `${name} format yields its address`,
      p && p.address ? p.address.text : 'no address');
  }
}

// Lines that must NOT be read as instructions.
const NON_INSTRUCTIONS = [
  '\t.headerflags\t@"EF_CUDA_64BIT_ADDRESS EF_CUDA_SM86"',
  '//-------------------- .text._Z8computePfS_i --------------------',
  '.L_x_4:',
  '        //## File "eval.cu", line 214',
  '',
  '        .section        .text._Z8computePfS_i'
];
for (const line of NON_INSTRUCTIONS) {
  const p = parseLine(line);
  check(!p || !p.opcode, `not an instruction: ${JSON.stringify(line.trim().slice(0, 40))}`,
    p && p.opcode ? `read as ${p.opcode.text}` : '');
}

/* ---------------------------------------------- 5. data coverage ---------- */

section('5. Corpus coverage against the data files');

const seenOpcodes = new Map();          // opcode -> count
const seenModifiers = new Map();        // "OPCODE.MOD" -> {opcode, mod}

for (const file of corpora) {
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    let parsed;
    try { parsed = parseLine(line); } catch (e) { continue; }
    if (!parsed || !parsed.opcode) continue;
    const op = parsed.opcode.text;
    seenOpcodes.set(op, (seenOpcodes.get(op) || 0) + 1);
    for (const m of parsed.modifiers) seenModifiers.set(`${op}.${m.text}`, { op, mod: m.text });
  }
}

const unknownOpcodes = [...seenOpcodes.keys()]
  .filter(op => !data.lookupOpcode(op))
  .sort();

const unknownModifiers = [...seenModifiers.values()]
  .filter(({ op, mod }) => !data.lookupModifier(op, mod))
  .map(({ op, mod }) => `${op}.${mod}`)
  .sort();

console.log(`  ${seenOpcodes.size} distinct opcodes, ${seenModifiers.size} distinct ` +
            `opcode+postfix pairs in the corpora`);

check(unknownOpcodes.length === 0,
  'every corpus opcode resolves in data/opcodes*.json',
  unknownOpcodes.length ? `missing: ${unknownOpcodes.join(' ')}` : '');

check(unknownModifiers.length === 0,
  'every corpus postfix resolves in data/modifiers.json',
  unknownModifiers.length ? `missing: ${unknownModifiers.join(' ')}` : '');

/* ---------------------------------------------- 6. data-layer sanity ------ */

section('6. Data layer');

check(data.opcodes.size >= 250, `opcode table loaded (${data.opcodes.size} entries)`);
check(!!data.lookupOpcode('IPA'), 'graphics supplement is merged (IPA resolves)');
check(data.lookupOpcode('IPA').documented === false, 'IPA is flagged as not first-party');
check(data.lookupOpcode('FFMA').documented === true, 'FFMA is flagged as first-party');

check(data.lookupModifier('MUFU', 'RSQ') !== null, 'opcode-specific postfix wins (MUFU.RSQ)');
check(data.lookupModifier('FMUL', 'FTZ') !== null, 'generic postfix resolves (FMUL.FTZ)');
check(data.lookupModifier('UIADD3', 'X') !== null,
  'uniform twin inherits its sibling postfixes (UIADD3.X via IADD3)');
check(data.uniformTwinOf('UIADD3') === 'IADD3', 'uniform twin resolution');
check(data.uniformTwinOf('IADD3') === null, 'non-uniform opcode has no twin');

check(data.isControlFlow('BRA') === true, 'BRA is control flow');
check(data.isControlFlow('FFMA') === false, 'FFMA is not control flow');
check(data.isUniformDatapath('ULDC') === true, 'ULDC is uniform datapath');

check(data.archForSm('86') === 'ampere', 'SM86 maps to the Ampere table');
check(data.archForSm('75') === 'turing', 'SM75 maps to the Turing table');
check(data.archForSm('90') === 'hopper', 'SM90 maps to the Hopper table');
check(data.archForSm('120') === 'blackwell', 'SM120 maps to the Blackwell table');

{
  const lines = fs.readFileSync(path.join(ROOT, 'samples', 'formats.sass'), 'utf8').split(/\r?\n/);
  check(data.detectArchitecture(i => lines[i] || '', lines.length) === 'ampere',
    'architecture detected from .headerflags in formats.sass');
}

check(data.lookupConstantOffset('0x0', '0x28') !== null, 'known constant-bank offset resolves');
check(data.lookupAttributeSlot('0x7c') !== null, 'known attribute slot resolves');
check(data.lookupSpecialRegister('SR_CTAID.X') !== null, 'special register resolves');
check(data.lookupSpecialRegister('SR_CTAID.W') !== null,
  'unknown component falls back to the base special register');

/* ------------------------------------------------------------ summary ---- */

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'}  ${checks} checks, ${failures} failures`);
process.exit(failures === 0 ? 0 : 1);
