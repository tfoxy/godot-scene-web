# TW: would tween descriptors save STS2's warm bytes? (2026-10-28)

**No: at most 132 B of a 12,477 B warm combat frame (−1.1 %), and realistically a few tens.**
TW measured this on the kept /11 recording `w11b-a11-1`. Each warm transaction was rebuilt as if
every item transform and modulate change were free (the most any tween-descriptor scheme could
remove), and coded with W11t's base-prefix zstd-3 against its own previous message:

- **Combat:** 12,477 → 12,345 B a frame.
- **Map:** 293 → 183 B.
- **Menu:** 1,012 B, unchanged. Nothing but spine meshes moves there.

Spine mesh entries and bodies are 12,119 B (97 %) of the combat frame.

The moving items are also mostly not tween-shaped. Only 30 of 1,380 warm-combat
transform/modulate runs fit one standard Godot easing curve. The rest are continuous orbits,
bobs and redrawn text.

Design and verdict (no-go, with a reopen criterion):
[protocol/tween-descriptors-design.md](../../protocol/tween-descriptors-design.md).
It also answers the observability and parity questions from the engine source. TW is docs only,
with no game launch and no wire change.

## Method

- **Recording.** `artifacts/render-stream/p3/fidelity-data/w11b-a11-1/capture/recording-patch.rs11`
  (/11, stable `content_version`, patched `unsupported`).
  - The scenes are W11b's: menu 82–1541, map 1544–2296, combat from 2305.
  - A transaction is warm 30 frames after its scene starts and is a patch, as in WB.
  - That gives 1,418 / 722 / 2,666 warm transactions.
- **Classification.** Each patched item is compared with its resolved previous state:
  - header keys other than `content_version`;
  - the 18 `item_f32` floats, split into transform 0–5, modulate 6–9, self_modulate 10–13 and
    custom rect 14–17;
  - the command list's structure, and its floats (`add_set_transform` against every other op).
- **Arms.** Each arm rebuilds the message's items, `item_f32` and `cmd_f32`, with command `f`
  offsets renumbered. Everything else in the message is the recording's.
  - **base:** the message as recorded. It reserializes to 78,407.9 B a combat frame, equal to the
    records' own size, and codes to 12,477 B (W11b measured 12,467).
  - **A, transform and modulate free:** an item's transform, modulate and self_modulate floats
    are reset to the base's. An item with no other change leaves the patch.
  - **B:** A, plus `add_set_transform` command floats free. It is identical to A: those floats
    never changed alone.
  - **C, all items free:** the patch carries no items, the ceiling of any item-level scheme.
  - **D, meshes free:** no mesh entries, `mesh_u8` or `mesh_f32`.
  - Each arm is coded with zstd-3, using that arm's previous message as a raw prefix
    (`ZstdDict(prev, is_raw=True).as_prefix`). That is W11t's coding as WB modelled it, with the
    envelope ignored.
- **Is it tween-shaped?** A *run* is an item's consecutive frames in which a transform or
  modulate float changes. The test, for each run of three frames or more:
  - The start is the item's value before the run and the end is its last value.
  - The duration D is swept over (t_{L−1}, t_L], with times from each transaction's `shader_time`.
  - It is tested against Godot's easing families in, out, in_out and out_in: linear, sine, quad,
    cubic, quart, quint, expo, circ and back (`scene/animation/easing_equations.h`). Elastic,
    bounce and spring were not tested.
  - Fit means that every moving component lies within 0.2 % of its span, with one curve and one D
    for all of them.
  - A sinusoid fit, `A·sin(ωt) + B·cos(ωt) + c` least squares over 600 frames, was tried on the
    four most frequent movers, against both clocks.
- **Load.** The scan ran under `quiet.sh shared` (about 1 min).

## Bytes (warm, per frame, base-prefix zstd-3)

