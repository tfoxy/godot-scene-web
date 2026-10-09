# Gate 0 fixture

The reference rendering for gate 0 (`../../protocol/gate0-design.md`): one opaque `Subject` rect
and one `Marker` rect, both `Node2D`s drawn through `_draw()`, moved and recoloured through a
fixed 5-step timeline. This project does not know about the capture library -- it runs
identically whether `GRC_EXTENSION` is set or not (see `loader.gd`), exactly like
`fixtures/spike/`.

## Running under the release template needs one prior step

Same as `fixtures/spike/` (see its README "Running a loose project directory under the RELEASE
TEMPLATE needs one prior step" for the full explanation and citations): the release template
cannot load a bare project directory until `.godot/` exists, so every launch is preceded by

```bash
mise exec -- godot --headless --path fixtures/gate0 --import
```

This is cheap and idempotent; re-run it whenever the fixture changes.

## What's in the scene

- `project.godot`: 640x360, `stretch/mode` `disabled`, vsync off, `gl_compatibility` (desktop and
  mobile), `msaa_2d=0`, `hdr_2d=false`, `default_clear_color=Color(0.2, 0.2, 0.4, 1)` (byte
  `[51, 51, 102, 255]`), the same `[debug]` warning-to-error keys as the spike fixture
  (`untyped_declaration`, `unsafe_property_access`, `unsafe_method_access`, `unsafe_cast`,
  `unsafe_call_argument`, all level 2), autoload `GrcLoader="*res://loader.gd"`, and
  `run/main_scene="res://gate0.tscn"`.
- `loader.gd`: a copy of `fixtures/spike/loader.gd`. Loads `GRC_EXTENSION` (absolute
  `.gdextension` path) in `_enter_tree()` when set; prints a skip line otherwise. Autoloads enter
  the tree before the main scene, so this always arms (or no-ops) first.
- `gate0.tscn`: a root `Node` (NOT a `CanvasItem`) with script `gate0.gd`, and nothing else.
- `gate0.gd`: an inner class `RectNode extends Node2D` with `rect: Rect2`, `color: Color`,
  `circle: bool`, and a `_draw()` that calls `draw_rect(rect, color)`, then (when `circle` is set)
  `draw_circle(Vector2(16, 16), 8.0, Color(0, 0, 0, 1))`. `_ready()` creates `Subject`, then
  `Marker`, with `add_child` in that order -- both strictly after the capture extension would have
  armed (see "Startup order on 4.5.1" in the design doc), so the mirror sees each one's
  `canvas_item_create`. `_process()` advances the timeline below. All output lines start with
  `[fixture]`.
- `preexisting.tscn`: the same `gate0.gd` script, on a scene that also declares a static
  `Preexisting` `Node2D` child directly in the `.tscn` (no script). That node is constructed while
  the packed scene is instantiated, which happens before the extension arms, so its later
  `canvas_item_set_parent` names an item RID the mirror never saw created -- the fixture half of
  the `preexisting` leg's `pre-existing-object` capture failure (gate0-design.md "Unknown-RID
  policy"). This file exercises that structure; the capture-side classification is gate 0
  integration (WP6), not this fixture.
- `expected.json` (`render-stream-gate0-expected/1`): the only source of the numbers below. See
  "expected.json schema" further down.

## Timeline

Step _k_ ≥ 1 is applied in `_process()` at frame `10k+1` (position and/or colour, then
`queue_redraw()` on whichever node changed) and settles at frame `10k+8`. Step 0 is the `_ready()`
state, "applied" at frame 1 and settled at frame 8. The Marker's colour changes on every step, so
a stale (un-redrawn) frame would be visible at every step if something failed to redraw.

| step | applied | settle | change        | Subject pos | Subject rect (local) | Subject colour  | Marker colour |
| ---- | ------- | ------ | ------------- | ----------- | -------------------- | --------------- | ------------- |
| 0    | 1       | 8      | initial       | (160, 96)   | (0, 0, 96, 64)       | (1, 0.4, 0)     | (1, 1, 1)     |
| 1    | 11      | 18     | move only     | (288, 96)   | same                 | same            | (1, 1, 0)     |
| 2    | 21      | 28     | colour only   | (288, 96)   | same                 | (0, 0.6, 1)     | (0, 1, 1)     |
| 3    | 31      | 38     | move + colour | (416, 224)  | same                 | (0.8, 0.2, 0.6) | (1, 0, 1)     |
| 4    | 41      | 48     | marker only   | (416, 224)  | same                 | same            | (0, 1, 0)     |

The Marker's node position is fixed at `(16, 16)` with local rect `(0, 0, 32, 32)` throughout --
only its colour (and, under the `unsupported` variant, its draw list) changes. Every colour
component is in `{0, .2, .4, .6, .8, 1}`, which maps exactly to byte `{0, 51, 102, 153, 204, 255}`
(no rounding). All positions and sizes are integers, and the Subject and Marker rects never
overlap. The fixture calls `get_tree().quit()` once `RS_FIXTURE_QUIT_FRAME` is reached (default
52; the capture leg uses 400 so its `/proc` sampling has time to run).

## Environment

All optional:

| Variable                | Meaning                                                                                                                                                                                 |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GRC_EXTENSION`         | absolute `.gdextension` path for `loader.gd` to load in `_enter_tree`                                                                                                                   |
| `RS_FIXTURE_STEP_LOG`   | absolute path. At each step's applied frame, one JSONL line `{"step":k,"applied_frame":a,"settle_frame":s}` (keys in that order) is appended and flushed                                |
| `RS_FIXTURE_SHOT_DIR`   | absolute directory. At each settle frame, if the display server is not `headless`, awaits `RenderingServer.frame_post_draw` then saves `step-<k>.png`. Under `headless`, logs and skips |
| `RS_FIXTURE_VARIANT`    | unset/empty runs the normal fixture. `unsupported` makes the Marker also `draw_circle` from step 2 on. Any other value prints an error and quits with code 2                            |
| `RS_FIXTURE_QUIT_FRAME` | integer ≥ 52, default 52                                                                                                                                                                |

## expected.json schema

`render-stream-gate0-expected/1`:

```jsonc
{
  "schema": "render-stream-gate0-expected/1",
  "viewport": [640, 360],
  "clear_rgba8": [51, 51, 102, 255],
  "quit_frame_default": 52,
  "steps": [
    {
      "step": 0,
      "applied_frame": 1,
      "settle_frame": 8,
      "subject": {
        "rect_px": [160, 96, 96, 64], // [x, y, w, h] in viewport pixels: node position + local rect
        "color": [1, 0.4, 0, 1], // Godot float colour
        "rgba8": [255, 102, 0, 255], // exact byte form of `color`
      },
      "marker": {
        "rect_px": [16, 16, 32, 32],
        "color": [1, 1, 1, 1],
        "rgba8": [255, 255, 255, 255],
      },
    },
    // ... one entry per step, 0..4
  ],
  "unsupported_variant": { "from_step": 2, "op": "canvas_item_add_circle" },
}
```

`scripts/lib/gate0-expected.ts` exports `synthesizeExpected(expected: GateZeroExpected, step:
number): {width, height, rgba: Uint8Array}` (640x360 RGBA, alpha 255 everywhere): it fills the
whole buffer with `clear_rgba8`, then paints the Subject's `rect_px` with its `rgba8`, then the
Marker's `rect_px` with its `rgba8` -- the same bottom-to-top paint order the fixture itself uses
(Subject added before Marker in `_ready()`). This is pure: no file I/O, no Godot. The checker
(WP5) reads `expected.json` itself and passes the parsed object in.

## Verification run (this work package)

```bash
mise trust   # once per worktree
mise exec -- godot --headless --path fixtures/gate0 --import
mise exec -- godot --headless --path fixtures/gate0
# -> "[fixture] extension load status=skipped (GRC_EXTENSION not set)"
# -> 5 lines of "[fixture] quitting frame=52"-adjacent output, no SCRIPT ERROR / WARNING
```

with `RS_FIXTURE_STEP_LOG=/abs/steps.jsonl` producing exactly 5 lines (steps 0..4, frames matching
the table above), and separately:

```bash
RS_FIXTURE_VARIANT=unsupported mise exec -- godot --headless --path fixtures/gate0   # exit 0
mise exec -- godot --headless --path fixtures/gate0 --import                          # (preexisting.tscn)
mise exec -- godot --headless --path fixtures/gate0 res://preexisting.tscn            # exit 0
```

A rendered run (private `gamescope --backend headless`, never Xvfb, never a desktop window -- see
`../../scripts/lib/gamescope.sh`) on the pinned release template, with the capture extension
absent and `RS_FIXTURE_SHOT_DIR` set, writes `step-0.png` .. `step-4.png`; each must equal
`synthesizeExpected(expected, k)` exactly (every pixel, every channel, alpha 255).
