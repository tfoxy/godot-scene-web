# Gate 8 canvas-group fixture (`gate8-cg`, CG1)

The fixture for render-stream/10's two item keys
([`../../protocol/render-stream-10.md`](../../protocol/render-stream-10.md)): `canvas_group`, the
state `clip_children` and `CanvasGroup` set through `canvas_item_set_canvas_group_mode`, and
`copy_to_backbuffer`, the state `BackBufferCopy` sets through `canvas_item_set_copy_to_backbuffer`.
Before /10 neither reached the wire, so every receiver drew the game's HP bars as square, full-height
fills (C3 gap 9, [`../../results/p3/p3-np.md`](../../results/p3/p3-np.md)). The scene does not know
about the capture. Gate 8's group `g8cg` runs it (`scripts/run-gate8.sh`,
`scripts/lib/gate8-cg-checks.ts`).

## Files

- `project.godot`: 640x360, no stretch, `gl_compatibility`, `msaa_2d=0`, default canvas filter
  nearest, autoload `GrcLoader`, main scene `cg.tscn`.
- `loader.gd`: loads the capture GDExtension when `GRC_EXTENSION` is set: in `_enter_tree` (an arm
  at birth, `RS_FIXTURE_ARM=born`, the default) or at fixture frame 12 (`RS_FIXTURE_ARM=late`, after
  the scene has drawn; the capture adopts it under `GRC_ADOPT=arm`). Unarmed otherwise (the
  `reference` legs).
- `cg.tscn` / `cg.gd`: a plain `Node` that builds every texture, material and item in `_ready`.
- `shaders/invert.gdshader`: `1 - ` the back buffer at `SCREEN_UV` (fixtures/gate55-screen's invert,
  read at level 0).
- `expected.json`: the hand-derived cells, wire states, model pixels and checkpoints the checker
  reads.

## Scene

Procedural textures only; nearest sampling at integer scales, or along an axis whose texels are all
equal (the HP bar's 16 to 18 px fill stretch, the mask's zero-width stretched centre), so no pixel
centre's colour rests on a texel-boundary tie.

| Cell | Position | Construction | What it proves |
| ---- | -------- | ------------ | -------------- |
| `HPBAR` | (40,32) | p3-np.md's HP bar node for node: `HpBackground` nine-patch (20x16, margins 9/0/9/0, modulated) at (-8,-3) 248x16; `ForegroundContainer` (a `Control`, no draw, clip only); `Mask` nine-patch (12x10 with pointed caps, alpha 0 outside the point, margins 6/0/6/0) stretched to 232x10, clip only; under it `HpMiddleground` (15x16 fill, margins 6/0/6/0, 229x18 at y -4, modulate orange) and `HpForeground` (232x18 at y -4, self-modulate red, clip and draw) | the fills are clipped to the mask's pointed 10 px alpha; the command-less container is no group; `HpForeground`'s clip-and-draw is ignored inside `Mask`'s open group |
| `HPLOW` | (40,72) | the same bar at a lower value (middleground 180, foreground 120 wide) | the orange middleground between them, clipped too |
| `CLIPDRAW` | (336,16) | a clip-and-draw `Sprite2D` owner (16x16 at scale 4, four alpha rings 255/192/128/64) over an opaque child overflowing it by 16 px | clip-and-draw with partial alpha |
| `GROUP` | (448,16) | a `CanvasGroup` (fit_margin 6, clear_margin 12, use_mipmaps, self-modulate alpha 0.6) over two overlapping 0.7-alpha `ColorRect`s | the group composites its children as one layer; non-default margins and `blur_mipmaps` travel |
| `NESTED` | (544,16) | a clip-only `Sprite2D` (a disc, scale 3) with a child, inside a `CanvasGroup` (defaults, self-modulate alpha 0.7) over a green backdrop | GLES3 keeps one open group: the inner owner draws plainly over its unclipped child |
| `BBV` | (40,136) | a backdrop, a `BackBufferCopy` in viewport mode, a yellow overlay, then a screen reader (invert) over the cell | the copy predates the overlay, so the reader hides it; without the copy the reader's own automatic copy would show it |
| `BBR` | (136,136) | a backdrop, a `BackBufferCopy` in rect mode over the cell's left half (the node at the origin: GLES3 reads the rect untransformed), then a screen reader over the cell | the left half reads the backdrop; the right half reads what BBV's whole-target copy left in the back buffer there, the clear colour. A whole-target copy instead (dropping the rect) shows the backdrop there |
| `TGL` | (232,136) | a diamond-mask `Sprite2D` with a child, `clip_children` disabled until step 2, then clip only | a state-only change: `set_clip_children_mode` does not redraw, so the patch carries the item with `commands: null` |
| `PLAIN` | (328,136) | a plain sprite | the control cell: no /10 state |

