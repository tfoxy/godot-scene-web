### G7t — GSW text, geometry, meshes: gates 4 and 5 (opus)

- **Files**: the applier's lowering table (Q5) for nine-patch, lines, polylines, circles,
  polygons, primitives, triangle arrays, meshes (GRM1) and hairlines; `gsw-msdf`; tolerance masks
  for gates 4 and 5; the adapters; `g7-4`, `g7-5` gsw file legs.
- **Checks**: gate 4 and 5 receiver checks `@gsw`; `atlas-upload-parity` (one GSW upload per
  wire atlas version, as the native census); `mesh-upload-parity` (gate 5e); P-G2 reported per
  glyph box.
- **Sabotages**: native receiver sabotages; a lowering sabotage `polygon-winding` (reversed
  triangle fan) must fail exactly gate 5b's polygon regions.
- **As built** must record whether hairlines meet gate 5b's decided set. If they do not, they are
  `gsw-hairline` and the legs that draw them classify `unsupported`.
- *Amended 2026-10-15 (D29):* the lowering table is written in `render-stream-core`'s applier,
  and executor features go into `canvas-items`. The Rust ports of `geometry-raster.ts`'s lowering
  must be bit-equal to the TypeScript on every gate 5 case (Q14d). Hairlines stay as specified.
- **As built (G7t, 2026-10-16)**, details in the README's "Gate 7t result". `g7-4` and `g7-5` pass
  for `gsw` (20 and 19 legs, 65/65 and 42/42 gating checks), `g7-0` to `g7-3` and G7s's `g7-55`
  still pass: 278/278 gating checks over the seven groups.
  - **Hairlines meet gate 5b's decided set.** GL lines and points are drawn as 1-px quads; every
    decided pixel is exact and every difference lies inside the thin-line band. They are counted
    (`slice-hairline-as-quads`), not typed, and no leg classifies `unsupported` for them.
  - **Typed refusals left:** `gsw-msdf` (gate 4e, whose three MSDF legs class `unsupported` with
    exactly that reason; MSDF commands are no longer drawn plain) and G7s's `gsw-shader-builtin`.
    `gsw-aa-feather`, `gsw-nine-patch-tile`, `gsw-mesh-primitive` and `gsw-hairline` are retired.
  - **The lowering table** is in `render-stream-core`: the engine's feathers, binary16 primitive
    colours, nine-patch tiling per period, GL lines and points, and native mesh residency (the
    lowering draws the resident surfaces). `lowering-parity` finds every hand-lowered shape of gate
    5's three fixtures bit for bit (615 of 615); make_expected.py's "any triangulation" polygons
    compare by area, and its round-to-nearest binary16 colours at half precision.
  - **Godot's orientation** (`canvas-items` `ExecOptions::godot_orientation`, off by default, on
    in `rs-gsw-wasm`) settles the `LE`-type ties: Godot draws 2D targets y-up through its `mat4`
    screen transform, and drawing y-down gave pixel-centre edges to the other row. LE drops from
    max 7 to max 1; gate 4f's hex box from 204 to exact, and gate 3c's ignore-clip sabotage shots
    are identical to native (120/120). The one-row vertex chain stays. G7s's item-space programs
    share the vertex stage and take the same path; `g7-55` keeps G7s's verdicts under it (every
    ShaderMaterial leg identical to native).
  - **Gate 5g's `NF` texel tie** (tile_fit, u exactly 10.0 on one column) is not reproduced: Godot
    takes the tiling's modulo per fragment, GSW interpolates each period's UV map. The gate's model
    marks the column undecided.
  - **P-G2 is `delta1`, not exact:** 35 of 316 glyph boxes are byte-identical, the rest differ by 1,
    Q7's translucent-blend cause.
  - **Q7 views of sabotage legs are paired** with the honest gsw leg, so an undecided mask (gate
    5e's DF band region) never hides a sabotage's own pixels.
  - **Sabotages:** the native gate 4/5 receiver sabotages pass with their native predicted sets;
    `polygon-winding` fails exactly `{PG}` at every settle step.

- *Amended 2026-10-16 (G7tm):* `gsw-msdf` is retired. G7tm draws `add_msdf_texture_rect_region`
  with canvas.glsl's MSDF branch, and gate 4e's three MSDF legs are judged by gate 4e's own checks
  ([g7tm.md](g7tm.md)).
