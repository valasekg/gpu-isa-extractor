'use strict';

const path = require('path');
const vscode = require('vscode');

const { SassSemanticTokensProvider, legend } = require('./src/semantic');
const { SassHoverProvider } = require('./src/hover');
const { SassDocumentSymbolProvider } = require('./src/symbols');

const pipeline = require('./src/pipeline');
const output = require('./src/output');
const doctor = require('./src/doctor');

const SELECTOR = { language: 'nvidia-sass' };

let channel = null;

function log(message) {
  if (channel) channel.appendLine(`[${new Date().toLocaleTimeString()}] ${message}`);
}

/**
 * Sweeps are keyed on what the file was when it was read. The driver rewrites cache files as
 * it compiles, so a stale sweep would offer objects that have since moved.
 */
const sweepCache = new Map();

async function sweepWithCache(filePath, options) {
  const fs = require('fs');
  let stamp = null;
  try {
    const stat = await fs.promises.stat(filePath);
    stamp = `${stat.mtimeMs}:${stat.size}`;
  } catch (e) { /* let the sweep report the real error */ }

  const settings = vscode.workspace.getConfiguration(pipeline.CONFIG);
  const key = `${filePath}|${stamp}|${settings.get('minCodeBytes')}|${settings.get('glcacheMode')}`;
  const hit = sweepCache.get(key);
  if (hit) {
    log(`reusing the sweep of ${path.basename(filePath)} (unchanged since it was read)`);
    return hit;
  }

  const result = await pipeline.sweep(filePath, options);
  if (!options.token || !options.token.isCancellationRequested) {
    sweepCache.clear();                 // one file's worth: these hold the whole file buffer
    sweepCache.set(key, result);
  }
  return result;
}

/** Ask for a file when the command was not invoked on one. */
async function pickFile() {
  const nvidia = process.env.LOCALAPPDATA
    ? vscode.Uri.file(path.join(process.env.LOCALAPPDATA, 'NVIDIA'))
    : undefined;
  const picked = await vscode.window.showOpenDialog({
    title: 'Select a shader-cache file',
    defaultUri: nvidia,
    canSelectMany: false,
    openLabel: 'Disassemble',
    filters: {
      'NVIDIA shader cache': ['bin', 'toc', 'nvph'],
      'All files': ['*']
    }
  });
  return picked && picked.length ? picked[0] : null;
}

function describeObject(obj) {
  const parts = [`${obj.codeBytes.toLocaleString()} B`, `${obj.instructions.toLocaleString()} instr`];
  if (obj.copies > 1) parts.push(`×${obj.copies}`);
  if (obj.warnings && obj.warnings.length) parts.push('has warnings');
  return parts.join('  ·  ');
}

async function chooseObject(objects, sweepResult) {
  if (objects.length === 1) return objects[0];

  const items = objects.map(obj => ({
    label: obj.name || '(unnamed)',
    description: describeObject(obj),
    detail: `${path.basename(obj.source)} @ ${obj.offset}  ·  sha1 ${obj.sha1.slice(0, 12)}`,
    obj
  }));

  const picked = await vscode.window.showQuickPick(items, {
    title: `${objects.length} shader objects in ${path.basename(sweepResult.source)}`,
    placeHolder: 'Pick one to disassemble - largest first, identical copies collapsed',
    matchOnDescription: true,
    matchOnDetail: true
  });
  return picked ? picked.obj : null;
}

function reportEmptySweep(sweepResult) {
  const nvcache = require('./src/nvcache');
  const notes = nvcache.describeSkips(sweepResult.stats);
  const detail = notes.length ? ` ${notes.join('; ')}.` : '';
  const hint = sweepResult.minCode
    ? ` The size floor is ${sweepResult.minCode} bytes - lower \`nvIsaExtractor.minCodeBytes\` to see smaller objects.`
    : sweepResult.backend === 'raw'
      ? ' This file does not look like a shader cache.'
      : ' Try setting `nvIsaExtractor.glcacheMode` to `scan`, or run the doctor command.';

  log(`no objects: ${sweepResult.frames} frame(s) examined.${detail}`);
  vscode.window.showWarningMessage(
    `No shader objects found in ${path.basename(sweepResult.source)} ` +
    `(${sweepResult.frames} compressed frame(s) examined).${detail}${hint}`);
}

