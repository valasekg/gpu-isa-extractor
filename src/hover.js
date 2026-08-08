'use strict';

const vscode = require('vscode');
const { parseLine } = require('./parse');
const { explainOpcode } = require('./explain');
const data = require('./data');
const scoreboard = require('./scoreboard');

const DOC_URL = 'https://docs.nvidia.com/cuda/cuda-binary-utilities/index.html#instruction-set-reference';

/** Human labels for the `source` field on a curated entry. */
const SOURCE_LABEL = {
  ptx: 'documented in the PTX ISA',
  slides: 'from the Ampere deep-dive lecture notes',
  community: 'established by published reverse-engineering',
  corpus: 'read off observed disassembly - inferred, not confirmed'
};

class SassHoverProvider {
  provideHover(document, position) {
    if (!vscode.workspace.getConfiguration('nvidiaSass').get('hover.enabled', true)) return null;

    const line = document.lineAt(position.line).text;
    let parsed;
    try {
      parsed = parseLine(line);
    } catch (e) {
      return null;
    }
    if (!parsed) return null;

    const col = position.character;
    const at = (a, b) => col >= a && col < b;
    const range = (a, b) => new vscode.Range(position.line, a, position.line, b);

    if (parsed.controlCode && at(parsed.controlCode.start, parsed.controlCode.end)) {
      const field = parsed.controlCode.fields.find(f => at(f.start, f.end));
      const dependency = scoreboardMarkdown(document, position, parsed);
      return md(controlCodeMarkdown(parsed.controlCode, field, dependency),
                range(parsed.controlCode.start, parsed.controlCode.end));
    }

    if (parsed.address && at(parsed.address.start, parsed.address.end)) {
      return md(addressMarkdown(parsed.address), range(parsed.address.start, parsed.address.end));
    }

    if (parsed.guard && at(parsed.guard.start, parsed.guard.end)) {
      return md(guardMarkdown(parsed.guard), range(parsed.guard.start, parsed.guard.end));
    }

    if (parsed.opcode && at(parsed.opcode.start, parsed.opcode.end)) {
      const arch = architectureFor(document);
      const elaborate = hoverDetail() === 'elaborate';
      return md(opcodeMarkdown(parsed.opcode.text, arch, parsed, elaborate),
                range(parsed.opcode.start, parsed.opcode.end));
    }

    const mod = parsed.modifiers.find(m => at(m.start, m.end));
    if (mod) {
      return md(modifierMarkdown(parsed.opcode ? parsed.opcode.text : null, mod),
                range(mod.start, mod.end));
    }

    // Innermost token wins, so UR4 inside cx[UR4][0x8] hovers as a uniform register.
    const hits = parsed.tokens.filter(t => at(t.start, t.end));
    if (hits.length) {
      const token = hits.reduce((a, b) => (b.end - b.start <= a.end - a.start ? b : a));
      const body = tokenMarkdown(token, parsed);
      if (body) return md(body, range(token.start, token.end));
    }

    return null;
  }
}

/* --------------------------------------------------------------- formatting */

function md(markdown, range) {
  const m = new vscode.MarkdownString(markdown);
  m.supportHtml = false;
  m.isTrusted = false;
  return new vscode.Hover(m, range);
}

function sourceNote(source) {
  if (!source) return '';
  const label = SOURCE_LABEL[source] || source;
  return `\n\n*Source: ${label}.*`;
}

function architectureFor(document) {
  const configured = vscode.workspace.getConfiguration('nvidiaSass').get('hover.architecture', 'auto');
  if (configured && configured !== 'auto' && configured !== 'any') return configured;
  if (configured === 'any') return null;
  return data.detectArchitecture(i => document.lineAt(i).text, document.lineCount);
}

function hoverDetail() {
  return vscode.workspace.getConfiguration('nvidiaSass').get('hover.detail', 'concise');
}

/* ------------------------------------------------------------------ opcodes */

