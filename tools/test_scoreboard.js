'use strict';

/**
 * Scoreboard dependency analysis.
 *
 * The semantics being pinned here are the ones that are easy to get subtly wrong:
 * scoreboards are counters rather than flags, a wait drains every outstanding arm at once,
 * and an instruction that both waits on and arms the same scoreboard leaves exactly its own
 * arm behind. The last case decides the order of two lines in the scan and is invisible until
 * it is wrong.
 *
 *   ELECTRON_RUN_AS_NODE=1 Code.exe tools/test_scoreboard.js
 */

const path = require('path');
const fs = require('fs');

const scoreboard = require(path.join(__dirname, '..', 'src', 'scoreboard.js'));

let checks = 0;
let failures = 0;

function check(condition, what, detail = '') {
  checks++;
  if (condition) return;
  failures++;
  console.log(`  FAIL  ${what}`);
  if (detail) console.log(`        ${String(detail).split('\n').slice(0, 8).join('\n        ')}`);
}

function section(title) { console.log(`\n${title}`); }

/** A stand-in for a TextDocument - the two members the analysis actually uses. */
function doc(lines) {
  return {
    lineCount: lines.length,
    lineAt(n) {
      const text = lines[n];
      return {
        text,
        firstNonWhitespaceCharacterIndex: text.length - text.replace(/^\s+/, '').length
      };
    }
  };
}

/** One instruction line in the format the pipeline emits. */
function ins(addr, column, body) {
  return `        /*${addr.toString(16).padStart(4, '0')}*/ ${column}  ${body} ;`;
}

/** `[B..:R.:W.:.:S..]` from a wait set and optional read/write arms. */
function col({ wait = [], read = null, write = null, yieldBit = false, stall = 1 } = {}) {
  let mask = '';
  for (let b = 0; b < 6; b++) mask += wait.includes(b) ? String(b) : '-';
  return `[B${mask}:R${read === null ? '-' : read}:W${write === null ? '-' : write}:` +
    `${yieldBit ? 'Y' : '-'}:S${String(stall).padStart(2, '0')}]`;
}

/** Column of the nth slot inside the wait field, for pointing the cursor at a scoreboard. */
function waitCursor(line, sb) {
  return line.indexOf('[B') + 2 + sb;
}
function fieldCursor(line, letter) {
  return line.indexOf(`:${letter}`) + 2;
}

/* ----------------------------------------------------- 1. reading a column --- */

section('1. Reading a control column');

{
  const line = ins(0, col({ wait: [0, 2], read: 3, write: 4 }), 'IMAD R2, R0, R1, R3');
  const control = scoreboard.controlOf(line);
  check(!!control, 'an annotated instruction parses');
  check(control.wait.has(0) && control.wait.has(2) && control.wait.size === 2,
    'the wait mask is positional', [...control.wait].join(','));
  check(control.read === 3 && control.write === 4, 'read and write arms decode',
    `${control.read}/${control.write}`);

  const clear = scoreboard.controlOf(ins(0, col({}), 'NOP'));
  check(clear.wait.size === 0 && clear.read === null && clear.write === null,
    'an all-clear column arms and waits on nothing');

  check(scoreboard.controlOf('        /*0000*/  NOP ;') === null,
    'a line with no control column is not analysed');
  check(scoreboard.controlOf('.L_x_0:') === null, 'nor is a label');
  check(scoreboard.controlOf('01:-:-:Y:d      ISETP.GE.AND P0, PT, R0, 0x80, PT ;') === null,
    'nor is a Maxwell-era column - its scoreboards are numbered differently');
}

section('2. Pointing at a scoreboard');
{
  const line = ins(0, col({ wait: [0, 2], read: 3, write: 4 }), 'IMAD R2, R0, R1, R3');
  const control = scoreboard.controlOf(line);
  const cc = control.parsed.controlCode;

  const hit = scoreboard.scoreboardAt(cc, waitCursor(line, 2));
  check(hit && hit.sb === 2 && hit.role === 'wait' && hit.active,
    'the cursor on a waited slot names that scoreboard', JSON.stringify(hit));

  const inactive = scoreboard.scoreboardAt(cc, waitCursor(line, 1));
  check(inactive && inactive.sb === 1 && !inactive.active,
    'the cursor on an empty slot names it as not waited on', JSON.stringify(inactive));

  const zero = scoreboard.scoreboardAt(cc, waitCursor(line, 0));
  check(zero && zero.sb === 0, 'slot 0 is the leftmost, not the B tag', JSON.stringify(zero));

  const tag = scoreboard.scoreboardAt(cc, line.indexOf('[B') + 1);
  check(tag === null, 'the B tag itself names no scoreboard');

  const r = scoreboard.scoreboardAt(cc, fieldCursor(line, 'R'));
  check(r && r.sb === 3 && r.role === 'read', 'the read field names its scoreboard',
    JSON.stringify(r));
  const w = scoreboard.scoreboardAt(cc, fieldCursor(line, 'W'));
  check(w && w.sb === 4 && w.role === 'write', 'and the write field names its own',
    JSON.stringify(w));

  const none = scoreboard.controlOf(ins(0, col({}), 'NOP'));
  const noneHit = scoreboard.scoreboardAt(none.parsed.controlCode,
    fieldCursor(ins(0, col({}), 'NOP'), 'W'));
  check(noneHit && noneHit.sb === null && !noneHit.active,
    'an unarmed field names no scoreboard', JSON.stringify(noneHit));
}

