'use strict';

const vscode = require('vscode');

const { SassSemanticTokensProvider, legend } = require('./src/semantic');
const { SassHoverProvider } = require('./src/hover');
const { SassDocumentSymbolProvider } = require('./src/symbols');

const SELECTOR = { language: 'nvidia-sass' };

function activate(context) {
  const semantic = new SassSemanticTokensProvider();

  context.subscriptions.push(
    semantic,

    vscode.languages.registerDocumentSemanticTokensProvider(SELECTOR, semantic, legend),

    vscode.languages.registerHoverProvider(SELECTOR, new SassHoverProvider()),

    vscode.languages.registerDocumentSymbolProvider(SELECTOR, new SassDocumentSymbolProvider()),

    // Semantic tokens are cached per document, so toggling the setting has to invalidate them.
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('nvidiaSass.semanticHighlighting')) semantic.refresh();
    })
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
