'use strict';

/**
 * The listing, pinned.
 *
 * Every other suite checks one module against its own contract. This one checks the thing the
 * user actually receives - banner and body, end to end - and it exists to make a refactor
 * prove it changed nothing. That is the whole of its value, so it is deliberately the least
 * clever file here: it computes a listing, and compares it to one recorded earlier.
 *
 * ## Why the gate is in two halves
 *
 * `output.banner` embeds the extension's version, absolute paths, the nvdisasm version string
 * and the exact command line that was run. All of those legitimately differ between machines
 * and between releases, so a byte-exact banner would fail for everyone who did not record it,
 * and a gate that fires when nothing is wrong gets switched off - taking the half that does
 * work with it.
 *
 * So:
 *
 *   the body     pinned BYTE FOR BYTE. It is `ctrl.annotate` over a fixed instruction stream,
 *                and there is nothing machine-dependent in it. If one character moves, the
 *                control column moved, and that is the regression this suite is for.
 *
 *   the banner   pinned as a SKELETON: every field label, in order, with the volatile half of
 *                each value replaced by a token. A field that disappears, is renamed, moves,
 *                or stops being emitted fails. A version bump does not.
 *
 * ## Why the instruction stream is built rather than captured
 *
 * `test_ctrl.js` states the rule this follows: a constructed vector points at the decoder,
 * where a captured sample nobody can re-derive points at nothing. The microcode here is
 * assembled from named control fields by the same inverse function that suite uses, and the
 * disassembly text beside it is written out longhand. Nothing in this file came off a GPU, so
 * it runs identically on a machine with no CUDA, no driver and no NVIDIA hardware - which is
 * also what makes it a usable gate for a refactor rather than a hardware test.
 *
 * ## What this does NOT cover
 *
 * Worth knowing before trusting a green run, because the gaps are structural rather than
 * accidental:
 *
 *   - It pins ONE listing, of `cache` origin. The `compiled` and `driver` provenance rows,
 *     `toolchainLines` and `flagLines` are never rendered here.
 *   - It never loads `compileview.js`, so it says nothing about the compile road. It passed
 *     cleanly across the refactor that left that module unable to parse; the parse sweep in
 *     `verify.py` is what covers that now.
 *   - The banner's tool paths, versions and command line are LITERALS in `goldenResult`, not
 *     values produced by `pipeline.js`. That is what lets this run with no CUDA installed, and
 *     it means a change to how the command is built - a dropped `--no-dataflow`, say - is
 *     invisible here. `test_endtoend.js` is where that is covered, on a machine with a toolkit.
 *
 * Recording, after a change that is *meant* to move the listing:
 *
 *   node tools/test_golden.js --record
 *
 * and then read the diff. That is the point at which someone decides the change was intended;
 * this suite only ensures nobody gets to skip that step.
 *
 *   ELECTRON_RUN_AS_NODE=1 Code.exe tools/test_golden.js
 */

const fs = require('fs');
const path = require('path');
const Module = require('module');

const ROOT = path.join(__dirname, '..');
const GOLDEN = path.join(__dirname, 'fixtures', 'golden');
const RECORD = process.argv.includes('--record');

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

/* --------------------------------------------------------- the vscode stub --- */

// `output.js` requires vscode at module load. The banner itself reads none of it - it takes
// everything from its argument and from package.json - so the stub only has to be present,
// not faithful. `getConfiguration` is stubbed anyway because `listingDir` is one call away and
// a future edit that reaches for a setting should get a default rather than a crash.
const vscodeStub = {
  workspace: {
    getConfiguration: () => ({ get: (_key, fallback) => fallback })
  },
  Uri: { file: p => ({ fsPath: p, scheme: 'file', toString: () => p }) },
  window: {},
  languages: {}
};

const realResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'vscode') return 'vscode';
  return realResolve.call(this, request, ...rest);
};
require.cache.vscode = { id: 'vscode', filename: 'vscode', loaded: true, exports: vscodeStub };

const ctrl = require(path.join(ROOT, 'src', 'ctrl.js'));
const output = require(path.join(ROOT, 'src', 'output.js'));
const stats = require(path.join(ROOT, 'src', 'stats.js'));

/* ------------------------------------------------------ the built instruction stream --- */

