'use strict';

/**
 * Where generated listings go, what they are called, and the provenance they carry.
 *
 * A listing is a derived artefact that outlives the command that made it - it gets saved,
 * mailed, pasted into an issue. Once it has moved, the only thing that can say which shader
 * it came from is the file itself, so every listing opens with a banner naming its source
 * byte-for-byte. The banner is also load-bearing for the extension's own hovers: the
 * `EF_CUDA_SM86` token is what the architecture auto-detection reads.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const vscode = require('vscode');

const nvcache = require('./nvcache');
const stats = require('./stats');

/** Banner label column, shared by every section so the fields line up. */
const FIELD_WIDTH = 14;

const LISTING_EXT = '.nvsass';
const LANGUAGE_ID = 'nvidia-sass';

/** Windows reserves these as device names regardless of extension. */
const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;

/**
 * Turn an entry-point name into a filename component.
 *
 * Entry names come out of a binary and are only nominally ASCII, so this is a whitelist
 * rather than a blacklist of the characters Windows rejects.
 */
function sanitize(name, fallback = 'object') {
  const cleaned = String(name || '')
    .replace(/[^\w.@$+-]+/g, '_')
    .replace(/^[_.]+|[_.]+$/g, '')
    .slice(0, 80);
  if (!cleaned || RESERVED.test(cleaned)) return fallback;
  return cleaned;
}

function listingName(object, arch) {
  return `${sanitize(object.name)}.${object.sha1.slice(0, 8)}.${sanitize(arch, 'sm')}${LISTING_EXT}`;
}

/**
 * The directory listings are written to.
 *
 * globalStorage by default: it survives restarts, is per-extension, and the retention sweep
 * can prune it without touching anything the user put there.
 */
function listingDir(context) {
  const where = vscode.workspace.getConfiguration('nvIsaExtractor').get('output.location');
  if (where === 'temp') return path.join(os.tmpdir(), 'nv-isa-extractor');
  return path.join(context.globalStorageUri.fsPath, 'listings');
}

function scratchDir(context) {
  return path.join(context.globalStorageUri.fsPath, 'scratch');
}

/**
 * Where a listing's code came from, and how that origin describes itself.
 *
 * Two kinds of input now reach this file - a shader carved out of a driver cache, and a
 * kernel compiled from source - and they have nothing in common to say about provenance. A
 * cache object has a file and a byte offset; a compiled one has a source file and a
 * toolchain, and "frame at offset 0" would be a provenance line that reads as fact and is
 * not. Rather than growing an `if` per origin through the middle of the banner, each origin
 * supplies its own lines and `banner` stays origin-blind. A third input - the `.ptx` and
 * `.cubin` entry points `compile.js` already accepts, or a driver round-trip - is a new entry
 * in these two tables and no edit anywhere else.
 */
const DEFAULT_ORIGIN = 'cache';

function originOf(object) {
  return object && PROVENANCE[object.origin] ? object.origin : DEFAULT_ORIGIN;
}

/**
 * What "registers" means for each origin.
 *
 * The cache states a count that sits a little above what the code touches; ptxas states the
 * number it actually allocated. Printing one as the other would merge two different claims
 * under one label, which is exactly what the register-margin note warns against.
 */
const REGISTER_SOURCE = {
  cache: 'declared',
  compiled: 'allocated by ptxas',
  // Same field, same container, same meaning as the cache path - because it IS the cache
  // path's field. ptxas never runs on this road, so "allocated by ptxas" would name a tool
  // that was not involved.
  driver: 'declared'
};

