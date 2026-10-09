# Gate 0 design: independent reference and one rectangle

Status: contract for gate 0, which passed on 2026-10-09 (see "Gate 0 result" in
[../README.md](../README.md)). This document is self-contained: an agent
implementing any work package below should need only this file,
[render-stream-0.md](render-stream-0.md) (the bytes),
[`capture/src/rs0_snapshot.h`](../capture/src/rs0_snapshot.h) (the C++ model) and the golden
vectors in [`golden/`](golden/). Background is in
[docs/handoff-headless-render-stream.md](../../../docs/handoff-headless-render-stream.md):
"Capture and receiver contract", the gate 0 row, and "Validation and measurement". Gate −1's
library, its runtime contract and its safety model are described in [../README.md](../README.md).

Source citations are `path:line` in the pinned `../godot-4.5.1-stable` checkout (commit
`f62fdbde15035c5576dad93e586201f4d41ef0cb`), relative to its root. Every line cited here was
re-read when this contract was written.

## What gate 0 proves

The handoff's gate 0 row sets the bar:

> Run an ordinary rendered fixture, a CPU-only capture host — the stock engine template plus the
> capture extension — and a receiver. Replay a recording of one opaque rectangle. Compare actual
> pixels and independently expected rectangle/step-marker pixels. Prove the receiver consumed the
> stream and never loaded the source scene.

Gate 0 meets it with three independent roles:

1. **Reference.** The release template renders `fixtures/gate0/` normally in private headless
   gamescope with the capture extension absent. It takes a screenshot at each step.
2. **Capture host.** The same template, under `--headless`, loads the same fixture with the
   capture extension armed. It writes a `render-stream/0` recording and rasterizes nothing.
3. **Receiver.** The same template renders `receiver/` in private gamescope. That project has no
   autoload, no extension and no fixture file. Its only input is the recording, and it takes a
   screenshot at each step's transaction.

The checker compares both sets of screenshots, exactly, with an image synthesized from
`fixtures/gate0/expected.json`, and compares them with each other. It also proves that the stream
was consumed, that the receiver never touched the fixture, and that four kinds of sabotage and
three failure modes are each classified correctly.

## Files

```
experiments/render-stream/
  protocol/gate0-design.md            this contract
  protocol/render-stream-0.md         wire format
  protocol/golden/                    make_golden.py (+ --check), minimal.{bin,hex,decoded.json},
                                      corrupt-meta.bin, invalid/*.bin, index.json
  capture/src/rs0_snapshot.h          shared C++17 model (no engine types)
  capture/src/rs0_mirror.{h,cpp}      WP1  retained canvas mirror
  capture/src/rs0_root_query.{h,cpp}  WP1  arm-time root viewport query
  capture/src/rs0_codec.{h,cpp}       WP2  no-I/O encoder
  capture/src/rs0_publish.{h,cpp}     WP2  file sink, session id, stats, freeze/perturb sabotage
  capture/test/rs0_mirror_test.cpp    WP1
  capture/test/rs0_codec_test.cpp     WP2  byte-identical to golden/minimal.bin
  scripts/lib/render-stream-0.ts      WP2  pure TS decoder/validator
  scripts/test/self-test-rs0.ts       WP2
  fixtures/gate0/                     WP3  project.godot, loader.gd, gate0.tscn, gate0.gd,
                                           preexisting.tscn, expected.json, README.md
  scripts/lib/gate0-expected.ts       WP3  synthesize the expected 640x360 RGBA per step
  receiver/                           WP4  project.godot, main.tscn, receiver.gd, rs0_decoder.gd,
                                           rs0_applier.gd, tests/codec_selftest.gd, README.md
  scripts/run-gate0.sh                WP5  orchestrator
  scripts/check-gate0.ts              WP5  writes result.json, exit status
  scripts/lib/gate0-checks.ts         WP5  classifyLeg + checks, pure over evidence dirs
  scripts/test/self-test-gate0.ts     WP5
  capture/src/entry.cpp               WP6  wiring
```

Recordings use the extension `.rs0`. Every generated file (recordings, PNGs, logs and traces) goes
under the ignored `artifacts/render-stream/gate0/<UTC>/`.

## Q1. Arming, root adoption and unknown RIDs

### Startup order on 4.5.1

| Step                                                                                                                                       | Evidence                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| SCENE-level init of startup-listed extensions                                                                                              | `main/main.cpp:3633`                                                     |
| `register_server_singletons()` (the RS singleton becomes reachable)                                                                        | `main/main.cpp:3704`                                                     |
| `memnew(SceneTree)` creates the root `Window`                                                                                              | `main/main.cpp:4158`, `scene/main/scene_tree.cpp:2034`                   |
| Viewport ctor `world_2d.instantiate()` → `canvas_create`                                                                                   | `scene/main/viewport.cpp:5335`, `scene/resources/world_2d.cpp:104`       |
| `OS::set_main_loop`                                                                                                                        | `main/main.cpp:4232`                                                     |
| autoload nodes instantiated                                                                                                                | `main/main.cpp:4300-4352`                                                |
| main scene instantiated: `CanvasItem` ctor → `canvas_item_create`                                                                          | `main/main.cpp:4557`, `scene/main/canvas_item.cpp:1731`                  |
| `GDExtensionManager::startup()`                                                                                                            | `main/main.cpp:4632`                                                     |
| `main_loop->initialize()` → `root->_set_tree`                                                                                              | `platform/linuxbsd/os_linuxbsd.cpp:975`, `scene/main/scene_tree.cpp:577` |
| root ENTER_TREE: `viewport_attach_canvas`, `viewport_set_canvas_transform`, `viewport_set_canvas_cull_mask`                                | `scene/main/viewport.cpp:548-551`                                        |
| children enter: autoload `_enter_tree` first, so **route (a) arms here**, then the main scene's `_enter_canvas` → `canvas_item_set_parent` | `scene/main/canvas_item.cpp:272`                                         |
| `_ready` of everything, still inside `initialize()`                                                                                        |                                                                          |
| each iteration: physics, process, `message_queue->flush()`, `RS::sync()`, `RS::draw()` (skipped headless), `GDExtensionManager::frame()`   | `main/main.cpp:4802-4839`                                                |

**Decision: route (a).** The fixture autoload `loader.gd` calls
`GDExtensionManager.load_extension(OS.get_environment("GRC_EXTENSION"))` in `_enter_tree`, as
`fixtures/spike/loader.gd` does. The library arms at SCENE init inside that call. Fixture rule:
**the main scene root is a plain `Node`, and every `CanvasItem` is created in `_ready`**, after
arming, so the mirror sees each one's `canvas_item_create`.

**Frame numbering.** The hooks stamp each call with `frames_total + 1`. The stamp starts at 1, and
`on_frame` advances it (`capture/src/entry.cpp`, `hooks.cpp` `g_frame`). Calls made during
`initialize()` therefore carry stamp 1, and so do calls during iteration 1. The frame callback at
the end of iteration _n_ sees `frames_total == n`, and the transaction it publishes has
`frame == n`. The fixture keeps its own counter, incremented at the top of each `_process`, which
also equals _n_ during iteration _n_. `_process` runs exactly once per `Main::iteration`
(`main/main.cpp:4802`).

### Root adoption (arm time, only when `GRC_STREAM_OUT` is set)

The root viewport and its canvas exist before the library loads, so their RIDs and state are read
back once. The read-only queries are method-bind `ptrcall`s, made right after the vptr store
succeeds and before the session record is written:

