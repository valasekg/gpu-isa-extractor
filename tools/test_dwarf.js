'use strict';

/**
 * Reading the line table out of an AMD code object.
 *
 * Needs nothing installed. The fixture `fixtures/rdna/surface-shading-debug.elf` is a real
 * code object, produced from `samples/surface-shading.slang` by
 *
 *     slangc -target spirv -entry {vsMain,fsMain} -stage {vertex,fragment} -g1 -o *.spv
 *     amdllpc -v --include-llvm-ir --auto-layout-desc --trim-debug-info=false \
 *             -o=dbg.elf --gfxip=12.0.1 vsMain.spv fsMain.spv
 *
 * with RGA 2.14.2's bundled amdllpc, and `surface-shading-{frag,vert}.isa` are RGA's own
 * listings from the SAME SPIR-V in the same run. That pairing is the point: the whole road
 * rests on the claim that the line table describes the code RGA disassembled, and the only way
 * to hold it to that is to keep both halves and check them against each other.
 *
 * The expected rows below were cross-checked against four independently written decoders.
 *
 *   ELECTRON_RUN_AS_NODE=1 Code.exe tools/test_dwarf.js
 */

const fs = require('fs');
const path = require('path');

const dwarf = require(path.join(__dirname, '..', 'src', 'dwarf_line.js'));
const parseRdna = require(path.join(__dirname, '..', 'src', 'parse_rdna.js'));

const FIXTURES = path.join(__dirname, 'fixtures', 'rdna');
const ELF = path.join(FIXTURES, 'surface-shading-debug.elf');

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

const buf = fs.readFileSync(ELF);

section('1. The ELF');

const secs = dwarf.sections(buf);
check(secs.has('.debug_line'), 'the code object carries a line table');
check(secs.has('.debug_line_str'),
  'and the string table its file names live in - which is why .debug_str_offsets, the ' +
  'section amdllpc emits malformed, is never needed');
check(secs.has('.text'), 'and the code the table describes');
check(secs.get('.debug_line').length === 312,
  'the line table is the size it was measured at', `${secs.get('.debug_line').length} bytes`);

check(dwarf.addressesAreTextRelative(buf),
  'and .text is based at zero, so line-table addresses are listing addresses unchanged');

// A section reader that returned a neighbouring section's bytes for a NOBITS section would
// corrupt whatever read it. Cheap to assert, and the failure would be baffling.
check(dwarf.sections(Buffer.alloc(0)).size === 0, 'an empty buffer yields no sections');
check(dwarf.sections(Buffer.from('not an elf at all, but long enough to read a header from it '
  .repeat(2))).size === 0, 'and something that is not an ELF yields none either');

section('2. Every unit, not just the first');

const { units, rows } = dwarf.decode(buf);

// This is the check that matters most. llvm-objdump reads the first unit and stops, which on
// this very file means it reports the vertex shader and NOTHING for the fragment shader -
// indistinguishable from "this shader has no debug info".
check(units.length === 3, 'three compile units are found', `${units.length}`);
check(units[1].rows.length === 0,
  'the middle one is the artificial spirv.dbg.cu unit and carries no rows');
check(units[0].rows.length > 0 && units[2].rows.length > 0,
  'while the two either side both do - a decoder that stopped at the first would lose one',
  units.map(u => u.rows.length).join(', '));
check(rows.length === 52, 'and 52 rows in total', `${rows.length}`);

section('3. The rows say what the shader says');

const named = rows.filter(r => r.fileName && /surface-shading\.slang$/.test(r.fileName));
check(named.length > 40, 'most rows name the original .slang file, not a generated one',
  `${named.length} of ${rows.length}`);
check(rows.some(r => r.fileName && /^[A-Za-z]:\\/.test(r.fileName)),
  'and carry the full path, joined from the directory table');

const at = a => rows.find(r => r.address === a);
check(at(0x29c) && at(0x29c).line === 137 && at(0x29c).column === 5,
  '0x29c is line 137 column 5', at(0x29c) && `${at(0x29c).line}:${at(0x29c).column}`);
check(at(0x2a4) && at(0x2a4).line === 137 && at(0x2a4).column === 27,
  'and 0x2a4 is the same line at column 27 - columns are real, not padding',
  at(0x2a4) && `${at(0x2a4).line}:${at(0x2a4).column}`);
