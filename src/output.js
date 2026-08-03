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

function banner(result, sweepResult) {
  const { object, arch, nvdisasm, nvdisasmVersion, command, annotation } = result;
  const pkg = require('../package.json');
  const lines = [
    `// Disassembled by ${pkg.displayName} ${pkg.version}`,
    `// source     : ${object.source}`,
    `//              frame at offset ${object.offset}` +
      (sweepResult ? ` (${sweepResult.label}${sweepResult.scanned ? ', found by magic scan' : ''})` : ''),
    `// entry      : ${object.name || '(unnamed)'}`,
    `// microcode  : ${object.codeBytes} bytes, ${object.instructions} instructions, ` +
      `sha1 ${object.sha1}`,
    // The literal EF_CUDA_<arch> token is what this extension's own hovers read to decide
    // which architecture's instruction set to describe. Keep the spelling.
    `// arch       : ${arch} (.headerflags @"EF_CUDA_64BIT_ADDRESS EF_CUDA_${arch}")`,
    `// nvdisasm   : ${nvdisasm}`,
    `//              ${nvdisasmVersion}`,
    `//              ${command}`
  ];

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

  for (const warning of object.warnings || []) lines.push(`// WARNING: ${warning}`);
  lines.push('');
  return lines.join('\n');
}

/**
 * Write a listing and show it.
 *
 * The language is set explicitly rather than left to the file extension: `.sass` and
 * `.nvsass` may be claimed by a user's own `files.associations`, and a listing this
 * extension just generated should always open as the language it generated.
 */
async function openListing(context, result, sweepResult) {
  const dir = listingDir(context);
  await fs.promises.mkdir(dir, { recursive: true });

  const file = path.join(dir, listingName(result.object, result.arch));
  // Collisions are content-identical by construction - the sha1 is in the name.
  await fs.promises.writeFile(file, banner(result, sweepResult) + result.text, 'utf8');

  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
  if (doc.languageId !== LANGUAGE_ID) {
    await vscode.languages.setTextDocumentLanguage(doc, LANGUAGE_ID);
  }
  await vscode.window.showTextDocument(doc, { preview: false });
  return file;
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
  listingDir,
  scratchDir,
  banner,
  openListing,
  pruneListings,
  storageStats,
  clearListings
};
