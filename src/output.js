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

const isa = require('./isa');
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

/**
 * `<entry>.<sha1[0:8]>.<arch><ext>` - the browse road's name for a listing.
 *
 * The dialect supplies the extension and the arch fallback, as it already does on the compile
 * road. Hardcoding them here meant the browse road could only ever write `.nvsass` and could
 * only fall back to `sm`, while the READ side - `listingIndex`, `pruneListings`, `showListing`
 * - had been generalised to accept every dialect. A second target's browsed listing would then
 * be written with the first target's extension and opened as the first target's language:
 * highlighted by the wrong grammar and hovered out of the wrong opcode table, which is exactly
 * what generalising the read side was meant to prevent.
 */
function listingName(object, arch, dialect = isa.DIALECTS[LANGUAGE_ID]) {
  return `${sanitize(object.name)}.${object.sha1.slice(0, 8)}.` +
    `${sanitize(arch, dialect.archFallback)}${dialect.listingExt}`;
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
 * Two kinds of input reach this file - a shader carved out of a driver cache, and a kernel
 * compiled from source - and they have nothing in common to say about provenance. A cache
 * object has a file and a byte offset; a compiled one has a source file and a toolchain, and
 * "frame at offset 0" would be a provenance line that reads as fact and is not. Rather than
 * growing an `if` per origin through the middle of the banner, each origin supplies its own
 * lines and `banner` stays origin-blind.
 *
 * Those rows now live on the TARGET rather than here, for the same reason they were rows in
 * the first place. `frame at offset N` is not merely a fact about a cache object, it is a fact
 * about an *NVuc* container, and a second vendor reaching this function would have printed it
 * anyway. The banner keeps the layout - the field column, the rules, the order - and the
 * target supplies what goes in it.
 */
const DEFAULT_ORIGIN = 'cache';

/**
 * The target a result describes.
 *
 * Results do not carry one yet, and the fallback is not a placeholder for that: a listing
 * being read back from disk has no compile behind it either, so there will always be a default
 * here. It is the registry's default rather than a literal so that this file names no vendor.
 */
function targetOf(result) {
  return (result && result.target) || isa.get(isa.DEFAULT_TARGET);
}

function originOf(object, target) {
  const rows = (target || isa.get(isa.DEFAULT_TARGET)).provenance;
  return object && rows[object.origin] ? object.origin : DEFAULT_ORIGIN;
}

/**
 * What the container states about a shader, as banner lines.
 *
 * These are the driver's own numbers, not anything derived from the disassembly - so they are
 * printed as declared. In particular the register count is never adjusted: it sits a couple
 * above the highest register the code touches, and quietly "correcting" for that would be
 * inventing precision the format does not offer.
 */
/**
 * @param {object} [target]  whose `registerSource` names what the count means.
 *   `banner` always passes the one it resolved; the default is here only so the exported
 *   signature keeps working for a two-argument caller. It used to resolve the registry default
 *   INTERNALLY, which meant one banner could be assembled from two targets - the provenance
 *   block and tail describing the result's target while this line described the default's, and
 *   `originOf` validating against the wrong table.
 */
function metadataLines(object, text, target = isa.get(isa.DEFAULT_TARGET)) {
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
    lines.push(field('registers') +
      `${meta.registers} ${target.registerSource[originOf(object, target)]}` +
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
  const { object, text } = result;
  const target = targetOf(result);

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
    ...metadataLines(object, text, target),
    ...(measured ? stats.summaryLines(measured, object.metadata) : [])
  ];

  const disagreements = measured ? stats.crossCheck(measured, object.metadata) : [];
  if (disagreements.length) {
    lines.push('//');
    lines.push('// The cache and the code disagree, so one of them is being read wrong:');
    for (const note of disagreements) lines.push(`//   - ${note}`);
  }

  lines.push(THIN_RULE);
  lines.push(...target.provenance[originOf(object, target)](result, sweepResult, field));

  // How this target's code was identified and disassembled, and what its per-instruction
  // column means. One call rather than a block, because every line of it names a tool, a
  // container field or an encoding that belongs to the target rather than to the layout.
  lines.push(...target.bannerTail(result, field));

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
function listingPathFor(context, object, arch, dialect) {
  return path.join(listingDir(context), listingName(object, arch, dialect));
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
    // Every target's extension, not this one's. All targets write into one directory, and a
    // single-extension filter here would mean one target's listings are counted as already
    // generated while another's are invisible - which reads as "not disassembled yet" forever.
    return new Set(names.filter(n => isa.isListingPath(n)));
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

  const file = path.join(dir, listingName(result.object, result.arch,
    isa.DIALECTS[targetOf(result).dialectId]));
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
  // Which language a listing opens as is decided by its extension, not by a constant: two
  // targets write into one directory, and the language id is what every provider dispatches
  // on. A listing opened as the wrong dialect is highlighted by the wrong grammar and hovered
  // out of the wrong opcode table, which looks like corrupt output rather than a mix-up.
  const dialect = isa.dialectForFile(file) || isa.DIALECTS[LANGUAGE_ID];
  if (doc.languageId !== dialect.id) {
    await vscode.languages.setTextDocumentLanguage(doc, dialect.id);
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
    // Same set the index uses. A listing this did not recognise would never be pruned, so the
    // retention setting would quietly stop applying to one target's output.
    if (!isa.isListingPath(name)) continue;
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
