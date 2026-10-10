# Gate 5 style fixture

The reference rendering for gate 5's nine-patch and stylebox coverage (G5g,
[`../../protocol/gate5-design.md`](../../protocol/gate5-design.md) "Q6f", "Q1h" and "G5g"). Ten
steps (0..9) cover `NinePatchRect` in `stretch`, `tile`, `tile_fit` and hollow, a resize of all
four, a `StyleBoxTexture` with modulate and expand margins, `StyleBoxFlat` sharp, bordered,
rounded (antialiased), shadowed and skewed (antialiased), the default theme's `Panel` box, a
bordered box flipped by `draw_set_transform` (TabBar's pattern) and a focused `RichTextLabel`
whose focus box sits between `add_clip_ignore` commands until it loses focus. Like the other
fixtures, the project does not know about the capture library and runs the same whether
`GRC_EXTENSION` is set or not.

```bash
mise exec -- godot --headless --path experiments/render-stream/fixtures/gate5-style --import
python3 experiments/render-stream/fixtures/gate5-style/make_expected.py --check
```

## Files

- `project.godot`, `loader.gd`: gate 5's settings and loader (640×360, stretch `disabled`,
  `gl_compatibility`, `msaa_2d=0`, `hdr_2d=false`, clear colour `(0.2, 0.2, 0.4, 1)`, the
  `[debug]` warning-to-error keys, autoload `GrcLoader`).
- `gate5_style.tscn`, `gate5_style.gd`: a root `Node`. `_ready()` makes `TEXN`
  (`ImageTexture.create_from_image`), then every item in `expected.json` `creation_order` (wire
  ids in that order; the RichTextLabel's constructor makes its hidden internal `VScrollBar` right
  after itself), grabs the RichTextLabel's focus, and `_process()` applies the timeline.
  `RS_FIXTURE_VARIANT` must be unset. All output lines start with `[fixture]`.
- `style_regions.gd`: `StyleNode` (a `Control` drawing one `StyleBox` over its rect, optionally
  inside TabBar's flip) and the marker's `RectNode`.
- `make_expected.py`: writes `expected.json` (`--check` compares values) in gate 5's schema
  (`render-stream-gate5-expected/1`, rasterized by `scripts/lib/geometry-raster.ts`). It ports
  `StyleBoxFlat::draw` and `draw_rounded_rectangle` to float32 (every triangle array's indices,
  points, per-vertex colours and UVs; `ulp: 2`), turns each `draw_rounded_rectangle` pass into one
  coverage shape (flat passes exact, translucent ones delta 1, the antialiasing and shadow rings
  band), and asserts the colour rule, disjoint regions, tie-freeness, the hand census, Q1h's hand
  vertex and index counts per box, the freshness rows and the receiver sabotage's regions. It
  imports gate 5's `make_expected.py` for the shared float32, transform and welding helpers.
  Nothing in it is measured.
- `expected.json`: as gate 5's (`op_lists`, per step `calls`, `items`, `fresh`), plus
  `translucent_shapes` and `theme_shapes` (the default theme's colours are off the 0.2 grid and
  exempt from it), `lowering_predictions` per box and `predictions`
  (`sabotage-style-receiver-ignore-axis`).

## Layout (640×360; regions `[x0,y0,x1,y1)`)

`TEXN` is 16×16: a uniform 4-texel border (1, 1, .6) around an 8×8 centre of 2×2-texel cells, the
top-left cell (1, .4, .4) and the rest a checker of (.4, .2, .8) and (.2, .8, .6). Every textured
node uses nearest filtering.

| Region   | Node (position, size)                         | Content                                                                                       |
| -------- | --------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `NS`     | `NinePatchRect` (16,16) 52×40, 68×56 from 2   | `TEXN`, margins 4, `stretch`/`stretch`                                                        |
| `NT`     | `NinePatchRect` (112,16)                      | `tile`/`tile`                                                                                 |
| `NF`     | `NinePatchRect` (208,16)                      | `tile_fit`/`tile_fit` (6 repeats of 7.33 px across, then 8 of 7.5 px)                        |
| `NH`     | `NinePatchRect` (304,16)                      | `stretch`, `draw_center = false`                                                              |
| `TX`     | `StyleNode` (404,20) 56×40                    | `StyleBoxTexture`: `TEXN`, texture margins 4, expand margins 4, modulate (.6,.6,1); (1,.6,.6) at 8 |
| `SF`     | `StyleNode` (16,116) 64×48                    | `StyleBoxFlat` sharp, bg (.4,.8,.4); (1,.6,.2) at 1                                           |
| `SB`     | `StyleNode` (112,116) 64×48                   | sharp, bg (.2,.4,.8), border (1,1,.6) widths L2 T4 R6 B8; L6 at 3                             |
| `SR`     | `StyleNode` (208,116) 64×48                   | radius 8 (12 at 6), antialiased, bg (1,.4,.4)                                                 |
| `SS`     | `StyleNode` (312,116) 56×40                   | sharp, bg (.8,.8,.2), shadow size 4 offset (2,2) ((-2,2) at 7), shadow colour (0,0,0,.6)      |
| `SK`     | `StyleNode` (408,116) 56×40                   | skew (0.2, 0), antialiased, bg (.6,.4,1)                                                      |
| `DP`     | `Panel` (504,116) 56×40, +(8,4) at 5          | the default theme's box: (0.1,0.1,0.1,0.6), radius 3, corner detail 5, antialiased            |
| `FL`     | `StyleNode` (16,212) 64×48, flipped           | sharp, bg (.2,.6,.6), border (1,.8,.4) L2 T2 R2 B6, drawn under `(0,48)` scale `(1,-1)`         |
| `RT`     | `RichTextLabel` (124,220) 56×40, empty text   | focused until 4: the theme focus box (expand 2, border 2 (.8,.8,.8), radius 3) between clip-ignores |
| `Marker` | `Node2D` (592,16)                             | 32×32 rect in gate 3's marker colour of the step                                              |

Step 9 sets the canvas transform to a translation by (8,4).
