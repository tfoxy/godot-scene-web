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
the instances in its scope get that slot rewritten in place. So does a
glyph run that keeps its glyph count, and a raster label whose patch swaps its
texture key when that is a pure slot rename: the old key is drawn by that label
alone within its draw, and a fresh build would batch the new key into the same
slot. The draw then rebinds; nothing else does. Other blend, texture, or
tile-count changes rebuild the draw table. Bind groups are cached
until a resource texture changes. Two picture textures and the surface quad
are reused between presents.

### GPU backends

`Renderer<B: GpuBackend>` (`src/renderer.rs`) holds everything that is not a
GPU call: the contract, staging, geometry, the damage plan, the bind caches,
residency and every counter. The GPU calls go through the `GpuBackend` trait
(`src/backend/mod.rs`): textures and binds, the instance buffer and design
size, frame acquisition, one validation scope per present, the picture pass
(whole or scissored to the damage rectangles) with the surface copy, and the
present. `WgpuBackend` (`src/backend/wgpu_backend.rs`) is the one
implementation; `create` and `createWithPresent` build on it.

### Damage present (opt-in)

`set_damage_present(true)` keeps the committed picture and redraws only what a
present can change. Off (the default), every present replays every draw into a
cleared picture, exactly as before. On:

- The damage is the union of the old and new device bounds of every changed
  instance, plus the old footprint of any draw whose texture list or texture
  pixels changed (any `upload_rgba_batch` op on a key it samples). A changed
  clip changes the clip slots of every instance in its scope, so those
  instances carry it. Bounds are the corner box of the transformed quad,
  clipped by its clip slots and widened by one device pixel.
- At most four damage rectangles are kept. Each is redrawn in place with
  `LoadOp::Load`: scissor, clear to transparent with a non-blending quad,
  then every draw whose footprint reaches it, in order. Blending is
  order-dependent, so unchanged draws under the damage are replayed too.
- The picture is redrawn whole on the first present, after a resize, a
  failed validation or a design-size change, when the draw table's shape
  changes, or when the damage covers more than half of the surface.
- In the default `surface` present mode the copy to the canvas stays
  full-screen: wgpu treats every acquired surface texture as uninitialized
  and clears it before a `LoadOp::Load`, and its WebGL2 present redraws the
  whole swapchain texture into the canvas. Only the `preserved` modes below
  copy just the damage.
- A present with nothing staged, or whose damage is empty, runs no GPU work
  and writes nothing to the canvas; the canvas keeps the previous frame. Its
  result is `presented: true` with `damage: "skip"` and `blitPixels: 0`.

### Present modes

`await RustRenderer.createWithPresent(canvas, mode)` picks how the picture
reaches the canvas; `create(canvas)` is `"surface"`. An unknown mode is an
error, and `present_mode` reports the mode in use.

- `"surface"` (default): wgpu's surface. A full-screen copy pass draws the
  picture into the acquired surface texture, then wgpu-hal's present draws
  that texture into the canvas. Two full-surface passes per presented frame.
- `"direct"`: the renderer creates the canvas's WebGL2 context itself
  (`antialias: false`, every other attribute at the WebGL default, as wgpu's
  surface does), builds the adapter on it with
  `wgpu_hal::gles::Adapter::new_external`, and creates no surface. A present
  draws the committed picture straight into the default framebuffer with
  wgpu-hal's own sRGB present shader and sampling state: one full-surface
  pass, the same pixels. The surface format wgpu picks on WebGL2 is
  `Rgba8UnormSrgb`, so wgpu-hal's present is that shader, not a
  `blitFramebuffer`, and a framebuffer blit would decode the sRGB picture.
- `"preserved"`: `direct` with `preserveDrawingBuffer: true`. After a partial
  redraw the present runs only inside the damage rectangles (scissored); a
  full redraw, the damage present off, and the first present after creation
  or a resize copy the whole picture.
- `"preserved-desync"`: `preserved` plus `desynchronized: true`.

A lost context is recovered as before, by creating a new renderer, whose
first present is full. Every result carries `present` (the mode) and
`blitPixels`: the pixels this present wrote to the canvas (0 on a skip or
failure, the whole surface for `surface`, `direct` and full presents, the
damage area for a `preserved` partial). In the direct modes `draws` no longer
counts the surface copy, and `presented: true` means the canvas draw was
issued. All four modes work with the damage present on or off.

Each result then carries `damage` (`"partial"`, `"full"` or `"skip"`) and
cumulative `damageStats`. `set_damage_verify(true)` re-derives every partial
plan by brute force from the full old and new instance arrays; a plan that
misses a changed bound counts in `damageStats.verifyMismatches` and is
redrawn whole instead. It shares the planner's bounds model and dirty-key
set, so it catches bookkeeping slips, not a wrong model: it is not pixel
evidence. The pixel evidence is the integration leg below. The integration gate below runs a seeded sequence of
patches, clip moves, MSDF glyph runs cut by a damage edge, re-admissions,
texture swaps, subrect rewrites under unchanged draws, uploads followed by an
empty present, and empty presents through a damage renderer and a default
one at a 3.49 device scale, and requires byte-identical screenshots after
every step.

### Idle animations (`RIA1`)

