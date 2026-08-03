'use strict';

/**
 * Control-code decoding: bit placement, column rendering, and the honesty tripwire.
 *
 * Every vector here is built by *constructing* the bits, so a failure points at the decoder
 * rather than at a captured sample nobody can re-derive. The one captured vector at the end
 * is the exception, and it is what pins the layout to a real instruction.
 *
 *   ELECTRON_RUN_AS_NODE=1 Code.exe tools/test_ctrl.js
 */

const path = require('path');
const ctrl = require(path.join(__dirname, '..', 'src', 'ctrl.js'));
const { parseLine } = require(path.join(__dirname, '..', 'src', 'parse.js'));

let checks = 0;
let failures = 0;

function check(condition, what, detail = '') {
  checks++;
  if (condition) return;
  failures++;
  console.log(`  FAIL  ${what}`);
  if (detail) console.log(`        ${detail}`);
}

function section(title) {
  console.log(`\n${title}`);
}

/** Build the high word from field values, the inverse of the decoder. */
function hiWord({ stall = 0, yieldBit = 0, writeSB = 7, readSB = 7, waitMask = 0, reuse = 0 }) {
  return (BigInt(stall) << 41n) | (BigInt(yieldBit) << 45n) | (BigInt(writeSB) << 46n) |
    (BigInt(readSB) << 49n) | (BigInt(waitMask) << 52n) | (BigInt(reuse) << 58n);
}

function column(fields) {
  return ctrl.formatColumn(ctrl.decodeControl(hiWord(fields)));
}

/* --------------------------------------------------- 1. field placement --- */

section('1. Field placement');

{
  const decoded = ctrl.decodeControl(hiWord({
    stall: 4, yieldBit: 1, writeSB: 0, readSB: 7, waitMask: 0b000100, reuse: 0
  }));
  check(decoded.stall === 4, 'stall decodes', JSON.stringify(decoded));
  check(decoded.yield === 1, 'yield decodes', JSON.stringify(decoded));
  check(decoded.writeSB === 0, 'write scoreboard decodes', JSON.stringify(decoded));
  check(decoded.readSB === 7, 'an unarmed read scoreboard decodes as 7', JSON.stringify(decoded));
  check(decoded.waitMask === 0b000100, 'wait mask decodes', JSON.stringify(decoded));
}

// Each field has to be independent: setting one must not disturb its neighbours. Sweeping
// every value of every field is what catches a shift that is off by one.
{
  const drift = [];
  const fields = [
    ['stall', 16, f => f.stall], ['yieldBit', 2, f => f.yield],
    ['writeSB', 8, f => f.writeSB], ['readSB', 8, f => f.readSB],
    ['waitMask', 64, f => f.waitMask], ['reuse', 16, f => f.reuse]
  ];
  for (const [name, range, read] of fields) {
    for (let v = 0; v < range; v++) {
      const decoded = ctrl.decodeControl(hiWord({ writeSB: 0, readSB: 0, [name]: v }));
      if (read(decoded) !== v) drift.push(`${name}=${v} read back ${read(decoded)}`);
      // Nothing else may move. Compare against a baseline with the same defaults.
      const base = ctrl.decodeControl(hiWord({ writeSB: 0, readSB: 0 }));
      for (const [other, , otherRead] of fields) {
        if (other === name) continue;
        if (otherRead(decoded) !== otherRead(base)) {
          drift.push(`${name}=${v} disturbed ${other}`);
        }
      }
    }
  }
  check(drift.length === 0, 'every field decodes independently across its whole range',
    drift.slice(0, 6).join('; '));
}

