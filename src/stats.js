'use strict';

/**
 * What a shader is made of, read off the disassembly and the instruction words.
 *
 * Everything here is counted from data the pipeline already has in hand - the text nvdisasm
 * produced and the bytes it was given - so none of it costs an extra tool or a second pass
 * over the cache. The scheduling figures in particular are decoded straight from the
 * instruction words rather than scraped back out of the rendered column.
 *
 * Two rules the whole file obeys, because the alternative is stating things that are not true:
 *
 *  - Counts are per shader, never per corpus. A percentage over a whole cache would be a
 *    statement about one machine's pixel shaders, since that is most of what a cache holds.
 *  - A derived number is either exact or labelled. The stall sum is the clearest case: it is
 *    a single-warp, straight-line issue lower bound that knows nothing about memory latency,
 *    occupancy, divergence or how many times a loop runs, so it is never called a cycle count.
 */

const data = require('./data');
const ctrl = require('./ctrl');

/** Address comment, optional control column, optional guard, then the opcode. */
const INSTRUCTION_RE =
  /^\s*(?:\/\*([0-9a-fA-F]+)\*\/)?\s*(?:\[[^\]]*\]\s*)?(@!?U?P\w+\s+)?([A-Z][A-Z0-9_]*)/;

/** Registers, being careful not to read the R of a UR or an SR as a vector register. */
const VECTOR_RE = /(?<![A-Za-z0-9_])R(\d+)/g;
const UNIFORM_RE = /(?<![A-Za-z0-9_])UR(\d+)/g;
const PREDICATE_RE = /(?<![A-Za-z0-9_])P(\d+)/g;
const CONST_BANK_RE = /\bc\[0x([0-9a-fA-F]+)\]/g;
const ATTRIBUTE_RE = /\ba\[0x([0-9a-fA-F]+)\]/g;
const BRANCH_TARGET_RE = /\b(?:BRA|BRX|JMP|JMX)\b[^;]*?0x([0-9a-fA-F]+)/;

/** Families worth a badge, because each says something a reader would act on. */
const FAMILIES = {
  spills: /^(?:LDL|STL)$/,
  shared: /^(?:LDS|STS|LDSM|ATOMS)$/,
  textures: /^(?:TEX|TLD|TLD4|TXD|TMML|TXQ|SULD|SUST|SURED|SUATOM)$/,
  barriers: /^(?:BAR|BARRIER|DEPBAR)$/,
  atomics: /^(?:ATOM|ATOMG|ATOMS|RED)$/,
  doubles: /^D(?:ADD|MUL|FMA|SETP|MNMX)$/
};

function percent(part, whole) {
  return whole ? (100 * part) / whole : 0;
}

/**
 * @param {string} text        the disassembly, newlines normalised
 * @param {Buffer} microcode   the bytes it was produced from
 */
function analyze(text, microcode) {
  const lines = text.split('\n');

  const opcodes = [];
  const byCategory = new Map();
  const families = {};
  for (const key of Object.keys(FAMILIES)) families[key] = 0;

  let predicated = 0;
  let backwardBranches = 0;
  let selfBranches = 0;

  for (const line of lines) {
    const m = INSTRUCTION_RE.exec(line);
    if (!m || !m[3]) continue;

    const address = m[1] === undefined ? null : parseInt(m[1], 16);
    const opcode = m[3];
    opcodes.push(opcode);
    if (m[2]) predicated++;

    const entry = data.lookupOpcode(opcode);
    const category = entry && entry.cat ? entry.cat : 'Unrecognised';
    byCategory.set(category, (byCategory.get(category) || 0) + 1);

    for (const [key, re] of Object.entries(FAMILIES)) if (re.test(opcode)) families[key]++;

    // Every object ends with a branch to its own address - the trap that catches a warp that
    // runs off the end. Counting it as a loop would make every shader look like one.
    const branch = BRANCH_TARGET_RE.exec(line);
    if (branch && address !== null) {
      const target = parseInt(branch[1], 16);
      if (target === address) selfBranches++;
      else if (target < address) backwardBranches++;
    }
  }

  // Trailing NOPs pad an object out to its allocation and are most of a small shader.
  let pad = 0;
  while (pad < opcodes.length && opcodes[opcodes.length - 1 - pad] === 'NOP') pad++;

  const total = opcodes.length;
  const mix = [...byCategory.entries()]
    .map(([category, count]) => ({ category, count, share: percent(count, total) }))
    .sort((a, b) => b.count - a.count);

  return {
    instructions: { total, live: total - pad, pad },
    mix,
    uses: Object.entries(families).filter(([, n]) => n > 0).map(([k]) => k),
    familyCounts: families,
    predicated: { count: predicated, share: percent(predicated, total) },
    registers: registerUse(text),
    controlFlow: {
      bssy: opcodes.filter(o => o === 'BSSY').length,
      bsync: opcodes.filter(o => o === 'BSYNC').length,
      backwardBranches,
      selfBranches
    },
    scheduling: schedulingOf(microcode),
    constants: bankUse(text)
  };
}

