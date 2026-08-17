'use strict';

const vscode = require('vscode');

const { SassSemanticTokensProvider, legend } = require('./src/semantic');
const { SassHoverProvider } = require('./src/hover');
const { SassDocumentSymbolProvider } = require('./src/symbols');
const {
  ScoreboardHighlighter, ScoreboardDefinitionProvider
} = require('./src/highlight');

const isa = require('./src/isa');

const blobstore = require('./src/blobstore');
const browser = require('./src/browser');
const compileview = require('./src/compileview');
const doctor = require('./src/doctor');
const output = require('./src/output');
const pipeline = require('./src/pipeline');
const review = require('./src/review');
const tree = require('./src/tree');

/**
 * Every listing dialect, as a document selector.
 *
 * Not a single language id. The providers below are what give a listing its hovers, semantic
 * colours, outline and F12 - so a dialect that `output.showListing` correctly opens as its own
 * language, but that no provider was registered for, gets none of them. That is not degraded
 * output, it is no provider invoked at all, which reads as the extension being broken rather
 * than as a target being unsupported.
 */
const SELECTOR = isa.ORDER.map(id => ({ language: isa.get(id).dialectId }));

let channel = null;

function log(message) {
  if (channel) channel.appendLine(`[${new Date().toLocaleTimeString()}] ${message}`);
}

