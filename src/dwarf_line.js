'use strict';

/**
 * Reading a DWARF 5 line table out of an AMD code object.
 *
 * This is what makes source correlation possible on the AMD road, and it exists as hand-written
 * code for a reason that is worth stating plainly: **there is no off-the-shelf consumer that
 * can read this file.**
 *
 * ## Why the bundled tools cannot do it
 *
 * RGA ships `llvm-objdump`, which would ordinarily do this in one flag. It cannot here.
 * amdllpc emits several compile units - one per hardware stage - but a single undersized
 * `.debug_str_offsets` contribution, so llvm-objdump fails with
 *
 *     error: invalid reference to or invalid content in .debug_str_offsets[.dwo]:
 *            insufficient space for 32 bit header prefix
 *
 * and annotates only the first unit before giving up: on a two-stage pipeline that means 15
 * vertex instructions and nothing at all for the fragment shader. `--dwarf=decodedline` is
 * rejected outright, and `llvm-dwarfdump` is not shipped at all.
 *
 * `.debug_line` itself is well formed and entirely self-contained - it never needs
 * `.debug_str_offsets` when the file and directory tables use `DW_FORM_line_strp`, which is
 * what amdllpc emits. So the table is readable; only the tool is broken. Four independent
 * decoders written from the DWARF 5 spec agreed row for row on it, which is why this one is
 * confident enough to ship.
 *
 * ## Where the line table comes from
 *
 * Not from `rga.exe`. RGA drives amdllpc with debug info trimmed and offers no way to turn
 * that off, so the extension runs amdllpc a second time itself with
 * `--trim-debug-info=false`. See `src/compile.js`. The resulting `.text` is compared against
 * RGA's byte for byte before any of this is trusted - a line table describing different
 * machine code would be worse than none.
 *
 * ## What it does NOT do
 *
 * Only `.debug_line`. Not `.debug_info`, not variable locations, not types - `slangc -g1`
 * produces `emissionKind: LineTablesOnly` and there is nothing else in there to read.
 */

// ------------------------------------------------------------------------------- ELF

const ELF_MAGIC = 0x464c457f;                  // "\x7fELF" little-endian
const SHT_NOBITS = 8;

/**
 * The section table of an ELF64 little-endian object, as name -> Buffer.
 *
 * Deliberately minimal and local rather than shared with `cubin.js`: that reader is about
 * finding entry points in a cubin and carries CUDA-specific validation, and an AMD code object
 * would fail its `EM_CUDA` check on the first line. Two readers of the same file format is not
 * duplication when they disagree about what a valid file is.
 */
function sections(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 64) return new Map();
  if (buf.readUInt32LE(0) !== ELF_MAGIC) return new Map();
  if (buf[4] !== 2 || buf[5] !== 1) return new Map();          // ELF64, little-endian

  const shoff = Number(buf.readBigUInt64LE(0x28));
  const shentsize = buf.readUInt16LE(0x3A);
  const shnum = buf.readUInt16LE(0x3C);
  const shstrndx = buf.readUInt16LE(0x3E);
  const out = new Map();
  if (!shoff || !shnum || shoff + shnum * shentsize > buf.length) return out;

  const strHeader = shoff + shstrndx * shentsize;
  const strOff = Number(buf.readBigUInt64LE(strHeader + 0x18));
  const strSize = Number(buf.readBigUInt64LE(strHeader + 0x20));
  const strtab = buf.subarray(strOff, strOff + strSize);

  for (let i = 0; i < shnum; i++) {
    const at = shoff + i * shentsize;
    const nameOff = buf.readUInt32LE(at);
    const type = buf.readUInt32LE(at + 4);
    const off = Number(buf.readBigUInt64LE(at + 0x18));
    const size = Number(buf.readBigUInt64LE(at + 0x20));
    let end = strtab.indexOf(0, nameOff);
    if (end < 0) end = strtab.length;
    const name = strtab.toString('utf8', nameOff, end);
    // NOBITS occupies no file space; slicing it would hand back an unrelated neighbour.
    out.set(name, type === SHT_NOBITS ? Buffer.alloc(0) : buf.subarray(off, off + size));
  }
  return out;
}

// ----------------------------------------------------------------------------- DWARF

/** A cursor over a Buffer. The line program is a byte stream, so everything is sequential. */
class Reader {
  constructor(buf, at = 0) {
    this.buf = buf;
    this.at = at;
  }

  get done() { return this.at >= this.buf.length; }