const PROVENANCE = {
  cache(result, sweepResult, field) {
    const { object } = result;
    return [
      field('source') + `${object.source}`,
      `// ${' '.repeat(FIELD_WIDTH)}  frame at offset ${object.offset}` +
        (sweepResult
          ? ` (${sweepResult.label}${sweepResult.scanned ? ', found by magic scan' : ''})`
          : '')
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
   * changing anything a reader could see: substituting UNIFORM_BUFFER_DYNAMIC for
   * UNIFORM_BUFFER took a shader from 48 instructions to 40, and adding four bindings it never
   * touches changed the code at the same instruction count. So the layout and the producer are
   * stated on the face of the listing. A listing that did not say which pipeline it describes
   * would be claiming more than it knows.
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
 * The source and the toolchain that ran over it - shared by both compiled origins.
 *
 * `joiner` differs because the extra sources do: the CUDA road records the generated `.cu` a
 * compile went *via*, the driver road the companion shaders it was compiled *with*.
 */
function toolchainLines(result, field, joiner) {
  const { object, compile } = result;
  const lines = [field('source') + `${object.source}`];
  for (const note of compile.sources.slice(1)) {
    lines.push(`// ${' '.repeat(FIELD_WIDTH)}  ${joiner} ${note}`);
  }
  lines.push(field('compiled') + `${compile.steps.map(s => s.tool).join(' -> ')}`);
  for (const step of compile.steps) {
    lines.push(`// ${' '.repeat(FIELD_WIDTH)}  ${step.command}`);
  }
  return lines;
}

/** Which flags were in force, and where each came from. Last, on both roads. */
function flagLines(result, field) {
  const { compile } = result;
  const lines = [];
  if (compile.directive) {
    lines.push(field('flags') + `${compile.directive} (from the file)`);
  }
  if (compile.configuredFlags) {
    lines.push(`// ${' '.repeat(FIELD_WIDTH)}  ${compile.configuredFlags} (from settings)`);
  }
  return lines;
}

/**
 * What the container states about a shader, as banner lines.
 *
 * These are the driver's own numbers, not anything derived from the disassembly - so they are
 * printed as declared. In particular the register count is never adjusted: it sits a couple
 * above the highest register the code touches, and quietly "correcting" for that would be
 * inventing precision the format does not offer.
 */
function metadataLines(object, text) {
  const meta = object.metadata;
  if (!meta) return [];

  const usesLocal = text === undefined ? undefined : /\b(?:LDL|STL)\b/.test(text);
  const usesShared = text === undefined ? undefined : /\b(?:LDS|STS|ATOMS)\b/.test(text);

  const lines = [];
  const field = label => `// ${label.padEnd(FIELD_WIDTH)}: `;
  const stage = meta.stage
    ? `${meta.stage}${meta.stageCode !== null ? ` (code ${meta.stageCode})` : ''}`
    : (meta.stageCode !== null ? `unrecognised stage code ${meta.stageCode}` : 'not recorded');
  lines.push(field('stage') + stage);

  if (meta.registers !== null) {
    lines.push(field('registers') + `${meta.registers} ${REGISTER_SOURCE[originOf(object)]}` +
      (meta.registerCap !== null ? `, cap ${meta.registerCap}` : ''));
  }

  lines.push(field('local mem') + (meta.localBytes !== null ? `${meta.localBytes} bytes`
    : (usesLocal ? 'used, but this cache does not record the size' : '0 bytes')));
  lines.push(field('shared mem') + nvcache.sharedNote(meta.sharedBytes, usesShared));

  if (meta.killsPixels !== null) {
    lines.push(field('discards') + `${meta.killsPixels ? 'yes' : 'no'} (per the shader header)`);
  }

  // Disagreements between this and the code are reported once, by `stats.crossCheck`, which
  // sees the full instruction histogram rather than these two regexes.
  return lines;
}

const RULE = `//${'='.repeat(76)}`;
const THIN_RULE = `//${'-'.repeat(76)}`;

function banner(result, sweepResult) {
  const { object, arch, nvdisasm, nvdisasmVersion, command, annotation, text } = result;
  const pkg = require('../package.json');

  let measured = null;
  try {
    measured = text ? stats.analyze(text, object.microcode) : null;
  } catch (e) {
    measured = null;                       // a banner is never worth failing a disassembly for
  }

  // What the shader IS comes first; where it came from follows. The identifying line names
  // the entry point and its stage, so the top of the file answers "what am I looking at".
  const meta = object.metadata || {};
  const stageLabel = meta.stage
    ? `${meta.stage} shader` : (meta.stageCode !== null && meta.stageCode !== undefined
      ? `stage code ${meta.stageCode}` : 'shader');

  const field = label => `// ${label.padEnd(FIELD_WIDTH)}: `;
  const lines = [
    RULE,
    `// ${object.name || '(unnamed)'} - ${stageLabel}`,
    RULE,
    ...metadataLines(object, text),
    ...(measured ? stats.summaryLines(measured, object.metadata) : [])
  ];

  const disagreements = measured ? stats.crossCheck(measured, object.metadata) : [];
  if (disagreements.length) {
    lines.push('//');
    lines.push('// The cache and the code disagree, so one of them is being read wrong:');
    for (const note of disagreements) lines.push(`//   - ${note}`);
  }

  lines.push(THIN_RULE);
  lines.push(...PROVENANCE[originOf(object)](result, sweepResult, field));

  lines.push(
    field('microcode') + `${object.codeBytes} bytes, sha1 ${object.sha1}`,
    // The literal EF_CUDA_<arch> token is what this extension's own hovers read to decide
    // which architecture's instruction set to describe. Keep the spelling.
    field('arch') + `${arch} (.headerflags @"EF_CUDA_64BIT_ADDRESS EF_CUDA_${arch}")`,
    field('nvdisasm') + `${nvdisasm}`,
    `// ${' '.repeat(FIELD_WIDTH)}  ${nvdisasmVersion}`,
    `// ${' '.repeat(FIELD_WIDTH)}  ${command}`,
    field('tool') + `${pkg.displayName} ${pkg.version}`
  );

  if (annotation) {
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
  }

  // The source map is what makes correlation survive the listing being saved and reopened:
  // the markers in the body carry short labels, and this is where a label becomes a path.
  if (result.correlation && result.correlation.files.length) {
    lines.push(
      '//',
      '// Source correlation. Each `@<address>` below starts a run of instructions the',
      '// compiler attributes to that source line, holding until the next entry. Attribution',
      '// is not cost: the scheduler interleaves independent work, so one line\'s instructions',
      '// are scattered and one instruction can serve several lines. Provenance, not a bill.');
    for (const [file, label] of result.correlation.files) {
      lines.push(`// ${' '.repeat(FIELD_WIDTH)}  ${label} = ${file}`);
    }
    const c = result.correlation;
    lines.push(`// ${' '.repeat(FIELD_WIDTH)}  ${c.marked} run(s) over ${c.lines} source line(s)` +
      (c.unattributed ? `; ${c.unattributed} instruction(s) carry no source position` : ''));

    // The map itself, keyed by instruction address. Each entry starts a run that holds until
    // the next one, so this is one line per source construct rather than per instruction.
    // It lives here rather than interleaved with the code because a line of prose every few
    // instructions destroys the column alignment that makes a disassembly scannable.
    for (const entry of c.map || []) {
      lines.push(`// ${' '.repeat(FIELD_WIDTH)}  ${entry}`);
    }
  }

  for (const note of (result.compile && result.compile.notes) || []) {
    lines.push(`// NOTE: ${note}`);
  }
  for (const warning of object.warnings || []) lines.push(`// WARNING: ${warning}`);
  lines.push('');
  return lines.join('\n');
}

/** Where a listing for this object would live, whether or not it has been generated. */
function listingPathFor(context, object, arch) {
  return path.join(listingDir(context), listingName(object, arch));
}

/**
 * The names of every listing already on disk, in one readdir.
 *
 * `listingName` is deterministic, so this is enough to tell which objects have already been
 * disassembled - which drives the browser's "already done" marker, lets a walk open an
 * existing listing instead of re-running nvdisasm, and lets a batch skip finished work.
 */
async function listingIndex(context) {
  try {
    const names = await fs.promises.readdir(listingDir(context));
    return new Set(names.filter(n => n.endsWith(LISTING_EXT)));
  } catch (e) {
    return new Set();
  }
}

/**
 * Write a listing to disk and return its path, without opening it.
 *
 * Separate from `openListing` because a batch run writes hundreds of these and must not open
 * hundreds of editors. Note a batch cannot instead build one concatenated document: the
 * largest cache file's listings total well over a gigabyte, and a single JavaScript string
 * caps out at 536,870,888 characters in this runtime.
 */
async function writeListing(context, result, sourceRecord) {
  const dir = listingDir(context);
  await fs.promises.mkdir(dir, { recursive: true });

  const file = path.join(dir, listingName(result.object, result.arch));
  // Collisions are content-identical by construction - the sha1 is in the name. The compiled
  // path is the exception and does not come through here twice for the same bytes; see
  // `compileview.js`, which writes its own listings because their content depends on source
  // paths and line numbers that the microcode's sha1 does not cover.
  //
  // `result.correlated` is the body with source markers merged in. The banner is deliberately
  // built from `result.text`, which has none: `stats.analyze` scans the whole listing string
  // for register operands rather than each instruction line, so a marker naming a path like
  // `.../R8G8B8A8/pass.slang` would be counted as a use of R8 and the banner would report a
  // register the code never touches - and then `crossCheck` would accuse the cache of
  // disagreeing with the code over a directory name.
  const body = result.correlated || result.text;
  await fs.promises.writeFile(file, banner(result, sourceRecord) + body, 'utf8');
  return file;
}

/**
 * Write a listing and show it.
 *
 * The language is set explicitly rather than left to the file extension: `.sass` and
 * `.nvsass` may be claimed by a user's own `files.associations`, and a listing this
 * extension just generated should always open as the language it generated.
 *
 * `show` is forwarded to `showTextDocument`. Walking objects one after another passes
 * `preview: true` so the listing tab is replaced rather than accumulating one tab per
 * shader; an explicit "open" pins it with `preview: false`.
 */
async function openListing(context, result, sourceRecord, show = { preview: false }) {
  const file = await writeListing(context, result, sourceRecord);
  await showListing(file, show);
  return file;
}

/** Show a listing that is already on disk. */
async function showListing(file, show = { preview: false }) {
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
  if (doc.languageId !== LANGUAGE_ID) {
    await vscode.languages.setTextDocumentLanguage(doc, LANGUAGE_ID);
  }
  await vscode.window.showTextDocument(doc, show);
  return doc;
}

/**
 * Delete listings older than the retention setting.
 *
 * Files open in an editor are left alone: deleting one under the user turns a tidy-up into a
 * "file has been deleted" prompt on a document they are reading.
 */
async function pruneListings(context, log) {
  const days = Number(vscode.workspace.getConfiguration('nvIsaExtractor')
    .get('output.retentionDays'));
  if (!days || days <= 0) return 0;

  const dir = listingDir(context);
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const open = new Set(vscode.workspace.textDocuments
    .map(d => (d.uri.scheme === 'file' ? path.normalize(d.uri.fsPath).toLowerCase() : null))
    .filter(Boolean));

  let removed = 0;
  let names;
  try { names = await fs.promises.readdir(dir); } catch (e) { return 0; }

  for (const name of names) {
    if (!name.endsWith(LISTING_EXT)) continue;
    const file = path.join(dir, name);
    if (open.has(path.normalize(file).toLowerCase())) continue;
    try {
      const stat = await fs.promises.stat(file);
      if (stat.mtimeMs >= cutoff) continue;
      await fs.promises.unlink(file);
      removed++;
    } catch (e) { /* raced with something else; nothing to do */ }
  }
  if (removed && log) log(`pruned ${removed} listing(s) older than ${days} days from ${dir}`);
  return removed;
}

/** Size and count of what is currently stored, for the doctor report. */
async function storageStats(context) {
  const dir = listingDir(context);
  let names;
  try { names = await fs.promises.readdir(dir); } catch (e) { return { dir, files: 0, bytes: 0 }; }

  let bytes = 0;
  let files = 0;
  for (const name of names) {
    try {
      const stat = await fs.promises.stat(path.join(dir, name));
      if (stat.isFile()) { files++; bytes += stat.size; }
    } catch (e) { /* ignore */ }
  }
  return { dir, files, bytes };
}

async function clearListings(context) {
  const dir = listingDir(context);
  let names;
  try { names = await fs.promises.readdir(dir); } catch (e) { return 0; }

  let removed = 0;
  for (const name of names) {
    try { await fs.promises.unlink(path.join(dir, name)); removed++; } catch (e) { /* ignore */ }
  }
  return removed;
}

module.exports = {
  LISTING_EXT,
  LANGUAGE_ID,
  sanitize,
  listingName,
  listingPathFor,
  listingIndex,
  listingDir,
  scratchDir,
  banner,
  metadataLines,
  writeListing,
  openListing,
  showListing,
  pruneListings,
  storageStats,
  clearListings
};
