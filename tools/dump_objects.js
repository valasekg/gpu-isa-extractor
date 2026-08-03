'use strict';

/**
 * Command-line access to the extension's cache reader, for testing it against the reference
 * Python implementation. Not shipped in the VSIX.
 *
 *   ELECTRON_RUN_AS_NODE=1 Code.exe tools/dump_objects.js list --backend vk --json
 *   ELECTRON_RUN_AS_NODE=1 Code.exe tools/dump_objects.js dump --source F --offset N --raw OUT
 *
 * The JSON field names match `nvsass.py list --json` so `oracle_compare.py` can diff the two
 * without translating between them.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const nvcache = require(path.join(__dirname, '..', 'src', 'nvcache.js'));

function usage(message) {
  if (message) console.error(`dump_objects: ${message}`);
  console.error(`usage:
  list --backend vk|dx [--root DIR] [--scan] [--min-code N] [--json]
  dump --source FILE --offset N [--raw OUT] [--json]`);
  process.exit(2);
}

function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { opts._.push(a); continue; }
    const key = a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) opts[key] = true;
    else { opts[key] = next; i++; }
  }
  return opts;
}

function glRoot() {
  return process.env.__GL_SHADER_DISK_CACHE_PATH ||
    (process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'NVIDIA', 'GLCache'));
}

function dxRoot() {
  return process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'NVIDIA', 'DXCache');
}

/** Every `.bin` in a GLCache tree, largest first - the driver shards under driver/device. */
function glBlobs(root, requireToc = true) {
  const out = [];
  const walk = dir => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith('.bin') &&
        (!requireToc || fs.existsSync(full.slice(0, -4) + '.toc'))) out.push(full);
    }
  };
  walk(root);
  return out.sort((a, b) => fs.statSync(b).size - fs.statSync(a).size);
}

function readOrNull(file) {
  try { return fs.readFileSync(file); } catch (e) { return null; }
}

async function cmdList(opts) {
  const backend = opts.backend || 'vk';
  const minCode = Number(opts.minCode || 0);
  const scan = !!opts.scan;
  const root = opts.root || (backend === 'dx' ? dxRoot() : glRoot());

  const objects = [];
  const stats = {};
  let files = 0;

  const absorb = r => {
    objects.push(...r.objects);
    for (const [k, v] of Object.entries(r.stats)) stats[k] = (stats[k] || 0) + v;
  };

  if (backend === 'vk') {
    for (const file of glBlobs(root, !scan)) {
      const blob = readOrNull(file);
      if (!blob) { stats.unreadable = (stats.unreadable || 0) + 1; continue; }
      files++;
      absorb(await nvcache.enumerateObjects(blob, {
        source: file, backend: 'vk', toc: scan ? null : readOrNull(file.slice(0, -4) + '.toc'),
        scan, minCode
      }));
    }
  } else {
    let names = [];
    try { names = fs.readdirSync(root).sort(); } catch (e) { names = []; }
    for (const name of names) {
      const file = path.join(root, name);
      const raw = readOrNull(file);
      if (!raw) { stats.unreadable = (stats.unreadable || 0) + 1; continue; }
      const live = nvcache.dxLivePrefix(raw);
      if (!live) continue;
      files++;
      absorb(await nvcache.enumerateObjects(live, { source: file, backend: 'dx', minCode }));
    }
  }

  const records = objects.map(o => ({
    entry: o.name, code_bytes: o.codeBytes, instructions: o.instructions,
    source: o.source, offset: o.offset, backend: o.backend,
    microcode_sha1: o.sha1, warnings: o.warnings
  }));

  if (opts.json) {
    process.stdout.write(JSON.stringify({
      tool: 'dump_objects', command: 'list', backend, root, scan, min_code: minCode,
      files, count: records.length, skipped: stats, objects: records
    }, null, 1));
    return records.length ? 0 : 1;
  }

  for (const r of records) {
    console.log(`${path.basename(r.source)} @${r.offset}  ${String(r.code_bytes).padStart(9)} B  ` +
      `${String(r.instructions).padStart(7)} instr  ${r.microcode_sha1.slice(0, 8)}  ` +
      `${r.entry || '(unnamed)'}${r.warnings.length ? '  !!' : ''}`);
  }
  console.log(`${records.length} object(s) in ${files} file(s)`);
  for (const line of nvcache.describeSkips(stats)) console.log(`  note: ${line}`);
  return records.length ? 0 : 1;
}

function cmdDump(opts) {
  if (!opts.source) usage('dump needs --source');
  if (opts.offset === undefined) usage('dump needs --offset');

  const raw = readOrNull(opts.source);
  if (!raw) { console.error(`cannot read ${opts.source}`); return 1; }

  const isDx = opts.source.toLowerCase().endsWith('.nvph');
  const buf = isDx ? (nvcache.dxLivePrefix(raw) || raw) : raw;
  const obj = nvcache.carveAt(buf, Number(opts.offset), {
    source: opts.source, backend: isDx ? 'dx' : 'vk'
  });
  if (!obj) { console.error(`no object at offset ${opts.offset} in ${opts.source}`); return 1; }

  const out = opts.raw || path.join(os.tmpdir(), `${obj.sha1.slice(0, 12)}.bin`);
  fs.writeFileSync(out, obj.microcode);

  const record = {
    tool: 'dump_objects', command: 'dump', out,
    entry: obj.name, code_bytes: obj.codeBytes, instructions: obj.instructions,
    source: obj.source, offset: obj.offset, backend: obj.backend,
    microcode_sha1: obj.sha1, warnings: obj.warnings
  };
  process.stdout.write(opts.json ? JSON.stringify(record, null, 1)
    : `${obj.sha1}  ${obj.codeBytes} bytes -> ${out}\n`);
  return 0;
}

(async () => {
  const opts = parseArgs(process.argv.slice(2));
  const command = opts._[0];
  try {
    if (command === 'list') process.exit(await cmdList(opts));
    else if (command === 'dump') process.exit(cmdDump(opts));
    else usage(command ? `unknown command ${command}` : null);
  } catch (e) {
    console.error(`dump_objects: ${e && e.stack ? e.stack : e}`);
    process.exit(3);
  }
})();