function opcodeMarkdown(name, arch, parsed, elaborate) {
  const entry = data.lookupOpcode(name);
  if (!entry) {
    const twin = data.uniformTwinOf(name);
    const twinEntry = twin && data.lookupOpcode(twin);
    const lines = [`### \`${name}\``, '', 'Not in NVIDIA\'s published instruction tables.'];
    if (twinEntry) {
      lines.push('', `Looks like the warp-uniform twin of \`${twin}\` - *${twinEntry.desc}* - ` +
                     'run on the uniform datapath.');
    }
    if (elaborate) lines.push(...elaborateOpcodeMarkdown(name, twinEntry, parsed));
    return lines.join('\n');
  }

  const lines = [`### \`${name}\`  ·  ${entry.cat}`, '', entry.desc];

  if (entry.documented) {
    const listed = entry.archs.map(a => data.ARCH_LABELS[a] || a).join(', ');
    lines.push('', `**Listed for:** ${listed}`);
    if (arch && !entry.archs.includes(arch)) {
      lines.push('', `> Not listed in the ${data.ARCH_LABELS[arch]} table, but present in this file.`);
    }
    lines.push('', `[NVIDIA CUDA Binary Utilities](${DOC_URL})`);
  } else {
    lines.push('', '> Absent from NVIDIA\'s tables, which cover the compute pipeline only. ' +
                   'This is a graphics-pipeline instruction; the description is reconstructed ' +
                   'from observed shader disassembly.');
    lines.push(sourceNote(entry.source));
  }

  if (data.isUniformDatapath(name)) {
    lines.push('', 'Runs on the **uniform datapath** - one result for the whole warp.');
  }
  if (elaborate) lines.push(...elaborateOpcodeMarkdown(name, entry, parsed));
  return lines.join('\n');
}

function elaborateOpcodeMarkdown(name, entry, parsed) {
  const modifierNames = parsed ? parsed.modifiers.map(mod => mod.text) : [];
  const explanation = explainOpcode(name, entry, modifierNames, instructionOperands(parsed));
  const lines = [
    '',
    '---',
    '',
    '#### Algorithm',
    '',
    explanation.algorithm,
    '',
    `**Operands:** ${explanation.operands}`,
    '',
    `**Execution:** ${explanation.execution}`,
    '',
    `**Scheduling:** ${explanation.scheduling}`
  ];

  const roles = operandRoleSummary(parsed);
  if (roles.length) {
    lines.push('', '**This instruction:** ' + roles.join(' · '));
  }

  if (parsed && parsed.modifiers.length) {
    lines.push('', '#### Active postfixes', '');
    for (const mod of parsed.modifiers) {
      const known = data.lookupModifier(name, mod.text);
      const meaning = known ? known.desc : 'No curated description is recorded.';
      const provenance = known && known.source
        ? ` *(${SOURCE_LABEL[known.source] || known.source})*` : '';
      lines.push(`- \`.${mod.text}\` — ${meaning}${provenance}`);
    }
  }

  lines.push('', `*${explanation.caveat}*`);
  return lines;
}

function instructionOperands(parsed) {
  if (!parsed) return [];
  if (parsed.operands && parsed.operands.length) {
    return parsed.operands.map(operand =>
      operand.text.replace(/\.reuse\b/g, '').replace(/\s+/g, ' ').trim());
  }

  // Compatibility for parser results created by older callers/tests.
  const operands = [];
  for (const token of parsed.tokens) {
    if (token.nested || operands[token.operandIndex]) continue;
    operands[token.operandIndex] = `${token.negated ? '!' : ''}${token.text}`;
  }
  return operands;
}

function operandRoleSummary(parsed) {
  if (!parsed) return [];
  const byRole = { dst: new Set(), src: new Set(), discard: new Set() };
  for (const token of parsed.tokens) {
    if (!token.role || token.nested) continue;
    byRole[token.role].add(token.text);
  }
  const parts = [];
  if (byRole.dst.size) parts.push(`writes ${[...byRole.dst].map(code).join(', ')}`);
  if (byRole.src.size) parts.push(`reads ${[...byRole.src].map(code).join(', ')}`);
  if (byRole.discard.size) parts.push(`discards ${[...byRole.discard].map(code).join(', ')}`);
  return parts;
}

function code(value) {
  return `\`${String(value).replace(/`/g, '\\`')}\``;
}

/* ---------------------------------------------------------------- modifiers */

