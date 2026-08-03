'use strict';

/**
 * Hover-provider tests without an Extension Host.
 *
 * The provider only needs a small slice of the VS Code API, so a local stub lets the
 * tooltip behavior run under Node/Electron with the same data and parser as the extension.
 */

const Module = require('module');
const path = require('path');

class Range {
  constructor(startLine, startCharacter, endLine, endCharacter) {
    this.start = { line: startLine, character: startCharacter };
    this.end = { line: endLine, character: endCharacter };
  }
}

class MarkdownString {
  constructor(value) {
    this.value = value;
    this.supportHtml = false;
    this.isTrusted = false;
  }
}

class Hover {
  constructor(contents, range) {
    this.contents = contents;
    this.range = range;
  }
}

const settingOverrides = {};

const vscodeStub = {
  Range,
  MarkdownString,
  Hover,
  workspace: {
    getConfiguration() {
      return {
        get(key, fallback) {
          return Object.prototype.hasOwnProperty.call(settingOverrides, key)
            ? settingOverrides[key] : fallback;
        }
      };
    }
  }
};

const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (request === 'vscode') return vscodeStub;
  return originalLoad.call(this, request, parent, isMain);
};

const { SassHoverProvider } = require(path.join(__dirname, '..', 'src', 'hover.js'));

let checks = 0;
let failures = 0;

function check(condition, what, detail = '') {
  checks++;
  if (condition) return;
  failures++;
  console.log(`  FAIL  ${what}`);
  if (detail) console.log(`        ${detail}`);
}

const lines = [
  '\t.headerflags\t@"EF_CUDA_64BIT_ADDRESS EF_CUDA_SM86"',
  '        /*0120*/              @!P5 LDG.E.STRONG.SM R11, [R12.U32+UR4] ;',
  '        /*0130*/                   STG.E.128.STRONG.SM [R19.U32+UR4], R0 ;',
  'IMAD.MOV.U32 R0, RZ, RZ, 0x3f800000',
  'IPA.PASS R4, a[0x7c]',
  '01:-:-:Y:d      ISETP.GE.AND P0, PT, R0, 0x80, PT ;',
  'FSETP.GEU.FTZ.AND P1, PT, R4, RZ, PT ;',
  'FFMA.FTZ R38, R41, R31.reuse, R38 ;',
  'FSEL R2, -R3, |R4|, !P0 ;',
  'UISETP.GE.U32.AND UP0, UPT, UR4, 0x100, UPT ;',
  'PSETP.AND.OR P2, PT, P0, !P1, P3 ;',
  'LOP3.LUT R42, R42, 0xfffdffff, RZ, 0xc0, !PT ;',
  'PLOP3.LUT P0, PT, P1, P2, P3, 0x80, 0x0 ;',
  '        /*0020*/ [B--2---:R3:W0:Y:S04]  IMAD R2, R0, c[0x0][0x0], R3 ;',
  '        /*0030*/ [B------:R-:W-:-:S00]  IADD3 R5, R2, UR4, RZ ;'
];

const document = {
  lineCount: lines.length,
  lineAt(line) {
    return { text: lines[line] };
  }
};

const provider = new SassHoverProvider();

function hoverAt(line, needle, within = 0) {
  const start = lines[line].indexOf(needle);
  if (start < 0) throw new Error(`missing test needle: ${needle}`);
  return provider.provideHover(document, { line, character: start + within });
}

function body(hover) {
  return hover && hover.contents ? hover.contents.value : '';
}

console.log('\n1. Opcode and postfix tooltips');

{
  const hover = hoverAt(1, 'LDG', 1);
  check(body(hover).includes('Load from Global Memory'), 'opcode hover includes its description',
    body(hover));
  check(body(hover).includes('Ampere / Ada'), 'opcode hover reports architecture availability',
    body(hover));
}
{
  const hover = hoverAt(1, '.STRONG', 2);
  check(body(hover).includes('Strongly-ordered access'), 'postfix hover resolves semantics',
    body(hover));
  check(body(hover).includes('Source:'), 'postfix hover exposes provenance', body(hover));
}
{
  const hover = hoverAt(4, 'IPA', 1);
  check(body(hover).includes('graphics-pipeline instruction'),
    'graphics opcode hover distinguishes reconstructed documentation', body(hover));
}

console.log('\n2. Operand tooltips');

{
  const hover = hoverAt(1, 'R11', 1);
  check(body(hover).includes('general-purpose registers'),
    'vector register hover identifies its class',
    body(hover));
  check(body(hover).includes('Destination'), 'load destination hover reports its role', body(hover));
}
{
  const hover = hoverAt(1, 'UR4', 1);
  check(body(hover).includes('Uniform register'), 'uniform register hover identifies its class',
    body(hover));
  check(body(hover).includes('Source'), 'address register hover reports source role', body(hover));
}
{
  const hover = hoverAt(3, '0x3f800000', 3);
  check(body(hover).includes('| as float32 | 1 |'),
    'immediate hover reinterprets a float bit pattern', body(hover));
}
{
  const hover = hoverAt(4, 'a[0x7c]', 2);
  check(body(hover).includes('1/w'), 'attribute hover resolves a known slot', body(hover));
}

console.log('\n3. Address and control-code tooltips');

