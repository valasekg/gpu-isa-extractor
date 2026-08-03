'use strict';

/**
 * Read compiled shader objects out of NVIDIA's on-disk shader caches.
 *
 * Two caches, one object format. The driver writes Vulkan/GL objects to GLCache and D3D12
 * objects to DXCache; the containers differ, but what is inside is the same NVuc object, so
 * both paths converge on `parseNvuc` and produce the same record.
 *
 *   GLCache   %LOCALAPPDATA%\NVIDIA\GLCache\<driver>\<device>\<id>.{toc,bin}
 *     <id>.toc  'CDVN', u32 version, 0x20 header, then entries {u8 key[16]; off; size}.
 *               VERSION-DEPENDENT STRIDE: >=0x00040000 is 32 bytes with u64 off/size,
 *               0x00030000 is 24 bytes with u32. Both occur, and a freshly created cache is
 *               written as v3, so a reader that only knows v4 silently finds nothing.
 *     <id>.bin  at each entry offset: a 0x24-byte record header, then a raw zstd frame.
 *               The frame ends at off+32+size, NOT off+size - `size` counts from the end of
 *               a 32-byte prefix while the frame starts at 0x24.
 *
 *   DXCache   %LOCALAPPDATA%\NVIDIA\DXCache\<id>.nvph
 *     'nvph', u32, u64 usedBytes, then records each ending in a raw zstd frame. No index at
 *     all. Files are PREALLOCATED buckets (4K/64K/16M/256M) whose tail is zeros, so read
 *     only the live prefix - and clamp it, because usedBytes is occasionally garbage
 *     (4,294,979,901 has been observed in a 65,536-byte file).
 *
 *   payload (both)
 *     A = payload.indexOf('NVuc')   - 8 in GLCache (an 'NVDANVVM' prefix), 0 in DXCache
 *     A+0x08 u16  sectionCount
 *     A+0x20      32-byte entries { u32 type; u32 len; u32 off; ... }
 *                   SECTION DATA = payload[A+off : A+off+len]   <- anchor-relative
 *                   type 0x01 microcode (a multiple of 16 bytes on SM70+)
 *                   type 0x21 entry-point name (ASCII, NUL-terminated)
 *
 * The anchor-relative rule is the whole trick, and it is why one reader covers both caches.
 * Getting it wrong by the 8-byte prefix truncates the last instruction: usually harmless,
 * because kernels are NOP-padded, but a hard failure whenever the final instruction is not a
 * benign NOP.
 *
 * The format is reverse-engineered and undocumented. Failures here are loud - no objects
 * found, counted skip reasons - never a silent short carve; see `sectionData` and `validate`
 * for why that distinction is load-bearing.
 *
 * Ported from the reference Python reader in csg-propagation (tools/nvsass/nvcache.py);
 * `tools/oracle_compare.py` holds the two to byte identity on this machine's real caches.
 */

const crypto = require('crypto');
const { frameContentSize, decodeFrame, frameOffsets } = require('./zstd');

const TOC_MAGIC = Buffer.from('CDVN', 'ascii');
const NVPH_MAGIC = Buffer.from('nvph', 'ascii');
const NVUC_MAGIC = Buffer.from('NVuc', 'ascii');

const SECTION_MICROCODE = 0x01;
const SECTION_ENTRY_NAME = 0x21;

const SECTION_TABLE_OFFSET = 0x20;      // relative to the NVuc anchor
const SECTION_ENTRY_SIZE = 32;
const GL_FRAME_PREFIX = 0x24;           // record header inside a .bin, before the frame

/** SM70+ encodes one instruction per 16 bytes. Everything downstream assumes it. */
const INSTRUCTION_BYTES = 16;

const SKIP_REASONS = {
  unreadable: 'cache file(s) held open by the driver and skipped - often the most recently ' +
    'written shard, so the newest objects may be invisible',
  short_decode: 'frame(s) decoded shorter than their declared content size - a truncated or ' +
    'concurrently-rewritten cache file',
  bad_microcode_section: 'object(s) whose microcode section was empty or ran past the end of ' +
    'the decompressed payload - the signature of a container-layout change; try scan mode'
};

function bump(stats, key) {
  if (stats) stats[key] = (stats[key] || 0) + 1;
}

