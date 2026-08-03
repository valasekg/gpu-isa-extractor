# NVIDIA ISA Extractor

Turn an NVIDIA driver shader-cache blob into a readable SASS listing, inside VS Code.

Point the extension at a cache file and it decompresses the zstd frames, carves the GPU
microcode out of the `NVuc` container, disassembles it with `nvdisasm`, decodes the
per-instruction **scheduling control codes** into a column, and opens the result with full
syntax highlighting, semantic tokens and hover documentation.

```
/*0000*/ [B------:R-:W0:Y:S04]  S2R R0, SR_CTAID.X ;
/*0010*/ [B--2---:R-:W-:-:S01]  IMAD R2, R0, c[0x0][0x0], R3 ;
```

The column reads: scoreboards this instruction waits on, scoreboard armed at operand
read-out, scoreboard armed until writeback, yield hint, and the stall count in cycles.
Hover any field for an explanation.

### Following a scoreboard

Move the cursor onto a scoreboard inside a control column — arrow keys are enough — and the
other end of that dependency lights up. From a wait, the instructions that armed it; from an
arm, the wait that drains it and everything else that wait covers. `F12` opens the same set in
a peek window. Turn it off with `nvidiaSass.scoreboard.highlight`.

The hover says how deep the scoreboard is:

> **Scoreboard 4 stands at 2** here — 2 outstanding arms this instruction waits to drain:
> - line 61 · `LDG` arms it until its result is written back
> - line 62 · `LDG` arms it until its result is written back

Scoreboards are counters rather than flags, so one wait routinely drains several arms — two
loads sharing a scoreboard and a single wait covering both is ordinary compiler output.

The scan is exact within a straight-line run, which is where nearly all scoreboard scheduling
happens. Where it crosses a label or a branch it says so rather than presenting a guess as a
fact. At a branch target the arms genuinely live on the other side of the branch, and the
hover reports them while making clear it cannot know which path arrived.

## Requirements

