'use strict';

/**
 * Everything that is true of AMD specifically: the second row in the registry.
 *
 * The counterpart of `isa_nvidia.js`, and deliberately shaped like it - a `target` for
 * producing and a `dialect` for reading. Where a cell is null, that is a statement about this
 * ISA rather than an unfinished edge, and `absences` says which in words so the banner can
 * print the reason once instead of every consumer inventing its own.
 *
 * ## What the roads are
 *
 *     .slang --slangc--> .spv  --rga -s vk-spv-offline--> RDNA ISA text
 *     .slang --slangc--> .hlsl --rga -s dxr------------> RDNA ISA text   (raytracing)
 *     an AMD code object ------ --rga -s bin------------> RDNA ISA text   (nothing compiled)
 *
 * All three end in TEXT rather than in bytes to disassemble, which is the whole reason
 * `isa_entry.emit()` exists. The first is one step shorter than either NVIDIA road.
 *
 * They are three roads rather than one flag because they disagree about almost everything:
 * the raytracing road goes through HLSL rather than SPIR-V and needs a state definition
 * synthesised for it (`dxr_library.js`), and the binary road compiles nothing at all and takes
 * no target, because the file it reads already names one. Even the list of GPUs differs - RGA
 * offers 10 targets in the Vulkan offline mode and 27 in the DXR mode, so `targets()` takes
 * the mode rather than assuming there is one answer.
 *
 * ## What it does not need, and the NVIDIA road does
 *
 * An AMD GPU. Neither RGA mode requires one: the offline mode is a static compiler, and the
 * live-driver mode falls back to the AMDVLK driver RGA ships with. Measured on a machine with
 * only an NVIDIA adapter, both produced output, and the live road is really compiling rather
 * than replaying the offline result - it responds to its inputs, changing from 87 instructions
 * to 76 when handed a pipeline state file. (Not because the two disagree: given that file they
 * agree exactly. See below.)
 *
 * That inverts the NVIDIA graphics road's central constraint, where the local driver IS the
 * compiler. It is stated here rather than generalised from there.
 *
 * ## Which road is accurate - measured, not assumed
 *
 * This header used to end by declining to say, on the strength of that 87-vs-76 gap. The gap
 * turned out not to be the two compilers disagreeing. Feeding the live road a pipeline state -
 * an EMPTY one, carrying no descriptor layout at all - drops it to 76 and makes it
 * byte-identical to the offline listing. The 87 was RGA's invented default state, which is
 * what its own warning is about.
 *
 * So the offline road is not an approximation of the driver's output; on what has been
 * measured it IS the driver's output, and the caveat belongs on live-with-no-state alone.
 * `tools/test_rga.js` pins both halves so the banner cannot keep claiming this after it stops
 * being true.
 *
 * ## What is still NOT claimed
 *
 * That the descriptor layout never matters here. It did not change the code for this shader
 * pair on this target - substituting UNIFORM_BUFFER_DYNAMIC and adding eight unused bindings
 * produced identical output, where the same substitution on the NVIDIA graphics road moved a
 * shader from 48 instructions to 40. One pair on one target is not a rule, and it is not
 * written down as one.
 */

const path = require('path');

const dataRdna = require('./data_rdna');
const dependRdna = require('./depend_rdna');
const parseRdna = require('./parse_rdna');
const rga = require('./rga');

/** Banner label column. Shared with `output.js`, which owns the layout. */
const FIELD_WIDTH = 14;

const cont = text => `// ${' '.repeat(FIELD_WIDTH)}  ${text}`;

// --------------------------------------------------------------------------- provenance

/**
 * Where an AMD listing's code came from.
 *
 * Two rows. There is still no cache row - this extension has no reader for an AMD driver's
 * shader cache - and no `driver` row distinct from `compiled`, because RGA's live-driver mode
 * is still a compile this tool asked for rather than a by-product it went looking for. That
 * distinction is what the NVIDIA `driver` row exists to record, and inventing one here would
 * be describing a road that does not exist.
 *
 * `binary` is the one road in that did not compile anything: an AMD code object the user
 * already had, read back with `-s bin`. It is kept separate from `compiled` because the
 * honest banner differs in the field that matters - there is no source file and no command
 * that produced the code, only a file and the target RGA detected inside it.
 */
