'use strict';

/**
 * Check everything the disassembly pipeline depends on, and say which part is missing.
 *
 * Most of what this extension needs is not its own: a CUDA toolkit it may not bundle, a GPU
 * to name an architecture, caches written by a driver on its own schedule. When any of that
 * is absent the command fails at the point of use, which is a bad place to learn about it.
 * This is the same information gathered up front, cheaply - no cache sweep, no decompression
 * beyond a self-test on a frame small enough to embed here.
 */

const fs = require('fs');
const path = require('path');
const vscode = require('vscode');

const pipeline = require('./pipeline');
const output = require('./output');
const zstd = require('./zstd');
const nvcache = require('./nvcache');

const OLD_EXTENSION = 'gvalasek.nvidia-sass-highlighter';

/**
 * A real 39-byte zstd frame whose payload is a known 491 bytes. Decoding it proves the
 * vendored decompressor survived packaging - the one dependency that ships inside the VSIX
 * and would otherwise fail for the first time on a user's cache file.
 */
const SELF_TEST_FRAME = 'KLUv/WDrAO0AAJhIRUxMTy1OVnVjLVBBWUxPQUQAAgBEHCU4SC1h';
const SELF_TEST_LENGTH = 491;
const SELF_TEST_HEAD = 'HELLO-NVuc-';

