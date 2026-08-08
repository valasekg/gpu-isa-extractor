'use strict';

/**
 * Everything between "a file on disk" and "a SASS listing": locating nvdisasm, deciding the
 * architecture, sweeping a cache file for objects, and disassembling the one that was chosen.
 *
 * The cache reading itself lives in `nvcache.js` and the control-code decoding in `ctrl.js`,
 * both free of any VS Code dependency so they can be tested from a plain script. This module
 * is the part that knows about settings, progress and cancellation.
 */

const cp = require('child_process');
const fs = require('fs');
const path = require('path');
const vscode = require('vscode');

const nvcache = require('./nvcache');
const spawn = require('./spawn');
const ctrl = require('./ctrl');

const CONFIG = 'nvIsaExtractor';

function config() {
  return vscode.workspace.getConfiguration(CONFIG);
}

/** How a cache file is read, decided by its name and what sits next to it. */
function classify(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.nvph') return { backend: 'dx', label: 'DXCache bucket' };
  if (ext === '.toc') {
    const bin = filePath.slice(0, -4) + '.bin';
    if (!fs.existsSync(bin)) {
      throw new Error(
        `${path.basename(filePath)} is only the index for ${path.basename(bin)}, which is not ` +
        'next to it. Open the .bin instead.');
    }
    return { backend: 'vk', label: 'GLCache blob', redirect: bin };
  }
  if (ext === '.bin') return { backend: 'vk', label: 'GLCache blob' };
  return { backend: 'raw', label: 'blob' };
}

// --------------------------------------------------------------------------- tools

let cachedArch = null;

function run(exe, args, { timeout = 15000, scrub } = {}) {
  return new Promise(resolve => {
    cp.execFile(exe, args, {
      timeout, windowsHide: true,
      // `scrub` exists for the Vulkan probe. Diagnosing the graphics road in an environment
      // the graphics road never uses reports the wrong verdict in both directions: an implicit
      // overlay layer can hang the probe on a machine where compiling works, and an inherited
      // ICD override can make it name a driver the compile would never load.
      env: scrub ? spawn.environment(null, scrub) : undefined
    }, (error, stdout, stderr) => {
      resolve({ error, stdout: stdout || '', stderr: stderr || '' });
    });
  });
}

/**
 * Locate nvdisasm: the setting, then PATH, then the CUDA toolkit.
 *
 * Never bundled - it ships with the CUDA Toolkit under a license that does not allow
 * redistribution, so the most an extension can do is find an installed one.
 */
async function resolveNvdisasm() {
  const configured = (config().get('nvdisasmPath') || '').trim();
  const tried = [];

  if (configured) {
    if (fs.existsSync(configured)) return { path: configured, from: 'the nvdisasmPath setting' };
    tried.push(`the nvdisasmPath setting (${configured})`);
  }

  const bare = process.platform === 'win32' ? 'nvdisasm.exe' : 'nvdisasm';
  const probe = await run(bare, ['--version']);
  if (!probe.error) return { path: bare, from: 'PATH' };
  tried.push('PATH');

  const cuda = process.env.CUDA_PATH;
  if (cuda) {
    const candidate = path.join(cuda, 'bin', bare);
    if (fs.existsSync(candidate)) return { path: candidate, from: 'CUDA_PATH' };
    tried.push(`CUDA_PATH (${candidate})`);
  } else {
    tried.push('CUDA_PATH (not set)');
  }

  throw new Error(
    `nvdisasm not found. Looked in: ${tried.join(', ')}. It ships with the CUDA Toolkit and ` +
    'cannot be bundled with this extension; install the toolkit, or set ' +
    '`nvIsaExtractor.nvdisasmPath` to an existing nvdisasm.');
}

async function nvdisasmVersion(exe) {
  const probe = await run(exe, ['--version']);
  const line = (probe.stdout + probe.stderr).split('\n').map(s => s.trim())
    .find(s => /release|V\d/i.test(s));
  return line || 'version unknown';
}

/**
 * The architecture to disassemble for.
 *
 * Cache objects are already compiled for this machine's GPU, so its compute capability is
 * the right answer - but a machine may have no GPU, or more than one, hence the override.
 */
/**
 * @param {object} [options]
 * @param {boolean} [options.probed]  ignore the `arch` setting and ask the hardware.
 *   For bytes this machine's own driver just produced, the setting is not an override but a
 *   mistake waiting to happen: it exists so a listing can be read for a GPU that is not
 *   present, and honouring it here would decode SM86 bytes as whatever the user pinned.
 */
