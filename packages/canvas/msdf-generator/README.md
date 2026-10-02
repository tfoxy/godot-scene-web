# Runtime MTSDF generator

This generic generator receives font bytes and glyph IDs; text shaping stays on
the consumer's main thread with its existing HarfBuzz instance. It emits linear
RGBA8 tiles: RGB is MSDF and alpha is a true SDF. A blank glyph keeps its pen
advance and returns an empty tile. Glyph metrics use a 48 px/em baseline and
include the tile's left/top offset from the baseline origin.

Accepted full distance ranges are 8, 16, and 32 pixels. Pass the selected full
range to the Rust canvas GlyphRun `pxRange` field. A tile gets half the range
plus two guard pixels on each side. The worker accepts transferable font buffers
and transfers individual tile buffers back; the caller retains any font it
needs by sending a copy. A request accepts up to 256 glyph IDs and at most
1 MiB of aggregate RGBA tile pixels. Rust sizes the whole batch before creating
any raster image. During the WASM-to-JavaScript transfer, both Rust pixels and
JavaScript tile arrays exist briefly; the one-batch cap keeps their combined
pending tile storage below 4 MiB. Font bytes and the WASM heap are separate
from that tile budget. Call `result.release()` after uploading or discarding
tiles before starting another request. Concurrent calls reject without
transferring their font buffer. Invalid font bytes or glyph IDs reject that request.
A worker load or message failure rejects all pending work; there is no retry
loop. The client creates one worker lazily and disposes it explicitly.

Build from the repository root:

```sh
mise exec -- bash packages/canvas/msdf-generator/scripts/build-web.sh
mise exec -- python3 packages/canvas/msdf-generator/scripts/check-licenses.py
```

The ignored output is `.sts2/msdf-generator-web/`. The consuming host serves
`msdf_generator.js` and `msdf_generator_bg.wasm` together and passes the glue
URL as `wasmModuleUrl` to `MsdfGenerator` from
`@godot-scene-web/canvas/msdf-generator`. The canvas package builds and
publishes `msdf-generator-worker.js`; consumers of source can supply their own
`createWorker` factory if their bundler needs one.

This crate's WASM is distributed separately from the canvas npm package. Ship
`THIRD_PARTY_NOTICES.md` and `licenses/` with a deployed copy of the WASM.
`test/fixtures/` is a licensed, portable test fixture and is not shipped.

The overlap contour test covers a union of two intersecting rectangles, and
the browser operation probe covers B/O/@ contours from the fixture font.
Further font-specific fidelity is a consumer QA step because no game fonts are
committed here.
