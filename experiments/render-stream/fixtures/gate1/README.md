# Gate 1 fixture

The reference rendering for gate 1's retained-state increment (G1a,
[`../../protocol/gate1-design.md`](../../protocol/gate1-design.md) "Q6. Fixture (G1a)"). Eleven
steps each exercise one retained canvas behaviour: inherited modulate, transform-only moves, draw
order by index and by z, reparenting, visibility, content replacement, frees, re-attachment and
the canvas transform. A bottom-right-anchored `ColorRect` exposes the headless root size. Like
`fixtures/gate0/`, the project does not know about the capture library. It runs the same whether
`GRC_EXTENSION` is set or not (`loader.gd` is gate 0's loader).

Before the release template can run it, import it once with the mise editor (see
`fixtures/spike/README.md`):

```bash
mise exec -- godot --headless --path experiments/render-stream/fixtures/gate1 --import
```

## Files

- `project.godot`: gate 0's settings (640×360, stretch `disabled`, `gl_compatibility`,
  `msaa_2d=0`, `hdr_2d=false`, clear colour `(0.2, 0.2, 0.4, 1)`, the same `[debug]`
  warning-to-error keys, autoload `GrcLoader`), with `run/main_scene="res://gate1.tscn"`.
- `gate1.tscn`: a root `Node` (not a `CanvasItem`) with `gate1.gd`.
- `gate1.gd`: an inner class `RectNode extends Node2D` that draws a list of `(Rect2, Color)`
  pairs. `_ready()` constructs every item in `expected.json` `creation_order` (wire ids 1..19),
  then adds the raw `RenderingServer` items `Y` and `X`. `_process()` applies the timeline. All
  output lines start with `[fixture]`.
- `expected.json` (`render-stream-gate1-expected/1`): the only source of the numbers. It holds the
  regions, the creation order and, per step, the draws in paint order, the marker colour, the
  root canvas transform and the retained-state invariants. The draws were derived by hand from
  gate1-design.md Q2. The reference and the receiver both have to match them exactly
  (`expected-image-*`).

## Timeline

`S` = `RS_FIXTURE_START_FRAME` (default 1) and `N` = `RS_FIXTURE_STEP_FRAMES` (default 10, at
least 8). Step 0 is the `_ready()` state at frame 1. Step _k_ ≥ 1 is applied in `_process()` at
frame `S + N·k`, and every step settles at `S + N·k + 7`. The fixture quits at `S + N·10 + 11`
(112 by default) unless `RS_FIXTURE_QUIT_FRAME` asks for later. Every step also recolours the
`Marker`, with one distinct colour per step that no other item uses.

| step | change                                                                                           |
| ---- | ------------------------------------------------------------------------------------------------ |
| 0    | creation, parenting, top-level draw indices                                                      |
| 1    | `P.modulate = (1,0,1)`, `C.self_modulate = (0,1,1)`                                              |
| 2    | `P` moved, `C` rotated 90° (transform only); `R1` recoloured                                     |
| 3    | `Q.move_child(Q2, 0)`: the draw indices swap, so `Q1` is drawn over `Q2`                         |
| 4    | `Q2.z_index = 1`: `Q2` on top again                                                              |
| 5    | `Q1` moved from `Q` to `R`, appended after `R1`, which it covers                                 |
| 6    | `V` hidden (with `V1`); `K` redrawn with one rect                                                |
| 7    | `V` shown; `V1.visibility_layer = 0` (culled); `K` cleared                                       |
| 8    | `L` and `M` (with `M1`) freed; raw `Y` freed, leaving `X` detached; `D` removed; `K` three rects |
| 9    | new `L2`; `D` added back with its old id; raw `X` freed; `R1` re-appended over `Q1`              |
| 10   | `get_viewport().canvas_transform` shifted by (8, 4)                                              |

## Environment

All variables are optional. An invalid value prints `[fixture] error: …` and quits with code 2.
That includes gate 0's `RS_FIXTURE_VARIANT`, because this fixture has no variants.

| Variable                 | Meaning                                                                                                              |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `RS_FIXTURE_STEP_LOG`    | absolute path: `{"step","applied_frame","settle_frame"}` per step, written at the applied frame (step 0 in `_ready`) |
| `RS_FIXTURE_SHOT_DIR`    | absolute directory: `step-<k>.png` after the settle frame's `frame_post_draw` (rendered only)                        |
| `RS_FIXTURE_ROOT_LOG`    | absolute path: one root-geometry line per settle frame (gate1-design.md Q1)                                          |
| `RS_FIXTURE_START_FRAME` | `S`, at least 1                                                                                                      |
| `RS_FIXTURE_STEP_FRAMES` | `N`, at least 8                                                                                                      |
| `RS_FIXTURE_QUIT_FRAME`  | at least `S + N·10 + 11`                                                                                             |

## Traps worth knowing before editing it

- **Wire ids are construction order.** `CanvasItem`'s constructor calls `canvas_item_create`, so
  reordering the `RectNode.new()` calls changes the ids and breaks the checker's name mapping
  (`creation_order`).
- **Top-level draw indices arrive one frame late.** A top-level item that enters a canvas at
  runtime keeps the RenderingServer default index 0 (a new item) or its old index (`D`), until
  `_top_level_raise_self` runs. That is a deferred group call queued while the message queue
  flushes, after `SceneTree::process`'s last `_flush_ugc`
  (`scene/main/scene_tree.cpp:708-709`). It therefore runs at the next iteration's first
  `_flush_ugc` (`:644`). In this fixture, step 8's `remove_child(D)` had already re-raised the
  top-level items to 10..16, so step 9's `L2`@0 and `D`@7 tie with nothing for that frame. Adding
  a top-level node while a sibling still holds index 0 gives a one-frame tie, which
  `no-draw-index-ties` reports. This was measured with a scratch copy of this fixture (README
  "Gate 1a result").
- **Colours.** Every drawn component is a multiple of 0.2 and every modulate component is 0 or 1,
  so every final channel is exactly k·51 (`expected-self-consistent`).