// Bits outside [41,62) belong to the opcode and operands and must be ignored entirely.
{
  const clean = ctrl.decodeControl(hiWord({ stall: 7, writeSB: 2, waitMask: 0b010010 }));
  const noisy = ctrl.decodeControl(
    hiWord({ stall: 7, writeSB: 2, waitMask: 0b010010 }) | 0x000003ffffffffffn | (0x3n << 62n));
  check(JSON.stringify(clean) === JSON.stringify(noisy),
    'bits outside [41,62) do not leak into the control fields',
    `${JSON.stringify(clean)} vs ${JSON.stringify(noisy)}`);
}

/* ------------------------------------------------- 2. column rendering ---- */

section('2. Column rendering');

check(column({ stall: 4, yieldBit: 1, writeSB: 0, readSB: 7, waitMask: 0b000100 })
  === '[B--2---:R-:W0:Y:S04]', 'the worked example renders as documented',
  column({ stall: 4, yieldBit: 1, writeSB: 0, readSB: 7, waitMask: 0b000100 }));

check(column({}) === '[B------:R-:W-:-:S00]',
  'an instruction with no scheduling metadata renders as all-clear', column({}));

check(column({ stall: 15, yieldBit: 1, writeSB: 5, readSB: 4, waitMask: 0b111111 })
  === '[B012345:R4:W5:Y:S15]', 'a fully-loaded instruction renders every field',
  column({ stall: 15, yieldBit: 1, writeSB: 5, readSB: 4, waitMask: 0b111111 }));

check(column({ waitMask: 0b000001 }) === '[B0-----:R-:W-:-:S00]' &&
      column({ waitMask: 0b100000 }) === '[B-----5:R-:W-:-:S00]',
  'the wait mask is positional - scoreboard 0 is leftmost, 5 rightmost');

check(column({ stall: 9 }).includes('S09') && column({ stall: 10 }).includes('S10'),
  'the stall count is decimal and zero-padded to a fixed width');

// The Maxwell column prints the same 4 as hex `4` in a one-character field; this one prints
// two decimal digits. Confusing them is the whole reason the format is bracketed and tagged.
check(column({ stall: 12 }).includes('S12') && !column({ stall: 12 }).includes('Sc'),
  'a stall of 12 prints as decimal 12, never hex c');

{
  const bad = [];
  for (let stall = 0; stall < 16; stall++) {
    for (const waitMask of [0, 1, 0b101010, 0b111111]) {
      for (const sb of [0, 3, 5, 7]) {
        const text = column({ stall, waitMask, readSB: sb, writeSB: sb, yieldBit: stall & 1 });
        if (!ctrl.COLUMN_RE.test(text)) bad.push(text);
      }
    }
  }
  check(bad.length === 0, 'every rendered column matches the format contract',
    bad.slice(0, 4).join(' '));
}

/* --------------------------------------- 3. contract with the parser ------ */

section('3. Contract with the language layer');

{
  // The column is only useful if the extension's own parser reads back what it wrote.
  const rendered = column({ stall: 4, yieldBit: 1, writeSB: 0, readSB: 7, waitMask: 0b000100 });
  const line = `        /*0000*/ ${rendered}  S2R R0, SR_CTAID.X ;`;
  const parsed = parseLine(line);
  check(!!parsed && !!parsed.controlCode && parsed.controlCode.era === 'volta',
    'parse.js reads back a rendered column as a Volta-era control record');
  if (parsed && parsed.controlCode) {
    const byName = Object.fromEntries(parsed.controlCode.fields.map(f => [f.name, f.text]));
    check(byName.wait === 'B--2---' && byName.write === 'W0' && byName.stall === 'S04',
      'the parsed fields carry the rendered values', JSON.stringify(byName));
    check(!!parsed.opcode && parsed.opcode.text === 'S2R',
      'the opcode survives the inserted column');
  }
}

/* ---------------------------------------------- 4. listing annotation ----- */

section('4. Listing annotation');

