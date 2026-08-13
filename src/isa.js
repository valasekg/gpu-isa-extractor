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
const amd = require('./isa_amd');

const TARGETS = { nvidia: nvidia.target, amd: amd.target };
const DIALECTS = { 'nvidia-sass': nvidia.dialect, 'amd-rdna-isa': amd.dialect };

/** Presentation order: the default first. Not alphabetical, and not insertion order by luck. */
const ORDER = ['nvidia', 'amd'];

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

/**
 * `<entry>.<sha1[0:8]>.<arch><ext>` - the shape `output.listingName` writes, as a pattern.
 *
 * Here rather than in its two readers because it is derived from `LISTING_EXTS`, and the two
 * readers had a hardcoded `.nvsass` each. `listingIndex` admits every dialect's listings, so a
 * reader that recognises only one means a second dialect's listings are indexed and pruned and
 * then never matched - `hasListing` is permanently false, the browser shows every object as
 * not disassembled, and the shortcut that opens an existing listing instead of re-running
 * nvdisasm re-disassembles on every visit.
 *
 * Capturing groups: 1 the entry name, 2 the sha1 prefix, 3 the architecture.
 */
const LISTING_NAME_RE = new RegExp(
  '^(.*)\\.([0-9a-f]{8})\\.([^.]+)(?:' +
  [...LISTING_EXTS].map(ext => ext.replace(/\./g, '\\.')).join('|') + ')$', 'i');

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
 * `auto` is resolved PER ROAD, not per machine, and the distinction is the whole of the
 * design here:
 *
 *   compute        NVIDIA whenever ptxas resolves, unconditionally. ptxas cross-compiles for
 *                  any architecture from a machine with no GPU at all, so making the installed
 *                  adapter the discriminator would silently change what an existing machine
 *                  does - a laptop with a Radeon in it would stop producing the SASS it
 *                  produced yesterday.
 *
 *   a graphics     NVIDIA only when the Vulkan probe finds an NVIDIA device, because that road
 *   stage         IS the local driver. Otherwise AMD, when RGA resolves. Without this split, a
 *                  machine with the CUDA Toolkit installed and a Radeon fitted resolves NVIDIA,
 *                  walks into vk_compile.py against a driver that enumerates no NVIDIA device,
 *                  and fails - while the RGA road that would have worked is never considered.
 *
 * Neither branch asks about AMD hardware, because neither RGA mode needs any.
 *
 * @param {object} [request]
 * @param {string} [request.stage]      the shader stage, where one is known
 * @param {string} [request.requested]  an explicit id from the setting or the file's directive
 * @param {object} [request.available]  {nvidia: bool, amd: bool} - what actually resolves here.
 *   Passed in rather than probed, because probing costs process launches and the caller has
 *   already done it. Absent means "do not consider availability", which is what keeps this
 *   callable from a test with no toolchain at all.
 * @returns {{target, from: string, alternative: ?object}}
 */
function resolveTarget({ stage, requested, available } = {}) {
  if (requested && requested !== 'auto') {
    const chosen = get(requested);
    if (!chosen) {
      throw new Error(
        `${requested} is not a target this can compile for. Available: ${ORDER.join(', ')}.`);
    }
    return { target: chosen, from: 'the compile.target setting', alternative: null };
  }

  const can = id => !available || available[id] !== false;
  const road = stage ? (TARGETS.nvidia.roadFor(stage) || null) : null;

  // Compute, or a stage nobody named: hardware-blind, because ptxas is.
  if (!stage || road === 'cuda') {
    if (can('nvidia')) {
      return { target: TARGETS.nvidia, from: 'the compute road cross-compiles from anywhere',
        alternative: can('amd') ? TARGETS.amd : null };
    }
    if (can('amd')) return { target: TARGETS.amd, from: 'no CUDA toolchain here', alternative: null };
  } else if (available && available.nvidiaDevice === false && can('amd')) {
    // A graphics stage on a machine whose Vulkan probe finds no NVIDIA device. The NVIDIA road
    // cannot work here and RGA can.
    return { target: TARGETS.amd, from: 'no NVIDIA device for the driver road',
      alternative: can('nvidia') ? TARGETS.nvidia : null };
  } else if (can('nvidia')) {
    return { target: TARGETS.nvidia, from: 'the local driver compiles graphics stages',
      alternative: can('amd') ? TARGETS.amd : null };
  } else if (can('amd')) {
    return { target: TARGETS.amd, from: 'no NVIDIA toolchain here', alternative: null };
  }

  return { target: TARGETS[DEFAULT_TARGET], from: 'the default', alternative: null };
}

module.exports = {
  TARGETS,
  DIALECTS,
  ORDER,
  DEFAULT_TARGET,
  LISTING_EXTS,
  LISTING_NAME_RE,
  get,
  strideFor,
  list,
  dialectFor,
  dialectForFile,
  isListingPath,
  resolveTarget
};
