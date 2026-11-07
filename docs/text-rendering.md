# Text rendering

How godot-scene-web draws text outside the DOM, and how the text instruments grade it. The
question the instruments answer: **can a renderer draw crisp text at 14 px, rotated 10°,
translating every frame, inside a mobile browser's frame budget?** The `html` package renders text
as rotated CSS boxes; the `canvas` package has a glyph path backed by `hb-gpu`.

**Two scripts, measured separately.** A 12-glyph Han run in Noto Sans SC and an ASCII pangram in
Roboto are stacked in every cell and in every fidelity still, because they are different problems:
Han is full-width, unkerned and unligatured over thousands of outlines; Latin is proportional,
kerned, and an alphabet of ~95 glyphs. Every crispness number is measured over one script's
**band** — the rows of the image that run occupies — against a reference cropped the same way.

**The mechanism is `hb-gpu`** — HarfBuzz's Slug encoder, which stores each glyph's outline as a
texel blob and evaluates coverage in a fragment shader. Nothing it holds grows with the device
pixel ratio: no atlas resolution, no phase grid, no baked rotation. That is why it suits
high-density phone screens, where an atlas that stores pixels grows with DPR².

Numbers from these instruments are comparable **within one environment only**: a SwiftShader box,
a desktop GPU and a phone GPU are three different environments, and every report names its own.

## Why a rotated textured quad looks fuzzy

A pre-rendered text texture drawn as a rotated quad is sampled bilinearly (`gl.LINEAR` for
`TEXTURE_MIN_FILTER` and `TEXTURE_MAG_FILTER`). Bilinear is invisible while the quad is
axis-aligned at 1:1, because every fragment centre lands on a texel centre and the four taps
collapse to one. **Rotate the quad by 10° and no fragment centre lands on a texel centre again**:
every output pixel becomes a weighted average of four texels, which is a low-pass filter applied to
a glyph edge that is one or two pixels wide to begin with. It is not a resolution problem and no
atlas size fixes it — the resampling happens after the atlas is read.

Two strategies avoid it:

- **Bake the rotation into the pixels** (the `hb-atlas` arm): snap the destination to whole device
  pixels and make design space equal framebuffer space, so the `LINEAR` sample becomes a 1:1 blit.
  This is crisp but fragile: any scale, zoom or non-integer destination re-introduces exactly the
  resampling it was built to avoid. This is why S9 **refuses** an over-subscribed layout instead of
  scaling the stage down to fit.
- **Re-rasterize at the requested transform** (`canvas2d`, `dom`, `hb-gpu`): resolution-independent
  by construction.

## The shipped path

`packages/canvas` has a `glyphs` draw command and a `GlyphPass` seam behind it, and the only
implementation of that seam is backed by `packages/hb-gpu`.

**It is one draw command in the same context, not an overlay canvas.** A glyph run interleaves with
quads in one draw list, so it gets real z-order, real clipping and the executor's own blending. The
executor flushes its pending batch under its own GL state, hands the run over, then re-binds its VAO
and program and invalidates its cached state — `emitGlyphsCommand`
([executor-webgl.ts](../packages/canvas/src/executor-webgl.ts)) is where that order is written
down, and it is the module's own flush-before-state-change rule applied to a whole foreign program.

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

`PPEM_FIDELITY_FLOOR` is 16, and `ppem` is `pixelsPerEm × the scale in run.m × devicePixelRatio` —
the size in **device** pixels, not CSS pixels. The middle factor is there because a caller's own
zoom, fit or hover scale rides the model matrix rather than `pixelsPerEm`: the shader sees that
scale (it derives ppem from `fwidth`), so the CPU-side gate has to see it too, or it reports a
comfortable size for text the shader is approximating. The pass reads it back out as the mean of
the two basis-vector lengths of `run.m`.

Below the floor, HarfBuzz's coverage shader takes a five-tap approximation (taps a third of a pixel
apart — a box filter by another name), and this path is **blurrier than the DOM text path it would
replace**. A phone rendering 14 px at DPR 3.5 is at ppem ~49 and never enters that branch; 14 px at
DPR 1 does, and there the DOM path or a baked atlas is crisper. The pass warns once on the console
below the floor and tallies every run in `stats.runsBelowPpemFloor`; it draws the text either way.

### Contrast and outlines

