'use strict';

/**
 * Map SASS instructions back to the source lines they came from.
 *
 * `nvdisasm -g` prints a marker before each run of instructions that share a source position:
 *
 *     //## File "C:\\src\\c.slang", line 11
 *     /*0010*\/  S2R R0, SR_CTAID.X ;
 *
 * A marker holds until the next one, so the mapping is a run-length encoding over addresses,
 * not one entry per instruction. That is read here and re-emitted into the generated listing
 * in a shorter form, so a listing that has been saved, mailed or reopened a month later still
 * carries its own correlation - the same reason the banner names its source byte-for-byte.
 *
 * ## What the mapping is, and is not
 *
 * It is the compiler's own record of which source construct an instruction was generated for.
 * It is not a claim that the line "costs" those instructions. Under optimisation the
 * scheduler interleaves independent work, so a single line's instructions are routinely
 * scattered through the listing and a single instruction may serve several lines; the
 * markers below flip back and forth between lines for exactly that reason. Anything built on
 * this has to present a set of addresses per line, never a range, and has to be able to say
 * "these instructions are attributed here" rather than "this line took N instructions".
 *
 * ## Inlining
 *
 * A marker can name a file the user never wrote. Slang emits its CUDA prelude into the
 * generated intermediate, so an instruction from `saturate()` is attributed to the prelude
 * rather than to the shader. Those are kept and labelled rather than dropped: an instruction
 * with no visible provenance is worse than one attributed to a file the reader can be told
 * about. `primary` marks the file the user actually compiled.
 */

const path = require('path');

/** What `nvdisasm -g` prints. The path is C-escaped, so `\\` means one backslash. */
const NVDISASM_MARKER_RE = /^\s*\/\/##\s*File\s+"((?:[^"\\]|\\.)*)"\s*,\s*line\s+(\d+)/;

/** The inline marker form, still written when `correlationStyle` is `inline`. */
const MARKER_RE = /^\s*\/\/##\s+([^\s:][^:]*):(\d+)\s*$/;

/**
 * The banner form, which is the default.
 *
 * Interleaving a marker into the instruction stream puts the correlation where the eye is
 * already looking, and that is exactly the problem: a listing is read for its instructions,
 * and a line of prose every few instructions breaks the column alignment that makes a
 * disassembly scannable. The same information keyed by *address* sits in the banner instead,
 * out of the way, and the editor resolves it per line.
 *
 * Keyed by address rather than by listing line so it survives the banner changing length -
 * a line number would be invalidated by the very block that carries it.
 *
 *     //                @0000 prefix-blur.slang:9
 *
 * The `@` is what keeps this unambiguous against the source-file table in the same banner,
 * whose right-hand side is a Windows path and therefore also contains a colon.
 */
const ADDRESS_MAP_RE = /^\s*\/\/\s+@([0-9a-fA-F]+)\s+(\S+):(\d+)\s*$/;

const ADDRESS_RE = /\/\*([0-9a-fA-F]+)\*\//;

/** `.section .text.name` and the banner rule nvdisasm draws above it. */
const SECTION_RE = /^\s*\.section\s+(\.text\.[^\s,]+)/;
const SECTION_RULE_RE = /^\s*\/\/-+\s+(\.text\.\S+)\s+-+/;

const TEXT_PREFIX = '.text.';

/** Undo the C escaping nvdisasm applies to a path. */
function unescapePath(text) {
  return text.replace(/\\(.)/g, (_, c) => (c === 'n' ? '\n' : c === 't' ? '\t' : c));
}

/**
 * Two paths naming the same file.
 *
 * Every hop in the chain rewrites the path a little - slangc records what it was given,
 * nvrtc records what slangc wrote, and nvdisasm prints a mix of separators (the observed
 * output has `C:\\a\\b/c.slang` in one marker). Comparing normalised, case-folded paths is
 * what makes "is this the file the user compiled?" answerable at all on Windows.
 */
function samePath(a, b) {
  if (!a || !b) return false;
  const norm = p => path.normalize(p).replace(/[\\/]+$/, '').toLowerCase();
  return norm(a) === norm(b);
}

/**
 * Read the source positions out of `nvdisasm -g` output.
 *
 * @param {string} text        `nvdisasm -c -g <cubin>` output, newlines normalised
 * @param {string} [entryName] restrict to one entry point's `.text` section
 * @returns {{entries: Map<string, Array<{address, file, line}>>, files: string[]}}
 *   Each entry's array is ordered by address and holds one record per *change* of source
 *   position, which is how nvdisasm prints it - not one per instruction.
 */
