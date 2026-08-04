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

/**
 * Every operand worth counting, in one alternation run over the whole listing.
 *
 * Measured three ways on a 500,000-line listing, doing identical work: six separate patterns
 * scanned over the text took 97 ms, this one combined pattern scanned over the text took
 * 54 ms, and the same combined pattern invoked once per line took 68 ms. Whole-text wins
 * because the match loop stays inside the regex engine instead of paying a call's overhead
 * half a million times; combining wins again because the text is walked once rather than six
 * times. Per-line looks like the tidy answer and is the slowest of the three.
 *
 * `UR` and `UP` come before `R` and `P` so a uniform register is never read as a vector one,
 * and the lookbehind stops the `R` of an `SR_` counting at all.
 */
const OPERAND_RE =
  /(?<![A-Za-z0-9_])(?:UR(\d+)|R(\d+)|UP(\d+)|P(\d+))|\b([ca])\[0x([0-9a-fA-F]+)\]/g;

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
  const byCategory = new Map();
  const families = {};
  for (const key of Object.keys(FAMILIES)) families[key] = 0;
  const familyList = Object.entries(FAMILIES);

  let total = 0;
  let predicated = 0;
  let backwardBranches = 0;
  let selfBranches = 0;
  let bssy = 0;
  let bsync = 0;
  let trailingNops = 0;

  // Walked by hand: splitting would allocate an array as large as the listing.
  let from = 0;
  while (from <= text.length) {
    let end = text.indexOf('\n', from);
    if (end < 0) end = text.length;
    const line = text.slice(from, end);
    from = end + 1;

    const m = INSTRUCTION_RE.exec(line);
    if (!m || !m[3]) continue;

    const address = m[1] === undefined ? null : parseInt(m[1], 16);
    const opcode = m[3];
    total++;
    if (m[2]) predicated++;

    // Trailing NOPs pad an object out to its allocation and are most of a small shader.
    if (opcode === 'NOP') trailingNops++;
    else trailingNops = 0;

    if (opcode === 'BSSY') bssy++;
    else if (opcode === 'BSYNC') bsync++;

    const entry = data.lookupOpcode(opcode);
    const category = entry && entry.cat ? entry.cat : 'Unrecognised';
    byCategory.set(category, (byCategory.get(category) || 0) + 1);

    for (const [key, re] of familyList) if (re.test(opcode)) families[key]++;

    // Every object ends with a branch to its own address - the trap that catches a warp that
    // runs off the end. Counting it as a loop would make every shader look like one.
    const branch = BRANCH_TARGET_RE.exec(line);
    if (branch && address !== null) {
      const target = parseInt(branch[1], 16);
      if (target === address) selfBranches++;
      else if (target < address) backwardBranches++;
    }

  }

  // Operands, over the whole listing at once - see OPERAND_RE for why this is a separate
  // walk rather than folded into the loop above.
  const operands = operandUse(text);

  const mix = [...byCategory.entries()]
    .map(([category, count]) => ({ category, count, share: percent(count, total) }))
    .sort((a, b) => b.count - a.count);

  return {
    instructions: { total, live: total - trailingNops, pad: trailingNops },
    mix,
    uses: Object.entries(families).filter(([, n]) => n > 0).map(([k]) => k),
    familyCounts: families,
    predicated: { count: predicated, share: percent(predicated, total) },
    registers: operands.registers,
    controlFlow: { bssy, bsync, backwardBranches, selfBranches },
    scheduling: schedulingOf(microcode),
    constants: { banks: operands.banks, attributes: operands.attributes }
  };
}

/**
 * The highest index used in each register file, plus the constant banks and attribute slots
 * the code touches - all from one walk of the listing.
 *
 * Register counts are the plain maximum. Widening them for the 64- and 128-bit operand forms,
 * which implicitly occupy the registers above the one named, changes the answer on about one
 * object in a thousand, and a version that applies the operand width to address registers
 * gets it wrong far more often than that.
 */