/* --------------------------------------------------------- 3. counting arms --- */

section('3. Counting the arms a wait is waiting on');

{
  // Two loads arm the same scoreboard; one wait drains both. This is ordinary output, and it
  // is the whole reason a scoreboard is a counter rather than a flag.
  const d = doc([
    ins(0x00, col({ write: 4 }), 'LDG.E R13, [UR4+0x1c]'),
    ins(0x10, col({ write: 4 }), 'LDG.E R0, [UR4+0x18]'),
    ins(0x20, col({}), 'FMNMX.FTZ R12, R12, R11, !PT'),
    ins(0x30, col({ wait: [4] }), 'FADD R5, R13, R0')
  ]);

  const a = scoreboard.armsFor(d, 3, 4);
  check(a.value === 2, 'the counter reads 2 with two arms outstanding', String(a.value));
  check(a.arms.length === 2 && a.arms[0].line === 0 && a.arms[1].line === 1,
    'and names both, in program order', JSON.stringify(a.arms.map(x => x.line)));
  check(a.arms.every(x => x.kind === 'write'), 'each tagged with how it armed');
  check(a.arms[0].opcode === 'LDG', 'and with the opcode that did it', a.arms[0].opcode);
  check(a.exact === true, 'straight-line code gives an exact answer');
  check(a.drainLine === null && a.reachedStart,
    'with nothing before it, the count runs to the top of the listing');
}

{
  // A previous wait on the same scoreboard is a hard floor: everything before it retired.
  const d = doc([
    ins(0x00, col({ write: 2 }), 'LDG.E R1, [UR4]'),
    ins(0x10, col({ wait: [2] }), 'IADD3 R5, R1, R2, RZ'),
    ins(0x20, col({ write: 2 }), 'LDG.E R7, [UR6]'),
    ins(0x30, col({ wait: [2] }), 'IADD3 R8, R7, R2, RZ')
  ]);

  const a = scoreboard.armsFor(d, 3, 2);
  check(a.value === 1 && a.arms[0].line === 2,
    'only arms since the previous drain are counted',
    JSON.stringify({ value: a.value, arms: a.arms.map(x => x.line) }));
  check(a.drainLine === 1, 'and the drain that bounded the count is reported',
    String(a.drainLine));
}

{
  // The ordering case. An instruction that waits on a scoreboard AND arms it drains first and
  // arms second, so its own arm is still outstanding for the next wait - but nothing earlier
  // is. Scanning in the wrong order loses this arm or keeps too many.
  const d = doc([
    ins(0x00, col({ write: 3 }), 'LDG.E R1, [UR4]'),
    ins(0x10, col({ write: 3 }), 'LDG.E R2, [UR6]'),
    ins(0x20, col({ wait: [3], write: 3 }), 'LDG.E R4, [R1]'),
    ins(0x30, col({ wait: [3] }), 'IADD3 R9, R4, RZ, RZ')
  ]);

  const a = scoreboard.armsFor(d, 3, 3);
  check(a.value === 1 && a.arms.length === 1 && a.arms[0].line === 2,
    'an instruction that both drains and arms leaves exactly its own arm',
    JSON.stringify({ value: a.value, arms: a.arms.map(x => x.line) }));
  check(a.drainLine === 2, 'and is itself the drain point', String(a.drainLine));
}