const PROVENANCE = {
  binary(result, sweepResult, field) {
    const { object, compile } = result;
    const lines = [field('read from') + `${object.source}`];
    // The target is the code object's own word, not a setting and not a guess - which is the
    // whole reason this road needs no ASIC. Worth saying, because every other AMD listing's
    // target was chosen for it.
    if (compile.asic) {
      lines.push(field('target') + `${compile.asic} (detected in the code object)`);
    }
    lines.push(field('disassembled') + `${compile.steps.map(s => s.tool).join(' -> ')}`);
    for (const step of compile.steps) lines.push(cont(step.command));
    return lines;
  },

  compiled(result, sweepResult, field) {
    const { object, compile } = result;
    const lines = [field('source') + `${object.source}`];
    for (const note of compile.sources.slice(1)) lines.push(cont(`with ${note}`));
    lines.push(field('compiled') + `${compile.steps.map(s => s.tool).join(' -> ')}`);
    for (const step of compile.steps) lines.push(cont(step.command));
    if (compile.pipeline) lines.push(field('pipeline') + `${compile.pipeline}`);
    if (compile.directive) lines.push(field('flags') + `${compile.directive} (from the file)`);
    if (compile.configuredFlags) lines.push(cont(`${compile.configuredFlags} (from settings)`));
    return lines;
  }
};

/**
 * What "registers" means here.
 *
 * RGA states VGPR and SGPR counts in its statistics CSV, which is a second account of the
 * shader independent of the code - the same two-source arrangement the cache road has, and the
 * thing `stats.crossCheck` exists to disagree with.
 */
const REGISTER_SOURCE = { compiled: 'reported by RGA', binary: 'reported by RGA' };

// --------------------------------------------------------------------------- banner tail

/**
 * Everything from `microcode` down to the capability notes.
 *
 * The identity line is the interesting one. There is no microcode blob to hash - RGA emits one
 * ELF for the whole pipeline, not one per stage - so the listing is identified by a digest of
 * the ISA text, and the banner SAYS that rather than printing a hash that looks like the
 * NVIDIA one and means something else.
 */
function bannerTail(result, field) {
  const { object, arch, nvdisasm, nvdisasmVersion, command } = result;
  const pkg = require('../package.json');

  const lines = [
    field('code') + `${object.codeBytes} bytes of ISA` +
      (object.sha1 ? `, sha1 ${object.sha1}` : ''),
    cont(object.identityNote || 'digest of the ISA text'),
    field('asic') + `${arch}`,
    field('rga') + `${nvdisasm}`,
    cont(nvdisasmVersion),
    cont(command),
    field('tool') + `${pkg.displayName} ${pkg.version}`
  ];

  // Absences, once, in words. A reader who does not find a control column should learn why
  // here rather than concluding the feature is broken.
  lines.push(
    '//',
    '// No control-code column: RDNA states dependency resolution as separate instructions',
    '//   (s_wait_*, s_delay_alu) rather than as a field inside every instruction, so the',
    '//   scheduling is in the code below and carries hovers. Some gfx11+ encodings do hold',
    '//   embedded wait fields - wait_exp, wait_va_vdst - and those print as ordinary',
    '//   modifiers.',
    '// No source correlation: RGA offers none in any Vulkan mode.',
    '// Instruction width varies (4, 8 or 12 bytes), so addresses are printed as RGA emits',
    '//   them and no instruction index is derived from them.');

  if (result.accuracy) lines.push('//', ...result.accuracy.map(line => `// ${line}`));
  return lines;
}

// --------------------------------------------------------------------------- measuring

/**
 * Every register the code names, in one alternation over the whole listing.
 *
 * A range writes its high end too - `v[2:3]` means v3 is live - so both spellings are captured
 * and the range's upper bound is what counts. Getting that wrong understates the maximum by up
 * to three on exactly the wide loads and stores where it matters most.
 *
 * `\b[vs]\d+` cannot match inside a mnemonic: `v_mul_f32_e32` has no digit directly after a
 * word-boundary `v`, and `s_mov_b32` none after `s`. `f32` and `b128` are preceded by `_`,
 * which is a word character, so the boundary does not fire there either.
 */