`HbGpuRendererOptions.contrast` defaults to `HB_GPU_CONTRAST_DEFAULT`
(`{ gamma: 1, stemDarkening: true }`). Raw linear coverage leaves a sub-pixel stem at mid-grey,
which reads as washed out next to browser text (gamma-correct blending plus stem darkening). The
fragment applies HarfBuzz's own `hb_gpu_stem_darken` to the final coverage:

```glsl
pow (coverage, mix (pow (2.0, brightness - 0.5), 1.0, smoothstep (8.0, 48.0, ppem)))
```

- `brightness` is `dot (u_color.rgb, vec3 (1/3))`, read per draw, so dark ink thickens and light ink
  thins in the same frame. `ppem` is `hb_gpu_ppem` (this renderer's coordinates are font units, so
  upstream's `1 / max (fwidth (v_texcoord))` would be off by `upem`).
- It ramps itself off: at and above ppem 48 the correction is exactly the identity.
- `gamma` is a plain exponent with no size or colour term, defaulting to 1 (skipped at that value).
- **Stem darkening is gated off on dilated (outline) draws.** Godot strokes outlines with
  FreeType's stroker at `outline_size / 4` and applies no contrast curve to them; darkening a rim
  would paint a halo outside the silhouette. A run drawn as an outline with no fill composited over
  it therefore gets uncorrected coverage.
- Fidelity probes and the `hb-gpu` perf arm pass `HB_GPU_CONTRAST_NONE`, because a probe grades a
  rasterizer against area coverage and an arm carrying a contrast curve would score the curve.

The DOM path matches Godot's outline reach with a CSS stroke: a stroke is centred on the contour,
so `cssOutlineSizeForFont` (`packages/html/src/text.ts`) emits `-webkit-text-stroke` width
`outline_size * 0.5`, whose outward reach is the `outline_size / 4` Godot draws.

### One HarfBuzz

`fillRun` shapes through hb-gpu's own wasm, which exports the OpenType shaper as well as the Slug
encoder, so a consumer holds each face once instead of loading npm `harfbuzzjs` as a second build
with a second heap. The lower-level pieces are still there — `slotFor` and a hand-built
`GlyphsView` — for a caller that has already shaped elsewhere; `GLYPH_SLOT_NONE` is what an inkless
glyph answers, and it must be skipped rather than given a slot.

## Limitations

- **ppem ≥ 16 for the hb-gpu glyph path.** `pixelsPerEm × scale × devicePixelRatio` below 16 is
  measurably blurrier than DOM text. Small text at DPR 1 is a reason to keep using the `html` path,
  not a bug.
- **Outline-only runs** are drawn without stem darkening (see above).
- **Baked arms (`hb-atlas`, `hb-run`) are measurement arms**, crisp only while the blit stays 1:1;
  they are not shipped renderers.
- Results do not carry across environments: compare runs from the same GPU, browser and DPR only.

## Running it

**`hb-gpu`'s wasm is checked in**, at `packages/hb-gpu/vendor/` — a vendored third-party binary with
its digests, provenance and license texts beside it in `packages/hb-gpu/vendor/VENDOR.md`. Nothing
has to be built to sweep the arm. To reproduce it (docker + emscripten; byte-identical if nothing
was bumped):

```bash
bash packages/hb-gpu/build.sh     # prints the wasm size and sha256
```

If the file is somehow absent the arm is **skipped and named** — the fidelity probe and a default
`perf` run both list it as NOT MEASURED with that command, and neither ever renders it as a zero. An
explicit `--mechanism hb-gpu` fails loudly instead.

```bash
# Crispness: 9 arms x 2 bands x 8 sub-pixel offsets, stills + metrics. Needs a display for Godot.
xvfb-run -a mise exec -- pnpm -w run text:fidelity

# Godot VRAM and draw calls, on the real GPU.
xvfb-run -a mise exec -- pnpm -w run godot:text-bench -- --all-variants

# Godot outline reference metrics (the fixture the hb-gpu outline is graded against).
xvfb-run -a mise exec -- pnpm -w run godot:outline-ref

# Browser frame cost, raster and CPU. The environment decides the answer here.
mise exec -- pnpm -w run perf -- --scenario text-render                        # SwiftShader
xvfb-run -a mise exec -- pnpm -w run perf -- --scenario text-render \
  --headed --env linux-chrome-nvidia                                          # real GPU

# Assemble whatever of the above exists into one browsable directory.
mise exec -- pnpm -w run text:report
xdg-open artifacts/perf/text-report/index.html
```

The arms: `reference` (the same geometry drawn at 8× and box-downsampled — a ceiling, not a
mechanism), `dom` (the shipped CSS-box path), `canvas2d` (`fillText`), `hb-atlas` (rotation and
sub-pixel phases baked into an atlas, blitted 1:1), `hb-run` (a whole run baked once, then rotated
and translated), `hb-gpu` (Slug coverage in a fragment shader), and three Godot arms
(`godot-default`, `godot-oversample`, `godot-msdf`).

S9's parameters (`--param name=value`): `script` (`both`, `han`, `latin`), `labels` (cells
mounted), `chars`, `glyphs` (distinct-glyph pool size, which drives atlas VRAM), `fontSize`,
`rotationDeg`, and the baked-arm isolations `phases`, `bakeRotation` and `bakeShaper`
(`harfbuzz` or `fillText`) — all three REFUSED on `hb-gpu`, which bakes no pixels. `outlinePx`
runs the other way: `hb-gpu` only, the dilation radius is half of it, 0 is fill only.

