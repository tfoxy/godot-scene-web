# Perf harness

`@godot-scene-web/perf-harness` is an **A/B instrument**: it compares rendering _mechanisms_ on
measured numbers, driven by a locally launched headless Chrome over raw CDP.

The primary artifact is a **comparison table**, not a regression gate. It answers "which of these
three ways of drawing the same thing is cheapest, and where does the cost actually go?" — not "did
this commit get 3% slower".

## Running it

```bash
# the whole comparison: every mechanism the scenario declares, medians over 5 repeats
mise exec -- pnpm perf -- --scenario atlas-sprites

# one mechanism, throttled to roughly phone-class CPU
mise exec -- pnpm perf -- --scenario atlas-sprites --mechanism page-crop --cpu-throttle 6

# re-print the table from a finished run
mise exec -- pnpm perf -- compare artifacts/perf/runs/<timestamp>

# check a scenario's RELATIONAL gate — measures a run, then checks the ratios between arms
mise exec -- pnpm perf -- assert --scenario ancestor-rescale
# ...or re-check a finished run without touching Chrome
mise exec -- pnpm perf -- assert --scenario ancestor-rescale artifacts/perf/runs/<timestamp>

# check an envelope (the sibling repos shell out to this)
mise exec -- pnpm perf -- validate-report artifacts/perf/runs/<timestamp>/atlas-sprites-page-crop.json

# serve the scenario pages and stay up, so an external browser can look at them
mise exec -- pnpm perf -- --serve

# capture one trace, CHECK THE ANALYZER'S MATCHERS against it, print its event-name histogram
# (do this FIRST on any new Chrome, and always before trusting a phone number)
mise exec -- pnpm perf -- --dump-trace-names

# the same scenario, on a real Android phone over adb
mise exec -- pnpm perf -- --env device --scenario atlas-sprites
mise exec -- pnpm perf -- --env device --dump-trace-names

# canvas vs <img> for finished surfaces — static, then with an occasional update
mise exec -- pnpm perf -- --scenario static-surfaces
mise exec -- pnpm perf -- --scenario static-surfaces --param updateEveryMs=2000 --duration 6000

# would WebGPU help? the WebGL reference arms, then the WebGPU probe arms (SEPARATE invocations:
# a ready() failure on one arm aborts the whole run — see Scenario S7)
mise exec -- pnpm perf -- --scenario effects-webgpu --mechanism particles-webgl,shaders-webgl
mise exec -- pnpm perf -- --env device --scenario effects-webgpu --baseline device-effects-webgpu

# text crispness instrument (not a scenario, not a perf-report — see docs/text-rendering.md)
xvfb-run -a mise exec -- pnpm -w run text:fidelity

# DRIVER-attributed VRAM: headed on the real GPU (headless is SwiftShader and the sample gates itself
# off there), plus the optional self-counted cross-check
xvfb-run -a mise exec -- pnpm perf -- --scenario atlas-sprites --headed --env linux-chrome-nvidia
xvfb-run -a mise exec -- pnpm perf -- --scenario atlas-sprites --headed --memory-dump
```

Chrome is resolved from `GSW_PERF_CHROME`, then the newest
`~/.cache/ms-playwright/chromium-*/chrome-linux64/chrome`, then `/snap/bin/chromium`. There is
deliberately **no Playwright dependency**: a perf harness must never be blocked on a browser
download. If you do fall back to snap chromium, note it is confined — the profile directory must stay
inside the repo (`artifacts/perf/chrome-profile/`), never under `/tmp`.

Everything the harness writes lands under `artifacts/perf/`, which is ignored. The generated atlas
page is ~15 MB; it is cached and regenerated only when missing.

## The two things this harness exists to say

### 1. Swap rate is not fps

The compositor will happily swap at 87–90 Hz while the user watches half-second freezes, because it
keeps re-presenting _the same content_. The rate at which **new content** is activated is a different
number entirely, and it can be a third of the swap rate.

So:

- `contentUpdateHz` — `ActivateLayerTree` rate. **This is the frame rate.**
- `swapRateHz` — `DrawFrame` rate. Reported, labelled, and never called fps.
- `activationGapMs` — the distribution of gaps between activations, plus a count of gaps over 100 ms.
  A good p50 with three 400 ms gaps is a page that stutters, and only the gap row shows it.

`initialRenderMs` follows the same rule: it is measured from the mount mark to the first
`ActivateLayerTree` at or after the ready mark. Never from a rAF callback, which fires when the frame
was _requested_, not when content was _presented_.

When `contentUpdateHz` moves, check `swapRateHz` before blaming the code: a variable-refresh panel
that drops to 60 Hz moves both together, and a real regression moves only the first.

### 2. Image decode dominates and is invisible to JS

Decode runs on decode worker threads. It never appears in a rAF timer, a `performance.now()` delta or
a user-timing mark, so if you do not read it out of the trace you do not measure it at all. An image
that exceeds the discardable decode cache can decode **inside raster**, i.e. be re-paid on every
re-raster forever.

The cause class is specific: **small elements whose display lists reference large source images.** Any
ancestor scale change re-rasters, and the re-raster re-decodes the full source. `paint.maxSourceMegapixels`
and `paint.maxSourceToPaintedRatio` measure exactly that shape (a 4096×4096 source painted into a
96×96 box is a ratio of 1820).

`decode.inRasterCount > 0` is a **hard failure**, not a slow number, and the table prints it as one.

## Metrics

Full field list and aggregation rules: [perf-report-contract.md](perf-report-contract.md).

Two that are easy to misread:

- **`mainThreadCpuRatio`** = `tdur/dur` over long tasks. A 500 ms task with 20 ms of CPU is the main
  thread _parked_ (blocked on commit, raster or decode), not computing. The two demand opposite
  fixes, and the wall-clock number alone cannot tell them apart. The biggest main-thread "task" is
  often `LayerTreeHost::WaitForCommitCompletion`, which is pure waiting.
- **`layerCount` / `renderSurfaces`** are comparable **within an environment only**. Do not compare a
  headless SwiftShader layer count against a phone's.

## CPU and GPU: `cpu` and `gpu`

The analyzer attributes CPU across **every traced process** — renderer, browser and GPU — not only
the renderer that emitted the scenario marks. The trace carries `tdur` (thread CPU) for every traced
process, so this needs no extra transport.

### `totalCpuMs` is a LOWER BOUND, and the tooling says so everywhere

`tdur` is CPU spent **inside a traced task**. Anything in a category this capture did not enable, and
every process Chrome did not instrument, counts as zero. So the totals are a floor on real CPU, and
`totalCoreRatio` is **not** a `top`-style CPU%.

The field docs, the contract and the table all say so, and the affected rows are labelled `(>=)`.
`cpuCoverage` is the check on the caveat: the share of summed top-level **wall** time that carried a
`tdur` at all. A thread with high wall and low coverage has **unknown** CPU, not zero. At `1.000` the
floor is tight.

Attribution is what the block is really for, and it is per thread across every process:

```
  page-crop  —  total 1006 ms cpu over a 2507 ms window (0.4016x one core), coverage 1
      process/thread                               cpu ms    wall ms     core    n
      Renderer/ThreadPoolForegroundWorker             670       1454   0.2673   10
      Renderer/Compositor                             101        121  0.04026    1
      Renderer/CrRendererMain                       88.78        591  0.03542    3
      GPU Process/VizCompositorThread               85.87      94.55  0.03425    1
```

Here the main thread holds 591 ms of **wall** but 88.78 ms of **CPU** — parked — while the raster
workers burn 670 ms of real CPU across ten threads.

Rows fold by the `(process, thread)` name pair rather than `pid:tid` (`n` = how many OS threads were
summed), because a phone with many background tabs has many renderer processes and one story.

### `gpu`, and `--no-gpu`

