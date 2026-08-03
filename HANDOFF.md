# Handoff

What someone picking this up needs to know that the code does not say for itself.

## What it is

A VS Code extension that turns an NVIDIA driver shader-cache blob into a readable SASS
listing with the per-instruction scheduling control codes decoded into a column.

It began as [`nvidia-sass-highlighter`](https://github.com/gvalasek/nvidia-sass-highlighter)
v0.3.0 and **supersedes it** - the language support (grammar, parser, semantic tokens,
hovers, symbols, data, themes) is the same code, extended. Both declare language id
`nvidia-sass`, grammar scope `source.nvidia-sass` and the same theme names, so only one
should be installed. The doctor command checks for the other.

```
blob ──enumerate──> zstd frames ──decompress──> NVuc payload ──carve──> microcode
     ──nvdisasm──> SASS text ──annotate──> listing with [B..:R.:W.:Y:S..] columns
```

The browsing layer sits on top of that:

```
blobstore.js  loaded cache files and their objects - never their bytes
tree.js       the Shader Objects view (TreeDataProvider)
browser.js    every command body; extension.js is only a registry
review.js     which shaders you have already been through, keyed on sha1
```

## Toolchain constraints

**There is no node/npm on this machine, and nothing here needs it.** No bundler, no
TypeScript, no `vsce`. Plain CommonJS that the extension host runs directly.

- Python is `py` (3.12). It drives verification (`tools/verify.py`) and packaging
  (`tools/package_vsix.py`, which writes the VSIX by hand).
- The JavaScript test suites run under **VS Code's own Electron in Node mode** -
  `ELECTRON_RUN_AS_NODE=1` against `Code.exe`. `find_node()` in `verify.py` locates it and
  reports a skip rather than a pass if it cannot.
- VS Code CLI: `D:\Development\Programs\Microsoft VS Code\bin\code.cmd`.
- CUDA is at `D:\Development\Programs\CUDA`; `nvdisasm` works, `nvcc` does not (no MSVC).

Do not introduce an npm-only workflow without first making the offline packaging story
explicit. The current one has no network dependency at all.

## Verification

```powershell
py tools\verify.py                    # everything; seconds
py tools\oracle_compare.py --quick    # against the reference reader; seconds
py tools\oracle_compare.py --full     # release gate; minutes
```

`verify.py` is the single entry point: JSON shape, every grammar regex, manifest wiring
(commands, menus, settings, packaged modules), theme coverage, and the seven JavaScript
suites. Expect `PASS 59 passed, 0 failed, 0 warnings`.

**Python `re` only approximates Oniguruma**, which is what VS Code actually runs grammars
under. A regex change involving lookbehind or heavy nesting needs a live check:

```powershell
& "D:\Development\Programs\Microsoft VS Code\bin\code.cmd" --extensionDevelopmentPath="D:\Development\Repositories\nv-isa-extractor" "D:\Development\Repositories\nv-isa-extractor\samples\formats.sass"
```

### The oracle

The cache container is reverse-engineered and undocumented, so correctness cannot be argued
from a specification. What can be established is that two independent implementations agree.
`tools/oracle_compare.py` runs this extension's reader and the reference Python one
(`csg-propagation/tools/nvsass`, override with `NVSASS_ORACLE`) over the real caches and
compares object sets, carved bytes and disassembled text.

Last full run: object sets identical at 255 objects (GLCache indexed), 151 (magic scan) and
381 (DXCache); three kernels up to 8 MB carve byte-for-byte identically and disassemble to
identical text. It reports SKIP, not PASS, on a machine without the reference or a cache.

**The reference has no `--ctrl` feature.** An earlier planning document claimed it did and
described the interface as verified; `git log --all -S` shows it never existed on any branch.
`src/ctrl.js` is original work. Do not go looking for the Python version of it.

## Traps

### Container format

- **Anchor-relative section carving.** `payload[anchor+off : anchor+off+len]`, never
  `payload[off+8 : off+len]`. Off by the 8-byte GLCache prefix truncates the last
  instruction - invisible most of the time because kernels are NOP-padded, a hard nvdisasm
  failure whenever the last instruction is not a benign NOP.
- **A GLCache frame ends at `off+32+size`, not `off+size`.** `size` counts from the end of a
  32-byte prefix while the frame starts at 0x24.
- **Never clamp a carve.** An extent past the payload returns null. In DXCache the anchor is
  0 and every microcode offset is a multiple of 16, so a payload truncated on a block
  boundary yields a shortfall that is *also* a multiple of 16 - it would pass validation and
  hold wrong instructions.
- **The `.toc` stride is version-dependent** (24 bytes/u32 at v3, 32/u64 at v4). Both occur,
  and a freshly created cache is written as v3, so a v4-only reader silently finds nothing.
  Synthetic fixtures for both are in `test_zstd.js`; this machine's caches are all v4.
- **Sections do not tile the object.** They are alignment-padded and interleaved with
  zero-length entries. Validity is "the first live section starts exactly at the table end",
  not "each starts where the last ended".
- **The driver holds cache files open**, routinely the most recently written one - i.e. the
  one holding the newest shaders. That is a counted skip reason, not a bug.

### zstd

- **fzstd throws away a decoded payload when it hits trailing bytes.** Cache frames always
  have trailing bytes. Hence `frameCompressedEnd`: walk the block headers to find the exact
  end, then decode exactly that. Never hand the decoder a frame plus slack.
- **A too-tight decode window returns a SHORT payload, not an error.** No decoder raises.
  The frame's declared content size is the only thing that catches it.

### Control codes

- **Two column formats, two conventions, never mixed.** Maxwell prints a hex *mask* over
  barriers renumbered 1-6 and a hex stall; Volta+ prints *positional* scoreboards 0-5 and a
  decimal stall. Every control record carries an `era`, and `hover.js` dispatches on it into
  a separate spec in `registers.json`. A test asserts the Volta hover never reuses the
  Maxwell mask wording.
- **The reuse tripwire's two directions mean different things.** See the comment at the top
  of `src/ctrl.js`. Treating them alike makes it fire on every graphics shader.

### The browser

- **A binary file has no `TextDocument`.** Opening a `.bin` gives you a placeholder editor,
  so `window.activeTextEditor` is `undefined`, `visibleTextEditors` is empty, and the file
  never appears in `workspace.textDocuments`. `workspace.openTextDocument` on it fails
  outright. The tab still knows the resource:
  `window.tabGroups.activeTabGroup.activeTab.input.uri`. That three-step chain in
  `browser.resolveTarget` is the only reason the extension is reachable from an open file.
  `Tab.input` is `undefined` for editor kinds VS Code does not model, so it must be
  duck-typed, never assumed.
- **Never retain a file buffer.** See `blobstore.js`. Measured: seven cache files held with
  their buffers cost +560 MB resident; the same files' object records cost +30 MB. Re-reading
  costs ~94 ms against nvdisasm's ~4.5 s. A DXCache live prefix is a *subarray* and pins the
  whole 256 MB bucket, so trimming is not an alternative to dropping.
- **Every tree node needs an explicit stable `id`.** Without one VS Code derives handles from
  labels and loses expansion and selection whenever a label changes - which here is every
  time a review mark flips. Duplicate ids throw.
- **`resolveTreeItem` runs at most once per item.** A tooltip mentioning mutable state goes
  stale and stays stale, so tooltips carry only immutable facts and everything that changes
  lives in the icon and `contextValue`.
- **Review marks are keyed on sha1, not on `source+offset`.** The driver rewrites cache files
  constantly, so offsets move between sessions while the shader does not. This is the only
  reason a review pass survives a rescan.
- **`engines.vscode` is `^1.75.0` while this machine runs 1.131.** `TreeItem.checkboxState`
  and friends are 1.80+ and are deliberately unused; `verify.py` greps for them, because
  nothing else in the toolchain would notice.
- **`verify.py` scrapes `extension.js` for `registerCommand('...')` with single quotes** and
  demands set equality with the declared commands. Registering from another module, or in a
  loop, or with double quotes, fails the gate even though the extension works. Keep
  `extension.js` a thin registry.
- **`withProgress({location: {viewId}})` throws "Bad progress location"** if the view id is
  wrong. `browser.openBlob` catches it and falls back to a notification so a wiring mistake
  degrades instead of breaking the command.
- The provider and the command module both take their record source as a parameter,
  defaulting to `blobstore`. That is what lets `tools/test_browser.js` drive the view over
  ten-thousand-object files and unreadable files without such a cache existing.

### Extension

- **`execFile` has a 1 MB default buffer.** A large kernel disassembles to tens of megabytes.
  Use `spawn`. (An 8 MB kernel produced 503,994 lines here.)
- **nvdisasm emits CRLF on Windows.** Normalise, or every oracle text comparison fails.
- **Grammar capture numbers are positional and load-bearing.** The instruction rule's
  `begin` has 31 groups; the opcode is 28. Inserting anything shifts everything after it, and
  `verify.py` checks the opcode capture across every line-prefix form for exactly this reason.
  The regex is `(?x)` extended - literal spaces are ignored and `#` starts a comment.
- **Both control-column rules are line-anchored, as is the instruction rule.** The
  instruction rule must consume the column itself; the standalone rules stay ordered *after*
  `#instruction` or they win and the opcode is never reached.
- **`src/data.js` loads `../data/*.json` at require time.** Moving `src/` without `data/`
  breaks module load.
- **Opcode colour stability is load-bearing** (inherited). Every opcode is emitted as the
  bare `sassOpcode` type with no modifier bits. An earlier version added classification
  modifiers; stock themes did not understand the combinations and opcodes flashed blue to
  black when the async semantic pass landed.
- **The semantic pass re-reads the whole document** every time VS Code asks, which is after
  every edit. `nvidiaSass.semanticMaxLines` (default 100k) is what keeps a half-million-line
  listing usable. There is no range or delta provider; adding one is the obvious next step.

## Data provenance

Every curated modifier entry carries a `source` of `ptx`, `slides`, `community` or `corpus`,
and the hover shows it. **Do not add unsourced descriptions.** `data/opcodes.json` is
generated by `tools/fetch_opcodes.py` from NVIDIA's docs; the seven graphics opcodes in
`opcodes-extra.json` are hand-curated and must never be merged into the generated file.

## Packaging

```powershell
py tools\package_vsix.py --install
```

Then **Developer: Reload Window** - a newly installed manifest is invisible to an already
running window, including its Settings UI.

`INCLUDE_DIRS` in `package_vsix.py` decides what ships. `verify.py` walks every `require()`
in the source and fails if a module would be missing from the package, so a new `src/` file
does not need to be registered anywhere - but a new *directory* does.

## Not done

Deliberately out of scope for the first version, roughly in value order:

- A "find every cache file on this machine" command. The view browses files you point it at;
  it does not go looking. `dump_objects.js:51` already walks a whole cache root, and
  `doctor.js:40` has a second copy of the same walk - one shared module would retire both and
  back the command.
- Jump from a wait to the instruction that armed the scoreboard - the flagship use of the
  decoded columns, and the reason `era` is on the parse record. Needs a Definition or
  Reference provider, plus honesty about it being a linear scan that is exact only on
  straight-line code.
- `BSSY`/`BSYNC` pairing and folding; a stats panel; a stall-count heatmap as a semantic
  token modifier (read the opcode-colour trap first).
- Range and delta semantic token providers, which would retire `semanticMaxLines`.
- Linux cache discovery. Both cache roots are `%LOCALAPPDATA%`-based; the reference reader
  has the same limitation.
- Marketplace publishing and CI.