  u8() { return this.buf[this.at++]; }
  i8() { return this.buf.readInt8(this.at++); }
  u16() { const v = this.buf.readUInt16LE(this.at); this.at += 2; return v; }
  u32() { const v = this.buf.readUInt32LE(this.at); this.at += 4; return v; }
  u64() { const v = Number(this.buf.readBigUInt64LE(this.at)); this.at += 8; return v; }

  uleb() {
    let result = 0;
    let shift = 0;
    for (;;) {
      const byte = this.buf[this.at++];
      // Beyond 2^53 the arithmetic stops being exact, but a line number or address that large
      // is a corrupt table rather than a big one, so this is a bound not a limitation.
      result += (byte & 0x7f) * Math.pow(2, shift);
      shift += 7;
      if (!(byte & 0x80)) return result;
    }
  }

  sleb() {
    let result = 0;
    let shift = 0;
    let byte;
    do {
      byte = this.buf[this.at++];
      result += (byte & 0x7f) * Math.pow(2, shift);
      shift += 7;
    } while (byte & 0x80);
    if (byte & 0x40) result -= Math.pow(2, shift);
    return result;
  }

  cstr() {
    let end = this.buf.indexOf(0, this.at);
    if (end < 0) end = this.buf.length;
    const s = this.buf.toString('utf8', this.at, end);
    this.at = end + 1;
    return s;
  }
}

function stringAt(buf, offset) {
  if (!buf || offset >= buf.length) return null;
  let end = buf.indexOf(0, offset);
  if (end < 0) end = buf.length;
  return buf.toString('utf8', offset, end);
}

/** DW_LNCT_*, the content types a directory or file entry can carry. */
const LNCT_PATH = 1;
const LNCT_DIRECTORY_INDEX = 2;

/**
 * One value of a given DW_FORM.
 *
 * Only the forms amdllpc actually emits are decoded exactly; the rest are SKIPPED at the right
 * width and reported as null. That distinction matters: a form this does not understand must
 * not desynchronise the cursor, because everything after it in the entry table would then be
 * garbage that still parses. Throwing on an unknown form would be the other reasonable
 * choice, but a file table entry carrying, say, an MD5 this code does not care about should
 * not cost the whole line table.
 */
function readForm(r, form, strings) {
  switch (form) {
    case 0x08: return r.cstr();                                   // DW_FORM_string
    case 0x1f: return stringAt(strings.lineStr, r.u32());         // DW_FORM_line_strp
    case 0x0e: return stringAt(strings.str, r.u32());             // DW_FORM_strp
    case 0x0b: return r.u8();                                     // DW_FORM_data1
    case 0x05: return r.u16();                                    // DW_FORM_data2
    case 0x06: return r.u32();                                    // DW_FORM_data4
    case 0x07: return r.u64();                                    // DW_FORM_data8
    case 0x0f: return r.uleb();                                   // DW_FORM_udata
    case 0x1e: r.at += 16; return null;                           // DW_FORM_data16 (MD5)
    case 0x09: { const n = r.uleb(); r.at += n; return null; }     // DW_FORM_block
    // The strx family indexes .debug_str_offsets, which amdllpc emits malformed - it is the
    // reason llvm-objdump cannot read these files at all. Skipped at the right width rather
    // than followed, so a table using them degrades to unnamed files instead of to nonsense.
    case 0x1a: r.uleb(); return null;                             // DW_FORM_strx
    case 0x25: r.at += 1; return null;                            // DW_FORM_strx1
    case 0x26: r.at += 2; return null;                            // DW_FORM_strx2
    case 0x27: r.at += 3; return null;                            // DW_FORM_strx3
    case 0x28: r.at += 4; return null;                            // DW_FORM_strx4
    default:
      throw new Error(`unhandled DW_FORM 0x${form.toString(16)} at offset ${r.at}`);
  }
}

/**
 * The directory or file table: a format description, then that many entries.
 *
 * The count is BOUNDED by the bytes left in the section, and that is not defensive
 * programming for its own sake. `uleb` past the end of a Buffer reads `undefined`, which
 * arithmetic turns into 0, so a corrupt count neither throws nor terminates - it just keeps
 * pushing entries. Measured on a hand-corrupted 41-byte `.debug_line` whose only damage was
 * the directory count: 16 million took 1.7 seconds, and larger values ran for 25 seconds and
 * 3.7 GB before V8 gave up. An entry cannot be shorter than one byte, so the bytes remaining
 * are a hard ceiling on how many there can be.
 */
