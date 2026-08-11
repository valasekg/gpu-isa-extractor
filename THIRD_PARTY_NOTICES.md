# Third-party notices

## fzstd 0.1.1 — `src/vendor/fzstd.js`

Zstandard decompressor, vendored as the UMD/CommonJS build from
`https://unpkg.com/fzstd@0.1.1/umd/index.js`. Used to decompress the zstd frames that
NVIDIA's shader disk cache stores its objects in. Vendored rather than installed because
this repository deliberately has no npm toolchain (see `HANDOFF.md`).

Copyright (c) 2020 Arjun Barrett. MIT License — full text in `src/vendor/fzstd-LICENSE.txt`.

## nvidia-sass-highlighter — `src/{parse,hover,explain,data,semantic,symbols}.js`, `syntaxes/`, `themes/`, `data/`, `samples/`, parts of `tools/`

The SASS language support in this extension originates in
[`gvalasek/nvidia-sass-highlighter`](https://github.com/gvalasek/nvidia-sass-highlighter)
v0.3.0 and is extended here (Volta+ bracketed control column in the grammar, parser and
hovers). Same author, same MIT license, carried over in `LICENSE`.

## NVIDIA tooling

`nvdisasm` is **not** bundled. It ships with the CUDA Toolkit under a license that does not
permit redistribution; this extension locates an installed copy and runs it. The shader
cache container format is not documented by NVIDIA — the reader here is reverse-engineered
and validated against a Python implementation on real caches.

## SASS King — `data/modifiers.json`

The SM120/SM120a postfix descriptions with `source: "sass-king"` are paraphrased from
controlled observations published by
[`florianmattana/sass-king`](https://github.com/florianmattana/sass-king), pinned in the
data file to revision `079016969849858c781f8ff315fc018cc04a89ed`. Each affected tooltip
links to its evidence page and records the observed target and confidence. No SASS King
source code or corpus files are bundled here.

SASS King is provided under the Apache License 2.0 — see the
[upstream license](https://github.com/florianmattana/sass-king/blob/079016969849858c781f8ff315fc018cc04a89ed/LICENSE).
