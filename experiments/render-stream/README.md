# render-stream

render-stream is an engine-side capture of Godot's 2D canvas. A GDExtension loaded into an
**unmodified official Godot 4.5.1 release template** observes every `RenderingServer` canvas,
texture, mesh, shader and material call the running game makes, mirrors the resulting canvas
state, and publishes it as a versioned wire protocol (`render-stream/0` through `/14`). Receivers
replay that stream onto their own renderer, live over WebSocket (or an opt-in carrier) or from a
recording file:

- the native receiver, a Godot project replaying onto its own `RenderingServer`;
- the same project exported for the web (Godot's web template);
- the GSW canvas receiver, a browser page over this toolkit's Rust/WebGL canvas executor.

All three share one Rust core that decodes, validates and resolves the stream. The capture runs
headless (no window, no GPU work on the host) and is the streaming backend of a real product
(Slay the Spire 2, through CouchCoop). Downstream release builds take `capture/`, `rs-core/`,
`rs-net/`, `web/gsw-rs/`, `third_party/`, `scripts/build-rs-net.sh` and `scripts/lib/quiet.sh`
from this tree, so keep those buildable on their own.

## Layout

| Path                          | What it is                                                                                                                                                                                                                                                                                                                                                                               |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `capture/`                    | The capture GDExtension (C++, CMake): `RenderingServer` hooks, the mirror, codecs for every wire version, the live listener and HTTP payload server, texture decode/encode workers. `capture/test/` holds its ctest unit tests; `capture/vendor/` the vendored `gdextension_interface.h`, zlib and zstd (see `PROVENANCE.md`); `capture/tools/calibrate.py` derives calibration records. |
| `calibration/`                | Committed calibration records, keyed by the engine binary's sha256. The capture refuses to arm on a binary whose record does not match.                                                                                                                                                                                                                                                  |
| `rs-core/`                    | `render-stream-core`, the shared Rust core: decode, validation, resolution, the packed draw list, plus the `rs-core-check` CLI.                                                                                                                                                                                                                                                          |
| `rs-core-capi/`               | The core's C ABI as a staticlib, linked into the native receiver's GDExtension adapter and the web export's side module.                                                                                                                                                                                                                                                                 |
| `rs-net/`                     | `render-stream-net`, an optional runtime-loaded Rust module for the capture: WebTransport and TLS for the live listener (patched `wtransport` vendored under `rs-net/vendor/`).                                                                                                                                                                                                          |
| `receiver/`                   | The native receiver (a Godot project with a GDExtension adapter over the core) and its web-export preset. See [receiver/README.md](receiver/README.md).                                                                                                                                                                                                                                  |
| `web/gsw-rs/`                 | `rs-gsw-wasm`: the core and the canvas-items executor in one wasm module.                                                                                                                                                                                                                                                                                                                |
| `web/gsw-receiver/`           | The GSW canvas receiver page (TypeScript over `rs-gsw-wasm`).                                                                                                                                                                                                                                                                                                                            |
| `web/basis-transcoder/`       | The KTX2/Basis transcoder wasm and its Web Worker, for GSW's compressed texture variants.                                                                                                                                                                                                                                                                                                |
| `web/client-*/`, `web/bench/` | Browser check pages for the client package legs, and decode benches.                                                                                                                                                                                                                                                                                                                     |
| `decode-proto-rs/`            | A small Rust decode prototype and its wasm bench.                                                                                                                                                                                                                                                                                                                                        |
| `benches/`                    | Committed instruction-count baselines for the capture benches.                                                                                                                                                                                                                                                                                                                           |
| `third_party/`                | Vendored third-party sources (`basis_universal`), with provenance.                                                                                                                                                                                                                                                                                                                       |
| `protocol/`                   | The wire specs (below), golden vectors (`golden/`, `golden-1/` … `golden-14/`), per-receiver feature manifests (`features/`) and the [capture environment reference](protocol/streaming-host.md).                                                                                                                                                                                        |
| `fixtures/`                   | Godot scene fixtures the gate runners capture and replay; each has a README.                                                                                                                                                                                                                                                                                                             |
| `scripts/`                    | Build scripts, gate runners (`run-gate*.sh`), checkers (`check-gate*.ts`), the smoke tier, the quiet lock and the self-tests. See [scripts/README.md](scripts/README.md).                                                                                                                                                                                                                |

## Prerequisites

- The repo's mise toolchain (`mise exec -- ...`), a C++20 compiler and CMake, stable Rust with the
  `wasm32-unknown-unknown` target, and `wasm-bindgen` CLI 0.2.129. The web export also needs the
  pinned emscripten (4.0.11) and a Rust nightly for `-Zbuild-std`; `build-rs-core-web.sh` says
  which.
- The pinned engine: the official Godot 4.5.1 Linux release export template at
  `~/.cache/godot-render-stream/templates/4.5.1-stable/linux_release.x86_64` (its sha256 is in
  `calibration/godot-4.5.1-stable-linux-release.json`), plus a Godot 4.5.1 editor for the one
  `--import` pass each project needs before the template can run it (see
  [fixtures/spike/README.md](fixtures/spike/README.md)).
- Rendered legs run inside a private `gamescope --backend headless`, never Xvfb or the desktop.
- Cargo builds are offline: every crate comes from the local registry, pinned by each crate's
  `Cargo.lock`.

## Building

Every build script holds the machine-wide quiet lock shared (`scripts/lib/quiet.sh`), so it waits
while a timing measurement runs. Run them from anywhere; paths are resolved from the script.

```bash
S=experiments/render-stream/scripts

# Capture GDExtension: configure, build and run its ctest suite.
# Prints capture/build/render_stream_capture.gdextension.
bash $S/build-capture.sh [Release|Debug]

# Optional net module (WebTransport, TLS), after build-capture.sh:
# capture/build/librender_stream_net.so.
bash $S/build-rs-net.sh [--no-test]

# Shared Rust core: the rs-core-check CLI and the rs-gsw-wasm module for GSW,
# into artifacts/render-stream/rs-core/<sha>/ (latest -> newest).
bash $S/build-rs-core.sh [--native-only|--wasm-only]

# Native receiver adapter: receiver/ext/build/librs_core_ext.so.
# Needed once per checkout before any native receiver launch.
bash $S/build-rs-core-ext.sh [--no-test]

# Web export receiver: first the core as an emscripten side module, then the export.
# The bundle lands in artifacts/render-stream/web-receiver/<sha>/bundle/.
bash $S/build-rs-core-web.sh
bash $S/build-web-receiver.sh --core rust [--out DIR] [--force]

# GSW receiver bundle (page + esbuild bundle + rs-gsw-wasm), printed directory:
mise exec -- pnpm exec tsx --conditions=development $S/gate7-tool.ts gsw-bundle --out <dir>

# KTX2/Basis transcoder wasm for GSW:
bash $S/build-basis-transcoder.sh
```

`scripts/calibrate.sh --check` re-derives the committed calibration record and diffs it.
`scripts/prepare-textures.sh --cache <dir> (--project <dir> | --images <dir> | --list <file>)`
fills the capture's persisted texture cache before a session runs.

Build outputs and run evidence go under the repo's ignored `artifacts/render-stream/` (or the
ignored `build/` directories next to the sources). Nothing generated is committed.