`--scenario …` collects `gpu`, `viz`, `disabled-by-default-gpu.service` and
`disabled-by-default-skia.gpu` by default and reports GPU-process cost bucketed by op. `--no-gpu`
turns that off: `gpu.available` becomes `false` — **not measured**, never "the GPU did nothing" — and
the CPU block is untouched, because `cpu.byProcess.gpu` comes from `tdur` on the same `toplevel`
tasks either way.

`--no-gpu` is protective, not cosmetic. `disabled-by-default-skia.gpu` emits an event per draw op, so
the GPU categories grow the trace, and a trace-buffer overflow truncates a capture into something
that reads as an idle page. The harness therefore reads `Tracing.tracingComplete.dataLossOccurred`,
and a repeat Chrome admits it truncated is **DISCARDED** with that reason (and a pointer to
`--no-gpu`) rather than analyzed.

**GPU numbers are comparable within an environment only**, exactly like `layerCount`. A headless
linux run is SwiftShader — a software rasteriser, no hardware GPU — so `gpu.hardware` reads
`swiftshader` there and names an ANGLE GPU on a phone, and the table header repeats the warning next
to the hardware names.

The buckets (`uploadDecode`, `rasterPlayback`, `skiaPrepare`, `skiaExecute`, `presentSwap`, `clear`,
`schedulerIpc`, `other`) are name-matched. **`topUnbucketedOps` is always printed**, so nothing hides
behind the taxonomy. SwiftShader composites through `SoftwareRenderer`, so there its skia-GPU
buckets are genuinely 0.00 and most GPU-process CPU shows up as unbucketed
`SoftwareRenderer::DoDrawQuad`.

### `gpu.device.gpuMemoryBytes` — the DRIVER's byte, not ours

Every other GPU-memory figure in this repository is **self-counted**: the texture cache's own total,
Godot's `RENDER_TEXTURE_MEM_USED`, Chrome's memory-infra allocators. `gpu.device.gpuMemoryBytes` is
what the **driver** says the process is holding, so a mechanism's texture cost can be checked rather
than believed. Two sources produce it, and `gpu.device.source` always names which:

| `source`            | where                     | command                                      |
| ------------------- | ------------------------- | -------------------------------------------- |
| `"dumpsys-gfxinfo"` | `--env device`            | `adb shell dumpsys gfxinfo <chrome package>` |
| `"nvidia-smi"`      | desktop **headed** NVIDIA | `nvidia-smi -q -x`                           |

Both are sampled at the SAME out-of-band bracket (`CaptureOptions.window`), best-effort: **a failure
to read GPU memory must never fail a measurement**.

#### Attribution is the whole feature

`nvidia-smi -q -x` reports a box-wide `<fb_memory_usage><used>` **and** a per-process list. The
box-wide figure is never read: it carries the desktop shell, editors and other browsers. The bytes
come from the GPU process(es) that **descend from the Chrome the run launched**: `PerfBrowser.pid`
(`null` on device, where `dumpsys` answers instead), a `/proc` `{ pid, ppid, cmdline }` table (ppid
read **after the last `)`** of `/proc/<pid>/stat`, since `comm` may contain spaces), and a
**transitive** descendant walk filtered by `--type=gpu-process` — transitive because Chrome forks
children off a zygote, summed because Chrome can briefly run a second GPU-info process. **No match
means `null` — NOT MEASURED**, never 0.

#### Absolute and delta, and which one answers what

Both are reported. The **absolute** (`gpuMemoryBytes`, read after the window) is the honest total but
carries Chrome's fixed cost — a headed GPU process holds framebuffers, UI tiles and a shader cache
before the page mounts anything — so it cannot price a scenario. The **delta**
(`gpuMemoryDeltaBytes`) can: the bracket spans mount plus the measured window, which is when a
scenario uploads its textures.

The delta is the fragile half. **The driver reports whole MiB**, so anything under ~1.05 MB is below
the instrument, and where a texture upload falls relative to `ready()` can move between runs. Read a
delta as evidence about one run; a VRAM claim needs repeats.

#### `--memory-dump`: the cross-check, OFF BY DEFAULT

`--memory-dump` adds `disabled-by-default-memory-infra` and requests a detailed, deterministic dump at
the same bracket, reporting the delta on `gpu/gl/textures`, `gpu/shared_images` and
`skia/gpu_resources/*`. It reads **`size`, never `effective_size`**, which deduplicates a shared
allocation across processes and would report 0 for a texture the renderer owns and shares into the
GPU process. It is a self-counted CROSS-CHECK: **where it disagrees with the driver, the driver is
the truth**. An allocator a Chrome build does not emit prints `—` (NOT MEASURED, not zero).

## Methodology (non-negotiable)

