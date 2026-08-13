'use strict';

const vscode = require('vscode');
const { parseLine } = require('./parse');

/**
 * Semantic highlighting pass.
 *
 * The TextMate grammar already colours register *classes*. What it cannot do is tell a
 * destination from a source, because that depends on the opcode: `STG [R19+UR4], R0`
 * writes memory, not R19. This provider re-parses each line in JS and emits the role, so
 * the theme can brighten destinations without ever getting a store backwards.
 *
 * Ranges emitted here must not overlap. For bracketed operands only the leading
 * identifier is claimed (`c` of `c[0x0][0x28]`), which leaves the brackets and any nested
 * register to the grammar.
 */

const TOKEN_TYPES = [
  'sassOpcode', 'sassModifier', 'sassVectorReg', 'sassUniformReg', 'sassPredicate',
  'sassUniformPredicate', 'sassSpecialReg', 'sassBarrier', 'sassConstBank',
  'sassAttribute', 'sassImmediate', 'sassGuard', 'sassLabel'
];

const TOKEN_MODIFIERS = [
  'dst', 'src', 'discard', 'tier1', 'tier2', 'tier3', 'reuse'
];

/**
 * Registers that are not storage but a constant: RZ and URZ read as zero, PT and UPT as
 * true, SRZ as zero. The grammar gives each its own dimmed scope on sight, and the semantic
 * pass deliberately leaves them alone in a source slot - see the loop below.
 */
const ZERO_REGISTERS = new Set(['RZ', 'URZ', 'PT', 'UPT', 'SRZ']);

/** The text a parsed token covers, for comparing against a name. */
function sliceOf(line, token) {
  const range = token.head || token;
  return line.slice(range.start, range.end);
}

const legend = new vscode.SemanticTokensLegend(TOKEN_TYPES, TOKEN_MODIFIERS);

const KIND_TO_TYPE = {
  vector: 'sassVectorReg',
  uniform: 'sassUniformReg',
  predicate: 'sassPredicate',
  predFile: 'sassPredicate',
  uniformPredicate: 'sassUniformPredicate',
  special: 'sassSpecialReg',
  barrier: 'sassBarrier',
  scoreboard: 'sassBarrier',
  const: 'sassConstBank',
  descriptor: 'sassConstBank',
  attribute: 'sassAttribute',
  immediate: 'sassImmediate',
  label: 'sassLabel'
};

const TYPE_INDEX = new Map(TOKEN_TYPES.map((t, i) => [t, i]));
const MODIFIER_BIT = new Map(TOKEN_MODIFIERS.map((m, i) => [m, 1 << i]));

function bits(...names) {
  let v = 0;
  for (const n of names) if (n && MODIFIER_BIT.has(n)) v |= MODIFIER_BIT.get(n);
  return v;
}

class SassSemanticTokensProvider {
  constructor() {
    this._onDidChange = new vscode.EventEmitter();
    /** Fired to make VS Code drop its cache and ask for tokens again. */
    this.onDidChangeSemanticTokens = this._onDidChange.event;
  }

  /** Call when a setting changed that affects what this provider emits. */
  refresh() {
    this._onDidChange.fire();
  }

  dispose() {
    this._onDidChange.dispose();
  }

  provideDocumentSemanticTokens(document) {
    const builder = new vscode.SemanticTokensBuilder(legend);
    const settings = vscode.workspace.getConfiguration('nvidiaSass');
    if (!settings.get('semanticHighlighting', true)) {
      return builder.build();
    }

    // This pass re-reads the whole document every time VS Code asks for tokens, which it does
    // after every edit. That is fine for a hand-sized listing and not fine for a megakernel
    // dump of several hundred thousand lines, so past a threshold the TextMate grammar - which
    // only ever colours the visible viewport - is left to do the job alone.
    const maxLines = settings.get('semanticMaxLines', 100000);
    if (maxLines > 0 && document.lineCount > maxLines) {
      return builder.build();
    }

    for (let lineNo = 0; lineNo < document.lineCount; lineNo++) {
      const text = document.lineAt(lineNo).text;
      if (!text.trim()) continue;

      let parsed;
      try {
        parsed = parseLine(text);
      } catch (e) {
        continue;                        // never let one odd line break the whole file
      }
      if (!parsed || !parsed.opcode) continue;

      if (parsed.guard) {
        push(builder, lineNo, parsed.guard.start, parsed.guard.end, 'sassGuard', 0);
      }

      // Keep every opcode on the same base token. Modifier-qualified custom semantic
      // tokens can override TextMate with the editor foreground in stock themes, causing
      // a visible blue-to-black flash after the asynchronous semantic pass arrives.
      // Category and provenance remain available in the hover instead.
      push(builder, lineNo, parsed.opcode.start, parsed.opcode.end, 'sassOpcode', 0);

      for (const mod of parsed.modifiers) {
        // Skip the leading '.' so the accessor keeps its punctuation colour.
        push(builder, lineNo, mod.start + 1, mod.end, 'sassModifier', bits('tier' + mod.tier));
      }

      for (const token of parsed.tokens) {
        const type = KIND_TO_TYPE[token.kind];
        if (!type) continue;
        // The grammar already dims a register that reads as a constant, and repainting it
        // here at full register brightness is the same flash the opcode comment above warns
        // about, only in the other direction: RZ arrives dim and turns bright. Letting the
        // token fall through leaves VS Code with nothing to override the grammar with, so
        // the dim colour survives by construction rather than by every theme agreeing to
        // define a matching semantic rule.
        //
        // Only in a source slot. A zero register in a *destination* is a real statement -
        // "computed and thrown away" - which `role: 'discard'` styles and `hover.js`
        // explains, so that one keeps its token.
        if (ZERO_REGISTERS.has(sliceOf(text, token)) &&
            token.role !== 'dst' && token.role !== 'discard') {
          continue;
        }
        const range = token.head || token;
        push(builder, lineNo, range.start, range.end, type, bits(token.role));
      }
    }

    return builder.build();
  }
}

function push(builder, line, start, end, type, modifiers) {
  if (end <= start) return;
  builder.push(line, start, end - start, TYPE_INDEX.get(type), modifiers);
}

module.exports = { SassSemanticTokensProvider, legend, TOKEN_TYPES, TOKEN_MODIFIERS };
