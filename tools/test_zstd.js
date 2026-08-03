'use strict';

/**
 * Frame framing and container carving, against real zstd frames.
 *
 * The fixtures below are genuine frames produced by the `zstandard` module, base64'd in so
 * the suite needs no data files and no compressor at run time. They cover the header shapes
 * that actually occur in a shader cache: a declared content size, none at all (what
 * streaming compression produces), the biased 2-byte size form, and a content checksum.
 *
 * The behaviour under test is the awkward one: these frames sit *inside* a larger file with
 * unrelated bytes after them, and the decoder has to stop at the right byte.
 *
 *   ELECTRON_RUN_AS_NODE=1 Code.exe tools/test_zstd.js
 */

const path = require('path');
const zstd = require(path.join(__dirname, '..', 'src', 'zstd.js'));
const nvcache = require(path.join(__dirname, '..', 'src', 'nvcache.js'));

let checks = 0;
let failures = 0;

function check(condition, what, detail = '') {
  checks++;
  if (condition) return;
  failures++;
  console.log(`  FAIL  ${what}`);
  if (detail) console.log(`        ${detail}`);
}

function section(title) {
  console.log(`\n${title}`);
}

const FIXTURES = {
  withFcs: 'KLUv/WA8Dq0AAGhOVnVjLXBheWxvYWQtAQAsB39+AQ==',
  noFcs: 'KLUv/QBYrQAAaE5WdWMtcGF5bG9hZC0BACwHf34B',
  small: 'KLUv/WAAAlUIAAQQAAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8gISIjJCUmJygpKissLS4v' +
    'MDEyMzQ1Njc4OTo7PD0+P0BBQkNERUZHSElKS0xNTk9QUVJTVFVWV1hZWltcXV5fYGFiY2RlZmdoaWpr' +
    'bG1ub3BxcnN0dXZ3eHl6e3x9fn+AgYKDhIWGh4iJiouMjY6PkJGSk5SVlpeYmZqbnJ2en6ChoqOkpaan' +
    'qKmqq6ytrq+wsbKztLW2t7i5uru8vb6/wMHCw8TFxsfIycrLzM3Oz9DR0tPU1dbX2Nna29zd3t/g4eLj' +
    '5OXm5+jp6uvs7e7v8PHy8/T19vf4+fr7/P3+/wEAAP0D6poC',
  checksum: 'KLUv/WQ8Dq0AAGhOVnVjLXBheWxvYWQtAQAsB39+AZTAGOs=',
  // Real compressed NVuc objects: four instructions and an entry name, wrapped the way
  // GLCache stores them (an 8-byte NVDANVVM prefix ahead of the anchor) and the way DXCache
  // does (no prefix). These are what let the sweep be tested end to end - frame to carve -
  // in an environment that has a decompressor but no compressor.
  glObject: 'KLUv/SC3VQIAlANOVkRBTlZWTU5WdWMAAAAAAgABAAAAQAAAAGAAIQAAAA8AAACgAAQGAABldmFsR3' +
    'JpZFRleAAAAAAGAIAAZIcHJACcCCiIAsI=',
  dxObject: 'KLUv/SCvFQIAFANOVnVjAAAAAAIAAQAAAEAAAABgACEAAAAPAAAAoAAEBgAAZXZhbEdyaWRUZXgAAA' +
    'AABgCAAGSHByQAnAgoSAFI'
};

/** sha1 of the microcode inside the object fixtures - identity, as the pipeline defines it. */
const OBJECT_SHA1 = '853789b137bf260632679e86d08cdb8518a5f771';

const frame = Object.fromEntries(
  Object.entries(FIXTURES).map(([k, v]) => [k, Buffer.from(v, 'base64')]));

const PAYLOAD = Buffer.from('NVuc-payload-'.repeat(300));
const SMALL = Buffer.concat(Array.from({ length: 3 }, () => Buffer.from(Array.from({ length: 256 }, (_, i) => i))));

/** Put a frame inside a bigger buffer, with junk on both sides - the real situation. */
function embed(f, { before = 64, after = 4096 } = {}) {
  const lead = Buffer.alloc(before, 0xa5);
  const trail = Buffer.alloc(after);
  for (let i = 0; i < after; i++) trail[i] = (i * 37) & 0xff;   // not zeros: zeros are easy
  return { buf: Buffer.concat([lead, f, trail]), offset: before };
}

/* ------------------------------------------------------ 1. frame header --- */

