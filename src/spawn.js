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
 * @returns {Promise<{code, stdout, stderr, argv, command, failed, timedOut, cancelled}>}
 */
function text(exe, args, { timeout = 0, token, cwd, env } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = cp.spawn(exe, args, {
        cwd, windowsHide: true, env: env ? { ...process.env, ...env } : process.env
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
      child.kill();
    }, timeout) : null;

    const subscription = token && token.onCancellationRequested
      ? token.onCancellationRequested(() => { cancelled = true; child.kill(); })
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

/** An argv array as a command line that can be pasted back into a shell. */
function quote(argv) {
  return argv.map(a => (/[\s"]/.test(a) ? `"${a}"` : a)).join(' ');
}

module.exports = { text, quote };
