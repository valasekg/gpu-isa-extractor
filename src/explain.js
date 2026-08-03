'use strict';

/**
 * Algorithmic opcode explanations for elaborate hovers.
 *
 * NVIDIA's published tables intentionally stop at a short mnemonic description. These
 * explanations combine that first-party classification with stable instruction-family
 * behavior. They describe the operation readers need in order to follow data flow; they
 * do not pretend to specify binary encoding, corner cases, or cycle counts.
 */

const CATEGORY_DETAILS = {
  'Control': {
    algorithm: 'Updates control-flow, convergence, or warp execution state.',
    operands: 'Targets, masks, and barrier state are control inputs rather than ordinary arithmetic values.',
    execution: 'Acts on the program counter, active-lane mask, or convergence state.',
    scheduling: 'Control transfers can disrupt sequential issue; divergent transfers additionally split the active lanes.'
  },
  'Conversion': {
    algorithm: 'Converts a source value to the destination representation selected by the opcode and postfixes.',
    operands: 'The first register is normally the destination; later operands supply the value and optional packing controls.',
    execution: 'A register-to-register datapath operation. Rounding, saturation, and source/destination widths are selected by postfixes.',
    scheduling: 'Normally compiler-scheduled as fixed-latency arithmetic.'
  },
  'Floating Point': {
    algorithm: 'Performs the floating-point operation named by the opcode on its source operands.',
    operands: 'The first register is normally written; remaining register, constant, or immediate operands are read.',
    execution: 'Runs per active lane unless the opcode is explicitly a uniform-datapath instruction.',
    scheduling: 'Ordinary arithmetic is compiler-scheduled; special-function and matrix operations use dedicated pipelines.'
  },
  'Graphics': {
    algorithm: 'Moves data between shader registers and fixed-function graphics-pipeline state.',
    operands: 'Attribute slots, pixel state, and shader-buffer entries describe fixed-function inputs or outputs.',
    execution: 'Graphics-only operation reconstructed from observed shader disassembly.',
    scheduling: 'May involve fixed-function units outside the ordinary arithmetic datapaths.'
  },
  'Integer': {
    algorithm: 'Performs the integer or bitwise operation named by the opcode.',
    operands: 'The first register is normally the destination; later operands are sources, carry predicates, or control immediates.',
    execution: 'Runs independently in each active lane.',
    scheduling: 'Normally compiler-scheduled as fixed-latency ALU/address arithmetic.'
  },
  'Load/Store': {
    algorithm: 'Transfers data between registers and the memory space selected by the opcode.',
    operands: 'Loads write a leading register destination; stores read an address and value and have no register destination.',
    execution: 'Address generation runs per lane; cache, ordering, width, and scope postfixes refine the transaction.',
    scheduling: 'Memory completion is generally variable-latency and tracked through scoreboards or dependency barriers.'
  },
  'Miscellaneous': {
    algorithm: 'Performs the synchronization, system-state, or miscellaneous operation named by the opcode.',
    operands: 'Operand shape is instruction-specific; system registers and masks are common inputs.',
    execution: 'May interact with warp state, barriers, performance monitors, or special registers.',
    scheduling: 'Latency and side effects are instruction-specific.'
  },
  'Movement': {
    algorithm: 'Rearranges or copies source bits into the destination register without an arithmetic interpretation.',
    operands: 'The first register is the destination; remaining operands provide source bits and selection controls.',
    execution: 'Register-to-register movement, permutation, selection, or lane exchange.',
    scheduling: 'Usually compiler-scheduled; cross-lane movement may use a dedicated warp datapath.'
  },
  'Predicate': {
    algorithm: 'Reads, combines, or writes predicate state used for lane masking and conditional execution.',
    operands: 'Predicate destinations can be paired; later predicates and immediates describe the boolean function.',
    execution: 'Produces per-lane boolean state rather than a conventional numeric result.',
    scheduling: 'Usually fixed-latency, but its result may gate later instructions or control flow.'
  },
  'Surface': {
    algorithm: 'Accesses a graphics surface through its descriptor and coordinates.',
    operands: 'Address/coordinate operands select the surface element; loads write registers and stores/reductions update the surface.',
    execution: 'Descriptor-based memory operation with surface bounds and format semantics.',
    scheduling: 'Variable-latency memory traffic tracked through the scoreboard.'
  },
  'Tensor Core Memory': {
    algorithm: 'Moves or synchronizes tensor-memory data used by matrix pipelines.',
    operands: 'Descriptors, tensor-memory addresses, register fragments, and barrier state are instruction-specific inputs.',
    execution: 'Feeds dedicated tensor-memory or tensor-core hardware rather than the scalar ALU.',
    scheduling: 'Asynchronous forms require explicit completion/barrier coordination.'
  },
  'Tensor Memory Access': {
    algorithm: 'Launches or controls an asynchronous multidimensional tensor-memory transfer.',
    operands: 'A tensor descriptor defines layout and bounds; coordinates and barriers describe this transfer instance.',
    execution: 'The TMA engine performs bulk movement independently of ordinary per-lane loads and stores.',
    scheduling: 'Completion is asynchronous and must be observed through the associated barrier/proxy mechanism.'
  },
  'Texture': {
    algorithm: 'Samples, loads, or queries texture state using coordinates and a texture/sampler descriptor.',
    operands: 'Destination registers receive texels or query results; sources provide coordinates, handles, offsets, and LOD data.',
    execution: 'Runs through the texture pipeline, including address calculation, filtering, and format conversion as selected.',
    scheduling: 'Texture results are variable-latency and scoreboarded.'
  },
  'Uniform Datapath': {
    algorithm: 'Executes the named operation once for a warp-uniform value.',
    operands: 'Uniform registers (`UR*`) and uniform predicates (`UP*`) hold values shared by every lane.',
    execution: 'One warp-wide result replaces 32 identical per-lane computations and avoids consuming vector registers.',
    scheduling: 'Uses the uniform datapath; dependencies are warp-wide rather than per-lane.'
  },
  'Warpgroup': {
    algorithm: 'Coordinates or computes across a warpgroup rather than one independent warp.',
    operands: 'Register fragments, descriptors, and synchronization state are distributed across participating warps.',
    execution: 'All required warps must participate according to the instruction contract.',
    scheduling: 'Matrix work is asynchronous or long-running relative to scalar issue and requires explicit synchronization.'
  }
};

