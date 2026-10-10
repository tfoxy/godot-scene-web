# Gate 4 MSDF fixture

The reference rendering for gate 4's G4e2 ([`../../protocol/gate4-design.md`](../../protocol/gate4-design.md)
"G4e2" and "Q6e"): five native `Label`s on one runtime MSDF `FontFile` `FM` of the pinned Open
Sans SemiBold bytes, with the target game's import values `msdf_size` 48 and `msdf_pixel_range` 24
(D5; a `FontFile.new()` would default to 128 and 14). Their glyphs reach the RenderingServer as
`canvas_item_add_msdf_texture_rect_region`, which render-stream/3 carries. Ten steps (0..9) cover
new glyphs, a size change, an outline toggle, colour changes and a parent rotation. The project
does not know about the capture library and runs the same whether `GRC_EXTENSION` is set or not.

```bash
bash experiments/render-stream/scripts/lib/provision-fonts.sh experiments/render-stream/fixtures/gate4-msdf
mise exec -- godot --headless --path experiments/render-stream/fixtures/gate4-msdf --import
```

## Files

- `project.godot`, `loader.gd`, `fonts.lock.json`, `fonts/`: as `fixtures/gate4` (Q1e's pins, the
  `GrcLoader` autoload, the one font).
- `gate4_msdf.tscn`, `gate4_msdf.gd`: a root `Node`; builds the panel `P`, the Labels, the
  `Node2D` `R` (rotated 20°, scaled 1.5) holding `MR`, and the `Marker` in `_ready()` in
  `expected.json` `creation_order`; `_process()` applies the timeline.
- `glyph_oracle.gd`: fixtures/gate4-layout's oracle with the MSDF branch of `_font_draw_glyph`
  (`text_server_adv.cpp:4021-4025`, outline pass `:4167-4171`): no subpixel shift and no floor,
  the glyph rect scaled by size / msdf_size through the engine's own getters, the quad at
  pen + offset as a float32 add, and per glyph its `outline`, `px_range` and `scale`.
- `make_expected.py`: writes `expected.json` (`--check` compares values). Its docstring lists the
  model: one cache keyed on msdf_size for every draw size and outline, one 512×512 RGBA8 page
  created once at step 0, one upload per Label draw that adds glyphs, none at the size change or
  the outline toggle. It asserts the contract's hand table.
- `expected.json`: per step the texts and their draw properties, draws, ink and command counts,
  passes, new glyphs, creates, updates, hook and wire versions, regions, backgrounds and
  freshness; the cache's page shape; and `predictions` for `sabotage-msdf-perturb-glyph` and
  `sabotage-msdf-receiver-drop` (the gray twin's is in `fixtures/gate4/expected.json`).

## Layout (640×360; regions `[x0,y0,x1,y1)`)

| Node  | Size        | Colour            | What it covers                         | Region               |
| ----- | ----------- | ----------------- | -------------------------------------- | -------------------- |
| `M16` | 16          | (1,1,1)           | new glyphs (steps 1, 7), colour        | `[16,16,240,52)`     |
| `M24` | 24 → 56     | (1,.8,.2)         | the size change, new placement         | `[16,56,336,148)`    |
| `M40` | 40          | (.4,1,.6)         | the outline toggle (4), outline colour | `[16,152,336,232)`   |
| `MT`  | 24, on `P`  | (0,0,0,.6)        | semi-transparent ink on the panel      | `[352,32,568,80)`    |
| `MR`  | 16, under R | (.2,0,.4), on `P` | rotated 20° → 35° and scaled 1.5       | `[352,96,568,200)`   |

## Timeline

| step | change                                   | FM@48 page        |
| ---- | ---------------------------------------- | ----------------- |
| 0    | everything (19 glyphs)                   | create            |
| 1    | `M16` "Hello Wyvern"                     | 1 update          |
| 2    | `M24` 24 → 56 px                         | none              |
| 3    | `M40` outline 4, colour (1,.4,0)         | none              |
| 4    | `M16` colour (1,.6,.6)                   | none              |
| 5    | `R` rotation 20° → 35°                   | none              |
| 6    | `M40` outline colour (.4,1,1)            | none              |
| 7    | `MT` "Jump!", `M16` "Wizard"             | 2 updates, 1 wire |
| 8    | `M24` "Ship"                             | none              |
| 9    | `M40` "Quartz Quiz"                      | none              |

The environment variables are fixtures/gate4's (see its README); there is no variant.
