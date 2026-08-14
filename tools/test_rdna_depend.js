'use strict';

/**
 * The RDNA dependency model, pinned against what RGA really emitted.
 *
 * The fixtures are two compilations of ONE shader - `fixtures/rdna/waits.slang`, written to put
 * two scalar loads, an LDS access and two vector loads in flight at once - for gfx1100 and
 * gfx1201. Same source, same RGA, two generations, so every difference between the two
 * listings is a difference between the architectures rather than between two shaders.
 *
 * Re-record with:
 *   slangc waits.slang -target spirv -entry csMain -stage compute -o waits.spv
 *   rga -s vk-spv-offline -c gfx1100 --isa out.txt --comp waits.spv
 *   rga -s vk-spv-offline -c gfx1201 --isa out.txt --comp waits.spv
 *
 * These checks come BEFORE any hover quotes the rules they pin, deliberately. A dependency
 * answer that is confidently wrong is worse than none: it points at an instruction and says
 * "this is what you are waiting for", and a reader has no way to tell that it is guessing.
 *
 *   ELECTRON_RUN_AS_NODE=1 Code.exe tools/test_rdna_depend.js
 */

const fs = require('fs');
const path = require('path');

const depend = require(path.join(__dirname, '..', 'src', 'depend_rdna.js'));

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

/** A document-like object over a listing, the shape the analysis takes. */
function docFor(name) {
  const lines = fs.readFileSync(path.join(FIXTURES, name), 'utf8').split(/\r?\n/);
  return {
    lineCount: lines.length,
    lineAt: i => ({ text: lines[i] }),
    uri: null,
    version: 1,
    lines
  };
}

/** The first line whose text matches, or -1. */
function lineOf(doc, re) {
  return doc.lines.findIndex(l => re.test(l));
}

const legacy = docFor('gfx1100-waits.isa');
const split = docFor('gfx1201-waits.isa');

/* ------------------------------------------------ 1. which generation is which --- */

section('1. The two generations are told apart by the code, not the banner');

check(depend.generationOf(legacy.lines.join('\n')) === 'legacy',
  'gfx1100 uses the combined s_waitcnt form');
check(depend.generationOf(split.lines.join('\n')) === 'split',
  'gfx1201 uses one instruction per counter');
check(depend.generationOf('\tv_mov_b32_e32 v0, v1') === null,
  'a listing with no waits at all commits to neither');

/* --------------------------------------- 2. the rule that matters most of all --- */

section('2. An omitted counter is NOT waited on');

// Measured: gfx1100 emits `s_waitcnt vmcnt(0)` at a point where three scalar loads are still
// outstanding. Read the other way round - "an omitted field means wait for zero" - every
// answer this module gives would be wrong, and plausibly so.
const vmOnly = lineOf(legacy, /s_waitcnt\s+vmcnt\(0\)\s*(?:\/\/|$)/);
check(vmOnly >= 0, 'gfx1100 really does emit a vmcnt-only wait', legacy.lines[vmOnly]);

const named = depend.waitsOn(legacy.lines[vmOnly]);
check(named.length === 1 && named[0].counter === 'vmcnt',
  'and it names exactly one counter', named.map(w => w.counter).join(', '));

// The proof that omission is not a zero-wait: scalar loads are in flight across it.
const scalarBefore = legacy.lines
  .slice(0, vmOnly)
  .filter(l => /^\s+s_(?:buffer_)?load/.test(l)).length;
const scalarAfter = legacy.lines
  .slice(vmOnly)
  .findIndex(l => /s_waitcnt[^/]*lgkmcnt/.test(l));
check(scalarBefore > 0 && scalarAfter > 0,
  'with scalar loads outstanding before it and their lgkmcnt wait only afterwards',
  `${scalarBefore} scalar load(s) before, lgkmcnt wait ${scalarAfter} line(s) later`);

/* ------------------------------------------- 3. what shares a counter, per gen --- */

section('3. gfx10/11 shares a counter that gfx12 splits');

check(depend.QUEUES.legacy.of('ds_store_b32')[0] === 'lgkmcnt',
  'on gfx10/11 an LDS store lands in lgkmcnt');
check(depend.QUEUES.legacy.of('s_load_b256')[0] === 'lgkmcnt',
  'and so does a scalar load - the same counter');
check(!!depend.AMBIGUOUS.lgkmcnt,
  'so a wait on it is reported as unable to name which access it drains');

check(depend.QUEUES.split.of('ds_store_b32')[0] === 'dscnt',
  'on gfx12 an LDS store lands in dscnt');
check(depend.QUEUES.split.of('s_load_b256')[0] === 'kmcnt',
  'and a scalar load in kmcnt - a different queue');
check(!depend.AMBIGUOUS.dscnt && !depend.AMBIGUOUS.kmcnt,
  'so neither carries the caveat: gfx12 REMOVES the ambiguity rather than renaming it');