All cells sit in one canvas, in this tree order: every group's back-buffer work comes before BBV's
whole-target copy, which overwrites the back buffer, so BBV and BBR read the same back buffer
whatever the groups did.

The reference matches the model exactly (checked by `cg-reference-model`): BBV is 255 minus its
backdrop, BBR's right half is (204,204,153), 255 minus the clear colour (51,51,102), and HPBAR's fill
colour appears on none of the fill's 8 rows outside the mask.

## What each leg loses

| leg | loses | differs from the reference in |
| --- | ----- | ----------------------------- |
| `receiver-v9` (the /9 capture) | every /10 state | HPBAR, HPLOW, CLIPDRAW, GROUP, NESTED, BBV, BBR; TGL at step 2 |
| `sabotage-drop-canvas-group/receiver` | `canvas_group` | HPBAR, HPLOW, CLIPDRAW, GROUP, NESTED; TGL at step 2 |
| `sabotage-full-backbuffer-copy/receiver` | the rect of every copy (`Rect2()`) | BBR |

Each equals the reference everywhere else.

## Timeline

| frame | |
| ----- | - |
| 1 | checkpoint 0 (the scene `_ready` built); settles at 4 |
| 12 | the late arm (`RS_FIXTURE_ARM=late` only) |
| 14 | checkpoint 1: nothing changes (after a late arm, the adopted scene); settles at 17 |
| 20 | checkpoint 2: TGL's clip_children disabled -> clip only; settles at 27 |
| 35 | quit |

Under `RS_FIXTURE_ARM=late` the step log holds only checkpoints 1 and 2 (the recording starts at
the arm). The capture runs headless (the hooks see the calls; the dummy renderer draws nothing),
the references and receivers in one private 640x360 gamescope.

## Wire state

At checkpoints 0 and 1 (and 2, with TGL's mask added as a fourth commands-bearing clip-only item):

| `canvas_group` | items |
| -------------- | ----- |
| `clip_only`, 5, false, 0, false; no commands | 2 (`ForegroundContainer`) |
| the same; commands | 3 (`Mask` x2, NESTED's owner) |
| `clip_and_draw`, 5, false, 0, false; commands | 3 (`HpForeground` x2, CLIPDRAW's owner) |
| `transparent`, 12, true, 6, true; no commands | 1 (GROUP) |
| `transparent`, 10, true, 10, false; no commands | 1 (NESTED's `CanvasGroup`, the defaults) |

| `copy_to_backbuffer` | items |
| -------------------- | ----- |
| `[0, 0, 0, 0]` | 1 (BBV, viewport mode) |
| `[136, 136, 32, 64]` | 1 (BBR) |

Every other item carries `null` for both. The capture counts 14 `canvas_item_set_canvas_group_mode`
calls while armed (GROUP 4: the `CanvasGroup` constructor's `set_fit_margin(10)` and three setters;
NESTED's group 1; 8 `clip_children` setters; the toggle) and 5
`canvas_item_set_copy_to_backbuffer` calls (each `BackBufferCopy` constructor sends its default rect
mode, `Rect2(-100, -100, 200, 200)`; then BBV's mode, BBR's mode and rect); teardown may add one
disabling call per `CanvasGroup`.