function modifierMarkdown(opcode, mod) {
  const entry = data.lookupModifier(opcode, mod.text);
  const title = `### \`.${mod.text}\`` + (opcode ? `  on \`${opcode}\`` : '');

  if (!entry) {
    return `${title}\n\nNo description recorded for this postfix.\n\n` +
           `*NVIDIA does not document SASS postfix semantics; this extension carries a ` +
           `curated table (\`data/modifiers.json\`) and this one is not yet in it.*`;
  }

  const lines = [title, '', entry.desc];
  const extra = [];
  if (entry.class) extra.push(`class \`${entry.class}\``);
  extra.push(`postfix #${mod.tier === 3 ? '3+' : mod.tier}`);
  lines.push('', `*${extra.join(' · ')}*`);
  lines.push(sourceNote(entry.source));
  return lines.join('\n');
}

/* ----------------------------------------------------------------- operands */

function roleNote(role) {
  if (role === 'dst') return '\n\n**Destination** - written by this instruction.';
  if (role === 'src') return '\n\n**Source** - read by this instruction.';
  if (role === 'discard') {
    return '\n\n**Destination, discarded** - the value is computed and thrown away. ' +
           'Usually the instruction is there for its predicate or side effect.';
  }
  return '';
}

function classMarkdown(key, role) {
  const cls = data.registerClass(key);
  if (!cls) return null;
  return `### ${cls.title}\n\n${cls.desc}${roleNote(role)}`;
}

function tokenMarkdown(token, parsed) {
  const role = token.role;
  const opcode = parsed.opcode ? parsed.opcode.text : null;

  switch (token.kind) {
    case 'vector':
      return classMarkdown(token.text === 'RZ' ? 'vectorZero' : 'vector', role);
    case 'uniform':
      return classMarkdown(token.text === 'URZ' ? 'uniformZero' : 'uniform', role);
    case 'predicate':
      return classMarkdown(token.text === 'PT' ? 'predicateTrue' : 'predicate', role);
    case 'uniformPredicate':
      return classMarkdown(token.text === 'UPT' ? 'uniformPredicateTrue' : 'uniformPredicate', role);
    case 'predFile':
      return classMarkdown('predicateFile', role);
    case 'special':
      return specialMarkdown(token, role);
    case 'barrier':
      return classMarkdown('barrier', role);
    case 'scoreboard':
      return classMarkdown('scoreboard', role);
    case 'const':
      return constMarkdown(token, role);
    case 'descriptor':
      return descriptorMarkdown(token);
    case 'attribute':
      return attributeMarkdown(token);
    case 'immediate':
      return immediateMarkdown(token, opcode);
    case 'reuse': {
      const entry = data.lookupModifier(null, 'reuse');
      return entry ? `### \`.reuse\`\n\n${entry.desc}${sourceNote(entry.source)}` : null;
    }
    default:
      return null;
  }
}

function specialMarkdown(token, role) {
  const cls = data.registerClass(token.text === 'SRZ' ? 'specialZero' : 'special');
  const specific = data.lookupSpecialRegister(token.text);
  const parts = [`### \`${token.text}\``];
  if (specific) parts.push('', specific.desc);
  if (cls) parts.push('', cls.desc);
  parts.push(roleNote(role));
  return parts.join('\n');
}

function constMarkdown(token, role) {
  const cls = data.registerClass('constant');
  const parts = [`### \`${token.text}\``];

  const m = /^c\[([^\]]*)\]\[([^\]]*)\]/.exec(token.text);
  if (m) {
    const known = data.lookupConstantOffset(m[1], m[2]);
    if (known) parts.push('', `Bank \`${m[1]}\`, offset \`${m[2]}\` - **${known}**.`);
    else parts.push('', `Bank \`${m[1]}\`, offset \`${m[2]}\`.`);
  } else if (token.indexed) {
    parts.push('', 'Indexed constant access: a uniform register supplies the bank base, ' +
                   'so the offset is resolved at run time.');
  }

  if (cls) parts.push('', cls.desc);
  const note = data.registersDoc.constantBanks._note;
  if (m && note) parts.push('', `*${note}*`);
  parts.push(roleNote(role));
  return parts.join('\n');
}

function descriptorMarkdown(token) {
  const entry = data.lookupModifier(null, 'DESC');
  const parts = [`### \`${token.text}\``, '',
    'Memory descriptor held in a uniform register - the base and bounds the access is ' +
    'resolved against.'];
  if (entry) parts.push('', entry.desc);
  return parts.join('\n');
}

