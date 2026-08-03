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

## Requirements

- **CUDA Toolkit** for `nvdisasm` — located automatically (setting → `PATH` → `%CUDA_PATH%\bin`),
  never bundled (NVIDIA's license does not permit redistribution).
- An NVIDIA GPU for automatic architecture detection (`nvidia-smi`), or set
  `nvIsaExtractor.arch` manually (e.g. `SM86`).
- Windows: the shader caches live under `%LOCALAPPDATA%\NVIDIA\GLCache` and `...\DXCache`.

Run **NVIDIA ISA: Doctor** to check all of this at once.

## Usage

- Right-click a `.bin`, `.toc` or `.nvph` file in the Explorer → **Disassemble Shader-Cache Blob**.
- Or run the command from the palette and pick a file — the dialog opens at
  `%LOCALAPPDATA%\NVIDIA`, so cache files outside your workspace are reachable.

A cache file usually holds many shader objects; you pick one from a list sorted
largest-first, labelled with its entry point name. The generated listing carries a
provenance banner (source file, offset, sha1, architecture, nvdisasm version).

Supported inputs: GLCache `.bin` with its `.toc` index (fast path), GLCache `.bin` without
one (magic scan), DXCache `.nvph`, and any other blob containing zstd frames.

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