const MUFU_ALGORITHMS = {
  RCP: '`d = approximate(1 / a)`',
  RSQ: '`d = approximate(1 / sqrt(a))`',
  SQRT: '`d = sqrt(a)`',
  SIN: '`d = approximate(sin(2π · a))`; the compiler normally pre-scales radians by `1/(2π)`.',
  COS: '`d = approximate(cos(2π · a))`; the compiler normally pre-scales radians by `1/(2π)`.',
  EX2: '`d = approximate(2^a)`',
  LG2: '`d = approximate(log2(a))`',
  TANH: '`d = approximate(tanh(a))`',
  RCP64H: 'Produces a reciprocal seed from the high word of an FP64 source for iterative refinement.',
  RSQ64H: 'Produces a reciprocal-square-root seed from the high word of an FP64 source.'
};

const COMPARE_OPERATORS = {
  EQ: { symbol: '==', label: 'equal' },
  NE: { symbol: '!=', label: 'not equal' },
  LT: { symbol: '<', label: 'less than' },
  LE: { symbol: '<=', label: 'less than or equal' },
  GT: { symbol: '>', label: 'greater than' },
  GE: { symbol: '>=', label: 'greater than or equal' },
  EQU: { symbol: '==', label: 'equal or unordered', unordered: true },
  NEU: { symbol: '!=', label: 'not equal or unordered', unordered: true },
  LTU: { symbol: '<', label: 'less than or unordered', unordered: true },
  LEU: { symbol: '<=', label: 'less than or equal or unordered', unordered: true },
  GTU: { symbol: '>', label: 'greater than or unordered', unordered: true },
  GEU: { symbol: '>=', label: 'greater than or equal or unordered', unordered: true },
  NUM: { label: 'ordered (neither input is NaN)', orderedOnly: true },
  NAN: { label: 'unordered (at least one input is NaN)', nanOnly: true },
  T: { label: 'always true', constant: true },
  F: { label: 'always false', constant: false }
};

const BOOLEAN_OPERATORS = new Set(['AND', 'OR', 'XOR']);
const TYPE_MODIFIERS = new Set([
  'U8', 'S8', 'U16', 'S16', 'U32', 'S32', 'U64', 'S64',
  'F16', 'F32', 'F64', 'BF16', 'H2'
]);
const NUMERIC_COMPARE_OPCODES = new Set([
  'FSET', 'FSETP', 'DSETP', 'HSET2', 'HSETP2', 'ISETP'
]);
const PREDICATE_SET_OPCODES = new Set(['PSETP', 'UPSETP']);
const LUT_VARIABLES = [
  { name: 'a', bit: 0b100 },
  { name: 'b', bit: 0b010 },
  { name: 'c', bit: 0b001 }
];

function normalizedOpcode(name) {
  const clean = name.replace(/\.64$/, '');
  if (/^U(?=(?:F|I|D|H|LEA|LOP|PLOP|SH|MOV|SEL|SETP|BMSK|BREV|FLO|POPC|PRMT|SGXT))/.test(clean)) {
    return clean.slice(1);
  }
  return clean;
}

function isNumericCompareOpcode(name) {
  return NUMERIC_COMPARE_OPCODES.has(normalizedOpcode(name));
}

function isPredicateSetOpcode(name) {
  return PREDICATE_SET_OPCODES.has(name);
}

