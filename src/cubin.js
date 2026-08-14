'use strict';

/**
 * Read a cubin - the ELF64 container `ptxas` and `nvcc` emit - far enough to get the same
 * thing the cache reader gets: one entry point's raw microcode.
 *
 * That equivalence is the whole point. `nvcache.carveAt` hands `pipeline.disassemble` a
 * buffer of 128-bit instruction words starting at address 0, and everything downstream -
 * `nvdisasm --binary`, the control-code column, the scoreboard scan, the statistics - is
 * built on that shape. A cubin's `.text.<entry>` section is exactly the same shape, so a
 * compiled kernel can travel the existing pipeline unchanged rather than needing a parallel
 * one.
 *
 *     .text.addvec: off=3200 size=512   ->   nvdisasm --binary SM86   ->   /*0000*\/ MOV R1...
 *
 * Verified against ptxas 13.1 output: the section is 16-byte aligned and its addresses start
 * at zero, which is what `ctrl.annotate` requires - it indexes the microcode by
 * `address / 16` and would silently decode the wrong instruction for a section that did not.
 *
 * Only what is needed is decoded. A cubin holds a great deal more (relocations, `.nv.info`
 * attribute streams, the embedded PTX) and none of it is required to disassemble.
 */

const ELF_MAGIC = 0x464c457f;                  // "\x7fELF" little-endian
const EM_CUDA = 190;
const SHT_SYMTAB = 2;
const SHT_NOBITS = 8;

const EHDR = {
  type: 0x10, machine: 0x12, flags: 0x30,
  shoff: 0x28, shentsize: 0x3a, shnum: 0x3c, shstrndx: 0x3e
};

const SHDR_SIZE_MIN = 64;
const TEXT_PREFIX = '.text.';

/** The instruction stride every architecture this extension covers uses. */
const INSTRUCTION_BYTES = 16;

class CubinError extends Error {}

function u16(buf, at) { return buf.readUInt16LE(at); }
function u32(buf, at) { return buf.readUInt32LE(at); }

/**
 * A u64 field read as a Number.
 *
 * Section offsets and sizes are file positions in a cubin that is at most a few megabytes,
 * so they are far inside the safe integer range - but a corrupt or misidentified file could
 * hold anything, and silently truncating a huge value into a plausible offset is exactly how
 * a bad read turns into wrong instructions rather than an error.
 */
function u64(buf, at, what) {
  const value = buf.readBigUInt64LE(at);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new CubinError(`${what} is ${value}, which is not a plausible offset in a cubin`);
  }
  return Number(value);
}

/** A NUL-terminated name out of a string table, without scanning past its end. */
function stringAt(table, at) {
  if (at < 0 || at >= table.length) return '';
  let end = table.indexOf(0, at);
  if (end < 0) end = table.length;
  return table.toString('latin1', at, end);
}

function isElf(buf) {
  return Buffer.isBuffer(buf) && buf.length >= 64 && buf.readUInt32LE(0) === ELF_MAGIC;
}

/**
 * The section table, with each section's name resolved.
 *
 * @returns {Array<{index, name, type, flags, addr, offset, size, link, info, entsize}>}
 */
function sections(buf) {
  if (!isElf(buf)) {
    throw new CubinError('not an ELF file - a cubin starts with the bytes 7f 45 4c 46');
  }
  if (buf[4] !== 2 || buf[5] !== 1) {
    throw new CubinError('not a 64-bit little-endian ELF, which every cubin is');
  }

  const machine = u16(buf, EHDR.machine);
  if (machine !== EM_CUDA) {
    throw new CubinError(
      `ELF machine ${machine}, not ${EM_CUDA} (EM_CUDA) - this is an ELF but not a cubin`);
  }

  const shoff = u64(buf, EHDR.shoff, 'the section table offset');
  const shentsize = u16(buf, EHDR.shentsize);
  const shnum = u16(buf, EHDR.shnum);
  const shstrndx = u16(buf, EHDR.shstrndx);

  if (shentsize < SHDR_SIZE_MIN) {
    throw new CubinError(`section headers are ${shentsize} bytes, too small to be ELF64`);
  }
  if (!shnum || shoff + shnum * shentsize > buf.length) {
    throw new CubinError('the section table extends past the end of the file');
  }

  const read = index => {
    const at = shoff + index * shentsize;
    return {
      index,
      nameOffset: u32(buf, at),
      type: u32(buf, at + 0x04),
      flags: u64(buf, at + 0x08, 'a section flags word'),
      addr: u64(buf, at + 0x10, 'a section address'),
      offset: u64(buf, at + 0x18, 'a section offset'),
      size: u64(buf, at + 0x20, 'a section size'),
      link: u32(buf, at + 0x28),
      info: u32(buf, at + 0x2c),
      entsize: u64(buf, at + 0x38, 'a section entry size')
    };
  };

  let names = Buffer.alloc(0);
  if (shstrndx < shnum) {
    const strtab = read(shstrndx);
    if (strtab.offset + strtab.size <= buf.length) {
      names = buf.subarray(strtab.offset, strtab.offset + strtab.size);
    }
  }

  const out = [];
  for (let i = 0; i < shnum; i++) {
    const s = read(i);
    out.push({ ...s, name: stringAt(names, s.nameOffset) });
  }
  return out;
}

