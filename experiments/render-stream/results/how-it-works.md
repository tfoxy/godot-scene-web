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