/** The inverse of `ctrl.decodeControl`, as `test_ctrl.js` writes it. */
function hiWord({ stall = 0, yieldBit = 0, writeSB = 7, readSB = 7, waitMask = 0, reuse = 0 }) {
  return (BigInt(stall) << 41n) | (BigInt(yieldBit) << 45n) | (BigInt(writeSB) << 46n) |
    (BigInt(readSB) << 49n) | (BigInt(waitMask) << 52n) | (BigInt(reuse) << 58n);
}

/**
 * A kernel that is not real but is representative.
 *
 * Chosen so the banner has something to say in every section it can produce: several
 * instruction categories so `mix` is not one entry, a load and a store so `uses` names
 * families, a scoreboard armed and drained so the scheduling shares are not zero, a
 * BSSY/BSYNC pair and a backward branch so `control flow` reports both, a guard predicate so
 * `guarded` appears, a constant bank and an attribute so those lines appear, and trailing NOP
 * pad so `instructions` reports live-versus-pad.
 *
 * `reuse` is left at 0 throughout and no line carries a `.reuse` suffix, so `ctrl.annotate`'s
 * tripwire agrees with itself and the banner carries no warning. A fixture that tripped it
 * would be pinning the warning text rather than the listing.
 */
const PROGRAM = [
  ['S2R R0, SR_CTAID.X ;', { stall: 4, writeSB: 0, yieldBit: 1 }],
  ['S2R R3, SR_TID.X ;', { stall: 2, writeSB: 1, yieldBit: 1 }],
  ['MOV R1, c[0x0][0x28] ;', { stall: 1 }],
  ['IMAD R0, R0, c[0x0][0x0], R3 ;', { stall: 2, waitMask: 0b000011 }],
  ['IPA R6, a[0x80], RZ ;', { stall: 1 }],
  ['ISETP.GE.AND P0, PT, R0, c[0x0][0x170], PT ;', { stall: 4, yieldBit: 1 }],
  ['BSSY B0, 0x90 ;', { stall: 1 }],
  ['@!P0 BRA 0x80 ;', { stall: 1 }],
  ['LDG.E R4, [R2.64] ;', { stall: 2, writeSB: 2 }],
  ['LDG.E R5, [R2.64+0x4] ;', { stall: 2, writeSB: 2 }],
  ['FFMA R7, R4, R5, R6 ;', { stall: 6, waitMask: 0b000100, yieldBit: 1 }],
  ['STG.E [R2.64], R7 ;', { stall: 1, readSB: 3 }],
  ['BSYNC B0 ;', { stall: 1 }],
  ['BRA 0x30 ;', { stall: 1 }],
  ['EXIT ;', { stall: 1 }],
  ['NOP ;', { stall: 0 }],
  ['NOP ;', { stall: 0 }]
];

function buildProgram() {
  const microcode = Buffer.alloc(PROGRAM.length * ctrl.INSTRUCTION_BYTES);
  const lines = [];
  PROGRAM.forEach(([text, fields], i) => {
    const at = i * ctrl.INSTRUCTION_BYTES;
    // The low word carries the opcode encoding, which nothing here decodes. It is filled with
    // the instruction index rather than zeros so the microcode has a stable, non-degenerate
    // sha1 - a buffer of mostly zeros would hash the same as any other of the same length if
    // the control words ever stopped being written.
    microcode.writeBigUInt64LE(BigInt(i + 1), at);
    microcode.writeBigUInt64LE(hiWord(fields), at + 8);
    lines.push(`        /*${at.toString(16).padStart(4, '0')}*/ ${text}`);
  });
  return {
    microcode,
    // The shape `nvdisasm --binary` emits: a headerflags line, the section comment, then the
    // instructions. `ctrl.annotate` passes anything without an address comment through
    // untouched, and the banner's architecture line is what the hovers read, so both are here.
    text: [
      '\t.headerflags\t@"EF_CUDA_TEXMODE_UNIFIED EF_CUDA_64BIT_ADDRESS EF_CUDA_SM86"',
      '\t\t.elftype\t@"ET_EXEC"',
      '',
      '//--------------------- .text.goldenKernel --------------------------',
      '\t\t.headerflags\t@"EF_CUDA_SM86"',
      '\t\t.sectionflags\t@"SHF_BARRIERS=1"',
      '\t\t.sectioninfo\t@"SHI_REGISTERS=8"',
      '',
      ...lines,
      ''
    ].join('\n')
  };
}

