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

// `scoreboard.js` is no longer required directly: it is reached through the dialect's
// dependency model, which is the thing that varies per ISA. The analysis still lives there.
const isa = require('./isa');

/**
 * Whether this editor's document is one whose dependencies can be followed.
 *
 * Two conditions, not one. It has to be a listing this extension understands, and its dialect
 * has to have a dependency relation to follow at all - an ISA that states no such thing gets
 * no highlighter rather than a highlighter that scans every line for a column that is never
 * there.
 *
 * This is the EDITOR's gate, and it is deliberately not applied inside `analyze`. A document
 * with no language id is not a document in an unrecognised language, it is a document whose
 * language nobody stated - which is exactly what `decorationsFor`'s callers hand it, since
 * that function exists to be tested without an editor at all. Gating the analysis on a field
 * only VS Code sets would have made the pure half untestable to buy nothing.
 */
function followable(document) {
  const dialect = isa.dialectFor(document);
  return dialect && dialect.dependency ? dialect : null;
}

/** The model to read a document with: its own, or the default when it does not say. */
function modelFor(document) {
  const dialect = isa.dialectFor(document) || isa.DIALECTS[isa.get(isa.DEFAULT_TARGET).dialectId];
  return dialect.dependency || null;
}

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
  // Through the dialect, so the answer comes from the model that matches the ISA in front of
  // the cursor. `scoreboard.analyzeAt` is still what answers for a SASS listing - it is
  // reached by a lookup rather than by being the only thing there is.
  const model = modelFor(document);
  if (!model) return null;
  try {
    return model.analyzeAt(document, position.line, position.character);
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

/**
 * How long to wait after the cursor stops before looking anything up.
 *
 * Holding an arrow key down fires a selection change per repeat, and resolving a dependency
 * means walking back over as many as a few thousand instructions - fine once, wasteful sixty
 * times a second while the caret is still moving.
 */
const SETTLE_MS = 50;

class ScoreboardHighlighter {
  constructor() {
    const styles = decorationStyles();
    this.anchorType = vscode.window.createTextEditorDecorationType(styles.anchor);
    this.relatedType = vscode.window.createTextEditorDecorationType(styles.related);
    this.timer = null;
    this.lastKey = null;
    this.disposables = [
      vscode.window.onDidChangeTextEditorSelection(e => this.schedule(e.textEditor)),
      vscode.window.onDidChangeActiveTextEditor(editor => this.schedule(editor))
    ];
  }

  schedule(editor) {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.update(editor);
    }, SETTLE_MS);
  }

  enabled() {
    return vscode.workspace.getConfiguration('gpuIsaExtractor')
      .get('scoreboard.highlight', true);
  }

  clear(editor) {
    if (!editor) return;
    editor.setDecorations(this.anchorType, []);
    editor.setDecorations(this.relatedType, []);
  }

  update(editor) {
    if (!editor || !followable(editor.document)) return;
    if (!this.enabled()) return this.clear(editor);

    const at = editor.selection.active;
    const key = `${editor.document.uri.toString()}:${editor.document.version}:${at.line}:${at.character}`;
    if (key === this.lastKey) return;
    this.lastKey = key;

    const { anchor, related } = decorationsFor(editor.document, at);
    editor.setDecorations(this.anchorType, anchor);
    editor.setDecorations(this.relatedType, related);
  }

  /** Redraw every visible editor, for when the setting changes. */
  refresh() {
    this.lastKey = null;
    for (const editor of vscode.window.visibleTextEditors) this.update(editor);
  }

  dispose() {
    if (this.timer) clearTimeout(this.timer);
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
    // The same editor gate `update` applies. Registered per language selector today, so this
    // is belt and braces - but a dialect with no dependency model would otherwise answer F12
    // out of another ISA's reader.
    if (!followable(document)) return null;
    const hit = analyze(document, position);
    if (!hit || hit.sb === null || !hit.related.length) return null;

    return hit.related.map(line => new vscode.Location(
      document.uri, contentRange(document, line)));
  }
}

module.exports = { ScoreboardHighlighter, ScoreboardDefinitionProvider, decorationsFor };
