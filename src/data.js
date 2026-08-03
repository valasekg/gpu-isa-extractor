'use strict';

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');

function readJson(name) {
  return JSON.parse(fs.readFileSync(path.join(DATA_DIR, name), 'utf8'));
}

const opcodesDoc = readJson('opcodes.json');
const extraDoc = readJson('opcodes-extra.json');
const modifiersDoc = readJson('modifiers.json');
const registersDoc = readJson('registers.json');

/* ------------------------------------------------------------------ opcodes */

/**
 * First-party opcodes first, then the graphics-only supplement. `documented` records
 * which list an opcode came from - a Hopper-only or undocumented mnemonic showing up in
 * an SM86 dump is worth knowing about, so the hover says so rather than hiding it.
 */
const opcodes = new Map();
for (const [name, e] of Object.entries(opcodesDoc.opcodes)) {
  opcodes.set(name, Object.assign({ name, documented: true }, e));
}
for (const [name, e] of Object.entries(extraDoc.opcodes)) {
  if (!opcodes.has(name)) {
    opcodes.set(name, Object.assign({ name, documented: false }, e));
  }
}

/* ---------------------------------------------------------------- modifiers */

/** opcode -> Map(modifier -> entry), built from the group table. */
const modsByOpcode = new Map();
const groupOfOpcode = new Map();

for (const [groupName, group] of Object.entries(modifiersDoc.groups)) {
  for (const op of group.opcodes) {
    groupOfOpcode.set(op, groupName);
    let bucket = modsByOpcode.get(op);
    if (!bucket) modsByOpcode.set(op, (bucket = new Map()));
    for (const [mod, entry] of Object.entries(group.mods)) {
      if (!bucket.has(mod)) bucket.set(mod, Object.assign({ group: groupName }, entry));
    }
  }
}

const genericMods = new Map(Object.entries(modifiersDoc.generic));

/**
 * The uniform-datapath twin of a scalar opcode: UIADD3 -> IADD3, USHF -> SHF.
 * Lets the uniform instructions inherit their sibling's postfix meanings instead of
 * duplicating every entry.
 */
function uniformTwinOf(name) {
  if (name.length > 2 && name[0] === 'U') {
    const rest = name.slice(1);
    if (opcodes.has(rest) || modsByOpcode.has(rest)) return rest;
  }
  return null;
}

function lookupOpcode(name) {
  return opcodes.get(name) || null;
}

/** Opcode-specific entry, then the uniform twin's, then generic. */
function lookupModifier(opcodeName, mod) {
  const candidates = [opcodeName];
  const twin = opcodeName && uniformTwinOf(opcodeName);
  if (twin) candidates.push(twin);

  for (const op of candidates) {
    const bucket = modsByOpcode.get(op);
    if (bucket && bucket.has(mod)) return bucket.get(mod);
  }
  return genericMods.get(mod) || null;
}

/* ---------------------------------------------------------------- registers */

function registerClass(key) {
  return registersDoc.classes[key] || null;
}

function lookupSpecialRegister(name) {
  if (registersDoc.special[name]) return registersDoc.special[name];
  // SR_TID.X falls back to SR_TID when the component is not listed separately.
  const dot = name.indexOf('.');
  if (dot > 0 && registersDoc.special[name.slice(0, dot)]) {
    return registersDoc.special[name.slice(0, dot)];
  }
  return null;
}

function lookupConstantOffset(bank, offset) {
  const b = registersDoc.constantBanks[bank];
  if (!b || !b.offsets) return null;
  return b.offsets[offset] || null;
}

function lookupAttributeSlot(offset) {
  const v = registersDoc.attributeSlots[offset];
  return typeof v === 'string' ? v : null;
}

/* ------------------------------------------------------------- architecture */

const ARCH_LABELS = {
  turing: 'Turing (SM75)',
  ampere: 'Ampere / Ada (SM8x)',
  hopper: 'Hopper (SM90)',
  blackwell: 'Blackwell (SM10x/12x)'
};

/** Map an SM number from `.headerflags` onto the instruction-set table that covers it. */
function archForSm(sm) {
  const n = parseInt(sm, 10);
  if (!Number.isFinite(n)) return null;
  if (n < 80) return 'turing';
  if (n < 90) return 'ampere';
  if (n < 100) return 'hopper';
  return 'blackwell';
}

/** Read the target architecture out of a document's ELF header flags, if present. */
function detectArchitecture(getLine, lineCount) {
  const limit = Math.min(lineCount, 200);
  for (let i = 0; i < limit; i++) {
    const m = /EF_CUDA_SM(\d+)/.exec(getLine(i));
    if (m) return archForSm(m[1]);
  }
  return null;
}

/* --------------------------------------------------------------- categories */

const CATEGORY_CONTROL = 'Control';
const CATEGORY_UNIFORM = 'Uniform Datapath';

function isControlFlow(name) {
  const e = lookupOpcode(name);
  return !!e && e.cat === CATEGORY_CONTROL;
}

function isUniformDatapath(name) {
  const e = lookupOpcode(name);
  if (e) return e.cat === CATEGORY_UNIFORM;
  return !!uniformTwinOf(name);
}

module.exports = {
  opcodes,
  opcodesMeta: opcodesDoc._meta,
  modifiersMeta: modifiersDoc._meta,
  registersDoc,
  sourceLabels: modifiersDoc._meta.sources,
  ARCH_LABELS,
  lookupOpcode,
  lookupModifier,
  uniformTwinOf,
  groupOfOpcode,
  registerClass,
  lookupSpecialRegister,
  lookupConstantOffset,
  lookupAttributeSlot,
  archForSm,
  detectArchitecture,
  isControlFlow,
  isUniformDatapath
};