/**
 * A cache object around that stream.
 *
 * `origin: 'cache'` is deliberate: it is the road nearly every listing takes, and it is the
 * only one whose provenance block prints a byte offset. The metadata is set so
 * `stats.crossCheck` finds nothing to complain about - a fixture that pinned a disagreement
 * would be pinning the disagreement text, and the disagreement is what a real listing is
 * supposed to surface rather than what this file is supposed to freeze.
 */
function goldenResult(program) {
  const crypto = require('crypto');
  return {
    text: program.annotated,
    object: {
      name: 'goldenKernel',
      source: 'C:\\caches\\GLCache\\0123456789abcdef.bin',
      offset: 265348,
      codeBytes: program.microcode.length,
      microcode: program.microcode,
      sha1: crypto.createHash('sha1').update(program.microcode).digest('hex'),
      origin: 'cache',
      warnings: [],
      metadata: {
        stage: 'compute',
        stageCode: 5,
        registers: 8,
        registerCap: 255,
        localBytes: 0,
        sharedBytes: 0,
        killsPixels: null
      }
    },
    arch: 'SM86',
    archFrom: 'the arch setting',
    nvdisasm: 'C:\\CUDA\\v12.8\\bin\\nvdisasm.exe',
    nvdisasmVersion: 'Cuda compilation tools, release 12.8, V12.8.55',
    command: '"C:\\CUDA\\v12.8\\bin\\nvdisasm.exe" --binary SM86 --no-dataflow "C:\\scratch\\a.bin"',
    annotation: program.annotation
  };
}

/* ------------------------------------------------------------- canonicalising --- */

/**
 * The banner with everything machine-dependent replaced by a token.
 *
 * Each rule names what it hides and why it has to be hidden. Anything not listed here is
 * pinned exactly - which is the point, because the set of things allowed to vary is the part
 * a reviewer should have to argue for.
 */
const REDACTIONS = [
  // The extension's own version, from package.json. Bumped every release.
  [/\b\d+\.\d+\.\d+\b/g, '<version>'],
  // The nvdisasm banner line, which carries the CUDA release.
  [/Cuda compilation tools.*/g, '<nvdisasm version>'],
  // sha1 of the microcode. Deterministic here, but a fixture edit changes it, and the point of
  // the body half of this gate is that such an edit is visible there rather than only here.
  [/\b[0-9a-f]{40}\b/g, '<sha1>']
];

/**
 * Paths, with the DIRECTORY redacted and the filename kept.
 *
 * The directory is the machine-dependent half - a CUDA install root, a scratch tag, a home
 * directory - and the filename is not: `nvdisasm.exe` is `nvdisasm.exe` everywhere, and a
 * carved object's `.bin` is named from a content hash.
 *
 * Replacing the WHOLE path with one token, which is what this did first, makes every absolute
 * path interchangeable: pointing the `nvdisasm` field at the cache `.bin` - a banner naming
 * the wrong file as the tool that produced it - passed. Replacing it with a token naming the
 * FIELD does not fix that either, because the token then describes the label rather than the
 * value, and a swapped value still lands on its own field's token. Keeping the basename is
 * what makes the two distinguishable, and it costs nothing in portability.
 *
 * The pattern also no longer stops at the first space. `C:\Program Files\...` is the DEFAULT
 * Windows CUDA location, and the old `[^\s"]*` left everything after `Program` in the skeleton
 * while the section-4 guard still passed, because only the drive letter had gone.
 */
const WINDOWS_PATH = /[A-Za-z]:\\[^"\n]*?(?=\s{2,}|"|$)/g;
const POSIX_PATH = /\/(?:[\w.-]+\/)+[\w.-]+/g;

/** `C:\CUDA\v12.8\bin\nvdisasm.exe` -> `<dir>\nvdisasm.exe`. */
function redactDirectory(match) {
  const cut = Math.max(match.lastIndexOf('\\'), match.lastIndexOf('/'));
  return cut < 0 ? '<dir>' : `<dir>${match[cut]}${match.slice(cut + 1)}`;
}

function canonicalise(banner) {
  return banner.split('\n').map(line => {
    let out = line;
    for (const [pattern, token] of REDACTIONS) out = out.replace(pattern, token);
    return out.replace(WINDOWS_PATH, redactDirectory).replace(POSIX_PATH, redactDirectory);
  }).join('\n');
}

/* -------------------------------------------------------------- the fixtures --- */