{
  // Read arms and write arms both count, and are distinguished.
  const d = doc([
    ins(0x00, col({ read: 1 }), 'STG.E [R4], R6'),
    ins(0x10, col({ write: 1 }), 'LDG.E R8, [R2]'),
    ins(0x20, col({ wait: [1] }), 'IADD3 R9, R8, RZ, RZ')
  ]);
  const a = scoreboard.armsFor(d, 2, 1);
  check(a.value === 2, 'a read arm counts alongside a write arm', String(a.value));
  check(a.arms[0].kind === 'read' && a.arms[1].kind === 'write',
    'and the two are told apart', JSON.stringify(a.arms.map(x => x.kind)));
}

{
  // A wait on a scoreboard nothing armed is legitimate and must not invent arms.
  const d = doc([
    ins(0x00, col({ write: 0 }), 'LDG.E R1, [UR4]'),
    ins(0x10, col({ wait: [5] }), 'IADD3 R2, R1, RZ, RZ')
  ]);
  const a = scoreboard.armsFor(d, 1, 5);
  check(a.value === 0 && a.arms.length === 0, 'a wait on an unarmed scoreboard counts zero');
}

{
  // Other scoreboards must not leak in.
  const d = doc([
    ins(0x00, col({ write: 0 }), 'LDG.E R1, [UR4]'),
    ins(0x10, col({ write: 1 }), 'LDG.E R2, [UR6]'),
    ins(0x20, col({ write: 2 }), 'LDG.E R3, [UR8]'),
    ins(0x30, col({ wait: [1] }), 'IADD3 R4, R2, RZ, RZ')
  ]);
  const a = scoreboard.armsFor(d, 3, 1);
  check(a.value === 1 && a.arms[0].line === 1, 'only the named scoreboard is counted',
    JSON.stringify(a.arms.map(x => x.line)));
}

/* ------------------------------------------------------ 4. the other direction --- */

section('4. From an arm to the wait that drains it');

{
  const d = doc([
    ins(0x00, col({ write: 4 }), 'LDG.E R13, [UR4+0x1c]'),
    ins(0x10, col({ write: 4 }), 'LDG.E R0, [UR4+0x18]'),
    ins(0x20, col({}), 'FMNMX.FTZ R12, R12, R11, !PT'),
    ins(0x30, col({ wait: [4] }), 'FADD R5, R13, R0')
  ]);

  const w = scoreboard.waitFor(d, 0, 4);
  check(w.waitLine === 3, 'an arm finds the wait that drains it', String(w.waitLine));
  check(w.siblings.length === 2, 'and the other arms that wait covers',
    JSON.stringify(w.siblings.map(s => s.line)));

  const orphan = scoreboard.waitFor(doc([ins(0, col({ write: 4 }), 'LDG.E R1, [UR4]')]), 0, 4);
  check(orphan.waitLine === null && orphan.siblings.length === 0,
    'an arm nothing waits on reports no drain');
}

/* ---------------------------------------------------- 5. control flow honesty --- */

section('5. Control-flow honesty');

{
  const d = doc([
    ins(0x00, col({ write: 2 }), 'LDG.E R1, [UR4]'),
    '.L_x_4:',
    ins(0x10, col({ wait: [2] }), 'IADD3 R5, R1, RZ, RZ')
  ]);
  const a = scoreboard.armsFor(d, 2, 2);
  check(a.crossedLabel === 1, 'a label between the arm and the wait is reported',
    String(a.crossedLabel));
  check(a.exact === false,
    'so the answer is flagged as a straight-line reading, not a fact');
  check(a.value === 1, 'the arm is still reported - flagged, not hidden');
}

{
  const d = doc([
    ins(0x00, col({ write: 2 }), 'LDG.E R1, [UR4]'),
    ins(0x10, col({}), '@!P0 BRA 0x40'),
    ins(0x20, col({ wait: [2] }), 'IADD3 R5, R1, RZ, RZ')
  ]);
  const a = scoreboard.armsFor(d, 2, 2);
  check(a.crossedBranch === 1, 'a branch is reported too', String(a.crossedBranch));
  check(a.exact === false, 'and also costs exactness');
}

