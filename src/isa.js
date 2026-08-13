'use strict';

/**
 * One row per ISA this extension can produce, and one per ISA it can read back.
 *
 * The shape is the shape `output.PROVENANCE` and `compile.STAGES` already have: mostly
 * declarative cells, function-valued only where two targets would do different WORK rather
 * than merely spell the same work differently. Nothing above this file writes
 * `if (vendor === ...)`.
 *
 * There is one target today. A registry with one row proves nothing by itself, and it is not
 * here to prove anything - it is here so that the modules above it stop naming a vendor, which
 * is the part that cannot be done incrementally later. `output.banner` asking the registry for
 * a provenance table is the same amount of code as `output.banner` holding one; the difference
 * is that the second version has to be edited to add a target and the first does not.
 *
 * Three axes, because three different things arrive with three different handles:
 *
 *   TARGETS    producing - keyed by target id, which is what a setting or a directive names.
 *   DIALECTS   reading   - keyed by the VS Code language id, because a listing opened from
 *                          disk has no compile behind it and its language id is all that
 *                          survived.
 *   extensions browsing  - keyed by file extension, because `output.pruneListings`,
 *                          `output.listingIndex` and `showListing` are handed a PATH and
 *                          nothing else.
 */

const nvidia = require('./isa_nvidia');

const TARGETS = { nvidia: nvidia.target };
const DIALECTS = { 'nvidia-sass': nvidia.dialect };

/** Presentation order: the default first. Not alphabetical, and not insertion order by luck. */
const ORDER = ['nvidia'];

const DEFAULT_TARGET = 'nvidia';

/**
 * Every listing extension, as one set.
 *
 * `pruneListings`, `listingIndex` and `storageStats` share one directory and each decides for
 * itself what counts as a listing. Behind a single-extension constant, a second target's
 * listings would be counted by one, never pruned by another, and invisible to the third -
 * three different answers to one question. One set, read by all of them.
 */
const LISTING_EXTS = new Set(ORDER.map(id => DIALECTS[TARGETS[id].dialectId].listingExt));

function get(id) {
  return TARGETS[id] || null;
}

/**
 * Bytes per instruction for this target, or null where that is not a fixed number.
 *
 * A single helper because the alternative is every caller writing
 * `target.controlColumn && target.controlColumn.INSTRUCTION_BYTES`, and the one caller that
 * forgets the guard gets a TypeError swallowed by whatever try block it sits in. `null` is a
 * real answer: a variable-length encoding has no stride, and code that steps by one must not
 * run at all rather than step by a plausible-looking wrong number.
 */
function strideFor(target) {
  return (target && target.controlColumn && target.controlColumn.INSTRUCTION_BYTES) || null;
}

function list() {
  return ORDER.map(id => TARGETS[id]);
}

/** The dialect for an open document, by its language id. */
function dialectFor(document) {
  return (document && DIALECTS[document.languageId]) || null;
}

/** The dialect for a path, by extension - for the cases that never see a document. */
function dialectForFile(file) {
  return Object.values(DIALECTS).find(d => d.claimsFile(file)) || null;
}

/** Is this file one of ours at all? */
function isListingPath(file) {
  return dialectForFile(file) !== null;
}

/**
 * Which target should compile this.
 *
 * One target, so one answer - but it is asked through here rather than assumed, so that the
 * call sites are already in place when there is a second. The signature takes what the
 * decision will need rather than what it needs today, because changing a signature later means
 * revisiting every call site, which is the thing this is trying to avoid.
 *
 * @param {object} [request]
 * @param {string} [request.stage]     the shader stage, where one is known
 * @param {string} [request.requested] an explicit target id from a setting or a directive
 * @returns {{target, from: string}}
 */
function resolveTarget({ stage, requested } = {}) {
  void stage;
  if (requested && requested !== 'auto') {
    const chosen = get(requested);
    if (!chosen) {
      throw new Error(
        `${requested} is not a target this can compile for. Available: ${ORDER.join(', ')}.`);
    }
    return { target: chosen, from: 'the target setting' };
  }
  return { target: TARGETS[DEFAULT_TARGET], from: 'the only target installed' };
}

module.exports = {
  TARGETS,
  DIALECTS,
  ORDER,
  DEFAULT_TARGET,
  LISTING_EXTS,
  get,
  strideFor,
  list,
  dialectFor,
  dialectForFile,
  isListingPath,
  resolveTarget
};
