## Gate 4a result (2026-10-09)

G4a ([protocol/gate4-design.md](../protocol/gate4-design.md) "G4a") passes:
`pnpm render-stream:gate4 -- --legs g4a` is 21/21 in
`artifacts/render-stream/gate4/20261009T231107Z/`. The first run on the same build,
`20261009T230526Z`, was 20/21: only `oracle-agrees` failed, on colour floats printed at 15
digits. The same build passed gate −1 28/28 with 55 hooks (`gate-minus1/20261009T230733Z/`),
gate 0 19/19 (`gate0/20261009T230858Z/`), gate 1 65/65 with all four groups
(`gate1/20261009T231230Z/`), gate 2 85/85 with all five groups (`gate2/20261009T232533Z/`) and
gate 3 `--legs g3a` 16/16
(`gate3/20261009T234532Z/`). Nothing on the capture side or the wire changed: grayscale text is
render-stream/2 as it stands, and the capture leg classifies `success`.

What landed: the Latin grayscale fixture (`fixtures/gate4/`). Its font is provisioned from
`fonts.lock.json` by `scripts/lib/provision-fonts.sh`, so no second copy of a binary is
committed. Also landed: the reference-side glyph oracle (`glyph_oracle.gd`), `make_expected.py`
(the census derived from the strings by Q1c), and the runner, checker and self-test
(`run-gate4.sh`, `check-gate4.ts`, `lib/gate4-*.ts`, `test/self-test-gate4.ts`, 66 assertions).

Images (under the run directory): `reference/shots/step-{0..9}.png`, `early-{1,4,7}.png` (one
frame after each upload step), and the same under `reference-repeat/` and `reference-armed/`.
Outside the text regions every shot equals `synthesizeGate4` exactly. Every text region has ink
exactly when its Label is visible with text, and it changes exactly when expected. The repeat and
the armed reference are byte-identical to the reference, so the **budget is 0** in every region.
Each early shot already equals its settle shot.

Census as measured (hook log, frame of each call; it equals the prediction of gate4-design.md Q6b
in every cell):

| step | frame | F@16 (wire id 2)        | F@24 (3) | DF@16 (4) | other                          | glyph commands |
| ---- | ----- | ----------------------- | -------- | --------- | ------------------------------ | -------------- |
| 0    | 1     | create v1 (H e l o)     | create   | create    | the engine's 800×6 RGBA8 strip | 31             |
| 1    | 11    | update v2 (Q u a r t z) | —        | —         |                                | 37             |
| 2, 3 | —     | —                       | —        | —         | no texture call at all         | 37, 37         |
| 4    | 41    | update v3 (W y v n)     | —        | —         |                                | 43             |
| 5, 6 | —     | —                       | —        | —         | no texture call at all         | 32, 43         |
| 7    | 71    | update v4 **and** v5    | —        | —         | wire publishes v5 only         | 37             |
| 8    | —     | —                       | —        | —         | no texture call at all         | 37             |
| 9    | 91    | —                       | —        | update v2 |                                | 38             |

Each upload is a whole 256² LA8 page: 131 072 data bytes, 131 185 payload bytes. That is 412 867
B published at step 0 (three pages and the hue strip) and 131 185 B at each of steps 1, 4, 7 and 9.
At the hook a page copy costs 10–100 µs and its SHA-256 about 0.4 ms. Teardown frees the runtime
font's two pages at frame 401; the default theme font's page outlives the run.

Atlas parity: at every settle step each page the rendered reference dumps
(`font_get_texture_image` as a GRT1 payload) has the hash of exactly one wire texture:

| steps | F@16              | F@24                | DF@16               |
| ----- | ----------------- | ------------------- | ------------------- |
| 0     | v1 `607c200f69…`  | v1 `366798e78b…`    | v1 `e9fd3088be…`    |
| 1–3   | v2 `ab83b838df…`  | same                | same                |
| 4–6   | v3 `4deb468ed7…`  | same                | same                |
| 7, 8  | v5 `b446a2d32c…`  | same                | same                |
| 9     | same              | same                | v2 `8477ff7922…`    |

Headless rasterization is therefore byte-identical to the rendered reference's. All 372 glyph
commands (both sinks) equal the oracle's quads and source rects as float32 exactly, with the font
colour as modulate. The four consecutive version pairs wrote 1 105 texels, all onto empty `(255,0)`
texels.

### Findings

- **Every census prediction held on the first run.** These include the step 7 double upload, the
  hidden Label that rasterizes nothing until shown, zero texture traffic on the transform-only,
  hidden-text, emptied, reordered and recoloured steps, and the default theme font's own page.
- **The oracle needs the engine's own paragraph.** A Label shapes `text + U+200B`. An oracle that
  shapes the bare text would differ for any font that kerns or ligates against it.
- **Amendments** (gate4-design.md G4a "As built"): the capture quits at 400 as in gates 0–3, the
  early shots are `early-<k>.png`, the oracle prints floats at full precision, and glyph sets are
  compared by glyph index.

### What G4a does not prove

- That a receiver draws any of this: that is G4b, which replays the recording with the unchanged
  receiver.
- Subpixel variants, outlines, shadows, wrapping, alignment, `clip_text`, multiple pages, cache
  lifetime (G4c), RichTextLabel (G4d), MSDF (G4e), or complex scripts and fallback (G4f).