function compare(name, actual) {
  const file = path.join(GOLDEN, name);
  if (RECORD) {
    fs.mkdirSync(GOLDEN, { recursive: true });
    fs.writeFileSync(file, actual, 'utf8');
    console.log(`  recorded  ${name} (${actual.length} bytes)`);
    return;
  }
  if (!fs.existsSync(file)) {
    check(false, `${name} has been recorded`,
      `no fixture at ${path.relative(ROOT, file)} - run: node tools/test_golden.js --record`);
    return;
  }
  const expected = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  if (expected === actual) {
    check(true, `${name} is unchanged`);
    return;
  }
  check(false, `${name} is unchanged`, firstDifference(expected, actual));
}

/** The first differing line, with its neighbours - a whole-file diff is unreadable here. */
function firstDifference(expected, actual) {
  const a = expected.split('\n');
  const b = actual.split('\n');
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] === b[i]) continue;
    const from = Math.max(0, i - 2);
    const context = a.slice(from, i).map(l => `  ${l}`);
    return [
      `first difference at line ${i + 1}:`,
      ...context,
      `- ${a[i] === undefined ? '(end of recorded fixture)' : a[i]}`,
      `+ ${b[i] === undefined ? '(end of produced listing)' : b[i]}`,
      '',
      'If this change was intended: node tools/test_golden.js --record, then read the diff.'
    ].join('\n');
  }
  return 'the files differ only in trailing newlines';
}

/* -------------------------------------------------------------------- run --- */

section('1. The instruction stream is what it claims to be');

const program = buildProgram();
check(program.microcode.length === PROGRAM.length * 16,
  'the built microcode is one 16-byte word per instruction',
  `${program.microcode.length} bytes for ${PROGRAM.length} instructions`);

const annotation = ctrl.annotate(program.text, program.microcode);
program.annotated = annotation.text;
program.annotation = annotation;

check(annotation.annotated === PROGRAM.length,
  'every instruction got a control column', `annotated ${annotation.annotated}`);
check(annotation.skipped === 0, 'no line was skipped', `skipped ${annotation.skipped}`);
// The tripwire has to be quiet, or this fixture is pinning a warning rather than a listing.
check(annotation.mismatchTotal === 0 && !annotation.suspect,
  'the reuse tripwire agrees with itself on the built stream',
  `${annotation.mismatchTotal} mismatch(es), suspect=${annotation.suspect}`);

section('2. The statistics read the built stream correctly');

const measured = stats.analyze(program.annotated, program.microcode);
check(measured.instructions.total === PROGRAM.length,
  'every instruction is counted', measured.instructions.total);
check(measured.instructions.pad === 2,
  'the trailing NOP pad is recognised', measured.instructions.pad);
check(measured.controlFlow.bssy === 1 && measured.controlFlow.bsync === 1,
  'the BSSY/BSYNC pair is matched',
  `${measured.controlFlow.bssy} BSSY, ${measured.controlFlow.bsync} BSYNC`);
check(measured.controlFlow.backwardBranches === 1,
  'the backward branch is counted', measured.controlFlow.backwardBranches);
check(measured.predicated.count === 1, 'the guarded instruction is counted',
  measured.predicated.count);
check(measured.uses.includes('textures') === false && measured.familyCounts.spills === 0,
  'no family is claimed that the stream does not contain');
check(stats.crossCheck(measured, goldenResult(program).object.metadata).length === 0,
  'the container and the code do not disagree on this fixture',
  stats.crossCheck(measured, goldenResult(program).object.metadata).join('; '));

section('3. The listing is byte for byte what it was');

// The body: `ctrl.annotate` over the built stream. Nothing here varies by machine, so this
// half is pinned exactly.
compare('listing-body.txt', program.annotated);

// The banner: every label in order, volatile values tokenised.
const banner = output.banner(goldenResult(program), { label: 'GLCache blob', scanned: false });
compare('listing-banner.skeleton.txt', canonicalise(banner));

section('4. The skeleton still hides only what it means to hide');

const skeleton = canonicalise(banner);
check(!/\d+\.\d+\.\d+/.test(skeleton.replace(/<version>/g, '')),
  'no bare version number survives canonicalisation');
check(!/[A-Za-z]:\\/.test(skeleton), 'no absolute Windows path survives canonicalisation');
// The half that matters is what SURVIVES: a skeleton that redacted filenames too would pass
// every comparison while being unable to tell one file from another.
check(/<dir>[\\/]nvdisasm\.exe/.test(skeleton),
  'the filename survives redaction, so two paths are still distinguishable', skeleton);
