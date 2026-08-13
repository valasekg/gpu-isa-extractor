'use strict';

/**
 * Everything that is true of AMD specifically: the second row in the registry.
 *
 * The counterpart of `isa_nvidia.js`, and deliberately shaped like it - a `target` for
 * producing and a `dialect` for reading. Where a cell is null, that is a statement about this
 * ISA rather than an unfinished edge, and `absences` says which in words so the banner can
 * print the reason once instead of every consumer inventing its own.
 *
 * ## What this road is
 *
 *     .slang --slangc--> .spv --rga--> RDNA ISA text
 *
 * One step shorter than either NVIDIA road, and it ends in TEXT rather than in bytes to
 * disassemble - which is the whole reason `isa_entry.emit()` exists.
 *
 * ## What it does not need, and the NVIDIA road does
 *
 * An AMD GPU. Neither RGA mode requires one: the offline mode is a static compiler, and the
 * live-driver mode falls back to the AMDVLK driver RGA ships with. Measured on a machine with
 * only an NVIDIA adapter, both produced output, and the two disagreed - 87 instructions
 * against 76 for one fragment shader - so the live road really did compile rather than
 * silently reusing the offline result.
 *
 * That inverts the NVIDIA graphics road's central constraint, where the local driver IS the
 * compiler. It is stated here rather than generalised from there.
 *
 * ## What is NOT yet claimed
 *
 * Which of the two roads is accurate. RGA warns that a live compile with no pipeline state may
 * be inaccurate, and the 87-vs-76 gap is exactly that warning made visible: the first
 * divergence is `s_mov_b64 s[0:1], exec` against `s[2:3]`, user-data SGPRs shifting because
 * the descriptor layout differs. Until a reflected `.gpso` is fed to the live road and the
 * result compared, NEITHER number is the one a real pipeline gets, and the banner says so
 * rather than picking one and sounding certain.
 */

const path = require('path');

const parseRdna = require('./parse_rdna');
const rga = require('./rga');

/** Banner label column. Shared with `output.js`, which owns the layout. */
const FIELD_WIDTH = 14;

const cont = text => `// ${' '.repeat(FIELD_WIDTH)}  ${text}`;

// --------------------------------------------------------------------------- provenance

/**
 * Where an AMD listing's code came from.
 *
 * One row, because there is one road in: compiled from source through RGA. There is no cache
 * row - this extension has no reader for an AMD driver's shader cache - and no `driver` row
 * distinct from `compiled`, because RGA's live-driver mode is still a compile this tool asked
 * for rather than a by-product it went looking for. That distinction is what the NVIDIA
 * `driver` row exists to record, and inventing one here would be describing a road that does
 * not exist.
 */
const PROVENANCE = {
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
const REGISTER_SOURCE = { compiled: 'reported by RGA' };

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
    if (compile.roadOf(stage, this.id)) return null;
    if (RAYTRACING.has(stage)) {
      return `RGA's Vulkan modes have no raytracing stage options at all - \`--rgen\` is ` +
        'rejected with "Option \'rgen\' does not exist", and neither the offline nor the ' +
        'live-driver mode accepts --miss, --chit, --ahit, --sect or --call. This is a gap in ' +
        'one tool\'s command line rather than a property of the hardware. RGA does have a ' +
        '`-s dxr` mode, which takes DXIL rather than SPIR-V.';
    }
    return compile.stageRefusal(this.id);
  },

  // RDNA has no per-instruction scheduling field and no fixed instruction width. Both are the
  // same `null`, and `isa.strideFor` is what turns the second into a refusal to step.
  controlColumn: null,

  provenance: PROVENANCE,
  registerSource: REGISTER_SOURCE,
  bannerTail,

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
  modes: { offline: rga.MODE_OFFLINE, driver: rga.MODE_DRIVER }
};

/** The six stages RGA's Vulkan modes cannot reach, named so the refusal can be specific. */
const RAYTRACING = new Set([
  'raygeneration', 'miss', 'closesthit', 'anyhit', 'intersection', 'callable'
]);

const dialect = {
  id: 'amd-rdna-isa',
  listingExt: '.rdnaisa',
  archFallback: 'gfx',
  parseLine: parseRdna.parseLine,
  detectArchitecture: parseRdna.detectArchitecture,
  tables: {},
  /**
   * Null, and the null is the point.
   *
   * RDNA does express the arm/wait relation this would follow - `s_wait_loadcnt` drains what a
   * `buffer_load` armed - but reading it needs a forward FIFO pass that does not exist yet.
   * Until it does, `highlight.js` stands down rather than running NVIDIA's scoreboard walker
   * over a listing that has no scoreboards, which would light up plausible and wrong.
   */
  dependency: null,
  explain: null
};

dialect.claimsFile = file =>
  path.extname(String(file || '')).toLowerCase() === dialect.listingExt;

module.exports = { target, dialect, RAYTRACING, FIELD_WIDTH };
