'use strict';

/**
 * Run a tool and collect what it printed.
 *
 * Three places needed this and each grew its own: the disassembler runner in `pipeline.js`,
 * the toolchain driver in `compile.js`, and the second nvdisasm pass in `compileview.js`.
 * They agreed on the hard-won parts by accident rather than by construction, which is the
 * kind of agreement that stops being true the first time one of them is fixed.
 *
 * What has to be right, and is easy to get wrong once per copy:
 *
 *   - **`spawn`, not `execFile`.** execFile buffers into a 1 MB string by default and a large
 *     kernel disassembles to tens of megabytes; the overflow is reported as an error whose
 *     message says nothing about truncation. An 8 MB kernel produced 503,994 lines here.
 *   - **An argv array and no shell.** Paths with spaces are ordinary on Windows, and quoting
 *     rules are a source of bugs that only appear on someone else's directory layout.
 *   - **CRLF normalisation.** nvdisasm emits CRLF on Windows. Every text comparison against
 *     reference output fails without this, and the line arithmetic downstream assumes `\n`.
 *   - **Cancellation that actually kills the child.** A cancelled disassembly that leaves
 *     nvdisasm running holds the scratch file open and the next run cannot replace it.
 *
 * This module deliberately has no opinion about failure: it reports the exit code and lets
 * the caller phrase the error, because the useful message differs per tool (the disassembler
 * wants to name the file it kept so the failure can be reproduced; the compiler wants the
 * compiler's own diagnostics).
 *
 * No `vscode` import, so it stays usable from `compile.js` - which is testable precisely
 * because it does not depend on the editor.
 */

const cp = require('child_process');

/**
 * Normalise whatever a Windows tool emits into `\n`, and drop a leading BOM.
 *
 * The BOM is written as an escape rather than as the character itself: a literal U+FEFF is
 * invisible in every editor and turns the file non-ASCII, which is how a stray control byte
 * gets into a source file and stays there.
 */
function normalise(chunks) {
  return Buffer.concat(chunks).toString('utf8')
    .replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/^\uFEFF/, '');
}

/**
 * Environment variables that redirect the Vulkan loader, cleared for a child that creates a
 * pipeline.
 *
 * Inheriting them is the default and it is wrong here. A developer's machine routinely has
 * implicit layers hooking pipeline creation - Steam's overlay, OBS, RenderDoc, Afterburner,
 * the Game Bar, Nsight - and any of them can perturb, hang or crash a compile that is
 * supposed to be measuring the driver. When that happens the failure is attributed to the
 * user's shader, because that is the only thing the listing names.
 *
 * `VK_LOADER_LAYERS_DISABLE` turns off implicit layers that no variable names, which is most
 * of them; the rest are pointed at nothing rather than left inherited.
 *
 * It says `~implicit~` and not `*`. The glob disables EXPLICIT layers too - including the
 * validation layer the harness asks for by name - so with `*` here a run that requested
 * validation either failed with VK_ERROR_LAYER_NOT_PRESENT or reported "clean" from a layer
 * that never loaded. That is the worst of the three outcomes: this driver compiles invalid
 * pipelines into plausible microcode, and the layer is the only thing that has ever caught it.
 * `~implicit~` is the loader's name for exactly the set this is meant to exclude.
 *
 * `VK_LAYER_PATH` is deleted rather than kept: the validation layer is found through the
 * registry manifests the SDK installs, and an inherited override pointing somewhere else is
 * how a layer goes missing.
 */
const VULKAN_ENV = {
  VK_ICD_FILENAMES: '', VK_DRIVER_FILES: '', VK_ADD_DRIVER_FILES: '',
  VK_LAYER_PATH: '', VK_ADD_LAYER_PATH: '', VK_INSTANCE_LAYERS: '',
  VK_LOADER_LAYERS_DISABLE: '~implicit~'
};

