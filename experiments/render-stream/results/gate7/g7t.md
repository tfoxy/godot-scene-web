## Gate 7t result (2026-10-16)

G7t ([protocol/gate7-design.md](../../protocol/gate7-design.md) "G7t", Q5, Q7, Q8, Q14d) extends the
GSW canvas receiver to gates 4 and 5: text (grayscale atlases, layout, outlines, shadows, LCD,
RichTextLabel spans, i18n with fallbacks, MSDF), geometry (lines, polylines, multilines, circles,
polygons, primitives, triangle arrays, nine-patches in every axis mode, antialiased feathers,
hairlines), GRM1 meshes and StyleBoxFlat. **`g7-4` and `g7-5` pass for `gsw`, and `g7-0` to
`g7-3` still pass:** 278 of 278 gating checks over the final run's seven groups. Those include
G7s's `g7-55`, which now draws in Godot's orientation too.

```bash
bash experiments/render-stream/scripts/run-gate7.sh --legs g7-0,g7-1,g7-2,g7-3,g7-4,g7-5,g7-55 \
  --receiver gsw --skip-harness-selftest --make-sources --out <dir>
```

**What was built**

- **`render-stream-core`'s lowering** (`apply/lower.rs`, `apply/geom.rs`), every op ported from
  4.5.1's own construction:
  - Antialiased feathers exactly as `canvas_item_add_rect`, `_add_line`, `_add_polyline`,
    `_add_multiline` and `_add_circle` build them: eight 4-point primitives for rects and lines,
    the polyline's middle strip with open-end feathers plus its left and right strips, the
    circle's 130-point strip. Each feather counts in `Item::get_rect` as the engine's own command.
  - `TYPE_PRIMITIVE` colours through binary16 as `Math::make_half_float` truncates them.
  - Nine-patch `tile` and `tile_fit` as one quad per period, each with its period's linear UV map
    (`map_ninepatch_axis`), so nothing is drawn as `stretch` any more.
  - GL lines and points (width < 0 lines, polylines, multilines, 2-point primitives, mesh `lines`,
    `line_strip` and `points` surfaces) as 1-px quads.
  - `add_msdf_texture_rect_region` is not drawn and is typed `gsw-msdf` (G7x drew it plain, which
    spills the distance field's padding outside the glyphs: 194 px per gate 4e shot).
- **Mesh residency with native semantics** (`apply/meshes.rs`, `rs_applier.gd` `_apply_meshes`):
  create on first naming, rebuild on a layout change, in-place updates listing exactly the changed
  buffers, custom AABB rows, frees. The lowering draws the *resident* surfaces, so the native
  sabotages `drop-mesh-surface` and `stale-mesh` act on pixels as they do natively, and
  `applied.json` carries `mesh_uploads` and the mesh counters.
- **The applier's sabotages:** native `drop-msdf`, `ignore-set-transform`, `ignore-clip-ignore`,
  `ignore-nine-patch-axis`, `drop-mesh-surface` and `stale-mesh`, and G7t's GSW-only
  `polygon-winding` (a triangle fan over the reversed contour).
- **`canvas-items`: Godot's orientation** (`ExecOptions::godot_orientation`, off by default). Godot
  draws a 2D render target y-up: `screen_transform` is `translate_local(-w/2, -h/2)` then
  `scale(2/w, 2/h)`, so design row y is GL row y. GSW drew y-down, so every edge exactly on a pixel
  centre was owned by the other row. The option draws through Godot's `mat4` screen transform,
  reads shots without a row swap and flips in the present draw. `rs-gsw-wasm` turns it on. G7s's
  item-space programs share the builtin's vertex stage, so they take the same `u_screen` path; the
  opaque target's blends do not depend on orientation, and its readback and present are the same
  paths. `canvasItemsProgramPixel` now runs every G7s case in both orientations against the same
  hand model (16/16; each case's two shots are byte-identical).
- **`rs-core-check lowered`**: every item's lowered vertices, colours and indices at chosen seqs.
- **Gate scripts:** `lib/gate7-gsw-g45.ts` (legs, receiver checks, Q7 plans, typed checks),
  `lib/gate7-gsw-g45-checks.ts` (G7t's checks), gate 4/5 masks in `lib/gsw-tolerance.ts` and
  `fixtures/gsw-tolerance.json`, per-pixel Q7 classes (`classMask`), a thin-line marker in
  `geometry-raster.ts`, `buildGate4Report`/`buildGate5Report` exported from the CLIs, and
  `scripts/test/probe-receiver-checks.ts`.

**How gates 4 and 5 are judged.** As for gates 0 to 3: each gate's own checker on a view of its
native source run.

- **Which checks are receiver checks** was found mechanically, by viewing each source run with
  every receiver leg emptied and diffing the verdicts: 64 gate 4 checks and 36 gate 5 checks
  change. Each is kept `@gsw` except the strace and GDScript ones (as G7a), and two gate 4e checks
  that judge only MSDF regions.
- **Masks** (Q7, from the gates' own models): gate 4's glyph boxes (every step's `text_regions`)
  are `delta1`, gate 4e's are `excluded` with reason `gsw-msdf`. Gate 5's are per pixel from
  `geometry-raster.ts`: pixels decided within 1 and antialiased feather bands are `delta1`; thin GL
  lines' bands, gate 5e's DF band region and the 1/16-px edge pixels are `undecided`. The committed
  file pins their pixel counts per step.
- **Sabotage legs are paired with the honest gsw leg.** A view would otherwise hand an undecided
  pixel the reference's value even where the sabotage changed it (gate 5e's DF region). A pixel the
  sabotage left equal to the honest leg takes the honest view's value; every pixel it changed stays
  as drawn.
- **Typed legs:** gate 4e's three MSDF legs must class `unsupported` with exactly `{gsw-msdf}`.

**Results** (`artifacts/render-stream/gate7/g7t/final4/result.json`, on G7s's main `130363ab`;
desktop D9 harness, pinned chromium-1223, sources made on this build in `sources-made/`):

| Group | gsw legs | Gating checks | Shots identical to native | Notable |
| ----- | -------- | ------------- | ------------------------- | ------- |
| `g7-0` | 8 | 24/24 | 25/25 | unchanged |
| `g7-1` | 13 | 29/29 | 164/164 | unchanged |
| `g7-2` | 17 | 38/38 | 56/132; the rest delta 1 | unchanged (Q7: 10 240 px `delta1`, 4 468 px `undecided`) |
| `g7-3` | 14 | 31/31 | **120/120** | G7a had 117/120: Godot's orientation makes gate 3c's ignore-clip sabotage shots exact too |
| `g7-4` | 20 | 65/65 | 10/222; the rest delta 1 but gate 4e's 34 MSDF shots | Q7: decided exact, 119 484 px `delta1`, 163 570 px in typed `gsw-msdf` regions; glyph boxes 35/316 exact, the rest within 1; `atlas-upload-parity` 82 rows on 10 legs |
| `g7-5` | 19 | 42/42 | 33/180; the rest delta 1 but 20 gate 5g shots | Q7: decided exact, 138 580 px `delta1`, 88 468 px `undecided`; `lowering-parity` 615/615; `mesh-upload-parity` 2 295 rows; `polygon-winding` fails exactly `{PG}` at 10 steps; the 20 shots differ only in `NF` (below) |
| `g7-55` | 22 | 49/49 | 110/210; the rest delta 1 | G7s's numbers under Godot's orientation: every ShaderMaterial leg, sabotages included, identical to native; CIM legs delta 1 in `delta1` masks; `shader-param-parity` 20 880 values; `blend-swap` fails exactly `{BA,BS,RC,UP}` (step 4 `{BA,BS,UP}`) |

Every native source run passed on this run (gate 2's load-sensitive live legs included);
`run-gate55.sh` exits 1 only because g55f's live legs are not run, which `source-run-valid@gsw`
accepts.

**Supported and refused.**

- **Supported now:** every gate 4 and 5 op except MSDF, including feathers, nine-patch tiles, GL
  lines and points, mesh primitives and the native mesh census.
- **Typed:** `gsw-msdf` only (gate 4e). `gsw-hairline`, `gsw-aa-feather`, `gsw-nine-patch-tile` and
  `gsw-mesh-primitive` are retired. Hairlines meet gate 5b's decided set (every decided pixel exact,
  every difference inside the thin-line band), so they are counted, not typed.
- **Still G7s's:** `gsw-shader-builtin`.

**Findings.**

- **P-G2 does not hold exactly.** 35 of 316 of the glyph boxes are byte-identical to the reference;
  the rest differ by exactly 1 on partially covered texels. That is Q7's `delta1` cause: Godot
  blends straight alpha in the blend unit, GSW blends premultiplied colour from the shader, so a
  translucent pixel can round one level apart. Every glyph box is within its `delta1` mask.
- **`LE` is settled by orientation, not by float order.** On the gate 6 scene (G7a's inputs, G7x's
  native receiver), LE falls from max 7 (4 275 px) to max 1 on every settle shot
  (`artifacts/render-stream/gate7/g7t/le/scene/scene-vs-native.json`); every region but SM (G7s) is
  now within 1 of native. Gate 4f's hex box (LX, `draw_hex_code_box`'s add_rects at pen y + .5)
  differed by 204 on 88 px per shot before and is exact now. GSW still composes one item row
  instead of Godot's model, canvas and screen products, and no tie needed more.
- **The lowering differential holds bit for bit:** `lowering-parity` finds all 615 hand-lowered
  shapes of gate 5's three fixtures in the Rust lowering. Two hand-model conventions differ from the
  engine and are allowed for: make_expected.py tiles gate 5's polygons with "any triangulation" (so
  triangles compare by covered area), and rounds primitive colours to nearest binary16 where Godot
  truncates (so colours compare at half precision).

- **Gate 5g's `NF` has one texel tie GSW does not reproduce.** `NF` is a `tile_fit` nine-patch
  (52x40, margins 4, a 16 px texture). On one 32-px column (local x 9.5, where u is exactly 10.0, a
  texel boundary) Godot evaluates the tiling's modulo per fragment and lands on the next texel,
  while GSW interpolates each period's linear UV map. The column differs by up to 204 (153 on two
  shots, 144 px over the later steps' larger box), on 20 shots of `style/receiver` and
  `style/receiver-patch`. The gate's own model marks those pixels undecided, so Q7 passes, and the
  shots match the pre-rebase run's exactly.

**Re-verified.**

- The final run above: every source made on this build (`final4/sources-made/`), all seven
  groups passing, `gate_passed=true`.
- `rs-core` cargo tests (35, 8 of them G7t's lowering and mesh cases) and clippy are clean;
  `rust-prototype` tests pass with `canvas-items` (56 + 34 + 6), and the new orientation unit test
  holds. Clippy findings on that crate are all in untouched files (`contract.rs`, `geometry.rs`,
  `idle.rs`, `renderer.rs`).
- `canvasItemsRustPixel` 24/24 byte-identical (the default orientation). `canvasItemsProgramPixel`
  16/16: G7s's eight cases in both orientations, every pixel within its hand-model delta.
- `pnpm test`: 169 files, 2 510 tests. `gsw-tolerance.ts --check` is byte-identical after the
  derivation was regenerated with gate 5.5's and gates 4 and 5's masks together.
- The default `rust-prototype` build is byte-identical to main (wasm `d810e2a3…`, JS
  `fed168e4…`).
- **Consumer check.** `../sts2-couch-coop`'s `build-rust-prototype.sh` was run from a scratch copy
  against this worktree (so its shared `.sts2/` output was not rewritten): byte-identical output.
  Its seven Rust renderer specs pass against the worktree (`COUCHCOOP_GSW_ROOT`, 211 tests). No
  consumed TypeScript API changed, so `vue-tsc` was not needed. The couch checkout was not touched.
- `LE` on the gate 6 scene (`artifacts/render-stream/gate7/g7t/le/`) was measured on the
  pre-rebase build; the orientation code it measured is unchanged by the rebase.

**What G7t does not prove:** g5f's live legs (G7l), anything about shaders beyond re-running G7s's
`g7-55` under the new orientation, gate 6 legs (G7g), and any phone leg (the section names none).

**What G7g inherits:**

- Godot's orientation is on, so gate 6's StyleBoxFlat and LineEdit ties should be exact. Its masks
  can reuse `classMask` and its sabotages the `pair` view.
- Gate 6's text is `delta1` per glyph box, as gate 4's.
- MSDF stays `gsw-msdf` (gate 6's Kreon is MSDF). Drawing it needs an MSDF program, which is the
  draw list's `program` id that G7s introduces.
