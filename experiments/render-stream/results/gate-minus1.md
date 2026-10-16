Gate −1 of [docs/handoff-headless-render-stream.md](../../../docs/handoff-headless-render-stream.md).
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

## Gate −1 result (2026-10-08)

**Pass.** The integrated run is
`artifacts/render-stream/gate-minus1/20261009T020323Z/` (ignored, not committed; produced
in the integration worktree). Its `result.json` passes 18 of 18 checks across the eight
criteria in [scripts/README.md](../scripts/README.md). The fixture is `fixtures/spike/` on
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
listed in [scripts/README.md](../scripts/README.md) as #7 `new-drawings-visible`,
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