function readEntryTable(r, strings) {
  const formatCount = r.u8();
  const formats = [];
  for (let i = 0; i < formatCount; i++) formats.push([r.uleb(), r.uleb()]);

  const declared = r.uleb();
  const count = Math.min(declared, Math.max(0, r.buf.length - r.at));
  const entries = [];
  for (let i = 0; i < count; i++) {
    if (r.at >= r.buf.length) break;                  // ran out mid-entry
    const entry = { path: null, directory: null };
    for (const [contentType, form] of formats) {
      const value = readForm(r, form, strings);
      if (contentType === LNCT_PATH) entry.path = value;
      else if (contentType === LNCT_DIRECTORY_INDEX) entry.directory = value;
    }
    entries.push(entry);
  }
  return entries;
}

/**
 * Every row of every line-number program in the object.
 *
 * **Every unit, not the first.** amdllpc emits one compile unit per hardware stage plus an
 * artificial one (`spirv.dbg.cu`) with no rows at all. A decoder that stops after the first
 * unit gets the vertex shader and silently reports nothing for the fragment shader - which
 * looks exactly like "this shader has no debug info" rather than like a bug. That is the
 * specific failure llvm-objdump exhibits here.
 *
 * Relocations are deliberately ignored. `.rel.debug_line` is `R_AMDGPU_ABS64` against `.text`
 * whose `sh_addr` is 0, with the addend already in place, so applying them is a no-op - but
 * `decode` ASSERTS that rather than assuming it, because a future toolchain that based `.text`
 * elsewhere would otherwise shift every address silently.
 *
 * @returns {{units: Array, rows: Array<{address, line, column, file, endSequence}>}}
 */
function decode(buf) {
  const secs = sections(buf);
  const line = secs.get('.debug_line');
  if (!line || !line.length) return { units: [], rows: [] };

  const strings = {
    lineStr: secs.get('.debug_line_str') || null,
    str: secs.get('.debug_str') || null
  };

  const units = [];
  const rows = [];
  const r = new Reader(line);

  while (r.at + 4 <= line.length) {
    const unitStart = r.at;
    const unitLength = r.u32();
    if (unitLength === 0xffffffff) {
      throw new Error('64-bit DWARF is not supported; amdllpc emits 32-bit');
    }
    const unitEnd = r.at + unitLength;
    if (unitLength === 0 || unitEnd > line.length) break;

    const version = r.u16();
    if (version !== 5) {
      // Version 4 puts the file table in a different shape entirely. Rather than decode a
      // format this producer does not emit, skip the unit and say so - the caller reports a
      // partial table as no table.
      r.at = unitEnd;
      units.push({ version, rows: [], unsupported: true });
      continue;
    }

    const addressSize = r.u8();
    r.u8();                                              // segment_selector_size
    const headerLength = r.u32();
    const programStart = r.at + headerLength;

    const minInstLength = r.u8();
    const maxOpsPerInst = r.u8() || 1;
    const defaultIsStmt = r.u8();
    const lineBase = r.i8();
    const lineRange = r.u8();
    const opcodeBase = r.u8();
    const standardLengths = [];
    for (let i = 1; i < opcodeBase; i++) standardLengths.push(r.u8());

    const directories = readEntryTable(r, strings);
    const files = readEntryTable(r, strings);

    const unitRows = [];
    r.at = programStart;

    // The line-number program's state machine, DWARF 5 section 6.2.2.
    let state = null;
    const reset = () => {
      state = { address: 0, opIndex: 0, file: 1, line: 1, column: 0, isStmt: !!defaultIsStmt };
    };
    reset();
    const emit = (endSequence = false) => {
      unitRows.push({
        address: state.address,
        line: state.line,
        column: state.column,
        file: state.file,
        isStmt: state.isStmt,
        endSequence
      });
    };
    const advance = operationAdvance => {
      state.address += minInstLength *
        Math.floor((state.opIndex + operationAdvance) / maxOpsPerInst);
      state.opIndex = (state.opIndex + operationAdvance) % maxOpsPerInst;
    };

    while (r.at < unitEnd) {
      const op = r.u8();

      if (op >= opcodeBase) {                              // special opcode
        const adjusted = op - opcodeBase;
        advance(Math.floor(adjusted / lineRange));
        state.line += lineBase + (adjusted % lineRange);
        emit();
        continue;
      }

      if (op === 0) {                                      // extended
        const length = r.uleb();
        const bodyEnd = r.at + length;
        const sub = r.u8();
        if (sub === 0x01) {                                // DW_LNE_end_sequence
          emit(true);
          reset();
        } else if (sub === 0x02) {                         // DW_LNE_set_address
          state.address = addressSize === 8 ? r.u64() : r.u32();
        }
        // DW_LNE_define_file, set_discriminator and vendor extensions carry nothing this
        // needs; the explicit bodyEnd is what makes skipping them safe.
        r.at = bodyEnd;
        continue;
      }

      switch (op) {                                        // standard opcodes
        case 0x01: emit(); break;                          // copy
        case 0x02: advance(r.uleb()); break;               // advance_pc
        case 0x03: state.line += r.sleb(); break;          // advance_line
        case 0x04: state.file = r.uleb(); break;           // set_file
        case 0x05: state.column = r.uleb(); break;         // set_column
        case 0x06: state.isStmt = !state.isStmt; break;    // negate_stmt
        case 0x07: break;                                  // basic_block
        case 0x08:                                         // const_add_pc
          advance(Math.floor((255 - opcodeBase) / lineRange));
          break;
        case 0x09: state.address += r.u16(); state.opIndex = 0; break;   // fixed_advance_pc
        case 0x0a: break;                                  // prologue_end
        case 0x0b: break;                                  // epilogue_begin
        case 0x0c: r.uleb(); break;                        // set_isa
        default:
          // An opcode this build does not know, skipped by its declared argument count. That
          // count is in the header precisely so an unknown opcode is survivable.
          for (let i = 0; i < (standardLengths[op - 1] || 0); i++) r.uleb();
          break;
      }
    }

    // The file table is 0-based in DWARF 5 (entry 0 is the primary source file), unlike
    // version 4 where it was 1-based. Getting this wrong shifts every attribution by one file.
    const nameOf = index => {
      const entry = files[index];
      if (!entry || !entry.path) return null;
      const dir = directories[entry.directory || 0];
      if (!dir || !dir.path || /^([a-zA-Z]:[\\/]|[\\/])/.test(entry.path)) return entry.path;
      const sep = /[\\]/.test(dir.path) ? '\\' : '/';
      return `${dir.path}${sep}${entry.path}`;
    };

    for (const row of unitRows) row.fileName = nameOf(row.file);
    units.push({
      version,
      directories,
      files,
      fileNames: files.map((_, i) => nameOf(i)),
      rows: unitRows
    });
    for (const row of unitRows) rows.push(row);

    r.at = unitEnd;
  }

  rows.sort((a, b) => a.address - b.address);
  return { units, rows };
}

