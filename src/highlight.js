'use strict';

/**
 * Scoreboard dependencies, as editor navigation.
 *
 * Put the cursor on a scoreboard in a control column and the instructions on the other end of
 * that dependency light up: from a wait, the arms it is waiting to drain; from an arm, the
 * wait that drains it and everything else that wait covers. `F12` opens the same set in a peek
 * window, and `F7` steps through them, because VS Code drives both off these providers.
 *
 * The analysis itself is in `src/scoreboard.js`, deliberately free of any editor API so it can
 * be tested directly. This file is only the wiring.
 */

const vscode = require('vscode');

const scoreboard = require('./scoreboard');

/** The instruction on a line, without its indentation. */
function contentRange(document, line) {
  const text = document.lineAt(line);
  const start = typeof text.firstNonWhitespaceCharacterIndex === 'number'
    ? text.firstNonWhitespaceCharacterIndex
    : text.text.length - text.text.replace(/^\s+/, '').length;
  return new vscode.Range(line, start, line, text.text.length);
}

function analyze(document, position) {
  try {
    return scoreboard.analyzeAt(document, position.line, position.character);
  } catch (e) {
    return null;
  }
}

class ScoreboardHighlightProvider {
  /**
   * Highlight both ends of the dependency.
   *
   * The arming instructions get `Write` and the waiting one `Read`, which is how VS Code
   * colours a definition against its uses - and is the right way round here, since an arm
   * increments the scoreboard and a wait only observes it.
   */
  provideDocumentHighlights(document, position) {
    const hit = analyze(document, position);
    if (!hit || hit.sb === null || !hit.related.length) return null;

    const highlights = [
      new vscode.DocumentHighlight(
        new vscode.Range(position.line, hit.field.start, position.line, hit.field.end),
        hit.role === 'wait' ? vscode.DocumentHighlightKind.Read
          : vscode.DocumentHighlightKind.Write)
    ];

    for (const line of hit.related) {
      if (line === position.line) continue;
      highlights.push(new vscode.DocumentHighlight(
        contentRange(document, line),
        hit.role === 'wait' ? vscode.DocumentHighlightKind.Write
          : vscode.DocumentHighlightKind.Read));
    }
    return highlights;
  }
}

class ScoreboardDefinitionProvider {
  /**
   * "Go to Definition" on a scoreboard means "show me what put it there".
   *
   * From a wait that is one location per arm, so the peek window lists them all; from an arm
   * it is the single wait that drains it.
   */
  provideDefinition(document, position) {
    const hit = analyze(document, position);
    if (!hit || hit.sb === null || !hit.related.length) return null;

    return hit.related.map(line => new vscode.Location(
      document.uri, contentRange(document, line)));
  }
}

module.exports = { ScoreboardHighlightProvider, ScoreboardDefinitionProvider };