function human(bytes) {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} bytes`;
}

async function walkCache(root, extension) {
  const out = { root, exists: false, files: 0, bytes: 0, newest: null, orphans: 0 };
  if (!root) return out;
  try {
    if (!(await fs.promises.stat(root)).isDirectory()) return out;
  } catch (e) {
    return out;
  }
  out.exists = true;

  const walk = async dir => {
    let entries;
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { await walk(full); continue; }
      if (!e.name.toLowerCase().endsWith(extension)) continue;
      let stat;
      try { stat = await fs.promises.stat(full); } catch (e2) { continue; }
      out.files++;
      out.bytes += stat.size;
      if (!out.newest || stat.mtimeMs > out.newest.mtimeMs) {
        out.newest = { path: full, mtimeMs: stat.mtimeMs, size: stat.size };
      }
      if (extension === '.bin' && !fs.existsSync(full.slice(0, -4) + '.toc')) out.orphans++;
    }
  };
  await walk(root);
  return out;
}

/**
 * Gather the report. Each check yields {level, title, detail} where level is
 * 'ok' | 'warn' | 'fail'; the caller decides how to present them.
 */
async function diagnose(context) {
  const findings = [];
  const add = (level, title, ...detail) => findings.push({ level, title, detail: detail.filter(Boolean) });

  // 1. nvdisasm
  try {
    const { path: exe, from } = await pipeline.resolveNvdisasm();
    const version = await pipeline.nvdisasmVersion(exe);
    add('ok', 'nvdisasm found', exe, `via ${from}`, version);
  } catch (e) {
    add('fail', 'nvdisasm not found', e.message);
  }

  // 2. architecture
  try {
    const info = await pipeline.resolveArch();
    add(info.multiple ? 'warn' : 'ok',
      `architecture ${info.arch}`,
      `determined from ${info.from}`,
      info.multiple
        ? `this machine reports ${info.multiple.length} GPUs (${info.multiple.join(', ')}); the ` +
          'first is used. Set `nvIsaExtractor.arch` to choose another.'
        : null);
  } catch (e) {
    add('fail', 'GPU architecture unknown', e.message);
  }

  // 3. GLCache
  {
    const redirect = process.env.__GL_SHADER_DISK_CACHE_PATH;
    const root = redirect ||
      (process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'NVIDIA', 'GLCache'));
    const info = await walkCache(root, '.bin');
    const detail = [root || '(LOCALAPPDATA is not set)'];
    if (info.exists) {
      detail.push(`${info.files} blob(s), ${human(info.bytes)}`);
      if (info.orphans) detail.push(`${info.orphans} blob(s) with no .toc index - these need scan mode`);
      if (info.newest) {
        detail.push(`newest: ${path.basename(info.newest.path)}, ` +
          `${new Date(info.newest.mtimeMs).toLocaleString()}`);
        const toc = info.newest.path.slice(0, -4) + '.toc';
        try {
          const head = await fs.promises.readFile(toc);
          if (head.length >= 8 && head.subarray(0, 4).equals(nvcache.TOC_MAGIC)) {
            const version = head.readUInt32LE(4);
            detail.push(`index format v${version >>> 16} ` +
              `(${version >= 0x00040000 ? '64-bit' : '32-bit'} offsets)`);
          } else {
            detail.push('its .toc does not carry the CDVN magic - scan mode will be needed');
          }
        } catch (e) { detail.push('its .toc could not be read'); }
      }
    }
    if (redirect) {
      detail.push('__GL_SHADER_DISK_CACHE_PATH is set, so this is not the system cache');
    }
    add(info.exists && info.files ? 'ok' : 'warn',
      info.exists ? (info.files ? 'GLCache readable' : 'GLCache is empty') : 'GLCache not found',
      ...detail);
  }

  // 4. DXCache
  {
    const root = process.env.LOCALAPPDATA &&
      path.join(process.env.LOCALAPPDATA, 'NVIDIA', 'DXCache');
    const info = await walkCache(root, '.nvph');
    const detail = [root || '(LOCALAPPDATA is not set)'];
    if (info.exists) {
      detail.push(`${info.files} bucket(s), ${human(info.bytes)}`);
      if (info.newest) {
        try {
          const head = await fs.promises.readFile(info.newest.path);
          const live = nvcache.dxLivePrefix(head);
          detail.push(live
            ? `newest: ${path.basename(info.newest.path)}, ${human(live.length)} live of ` +
              `${human(info.newest.size)} allocated`
            : `newest: ${path.basename(info.newest.path)} has no nvph header`);
        } catch (e) {
          detail.push(`newest: ${path.basename(info.newest.path)} could not be read (the driver ` +
            'holds some open)');
        }
      }
      detail.push('buckets are preallocated, so most of that size is zeros; a size floor of ' +
        '65536 makes sweeping them much faster');
    }
    add(info.exists && info.files ? 'ok' : 'warn',
      info.exists ? (info.files ? 'DXCache readable' : 'DXCache is empty') : 'DXCache not found',
      ...detail);
  }

  // 5. the bundled decompressor, end to end
  try {
    const frame = Buffer.from(SELF_TEST_FRAME, 'base64');
    const padded = Buffer.concat([frame, Buffer.alloc(64, 0xa5)]);   // with trailing junk
    const decoded = zstd.decodeFrame(padded, 0, null, zstd.frameContentSize(padded, 0));
    const good = decoded && decoded.length === SELF_TEST_LENGTH &&
      decoded.subarray(0, SELF_TEST_HEAD.length).toString() === SELF_TEST_HEAD;
    add(good ? 'ok' : 'fail', good ? 'zstd decompressor working' : 'zstd decompressor is broken',
      good ? `bundled fzstd decoded a ${frame.length}-byte frame to ${decoded.length} bytes`
        : `expected ${SELF_TEST_LENGTH} bytes, got ${decoded ? decoded.length : 'nothing'}`);
  } catch (e) {
    add('fail', 'zstd decompressor is broken', e.message);
  }

  // 6. the extension this one supersedes
  {
    const old = vscode.extensions.getExtension(OLD_EXTENSION);
    add(old ? 'warn' : 'ok',
      old ? 'the older highlighter extension is still installed' : 'no conflicting extension',
      old
        ? `${OLD_EXTENSION} contributes the same language id, grammar scope and theme names as ` +
          'this extension. With both installed, which contribution wins is not defined. ' +
          'Uninstall it - this extension contains all of it.'
        : null);
  }

  // 7. storage
  {
    const stats = await output.storageStats(context);
    const days = vscode.workspace.getConfiguration('nvIsaExtractor').get('output.retentionDays');
    add('ok', 'listing storage', stats.dir,
      `${stats.files} file(s), ${human(stats.bytes)}`,
      Number(days) > 0 ? `pruned after ${days} days` : 'kept indefinitely (retentionDays is 0)');
  }

  return findings;
}

function render(findings, context) {
  const pkg = require('../package.json');
  const mark = { ok: '  ok  ', warn: ' warn ', fail: ' FAIL ' };
  const lines = [
    `${pkg.displayName} ${pkg.version} - environment check`,
    `VS Code ${vscode.version} on ${process.platform}`,
    `run at ${new Date().toLocaleString()}`,
    ''
  ];
  for (const f of findings) {
    lines.push(`${mark[f.level]} ${f.title}`);
    for (const d of f.detail) {
      for (const line of String(d).split('\n')) lines.push(`        ${line}`);
    }
  }
  const failed = findings.filter(f => f.level === 'fail').length;
  const warned = findings.filter(f => f.level === 'warn').length;
  lines.push('', '-'.repeat(70),
    failed ? `${failed} problem(s) will stop disassembly from working.`
      : warned ? `Ready. ${warned} thing(s) worth knowing about, listed above.`
        : 'Ready - everything checks out.');
  void context;
  return { text: lines.join('\n'), failed, warned };
}

module.exports = { diagnose, render, OLD_EXTENSION };