1. `Engine.get_main_loop()` → `SceneTree` (an Object pointer).
2. `SceneTree.get_root()` → `Window`, which is a `Viewport`.
3. `Viewport.get_viewport_rid()` → root viewport RID.
4. `Viewport.get_world_2d()` → `Ref<World2D>`, then `World2D.get_canvas()` → root canvas RID.
5. `Viewport.get_canvas_transform()` → `Transform2D`, which becomes session `root_canvas_xform`
   and canvas 1's initial transform.
6. `Viewport.get_canvas_cull_mask()` → `uint32`, which becomes session
   `viewport.canvas_cull_mask`.
7. `Viewport.get_visible_rect()` → `Rect2`, which becomes session `host_visible_rect`. It is
   `0,0,64,64` under `--headless`, the root window's minimum size (see render-stream-0.md).
8. `RenderingServer.get_default_clear_color()` → `Color`, which becomes session `clear_color`.
   The call goes through the method bind, as the gate −1 probe already does.

Method hashes come from `godot --dump-extension-api` for 4.5.1. Pin them in code, each with a
comment naming the class, method and hash. For a `Ref<T>` return, `ptrcall` assigns into a
`Ref<RefCounted>` slot, which takes a reference (`core/object/ref_counted.h:251-254`). Pass a
zeroed pointer-sized slot, read the object with `ref_get_object`, and release it with
`ref_set_object(slot, nullptr)` (`core/extension/gdextension_interface.cpp:1436-1442`, which calls
`reference_ptr(nullptr)` and so unrefs).

The root canvas becomes canvas wire id 1, with `origin` `root-query`, `role` `root`, `attached`
true and no items. Every hook compares RIDs against the root viewport RID and the root canvas RID
from this query.

**Any query failure** (a null bind, a null object, a null RID) still writes the session, with
zeros in place of the missing values. **Every** transaction then has status `capture-failure`
with `{"reason":"root-query-failed","detail":"<which step>"}`. The failure is sticky.

### Unknown-RID policy

The mirror never assigns a guessed id. A canvas-item or canvas hook names an item, a parent, or
(for viewport hooks on the root viewport) a canvas. If the mirror does not know that RID:

- it logs `{rid, op, frame}` once, as `[grc] stream: unknown rid=<u64> op=<name> frame=<n>`;
- every transaction from then on carries
  `{"reason":"pre-existing-object","detail":"rid=<u64> op=<name> frame=<n>"}`, for the first
  such event only. The failure is sticky;
- the call is still forwarded to the engine. The mirror is a tap and never blocks a call.

`free(rid)` is untyped. A `free` of an unknown RID is counted (`free_unknown`) and ignored. It is
not a failure, because textures, meshes and materials are freed through the same slot.

Viewport hooks:

- `viewport_attach_canvas(vp, canvas)` with `vp` other than the root viewport adds the sticky
  session-level unsupported entry `{op:"viewport_attach_canvas",item:null,reason:"non-root-viewport"}`.
  The mirror changes nothing.
- `viewport_attach_canvas(root, canvas)` with a known canvas other than 1 marks that canvas
  `attached` and adds the sticky `{op:"viewport_attach_canvas",item:null,reason:"extra-canvas"}`.
  An unknown canvas is `pre-existing-object`.
- `viewport_set_canvas_transform(vp, canvas, xform)`: on the root viewport with a known canvas, it
  sets that canvas's transform. With an unknown canvas it is `pre-existing-object`. On any other
  viewport it adds the sticky `{op:"viewport_set_canvas_transform",item:null,reason:"non-root-viewport"}`.

Late join (adopting pre-existing items) is later work, at gate 8. The wire `origin` field is
there so that adoption can be added later without changing the format.

## Q2. Fixture

Nothing in the root viewport creates canvas items in this configuration. The viewport's own
items are created only for embedded subwindows (`scene/main/viewport.cpp:304`) and debug
collision shapes (`:563`). A `CanvasLayer` would add a canvas (`scene/main/canvas_layer.cpp:357`).

The fixture draws with **two `Node2D`s using `_draw` rects**, a subject and a step marker. It does
not use `Control`. A Control's NOTIFICATION_DRAW calls `canvas_item_set_custom_rect` and
`canvas_item_set_clip` on every redraw (`scene/gui/control.cpp:3899-3901`), and its size depends
on the root size. Headless reports the window as `Size2i()` (`servers/display_server_headless.h:129`),
and the root then takes its 64×64 minimum (`scene/main/scene_tree.cpp:2035`), not 640×360.

What a `Node2D` does to the RenderingServer:

- **Construction:** `canvas_item_create` (`scene/main/canvas_item.cpp:1731`).
- **Entering the tree:** `canvas_item_set_parent(item, root canvas)` (`:272`),
  `canvas_item_set_visibility_layer(item, 1)` (`:273`), `canvas_item_set_visible` (`:354`), and
  default texture filter and repeat (`:1603`, unobserved). Then the draw index arrives
  **deferred**. `_enter_canvas` calls `Viewport::canvas_parent_mark_dirty` (`:242`), which
  defers `_process_dirty_canvas_parent_orders` (`scene/main/viewport.cpp:1188`, `:243-266`).
  That calls `CanvasItem::update_draw_order` (`canvas_item.cpp:433-446`), which for a top-level
  item makes a deferred group call to `_top_level_raise_self`, and that calls
  `canvas_item_set_draw_index(item, viewport->gui_get_canvas_sort_index())` (`:231-233`). The
  sort index increments per call (`viewport.cpp:3658-3660`). All of this flushes in iteration 1,
  before the first frame callback.
- **Each redraw:** `canvas_item_clear` (`:140`), then `canvas_item_add_rect` (`:797`).
- **A move:** only `canvas_item_set_transform` (`scene/2d/node_2d.cpp:139`), with no redraw.

### Scene and scripts

- `project.godot`: as `fixtures/spike/project.godot`. That means 640×360, `stretch/mode`
  `disabled`, vsync off, `gl_compatibility` for both desktop and mobile, `msaa_2d=0` and
  `hdr_2d=false`, and the same `[debug]` warning keys at level 2: `untyped_declaration`,
  `unsafe_property_access`, `unsafe_method_access`, `unsafe_cast` and `unsafe_call_argument`.
  Differences: `run/main_scene="res://gate0.tscn"`, `default_clear_color=Color(0.2, 0.2, 0.4, 1)`,
  and autoload `GrcLoader="*res://loader.gd"`.
- `loader.gd`: a copy of the spike's loader. It loads `GRC_EXTENSION` when set and prints
  `[fixture] extension load status=…`.
- `gate0.tscn`: a root `Node` with script `res://gate0.gd`, and nothing else.
- `gate0.gd`: an inner class `RectNode extends Node2D` (`var rect: Rect2`, `var color: Color`,
  `var circle: bool`, and a `_draw()` that calls `draw_rect(rect, color)`, then
  `draw_circle(Vector2(16, 16), 8.0, Color(0, 0, 0, 1))` when `circle` is set). `_ready` creates
  `Subject`, then `Marker`, with `add_child` in that order. `_process` advances the timeline below.
- `preexisting.tscn`: a root `Node` with script `res://gate0.gd`, plus one child `Node2D` named
  `Preexisting` declared in the `.tscn`, with no script. That node is constructed before arming,
  so its `_enter_canvas` `canvas_item_set_parent` names an unknown item RID.