function compareType(op, modifiers) {
  const explicit = modifiers.find(mod => TYPE_MODIFIERS.has(mod));
  if (explicit) return explicit.toLowerCase();
  if (op === 'DSETP') return 'f64';
  if (op === 'HSETP2' || op === 'HSET2') return 'f16x2';
  if (op.startsWith('F')) return 'f32';
  return 's32';
}

function compareCondition(spec, type, a, b, floatComparison) {
  if (spec.constant !== undefined) return String(spec.constant);
  if (spec.orderedOnly) return `ordered(${a}, ${b})`;
  if (spec.nanOnly) return `unordered(${a}, ${b})`;

  const relation = `${type}(${a}) ${spec.symbol} ${type}(${b})`;
  if (!floatComparison) return relation;
  if (spec.unordered) return `(${relation}) OR unordered(${a}, ${b})`;
  return `ordered(${a}, ${b}) AND (${relation})`;
}

function operandAt(operands, index, fallback) {
  const value = operands && operands[index];
  return value || fallback;
}

function lutIndex(evaluate) {
  let index = 0;
  for (let minterm = 0; minterm < 8; minterm++) {
    const a = !!(minterm & 0b100);
    const b = !!(minterm & 0b010);
    const c = !!(minterm & 0b001);
    if (evaluate(a, b, c)) index |= 1 << minterm;
  }
  return index;
}

function namedLutExpressions() {
  const expressions = new Map([
    [0x00, 'false'],
    [0xff, 'true']
  ]);
  const add = (expression, evaluate) => {
    const index = lutIndex(evaluate);
    if (!expressions.has(index)) expressions.set(index, expression);
  };
  const variables = [
    ['a', (a) => a],
    ['b', (_a, b) => b],
    ['c', (_a, _b, c) => c]
  ];

  for (const [name, value] of variables) {
    add(name, value);
    add(`NOT ${name}`, (...args) => !value(...args));
  }

  for (let left = 0; left < variables.length; left++) {
    for (let right = left + 1; right < variables.length; right++) {
      const [aName, aValue] = variables[left];
      const [bName, bValue] = variables[right];
      add(`${aName} AND ${bName}`, (...args) => aValue(...args) && bValue(...args));
      add(`${aName} OR ${bName}`, (...args) => aValue(...args) || bValue(...args));
      add(`${aName} XOR ${bName}`, (...args) => aValue(...args) !== bValue(...args));
      add(`${aName} XNOR ${bName}`, (...args) => aValue(...args) === bValue(...args));
      add(`${aName} NAND ${bName}`, (...args) => !(aValue(...args) && bValue(...args)));
      add(`${aName} NOR ${bName}`, (...args) => !(aValue(...args) || bValue(...args)));
    }
  }

  add('a XOR b XOR c', (a, b, c) => a !== b !== c);
  add('NOT (a XOR b XOR c)', (a, b, c) => !(a !== b !== c));
  add('(a AND b) OR (a AND c) OR (b AND c)',
    (a, b, c) => (a && b) || (a && c) || (b && c));
  add('a ? b : c', (a, b, c) => a ? b : c);
  add('b ? a : c', (a, b, c) => b ? a : c);
  add('c ? a : b', (a, b, c) => c ? a : b);
  return expressions;
}

const NAMED_LUT_EXPRESSIONS = namedLutExpressions();

function parseLutLiteral(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim().replace(/^\+/, '');
  if (!/^(?:0[xX][0-9a-fA-F]+|0[bB][01]+|\d+)$/.test(text)) return null;
  const parsed = text.startsWith('0x') || text.startsWith('0X')
    ? parseInt(text.slice(2), 16)
    : text.startsWith('0b') || text.startsWith('0B')
      ? parseInt(text.slice(2), 2)
      : parseInt(text, 10);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 0xff ? parsed : null;
}

function popcount(value) {
  let bits = value;
  let count = 0;
  while (bits) {
    count += bits & 1;
    bits >>>= 1;
  }
  return count;
}

/**
 * Convert an 8-bit LOP3 truth table to a compact Boolean expression. Named common
 * operations win; the remaining tables use an exact minimum sum-of-products cover.
 */