{
  // A branch target. The instructions immediately above belong to the path that jumps OVER
  // this one, so their drain is not ours - the arms being waited on are before the branch.
  // Real compiler output does this constantly and a strict scan reports "waits on nothing".
  const d = doc([
    ins(0x00, col({ write: 0 }), 'LDG.E R1, [UR4]'),          // the real arm
    ins(0x10, col({}), '@!P0 BRA 0x40'),                       // ...jumps to line 4
    ins(0x20, col({ wait: [0] }), 'IADD3 R5, R1, RZ, RZ'),     // fall-through drains SB0
    ins(0x30, col({}), 'BRA 0x50'),                            // ...and skips line 4
    ins(0x40, col({ wait: [0] }), 'FADD R6, R1, RZ'),          // the branch target
    ins(0x50, col({}), 'EXIT')
  ]);

  const strict = scoreboard.armsFor(d, 4, 0, { hops: 0 });
  check(strict.value === 0,
    'a strict scan from a branch target finds nothing - it stopped at another path\'s drain');

  const a = scoreboard.armsFor(d, 4, 0);
  check(a.value === 1 && a.arms[0].line === 0,
    'continuing past that drain finds the arm the branch path is really waiting on',
    JSON.stringify({ value: a.value, arms: a.arms.map(x => x.line) }));
  check(a.alternatePath === true && a.pathJoin === 2,
    'and says so, naming where the paths join',
    JSON.stringify({ alternatePath: a.alternatePath, pathJoin: a.pathJoin }));
  check(a.exact === false, 'such an answer is never presented as exact');
}

{
  // The fallback must not fire when the strict answer is good, or every ordinary wait would
  // be labelled uncertain.
  const d = doc([
    ins(0x00, col({ write: 0 }), 'LDG.E R1, [UR4]'),
    ins(0x10, col({ wait: [0] }), 'IADD3 R5, R1, RZ, RZ')
  ]);
  const a = scoreboard.armsFor(d, 1, 0);
  check(a.value === 1 && a.alternatePath === false,
    'a wait that resolves on its own path is not flagged as crossing one');
}

{
  // A hover must stay cheap on a listing with half a million lines, so the scan is bounded.
  const lines = [];
  for (let i = 0; i < 500; i++) lines.push(ins(i * 16, col({}), 'NOP'));
  lines.push(ins(500 * 16, col({ wait: [1] }), 'IADD3 R2, R1, RZ, RZ'));
  const a = scoreboard.armsFor(doc(lines), 500, 1, { limit: 50 });
  check(a.truncated === true, 'the scan gives up rather than walking a whole megakernel');
  check(a.exact === false, 'and says the answer is incomplete');
}

/* ------------------------------------------------------------ 6. analyzeAt --- */

section('6. What the editor asks for');

{
  const lines = [
    ins(0x00, col({ write: 4 }), 'LDG.E R13, [UR4+0x1c]'),
    ins(0x10, col({ write: 4 }), 'LDG.E R0, [UR4+0x18]'),
    ins(0x20, col({ wait: [4] }), 'FADD R5, R13, R0')
  ];
  const d = doc(lines);

  const onWait = scoreboard.analyzeAt(d, 2, waitCursor(lines[2], 4));
  check(onWait && onWait.role === 'wait' && onWait.sb === 4,
    'the cursor on a wait resolves to that scoreboard');
  check(JSON.stringify(onWait.related) === '[0,1]',
    'and the lines to highlight are its arms', JSON.stringify(onWait.related));

  const onArm = scoreboard.analyzeAt(d, 0, fieldCursor(lines[0], 'W'));
  check(onArm && onArm.role === 'write' && onArm.sb === 4,
    'the cursor on an arm resolves to its scoreboard');
  check(onArm.related.includes(2) && onArm.related.includes(1) && !onArm.related.includes(0),
    'and highlights the draining wait plus the sibling arm, not itself',
    JSON.stringify(onArm.related));

  const onEmpty = scoreboard.analyzeAt(d, 2, waitCursor(lines[2], 0));
  check(onEmpty && onEmpty.sb === 0 && onEmpty.related.length === 0,
    'an unwaited slot highlights nothing');

  check(scoreboard.analyzeAt(d, 2, 0) === null,
    'the cursor outside the column analyses nothing');
}

/* ------------------------------------------------------ 7. a real listing --- */

section('7. A real listing');

{
  const sample = path.join(__dirname, '..', 'samples', 'example-kernel.nvsass');
  if (!fs.existsSync(sample)) {
    console.log('  skip  samples/example-kernel.nvsass is not present');
  } else {
    const lines = fs.readFileSync(sample, 'utf8').split('\n');
    const d = doc(lines);

    let waits = 0;
    let resolved = 0;
    let armsTotal = 0;
    let exact = 0;
    let viaBranch = 0;
    for (let n = 0; n < lines.length; n++) {
      const control = scoreboard.controlOf(lines[n]);
      if (!control || !control.wait.size) continue;
      for (const sb of control.wait) {
        waits++;
        const a = scoreboard.armsFor(d, n, sb);
        if (a.value > 0) { resolved++; armsTotal += a.value; }
        if (a.exact) exact++;
        if (a.alternatePath) viaBranch++;
      }
    }

    console.log(`        ${waits} waits, ${resolved} resolved, ${armsTotal} arms, ` +
      `${exact} exact, ${viaBranch} resolved across a branch`);
    check(waits > 0, 'the sample listing contains waits', String(waits));
    // A compiler does not emit a wait for nothing, so every wait must resolve. The ones that
    // only resolve across a branch are branch targets, and finding those is the whole reason
    // the scan continues past a drain that yielded nothing.
    check(resolved === waits,
      'every wait in real compiler output resolves to at least one arm',
      `${resolved} of ${waits}`);
    check(viaBranch > 0 && viaBranch < waits,
      'some of them only resolve by looking across a branch, and are flagged as such',
      `${viaBranch} of ${waits}`);
    check(armsTotal > resolved, 'and some waits cover more than one arm',
      `${armsTotal} arms for ${resolved} waits`);
  }
}