check(/^\/\/ arch\s+:/m.test(banner),
  'the banner still carries the arch field the hovers read');
check(/EF_CUDA_SM86/.test(banner),
  'the banner still carries the literal EF_CUDA_SM<arch> token');
// A skeleton that redacted the whole line would pass every comparison forever.
check(skeleton.split('\n').filter(l => l.includes('<path>')).length < skeleton.split('\n').length / 2,
  'canonicalisation did not redact most of the banner',
  `${skeleton.split('\n').filter(l => l.includes('<path>')).length} of ` +
  `${skeleton.split('\n').length} lines mention a path`);

section('5. The entry contract carries the same listing as a hand-built object');

// The strongest check available for the entry refactor: `openEntry` used to assemble a flat
// object literal and hand it to the banner. It now normalises an entry and flattens it back.
// If those two produce different banners, the refactor changed the listing - which is exactly
// what it promised not to do, and what no other suite here would notice.
const isaEntry = require(path.join(ROOT, 'src', 'isa_entry.js'));
const isa = require(path.join(ROOT, 'src', 'isa.js'));

const reference = goldenResult(program);
const normalised = isaEntry.normalize({
  name: 'goldenKernel',
  microcode: program.microcode,
  codeBytes: program.microcode.length,
  metadata: reference.object.metadata
}, { target: isa.get(isa.DEFAULT_TARGET), origin: 'cache' });

check(normalised.evidence.microcode === program.microcode,
  'the microcode survives as evidence rather than as the interface');
// Derived from a raw entry that genuinely omits it. The previous version of this check was fed
// an entry that stated codeBytes, so it asserted the caller's own value back at itself:
// replacing the derivation in isa_entry.js with `null` left the suite green.
const derived = isaEntry.normalize({ name: 'x', microcode: program.microcode },
  { target: isa.get(isa.DEFAULT_TARGET) });
check(derived.evidence.codeBytes === program.microcode.length,
  'codeBytes is derived when the caller does not state it', derived.evidence.codeBytes);
check(normalised.evidence.codeBytes === program.microcode.length,
  'codeBytes is kept when the caller does state it', normalised.evidence.codeBytes);
check(normalised.sha1 === reference.object.sha1,
  'identity is computed the same way it was', normalised.sha1);
check(typeof normalised.emit === 'function', 'the entry knows how to become text');
check(normalised.stages.length === 0,
  'an entry that names no stage claims no stages', JSON.stringify(normalised.stages));
check(normalised.declared.registers === null && normalised.declared.spillLoads === null,
  'what a tool declared starts empty rather than borrowing from the code');

const throughContract = output.banner(
  { ...reference, object: isaEntry.asObject(normalised, {
    source: reference.object.source, offset: reference.object.offset }) },
  { label: 'GLCache blob', scanned: false });
check(throughContract === output.banner(reference, { label: 'GLCache blob', scanned: false }),
  'a banner built through the entry contract is identical to one built by hand',
  firstDifference(output.banner(reference, { label: 'GLCache blob', scanned: false }),
    throughContract));

section('6. A target with no per-instruction column says so by omission');

// `absences` and the nullable capability cells are the mechanism the whole design rests on: a
// target that has no control column must produce a banner with no legend, rather than an empty
// legend or a crash. Checked with a stand-in row rather than a real second target, because the
// claim is about the mechanism and there is no second target yet.
const columnless = {
  ...isa.get(isa.DEFAULT_TARGET),
  controlColumn: null,
  bannerTail: (result, field) => [
    field('microcode') + `${result.object.codeBytes} bytes, sha1 ${result.object.sha1}`,
    field('note') + 'this target states dependencies as instructions, not as a column'
  ]
};
const withoutColumn = output.banner(
  { ...reference, target: columnless }, { label: 'GLCache blob', scanned: false });
check(!/Control codes decoded from bits/.test(withoutColumn),
  'no control-column legend is printed for a target that has none');
check(/this target states dependencies as instructions/.test(withoutColumn),
  'the target got to say what it has instead');
check(/^\/\/ stage\s+: compute/m.test(withoutColumn),
  'everything the layout owns is still printed');