function decodeLutExpression(index) {
  if (!Number.isInteger(index) || index < 0 || index > 0xff) return null;
  if (NAMED_LUT_EXPRESSIONS.has(index)) return NAMED_LUT_EXPRESSIONS.get(index);

  const implicants = [];
  for (let mask = 0; mask < 8; mask++) {
    for (let bits = 0; bits < 8; bits++) {
      if (bits & ~mask) continue;
      let cover = 0;
      let valid = true;
      for (let minterm = 0; minterm < 8; minterm++) {
        if ((minterm & mask) !== bits) continue;
        const selected = 1 << minterm;
        if (!(index & selected)) {
          valid = false;
          break;
        }
        cover |= selected;
      }
      if (valid && cover) {
        implicants.push({ mask, bits, cover, literals: popcount(mask) });
      }
    }
  }

  const best = new Array(256);
  best[0] = { terms: [], literals: 0, key: '' };
  for (let covered = 0; covered < 256; covered++) {
    const current = best[covered];
    if (!current) continue;
    for (let i = 0; i < implicants.length; i++) {
      const implicant = implicants[i];
      const next = covered | implicant.cover;
      if (next === covered) continue;
      const terms = current.terms.concat(i);
      const literals = current.literals + implicant.literals;
      const key = terms.join(',');
      const candidate = { terms, literals, key };
      const previous = best[next];
      if (!previous ||
          terms.length < previous.terms.length ||
          (terms.length === previous.terms.length && literals < previous.literals) ||
          (terms.length === previous.terms.length && literals === previous.literals &&
           key < previous.key)) {
        best[next] = candidate;
      }
    }
  }

  const solution = best[index];
  if (!solution) return null;
  const terms = solution.terms.map(i => implicants[i])
    .sort((left, right) => right.mask - left.mask || right.bits - left.bits)
    .map(implicant => {
      const literals = LUT_VARIABLES
        .filter(variable => implicant.mask & variable.bit)
        .map(variable => implicant.bits & variable.bit ? variable.name : `NOT ${variable.name}`);
      const term = literals.join(' AND ');
      return literals.length > 1 ? `(${term})` : term;
    });
  return terms.join(' OR ');
}

function decodedLutExpression(value) {
  const index = parseLutLiteral(value);
  return index === null ? null : decodeLutExpression(index);
}

function predicateOperand(value) {
  return /^(?:U?P(?:T|\d+))$/.test(value || '');
}

/**
 * Most arithmetic instructions have one numeric destination followed by sources. A few
 * families insert a predicate destination before or after that numeric destination; keep
 * that shape knowledge here so every formula uses the same binding rules.
 */
function numericLayout(operands) {
  let destination = 0;
  let source = 1;
  if (predicateOperand(operandAt(operands, 0, ''))) {
    destination = 1;
    source = 2;
  } else if (predicateOperand(operandAt(operands, 1, ''))) {
    source = 2;
  }
  return { destination, source };
}

function bindingsFromLayout(operands) {
  const { destination, source } = numericLayout(operands);
  return {
    d: operandAt(operands, destination, null),
    a: operandAt(operands, source, null),
    b: operandAt(operands, source + 1, null),
    c: operandAt(operands, source + 2, null)
  };
}

function addressExpression(value) {
  if (!value) return value;
  if (value.startsWith('[') && value.endsWith(']')) return value.slice(1, -1);
  const attribute = /^a\[(.*)\]$/.exec(value);
  return attribute ? attribute[1] : value;
}

/**
 * Map symbolic names used by the explanatory formulas to the printed instruction shape.
 * Families without a stable formula deliberately return no bindings instead of inventing
 * architecture-specific semantics.
 */
function contextualBindings(name, operands) {
  if (!operands || !operands.some(Boolean)) return null;

  const op = normalizedOpcode(name);
  const common = bindingsFromLayout(operands);
  const { destination, source } = numericLayout(operands);

  if (op === 'MUFU' ||
      /^(?:F|D|H)(?:ADD|MUL|FMA)(?:2|32I)?$/.test(op) ||
      /^(?:IADD|IADD3|IADD32I|VIADD)$/.test(op) ||
      /^(?:IMAD|IMUL|IMUL32I)$/.test(op) ||
      /^(?:MOV|MOV32I|POPC|BREV)$/.test(op) ||
      /^(?:F2F|F2I|F2IP|I2F|I2FP|I2I|I2IP|FRND)$/.test(op)) {
    return common;
  }

  if (/^(?:ISCADD|ISCADD32I)$/.test(op)) {
    return { ...common, scale: operandAt(operands, source + 2, null) };
  }

  if (/^(?:F|D|H|I|VI|VHM)MNMX/.test(op)) {
    return { ...common, predicate: operandAt(operands, source + 2, null) };
  }

  if (/^(?:F|I|U)?SEL$/.test(op) || op === 'SEL') {
    return { ...common, p: operandAt(operands, source + 2, null) };
  }

  if (op === 'LOP3') {
    return { ...common, imm8: operandAt(operands, source + 3, null) };
  }

  if (op === 'PLOP3') {
    return {
      p: operandAt(operands, 0, null),
      q: operandAt(operands, 1, null),
      a: operandAt(operands, 2, null),
      b: operandAt(operands, 3, null),
      c: operandAt(operands, 4, null),
      immP: operandAt(operands, 5, null),
      immQ: operandAt(operands, 6, null)
    };
  }

  if (/^(?:SHL|SHR)$/.test(op)) {
    return { ...common, shift: operandAt(operands, source + 1, null) };
  }

  if (op === 'SHFL') {
    return {
      p: operandAt(operands, 0, null),
      d: operandAt(operands, destination, null),
      a: operandAt(operands, source, null),
      lane: operandAt(operands, source + 1, null),
      clamp: operandAt(operands, source + 2, null)
    };
  }

  if (/^(?:LD|LDC|LDG|LDL|LDS|LDSM|LDT|LDTM|SULD)/.test(name) ||
      /^(?:ULDC|UTMALDG)/.test(name)) {
    return {
      destination: operandAt(operands, 0, null),
      address: addressExpression(operandAt(operands, 1, null))
    };
  }

  if (/^(?:ST|STAS|STG|STL|STS|STSM|STT|STTM|SUST|UTMASTG)/.test(name)) {
    return {
      address: addressExpression(operandAt(operands, 0, null)),
      value: operandAt(operands, 1, null)
    };
  }

  if (/^(?:BRA|BRX|BRXU|JMP|JMX|JMXU)$/.test(name)) {
    return { target: operandAt(operands, 0, null) };
  }

  if (/^(?:S2R|CS2R|S2UR|CS2UR)$/.test(name)) {
    return {
      d: operandAt(operands, 0, null),
      special_register: operandAt(operands, 1, null)
    };
  }

  if (/^(?:HMMA|IMMA|BMMA|DMMA|OMMA|QMMA|HGMMA|IGMMA|BGMMA|QGMMA)$/.test(name)) {
    return {
      D: operandAt(operands, 0, null),
      A: operandAt(operands, 1, null),
      B: operandAt(operands, 2, null),
      C: operandAt(operands, 3, null)
    };
  }

  if (name === 'ALD') {
    return {
      d: operandAt(operands, 0, null),
      address: addressExpression(operandAt(operands, 1, null))
    };
  }
  if (name === 'AST') {
    return {
      address: addressExpression(operandAt(operands, 0, null)),
      value: operandAt(operands, 1, null)
    };
  }

  return null;
}

