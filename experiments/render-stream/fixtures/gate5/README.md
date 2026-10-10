# Gate 5 fixture

The reference rendering for gate 5's immediate geometry (G5b,
[`../../protocol/gate5-design.md`](../../protocol/gate5-design.md) "Q6b" and "Q6c"). Ten steps
(0..9) cover wide lines at integer and half-integer coordinates, a thin GL line, a dashed line
(`canvas_item_add_multiline`), an antialiased diagonal, a polyline with a miter corner, an
unfilled rect (a closed 5-point polyline), a polyline with a hold-last colour list, a concave
tie-free polygon, a three-colour triangle, a polygon textured 1:1, 3- and 4-point primitives, a raw
triangle array drawn with a `count`, filled, antialiased and unfilled circles, draw-transform
commands that replace each other, a clip-ignore span, raw nine-patches (`stretch` and `tile`, one
hollow), an antialiased rect, a translucent polygon and a `Line2D`. Like the gate 0 to 4 fixtures,
the project does not know about the capture library and runs the same whether `GRC_EXTENSION` is
set or not.

```bash
mise exec -- godot --headless --path experiments/render-stream/fixtures/gate5 --import
```

## Files

- `project.godot`: gate 3's settings (640×360, stretch `disabled`, `gl_compatibility`,
  `msaa_2d=0`, `hdr_2d=false`, clear colour `(0.2, 0.2, 0.4, 1)`, the `[debug]` warning-to-error
  keys, autoload `GrcLoader`).
- `loader.gd`: gate 3's loader.
- `gate5.tscn`, `gate5.gd`: a root `Node`. `_ready()` makes `TEX16` and `TEX9`
  (`ImageTexture.create_from_image`), then every item in `expected.json` `creation_order` (wire ids
  in that order), and `_process()` applies the timeline. `RS_FIXTURE_VARIANT` is unset or `canvas`
  (one `CanvasTexture` made in `_ready`, D11; G5d's `capture-canvas` leg uses it); anything else
  exits 2. All output lines start with `[fixture]`.
- `regions.gd`: the region nodes, one class per region, each issuing its calls in local
  coordinates from `_draw`. A property a step changes queues its own node's redraw.
- `make_expected.py`: writes `expected.json` (`--check` compares values). It models every call
  and its server lowering from the source (its docstring cites the lines), in float32, and asserts
  the colour rule, disjoint regions, tie-freeness, the hand census of calls per op, Q6b's
  freshness rows, the Line2D and dashed-line lowering counts, and Q6b's sabotage sets. Nothing in
  it is measured.
- `expected.json` (`render-stream-gate5-expected/1`, gate5-design.md Q6c). Per step: the applied
  and settle frames, the marker colour, the canvas transform, the items that redraw, `calls` (per
  region, every RenderingServer call with its float32 arguments; computed ones carry `ulp: 2`),
  `items` (paint order, each with its final transform, scissor and an `op_lists` key) and `fresh`.
  `op_lists` holds each recorded command list once: lowered shapes in draw space (`mesh` with
  vertices, triangles, one or per-vertex colours, optional uvs and texture, and `band_px` when
  antialiased; `thin_line`; `nine_patch`), `set_transform` and `clip_ignore` entries in order.
  Also `textures` (TEX16 and TEX9 texels), `hook_census`, `typed_ops` (what a pre-/4 capture types
  `unsupported`), `calibrator7_ops`, `lowering_predictions` and `predictions` (G5d's sabotage
  sets). Regions are `[x0, y0, x1, y1)`.

## Layout (640×360; regions `[x0,y0,x1,y1)`)

| Region | Node (position)                            | Content (local)                                                                                                    |
| ------ | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `LN`   | `Node2D` (16,16)                           | L1 width 1 at y 8.5; L2 width 2 (4 from step 1) at y 20; L3 vertical width 3 at x 140.5; L4 thin at y 32.5; L5 dashed width 2, dash 8 (8 dashes at integers); L6 diagonal width 4, antialiased until step 8 |
| `PL`   | `Node2D` (176,16)                          | P1 L-shape width 4, colour (.4,.8,1) then (1,.8,.2) at step 3; P2 unfilled rect (80,8,48,32) width 2; P3 4 points, 2 colours, width 4 |
| `PG`   | `Node2D` (336,16), nearest                 | G1 concave arrow (+(0,8) at step 2); G2 triangle in red, green, blue; G3 16×16 square, `TEX16` 1:1                  |
| `PR`   | `Node2D` (472,16)                          | R1 triangle primitive; R2 quad primitive; R3 raw triangle array of two quads, `count` 2 then 4 at step 4         |
| `CI`   | `Node2D` (16,112)                          | C1 filled r 24 (20 from step 6); C2 antialiased r 16; C3 unfilled r 12 width 2                                     |
| `ST`   | `Node2D` (176,112) + `STC` (96,44)          | A; B under translate (32,0) scale 2 (3 from step 5); C under an exact 90° matrix; D under translate (0,40) only; `STC` draws E |
| `CG`   | `Control` (344,120) 64×48, `clip_contents` | X fills it; Y overhangs right-bottom between `clip_ignore(true)` and `(false)`; Z overhangs top-left (clipped); +(16,8) at step 7 |
| `NP`   | `Node2D` (472,112), nearest                | two raw nine-patches of `TEX9`, margins 4, 56×40: `stretch` with centre, `tile` without                             |
| `RA`   | `Node2D` (16,208)                          | antialiased white rect (8,8,48,32)                                                                                 |
| `BL`   | `Node2D` (176,208)                         | white panel, then a polygon at (.2,.4,1,.6) over it and the background                                             |
| `L2`   | `Line2D` (328,216)                         | 3 points, width 6, sharp joint, no caps, (1,.6,.2); `antialiased = true` at step 3 (no effect)                     |
| `Marker` | `Node2D` (592,16)                        | 32×32 rect in gate 3's marker colour of the step                                                                   |

Step 9 sets the canvas transform to a translation by (8,4).
