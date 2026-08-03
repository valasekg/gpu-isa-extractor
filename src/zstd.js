'use strict';

/**
 * Just enough zstd framing to pull one frame out of the middle of a cache file.
 *
 * The frames in a shader cache are raw and *followed by unrelated bytes* - the next record
 * header, the next frame, or preallocated zeros. That is the whole difficulty. fzstd's
 * one-shot `decompress` keeps reading after a frame ends, expecting another frame, and
 * throws `invalid zstd data` on whatever it finds there - discarding the payload it had
 * already decoded. So handing it "the frame plus some slack" does not work.
 *
 * The fix is to know exactly where the frame ends before decoding: parse the frame header,
 * then walk the block headers, which carry their own sizes. That costs a few reads per
 * frame, needs no decompression, and doubles as a validity filter - a scan for the 4-byte
 * frame magic across a 256 MB DXCache bucket turns up plenty of false positives inside
 * compressed data, and a bogus block walk runs off the end almost immediately.
 *
 * Frame layout (RFC 8878): magic, Frame_Header_Descriptor, optional Window_Descriptor,
 * optional Dictionary_ID, optional Frame_Content_Size, then blocks - each a 3-byte header
 * (bit 0 last, bits 1-2 type, bits 3+ size) followed by its content - then an optional
 * 4-byte checksum.
 */

const fzstd = require('./vendor/fzstd.js');

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

const FCS_SIZE = [0, 2, 4, 8];
const DID_SIZE = [0, 1, 2, 4];

const BLOCK_RAW = 0;
const BLOCK_RLE = 1;
const BLOCK_COMPRESSED = 2;
const BLOCK_RESERVED = 3;

/**
 * Parse the frame header at `off`.
 *
 * Returns null when this is not a frame header we understand, which is the common case on a
 * false-positive magic hit.
 */
function frameHeader(buf, off) {
  if (off + 5 > buf.length) return null;
  if (buf[off] !== 0x28 || buf[off + 1] !== 0xb5 ||
      buf[off + 2] !== 0x2f || buf[off + 3] !== 0xfd) return null;

  const fhd = buf[off + 4];
  if (fhd & 0x08) return null;                          // reserved bit must be zero

  const singleSegment = (fhd >> 5) & 1;
  const checksum = (fhd >> 2) & 1;
  const fcsSize = FCS_SIZE[fhd >> 6] || (singleSegment ? 1 : 0);
  const didSize = DID_SIZE[fhd & 3];

  const fcsAt = off + 5 + (singleSegment ? 0 : 1) + didSize;
  const end = fcsAt + fcsSize;
  if (end > buf.length) return null;

  let contentSize = null;
  if (fcsSize === 1) contentSize = buf[fcsAt];
  else if (fcsSize === 2) contentSize = buf.readUInt16LE(fcsAt) + 256;   // the 2-byte form is biased
  else if (fcsSize === 4) contentSize = buf.readUInt32LE(fcsAt);
  else if (fcsSize === 8) {
    const big = buf.readBigUInt64LE(fcsAt);
    // A frame claiming more than 2^53 bytes is a false positive, not a frame.
    contentSize = big > BigInt(Number.MAX_SAFE_INTEGER) ? null : Number(big);
  }

  return { headerEnd: end, contentSize, checksum: !!checksum, singleSegment: !!singleSegment };
}

/**
 * Uncompressed size straight from the frame header, without decoding, or null if the frame
 * does not declare one (legal - it is what streaming compression produces).
 *
 * Worth reading first: it rejects an object below a size floor for a few bytes of parsing
 * instead of a full decode, which is the difference between a DXCache sweep taking a second
 * and taking minutes.
 */
function frameContentSize(buf, off) {
  const header = frameHeader(buf, off);
  return header ? header.contentSize : null;
}

/**
 * Byte just past the end of the frame starting at `off`, found by walking block headers, or
 * null if the walk runs off the end or hits a reserved block type.
 */
function frameCompressedEnd(buf, off) {
  const header = frameHeader(buf, off);
  if (!header) return null;

  let p = header.headerEnd;
  for (;;) {
    if (p + 3 > buf.length) return null;
    const h = buf[p] | (buf[p + 1] << 8) | (buf[p + 2] << 16);
    p += 3;

    const last = h & 1;
    const type = (h >> 1) & 3;
    const size = h >>> 3;
    if (type === BLOCK_RESERVED) return null;

    p += type === BLOCK_RLE ? 1 : size;
    if (p > buf.length) return null;
    if (last) break;
  }

  if (header.checksum) p += 4;
  return p <= buf.length ? p : null;
}

/** Decompress exactly `buf[off..end)`, or null if fzstd rejects it. */
function decodeExact(buf, off, end) {
  try {
    const out = fzstd.decompress(new Uint8Array(buf.buffer, buf.byteOffset + off, end - off));
    return out && out.length ? Buffer.from(out.buffer, out.byteOffset, out.length) : null;
  } catch (e) {
    return null;
  }
}

/**
 * Decompress as much of a frame as arrives before fzstd objects to what follows it.
 *
 * The streaming decoder hands over each block as it is decoded, so a frame that is followed
 * by garbage still yields its own content before the throw. Used only when the block walk
 * could not find the frame end.
 */
function decodeStreaming(buf, off, end) {
  const chunks = [];
  try {
    const d = new fzstd.Decompress(chunk => chunks.push(chunk));
    d.push(new Uint8Array(buf.buffer, buf.byteOffset + off, end - off), true);
  } catch (e) {
    // Expected whenever the window ran past the frame; keep whatever decoded first.
  }
  if (!chunks.length) return null;
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = Buffer.allocUnsafe(total);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}

/**
 * One frame at `off` -> payload, or null.
 *
 * The block walk is the fast, exact path. The fallback ladder mirrors the reference Python
 * reader: try a bounded window, then the whole tail, and accept a payload only if it is at
 * least as long as the frame declared. A too-tight window yields a SHORT payload rather than
 * an error - no decoder raises, they simply return fewer bytes - so the declared content
 * size is the only thing that catches it.
 *
 * @param {Buffer} buf    the whole file
 * @param {number} off    frame start
 * @param {?number} end   window hint from a table of contents, or null
 * @param {?number} fcs   declared content size, or null if the frame omits one
 */
function decodeFrame(buf, off, end, fcs) {
  const exactEnd = frameCompressedEnd(buf, off);
  if (exactEnd !== null) {
    const payload = decodeExact(buf, off, exactEnd);
    if (payload && (fcs === null || payload.length >= fcs)) return payload;
  }

  const windows = [];
  if (end !== null && end !== undefined && end < buf.length) windows.push(end);
  windows.push(buf.length);

  for (const window of windows) {
    if (window <= off) continue;
    const payload = decodeExact(buf, off, window) || decodeStreaming(buf, off, window);
    if (payload && payload.length && (fcs === null || payload.length >= fcs)) return payload;
  }
  return null;
}

/** Every offset in `buf` where a zstd frame magic appears. */
function frameOffsets(buf, from = 0) {
  const out = [];
  let pos = from;
  for (;;) {
    const i = buf.indexOf(ZSTD_MAGIC, pos);
    if (i < 0) break;
    out.push(i);
    pos = i + 4;
  }
  return out;
}

module.exports = {
  ZSTD_MAGIC,
  frameHeader,
  frameContentSize,
  frameCompressedEnd,
  decodeFrame,
  decodeExact,
  decodeStreaming,
  frameOffsets
};
