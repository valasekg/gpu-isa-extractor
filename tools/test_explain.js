'use strict';

/**
 * Coverage and representative-content checks for algorithmic opcode explanations.
 */

const path = require('path');
const data = require(path.join(__dirname, '..', 'src', 'data.js'));
const {
  explainOpcode,
  decodeLutExpression
} = require(path.join(__dirname, '..', 'src', 'explain.js'));

let checks = 0;
let failures = 0;

function check(condition, what, detail = '') {
  checks++;
  if (condition) return;
  failures++;
  console.log(`  FAIL  ${what}`);
  if (detail) console.log(`        ${detail}`);
}

console.log('\n1. Complete opcode coverage');

const incomplete = [];
for (const [name, entry] of data.opcodes) {
  const detail = explainOpcode(name, entry, []);
  if (!detail || !detail.algorithm || !detail.operands ||
      !detail.execution || !detail.scheduling || !detail.caveat) {
    incomplete.push(name);
  }
}
check(incomplete.length === 0,
  `every opcode has a complete elaborate explanation (${data.opcodes.size} opcodes)`,
  incomplete.join(' '));

console.log('\n2. Representative algorithms');

function algorithm(name, modifiers = []) {
  return explainOpcode(name, data.lookupOpcode(name), modifiers).algorithm;
}

check(algorithm('FFMA').includes('a × b + c'), 'FFMA describes fused multiply-add');
check(algorithm('UIADD3').includes('a + b + c'), 'uniform UIADD3 inherits integer-add semantics');
check(algorithm('LOP3').includes('truth table'), 'LOP3 explains its LUT immediate');
check(algorithm('STG').includes('memory[address] = value'), 'STG explains store direction');
check(algorithm('LDG').includes('destination = memory[address]'), 'LDG explains load direction');
check(algorithm('BRA').includes('PC = target'), 'BRA explains its program-counter update');
check(algorithm('MUFU', ['RCP']).includes('1 / a'), 'MUFU.RCP explains reciprocal');
check(algorithm('HMMA').includes('A × B + C'), 'HMMA explains matrix multiply-accumulate');
check(algorithm('IPA').includes('Interpolates'), 'IPA explains graphics interpolation');
check(algorithm('ISETP', ['GE', 'AND']).includes('t = s32(a) >= s32(b)'),
  'ISETP decodes signed comparison semantics');
check(algorithm('FSETP', ['NEU', 'FTZ', 'XOR']).includes('OR unordered(a′, b′)'),
  'FSETP decodes FTZ and unordered comparison semantics');

console.log('\n3. Context-aware operand binding');

function contextualAlgorithm(name, modifiers, operands) {
  return explainOpcode(name, data.lookupOpcode(name), modifiers, operands).algorithm;
}

check(contextualAlgorithm('FFMA', ['FTZ'], ['R38', 'R41', 'R31', 'R38'])
  .includes('R38 = R41 × R31 + R38'), 'FFMA binds destination and source registers');
check(contextualAlgorithm('UIADD3', [], ['UR6', 'UP0', 'UR4', '0x100', 'URZ'])
  .includes('UR6 = UR4 + 0x100 + URZ'),
  'UIADD3 skips its carry-out predicate when binding arithmetic sources');
check(contextualAlgorithm('FSEL', [], ['R2', '-R3', '1', '!P0'])
  .includes('R2 = !P0 ? -R3 : 1'), 'FSEL binds its trailing predicate and decorated source');
check(contextualAlgorithm(
  'LOP3', ['LUT'], ['P3', 'RZ', 'R42', '0x40000', 'RZ', '0xc0', '!PT'])
  .includes('RZ = LUT(R42, 0x40000, RZ, 0xc0)'),
  'LOP3 skips its predicate destination and binds the truth-table literal');
check(contextualAlgorithm('SHFL', ['BFLY'], ['PT', 'R6', 'R6', '0x10', '0x1f'])
  .includes('R6 = shuffle(R6, 0x10, 0x1f)'),
  'SHFL binds its register destination, input, lane, and clamp');
check(contextualAlgorithm('LDG', [], ['R11', '[R12.U32+UR4]'])
  .includes('R11 = memory[R12.U32+UR4]'), 'load formula binds destination and address');
check(contextualAlgorithm('STG', [], ['[R19.U32+UR4]', 'R0'])
  .includes('memory[R19.U32+UR4] = R0'), 'store formula binds address and value');
check(contextualAlgorithm('BRA', [], ['0x3a0']).includes('PC = 0x3a0'),
  'branch formula binds its target literal');