/**
 * Bind only inline-code formulas. Prose and modifier names remain untouched, and one
 * alternation pass prevents operand text from being interpreted as another placeholder.
 */
function bindAlgorithm(algorithm, bindings) {
  if (!bindings) return algorithm;
  const present = Object.entries(bindings).filter(([, value]) => value);
  if (!present.length) return algorithm;
  const values = Object.fromEntries(present);
  const names = present.map(([name]) => name)
    .sort((a, b) => b.length - a.length)
    .map(name => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const placeholder = new RegExp(`\\b(?:${names.join('|')})\\b`, 'g');

  return algorithm.replace(/`([^`\r\n]+)`/g, (span, expression) => {
    const bound = expression.replace(placeholder, name =>
      String(values[name]).replace(/`/g, '\\`'));
    return `\`${bound}\``;
  });
}

function compareAlgorithm(op, modifiers, operands) {
  const cmpName = modifiers.find(mod => COMPARE_OPERATORS[mod]) || 'EQ';
  const cmp = COMPARE_OPERATORS[cmpName];
  const bool = modifiers.find(mod => BOOLEAN_OPERATORS.has(mod)) || null;
  const type = compareType(op, modifiers);
  const floatComparison = type.startsWith('f') || type === 'bf16';
  const packed = op === 'HSETP2' || op === 'HSET2';
  const isPredicateResult = op.endsWith('SETP') || op === 'HSETP2';
  const offset = isPredicateResult ? 2 : 1;
  const a = operandAt(operands, offset, 'a');
  const b = operandAt(operands, offset + 1, 'b');
  const c = operandAt(operands, offset + 2, 'c');
  const p = operandAt(operands, 0, isPredicateResult ? 'p' : 'd');
  const q = operandAt(operands, 1, 'q');
  const ftz = modifiers.includes('FTZ');
  const left = ftz ? 'a′' : a;
  const right = ftz ? 'b′' : b;
  const lines = [];

  if (ftz) {
    lines.push(`\`a′ = ftz(${a}); b′ = ftz(${b})\``);
  }

  if (packed) {
    lines.push(`\`t.lo = ${compareCondition(cmp, 'f16', `${left}.lo`, `${right}.lo`, true)}\``);
    lines.push(`\`t.hi = ${compareCondition(cmp, 'f16', `${left}.hi`, `${right}.hi`, true)}\``);
  } else {
    lines.push(`\`t = ${compareCondition(cmp, type, left, right, floatComparison)}\``);
  }

  const combine = (value) => bool ? `(${value}) ${bool} ${c}` : value;
  if (isPredicateResult) {
    if (packed) {
      lines.push(`\`${p} = ${combine('t.lo')}\``);
      lines.push(`\`${q} = ${combine('t.hi')}\``);
    } else {
      lines.push(`\`${p} = ${combine('t')}\``);
      const discarded = q === 'PT' || q === 'UPT' ? '; discarded' : '';
      lines.push(`\`${q} = ${combine('NOT t')}\`  *(complementary compare result${discarded})*`);
    }
  } else if (packed) {
    const trueValue = modifiers.includes('BF') ? '1.0h' : '0xffff';
    lines.push(`\`${p}.lo = ${combine('t.lo')} ? ${trueValue} : 0\``);
    lines.push(`\`${p}.hi = ${combine('t.hi')} ? ${trueValue} : 0\``);
  } else {
    const trueValue = modifiers.includes('BF') ? '1.0f' : '0xffffffff';
    lines.push(`\`${p} = ${combine('t')} ? ${trueValue} : 0\``);
  }

  const traits = [`${cmpName}: ${cmp.label}`, `source type: ${type}`];
  if (bool) traits.push(`combine with ${c} using ${bool}`);
  if (ftz) traits.push('flush FP32 subnormals to signed zero');
  lines.push(`*Decoded postfixes: ${traits.join('; ')}.*`);
  return lines.join('  \n');
}