/** One line per non-zero skip reason; empty when the sweep was clean. */
function describeSkips(stats) {
  return Object.keys(SKIP_REASONS)
    .filter(k => stats && stats[k])
    .map(k => `${stats[k]} ${SKIP_REASONS[k]}`);
}

// --------------------------------------------------------------------------- GLCache index

/**
 * [{offset, size}] from a `.toc`, honouring the version's entry stride.
 *
 * v4 widened the offset/size fields to 64 bits. Both versions occur in one cache directory,
 * so the stride cannot be assumed. Offsets are bounds-checked before leaving BigInt: a
 * corrupt table would otherwise produce a nonsense slice, and `Buffer.subarray` clamps
 * silently rather than throwing.
 */
function readTocEntries(toc, blobSize = Number.MAX_SAFE_INTEGER) {
  if (!toc || toc.length < 0x20 || !toc.subarray(0, 4).equals(TOC_MAGIC)) return [];
  const version = toc.readUInt32LE(4);
  const wide = version >= 0x00040000;
  const stride = wide ? 32 : 24;

  const out = [];
  for (let at = 0x20; at + stride <= toc.length; at += stride) {
    const p = at + 16;                                   // past the 16-byte key
    let offset;
    let size;
    if (wide) {
      const o = toc.readBigUInt64LE(p);
      const s = toc.readBigUInt64LE(p + 8);
      if (o > BigInt(Number.MAX_SAFE_INTEGER) || s > BigInt(Number.MAX_SAFE_INTEGER)) continue;
      offset = Number(o);
      size = Number(s);
    } else {
      offset = toc.readUInt32LE(p);
      size = toc.readUInt32LE(p + 4);
    }
    if (!size || offset >= blobSize) continue;
    out.push({ offset, size });
  }
  return out;
}

/** The written prefix of a preallocated DXCache bucket, or null if this is not one. */
function dxLivePrefix(buf) {
  if (!buf || buf.length < 0x40 || !buf.subarray(0, 4).equals(NVPH_MAGIC)) return null;
  const declared = buf.readBigUInt64LE(8);
  let used = declared > BigInt(Number.MAX_SAFE_INTEGER) ? 0 : Number(declared);
  if (used === 0 || used > buf.length) used = buf.length;   // the header lied
  return buf.subarray(0, used);
}

// --------------------------------------------------------------------------- NVuc object

/**
 * {anchor, sections} for a decompressed NVuc object, or null if it is not one.
 *
 * Validity is decided by structure, not by the magic constant: the first live section must
 * start exactly where the section table ends. That survives a driver changing the header
 * while still rejecting the false positives a bare 4-byte magic search turns up.
 *
 * Note the sections do NOT tile the object - measured on real GLCache objects they are
 * alignment-padded (gaps of 8 and 12 bytes) and interleaved with zero-length entries at
 * off=0. A stricter "each section starts where the last ended" check rejects all of them.
 * Bounds are enforced per section instead, in `sectionData`.
 */
function parseNvuc(payload) {
  const anchor = payload.indexOf(NVUC_MAGIC);
  if (anchor < 0 || anchor + SECTION_TABLE_OFFSET > payload.length) return null;

  const count = payload.readUInt16LE(anchor + 8);
  const tableEnd = SECTION_TABLE_OFFSET + count * SECTION_ENTRY_SIZE;
  if (!count || anchor + tableEnd > payload.length) return null;

  const sections = [];
  for (let i = 0; i < count; i++) {
    const at = anchor + SECTION_TABLE_OFFSET + i * SECTION_ENTRY_SIZE;
    // All eight words, not just the three that address a payload. Several section types are
    // typed *slots* rather than sections: they carry their whole value in words 4 and 5 and
    // leave `len` at zero, so anything that reaches them through `sectionData` - which needs
    // a non-zero length - cannot see them at all. Local memory, shared memory and the driver
    // flag word all live there.
    sections.push({
      type: payload.readUInt32LE(at),
      len: payload.readUInt32LE(at + 4),
      off: payload.readUInt32LE(at + 8),
      w3: payload.readUInt32LE(at + 12),
      w4: payload.readUInt32LE(at + 16),
      w5: payload.readUInt32LE(at + 20),
      w6: payload.readUInt32LE(at + 24),
      w7: payload.readUInt32LE(at + 28)
    });
  }

  const live = sections.filter(s => s.len);
  if (!live.length || live[0].off !== tableEnd) return null;
  return { anchor, sections };
}