/**
 * The bytes of a section.
 *
 * Never clamped. A section whose extent runs past the end of the file means the file is not
 * what we think it is, and returning the short prefix that happens to be there would hand
 * the disassembler a truncated instruction stream that mostly works - the same failure mode
 * `nvcache.carveAt` refuses for carved microcode, for the same reason.
 */
function sectionData(buf, section) {
  if (section.type === SHT_NOBITS) return null;
  if (section.offset + section.size > buf.length) {
    throw new CubinError(
      `section ${section.name} claims ${section.size} bytes at ${section.offset}, past the ` +
      `end of a ${buf.length}-byte file`);
  }
  return buf.subarray(section.offset, section.offset + section.size);
}

/**
 * The architecture the cubin was built for, from the ELF flags.
 *
 * It is read rather than assumed because a listing that says SM86 while holding SM90 code is
 * worse than one that says nothing: `nvdisasm --binary` decodes to whatever it is told, and
 * decoding the wrong architecture produces plausible-looking wrong instructions.
 *
 * ## The field MOVED between CUDA releases
 *
 * This used to read bits [8,16) unconditionally, which was right for the toolkit it was
 * written against - `0x09005604` is sm_86 there, and the low byte was 4 on every cubin seen.
 * CUDA 12.8 lays it out the other way round. Measured with its own ptxas:
 *
 *     sm_86  e_flags=0x00560556      sm_89  e_flags=0x00560559
 *     sm_90  e_flags=0x0056055a      sm_75  e_flags=0x004b054b
 *
 * The SM number is now the LOW byte; bits [8,16) read 5 on all of them, and bits [16,24) hold
 * the virtual arch the code was compiled from. Reading the old position gave `SM5` for
 * everything, and `nvdisasm --binary SM5` fails outright - which is how this was caught, and
 * is a far better outcome than the silent wrong-architecture decode it could have been.
 *
 * Rather than key on a toolkit version this cannot see, both positions are read and the one
 * holding a PLAUSIBLE SM number wins. The two layouts disambiguate themselves: the field that
 * is not the SM number reads 4 or 5 in either of them, and no real target is below sm_20.
 */
function arch(buf) {
  if (!isElf(buf)) return null;
  const flags = u32(buf, EHDR.flags);
  const plausible = n => n >= 20 && n <= 200;
  const low = flags & 0xff;                       // CUDA 12.8 and later
  const shifted = (flags >>> 8) & 0xff;           // earlier toolkits
  const sm = plausible(low) ? low : (plausible(shifted) ? shifted : 0);
  return sm ? `SM${sm}` : null;
}

/**
 * Register count for an entry point.
 *
 * ptxas stores it in the top byte of the `.text` section's `sh_info`, which is what nvdisasm
 * prints as `.sectioninfo @"SHI_REGISTERS=n"`. It is the same number `ptxas -v` reports, and
 * having it from the binary as well as from the compiler's chatter is what lets the banner
 * cross-check the two the way it already does for cache objects.
 */
function registersOf(section) {
  const n = (section.info >>> 24) & 0xff;
  return n || null;
}

/**
 * Every entry point in a cubin, as records shaped like the ones `nvcache` produces.
 *
 * The `.text.<name>` convention is ptxas's own and is how nvdisasm itself finds functions;
 * the symbol table is consulted only to confirm the name really is a function, so that a
 * section named like one but holding something else is not offered as a kernel.
 *
 * @returns {Array<{name, microcode, codeBytes, registers, sectionIndex, instructions}>}
 */
function entryPoints(buf) {
  const all = sections(buf);
  const functions = new Set();

  for (const s of all) {
    if (s.type !== SHT_SYMTAB || !s.entsize) continue;
    const data = sectionData(buf, s);
    if (!data) continue;
    const strtab = all[s.link] ? sectionData(buf, all[s.link]) : null;
    if (!strtab) continue;
    for (let at = 0; at + s.entsize <= data.length; at += s.entsize) {
      const type = data[at + 4] & 0xf;                       // STT_FUNC == 2
      if (type !== 2) continue;
      functions.add(stringAt(strtab, u32(data, at)));
    }
  }

  const out = [];
  for (const s of all) {
    if (!s.name.startsWith(TEXT_PREFIX) || !s.size) continue;
    const name = s.name.slice(TEXT_PREFIX.length);
    // A `.text.x` with no matching STT_FUNC symbol is not something to disassemble as a
    // kernel. In practice ptxas always emits both; a cubin that disagrees is not understood.
    if (functions.size && !functions.has(name)) continue;

    const microcode = sectionData(buf, s);
    if (!microcode) continue;
    if (microcode.length % INSTRUCTION_BYTES !== 0) {
      throw new CubinError(
        `${s.name} is ${microcode.length} bytes, not a whole number of ` +
        `${INSTRUCTION_BYTES}-byte instructions - the section is not raw microcode`);
    }

    out.push({
      name,
      // Copied, not a subarray: the caller keeps this long after the cubin buffer should have
      // been collected, and a subarray pins the whole file the way a DXCache prefix does.
      microcode: Buffer.from(microcode),
      codeBytes: microcode.length,
      instructions: microcode.length / INSTRUCTION_BYTES,
      registers: registersOf(s),
      sectionIndex: s.index
    });
  }

  // Largest first, matching how the browser orders shader objects in a cache file.
  return out.sort((a, b) => b.codeBytes - a.codeBytes || a.name.localeCompare(b.name));
}

module.exports = {
  CubinError,
  INSTRUCTION_BYTES,
  isElf,
  sections,
  sectionData,
  arch,
  registersOf,
  entryPoints
};
