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
scoreboard.js follows a scoreboard between the instructions that arm it and the wait
              that drains it (no editor API, so it is directly testable)
highlight.js  wires that into DocumentHighlight and Definition providers
```

## Toolchain constraints

**There is no node/npm on this machine, and nothing here needs it.** No bundler, no
TypeScript, no `vsce`. Plain CommonJS that the extension host runs directly.

- Python is `py` (3.12). It drives verification (`tools/verify.py`) and packaging
  (`tools/package_vsix.py`, which writes the VSIX by hand).
- The JavaScript test suites run under **a real Node if there is one, otherwise VS Code's own
  Electron in Node mode** - `ELECTRON_RUN_AS_NODE=1` against `Code.exe`. `find_node()` in
  `verify.py` prefers `which("node")`, then derives Code.exe from `code` on PATH, and reports a
  warning rather than a pass if it finds neither. A machine with neither runs 65 of the checks
  and skips the 17 JS suites, which is a warning, not a pass.
- CUDA is at `D:\Development\Programs\CUDA\v12.8`; `nvdisasm` and `ptxas` work. MSVC 14.44 is
  installed at `D:\Development\VisualStudio2022`, so `nvcc` and `tools/vk_abi_freeze.py` can
  run - but nothing in the shipped extension needs a C compiler, and that must stay true.
- The Vulkan SDK is at `%VULKAN_SDK%` and supplies `slangc`. The *loader* the graphics road
  actually uses ships with the display driver; the SDK is a dev-time convenience for
  `spirv-reflect` and the validation layers.
- **RGA** (Radeon GPU Analyzer) is the AMD target's third-party tool, on the same footing as
  slangc and CUDA: not bundled, free, and resolved at run time. It needs **no AMD GPU** - the
  offline mode is a static compiler, the live-driver mode falls back to the AMDVLK driver RGA
  ships with, and the DXR mode takes `--offline` and uses the `amdxc64.dll` it bundles. All
  three measured working on an NVIDIA-only machine. Versions measured here are **2.14.2.7** and
  **2.14.2.8** (the latter as shipped inside the Radeon Developer Tool Suite, whose tree puts
  `rga.exe` and `utils/amdllpc.exe` exactly where the standalone archive does).
  `tools/test_rga.js` and `tools/test_dxr.js` take **`RGA_PATH`**, mirroring `VSCODE_EXE`;
  without it the checks needing a real binary skip.

  **`RGA_PATH` may name the unpacked archive or the `rga` inside it**, and so may the
  `compile.rgaPath` setting. Everything that takes a path runs it through `rga.asExecutable`,
  which asks the filesystem which one it is. Before that, a directory passed `existsSync` and
  was returned AS the executable: `version` read `version unknown`, `--list-asics` listed
  nothing, and the doctor reported an RGA that could build for no target. A bad path must fail
  as a bad path.

  **Auto-location was dead code until it was fixed, and the failure looked like absence.**
  `rga.resolve` probes PATH before consulting `RGA_PATH`, `%ProgramFiles%\RGA` and
  `%LOCALAPPDATA%\RGA`, and the runner *rejects* rather than returning `failed` when a program
  cannot be started at all - ENOENT arrives on the child's `error` event. Unguarded, that
  exception left `resolve` before any install root was read, so on every machine without `rga`
  on PATH the roots were unreachable and an installed RGA was reported as not installed. The
  probe is now guarded. This is the same lesson `compileview.resolveTools` records at its own
  `onPath`, about the same runner - if a third tool ever grows a probe, guard it there too.

  Three AMD roads, and they are not variations on one:

  | road | input | target flag | notes |
  |---|---|---|---|
  | `-s vk-spv-offline` | SPIR-V | `-c` required | the default; byte-identical to the live driver given any pipeline state |
  | `-s dxr` | HLSL library | `-c` required | raytracing; needs a state definition synthesised by `src/dxr_library.js` |
  | `-s bin` | AMD code object | **none** | compiles nothing; reads the target out of the file |

  **The target list is per mode.** Vulkan offline lists 10 codenames, all RDNA3/3.5/4, having
  dropped every gfx9 and gfx10 target an earlier release accepted; DXR lists 27, reaching back
  to gfx900 and including RDNA1 and CDNA. Asking one mode about another's targets returns a
  confident wrong answer, so `rga.targets()` takes the mode. Digests pinned to a target name
  skip rather than fail when this RGA cannot build for it.

  **Source correlation uses `utils/amdllpc.exe`, not `rga.exe`.** RGA has no line-info flag in
  any mode and hardcodes debug info off in the amdllpc it drives. Running that same bundled
  amdllpc directly with `--trim-debug-info=false`, over `slangc -g1` SPIR-V, yields a DWARF 5
  `.debug_line` table over machine code byte-identical to RGA's. `rga -v` prints RGA's own
  amdllpc argv, which is where this one came from; it differs by that single flag.

  Three things about it that cost time to learn:

  - **`-g1`, never `-g2`.** `-g2` emits `NonSemantic.Shader.DebugInfo.100`, which crashes
    amdllpc outright on hull and raygeneration shaders and silently reorders geometry
    scheduling.
  - **amdllpc takes its SPIR-V positionally**, where `rga` takes it behind `--vert`/`--frag`.
    Hand it a pipeline's stages in the wrong order and it compiles a different pipeline.
  - **No bundled tool can read the result.** amdllpc emits several compile units but one
    undersized `.debug_str_offsets`, so `llvm-objdump` fails and annotates only the first unit.
    `src/dwarf_line.js` exists because of this, not for want of looking.

**The machine this was last verified on is not the machine most of the recorded numbers came
from,** and the difference is load-bearing rather than trivia. The digests throughout this file
and in `test_gfx.js` were recorded on an **RTX A4500 (SM86)** under **Vulkan SDK 1.3.296.0**.
The current machine is an **RTX 3500 Ada Generation Laptop GPU (SM89)** with **SDK 1.4.341.1**
and **CUDA 12.8**. Anything that compares against a recorded digest therefore skips here rather
than passing, and says so - which is correct, and is not the same as working.

This paragraph used to end "and there is no VS Code installed". There is: it is at
`C:\Development\Programs\Microsoft VS Code`, on **C: and not D:** unlike everything else here.
`find_node()` had that path hardcoded to the D: drive, found nothing, and downgraded the entire
JavaScript section to a warning - 65 checks, `PARTIAL`, exit 0, with the suites and the
module-parse check silently not running. It now derives the path from `code` on PATH. If you
ever see `PARTIAL` and "no JS runtime found", nothing has been checked about the code itself.

Do not introduce an npm-only workflow without first making the offline packaging story
explicit. The current one has no network dependency at all.

## Verification

```powershell
py tools\verify.py                    # everything; seconds
py tools\oracle_compare.py --quick    # against the reference reader; seconds
py tools\oracle_compare.py --full     # release gate; minutes
```

`verify.py` is the single entry point: JSON shape, every grammar regex, manifest wiring
(commands, menus, settings, packaged modules), theme coverage, a parse sweep over every shipped
module, and the 16 JavaScript suites.

**Read the failure detail, not the count.** `verify.py` records one result per JS *script*, so
a suite that dies at its third check and a suite that dies at its fortieth produce an identical
summary line. That is not hypothetical: a syntax error in `compileview.js` once survived ten
commits behind an unchanged count of 2, because the count was checked and the reason was not.
The count agreeing with what is written below is necessary and nowhere near sufficient.

With a JS runtime on `PATH`, expect `FAIL 81 passed, 1 failed, 0 warnings, 1 skipped`. Without
one, expect `PARTIAL 60 passed` - the word is `PARTIAL` rather than `PASS` because no
JavaScript ran at all, so nothing checked whether the extension so much as parses.

The one failure is **known, pre-existing, and unrelated to the extension's own logic.** It is
recorded here rather than fixed in passing, because it needs evidence from more than one
toolchain before it can be fixed rather than guessed at:

- `test_endtoend.js` - "the cubin reports the architecture it was built for" gets `SM5`.
  `cubin.arch()` reads bits [8,16) of the ELF `e_flags`, which is where CUDA used to put the SM
  number. CUDA 12.8 puts it in the **low byte**: `ptxas -arch sm_86` gives `e_flags 0x00560556`
  and `sm_89` gives `0x00560559`, and the byte the existing comment dismisses as "4 on every
  cubin seen here" is now the answer. The whole CUDA compile road fails on this machine as a
  result - `nvdisasm --binary SM5` is rejected outright. Fixing it needs `e_flags` from more
  toolkit versions than one, or the two layouts cannot be told apart safely.

`test_gfx.js` is the suite that can legitimately report skips: its second half needs an NVIDIA
GPU, a working Vulkan driver and `slangc`, and skips rather than fails without them. Its first
half - the struct ABI and the SPIR-V reflector - needs only Python and runs anywhere. Here it
skips 11 checks: seven whose recorded microcode came from the A4500, and four whose fixtures
were regenerated (below).

## The SPIR-V fixtures, and which SDK made them

`tools/fixtures/gfx/*.spv` are committed binaries, and **the SDK that produced them is part of
what they are**. Not recording that cost a day: four of them carried an `ArrayStride`
decoration on a `Function`-storage array, which Vulkan SDK 1.3.296.0's `slangc` emitted and
1.4.341.1's `spirv-val` rejects, and `test_gfx.js` section 9 failed on geometry, tessellation
and mesh with no indication that the inputs rather than the code had aged.

- `gsMain.spv`, `tessHs.spv`, `msMain.spv`, `tessGenHs.spv` were regenerated with **Vulkan SDK
  1.4.341.1**. Established as stale fixtures rather than a slangc bug by rebuilding each from
  its `.slang` source and re-running `spirv-val`: current slangc produces valid SPIR-V from the
  same unchanged sources.
- Every other `.spv` there predates that and still validates. They were left alone deliberately
  - regenerating a fixture invalidates any digest recorded against it, so it is not free.

All 23 validate under `spirv-val --target-env vulkan1.3`. Check before committing a new one:

```powershell
Get-ChildItem tools\fixtures\gfx -Filter *.spv | ForEach-Object {
  & "$env:VULKAN_SDK\Bin\spirv-val.exe" --target-env vulkan1.3 $_.FullName }
```

Rebuild one with, for example:

```powershell
& "$env:VULKAN_SDK\Bin\slangc.exe" tools\fixtures\gfx\geometry.slang `
    -target spirv -entry gsMain -stage geometry -o tools\fixtures\gfx\gsMain.spv
```

**Four digests in `test_gfx.js` are now marked stale** - the geometry, hull, domain and mesh
microcode pins - because the modules they describe no longer exist. They skip on every machine,
including the A4500 they were recorded on, since that is precisely where they would otherwise
fail and read as a driver regression. `STALE_PINS` in that file says so. Re-record them on an
A4500 against the new fixtures; they are kept rather than deleted because they are the only
record of what those pipelines used to produce.

The driver builds these pipelines whether the SPIR-V validates or not, and the microcode is
probably right either way - which is exactly why `vk_compile.py` treats the validation layer's
verdict as fatal. Do not weaken that to make a check pass.

`test_golden.js` is the refactor gate, **and its limits are worth knowing before you trust it**.
It pins the banner and the body of one *cache-origin* listing built from a synthetic
instruction stream. It never loads `compileview.js`, so it says nothing about the compile road;
it never exercises the `compiled` or `driver` provenance rows; and it passed cleanly across the
exact refactor that left `compileview.js` unable to parse. A green golden run means the listing
layout did not move, not that the extension works.

It pins the whole listing, banner and body, and builds
its own instruction stream so it needs no CUDA, no driver and no GPU. It should never skip. If
a change is *meant* to move the listing, re-record with `node tools/test_golden.js --record`
and read the diff - that is the step it exists to stop anyone skipping.

**Python `re` only approximates Oniguruma**, which is what VS Code actually runs grammars
under. A regex change involving lookbehind or heavy nesting needs a live check:

```powershell
& "D:\Development\Programs\Microsoft VS Code\bin\code.cmd" --extensionDevelopmentPath="D:\Development\Repositories\gpu-isa-extractor" "D:\Development\Repositories\gpu-isa-extractor\samples\formats.sass"
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

## The two compile roads

A `.slang` file takes one of two roads, decided by stage before slangc is invoked:

```
compute            slangc -target cuda  → NVRTC → ptxas → cubin  → carve with cubin.js
vertex, fragment   slangc -target spirv → vk_compile.py → isolated GLCache → carve with nvcache.js
```

Both end in microcode of the same shape, so everything downstream is shared.

**Why the decision is before slangc and not after.** `slangc -stage fragment -target cuda`
crashes - exit `0xC0000005`, no diagnostic, no output file. A gate placed afterwards would
report a segfault instead of a route. Verified on Slang 2024.13.

**Why the driver at all.** There is no API that hands back a graphics shader's machine code.
Creating a pipeline makes the driver compile, and it writes the result to its shader disk cache
on the way past. `__GL_SHADER_DISK_CACHE_PATH` redirects that to a scratch directory, so what
lands there is attributable to this run. Nothing is drawn.

**Why the teardown matters.** The driver flushes to that cache as the *device is destroyed*, so
a path that returns without destroying it produces nothing to carve - and the failure looks
like "the shader has no instructions" rather than "the run was abandoned". `vk_compile.py`
destroys on every path, not just the successful one.

**What was measured, and must not be re-litigated from first principles:**

| claim | evidence |
|---|---|
| render state does not move the SASS | 24 cells (6 colour formats × 1/4 samples × none/D32) → one distinct pixel microcode, one vertex. Repeated with a `discard` shader over 12 cells incl. D24S8 |
| the descriptor layout **does** | `UNIFORM_BUFFER_DYNAMIC` for `UNIFORM_BUFFER`: 48 → 40 instructions. Four unused bindings added: different sha1 at the *same* 48 |
| the consumer narrows the producer | a fragment shader reading two fewer varyings deleted the `AST.96`/`AST.64` attribute stores: 48 → 40 |
| the producer does **not** narrow the consumer | three producers - exact, over-provisioned, mismatched - all gave byte-identical fragment code |
| but a mismatched pair is still invalid | `VUID-RuntimeSpirv-OpEntryPoint-08743` and `-maintenance4-06817`. The driver compiles it anyway and exits 0; only the validation layer objects, which is why `vk_compile.py` checks the interface itself |
| no correlation is recoverable | no debug section across 3,340 cache objects; `slangc -g` SPIR-V with `OpLine`, `OpSource` and embedded source produced a byte-identical object of identical size |

**Reproducing the measurements.** `tools/test_gfx.js` pins the digests. The fixtures under
`tools/fixtures/gfx/` are the exact modules those numbers came from; regenerate the frozen
struct ABI with `py tools/vk_abi_freeze.py` (needs MSVC and the SDK) if a struct changes.

**Run new work under the validation layer, and do not skip this.** The driver is lenient, and
that is the hazard. Twice a pipeline has been built from an invalid request, compiled anyway,
and returned microcode matching an independent C++ harness byte for byte:

- `dynamicRendering` was never enabled, because the 1.3 features struct carried the sType of
  the 1.1 one (53 vs 49). Every pipeline was created with `renderPass = NULL` on a device that
  had not asked for it.
- a module declared the SPIR-V `DrawParameters` capability - Slang's `SV_VertexID` lowering -
  that no feature had turned on.

Neither was visible to a digest, a struct-layout diff or an exit code. Both were obvious to the
validation layer within seconds. Section 9 of `test_gfx.js` now runs every fixture with
`validate: true`, which makes the layer's verdict fatal (exit 5) and prints the VUID. Fixing
both changed no microcode at all - the requests were invalid, the answers were right - which is
precisely why nothing else could find them.

**Why ctypes and not a binary.** Same reason as `nvrtc_compile.py`: the extension host cannot
call native code, and a VSIX carrying per-platform binaries would end the no-build-step
packaging story. The port is pinned against a C++ harness byte for byte, and `tools/vk_abi.json`
holds what a C compiler computes for every struct `vk_compile.py` declares - the list is
discovered from the module rather than hand-written, because a hand-written one is what
let three used structs go unfrozen while the suite reported full coverage.

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
- **Several section types have `len == 0` and carry their value in the entry itself.** They
  are typed *slots*, not sections: `0x15` holds the local-memory size in word 4, `0x3c` the
  shared-memory size in word 5, `0x45` a driver flag word. `sectionData` needs a non-zero
  length, so anything reaching them that way sees nothing — which is why the container looked
  like it held only microcode and a name. Use `sectionEntry` for these.
- **Metadata field provenance** (measured over 10,950 objects, driver 596.72 / SM86): stage is
  the low half of the `u32` at `anchor+0x10` (`1=VS 2=PS 5=CS 6=HS 7=DS`, high half always
  `0x0002`); registers are `{count, cap}` in section `0x03`; local memory is `0x15` word 4;
  shared memory is `0x3c` word 5; "discards pixels" is bit 15 of the shader program header
  (`0x2d`) word 0. Geometry shaders never appeared in the corpus, so that enum value is a
  guess — an unrecognised code is printed as a number rather than named.
- **Never print `0 B` of shared memory just because `0x3c` is absent.** That section is
  effectively Vulkan/GL-only; D3D12 compute shaders that clearly use shared memory have no
  such section at all. `sharedNote()` keeps absent and zero distinguishable using the
  instruction mix.
- **Never subtract the register margin.** The declared count sits ~2 above the highest
  register used, but the offset is empirical and is not always 2.
- **`--print-life-ranges` is a silent no-op on raw microcode** — accepted, exit 0, output
  byte-identical, no warning. The control-flow-graph flags are worse: they SIGSEGV. Neither
  works without an ELF, so do not wire them in expecting output.
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
- **A strict backward scan cannot resolve a wait at a branch target.** The instructions above
  it belong to the path that jumps *over* it, so the scan stops at their drain and reports
  that nothing armed the scoreboard. A compiler never emits a wait for nothing, so that empty
  result is the tell: `scoreboard.js` continues from the drain and labels what it finds as
  another path's. Measured on real output this is the difference between 82% and 100% of waits
  resolving - if you ever "simplify" the fallback away, that ratio is the regression to watch,
  and `test_scoreboard.js` asserts it.
- **Scoreboards are counters.** One wait routinely drains several arms. Any code that assumes
  a wait pairs with exactly one arm is wrong on ordinary compiler output.
- **Resolving a join point by resuming at the drain is wrong.** An arm between the branch and
  that drain belongs to the path that was jumped over, so it is outstanding on *no* path
  reaching the target. `branchSourcesTo()` finds the branches naming the target's address and
  reads the scoreboard as it stood when each jumped; `test_scoreboard.js` has the case.
- **Generated listings stay plain ASCII.** They get opened by whatever the user has to hand,
  not only by an editor that knows the file is UTF-8. `test_endtoend.js` asserts it.
- **`viewsWelcome` has no `"when": "default"`.** VS Code deserialises the string as a context
  key before it ever compares it to the literal, so such a block never renders and the pane is
  simply blank. Every welcome block here carries an explicit condition, and between them they
  cover every state.
- **`reveal()` reports failure by logging, not by rejecting.** It only accepts a node whose
  whole parent chain the editor has already been given, and `visibleObjects()` describes rows
  that may never have been built — inside a collapsed bucket, or past a "Load more". Revealing
  one of those silently does nothing, which pinned the walk at every bucket boundary because
  the position was then read back off a selection that had not moved. `provider.materialize()`
  walks the levels first, and `browser.walkCursor` tracks the position independently of the
  selection. Neither is optional; a stubbed `reveal()` in a test cannot catch this.
- **Do not implement this as a `DocumentHighlightProvider`.** It was, and it only worked on
  part of the column. VS Code's occurrence highlighter resolves the *word* at the cursor and
  gives up before calling any provider when there is none — so in `[B01-3--:…]` the leading
  `B01` is one word and highlighted, while the `3` after a dash belongs to no word and the
  provider was never invoked. A fixed-width field of single characters does not fit the
  word-highlight model; `src/highlight.js` drives decorations off the selection instead.
  `verify.py` also asserts the language's `wordPattern` matches a lone digit, which is what
  ctrl+click and double-click need.

### Compiling from source

The chain is `slangc -target cuda` → NVRTC → `ptxas` → cubin → `cubin.entryPoints`, and the
last step exists so the *existing* pipeline runs unchanged: a `.text.<entry>` section is a
contiguous run of 128-bit instructions starting at address 0, which is exactly what
`nvcache.carveAt` produces. Everything downstream — `nvdisasm --binary`, `ctrl.annotate`,
`scoreboard.js`, `stats.js` — is reused rather than reimplemented. If that equivalence ever
breaks, the compiled path is the thing to change, not the shared code.

- **`nvcc` needs a host C++ compiler for every mode**, `-ptx` and `-E` included. Without MSVC
  it fails at `Cannot find compiler 'cl.exe' in PATH` before doing anything, and `-ccbin`
  pointed at MinGW fails deeper with `Host compiler targets unsupported OS`. **NVRTC needs
  none** — hence `src/nvrtc_compile.py`, ~80 lines of `ctypes` against `nvrtc64_*.dll`,
  because NVRTC ships as a DLL with no CLI and the extension host cannot call one without
  npm or native modules. That makes Python a runtime dependency *of this feature only*.
- **Pass NVRTC the absolute source path as the program name.** It is written verbatim into
  the PTX `.file` record, and a bare basename is later resolved against whatever directory
  the editor is running in — producing a source map that points at a file which does not
  exist. This was a real bug; the banner said `gpu-isa-extractor/s.cu`.
- **`-lineinfo` is codegen-neutral** — the `.text` bytes are identical with and without it,
  measured — so listings are what would have been produced anyway. `-G` is not, and is never
  passed implicitly.
- **The SM number is bits [8,16) of `e_flags`, not the low byte.** `0x09005604` is sm_86;
  the low byte is 4 on every cubin seen here and means something else. Reading it wrong makes
  `nvdisasm --binary` decode to the wrong architecture, which yields plausible wrong
  instructions rather than an error.
- **The stage gate must run before slangc, not on its exit code.** `slangc -stage fragment
  -target cuda` **crashes** (exit 0xC0000005, no diagnostic, no output file), which is why
  `compile.chooseSlangEntry` decides the road from the source text rather than by trying one.
  Raytracing stages get all the way through slangc and NVRTC and then die at `ptxas` with
  `Call to '_optix_trace_typed_32' requires call prototype` — OptiX intrinsics are resolved by
  the driver's pipeline linker, so there is no cubin at the end of the CUDA road however far
  it is followed. They reach SASS by the graphics road instead.
- **A raytracing pipeline deposits two container tags, and both hold finished SASS.**
  `NVVMVKRT` and `RTCTskKy`, each a 40-byte header wrapping a plain ELF64 that `cubin.js`
  reads unchanged — no `NVuc` anywhere. The names invite the guess that one is IR; it is not.
  The driver compiles each shader twice, and the two copies of one miss shader came out with
  the same eleven instructions in the same order and a different register allocation, 64 under
  `NVVMVKRT` and 62 under `RTCTskKy`. Reading only the tag that sounds like machine code
  showed a valid six-stage pipeline as **empty**, because a pipeline with a procedural hit
  group wrote `NVVMVKRT` for all six shaders and no `RTCTskKy` at all. `nvcache` reads both
  and `pickLatest` keeps the last copy of each entry point.
- **A raytracing shader can be more than one object.** `TraceRay` and `CallShader` suspend the
  caller, so the driver splits it and names the pieces `_ss_0`, `_ss_1`. Those are separately
  scheduled programs, not fragments — collapsing them to one listing, or naming both after the
  Slang entry point with no suffix, loses a real distinction. `compile.splitSuffix` keeps it.
- **A file mixing compute and graphics entry points must name its compute entry**, or
  slangc's own discovery finds the graphics one and crashes. But do *not* pass `-entry`
  otherwise: a compute-only file compiles fine without it, and passing `-entry` with no name
  makes slangc look for `main` and fail on a file that never claimed to have one.
- **The entry-point scan cannot be one regex.** The attributes between `[shader("compute")]`
  and the function are themselves calls — `[numthreads(64,1,1)]` — so any pattern of the form
  "identifier followed by (" names the entry point `numthreads`. `functionAfter()` skips
  bracket groups and takes the last identifier before the parameter list.
- **Never merge source markers into the text the banner analyses.** `stats.analyze` runs
  `OPERAND_RE` over the whole listing string rather than per instruction line (a measured
  perf decision, `src/stats.js:28-38`), so a marker naming a path like `.../R8G8B8A8/pass.slang`
  is counted as a use of R8 — the banner then reports registers the code never touches and
  `crossCheck` accuses the cache of disagreeing with the code over a directory name.
  `result.text` is the pre-merge listing and is what the banner reads; `result.correlated` is
  the body that gets written. `test_compile.js` section 12 pins this.
- **A compiled listing is not identified by its microcode sha1.** `output.listingName` is
  built on "identical bytes make an identical listing", which is true for a carve and false
  here: adding a comment to a kernel leaves `.text` byte-identical and moves every line
  number, and two files in different directories collide outright. `compileview.writeCompiledListing`
  names on the source path instead and always rewrites, deliberately bypassing
  `browser.openObject`'s `hasListing` shortcut.
- **Slang's `precise` qualifier does not survive the CUDA target.** slangc accepts it and
  emits it verbatim into the generated CUDA, where it is not a keyword, so NVRTC stops at
  `identifier "precise" is undefined`. It is the language-level control over FMA contraction,
  so on this path there is no way to forbid contraction from the shader source; the only
  working control is NVRTC's own `--fmad=false`, reachable as `-Xnvrtc --fmad=false`.
  Do not reach for `-fp-mode` for this - contraction is a separate axis from floating-point
  mode, slangc has no contraction flag, and `-fp-mode precise` leaves the SASS byte-identical.
- **`-g` and `-gi` disagree about which line an instruction belongs to** — measured at 4 of
  24 instructions on a 3-deep inline chain, where `-g` names the innermost callee and `-gi`
  the call site. `-gi` also emits *depth+1* consecutive markers, not two, and re-emits a
  marker when the inline context changes but the line does not. Only `-g` is used, and any
  parser that carries `(file, line)` forward until it changes is correct under `-g` and
  silently wrong under `-gi`. Adding `-gi` means writing a frame-stack parser and deciding,
  in public, which frame is authoritative.

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
- **A scope is only coloured by a theme that styles one of its dotted prefixes**, and the
  default theme family styles far less than it looks. `dark_vs` - which Dark+, Dark Modern,
  Light+, Light Modern and both high-contrast themes inherit - defines `constant.language`,
  `constant.numeric`, `constant.regexp` and `constant.character`, but nothing bare enough to
  catch `constant.other`. All five control-column fields were rooted there, so the column that
  is the whole point of this extension rendered at plain foreground in 8 of the 19 built-in
  themes, including every one most people use. It looked right only in the bundled themes,
  which style the full scope string. The fields are now rooted at `variable.other`
  (the three barriers, matching how barrier *operands* are scoped so a scoreboard looks the
  same everywhere), `constant.numeric` (stall) and `constant.language` (yield): three distinct
  colours in stock Dark+ where there were none. `verify.py` section 5 now checks every
  non-punctuation scope against VS Code's own Dark+ and fails on any that would fall through;
  it skips when VS Code cannot be located. Punctuation is exempt - every theme leaves it at
  the foreground colour on purpose.
  Measured coverage across the 19 built-in themes: control-code fields 18-19/19 (only Abyss
  misses the barriers, and it leaves 38 of our scopes unstyled anyway); `entity.name.label`
  was the worst scope in the grammar at 9/19 and is now `entity.name.function.label` at 17/19.
- **The flash has a second direction, and it was live.** The grammar dims the registers that
  are really constants - `RZ`, `URZ`, `PT`, `UPT`, `SRZ` - on sight. The semantic pass then
  repainted them at full register brightness wherever they sat in a *source* slot, because
  `parse.js` only assigns `role: 'discard'` to a zero register in a destination. Measured in
  the bundled dark theme: `RZ` 4.32:1 arriving as 8.24:1, `PT` 3.39:1 arriving as 6.21:1, on
  36 tokens across the 200-instruction sample. `semantic.js` now skips those tokens entirely
  rather than giving them a dimmer semantic colour: emitting nothing leaves VS Code with
  nothing to override the grammar with, so the dim colour holds by construction instead of by
  every theme agreeing to define a matching rule. Destination discards keep their token - a
  zero *destination* is a real statement that `hover.js` explains, and reusing the `discard`
  role for sources would make that hover say "discards RZ" about a register merely read.
- **Punctuation is the brightest ink on the line in 18 of the 19 built-in themes.** Only
  quietlight styles bare `punctuation`; everywhere else the commas and semicolons render at
  full editor foreground while the opcode is a mid-tone - in Monokai, 13.9:1 against 3.9:1.
  Do *not* re-root the operand punctuation to work around it: those scopes are correct and a
  custom rule written against them would then miss. The README documents a
  `editor.tokenColorCustomizations` snippet instead. The control column's `[`, `:` and `]` are
  the one exception and were moved to `variable.other.control-code.separator.sass`: they are
  internal structure of a single encoded field, not general syntax, and at full brightness
  they framed the column's own digits like a cage.
- **An address delimiter must carry the address's scope.** Captures 10 and 12 of the
  instruction rule - the `/*` and `*/` - were `punctuation.definition.comment.address.sass`
  while the digits between them were `comment.block.address.sass`, so in 15 of the 19 built-in
  themes the delimiters were brighter than the thing they delimit.
- **Opcode colour stability is load-bearing** (inherited). Every opcode is emitted as the
  bare `sassOpcode` type with no modifier bits. An earlier version added classification
  modifiers; stock themes did not understand the combinations and opcodes flashed blue to
  black when the async semantic pass landed.
- **The semantic pass re-reads the whole document** every time VS Code asks, which is after
  every edit. `gpuIsaExtractor.semanticMaxLines` (default 100k) is what keeps a half-million-line
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
- Per-shader metadata beyond entry name and size: register count, local/shared memory, shader
  stage. Some may be in the NVuc sections nothing has looked at yet (only types 0x01 and 0x21
  are read, and fields [3..7] of every section-table entry are unexamined); the rest is
  derivable from the disassembly.
- `BSSY`/`BSYNC` pairing and folding; a stats panel; a stall-count heatmap as a semantic
  token modifier (read the opcode-colour trap first).
- Compiled kernels do not appear in the Shader Objects view. The model there is
  "blob → objects" and a source file is a third kind of root; the compile command opens its
  listing directly instead. Walking, review marks and batch disassembly are therefore
  cache-only. Recompiling on save, and diffing two listings of the same kernel built with
  different flags, are the obvious things that view would make possible.
- Correlation is one-way per gesture and has no CodeLens showing how many instructions a
  line is attributed. That number is easy to compute and easy to misread as a cost, so it
  wants a wording decision before it is shown, not after.
- Range and delta semantic token providers, which would retire `semanticMaxLines`.
- Linux cache discovery. Both cache roots are `%LOCALAPPDATA%`-based; the reference reader
  has the same limitation.
- Marketplace publishing and CI.
