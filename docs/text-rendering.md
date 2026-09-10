# Text rendering

The question this round exists to answer: **can we render crisp text at 14 px, rotated 10°,
translating every frame, inside a mobile browser's frame budget?** gsw renders text one way today —
rotated CSS boxes through the `html` package — and it is not good enough.

**Two scripts, measured separately.** A 12-glyph Han run in Noto Sans SC and an ASCII pangram in
Roboto, stacked in every cell and in every fidelity still, because they are different problems: Han
is full-width, unkerned and unligatured over thousands of outlines; Latin is proportional, kerned,
and an alphabet of ~95 glyphs. Every crispness number below is measured over one script's **band** —
the rows of the image that run occupies — against a reference cropped the same way. A Han
distortion and a Latin distortion are two different scales printed in the same units.

**The answer is yes, and the mechanism is `hb-gpu`** — HarfBuzz's Slug encoder, which stores each
glyph's outline as a texel blob and evaluates coverage in a fragment shader. On a moto g86 5G
(Mali-G615 MC2, DPR 3.4876) it is the cheapest arm in total CPU, **~9× the smallest in GPU storage**,
the best-aligned, and joint-cheapest per frame at one draw call. See [The phone](#the-phone) for the
run that decided it — including why per-frame cost stopped being the column that discriminates.

Getting there took two reversals, and both are the point of measuring rather than reasoning:

- **`hb-atlas` won the desktop and lost the phone.** Baking the rotation and four sub-pixel phases
  into an atlas and blitting 1:1 is the crispest thing measured on Han at every size (0.017 distortion
  at 14 px against `dom`'s 0.132), and it is still the crispness winner. But an atlas stores pixels,
  so it grew **7.9× per cell** at the phone's density while Slug's blobs grew **1.01×** — the same
  5.4 KiB a glyph on both rungs. Measured in one run per rung, hb-gpu goes from 14 % smaller on the
  desktop to **9.6× smaller** on the phone.
- **`canvas2d` looked like a free candidate and is the phone's most expensive arm.** Plain `fillText`
  is 0.99 ms and second-crispest on the desktop with no new code at all; on the phone it is 5.92 ms
  p50 with the main thread **96 % saturated**. A desktop has main-thread headroom to spare and a phone
  does not, so the desktop rung was flattering the one arm whose entire cost is main-thread CPU.

`hb-gpu`'s own reversal is the third: **at 14 px / DPR 1 it is an order of magnitude blurrier than
`hb-atlas`** (0.196 Han), and that blur has a single measured cause — HarfBuzz's shader takes a
five-tap MSAA branch below ppem 16. **A phone renders this text at ppem 49 and never enters it.** At
that scale hb-gpu measures 0.017 Han / 0.001 Latin: still behind `hb-atlas` on Han, and the crispest
arm on the page on Latin.

Every number here is measured on a named rung, and **no column may be read across rungs** — a
SwiftShader box, an RTX 2060 and a Mali-G615 are three different environments, and this document says
which one each table came from.

## The fuzz in the canvas package is bilinear sampling of a rotated quad

This round started from a complaint — text drawn through the `canvas` package looks fuzzy — so it is
worth naming the cause plainly rather than leaving it implicit in a table row further down.

**The `canvas` package had no text path.** There was no `fillText`, no font handling and no shaper
anywhere in `packages/canvas/src/`; it drew textured quads. So text that reached it was already a
**pre-rendered texture**, and drawing it was a textured quad like any other. It has one now — see
[The shipped path](#the-shipped-path) — and this section is why.

Both sampler setups in the package select bilinear filtering — [textures.ts:219-220](packages/canvas/src/textures.ts#L219-L220)
and [executor-webgl.ts:493-494](packages/canvas/src/executor-webgl.ts#L493-L494) each set `gl.LINEAR`
for `TEXTURE_MIN_FILTER` and `TEXTURE_MAG_FILTER`. Bilinear is invisible while the quad is axis-aligned
at 1:1, because every fragment centre lands on a texel centre and the four taps collapse to one. **Rotate
the quad by 10° and no fragment centre lands on a texel centre again**: every output pixel becomes a
weighted average of four texels, which is a low-pass filter applied to a glyph edge that is one or two
pixels wide to begin with. That is the fuzz. It is not a resolution problem and no atlas size fixes it —
the resampling happens after the atlas is read.

It is measured here twice, both times as an arm rather than as an assertion:

| arm                             | Han distortion | Latin | what it is                                                     |
| ------------------------------- | -------------- | ----- | -------------------------------------------------------------- |
| `hb-atlas` `bakeRotation=false` | 0.271          | 0.184 | upright atlas, rotated by the draw call — the conventional way |
| `hb-run`                        | 0.377          | 0.242 | whole run baked once, then rotated and translated              |
| _for scale:_ `godot-default`    | 0.242          | 0.184 | Godot's own FreeType atlas, no tricks                          |

The upright-atlas arm is **blurrier on Han than Godot's default**, and `hb-run` — the arm that resamples
most, because it rotates a whole baked run — is the blurriest arm in this document and carries 12–20×
every other arm's `edgeShimmer`. Those two rows are the complaint, reproduced under instrumentation.

**`hb-atlas`'s entire trick is making that `LINEAR` sample a no-op.** It bakes the rotation into the
pixels, snaps the destination to whole device pixels, and sets up design space to equal framebuffer
space (`createAtlasRenderer`, [text-hb.ts:568](packages/perf-harness/src/scenarios/text-hb.ts#L568)),
so every tap lands back on a texel centre and the blit is 1:1. Switching `bakeRotation` on is worth an
order of magnitude (0.271 → 0.017 Han) for 4.8× the atlas and 0.05 ms a frame.

**The corollary is the uncomfortable half.** `hb-atlas` and `hb-run` are the crispest arms _and_ the
most fragile ones: their crispness is conditional on the blit staying 1:1, so any scale, any zoom, any
non-integer destination re-introduces exactly the resampling they were built to avoid. `canvas2d`, `dom`
and `hb-gpu` are resolution-independent — they re-rasterize at whatever scale they are asked for. This
is why S9 **refuses** an over-subscribed layout instead of scaling the stage down to fit: scaling would
quietly convert the measurement of a baked arm into a measurement of bilinear filtering.

## The shipped path

The measurement closed with a verdict, so `hb-gpu` is no longer only an arm: `packages/canvas` now
has a `glyphs` draw command and a `GlyphPass` seam behind it, and the only implementation of that
seam is backed by `packages/hb-gpu`.

**It is one draw command in the same context, not an overlay canvas.** A glyph run interleaves with
quads in one draw list, so it gets real z-order, real clipping and the executor's own blending. The
executor flushes its pending batch under its own GL state, hands the run over, then re-binds its VAO
and program and invalidates its cached state — `emitGlyphsCommand`
([executor-webgl.ts](packages/canvas/src/executor-webgl.ts)) is where that order is written down,
and it is the module's own flush-before-state-change rule applied to a whole foreign program.

```ts
import {
  createCanvasExecutor,
  createDrawList,
  createGlyphsView,
} from "@godot-scene-web/canvas";
import { createHbGpuGlyphPass } from "@godot-scene-web/canvas/glyphs";

const glyphs = createHbGpuGlyphPass({
  gl: stage.gl,
  module, // the hb-gpu wasm, loaded from packages/hb-gpu/vendor/
  designWidth: 1920,
  designHeight: 1080,
  framebufferWidth: stage.projection().framebufferWidth,
  framebufferHeight: stage.projection().framebufferHeight,
});
if (!glyphs) return; // null, not a throw: fall back to the DOM text path

const executor = createCanvasExecutor({ gl: stage.gl, glyphs });
const face = glyphs.registerFace(fontBytes, "Noto Sans SC");

const run = createGlyphsView(text.length);
run.m.set([cos, sin, -sin, cos, x, y]); // rotation belongs HERE, never in the pen positions
run.pixelsPerEm = 14;
glyphs.fillRun(run, face, text, { script: "Hans", language: "zh-Hans" });
list.pushGlyphs(run);
```

Four things about that shape are load-bearing, and each has a failure mode that looks like working
text:

- **`glyphs` is optional on the executor**, injected the way `white` is, and the adapter is on the
  `@godot-scene-web/canvas/glyphs` subpath rather than the main barrel — a scene with no text loads
  no glyph renderer. A `glyphs` command with no pass installed is counted in
  `stats.glyphRunsDropped`, never silently dropped; the symptom of forgetting to inject one is a
  page that renders perfectly except for having no words on it.
- **`run.slots` holds atlas slot ids, not atlas offsets.** The atlas is a fixed texture over an
  unbounded glyph pool, so it evicts. A draw list is meant to be retained and repainted, so an
  offset baked into one can outlive its allocation and draw a _different glyph's outline, correctly
  sized, correctly placed, perfectly antialiased_. An id survives eviction because the pass
  re-resolves it, and re-uploads only on a miss.
- **Rotation goes in `run.m`, never into the pen positions.** `hb_gpu_dilate` computes its
  half-pixel dilation in screen space by pushing the corner _and its normal_ through that same
  matrix; a run rotated on the CPU behind its back is dilated along the wrong axes.
- **`run` colour is premultiplied** like every other view in the IR, and hb-gpu's fragment
  multiplies exactly once, so the adapter un-premultiplies on the way in. Getting this wrong is
  silent — the text is merely darker.

### This path wants ppem ≥ 16

The one constraint that has to travel with the API rather than live in a table further down.
`PPEM_FIDELITY_FLOOR` is 16, and `ppem` is `pixelsPerEm × the scale in run.m × devicePixelRatio` —
the size in **device** pixels, not CSS pixels. The middle factor is there because a caller's own
zoom, fit or hover scale rides the model matrix rather than `pixelsPerEm`: the shader sees that
scale (it derives ppem from `fwidth`), so the CPU-side gate has to see it too, or it reports a
comfortable size for text the shader is approximating. The pass reads it back out as the mean of
the two basis-vector lengths of `run.m`. Below it, HarfBuzz's coverage shader takes a five-tap approximation
([the measurement](#the-blur-is-the-ppem--16-branch-and-it-is-measured)) and this path is **blurrier
than the DOM text one it replaces**: 0.196 against 0.132 on Han at ppem 14. At ppem 49 — a phone
rendering 14 px at DPR 3.5, which is the case the round was run for — it is 0.017.

So 14 px at DPR 1 is the wrong tool, and a baked atlas or the DOM path is crisper there. The pass
warns once on the console below the floor and tallies every run in `stats.runsBelowPpemFloor`; it
draws the text either way, because a measurement saying another path would be crisper is not a
reason to render nothing.

**One HarfBuzz.** `fillRun` shapes through hb-gpu's own wasm, which exports the OpenType shaper as
well as the Slug encoder, so a consumer holds each face once instead of loading npm `harfbuzzjs` as
a second build with a second heap. The lower-level pieces are still there — `slotFor` and a
hand-built `GlyphsView` — for a caller that has already shaped elsewhere; `GLYPH_SLOT_NONE` is what
an inkless glyph answers, and it must be skipped rather than given a slot.

## Running it

**`hb-gpu`'s wasm is checked in**, at `packages/hb-gpu/vendor/` — a vendored third-party binary with
its digests, provenance and license texts beside it in `packages/hb-gpu/vendor/VENDOR.md`. Nothing
has to be built to sweep the arm. To reproduce it (docker + emscripten; byte-identical if nothing
was bumped):

```bash
bash packages/hb-gpu/build.sh     # prints: wasm 417263 bytes / sha256 bfca55c32e788d5b…
```

If the file is somehow absent the arm is **skipped and named** — the fidelity probe and a default
`perf` run both list it as NOT MEASURED with that command, and neither ever renders it as a zero. An
explicit `--mechanism hb-gpu` fails loudly instead.

```bash
# Crispness: 9 arms x 2 bands x 8 sub-pixel offsets, stills + metrics. Needs a display for Godot.
xvfb-run -a mise exec -- pnpm -w run text:fidelity

# Godot VRAM and draw calls, on the real GPU.
xvfb-run -a mise exec -- pnpm -w run godot:text-bench -- --all-variants

# Browser frame cost, raster and CPU. THE RUNG DECIDES THE ANSWER HERE — see below.
mise exec -- pnpm -w run perf -- --scenario text-render                        # SwiftShader
xvfb-run -a mise exec -- pnpm -w run perf -- --scenario text-render \
  --headed --env linux-chrome-nvidia                                          # real GPU

# Assemble whatever of the above exists into one browsable directory.
mise exec -- pnpm -w run text:report
xdg-open artifacts/perf/text-report/index.html
```

The baked arms' isolations take the same parameter name on both instruments:

```bash
xvfb-run -a mise exec -- pnpm -w run perf -- --scenario text-render --mechanism hb-atlas \
  --headed --env linux-chrome-nvidia --param bakeShaper=fillText
xvfb-run -a mise exec -- pnpm -w run text:fidelity -- --no-godot --bake-shaper fillText
```

So does the script axis, which is new this round:

```bash
mise exec -- pnpm -w run perf -- --scenario text-render --param script=han     # Han alone
mise exec -- pnpm -w run text:fidelity -- --no-godot --script latin            # Latin alone
```

The probe additionally takes `--font-size`, which is what the `bakeShaper` sweep below is made of —
one run per size per shaper, into its own `--out` so nothing overwrites the comparison run:

```bash
mise exec -- pnpm -w run text:fidelity -- --no-godot --font-size 12 \
  --bake-shaper fillText --out artifacts/perf/probes/sweep/12-fillText
```

**The phone needs a `labels` count that fits its own viewport, and you do not have to guess it.** S9's
stage IS the viewport — that is what keeps the glyph raster scale at the real device pixel ratio — so it
**refuses** an over-subscribed layout rather than overlapping the cells or scaling the stage, and the
refusal names the largest `labels` that fits. The run also prints the viewport it measured before it
mounts. So: start from the numbers below, and if it refuses, re-run with the count the message gives.

```bash
mise exec -- pnpm -w run perf -- --scenario text-render --env device \
  --param labels=4 --baseline device-text-render
mise exec -- pnpm -w run perf -- --scenario text-render --env device \
  --param script=han --param labels=8 --baseline device-text-render-han
```

Those two counts are **this device in portrait**, not a constant: a moto g86 5G reports a 790x1484
window at dpr 3.4876, which is a 349x657 layout viewport; a `both` cell is 283.0x143.1 CSS px and a
`han` cell 194.7x73.8, so capacity is `floor(349/283) x floor(657/143.1)` = **4** and
`1 x 8` = **8**. **Orientation changes the answer** — the same phone in landscape is a 703x281
viewport and holds **2** and **9**. Auto-picking `labels` was rejected deliberately: it would silently
change the workload between two runs that are meant to be compared.

`text:report` is a **pure reader**. It launches no browser and drives no Godot; running it twice
cannot change a result. Anything it could not find is listed at the top of the page with the
command that produces it, never rendered as zeros.

## The viewer

`artifacts/perf/text-report/` is one movable directory: `index.html`, `data.json`, and every still
copied in as a sibling PNG. The data is inlined into the HTML rather than fetched, because a
`file://` page cannot fetch its own siblings. Three views share state through the URL hash
(`#view=flip&arm=dom&offset=3&zoom=8`), so a particular comparison can be linked.

| view     | what it is for                                                                                       |
| -------- | ---------------------------------------------------------------------------------------------------- |
| **grid** | every arm side by side at the same zoom, with its headline numbers and the three metric tables below |
| **flip** | one arm at a time in a fixed box — the in-place A/B                                                  |
| **diff** | `\|arm − reference\|` at the same offset, amplified live                                             |

Every image is `image-rendering: pixelated` at an integer zoom (1–16×, default 4×), so what is on
screen are the actual pixels. **The zoom is in DEVICE pixels, and that took a fix.** A CSS size does
not control device pixels: at a `devicePixelRatio` of 1.25 the viewer used to size images by zoom
alone and drew each source pixel 1.25, 2.5, 5, 10 and 20 device px wide at its five zoom levels. The
two fractional ones are the damaging case — `pixelated` can only render them by making some source
pixels one device px wide and their neighbours two, which lays an uneven blocking over every arm in
the one tool built to tell nearly-identical rasterisations apart. The CSS size is now divided by the
ratio, so a zoom of _n_ is _n_ device pixels on every display; verified in Chrome at dpr 1.25, where
all five levels now measure exactly 1/2/4/8/16. The image is physically smaller at a fractional
ratio than it used to be — 0.8× at 1.25 — and the zoom label names the ratio so that reads as the
correction it is rather than as a bug. Flip and diff carry the selected arm's own numbers in a panel beside
the image — the same pre-formatted cells the grid tables render, so the panel cannot disagree with
them. That panel exists because the views that show one arm at a time show no table, which is
exactly how the anchoring bug below went unnoticed for a round.

Three implementation details are load-bearing rather than incidental:

- **The flip view stacks the arms and toggles opacity.** Swapping `img.src` tears down the old
  frame before the new one is decoded, and that blink is exactly what destroys an A/B comparison of
  two nearly-identical images. Nothing is added, removed or re-decoded when you change arms.
- **The offset axis _is_ a `src` swap**, because 6 arms × 8 offsets stacked at 16× would be ~700 MB
  of rasterised layers. It is safe only because a hidden pool paints every still at 1:1, so the
  bytes are already decoded and the swap is synchronous. The pool is not a caching nicety; it is
  what lets the cheap structure behave like the expensive one.
- **The diff is generated per offset against the reference _at that offset_.** A moved arm
  differenced against a still reference draws the translation, not the rasterizer. The control that
  proves the alignment: `diff-reference-*.png` is **exactly zero at all eight offsets** — max and
  mean both 0 — so the subtraction itself is not introducing a difference.

Press `space` in the flip view to cycle the offsets. `edgeShimmer` says the crawl is there; this is
how you see it.

## Every metric reads one channel, and that channel is green

`dom` is the only arm Chrome draws with **LCD subpixel antialiasing**, and that is a property of the
shipped mechanism rather than of the instrument. Counted on the stills: `dom-0.png` has 2980 pixels
whose channels spread by more than 8 (worst 143, e.g. `rgba(75,157,218)`); `canvas2d-0.png`,
`hb-atlas-0.png`, `reference-0.png` and all three `godot-*` stills have **0**, worst spread 4. Alpha
is a uniform 255 throughout, so this is the rasterizer's own output and not a compositing artefact.
`fillText`, the WebGL blit and Godot's rasterizer all emit grayscale coverage; real DOM text on an
opaque background does not.

**Averaging R, G and B on a subpixel-AA still is a ~1 px horizontal box blur**, because the three
channels sample the glyph a third of a pixel apart. The probe used to do exactly that
(`sharp().greyscale()`), to the one arm that could feel it, and the blur landed in the column that
grades the _mechanism_. Measured, over the same eight offsets:

| band  | `dom` distortion on luma | on green  |
| ----- | ------------------------ | --------- |
| han   | 0.171                    | **0.132** |
| latin | 0.162                    | **0.121** |

So ~0.04 of a ~0.17 reading — a quarter of it — was the measurement's own channel averaging rather
than blur the mechanism produced. **Green samples coverage at the pixel centre**, which is the same
question asked of every arm, and on the seven greyscale arms it is bit-identical to the old luma
(verified over all 256 neutral values, 0 mismatches), so nothing else in this document moved. No
ordering changes; `dom` remains eight times `hb-atlas`'s distortion instead of ten.

**Rejected: disabling subpixel AA on the probe page** (`-webkit-font-smoothing: antialiased`). It
would make all eight arms greyscale and the choice of channel moot — and it would grade a `dom` arm
that gsw does not ship. Measuring the shipped CSS-box path is the entire point of that arm. The
mechanism keeps its antialiasing; the metric stops averaging across it.

It also changes what the alignment guard allows, since the allowance is `0.25 + 0.65 × distortion`:
`dom`'s shrank from 0.361 to 0.336 (Han) while its reading fell from 0.314 px to 0.300, so it still
clears — by a thinner margin, honestly measured. `test/text-fidelity.test.ts` pins the channel with
a one-pixel stem whose fringes give an ideal acutance of 2.000 on green against 1.114 on a luma.

## What the metrics mean

Measured by `packages/perf-harness/probes/text-fidelity.ts` over 8 sub-pixel translations of a
12-glyph Han run above an ASCII pangram, both at 14 px / 10°, **once per band**.

A **band** is the rows of the still one run occupies, plus half the gap between the runs. The two
bands are disjoint by construction (the boundary is one rounded value shared by both), so no pixel
of Han ink reaches a Latin number or the reverse. One acutance over both scripts would be a
property no rasterizer has: it would move whenever the mix moved, so an arm that improved on Latin
and regressed on Han would read as unchanged.

- **acutance** — mean `|∇green|` per unit ink. **Not higher-is-better.** The `reference` arm is the
  same geometry drawn at 8× and box-downsampled in node, i.e. correct area coverage for this exact
  run, so it is a _ceiling_, not a mechanism anyone could ship.
- **distortion** — `|1 − acutance/reference|`, and the column to read. Below the reference is blur,
  above it is harder-than-correct edges, i.e. aliasing. Only the distance says how wrong. Derived
  in the reader; it is not stored in the JSON.
- **edgeShimmer** — coefficient of variation of acutance across the offsets: does the edge
  structure hold still while the text moves. This is the crawl metric, and **it is deliberately not
  ranked** — see below.
- **inkShimmer** — CV of _total ink_. Near zero for any exact-area rasterizer whether it crawls or
  not, because translating a shape does not change its area. Reported, but the weaker signal.
- **subpixelTravel / subpixelResidualPx** — slope and RMS residual of the measured ink centroid
  against the requested offset. **Read these before the shimmer columns.** The slope alone cannot
  tell sub-pixel motion from whole-pixel snapping, because a snapping arm still tracks the request
  on average; the residual can. ~0.29 px is the signature of rounding to whole pixels.
- **alignment px** — how far the arm must be **moved** to land on the reference, found by
  correlating the two stills. **A licence, not a score**, and the row to read before the two below
  it. Every arm anchors its alphabetic baseline at the same y inside the run box, so a large value
  means an arm is not drawing where it was asked — and then `rmsVsReference` and the diff view are
  measuring that displacement instead of the rasterizer. Past its allowance the probe prints a loud
  warning, the table marks the arm's RMS cell `⚠`, and the viewer says so beside the diff.
- **rmsVsReference** — reported last and hedged. It ranks hinting policy, not crispness. It is
  `null` for the Godot arms on purpose, and the viewer renders that as `—`: a different rasterizer
  disagrees about stem darkening long before it disagrees about blur, so a number there would score
  the wrong thing.

### Why edgeShimmer has no winner

Low `edgeShimmer` has three causes and only one of them is merit:

1. edges that genuinely hold still while the glyph moves;
2. an arm that **snapped** translation to whole pixels — it cannot shimmer because it cannot move
   (`dom` reads exactly `0.00000`, with a 0.270 px residual);
3. an arm too **blurry** to have edge structure to disturb (`godot-default`, at distortion 0.243,
   scores 0.00191 against `canvas2d`'s 0.00672).

Highlighting a winner there would recommend the arm this round exists to replace. The row is read
next to `distortion` and `subpixelResidualPx`, or not at all. `phases=1` makes the point sharpest:
it has the lowest `edgeShimmer` on the page (0.00033) because it cannot move sub-pixel at all.

## Every arm anchors the same baseline

The probe draws each arm with its alphabetic baseline exactly `fontSize` px below the run box's top
edge. This is a normalisation, not a rendering choice: the probe measures **rasterization**, and
left to their own conventions the three engines put the same run in three different places.

- canvas `textBaseline: "top"` pins the em top;
- a CSS line box puts the baseline at `half-leading + ascent`;
- Godot's `Label` uses its own ascent.

**None of that can be derived from the font, and it is now a different number per face.** The Han
fixture's tables disagree by 45 % — `hhea` 1160/−288 against `OS/2` typo 880/−120 at 1000 upem, with
`USE_TYPO_METRICS` unset — and they predict half-leadings of opposite sign; Roboto's answer is a
third number again. So each arm is _asked_ where its baseline is, **once per face**: the browser arms
via a zero-height `inline-block` with `vertical-align: baseline` (which sits exactly on the line
box's baseline) measured on an **unrotated** element, and Godot via its own `font.get_ascent()`
reproduced from `label.cpp`, taking the run's own `FontFile`. S9 measures the shipped DOM's answer
and publishes both: `baselinePx: 16` for Noto Sans SC, `baselineLatinPx: 13` for Roboto, at
`fontSize` 14. One shared number would have put one of the two runs 3 px out.

Both faces share one run-box height (`fontSize × 1.35`) and one baseline rule, which is checkable
rather than lucky: Roboto's descender is 0.244 em against the 0.35 em the box leaves below the
baseline. `test/latin-fixture.test.ts` asserts it against the real subset file.

Four bugs this has now caught, every one of which had been quietly corrupting per-pixel numbers:

1. **The `dom` arm drew 2.35 px low**, because it was the only arm anchored by CSS half-leading.
2. **Godot rotated about the wrong pivot**, putting every glyph 4.20 px too high at 10°.
   `Control.set_size` **clamps to the combined minimum size**, and `Label`'s minimum is its own
   measurement of the text: a 144×16.2 run box came back as 192×23. Reading `pivot_offset` back off
   `label.size` therefore rotated about a point 24 px to the right of the browser's. It was
   invisible at rotation 0, invisible in the fitted slope (10.07° against the reference's 9.89°),
   and it partly cancelled bug 1 — which is why the totals looked plausible.

3. **`hb-run` sat 0.71 px out** because its cell was baked at the centre of its single sub-pixel
   phase (+0.5, +0.5 device px) and then drawn at a fractional position, so the baked offset was
   _added_ to the true position instead of standing in for it. Phases only make sense for a draw
   that snaps to whole device pixels; an unsnapped draw must bake at offset zero.
   `BakeOptions.snapped` now says which, explicitly.
4. **Every arm read 0.51 px out, in both bands, for one round of this document's life** — because
   stacking two runs put their rest positions on half-pixels where the single-run layout had put
   them on whole ones, and the `dom` arm snaps its text origin to whole device pixels. The guard
   flagged it; the fix is that `probeLayout` rounds each run box's origin. The sweep is where
   sub-pixel phases belong, not the rest position.

### Measuring alignment: correlation, not centroids

`alignment px` is the guard, and getting the guard itself right took two attempts.

**It is not a centroid difference.** A centroid moves when an arm is displaced, but it also moves
when the arm merely _redistributes_ ink — and every arm redistributes ink relative to an 8×
reference whose per-glyph advances round differently. Measured on aligned arms: `canvas2d`'s
centroid sits 0.399 px from the reference's while its correlation peak is at 0.051 px, and `hb-run`
— which resamples a whole run bilinearly — reads 0.543 px by centroid and 0.399 px by correlation.
A guard that cannot tell a blurrier arm from a displaced one would have accused every candidate
mechanism this round exists to evaluate.

**Nor is it a parabola through the correlation peak's integer neighbours.** That is the textbook
sub-pixel refinement and it peak-locks: exact at 0, 0.5, 1.0 and 1.5 px, and 0.135 px wrong at the
quarters. What works is sampling the reference _between_ texels and scanning, with the correlation
normalised — otherwise the estimator notices that fractional sampling blurs slightly and locks
straight back onto the integers.

Calibrated on ground truth that shares no interpolation model with the estimator — the probe's
eight reference stills are independent 8× renders at known offsets, giving 56 ordered pairs with a
known answer. Re-run at 14 px, per band: **Han mean |error| 0.056 px, worst 0.106; Latin 0.017 /
0.036.** The Han band is the noisier of the two, which is what a denser script should be.

The allowance is `0.25 px + 0.65 × distortion`, and both terms are measured. 0.25 is more than twice
the worst-case noise. The second term corrects the estimator's one known bias: normalised
correlation slightly prefers the smoothing that fractional sampling introduces, so an arm blurrier
than the reference reads a small spurious offset. Re-measured at 14 px by softening a band of a
reference still with a separable gaussian:

| distortion | spurious offset | ratio |
| ---------- | --------------- | ----- |
| 0.228      | 0.170 px        | 0.74  |
| 0.311      | 0.212 px        | 0.68  |
| 0.440      | 0.347 px        | 0.79  |
| 0.571      | 0.431 px        | 0.76  |
| 0.728      | 0.580 px        | 0.80  |

The ratio rises with the distortion, so one slope has to be picked for the range the arms occupy
(0.015–0.40). **0.65 is deliberately the low end of it**: this is an allowance, and an over-generous
one silences the guard on exactly the soft arms it is watching. Arms _sharper_ than the reference
get none at all, because the bias does not apply to them.

**What it flags today: the three Godot arms and nothing else** — `godot-msdf` at 0.634 px (Han) and
0.430 (Latin), `godot-default` at 0.513 (Latin), `godot-oversample` at 0.306 (Latin). MSDF's Han
distortion is 0.030, so essentially none of its 0.634 px is blur bias: Godot's MSDF path really does
draw more than half a pixel from where the reference draws. Every browser arm clears its allowance
in both bands, which is the check a baked atlas holding two faces most needed to pass.

## Measured so far

### Crispness — all eight arms, both bands, same geometry, same eight offsets

**Han band** — 12 glyphs of Noto Sans SC at 14 px.

| arm                 | distortion | edgeShimmer | travel | resid px  | align px  | allowed | rms vs ref |
| ------------------- | ---------- | ----------- | ------ | --------- | --------- | ------- | ---------- |
| reference (ceiling) | 0.000      | 0.01015     | 1.001  | 0.004     | 0.000     | 0.250   | 0.00       |
| **hb-atlas**        | **0.017**  | 0.00280     | 0.996  | **0.030** | 0.052     | 0.261   | 6.46       |
| godot-msdf          | 0.030      | 0.00075     | 1.052  | 0.169     | **0.633** | 0.270   | —          |
| **canvas2d**        | 0.032      | 0.00671     | 0.996  | 0.044     | 0.051     | 0.271   | 6.19       |
| **dom** (today)     | 0.132      | 0.00000     | 0.944  | **0.270** | 0.300     | 0.336   | 9.61       |
| godot-oversample    | 0.184      | 0.00754     | 0.956  | 0.171     | 0.000     | 0.369   | —          |
| godot-default       | 0.242      | 0.00210     | 1.001  | 0.012     | 0.269     | 0.407   | —          |
| **hb-run**          | 0.377      | **0.11875** | 0.992  | 0.021     | 0.399     | 0.495   | 11.12      |

**Latin band** — the pangram in Roboto at 14 px.

| arm                 | distortion | edgeShimmer | travel | resid px  | align px  | allowed | rms vs ref |
| ------------------- | ---------- | ----------- | ------ | --------- | --------- | ------- | ---------- |
| reference (ceiling) | 0.000      | 0.00426     | 1.001  | 0.004     | 0.000     | 0.250   | 0.00       |
| **hb-atlas**        | **0.015**  | 0.00172     | 1.004  | **0.023** | 0.033     | 0.260   | 8.60       |
| **canvas2d**        | 0.034      | 0.00410     | 1.000  | 0.019     | 0.043     | 0.272   | 5.26       |
| godot-oversample    | 0.050      | 0.00617     | 0.977  | 0.074     | **0.306** | 0.282   | —          |
| godot-msdf          | 0.085      | 0.00323     | 0.989  | 0.059     | **0.430** | 0.305   | —          |
| **dom** (today)     | 0.121      | 0.00000     | 0.944  | **0.270** | 0.286     | 0.329   | 12.73      |
| godot-default       | 0.184      | 0.00216     | 0.996  | 0.009     | **0.512** | 0.369   | —          |
| **hb-run**          | 0.242      | **0.09193** | 1.005  | 0.017     | 0.249     | 0.407   | 11.50      |

Six readings, and the two bands agree on every one of them:

- **`hb-atlas` is now the crispest shippable arm on both scripts** — 0.017 Han / 0.015 Latin, ahead
  of `canvas2d`'s 0.032 / 0.034 and roughly **eight times** ahead of what gsw ships. It also moves
  genuinely sub-pixel (residual 0.030 / 0.023).
- **`dom`'s zero shimmer is a diagnosis, not a win.** Its 0.270 px residual ≈ the 0.289 px expected
  from rounding a uniform phase sweep to whole pixels, identically in both bands. It holds still
  because it does not move.
- **Godot's default output is the blurriest arm that is not `hb-run`.** Godot is not the crispness
  bar; the 8× reference is.
- **`hb-run` crawls, and the number says so.** Its `edgeShimmer` of 0.119 / 0.092 is an order of
  magnitude above every other arm and 12–20× the reference floor. That is the measured price of
  freezing a whole run to one texture and translating it: every frame is a different bilinear
  resample of the same bitmap. It is also the arm whose distortion moved most between rounds (0.21 →
  0.38 for a change in the run's REST position alone), which is the same fact stated twice.
- **Latin is the easier case for every arm.** Its reference acutance is 1.78 against Han's 1.97 —
  fewer strokes per em, so less edge structure to get wrong — and every arm's distortion is equal or
  lower there except `godot-msdf`'s.
- **The alignment guard flags three Godot arms and no browser arm.** `godot-msdf` at 0.634 px in the
  Han band buys almost no blur allowance (distortion 0.030), so that is displacement and nothing
  else; it was 0.517 px at 12 px last round, so the finding is stable rather than new.

The reference's own `edgeShimmer` is 0.01015 (Han) / 0.00426 (Latin), which is the floor an ideal
rasterizer shimmers at — so `hb-atlas`'s 0.00271 / 0.00173 is BELOW that floor, which is what
snapping a pre-rasterized bitmap to whole pixels buys and what its 4 phases cost in position
accuracy.

### The baked arms, and what each knob buys

`hb-atlas` and `hb-run` both shape once and rasterize once. They differ in _what_ is baked, and
three parameters isolate the rest. Every row below is one `--param` away from the one above it, on
identical geometry. Distortion is quoted **Han / Latin**.

**`bakeRotation` — baking the rotation into the pixels is the whole trick.**

| `hb-atlas`           | distortion        | edgeShimmer | atlas    | cells | frame ms |
| -------------------- | ----------------- | ----------- | -------- | ----- | -------- |
| `bakeRotation=true`  | **0.017 / 0.015** | 0.00271     | 1.45 MiB | 1040  | 0.72     |
| `bakeRotation=false` | 0.271 / 0.184     | 0.00089     | 0.30 MiB | 260   | 0.67     |

The upright atlas rotated by the draw call — the conventional implementation — is **blurrier than
Godot's default arm on Han** (0.271 against 0.243). Every fragment is a bilinear tap through a
rotated quad, and no amount of atlas resolution fixes that. Baking the rotation is what lets the
blit be 1:1 texel-to-pixel, and 1:1 is what buys the crispness. It costs 4.8× the VRAM, because the
phases only make sense once the destination snaps, and 0.05 ms a frame.

**`bakeShaper` — HarfBuzz earns its 420 KB, but in the ALIGNMENT column, not the acutance one.**

| `hb-atlas`            | distortion    | resid px | align px | atlas    | shape ms | bake ms | wasm heap |
| --------------------- | ------------- | -------- | -------- | -------- | -------- | ------- | --------- |
| `bakeShaper=harfbuzz` | 0.017 / 0.015 | 0.030    | 0.052    | 1.45 MiB | 9.5      | 17.0    | 2.50 MiB  |
| `bakeShaper=fillText` | 0.030 / 0.034 | 0.028    | 0.076    | 1.62 MiB | **4.1**  | **9.7** | **0**     |

Those two rows are one font size, and for a round of this document's life they were read as a size
effect: `fillText` reached distortion 0.000 at 12 px, lost at 14 px, and the conclusion recorded here
was "at 14 px HarfBuzz outlines bake better than Skia glyphs". **Swept across five sizes, that is not
what is happening.** Signed acutance error against each size's own 8× reference — the sign matters,
and `distortion` is its absolute value:

| px  | Han harfbuzz | Han fillText | Latin harfbuzz | Latin fillText |
| --- | ------------ | ------------ | -------------- | -------------- |
| 11  | +1.48 %      | −2.49 %      | +1.14 %        | −4.05 %        |
| 12  | +4.88 %      | **+0.01 %**  | +1.79 %        | −3.49 %        |
| 13  | +3.27 %      | −1.38 %      | +1.44 %        | −3.36 %        |
| 14  | +1.74 %      | −2.96 %      | +1.54 %        | −3.44 %        |
| 16  | +2.20 %      | −2.69 %      | +1.32 %        | −3.46 %        |

**The two shapers sit on opposite sides of the reference at every size.** HarfBuzz outlines through
`Path2D` bake consistently over-sharp; Skia's hinted glyph raster bakes consistently soft. So which
one "wins on distortion" flips whenever `fillText`'s magnitude happens to dip below HarfBuzz's, and
that is arithmetic about two signs, not a quality trend. **The famous 0.000 at 12 px was a zero
crossing** — `fillText`'s signed error passes through zero between 11 px and 13 px and is negative on
both sides of it. Nothing was reference-grade; a sign changed.

The column that does hold still is **alignment**, and it separates the two scripts exactly as the
premise predicted:

| px  | Han harfbuzz | Han fillText | Latin harfbuzz | Latin fillText |
| --- | ------------ | ------------ | -------------- | -------------- |
| 11  | 0.088 px     | 0.097 px     | 0.048 px       | **0.152 px**   |
| 12  | 0.060        | 0.086        | 0.042          | **0.169**      |
| 13  | 0.061        | 0.078        | 0.038          | **0.167**      |
| 14  | 0.052        | 0.076        | 0.033          | **0.170**      |
| 16  | 0.068        | 0.091        | 0.063          | **0.201**      |

**On Han the gap is 0.01–0.03 px; on Latin it is 0.10–0.14 px, at every size measured.** That is the
kerning signature and nothing else: Han is full-width, unkerned and unligatured, so a per-codepoint
`measureText` walk reproduces the shaped pen positions and the two arms land on top of each other.
Latin kerns, and the walk cannot see it. `rmsVsReference` says the same thing twice as loudly — Latin
8.6–8.9 shaped against 11.8–12.9 unshaped, at every size, while Han is 6.5–7.5 against 7.6–8.2.

So the isolation the Latin run was added for **did go the way it was supposed to**; it was being read
in the wrong column. The honest summary:

- **Baking is what buys the crispness**, on both scripts — that is the `bakeRotation` row above, and
  it is worth an order of magnitude.
- **Shaping buys POSITION, and only where the script kerns.** ~0.13 px and ~4 RMS on Latin at every
  size; ~0.02 px on Han.
- `fillText` still halves shape+bake time and removes two wasm heaps. For a Han-only workload that is
  close to free. For anything Latin it costs an eighth of a pixel on every run, permanently.

Two caveats on the sweep. It is `--no-godot`, and both arms are greyscale, so the channel change
above does not touch these numbers. And 16 px only became measurable after `atlasPageSideFor` was
taught to size a page to its largest single cell — `hb-run` bakes a whole run into one cell, its
16 px Latin pangram is 265×65 device px, and an area-derived 256 page made `packShelves` refuse the
bake. That failure mode scales with the device pixel ratio, which is the direction a phone run moves.

**`phases` — position accuracy against VRAM, with a twist.**

| `hb-atlas` | distortion    | edgeShimmer | align px  | atlas    | cells |
| ---------- | ------------- | ----------- | --------- | -------- | ----- |
| `phases=1` | 0.009 / 0.021 | **0.00033** | 0.175     | 0.38 MiB | 260   |
| `phases=4` | 0.017 / 0.015 | 0.00271     | 0.052     | 1.45 MiB | 1040  |
| `phases=9` | 0.019 / 0.014 | 0.00863     | **0.029** | 3.23 MiB | 2340  |

More phases means better POSITIONING — alignment falls 0.175 → 0.052 → 0.029 px, monotonically, for
linearly more VRAM — and **not** monotonically less distortion or less shimmer. `phases=1` has the
lowest `edgeShimmer` and (on Han) the lowest distortion on the page precisely because every glyph is
pixel-identical wherever it lands: it cannot shimmer because it cannot move sub-pixel, and it cannot
be softened by a phase it was not baked at. That is cause (2) from the list above, and it is why
`edgeShimmer` has no winner. What `phases` actually buys is the alignment column.

**`script` — what the second run costs.**

| `hb-atlas`     | runs/frame | glyphs/frame | distinct glyphs | atlas    | cells | wasm heap | frame ms |
| -------------- | ---------- | ------------ | --------------- | -------- | ----- | --------- | -------- |
| `script=han`   | 20         | 240          | 221             | 1.36 MiB | 884   | 1.00 MiB  | 0.54     |
| `script=latin` | 20         | 800          | 39              | 0.12 MiB | 156   | 0.25 MiB  | 0.60     |
| `script=both`  | 40         | 1040         | 260             | 1.45 MiB | 1040  | 2.50 MiB  | 0.72     |

Latin is 3.3× the glyphs per frame for **11× less atlas**, which is the whole shape of the
difference: an alphabet is 39 distinct outlines and a Han pool is 221, and the atlas pays for
distinct outlines while the frame pays for glyphs drawn. Both together cost 0.72 ms against 0.54 for
Han alone — sub-linear, because the per-frame cost is one draw call either way.

### Godot — RTX 2060, Vulkan, forward+

Text cost is the delta over an identical empty scene. 40 Labels (20 cells x 2 scripts), two
`FontFile`s.

| variant    | text texture            | draw calls | notes                                              |
| ---------- | ----------------------- | ---------- | -------------------------------------------------- |
| default    | 393 984 B (0.38 MiB)    | 50         | FreeType into a shelf-packed grayscale atlas       |
| msdf       | 33 554 944 B (32.0 MiB) | 97         | `msdf_size` 128, pixel range 14 — **85× the VRAM** |
| oversample | 655 872 B (0.63 MiB)    | 69         | viewport oversampling override 2×                  |

Godot's MSDF is its crispest variant on Han (distortion 0.030) and costs 85× the atlas memory at its
own default `msdf_size` — and it is the arm the alignment guard flags hardest, at 0.63 px.

Do **not** read Godot's `frameMs` from this rung: under Xvfb the present is a software blit of the
whole surface, which puts a ~29 ms floor under every variant identically. Read texture memory and
draw calls. `poolVideoMemBytes` is the VMA pool total, quantised to ~34 MiB blocks — it once made
msdf and oversample look identically expensive when they differ by 64×, and it is reported only as
a labelled non-cost.

### Browser — 1280×800, 20 cells × 2 runs, and why the rung decides the answer

Two runs of the same four arms on the same scene, differing only in whether Chrome had a GPU.

**headless, SwiftShader** (`linux-chrome-148`)

| arm      | frameCostMs p50 | rasterMs | mainThreadBusyMs | cpu.totalCpuMs |
| -------- | --------------- | -------- | ---------------- | -------------- |
| dom      | 0.83            | **3151** | 129              | 1669           |
| canvas2d | 1.63            | 0        | 306              | **628**        |
| hb-atlas | 10.10           | 0        | 1574             | 1165           |
| hb-run   | 9.54            | 0        | 1505             | 1119           |

**headed under Xvfb, NVIDIA RTX 2060 through ANGLE** (`linux-chrome-nvidia`)

| arm          | frameCostMs p50 | rasterMs | mainThreadBusyMs | cpu.totalCpuMs | draw calls | quads/frame |
| ------------ | --------------- | -------- | ---------------- | -------------- | ---------- | ----------- |
| dom          | 0.77            | **348**  | 158              | 1082           | —          | —           |
| canvas2d     | 0.90            | 0        | 242              | 673            | —          | —           |
| **hb-atlas** | 0.72            | 0        | 146              | 558            | **1**      | 1040        |
| **hb-run**   | **0.43**        | 0        | **89**           | **474**        | **1**      | 40          |

**The ordering reverses, and the gap is wider than it was at 12 px.** On SwiftShader the baked arms
look 6× worse than `canvas2d`; on a real GPU they are the two cheapest things on the page, at 44–56 %
of `dom`'s CPU and with `dom`'s 348 ms of raster replaced by nothing. Same code, same scene, same
frame count. Under SwiftShader a WebGL2 draw is _software rasterized on the CPU_, so an arm whose
entire strategy is "move the work to the GPU" is measured with the GPU removed. This is the
harness's own rule — no column may be compared across rungs — biting on the exact question the round
exists to answer, and it is why the default headless run must not be quoted for these arms.

`dom` looks cheap per frame on both rungs precisely because its cost is not on the main thread.
`canvas2d`'s zero raster is not a bug: the canvas is composited, so its cost lands in the GPU
process instead. Note that `canvas2d` is now the most expensive arm per frame on the GPU rung — it
makes 7520 `fillText` calls in a 3 s window, and tripling the glyphs per frame is what moved it past
`dom`.

Startup cost, paid once before the measured window and reported so it is not invisible: `hb-atlas`
shapes 40 runs in 9.5 ms and bakes 1040 glyph variants in 17.0 ms; `hb-run` bakes 40 whole runs in
13.0 ms. Both carry **two** 1.25 MiB wasm heaps (one per face), which `bakeShaper=fillText` removes
entirely.

VRAM, self-counted from the texture cache: `hb-atlas` 1.45 MiB on one 1024² page at 87 % occupancy,
`hb-run` 2.27 MiB on one 1024² page at 80 %. Against Godot's MSDF at 32.0 MiB that is **22× less
atlas**, at a distortion of 0.017 against MSDF's 0.030. These are the arms' own counters rather than
driver-attributed VRAM; the driver's own per-process figure is the ΔVRAM column below, from
`nvidia-smi -q -x` on the GPU process this run launched. Note the reversal against the 12 px round:
`hb-run`'s per-run textures now cost MORE than `hb-atlas`'s glyph atlas, because a 258 px Latin
pangram baked whole is a large texture and there are 20 distinct ones.

All four arms report `baselinePx: 16` / `baselineLatinPx: 13` and presence **40/40**: S9 measures the
**shipped** DOM's baseline once at mount, per face, and hands it to every other arm, so they draw in
the same place while the dom arm stays exactly what gsw ships. Both numbers are published on all of
them because agreement there is the only thing in the table that would catch them drifting apart
again — and 40/40 rather than 20/20 is what proves the Latin run reached the screen at all.

## hb-gpu, measured

The Slug algorithm compiled to wasm (`packages/hb-gpu`, HarfBuzz 14.4.0, a 227 KB binary): each
glyph's **outline** is encoded once into a banded RGBA16I texel blob and a fragment shader evaluates
coverage from it every frame. No atlas resolution, no phase grid, no baked rotation — so nothing it
holds grows with the device pixel ratio. When these numbers were taken it shaped with the same npm
`harfbuzzjs` the baked arms use; it reuses their `glyphLocal` either way, so its placement is
arithmetically identical to `hb-atlas`'s (`test/text-gpu.test.ts` proves that without a browser).

> **Neither the binary nor the shaping in this section is what the repo does any more.** Every
> number below was measured against the 227 KB encoder-only build, shaping with npm `harfbuzzjs`.
> After the round closed, `hb_shape` and the `hb_buffer_*` API were added to `hb-gpu.symbols`, which
> pulled the OpenType shaper back in and took the wasm to **417 KB**; the arm was then rewired to
> shape through `HbGpuFont.shape`, so it now holds ONE HarfBuzz and one copy of each face. Nothing
> about the outlines, the atlas or the shader changed, so the crispness, storage and frame-cost
> columns still describe the mechanism. The **wasm heap** row has been re-measured and is marked
> where it appears; **startup** has not been, for a reason worth stating — see
> [After the swap](#after-the-swap-one-harfbuzz-measured).

**It clears the alignment guard in both bands**, which is what licenses the columns below:
0.156 px against an allowance of 0.377 (Han) and 0.092 against 0.318 (Latin).

**Crispness — same eight offsets, same geometry, beside the arms it is competing with.**

| arm          | band  | distortion | edgeShimmer | resid px | align px | allowed | rms vs ref |
| ------------ | ----- | ---------- | ----------- | -------- | -------- | ------- | ---------- |
| **hb-atlas** | han   | **0.017**  | 0.00280     | 0.030    | 0.052    | 0.250   | 6.46       |
| **hb-gpu**   | han   | **0.196**  | 0.00758     | 0.029    | 0.156    | 0.377   | **5.77**   |
| **hb-atlas** | latin | **0.015**  | 0.00172     | 0.023    | 0.033    | 0.250   | 8.60       |
| **hb-gpu**   | latin | **0.104**  | 0.00375     | 0.099    | 0.092    | 0.318   | **5.65**   |

**The headline is that hb-gpu is BLURRIER, and by a lot** — 11× `hb-atlas`'s distortion on Han, 7×
on Latin, and worse than the shipped `dom` path on Han (0.196 against 0.132). That is a property of
evaluating coverage at 14 px, not a placement bug: `_hb_gpu_slug` takes its `ppem < 16` branch here
and averages five taps a third of a pixel apart, which is a box filter by another name. **The
HARNESS ARM runs no stem darkening and no gamma, deliberately**, so this is raw coverage with no
contrast curve flattering it — `text-gpu.ts` passes `HB_GPU_CONTRAST_NONE` and says why at the call
site. The renderer's own default is the opposite; see
[The contrast curve](#the-contrast-curve-shipped-on-measured-off) below. Every distortion figure in
this table is a statement about raw Slug coverage and would be a statement about a contrast curve if
the arm shipped one.

Two columns cut the other way and are worth stating rather than burying. **`rmsVsReference` is the
lowest of any browser arm in both bands** (5.77 / 5.65 against `hb-atlas`'s 6.46 / 8.60): per pixel
it is CLOSER to the 8× reference than the crisper arm is, because `hb-atlas` sits slightly ABOVE the
reference acutance (2.0029 against 1.9694 — harder-than-correct edges) while hb-gpu sits below it.
And it moves genuinely sub-pixel (residual 0.029 Han), with an `edgeShimmer` an order of magnitude
under `hb-run`'s.

**Cost — 1280×800, 20 cells × 2 runs, headed under Xvfb on the RTX 2060 through ANGLE.** All five
arms in **one invocation**, which is the only way this table is legitimate: an earlier draft put a
freshly measured hb-gpu next to four numbers from a previous session, and this harness's own rule is
that a column may not be compared across runs. Driver VRAM is the per-window delta, per arm.

| arm          | frameCostMs p50 | rasterMs | mainThreadBusyMs | cpu.totalCpuMs | draws | quads/frame | ΔVRAM   |
| ------------ | --------------- | -------- | ---------------- | -------------- | ----- | ----------- | ------- |
| **hb-run**   | **0.52**        | 0        | **106**          | 531            | 1     | 40          | 38.8 MB |
| **hb-gpu**   | **0.56**        | 0        | 119              | **524**        | **1** | **900**     | 41.9 MB |
| **hb-atlas** | 0.85            | 0        | 171              | 635            | 1     | 1040        | 45.1 MB |
| dom          | 0.98            | **782**  | 191              | **1606**       | —     | —           | 8.4 MB  |
| canvas2d     | 0.99            | 0        | 255              | 742            | —     | —           | 16.8 MB |

Presence **40/40** on every arm. **hb-gpu is cheaper per frame than `hb-atlas`** despite evaluating
curves per fragment instead of blitting 1:1 — one instanced draw call, 900 quads. It draws 900 where
`hb-atlas` draws 1040 because it emits no quad for the 140 spaces, which carry no ink;
`inklessGlyphsPerFrame` is published so that gap cannot be read as dropped glyphs.

The absolute p50s run ~15 % above the previous round's on identical code, uniformly across all five
arms, while the ordering is unchanged — which is what a busier box looks like and why the ordering,
not the millisecond, is the finding. **Read ΔVRAM and not the absolute**: all five arms share ONE
Chrome GPU process measured in sequence, so its absolute reading (76 → 96 → 120 → 108 → 113 MB)
is cumulative and reclaimed, not per-arm. `hb-atlas`'s +45.09 MB has now reproduced to the byte
across three independent runs, including one that measured that arm alone.

**Memory, and the two numbers that must not be confused.**

|                          | hb-gpu                                                       | hb-atlas     |
| ------------------------ | ------------------------------------------------------------ | ------------ |
| texture the driver holds | **1.25 MiB** (`atlasReservationBytes`, 4096 × 40 rows × 8 B) | **1.45 MiB** |
| live glyph data          | 1.24 MiB (`atlasBytes`, 99.4 % occupancy)                    | —            |
| wasm heaps, as measured  | **4.50 MiB** — harfbuzzjs 2.50 + hb-gpu 2.00                 | 2.50 MiB     |
| wasm heaps, since↓       | **2.00 MiB** — hb-gpu alone                                  | 2.50 MiB     |

`atlasReservationBytes` is the figure that belongs beside `hb-atlas`'s 1.45 MiB, because that one is
also a whole-texture allocation; `atlasBytes` is the occupied part and is the smaller, more
flattering number. At DPR 1 hb-gpu's texture is **marginally smaller** than the baked atlas — and it
is the number that does not move on a phone, where the atlas grows 7.9× per cell.
[The phone](#the-phone) measures both sides of that.

`wasmHeapBytes` **was summed across MODULES, not just faces**, when this was measured: the arm shaped
with harfbuzzjs and encoded with hb-gpu's own HarfBuzz, so both faces were resident in two heaps at
once. hb-gpu's half is exactly 2.00 MiB, its `-sINITIAL_MEMORY`, which the workload never exceeded —
the package was built with that flag because emscripten's 16 MiB default reservation is not a
measurement and would have overstated this arm ~8×. **That half is now the whole row**, measured
below.

### After the swap: one HarfBuzz, measured

`mountHbGpu` shapes through `HbGpuFont.shape`, so npm `harfbuzzjs` is not instantiated on this arm at
all. Re-measured on the same rung as the table above — 1280×800, DPR 1, headed under Xvfb on the
RTX 2060 through ANGLE, hb-gpu alone:

| `script=both`, desktop  | before    | after        |
| ----------------------- | --------- | ------------ |
| `wasmHeapBytes`         | 4.50 MiB  | **2.00 MiB** |
| `shapeMs`               | 9.4       | **3.8**      |
| `glDrawCalls`           | 1         | 1            |
| `glyphsPerFrame`        | 1040      | 1040         |
| `quadsPerFrame`         | 900       | 900          |
| `distinctGlyphs`        | 260       | 260          |
| `atlasReservationBytes` | 1 310 720 | 1 310 720    |
| `blobBytes`             | 1 302 848 | 1 302 848    |

**The unchanged rows are the load-bearing ones.** Two independently compiled HarfBuzz builds shaped
the same 40 fixture runs into the same 260 distinct glyphs and the same 1 302 848 B of encoded
outline. That is the agreement `test/text-shaper-agreement.test.ts` asserts, confirmed on the real
workload by the arm producing byte-identical storage.

**Startup did not regress, which contradicts what this page predicted.** The prediction was that the
extra 190 KB of binary would cost fetch and compile time. It does not, because the 190 KB was already
being paid — the vendored binary has exported the shaper since before this swap — while a whole
second wasm module's fetch and instantiation was removed. Back to back on one box, hb-gpu alone:
`initialRenderMs` **70.3 after against 186 before**, `frameCostMs` p50 0.67 against 0.73.

**Do not read the frame-cost column as a finding.** Across six runs this arm's p50 ranged 0.56–0.92
on the _same_ code depending on what else the box was doing, and the swap does not touch the
per-frame path at all — same quads, same draw call, same atlas. Only the back-to-back pair above may
be compared column for column, and it is reported because it refutes a predicted regression, not
because 0.06 ms is a result.

**The heap figure stopped varying**, which is the more useful form of the result. It is now exactly
`-sINITIAL_MEMORY` — 2 097 152 B — on every rung and every script measured, holding one face or two,
shaping and encoding. It previously moved with how many faces harfbuzzjs was holding beside it:
3.15 MiB (`script=han`, phone), 4.19 MiB (`script=both`, phone), 4.50 MiB (`script=both`, desktop).
[The phone](#the-phone) has the two device readings.

**Blob size — the prediction, answered.** 259 distinct inked glyphs, 1 302 848 B total = **4.91 KiB
per glyph**, against the ~5.4 KB predicted. The spread is the interesting part and a mean hides it:
**376 B to 11 672 B, a factor of 31**, so an atlas cannot be sized by multiplying the mean by a
glyph count.

**Startup.** shape 6.1 ms, encode 9.5 ms, upload 2.8 ms, program link 13.8 ms — against `hb-atlas`'s
shape 9.5 + bake 17.0. `encodeMs` and `programMs` are reported SEPARATELY because the combined
counter lied: it read 182.8 ms, then 226.4 ms after the encode work was **halved**. The link is what
dominates, and it is driver-cache-bound — 161.5 ms on the first repeat of a run, 10.6 and 13.8 ms on
the second and third once ANGLE's program cache is warm. Encoding is a stable 9.4–10.0 ms.

**Blob size — the prediction, answered, and the comparison it got wrong.** The estimate was ~5.4 KB
per Han glyph against ~1.4 KB for a 38×38 R8 atlas cell, concluding that hb-gpu loses on VRAM. **The
per-glyph number is right and the conclusion does not follow.** Measured with the encoder itself,
over the glyph sets S9 really draws:

| glyph set                              | glyphs | Slug blobs | per glyph |
| -------------------------------------- | ------ | ---------- | --------- |
| Han, S9's working set (20 runs × 12)   | 221    | 1.16 MiB   | 5.35 KiB  |
| Han, the whole pool the runs draw from | 2999   | 16.79 MiB  | 5.73 KiB  |
| Latin, S9's working set                | 38     | 0.10 MiB   | 2.74 KiB  |

5.73 KiB a glyph against ~5.4 KB predicted, so the estimate was slightly low and the full 3000-glyph
pool costs 16.79 MiB rather than 13.5 MB. **But `~1.4 KB per cell` was the wrong thing to compare it
against.** A cell is one glyph at ONE sub-pixel phase and `hb-atlas` ships four; a blob is the whole
glyph, at every phase and every rotation, because it stores an outline rather than pixels. Like for
like, on the identical 221-glyph Han set:

| S9's Han working set | storage      | per distinct glyph |
| -------------------- | ------------ | ------------------ |
| `hb-atlas`, 4 phases | 1.36 MiB     | 6.30 KiB           |
| **hb-gpu**           | **1.16 MiB** | **5.35 KiB**       |

**Slug is 15 % smaller than the baked atlas on the workload S9 actually draws**, not 3.9× larger.

**And the two scale differently, which is what a phone decides.** An atlas cell is pixels and grows
with pixel density; a Slug blob is em-space outline data and does not. Both halves are now measured
on both rungs — `hb-atlas` **7.9× per cell** from DPR 1 to DPR 3.4876, `hb-gpu` **1.01×** — in
[The phone](#the-phone), which is also where the 15 % above becomes 9.2×.

### The blur is the `ppem < 16` branch, and it is measured

`src/hb-gpu-fragment.glsl` branches on `if (ppem < 16.0)` and evaluates `_hb_gpu_slug_single`
**five** times inside it — one central tap plus four MSAA taps a third of a pixel apart,
unconditionally — while `smoothstep(16, 8, 14)` mixes only **0.156** of that result in. At 14 px and
DPR 1 the arm pays five times the work for a sixth of an effect. That is a box filter with extra
steps, and it predicts that hb-gpu's blur should vanish the moment ppem clears 16.

**It does.** Same probe, same eight offsets, same geometry, only `--font-size` moved:

| ppem   | hb-gpu Han | hb-gpu Latin | hb-atlas Han | hb-atlas Latin | hb-gpu align (Han / Latin) |
| ------ | ---------- | ------------ | ------------ | -------------- | -------------------------- |
| 14     | 0.196      | 0.104        | **0.017**    | **0.015**      | 0.156 / 0.092              |
| 20     | **0.014**  | **0.004**    | 0.012        | 0.009          | 0.031 / 0.014              |
| 28     | 0.025      | **0.003**    | **0.012**    | 0.006          | 0.034 / 0.014              |
| **49** | 0.017      | **0.001**    | **0.004**    | 0.002          | **0.028 / 0.014**          |

**A 14× improvement on Han and 26× on Latin, from one step across ppem 16**, with alignment
collapsing 0.156 → 0.031 px alongside it. At ppem 20 hb-gpu ties `hb-atlas` on Han and is **twice as
crisp on Latin**; at 28 it is still twice as crisp on Latin. Every arm improves with size — `dom`
goes 0.132 → 0.106 → 0.104 → 0.040 — so these are only comparable down a column, but nothing else on
the page moves by 14× across two font sizes. The branch is the whole story.

**ppem 49 is the row that matters, because it is the phone's raster scale**: 14 px × DPR 3.4876 =
48.8, so the glyph raster scale, the atlas cell sizes and the shader's own `ppem` uniform all match
the device. It is still a desktop rung — measured at DPR 1 with `--font-size 49`, on the RTX 2060 box
under Xvfb — so it is a **proxy for the phone's crispness, not a phone measurement**. What it shows:

- **hb-gpu lands at 0.017 Han / 0.001 Latin**, 11× and 104× better than at ppem 14, and it is the
  **crispest arm on the page in the Latin band**, ahead of `hb-atlas`'s 0.002.
- **`hb-atlas` is still the crispest on Han** (0.004 against hb-gpu's 0.017). The ordering on Han does
  not flip; the gap closes from 11× to 4× and both are far inside what either would show a user.
- **hb-gpu has the best alignment of any arm at this size**, 0.028 / 0.014 px.
- `dom` snaps: residual **0.270 px** and alignment 0.246 in both bands, the signature of rounding to
  whole pixels. It is the only arm here that cannot move sub-pixel at all.
- `hb-run` stays disqualified on the metric it was always going to fail — 0.089 Han with an
  `edgeShimmer` of **0.0442**, 45× `hb-atlas`'s and 45× hb-gpu's. Density does not fix resampling.

The narrow claim the ppem sweep was built to test is now closed: **hb-gpu's blur at 14 px is a shader
branch that a phone's pixel density does not take**, and once outside it the arm is competitive on
Han and best-in-class on Latin.

### The same branch again, on the OUTLINE, where it cost 5.74× and bought nothing

`HbGpuRenderer.setSpread` dilates a run by taking a max of coverage taps, and each tap was
`hb_gpu_spread_tap` — `_hb_gpu_slug` mirrored, `ppem < 16` branch and all. So below ppem 16 one ring
tap was **five** `_hb_gpu_slug_single` evaluations and a dilated fragment took up to 65 taps. Measured
on S9 (RTX 2060, 1280×800 at DPR 1, 40 outlined runs at 14 px, the consumer's modal `outlinePx` 6):
**12.27 Hz, against 70.47 with the branch dropped from the tap only**. The font-size ladder isolates
it — same 3 px radius, same 47-tap set, 17.44 Hz at `fontSize` 18 and 74.76 at 20, because 20 is
where the ppem the shader computes crosses 16. It is one branch, not the tap count: capping the rings
and steps at 3×12 buys 1.5× and 2×8 buys 2.3× by punching holes through thin features.

**The fill's branch stays. Only the dilation's taps lose it** —
`HbGpuRendererOptions.spreadTapMsaa`, default `false`, guarded by `HB_GPU_SPREAD_TAP_NO_MSAA` and
deliberately not the library's `HB_GPU_NO_MSAA`, which is the fill's. `glyphPixelXvfb.test.ts` builds
both programs on one context and asserts the spread-0 fill is byte-identical between them; defining
the library's macro instead moves 84 pixels of it, worst 40 levels.

**And the quality argument came out backwards from the prediction.** The expectation was a slightly
coarser rim. What the pixels show, at 14 px per em rotated 10°, spread 3, both programs in one frame
at one phase: the two differ on 267 px, RMS 33.4 levels, worst 85 — spread across the blob's whole
interior, not its rim — and the variant **without** the MSAA is the one closer to an 8× dilated
reference (rim RMS 77.9 vs 85.1; ink 36102 vs 30192 where the ideal grown shape is 58081).

The reason is the same fact that makes `PPEM_FIDELITY_FLOOR` 16 in the first place. A `max` over
coverage cannot exceed the peak coverage near a fragment, and at ppem 14 a Han glyph's strokes never
reach coverage 1 — so **a dilated glyph at 14 px is a translucent mottle at ~60 % of the ideal
silhouette whatever the tap set does**, and the extra smoothing was deepening that shortfall rather
than repairing it. `artifacts/perf/outline-study/lowppem-compare.png` is the pair at 10× zoom.

Two consequences worth carrying: the outline path below ppem 16 is a **fidelity** problem and not
only a cost one, so the ≥ 16 floor binds harder for outlined labels than for plain ones; and the
`cov >= 0.999` interior early-out barely fires down there, which is the other half of why that size
was also the expensive one.

### The mottle was in what a tap MEANT, not in the tap set

The round above closed with "a dilated glyph at 14 px is a translucent mottle at ~60 % of the ideal
silhouette **whatever the tap set does**". That was right, and it was the wrong thing to conclude
from. Every candidate on the table was a different arrangement of taps, and the arrangement was
never the problem.

**A dilated shape is a union of disks: a BINARY shape**, with partial coverage only at its own
boundary. `max` over raw coverage taps cannot produce one, because a max cannot exceed the largest
coverage near the fragment — and at ppem 14 a Han stroke is thinner than a pixel, so its coverage
**peaks at 0.42** and the whole silhouette inherits that ceiling. So each tap is now **sharpened
before the max**, `smoothstep(0.0, 0.5, coverage)`, which turns it from "how much ink is here" into
"is this inside". `0.5` is the top of the range because a pixel centred exactly ON the outline reads
0.5.

**"A tap above half coverage is inside" is the obvious rule and it is measurably the wrong one.** It
was tried first and it makes this case worse than shipping nothing — half of a _pixel_ is not half
of a sub-pixel _stroke_, and a knee centred on 0.5 sits above anything a 14 px Han stroke can reach.
Swept on the RTX 2060 through ANGLE against 8× grown references, both regimes:

| knee            | low rim RMS | low ink ratio | low interior short | thin rim RMS | thin ink ratio |
| --------------- | ----------- | ------------- | ------------------ | ------------ | -------------- |
| none (was)      | 77.89       | 0.622         | 38.5 %             | 80.90        | 0.965          |
| 0.35 – 0.65     | 128.57      | 0.574         | worse still        | 102.52       | 0.966          |
| 0.25 – 0.75     | 112.35      | 0.604         | —                  | 99.72        | 0.965          |
| 0.20 – 0.50     | 76.87       | 0.870         | —                  | 94.27        | 0.974          |
| 0.15 – 0.45     | 73.85       | 0.968         | —                  | 90.15        | 0.978          |
| 0.10 – 0.40     | 84.75       | 1.037         | —                  | 85.82        | 0.985          |
| 0.05 – 0.50     | **72.64**   | 0.968         | 7.4 %              | 82.81        | 0.983          |
| 0.00 – 0.55     | 69.73       | 0.947         | 9.3 %              | 79.96        | 0.984          |
| 0.00 – 0.45     | 83.29       | 1.026         | **3.3 %**          | 78.86        | **0.990**      |
| **0.00 – 0.50** | 75.66       | **0.988**     | 6.1 %              | **79.10**    | 0.987          |

`0.00 – 0.50` is the only row that improves **every** column at once, and the only one with a
sentence behind it rather than a fit. The headline: **ink 36102 → 57370 against an ideal 58081**
(0.622 → 0.988), **interior shortfall 38.5 % → 6.1 %**, rim RMS 77.89 → 75.66.

**Three things it is honest to say it did not do.**

1. **The early-out still does not fire at 14 px.** The predicted frame-cost side effect is not
   there. A tap saturates to exactly 1 only once its raw coverage reaches 0.5, and 0.42 sharpens to
   **0.931** — under `HB_GPU_SPREAD_SOLID`'s 0.999. Above ppem 16 taps already reached 1, so nothing
   moved there either. Lowering that constant would collect it and is a separate decision with its
   own pixels to grade.
2. **The placement is not what fixes the fidelity.** `smoothstep` is monotone, so it commutes with
   `max`: moving it after the loop measures ink ratio 0.989 against 0.988. Per-tap earns its place
   for two other reasons — the unsharpened fill stays the FLOOR (`smoothstep(0, 0.5, x)` is _below_
   `x` for `x < ~0.08`, so sharpening the max would make a faint fill pixel dimmer than it was
   drawn, breaking the superset property), and only a per-tap value can trip the in-loop early-out
   at all.
3. **The boundary moves outward by a fraction of a pixel at large ppem.** A tap sitting exactly on
   the outline reads 0.5 and this maps it to 1, where the ideal answer at the dilated boundary is
   also 0.5. Measured: the 96 px/em ink box grows 5 px on one side for a spread of 4. Inside
   `SPREAD_TOLERANCE_PX`, and it moves the thin case's ink ratio _closer_ to 1 (0.965 → 0.987).

### A second, separate defect: the clamped tap set did not tile a large disk

`HB_GPU_SPREAD_MAX_RINGS` 4 and a per-ring `HB_GPU_SPREAD_MAX_STEPS` of 16 gave a 65-tap ceiling.
Past a radius of ~2.7 device px the ring spacing starts to grow and past ~2.5 the angular step did
too, so a large outline was dilated by a tap set that **no longer covers its own disk**. On the moto
g86 5G at DPR 3.4876 the clamp is hit at _every_ outline width, and at `outlinePx` 10 (radius 17.4
device px) the outline renders as a ragged fringed slab.

`SPREAD_THIN_CASE` at spread 12 is the in-repo fixture in that regime — rings 3 px apart, outermost
taps 4.7 px of arc apart — and it carries an 8× grown reference of its own, because the pre-existing
"every reachable pixel is solid" mask only looks _inside_ the shape and is blind to a scalloped
boundary. Measured there: **rim RMS 79.10, ink ratio 0.987, interior shortfall 213 levels (0.8 % of
the interior)**. The tap sharpening improved all three (from 80.90 / 0.965 / 1506), but the rim was
still as far from ground truth as the 14 px mottle was, for an unrelated reason.

**The budget was not widened. It was redistributed, and that was free.** A tap budget is a
device-cost ceiling and the device is the rung that cannot afford to raise it — but the defect was
never the ceiling. Clamping every ring to the same 16 steps spends the budget EQUALLY across rings
whose circumferences differ by 4×, so the outermost ring — the only one that decides where the
dilated boundary lands — was the **sparsest** of the four: at radius 12 its taps sat 4.71 px of arc
apart while ring 1 sampled a 4.7 px circle with the same 16.

So `HB_GPU_SPREAD_MAX_STEPS` is gone and `HB_GPU_SPREAD_MAX_TAPS` = 64 replaces it: one flat loop,
one tap per iteration, the compile-time bound _is_ the worst-case tap count (64 + the centre tap =
65, exactly what 4 × 16 was), and the split is proportional to ring radius —
`(64·k + denom/2) / denom` with `denom = rings(rings+1)/2`, i.e. **6 / 13 / 19 / 26** at four rings,
summing to exactly 64 at every ring count from 1 to 4. Ring radii stay equally spaced. The outer arc
at radius 12 goes 4.71 px → **2.90 px**.

Measured on the Godot 4.5.1 golden (headless ANGLE/Vulkan, RTX 2060), one shader change apart:

| case                    | radius | metric     | Godot  | 4 × 16     | 6/13/19/26 |
| ----------------------- | ------ | ---------- | ------ | ---------- | ---------- |
| dot-radial-wide         | 12     | `r50Stdev` | 0.1068 | 0.2813     | **0.1679** |
| dot-radial-wide         | 12     | h16        | 0.0164 | **0.3099** | **0.0512** |
| dot-radial-wide         | 12     | h26        | —      | —          | 0.0934     |
| dot-radial              | 4      | `r50Stdev` | 0.0833 | 0.1628     | 0.1587     |
| dot-radial              | 4      | h16        | 0.0012 | 0.0057     | 0.0406     |
| dot-radial              | 4      | h26        | —      | —          | 0.0059     |
| **dot-radial-live-max** | **14** | `r50Stdev` | 0.1092 | —          | **0.1910** |
| **dot-radial-live-max** | **14** | h16        | 0.0115 | —          | **0.0426** |
| **dot-radial-live-max** | **14** | h26        | —      | —          | **0.1506** |
| **dot-radial-live-max** | **14** | `r50Mean`  | 18.066 | —          | **18.140** |
| **dot-radial-live-max** | **14** | ramp       | 0.933  | —          | **0.000**  |
| **dot-radial-live-max** | **14** | ramp (∇)   | 0.994  | —          | **0.248**  |
| `SPREAD_THIN_CASE`      | 12     | rim RMS    | —      | 79.10      | **52.26**  |
| `SPREAD_THIN_CASE`      | 12     | interior   | —      | 213 levels | **0**      |
| `SPREAD_THIN_CASE`      | 12     | ink ratio  | —      | 0.987      | 1.012      |

The 19× excess at 16 cycles per revolution — the signature of a boundary following a tap count
rather than a circle — falls to 3.1×, the total wobble falls 40 %, the thin case's rim falls a
third, and the scallop that used to cut into the grown reference's solid interior is **exactly zero**
levels. The residue moved where the mechanism says it must: on `dot-radial-wide`, h26 (0.0934) is now
the larger bin, a scallop at the outer ring's new 2.90 px pitch. `dot-radial`'s h16 went the other
way, 0.0057 → 0.0406, while its total wobble fell — one DFT bin of a boundary that got smoother
picking up a twenty-fifth of a pixel of leakage, reported rather than explained away.

**What did not move**: the ink box growth (L5 T4 R4 B4 at spread 4, byte-identical), the "no ink past
r+1 / no shortfall inside r−1" pair on both spread cases (exactly 0 under both allocations, so the
boundary did not move outward on average), the fill path at spread 0, and the worst-case tap count.
A radius of 4 now spends the full 65 where it spent 53, and a radius of 3 spends 51 where it spent
48; every radius past 4 spends 65 either way, which is the case a phone is in.

Fail-proved twice: dropping the old step ceiling to 6 read rim RMS 128.80 / ink 0.829 / interior
26353, and reverting this split back to a flat `clamp(…, 6, 16)` puts the thin rim back to 79.10
against the tightened `THIN_RIM_RMS_BUDGET` of 65 and `dot-radial-wide`'s h16 back to 0.3099 against
`GODOT_HARMONIC_BUDGET_PX` of 0.08.

**It is not a claim that the disk is now tiled.** 2.90 px of arc is still a coarse covering at radius
12, and the phone's radius is 17.4. What the redistribution buys is the free 3× — the same cost, the
gaps moved off the ring that matters. Whether that is enough on a phone is a measurement on a phone.

#### The live worst case: r = 14, and the budget that had a radius hidden in it

Everything above was graded at r ≤ 12, and the product does not stop there. Measured on the running
game, its outline strokes are `outlinePx` **6, 7.5 and 8** CSS px, which at the phone's DPR 3.4876
are device radii of **10.5, 13.1 and 14.0**. `han-phone` covers the first, `dot-radial-wide` at 12
sits between the first and the second, and nothing covered the third — so **`dot-radial-live-max`**
was added at **spread 14, `outline_size` 56**, and it is the row above marked as the live worst case.
(The earlier `outlinePx` 10 / radius 17.4 figure in this section is the ragged-slab observation that
opened the defect, not a stroke the current scene draws; 14.0 is what the live measurement returns.)

It is `dot-radial-wide`'s geometry with only `spreadPx` moved — a `.` at 96 px/em in a 128 px cell,
pen (53, 67), dot radius 3.89 px — so the pair is a controlled comparison in the **radius alone**
rather than two fixtures whose difference could be the ppem or the sub-pixel phase. The dilated dot
reaches 17.9 px in a cell whose centre is 64 px from every edge, so the radial metric's rays still
have over 45 px of background to walk in from. The five pre-existing Godot rows came back **identical
to the digit** when the golden was regenerated with it; the capture is deterministic and only the
frame's width, its PNG digest and the realism column's `cellX` moved.

**What the r = 14 row says.** Reach is the _tightest_ agreement of the three radii — +0.074 px
against Godot, where r = 4 is +0.241 — so `outline_size / 4` is if anything better re-derived at the
live maximum than at the fixtures that were chosen first. The rim is sharper than Godot's on both
forms (radial 0.000 against 0.933, and the gradient form, which shares none of the ray sampler's
arithmetic, 0.248 against 0.994). Total wobble stays inside `GODOT_SCALLOP_BUDGET_PX` at **0.1910**,
which is 1.75× Godot's own 0.1092 — the same multiple the r = 12 row carries.

**One budget moved, and it was restated rather than loosened.** h26 read **0.1506 against a flat
0.14**, and every case that flat number was calibrated on was r ≤ 12. That bin is the sagitta of the
outermost ring, whose step count is fixed at 26 for any radius past ~4 px, and a sagitta is
`r · (1 − cos(π/N))` — _linear in the radius_. A flat px budget on it therefore has a radius hidden
in it. `GODOT_OUTER_HARMONIC_BUDGET_PER_RADIUS` = **0.016 px per px of radius** replaces it: the
worst reading (0.01076/px at r = 14, against 0.00778 at r = 12 and 0.00148 at r = 4) plus a half,
which is the construction the flat number already carried. It yields 0.064 / 0.192 / 0.224 px at
r = 4 / 12 / 14.

**It still excludes the old allocation at every radius**, which is what makes it a budget and not a
fitted line. The same statistic under `4 × 16` — that allocation's _own_ outermost-ring bin, which
was h16 because 16 is what its outer ring ran — read **0.3099 at r = 12, i.e. 0.02583 per px of
radius**. Both sides are linear in `r`, so the exclusion is a comparison of coefficients and is
radius-independent: 0.016 is 1.61× below it, and at r = 12 the rule gives 0.192 against that
allocation's 0.3099. The two constants that carry the old allocation's measured numbers —
`GODOT_SCALLOP_BUDGET_PX` (0.21 vs 0.2813) and `GODOT_HARMONIC_BUDGET_PX` (0.08 vs 0.3099) — **did
not move** and are green at r = 14 (0.1910 and 0.0426).

**This is the number the two-pass decision turns on, and it does not decide it.** 0.1506 px of
26-cycle scallop at the widest stroke the product draws is 1.61× the r = 12 reading on a radius only
1.17× larger. `r50Stdev` per px of radius is essentially flat (0.01399 at 12, 0.01364 at 14) while
the outer harmonic's is not (0.00778 → 0.01076), so the residue is _concentrating_ in the outer
ring's own bin as the radius grows — which is what a second dilation pass removes and what
redistributing one pass's taps again would not. Whether 0.15 px of scallop is visible at DPR 3.49 is
a measurement on a phone, not a budget in this repo.

### The contrast curve: shipped ON, measured OFF

Everything above grades this path against an 8× area-coverage reference, and for a long time the
renderer emitted exactly that — raw coverage, no stem darkening, no gamma. **That was the right
default for a measurement arm and the wrong one for a product**, and the number that says so is not
a distortion figure.

**The measurement that opened it.** One fixed crop of the word "Breakthrough" in the downstream game
scene, 1600×900 at DPR 1.25 — i.e. 20 device px per em — with three arms rendering the same word:

| arm            | acutance | px below luma 80 | peak darkness | mean luma | total ink |
| -------------- | -------- | ---------------- | ------------- | --------- | --------- |
| glyph (hb-gpu) | 49.80    | 775              | 51            | 120.5     | 2736      |
| raster (2D)    | 47.72    | 671              | 51            | 121.5     | 2623      |
| **dom**        | 59.12    | **1285**         | 50            | 121.0     | 2744      |

Identical peak darkness, identical mean luminance, identical total ink — and DOM puts **66 % more
pixels in the deep-dark end**. The disagreement is entirely in the middle of the coverage ramp: the
browser pushes a partially covered pixel toward the ink colour (gamma-correct blending plus stem
darkening), where a linear coverage ramp leaves a sub-pixel stem at mid-grey. That reads as washed
out at exactly the sizes a UI uses, and it is not something a consumer can fix downstream.

**What ships now.** `HbGpuRendererOptions.contrast`, defaulting to `HB_GPU_CONTRAST_DEFAULT`
(`{ gamma: 1, stemDarkening: true }`). The fragment applies `hb_gpu_stem_darken` — HarfBuzz's own,
out of the vendored shader library — to the FINAL coverage, after any dilation:

```glsl
pow (coverage, mix (pow (2.0, brightness - 0.5), 1.0, smoothstep (8.0, 48.0, ppem)))
```

`brightness` is `dot (u_color.rgb, vec3 (1/3))`, which needs no new uniform because `u_color` is
straight rather than premultiplied; `ppem` is `hb_gpu_ppem`, **not** upstream's
`1 / max (fwidth (v_texcoord))` — this renderer's coordinates are font units, so that reciprocal
would be off by a factor of `upem` and the ramp would be saturated everywhere. Both calls sit in
uniform control flow, because `hb_gpu_ppem` takes a derivative and upstream's demo puts its `fwidth`
inside a per-fragment `0 < cov < 1` test, which is a desktop-GLSL liberty GLSL ES 3.00 does not
allow.

**Measured, on the RTX 2060 through ANGLE**, twenty-five "B"s at 20 device px per em — the
consumer's own size — read off the alpha plane, which IS the coverage
(`packages/hb-gpu/test/glyphPixelXvfb.test.ts`, `contrast` block):

| frame                     | ink     | ramp px | deep (≥ 0.70) | peak | acutance |
| ------------------------- | ------- | ------- | ------------- | ---- | -------- |
| `HB_GPU_CONTRAST_NONE`    | 220 500 | 1750    | 425           | 223  | 2.001    |
| **shipped, dark fg**      | 251 700 | 1750    | **750**       | 230  | 1.911    |
| shipped, light fg         | 185 775 | 1725    | 75            | 213  | 2.100    |
| `gamma: 0.6` (probe only) | 280 275 | 1750    | 950           | 235  | 1.828    |

**+76.5 % in the deep end for +14.1 % ink**, with the peak up 3 % and acutance down 4.5 %. That is
the same SHAPE as the DOM gap — a reshape of the ramp's upper half, not a brightness knob — and the
test asserts the ratio rather than either number, because a correction that moved ink and the deep
count together would be scaling coverage rather than fixing it. Light-on-dark moves the other way by
construction (`pow (2, 1 - 0.5)` = 1.414, i.e. thinner), which is the whole reason the brightness is
read per draw instead of configured.

**It ramps itself off.** `smoothstep (8, 48, ppem)` is exactly 1 at and above ppem 48, so large text
cannot move: the same fixture at 96 px per em is **byte-identical** with the correction on and off
(ink 89 473 either way). `gamma` does not ramp — it is a plain exponent with no view of `u_color` and
no size term — which is why its default is 1 and why it is a separate field. HarfBuzz's own demo
flips gamma by theme (`dark_mode ? 1/2.2 : 2.2`); a renderer that draws both polarities in one frame
cannot, so the polarity-aware half is stem darkening and gamma is the manual override beside it.

**Who turns it off, and why that list is short.** `packages/perf-harness/src/scenarios/text-gpu.ts`
and every graded probe in `packages/hb-gpu/test/browser-entry.ts` pass `HB_GPU_CONTRAST_NONE`, each
with the reason at the call site. A fidelity probe grades a RASTERIZER against area coverage; an arm
carrying a contrast curve scores the curve. The distortion figures above (0.196 Han at ppem 14,
0.017 at ppem 49) only mean what they say against raw coverage, and they are the reason the opt-out
exists rather than the default being off.

### …and it was running on the OUTLINE too, where Godot has none

The block above applies the curve to the **final** coverage, after any dilation, on the argument that
an outline's rim is a coverage ramp with the same problem a fill's has. That argument is wrong, and
the fixture that says so is a Godot render rather than an opinion.

**Godot applies no contrast curve to an outline.** It strokes the glyph with FreeType's stroker at
`outline_size / 4` and rasterises the result through the same plain grayscale raster it uses for the
body — no gamma, no darkening, nothing keyed on the foreground colour. `godot/project/scripts/outline_ref.gd`
draws five cases that way under Godot 4.5.1, `scripts/godot-outline-ref.ts` measures them, and the
metrics are committed at `packages/hb-gpu/test/goldens/godot-outline-metrics.json`.

**Measured against it, RTX 2060 through ANGLE**, ramp width in px of equivalent linear ramp — the
`none` column is `HB_GPU_CONTRAST_NONE`, the two `default` columns are a renderer built with no
`contrast` option at all, i.e. what a consumer gets:

| case            | ppem | radius | godot | none  | default white | default black | white vs none  | black vs none  |
| --------------- | ---- | ------ | ----- | ----- | ------------- | ------------- | -------------- | -------------- |
| han-desktop     | 14   | 3      | 0.851 | 0.662 | **1.965**     | 0.518         | 31 lv / 144 px | 30 lv / 146 px |
| han-phone       | 49   | 10.5   | 1.077 | 0.851 | 0.851         | 0.851         | 0              | 0              |
| latin-desktop   | 20   | 3      | 1.043 | 0.216 | 0.216         | 0.196         | 26 lv / 14 px  | 25 lv / 12 px  |
| dot-radial      | 49   | 4      | 1.091 | 0.518 | 0.518         | 0.518         | 0              | 0              |
| dot-radial-wide | 96   | 12     | 0.938 | 0.475 | 0.475         | 0.475         | 0              | 0              |

Two things fall out. The uncorrected dilation is **sharper than Godot on every case** — the taps have
been an inside test since `HB_GPU_SPREAD_INSIDE_LOW`, so the dilated boundary is nearly binary, and a
binary edge is harder than area coverage, not softer. And the softness the round went looking for is
entirely in the shipped columns, at exactly the two sizes where `smoothstep (8, 48, ppem)` has not
yet ramped the correction off. At han-desktop the shipped curve **tripled** the rim of a frame whose
uncorrected version was already sharper than the engine's.

The mechanism is the one the fill wants and the outline does not. `pow (2, brightness - 0.5)` is
0.707 for dark ink, which lifts a rim pixel from 0.30 coverage to 0.43 — on a stem that is the middle
of the ramp being pushed toward the ink colour, on a stroke it is 0.13 of unearned ink outside the
silhouette, in a ring, which is a halo. Light ink gets the same thing with the sign flipped: 1.414
thins the rim and the outline reads as eaten into.

**What ships now.** The fragment computes `fillPass` as the exact negation of the dilation branch's
own condition and gates stem darkening on it, so a dilated draw writes the coverage it computed.
Gamma is **not** gated: it is an explicit consumer knob, defaults to 1 and is skipped entirely at
that value, and putting the fill and the outline of one run on different transfer curves for a
deliberate setting would be stranger than either choice. No new uniform, no API change — the shape
is `bool darken = u_stemDarken > 0.0 && fillPass`.

Negating the dilation branch's condition rather than testing `u_spreadPx` alone keeps a **degenerate**
run — one whose `a_emPerPos` is zero or NaN, which fails `v_spreadEm > 0.0` and takes the single-tap
path — on the fill's darkening. Such a fragment is a fill in everything that reaches the
framebuffer. It also means the gate is coherent wherever the dilation is: same predicate, same quad.

**After, same fixtures, same box:** every case's `defaultWhite` and `defaultBlack` frames are
**byte-identical** to `none` — 0 differing pixels on all five — so the Godot-graded table has one
column of ours in it and the shipping outline is under the same budget the measurement arm is:

| case            | ppem | radius | godot | ours, all three columns | delta  |
| --------------- | ---- | ------ | ----- | ----------------------- | ------ |
| han-desktop     | 14   | 3      | 0.851 | 0.662                   | -0.189 |
| han-phone       | 49   | 10.5   | 1.077 | 0.851                   | -0.226 |
| latin-desktop   | 20   | 3      | 1.043 | 0.216                   | -0.827 |
| dot-radial      | 49   | 4      | 1.091 | 0.518                   | -0.573 |
| dot-radial-wide | 96   | 12     | 0.938 | 0.475                   | -0.463 |

**The fill is untouched, and that is asserted rather than assumed.** Twenty-five "B"s at 20 device px
per em still move by 25 levels between `HB_GPU_CONTRAST_NONE` and the default (ink 220 500 → 251 700,
+76.5 % in the deep end); the same twenty-five glyphs dilated by 3 px move by **0**. The dilated frame
carries 350 partially covered pixels against the fill's 1750 at 8.5× the ink, which is the
nearly-binary boundary stated as a count.

**How this shipped in the first place**, recorded because the gap is reusable: `contrastProbe`
hardcoded `setSpread(0)` on every frame it captured, and every probe that _did_ dilate passed
`HB_GPU_CONTRAST_NONE` for the fidelity reason above. No fixture in the repo ran the shipping curve
over a dilated draw. The probe's `drawOn` now takes the radius as a parameter and captures an
`OutlineLow` pair beside the fill pair, and the Godot block asserts the identity above per case.

**The one edge that leaves.** A consumer drawing a spread run as the _only_ ink — an outline with no
fill composited over it — gets uncorrected coverage for that text, with no way to ask otherwise. That
is the right picture for a stroke and the wrong one for a glyph body; a caller in that position
should draw the fill it is standing in for.

### What `-webkit-text-stroke` has to be, for the DOM path to land in the same place

`outline_size / 4` is not an hb-gpu fact. It is what Godot's non-MSDF stroker does, so it is also the
number `packages/html` has to hit with a CSS stroke — and `cssOutlineSizeForFont` (`packages/html/src/text.ts`)
is that one line of arithmetic. **A CSS stroke is CENTRED on the contour**, so a width `W` reaches
`W / 2` outward while Godot's stroker reaches `outline_size / 4`; setting them equal gives
`W = outline_size * 0.5`, which is the whole function. `round` there is `css-values.ts`'s 3-decimal
quantizer and not an integer snap, so `outline_size` 3 emits **`1.5px`**, whose outward reach is the
0.75 px Godot draws.

**That is the emitted value; whether Chromium PAINTS it is a separate question**, and it was asked
because a handoff claimed a 1.5 px stroke reaches 1.0 px on screen — a +33 % halo, which would have to
be the browser rounding the width, since it cannot be the CSS. Measured with this repo's own
`outline-metrics.ts` radial form (256 rays, outermost 50 % crossing) on an isolated "." at a range of
sizes, reach taken as `r50(stroke = W) - r50(stroke = 0)` on the same glyph in the same cell so that
font, hinting and sub-pixel phase cancel; Chrome for Testing 148.0.7778.96 (Playwright build 1223),
windowless on ANGLE/Vulkan by the recipe in `glyphPixelXvfb.test.ts`'s header, grayscale AA
(`--disable-lcd-text`), white on black, blend calibrated at 0.25/0.5/0.75 → 64/128/191 first. **Reach
at `W = 1.5`, in CSS px, against the 0.750 the arithmetic predicts:**

| face         | font-size | DPR 1 | DPR 2 | DPR 4 |
| ------------ | --------- | ----- | ----- | ----- |
| Roboto       | 24 px     | 0.797 | 0.758 | 0.738 |
| Roboto       | 96 px     | 0.724 | 0.765 | 0.734 |
| Noto Sans SC | 24 px     | —     | 0.730 | 0.743 |
| Noto Sans SC | 96 px     | 0.781 | 0.767 | 0.738 |

**Worst deviation +0.047 px, against a threshold of 0.15 px stated before measuring — no gap.** Both
oddities in that table are the same one: a 24 px "." at DPR 1 is a ~1.3 px dot, at the radial form's
resolution floor. Noto Sans SC's is smaller still and yields no crossing at all with no stroke on it
(the blank); Roboto's is the +0.047 cell. Every other cell — 96 px anywhere, or the same 24 px dot at
DPR 4 where it is well resolved — lands 0.724 to 0.781. Sweeping `W` over 0.25–4 px fits
`reach = 0.480…0.528 * W` on every face/size/DPR combination, and a 0.25 px stroke reaches
0.06–0.16 px — sub-pixel widths paint sub-pixel reaches. **There is no staircase**, which is what a
browser quantising 1.5 px up to 2 px would have to show.

**Where the 1.0 px probably came from.** A whole-run ink measurement is the tempting way to check this
and it reads high. `(A_stroked - A_plain) / perimeter` on an eight-glyph "Outlined" run gives 0.925 px
at DPR 1, 0.803 at DPR 2, 0.785 at DPR 4 — because it is the FIRST-ORDER Steiner term only. Restoring
`pi * chi * r²` (χ = 6 for that run) and solving the quadratic at DPR 4 gives **0.763 px**, back on the
prediction. Measure the reach of an isolated round glyph, not the area of a run.

## The phone

The run the round existed to take. **motorola moto g86 5G**, Android 15, Chrome 151.0.7922.174,
**Mali-G615 MC2 through ANGLE** (OpenGL ES 3.2 `v1.r44p1-01eac0`), portrait, a 349×657 CSS-px
viewport at **DPR 3.4876** — so 14 px CSS is **ppem 48.8**, and the stage is the viewport, fit ×1.
Five arms, five repeats plus a warmup, medians. Battery 21→22 %, 24→25 °C, thermal status `none`
throughout, so nothing here was measured under throttling. **Presence 8/8 on every arm in both runs.**

**`script=han`, 8 runs × 12 glyphs, 89 distinct glyphs** — the workload comparable to the desktop's
Han half:

| arm          | frameCost p50 | raster ms | mainThread busy | cpu ALL ms | GPU storage  | draws | quads |
| ------------ | ------------- | --------- | --------------- | ---------- | ------------ | ----- | ----- |
| **hb-gpu**   | **2.79**      | 0         | **681**         | **3738**   | **0.47 MiB** | **1** | 96    |
| hb-run       | 2.92          | 0         | 714             | 3910       | 4.66 MiB     | 1     | 8     |
| dom          | 2.93          | **910**   | 790             | **5205**   | —            | —     | —     |
| hb-atlas     | 3.09          | 0         | 752             | 4080       | 4.36 MiB     | 1     | 96    |
| **canvas2d** | **5.92**      | 0         | **1444**        | 4107       | —            | —     | —     |

**`script=both`, 8 runs, 78 distinct glyphs** — Han and Latin together, the same ordering:

| arm          | frameCost p50 | raster ms | mainThread busy | cpu ALL ms | GPU storage  |
| ------------ | ------------- | --------- | --------------- | ---------- | ------------ |
| **hb-gpu**   | 2.89          | 0         | 704             | **3755**   | **0.29 MiB** |
| hb-run       | 2.89          | 0         | 702             | 3780       | 5.57 MiB     |
| **dom**      | **2.73**      | **688**   | 693             | **4885**   | —            |
| hb-atlas     | 3.30          | 0         | 786             | 4124       | 2.77 MiB     |
| **canvas2d** | **6.43**      | 0         | **1435**        | 4391       | —            |

**First, the question as asked: yes.** `contentUpdateHz` is **88–90 on all five arms in both runs**,
`gaps > 100 ms` is 0 everywhere, and HWUI jank is 0.00 %. Every mechanism here renders 14 px rotated
translating text inside a 90 Hz phone's frame budget, and the crisp ones are crisp at this density —
`hb-atlas` 0.004 and `hb-gpu` 0.017 Han at the matching ppem. So the question that survives is not
_whether_ but _at what cost_, and there the arms are not close.

Note that **`frameCostMs` p50 alone does not separate the top four** — 2.73 to 3.09 in `han`, 2.73 to
3.30 in `both`, with `dom` taking the lowest single p50 in the `both` run. All four are comfortably
inside an 11 ms frame, so the p50 has stopped discriminating and the columns that still do are CPU,
storage and startup. Only `canvas2d`, at roughly double, separates on frame cost at all.

### canvas2d loses, and only the phone could have shown it

**`canvas2d` is the most expensive arm on the phone by a factor of two** — 5.92 / 6.43 ms p50 against
2.79–3.30 for everything else — and the reason is in one cell: `mainThread cpu ratio` **0.963** and
**0.961**, over 143 and 159 tasks. Its main thread is essentially saturated, on 1784 / 1800 `fillText`
calls per measured window. Nothing else on the page exceeds 0.50.

This is the honest correction to how this document has been reading `canvas2d`. On the desktop it is
0.99 ms and the second-crispest arm at 14 px, with zero new code, zero wasm and zero VRAM — a sleeper
candidate that the round had been framing as a control rather than a contender, which was not a
framing the desktop numbers supported. **The phone supports it, for a reason the desktop could not
produce**: an RTX 2060 box has main-thread headroom to spare and a Mali-G615 phone does not, so the
one arm whose entire cost is per-frame CPU on the main thread is the one arm the desktop rung
flattered. It is also the arm that will degrade first as glyph count grows, because its cost is
linear in glyphs drawn with no batching anywhere.

### The DPR² prediction, measured on both rungs

This was the round's central architectural claim, and it is now measured rather than modelled. Same
arm, same `script=han` workload shape, the only difference being DPR 1 against DPR 3.4876:

| `script=han`              | desktop, DPR 1 | phone, DPR 3.4876 | growth    |
| ------------------------- | -------------- | ----------------- | --------- |
| `hb-atlas` bytes per cell | 1.58 KiB       | **12.54 KiB**     | **7.9×**  |
| `hb-gpu` bytes per glyph  | 5.35 KiB       | **5.42 KiB**      | **1.01×** |

**hb-gpu's Slug blobs cost 5.42 KiB a glyph on a phone with 12× the pixel density of the desktop that
measured 5.35 KiB** — the same number, within 1.3 %. That is Slug's architectural claim demonstrated
directly on both rungs rather than argued from first principles: a blob stores an em-space outline,
so pixel density is not one of its inputs.

The atlas grows **7.9×**, not the 12.2× that DPR² alone predicts, and the shortfall is worth naming
rather than rounding away: `ATLAS_PADDING` is a fixed **1 px per side per cell**, which is a much
larger fraction of an 18 px cell than of a 54 px one, so packing overhead amortises as cells grow. The
direction of the prediction held; the magnitude was 35 % smaller than the naive model, and only a
measurement was going to say that.

**The doctrine-clean version of the same fact needs no cross-rung arithmetic at all** — it is a ratio
between two arms measured **in the same run**, on the same rung, over an identical glyph set. Both
cells below are one `script=both` invocation each, five arms in sequence:

| `script=both`, hb-gpu ÷ hb-atlas storage | desktop (RTX 2060)       | phone (Mali-G615)         |
| ---------------------------------------- | ------------------------ | ------------------------- |
| hb-gpu                                   | 1 302 848 B              | 303 280 B                 |
| hb-atlas                                 | 1 515 524 B              | 2 908 164 B               |
| **ratio**                                | **0.86× (14 % smaller)** | **0.104× (9.6× smaller)** |

hb-gpu's storage advantage swings from _marginal_ to _an order of magnitude_ across the one variable
that separates a desktop from a phone. The phone's `script=han` run says the same thing from its own
single invocation — 494 368 B against 4 571 140 B, **9.2× smaller**.

### The phone's wasm heap, after the swap

Re-measured on the same device after `mountHbGpu` moved to `HbGpuFont.shape` — same phone, same
Chrome, same two configurations, battery 74 % and 26 °C with `thermalStatus none` before and after
both runs:

| phone, hb-gpu | before   | after        |
| ------------- | -------- | ------------ |
| `script=han`  | 3.15 MiB | **2.00 MiB** |
| `script=both` | 4.19 MiB | **2.00 MiB** |

**These are the same workloads, not merely the same flags**: both runs reproduced the documented
storage exactly — `atlasBytes` 494 368 B over 89 distinct glyphs for `han`, 303 280 B over 78 for
`both`, 8 runs each. Two different HarfBuzz builds encoding byte-identical outline sets is what makes
the heap column a like-for-like comparison.

**Only the heap row is comparable, and the reason is worth keeping.** The tables above come from a
five-arm invocation with a cold ANGLE program cache; these are one arm on a cache the desktop runs had
already warmed, so `initialRenderMs` (341 / 353 here against 409 / 428 there) and `programMs`
(64.2 / 60.2 against 138.6 / 134.3) are **not** measurements of the swap and are not carried into the
tables. `wasmHeapBytes` is this arm's own module heap read at mount, which no other arm's ordering can
touch — it is the one column a single-arm run may put beside a five-arm one.

(The desktop `script=han` pair in the blob table further up is not a single-run comparison: its
`hb-atlas` side is a perf run and its `hb-gpu` side is the offline encoder. The `script=both` rows
here are, which is why they are the ones the verdict rests on.)

### The verdict: hb-gpu

**At the density a phone actually has, `hb-gpu` is the mechanism to ship.** It is not the crispest arm
on Han — `hb-atlas` is, 0.004 against 0.017 at ppem 49 — and that is the one column it loses. It wins
or ties every other one:

- **cheapest per frame in the `han` run** (2.79 ms) and within 0.16 ms of the lowest in `both`, on
  **one draw call** — though as noted, the top four are indistinguishable on this column;
- **lowest total CPU across all processes** on both runs (3738 / 3755 ms, 1.49 core-equivalents),
  against `dom`'s 5205 / 4885 and `canvas2d`'s 4107 / 4391;
- **lowest main-thread busy** (681 / 704 ms) and the lowest main-thread cpu ratio on the page (0.384);
- **~9× the smallest GPU storage**, and the only arm whose storage does not grow with DPR at all;
- **crispest arm measured in the Latin band at ppem 49** (0.001) and the **best-aligned in both
  bands** (0.028 / 0.014 px);
- **zero LoAF blocked time**, against `hb-atlas`'s 162 ms and `hb-run`'s 134 ms of startup bake — both
  of which are a visible hitch on a phone;
- **resolution-independent**, so it survives a zoom, a scale or a non-integer destination. The baked
  arms do not: their crispness is conditional on a 1:1 blit, which is the fragility named at the top
  of this page.

The costs, stated rather than buried. **hb-gpu has the slowest startup on the page** — 409 / 428 ms to
`initialRender` against 126–152 ms for `dom` and `canvas2d` — and it is dominated by
`programMs` **138.6 / 134.3 ms** of shader link, not by its own work (encode 18.9 / 16.1 ms, upload
12.2 / 10.7 ms, shape ~10 ms). That link is driver-cache-bound and warms on repeat, and
`WebglShaderRuntime.warmPrograms` exists to move it off the critical path. It also carried the
largest wasm footprint, **3.15 / 4.19 MiB across two HarfBuzz copies** (harfbuzzjs to shape, hb-gpu to
encode) — an obvious consolidation, and one that has since been made and measured: **2.00 MiB in both
configurations**, in [The phone's wasm heap, after the swap](#the-phones-wasm-heap-after-the-swap).

**The consolidation exists, and the arm now uses it.** `hb-gpu.symbols` named none of the
shaping engine, so `-flto` and `--gc-sections` discarded it even though `harfbuzz-world.cc` always
compiled it; naming `hb_shape` and the `hb_buffer_*` API brings it back for **+190 KB** of binary
(227 → 417 KB) and puts `font.shape()` on the module, graded against npm `harfbuzzjs` glyph for
glyph and cluster for cluster on both fixture fonts. `mountHbGpu` shapes through it
(`shapeRunWithHbGpu` in `packages/perf-harness/src/scenarios/text-gpu.ts`), so the arm holds each
face **once** — the larger half of the 4.19 MiB above — and `wasmHeapBytes` is one module's heap.

**It was swept, on both rungs, and one of the two predictions was wrong.** The heap total did fall to
one module's — 4.50 → 2.00 MiB on the desktop, 3.15 / 4.19 → 2.00 MiB on this phone — and it stopped
varying with the script at all, because it is now `-sINITIAL_MEMORY` and the workload never reaches
it. Startup did **not** gain the 190 KB's fetch and compile: that binary was already the one being
loaded, so what the swap removed was a second module's instantiation, and desktop `initialRenderMs`
went **down** (70.3 against 186, back to back on one box). Every other column on this page — crispness,
storage, draws, quads — is byte-for-byte unchanged, which is the check that the two shapers agreed on
the real workload rather than merely in a test.

What the swap cost in guarantees, since it is not free: the arm no longer shares a shaper OBJECT
with `hb-atlas` / `hb-run`, so "the alignment guard grades the renderer, not two shapers" became a
claim about two HarfBuzz builds agreeing. It is asserted on S9's own run strings, at S9's font size,
through both code paths, by `packages/perf-harness/test/text-shaper-agreement.test.ts` — and by
`packages/hb-gpu/test/shape.test.ts` underneath it. The fidelity probe's own hb-gpu arm still shapes
with `harfbuzzjs`, so inside the probe the guard stays structural.

**When to prefer `hb-atlas` instead:** a fixed, known raster scale where maximum Han crispness is
worth ~9× the GPU storage and a 162 ms startup hitch. It remains an excellent mechanism and the
crispest thing measured on Han at every size. It is simply the one whose costs are the ones a phone
charges most.

**`dom`, the shipped path, is the most expensive arm in total CPU on the phone** (5205 ms `han`,
2.08 core-equivalents) and the only one paying raster — **910 ms** where every other arm pays zero —
while snapping to whole pixels (0.270 px residual) so it cannot translate sub-pixel. Replacing it was
the premise of the round, and the phone does not argue with the premise.

### What the phone did NOT measure

- **Crispness on the device.** The fidelity probe drives a local browser (`openLocalBrowser`), so
  every distortion number on this page is a desktop rung. The ppem 49 row is a faithful **proxy** for
  the phone's raster scale, not a measurement of the phone's rasterizer, and it is labelled that way
  where it appears.
- **Per-process GPU memory.** `gpu memory MB (driver)` on this rung is `dumpsys gfxinfo`, which is
  **whole-package HWUI** — it read 17.55–26.21 MB across repeats of a single arm, a spread wider than
  any difference between arms, and `window delta` is `—`. It is published because absent must never
  become zero, and it must not be read as a per-arm cost. The per-arm storage columns above are the
  arms' own counters (`atlasBytes` / `blobBytes`), which is why they are the ones quoted.
- **Anything above ~200 glyphs a frame on this device.** The viewport holds 8 cells, so the phone
  workload is 96 (`han`) / 208 (`both`) glyphs against the desktop's 1040. `canvas2d`'s saturation at
  1800 `fillText` calls is the arm most likely to move with that, and it is already losing.

The commands are in [Running it](#running-it), with this device's label counts as the worked example.

See `packages/perf-harness/src/scenarios/text-render.ts` for the scenario (S9),
`packages/hb-gpu/` for the Slug encoder, and `docs/perf-harness.md` for the harness doctrine these
measurements follow.
