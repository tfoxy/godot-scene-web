# Gate 4 multilingual fixture

The reference rendering for gate 4's G4f ([`../../protocol/gate4-design.md`](../../protocol/gate4-design.md)
"G4f" and "Q6e"): ten native `Label`s at 16 px on one runtime `FontFile` of Open Sans SemiBold
(`OS`) whose fallbacks are the engine's Vazirmatn (`VZ`), Noto Sans Devanagari UI (`DV`) and Noto
Sans Hebrew (`HE`), in that order. Ten steps (0..9) bring in Greek, Cyrillic and NFD Vietnamese
(OS), Arabic with lam-alef and Persian with ZWNJ (VZ), Hebrew with niqqud and a mixed bidi string
(HE), two Devanagari Labels in one frame (DV), and U+2603, which no pinned font maps (a hex box).
Each fallback's script first appears at its own step. The project does not know about the capture
library and runs the same whether `GRC_EXTENSION` is set or not.

```bash
bash experiments/render-stream/scripts/lib/provision-fonts.sh experiments/render-stream/fixtures/gate4-i18n
mise exec -- godot --headless --path experiments/render-stream/fixtures/gate4-i18n --import
```

## Files

- `project.godot`, `loader.gd`, `fonts/`: as `fixtures/gate4` (Q1e's pins, the `GrcLoader`
  autoload, the ignored font copies).
- `fonts.lock.json`: four entries. Open Sans comes from `packages/html/vendor/` (D2); the three
  OFL-1.1 fallbacks come from the engine checkout's `thirdparty/fonts/` with their sizes, SHA-256
  and licence files. `scripts/lib/provision-fonts.sh` copies and verifies them; no font binary is
  committed here.
- `gate4_i18n.tscn`, `gate4_i18n.gd`: a root `Node`; builds the four fonts (D3's pins, then OS's
  fallbacks), the panel `P`, the Labels and the `Marker` in `_ready()` in `expected.json`
  `creation_order`; `_process()` applies the timeline. At startup it checks, through
  `TextServer.font_has_char`, that the fallback order picks each string's expected font, that OS
  maps U+1EBF and that no font maps U+2603, and exits 2 otherwise.
- `glyph_oracle.gd`: the layout oracle reduced to single-line, left-aligned Labels with the text
  pass only, and extended with every shaped glyph's cluster (`start`, `end`, `count`), font key
  (`null` for no font), advance, offset and pen; the draw commands in order (texture glyphs, and
  the hex box's `add_rect`s recomputed from `TextServer::draw_hex_code_box`); every font's size
  caches; and cmap probes for the predictions (`OS:1EBF`, `DV:0915`, `DV:093F`). Each Label shapes
  in its own direction (`text_direction` is AUTO by default, so the Arabic, Persian and Hebrew
  Labels are RTL paragraphs).
- `make_expected.py`: writes `expected.json` (`--check` compares values). It derives which caches
  gain glyphs, the uploads, the pages, the hex box's `add_rect` count, the sabotage prediction and
  the script predictions from the strings and the rules in its docstring. It never predicts how
  many glyphs a complex string shapes to: the oracle is the only source of those counts.
- `expected.json`: per step the texts, draws, ink lower bounds, glyph commands where predictable,
  hex-box rects, new glyph units, creates, updates, hook and wire versions per page, page counts,
  regions, backgrounds and freshness; `units_model` (the census model's inputs, which the checker
  re-derives from); `script_predictions`; `fallback_first_steps`; and
  `predictions["sabotage-i18n-omit-atlas"]`.

## Layout (640×360; regions `[x0,y0,x1,y1)`)

| Node  | Text (from step)                    | Font picked   | Colour                   | Region                     |
| ----- | ----------------------------------- | ------------- | ------------------------ | -------------------------- |
| `LG`  | `Καλημέρα` (0)                      | OS            | (1,1,1)                  | `[8,8,200,56)`             |
| `LCy` | `Привет` (0), `Привет Καλημέρα` (9) | OS            | (1,.8,.2)                | `[200,8,392,56)`           |
| `LV`  | `Tiếng`, NFD (0)                    | OS            | (.8,.8,1)                | `[8,64,200,112)`           |
| `LAr` | `مرحبا لا` (1)                      | VZ (space OS) | (1,1,1) → (.4,1,.6) at 6 | `[200,64,392,112)`         |
| `LBi` | `abc אבג 123` (4), x+8 at 8         | OS + HE       | (1,1,1,.6)               | `[8,120,200,168)`          |
| `LX`  | U+2603 (7)                          | none: hex box | (1,.6,.6)                | `[200,120,392,168)`        |
| `LD1` | `क्षत्रिय` (5)                      | DV            | (0,0,.2)                 | `[408,16,576,64)`, panel   |
| `LD2` | `कि` (5)                            | DV            | (.2,0,0)                 | `[408,64,576,112)`, panel  |
| `LHe` | `שָׁלוֹם` (3)                       | HE            | (0,0,0,.6)               | `[408,112,576,160)`, panel |
| `LFa` | `می‌خواهم` (2)                      | VZ            | (0,.2,0)                 | `[408,160,576,208)`, panel |

The panel `P` is `(400,8)`, 176×240, colour (1,1,.8); the marker is gate 3's.

## Timeline and census

| step | change                        | uploads (c = create)  |
| ---- | ----------------------------- | --------------------- |
| 0    | Greek, Cyrillic, Vietnamese   | OS@16: c              |
| 1    | `LAr` Arabic                  | VZ@16: c              |
| 2    | `LFa` Persian                 | VZ@16: 1              |
| 3    | `LHe` Hebrew                  | HE@16: c              |
| 4    | `LBi` bidi                    | OS@16: 1, HE@16: 1    |
| 5    | `LD1`, `LD2` Devanagari       | DV@16: c + 1          |
| 6    | `LAr` colour                  | none                  |
| 7    | `LX` U+2603                   | none (26 `add_rect`s) |
| 8    | `LBi` moves 8 px              | none                  |
| 9    | `LCy` two scripts, old glyphs | none                  |

The environment variables are fixtures/gate4's (see its README); every `RS_FIXTURE_VARIANT` is
refused.