- Fixed viewport and device pixel ratio **on `ci`**. On `--env device` the phone is measured at its
  OWN viewport, orientation and DPR, and the scenario's stage is fitted into it — see
  [Viewport and fit](#viewport-and-fit). Either way the geometry is recorded in `env.geometry`, and
  two runs at different fit scales are not comparable on decode/raster.
- Seeded fixture data — the atlas page is a pure function of its seed, byte-identical on regeneration.
- 1 warmup repeat, **discarded**.
- 5 repeats, **medians** reported (means let one bad repeat move the number).
- **A fresh browser context + target per repeat**, and a per-repeat cache-busted image URL. Chrome's
  decoded-image cache survives navigation, so reusing a page silently erases the cold-decode number
  this whole harness exists to measure.
- The page is served over real `http://` from an in-process `node:http` server. Not `data:`, not
  `about:blank` — image decode and HTTP caching behave differently there, and that is what is being
  measured.
- Every run ends with a screenshot presence check (below).

### The presence guard

The #1 failure mode of a perf harness is **measuring a blank page and reporting excellent numbers**.
No content means no paint, no raster, no decode — which looks like a spectacular win.

So after the measured window the harness takes a `Page.captureScreenshot`, decodes it, and computes:

- `nonEmptyRatio` — fraction of pixels that differ from the page background;
- `sampleHits` — for each mounted sprite's expected centre point, whether that pixel is non-background.

A repeat with `sampleHits < mounted` is **discarded and listed in `failures`**, never averaged in.
The atlas generator guarantees an opaque core at the centre of every region precisely so this check
cannot produce false misses on hollow shapes.

## Scenarios

Every scenario follows the same rule: the **mechanism is a parameter, never a forked copy of the
scenario**. Geometry, node count, animation and sample points are identical across arms, so any
difference in the numbers is the mechanism and nothing else. Where an arm stands for shipped
behaviour it mounts the **shipped code** — measuring a re-derivation would measure the wrong code.

Scenarios S2, S5, S6, S7 and S8 deliberately have **no `perf assert` gate**: a relational gate is
written FROM readings on the device that matters, not from desktop intuition.

## Scenario S1: `atlas-sprites`

100-region atlas on a 4096×4096 page (real atlas pages reach that size, so a realistic page size is
the point), 50 sprites mounted, 10 of them advancing their region index every frame — the "intent
icon" shape.

- **`region-blob`** — bake each region once via `OffscreenCanvas` → `convertToBlob` →
  `URL.createObjectURL`; a `<div>` with `background-image: url(blob:…)`.
- **`page-crop`** — a `<div>` with `background-image: url(<whole page>)`, cropped by CSS through
  gsw's **shipped** `regionBackgroundStyle` (`packages/html/src/textures.ts`).
- **`canvas`** — `createImageBitmap(page)` once, then per-node `<canvas>` + `drawImage`.

Only `page-crop` awaits nothing more than the network fetch before declaring ready — its cost is
deliberately left in paint and decode, where the mechanism really puts it. The other two must fully
decode the page to build an `ImageBitmap`, so their cost is JS-visible and lands in `readyMs`. That
split between `readyMs` and `initialRenderMs` is the point of having both.

### The `scaleDiversity` isolation (S1 and S2)

`page-crop`'s decode cost is two effects wearing one coat: **one big page**, and **many distinct
scaled decodes of that page**. Each sprite's box is a fixed 96×96 while its region rect is not, so
every sprite implies its own `background-size`, and Chrome keeps a separately-scaled decode per
distinct size.

`scaleDiversity` separates them by changing the **fixture**, not the DOM: `per-region` (default)
insets each region by a per-region jitter, so every sprite implies its own `background-size`;
`shared` makes every region exactly one grid cell, so every sprite resolves to the SAME
`background-size`. The sprite geometry is byte-identical either way, and `shared` gets its own
fixture cache stem, so a run can never silently measure the jittered page.

S3 has the same isolation on its own axis: `nodeSizing=uniform` gives all 20 nine-patch nodes one
size (one scaling of the sheet) against `varied`'s 20 (twenty scalings).

## Scenario S2: `ancestor-rescale`

S1's scene, unchanged, re-scaled 1.0 → 1.2 → 1.0 from JS **every frame** for the whole measured
window — the card-focus / hover-tip / view-scale shape that causes activation stalls and repeated
decodes of large atlas pages. It is **the harness's own acceptance test**: if the instrument cannot
reproduce an independently traced hazard, it is not measuring the right thing.

Params: `focusPeriodMs`, `focusRampMs`, `focusScale`, and `driver`, because the mechanism matters
more than the curve:

- **`js-layout`** _(default)_ — box sizes and positions in CSS px, so `regionBackgroundStyle`
  re-derives a new `background-size`, as gsw's own view-scale does (`scaleStyleRecord`).
- **`js-transform`** — `transform: scale()` written on an ancestor from a rAF callback.
- **`css-transition`** — the same curve as a compositor-driven `@keyframes` animation: the control.

A CSS transition alone would measure nothing: the compositor re-uses the tiles it already
rasterized. Driving the scale from JS forces the paint → raster → decode chain, which is the point.

**The software decode cache cannot show the stall.** Headless/SwiftShader's software cache
re-scales an existing decode instead of re-running the codec, so the activation-gap symptom only
appears on the GPU decode path (a real GPU, e.g. a phone). That is why one `perf assert` relation is
skipped there — see [below](#the-one-relation-that-is-skipped-and-why-it-is-skipped-rather-than-dropped).

## Scenario S3: `nine-patch-atlas`

20 nine-patch nodes, 9 slices each, over ONE 4096² sheet, mounted and then rescaled on the same
1.0 → 1.2 curve as S2. Params: `patchMargin`, `sheetSize`, `nodeSizing` (`varied` | `uniform`).

gsw's shipped nine-patch path for an **external** texture URL (`packages/html/src/textures.ts`, the
`if (ninePatch)` block) emits `border-image-source: url(<the whole sheet>)` with a per-node
`border-width` and `border-image-slice … fill`. Every nine-patch node's display list therefore
references the **full sheet**, and the browser scales that sheet into that node's box — so two
differently-sized nodes are two differently scaled draws of one 16 MP image.

The `gsw-nine-patch` arm does not re-derive that CSS. It authors the scene as real `.tscn` text and
runs it through the shipped chain — `parseGodotTextScene` → `deriveSceneGraph` →
`resolveGodotSceneTree` → `renderSceneToHtmlModel` → `mountHtmlScene` — so the DOM under measurement
is the DOM the library produces.

Arms: **`gsw-nine-patch`** (the shipped `border-image` path), **`slice-blob`** (nine slices baked
once per node at destination resolution, nine `<span>` backgrounds) and **`canvas`** (one `<canvas>`
per node, nine `drawImage` calls from one `ImageBitmap`).

The sheet is the **opaque** generated fixture, not the sprite atlas: a nine-patch stretches its centre
slice across the whole node, and an atlas page's transparent gutters would land under the presence
guard's sample points and report a perfectly good render as a blank page.

## Scenario S4: `large-image-coexistence`

One 2520×1080 opaque background (`bgWidth`) — a host-rendered static background — beneath S1's
sprite grid, with a strip of unrelated content (`churn`) repainted every frame.

The question is not what the image costs to decode once. It is whether anything makes us pay for it
**again**. Each half of the claim is measured differently, because Chrome only gives you one of them
per image:

- **not re-decoded** — `decode.redecodeCount` and `decode.inRasterCount`. Run-wide: cc keys decodes
  by an opaque pixelRef/content id that carries no URL, so a `0` proves the background decoded once,
  and a non-zero total cannot be attributed. Add `--param mounted=0 --param animated=0` for the
  unambiguous version — with no sprites the background is the only image in the trace.
- **not re-painted** — `watchedImage.paintCountInWindow`. `PaintImage` is the only url-bearing event
  in a Chrome trace, so this is the one honest per-image signal that exists. A record inside the
  measured window means the display list was re-recorded with the background in it, which is what
  precedes a re-raster.

## Scenario S5: `static-surfaces` — canvas vs `<img>`, once the drawing is finished

The WebGL effects runtime renders static shaders and particle systems into a per-node `<canvas>`:
one shared WebGL canvas produces a frame, and each node owns a 2D canvas whose entire job is a single
full-canvas `drawImage` of it (`packages/html/src/webgl/runtime.ts`). The alternative is an `<img>`:
bake the finished frame to a blob once and let the browser treat it as an ordinary image.

The question is **steady state**: once both a canvas surface and an `<img>` surface have finished
rendering, and the DOM has to render other things, which one holds frame rate? Setup cost appears
only as `readyMs`.

24 finished 128×128 surfaces, all cut from one shared source canvas, with 24 unrelated cells
repainted every frame beside them.

Arms: **`canvas-2d`** (per-node `<canvas>` + 2D context + `drawImage`, the shipped path),
**`canvas-bitmaprenderer`** (`ImageBitmapRenderingContext` + `transferFromImageBitmap`),
**`img-webp`** (encode once → blob URL → `<img>`), **`img-png`** (the same, PNG — what the shipped
baker emits) and **`img-worker-webp`** (the WebP encode on a worker pool).

Params beyond `mechanism`: `churn`, `alpha`, `overlap`, `regions`, and

- `updateEveryMs` — the second axis. `0` is the strictly-static case: `step()` touches only the churn
  strip and the surfaces are never redrawn. A non-zero value regenerates each surface on that
  cadence, staggered — the canvas arms redraw, the `<img>` arms must **re-encode**.
- `bakeWorkers` — the worker-pool size for `img-worker-webp`.
- `serialBake` — bake one surface at a time instead of concurrently.
- `sharedFrames` — every surface shows **one** frame. The trace then counts codec runs
  (`codecRuns`, `distinctImages`): 24 nodes showing one blob URL decode it once (the count includes
  the atlas page the frames are cut from). `presented.nonEmptyRatio` changes when every surface
  shows the same frame, so a `sharedFrames` run is comparable only to another `sharedFrames` run.

## Scenario S6: `effects-runtime` — is it the CPU sim?

A particle frame is **four** things: the CPU simulation
(`packages/effects/src/particles/simulate.ts`), the instance-buffer build, the instanced GL draw, and
the GL→2D blit onto the node's canvas — plus whatever it costs merely to keep N composited canvases
on screen. S6 separates them **by construction**, with four arms over the **shipped runtimes**
(`createParticleRuntime`, `createWebglShaderRuntime` from `packages/html`): 12 systems of 64
particles (`systems`, `cellPx`), one per 96 px cell, beside a small strip of DOM cells recoloured
every frame. Other params: `simCapHz`, `overLife`, `blend`, `fps`, `pacing`, `renderScale`, `churn`.

- **`particles-live`** — sim (fixed 30 Hz) + instance build + instanced GL draw + blit: the real
  thing.
- **`particles-simcap`** — the **identical spec** at `fixedFps: simCapHz` (default 1): one sim step
  per second, every particle still alive, draw path byte-identical. `live − simcap` is the CPU sim.
- **`particles-frozen`** — the identical spec with `staticParticles: true`: each system is drawn
  **once**, then the loop parks. The compositing floor.
- **`shaders-live`** — the WebGL shader runtime at the same cell count and **canvas pixel count**,
  running a `TIME`-driven shader: GL draw + blit, no CPU sim.

What each arm has to prove:

- `particles-simcap` draws the same picture **and the same number of particles** as
  `particles-live` (`test/scenarios.test.ts` asserts the specs differ only in `fixedFps`).
  `lifetime` is 32 s so that a 1 Hz cap does not leave slots momentarily dead.
- `particles-frozen` really parks; the churn strip keeps layer activations flowing so the validator
  does not reject a correct frozen run as "nothing was measured".
- `shaders-live` has the same pixels: its node box adds the runtime's own canvas pad
  (`spriteExtentPad + emissionExtentPad`, imported), and its shader reads `TIME`, because the shader
  runtime only re-renders a program that `usesTime`.

### The verdict arithmetic

```
CPU sim         ≈ (live − simcap) × 30 / (30 − simCapHz)
draw pipeline   ≈ simcap − frozen          (instance build + instanced GL draw + blit)
compositing floor ≈ frozen                 (N canvases on screen, nothing redrawing them)
shader tick     ≈ shaders-live − frozen    (GL draw + blit at the same canvas pixel count)
```

The `simcap` arm runs the sim `simCapHz`/30 as often, so the difference has to be scaled back up. If
`CPU sim` dominates `draw pipeline`, the fix is the simulation (fewer particles, a lower `fixedFps`,
a worker); if `draw pipeline` dominates, it is the canvas/blit path and `renderScale`; if
`shaders-live − frozen` is close to `simcap − frozen`, particles and shaders cost the same to draw.

Read the main thread (`cpu.byThread`'s `Renderer/CrRendererMain`), not `frameCostMs.p50`, which is
bimodal with a 30 Hz sim at 60 Hz. Desktop is SwiftShader, where the GL half is CPU work that does
not exist on a real GPU, so `--env ci` is a smoke test. The page paints no images and carries one
8×8 PNG canary for `decode.count > 0`: `decode tasks: 1` is the scenario, not a broken matcher.

### The `scenario.*` counters

S6 turns on `effectsProfiling`, so both runtimes attribute each tick's main-thread cost to their own
buckets (`ParticleProfile` / `ShaderProfile`), reported as `scenario.<key>` rows. Everything is a
**window delta** (snapshotted on the first `step()`) except the two marked _life_:

- `particleDraws` — `drawBinding` calls that reached `drawParticles`; `particleCacheHits` — frozen
  static-frame cache hits;
- `simSteps` — fixed sub-steps executed, **the** sim work unit; `instances` — particles pushed into
  the instance buffer ≈ particles drawn;
- `simMs` / `buildMs` — CPU sim / instance build; `glMs` / `blitMs` — GL submit (issue cost, never
  GPU time) / the GL→2D blit;
- `profTicks` / `profBindings` — loop ticks that did work, and bindings summed across them;
  `shaderDraws` / `shaderCacheHits` — the shader runtime's equivalents;
- `renderedNodes` _(life)_ — bindings that have ever drawn (`ready()`'s gate); `boxReads` _(life)_ —
  forced `clientWidth` layouts on the create path.

Keys are **per arm and never zero-filled**: an absent key means "not measured". The counters must
show `particles-frozen` parked (`profTicks` 0, `particleDraws` ≈ 0), `particles-simcap` capping the
sim **only** (`simSteps` ≈ `systems × simCapHz × windowSeconds` while `particleDraws` keeps display
rate), equal `instances / particleDraws` on the live and simcap arms, and `boxReads` 0.

### Running it

```bash
mise exec -- pnpm perf -- --scenario effects-runtime                         # all four arms
mise exec -- pnpm perf -- --env device --scenario effects-runtime            # on a phone
mise exec -- pnpm perf -- --env device --scenario effects-runtime --param fps=30         # an FPS cap does not buy back the sim
mise exec -- pnpm perf -- --env device --scenario effects-runtime --param overLife=none  # cost of the ramp/curve chain
mise exec -- pnpm perf -- --env device --scenario effects-runtime --param blend=1        # additive accumulate+resolve
mise exec -- pnpm perf -- --scenario effects-runtime --mechanism particles-live --duration 6000
```

## Scenario S7: `effects-webgpu` — would WebGPU help?

The shipped WebGL effects pipeline is one shared offscreen WebGL canvas → a `ctx2d.drawImage` blit
per node → N composited canvases. S7 asks, separately: does **WebGPU** cut the main-thread submit
cost, and does rendering **directly into N canvases**, with no blit, relieve the GPU process?

**PROBE, NOT PRODUCT.** S7 carries its own WebGPU renderer (all of it in
`packages/perf-harness/src/scenarios/webgpu/`), to price an architecture before writing it.
Everything above the renderer is shipped code, imported: `simulateParticles` /
`preprocessParticles`, the `InstanceBuffer` packing at `INSTANCE_STRIDE`, `backingStoreSize` /
`effectivePixelRatio` for canvas sizes, and S6's geometry, spec, churn strip and canary. Params:
`systems`, `cellPx`, `overLife`, `blend`, `fps`, `renderScale`, `churn`.

- **`particles-webgl`** — shipped `createParticleRuntime`: shared GL canvas → blit → per-node 2D
  canvas. The in-session reference.
- **`particles-webgpu`** — WGSL port, imported sim + packing, drawn **directly** into each node's
  own `GPUCanvasContext`: the API and the missing blit together.
- **`particles-webgpu-blit`** — the identical WGSL pipeline into one shared WebGPU canvas (N
  `setViewport` sub-rects in one pass) → the same N `drawImage` blits: the shipped architecture with
  only the API swapped. This arm makes the table decomposable.
- **`shaders-webgl`** / **`shaders-webgpu`** — the shipped shader runtime against a WGSL port of
  `EFFECTS_SHADER_SOURCE` drawn directly: the same pair with no simulation.

What each arm has to prove: the **same pixels** (`test/effects-webgpu.test.ts` holds S7's geometry
and sizing against S6's and `backingStoreSize`); the **same particles** (S6's `effectsSpec`, every
arm uncapped at `fixedFps: 0`); the **same bytes** (`packSystem` against the shipped build loop,
element by element); the **same shader** (every float literal of `EFFECTS_SHADER_SOURCE` must appear
in `SHADER_WGSL`); and **the shape its name says** — direct arms N passes and 1 submit per tick, the
blit arm 1 pass, 1 submit, N blits.

**Premultiplied alpha.** A `GPUCanvasContext` offers only `"opaque" | "premultiplied"`, so every
WGSL and GLSL fragment writes `(rgb·a, a)` under `one / one-minus-src-alpha` on colour and alpha
(the WebGL shared canvas declares `premultipliedAlpha: true`). The wrong pairing double-multiplies
or halos without any error, so `PREMULTIPLIED_BLEND` is asserted together with the WGSL sources and
`test-harness`'s composite Xvfb tests check the result through the real page compositor.

Counters: `simMs` / `buildMs` / `simSteps` / `instances` (identical imported code on every particle
arm); `glMs` (webgl arms); `submitMs` (webgpu arms: `writeBuffer` + encode + `queue.submit`);
`passes` / `submits` / `particleDraws` / `shaderDraws`; `blitMs` / `blits` (blit arms only);
`adapterFallback` (1 = a software adapter, **the arm is void**); `gpuErrors` / `deviceLosses` (any
non-zero value means a frame was silently wrong, or stopped); `renderedNodes`. **`submitMs` is not
`glMs`**, so a reader cannot median the two together; and **a missing `blitMs` row IS the
architecture** — a `blitMs: 0` "for symmetry" would erase the difference under test.

### The verdict arithmetic

```
API submit cost     : particles-webgpu.submitMs vs particles-webgl.glMs
Page rate recovered : contentUpdateHz deltas
GPU-process relief  : cpu-process deltas
Blit's share        : particles-webgpu-blit vs particles-webgpu

webgpu-blit ≈ webgl         → the API is not the lever
webgpu-direct ≈ webgpu-blit → the blit is not the lever
webgpu-direct ≫ both        → the win is skipping the blit

A win counts only if it shows in BOTH contentUpdateHz and GPU-process CPU, on BOTH pairs, same session.
```

A `submitMs` that halves while `contentUpdateHz` stays put is a micro-optimisation, not an answer;
a fix that helps only the particle pair or only the shader pair is a fix to something other than the
pipeline. Allocation-jank claims are read off `frameCost` / `activationGap` **p95/max** and `gfxinfo`
jank%, not p50.

### Rules for running it

- **Desktop is smoke only**: under SwiftShader WebGPU is a software adapter, which sets
  `adapterFallback` and voids the arm. Only `--env device` answers the question.
- **`--chrome-arg` is desktop-only**: the desktop smoke needs `--chrome-arg=--enable-unsafe-webgpu`
  (on Linux also `--chrome-arg=--enable-features=Vulkan`); the device path attaches to the phone's
  Chrome and does not launch it.
- **A `ready()` failure aborts the WHOLE run**, so smoke the webgl and webgpu arms in separate
  `--mechanism` invocations. Errors front-load the actionable fix, because they are read truncated.
- **`blend=1` is refused** on the probe's webgpu arms (no accumulate+resolve pass); S8 measures
  additive on the shipped path. **`fps`** is a rAF skip on the webgpu arms but a parked timer in the
  shipped runtime — not directly comparable.

```bash
# desktop SMOKE, in two invocations
mise exec -- pnpm perf -- --scenario effects-webgpu --mechanism particles-webgl,shaders-webgl
mise exec -- pnpm perf -- --scenario effects-webgpu \
  --mechanism particles-webgpu,particles-webgpu-blit,shaders-webgpu \
  --chrome-arg=--enable-unsafe-webgpu --chrome-arg=--enable-features=Vulkan

# on a phone — all five arms, one session
mise exec -- pnpm perf -- --env device --scenario effects-webgpu --baseline device-effects-webgpu
```

## Scenario S8: `effects-webgpu-runtime` — the SHIPPED WebGPU path

Does a WebGPU win survive productization? The shipped renderer carries textures, flipbooks, LUT
recolour, masks, polar UV, erode, the additive accumulate+resolve pass, per-binding fallback, a
device-lost rebuild and the lifecycle machinery a probe never has. So S8 mounts **shipped code
only** — the `packages/html` runtimes and S6's node builders, **called** — with exactly ONE option
different between an arm and its reference, and imports nothing from S7. It runs at 12 systems and
at `--param systems=30`. Params: `systems`, `cellPx`, `blend`, `fps`, `renderScale`, `churn`,
`forceWebgpu`, `freeze`, `swap`.

Arms: `particles-webgl` / `particles-webgpu` (`createParticleRuntime`) and `shaders-webgl` /
`shaders-webgpu` (`createWebglShaderRuntime`), each pair differing only in `effectsRenderer`
(`"webgl"` / `"webgpu"`).

**Both sides are PINNED; neither is `"auto"`** (the shipped default), or the reference would adopt
WebGPU and the table would be WebGPU against WebGPU. `test/effects-webgpu-runtime.test.ts` asserts
the pinning and that geometry and spec equal S6's at `systems` 12 and 30. `blend=1` is measurable
here.

### `freeze` and `swap` — fewer live canvases, as PARAMS

`freeze=1` sets `staticParticles` (particle arms) or `staticShaders` + `staticShaderTime: 1` (shader
arms). `swap=1` sets `staticParticleImages` + `staticShaderImages`, so a frozen canvas is replaced by
an `<img>` and leaves the composite. They apply to the arm **and its reference**, so the reading is
**the same arm at `swap=0` against `swap=1`**.

- `swap=0` pins `staticShaderImages: false` **explicitly**, because that option ships ON.
- `swap=1` **requires** `freeze=1` (`mount()` throws otherwise): a live population never earns a
  swap, so the run would publish a mechanism that never engaged.
- With `swap=1`, `ready()` reconciles the shader runtime once per frame and polls `staticImagesLive`
  until every surface has swapped, throwing after 20 s with the failure counters and
  `webgpuFallbackReason`. The window measures the **swapped steady state**, never the transition.

### Counter conventions

Window deltas (S6's `counterDelta`) unless marked:

- `simMs` / `buildMs` / `simSteps` / `instances` (particle arms); `glMs` / `blitMs` (webgl arms);
  `submitMs` (webgpu arms — **the runtime's `glMs` bucket, renamed** by `renameWebgpuBuckets` at
  the scenario boundary so a table read across arms never medians GL submit with WebGPU encode);
  `webgpuSubmits` (`queue.submit` calls, one per tick that drew). A missing `blitMs` on the WebGPU
  arms IS the architecture.
- Validity: `rendererWebgpu` (1 iff `stats().renderer === "webgpu"` **after** the window),
  `webgpuFallbacks` / `webgpuBindingFallbacks`, `gpuErrors` / `deviceLosses`, and `forcedAdapter` —
  present ONLY with `forceWebgpu=1`, which disables the shipped fallback-adapter decline
  (`webgpu/device.ts`) and therefore **voids the arm for performance**. There is deliberately no
  `forcedAdapter: 0`.
- `renderedNodes` / `boxReads` _(life)_ — S6's rows.
- `swap=1` only (absent otherwise, because a `0` would mean "never asked"):
  `staticImageSwaps` / `Reverts` / `Encodes` / `Failures` (**≈0 is healthy**);
  `staticImageEncodeMs` (synchronous main-thread `toBlob` park) and `staticImageCaptureMs` (GPU
  `mapAsync` readback wall time, which parks nothing — never add the two);
  `staticImageBlankCaptures` (captures refused for holding no visible px for a surface the renderer
  drew: a **launch-mode** verdict; always 0 on webgl arms, meaning "not measurable");
  `staticImagesLive` _(life, GAUGE, never delta'd)_ — `== systems` means every canvas left the
  composite.

### `ready()` refuses a silent fallback

The shipped runtime's WebGPU failure is invisible by design: it adopts WebGL and keeps rendering.
For a confirmation arm that would publish WebGL numbers under a WebGPU name. So on a webgpu arm
`ready()` polls `stats().renderer` until it is `"webgpu"`, and throws if `webgpuFallbacks > 0` or
`webgpuBindingFallbacks > 0`, naming `webgpuFallbackReason` and the remedy (`--param forceWebgpu=1`
for a desktop smoke on a fallback adapter, or the webgl arms). `rendererWebgpu` re-checks after the
window, because a device lost mid-run rebuilds the runtime on WebGL.

### Rules for running it

- As in S7, smoke the webgl and webgpu arms in separate invocations.
- **Headless Chrome never composites a WebGPU canvas**, and the presence guard samples composited
  pixels, so a desktop WebGPU smoke runs `xvfb-run -a … --headed`. **`swap=1` inverts this**: a
  swapped surface is an `<img>`, which composites headless.
- **A swapped WebGPU smoke needs headless `--use-angle=vulkan`**: on the default ANGLE backend the
  still is assembled in an accelerated 2D canvas whose `putImageData` produces nothing;
  `staticImageBlankCaptures` reports it and `ready()` throws.
- **Desktop is correctness-only**, and the two smoke invocations run in different display and GPU
  modes, so their columns are not comparable with each other.

```bash
# desktop SMOKE, in two invocations
mise exec -- pnpm perf -- --scenario effects-webgpu-runtime --mechanism particles-webgl,shaders-webgl
xvfb-run -a mise exec -- pnpm perf -- --scenario effects-webgpu-runtime \
  --mechanism particles-webgpu,shaders-webgpu --headed \
  --chrome-arg=--enable-unsafe-webgpu --chrome-arg=--enable-features=Vulkan \
  --param forceWebgpu=1

# on a phone — all four arms, at 12 and at 30 (add --param blend=1 for additive)
mise exec -- pnpm perf -- --env device --scenario effects-webgpu-runtime \
  --baseline device-effects-webgpu-runtime
mise exec -- pnpm perf -- --env device --scenario effects-webgpu-runtime --param systems=30

# THE SWAP: webgl arms, then the webgpu arms headless on --use-angle=vulkan
mise exec -- pnpm perf -- --scenario effects-webgpu-runtime \
  --mechanism particles-webgl,shaders-webgl --param freeze=1 --param swap=1
mise exec -- pnpm perf -- --scenario effects-webgpu-runtime \
  --mechanism particles-webgpu,shaders-webgpu \
  --chrome-arg=--enable-unsafe-webgpu --chrome-arg=--enable-features=Vulkan \
  --chrome-arg=--use-angle=vulkan \
  --param forceWebgpu=1 --param freeze=1 --param swap=1

# 30 canvases, frozen, swapped against not-swapped
mise exec -- pnpm perf -- --env device --scenario effects-webgpu-runtime \
  --param systems=30 --param freeze=1 --param swap=0
mise exec -- pnpm perf -- --env device --scenario effects-webgpu-runtime \
  --param systems=30 --param freeze=1 --param swap=1
```

Reading a swap pair: `staticImagesLive == systems` (engaged), `staticImageBlankCaptures == 0` (real
pixels), in-window `staticImageSwaps` / `Reverts` ≈ 0 (sat still); the difference the run is about
shows up in `contentUpdateHz`, `CompositorGpuThread` ms and the layer count.

## Scenario S9: `text-render` — crisp small rotated text

14 px, rotated 10°, translating every frame. The fidelity instrument, the alignment guard and the
Godot comparison are in [text-rendering.md](text-rendering.md); this is the harness-facing shape.

**Arms.** `dom` (the shipped `html` path), `canvas2d` (`fillText` per run per frame), `hb-atlas`
(HarfBuzz shapes once; each glyph rasterized with the rotation and N sub-pixel phases baked in,
blitted 1:1 through `createDrawList` + the WebGL2 executor), `hb-run` (each whole run baked to one
texture, then only translated), `hb-gpu` (HarfBuzz's Slug encoder turns each glyph's outline into an
RGBA16I texel blob and a fragment shader evaluates coverage per frame — no baked pixels).

**`hb-gpu` may be absent.** Its wasm is committed at `packages/hb-gpu/vendor/` (see `VENDOR.md`
there), but a sparse checkout or an interrupted `build.sh` can lose it. A default invocation then
drops the arm and prints `NOT MEASURED: hb-gpu — … packages/hb-gpu/vendor/hb-gpu.mjs is absent` /
`bash packages/hb-gpu/build.sh` below the table; `--mechanism hb-gpu` **fails loudly** with the same
words. The gate is node-side (`src/hb-gpu-build.ts`), before any browser launch, and the arm is
**never rendered as a zero** (`test/hb-gpu-build.test.ts`).

**Refused params.** `phases`, `bakeRotation` and `bakeShaper` describe a bake `hb-gpu` does not have
and are refused on it at mount (`textGpuUnsupportedParam`, shared with the fidelity probe); defaults
are accepted, because `resolveParams` materialises every default into the page URL. `outlinePx` runs
the other way (`textOutlineParamRefusal`): `hb-gpu` only, refused on the four other arms and for a
negative or non-finite width (which `HbGpuRenderer.setSpread` would silently clamp to 0). With it the
arm draws an outline pass at `setSpread(w / 2)` then the fill — the order `packages/canvas`'s glyph
pass uses. The radius is half the width and is in **device** pixels, published as
`outlineSpreadPx`; `passesPerFrame` doubles both sides of
`glyphsPerFrame × passesPerFrame − quadsPerFrame = inklessGlyphsPerFrame`; and the outline colour is
neither black nor the fill's white so `nonEmptyRatio` rises with the radius.

**Headless numbers for the baked arms are not GPU numbers**: under SwiftShader a WebGL2 draw is
rasterized on the CPU, and the ordering against `canvas2d` can reverse on a real GPU. Use a distinct
env label (`--env linux-chrome-nvidia`, headed) so the two cannot land in one baseline.

### `scenario.*` counters

Baked arms: `atlasPages`, `atlasBytes` (self-counted), `atlasPageSide`, `atlasOccupancy`,
`atlasPhases`, `rasterizedGlyphs` (glyphs × phases), `shapeMs`, `bakeMs`, `wasmHeapBytes` (summed
across faces), `quadsPerFrame`, `glDrawCalls`. `canvas2d`: `fillTextCalls`; `dom`: `domNodes`. Every
arm: `cellsDrawn`, `runsDrawn`, `distinctFaces`, and `baselinePx` / `baselineLatinPx` — identical
values are the evidence that the arms draw in the same place.

`hb-gpu` reports the same shape where the concept exists and **nothing** where it does not (no
`atlasPhases`, `atlasPageSide` or `rasterizedGlyphs`). Its own keys: `encodeMs` / `programMs` /
`uploadMs` (split, because the driver's program link depends on the shader cache); `atlasBytes`
(live texels × 8) and `atlasReservationBytes` (the whole texture — the figure comparable with
`hb-atlas`'s `atlasBytes`), bridged by `atlasOccupancy`; `blobBytes`, `blobGlyphs`, `blobMinBytes`,
`blobMaxBytes`; `inklessGlyphsPerFrame` (spaces get no quad); `passesPerFrame`, `outlineSpreadPx`;
and `wasmHeapBytes` for its ONE module, which shapes and encodes — an upper bound equal to the
initial memory reservation unless the workload grows the heap.

The scenario also enforces: query-string booleans are coerced (`test/browser-params.test.ts`), the
viewport is passed explicitly to `resolveGodotSceneTree`, and atlas keys are namespaced
`<face>/<glyph>` because glyph ids are per-face (`test/text-atlas.test.ts`).

## `perf assert` — relational gates

```bash
mise exec -- pnpm perf -- assert --scenario ancestor-rescale
mise exec -- pnpm perf -- assert --scenario ancestor-rescale artifacts/perf/runs/<timestamp>
```

Exit `0` when every relation holds, `1` when any fails. With a directory argument it re-checks a
finished run without launching Chrome.

### Why relational, never an absolute wall-clock threshold

Every millisecond this harness reports is a property of the machine. A headless SwiftShader box, a CI
runner and a phone disagree by an order of magnitude on the same page, and the same box disagrees with
itself when it is thermally throttled. A gate written as "page-crop must decode in under 1500 ms"
encodes the box it was written on: it goes red on a slower machine that reproduces the bug perfectly,
and green on a faster one that reproduces it just as badly. Both outcomes teach the reader to ignore
the gate.

What survives the machine is the **relation between arms measured in the same browser, minutes apart,
on identical geometry**. "page-crop re-decodes at least three times as often as region-blob" is a
statement about the mechanisms, and it fails exactly when the defect stops reproducing.

### What `ancestor-rescale` asserts

| relation                                                                | why                                                                                      |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| every arm's `presented.sampleHits == sampleCount`                       | a blank page decodes nothing and stalls nothing; it would pass every ratio the wrong way |
| `decode.redecodeCount`: page-crop ≥ 3× each control arm **and ≥ 3**     | the mechanism-level statement of the hazard                                              |
| `decode.maxMs`: page-crop ≥ 3× each control arm                         | only the arm referencing the whole page ever pays a 16 MP decode                         |
| `paint.maxSourceToPaintedRatio`: page-crop ≥ 10× each control arm       | the cause class itself, straight out of the display lists                                |
| `activationGapMs`: page-crop stalls past 100 ms and the controls do not | the user-visible symptom — **evaluated only on the GPU decode path**, see below          |

The two count-valued floors (`≥ 3` re-decodes, `≥ 1` long gap) are not wall-clock thresholds. They
exist because a ratio against zero is not a relation: without them a run where nothing was measured —
0 re-decodes on every arm, the shape a broken capture takes — would satisfy "page-crop ≥ 3× the
others" and go green.

### The one relation that is skipped, and why it is skipped rather than dropped

The activation-gap relation is asserted only when `decode.cacheFamily` is `gpu`. On the software
cache it prints **SKIP** with its reason and the observed numbers, and the summary line says how many
relations were skipped, so the command can never be read as claiming the traced defect reproduced.

The software decode cache re-scales an existing decode instead of re-running the codec, so the stall
cannot occur on that path. Asserting it there would fail every clean headless run, and the relation
would then be disabled on the device runner where it does hold. It is enforced whenever a run
reports the `gpu` family.

## Chrome trace event names

**Chrome trace event names drift between versions.** An analyzer coded against remembered names
reports zeroes and nobody notices. `--dump-trace-names` exists so you never have to: run it on the
target Chrome first, then write the matcher against what it actually printed.

Reference (Chrome for Testing 148, headless, SwiftShader):

- **`ActivateLayerTree`** — `ph:"I"` (instant), not a complete event; cat
  `disabled-by-default-devtools.timeline.frame`, thread `Renderer/Compositor`, args
  `{frameId, layerTreeId}`.
- **`DrawFrame`** — `ph:"I"`, emitted on **both** `Renderer/Compositor` and
  `GPU Process/VizCompositorThread` at the same timestamp: deduplicate by ts or the swap rate doubles.
- **`RunTask`** — `ph:"X"`, cat `disabled-by-default-devtools.timeline`, on every thread including
  `CrRendererMain`, carrying `tdur`.
- **`RasterTask`** — `ph:"X"`, cat `cc,disabled-by-default-devtools.timeline`, on
  `Renderer/ThreadPoolForegroundWorker` and `Browser/CompositorTileWorker1`.
- **`ImageDecodeTask`** — `args` is `{pixelRefId}` only, **no url**.
- **`Decode Image`** — rare: the **codec run**, nested deep inside the decode task.
- **`PaintImage`** — cat `disabled-by-default-devtools.timeline`, `CrRendererMain`; `args.data`
  carries `{url, srcWidth, srcHeight, width, height, nodeId, nodeName, x, y}` — **the only
  url-bearing event**.
- **`Draw LazyPixelRef`** — useless: `args.LazyPixelRef` is `0` on every event.
- **`RenderSurfaceReasonCount`** — absent unless the page has a reason (blend modes, filters,
  non-axis-aligned clips): cc emits one instant per reason per draw. `CalculateRenderSurfaceLayerList`
  (cat `cc`, always on) is recorded as `renderSurfaceListPasses`, so a `0` can be told apart from
  "not measured".
- **user-timing marks** — `ph:"I"`, cat `blink.user_timing`, name = the mark name.

The decode nesting chain:

```
ThreadPool_RunTask
└ TaskGraphRunner::RunTask
  └ SoftwareImageDecodeTaskImpl::RunOnWorkerThread
    └ ImageDecodeTask                                  args.pixelRefId
      └ SoftwareImageDecodeCache::DecodeImageInTask     cat cc,benchmark; args.key → content_id
        └ Decode LazyPixelRef
          └ ImageFrameGenerator::decode
            └ Decode Image                              the actual codec run
```

The analyzer uses a containment stack everywhere (maximal events per thread), because nested totals
in a name histogram double-count. `inRasterCount` counts **codec runs** inside a `RasterTask`, not
in-raster cache lookups, which are cache hits.

### Software vs GPU decode cache — the portability trap

Headless/SwiftShader runs cc's **software** decode path and emits `SoftwareImageDecodeCache::*`. A
real phone with a GPU runs the **GPU** path and emits `GpuImageDecodeCache::*` instead. An analyzer
matching only the software names reports **zero decode on the phone**. So the analyzer matches both
families, and every report carries `decode.cacheFamily` (`software` | `gpu` | `mixed` | `unknown`).
`unknown`, or a `decode.count` of `0`, fails validation: that state means **unmeasured**, never
_fast_. `*ImageDecodeCache::DecodeImageInTask` is cat `cc,benchmark`, available without
`disabled-by-default-cc.debug`, which makes family detection cheap.

## Cross-checking with an external browser

`--serve` starts the server, prints one URL per mechanism (with `autorun=1`) and stays up. Point
chrome-devtools-mcp, a phone, or a plain browser at those URLs to check the render visually and to
take an independent trace. A harness whose output nobody can look at is a harness nobody should
trust.

## Measuring on a real phone: `--env device`

```bash
mise exec -- pnpm perf -- --env device --dump-trace-names   # ALWAYS FIRST on a new phone
mise exec -- pnpm perf -- --env device --scenario atlas-sprites --baseline device-atlas-sprites
mise exec -- pnpm perf -- --env device --serve              # open the URLs in Chrome ON the phone
```

Same scenarios, same analyzer, same envelope, same presence guard — only the attach mode changes, so
device numbers can be put next to desktop ones. Extra flags: `--device-serial <serial>` (default
`ANDROID_SERIAL`, or the only connected device), `--devtools-port <n>` (default 9222), `--adb <path>`
(default `GSW_PERF_ADB`, then `adb`).

**Transport: `adb reverse`, not a LAN IP.** The harness server stays bound to `127.0.0.1`, and
`adb reverse tcp:<port> tcp:<port>` makes the phone's own `127.0.0.1:<port>` tunnel back to it, so
the phone loads the byte-identical URL the desktop run uses. It needs no network configuration and
nothing else on the network can reach the page. There is no LAN fallback; if reverse forwarding
fails, the error says so.

**Attach: flattened, through the browser endpoint**, exactly the path `src/cdp.ts` uses:

```
adb forward tcp:9222 localabstract:chrome_devtools_remote
GET http://127.0.0.1:9222/json/version   ->   webSocketDebuggerUrl
Target.attachToTarget { flatten: true }  ->   sessionId
```

The legacy per-page endpoint (`ws://…/devtools/page/<id>`) no longer responds on current Chrome. The
DevTools socket name is **discovered** from `/proc/net/unix`, so Chrome Beta/Dev and WebView
(`*_devtools_remote_<pid>`) are visible instead of attached to by accident; stock
`chrome_devtools_remote` wins when present.

**The Android foreground rule.** CDP drives only the ACTIVE tab: a backgrounded tab attaches and
then `Runtime.evaluate` hangs. Every lease calls `Page.bringToFront` and probes with a 10 s
`Runtime.evaluate("1")`; lock state is checked first (`adb shell dumpsys window | grep
mDreamingLockscreen`). Keep the phone unlocked, screen on, Chrome in the foreground.

**What a "repeat" is on a phone.** Android Chrome may refuse a fresh browser context per repeat, so
the provider degrades and records what it did in `env.device.isolation`: `browser-context` (fresh
context, as desktop), `new-tab` (fresh tab, shared caches) or `reused-tab` (same tab, navigated,
HTTP cache cleared). In all three the per-repeat cache-busted image URL keeps each decode cold.

### Viewport and fit

The device run measures at the **phone's own viewport, orientation and DPR** — nothing is emulated,
because raster scale drives the decode cost being measured. The scenario **fits itself into whatever
viewport it is given**:

```
scale = min(viewportWidth / stageWidth, viewportHeight / stageHeight)
```

applied as `transform: scale()` on a stage that keeps its px layout, centred in a frame that clips the
letterbox bars — the uniform "keep" fit of Godot's `content_scale_aspect`, which this repo ships as
`observeContentScale` / `contentScaleStageStyle` (`packages/html`). `src/fit.ts` stays
product-neutral.

| environment      | viewport                             | fit        |
| ---------------- | ------------------------------------ | ---------- |
| `ci` (default)   | emulated 1280×800 @ DPR 1            | **off**    |
| `--env device`   | the phone's own, whatever it reports | **on**     |
| `--fit`          | unchanged                            | forced on  |
| `--no-fit`       | unchanged                            | forced off |
| `--viewport WxH` | forced (emulated) on either          | unchanged  |

**The grid follows the viewport's aspect.** A landscape grid fitted into a portrait phone renders
tiny in a band across the middle, under-loading the work being measured. So a **fitted** run picks
the grid's shape with `gridShapeFor`: the column count whose grid aspect is closest to the
viewport's, compared in log space. **The cell COUNT never changes**; the arrangement is recorded in
`env.geometry.grid` (e.g. `"5x10"`). Unfitted runs keep the authored shape (10 columns for S1/S2, 4
for S3) and insert nothing into the DOM.

**`--viewport` on a phone is unreliable**: the layout viewport and compositor scale the phone reports
need not match the request. The harness warns when they differ; use it only for a rough geometry
check, never for a measurement.

Every report carries `env.geometry` (see [perf-report-contract.md](perf-report-contract.md)), and the
table prints it with a warning when `fitScale !== 1`. **Two runs at different fit scales are not
directly comparable on `decode.*`, `rasterMs` or `paint.*`.** A repeat whose geometry differs from
the first — a phone rotated mid-run — is DISCARDED, and `perf compare` prints a **GEOMETRY MISMATCH**
block rather than tabling two experiments as one A/B. The presence guard maps sample points through
the fit and counts misses **outside the viewport** separately: "did not fit" and "did not render" are
opposite problems.

### Recovering a stuck tracing controller

`Tracing.start` failing with **"Tracing has already been started (possibly in another tab)"** means
Chrome's **browser-global** tracing controller is held:

- by **this** connection (a wedged repeat): a browser-level `Tracing.end` releases it, and
  `startTracing` does that automatically (`{ flat: true }`, no sessionId) and retries once;
- by a connection that is **gone**: Chrome releases it when the websocket closes;
- by **another live connection** (another harness process, a `--dump-trace-names` run,
  chrome-devtools-mcp, an open DevTools frontend): it cannot be taken over — stop the holder.

`Tracing.end` per attached PAGE session clears nothing, because the tracing agent is per-connection.
As a last resort: `adb shell am force-stop com.android.chrome`, then reopen Chrome on the phone.

### GPU, battery and thermal on the phone

`--env device` names the GPU from CDP `SystemInfo.getInfo` (`gpu.hardware`, e.g. `<GPU> (ANGLE)`)
and supplements the trace with `dumpsys gfxinfo com.android.chrome`, reset just before the page's
`run()` and read when it resolves; its `Total GPU memory usage` line is `gpu.device.gpuMemoryBytes`.
The gfxinfo percentiles are **HWUI** statistics for Chrome's Android View hierarchy, not the page's
frame times (web content is composited by the GPU process); `contentUpdateHz` remains the honest
content rate. `Slow bitmap uploads` / `Slow issue draw commands` are aggregated by worst case.

CDP `SystemInfo.getProcessInfo` may report `cpuTime: 0` for renderer and GPU processes on Android,
which is why `cpu` comes from trace `tdur`.

`env.device` carries battery and thermal samples **before** the first repeat and **after** the last,
plus `warnings[]` (already throttled, thermal status rising, battery heated ≥3 °C, battery under
20%). A baseline that cannot be told apart from a hot-phone run is worse than none.
`env.cpuThrottle` is `null` on device runs and `--cpu-throttle` is ignored there.

### What ports between environments and what does not

- **Portable**: `initialRenderMs`, `readyMs`, `frameCostMs`, `contentUpdateHz`, `activationGapMs`,
  `blockedMs`, the whole `decode` block, `paint.*`, `rasterMs`, `mainThreadCpuRatio`.
- **Environment-specific**: `layerCount`, `renderSurfaces`, `swapRateHz`, `presented.nonEmptyRatio`,
  and **the whole `gpu` block**.
- **`cpu`**: lower bounds from `tdur`, only as comparable as the two captures' category sets and
  thread inventories. `cpu.byThread` attribution ports; absolute milliseconds do not.

Every committed baseline restates this split in its own `portability` block.

### Decode cache family — verify on the phone FIRST

`mise exec -- pnpm perf -- --env device --dump-trace-names` leads with an **analyzer matcher probe**
— one line per name family the analyzer depends on (`activation`, `swap`, `main-thread task`,
`raster`, `decode task`, `codec run`, `decode cache family`, `paint`, `scenario marks`), each `ok`
with the names that matched or `MISS` with the metrics it silently zeroes. `NEAR MISSES` lists
unmatched names that look like a renamed family member. `decode.count === 0` is a **validation
failure**, not a fast phone.

## Baselines

`packages/perf-harness/baselines/<name>.json`, written by `--baseline [name]` and **committed** — the
one output of this harness that belongs in the repository: medians per mechanism plus the environment
they were measured in, a few KB, reviewable in a diff. Per-repeat `runs`, traces and screenshots stay
under the ignored `artifacts/` tree. `--baseline` also works on `compare <dir>`, so a baseline can be
re-derived from a finished run without re-measuring.

A baseline file holds **one scenario**, so the name has to carry the scenario — **`--baseline` with
no name writes `<env label>.json`, which is `atlas-sprites`' file**, and running it from another
scenario silently overwrites S1's baseline with a diff that looks like a legitimate re-capture.
Always pass the name: `--baseline linux-chrome-148-static-surfaces`.

Committed: `linux-chrome-148.json` (`atlas-sprites`), `linux-chrome-148-static-surfaces.json` (the
static `updateEveryMs=0` reading) and `linux-chrome-148-effects-runtime.json`, all headless Chrome
for Testing 148 on SwiftShader. To compare, run the same scenario on the same environment label and
read the new table against the baseline's medians; the file's `portability` block says which fields
port at all. A second experiment on the same scenario (e.g. `updateEveryMs=2000`) is not baselined
under the same name. The WebGPU scenarios have no desktop baseline: on a fallback adapter their
WebGPU arms are void.

## Adding a scenario

Implement the `Scenario` interface (`src/scenarios/types.ts`) and register it in
`src/scenarios/index.ts`. Requirements:

- `params` declares defaults and allowed values, including `mechanism` — mechanisms are parameters,
  not copies.
- `mount` / `ready` / `step` / `teardown` are browser-side and must not import anything from node;
  the same modules are bundled into the page _and_ imported by the CLI for the parameter defaults.
- `samplePoints` must return where the content is, in CSS px, **in the scenario's own stage
  coordinates**. Without it the presence guard cannot tell a correct render from a blank page. The
  runner maps these through the fit; a scenario never has to know whether it was fitted.
- `stageSize(params, layout)` must return the smallest box containing everything the scenario mounts
  and every point `samplePoints` can return **at any point in its animation** — S2 and S3 size theirs
  for the PEAK of the focus curve, because the screenshot is taken wherever the window happened to
  end. It is a pure function of its arguments, so `test/fit.test.ts` proves the box actually contains
  the sample points (in portrait and landscape) without a browser.
- `gridShape(params, layout)` is optional and reports the arrangement for `env.geometry.grid`. A
  scenario that adapts its shape to `layout` must keep its cell COUNT fixed: the shape may follow the
  screen, the workload may not.
- Read `ctx.stage`, never `window.innerWidth`, for the scenario's own extent: on a fitted run the
  window is the letterboxed frame, not the space the scenario has.