{
  // Two instructions: the first arms scoreboard 0, the second waits on it.
  const microcode = Buffer.alloc(32);
  microcode.writeBigUInt64LE(hiWord({ stall: 4, yieldBit: 1, writeSB: 0 }), 8);
  microcode.writeBigUInt64LE(hiWord({ stall: 1, waitMask: 0b000001 }), 24);

  const listing = [
    '\t.headerflags\t@"EF_CUDA_SM86"',
    '        /*0000*/                   S2R R0, SR_CTAID.X ;',
    '        /*0010*/                   IMAD R2, R0, c[0x0][0x0], R3 ;',
    '.L_x_0:',
    ''
  ].join('\n');

  const result = ctrl.annotate(listing, microcode);
  const lines = result.text.split('\n');

  check(result.annotated === 2, 'both instruction lines are annotated', String(result.annotated));
  check(lines[1] === '        /*0000*/ [B------:R-:W0:Y:S04]  S2R R0, SR_CTAID.X ;',
    'the first instruction gets its column', JSON.stringify(lines[1]));
  check(lines[2] === '        /*0010*/ [B0-----:R-:W-:-:S01]  IMAD R2, R0, c[0x0][0x0], R3 ;',
    'the second instruction gets its column', JSON.stringify(lines[2]));
  check(lines[0] === '\t.headerflags\t@"EF_CUDA_SM86"' && lines[3] === '.L_x_0:',
    'non-instruction lines pass through untouched');
  check(lines.length === 5 && lines[4] === '',
    'the line count and trailing newline are preserved', String(lines.length));
  check(result.mismatchTotal === 0, 'a matching listing trips no wire');
}

{
  // Addresses index the microcode directly, so a listing may start anywhere and skip around.
  const microcode = Buffer.alloc(16 * 4);
  microcode.writeBigUInt64LE(hiWord({ stall: 3 }), 8 + 16 * 3);
  const result = ctrl.annotate('        /*0030*/                   NOP ;', microcode);
  check(result.text.includes('[B------:R-:W-:-:S03]'),
    'an address addresses its own instruction, not the line number', result.text);
}

{
  // An address past the end of the microcode must be left alone, not decoded from garbage.
  const result = ctrl.annotate('        /*0100*/                   NOP ;', Buffer.alloc(16));
  check(result.annotated === 0 && result.skipped === 1 && !result.text.includes('['),
    'an address past the end of the microcode is skipped, not guessed', result.text);
}

/* ------------------------------------------------------- 5. tripwire ------ */

section('5. Reuse tripwire');

{
  const microcode = Buffer.alloc(16);
  microcode.writeBigUInt64LE(hiWord({ reuse: 0b0011 }), 8);       // two operands reused

  const agreeing = ctrl.annotate(
    '        /*0000*/                   FFMA R38, R41.reuse, R31.reuse, R38 ;', microcode);
  check(agreeing.mismatchTotal === 0,
    'two decoded reuse bits agree with two printed .reuse flags');

  const disagreeing = ctrl.annotate(
    '        /*0000*/                   FFMA R38, R41.reuse, R31, R38 ;', microcode);
  check(disagreeing.mismatchTotal === 1 && disagreeing.mismatches.length === 1,
    'a disagreement is counted and reported', JSON.stringify(disagreeing.mismatches));
  check(disagreeing.mismatches[0].decoded === 2 && disagreeing.mismatches[0].printed === 1,
    'the tripwire reports both counts so the direction of the drift is visible',
    JSON.stringify(disagreeing.mismatches[0]));
  check(disagreeing.text.includes('[B------:R-:W-:-:S00]'),
    'a tripped wire still annotates - it is a warning, not a hard failure');
}