const REGISTER_RE = /\b([vs])\[(\d+):(\d+)\]|\b([vs])(\d+)\b/g;

/**
 * DS-encoded instructions that read rasterizer-written data rather than allocated LDS.
 *
 * `ds_param_load` is how an RDNA pixel shader fetches its interpolants, and `ds_direct_load`
 * how it reads a flat-shaded one. Both go through LDS the hardware populated before the shader
 * ran, so neither consumes the workgroup's LDS budget - which is why RGA reports
 * `USED_LDS_BYTES 0` for a fragment shader full of them, correctly.
 */
const PARAM_LOAD = /^ds_(?:param|direct)_load/;

/** Instruction-class prefixes, longest first so `s_wait_` is not shadowed by `s_`. */
const CLASS_OF = [
  ['export', 'Export'], ['exp ', 'Export'],
  ['s_wait', 'Wait'], ['s_delay_alu', 'Wait'],
  ['ds_', 'LDS'], ['buffer_', 'Memory'], ['global_', 'Memory'], ['flat_', 'Memory'],
  ['scratch_', 'Scratch'], ['image_', 'Texture'], ['tbuffer_', 'Memory'],
  ['v_', 'Vector'], ['s_', 'Scalar']
];

/**
 * What a listing is made of, counted from the text.
 *
 * One walk for the opcodes and one alternation over the whole string for the operands, for the
 * reason `stats.js` measured and recorded: scanning the text once inside the regex engine beat
 * invoking a pattern per line, and beat several patterns scanned separately.
 */
function measureRdna(text) {
  const byClass = new Map();
  let instructions = 0;
  let waits = 0;
  let delays = 0;
  let usesLds = false;
  let usesScratch = false;

  let from = 0;
  while (from <= text.length) {
    let end = text.indexOf('\n', from);
    if (end < 0) end = text.length;
    const line = text.slice(from, end);
    from = end + 1;

    const parsed = parseRdna.parseLine(line);
    if (!parsed || !parsed.opcode) continue;
    const op = parsed.opcode.text;
    instructions++;

    if (op.startsWith('s_wait')) waits++;
    else if (op === 's_delay_alu') delays++;
    // `ds_` is the encoding class, not the question. A pixel shader reads its interpolants
    // with `ds_param_load`, and those live in LDS the RASTERIZER wrote - they cost the shader
    // no LDS allocation at all. Counting them as LDS use made the cross-check report "the code
    // reads or writes LDS but RGA reports none used" on an ordinary fragment shader, which is
    // the crying-wolf failure that gets a check ignored. Only allocation-consuming access
    // counts.
    if (op.startsWith('ds_') && !PARAM_LOAD.test(op)) usesLds = true;
    if (op.startsWith('scratch_')) usesScratch = true;

    const klass = (CLASS_OF.find(([prefix]) => op.startsWith(prefix)) || [null, 'Other'])[1];
    byClass.set(klass, (byClass.get(klass) || 0) + 1);
  }

  const registers = { maxVector: -1, maxScalar: -1 };
  REGISTER_RE.lastIndex = 0;
  let m;
  while ((m = REGISTER_RE.exec(text)) !== null) {
    const file = m[1] || m[4];
    // The high end of a range, or the single index.
    const index = m[1] ? Math.max(Number(m[2]), Number(m[3])) : Number(m[5]);
    if (file === 'v') registers.maxVector = Math.max(registers.maxVector, index);
    else registers.maxScalar = Math.max(registers.maxScalar, index);
  }

  const mix = [...byClass.entries()]
    .map(([category, count]) => ({
      category, count, share: instructions ? (100 * count) / instructions : 0
    }))
    .sort((a, b) => b.count - a.count);

  return { instructions, mix, registers, waits, delays, usesLds, usesScratch };
}

// --------------------------------------------------------------------------- the rows