- All output lines start with `[fixture]`.

### Timeline

There are 10 frames per step and steps 0..4. Step _k_ ≥ 1 is applied in `_process` at frame
`10k+1`, which means setting `position` and/or `color` and calling `queue_redraw()`. It settles at
frame `10k+8`. Step 0 is the `_ready` state, applied at frame 1 (its first transaction) and
settled at frame 8. The fixture calls `get_tree().quit()` at frame `RS_FIXTURE_QUIT_FRAME`
(default 52). The frame callback still runs for that iteration (`main/main.cpp:4839` follows the
process return), so the last transaction has that frame.

| step | applied | settle | change        | Subject pos | Subject rect (local) | Subject colour  | Marker colour (pos 16,16, rect 0,0,32,32) |
| ---- | ------- | ------ | ------------- | ----------- | -------------------- | --------------- | ----------------------------------------- |
| 0    | 1       | 8      | initial       | (160, 96)   | (0, 0, 96, 64)       | (1, 0.4, 0)     | (1, 1, 1)                                 |
| 1    | 11      | 18     | move only     | (288, 96)   | same                 | same            | (1, 1, 0)                                 |
| 2    | 21      | 28     | colour only   | (288, 96)   | same                 | (0, 0.6, 1)     | (0, 1, 1)                                 |
| 3    | 31      | 38     | move + colour | (416, 224)  | same                 | (0.8, 0.2, 0.6) | (1, 0, 1)                                 |
| 4    | 41      | 48     | marker only   | (416, 224)  | same                 | same            | (0, 1, 0)                                 |

Every alpha is 1. Every component is in {0, .2, .4, .6, .8, 1}, which maps exactly to 8-bit
{0, 51, 102, 153, 204, 255}. All positions and sizes are integers, and the two rects never
overlap. Step 1 changes only the transform, so the Subject's `content_version` stays the same.
Every step changes the Marker's colour, so a stale frame is visible at every step. The clear
colour is `(0.2, 0.2, 0.4, 1)`, which is `(51, 51, 102, 255)`.

Fixture environment (all optional):

- `RS_FIXTURE_STEP_LOG`: an absolute path. At each step's applied frame, append one JSONL line
  `{"step":k,"applied_frame":a,"settle_frame":s}` (keys in that order) and flush it.
- `RS_FIXTURE_SHOT_DIR`: an absolute directory. At each settle frame, if the display server is not
  `headless`, `await RenderingServer.frame_post_draw`, then save
  `get_viewport().get_texture().get_image()` as `step-<k>.png`. Under `headless`, print
  `[fixture] shot skipped (headless)`.
- `RS_FIXTURE_VARIANT`: unset or empty runs the normal fixture. `unsupported` makes the Marker
  also `draw_circle` (`canvas_item.cpp:824`) from step 2 on. Any other value prints an error and
  quits with code 2.
- `RS_FIXTURE_QUIT_FRAME`: an integer ≥ 52, default 52. The capture leg sets 400 so that its
  `/proc` maps and fd sample has time to run, as gate −1's 400 frames did.

`expected.json` (`render-stream-gate0-expected/1`) is the only source of the numbers in the table
above. It contains `viewport` `[640,360]`, `clear_rgba8`, `quit_frame_default`, and `steps[]` of
`{step, applied_frame, settle_frame, subject:{rect_px:[x,y,w,h], color:[r,g,b,a], rgba8},
marker:{rect_px, color, rgba8}}`. Here `rect_px` is the rect in viewport pixels: position plus
local rect. It also contains `unsupported_variant:{from_step:2, op:"canvas_item_add_circle"}`.
`scripts/lib/gate0-expected.ts` exports
`synthesizeExpected(expected, step): {width, height, rgba: Uint8Array}`. It fills the clear colour,
then the subject rect, then the marker rect, all with alpha 255.

## Q2b. Hooks: calibrator 3

Calibrator 3 adds 11 optional (tier 3) hooks. Each signature is copied from
`servers/rendering_server.h`:

| Method                             | Line | Signature notes                                           | Mirror effect                                                                                               |
| ---------------------------------- | ---- | --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `viewport_attach_canvas`           | 1031 | `(RID viewport, RID canvas)`                              | see "Viewport hooks"                                                                                        |
| `viewport_set_canvas_transform`    | 1033 | `(RID viewport, RID canvas, const Transform2D &)`         | canvas xform                                                                                                |
| `canvas_create`                    | 1525 | `() -> RID`                                               | new canvas id                                                                                               |
| `canvas_item_set_parent`           | 1551 | `(RID item, RID parent)`                                  | parent / child order                                                                                        |
| `canvas_item_set_visible`          | 1556 | `(RID, bool)`                                             | `visible`                                                                                                   |
| `canvas_item_set_clip`             | 1562 | `(RID, bool)`                                             | `clip`                                                                                                      |
| `canvas_item_set_custom_rect`      | 1564 | `(RID, bool, const Rect2 &)`, with the Rect2 by reference | `custom_rect` + rect                                                                                        |
| `canvas_item_set_self_modulate`    | 1566 | `(RID, const Color &)`                                    | `self_modulate`                                                                                             |
| `canvas_item_set_visibility_layer` | 1567 | `(RID, uint32_t)`                                         | `visibility_layer` (RS default `0xffffffff`, `renderer_canvas_cull.h:60`; enter sets 1; it affects culling) |
| `canvas_item_set_z_index`          | 1599 | `(RID, int)`                                              | `z_index`                                                                                                   |
| `canvas_item_set_draw_index`       | 1606 | `(RID, int)`                                              | `draw_index`                                                                                                |

`free` (tier 1, line 1770) now passes its RID to the mirror. The tier-2 hooks the mirror uses are
`canvas_item_create`, `canvas_item_set_transform`, `canvas_item_set_modulate`,
`canvas_item_clear`, `canvas_item_set_material`, `canvas_item_add_rect` (tier 1) and every other
hooked `canvas_item_add_*`, which the mirror records as unsupported. The gate needs all 42 hooks
installed: `hooks_omitted` must be empty. The session lists them in `capture.hooks_planned` (see
render-stream-0.md).

The manifest's `unobserved` list (render-stream-0.md) names the pixel-affecting state that is still
not hooked: texture filter/repeat, light mask, `z_as_relative`, y-sort, draw-behind-parent,
canvas-group mode, instance shader parameters, `canvas_set_modulate`, `viewport_remove_canvas`,
and `viewport_set_canvas_cull_mask` after arm.

## Q3. Mirror (`capture/src/rs0_mirror.{h,cpp}`)

The mirror is active **only when `GRC_STREAM_OUT` is set** and the library armed. Otherwise hooks
behave exactly as at gate −1. All mirror state sits behind one `std::mutex`. The frame callback
copies a `Snapshot` under the lock and encodes it outside the lock.

**Ids.** There is one counter per kind (canvas, item) per session. Each starts at 1, and canvas 1
is the root from the root query. A value is never reused. `free` erases the RID→id mapping, so an
engine RID value that gets recycled receives a new id.

**Item state** (`ItemState` in `rs0_snapshot.h`):

- parent `(kind, id)` or none
- ordered children
- xform[6] (x.x, x.y, y.x, y.y, origin.x, origin.y)
- modulate[4] and self_modulate[4]
- visible, draw_index, z_index, clip
- custom_rect and rect[4]
- visibility_layer
- content_version
- commands
- unsupported_state