check(at(0x3bc) && at(0x3bc).line === 144, '0x3bc is line 144',
  at(0x3bc) && String(at(0x3bc).line));

// The attributions are checked against the SOURCE rather than against themselves. Line 137 of
// the sample is the alpha test; if the decoder were off by a unit or a file, this would still
// produce plausible-looking numbers, and only reading the source catches that.
const source = fs.readFileSync(
  path.join(__dirname, '..', 'samples', 'surface-shading.slang'), 'utf8').split(/\r?\n/);
check(/0\.05f/.test(source[136] || ''),
  'line 137 of the sample is the one testing against 0.05f', (source[136] || '').trim());

const frag = fs.readFileSync(path.join(FIXTURES, 'surface-shading-frag.isa'), 'utf8');
const at29c = frag.split('\n').find(l => /\/\/\s*00000000029C:/i.test(l)) || '';
check(/0x3d4ccccd/i.test(at29c),
  'and the instruction at 0x29c in RGA\'s own listing carries 0.05f as a literal - so the ' +
  'table and the disassembly are describing the same instruction', at29c.trim());

section('4. Line 0 is a hole, not a line');

check(rows.some(r => r.line === 0),
  'the table really does contain line-0 rows, so this is not a hypothetical');

const { records, files } = dwarf.records(buf);
check(records.some(r => r.line === null),
  'which become records with no position rather than an attribution to line 0');
check(!records.some(r => r.line === 0),
  'and line 0 never survives as a line number');
check(files.length === 1 && /surface-shading\.slang$/.test(files[0]),
  'one source file is named', files.join(', '));

section('5. Attribution uses the listing\'s own addresses');

// The stride problem, concretely. RDNA instructions are 4, 8 or 12 bytes, so any fixed step
// invents addresses; this is why correlate.byAddress must never be called for AMD.
const fragAddresses = [];
for (const line of frag.split('\n')) {
  const m = /\/\/\s*([0-9A-Fa-f]{8,16}):/.exec(line);
  if (m && parseRdna.parseLine(line)) fragAddresses.push(parseInt(m[1], 16));
}
check(fragAddresses.length > 60, 'the fragment listing parses to real instruction addresses',
  `${fragAddresses.length}`);

const gaps = new Set();
for (let i = 1; i < fragAddresses.length; i++) {
  gaps.add(fragAddresses[i] - fragAddresses[i - 1]);
}
check(gaps.size > 1,
  'whose spacing is genuinely variable, so no stride could walk them',
  [...gaps].sort((a, b) => a - b).join(', '));

const positions = dwarf.positionsFor(records, fragAddresses);
check(positions.size > 0, 'and those addresses get positions', `${positions.size}`);
check([...positions.keys()].every(a => fragAddresses.includes(a)),
  'every attributed address is one an instruction actually starts at - no invented addresses');
check(positions.size < fragAddresses.length,
  'while some instructions get none, which is the honest state and must stay representable',
  `${positions.size} of ${fragAddresses.length}`);

const p29c = positions.get(0x29c);
check(p29c && p29c.line === 137, 'the join lands 0x29c on line 137',
  p29c ? String(p29c.line) : 'unattributed');

// A hole must actually suppress attribution rather than let the previous run run on.
const vert = fs.readFileSync(path.join(FIXTURES, 'surface-shading-vert.isa'), 'utf8');
const vertAddresses = [];
for (const line of vert.split('\n')) {
  const m = /\/\/\s*([0-9A-Fa-f]{8,16}):/.exec(line);
  if (m && parseRdna.parseLine(line)) vertAddresses.push(parseInt(m[1], 16));
}
const vertPositions = dwarf.positionsFor(records, vertAddresses);
check(vertPositions.size < vertAddresses.length * 0.8,
  'the vertex shader is mostly unattributed, because Slang lowers it into an NGG wrapper ' +
  'that has no source behind it - stated rather than papered over',
  `${vertPositions.size} of ${vertAddresses.length}`);
check([...vertPositions.values()].every(p => p.line > 0),
  'and nothing it DID attribute claims line 0');

// The two stages share one address space; a vertex address must never pick up a fragment run.
check([...vertPositions.keys()].every(a => a < 0x200),
  'vertex addresses all sit below the fragment shader\'s base, so the stages do not bleed');

console.log(`\n${failures ? 'FAIL' : 'PASS'}  ${checks} checks, ${failures} failures`);
process.exit(failures ? 1 : 0);
