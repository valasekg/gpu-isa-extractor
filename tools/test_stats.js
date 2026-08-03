'use strict';

/**
 * What a shader is made of, counted from its disassembly and its instruction words.
 *
 * The cases worth pinning here are the ones where a naive count says something false: the
 * self-branch trap every object ends with would report every shader as looping, the trailing
 * NOP pad would inflate the instruction count of a small shader several times over, and the
 * `R` of a `UR` or an `SR_` would inflate the register count.
 *
 *   ELECTRON_RUN_AS_NODE=1 Code.exe tools/test_stats.js
 */

const fs = require('fs');
const path = require('path');

const stats = require(path.join(__dirname, '..', 'src', 'stats.js'));
const ctrl = require(path.join(__dirname, '..', 'src', 'ctrl.js'));

let checks = 0;
let failures = 0;

function check(condition, what, detail = '') {
  checks++;
  if (condition) return;
  failures++;
  console.log(`  FAIL  ${what}`);
  if (detail) console.log(`        ${String(detail).split('\n').slice(0, 6).join('\n        ')}`);
}

function section(title) { console.log(`\n${title}`); }

function ins(addr, body) {
  return `        /*${addr.toString(16).padStart(4, '0')}*/                   ${body} ;`;
}

/** Instruction words carrying the given control fields, so scheduling can be counted. */
function microcodeFor(fields) {
  const buf = Buffer.alloc(16 * fields.length);
  fields.forEach((f, i) => {
    const hi = (BigInt(f.stall || 0) << 41n) | (BigInt(f.yieldBit || 0) << 45n) |
      (BigInt(f.writeSB === undefined ? 7 : f.writeSB) << 46n) |
      (BigInt(f.readSB === undefined ? 7 : f.readSB) << 49n) |
      (BigInt(f.waitMask || 0) << 52n) | (BigInt(f.reuse || 0) << 58n);
    buf.writeBigUInt64LE(hi, i * 16 + 8);
  });
  return buf;
}

/* ------------------------------------------------------- 1. counting code --- */

section('1. Counting instructions');

{
  const text = [
    '\t.headerflags\t@"EF_CUDA_SM86"',
    ins(0x00, 'S2R R0, SR_CTAID.X'),
    ins(0x10, 'IMAD R2, R0, c[0x0][0x0], R3'),
    ins(0x20, 'EXIT'),
    ins(0x30, 'BRA 0x30'),
    ins(0x40, 'NOP'),
    ins(0x50, 'NOP'),
    ins(0x60, 'NOP')
  ].join('\n');
  const s = stats.analyze(text, microcodeFor(new Array(7).fill({})));

  check(s.instructions.total === 7, 'every instruction line is counted',
    String(s.instructions.total));
  // On a small shader the pad is most of the object, so a total on its own is misleading.
  check(s.instructions.pad === 3 && s.instructions.live === 4,
    'the trailing NOP pad is separated from the live code',
    JSON.stringify(s.instructions));
  check(!/\.headerflags/.test(JSON.stringify(s.mix)),
    'directives are not mistaken for instructions');
}

{
  // Every object ends with a branch to its own address, catching a warp that runs off the
  // end. Counting it as a backward branch would report every shader in existence as looping.
  const text = [ins(0x00, 'MOV R0, RZ'), ins(0x10, 'BRA 0x10')].join('\n');
  const s = stats.analyze(text, microcodeFor([{}, {}]));
  check(s.controlFlow.selfBranches === 1 && s.controlFlow.backwardBranches === 0,
    'the self-branch trap is not counted as a loop', JSON.stringify(s.controlFlow));
}

{
  const text = [
    ins(0x00, 'MOV R0, RZ'),
    ins(0x10, 'IADD3 R0, R0, 0x1, RZ'),
    ins(0x20, '@!P0 BRA 0x10'),
    ins(0x30, 'BRA 0x30')
  ].join('\n');
  const s = stats.analyze(text, microcodeFor(new Array(4).fill({})));
  check(s.controlFlow.backwardBranches === 1,
    'a genuine backward branch is counted', JSON.stringify(s.controlFlow));
  check(s.predicated.count === 1, 'and the guard is recognised as a predicate, not an opcode',
    JSON.stringify(s.predicated));
}

section('2. Registers');
{
  // The R of a UR or an SR_ must not be read as a vector register.
  const text = [
    ins(0x00, 'S2R R4, SR_TID.X'),
    ins(0x10, 'ULDC.64 UR40, c[0x0][0x30]'),
    ins(0x20, 'IMAD R2, R4, UR40, RZ'),
    ins(0x30, 'ISETP.GE.AND P3, PT, R2, RZ, PT')
  ].join('\n');
  const r = stats.registerUse(text);
  check(r.maxVector === 4, 'the highest vector register is found', String(r.maxVector));
  check(r.maxUniform === 40, 'uniform registers are counted separately', String(r.maxUniform));
  check(r.maxPredicate === 3, 'and predicates too', String(r.maxPredicate));
  check(r.maxVector !== 40, 'a UR is never read as an R');
}

section('3. Scheduling, decoded from the instruction words');
{
  const micro = microcodeFor([
    { stall: 4, writeSB: 0, yieldBit: 1 },
    { stall: 2, waitMask: 0b000001 },
    { stall: 0, reuse: 0b0011 }
  ]);
  const s = stats.schedulingOf(micro);
  check(s.instructions === 3, 'every instruction word is read', String(s.instructions));
  check(s.stallTotal === 6, 'stall cycles sum', String(s.stallTotal));
  check(Math.abs(s.stallPerInstruction - 2) < 1e-9, 'and average per instruction');
  check(Math.abs(s.waitShare - 100 / 3) < 0.01, 'the share that waits on a scoreboard');
  check(Math.abs(s.armShare - 100 / 3) < 0.01, 'the share that arms one');
  check(Math.abs(s.reuseShare - 100 / 3) < 0.01, 'and the share reusing an operand');
}