/**
 * Is `.text` addressed as the line table assumes?
 *
 * The addresses in `.debug_line` are relative to `.text` only because its `sh_addr` is zero
 * and the relocations are no-ops. Both were measured true, and both are cheap to check, so
 * they are checked rather than trusted - a toolchain that based `.text` elsewhere would shift
 * every attribution by a constant, which reads as "the correlation is subtly wrong" rather
 * than as "the correlation is missing".
 */
function addressesAreTextRelative(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 64) return false;
  if (buf.readUInt32LE(0) !== ELF_MAGIC) return false;
  const shoff = Number(buf.readBigUInt64LE(0x28));
  const shentsize = buf.readUInt16LE(0x3A);
  const shnum = buf.readUInt16LE(0x3C);
  const shstrndx = buf.readUInt16LE(0x3E);
  // The same bound `sections` applies. Without it the two disagreed on a truncated file:
  // `sections` returned nothing and this threw RangeError reading past the end, so a
  // half-written code object crashed the compile instead of losing the correlation.
  if (!shoff || !shnum || shoff + shnum * shentsize > buf.length) return false;
  if (shstrndx >= shnum) return false;

  const strHeader = shoff + shstrndx * shentsize;
  const strOff = Number(buf.readBigUInt64LE(strHeader + 0x18));
  const strSize = Number(buf.readBigUInt64LE(strHeader + 0x20));
  if (strOff + strSize > buf.length) return false;
  const strtab = buf.subarray(strOff, strOff + strSize);

  for (let i = 0; i < shnum; i++) {
    const at = shoff + i * shentsize;
    const nameOff = buf.readUInt32LE(at);
    let end = strtab.indexOf(0, nameOff);
    if (end < 0) end = strtab.length;
    if (strtab.toString('utf8', nameOff, end) !== '.text') continue;
    return Number(buf.readBigUInt64LE(at + 0x10)) === 0;      // sh_addr
  }
  return false;
}