{
  const hover = hoverAt(1, '/*0120*/', 3);
  check(body(hover).includes('Instruction #18'), 'address hover computes the instruction index',
    body(hover));
}
{
  const hover = hoverAt(5, 'Y');
  check(body(hover).includes('yield hint'), 'control-column hover resolves the selected field',
    body(hover));
  check(body(hover).includes('Control code') && !body(hover).includes('Volta+'),
    'a colon-separated column is documented with the Maxwell-era spec', body(hover));
}
{
  // The two eras count scoreboards differently. Mixing the wording is the failure mode worth
  // testing for: Maxwell's wait field is a hex mask over barriers 1-6, this one is positional.
  const hover = hoverAt(13, 'B--2---', 4);
  check(body(hover).includes('Control code (Volta+)'),
    'a bracketed column is documented with the Volta+ spec', body(hover));
  check(body(hover).includes('wait mask') && body(hover).includes('scoreboard 2'),
    'the Volta+ wait field names the scoreboard it waits on positionally', body(hover));
  check(!/\bmask of scoreboard barriers\b/i.test(body(hover)),
    'the Volta+ hover never reuses the Maxwell mask wording', body(hover));
}
{
  const hover = hoverAt(13, 'S04', 1);
  check(body(hover).includes('**4**') && body(hover).includes('cycles'),
    'the Volta+ stall count reads as 4 decimal cycles, not 0x04', body(hover));
}
{
  const hover = hoverAt(13, 'W0', 1);
  check(body(hover).includes('scoreboard 0'),
    'the Volta+ write field names the scoreboard it arms', body(hover));
}
{
  const hover = hoverAt(14, 'B------', 3);
  check(body(hover).includes('Waits on nothing'),
    'an empty Volta+ wait mask says so', body(hover));
}
{
  const hover = hoverAt(14, 'R-', 1);
  check(body(hover).includes('Arms no scoreboard'),
    'an unarmed Volta+ read scoreboard says so', body(hover));
}

console.log('\n4. Elaborate opcode tooltips');

settingOverrides['hover.detail'] = 'elaborate';
{
  const hover = hoverAt(3, 'IMAD', 1);
  check(body(hover).includes('#### Algorithm'), 'elaborate hover adds an algorithm section',
    body(hover));
  check(body(hover).includes('`R0 = RZ × RZ + 0x3f800000`'),
    'elaborate IMAD hover binds registers and a literal in the formula', body(hover));
  check(body(hover).includes('writes `R0`') && body(hover).includes('reads `RZ`'),
    'elaborate hover summarizes roles in the current instruction', body(hover));
  check(body(hover).includes('#### Active postfixes') && body(hover).includes('`.MOV`'),
    'elaborate hover decodes active postfixes', body(hover));
}
{
  const hover = hoverAt(7, 'FFMA', 1);
  check(body(hover).includes('`R38 = R41 × R31 + R38`'),
    'FFMA formula uses the current operands and omits the reuse-cache hint', body(hover));
}
{
  const hover = hoverAt(8, 'FSEL', 1);
  check(body(hover).includes('`R2 = !P0 ? -R3 : |R4|`'),
    'contextual formula retains negation and absolute-value decorators', body(hover));
}
{
  const load = hoverAt(1, 'LDG', 1);
  const store = hoverAt(2, 'STG', 1);
  check(body(load).includes('`R11 = memory[R12.U32+UR4]`'),
    'load formula binds its destination and complete address', body(load));
  check(body(store).includes('`memory[R19.U32+UR4] = R0`'),
    'store formula binds its complete address and stored value', body(store));
}
{
  const hover = hoverAt(5, 'ISETP', 1);
  check(body(hover).includes('`t = s32(R0) >= s32(0x80)`'),
    'ISETP hover decodes the comparison and its actual operands', body(hover));
  check(body(hover).includes('`P0 = (t) AND PT`') &&
        body(hover).includes('`PT = (NOT t) AND PT`'),
    'ISETP hover explains primary and complementary predicate outputs', body(hover));
}
{
  const hover = hoverAt(6, 'FSETP', 1);
  check(body(hover).includes('`a′ = ftz(R4); b′ = ftz(RZ)`'),
    'FSETP hover explains FTZ preprocessing', body(hover));
  check(body(hover).includes('OR unordered(a′, b′)'),
    'FSETP hover decodes unordered floating comparison semantics', body(hover));
}
{
  const hover = hoverAt(9, 'UISETP', 2);
  check(body(hover).includes('`t = u32(UR4) >= u32(0x100)`') &&
        body(hover).includes('`UP0 = (t) AND UPT`'),
    'uniform integer SETP uses its uniform registers and predicates', body(hover));
}
{
  const hover = hoverAt(10, 'PSETP', 2);
  check(body(hover).includes('`t = (P0) AND (!P1)`') &&
        body(hover).includes('`P2 = (t) OR P3`'),
    'predicate SETP decodes both Boolean postfixes with current operands', body(hover));
}
{
  const hover = hoverAt(11, 'LOP3', 2);
  check(body(hover).includes('Equivalent Boolean operation: `R42 = R42 AND 0xfffdffff`'),
    'LOP3 hover translates a constant truth table to bound Boolean logic', body(hover));
}
{
  const hover = hoverAt(12, 'PLOP3', 2);
  check(body(hover).includes('`P0 = (P1 AND P2 AND P3)`') &&
        body(hover).includes('`PT = false`'),
    'PLOP3 hover decodes both predicate truth-table outputs', body(hover));
}
delete settingOverrides['hover.detail'];

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'}  ${checks} checks, ${failures} failures`);
process.exit(failures === 0 ? 0 : 1);