function attributeMarkdown(token) {
  const cls = data.registerClass('attribute');
  const parts = [`### \`${token.text}\``];
  const m = /^a\[([^\]]*)\]/.exec(token.text);
  if (m) {
    const known = data.lookupAttributeSlot(m[1]);
    if (known) parts.push('', `Slot \`${m[1]}\` - **${known}**`);
  }
  if (cls) parts.push('', cls.desc);
  const note = data.registersDoc.attributeSlots._note;
  if (note) parts.push('', `*${note}*`);
  return parts.join('\n');
}

/**
 * Immediates are where SASS is least readable: `0x3f800000` is 1.0f and nothing about the
 * text says so. Reinterpreting the bit pattern is the single most useful thing a tooltip
 * can do here.
 */
function immediateMarkdown(token, opcode) {
  const text = token.text;
  const hex = /^([-+])?0[xX]([0-9a-fA-F]+)$/.exec(text);
  const parts = [`### \`${text}\``];

  let after = null;
  if (hex) {
    const digits = hex[2];
    const negated = hex[1] === '-';
    const value = BigInt('0x' + digits);
    const rows = [];
    rows.push(`| decimal | ${negated ? '-' : ''}${value.toString()} |`);
    // One group of four bits per hex digit, so the groups line up with the digits written in
    // the instruction and a mask can be read off against them.
    rows.push(`| binary | ${negated ? '-' : ''}\`${binaryGroups(value, digits.length)}\` |`);

    if (digits.length <= 8) {
      const u32 = Number(BigInt.asUintN(32, value));
      const s32 = Number(BigInt.asIntN(32, value));
      const buf = new ArrayBuffer(4);
      new DataView(buf).setUint32(0, u32);
      const f32 = new DataView(buf).getFloat32(0);
      if (s32 !== u32) rows.push(`| as int32 | ${s32} |`);
      const folded = describeFloat(f32);
      const gloss = folded && folded.text;
      rows.push(`| as float32 | ${formatFloat(f32)}${gloss ? ` - **${gloss}**` : ''} |`);
      if (folded && folded.from) {
        // Held until after the table, which is what it explains.
        after = '> The hardware has only base-2 `MUFU` instructions, so a source ' +
          `\`${folded.from}\` is emitted in base 2 with the source's own multiplier folded ` +
          'into this constant.';
      }
    } else if (digits.length <= 16) {
      const u64 = BigInt.asUintN(64, value);
      const buf = new ArrayBuffer(8);
      new DataView(buf).setBigUint64(0, u64);
      rows.push(`| as float64 | ${formatFloat(new DataView(buf).getFloat64(0))} |`);
    }

    parts.push('', '| | |', '|---|---|', ...rows);
    if (after) parts.push('', after);
    parts.push('', '*Bit-pattern reinterpretations - which one is meant depends on the ' +
                   'instruction. Integer and bit-pattern immediates print in hex, float ' +
                   'immediates print in decimal, so a hex value feeding a float ' +
                   'instruction is a bit pattern.*');
  } else {
    // A float immediate prints in DECIMAL, so this is the branch that actually meets
    // 0.15915493667125702 and the rest of them - the hex branch above never sees one.
    const decimal = /^[-+]?(?:\d+\.\d*|\.\d+|\d+)(?:[eE][-+]?\d+)?$/.test(text)
      ? Math.fround(parseFloat(text)) : NaN;
    const known = Number.isFinite(decimal) ? describeFloat(decimal) : null;
    if (known) {
      parts.push('', `**${known.text}**`);
      if (known.from) {
        parts.push('', '> The hardware has only base-2 `MUFU` instructions, so a source ' +
          `\`${known.from}\` is emitted in base 2 with the source's own multiplier folded ` +
          'into this constant.');
      }
    }
    parts.push('', 'Immediate literal, encoded in the instruction and therefore uniform ' +
                   'across the warp.');
  }

  if (opcode === 'LOP3' || opcode === 'ULOP3' || opcode === 'PLOP3') {
    parts.push('', '> On `LOP3`/`PLOP3` the small trailing immediate is the **truth table**, ' +
                   'not a value: `0xc0` = a AND b, `0xfc` = a OR b, `0x3c` = a XOR b.');
  }
  return parts.join('\n');
}

