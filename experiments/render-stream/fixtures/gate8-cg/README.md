# Gate 8 canvas-group fixture (`gate8-cg`, CG1)

The fixture for render-stream/10's two item keys
([`../../protocol/render-stream-10.md`](../../protocol/render-stream-10.md)): `canvas_group`, the
state `clip_children` and `CanvasGroup` set through `canvas_item_set_canvas_group_mode`, and
`copy_to_backbuffer`, the state `BackBufferCopy` sets through `canvas_item_set_copy_to_backbuffer`.
Before /10 neither reached the wire, so every receiver drew the game's HP bars as square, full-height
fills. The scene does not know
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
- `shaders/blur.gdshader`, `shaders/threshold.gdshader`, `shaders/fade.gdshader`: COVER's
  mip-reading screen reader, ALPHA0's `COLOR.a = threshold` overlay and its fading screen reader.
- `expected.json`: the hand-derived cells, wire states, model pixels and checkpoints the checker
  reads.

## Scene

Procedural textures only; nearest sampling at integer scales, or along an axis whose texels are all
equal (the HP bar's 16 to 18 px fill stretch, the mask's zero-width stretched centre), so no pixel
centre's colour rests on a texel-boundary tie.

| Cell       | Position  | Construction                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | What it proves                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ---------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `HPBAR`    | (40,32)   | a game's HP bar node for node: `HpBackground` nine-patch (20x16, margins 9/0/9/0, modulated) at (-8,-3) 248x16; `ForegroundContainer` (a `Control`, no draw, clip only); `Mask` nine-patch (12x10 with pointed caps, alpha 0 outside the point, margins 6/0/6/0) stretched to 232x10, clip only; under it `HpMiddleground` (15x16 fill, margins 6/0/6/0, 229x18 at y -4, modulate orange) and `HpForeground` (232x18 at y -4, self-modulate red, clip and draw)                        | the fills are clipped to the mask's pointed 10 px alpha; the command-less container is no group; `HpForeground`'s clip-and-draw is ignored inside `Mask`'s open group                                                                                                                                                                                                                                                                                                    |
| `HPLOW`    | (40,72)   | the same bar at a lower value (middleground 180, foreground 120 wide)                                                                                                                                                                                                                                                                                                                                                                                                                  | the orange middleground between them, clipped too                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `CLIPDRAW` | (336,16)  | a clip-and-draw `Sprite2D` owner (16x16 at scale 4, four alpha rings 255/192/128/64) over an opaque child overflowing it by 16 px                                                                                                                                                                                                                                                                                                                                                      | clip-and-draw with partial alpha                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `GROUP`    | (448,16)  | a `CanvasGroup` (fit_margin 6, clear_margin 12, use_mipmaps, self-modulate alpha 0.6) over two overlapping 0.7-alpha `ColorRect`s                                                                                                                                                                                                                                                                                                                                                      | the group composites its children as one layer; non-default margins and `blur_mipmaps` travel                                                                                                                                                                                                                                                                                                                                                                            |
| `NESTED`   | (544,16)  | a clip-only `Sprite2D` (a disc, scale 3) with a child, inside a `CanvasGroup` (defaults, self-modulate alpha 0.7) over a green backdrop                                                                                                                                                                                                                                                                                                                                                | GLES3 keeps one open group: the inner owner draws plainly over its unclipped child                                                                                                                                                                                                                                                                                                                                                                                       |
| `BLEND`    | (40,240)  | a `CanvasGroup` (defaults) over a translucent blue base, with a SUB-blend and an ADD-blend `ColorRect` child, each overflowing the base                                                                                                                                                                                                                                                                                                                                                | on the group's transparent target SUB removes coverage (it never adds it) and ADD keeps Godot's alpha factors; past the base the destination alpha is 0                                                                                                                                                                                                                                                                                                                  |
| `BBV`      | (40,136)  | a backdrop, a `BackBufferCopy` in viewport mode, a yellow overlay, then a screen reader (invert) over the cell                                                                                                                                                                                                                                                                                                                                                                         | the copy predates the overlay, so the reader hides it; without the copy the reader's own automatic copy would show it                                                                                                                                                                                                                                                                                                                                                    |
| `BBR`      | (136,136) | a backdrop, a `BackBufferCopy` in rect mode over the cell's left half (the node at the origin: GLES3 reads the rect untransformed), then a screen reader over the cell                                                                                                                                                                                                                                                                                                                 | the left half reads the backdrop; the right half reads what BBV's whole-target copy left in the back buffer there, the clear colour. A whole-target copy instead (dropping the rect) shows the backdrop there                                                                                                                                                                                                                                                            |
| `TGL`      | (232,136) | a diamond-mask `Sprite2D` with a child, `clip_children` disabled until step 2, then clip only                                                                                                                                                                                                                                                                                                                                                                                          | a state-only change: `set_clip_children_mode` does not redraw, so the patch carries the item with `commands: null`                                                                                                                                                                                                                                                                                                                                                       |
| `PLAIN`    | (328,136) | a plain sprite                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | the control cell: no /10 state                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `COVER`    | (448,128) | in its own `CanvasLayer`: backdrop sprites, a full-core screen reader reading the back buffer's mips (a fresh whole-target copy with its mip chain), then two opaque meshes over the 144x144 core (top: a wobbly 4x2 grid sampling an atlas region inside a transparent frame, reaching past a `clip_contents` scissor; bottom: an untextured grid with straight outer edges and wobbly inner vertices), a translucent overlay, and below the core a sprite under a modulate-0.99 quad | the cover walk's cell: a receiver may leave out what the meshes hide (the backdrop, the reader, its copy and mips) and must paint the same pixels; no /10 state                                                                                                                                                                                                                                                                                                          |
| `ALPHA0`   | (176,240) | in its own `CanvasLayer` above COVER's: backdrop sprites; a sprite at self-modulate alpha 0 (Godot culls an inherited modulate under 0.007, not a self-modulate); a screen reader (`fade.gdshader`, the inverse of the back buffer) at its material's `threshold`, 0 until step 2 sets 0.5; and over the whole screen a `COLOR.a = threshold` overlay (`threshold.gdshader`) whose threshold is never set (0)                                                                          | the no-op walk's cell: a receiver may leave out the zero-alpha draws (and the reader's copy while the reader is one) and must paint the same pixels, and draws the reader again when its uniform rises; no /10 state                                                                                                                                                                                                                                                     |
| `TILES`    | (176,224) | in its own `CanvasLayer` at layer -1 (its draws come first in the root's list, before any back-buffer work): a 256x128 backdrop; a sprite opaque but for a transparent 16 px frame over part of it; a clip-only disc owner with a child, under a second framed sprite over its corner (one of that sprite's 32 px cells meets the group's copy); a screen reader reading the back buffer's mips; a third framed sprite over part of the reader                                         | the depth-tile cell: a receiver may depth-test the backdrop under the first sprite's core, on a 32 px grid, and must paint the same pixels; a cell meeting a copy between the backdrop and a later sprite stays drawn (the reader's blur reads around its pixels, so hiding the backdrop under the third sprite would show); its clip group is /10 state, and its region ([376,224]-[447,359]) holds the group; its other draws lie under ALPHA0's, which stops at x 375 |

