# Gate 4 layout fixture

The reference rendering for gate 4's G4c ([`../../protocol/gate4-design.md`](../../protocol/gate4-design.md)
"G4c" and "Q6e"): fourteen native `Label`s on runtime `FontFile`s of the pinned Open Sans
SemiBold bytes. Ten steps (0..9) cover font sizes and atlas pages, word and arbitrary wrapping,
horizontal and vertical alignment, `clip_text`, a bitmap outline, a shadow, subpixel positioning
and an atlas page's lifetime. Variant `lcd` adds one LCD Label. The project does not know about
the capture library and runs the same whether `GRC_EXTENSION` is set or not.

```bash
bash experiments/render-stream/scripts/lib/provision-fonts.sh experiments/render-stream/fixtures/gate4-layout
mise exec -- godot --headless --path experiments/render-stream/fixtures/gate4-layout --import
```

## Files

- `project.godot`, `loader.gd`, `fonts.lock.json`, `fonts/`: as `fixtures/gate4` (Q1e's pins, the
  `GrcLoader` autoload, the one font).
- `gate4_layout.tscn`, `gate4_layout.gd`: a root `Node`; builds the panel `P`, the Labels and the
  `Marker` in `_ready()` in `expected.json` `creation_order`; `_process()` applies the timeline.
  Fonts: `F` (G4a's settings), `FX` (`F` with subpixel positioning auto), `FL` (`F`'s twin whose
  cache step 8 clears) and, for variant `lcd`, `FC` (LCD antialiasing).
- `glyph_oracle.gd`: fixtures/gate4's oracle extended to Label's full layout and draw: autowrap
  line breaks, fill justification, vertical and horizontal alignment, the shadow, outline and text
  passes (each glyph with its pass colour and its cache, outline caches included), subpixel x
  shifts in the glyph index, and pages from `font_get_size_cache_info` (which also lists the
  draw-time outline caches that `font_get_size_cache_list` hides). After step 8 it names FL's new
  cache `FL2`.
- `make_expected.py`: writes `expected.json` (`--check` compares values). It derives the census
  from the strings and Q1c's rules extended for G4c (its docstring lists them): step 0 shapes
  before drawing, outline glyphs upload per glyph, subpixel uploads are bounded, F@320 opens a
  second page at step 7. It asserts its own hand table, the word-wrap lines and the layout.
- `expected.json`: per step the texts and their draw properties, draws, ink and command counts,
  predicted lines, new glyphs, creates, updates, frees, hook and wire versions per page, page
  counts per cache, regions, backgrounds, clip rects and freshness; the caches' page shapes; the
  LCD variant; and `predictions["sabotage-layout-omit-atlas"]`.

## Layout (640×360; regions `[x0,y0,x1,y1)`)

| Node | Font, size | What it covers | Region |
| ---- | ---------- | -------------- | ------ |
| `LZ` | F 16 → 40 | size change: new cache, 512² page | `[8,8,152,68)` |
| `LS` | F 12 | the 12 px cache | `[152,8,296,68)` |
| `LW` | F 16, `AUTOWRAP_WORD`, 120 wide | word wrap, rewrap at step 2 | `[8,68,152,128)` |
| `LR` | F 16, `AUTOWRAP_ARBITRARY`, 48 wide, alpha .6 | grapheme wrap | `[152,68,296,128)` |
| `LK` | F 16, `clip_text`, 80×28 | clipped overflow | `[8,128,96,188)` (ends at the clip) |
| `LO` | F 24, outline 4 | outline cache, per-glyph uploads | `[152,128,296,188)` |
| `LSh` | F 24, shadow (2,2), `shadow_outline_size` 0 | shadow on the text page | `[8,188,152,248)` |
| `LX` | FX 14 | subpixel variants | `[152,188,296,248)` |
| `AL`, `AC`, `AR`, `AF` | F 16, boxes 120×64 on the panel | left/top, centre/centre, right/bottom, fill/top | panel cells |
| `LL` | FL 16 | page lifetime | `[304,168,440,248)` |
| `LP` | F 320, `clip_text`, box 600×120 | two 1024² pages, clipped | `[8,252,616,360)` (ends at the clip) |
| `LC` | FC 16 (variant `lcd` only) | LCD, typed unsupported | `[440,168,576,248)` |

## Timeline

| step | change | uploads (c = create) |
| ---- | ------ | -------------------- |
| 0 | everything | F@16, F@12, F@24, F@320, FL@16: c; F@24/4: c + 6; FX@14: c + some |
| 1 | `LZ` 16 → 40 px | F@40: c |
| 2 | `LW` "Words wrap again", `LR` "Breakable" | F@16: 1 |
| 3 | `LO` "Overt" | F@24: 1, F@24/4: 2 |
| 4 | `LX` "Subpixel wave" | FX@14: some (bounded) |
| 5 | `AC` right, `AR` top | none |
| 6 | `LK` "Clip me as you can" | F@16: 1 |
| 7 | `LP` "ABCDEFGHIJKLMNOPQRSTUVWXYZ" | F@320: page 0 update, page 1 create |
| 8 | `FL.hinting = NONE` | FL@16 freed, FL2@16: c, in one frame |
| 9 | `LO` outline colour | none |

The environment variables are fixtures/gate4's (see its README), and `RS_FIXTURE_VARIANT=lcd` is
the only variant; the oracle refuses to run with it.