const target = {
  id: 'amd',
  vendor: 'AMD',
  isa: 'RDNA ISA',
  dialectId: 'amd-rdna-isa',

  /** `gfx1201` is already the name; there is no SM-style prefix to add. */
  archLabel: arch => String(arch || '').toLowerCase(),

  resolveTool: () => { throw new Error('resolved through compileview.resolveTools'); },

  /**
   * The listing text, which RGA already produced.
   *
   * There is nothing to disassemble: `rgaCompile` captured the ISA when it ran, so this hands
   * it over. That asymmetry with the NVIDIA row - which writes bytes to a file and shells out
   * to nvdisasm - is exactly what `emit()` exists to absorb, and it is why the text is the
   * obligation and the bytes are optional.
   */
  async emit(entry, ctx) {
    void ctx;
    if (!entry.evidence.isa) {
      throw new Error(
        `${entry.name} carries no ISA text. On this road the compile produces the listing, ` +
        'so an entry without one means rga wrote nothing for that stage.');
    }
    return {
      text: entry.evidence.isa,
      // No per-instruction column: RDNA states dependency resolution as instructions, which
      // are already in the text below.
      annotation: null,
      tool: ctx.tool || 'rga',
      toolVersion: ctx.toolVersion || '',
      command: ctx.command || ''
    };
  },

  /**
   * The architecture to build for.
   *
   * Unlike the NVIDIA roads this never probes the hardware, because it never compiles ON the
   * hardware: RGA cross-compiles for any listed target from any machine. The setting is
   * therefore the whole answer, and the default is stated rather than detected.
   */
  async resolveArch() {
    return { arch: null, from: 'the compile.gfx setting' };
  },

  async available() { return false; },

  roadFor(stage) {
    return require('./compile').roadOf(stage, this.id);
  },

  refusalFor(stage) {
    const compile = require('./compile');
    // Raytracing used to be refused here, at length, because RGA's Vulkan modes have no
    // raytracing stage options at all - `--rgen` is rejected with "Option 'rgen' does not
    // exist", and neither the offline nor the live-driver mode accepts --miss, --chit,
    // --ahit, --sect or --call. That was a gap in one command line rather than a property of
    // the hardware, and the refusal said so by naming `-s dxr` as the mode that does exist.
    // It is now the road those stages take, so the refusal is gone rather than reworded: a
    // stage with a road returns null here on the line below, like any other.
    if (compile.roadOf(stage, this.id)) return null;
    return compile.stageRefusal(this.id);
  },

  // RDNA has no per-instruction scheduling field and no fixed instruction width. Both are the
  // same `null`, and `isa.strideFor` is what turns the second into a refusal to step.
  controlColumn: null,

  provenance: PROVENANCE,
  registerSource: REGISTER_SOURCE,
  bannerTail,

  /**
   * What this road can honestly count, which is less than the NVIDIA one and says so.
   *
   * The instruction count comes from the parser rather than from a line count, because a
   * listing holds labels and blank lines too. The rest comes from RGA's statistics CSV - a
   * second account of the shader, independent of the code, which is the same arrangement the
   * cache road has and what makes a cross-check possible at all.
   *
   * Deliberately absent until measured rather than guessed: the instruction MIX, because
   * grouping RDNA mnemonics into functional units needs a table nobody here has verified;
   * the stall total, because the only RDNA cycle figures available are a static table
   * containing "Varies"; and the wait/arm census, which needs the dependency model.
   */
  statsProfile: {
    analyze(text, object) {
      return {
        ...measureRdna(String(text)),
        declared: (object && object.statistics) || null,
        localSize: (object && object.localSize) || null
      };
    },

    summaryLines(measured, metadata) {
      const pad = label => `// ${label.padEnd(FIELD_WIDTH)}: `;
      const blank = `// ${' '.repeat(FIELD_WIDTH)}  `;
      const d = measured.declared || {};
      const lines = [pad('instructions') + `${measured.instructions.toLocaleString()}`];

      // By ENCODING CLASS, which is what the mnemonic prefix names and is documented as such -
      // not by functional unit, which would need a per-opcode table nobody here has verified.
      // The label says which, because the two are easy to mistake for one another.
      if (measured.mix.length) {
        lines.push(pad('mix') + measured.mix.slice(0, 5)
          .map(m => `${m.category} ${m.share < 10 ? m.share.toFixed(1) : Math.round(m.share)}%`)
          .join('   '));
        lines.push(blank + 'by encoding class, from the mnemonic prefix');
      }

      if (d.ISA_SIZE !== undefined) lines.push(pad('code size') + `${d.ISA_SIZE} bytes`);

      // RGA's count and the code's highest index are two independent statements. Both are
      // printed, because the gap between them is meaningful: an allocation sits at or above
      // what the code touches, and quietly printing one as the other would merge two claims.
      if (d.USED_VGPRs !== undefined) {
        lines.push(pad('vector regs') + `${d.USED_VGPRs} of ${d.AVAILABLE_VGPRs} VGPR ` +
          'allocated by RGA' +
          (measured.registers.maxVector >= 0
            ? `; the code reaches v${measured.registers.maxVector}` : ''));
      }
      if (d.USED_SGPRs !== undefined) {
        lines.push(pad('scalar regs') + `${d.USED_SGPRs} of ${d.AVAILABLE_SGPRs} SGPR ` +
          'allocated by RGA' +
          (measured.registers.maxScalar >= 0
            ? `; the code reaches s${measured.registers.maxScalar}` : ''));
      }

      if (d.USED_LDS_BYTES !== undefined) {
        lines.push(pad('LDS') + `${d.USED_LDS_BYTES} of ${d.AVAILABLE_LDS_BYTES} bytes`);
      }
      // Scratch is private memory, and its presence means the shader spilled or indexed a
      // local array - which is why it is printed even when zero, the way local mem is on the
      // NVIDIA road.
      if (d.SCRATCH_MEM !== undefined) {
        lines.push(pad('scratch') + `${d.SCRATCH_MEM} bytes` +
          (d.SCRATCH_MEM ? ' - private memory, so something spilled or was indexed' : ''));
      }

      const spills = (d.VGPR_SPILLS || 0) + (d.SGPR_SPILLS || 0);
      lines.push(pad('spills') + (spills
        ? `${d.VGPR_SPILLS || 0} VGPR, ${d.SGPR_SPILLS || 0} SGPR`
        : 'none'));

      // Declared by the shader, and labelled so. RGA's own THREADS_PER_WORKGROUP and
      // CL_WORKGROUP_* columns read 0 for every Vulkan shader measured, including a compute
      // shader with a declared size, so they are dropped rather than printed - see
      // `rga.ALWAYS_ZERO`. There is deliberately NO wave size and NO occupancy figure: RGA
      // reports neither, and deriving occupancy would need a per-target allocation-granularity
      // table this has not measured.
      if (measured.localSize) {
        lines.push(pad('workgroup') +
          `${measured.localSize.join(' x ')} - declared by the shader, not reported by RGA`);
      }

      if (measured.waits) {
        lines.push(pad('waits') + `${measured.waits} s_wait_* / s_waitcnt` +
          (measured.delays ? `, ${measured.delays} s_delay_alu` : ''));
        lines.push(blank + 'RDNA states dependency resolution as instructions, so these are ' +
          'counted rather than decoded from a column.');
      }

      void metadata;
      return lines;
    },

    /**
     * The two accounts compared.
     *
     * RGA states the register counts and the code states which registers it touches, arrived
     * at independently - so a disagreement means one of them is being read wrong, which is
     * worth more than either number alone. Exactly the argument `stats.crossCheck` makes for
     * the cache road, and the reason `declared` and `evidence` are kept apart.
     *
     * The rule is `used > allocated`, not `used != allocated`. An allocation legitimately sits
     * ABOVE the highest register touched - alignment, a reserved pair, a granularity the
     * compiler rounds to - so equality is not expected and demanding it would cry wolf on
     * ordinary output. Exceeding it is the impossible direction.
     */
    crossCheck(measured, metadata) {
      const notes = [];
      const d = measured.declared;
      if (!d) return notes;

      const r = measured.registers;
      if (d.USED_VGPRs !== undefined && r.maxVector >= 0 && r.maxVector + 1 > d.USED_VGPRs) {
        notes.push(`RGA reports ${d.USED_VGPRs} VGPRs but the code reaches v${r.maxVector} - ` +
          'one of the two is being read wrong');
      }
      if (d.USED_SGPRs !== undefined && r.maxScalar >= 0 && r.maxScalar + 1 > d.USED_SGPRs) {
        notes.push(`RGA reports ${d.USED_SGPRs} SGPRs but the code reaches s${r.maxScalar} - ` +
          'one of the two is being read wrong');
      }
      if (d.USED_LDS_BYTES === 0 && measured.usesLds) {
        notes.push('the code reads or writes LDS but RGA reports none used');
      }
      if ((d.VGPR_SPILLS || d.SGPR_SPILLS) && !measured.usesScratch) {
        notes.push('RGA reports spills but the code contains no scratch access');
      }
      void metadata;
      return notes;
    }
  },

  /**
   * What this target does not have, in words, once.
   *
   * Read by the doctor and by the banner. Each names the reason rather than the feature, so a
   * reader learns whether it is coming, absent by construction, or absent because a third
   * party does not offer it.
   */
  absences: {
    controlColumn: 'RDNA states dependency resolution as separate instructions rather than ' +
      'as a field in every instruction, so there is no column to decode.',
    correlation: 'RGA offers no source correlation in any Vulkan mode - there is no ' +
      'line-info flag and no OpLine pass-through.',
    cache: 'This extension has no reader for an AMD driver\'s shader cache, so AMD listings ' +
      'come from compiling rather than from browsing.'
  },

  describeEntry(entry) {
    const declared = entry.declared || {};
    const bits = [];
    if (entry.evidence && entry.evidence.instructions) {
      bits.push(`${entry.evidence.instructions} instructions`);
    }
    if (declared.registers) bits.push(`${declared.registers} VGPR`);
    if (entry.hardwareStage) bits.push(entry.hardwareStage);
    return bits.join(', ') || 'ISA listing';
  },

  /** The RGA modes, so callers name them through the target rather than by literal. */
  modes: { offline: rga.MODE_OFFLINE, driver: rga.MODE_DRIVER, dxr: rga.MODE_DXR, binary: rga.MODE_BINARY }
};