| arm | menu | map | combat | combat Δ |
| --- | ---: | --: | -----: | -------: |
| base (/11 as recorded) | 1,012.1 | 292.6 | **12,477.2** | — |
| A: item transform and modulates free | 1,012.1 | 182.9 | **12,344.6** | **−132.6 (−1.06 %)** |
| B: A + `add_set_transform` floats free | 1,012.1 | 182.9 | 12,344.6 | −132.6 |
| C: all items free | 1,012.1 | 36.0 | 12,046.8 | −430.4 (−3.4 %) |
| D: meshes free | 173.1 | 292.6 | 358.0 | −12,119.2 (−97.1 %) |

Raw, uncoded (the `GRC_LIVE_CODING=off` case, not a target):

| arm | menu | map | combat |
| --- | ---: | --: | -----: |
| base | 16,667.6 | 10,507.4 | 78,407.9 |
| A | 16,667.6 | 8,375.8 | 75,394.2 (−3,014, −3.8 %) |
| C | 16,667.6 | 978.0 | 67,465.6 |
| D | 3,070.1 | 10,507.4 | 11,965.5 |

The combat categories (raw, per frame) are items JSON 7,371, `item_f32` 565, `cmd_f32` 3,005,
mesh entries JSON 24,942, `mesh_u8` 39,012 and `mesh_f32` 2,484.

The ceiling counts no descriptor bytes, no clock key and no corrections.

- **Per moving item.** Base-prefix zstd already codes one moving item-frame in about 22 B
  (132.6 B over the 6.0 items arm A removes).
- **Per descriptor.** A descriptor costs about 40–80 B each time it starts (item, channel, two
  endpoints, duration, transition, ease, start clock). Combat's runs are mostly 4–15 frames long,
  so that amortizes to 3–20 B a frame for each descriptor.
- **The process clock** a parity-safe tier needs adds about 8 B raw to every transaction.

## Which items move (combat, per warm frame)

| change class | items / frame |
| ------------ | ------------: |
| transform only | 5.71 |
| command floats other than `add_set_transform` (redrawn text, a ~15 fps frame animation) | 1.73 |
| modulate only | 0.21 |
| command structure | 0.06 |
| transform + modulate | 0.05 |
| header changes (re-parenting, visibility, `draw_index`) | ≈ 0.1 |
| **patched items, total** | **7.83** |

The menu patches no items: its motion is entirely spine poses. The map's movers are 4.0
transform-only and 1.0 command-float items a frame.

## Is it tween-shaped?

| combat runs | count | moving item-frames |
| ----------- | ----: | -----------------: |
| all | 1,380 | 16,272 |
| length 1 / 2–3 / 4–15 / 16–60 / > 60 | 97 / 40 / 1,208 / 27 / 8 | |
| fit one standard easing curve (≤ 0.2 % of span) | **30** | **382 (2.3 %)** |
| of which linear / expo-out / quad-out / back-out | 23 / 3 / 3 / 1 | |

- **By what moves:** origin 9,738 frames, origin + linear part (rotation or scale) 5,704,
  modulate 423, origin + modulate 249, all three 158.
- **On the map,** 0 of 107 runs fit. Its movers turn as well as translate.
- **The frequent movers** are a few items that move for the whole combat:
  - two items in a continuous rotation (8329, 8330, a 2,571-frame run each);
  - four that bob between about 0 and 2 px (8394, 8400, 8406, 8412);
  - a text item that re-records its glyph floats every frame (5474).
- **No simple model reproduces them.** A single sinusoid leaves 3–10 px of residual over 600
  frames on both the `shader_time` clock and frame/60.
  - These are compound or script-driven motions, or looping tweens on a clock the wire does not
    carry. The RS stream cannot tell which.
  - In every case, inference would have to correct most frames.

## Engine-source facts the design relies on (Godot 4.5.1)