/* ------------------------------------------------ 8. what the cursor lights up --- */

section('8. Decorations follow the cursor');

{
  // The regression this section exists for: every slot in the mask must behave the same way.
  // A digit sitting between dashes is not part of any word, and anything that resolves "the
  // word at the cursor" first will skip it - which made `B01` highlight and `3` do nothing.
  const Module = require('module');
  const realResolve = Module._resolveFilename;
  Module._resolveFilename = function (request, ...rest) {
    if (request === 'vscode') return 'vscode';
    return realResolve.call(this, request, ...rest);
  };
  require.cache.vscode = {
    id: 'vscode',
    filename: 'vscode',
    loaded: true,
    exports: {
      Range: class { constructor(sl, sc, el, ec) { Object.assign(this, { sl, sc, el, ec }); } },
      ThemeColor: class { constructor(id) { this.id = id; } },
      OverviewRulerLane: { Center: 2 },
      window: {
        createTextEditorDecorationType: o => ({ o, dispose() {} }),
        onDidChangeTextEditorSelection: () => ({ dispose() {} }),
        onDidChangeActiveTextEditor: () => ({ dispose() {} }),
        visibleTextEditors: []
      },
      workspace: { getConfiguration: () => ({ get: (k, d) => d }) },
      languages: {},
      Location: class { constructor(uri, range) { Object.assign(this, { uri, range }); } }
    }
  };
  const highlight = require(path.join(__dirname, '..', 'src', 'highlight.js'));

  const lines = [
    ins(0x00, col({ write: 0 }), 'LDG.E R1, [UR4]'),
    ins(0x10, col({ write: 1 }), 'LDG.E R2, [UR6]'),
    ins(0x20, col({ write: 3 }), 'LDG.E R4, [UR8]'),
    ins(0x30, col({ wait: [0, 1, 3] }), 'FMUL.FTZ R3, R1, R2')
  ];
  const d = doc(lines);
  const waitLine = lines[3];

  // Every armed slot, including the ones a word-based lookup would never reach.
  for (const [sb, armLine] of [[0, 0], [1, 1], [3, 2]]) {
    const at = { line: 3, character: waitCursor(waitLine, sb) };
    const { anchor, related } = highlight.decorationsFor(d, at);
    check(anchor.length === 1,
      `the cursor on slot ${sb} marks the scoreboard it is on`, JSON.stringify(anchor));
    check(related.length === 1 && related[0].sl === armLine,
      `and lights up the instruction that armed scoreboard ${sb}`,
      JSON.stringify(related.map(r => r.sl)));
  }

  // Slot 3 is the one that used to do nothing: it sits after a dash, so it belongs to no word.
  const dashNeighbour = { line: 3, character: waitCursor(waitLine, 2) };
  check(highlight.decorationsFor(d, dashNeighbour).related.length === 0,
    'an unarmed slot between armed ones lights up nothing');

  const outside = { line: 3, character: 0 };
  check(highlight.decorationsFor(d, outside).anchor.length === 0,
    'and a cursor outside the column marks nothing');

  // The line the cursor is on is never listed as related to itself.
  const armAt = { line: 0, character: fieldCursor(lines[0], 'W') };
  const fromArm = highlight.decorationsFor(d, armAt);
  check(fromArm.related.length === 1 && fromArm.related[0].sl === 3,
    'from an arm, the wait that drains it lights up',
    JSON.stringify(fromArm.related.map(r => r.sl)));
  check(!fromArm.related.some(r => r.sl === 0), 'and never the cursor\'s own line');
}

console.log(`\n${failures ? 'FAIL' : 'PASS'}  ${checks} checks, ${failures} failures`);
process.exit(failures ? 1 : 0);