The baked arms' isolations take the same parameter name on both instruments:

```bash
xvfb-run -a mise exec -- pnpm -w run perf -- --scenario text-render --mechanism hb-atlas \
  --headed --env linux-chrome-nvidia --param bakeShaper=fillText
xvfb-run -a mise exec -- pnpm -w run text:fidelity -- --no-godot --bake-shaper fillText
```

So does the script axis:

```bash
mise exec -- pnpm -w run perf -- --scenario text-render --param script=han     # Han alone
mise exec -- pnpm -w run text:fidelity -- --no-godot --script latin            # Latin alone
```

The probe additionally takes `--font-size`; a size sweep is one run per size, each into its own
`--out` so nothing overwrites the comparison run:

```bash
mise exec -- pnpm -w run text:fidelity -- --no-godot --font-size 12 \
  --bake-shaper fillText --out artifacts/perf/probes/sweep/12-fillText
```

**On a phone, `labels` must fit the phone's own viewport, and you do not have to guess it.** S9's
stage IS the viewport — that is what keeps the glyph raster scale at the real device pixel ratio —
so it **refuses** an over-subscribed layout rather than overlapping the cells or scaling the stage,
and the refusal names the largest `labels` that fits. The run also prints the viewport it measured
before it mounts. Start from a small count and, if it refuses, re-run with the count the message
gives. Orientation changes the answer. `labels` is never auto-picked, because that would silently
change the workload between two runs that are meant to be compared.

```bash
mise exec -- pnpm -w run perf -- --scenario text-render --env device \
  --param labels=4 --baseline device-text-render
mise exec -- pnpm -w run perf -- --scenario text-render --env device \
  --param script=han --param labels=8 --baseline device-text-render-han
```