- `SceneTree::process_tweens` steps each tween with the tree's process delta. Under
  `ignore_time_scale` it uses the unscaled `Engine::get_process_step()`, for physics-mode tweens
  too. It runs after `_process` and the timers (`scene/main/scene_tree.cpp:648, 717, 812-838`).
- `Tween::step` scales by `speed_scale` and carries leftover delta across finished tweeners and
  loops (`scene/animation/tween.cpp:315-407`).
- `PropertyTweener::step` writes through `set_indexed`. `from_current` and `do_continue` read the
  start value at `start()` or after the delay (`:595-660`).
- `Tweener::start` and `step` are virtual. `Tween`'s and `PropertyTweener`'s builder methods are
  not (`tween.h:39-47`).
- `SceneTree.get_processed_tweens()` is bound, but no getter for tweeners or their fields is
  (`tween.cpp:466-496`).
- Penner's functions call `std::cos`, `std::sin` and `std::pow` with mixed float and double
  arguments. Interpolation is `Vector2::lerp` / `Color::lerp` in float
  (`scene/resources/animation.cpp:6184-6207`).
- `Node2D::_update_transform` → `set_rotation_scale_and_skew` → `canvas_item_set_transform`
  (`scene/2d/node_2d.cpp:135-139`).
- `Control::_update_canvas_item_transform` applies the pivot and, under
  `snap_controls_to_pixels`, `floor(origin + 0.5)` (`scene/gui/control.cpp:716-725`).
- `CanvasItem::set_modulate` is a direct RS setter (`scene/main/canvas_item.cpp:474-481`).

## Validation

- **Docs only.** The diff is `protocol/tween-descriptors-design.md` and this file.
  `validate-increment.sh --plan` maps the diff to the `pure` target alone, with 57 targets out
  of reach.
- **The smoke tier ran it:** 92 of 93 pure self-tests pass (897 s, no lock). The one failure is
  `self-test-rs-ws`, because the fresh worktree has no `capture/build/rs_ws_echo`: the build step
  was skipped, since a docs diff cannot reach the capture. It is a missing build, not a result.
- The scan's base arm reproduces the recording's own sizes: reserialized 78,407.9 B against the
  records' 78,407.9 B, and coded 12,477 against W11b's 12,467. That is the cross-check for the
  rebuilt arms.

## Deviations

- **One recording, STS2 only.** The `a8-2` /8 and `p3tm-a10-2` /10 recordings predate the
  stable `content_version`, so their lean message differs by construction. WB's own split already
  covers them: item floats are 99 B and command floats 160 B under XOR+zstd.
- **The fit's clock is `shader_time`** (the `RS::draw` step), not the process delta a tween
  actually uses. The two agree except after a stall clamp (P3-CK), but the fit count is a lower
  bound on tween-shaped runs. The byte ceiling (arm A) does not depend on it.
- **Elastic, bounce and spring were not fitted**, and neither were chained, multi-step or
  custom-interpolated tweens. A run covering two chained tweeners fails a one-curve fit.

## Evidence

In the main checkout's ignored `artifacts/render-stream/p3/tw/`:

- `tween-scan.py` (the arms and classes) and `scan.json` / `scan.log`, its per-scene totals
  (divide by `tx`);
- `tween-fit.py` and `fit.json` (the easing fit), and `bob-fit.py` (the sinusoid check).

Re-run (from a checkout whose `mise.toml` is trusted, for Python 3.14's `compression.zstd`):

```
mise exec -- python3 artifacts/render-stream/p3/tw/tween-scan.py \
  experiments/render-stream/scripts/lib/wire-budget.py \
  artifacts/render-stream/p3/fidelity-data/w11b-a11-1/capture/recording-patch.rs11 \
  scan.json menu:82-1541 map:1544-2296 combat:2305-99999
mise exec -- python3 artifacts/render-stream/p3/tw/tween-fit.py scan.json.series.pkl \
  menu:82-1541 map:1544-2296 combat:2305-99999
```
