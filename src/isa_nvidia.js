'use strict';

/**
 * Everything that is true of NVIDIA specifically, in one place.
 *
 * This module holds no new logic. Every function in it was moved here from `output.js`,
 * `pipeline.js`, `compileview.js` or `data.js` with its body unchanged, so that the modules it
 * came from can stop knowing which vendor they are describing. If a body here differs from the
 * one it replaced, that is a bug rather than an improvement.
 *
 * Two exports, because two different questions get asked at two different times:
 *
 *   target    PRODUCING. How source becomes a listing: which tool, which architecture, which
 *             road a stage takes, what the banner may claim, what it must decline to claim.
 *             Reached by target id.
 *   dialect   READING. What a line of the resulting text means. Reached by VS Code language
 *             id, because a listing opened from disk months later has no compile behind it -
 *             its language id is the only thing that survived.
 *
 * A cell that is `null` is a statement, not an omission: it says this target has no such
 * thing, and the banner and the doctor read that `null` to decide whether to say anything at
 * all. Where the absence is worth explaining to a reader, the explanation lives in `absences`,
 * once, rather than being spelled out at each place that notices it.
 */

const path = require('path');

const ctrl = require('./ctrl');
const data = require('./data');
const pipeline = require('./pipeline');
const { parseLine } = require('./parse');

/** Banner label column. Shared with `output.js`, which owns the layout. */
const FIELD_WIDTH = 14;

/** A continuation line: no label, no colon, so it reads as belonging to the line above. */
const cont = text => `// ${' '.repeat(FIELD_WIDTH)}  ${text}`;

// --------------------------------------------------------------------------- provenance

/**
 * Where a listing's code came from, and how that origin describes itself.
 *
 * Moved from `output.js`, which introduced these rows with the observation that a third input
 * should be "a new entry in these two tables and no edit anywhere else". That held, and the
 * only thing that changed is that the tables now belong to the target rather than to the
 * banner - because a second vendor's cache road would print `frame at offset N`, which is a
 * fact about an NVuc container and false of anything else.
 */
const PROVENANCE = {
  cache(result, sweepResult, field) {
    const { object } = result;
    return [
      field('source') + `${object.source}`,
      cont(`frame at offset ${object.offset}` +
        (sweepResult
          ? ` (${sweepResult.label}${sweepResult.scanned ? ', found by magic scan' : ''})`
          : ''))
    ];
  },

  compiled(result, sweepResult, field) {
    return [...toolchainLines(result, field, 'via'), ...flagLines(result, field)];
  },

  /**
   * A graphics shader the local driver compiled, for one pipeline this extension described.
   *
   * The extra lines are not decoration. A vertex or fragment shader has no SASS of its own -
   * only SASS for a pipeline - and two parts of that pipeline are things the source file never
   * said and this tool had to decide. Both were measured to change the generated code without
   * changing anything a reader could see.
   */
  driver(result, sweepResult, field) {
    const { compile } = result;
    const lines = toolchainLines(result, field, 'with');
    if (compile.device) {
      // Which GPU, because this road needs the hardware present and the answer is that
      // device's - unlike ptxas, which cross-compiles for any architecture from anywhere.
      lines.push(field('driver') + `${compile.device}`);
    }
    if (compile.pipeline) {
      lines.push(field('pipeline') + `${compile.pipeline}`);
    }
    return [...lines, ...flagLines(result, field)];
  }
};

/**
 * What "registers" means for each origin.
 *
 * The cache states a count that sits a little above what the code touches; ptxas states the
 * number it actually allocated. Printing one as the other would merge two different claims
 * under one label.
 */
const REGISTER_SOURCE = {
  cache: 'declared',
  compiled: 'allocated by ptxas',
  // Same field, same container, same meaning as the cache path - because it IS the cache
  // path's field. ptxas never runs on this road, so "allocated by ptxas" would name a tool
  // that was not involved.
  driver: 'declared'
};

/** The source and the toolchain that ran over it - shared by both compiled origins. */
function toolchainLines(result, field, joiner) {
  const { object, compile } = result;
  const lines = [field('source') + `${object.source}`];
  for (const note of compile.sources.slice(1)) lines.push(cont(`${joiner} ${note}`));
  lines.push(field('compiled') + `${compile.steps.map(s => s.tool).join(' -> ')}`);
  for (const step of compile.steps) lines.push(cont(step.command));
  return lines;
}

/** Which flags were in force, and where each came from. Last, on both roads. */
function flagLines(result, field) {
  const { compile } = result;
  const lines = [];
  if (compile.directive) lines.push(field('flags') + `${compile.directive} (from the file)`);
  if (compile.configuredFlags) lines.push(cont(`${compile.configuredFlags} (from settings)`));
  return lines;
}

// --------------------------------------------------------------------------- banner tail

/**
 * Everything from `microcode` down to the control-column note.
 *
 * One cell rather than four, deliberately. This is a contiguous block that is entirely about
 * how *this* target's code was identified and disassembled, and splitting it into a cell per
 * line would be more indirection than the table row it replaces, not less.
 *
 * The literal `EF_CUDA_<arch>` token is load-bearing: it is what this extension's own hovers
 * read to decide which instruction set to describe. Keep the spelling.
 */