// The three above prove the BANNER honours the target's tail - which is real, but is a claim
// about bannerTail, not about `controlColumn`. output.js never reads that cell, so overriding
// it alone changes nothing and the section used to be asserting its own stub back at itself.
// The cell's actual consumer is the instruction stride, so that is what gets checked.
check(isa.strideFor(isa.get(isa.DEFAULT_TARGET)) === 16,
  'a target with a control column reports its instruction width',
  isa.strideFor(isa.get(isa.DEFAULT_TARGET)));
check(isa.strideFor(columnless) === null,
  'a target without one reports no width, rather than throwing or guessing',
  isa.strideFor(columnless));
check(isa.strideFor(undefined) === null,
  'and neither does asking about no target at all');

// The whole banner speaks for one target. `metadataLines` used to resolve the registry default
// internally while `banner` honoured `result.target`, so the registers line and the provenance
// block could describe two different toolchains in one file.
const twoVoiced = {
  ...isa.get(isa.DEFAULT_TARGET),
  registerSource: { cache: 'VGPRs allocated', compiled: 'VGPRs allocated', driver: 'VGPRs allocated' }
};
const oneVoice = output.banner(
  { ...reference, target: twoVoiced }, { label: 'GLCache blob', scanned: false });
check(/registers\s+: 8 VGPRs allocated/.test(oneVoice),
  'the registers line speaks for the result\'s target, not the registry default',
  oneVoice.split('\n').find(l => l.includes('registers')));

section('7. Every stage has a road, and the two spellings agree');

// `lineage` and `road.nvidia` say the same thing, which is the whole risk of keeping both. A
// stage added with one and not the other would route correctly today and be invisible to the
// target the moment there is a second one, so the invariant is asserted rather than trusted.
const compile = require(path.join(ROOT, 'src', 'compile.js'));
const nvidiaTarget = isa.get('nvidia');
const drifted = Object.keys(compile.STAGES).filter(
  stage => compile.STAGES[stage].lineage !== compile.roadOf(stage, 'nvidia'));
check(drifted.length === 0,
  'every stage\'s lineage matches its NVIDIA road', drifted.join(', '));
check(Object.keys(compile.STAGES).every(s => nvidiaTarget.roadFor(s)),
  'the target can name a road for every stage in the table');
check(nvidiaTarget.roadFor('compute') === 'cuda' &&
  nvidiaTarget.roadFor('fragment') === 'graphics',
  'the roads are the ones the two compile paths actually take');
check(nvidiaTarget.roadFor('nonesuch') === null,
  'a stage the table does not know has no road rather than a wrong one');

// The refusal is prose, and prose assembled from a table is where sentences come out backwards
// or with an empty list rendered as though it were an answer. Both happened; both are checked.
const refusal = compile.stageRefusal('nvidia');
// Both indices guarded. `indexOf` returns -1, and -1 is less than any found index, so the
// unguarded form passed whenever the FIRST clause was missing - which is precisely the
// regression it was written for after that clause once came out second.
const cudaAt = refusal.indexOf('ompute goes through CUDA');
const restAt = refusal.indexOf('the rest are compiled');
check(cudaAt >= 0 && restAt >= 0 && cudaAt < restAt,
  'the refusal says what "the rest" is the rest of, before saying "the rest"', refusal);
// A clause following a full stop starts a sentence, and ROAD_PROSE stores fragments.
check(/\.\s+[A-Z]/.test(refusal.slice(refusal.indexOf('. ') )),
  'the clause after the stage list starts a sentence, not a fragment', refusal);

// A stage the table knows but this target has no road for must refuse, not fall through. It
// used to reach `compile()`'s fork as `road: null`, and anything that is not 'graphics' went
// down the CUDA road - where slangc crashes with no diagnostic for a graphics stage.
let refusedNullRoad = null;
try {
  compile.chooseSlangEntry('[shader("mesh")] void m(){}', undefined, 'a.slang',
    { stage: 'mesh' }, 'nosuch');
} catch (e) {
  refusedNullRoad = e.message;
}
check(refusedNullRoad !== null && /cannot compile/.test(refusedNullRoad),
  'a stage with no road on this target is refused rather than routed to CUDA',
  refusedNullRoad === null ? 'it returned instead of throwing' : refusedNullRoad);
check(/compiled: amplification, .*vertex\./.test(refusal),
  'the refusal lists the stages this target really compiles');
check(!/compiled: \./.test(compile.stageRefusal('nosuch')) &&
  /No stage can be compiled for nosuch/.test(compile.stageRefusal('nosuch')),
  'a target that compiles nothing says so rather than printing an empty list',
  compile.stageRefusal('nosuch'));
