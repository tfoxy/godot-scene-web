# Vendored HarfBuzz GPU encoder

A **vendored third-party binary**, not a build output. `dist/` is the tsdown TypeScript build and
stays gitignored; this directory is committed, because a wasm that only exists after a docker pull
and an emscripten run is a package a fresh checkout cannot use at all.

Everything here is reproducible from `../build.sh`, and every digest below is asserted by
`../test/vendor.test.ts` — so a rebuild that moves a byte turns the suite red until this file is
updated to match.

## What is here

| file                 |   bytes | sha256                                                             |
| -------------------- | ------: | ------------------------------------------------------------------ |
| `hb-gpu.wasm`        | 417 263 | `bfca55c32e788d5bb523ca7ae70cb895fe0c062173e2a35c4a7fb617c5b49e19` |
| `hb-gpu.mjs`         |   9 909 | `2a3626057472a1158f10dda3f1b119f10f6f711ca40a1d88e2780360d6c88a41` |
| `LICENSE-harfbuzz`   |   1 971 | verbatim `harfbuzz-14.4.0/COPYING`                                 |
| `LICENSE-emscripten` |   5 093 | verbatim `/emsdk/upstream/emscripten/LICENSE` from the image below |
| `hb-gpu.d.mts`       |       — | hand-written by this repo, not vendored                            |

`hb-gpu.wasm` is HarfBuzz's Slug GPU glyph encoder, its shader-source getters **and its OpenType
shaper**, compiled from the single translation unit `src/harfbuzz-world.cc`. `hb-gpu.mjs` is
emscripten's ES6 glue for it.

**It grew 227 049 -> 417 263 bytes (+190 KB, 1.84x) on 2026-09-01, and that was the point.** The
shaping engine was always in the translation unit; `../hb-gpu.symbols` named none of it, so `-flto`
and `--gc-sections` threw it away, and every consumer therefore loaded npm `harfbuzzjs` as a SECOND
HarfBuzz and held every font face in BOTH wasm heaps — 4.19 MiB across the pair on the phone. The
symbol list now names `hb_shape` and the `hb_buffer_*` API behind it. One binary is bigger; one
face is resident once. `../test/shape.test.ts` grades the result against npm `harfbuzzjs`, which
stays a devDependency precisely because being a different build is what makes it a check.

Both are reachable as package subpaths — `@godot-scene-web/hb-gpu/vendor/hb-gpu.wasm` and
`.../vendor/hb-gpu.mjs` — so a consumer never has to reach into the package by relative path.

**The glue is browser-first, and node works only if you hand it the bytes.** It is built with
`-sENVIRONMENT=web,worker`, so the node branch is compiled out and an import that lets the glue go
looking for its own `.wasm` aborts with "both async and sync fetching of the wasm failed". Pass
`{ wasmBinary }` — the one key `-sINCOMING_MODULE_JS_API` admits — and that path is never reached,
which is how `../test/shape.test.ts` shapes under node. `../test/vendor.test.ts` still asserts
against the file on disk, because what it checks is the file and not a runtime.

## Provenance

| what             | value                                                                                                      |
| ---------------- | ---------------------------------------------------------------------------------------------------------- |
| HarfBuzz version | 14.4.0                                                                                                     |
| tarball          | <https://github.com/harfbuzz/harfbuzz/archive/refs/tags/14.4.0.tar.gz>                                     |
| tarball sha256   | `46dc4f3b6aefc4d8256b10017186f5ebe50ea086714ab8948cdac4695a7a80a8`                                         |
| toolchain image  | `emscripten/emsdk@sha256:96617f27fe16421588241def73908fd348a7f9d260440ed0d00b36dcf7a063cc` (manifest list) |
| — linux/amd64    | `sha256:3ba391c5b1554e06f9af0a69652ff20919dff14e771619339dba988bd62574b5`                                  |
| — emcc in it     | 6.0.9 (`4e4223852a0835923411059a3929907d7df1232e`)                                                         |

A tag is not a pin: GitHub builds those archives on demand and a tag can be moved, so `build.sh`
checksums the tarball and refuses to compile different bytes under the same version. The image is
pinned by digest for the same reason — it used to be `emscripten/emsdk:latest`, which made the
toolchain a moving target while the source was nailed down.

To re-resolve the image digest after a deliberate toolchain bump:

```bash
docker buildx imagetools inspect emscripten/emsdk:latest   # -> Digest: sha256:...
```

## Reproducing

```bash
packages/hb-gpu/build.sh
```

Docker is the only prerequisite; the script fetches and checksums the tarball, copies upstream's own
`util/gpu/web/config.h` and `config-override.h`, compiles inside the pinned image as the invoking
uid, and prints the sizes and digests above. If nothing in `build.sh` or the pinned inputs changed,
the rebuild is byte-identical and `git status` stays clean.

**Measured, not assumed.** Rebuilt on 2026-09-01 on linux/amd64, on a different checkout of the same
commit, and both outputs came out byte-for-byte equal to the ones committed here — including across
the removal of the dead `-DHB_GPU_ATLAS_2D` flag, which reaches only `util/gpu/demo-atlas.cc` and is
not in this translation unit.

**Still byte-reproducible across the shaper change.** The digests above were produced by one build
and then reproduced by a second, from the same pinned tarball and the same pinned image, after only
comment edits to `../hb-gpu.symbols` — which the emscripten response-file parser drops, so the
export list, and therefore the binary, is unchanged by them.

## Change-frequency policy

**This binary changes only on a deliberate HarfBuzz version bump, build-flag change, or edit to
`../hb-gpu.symbols`.** That third trigger is the one that produced the change of 2026-09-01, and it
is the least obvious: the symbol list is what `-flto` and `--gc-sections` prune against, so adding
one name can pull in a whole subsystem — `hb_shape` brought +190 KB of OpenType shaper with it.

It is not regenerated by `pnpm build`, it has no watch mode, and nothing in CI writes to it. A bump
is a conscious act, and it must land as one commit that updates, together:

- the rebuilt `hb-gpu.wasm` / `hb-gpu.mjs`,
- `HB_VERSION` / `HB_SHA256` / `IMAGE` in `../build.sh`,
- every digest and size in this file,
- the exported-function floor in `../test/vendor.test.ts`, if the symbol list changed,
- `LICENSE-harfbuzz` and `LICENSE-emscripten`, if the upstream texts moved.

A diff that touches the binary and not this file is the failure mode this policy exists to prevent;
`../test/vendor.test.ts` fails on exactly that.

## Licensing

Both are permissive and compatible with this repo's MIT license. The obligation is attribution, and
shipping the texts here is how it is discharged — they must travel with the binaries.

- **HarfBuzz** — "Old MIT" (`LICENSE-harfbuzz`, verbatim `harfbuzz-14.4.0/COPYING`): the copyright
  notice and the two disclaimer paragraphs must appear in all copies. The only other `COPYING` in
  the tarball is `test/COPYING`, and `test/` is not compiled, so every source that reaches this wasm
  is under the text shipped here.
- **Emscripten** — MIT / University of Illinois NCSA, dual (`LICENSE-emscripten`). This covers the
  ~8 KB of JS glue and the emscripten-supplied runtime pieces linked into the wasm.
