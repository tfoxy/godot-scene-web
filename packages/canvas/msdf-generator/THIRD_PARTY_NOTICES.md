# MTSDF generator third-party notices

The generated `msdf_generator_bg.wasm` is built from this crate and the dependencies
selected in `Cargo.lock`. The machine-readable `licenses/manifest.tsv` lists the
40 third-party packages in the `wasm32-unknown-unknown` normal dependency graph,
the licence choice for each package, and the one-level licence file shipped with
it. Host builds also use procedural macros; the manifest includes them
conservatively. Cargo's lockfile records additional optional dependency versions
that are not in this target graph.

`fdsm` 0.8.0 and `fdsm-ttf-parser` 0.2.0 declare MIT, but their crates.io
archives omit the licence file. Their copied MIT text is from the upstream
[fdsm repository](https://gitlab.com/Kyarei/fdsm/-/raw/main/LICENSE), with
copyright (c) 2023 +merlan #flirora. Other licence files are copied from the
corresponding crates.io package archives at the versions in the manifest.

`unicode-ident` combines MIT with Unicode-3.0; its manifest entry contains
both terms. The test-only Liberation Sans Narrow font is licensed separately
under SIL OFL 1.1 at `test/fixtures/OFL.txt`. It is not embedded in the WASM.

A consumer shipping the generated WASM should ship this notice and the entire
`licenses/` directory alongside it. The canvas npm package ships the worker
JavaScript but does not contain the separately built generator WASM.