async function resolveArch({ probed = false } = {}) {
  const configured = (config().get('arch') || 'auto').trim();
  if (!probed && configured && configured.toLowerCase() !== 'auto') {
    return { arch: configured, from: 'the arch setting' };
  }
  if (cachedArch) return cachedArch;

  const probe = await run('nvidia-smi', ['--query-gpu=compute_cap', '--format=csv,noheader']);
  const caps = probe.error ? [] : probe.stdout.split('\n').map(s => s.trim()).filter(Boolean);
  if (!caps.length) {
    // Two different failures, and telling them apart is the whole point. In probed mode the
    // `arch` setting is deliberately ignored, so advising it here sent the user round a loop
    // they could not leave: set it, retry, get the same message, forever. The bytes came from
    // THIS machine's driver, so the only real answer is to make the probe work.
    throw new Error(probed
      ? 'Could not determine the GPU architecture: nvidia-smi is not available or reported ' +
        'nothing. These bytes were just produced by this machine\'s driver, so the ' +
        '`nvIsaExtractor.arch` setting cannot answer for them and is ignored here - put ' +
        'nvidia-smi on PATH (it installs beside the display driver) so the architecture can ' +
        'be read from the hardware that compiled them.'
      : 'Could not determine the GPU architecture: nvidia-smi is not available or reported ' +
        'nothing. Set `nvIsaExtractor.arch` to the compute capability of the GPU that ' +
        'compiled these shaders, for example SM86.');
  }

  const [major, minor] = caps[0].split('.');
  cachedArch = {
    arch: `SM${major}${minor}`,
    from: 'nvidia-smi',
    multiple: caps.length > 1 ? caps : null
  };
  return cachedArch;
}

function resetArchCache() {
  cachedArch = null;
}

// --------------------------------------------------------------------------- sweep

/**
 * Read a cache file and list the shader objects in it.
 *
 * `keepBuffer: false` returns the objects without the file buffer. A GLCache blob is up to
 * 167 MB, and holding one per browsed file costs about its own size in resident memory;
 * re-reading it when a disassembly actually needs it takes ~94 ms against the ~4.5 s that
 * nvdisasm then spends, so the buffer is not worth keeping. The caller cannot drop it
 * itself: for DXCache `buf` is a subarray of the whole preallocated bucket and pins all
 * 256 MB of it, live prefix or not.
 *
 * `minCodeOverride` lets a caller re-sweep at a different size floor without writing the
 * user's setting.
 */
async function sweep(filePath, { progress, token, log, keepBuffer = true, minCodeOverride } = {}) {
  const kind = classify(filePath);
  const target = kind.redirect || filePath;
  const settings = config();
  const minCode = minCodeOverride === undefined
    ? Number(settings.get('minCodeBytes') || 0)
    : Number(minCodeOverride);
  const mode = settings.get('glcacheMode') || 'auto';

  let raw;
  try {
    raw = await fs.promises.readFile(target);
  } catch (e) {
    throw new Error(
      `Cannot read ${path.basename(target)}: ${e.message}. The driver holds some cache files ` +
      'open while it runs; the most recently written shard is the usual casualty.');
  }

  let buf = raw;
  if (kind.backend === 'dx') {
    const live = nvcache.dxLivePrefix(raw);
    if (!live) {
      throw new Error(
        `${path.basename(target)} does not start with the nvph header a DXCache bucket has.`);
    }
    if (log) log(`live prefix: ${live.length} of ${raw.length} bytes`);
    buf = live;
  }

  let toc = null;
  if (kind.backend === 'vk' && mode !== 'scan') {
    try { toc = await fs.promises.readFile(target.slice(0, -4) + '.toc'); } catch (e) { toc = null; }
  }

  const sweepOnce = async scan => nvcache.enumerateObjects(buf, {
    source: target,
    backend: kind.backend,
    toc: scan ? null : toc,
    scan,
    minCode,
    isCancelled: token ? () => token.isCancellationRequested : null,
    tick: async (i, total, found) => {
      if (progress) {
        progress.report({ message: `frame ${i} of ${total} - ${found} object(s)` });
      }
      await new Promise(setImmediate);
    }
  });

  let result = await sweepOnce(mode === 'scan');
  let scanned = mode === 'scan';

  // An indexed sweep that comes up empty is exactly what a driver-side layout change looks
  // like, and scanning for frame magic does not depend on the index at all.
  if (!result.objects.length && kind.backend === 'vk' && mode === 'auto' && toc &&
      !(token && token.isCancellationRequested)) {
    if (log) log('the table of contents yielded no objects; falling back to a magic scan');
    result = await sweepOnce(true);
    scanned = true;
  }

  return {
    ...result,
    ...(keepBuffer ? { buf } : {}),
    source: target,
    backend: kind.backend,
    label: kind.label,
    scanned,
    minCode
  };
}