function maxIndex(text, re) {
  let max = -1;
  let m;
  re.lastIndex = 0;
  while ((m = re.exec(text)) !== null) max = Math.max(max, Number(m[1]));
  return max;
}

/**
 * The highest register index the code touches.
 *
 * Reported as the plain maximum. Widening it for the 64- and 128-bit operand forms - which
 * implicitly occupy the registers above the one named - changes the answer on about one
 * object in a thousand, and a version that applies the operand width to address registers
 * gets it wrong far more often than that.
 */
function registerUse(text) {
  return {
    maxVector: maxIndex(text, VECTOR_RE),
    maxUniform: maxIndex(text, UNIFORM_RE),
    maxPredicate: maxIndex(text, PREDICATE_RE)
  };
}

function bankUse(text) {
  const banks = new Set();
  const attributes = new Set();
  let m;
  CONST_BANK_RE.lastIndex = 0;
  while ((m = CONST_BANK_RE.exec(text)) !== null) banks.add(parseInt(m[1], 16));
  ATTRIBUTE_RE.lastIndex = 0;
  while ((m = ATTRIBUTE_RE.exec(text)) !== null) attributes.add(parseInt(m[1], 16));
  return {
    banks: [...banks].sort((a, b) => a - b),
    attributes: [...attributes].sort((a, b) => a - b)
  };
}

/**
 * Scheduling pressure, decoded from the instruction words themselves.
 *
 * `ctrl.js` already reads these fields to print the control column and then throws the
 * numbers away; this is the same decode, kept.
 */
function schedulingOf(microcode) {
  if (!microcode || !microcode.length) return null;
  const count = Math.floor(microcode.length / ctrl.INSTRUCTION_BYTES);

  let stall = 0;
  let waits = 0;
  let arms = 0;
  let yields = 0;
  let reuse = 0;
  for (let i = 0; i < count; i++) {
    const c = ctrl.decodeAt(microcode, i);
    if (!c) continue;
    stall += c.stall;
    if (c.waitMask) waits++;
    if (c.readSB !== ctrl.NO_SCOREBOARD || c.writeSB !== ctrl.NO_SCOREBOARD) arms++;
    if (c.yield) yields++;
    if (c.reuse) reuse++;
  }

  return {
    instructions: count,
    stallTotal: stall,
    stallPerInstruction: count ? stall / count : 0,
    waitShare: percent(waits, count),
    armShare: percent(arms, count),
    yieldShare: percent(yields, count),
    reuseShare: percent(reuse, count)
  };
}

/**
 * The stats as banner lines, most useful first.
 *
 * `metadata` is what the container declared; passing it in lets the two be cross-checked,
 * since they are independent statements about the same shader.
 */