section('1. Frame header');

check(zstd.frameContentSize(frame.withFcs, 0) === PAYLOAD.length,
  'a declared content size is read without decoding',
  String(zstd.frameContentSize(frame.withFcs, 0)));

check(zstd.frameContentSize(frame.noFcs, 0) === null,
  'a frame that declares no content size reports null, not zero',
  String(zstd.frameContentSize(frame.noFcs, 0)));

// The 2-byte form stores size-256. Reading it without the bias understates every payload
// between 256 and 65791 bytes, which is most small shader objects.
check(zstd.frameContentSize(frame.small, 0) === SMALL.length,
  'the 2-byte content size is un-biased by +256',
  `${zstd.frameContentSize(frame.small, 0)} != ${SMALL.length}`);

check(zstd.frameHeader(frame.checksum, 0).checksum === true &&
      zstd.frameHeader(frame.withFcs, 0).checksum === false,
  'the content-checksum flag is read from the descriptor');

check(zstd.frameHeader(Buffer.from('deadbeefdeadbeef', 'hex'), 0) === null,
  'bytes that are not a frame header are rejected');

{
  // The reserved bit is how a garbage magic hit gives itself away cheaply.
  const bad = Buffer.from(frame.withFcs);
  bad[4] |= 0x08;
  check(zstd.frameHeader(bad, 0) === null, 'a set reserved bit rejects the header');
}

check(zstd.frameContentSize(frame.withFcs.subarray(0, 5), 0) === null,
  'a header truncated mid-field reports null instead of reading past the end');

/* -------------------------------------------------------- 2. frame end ---- */

section('2. Finding the frame end by walking blocks');

for (const [name, f] of Object.entries(frame)) {
  const { buf, offset } = embed(f);
  check(zstd.frameCompressedEnd(buf, offset) === offset + f.length,
    `the ${name} frame's end is found exactly, with 4 KB of junk after it`,
    `${zstd.frameCompressedEnd(buf, offset)} != ${offset + f.length}`);
}

{
  // A frame cut short by the end of the live prefix must not report a plausible end.
  const truncated = frame.withFcs.subarray(0, frame.withFcs.length - 6);
  check(zstd.frameCompressedEnd(truncated, 0) === null,
    'a truncated frame has no findable end');
}

/* ------------------------------------------------------- 3. decoding ------ */

section('3. Decoding a frame embedded in a larger file');

for (const [name, expected] of [['withFcs', PAYLOAD], ['noFcs', PAYLOAD],
  ['small', SMALL], ['checksum', PAYLOAD]]) {
  const f = frame[name];
  const { buf, offset } = embed(f);
  const fcs = zstd.frameContentSize(buf, offset);
  const decoded = zstd.decodeFrame(buf, offset, null, fcs);
  check(decoded && decoded.equals(expected),
    `the ${name} frame decodes to its exact payload despite trailing bytes`,
    decoded ? `${decoded.length} bytes, expected ${expected.length}` : 'null');
}

{
  // The reason the block walk exists: hand fzstd a frame plus slack and it throws away the
  // payload it had already decoded. This asserts the wrapper does not have that behaviour.
  const { buf, offset } = embed(frame.withFcs, { after: 512 });
  const naive = zstd.decodeExact(buf, offset, buf.length);
  check(naive === null, 'decoding a frame together with its trailing bytes fails outright');
  check(zstd.decodeFrame(buf, offset, buf.length, PAYLOAD.length).equals(PAYLOAD),
    'but decodeFrame still recovers the payload from the same buffer');
}

{
  // A window bound that is too tight yields a SHORT payload rather than an error, so the
  // declared size is the only thing that catches it.
  const { buf, offset } = embed(frame.withFcs);
  const tight = zstd.decodeFrame(buf, offset, offset + 12, PAYLOAD.length);
  check(tight && tight.equals(PAYLOAD),
    'a too-tight window bound is retried against the whole tail, not accepted short');
}

{
  const junk = Buffer.alloc(4096, 0x5a);
  Buffer.from([0x28, 0xb5, 0x2f, 0xfd]).copy(junk, 100);        // a false-positive magic hit
  check(zstd.decodeFrame(junk, 100, null, null) === null,
    'a bare magic hit inside unrelated data decodes to nothing');
}

section('4. Scanning for frames');