function parse(text, entryName) {
  const entries = new Map();
  const files = new Map();                      // normalised -> as first seen

  let section = null;
  let pending = null;                           // marker seen, awaiting its instructions
  let last = null;                              // last record pushed, to collapse repeats

  let from = 0;
  while (from <= text.length) {
    let end = text.indexOf('\n', from);
    if (end < 0) end = text.length;
    const line = text.slice(from, end);
    from = end + 1;

    const rule = SECTION_RULE_RE.exec(line) || SECTION_RE.exec(line);
    if (rule) {
      section = rule[1].slice(TEXT_PREFIX.length);
      pending = null;
      last = null;
      continue;
    }

    const marker = NVDISASM_MARKER_RE.exec(line);
    if (marker) {
      const file = unescapePath(marker[1]);
      const key = path.normalize(file).toLowerCase();
      if (!files.has(key)) files.set(key, file);
      pending = { file: files.get(key), line: Number(marker[2]) };
      continue;
    }

    if (!section || (entryName && section !== entryName)) continue;

    const addr = ADDRESS_RE.exec(line);
    if (!addr) continue;
    const address = parseInt(addr[1], 16);
    if (!Number.isFinite(address)) continue;

    // Only a change of position is recorded. nvdisasm already prints one marker per run, but
    // a run can be interrupted by a label without the position changing.
    if (pending) {
      if (!last || last.file !== pending.file || last.line !== pending.line) {
        if (!entries.has(section)) entries.set(section, []);
        last = { address, file: pending.file, line: pending.line };
        entries.get(section).push(last);
      }
      pending = null;
    }
  }

  return { entries, files: [...files.values()] };
}

/**
 * Turn the per-entry records into a lookup keyed by instruction address.
 *
 * Records are run starts, so an address between two of them belongs to the earlier one. The
 * expansion is done once here rather than by binary-searching on every cursor move.
 *
 * @param {Array<{address, file, line}>} records
 * @param {number} codeBytes  so the last run can be closed at the end of the code
 * @param {number} [stride]   bytes per instruction.
 *
 * The stride is a parameter rather than a constant because it is only universal within one
 * ISA. A SASS instruction is 16 bytes and every address in a listing is a multiple of it,
 * which is what lets a run be walked by stepping. Where instructions vary in length - RDNA
 * encodes in 4, 8 or 12 - stepping by a fixed amount lands between instructions and attributes
 * a run to addresses that do not exist, so such a target must expand its runs from the
 * addresses it actually parsed rather than call this at all. Keeping the 16 here as a default
 * rather than deleting it is deliberate: the NVIDIA road is the caller, and its stride is a
 * fact about the encoding rather than a value worth threading through five frames.
 */
function byAddress(records, codeBytes, stride = 16) {
  const map = new Map();
  if (!records || !records.length) return map;
  const STRIDE = stride;
  for (let i = 0; i < records.length; i++) {
    const start = records[i].address;
    const stop = i + 1 < records.length ? records[i + 1].address : codeBytes;
    for (let at = start; at < stop; at += STRIDE) {
      map.set(at, { file: records[i].file, line: records[i].line });
    }
  }
  return map;
}

/**
 * The short label a marker carries in a generated listing.
 *
 * The basename, because the full path is repeated on every marker and the observed output is
 * unreadable with it - but disambiguated when two files share one, since silently showing two
 * different files under one name is exactly the kind of invented certainty this extension
 * avoids elsewhere.
 */
function labelsFor(files) {
  const counts = new Map();
  for (const f of files) {
    const base = path.basename(f);
    counts.set(base, (counts.get(base) || 0) + 1);
  }
  const labels = new Map();
  let n = 0;
  for (const f of files) {
    const base = path.basename(f);
    n++;
    labels.set(f, counts.get(base) > 1 ? `${base}#${n}` : base);
  }
  return labels;
}

/**
 * Merge source markers into a listing.
 *
 * The listing is `nvdisasm --binary` output that `ctrl.annotate` has already put a control
 * column into, so this walks it the same way: by the address comment, which *is* the
 * instruction index. Lines without one pass through.
 *
 * Markers are emitted only where the position changes, so a listing gains roughly one line
 * per source construct rather than one per instruction.
 *
 * @returns {{text, marked, lines: number, unattributed: number}}
 */