See [perf-harness.md](perf-harness.md#measuring-on-a-real-phone---env-device) for attaching a
phone.

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
screen are the actual pixels. **The zoom is in DEVICE pixels**: the CSS size is divided by
`devicePixelRatio`, so a zoom of _n_ is _n_ device pixels on every display. (At a fractional ratio,
sizing by CSS px alone would make some source pixels one device px wide and their neighbours two —
an uneven blocking over every arm.) The image is physically smaller at a fractional ratio, and the
zoom label names the ratio. Flip and diff carry the selected arm's own numbers in a panel beside
the image — the same pre-formatted cells the grid tables render, so the panel cannot disagree with
them.

Three implementation details are load-bearing rather than incidental:

- **The flip view stacks the arms and toggles opacity.** Swapping `img.src` tears down the old
  frame before the new one is decoded, and that blink is exactly what destroys an A/B comparison of
  two nearly-identical images. Nothing is added, removed or re-decoded when you change arms.
- **The offset axis _is_ a `src` swap**, because 6 arms × 8 offsets stacked at 16× would be ~700 MB
  of rasterised layers. It is safe only because a hidden pool paints every still at 1:1, so the
  bytes are already decoded and the swap is synchronous.
- **The diff is generated per offset against the reference _at that offset_.** A moved arm
  differenced against a still reference draws the translation, not the rasterizer. The control that
  proves the alignment: `diff-reference-*.png` is exactly zero at all eight offsets, so the
  subtraction itself is not introducing a difference.

Press `space` in the flip view to cycle the offsets. `edgeShimmer` says the crawl is there; this is
how you see it.

## Every metric reads one channel, and that channel is green

`dom` is the only arm Chrome draws with **LCD subpixel antialiasing**, and that is a property of the
shipped mechanism rather than of the instrument: `fillText`, the WebGL blit and Godot's rasterizer
all emit grayscale coverage; real DOM text on an opaque background does not.

**Averaging R, G and B on a subpixel-AA still is a ~1 px horizontal box blur**, because the three
channels sample the glyph a third of a pixel apart — so a luma metric would grade the measurement's
own channel averaging as blur of the `dom` mechanism. **Green samples coverage at the pixel
centre**, which is the same question asked of every arm, and on the greyscale arms it is identical
to luma.

**Disabling subpixel AA on the probe page** (`-webkit-font-smoothing: antialiased`) is rejected: it
would grade a `dom` arm that gsw does not ship. The mechanism keeps its antialiasing; the metric
stops averaging across it. `test/text-fidelity.test.ts` pins the channel with a one-pixel stem
whose fringes give an ideal acutance of 2.000 on green against 1.114 on a luma.

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
   (its `subpixelResidualPx` gives it away);
3. an arm too **blurry** to have edge structure to disturb (its `distortion` gives it away).

So the row is read next to `distortion` and `subpixelResidualPx`, or not at all. `phases=1` makes
the point sharpest: it cannot move sub-pixel at all, so it shimmers least.

## Every arm anchors the same baseline

The probe draws each arm with its alphabetic baseline exactly `fontSize` px below the run box's top
edge. This is a normalisation, not a rendering choice: the probe measures **rasterization**, and
left to their own conventions the three engines put the same run in three different places.

- canvas `textBaseline: "top"` pins the em top;
- a CSS line box puts the baseline at `half-leading + ascent`;
- Godot's `Label` uses its own ascent.

**None of that can be derived from the font, and it is a different number per face** — a face's
`hhea` and `OS/2` typo metrics can disagree enough to predict half-leadings of opposite sign. So
each arm is _asked_ where its baseline is, **once per face**: the browser arms via a zero-height
`inline-block` with `vertical-align: baseline` (which sits exactly on the line box's baseline)
measured on an **unrotated** element, and Godot via its own `font.get_ascent()` reproduced from
`label.cpp`, taking the run's own `FontFile`. S9 measures the shipped DOM's answer and publishes
both: `baselinePx` for Noto Sans SC and `baselineLatinPx` for Roboto.

Both faces share one run-box height (`fontSize × 1.35`) and one baseline rule, which is checkable
rather than lucky: Roboto's descender is 0.244 em against the 0.35 em the box leaves below the
baseline. `test/latin-fixture.test.ts` asserts it against the real subset file.

Rules that follow from it:

- **Godot rotates about the browser's pivot.** `Control.set_size` clamps to the combined minimum
  size, and `Label`'s minimum is its own measurement of the text, so `pivot_offset` must not be read
  back off `label.size`.
- **Phases only make sense for a draw that snaps to whole device pixels**; an unsnapped draw must
  bake at offset zero. `BakeOptions.snapped` says which, explicitly.
- **`probeLayout` rounds each run box's origin**, because `dom` snaps its text origin to whole
  device pixels. The sweep is where sub-pixel phases belong, not the rest position.

### Measuring alignment: correlation, not centroids

**It is not a centroid difference.** A centroid moves when an arm is displaced, but it also moves
when the arm merely _redistributes_ ink — and every arm redistributes ink relative to an 8×
reference whose per-glyph advances round differently. A guard that cannot tell a blurrier arm from
a displaced one would accuse every candidate mechanism.

**Nor is it a parabola through the correlation peak's integer neighbours.** That is the textbook
sub-pixel refinement and it peak-locks: exact at the half-pixels and wrong at the quarters. What
works is sampling the reference _between_ texels and scanning, with the correlation normalised —
otherwise the estimator notices that fractional sampling blurs slightly and locks straight back onto
the integers. The estimator is calibrated on the probe's eight reference stills, which are
independent 8× renders at known offsets (56 ordered pairs with a known answer).

The allowance is `0.25 px + 0.65 × distortion`. 0.25 is more than twice the estimator's worst-case
noise. The second term corrects its one known bias: normalised correlation slightly prefers the
smoothing that fractional sampling introduces, so an arm blurrier than the reference reads a small
spurious offset. 0.65 is deliberately the low end of the measured ratio — an over-generous
allowance would silence the guard on exactly the soft arms it is watching. Arms _sharper_ than the
reference get none at all, because the bias does not apply to them.