/**
 * The largest section of type `type`, carved ANCHOR-RELATIVE, or null.
 *
 * A declared extent that escapes the payload returns null rather than a short carve. This is
 * the one failure mode that could otherwise pass `validate`: in DXCache the anchor is 0 and
 * every microcode offset is a multiple of 16, so a payload truncated on a block boundary
 * yields a shortfall that is *also* a multiple of 16. A loud miss beats plausible-looking
 * wrong instructions.
 */
function sectionData(payload, anchor, sections, type) {
  let best = null;
  for (const s of sections) {
    if (s.type === type && s.len && (best === null || s.len > best.len)) best = s;
  }
  if (best === null) return null;

  const start = anchor + best.off;
  const end = start + best.len;
  if (start < 0 || end > payload.length) return null;
  return payload.subarray(start, end);
}

/**
 * The first section-table entry of a given type, whether or not it addresses any payload.
 *
 * Separate from `sectionData` because the types worth reading this way have `len == 0` - the
 * value is in the entry itself.
 */
function sectionEntry(sections, type) {
  return sections.find(s => s.type === type) || null;
}

/**
 * What the container says about a shader, beyond its code.
 *
 * All of it is reverse-engineered, so each field below records how far it has been checked.
 * Measured across 10,950 objects from both caches on driver 596.72 / SM86:
 *
 *   stage      u32 at anchor+0x10, low half. Present and non-zero on every object, and
 *              agrees with an independent classifier built from the instruction mix on all
 *              8,068 that could be classified both ways - including 19 stubs too small for
 *              the instruction-based rule to judge. The high half is always 0x0002.
 *   registers  section 0x03, `{u32 count; u32 cap}`. Present on every object. `count` was
 *              never below the highest register the disassembly actually uses.
 *   local      section 0x15, word 4. Its presence is a perfect predictor of LDL/STL in the
 *              code (no misses, no false alarms), and the value matches the highest static
 *              local offset exactly wherever that can be computed.
 *   shared     section 0x3c, word 5. Reliable where present, but effectively Vulkan/GL only -
 *              see `sharedNote` for why absence must not be read as zero.
 */
const SECTION_REGISTERS = 0x03;
const SECTION_LOCAL_MEM = 0x15;
const SECTION_SHARED_MEM = 0x3c;
const SECTION_PROGRAM_HEADER = 0x2d;

const STAGE_NAMES = {
  1: 'vertex', 2: 'pixel', 5: 'compute', 6: 'hull', 7: 'domain'
};

const STAGE_LABELS = {
  vertex: 'VS', pixel: 'PS', compute: 'CS', hull: 'HS', domain: 'DS'
};

function readMetadata(payload, anchor, sections) {
  const meta = {
    stage: null, stageCode: null, registers: null, registerCap: null,
    localBytes: null, sharedBytes: null, killsPixels: null
  };

  if (anchor + 0x14 <= payload.length) {
    const code = payload.readUInt32LE(anchor + 0x10) & 0xffff;
    meta.stageCode = code;
    meta.stage = STAGE_NAMES[code] || null;
  }

  const regs = sectionEntry(sections, SECTION_REGISTERS);
  if (regs && regs.len >= 8 && anchor + regs.off + 8 <= payload.length) {
    meta.registers = payload.readUInt32LE(anchor + regs.off);
    meta.registerCap = payload.readUInt32LE(anchor + regs.off + 4);
  }

  const local = sectionEntry(sections, SECTION_LOCAL_MEM);
  if (local) meta.localBytes = local.w4;

  const shared = sectionEntry(sections, SECTION_SHARED_MEM);
  if (shared) meta.sharedBytes = shared.w5;

  // Bit 15 of the shader program header's first word. Checked against the KILL instruction
  // on 7,809 graphics objects with no disagreement either way. Compute objects have no
  // program header, hence the null.
  const sph = sectionEntry(sections, SECTION_PROGRAM_HEADER);
  if (sph && sph.len >= 4 && anchor + sph.off + 4 <= payload.length) {
    meta.killsPixels = !!(payload.readUInt32LE(anchor + sph.off) & (1 << 15));
  }

  return meta;
}