/**
 * PSETP replaces the numeric comparison with predicate logic while retaining SETP's
 * primary/complementary destination pair. Two Boolean postfixes select the inner
 * predicate operation and the optional combination with the trailing predicate.
 */
function predicateSetAlgorithm(modifiers, operands) {
  const booleanOps = modifiers.filter(mod => BOOLEAN_OPERATORS.has(mod));
  const inner = booleanOps[0] || 'BOOL';
  const outer = booleanOps[1] || null;
  const p = operandAt(operands, 0, 'p');
  const q = operandAt(operands, 1, 'q');
  const a = operandAt(operands, 2, 'a');
  const b = operandAt(operands, 3, 'b');
  const c = operandAt(operands, 4, 'c');
  const t = `(${a}) ${inner} (${b})`;
  const combine = value => outer ? `(${value}) ${outer} ${c}` : value;
  const discarded = q === 'PT' || q === 'UPT' ? '; discarded' : '';
  const traits = [`predicate operation: ${inner}`];
  if (outer) traits.push(`combine with ${c} using ${outer}`);

  return [
    `\`t = ${t}\``,
    `\`${p} = ${combine('t')}\``,
    `\`${q} = ${combine('NOT t')}\`  *(complementary predicate result${discarded})*`,
    `*Decoded postfixes: ${traits.join('; ')}.*`
  ].join('  \n');
}