{
  const a = embed(frame.withFcs, { before: 16, after: 0 });
  const b = embed(frame.small, { before: 32, after: 100 });
  const buf = Buffer.concat([a.buf, b.buf]);
  const offsets = zstd.frameOffsets(buf);
  check(offsets.includes(16) && offsets.includes(a.buf.length + 32),
    'both embedded frames are found by magic', JSON.stringify(offsets));
}

/* --------------------------------------------------- 5. GLCache index ----- */

section('5. GLCache table of contents');

/** Build a `.toc` the way the driver writes one, at either version. */
function makeToc(version, entries) {
  const wide = version >= 0x00040000;
  const stride = wide ? 32 : 24;
  const buf = Buffer.alloc(0x20 + entries.length * stride);
  buf.write('CDVN', 0, 'ascii');
  buf.writeUInt32LE(version, 4);
  entries.forEach(({ offset, size }, i) => {
    const at = 0x20 + i * stride + 16;                            // past the 16-byte key
    if (wide) {
      buf.writeBigUInt64LE(BigInt(offset), at);
      buf.writeBigUInt64LE(BigInt(size), at + 8);
    } else {
      buf.writeUInt32LE(offset, at);
      buf.writeUInt32LE(size, at + 4);
    }
  });
  return buf;
}

// v3 and v4 both occur in one cache directory, and a freshly created cache is written as v3
// - so a reader that only knows the 32-byte stride silently finds nothing in it.
for (const version of [0x00030000, 0x00040000]) {
  const entries = [{ offset: 0x100, size: 0x2000 }, { offset: 0x4000, size: 0x800 }];
  const read = nvcache.readTocEntries(makeToc(version, entries));
  check(JSON.stringify(read) === JSON.stringify(entries),
    `a v${version >>> 16} table of contents reads at its own stride`, JSON.stringify(read));
}

check(nvcache.readTocEntries(makeToc(0x00040000, [{ offset: 0x100, size: 0 }])).length === 0,
  'zero-size entries are skipped');

check(nvcache.readTocEntries(Buffer.alloc(0x40)).length === 0,
  'a table of contents without the CDVN magic yields nothing');

{
  // A corrupt 64-bit offset must be dropped, not turned into a nonsense slice - Buffer
  // clamps silently, so an unchecked value would carve garbage rather than fail.
  const toc = makeToc(0x00040000, [{ offset: 0x100, size: 0x10 }]);
  toc.writeBigUInt64LE(0xffffffffffffff00n, 0x20 + 16);
  check(nvcache.readTocEntries(toc, 0x10000).length === 0,
    'an offset past the end of the blob is dropped');
}

/* ------------------------------------------------- 6. DXCache prefix ------ */

section('6. DXCache live prefix');

function makeNvph(used, size) {
  const buf = Buffer.alloc(size);
  buf.write('nvph', 0, 'ascii');
  buf.writeBigUInt64LE(BigInt(used), 8);
  return buf;
}

check(nvcache.dxLivePrefix(makeNvph(1024, 65536)).length === 1024,
  'the live prefix of a preallocated bucket is honoured');

// Observed in the wild: 4,294,979,901 declared inside a 65,536-byte file.
check(nvcache.dxLivePrefix(makeNvph(4294979901, 65536)).length === 65536,
  'a usedBytes value larger than the file falls back to the whole bucket');

check(nvcache.dxLivePrefix(makeNvph(0, 4096)).length === 4096,
  'a zero usedBytes falls back to the whole bucket');

check(nvcache.dxLivePrefix(Buffer.alloc(4096)) === null,
  'a file without the nvph magic is not a DXCache bucket');

/* ---------------------------------------------------- 7. NVuc carving ----- */

section('7. NVuc object carving');

/**
 * Build an NVuc object the way both caches store one. `prefixLen` is 8 for GLCache (an
 * NVDANVVM prefix ahead of the anchor) and 0 for DXCache - the anchor-relative rule is what
 * makes one reader cover both.
 */
function makeNvuc(sections, prefixLen = 8) {
  const tableEnd = 0x20 + sections.length * 32;
  let at = tableEnd;
  const placed = sections.map(s => {
    const entry = { type: s.type, len: s.data.length, off: at, data: s.data };
    at += s.data.length;
    return entry;
  });
  const body = Buffer.alloc(prefixLen + at);
  body.write('NVDANVVM', 0, 'ascii');
  body.write('NVuc', prefixLen, 'ascii');
  body.writeUInt16LE(sections.length, prefixLen + 8);
  placed.forEach((s, i) => {
    const e = prefixLen + 0x20 + i * 32;
    body.writeUInt32LE(s.type, e);
    body.writeUInt32LE(s.len, e + 4);
    body.writeUInt32LE(s.off, e + 8);
    s.data.copy(body, prefixLen + s.off);
  });
  return body;
}