/**
 * The line table as correlation records: run starts, in address order.
 *
 * Two DWARF facts become two kinds of terminator, and both matter:
 *
 *   - **Line 0 means "no source position here".** It is not line zero of the file. amdllpc
 *     emits it for compiler-generated code - the NGG wrapper a vertex shader is wrapped in,
 *     prologue setup, register shuffling with no expression behind it. Dropping those rows
 *     would silently extend the PREVIOUS line's run over code that shader author never wrote.
 *   - **`end_sequence` closes a stage.** Vertex occupies 0x0-0x198 here and fragment starts at
 *     0x200; without the terminator the vertex shader's last line would swallow the gap and
 *     then collide with the fragment shader's first instruction.
 *
 * Both are emitted as a record with `file` and `line` null, which `positionsFor` reads as
 * "attribute nothing from here". A record and a hole are the same shape so that the walk over
 * them stays a single loop with no special case to forget.
 */
function records(buf) {
  const { rows } = decode(buf);
  const out = [];
  const files = new Map();
  let last = null;

  for (const row of rows) {
    const real = !row.endSequence && row.line > 0 && row.fileName;
    const file = real ? row.fileName : null;
    const line = real ? row.line : null;
    const column = real ? row.column : null;

    // Only a CHANGE of position starts a run. The table emits a row per source position
    // change, but a stage boundary or a run of compiler-generated code can produce several
    // consecutive holes, and recording each would be noise with no consumer.
    if (last && last.file === file && last.line === line) continue;

    if (real) {
      const key = file.toLowerCase();
      if (!files.has(key)) files.set(key, file);
    }
    last = { address: row.address, file: real ? files.get(file.toLowerCase()) : null, line, column };
    out.push(last);
  }

  return { records: out, files: [...files.values()] };
}

/**
 * Attribute real instruction addresses to source positions.
 *
 * The counterpart of `correlate.byAddress`, and separate from it for the reason that function's
 * own comment gives: it walks a run by stepping a fixed stride, and an RDNA instruction is 4, 8
 * or 12 bytes. Stepping by any constant lands between instructions and attributes source lines
 * to addresses no instruction starts at - measured, with a stride of 4 over one real listing:
 * 99 map entries of which 23 were at addresses that do not exist.
 *
 * So this takes the addresses the LISTING actually parsed and asks which run each falls in,
 * which needs no stride and cannot invent an address. Both sequences are sorted, so it is one
 * pass rather than a search per instruction.
 *
 * @param {Array<{address, file, line}>} runs   from `records()`
 * @param {Iterable<number>} addresses          instruction addresses from the parsed listing
 * @returns {Map<number, {file, line, column}>} only addresses with a real position
 */
function positionsFor(runs, addresses) {
  const map = new Map();
  if (!runs || !runs.length) return map;

  const sorted = [...addresses].sort((a, b) => a - b);
  let at = 0;
  for (const address of sorted) {
    while (at + 1 < runs.length && runs[at + 1].address <= address) at++;
    const run = runs[at];
    // Before the first run, or inside a hole: no position. Not a guess, and not line 0.
    if (run.address > address || run.line === null) continue;
    map.set(address, { file: run.file, line: run.line, column: run.column });
  }
  return map;
}

/**
 * The runs that describe one listing, out of a table describing a whole pipeline.
 *
 * A graphics pipeline compiles to ONE code object with every hardware stage in one `.text`,
 * so the line table covers all of them - vertex at 0x0, fragment at 0x200 - while RGA writes
 * one ISA file per stage. Handing the whole table to a single listing put 17 of 47 runs in the
 * fragment shader's banner that belonged to the vertex shader, at addresses that listing does
 * not contain, and inflated its "N runs over M source lines" to match.
 *
 * Per-instruction attribution was never wrong - `positionsFor` only answers about addresses it
 * is given - but the banner is read by people, and a map full of addresses that are not in the
 * listing beneath it is worse than useless.
 *
 * The run covering the first address is kept even though it starts earlier, because that is
 * the run the first instruction is in; it is re-based so the map does not point outside.
 *
 * @param {Array} runs        from `records()`
 * @param {Iterable<number>} addresses  the listing's own instruction addresses
 */
function forListing(runs, addresses) {
  const all = [...addresses];
  if (!runs || !runs.length || !all.length) return [];
  const first = Math.min(...all);
  const last = Math.max(...all);

  const out = [];
  for (const run of runs) {
    if (run.address > last) break;
    if (run.address < first) {
      // Covers the first instruction: keep it, re-based, and let a later run replace it.
      out.length = 0;
      out.push({ ...run, address: first });
      continue;
    }
    out.push(run);
  }
  return out;
}

module.exports = {
  sections,
  decode,
  records,
  positionsFor,
  forListing,
  addressesAreTextRelative
};