check(nvidiaTarget.refusalFor('compute') === null,
  'a stage that IS compilable has no refusal');
check(typeof nvidiaTarget.refusalFor('nonesuch') === 'string',
  'a stage that is not gets one');

section('8. The second target is a row, and says what it cannot do');

const amd = isa.get('amd');
check(amd !== null, 'the registry has an AMD row');
check(isa.DIALECTS['amd-rdna-isa'] !== undefined, 'and a dialect to read its listings');
check(isa.LISTING_EXTS.has('.rdnaisa'),
  'whose extension joins the set every listing consumer filters on',
  [...isa.LISTING_EXTS].join(' '));
check(isa.dialectForFile('x.deadbeef.gfx1201.rdnaisa') === isa.DIALECTS['amd-rdna-isa'],
  'so an AMD listing on disk resolves to the AMD dialect, not the NVIDIA one');

// The eight stages RGA's Vulkan modes reach, measured from `rga -h -s <mode>`.
const amdStages = compile.stagesFor('amd');
check(amdStages.length === 8, 'AMD reaches eight stages', amdStages.join(', '));
check(!amdStages.includes('raygeneration'),
  'and not raytracing, which RGA\'s Vulkan modes have no stage option for');
check(amdStages.includes('mesh') && amdStages.includes('amplification'),
  'mesh and amplification ARE reached - offline mode only, contrary to RGA\'s GUI manual');

// The refusal has to name the alternative rather than just decline.
const rtRefusal = amd.refusalFor('raygeneration');
check(typeof rtRefusal === 'string' && /-s dxr/.test(rtRefusal),
  'a raytracing stage is refused by name, and the refusal names the mode that does exist',
  rtRefusal);
check(amd.refusalFor('fragment') === null, 'a stage it CAN compile has no refusal');

// Absence is declared, not discovered.
check(amd.controlColumn === null && isa.strideFor(amd) === null,
  'RDNA declares no fixed instruction width, so nothing may step by one');
check(isa.DIALECTS['amd-rdna-isa'].dependency === null,
  'and no dependency model yet, so the highlighter stands down rather than guessing');
check(typeof amd.absences.controlColumn === 'string' &&
  typeof amd.absences.correlation === 'string',
  'each absence carries the reason in words, for the banner to print once');

section('9. `auto` resolves per road, not per machine');

// Compute is hardware-blind because ptxas is: a Radeon in the machine must not change what
// the compute road produces.
const computeHere = isa.resolveTarget({ stage: 'compute', available: { nvidia: true, amd: true } });
check(computeHere.target.id === 'nvidia',
  'compute goes to NVIDIA when ptxas resolves, whatever else is installed', computeHere.from);

// A graphics stage is the opposite: that road IS the local driver, so the device decides.
const gfxNoNvidia = isa.resolveTarget({
  stage: 'fragment', available: { nvidia: true, amd: true, nvidiaDevice: false } });
check(gfxNoNvidia.target.id === 'amd',
  'a graphics stage goes to AMD when the Vulkan probe finds no NVIDIA device',
  gfxNoNvidia.from);

const gfxWithNvidia = isa.resolveTarget({
  stage: 'fragment', available: { nvidia: true, amd: true, nvidiaDevice: true } });
check(gfxWithNvidia.target.id === 'nvidia',
  'and to NVIDIA when it does', gfxWithNvidia.from);
check(gfxWithNvidia.alternative && gfxWithNvidia.alternative.id === 'amd',
  'with the other target named, so the banner can say what else was available');

const onlyAmd = isa.resolveTarget({ stage: 'compute', available: { nvidia: false, amd: true } });
check(onlyAmd.target.id === 'amd',
  'a machine with no CUDA toolchain still compiles compute, through RGA', onlyAmd.from);

check(isa.resolveTarget({ requested: 'amd' }).target.id === 'amd',
  'an explicit request wins over any of it');
let badTarget = null;
try { isa.resolveTarget({ requested: 'intel' }); } catch (e) { badTarget = e.message; }
check(badTarget !== null && /not a target/.test(badTarget),
  'and an unknown one is refused by name', badTarget);

console.log(`\n${failures ? 'FAIL' : 'PASS'}  ${checks} checks, ${failures} failures`);
process.exit(failures ? 1 : 0);