/**
 * Constants worth naming when they turn up as a float32 bit pattern.
 *
 * Keyed on the bit pattern rather than the decimal, so the match is exact and needs no
 * tolerance. `0x3e22f983` is the one to know: the hardware's sin and cos take TURNS, so every
 * trigonometric call multiplies by 1/(2*pi) first.
 */
const NAMED_FLOATS = new Map([
  [0x40490fdb, 'pi'], [0x3fc90fdb, 'pi/2'], [0x3f490fdb, 'pi/4'], [0x40c90fdb, '2*pi'],
  [0x3ea2f983, '1/pi'], [0x3f22f983, '2/pi'], [0x3e22f983, '1/(2*pi)'],
  [0x42652ee1, '180/pi, degrees per radian'], [0x3c8efa35, 'pi/180, radians per degree'],
  [0x402df854, 'e'], [0x3ebc5ab2, '1/e'],
  [0x3f317218, 'ln(2)'], [0x3fb8aa3b, 'log2(e)'], [0x40135d8e, 'ln(10)'],
  [0x40549a78, 'log2(10)'], [0x3e9a209b, 'log10(2)'], [0x3ede5bd9, 'log10(e)'],
  [0x3fb504f3, 'sqrt(2)'], [0x3f3504f3, '1/sqrt(2)'], [0x3fddb3d7, 'sqrt(3)'],
  [0x3eaaaaab, '1/3'], [0x3f2aaaab, '2/3'], [0x3e2aaaab, '1/6'], [0x3b808081, '1/255'],
  [0x3fcf1bbd, 'the golden ratio']
]);

/**
 * A base change the compiler folded a source constant into, or null.
 *
 * The hardware has only `MUFU.EX2` and `MUFU.LG2`, so `exp(k*x)` is emitted as
 * `exp2(k*log2(e)*x)` and the multiplier carries the source's own k. Naming the k is what
 * makes the constant traceable back to the line it came from - `-8.65617` says nothing,
 * `-6 * log2(e)` says the source wrote `exp(-6*x)`.
 */
/**
 * What a float32 value is, by name, or null.
 *
 * Both immediate spellings go through this: a bit pattern written in hex, and the decimal a
 * float immediate is actually printed as.
 */
function describeFloat(f32) {
  const buf = new ArrayBuffer(4);
  new DataView(buf).setFloat32(0, f32);
  const named = NAMED_FLOATS.get(new DataView(buf).getUint32(0) >>> 0);
  if (named) return { text: named, from: null };
  return foldedConstant(f32);
}

function foldedConstant(f32) {
  const folds = [
    ['log2(e)', Math.LOG2E, 'exp'], ['1/(2*pi)', 1 / (2 * Math.PI), 'sin/cos'],
    ['log2(10)', Math.log2(10), 'exp10'], ['ln(2)', Math.LN2, 'log']
  ];
  for (const [name, base, from] of folds) {
    const k = f32 / base;
    // Quarters keep it to multipliers a person would actually write, and the round trip is
    // what stops a coincidence being reported as a fold.
    const rounded = Math.round(k * 4) / 4;
    if (!rounded || Math.abs(rounded) > 1024) continue;
    if (Math.fround(rounded * base) !== f32) continue;
    if (rounded === 1) return { text: name, from: null };
    return { text: `${rounded} * ${name}`, from };
  }
  return null;
}

/** A bit pattern in groups of four - one group per hex digit of the literal. */
function binaryGroups(value, hexDigits) {
  const width = hexDigits * 4;
  return BigInt.asUintN(width, value).toString(2).padStart(width, '0')
    .replace(/(.{4})(?=.)/g, '$1 ');
}

function formatFloat(v) {
  if (Number.isNaN(v)) return 'NaN';
  if (!Number.isFinite(v)) return v > 0 ? '+Inf' : '-Inf';
  if (v !== 0 && Math.abs(v) < 1e-4) return v.toExponential(9);
  return String(parseFloat(v.toPrecision(9)));
}

/* ------------------------------------------------------- guard / addr / ctl */