/**
 * The environment a child gets: this process's, with `env` over it, minus anything scrubbed.
 *
 * A cleared variable is *deleted* rather than set to an empty string, because the Vulkan
 * loader tests for presence and an empty `VK_ICD_FILENAMES` means "no drivers" rather than
 * "no preference" - which would leave nothing to compile with.
 */
function environment(env, scrub) {
  if (!env && !scrub) return process.env;
  const merged = { ...process.env, ...(env || {}) };
  for (const name of Object.keys(scrub || {})) {
    if (scrub[name] === '') delete merged[name];
    else merged[name] = scrub[name];
  }
  return merged;
}

/**
 * Run `exe` with `args` and resolve with everything it produced.
 *
 * Never rejects for a non-zero exit - that is a result, not an exception. It rejects only
 * when the process could not be started at all.
 *
 * @param {string} exe
 * @param {string[]} args
 * @param {object} [options]
 * @param {number} [options.timeout]  milliseconds; 0 or absent means no limit
 * @param {{onCancellationRequested: Function}} [options.token]  a VS Code CancellationToken,
 *   duck-typed so this module needs no editor import
 * @param {string} [options.cwd]
 * @param {object} [options.env]  merged over `process.env`
 * @param {object} [options.scrub]  variables to force after that merge; `''` deletes one
 * @returns {Promise<{code, stdout, stderr, argv, command, failed, timedOut, cancelled}>}
 */
function text(exe, args, { timeout = 0, token, cwd, env, scrub } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = cp.spawn(exe, args, {
        cwd, windowsHide: true, env: environment(env, scrub)
      });
    } catch (e) {
      return reject(new Error(`could not run ${exe}: ${e.message}`));
    }

    const out = [];
    const err = [];
    let timedOut = false;
    let cancelled = false;
    let settled = false;

    const timer = timeout > 0 ? setTimeout(() => {
      timedOut = true;
      terminate(child);
    }, timeout) : null;

    const subscription = token && token.onCancellationRequested
      ? token.onCancellationRequested(() => { cancelled = true; terminate(child); })
      : null;

    const done = () => {
      if (timer) clearTimeout(timer);
      // Disposing matters: these are registered per run and a browse session makes hundreds.
      if (subscription && subscription.dispose) subscription.dispose();
    };

    child.stdout.on('data', d => out.push(d));
    child.stderr.on('data', d => err.push(d));

    child.on('error', e => {
      if (settled) return;
      settled = true;
      done();
      reject(new Error(`could not run ${exe}: ${e.message}`));
    });

    child.on('close', code => {
      if (settled) return;
      settled = true;
      done();
      resolve({
        code,
        stdout: normalise(out),
        stderr: timedOut ? `timed out after ${timeout} ms` : normalise(err),
        argv: [exe, ...args],
        command: quote([exe, ...args]),
        failed: timedOut || cancelled || code !== 0,
        timedOut,
        cancelled
      });
    });
  });
}

/**
 * Kill a child and everything it started.
 *
 * `child.kill()` alone ends one process, and on Windows the process that matters is usually a
 * grandchild: `tools.python` resolves to the `py` launcher, which runs the real `python.exe`
 * and waits. Killing the launcher left that interpreter holding a Vulkan device and still
 * writing the shader cache the next compile was about to read - a cancelled compile that
 * quietly corrupted the one after it.
 *
 * `taskkill /T` walks the tree. If it cannot run, the direct kill below is still better than
 * nothing, so its failure is deliberately ignored rather than surfaced: this runs on a path
 * that is already unwinding.
 */
function terminate(child) {
  if (process.platform === 'win32' && child.pid) {
    try {
      cp.spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true })
        .on('error', () => {});
    } catch (e) { /* fall through to the direct kill */ }
  }
  child.kill();
}

/** An argv array as a command line that can be pasted back into a shell. */
function quote(argv) {
  return argv.map(a => (/[\s"]/.test(a) ? `"${a}"` : a)).join(' ');
}

module.exports = { text, quote, environment, terminate, VULKAN_ENV };