All cells sit in one canvas, in this tree order: every group's back-buffer work comes before BBV's
whole-target copy, which overwrites the back buffer, so BBV and BBR read the same back buffer
whatever the groups did.

The reference matches the model exactly (checked by `cg-reference-model`): BBV is 255 minus its
backdrop, BBR's right half is (204,204,153), 255 minus the clear colour (51,51,102), and HPBAR's fill
colour appears on none of the fill's 8 rows outside the mask.

## What each leg loses

| leg                                      | loses                              | differs from the reference in                                                |
| ---------------------------------------- | ---------------------------------- | ---------------------------------------------------------------------------- |
| `receiver-v9` (the /9 capture)           | every /10 state                    | TILES, HPBAR, HPLOW, CLIPDRAW, GROUP, NESTED, BLEND, BBV, BBR; TGL at step 2 |
| `sabotage-drop-canvas-group/receiver`    | `canvas_group`                     | TILES, HPBAR, HPLOW, CLIPDRAW, GROUP, NESTED, BLEND; TGL at step 2           |
| `sabotage-full-backbuffer-copy/receiver` | the rect of every copy (`Rect2()`) | BBR                                                                          |

Each equals the reference everywhere else.

## Timeline

| frame |                                                                                                          |
| ----- | -------------------------------------------------------------------------------------------------------- |
| 1     | checkpoint 0 (the scene `_ready` built); settles at 4                                                    |
| 12    | the late arm (`RS_FIXTURE_ARM=late` only)                                                                |
| 14    | checkpoint 1: nothing changes (after a late arm, the adopted scene); settles at 17                       |
| 20    | checkpoint 2: TGL's clip_children disabled -> clip only, ALPHA0's fade threshold 0 -> 0.5; settles at 27 |
| 35    | quit                                                                                                     |

Under `RS_FIXTURE_ARM=late` the step log holds only checkpoints 1 and 2 (the recording starts at
the arm). The capture runs headless (the hooks see the calls; the dummy renderer draws nothing),
the references and receivers in one private 640x360 gamescope.

## Wire state

At checkpoints 0 and 1 (and 2, with TGL's mask added as a fourth commands-bearing clip-only item):

| `canvas_group`                                  | items                                                |
| ----------------------------------------------- | ---------------------------------------------------- |
| `clip_only`, 5, false, 0, false; no commands    | 2 (`ForegroundContainer`)                            |
| the same; commands                              | 3 (`Mask` x2, NESTED's owner)                        |
| `clip_and_draw`, 5, false, 0, false; commands   | 3 (`HpForeground` x2, CLIPDRAW's owner)              |
| `transparent`, 12, true, 6, true; no commands   | 1 (GROUP)                                            |
| `transparent`, 10, true, 10, false; no commands | 2 (NESTED's and BLEND's `CanvasGroup`, the defaults) |

| `copy_to_backbuffer` | items                  |
| -------------------- | ---------------------- |
| `[0, 0, 0, 0]`       | 1 (BBV, viewport mode) |
| `[136, 136, 32, 64]` | 1 (BBR)                |

Every other item carries `null` for both. The capture counts 15 `canvas_item_set_canvas_group_mode`
calls while armed (GROUP 4: the `CanvasGroup` constructor's `set_fit_margin(10)` and three setters;
NESTED's group 1; BLEND's group 1; 8 `clip_children` setters; the toggle) and 5
`canvas_item_set_copy_to_backbuffer` calls (each `BackBufferCopy` constructor sends its default rect
mode, `Rect2(-100, -100, 200, 200)`; then BBV's mode, BBR's mode and rect); teardown may add one
disabling call per `CanvasGroup`.