function specificAlgorithm(name, modifiers, operands) {
  const op = normalizedOpcode(name);
  const firstMod = modifiers.length ? modifiers[0] : '';

  if (op === 'MUFU') {
    return {
      algorithm: MUFU_ALGORITHMS[firstMod] ||
        'Applies the special-function operation selected by the first postfix to the source value.',
      operands: 'The destination receives an approximation or seed; the following operand supplies the argument.',
      execution: 'Uses the multi-function unit (MUFU/SFU), independently for each active lane.',
      scheduling: 'Dedicated special-function pipeline; consumers must respect its result dependency.'
    };
  }

  if (/^(?:F|D|H)ADD(?:2|32I)?$/.test(op)) {
    return { algorithm: '`d = a + b` with precision and rounding selected by the opcode/postfixes.' };
  }
  if (/^(?:F|D|H)MUL(?:2|32I)?$/.test(op)) {
    return { algorithm: '`d = a × b` with precision and rounding selected by the opcode/postfixes.' };
  }
  if (/^(?:F|D|H)FMA(?:2|32I)?$/.test(op)) {
    return { algorithm: '`d = a × b + c`, evaluated as a fused operation with one final rounding.' };
  }
  if (/^(?:IADD|IADD3|IADD32I|VIADD)$/.test(op)) {
    return {
      algorithm: op === 'IADD3' ? '`d = a + b + c`; an optional predicate destination receives carry-out.'
        : '`d = a + b` using the selected integer width.'
    };
  }
  if (/^(?:IMAD|IMUL|IMUL32I|ISCADD|ISCADD32I)$/.test(op)) {
    if (op.startsWith('IMAD')) {
      return { algorithm: '`d = a × b + c`; `.HI`/`.WIDE` select which part of the full product is retained.' };
    }
    if (op.startsWith('ISCADD')) {
      return { algorithm: '`d = (a << scale) + b`; a combined scaled-add used heavily for address calculation.' };
    }
    return { algorithm: '`d = a × b` using integer arithmetic.' };
  }
  if (/^(?:F|D|H|I|VI|VHM)MNMX/.test(op)) {
    return { algorithm: '`d = predicate ? min(a, b) : max(a, b)`; exact NaN/sign behavior follows the postfixes.' };
  }
  if (isNumericCompareOpcode(name)) {
    return {
      algorithm: compareAlgorithm(op, modifiers, operands),
      operands: op.endsWith('SETP') || op === 'HSETP2'
        ? 'Predicate destinations come first, followed by comparison inputs `a` and `b` and the optional combining predicate `c`. For scalar `SETP`, the second destination receives the complementary comparison combined with the same `c`; `PT` discards it.'
        : 'A general register destination comes first, followed by comparison inputs `a` and `b` and the optional combining predicate `c`.'
    };
  }
  if (isPredicateSetOpcode(name)) {
    return {
      algorithm: predicateSetAlgorithm(modifiers, operands),
      operands: 'Two predicate destinations come first, followed by predicate inputs `a` and `b` and an optional combining predicate `c`. The second destination receives the complementary inner result; `PT`/`UPT` discards it.'
    };
  }
  if (/^(?:F|I|U)?SEL$/.test(op) || op === 'SEL') {
    return { algorithm: '`d = p ? a : b`; selection is lane-local and does not branch.' };
  }
  if (op === 'LOP3') {
    const { source } = numericLayout(operands);
    const decoded = decodedLutExpression(operandAt(operands, source + 3, null));
    const equivalent = decoded
      ? `  \nEquivalent Boolean operation: \`d = ${decoded}\`.`
      : '';
    return {
      algorithm: '`d = LUT(a, b, c, imm8)` bit by bit. The 8-bit immediate is the complete ternary truth table.' +
        equivalent,
      operands: 'Three bit-vector inputs feed the LUT; the immediate chooses the result for all eight input combinations.'
    };
  }
  if (op === 'PLOP3') {
    const pDecoded = decodedLutExpression(operandAt(operands, 5, null));
    const qDecoded = decodedLutExpression(operandAt(operands, 6, null));
    const lines = [
      '`p = LUT(a, b, c, immP)`',
      pDecoded ? `Equivalent Boolean operation: \`p = ${pDecoded}\`.` : null,
      '`q = LUT(a, b, c, immQ)`',
      qDecoded ? `Equivalent Boolean operation: \`q = ${qDecoded}\`.` : null
    ].filter(Boolean);
    return {
      algorithm: lines.join('  \n'),
      operands: 'Three predicate sources feed two truth tables; each trailing immediate selects the result written to its corresponding predicate destination.'
    };
  }
  if (/^(?:LOP|LOP32I)$/.test(op)) {
    return { algorithm: 'Applies the selected bitwise boolean operation (`AND`, `OR`, `XOR`, etc.) to the source words.' };
  }
  if (/^(?:SHF)$/.test(op)) {
    return { algorithm: 'Concatenates two source words, shifts the double-width value, and selects the requested result word.' };
  }
  if (/^(?:SHL|SHR)$/.test(op)) {
    return { algorithm: op === 'SHL' ? '`d = a << shift`.' : '`d = a >> shift`; signedness selects zero- or sign-fill.' };
  }
  if (op === 'LEA' || op === 'CLEA') {
    return { algorithm: 'Forms an effective address from a base plus scaled/index contributions, with optional high-word and carry handling.' };
  }
  if (op === 'MOV' || op === 'MOV32I') {
    return { algorithm: '`d = a`; copies the source bits without changing their interpretation.' };
  }
  if (op === 'PRMT') {
    return { algorithm: 'Builds the destination byte-by-byte by selecting bytes from the concatenated source pair according to the control operand.' };
  }
  if (op === 'SHFL') {
    return {
      algorithm: '`d = shuffle(a, lane, clamp)`; the mode computes the source lane and `p` reports whether it was in range.',
      execution: 'Cross-lane exchange within the active warp.'
    };
  }
  if (op === 'POPC') {
    return { algorithm: '`d = population_count(a)`; counts set bits.' };
  }
  if (op === 'BREV') {
    return { algorithm: '`d = reverse_bits(a)`.' };
  }
  if (op === 'FLO') {
    return { algorithm: 'Finds the leading set-bit position (find-leading-one), with signed/shift behavior selected by postfixes.' };
  }
  if (/^(?:F2F|F2I|F2IP|I2F|I2FP|I2I|I2IP|FRND)$/.test(op)) {
    return { algorithm: 'Converts `a` from the source type to the destination type; rounding/saturation/packing postfixes define edge behavior.' };
  }
  if (name === 'LDSM') {
    return {
      algorithm: 'Collectively loads one or more shared-memory matrices and distributes their fragments into aligned destination registers across the warp.'
    };
  }
  if (/^(?:LD|LDC|LDG|LDL|LDS|LDSM|LDT|LDTM|SULD)/.test(name) ||
      /^(?:ULDC|UTMALDG)/.test(name)) {
    return {
      algorithm: '`destination = memory[address]`; width and memory-space semantics come from the opcode/postfixes.',
      operands: 'A leading register or register group is written; the bracketed address and descriptor inputs are read.'
    };
  }
  if (/^(?:ST|STAS|STG|STL|STS|STSM|STT|STTM|SUST|UTMASTG)/.test(name)) {
    return {
      algorithm: '`memory[address] = value`; no general-purpose register is written.',
      operands: 'The address/descriptor and stored register group are all source operands.'
    };
  }
  if (/^(?:ATOM|ATOMG|ATOMS|SUATOM)/.test(name)) {
    return {
      algorithm: 'Atomically reads the addressed value, applies the selected read-modify-write operation, stores the result, and may return the old value.',
      execution: 'Serialization scope is the addressed memory location at the selected memory scope.'
    };
  }
  if (/^(?:RED|REDAS|REDG|SURED|UTMAREDG)/.test(name)) {
    return {
      algorithm: 'Atomically combines the source into memory using the selected reduction operation without requiring the old value as a register result.'
    };
  }
  if (/^(?:MEMBAR|FENCE|ERRBAR|CGAERRBAR)$/.test(name)) {
    return {
      algorithm: 'Orders and/or makes prior memory operations visible according to the selected consistency and scope postfixes.',
      operands: 'Primarily a side effect; it does not produce an ordinary numeric destination.'
    };
  }
  if (/^(?:BRA|BRX|BRXU|JMP|JMX|JMXU)$/.test(name)) {
    return {
      algorithm: '`PC = target` for participating lanes; a guard predicate can leave non-participating lanes on the fall-through path.',
      operands: 'The target may be immediate, relative, absolute, or register-derived.'
    };
  }
  if (name === 'CALL') {
    return { algorithm: 'Records a return point and transfers control to the target function.' };
  }
  if (name === 'RET' || name === 'RTT') {
    return { algorithm: 'Restores the caller continuation and transfers control back to it.' };
  }
  if (/^(?:EXIT|PREEXIT|KILL)$/.test(name)) {
    return { algorithm: 'Removes participating lanes from further normal execution of this program.' };
  }
  if (/^(?:BSSY|BSYNC|BREAK|BMOV|WARPSYNC|BAR|DEPBAR|UCGABAR_)/.test(name)) {
    return {
      algorithm: 'Updates or waits on convergence/synchronization state so participating lanes can safely proceed together.'
    };
  }
  if (/^(?:VOTE|VOTEU)$/.test(name)) {
    return { algorithm: 'Combines a predicate across active lanes (`ALL`, `ANY`, ballot, etc.) and returns the warp-wide result.' };
  }
  if (/^(?:S2R|CS2R|S2UR|CS2UR)$/.test(name)) {
    return { algorithm: '`d = special_register`; reads hardware/launch state such as lane, CTA, clock, or grid identifiers.' };
  }
  if (/^(?:HMMA|IMMA|BMMA|DMMA|OMMA|QMMA|HGMMA|IGMMA|BGMMA|QGMMA)$/.test(name)) {
    return {
      algorithm: '`D = A × B + C` on distributed matrix fragments; shape and element types are encoded by postfixes.',
      operands: 'Each printed base register denotes an aligned register group holding a per-lane matrix fragment.',
      execution: name.endsWith('GMMA') ? 'Warpgroup matrix multiply-accumulate on tensor cores.'
        : 'Warp-level matrix multiply-accumulate on tensor cores.',
      scheduling: 'Tensor-core operation; fragment dependencies and architecture-specific issue rules apply.'
    };
  }
  if (/^(?:TEX|TLD|TLD4|TMML|TXD|TXQ)$/.test(name)) {
    return {
      algorithm: name === 'TXQ' ? 'Queries texture or sampler metadata and writes the requested property.'
        : 'Computes texture coordinates/LOD, accesses the selected texels, and optionally filters or gathers components.'
    };
  }
  if (name === 'IPA') {
    return {
      algorithm: 'Interpolates a raster attribute at the current pixel/sample. Perspective-correct code commonly divides by interpolated `1/w` afterward.'
    };
  }
  if (name === 'ALD') return { algorithm: '`d = attribute[address]`; reads an already-resolved graphics attribute.' };
  if (name === 'AST') return { algorithm: '`attribute[address] = value`; publishes shader output to the graphics pipeline.' };
  if (name === 'PIXLD') return { algorithm: 'Reads per-pixel fixed-function state such as coverage, sample, or live-lane information.' };

  return null;
}

function explainOpcode(name, entry, modifiers = [], operands = []) {
  const category = entry && entry.cat ? entry.cat : 'Miscellaneous';
  const base = CATEGORY_DETAILS[category] || CATEGORY_DETAILS.Miscellaneous;
  const specific = specificAlgorithm(name, modifiers, operands) || {};
  const contextual = isNumericCompareOpcode(name) || isPredicateSetOpcode(name)
    ? specific.algorithm
    : bindAlgorithm(specific.algorithm || base.algorithm, contextualBindings(name, operands));
  return {
    algorithm: contextual,
    operands: specific.operands || base.operands,
    execution: specific.execution || base.execution,
    scheduling: specific.scheduling || base.scheduling,
    caveat: 'Explanatory model, not an encoding specification. Exact edge cases and timing can vary by architecture and postfix.'
  };
}

module.exports = { explainOpcode, CATEGORY_DETAILS, decodeLutExpression };