function summaryLines(stats, metadata) {
  if (!stats) return [];
  const pad = label => `// ${label.padEnd(14)}: `;
  const lines = [];
  const round = n => (n < 10 ? n.toFixed(1) : Math.round(n));

  const instr = stats.instructions;
  lines.push(pad('instructions') + `${instr.total.toLocaleString()}` +
    (instr.pad ? `, ${instr.live.toLocaleString()} live (${instr.pad} trailing NOP pad)` : ''));

  if (stats.mix.length) {
    lines.push(pad('mix') + stats.mix.slice(0, 5)
      .map(m => `${m.category} ${round(m.share)}%`).join('   '));
  }
  if (stats.uses.length) lines.push(pad('uses') + stats.uses.join(', '));

  const cf = stats.controlFlow;
  const flow = [];
  if (cf.bssy || cf.bsync) {
    flow.push(cf.bssy === cf.bsync
      ? `${cf.bssy} BSSY/BSYNC pair${cf.bssy === 1 ? '' : 's'}`
      : `${cf.bssy} BSSY and ${cf.bsync} BSYNC - these should match`);
  }
  // A backward branch is how a loop looks, but it is also how an if/else can be lowered, so
  // this says what was counted rather than claiming a loop.
  flow.push(cf.backwardBranches
    ? `${cf.backwardBranches} backward branch${cf.backwardBranches === 1 ? '' : 'es'} (a loop, or lowered control flow)`
    : 'no backward branches');
  lines.push(pad('control flow') + flow.join(';  '));

  const sc = stats.scheduling;
  if (sc) {
    lines.push(pad('scheduling') +
      `${sc.stallPerInstruction.toFixed(2)} stall cycles/instr   ` +
      `${round(sc.waitShare)}% wait   ${round(sc.armShare)}% arm   ` +
      `${round(sc.yieldShare)}% yield   ${round(sc.reuseShare)}% reuse`);
    // Continuation lines carry no label and no colon, so the eye reads them as belonging to
    // the line above rather than as a field whose name went missing.
    const blank = `// ${' '.repeat(14)}  `;
    lines.push(`${blank}${sc.stallTotal.toLocaleString()} static issue cycles - one warp on a ` +
      'straight line, ignoring memory');
    lines.push(`${blank}latency, occupancy and loop counts. A floor on issue, not a ` +
      'performance figure.');
  }

  const r = stats.registers;
  const used = [];
  if (r.maxVector >= 0) used.push(`R0-R${r.maxVector}`);
  if (r.maxUniform >= 0) used.push(`UR0-UR${r.maxUniform}`);
  if (r.maxPredicate >= 0) used.push(`P0-P${r.maxPredicate}`);
  if (used.length) lines.push(pad('registers used') + used.join('   '));

  const c = stats.constants;
  if (c.banks.length) {
    lines.push(pad('const banks') + c.banks.map(b => `c[0x${b.toString(16)}]`).join(', '));
  }
  if (c.attributes.length) {
    lines.push(pad('attributes') + `${c.attributes.length} slot(s), ` +
      `a[0x${c.attributes[0].toString(16)}]-a[0x${c.attributes[c.attributes.length - 1].toString(16)}]`);
  }

  if (stats.predicated.count) {
    lines.push(pad('predicated') + `${round(stats.predicated.share)}% of instructions`);
  }

  void metadata;
  return lines;
}

/**
 * Disagreements between what the container declared and what the code does.
 *
 * The two are arrived at independently, so a mismatch means one of them was read wrong - which
 * is worth more than either number on its own.
 */
function crossCheck(stats, metadata) {
  const notes = [];
  if (!stats || !metadata) return notes;

  if (metadata.registers !== null && stats.registers.maxVector >= metadata.registers) {
    notes.push(`the container declares ${metadata.registers} registers but the code uses ` +
      `R${stats.registers.maxVector} - one of the two is being read wrong`);
  }
  const spills = stats.familyCounts.spills > 0;
  if (spills && !metadata.localBytes) {
    notes.push('the code spills to local memory but the container declares none');
  }
  if (!spills && metadata.localBytes) {
    notes.push(`${metadata.localBytes} bytes of local memory are declared, but no LDL/STL ` +
      'appears in the code');
  }
  if (stats.familyCounts.shared === 0 && metadata.sharedBytes) {
    notes.push(`${metadata.sharedBytes} bytes of shared memory are declared, but the code ` +
      'makes no shared-memory access');
  }
  if (stats.controlFlow.bssy !== stats.controlFlow.bsync) {
    notes.push(`${stats.controlFlow.bssy} BSSY against ${stats.controlFlow.bsync} BSYNC - ` +
      'these are always equal in correctly carved code');
  }
  return notes;
}

module.exports = { analyze, summaryLines, crossCheck, schedulingOf, registerUse, FAMILIES };
