'use strict';

/**
 * Semantic-token regression tests without an Extension Host.
 *
 * TextMate colors arrive first and semantic tokens replace them asynchronously. Opcodes
 * must therefore stay on the unmodified `sassOpcode` token or stock themes can repaint
 * classified instructions (notably UIADD3) with the editor foreground.
 */

const Module = require('module');
const path = require('path');

class EventEmitter {
  constructor() {
    this.event = () => {};
  }
  fire() {}
  dispose() {}
}

class SemanticTokensLegend {
  constructor(tokenTypes, tokenModifiers) {
    this.tokenTypes = tokenTypes;
    this.tokenModifiers = tokenModifiers;
  }
}

class SemanticTokensBuilder {
  constructor(legend) {
    this.legend = legend;
    this.tokens = [];
  }
  push(line, character, length, tokenType, tokenModifiers) {
    this.tokens.push({ line, character, length, tokenType, tokenModifiers });
  }
  build() {
    return this.tokens;
  }
}

const vscodeStub = {
  EventEmitter,
  SemanticTokensLegend,
  SemanticTokensBuilder,
  workspace: {
    getConfiguration() {
      return {
        get(_key, fallback) {
          return fallback;
        }
      };
    }
  }
};

const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (request === 'vscode') return vscodeStub;
  return originalLoad.call(this, request, parent, isMain);
};

const {
  SassSemanticTokensProvider,
  legend
} = require(path.join(__dirname, '..', 'src', 'semantic.js'));

let checks = 0;
let failures = 0;

function check(condition, what, detail = '') {
  checks++;
  if (condition) return;
  failures++;
  console.log(`  FAIL  ${what}`);
  if (detail) console.log(`        ${detail}`);
}

const lines = [
  'LDG.E.STRONG.SM R11, [R12.U32+UR4] ;',
  'UIADD3 UR6, UP0, UR4, 0x100, URZ ;',
  'BRA 0x40 ;',
  'IPA.PASS R4, a[0x7c] ;'
];

const document = {
  lineCount: lines.length,
  lineAt(line) {
    return { text: lines[line] };
  }
};

const provider = new SassSemanticTokensProvider();
const tokens = provider.provideDocumentSemanticTokens(document);
const opcodeType = legend.tokenTypes.indexOf('sassOpcode');
const uniformType = legend.tokenTypes.indexOf('sassUniformReg');
const opcodeTokens = tokens.filter(token => token.tokenType === opcodeType);

console.log('\n1. Opcode stability across the semantic pass');

check(opcodeTokens.length === lines.length, 'every instruction emits an opcode token',
  JSON.stringify(opcodeTokens));
check(opcodeTokens.every(token => token.tokenModifiers === 0),
  'all opcodes use the unmodified sassOpcode token',
  JSON.stringify(opcodeTokens));

const uiadd3 = opcodeTokens.find(token => token.line === 1);
check(uiadd3 && lines[1].slice(uiadd3.character, uiadd3.character + uiadd3.length) === 'UIADD3',
  'uniform-datapath UIADD3 remains a base opcode token', JSON.stringify(uiadd3));

console.log('\n2. Operand-role semantics remain enabled');

const ur6 = tokens.find(token =>
  token.line === 1 &&
  token.tokenType === uniformType &&
  lines[1].slice(token.character, token.character + token.length) === 'UR6');
check(ur6 && ur6.tokenModifiers !== 0,
  'destination/source modifiers remain on register operands', JSON.stringify(ur6));

provider.dispose();

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'}  ${checks} checks, ${failures} failures`);
process.exit(failures === 0 ? 0 : 1);