const dialect = {
  id: 'amd-rdna-isa',
  listingExt: '.rdnaisa',
  archFallback: 'gfx',
  parseLine: parseRdna.parseLine,
  detectArchitecture: parseRdna.detectArchitecture,
  tables: {
    lookupOpcode: dataRdna.lookupOpcode,
    lookupModifier: dataRdna.lookupModifier,
    lookupSpecialRegister: dataRdna.lookupSpecialRegister,
    registerClass: dataRdna.registerClass,
    ARCH_LABELS: dataRdna.ARCH_LABELS
  },
  /** How well grounded an entry is, which reads differently here - see data_rdna.js. */
  sourceLabels: dataRdna.sourceLabels,
  docUrl: 'https://gpuopen.com/amd-isa-documentation/',
  /**
   * How this ISA expresses "wait for that", and how to follow it.
   *
   * `s_wait_loadcnt` drains what a `buffer_load` put in flight, which is the same relation
   * NVIDIA states in a scoreboard field - so `highlight.js` and its F12 provider work on an
   * RDNA listing with no change above this cell. The counters are in-order queues rather than
   * anonymous counters, which makes the answer MORE precise than the SASS side's: a partial
   * wait can name which operation it was waiting for.
   *
   * The two places it cannot be exact are reported rather than smoothed over - a shared
   * `lgkmcnt` on gfx10/11, and `flat_` addressing that resolves to a queue at run time. See
   * `depend_rdna.js`, and `test_rdna_depend.js` for what was measured versus documented.
   */
  dependency: {
    analyzeAt: dependRdna.analyzeAt,
    armsFor: dependRdna.producersFor,
    waitFor: dependRdna.waitFor
  },
  explain: null
};

dialect.claimsFile = file =>
  path.extname(String(file || '')).toLowerCase() === dialect.listingExt;

module.exports = { target, dialect, FIELD_WIDTH };