The defaults are the RenderingServer's: `renderer_canvas_cull.h:60` (visibility_layer
`0xffffffff`), `:88-94` (z 0, modulate and self_modulate white, index 0) and
`renderer_canvas_render.h:474-478` (clip false, visible true, custom_rect false).

Operations:

- **`canvas_item_create`** → a new item with default state, no parent and `content_version` 0.
  Exceeding 4096 live items is a sticky `mirror-capacity` failure, and the item is not tracked.
- **`canvas_item_set_parent(item, parent)`** mirrors `renderer_canvas_cull.cpp:569-598`: remove
  the item from its old parent's list (if any), then **append** it to the new parent's list,
  **even when the parent is unchanged**. A null `parent` leaves it detached. A parent may be a
  known canvas or a known item.
- **Draw order.** The renderer sorts child lists by `index` with an unstable sort when it draws
  (`renderer_canvas_cull.h:109`, `ItemIndexSort`). The mirror keeps append order and `draw_index`
  separately. A receiver reproduces both, and its own renderer then sorts. Ties in `draw_index`
  have no defined order. Gate 0's fixture has none.
- **`canvas_item_add_rect`** appends `{add_rect, antialiased, rect, color}` and bumps
  `content_version`. **`canvas_item_clear`** empties `commands` and bumps `content_version`.
- **Every other hooked `canvas_item_add_*`** appends `{unsupported, name}` and bumps
  `content_version`. More than 1024 commands on one item is a sticky `mirror-capacity` failure,
  and further commands are dropped.
- **`canvas_item_set_material(item, m)`**: a non-null `m` sets `unsupported_state`, and a null
  `m` clears it.
- **Setters** (transform, modulate, self_modulate, visible, clip, custom_rect, visibility_layer,
  z_index, draw_index) store the value.
- **`free(rid)`**:
  - A canvas: its child items lose their parent and become detached
    (`renderer_canvas_cull.cpp:2566`). The canvas id vanishes.
  - An item: it is removed from its parent's list, its children lose their parent
    (`:2585-2600`), and the id vanishes.
  - An unknown RID: counted and ignored.
- **`canvas_create`** → a new canvas: `role` none, not attached, identity xform, no items.
- **Unknown item or parent RIDs** on any canvas-item hook → `pre-existing-object` (see Q1).

**Snapshot.** Canvases sorted by id, then items sorted by id. Each list keeps its append order.
`unsupported` is built as render-stream-0.md specifies. `failures` holds the sticky failures in
the order first observed.

**Sabotage `omit-update`.** Any state mutation stamped `frame == GRC_SABOTAGE_FRAME` (setters,
`set_parent`, `add_*`, `clear`, material) is not applied to the mirror. It is still forwarded to
the engine. Identity bookkeeping (`canvas_item_create`, `canvas_create`, `free`) is **never**
dropped, so the sabotage cannot turn into a `pre-existing-object` capture failure. This tightens
the plan's "mutations stamped that frame are dropped".

## Publication (`rs0_publish`, wired in `entry.cpp` by WP6)

- **At arm**, if `GRC_STREAM_OUT` is set: validate the sabotage environment, open the file
  (create or truncate it, creating the parent directory if it is missing), enable the mirror, run
  the root query, write the magic and the session record, then `fflush`. `session_id` is 128
  random bits from `/dev/urandom` (`getrandom`) as 32 lowercase hex.
- **`on_frame`**, in this order:
  1. `++frames_total` and advance the hook stamp.
  2. Arm if still undecided (the deferred path).
  3. If the library was armed **at the start of this callback** and the stream is open: copy the
     snapshot under the lock (timed into `snapshot_ns_total`), apply publisher sabotage, assign
     `seq` (1, 2, …) and `frame = frames_total`, encode it (timed into `encode_ns_total`), then
     `fwrite` and `fflush` the record.
  4. Run the existing disarm-after-frames logic. If it disarms, first write the end record with
     `reason:"disarm"` and close the file.
- **`on_shutdown`**: if the stream is still open, write the end record with `reason:"shutdown"`
  and close it, then disarm as before.
- Encode outside the mirror lock. One `fwrite` and one `fflush` per record.
- `result.json` gains an additive `stream` object:
  `{"path":<str|null>,"status":"off"|"open"|"closed"|"refused"|"open-failed","reason":<str|null>,"transactions":<int>}`.
  The schema string is unchanged.

Publisher sabotage. It applies to the copy that gets published, never to the mirror:

- **`freeze-frame`**: from frame `F = GRC_SABOTAGE_FRAME` on, publish the snapshot payload that was
  published for the transaction before frame `F` (frame 20 in gate 0), with a fresh `seq` and the
  current `frame`.
- **`perturb-transform`**: from frame `F` on, add `+1.0` to `xform[4]` (origin.x) of every item.
- **`omit-update`**: this one lives in the mirror (above). The publisher only records it in the
  session.
- An unknown `GRC_SABOTAGE` kind, or a `GRC_SABOTAGE_FRAME` that is not an integer ≥ 1, **refuses
  to publish**: no file is created, the log gets
  `[grc] stream: refused sabotage=<value>` (then ` frame=<value>` when set, and the reason in
  parentheses), and `result.json` `stream.status` is `"refused"` with that reason. Arming itself is
  unaffected.

The session's `sabotage` is `{"kind","frame"}` whenever a sabotage is active. The checker's
classifier never reads it.

## Environment

| Variable                                 | Read by                   | Default                         | Meaning                                                                                |
| ---------------------------------------- | ------------------------- | ------------------------------- | -------------------------------------------------------------------------------------- |
| `GRC_EXTENSION`                          | fixture `loader.gd`       | unset → not loaded              | absolute `.gdextension` path to load in `_enter_tree`                                  |
| `GRC_CALIBRATION`                        | capture library           | unset → refuse                  | absolute calibration record path (gate −1 contract)                                    |
| `GRC_MODE`                               | capture library           | `validate`                      | `validate` or `arm` (gate −1 contract). A stream needs `arm`                           |
| `GRC_EVIDENCE_DIR`                       | capture library           | stdout                          | evidence directory (gate −1 contract)                                                  |
| `GRC_DISARM_AFTER_FRAMES`                | capture library           | unset → shutdown                | disarm after N armed frames. The end record then has `reason:"disarm"`                 |
| `GRC_STREAM_OUT`                         | capture library           | unset → no stream               | absolute recording path. Enables the mirror and the root query. Ignored unless armed   |
| `GRC_SABOTAGE`                           | capture library           | unset → none                    | `freeze-frame`, `omit-update` or `perturb-transform`. Anything else refuses to publish |
| `GRC_SABOTAGE_FRAME`                     | capture library           | `21`                            | first sabotaged frame, an integer ≥ 1. Read only when `GRC_SABOTAGE` is set            |
| `GRC_SCREENSHOT`, `GRC_SCREENSHOT_FRAME` | spike fixture only        | —                               | gate −1. Listed so that launchers strip them                                           |
| `RS_FIXTURE_STEP_LOG`                    | `gate0.gd`                | unset → none                    | step JSONL path                                                                        |
| `RS_FIXTURE_SHOT_DIR`                    | `gate0.gd`                | unset → none                    | reference screenshot directory (rendered runs only)                                    |
| `RS_FIXTURE_VARIANT`                     | `gate0.gd`                | normal                          | `unsupported` adds the marker circle from step 2                                       |
| `RS_FIXTURE_QUIT_FRAME`                  | `gate0.gd`                | `52`                            | quit frame, ≥ 52                                                                       |
| `RS_RECEIVER_RECORDING`                  | `receiver.gd`             | required                        | absolute `.rs0` path                                                                   |
| `RS_RECEIVER_OUT`                        | `receiver.gd`             | required                        | absolute `applied.json` path. Shots go to `<dirname>/shots/`                           |
| `RS_RECEIVER_SHOT_SEQS`                  | `receiver.gd`             | empty                           | CSV of transaction `seq`s to screenshot                                                |
| `RS_SELFTEST_GOLDEN_DIR`                 | `tests/codec_selftest.gd` | `<receiver>/../protocol/golden` | golden directory                                                                       |

