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

## Compiling a shader you are writing

**NVIDIA ISA: Compile and Disassemble** (`Ctrl+Alt+Shift+B`) takes the `.slang` or `.cu` file in
the editor, compiles it, and opens its SASS beside the source — with the same control-code
column, hovers, scoreboard following and statistics a cache listing gets, plus **source
correlation**:

The instruction stream stays clean — the map lives in the banner, keyed by address, so nothing
is interleaved with the code:

```
// correlation  : @0000 saxpy.cu:2
//                @0010 saxpy.cu:4
//                @0040 saxpy.cu:5
...
        /*0010*/ [B------:R-:W0:Y:S04]  S2R R6, SR_CTAID.X ;
        /*0020*/ [B------:R-:W0:Y:S02]  S2R R3, SR_TID.X ;
```

Each entry starts a run that holds until the next. Set
`nvIsaExtractor.compile.correlationStyle` to `inline` for the older
`//## file:line` markers above each run, which survive being pasted as plain text.

Put the cursor on an instruction and the line that produced it lights up in the source; put it
on a source line and every instruction attributed to it lights up in the listing.

**Select a range and it works on the whole range** — pick out a loop body, or a function, and
every instruction it accounts for is highlighted at once, scattered through the listing as the
scheduler left it. This is the useful way to read optimised code: one line rarely maps to one
contiguous run, but a *block* usually maps to something you can see the shape of. It works in
both directions and across a multi-cursor, so selecting a stretch of SASS answers "where did
all of this come from" — including which parts came from inlined code rather than from
anything you wrote.

**Ctrl+click a source line** to jump straight to the first instruction it produced.
`Ctrl+Alt+Shift+S` goes the other way, from an instruction to its source line. The map is
written into the listing itself, so all of this still works on one saved and reopened later.

If a selection highlights nothing and you expected it to, turn on
`nvIsaExtractor.compile.traceCorrelation` — it says whether the listing has no map, names a
different path, or simply attributes no instructions to those lines.

A shader takes one of two roads, chosen by its stage:

```
compute                       slangc -target cuda  → NVRTC → ptxas → cubin
vertex, fragment, geometry,   slangc -target spirv → the display driver → its shader cache
hull, domain
```

Both end in the same place — microcode, in the same shape as bytes carved out of a cache — so
the listing is produced by the extension's ordinary `nvdisasm --binary` path either way.

Five worked examples are in `samples/` — open any and press `Ctrl+Alt+Shift+B`:

| | |
|---|---|
| [`tiled-matmul.cu`](samples/tiled-matmul.cu) | shared-memory staging, `BAR.SYNC`, paired scoreboard loads, an unrolled inner product, and a guard the compiler **predicates** rather than branches |
| [`prefix-blur.slang`](samples/prefix-blur.slang) | three `BSSY`/`BSYNC` pairs, `MUFU.RSQ`, and markers naming both the `.slang` and Slang's inlined CUDA prelude |
| [`surface-shading.slang`](samples/surface-shading.slang) | the **graphics** road: `IPA` reads out of attribute space, `AST` stores feeding them, `TEX`, `KILL`, and a banner naming the pipeline it was compiled into |
| [`point-sprites.slang`](samples/point-sprites.slang) | a **geometry** shader expanding one point into a quad: `OUT.EMIT`/`OUT.FINAL`, `ISBERD`, and a topology read out of the shader rather than chosen |
| [`terrain-tessellation.slang`](samples/terrain-tessellation.slang) | a **hull** and **domain** pair, which cannot be compiled apart — and the measured asymmetry between generating one half and the other |

Each opens with a comment saying what to look for in its listing, and which flag to change to
make the code move.

### Compile flags

Flags live with the code they change, on the first line of the file:

```hlsl
// nv-isa-extractor -O3 -fp-mode fast -Xptxas -maxrregcount=32
```

A bare flag goes to the compiler for that language — `slangc` for Slang (`-O3`, `-fp-mode`),
NVRTC or `nvcc` for CUDA (`-use_fast_math`, `-ffp-contract`). Later stages are reached with
`-Xptxas <flag>` and, from a Slang file, `-Xnvrtc <flag>`, following nvcc's own convention.
`nvIsaExtractor.compile.flags` sets defaults; the file's own line wins.

### Vertex, fragment, geometry and tessellation shaders

A graphics shader has no CUDA lowering, so it is compiled by asking the **display driver** to
build one pipeline and then reading what it wrote into an isolated copy of its own shader
cache. Nothing is drawn: no swapchain, no images, no render pass, no draw call.