function bannerTail(result, field) {
  const { object, arch, nvdisasm, nvdisasmVersion, command, annotation } = result;
  const pkg = require('../package.json');

  const lines = [
    field('microcode') + `${object.codeBytes} bytes, sha1 ${object.sha1}`,
    field('arch') + `${arch} (.headerflags @"EF_CUDA_64BIT_ADDRESS EF_CUDA_${arch}")`,
    field('nvdisasm') + `${nvdisasm}`,
    cont(nvdisasmVersion),
    cont(command),
    field('tool') + `${pkg.displayName} ${pkg.version}`
  ];

  if (!annotation) return lines;

  lines.push(
    '//',
    '// Control codes decoded from bits [105,126) of each instruction and printed as',
    '//   [B<wait 0-5>:R<read>:W<write>:<yield>:S<stall>]',
    '// Scoreboards are positional and numbered 0-5 exactly as encoded - this is NOT the',
    '// hex mask over barriers 1-6 that Maxwell-era listings use. Hover any field for detail.');

  if (annotation.suspect) {
    lines.push(
      '//',
      `// WARNING: on ${annotation.mismatchTotal} of ${annotation.annotated} instructions the`,
      '// decoded reuse flags disagree with the .reuse flags nvdisasm printed from the same',
      `// instruction word (${annotation.missing} where nvdisasm found a flag this did not).`,
      '// The control-field layout may differ on this architecture, so the columns below may',
      '// be wrong. Everything else in this listing is nvdisasm\'s own output and is unaffected.');
    for (const m of annotation.mismatches.slice(0, 5)) {
      lines.push(`//   /*${m.address}*/ decoded ${m.decoded} reuse bit(s), printed ${m.printed}`);
    }
  } else if (annotation.mismatchTotal) {
    // Benign, and common enough on graphics shaders to be worth explaining rather than
    // hiding: a reuse bit whose operand-collector slot holds no plain register has nothing
    // for nvdisasm to attach a .reuse suffix to.
    lines.push(
      '//',
      `// Note: ${annotation.mismatchTotal} of ${annotation.annotated} instructions carry a reuse`,
      '// bit that nvdisasm did not print - normal where the reused slot is not a plain',
      '// register (IPA reading attribute space, TEX). The scheduling columns are unaffected.');
  }
  return lines;
}

// --------------------------------------------------------------------------- the rows

/**
 * The producing side.
 *
 * `roadFor` returns what `compile.lineageOf` returns, unchanged - it is renamed here because
 * "lineage" describes NVIDIA's two roads specifically, and the cell has to mean "which of this
 * target's roads" for any target. `compile.js` keeps exporting `lineageOf` so nothing that
 * reads it has to move at the same time as this lands.
 */
const target = {
  id: 'nvidia',
  vendor: 'NVIDIA',
  isa: 'SASS',
  dialectId: 'nvidia-sass',

  /** `86` or `sm_86` or `SM86` all mean SM86; the listing filename is built from this. */
  archLabel: arch => `SM${String(arch).replace(/^sm_?/i, '').replace(/^SM/i, '')}`,

  resolveTool: () => pipeline.resolveNvdisasm(),
  resolveArch: options => pipeline.resolveArch(options),

  async available() {
    try {
      await pipeline.resolveNvdisasm();
      return true;
    } catch (e) {
      return false;
    }
  },

  // The control column IS this target's per-instruction annotation. A target with none sets
  // this to null, and `output.banner` then prints no legend rather than an empty one.
  controlColumn: { annotate: ctrl.annotate, INSTRUCTION_BYTES: ctrl.INSTRUCTION_BYTES },

  provenance: PROVENANCE,
  registerSource: REGISTER_SOURCE,
  bannerTail,

  /**
   * Nothing NVIDIA cannot do, so far.
   *
   * The cell exists rather than being omitted because its emptiness is the claim: every
   * feature this extension has, this target has. A target that fills it in is saying which
   * ones it does not, in words, once.
   */
  absences: {},

  /**
   * The quick-pick line for one compiled entry point.
   *
   * `compileview.chooseEntry` used to read `instructions`/`codeBytes`/`registers` straight off
   * the entry. It still does, through here - but through here, so a target whose entries carry
   * different figures describes them itself instead of rendering "undefined instructions".
   */
  describeEntry(entry) {
    return `${entry.instructions} instructions, ${entry.codeBytes} bytes` +
      (entry.registers ? `, ${entry.registers} registers` : '');
  }
};

/**
 * The reading side.
 *
 * `parseLine` is the whole of it, and the vocabulary it returns - the `kind` names on each
 * token - is what makes `semantic.js` and `hover.js` vendor-blind without either of them
 * knowing this file exists. A second dialect that returns a different vocabulary would have to
 * be special-cased in both, which is exactly what having a dialect row is meant to prevent.
 */
const dialect = {
  id: 'nvidia-sass',
  listingExt: '.nvsass',
  /** `output.sanitize(arch, fallback)` - what a listing is called when the arch is unusable. */
  archFallback: 'sm',
  parseLine,
  detectArchitecture: data.detectArchitecture,
  tables: {
    lookupOpcode: data.lookupOpcode,
    lookupModifier: data.lookupModifier,
    lookupSpecialRegister: data.lookupSpecialRegister,
    registerClass: data.registerClass,
    ARCH_LABELS: data.ARCH_LABELS
  }
};

/** Does this path look like one of this dialect's listings? */
dialect.claimsFile = file =>
  path.extname(String(file || '')).toLowerCase() === dialect.listingExt;

module.exports = { target, dialect, FIELD_WIDTH };