Launchers start from a clean slate. `gs_launch_godot` in `scripts/lib/gamescope.sh` and the
headless launch in `run-gate0.sh` add `-u` for every variable above: the existing `GRC_*` five,
`GRC_STREAM_OUT`, `GRC_SABOTAGE`, `GRC_SABOTAGE_FRAME` and every `RS_*`. Each leg then passes
only the variables it wants.

## Q5. Receiver (`experiments/render-stream/receiver/`)

**Project.** `project.godot` has the same `[display]` and `[rendering]` block as the fixture,
except `default_clear_color=Color(1, 0, 1, 1)`. That magenta is deliberately wrong: the session
must override it. It has the same `[debug]` warning keys at level 2, no `[autoload]` and no
extension. `main.tscn` is a root `Node` with `receiver.gd`. Every output line starts with
`[receiver]`. No file in `receiver/` may be byte-identical to a file in `fixtures/gate0/`.

**Scripts** (typed GDScript only):

- `rs0_decoder.gd`: `class_name Rs0Decoder extends RefCounted`. A pure `PackedByteArray` →
  records decoder using `decode_u32`, `decode_float` (or `slice().to_float32_array()`),
  `get_string_from_ascii` + `JSON.parse_string`, and `HashingContext` for SHA-256. It validates
  everything in render-stream-0.md except `meta-noncanonical`, with the same error codes. API:
  - `static func split_records(data: PackedByteArray) -> Dictionary` returns
    `{records: Array[Dictionary] of {offset, byte_length}, errors: PackedStringArray}`.
  - `static func decode_record(data: PackedByteArray, offset: int) -> Dictionary` returns
    `{meta: Dictionary, blocks: Array[PackedFloat32Array], sha256: String, errors: PackedStringArray}`.
  - An inner `class Stream` (cross-record state) with
    `func accept(record: Dictionary) -> PackedStringArray`.
  - `static func validate_recording(data: PackedByteArray) -> PackedStringArray`.
- `rs0_applier.gd`: `class_name Rs0Applier extends RefCounted`. It owns the wire id → RID maps,
  makes every `RenderingServer` call, and counts them in `rs_calls: int`.
- `receiver.gd`: orchestration.
- `tests/codec_selftest.gd`: `extends SceneTree`. It decodes `minimal.bin` and requires deep
  equality with `minimal.decoded.json`, comparing numbers as floats. It requires each vector in
  `index.json` `invalid[]` to be rejected with its code, and `corrupt-meta.bin` with `meta-json`
  at record index 2. It runs `Rs0Applier` on `minimal.bin` and requires the corrupt transaction to
  cost 0 `rs_calls`. It prints `[rs0-selftest] ok` and quits 0, or prints each failure and quits 1.

**Behaviour.**

1. `_ready`: read `RS_RECEIVER_RECORDING` with `FileAccess.get_file_as_bytes`. Unreadable →
   replay-failure `recording-unreadable`. Run `split_records` over the whole file. Any framing
   error → replay-failure with `seq` null, before any RS call. Decode and validate the session.
   Then:
   - `RenderingServer.set_default_clear_color(clear_color)`.
   - Viewport check. When `DisplayServer.get_name() != "headless"`, require
     `get_viewport().get_visible_rect().size == Vector2(640, 360)`, or replay-failure
     `viewport-mismatch`. Under headless, record `size_check: "skipped-headless"` instead. The
     headless root is 64×64 (`scene/main/scene_tree.cpp:2035`, `scene/main/window.cpp:1144-1150`),
     so the plan's unconditional check would fail every headless receiver run.
   - Map canvas 1 to `get_viewport().find_world_2d().canvas`. Then
     `viewport_set_canvas_transform(get_viewport().get_viewport_rid(), canvas, root_canvas_xform)`
     and `viewport_set_canvas_cull_mask(viewport_rid, canvas_cull_mask)`.
2. `_process`: apply **one transaction per frame**. While a shot is in progress, do nothing. For
   the next record:
   1. Decode and validate it completely, including the cross-record `Stream` rules. On any error,
      make **no** RS call for this transaction, set replay-failure
      `{seq, reason: <code>, detail}`, write `applied.json` and `quit(3)`.
   2. Free vanished items with `free_rid`. A canvas other than 1 that vanishes is freed too.
   3. Create new canvases (other than 1) with `canvas_create`. They are never attached. Create
      new items with `canvas_item_create`.
   4. Parent pass. For each item in id order whose wire parent differs from the receiver's
      current parent (new items included), call `canvas_item_set_parent(rid, parent_rid or RID())`
      and update the receiver's lists.
   5. Order pass. For each container (canvases by id, then items by id) whose current list
      differs from the wire list, re-call `canvas_item_set_parent(child, container)` for every
      child from the first differing index to the end, in wire order. This reproduces the
      engine's append semantics exactly.
   6. Setters: transform, modulate, self_modulate, visible, clip, custom_rect + rect,
      visibility_layer, z_index and draw_index. Call all of them for a new item. For an existing
      item, call only the ones whose value changed. A float is compared by its float32 value.
   7. Content. For a new item, replay its commands. For an existing item whose `content_version`
      changed, call `canvas_item_clear` and then replay. Replay means calling
      `canvas_item_add_rect(rid, Rect2, Color, aa)` for each `add_rect`. An `unsupported` command
      is logged, not drawn.
   8. Canvas transforms. For canvas 1, call `viewport_set_canvas_transform` when its floats
      changed.
   9. Record the transaction entry. If `seq` is in `RS_RECEIVER_SHOT_SEQS`, mark busy,
      `await RenderingServer.frame_post_draw`, save `shots/seq-<seq>.png`, record the shot and
      clear busy. Under headless a requested shot is replay-failure `shot-unavailable`.
3. On the end record: check that every requested shot exists, write `applied.json` with status
   `ok` and `end_seen: true`, then `quit(0)`. Running out of records without an end record is
   replay-failure `recording-incomplete`.

An unsupported condition is reported, not treated as a replay failure. The golden `minimal.bin`
replays with status `ok` and one `unsupported` entry.

**`applied.json`** (`render-stream-receiver-applied/1`). This is an ordinary JSON file, not wire
format, so floats are allowed.

```
{"schema":"render-stream-receiver-applied/1",
 "recording":{"path":<abs>,"sha256":<hex>,"bytes":<int>},
 "session_id":<str|null>,
 "status":"ok"|"replay-failure",
 "failure":{"seq":<int|null>,"reason":<code>,"detail":<str>}|null,
 "end_seen":<bool>,
 "viewport":{"display_server":<str>,"size":[w,h],"size_check":"ok"|"skipped-headless"|"mismatch",
             "canvas_transform":[6 floats]},
 "transactions":[{"seq","frame","record_sha256","process_frame","created","freed","reparented",
                  "commands_replayed","rs_calls"}],
 "shots":[{"seq","path","process_frame","applied_through"}],
 "unsupported":[{"seq","item","name","reason"}]}
```