That means a vertex or fragment shader has no SASS of its own — only SASS **for a pipeline** —
and a pipeline carries two things the source file never states. Both were measured to change
the generated code *without changing anything a reader could see*, so both are decided
explicitly and then printed in the banner:

| | default | why it matters |
|---|---|---|
| descriptor layout | reflected out of the SPIR-V | substituting `UNIFORM_BUFFER_DYNAMIC` for `UNIFORM_BUFFER` took one shader from 48 instructions to 40; adding four bindings it never touches changed the code at the **same** instruction count |
| the producer | the file's own vertex shader, else one generated to match | a mismatched pair makes the pipeline undefined — and the driver compiles it anyway, exits zero, and returns byte-identical code. Only the validation layer objects |

Render state — colour format, sample count, depth — is *not* in that table: 24 measured cells
across six formats, two sample counts and three depth configurations produced one distinct
pixel microcode and one distinct vertex microcode. It is recorded, not weighed.

Where you know better than reflection can — because you know how your engine binds the shader
— say so on the line that already carries the compile flags:

```hlsl
// nv-isa-extractor -Xvk bind=0:0:8:1 -Xvk samples=4
// nv-isa-extractor -Xvk producer=fullscreen.slang:vsMain
```

`bind=<set>:<binding>:<type>[:<count>]` (type is `VkDescriptorType`'s own numbering),
`push=<bytes>`, `producer=<file>[:<entry>]`, `format=`, `depth=`, `samples=`. Saying nothing is
deliberately not the same as saying "no descriptors": with no `bind` the layout is reflected,
because an empty one would drop every binding the shader declares.

### Includes and imports

**The file's own directory is always on the include path**, so a header or a module beside a
shader is found without being asked for — `#include "common.h"` from a `.cu`, `import helpers;`
from a `.slang`. That holds while the buffer is *unsaved*, which is when it is least obvious:
the text is compiled from a copy in a scratch directory, where every sibling of the real file
would otherwise be out of reach. NVRTC has no notion of a source directory at all, so for CUDA
this is the only thing that makes a sibling header work.

Anywhere else goes on the same first line, relative to the file:

```hlsl
// nv-isa-extractor -I../common -I"C:\Program Files\shaders\inc"
```

Relative means *relative to the shader*, not to whatever directory the editor was started in,
so the line means the same thing for whoever opens the file. `-I<dir>`, `-I <dir>` and
`--include-path=<dir>` are all accepted and normalised to the one spelling every tool takes.
A bare `-I` goes to the compiler for the language, as every other bare flag does, and
`-Xnvrtc -I<dir>` reaches the CUDA stage of a Slang compile. A directory that is not there is
reported in the listing's banner, rather than surfacing further down as `cannot open source
file` naming the header instead of the mistyped path.

Correlation follows the code in: instructions generated from an included header or an imported
module are attributed to *that* file, which is listed in the banner's source map, so
`Ctrl+Alt+Shift+S` opens it at the line.

### What it will not do

- **Mesh, amplification and raytracing are unimplemented.** Mesh and amplification need a
  pipeline shape this does not build yet; raytracing needs a different creation call
  (`vkCreateRayTracingPipelinesKHR`). Neither is impossible. Read those from a cache file for now.
- **A generated tessellation counterpart is not free in both directions.** A domain shader
  compiles identically whichever hull feeds it; a hull shader does not, because a generated
  domain reads every output it declares and brings no descriptors of its own. The banner says
  which case you got.
- **No source correlation for graphics shaders.** The compute road gets it from the cubin's
  line table; a driver-compiled shader has no cubin and the container carries no debug section
  — checked across 3,340 cache objects. SPIR-V built with `slangc -g`, source text and all,
  produces a byte-identical object of exactly the same size. The driver strips it.
- **Graphics needs the GPU present.** `ptxas` cross-compiles for any architecture from a
  machine with no NVIDIA card at all; asking the driver to compile does not. It also fails
  where the driver itself is fine but Vulkan is not — a Remote Desktop session, or a
  datacenter driver that registers no ICD. The doctor names each of those specifically.
- **Attribution is not cost.** A marker says which source construct an instruction was
  generated for. Under optimisation the scheduler interleaves independent work, so one line's
  instructions are scattered and one instruction can serve several lines. Instructions from
  inlined code — Slang's CUDA prelude, for instance — are attributed to *that* file and are
  labelled as such rather than being folded into the nearest line you wrote.

### Requirements

`slangc` for Slang (ships with the Vulkan SDK) and Python 3 on `PATH` are common to both roads.

**Compute** additionally wants `ptxas` (CUDA Toolkit, beside `nvdisasm`) and a CUDA front end.
NVRTC is the default and needs no host C++ compiler; because it is a DLL with no CLI it is
driven through a small Python helper. Set `nvIsaExtractor.compile.backend` to `nvcc` instead if
you have MSVC. No GPU is needed at all — `ptxas` will target `SM90` from a laptop.

**Vertex, fragment, geometry and tessellation** need neither `ptxas` nor NVRTC, but do need an NVIDIA GPU with
a working Vulkan driver, because the driver is the compiler. The Vulkan loader ships with the
display driver; the SDK is not required.

**NVIDIA ISA: Doctor** reports which of these you have, and names the specific reason when
Vulkan is unusable on a machine where everything else works.

## Language support

`.sass` and `.nvsass` files get highlighting, semantic tokens, hovers and an outline,
covering `nvdisasm`, `cuobjdump -sass`, Nsight export and bare listing formats, plus both
control-column conventions: the Maxwell/maxas leading `06:-:-:Y:d` form and the Volta+
bracketed `[B------:R-:W0:Y:S04]` form this extension emits.

The two bundled themes (**SASS Dark**, **SASS Light**) give each control-column field its own
colour, but nothing requires you to use them: every scope the grammar emits is rooted at a
prefix the common themes already style, so a listing keeps its structure under Dark+, Dark
Modern, Solarized, Monokai and the rest. `verify.py` checks this against VS Code's own Dark+
and fails on any scope that would fall through to plain foreground.

### Tuning another theme

Two things a listing wants that no general-purpose theme provides. Both go in `settings.json`,
scoped to the theme by name so nothing else changes.

**Dim the punctuation.** Only one of VS Code's nineteen built-in themes styles bare
`punctuation`, so in the rest the commas and semicolons are drawn at the editor's full
foreground — brighter than the opcodes they separate. In Monokai the opcode sits at 3.9:1
against the background while the comma is 13.9:1. This is the single highest-value thing to
paste:

```jsonc
"editor.tokenColorCustomizations": {
  "[Monokai]": {                       // or whichever theme you use
    "textMateRules": [{
      "scope": ["punctuation.separator.operand.sass",
                "punctuation.terminator.instruction.sass",
                "punctuation.section.brackets.begin.sass",
                "punctuation.section.brackets.end.sass",
                "punctuation.accessor.sass"],
      "settings": { "foreground": "#6B6B6B" }
    }]
  }
}
```

**Recover destination-versus-source.** The semantic pass knows which registers an instruction
writes and which it reads, but a foreign theme can only borrow colours it already defines, so
the distinction is invisible outside the bundled themes. `enabled: true` is required — several
themes never opt into semantic highlighting at all:

```jsonc
"editor.semanticTokenColorCustomizations": {
  "[Monokai]": {
    "enabled": true,
    "rules": {
      "sassVectorReg.dst": { "foreground": "#FFD08A", "bold": true },
      "sassPredicate":     "#F07178",
      "sassImmediate":     "#C3E88D"
    }
  }
}
```

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
| `nvIsaExtractor.compile.flags` | `""` | Default compile flags; the file's own line wins |
| `nvIsaExtractor.compile.backend` | `auto` | CUDA front end: `nvrtc` (no host compiler) or `nvcc`. Compute only — the graphics road uses neither |
| `nvIsaExtractor.compile.correlate` | `true` | Highlight the matching lines as the selection moves |
| `nvIsaExtractor.compile.correlationStyle` | `banner` | Where the map is recorded: `banner`, `inline` or `off` |
| `nvIsaExtractor.compile.clickToSass` | `true` | Ctrl+click a source line to jump to its first instruction |
| `nvIsaExtractor.compile.traceCorrelation` | `false` | Log why a line highlighted nothing |
| `nvIsaExtractor.compile.slangcPath` | `""` | Explicit `slangc`; empty = auto-locate |
| `nvIsaExtractor.compile.ptxasPath` | `""` | Explicit `ptxas`; empty = auto-locate |
| `nvIsaExtractor.compile.pythonPath` | `""` | Interpreter for the NVRTC helper; empty tries `py`, `python3` |
| `nvIsaExtractor.compile.nvrtcPath` | `""` | Explicit `nvrtc64_*.dll`; empty searches `%CUDA_PATH%` |

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
