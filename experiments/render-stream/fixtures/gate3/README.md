# Gate 3 fixture

The reference rendering for gate 3's axis-aligned clipping increment (G3a,
[`../../protocol/gate3-design.md`](../../protocol/gate3-design.md) "Q6b"). Ten steps (0..9)
cover the following: three levels of nested `clip_contents` Controls, a non-clipping
intermediate, a child in a higher z list that keeps its ancestor's scissor, content moving across
a clip edge, a clip window that slides with no redraw, a resize that re-sends the clip through a
redraw, a clip toggled off and on, a clipping item redrawn with its clip unchanged, the raw-RS
clear/custom-rect cases, a custom rect acting as the visibility (cull) rect, and an anchored clip
that depends on the root size. Like the gate 0 to 2 fixtures, the project does not know about the
capture library and runs the same whether `GRC_EXTENSION` is set or not.

Import it once with the mise editor before the release template can run it:

```bash
mise exec -- godot --headless --path experiments/render-stream/fixtures/gate3 --import
```

## Files

- `project.godot`: gate 1's settings (640×360, stretch `disabled`, `gl_compatibility`,
  `msaa_2d=0`, `hdr_2d=false`, clear colour `(0.2, 0.2, 0.4, 1)`, the same `[debug]`
  warning-to-error keys, autoload `GrcLoader`).
- `loader.gd`: gate 1's loader.
- `gate3.tscn`: a root `Node` (not a `CanvasItem`) with `gate3.gd`.
- `gate3.gd`: builds every item in `_ready()` in `expected.json` `creation_order` (wire ids
  1..18). That is 15 Controls (`ColorRect` fillers that overhang their clip owner, plain
  `Control`s for `A`, `B`, `N`, `C` and the anchored `AN`, and the cull probe `CU`), the `Marker`
  (a `Node2D`), then the raw `RenderingServer` items `RC` (draw index 1000, custom rect, clip, no
  commands) and `RCF`, its only child. `_process()` applies the timeline. `RS_FIXTURE_VARIANT` is
  refused (exit 2); G3d adds `clip-ignore`. All output lines start with `[fixture]`.
- `cull_probe.gd`: `CU`, a Control whose own draw lies 56 px right of its rect.
- `make_expected.py`: writes `expected.json` (`--check` compares values). It models the engine's
  clip semantics from the source over the fixture's own parameters (its docstring cites the
  lines). It also asserts that the derivation equals the contract's hand table, that `CU` is
  culled exactly at steps 0 and 1, and that every owner edge has decisive probes (only `D.left`
  is listed). Nothing in it is measured.
- `expected.json` (`render-stream-gate3-expected/1`, gate3-design.md Q6c) holds the following.
  Per step: the draws in paint order with each one's effective scissor (`clip_px`), the culled
  items, every owner's final scissor (`clip_rects`), the named probes, and the retained-state
  invariants (`clip`, `custom_rect`, `commands`, `content_unchanged`, `version`, `canvas_xform`).
  Across the run: the contract's hand table (`hand_clip_rects`), `non_decisive_edges`, the hook
  census totals (`census_totals`), and the predictions for gate 3b's sabotage, receiver and
  root-size legs.

## Timeline

`S` = `RS_FIXTURE_START_FRAME` (default 1) and `N` = `RS_FIXTURE_STEP_FRAMES` (default 10, at
least 8). Step 0 is the `_ready()` state at frame 1. Step _k_ ≥ 1 is applied at `S + N·k` and
settles at `S + N·k + 7`. The fixture quits at `S + N·9 + 11` (102) unless
`RS_FIXTURE_QUIT_FRAME` asks for later. Every step recolours the `Marker`.

| step | change                                                                  | Controls redrawn                    |
| ---- | ----------------------------------------------------------------------- | ----------------------------------- |
| 0    | initial                                                                 | all 15                              |
| 1    | `S1` moves across `A`'s right edge                                      | none                                |
| 2    | `B`, `BF` and `CU` move (B's window slides, `BF` stays put globally)    | none                                |
| 3    | `B.size = (60, 50)`                                                     | `B`                                 |
| 4    | `A.clip_contents = false`                                               | `A`                                 |
| 5    | `A.clip_contents = true`; `D.color` changes                             | `A`, `D`                            |
| 6    | `RC`: clear, add_rect, no `set_clip`                                    | none (`RC` is raw)                  |
| 7    | `RC`: clear, add_rect, `set_custom_rect(false)`, `set_clip(true)`       | none                                |
| 8    | `RC`: clear, `set_clip(true)`                                           | none                                |
| 9    | the root canvas transform shifts by (8, 4)                              | none                                |

The final scissors per step are gate3-design.md Q6b's table, and `expected.json` `clip_rects`
reproduces it exactly.

## Environment

| Variable                 | Meaning                                                            |
| ------------------------ | ------------------------------------------------------------------ |
| `RS_FIXTURE_STEP_LOG`    | absolute path: one JSONL line per step at its applied frame        |
| `RS_FIXTURE_SHOT_DIR`    | absolute dir: `step-<k>.png` at each settle frame (rendered runs) |
| `RS_FIXTURE_START_FRAME` | `S` ≥ 1, default 1                                                 |
| `RS_FIXTURE_STEP_FRAMES` | `N` ≥ 8, default 10                                                |
| `RS_FIXTURE_QUIT_FRAME`  | ≥ the default `S + N·9 + 11`                                       |
| `RS_FIXTURE_VARIANT`     | refused in G3a (exit 2)                                            |
