'use strict';

const vscode = require('vscode');

/**
 * Outline and breadcrumbs. A megakernel dump runs to hundreds of thousands of lines, so
 * being able to jump to a function or a branch target is worth more here than in most
 * languages.
 *
 * Labels nest under the function they fall inside.
 */

const FUNCTION_RES = [
  /^\s*(?:Function|code)\s*(?::|for)\s*(\S.*?)\s*$/,          // cuobjdump / nvdisasm banner
  /^\s*\/\/-+\s*\.text\.(\S+?)\s*-*\s*$/,                     // //----- .text.foo -----
  /^\s*\.section\s+\.text\.(\S+)/                             // .section .text.foo
];

const LABEL_RE = /^\s*(\.?[A-Za-z_][\w.$]*)\s*:\s*$/;

class SassDocumentSymbolProvider {
  provideDocumentSymbols(document) {
    const roots = [];
    let current = null;

    for (let i = 0; i < document.lineCount; i++) {
      const text = document.lineAt(i).text;
      if (!text.trim()) continue;

      const fn = matchFunction(text);
      if (fn) {
        finish(current, i - 1, document);
        current = new vscode.DocumentSymbol(
          fn, '', vscode.SymbolKind.Function,
          lineRange(document, i), lineRange(document, i)
        );
        roots.push(current);
        continue;
      }

      const label = LABEL_RE.exec(text);
      if (label) {
        const symbol = new vscode.DocumentSymbol(
          label[1], '', vscode.SymbolKind.Key,
          lineRange(document, i), lineRange(document, i)
        );
        if (current) current.children.push(symbol);
        else roots.push(symbol);
      }
    }

    finish(current, document.lineCount - 1, document);
    return roots;
  }
}

function matchFunction(text) {
  for (const re of FUNCTION_RES) {
    const m = re.exec(text);
    if (m) return m[1];
  }
  return null;
}

function lineRange(document, line) {
  return document.lineAt(line).range;
}

/** Extend a function symbol's range to cover everything up to the next one. */
function finish(symbol, lastLine, document) {
  if (!symbol || lastLine < symbol.range.start.line) return;
  const end = document.lineAt(Math.min(lastLine, document.lineCount - 1)).range.end;
  symbol.range = new vscode.Range(symbol.range.start, end);
  for (const child of symbol.children) {
    if (child.range.end.isAfter(end)) child.range = new vscode.Range(child.range.start, end);
  }
}

module.exports = { SassDocumentSymbolProvider };