// The two directions mean different things, and treating them alike makes the wire cry wolf.
// A set bit nvdisasm did not print is normal where the reused slot holds no plain register
// (measured: 2 in 55,424 instructions, all IPA/TEX). A printed flag we did not decode has no
// benign reading at all.
{
  const microcode = Buffer.alloc(16);
  microcode.writeBigUInt64LE(hiWord({ reuse: 0b0001 }), 8);
  const result = ctrl.annotate('        /*0000*/                   IPA.PASS R4, a[0x300] ;',
    microcode);
  check(result.mismatchTotal === 1 && result.extra === 1 && result.missing === 0,
    'a decoded bit with nothing printed counts as extra, not missing',
    JSON.stringify(result.mismatches));
  check(result.suspect === false,
    'and a single extra does not condemn the whole listing');
  check(result.mismatches[0].kind === 'extra', 'the example says which direction it went',
    JSON.stringify(result.mismatches[0]));
}
{
  const microcode = Buffer.alloc(16);                            // no reuse bits set at all
  const result = ctrl.annotate('        /*0000*/                   FFMA R38, R41.reuse, R31, R38 ;',
    microcode);
  check(result.missing === 1 && result.suspect === true,
    'a printed flag we did not decode condemns the listing immediately',
    JSON.stringify(result));
  check(result.mismatches[0].kind === 'missing', 'and is reported as the missing direction');
}
{
  // Widespread extras are the signature of a window that has actually moved.
  const count = 200;
  const microcode = Buffer.alloc(16 * count);
  const lines = [];
  for (let i = 0; i < count; i++) {
    microcode.writeBigUInt64LE(hiWord({ reuse: 0b1111 }), 16 * i + 8);
    lines.push(`        /*${(16 * i).toString(16).padStart(4, '0')}*/                   NOP ;`);
  }
  const result = ctrl.annotate(lines.join('\n'), microcode);
  check(result.extra === count && result.missing === 0 && result.suspect === true,
    'extras above the benign rate condemn the listing even with nothing missing',
    JSON.stringify({ extra: result.extra, suspect: result.suspect }));
}

{
  // The example list is capped, but the total must stay honest: a caller that reported the
  // capped length as "the number of problems" would understate a systematic layout change.
  const count = 50;
  const microcode = Buffer.alloc(16 * count);
  const lines = [];
  for (let i = 0; i < count; i++) {
    microcode.writeBigUInt64LE(hiWord({ reuse: 0b1111 }), 16 * i + 8);
    lines.push(`        /*${(16 * i).toString(16).padStart(4, '0')}*/                   NOP ;`);
  }
  const result = ctrl.annotate(lines.join('\n'), microcode, { maxExamples: 8 });
  check(result.mismatchTotal === count, 'the tripwire total counts every mismatch',
    `${result.mismatchTotal} of ${count}`);
  check(result.mismatches.length === 8, 'the reported examples are capped',
    String(result.mismatches.length));
}

/* ------------------------------------------------ 6. endianness anchor ---- */

section('6. Endianness');

{
  // Pinned byte-for-byte: the control fields live in the HIGH word, read little-endian.
  // A big-endian read, or reading the low word, fails here and nowhere else.
  // yield=1 (bit 45), readSB=7/none (bits 49-51), waitMask=0b000010 (bit 53) puts the high
  // word at 0x002e200000000000, whose little-endian tail is 00 20 2e 00.
  const microcode = Buffer.from('00000000000000000000000000202e00', 'hex');
  const decoded = ctrl.decodeAt(microcode, 0);
  const hi = microcode.readBigUInt64LE(8);
  check(hi === 0x002e200000000000n, 'the high word reads little-endian', hi.toString(16));
  check(decoded.stall === 0 && decoded.yield === 1 && decoded.writeSB === 0 &&
        decoded.readSB === 7 && decoded.waitMask === 0b000010,
    'a literal instruction word decodes to its documented fields',
    JSON.stringify(decoded));
  check(ctrl.formatColumn(decoded) === '[B-1----:R-:W0:Y:S00]',
    'and renders as the expected column', ctrl.formatColumn(decoded));
}

console.log(`\n${failures ? 'FAIL' : 'PASS'}  ${checks} checks, ${failures} failures`);
process.exit(failures ? 1 : 0);