function guardMarkdown(guard) {
  const sense = guard.negated
    ? `runs only in the lanes where \`${guard.register}\` is **false**`
    : `runs only in the lanes where \`${guard.register}\` is **true**`;
  return [
    `### Guard predicate \`@${guard.negated ? '!' : ''}${guard.register}\``,
    '',
    `The instruction ${sense}; the remaining lanes are masked off and it costs them nothing ` +
    'but the issue slot.',
    '',
    'This is how SASS expresses a short divergent region without branching at all - no ' +
    'convergence barrier, no reconvergence point, just a per-lane mask.',
    '',
    '`@PT` means unconditional.'
  ].join('\n');
}

function addressMarkdown(address) {
  const hex = address.text.replace(/^0[xX]/, '');
  const value = BigInt('0x' + hex);
  const parts = [`### Instruction address \`0x${hex}\``, '', `Decimal: ${value.toString()}`];
  // Every SM70+ instruction is 16 bytes, so the address doubles as an instruction index.
  if (value % 16n === 0n) {
    parts.push('', `Instruction #${(value / 16n).toString()} at 16 bytes per instruction.`);
  }
  return parts.join('\n');
}

/**
 * Decode one field of a Maxwell-era column. The wait field is a hex mask; the stall count is
 * hex too. Barrier numbering here is maxas's, not the raw encoding's - see the Volta+ decoder
 * below for the other convention, and never let the two share a sentence.
 */
function maxwellFieldNotes(field) {
  const notes = [];
  if (field.name === 'stall' && /^[0-9a-f]+$/i.test(field.text)) {
    const n = parseInt(field.text, 16);
    notes.push(n === 0
      ? '`0` - dual-issued with the next instruction.'
      : `Stalls **${n}** cycle${n === 1 ? '' : 's'} after issue.`);
  }
  if (field.name === 'wait' && /^[0-9a-f]+$/i.test(field.text)) {
    const mask = parseInt(field.text, 16);
    const on = [];
    for (let b = 0; b < 6; b++) if (mask & (1 << b)) on.push('SB' + b);
    notes.push(on.length ? `Waits on ${on.join(', ')}.` : 'Waits on nothing.');
  }
  return notes;
}

/**
 * Decode one field of a Volta+ bracketed column. Every field carries its own letter tag, the
 * wait field is positional over scoreboards 0-5 rather than a mask, and the stall is decimal.
 */
function voltaFieldNotes(field) {
  const notes = [];
  if (field.name === 'stall') {
    const n = parseInt(field.text.slice(1), 10);
    if (Number.isFinite(n)) {
      notes.push(n === 0
        ? 'No stall - the next instruction may issue immediately.'
        : `The scheduler holds this warp **${n}** cycle${n === 1 ? '' : 's'} before its next issue.`);
    }
  }
  if (field.name === 'wait') {
    const on = [];
    for (const ch of field.text.slice(1)) if (ch !== '-') on.push('scoreboard ' + ch);
    notes.push(on.length
      ? `Waits for ${on.join(', ')} to drain to zero before issuing.`
      : 'Waits on nothing.');
  }
  if (field.name === 'read' || field.name === 'write') {
    const sb = field.text.slice(1);
    const when = field.name === 'read' ? 'its source operands have been read out'
      : 'its result has been written back';
    notes.push(sb === '-'
      ? 'Arms no scoreboard.'
      : `Arms **scoreboard ${sb}** until ${when}.`);
  }
  if (field.name === 'yield') {
    notes.push(field.text === 'Y'
      ? 'The scheduler is hinted that it may switch warps here.'
      : 'No warp-switch hint.');
  }
  return notes;
}

/**
 * Where the scoreboard under the cursor came from, or where it goes.
 *
 * This is the part of a control code that cannot be read off the instruction in front of you:
 * a wait names a scoreboard, and the instructions that armed it are somewhere above. Scanning
 * for them is exact within a straight-line run and a guess across a branch, so the wording
 * distinguishes the two rather than presenting one count for both.
 */