## Testing

- **Unit tests**: `build-capture.sh` runs the capture's ctest suite; `build-rs-net.sh` and
  `build-rs-core-ext.sh` run their crates' tests; `cargo test --offline --release` in `rs-core/`
  runs the core's tests, and `rs-core-check goldens` (built by `build-rs-core.sh`) checks it against
  the golden vectors.
- **Pure self-tests** (no engine, no lock):
  `bash experiments/render-stream/scripts/test/run-pure-self-tests.sh` runs every
  `scripts/test/self-test-*.ts` and each golden directory's `make_golden.py --check`.
- **Gate runners**: `scripts/run-gate-minus1.sh`, `run-gate0.sh` … `run-gate8.sh` and
  `run-gate55.sh` drive the fixtures through capture, reference render and receiver replay, then
  call their `check-gate*.ts` checker, which writes `result.json` and exits non-zero unless the
  gate passes. Native runners take `--extension <capture .gdextension> --calibration <record>`;
  `run-gate7.sh` runs the browser receivers over sources made by the native runners.
- **Smoke tier**: `bash experiments/render-stream/scripts/validate-increment.sh --plan` maps the
  current diff to the gates and receivers it can reach; without `--plan` it runs them.

Usage, flags and environment for all of these are in [scripts/README.md](scripts/README.md).

## Wire specs

Each version extends the one before it; a receiver states the versions it speaks in its hello.

| Spec                                             | Adds                                                                                                              |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| [render-stream-0](protocol/render-stream-0.md)   | Record framing, the session, transactions of canvas items and their draw commands.                                |
| [render-stream-1](protocol/render-stream-1.md)   | Retained state with full and patch encodings, and the live WebSocket transport with acks and credit.              |
| [render-stream-2](protocol/render-stream-2.md)   | Content-addressed texture payloads, the out-of-band resource store and HTTP payload GETs.                         |
| [render-stream-3](protocol/render-stream-3.md)   | MSDF text draws.                                                                                                  |
| [render-stream-4](protocol/render-stream-4.md)   | Immediate geometry ops, transforms and clip-ignore inside items, and meshes.                                      |
| [render-stream-5](protocol/render-stream-5.md)   | Shaders and materials, instance parameters and canvas modulate.                                                   |
| [render-stream-6](protocol/render-stream-6.md)   | Presentation size and stretch, and canvas layers.                                                                 |
| [render-stream-7](protocol/render-stream-7.md)   | Browser live transport: hello with token, credit window and feature manifest (live only).                         |
| [render-stream-8](protocol/render-stream-8.md)   | Late-join adoption, host-decoded block-compressed and float texture payloads.                                     |
| [render-stream-9](protocol/render-stream-9.md)   | Texture delivery variants (`decoded`, `block`, KTX2 `uastc`) and the delivery hello keys.                         |
| [render-stream-10](protocol/render-stream-10.md) | Canvas-group mode and copy-to-backbuffer item state.                                                              |
| [render-stream-11](protocol/render-stream-11.md) | Pruned carried set, dynamic mesh surfaces by id, stable content versions, multimesh, live message coding.         |
| [render-stream-12](protocol/render-stream-12.md) | Particle emitters (the receiver simulates them), and headless defaults for CanvasTexture and particle identities. |
| [render-stream-13](protocol/render-stream-13.md) | A second syntax for `/12`'s model: binary transaction records and predicted mesh/multimesh blocks.                |
| [render-stream-14](protocol/render-stream-14.md) | Item metadata v2 identity.                                                                                        |
