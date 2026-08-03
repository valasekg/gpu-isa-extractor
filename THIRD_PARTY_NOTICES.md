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