/** Collapse identical objects - a cache legitimately holds several copies of one shader. */
function collapse(objects) {
  const seen = new Map();
  for (const obj of objects) {
    const existing = seen.get(obj.sha1);
    if (existing) existing.copies++;
    else seen.set(obj.sha1, { ...obj, copies: 1 });
  }
  return [...seen.values()].sort((a, b) => b.codeBytes - a.codeBytes);
}

// --------------------------------------------------------------------------- disassembly

/**
 * Run nvdisasm over carved microcode.
 *
 * `spawn`, not `execFile`: a large kernel disassembles to tens of megabytes and execFile's
 * default 1 MB buffer would truncate it. An argument array with no shell keeps paths with
 * spaces intact without quoting rules entering into it.
 */
async function runNvdisasm(exe, arch, rawPath, token) {
  const args = ['--binary', arch, '--no-dataflow', rawPath];
  const result = await spawn.text(exe, args, { token });

  if (result.cancelled) throw new Error('cancelled');
  if (result.code !== 0) {
    const message = result.stderr.trim().split('\n').slice(0, 4).join('\n');
    throw new Error(
      `nvdisasm exited ${result.code}${message ? `:\n${message}` : ''}\n` +
      `The carved microcode was kept at ${rawPath} so the failure can be reproduced:\n` +
      `  ${result.command}`);
  }
  return { text: result.stdout, command: result.command };
}

/**
 * Carve one object out of a loaded buffer and disassemble it.
 *
 * @param {{buf: Buffer, source: string, backend: string, label: string, scanned: boolean}} source
 *   The whole of what this and `output.banner` read. A live `sweep()` result satisfies it, and
 *   so does a record rebuilt by `blobstore.materialize()` long after the sweep - which is what
 *   lets the browser list objects without holding their file in memory.
 * @returns {{text, object, arch, nvdisasm, command, annotation, rawPath}}
 */
async function disassemble(source, chosen, { token, log, scratchDir } = {}) {
  const sweepResult = source;
  const object = nvcache.carveAt(sweepResult.buf, chosen.offset, {
    source: sweepResult.source,
    backend: sweepResult.backend,
    // A raytracing frame holds several entry points at one offset, so the name is what picks
    // the one the user clicked. Ignored for every other container, which holds exactly one.
    name: chosen.name || null
  });
  if (!object) {
    throw new Error(
      `The object at offset ${chosen.offset} could not be re-read. The cache file changed ` +
      'while it was open - the driver rewrites it as shaders are compiled. Run the command ' +
      'again to pick it up from the current contents.');
  }

  const [{ path: exe, from }, archInfo] = await Promise.all([resolveNvdisasm(), resolveArch()]);
  const { arch } = archInfo;
  if (log) log(`nvdisasm: ${exe} (found via ${from}), architecture ${arch} (${archInfo.from})`);

  await fs.promises.mkdir(scratchDir, { recursive: true });
  const rawPath = path.join(scratchDir, `${object.sha1.slice(0, 12)}.bin`);
  await fs.promises.writeFile(rawPath, object.microcode);

  let result;
  try {
    result = await runNvdisasm(exe, arch, rawPath, token);
  } catch (e) {
    // Deliberately left behind: the message names it so the failure can be reproduced.
    throw e;
  }

  let annotation = null;
  let text = result.text;
  if (config().get('decodeControlCodes') !== false) {
    annotation = ctrl.annotate(text, object.microcode);
    text = annotation.text;
    if (log) {
      log(`decoded control codes for ${annotation.annotated} instruction(s)` +
        (annotation.skipped ? `, skipped ${annotation.skipped} line(s)` : ''));
    }
  }

  if (!config().get('keepRawMicrocode')) {
    fs.promises.unlink(rawPath).catch(() => {});
  }

  return {
    text,
    object,
    arch,
    archFrom: archInfo.from,
    nvdisasm: exe,
    nvdisasmVersion: await nvdisasmVersion(exe),
    command: result.command,
    annotation,
    rawPath: config().get('keepRawMicrocode') ? rawPath : null
  };
}

module.exports = {
  CONFIG,
  classify,
  resolveNvdisasm,
  nvdisasmVersion,
  resolveArch,
  resetArchCache,
  sweep,
  collapse,
  disassemble,
  run
};