const microcode = Buffer.alloc(64);
for (let i = 0; i < 4; i++) microcode.writeBigUInt64LE(BigInt(i) << 41n, i * 16 + 8);
const entryName = Buffer.from('evalGridTex\0\0\0\0', 'ascii');

for (const prefixLen of [8, 0]) {
  const payload = makeNvuc([
    { type: 0x01, data: microcode },
    { type: 0x21, data: entryName }
  ], prefixLen);
  const obj = nvcache.objectFromPayload(payload, 'test.bin', 0, 'vk', null);
  check(!!obj, `an object with a ${prefixLen}-byte prefix parses`);
  if (obj) {
    check(obj.microcode.equals(microcode),
      `the microcode carves anchor-relative with a ${prefixLen}-byte prefix`,
      `${obj.codeBytes} bytes`);
    check(obj.name === 'evalGridTex', 'the entry name stops at its NUL', String(obj.name));
    check(obj.instructions === 4, 'the instruction count is bytes/16', String(obj.instructions));
    check(obj.warnings.length === 0, 'a clean carve raises no warnings',
      JSON.stringify(obj.warnings));
  }
}

{
  // The off-by-8 that anchor-relative addressing exists to prevent: it truncates the last
  // instruction, and the result is still a multiple of 16, so nothing downstream notices.
  const payload = makeNvuc([{ type: 0x01, data: microcode }], 8);
  const obj = nvcache.objectFromPayload(payload, 'test.bin', 0, 'vk', null);
  check(obj && obj.codeBytes === microcode.length,
    'the carve is not short by the prefix length',
    obj ? `${obj.codeBytes} != ${microcode.length}` : 'null');
}

{
  // Structural validity, not the magic, is what rejects a scan false positive.
  const payload = makeNvuc([{ type: 0x01, data: microcode }], 8);
  payload.writeUInt32LE(0x400, 8 + 0x20 + 8);                   // move the first section
  check(nvcache.parseNvuc(payload) === null,
    'a first section that does not start at the table end is rejected');
}

{
  // A declared extent past the payload must return nothing rather than a clamped carve: a
  // short carve in DXCache is still a multiple of 16 and would pass validation.
  const payload = makeNvuc([{ type: 0x01, data: microcode }], 0);
  payload.writeUInt32LE(0x8000, 0x20 + 4);                      // len far past the end
  const obj = nvcache.objectFromPayload(payload, 'test.bin', 0, 'dx', null);
  check(obj === null, 'a section running past the payload is refused, not clamped');
}

{
  const stats = {};
  const payload = makeNvuc([{ type: 0x21, data: entryName }], 8);
  nvcache.objectFromPayload(payload, 'test.bin', 0, 'vk', stats);
  check(stats.bad_microcode_section === 1,
    'an object with no microcode section is counted as a skip reason',
    JSON.stringify(stats));
  check(nvcache.describeSkips(stats).length === 1,
    'and is described for the user', JSON.stringify(nvcache.describeSkips(stats)));
}

check(nvcache.validate(Buffer.alloc(24))[0].includes('multiple of 16'),
  'microcode that is not a whole number of instructions is flagged');
check(nvcache.validate(Buffer.alloc(0))[0].includes('empty'),
  'empty microcode is flagged');

/* ------------------------------------------------- 8. end-to-end sweep ---- */

section('8. End-to-end sweep');

/** A .bin the way GLCache writes one: a record header, then the frame, at each entry. */
function makeGlBin(payloads) {
  const zstandardish = payloads.map(p => p);                    // already-compressed frames
  const parts = [];
  const entries = [];
  let at = 0;
  for (const f of zstandardish) {
    const header = Buffer.alloc(0x24, 0x11);
    // `size` is measured from the end of a 32-byte prefix while the frame starts at 0x24.
    entries.push({ offset: at, size: f.length + 4 });
    parts.push(header, f);
    at += header.length + f.length;
  }
  return { blob: Buffer.concat(parts), entries };
}