section('4. What the code uses');
{
  const text = [
    ins(0x00, 'LDL R2, [R1+0x10]'),
    ins(0x10, 'STS [R4], R2'),
    ins(0x20, 'TEX.SCR R8, R4, R5, 0x0, 2D'),
    ins(0x30, 'BAR.SYNC 0x0'),
    ins(0x40, 'RED.E.ADD [R6], R7')
  ].join('\n');
  const s = stats.analyze(text, microcodeFor(new Array(5).fill({})));
  for (const family of ['spills', 'shared', 'textures', 'barriers', 'atomics']) {
    check(s.uses.includes(family), `${family} are noticed`, s.uses.join(','));
  }
  check(!s.uses.includes('doubles'), 'and a family the code does not use is not claimed');
}

section('5. Constant banks and attributes');
{
  const text = [
    ins(0x00, 'MOV R0, c[0x0][0x28]'),
    ins(0x10, 'MOV R1, c[0x1][0x40]'),
    ins(0x20, 'IPA.PASS R4, a[0x80]')
  ].join('\n');
  const s = stats.analyze(text, microcodeFor(new Array(3).fill({})));
  check(JSON.stringify(s.constants.banks) === '[0,1]', 'the banks read are listed by number',
    JSON.stringify(s.constants.banks));
  check(JSON.stringify(s.constants.attributes) === '[128]',
    'and the attribute slots by offset', JSON.stringify(s.constants.attributes));
}

section('6. Disagreements with what the container declared');
{
  const spilling = stats.analyze(
    [ins(0x00, 'LDL R2, [R1+0x10]'), ins(0x10, 'BRA 0x10')].join('\n'),
    microcodeFor([{}, {}]));

  const notes = stats.crossCheck(spilling, {
    registers: 8, localBytes: null, sharedBytes: null
  });
  check(notes.some(n => /spills to local memory but the container declares none/.test(n)),
    'code that spills with no declared local memory is reported', JSON.stringify(notes));

  const clean = stats.crossCheck(spilling, { registers: 8, localBytes: 64, sharedBytes: null });
  check(clean.length === 0, 'and agreement is silent', JSON.stringify(clean));

  // A declared register count below what the code uses is impossible, so it means a bad carve.
  const impossible = stats.crossCheck(spilling, {
    registers: 1, localBytes: 64, sharedBytes: null
  });
  check(impossible.some(n => /uses R2/.test(n)),
    'a register count the code exceeds is flagged as one of the two being wrong',
    JSON.stringify(impossible));
}
{
  // BSSY and BSYNC pair up in correctly carved code, so an imbalance is a carve signal.
  const unbalanced = stats.analyze(
    [ins(0x00, 'BSSY B0, 0x40'), ins(0x10, 'BRA 0x10')].join('\n'), microcodeFor([{}, {}]));
  const notes = stats.crossCheck(unbalanced, { registers: 8, localBytes: null, sharedBytes: null });
  check(notes.some(n => /BSSY against 0 BSYNC/.test(n)),
    'an unmatched BSSY is reported', JSON.stringify(notes));
}

section('7. The rendered summary');
{
  const text = [
    ins(0x00, 'S2R R0, SR_CTAID.X'),
    ins(0x10, 'LDL R2, [R1]'),
    ins(0x20, 'BRA 0x20'),
    ins(0x30, 'NOP')
  ].join('\n');
  const s = stats.analyze(text, microcodeFor([
    { stall: 3 }, { stall: 1, writeSB: 0 }, {}, {}
  ]));
  const lines = stats.summaryLines(s, { registers: 8 });
  const joined = lines.join('\n');

  check(lines.every(l => l.startsWith('//')), 'every line is a comment', joined);
  check(/instructions\s*:/.test(joined), 'the instruction count is shown');
  check(/1 trailing NOP pad/.test(joined), 'with the pad called out', joined);
  check(/spills/.test(joined), 'and what the code uses');
  // The stall sum must never read as a measured cost.
  check(/not a performance figure/.test(joined),
    'the static issue figure is labelled as what it is', joined);
  check(!/\bcycle count\b/.test(joined), 'and is never called a cycle count');
}

section('8. A real listing');
{
  const sample = path.join(__dirname, '..', 'samples', 'example-kernel.nvsass');
  if (!fs.existsSync(sample)) {
    console.log('  skip  samples/example-kernel.nvsass is not present');
  } else {
    const text = fs.readFileSync(sample, 'utf8');
    const s = stats.analyze(text, null);
    check(s.instructions.total > 0, `the sample parses: ${s.instructions.total} instructions`);
    check(s.mix.length > 0 && s.mix[0].share > 0, 'with a category breakdown',
      JSON.stringify(s.mix.slice(0, 3)));
    // Every opcode the corpus contains should be one the data files know about.
    const unknown = s.mix.find(m => m.category === 'Unrecognised');
    check(!unknown, 'and no opcode falls outside the documented categories',
      unknown ? `${unknown.count} unrecognised` : '');
    check(s.controlFlow.bssy === s.controlFlow.bsync,
      'BSSY and BSYNC balance in real compiler output',
      JSON.stringify(s.controlFlow));
    console.log(`        ${s.instructions.total} instructions, ` +
      `${s.mix.map(m => `${m.category} ${m.share.toFixed(0)}%`).slice(0, 3).join(', ')}`);
  }
}

void ctrl;
console.log(`\n${failures ? 'FAIL' : 'PASS'}  ${checks} checks, ${failures} failures`);
process.exit(failures ? 1 : 0);
