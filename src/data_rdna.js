'use strict';

/**
 * The RDNA documentation tables, in the shape `hover.js` reads.
 *
 * The counterpart of `data.js`, and deliberately a different shape underneath. NVIDIA's
 * mnemonics are not derivable from each other, so that table enumerates 255 of them. RDNA's
 * are systematic - an encoding class, an operation, a type suffix - so this looks up the exact
 * name first and falls back to the CLASS the prefix names. That is why a shader full of
 * `v_mul_f32_e32`, `v_add_f32_e32`, `v_sub_f32_e32` needs one row rather than three, and why
 * an opcode nobody wrote a row for still hovers with something true.
 *
 * The confidence story also inverts, and the hovers should say so. NVIDIA's SASS semantics are
 * assembled from PTX docs, slides and corpus observation; AMD documents its instruction set
 * first-party and ships a machine-readable spec with RGA. An RDNA hover is better grounded
 * than a SASS one, and `_meta.sources` labels which kind each entry is.
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');

const doc = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'rdna-opcodes.json'), 'utf8'));

/** Longest prefix first, so `s_wait_` cannot be shadowed by `s_`. */
const CLASS_PREFIXES = Object.keys(doc.classes).sort((a, b) => b.length - a.length);

/**
 * What an opcode is.
 *
 * The exact name wins; otherwise the encoding class its prefix names, marked so a caller can
 * tell a documented instruction from a documented family. `documented` keeps the field name
 * `data.js` uses, because `hover.js` reads it.
 */
function lookupOpcode(name) {
  if (!name) return null;
  const exact = doc.opcodes[name];
  if (exact) return { name, documented: true, ...exact };

  for (const prefix of CLASS_PREFIXES) {
    if (!name.startsWith(prefix)) continue;
    const klass = doc.classes[prefix];
    return {
      name,
      documented: false,
      desc: `${klass.name}. ${klass.desc}`,
      cat: klass.cat,
      source: klass.source,
      // Said plainly rather than implied: this describes the family, and the specific
      // operation is being read off the mnemonic by the reader rather than by this table.
      note: `No entry for ${name} specifically - this describes the ${prefix}* class it ` +
        'belongs to. RDNA mnemonics name their operation and operand types directly, so the ' +
        'rest of the name is the rest of the answer.'
    };
  }
  return null;
}

/**
 * What a modifier means.
 *
 * A named value like `wait_exp:5` is looked up under its name, so the table needs one row per
 * modifier rather than one per value.
 */
function lookupModifier(opcodeName, mod) {
  if (!mod) return null;
  const bare = String(mod).split(':')[0].replace(/\(.*$/, '');
  const entry = doc.modifiers[bare];
  return entry ? { ...entry, name: bare } : null;
}

/** A named register file or hardware register. */
function lookupSpecialRegister(name) {
  if (!name) return null;
  const bare = String(name).toLowerCase().replace(/_(lo|hi)$/, '');
  return doc.registers[bare] || null;
}

/** The register class a token belongs to, for a hover over `v9` or `s[0:1]`. */
function registerClass(key) {
  return doc.registers[key] || null;
}

/**
 * Architecture labels, the counterpart of `data.ARCH_LABELS`.
 *
 * Keyed by the generation rather than by codename, because a hover wants to say "RDNA 4"
 * rather than list four gfx numbers.
 */
const ARCH_LABELS = {
  rdna1: 'RDNA 1 (gfx101x)',
  rdna2: 'RDNA 2 (gfx103x)',
  rdna3: 'RDNA 3 (gfx110x)',
  rdna35: 'RDNA 3.5 (gfx115x)',
  rdna4: 'RDNA 4 (gfx120x)'
};

/** Which generation a gfx codename belongs to, or null. */
function generationOf(codename) {
  const m = /^gfx(\d{3,4})$/.exec(String(codename || '').toLowerCase());
  if (!m) return null;
  const n = Number(m[1]);
  if (n >= 1200) return 'rdna4';
  if (n >= 1150) return 'rdna35';
  if (n >= 1100) return 'rdna3';
  if (n >= 1030) return 'rdna2';
  if (n >= 1010) return 'rdna1';
  return null;
}

module.exports = {
  meta: doc._meta,
  sourceLabels: doc._meta.sources,
  lookupOpcode,
  lookupModifier,
  lookupSpecialRegister,
  registerClass,
  generationOf,
  ARCH_LABELS,
  CLASS_PREFIXES
};
