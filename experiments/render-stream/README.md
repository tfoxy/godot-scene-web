# render-stream experiment — gates −1, 0, 1, 2, 3, 4, 5 and 5.5: capture seam, first stream, retained state, live delivery, textures, clipping, text, geometry, meshes and materials

Gate 0 passed on 2026-10-09 (see "Gate 0 result" below): one opaque rectangle and a step marker,
captured by the stock release template under `--headless`, replayed by a separate receiver
project, pixel-exact against an independent reference. Its contract is
[protocol/gate0-design.md](protocol/gate0-design.md), and its wire format is
[protocol/render-stream-0.md](protocol/render-stream-0.md).

Gate 1's first increment, G1a, passed on the same day (see "Gate 1a result" below). Its fixture
has eleven retained-state steps (thirteen since G1e). The capture host gets the logical root size it needs
(`GRC_ROOT_SIZE=enforce-min-size`) and declares it. Its contract is the G1a section of
[protocol/gate1-design.md](protocol/gate1-design.md).

G1b2 followed (see "Gate 1b result" below): the capture, the receiver and both gate runners moved
to [protocol/render-stream-1.md](protocol/render-stream-1.md), with a patch-encoded sink that
resolves bit for bit to the full one, and the one-frame draw-index tie of a top-level item added
at runtime is now provoked, declared and classified. render-stream/0 is superseded.

G1c2 followed (see "Gate 1c result" below): the capture library serves the same stream live over its
own loopback WebSocket server, one transaction in flight with credit returned from the receiver's
paced render loop, and a live receiver draws the same pixels as the file replay of what it received.

G1d completed gate 1 (see "Gate 1d result" and "Gate 1 summary" below): a receiver that stalls for
two seconds costs the host one pending target and no queue, catches up to the newest state in one
transaction, and resync, reconnect and a killed receiver all leave the host and the picture
correct.

G1e followed (see "Gate 1e result" below): calibrator 4 hooks `z_as_relative_to_parent` and
`draw_behind_parent` (44 hooks), and the fixture grows to thirteen steps to prove both.

Gate 2's first increment, G2a, followed (see "Gate 2a result" below): calibrator 5 hooks eleven
texture calls (55 hooks); with a stream enabled, every `texture_2d_create` and `texture_2d_update`
copies its image into a canonical payload and hashes it on the calling thread, and every
texture call lands in a hook log; a texture fixture's rendered reference, call census and payload
hashes agree with an independent derivation. Its contract is the G2a section of
[protocol/gate2-design.md](protocol/gate2-design.md).

G2b2 followed (see "Gate 2b result" below): everything moved to
[protocol/render-stream-2.md](protocol/render-stream-2.md). The capture's mirror keeps a texture
table (ids, versions, tombstones, the payloads the hooks copied), the file sinks write a
content-addressed store or inline resource records, live connections carry payloads inline, and
the receiver uploads a texture only when a command first needs it and again only when its hash
changes, from an in-memory map, a verified cache directory or the store. render-stream/1 is
superseded.

G2c2, G2d and G2e completed gate 2 (see "Gate 2 summary" below): payloads served live over HTTP
by hash with pins and retirement, `CanvasTexture` filter and repeat (typed as unsupported on a
headless host), and bearer-token authorization.

G3a through G3d completed gate 3 (see "Gate 3 summary" below): nested axis-aligned and
rotated/scaled Control clips both resolve to the engine's own scissor — the rounded bounding box
of the item's transformed rect intersected with the nearest clipping ancestor's — with a mirror
fix for `canvas_item_clear` and a receiver apply-order fix behind it, and
`canvas_item_add_clip_ignore` hooked and typed `unsupported` until gate 5's own wire bump
(render-stream/4, G5d, which made it a command the receiver replays).

G4a through G4f completed gate 4 (see "Gate 4 summary" below): grayscale, layout, RichTextLabel,
multilingual and MSDF text all reach the wire host-evaluated and host-rasterized, with atlas bytes
byte-identical to the rendered reference and every glyph command float32-exact against an
independent oracle; LCD text stays typed `unsupported`, and `RichTextLabel`'s
`canvas_item_add_set_transform` did until G5d; MSDF text landed on `render-stream/3`.

Gate 5 passed on 2026-10-11 (see "Gate 5b result" onward and "Gate 5 summary" below): G5b's
immediate-geometry fixture and reference rasterizer, G5w's render-stream/4 codecs, G5a's
calibrator 7, G5c, and G5d (see "Gate 5d result"), which moved the capture, the receiver and every
gate runner to [protocol/render-stream-4.md](protocol/render-stream-4.md) (render-stream/5 since
G55d, below): every immediate geometry op, `add_set_transform` and `add_clip_ignore` travel as the
engine's own call arguments and replay pixel-exact, so G3d's clip-ignore variant and every G4d
`RichTextLabel` leg now classify `success`. G5c's mesh fixture, oracle and census, G5e's meshes on
the wire, G5g's styleboxes and, last, G5f's live meshes through dropped presentations (stall,
coalescing and newest-state recovery on `fixtures/gate5-mesh`'s GRM1 surfaces) all landed; gate 5's
own runner and checker (`pnpm render-stream:gate5 -- --legs g5b,g5c,g5d,g5e,g5f,g5g`) are 116/116.

Gate 5.5 passed on 2026-10-11 (see "Gate 5.5b result" onward and "Gate 5.5 summary" below): G55a's
calibrator 8 (73 hooks), G55b's `CanvasItemMaterial` and G55c's `ShaderMaterial` fixtures, G55w's
render-stream/5 codecs, and G55d (see "Gate 5.5d result"), which moved the capture, the receiver
and every gate runner to [protocol/render-stream-5.md](protocol/render-stream-5.md). **Every
gate, −1 through 5.5, now runs on render-stream/5**: shaders and materials travel as two tables
(GRP1 code payloads by hash), items carry `material`/`use_parent_material`/`instance_params`,
canvases carry their modulate, and `CanvasItemMaterial` blend and light modes replay pixel-exact
on a native receiver. G55e (see "Gate 5.5e result") carried `ShaderMaterial` end to end: captured
code compiles on a native receiver, every parameter equals what the reference reads back,
`GRC_SHADER_POLICY=params` keeps every code byte off the stream (a receiver compiles from an
operator-local library) and `exclude` refuses the shaders. G55f (see "Gate 5.5f result") closed
gate 5.5: live `ShaderMaterial` parameters and code survive a dropped presentation — a receiver
that stalls for two seconds on `fixtures/gate55-shader`'s continuously-changing `PH` parameter
catches up to the newest code and value in one coalesced transaction, and `stale-coalesce`
classifies `pixel-mismatch` in exactly the regions the stall's swallowed steps touch. Gate 5.5's
own runner and checker (`pnpm render-stream:gate55 -- --legs g55b,g55c,g55d,g55e,g55f`) are
130/130.

Gate −1 of [docs/handoff-headless-render-stream.md](../../docs/handoff-headless-render-stream.md).
It answers one question before any protocol work starts:

> Can a GDExtension observe every `RenderingServer` drawing and texture call made
> by an **unmodified official** Godot release template running `--headless`,
> without patching code, without a custom engine build, and without any way to
> damage a shipped game?

**Answer: yes, measured.** A GDExtension copies the `RenderingServer` singleton's
vtable into the heap, replaces up to 64 slots with pass-through recording hooks
(the eight gate −1 hooks, 23 draw-path hooks added for gate −0.25, 11 canvas
and viewport state hooks added for gate 0, 2 more draw-order hooks added for
gate 1 G1e, 11 texture hooks added for gate 2 G2a, one `clip_ignore` hook
added for gate 3 G3d, and eight geometry/mesh hooks added for gate 5 G5a),
and publishes the copy with one aligned pointer store into the
singleton object's first word. Native `Control` drawing, the `Label` glyph path and direct
`RenderingServer` calls from GDScript are all intercepted; the engine's own call
sites are **not** devirtualised away by the official build's LTO. Disarming
restores the original vptr and the process exits 0.

The end target is a modder loading this into a shipped game (STS2, a stripped
MegaDot 4.5.1 fork) through `GDExtensionManager.load_extension`, so the library
refuses by default: it does nothing at all unless it is handed a calibration
record that matches the running binary byte for byte, and `GRC_MODE` must say
`arm` before the one store happens.

## The pinned binary

```
~/.cache/godot-render-stream/templates/4.5.1-stable/linux_release.x86_64
sha256 54cc228405e5be61934192e3bc5461c91dcb4a3275578b29a869557a4322e79c
```

Official `Godot_v4.5.1-stable_export_templates.tpz`, member
`templates/linux_release.x86_64`, range-extracted from the archive (the member
alone, not the whole template set). It is a non-PIE (`ET_EXEC`), stripped,
dynamically linked x86-64 ELF with no GNU build-id, and it reports
`Godot Engine v4.5.1.stable.official`. It is not committed here; neither is any
other engine binary.

Matching source for the header the calibrator parses: `../godot-4.5.1-stable`,
commit `f62fdbde15035c5576dad93e586201f4d41ef0cb` (read-only reference).

## How it works

`RenderingServer` is an abstract `Object` subclass; `RenderingServerDefault` is
the only concrete implementation and adds no virtual slots. `Object*` and
`RenderingServer*` are the same address (single inheritance, vptr at offset 0),
so the singleton's first word is its vtable address point, and slot `i` is
`*(vptr + 8*i)` — Itanium ABI, declaration order.

1. **Calibrate** (`capture/tools/calibrate.py`, offline, read-only): find the RTTI
   typeinfo name strings `15RenderingServer` and `22RenderingServerDefault`, the
   typeinfo objects that point at them, and the primary vtables that point at
   those (offset-to-top 0, typeinfo pointer, then slots). Walk each vtable and
   record per slot whether it holds a code address or the pure-virtual
   placeholder. Parse the ordered virtual list of `class RenderingServer` out of
   the pinned `servers/rendering_server.h` with the release define set
   (no `TOOLS_ENABLED`, no `DEBUG_ENABLED`, `DISABLE_DEPRECATED` **not**
   defined), derive the `Object` prefix as `slot_count − new_virtuals`, then
   require the whole implemented/pure mask to agree and the matching prefix to be
   unique.
2. **Verify at runtime** (`capture/src/calib.cpp`): see "Safety model" below.
3. **Arm** (`capture/src/vtable.cpp`): `calloc` a table of `slot_count + 2`
   pointers, copy the live table from two words before the address point (so
   offset-to-top and the typeinfo pointer come along), overwrite the hooked slots
   the record names, then one `__atomic_store_n(..., __ATOMIC_RELEASE)` of the new address
   point into the object's first word.
4. **Hook** (`capture/src/hooks.cpp`): each hook records and calls the original
   function pointer with the identical arguments. The hooks are plain functions
   whose first parameter is the `this` pointer, which is exactly the ABI of the
   member functions they replace.
5. **Disarm**: if the object still carries our address point, store the original
   back. The shadow table is deliberately leaked — another thread can be
   mid-dispatch through it at that instant.

### Measured calibration

| Binary                                  | Version                      | Slots | Object prefix | `RenderingServer` virtuals | Anchors   |
| --------------------------------------- | ---------------------------- | ----- | ------------- | -------------------------- | --------- |
| `4.5.1-stable` `linux_release` (pinned) | `4.5.1.stable.official`      | 588   | **23**        | 565                        | 17/17     |
| `4.5.1.stable.mono` `linux_debug`       | `4.5.1.stable.mono.official` | 607   | **42**        | 565                        | 17/17     |
| `4.6.2.stable` `linux_release`          | `4.6.2.stable.official`      | 592   | **22**        | 570                        | 17/17     |
| `4.7.2.stable` `linux_release`          | `4.7.2.stable.official`      | 603   | not derived   | —                          | mask only |

The prefix is 23 on the 4.5.1 release template and 42 on the debug one because
`DEBUG_ENABLED` turns `MTVIRTUAL` into `virtual` and adds `Object` virtuals; 4.6
dropped one `Object` virtual, hence 22. 4.6 also renamed
`RenderingServer::free` to `free_rid`, which the calibrator accepts under the
record key `free`. No 4.7 source is checked out locally, so the 4.7.2 row is a
measurement only (`--mask-only`): its implemented-slot mask has the same shape as
4.6.2's (slots 0–19 and 22 implemented, 20/21 the zeroed destructor pair), which
is consistent with prefix 22, but the calibrator refuses to assert a prefix it
cannot verify against the matching header.

Two facts worth knowing about this build family: pure-virtual slots in the
abstract vtable are **literally null** (there is no `__cxa_pure_virtual` symbol
in the binary at all, and no relocation covers those words), and the two virtual
destructor slots of the `Object` prefix are also zeroed in the abstract vtable.
The runtime check therefore requires all hooked slots to share one placeholder
value, that value not to be code, and the 17 anchors to be code — rather than
assuming any particular sentinel.

### Hooked slots on the pinned binary

"Tier" is the calibrator version that first emitted the slot. Tier 1 is gate −1's
set and is required; tiers 2, 3, 4, 5, 8 and 9 are optional (see "Calibration records and
hook versions" below). Tier 3 is gate 0's: the state the retained canvas mirror
(`capture/src/rs_mirror.h`) needs, beside the tier 1 and 2 hooks it also taps.
Tier 4 is gate 1 G1e's: the two draw-order fields the mirror held at
RenderingServer defaults until then (`z_relative`, `behind`). Tier 5 is gate 2
G2a's: texture placeholders, replacement, canvas textures, the three levels of
texture filter and repeat, and the LCD text draw (gate2-design.md Q2). With a
stream enabled the texture calls also go to the hook log
(`evidence/resources.jsonl`, "Runtime contract" below). Tiers 6 and 7 (clip_ignore;
gate5-design.md Q2's eight geometry/mesh hooks) are covered in their own gate 3/5
result sections below, not repeated in this table. Tier 8 is gate 5.5 G55a's:
materials and canvas shaders (gate5_5-design.md Q2), closing three previously-silent
holes (every material's shader, every `CanvasItemMaterial` shader, inherited
materials), a canvas field and two typed refusals; `material_set_param`,
`shader_create_from_code` and `shader_set_code` (tier 2, below) start decoding their
`StringName`/`Variant`/`String` arguments at the same time, copying and classifying
a shader's code into a `render-stream-shader/1` (GRP1) payload (`capture/src/rs_
shader_payload.h`) and a parameter's Variant into D8's typed, float64-component
shape (`capture/src/rs_variant.h`). As with tier 2's material hooks, none of the
decoded content crosses into `counters.json` -- only `evidence/resources.jsonl`
(`kind`:"shader"/"material"/"item-material" lines) and, once gate 5.5 has a
mirror (G55d), the mirror. Tier 9 is gate 6 G6k's (gate6-design.md Q2): `CanvasLayer`
attach/stacking/removal, canvas-item mirroring/repeat and the root's global canvas
transform. Decode and hook-log only (`evidence/resources.jsonl` `kind`:"canvas"
lines) -- no mirror, publisher or wire change; that is G6b's job.
"Captured" is what the hook records beside its count. Every signature is copied
from the 4.5.1 header, with the line cited in `capture/src/hooks.cpp`.

| Method                                            | Slot | Tier | Captured                                                                                           |
| ------------------------------------------------- | ---- | ---- | -------------------------------------------------------------------------------------------------- |
| `texture_2d_create`                               | 24   | 1    | returned RID, image size/format/bytes, frame; with a stream, the GRT1 payload copy + SHA-256 (G2a) |
| `texture_2d_update`                               | 30   | 1    | RID, layer, image size/format/bytes, frame; with a stream, the payload copy + SHA-256 (G2a)        |
| `shader_create_from_code`                         | 54   | 2    | returned RID (count only); with a stream, the code decoded, GRP1-encoded and hashed (tier 8)       |
| `shader_set_code`                                 | 55   | 2    | shader RID (count only); as above with a stream (tier 8)                                           |
| `material_set_param`                              | 66   | 2    | material RID (count only); with a stream, the `StringName`/`Variant` decoded (tier 8)              |
| `mesh_create`                                     | 71   | 2    | returned RID                                                                                       |
| `mesh_add_surface`                                | 82   | 2    | mesh, and from `SurfaceData`: primitive, format, vertex/index counts, four buffer sizes, `aabb`    |
| `mesh_surface_update_vertex_region`               | 86   | 2    | mesh, surface, byte offset, byte count, first 64 bytes                                             |
| `mesh_surface_update_attribute_region`            | 87   | 2    | as above                                                                                           |
| `mesh_set_custom_aabb`                            | 94   | 2    | mesh, AABB                                                                                         |
| `mesh_clear`                                      | 100  | 2    | mesh                                                                                               |
| `viewport_attach_canvas`                          | 313  | 3    | viewport, canvas                                                                                   |
| `viewport_set_canvas_transform`                   | 315  | 3    | viewport, canvas, transform                                                                        |
| `canvas_create`                                   | 435  | 3    | returned RID                                                                                       |
| `canvas_item_create`                              | 446  | 2    | returned RID                                                                                       |
| `canvas_item_set_parent`                          | 447  | 3    | item, parent                                                                                       |
| `canvas_item_set_visible`                         | 450  | 3    | item, visible                                                                                      |
| `canvas_item_set_transform`                       | 453  | 2    | item, transform                                                                                    |
| `canvas_item_set_clip`                            | 454  | 3    | item, clip                                                                                         |
| `canvas_item_set_custom_rect`                     | 456  | 3    | item, enabled, rect                                                                                |
| `canvas_item_set_modulate`                        | 457  | 2    | item, colour                                                                                       |
| `canvas_item_set_self_modulate`                   | 458  | 3    | item, colour                                                                                       |
| `canvas_item_set_visibility_layer`                | 459  | 3    | item, layer                                                                                        |
| `canvas_item_set_draw_behind_parent`              | 460  | 4    | item, behind                                                                                       |
| `canvas_item_add_line`                            | 462  | 2    | item, from, to, colour, width, antialiased                                                         |
| `canvas_item_add_polyline`                        | 463  | 2    | item, points, colours, width, antialiased                                                          |
| `canvas_item_add_rect`                            | 465  | 1    | item, rect, colour, antialiased                                                                    |
| `canvas_item_add_circle`                          | 466  | 2    | item, position, radius, colour, antialiased                                                        |
| `canvas_item_add_texture_rect`                    | 467  | 1    | item, rect, texture, tile, modulate, transpose (count only before calibrator 5)                    |
| `canvas_item_add_texture_rect_region`             | 468  | 1    | item, rect, texture, source, modulate, transpose, clip_uv (count only before calibrator 5)         |
| `canvas_item_add_msdf_texture_rect_region`        | 469  | 1    | count only                                                                                         |
| `canvas_item_add_nine_patch`                      | 471  | 2    | every argument                                                                                     |
| `canvas_item_add_primitive`                       | 472  | 2    | item, points, colours, UVs, texture                                                                |
| `canvas_item_add_polygon`                         | 473  | 1    | item, points, colours, UV count, texture                                                           |
| `canvas_item_add_triangle_array`                  | 474  | 2    | item, indices, points, colours, UVs, bone/weight counts, texture, count                            |
| `canvas_item_add_mesh`                            | 475  | 2    | item, mesh (passed by reference), transform, modulate, texture                                     |
| `canvas_item_add_multimesh`                       | 476  | 2    | item, multimesh, texture                                                                           |
| `canvas_item_add_set_transform`                   | 478  | 2    | item, transform                                                                                    |
| `canvas_item_set_z_index`                         | 482  | 3    | item, z index                                                                                      |
| `canvas_item_set_z_as_relative_to_parent`         | 483  | 4    | item, z_relative                                                                                   |
| `canvas_item_clear`                               | 486  | 2    | item                                                                                               |
| `canvas_item_set_draw_index`                      | 487  | 3    | item, draw index                                                                                   |
| `canvas_item_set_material`                        | 488  | 2    | item, material (count only); with a stream, also an `item-material` hook-log line (tier 8)         |
| `free`                                            | 549  | 1    | freed RID (deduplicated log, as tier 2)                                                            |
| `texture_2d_placeholder_create`                   | 34   | 5    | returned RID                                                                                       |
| `texture_replace`                                 | 40   | 5    | texture, by-texture                                                                                |
| `viewport_set_default_canvas_item_texture_filter` | 321  | 5    | viewport, filter                                                                                   |
| `viewport_set_default_canvas_item_texture_repeat` | 322  | 5    | viewport, repeat                                                                                   |
| `canvas_texture_create`                           | 441  | 5    | returned RID                                                                                       |
| `canvas_texture_set_channel`                      | 442  | 5    | canvas texture, channel, texture                                                                   |
| `canvas_texture_set_texture_filter`               | 444  | 5    | canvas texture, filter                                                                             |
| `canvas_texture_set_texture_repeat`               | 445  | 5    | canvas texture, repeat                                                                             |
| `canvas_item_set_default_texture_filter`          | 448  | 5    | item, filter                                                                                       |
| `canvas_item_set_default_texture_repeat`          | 449  | 5    | item, repeat                                                                                       |
| `canvas_item_add_lcd_texture_rect_region`         | 470  | 5    | item, rect, texture, source, modulate                                                              |
| `shader_create`                                   | 53   | 8    | returned RID; with a stream, logged with no code yet                                               |
| `shader_set_default_texture_parameter`            | 60   | 8    | shader, texture, index (`StringName` name decoded with a stream)                                   |
| `material_create`                                 | 63   | 8    | returned RID                                                                                        |
| `material_create_from_shader`                     | 64   | 8    | returned RID, shader (next_pass/priority not carried, D6)                                          |
| `material_set_shader`                             | 65   | 8    | material, shader                                                                                    |
| `canvas_set_modulate`                              | 438  | 8    | canvas, colour (full colour; not a material parameter, Q2 does not cover it)                        |
| `canvas_item_set_use_parent_material`             | 489  | 8    | item, enable                                                                                         |
| `canvas_item_set_instance_shader_parameter`       | 490  | 8    | item (`StringName`/`Variant` decoded with a stream, never into `counters.json`)                     |
| `canvas_light_attach_to_canvas`                   | 503  | 8    | light, canvas                                                                                        |
| `viewport_remove_canvas`                          | 314  | 9    | viewport, canvas                                                                                     |
| `viewport_set_global_canvas_transform`            | 323  | 9    | viewport, transform                                                                                  |
| `viewport_set_canvas_stacking`                    | 324  | 9    | viewport, canvas, layer, sublayer                                                                     |
| `canvas_set_item_mirroring`                       | 436  | 9    | canvas, item, mirroring (real ABI has two RIDs; gate6-design.md Q2's shorthand omits one)             |
| `canvas_set_item_repeat`                          | 437  | 9    | item, repeat size, repeat times                                                                       |
| `canvas_set_parent`                               | 439  | 9    | canvas, parent (scale not logged, Q2)                                                                 |
| `get_default_clear_color` (probe, not hooked)     | 577  | 1    | —                                                                                                  |

Floats are written as values and as float32 bit patterns (`*_bits`). Arrays keep
their first 64 elements, and `*_total` gives the real length. A tier-2 or tier-3 hook
deduplicates identical calls into one entry with `calls`, `first_frame` and
`last_frame`. It keeps at most 32 distinct entries and counts any further
distinct calls in `captured_dropped`. Nothing that owns memory is decoded: no
`String`, `StringName` or `Variant`. `SurfaceData` is read in place through the
engine's pointer, and only its leading members up to `aabb` are read. Their
offsets are pinned by `static_assert`s in `capture/src/abi.h` and by the
`abi_decode` unit test. The offsets were also cross-checked with `offsetof` probes
compiled against the pinned 4.5.1 header itself: primitive 0, format 8, the
vertex/attribute/skin buffers 16/32/48, vertex_count 64, index_data 72,
index_count 88, aabb 92, struct size 240.

The calibrator also refuses to write a record whose named slots would not pass
the library's own runtime check: pure-virtual in the abstract vtable and
implemented in the concrete one.

### Calibration records and hook versions

A record produced by an older calibrator still loads in the current library.
That record may come from a sibling calibrating another binary with whatever
`calibrate.py` was on `main` at the time. The rules:

- **Tier 1 slots are required.** If a record does not name one of the eight
  gate −1 hooks, the library refuses with `slot-mask-mismatch` before any write.
  It now refuses in `validate` mode too, so validate predicts what arm would do.
- **Tier 2 and later slots are optional.** If a record does not name one, that
  hook is not installed. Nothing is guessed, and the record is not refused. The
  omission is recorded in three places:
  - `calibration-check.json` gets an ok `hook_plan` entry whose detail names the
    omitted hooks, for example:
    `8 of 79 hooks named by the record; omitted (record predates them): …`.
  - `counters.json` lists the hook under `hooks_omitted`, and its `counts` value
    is `null` rather than `0`. A `null` means "not installed", which is
    different from "never called".
  - stdout gets a `[grc] hooks: …` line.
- **Every slot a record names is verified, whether or not it is hooked.** It must
  be pure-virtual in the abstract vtable and implemented in the concrete one, or
  the library refuses with `slot-mask-mismatch`.
- **Changing the calibrator.** Adding a key to `WANTED_SLOTS` is backward
  compatible. Bump `CALIBRATOR_VERSION` and add the hook as optional. Renaming or
  removing a key is not backward compatible. The gate's `old-record` leg proves
  that a version-1 record (tier 1 slots only) still arms.

## Build, calibrate, run

```bash
# build + unit test (cmake is at /snap/bin/cmake; override with CMAKE=)
experiments/render-stream/scripts/build-capture.sh

# re-derive the committed record, plus uncommitted records for the other local
# templates under artifacts/render-stream/calibration/
experiments/render-stream/scripts/calibrate.sh
experiments/render-stream/scripts/calibrate.sh --check   # diff, do not overwrite

# an engine fork that rebrands GODOT_VERSION_NAME (the version string is "<name> v<build>")
python3 experiments/render-stream/capture/tools/calibrate.py --binary <elf> \
  --header ../godot-4.5.1-stable/servers/rendering_server.h --version-name MegaDot --out <record>
```

The build writes `capture/build/librender_stream_capture.so` and
`capture/build/render_stream_capture.gdextension` (absolute library path,
`entry_symbol = "grc_library_init"`, `compatibility_minimum = "4.5"`). Both are
ignored. Load the `.gdextension` from a fixture autoload, as `fixtures/spike/loader.gd` does:

```gdscript
GDExtensionManager.load_extension(OS.get_environment("GRC_EXTENSION"))
```

### Run gate −1

```bash
experiments/render-stream/scripts/build-capture.sh
experiments/render-stream/scripts/calibrate.sh --check
mise exec -- pnpm render-stream:gate-minus1 -- \
  --extension "$PWD/experiments/render-stream/capture/build/render_stream_capture.gdextension" \
  --calibration "$PWD/experiments/render-stream/calibration/godot-4.5.1-stable-linux-release.json"
```

About 80 seconds. It imports the fixture once with the mise editor (the release template cannot
run a loose project without `.godot/`), runs the six headless legs and the two rendered legs in a
private `gamescope --backend headless`, then the checker, which writes
`artifacts/render-stream/gate-minus1/<UTC timestamp>/result.json` and exits non-zero unless every
check passed. Legs, evidence layout and criteria: [scripts/README.md](scripts/README.md). Checker
self-test: `mise exec -- pnpm exec tsx --conditions=development
experiments/render-stream/scripts/test/self-test-checker.ts`.

### Run gate 0

```bash
experiments/render-stream/scripts/build-capture.sh          # + rs_mirror, rs_publish ctests
mise exec -- pnpm render-stream:gate0 -- \
  --extension "$PWD/experiments/render-stream/capture/build/render_stream_capture.gdextension" \
  --calibration "$PWD/experiments/render-stream/calibration/godot-4.5.1-stable-linux-release.json"
```

About 105 seconds. It imports `fixtures/gate0/` and `receiver/` with the mise editor, runs the
receiver's typed self-test, the headless capture hosts (the 400-frame capture, `preexisting`,
`preexisting-skip`, `unsupported` and the three sabotage captures), the headless receivers
(`corrupt`, `receiver-headless-trace`, `unsupported`), then the reference, the receiver,
`preexisting-reference`, the `preexisting-skip` receiver and the three sabotage receivers in one
private `gamescope --backend headless`, then the checker, which writes
`artifacts/render-stream/gate0/<UTC timestamp>/result.json` and exits non-zero unless every check
passed. Since G1b2 every capture runs under `GRC_ROOT_SIZE=enforce-min-size`; since G2b2 every
capture writes its payload store (`<capture>/store`, which holds only the engine's hue strip here)
and every file-mode receiver gets a fresh cache and that store. Every gate runs on
[protocol/render-stream-4.md](protocol/render-stream-4.md) since G5d (render-stream/3 from G4e2
to G5d, render-stream/2 from G2b2 to G4e2; /3 is /2 plus the MSDF glyph command, /4 is /3 plus
the immediate geometry ops, `add_set_transform`, `add_clip_ignore`, `add_mesh` and a mesh table):
the capture, the receiver and every checker speak it, the recordings keep their `.rs2` names, and
the receiver's typecheck replays `golden-4/`.
Self-tests: `scripts/test/self-test-rs2.ts` (TS decoder against the /2 golden vectors and, since
G4e1, G5w and G55w, against `golden-3/`, `golden-4/` and `golden-5/`, implemented in
`render-stream-2.ts` itself behind a `version` parameter rather than forked modules; since G5d the
parameter defaults to 4 -- /5 decoding is exercised only against `golden-5/`, since the capture and
receiver do not speak it until G55d), `scripts/test/self-test-gate0.ts` (checker and classifier on
synthetic evidence) and `python3 experiments/render-stream/protocol/golden-2/make_golden.py
--check` (plus `golden-3/`'s, `golden-4/`'s and `golden-5/`'s);
the frozen /0 and /1 history stays checked by `scripts/test/self-test-rs0.ts`, `self-test-rs1.ts`
and both older `make_golden.py --check`.

### Run gate 1

```bash
experiments/render-stream/scripts/build-capture.sh
mise exec -- pnpm render-stream:gate1 -- \
  --extension "$PWD/experiments/render-stream/capture/build/render_stream_capture.gdextension" \
  --calibration "$PWD/experiments/render-stream/calibration/godot-4.5.1-stable-linux-release.json" \
  [--legs g1a,g1b,g1c,g1d]
```

This takes about nine minutes and runs the landed groups, `g1a`, `g1b`, `g1c` and `g1d`. It imports
`fixtures/gate1/` and `receiver/`, then runs the receiver's typed self-test and the headless
captures, each writing both sinks (`recording.rs2` full, `recording-patch.rs2` patch,
render-stream/2 since G2b2, render-stream/3 since G4e2, render-stream/4 since G5d) and its payload
store: the
400-frame capture under `enforce-min-size`, the four `omit-update` sabotage captures and the
`root-size-observe` capture. Next it runs the headless traced receiver. The reference and the six
g1a rendered receivers share one private gamescope. Group g1b then captures the two `omit-op`
sabotages, the `patch-drop-item` sabotage and the `RS_FIXTURE_TIE=overlap` variant, and runs the
patch receiver, the sabotage receivers and the overlap variant's reference and receiver in a
second private gamescope. Group g1c runs four live legs: a host serving on an ephemeral loopback
port with a headless receiver, then, in a third private gamescope, a host with a rendered live
receiver, a file-mode replay of what that receiver received, and the `drop-message` sabotage.
Group g1d runs six more live hosts: one whose headless receiver is SIGKILLed at frame 600, then, in
a fourth private gamescope, a stalled receiver, a reconnecting one, a resyncing one, and the
`ignore-credit` and `stale-coalesce` sabotages. Last, the checker writes
`artifacts/render-stream/gate1/<UTC>/result.json` (`render-stream-gate1-report/1`). Legs and
criteria: [scripts/README.md](scripts/README.md) "Gate 1". Self-test:
`scripts/test/self-test-gate1.ts`.

### Run gate 2

```bash
experiments/render-stream/scripts/build-capture.sh          # + rs_sha256, rs_texture_payload, rs_resource_log, rs_publish ctests
mise exec -- pnpm render-stream:gate2 -- \
  --extension "$PWD/experiments/render-stream/capture/build/render_stream_capture.gdextension" \
  --calibration "$PWD/experiments/render-stream/calibration/godot-4.5.1-stable-linux-release.json" \
  [--legs g2a,g2b,g2c,g2d,g2e]
```

About fifteen minutes for all five groups. g2b, g2c and g2d need g2a's captures and reference,
and g2d also needs g2b's. It imports `fixtures/gate2/` and `receiver/`, runs the headless capture
(400 frames, `enforce-min-size`, strace, both sinks and the store) and the `unsupported` variant's
capture, then the reference, its same-build repeat and the extension-armed reference in one private
gamescope. Group g2b adds the inline capture and the five sabotage captures, the headless
receivers (strace trace, wrong-hash, stale, spurious, reupload), a live host with a headless
inline receiver, then in a second private gamescope the variant's reference and the rendered
receivers (cold, warm, patch, inline, unsupported, the two omit-op sabotages), and last the
ignore-cache receiver. Group g2c runs nine live hosts (S = 300, N = 60, quit 971, fetch http):
the headless live receiver and the drop-resource and live wrong-hash sabotages, then in a third
private gamescope the rendered `live` receiver, its file replay, the warm, stall, reconnect and
animate receivers and the unpin sabotage. Group g2d runs the `canvas` variant on a headless capture
host (the typed refusal), then, in a fourth gamescope, three rendered capture hosts with their
rendered receivers (host-renderer evidence). Group g2e runs three live hosts with
`GRC_LIVE_AUTH=token`. Group g2f is opt-in (`--legs …,g2f`, never in the default set). It runs the
headless `CanvasTexture` shim experiment ("Gate 2f result" below), and it is standalone. The checker writes `artifacts/render-stream/gate2/<UTC>/result.json`
(`render-stream-gate2-report/1`). Legs and criteria: [scripts/README.md](scripts/README.md) "Gate
2". Self-tests: `scripts/test/self-test-gate2.ts`, `scripts/test/self-test-gate2f.ts`;
`fixtures/gate2/make_expected.py --check`; the receiver's `tests/applier2_selftest.gd`.

### Run gate 3

```bash
experiments/render-stream/scripts/build-capture.sh
mise exec -- pnpm render-stream:gate3 -- \
  --extension "$PWD/experiments/render-stream/capture/build/render_stream_capture.gdextension" \
  --calibration "$PWD/experiments/render-stream/calibration/godot-4.5.1-stable-linux-release.json" \
  [--legs g3a,g3b,g3c,g3d]
```

About seven minutes for all four groups. It imports `fixtures/gate3/` and `receiver/` with the
mise editor, runs the 400-frame headless capture (`enforce-min-size`, both sinks and the store),
then the reference, its same-build repeat and the armed reference in one private gamescope (group
g3a). Group g3b replays the capture through the unchanged receiver on both sinks, a headless
traced receiver, four fresh sabotage captures (`freeze-frame`, `perturb-transform`, and two
`omit-op` legs dropping `canvas_item_set_clip`/`canvas_item_set_custom_rect`) with their rendered
receivers, the receiver-side `ignore-clip` and `clip-before-clear` sabotages, and the
`root-size-observe` leg, in a second private gamescope. Group g3c imports `fixtures/gate3-xform/`
and its own receiver, then runs a 52-frame capture, three references (reference, repeat, armed)
and two receivers (full, patch), plus the `perturb-transform` and receiver `ignore-clip`
sabotages, in a third private gamescope (`gamescope-xform/`). Group g3d captures the fixture's
`clip-ignore` variant, renders its own reference, and replays it through the unchanged receiver,
in a fourth private gamescope (`gamescope-g3d/`). The checker writes
`artifacts/render-stream/gate3/<UTC>/result.json` (`render-stream-gate3-report/1`). Legs and
criteria: [scripts/README.md](scripts/README.md) "Gate 3". Self-tests:
`scripts/test/self-test-gate3.ts`; `fixtures/gate3/make_expected.py --check`;
`fixtures/gate3-xform/make_expected.py --check`.

### Run gate 4

```bash
experiments/render-stream/scripts/build-capture.sh
mise exec -- pnpm render-stream:gate4 -- \
  --extension "$PWD/experiments/render-stream/capture/build/render_stream_capture.gdextension" \
  --calibration "$PWD/experiments/render-stream/calibration/godot-4.5.1-stable-linux-release.json" \
  [--legs g4a,g4b,g4c,g4d,g4e,g4f]
```

About fourteen minutes for all six groups. It provisions each fixture's fonts from
`fonts.lock.json` before import and refuses on any mismatch. It imports `fixtures/gate4/` and
`receiver/`, runs the headless capture and the reference oracle (plus the early shots after each
upload step), in one private gamescope (group g4a). Group g4b needs g4a in the same `--legs`: it
replays the shared capture through the unchanged receiver on both sinks, a headless `openat`
trace, and three fresh sabotage captures (`freeze-frame`, `perturb-transform`, `omit-op` on
`texture_2d_update`) with their rendered receivers, in a second private gamescope
(`gamescope-g4b/`). Group g4c imports `fixtures/gate4-layout/` under `layout/` and runs its own
14-Label capture, reference and early shots, two receivers, the `omit-atlas` sabotage and the
`lcd` variant's reference and receiver, in a third private gamescope (`gamescope-g4c/`). Group
g4d imports `fixtures/gate4-rich/` under `rich-*/` and runs its own `RichTextLabel` capture,
reference, two receivers and the underline variant, in a fourth private gamescope
(`gamescope-g4d/`). Group g4e (G4e2) needs g4a in the same `--legs` for its own
`sabotage-gray-perturb-glyph` leg on `fixtures/gate4`; it imports `fixtures/gate4-msdf/` under
`msdf/` and runs its own capture, reference and early shots, two receivers and three sabotage
receivers (`perturb-glyph`, a receiver `drop-msdf`, and the grayscale sabotage), in a fifth
private gamescope (`gamescope-g4e/`). Group g4f imports `fixtures/gate4-i18n/` under `i18n/`
(four fallback fonts provisioned) and runs its own capture, reference and early shots, two
receivers and the `omit-atlas` sabotage, in a sixth private gamescope (`gamescope-g4f/`). The
checker writes `artifacts/render-stream/gate4/<UTC>/result.json`
(`render-stream-gate4-report/1`); g4c, g4d, g4e and g4f each merge their own checks and legs into
the same report. Legs and criteria: [scripts/README.md](scripts/README.md) "Gate 4". Self-tests:
`scripts/test/self-test-gate4.ts`; `scripts/test/self-test-gate4d.ts`; `make_expected.py --check`
for `fixtures/gate4`, `fixtures/gate4-layout`, `fixtures/gate4-rich`, `fixtures/gate4-i18n` and
`fixtures/gate4-msdf`.

## Runtime contract

Environment, read once at SCENE initialisation:

| Variable                         | Meaning                                                                                                                                                                                                                                                                                                                                                                                                   |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GRC_CALIBRATION`                | absolute path to the record. Absent or unreadable → refuse `no-calibration`; present but malformed → refuse `invalid-calibration`                                                                                                                                                                                                                                                                         |
| `GRC_MODE`                       | `validate` (default; all checks, all evidence, never writes the vptr) or `arm`                                                                                                                                                                                                                                                                                                                            |
| `GRC_EVIDENCE_DIR`               | absolute directory, created if missing. Unset → the same payloads go to stdout as `[grc] evidence <name> …` lines                                                                                                                                                                                                                                                                                         |
| `GRC_DISARM_AFTER_FRAMES`        | integer; disarm after that many armed frame callbacks. Unset → stay armed until the shutdown callback                                                                                                                                                                                                                                                                                                     |
| `GRC_STREAM_OUT`                 | absolute `.rs2` path of the full-encoding sink (render-stream/1 from G1b2, render-stream/2 since G2b2, render-stream/3 since G4e2, render-stream/4 since G5d, render-stream/5 since G55d). When this or `GRC_STREAM_PATCH_OUT` is set and the library armed, enable the canvas mirror, run the root query and publish. Unset → hooks behave as at gate −1                                                                                                                                    |
| `GRC_STREAM_PATCH_OUT`           | G1b2: absolute `.rs2` path of the patch-encoding sink (seq 1 full, then patches on `seq-1`), fed from the same per-frame snapshot as the full sink                                                                                                                                                                                                                                                        |
| `GRC_SABOTAGE`                   | test sabotage: `freeze-frame`, `omit-update`, `perturb-transform` (gate 0), `omit-op`, `patch-drop-item` (G1b2), `drop-message`, `ignore-credit`, `stale-coalesce` (live, need `GRC_LIVE_LISTEN`), G2b2's `stale-texture`, `wrong-hash` (needs a store) and `spurious-texture-update`, G4e2's `perturb-glyph` (the mirror records rect.x + 0.25 on every glyph command from the frame on), G5d's `perturb-vertex` and G55d's `perturb-shader` (the mirror records every non-builtin shader code set from the frame on with `COLOR.rgb` inverted before its last `}`; the engine and the hook log keep the true code). `drop-resource`, `unpin` (G2c2) and any other value refuse to publish (arming is unaffected)                   |
| `GRC_SABOTAGE_OP`                | G1b2: the RenderingServer method `omit-op` drops from `GRC_SABOTAGE_FRAME` on (`free`, `canvas_item_set_visible`, …); required for `omit-op`, refused with any other kind                                                                                                                                                                                                                                 |
| `GRC_SABOTAGE_FRAME`             | first sabotaged frame, an integer ≥ 1, default 21. Read only when `GRC_SABOTAGE` is set                                                                                                                                                                                                                                                                                                                   |
| `GRC_ROOT_SIZE`                  | gate 1 (G1a), read at arm with a stream: `observe` (default; declare only) or `enforce-min-size` (`Window.set_min_size(content_scale_size)` on the root, see below). Anything else refuses to publish                                                                                                                                                                                                     |
| `GRC_UNKNOWN_ITEM`               | 2026-10-10, read at arm with a stream: `strict` (default; also unset or empty: gate 0's sticky `pre-existing-object`) or `skip`, the opt-in diagnostic of [protocol/unknown-item-skip.md](protocol/unknown-item-skip.md): unknown canvas/item RIDs and every known item under one are withheld, the session declares `unknown_item_policy: "skip"` and every transaction carries `unknown_items`. Anything else refuses to publish|
| `GRC_SHADER_POLICY`              | G55d (gate5_5-design.md D4), read at arm with a stream: `source` (default; also unset or empty: shader code travels as `render-stream-shader/1` payloads under the resource policy), `params` (every non-builtin shader entry is `withheld`: hash and size only, no code byte in the stream, the store or HTTP) or `exclude` (every non-builtin shader is `unsupported` / `shader-excluded`). CanvasItemMaterial shaders are engine content and travel under every policy. Declared in the session's `materials.shader_policy`. Anything else refuses to publish |
| `GRC_LIVE_LISTEN`                | G1c2: `127.0.0.1:<port>` or `[::1]:<port>` (0 = ephemeral). Enables the mirror and root query like `GRC_STREAM_OUT` and serves the stream (render-stream/5 since G55d, subprotocol `render-stream.5`; /4 from G5d; /3 from G4e2; /2 from G2b2; out-of-band payloads over `GET /resources/sha256/<hash>` on the same listener since G2c2) over the library's own WebSocket server (one receiver at a time). Any other host refuses (`non-loopback`) |
| `GRC_LIVE_TAP_DIR`               | G1c2: absolute directory for `stream-<n>.rs2` (every binary message formed for connection n, resource records included) and `live-<n>.jsonl` (the live log)                                                                                                                                                                                                                                               |
| `GRC_LIVE_MAX_MESSAGE_BYTES`     | G1c2: default 16777216; the cap is the minimum of this and the receiver's `hello.inbound_buffer_bytes` (larger: `error` + close 1009)                                                                                                                                                                                                                                                                     |
| `GRC_LIVE_HELLO_TIMEOUT_MS`      | G1c2: default 5000; no `hello` in time → close 1002                                                                                                                                                                                                                                                                                                                                                       |
| `GRC_RESOURCE_FORMATS`           | G2a, read at arm with a stream: the `Image` formats whose bytes are copied, a comma-separated subset of `L8,LA8,R8,RG8,RGB8,RGBA8` (the default); any other name refuses to publish                                                                                                                                                                                                                       |
| `GRC_RESOURCE_MAX_PAYLOAD_BYTES` | G2a: the largest canonical payload copied, a decimal integer ≥ 1, default 67108864 (64 MiB); a larger texture is logged `payload-too-large` and not copied. An engine without the `Image` binds or `image_ptr` refuses to publish (`image-access-unavailable`)                                                                                                                                            |
| `GRC_RESOURCE_STORE_DIR`         | G2b2: absolute content-addressed store (`sha256/<hash>.grt`, `.grm` since G5e, `.grp` since G55d, `index.jsonl`) every `ok` payload of each published snapshot is written to; required when a file sink is open and delivery is not inline (else the stream refuses: `resource-store-missing`)                                                                                                                                                 |
| `GRC_RESOURCE_INLINE_MAX_BYTES`  | G2b2: the largest payload a file sink carries in band as a `resource` record, default 0 (out of band); delivery is `inline` when it is at least the max payload size, `mixed` in between. Live connections follow it too (G2c2); above 1 MiB the live listener is refused                                                                                                                                 |
| `GRC_RESOURCE_BUDGET_BYTES`      | G2b2: the payload bytes the capture may retain (the mirror's plus those the last publication pins), default 536870912; above it the stream ends with `resource-budget-exceeded` (result.json `stream.reason`), as a store write failure does with `resource-store-failed`                                                                                                                                 |

Arming happens at the earliest point where the `RenderingServer` singleton is
available. With a runtime `load_extension` from an autoload that is SCENE
initialisation, because the engine singletons are already registered by then —
this is the path the scratch runs exercise, and the one the fixture uses. A
startup-loaded extension reaches SCENE initialisation at `main/main.cpp:3633`,
before `register_server_singletons()` at `main/main.cpp:3704`, so
`global_get_singleton("RenderingServer")` would still be null; the attempt is
then retried from the `startup` callback and from each `frame` callback until the
singleton exists. Only the first successful attempt decides.

That deferred path was first run on 2026-10-09, with the extension listed in a
scratch project's `.godot/extension_list.cfg` on the pinned template. It refused
a correct record as `slot-mask-mismatch`: the retry re-parsed the record into the
same lists and the anchors doubled to 34/17. Loading the record and collecting the
fingerprint now start from empty. With that change the startup-loaded extension
defers at `scene-init` and decides at `startup`: `validated` in validate mode;
`armed` in arm mode, where the scripted `add_rect` is bit-exact, and then
disarmed and restored. A `load_extension` from a `--script` `SceneTree._initialize`
arms at `scene-init` directly.

A mod's managed code always runs after the singletons exist, because
`ScriptServer::init_languages()` follows `register_server_singletons()`
(`main/main.cpp:3707`). So a `GDExtensionManager.LoadExtension` call from mod code
decides at `scene-init` and never needs the deferred path. Gate −0.5 measured the
same on the target game.

Evidence files, exactly as the runner expects:

- `result.json` — `render-stream-capture-result/1`: `status`
  (`armed|validated|refused|error`), `reason`, `vptr_written`, `disarmed`,
  `display_server`, `rendering_driver`, `rendering_method`, and (gate 0, additive)
  `stream`: `{path, patch_path, status: off|open|closed|refused|open-failed, reason,
transactions}` (`patch_path` since G1b2), and (G1c2) `live`: `{status, listen, address, port,
reason, connections}`. Written at decision time and rewritten at disarm and shutdown.
- `live.json` (G1c2, with `GRC_LIVE_LISTEN`) — `render-stream-live/1`: `status`
  (`listening|refused|failed`), `address`, `port`, `reason`; written when the listener is decided.
- `live-summary.json` (G1c2) — `render-stream-live-summary/1`: per connection the transactions
  formed and sent, coalesced callbacks, acks per stage, credit round trips, close code and side.
- `fingerprint.json` — version string, sha256, build-id, pie, load bias, live
  vptr, singleton address, abstract address point, pure placeholder, pid, and the
  `/proc/self/maps` lines of the main binary.
- `calibration-check.json` — every check with `ok` and a detail string.
- `counters.json` — `render-stream-gate-minus1-counters/1`, written at disarm and
  at shutdown. Floats are printed with `%.9g` **and** as IEEE-754 float32 hex
  bits.
- `disarm.json` — `disarmed`, `vptr_was_shadow`, `vptr_restored`, `frame`.
- `resources.jsonl` (G2a, whenever a stream is enabled) — `render-stream-resource-log/1`, the
  texture hook log (`capture/src/rs_resource_log.h`): one line per texture-related
  RenderingServer call after it was forwarded (a free is logged only for a RID created as a
  texture), drained at every frame callback. Keys, in order: gate2-design.md Q3's `frame`, `t_us`
  (since the stream opened), `thread` (`main` or `other`), `op`, `id` and `by_id` (the wire ids
  G2b2's mirror will use: one per-session counter, never reused), `rid`, `version`, `kind`,
  `status`, `reason`, `format`, `width`, `height`, `mipmaps`, `data_bytes`, `payload_bytes`,
  `hash` (SHA-256 of the GRT1 payload, copied and hashed on the calling thread before the call
  was forwarded), `copy_ns`, `hash_ns`, `conn` and `http_status` (set on G2c2's `http-get` lines), then G2a's
  additions `target` (the item, viewport or other texture RID the call names), `ref_id` (that
  texture's id), `value` (the filter, repeat or channel argument), `layer` and `root_viewport`.
  A `texture_replace` line carries the payload fields of the content its target now holds.
  G2b2 adds publisher lines (`op` `store` for a payload written to the store directory, `inline`
  for a resource record written to a sink, with `hash`, `payload_bytes` and `status`) and two
  trailing keys on a sabotage's own lines: `"sabotage":true` (spurious-texture-update's version
  bump) and `"sabotage":true,"omitted":true` (a call the omit-op sabotage dropped from the
  capture: logged, but neither the mirror nor the log's registry applies it, so the two keep
  agreeing and the sabotage shows as pixels).
  G2c2 adds the live serving lines: `pin` (a hash became servable over HTTP; `reason` `current`),
  `retire` (it stopped being servable and its bytes were released; `superseded`, or `unpin` under
  that sabotage) and `http-get` (one GET the server answered: `hash`, `http_status`,
  `payload_bytes`, `conn` the live connection streaming then, thread `other`); a drop-resource
  pin carries `"sabotage":true`.
- `armed.marker` — empty file, created immediately after the vptr store.

Deviations from the drafted contract, all additive:

- `counters.json` adds `image_details_available` (whether the `Image` method
  binds resolved), and each `canvas_item_add_polygon` entry adds `points_total`,
  `colors_total` and `texture`; captured point/colour lists are truncated at 64
  elements per call, which `points_total`/`colors_total` make visible.
- `texture_2d_create`/`texture_2d_update` entries carry `rid`, `details`, `frame`
  and (for updates) `layer` beside the drafted `width`/`height`/`format`/`data_size`.
  `frame` is the 1-based main-loop iteration the call arrived in, the same numbering
  as the fixture's own frame counter (the frame callback runs after process and
  draw), so an expected atlas update can be placed in time.
- `invalid-calibration` is a reason code in addition to the drafted ones, for a
  record that exists but does not parse or carries the wrong schema.
- Calibrator 2 added keys only; the schema string is unchanged. The new
  `counters.json` keys are:
  - `hooks_planned` and `hooks_omitted`, as described in "Calibration records and
    hook versions".
  - one `counts` entry per tier-2 hook, `null` when the hook was omitted.
  - one `captured` array per tier-2 hook, in the shapes listed in the slot table
    above.
  - `captured_dropped`.

  `calibration-check.json` adds the `hook_plan` check.

- Calibrator 3 (gate 0) also added keys only. `counters.json` gains a `counts`
  entry, a `captured` array and a `captured_dropped` entry for each of the 11
  tier-3 hooks, and a `captured.free` array of freed RIDs (with
  `captured_dropped.free`).
- Calibrator 5 (G2a) also added keys only. `counters.json` gains a `counts`
  entry, a `captured` array and a `captured_dropped` entry for each of the 11
  tier-5 hooks; `captured.canvas_item_add_texture_rect` and `_region` arrays with
  the full arguments (256 distinct entries each instead of 32);
  `image_payload_available`; and `texture_update_unknown`. `root.json` gains
  `texture_defaults` (`filter`, `repeat`: the root `Viewport`'s scene enums read at
  arm, −1 when unread).

## Safety model

- **Refusing by default.** No `GRC_CALIBRATION`, no action. Default `GRC_MODE` is
  `validate`, which never writes.
- **Identity before anything else.** sha256 of `/proc/self/exe`, the GNU build-id
  (required absent when the record says `null`), the `get_godot_version2` version
  string, PIE flag and load bias must all match the record; a PIE binary's bias
  is taken from `dl_iterate_phdr` and added to the recorded addresses.
- **No call into an unidentified slot, ever.** The live checks only _read_ vtable
  words. The one behavioural call is `get_default_clear_color`, which the record
  names, compared byte for byte against the same method reached through
  `classdb_get_method_bind` + `object_method_bind_ptrcall`. This is what proves
  the derived indices are real and not just self-consistent.
- **One write.** A single aligned pointer-sized store with release ordering into
  heap memory the engine allocated for the singleton. Nothing else in the process
  is modified: the library imports neither `mprotect` nor `mmap` (checked with
  `nm -D --undefined-only`), and an `strace` of an armed run shows no `mprotect`
  from the arming thread after the `armed.marker` `openat`.
- **Verified restore.** Disarm compares the live vptr with our shadow address
  point before restoring, and re-reads it afterwards; both facts land in
  `disarm.json`.
- **Failure is refusal, not a crash.** A missing `Image` method bind downgrades
  texture captures to counts only; a failed check refuses with a reason; the
  hooks hold no locks across the forwarded call except the small capture mutex,
  and counters are atomics because calls arrive from loader threads too.

What this does **not** establish:

- that the shipped game's stripped fork has the same vtable layout. It needs its
  own record, which is exactly what the calibrator is for.
- that the capture is complete. 55 of the 565 `RenderingServer` virtuals are
  hooked.
- anything about performance.

## Gate −1 result (2026-10-08)

**Pass.** The integrated run is
`artifacts/render-stream/gate-minus1/20261009T020323Z/` (ignored, not committed; produced
in the integration worktree). Its `result.json` passes 18 of 18 checks across the eight
criteria in [scripts/README.md](scripts/README.md). The fixture is `fixtures/spike/` on
the pinned template.

| Leg                                 | Measured                                                                                                                                                                                                                                                                                                           |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `headless-armed`                    | display server `headless`; armed at scene init, disarmed after 60 armed frames (`vptr_was_shadow`, `vptr_restored`), then 340 more frames, `frames=400`, exit 0                                                                                                                                                    |
|                                     | in those 60 frames: `add_rect` 62, `add_polygon` 61, `add_texture_rect_region` 17, `add_msdf_texture_rect_region` 0, `add_texture_rect` 0, `texture_2d_create` 2 (an 800×6 format-5 image and the 256×256 format-1 glyph atlas, frame 1), `texture_2d_update` 1 (the atlas, frame 30, the relabel frame), `free` 0 |
|                                     | scripted rect, ColorRect rect `(0, 0, 120, 80)` in local coordinates with its colour, and the 3-point polygon all bit-exact against `fixtures/spike/expected.json`                                                                                                                                                 |
|                                     | no GPU device or driver library in the whole-run `openat` trace or in the maps/fd sample taken after arming; 1 `mprotect` after `armed.marker`, an anonymous 132 KiB malloc arena, none in the executable's 5 mapped ranges                                                                                        |
| `headless-validate`                 | `validated`, `vptr_written: false`                                                                                                                                                                                                                                                                                 |
| `refuse-sha` / `refuse-binary-byte` | `fingerprint-mismatch` (record digest changed / one byte flipped in the unmapped `.comment` section), `vptr_written: false`                                                                                                                                                                                        |
| `refuse-prefix`                     | `slot-mask-mismatch` (anchors 11/17 with every index +1), `vptr_written: false`                                                                                                                                                                                                                                    |
| `refuse-nocal`                      | `no-calibration`, `vptr_written: false`                                                                                                                                                                                                                                                                            |
| `rendered-armed`                    | OpenGL 3.3 Compatibility on the RTX 2060 under X11 in private gamescope; armed for all 400 frames: `add_rect` 401, `add_polygon` 400, `add_texture_rect_region` 17, `free` 7                                                                                                                                       |
| `rendered-unarmed`                  | capture extension absent; `unarmed.png` and `armed.png` are byte-identical files (sha256 `4ae01e54…`)                                                                                                                                                                                                              |

### The gate fails when it should

Three sabotaged runs, none committed, each failing exactly one check, all under
`artifacts/render-stream/gate-minus1/`:

| Sabotage                                         | Run                       | Failing check                                  |
| ------------------------------------------------ | ------------------------- | ---------------------------------------------- |
| `SCRIPT_RECT.x` 213.25 → 213.5 in `spike.gd`     | `sabotage-a-script-rect/` | #4 `script-add-rect`                           |
| `ShadowVtable::disarm` skips the restoring store | `sabotage-b-no-restore/`  | #6 `disarm-restored` (`vptr_restored: false`)  |
| `hook_add_rect` forwards green + 1/255           | `sabotage-c-hook-colour/` | #7 `armed-vs-unarmed-pixels` (channel delta 1) |

In (c), pixelmatch reported 0 differing pixels. The explicit `maxChannelDelta: 0` caught
the change.

### What this proves

- A GDExtension loaded at runtime into the unmodified official 4.5.1 release template
  can interpose on `RenderingServer` under `--headless` with one pointer store. It
  makes no code-page change and opens no GPU device. It sees native Control drawing,
  the Label glyph path including the atlas update the relabel causes, and direct
  script calls, all with exact argument bytes.
- It disarms cleanly. Rendered output is byte-identical with capture armed and with
  capture absent.
- It refuses before writing on a wrong digest, a wrong slot table, a missing record
  and a one-byte binary change.

### What this does not prove

- The `add_msdf_texture_rect_region` and `add_texture_rect` hooks were never called:
  the default font is a bitmap atlas, and the fixture has no `TextureRect`. They are
  installed, but their argument decoding has not been exercised.
- Only 8 slots were hooked in that run, so nothing in it says the capture is
  complete. The 23 draw-path hooks added afterwards are covered in the next
  section.
- Only Linux x86-64 and this one binary were tested. The startup-loaded path (deferred
  arming) was not run here; it was run, and fixed, on 2026-10-09 (see "Runtime contract").
- MegaDot and the shipped game were not tested. Their stripped fork needs its own
  record, which is gate −0.5.
- No costs were measured.

## Gate −0.5 result (2026-10-09)

**Pass.** The operator approved the run. The library ran unmodified with
`GRC_MODE=validate` against the installed STS2 binary (`MegaDot v4.5.1.m.14.mono.custom_build`,
non-PIE, with a GNU build-id). The instance was owned, isolated and `--headless`, run under
sts2-couch-coop's instance rules.

- **Offline calibration.** `calibrate.py --version-name MegaDot` against the pinned 4.5.1 header gives
  588 slots: Object prefix **23** plus 565 `RenderingServer` virtuals. **17/17** anchors match, the
  mask is unique, so there are no interior insertions, and the pure placeholder is 0. The hooked-slot
  indices are identical to the stock release template's. The record holds addresses and a digest of a
  commercial binary, so it is kept in that repository's ignored research folder, not here.
- **Load route.** The modder route. An env-gated, dev-only couch-coop hook calls
  `GDExtensionManager.LoadExtension(<absolute .gdextension>)` at mod init and logs `LoadStatus` `Ok`.
  It runs on a couch-coop branch and is not merged. The mod was deployed into a private game-root
  copy, not into the install. The extension decided at `scene-init`.
- **Decision.** `validated`, `vptr_written: false`. All 13 runtime checks pass: digest, version
  string, build-id, bias, live concrete vptr equal to the recorded address + 16, anchors 17/17 in
  memory, hooked slots pure in the abstract table and implemented in the concrete one, and the
  `get_default_clear_color` probe byte-equal through the slot and through the method bind. The game
  reached its normal main-menu readiness and stayed up through the settle window.
- **Negative.** The every-index-+1 record is refused `slot-mask-mismatch` with anchors 11/17, before
  the behavioural probe.
- **Safety.** The operator's profile, the Steam remote store and the install's binaries hash identical
  before and after.
- **Teardown.** After the main menu, the game ends on SIGTERM by SIGABRT ("terminate called without an
  active exception"), with or without the extension. The control leg reproduced it, so "no crash" is
  judged over the running window.

## Draw-path hooks for gate −0.25 (2026-10-09)

Gate −0.25 arms counters on the real game. It needs counters for the paths the
game draws through: Spine rigs drawn by the spine-godot GDExtension, nine-patch
styleboxes, meshes and primitives. Calibrator 2 adds 23 optional hooks for those
paths (the tier-2 rows of the slot table above). The fixture now drives every one
of them.

**Pass.** Run `artifacts/render-stream/gate-minus1/20261009T031006Z/` (ignored,
not committed) passes 28 of 28 checks: the 18 gate −1 checks plus 10 new ones,
listed in [scripts/README.md](scripts/README.md) as #7 `new-drawings-visible`,
#9 and #10.

### spine-godot's draw path

spine-godot draws through `canvas_item_add_mesh`, not
`canvas_item_add_triangle_array`. The source is
`spine-godot/spine_godot/SpineSprite.cpp` on the `4.2` branch of
EsotericSoftware/spine-runtimes. That file was fetched and read, and it matches
the pinned copy at commit `e7dc1435`
(`sts2-couch-coop/.sts2/research/data/spine-reliable-sep04/upstream/`, sha256
`8eb74951…`). Each `SpineMesh2D` runs `_notification(NOTIFICATION_DRAW)`, which
calls `clear_triangles` (`canvas_item_clear`) and then `add_triangles`. In 4.x
`add_triangles` calls `update_mesh`. The `#ifdef SPINE_GODOT_EXTENSION` branch is
the one a GDExtension build such as the game's `libspine_godot` compiles:

- **When the mesh is rebuilt** (vertex or index count changed): `free_rid` (the
  `free` slot), `mesh_create`, then `mesh_add_surface_from_arrays` with the
  `ARRAY_FLAG_USE_DYNAMIC_UPDATE` flag. That method is implemented in
  `RenderingServer` itself and calls the virtual `mesh_add_surface`
  (`servers/rendering_server.cpp:1390-1396`). It then calls `mesh_get_surface`
  and the stride getters, which only read.
- **Every other frame**: `mesh_surface_update_vertex_region(mesh, 0, 0, …)`,
  `mesh_surface_update_attribute_region(mesh, 0, 0, …)` and
  `mesh_set_custom_aabb`.
- **Always**: `canvas_item_add_mesh` of that mesh, with an identity transform, a
  white modulate and the renderer object's canvas texture.

`canvas_item_add_triangle_array` appears only in the Godot 3
`VisualServer` branch. A GDExtension reaches these methods through ClassDB
method binds, and those binds call the virtual member functions
(`rendering_server.cpp:2350-2375`, `3315`, `3327`, `3471`). Every call in the
list above therefore dispatches through the shadow vtable, and each one has a
hook. The fixture's ArrayMesh reproduces this shape: one surface with dynamic
update, per-frame vertex and attribute region writes, a custom AABB each frame,
then `canvas_item_add_mesh`.

### Counts in the headless-armed leg (armed for 60 frames)

| Hook                                                                                                                       | Count | Source                                                                                             |
| -------------------------------------------------------------------------------------------------------------------------- | ----- | -------------------------------------------------------------------------------------------------- |
| `canvas_item_add_triangle_array`                                                                                           | 62    | script (61, bit-exact) + the Panel's `StyleBoxFlat` (108 points, 318 indices, native)              |
| `canvas_item_add_nine_patch`                                                                                               | 62    | script (61, bit-exact, on its 4×4 texture) + `NinePatchRect` (native, same texture RID)            |
| `canvas_item_add_primitive`, `_line`, `_polyline`, `_circle`, `_set_transform`                                             | 61    | script, each bit-exact                                                                             |
| `canvas_item_add_mesh`, `canvas_item_add_multimesh`                                                                        | 61    | script, mesh RID = the ArrayMesh's `mesh_create`                                                   |
| `mesh_surface_update_vertex_region`, `_attribute_region`, `mesh_set_custom_aabb`                                           | 60    | script `_process`, once per armed frame; offset 8, 8 bytes `0080dc420040a543` / 4 bytes `ffff00ff` |
| `mesh_create` / `mesh_add_surface`                                                                                         | 2 / 2 | the ArrayMesh (format `34460401673`, 3 vertices, 24 + 12 bytes, AABB) + a scratch mesh             |
| `mesh_clear`                                                                                                               | 1     | the scratch mesh                                                                                   |
| `canvas_item_clear`                                                                                                        | 67    | engine, every redraw                                                                               |
| `canvas_item_set_transform`                                                                                                | 5     | engine                                                                                             |
| `canvas_item_create`                                                                                                       | 1     | a `Node2D` created after arming (the scene's own items exist before the extension loads)           |
| `canvas_item_set_modulate`, `canvas_item_set_material`, `material_set_param`, `shader_create_from_code`, `shader_set_code` | 1     | the Panel's modulate and `ShaderMaterial`, RIDs consistent across all five                         |

The rendered-armed leg is armed for all 400 frames on OpenGL under X11. It counts
400 or 401 calls of every per-frame hook, so the same paths are hooked on the GPU
renderer too. `unarmed.png` and `armed.png` are still byte-identical (sha256
`985ed809…`), and the new drawings appear in both. Each one covers a sample pixel,
and one sample lies inside the mesh only because the per-frame vertex update
moved that vertex.

A calibrator-1 record (leg `old-record`) arms with 8 hooks and omits 23. Each
omitted hook has a `null` count and is named in `hook_plan`. The armed run counts
`add_rect` 62 and `add_polygon` 61, and disarm restores the vptr.

### What is left

- `canvas_item_add_texture_rect` and `canvas_item_add_msdf_texture_rect_region`
  are still never called by this fixture, as at gate −1. Every tier-2 hook is
  exercised.
- Count-only by design: `shader_create_from_code`, `shader_set_code` and
  `material_set_param` record RIDs and leave their `String`, `StringName` and
  `Variant` arguments undecoded. Those are reference-counted, owning types, so
  decoding them means reproducing more engine ABI than a counter needs. Gate 5.5
  needs captured shader source, and that should go through a ClassDB call rather
  than a layout copy. The three gate −1 hooks `texture_rect`,
  `texture_rect_region` and `msdf_texture_rect_region` also stay count-only.
- Not hooked but on spine-godot's path: `mesh_get_surface` and the format and
  stride getters. They are read-only queries and draw nothing.
- Signatures that needed care: `canvas_item_add_mesh` takes its mesh RID **by
  reference**. `canvas_item_add_nine_patch` passes its axis modes as 4-byte enums
  and puts `draw_center` and `modulate` on the stack. The fixture captures
  `draw_center = false` and the modulate exactly, which proves the tail of that
  argument list. `mesh_add_surface` takes `SurfaceData` by reference.

## Gate −0.25 result (2026-10-09)

**Pass.** The operator approved this gate too. It used the same owned, isolated `--headless` STS2
instance and the same modder load route as gate −0.5, with the 31-hook library. The record was
re-derived with the version-2 calibrator: 31 of 31 hooks are named, and the indices are identical to
the stock template's. The run was `GRC_MODE=arm` with `GRC_DISARM_AFTER_FRAMES=2000`.

- **Readiness.** Normal main-menu readiness at 27 s. The library armed at `scene-init`, stayed armed for
  about 4 minutes (2000 frames at the game's idle frame cap) and disarmed itself with
  `vptr_was_shadow` and `vptr_restored`. The game stayed up afterwards. RSS was flat and there was no
  crash.
- **Counts.**

  | Hook                                       | Count  |
  | ------------------------------------------ | ------ |
  | `canvas_item_add_rect`                     | 3      |
  | `canvas_item_add_texture_rect`             | 6      |
  | `canvas_item_add_texture_rect_region`      | 25     |
  | `canvas_item_add_msdf_texture_rect_region` | 247    |
  | `canvas_item_add_mesh`                     | 65 604 |
  | `mesh_surface_update_vertex_region`        | 65 571 |
  | `mesh_surface_update_attribute_region`     | 65 571 |
  | `mesh_set_custom_aabb`                     | 65 571 |
  | `mesh_create`                              | 83     |
  | `texture_2d_create`                        | 1 526  |
  | `canvas_item_add_triangle_array`           | 0      |
  | `canvas_item_add_nine_patch`               | 0      |
  | `canvas_item_add_polygon`                  | 0      |

  The three equal mesh counts are spine-godot's per-frame pattern. They show the rigs animating
  through a third-party extension on the dummy renderer. This is the first live exercise of the
  `texture_rect` and `msdf_texture_rect_region` hooks.

- **Teardown.** Writing evidence by frame count matters here, because this game ends on SIGTERM by
  SIGABRT before any GDExtension shutdown callback runs.

## Gate 0 WP1: calibrator 3, mirror and root query (2026-10-09)

Calibrator 3 adds the 11 tier-3 hooks (slot table above). Gate −1 with them, run
`artifacts/render-stream/gate-minus1/20261009T043727Z/` (ignored), passes 28 of 28 checks with
42 hooks planned and none omitted, and `armed.png` is still byte-identical to `unarmed.png`. The
headless-armed counts of the new hooks are `viewport_attach_canvas`, `viewport_set_canvas_transform`,
`canvas_create`, `canvas_item_set_self_modulate` and `canvas_item_set_z_index` 1 each (the spike's
post-arm `CanvasLayer` and `Node2D`); `canvas_item_set_parent`, `_set_visible`,
`_set_visibility_layer` and `_set_draw_index` 6 each (the scene entering the tree after arming);
and `canvas_item_set_clip` and `_set_custom_rect` 5 each (`Control` redraws). The captured values
decode exactly: the `ColorRect`'s custom rect is `0,0,120,80`, `z_index` is 1, and the
self-modulate bits are those of `Color(0.5, 0.75, 1, 1)`.

A temporary `GRC_RS0_PROBE` hook (removed when the stream was wired) proved the mirror and the
root query at runtime before the publisher existed. On a
scratch fixture shaped like gate 0's (a root `Node` that creates its `Node2D`s in `_ready`), the
root query returned the root viewport and canvas RIDs, an identity canvas transform, cull mask
`0xffffffff` and the project's clear colour, and the snapshot was `ok`: two items on canvas 1 in
append order with draw indices 0 and 1, the moved transform, the redrawn colour, and the freed
child gone. On the spike, whose scene items exist before arming, it was `pre-existing-object` at
the root node's `canvas_item_set_parent`, with the `CanvasLayer` reported as `extra-canvas`.

One measured fact differed from the first contract text: under `--headless`, the root
`Viewport.get_visible_rect()` at arm time is `0, 0, 64, 64`, not `0, 0, 0, 0`. The headless
display server reports `Size2i()`, but `SceneTree` gives the root window a 64×64 minimum size
(`scene/main/scene_tree.cpp:2035`), and `Window::_update_window_size` clamps to it
(`scene/main/window.cpp:1144-1150`). The session records the value as read, so only the
documentation was affected; both protocol documents now say 64×64.

## Gate 0 result (2026-10-09)

**Pass.** The integrated run is `artifacts/render-stream/gate0/20261009T050442Z/` (ignored, not
committed; produced in the integration worktree). Its `result.json` has `gate_passed: true` and
passes 19 of 19 checks ([protocol/gate0-design.md](protocol/gate0-design.md) "Checks"). Every leg
classifies as expected. The capture host is the pinned release template under `--headless` with
the 42-hook library armed at `scene-init` (calibrator 3, none omitted); the reference and the
receiver are the same template rendering OpenGL 3.3 on the RTX 2060 inside one private gamescope.
Gate −1 on the same build still passes 28 of 28
(`artifacts/render-stream/gate-minus1/20261009T050631Z/`).

| Leg                       | Class (expected = measured)           | Measured                                                                                                                                                                                                                                                    |
| ------------------------- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `capture`                 | `success`                             | 400 transactions, frames 1..400, every status `ok`; `bytes_total` 429 425 (file 429 610 with the end record), `max_record_bytes` 2 873 (the session; transactions 1 062–1 067), `encode_ns_total` 2 184 113, `snapshot_ns_total` 378 958                    |
|                           |                                       | session: `display_server` `headless`, `clear_color` `0.2, 0.2, 0.4, 1`, identity root canvas transform, cull mask `4294967295`, `host_visible_rect` `0, 0, 64, 64`; no GPU device or library in the `openat` trace or the maps/fd sample                    |
|                           |                                       | 39 intercepted calls in 400 frames: 2 `canvas_item_create` (the `Node2D`s, after arming), 4 `set_parent`, 2 `set_draw_index` (0 and 1), 4 `set_transform` (2 initial, 2 moves), 8 `clear` + 8 `add_rect` (3 subject and 5 marker draws), 6 `free`           |
| `reference`               | support                               | 5 shots, each equal to `synthesizeExpected(k)` exactly                                                                                                                                                                                                      |
| `receiver`                | `success`                             | 400 seqs applied in order, each `record_sha256` equal to the host's; shots of seqs 8, 18, 28, 38, 48 (the settle frames), each equal to `synthesizeExpected(k)` and to the reference: 0 mismatched pixels, max channel delta 0, full frame and both regions |
| `receiver-headless-trace` | support                               | applied `ok`; no successful `openat` under `fixtures/`; no receiver file shares a sha256 with a fixture file                                                                                                                                                |
| `sabotage-freeze`         | `pixel-mismatch`, steps {2,3,4}       | 52 transactions; steps 0–1 exact; step 2: 7 168 px (subject 6 144, marker 1 024), steps 3 and 4: 13 312 px each; max channel delta 255                                                                                                                      |
| `sabotage-omit`           | `pixel-mismatch`, step {2}            | 52 transactions; steps 0–1 exact; step 2: 7 168 px (subject 6 144, marker 1 024), delta 255; steps 3–4 exact again (the next update repairs the snapshot)                                                                                                   |
| `sabotage-perturb`        | `pixel-mismatch`, steps {2,3,4}       | 52 transactions; steps 0–1 exact; steps 2–4: 192 px each (subject 64, marker 32 inside the regions: one-pixel columns at both edges of each rect), delta 204                                                                                                |
| `unsupported`             | `unsupported`                         | the recording carries `canvas_item_add_circle` as an `unsupported` command and an `unsupported-op` entry from step 2; the headless receiver reports it in `applied.json`, does not draw it, and ends `ok`                                                   |
| `preexisting`             | `capture-failure`                     | every one of 52 transactions is `pre-existing-object`: `rid=… op=canvas_item_set_parent frame=1` (the `.tscn`'s `Node2D`, constructed before arming)                                                                                                        |
| `corrupt`                 | `replay-failure` (seq 3, `meta-json`) | the receiver applied seqs 1–2 (24 and 0 RS calls), rejected seq 3 (`meta byte 0 is 0x00`) before any RS call for it, and exited 3                                                                                                                           |

Images, all under the run directory:

- Reference: `reference/shots/step-<k>.png` (k = 0..4).
- Receiver: `receiver/shots/seq-{8,18,28,38,48}.png`; per-step diffs `receiver/diff/step-<k>.png`
  (all blank).
- Sabotage: `sabotage-{freeze,omit,perturb}/receiver/shots/seq-<n>.png` and
  `sabotage-*/receiver/diff/step-<k>.png`; for example `sabotage-freeze/receiver/diff/step-3.png`
  marks the stale marker, the stale subject and the missing moved subject.

### The gate fails when it should

| Sabotage (capture host)                                 | What the receiver drew                                    | Check that classifies it                        |
| ------------------------------------------------------- | --------------------------------------------------------- | ----------------------------------------------- |
| `freeze-frame` at 21: republish the frame-20 snapshot   | step 1's picture from step 2 on                           | `leg-class-sabotage-freeze`                     |
| `omit-update` at 21: mutations stamped 21 not mirrored  | step 1's picture at step 2 only; step 3 repairs it        | `leg-class-sabotage-omit`                       |
| `perturb-transform` at 21: `origin.x + 1` on every item | everything one pixel to the right from step 2             | `leg-class-sabotage-perturb`                    |
| fixture draws a circle (`RS_FIXTURE_VARIANT`)           | the rectangles, with the circle reported and not drawn    | `leg-class-unsupported`                         |
| scene item constructed before arming                    | (no receiver: the capture is unusable)                    | `leg-class-preexisting` (`pre-existing-object`) |
| seq 3's first meta byte zeroed in the receiver's copy   | seqs 1–2, then a replay failure with no RS call for seq 3 | `leg-class-corrupt`                             |

In each sabotage leg steps 0 and 1 matched exactly, so the mismatch starts where the sabotage does.
The classifier never reads `session.sabotage`. The publisher's refusal path was also run by hand
(not a gate leg): `GRC_SABOTAGE=bogus` and `GRC_SABOTAGE_FRAME=0` each armed, created no file and
left `stream.status: "refused"`; `GRC_DISARM_AFTER_FRAMES=30` ended a valid recording with
`reason: "disarm"` after 30 transactions.

### What this proves

- The stock 4.5.1 release template under `--headless`, with no GPU device opened, can publish a
  self-validating snapshot of the hooked canvas state every frame, through the gate −1
  interposition alone, and the snapshot is enough to redraw this fixture exactly.
- A separate Godot project that has no extension, no autoload and no copy of the fixture rebuilds
  that canvas from the recording through ordinary `RenderingServer` calls, and renders it
  pixel-identically to both the fixture rendered normally and an image synthesized from
  `expected.json` at five checkpoints.
- The receiver consumed exactly the bytes the host wrote (record hashes match), and a frozen,
  dropped or shifted update shows up as a pixel mismatch at the step where it starts.

### What this does not prove

- One rectangle per item, opaque, axis-aligned, integer coordinates, colours that land exactly on
  8-bit values, no overlap, no ties in `draw_index`. Every other draw op is only reported as
  `unsupported`; textures, text, materials and meshes are not streamed.
- The `unobserved` state in the session (texture filter/repeat, light mask, `z_as_relative`,
  y-sort, `canvas_set_modulate`, ...) is not hooked, so a scene that changes it would replay
  wrongly without any failure being reported.
- Arming must precede every canvas item (route (a), a fixture autoload). Late join and the
  deferred-arming path are gate 8; on them the capture is `pre-existing-object` by design.
- The receiver replays from a file, one transaction per `_process`, with no pacing, transport,
  credit or coalescing (gate 1). Cost numbers are for two items: about 5.4 µs encode and 0.95 µs
  snapshot per frame, about 1 060 bytes per transaction.
- Not run on MegaDot or the shipped game.

## Gate 1a result (2026-10-09)

**Pass.** The run is `artifacts/render-stream/gate1/20261009T055845Z/` (ignored, not committed;
produced in the G1a worktree). Its `result.json` (`render-stream-gate1-report/1`) has
`gate_passed: true`, with groups `g1a` run and none missing, and 22 of 22 checks pass
([protocol/gate1-design.md](protocol/gate1-design.md) "G1a"). Every leg classifies as expected.
The hosts are gate 0's: the pinned release template under `--headless`, with the 42-hook library
armed at `scene-init`; and the same template rendering OpenGL 3.3 on the RTX 2060 inside one
private gamescope. Runs on the same build:

- gate 0: `artifacts/render-stream/gate0/20261009T060059Z/` still passes 19 of 19, with
  `run-gate0.sh` now on the shared `lib/legs.sh`;
- gate −1: `artifacts/render-stream/gate-minus1/20261009T060243Z/` still passes 28 of 28.

**Root geometry.** The capture host's `evidence/root.json` reads:

- logical size 640×360, stretch `disabled`/`keep`/`fractional`, content scale factor 1;
- before the policy, window 64×64 and visible rect `0,0,64,64` (the headless minimum);
- after `Window.set_min_size(640×360)`, window 640×360 and visible rect `0,0,640,360`;
- canvas and final transforms identity both before and after, so `host_size_status` is `match`.

The host fixture's own `root.jsonl` equals the reference's line for line except `display_server`
(`headless` against `X11`). Canvas 1's transform in the recording equals the reference's at all 11
settle transactions: identity through step 9, `1,0,0,1,8,4` at step 10. Without the policy
(`root-size-observe`), the host declares `degenerate-visible` with window and visible rect
64×64.

| Leg                        | Class (expected = measured)            | Measured                                                                                                                                                                                                                                                            |
| -------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `capture`                  | `success`                              | 400 transactions, every status `ok`, 20 item ids in creation order (P=1 … X=19, L2=20); `bytes_total` 2 339 645, `max_record_bytes` 6 924, `encode_ns_total` 5 599 177 (14 µs/frame), `snapshot_ns_total` 1 366 025 (3.4 µs/frame); no GPU device or library opened |
|                            |                                        | all 45 `expected.json` invariants hold on the settle transactions; no draw-index tie in any of the 400 transactions; marker colours first published at frames 1, 11, 21, …, 101                                                                                     |
| `reference`                | support                                | 11 shots, each equal to `synthesizeGate1(k)` exactly                                                                                                                                                                                                                |
| `receiver`                 | `success`                              | 400 seqs applied in order with the host's hashes, 321 RS calls (227 at seq 1); shots at seqs 8, 18, …, 108 equal to the reference and to `synthesizeGate1(k)`: 0 pixels, full frame and all 8 regions                                                               |
| `receiver-headless-trace`  | support                                | applied `ok`; no successful `openat` under `fixtures/`; no receiver file shares a sha256 with a `fixtures/gate1` file                                                                                                                                               |
| `sabotage-omit-modulate`   | `pixel-mismatch`, steps {1..10}        | step 1: 8 448 px (hierarchy 7 424, marker 1 024); steps 2–10: hierarchy 7 424 each (`P`, `C`, `G` keep their step-0 colours); delta 255                                                                                                                             |
| `sabotage-omit-transform`  | `pixel-mismatch`, steps {2..10}        | step 2: 10 240 px (hierarchy 6 912, order 2 304 = `R1`'s lost recolour, marker 1 024); steps 3–4: 9 216; steps 5–10: hierarchy 6 912 (`R1` is under `Q1` from step 5 and redrawn when re-added at 9); delta 204–255                                                 |
| `sabotage-omit-order`      | `pixel-mismatch`, steps {3}            | step 3: 2 048 px (the 32×32 `Q1`/`Q2` overlap and the marker); steps 4–10 exact again                                                                                                                                                                               |
| `sabotage-omit-visibility` | `pixel-mismatch`, steps {7..10}        | step 7: 7 424 px (visibility 4 096 = `V` still hidden, content 2 304 = `K` not cleared, marker 1 024); steps 8–10: visibility 4 096; delta 153–204                                                                                                                  |
| `root-size-observe`        | `unsupported` (`degenerate-host-size`) | declared `degenerate-visible`, visible `0,0,64,64`; every step mismatches in exactly `corner` (1 024 px) and `corner-degenerate` (1 024 px), with 0 px outside the regions. At step 10 `corner` has 672 px: the shifted `Corner` at 616,332 is clipped to 24×28     |

Images, all under the run directory:

- Reference: `reference/shots/step-<k>.png` (k = 0..10).
- Receiver: `receiver/shots/seq-{8,18,…,108}.png`. The per-step diffs
  `receiver/diff/step-<k>.png` are all blank.
- Sabotage: `sabotage-omit-{modulate,transform,order,visibility}/receiver/shots/seq-<n>.png` and
  `…/receiver/diff/step-<k>.png`. For example, `sabotage-omit-order/receiver/diff/step-3.png`
  marks only the `Q1`/`Q2` overlap and the marker.
- Root size: `root-size-observe/receiver/diff/step-<k>.png` marks the missing bottom-right
  `Corner` and the one drawn at 32,32.

### The sabotage predictions, confirmed

Each sabotage drops every mirror mutation stamped with one step's applied frame (`omit-update`).
The engine still renders it.

| Sabotage                                    | Predicted (gate1-design.md)                        | Measured | Why the set ends where it does (engine source)                                                                                                                                        |
| ------------------------------------------- | -------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `omit-update` at 11 (modulate)              | {1..10}                                            | {1..10}  | `modulate` and `self_modulate` are never set again                                                                                                                                    |
| `omit-update` at 21 (transform)             | {2..10}                                            | {2..10}  | `P` and `C` never move again. `R1`'s lost recolour is only repaired at step 9, when re-entering calls `queue_redraw` (`scene/main/canvas_item.cpp:286`), so it cannot end the set     |
| `omit-update` at 31 (order)                 | {3}                                                | {3}      | `move_child` sets child draw indices in the same frame (`update_draw_order`, `canvas_item.cpp:443-444`). At step 4 `Q2`'s z puts it on top in both worlds, and step 5 moves `Q1` away |
| `omit-update` at 71 (visibility)            | {7..10}                                            | {7..10}  | `V` is never shown again in the mirror. `K` is repaired at step 8. `V1` is hidden either way (layer 0 against stale `visible: false`)                                                 |
| `GRC_ROOT_SIZE` unset (`root-size-observe`) | `unsupported`, regions {corner, corner-degenerate} | same     | the `Corner` `ColorRect` lays out against a 64×64 parent rect                                                                                                                         |

Every prediction held on the first run, so no expectation was changed. Two refusal paths were also
run by hand rather than as legs. `GRC_ROOT_SIZE=stretch-it` armed, created no recording and left
`stream.status: "refused"` with the reason. `RS_FIXTURE_STEP_FRAMES=7`,
`RS_FIXTURE_START_FRAME=0`, `RS_FIXTURE_QUIT_FRAME=100`, a relative `RS_FIXTURE_ROOT_LOG` and
`RS_FIXTURE_VARIANT` each print `[fixture] error: …` and exit 2. `S=300, N=60` (the live legs'
timeline) logs step 1 at frame 360 and step 10 at frame 900.

### Findings

- **Root size.** `enforce-min-size` is enough on a headless 4.5.1 host. One ptrcall of
  `Window.set_min_size` at arm grows the root from 64×64 to the logical size. That happens before
  the main scene's `Control`s lay out, so the size-anchored `ColorRect` is pixel-exact. The final
  (stretch × global canvas) transform stays identity. Without the policy,
  the only pixel difference in this fixture is that `Control`.
- **Draw-order ties are transient, not absent, in node-driven scenes.** None of the capture's 400
  transactions has a tie. But a top-level `CanvasItem` gets its index from `_top_level_raise_self`,
  a deferred group call that is queued while the message queue flushes. That is after
  `SceneTree::process`'s last `_flush_ugc` (`scene/main/scene_tree.cpp:708-709`), so it runs at
  the next iteration's first one (`:644`). Measured in this run: step 8's re-raise lands at frame
  82, and step 9's at 92. On frame 91, `L2` still has the RenderingServer default index 0 and the
  re-added `D` its stale 7. They tie with nothing only because step 8 had already moved the other
  top-level items to 10..16. A scratch copy of the fixture that adds a top-level node at step 1
  shows the tie: on frame 11 the new item and `P` both have index 0, and on frame 12 the new item
  has 10. So D7's "node-driven scenes never produce ties" holds only for frames after the raise.
  Once G1b2 reports `draw-index-tie`, any scene that adds a top-level item at runtime will report
  it for that one frame. Child indices (`move_child`, reparenting under an item) are set in the
  same frame. G1b2 has to decide whether such a one-frame tie is item-level `unsupported` or
  something the receiver resolves (the engine's sort is stable up to 16 siblings, so the newly
  appended item is drawn last).
- **Receiver.** The three candidates gate1-design.md listed needed no change: `X` orphaned by a
  raw parent free, `R1` re-appended under an unchanged parent, and `D` re-attached with its old
  id. The applier's free pass, parent pass and order pass already reproduce the engine's
  semantics (receiver shots exact at steps 8 and 9). Mirror unit tests now pin the two
  mirror-side cases (`rs0_mirror_test.cpp`: detach and re-attach keep the id; a raw parent free
  leaves a detached, still addressable child).

### What G1a does not prove

- render-stream/1, patches, the live adapter, credit, stalls, resync and reconnect: G1b–G1d.
- `z_as_relative` and `draw_behind_parent` are still unobserved (G1e). The fixture never changes
  them.
- The root-size policy was measured only on stretch `disabled`. `canvas_items` and `viewport`
  hosts declare their stretch but were not run, and the receiver applies no stretch of its own
  (G1b2 declares it on the wire).
- The fixture is still axis-aligned opaque rects on integer pixels (the one rotation is exactly
  90°), with no textures or text.

## Gate 1b result (2026-10-09)

**Pass.** The run is `artifacts/render-stream/gate1/20261009T070813Z/` (ignored, not committed;
produced in the G1b2 worktree). Its `result.json` has `gate_passed: true`, groups `g1a` and `g1b`
run and none missing, and 34 of 34 checks pass
([protocol/gate1-design.md](protocol/gate1-design.md) "G1b2"). Every leg classifies as expected.
The capture library, the receiver and both runners now speak
[render-stream/1](protocol/render-stream-1.md); render-stream/0's encoder, publisher and GDScript
decoder are gone, and its goldens stay as checked history. Runs on the same build:

- gate 0: `artifacts/render-stream/gate0/20261009T071223Z/` passes 19 of 19 on /1, every capture
  under `GRC_ROOT_SIZE=enforce-min-size` (400 transactions, `bytes_total` 486 354,
  `max_record_bytes` 3 402);
- gate −1: `artifacts/render-stream/gate-minus1/20261009T071402Z/` still passes 28 of 28.

**Full sink against patch sink.** Every gate 1 capture writes both from one mirror snapshot per
frame. For the 400-frame `capture` leg (end records, rounded per frame):

| Sink                          | `bytes_total` | `max_record_bytes` | median / max transaction | `encode_ns_total` | `diff_ns_total`  | `snapshot_ns_total` (shared) |
| ----------------------------- | ------------- | ------------------ | ------------------------ | ----------------- | ---------------- | ---------------------------- |
| full (`recording.rs1`)        | 2 728 254     | 8 078              | 6 532 / 8 078 B          | 8 255 748 (21 µs) | 0                | 3 304 783 (8.3 µs)           |
| patch (`recording-patch.rs1`) | 171 195       | 7 623 (seq 1)      | 354 / 3 496 B            | 878 177 (2.2 µs)  | 1 999 967 (5 µs) | 3 304 783                    |

The patch sink is 6.3 % of the full one. Its seq 1 is the one full transaction (7 623 bytes); the
largest patch, 3 496 bytes, is a step that redraws several items. Resolved, the patch recording
equals the full one at all 400 frames, floats bit for bit.

| Leg                      | Group | Class (expected = measured)            | Measured                                                                                                                                                             |
| ------------------------ | ----- | -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `capture`                | g1a   | `success`                              | 400 transactions, 21 item ids (P=1 … X=19, T=20, L2=21); all 48 invariants hold; one declared tie, frame 11, harmless                                                |
| `receiver`               | g1a   | `success`                              | shots at the 11 settle seqs equal the reference and `synthesizeGate1(k)`; state dumps at the settle seqs                                                             |
| `sabotage-omit-*` (four) | g1a   | `pixel-mismatch`                       | step sets as at G1a: {1..10}, {2..10}, {3}, {7..10}                                                                                                                  |
| `root-size-observe`      | g1a   | `unsupported` (`degenerate-host-size`) | now declared in the session (`degenerate-visible`, `host_visible_rect` 0,0,64,64) and in every transaction; mismatch only in `corner` and `corner-degenerate`        |
| `receiver-patch`         | g1b   | `success`                              | on the patch recording: the same 11 shots as `receiver`, pixel for pixel; equal state dumps; identical RS calls at all 400 seqs (378 in all)                         |
| `sabotage-omit-free`     | g1b   | `pixel-mismatch`, steps {8,9,10}       | 1 280 px in `lifetime`: the raw `Y` and its child `X` stay drawn; `L`, `M`, `M1` left the tree (`set_parent` to none) before their `free`, so they vanish either way |
| `sabotage-omit-visible`  | g1b   | `pixel-mismatch`, steps {6}            | 6 400 px: `V` and `V1` drawn while hidden; step 7 shows them again in both worlds                                                                                    |
| `sabotage-patch-drop`    | g1b   | `capture-failure` (`patch-divergence`) | the patch sink drops the `Marker` entry at frame 51; frames 51–60 resolve differently from the full sink (the receiver on it shows the stale marker at step 5)       |
| `tie-overlap`            | g1b   | `unsupported` (`draw-index-tie`)       | the same frame-11 tie with a 224×32 `T` over `P` and `Q`'s children, not harmless                                                                                    |

Images, all under the run directory:

- Reference: `reference/shots/step-<k>.png` (k = 0..10) and `reference/shots/frame-11.png`.
- Receivers: `receiver/shots/seq-{8,…,108}.png` and `seq-11.png`, the same names under
  `receiver-patch/shots/`; state dumps `receiver{,-patch}/state/seq-<n>.json`.
- Sabotage: `sabotage-omit-{free,visible}/receiver/diff/step-<k>.png`,
  `sabotage-patch-drop/receiver/diff/step-5.png` (the stale marker).
- Tie: `tie-overlap/reference/shots/frame-{11,12}.png`, `tie-overlap/receiver/shots/seq-{11,12}.png`.

### The one-frame draw-index tie, decided

A top-level item added at runtime keeps the RenderingServer default index 0 for one rendered frame
(G1a finding). Fixture step 1 now provokes it: `T` enters at frame 11 while `P` holds 0. The
capture declares exactly one tie in 400 transactions: frame 11, canvas 1, `{P, T}`. On frame 12 the
raise gives `T` 10. The decision (gate1-design.md D7 and G1b2 "As built") is:

- the wire declares every tie, as render-stream-1.md invariant 9 requires;
- the checker classifies a tie by what it can do to pixels. `P`'s subtree paints
  `[79,79]–[209,169]` and `T` paints `[79,303]–[113,337]` (footprints grown by 1 px), which are
  disjoint, so every order paints the same frame. The tie is **harmless**: listed in
  `harmless_ties` (`11:1`), no reason, and the legs stay `success`;
- `tie-frame-pixels` confirms it: `reference/shots/frame-11.png` equals both receivers' shot of
  seq 11 exactly;
- with `T` over `P` and `Q`'s children (`tie-overlap`) the same tie is not harmless and the leg is
  `unsupported`.

The overlap legs also measure what the engine and the receiver actually drew. This is not gated.
The variant reference's frames 11 and 12 differ in 1 536 px: on the tie frame `T` is drawn right
after `P` and under `Q`'s children, and one frame later it is raised over them. That matches the
stable insertion sort of `render_canvas` (`renderer_canvas_cull.cpp:490-493`,
`core/templates/sort_array.h:289-301`), which keeps the appended `T` after `P`. The receiver drew
both frames exactly as the reference did (0 px each). That is the expected outcome for an appended
item in a container of at most 16 siblings. In general (more siblings, or ties between items that
were already siblings) the order depends on each process's sort history, which is why a tie that
can change pixels stays `unsupported`.

### What this proves

- One mirror snapshot per frame feeds a full and a patch sink that resolve to the same state at
  every frame, bit for bit. A receiver replaying the patch recording does the same RenderingServer
  work per transaction and draws the same pixels as one replaying the full recording.
- Transform-only and canvas-only changes travel as `commands: null`: at step 2 only `R1`'s and the
  marker's rects are encoded, and at step 10 only the marker's.
- A dropped patch entry is caught by the full/patch comparison before any pixel is looked at, and
  dropping `free` or `canvas_item_set_visible` from the mirror shows up at exactly the steps the
  engine semantics predict.
- The runtime top-level tie is declared on the frame it happens and only then, and a harmless tie
  costs nothing on screen.

### What this does not prove

- Live delivery, credit, stalls, resync and reconnect (G1c2, G1d). The patch base here is always
  the previous frame of a file stream.
- That ties between items that were already siblings, or in containers of more than 16 children,
  replay in the engine's order. They are declared and classified `unsupported` unless their
  footprints are disjoint.
- The footprint analysis knows only `add_rect`; any unsupported command makes a footprint
  unbounded.
- `z_as_relative` and `draw_behind_parent` are still unobserved (G1e). The fixture is still
  axis-aligned opaque rects.

## Gate 1c result (2026-10-09)

**Pass.** The run is `artifacts/render-stream/gate1/20261009T080634Z/` (ignored, not committed;
produced in the G1c2 worktree). Its `result.json` has `gate_passed: true`, groups `g1a`, `g1b` and
`g1c` run and none missing, and 50 of 50 checks pass
([protocol/gate1-design.md](protocol/gate1-design.md) "G1c2"). Every leg classifies as expected.
The capture library now links `rs_ws` and serves render-stream/1 live (`GRC_LIVE_LISTEN`); the
receiver has a live mode. Runs on the same build:

- gate 0: `artifacts/render-stream/gate0/20261009T080454Z/` passes 19 of 19;
- gate −1: `artifacts/render-stream/gate-minus1/20261009T080356Z/` still passes 28 of 28 (the
  library's imports still have no `mprotect` or `mmap`).

**Delivery.** Each live host paces the fixture at 60 frames per second with S = 300, N = 60 and
quits at frame 960; the receiver joins long before step 0 settles (first applied host frame 38,
85 and 40, against 307). Counts from each host's `live-summary.json` and the receiver's
`applied.json`; presented is reported as `"unavailable"` throughout, since Godot gives no
presentation feedback.

| Leg                     | Credit stage | Frames offered | Formed | Sent | Received / applied / submitted (receiver) | Coalesced | Credit round trip p50 / p95 / max |
| ----------------------- | ------------ | -------------- | ------ | ---- | ----------------------------------------- | --------- | --------------------------------- |
| `live`                  | `submitted`  | 923            | 912    | 912  | 912 / 912 / 912                           | 0         | 10.9 / 11.3 / 19.7 ms             |
| `live-headless`         | `applied`    | 876            | 876    | 876  | 876 / 876 / –                             | 0         | 7.1 / 7.6 / 11.6 ms               |
| `sabotage-drop-message` | `submitted`  | 522            | 517    | 516  | 515 / 515 / 515, then `seq-gap` at 517    | 0         | 9.3 / 10.0 / 20.1 ms              |

Host-side ack latency, from the main thread's send to the I/O thread's receipt of each stage's ack
(`live`, p50 / p95): received 8.9 / 9.1 ms, applied 9.2 / 9.3 ms, submitted 10.9 / 11.3 ms. On the
receiver, received → applied takes 0.64 ms (median, max 1.4) and applied → submitted (the next
`frame_post_draw`) 1.8 ms (median, max 10.5). The credit returns within 1 host frame at the
median and 2 at most, so the host sends on 912 of 923 streaming frames (99 %); none of the 11
frames without credit saw the mirror change, so nothing coalesced. Queued bytes never exceeded
7 628 (bound: the largest message, 7 624, + 4 096).

**Bytes.** The live stream is the patch encoding: a 3 405-byte session message (magic included),
seq 1 full at 7 624 bytes, then patches with a median of 354 bytes and a maximum of 3 499 (a step
that redraws several items), and a 258-byte end record: 352 749 bytes for 912 transactions on
`live`. The tap equals the received file byte for byte on `live` and `live-headless`.

| Leg                     | Group | Class (expected = measured)  | Measured                                                                                                                                                                         |
| ----------------------- | ----- | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `live`                  | g1c   | `success`                    | 912 transactions; one shot per step window (seqs 270, 329, … 860), each equal to the reference and `synthesizeGate1(k)`; every live state equals the full recording at its frame |
| `live-replay`           | g1c   | `success`                    | the file-mode replay of `live/receiver/received.rs1`: same 912 seqs and record hashes, identical shots and state dumps at the 11 shot seqs                                       |
| `live-headless`         | g1c   | `success`                    | credit stage `applied` (forced under `--headless`), 876 transactions; under `strace -e openat` it opens nothing under `fixtures/`                                                |
| `sabotage-drop-message` | g1c   | `replay-failure` (`seq-gap`) | the host formed seq 516 at frame 560, tapped it and did not send it; the receiver failed at seq 517 (`seq-gap`), after 5 of the 11 step shots                                    |

g1a and g1b classify exactly as in "Gate 1b result". Images, all under the run directory:
`reference/shots/step-<k>.png`; `live/receiver/shots/seq-{270,329,…,860}.png` with
`live/receiver/state/seq-<n>.json`; `live-replay/shots/seq-<n>.png` for the same seqs;
`sabotage-drop-message/receiver/shots/seq-<n>.png` for steps 0–4.

### Findings

- **A Godot client never reads a message that arrives with the close frame.** The first run's
  live receiver applied 942 transactions and then reported `live-disconnected`: the host had sent
  the end record and close 1000 together, and `WebSocketPeer` returns no packets once its state
  is not `STATE_OPEN` and clears its buffer on a clean close (`modules/websocket/wsl_peer.cpp:654`,
  `:746-752`, `:827-832`, `:843-870`). The host now sends the end record and lingers (up to
  1.5 s) for the receiver to close first; error close reasons repeat the error's reason.
- **A patch after a lost message reported its base, not the gap.** Both decoders checked the
  patch rules before seq continuity, so the drop-message sabotage read `patch-base`. They now
  report `seq-gap` first (golden `invalid/patch-after-gap.rs1`).
- **Typed GDScript is checked only by the debug editor.** The release template ran the live
  receiver happily while the editor's parse of `receiver.gd` failed on one Variant passed to an
  `int` parameter; `receiver-typed-clean` caught it.

### What this proves

- The capture library can serve the stream live from inside the game process without the frame
  callback ever waiting on a socket: encoding stays on the main thread, the I/O thread only moves
  bytes, and one transaction is in flight at a time, by the host's own log and by an independent
  recount from its ack lines.
- Live delivery loses nothing a recording has: every live transaction resolves to the full file
  recording's state at its frame, and a live receiver's pixels equal both the reference and a
  file replay of exactly the bytes it received.
- A lost transaction is caught at the receiver as a sequence gap before anything is drawn from it.

### What this does not prove

- Stalls, coalescing under a slow receiver, resync and reconnect: G1d. The host handles `resync`
  and a second connection (unit-tested), but no leg exercises them, and coalescing never fired
  here because the receiver keeps up.
- Presentation: `presented` is unavailable in Godot; `submitted` is "Godot submitted the frame".
- Rates other than 60 frames per second, more than one receiver, non-loopback serving and
  constrained links (gate 6, gate 2).

## Gate 1d result (2026-10-09)

**Pass.** The run is `artifacts/render-stream/gate1/20261009T0930Z-g1d/` (ignored, not committed;
produced in the G1d worktree). Its `result.json` has `gate_passed: true`, all four groups (`g1a`,
`g1b`, `g1c`, `g1d`) run and none missing, and 65 of 65 checks pass
([protocol/gate1-design.md](protocol/gate1-design.md) "G1d"). Every leg classifies as expected.
Runs on the same library:

- gate 0: `artifacts/render-stream/gate0/20261009T090439Z/` passes 19 of 19;
- gate −1: `artifacts/render-stream/gate-minus1/20261009T090340Z/` still passes 28 of 28.

**The stall.** `live-stall`'s receiver takes its step 1 shot (seq 332, host frame 367), then blocks
its main loop for 2 000.05 ms with `OS.delay_msec` before that seq's `submitted` ack. The delay is
injected and declared so (`live.stall.injected`, with the mechanism); it is not GPU-limited work,
and the host cannot tell the difference: it only sees a credit that does not return.

| Measured on the host (`tap/live-1.jsonl`)                       | `live-stall`                                     |
| --------------------------------------------------------------- | ------------------------------------------------ |
| frames simulated between the stalled send and its credit        | 121 (367 → 488), every one logged, 16.67 ms mean |
| fixture steps applied inside the stall                          | 2 (frame 420) and 3 (frame 480)                  |
| transactions sent during the stall                              | 0                                                |
| coalesced callbacks during the stall                            | 68 (one per frame from 420 to 487)               |
| pending targets at once                                         | at most 1 (a flag; the target is the mirror)     |
| oldest pending target                                           | 68 frames, 1 133 ms                              |
| max queued bytes (whole leg / during the stall)                 | 7 628 / 2 361 (bound 11 720)                     |
| max in flight                                                   | 1                                                |
| recovery: first transaction after the credit                    | seq 333, a 2 357-byte patch on seq 332           |
| … sent after the credit arrived                                 | 0 frames (the same callback), 1.4 ms             |
| … its `applied` / `submitted` ack after the credit (host clock) | 3.6 ms / 13.0 ms                                 |
| … equal to the full recording at its frame (488)                | yes                                              |

The coalesced count starts at frame 420, not at the start of the stall: the hub counts a callback
only when the mirror changed since the last send, and this fixture changes the mirror only at step
frames (see "Findings"). Step 2's window (`[427, 479]`) lies wholly inside the stall and is the
only step without a shot, exactly as derived from the host log. The first shot after the stall
(step 3, seq 333) equals the reference and shows all 9 216 pixels step 2 changed inside the stall
(the hierarchy's new transforms and `R1`'s colour) that still show at step 3.

| Leg                       | Group | Class (expected = measured)          | Measured                                                                                                                                                                                                                                   |
| ------------------------- | ----- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `live-stall`              | g1d   | `success`                            | 569 transactions; 10 shots, all equal to the reference; step 2 missed inside the stall; numbers above                                                                                                                                      |
| `live-reconnect`          | g1d   | `success`                            | connection 1: 505 sent, closed by the receiver with 1000 after the step 4 shot (seq 505); `dispose` freed 20 of 20 RIDs, 0 left; connection 2: fresh `stream_id`, same `session_id`, seq 1 full at frame 552, 403 sent; 6 shots, all equal |
| `live-resync`             | g1d   | `success`                            | seq 629 (frame 667, step 6's window) refused unapplied, acked `received` only; the host credited the `resync` and sent seq 630 full (`base_seq` null); 2 full transactions in 922; every shot equal                                        |
| `live-receiver-killed`    | g1d   | support                              | headless receiver SIGKILLed at host frame 601; the host's connection closed 1006 (connection reset) after frame 602; the fixture quit at 960, exit 0, both file sinks complete                                                             |
| `sabotage-ignore-credit`  | g1d   | `delivery-violation`                 | from frame 488 (the receiver's 500 ms stall after its step 3 shot) 38 sends without credit, up to 31 in flight; nothing before the sabotage frame 480                                                                                      |
| `sabotage-stale-coalesce` | g1d   | `delivery-violation` (`stale-state`) | the first post-stall transaction (seq 330, frame 488) carries frame 420's state (`stale_from: 420`); its step 3 shot also differs from the reference (2 048 px)                                                                            |

g1a, g1b and g1c classify exactly as in "Gate 1c result". Images, all under the run directory:
`live-stall/receiver/shots/seq-{…,332,333,…}.png` (step 1 before the stall, step 3 after it),
`live-reconnect/receiver/shots/stream-2-seq-<n>.png` (steps 5–10 on connection 2),
`live-resync/receiver/shots/seq-630.png` (step 6, the full transaction after the resync) and
`sabotage-stale-coalesce/receiver/shots/seq-330.png` with `diff/step-3.png`.

**Acks and bytes.** Credit round trips on the host clock (send → the credit-stage ack's receipt),
p50 / p95: `live-stall` 7.3 / 18.4 ms outside the stall (max 2 015 ms, the stall),
`live-reconnect` 13.8 / 14.5 ms and 14.4 / 14.7 ms (connections 1 and 2), `live-resync`
6.8 / 7.1 ms. The g1c `live` leg measured 16.7 / 17.2 ms in this run against 10.9 / 11.3 ms in the
G1c2 run: a rendered receiver's `submitted` stage follows the private gamescope's frame timing,
which varies between runs; the credit still returned within 1–2 host frames. Bytes are G1c2's:
patches of a few hundred bytes, the stall's recovery patch 2 357 bytes (two steps' changes at
once), a fresh connection's seq 1 about 8 KB. On the host, one snapshot copy costs about 14 µs per
frame, a patch diff about 7 µs and its encoding about 2 µs (the ignore-credit host's end stats).

### Findings

- **The contract's `coalesced` bound assumed a mirror that changes every frame.** The hub counts
  a coalesced callback only when the mirror changed since the last send (Q4), and the fixture
  changes it only at step frames, so a 121-frame stall coalesced 68 callbacks (from step 2's frame
  to the credit), not "stall frames − 2". The check measures from the first in-stall change, and
  requires one coalesced callback per pending frame line.
- **ignore-credit is unobservable against a receiver that keeps up.** With credit returning in
  well under a frame (p50 8.5 ms in the first full run), a host that ignores credit sends exactly
  what a correct host sends, and that run classified the sabotage `success`. The leg now gives its
  receiver a 500 ms stall after the step 3 shot, which ends before step 4's window: the host keeps
  sending into it, 31 in flight.
- **stale-coalesce is visible only because a step lands before the credit.** The stale copy is
  frame 420's state; it differs from the newest state at the credit (488) only through step 3
  (480). A stall that ended 8 frames sooner would hide the sabotage and fail its leg check.
- **A reconnect's first stream stops short of the host's tap.** The host sends the next
  transaction as soon as the reconnect step's `submitted` ack returns the credit; the receiver
  closes without reading it. The received stream is a byte prefix of the tap, without an end
  record, and the checker requires exactly that.

### What this proves

- A receiver that stops reading for two seconds costs the host nothing it would not spend anyway:
  the simulation runs at 60 frames per second throughout, nothing is serialized for a target the
  receiver will never see, at most one transaction is in flight and one target pending, and the
  queue never grows past one message.
- The receiver catches up in one transaction to the newest state, including changes made while
  it was stalled, and draws exactly the reference afterwards.
- `resync` turns a refused transaction into one full transaction on the same stream; a reconnect
  is a fresh session that owes nothing to the old stream, with every receiver RID freed in
  between; a receiver killed mid-stream leaves the host and its recordings intact.
- A host that ignores credit, or that coalesces to a stale target, is caught by the checker.

### What this does not prove

- GPU-limited receivers: the stall is an injected main-loop block, and `submitted` is "Godot
  submitted the frame", not presentation or GPU completion (gate 6 measures those).
- Resources (no textures yet: pinning in-flight resource versions is gate 2), more than one
  receiver, arm-on-first-subscriber, non-loopback serving, other rates and constrained links.

## Gate 1e result (2026-10-09)

**Pass.** Calibrator 4 hooks `canvas_item_set_z_as_relative_to_parent` (slot 483) and
`canvas_item_set_draw_behind_parent` (slot 460), feeding the mirror's `z_relative`/`behind` fields
that render-stream/1 already carried since G1b1 (and the receiver already applied). Both leave
the session's `unobserved` list. G1e was built on G1b2 and integrated after G1c2 and G1d; the runs
below are on the integrated tree (ignored, not committed):

- gate −1: `artifacts/render-stream/gate-minus1/g1e-onto-main/` passes 28 of 28, 44 hooks planned,
  none omitted (the `older-record-loads` leg's calibrator-1 record still omits 36 and arms);
  `optional-hook-counts` includes both new hooks (the spike's post-arm `Node2D` sets non-default
  `z_as_relative`/`show_behind_parent`, so the setters' early return on an unchanged value does
  not skip the `RenderingServer` call).
- gate 0: `artifacts/render-stream/gate0/g1e-onto-main/` passes 19 of 19, `hooks_planned` exactly
  the 44 names.
- gate 1, all four groups, run twice: `artifacts/render-stream/gate1/g1e-onto-main-run1/` and
  `…-run2/` each pass 65 of 65, every leg at its expected class.

**Fixture.** Two appended steps, each adding new top-level items (so each ties with `P` at index 0
for one frame, as `T` does at step 1):

- step 11: `ZP` (z_index 1, draws nothing) with child `ZC` (z_index −1, `z_as_relative = false`,
  so its effective z is −1, not 0 — its own z_index alone, ignoring the parent's).
- step 12: `ZB` (a new top-level sibling at effective z 0, overlapping `ZC` by 32 px — the overlap
  shows `ZB`, which proves the receiver applied step 11's setter) and `BP`/child `BC`
  (`BC.show_behind_parent = true`, overlapping `BP` by 32 px — the overlap shows `BP`, not `BC`).

`ZB` is deferred to step 12 rather than joining `ZP` at step 11: two new top-level items entering
the same frame tie with each other too (not just with `P`), and a tie's harmlessness is a
footprint check over each member's whole subtree — `ZC`/`ZB`'s by-design overlap would have made
that tie `unsupported`. A step apart, `ZP` and `ZB`/`BP` each only tie with `P` (disjoint
footprints, harmless), and `ZC` — not top-level — never ties with `ZB` at all. Measured:
`draw-index-ties` reports 3 ties, all harmless (frame 11 `{P,T}`, frame 111 `{P,ZP}`, frame 121
`{P,ZB,BP}`); `tie-overlap` still finds only frame 11's not harmless.

**Sabotage step sets, extended.** The sabotages whose dropped state is never reset by a later step
now mismatch through steps 11 and 12 too (measured): `sabotage-omit-modulate` {1..12},
`sabotage-omit-transform` {2..12}, `sabotage-omit-visibility` {7..12}, `sabotage-omit-free`
{8..12}. `sabotage-omit-order` ({3}) and `sabotage-omit-visible` ({6}) are unchanged: both
re-converge with the reference before step 11.

**Patch sink**, the same 400-frame capture: full 3 252 541 B (max record 8 447), patch 175 125 B
(max record 7 623); median transaction 8 379 B full against 354 B patch. Resolved, the patch
recording equals the full one at all 400 frames.

**Live timeline, re-derived by running.** The fixture's default quit is now `S + 12N + 11`, so the
live hosts' `S + 11N` (960) would be refused; they quit at `S + 13N` = 1080, and the receivers
shoot 13 windows, step 12's being `[1027, 1080]`. Everything G1d measured lies before step 4 and
is unchanged in both runs:

| Measured (run 1 / run 2)                    | Value                                                                                                                                                     |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `live-stall`: stalled send → credit         | 367 → 488 / 367 → 489; steps 2 (420) and 3 (480) inside; coalesced 68 / 69 from frame 420; recovery patch 2 357 B, 0 frames after the credit              |
| `sabotage-stale-coalesce`: first post-stall | frame 489, frame 420's state (`stale_from`), step 3 shot 2 048 px off, in both runs; run 2 also caught an ordinary-gap stale copy at frame 361 (step 1's) |
| `sabotage-ignore-credit`                    | violations from frame 480 / 488 (sabotage frame 480); 49 / 33 sends without credit; up to 32 / 33 in flight                                               |
| `live-receiver-killed`                      | killed at host frame 601, closed 1006, the fixture quit at 1080, both sinks complete                                                                      |
| `live`                                      | 1 020 / 1 044 transactions, 13 shots equal to the reference; two more harmless one-frame ties (frames 960 and 1020)                                       |

The step-3-before-credit margin `stale-coalesce` depends on (step 3 at 480, credit at 488–489) is
untouched: steps 11 and 12 come after every G1d event.

**What this does not prove.** A new top-level item's tie with an existing one other than `P`, or
two new top-level items whose subtrees are disjoint but which overlap a third tied member — neither
is exercised.

## Gate 1 summary

Gate 1 passes as of 2026-10-09 with all four groups in one run (65 checks): G1a, G1b2, G1c2, G1d
and G1e, built on G1b1's codecs and G1c1's WebSocket server (G1e's calibrator 4 adds no check of
its own; it extends the fixture, the hook set and the sabotage step sets).

What gate 1 proves, on the pinned 4.5.1 release template under `--headless`:

- **Retained state (1a).** Parent/child transforms and modulation, transform changes without a
  redraw, draw order (index swap, z over index, reparent, same-parent re-append), visibility and
  layer culling, content replacement and clearing, create/free/recreate and detach/re-attach, and a
  canvas transform, and (1e) `z_as_relative_to_parent` and `draw_behind_parent`: thirteen steps,
  each pixel-exact against the rendered reference and an image painted from `expected.json`, each
  sabotage failing at exactly its predicted steps.
- **Root geometry (1a).** The headless host's degenerate 64×64 root is declared, never guessed;
  `GRC_ROOT_SIZE=enforce-min-size` makes it match the 640×360 logical size.
- **render-stream/1 (1b).** Patch transactions resolve bit for bit to the full snapshots of the
  same frames and cost the receiver the same RenderingServer calls; a corrupt patch is caught as
  `patch-divergence`. The one-frame draw-index tie of a top-level item added at runtime is
  declared on the wire and classified by its effect.
- **Live delivery (1c).** The capture library serves the stream from inside the game process over
  its own loopback WebSocket server, encoding on the main thread at the frame boundary, one
  transaction in flight, credit returned from the receiver's paced render loop; live pixels equal
  the reference and a file replay of the received bytes; a lost message is a sequence gap.
- **Slow receivers (1d).** Stall, coalescing to one pending target, newest-state recovery,
  resync, reconnect and receiver loss, as above.

Unsupported or deferred, by design: textures and every resource payload (gate 2), clipping
semantics (gate 3), `viewport_set_global_canvas_transform`, `canvas_set_modulate`, y-sort, light masks and texture
filter/repeat (in the session's `unobserved` list), equal-draw-index ties that can change pixels
(`draw-index-tie`, unsupported), a degenerate host size (`degenerate-host-size`, unsupported),
arm-on-first-subscriber and late join (gate 8), more than one receiver, publication-rate control
and real presentation timing (gate 6), non-loopback serving and authorization (gate 2).

Costs, measured on the gate 1 hosts (60 frames per second, the 21-item fixture before G1e, 26 since): one mirror
snapshot copy per frame, about 14 µs; a patch diff about 7 µs and its encoding about 2 µs; a
transaction is a few hundred bytes (about 350 KB for 900 frames), a full snapshot about 8 KB; the
credit round trip is 1–2 host frames for a rendered receiver (`submitted`) and about 1.5 ms for a
headless one (`applied`); the receiver applies a transaction in about 0.6 ms (median, G1c2). The
hook itself stays armed for the whole session (D6), a cost gate 1 does not measure.

## Gate 2a result (2026-10-09)

G2a ([protocol/gate2-design.md](protocol/gate2-design.md) "G2a") passes:
`pnpm render-stream:gate2 -- --legs g2a` is 15/15 in
`artifacts/render-stream/gate2/20261009T110836Z/` (an earlier run with the same build,
`20261009T105103Z`, matched every image and hash and taught the census one engine call, below).
The same build passed gate −1 28/28 with 55 hooks planned and none omitted
(`artifacts/render-stream/gate-minus1/20261009T104748Z/`, `armed.png == unarmed.png`), gate 0 19/19
(`artifacts/render-stream/gate0/20261009T105733Z/`) and gate 1 65/65 with all four groups
(`artifacts/render-stream/gate1/20261009T105916Z/`). Nothing changed on the render-stream/1 wire:
the capture leg classifies `unsupported`, and only because its texture draws are unsupported
commands.

What landed:

- **Calibrator 5**, eleven optional slots at exactly the contract's indices: placeholder create 34,
  `texture_replace` 40, the root default filter/repeat 321/322, canvas textures 441/442/444/445,
  item default filter/repeat 448/449, LCD text 470. `calibrate.sh --check` is clean. On /1 the new
  hooks are counted, captured into `counters.json` and logged; they make no mirror tap. The two
  texture-rect draws now capture every argument. The spike drives all eleven off-screen.
- **Copy and hash at the hook.** With a stream enabled, `texture_2d_create` and `_update` read the
  image's shape through the `Image` binds (`has_mipmaps` added), copy `image_ptr`'s bytes into a
  GRT1 payload and SHA-256 it on the calling thread before forwarding
  (`capture/src/rs_texture_payload.*`, `rs_sha256.*`; ctests on the FIPS vectors and on literal
  payload bytes for golden-2's four shapes). Formats outside `GRC_RESOURCE_FORMATS` and payloads
  over `GRC_RESOURCE_MAX_PAYLOAD_BYTES` are logged and not copied. G2a keeps no payload.
- **The hook log**, `evidence/resources.jsonl` (`capture/src/rs_resource_log.*`, ctest), with the
  wire ids and versions G2b2's mirror will assign.
- **The arm-time root texture defaults**, read through the two `Viewport` binds into `root.json`.
- **The gate 2 fixture and runner** (`fixtures/gate2/`, `scripts/run-gate2.sh`, `check-gate2.ts`,
  `lib/gate2-*.ts`, `test/self-test-gate2.ts`).

Images (all under the run directory): `reference/shots/step-{0..10}.png`,
`reference-repeat/shots/step-{0..10}.png` and `reference-armed/shots/step-{0..10}.png`. Every
reference shot equals `synthesizeGate2` exactly outside its `synth_exclude` regions (the linear,
mipmapped and semi-transparent ones: `s2` from step 3, all eight default-filter drawers at step 4,
`sb` from step 7, `mm` from step 9). The repeat is identical in every region of every step, so the
recorded budget is 0 everywhere. The armed reference is byte-identical to the unarmed one.

The measured census, per step window, identical in the headless capture and the rendered armed
reference and equal to `expected.json` (`<op>@other` is off the main thread):

| step | RenderingServer texture calls                                                                    |
| ---- | ------------------------------------------------------------------------------------------------ |
| 0    | `texture_2d_create` 5, `texture_2d_placeholder_create` 2, item default filter 11, item repeat 11 |
| 1    | none (flips, region, transpose are draw arguments)                                               |
| 2    | none (transform only)                                                                            |
| 3    | item default filter 1 (`S2`)                                                                     |
| 4    | `viewport_set_default_canvas_item_texture_filter` 1 (LINEAR, 2)                                  |
| 5    | `viewport_set_default_canvas_item_texture_filter` 1 (NEAREST, 1), item repeat 1 (`DR` MIRROR)    |
| 6    | `texture_2d_update` 1                                                                            |
| 7    | `texture_2d_create` 2, `texture_replace` 2                                                       |
| 8    | `texture_2d_create` 1, `texture_2d_create@other` 1, `free` 2                                     |
| 9    | `texture_2d_create` 1, `texture_replace` 1, item default filter 1 (`MM`)                         |
| 10   | none (transform only)                                                                            |

After the quit frame the scene teardown frees five textures (A, B, M, C, D); `P2` and the two raw
items are left to the engine's exit, as gate 1's raw items were. The `unsupported` variant adds
U1's create (logged `unsupported-format`, not copied) and two items' filter/repeat calls at step
0, and draws exactly one texture RID the log never saw created (`PRE`, made before arming); the
main capture draws none.

Copy and hash at the hook, headless capture, median ns (copy = header + `memcpy`, hash = SHA-256
of the whole payload):

| shape                | payload bytes | copy  | hash   |
| -------------------- | ------------- | ----- | ------ |
| LA8 4×4              | 137           | 140   | 1 120  |
| RGBA8 4×4            | 171           | 130   | 970    |
| RGBA8 16×16          | 1 135         | 1 160 | 5 330  |
| RGBA8 32×32          | 4 207         | 1 030 | 13 310 |
| RGBA8 800×6 (theme)  | 19 312        | 1 830 | 55 380 |
| RGBA8 64×64, mipmaps | 21 955        | 2 200 | 62 880 |

The rendered armed reference measures the same within noise. The portable SHA-256 runs at about
350 MB/s, so hashing, not copying, is the cost; lazy hashing stays a gate 6 measurement.

### Findings

- **The engine makes a texture of its own after arming.** The default theme gives ColorPicker an
  800×6 `GradientTexture2D` hue strip (`scene/theme/default_theme.cpp:1093-1097`) whose deferred
  `update_now` (`scene/resources/gradient_texture.cpp:220-225`) runs at the first MessageQueue
  flush, in frame 1, as a plain `texture_2d_create` (`:273-278`). It is the "800×6 format-5 image"
  gate −1 counted without explaining. Every armed run sees it, so `expected.json` declares it
  (`engine_textures`) and the census counts it.
- **Every texture prediction held on the first run.** The synthesized flips, the transposed
  region, `S3`'s 90° turn (transpose + flip in the shader's sampling), the flipped tile, mirror
  repeat, the LA8 alpha, the freed `P1` drawing white (D11), the placeholder becoming `E` through
  `texture_replace`, and `C` showing its pre-fill content all matched the reference exactly.
- **Copy at the hook is proven twice.** `C`'s hook hash equals the fixture's hash of the image
  before `fill(black)`, and the reference shows those colours. `D`'s create is the only line off
  the main thread, and its hash equals the worker's own.
- **Two independent encoders agree.** The C++ hook and the fixture's GDScript `payload.gd`
  produce the same SHA-256 for all twenty creates and updates across the capture and the armed
  reference; A0's and B's hashes also equal the ctest's Python-derived literals.

### Deviations from the contract

- Every sprite is `centered = false`: the layout table's regions put each sprite's top-left at its
  position. `DR`'s step-1 source is (4,0,8,8), not (8,0,8,8), which lies wholly in A0's green
  quadrant and would look the same with or without the transpose.
- The hook log appends five keys to Q3's (`target`, `ref_id`, `value`, `layer`,
  `root_viewport`): the census, `replace-retires-temp` and `viewport-defaults` need the argument
  an op names. A `texture_replace` line repeats its by-texture's payload fields. The census keys
  thread as `<op>@other`.
- `GRC_RESOURCE_MAX_PAYLOAD_BYTES` defaults to 64 MiB; the contract names no default.
- `reference-armed` runs with the default root-size policy (`observe`), so the only difference
  from `reference` is the armed extension and its stream; its window is 640×360, so it declares
  `match`.
- One check beyond the contract's list, `unsupported-variant`, judges the `capture-unsupported`
  support leg ("census of unknown RIDs"). `expected.json` is generated by
  `fixtures/gate2/make_expected.py`, which encodes the hand derivation and cites its sources.
- `gate0-checks.ts` `GATE0_HOOKS` grows to the 55 names the shared record plans, so gates 0 and 1
  keep requiring exactly the committed record's hooks.

### What G2a does not prove

- Anything a receiver does with textures: the wire is still render-stream/1 (G2b2).
- Payload retention, the store, HTTP delivery and pinning (G2b2, G2c1, G2c2), or the
  `CanvasTexture` hooks beyond their counts (G2d).
- That the texture capture covers formats other than the six 8-bit uncompressed ones, textures
  created before arming, or the target game's 1 526 textures (gate 8).

## Gate 2b result (2026-10-09)

G2b2 ([protocol/gate2-design.md](protocol/gate2-design.md) "G2b2" and its "As built") passes:
`pnpm render-stream:gate2 -- --legs g2a,g2b` is 47/47 in
`artifacts/render-stream/gate2/g2b2-final/` (an earlier run of the same tree, `g2b2-try1`, also
passed once the checker classified the patch receiver against the patch recording). The same build
passed gate −1 28/28 with 55 hooks and `armed.png == unarmed.png`
(`artifacts/render-stream/gate-minus1/g2b2-final/`), gate 0 19/19 on /2
(`artifacts/render-stream/gate0/g2b2-final/`) and gate 1 65/65, all four groups, on /2
(`artifacts/render-stream/gate1/g2b2-final/`). All under the ignored `artifacts/`.

What landed:

- **The capture speaks render-stream/2.** `rs_mirror` keeps the texture table (one id counter for
  images and placeholders, versions, `freed` tombstones that leave at the first snapshot nothing
  names them, `texture_replace` retiring the by-texture, the payload bytes the hook copied), the
  item and root-viewport filter/repeat, and the texture draws as commands (`unknown-texture` for a
  RID it never saw created, derived `unsupported-texture` entries). `rs_publish` (was
  `rs1_publish`) writes both sinks, the content-addressed store (`rs_resource_store`) and inline
  resource records per sink; `rs_live` (was `rs1_live`) serves /2 with every payload inline until
  G2c2. The /1 codecs left the library; `render-stream-1.ts`, `golden-1/` and `self-test-rs1.ts`
  stay as frozen history.
- **The receiver consumes /2**: `Rs2Decoder.Stream`, `RsResourceCache` (memory, a verified cache
  directory, the store as origin), lazy residency and the D5 upload rule in `RsApplier`, typed
  refusal of unsupported textures, `applied.json` `/3`.
- **Gates 0 and 1 run on /2** (`recording.rs2`, stores, caches, the /2 features), and gate 2 has
  group g2b (`lib/gate2b-checks.ts`).

Images (all under the run directory): the receivers' `receiver-{cold,warm,patch,inline}/shots/seq-<n>.png`
at the eleven settle seqs are byte-identical to `reference/shots/step-<k>.png`, full frame,
`synth_exclude` regions included; `receiver-cold`'s equal `synthesizeGate2` outside them. RAW1 is
white at step 8 (the freed `P1` tombstone), S3 shows C's pre-fill content. The unsupported variant's
receiver differs from `reference-unsupported/` in exactly `u1` and `u2` (1 024 px each) at every
step.

Bytes, 400-frame captures:

| recording                             | bytes     | median transaction | seq 1 | resource records |
| ------------------------------------- | --------- | ------------------ | ----- | ---------------- |
| `capture/recording.rs2` (full)        | 3 434 197 | 8 697              | 8 109 | 0                |
| `capture/recording-patch.rs2` (patch) | 211 669   | 461                | 8 109 | 0                |
| `capture-inline/recording.rs2` (full) | 3 486 461 | 8 697              | 8 109 | 10 (50 493 B)    |
| `capture-inline/recording-patch.rs2`  | 263 933   | 461                | 8 109 | 10 (50 493 B)    |
| `live-inline` tap (892 transactions)  | 490 726   | 461                | 8 110 | 10 (50 493 B)    |

The store holds 10 payloads, 50 493 B (A0, A1, A2, B0, B1, M, C, D, E and the engine's hue strip);
the retained maximum (the mirror's payloads plus the last publication's) is 49 050 B. The inline
records are byte-identical to the store files, and the inline capture resolves to the out-of-band
one at all 400 frames.

The receivers, per step (fetched / uploads), equal `expected.json` `receiver_resources`: step 0
2 fetched (A0 once for A and Atwin, B0), 5 created (A, Atwin, B, P1, P2); step 6 1 / 1 updated; step 7
2 / 2 replaced; step 8 2 / 2 created and 2 RIDs freed; step 9 2 / 1 created, 1 replaced; every
other step 0. `receiver-cold` fetched 9 distinct payloads (31 181 B) from the store, about 37 µs
per fetch (median, max 45 µs, verification included), and uploaded 10 times (31 220 data bytes);
its cache ends with exactly those 9 files. `receiver-warm`, a new process on that cache, fetched
0 with 9 cache hits, and its uploads, `rs_calls`, shots and state dumps are identical.
`receiver-patch` costs what `receiver-cold` does; `receiver-inline` and the live receiver take
every payload from the stream and fetch nothing. In the transform-only windows (steps 2 and 10:
frames 21–30 and 101–400) every receiver counter is 0, the hook log has no texture call and the
patch transactions carry no texture entry.

| leg                                                          | class (expected)          | why                                                                           |
| ------------------------------------------------------------ | ------------------------- | ----------------------------------------------------------------------------- |
| `receiver-cold`, `-warm`, `-patch`, `-inline`, `live-inline` | success                   | as above                                                                      |
| `unsupported-textures`                                       | unsupported               | U1 `unsupported-format` (unsupported-texture), U2 `unknown-texture`           |
| `sabotage-omit-update`                                       | pixel-mismatch {6}        | A keeps A0 at step 6; step 7's replace re-converges                           |
| `sabotage-omit-replace`                                      | pixel-mismatch {7,8,9,10} | A keeps A1 at its old size; step 9's replace of P2 is dropped too             |
| `sabotage-stale-texture`                                     | capture-failure           | texture-log-divergence at seq 61: the stream keeps A v1, the hook log says v2 |
| `sabotage-wrong-hash`                                        | replay-failure            | resource-hash-mismatch at seq 61 (step 6), A1's store file corrupted          |
| `sabotage-spurious-update`                                   | resource-violation        | transform-only-resource-traffic at frame 21 (A v2, same hash; no re-upload)   |
| `sabotage-receiver-reupload`                                 | resource-violation        | redundant-upload (and traffic in the transform-only windows)                  |
| `sabotage-receiver-ignore-cache`                             | resource-violation        | warm-cache-fetch: a warm receiver fetched every hash its cache held           |

### Findings

- **G2b1's goldens carried the wrong `payload_bytes`.** The texture entry's `payload_bytes` is the
  whole `render-stream-texture/1` payload (1 135 B for RGBA8 16×16), the size the inline threshold
  and the store compare; golden-2 had the image data size (1 024 B), and both decoders compared
  the resource record's data length against it. golden-2 was regenerated and both decoders fixed.
- **omit-op needs the hook log's cooperation.** A texture call the capture misses must be missed by
  the log's registry too, or the stream and the log diverge and the sabotage lands as
  `capture-failure` instead of pixels. The omitted call is still logged, marked.
- **The texture mirror and the hook log assign ids independently**, so their identity taps share
  one hook-side lock; a worker-thread create (D) cannot interleave differently in the two.
- **Every gate 0 and gate 1 stream now carries one texture** (the engine's hue strip): stores of
  one payload, and every live connection sends one 19 312-byte resource record before seq 1. Gate
  1's queued-bytes bound now counts a credit window (a transaction and the records sent ahead of
  it) rather than one message.

### What G2b does not prove

- HTTP delivery, pins and retirement (G2c2), canvas textures and per-command filter/repeat (G2d),
  bearer tokens (G2e).
- Payload sizes beyond the fixture's (the largest is M's 21 955 B) or a store write failure and the
  retained budget in a real run (both are unit-tested only).
- Cache eviction, parallel fetches, lazy hashing (gate 6), browser receivers (gate 7), late join and
  the target game's textures (gate 8).

## Gate 2c result (2026-10-09)

G2c2 ([protocol/gate2-design.md](protocol/gate2-design.md) "G2c2" and its "As built") passes:
`pnpm render-stream:gate2` (groups g2a, g2b, g2c) is 72/72 in
`artifacts/render-stream/gate2/g2c2-final/`. The same build passed gate −1 28/28
(`artifacts/render-stream/gate-minus1/g2c2-final/`), gate 0 19/19
(`artifacts/render-stream/gate0/g2c2-final/`) and gate 1 65/65, all four groups
(`artifacts/render-stream/gate1/g2c2-final/`). All under the ignored `artifacts/`.

What landed:

- **The live host serves payloads by hash.** `ServedResources` (`capture/src/rs_resource_store.h`)
  is the rs_ws `ResourceSource`: at each frame callback the published snapshot's payloads are
  pinned before the hub sends, and after the sends the servable set is exactly the current state's
  payloads united with every open connection's base (the payloads of its last sent transaction);
  everything else is retired and its bytes released. Pins, retirements and every GET go to the
  hook log (`pin`, `retire`, `http-get`), the summary gains the serving totals, and the retained
  budget counts the servable set. Live connections follow the configured policy (`fetch: "http"`,
  inline capped at 1 MiB). Sabotages `unpin` and `drop-resource`; `wrong-hash` serves the store's
  corrupted copy.
- **The live receiver fetches before it applies.** `RsResourceFetcher` (one keep-alive
  `HTTPClient`, sequential GETs, a timeout, the delay as a timed wait) fills the cache; a
  transaction stays unapplied (acked `received`) until every payload it needs is verified and
  cached, while the previous state stays on screen.

Numbers (host `live-summary.json` and hook log; receiver `applied.json`):

| leg              | GETs | HTTP bytes | pinned / retired | retained max (hashes / bytes) | fetch latency p50 / p95                |
| ---------------- | ---- | ---------- | ---------------- | ----------------------------- | -------------------------------------- |
| `live`           | 9    | 31 181     | 10 / 3           | 7 / 49 050                    | 16.1 / 16.7 ms                         |
| `live-headless`  | 9    | 31 181     | 10 / 3           | 7 / 49 050                    | 19.4 / 20.9 ms                         |
| `live-stall`     | 9    | 31 181     | 10 / 3           | 7 / 49 050                    | 16.1 / 16.7 ms                         |
| `live-reconnect` | 9    | 31 181     | 10 / 3           | 7 / 49 050                    | 16.2 / 16.7 ms                         |
| `live-warm`      | 0    | 0          | 10 / 3           | 7 / 49 050                    | – (9 cache hits)                       |
| `live-animate`   | 15   | 33 365     | 905 / 897        | 10 / 49 778                   | 16.9 / 17.1 ms (100 ms delay excluded) |

Fetch latency is the same for 137 B and 21 955 B payloads (15.8–16.7 ms in `live`): a fetch costs
one receiver frame at `--max-fps 60`, since the fetcher is polled from `_process`; the loopback
transfer itself is not visible at this resolution. `pins-bounded` holds at all 911 frames of every
good host (the replayed servable set equals the full recording's ok hashes united with every open
connection's tapped base, peak 48 086 B after retirement; the summary's 49 050 B includes the
phase-1 pins of a callback before its retirements), against a 512 MiB budget.

`live-animate`: 911 ANIM updates, 661 ANIM versions reached the wire (in 661 transactions), six
distinct ANIM hashes (k = frame mod 6), 15 distinct hashes fetched (the six ANIM contents and the
nine fixture payloads, every one named by a sent transaction), 897 retirements: every superseded
ANIM version left the servable set at the next callback once no base named it.

| leg                        | class (expected) | why                                                                                                                  |
| -------------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------- |
| `live`                     | success          | 853 transactions, 9 fetches (one per payload), 11 shots equal to the reference                                       |
| `live-warm`                | success          | a new host and receiver on `live`'s cache: the host answers no GET, 9 cache hits, shots equal `live`'s               |
| `live-replay`              | success          | file replay of `live`'s `received.rs2` with `live`'s cache as its store: same seqs, payloads, shots and state dumps  |
| `live-headless`            | success          | 808 transactions, `applied` credit, under strace                                                                     |
| `live-stall`               | success          | stall after seq 559 (frame 607); seq 560 at frame 687 carries A1, fetched once; its step 6 shot equals the reference |
| `live-reconnect`           | success          | connection 2 starts full: 0 fetched, 3 cache hits, 5 uploads for 5 resident textures; then C and D fetched once each |
| `live-animate`             | success          | anim region equal to `synthesizeGate2` at each shot's frame, the rest equal to the reference                         |
| `sabotage-unpin`           | replay-failure   | `resource-unavailable` at seq 1: the third GET (ANIM, ~21 frames after the send) found its version retired, HTTP 404 |
| `sabotage-drop-resource`   | replay-failure   | `resource-unavailable` at seq 568, the first transaction naming A1, which the host answers 404                       |
| `sabotage-wrong-hash-live` | replay-failure   | `resource-hash-mismatch` at seq 571: the served A1 has its first data byte flipped                                   |

Images, all under the run directory: `live/receiver/shots/seq-<n>.png` (11 steps; equal to
`reference/shots/step-<k>.png`), `live-replay/shots/seq-<n>.png` for the same seqs,
`live-stall/receiver/shots/seq-560.png` (step 6, after the stall),
`live-reconnect/receiver/shots/stream-2-seq-<n>.png` (steps 8–10 on connection 2) and
`live-animate/receiver/shots/seq-<n>.png`.

### Findings

- **Pinning has to precede the send.** rs_ws's I/O thread transmits a transaction as soon as it
  is queued, so a receiver can GET a hash new at that frame before the callback ends; the host
  therefore pins everything it may send before the hub runs and retires after it.
- **The contract's 100 ms delay with a six-content ANIM.** A fresh receiver caches all six ANIM
  contents by host frame ~90, so `unpin` from S + N was unobservable (it retired 11 base-named
  hashes and the leg succeeded); the leg arms it from frame 1. The delay itself is safe: a fetch
  costs ~7 frames, so the GET lands three ANIM phases off the current content and is served only
  by the base pin.
- **A 2 s stall after step 5 skips step 6 entirely.** It would end at ~728, after step 7 replaced
  A, so A1 never reaches the wire; `live-stall` uses 1.3 s, ending inside step 6's window.
- **One HTTPClient state per frame cost 2–3 frames per fetch.** The fetcher now polls repeatedly
  within a frame while it makes progress (each poll non-blocking), bringing a fetch to one frame.

### What G2c does not prove

- Bearer tokens (G2e) and canvas textures (G2d); non-loopback serving (gate 8).
- Fetch costs below one frame, parallel fetches, large payloads (the largest is 21 955 B),
  constrained links and cache eviction (gate 6); browser receivers and their HTTP caches (gate 7).

## Gate 2d result (2026-10-09)

G2d ([protocol/gate2-design.md](protocol/gate2-design.md) "G2d" and its "As built") passes,
integrated onto `main` after G2c2 and G2e: `pnpm render-stream:gate2` with every group is 85/85 in
`artifacts/render-stream/gate2/g2d-final/`. The same build passed gate −1 28/28 with 55 hooks
(`artifacts/render-stream/gate-minus1/g2d-final/`), gate 0 19/19
(`artifacts/render-stream/gate0/g2d-final/`) and gate 1 65/65, all four groups
(`artifacts/render-stream/gate1/g2d-final/`). The calibrator did not need a bump: the four slots
(441/442/444/445) were reserved by calibrator 5.

What landed:

- **`CanvasTexture` in the mirror and on the wire.** `rs_mirror` taps `canvas_texture_create`,
  `_set_channel` (diffuse, normal, specular), `_set_texture_filter` and `_set_texture_repeat`. A
  canvas texture with a normal or specular channel is `unsupported`/`canvas-texture-channel`. The
  texture table gets `kind: "canvas"` entries with `canvas: {diffuse, filter, repeat}`.
- **The receiver applies it.** `rs_applier.gd` creates the canvas texture on first sight and
  re-issues the channel, filter and repeat calls whenever the wire version advances.
- **A headless host refuses it, typed.** The dummy storage never allocates a canvas texture
  (`servers/rendering/dummy/storage/texture_storage.h:54` returns `RID()`; the same on 4.6.2 and
  4.7.2), so a headless host declares
  `features.unsupported_resources: [{"resource":"canvas_texture","reason":"canvas-texture-headless"}]`
  and makes a texture draw naming `RID()` an `unsupported` command `canvas-texture-headless`. It is
  never replayed as the white default. The hook log marks each `canvas_texture_*` call the same
  way. The options for real support are in
  [protocol/canvas-texture-headless.md](protocol/canvas-texture-headless.md).
- **The fixture's step 11.** `SC` draws `A`'s 64×64 region at 1.125× with nearest filtering and
  repeat enabled. The main fixture sets them on the item, so no headless leg meets a
  `CanvasTexture`. The `canvas` variant gets the same pixels from a `CanvasTexture` `CT` while the
  item says linear/disabled.

| leg                           | host     | class (expected)                        | why                                                                                                          |
| ----------------------------- | -------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `canvas-headless`             | headless | unsupported (`canvas-texture-headless`) | 4 refused `canvas_texture_*` calls, no canvas entry; SC's draw refused from step 11, the receiver reports it |
| `canvas-host`                 | rendered | success                                 | CT on the wire (canvas, diffuse A, nearest/enabled, version 4); the receiver equals the reference            |
| `canvas-normal`               | rendered | unsupported (`unsupported-texture`)     | `CT.normal_texture = B`: canvas-texture-channel; region `sc` only, only step 11 (5 184 px)                   |
| `sabotage-omit-canvas-filter` | rendered | pixel-mismatch {11}                     | `omit-op canvas_texture_set_texture_filter` at step 11's frame; 1 088 px differ (nearest vs linear)          |

The three rendered legs are host-renderer evidence for the capture and replay path, not headless
support. `canvas-texture-override` holds on `canvas-host`'s own step-11 frame: region `sc` equals
`synthesizeGate2`'s nearest/enabled exactly (0 px differ), although SC's item says linear/disabled.

### Findings

- **A headless host cannot create a `CanvasTexture`** (above). Only the refusal makes that loud.
  Before it, the draw replayed as `tex: null`, which is white.
- **The hook log did not recompute status on a channel-set call.** `rs_resource_log.cpp`'s
  `canvas_texture_set_channel` left `canvas/ok` after the mirror flipped to `unsupported`.
  `canvas-normal` caught it as `texture-log-divergence`. Fixed.
- **Nearest vs linear only shows under magnification here.** At 1:1 and at 0.75× no pixel differed
  on flat-colour content. `SC` draws at 1.125×.
- **Gate 2's TS checker listed only the landed groups g2a-g2c** while the runner listed g2e too.
  Both now list g2a-g2e, g2d's legs are judged only when g2d ran, and the self-test fabricates g2e
  evidence (`gate2c-fixture.ts` `buildG2eTree`).

### What G2d does not prove

- `CanvasTexture` capture on a headless host (refused; see the options study).
- `canvas_texture_set_shading_parameters`, `texture_set_size_override`, and proxy, layered, 3D,
  external and viewport textures.
- Textured polygons, meshes and nine-patch (gate 5), lazy hashing and cache eviction (gate 6),
  browser receivers (gate 7), late join and the target game's textures (gate 8).

## Gate 2e result (2026-10-09)

G2e ([protocol/gate2-design.md](protocol/gate2-design.md) "G2e") passes: `pnpm render-stream:gate2
-- --legs g2a,g2b,g2c,g2e` is 77/77 in `artifacts/render-stream/gate2/g2e-run1/`. The same build
passed gate −1 28/28, gate 0 19/19 and gate 1 65/65 (all four groups), and `pnpm test` (2490
passed), `pnpm exec tsc --noEmit` on `experiments/render-stream`, and every pure self-test
(`self-test-rs0/1/2.ts`, `self-test-gate0.ts` 205/205, `self-test-gate1.ts` 402/402,
`self-test-gate2.ts` 354/354, `make_golden.py --check` on `golden/`, `golden-1/` and `golden-2/`).
All under the ignored `artifacts/`.

What landed:

- **`rs_ws` checks a bearer token on both routes.** `ServerConfig::auth_token` (empty disables the
  check, exactly as before G2e) gates the WebSocket upgrade and every resource GET.
  `constant_time_equals` (exposed in `rs_ws.h` for its own ctest) compares the presented token
  against the configured one in time that depends only on the longer string's length, never on
  where they first differ; the "Bearer " prefix check itself is allowed to short-circuit, since it
  names no secret. A missing or wrong token is `401`, never a close code: the upgrade's `reject()`
  closes the TCP connection after flushing the response (the same path every other rejected
  handshake already took); a GET's `401` honours `Connection: keep-alive` like its `404`, since an
  unauthorized request is not a broken connection.
- **The host generates and evidences the token without ever logging it.** `GRC_LIVE_AUTH=token`
  (default `none`) makes `entry.cpp` generate 32 random bytes as 64 lowercase hex
  (`getrandom()`, independent of `rs2::generate_id()`'s 16-byte session/stream ids), write them to
  `evidence/live-token` (mode 0600) before the listener starts, and declare the session's
  `resources.auth: "bearer"` (the wire field G2b1 had already reserved). A rejected upgrade is a
  new `rs_ws` event, `AuthRejected` — the connection never reaches `Opened`, so the hub has nothing
  to track; `entry.cpp`'s `live_drain()` logs it directly to `stdout.log` as `live: 401
unauthorized upgrade`, never to the structured hook log, since it carries no hash. A rejected GET
  stays on the existing `HttpGet`/`http-get` path with `http_status: 401`.
- **The receiver sends the token on both routes, or a deliberately wrong one.**
  `RS_RECEIVER_TOKEN_FILE` is read once at startup; `RsLiveClient.open()` sets
  `WebSocketPeer.handshake_headers` to `Authorization: Bearer <token>` before every
  `connect_to_url()` call, including reconnects; `RsResourceFetcher` sends the same header on every
  `HTTPClient.request()`. The new sabotage `RS_RECEIVER_SABOTAGE=wrong-http-token` corrupts only the
  fetcher's copy (appends `-wrong`) after the WebSocket has already opened with the correct one, so
  "correct on the upgrade, wrong on every GET" holds exactly as the contract asks.

Legs (group `g2e`), each a fresh live host (`GRC_LIVE_AUTH=token`, the live timeline, S = 300,
N = 60, quit 911) plus one receiver:

| leg                       | class (expected) | why                                                                                                                                       |
| ------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `live-auth`               | success          | as `live` (README "Gate 2c result") with tokens: 852 transactions, 9 fetches (31 181 B), 10 uploads (31 220 B), host 9 GETs / 0 errors    |
| `sabotage-no-token`       | replay-failure   | `live-connect-failed` at the very first connect: `WebSocketPeer` never reaches `STATE_OPEN` (state 3, close code −1) after the host's 401 |
| `sabotage-bad-http-token` | replay-failure   | `resource-unavailable` at seq 1: the first resource GET (needed by the initial transaction) answers HTTP 401                              |

`sabotage-no-token`'s host log shows exactly one `live: 401 unauthorized upgrade` line and zero
`http-get` 401s; `sabotage-bad-http-token`'s hook log shows exactly one `http-get` line with
`http_status: 401` and zero upgrade rejections; `live-auth` shows neither. `token-not-logged`
greps every file under each leg's directory (recordings, hook log, `stdout.log`, `applied.json`,
shots) for that leg's own 64-character token and finds it nowhere but `evidence/live-token` — this
was re-verified independently outside the checker (a raw-byte grep of the whole run directory,
each leg's token excluded only from its own `evidence/live-token` file) with zero hits.

### Findings

- **Bearer-auth evidence needed a channel `rs_ws` didn't have.** Every existing rejected-handshake
  path (wrong subprotocol, `max_clients`, a malformed request) produces no `Event` at all, which
  is fine when nothing downstream needs to know why. Proving the _host_ actually answered 401 (not
  just that the receiver failed to connect, which Godot's `WebSocketPeer` reports identically for
  any handshake failure — `get_close_code()` stays unset) needed a dedicated event
  (`AuthRejected`), following the exact precedent `HttpGet` set at G2c1/G2c2 for the same kind of
  "the switch must stay exhaustive under `-Wswitch`" extension.
- **Only the secret itself needs the constant-time property.** The "Bearer " prefix is a public
  RFC 6750 constant; letting `std::string::compare` short-circuit on it leaks nothing a timing
  attack could use, so `bearer_ok()` only pays for `constant_time_equals` over the token that
  follows the prefix (or an empty string, when the header is missing or malformed).
- **Node's WebSocket global cannot drive this test.** The WHATWG `WebSocket` constructor has no
  header parameter (the same restriction browsers have), so `self-test-rs-ws.ts`'s bearer-auth
  checks use `node:http`'s raw upgrade request directly: a 101 response arrives as an `upgrade`
  event, anything else (401 included) as an ordinary `response` event. The Godot interop tests hit
  the same wall from the other side — `WebSocketPeer` exposes no HTTP status for a failed
  handshake — so `ws_selftest.gd`'s auth phase can only assert "never reaches `STATE_OPEN`"; the
  host-side evidence above is what actually proves the status was 401.

### What G2e does not prove

- Non-loopback serving (gate 8, D13) and token transport without headers for a browser receiver
  (gate 7, deferred by D13 too).
- Token rotation while a connection is open, multiple valid tokens, or any authorization scheme
  beyond one static bearer token per host process.
- Canvas textures (G2d, landing in parallel); gate 2's full summary waits for it.

## Gate 2f result: the headless CanvasTexture shim, opt-in (2026-10-10)

The user approved option (a) of
[protocol/canvas-texture-headless.md](protocol/canvas-texture-headless.md) as an experiment, and it
passes that doc's criteria 1–4 ("Experiment (a) result"). With
`GRC_HEADLESS_CANVAS_TEXTURE=synthesize`, the `canvas_texture_create` hook replaces the dummy
storage's `RID()` with a private RID, `0x47524354 << 32 | (2^31 + n)`, which no engine owner can
own. A headless host then captures `CanvasTexture` like a rendered one. Without the variable,
nothing changes, and the typed refusal (`canvas-texture-headless`) stays the default. The capture
refuses typed when the opt-in is set on a host that is not `headless`
(`canvas-texture-shim-not-headless`), and when the value is invalid
(`canvas-texture-shim-invalid`).

The final run is on `main` at `0605ea75` (calibrator 8). It is on render-stream/4, after G5d,
the /5 codecs and G5g. `pnpm render-stream:gate2 -- --legs g2a,g2b,g2c,g2d,g2e,g2f` is 97/97 in
`artifacts/render-stream/gate2/ctshim-v5/`: g2a–g2e's 85 unchanged, plus g2f's 12. The same build
passed:

- `build-capture.sh` 17/17 ctests
- `calibrate.sh --check`
- gate −1 28/28
- gate 0 19/19
- gate 1 65/65
- gate 3 56/56
- gate 4 185/185
- gate 5 (g5b, g5c, g5d, g5g) 78/78
- gate 5.5 (g55b, g55c) 52/52

All are in `artifacts/render-stream/<gate>/ctshim-v5/`. Every pure self-test and every
`make_expected`/`make_golden --check` also passed. g2d's `canvas-headless` is still `unsupported`
(`canvas-texture-headless`). Earlier full runs on earlier bases are `ctshim-v1` (before G5d,
96/96 with 11 g2f checks) and `ctshim-v3` (after G5d, 97/97).

An earlier full run, `ctshim-v2`, was 95/97. Its two failures were g2c's `pins-bounded` and
`obsolete-retired` on `live-animate`, at quit frame 971: one hash was still servable that nothing
named. It ran beside the pure self-tests. This is the known live-animate load flake: no
`CanvasTexture` and no shim in those legs. Every g2f check passed in that run, and the next full
run, `ctshim-v3`, passed.

| leg                                | host                                          | class                                   | why                                                                                                                                            |
| ---------------------------------- | --------------------------------------------- | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `shim-headless`                    | headless capture (no GPU) + rendered receiver | success                                 | all 12 settle shots byte-exact against `reference-canvas` (rendered, extension absent), step 11's region `sc` included; CT on the wire as canvas/diffuse A/nearest/enabled |
| `shim-sabotage-omit-canvas-filter` | headless + rendered receiver                  | pixel-mismatch {11}                     | 1 088 px at step 11, the same as G2d's rendered-host sabotage                                                                                 |
| `shim-off`                         | headless, `=off` + headless receiver          | unsupported (`canvas-texture-headless`) | exactly the default                                                                                                                            |
| `shim-refused-rendered`            | gamescope capture host, `=synthesize`         | refused, typed                          | `canvas-texture-shim-not-headless`; no vptr write, no private RID, no recording                                                                |
| `shim-invalid`                     | headless, `=bogus`                            | refused, typed                          | `canvas-texture-shim-invalid`                                                                                                                  |
| `shim-gate5-canvas`                | headless, `fixtures/gate5` `canvas`, `=synthesize` | success                            | gate 5's D11 refuses no `RID()` geometry draw; commands equal the main gate 5 fixture's                                                        |

**Gate 5's D11 is relaxed under the opt-in.** G5d landed while this experiment was in flight. Its
sticky "a canvas texture exists" flag is now set only by a `canvas_texture_create` that returned
`RID()`. With the opt-in on, `RID()` geometry stays `tex: null` after a `CanvasTexture` is created.
With it off, nothing changes: gate 5's `capture-canvas` still refuses its five predicted draws. The
g2f leg `shim-gate5-canvas` (`fixtures/gate5`'s `canvas` variant, headless, opt-in) classifies
`success`, with the main fixture's commands at every settle frame.

One private RID, `0x4752435480000000`, was created at frame 111 and freed once through the hooked
`free()` at teardown. It is disjoint from all 26 RIDs that the 8 hooked creators returned. The
run's engine `ERROR`/`WARNING` lines are exactly the shim-off run's: two exit-time leak reports
that every headless gate-2 capture prints.

Open items:

- **Criterion 5**, the same leg on the target game. Pending the user's approval for the launch.
- **A session-level wire declaration of the shim.** Today it is declared only in the evidence.

The doc's "Experiment (a) result" has the details, including why `Skeleton2D` and
`GPUParticles2D`, which share the stub, are not a mechanical extension.

## Gate 2 summary

Gate 2 passes: `pnpm render-stream:gate2` with all groups g2a-g2e is 85/85 in
`artifacts/render-stream/gate2/g2d-final/`, on the same build as gate −1 28/28, gate 0 19/19 and
gate 1 65/65 (`artifacts/render-stream/{gate-minus1,gate0,gate1}/g2d-final/`). Every leg is at its
expected class. Images are under each leg's `shots/` in the run directory, and the references are
`reference/shots/step-{0..11}.png`.

What it proves, by increment:

- **2a.** The stock release template's texture calls can be hooked (calibrator 5, 55 hooks). Image
  bytes are copied and hashed at the hook, on the calling thread (loader threads included), and
  agree with an independent derivation of the fixture's twelve steps.
- **2b.** render-stream/2 carries textures as a versioned table with content-addressed payloads,
  out of band (store) or inline. A receiver uploads a texture only when a command first needs it
  and re-uploads only on a hash change. Transform-only steps cost zero texture traffic, and a warm
  cache fetches nothing.
- **2c.** Live hosts serve payloads over HTTP by hash on the WebSocket's listener. Pins cover every
  fetch a correct receiver can make, and everything else is retired. Stall, reconnect, warm, replay
  and animate legs all draw the reference's pixels.
- **2d.** `CanvasTexture` per-command filter and repeat override the item's, on the wire and in
  pixels, on a host with a real renderer.
- **2e.** A bearer token gates the upgrade and every GET, compared in constant time, and is never
  logged.

Unsupported, each typed and never substituted: formats outside the permitted six
(`unsupported-format`), oversized payloads (`payload-too-large`), textures created before arming or
never hooked, such as proxy, layered, 3D and viewport textures (`unknown-texture`), canvas
textures with a normal or specular channel (`canvas-texture-channel`), and, as an **architectural
finding**, every `CanvasTexture` on a headless host (`canvas-texture-headless`). The dummy renderer
that `--headless` forces allocates no canvas texture on 4.5.1, 4.6.2 or 4.7.2, so no pass-through
tap can see one. The options (a synthesized-identity shim, a software-GL host, a host-renderer
opt-in) and the recommended next experiment are in
[protocol/canvas-texture-headless.md](protocol/canvas-texture-headless.md). That experiment, an
opt-in shim that synthesizes the identities (`GRC_HEADLESS_CANVAS_TEXTURE=synthesize`), passes
criteria 1–4 (group g2f, "Gate 2f result" above). The refusal stays the default.

Costs measured in this run:

- **Copy and hash at the hook** (`capture`, 11 payloads): copy median 0.97 µs (max 2.7 µs for the
  800×6 hue strip). SHA-256 median 4.5 µs; 16 µs for 4 KiB, max 95 µs.
- **Bytes** (README "Gate 2b result"): median transaction 8 697 B full, 461 B patch. The store
  holds 10 payloads (50 493 B).
- **Fetches and uploads.** A cold receiver fetches 9 payloads (31 181 B) and uploads 10 times
  (31 220 B). A warm one fetches 0. Live fetch latency is p50 16.2 ms and p95 16.7 ms whatever the
  size (137 B to 21 955 B): one receiver frame at 60 fps. The retained maximum is 7 hashes
  (49 050 B).

What gate 2 does not prove: glyph atlases and MSDF text (gate 4); textured polygons, meshes and
nine-patch (gate 5); lazy hashing, spill-to-disk, cache eviction and parallel fetches (gate 6);
browser receivers and their HTTP caches (gate 7); non-loopback serving, late join, and the target
game's own textures (gate 8); `CanvasTexture` on a headless host (above).

## Gate 3a result (2026-10-09)

G3a ([protocol/gate3-design.md](protocol/gate3-design.md) "G3a") passes:
`pnpm render-stream:gate3 -- --legs g3a` is 16/16 in
`artifacts/render-stream/gate3/20261009T220745Z/`. An earlier run on the same code,
`20261009T213400Z`, was also 16/16. The same build passed gate −1 28/28 with 55 hooks planned and
none omitted (`artifacts/render-stream/gate-minus1/20261009T214037Z/`), gate 0 19/19
(`gate0/20261009T214155Z/`), gate 1 65/65 with all four groups (`gate1/20261009T214425Z/`) and
gate 2 85/85 with all five groups (`gate2/20261009T215439Z/`). The wire is unchanged
(render-stream/2), and the capture leg classifies `success`.

What landed:

- **The mirror clear fix (D3).** `Mirror::clear` now sets `clip = false`, as the engine's
  `Item::clear()` does, and keeps `custom_rect`. Three new `rs_mirror_test` cases cover it: clear
  resets, re-asserting in the same frame carries no clip change on the patch wire, and an omitted
  `set_clip` followed by a clear leaves the clip false. Gates 0–2 never set a clip true, so their
  captured state is unchanged.
- **The axis-aligned fixture** (`fixtures/gate3/`) and `make_expected.py`, which models Q1c from
  the source over the fixture's parameters and asserts Q6b's hand table.
- **`scripts/lib/clip-derive.ts`**, the wire-side scissor derivation (gate 7's reference), and the
  runner, checker and self-test (`run-gate3.sh`, `check-gate3.ts`, `lib/gate3-*.ts`,
  `test/self-test-gate3.ts`, 110 assertions).

Images (under the run directory): `reference/shots/step-{0..9}.png`,
`reference-repeat/shots/step-{0..9}.png` and `reference-armed/shots/step-{0..9}.png`. Every
reference shot equals `synthesizeGate3` exactly, full frame and every region. The repeat and the
armed reference are byte-identical to the reference, so the budget is 0. All **1 314 probes**
across the ten steps (591 decisive pairs) have exactly their expected colour. `clip-derive.ts`
over both sinks' settle transactions reproduces every owner's scissor, Q6b's table:

| step | `A`                | `B`                 | `C`                 | `D`                | `RC`               | `AN`               |
| ---- | ------------------ | ------------------- | ------------------- | ------------------ | ------------------ | ------------------ |
| 0, 1 | `[96,88,256,208)`  | `[196,148,256,208)` | `[236,188,256,208)` | `[344,88,408,136)` | `[464,88,528,136)` | `[88,320,616,344)` |
| 2    | same               | `[176,138,256,208)` | `[216,178,256,208)` | same               | same               | same               |
| 3    | same               | `[176,138,236,188)` | `[216,178,236,188)` | same               | same               | same               |
| 4    | —                  | same as 3           | same as 3           | same               | same               | same               |
| 5    | `[96,88,256,208)`  | same as 3           | same as 3           | same               | same               | same               |
| 6    | same               | same                | same                | same               | —                  | same               |
| 7    | same               | same                | same                | same               | `[472,96,488,112)` | same               |
| 8    | same               | same                | same                | same               | skipped            | same               |
| 9    | `[104,92,264,212)` | `[184,142,244,192)` | `[224,182,244,192)` | `[352,92,416,140)` | skipped            | `[96,324,624,348)` |

The census at the hook (`counters.json`, whole run) equals `expected.json`:
`canvas_item_set_clip` 11 true and 11 false (17 distinct entries), `canvas_item_set_custom_rect`
20 enabled and 1 disabled (18 distinct), and `canvas_item_clear` 32, with nothing dropped. Every
Control redraw re-sent clear, custom rect and clip, and no engine redraw was unaccounted for.

### Findings

- **Every hand prediction held on the first run.** These include the nested and slid scissors, the
  clip that a redraw re-asserts after its clear, the toggle, the step-6 clear that resets `RC`'s
  clip (`RCF` drawn whole), the clip without a custom rect that falls back to the command bounds,
  the zero-area skip, the custom rect that culls `CU` at steps 0–1 and draws it once its rect only
  touches the viewport edge, and the canvas shift.
- **No draw-index ties** occur in any of the capture's 400 frames, so `no-draw-index-ties` has
  nothing to list.
- **The ignore-clip prediction is wider than the contract said.** Unclipped, `BF`, `BZ` and `CF`
  also cover 34 _inside_ probes near `A`'s and `B`'s right and bottom edges. The model's
  `predictions` carry the exact set, and the contract's G3b row now points at them (As built,
  G3a). The other predicted step sets match Q7: freeze {2..9}, perturb {1..9}, omit-clip {3..9},
  omit-custom-rect {7,8,9}, clip-before-clear {3..9}, and root-size-observe mismatching only
  region `anchored`.

### What G3a does not prove

- That a receiver reproduces any of this. The receiver still applies `clip` before its clear
  (G3b). That gap is also why G3a has no receiver legs.
- Rotated or scaled clip owners (G3c), `clip_ignore` (G3d), text clipping (gate 4), or clipping
  under stretch (gates 6 and 7).

## Gate 3b result (2026-10-09)

G3b ([protocol/gate3-design.md](protocol/gate3-design.md) "G3b") passes:
`pnpm render-stream:gate3 -- --legs g3a,g3b` is 31/31 in
`artifacts/render-stream/gate3/20261010T003234Z/`. The same build passed gate −1 28/28 with 55
hooks and none omitted, gate 0 19/19, gate 1 65/65 (all four groups) and gate 2 85/85 (all five
groups) -- proving the reordered applier is still correct for every receiver leg gates 0–2
already exercise. `pnpm exec tsx --conditions=development
experiments/render-stream/scripts/test/self-test-gate3.ts` is 171/171 and
`fixtures/gate3/make_expected.py --check` is clean.

What landed:

- **The receiver apply order (D3).** `rs_applier.gd`'s `clip` setter now runs after the content
  block. A content rebuild's `canvas_item_clear` resets the shadow clip to false first (the
  engine's own reset), so the setter only re-sends `canvas_item_set_clip` when the wire value then
  differs from that shadow -- exactly the three cases of Q5: a redraw with `clip` unchanged
  re-sends it (`clear`, the adds, `set_clip(true)`); a transform-only change sends neither; a
  redraw that also flips `clip` to `false` sends no `set_clip` call, because the post-clear shadow
  already agrees. `receiver/tests/applier2_selftest.gd` gained `_test_applier_clip_order` (the
  three cases plus the new-item path) and two sabotage tests, all against the recorded
  `item_calls` sequence (new test instrumentation on `apply_state()`'s return value, not a wire
  field). Gates 0–2's own receiver legs stayed green because none of their fixtures ever clip.
- **Two receiver sabotages** (`RS_RECEIVER_SABOTAGE=ignore-clip` / `clip-before-clear`): the first
  corrupts every `canvas_item_set_clip` argument to `false` while the shadow still tracks the true
  wire value (same call cadence as an honest receiver); the second restores the pre-gate-3 bug
  outright (clip before content, no shadow reset).
- **`receiver`, `receiver-patch` and `receiver-headless-trace`** replay g3a's own capture
  (full and patch); **`sabotage-freeze`, `sabotage-perturb`, `sabotage-omit-clip` and
  `sabotage-omit-custom-rect`** each capture their own fresh recording with /1's host sabotages;
  **`root-size-observe`** captures with `GRC_ROOT_SIZE` unset. `scripts/lib/gate3-checks.ts` gained
  `evaluateG3bLeg`, `computeGate3ReceiverCheckpoints`, `probeTallyReceiver` and `checkLegClass3`,
  which reads every leg's expected mismatching steps, mismatching regions and failing probes
  straight out of `expected.json` `predictions[leg]` rather than a hand-typed table, so a
  disagreement with gate3-design.md Q7 would be a finding, not a silently-passing copy.
  `checkClipRectsDerived` gained a fourth, optional argument: once g3b runs, the same check also
  runs `deriveClipRects` over `receiver-patch`'s own resolved `state/seq-<n>.json` dumps, not just
  the capture's two sinks.

Every leg classified exactly as gate3-design.md Q7 and G3a's "As built" predictions say, with no
hand-derivation needed on this side either:

| Leg                                    | Class            | Mismatching steps     |
| --------------------------------------- | ---------------- | ---------------------- |
| `receiver`, `receiver-patch`           | `success`        | none                    |
| `sabotage-freeze`                       | `pixel-mismatch` | `{2,3,4,5,6,7,8,9}`     |
| `sabotage-perturb`                      | `pixel-mismatch` | `{1,2,3,4,5,6,7,8,9}`   |
| `sabotage-omit-clip`                    | `pixel-mismatch` | `{3,4,5,6,7,8,9}`       |
| `sabotage-omit-custom-rect`             | `pixel-mismatch` | `{7,8,9}`               |
| `sabotage-receiver-ignore-clip`         | `pixel-mismatch` | `{0,1,2,3,4,5,6,7,8,9}` (625 failing probes, exactly `predictions`) |
| `sabotage-receiver-clip-before-clear`   | `pixel-mismatch` | `{3,4,5,6,7,8,9}`       |
| `root-size-observe`                      | `unsupported` (`degenerate-host-size`) | `{0..9}`, mismatching only in region `anchored` |

`receiver`'s and `receiver-patch`'s shots (`receiver/shots/seq-{8,18,28,...,98}.png`,
`receiver-patch/shots/seq-{8,18,...,98}.png`) equal `synthesizeGate3` exactly, full frame and
every region: all 1314 probes across the ten steps (591 decisive pairs) have exactly their
expected colour, same as the reference. `sabotage-receiver-ignore-clip`'s shots
(`sabotage-receiver-ignore-clip/shots/seq-*.png`) fail exactly the predicted 625 probes (every
decisive outside probe plus the 34 inside probes `BF`/`BZ`/`CF` cover once unclipped, G3a's "As
built" amendment). `clip-rects-derived` reproduces Q6b's table over both sinks' settle
transactions and, now, over `receiver-patch`'s own resolved state dumps -- the same table as
G3a's, unchanged.

### Findings

- **No surprises.** Every mismatching-step, mismatching-region and failing-probe set matched
  gate3-design.md Q7's tables and `expected.json` `predictions` exactly on the first run; no
  amendment was needed to either.
- **The gamescope teardown segfault recurred twice** (benign, memory:
  gamescope-teardown-segfault-benign): the run still reported 31/31 with every leg at its
  expected class.

### What G3b does not prove

- Rotated or scaled clip owners, `clip_ignore`, text clipping, or clipping under stretch (G3c,
  G3d, gates 4, 6 and 7, same as G3a).
- Late-join adoption of clip state, or a live leg exercising clip (both deferred, D10, gate 8).

## Gate 3c result (2026-10-09)

G3c ([protocol/gate3-design.md](protocol/gate3-design.md) "G3c") adds the rotated/scaled fixture
`fixtures/gate3-xform/` and group g3c, and passes on top of G3b:
`pnpm render-stream:gate3 -- --legs g3a,g3b,g3c` is 49/49 in
`artifacts/render-stream/gate3/20261010T010856Z/`. Before G3b landed, the same g3c receiver checks failed on the
old receiver (28/34 with g3a, `20261009T232851Z/`), at exactly the six checks that need G3b's
clear-before-clip order and `ignore-clip` sabotage. The same build passed gate −1 28/28
(`gate-minus1/20261010T010355Z/`), gate 0 19/19 (`gate0/20261010T010357Z/`), gate 1 65/65
(`gate1/20261010T010853Z/`), gate 2 85/85 (`gate2/20261010T012338Z/`) and gate 4 g4a 21/21
(`gate4/20261010T012340Z/`). The capture and the wire are unchanged.

What landed:

- **The fixture** (`fixtures/gate3-xform/`): four clip owners under transformed `Node2D` parents
  (`rot`, `rotnest`, `half`, `flip`) over five steps, with `snap_controls_to_pixels` off.
- **`make_expected.py`**, which models the transforms, the RS calls, the cull and the scissor
  from the source, paints by pixel-centre coverage, marks the band, and evaluates the three
  alternative clip models at the six semantic probes. It asserts Q6d's hand tables.
- **`lib/gate3x-expected.ts`**, **`lib/gate3x-checks.ts`**, group g3c in `run-gate3.sh` and
  `runGate3`, and `test/gate3x-cases.ts` (34 more self-test assertions; 205 in all with G3b's).

Images (under `20261010T010856Z/`): `reference-xform/shots/step-{0..4}.png`, the same under
`reference-xform-repeat/` and `reference-xform-armed/`, and the receivers' `seq-{8,18,28,38,48}.png`
under `receiver-xform/shots/`, `receiver-xform-patch/shots/`,
`sabotage-xform-perturb/receiver/shots/` and `sabotage-xform-receiver-ignore-clip/shots/`.

The semantic probes as measured (reference pixel; the colour each model predicts):

| Probe                          | reference | engine | `rotated-exact` | `edge-round` | `pixel-centre` |
| ------------------------------ | --------- | ------ | --------------- | ------------ | -------------- |
| `rot.corner@0` (84,84)         | `RQF`     | `RQF`  | clear           | `RQF`        | `RQF`          |
| `rot.bottom@0` (100,157)       | `RQF`     | `RQF`  | clear           | clear        | clear          |
| `rot.bottom@2` (100,166)       | clear     | clear  | clear           | `RQF`        | `RQF`          |
| `half.right@0` (402,60)        | `SQF`     | `SQF`  | clear           | clear        | clear          |
| `half.bottom@0` (380,73)       | `SQF`     | `SQF`  | clear           | clear        | clear          |
| `half.sliver@0` (401,60)       | `SRF`     | `SRF`  | `SQF`           | `SQF`        | `SQF`          |

So the reference refutes each alternative at five of the six probes. The band is 191, 191, 240,
240 and 240 px at steps 0–4, all of it on `RQI`'s rotated edges. The reference equals pixel-centre
synthesis there too, and the repeat differs nowhere, so **the budget is 0 px**. All 660 probes
(330 decisive pairs) are exact in the reference and in both receivers. `clip-derive.ts` over both
sinks reproduces every scissor, including the rotation (`RQ` `[83,83,172,158)` → `[91,75,166,164)`
→ `[72,73,184,166)`), the nesting (`RQ2` `[232,79,328,145)`), the half rounding (`SQ`
`[371,51,403,74)`), the sliver (`SR` `[401,54,402,66)` → `[414,58,415,74)`) and the flip (`FQ`
`[448,208,512,256)` → `[528,208,592,256)`). The capture's retained state holds all 460 invariants:
there are no content changes at steps 1, 3 and 4, and `RQ` bumps at step 2 with `clip` true. Perturb
mismatches at exactly {1..4}. Ignore-clip mismatches at exactly {0..4}, with the 386 predicted
failing probes.

### Findings

- **Every hand value of Q6d held on the first run**, both the scissors and all 24 semantic-probe
  cells. GLES3 rasterizes non-antialiased rotated rects exactly by pixel centre on this GPU (RTX
  2060), band included.
- **The receiver dependency is the D3 trap, measured.** On the pre-G3b receiver, `receiver-xform`
  and `-patch` mismatch at exactly steps {2,3,4}, in `rot`, with `RQF` spilling into `rotnest`. `RQ`'s scale redraw at step 2 clears it, and the receiver set `clip` before that
  clear.
- Contract amendments (gate3-design.md "As built (G3c)"): `OA.left` and `OA.right` are listed as
  non-decisive, because `RQ2`'s scissor shares them; two ignore-clip probes lie in the unclipped
  band; the receiver import; check ids get `-xform`; the snap rounds rather than floors.

### What G3c does not prove

- Rotated text clipping, skew, clipping under stretch, or a browser receiver's clip (gates 4, 6
  and 7).

## Gate 3d result (2026-10-10)

G3d ([protocol/gate3-design.md](protocol/gate3-design.md) "G3d") passes:
`pnpm render-stream:gate3 -- --legs g3a,g3b,g3c,g3d` is **56/56** in
`artifacts/render-stream/gate3/20261010T025646Z/`, with `groups.not_run` empty. This run lands
after G3b's and G3c's own increments, and lifts G3d's original step-0-only limitation on
`receiver-clip-ignore` (see "Findings"). The same build passed gate −1 29/29 with **56 hooks**
planned and none omitted (`artifacts/render-stream/gate-minus1/20261010T023902Z/`), gate 0 19/19
(`gate0/20261010T013636Z/`), gate 1 65/65 (`gate1/20261010T013931Z/`) and gate 2 85/85
(`gate2/20261010T024044Z/`, a rerun: a same-code run earlier that session scored 83/85 on
`pins-bounded`/`obsolete-retired` under heavy concurrent load from other agents' gate runs on this
machine -- a timing-sensitive `live-animate` leg, not a regression; see gate 3c's own "Findings").

What landed:

- **Calibrator 6.** `canvas_item_add_clip_ignore` (header line 1595, slot 479, the existing
  `FnRidBool` signature) joins `hooks.cpp` as an optional hook. The mirror tap is the *existing*
  generic `add_unsupported` path every other calibrator-2 draw op already uses (msdf, polygon,
  triangle array, …): no new mirror code, one new `rs_mirror_test` case. The hook itself logs
  `(item, ignore)` into `counters.json`'s `captured.canvas_item_add_clip_ignore`, deduplicated like
  every other optional setter; the bool never reaches the wire.
- **Calibration record and spike.** The committed record now names 57 slots (56 hooks plus the
  `get_default_clear_color` probe); `scripts/calibrate.sh --check` is clean. `fixtures/spike/`
  gets a second orphan raw item (`add_clip_ignore(true)`, a rect, `add_clip_ignore(false)`, no
  parent canvas), so gate −1 plans 56 hooks with every optional counter positive and
  `armed.png == unarmed.png` still holds.
- **Feature-list amendment.** `observed_unsupported_ops` gains `canvas_item_add_clip_ignore`;
  `unobserved` gains `canvas_item_set_visibility_notifier` (D6: it is never hooked, and the scene
  API never combines a notifier with a clip). Both arrays stay sorted by byte value, in
  `capture/src/rs_publish.cpp` (`gate2_features`) and its test mirror
  `scripts/lib/gate0-checks.ts` (`RS2_FEATURES`, `GATE0_HOOKS`), which every gate's
  `manifest-present`/`capture-armed` reuses. `protocol/golden-2/` and `capture/test/rs2_golden_states.h`
  were regenerated to match (G1e's precedent).
- **The `clip-ignore` variant.** `fixtures/gate3/gate3.gd` adds a static raw item `RI` (draw index
  1002, origin (472,184)) only under `RS_FIXTURE_VARIANT=clip-ignore`: `add_rect`,
  `add_clip_ignore(true)`, `add_rect`, `add_clip_ignore(false)`, inside its own custom rect/clip.
  `make_expected.py`'s `variant_clip_ignore` block carries RI's draws per step for both the
  reference (the real engine's clip-ignore semantics, Q1d) and the receiver (which only sees the
  two `add_clip_ignore` calls as unsupported commands, so both rects stay clipped to RI's own
  scissor); both move with the step-9 canvas shift like every other top-level item. New legs
  `capture-clip-ignore`, `reference-clip-ignore` and `receiver-clip-ignore`
  (group `g3d`) and new checks `capture-armed-clip-ignore` (a second capture leg under its own
  directory, since gate 0's `checkCaptureArmed` hardcodes `capture/`), `clip-ignore-typed`,
  `expected-image-reference-clip-ignore` and `leg-class-capture-clip-ignore`/
  `-receiver-clip-ignore`.

Evidence: `capture-clip-ignore/recording.rs2`'s last transaction carries RI's item with exactly
`add_rect`, `unsupported canvas_item_add_clip_ignore`, `add_rect`, `unsupported
canvas_item_add_clip_ignore`, and one de-duplicated item-level entry
`{"op":"canvas_item_add_clip_ignore","reason":"unsupported-op"}` — `clip-ignore-typed` reads this
directly. `reference-clip-ignore/shots/step-{0..9}.png` equal `synthesizeGate3` with RI's
reference draws appended, exactly, at every step. `receiver-clip-ignore` replays every one of the
ten settle seqs against `reference-clip-ignore`'s matching `step-<k>.png`: `leg-class-receiver-
clip-ignore` reports mismatching regions `{ri}` and nothing else, at every step combined -- RI's
escaped second rect is the only disagreement, and the base scene's own clipping Controls (`B`,
`A`, `D`, `RC`), now on G3b's fixed receiver, replay clean alongside it.

### Findings

- **The step-0-only limitation lifted cleanly once G3b landed.** The first G3d run (branch history,
  `--legs g3a,g3d` only) found that comparing `receiver-clip-ignore` past step 0 also exercised the
  base scene's own clipping Controls (`B`, `A`, `D`, `RC`), which redraw at steps 3, 5 and 7 and lost
  their clip on the then-current receiver's `clip`-before-clear order (D3) -- spurious mismatches in
  regions `nested`, `redraw` and `raw`, not `ri`. The fix at the time was to request and check only
  the step-0 shot. With G3b's receiver apply-order fix now on `main`, this run restores full
  ten-step comparison (`make_expected.py`'s `variant_clip_ignore.receiver_draws` is per step, same
  as `reference_draws`; `run-gate3.sh`'s `run_g3d` uses the generic `run_rendered_receiver` helper
  again instead of a single-seq lookup) and the result is exactly the predicted `{ri}`-only
  mismatch at every step, with zero contamination from the base scene.
- **RI moves with the canvas shift.** The first attempt kept `variant_clip_ignore`'s draws static
  across all ten steps; `expected-image-reference-clip-ignore` caught the miss at step 9 (RI, like
  every other top-level item, is parented to the root canvas, so `get_viewport().canvas_transform`
  moves it too). Both `reference_draws` and `receiver_draws` are computed per step.

### What G3d does not prove

- That a receiver reproduces `canvas_item_add_clip_ignore` as anything other than a typed refusal
  — it is never asked to draw RI's second rect unclipped; that is the engine-only behaviour Q1d
  describes and D4 deliberately keeps off the wire.
- `clip_ignore` as a *supported* command: it stays a typed, in-place refusal (D4); the first wire
  bump after gate 3 (gate 5) is where that lands.

## Gate 3 summary

Gate 3 passes: `pnpm render-stream:gate3` with all groups g3a-g3d is **56/56** in
`artifacts/render-stream/gate3/20261010T074659Z/`, on the same build as gate −1
(`artifacts/render-stream/gate-minus1/20261010T072444Z/`), gate 0 19/19
(`gate0/20261010T072550Z/`), gate 1 65/65 (`gate1/20261010T072751Z/`) and gate 2 85/85
(`gate2/20261010T073607Z/`). Every leg is at its expected class. Images are under each leg's
`shots/` in the run directory: `reference/shots/step-{0..9}.png`, `reference-repeat/shots/` and
`reference-armed/shots/` (g3a); `receiver/shots/` and `receiver-patch/shots/` (g3b);
`reference-xform/shots/step-{0..4}.png`, `receiver-xform/shots/` and `receiver-xform-patch/shots/`
(g3c); `reference-clip-ignore/shots/step-{0..9}.png` and `receiver-clip-ignore/shots/` (g3d).

What it proves, by increment:

- **3a.** The engine's clip is a scissor: the rounded axis-aligned bounding box of the item's
  transformed rect, intersected with the nearest clipping ancestor's own already-rounded clip, as
  an integer scissor. The mirror's `canvas_item_clear` fix (D3) resets `clip` to `false` the way
  the engine's `Item::clear()` does. The axis-aligned fixture's 1 314 probes (591 decisive pairs)
  match exactly, `clip-derive.ts` reproduces every owner's scissor table by hand, and the budget
  (reference against a same-build repeat) is 0.
- **3b.** The receiver's apply order (D3): `clip` now applies after the content block, so a
  redraw's post-clear shadow state only re-sends `canvas_item_set_clip` when the wire value
  actually differs from it. Every sabotage — host-side (`freeze-frame`, `perturb-transform`,
  `omit-op` on `clip`/`custom_rect`) and receiver-side (`ignore-clip`,
  `clip-before-clear`) — mismatches at exactly its predicted steps, regions and probes, read
  straight from `expected.json` rather than a hand-typed table.
- **3c.** Rotated and scaled clip owners follow the same bounding-box model, not a rotated-rectangle
  clip, edge-independent rounding, or a pixel-centre scissor: the reference refutes each of those
  three alternatives at five of six semantic probes. The budget outside the non-axis-aligned band
  is 0, and the band itself (191–240 px across the five steps) matches pixel-centre synthesis.
- **3d.** Calibrator 6 hooks `canvas_item_add_clip_ignore` and types it `unsupported-op`, through
  the same generic unsupported-command path every other optional draw op already uses — no new
  mirror code. The receiver's only disagreement with the reference is the region `clip_ignore`
  escapes; the base scene's own clipping Controls replay clean alongside it.

Unsupported, each typed and never substituted: `canvas_item_add_clip_ignore`
(`unsupported-op`, calibrator 6, G3d) — supporting it as a command waits for gate 5's own wire
bump (`render-stream/4`, D4), since gate 5 must already bump for lines, polygons, meshes and
nine-patch. `unobserved`, not even typed: `clip_children` / `canvas_group_mode` (the handoff's
CanvasGroup/masks capability, D5, which needs item state /2 cannot validate) and
`canvas_item_set_visibility_notifier` (D6, added at G3d: the scene API never combines a notifier
with a clip, and notifier callbacks never fire on a headless host at all).

Costs and budgets measured in this run:

- **Budgets.** Axis-aligned: 0 px, reference byte-identical to its repeat across all 1 314 probes.
  Rotated/scaled: 0 px outside the band; the band covering non-axis-aligned edges is 191–240 px
  across the five steps, all on the rotated owner's edges, and the reference equals pixel-centre
  synthesis there too.
- **Probe coverage.** Every named boundary probe is exact in the reference and in both receivers
  (g3b, g3c); `sabotage-receiver-ignore-clip` fails exactly its predicted 625 probes (every
  decisive outside probe plus the 34 inside probes the unclipped scene exposes near `A`'s and
  `B`'s edges).
- **Census.** The hook log's `canvas_item_set_clip`, `canvas_item_set_custom_rect` and
  `canvas_item_clear` counts equal an independent derivation with nothing dropped, at every step.

What gate 3 does not prove: text clipping, including `Label.clip_text` (gate 4); clipping under
`canvas_items` stretch or a receiver-side stretch (gates 6 and 7); scroll containers with themed
scrollbars (gate 5's styleboxes, then gate 6); a browser receiver's clip, for which
`clip-derive.ts` is the reference implementation and both gate 3 fixtures the conformance set
(gate 7); a live leg exercising clip, and late-join adoption of clip state for Controls that exist
before arming (both gate 8, D10); `top_level` escape, uncovered unless gate 6's combined scene
uses it; and `VisibleOnScreenNotifier2D` never firing on a headless host, a host-behaviour finding
left to gate 8 (D6).

## Gate 4a result (2026-10-09)

G4a ([protocol/gate4-design.md](protocol/gate4-design.md) "G4a") passes:
`pnpm render-stream:gate4 -- --legs g4a` is 21/21 in
`artifacts/render-stream/gate4/20261009T231107Z/`. The first run on the same build,
`20261009T230526Z`, was 20/21: only `oracle-agrees` failed, on colour floats printed at 15
digits. The same build passed gate −1 28/28 with 55 hooks (`gate-minus1/20261009T230733Z/`),
gate 0 19/19 (`gate0/20261009T230858Z/`), gate 1 65/65 with all four groups
(`gate1/20261009T231230Z/`), gate 2 85/85 with all five groups (`gate2/20261009T232533Z/`) and
gate 3 `--legs g3a` 16/16
(`gate3/20261009T234532Z/`). Nothing on the capture side or the wire changed: grayscale text is
render-stream/2 as it stands, and the capture leg classifies `success`.

What landed: the Latin grayscale fixture (`fixtures/gate4/`). Its font is provisioned from
`fonts.lock.json` by `scripts/lib/provision-fonts.sh`, so no second copy of a binary is
committed. Also landed: the reference-side glyph oracle (`glyph_oracle.gd`), `make_expected.py`
(the census derived from the strings by Q1c), and the runner, checker and self-test
(`run-gate4.sh`, `check-gate4.ts`, `lib/gate4-*.ts`, `test/self-test-gate4.ts`, 66 assertions).

Images (under the run directory): `reference/shots/step-{0..9}.png`, `early-{1,4,7}.png` (one
frame after each upload step), and the same under `reference-repeat/` and `reference-armed/`.
Outside the text regions every shot equals `synthesizeGate4` exactly. Every text region has ink
exactly when its Label is visible with text, and it changes exactly when expected. The repeat and
the armed reference are byte-identical to the reference, so the **budget is 0** in every region.
Each early shot already equals its settle shot.

Census as measured (hook log, frame of each call; it equals the prediction of gate4-design.md Q6b
in every cell):

| step | frame | F@16 (wire id 2)        | F@24 (3) | DF@16 (4) | other                          | glyph commands |
| ---- | ----- | ----------------------- | -------- | --------- | ------------------------------ | -------------- |
| 0    | 1     | create v1 (H e l o)     | create   | create    | the engine's 800×6 RGBA8 strip | 31             |
| 1    | 11    | update v2 (Q u a r t z) | —        | —         |                                | 37             |
| 2, 3 | —     | —                       | —        | —         | no texture call at all         | 37, 37         |
| 4    | 41    | update v3 (W y v n)     | —        | —         |                                | 43             |
| 5, 6 | —     | —                       | —        | —         | no texture call at all         | 32, 43         |
| 7    | 71    | update v4 **and** v5    | —        | —         | wire publishes v5 only         | 37             |
| 8    | —     | —                       | —        | —         | no texture call at all         | 37             |
| 9    | 91    | —                       | —        | update v2 |                                | 38             |

Each upload is a whole 256² LA8 page: 131 072 data bytes, 131 185 payload bytes. That is 412 867
B published at step 0 (three pages and the hue strip) and 131 185 B at each of steps 1, 4, 7 and 9.
At the hook a page copy costs 10–100 µs and its SHA-256 about 0.4 ms. Teardown frees the runtime
font's two pages at frame 401; the default theme font's page outlives the run.

Atlas parity: at every settle step each page the rendered reference dumps
(`font_get_texture_image` as a GRT1 payload) has the hash of exactly one wire texture:

| steps | F@16              | F@24                | DF@16               |
| ----- | ----------------- | ------------------- | ------------------- |
| 0     | v1 `607c200f69…`  | v1 `366798e78b…`    | v1 `e9fd3088be…`    |
| 1–3   | v2 `ab83b838df…`  | same                | same                |
| 4–6   | v3 `4deb468ed7…`  | same                | same                |
| 7, 8  | v5 `b446a2d32c…`  | same                | same                |
| 9     | same              | same                | v2 `8477ff7922…`    |

Headless rasterization is therefore byte-identical to the rendered reference's. All 372 glyph
commands (both sinks) equal the oracle's quads and source rects as float32 exactly, with the font
colour as modulate. The four consecutive version pairs wrote 1 105 texels, all onto empty `(255,0)`
texels.

### Findings

- **Every census prediction held on the first run.** These include the step 7 double upload, the
  hidden Label that rasterizes nothing until shown, zero texture traffic on the transform-only,
  hidden-text, emptied, reordered and recoloured steps, and the default theme font's own page.
- **The oracle needs the engine's own paragraph.** A Label shapes `text + U+200B`. An oracle that
  shapes the bare text would differ for any font that kerns or ligates against it.
- **Amendments** (gate4-design.md G4a "As built"): the capture quits at 400 as in gates 0–3, the
  early shots are `early-<k>.png`, the oracle prints floats at full precision, and glyph sets are
  compared by glyph index.

### What G4a does not prove

- That a receiver draws any of this: that is G4b, which replays the recording with the unchanged
  receiver.
- Subpixel variants, outlines, shadows, wrapping, alignment, `clip_text`, multiple pages, cache
  lifetime (G4c), RichTextLabel (G4d), MSDF (G4e), or complex scripts and fallback (G4f).

## Gate 4b result (2026-10-09)

G4b ([protocol/gate4-design.md](protocol/gate4-design.md) "G4b") passes:
`pnpm render-stream:gate4 -- --legs g4a,g4b` is 37/37 in
`artifacts/render-stream/gate4/20261010T003432Z/` (a first, identical-logic run at
`20261010T002835Z` caught a checker bug, below). The same build passed `build-capture.sh` (10/10
ctests), gate −1 (`gate-minus1/verify-g4b/`), gate 0 19/19 (`gate0/20261010T002934Z/`), gate 1
65/65 with all four groups (`gate1/20261010T003023Z/`), gate 2 85/85 with all five groups
(`gate2/20261010T003027Z/`) and gate 3 `--legs g3a` 16/16 (`gate3/20261010T003042Z/`). No
receiver, mirror or fixture file changed; the receiver is the one gates 0–3 already exercise.

What landed: `synthesizeText`/`compareSynthesizedText` in `lib/gate4-expected.ts` (D8's ink:
oracle quads sampled against a page's LA8 alpha, in the node's font colour, straight-alpha
blended over the region's background); `receiverStepSeqs`/`loadReceiverShots` in
`lib/gate4-checks.ts`, which re-key a receiver's wire-seq shots to the reference's filenames so
every G4a shot evaluator runs over a receiver unchanged; `computeGate4Checkpoints` plus
`checkLegClass` (classifyLeg against a leg's class and, for a sabotage, its exact predicted
mismatching steps); `loadAtlasPageImages`/`loadPagesByStep`; `evaluateExpectedText`/
`checkExpectedText`; `evaluateResourceQuiet`; `checkReceiverNeverShapes`;
`checkReceiverConsumedStream`; `checkReceiverTypedClean`; and `checkAtlasHashParitySabotage`. The
runner (`run_g4b`, `g4_capture`, `early_shots_csv`) adds group `g4b`: the unchanged receiver on
the main capture's full and patch sinks (plus the early shots at frames 12, 42 and 72), a headless
openat trace, and three fresh sabotage captures at the fixture's own 102-frame default — each with
its own rendered receiver.

Images (under the run directory): `receiver/shots/` and `receiver-patch/shots/` (`seq-<n>.png`,
re-keyed to `step-<k>.png`/`early-<k>.png` by the checker), and
`sabotage-{freeze,perturb,omit-atlas}/receiver/shots/`. `receiver-vs-reference` is exact on both
sinks, full frame and every region (budget 0, as the reference-repeat budget already was).
`expected-text-reference` and `expected-text-receiver` (D8's new, independent check) hold the
budget exactly: **max channel delta 1**, 5 301 pixels at delta ≥ 1 across the ten steps' seven
text regions — every one of them inside the documented UNORM8-blend-rounding allowance, with none
at delta 2 or more.

Sabotage outcomes, matched to G4a's predictions exactly:

| Leg                    | Sabotage                                   | Class          | Mismatching steps | atlas-hash-parity                      |
| ----------------------- | ------------------------------------------- | -------------- | ------------------ | --------------------------------------- |
| `sabotage-freeze`      | `freeze-frame` @ frame 11 (step 1)         | `pixel-mismatch` | {1..9}            | n/a                                      |
| `sabotage-perturb`     | `perturb-transform` @ frame 21 (step 2)    | `pixel-mismatch` | {2..9}            | n/a                                      |
| `sabotage-omit-atlas`  | `omit-op texture_2d_update` @ frame 41 (step 4) | `pixel-mismatch` | {4..9}       | fails exactly at `F@16` {4..9}, `DF@16` {9} |

Every step outside a leg's predicted set matches the reference exactly (`checkLegClass` asserts
this explicitly, not just the overall class). `receiver-never-shapes` found no `*.ttf`/`*.otf`/
`*.woff`/`*.woff2`/`*.fnt`/`*.fontdata` opened by the traced receiver and no `TextServer`, `Font`,
`Label`, `RichTextLabel`, `draw_string` or `draw_char` symbol in any of the receiver's 11 `.gd`
files. `receiver-consumed-stream`, `receiver-never-loaded-fixture` and `receiver-typed-clean` are
clean across all six receiver legs. `resource-quiet` confirms the five no-texture-traffic steps
(2, 3, 5, 6, 8) fetch and upload nothing on either sink.

### Findings

- **The checker, not the runner, had the only bug.** The first run's three sabotage legs
  classified `replay-failure` instead of `pixel-mismatch`: the checker's `requestedShotSeqs`
  wrongly included the early-frame seqs (12/42/72) for a sabotage receiver, which `run_g4b` never
  requests (only the plain `receiver`/`receiver-patch` legs shoot them). Fixed by restricting a
  sabotage leg's `requestedShotSeqs` to its settle seqs; re-running only the checker against the
  same evidence (no Godot re-run needed) turned all three green, and a full fresh run confirmed
  it byte-for-byte.
- **D8's budget held at exactly its ceiling, not below it.** 5 301 pixels sit at delta 1 and none
  at 2+, across both the reference's own shots (a sanity check on the synthesizer itself) and the
  receiver's (the real claim). This is the first evidence that the synthesizer's blend model
  (straight alpha, node colour, LA8 coverage, no filtering) matches the GPU's UNORM8 rounding to
  within its documented tolerance and no further.
- **Reusing G4a's shot evaluators needed one seam, not a rewrite.** Re-keying a receiver's
  `seq-<n>.png` files to the reference's `step-<k>.png`/`early-<k>.png` names
  (`loadReceiverShots`) let `evaluateExpectedImage`, `evaluateInkPresence`, `compareLegs` and the
  new `evaluateExpectedText` run unchanged over either side.

### What G4b does not prove

- Anything G4c–G4f own: sizes, pages, wrapping, alignment, `clip_text`, outlines, shadows,
  subpixel, cache lifetime and LCD (G4c); `RichTextLabel` spans (G4d); MSDF and `render-stream/3`
  (G4e); multilingual shaping (G4f).
- That the receiver's apply order for clipped text is correct: G4c and G4d wait for G3b for that
  reason (D13); G4b's Labels never clip.

## Gate 4c result (2026-10-10)

G4c ([protocol/gate4-design.md](protocol/gate4-design.md) "G4c", "As built (G4c)") passes:
`pnpm render-stream:gate4 -- --legs g4a,g4b,g4c` is 79/79 in
`artifacts/render-stream/gate4/20261010T023733Z/` (g4c alone 43/43 at `gate4/dev-g4c-2/`). The
same build passed `build-capture.sh` (11/11 ctests), gate −1 28/28 (`gate-minus1/20261010T015223Z/`),
gate 0 19/19 (`gate0/20261010T015342Z/`), gate 1 65/65 (`gate1/20261010T015624Z/`), gate 2
85/85 (`gate2/20261010T020714Z/`) and gate 3 49/49 with g3a–g3c (`gate3/20261010T022208Z/`).
No capture, receiver or protocol file changed.

What landed: `fixtures/gate4-layout/` (14 Labels on runtime `FontFile`s of the pinned bytes:
sizes 12/14/16/24/40/320, word and arbitrary wrap, left/centre/right/fill and top/centre/bottom
alignment, two `clip_text` Labels, an outline-4 Label, a shadow, a subpixel-`auto` font, a cache
whose hinting changes, and variant `lcd`), its oracle (Label's whole layout and draw, every pass),
`make_expected.py`, group g4c in `run-gate4.sh` (legs under `<out>/layout/`) and
`lib/gate4c-checks.ts`. Images: `layout/reference/shots/step-<k>.png` and `early-<k>.png`,
`layout/receiver{,-patch}/shots/`, `layout/sabotage-omit-atlas/receiver/shots/`,
`layout/lcd/{reference,receiver}/shots/`.

Every glyph command (1 269 per sink over the ten settle steps, shadow, outline and text passes)
equals the oracle float32-exact, every oracle page hashes to exactly one wire texture, and the
receivers equal the reference exactly. D8's synthesized ink, now per pass colour, outline page and
clip, holds at **max channel delta 1** (21 386 px at delta 1). Census as measured (c = create,
u = updates, f = free; `F@24/4` is the outline cache):

| step | change                     | uploads                                                                 |
| ---- | -------------------------- | ----------------------------------------------------------------------- |
| 0    | everything                 | F@16, F@12, F@24, F@320, FL@16: c; F@24/4: c + u6; FX@14: c + u7        |
| 1    | LZ 16 → 40 px              | F@40: c (512²)                                                          |
| 2    | LW, LR rewrap              | F@16: u1                                                                |
| 3    | LO "Overt"                 | F@24: u1; F@24/4: u2                                                    |
| 4    | LX "Subpixel wave"         | FX@14: u5                                                               |
| 5, 9 | alignment; outline colour  | none                                                                    |
| 6    | LK new clipped text        | F@16: u1                                                                |
| 7    | LP's 26 capitals at 320 px | F@320 page 0: u1, page 1: c (two 1024² LA8 pages, 4 MiB published)      |
| 8    | FL.hinting = NONE          | FL@16 page (wire id 7): f; FL2@16 page (wire id 11): c, both in frame 81 |

Subpixel census (`FX@14`, quarter pixel, x shifts {0,1,2,3}): 8 uploads against 17 new
(glyph, shift) pairs at step 0, and 5 against 6 at step 4. Clips derived from the wire: LK
`[16,132,96,160)`, LP `[16,147,616,360)`. `sabotage-layout-omit-atlas` (omit
`texture_2d_update` from frame 71) is `pixel-mismatch` at exactly {7,8,9}, with all 23 393
differing pixels inside LP, and its parity fails exactly at F@320 {7,8,9}. `capture-lcd` and
`receiver-lcd` are `unsupported` (`canvas_item_add_lcd_texture_rect_region`/`unsupported-op`,
7 commands, beside an `ok` RGBA8 256² page). The receiver differs from `reference-lcd` only inside
LC's region (437 px per step).

### Findings

- **Labels added in `_ready` shape before anything draws.** A Control's post-enter-tree minimum
  size update is synchronous (`control.cpp:3803-3807`), and it shapes the Label. So every plain
  page is created once at step 0, whatever feeds it. Q1c's per-draw rule starts at step 1.
- **Outline and subpixel glyphs upload one at a time.** Both rasterize at draw time, so each new
  outline glyph or (glyph, shift) variant is its own whole-page upload. This is gate 6's
  hash-at-publish input (D9).
- **Draw-time caches hide from `font_get_size_cache_list`.** They carry the viewport's
  oversampling level. The oracle uses `font_get_size_cache_info`.
- **The default theme's `shadow_outline_size` is 1.** A shadowed Label would draw a second pass
  from its own `(size, 1)` cache. The fixture pins it to 0, as Q6e's "reuses the text page"
  assumes.
- **A free Label never shrinks below its minimum.** LP's 600×120 box is 600×437, so its clip ends
  at the viewport. An autowrap Label's first minimum is computed at width 0, so the fixture sets
  each box, re-shapes and sets it again.
- `run_g4c` imports `receiver/`. A fresh worktree had never imported it, and `run_g4b` relies on
  an earlier gate having done so.

### What G4c does not prove

- Fractional glyph quads: subpixel quads are still floored at scale 1, so MSDF's unfloored quads
  are G4e2's. `RichTextLabel` (G4d), multilingual shaping and fallback pages (G4f).
- LCD rendering on a receiver: it stays typed `unsupported` (Deferred).
- Overrun trimming, ellipses, `max_lines_visible`, paragraph separators and stacked outlines or
  shadows. The oracle refuses ellipses and models one paragraph.

## Gate 4d result (2026-10-10)

G4d ([protocol/gate4-design.md](protocol/gate4-design.md) "G4d", "As built (G4d)") passes:
`pnpm render-stream:gate4 -- --legs g4a,g4b,g4d` is 62/63 in
`artifacts/render-stream/gate4/20261010T031556Z/` (the one non-pass is the expected `not-run`
placeholder for `g4c`, landed but not requested in this `--legs`; g4d's own 24 checks are all
`pass`). The same build passed `build-capture.sh` (11/11 ctests), gate −1 28/28
(`gate-minus1/20261010T015258Z/`), gate 0 19/19 (`gate0/20261010T015440Z/`), gate 1 65/65
(`gate1/20261010T015728Z/`), gate 2 85/85 (`gate2/20261010T020936Z/`) and gate 3 49/49 with
g3a–g3c (`gate3/20261010T030336Z/`). No capture, receiver or protocol file changed.

What landed: `fixtures/gate4-rich/` (a `RichTextLabel` with `[color]`, plain, `[font_size=24]`,
`[b]` (a `FontVariation` embolden 1.2), `[i]` (a `FontVariation` transform skewed 0.2),
`[bgcolor]` and an outlined (`[outline_size=2]`) span, cumulative over six steps, plus an
`append_text` step), its own glyph oracle (`glyph_oracle.gd`, per-span glyph sets and counts, not
quads: Q6c), `make_expected.py`, group `g4d` in `run-gate4.sh` (legs under `rich-*/`) and
`lib/gate4d-checks.ts`. Images: `rich-reference/shots/step-{0..5}.png`,
`rich-receiver{,-patch}/shots/`, `rich-underline/{reference,receiver}/shots/`.

Every glyph command (176 over the six settle steps x 2 sinks) sums by wire id to the oracle's
per-span `glyph_count` exactly; bold and italic map to their own wire ids (`FB@16`=4, `FI@16`=5,
distinct from `F@16`=2); every `[bgcolor]` span has its matching `add_rect`. Every oracle page
hashes to exactly one wire texture at every step, and `deriveClipRects` (gate 3's) gives `RTL`
its fixed clip rect `[24,32,424,222)` on both sinks at every step (`fit_content` never needs to
grow it: the chosen 190 px height covers every step's content). `reference-repeat-budget` is 0 in
every region. Census as measured (c = create, u = update):

| step | change                                        | uploads                                          |
| ---- | ---------------------------------------------- | ------------------------------------------------- |
| 0    | `[color]Amber[/color] plain [font_size=24]Big` | `F@16`: c (10 glyphs); `F@24`: c (3)              |
| 1    | `+ [b]Bold[/b]`                                 | `FB@16`: c (4)                                    |
| 2    | `+ [i]Italic[/i]`                               | `FI@16`: c (6)                                    |
| 3    | `+ [bgcolor=cyan]Marked[/bgcolor]`              | `F@16`: u1 (M, k, d)                               |
| 4    | `+ [outline_size=2]Outlined[/outline_size]`     | `F@16`: u1 (O, u, t); `FO@16`: c + u7 (8 glyphs, one event per glyph) |
| 5    | `append_text("\n[color=magenta]More[/color]")` | `F@16`: u1 (o)                                    |

### Findings

- **`RichTextLabel` is never `leg-class` `success`.** Its per-line box-drawing pass unconditionally
  emits `canvas_item_add_set_transform` (identity or not), which `render-stream-0.md` types
  `unsupported`, unrelated to any span. `rich-leg-class-capture` requires `unsupported` with
  *exactly* that op and nothing else, and separately requires zero pixel mismatch (the reset is
  visually inert here). The underline variant's `leg-class` is `unsupported` for two reasons once
  this is accounted for; `rich-underline-capture-class` only asserts `canvas_item_add_line` is
  among the reasons, not the only one.
- **An outline cache uploads once per new glyph, not once per redraw.** The first `make_expected.py`
  draft modelled it like a fill cache (one event for the whole span) and `rich-atlas-census` failed
  61/62 against the real capture, which showed 8 events (1 create + 7 updates) for the 8-glyph
  "Outlined" span's first use; a checker/model re-run against the *unchanged* evidence after fixing
  the model (memory rs-g4b-receiver-checker-facts' pattern one gate later) turned it 62/62. Source
  (`_font_draw_glyph_outline`, `ts_adv:4068-4136`) confirms why: it checks its own texture's
  `dirty` flag inline, per glyph, with no shaping-time pre-rasterization pass of its own -- unlike
  the fill path, which rasterizes a whole redraw's new glyphs together before any drawing. G4c
  found the same fact independently for its own outline and subpixel caches.
- **`RichTextLabel` always has an internal `VScrollBar` child**, its own `CanvasItem` created right
  after `RTL`'s and before `Marker`'s, present regardless of `scroll_active` and drawing nothing
  here; `creation_order` needed a third name.
- **The outlined span's two-pass oracle design held on the first measurement**: `glyph_oracle.gd`
  expands one `outline > 0` span into two entries sharing its `key` (fill `F@16`, outline `FO@16`),
  and `evaluateRichOracleAgrees`'s zero-problem result against the real oracle confirmed the model
  before any capture comparison ran (D7).

### What G4d does not prove

- Exact glyph placement for `RichTextLabel`: the oracle reports per-span counts and sets, not
  quads (Q6c), so there is no `rich-expected-text-*` (D8's exact synthesis). `rich-expected-image-*`
  and `rich-ink-presence-*` (quad-independent) still hold exactly.
- Wrapping, alignment, multiple pages, cache lifetime and LCD for `RichTextLabel` specifically
  (G4c covers these for `Label`); MSDF spans (G4e); multilingual spans (G4f).
- `[u]` underline placement beyond "confined to `RTL`'s region": the stroke's own geometry is not
  checked, only that dropping it changes no pixel outside `RTL`.

## Gate 4f result (2026-10-10)

G4f ([protocol/gate4-design.md](protocol/gate4-design.md) "G4f", "As built (G4f)") passes:
`pnpm render-stream:gate4 -- --legs g4a,g4b,g4c,g4d,g4f` is 142/142 in
`artifacts/render-stream/gate4/20261010T041606Z/` (g4f's own 38 checks; g4f alone was 38/38 on
its first run). The same build passed `build-capture.sh` (11/11 ctests), gate −1 28/28
(`gate-minus1/20261010T043254Z/`), gate 0 19/19 (`gate0/20261010T043412Z/`), gate 1 65/65
(`gate1/20261010T043647Z/`), gate 2 85/85 (`gate2/20261010T044740Z/`) and gate 3 56/56 with
g3a–g3d (`gate3/20261010T050200Z/`). No capture, receiver or protocol file changed.

What landed: `fixtures/gate4-i18n/` (ten Labels at 16 px on one runtime `FontFile`, Open Sans,
whose fallbacks are the engine's Vazirmatn, Noto Sans Devanagari UI and Noto Sans Hebrew, pinned
in `fonts.lock.json` from `../godot-4.5.1-stable/thirdparty/fonts/` with their SHA-256 and OFL-1.1
licence files and provisioned, never committed), its oracle (shaped clusters, fallback font keys,
hex boxes), `make_expected.py`, group g4f in `run-gate4.sh` (legs under `<out>/i18n/`) and
`lib/gate4f-checks.ts`. Images: `i18n/reference/shots/step-<k>.png` and `early-{1..5}.png`,
`i18n/receiver{,-patch}/shots/`, `i18n/sabotage-omit-atlas/receiver/shots/`.

Every glyph command (441 per sink over the ten settle steps) and every hex-box `add_rect` equals
the oracle float32-exact, each glyph names its own font's page, every oracle page hashes to
exactly one wire texture, and the receivers equal the reference exactly. Reference against repeat
is 0 in every region. D8's synthesized ink holds at **max channel delta 1** (6 312 px at delta 1;
the hex box at 0). Census as measured, with the atlas bytes published per step and the copy/hash
cost per step in µs:

| step | change                                       | uploads (c = create, u = update) | bytes   | copy/hash |
| ---- | -------------------------------------------- | -------------------------------- | ------- | --------- |
| 0    | `LG` Greek, `LCy` Cyrillic, `LV` NFD Vietnamese | OS@16: c (+ the 800×6 hue strip) | 150 497 | 15/434    |
| 1    | `LAr` Arabic                                  | VZ@16: c                         | 131 185 | 12/466    |
| 2    | `LFa` Persian with ZWNJ                       | VZ@16: u1                        | 131 185 | 11/472    |
| 3    | `LHe` Hebrew with niqqud                      | HE@16: c                         | 131 185 | 10/403    |
| 4    | `LBi` `abc אבג 123`                            | OS@16: u1, HE@16: u1             | 262 370 | 241/951   |
| 5    | `LD1` `क्षत्रिय`, `LD2` `कि` (one frame)        | DV@16: c + u1 (hook v1, v2; wire v2) | 131 185 | 77/746 |
| 6–9  | colour, U+2603, a move, old glyphs in two scripts | none                         | 0       | 0/0       |

Script predictions (`script-predictions`, on the oracle and on both sinks), all held: the NFD
`e + U+0302 + U+0301` is 1 glyph, OS's U+1EBF (828); lam-alef is 1 Vazirmatn glyph; ZWNJ is an
invisible index-0 glyph; shin + qamats + shin dot is one 3-glyph cluster with one advancing glyph,
the marks over the base; `क्षत्रिय` is 4 glyphs for 8 codepoints; `कि`'s i-matra quad is at x −1,
left of KA's at 3; the Hebrew run's quads go 75 > 67 > 61 in logical order; U+2603 is 26
`add_rect`s and no texture command. `fallback-pages`: OS's page at step 0 (wire id 2), VZ's at 1
(3), HE's at 3 (4), DV's at 5 (5), each created once in its step's applied frame. Atlas parity:

| step | OS@16       | VZ@16       | HE@16       | DV@16       |
| ---- | ----------- | ----------- | ----------- | ----------- |
| 0    | 2@v1 9d6955 | —           | —           | —           |
| 1    | 2@v1 9d6955 | 3@v1 55a318 | —           | —           |
| 2    | 2@v1 9d6955 | 3@v2 01d278 | —           | —           |
| 3    | 2@v1 9d6955 | 3@v2 01d278 | 4@v1 47b3a5 | —           |
| 4    | 2@v2 95d9e4 | 3@v2 01d278 | 4@v2 e723bc | —           |
| 5–9  | 2@v2 95d9e4 | 3@v2 01d278 | 4@v2 e723bc | 5@v2 faf885 |

`sabotage-i18n-omit-atlas` (omit `texture_2d_update` from frame 51) is `pixel-mismatch` at
exactly {5..9}, all 94 differing pixels per step inside LD2, and its parity fails exactly at DV@16
{5..9}.

### Findings

- **`Label.text_direction` defaults to AUTO** (`scene/gui/label.h:70`), so the Arabic, Persian and
  Hebrew Labels are RTL paragraphs; the oracle shapes in the Label's own direction.
- **`Font.get_rids`, `has_char` and `get_height` walk the fallback chain.** The oracle keys fonts
  by `get_rids()[0]`, the fixture tests coverage with `TextServer.font_has_char`, and the line
  height is the chain's maximum (26 at 16 px), which leaves a 23 px line's pen at y 19.5.
- **Every fallback's cache exists from step 0, empty** (`Font::get_height` asks each fallback's
  metrics); only the pages wait for the script.
- **The hex box sits on half pixels** (y 7.5) because glyph quads floor the pen but `add_rect`s do
  not; it rasterizes by the half-open pixel-centre rule exactly.
- **Two Devanagari Labels in one frame** give a create and an update of DV's page in frame 51, and
  only the second carries anything new (KA; the i-matra glyph is shared), so the sabotage is
  LD2-only.

### What G4f does not prove

- Glyph counts for complex scripts from first principles: the oracle is their only source, and
  the hand model predicts only which caches gain glyphs.
- Autowrap, alignment or ellipses with complex scripts, RTL layout direction
  (`root_node_layout_direction` stays LTR), explicit `language` tags (`locl`), system fallback,
  colour or emoji fonts, and `RichTextLabel` spans in other scripts.
- Subpixel positioning or MSDF on the fallbacks (G4e2 owns MSDF).

## Gate 4e result (2026-10-10)

G4e2 ([protocol/gate4-design.md](protocol/gate4-design.md) "G4e2", "As built (G4e2)") passes:
`pnpm render-stream:gate4` (every landed group, g4a–g4f) is 185/185 in
`artifacts/render-stream/gate4/20261010T064607Z/`, g4e's own 43/43. Everything now runs on
[protocol/render-stream-3.md](protocol/render-stream-3.md): the capture publishes `GRS3` with the
/3 features and serves `render-stream.3`, the receiver decodes /3 and replays
`add_msdf_texture_rect_region`, and every checker decodes /3, g4d and g4f included (recordings
keep their `.rs2` names; /2 decoding remains for `golden-2/` only). The same build passed
`build-capture.sh` (11/11 ctests), `calibrate.sh --check`, gate −1 28/28 with 56 hooks
(`gate-minus1/20261010T061257Z/`), gate 0 19/19 (`gate0/20261010T061413Z/`), gate 1 65/65
(`gate1/20261010T061700Z/`), gate 2 85/85 (`gate2/20261010T062637Z/`) and gate 3 56/56 with
g3a–g3d (`gate3/20261010T063835Z/`).

What landed: the mirror's msdf tap and the `perturb-glyph` sabotage (`rs_mirror`, `hooks.cpp`,
which also records the msdf arguments in `counters.json`), the /3 session and live hub
(`rs_publish`, `rs_live`, `entry.cpp`), the receiver's msdf replay and `drop-msdf` sabotage
(`rs_applier.gd`, `receiver.gd`, `applied.json` `msdf_commands`), `fixtures/gate4-msdf/` (five
Labels on one MSDF `FontFile` with the target game's `msdf_size` 48 and `msdf_pixel_range` 24 at
16, 24, 40 and 56 px, an outline toggled on, one Label under a Node2D rotated 20° → 35° and scaled
1.5), its oracle and `make_expected.py`, group g4e in `run-gate4.sh` (legs under `<out>/msdf/`) and
`lib/gate4e-checks.ts`. Images: `msdf/reference/shots/step-{0..9}.png` and `early-{1,7}.png`,
`msdf/receiver{,-patch}/shots/`, `msdf/sabotage-perturb-glyph/receiver/shots/`,
`msdf/sabotage-receiver-drop/receiver/shots/`, `msdf/sabotage-gray-perturb-glyph/receiver/shots/`.

Every msdf command (338 over the ten settle steps × 2 sinks) equals the oracle's float32 quad and
source rect bit for bit, with `outline` 0 or 4 as its pass sets it, `px_range` 24 and
`scale = size / 48` (15 080 msdf commands on the full sink, 3 460 of them outline-pass). The one
page hashes to the oracle's dump at every step and every new version writes only empty texels
(27 049). **The MSDF budget, measured from the same-build reference repeat, is 0 in every region**,
and both receivers equal the reference exactly. Census as measured:

| step | change                         | `FM@48` (512² RGBA8)                 | msdf commands |
| ---- | ------------------------------ | ------------------------------------ | ------------- |
| 0    | everything (19 glyphs)         | create (1 048 692 B payload)         | 25            |
| 1    | `M16` "Hello Wyvern"           | 1 update                             | 31            |
| 2    | `M24` 24 → 56 px               | none                                 | 31            |
| 3    | `M40` outline 4 on             | none                                 | 37            |
| 4–6  | colour, R rotation, outline colour | none                             | 37            |
| 7    | `MT` "Jump!", `M16` "Wizard"   | 2 updates in frame 71, wire v4       | 33            |
| 8, 9 | new placement, new text        | none                                 | 31, 39        |

Cost at the hook per 1 MiB page upload: copy 0.55–0.62 ms, hash 3.0–3.4 ms (step 7's two uploads
6.0 ms of hashing). Sabotages, each exactly as predicted: `sabotage-msdf-perturb-glyph` is
`pixel-mismatch` at {1..9}, confined to the Labels that redrew after frame 11 (M16 from step 1, M24
from 2, M40 from 3, MT from 7; MR never redraws and never mismatches), with +0.25 on exactly those
Labels' 235 recorded rects; `sabotage-msdf-receiver-drop` is `pixel-mismatch` at {0..9} in every
text region and replays no msdf command; `sabotage-gray-perturb-glyph` (fixtures/gate4) is
`pixel-mismatch` at {1..9} in L1, LH, L2, L3 and LD as each redraws, a quarter pixel on the integer
path (701 px at step 1, max delta 51).

### Findings

- **One MSDF cache for every size.** The cache key is `msdf_size`, so 16, 24, 40 and 56 px and the
  outline pass share one page: a size change or an outline toggle uploads nothing. At range 24 a
  glyph cell is about 78×87 texels, so a 512² page holds about 30 glyphs.
- **perturb-glyph moves only re-recorded commands.** It acts where the mirror records, so a Label
  whose commands were recorded before the sabotage frame keeps them: the prediction is per Label
  from its first redraw, and a transform-only parent never reveals it.
- **The oracle's MSDF quads are bit-exact by construction.** The engine's getters and its draw
  scale the glyph rect the same way (Vector2 × real_t, then / real_t), so pen + offset in float32
  reproduces every command with no tolerance.
- **A dormant gate 3 test.** `rs_mirror_test`'s `test_clip_ignore_tap` (G3d) was never called from
  `main()` and had two wrong expectations; G4e2 calls it and fixed them.

### What G4e2 does not prove

- MSDF pixels against an independent synthesis: the shader's `fwidth` coverage is not modelled
  (no `expected-text-*`). The claim is atlas parity, bit-exact commands, a zero repeat budget and
  receiver equality on one GPU and driver.
- Browser receivers' MSDF (gate 7), MSDF under `canvas_items` stretch (gate 6), several MSDF pages
  or `msdf_size` 128, and the target game's own fonts (gate 8).
- Live MSDF delivery beyond the shared /3 live path (gate 1's and gate 2's live legs pass on /3,
  but no live leg draws MSDF text).

## Gate 4 summary

Gate 4 passes: `pnpm render-stream:gate4` with all groups g4a-g4f is **185/185** in
`artifacts/render-stream/gate4/20261010T075427Z/`, on the same build as gate −1
(`artifacts/render-stream/gate-minus1/20261010T072444Z/`), gate 0 19/19
(`gate0/20261010T072550Z/`), gate 1 65/65 (`gate1/20261010T072751Z/`), gate 2 85/85
(`gate2/20261010T073607Z/`) and gate 3 56/56 with g3a–g3d (`gate3/20261010T074659Z/`). Every leg
is at its expected class. Images are under each leg's `shots/` in the run directory:
`reference/shots/step-{0..9}.png`, `reference-repeat/shots/` and `reference-armed/shots/` (g4a);
`receiver/shots/` and `receiver-patch/shots/` (g4b); `layout/reference/shots/`,
`layout/receiver{,-patch}/shots/` and `layout/lcd/{reference,receiver}/shots/` (g4c);
`rich-reference/shots/step-{0..5}.png`, `rich-receiver{,-patch}/shots/` and
`rich-underline/{reference,receiver}/shots/` (g4d); `msdf/reference/shots/step-{0..9}.png` and
`msdf/receiver{,-patch}/shots/` (g4e); `i18n/reference/shots/` and `i18n/receiver{,-patch}/shots/`
(g4f).

What it proves, by increment:

- **4a.** Grayscale text needs no new capture machinery: a glyph is `add_texture_rect_region`
  naming an `ImageTexture` atlas page, already on render-stream/2. The headless host rasterizes
  atlases byte-identical to the rendered reference's, hash for hash, at every step, and every
  glyph command on the wire equals the reference's own TextServer oracle, float32-exact. The
  budget (reference against a same-build repeat) is 0.
- **4b.** The unchanged receiver — no fonts, no TextServer, never shapes — replays grayscale text:
  synthesized ink (oracle quads × atlas alpha × colour, straight-alpha blended) against both the
  reference and the receiver holds at max channel delta 1, the documented ceiling for UNORM8
  blend rounding, and never above it.
- **4c.** Layout: sizes, word and arbitrary wrap, alignment, `clip_text`, an outline and a shadow
  pass, a draw-time subpixel-`auto` font and a cache whose hinting changes mid-run, all at max
  channel delta 1 (21 386 px at delta 1, none higher). `canvas_item_add_lcd_texture_rect_region`
  (the `lcd` variant) is `unsupported`, typed, on both the capture and the receiver.
- **4d.** `RichTextLabel` spans (`[color]`, `[b]`, `[i]`, `[bgcolor]`, an outlined span) each
  upload to their own wire id and sum to the oracle's per-span glyph counts exactly, and every
  `[bgcolor]` span has its matching `add_rect`. `RichTextLabel` itself is never `leg-class`
  `success`: its per-line box-drawing pass unconditionally emits `canvas_item_add_set_transform`,
  typed `unsupported` since render-stream-0.md, independent of which spans it draws.
- **4e.** `render-stream/3` carries MSDF text (`add_msdf_texture_rect_region`) as a supported
  command; every gate now runs on it. Every msdf command matches the oracle's float32 quad and
  source rect bit for bit, with `outline`, `px_range` and `scale` as the oracle computes them; the
  one atlas page hashes to the oracle's dump at every step, and every new version writes only
  empty texels. The MSDF budget, measured from a same-build reference repeat, is 0 in every
  region, and both receivers equal the reference exactly.
- **4f.** Multilingual shaping with fallback fonts (Vazirmatn, Noto Sans Devanagari UI, Noto Sans
  Hebrew behind the pinned Open Sans): NFD composition, lam-alef ligation, an invisible ZWNJ
  glyph, Hebrew marks over their base, Devanagari conjuncts and a missing-glyph hex box all hold
  on the oracle and on both sinks, float32-exact, and each fallback's own atlas page is created
  once, in its own step.

Unsupported, each typed and never substituted: LCD subpixel text
(`canvas_item_add_lcd_texture_rect_region`, `unsupported-op`) on both capture and receiver —
its pixels depend on the host's `lcd_subpixel_layout` matching the viewer's physical panel, and
gate 7's receiver manifests decide whether it is ever supported (Deferred); `RichTextLabel` as a
whole, which classifies `unsupported` because of `canvas_item_add_set_transform` regardless of
which spans it draws; and underline/strikethrough (`add_line`) and `clip_ignore` for
`RichTextLabel`/`Tree`/`ItemList` focus outlines, both deferred to gate 5's own wire bump
(`render-stream/4`).

Costs measured in this run:

- **Atlas uploads.** A whole 256² LA8 grayscale page is 131 072 data bytes / 131 185 payload
  bytes. G4c's 320 px Label publishes two 1024² LA8 pages (4 MiB) in one frame. G4e's 512² RGBA8
  MSDF page is 1 048 692 payload bytes at create, and every later version writes only empty
  texels.
- **Copy and hash at the hook.** Grayscale and layout pages: 10–100 µs to copy, about 0.4 ms to
  hash. MSDF, per 1 MiB page: copy 0.55–0.62 ms, hash 3.0–3.4 ms (a double upload in one frame, 6.0
  ms of hashing).
- **Synthesized-ink budgets.** Grayscale, layout and multilingual text all hold at max channel
  delta 1 against D8's straight-alpha oracle synthesis (21 386 px at delta 1 in G4c, 6 312 in
  G4f), none at delta 2 or higher. MSDF's budget, measured the same way, is 0 in every region.

What gate 4 does not prove: MSDF pixels against an independent synthesis — the shader's `fwidth`
coverage is not modelled, so the claim is atlas parity, bit-exact commands, a zero repeat budget
and receiver equality on one GPU and driver, not a from-scratch render (G4e2); browser receivers'
text, including LA8 upload on WebGL and the MSDF shader (gate 7); text under `canvas_items`
stretch, where viewport oversampling follows the stretch scale (gate 6); several MSDF pages,
`msdf_size` 128, and the target game's own fonts (gate 8); live MSDF delivery beyond the shared /3
live path gates 1 and 2 already exercise; colour/emoji fonts, bitmap (`.fnt`) and `fixed_size`
fonts, left to gate 8's census of the target game; `TextEdit`/`LineEdit` carets, selection and IME
(gate 6); late-join adoption of atlases that exist before arming (gate 8); `RichTextLabel`
effects, tables, images and scrolling (gate 6's combined scene, if it uses them); atlas deltas and
hash-at-publish for versions superseded within a frame (gate 6, D9); and `clip_ignore`, underline
and strikethrough as supported commands (gate 5's own wire bump).

## Gate 5b result (2026-10-10)

G5b ([protocol/gate5-design.md](protocol/gate5-design.md) "G5b", "As built (G5b)") passes:
`pnpm render-stream:gate5 -- --legs g5b` is 15/15 in `artifacts/render-stream/gate5/20261010T074641Z/`,
on render-stream/3 after G4e2. The same build passed `build-capture.sh` (11/11 ctests), gate −1
28/28 with 56 hooks (`gate-minus1/20261010T080906Z/`), gate 0 19/19 (`gate0/20261010T081012Z/`),
gate 1 65/65 (`gate1/20261010T081219Z/`), gate 2 85/85 (`gate2/20261010T082045Z/`), gate 3 56/56
with g3a–g3d (`gate3/20261010T083111Z/`) and gate 4 185/185 with g4a–g4f (`gate4/20261010T083813Z/`), every pure self-test (gate 5's 63
assertions included) and every `make_golden.py`/`make_expected.py --check`. Nothing on the
capture, the wire or the receiver changed.

What landed: the immediate-geometry fixture (`fixtures/gate5/`, eleven regions and the marker over
ten steps), `make_expected.py` (every RenderingServer call the fixture makes and the server's
lowering of it, re-derived in float32 from the source), `scripts/lib/geometry-raster.ts` (a
pixel-centre reference rasterizer over that model: D9's replaced draw transforms, D10's
clip-ignore spans, binary16 primitive colours, nearest texture and nine-patch sampling, band
classes), and the runner, checker and self-test (`run-gate5.sh`, `check-gate5.ts`,
`lib/gate5-*.ts`, `test/self-test-gate5.ts`).

Images (under the run directory): `reference/shots/step-{0..9}.png`, and the same under
`reference-repeat/` and `reference-armed/`. Every reference shot equals `rasterizeGate5` on every
pixel the model decides: 228 246 of 230 400 per shot, 228 760 from step 8 (2 283 488 over the
run), exact where colours are flat (224 487, then 225 001), and within 1 at the gradient triangle,
the gradient polyline segment and the `.6` blend (3 759), where 23 160 pixels over the run do
differ by exactly 1. Left out per shot: 1 992 band pixels (the
antialiased diagonal, circle and rect, the thin GL line; 1 462 once L6 loses `antialiased` at
step 8) and 162 undecided ones (within 1/16 px of a boundary edge, and the stretched nine-patch's
centre pixels next to a margin; 178 from step 8). Every sub-shape is present in every shot, and
every region changes exactly at Q6b's steps: `L2` does not change at step 3, where
`Line2D.antialiased` re-records the same triangle array.

**Measured budget: 0.** The repeat and the armed reference are byte-identical to the reference
at every pixel of every shot, band pixels included (LN 8 100, CI 4 360 and RA 6 400 band
pixel-shots, all at delta 0).

Hook census as measured (`counters.json`, one call per item redraw; it equals the hand count in
every cell): `add_rect` 24, `add_line` 15, `add_polyline` 8, `add_circle` 4, `add_polygon` 7,
`add_primitive` 4, `add_triangle_array` 4, `add_nine_patch` 2, `add_set_transform` 6,
`add_clip_ignore` 2, `texture_2d_create` 3 (the hue strip, TEX16, TEX9). The three predicted
`add_multiline` calls (the dashed line) are invisible: slot 464 is unhooked until calibrator 7
(G5a). The capture classifies `unsupported` with exactly those nine ops typed, and at every settle
frame each item's commands are its calls in order (`add_rect` float32-exact, every other op an
`unsupported` command); no draw-index tie.

### Findings

- **Every engine prediction G5b can see held on the first run**: the census, the class, the
  lowering of lines (quads at half-integer edges), polylines (miter offsets of the clamped
  bisector, a closed loop, hold-last colours), circles, concave and textured polygons,
  primitives (binary16 colours on the 0.2 grid), a triangle array's `count`, draw transforms that
  replace, a clip-ignore span, nine-patch mapping, and `Line2D.antialiased` as a no-op.
- **The rasterizer needed two rules the contract did not spell out** (gate5-design.md "As built
  (G5b)"): a pixel within 1/16 px of a boundary edge is undecided on either side of it, and a
  closed strip or a fan must be welded before finding boundary edges. `make_expected.py`'s
  tie-free assertion and the self-test's hand cases caught them, not the engine.

### What G5b does not prove

- That a receiver draws any of this: on render-stream/3 the capture types every geometry op
  `unsupported`. Commands on the wire, `geometry-commands` within 2 ulp and receiver legs are G5d.
- Meshes (G5c, G5e), styleboxes and the other nine-patch modes at scale (G5g), the `canvas`
  variant's D11 refusal (G5d), and `add_multiline` capture (G5a).
- Pixel exactness on another GPU or driver: budgets and the delta-1 class are measured on one
  RTX 2060 under GLES3.

## Gate 5w result (2026-10-10)

G5w ([protocol/gate5-design.md](protocol/gate5-design.md) "G5w", "As built (G5w)") passes:
`build-capture.sh`'s ctest suite is 12/12 including the new `rs4_codec` test, all four golden
generators pass `--check` (`golden-1` 35, `golden-2` 47, `golden-3` 37, `golden-4` 51 outputs
match), the TS self-tests (`self-test-rs0.ts`, `-rs1.ts`, `-rs2.ts` — the last covering
golden-2/3/4) and both GDScript self-tests (`codec2_selftest.gd` over golden-2/3/4,
`applier2_selftest.gd` confirming no golden-3 regression). Gate 0 is 19/19
(`artifacts/render-stream/gate0/20261010T084405Z/`). Gate 2's full run (g2a,g2b,g2c,g2e) is 75/78
in `gate2/20261010T084625Z/`; its two failures are the same live-animate pin/retire check at
frame 971 ("811b615292e5 is servable, named by nothing") and did not reproduce on a same-build
rerun of just g2a,g2c (40/40 real checks, `gate2/20261010T131627Z/`) — a timing flake, not a /4
regression, since /4 never runs in gate 2. Gate 4's g4a,g4e legs are 64/64 real checks in
`gate4/20261010T131622Z/` (g4b,g4c,g4d,g4f correctly not run). Nothing on the capture, the wire or
the receiver's /2 or /3 behavior changed.

What landed: render-stream/4 ([protocol/render-stream-4.md](protocol/render-stream-4.md)), a
version-parameterized extension of `rs2_codec.*`/`rs2_diff.*` (11 new immediate/mesh draw ops, an
`i32` block kind, a mesh table parallel to the texture table) exactly as D1/Q4 describe, plus
`render-stream-2.ts`/`rs2_decoder.gd` threading a `2|3|4` version parameter throughout, a new
`rs4_codec_test.cpp` (the "C++ golden check" D1 names, standing in for G5a's mirror-driven encoder
until G5d wires it up), and one new file per side for the mesh payload format
(`scripts/lib/render-stream-mesh.ts`, `receiver/rs_mesh_payload.gd`, mirroring the GRT1 texture
payload as GRM1). `Transaction`/`Snapshot` gained their own `version` field mirroring
`Session::version`; V2 and V3 stay byte-identical in transaction shape.

`golden-4/` holds 11 states, not Q4's predicted 3 new ones (8/9/10/11 instead of 8/9/10), 1.6 MB
across 51 files — splitting "two meshes created" from "a version-only mesh change" once a third
mesh needed to go `"unsupported"` and a fourth command needed to name an unknown mesh in the same
transaction. See gate5-design.md's "As built (G5w)" note for the full rationale and two
GDScript-only pitfalls, one a ternary-into-typed-array runtime trap that silently broke every
golden-2/3 resolved-state check, not just golden-4's (recorded in
`.agents/memory/rs-gate5-g5w-gdscript-facts.md`).

### What G5w does not prove

- That a receiver draws any of this, or that capture/the live runners speak /4 at all: gate 2 and
  gate 4 run entirely on /2 and /3, unchanged by construction. Switching capture, the receiver or
  any runner to /4 is G5d's job.
- That the mesh table or GRM1 payload matches what the engine actually emits for a real
  `ArrayMesh`: G5w's encoder is hand-built from `rs2_golden_states.h`, not driven by a captured
  mirror. G5c's mesh oracle and G5a's calibrator 7 are the first contact with a live mesh.
- Pixel exactness, budgets, or any rendering at all: /4 carries commands and resources; nothing
  paints yet.

## Gate 5a result (2026-10-10)

G5a ([protocol/gate5-design.md](protocol/gate5-design.md) "G5a") passes, rebased onto G4e2 (MSDF
on render-stream/3), G5b (the gate 5 immediate-geometry fixture) and G5w (render-stream/4 codecs)
in turn: `build-capture.sh` **13/13** ctests (the new `rs4_codec` included), `scripts/calibrate.sh
--check` clean, gate −1 **28/28** with **64 hooks** planned and none omitted
(`gate-minus1/g5a-final/result.json`), gate 0 **19/19** (`gate0/20261010T133158Z`), gate 1
**65/65** (`gate1/20261010T085201Z`), gate 2 **85/85** (`gate2/20261010T131658Z`; one earlier
attempt scored 83/85 on `pins-bounded`/`obsolete-retired` under `live-animate`'s known
load-timing flake, clean on every rerun since — not a regression), gate 3 **56/56**
(`gate3/20261010T134140Z`), gate 4 **185/185** with every landed group g4a–g4f, g4e (MSDF)
included (`gate4/20261010T135125Z`) and gate 5 `--legs g5b` **15/15**
(`gate5/20261010T133647Z`, confirming the census now reports `add_multiline` instead of silently
dropping it, as G5b's own "What G5b does not prove" predicted it would once calibrator 7 landed).
Every pure self-test (checker, gate 0–4, gate 4d, gate 5, rs0–rs2, rs-ws) and every
`make_golden.py`/`make_expected.py --check` (`golden/`, `golden-1/`, `golden-2/`, `golden-3/`,
`golden-4/`, every gate 2–5 fixture) stayed clean throughout.

What landed:

- **Calibrator 7, eight new optional slots** (gate5-design.md D2, Q2), confirmed by
  `calibrate.py`/`scripts/calibrate.sh` against the pinned binary exactly as predicted:
  `canvas_item_add_multiline` 464, `canvas_item_add_particles` 477,
  `canvas_item_add_animation_slice` 480, `canvas_item_attach_skeleton` 485,
  `mesh_create_from_surfaces` 70, `mesh_surface_update_skin_region` 88,
  `mesh_surface_update_index_region` 89 and `mesh_surface_remove` 99. The committed record now
  names 65 slots (64 hooks plus the `get_default_clear_color` probe). `canvas_item_add_multiline`
  and `mesh_create_from_surfaces` close the two silent holes the contract predicted: before this,
  `draw_dashed_line`'s dashes and a loaded `ArrayMesh`'s surfaces vanished from every capture
  without a trace.
- **`abi.h`'s `SurfaceDataPrefix` grows to the full 240-byte `SurfaceData`**: `Transform3D` (48
  bytes) and `Vector4` (16 bytes) stand-ins, `lods`/`bone_aabbs` reproduced as `Vector<uint8_t>`
  (a `Vector<T>`'s own layout never depends on `T`), then `mesh_to_skeleton_xform`,
  `blend_shape_data`, `uv_scale` and `material`. Every offset (120, 136, 152, 200, 216, 232, 240)
  matches the contract's hand-derived prediction exactly; `abi_decode_test` pins all of them plus a
  round-trip decode of `blend_shape_data`/`uv_scale`/`material`.
- **`rs_mesh_payload.{h,cpp}`**: the `render-stream-mesh/1` (GRM1) encoder, D7's format
  classification (`classify_surface`: 2D positions, no compressed attributes, no `NORMAL`/
  `TANGENT`/`TEX_UV2`/custom channels, blend-shape data refused first and independently), and the
  primitive name table. `rs_mesh_payload_test` pins one literal payload (header hex, length 243,
  SHA-256) derived independently with Python, plus every refusal reason.
- **Whole-surface copy at the hook (D6)**: `mesh_add_surface`, `mesh_create_from_surfaces` and the
  four region updates now classify, copy and hash the complete surface, timed the same way
  `copy_payload` times a texture (`copy_ns`/`hash_ns` split at the encode/hash boundary). Because a
  region update only ever carries the changed bytes, `hooks.cpp` keeps its own retained-buffer
  cache (`g_mesh_buffers`, one entry per mesh RID the hook has seen, with each surface's AABB and
  `uv_scale` fixed at creation per D8) so a later update can re-encode and re-hash the whole
  surface; `mesh_surface_update_*_region` classifies each call `applied` (the common case, or
  "version + 1 only" on an already-`unsupported` surface, Q3b), `rejected` (out of bounds or
  empty, as GLES3 would refuse it) or `unknown` (an unseen mesh or surface index), gated behind the
  omit-op sabotage's hook exactly as a texture update is.
- **The mesh hook log** (`evidence/resources.jsonl`, `kind:"mesh"`, gate5-design.md Q3d): one line
  per mesh call, with its own per-session id counter from 1 (no mirror mesh table yet, as gate 2's
  log worked before G2b2) and eight new trailing columns (`surface`, `buffer`, `offset`, `bytes`,
  `primitive`, `vertex_count`, `index_count`, `outcome`), null on every non-mesh line; `format`
  shares its column with a texture line's format name (the raw `ArrayFormat` bitfield on a mesh
  line, a quoted name on a texture line — never both on the same line).
- **`rs_mirror`**: `canvas_item_add_multiline`/`_particles` go through the existing generic
  `add_unsupported` tap (zero new mirror code, clip_ignore's G3d precedent); `attach_skeleton`
  gets its own small `unsupported_skeleton` item field and `Mirror::attach_skeleton`, reported in
  `Snapshot::unsupported` exactly like a non-null material, under its own op name, never bumping
  `content_version`. A null skeleton (Polygon2D's per-draw call, and the spike's own exercise) is
  free.
- **Feature-list amendment**: `observed_unsupported_ops` gains `canvas_item_add_animation_slice`,
  `canvas_item_add_multiline`, `canvas_item_add_particles` and `canvas_item_attach_skeleton`, in
  `capture/src/rs_publish.cpp` (`gate2_features`) and its TypeScript mirror
  (`scripts/lib/gate0-checks.ts` `RS2_FEATURES`); `protocol/render-stream-3.md`'s "Features"
  section gets the amendment note. `golden-2/`, `golden-3/` and `rs_publish_test`'s golden-session
  fixtures keep their own frozen, pre-G5a copies of the list (`make_golden.py --check` stayed
  clean both before and after, unaffected since it never calls the live function).
- **`fixtures/spike/`** exercises every new hook (Q2's own list): a `draw_dashed_line` longer than
  its dash (alpha 0, so it never changes a pixel) to force `canvas_item_add_multiline` instead of
  `canvas_item_add_line`; a `draw_animation_slice` called *last* in `_draw()`, after every other
  command, because its "skipping" state is time-dependent
  (`drivers/gles3/rasterizer_canvas_gles3.cpp:1276-1282`) and reaches every later command on the
  same item; an orphan item's `particles_create()` particles and a null skeleton attach; a
  `mesh_create_from_surfaces` of one triangle; and a mesh with bones, weights and an index buffer
  exercising the new skin/index region updates and `mesh_surface_remove`.

### Findings

- **The resources.jsonl schema check is a shared, ordered key list.** `scripts/lib/gate2-checks.ts`
  `RESOURCE_LINE_KEYS` enumerates every column of a `render-stream-resource-log/1` line, in order,
  and gates 0, 2, 3 and 4 all import it. The first full run after adding the eight mesh trailing
  columns failed six checks across gate 2 (`census`, `hook-bytes-exact`, `worker-thread-create`,
  `replace-retires-temp`, `viewport-defaults`, `unsupported-variant`) with the same root cause:
  *every* `resources.jsonl` line, mesh or not, now has eight more columns, so the shared key-order
  validator rejected line 1 of every capture before any mesh-specific check even ran. Fixing
  `RESOURCE_LINE_KEYS` (and the `ResourceLine` TypeScript type, including widening `format` to
  `string | number | null`) fixed all six at once; a one-off build-capture.sh/gate −1 pass alone
  would never have caught this, because gate −1 does not read `resources.jsonl` at all.
- **A stream needs `GRC_RESOURCE_STORE_DIR`, not just `GRC_STREAM_OUT`.** Verifying the spike's
  mesh hashes by hand (gate −1's own runner never opens a stream) first refused with
  `resource-store-missing`; both env vars are required before `resources.jsonl` exists.
- **The GRM1 hashes were cross-checked independently.** A headless run of `fixtures/spike/` with a
  stream enabled produced `mesh_add_surface`/`mesh_surface_update_{skin,index}_region` lines whose
  hashes were recomputed byte-for-byte in a standalone Python script (magic, meta JSON, geometry
  block, buffers) from the same literals `spike.gd` passes: all four matched exactly, including the
  skin-region update that rewrites identical bytes (hash unchanged) and the index-region update
  that changes two bytes (hash changed, recomputed correctly). Copy/hash cost on these tiny
  surfaces (24–48 byte buffers, n=125): copy median 1220 ns (530–5070 ns), hash median 1870 ns
  (1290–3570 ns).

### What G5a does not prove

- Any wire support: every new op and the mesh table stay off `render-stream/2` and `/3` entirely
  (G5w writes `/4`, G5d switches the runners and receiver).
- A resident mirror mesh table, tombstones or budget-wide `GRC_RESOURCE_BUDGET_BYTES` enforcement
  across a whole session: the retained-buffer cache here is the hook's own, scoped to re-hashing
  after a region update, not the mirror's eventual mesh table (G5e); only the per-payload
  `GRC_RESOURCE_MAX_PAYLOAD_BYTES` cap is checked, exactly as for a texture.
- That a receiver, or anything downstream, can reproduce a mesh or the new immediate ops: nothing
  here is on any wire yet.

## Gate 5c result (2026-10-10)

G5c ([protocol/gate5-design.md](protocol/gate5-design.md) "G5c", "As built (G5c)") passes:
`pnpm render-stream:gate5 -- --legs g5b,g5c` is **33/33** in
`artifacts/render-stream/gate5/g5c-verify1/` (g5c under `mesh/`), on render-stream/3. The same
build passed `build-capture.sh` (13/13 ctests), gate −1 28/28 with 64 hooks
(`gate-minus1/g5c-verify1/`), gate 0 19/19 (`gate0/g5c-verify1/`), gate 1 65/65
(`gate1/g5c-verify1/`), gate 2 85/85 (see below), gate 3 56/56 (`gate3/g5c-verify1/`), gate 4 185/185
(`gate4/g5c-verify1/`), every pure self-test (gate 5c's included) and every
`make_golden.py`/`make_expected.py --check`. Gate 2 scored 83/85 on the first pass
(`gate2/g5c-verify1/`: `pins-bounded` and `obsolete-retired` on `live-animate` at frame 971, the
known load-timing flake) and 85/85 on its one rerun (`gate2/g5c-verify2/`). Nothing on the wire or
the receiver changed.

What landed: the mesh fixture (`fixtures/gate5-mesh/`: an `ArrayMesh` in a `MeshInstance2D`, a
raw mesh drawn once and then changed only by vertex, attribute and index region updates, a
two-surface mesh losing a surface, a geoclip-like 9×5 grid deformed every frame in spine-godot's
order and rebuilt 5×3, a `Polygon2D`, a loaded `ArrayMesh` resource and a freed mesh its item still
names), `make_expected.py` (every surface's bytes and so every GRM1 hash, the per-frame hook
census, commands, coverage, freshness, counters), the reference-side mesh oracle
(`mesh_oracle.gd`), group g5c in `run-gate5.sh` and `lib/gate5c-checks.ts`, and one capture
change: a single-surface `mesh_create_from_surfaces` log line now carries its surface's hash.

Images (under the run directory): `mesh/reference/shots/step-{0..9}.png`, and the same under
`mesh/reference-repeat/` and `mesh/reference-armed/`. Every shot equals the coverage model on all
2 143 780 decided pixels of the exact regions; `DF` is band and the repeat and the armed
reference are byte-identical to the reference everywhere (budget 0; `DF` 160 000 band
pixel-shots at delta 0). Fresh regions per step, as predicted: `RM` at 2, 3 and 4 with its
`content_version` constant over all 400 capture frames (pixels change through region updates
alone), `M2` at 6, `P2` and `FR` at 7, `MI` at 1 and 8, `DF` at every step.

Census as measured, equal to `make_expected.py`'s in every frame, on the headless capture (1 222
mesh lines over frames 1 to 400, plus 6 teardown frees at 401) and on the armed rendered reference
(328 lines to its quit frame 102). Hook-log ids are creation order: `AM1` 1, `RMS` 2, `M2` 3,
`DF` 4, `P2` 5, `LD` 6, `FM` 7, `DF2` 8. Frame 1: 6 `mesh_create`, 1 `mesh_create_from_surfaces`,
7 `mesh_add_surface`, `P2`'s `mesh_clear`. Then 11 `AM1` vertex region (v3), 21/31/41 `RMS`
vertex, attribute, index region (v3 to v5), 51 `free(DF)` at v149 + `DF2` create and add, 61
`M2` surface remove (v4), 71 `free(FM)` + `P2` clear and add (v5), 81 `AM1` clear and add (v5),
and `DF`/`DF2` three lines on every frame from 2 (`DF2` v1049 at 400). `counters.json`:
`add_mesh` 409, `mesh_surface_update_vertex_region` 400, `_attribute_region` 399,
`mesh_set_custom_aabb` 398, `attach_skeleton` 3. Hash parity: 73 surface-steps where the hook's
hash (headless capture and armed reference), the oracle's GPU readback and the model's predicted
GRM1 hash are one value; both oracle logs are byte-identical and verify the derived `Polygon2D`
RID. Median hook cost per change (tiny surfaces): copy 0.8–5.9 µs, hash 1.4–7.3 µs.

### Findings

- **Every prediction held on the first engine run**, hashes included: `make_expected.py`'s port of
  `mesh_create_surface_data_from_arrays` (float32 AABB from `Rect2(v0, CMP_EPSILON)`, truncated
  RGBA8) and of Godot's ear clipper reproduced every byte the engine stored, so the oracle, the hook
  and the model agree without either copying the other.
- **A freed mesh still named by a command draws nothing and says so**: the rendered legs print
  `ERROR: Parameter "mesh" is null.` once per frame while `FR` names freed `FM` (frames 71–80, ten
  lines); the headless capture prints nothing (the dummy renderer draws nothing).
- **`Polygon2D`'s mesh RID is not reachable from script.** The oracle derives it from the RID
  allocator's layout and verifies the result against the polygon's own bytes every time.
- **`counters.json` counts teardown**: `Polygon2D`'s destructor calls `attach_skeleton(RID())` once
  more after the quit frame.

### What G5c does not prove

- That any mesh reaches a receiver: on render-stream/3 `canvas_item_add_mesh` is a typed
  `unsupported` command and no mesh table exists. The mesh table, GRM1 on the wire, receiver
  residency and `receiver-vs-reference` on `DF` are G5e's; dropped presentations are G5f's.
- Multi-surface `mesh_create_from_surfaces` hashes in the log (still unnamed; one-surface only).
- Exactness on another GPU or driver: measured on one RTX 2060 under GLES3.

## Gate 5d result (2026-10-10)

G5d ([protocol/gate5-design.md](protocol/gate5-design.md) "G5d", "As built (G5d)") passes:
the capture, the receiver and every gate runner now speak
[render-stream/4](protocol/render-stream-4.md), and `pnpm render-stream:gate5 -- --legs
g5b,g5c,g5d` is 49/49 in `artifacts/render-stream/gate5/f2/` (ignored, not committed). On the same
build, rebased onto G5c: `build-capture.sh` 13/13 ctests, `calibrate.sh --check` clean, gate −1
28/28 with 64 hooks (`gate-minus1/f2/`), gate 0 19/19 (`gate0/f2/`), gate 1 65/65 (`gate1/f2/`),
gate 2 85/85 (`gate2/f2/`, live-animate included, no retry needed), gate 3 56/56 (`gate3/f2/`),
gate 4 185/185 (`gate4/f2/`), and after a further rebase onto gate 5.5c, gate 5.5 24/24
(`gate55/f3/`, its capture legs still `unsupported` with `canvas_item_set_material` typed on /4),
every pure self-test (gate 5's 88 assertions and gate 5c's 37
included), both receiver self-tests (`codec2_selftest.gd`, `applier2_selftest.gd`, now on
`golden-4/`) and all fifteen `make_golden.py`/`make_expected.py --check`.

What landed: the mirror records every immediate geometry op (`add_line`, `add_polyline`,
`add_multiline`, `add_circle`, `add_primitive`, `add_polygon`, `add_triangle_array`,
`add_nine_patch`), `add_set_transform` and `add_clip_ignore` as /4 commands, every array copied
whole at the hook; D11's `RID()` rule and the `perturb-vertex` sabotage; the publisher and live hub
write GRS4 with the fifteen-op features. The receiver replays each command in order with the
engine's own call and gains the `ignore-set-transform` and `ignore-clip-ignore` sabotages.
`clip-derive.ts` models D9 and D10. Group g5d adds the receiver, canvas-variant and sabotage legs
(`lib/gate5d-checks.ts`).

Images (under the run directory): `reference/shots/step-{0..9}.png` and the receivers'
`receiver/shots/seq-<n>.png` and `receiver-patch/shots/seq-<n>.png` at the settle seqs (twenty
shots, every pixel equal to the reference's, band pixels included: budget 0), and the sabotage
receivers' shots under `sabotage-*/receiver/shots/` and `sabotage-receiver-*/shots/`.

- **Commands.** All 760 settle-frame commands of both sinks equal `expected.json`'s calls,
  passthrough arguments float32-exact; not one computed argument needed its 2-ulp allowance.
  Line2D is one triangle array (6 vertices, 12 indices, count −1, identical across step 3's
  redraw), the dashed line one 16-point multiline, the unfilled rect and circle closed polylines
  of 5 and 65 points. The full sink is 4 148 170 bytes over 400 transactions, the patch sink
  259 457.
- **Clipping.** `deriveClipRects` gives CG `[344,120,408,168]` (moved at step 7, shifted at 9) and
  exactly one clip-ignored command (index 2) at every step, on both sinks and on receiver-patch's
  own state dumps, each of which equals the recording's resolved state.
- **D11.** The `canvas` variant's capture classifies `unsupported` with exactly five refusals,
  each `canvas-texture-headless`: BL's and PG's polygons, PR's primitives and triangle array, and
  Line2D's triangle array; the textured polygon, the nine-patches and every op without a texture
  argument stay commands.
- **Sabotages**, each exactly as `make_expected.py` predicts: freeze-frame @11 at steps 1..9;
  perturb-vertex @21 in LN {8,9}, PL {3..9}, PG {2..9}, PR {4..9}, CI {6..9} and L2 {3..9};
  omit-op `canvas_item_add_polygon` @21 in PG {2..9}; the receiver's ignore-set-transform in ST and
  ignore-clip-ignore in CG at every step.
- **Gates 3 and 4 flipped to `success`** (Q6g): G3d's `capture-clip-ignore` and
  `receiver-clip-ignore` (equal to the reference in every region, `ri` included), and every G4d
  leg, the underline variant included (one wide `add_line` per redraw, width 1.203125).

### Findings

- **`RichTextLabel` emits two `add_set_transform` per glyph per pass**, not one per line: the
  glyph's own transform before it and `Transform2D()` after, in the text pass and again in the
  outline pass, identity without `[fx]`, spaces and the paragraph's trailing break included. G4d's
  `RTL` carries 30, 40, 54, 68, 102 and 112 of them at steps 0–5 (`2 × glyphs`, plus `2 × 8` for the
  outlined span); gate4-design.md's G4d note is amended.
- **Gate 0's `unsupported` variant had to change**: its marker circle became a command, so the
  circle now sits inside a whole-period `draw_animation_slice`, which stays typed.
- **The snapshot needs the version stamp too**: the mirror stamps `ProtocolVersion::V4`, or
  `make_full` would encode three-block transactions under a GRS4 session.
- `golden-4/`'s state-8 triangle array (`count` 3 over 6 indices) is one the engine refuses; a
  receiver replaying it logs the engine's `count > p_indices.size()` error, harmlessly.

### What G5d does not prove

- Meshes on the wire: `add_mesh` stays a typed refusal in the capture and is skipped by the
  receiver (`mesh-not-replayed`) until G5e brings the mirror's mesh table; `capture-mesh` stays
  `unsupported`.
- Styleboxes, `TabBar`'s flipped box and the focused `RichTextLabel`'s clip-ignore pair at scale
  (G5g); live geometry through dropped presentations (G5f).
- Browser receivers (gate 7): `clip-derive.ts` leaves rects that need the server's lowering
  (antialiased lines, wide polylines, circles, meshes) unknown.
- Pixel exactness on another GPU or driver: one RTX 2060 under GLES3.

## Gate 5.5b result (2026-10-10)

G55b ([protocol/gate5_5-design.md](protocol/gate5_5-design.md) "G55b", "As built (G55b)")
passes. `pnpm render-stream:gate55 -- --legs g55b,g55c` is **52/52** in
`artifacts/render-stream/gate55/g55b-verify2/`, on render-stream/4 after G5d. It was also 52/52 on
/3 before G5d (`gate55/g55b-verify1/`), and g55b's 28 checks were 28/28 alone before the rebase
onto G55c (`gate55/g55b-run1/`). The same build passed `build-capture.sh` (13/13 ctests), gate −1
28/28 (`gate-minus1/g55b-verify2/`), every pure self-test (`self-test-gate55b.ts` 53/53) and every
`make_golden.py`/`make_expected.py --check`. No capture, wire or receiver file changed.

What landed:

- the `CanvasItemMaterial` fixture (`fixtures/gate55-cim/`) with variant `modulate`;
- `make_expected.py`, with a replay of `cim.cpp`'s shader cache, the light-mode and
  canvas-modulate rule, a Python twin of GL's blend equations, per-cell probes, the census and
  G55d's sabotage sets;
- blend modes and a target alpha depth in `scripts/lib/geometry-raster.ts`;
- `lib/gate55b-checks.ts` and `lib/gate55b-expected.ts`, and group g55b in `run-gate55.sh` and
  `check-gate55.ts`.

Images (under the run directory): `cim/reference/shots/step-{0..9}.png` and
`cim-modulate/reference/shots/step-{0..9}.png`, with the same under `reference-repeat/` and
`reference-armed/`. Every shot equals the raster on every pixel (2 304 000 per leg), alpha
included:

- Exact: 225 408 pixels per shot at step 0 and 224 640 after it, once `BD`'s strip is `mix`.
- Within 1: the `mul` region and the .6 strips. 24 672 base and 20 256 `modulate` pixel-shots
  actually differ by 1.

**Measured budget: 0.** Repeat and armed are byte-identical to the reference in both scenes.

Light modes are pixel-proven:

- `LO` (`light_only`) shows only the background until step 2.
- `LU` (`unshaded`) ignores the (1,1,0) and (0,1,1) modulates until it turns `light_only` at 3.
- `UC` changes at 6 through `use_parent_material` alone.

The `BD` alpha prediction (153) is **refuted and explained**. The strip reads (102,51,153,**170**)
because the root viewport's render target is `GL_RGB10_A2`, so alpha has 2 bits. The model
predicted 170 from the source before the run.

`counters.json`, both scenes: `canvas_item_set_material` 13, `material_set_param` 36,
`shader_set_code` 9, `shader_create_from_code` 0, `canvas_item_add_rect` 37 and
`texture_2d_create` 1, all as predicted. Calibrator 8's ops are still unhooked. Both captures
classify `unsupported`, with `canvas_item_set_material` / `unsupported-state` on exactly the items
that name a material at every settle frame, and no item's `content_version` moves but the marker's.

### Findings

- **The root render target is RGB10_A2.** Only `disabled` exposes it, by writing alpha. Every
  other blend keeps the target's alpha, and 0.2-grid colours survive the 10-bit store.
- **A `sub` of (.2,.2,.2) over (.4,.4,.4) equals the same rect without a material.** Q6b's `RC`
  and `UP` therefore needed rects that overhang onto the background to be distinguishable. Q6b's
  56 px overlays also left their region after the `BA` move and the canvas shift.
- **Q6b's `omit-op material_set_shader` set was wrong about `LO`.** The flush that rebinds it also
  frees its old shader, and the wire's free rule then gives exactly the engine's picture. Gate 3's
  marker colours collide under the modulate variant, so G55b has its own ten.

### What G55b does not prove

- The census of calibrator 8's calls (`material_create`, `shader_create`, `material_set_shader`,
  frees, `use_parent_material`, `canvas_set_modulate`). They are predicted per step in
  `expected.json` and checked once G55a's log exists.
- That any material reaches a receiver: that is G55d.
- Exactness on another GPU or driver: measured on one RTX 2060 under GLES3.

## Gate 5.5c result (2026-10-10)

G55c phase 1 ([protocol/gate5_5-design.md](protocol/gate5_5-design.md) "G55c", "As built (G55c
phase 1)") passes. `pnpm render-stream:gate55 -- --legs g55c` is **24/24** in
`artifacts/render-stream/gate55/g55c-run1/`, on the wire `main` speaks. The same build passed
`build-capture.sh` (13/13 ctests), gate −1 28/28 with 64 hooks (`gate-minus1/g55c-run1/`),
`self-test-gate55c.ts` 35/35 and `make_expected.py --check`. No capture, wire or receiver file
changed.

What landed:

- the `ShaderMaterial` fixture (`fixtures/gate55-shader/`, with synthetic shaders only);
- `make_expected.py`, which holds the calls with exact Variant values, a port of the shader
  preprocessor, a Python twin of every `fragment()`, freshness, the oracle's view, a per-frame
  census and G55e's sabotage sets;
- the material oracle (`material_oracle.gd`);
- `run-gate55.sh`, `check-gate55.ts` and `lib/gate55c-checks.ts`, group g55c.

Images (under the run directory): `shader/reference/shots/step-{0..9}.png`, the same under
`shader/reference-repeat/` and `shader/reference-armed/`, and
`shader-refused/reference/shots/step-{0..9}.png`. Every shot equals the model on every pixel
(2 304 000 per leg), refused variant included. Repeat and armed are byte-identical to the
reference, so the budget is 0. Fresh regions per step are exactly as predicted:

- `TI` at 1, 3 and 4, with every material item's `content_version` constant over all 400
  capture frames (fresh without redraw);
- `IN` at 2, `RM` at 3 and 5, `PA` at 6, `TY` at 7, `SH` at 8;
- `PH` at every step.

Measured on the reference by the oracle:

- All 320 parameter values (and 160 on `reference-refused`) equal the model's type and value,
  float32 components exact. Both reference logs are byte-identical.
- Every shader's `shader_get_code` GRP1 hash equals the model's: 170 shader-steps, `tint`
  changing at 3 only, include markers on `tint` only.

`counters.json` on the capture holds 7 `shader_create_from_code`, 1 `shader_set_code`, 417
`material_set_param` (400 of them `PH`'s) and 9 `canvas_item_set_material`. Both captures
classify `unsupported`: `canvas_item_set_material` / `unsupported-state` on exactly the 8 (refused:
13) material items. Neither prints a shader error.

### Findings

- **Canvas `instance uniform` renders in Compatibility 4.5.1.** An unset one reads back as
  `Vector4`, the `vec4` default without a colour hint, and no capture call carries it.
- **The server's shader code is not the file's text.** The preprocessor collapses every run of
  spaces and tabs to one space as well as inserting `@@>`/`@@<` include markers. The port of it
  predicted every hash.
- **`TIME`, screen texture, SDF and global uniforms can be made pixel-exact on the reference**
  (`0.0 * step(0.0, x)`), so G55e's refused receiver has an exact reference.
- **The contract's step-0 row miscounted.** It has 7 materials and 8 `canvas_item_set_material`,
  not 6 and 7. The contract's `TI` colours were off the 0.2 grid with `gain` .5 and were changed.

### Phase 2: the census against G55a's log

On G55a's shader and material hook log, three checks join g55c. With them,
`pnpm render-stream:gate55 -- --legs g55b,g55c` is **55/55** in
`artifacts/render-stream/gate55/g55c-p2/`, and gate −1 is 28/28 with 73 hooks
(`gate-minus1/g55c-p2/`).

- **`material-census`**: the log equals the census frame by frame.
  - `capture-shader`: 448 lines to frame 400, plus 13 teardown frees at 401.
  - `reference-shader-armed`: 150 lines to frame 102.
  - `capture-refused`: 463 lines.

  Every line names the right entity, version, shader, material and parameter type.
- **`shader-hook-hash-parity`**: the hook's GRP1 hash, the reference oracle's and the model's are
  one value on 230 shader-steps.
- **`shader-scan`**: the refused shaders carry exactly `shader-time`, `shader-screen-texture`,
  `shader-sdf`, `shader-global-uniform` and `shader-mode`.

Every prediction held on the first run.

### What G55c does not prove

- That any shader or material reaches a receiver: that is G55d/G55e.
- Exactness on another GPU or driver: measured on one RTX 2060 under GLES3.

## Gate 5g result (2026-10-10)

G5g ([protocol/gate5-design.md](protocol/gate5-design.md) "G5g", "As built (G5g)") passes on
render-stream/4: `pnpm render-stream:gate5` (g5b, g5c, g5d, g5g) is 78/78 in
`artifacts/render-stream/gate5/20261010T184828Z/` (g5g's 29 checks carry a `-style` suffix). The
same build passed `build-capture.sh` (13/13 ctests), gate −1 28/28 (`gate-minus1/20261010T174402Z/`),
gate 0 19/19 (`gate0/20261010T174526Z/`), gate 1 65/65 (`gate1/20261010T174807Z/`), gate 2 85/85
(`gate2/20261010T190359Z/`; the first run's `live-animate` pin replay failed 83/85 once and did not
reproduce), gate 3 56/56 (`gate3/20261010T181635Z/`), gate 4 185/185 (`gate4/20261010T182816Z/`),
gate 5.5 24/24 (`gate55/20261010T185832Z/`), every pure self-test and every
`make_golden.py`/`make_expected.py --check`.

What landed: `fixtures/gate5-style/` (nine-patch modes, `StyleBoxTexture`, five `StyleBoxFlat`
variants, the default theme's `Panel`, TabBar's flip and a focused `RichTextLabel`; its README
has the tables), `make_expected.py` (a float32 port of `StyleBoxFlat::draw`), group `g5g` in
`run-gate5.sh` (evidence under `style/`), `lib/gate5g-checks.ts`, `test/gate5g-cases.ts`, and the
receiver sabotage `RS_RECEIVER_SABOTAGE=ignore-nine-patch-axis`.

Images: `style/reference/shots/step-{0..9}.png` (and `reference-repeat/`, `reference-armed/`), and
`style/receiver/shots/seq-<n>.png` (and `receiver-patch/`, `sabotage-receiver-ignore-axis/`). Every
reference shot equals the raster on every decided pixel (225 252 per shot at step 0, 226 388 from
step 6; 37 480 of 2 259 144 used their delta of 1: the modulated texture box and the theme Panel's
`.6` fill). Both receivers are pixel-identical to the reference in every shot; the axis sabotage
mismatches exactly `NT` and `NF` at every step.

**Measured stylebox band budget: 0.** The repeat, the armed reference and both receivers equal the
reference at every pixel: `SR` 8 312, `SS` 14 800, `SK` 7 800, `DP` 7 480 and `RT` 4 672 band
pixel-shots and `NF` 1 792 undecided ones, all at delta 0.

On the wire: the capture is `success`; all 324 settle commands equal the expected calls on both
sinks float32-exact (the 2-ulp allowance for the StyleBoxFlat port's cos/sin went unused); Q1h's
counts hold on every array (8/18, 24/66, 108/318, the shadowed box 32/84, the theme Panel 72/210,
the focus box 144/432); 100 nine-patches match argument for argument; the focus box sits between
`clip_ignore(true)` and `(false)` exactly at steps 0–3, and `RT`'s derived scissor reports it
(command 1) as clip-ignored.

### Findings

- **A modulated texel between two UNORM8 levels is not rounded to nearest**: 0.2 × 0.6 (30.6/255)
  reads 30 while 0.6 × 0.6 (91.8/255) reads 92. Such texels are synthesized at delta 1.
- **The default theme is off the 0.2 grid, and its focus border is (0.8, 0.8, 0.8)**: the focus
  box draws no centre, so `style_focus_color` never shows; the box is three rings.
- **An empty `RichTextLabel` emits no `add_set_transform`**, and its hidden scrollbar has a wire id
  but no scissor.

### What G5g does not prove

- Text inside a `RichTextLabel` (its glyph transforms are G5d's measurement on `gate4-rich`).
- `StyleBoxFlat` with `blend_border`, a non-default `aa_size` or a stretch scale, and
  `StyleBoxTexture` with a region: not in the fixture.
- Pixel exactness on another GPU or driver.

## Gate 5.5w result (2026-10-10)

G55w ([protocol/gate5_5-design.md](protocol/gate5_5-design.md) "G55w") passes, rebased onto G5d
(render-stream/4 end to end): `build-capture.sh` **14/14** ctests (the new `rs5_codec` included),
all four golden generators pass `--check` (`golden-2` 47, `golden-3` 37, `golden-4` 51, `golden-5`
62 outputs match), the TS self-tests (`self-test-rs0.ts`, `-rs1.ts`, `-rs2.ts` — the last covering
golden-2/3/4/5) and both GDScript self-tests (`codec2_selftest.gd` over golden-2/3/4/5,
`applier2_selftest.gd` confirming no golden-4 regression — it still reproduces golden-4 state 8's
known engine-invalid `add_triangle_array` as a logged engine error, pre-existing since G5d, not a
regression). Gate 0 is 19/19 (`gate0/20261010T181332Z/`). Gate 4's g4a,g4e legs are 64/64 real
checks in `gate4/20261010T181941Z/` (g4b,g4c,g4d,g4f correctly not run). Gate 5's landed groups
(g5b,g5c,g5d) are 49/49 in `gate5/20261010T182749Z/`. Nothing on the capture, the wire or the
receiver's /2, /3 or /4 behavior changed.

What landed: render-stream/5 ([protocol/render-stream-5.md](protocol/render-stream-5.md)), a
version-parameterized extension of `rs2_codec.*`/`rs2_diff.*` (a shader table and a material table
each with their own id counter, the `f64` block for parameter values, a 10-float canvas, three new
item fields) exactly as D1/Q4 describe, plus `render-stream-2.ts`/`rs2_decoder.gd` threading a
`2|3|4|5` version parameter throughout (the module-wide default moved from 3 to 4 under this same
increment, since G5d landed mid-way through it and both changes touch the same default — D17), a
new `rs5_codec_test.cpp`, and one new file per side for the shader payload format
(`scripts/lib/render-stream-shader.ts`, `receiver/rs_shader_payload.gd`, mirroring GRT1/GRM1 as
GRP1). `Transaction`/`Snapshot` gained their own V5 fields mirroring `Session::version`; V2
through V4 stay byte-identical in transaction shape.

`golden-5/` holds Q4's predicted four new states (12-15), 62 files. Its states derived from
golden-4's state 8 (12 onward) patch that state's `add_triangle_array` `count` from 3 to 1 — a
local fix, in the Python generator and in a `rs5_codec_test.cpp`-local wrapper only, never in
`rs2_golden_states.h` or `rs4_codec_test.cpp` — since G5d's own landing found that exact count
engine-invalid (`count × 3` must not exceed the index count, `renderer_canvas_render.h:144`): see
render-stream-5.md's "Golden vectors" and "As built" for the rationale. The GDScript `Schema`
class's shader/material/param-entry checks needed a `code` field threaded through `fail()` and its
helpers to match render-stream-2.ts's self-coded (not generic `meta-schema`) error codes for those
three entries (memory: rs-schema-self-coded-errors).

### What G55w does not prove

- That a receiver draws any of this, or that capture/the live runners speak /5 at all: gate 0, gate
  4 and gate 5 run entirely on /2 through /4, unchanged by construction. Switching capture, the
  receiver or any runner to /5 is G55d's job.
- That the shader/material tables or GRP1 match what the engine actually emits for a real
  `ShaderMaterial`/`CanvasItemMaterial`: G55w's encoder is hand-built from golden-5's own
  generator, not driven by a captured mirror. G55a's calibrator 8 and G55b/G55c's fixtures are the
  first contact with a live shader/material.
- Pixel exactness, budgets, or any rendering at all: /5 carries tables and resources; nothing
  paints yet.

## Gate 5.5a result (2026-10-10)

G55a ([protocol/gate5_5-design.md](protocol/gate5_5-design.md) "G55a") passes, rebased in turn onto
G5d (render-stream/4 everywhere) and G55b (the `gate55-cim` fixture and its material census):
`build-capture.sh` **15/15** ctests (`rs_shader_payload` and `rs_variant` new), `scripts/
calibrate.sh --check` clean, gate −1 **28/28** with **73 hooks** planned, none omitted, and every
one of calibrator 8's nine hooks reporting a positive count (the `old-record` leg still arms a
calibrator-1 record with 65 hooks omitted), gate 0 **19/19**, gate 1 **65/65**, gate 2 **85/85**
(no `live-animate` retry needed on either rebase's run), gate 3 **56/56**, gate 4 **185/185**, gate
5 `--legs g5b,g5c,g5d` **49/49** and gate 5.5 `--legs g55b,g55c` **52/52** (confirming the census
fix below). Every pure self-test (checker, gate 0–5, gate 4d, gate 5c, gate 55b, gate 55c, rs0–rs2,
rs-ws) and every `make_golden.py`/`make_expected.py --check` (`golden/`, `golden-1/`–`golden-4/`,
every gate 2–5 and gate 55b/55c fixture) stayed clean.

What landed:

- **Calibrator 8, nine new optional slots** (gate5_5-design.md D2, Q2), confirmed by
  `calibrate.py`/`scripts/calibrate.sh` against the pinned binary exactly as the contract
  predicted: `shader_create` 53, `shader_set_default_texture_parameter` 60, `material_create` 63,
  `material_create_from_shader` 64, `material_set_shader` 65, `canvas_set_modulate` 438,
  `canvas_item_set_use_parent_material` 489, `canvas_item_set_instance_shader_parameter` 490 and
  `canvas_light_attach_to_canvas` 503. The committed record now names 74 slots (73 hooks plus the
  `get_default_clear_color` probe).
- **`rs_variant.{h,cpp}`**: D8's decode through the GDExtension interface alone
  (`variant_get_type`, `get_variant_to_type_constructor`, `variant_get_ptr_constructor`,
  `variant_get_ptr_destructor`, `string_to_utf8_chars`) — every supported scalar and packed-array
  Variant type (the `int` ±2^53 range check, `rid`'s bare id, D8's exact float64 member order for
  every matrix/vector type) and the `StringName`→`String` builtin constructor (index 2 in
  `STRING`'s registration order). No ctest here runs inside a live Godot process, so
  `rs_variant_test` builds its own fake implementation of those five interface functions (a
  test-chosen "Variant"/"StringName" representation the decoder never assumes a shape for) and
  round-trips all 29 supported types plus the catch-all `param-type`/`param-range` refusals.
- **`rs_shader_payload.{h,cpp}`**: the `render-stream-shader/1` (GRP1) encoder; the D11 token scan
  (comment- and dot-aware, typing `TIME`, `hint_screen_texture`, the `texture_sdf` family, `global
  uniform`/`instance uniform`/`light` and a non-`canvas_item` `shader_type`); and the D7
  `CanvasItemMaterial` template recognizer, independently retyped in `rs_shader_payload_test` from
  `canvas_item_material.cpp:80-137` (tabs and the missing newline before the particles block's
  `UV /=` line included) and cross-checked against all six blend modes, all three light modes and
  particles on/off.
- **Decoding added to the three existing material hooks** (`shader_create_from_code`,
  `shader_set_code`, `material_set_param`), gated behind `resources().active()` exactly as the
  texture and mesh hooks are; the decoded name/value/code never reach `counters.json` (Q2) — only
  `evidence/resources.jsonl` and, eventually, the mirror.
- **`rs_resource_log`'s own shader and material registries** (no mirror table yet, as G5a's mesh
  registry): their own per-session id counters, `kind:"shader"`/`"material"`/`"item-material"`
  lines, and nine new trailing columns (`mode`, `source`, `builtin`, `uses`, `scan_ns`, `param`,
  `type`, `n`, `decode_ns`) — `target`/`ref_id` are reused for a material's current shader exactly
  as `texture_replace` already reuses them, and `value` for a plain bool/int state value. A
  material's `status` here reflects only whether its shader RID is known (`unknown-shader`, D16);
  it is never recomputed from historical parameters as the future mirror will (D6) — this log is
  evidence for the census, never the stream. `RESOURCE_LINE_KEYS` (`gate0-checks.ts`,
  `gate2-checks.ts`), `RESOURCE_LOG_OPS` and `GATE0_HOOKS` all extended to match.
- **`canvas_item_set_material` (slot 488, hooked since calibrator 2) now logs a `kind:"item-
  material"` line too**, for the material census alone: its item field on the wire/mirror still
  waits for G55d (D2, D9); this hook gained no new state, no registry lookup result it did not
  already have, and no decoding.
- **`fixtures/spike/`** exercises all nine (Q2's own list): a `CanvasItemMaterial` with a
  `light_mode` change, recognized by D7; a default-texture parameter and an instance parameter on
  the Panel's existing `Shader`/`ShaderMaterial` (which already exercised
  `material_create_from_shader`); `use_parent_material` on a child item; a default-colour (white)
  `CanvasModulate`; and a raw `canvas_light_create` + `canvas_light_attach_to_canvas`. None of it
  draws, so `armed.png == unarmed.png` held unchanged.

### Findings

- **A `CanvasItemMaterial` built only as a local variable never gets its shader.**
  `_update_shader()` (`shader_create`/`material_set_shader`) runs on a *later* idle callback
  (`scene/register_scene_types.cpp:855`), not the frame that queues it
  (`Material::_mark_initialized`'s "straightforward conditions" branch calls `_queue_shader_change`
  synchronously, but that only adds a `SelfList` entry to `dirty_materials`). A local
  `CanvasItemMaterial.new()` inside a helper function is refcounted to zero — taking its
  `dirty_materials` entry with it — the moment that function returns, so the deferred flush never
  fires: the first full run showed `shader_create=0; material_set_shader=0` while the other seven
  calibrator-8 hooks were already positive. Keeping it as a script-level field (as `_nine_texture`/
  `_mesh`/`_multimesh` already are) fixed it on the next run.
- **`expected.json` carries the optional-hook list twice.** `optional_hooks` (gate −1's
  `older-record-loads` check, comparing against `hooks_omitted`) and
  `optional_counters_must_be_positive` (`optional-hook-counts`) are separate arrays with the same
  64 names before this change; missing the first while updating the second passed every check but
  `older-record-loads`, which is easy to miss since its own `hooks_omitted` printout looks like
  the *expected* value at a glance.
- **The GRP1 hashes were cross-checked independently**, as G5a's GRM1 hashes were. A headless run
  of `fixtures/spike/` with a stream enabled produced `shader_create_from_code`/`shader_set_code`
  lines whose hashes were recomputed byte-for-byte in a standalone Python script (magic, meta
  JSON, code bytes) from `TINT_SHADER_A`/`TINT_SHADER_B`'s own literals: both matched exactly. The
  same run's `shader_set_code` line for the CIM's shader carries
  `"builtin":{"kind":"canvas_item_material","blend_mode":"mix","light_mode":"unshaded","particles_animation":false}`
  — `mix` is `CanvasItemMaterial`'s default, `unshaded` is the one property the fixture changes.
- **G55b's own census needed one more op in the log than G55a had shipped.** `gate55-cim`'s
  `cim-material-census` check groups every `evidence/resources.jsonl` line by `op` and compares the
  counts to `expected.json`'s prediction, which (correctly) counts `canvas_item_set_material`
  alongside `material_create`/`material_set_param`/etc. since it is just as much a "material op" as
  those; G55a's own log never wrote a line for it (its item field was out of scope, D2), so the
  first `--legs g55b,g55c` run failed on exactly that one op at three windows (step 0, 4, 5) in both
  `gate55-cim` variants. Adding the line (no registry change, no decoding — `canvas_item_set_
  material` carries two RIDs, nothing to decode) fixed both legs without needing another gate
  rebuild logic change; gates 0–5 were re-run afterward to confirm the new, previously-absent line
  doesn't disturb any other fixture's census or schema checks (none do: it is purely additive).

### What G55a does not prove

- Any wire support: render-stream/4 and /5 are untouched; the shader and material tables, the
  `f64` block, and every new item/canvas field stay off every protocol version (G55w writes the
  codecs, G55d switches the runners and receiver).
- A resident mirror shader/material table, `GRC_SHADER_POLICY`'s `params`/`exclude` branches, or a
  material's `status` recomputed from more than its own shader reference: all G55d/G55e.
- That a receiver, or anything downstream, can compile a shader or apply a parameter: nothing here
  is on any wire yet.

## Gate 5e result (2026-10-10)

G5e ([protocol/gate5-design.md](protocol/gate5-design.md) "G5e", "As built (G5e)") passes: meshes
travel on render-stream/4 end to end. `pnpm render-stream:gate5` (g5b, g5c, g5d, g5e, g5g) is
**101/101** in `artifacts/render-stream/gate5/g5e-v4/` (g5e under `mesh/`; ignored, not
committed). On the same build, rebased onto G5g, G55w and G55a: `build-capture.sh` 16/16 ctests,
gate −1 28/28 (`gate-minus1/g5e-v4/`), gate 0 19/19, gate 1 65/65, gate 2 85/85, gate 3 56/56,
gate 4 185/185 (each `<gate>/g5e-v4/`), and after the last rebase onto G55c's census gate 5.5 55/55
(`gate55/g5e-v5/`); every pure self-test, the receiver self-tests (`applier2`, `codec2`, the ws/http
interop) and every `make_golden.py`/`make_expected.py --check`. One earlier pass scored gate 2 83/85
(`gate2/g5e-v1/`: the known `live-animate` frame-971 pin flake); every later pass was 85/85.

What landed: the mirror's mesh table (own id counter, versions counted as the hook log counts
them, tombstones, `unsupported`/`unknown-mesh`/`unsupported-mesh`, `perturb-vertex` on payloads);
the hook hands each GRM1 surface version it encodes to the mirror; GRM1 payloads in the store
(`.grm`, index lines typed), inline and on the live hub; the receiver's mesh residency (create,
in-place region updates of changed buffers, rebuild on a layout change, custom AABB, free) and
`add_mesh` replay, `drop-mesh-surface` and `stale-mesh`, `applied.json` /4 and state dumps with
`meshes`; `clip-derive.ts` mesh rects; group g5e (`lib/gate5e-checks.ts`).

Images (under the run directory): `mesh/reference/shots/step-{0..9}.png` against
`mesh/receiver/shots/seq-<n>.png`, `mesh/receiver-patch/shots/` and `mesh/receiver-inline/shots/`
(thirty shots, every pixel equal, `DF`'s band included), and the sabotage receivers' shots under
`mesh/sabotage-mesh-*/receiver/shots/` and `mesh/sabotage-mesh-receiver-*/shots/`.

- **Wire.** 1 200 transactions (both sinks and the inline capture) agree with the hook log at
  every frame; 219 settle surface-steps equal the oracle's GPU readback. Mesh tables: ids 1–7 at
  frame 1, `DF` (4) out and `DF2` (8) in at 51, `FM` (7) a named tombstone 71–80, gone at 81.
  `RM`'s `content_version` never changes while `RMS` changes at 21, 31, 41.
- **Bytes and cost.** The store holds 37 GRM1 payloads, 33 004 B over 400 frames (`DF`'s
  displacement repeats every 8 frames, so its hashes do too). Sinks: full 2 603 881 B, patch
  546 737 B, all-inline 2 665 222 B. Live surface bytes per step 3 532 (steps 0–4), 2 642, 2 358,
  2 074, 2 085, 2 085; per step about 31 mesh hook lines and 21 payloads made, median copy
  1.2–3.0 µs and hash 2.6–7.6 µs per payload (`g5e-v3` of the same work: 1.3–5.4 and 2.9–7.4). Each receiver: 765 upload rows, 62 504 B (8 creates,
  402 in-place updates, 3 rebuilds, 350 custom AABBs, 2 frees), 37 fetches (33 004 B) out of band,
  none inline.
- **Sabotages.** freeze-frame @11 at steps 1..9; omit-op vertex region @21 in `RM` {2..9} and `DF`
  {3..9}; perturb-vertex @21 in `RM`/`DF` {2..9}, `P2` {7..9}, `MI` {8,9}; drop-mesh-surface in
  `M2` {0..5}; stale-mesh in `MI` {1..7}, `RM` {2..9}, `DF` {0..9}.

### Findings

- **`DF`'s displacement repeats every 8 frames**, so stale vertices can look right: omitting
  vertex updates from frame 21 leaves `DF` correct at step 2 (frame 28 ≡ 20 mod 8). Q6d's {2..9}
  was wrong; `make_expected.py` now derives the set from its byte model.
- **Host sabotages diverge from the hook log by design** (freeze republishes the frame-10 table,
  perturb-vertex re-hashes), so D15's `mesh-log-divergence` classifies the honest legs and a
  `sabotage-mesh-log-signature` check proves each sabotage's own divergence.

### What G5e does not prove

- Meshes through dropped presentations and live HTTP fetches of GRM1 (G5f).
- Multi-surface `mesh_create_from_surfaces` hashes in the hook log (the mirror carries them).
- Item-rect caching across a custom-AABB change without a redraw (Q1f), browser receivers (gate
  7), and exactness on another GPU or driver.

## Gate 5.5d result (2026-10-11)

G55d ([protocol/gate5_5-design.md](protocol/gate5_5-design.md) "G55d", "As built (G55d)") passes:
the capture, the receiver and every gate runner speak
[render-stream/5](protocol/render-stream-5.md), and `CanvasItemMaterial` blend and light modes
travel end to end. `pnpm render-stream:gate55 -- --legs g55b,g55c,g55d` is **90/90**, first in
`artifacts/render-stream/gate55/20261011T034704Z/` and again on the final, merged build in
`gate55/20261011T091759Z/` (ignored, not committed).

**Final build (merged with `main` at 22909275: G5f and the gate 6 tools).** `build-capture.sh`
17/17 ctests, every pure self-test (`self-test-report` included) and the receiver self-tests
(`codec2`, `applier2`, ws/http interop). Each gate's run directory:

| gate | result | run directory |
| --- | --- | --- |
| −1 | 28/28 | `gate-minus1/20261011T083309Z/` |
| 0 | 24/24 | `gate0/20261011T083424Z/` |
| 1 | 65/65 | `gate1/20261011T084517Z/` |
| 2 | 85/85 | `gate2/20261011T093608Z/` |
| 3 | 56/56 | `gate3/20261011T083311Z/` |
| 4 | 185/185 | `gate4/20261011T084519Z/` |
| 5 (g5b–g5g, G5f's live legs included) | 116/116 | `gate5/20261011T081217Z/` |

The first gate 2 pass of the final build scored 83/85 (`gate2/20261011T090459Z/`) on the known
`live-animate` frame-971 pin. Before the merge, the same work passed:

| gate | result | run directory |
| --- | --- | --- |
| −1 | 28/28 | `gate-minus1/20261011T041335Z/` |
| 0 | 24/24 | `gate0/20261011T041337Z/` |
| 1 | 65/65 | `gate1/20261011T045413Z/` |
| 2 | 85/85 | `gate2/20261011T050522Z/` |
| 3 | 56/56 | `gate3/20261011T041955Z/` |
| 4 | 185/185 | `gate4/20261011T045414Z/` |
| 5 (g5b–g5e, g5g) | 101/101 | `gate5/20261011T042938Z/` |

The first pre-merge gate 1 pass scored 63/65 (`gate1/20261011T041954Z/`). Its live checker still
expected subprotocol `render-stream.4`, and its receiver-state comparison did not carry the new
tables.

What landed:

- **The mirror.** The capture now keeps a shader table and a material table (Q3b), each with its
  own id counter. Versions count as the hook log counts them, and there are no tombstones: freeing a
  shader nulls every material that names it, and freeing a material nulls every item that names it.
- **Item and canvas state.** Items carry `material`, `use_parent_material` and `instance_params`, and
  canvases carry their modulate. The derived entries `unsupported-material` (from the effective
  material), `unknown-material` and `param-type` are emitted, and so is the sticky `canvas-light`
  entry.
- **Policy, sabotage and payloads.** `GRC_SHADER_POLICY` and `perturb-shader` are wired. GRP1 code
  payloads go to the store (`.grp`, `shader-code` index lines), to inline records and to the live
  hub. Every snapshot is stamped V5.
- **The receiver.** It follows Q5: shaders compile through `shader_create` plus `shader_set_code`
  from verified GRP1 code, materials and their parameters are rebuilt as exact Variant types, and
  items and canvas 1 get their material fields and modulate. It also gains `ignore-material`,
  `ignore-canvas-modulate` and `stale-param`, `applied.json` /5 and /5 state dumps.
- **The g55d group.** `lib/gate55d-checks.ts` and `lib/gate55-wire.ts` hold its checks.

Legs and classes (gate55-cim, both scenes under `cim/` and `cim-modulate/`):

| leg | class |
| --- | --- |
| `capture-cim`, `capture-cim-modulate` | `success` (both sinks and the store) |
| `capture-cim-inline`, `capture-cim-modulate-inline` | `success` (every payload inline, GRP1 included) |
| `receiver-cim{,-patch,-inline}`, `receiver-cim-modulate{,-patch,-inline}` | `success`, every pixel equal to the reference |
| `sabotage-cim-freeze` | `pixel-mismatch`: marker {1..9}, `BD` {1..9}, `LO` {2..9}, `LU` {3..9}, `RC` {4..9}, `UP` {6..9}, `BA` {7..9}, every other region {9} |
| `sabotage-cim-omit-material-set-shader` | `pixel-mismatch`: `LU` {3..9}, `RC` {5..9}, `UP` {8,9} |
| `sabotage-cim-receiver-ignore-material` | `pixel-mismatch`: `BA`, `BS`, `BU`, `BP`, `UP` {0..9}, `BD` {0}, `LO` {0,1}, `LU` {3..9}, `RC` all but {4}; `BM` and `LM` never |
| `sabotage-cim-modulate-receiver-ignore-canvas-modulate` | `pixel-mismatch`: every region and the marker {0..7}, `LO` {2..7}, `LU` never |
| `capture-shader` (g55c) | `success` on /5 (G55e adds its receivers) |
| `capture-refused` (g55c) | `unsupported`: `unsupported-material` on the five refused items only |

Images, all under the run directory:

- `cim/reference/shots/step-{0..9}.png` against `cim/receiver/shots/seq-<n>.png`, with
  `receiver-patch/` and `receiver-inline/` beside it;
- the same for `cim-modulate/`, where `seq-28.png` shows the (0,1,1) canvas modulate, `LU`
  unshaded and `LO` visible;
- the sabotages' shots under `cim/sabotage-*/receiver/shots/`, `cim/sabotage-receiver-*/shots/` and
  `cim-modulate/sabotage-receiver-*/shots/`.

- **Wire.** At every transaction of both sinks, and of the inline capture, the shader and material
  tables equal the hook log replayed to the end of that frame (`material-commands`). Each item
  reaches CimSim's builtin blend and light mode through item → parent → material → shader at every
  settle frame (`builtin-modes`). Each table event lands in exactly one patch transaction
  (`material-census-wire`):
  - the frees of the disabled, light_only and unshaded shaders at 11, 21 and 31;
  - shader 9 at 31;
  - `RI`'s material 11 leaving at 41;
  - material 12 at 51.

  `UC`'s `use_parent_material` flips at 61 with no redraw (`fresh-without-redraw`). There is no
  shader or material traffic at steps 7 and 9 (`resource-quiet`).
- **Bytes and cost.**
  - **Store:** 8 GRP1 payloads, 1 578 B; every CIM shader is 193 B, 142 B of code.
  - **`param_f64`:** 264 B in a full transaction (33 parameters), 24 B in a patch carrying one material.
  - **Sinks over 400 frames:** full 7 268 953 B, patch 313 752 B, all-inline 7 291 423 B.
  - **Hook cost at step 0** (8 shaders, 36 parameters): copy 7.0 µs, hash 9.7 µs, scan 13.3 µs and
    decode 3.1 µs in total. Step 3's new shader costs 3.1, 2.0 and 2.8 µs.
  - **Each receiver:** creates 9 shaders and 12 materials, sets 36 parameters and fetches 8 payloads
    out of band (none inline). Step 0 costs 398 RS calls, 60 of them material calls.

### Findings

- **The /5 receiver tipped G5f's live legs into a phase lock, and a decoder fix brought them back.**
  After the merge, every branch run of `--legs g5c,g5f` failed some g5f check, a different one
  each time: `pins-bounded`/`obsolete-retired` at frame 851, `warm-host-no-gets`, or the
  stale-coalesce leg's step 1. Main's code passed 2/2 on the same machine (A/B runs in this
  session's scratchpad). The /5 receiver cost about 150 µs more per transaction: in a headless
  benchmark over the same recording, `decode_record` took 684 → 729 µs, `needed()` 13 µs more and
  `apply_state` 32 µs more. That was enough to push the 60 Hz credit loop into a stable
  every-other-frame lock (`coalesced` 290–400 instead of 0–11). The warm leg then saw a different
  set of `DF` phases than the cold one.

  Most of `decode_record`'s time was a per-byte GDScript loop that checks the meta is printable
  ASCII. It now does a native Latin-1 decode plus one regex search, and the loop runs only to name
  the bad byte of a record that has one. That saves 170 µs per transaction and makes the receiver
  faster than main's. g5f then passed alone (`--legs g5c,g5f`) and in the full gate 5 run
  (116/116).
- **The hook log has to apply D5 too.** A CIM flush frees the old shader while its material still
  names it, then binds the new one. The mirror nulls the material at version + 1 on the free, and the
  G55a log did not, so the log's versions trailed the wire's by one after steps 1–3. The log now
  applies the rule silently, with no line of its own, and readers replay it from the `free` line.
- **G55w's validators derived `unsupported-material` from the item's own material.** D9 says the
  effective one, which is what the mirror emits. Both validators (TS and GDScript) now walk
  `use_parent_material`.
- **`rs::DecodedParam` could not tell a `Vector2` from a `PackedVector2Array`.** Both reported
  `"vector2"`. It now has a `packed` flag.

### Deviations from the contract

As built (G55d) 3–8 in the design doc: the `exclude` policy is `withheld` and a D11 reason wins;
`RID()` parameters are erased; code with no known `shader_type` is refused with `shader-mode`;
`canvas-light` keeps first-observed order after `degenerate-host-size`; the receiver's conservative
choices (it never creates an unsupported material, sets the modulate only when it differs, and
already has `stale-param`); and g55d reuses g55b's legs and adds three checks
(`canvas-modulate-wire`, `shader-store`, `receiver-state-dumps`).

### What G55d does not prove

- `ShaderMaterial` on a receiver: instance parameters, default and parameter textures, packed
  arrays, the `params`/`exclude` policies and `perturb-shader` (G55e). The capture carries them, but no
  receiver leg replays them yet.
- Materials through a stall or over live HTTP (G55f), late-join materials and the process-global CIM
  shader cache (gate 8), and browser receivers (gate 7).
- `Light2D`: typed only (`canvas-light`). Exactness on another GPU or driver.

## Gate 5.5e result (2026-10-11)

G55e ([protocol/gate5_5-design.md](protocol/gate5_5-design.md) "G55e", "As built (G55e)") passes:
`ShaderMaterial` travels end to end on render-stream/5. Native receivers compile the captured
GRP1 code and rebuild every parameter. The `params` policy keeps all code off the stream, and the
`exclude` policy refuses the shaders. Every sabotage mismatches in exactly its predicted regions.
`pnpm render-stream:gate55 -- --legs g55b,g55c,g55d,g55e` is **115/115** in
`artifacts/render-stream/gate55/run1/` (ignored, not committed). The discovery run
(`gate55/disc1/`, `--legs g55c,g55e`) failed one check, the freeze leg's marker (Findings), and
nothing else.

| gate | result | run directory |
| --- | --- | --- |
| 5.5 (g55b–g55e) | 115/115 | `gate55/run1/` |
| −1 | 28/28 | `gate-minus1/run1/` |
| 0 | 24/24 | `gate0/run1/` |
| 1 | 65/65 | `gate1/run1/` |
| 2 | 85/85 | `gate2/run1/` |

Gate 5 was not rerun: G55e changes no capture, receiver, codec or publisher file. The pure
self-tests `self-test-gate55b` to `-e` pass (54, 53, 64 and 38 assertions), and so do both
`make_expected.py --check` runs.

What landed:

- **The g55e group.** `run-gate55.sh` `run_g55e` drives the legs. `lib/gate55e-checks.ts` holds
  the checks and `test/self-test-gate55e.ts` tests them. g55e reuses g55c's captures, references
  and oracle, so `--legs g55e` adds g55c.
- **The model.** `make_expected.py` gains `receiver_views`: what `receiver-refused` and
  `receiver-params-nolib` draw, which is items with no material. It also gains both typed legs'
  region sets, and the freeze set now includes the marker.
- **No engine code.** G55d's mirror and receiver already carried and replayed the whole shader
  fixture: instance parameters, the default and parameter textures, the packed array, the library,
  `stale-param` and `perturb-shader`.

Legs and classes (`gate55-shader`; g55c's `capture-shader`/`capture-refused` are the same runs):

| leg | class |
| --- | --- |
| `capture-shader` (g55c) | `success` |
| `capture-shader-inline` | `success`: every payload inline, GRP1 included |
| `capture-refused` (g55c) | `unsupported`: `unsupported-material` on `TM`, `SC`, `SD`, `GU` and `SP`, with their shaders `shader-time`, `shader-screen-texture`, `shader-sdf`, `shader-global-uniform` and `shader-mode` |
| `capture-policy-params` | `success`: every fixture shader `ok` and `withheld` |
| `capture-policy-exclude` | `unsupported`: every fixture shader `shader-excluded`, `unsupported-material` on the eight items with a ShaderMaterial |
| `receiver-shader{,-patch,-inline}` | `success`, every pixel equal to the reference |
| `receiver-params-lib` | `success`, every pixel equal to the reference, all code from the oracle's library |
| `receiver-refused` | `unsupported` (five typed items): `TM`, `SC`, `SD`, `GU` drawn with no material at every step, exactly the receiver view's raster |
| `receiver-params-nolib` | `unsupported` (8 × `shader-withheld`): every item drawn with no material, matching the receiver view's raster; mismatches are the `ignore-material` set |
| `sabotage-shader-freeze` | `pixel-mismatch`: marker {1..9}, `TI` {1..9}, `IN` {2..9}, `PH` {1,3,4,6,7,9}, `RM` {3,4,9}, `PA` {6..9}, `TY` {7..9}, `SH` {8,9} |
| `sabotage-shader-omit-param` | `pixel-mismatch`: `PH` {2,4,5,7,8}, `TI` {4..9}, `RM` {5..9}, `PA` {6..9}, `TY` {7..9} |
| `sabotage-shader-perturb-shader` | `pixel-mismatch`: `TI`, `RM` {3..9}, `SH` {8,9}. Shaders made at frame 1 never move |
| `sabotage-shader-receiver-ignore-material` | `pixel-mismatch`: `TI`, `IN`, `TY`, `PH`, `RM`, `SH` {0..9}, `PA` {6..9} |
| `sabotage-shader-receiver-stale-param` | `pixel-mismatch`: `PH` {0..9}, `TI` {1..9}, `PA` {6..9}, `TY` {7..9}, `RM` never |

Images, all under the run directory:

- `shader/reference/shots/step-{0..9}.png` against `shader/receiver/shots/seq-<n>.png`, with
  `receiver-patch/`, `receiver-inline/` and `shader-policy-params/receiver-lib/` beside it;
- `shader-refused/reference/shots/` against `shader-refused/receiver/shots/` (the four refused
  regions in their plain (.4,.6,.2) rect);
- `shader-policy-params/receiver-nolib/shots/` (every item without its material);
- the sabotages under `shader/sabotage-*/receiver/shots/` and `shader/sabotage-receiver-*/shots/`.

Checks:

- **Parity with the reference's own state.** The reference oracle reads the reference's state
  back through the RenderingServer.
  - `shader-hash-parity`: at every settle step, every live oracle shader hash (`shader_get_code`)
    is the hash of exactly one wire shader entry. 580 shader-steps hold this over six sinks: both
    sinks of `capture-shader` and `capture-policy-params`, the inline capture, and
    `capture-policy-exclude`, whose withheld entries keep their hash. The refused variant holds it
    against its own oracle. The pairing is the creation order (`pal` 1 … `sh_b` 7) and never
    moves: `tint` keeps id 2 across step 3's code change.
  - `param-parity`: 1 264 parameter values have the oracle's Variant type and value exactly (the
    float64 `gain` and `f`, float32 colours and vectors, `vector2i`, the packed float32 array,
    bool, int). `MP.pal` names the fixture texture whose GRT1 pixels the wire's texture id carries.
    Erased and unset parameters are absent. I2's unset instance parameter (16 settle-steps) is
    exempt: the oracle reads it as the uniform's `Vector4` default.
- **Tables.** `shader-material-commands` holds over 54 800 table entries on ten sinks, with D4
  applied to the hook log's view. `shader-store` finds 8 GRP1 payloads in 1 755 B.
  `shader-receiver-state-dumps` finds 10 dumps equal.
- **Policy.** `shader-policy-respected` covers the `params` and `exclude` captures. Each has 4 800
  withheld shader entries. Its store holds no `.grp` and no `shader-code` line, and the inline
  records carry no shader payload. Fifteen files per capture contain neither the GRP1 magic,
  `shader_type`, nor any of the library's eight codes: both recordings, the store, `evidence/`
  with the hook log, and stdout. The same scan finds 24 hits in `capture-shader`.
- **Receivers.** `shader-receiver-typed`: honest receivers type nothing. `receiver-refused` types
  exactly the five refused items. `receiver-params-nolib` types one `shader-withheld` per resident
  (id, hash) pair (8) and sets no code. `receiver-params-lib` sets 8 codes and fetches nothing.

Bytes and cost (`capture-shader`, `materials.gate55-shader.g55e.per_step` in `result.json`):

| step | GRP1 code B first published | `param_f64` B (patch sink, window) | hook copy / hash / scan ns | parameter decode ns | receiver material calls / RS calls |
| --- | --- | --- | --- | --- | --- |
| 0 | 1 311 (6 shaders) | 328 | 9 490 / 7 840 / 10 990 | 10 190 | 41 / 187 |
| 1 | 0 | 120 | 0 | 6 430 | 11 / 13 |
| 2 | 0 | 112 | 0 | 5 950 | 11 / 13 |
| 3 | 313 (`tint_b`) | 80 | 2 550 / 10 370 / 3 780 | 3 340 | 11 / 13 |
| 4 | 0 | 112 | 0 | 3 780 | 11 / 13 |
| 5 | 0 | 112 | 0 | 4 850 | 12 / 17 |
| 6 | 0 | 112 | 0 | 4 020 | 11 / 14 |
| 7 | 0 | 192 | 0 | 4 260 | 12 / 14 |
| 8 | 131 (`sh_b`) | 80 | 2 660 / 2 150 / 2 250 | 4 030 | 12 / 16 |
| 9 (frames 91–400) | 0 | 2 480 | 0 | 123 719 | 310 / 313 |

- **`param_f64`.** A full transaction carries 256–288 B (32–36 values). `PH`'s per-frame `phase`
  costs 8 B per patch and about 0.4 µs of hook decode per frame. A step-3 hash of 10.4 µs against
  3.1 µs in the discovery run is timing noise on one call.
- **Sinks over 400 frames.**
  - `capture-shader`: full 3 719 755 B, patch 363 855 B.
  - All-inline: full 3 745 028 B, patch 389 128 B.
  - `params`: full 3 722 155 B (+6 B per full transaction, for `"withheld"` against `"payload"`),
    patch 363 863 B.
  - `exclude`: full 4 014 557 B, patch 603 640 B. Every patch repeats the eight
    `unsupported-material` entries.
- **Each honest receiver** creates 7 shaders and 8 materials, and sets 8 codes, 417 parameters and
  2 instance parameters. Fetches: 8 from the store, 0 inline, 0 with the library.
- **The `params` receivers.** `receiver-params-lib` costs the same RS calls as `receiver-shader`
  (187 at step 0). `receiver-params-nolib` costs 167: it creates no shader but still makes all 8
  materials and sets all 417 parameters.

### Findings

- **G55c's sabotage sets left the marker out.** `make_expected.py`'s `diff_sets` skipped the
  `Marker` region in every prediction. Under `freeze-frame` the marker shows step 0's colour from
  step 1 on, as Q6c says, so the freeze leg failed on its first run with the marker as the only
  extra region. No other view moves the marker, so `diff_sets` now compares every region.
- **The hook log stays policy-blind.** Its shader lines say `source: "payload"` under every policy,
  because D4 is applied at publication, not at the hook. A reader comparing the log with the wire
  applies D4 to the log's view first (`applyPolicyToLog`). The log still carries no code, only
  hashes. The scan proves it for both policies.
- **`params` is not a typed capture.** A withheld shader is `ok`, so `capture-policy-params`
  classifies `success`. The refusal is the receiver's: `shader-withheld` in `applied.json`. A
  material whose shader is skipped draws as none, so `receiver-params-nolib` is exactly the
  `ignore-material` picture.
- **No engine change.** The first engine run passed every g55e check but the marker one, so G55d's
  mirror and receiver needed nothing for `ShaderMaterial`. The receiver's per-transaction path is
  unchanged, so G5f's live timing (G55d's finding) is not at risk.

### Deviations from the contract

As built (G55e) 2–7 in the design doc:

- `capture-policy-params` is `success`, and the receiver types `shader-withheld`.
- The checker applies D4 to the hook log's view.
- The marker is in the freeze set.
- `expected.json` gains `receiver_views`.
- The library is a copy of the reference oracle's dump.
- Check ids carry `shader-`, and six checks were added (`shader-material-commands`,
  `shader-store`, `shader-expected-image-receiver`, `shader-receiver-state-dumps`,
  `shader-receiver-typed`, `g55e-capture-log-clean`).

### What G55e does not prove

- Shaders and parameters through a stall or over live HTTP: G55f.
- `TIME`, the screen texture, SDF and global uniforms on a receiver. They stay typed.
- Late-join materials, which are gate 8's.
- Browser and web-export receivers (gate 7).
- Exactness on another GPU or driver.
- The library's provenance. It is trusted by hash only: the receiver verifies each GRP1 file
  against the wire hash, but does not check where the file came from.

## Gate 5.5f result (2026-10-11)

G55f ([protocol/gate5_5-design.md](protocol/gate5_5-design.md) "G55f") passes: live `ShaderMaterial`
parameters and code survive a dropped presentation, and gate 5.5 is complete. No capture-side
(C++) or receiver-side (GDScript) change was needed — exactly G5f's finding
(gate5-design.md "G5f"), since `GRC_SABOTAGE=stale-coalesce`, the pin/retire/HTTP machinery and
`fixtures/gate55-shader`'s own `RS_FIXTURE_START_FRAME`/`_STEP_FRAMES`/`_QUIT_FRAME` handling are
already generic over resource kind. The whole increment is runner (`run-gate55.sh`'s new
`run_g55f`, plus `REFERENCE_START_FRAME`/`_STEP_FRAMES`/`_QUIT_FRAME` added to `run_reference`)
and checker (`lib/gate55f-checks.ts`) wiring onto gate 1's G1d stall report and gate 2's live
pin/retire/HTTP checks, generalized to GRP1 shader-code hashes
(`okShaderHashes`/`shaderTableHashes`, gate2c-checks.ts). `pnpm render-stream:gate55 -- --legs
g55b,g55c,g55d,g55e,g55f` is **130/130** in `artifacts/render-stream/gate55/20261011T112118Z/`
(g55f's evidence under `shader-live/<leg>/`; ignored, not committed). On the same build: gate −1
PASS (`gate-minus1/20261011T112145Z/`), gate 0 PASS (`gate0/20261011T112300Z/`), gate 1 65/65
(`gate1/20261011T112614Z/`), gate 2 85/85 (`gate2/20261011T113612Z/`) — no regression.

**The live timeline** is gate 1's and G5f's exact pattern, reused unchanged: S=300, N=60, the
shader fixture's own `LAST_STEP`=9, quit=851. Four legs, each its own host and receiver on
`fixtures/gate55-shader`: `live-shader` (fresh cache), `live-shader-warm` (a new host and receiver
on `live-shader`'s cache, mode warm), `live-shader-stall` (`RS_RECEIVER_STALL=1:2000` after step
1), and `sabotage-shader-stale-coalesce` (the same stall, host `GRC_SABOTAGE=stale-coalesce` from
step 1's frame). A fifth rendered run, `reference-live`, is the shader fixture at this *same* live
timeline with the capture extension absent — the ground truth every leg's shots are compared
against.

| Leg | Class | Exit |
| --- | --- | --- |
| `live-shader` | `success` | 0 |
| `live-shader-warm` | `success` | 0 |
| `live-shader-stall` | `success` | 0 |
| `sabotage-shader-stale-coalesce` | `pixel-mismatch` | 0 |

Measured stall timing (both stalling legs, independently): send frame 367, credit frame 488–489
(121–122 frames at a 2000 ms request — matching memory `rs-g1d-stall-facts`'s gate-1 numbers
almost exactly), the post-stall shot landing in step 3's window (step 2's window lies wholly
inside the stall and has no shot at all, by design). `live-shader-stall`'s recovery transaction
(seq 317, frame 488) resolves to exactly the host's own full file recording at frame 488 — the
newest state (`phase` and the `tint_b` code hash both included in that one proof), not a missed
one; only the one shader-kind fetch tied to that seq names a hash, and it is the newest one.
`sabotage-shader-stale-coalesce`'s recovery transaction (seq 312, frame 489) is labelled
`stale_from: 368` and does **not** equal the host's full recording there; its step-3 shot
mismatches `reference-live` exactly in `IN`, `Marker`, `PH`, `RM` and `TI` — every region
`expected.json`'s per-step `fresh` table says steps 2 and 3 (both swallowed by the stall) touch,
not only `PH`, the one region that changes every frame (memory
`rs-g55f-stale-coalesce-region-set`).

**Checks** (`lib/gate55f-checks.ts`, all passing): `live-tap-equals-received`,
`live-resolves-to-recording` (2225 live transactions equal the host recordings),
`pins-bounded`/`obsolete-retired` (replayed from the pin/retire lines against the full recording's
`okImageHashes ∪ okShaderHashes`, since the fixture also serves TEX16/TEX16B and the engine's hue
strip over the same mechanism; retained max 9–10 hashes, 22.9–23.2 KB), `http-gets-match-fetches`
(20 GETs total: `live-shader` 10, `live-shader-warm` 0, `live-shader-stall` 10, every one a
verified 200 with the right headers), `gets-advertised`, `fetch-before-applied`,
`shader-fetches-latest-only` (the recovery transaction equals the host's newest; the one
shader-kind fetch tied to its seq names only a hash the newest state holds),
`receiver-vs-reference` (`live-shader` 10/10, `live-shader-warm` 10/10, `live-shader-stall` 9/9,
`sabotage-shader-stale-coalesce` 8/8 — each leg's own stall-window step excluded, a `PH`-only
difference tolerated when the wire's own state at that frame equals the host's full recording
there), `stale-coalesce` (the region set above), `warm-host-no-gets` (0 GETs, 10 cache hits, shots
equal `reference-live`'s), and `leg-class-*` for all four legs.

Images (under the run directory): `shader-live/reference-live/shots/step-{0..9}.png` against
`shader-live/live-shader/receiver/shots/seq-<n>.png`, `shader-live/live-shader-warm/receiver/shots/`
and `shader-live/live-shader-stall/receiver/shots/` (step 2 absent, swallowed by the stall), and
`shader-live/sabotage-shader-stale-coalesce/receiver/shots/seq-312.png` (step 3, the stale shot)
against `shader-live/live-shader-stall/receiver/shots/seq-317.png` (step 3, the healthy recovery)
and `shader-live/reference-live/shots/step-3.png`.

### Findings

- **The design doc's own G55f text undersold the stale-coalesce mismatch.** It named `PH` and `TI`;
  the measured set is `IN`, `Marker`, `PH`, `RM` and `TI`. Step 2 (`I2.inst_color`) and step 3
  (`tint.code → tint_b`, shared by `TI`'s and `RM`'s materials) are both swallowed by the stall,
  and this fixture's marker is `fresh` at *every* step (unlike `fixtures/gate5-mesh`'s), unlike
  `gate5-mesh`'s G5f, where the swallowed steps' own regions happened to be narrower. The checker
  derives the expected set generically from `expected.json`'s per-step `fresh` table unioned over
  `StallReport.steps_applied_during` — the same rule memory `rs-g5f-live-mesh-facts` established
  and warned not to replace with a hardcoded guess — never from this section's or the contract's
  own prediction. See memory `rs-g55f-stale-coalesce-region-set`.
- **"Only the newest hash is fetched" must scope to the recovery seq, not the whole leg.** A
  fresh-cache receiver legitimately fetches the other five shaders' GRP1 hashes earlier in the run
  (the step-0 bootstrap), unrelated to the stall; comparing the whole leg's fetched-hash set
  against "the newest state's hashes" fails on every real run for that reason alone.
- **Pins, retirement and GET-advertising must union image and shader hashes.** The shader fixture
  also serves TEX16 and TEX16B (drawn by `PA`) and the engine's default-theme hue strip over the
  identical resource mechanism; `okImageHashes(t) ∪ okShaderHashes(t)` feeds the generalized
  `pinsReport`/`unadvertisedGets`, the same shape G5f established for `okImageHashes ∪
  okMeshHashes`.

### What G55f does not prove

- Resource pinning or retirement at a budget tight enough to actually evict something (the shader
  fixture's live retained set never exceeded 10 hashes / 23.2 KB over an 851-frame run).
  Reconnect, resync, or a killed live-shader receiver (gate 1's G1d already proves the mechanism;
  G55f reuses it unchanged).
- A second resource kind changing every frame at once (only `PH` churns continuously here); a
  frame-exact ground truth for a region whose *reference* also depends on continuous time (G55f's
  `benign` rule needs the wire, not a synthesized image, specifically because of this).
- `TIME`, the screen texture, SDF and global uniforms live (they stay typed, as in G55e).
- Browser receivers (gate 7), non-loopback serving and late join (gate 8), and exactness on
  another GPU or driver.

## Gate 5.5 summary

Gate 5.5 passes: every increment from G55a through G55f lands, every gate from −1 through 5.5 now
runs on [render-stream/5](protocol/render-stream-5.md), and `pnpm render-stream:gate55 -- --legs
g55b,g55c,g55d,g55e,g55f` is **130/130** in `artifacts/render-stream/gate55/20261011T112118Z/`, on
the same build as gate −1 PASS (`gate-minus1/20261011T112145Z/`), gate 0 PASS
(`gate0/20261011T112300Z/`), gate 1 65/65 (`gate1/20261011T112614Z/`) and gate 2 85/85
(`gate2/20261011T113612Z/`). Every leg is at its expected class; images are under each leg's
`shots/` in the run directory, and the references are `reference/shots/step-{0..9}.png` for the
batch timeline (`cim/`, `cim-modulate/`, `shader/`, `shader-refused/`) and
`shader-live/reference-live/shots/` for G55f's own live timeline.

What it proves, by increment:

- **G55a.** Calibrator 8 hooks nine `CanvasItemMaterial`/`ShaderMaterial` calls (73 hooks total);
  whole decoded `Variant` parameter values are copied at the hook on the calling thread, and the
  shader/material hook log carries op, entity, version and (for a parameter) D8's type spelling,
  distinct from the image and mesh columns (Q3d).
- **G55b.** `fixtures/gate55-cim`'s blend modes and light modes (`add`, `sub`, `mul`,
  `premul_alpha`, `disabled`, `mix`; `light_only`, `unshaded`, `use_parent_material`) rasterize
  float32-exact against an independent Python twin: 2 304 000 pixel-shots per leg compared, a
  `BD` alpha prediction refuted and corrected (the root render target is `RGB10_A2`), budget 0 on
  a repeat.
- **G55c.** `fixtures/gate55-shader`'s seven synthetic shaders (code change, recreation, parameter
  erase, texture parameter, packed array, instance parameter) census exactly against the material
  oracle's `shader_get_code`/`material_get_param` readback (230 shader-steps) and a same-build
  repeat (budget 0); the server's preprocessed code (collapsed whitespace, `@@` include markers)
  is independently ported, not assumed.
- **G55d.** [render-stream/5](protocol/render-stream-5.md) landed for every gate: shaders and
  materials travel as two tables, items carry `material`/`use_parent_material`/`instance_params`,
  canvases carry their modulate, and `CanvasItemMaterial` blend/light modes replay pixel-exact on
  a native receiver (90/90 on the first engine run); the hook log applies D5 (a shader free nulls
  every material naming it at version + 1).
- **G55e.** `ShaderMaterial` travels end to end: a native receiver compiles captured GRP1 code and
  rebuilds every parameter exactly; `GRC_SHADER_POLICY=params` keeps every code byte off the
  stream (a receiver compiles from an operator-local library) and `exclude` refuses the shaders;
  every sabotage mismatches in exactly its predicted regions (115/115).
- **G55f.** Live parameters and code through a dropped presentation: a receiver that stalls for
  two seconds on a continuously-changing shader parameter (`PH`) catches up to the newest `tint_b`
  code and `phase` value in one coalesced transaction (not a stale one), and `stale-coalesce`
  classifies `pixel-mismatch` in exactly the regions the swallowed steps touch. See "Gate 5.5f
  result" above.

Costs measured in this run:

- **Materials (G55b/d).** `gate55-cim` and its `modulate` variant: 8→6 shaders, 11→10 materials,
  GRP1 code published once (1578 B at step 0, 204 B at step 3's recreation), `param_f64` 0–264 B
  per patch transaction. Hook census: `canvas_item_set_material`=13, `material_set_param`=36,
  `shader_set_code`=9, `material_create`=12, `material_set_shader`=17, `shader_create`=9.
- **Shaders (G55c/e).** `gate55-shader`: 6 live shaders throughout (`sh_a`→`sh_b` at step 8), GRP1
  code published at steps 0 (1311 B, six shaders), 3 (313 B, `tint_b`) and 8 (131 B, `sh_b`);
  `param_f64` 80–2480 B per patch transaction (`PH`'s per-frame `phase` dominates step 9's
  258-frame window, 2480 B). 417 `material_set_param` calls, 9 `canvas_item_set_material`.
- **Live shaders (G55f).** Retained store: 9–10 hashes, 22.9–23.2 KB max over an 851-frame live
  run. GETs: 10 cold, 0 warm, 10 after a 2 s stall (121–122-frame gap). See "Gate 5.5f result" for
  the stall timing and the stale-coalesce region set.

### What gate 5.5 does not prove

- The GSW browser or web-export receiver's shader path (gate 7): transpiling the supported subset,
  typing the rest `unsupported`, and a `params`-policy effect keyed by shader hash.
- Shader `TIME`, the screen texture, `BackBufferCopy`/`CanvasGroup`, `Light2D`/occluders/SDF/light
  masks, and global shader uniforms on a receiver (deferred, with owners, to gate 6 or later).
- Sampler arrays, `Array`/`String`/`Dictionary` parameters, and a resource budget tight enough to
  actually evict a shader or material under load (gate 6/8).
- The shader library's provenance beyond its hash, late-join materials, non-loopback serving, and
  authorization beyond a bearer token (gate 8).
- Exactness on another GPU or driver than the RTX 2060 this experiment runs on.

## Unknown-item skip (2026-10-10)

`GRC_UNKNOWN_ITEM=skip` is an opt-in diagnostic capture mode, approved by the user on 2026-10-10.
It lets one approved STS2 capture produce a meaningful partial picture before real late join
(gate 8's adoption pass) exists. The default is unchanged: an unknown canvas or item RID is still
gate 0's sticky `capture-failure` / `pre-existing-object`. The contract, the wire keys and the
reason the version does not change are in
[protocol/unknown-item-skip.md](protocol/unknown-item-skip.md). This mode is implemented in the
mirror's unknown-RID path (`capture/src/rs_mirror.*`), the session/transaction keys (C++ encoder,
TypeScript and GDScript decoders) and gate 0's `preexisting` legs. The receiver's applier is
unchanged: it draws exactly what is published.

### Semantics as built

- **Unknown target.** A call naming an unknown canvas or item RID as its target is counted
  (`unknown_calls`) and not applied. The RID stays remembered until it is freed.
- **Unknown parent.** A known item parented to an unknown RID is linked to it. That item and its
  whole subtree are **withheld**: they are still recorded, but left out of every snapshot (item
  entries, item-level `unsupported` entries, draw-index groups). No published container lists a
  withheld item, so the published state stays a valid, closed render-stream state.
- **Reparenting.** Reparenting a withheld item out publishes it again. A published item that
  enters a withheld subtree is first given a fresh wire id, so it never reappears under an old id
  (`id-reused`).
- **Freeing.** Freeing an unknown RID drops it silently and orphans the known items linked to it,
  which are then published.
- **Resources.** Texture and mesh tables are not filtered.
- **Wire.** The session declares `"unknown_item_policy":"skip"` after `sabotage`. Every
  transaction carries
  `"unknown_items":{"unknown_rids","withheld_items","withheld_commands","unknown_calls"}` after
  `unsupported`, complete in full and patch transactions. Both keys exist only in a skip session,
  at /4 and /5. Strict recordings and every golden vector are byte-identical to before, and a
  decoder that predates this note refuses a skip session (`meta-schema`): it fails closed.
- **Classification.** A transaction with `unknown_rids + withheld_items > 0` is partial. Gate 0's
  `classifyLeg` gives such a leg the new class `partial-unknown-items`, ranked just above
  `success`, so it is never plain success and every real failure still outranks it.
- **Opt-in values.** `GRC_UNKNOWN_ITEM` other than `strict` or `skip` refuses to publish.
  `result.json` `stream` gains `unknown_item_policy` and, under skip, the final mirror counters
  (`unknown_items`).

### Evidence

`fixtures/gate0/preexisting.tscn` now draws. Its `.tscn`-declared `Preexisting` node is
constructed before arming, so its RID is unknown. It draws a 64×64 rect, recoloured at step 2. A
`PreChild` it creates in `_ready` (after arming) is a known item withheld under it; it draws a
48×48 rect, recoloured at step 3. Gate 0 gained the `preexisting-skip` leg (skip capture and a
rendered receiver) and the `preexisting-reference` support leg. The strict `preexisting` leg is
unchanged in shape and still classifies `capture-failure` / `pre-existing-object` (`rid=… op=canvas_item_set_parent frame=1`,
all 52 transactions).

| check                              | result                                                                                                                                  |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `leg-class-preexisting-skip`       | `partial-unknown-items`: 52 of 52 transactions account for 1 unknown RID and 1 withheld item holding 1 command                            |
| `preexisting-skip-account`         | session and `result.json` declare skip; every transaction `ok`, exactly 2 published items, no pre-existing colour; `unknown_calls` 9 → 11 across step 2 |
| `preexisting-skip-reference`       | the 5 `preexisting-reference` shots equal `synthesizePreexistingReference(k)` exactly                                                     |
| `preexisting-skip-receiver`        | the 5 skip-receiver shots equal `synthesizeExpected(k)` exactly                                                                          |
| `preexisting-skip-excluded-region` | at every step the receiver differs from the reference in exactly 6400 px, every pixel of the two pre-existing rects, and nowhere else      |
| `leg-class-preexisting`            | `capture-failure` (`pre-existing-object`), as before                                                                                     |

Mirror ctests cover each exclusion rule (`rs_mirror_test`, 409 checks in all): an unknown target, an
unknown parent, reparenting into and out of a withheld subtree (including into a withheld *known*
item, and a same-frame round trip), freeing an unknown RID (orphaning, silence, recycled RID
values), and patch/full equivalence with no reappearing id over a six-state sequence.
`rs4_codec_test` pins the two keys' placement, and that they are absent from strict, /2 and /3
encodings. `self-test-rs2.ts` covers the TypeScript validator's acceptance and its three
`meta-schema` refusals. `self-test-gate0.ts` covers the new class's precedence against every
other class and five evidence scenarios. The GDScript decoder is exercised by the skip receiver
itself and by the unchanged golden self-test.

### What an STS2 run with `GRC_UNKNOWN_ITEM=skip` will and will not show

It **shows** canvas items created after arming whose parent chain never reaches a pre-arm object:
new top-level items on the root canvas or on canvases created after arming, and their subtrees.
It also says exactly how much is missing, per transaction and in `result.json`. It **does not
show**:

- the UI and scene items built before mod init, or anything parented under them, even if created
  later;
- every item in a `CanvasLayer` created before arming (that canvas is an unknown RID);
- textures created before arming (still `unknown-texture` commands).

It does not raise the 4096 live-item cap, which counts withheld items, and it supports no command
that was unsupported before. Its class is `partial-unknown-items`, or a worse one: on STS2 most
likely `unsupported`, with `partial-unknown-items` among the reasons. Late join is still gate 8.

## Scratch verification (2026-10-08)

A throwaway project under the ignored `artifacts/render-stream/scratch/` —
autoload loading the extension, a `ColorRect`, a `Label`, and a `_draw()` making
one `canvas_item_add_rect` and one `canvas_item_add_polygon` call with bit-exact
values — run as
`linux_release.x86_64 --headless --path <proj>` for eight frames:

```
GRC_MODE=arm      armed,    vptr_written=true,  disarmed=true, exit 0
  frames_total 8, frames_armed 8, intercepted 33
  canvas_item_add_rect 3, canvas_item_add_texture_rect_region 12,
  canvas_item_add_polygon 2, texture_2d_create 2, texture_2d_update 7, free 7
  display_server "headless", rendering_driver "opengl3",
  rendering_method "gl_compatibility"
GRC_MODE=validate validated, vptr_written=false, all counters 0
GRC_MODE unset    validated (default), vptr_written=false
GRC_CALIBRATION="" refused no-calibration,        vptr_written=false
nonexistent path   refused no-calibration,        vptr_written=false
record, sha256 zeroed            refused fingerprint-mismatch, vptr_written=false
record, every index +1           refused slot-mask-mismatch,   vptr_written=false
GRC_DISARM_AFTER_FRAMES=2        disarmed at frame 2, frames_armed 2, restored
```

Captured values, bit-exact and by value:

- From the scripted `_draw()`: `rect [213.25, 27.5, 101.125, 49.75]`
  (`0x43554000 0x41dc0000 0x42ca4000 0x42470000`), `color [0.125, 0.5, 0.75, 1]`;
  polygon points `[[10.5, 20.25], [140.75, 20.25], [75.125, 96.5]]` with three
  colours and `uvs_count 0`.
- From the native `ColorRect` (no script involved): `rect [0, 0, 160, 80]`,
  `color [0.25, 0.5, 0.125, 1]` — the scene's `Color(0.25, 0.5, 0.125, 1)`.
- From the `Label`: twelve `canvas_item_add_texture_rect_region` calls (the glyph
  path) plus a 256×256 format-1 glyph atlas created once and updated seven times,
  with sizes read off the `Image` through `Image.get_width`/`get_height`/
  `get_format`/`get_data_size` method binds.

The `+1`-shifted record is caught by the anchor mask (11/17 anchors matched),
not by the hooked slots — a neighbouring slot is pure-virtual too, which is
exactly why the 17 implemented anchors are part of the check and why the
calibrator insists the matching prefix be unique.

### Negative finding worth keeping

Godot's `Vector<T>` is **two words, not one**: it leads with an empty
`VectorWriteProxy<T> write` member (`core/templates/vector.h`), so the CowData
element pointer sits at offset 8. Decoding it as one word read the wrong word out
of every `Vector` argument and segfaulted on the first `canvas_item_add_polygon`
with a default-constructed `uvs`. `capture/test/abi_decode.cpp` now pins both the
offset and `sizeof`. The shape of a wrong-ABI failure is worth remembering: the
hooks still forwarded correctly (the engine never noticed), only the _recording_
was wrong — a silent-corruption class that only bit-exact expected values catch.

## Gate 5f result (2026-10-11)

G5f ([protocol/gate5-design.md](protocol/gate5-design.md) "G5f") passes: live meshes survive a
dropped presentation. No capture-side (C++) or receiver-side (GDScript) change was needed —
`GRC_SABOTAGE=stale-coalesce` and the pin/retire/HTTP-serving machinery are already generic over
resource kind in `rs_live.cpp`/`entry.cpp` (gate 1's and gate 2's own work), and
`fixtures/gate5-mesh` already honours `RS_FIXTURE_START_FRAME`/`_STEP_FRAMES`/`_QUIT_FRAME` the
way gate 1/2's fixtures do — so the whole increment is runner (`run-gate5.sh`'s new `run_g5f`) and
checker (`lib/gate5f-checks.ts`) wiring onto gate 1's G1d stall report and gate 2's G2c2 live-
resource checks, generalized to GRM1 mesh surfaces. `pnpm render-stream:gate5 -- --legs
g5b,g5c,g5d,g5e,g5f,g5g` is **116/116** in `artifacts/render-stream/gate5/20261011T040840Z/` (g5f
under `mesh/<leg>/`; ignored, not committed). On the same build: gate −1 PASS
(`gate-minus1/20261011T042351Z/`), gate 0 PASS (`gate0/20261011T042509Z/`), gate 1 65/65
(`gate1/20261011T042826Z/`), gate 2 85/85 (`gate2/20261011T043831Z/`) — no regression.

**The live timeline** (gate 1's and gate 2's pattern, reused unchanged): S=300, N=60, the mesh
fixture's own `LAST_STEP`=9, quit=851. Four legs, each its own host and receiver on
`fixtures/gate5-mesh`: `live-mesh` (fresh cache), `live-mesh-warm` (a new host and receiver on
`live-mesh`'s cache, mode warm), `live-mesh-stall` (`RS_RECEIVER_STALL=1:2000` after step 1), and
`sabotage-mesh-stale-coalesce` (the same stall, host `GRC_SABOTAGE=stale-coalesce` from step 1's
frame). A fifth rendered run, `reference-live`, is the mesh fixture at this *same* live timeline
with the capture extension absent — the ground truth every leg's shots are compared against.

| Leg | Class | Exit |
| --- | --- | --- |
| `live-mesh` | `success` | 0 |
| `live-mesh-warm` | `success` | 0 |
| `live-mesh-stall` | `success` | 0 |
| `sabotage-mesh-stale-coalesce` | `pixel-mismatch` | 0 |

Measured stall timing (both stalling legs, independently): send frame 367, credit frame 489 (122
frames at a 2000 ms request — matching memory `rs-g1d-stall-facts`'s gate-1 numbers almost
exactly), the post-stall shot landing in step 3's window (step 2's window lies wholly inside the
stall and has no shot at all, by design). `live-mesh-stall`'s recovery transaction (seq 307, frame
489) resolves to exactly the host's own full file recording at frame 489 — the newest state, not a
missed one. `sabotage-mesh-stale-coalesce`'s recovery transaction (seq 306, same frame 489) is
labelled `stale_from: 368` and does **not** equal the host's full recording there; its step-3 shot
mismatches `reference-live` exactly in `DF`, `Marker` and `RM` — every region `expected.json`'s
per-step `fresh` table says steps 2 and 3 (both swallowed by the stall) touch, not only `DF`, the
one region that changes every frame.

**Checks** (`lib/gate5f-checks.ts`, all passing): `live-tap-equals-received`,
`live-resolves-to-recording` (2202 live transactions equal the host recordings),
`pins-bounded`/`obsolete-retired` (replayed from the pin/retire lines against the full recording's
`okImageHashes ∪ okMeshHashes`, since the fixture also serves TEXG and the engine's hue strip over
the same mechanism; retained max 11–12 hashes, 26.5–26.8 KB), `http-gets-match-fetches`
(112 GETs total: `live-mesh` 38, `live-mesh-warm` 0, `live-mesh-stall` 37, every one a verified 200
with the right headers), `gets-advertised`, `fetch-before-applied`, `mesh-fetches-latest-only`
(during the stall no `DF` hash is fetched; the first post-stall transaction's `DF` surface equals
the host's newest), `receiver-vs-reference` (`live-mesh` 10/10, `live-mesh-warm` 10/10,
`live-mesh-stall` 9/9, `sabotage-mesh-stale-coalesce` 8/8 — each leg's own stall-window step
excluded, a DF-only difference tolerated when the wire's own state at that frame equals the host's
full recording there), `stale-coalesce` (the region set above), `warm-host-no-gets` (0 GETs, 38
cache hits, shots equal `reference-live`'s), and `leg-class-*` for all four legs.

Images (under the run directory): `mesh/reference-live/shots/step-{0..9}.png` against
`mesh/live-mesh/receiver/shots/seq-<n>.png`, `mesh/live-mesh-warm/receiver/shots/` and
`mesh/live-mesh-stall/receiver/shots/` (step 2 absent, swallowed by the stall), and
`mesh/sabotage-mesh-stale-coalesce/receiver/shots/seq-306.png` (step 3, the stale shot) against
`mesh/live-mesh-stall/receiver/shots/seq-307.png` (step 3, the healthy recovery) and
`mesh/reference-live/shots/step-3.png`.

### Findings

- **DF's band nature (gate5-design.md Q6d: "compared leg to leg only") means even an unstalled
  leg's shot can land a host frame off its nominal settle frame.** `live-mesh`'s step-5 shot (DF's
  rebuild step: free + create + add, one call more than DF's usual two) landed at frame 608, one
  frame past the window's `from` (607), purely from round-trip timing around the heavier
  transaction — no stall involved. A per-step static reference image is only pixel-exact for a
  shot taken at DF's *exact* frame, so a checkpoint whose only mismatching region is `DF` is judged
  `benign` against the wire itself (the connection's tapped resolved state at the shot's actual
  frame equals the host's own full file recording there, `statesEqual`), not against a fixed
  region allow-list. See memory `rs-g5f-live-mesh-facts`.
- **The stale-coalesce sabotage's effect is not confined to the continuously-animating region.**
  The stale snapshot it resends is from right after step 1, so step 2's and step 3's own changes
  (both swallowed by the 1:2000 stall) are stale too — `RM` and `Marker`, not only `DF`. The
  expected mismatching-region set is derived from `expected.json`'s per-step `fresh` table unioned
  over `StallReport.steps_applied_during`, never hardcoded to one region.
- **Pins, retirement and GET-advertising must union image and mesh hashes.** The mesh fixture also
  serves two ordinary textures (TEXG and the engine's default-theme hue strip) over the identical
  resource mechanism; gate 2c2's hash extractors default to textures only, and G5f's own checks
  pass `okImageHashes(t) ∪ okMeshHashes(t)` into the generalized `pinsReport`/`unadvertisedGets`
  (gate2c-checks.ts gained an optional hash-extractor parameter, backward compatible: gate 2's own
  checks keep their default).

### What G5f does not prove

- Resource pinning or retirement at a budget tight enough to actually evict something (the mesh
  fixture's live retained set never exceeded 12 hashes / 26.8 KB over an 851-frame run).
  Reconnect, resync, or a killed live-mesh receiver (gate 1's G1d already proves the mechanism;
  G5f reuses it unchanged).
- A second resource kind changing every frame at once (only `DF` churns continuously here); a
  frame-exact ground truth for a region whose *reference* also depends on continuous time (G5f's
  `benign` rule needs the wire, not a synthesized image, specifically because of this).
- Browser receivers (gate 7), non-loopback serving and late join (gate 8), and exactness on
  another GPU or driver.

## Gate 5 summary

Gate 5 passes: every increment from G5a through G5g lands, and `pnpm render-stream:gate5 --
--legs g5b,g5c,g5d,g5e,g5f,g5g` is **116/116** in
`artifacts/render-stream/gate5/20261011T040840Z/`, on the same build as gate −1 PASS
(`gate-minus1/20261011T042351Z/`), gate 0 PASS (`gate0/20261011T042509Z/`), gate 1 65/65
(`gate1/20261011T042826Z/`) and gate 2 85/85 (`gate2/20261011T043831Z/`). Every leg is at its
expected class; images are under each leg's `shots/` in the run directory, and the references are
`reference/shots/step-{0..9}.png` (`mesh/reference/shots/` and `mesh/reference-live/shots/` for
the mesh fixture's batch and live timelines, `style/reference/shots/` for the stylebox fixture).

What it proves, by increment:

- **G5a.** Calibrator 7 hooks eight geometry/mesh calls (73 hooks); whole copies are taken at the
  hook on the calling thread, and the mesh hook log carries per-surface version, hash and buffer
  columns distinct from the image columns (Q3d).
- **G5b.** render-stream/4 carries every immediate-geometry op (circle, line, multiline, nine-patch,
  polygon, polyline, primitive, rect, triangle-array, set-transform, clip-ignore) as the engine's
  own call arguments, float32-exact against an independent rasterizer (`geometry-raster.ts`):
  760 commands compared, 0 using their 2-ulp allowance.
- **G5c.** `fixtures/gate5-mesh`'s eight meshes (an `ArrayMesh`, two raw dynamic meshes, a
  `Polygon2D`'s own mesh, a loaded resource and a freed-but-named tombstone) census exactly against
  the mesh oracle's GPU readback (219 surface-steps) and a same-build repeat (budget 0).
- **G5d.** render-stream/4 landed for every gate: `add_set_transform` and `add_clip_ignore` travel
  as commands, so G3d's clip-ignore variant and G4d's `RichTextLabel` legs now classify `success`;
  the sabotages (freeze-frame, perturb-vertex, omit-op) and the receiver sabotages
  (ignore-set-transform, ignore-clip-ignore) each mismatch exactly their predicted regions.
- **G5e.** Meshes travel on render-stream/4 end to end: the mirror's mesh table, GRM1 payloads in
  the store/inline/live, the receiver's in-place residency (create, region update, rebuild, free),
  `drop-mesh-surface` and `stale-mesh`. 1200 transactions agree with the hook log; 37 GRM1 payloads
  (33 004 B) serve 765 receiver upload rows (62 504 B: 8 creates, 402 in-place updates, 3 rebuilds,
  350 custom AABBs, 2 frees) three ways (full sink, patch sink, all-inline) identically.
- **G5g.** Nine-patch and `StyleBoxFlat` (sharp, bordered, rounded, shadowed, skewed), the default
  theme's `Panel`, `TabBar`'s flipped draw, and a focused `RichTextLabel`'s clip-ignored focus box:
  324 commands float32-exact, 100 nine-patches equal, a stylebox band budget of 0.
- **G5f.** Live meshes through a dropped presentation: a receiver that stalls for two seconds on
  a continuously-deforming mesh resource catches up to the newest `DF` surface in one coalesced
  transaction (not a stale one), and `stale-coalesce` classifies `pixel-mismatch` in exactly the
  regions the swallowed steps touch. See "Gate 5f result" above.

Costs measured in this run:

- **Geometry (G5b).** Capture hook census: `circle` 4, `line` 15, `multiline` 3, `nine_patch` 2,
  `polygon` 7, `polyline` 8, `primitive` 4, `rect` 24, `set_transform` 6, `triangle_array` 4,
  `texture_2d_create` 3. Full sink 4 148 430 B, patch 259 717 B over 400 frames.
- **Meshes (G5c/G5e).** `DF`, the one every-frame mesh, logs 150 hook lines over the batch
  timeline (median copy 2.0 µs, hash 5.9 µs) and 1049 after its step-5 rebuild (`DF2`); the store
  holds 37 GRM1 payloads (33 004 B) because `DF`'s displacement repeats every 8 frames, so its
  hashes do too. Full sink 2 603 881 B, patch 546 737 B, all-inline 2 665 222 B (400 frames). Live
  surface bytes per step: 3 532 B (steps 0–4), 2 642, 2 358, 2 074, 2 085, 2 085.
- **Styleboxes (G5g).** Vertex/index counts exact per Q1h: `SF` 8/18, `SB` 24/66, `SR` 108/318,
  `SS` 32/84, `SK` 24/66, `DP` 72/210, `FL` 24/66, `RT` 144/432 — a stylebox band budget of 0 over
  every repeat.
- **Live meshes (G5f).** Retained store: 11–12 hashes, 26.5–26.8 KB max over an 851-frame live
  run. GETs: 38 cold, 0 warm, 37 after a 2 s stall (122-frame gap). See "Gate 5f result" for the
  stall timing and the stale-coalesce region set.

### What gate 5 does not prove

- Multimesh and GPU particles (typed `unsupported`, deferred to gate 8's census and gate 6).
- A resource budget tight enough to actually evict a mesh surface or texture under load (gate 6).
- Lazy hashing, spill-to-disk, cache eviction and parallel fetches at scale (gate 6).
- Browser receivers and their HTTP caches (gate 7).
- Non-loopback serving, late join, authorization beyond a bearer token, and the target game's own
  meshes, textures, shaders and materials at scale (gate 8).
- Exactness on another GPU or driver than the RTX 2060 this experiment runs on.

## Gate 6t result (2026-10-11)

G6t ([protocol/gate6-design.md](protocol/gate6-design.md) "G6t") passes: the measurement/report
tooling landed as new files only, touching no engine, capture or receiver code, per its wave-1
"no dependencies" entry in the Waves table. It owns:

- `scripts/lib/render-stream-report.ts` -- the `render-stream-report/1` schema (D10, Q7f): types,
  `validate()` (schema plus internal-consistency checks: exactly 5 repeats, `presented` always
  `unavailable`, `recv_gpu_render_ms` measured only for a rendered desktop-GL receiver, every
  `measured` value sourced, `memory` leaves as plain finite numbers from `/proc` with no status
  wrapper, and the `aggregate` block recomputed and compared), and `aggregate()` (median/min/max/
  coefficient-of-variation across exactly five repeats, dropping any metric path that any one
  repeat reports unavailable rather than aggregating a mix of real numbers and absent ones).
- `scripts/throttle-proxy.ts` (D12) -- a loopback-only TCP proxy (`node:net` only) in front of a
  host's listener, with a token bucket plus a fixed one-way delay per direction (`constrained`:
  500 000 B/s, 64 KiB burst, 30 ms). Both importable (`startThrottleProxy`) and a standalone CLI.
- `scripts/lib/proc-sampler.ts` -- 1 Hz `/proc/<pid>/status` and `/proc/<pid>/task/*/stat` reads
  (D9: engine memory counters are unavailable in release templates).
- `scripts/lib/provenance.ts` -- host facts, the gamescope version string, `sha256File`.
- `scripts/analyze-deltas.ts` (D15) -- hash-at-publish and mesh region-update delta savings from a
  `resources.jsonl` hook log, reported honestly rather than estimated where the log does not carry
  the needed byte size (mesh whole-buffer bytes; see "What G6t does not prove").
- `scripts/report-gate6.ts` -- `validate <report.json>` and `build <run-set dir> --out <file>
  [--deltas <resources.jsonl>]`, wired to `pnpm render-stream:report`.

**How it was tested**: `scripts/test/self-test-report.ts`, 40 assertions, all green, stable across
repeated runs:

- `validate()`: a fabricated report validates clean; one perturbation per rule each fails with its
  expected code (`bad-schema`, `run-entry`, `repeat-count`, `scenario-entry`, `rate-entry` ×2,
  `dist-entry`, `memory-entry`, `aggregate-mismatch`, `optimizations-entry`).
- `aggregate()`: median/min/max/cov of `[1,2,3,4,5]` computed by hand (cov ≈ 0.527); a metric
  unavailable in one of five repeats is dropped from the result entirely.
- `throttle-proxy.ts` against two real loopback TCP servers: a saturating echo stream stayed within
  5% of the configured 500 000 B/s (measured 97-102% across runs); discrete low-rate messages (one
  byte every 120 ms, well under the bucket's drain rate) stayed within 2 ms of the configured 30 ms
  delay (measured mean 30.0-30.2 ms both directions). The two had to be separate scenarios: a
  saturating stream's per-chunk latency is dominated by token-bucket queueing (measured ~1.5 s at
  saturation), which would otherwise swamp the ±2 ms delay check (memory:
  g6t-report-tooling-facts).
- `proc-sampler.ts` against a real spawned `node` child doing ~1s of CPU work: positive VmRSS, at
  least one thread, and that thread's summed CPU time measurably increasing between two samples.
- `provenance.ts` against this machine (positive logical CPUs/RAM, non-empty kernel string) and a
  real temp file (`sha256File` matches an independently computed digest).
- `analyze-deltas.ts` against fabricated `resources.jsonl` lines: a same-frame texture version bump
  correctly identified as superseded (and its own, not the superseding version's, bytes/hash_ns/
  copy_ns counted); a mesh's two region updates summed to an exact 200-byte delta with
  `whole_version_bytes_available: false`; a texture's delta equalling its whole (`savings_bytes:
  0`); mixed-unit parameter bytes per frame; and `parseHookLog` skipping one malformed line.
- `report-gate6.ts build()` assembling a report from a fabricated run-set directory that then
  validates clean, exercised both in-process and as the real `pnpm render-stream:report -- build
  ...` / `-- validate ...` CLI against a scratch run-set directory (outside the repo, not
  committed).
- `mise exec -- pnpm exec biome check` and `mise exec -- pnpm exec tsc --noEmit -p
  experiments/render-stream/tsconfig.json` both clean on every file this increment touched.

### What G6t does not prove

- That any of this runs against a REAL gate 6 capture, receiver or soak run: no `resources.jsonl`,
  `perf.json` or receiver `applied.json` from an actual Godot session exists yet (G6a/G6k/G6r/G6l
  land those). `report-gate6.ts build()`'s run-set directory layout is this increment's own
  convention, not something another file in the repository already defines; whichever increment
  first calls `build()` on a real measurement run may need to adjust it.
- A true mesh "whole-version bytes" baseline: `MeshSurfaceCopy` lines carry `vertex_count`/
  `index_count`, never a byte size, so `analyze-deltas.ts` cannot compute a mesh savings
  percentage without `rs_mesh_payload.h`'s format-to-stride mapping (out of scope here; memory:
  g6t-report-tooling-facts). The mesh delta total itself (from region updates' own `bytes`) is
  exact.
- `recv_gpu_render_ms`'s "rendered desktop-GL receiver" classification: the committed provenance
  shape has no explicit headless/rendered flag, so `isRenderedDesktopGlReceiver()` in
  `render-stream-report.ts` infers it from `rendering_method === "gl_compatibility"` plus a
  non-empty, non-placeholder `adapter.name` -- a judgment call documented in that file's header,
  not a normative field G6b/G6c's receiver provenance is guaranteed to populate the same way.
- `GRC_LIVE_MAX_CONNECTIONS`, rate control, or anything engine-side: G6t touches none of it (G6r's
  job). The throttle proxy and sampler are ready for G6c/G6l/G6s/G6p to drive against a real host
  and receiver, but have only ever been exercised against synthetic loopback servers here.

## Gate 6k result (2026-10-11)

G6k ([protocol/gate6-design.md](protocol/gate6-design.md) "G6k", Q2) passes: calibrator 9 hooks the
six slots Q2 predicted, confirmed by `calibrate.py`/`scripts/calibrate.sh` against the pinned
binary exactly as predicted: `viewport_remove_canvas` 314, `viewport_set_global_canvas_transform`
323, `viewport_set_canvas_stacking` 324, `canvas_set_item_mirroring` 436, `canvas_set_item_repeat`
437, `canvas_set_parent` 439. Gate −1 goes from 73 to 79 hooks, none omitted; the committed record
now names 80 slots (79 hooks plus the `get_default_clear_color` probe). `build-capture.sh`
**17/17** ctests (`rs_resource_log` extended, no new
executable), `scripts/calibrate.sh --check` clean, gate −1 **29/29** (79 hooks, all six positive,
`old-record` still arms a calibrator-1 record with 71 hooks omitted), gate 0 **24/24**, gate 1
(groups g1a-g1d) **65/65**, gate 2 (groups g2a-g2e) **85/85** (one `live-animate`
pins-bounded/obsolete-retired rerun, the pre-existing load-timing flake named in
`.agents/memory/preexisting-check-failures.md`; it did not recur). Every pure self-test (checker,
gate 0, gate 1, gate 2) and `tsc --noEmit`/`biome check` on every file this increment touched
stayed clean: checker 75/75, gate 0 237/237, gate 1 402/402, gate 2 406/406.

Decode and hook-log only, exactly as scoped: none of the six calls the mirror, publisher or wire
format (`rs_mirror.*`/`rs_publish.*` untouched, render-stream/4 unchanged) -- that is G6b's job.

What landed:

- **Calibrator 9, six new optional slots** (`capture/src/hooks.cpp`): each hook bumps its
  `counters.json` entry and, with `resources().active()`, writes an `evidence/resources.jsonl`
  `kind:"canvas"` line (`capture/src/rs_resource_log.{h,cpp}`) with no registry and no
  classification -- a canvas's identity and state stay the mirror's field (G6b). New trailing
  columns, null on every other line: `sublayer` (`layer` itself reuses the existing column),
  `transform` (flattened `[a, b, c, d, origin.x, origin.y]`), `parent` (decimal string or null for
  `RID()`; the scale argument is not logged), `mirroring` (`[x, y]`) and `repeat` (`[size.x,
  size.y, times]`). `RESOURCE_LINE_KEYS`/`RESOURCE_LOG_OPS` (`gate2-checks.ts`) and `GATE0_HOOKS`
  (`gate0-checks.ts`) extended to match; `validateResourceLine`'s exact-key-order check means every
  existing line in every gate now carries five more trailing nulls too.
- **`fixtures/spike/`'s `_exercise_calibrator9_hooks`**: a `CanvasLayer`, parented to a throwaway
  `Node` so its stacking sublayer is deterministically 0, gets an explicit `set_layer`, a
  `set_follow_viewport(true)` (a non-null `canvas_set_parent`) and a `remove_child`
  (`viewport_remove_canvas`); a raw canvas item, parented to the world canvas (so
  `canvas_set_item_mirroring`'s own canvas lookup does not log an engine error,
  `renderer_canvas_cull.cpp:514-521`), gets a raw `canvas_set_item_mirroring` and
  `canvas_set_item_repeat`; the root's `global_canvas_transform` is written non-identity then
  reset to identity again before anything draws (stretch is disabled, so both values are exact),
  so every other calibrator's pixel sample keeps its frame-60 position.
- **A new gate −1 leg, `headless-stream`**: the only gate −1 leg with a file sink
  (`GRC_STREAM_OUT`) and resource store (`GRC_RESOURCE_STORE_DIR`) open, so `evidence/
  resources.jsonl` exists to check -- `headless-armed` and every other leg are untouched.
  `GRC_MODE=arm` alone never opens one (`entry.cpp`'s `resources_start()` runs only from the
  stream-open path), and no gate −1 leg had before this. The new `canvas-hook-log` criterion reads
  it alone, matching each of the six ops among resources.jsonl's `kind:"canvas"` lines against the
  fixture's own constants (`expected.json`'s new `canvas9` block).
- **`gate2-checks.ts`'s `census` criterion widened**: every `Viewport` (the root included) calls
  `viewport_remove_canvas` on `NOTIFICATION_EXIT_TREE` (`scene/main/viewport.cpp:611-615`) -- a
  universal engine behaviour, not specific to gate 2's fixture -- so the root viewport's own exit
  at `SceneTree` teardown now logs one after gate 2's quit frame on every stream-enabled leg. The
  "after the quit frame only teardown frees" rule now allows `viewport_remove_canvas` beside
  `free`.

### Findings

- **`canvas_set_item_mirroring`'s real ABI has two RIDs** (`RID p_canvas, RID p_item, const
  Point2 &p_mirroring`, `rendering_server.h:1526`), not the one `gate6-design.md` Q2's ABI
  shorthand ("436 is `(RID, const Vector2 *)`") shows. The slot number it predicted (436) was
  still exactly right -- `calibrate.py` discovers slots by name, independent of the hooked
  function's own decoded ABI -- so this was purely a decode-arity bug, caught by cross-checking
  the real header before writing the `using Fn... = ...` alias, not by any runtime failure (the
  hook still forwards the real pointer to the engine unchanged either way). `canvas_set_item_
  repeat`'s one RID argument is an item, not a canvas, despite the design doc calling that column
  "canvas RID" generically (memory: rs-g6k-canvas-hook-facts).
- **`evidence/resources.jsonl` needs an open stream, not just an armed capture.** Gate −1 never
  set `GRC_STREAM_OUT` on any leg before this increment (git history confirms G5a and G55a added
  `kind:"mesh"`/`"shader"`/`"material"`/`"item-material"` lines to the SAME file without ever
  checking them at gate −1 -- their first hook-log checks land at gate 2/5c/55b/55c, which all
  open streams). Validating a brand-new hook's hook-log content from gate −1 itself needed a new
  leg, not a new check against existing evidence.
- **The root viewport's own teardown call was the only gate 2 regression.** Hooking slot 314 is
  purely additive everywhere else it was already exercised (gate −1's spike, gate 0's and gate
  1's fixtures): only gate 2's `census` criterion asserts an exact, closed set of post-quit-frame
  ops, so it was the one place a new, always-present teardown call needed an explicit allowance.
  `gate5c-checks.ts`/`gate55c-checks.ts` have their own `after_quit` counters but only *report* the
  count, scoped to `kind:"mesh"`/`"shader"`/`"material"` lines that a `kind:"canvas"` line never
  matches, so they were never at risk.

### What G6k does not prove

- That the mirror, publisher or receiver understand any of these six calls: `rs_mirror.*` gained
  no canvas-layer table, no stacking/attach/transform fields, and the wire format did not move
  past render-stream/4. A `CanvasLayer`, `global_canvas_transform`, mirroring or repeat in a real
  scene changes nothing a receiver renders yet -- that is G6b's `fixtures/gate6-scene`/`gate6-hd`
  work.
- `canvas_set_parent`'s `scale` argument, or `viewport_set_canvas_stacking`'s/`canvas_set_item_
  repeat`'s values beyond what the spike fixture's own constants exercise: the hook log carries
  exactly what Q2 named and no more (D2's "no classification yet" rule).
- Rendering or pixels: none of the six calls draws anything, by design (the fixture additions are
  on an empty `CanvasLayer` and orphan/world-canvas items), so this increment proves decode
  correctness and hook-log shape, not visual behaviour.

## Gate 6r result (2026-10-11)

G6r ([protocol/gate6-design.md](protocol/gate6-design.md) "G6r") passes: rate control, the
`GRC_LIVE_MAX_CONNECTIONS` admission limit and perf instrumentation on render-stream/5, with the
default (`GRC_PUBLISH_FPS=uncapped`) unchanged and no gate 6 wire version. Per the increment's own
scoping rule (`rs_live.cpp`+`entry.cpp` only, not `hooks.cpp`/`rs_resource_store.cpp`/
`rs_texture_payload.cpp`/`rs_mesh_payload.cpp`/`rs_shader_payload.cpp`/`rs_variant.cpp`/`rs_ws.cpp`),
Q3d's `store_write_us`, the texture/mesh/shader `copy_us`/`hash_us` pairs, `param_decode_us` and
`http_serve_us` are declared `unavailable` in `perf.json` rather than wired or guessed, and the
receiver's perf equivalently declares `resolve_us`/`upload_us` unavailable (combined inside
`RsApplier.accept_record`/`apply_state`, which this increment does not split).

- **Rate control (`capture/src/rs_live.{h,cpp}`, Q3c).** Per connection: `period_ns` (0 =
  uncapped), `t0_ns`/`next_due_ns` (started at the connection's own first send, never reset), and
  counters `ticks_due`, `ticks_sent`, `ticks_credit_blocked`, `frames_rate_idle` (all 0 under the
  default). A due tick without credit stays due and is counted; a due tick with credit sends and
  advances the schedule to the first tick strictly after "now", anchored at the *previous*
  `next_due_ns` rather than recomputed from `t0` and raw `now` -- the literal `t0 +
  (⌊(now-t0)/P⌋+1)·P` formula, applied when a send fires slightly *early* inside the due check's
  quarter-period slack (the common case, not an edge case), can floor back to the tick just
  serviced instead of the next one, double-firing on the very next callback. Anchoring at the old
  `next_due_ns` fixes it: `now < next_due_ns` (early/on-time) adds one period; `now >= next_due_ns`
  (credit blocked for a while) jumps straight to the first tick after `now`, skipping every missed
  one -- "never burst" without ever needing to catch up tick by tick.
- **Multi-connection admission (D13).** `GRC_LIVE_MAX_CONNECTIONS=1..4` sets
  `ServerConfig::max_clients`; the `Hub` already tracked every connection independently (pins as
  the union of every open connection's base, one snapshot copy per frame for all of them). The one
  real change: with more than one connection open, `on_http_get` no longer attributes a GET to
  "the newest connection" (which would misattribute a different receiver's fetch) -- it returns 0
  and counts the GET at the host level only.
- **Histogram (`capture/src/rs_histogram.{h,cpp}`, new).** A fixed 400-bucket log-linear
  histogram, 16 linear sub-buckets per octave (25 octaves, covering samples up to 2^25-1 before
  the top bucket clamps), ≤6.25% relative error, plus exact count/sum/min/max/mean. Below octave 4
  (values < 16) 16 equal-width sub-buckets cannot all be distinct -- most stay permanently
  unreachable, harmlessly, since the index formula is still injective over every value that
  actually occurs. `rs_histogram_test.cpp` (218 440 checks: an exhaustive sweep plus a
  reference-formula cross-check) passes clean. The receiver's perf.json reimplements the same
  bucket scheme in GDScript (`rs_perf.gd`'s `Histogram`), since it is a separate process with no
  access to the C++ library.
- **perf.json / perf-timeline.jsonl (`entry.cpp`).** `frame_interval_us`, `frame_callback_us` and
  `snapshot_us` measured directly in `entry.cpp`; `diff_us`, `encode_us`, `enqueue_us`,
  `credit_rtt_us`/`staleness_us` (`{applied, submitted}`) as cross-connection histograms owned by
  the `Hub` (the same costs already accumulated into `EndStats`, now also sampled per call).
  `cpu.main_thread_us` is exact (`CLOCK_THREAD_CPUTIME_ID`); `cpu.io_thread_us` is `null` (no
  handle to the I/O thread without touching `rs_ws.h`). `perf-timeline.jsonl` adds one line per
  second: frame count, RSS (`/proc/self/statm`) and, per connection, `sent`/`credits`/
  `coalesced`/`ticks_credit_blocked`/`max_pending_age_us`/`bytes_sent`.
- **GRC_HOOK_LOG (Q3d).** `off` stops `entry.cpp` from ever opening `resources.jsonl`, and
  `resources_drain()` now always drains (and, with the file closed, discards) the hooks' buffered
  lines every frame rather than only when the file is open -- fixing a latent unbounded-buffer-
  growth risk that existed whenever the file failed to open, not only under the new flag.
  `counters.json` and the mirror read from the hooks directly, never from this file, so they are
  unaffected either way; the per-call line-*building* cost inside `rs_resource_log.cpp` is
  unchanged (out of this increment's file list), so `off`'s measured saving is the file I/O and
  buffer retention only, not the hook's own formatting cost.
- **Receiver (`receiver/receiver.gd`, new `receiver/rs_perf.gd`).** `RS_RECEIVER_LOG=summary`
  drops `applied.json`'s `transactions` array to `null` (shots and failures stay; the backing
  array is never appended to either, so nothing grows unbounded). `RS_RECEIVER_PERF_OUT` writes
  `render-stream-receiver-perf/1` on every exit path (`_fail`/`_finish`/`_finish_live`, via
  `_write_report()`): histograms for `decode_us` (`RsApplier.accept_record`), `apply_us`
  (`RsApplier.apply_state`), `fetch_us` (reusing the fetch stage's own existing timestamps, never
  re-timed) and `frame_interval_us`; `cpu_render_ms`/`gpu_render_ms` via
  `RenderingServer.viewport_get_measured_render_time_{cpu,gpu}` with a status
  (`skipped-headless` under `--headless`, reusing receiver.gd's own existing headless
  vocabulary); `counts` (`received`/`applied`/`submitted`, from the existing `_acks_sent`, `null`
  in file mode, which has no acks); and a one-line-per-second timeline (RSS via `FileAccess` on
  `/proc/self/statm`, `RenderingServer.get_rendering_info`'s texture/buffer/video memory, the disk
  cache's entry count and bytes). Smoke-tested standalone against `protocol/golden-5/inline.rs5`
  in both `RS_RECEIVER_LOG` modes: `applied.json.transactions` is `null` under `summary` and a
  15-entry array under `full`; `perf.json` validates with populated `decode_us`/`apply_us`
  histograms, `fetch_us` exactly 0 (no fetches: an inline session), `render_time` both
  `skipped-headless`, and `counts` correctly `null` (file mode).

**Self-test leg**: `live-rate-30` (gate 1's `g1c` group, `GRC_PUBLISH_FPS=30` on the fixture's
60 fps host and receiver). `checkLiveRate30` (`scripts/lib/gate1-live-checks.ts`) compares it
against the plain `live` leg on the *same fixed timeline*: the file sinks (`recording.rs2`,
`recording-patch.rs2`) must publish exactly as many transactions as `live`'s did, proving rate
control affects only the live connection, never the file publisher.

| Metric | `live-rate-30` (target 30, host/receiver 60 fps) |
| --- | --- |
| requested | 30 fps |
| published (measured) | 518 sent over 1036 streaming frames = **30.00 fps** |
| file sink (full) transactions | 1080, 0 errors -- identical to the `live` leg's 1080, 0 errors |
| file sink (patch) transactions | 1080, 0 errors -- identical to the `live` leg's 1080, 0 errors |
| `ticks_due` / `ticks_sent` / `ticks_credit_blocked` / `frames_rate_idle` | 517 / 517 / 0 / 143 |
| `max_in_flight` | 1 |

The connection's very first send (right after the hello) is not itself a counted tick (it starts
the schedule); `sent` = 1 + `ticks_sent`. `ticks_credit_blocked` is 0: the fixture's receiver
always returns credit well within one 30 fps period. `frames_rate_idle` (143) accounts for the
rest of the 1036 streaming callbacks: `1036 = 1 (first send) + 517 (ticks_sent) + 143
(frames_rate_idle) + 375` -- the remaining callbacks are the ones spent waiting for credit to
return in between (counted in `frames_offered` but not in any of the four rate counters, which
only classify callbacks once streaming and not already accounted for by a send).

**How it was tested**:

- `rs_histogram_test` (218 440 checks), `rs_live_test` (261 checks, including four new rate-
  schedule tests: uncapped unchanged, 15/30/60 fps targets with a no-burst spacing check, a
  credit-blocked stall with no catch-up burst, and two independent connections) -- both via
  `ctest` from `experiments/render-stream/capture/build`, alongside the full existing capture
  suite (18 targets, all green, nothing regressed by the `wants_snapshot()` signature change or
  the `send_transaction()`/`Conn` additions).
- `mise exec -- pnpm exec tsc --noEmit -p experiments/render-stream/tsconfig.json`: clean;
  `mise exec -- pnpm exec biome check` clean on every file this increment touched.
- `scripts/test/self-test-gate1.ts`: 402/402 assertions, 89 fabricated evidence scenarios. Adding
  `checkLiveRate30` to g1c's check list meant the self-test's own fully-passing "good tree"
  fixture needed a `live-rate-30` host built alongside `live`'s (same file sink, same ~30 fps
  send cadence by construction) for that one new check to find evidence for; without it the
  "good tree passes every check" assertion failed (401/402) until `buildLiveLegs()` was extended.
- The receiver smoke-tested standalone (not via a gate) against `protocol/golden-5/inline.rs5` in
  both `RS_RECEIVER_LOG` modes, as described above.
- Gates -1, 0, 1 and 2 green with defaults (gate 1's full `g1a,g1b,g1c,g1d`, now including
  `live-rate-30`, 66/66 checks; gate 2's live-animate checks, sensitive to per-transaction timing
  per memory `rs-g55d-rs5-switch-facts`, are unperturbed by code that only runs under non-default
  `GRC_PUBLISH_FPS`/`GRC_LIVE_MAX_CONNECTIONS`/`GRC_HOOK_LOG`). Gate 5.5 green with defaults.
- `rs-g55d-rs5-switch-facts` also flags G5f specifically: a ~150 µs per-transaction receiver
  slowdown breaks its live checks. A dedicated benchmark (five warm-cache repeats, file-mode
  replay of a real 400-transaction capture through the receiver, `RS_RECEIVER_PERF_OUT` unset)
  measured this increment's receiver.gd within **~5 µs/transaction** of main's (3395-3402 ms
  total both sides; see memory `g5f-stale-coalesce-receiver-vs-reference-flake`). `pnpm
  render-stream:gate5 -- --legs g5c,g5f` (g5f's own checks only run when g5c is also requested)
  then showed one flaky check, `receiver-vs-reference`, on the `sabotage-mesh-stale-coalesce` leg
  alone (two runs, different step each time); A/B testing the identical fixture against main's
  unmodified receiver.gd (G6r's receiver.gd and rs_perf.gd fully reverted/removed) reproduced the
  exact same failure, 33/38, proving it is pre-existing and not a regression from this increment
  -- recorded as `g5f-stale-coalesce-receiver-vs-reference-flake` rather than "fixed" by changing
  code that was already zero-cost.

### Deviations from Q3d's full instrumentation list

Scoped to the files G6r's own section names (`rs_live.{h,cpp}`, `entry.cpp`, `rs_histogram.{h,cpp}`,
`receiver.gd`, `rs_perf.gd`); every omission below is declared in `perf.json`'s
`unavailable_stages` (capture) or the receiver perf's own list, not silently missing:

- `store_write_us`, `texture_copy_us`/`_hash_us`, `mesh_copy_us`/`_hash_us`,
  `shader_copy_us`/`_hash_us`, `param_decode_us` -- need `rs_resource_store.cpp`,
  `rs_texture_payload.cpp`, `rs_mesh_payload.cpp` or `rs_shader_payload.cpp`/`rs_variant.cpp`.
- `http_serve_us`, `cpu.io_thread_us` -- need a handle to the I/O thread, which `rs_ws.h` does not
  expose to `entry.cpp`.
- Receiver `resolve_us`/`upload_us` -- combined with `decode_us`/`apply_us` respectively inside
  `RsApplier.accept_record`/`apply_state`, which this increment does not split (upload bytes are
  already in `applied.json`'s `resources_summary`, not duplicated in perf.json).
- Receiver timeline `pipeline_compilations`, `live_rids`, `cache_entries_memory`/
  `cache_bytes_memory` -- would need new `RsApplier`/`RsResourceCache` accessors, out of this
  increment's two receiver files.
- `rs_perf.gd`'s `Histogram` has no dedicated GDScript unit test (no existing fast per-class
  self-test harness for a standalone RefCounted class in this project; it was instead verified by
  smoke-testing the whole receiver against `protocol/golden-5/inline.rs5` and by the C++
  `Histogram`'s own exhaustive test proving the shared bucket-math algorithm).

### What G6r does not prove

- A true gate 6 measurement matrix, report or deltas analysis (G6p); this increment's own
  `live-rate-30` table above is a single self-test, not the warmup-plus-five-repeats protocol
  D11 requires.
- Rate control under the `constrained` transport profile, dual connections at genuinely different
  *target* rates (both connections here share one `GRC_PUBLISH_FPS`; D13's "two at once, at
  different rates" is proved by independent receiver `--max-fps`, not independent publish
  targets, since GRC_PUBLISH_FPS is one hub-wide setting), or any of G6c's rate legs
  (`rate-15/-30/-60`, `mismatch-*`, `dual-60-15`, `recv-delay`, `gpu-heavy`) -- those are G6c's.
- The full Q3d instrumentation list end to end (see "Deviations" above).

## Gate 6w result (2026-10-11)

G6w ([protocol/gate6-design.md](protocol/gate6-design.md) "G6w") passes: render-stream/6 is
implemented as a protocol-version switch on the same `rs2_codec.*`/`rs2_diff.*`/
`render-stream-2.ts`/`rs2_decoder.gd` modules /3-/5 already extended (memory:
g4e1-rs3-version-switch-pattern), touching no capture, receiver or runner code -- both still speak
/5 until G6b. [protocol/render-stream-6.md](protocol/render-stream-6.md) specifies the delta as a
document like render-stream-5.md.

/6 adds, on top of /5: a new magic/protocol/subprotocol string; three new `viewport` keys
(`presentation_size`, `font_oversampling`, `snap_2d`) and a new `root_size_policy` value
(`presentation`); a new top-level session key `publication` (rate control, distinct from
`features.publication`); two new canvas keys (`layer`, `sublayer`); five new session-level
`unsupported` reasons (`canvas-stacking-tie`, `canvas-repeat`, `canvas-follow-viewport`,
`global-canvas-transform`, `snap-2d`); and three `features` list changes. `extra-canvas` stays a
schema-legal spelling but is rejected outright at /6 (mirroring how /5 rejects `unsupported-state`
naming `canvas_item_set_material`). Transactions, blocks, items and commands are byte-identical to
/5.

**As built**: `font_oversampling` is the one deliberate exception to render-stream-0.md's "floats
never appear in JSON" rule (gate6-design.md Q4 marks it `(new, float32)` as a bare JSON number).
Its canonical form -- the shortest fixed-point decimal that round-trips to the float64 widening of
the value, matching JavaScript's `Number::toString` (no trailing `.0`, unlike Python's `repr`) --
is implemented identically in `rs2_codec.cpp`'s `append_json_float()` and `make_golden.py`'s
`_json_float()`; the TypeScript decoder needs no special handling since its generic
`meta-noncanonical` check already re-serialises with native `JSON.stringify`, and GDScript performs
no canonical re-serialisation check at all (render-stream-0.md's existing exemption), so it only
parses the value and checks positivity.

`protocol/golden-6/` re-derives golden-5's fifteen states byte for byte under the new magic/
protocol (presentation_size equal to logical_size, oversampling 1, snap off, publication
every-frame, root canvas at layer 0/sublayer 0), then adds four more: state 16 (a second canvas
attached at layer 1/sublayer 0 with two new items), state 17 (only the layer changes, 1 -> -1), 18
(the canvas is detached, its items stay in the table), 19 (the canvas is reattached at layer 2 --
never carrying forward its detached layer -- alongside a third canvas at the same layer, a
canvas-stacking-tie, plus canvas-repeat/canvas-follow-viewport/global-canvas-transform declared
together). Three dedicated independent small streams follow params.rs5's precedent:
`presentation.rs6` (canvas_items, logical 1920x1080, presentation 960x540, oversampling 0.5),
`snap.rs6` (both flags true, every transaction carries the snap-2d entry), `rate.rs6` (a websocket
stream, publication rate/30). `invalid/` carries the thirteen new failure modes render-stream-6.md
lists; no new payload format at /6, so there is no `payload-invalid/` (golden-3's precedent).

**How it was tested**:

- `protocol/golden-6/make_golden.py --check` (stdlib only): 65 outputs match, deterministic
  regeneration. `make_golden.py --check` for golden-2 through golden-5 still match unchanged (62,
  47, 37 and 51 outputs respectively -- unaffected by this increment).
- `build-capture.sh`: all 18 ctests pass, including the new `rs6_codec_test` (full.rs6/patch.rs6/
  inline.rs6 byte-for-byte against `rs2_codec.cpp`'s V6 output, plus `rs2_diff.cpp`'s
  `make_full()`/`make_patch()`/`resolve()` round-tripping states 16-19 through the version-
  parameterized diff engine) and the unchanged rs2-rs5 codec tests.
- `scripts/test/self-test-rs2.ts` (TypeScript): all golden-2 through golden-6 suites green,
  including all thirteen golden-6 invalid vectors with their exact codes, the three new
  independent legs, and bidirectional bad-magic checks against /5.
- `receiver/tests/codec2_selftest.gd` (GDScript, headless): `[rs2-selftest] ok` against all five
  golden directories, same coverage as the TypeScript suite.
- `mise exec -- pnpm exec biome check` and `mise exec -- pnpm exec tsc --noEmit -p
  experiments/render-stream/tsconfig.json` clean on every file this increment touched.

### What G6w does not prove

- That the capture or receiver speak /6 at all: both still negotiate /5 (G6b's job). This
  increment is pure codec/golden-vector work, exactly as gate5_5-design.md's G55w was for /5.
  `calibrator_version`/`hooks_planned` in the golden-6 session are /5's values unchanged -- the
  real calibrator 9 hooks (canvas stacking, mirroring, repeat, parent, global canvas transform)
  are G6k's job, not this increment's.
- That `canvas-repeat`, `canvas-follow-viewport` or `global-canvas-transform` ever correspond to a
  real engine call: none of the three has a wire-visible argument (a mirroring vector, a parent
  RID, a live transform), so golden-6's vectors declare them directly rather than deriving them
  from any other field -- exactly as `canvas-light` already does at /5. Only `canvas-stacking-tie`
  and `snap-2d` have an independently checkable "actual" signal (the resolved canvas table and the
  session's own `snap_2d` flags, respectively).

## Gate 6a result (2026-10-11)

G6a ([protocol/gate6-design.md](protocol/gate6-design.md) "G6a") passes: the combined 640×360
scene `fixtures/gate6-scene` (native Controls, a clipped ScrollContainer that scrolls, a Label and a
scrolling RichTextLabel with an inline image, a custom `_draw`, a texture that changes and is freed,
a mesh deformed every frame, a CanvasItemMaterial, a ShaderMaterial driven by an AnimationPlayer, a
Tween, a `top_level` escape and a HUD CanvasLayer) runs its file legs on render-stream/5.
`pnpm render-stream:gate6 -- --legs g6a` is **32/32** in `artifacts/render-stream/gate6/g6a-final/`
(ignored, not committed; 8 min wall clock), on `main` with G6r and G6w merged, and again 32/32 in `gate6/g6a-final2/` after G6k (calibrator 9) landed. The regression
gates on the same build are listed under "Runs" below.

**What was added.** The fixture (`scene_builder.gd`, parameterized by origin, cell and phase for
G6h; `gate6_scene.gd` with the `file`, `live`, `rate` and `soak` timelines, `steps` and `realtime`
time, the `animate` and `refused` variants and `RS_FIXTURE_SHOT_FRAMES`; `scene_oracle.gd`;
`make_expected.py` and `expected.json`), `run-gate6.sh` and `pnpm render-stream:gate6`,
`check-gate6.ts`, `lib/gate6-expected.ts`, `lib/gate6a-checks.ts` and `test/self-test-gate6.ts`
(39 assertions). Two shared files changed: `lib/geometry-raster.ts` gains an undecided box (text
and other hand-undecided content inside exact regions), and the receiver gains
`RS_RECEIVER_SABOTAGE=stale-texture` (with an `applier2_selftest.gd` case).

| Leg | Class | Pixels outside HU (and RF) |
| --- | --- | --- |
| `capture-scene`, `-inline`, `capture-animate` | `unsupported` (`extra-canvas` only) | — |
| `capture-refused` | `unsupported` (`extra-canvas`, `canvas-light`, multimesh and LCD `unsupported-op`, `unsupported-material`) | — |
| `receiver-scene`, `-patch`, `-inline`, `receiver-animate`, `receiver-refused` | `unsupported` | `success`: every pixel of every shot equals the reference |
| `sabotage-freeze` (@11), `-omit-transform` (@21), `-perturb-vertex` (@21) | `unsupported` | `pixel-mismatch` at exactly the predicted (shot, region) sets |
| `sabotage-perturb-shader` (@21) | `unsupported` | `success` (SM's shader is never re-coded; CM's are builtin) |
| `sabotage-receiver-ignore-clip`, `-stale-texture` | `unsupported` | `pixel-mismatch` at exactly the predicted sets |

Before G6b, /5 can only call the HUD's CanvasLayer `extra-canvas`, so every leg is `unsupported`
and the pixel verdict is judged outside `HU` (Q7b). Inside `HU` every honest receiver differs in
exactly the HUD panel's 168×28 pixels while the HUD shows above the root canvas, and nowhere at
steps 8 and 9.

**Measured budgets.** Reference against the hand model: 5 083 944 decided pixels over 30 shots
(twelve settle shots and frames 13, 53 and 93, both variants), 0 beyond their allowance; 80 388 use
delta 1 (the translucent, off-grid theme boxes and MS's gradients). `reference-repeat` and
`reference-armed` against `reference`: 0 of 3 456 000 pixel-shots each, in every region and pixel
class (exact 2 539 436, delta1 88 936, band 115 422, undecided 712 206). Receiver against reference:
0 in every compared pixel of every shot (3 348 992 per leg; 3 176 192 for `refused`), so the Q6g
budget is 0 everywhere.

**Checks** (`lib/gate6a-checks.ts`): `expected-self-consistent`, `leg-class-*` for the 4 captures
and 11 receivers, `headless-no-gpu`, `recordings-decode` (full sink 39.5 MB, patch 1.59 MB over 400
frames), `patch-resolves-to-full`, `step-log`, `draw-index-tie`, `expected-image-reference`,
`presence-reference` (692 shape-shots), `freshness-reference`, `reference-repeat-budget`,
`armed-transparent`, `scroll-parity`, `atlas-parity` (four LA8 pages at every step, both
directions, both sinks), `param-parity`, `line-edit-geometry` (36 selection and caret rects equal
the oracle's), `scene-census` (TEXN, TEXA, TEXB with predicted GRT1 hashes, 111 MS region updates,
34 SM parameter writes, CM builtin add at 1 and sub at 41, the HUD hidden over 81..90; the animate
capture's five TEXA versions) and `receiver-vs-reference`.

**Runs** (same build, all under `artifacts/render-stream/<gate>/g6a-final/`, ignored): gate 6
`--legs g6a` 32/32; gate −1 PASS; gate 0 PASS; gate 1 66/66; gate 2 85/85; gate 3 56/56; gate 4
185/185; gate 5.5 130/130; gate 5 failed 114/116 once on g5f's live `pins-bounded` /
`obsolete-retired` ("servable, named by nothing" at frame 851, the known live timing flake) and
passed 116/116 on the one rerun (`gate5/g6a-final-rerun/`). After merging G6k: gate 6 32/32,
gate −1 PASS (79 hooks) and gate 0 PASS under `<gate>/g6a-final2/`.

### Findings

- **No frame-1 tie.** Items created in `_ready()` get their top-level draw index inside frame 1, so
  Q6b's predicted `Scene`/`TL` tie never appears; Q6b's fallback is not needed.
- **LineEdit's selection draws with or without focus** (a scratch probe on the headless capture),
  and its carets sit on the baseline (`le.cpp:1466`), not at the selection's top.
- **The contract's sets were amended by the model and confirmed by the run**: TR redraws when its
  texture updates; HU is not fresh at step 9 (the layer behind the root canvas is under BG); PB
  redraws on every frame (step 0.01) and needed its box set again inside the tree; RT's image is
  scrolled out from step 5, so `stale-texture` reaches RT at 3 and 4 only; `perturb-vertex` also
  reaches RT through its own scrollbar. All in gate6-design.md "As built (G6a)".
- **Determinism needs quarter-frame clocks.** Sampling AnimationPlayers and the Tween at
  (f + ¼)/60 s keeps every key, loop end and rounding threshold away from accumulated float error.

### Deviations

- The receiver `stale-texture` sabotage did not exist (G2b2's is a host sabotage); G6a adds one,
  scoped to RGBA8 images so font atlases keep text honest.
- `line-edit-geometry` and `step-log` are checks beyond Q7b's list; the HU exactness is added to
  `receiver-vs-reference`.
- Sabotage captures run the default 122 frames, not 400.
- RT's line 3 reads "line 3" so the clip-escape prediction stays inside one region.

### What G6a does not prove

- The HUD layer end to end (G6b on /6), the 1920×1080 `canvas_items` fixture (G6h), live motion,
  stalls and reconnect on this scene (G6l), rates (G6c), stability (G6s) and costs (G6p).
- Text glyph pixels against a hand model: text stays undecided, covered by receiver equality and
  atlas parity only.
- Exactness on another GPU or driver, and browser receivers (gate 7).

Images (under the run directory): `scene/reference/shots/{step-0..11,frame-13,frame-53,frame-93}.png`
against `scene/receiver/shots/seq-<frame>.png`; the refused variant under `refused/`; each
sabotage's shots under `scene/sabotage-*/receiver/shots/` and `scene/sabotage-receiver-*/shots/`.