/** A short human summary of a shader's metadata, for a list row. */
function describeMetadata(meta) {
  if (!meta) return '';
  const parts = [];
  if (meta.stage) parts.push(STAGE_LABELS[meta.stage] || meta.stage);
  if (meta.registers !== null) parts.push(`${meta.registers} regs`);
  if (meta.localBytes) parts.push(`${meta.localBytes} B local`);
  if (meta.sharedBytes) parts.push(`${meta.sharedBytes} B shared`);
  return parts.join('  ·  ');
}

/**
 * How to talk about shared memory, which is the one field that cannot be read as a number.
 *
 * The section carrying it is effectively Vulkan/GL only: of the compute objects that clearly
 * use shared memory, the D3D12 ones simply have no such section. Printing "0 B" for those
 * would be a plain falsehood, so absence and zero have to stay distinguishable, and the
 * instruction mix is what tells them apart.
 *
 * @param {?number} sharedBytes  from the container, or null when the section is absent
 * @param {?boolean} usesShared  whether the disassembly contains shared-memory accesses
 */
function sharedNote(sharedBytes, usesShared) {
  if (sharedBytes !== null && sharedBytes !== undefined) return `${sharedBytes} bytes`;
  if (usesShared) return 'used, but this cache does not record the size';
  if (usesShared === false) return '0 bytes (no shared-memory access in the code)';
  return 'not recorded';
}

/** Structural warnings about a carved object; empty when it looks right. */
function validate(microcode) {
  const problems = [];
  if (!microcode || microcode.length === 0) {
    problems.push('empty microcode section');
    return problems;
  }
  if (microcode.length % INSTRUCTION_BYTES !== 0) {
    problems.push(
      `microcode is ${microcode.length} bytes, not a multiple of ${INSTRUCTION_BYTES} - the ` +
      'carve is wrong (a partial trailing instruction usually means an off-by-N section offset)');
  }
  return problems;
}

function objectFromPayload(payload, source, offset, backend, stats) {
  const parsed = parseNvuc(payload);
  if (!parsed) return null;

  const { anchor, sections } = parsed;
  const microcode = sectionData(payload, anchor, sections, SECTION_MICROCODE);
  if (!microcode || !microcode.length) {
    // An NVuc header parsed but its microcode section did not: either empty, or its declared
    // extent escapes the payload. Counted, because this is the signature of a container
    // change and would otherwise present as "the cache is empty".
    bump(stats, 'bad_microcode_section');
    return null;
  }

  const rawName = sectionData(payload, anchor, sections, SECTION_ENTRY_NAME);
  let name = null;
  if (rawName) {
    const nul = rawName.indexOf(0);
    name = (nul < 0 ? rawName : rawName.subarray(0, nul)).toString('ascii').trim() || null;
  }

  return {
    source,
    offset,
    backend,
    name,
    microcode,
    codeBytes: microcode.length,
    instructions: Math.floor(microcode.length / INSTRUCTION_BYTES),
    sha1: crypto.createHash('sha1').update(microcode).digest('hex'),
    metadata: readMetadata(payload, anchor, sections),
    warnings: validate(microcode)
  };
}

// --------------------------------------------------------------------------- sweeps

/**
 * The frames to try in one file, as {offset, end} - `end` is a bound from the index when
 * there is one, null when the frame was found by scanning.
 */
function planFrames(buf, { backend, toc, scan }) {
  if (backend === 'vk' && toc && !scan) {
    const frames = [];
    for (const { offset, size } of readTocEntries(toc, buf.length)) {
      const at = offset + GL_FRAME_PREFIX;
      if (at + 4 > buf.length) continue;
      if (buf[at] !== 0x28 || buf[at + 1] !== 0xb5 ||
          buf[at + 2] !== 0x2f || buf[at + 3] !== 0xfd) continue;
      // `size` is measured from the end of a 32-byte prefix but the frame starts at 0x24,
      // so the frame ends at off+32+size - 32 bytes past the obvious off+size.
      frames.push({ offset: at, end: Math.min(offset + 32 + size, buf.length) });
    }
    return frames;
  }
  return frameOffsets(buf).map(offset => ({ offset, end: null }));
}