async function doctorCommand(context) {
  const findings = await vscode.window.withProgress({
    location: vscode.ProgressLocation.Window,
    title: 'Checking the GPU ISA Extractor environment'
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
    vscode.window.showInformationMessage('GPU ISA Extractor: everything checks out.');
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
  await browser.refreshListingIndex();
  vscode.window.showInformationMessage(`Removed ${removed} generated listing(s).`);
}

function activate(context) {
  channel = vscode.window.createOutputChannel('GPU ISA Extractor');
  review.load(context.globalState);

  const semantic = new SassSemanticTokensProvider();
  const highlighter = new ScoreboardHighlighter();
  const provider = new tree.ShaderObjectsProvider(context);
  const view = vscode.window.createTreeView(tree.VIEW_ID, {
    treeDataProvider: provider,
    showCollapseAll: true,
    canSelectMany: true
  });

  browser.init({ context, provider, view, log, showLog: () => channel.show(true) });
  compileview.init({ context, log, showLog: () => channel.show(true) });

  context.subscriptions.push(
    channel,
    semantic,
    provider,
    view,

    // Correlation lights up the other side of a source<->SASS pair from the selection, so it
    // needs the same editor events the scoreboard highlighter does.
    ...compileview.watch(),

    vscode.languages.registerDocumentSemanticTokensProvider(SELECTOR, semantic, legend),
    vscode.languages.registerHoverProvider(SELECTOR, new SassHoverProvider()),
    vscode.languages.registerDocumentSymbolProvider(SELECTOR, new SassDocumentSymbolProvider()),

    // Put the cursor on a scoreboard in a control column and the other end of that dependency
    // lights up; F12 peeks the same set.
    highlighter,
    vscode.languages.registerDefinitionProvider(SELECTOR, new ScoreboardDefinitionProvider()),

    // Every handler lives in src/browser.js; these registrations stay one per line and
    // single-quoted because tools/verify.py scrapes this file to prove that each declared
    // command really is registered.
    vscode.commands.registerCommand('gpuIsaExtractor.disassemble', uri => browser.openBlob(uri)),
    vscode.commands.registerCommand('gpuIsaExtractor.openBlobDialog', () => browser.openBlobDialog()),
    vscode.commands.registerCommand('gpuIsaExtractor.refreshBlob', node => browser.refreshBlob(node)),
    vscode.commands.registerCommand('gpuIsaExtractor.closeBlob', node => browser.closeBlob(node)),
    vscode.commands.registerCommand('gpuIsaExtractor.filter', () => browser.filterObjects()),
    vscode.commands.registerCommand('gpuIsaExtractor.openObject', node => browser.openObject(node)),
    vscode.commands.registerCommand('gpuIsaExtractor.disassembleObject', (node, selection) => browser.disassembleObject(node, selection)),
    vscode.commands.registerCommand('gpuIsaExtractor.toggleReviewed', (node, selection) => browser.toggleReviewed(node, selection)),
    vscode.commands.registerCommand('gpuIsaExtractor.clearReviewed', node => browser.clearReviewed(node)),
    vscode.commands.registerCommand('gpuIsaExtractor.nextObject', () => browser.walk(1)),
    vscode.commands.registerCommand('gpuIsaExtractor.previousObject', () => browser.walk(-1)),
    vscode.commands.registerCommand('gpuIsaExtractor.nextUnreviewed', () => browser.walk(1, { unreviewedOnly: true })),
    vscode.commands.registerCommand('gpuIsaExtractor.loadMore', node => browser.loadMore(node)),
    vscode.commands.registerCommand('gpuIsaExtractor.compileSource', uri => compileview.compileCommand(uri)),
    vscode.commands.registerCommand('gpuIsaExtractor.compileSourceFor', uri => compileview.compileForCommand(uri)),
    vscode.commands.registerCommand('gpuIsaExtractor.switchStage', uri => compileview.switchStageCommand(uri)),
    vscode.commands.registerCommand('gpuIsaExtractor.revealSource', () => compileview.revealSource()),
    vscode.commands.registerCommand('gpuIsaExtractor.openSettings', () => browser.openSettings()),
    vscode.commands.registerCommand('gpuIsaExtractor.doctor', () => doctorCommand(context)),
    vscode.commands.registerCommand('gpuIsaExtractor.clearOutput', () => clearOutputCommand(context)),

    vscode.workspace.onDidChangeConfiguration(e => {
      // Semantic tokens are cached per document, so toggling the setting has to invalidate them.
      if (e.affectsConfiguration('gpuIsaExtractor.semanticHighlighting') ||
          e.affectsConfiguration('gpuIsaExtractor.semanticMaxLines')) semantic.refresh();
      if (e.affectsConfiguration('gpuIsaExtractor.scoreboard.highlight')) highlighter.refresh();
      // The compile toolchain is probed once and cached; a path setting changes the answer.
      if (e.affectsConfiguration('gpuIsaExtractor.compile')) compileview.resetToolCache();
      if (e.affectsConfiguration('gpuIsaExtractor.arch')) {
        // Listings are named after the architecture, so which ones count as already-generated
        // changes with it.
        pipeline.resetArchCache();
        browser.refreshListingIndex();
      }
      // These change what a sweep would find. Say so rather than silently re-reading every
      // loaded file on a settings keystroke.
      if (e.affectsConfiguration('gpuIsaExtractor.minCodeBytes') ||
          e.affectsConfiguration('gpuIsaExtractor.glcacheMode')) blobstore.markStale();
      if (e.affectsConfiguration('gpuIsaExtractor.tree')) provider.refresh();
    }),

    vscode.window.tabGroups.onDidChangeTabs(() => browser.syncContext()),
    vscode.window.onDidChangeActiveTextEditor(() => browser.syncContext()),
    view.onDidChangeVisibility(e => { if (e.visible) blobstore.checkStamps(); })
  );

  // The tools probe decides which welcome message the empty view shows. It asks about
  // nvdisasm specifically, and that is right rather than an oversight: this key gates the
  // CACHE-BROWSING welcome, and browsing a driver shader cache is NVIDIA-only - there is no
  // reader for an AMD one. Compiling for AMD needs none of this and is reported separately
  // by the doctor, so a machine with rga and no CUDA toolkit correctly sees the cache-road
  // welcome while still being able to compile.
  // It is phrased as
  // "missing" rather than "ready" so the unset state - which is what the view renders during
  // the probe - reads as "nothing wrong yet" instead of accusing the user of a missing
  // toolkit for the moment it takes to find one.
  pipeline.resolveNvdisasm()
    .then(() => vscode.commands.executeCommand('setContext', 'gpuIsaExtractor.toolsMissing', false))
    .catch(() => vscode.commands.executeCommand('setContext', 'gpuIsaExtractor.toolsMissing', true));

  browser.syncContext();
  browser.refreshListingIndex();
  output.pruneListings(context, log).catch(() => {});
}

function deactivate() {
  blobstore.dispose();
}

module.exports = { activate, deactivate };
