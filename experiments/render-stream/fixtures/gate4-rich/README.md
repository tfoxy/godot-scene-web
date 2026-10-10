# Gate 4 RichTextLabel fixture (G4d)

The reference rendering for gate 4's RichTextLabel increment, G4d
([`../../protocol/gate4-design.md`](../../protocol/gate4-design.md) "G4d", Q6e). Six steps (0..5)
cumulatively add BBCode spans to one `RichTextLabel` (`RTL`): a `[color]` span, a plain-text span,
a `[font_size=24]` span, a `[b]` span (its own `FontVariation` cache, `variation_embolden 1.2`), an
`[i]` span (its own `FontVariation` cache, `variation_transform` skewed 0.2), a `[bgcolor]` span
(an `add_rect`), and an outlined span (`[outline_size=2][outline_color]`, its own bitmap-outline
cache alongside the ordinary fill glyphs). Step 5 is `append_text`, not a full `.text=` replace.
`RS_FIXTURE_VARIANT=underline` wraps the first span's word in `[u]...[/u]`, which draws
`canvas_item_add_line` -- typed `unsupported` (gate4-design.md Q2) -- confined to `RTL`'s region.

Like gates 0-4a, the project does not know about the capture library and runs the same whether
`GRC_EXTENSION` is set or not.

Provision the font and import the project once before the release template can run it:

```bash
bash experiments/render-stream/scripts/lib/provision-fonts.sh experiments/render-stream/fixtures/gate4-rich
mise exec -- godot --headless --path experiments/render-stream/fixtures/gate4-rich --import
```

## Files

- `project.godot`: a copy of `fixtures/gate4/project.godot`'s settings and `[debug]` warning keys.
- `loader.gd`: a copy of `fixtures/gate4/loader.gd`.
- `gate4-rich.tscn`: a root `Node` (not a `CanvasItem`) with `gate4-rich.gd`.
- `gate4-rich.gd`: loads `res://fonts/OpenSans_SemiBold.woff2` as `F` (D3 settings), and two
  `FontVariation`s over it, `FB` (`variation_embolden 1.2`) and `FI` (`variation_transform` skewed
  0.2). It builds `RTL` (position (24,32), size (400,190), `bbcode_enabled`, `fit_content`,
  `scroll_active = false`) and `Marker` in `_ready()` (`expected.json` `creation_order`: `RTL`,
  `Marker`). `RTL`'s size is chosen generously: `fit_content` only *grows* a free Control's actual
  size up to its minimum when the minimum exceeds the offset-derived size
  (`scene/gui/control.cpp:1742-1786`), and this fixture's content never needs more than the chosen
  190 px, so `RTL`'s clip rect stays the fixed rectangle every step (checked against the rendered
  reference, not assumed). `_spans_upto(step)` returns the cumulative span list the glyph oracle
  and the step log both read, built from the same literal words as the BBCode fragments
  (`FRAG_0`..`FRAG_5`) so the two cannot silently drift. `RS_FIXTURE_VARIANT` accepts only `""` or
  `"underline"`.
- `glyph_oracle.gd` (`render-stream-gate4-glyphs/1`, Q6c): its own copy, independent of
  `fixtures/gate4/glyph_oracle.gd`. At each settle frame it reports, per BBCode span, the glyph
  **set and count** (not quads: Q6c, "For RichTextLabel the oracle reports glyph sets and counts
  per span"), re-shaping the span's own plain text with its own Font and size -- it never
  introspects `RichTextLabel`'s own `Item` tree. An outlined span expands to two entries sharing
  its `key`: a fill-pass entry (cache `font_key@size`) and an outline-pass entry, relabelled
  `font_key + "O"` (e.g. `"FO"`) so it never collides with the fill cache under this repo's
  `cacheKeyOf` (`font_key@size` alone) -- the real engine keeps both caches on the same TextServer
  RID, keyed only by `(size, outline)`. It also dumps every atlas page's GRT1 SHA-256, as
  `fixtures/gate4/glyph_oracle.gd` does.
- `fonts.lock.json`, `fonts/.gitignore`, `fonts/.gdignore`: the one font (Q6a), as gate4's own.
- `make_expected.py`: writes `expected.json` (`--check` compares values). It independently derives
  the per-cache census (new glyphs, page creates/uploads, hook/wire versions, cumulative distinct
  glyph counts) from the same cumulative span list `_spans_upto` builds, including the outlined
  span's two cache contributions. Nothing in it is measured or read from the engine.
- `expected.json` (`render-stream-gate4-expected/1`, extended with `spans` per step and a hand
  `clip_rects.RTL`, gate 3's shape): per step the cumulative spans, ink-glyph count, the census per
  cache (`F@16`, `F@24`, `FB@16`, `FI@16`, `FO@16`), `RTL`'s fixed text region and clip rect, and
  the underline variant's prediction (every step mismatches, confined to `RTL`).

## Timeline

`S` = `RS_FIXTURE_START_FRAME` (default 1) and `N` = `RS_FIXTURE_STEP_FRAMES` (default 10, at
least 8). Step 0 is the `_ready()` state at frame 1. Step _k_ >= 1 is applied at `S + N*k` and
settles at `S + N*k + 7`. There are no "early" shots (gate4-design.md G4d has no intermediate-shot
requirement). The fixture quits at `S + N*5 + 11` (62) unless `RS_FIXTURE_QUIT_FRAME` asks for
later. Every step recolours the `Marker`.

| step | change                                        | new cache traffic              |
| ---- | ---------------------------------------------- | ------------------------------- |
| 0    | `[color]Amber[/color] plain [font_size=24]Big` | `F@16` create, `F@24` create    |
| 1    | `+ [b]Bold[/b]`                                 | `FB@16` create                  |
| 2    | `+ [i]Italic[/i]`                               | `FI@16` create                  |
| 3    | `+ [bgcolor=cyan]Marked[/bgcolor]`              | `F@16` update (M, k, d)         |
| 4    | `+ [outline_size=2][outline_color=black]Outlined[/outline_color][/outline_size]` | `F@16` update (O, u, t); `FO@16` create (8 glyphs) |
| 5    | `append_text("\n[color=magenta]More[/color]")` | `F@16` update (o)               |

## Environment

| Variable                 | Meaning                                                                      |
| ------------------------ | ------------------------------------------------------------------------------ |
| `RS_FIXTURE_STEP_LOG`    | absolute path: one JSONL line per step at its applied frame                    |
| `RS_FIXTURE_SHOT_DIR`    | absolute dir: `step-<k>.png` at each settle frame                              |
| `RS_FIXTURE_ENV_LOG`     | absolute path: `env.json` (TextServer, font hashes and properties, settings)    |
| `RS_FIXTURE_GLYPH_LOG`   | absolute path: the oracle; refused (exit 2) next to any `GRC_*` variable        |
| `RS_FIXTURE_START_FRAME` | `S` >= 1, default 1                                                            |
| `RS_FIXTURE_STEP_FRAMES` | `N` >= 8, default 10                                                           |
| `RS_FIXTURE_QUIT_FRAME`  | >= the default `S + N*5 + 11`                                                  |
| `RS_FIXTURE_VARIANT`     | `""` (default) or `"underline"`; anything else is refused (exit 2)             |