- `process_frame` is `Engine.get_process_frames()` when the transaction was applied or the shot
  was taken.
- `reparented` counts `canvas_item_set_parent` calls.
- `applied_through` is the last applied `seq` when the shot was taken. It must equal `seq`.
- `unsupported` has one entry for each top-level `unsupported` entry of a transaction that was not
  present in the previous transaction. `name` is the entry's `op`, and `item` is `null` for
  session-level entries.
- Replay-failure reasons are the render-stream-0.md codes plus `recording-unreadable`,
  `viewport-mismatch`, `shot-unavailable` and `shot-failed`.

## Q6. Runner, legs and checker

```
experiments/render-stream/scripts/run-gate0.sh --extension <abs .gdextension> --calibration <abs record> \
    [--binary <abs template>] [--out <abs dir>]
mise exec -- pnpm render-stream:gate0 -- …     # package.json: "bash experiments/render-stream/scripts/run-gate0.sh"
```

`--binary` defaults to the pinned template (`~/.cache/godot-render-stream/templates/4.5.1-stable/linux_release.x86_64`).
`--out` defaults to `artifacts/render-stream/gate0/<UTC>/`, with one directory per leg. Each leg
directory holds `argv.txt`, `env.txt`, `stdout.log` and `exit-code.txt`, plus as applicable:
`evidence/` (`GRC_EVIDENCE_DIR`), `recording.rs0`, `steps.jsonl`, `shots/`, `applied.json`,
`strace.txt`, `maps.txt`, `fd.txt` and `gamescope.json`. Rendered legs use `lib/gamescope.sh`
(private headless gamescope, never Xvfb, never a desktop window). Headless legs strip
`DISPLAY`/`WAYLAND_DISPLAY`. The checker is run as
`mise exec -- pnpm exec tsx --conditions=development scripts/check-gate0.ts --out <dir>`.

| Leg                       | Runs                                                                                                                                                                                                                                     | Expected class                             |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| `import`                  | `mise exec -- godot --headless --path <fixture> --import`, and the same for `receiver/`                                                                                                                                                  | — (exit 0)                                 |
| `receiver-typecheck`      | mise editor (debug, so warnings are live): `--headless --path receiver --script res://tests/codec_selftest.gd`, then one `--headless` receiver run on `golden/minimal.bin`                                                               | — (selftest ok; applied ok, 1 unsupported) |
| `capture`                 | template `--headless --path fixtures/gate0`, `GRC_MODE=arm`, `GRC_STREAM_OUT`, `RS_FIXTURE_STEP_LOG`, `RS_FIXTURE_QUIT_FRAME=400`, under `strace -f -e trace=mprotect,openat`, with a maps/fd sample once `evidence/armed.marker` exists | `success`                                  |
| `reference`               | template in gamescope, extension **absent**, `RS_FIXTURE_SHOT_DIR` → `shots/step-<k>.png`, `RS_FIXTURE_STEP_LOG`                                                                                                                         | — (5 shots, exit 0)                        |
| `receiver`                | template in gamescope on a copy of `capture/recording.rs0` in the leg dir, `RS_RECEIVER_SHOT_SEQS` = the settle seqs                                                                                                                     | `success`                                  |
| `receiver-headless-trace` | template `--headless` receiver on the same copy, under `strace -f -e trace=openat`, with no shots                                                                                                                                        | — (applied ok)                             |
| `sabotage-freeze`         | capture as above (quit 52) with `GRC_SABOTAGE=freeze-frame`, then a gamescope receiver                                                                                                                                                   | `pixel-mismatch`, steps {2,3,4}            |
| `sabotage-omit`           | `GRC_SABOTAGE=omit-update`                                                                                                                                                                                                               | `pixel-mismatch`, steps {2}                |
| `sabotage-perturb`        | `GRC_SABOTAGE=perturb-transform`                                                                                                                                                                                                         | `pixel-mismatch`, steps {2,3,4}            |
| `unsupported`             | capture with `RS_FIXTURE_VARIANT=unsupported`, then a headless receiver                                                                                                                                                                  | `unsupported`                              |
| `preexisting`             | capture of `res://preexisting.tscn` (the scene path as a positional argument after `--path`)                                                                                                                                             | `capture-failure`                          |
| `corrupt`                 | headless receiver on a copy of the capture recording whose transaction **seq 3** has its first meta byte set to `0x00`                                                                                                                   | `replay-failure` (seq 3, `meta-json`)      |

Every sabotage leg also requires that steps 0 and 1 match exactly. The settle seqs come from a
join: each capture's `steps.jsonl` `settle_frame` is matched to the transaction with that
`frame`, and the result is passed as `RS_RECEIVER_SHOT_SEQS`. If the join finds no transaction
for some step, the leg is `capture-failure` with reason `step-join-failed`.

### Classification (`classifyLeg`, pure)

Its inputs are the capture leg's `result.json`, the recording's `validateRecording()` errors and
decoded transactions, the receiver's `applied.json`, and the checkpoint comparisons. It **never
reads `session.sabotage`**. In the `corrupt` leg the host-side recording inputs come from the
uncorrupted capture recording. The corrupted copy is only the receiver's input. Precedence, with
the first match winning:

1. **`capture-failure`**: capture `result.json` status is not `armed`; `stream.status` is not
   `closed`; the recording is missing; `validateRecording` errors (`recording-incomplete`
   included); any transaction has `status` `capture-failure`; or `step-join-failed`.
2. **`unsupported`**: any transaction has a non-empty `unsupported`, or any command has
   `op:"unsupported"`, or the receiver's `applied.json` `unsupported` is non-empty.
3. **`replay-failure`**: no `applied.json`, or one that does not parse; `status`
   `replay-failure`; `end_seen` false; applied seqs not exactly 1..N with matching
   `record_sha256`; or a requested shot missing.
4. **`pixel-mismatch`**: any checkpoint (full frame or region) has `mismatched_pixels > 0` or
   `max_channel_delta > 0` against the reference.
5. **`success`**.

Legs without a receiver (`capture`, `preexisting`) stop after rule 2. `reasons` lists every rule
that fired, not only the winning one.

### Checks