async function disassembleCommand(context, uri) {
  const target = uri && uri.fsPath ? uri : await pickFile();
  if (!target) return;

  const filePath = target.fsPath;
  log(`--- disassemble ${filePath}`);

  try {
    const sweepResult = await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: `Scanning ${path.basename(filePath)}`,
      cancellable: true
    }, (progress, token) => sweepWithCache(filePath, { progress, token, log }));

    log(`${sweepResult.objects.length} object(s) in ${sweepResult.frames} frame(s)` +
      (sweepResult.scanned ? ' (magic scan)' : ''));

    if (!sweepResult.objects.length) return reportEmptySweep(sweepResult);

    const collapsed = pipeline.collapse(sweepResult.objects);
    const chosen = await chooseObject(collapsed, sweepResult);
    if (!chosen) return;

    const result = await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: `Disassembling ${chosen.name || 'shader object'}`,
      cancellable: true
    }, (progress, token) => {
      progress.report({ message: `${chosen.instructions.toLocaleString()} instructions` });
      return pipeline.disassemble(sweepResult, chosen, {
        token, log, scratchDir: output.scratchDir(context)
      });
    });

    const file = await output.openListing(context, result, sweepResult);
    log(`wrote ${file}`);

    // The tripwire is the only signal that the decoded control columns might be wrong, so it
    // gets a notification rather than a line in a channel nobody has open.
    const annotation = result.annotation;
    if (annotation && annotation.mismatchTotal) {
      log(`reuse tripwire: ${annotation.mismatchTotal} of ${annotation.annotated} instructions ` +
        `disagree with nvdisasm (${annotation.missing} missing, ${annotation.extra} extra)` +
        (annotation.suspect ? '' : ' - within the benign range, see the listing banner'));
    }
    if (annotation && annotation.suspect) {
      const choice = await vscode.window.showWarningMessage(
        `Control codes may be wrong: on ${annotation.mismatchTotal} of ` +
        `${annotation.annotated} instructions the decoded reuse flags disagree with what ` +
        'nvdisasm printed. The field layout may differ on this architecture.',
        'Show details');
      if (choice === 'Show details' && channel) channel.show(true);
    } else if (result.object.warnings.length) {
      vscode.window.showWarningMessage(
        `${path.basename(filePath)}: ${result.object.warnings.join('; ')}`);
    }
  } catch (e) {
    if (e && e.message === 'cancelled') { log('cancelled'); return; }
    log(`failed: ${e && e.stack ? e.stack : e}`);
    const choice = await vscode.window.showErrorMessage(
      `Disassembly failed: ${e && e.message ? e.message.split('\n')[0] : e}`, 'Show details');
    if (choice === 'Show details' && channel) channel.show(true);
  }
}

async function doctorCommand(context) {
  const findings = await vscode.window.withProgress({
    location: vscode.ProgressLocation.Window,
    title: 'Checking the NVIDIA ISA Extractor environment'
  }, () => doctor.diagnose(context));

  const { text, failed, warned } = doctor.render(findings, context);
  if (channel) {
    channel.clear();
    channel.appendLine(text);
    channel.show(true);
  }

  if (failed) {
    vscode.window.showErrorMessage(
      `${failed} problem(s) will stop disassembly from working - see the output channel.`);
  } else if (warned) {
    vscode.window.showWarningMessage(
      `Ready, with ${warned} thing(s) worth knowing - see the output channel.`);
  } else {
    vscode.window.showInformationMessage('NVIDIA ISA Extractor: everything checks out.');
  }
}

async function clearOutputCommand(context) {
  const stats = await output.storageStats(context);
  if (!stats.files) {
    vscode.window.showInformationMessage('No generated listings to remove.');
    return;
  }
  const confirm = await vscode.window.showWarningMessage(
    `Delete ${stats.files} generated listing(s) from ${stats.dir}?`,
    { modal: true }, 'Delete');
  if (confirm !== 'Delete') return;

  const removed = await output.clearListings(context);
  log(`cleared ${removed} listing(s) from ${stats.dir}`);
  vscode.window.showInformationMessage(`Removed ${removed} generated listing(s).`);
}

function activate(context) {
  channel = vscode.window.createOutputChannel('NVIDIA ISA Extractor');
  const semantic = new SassSemanticTokensProvider();

  context.subscriptions.push(
    channel,
    semantic,

    vscode.languages.registerDocumentSemanticTokensProvider(SELECTOR, semantic, legend),
    vscode.languages.registerHoverProvider(SELECTOR, new SassHoverProvider()),
    vscode.languages.registerDocumentSymbolProvider(SELECTOR, new SassDocumentSymbolProvider()),

    vscode.commands.registerCommand('nvIsaExtractor.disassemble',
      uri => disassembleCommand(context, uri)),
    vscode.commands.registerCommand('nvIsaExtractor.doctor', () => doctorCommand(context)),
    vscode.commands.registerCommand('nvIsaExtractor.clearOutput',
      () => clearOutputCommand(context)),

    vscode.workspace.onDidChangeConfiguration(e => {
      // Semantic tokens are cached per document, so toggling the setting has to invalidate them.
      if (e.affectsConfiguration('nvidiaSass.semanticHighlighting') ||
          e.affectsConfiguration('nvidiaSass.semanticMaxLines')) semantic.refresh();
      if (e.affectsConfiguration('nvIsaExtractor.arch')) pipeline.resetArchCache();
      if (e.affectsConfiguration('nvIsaExtractor.minCodeBytes') ||
          e.affectsConfiguration('nvIsaExtractor.glcacheMode')) sweepCache.clear();
    })
  );

  output.pruneListings(context, log).catch(() => {});
}

function deactivate() {
  sweepCache.clear();
}

module.exports = { activate, deactivate };