function annotate(listing, map, { labels } = {}) {
  if (!map || !map.size) {
    return { text: listing, marked: 0, lines: 0, unattributed: 0 };
  }

  const out = [];
  let last = null;
  let marked = 0;
  let unattributed = 0;
  const seen = new Set();

  let from = 0;
  while (from <= listing.length) {
    let end = listing.indexOf('\n', from);
    if (end < 0) end = listing.length;
    const line = listing.slice(from, end);
    from = end + 1;

    const addr = ADDRESS_RE.exec(line);
    if (!addr) { out.push(line); continue; }
    const address = parseInt(addr[1], 16);
    const at = map.get(address);
    if (!at) {
      unattributed++;
      out.push(line);
      continue;
    }

    const key = `${at.file}\u0000${at.line}`;
    if (key !== last) {
      const label = (labels && labels.get(at.file)) || path.basename(at.file);
      // Indented to the address column so the markers read as headings over the runs they
      // introduce rather than as instructions.
      out.push(`        //## ${label}:${at.line}`);
      marked++;
      last = key;
      seen.add(key);
    }
    out.push(line);
  }

  return { text: out.join('\n'), marked, lines: seen.size, unattributed };
}

/**
 * Rewrite one source path to another, everywhere it appears.
 *
 * Compiling an unsaved buffer means compiling a copy in the scratch directory, so every path
 * the toolchain records - `#line` in the generated CUDA, `.loc` in the PTX, the cubin's line
 * table - names that copy. The copy is an implementation detail; the file the user is editing
 * is what the banner claims as the source and what the editor will ask about later. Left
 * unrewritten the two disagree, and correlation silently matches nothing for exactly the
 * case it is most useful in.
 *
 * @param {{entries: Map, files: string[]}} parsed  as returned by `parse`
 * @param {string} from   the path the compiler saw
 * @param {string} to     the path the user has open
 */
function rewriteSource(parsed, from, to) {
  if (!from || !to || samePath(from, to)) return parsed;

  const swap = file => (samePath(file, from) ? to : file);
  const entries = new Map();
  for (const [name, records] of parsed.entries) {
    entries.set(name, records.map(r => ({ ...r, file: swap(r.file) })));
  }
  return { entries, files: parsed.files.map(swap) };
}

/**
 * The banner block for a set of records: one line per run, `@<address> <label>:<line>`.
 *
 * Returned without the `// ` prefix and padding, which `output.banner` owns.
 */
function bannerLines(records, labels) {
  const out = [];
  for (const record of records || []) {
    const label = (labels && labels.get(record.file)) || path.basename(record.file);
    out.push(`@${record.address.toString(16).padStart(4, '0')} ${label}:${record.line}`);
  }
  return out;
}

/**
 * Read the banner's address map back, as run starts ordered by address.
 *
 * @returns {Array<{address, label, line}>}
 */
function readAddressMap(text) {
  const out = [];
  // Walked by hand rather than split: the banner holds one line per run and a large kernel
  // has thousands of them, so there is no line count that is safely "enough". A cap here
  // would not fail loudly - `positionAt` would keep returning the last run it managed to
  // read, and every instruction past the cut would be confidently attributed to the wrong
  // source line. Reading to the first non-comment line has no such ceiling, and splitting
  // the whole document would allocate an array the size of the listing.
  let from = 0;
  while (from < text.length) {
    let end = text.indexOf('\n', from);
    if (end < 0) end = text.length;
    const line = text.slice(from, end);
    from = end + 1;

    // The map lives in the banner; the first line that is not a comment ends it.
    if (!line.startsWith('//')) break;
    const m = ADDRESS_MAP_RE.exec(line);
    if (m) out.push({ address: parseInt(m[1], 16), label: m[2], line: Number(m[3]) });
  }
  return out.sort((a, b) => a.address - b.address);
}

/**
 * The run covering an address: the last run that starts at or before it.
 *
 * Binary search rather than expanding every address into a Map, because the expansion is
 * proportional to the kernel and this is called once per line of a document that can run to
 * half a million lines.
 */
function positionAt(runs, address) {
  let lo = 0;
  let hi = runs.length - 1;
  let found = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (runs[mid].address <= address) { found = runs[mid]; lo = mid + 1; } else hi = mid - 1;
  }
  return found;
}

/**
 * Read markers back out of a listing document.
 *
 * The UI drives off this rather than off anything the compile kept in memory, so correlation
 * works on a listing reopened long after the session that produced it - the same principle as
 * the banner carrying its own provenance.
 *
 * @param {string} text
 * @returns {{byListingLine: Map<number, {label, line}>, bySourceLine: Map<string, number[]>}}
 *   `byListingLine` is 0-based listing line -> source position, filled for every instruction
 *   line under a marker. `bySourceLine` is `label:line` -> the listing lines showing it.
 */