| id                              | passes when                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `capture-armed`                 | the `capture` leg's `result.json` is `armed`, `stream.status` is `closed`; `counters.json` `hooks_omitted` and session `capture.hooks_omitted` are empty; `hooks_planned` is exactly the 42 names                                                                                                                                                                                            |
| `headless-no-gpu`               | gate −1's `checkHeadlessNoGpu` over the `capture` leg (refactor it to take the leg directory): display server `headless`; no GPU device or library in the strace `openat`s, `maps.txt` or `fd.txt`                                                                                                                                                                                           |
| `recording-decodes`             | `validateRecording(capture recording)` is `[]`. That covers contiguous seqs, increasing frames, ids never reused or reappearing, parents resolving and block lengths. Also the first transaction has `frame` 1 and `transactions == 400`                                                                                                                                                     |
| `manifest-present`              | session `protocol`, `features` (exact gate-0 arrays), `engine.display_server == "headless"`, `viewport.root_canvas == 1` and `sabotage == null` in the `capture` leg                                                                                                                                                                                                                         |
| `step-alignment`                | `capture` `steps.jsonl` has steps 0..4 with the frames in `expected.json`; the reference's `steps.jsonl` agrees; for each step _k_, the first transaction containing an `add_rect` with the marker colour of step _k_ (compared as float32) has `frame == applied_frame`                                                                                                                     |
| `expected-image-reference`      | each `reference/shots/step-<k>.png` equals `synthesizeExpected(k)` exactly (640×360 RGBA, alpha 255)                                                                                                                                                                                                                                                                                         |
| `expected-image-receiver`       | each receiver shot for step _k_ equals `synthesizeExpected(k)` exactly                                                                                                                                                                                                                                                                                                                       |
| `receiver-vs-reference`         | `compareRgbaBuffers` with `maxChannelDelta: 0` on the full frame, plus the subject and marker regions (`rect_px`) at every step: 0 mismatched pixels                                                                                                                                                                                                                                         |
| `receiver-consumed-stream`      | `receiver` `applied.json` lists seqs 1..N, each `record_sha256` equals the host-computed hash, every shot has `applied_through == seq`, and `recording.sha256` equals the capture file's                                                                                                                                                                                                     |
| `receiver-never-loaded-fixture` | `receiver-headless-trace`: no successful `openat` under `experiments/render-stream/fixtures/`; no file in `receiver/` (excluding `.godot/`) has the sha256 of a file in `fixtures/gate0/`; no `[fixture]` line in any receiver log; argv has `--path <abs receiver>`                                                                                                                         |
| `receiver-typed-clean`          | the `receiver-typecheck` logs contain no `SCRIPT ERROR`, `SCRIPT WARNING`, `Parse Error` or `Failed to load script`; the selftest printed `[rs0-selftest] ok` and exited 0; the minimal run's `applied.json` is ok with exactly 1 unsupported                                                                                                                                                |
| `leg-class-<leg>`               | one per classified leg (`capture`, `receiver`, `sabotage-freeze`, `sabotage-omit`, `sabotage-perturb`, `unsupported`, `preexisting`, `corrupt`): `result_class == expected_class`; for pixel-mismatch legs the set of mismatching steps equals the expected set and steps 0–1 match; `preexisting` reasons include `pre-existing-object`; `corrupt` failure is `{seq:3, reason:"meta-json"}` |

`gate_passed` is true when every check passed. The runner exits non-zero unless it is.

### Report (`<out>/result.json`, `render-stream-gate0-report/1`)

```
{"schema":"render-stream-gate0-report/1",
 "generated_at":<ISO-8601 UTC>,
 "binary":{"path","sha256"},
 "gate_passed":<bool>,
 "legs":{"<leg>":{"expected_class":<class|null>,"result_class":<class|null>,"reasons":[<str>],
                  "exit_code":<int|null>,"artifacts":[<path>]}},
 "checks":[{"id","criterion","passed","detail","evidence":[<path>]}],
 "checkpoints":[{"step","settle_frame","seq","reference_png","receiver_png","diff_png",
                 "mismatched_pixels","max_channel_delta",
                 "regions":[{"name":"subject"|"marker","rect_px":[4],"mismatched_pixels","max_channel_delta"}]}],
 "stream":{"transactions","bytes_total","encode_ns_total","snapshot_ns_total","max_record_bytes"}}
```

The support legs (`import`, `receiver-typecheck`, `reference` and `receiver-headless-trace`) have
`expected_class` and `result_class` null. `checkpoints` come from the `receiver` leg. `stream`
comes from the `capture` leg's end record.

## Q7. Code layout

- `capture/src/rs0_codec.{h,cpp}`: no I/O.
  `std::vector<uint8_t> encode_session(const Session&)`, `encode_transaction(const Snapshot&)`
  and `encode_end(const End&)` each return one complete record, length prefix included.
  `kMagic` comes from `rs0_snapshot.h`. A hand-written JSON writer follows render-stream-0.md
  exactly. It sorts `hooks_planned` and `hooks_omitted`, and it replaces any non-printable byte
  in a string with `?`.
- `capture/src/rs0_publish.{h,cpp}`: the file sink (`fopen` `wb`, then one `fwrite` and `fflush`
  per record), session id, seq assignment, stats, and the freeze and perturb sabotage. It is
  testable against a memory sink.
- `capture/test/rs0_codec_test.cpp`: builds the golden's `Session`, two `Snapshot`s and `End` by
  hand, and requires the bytes to equal `protocol/golden/minimal.bin`, located through a CMake
  compile definition. `rs0_mirror_test.cpp` drives the mirror's public API.
- `scripts/lib/render-stream-0.ts`: pure over `Uint8Array`. It may use `node:crypto` for SHA-256,
  and it does no file or network I/O:

  ```ts
  export const MAGIC: Uint8Array;
  export interface RawRecord {
    offset: number;
    byte_length: number;
    bytes: Uint8Array;
  }
  export function splitRecords(data: Uint8Array): {
    records: RawRecord[];
    errors: string[];
  };
  export interface DecodedRecord {
    offset: number;
    byte_length: number;
    sha256: string;
    meta: Rs0Meta;
    blocks: number[][];
  }
  export function decodeRecord(raw: RawRecord): {
    record?: DecodedRecord;
    errors: string[];
  };
  export function decodeRecording(data: Uint8Array): {
    schema: "render-stream-0-decoded/1";
    magic: string;
    records: DecodedRecord[];
  }; // throws on a framing error
  export function validateRecording(data: Uint8Array): string[]; // "<code>: <detail>", [] when valid
  export function recordSha256(data: Uint8Array, offset: number): string;
  ```

  The golden set is shared by the C++, TS and GDScript tests.

## Work packages

WP1–WP5 run in parallel against this document. WP6 integrates them.

### WP1: hooks, calibrator 3, mirror and root query

- **Files:**
  - `capture/tools/calibrate.py`: `CALIBRATOR_VERSION = "3"`, plus the 11 `WANTED_SLOTS` entries
    from the Q2b table.
  - `calibration/godot-4.5.1-stable-linux-release.json`: re-derived.
  - `capture/src/hooks.{h,cpp}`: the 11 hooks, `free` RID forwarding, and the mirror tap.
  - `capture/src/rs0_mirror.{h,cpp}` and `capture/src/rs0_root_query.{h,cpp}`.
  - `capture/test/rs0_mirror_test.cpp` and `CMakeLists.txt`.
  - `fixtures/spike/{spike.gd,spike.tscn,expected.json}`: after arming, add an empty `CanvasLayer`
    (`canvas_create`, `viewport_attach_canvas`, `viewport_set_canvas_transform`). On the post-arm
    `Node2D`, set `z_index = 1` and `self_modulate = Color.WHITE`, so that every new hook gets a
    non-zero count and the pixels do not change. Add the 11 names to `optional_hooks` and
    `optional_counters_must_be_positive`.
  - `README.md`: the slot table.
- **Passes when:**
  - `scripts/build-capture.sh` and ctest are green.
  - `scripts/calibrate.sh --check` is clean.
  - Gate −1 (`pnpm render-stream:gate-minus1`) is green, with every optional hook count > 0 and
    the armed and unarmed pixels still identical.
  - The mirror tests cover:
    - id counters, and a recycled RID value getting a new id;
    - append-on-same-parent;
    - free of a canvas and free of an item;
    - clear and `add_rect` versions;
    - unsupported ops and material state;
    - unknown RID → `pre-existing-object`;
    - omit-update keeping create and free;
    - both capacity limits;
    - the snapshot's `unsupported` ordering.

