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
const SPV = path.join(__dirname, 'fixtures', 'gfx');
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

section('5b. How many files the shader spans, asked of the SPIR-V');

// The guard that decides whether correlation is safe at all, and the reason it reads the
// SPIR-V rather than the line table.
//
// amdllpc collapses every DIFile into one. Measured on `twofile-g1.spv` - a compute shader
// that `#include`s a helper - the SPIR-V names both files correctly and the DWARF that comes
// out names only ONE, and it is the INCLUDED file. So the main file's instructions would be
// attributed to a file they never came from, at line numbers belonging to the other file.
//
// The first version of this guard counted the DWARF's files and was therefore dead code: one
// file in, one file out, guard never fires, attributions silently wrong. These fixtures exist
// so it cannot quietly become dead again.
const compileMod = require(path.join(__dirname, '..', 'src', 'compile.js'));

const twoFile = fs.readFileSync(path.join(FIXTURES, 'twofile-g1.spv'));
const oneFile = fs.readFileSync(path.join(FIXTURES, 'onefile-g1.spv'));

check(compileMod.spirvLineFiles(twoFile).size === 2,
  'a shader that includes another names two files in its OpLine records',
  [...compileMod.spirvLineFiles(twoFile)].join(', '));
check(compileMod.spirvLineFiles(oneFile).size === 1,
  'and one that does not names one',
  [...compileMod.spirvLineFiles(oneFile)].join(', '));

// PATHS, not <id>s. A result id is per-module, so `%12` in a vertex module and `%12` in a
// fragment module are unrelated - counting ids per module and taking the largest scores 1 for
// a pipeline whose two stages each name one file, but two DIFFERENT files.
check([...compileMod.spirvLineFiles(twoFile)].every(f => typeof f === 'string' && f.length > 3),
  'and they come back as paths, so they can be unioned across a pipeline',
  [...compileMod.spirvLineFiles(twoFile)].join(', '));
const union = new Set([...compileMod.spirvLineFiles(twoFile),
  ...compileMod.spirvLineFiles(oneFile)]);
check(union.size === 3, 'unioning two modules counts every distinct file once',
  `${union.size}`);

// The same call is what proves `-g1` did anything at all. A future Slang whose `-g1` stops
// emitting OpLine must lose the road rather than keep it on an assumption.
check(compileMod.spirvLineFiles(fs.readFileSync(path.join(SPV, 'fs.spv'))).size === 0,
  'a module compiled WITHOUT -g1 reports no files, which is what turns the road off',
  String(compileMod.spirvLineFiles(fs.readFileSync(path.join(SPV, 'fs.spv'))).size));
check(compileMod.spirvLineFiles(Buffer.from('this is not spirv at all, but long enough')).size === 0,
  'and something that is not SPIR-V reports none rather than throwing');
check(compileMod.spirvLineFiles(Buffer.alloc(4)).size === 0,
  'as does a buffer too short to hold a header');

section('6. A hole survives the round trip through the banner');

// The banner is not a cache - it IS the correlation, read back when a saved listing is
// reopened. So a hole has to be expressible there, or an instruction in compiler-generated
// code inherits the previous source line the moment the file is closed and opened again.
const correlate = require(path.join(__dirname, '..', 'src', 'correlate.js'));

const withHole = [
  { address: 0x000, file: 'D:\\shaders\\x.slang', line: 10 },
  { address: 0x100, file: null, line: null },
  { address: 0x200, file: 'D:\\shaders\\x.slang', line: 20 }
];
const labels = correlate.labelsFor(['D:\\shaders\\x.slang']);
const mapLines = correlate.bannerLines(withHole, labels);
check(mapLines.length === 3, 'the map has a line per run, holes included', mapLines.join(' | '));
check(/^@0100 -$/.test(mapLines[1]), 'and the hole is written as a dash', mapLines[1]);

const banner = mapLines.map(l => `// ${' '.repeat(14)}  ${l}`).join('\n') + '\nsomething:\n';
const runs = correlate.readAddressMap(banner);
check(runs.length === 3, 'all three read back', `${runs.length}`);
check(runs[1].line === null && runs[1].label === null,
  'the hole reads back as a run with no position');

check(correlate.positionAt(runs, 0x050) && correlate.positionAt(runs, 0x050).line === 10,
  'an address in the first run gets line 10');
check(correlate.positionAt(runs, 0x180) === null,
  'an address INSIDE THE HOLE gets nothing - not line 10, which is the whole point');
check(correlate.positionAt(runs, 0x240) && correlate.positionAt(runs, 0x240).line === 20,
  'and the run after the hole resumes normally');

// The NVIDIA form must be untouched by all of this.
const plain = `// ${' '.repeat(14)}  @0000 k.cu:7\ncode:\n`;
const plainRuns = correlate.readAddressMap(plain);
check(plainRuns.length === 1 && plainRuns[0].line === 7 && plainRuns[0].label === 'k.cu',
  'an ordinary NVIDIA map entry still reads exactly as before',
  JSON.stringify(plainRuns));

section('6b. What survives a hostile or half-written file');

// Every one of these was a real failure before it was a check. A code object is a file on
// disk that another process is writing, and correlation is a decoration on a listing that has
// already compiled - none of these may take the listing down with them.

check(dwarf.addressesAreTextRelative(buf.subarray(0, 4096)) === false,
  'a truncated code object answers false rather than throwing RangeError');