/**
 * Every parseable object in one cache file.
 *
 * `tick` is awaited between frames so a sweep of a 167 MB shard does not wedge the extension
 * host, and `isCancelled` is checked at the same points. Microcode buffers are dropped
 * unless `keepMicrocode` is set: an enumeration keeps only identity and metadata, and the
 * one object the user picks is re-carved by `carveAt`.
 *
 * @param {Buffer} buf              the whole file (DXCache callers pass the live prefix)
 * @param {object} opts
 * @param {string} opts.source      path, recorded on each object
 * @param {string} opts.backend     'vk' (GLCache), 'dx' (DXCache) or 'raw' (any blob)
 * @param {?Buffer} opts.toc        the sibling `.toc`, when there is one
 * @param {boolean} opts.scan       ignore the index and find frames by magic
 * @param {number} opts.minCode     drop objects with less microcode than this
 */
async function enumerateObjects(buf, opts = {}) {
  const {
    source = '<buffer>', backend = 'raw', toc = null, scan = false, minCode = 0,
    keepMicrocode = false, tick = null, isCancelled = null, onProgress = null
  } = opts;

  const stats = {};
  const objects = [];
  const frames = planFrames(buf, { backend, toc, scan });
  // A scan hits frames that no index vouched for, so its failures are not reportable: a
  // false-positive magic hit is not a truncated frame, and counting them would report a
  // healthy cache as damaged. An indexed sweep's failures are real and get counted.
  const indexed = backend === 'vk' && !!toc && !scan;

  for (let i = 0; i < frames.length; i++) {
    if (isCancelled && isCancelled()) break;
    if (tick && (i & 0x1f) === 0) await tick(i, frames.length, objects.length);
    if (onProgress && (i & 0x1f) === 0) onProgress(i, frames.length, objects.length);

    const { offset, end } = frames[i];
    const fcs = frameContentSize(buf, offset);

    // The microcode is a subset of the payload, so a payload below the floor cannot hold a
    // large enough object - a few bytes of header parsing instead of a full decode.
    if (fcs !== null && fcs < minCode) continue;
    // A frame may legally omit its content size (streaming compression does), but on a magic
    // scan that is also what a false positive inside compressed data looks like. GLCache has
    // no false positives, so keep those; DXCache does, so drop them.
    if (fcs === null && backend === 'dx') continue;

    const window = end !== null ? end
      : (fcs !== null ? Math.min(buf.length, offset + 2 * fcs + 8192) : null);

    const payload = decodeFrame(buf, offset, window, fcs);
    if (!payload) {
      if (indexed) bump(stats, 'short_decode');
      continue;
    }

    const obj = objectFromPayload(payload, source, offset, backend, indexed ? stats : null);
    if (!obj || obj.codeBytes < minCode) continue;
    if (!keepMicrocode) obj.microcode = null;
    objects.push(obj);
  }

  return { objects, stats, frames: frames.length };
}

/** Re-decode and carve a single known frame - what the enumeration deliberately threw away. */
function carveAt(buf, offset, { source = '<buffer>', backend = 'raw' } = {}) {
  const fcs = frameContentSize(buf, offset);
  const window = fcs !== null ? Math.min(buf.length, offset + 2 * fcs + 8192) : null;
  const payload = decodeFrame(buf, offset, window, fcs);
  if (!payload) return null;
  return objectFromPayload(payload, source, offset, backend, null);
}

module.exports = {
  TOC_MAGIC,
  NVPH_MAGIC,
  NVUC_MAGIC,
  SECTION_MICROCODE,
  SECTION_ENTRY_NAME,
  INSTRUCTION_BYTES,
  SKIP_REASONS,
  STAGE_NAMES,
  STAGE_LABELS,
  readTocEntries,
  dxLivePrefix,
  parseNvuc,
  sectionData,
  sectionEntry,
  readMetadata,
  describeMetadata,
  sharedNote,
  objectFromPayload,
  planFrames,
  enumerateObjects,
  carveAt,
  validate,
  describeSkips
};