### WP2: codec, publisher and TS decoder

- **Files:** `capture/src/rs0_codec.{h,cpp}`, `capture/src/rs0_publish.{h,cpp}`,
  `capture/test/rs0_codec_test.cpp`, `CMakeLists.txt`, `scripts/lib/render-stream-0.ts` and
  `scripts/test/self-test-rs0.ts`.
- **Passes when:**
  - The C++ encoding of the golden structures is byte-identical to `minimal.bin`.
  - The publisher test shows freeze and perturb from frame F, contiguous seqs, correct
    `bytes_total` and `max_record_bytes`, and a refused unknown sabotage.
  - TS `decodeRecording(minimal.bin)` deep-equals `minimal.decoded.json`, and
    `validateRecording(minimal.bin)` is `[]`.
  - Each `invalid/*.bin` yields an error starting with its `index.json` code, and
    `corrupt-meta.bin` yields `meta-json`.
  - `python3 protocol/golden/make_golden.py --check` passes.

### WP3: fixture

- **Files:** `fixtures/gate0/{project.godot, loader.gd, gate0.tscn, gate0.gd, preexisting.tscn,
expected.json, README.md}` and `scripts/lib/gate0-expected.ts`.
- **Passes when:**
  - Under the mise editor, the fixture imports and runs headless to exit 0 at frame 52, with
    `steps.jsonl` exactly as in the timeline and no script warnings or errors.
  - A rendered gamescope run on the template, with the extension absent, writes `step-0..4.png`,
    each equal to `synthesizeExpected(k)` exactly.
  - The `unsupported` variant and `preexisting.tscn` also run to exit 0.

### WP4: receiver

- **Files:** `receiver/{project.godot, main.tscn, receiver.gd, rs0_decoder.gd, rs0_applier.gd,
tests/codec_selftest.gd, README.md}`.
- **Passes when:**
  - The selftest prints `[rs0-selftest] ok` under the mise editor with no warnings or errors.
  - A headless run on `minimal.bin` writes `applied.json` with status `ok`, `end_seen`, seqs 1–2
    with the golden `sha256`s, and exactly one unsupported
    `{seq:1, item:2, name:"canvas_item_add_circle"}`. Unsupported is reported, not a failure.
  - A headless run on `corrupt-meta.bin` gives replay-failure `{seq:2, reason:"meta-json"}`, only
    seq 1 in `transactions`, exit code 3, and no RS calls for seq 2 (the selftest proves this
    through `rs_calls`).
  - A gamescope run on any valid recording takes the requested shots.

### WP5: runner, checker and self-test

- **Files:**
  - `scripts/run-gate0.sh`, `scripts/check-gate0.ts`, `scripts/lib/gate0-checks.ts` and
    `scripts/test/self-test-gate0.ts`.
  - `scripts/lib/gamescope.sh` (strip list).
  - `scripts/lib/gate-minus1-checks.ts`: `checkHeadlessNoGpu(outDir, legName = "headless-armed")`.
  - `package.json` (`render-stream:gate0`) and a `scripts/README.md` section.
- **Passes when:**
  - The self-test builds synthetic evidence directories and shows, for each check, a passing
    case and at least one failing case. It shows `classifyLeg` precedence for every pair of
    classes, and that `session.sabotage` is ignored.
  - The gate −1 self-test still passes.
  - `run-gate0.sh` without `--extension` or `--calibration` refuses immediately.

### WP6: integration and end-to-end

- **Files:** `capture/src/entry.cpp` and `README.md` (a gate 0 result section).
- **Wiring:**
  - `GRC_STREAM_OUT` → enable the mirror, run the root query, and write the session after arm.
  - `on_frame` while armed: snapshot, encode, write.
  - The end record at disarm or shutdown.
  - The sabotage environment and the `stream` object in `result.json`.
- **Passes when:**
  - `pnpm render-stream:gate0` exits 0 with `gate_passed: true`, all legs at their expected
    class, and the artifact paths quoted in the README.
  - Gate −1 is still green.

## Changes from the orchestrator's plan

Each change is noted with its reason:

1. **`host_visible_size` became a block, `host_visible_rect` (4 floats).** It is a float `Rect2`
   in Godot, and floats never go in JSON. Under headless it is 64×64: the display server reports
   `Size2i()` (`servers/display_server_headless.h:129`), and the root clamps to the 64×64 minimum
   that `SceneTree` gives it (`scene/main/scene_tree.cpp:2035`). This contract first said 0×0;
   gate 0 measured `0,0,64,64`.
2. **The session has three named blocks** (`clear_color`, `root_canvas_xform` and
   `host_visible_rect`) instead of one unnamed 10-float list.
3. **`origin` is on the wire for canvases and items.** The plan says wire ids carry origin but
   left it out of the key list.
4. **`unsupported` entries carry `reason`, and `item` is nullable**, so that the session-level
   `non-root-viewport` and `extra-canvas` conditions fit the same list. The list is a
   de-duplicated snapshot of current conditions, with a fixed order.
5. **The receiver's viewport-size check is skipped under headless.** A headless root is 64×64, so
   the unconditional check would make the WP4 headless runs and the `receiver-headless-trace` leg
   fail with `viewport-mismatch`.
6. **`omit-update` never drops create and free**, so the sabotage stays a pixel fault and does not
   turn into a `pre-existing-object` capture failure.
7. **The draw-index path is deferred twice.** The plan said "deferred set_draw_index
   (:231-233)". Those lines are the final call, but the path to them is
   `_enter_canvas` → `canvas_parent_mark_dirty` → deferred `_process_dirty_canvas_parent_orders`
   → `update_draw_order` → deferred group call `_top_level_raise_self`, which is where the call
   at `:231-233` happens. All of it flushes before the first frame callback.
8. **New: `RS_FIXTURE_QUIT_FRAME`.** The capture leg runs 400 frames, so the maps/fd sample can
   run (52 headless frames finish too fast), as gate −1 did.
9. **`applied.json` gained fields:** `viewport.display_server`, `viewport.size_check`, per-shot
   `applied_through` (the plan's checker already needed it), per-transaction `rs_calls`, and
   `unsupported[].reason`.
10. **`unobserved` gained `canvas_set_modulate`, `viewport_remove_canvas` and
    `viewport_set_canvas_cull_mask`.** All three affect pixels and are not hooked.
11. **The `corrupt` leg's host-side inputs come from the uncorrupted capture recording.**
    Otherwise precedence would classify it as `capture-failure`.
12. **`result.json` gained an additive `stream` object**, so that "refused to publish" and an
    open failure leave evidence beyond a missing file.
13. **Checkpoints gained `regions[]`, and legs gained `exit_code`.**

## Open questions

- **Equal `draw_index` ties.** The engine's unstable index sort runs in place at draw time, so the
  order of equal-index siblings depends on each process's own draw history. Gate 0 avoids ties.
  Gate 1 (draw order) has to decide whether to capture post-sort order or to refuse ties.
- **The deferred-arming path** (an extension listed at startup) arms after the main scene
  exists, so every pre-existing item becomes `pre-existing-object`. That path is out of scope
  until adoption (gate 8).
- **Receiver presentation.** One transaction per `_process` frame is enough for gate 0's
  correctness. Live pacing, credit and coalescing are gate 1.
