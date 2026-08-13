'use strict';

/**
 * One entry point's compiled code, before it is a listing.
 *
 * ## `microcode` used to be the interface. It is now evidence.
 *
 * Everything downstream of a compile took a `Buffer` of 16-byte instruction words and made a
 * listing out of it: write it to a file, hand the file to `nvdisasm --binary`, decode the
 * control fields out of the same bytes, hash it for the listing's identity. That is not a
 * description of "a compiled shader", it is a description of NVIDIA's toolchain, and it is
 * only available because nvdisasm happens to want bytes.
 *
 * A disassembler that emits text instead has no such buffer to offer. There is exactly one
 * thing both kinds of toolchain can promise, and it is the text - so the text is the
 * obligation, and the bytes are an optional attachment.
 *
 * The alternative was four `if (microcode)` guards threaded through the editor layer, and
 * three of them would have thrown rather than degraded. The fourth is worse than throwing:
 * `stats.analyze(text, undefined)` returns a complete-looking result with the entire
 * scheduling section silently missing, while every other figure stays right. A section that
 * vanishes without a word is harder to notice than a crash and easier to believe.
 *
 * ## Why `declared` and `evidence` are separate
 *
 * The banner's most useful habit is comparing two independent accounts of the same shader and
 * saying when they disagree - `stats.crossCheck` exists for nothing else. That only works if
 * the two accounts never get merged on the way in. `declared` is what some tool *said* (ptxas
 * -v, a cache container's header, a statistics file); `evidence` is what is in the code. A
 * field that has drifted from one to the other is a cross-check that silently passes forever.
 */

const crypto = require('crypto');

/**
 * @typedef {object} Evidence     what the code itself shows
 * @property {?Buffer} microcode  the instruction words, where the toolchain hands them over
 * @property {?number} codeBytes  size of the code, where it is known
 * @property {?number} instructions
 *
 * @typedef {object} Declared     what some tool stated about the code
 * @property {?number} registers
 * @property {?number} localBytes
 * @property {?number} sharedBytes
 * @property {?number} spillStores
 * @property {?number} spillLoads
 *
 * @typedef {object} EmitContext
 * @property {string}  outDir      a scratch directory this may write into
 * @property {string}  arch        the architecture, in the target's own spelling
 * @property {?object} token       a VS Code cancellation token, or null
 * @property {boolean} decodeColumn  whether the per-instruction column was asked for
 * @property {boolean} keepIntermediates  whether to leave what it wrote behind
 *
 * @typedef {object} Emission
 * @property {string}  text        the listing body, before any correlation markers
 * @property {?object} annotation  the per-instruction column's own report, or null when this
 *                                 target has no column or the user turned it off
 * @property {string}  tool        what produced the text
 * @property {string}  toolVersion
 * @property {string}  command     the exact invocation, for the banner
 */

const EMPTY_DECLARED = {
  registers: null, localBytes: null, sharedBytes: null, spillStores: null, spillLoads: null
};

/**
 * Put a raw entry from a compile into the shape everything downstream reads.
 *
 * Callers hand in whatever their road produced - `cubin.entryPoints` yields one shape,
 * `carveCache` another - and the differences between those two are exactly the differences
 * this is meant to stop leaking further.
 *
 * @param {object} raw
 * @param {object} options
 * @param {object} options.target  the target row; supplies `emit` and the identity rule
 * @param {string} [options.origin]
 */
function normalize(raw, { target, origin } = {}) {
  const microcode = raw.microcode || null;

  const entry = {
    name: raw.name || null,
    stage: raw.stage || null,

    /**
     * Every API stage this ONE listing covers.
     *
     * Normally one. It is a list because hardware stages and API stages are not the same
     * thing: an architecture that merges two API stages into one hardware stage produces a
     * single body that is the answer for both, and offering the user two identical listings
     * under two names would be describing a choice that does not exist.
     */
    stages: raw.stages || (raw.stage ? [raw.stage] : []),

    /** What the hardware calls the stage, where that differs from what the API calls it. */
    hardwareStage: raw.hardwareStage || null,

    /** The name the producing tool really wrote, where it mangled the one the user chose. */
    driverName: raw.driverName || null,

    /** A key into this target's `provenance` table. */
    origin: origin || raw.origin || 'cache',

    /**
     * Identity. Keeps its field name, because `review.js`, `output.listingName`,
     * `tree.LISTING_NAME_RE` and `browser.listingSha1` all key on it and all belong to the
     * cache road, which is unaffected by any of this.
     */
    sha1: raw.sha1 || (microcode ? sha1Of(microcode) : null),

    /** What was hashed, in words, for the banner to state rather than imply. */
    identityNote: raw.identityNote || null,

    evidence: {
      microcode,
      codeBytes: raw.codeBytes !== undefined ? raw.codeBytes
        : (microcode ? microcode.length : null),
      instructions: raw.instructions !== undefined ? raw.instructions : null
    },

    declared: { ...EMPTY_DECLARED, ...(raw.declared || {}) },

    /** The container's own account, where there is one. Shape is the target's business. */
    metadata: raw.metadata || null,

    warnings: raw.warnings || []
  };

  // Bound here rather than left for the caller to look up, so an entry can be passed around
  // without also passing the target that knows how to disassemble it.
  entry.emit = ctx => target.emit(entry, ctx);
  return entry;
}

function sha1Of(buf) {
  return crypto.createHash('sha1').update(buf).digest('hex');
}

/**
 * The old flat shape, for the parts of the extension that still speak it.
 *
 * `output.banner`, `stats` and the cache browser read `object.microcode`, `object.codeBytes`
 * and `object.metadata` directly, and rewriting all of them in the same commit as this would
 * make the diff impossible to review against the golden listing. This flattens an entry back
 * for them, and it is the seam that disappears when they are moved.
 */
function asObject(entry, extra = {}) {
  return {
    name: entry.name,
    offset: 0,
    codeBytes: entry.evidence.codeBytes,
    microcode: entry.evidence.microcode,
    sha1: entry.sha1,
    origin: entry.origin,
    metadata: entry.metadata,
    warnings: entry.warnings,
    ...extra
  };
}

module.exports = { normalize, asObject, sha1Of, EMPTY_DECLARED };