- **CUDA Toolkit** for `nvdisasm` — located automatically (setting → `PATH` → `%CUDA_PATH%\bin`),
  never bundled (NVIDIA's license does not permit redistribution).
- An NVIDIA GPU for automatic architecture detection (`nvidia-smi`), or set
  `nvIsaExtractor.arch` manually (e.g. `SM86`).
- Windows: the shader caches live under `%LOCALAPPDATA%\NVIDIA\GLCache` and `...\DXCache`.

Run **NVIDIA ISA: Doctor** to check all of this at once.

## Usage

Open a shader cache any of these ways:

- **Right-click** a `.bin`, `.toc` or `.nvph` in the Explorer.
- **With the file already open** — a `.bin` shows as a binary placeholder, and the
  circuit-board button in the editor title bar scans it. `Ctrl+Alt+Shift+D` does the same.
- **From the palette** — *NVIDIA ISA: Open Shader-Cache File*. With a cache file in the
  active tab it uses that; otherwise it asks, starting at `%LOCALAPPDATA%\NVIDIA`.
- **From the view** — the NVIDIA ISA icon in the activity bar.

Supported inputs: GLCache `.bin` with its `.toc` index (fast path), GLCache `.bin` without
one (magic scan), DXCache `.nvph`, and any other blob containing zstd frames.

### Going through them

The **Shader Objects** view lists every shader in every cache file you have open, so the
list stays put while you read a listing. Click one to disassemble and open it.

A cache file holds hundreds of shaders, so the view is built for working through them:

- **Walk them in order** with `Ctrl+Alt+PageDown` / `PageUp`, from either the view or a
  listing. Each step replaces the listing tab rather than opening a new one, so stepping
  through two hundred shaders leaves you with one tab, not two hundred.
- **Mark what you have seen** with `Ctrl+Alt+Shift+M`. `Ctrl+Alt+Shift+PageDown` jumps to
  the next shader you have not marked, and the activity-bar badge counts what is left.
  Marks are keyed on shader contents, so they survive the driver rewriting the cache and
  renumbering every offset.
- **Filter** by entry name, sha1 prefix, or offset. Walking then covers only what matched.
- **Disassemble in bulk** — right-click a file or a size group. It tells you how many
  shaders, how much text and roughly how long before starting, and skips anything already
  done.
- Identical shaders stored at several offsets collapse into one row you can expand;
  a quarter of DXCache entries are duplicates.
- Files with thousands of shaders split into size buckets automatically.

Every listing opens with what the shader *is*, then where it came from:

```
//============================================================================
// colorizeOverlayMain_2 - compute shader
//============================================================================
// stage         : compute (code 5)
// registers     : 24 declared, cap 255
// local mem     : 0 bytes
// shared mem    : 0 bytes (no shared-memory access in the code)
// instructions  : 200, 188 live (12 trailing NOP pad)
// mix           : Floating Point 59%   Integer 12%   Movement 9.0%   Load/Store 5.0%
// uses          : textures
// control flow  : 1 BSSY/BSYNC pair;  no backward branches
// scheduling    : 1.98 stall cycles/instr   11% wait   14% arm   79% yield   10% reuse
//                 395 static issue cycles - one warp on a straight line, ignoring memory
//                 latency, occupancy and loop counts. A floor on issue, not a performance figure.
// registers used: R0-R21   UR0-UR4   P0-P4
// const banks   : c[0x0]
// predicated    : 19% of instructions
//----------------------------------------------------------------------------
// source        : ...\648bf5c69af8e551.bin
//                 frame at offset 265348 (GLCache blob)
// microcode     : 3200 bytes, sha1 fd89076810a481d90484c8064415908f512f9b38
// arch          : SM86
```

The first four fields are the cache's own record of the shader; the rest is counted from the
disassembly and the instruction words. Stage, register count and memory sizes also appear in
the view's rows, and you can filter by stage (`ps`, `vertex`, `cs`…).

Because those two sources are independent, the extension compares them and says so in the
banner when they disagree — a declared register count the code exceeds, or local memory
declared for a shader that never spills, means one of the two is being read wrong.

Some things are deliberately not said:

- **The register count is printed as declared.** It runs a little above the highest register
  the code touches, but that margin is not constant, so subtracting it would invent precision.
- **Shared memory is only recorded by the Vulkan/GL cache.** Where it is absent and the code
  plainly uses shared memory, the banner says *"used, but this cache does not record the
  size"* rather than `0 B`.
- **The stall total is a floor on issue, not a cost.** It assumes one warp on a straight line
  and knows nothing about memory latency, occupancy or how many times a loop runs.
- **A backward branch is reported as a backward branch,** not as "has a loop" — if/else
  lowering produces them too. The self-branch trap every shader ends with is excluded.

## Language support

`.sass` and `.nvsass` files get highlighting, semantic tokens, hovers and an outline,
covering `nvdisasm`, `cuobjdump -sass`, Nsight export and bare listing formats, plus both
control-column conventions: the Maxwell/maxas leading `06:-:-:Y:d` form and the Volta+
bracketed `[B------:R-:W0:Y:S04]` form this extension emits.

> `.sass` is also the extension of the indented CSS preprocessor. If VS Code guesses wrong,
> pin it per folder:
> ```json
> "files.associations": { "**/*.sass": "nvidia-sass" }
> ```

This extension **supersedes `gvalasek.nvidia-sass-highlighter`** — it contains all of it.
Uninstall the highlighter; running both means two extensions contributing the same language
id, grammar and themes.

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `nvIsaExtractor.nvdisasmPath` | `""` | Explicit `nvdisasm` path; empty = auto-locate |
| `nvIsaExtractor.arch` | `auto` | `auto` reads the GPU's compute capability; else e.g. `SM86` |
| `nvIsaExtractor.minCodeBytes` | `0` | Ignore objects smaller than this (try `65536` on DXCache) |
| `nvIsaExtractor.glcacheMode` | `auto` | `auto` uses the `.toc` index and falls back to scanning |
| `nvIsaExtractor.decodeControlCodes` | `true` | Emit the `[B…]` scheduling column |
| `nvIsaExtractor.keepRawMicrocode` | `false` | Keep the carved binary beside the listing |
| `nvIsaExtractor.output.location` | `globalStorage` | Where listings are written |
| `nvIsaExtractor.output.retentionDays` | `30` | Prune listings older than this; `0` = never |
| `nvIsaExtractor.tree.sortBy` | `size` | Order in the view: `size`, `offset` (file order) or `name` |
| `nvIsaExtractor.tree.autoGroupThreshold` | `200` | Above this many shaders, split into size buckets |
| `nvIsaExtractor.tree.pageSize` | `500` | Rows per level before a `Load more…` entry; `0` = all |
| `nvIsaExtractor.tree.maxBlobs` | `8` | How many cache files stay listed at once |
| `nvIsaExtractor.batch.confirmAboveBytes` | `256 MB` | Ask before a batch producing more than this |

The `nvidiaSass.*` settings (semantic highlighting, hover detail, architecture) carry over
from the highlighter unchanged, plus `nvidiaSass.semanticMaxLines` which skips the semantic
pass on very large listings.

## Honesty

SASS is undocumented. The opcode and postfix descriptions are assembled from PTX docs,
NVIDIA slides, community reverse-engineering and corpus observation, and each hover states
its source. The control-code bit layout is reverse-engineered (Volta→Blackwell, bits
[105,126) of the 128-bit instruction) and cross-checked on every dump against `.reuse`
flags that `nvdisasm` prints independently — a mismatch raises a warning rather than
silently showing wrong numbers. Verified on Ampere/Ada; take the details with a pinch of
salt on other architectures.

## Development

No npm. Python drives everything:

```bash
py tools/verify.py
```

See `HANDOFF.md` for the toolchain constraints and the oracle-comparison workflow.

## License

MIT — see `LICENSE`. Vendored third-party code is listed in `THIRD_PARTY_NOTICES.md`.
