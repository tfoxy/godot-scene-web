# Gate 4 fixture

The reference rendering for gate 4's first increment, G4a: Latin grayscale text
([`../../protocol/gate4-design.md`](../../protocol/gate4-design.md) "Q6b"). Ten steps (0..9) put
native `Label`s on one runtime `FontFile` at 16 and 24 px and on the default theme font. They cover
the first atlas pages, new glyphs after frame one, a transform-only move, a hidden Label that
shapes nothing until it is shown, emptied and reordered text, two Labels filling one page in one
frame, a colour-only redraw, and the default font's own page. Like the gate 0 to 3 fixtures, the
project does not know about the capture library and runs the same whether `GRC_EXTENSION` is set
or not.

Provision the font and import the project once before the release template can run it:

```bash
bash experiments/render-stream/scripts/lib/provision-fonts.sh experiments/render-stream/fixtures/gate4
mise exec -- godot --headless --path experiments/render-stream/fixtures/gate4 --import
```

## Files

- `project.godot`: gate 3's settings (640×360, stretch `disabled`, `gl_compatibility`,
  `msaa_2d=0`, `hdr_2d=false`, clear colour `(0.2, 0.2, 0.4, 1)`, the `[debug]` warning-to-error
  keys, autoload `GrcLoader`) plus every text input Q1e pins: the text driver, layout direction,
  locale, the `gui/theme/default_font_*` settings (grayscale, light hinting, subpixel positioning
  disabled, no MSDF, no mipmaps), LCD layout, theme scale and stretch scale.
- `loader.gd`: gate 3's loader.
- `gate4.tscn`: a root `Node` (not a `CanvasItem`) with `gate4.gd`.
- `gate4.gd`: loads `res://fonts/OpenSans_SemiBold.woff2` with `FontFile.load_dynamic_font` and
  sets D3's properties before any Label uses it. It then builds every item in `_ready()` in
  `expected.json` `creation_order` (wire ids 1..9): the panel `P`, seven Labels and the `Marker`.
  `_process()` applies the timeline. `RS_FIXTURE_VARIANT` is refused (exit 2). All output lines
  start with `[fixture]`.
- `glyph_oracle.gd` (`render-stream-gate4-glyphs/1`, Q6c): at each settle frame, every visible
  Label's glyphs in draw order with the quad and source rect the engine's `_font_draw_glyph` would
  compute, and every atlas page with the GRT1 SHA-256 of `font_get_texture_image`. Page bytes go
  to `<log dir>/pages/<sha256>.grt`. It never calls a getter that uploads, never shapes a hidden
  node, and carries its own GRT1 encoder.
- `fonts.lock.json`: the one font (Q6a). Its source is `packages/html/vendor/`; no font binary is
  committed here.
- `fonts/.gitignore`, `fonts/.gdignore`: the provisioned copy stays ignored and unimported.
- `make_expected.py`: writes `expected.json` (`--check` compares values). It derives the census
  from the strings with Q1c's rules (its docstring cites the lines) and asserts the contract's
  hand table, the wire versions and the region layout. Nothing in it is measured.
- `expected.json` (`render-stream-gate4-expected/1`, Q6d): per step the texts, the draws in
  order, ink-glyph counts, new glyphs, page creates, uploads, hook and wire versions per cache
  (`F@16`, `F@24`, `DF@16`), text regions, backgrounds and freshness; the engine's own texture;
  and the predictions for G4b's sabotage legs.

## Timeline

`S` = `RS_FIXTURE_START_FRAME` (default 1) and `N` = `RS_FIXTURE_STEP_FRAMES` (default 10, at
least 8). Step 0 is the `_ready()` state at frame 1. Step _k_ ≥ 1 is applied at `S + N·k` and
settles at `S + N·k + 7`. Steps 1, 4 and 7 are also shot one frame after they apply. The fixture
quits at `S + N·9 + 11` (102) unless `RS_FIXTURE_QUIT_FRAME` asks for later. Every step
recolours the `Marker`.

| step | change                                                                 | F@16 uploads |
| ---- | ---------------------------------------------------------------------- | ------------ |
| 0    | `L1`/`L2` "Hello", `L3` "Sphinx" (24 px), `LD` "Default", `LT`/`LA` "Hole" | create       |
| 1    | `L1` "Hello Quartz"                                                    | 1            |
| 2    | `L3` moves 8 px right                                                  | 0            |
| 3    | hidden `LH` gets "Wyvern"                                              | 0            |
| 4    | `LH` shown                                                             | 1            |
| 5    | `L1` emptied                                                           | 0            |
| 6    | `L1` "Quartz Hello"                                                    | 0            |
| 7    | `L2` "Jump!", then `L1` "Fjord"                                        | 2            |
| 8    | `L3`'s colour changes                                                  | 0            |
| 9    | `LD` "Default 2" (the default font's page: 1 update)                   | 0            |

## Environment

| Variable                 | Meaning                                                                         |
| ------------------------ | ------------------------------------------------------------------------------- |
| `RS_FIXTURE_STEP_LOG`    | absolute path: one JSONL line per step at its applied frame                     |
| `RS_FIXTURE_SHOT_DIR`    | absolute dir: `step-<k>.png` at each settle frame, `early-<k>.png` for k 1, 4, 7 |
| `RS_FIXTURE_ENV_LOG`     | absolute path: `env.json` (TextServer, font hashes and properties, settings)    |
| `RS_FIXTURE_GLYPH_LOG`   | absolute path: the oracle; refused (exit 2) next to any `GRC_*` variable        |
| `RS_FIXTURE_START_FRAME` | `S` ≥ 1, default 1                                                              |
| `RS_FIXTURE_STEP_FRAMES` | `N` ≥ 8, default 10                                                             |
| `RS_FIXTURE_QUIT_FRAME`  | ≥ the default `S + N·9 + 11`                                                    |
| `RS_FIXTURE_VARIANT`     | refused in G4a (exit 2)                                                         |