function readMarkers(text) {
  const byListingLine = new Map();
  const bySourceLine = new Map();

  // Both forms are read. The banner map is what is written now; the inline markers are what
  // listings generated before it carry, and a listing on disk outlives the version that made
  // it - the whole reason correlation is stored in the file rather than kept in memory.
  const runs = readAddressMap(text);

  const lines = text.split('\n');
  let current = null;
  for (let i = 0; i < lines.length; i++) {
    // A banner line is commentary about the listing, not a line of it. The banner quotes
    // instruction addresses when it has something to say about them - the reuse-bit tripwire
    // prints `/*0120*/ decoded 2 reuse bit(s), printed 1` - and those quotes matched the
    // address scan below, so the banner's own rows were indexed as if they were code: moving
    // the cursor scrolled the listing back up to the header.
    if (/^\s*\/\//.test(lines[i]) && !MARKER_RE.test(lines[i])) continue;

    const marker = MARKER_RE.exec(lines[i]);
    if (marker) {
      current = { label: marker[1], line: Number(marker[2]) };
      continue;
    }
    const address = ADDRESS_RE.exec(lines[i]);
    if (!address) continue;

    let at = current;
    if (runs.length) {
      const parsed = parseInt(address[1], 16);
      at = Number.isFinite(parsed) ? positionAt(runs, parsed) : null;
    }
    if (!at) continue;

    byListingLine.set(i, at);
    const key = `${at.label}:${at.line}`;
    if (!bySourceLine.has(key)) bySourceLine.set(key, []);
    bySourceLine.get(key).push(i);
  }
  return { byListingLine, bySourceLine };
}

/**
 * Merge line numbers into contiguous runs.
 *
 * A selection covering a loop body maps to hundreds of scattered instruction lines, and one
 * decoration range per line is both slow to apply and pointless when the lines are adjacent.
 * Runs also make the pathological case cheap rather than dangerous: selecting a whole source
 * file matches most of the listing, which is *contiguous*, so it collapses to a handful of
 * ranges instead of half a million.
 *
 * @param {Iterable<number>} lines
 * @returns {Array<[number, number]>} inclusive [first, last] pairs, ascending
 */
function runs(lines) {
  const sorted = [...new Set(lines)].sort((a, b) => a - b);
  const out = [];
  for (const line of sorted) {
    const last = out[out.length - 1];
    if (last && line === last[1] + 1) last[1] = line;
    else out.push([line, line]);
  }
  return out;
}

/**
 * Every listing row attributed to any of `lines` of the file labelled `label`.
 *
 * @param {Map<string, number[]>} bySourceLine  from `readMarkers`
 * @param {string} label
 * @param {Iterable<number>} lines   1-based source lines
 * @returns {number[]} 0-based listing rows, ascending, deduplicated
 */
function rowsFor(bySourceLine, label, lines) {
  if (!bySourceLine || !label) return [];
  const out = new Set();
  for (const line of lines) {
    for (const row of bySourceLine.get(`${label}:${line}`) || []) out.add(row);
  }
  return [...out].sort((a, b) => a - b);
}

/**
 * Every source position carried by any of `rows`.
 *
 * The inverse direction: a selection over a run of instructions answers "where did all of
 * this come from", which under an optimising compiler is routinely several places at once -
 * hence a set per file rather than a range.
 *
 * @param {Map<number, {label, line}>} byListingLine  from `readMarkers`
 * @param {Iterable<number>} rows   0-based listing rows
 * @returns {Map<string, number[]>} label -> ascending 1-based source lines
 */
function sourcesFor(byListingLine, rows) {
  const out = new Map();
  if (!byListingLine) return out;
  for (const row of rows) {
    const at = byListingLine.get(row);
    if (!at) continue;
    if (!out.has(at.label)) out.set(at.label, new Set());
    out.get(at.label).add(at.line);
  }
  return new Map([...out].map(([label, lines]) =>
    [label, [...lines].sort((a, b) => a - b)]));
}

module.exports = {
  MARKER_RE,
  ADDRESS_MAP_RE,
  NVDISASM_MARKER_RE,
  rewriteSource,
  bannerLines,
  readAddressMap,
  positionAt,
  runs,
  rowsFor,
  sourcesFor,
  unescapePath,
  samePath,
  parse,
  byAddress,
  labelsFor,
  annotate,
  readMarkers
};