check(contextualAlgorithm('S2R', [], ['R0', 'SR_CTAID.X'])
  .includes('R0 = SR_CTAID.X'), 'special-register move binds both operands');
check(contextualAlgorithm('HMMA', [], ['R16', 'R20', 'R24', 'R16'])
  .includes('R16 = R20 × R24 + R16'), 'matrix formula binds fragment base registers');
check(contextualAlgorithm('FSET', ['LT', 'FTZ', 'AND'], ['R0', '|R1|', '0.0', 'PT'])
  .includes('R0 = (t) AND PT'), 'FSET binds its register result and combining predicate');
check(contextualAlgorithm('DSETP', ['GE', 'AND'], ['P0', 'PT', 'R2', 'R4', 'PT'])
  .includes('f64(R2) >= f64(R4)'), 'DSETP decodes an FP64 comparison');
check(contextualAlgorithm('HSET2', ['NE', 'AND'], ['R0', 'R2', 'R4', 'P0'])
  .includes('t.lo = ordered(R2.lo, R4.lo)'),
  'HSET2 decodes packed low/high comparisons');
check(contextualAlgorithm('UFSETP', ['NEU', 'AND'], ['UP0', 'UPT', 'UR2', 'UR4', 'UPT'])
  .includes('unordered(UR2, UR4)'), 'UFSETP inherits contextual floating-point comparison decoding');
check(contextualAlgorithm('UISETP', ['GE', 'U32', 'AND'],
  ['UP0', 'UPT', 'UR4', '0x100', 'UPT']).includes('u32(UR4) >= u32(0x100)'),
  'UISETP binds uniform registers and applies its explicit unsigned type');
check(contextualAlgorithm('PSETP', ['AND', 'OR'], ['P2', 'PT', 'P0', '!P1', 'P3'])
  .includes('P2 = (t) OR P3'), 'PSETP decodes predicate logic and its combining predicate');

console.log('\n4. LUT truth-table decoding');

const missingLutExpressions = [];
for (let index = 0; index <= 0xff; index++) {
  if (decodeLutExpression(index) === null) missingLutExpressions.push(index);
}
check(missingLutExpressions.length === 0, 'all 256 LUT truth tables have an expression',
  missingLutExpressions.join(', '));
check(decodeLutExpression(0x00) === 'false' && decodeLutExpression(0xff) === 'true',
  'constant-false and constant-true tables decode');
check(decodeLutExpression(0xf0) === 'a' &&
      decodeLutExpression(0xcc) === 'b' &&
      decodeLutExpression(0xaa) === 'c', 'single-input LUT tables decode');
check(decodeLutExpression(0xc0) === 'a AND b' &&
      decodeLutExpression(0xfc) === 'a OR b' &&
      decodeLutExpression(0x3c) === 'a XOR b', 'common two-input operations use named forms');
check(decodeLutExpression(0x96) === 'a XOR b XOR c',
  'three-input parity uses a named XOR form');
check(decodeLutExpression(0x80) === '(a AND b AND c)',
  'an unnamed table receives a minimized sum-of-products expression');
check(contextualAlgorithm(
  'LOP3', ['LUT'], ['P3', 'RZ', 'R42', '0x40000', 'RZ', '0xc0', '!PT'])
  .includes('Equivalent Boolean operation: `RZ = R42 AND 0x40000`'),
  'LOP3 binds a decoded operation to its actual operands');
check(contextualAlgorithm('ULOP3', ['LUT'], ['UR9', 'UR8', '0xffff', 'URZ', '0xc0', '!UPT'])
  .includes('Equivalent Boolean operation: `UR9 = UR8 AND 0xffff`'),
  'ULOP3 binds uniform operands to the decoded operation');
check(!contextualAlgorithm('LOP3', ['LUT'], ['R0', 'R1', 'R2', 'R3', 'UR4', 'PT'])
  .includes('Equivalent Boolean operation'),
  'a non-literal LUT index remains undecoded');
{
  const predicateLut = contextualAlgorithm(
    'PLOP3', ['LUT'], ['P0', 'PT', 'P1', 'P2', 'P3', '0x80', '0x0']);
  check(predicateLut.includes('Equivalent Boolean operation: `P0 = (P1 AND P2 AND P3)`') &&
        predicateLut.includes('Equivalent Boolean operation: `PT = false`'),
    'PLOP3 decodes the independent truth table for each predicate destination', predicateLut);
}

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'}  ${checks} checks, ${failures} failures`);
process.exit(failures === 0 ? 0 : 1);