A caller whose steady frames only move a few retained subtrees through periodic
loops (a bob, a spin, a pulse) can hand those loops to the renderer instead of
sending a patch per frame. `set_idle_anims(bytes)` installs a descriptor set
for the committed scene revision; `present_idle(t_ms)` is one idle frame. It
samples every loop at `t_ms`, re-poses the commands the set targets, and
presents through the ordinary patch path (instance spans, damage plan, partial
redraw, the same validation), synchronously. The scene revision does not move,
so the caller's next patch applies on top; any admission or patch that commits
a new revision makes the set stale, and `present_idle` refuses it until a new
set is installed. The result is a bit set (`1` presented, `2` skip, `4`
partial, `8` full, `16` no command moved), `0` on a refusal, with the reason in
`idle_stats()`. `idle_last_result()` returns that present's full result
(`present()`'s JSON) for diagnostics.

A root is a curve (`rest`, `rotate`, `rock`, `bob`, `pivotPulse`,
`pulseScale`) with a phase origin, offset and period, composed into its
subtree's placement: `phase = ((((t - origin + phaseMs) / periodMs) % 1) + 1) % 1`,
`raw = base · (pre · wire) · post`, `draw = outer · [raw.linear, raw.tx +
spreadDx, raw.ty]`, `delta = draw · inverse`. A target is one placed command
(`quad`, `ninePatch`, `rasterText`, `stillImage`, `glyphRun`): `group`
(`m = (P · delta) · Q`), `primitive` (`m = C · Q`, `C` its root chain's
deltas composed outermost first, each translated by the command's spread offset
from that root) or `text` (`m = P · ((C · Q) · R)`). Every operation is the
caller's f64 arithmetic in the caller's order, and the browser build takes
`cos`/`sin` from the page's `Math`, so a pose is bit-identical to the same pose
computed in the page; `idleEvaluate(bytes, t_ms)` returns those poses without a
renderer. Alpha curves are refused: they change paint, not placement.

The wire format is little endian: ASCII `RIA1`, u32 version 1, the base
revision as two u32 halves, u32 root and target counts; per root u32 curve, u32
flags (bit 0: has wire), 12 f64 curve parameters (amplitudeRad, amplitudePx,
baselineUpPx, scaleFrom, scaleTo, alphaFrom, alphaTo, pivotX, pivotY, originMs,
phaseMs, periodMs) and 25 f64 of placement (base, wire, outer, spreadDx,
inverse); per target u32 command index, u32 mode, u32 chain length, per link
u32 root, u32 reserved, f64 offset, then P, Q and R (18 f64). Browser callers
encode with `encodeRustIdleAnims`, and read a committed retained scene's group
members and text placements with `rustRetainedGroupMembers` and
`rustRetainedTextPlacement` (`RUST_IDLE_ANIMS` advertises them).

Every present now resolves its validation scope synchronously: wgpu-core's
error-scope pop is ready on its first poll, so `present()` and `present_idle`
check validation before presenting exactly as before, without suspending. A
present also writes the design-size uniform only when the design size changed.

The integration gate ends its damage sequence with an idle leg: one set over
group members, a primitive, a nested chain with a spread offset, a glyph run
in text mode and a root at rest, then 24 idle frames at seeded clocks. Every
renderer but the full-redraw reference presents them with `present_idle`; the
reference applies the same poses as patches; every step must be byte-identical.
A re-admission then makes the set stale, and `present_idle` must refuse it.

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
`apply_patch(bytes)`, `resize(width,height)`, `await present()`, and `dispose()`,
the idle-animation methods above,
plus the optional `set_draw_state_dedupe`, `set_damage_present` and
`set_damage_verify` switches. `GSW_RUST_DAMAGE_PRESENT=1` runs the
integration and fault legs with the damage present on, and
`GSW_RUST_PRESENT_MODE=<mode>` runs their main Rust steps through
`createWithPresent`. `GSW_RUST_PRESENT_PARITY=1` adds `direct`,
`preserved` and `preserved-desync` renderers (damage on, and `direct` and
`preserved` with it off) to the damage sequence, appends a resize, and
requires each to match the full-redraw surface renderer byte for byte after
every step, with `blitPixels` checked per step.
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
`version: 1`: they carry command replacements and revisions, plus, only when a
patch changes it, the scene's next resource list.
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
[{id,command}]`, each a full same-kind command replacement, and optionally
`resources: [{key,width,height}]`, the scene's complete resource list after the
patch. That list may add keys (already uploaded at the declared size) and drop
keys no command still names, but cannot resize a kept key. The renderer's
`patch_resources` property is `true` when it accepts the field; an older
renderer refuses such a patch. Revisions, shape, clip balance and resources are
checked atomically. Unsupported command kinds
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
A sixth argument, `{ texts: [{ record, carrier }] }`, replaces text commands
with exactly what a full admission emits for those records and carriers
(`RUST_RETAINED_TEXT_PATCH` advertises it). The record must keep its command id,
parent group and method. A raster carrier may name a new key: the patch then
carries the next resource list in full-admission order, `resourcesChanged` is
true, and `textUploads` lists the pixels to upload before applying it. Release
the old key only after the patch presents.
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
