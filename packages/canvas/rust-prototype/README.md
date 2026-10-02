# Rust WebGL canvas renderer

This crate renders an admitted Godot CanvasItem draw list through WebGL2.
Scene production, hit geometry, networking and input stay with the caller.

The WebGL2 path uses one instance per visible tile and keeps command order.
Each draw uses up to eight texture slots selected by a static shader switch.
Blend changes or a ninth distinct texture start another batch. Creation refuses
an adapter with fewer than eight sampled texture slots. The instance buffer
grows by powers of two and is reused. A shape-preserving patch re-emits only
its changed commands and uploads differing instance ranges. A replaced
`clipPush` keeps the draw table too: clips live in per-instance clip slots, so
the instances in its scope get that slot rewritten in place. Blend, texture, or
tile-count changes rebuild the draw table. Bind groups are cached
until a resource texture changes. Two picture textures and the surface quad
are reused between presents.

## Browser build

`cargo` and a matching `wasm-bindgen` CLI (0.2.129) are required. Run
`packages/canvas/rust-prototype/scripts/build-web.sh` from any directory. Its
ignored output defaults to `.sts2/rust-prototype-web/rust_prototype.js` and
`rust_prototype_bg.wasm`; `GSW_RUST_PROTOTYPE_OUT` and
`GSW_WASM_BINDGEN_CLI` override output and CLI paths. Import the generated JS,
`await init()`, then `await RustRenderer.create(canvas)`.

After building, run `mise exec -- node packages/canvas/rust-prototype/scripts/test-web-pixels.mjs`
from the repository root. The browser test checks a half-transparent red scene
through generated Wasm and writes its PNG witness under ignored
`.sts2/rust-webgl-proof/`. It requires Playwright Chromium.

For the source integration gate, run
`mise exec -- node packages/canvas/rust-prototype/scripts/test-integration-browser.mjs`
after the WebAssembly build. It bundles the current canvas TypeScript source,
drives Rust, retained WebGL and Pixi in Chromium, and writes 12 screenshots plus
an artifact hash and pixel receipt under ignored `.sts2/rust-webgl-integration/`.

To check GPU validation rollback with the optional test feature, use a separate
ignored artifact directory:

```bash
GSW_RUST_PROTOTYPE_FEATURES=webgl,fault-injection \
  GSW_RUST_PROTOTYPE_OUT="$PWD/.sts2/rust-prototype-web-fault" \
  packages/canvas/rust-prototype/scripts/build-web.sh
GSW_RUST_PROTOTYPE_OUT="$PWD/.sts2/rust-prototype-web-fault" \
  GSW_RUST_FAULT_INJECTION=1 \
  mise exec -- node packages/canvas/rust-prototype/scripts/test-integration-browser.mjs
```

This writes a separate `.sts2/rust-webgl-fault/receipt.json` and PNG set. The
fault leg checks that a staged visible patch fails GPU validation, leaves the
committed revision and picture intact, and succeeds when reapplied.

The browser methods are `upload_rgba_batch(bytes)`, `admit_scene(bytes)`,
`apply_patch(bytes)`, `resize(width,height)`, `await present()`, and `dispose()`.
Admission and presentation return JSON strings for a batch-sized JS/WASM
boundary. `backend`, `upload_calls`, `upload_bytes`, `texture_creations`, and
`present_calls` are readable properties. Each present result also includes
per-call `draws`, the adapter's `maxSampledTextures`, and cumulative
`drawCalls`, `bufferCreations`, `textureCreations`, `uploadBytes`,
`instanceUploadBytes`, `completedPresents`, `incrementalPatches`,
`geometryRebuilds`, and `wasmCalls`. `uploadBytes` counts GPU resource pixel
and instance writes, including restoration after failed validation; it
excludes wire headers. `presented: true` means the scene and surface passes
passed one awaited wgpu validation scope and `queue.present` was called. It is
not proof that the browser compositor displayed that frame. The caller
publishes matching hit geometry only after this result.

## Wire contract (`scene/2`, `patch/1`, `RSR1`)

Scene and patch buffers are UTF-8 JSON. A scene has `version: 2`, a
monotonically increasing `revision`, backing-surface pixel `width,height`,
logical `designWidth,designHeight`, `resources: [{key,width,height}]`, and
ordered `commands`. Quad transforms and clip coordinates use design space;
the vertex stage projects through `designWidth,designHeight` into the configured
surface. The surface must match the scene's `width,height`. Patches remain
`version: 1` because they carry only command replacements and revisions.
Commands have stable `id` and tagged `kind`; `encodeRustScene` names a command
its plan does not name `c<draw-list index>`:

