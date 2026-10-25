# P3 part 1: gates −0.5 and −0.25 re-run on the installed STS2 (2026-10-25)

**Gate −0.5: pass. Gate −0.25: pass.** The current capture library (GSW `main` `d9b30287`, 79 hooks)
validated the installed game binary, refused the every-index-+1 record, armed counters for 2000 frames
on the main menu and disarmed cleanly. It needed no change to `calibrate.py` or to the capture code.

The user approved the game launches for this increment. Every launch was an owned, isolated
`--headless` instance under sts2-couch-coop's live-QA instance rules. Evidence, including the
game-derived calibration records, stays in sts2-couch-coop's ignored research folder
`.sts2/research/render-stream-p3-20261025/` (`README.md` there). Nothing game-derived is committed here.

## Target

| Fact            | Value                                                                                   |
| --------------- | --------------------------------------------------------------------------------------- |
| Game            | stable `v0.107.1` (release commit `59260271`), Steam build id 23811903                  |
| Engine string   | `MegaDot v4.5.1.m.12.mono.custom_build`, non-PIE, stripped GCC release template         |
| Executable      | sha256 `0c21999e…`, GNU build-id `9a404dfe…`                                            |
| Since last gate | Not the m.14 binary of the 2026-10-09 gates. Same executable as the 2026-10-10 shim leg |

## Calibration

`calibrate.py --version-name MegaDot` (calibrator 9) against the pinned 4.5.1
`servers/rendering_server.h`, offline and read-only:

- 588 slots: Object prefix **23** plus 565 `RenderingServer` virtuals.
- Anchors **17/17**, unique mask with no interior insertion, pure placeholder 0.
- All 81 named slots and all 17 anchors are identical to the stock 4.5.1 `linux_release` record.

The negative record is `tamper-calibration.mjs prefix`, which shifts every index by +1.

## Load route and instance

- **Loader.** The couch-coop F2 loader: sts2-couch-coop `main` `4e852b09` plus cherry-picked `14f4434b`,
  built in a scratch worktree with `build-local-mod.sh --output <private dir>`. It was never deployed into
  the install. `sts2 code verify-references` against the install reports 0 breaks. The extension is
  named by `COUCHCOOP_RENDER_CAPTURE_EXTENSION` and loads at mod init with `LoadStatus` `Ok`. It decided
  at `scene-init`.
- **Not the streaming-seat build.** This is not C1's `e86f9405` build, so `COUCHCOOP_STREAMING_SEAT` was
  not set. The headless visual suspender was **active** (`[couchcoop][suspend]`, idle frame cap 8). No
  texture-evictor lines appeared. Neither matters for these gates.
- **Instance.**
  - Each batch ran inside one `live-qa-lock with` holding `shared:install`, `exclusive:game:c2-p3` and
    `exclusive:port:13757`.
  - The game root was a private farm: the executable copied byte-identical, the content symlinked, and
    its own `mods/`.
  - It had a private XDG root with the offline `default/1` profile seeded, its own bridge socket and
    scrubbed display variables.
  - argv was `SlayTheSpire2 --headless --force-steam off`.
  - Teardown was by pid, with the identity re-proved, from an EXIT trap.

## Legs

| Leg              | Mode                                       | Outcome                                                                                         |
| ---------------- | ------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| `validate-1`     | `GRC_MODE=validate`                        | `validated`, 14/14 checks, `hook_plan` 79 of 79, anchors 17/17 in memory, `vptr_written` false  |
| `refuse-plus1-1` | validate, +1 record                        | `refused` `slot-mask-mismatch`, anchors 11/17 (first mismatch at slot 24), probe never reached  |
| `arm-1`          | `GRC_MODE=arm`, counters only, 2000 frames | armed at launch +0.9 s, disarmed at frame 2000 (227.7 s), `vptr_was_shadow` and `vptr_restored` |
| `control-1`      | no extension                               | the same readiness, used to attribute the teardown behaviour                                    |

`validate-1` also matched the executable digest, the version string, the build-id and a zero bias. The
live concrete vptr was the recorded address +16. The hooked slots were pure in the abstract table and
implemented in the concrete one. The `get_default_clear_color` probe was byte-equal through the slot
and through the method bind.

Readiness was the couch-coop browser server plus `Preloading 'Common' Complete`, reached in 7-8 s on
every leg. Gate −0.5 on 2026-10-09 took 27 s. Every leg was alive 30 s after readiness, or 30 s after
the disarm on `arm-1`.

## Gate −0.25 counts (`arm-1`, 2000 armed frames, main menu)

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
| `canvas_item_add_particles`                | 3      |
| `canvas_item_add_multimesh`                | 1      |
| `mesh_create`                              | 83     |
| `texture_2d_create`                        | 1 441  |
| `texture_2d_update`                        | 280    |
| `canvas_item_add_triangle_array`           | 0      |
| `canvas_item_add_polygon`                  | 0      |
| `canvas_item_add_nine_patch`               | 0      |

- **Rectangles and texture rects are nonzero.** The triangle traffic is spine-godot's mesh path, as on
  2026-10-09: `add_mesh` plus three equal per-frame mesh updates. The rigs are drawn by a third-party
  extension and animate under the dummy renderer. `add_triangle_array` itself stays 0 on this scene.
  The draw counts match 2026-10-09 exactly. Only the texture counts moved (m.12 against m.14).
- `hooks_omitted` is empty.
- The frame interval averaged 112.8 ms, which is the suspender's 8 fps idle cap.
- RSS was flat at 781-785 MB, with 34-37 threads.

## Teardown, safety and durations

- **Teardown.** TERM-to-exit took 14 s (`refuse-plus1-1`, SIGABRT) and 18 s (`control-1`, no extension,
  SIGABRT). `validate-1` and `arm-1` needed KILL after 25 s. `validate-1` had already printed
  `terminate called without an active exception`, the game's own abort. `arm-1` had been disarmed for
  30 s. The 2026-10-09 control leg also once needed KILL. So, as before, "no crash" is judged over the
  running window, which was clean on every leg.
- **Safety.** The Steam remote store (118 files), the operator's profile (271 files), the install's
  binaries, the install's `mods/` and the private mod build hashed identical before and after every leg.
  No game, crashpad or compositor process from this increment survives. Process lookup was by private
  XDG root, and no operator game was running.
- **Durations.** About 7 minutes of implementation: worktrees, the build, calibration and harness
  adaptation. About 9 minutes of game legs: four launches under the lease, from 08:56 to 09:06 UTC.