// The measured evidence for that claim, from the fixtures themselves.
check(/s_wait_kmcnt/.test(split.lines.join('\n')) &&
  /s_wait_dscnt/.test(split.lines.join('\n')) &&
  /s_wait_loadcnt/.test(split.lines.join('\n')),
  'and the gfx1201 listing really does emit all three separately');
check(!/s_wait_kmcnt|s_wait_dscnt/.test(legacy.lines.join('\n')),
  'while gfx1100 emits neither');

/* --------------------------------------------------- 4. following a dependency --- */

section('4. A wait names the operations it drains');

const dsWait = lineOf(split, /s_wait_dscnt/);
const dsHit = depend.analyzeAt(split, dsWait, split.lines[dsWait].indexOf('s_wait_dscnt') + 2);
check(dsHit !== null && dsHit.role === 'wait', 'a gfx12 dscnt wait is recognised');
check(dsHit && dsHit.sb === 'dscnt', 'and names its counter', dsHit && dsHit.sb);
check(dsHit && dsHit.analysis.drained.length > 0,
  'and finds the LDS operation it is waiting for',
  dsHit && dsHit.analysis.drained.map(p => `${p.line}:${p.opcode}`).join(', '));
check(dsHit && dsHit.analysis.drained.every(p => /^ds_/.test(p.opcode)),
  'and only LDS operations - nothing from another queue',
  dsHit && dsHit.analysis.drained.map(p => p.opcode).join(', '));
check(dsHit && dsHit.related.length > 0, 'so the highlighter has lines to light up');

const kmWait = lineOf(split, /s_wait_kmcnt/);
const kmHit = depend.analyzeAt(split, kmWait, split.lines[kmWait].indexOf('s_wait_kmcnt') + 2);
check(kmHit && kmHit.analysis.drained.every(p => /^s_(?:buffer_)?load/.test(p.opcode)),
  'a kmcnt wait drains scalar loads and nothing else',
  kmHit && kmHit.analysis.drained.map(p => p.opcode).join(', '));

// The same question on gfx1100 must carry the caveat, because the queue is shared.
const lgkmWait = lineOf(legacy, /s_waitcnt[^/]*lgkmcnt/);
const lgkmHit = depend.analyzeAt(legacy, lgkmWait,
  legacy.lines[lgkmWait].indexOf('lgkmcnt') + 2);
check(lgkmHit !== null && lgkmHit.sb === 'lgkmcnt', 'the gfx1100 lgkmcnt wait is recognised');
check(lgkmHit && lgkmHit.analysis.ambiguous !== null,
  'and says it cannot name which kind of access it drains',
  lgkmHit && lgkmHit.analysis.ambiguous);
check(lgkmHit && lgkmHit.analysis.exact === false,
  'so the answer is not offered as exact');

/* ---------------------------------------------------- 5. the other direction --- */

section('5. An operation names the wait that drains it');

const dsStore = lineOf(split, /^\s+ds_store/);
const armHit = depend.analyzeAt(split, dsStore, split.lines[dsStore].indexOf('ds_store') + 2);
check(armHit !== null && armHit.role === 'arm', 'an LDS store is recognised as putting work in flight');
check(armHit && armHit.sb === 'dscnt', 'in the dscnt queue', armHit && armHit.sb);
check(armHit && armHit.analysis.waitLine > dsStore,
  'and the wait that drains it is found below it',
  armHit && `store on ${dsStore}, wait on ${armHit.analysis.waitLine}`);

/* --------------------------------------------- 6. what it declines to claim --- */

section('6. What it will not claim');

// A partial wait did not appear in either listing, so the FIFO reasoning that would let one
// name a specific operation is documented rather than observed. The model still implements it
// - it is what the ISA specifies - but the test records that this run did not exercise it.
const anyPartial = [...legacy.lines, ...split.lines]
  .some(l => /(?:vmcnt|lgkmcnt|expcnt|vscnt)\((?!0\))\d+\)/.test(l) ||
    /s_wait_\w+cnt\s+0x0*[1-9]/.test(l));
check(!anyPartial,
  'neither fixture contains a partial wait, so that path is unverified here and says so',
  'if this fails, a partial wait now exists and its handling can be pinned properly');

// flat_ addressing resolves at run time, so it sits in two queues. Not observed in either
// fixture - Slang emitted buffer_ and ds_ - so an answer involving one is marked uncertain
// rather than presented as precise.
check(depend.QUEUES.legacy.of('flat_load_b32').length === 2,
  'a flat_ access is modelled as touching two queues on gfx10/11',
  depend.QUEUES.legacy.of('flat_load_b32').join(', '));
check(depend.QUEUES.split.of('flat_load_b32').length === 2,
  'and on gfx12 as well');
check(!/^\s+flat_/m.test([...legacy.lines, ...split.lines].join('\n')),
  'and neither fixture contains one, so that rule is documented rather than measured');

console.log(`\n${failures ? 'FAIL' : 'PASS'}  ${checks} checks, ${failures} failures`);
process.exit(failures ? 1 : 0);
