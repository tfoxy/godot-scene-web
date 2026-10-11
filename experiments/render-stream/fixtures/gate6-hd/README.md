# Gate 6 HD fixture

Nine copies of the gate 6 combined scene ([`../gate6-scene`](../gate6-scene/README.md)) in a 3×3
`GridContainer` at logical 1920×1080 under `canvas_items` stretch, aspect `keep` (G6h,
[`../../protocol/gate6-design.md`](../../protocol/gate6-design.md) "Q6e"). The window size is the
presentation: `native` runs at 1920×1080 (stretch identity, font oversampling 1) and `half` at
960×540 (`--resolution 960x540`: stretch 0.5, oversampling 0.5, StyleBoxFlat's feather
`aa_size / 0.5`). The fixture itself does not know which. Like the other fixtures, it does not know
about the capture library and runs the same whether `GRC_EXTENSION` is set or not.

```bash
mise exec -- godot --headless --path experiments/render-stream/fixtures/gate6-hd --import
python3 experiments/render-stream/fixtures/gate6-hd/make_expected.py --check
python3 experiments/render-stream/fixtures/gate6-hd/make_expected.py --sync   # after gate6-scene changes
```

## Files

- `project.godot`: gate6-scene's settings at 1920×1080, `window/stretch/mode="canvas_items"`,
  `window/stretch/aspect="keep"`.
- `gate6_hd.tscn`, `gate6_hd.gd`: a plain root `Node`. `_ready()` adds `Grid` (3 columns,
  separations 0, anchored full rect) and, for c = 0..8, a `Cell` Control (minimum size 640×360)
  that the synced `scene_builder.gd` builds into with cell index c (TEXA content offset 100c, HUD
  layer 1 + c) and phase 7c frames. The timelines, time modes, shots and step log are
  gate6_scene.gd's, applied to every cell at the same frames. Variables: gate6_scene.gd's
  (`RS_FIXTURE_VARIANT` is `animate` or `gpu-heavy` here) plus `RS_FIXTURE_BURN_ITERATIONS`
  (`gpu-heavy` only, default 1000).
- `hd_oracle.gd` (`render-stream-gate6-hd-oracle/1`, reference legs only): at each settle frame the
  viewport's oversampling, window size, visible rect, stretch scale and canvas transform, the grid's
  rect, each cell's rect and Scene position plus everything gate6-scene's oracle reads for one copy
  (through the synced `scene_oracle.gd`), each LineEdit's focus, and the atlas pages.
- `shaders/burn.gdshader` (`gpu-heavy`): a loop of `iterations` `sin`/`fract` steps into `acc`,
  `COLOR = vec4(0.0, 0.0, 0.0, step(1e9, acc))`: transparent, unchanged pixels, unfoldable work.
  G6c calibrates `iterations`.
- Synced from `../gate6-scene` (never edited here; `make_expected.py --sync` copies them and
  `--check` fails when one differs): `scene_builder.gd`, `scene_oracle.gd`, `loader.gd`,
  `shaders/phase_tint.gdshader`.
- `make_expected.py` writes `expected.json` (`render-stream-gate6-hd-expected/1`). It imports
  gate6-scene's model and composes it: each cell is that model at the cell's phase and TEXA offset,
  translated by the cell's origin; `half` is the same scene under scale(0.5) with the antialiased
  StyleBoxFlats lowered at `aa_size / 0.5` (items carry `ops_half` where that differs). It runs
  gate6-scene's own asserts per cell, then the HD ones (regions disjoint across cells, every region
  edge even, nine distinct HUD layers at every step).

## Layout

Cell c sits at (640 (c mod 3), 360 ⌊c/3⌋); its regions are gate6-scene's, named `c<c>.<region>`,
translated by the origin (and by (8, 4) at steps 10 and 11, clamped to the viewport only). Every
origin and region edge is even, so `half` maps it to an integer pixel.

Two things differ from nine independent copies of gate6-scene, both forced by sharing one viewport:

- **One focus owner.** The builder grabs the LineEdit's focus in every cell, so only the last cell
  built (8) keeps it. The other LineEdits draw no focus box and no caret. Each cell keeps its
  selection because `gate6_hd.gd` sets `deselect_on_focus_loss_enabled = false` on each LineEdit
  before the next cell grabs focus (the default would clear cells 0 to 7's selections).
- **The root canvas transform** at step 10 moves the whole grid by (8, 4), so cell 0's moved panel
  abuts cell 1's, and the bottom row's TLs lose their last 4 rows to the viewport's edge.