(async () => {
  // The whole path, on a real compressed object: find the frame, decode it, carve it.
  const { blob, entries } = makeGlBin([frame.glObject, frame.withFcs, frame.small]);
  const toc = makeToc(0x00040000, entries);

  const indexed = await nvcache.enumerateObjects(blob, { source: 'x.bin', backend: 'vk', toc });
  check(indexed.frames === 3, 'the indexed path plans one frame per table entry',
    String(indexed.frames));
  check(indexed.objects.length === 1,
    'only the frame holding an NVuc object produces one', String(indexed.objects.length));
  if (indexed.objects.length === 1) {
    const obj = indexed.objects[0];
    check(obj.sha1 === OBJECT_SHA1, 'the carved microcode has the expected identity', obj.sha1);
    check(obj.name === 'evalGridTex' && obj.instructions === 4 && obj.codeBytes === 64,
      'and the expected metadata', JSON.stringify(obj));
    check(obj.offset === 0x24,
      'the recorded offset is the frame, not the record header', String(obj.offset));
    check(obj.microcode === null,
      'the sweep drops microcode buffers - identity and metadata are all it keeps');
  }

  // The table entry's `size` counts from a 32-byte prefix while the frame starts at 0x24. An
  // implementation that used off+size would bound the frame 32 bytes short and decode nothing.
  check(nvcache.planFrames(blob, { backend: 'vk', toc, scan: false })[0].end
    === entries[0].offset + 32 + entries[0].size,
    'the indexed frame window ends at off+32+size, not off+size');

  const scanned = await nvcache.enumerateObjects(blob, {
    source: 'x.bin', backend: 'vk', toc, scan: true
  });
  check(scanned.objects.length === 1 && scanned.objects[0].sha1 === OBJECT_SHA1,
    'scan mode finds the same object without consulting the table');

  // DXCache stores the same object with no prefix, inside a preallocated bucket.
  {
    const bucket = Buffer.concat([
      makeNvph(0, 0x40), frame.dxObject, Buffer.alloc(4096)
    ]);
    bucket.writeBigUInt64LE(BigInt(0x40 + frame.dxObject.length), 8);
    const live = nvcache.dxLivePrefix(bucket);
    const dx = await nvcache.enumerateObjects(live, { source: 'x.nvph', backend: 'dx' });
    check(dx.objects.length === 1 && dx.objects[0].sha1 === OBJECT_SHA1,
      'the DXCache path carves the same object from a bucket',
      JSON.stringify(dx.objects.map(o => o.sha1)));
  }

  // A magic hit with no declared size is a frame in GLCache and a false positive in DXCache.
  {
    const junk = Buffer.concat([makeNvph(0, 0x40), frame.noFcs, Buffer.alloc(512)]);
    junk.writeBigUInt64LE(BigInt(junk.length), 8);
    const dx = await nvcache.enumerateObjects(nvcache.dxLivePrefix(junk),
      { source: 'x.nvph', backend: 'dx' });
    check(dx.objects.length === 0,
      'DXCache drops frames that declare no content size - that is what its false positives look like');
  }

  // The size floor is applied from the frame header, before any decode.
  const filtered = await nvcache.enumerateObjects(blob, {
    source: 'x.bin', backend: 'vk', toc, minCode: 1000000
  });
  check(filtered.objects.length === 0, 'a size floor rejects everything below it');

  const kept = await nvcache.enumerateObjects(blob, {
    source: 'x.bin', backend: 'vk', toc, keepMicrocode: true
  });
  check(kept.objects[0].microcode && kept.objects[0].microcode.length === 64,
    'keepMicrocode hands the bytes back when the caller wants them');

  const carved = nvcache.carveAt(blob, 0x24, { source: 'x.bin', backend: 'vk' });
  check(carved && carved.sha1 === OBJECT_SHA1 && carved.microcode.length === 64,
    're-carving a single known frame reproduces it exactly',
    carved ? carved.sha1 : 'null');

  let ticks = 0;
  await nvcache.enumerateObjects(blob, {
    source: 'x.bin', backend: 'vk', toc, tick: async () => { ticks++; }
  });
  check(ticks > 0, 'the sweep yields to its caller while it works', String(ticks));

  const cancelled = await nvcache.enumerateObjects(blob, {
    source: 'x.bin', backend: 'vk', toc, isCancelled: () => true
  });
  check(cancelled.objects.length === 0, 'cancellation stops the sweep');

  console.log(`\n${failures ? 'FAIL' : 'PASS'}  ${checks} checks, ${failures} failures`);
  process.exit(failures ? 1 : 0);
})();