- `quad`, `rasterText`, `stillImage`: `resource` (key or null), affine `m`
  `[xx,xy,yx,yy,ox,oy]`, destination `w,h`, page-pixel crop `src`
  `[x,y,w,h]`, premultiplied linear tint `color` `[r,g,b,a]`, `blend`
  (`mix` or `add`), `flipH`, `flipV`, optional row-major `colorMatrix` (9 floats).
- `ninePatch`: quad fields plus page-pixel `margins`
  `[left,top,right,bottom]`.
- `clipPush`: design-space `rect` `[x,y,w,h]`, `radius`, horizontal `outset`.
  `clipPop`: just `id` and `kind`. Three nested clips are supported.

A patch has `version`, `baseRevision`, new `revision`, and `updates:
[{id,command}]`, each a full same-kind command replacement. Revisions, shape,
clip balance and resources are checked atomically. Unsupported command kinds
are counted and refused; they are never silently skipped. Admission refuses
until every resource is uploaded at the declared dimensions.

Resources are a separate binary batch: ASCII `RSR1`, little-endian u32 count,
then repeated little-endian u32 `keyByteLength,width,height,pixelByteLength`,
UTF-8 key bytes and tightly packed RGBA8 pixel bytes. Pixel RGB is **straight-alpha sRGB**, sampled into linear shader space. Duplicate unchanged uploads are ignored; changed keys recreate only
their own GPU texture. Browser callers can use `encodeRustScene`,
`encodeRustPatch`, and `encodeRustResources` from
`@godot-scene-web/canvas/rust-prototype`. `encodeRustScene` accepts a DrawList,
text records, a scene plan and resource/text resolvers, with both design and
surface dimensions supplied explicitly. It preserves unknown kinds for refusal.
Raster text images must already exist; Rust does not shape text. Raster text
opacity is encoded as premultiplied tint `[a,a,a,a]`.

`encodeRustRetainedPatch(base, revision, updates, groupTransforms)` accepts
complete changed command records and optional group-local transforms from the
last completed typed scene. It expands group changes into affected command
matrices, including raster text, and returns patch bytes plus a candidate typed
scene. The caller publishes that candidate only after presentation succeeds.
An update may include `localTransform` from a retained primitive change. The
serializer composes it with its parent group and preserves any raster text
carrier inset from full scene admission; this field stays out of patch/1 bytes.
The returned `changedIndexes` identifies every replaced command, including
group-expanded descendants, so retained caches can update those entries only.
A clip moves by translation only: an update may replace a `clipPush` whose
size, radius and outset are unchanged, and a group change carries the clips
placed through that group along when the group's world moved by a pure
translation. An admitted clip is re-placed exactly as admission places it (the
current world times its draw-list rect); one placed by an explicit update moves
by the world's change since that update, so chained patches do not accumulate.
An explicit update of the same clip in one patch wins over the group's
translation, but not over a scale or rotation, which returns `null`. Any other clip change, changed resource keys or blend modes,
unknown IDs, and unsupported changes return `null` so the caller can admit a
full scene. An older renderer applies a clip replacement by rebuilding its
geometry, so emitting one stays compatible.

Scene changes render into the picture texture opposite the committed one. The
candidate pass and surface pass share one encoder and submission. Validation is
awaited before `queue.present`; a validation failure discards the staged scene
and restores changed instance ranges. A refused admission, failed patch, missing
texture, surface acquisition failure, or validation failure keeps the last
committed scene and picture, and `present` does not publish the candidate.
Device loss or failures after the compositor accepts `queue.present` remain
outside this guarantee and require browser/process presentation evidence.

The optional test-only `fault-injection` feature exposes
`debugValidationFailureOnce()` for the browser rollback fixture. It is not
enabled in normal builds. Detailed CPU phase timing belongs in separate
diagnostic runs and is absent from the normal present path.

## Scope limits

Group transforms are flattened into world-space commands. Fractional group
alpha and rotated/nonuniform clips are explicitly refused; exact group
compositing is not implemented. Native text is a raster image carrier. The
renderer uses ordered eight-texture batches. Its `presented` result is
an executor completion signal, not evidence of browser compositor display.