let survived = true;
for (let cut = 64; cut < buf.length; cut += 512) {
  try {
    dwarf.addressesAreTextRelative(buf.subarray(0, cut));
    dwarf.sections(buf.subarray(0, cut));
  } catch (e) {
    survived = false;
    check(false, `truncating to ${cut} bytes threw`, e.message);
    break;
  }
}
check(survived, 'and no truncation of this fixture throws at all');

// A corrupt directory-entry count used to allocate until V8 died - 25 seconds and 3.7 GB from
// a 41-byte section, because uleb past the end of a Buffer reads undefined, becomes 0, and
// never terminates the loop. The bound is the bytes remaining: an entry is at least one byte.
const corrupt = Buffer.from(buf);
const lineSection = dwarf.sections(buf).get('.debug_line');
const lineAt = buf.indexOf(lineSection.subarray(0, 32));
check(lineAt > 0, 'the .debug_line section is locatable for corruption');
// The directory-table entry count sits after the header params; overwrite a wide span of the
// table with 0xff so whatever ULEB it lands on decodes as enormous.
for (let i = lineAt + 15; i < lineAt + 30 && i < corrupt.length; i++) corrupt[i] = 0xff;
const started = Date.now();
let threw = null;
try {
  dwarf.decode(corrupt);
} catch (e) {
  threw = e.message;
}
const took = Date.now() - started;
check(took < 3000, 'a corrupt entry count returns quickly instead of allocating forever',
  `${took}ms${threw ? `, threw: ${threw.slice(0, 60)}` : ''}`);

section('7. The editor resolves an RDNA listing line to a source line');

// The whole point, end to end: a saved AMD listing with its banner map, read back the way the
// editor reads it. This is what `revealSource` and the definition provider run on, and it
// exercises the one thing that had to change in correlate.js - nvdisasm writes the address in
// a LEADING `/*hex*/` and RGA in a TRAILING `// hex:`, and readMarkers scans for it.
const fragLabels = correlate.labelsFor(files);

// Narrowed to this listing first, as openEntry does. The line table covers the whole
// pipeline - vertex at 0x0, fragment at 0x200, one .text - while RGA writes one file per
// stage, so the unfiltered set put 17 of 47 runs in the fragment banner at addresses that
// listing does not contain, and inflated its run and line counts to match.
const forFrag = dwarf.forListing(records, fragAddresses);

const document = [
  ...correlate.bannerLines(forFrag, fragLabels).map(l => `// ${' '.repeat(14)}  ${l}`),
  '',
  ...frag.split('\n')
].join('\n');

check(forFrag.length < records.length,
  'the whole-pipeline table is narrowed to the listing being read',
  `${forFrag.length} of ${records.length} runs`);
check(forFrag.every(r => r.address >= Math.min(...fragAddresses) &&
  r.address <= Math.max(...fragAddresses)),
  'and every surviving run is inside the listing\'s own address range');
check(forFrag.length > 0 && forFrag[0].address === Math.min(...fragAddresses),
  'the run covering the first instruction is kept, re-based so it points inside',
  forFrag.length ? `0x${forFrag[0].address.toString(16)}` : 'none');

// A space in the file name used to lose the map silently: 47 rows written, 5 read back.
const spaced = correlate.labelsFor(['D:\\a b\\surface shading.slang']);
const spacedRow = correlate.bannerLines(
  [{ address: 0x10, file: 'D:\\a b\\surface shading.slang', line: 12 }], spaced);
const spacedBack = correlate.readAddressMap(`// ${' '.repeat(14)}  ${spacedRow[0]}\ncode:\n`);
check(spacedBack.length === 1 && spacedBack[0].line === 12,
  'a file name containing a space still round-trips through the banner',
  `${spacedRow[0]} -> ${JSON.stringify(spacedBack)}`);
check(spacedBack.length === 1 && spacedBack[0].label === 'surface shading.slang',
  'with the label intact', spacedBack.length ? spacedBack[0].label : 'none');

const marks = correlate.readMarkers(document);
check(marks.byListingLine.size > 50,
  'most instruction lines in the listing resolve to a source position',
  `${marks.byListingLine.size} lines`);

// The banner's own rows must not be indexed as if they were code - that bug scrolled the
// listing back up to its own header.
const bannerRows = correlate.bannerLines(forFrag, fragLabels).length;
check([...marks.byListingLine.keys()].every(i => i > bannerRows),
  'and no banner row is mistaken for an instruction',
  [...marks.byListingLine.keys()].filter(i => i <= bannerRows).join(', '));

// Resolve one known line by content rather than by index, so the check survives the fixture
// being regenerated.
const docLines = document.split('\n');
const alphaTest = docLines.findIndex(l => /0x3d4ccccd/i.test(l));
check(alphaTest > 0, 'the listing contains the alpha-test compare');
const resolved = marks.byListingLine.get(alphaTest);
check(resolved && resolved.line === 137,
  'and it resolves to line 137 - the `if (albedo.a < 0.05f)` the constant belongs to',
  resolved ? `line ${resolved.line}` : 'unresolved');

check(marks.bySourceLine && marks.bySourceLine.size > 0,
  'the reverse direction is populated too, so source -> listing works',
  marks.bySourceLine ? `${marks.bySourceLine.size} source lines` : 'none');

console.log(`\n${failures ? 'FAIL' : 'PASS'}  ${checks} checks, ${failures} failures`);
process.exit(failures ? 1 : 0);
