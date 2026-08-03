'use strict';

/**
 * Scoreboard dependencies, as editor navigation.
 *
 * Move the cursor onto a scoreboard inside a control column and the other end of that
 * dependency lights up: from a wait, the instructions that armed it; from an arm, the wait
 * that drains it and everything else that wait covers. `F12` opens the same set in a peek
 * window.
 *
 * **Why this draws its own decorations instead of implementing DocumentHighlightProvider.**
 * VS Code's occurrence highlighter asks the language for the *word* at the cursor and gives up
 * before calling any provider when there is none. A control column is a fixed-width field of
 * single characters, and this language's word pattern only matches identifier-shaped runs - so
 * in `[B01-3--:...]` the leading `B01` is one word and highlights fine, while the `3` after a
 * dash is not part of any word and the provider was never invoked at all. That is a poor
 * foundation for a feature whose whole subject is individual characters, so the selection
 * drives the decorations directly and every position behaves the same way.
 *
 * The analysis itself is in `src/scoreboard.js`, deliberately free of any editor API.
 */

const vscode = require('vscode');

const scoreboard = require('./scoreboard');

const LANGUAGE_ID = 'nvidia-sass';

/**
 * How the two ends are drawn. Built on construction rather than at module load: touching the
 * editor API while the module is merely being required makes it impossible to load this file
 * for anything else, tests included.
 */
function decorationStyles() {
  return {
    /** The scoreboard the cursor is on. */
    anchor: {
      backgroundColor: new vscode.ThemeColor('editor.wordHighlightStrongBackground'),
      borderRadius: '2px'
    },
    /** The instructions on the other end of the dependency. */
    related: {
      isWholeLine: true,
      backgroundColor: new vscode.ThemeColor('editor.rangeHighlightBackground'),
      overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.rangeHighlightForeground'),
      overviewRulerLane: vscode.OverviewRulerLane.Center
    }
  };
}

/** The instruction text on a line, without its indentation. */
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

/**
 * The ranges to decorate for a cursor position: the scoreboard it is on, and the instructions
 * related to it. Split out from the editor plumbing so it can be tested directly.
 */
function decorationsFor(document, position) {
  const hit = analyze(document, position);
  if (!hit || hit.sb === null || !hit.related.length) return { anchor: [], related: [] };

  return {
    anchor: [new vscode.Range(position.line, hit.field.start, position.line, hit.field.end)],
    related: hit.related
      .filter(line => line !== position.line)
      .map(line => contentRange(document, line))
  };
}

class ScoreboardHighlighter {
  constructor() {
    const styles = decorationStyles();
    this.anchorType = vscode.window.createTextEditorDecorationType(styles.anchor);
    this.relatedType = vscode.window.createTextEditorDecorationType(styles.related);
    this.disposables = [
      vscode.window.onDidChangeTextEditorSelection(e => this.update(e.textEditor)),
      vscode.window.onDidChangeActiveTextEditor(editor => this.update(editor))
    ];
  }

  enabled() {
    return vscode.workspace.getConfiguration('nvidiaSass')
      .get('scoreboard.highlight', true);
  }

  clear(editor) {
    if (!editor) return;
    editor.setDecorations(this.anchorType, []);
    editor.setDecorations(this.relatedType, []);
  }

  update(editor) {
    if (!editor || !editor.document || editor.document.languageId !== LANGUAGE_ID) return;
    if (!this.enabled()) return this.clear(editor);

    const { anchor, related } = decorationsFor(editor.document, editor.selection.active);
    editor.setDecorations(this.anchorType, anchor);
    editor.setDecorations(this.relatedType, related);
  }

  /** Redraw every visible editor, for when the setting changes. */
  refresh() {
    for (const editor of vscode.window.visibleTextEditors) this.update(editor);
  }

  dispose() {
    for (const d of this.disposables) d.dispose();
    this.anchorType.dispose();
    this.relatedType.dispose();
  }
}

class ScoreboardDefinitionProvider {
  /**
   * "Go to Definition" on a scoreboard means "show me what put it there".
   *
   * From a wait that is one location per arm, so the peek window lists them all; from an arm
   * it is the wait that drains it.
   */
  provideDefinition(document, position) {
    const hit = analyze(document, position);
    if (!hit || hit.sb === null || !hit.related.length) return null;

    return hit.related.map(line => new vscode.Location(
      document.uri, contentRange(document, line)));
  }
}

module.exports = { ScoreboardHighlighter, ScoreboardDefinitionProvider, decorationsFor };