## Gate 4b result (2026-10-09)

G4b ([protocol/gate4-design.md](../protocol/gate4-design.md) "G4b") passes:
`pnpm render-stream:gate4 -- --legs g4a,g4b` is 37/37 in
`artifacts/render-stream/gate4/20261010T003432Z/` (a first, identical-logic run at
`20261010T002835Z` caught a checker bug, below). The same build passed `build-capture.sh` (10/10
ctests), gate −1 (`gate-minus1/verify-g4b/`), gate 0 19/19 (`gate0/20261010T002934Z/`), gate 1
65/65 with all four groups (`gate1/20261010T003023Z/`), gate 2 85/85 with all five groups
(`gate2/20261010T003027Z/`) and gate 3 `--legs g3a` 16/16 (`gate3/20261010T003042Z/`). No
receiver, mirror or fixture file changed; the receiver is the one gates 0–3 already exercise.

What landed: `synthesizeText`/`compareSynthesizedText` in `lib/gate4-expected.ts` (D8's ink:
oracle quads sampled against a page's LA8 alpha, in the node's font colour, straight-alpha
blended over the region's background); `receiverStepSeqs`/`loadReceiverShots` in
`lib/gate4-checks.ts`, which re-key a receiver's wire-seq shots to the reference's filenames so
every G4a shot evaluator runs over a receiver unchanged; `computeGate4Checkpoints` plus
`checkLegClass` (classifyLeg against a leg's class and, for a sabotage, its exact predicted
mismatching steps); `loadAtlasPageImages`/`loadPagesByStep`; `evaluateExpectedText`/
`checkExpectedText`; `evaluateResourceQuiet`; `checkReceiverNeverShapes`;
`checkReceiverConsumedStream`; `checkReceiverTypedClean`; and `checkAtlasHashParitySabotage`. The
runner (`run_g4b`, `g4_capture`, `early_shots_csv`) adds group `g4b`: the unchanged receiver on
the main capture's full and patch sinks (plus the early shots at frames 12, 42 and 72), a headless
openat trace, and three fresh sabotage captures at the fixture's own 102-frame default — each with
its own rendered receiver.

Images (under the run directory): `receiver/shots/` and `receiver-patch/shots/` (`seq-<n>.png`,
re-keyed to `step-<k>.png`/`early-<k>.png` by the checker), and
`sabotage-{freeze,perturb,omit-atlas}/receiver/shots/`. `receiver-vs-reference` is exact on both
sinks, full frame and every region (budget 0, as the reference-repeat budget already was).
`expected-text-reference` and `expected-text-receiver` (D8's new, independent check) hold the
budget exactly: **max channel delta 1**, 5 301 pixels at delta ≥ 1 across the ten steps' seven
text regions — every one of them inside the documented UNORM8-blend-rounding allowance, with none
at delta 2 or more.

Sabotage outcomes, matched to G4a's predictions exactly:

| Leg                    | Sabotage                                   | Class          | Mismatching steps | atlas-hash-parity                      |
| ----------------------- | ------------------------------------------- | -------------- | ------------------ | --------------------------------------- |
| `sabotage-freeze`      | `freeze-frame` @ frame 11 (step 1)         | `pixel-mismatch` | {1..9}            | n/a                                      |
| `sabotage-perturb`     | `perturb-transform` @ frame 21 (step 2)    | `pixel-mismatch` | {2..9}            | n/a                                      |
| `sabotage-omit-atlas`  | `omit-op texture_2d_update` @ frame 41 (step 4) | `pixel-mismatch` | {4..9}       | fails exactly at `F@16` {4..9}, `DF@16` {9} |

Every step outside a leg's predicted set matches the reference exactly (`checkLegClass` asserts
this explicitly, not just the overall class). `receiver-never-shapes` found no `*.ttf`/`*.otf`/
`*.woff`/`*.woff2`/`*.fnt`/`*.fontdata` opened by the traced receiver and no `TextServer`, `Font`,
`Label`, `RichTextLabel`, `draw_string` or `draw_char` symbol in any of the receiver's 11 `.gd`
files. `receiver-consumed-stream`, `receiver-never-loaded-fixture` and `receiver-typed-clean` are
clean across all six receiver legs. `resource-quiet` confirms the five no-texture-traffic steps
(2, 3, 5, 6, 8) fetch and upload nothing on either sink.

### Findings

- **The checker, not the runner, had the only bug.** The first run's three sabotage legs
  classified `replay-failure` instead of `pixel-mismatch`: the checker's `requestedShotSeqs`
  wrongly included the early-frame seqs (12/42/72) for a sabotage receiver, which `run_g4b` never
  requests (only the plain `receiver`/`receiver-patch` legs shoot them). Fixed by restricting a
  sabotage leg's `requestedShotSeqs` to its settle seqs; re-running only the checker against the
  same evidence (no Godot re-run needed) turned all three green, and a full fresh run confirmed
  it byte-for-byte.
- **D8's budget held at exactly its ceiling, not below it.** 5 301 pixels sit at delta 1 and none
  at 2+, across both the reference's own shots (a sanity check on the synthesizer itself) and the
  receiver's (the real claim). This is the first evidence that the synthesizer's blend model
  (straight alpha, node colour, LA8 coverage, no filtering) matches the GPU's UNORM8 rounding to
  within its documented tolerance and no further.
- **Reusing G4a's shot evaluators needed one seam, not a rewrite.** Re-keying a receiver's
  `seq-<n>.png` files to the reference's `step-<k>.png`/`early-<k>.png` names
  (`loadReceiverShots`) let `evaluateExpectedImage`, `evaluateInkPresence`, `compareLegs` and the
  new `evaluateExpectedText` run unchanged over either side.

### What G4b does not prove

- Anything G4c–G4f own: sizes, pages, wrapping, alignment, `clip_text`, outlines, shadows,
  subpixel, cache lifetime and LCD (G4c); `RichTextLabel` spans (G4d); MSDF and `render-stream/3`
  (G4e); multilingual shaping (G4f).
- That the receiver's apply order for clipped text is correct: G4c and G4d wait for G3b for that
  reason (D13); G4b's Labels never clip.

## Gate 4c result (2026-10-10)

G4c ([protocol/gate4-design.md](../protocol/gate4-design.md) "G4c", "As built (G4c)") passes:
`pnpm render-stream:gate4 -- --legs g4a,g4b,g4c` is 79/79 in
`artifacts/render-stream/gate4/20261010T023733Z/` (g4c alone 43/43 at `gate4/dev-g4c-2/`). The
same build passed `build-capture.sh` (11/11 ctests), gate −1 28/28 (`gate-minus1/20261010T015223Z/`),
gate 0 19/19 (`gate0/20261010T015342Z/`), gate 1 65/65 (`gate1/20261010T015624Z/`), gate 2
85/85 (`gate2/20261010T020714Z/`) and gate 3 49/49 with g3a–g3c (`gate3/20261010T022208Z/`).
No capture, receiver or protocol file changed.

What landed: `fixtures/gate4-layout/` (14 Labels on runtime `FontFile`s of the pinned bytes:
sizes 12/14/16/24/40/320, word and arbitrary wrap, left/centre/right/fill and top/centre/bottom
alignment, two `clip_text` Labels, an outline-4 Label, a shadow, a subpixel-`auto` font, a cache
whose hinting changes, and variant `lcd`), its oracle (Label's whole layout and draw, every pass),
`make_expected.py`, group g4c in `run-gate4.sh` (legs under `<out>/layout/`) and
`lib/gate4c-checks.ts`. Images: `layout/reference/shots/step-<k>.png` and `early-<k>.png`,
`layout/receiver{,-patch}/shots/`, `layout/sabotage-omit-atlas/receiver/shots/`,
`layout/lcd/{reference,receiver}/shots/`.

Every glyph command (1 269 per sink over the ten settle steps, shadow, outline and text passes)
equals the oracle float32-exact, every oracle page hashes to exactly one wire texture, and the
receivers equal the reference exactly. D8's synthesized ink, now per pass colour, outline page and
clip, holds at **max channel delta 1** (21 386 px at delta 1). Census as measured (c = create,
u = updates, f = free; `F@24/4` is the outline cache):

| step | change                     | uploads                                                                 |
| ---- | -------------------------- | ----------------------------------------------------------------------- |
| 0    | everything                 | F@16, F@12, F@24, F@320, FL@16: c; F@24/4: c + u6; FX@14: c + u7        |
| 1    | LZ 16 → 40 px              | F@40: c (512²)                                                          |
| 2    | LW, LR rewrap              | F@16: u1                                                                |
| 3    | LO "Overt"                 | F@24: u1; F@24/4: u2                                                    |
| 4    | LX "Subpixel wave"         | FX@14: u5                                                               |
| 5, 9 | alignment; outline colour  | none                                                                    |
| 6    | LK new clipped text        | F@16: u1                                                                |
| 7    | LP's 26 capitals at 320 px | F@320 page 0: u1, page 1: c (two 1024² LA8 pages, 4 MiB published)      |
| 8    | FL.hinting = NONE          | FL@16 page (wire id 7): f; FL2@16 page (wire id 11): c, both in frame 81 |

Subpixel census (`FX@14`, quarter pixel, x shifts {0,1,2,3}): 8 uploads against 17 new
(glyph, shift) pairs at step 0, and 5 against 6 at step 4. Clips derived from the wire: LK
`[16,132,96,160)`, LP `[16,147,616,360)`. `sabotage-layout-omit-atlas` (omit
`texture_2d_update` from frame 71) is `pixel-mismatch` at exactly {7,8,9}, with all 23 393
differing pixels inside LP, and its parity fails exactly at F@320 {7,8,9}. `capture-lcd` and
`receiver-lcd` are `unsupported` (`canvas_item_add_lcd_texture_rect_region`/`unsupported-op`,
7 commands, beside an `ok` RGBA8 256² page). The receiver differs from `reference-lcd` only inside
LC's region (437 px per step).

### Findings

- **Labels added in `_ready` shape before anything draws.** A Control's post-enter-tree minimum
  size update is synchronous (`control.cpp:3803-3807`), and it shapes the Label. So every plain
  page is created once at step 0, whatever feeds it. Q1c's per-draw rule starts at step 1.
- **Outline and subpixel glyphs upload one at a time.** Both rasterize at draw time, so each new
  outline glyph or (glyph, shift) variant is its own whole-page upload. This is gate 6's
  hash-at-publish input (D9).
- **Draw-time caches hide from `font_get_size_cache_list`.** They carry the viewport's
  oversampling level. The oracle uses `font_get_size_cache_info`.
- **The default theme's `shadow_outline_size` is 1.** A shadowed Label would draw a second pass
  from its own `(size, 1)` cache. The fixture pins it to 0, as Q6e's "reuses the text page"
  assumes.
- **A free Label never shrinks below its minimum.** LP's 600×120 box is 600×437, so its clip ends
  at the viewport. An autowrap Label's first minimum is computed at width 0, so the fixture sets
  each box, re-shapes and sets it again.
- `run_g4c` imports `receiver/`. A fresh worktree had never imported it, and `run_g4b` relies on
  an earlier gate having done so.

### What G4c does not prove

- Fractional glyph quads: subpixel quads are still floored at scale 1, so MSDF's unfloored quads
  are G4e2's. `RichTextLabel` (G4d), multilingual shaping and fallback pages (G4f).
- LCD rendering on a receiver: it stays typed `unsupported` (Deferred).
- Overrun trimming, ellipses, `max_lines_visible`, paragraph separators and stacked outlines or
  shadows. The oracle refuses ellipses and models one paragraph.

## Gate 4d result (2026-10-10)

G4d ([protocol/gate4-design.md](../protocol/gate4-design.md) "G4d", "As built (G4d)") passes:
`pnpm render-stream:gate4 -- --legs g4a,g4b,g4d` is 62/63 in
`artifacts/render-stream/gate4/20261010T031556Z/` (the one non-pass is the expected `not-run`
placeholder for `g4c`, landed but not requested in this `--legs`; g4d's own 24 checks are all
`pass`). The same build passed `build-capture.sh` (11/11 ctests), gate −1 28/28
(`gate-minus1/20261010T015258Z/`), gate 0 19/19 (`gate0/20261010T015440Z/`), gate 1 65/65
(`gate1/20261010T015728Z/`), gate 2 85/85 (`gate2/20261010T020936Z/`) and gate 3 49/49 with
g3a–g3c (`gate3/20261010T030336Z/`). No capture, receiver or protocol file changed.

What landed: `fixtures/gate4-rich/` (a `RichTextLabel` with `[color]`, plain, `[font_size=24]`,
`[b]` (a `FontVariation` embolden 1.2), `[i]` (a `FontVariation` transform skewed 0.2),
`[bgcolor]` and an outlined (`[outline_size=2]`) span, cumulative over six steps, plus an
`append_text` step), its own glyph oracle (`glyph_oracle.gd`, per-span glyph sets and counts, not
quads: Q6c), `make_expected.py`, group `g4d` in `run-gate4.sh` (legs under `rich-*/`) and
`lib/gate4d-checks.ts`. Images: `rich-reference/shots/step-{0..5}.png`,
`rich-receiver{,-patch}/shots/`, `rich-underline/{reference,receiver}/shots/`.

Every glyph command (176 over the six settle steps x 2 sinks) sums by wire id to the oracle's
per-span `glyph_count` exactly; bold and italic map to their own wire ids (`FB@16`=4, `FI@16`=5,
distinct from `F@16`=2); every `[bgcolor]` span has its matching `add_rect`. Every oracle page
hashes to exactly one wire texture at every step, and `deriveClipRects` (gate 3's) gives `RTL`
its fixed clip rect `[24,32,424,222)` on both sinks at every step (`fit_content` never needs to
grow it: the chosen 190 px height covers every step's content). `reference-repeat-budget` is 0 in
every region. Census as measured (c = create, u = update):

| step | change                                        | uploads                                          |
| ---- | ---------------------------------------------- | ------------------------------------------------- |
| 0    | `[color]Amber[/color] plain [font_size=24]Big` | `F@16`: c (10 glyphs); `F@24`: c (3)              |
| 1    | `+ [b]Bold[/b]`                                 | `FB@16`: c (4)                                    |
| 2    | `+ [i]Italic[/i]`                               | `FI@16`: c (6)                                    |
| 3    | `+ [bgcolor=cyan]Marked[/bgcolor]`              | `F@16`: u1 (M, k, d)                               |
| 4    | `+ [outline_size=2]Outlined[/outline_size]`     | `F@16`: u1 (O, u, t); `FO@16`: c + u7 (8 glyphs, one event per glyph) |
| 5    | `append_text("\n[color=magenta]More[/color]")` | `F@16`: u1 (o)                                    |

### Findings

- **`RichTextLabel` is never `leg-class` `success`.** Its per-line box-drawing pass unconditionally
  emits `canvas_item_add_set_transform` (identity or not), which `render-stream-0.md` types
  `unsupported`, unrelated to any span. `rich-leg-class-capture` requires `unsupported` with
  *exactly* that op and nothing else, and separately requires zero pixel mismatch (the reset is
  visually inert here). The underline variant's `leg-class` is `unsupported` for two reasons once
  this is accounted for; `rich-underline-capture-class` only asserts `canvas_item_add_line` is
  among the reasons, not the only one.
- **An outline cache uploads once per new glyph, not once per redraw.** The first `make_expected.py`
  draft modelled it like a fill cache (one event for the whole span) and `rich-atlas-census` failed
  61/62 against the real capture, which showed 8 events (1 create + 7 updates) for the 8-glyph
  "Outlined" span's first use; a checker/model re-run against the *unchanged* evidence after fixing
  the model (memory rs-g4b-receiver-checker-facts' pattern one gate later) turned it 62/62. Source
  (`_font_draw_glyph_outline`, `ts_adv:4068-4136`) confirms why: it checks its own texture's
  `dirty` flag inline, per glyph, with no shaping-time pre-rasterization pass of its own -- unlike
  the fill path, which rasterizes a whole redraw's new glyphs together before any drawing. G4c
  found the same fact independently for its own outline and subpixel caches.
- **`RichTextLabel` always has an internal `VScrollBar` child**, its own `CanvasItem` created right
  after `RTL`'s and before `Marker`'s, present regardless of `scroll_active` and drawing nothing
  here; `creation_order` needed a third name.
- **The outlined span's two-pass oracle design held on the first measurement**: `glyph_oracle.gd`
  expands one `outline > 0` span into two entries sharing its `key` (fill `F@16`, outline `FO@16`),
  and `evaluateRichOracleAgrees`'s zero-problem result against the real oracle confirmed the model
  before any capture comparison ran (D7).

### What G4d does not prove

- Exact glyph placement for `RichTextLabel`: the oracle reports per-span counts and sets, not
  quads (Q6c), so there is no `rich-expected-text-*` (D8's exact synthesis). `rich-expected-image-*`
  and `rich-ink-presence-*` (quad-independent) still hold exactly.
- Wrapping, alignment, multiple pages, cache lifetime and LCD for `RichTextLabel` specifically
  (G4c covers these for `Label`); MSDF spans (G4e); multilingual spans (G4f).
- `[u]` underline placement beyond "confined to `RTL`'s region": the stroke's own geometry is not
  checked, only that dropping it changes no pixel outside `RTL`.

## Gate 4f result (2026-10-10)

G4f ([protocol/gate4-design.md](../protocol/gate4-design.md) "G4f", "As built (G4f)") passes:
`pnpm render-stream:gate4 -- --legs g4a,g4b,g4c,g4d,g4f` is 142/142 in
`artifacts/render-stream/gate4/20261010T041606Z/` (g4f's own 38 checks; g4f alone was 38/38 on
its first run). The same build passed `build-capture.sh` (11/11 ctests), gate −1 28/28
(`gate-minus1/20261010T043254Z/`), gate 0 19/19 (`gate0/20261010T043412Z/`), gate 1 65/65
(`gate1/20261010T043647Z/`), gate 2 85/85 (`gate2/20261010T044740Z/`) and gate 3 56/56 with
g3a–g3d (`gate3/20261010T050200Z/`). No capture, receiver or protocol file changed.

What landed: `fixtures/gate4-i18n/` (ten Labels at 16 px on one runtime `FontFile`, Open Sans,
whose fallbacks are the engine's Vazirmatn, Noto Sans Devanagari UI and Noto Sans Hebrew, pinned
in `fonts.lock.json` from `../godot-4.5.1-stable/thirdparty/fonts/` with their SHA-256 and OFL-1.1
licence files and provisioned, never committed), its oracle (shaped clusters, fallback font keys,
hex boxes), `make_expected.py`, group g4f in `run-gate4.sh` (legs under `<out>/i18n/`) and
`lib/gate4f-checks.ts`. Images: `i18n/reference/shots/step-<k>.png` and `early-{1..5}.png`,
`i18n/receiver{,-patch}/shots/`, `i18n/sabotage-omit-atlas/receiver/shots/`.

Every glyph command (441 per sink over the ten settle steps) and every hex-box `add_rect` equals
the oracle float32-exact, each glyph names its own font's page, every oracle page hashes to
exactly one wire texture, and the receivers equal the reference exactly. Reference against repeat
is 0 in every region. D8's synthesized ink holds at **max channel delta 1** (6 312 px at delta 1;
the hex box at 0). Census as measured, with the atlas bytes published per step and the copy/hash
cost per step in µs:

| step | change                                       | uploads (c = create, u = update) | bytes   | copy/hash |
| ---- | -------------------------------------------- | -------------------------------- | ------- | --------- |
| 0    | `LG` Greek, `LCy` Cyrillic, `LV` NFD Vietnamese | OS@16: c (+ the 800×6 hue strip) | 150 497 | 15/434    |
| 1    | `LAr` Arabic                                  | VZ@16: c                         | 131 185 | 12/466    |
| 2    | `LFa` Persian with ZWNJ                       | VZ@16: u1                        | 131 185 | 11/472    |
| 3    | `LHe` Hebrew with niqqud                      | HE@16: c                         | 131 185 | 10/403    |
| 4    | `LBi` `abc אבג 123`                            | OS@16: u1, HE@16: u1             | 262 370 | 241/951   |
| 5    | `LD1` `क्षत्रिय`, `LD2` `कि` (one frame)        | DV@16: c + u1 (hook v1, v2; wire v2) | 131 185 | 77/746 |
| 6–9  | colour, U+2603, a move, old glyphs in two scripts | none                         | 0       | 0/0       |

Script predictions (`script-predictions`, on the oracle and on both sinks), all held: the NFD
`e + U+0302 + U+0301` is 1 glyph, OS's U+1EBF (828); lam-alef is 1 Vazirmatn glyph; ZWNJ is an
invisible index-0 glyph; shin + qamats + shin dot is one 3-glyph cluster with one advancing glyph,
the marks over the base; `क्षत्रिय` is 4 glyphs for 8 codepoints; `कि`'s i-matra quad is at x −1,
left of KA's at 3; the Hebrew run's quads go 75 > 67 > 61 in logical order; U+2603 is 26
`add_rect`s and no texture command. `fallback-pages`: OS's page at step 0 (wire id 2), VZ's at 1
(3), HE's at 3 (4), DV's at 5 (5), each created once in its step's applied frame. Atlas parity:

| step | OS@16       | VZ@16       | HE@16       | DV@16       |
| ---- | ----------- | ----------- | ----------- | ----------- |
| 0    | 2@v1 9d6955 | —           | —           | —           |
| 1    | 2@v1 9d6955 | 3@v1 55a318 | —           | —           |
| 2    | 2@v1 9d6955 | 3@v2 01d278 | —           | —           |
| 3    | 2@v1 9d6955 | 3@v2 01d278 | 4@v1 47b3a5 | —           |
| 4    | 2@v2 95d9e4 | 3@v2 01d278 | 4@v2 e723bc | —           |
| 5–9  | 2@v2 95d9e4 | 3@v2 01d278 | 4@v2 e723bc | 5@v2 faf885 |

`sabotage-i18n-omit-atlas` (omit `texture_2d_update` from frame 51) is `pixel-mismatch` at
exactly {5..9}, all 94 differing pixels per step inside LD2, and its parity fails exactly at DV@16
{5..9}.

### Findings

- **`Label.text_direction` defaults to AUTO** (`scene/gui/label.h:70`), so the Arabic, Persian and
  Hebrew Labels are RTL paragraphs; the oracle shapes in the Label's own direction.
- **`Font.get_rids`, `has_char` and `get_height` walk the fallback chain.** The oracle keys fonts
  by `get_rids()[0]`, the fixture tests coverage with `TextServer.font_has_char`, and the line
  height is the chain's maximum (26 at 16 px), which leaves a 23 px line's pen at y 19.5.
- **Every fallback's cache exists from step 0, empty** (`Font::get_height` asks each fallback's
  metrics); only the pages wait for the script.
- **The hex box sits on half pixels** (y 7.5) because glyph quads floor the pen but `add_rect`s do
  not; it rasterizes by the half-open pixel-centre rule exactly.
- **Two Devanagari Labels in one frame** give a create and an update of DV's page in frame 51, and
  only the second carries anything new (KA; the i-matra glyph is shared), so the sabotage is
  LD2-only.

### What G4f does not prove

- Glyph counts for complex scripts from first principles: the oracle is their only source, and
  the hand model predicts only which caches gain glyphs.
- Autowrap, alignment or ellipses with complex scripts, RTL layout direction
  (`root_node_layout_direction` stays LTR), explicit `language` tags (`locl`), system fallback,
  colour or emoji fonts, and `RichTextLabel` spans in other scripts.
- Subpixel positioning or MSDF on the fallbacks (G4e2 owns MSDF).

## Gate 4e result (2026-10-10)

G4e2 ([protocol/gate4-design.md](../protocol/gate4-design.md) "G4e2", "As built (G4e2)") passes:
`pnpm render-stream:gate4` (every landed group, g4a–g4f) is 185/185 in
`artifacts/render-stream/gate4/20261010T064607Z/`, g4e's own 43/43. Everything now runs on
[protocol/render-stream-3.md](../protocol/render-stream-3.md): the capture publishes `GRS3` with the
/3 features and serves `render-stream.3`, the receiver decodes /3 and replays
`add_msdf_texture_rect_region`, and every checker decodes /3, g4d and g4f included (recordings
keep their `.rs2` names; /2 decoding remains for `golden-2/` only). The same build passed
`build-capture.sh` (11/11 ctests), `calibrate.sh --check`, gate −1 28/28 with 56 hooks
(`gate-minus1/20261010T061257Z/`), gate 0 19/19 (`gate0/20261010T061413Z/`), gate 1 65/65
(`gate1/20261010T061700Z/`), gate 2 85/85 (`gate2/20261010T062637Z/`) and gate 3 56/56 with
g3a–g3d (`gate3/20261010T063835Z/`).

What landed: the mirror's msdf tap and the `perturb-glyph` sabotage (`rs_mirror`, `hooks.cpp`,
which also records the msdf arguments in `counters.json`), the /3 session and live hub
(`rs_publish`, `rs_live`, `entry.cpp`), the receiver's msdf replay and `drop-msdf` sabotage
(`rs_applier.gd`, `receiver.gd`, `applied.json` `msdf_commands`), `fixtures/gate4-msdf/` (five
Labels on one MSDF `FontFile` with the target game's `msdf_size` 48 and `msdf_pixel_range` 24 at
16, 24, 40 and 56 px, an outline toggled on, one Label under a Node2D rotated 20° → 35° and scaled
1.5), its oracle and `make_expected.py`, group g4e in `run-gate4.sh` (legs under `<out>/msdf/`) and
`lib/gate4e-checks.ts`. Images: `msdf/reference/shots/step-{0..9}.png` and `early-{1,7}.png`,
`msdf/receiver{,-patch}/shots/`, `msdf/sabotage-perturb-glyph/receiver/shots/`,
`msdf/sabotage-receiver-drop/receiver/shots/`, `msdf/sabotage-gray-perturb-glyph/receiver/shots/`.

Every msdf command (338 over the ten settle steps × 2 sinks) equals the oracle's float32 quad and
source rect bit for bit, with `outline` 0 or 4 as its pass sets it, `px_range` 24 and
`scale = size / 48` (15 080 msdf commands on the full sink, 3 460 of them outline-pass). The one
page hashes to the oracle's dump at every step and every new version writes only empty texels
(27 049). **The MSDF budget, measured from the same-build reference repeat, is 0 in every region**,
and both receivers equal the reference exactly. Census as measured:

| step | change                         | `FM@48` (512² RGBA8)                 | msdf commands |
| ---- | ------------------------------ | ------------------------------------ | ------------- |
| 0    | everything (19 glyphs)         | create (1 048 692 B payload)         | 25            |
| 1    | `M16` "Hello Wyvern"           | 1 update                             | 31            |
| 2    | `M24` 24 → 56 px               | none                                 | 31            |
| 3    | `M40` outline 4 on             | none                                 | 37            |
| 4–6  | colour, R rotation, outline colour | none                             | 37            |
| 7    | `MT` "Jump!", `M16` "Wizard"   | 2 updates in frame 71, wire v4       | 33            |
| 8, 9 | new placement, new text        | none                                 | 31, 39        |

Cost at the hook per 1 MiB page upload: copy 0.55–0.62 ms, hash 3.0–3.4 ms (step 7's two uploads
6.0 ms of hashing). Sabotages, each exactly as predicted: `sabotage-msdf-perturb-glyph` is
`pixel-mismatch` at {1..9}, confined to the Labels that redrew after frame 11 (M16 from step 1, M24
from 2, M40 from 3, MT from 7; MR never redraws and never mismatches), with +0.25 on exactly those
Labels' 235 recorded rects; `sabotage-msdf-receiver-drop` is `pixel-mismatch` at {0..9} in every
text region and replays no msdf command; `sabotage-gray-perturb-glyph` (fixtures/gate4) is
`pixel-mismatch` at {1..9} in L1, LH, L2, L3 and LD as each redraws, a quarter pixel on the integer
path (701 px at step 1, max delta 51).

### Findings

- **One MSDF cache for every size.** The cache key is `msdf_size`, so 16, 24, 40 and 56 px and the
  outline pass share one page: a size change or an outline toggle uploads nothing. At range 24 a
  glyph cell is about 78×87 texels, so a 512² page holds about 30 glyphs.
- **perturb-glyph moves only re-recorded commands.** It acts where the mirror records, so a Label
  whose commands were recorded before the sabotage frame keeps them: the prediction is per Label
  from its first redraw, and a transform-only parent never reveals it.
- **The oracle's MSDF quads are bit-exact by construction.** The engine's getters and its draw
  scale the glyph rect the same way (Vector2 × real_t, then / real_t), so pen + offset in float32
  reproduces every command with no tolerance.
- **A dormant gate 3 test.** `rs_mirror_test`'s `test_clip_ignore_tap` (G3d) was never called from
  `main()` and had two wrong expectations; G4e2 calls it and fixed them.

### What G4e2 does not prove

- MSDF pixels against an independent synthesis: the shader's `fwidth` coverage is not modelled
  (no `expected-text-*`). The claim is atlas parity, bit-exact commands, a zero repeat budget and
  receiver equality on one GPU and driver.
- Browser receivers' MSDF (gate 7), MSDF under `canvas_items` stretch (gate 6), several MSDF pages
  or `msdf_size` 128, and the target game's own fonts (gate 8).
- Live MSDF delivery beyond the shared /3 live path (gate 1's and gate 2's live legs pass on /3,
  but no live leg draws MSDF text).

## Gate 4 summary

Gate 4 passes: `pnpm render-stream:gate4` with all groups g4a-g4f is **185/185** in
`artifacts/render-stream/gate4/20261010T075427Z/`, on the same build as gate −1
(`artifacts/render-stream/gate-minus1/20261010T072444Z/`), gate 0 19/19
(`gate0/20261010T072550Z/`), gate 1 65/65 (`gate1/20261010T072751Z/`), gate 2 85/85
(`gate2/20261010T073607Z/`) and gate 3 56/56 with g3a–g3d (`gate3/20261010T074659Z/`). Every leg
is at its expected class. Images are under each leg's `shots/` in the run directory:
`reference/shots/step-{0..9}.png`, `reference-repeat/shots/` and `reference-armed/shots/` (g4a);
`receiver/shots/` and `receiver-patch/shots/` (g4b); `layout/reference/shots/`,
`layout/receiver{,-patch}/shots/` and `layout/lcd/{reference,receiver}/shots/` (g4c);
`rich-reference/shots/step-{0..5}.png`, `rich-receiver{,-patch}/shots/` and
`rich-underline/{reference,receiver}/shots/` (g4d); `msdf/reference/shots/step-{0..9}.png` and
`msdf/receiver{,-patch}/shots/` (g4e); `i18n/reference/shots/` and `i18n/receiver{,-patch}/shots/`
(g4f).

What it proves, by increment:

- **4a.** Grayscale text needs no new capture machinery: a glyph is `add_texture_rect_region`
  naming an `ImageTexture` atlas page, already on render-stream/2. The headless host rasterizes
  atlases byte-identical to the rendered reference's, hash for hash, at every step, and every
  glyph command on the wire equals the reference's own TextServer oracle, float32-exact. The
  budget (reference against a same-build repeat) is 0.
- **4b.** The unchanged receiver — no fonts, no TextServer, never shapes — replays grayscale text:
  synthesized ink (oracle quads × atlas alpha × colour, straight-alpha blended) against both the
  reference and the receiver holds at max channel delta 1, the documented ceiling for UNORM8
  blend rounding, and never above it.
- **4c.** Layout: sizes, word and arbitrary wrap, alignment, `clip_text`, an outline and a shadow
  pass, a draw-time subpixel-`auto` font and a cache whose hinting changes mid-run, all at max
  channel delta 1 (21 386 px at delta 1, none higher). `canvas_item_add_lcd_texture_rect_region`
  (the `lcd` variant) is `unsupported`, typed, on both the capture and the receiver.
- **4d.** `RichTextLabel` spans (`[color]`, `[b]`, `[i]`, `[bgcolor]`, an outlined span) each
  upload to their own wire id and sum to the oracle's per-span glyph counts exactly, and every
  `[bgcolor]` span has its matching `add_rect`. `RichTextLabel` itself is never `leg-class`
  `success`: its per-line box-drawing pass unconditionally emits `canvas_item_add_set_transform`,
  typed `unsupported` since render-stream-0.md, independent of which spans it draws.
- **4e.** `render-stream/3` carries MSDF text (`add_msdf_texture_rect_region`) as a supported
  command; every gate now runs on it. Every msdf command matches the oracle's float32 quad and
  source rect bit for bit, with `outline`, `px_range` and `scale` as the oracle computes them; the
  one atlas page hashes to the oracle's dump at every step, and every new version writes only
  empty texels. The MSDF budget, measured from a same-build reference repeat, is 0 in every
  region, and both receivers equal the reference exactly.
- **4f.** Multilingual shaping with fallback fonts (Vazirmatn, Noto Sans Devanagari UI, Noto Sans
  Hebrew behind the pinned Open Sans): NFD composition, lam-alef ligation, an invisible ZWNJ
  glyph, Hebrew marks over their base, Devanagari conjuncts and a missing-glyph hex box all hold
  on the oracle and on both sinks, float32-exact, and each fallback's own atlas page is created
  once, in its own step.

Unsupported, each typed and never substituted: LCD subpixel text
(`canvas_item_add_lcd_texture_rect_region`, `unsupported-op`) on both capture and receiver —
its pixels depend on the host's `lcd_subpixel_layout` matching the viewer's physical panel, and
gate 7's receiver manifests decide whether it is ever supported (Deferred); `RichTextLabel` as a
whole, which classifies `unsupported` because of `canvas_item_add_set_transform` regardless of
which spans it draws; and underline/strikethrough (`add_line`) and `clip_ignore` for
`RichTextLabel`/`Tree`/`ItemList` focus outlines, both deferred to gate 5's own wire bump
(`render-stream/4`).

Costs measured in this run:

- **Atlas uploads.** A whole 256² LA8 grayscale page is 131 072 data bytes / 131 185 payload
  bytes. G4c's 320 px Label publishes two 1024² LA8 pages (4 MiB) in one frame. G4e's 512² RGBA8
  MSDF page is 1 048 692 payload bytes at create, and every later version writes only empty
  texels.
- **Copy and hash at the hook.** Grayscale and layout pages: 10–100 µs to copy, about 0.4 ms to
  hash. MSDF, per 1 MiB page: copy 0.55–0.62 ms, hash 3.0–3.4 ms (a double upload in one frame, 6.0
  ms of hashing).
- **Synthesized-ink budgets.** Grayscale, layout and multilingual text all hold at max channel
  delta 1 against D8's straight-alpha oracle synthesis (21 386 px at delta 1 in G4c, 6 312 in
  G4f), none at delta 2 or higher. MSDF's budget, measured the same way, is 0 in every region.

What gate 4 does not prove: MSDF pixels against an independent synthesis — the shader's `fwidth`
coverage is not modelled, so the claim is atlas parity, bit-exact commands, a zero repeat budget
and receiver equality on one GPU and driver, not a from-scratch render (G4e2); browser receivers'
text, including LA8 upload on WebGL and the MSDF shader (gate 7); text under `canvas_items`
stretch, where viewport oversampling follows the stretch scale (gate 6); several MSDF pages,
`msdf_size` 128, and the target game's own fonts (gate 8); live MSDF delivery beyond the shared /3
live path gates 1 and 2 already exercise; colour/emoji fonts, bitmap (`.fnt`) and `fixed_size`
fonts, left to gate 8's census of the target game; `TextEdit`/`LineEdit` carets, selection and IME
(gate 6); late-join adoption of atlases that exist before arming (gate 8); `RichTextLabel`
effects, tables, images and scrolling (gate 6's combined scene, if it uses them); atlas deltas and
hash-at-publish for versions superseded within a frame (gate 6, D9); and `clip_ignore`, underline
and strikethrough as supported commands (gate 5's own wire bump).