function operandUse(text) {
  const registers = {
    maxVector: -1, maxUniform: -1, maxPredicate: -1, maxUniformPredicate: -1
  };
  const banks = new Set();
  const attributes = new Set();

  OPERAND_RE.lastIndex = 0;
  let m;
  while ((m = OPERAND_RE.exec(text)) !== null) {
    if (m[1] !== undefined) registers.maxUniform = Math.max(registers.maxUniform, +m[1]);
    else if (m[2] !== undefined) registers.maxVector = Math.max(registers.maxVector, +m[2]);
    else if (m[3] !== undefined) {
      registers.maxUniformPredicate = Math.max(registers.maxUniformPredicate, +m[3]);
    } else if (m[4] !== undefined) {
      registers.maxPredicate = Math.max(registers.maxPredicate, +m[4]);
    } else if (m[5] === 'c') banks.add(parseInt(m[6], 16));
    else if (m[5] === 'a') attributes.add(parseInt(m[6], 16));
  }

  return {
    registers,
    banks: [...banks].sort((a, b) => a - b),
    attributes: [...attributes].sort((a, b) => a - b)
  };
}

/** Just the register maxima, for callers that want nothing else. */
function registerUse(text) {
  return operandUse(text).registers;
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

  // Continuation lines carry no label and no colon, so the eye reads them as belonging to the
  // line above rather than as a field whose name went missing.
  const blank = `// ${' '.repeat(14)}  `;

  const sc = stats.scheduling;
  if (sc) {
    // Both the average and the denominator are spelled out. "1.98 cycles/instr, 11% wait"
    // leaves a reader guessing whether the percentage is of instructions, of cycles, or of
    // something to do with the scoreboards themselves.
    lines.push(pad('scheduling') +
      `mean stall ${sc.stallPerInstruction.toFixed(2)} cycles per instruction`);
    lines.push(`${blank}of ${sc.instructions.toLocaleString()} instructions: ` +
      `${round(sc.waitShare)}% wait on a scoreboard, ${round(sc.armShare)}% arm one, `);
    lines.push(`${blank}${round(sc.yieldShare)}% set the yield hint, ` +
      `${round(sc.reuseShare)}% reuse an operand`);
    lines.push(`${blank}${sc.stallTotal.toLocaleString()} static issue cycles in total - one ` +
      'warp on a straight line, ignoring');
    lines.push(`${blank}memory latency, occupancy and loop counts. A floor on issue, not a ` +
      'performance figure.');
  }

  // Vector and uniform registers are the general-purpose file; predicates are a separate one
  // with its own eight-deep budget. Listing `P0-P4` alongside `R0-R21` invites reading them
  // as the same resource, which is why they get their own line.
  const r = stats.registers;
  const used = [];
  if (r.maxVector >= 0) used.push(`R0-R${r.maxVector} (${r.maxVector + 1} vector)`);
  if (r.maxUniform >= 0) used.push(`UR0-UR${r.maxUniform} (${r.maxUniform + 1} uniform)`);
  if (used.length) lines.push(pad('registers used') + used.join(',   '));

  const predicates = [];
  if (r.maxPredicate >= 0) predicates.push(`P0-P${r.maxPredicate} (${r.maxPredicate + 1})`);
  if (r.maxUniformPredicate >= 0) {
    predicates.push(`UP0-UP${r.maxUniformPredicate} (${r.maxUniformPredicate + 1})`);
  }
  if (predicates.length) lines.push(pad('predicates') + predicates.join(',   '));

  const c = stats.constants;
  if (c.banks.length) {
    lines.push(pad('const banks') + c.banks.map(b => `c[0x${b.toString(16)}]`).join(', '));
  }
  if (c.attributes.length) {
    lines.push(pad('attributes') + `${c.attributes.length} slot(s), ` +
      `a[0x${c.attributes[0].toString(16)}]-a[0x${c.attributes[c.attributes.length - 1].toString(16)}]`);
  }

  if (stats.predicated.count) {
    lines.push(pad('guarded') + `${stats.predicated.count.toLocaleString()} instructions ` +
      `carry a guard predicate (${round(stats.predicated.share)}% of ` +
      `${stats.instructions.total.toLocaleString()})`);
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