function scoreboardMarkdown(document, position, parsed) {
  let hit;
  try {
    hit = scoreboard.analyzeAt(document, position.line, position.character);
  } catch (e) {
    return null;
  }
  if (!hit || hit.sb === null) return null;

  const lineRef = n => `line ${n + 1}`;
  const parts = [];

  if (hit.role === 'wait') {
    if (!hit.active) {
      return `Not waiting on **scoreboard ${hit.sb}**.`;
    }
    const a = hit.analysis;
    if (!a.arms.length) {
      parts.push(`Nothing above arms **scoreboard ${hit.sb}**` +
        (a.drainLine !== null ? ` since it was drained on ${lineRef(a.drainLine)}` : '') + '.');
    } else {
      parts.push(`**Scoreboard ${hit.sb} stands at ${a.value}** here — ` +
        `${a.value} outstanding arm${a.value === 1 ? '' : 's'} this instruction waits to drain:`);
      parts.push('');
      for (const arm of a.arms) {
        parts.push(`- ${lineRef(arm.line)} · \`${arm.opcode || '?'}\` ` +
          (arm.kind === 'write' ? 'arms it until its result is written back'
            : 'arms it until its operands have been read'));
      }
      if (a.alternatePath) {
        parts.push('', `Nothing between here and ${lineRef(a.pathJoin)} arms it, so this ` +
          'instruction is reached by a branch and these are the arms outstanding before it. ' +
          'Which path actually arrived here cannot be known from the listing alone.');
      } else if (a.drainLine !== null) {
        parts.push('', `Counted from ${lineRef(a.drainLine)}, the previous wait that drained it.`);
      } else if (a.reachedStart) {
        parts.push('', 'Counted from the start of the listing.');
      }
    }
  } else {
    const a = hit.analysis;
    const armed = hit.role === 'write'
      ? 'until this result is written back' : 'until these operands have been read';
    if (a.waitLine === null) {
      parts.push(`Arms **scoreboard ${hit.sb}** ${armed}. ` +
        'Nothing below waits on it' + (a.truncated ? ' within the scanned range' : '') + '.');
    } else {
      parts.push(`Arms **scoreboard ${hit.sb}** ${armed}; ` +
        `drained by the wait on ${lineRef(a.waitLine)}.`);
      const others = a.siblings.filter(s => s.line !== position.line);
      if (others.length) {
        parts.push('', `That wait drains ${a.siblings.length} arms in total — scoreboards are ` +
          'counters, so it blocks until every one of them has retired:');
        for (const s of others) {
          parts.push(`- ${lineRef(s.line)} · \`${s.opcode || '?'}\``);
        }
      }
    }
  }

  const caveats = [];
  if (hit.analysis && hit.analysis.crossedLabel !== null) {
    caveats.push(`the scan crossed the label on ${lineRef(hit.analysis.crossedLabel)}, so ` +
      'control may reach here by a path that skips some of these');
  }
  if (hit.analysis && hit.analysis.crossedBranch !== null) {
    caveats.push(`it crossed a branch on ${lineRef(hit.analysis.crossedBranch)}`);
  }
  if (hit.analysis && hit.analysis.truncated) {
    caveats.push(`it gave up after ${scoreboard.DEFAULT_LIMIT} instructions`);
  }
  if (caveats.length) {
    parts.push('', `*Straight-line reading only: ${caveats.join('; ')}.*`);
  }

  return parts.join('\n');
}

function controlCodeMarkdown(controlCode, field, dependency) {
  const volta = controlCode.era === 'volta';
  const spec = volta ? data.registersDoc.controlCodeVolta : data.registersDoc.controlCode;
  const parts = [`### ${spec.title}`];

  if (field && spec.fields[field.name]) {
    const f = spec.fields[field.name];
    parts.push('', `**${f.title}** = \`${field.text}\``, '', f.desc);
    for (const note of volta ? voltaFieldNotes(field) : maxwellFieldNotes(field)) {
      parts.push('', note);
    }
    if (dependency) parts.push('', '---', '', dependency);
    parts.push('', '---');
  }

  parts.push('', spec.desc);
  parts.push('', '| column | field |', '|---|---|');
  for (const name of spec.fieldOrder) {
    const value = controlCode.fields.find(f => f.name === name);
    parts.push(`| \`${value ? value.text : '?'}\` | ${spec.fields[name].title} |`);
  }
  parts.push('', `*Source: ${spec.source}.*`);
  return parts.join('\n');
}

module.exports = { SassHoverProvider };
