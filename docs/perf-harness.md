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
mise exec -- pnpm perf -- --env device --scenario effects-webgpu --baseline moto-g86-5g-effects-webgpu

# the encoder/fidelity PROBE (not a scenario, not a perf-report — see The bake probe)
mise exec -- pnpm exec tsx packages/perf-harness/probes/bake-probe.ts --local

# DRIVER-attributed VRAM: headed on the real GPU (headless is SwiftShader and the sample gates itself
# off there), plus the optional self-counted cross-check
xvfb-run -a mise exec -- pnpm perf -- --scenario atlas-sprites --headed --env linux-chrome-nvidia
xvfb-run -a mise exec -- pnpm perf -- --scenario atlas-sprites --headed --memory-dump
```

Chrome is resolved from `GSW_PERF_CHROME`, then the newest
`~/.cache/ms-playwright/chromium-*/chrome-linux64/chrome`, then `/snap/bin/chromium`. There is
deliberately **no Playwright dependency**: this repo's `@playwright/test` resolves to a version whose
pinned chromium revision is not on disk, and a perf harness must never be blocked on a browser
download. If you do fall back to snap chromium, note it is confined — the profile directory must stay
inside the repo (`artifacts/perf/chrome-profile/`), never under `/tmp`.

Everything the harness writes lands under `artifacts/perf/`, which is ignored. The generated atlas
page is ~15 MB; it is cached and regenerated only when missing.

## The two things this harness exists to say

### 1. Swap rate is not fps

The compositor will happily swap at 87–90 Hz while the user watches half-second freezes, because it
keeps re-presenting _the same content_. The rate at which **new content** is activated is a different
number entirely — in the trace that motivated this harness it was 28.9 Hz against a 90 Hz swap rate.

So:

- `contentUpdateHz` — `ActivateLayerTree` rate. **This is the frame rate.**
- `swapRateHz` — `DrawFrame` rate. Reported, labelled, and never called fps.
- `activationGapMs` — the distribution of gaps between activations, plus a count of gaps over 100 ms.
  A good p50 with three 400 ms gaps is a page that stutters, and only the gap row shows it.

`initialRenderMs` follows the same rule: it is measured from the mount mark to the first
`ActivateLayerTree` at or after the ready mark. Never from a rAF callback, which fires when the frame
was _requested_, not when content was _presented_.

### 2. Image decode dominates and is invisible to JS

Decode runs on decode worker threads. It never appears in a rAF timer, a `performance.now()` delta or
a user-timing mark, so if you do not read it out of the trace you do not measure it at all. In the
motivating trace it was 1034.8 ms — 29.4% of wall — with 40 of 68 distinct images decoded two or more
times, and one image that exceeded the discardable decode cache and decoded **inside raster** at
275 ms, i.e. re-paid on every re-raster forever.

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
  fixes, and the wall-clock number alone cannot tell them apart. In practice the biggest main-thread
  "task" in these runs is `LayerTreeHost::WaitForCommitCompletion`, which is pure waiting.
- **`layerCount` / `renderSurfaces`** are comparable **within an environment only**. Do not compare a
  headless SwiftShader layer count against a phone's.

## CPU and GPU: `cpu` and `gpu`

Until this round the analyzer filtered every event to the renderer process that emitted the scenario
marks, so **browser- and GPU-process work was discarded outright** — an instrument whose whole point
is finding where cost goes could not see two of the three processes it goes to. The trace already
carried `tdur` (thread CPU) for every traced process, so this is an analysis change, not new
transport.

```
cpu ALL PROCESSES ms (>=)                  858            1006             598
  core-equivalents (>=)                0.3415x         0.4016x         0.2385x
  cpu coverage                           1.000           1.000           1.000
  renderer cpu ms                          649             870             410
  browser cpu ms                         89.72           32.82           34.14
  gpu cpu ms                               104           93.08             141
```

### `totalCpuMs` is a LOWER BOUND, and the tooling says so everywhere

`tdur` is CPU spent **inside a traced task**. Anything in a category this capture did not enable, and
every process Chrome did not instrument, counts as zero. So the totals are a floor on real CPU, and
`totalCoreRatio` is **not** a `top`-style CPU%.

This matters enough to be enforced rather than remembered: the field docs say it, the contract says
it, the table prints it above the grid, and the affected rows are labelled `(>=)`. Reporting it as
true CPU% would be the same class of dishonesty as reporting the compositor swap rate as fps — which
this harness explicitly refuses to do, three sections above.

`cpuCoverage` is the check on the caveat: the share of summed top-level **wall** time that carried a
`tdur` at all. A thread with high wall and low coverage has **unknown** CPU, not zero. On the desktop
reference run above it is `1.000`, i.e. the floor is tight there.

Attribution is what the block is really for, and it is per thread across every process:

```
  page-crop  —  total 1006 ms cpu over a 2507 ms window (0.4016x one core), coverage 1
      process/thread                               cpu ms    wall ms     core    n
      Renderer/ThreadPoolForegroundWorker             670       1454   0.2673   10
      Renderer/Compositor                             101        121  0.04026    1
      Renderer/CrRendererMain                       88.78        591  0.03542    3
      GPU Process/VizCompositorThread               85.87      94.55  0.03425    1
```

Read the first and third rows together: page-crop's main thread holds 591 ms of **wall** and 88.78 ms
of **CPU** — parked, exactly as `mainThreadCpuRatio` 0.0033 already said — while the raster workers
burn 670 ms of real CPU across ten threads. That second half is the part the renderer-main-only view
could never show.

Rows fold by the `(process, thread)` name pair rather than `pid:tid` (`n` = how many OS threads were
summed), because a phone with a hundred background tabs has many renderer processes and one story.

### `gpu`, and `--no-gpu`

`--scenario … ` collects `gpu`, `viz`, `disabled-by-default-gpu.service` and
`disabled-by-default-skia.gpu` by default and reports GPU-process cost bucketed by op. `--no-gpu`
turns that off: `gpu.available` becomes `false` — **not measured**, never "the GPU did nothing" — and
the CPU block is untouched, because `cpu.byProcess.gpu` comes from `tdur` on the same `toplevel`
tasks either way.

`--no-gpu` is protective, not cosmetic. `disabled-by-default-skia.gpu` emits an event per draw op, and
a sibling repo has already had a capture silently truncated by trace-buffer overflow into something
that read as an idle page. Two things follow:

- measured on this box, the GPU categories grow a 5-repeat S1 capture from **32.88 MB to 36.34 MB**
  of gzipped trace (+10.5%). On hardware that really runs skia GPU ops the multiple is larger;
- the harness no longer trusts the buffer. `Tracing.tracingComplete.dataLossOccurred` is now read, and
  a repeat Chrome admits it truncated is **DISCARDED** with that reason (and a pointer to `--no-gpu`)
  rather than analyzed. A truncated capture does not look broken; it looks like a page that did less
  work, which is the most dangerous shape a perf measurement can take.

**GPU numbers are comparable within an environment only**, exactly like `layerCount`. This box is
SwiftShader — a software rasteriser, no hardware GPU — so `gpu.hardware` reads `swiftshader` here and
`Mali-G615 MC2 (ANGLE)` on the phone, and the table header repeats the warning next to the hardware
names.

The buckets (`uploadDecode`, `rasterPlayback`, `skiaPrepare`, `skiaExecute`, `presentSwap`, `clear`,
`schedulerIpc`, `other`) are name-matched, ported from couch-coop's `scripts/analyze-gpu-trace.mjs`.
**`topUnbucketedOps` is always printed**, so nothing hides behind the taxonomy — and on this box that
is not a formality, it is where the answer lives:

```
GPU OPS THE BUCKETS DID NOT NAME (`other`):
  region-blob:
          38.96 ms  x   753  SoftwareRenderer::DoDrawQuad
           3.96 ms  x   148  LayerContextImpl::DoDrawInternal
```

SwiftShader composites through `SoftwareRenderer`, so its skia-GPU buckets are genuinely 0.00 and
**62.89 of its 104 ms of GPU-process CPU is unbucketed**. A taxonomy built for real GPU ops describes
this environment badly, and the unbucketed list is what makes that visible instead of misleading.

### `gpu.device.gpuMemoryBytes` — the DRIVER's byte, not ours

Every other GPU-memory figure in this repository is **self-counted**: the texture cache's own total,
Godot's `RENDER_TEXTURE_MEM_USED`, Chrome's memory-infra allocators. All of them are a program adding
up what it believes it uploaded. `gpu.device.gpuMemoryBytes` is the one that is not — it is what the
**driver** says the process is holding, so "this mechanism costs 1.45 MiB of atlas" can be checked
rather than believed. Two rungs produce it, and `gpu.device.source` always names which:

| `source`            | where                     | command                                      |
| ------------------- | ------------------------- | -------------------------------------------- |
| `"dumpsys-gfxinfo"` | `--env device`            | `adb shell dumpsys gfxinfo <chrome package>` |
| `"nvidia-smi"`      | desktop **headed** NVIDIA | `nvidia-smi -q -x`                           |

Both are sampled at the SAME out-of-band bracket (`CaptureOptions.window`), best-effort: **a failure
to read GPU memory must never fail a measurement**.

#### Attribution is the whole feature

`nvidia-smi -q -x` reports a box-wide `<fb_memory_usage><used>` **and** a per-process list. The
box-wide figure is never read. Sampled independently, from a second shell, while an S9 run was in
flight: **1139 MiB used in total** over ten processes — 291 MiB VS Code, 235 MiB the developer's own
snap Chromium (whose GPU process carries exactly the same `--type=gpu-process` as ours), 114 MiB
gnome-shell, 94 MiB sunshine — and **103 MiB the Chrome the harness had just launched**. Publishing
the total would have been an order of magnitude out and would move when someone opened an editor.

So the pid is walked, not matched:

1. `launchChrome` keeps the `ChildProcess`; `PerfBrowser.pid` carries it (`null` on device — the
   phone's Chrome was attached to, never launched, and Android answers with `dumpsys` instead);
2. `/proc` is read into a `{ pid, ppid, cmdline }` table (ppid from `/proc/<pid>/stat`, **after the
   last `)`** — `comm` is parenthesised and may contain spaces, which shifts every later field);
3. descendants of the launched pid are walked **transitively** and filtered by `--type=gpu-process`.

Step 3 is transitive for a measured reason. In the S9 reference run the launched Chrome was pid 87333
and its GPU process pid 87372 — with **ppid 87340**, an intermediate. Chrome forks its children off a
zygote, so a "children of the browser" walk finds nothing at all. It also returns a **list**: the same
observation caught a second `--type=gpu-process` under our Chrome (2 MiB, Chrome's short-lived
GPU-info collection process), and summing is the only answer that neither double-counts nor drops one.

**No match means `null` — NOT MEASURED.** Never 0. A GPU process the driver does not list is one with
no GPU context, and reporting that as zero bytes would read as "our GPU work is free".

#### Absolute and delta, and which one answers what

Both are reported. The **absolute** (`gpuMemoryBytes`, read after the window) is the honest total but
carries Chrome's fixed cost — a headed GPU process holds framebuffers, UI tiles and a shader cache
before the page mounts anything — so it cannot price a scenario. The **delta**
(`gpuMemoryDeltaBytes`) can: the bracket spans mount plus the measured window, which is when a
scenario uploads its textures.

First readings on the RTX 2060, headed under Xvfb, 1 repeat:

| run                                | absolute            | window delta           |
| ---------------------------------- | ------------------- | ---------------------- |
| `text-render` / `hb-atlas`         | 100.66 MB (96 MiB)  | **+45.09 MB** (43 MiB) |
| `text-render` / `hb-atlas`, again  | 100.66 MB           | +45.09 MB              |
| `atlas-sprites` / `page-crop` (×3) | 144 / 145 / 231 MiB | +0 / +1 / +89 MiB      |

The delta is the fragile half and the S1 column says so plainly. **The driver reports whole MiB**, so
anything under ~1.05 MB is below the instrument, and where a texture upload falls relative to
`ready()` moves between runs. The S9 arm reproducing to the byte across two invocations is the
encouraging case, not the guaranteed one: read a delta as evidence about one run, and take that S1
spread as the reason a VRAM claim needs repeats rather than as a defect in the instrument.

#### `--memory-dump`: the cross-check, OFF BY DEFAULT

`--memory-dump` adds `disabled-by-default-memory-infra` and requests a detailed, deterministic dump at
the same bracket, reporting the delta on `gpu/gl/textures`, `gpu/shared_images` and
`skia/gpu_resources/*`.

It reads **`size`, never `effective_size`**. `effective_size` deduplicates an allocation across the
processes that share it, so a texture the renderer owns and shares into the GPU process is charged to
exactly one of them — and read from the GPU process's dump it reports 0 for memory that is
unmistakably on the card. That is the trap this flag exists to avoid falling into.

It is a CROSS-CHECK, not a second answer. **Where it disagrees with the driver, the driver is the
truth**, and the disagreement is not hypothetical — measured on the same run that read `+1.05 MB` from
the driver:

```
gpu memory MB (driver)                         152.04
  window delta MB                               +1.05
  source                                   nvidia-smi
memory-dump delta MB (self-counted)
  gpu/gl/textures                                   —
  gpu/shared_images                             +7.86
  skia/gpu_resources/*                          -8.62
```

Chrome's own accounting moves ±8 MB across a window in which the driver committed one megabyte. The
`—` is not a zero either: this Chrome's GL backend emits no `gpu/gl/textures` allocator at all, so that
allocator is NOT MEASURED and says so.

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

## Scenario S1: `atlas-sprites`

100-region atlas on a 4096×4096 page (real atlas pages in the consuming project reach 4032×4080, so a
realistic page size is the point), 50 sprites mounted, 10 of them advancing their region index every
frame — the "intent icon" shape.

The **mechanism is a parameter, never a forked copy of the scenario**: geometry, sprite count,
animation and sample points are identical across arms, so any difference in the numbers is the
mechanism and nothing else.

| mechanism     | how a sprite references its region                                                                                                                                                                                                                |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `region-blob` | bake each region once via `OffscreenCanvas` → `convertToBlob` → `URL.createObjectURL`; a `<div>` with `background-image: url(blob:…)`                                                                                                             |
| `page-crop`   | a `<div>` with `background-image: url(<whole page>)`, cropped by CSS through gsw's **shipped** `regionBackgroundStyle` (`packages/html/src/textures.ts`) — that is the real crop math, and measuring a re-derivation would measure the wrong code |
| `canvas`      | `createImageBitmap(page)` once, then per-node `<canvas>` + `drawImage`                                                                                                                                                                            |

Only `page-crop` awaits nothing more than the network fetch before declaring ready — its cost is
deliberately left in paint and decode, where the mechanism really puts it. The other two must fully
decode the page to build an `ImageBitmap`, so their cost is JS-visible and lands in `readyMs`. That
split between `readyMs` and `initialRenderMs` is the point of having both.

### Reference reading

Measured on Chrome for Testing 148.0.7778.56, headless, SwiftShader, 1280×800 @ DPR 1, no CPU
throttle, 5 repeats + 1 warmup, medians:

```
metric                             region-blob       page-crop          canvas
------------------------------------------------------------------------------
initialRender ms                           546             535             142
ready ms (JS)                              498           27.10             127
contentUpdate Hz                         59.43           48.29           60.36
  swapRate Hz (NOT fps)                  59.03           47.89           59.96
frameCost ms p50/p95/max        0.99/1.71/6.82  0.90/1.18/3.01 1.54/1.95/12.50
blocked ms (LoAF)                         0.00             433            0.00
mainThread busy ms                         210             618             275
mainThread cpu ratio              0.5764 (n=2)  0.002952 (n=1)    0.7262 (n=5)
decode ms                                  380            1343           96.53
  decode max ms                          96.24             505           96.53
  distinct images                          124               1               1
  decode cache family                 software        software         unknown
  REDECODES (n / ms)                  0 / 0.00         3 / 375        0 / 0.00
  DECODE IN RASTER (n / ms)           0 / 0.00        0 / 0.00        0 / 0.00
raster ms                                  116           97.81            0.00
paintImage records                        1490            1260               0
  max source:painted                    17.71x           1820x           0.00x
layers                                       4               4              54
presented sampleHits                     50/50           50/50           50/50
```

How to read it — the three arms fail in three different places, which is the whole point:

- **`region-blob`** pays 498 ms of **JS-visible** setup (decoding the page once, then encoding 100
  PNG blobs). Once mounted it is the cheapest to animate and its display lists only reference small
  images (`max source:painted` 17.7×). Its per-repeat cpu ratios were
  `[null, 0.5764, 0.5817, null, 0.2043]` — **two repeats produced no task reaching the 5 ms long-task
  threshold at all**, so they are `null` (not measured) and are dropped from the median, which is
  reported as `0.5764 (n=2)` over the repeats that actually backed it. That this arm frequently has
  _no long task at all_ is itself the finding: its main-thread work is finely divided.
- **`page-crop`** is ready in 27 ms but takes just as long to actually present (535 ms), and the cost
  is entirely invisible to JS: 1343 ms of decode, 433 ms of LoAF blocking, a **`mainThreadCpuRatio`
  of 0.002952** — 0.3% CPU across 618 ms of wall, i.e. the main thread is parked waiting for commit,
  not computing — and 3 re-decodes of the 16 MP page costing 375 ms. Its `max source:painted` of
  **1820×** is the cause class spelled out: a 4096×4096 source painted into a 96×96 box.
- **`canvas`** presents in 142 ms with almost no decode, but costs **54 compositor layers** against 4,
  and its `cacheFamily` is `unknown` because `createImageBitmap` decodes outside cc's image-decode
  cache entirely.

Read `mainThreadCpuRatio` together with its sample size `n`. The ratio is computed over top-level
main-thread tasks of at least 5 ms; with `n=0` it falls back to `1`, which means _no qualifying
tasks_, not _saturated_.

`inRasterCount` was 0 on all three arms: no image exceeded the discardable decode cache at this size.

### The `scaleDiversity` isolation (S1 and S2)

`page-crop`'s 1343 ms of decode is two effects wearing one coat, and the table cannot tell them apart:
**one big page**, and **many distinct scaled decodes of that page**. On the reference run all 50 divs
paint the same 4096² page but each at a different `background-size` — `980.589px 1440.35px` next to
`1297.74px 1010.84px` — because each sprite's box is a fixed 96×96 while its region rect is not, so
every sprite implies its own scale and Chrome keeps a separately-scaled decode per distinct size.

`scaleDiversity` separates them, and it does so by changing the **fixture**, not the DOM:

| value                  | atlas page                               | effect                                              |
| ---------------------- | ---------------------------------------- | --------------------------------------------------- |
| `per-region` (default) | regions inset by a per-region jitter     | every sprite implies its own `background-size`      |
| `shared`               | regions exactly one grid cell, no jitter | every sprite resolves to the SAME `background-size` |

The sprite geometry is byte-identical either way — same 96×96 boxes on the same grid — so the only
thing that changes is how many distinct scales exist. `shared` gets its own fixture cache stem, so a
run can never silently measure the jittered page.

S3 has the same isolation on its own axis: `nodeSizing=uniform` gives all 20 nine-patch nodes one
size (one scaling of the sheet) against `varied`'s 20 (twenty scalings).

## Scenario S2: `ancestor-rescale` — and the negative result it produced

S1's scene, unchanged, re-scaled 1.0 → 1.2 → 1.0 from JS **every frame** for the whole measured
window. This is the card-focus / 1.2× hover-tip / view-scale shape that produced the regression this
harness was built to catch: 429 ms and 507 ms activation stalls, 1034.8 ms of decode of which 97.6%
fell inside the two focus/unfocus windows, and 40 of 68 images decoded two or more times.

It is **the harness's own acceptance test**. If the instrument cannot reproduce a bug that was
independently traced, it is not measuring the right thing.

Three drivers, because the mechanism matters more than the curve:

| `driver`                | what changes per frame                                                                                                                                                          |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `js-layout` _(default)_ | box sizes and positions in CSS px, so `regionBackgroundStyle` re-derives a new `background-size` — what gsw's own view-scale does (`scaleStyleRecord` rewrites every px length) |
| `js-transform`          | `transform: scale()` written on an ancestor from a rAF callback                                                                                                                 |
| `css-transition`        | the same curve as a compositor-driven `@keyframes` animation — the control                                                                                                      |

A CSS transition alone would have measured nothing: the compositor re-uses the tiles it already
rasterized. Driving the scale from JS forces the paint → raster → decode chain, which is the point.

### It did not reproduce, and that is the finding

**On Chrome for Testing 148 headless / SwiftShader, none of the three drivers re-decodes the atlas.**
Measured across six runs (three drivers × `focusScale` 0.5 and 1.2), page-crop ran the PNG codec
**4 times in every single run**, `decode.redecodeCount` stayed at **3** — the same 3 a completely
static S1 run produces — and **no arm ever produced an activation gap over 100 ms**.

The scale genuinely reaches cc's decode cache. Its keys carry the decode target, and at
`focusScale=0.5` they move between mip levels exactly as the scale changes:

```
focusScale 1.2, js-transform : 104 distinct (src_rect -> target_size) pairs, ALL at mip 1/2
                               e.g. src_rect[3722,880 326x284] -> target_size[163x142]
focusScale 0.5, js-transform : 202 distinct pairs, at mip 1/2 AND mip 1/4
                               e.g. src_rect[831,3683 382x406] -> target_size[96x102]
focusScale 1.2, js-layout    : 473 distinct pairs
                               codec runs: 4 in all three cases
```

So `SoftwareImageDecodeCache` satisfies a new mip level by **re-scaling an existing decode** rather
than re-running the codec. The traced regression is a `GpuImageDecodeCache` behaviour, on the decode
path a real phone uses — exactly the software/GPU split this document warns about under
[Software vs GPU decode cache](#software-vs-gpu-decode-cache--the-portability-trap).

Two things follow, and neither is "the scenario is broken":

- The instrument is **not blind to stalls in general** — S3 produces three activation gaps over
  100 ms on the same box, in the same browser, on the same day. It is blind to _this_ stall because
  the software decode cache cannot produce it.
- S2 is **conclusive on a device run** and inconclusive here, which is why the gate skips exactly one
  relation rather than asserting it (below). Running
  `pnpm perf -- assert --scenario ancestor-rescale --env device` on a phone
  ([Measuring on a real phone](#measuring-on-a-real-phone---env-device)) is the outstanding test that
  settles it, and the gate enforces the relation automatically the moment the report says `gpu`.

What S2 does still measure here is real: page-crop is ready in 25 ms and takes 534 ms to present,
spends 1497 ms in decode against region-blob's 1019 ms, blocks the main thread for 420 ms of LoAF
time at a `mainThreadCpuRatio` of 0.009 (parked, not computing), and paints a 16.78 MP source into a
96 px box at a ratio of 1820×. And the canvas arm inverts under rescale: cheapest of the three when
static, **1944 ms of main-thread time** when every node has to redraw.

### Reference reading (5 repeats + 1 warmup, medians, `driver=js-layout`)

```
metric                             region-blob       page-crop          canvas
------------------------------------------------------------------------------
initialRender ms                           496             538             146
ready ms (JS)                              468           25.00             128
contentUpdate Hz                         59.55           48.23           57.63
activationGap ms p50/p95/max  16.65/18.61/33.69 16.66/16.85/17.03 17.30/20.26/30.88
  gaps > 100 ms                              0               0               0
blocked ms (LoAF)                         0.00             426            0.00
mainThread busy ms                         249             665            1955
mainThread cpu ratio               0.808 (n=2)  0.009341 (n=2)  0.8163 (n=126)
decode ms                                  371            1502           96.89
  decode max ms                          95.56             509           96.89
  codec runs                               112               4               1
  REDECODES (n / ms)                  0 / 0.00        3 / 380        0 / 0.00
  DECODE IN RASTER (n / ms)           0 / 0.00        0 / 0.00        0 / 0.00
raster ms                                  318             283            0.00
  max source:painted                    17.71x           1820x           0.00x
layers                                       4               4              54
presented sampleHits                     50/50           50/50           50/50
```

Compare against `baselines/linux-chrome-148.json` (S1, static): page-crop 534 ms / 1321 ms decode /
3 re-decodes, region-blob 535 ms / 334 ms, canvas 143.7 ms / 96.72 ms. S2 lands within noise of S1 on
every arm — which is the point of the negative result: **continuously re-scaling the whole scene costs
essentially nothing extra in decode on this decode path.**

## Scenario S3: `nine-patch-atlas`

20 nine-patch nodes, 9 slices each, over ONE 4096² sheet, mounted and then rescaled on the same
1.0 → 1.2 curve as S2.

gsw's shipped nine-patch path for an **external** texture URL (`packages/html/src/textures.ts`, the
`if (ninePatch)` block) emits `border-image-source: url(<the whole sheet>)` with a per-node
`border-width` and `border-image-slice … fill`. Every nine-patch node's display list therefore
references the **full sheet**, and the browser scales that sheet into that node's box — so two
differently-sized nodes are two differently scaled draws of one 16 MP image. Pre-existing, shipped,
and never measured before this scenario existed.

The `gsw-nine-patch` arm does not re-derive that CSS. It authors the scene as real `.tscn` text and
runs it through the shipped chain — `parseGodotTextScene` → `deriveSceneGraph` →
`resolveGodotSceneTree` → `renderSceneToHtmlModel` → `mountHtmlScene` — so the DOM under measurement
is the DOM the library produces. A hand-written copy could not drift when the real one does.

| mechanism        | how a node draws its nine slices                                                     |
| ---------------- | ------------------------------------------------------------------------------------ |
| `gsw-nine-patch` | the shipped `border-image` path, referencing the whole sheet                         |
| `slice-blob`     | nine slices baked once per node at destination resolution, nine `<span>` backgrounds |
| `canvas`         | one `<canvas>` per node, nine `drawImage` calls from one `ImageBitmap`               |

The sheet is the **opaque** generated fixture, not the sprite atlas: a nine-patch stretches its centre
slice across the whole node, and an atlas page's transparent gutters would land under the presence
guard's sample points and report a perfectly good render as a blank page.

### Reference reading (5 repeats + 1 warmup, medians)

```
metric                          gsw-nine-patch      slice-blob          canvas
------------------------------------------------------------------------------
initialRender ms                           653             408             225
contentUpdate Hz                         29.60           37.93           60.42
activationGap ms p50/p95/max   16.67/18.73/201 16.65/17.72/217 16.62/17.44/24.35
  gaps > 100 ms                              3               4               0
blocked ms (LoAF)                          517            0.00            0.00
mainThread busy ms                         702             378            1349
mainThread cpu ratio            0.004277 (n=1)    0.9304 (n=1)   0.853 (n=111)
decode ms                                 1209             294             164
  distinct images                            1             181               1
  codec runs                                 3             181               1
  REDECODES (n / ms)                   2 / 388        0 / 0.00        0 / 0.00
paintImage records                        1477           17050               0
  max source MP                          16.78            0.01            0.00
  max source:painted                     1598x           1.00x           0.00x
layers                                       4               4              24
presented sampleHits                     20/20           20/20           20/20
watched image MP                         16.78            0.00            0.00
  paints (total / in window)         1500 / 1496         0 / 0           0 / 0
  distinct painted sizes                      20               0               0
```

Read it as three different failures:

- **`gsw-nine-patch`** halves the frame rate — **29.60 Hz** against canvas's 60.42 — and produces
  **three activation gaps over 100 ms** (max 201 ms) with 517 ms of LoAF blocking, at a
  `mainThreadCpuRatio` of 0.0043 (parked, not computing). Its `watchedImage` row is the diagnosis:
  the 16.78 MP sheet is re-painted **1496 times inside the window at 20 distinct sizes** — one scaling
  per node, re-recorded every frame. It also re-decodes the sheet twice (388 ms).
- **`slice-blob`** removes the big source entirely (`max source:painted` 1.00×, 0 re-decodes) but
  pays 380 ms of JS-visible baking up front and emits **17,050** PaintImage records — nine spans per
  node per frame — which is enough to produce four long gaps of its own.
- **`canvas`** holds 60 Hz with no gaps, and pays for it with 1349 ms of main-thread time and 24
  compositor layers.

That `gsw-nine-patch` and `slice-blob` both stall while `canvas` does not is also the answer to
"can this harness see a stall at all?" — measured on the same box, in the same browser, on the same
day that S2 found none.

## Scenario S4: `large-image-coexistence`

One 2520×1080 opaque background — the stand-in for the consuming project's new host-rendered static
background — beneath S1's sprite grid, with a strip of unrelated content repainted every frame.

The question is not what the image costs to decode once. It is whether anything makes us pay for it
**again**: the trace that motivated this harness had a 275 ms decode running _inside_ a raster task,
and nothing in it said whether the culprit was an atlas page or the new background.

Each half of the claim is measured differently, because Chrome only gives you one of them per image:

- **not re-decoded** — `decode.redecodeCount` and `decode.inRasterCount`. Run-wide: cc keys decodes
  by an opaque pixelRef/content id that carries no URL, so a `0` proves the background decoded once,
  and a non-zero total cannot be attributed. Add `--param mounted=0 --param animated=0` for the
  unambiguous version — with no sprites the background is the only image in the trace.
- **not re-painted** — `watchedImage.paintCountInWindow`. `PaintImage` is the only url-bearing event
  in a Chrome trace, so this is the one honest per-image signal that exists. A record inside the
  measured window means the display list was re-recorded with the background in it, which is what
  precedes a re-raster.

### Reference reading, and what it settles

Sprites + background + 24 churn cells repainted every frame, 5 repeats, medians (worst case for the
`watchedImage` counters):

```
metric                             region-blob       page-crop          canvas
------------------------------------------------------------------------------
decode ms                                  383            1373             132
  distinct images                          127               3               2
  codec runs                               127               6               2
  REDECODES (n / ms)                  0 / 0.00        3 / 379        0 / 0.00
  DECODE IN RASTER (n / ms)           0 / 0.00        0 / 0.00        0 / 0.00
  max source MP                           2.72           16.78            2.72
presented sampleHits                     58/58           58/58           58/58
watched image MP                          2.72            2.72            2.72
  paints (total / in window)             1 / 0           2 / 1           1 / 0
  distinct painted sizes                     1               1               1
```

And the isolation run (`--param mounted=0 --param animated=0`, background alone, so every decode
number belongs to it):

```
decode ms 36.40   decode max ms 33.43   codec runs 1   REDECODES 0   DECODE IN RASTER 0 / 0.00
watched image 2.72 MP   paints 2 / 1   distinct painted sizes 1   presented 8/8
```

So, on this environment:

- **The 2520×1080 background decodes exactly once, for 33 ms, and never re-enters raster.** It is far
  from the discardable decode cache's limit, so **the traced 275 ms in-raster decode was not the
  static background** — it was an atlas page. That was the open question this scenario existed to
  settle.
- It is **not re-decoded** while 24 unrelated elements repaint every frame for 2.5 s, on any arm.
- It is re-**painted** at most once in that window (a single display-list re-record), against 1232 to
  5210 records for the sprites on the same page, and always at one painted size.

## Scenario S5: `static-surfaces` — canvas vs `<img>`, once the drawing is finished

The consuming project renders every static shader and particle system into a per-node `<canvas>`: one
shared WebGL canvas produces a frame, and each node owns a 2D canvas whose entire job is a single
full-canvas `drawImage` of it (`packages/html/src/webgl/runtime.ts`). Canvases were suspected of
costing frame rate, and the standing proposal was to replace them with `<img>` — bake the finished
frame to a blob once and let the browser treat it as an ordinary image.

The question this scenario was built for is **steady state**: once both a canvas surface and an
`<img>` surface have finished rendering, and the DOM has to render other things, which one holds frame
rate? [The bake probe](#the-bake-probe) measures the encode in isolation.

Setup cost is here too, but only as `readyMs`, and only because the `<img>` route's price turned out
to be payable rather than fixed — see [the setup-cost
section](#setup-cost-the-schedule-was-worth-more-than-the-thread). Anything finer-grained about the
encode belongs in the probe.

So: 24 finished 128×128 surfaces, all cut from one shared source canvas, with 24 unrelated cells
repainted every frame beside them.

| mechanism               | how a finished surface is displayed                                             |
| ----------------------- | ------------------------------------------------------------------------------- |
| `canvas-2d`             | per-node `<canvas>` + 2D context + `drawImage` — **today's path**               |
| `canvas-bitmaprenderer` | per-node `<canvas>` + `ImageBitmapRenderingContext` + `transferFromImageBitmap` |
| `img-webp`              | encode once → blob URL → `<img>`                                                |
| `img-png`               | the same, PNG — what the shipped baker emits                                    |
| `img-worker-webp`       | the same, with the encode on a **pool** of workers (`bakeWorkers`, default 4)   |

Three params exist only to keep the setup half of the question honest, and each is discussed below:
`bakeWorkers` (a single worker **loses**; the default is 4), `serialBake` (bake one surface at a time
— reproduces the pre-worker rounds' `readyMs`), and `sharedFrames` (every surface shows **one** frame,
which is the destination shape and the run whose trace counts codec runs).

`updateEveryMs` is the second axis. `0` is the strictly-static case: `step()` touches only the churn
strip and the surfaces are never redrawn. A non-zero value regenerates each surface on that cadence,
staggered — the canvas arms redraw, the `<img>` arms must **re-encode**. That distinction turns out to
decide the whole answer.

There is deliberately **no `perf assert` gate**. Nobody had a hypothesis here worth encoding as a
relation, and writing one from desktop intuition is exactly what S2's gate did before a device run
contradicted three of its five relations.

### Reference reading — strictly static (`updateEveryMs=0`)

Desktop, 1280×800, 5 repeats + 1 warmup, medians:

```
metric                             canvas-2d  canvas-bitmaprenderer     img-png    img-webp  img-worker-webp
------------------------------------------------------------------------------------------------------------
initialRender ms                         136                    139         172         164              171
ready ms (JS)                            126                    130         165         161              169
contentUpdate Hz                       60.32                  60.12       59.91       60.01            60.14
frameCost ms p50/p95/max      0.92/1.09/7.82         0.69/0.86/1.03 0.70/0.83/1.11 0.70/0.83/1.16  0.69/0.84/1.01
layers                                28 (!)                     28           4           4                4
cpu ALL PROCESSES ms (>=)                500                    421         380         401              386
  renderer cpu ms                        322                    259         242         245              248
  gpu cpu ms                             134                    119         104         108              106
codecRuns                                  1                      1          25          25               25
presented sampleHits                   24/24                  24/24       24/24       24/24            24/24
```

**`layers` is not stable for `canvas-2d` on this desktop and the `(!)` says so.** The same arm, same
params, read **28**, then **4**, then **28** across three runs; `canvas-bitmaprenderer` read 28 in all
three. Chrome's canvas layer promotion is a heuristic over how recently a canvas was drawn into, and a
surface painted once at mount and then never touched again sits exactly on that edge. The phone reads
31 against 6 in **four separate runs**, so the layer claim rests on the device numbers; the desktop
column is evidence about desktop only, and one desktop run is not enough to make it.

The desktop `<img>` arms are all within 8 ms of each other and the worker arm is the slowest of them
(169 against 161). That is expected rather than contradictory: on a 12-core desktop where a 128²
encode costs ~2 ms, the worker round trip is most of the arm. The worker question is a phone question,
and the phone is where it is answered.

Phone (moto g86 5G, Chrome 151, 790×1484 @ DPR 3.4876 fitted, grid 4×6, battery 100%, thermal `none`
throughout). This table is the **current default schedule** — all bakes issued concurrently, four
encoder workers on the worker arm; the setup rows under the previous one-at-a-time schedule are in
[the setup-cost section](#setup-cost-the-schedule-was-worth-more-than-the-thread):

```
metric                             canvas-2d  canvas-bitmaprenderer     img-png    img-webp  img-worker-webp
------------------------------------------------------------------------------------------------------------
initialRender ms                        1003                   1028        1498        1529             1342
ready ms (JS)                            981                   1009        1492        1494             1312
contentUpdate Hz                       86.73                  87.18       90.00       88.76            89.71
frameCost ms p50/p95/max      3.32/4.63/7.40         3.21/4.76/7.22 2.85/4.06/6.66 3.43/4.88/10.73  3.48/4.79/7.94
activationGap ms max                   93.01                  72.79       20.63       24.70            20.68
layers                                    31                     31           6           6                6
renderSurfaces                             4                      4           0           0                0
cpu ALL PROCESSES ms (>=)               4527                   4604        4327        4740             4788
  renderer cpu ms                       1820                   1822        1598        1930             1946
  gpu cpu ms                            2509                   2482        2469        2579             2617
  clear/fill ms (GPU)                   140.4                  139.4       29.49       44.83            44.36
REDECODES (n / ms)                  0 / 0.00               0 / 0.00 19 / 18.87   4 / 6.96         7 / 8.22
presented sampleHits                   24/24                  24/24       24/24       24/24            24/24
```

**When the surfaces really never change, `<img>` wins the compositor metrics on both environments.**
On the phone: 88.8–90.0 Hz against 86.7, **6 compositor layers against 31**, zero render surfaces
against four, a GPU clear/fill bill of 29–45 ms against 140, and a worst activation gap of 21–25 ms
against 93. It pays for that with `readyMs`, which is the encode, once — and which
[a worker pool cuts by 12%](#setup-cost-the-schedule-was-worth-more-than-the-thread).

**Total CPU does not separate the arms, and an earlier reading of this table over-claimed that it
did.** The previous round measured `img-webp` at 4,353 ms against `canvas-2d`'s 4,690 and reported "8%
less total CPU"; three later runs measure that arm at 4,801, 4,740 and `canvas-2d` at 4,600, 4,527.
`img-png` is reproducibly the cheapest (4,322 / 4,379 / 4,327), but the webp arms swing ~10% between
runs, which is larger than the gap being claimed. The metrics that **do** reproduce across every run
are `layers`, `renderSurfaces`, `activationGapMs.max` and GPU clear/fill — those carry the verdict;
total CPU does not.

### And the reading that inverts it — occasional update (`updateEveryMs=2000`, 6 s window)

Each surface regenerates every 2 s, staggered. Same 24 surfaces, same churn.

```
PHONE                              canvas-2d  canvas-bitmaprenderer     img-png    img-webp  img-worker-webp
contentUpdate Hz                       88.63                  88.86       88.27       88.00            89.60
frameCost ms p50/p95/max      3.30/4.95/8.96         3.26/4.66/8.08 3.63/17.60/23.52 3.38/18.00/24.02 3.47/6.42/12.55
mainThread busy ms                      1810                   1792        2982        2934             2046
mainThread cpu ratio           0.9521 (n=10)           0.9516 (n=7) 0.3259 (n=81) 0.3047 (n=81)   0.4880 (n=14)
cpu ALL PROCESSES ms (>=)              11220                  11400       11920       12510            12450
REDECODES (n / ms)                  0 / 0.00               0 / 0.00 86 / 108.90  70 / 80.74      72 / 121.40
layers                                    31                     31           6           6                6
```

Two earlier readings of this table (same phone) measured `img-webp` at 87.95 and 88.50 Hz, p95 18.53
and 17.73 ms, main-thread busy 2,904 and 2,865 ms — i.e. it reproduces, including across the encoder
correction below.

```
DESKTOP                            canvas-2d  canvas-bitmaprenderer     img-png    img-webp  img-worker-webp
cpu ALL PROCESSES ms (>=)               1190                   1004        1174        1288             1288
mainThread busy ms                       367                    275         366         333              320
frameCost ms p50/p95/max      0.93/1.24/7.00         0.66/1.31/1.62 0.73/1.83/2.11 0.72/1.73/2.02  0.73/1.52/1.82
REDECODES (n / ms)                  0 / 0.00               0 / 0.00    7 / 1.68    5 / 1.48         6 / 1.65
```

**A 2-second update cadence reverses the verdict for the plain `<img>` arms.** Their frame-cost p95 is
~3.7× worse than either canvas arm (18.0 ms against 4.9), their main thread is busy for 2,934 ms
against 1,792, and they re-decode 70–86 times where the canvas arms re-decode zero.

**And the worker pool very largely repairs it.** `img-worker-webp` holds p95 at **6.42 ms** against
`img-webp`'s 18.00 and `canvas-2d`'s 4.95, and main-thread busy at **2,046 ms** against 2,934 — most
of the way back to the canvas arms. The re-encode did not get cheaper; it stopped happening on the
thread that produces frames.

What it does **not** fix is aggregate cost: at 12,450 ms of total CPU it is within noise of
`img-webp`'s 12,510 and ~11% above the canvas arms' 11,220. The work moved across cores; it did not go
away. On a phone that is a battery question, not a frame-rate one, and the two point in opposite
directions here.

So the answer is conditional, and the conditions are now three rather than two:

- **Surfaces genuinely frozen for the life of the node** → `<img>`. The layer count alone (6 vs 31)
  justifies it, and with a worker pool the mount cost is 1,312 ms against `canvas-2d`'s 981.
- **Surfaces that change occasionally, where frame pacing is what matters** → `<img>` **plus a worker
  pool**. Without the pool this line said "keep the canvas"; with it, p95 and main-thread busy come
  back to the canvas arms' range.
- **Surfaces that change occasionally, where total CPU is what matters** → keep the canvas. Every
  `<img>` arm, worker or not, costs ~11% more CPU across all processes at a 2 s cadence.
- The mirror's "static" shaders are static only until game state changes them, so they sit on the
  second or third line depending on which cost is being optimised — never the first.

### `canvas-bitmaprenderer`: a measured null result worth having

`bitmaprenderer` is used **nowhere** in this repo or the consuming frontend, while the per-node blit is
exactly what `ImageBitmapRenderingContext` is for. In isolation it is dramatically cheaper — the probe
measured the blit for 50 nodes at **24 ms** for `2d drawImage` against **0 ms clone + 4 ms transfer**
for bitmaprenderer, a 6× gap.

In the scenario that gap almost vanishes: 4,708 ms of CPU against `canvas-2d`'s 4,690 on the phone —
inside the noise — and **31 layers either way**. Which is the point, and it is why the arm exists:
`bitmaprenderer` removes the 2D drawing context, **not the canvas element or its compositor layer**,
and in steady state the layer is the cost. Under update it is the cheapest arm on both environments
(desktop 1,038 ms; phone 11,290 ms), so it is never worse — just not the win the blit numbers imply.

`transferFromImageBitmap` **neuters its source**, so every node needs its own `ImageBitmap` and the
clone is part of the price. The scenario charges it inside the arm rather than hoisting it, because a
shared cache of bitmaps cannot be transferred to N nodes — and `webgl/runtime.ts`'s `staticFrameCache`
holds `HTMLCanvasElement`, so adopting this would mean changing what that cache stores.

### Setup cost: the schedule was worth more than the thread

`readyMs` is where the `<img>` route pays, and the follow-up question was whether the phone's other
seven cores could pay it instead. Three schedules, measured, on the phone:

PHONE (`serialBake=true` against the default), all arms encoding lossless webp:

| arm                    | one at a time | all issued at once |
| ---------------------- | ------------- | ------------------ |
| `canvas-2d`            | 987           | 981                |
| `img-png`              | 1,960         | **1,492**          |
| `img-webp`             | 1,870         | **1,494**          |
| `img-worker-webp` (×4) | 2,009         | **1,312**          |
| `img-worker-webp` (×1) | —             | 1,831              |

DESKTOP, same pair of schedules:

| arm                    | `serialBake=true` | concurrent |
| ---------------------- | ----------------- | ---------- |
| `img-png`              | 514               | **165**    |
| `img-webp`             | 206               | **161**    |
| `img-worker-webp` (×4) | 218               | 169        |

The desktop `serialBake` column reproduces the previous round's committed baseline (505 and 205)
to within 2%, which is what makes the rest readable: the schedule is the only thing that changed.

- **Issuing the bakes concurrently costs nothing and is worth more than the worker.** Phone: 1,870 →
  1,494 ms; desktop PNG 514 → 165, a 3.1× cut. Chrome's `toBlob` genuinely overlaps, and a `for` loop
  that awaited each bake was leaving that on the floor.
- **A worker pool is unmeasurable without it — and this is the trap the round was designed around.**
  Under `serialBake` the four-worker arm is the _slowest_ row in the table (2,009 ms), because the
  main thread sits idle across every round trip. Concurrent, the same arm is the _fastest_ (1,312).
  Had the schedule not been made a parameter, the round would have reported a confident null result
  that the schedule manufactured.
- **One worker loses.** 1,831 ms against 1,494 inline on the phone, and the probe's `worker-webp x1`
  reproduces it independently. `toBlob` is _already_ partly off-thread, so a single worker adds a
  round trip rather than a core. This is why `bakeWorkers` defaults to 4: shipping 1 would publish the
  degenerate case as the proposal.
- **Four workers wins, and keeps what the `<img>` route was chosen for.** `readyMs` 1,312 — 12% under
  the fastest inline `<img>` arm — with `layers` still 6, `renderSurfaces` still 0 and
  `presented.sampleHits` 24/24. Those have to be read together: an arm that got fast by falling back
  to canvas would win `readyMs` and lose the entire point.
- The remaining gap to `canvas-2d` is ~330 ms, down from ~890.
- **Desktop does not reproduce the win** (169 against 161), and should not be expected to: a 128²
  encode there costs ~2 ms, so the round trip is most of the arm. This is a phone result.
- `serialBake=true` is kept so the earlier rounds' numbers stay **reproducible** rather than merely
  remembered.

### `sharedFrames`: 24 nodes, one image — one decode, counted rather than inferred

The probe's [`share` phase](#share-24-nodes-one-image--a-proxy-and-labelled-as-one) can only show
that a shared blob URL decodes faster. This run counts codec runs in the trace.

| run                                      | `codecRuns` | `distinctImages` | `readyMs` |
| ---------------------------------------- | ----------- | ---------------- | --------- |
| default (24 distinct frames), `img-webp` | 25          | 25               | 1,450     |
| `sharedFrames=true`, `img-webp`          | **2**       | **2**            | 1,042     |
| `sharedFrames=true`, `img-worker-webp`   | **2**       | **2**            | 987       |

**The `readyMs` column here predates the [encoder-parity
fix](#toblob-and-converttoblob-are-not-the-same-call-and-a-previous-round-said-they-were)**, so its
`img-webp` row is lossy webp and is not comparable with the corrected tables above; the phone came off
adb before it could be re-measured. `codecRuns` and `distinctImages` — which is what this section
exists for — count decode operations and do not depend on the encoder's quality setting.

25 is 24 surfaces plus the atlas page the frames are cut from — the canvas arms read 1, the atlas
alone. So 24 nodes showing one image decode it **once**: 2 is the atlas plus the single shared frame.
`readyMs` falls for the same reason — one encode instead of 24 — which is the direction that matters
even though the exact figure wants re-measuring.

Two things to carry with that number:

- **`presented.nonEmptyRatio` changes** when every surface shows the same frame (0.4234 → 0.6563), so
  a `sharedFrames` run is comparable only to another `sharedFrames` run.
- **The `img-worker-webp` shared row read 59.90 Hz** where every other row on this phone reads ~89.
  That is the **panel, not the page**: `swapRateHz` was 59.50 and the activation gap p50 was 16.58 ms,
  so the display had dropped to 60 Hz and the page produced a frame for every vsync it was offered.
  When `contentUpdateHz` moves, check `swapRateHz` before blaming the code — a variable-refresh panel
  will move both together, and a real regression moves only the first.

## Scenario S6: `effects-runtime` — is it the CPU sim?

**THE QUESTION.** On the moto g86 5G, live **particles** feel slow with only a handful of systems on
screen. Live **shaders** do not. The suspicion is the CPU particle simulation
(`packages/effects/src/particles/simulate.ts`), which integrates every particle of every system on the
main thread every tick — but a particle frame is **four** things: the sim, the instance-buffer build,
the instanced GL draw, and the GL→2D blit onto the node's canvas. On top of those sits whatever it
costs merely to keep N composited canvases on screen. "Particles are slow" names none of them, and no
metric this harness collects separates them on its own.

So S6 separates them **by construction**, with four arms over the **real shipped runtimes**
(`createParticleRuntime` and `createWebglShaderRuntime` from `packages/html`) — measuring a
re-derivation would measure the wrong code, exactly as S1's `page-crop` arm calls the shipped
`regionBackgroundStyle` rather than a copy of its crop math.

12 systems of 64 particles each, one per 96 px cell, plus a small strip of unrelated cells recoloured
every frame beside them.

| arm                | what runs per tick                                                                                                                                           | what it isolates                     |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------ |
| `particles-live`   | sim (fixed 30 Hz) + instance build + instanced GL draw + blit                                                                                                | the real thing                       |
| `particles-simcap` | the **identical spec** at `fixedFps: simCapHz` (default 1) — one sim step per second instead of thirty, every particle still alive, draw path byte-identical | `live − simcap` is the CPU sim       |
| `particles-frozen` | the identical spec again with `staticParticles: true` — each system is warmed and drawn **once**, then the loop PARKS                                        | the compositing floor                |
| `shaders-live`     | the WebGL shader runtime at the same cell count and the **same canvas pixel count**, running a `TIME`-driven shader: GL draw + blit, no CPU sim              | particles vs shaders at equal pixels |

### What each arm has to prove

- **`particles-simcap` must draw the same picture as `particles-live`.** The spec is identical apart
  from one field, and `test/scenarios.test.ts` asserts exactly that (both specs, several indices,
  deep-equal after deleting `fixedFps`). `fixedFps` is the only knob in the whole spec that can
  suppress the sim while leaving the draw path byte-identical: `simulateParticles` steps
  `while (remainder >= 1/fixedFps)`, and `normalizeParticleConfig` reads `fixedFps: 0` as Godot's
  default 30.
- **…and it must draw the same NUMBER of particles.** A slot dies the step its age reaches `lifetime`
  and is reborn only when the cycle clock next crosses its birth phase, so the fraction of slots
  momentarily dead is one sim step per lifetime. That is why `lifetime` is **32 s** and not the two
  seconds a normal-looking spray would use: measured against the real simulation, `lifetime=2` gives
  63 active particles live against **32** under a 1 Hz cap — the "sim cost" would silently have half
  the draw cost inside it — while `lifetime=32` gives 64 against 62. Velocities are derived from a
  travel budget (half a cell over one lifetime) so the spray still fits its canvas, and per-step sim
  cost depends on neither lifetime nor velocity, so nothing being measured moves.
- **`particles-frozen` must really park.** It draws once per binding and never re-arms, which is also
  why the scenario carries the churn strip: with zero layer activations the report validator rejects
  `contentUpdateHz <= 0` as "nothing was measured", and a correct frozen run would be thrown out as a
  broken one.
- **`shaders-live` must be the same pixels.** Its node box is the particle cell **plus the runtime's
  own canvas pad** (`spriteExtentPad + emissionExtentPad`, imported from `packages/html` rather than
  copied), so both runtimes produce a canvas of identical size centred on the same point. Its shader
  reads `TIME`, because the shader runtime only re-renders a binding whose program `usesTime` — a
  static shader would render once, park, and re-measure the frozen arm.

### The verdict arithmetic

```
CPU sim         ≈ (live − simcap) × 30 / (30 − simCapHz)
draw pipeline   ≈ simcap − frozen          (instance build + instanced GL draw + blit)
compositing floor ≈ frozen                 (N canvases on screen, nothing redrawing them)
shader tick     ≈ shaders-live − frozen    (GL draw + blit at the same canvas pixel count)
```

The scale factor is the point of the `simcap` arm: it does not stop the sim, it runs it
`simCapHz`/30 as often, so the difference between the arms is `(30 − simCapHz)/30` of the sim's cost
and has to be scaled back up. At the default `simCapHz=1` that factor is 30/29 ≈ 1.034.

Then the answer to the question the scenario was built for is the comparison of the first two lines
against the fourth: if `CPU sim` dominates `draw pipeline`, the fix is the simulation (fewer
particles, a lower `fixedFps`, a worker); if `draw pipeline` dominates, the fix is the canvas/blit
path and `renderScale`; if `shaders-live − frozen` is close to `simcap − frozen`, then particles and
shaders cost the same to draw and everything above the floor is the sim.

### The `scenario.*` counters, and the two things they exist to prove

S6 turns on `effectsProfiling`, so both runtimes attribute each tick's main-thread cost to its own
buckets (`ParticleProfile` / `ShaderProfile` in `packages/html`), and the scenario reports them
through `Scenario.metrics` as `scenario.<key>` rows in the table. Everything is a **window delta** —
snapshotted on the first `step()` and read after the window closes — except the two marked _life_,
which are about what happened at mount.

| key                               | arms     | what it is                                                                                            |
| --------------------------------- | -------- | ----------------------------------------------------------------------------------------------------- |
| `particleDraws`                   | particle | `drawBinding` calls that reached `drawParticles` (never a cache-hit blit or clear-only)               |
| `particleCacheHits`               | particle | frozen-mode static-frame cache hits                                                                   |
| `simSteps`                        | particle | fixed sub-steps `simulateParticles` executed — **the** sim work unit                                  |
| `instances`                       | particle | particles pushed into the GL instance buffer ≈ particles actually drawn                               |
| `simMs` / `buildMs`               | particle | CPU simulation / instance-buffer build                                                                |
| `glMs` / `blitMs`                 | both     | GL submit (issue cost only, never GPU time) / the GL→2D blit                                          |
| `profTicks` / `profBindings`      | both     | loop ticks that did work, and bindings summed across them                                             |
| `shaderDraws` / `shaderCacheHits` | shader   | the shader runtime's equivalents                                                                      |
| `renderedNodes` _(life)_          | all      | distinct bindings that have ever drawn — `ready()`'s own gate, and the "was every cell alive?" answer |
| `boxReads` _(life)_               | particle | forced `clientWidth` layouts; the claim is about the CREATE path, which happens before the window     |

Keys are **per arm and never zero-filled** — a particle arm reports no `shaderDraws` and vice versa,
because an absent key means "not measured" and a fabricated `0` cannot be told apart from a measured
one. The same rule is why every profile key disappears if `effectsProfiling` is ever off: the runtime
returns `profile: null` rather than a zeroed object, and this scenario passes that through.

Two arms are only believable because of these counters:

- **`particles-frozen` really parked.** `profTicks` must be **0** and `particleDraws` ≈ **0** across
  the window: the arm draws its whole set during `ready()`, and after that the loop returns without
  re-arming. The churn strip keeps producing layer activations the whole time, so `contentUpdateHz`
  alone cannot tell "the loop parked" from "the loop is running and cheap" — the churn cells are DOM
  recolours, not particle draws, and only `particleDraws` separates them.
- **`particles-simcap` capped the sim and ONLY the sim.** `simSteps` must collapse to about
  `systems × simCapHz × windowSeconds` (12 × 1 × 2.5 ≈ 30) while `particleDraws` keeps ticking at
  display rate — roughly `systems × frames`, the same order as the live arm's. Both halves are
  needed: a `simSteps` drop on its own is equally consistent with an arm that quietly stopped
  drawing, which is precisely the failure the `speedScale: 0` trap below produces.

- **…and it drew the same picture while doing it.** `instances / particleDraws` is the live particle
  count per draw, and the [equal-instance-count law](#what-each-arm-has-to-prove) is exactly the
  claim that the two arms agree on it. The desktop smoke run reads **63.99** on `particles-live`
  against **62.00** on `particles-simcap` — the 3% the 32-second lifetime was chosen to get down to,
  now measured by the harness rather than argued from the simulation offline. At the two-second
  lifetime this ratio would read ~64 against ~32, and that is what the check is for.

And one that holds for every particle arm: **`boxReads` 0**, i.e. the runtime's observer-driven
sizing took every binding's first box from the ResizeObserver and the create path forced no layout at
all.

### Traps

- **`speedScale: 0` is not a simcap arm.** It looks like the obvious way to freeze the sim and
  silently measures an empty page: the remainder never reaches a step boundary, so no slot is ever
  restarted, every particle stays inactive, and `drawBinding` takes its clear-only path — no instance
  build, no `drawParticles`, no `onBindingRendered` — while the binding still counts as live (it is
  still `emitting`) and the loop keeps spinning over nothing. The arm would report an excellent frame
  rate for a blank canvas. Use `fixedFps`.
- **An FPS cap cannot reduce sim cost, and the run that proves it is `--param fps=30`.** The
  simulation is a fixed-step consumer of _simulated_ time: skipping a tick does not skip the steps,
  it hands the next tick a larger `dt`, and `simulateParticles` then runs the steps it owes in one
  go. Capping the loop halves the number of draws and leaves the sim's total work where it was, which
  is exactly what `fps=30` against `fps=0` should show — and if it does not, one of the two readings
  is wrong.
- **Read the main thread, not the frame cost.** `cpu.byThread`'s `Renderer/CrRendererMain` row is the
  honest number here. `frameCostMs.p50` is bimodal on this scenario: at 60 Hz with a 30 Hz sim, every
  other frame carries a sim step and the one between it does not, so the median lands on whichever of
  the two humps happened to hold more samples and can move without anything changing.
- **Desktop is SwiftShader, so the GL half of every arm is CPU work that does not exist on the
  phone.** `--env ci` is a smoke test for this scenario: it proves the four arms mount, render and
  report. Only `--env device` answers the question, because "the GL draw is expensive" is true by
  construction under a software rasteriser and is precisely what is in doubt on a real GPU.
- **This scenario draws untextured particles** (the runtime's built-in procedural dot) and no atlas
  regions. Sprite-sheet decode and texture upload are an explicit **non-goal** — a different
  question, for a different scenario. It also declares no `regions`/`atlasPage` params, so it reuses
  S1's cached fixture instead of generating a second 15 MB atlas page it never reads.
- **`decode tasks: 1` is the scenario, not a broken matcher.** S6's page paints no images at all — GL
  canvases and solid colours — and `validateReport` rejects `decode.count === 0` outright, because
  for every other scenario a zero there means the cc decode-cache event names have drifted. So the
  stage carries one 8×8 generated PNG in a corner, painted once, purely so the trace has a real
  decode of a real painted image to match (`decodeCanaryUrl`). It sits on the container rather than
  on the churn cells for a measured reason: a cell that repaints every frame re-decodes its
  background with it (150 decode tasks and 8 ms for the same one image), and this scenario has no
  reason to pay that.

### Reference reading

**moto g86 5G, Android 15, Chrome 151, Mali-G615 (ANGLE) — 2026-08-20, 5 repeats, medians, ~2.5 s
window, defaults (12 systems × 64 particles, cellPx 96, uncapped).** The desktop run this scenario
was smoke-tested on is a SwiftShader reading and is deliberately NOT published here: it would put a
GL cost that does not exist on the phone next to numbers that do (see the traps above).

| metric                         | particles-live | particles-simcap | particles-frozen | shaders-live |
| ------------------------------ | -------------- | ---------------- | ---------------- | ------------ |
| initialRender ms               | 528.7          | 290.1            | 975.4            | 417.2        |
| ready ms (JS)                  | 521.6          | 286.9            | 959              | 409.4        |
| contentUpdate Hz               | 47.07          | 48.23            | 89.02            | 47.28        |
| renderer CrRendererMain cpu ms | 673            | 596              | 703              | 537          |
| gpu-process cpu ms             | 3494           | 3480             | 2584             | 3505         |
| layers                         | 19             | 19               | 19               | 19           |
| scenario.simSteps              | 876            | 24               | 0                | —            |
| scenario.simMs                 | 71.9           | 6.7              | 0                | —            |
| scenario.buildMs               | 15.6           | 14.1             | 0                | —            |
| scenario.glMs                  | 62.6           | 58.1             | 0                | 34.5         |
| scenario.blitMs                | 353.2          | 350.5            | 0                | 324.6        |
| scenario.particleDraws         | 1392           | 1428             | 0                | —            |
| scenario.profTicks             | 116            | 119              | 0                | 117          |

The `scenario.*` rows are the arms' own evidence, not a second opinion on the trace: `simMs` +
`buildMs` + `glMs` + `blitMs` is the main-thread tick taken apart into the four buckets the verdict
arithmetic infers from arm differences, and the two agreeing is the check that both are right (here:
live − simcap on `CrRendererMain` is 77 ms against a 65 ms `simMs` delta). The frozen arm's **0**
profiled ticks is a claim, not a reading: a run where it is non-zero is a run whose frozen arm never
froze.

### The verdict (moto g86 5G, 2026-08-20)

**It is not the CPU sim.** At 12 systems × 64 particles the sim costs 71.9 ms of a 2 507 ms window —
under 3% of one core, cross-validated by the arm arithmetic above. The four-bucket split puts the
main-thread cost in the blit (353 ms, ~5× the sim), and even the whole instrumented particle tick
(~503 ms) is a minority of what the phone is actually spending: the **GPU process** runs ~3.5 s of
CPU inside the 2.5 s window (`CrGpuMain` at 0.90 of a core — saturated) on particles-live,
particles-simcap **and shaders-live alike**, and both live pipelines drag the whole page from the
~89 Hz the frozen arm proves the compositor can do down to ~47 Hz. "Shaders and particles are slow"
is one fact, not two: the per-node canvas pipeline (WebGL draw → canvas blit → composite N canvases
per frame) saturates the GPU process regardless of what fills the canvas.

The cross-checks, run the same day:

- **`--param fps=30`**: `simSteps` does NOT drop (912 vs 876 — the sim is a fixed-step consumer of
  simulated time, exactly as the trap section predicts), but draws halve, `blitMs` falls 353 → 240,
  GPU-process CPU falls 3 494 → 2 937 ms, and — the actionable part — **whole-page activations
  recover to 88 Hz** (frameCost p50 5.9 → 1.28 ms) with effect content updating at 30 Hz inside
  them. The cap does not buy back the sim; it buys back the page.
- **`--param amount=16`**: `simMs` 71.9 → 22.4 and `instances` scale linearly (89 052 → 22 644), but
  `blitMs` stays at 347 and the page stays at 47.6 Hz. Shrinking the particle count 4× does not
  move the felt rate at all — per-canvas cost, not per-particle cost, is what the phone pays.

What this licenses: `particleFps`/`shaderFps` caps (and the existing frozen/static modes) are the
levers that move this phone; `amount` and sim micro-optimization are not, below several hundred
particles per system. What it does not license: conclusions about spawn-heavy or
several-hundred-particle scenes (`simMs` scales with `amount`, so at ~512 the sim would be a ~20%
main-thread tenant), about additive `blend=1` (unmeasured here), or about any device whose GPU
process is not the saturated resource.

### Running it

```bash
# all four arms, medians over 5 repeats
mise exec -- pnpm perf -- --scenario effects-runtime

# the question, on the phone that raised it
mise exec -- pnpm perf -- --env device --scenario effects-runtime

# the cross-check that an FPS cap does NOT buy back the sim
mise exec -- pnpm perf -- --env device --scenario effects-runtime --param fps=30

# what the per-particle ramp/curve chain in updateDisplay costs
mise exec -- pnpm perf -- --env device --scenario effects-runtime --param overLife=none

# additive blending: a second accumulate+resolve pass in render-webgl
mise exec -- pnpm perf -- --env device --scenario effects-runtime --param blend=1

# one arm, longer window
mise exec -- pnpm perf -- --scenario effects-runtime --mechanism particles-live --duration 6000
```

There is deliberately **no `perf assert` gate**, and this time the reason is on the record: a gate is
written FROM device readings, and S2's was written from desktop intuition — a device run then
contradicted three of its five relations (see [FU-2](#fu-2-settled-the-s2-gate-fails-on-the-phone--reported-as-measured)).
The arithmetic above is what a gate would encode; it gets encoded once the phone has said what the
numbers are.

## Scenario S7: `effects-webgpu` — would WebGPU help?

**THE QUESTION.** S6 answered "is it the CPU sim?" with **no**, and in doing so indicted something
else. Its numbers, on the moto g86 5G: the simulation costs **71.9 ms** of a 2 507 ms window (under
3% of a core); the main-thread tick splits `simMs 71.9 / buildMs 15.6 / glMs 62.6 / blitMs 353.2`;
the **GPU process** runs ~3.5 s of CPU inside that 2.5 s window (`CrGpuMain` at **0.90 of a core** —
saturated) on `particles-live`, `particles-simcap` **and `shaders-live` alike**; and both live
pipelines drag whole-page activations from the **89 Hz** the frozen arm proves the compositor can do
down to **47 Hz**. The cost is not in what fills the canvas. It is in the pipeline that gets a canvas
onto the screen: one shared offscreen WebGL canvas → a `ctx2d.drawImage` blit per node → N composited
canvases, every frame.

That leaves exactly two follow-up questions, and they have to be asked separately:

1. does **WebGPU** cut the main-thread submit cost (S6's `glMs`)?
2. does rendering **directly into N canvases**, with no blit at all, relieve the GPU process?

### PROBE, NOT PRODUCT

Every other scenario here mounts shipped code, and measuring a re-derivation is the failure they
exist to avoid — S1's `page-crop` arm calls the shipped `regionBackgroundStyle` rather than a copy of
its crop math. S7 carries its own renderer anyway, and the licence is narrow: **the subject is an API
and an architecture that do not exist in this codebase.** There is no shipped WebGPU path to mount,
and pricing one before writing it is the only way to find out whether writing it is worth doing.

What is **not** re-derived is everything above the renderer:

- the **CPU simulation** is `simulateParticles` / `preprocessParticles`, imported;
- the **instance packing** writes the shipped `InstanceBuffer` at the shipped `INSTANCE_STRIDE`, with
  the shipped push expressions and the shipped `!active || a <= 0` skip;
- the **canvas pixel counts** come from the shipped `backingStoreSize` and `effectivePixelRatio`;
- the **geometry, spec, churn strip and decode canary** are S6's exported helpers, called directly.

So only the renderer differs. A probe that re-derived the sim or the sizing would be comparing two
workloads and calling the difference an API.

The renderer-independent simulation and packing seam lives in `@godot-scene-web/core`; HTML owns
only DOM/runtime behavior. No WebGPU concept enters either package's public HTML surface — every
line of the probe renderer lives in `packages/perf-harness/src/scenarios/webgpu/`.

If the answer is "no win", **S7 stays** as the measured record of a road not taken. A negative result
that cost a day is worth more than the same question re-asked every six months.

### The five arms

12 systems × 64 particles, one per 96 px cell, plus S6's churn strip — the same stage, the same
cells, the same canvas pixel count on every arm.

| arm                     | renderer                             | how pixels reach the node                                                                      | what it is for                                         |
| ----------------------- | ------------------------------------ | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `particles-webgl`       | shipped `createParticleRuntime`      | shared GL canvas → `drawImage` blit → per-node 2D canvas                                       | the **in-session reference**                           |
| `particles-webgpu`      | WGSL port, imported sim + packing    | **directly** into each node's own `GPUCanvasContext`                                           | the API _and_ the missing blit, together               |
| `particles-webgpu-blit` | the identical WGSL pipeline          | one shared WebGPU canvas, N `setViewport` sub-rects in one pass → the same N `drawImage` blits | the shipped **architecture** with only the API swapped |
| `shaders-webgl`         | shipped `createWebglShaderRuntime`   | shared GL canvas → blit → per-node 2D canvas                                                   | S6's `shaders-live`, in session                        |
| `shaders-webgpu`        | WGSL port of `EFFECTS_SHADER_SOURCE` | directly into each node's own canvas                                                           | the same pair, with no simulation at all               |

The middle arm is the one that makes the table decomposable. Without it, `particles-webgpu` versus
`particles-webgl` changes **two** things at once — the API and the blit — and any difference could be
attributed to either.

### What each arm has to prove

- **The same pixels.** Every arm's canvas is `cellPx + 2×pad` CSS px on a side, where `pad` comes
  from the runtime's own `spriteExtentPad + emissionExtentPad`, and its backing store comes from the
  shipped `backingStoreSize(css, css, effectivePixelRatio(renderScale))`. `test/effects-webgpu.test.ts`
  holds S7's `stageSize` / `gridShape` / `samplePoints` / `effectsCellBox` against S6's across three
  viewports and three `systems` counts, and holds the sizing helper against `backingStoreSize`
  directly. The 16 px sprite the untextured dot draws is the runtime's module-private `DEFAULT_DOT`,
  which cannot be imported — so the guard is `effectsCanvasPad(defaults) === ceil(hypot(16,16)/2)`,
  which fails the moment the runtime moves it.
- **The same particles.** The spec is S6's `effectsSpec` verbatim, deep-equal per index, and every
  arm carries `fixedFps: 0` (uncapped). S7 does not declare `simCapHz` or `pacing` at all: it
  compares renderers, and a capped sim on one arm would put a workload difference inside a renderer
  comparison.
- **The same bytes.** `packSystem` is the shipped `drawBinding` build loop, restated because the
  shipped one has no seam between "pack" and "draw". A test runs a hand-built particle list — with
  one `active: false` and one `a: 0` — through it and compares the resulting `Float32Array` element
  by element.
- **The same shader, in two languages.** A test extracts every float literal from
  `EFFECTS_SHADER_SOURCE` by regex and requires each to appear in `SHADER_WGSL`, so editing the Godot
  shader without editing the port fails the suite.
- **The arm did what its name says.** `passes`, `submits`, `draws` and `blits` are counted where they
  happen: the direct arms must show N passes and **1 submit** per tick, the blit arm **1 pass**, 1
  submit and N blits. An arm that quietly fell back to a different shape is visible in the table
  rather than inferred from a frame time.
- **The arm is valid at all.** `adapterFallback`, `gpuErrors`, `deviceLosses` — see below.

### Premultiplied alpha, and why it is not a detail

A `GPUCanvasContext` offers only `alphaMode: "opaque" | "premultiplied"`. There is no straight-alpha
canvas, so the WGSL fragments **return premultiplied** (`vec4f(col.rgb * col.a, col.a)`) and both
pipelines blend `one / one-minus-src-alpha` on colour **and** alpha.

**The WebGL path now states the same contract**, rather than a mirror-image one. Its shared canvas
declares `premultipliedAlpha: true` (`webgl/shared-gl.ts`), `effects/src/shaders/godot-shader.ts` emits the same
`fragColor = vec4(COLOR.rgb * COLOR.a, COLOR.a);`, `packages/canvas-effects/src/particle-webgl.ts` returns a
premultiplied fragment under `blendFuncSeparate(ONE, ONE_MINUS_SRC_ALPHA, ONE,
ONE_MINUS_SRC_ALPHA)`, and its additive resolve presents `(light, cov)` with no divide — expression
for expression, the WGSL. One rule, two languages.

It used to declare `premultipliedAlpha: false` and reach the right answer on two of its three paths
by compensating differently on each: the shader path wrote straight colour (correct under that
declaration), the additive resolve pre-divided by the coverage the blit would re-apply (correct by
cancellation), and the particle MIX path wrote premultiplied content into a canvas that said it was
straight — so `drawImage` into each node canvas multiplied by alpha a second time and MIX particles
composited at roughly `a²`. One canvas, three contracts.

The pairing is load-bearing on both halves at once — a premultiplied fragment under a src-alpha blend
double-multiplies, a straight fragment under this blend halos — and neither failure raises an error,
only a slightly different picture at the same frame rate. So `PREMULTIPLIED_BLEND` is exported next
to the WGSL sources and one test asserts the two together; `particles-render.test.ts` does the same
for the GL pair, and `test-harness`'s `webglCompositeXvfb.test.ts` / `webgpuCompositeXvfb.test.ts`
measure the result through the REAL page compositor, which is the only place the declaration is
observable at all.

### Counter conventions

| key                                                    | arms                                                                             | what it is                                                               |
| ------------------------------------------------------ | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `simMs` / `buildMs` / `simSteps` / `instances`         | particle arms                                                                    | the imported sim and the imported packing — identical code on both sides |
| `glMs`                                                 | the two `*-webgl` arms                                                           | the shipped runtime's GL submit cost                                     |
| `submitMs`                                             | the three webgpu arms                                                            | main-thread time in `writeBuffer` + encode + `queue.submit`              |
| `passes` / `submits` / `particleDraws` / `shaderDraws` | webgpu arms                                                                      | the encode shape, counted where it happens                               |
| `blitMs` / `blits`                                     | `particles-webgpu-blit` only (plus the runtime's own `blitMs` on the webgl arms) | the `drawImage` half                                                     |
| `adapterFallback`                                      | webgpu arms                                                                      | 1 = a software adapter; **the arm is void**                              |
| `gpuErrors` / `deviceLosses`                           | webgpu arms                                                                      | any non-zero value means a frame was silently wrong, or stopped          |
| `renderedNodes`                                        | all                                                                              | cells that really presented — `ready()`'s own gate                       |

Two conventions are deliberate and easy to "fix" wrongly:

- **`submitMs` is not `glMs`, because it is not GL.** It is the same _class_ of measurement — the main
  thread telling a GPU what to do — but sharing the key would let a reader median the two together
  across arms. A missing key means "not measured"; a wrongly _shared_ key is worse, because it is
  measured and mislabelled.
- **A missing `blitMs` row IS the architecture.** `particles-webgpu` and `shaders-webgpu` report no
  `blitMs` and no `blits` because there is no blit to time. Adding a `blitMs: 0` "for symmetry" would
  erase the exact difference this scenario exists to show.

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

The last line is the whole discipline. S6 already showed that a main-thread number can move a long
way while the felt rate does not (`--param amount=16` cut `simMs` by 4× and moved `contentUpdateHz`
by 0.5 Hz), and that the saturated resource on this phone is the GPU process. A `submitMs` that
halves while the page still activates at 47 Hz is a micro-optimisation, not an answer. "Both pairs"
means the particle pair and the shader pair: S6 found particles and shaders cost the same, so a fix
that only helps one of them is a fix to something other than the pipeline.

### The two claims under test

This scenario exists because two specific claims about WebGPU on phones keep being made, and both are
measurable here rather than arguable.

1. **"WebGPU cuts CPU/driver overhead."** Read it off `submitMs` against `glMs` on the particle pair,
   then off **GPU-process CPU** (`cpu.byProcess`, `CrGpuMain`) — because S6 established that the
   overhead that matters on this device is in the GPU process, not on the main thread. The harness's
   [battery and thermal samples](#battery-and-thermal-before-and-after) taken before and after each
   arm are the third reading: a genuine reduction in driver work shows up as less charge drawn and a
   cooler exit, and a "win" that does neither is inside the noise of a 2.5 s window.
2. **"Explicit memory control avoids allocation-spike jank."** Read it off `frameCost` and
   `activationGap` **p95/max** (not p50) and off `gfxinfo`'s jank%. Note what S6 already measured on
   this workload: **0.00% jank**, no activation gaps over 100 ms, a steady-state pipeline with nothing
   allocating per frame. There is no allocation spike here to avoid. If this claim is true it is true
   of some _other_ workload — a scene that creates and destroys systems, or streams textures — and
   this scenario cannot speak to it. Saying so is the result.

### Traps

- **Desktop is SwiftShader — smoke only.** `--env ci` proves the arms mount, render, present and
  report. It cannot answer either question: "the GPU is expensive" is true by construction under a
  software rasteriser, and on this box WebGPU is a software adapter too, which sets `adapterFallback`
  and voids the arm by its own rules.
- **`--chrome-arg` is desktop-only.** Enabling WebGPU on the desktop smoke needs
  `--chrome-arg=--enable-unsafe-webgpu` (and on Linux `--chrome-arg=--enable-features=Vulkan`). That
  flag passes arguments to the **locally launched** Chrome; the `--env device` path attaches to
  Chrome on the phone over `adb` and does not launch it, so device runs depend on what that build
  already supports.
- **A `ready()` failure aborts the WHOLE run.** `ready()` is the only awaited scenario hook, and a
  throw from it surfaces as `Runtime.evaluate threw: <first 800 chars>` and takes every remaining arm
  with it. So **smoke the webgl and webgpu arms in separate `--mechanism` invocations** until both are
  known good. Every error this scenario raises front-loads the actionable fix for the same reason:
  the message is read truncated.
- **`adapterFallback: 1` voids the arm.** A fallback adapter is a CPU implementation wearing WebGPU's
  name. Its numbers are internally consistent and completely unrelated to the question.
- **`fps` is a different mechanism here.** On the webgpu arms it is a rAF **skip** — the loop still
  wakes every display frame and returns early — while the shipped runtime **parks a timer** to the cap
  boundary. Same rate, different cost. An fps-capped webgpu arm is not directly comparable with an
  fps-capped runtime arm; S6 is where that question belongs.
- **`blend=1` is refused, not approximated.** Godot ADD needs the accumulate+resolve pass the shipped
  GL renderer runs, and it is not ported. The webgpu arms throw with the fallback spelled out
  (`--scenario effects-runtime --param blend=1`) rather than render a different picture.
- **TIME has a different origin.** The WGSL shader's clock starts at `ready()`, not at the runtime's
  shared clock origin. Same rate, different phase — the wave is at a different point in its cycle,
  which costs exactly the same to draw.
- **The canary is shared with S6.** This page paints no images either, and `validateReport` rejects
  `decode.count === 0` outright; the same one 8×8 PNG rides the container. `decode tasks: 1` is the
  scenario, not a broken matcher.
- **The blit arm's shared canvas is detached from the DOM**, exactly as the shipped shared GL canvas
  is — attaching it would add a composited layer the reference arm does not have. Confirm at smoke
  that `drawImage` from a detached WebGPU canvas reads its contents on the Chrome build in use; a
  blank blit arm with a healthy `submits` count is what that failure looks like.

### Reference reading

**moto g86 5G, Android 15, Chrome 151, Mali-G615 (real hardware adapter, `adapterFallback 0`,
`gpuErrors 0`, `deviceLosses 0` on every WebGPU arm) — 2026-08-20, 5 repeats, medians, ~2.5 s
window, defaults.** Desktop cannot produce this table at all: headless SwiftShader Chrome 148
acquires an adapter and accepts submits but **never composites a WebGPU canvas** (verified with a
minimal clear-to-red page — the screenshot stays blank while `SharedImageManager::ProduceMemory`
errors stream), so the desktop smoke is recorded only as "the two WebGL arms mount, present 12/12
and report".

Probed further for FUTURE VISUAL (not perf) testing, same box, same Chrome, same flags — three
distinct paths, three different answers:

- **Pure texture readback works HEADLESS**: render to an offscreen `rgba8unorm` texture,
  `copyTextureToBuffer` + `mapAsync` returns the correct pixels. A WebGL↔WebGPU image-diff can run
  headless on desktop with no display at all — and this is the precise path anyway (raw bytes, no
  compositor color management in between).
- **Compositing works HEADED under Xvfb**: `xvfb-run -a` + `--headed` + the same `--chrome-arg`
  flags shows the WebGPU canvas correctly in `Page.captureScreenshot`. Full-composite screenshot
  tests (alphaMode/premultiply behavior included) are desktop-runnable this way.
- **`drawImage(webgpuCanvas)` is blank in BOTH modes** on SwiftShader — the same path S7 measured
  as pathological on the phone. Never use it, for rendering or for readback.

The FALLBACK ADAPTER caveat still stands for anything timed: SwiftShader numbers are CPU-rasterizer
numbers and void by this scenario's own `adapterFallback` rule — desktop is for correctness only.

| metric                     | particles-webgl | particles-webgpu | particles-webgpu-blit | shaders-webgl | shaders-webgpu |
| -------------------------- | --------------- | ---------------- | --------------------- | ------------- | -------------- |
| contentUpdate Hz           | 47.19           | **86.95**        | **23.17**             | 46.55         | **86.79**      |
| frameCost ms p50 / p95     | 5.81 / 9.11     | 2.42 / 4.33      | 8.08 / 22.98          | 4.74 / 7.99   | 2.18 / 3.41    |
| renderer CrRendererMain ms | 666             | 554              | 577                   | 544           | 492            |
| GPU CrGpuMain ms           | 2251            | 1764             | 1908                  | 2261          | 1780           |
| GPU CompositorGpuThread ms | 568             | **1500**         | 438                   | 537           | **1508**       |
| layers                     | 19              | 19               | 19                    | 19            | 19             |
| scenario.profTicks         | 116             | 217              | 58                    | 115           | 217            |
| scenario.simSteps          | 888             | 900              | 864                   | —             | —              |
| scenario.simMs             | 64.6            | 60.1             | 176.4                 | —             | —              |
| scenario.glMs              | 59.5            | —                | —                     | 36.7          | —              |
| scenario.submitMs          | —               | 139.7            | 33.9                  | —             | 133.7          |
| scenario.blitMs            | 342.3           | —                | 151.8                 | 331.2         | —              |

### The verdict (moto g86 5G, 2026-08-20)

**WebGPU direct-to-canvas nearly doubles the felt rate: 47 → 87 Hz, on both pairs.** The effects
loop itself runs at the pace `profTicks` shows (217 ticks ≈ 87 Hz vs 116 ≈ 46 Hz), frame cost p50
halves, and the win passes this scenario's own bar — it shows in `contentUpdateHz` AND in per-frame
GPU cost (the GPU process spends about the same total CPU while presenting **twice as many
frames**), on the particle pair AND the sim-free shader pair, in one session. The sim is bystander
throughout: ~900 fixed steps and ~60 `simMs` on live arms regardless of API, exactly as S6 said.

**The blit arm is the anti-result that explains the win.** Keeping the shipped shape — render
elsewhere, `drawImage` into N 2D canvases — under WebGPU collapses to 23 Hz, WORSE than WebGL:
`drawImage` sourcing a WebGPU canvas is a pathological path in Android Chrome (its `simMs 176.4` is
the same sim paying bigger `dt` sub-steps at 23 Hz, not a sim regression). So the planned
attribution arithmetic resolves asymmetrically: the API alone is NOT the lever (webgpu-blit ≪
webgl), and the whole win lives in **presenting pixels where the compositor reads them** — which
WebGL cannot do for N nodes (one context per canvas is what the shared-canvas+blit architecture
exists to avoid) and WebGPU does natively (one device, N configured canvases). Note the cost did
not vanish; it moved: `CompositorGpuThread` triples on the direct arms (~1500 ms —
`BeginAccessImages` on N WebGPU canvases per composite), and that is the ceiling a "more systems"
follow-up would hit next.

**The two claims under test, answered:**

1. _"Lower CPU overhead / less driver chatter."_ Directionally true but not where the framing put
   it: per tick, main-thread submit falls from ~3.5 ms (GL submit + blit) to ~0.64 ms — but ~80% of
   that is the blit's disappearance, an architecture change WebGPU enables, not command-encoding
   magic. Renderer main-thread CPU drops ~17% while doing 2× the frames. Battery/thermal: status
   `none` throughout, battery temperature flat at 28 °C across all five arms — the window is too
   short to separate the APIs thermally.
2. _"Explicit memory control avoids allocation-spike jank."_ Not applicable here, as predicted:
   the shipped pipeline is steady-state (S6: 0.00% jank), and the WebGPU arms' win shows up as a
   lower, tighter frame cost (p95 4.33 vs 9.11 ms), not as removed spikes — there were none to
   remove.

**What this licenses:** WebGPU direct-to-canvas is a real, large lever for live effects on this
phone — worth a product-side spike IF live-effect frame rate matters enough to carry a second
renderer (WebGL must remain as the fallback; WebGPU coverage is still partial, and this probe is
explicitly not shippable code). **What it does not license:** any claim at higher system counts
(the tripled `CompositorGpuThread` is the next wall), on additive blend (refused in this probe),
with textures/LUTs/masks (not ported), or on any device where the compositor — not the GPU process
— is the saturated resource.

### Running it

```bash
# desktop SMOKE, in two invocations — a ready() failure on one arm aborts the whole run
mise exec -- pnpm perf -- --scenario effects-webgpu --mechanism particles-webgl,shaders-webgl
mise exec -- pnpm perf -- --scenario effects-webgpu \
  --mechanism particles-webgpu,particles-webgpu-blit,shaders-webgpu \
  --chrome-arg=--enable-unsafe-webgpu --chrome-arg=--enable-features=Vulkan

# the question, on the phone that raised it — all five arms, one session
mise exec -- pnpm perf -- --env device --scenario effects-webgpu \
  --baseline moto-g86-5g-effects-webgpu
```

There is deliberately **no `perf assert` gate**, for the S6 and S2 lesson: a gate is written FROM
device readings, and S2's was written from desktop intuition — a device run then contradicted three
of its five relations. The arithmetic above is what a gate would encode; it gets encoded once the
phone has said what the numbers are.

## Scenario S8: `effects-webgpu-runtime` — the SHIPPED WebGPU path

**THE QUESTION.** S7 priced WebGPU with a **probe** and the phone answered 47 → **87 Hz** on both
pairs. That licensed writing the renderer. S8 asks the only question left: **did the win survive
productization?** The shipped renderer is not the probe — it carries textures, flipbooks, LUT
recolour, masks, polar UV, erode, the additive accumulate+resolve pass, a per-binding fallback path,
a device-lost rebuild and the whole 2 000-line lifecycle machinery the probe never had, and every one
of those is a place for the 87 Hz to leak away. The consuming project also renders **30+** effect
canvases, and S7's own verdict named the tripled `CompositorGpuThread` as the next wall, so the
confirmation runs at 12 (S7 continuity) **and** at `--param systems=30`.

So this is an **S6-licence scenario: shipped code only.** `createParticleRuntime` /
`createWebglShaderRuntime` from `packages/html`, S6's exported node builders **called** (not copied),
and exactly ONE option different between an arm and its reference. **The S7 probe is untouched** —
it stays as the historical record of what an unencumbered WebGPU pipeline costs, and this scenario
imports nothing from it: not its WGSL, not its packer, not its renderer. If the two tables disagree,
the difference is what productization cost, which is a reading rather than a bug in either.

### The four arms

12 systems × 64 particles, one per 96 px cell, plus S6's churn strip and S6's decode canary — the
same stage, the same cells, the same canvas pixel count, the same spec on every arm.

| arm                | runtime                    | `effectsRenderer` | what it is for                                           |
| ------------------ | -------------------------- | ----------------- | -------------------------------------------------------- |
| `particles-webgl`  | `createParticleRuntime`    | `"webgl"`         | the in-session reference (S6's `particles-live`, pinned) |
| `particles-webgpu` | `createParticleRuntime`    | `"webgpu"`        | the confirmation: same runtime, WebGPU backend           |
| `shaders-webgl`    | `createWebglShaderRuntime` | `"webgl"`         | the in-session reference (S6's `shaders-live`, pinned)   |
| `shaders-webgpu`   | `createWebglShaderRuntime` | `"webgpu"`        | the confirmation, with no simulation in the frame at all |

**Both sides are PINNED; neither is `"auto"`.** `"auto"` is the shipped default, so a reference arm
left at it would adopt WebGPU on every device worth running this on and the table would be WebGPU
against WebGPU, reported as "productization cost nothing". `test/effects-webgpu-runtime.test.ts`
asserts the pinning, the arm classification, and that S8's geometry / stage box / sample points /
cell boxes / particle spec equal S6's across three viewports at `systems` **12 and 30**.

**`blend=1` is measurable here**, and that is new: S7 REFUSED additive because the probe had only the
single-pass mix path. The shipped WebGPU renderer ports Godot ADD's accumulate+resolve, so the case
S7 could not answer is a parameter — and doubling the passes per frame is exactly where a win leaks.

### `freeze` and `swap` — the N=30 lever, as PARAMS

The systems=30 verdict named "fewer live canvases per composite" as the next lever, and the frozen
surface → `<img>` swap is that lever: a swapped canvas leaves the composite entirely. These are
**params, not arms**, and that is the whole discipline — they apply to the arm **and its reference**,
so the pair stays subtractable and the reading is **the same arm at `swap=0` against `swap=1`**.

| param    | values | what it does                                                                                                             |
| -------- | ------ | ------------------------------------------------------------------------------------------------------------------------ |
| `freeze` | 0 / 1  | 1 → `staticParticles` on the particle arms; `staticShaders` + `staticShaderTime: 1` on the shader arms                   |
| `swap`   | 0 / 1  | 1 → `staticParticleImages` + `staticShaderImages`. **Requires `freeze=1`** (`mount()` throws otherwise, with the remedy) |

Three things are deliberate:

- **`swap=0` pins `staticShaderImages: false` EXPLICITLY.** That option ships **ON**, so a `freeze=1
swap=0` reference would engage the mechanism implicitly and the pair would be a swapped window
  against a swapped window.
- **`swap=1` without `freeze=1` is REFUSED, not measured.** A live population never earns a swap (a
  live shader's content key moves every frame; a live particle system paints every frame), so the run
  would publish an armed mechanism that never engaged — a `swap=1` row identical to its `swap=0` one,
  read as "the mechanism does nothing".
- **`ready()` gains an engagement phase when `swap=1`**, after the render/adoption waits and before
  the window: it reconciles the shader runtime once per frame (a frozen node renders once and the
  loop never visits it again, so each clean `reconcile()` IS one content-key observation; particles
  are NOT reconciled, since their gate is a quiet window their own repaint would reset) and polls
  `staticImagesLive` until every surface has swapped, throwing after 20 s with
  `staticImageFailures` / `staticImageCaptureFailures` / `staticImageBlankCaptures` /
  `webgpuFallbackReason` and the remedy (the third of those names the launch mode — see the traps). So
  the window measures the **swapped steady state**, never the transition — the mechanism's cost is
  front-loaded (a readback and an encode per distinct frame), and a window containing it would price
  the transition once instead of the question being asked.

`step()` is unchanged: the churn strip keeps the report validator fed exactly as it does on a frozen
S6 arm.

### Counter conventions

| key                                                      | arms          | what it is                                                             |
| -------------------------------------------------------- | ------------- | ---------------------------------------------------------------------- |
| `simMs` / `buildMs` / `simSteps` / `instances`           | particle arms | the shipped sim and instance build — identical code on both sides      |
| `glMs` / `blitMs`                                        | webgl arms    | the shipped runtime's GL submit and its GL→2D blit                     |
| `submitMs`                                               | webgpu arms   | encode + `writeBuffer` upload issue cost (see the mapping below)       |
| `webgpuSubmits`                                          | webgpu arms   | `queue.submit` calls — ONE per tick that drew, whatever N is           |
| `rendererWebgpu`                                         | webgpu arms   | 1 iff `stats().renderer === "webgpu"` **after** the window             |
| `webgpuFallbacks` / `webgpuBindingFallbacks`             | webgpu arms   | silent fallbacks; the second only on the shader runtime, which has it  |
| `gpuErrors` / `deviceLosses`                             | webgpu arms   | a frame was silently wrong / the device stopped producing frames       |
| `forcedAdapter`                                          | webgpu arms   | present ONLY when forced; **1 voids the arm for performance**          |
| `renderedNodes` _(life)_ / `boxReads` _(life, particle)_ | all           | S6's two whole-life rows, for S6's reasons                             |
| `staticImageSwaps` / `Reverts` / `Encodes` / `Failures`  | `swap=1` only | window deltas — **≈0 is healthy**, non-zero is the thrash diagnostic   |
| `staticImageEncodeMs` / `staticImageCaptureMs`           | `swap=1` only | window deltas: synchronous main-thread park / GPU readback wall time   |
| `staticImageBlankCaptures`                               | `swap=1` only | captures refused for holding no visible px — **non-zero = wrong rung** |
| `staticImagesLive` _(life, GAUGE)_                       | `swap=1` only | how many surfaces are swapped RIGHT NOW — `== systems` is engaged      |

Everything except the rows marked _life_ and the four validity rows is a **window delta** (S6's
`counterDelta`, snapshotted on the first `step()`). Three conventions are deliberate and easy to
"fix" wrongly:

- **`submitMs` IS the runtime's `glMs` bucket, renamed at the scenario boundary.** The shipped WebGPU
  backends book encode + upload into the profile's `glMs` (`particles/render-webgpu.ts`,
  `webgpu/render-shader.ts` both say so at the brackets) and never touch `blitMs`. Inside
  `packages/html` that is right — the profile has a fixed shape and a fifth bucket would leak a
  renderer concept into a renderer-agnostic type. But a table is read ACROSS arms, and a `glMs`
  column holding GL submit on two arms and WebGPU encode on the other two invites a reader to median
  them together. So the rename happens once, in `renameWebgpuBuckets`, where the arm's identity is
  known. (The rounding is inherited: `counterDelta` rounds under the original key.)
- **A missing `blitMs` row IS the architecture** — S7's rule. The WebGPU path has no blit, so the key
  is dropped rather than reported as 0; a `blitMs: 0` beside WebGL's 2 150 would read as "the blit
  got free" instead of "the blit stopped existing".
- **`forceWebgpu=1` voids the arm for performance, by construction.** It sets
  `__gswForceWebgpuEffects` before the runtime is created, which disables the shipped gate's
  fallback-adapter decline (`webgpu/device.ts`) — so the arm may be running on a CPU implementation
  wearing WebGPU's name. `forcedAdapter: 1` is reported and there is deliberately no `0`: the runtime
  does not publish whether the adapter it took was a fallback one, so the only honest claim is the
  one this scenario made ("the decline was disabled"), never a claim about an adapter nobody
  inspected.
- **The swap rows appear ONLY on a `swap=1` run** — the `forcedAdapter` convention again. On a run
  that never armed the mechanism, `staticImageSwaps: 0` would not mean "nothing swapped", it would
  mean "nothing was asked to", and a reader cannot tell those apart from a zero.
- **`staticImagesLive` is a GAUGE and never goes through `counterDelta`.** The surfaces froze during
  `ready()`, so its window delta is 0 on a perfectly healthy run; the number a reader wants is the
  standing count, and `staticImagesLive == systems` is "every canvas left the composite". Its
  siblings are the opposite: they are window deltas precisely so that ≈0 means "the mechanism sat
  still while it was being measured".
- **`staticImageCaptureMs` is NOT part of `staticImageEncodeMs`.** Encode-ms means synchronous
  main-thread park (`toBlob` on a readable canvas); capture-ms is a GPU `mapAsync` readback's wall
  time, which does not park the main thread at all. Adding them would invent a park that never
  happened. On a webgl arm capture-ms stays 0 — there is no capture on that path, which is the
  honest reading rather than a missing one.
- **`staticImageBlankCaptures` is a LAUNCH-MODE verdict, not a thrash counter.** It counts captures
  the swap refused because they held no visible pixels for a surface the renderer knew it drew — the
  guard against publishing a PNG of nothing (see the trap below and `@godot-scene-web/html`'s BLANK
  CAPTURES). Non-zero on a webgpu arm means this rung cannot assemble a still at all, so those
  surfaces stayed on their canvases and `ready()` will have thrown before a table was ever printed.
  It stays 0 on any working rung — and ALWAYS on a webgl arm, which has no capture hook to book it:
  a 0 there means "not measurable", never "verified" (the trap below says what is uncovered and why).

### `ready()` refuses a silent fallback

The shipped runtime's whole design is that WebGPU failure is **invisible**: it adopts WebGL, counts
`webgpuFallbacks`, latches a reason and keeps rendering. That is correct for a product and fatal for
a confirmation arm — `particles-webgpu` would publish WebGL numbers under a WebGPU name and the table
would read as "productization lost the win" when the truth is "WebGPU never ran here". So on a webgpu
arm `ready()` additionally polls `stats().renderer` until it is `"webgpu"`, and throws if
`webgpuFallbacks > 0` or (shader runtime) `webgpuBindingFallbacks > 0`, naming
`webgpuFallbackReason` and the remedy. Verified on this box — headless, unforced, the message is:

```
effects-webgpu-runtime: run --param forceWebgpu=1 (desktop smoke on a fallback adapter) or
--mechanism particles-webgl,shaders-webgl instead — shaders-webgpu asked for effectsRenderer
"webgpu" and the shipped runtime fell back to WebGL. webgpuFallbackReason=fallback-adapter,
webgpuFallbacks=1, renderer=webgl. Measuring it anyway would report WebGL under a WebGPU name,
which is the one thing a confirmation arm must never do.
```

`rendererWebgpu` is the same gate re-checked AFTER the window, because a device lost mid-run rebuilds
the whole runtime on WebGL and `ready()` cannot see that happen.

### Traps

- **A `ready()` throw aborts the WHOLE run** (S7's trap, and this scenario throws more often by
  design): smoke the webgl and webgpu arms in **separate `--mechanism` invocations**.
- **Headless Chrome never composites a WebGPU canvas**, and the presence guard samples composited
  pixels — so a desktop WebGPU smoke must be `xvfb-run -a … --headed`. The arms would otherwise
  report `sampleHits 0/12` while `webgpuSubmits` climbed happily.
  **`--param swap=1` inverts this**, and that inversion IS the mechanism: a swapped surface is an
  `<img>`, so it composites headless like any other image. Measured here — headless with
  `--use-angle=vulkan`, both webgpu arms swapped: `sampleHits 12/12`, `nonEmptyRatio` 0.188 on the
  shader arm, identical to the non-swapped headed reading.
- **A swapped WebGPU smoke needs `--use-angle=vulkan`. Its absence WAS silent; it is now a
  counter.** Measured on this box, 2026-08-21: headed under Xvfb with the default ANGLE backend,
  both webgpu arms swapped successfully (`staticImagesLive 12/12`, no capture failures — `ready()`
  did not throw) and then presented **`sampleHits 0/12`**, because every stand-in was a PNG of
  nothing. The canvas is hidden by then, so the systems vanished from the screenshot entirely. The
  same code on the `--use-angle=vulkan` rung is pixel-exact against the rendered frame
  (`test/webgpuSwapParityBrowser.test.ts`, worst channel delta 0), so this is a launch-mode hazard,
  not a swap bug. Headed **plus** `--use-angle=vulkan` was also tried and hangs (a CDP timeout on
  `Runtime.evaluate`); headless `--use-angle=vulkan` is the rung that works.

  **WHAT IS ACTUALLY BROKEN ON THAT RUNG — measured 2026-08-21, and it is NOT the WebGPU readback.**
  The readback the swap depends on is **fine** there (`captureNodePixels` on the `textured` fixture:
  827 / 15 376 painted px). What fails is `putImageData` into an **accelerated 2D canvas** — the
  canvas the still is assembled in — and the `toBlob` that follows then faithfully encodes the
  nothing that is really in it. Probed on this box (RTX 2060, Chrome 148), headed under Xvfb,
  default ANGLE, under the two launchers this repo uses:

  | probe                                                              | perf-harness Chrome | Playwright Chromium |
  | ------------------------------------------------------------------ | ------------------- | ------------------- |
  | WebGPU `copyTextureToBuffer` readback                              | fine (scan passed)  | fine (827 px)       |
  | `putImageData` → read one pixel back, default canvas               | **alpha 0**         | **0 / 16 384**      |
  | `putImageData` → read one pixel back, `willReadFrequently: true`   | **alpha 255**       | **16 384 / 16 384** |
  | host-painted canvas (`drawImage` from WebGL) → `toBlob`            | correct (row below) | **blank PNG**       |
  | the WebGL swap arms of this scenario (`toBlob` on the node canvas) | **12/12 visible**   | n/a                 |

  The perf-harness column's first row is the guard reporting on itself: with both checks armed, every
  one of the 12 refusals there came from the WRITE-BACK check, never the readback scan.

  Two facts that an earlier version of this note (and the memory it came from) got wrong, both now
  measured: the **readback is not the broken link**, and the breakage is **not uniform across
  canvases** — under the perf harness's own Chrome, a canvas the host painted still encodes
  correctly, which is why the WebGL swap arms publish real stills on the same rung while the WebGPU
  ones published nothing. (PNG contents in the Playwright column were decoded in **Node**, with
  sharp: an in-page decode counts pixels with `getImageData`, which is itself broken here and would
  have been the instrument measuring itself.)

  **THE REMEDY, measured but deliberately not taken.** `getContext("2d", { willReadFrequently: true })`
  on the still canvas — a CPU backing store — takes the identical `putImageData` and reads back 255
  under BOTH launchers, i.e. it would make the WebGPU swap work on this rung instead of failing safe.
  It is a one-line change in `packages/html/src/webgpu/still-capture.ts` and it is not made here for
  one reason: it changes the shipped encode path for every WebGPU still on every device, including
  the phone the pacing/park numbers were tuned on (S5/S8), and this repo does not ship an encode-path
  change on a desktop-only reading. Commission it with a device run behind it.

  **THE MITIGATION (and why this arm now fails loudly instead).** The swap refuses a capture that
  produced no visible pixels for a surface the renderer knows it drew — checking BOTH links: the
  readback's own alpha, and one pixel read back from the 2D canvas where the frame's most opaque
  pixel was just written. The surface keeps its LIVE canvas and the refusal books
  `staticImageBlankCaptures` (`@godot-scene-web/html`'s BLANK CAPTURES; a genuinely empty surface
  asserts no coverage and still freezes). Verified on this rung: the swap-parity fixture now reports
  `staticImagesLive=0, captures=0, captureFailures=1, blankCaptures=1` instead of publishing an empty
  `<img>`. On a `swap=1` perf run the arm therefore never reaches `staticImagesLive 12/12` — measured
  on the same rung, `ready()` throws "only 0/12 particles-webgpu surfaces swapped …
  staticImageCaptureFailures=12, staticImageBlankCaptures=12", which names the rung as the cause
  where the old silent pass named nothing. The healthy rung is unaffected: headless
  `--use-angle=vulkan`, both arms, `staticImagesLive 12`, `staticImageBlankCaptures 0`,
  `sampleHits 12/12`, `nonEmptyRatio` 0.188 — the S8 record above, re-measured with the guard in.
  The counter is reported on every `swap=1` run, and **non-zero on a webgpu arm means "change rung",
  never "read the table"**. The same guard is what keeps this out of production: a device that
  cannot produce still pixels now leaves the canvas up instead of blanking it.

  **THE WEBGL ARMS ARE NOT GUARDED, and are not affected here.** Only a capture hook can book
  `staticImageBlankCaptures`; a 2D-backed surface is read straight through `toBlob` and has no
  equivalent check. That is a deliberate hole, on the evidence in the table above: the only cheap
  probe available for that path (paint a scratch canvas, read a pixel back) reports BROKEN under the
  perf harness's own Chrome, where the WebGL arms nonetheless publish 12/12 visible stills — so the
  guard would have disabled a mechanism that works. Measured after the guard shipped, same rung:
  `particles-webgl` and `shaders-webgl` at `--param freeze=1 --param swap=1` both report
  `staticImagesLive 12`, `staticImageBlankCaptures 0`, `sampleHits 12/12`. What stays uncovered is a
  device on which `toBlob` over a host-painted canvas yields an empty PNG — the Playwright column
  above is exactly that — where a 2D-backed surface would still publish a blank `<img>` silently.

- **Desktop is correctness-only, and the two smoke invocations are not comparable with each other**
  (below).
- **`--chrome-arg` is desktop-only**: `--env device` attaches to Chrome on the phone and never
  launches it.
- **The arms share S7's names on purpose** so the two tables line up; `particles-webgpu-blit` has no
  counterpart here, because nothing shipped blits from a WebGPU canvas — and nothing ever should.

### Desktop smoke record — CORRECTNESS ONLY, never performance

**This box (linux, Chrome 148), 2026-08-20, 5 repeats, medians, ~2.5 s window, defaults (12 systems ×
64, `blend=0`).** The two invocations ran in **different display and GPU modes** — the WebGL arms
headless on SwiftShader, the WebGPU arms headed under `xvfb-run` where Chrome's compositor uses the
box's NVIDIA RTX 2060 — so **no column here may be compared with another**. Each column says exactly
one thing: the arm mounts, adopts the renderer its name claims, presents 12/12 sample points and
reports its own counters. The `contentUpdateHz` row is included only because a reader will look for
it; it is a measurement of two different machines.

| metric                              | particles-webgl        | shaders-webgl          | particles-webgpu  | shaders-webgpu    |
| ----------------------------------- | ---------------------- | ---------------------- | ----------------- | ----------------- |
| mode                                | headless / SwiftShader | headless / SwiftShader | headed under Xvfb | headed under Xvfb |
| initialRender ms                    | 304.3                  | 168.6                  | 375.8             | 202.8             |
| ready ms (JS)                       | 288.6                  | 162.6                  | 374.3             | 201.5             |
| presented sampleHits                | **12/12**              | **12/12**              | **12/12**         | **12/12**         |
| presented nonEmptyRatio             | 0.0365                 | 0.188                  | 0.0408            | 0.188             |
| contentUpdate Hz _(not comparable)_ | 44.12                  | 60.54                  | 67.84             | 68.00             |
| scenario.profTicks                  | 110                    | 150                    | 169               | 169               |
| scenario.simSteps                   | 900                    | —                      | 900               | —                 |
| scenario.simMs                      | 57.3                   | —                      | 39.7              | —                 |
| scenario.buildMs                    | 5.6                    | —                      | 6.0               | —                 |
| scenario.glMs                       | 79.6                   | 33.2                   | —                 | —                 |
| scenario.blitMs                     | 2149.9                 | 1594.8                 | —                 | —                 |
| scenario.submitMs                   | —                      | —                      | 39.9              | 19.2              |
| scenario.webgpuSubmits              | —                      | —                      | 169               | 169               |
| scenario.particleDraws              | 1320                   | —                      | 2028              | —                 |
| scenario.shaderDraws                | —                      | 1800                   | —                 | 2028              |
| scenario.rendererWebgpu             | —                      | —                      | 1                 | 1                 |
| scenario.webgpuFallbacks            | —                      | —                      | 0                 | 0                 |
| scenario.webgpuBindingFallbacks     | —                      | —                      | —                 | 0                 |
| scenario.gpuErrors / deviceLosses   | —                      | —                      | 0 / 0             | 0 / 0             |
| scenario.forcedAdapter              | —                      | —                      | **1**             | **1**             |
| scenario.boxReads                   | 0                      | —                      | 0                 | —                 |

The row that matters is the key SET, not the values: no `blitMs` and no `glMs` reach a webgpu arm, no
`submitMs` reaches a webgl arm, `webgpuBindingFallbacks` appears on the shader runtime alone, and
`forcedAdapter` only where the adapter was forced. That is `runtimeMetricKeysFor` holding on real
hardware, and it is what the node tests assert offline.

#### Swap smoke — `--param freeze=1 --param swap=1`, all four arms

**This box, 2026-08-21. WebGL arms headless (5 repeats); WebGPU arms headless
`--use-angle=vulkan` + `forceWebgpu=1` (5 repeats).** Correctness only, and again the columns are not
comparable with each other — what this table says is that **the mechanism engages and then sits
still on every arm, on both renderers**.

| metric                               | particles-webgl | shaders-webgl | particles-webgpu | shaders-webgpu |
| ------------------------------------ | --------------- | ------------- | ---------------- | -------------- |
| presented sampleHits                 | **12/12**       | **12/12**     | **12/12**        | **12/12**      |
| presented nonEmptyRatio              | 0.0366          | 0.188         | 0.0415           | 0.188          |
| scenario.staticImagesLive            | **12**          | **12**        | **12**           | **12**         |
| scenario.staticImageSwaps            | 0               | 0             | 0                | 0              |
| scenario.staticImageReverts          | 0               | 0             | 0                | 0              |
| scenario.staticImageEncodes          | 0               | 0             | 0                | 0              |
| scenario.staticImageFailures         | 0               | 0             | 0                | 0              |
| scenario.staticImageEncodeMs         | 0               | 0             | 0                | 0              |
| scenario.staticImageCaptureMs        | 0               | 0             | 0                | 0              |
| scenario.particleDraws / shaderDraws | 0               | 0             | 0                | 0              |
| scenario.rendererWebgpu              | —               | —             | 1                | 1              |

Read it as three facts. **`staticImagesLive == systems`** on every arm: all 12 canvases left the
composite. **Every window delta is 0**: the swaps and their encodes happened during `ready()`, and
nothing reverted or re-encoded while the window was open — the healthy reading, and the one the
thrash diagnostic is defined against. **`particleDraws`/`shaderDraws` are 0 in-window** too: a frozen
swapped surface draws nothing at all, which is what "left the composite" costs on the CPU side. The
`nonEmptyRatio` figures match the non-swapped readings above (0.188 on the shader arms either way),
which is the pixel-level statement that the `<img>` shows what the canvas showed.

**One S7-era belief was corrected here.** S7 recorded "on this box WebGPU is a software adapter too,
which sets `adapterFallback` and voids the arm" — that is a **headless** fact. Headed under Xvfb, an
unforced run (`--mechanism particles-webgpu --headed`, no `forceWebgpu`) is **accepted** by the
shipped gate: `webgpuFallbacks 0`, `rendererWebgpu 1`, and no `forcedAdapter` row at all. So
`--param forceWebgpu=1` is needed only for a **headless** WebGPU smoke; the table above carries it
(and therefore `forcedAdapter: 1`) because it was captured with the documented recipe. Headless and
unforced, the gate declines with `fallback-adapter` and `ready()` refuses — quoted in full above.
Either way the desktop is a different device class from the phone, and the verdict comes off the
phone.

### Reference reading (device)

**moto g86 5G, Android 15, Chrome 151, Mali-G615 (real adapter — `rendererWebgpu 1`,
`webgpuFallbacks 0`, `gpuErrors 0`, `deviceLosses 0` on every webgpu arm) — 2026-08-20, 5 repeats,
medians, ~2.5 s window, battery 58%, thermal `none` throughout, no warnings.** Baseline:
`moto-g86-5g-effects-webgpu-runtime.json` (defaults run).

Defaults (12 systems × 64 particles) — the 87 Hz continuity row against S7's probe:

| metric                     | particles-webgl | particles-webgpu | shaders-webgl | shaders-webgpu |
| -------------------------- | --------------- | ---------------- | ------------- | -------------- |
| contentUpdate Hz           | 47.33           | **85.57**        | 43.57         | **85.72**      |
| frameCost ms p50 / p95     | 5.91 / 8.48     | 2.86 / 4.62      | 4.88 / 9.01   | 2.52 / 3.93    |
| GPU CrGpuMain ms           | 2378            | 1831             | 2205          | 1844           |
| GPU CompositorGpuThread ms | 365             | **1465**         | 511           | **1468**       |
| scenario.glMs / blitMs     | 63.5 / 345.5    | — / —            | 35.9 / 325.8  | — / —          |
| scenario.submitMs          | —               | 161.3            | —             | 91.8           |
| scenario.simMs             | 53.8            | 54.1             | —             | —              |
| presented sampleHits       | 12/12           | 12/12            | 12/12         | 12/12          |

`--param systems=30` — the consuming project's real canvas count, and the wall S7 predicted:

| metric                     | particles-webgl | particles-webgpu | shaders-webgl | shaders-webgpu |
| -------------------------- | --------------- | ---------------- | ------------- | -------------- |
| contentUpdate Hz           | 18.92           | **35.91**        | 18.50         | **34.37**      |
| frameCost ms p50 / p95     | 14.22 / 27.24   | 5.77 / 14.35     | 10.78 / 22.09 | 4.09 / 11.70   |
| activationGap max ms       | 136.4           | 93.6             | 164.1         | 102.3          |
| GPU CrGpuMain ms           | 2094            | 1717             | 2085          | 1684           |
| GPU CompositorGpuThread ms | 613             | 1263             | 593           | 1241           |
| presented sampleHits       | 30/30           | 30/30            | 30/30         | 30/30          |

`--param blend=1` (additive accumulate+resolve — the case S7 refused), particle pair, 12 systems:

| metric                 | particles-webgl | particles-webgpu |
| ---------------------- | --------------- | ---------------- |
| contentUpdate Hz       | 41.98           | **83.51**        |
| frameCost ms p50 / p95 | 6.09 / 9.63     | 2.91 / 4.87      |
| scenario.submitMs      | —               | 186.6            |
| presented sampleHits   | 12/12           | 12/12            |

#### The swap, on the phone — `systems=30 freeze=1`, `swap=0` against `swap=1` (2026-08-20)

The reading the `freeze`/`swap` params exist for: the consumer's canvas count, the population
frozen, the ONLY difference between the two runs being whether frozen surfaces left the
composite. All four arms, 5 repeats each, same session; every `swap=1` arm reports
`staticImagesLive` **30/30** with every in-window swap counter at 0 (engaged during `ready()`,
silent through the window), webgpu validity rows all clean, `sampleHits` 30/30 everywhere.

| metric                      | particles-webgl | particles-webgpu | shaders-webgl | shaders-webgpu  |
| --------------------------- | --------------- | ---------------- | ------------- | --------------- |
| contentUpdate Hz off → on   | 89.7 → 90.1     | 85.9 → **90.0**  | 80.9 → 90.0   | 85.2 → **90.0** |
| activationGap max ms        | 22.5 → 20.5     | **116.6 → 19.6** | 253.7 → 20.2  | **93.1 → 19.7** |
| layers                      | 37 → **6**      | 37 → **6**       | 37 → **6**    | 37 → **6**      |
| GPU CompositorGpuThread ms  | 809 → 614       | **916 → 630**    | 831 → 631     | **900 → 618**   |
| frameCost ms p50 / p95 (on) | 3.02 / 4.10     | 3.02 / 4.27      | 3.09 / 4.13   | 3.02 / 4.26     |

Four facts, in the order they matter:

- **A frozen population already recovers most of the rate** — 85–90 Hz at `swap=0` against the
  live population's ~35/19. Freezing is the bigger half of the lever; nobody should read this
  table as "the swap took 35 Hz to 90".
- **What freezing does NOT fix, the swap does: the worst gap.** A frozen-but-live canvas still
  sits in the composite, and the compositor still stalls on it — worst activation gaps of 117 ms
  (webgpu) and 254 ms (webgl 2D canvases are not free either) with the page otherwise at 85+ Hz.
  Swapped, every arm's worst gap is ~20 ms: one panel tick.
- **The WebGPU per-composite premium is GONE, not reduced.** `CompositorGpuThread` lands at
  ~614–631 ms on every swapped arm, webgpu and webgl alike — the shared floor for compositing
  this page. The ~280–300 ms the webgpu arms paid over that floor at `swap=0` (`BeginAccessImages`
  walking 30 live WebGPU canvases per composite) has no canvases left to walk.
- **Layers 37 → 6 on every arm** — S5's static-surfaces signature, reproduced at N=30 with the
  SHIPPED runtimes and the shipped swap machinery rather than S5's synthetic arms.

(`CrGpuMain` total CPU reads ~2× higher on the swapped arms — read it per FRAME before
concluding anything: at `swap=0` the 100–250 ms stalls drop frames, so the window contains far
fewer composites. S5's rule applies: total CPU does not separate arms here; the reproducible
carriers are Hz, gaps, layers and `CompositorGpuThread`.)

### The verdict (moto g86 5G, 2026-08-20)

**Productization did not eat the probe's win.** At 12 systems the shipped runtimes read
47.3 → 85.6 Hz (particles) and 43.6 → 85.7 Hz (shaders) against the probe's 47.2 → 86.9 and
46.6 → 86.8 — within ~1.5 Hz on every arm, with the full feature set (textures, LUTs, masks,
additive) shipped rather than the probe's untextured dot. The win passes S7's bar in this
session: it shows in `contentUpdateHz` AND in per-frame GPU cost (CrGpuMain spends ~23% less
CPU while presenting ~1.8× the frames), on both pairs. Additive blending — refused by the
probe — carries the same factor (42.0 → 83.5 Hz).

**At 30 systems the 87 Hz does NOT hold — and WebGPU still doubles the page rate.** Both
pipelines fall (blit chain to ~19 Hz, WebGPU to ~35 Hz); WebGPU's worst activation gap stays
under 103 ms where the blit chain reaches 164 ms. `CompositorGpuThread` is the ceiling exactly
as S7 predicted, but it does not scale with N: ~1465 ms at 12 canvases and ~1263 ms at 30 — a
per-composite cost (`BeginAccessImages` over every live WebGPU canvas), so more canvases mean
fewer composites at the same thread saturation, not a bigger bill. What this licenses for the
30+-canvas consumer: WebGPU roughly doubles whole-page updates at every count measured, and the
next lever at N=30 is fewer live canvases per composite (freeze/park more systems, or an
`<img>`-swap for frozen WebGPU surfaces) — not a faster renderer. What it does not license: any
87 Hz claim above ~12 live systems.

That readback-encode path now EXISTS, and the lever is MEASURED (the swap table above): at
`systems=30` with the population frozen, swapping the frozen surfaces to `<img>` takes every arm
to the panel's 90 Hz, collapses the worst activation gap from 117–254 ms to ~20 ms (one panel
tick), cuts layers 37 → 6, and erases the WebGPU per-composite `BeginAccessImages` premium —
`CompositorGpuThread` lands on the same ~620 ms floor as the webgl arms. What this licenses for
the 30-canvas consumer: freeze what is not animating and let the swap take it out of the
composite; the page then holds panel rate with live-effect headroom underneath. What it does not
license: any claim about a LIVE population (the swap refuses one by design — `swap=1` without
`freeze=1` throws), or about gap-free behavior with the swap off.

### Running it

```bash
# desktop SMOKE, in two invocations — a ready() failure on one arm aborts the whole run
mise exec -- pnpm perf -- --scenario effects-webgpu-runtime --mechanism particles-webgl,shaders-webgl

# the WebGPU arms: HEADED under Xvfb (headless never composites a WebGPU canvas, and the presence
# guard samples composited pixels). `--param forceWebgpu=1` is only needed when running headless.
xvfb-run -a mise exec -- pnpm perf -- --scenario effects-webgpu-runtime \
  --mechanism particles-webgpu,shaders-webgpu --headed \
  --chrome-arg=--enable-unsafe-webgpu --chrome-arg=--enable-features=Vulkan \
  --param forceWebgpu=1

# the question, on the phone that raised it — all four arms, one session, at 12 and at 30
mise exec -- pnpm perf -- --env device --scenario effects-webgpu-runtime \
  --baseline moto-g86-5g-effects-webgpu-runtime
mise exec -- pnpm perf -- --env device --scenario effects-webgpu-runtime --param systems=30

# additive, the case S7 refused
mise exec -- pnpm perf -- --env device --scenario effects-webgpu-runtime --param blend=1

# THE SWAP, same arm both ways — the N=30 lever. `swap=1` REQUIRES `freeze=1`.
mise exec -- pnpm perf -- --scenario effects-webgpu-runtime \
  --mechanism particles-webgl,shaders-webgl --param freeze=1 --param swap=1

# the WebGPU arms SWAPPED run HEADLESS — and that is not a shortcut, it is the mechanism working:
# a swapped surface is an <img>, and an <img> composites where a WebGPU canvas never does. Use
# `--use-angle=vulkan` (the parity suite's rung — see the trap below).
mise exec -- pnpm perf -- --scenario effects-webgpu-runtime \
  --mechanism particles-webgpu,shaders-webgpu \
  --chrome-arg=--enable-unsafe-webgpu --chrome-arg=--enable-features=Vulkan \
  --chrome-arg=--use-angle=vulkan \
  --param forceWebgpu=1 --param freeze=1 --param swap=1

# the device reading the lever exists for: 30 canvases, frozen, swapped against not-swapped
mise exec -- pnpm perf -- --env device --scenario effects-webgpu-runtime \
  --param systems=30 --param freeze=1 --param swap=0
mise exec -- pnpm perf -- --env device --scenario effects-webgpu-runtime \
  --param systems=30 --param freeze=1 --param swap=1
```

Reading a swap pair: `staticImagesLive == systems` says the mechanism engaged at all;
`staticImageBlankCaptures == 0` says the surfaces it engaged over were real pixels rather than a
readback that produced nothing; the in-window `staticImageSwaps`/`Reverts` ≈ 0 say it then sat still;
and the difference the run is about shows up in `contentUpdateHz`, `CompositorGpuThread` ms and the
layer count, not in the swap's own counters.

There is deliberately **no `perf assert` gate**, for the S2/S6/S7 lesson: gates are written FROM
device readings.

## Scenario S9: `text-render` — crisp small rotated text

14 px, rotated 10°, translating every frame. Full treatment — the fidelity instrument, the alignment
guard, the Godot comparison and every reading — is in
[docs/text-rendering.md](./text-rendering.md). What belongs here is the harness-facing shape.

**Arms.** `dom` (the shipped `html` package path), `canvas2d` (`fillText` per run per frame),
`hb-atlas` (HarfBuzz shapes once; each glyph rasterized WITH the rotation and N sub-pixel phases
baked in, blitted 1:1 through `createDrawList` + the WebGL2 executor), `hb-run` (each whole run
baked to one texture and thereafter only translated — the frozen-surface technique applied to text),
`hb-gpu` (HarfBuzz's Slug encoder turns each glyph's OUTLINE into an RGBA16I texel blob and a
fragment shader evaluates coverage from it per frame — no baked pixels, so no atlas resolution, no
phase grid and no baked rotation).

### `hb-gpu` is the one arm that may not be swept

Its wasm is a docker + emscripten output, and it used to live under a **gitignored**
`packages/hb-gpu/dist/`, so a fresh checkout could not render it. It is now **committed** at
`packages/hb-gpu/vendor/` (see `packages/hb-gpu/vendor/VENDOR.md`) and a normal checkout sweeps the
arm. The gate stays, because the file can still be absent — a sparse checkout, or a `build.sh`
interrupted between writing the glue and finishing the binary. Two behaviours, and they are
deliberately different:

- **Default invocation** (`--scenario text-render`, no `--mechanism`) drops it from the sweep, prints
  the four-arm table, and names the absence below it:
  `NOT MEASURED: hb-gpu — … packages/hb-gpu/vendor/hb-gpu.mjs is absent` / `bash packages/hb-gpu/build.sh`.
- **`--mechanism hb-gpu`** with no build **fails loudly**, with the same words. An empty table and
  exit 0 is the same lie in a quieter voice.

The gate is node-side (`src/hb-gpu-build.ts`), evaluated before a fixture is generated or a browser
launched — because a `ready()` throw aborts the WHOLE run (S7's trap), which would turn every
default invocation into a failed run rather than a partial table. It is **never rendered as a zero**:
a blank page has no glyphs to raster, no texture to upload and no draw call to make, so a silently
failed arm would be reported as the fastest and crispest thing on the page. `test/hb-gpu-build.test.ts`
pins all three states (built / absent-and-default / absent-and-explicit).

### `phases`, `bakeRotation` and `bakeShaper` are REFUSED on `hb-gpu`

Not ignored — refused, at mount, with a message naming the arm to sweep them on instead. All three
describe a bake this arm does not have: there is no phase grid (coverage is evaluated at the position
the frame asks for), no rotation in the pixels (it is in the model matrix every frame), and no
rasterizer choice (outlines are encoded by glyph id, which a `fillText` shaper's character keys do
not carry). A run that recorded `phases=4` beside an arm with no phases would be a measurement of
something that did not happen. Defaults are accepted and cannot be refused — `resolveParams`
materialises every default into the page URL, so the arm cannot tell "nobody mentioned phases" from
"the operator asked for 4". `textGpuUnsupportedParam` is the one definition, shared by S9's mount and
the fidelity probe, and modelled on `webgpuUnsupportedParam`.

### `outlinePx` is the same rule pointed the other way

`--param outlinePx <w>` draws each frame's runs TWICE on `hb-gpu` — an outline pass at
`setSpread(w / 2)` in an outline colour, then the fill pass at spread 0 — which is the order and the
arithmetic `packages/canvas`'s glyph pass produces for a consumer's outlined label. It is **REFUSED
on `dom`, `canvas2d`, `hb-atlas` and `hb-run`**, which have no outline at all here: `hb-atlas` /
`hb-run` would need a second baked atlas per radius and `dom` / `canvas2d` a `-webkit-text-stroke` /
`strokeText`, none of which this scenario builds. `textOutlineParamRefusal` is the one definition and
it also refuses a negative or non-finite width on `hb-gpu` itself, because `HbGpuRenderer.setSpread`
CLAMPS those to 0 with no error channel — an `outlinePx=-4` run would draw the plain fill and file
its row under a stroke.

The default is **0**, so every reading taken before the outline path existed still describes what
this arm draws: one pass, `passesPerFrame: 1`, `outlineSpreadPx: 0`.

**The radius is HALF the width and is scaled by the device-pixel ratio.** A centred `strokeText` of
width `W` reaches `W / 2` outward, and this arm's object space IS device pixels — so `outlinePx=6`
is a 3 px radius on the desktop and a **10.46 px** one on a dpr 3.4876 phone. `outlineSpreadPx`
publishes the device radius beside the design width in `params`, because the shader picks its tap
count from the radius and quoting the width for it understates a phone by `dpr / 2`.

**`passesPerFrame` is in the table because both sides of the inkless identity double.** With an
outline the arm reports `quadsPerFrame` 1800 and `inklessGlyphsPerFrame` 280 against an unchanged
`glyphsPerFrame` of 1040, so the relation is
`glyphsPerFrame x passesPerFrame - quadsPerFrame = inklessGlyphsPerFrame`.

**The outline colour is deliberately neither black nor the fill's white.** The page background is
`#101014` and `nonEmptyRatio` counts pixels differing from it, so a black outline would cost every
one of its taps and move that ratio by almost nothing — an outline pass that silently drew nothing
would look identical to one that worked. Measured, the ratio rises monotonically with the radius
(0.0543 / 0.0749 / 0.0908 / 0.1170 / 0.1386 / 0.1579 / 0.1766 at radius 0 / 0.5 / 1 / 2 / 3 / 4 / 5),
which is what makes "the second pass reached the screen" a number rather than an assumption. The
fill is opaque and drawn second, so `sampleHits` is untouched at 40/40.

### The outline's cost is ONE BRANCH, not the tap count — measured

All rows below: `linux-chrome-nvidia` (RTX 2060, headed under Xvfb), 1280x800 @ DPR 1, 1 discarded
warmup, 5 repeats, medians, presence guard 40/40 on every repeat and **0 discards**. Taken
back-to-back in one session on one box, which is the only way these columns may be put beside each
other. `contentUpdateHz` is the honest cadence; the panel's vsync ceiling is ~75 Hz.

At the defaults (`fontSize` 14, `labels` 20, 40 runs, every one of them outlined):

| `outlinePx` | radius (device px) | passes | quads | `glDrawCalls` | `contentUpdateHz` | gap p50 | gap p95 |
| ----------- | ------------------ | ------ | ----- | ------------- | ----------------- | ------- | ------- |
| 0           | 0                  | 1      | 900   | 1             | **75.27**         | 13.33   | 15.18   |
| 1           | 0.5                | 2      | 1800  | 2             | 67.40             | 13.42   | 22.13   |
| 2           | 1                  | 2      | 1800  | 2             | 41.59             | 20.36   | 42.95   |
| 4           | 2                  | 2      | 1800  | 2             | 21.09             | 41.36   | 91.21   |
| 6           | 3                  | 2      | 1800  | 2             | **12.27**         | 74.55   | 153.1   |
| 8           | 4                  | 2      | 1800  | 2             | 10.53             | 91.44   | 285.9   |
| 10          | 5                  | 2      | 1800  | 2             | 8.53              | 106.5   | 226.8   |

That reads as a catastrophe and it is a catastrophe **of the sub-ppem-16 regime only**. Hold the
radius at 3 device px and walk the font size instead (`labels` 12, so the cell fits; total ink area
is roughly flat across the rows because it goes as `labels x fontSize²`):

| `fontSize` | `outlinePx` 0 | `outlinePx` 6 | `outlinePx` 10 |
| ---------- | ------------- | ------------- | -------------- |
| 15         | —             | 20.78         | —              |
| 16         | —             | 19.34         | —              |
| 18         | 75.42         | **17.44**     | —              |
| 20         | 75.68         | **74.76**     | 73.64          |

Two font-size steps, a 4.3x step in frame rate, and the LARGER text is the fast one — while carrying
more band fragments, not fewer. The tap count is identical in every row (radius 3 gave
`rings` 4 and 6/10/15/16 steps = 47 taps throughout under the per-ring clamp of the time; the same
radius spends 6/10/15/19 = 50 under the budget split that replaced it). The only thing that flips is
`hb_gpu_spread_tap`'s `if (ppem < 16.0)` MSAA branch, which turns one tap into **five**
`_hb_gpu_slug_single` evaluations. It fires below `fontSize` ~19 rather than ~16 because `fwidth` is
`|dFdx| + |dFdy|` and these runs are rotated 10 degrees, so the ppem the shader sees is about
`0.86 x fontSize x dpr`.

Confirmed directly by disabling that branch inside the tap (and only there — the fill's own
`hb_gpu_draw` untouched), at `fontSize` 14:

| tap set                        | max taps | `outlinePx` 6 | `outlinePx` 10 | thin-feature fixture        |
| ------------------------------ | -------- | ------------- | -------------- | --------------------------- |
| 4 rings x 16 steps (was)       | 65       | 12.27         | 8.53           | 0/600 short, darkest 255    |
| 3 rings x 12 steps             | 37       | 18.83         | 12.97          | 0/600 short, darkest 255    |
| 2 rings x 8 steps              | 17       | 28.19         | 22.37          | **83/600 short, darkest 0** |
| 4 x 16, no MSAA inside the tap | 65       | **70.47**     | **68.69**      | was blind to it — see below |

`5.74x` and `8.05x` respectively — the 5-evaluations-per-tap arithmetic, paid in full. The ring and
step caps are worth 1.5x (3x12) or 2.3x (2x8) by comparison, and 2x8 buys its 2.3x by punching
**fully black holes** through the outline of a thin feature: `SPREAD_THIN_CASE` (a full stop at
spread 12, in `packages/hb-gpu/test/geometry.ts`) reports 83 of 600 reachable pixels short of solid
with the darkest at 0. That fixture exists for exactly this and it is the reason 2x8 is not a
candidate.

### The MSAA lever was unguarded, then guarded, then taken

Every spread fixture in `glyphPixelXvfb.test.ts` drew at `pixelsPerEm` 96, so none of them took the
`ppem < 16` branch at all — disabling it left all thirteen byte-identical (ink 314860, thin 0/600,
darkest 255). The suite was blind to a 5.7x change in the shader it exists to guard. So the fixture
came first: `SPREAD_LOWPPEM_CASE` (中 at 14 px per em, rotated 10 degrees, spread 3 — S9's own
geometry at the consumer's modal `outlinePx` halved) plus a two-program A/B, and only then the
change. `HbGpuRendererOptions.spreadTapMsaa` now defaults to **false**.

**The A/B is two renderers on ONE context**, differing in one `#define`, drawn in one frame at one
sub-pixel phase — so the GPU, the driver, the glyph, the transform and the phase are held fixed by
construction. That is what the earlier screenshot comparison in this document could not do (two perf
runs at different frame rates sit at different translation phases, which is why it was reported as
qualitative). It asserts three things and each one has been made to fail on purpose:

| assertion                      | measured                   | broken by                                         |
| ------------------------------ | -------------------------- | ------------------------------------------------- |
| the two differ at ppem 14      | 267 px, rms 33.4, worst 85 | naming our macro `HB_GPU_NO_MSAA` -> 0 px         |
| they are identical at ppem 96  | 0 px                       | (see below — the `if` does not pin this)          |
| the spread-0 FILL is identical | 0 px                       | also defining `HB_GPU_NO_MSAA` -> 84 px, worst 40 |

The macro is `HB_GPU_SPREAD_TAP_NO_MSAA` and deliberately **not** the library's `HB_GPU_NO_MSAA`,
which guards `_hb_gpu_slug` — the FILL. Reusing that name compiles, runs, looks plausible and moves
84 pixels of the fill; the third assertion is what catches it.

**What the ppem-96 half does NOT pin, checked rather than assumed:** the `if (ppem < 16.0)` constant.
The blend is `mix (c, msaa, smoothstep (16.0, 8.0, ppem))` and that weight is already exactly 0 above
ppem 16 — widening the gate to `ppem < 200.0` leaves the frame byte-identical. The `if` is a COST
gate on top of a weight that had already vanished, which is the stronger statement for a consumer:
dropping the tap's MSAA **cannot change a pixel of text at or above ppem 16**, however the gate is
written.

**And the trade is not the one that was predicted.** The expected story was "5.74x for a slightly
coarser rim". The pixels say otherwise: the difference is spread across the blob's whole interior,
not its rim, and the variant WITHOUT the MSAA is the one **closer** to an 8x dilated ground truth —
rim RMS 77.9 against 85.1, ink 36102 against 30192 where the ideal grown shape is 58081. A `max` over
coverage taps cannot exceed the peak coverage near a fragment, and at ppem 14 a Han glyph's strokes
never reach coverage 1, so the outline comes out a **translucent mottle at ~60% of the ideal either
way**. The extra smoothing was deepening that shortfall, not repairing it. Images:
`artifacts/perf/outline-study/lowppem-compare.png` (MSAA on | MSAA off | 3x difference, 10x zoom).

That is also why this size is the expensive one: the `cov >= 0.999` interior early-out almost never
fires when coverage never reaches 1, so every fragment walks the whole tap set.

### After the change: the cliff is gone, not reduced

Re-measured back-to-back on the same box, same methodology, presence guard 40/40 (or 24/24 at
`labels` 12) on every repeat with 0 discards:

| `outlinePx` | radius | before (`updHz`) | after (`updHz`) | before gap p50 | after gap p50 |
| ----------- | ------ | ---------------- | --------------- | -------------- | ------------- |
| 0           | 0      | 75.27            | 75.64           | 13.33          | 13.33         |
| 2           | 1      | 41.59            | **75.33**       | 20.36          | 13.33         |
| 6           | 3      | 12.27            | **71.74**       | 74.55          | 13.34         |
| 10          | 5      | 8.53             | **71.92**       | 106.5          | 13.34         |

And the font-size ladder that isolated the branch is now flat — the 4.3x step between 18 and 20 has
gone, every size sits at vsync (`labels` 12, `outlinePx` 6):

| `fontSize`       | 15    | 16    | 18    | 20    |
| ---------------- | ----- | ----- | ----- | ----- |
| before (`updHz`) | 20.78 | 19.34 | 17.44 | 74.76 |
| after (`updHz`)  | 72.99 | 73.18 | 73.75 | 73.25 |

The ring and step caps were not touched and should not be: they were worth 1.5x (3x12) and 2.3x
(2x8) against this branch's 5.74x, and 2x8 buys its share by punching fully black holes through thin
features. `HB_GPU_SPREAD_MAX_RINGS` stays 4.

`HB_GPU_SPREAD_MAX_STEPS` has since been replaced — not raised — by `HB_GPU_SPREAD_MAX_TAPS` 64, a
bound on the WHOLE tap set rather than on each ring, split across the rings in proportion to their
radius (6/13/19/26 at four rings; `docs/text-rendering.md`). The worst case is the same 65 taps
`4 x 16` was, so nothing in this table moves at a radius past 4 device px, which is every radius the
phone draws. A radius of exactly 4 spends 65 where it spent 53, and 3 spends 51 where it spent 48 —
the only sizes where this is a cost change at all, and both are cheaper than the same fragment at a
larger radius has always been.

**What is still true below ppem 16** is that the outline is a translucent mottle, and that is a
fidelity limit rather than a cost one — the same floor `PPEM_FIDELITY_FLOOR` already states for the
fill, and a stronger reason to honour it. Nothing measured here makes small outlined text at DPR 1
look good; it only makes it cheap.

**Two scripts per cell.** A 12-glyph Han run in Noto Sans SC above an ASCII pangram in Roboto, each
a separate `Label` in its own face, stacked by their ROTATED boxes so their ink cannot overlap.
`--param script=han|latin` measures either alone. The default `both` is what the app renders and is
where the `bakeShaper` isolation has something to say: Han is full-width, unkerned and unligatured,
so a per-codepoint walk equals a shaped one, while Latin actually kerns.

**Defaults: `fontSize` 14, `labels` 20, `script` both.** `labels` is 20 rather than 24 because a
`both` cell is 283×143 px and a 1280×800 viewport holds exactly 4×5 of them.

**On a phone the count is whatever that phone's viewport holds, and it is discovered rather than
hardcoded.** The run prints the viewport it measured before it mounts, and an over-subscribed layout
is **refused** — the message names the largest `labels` that fits. A moto g86 5G in portrait reports
a 790×1484 window at dpr 3.4876, i.e. a 349×657 layout viewport, which holds **4** (`both`) and **8**
(`script=han`); the same phone in landscape is 703×281 and holds **2** and **9**. Auto-picking the
count was rejected on purpose: it would silently change the workload between two runs that exist to
be compared.

**Isolations**, all `--param` on the same arm rather than forked arms: `script`, `bakeRotation`
(`false` is the conventional upright atlas rotated by the draw call), `bakeShaper` (`harfbuzz` |
`fillText` — separates "does baking help" from "does shaping help"), `phases` (baked sub-pixel
variants per glyph, as a square grid: 4 is 2×2).

**The stage is the viewport**, so `fitScale` is exactly 1 everywhere. Every other scenario can
afford a fractional fit; this one cannot, because a `transform: scale()` above the stage changes the
raster scale every glyph is rasterized at, and glyph raster scale IS the thing under measurement.
Over-subscription is refused at mount instead of being absorbed by a smaller fit.

**The presence beacon is a glyph** (U+25A0), not a coloured rect: it reaches the screen through the
same cmap, shaping, rasterisation and blit as the text around it, so the guard cannot stay green
while every glyph silently fails to rasterize. It leads **both** runs, so the default samples 40
points and a missing Latin run is a failure rather than an unnoticed absence. The sample point is
the beacon's INK CENTRE — U+25A0's advance is 1 em in Noto Sans SC but 0.604 em in Roboto — **at the
last drawn frame**, because the guard samples a 5×5 device px box (±0.57 CSS px on a phone) while a
run travels ±0.5 em. A rest-position sample would have missed on a phone for Han too.

### DO NOT QUOTE THE HEADLESS RUN FOR THE BAKED ARMS

Under SwiftShader a WebGL2 draw is rasterized on the CPU, so `hb-atlas`/`hb-run` are measured with
the GPU — their entire strategy — removed. Measured at 14 px with both scripts: on
`linux-chrome-148` (SwiftShader) they read 10.10 and 9.54 ms p50 against `canvas2d`'s 1.63; on
`linux-chrome-nvidia` (headed under Xvfb, RTX 2060) the same code reads 0.72 and 0.43 against 0.90.
**The ordering reverses.** Force the env labels apart (`--env linux-chrome-nvidia`) so the two runs
cannot land in one baseline.

### `scenario.*` counters

`atlasPages`, `atlasBytes`, `atlasPageSide`, `atlasOccupancy`, `atlasPhases`, `rasterizedGlyphs`
(glyphs × phases, not distinct glyphs), `shapeMs`, `bakeMs`, `wasmHeapBytes`, `quadsPerFrame`,
`glDrawCalls` on the baked arms; `fillTextCalls` on `canvas2d`; `domNodes` on `dom`; `cellsDrawn`
beside `runsDrawn` (twice it at the default, and the gap between them is all of what `script=both`
added); `distinctFaces`; and `baselinePx` / `baselineLatinPx` on **every** arm, because identical
values there are the evidence that the arms draw in the same place and nothing else in the table
would catch it if they stopped. Per face, because the two faces' CSS line boxes put their baselines
in different places — Noto Sans SC's reads 16 px and Roboto's 13 px at `fontSize` 14.

`atlasBytes` is self-counted from the texture cache, not driver-attributed. `wasmHeapBytes` is
SUMMED across faces: `script=both` with `bakeShaper=harfbuzz` carries two wasm heaps.

**`hb-gpu` reports the same shape where the concept exists, and NOTHING where it does not.**
`atlasPhases`, `atlasPageSide` and `rasterizedGlyphs` carry no key on it — there is no phase grid,
no square page and nothing rasterized ahead of time — and absent means NOT MEASURED, which is the
honest answer for a column an arm has none. Its own keys:

- `encodeMs` / `programMs` / `uploadMs`, split rather than combined. `encodeMs` is
  `hb_gpu_draw_encode` only, so it stands beside `hb-atlas`'s `bakeMs` (also rasterisation only).
  The combined counter **lied**: it read 182.8 ms and then 226.4 ms after the encode work was
  HALVED, because the driver's program link dominates it — 161.5 ms on a cold ANGLE shader cache,
  10–14 ms warm.
- `atlasBytes` (live texels × 8) **and** `atlasReservationBytes` (`4096 × rows × 8`, the whole
  texture), plus `atlasOccupancy` as the bridge. The RESERVATION is the figure comparable with
  `hb-atlas`'s `atlasBytes`, which is also a whole-texture allocation; the live figure is the
  smaller, more flattering one, and both are published so a reader cannot mistake one for the other.
- `blobBytes`, `blobGlyphs`, `blobMinBytes`, `blobMaxBytes` — the Slug format's own size and its
  SPREAD, which on this pool is a factor of 31. A mean alone would suggest an atlas can be sized by
  multiplying it by a glyph count.
- `inklessGlyphsPerFrame`, which accounts for the whole gap between `glyphsPerFrame` (1040) and
  `quadsPerFrame` (900): 140 spaces carry no ink and this arm declines to emit a quad for them,
  where `hb-atlas` emits a degenerate one. Without it the pair reads as 140 dropped glyphs.
- `passesPerFrame` and `outlineSpreadPx`, which are how an outlined row stays readable — both sides
  of the identity above double when `outlinePx` is non-zero, and the DEVICE radius the tap count is
  chosen from is `outlinePx / 2 x dpr` rather than the design width in `params`. See
  [`outlinePx` is the same rule pointed the other way](#outlinepx-is-the-same-rule-pointed-the-other-way).
- `wasmHeapBytes` here is ONE module's heap, because this arm has one: it shapes AND encodes in
  hb-gpu's own HarfBuzz (`shapeRunWithHbGpu`), so each face is resident once. It used to be summed
  across **modules** as well as faces — shaping came from npm `harfbuzzjs` and both faces sat in two
  heaps at once (2.50 + 2.00 MiB). Swept on both rungs after the change, it reads **2 097 152 B on
  every configuration measured** — desktop `script=both`, phone `script=han`, phone `script=both` —
  which is exactly `-sINITIAL_MEMORY`, so the number is a reservation the workload never exceeds
  rather than a high-water mark. Treat it as an upper bound on this arm and not as its live
  allocation. The package was built with `-sINITIAL_MEMORY=2097152` because emscripten's 16 MiB
  default reservation is not a measurement and would have overstated this arm ~8×.

### Traps this scenario has already paid for

- **A query-string boolean is a STRING.** `--param bakeRotation=false` reached the page as
  `"false"`, every natural test read it as truthy, and the run measured the default configuration
  while its own report faithfully recorded `bakeRotation: false`. `readParams` now coerces the two
  boolean tokens; `test/browser-params.test.ts` pins it.
- **A baked sub-pixel offset only makes sense for a draw that snaps.** Bake one into a cell that is
  then drawn at a fractional position and the two ADD, putting every glyph half a pixel out.
- **`resolveGodotSceneTree` defaults to a 1280×720 viewport**, which silently clipped the bottom row
  of a 1280×800 run. The viewport is passed explicitly and the mount asserts the stage box.
- **Two faces in one atlas share a key space.** A HarfBuzz key is a glyph id and a `fillText` key is
  the character itself, and both are per-face: Roboto's gid 97 and Noto Sans SC's gid 97 are
  unrelated outlines. An unqualified key renders one face's glyph where the other's belongs — text
  that is perfectly crisp, perfectly aligned and WRONG, which every column in the table reports as
  fine. Keys are namespaced `<face>/<glyph>`; `test/text-atlas.test.ts` pins it.
- **`resolveResource` is handed `{ type, id }` and no path.** With one font that was invisible;
  with two, a resolver returning one fixed URL sets the Latin run in the Han face. The scenario
  switches on the ext-resource id, which is fixed per face rather than assigned in order.

## The bake probe

`packages/perf-harness/probes/bake-probe.{html,ts}` — **not a scenario**, and deliberately not a
`perf-report/1` producer. It measures no frame rate, takes no trace and runs no presence guard; it
answers "what does the encoder cost, and what does it cost in fidelity" for mechanisms nobody has
committed to yet. Dressing that up as a report would put numbers never measured under this harness's
methodology next to numbers that were.

```bash
mise exec -- pnpm exec tsx packages/perf-harness/probes/bake-probe.ts --local
mise exec -- pnpm exec tsx packages/perf-harness/probes/bake-probe.ts          # the phone
mise exec -- pnpm exec tsx packages/perf-harness/probes/bake-probe.ts \
  --query "count=50&phases=bake&variants=png,webp,webp@0.8"
mise exec -- pnpm exec tsx packages/perf-harness/probes/bake-probe.ts \
  --query "phases=bake&variants=worker-webp,worker-imagedata&workers=1,2,4"
```

Phases are `bake,fidelity,blit,share`; variants are `<kind>` or `<kind>@<quality>`, and a worker
variant is additionally run once per `?workers=` value. The kinds:

| kind                        | what it isolates                                                          |
| --------------------------- | ------------------------------------------------------------------------- |
| `draw-only`                 | slicing with no encode                                                    |
| `png`, `webp`, `jpeg`       | `convertToBlob` from a GPU-resident source                                |
| `png-idle`                  | `png` with a `requestIdleCallback` yield between bakes                    |
| `imagedata-webp`            | one whole-page CPU readback, then no GPU round trip per region            |
| `toblob-webp`, `toblob-png` | `HTMLCanvasElement.toBlob` — a **different call** with different defaults |
| `worker-webp`, `worker-png` | an `ImageBitmap` transferred per region, encoded in a worker              |
| `worker-imagedata`          | the page's pixels transferred once, sliced AND encoded in a worker        |

It drives the phone through the same `openDeviceBrowser` a real run uses (adb reverse, flattened CDP,
foreground probe, lock check), and **writes its JSON result to disk** as well as stdout — a device run
takes minutes and cannot be repeated cheaply.

### A retraction: the 149-second bake was a throttled tab, not a slow codec

An earlier probe run measured, on this phone, PNG at **49,305 ms** for 50 regions and JPEG at
**154,306 ms**, with p50s pinned at a suspiciously exact ~4,050 ms. That number is what set off the
whole investigation, and **it does not reproduce.** Re-run on the same phone with the screen kept
awake, the same probe measures PNG at **1,789 ms**.

The tell was the constant. ~4,050 ms per encode is not a codec doing arithmetic; it is a deadline. A
run that lasts minutes outlives the phone's screen timeout, and a backgrounded or occluded Android tab
has its timers and idle tasks deferred to their forced deadlines — so `convertToBlob`, which runs
PNG/JPEG encodes as idle tasks, gets pinned to a constant that reads exactly like a slow encoder.

A number measured through that is not slow, it is **invalid**, so the probe now says so itself. Every
variant carries the hidden time and worst rAF gap observed while it ran, anything non-zero prints
`!! THROTTLED — this timing is INVALID, not slow`, and the result JSON carries `throttledVariants`.
The authoritative table below ran with `watchdog.hiddenMs = 0`.

### Reference reading — 50 regions from a 4096² page, moto g86 5G / Chrome 151, unthrottled

| variant          | wall total | p50  | p95  | max   | sync total | KB/region |
| ---------------- | ---------- | ---- | ---- | ----- | ---------- | --------- |
| `draw-only`      | **5**      | 0.1  | 0.2  | 0.3   | 4          | —         |
| `png`            | **1,789**  | 29.3 | 71.9 | 267.5 | 982        | 37.4      |
| `png-idle`       | 2,048      | 39.1 | 82.8 | 104.4 | 956        | 37.4      |
| `webp`           | 2,244      | 43.8 | 65.6 | 79.6  | 1,087      | 31.2      |
| `webp@1`         | 2,231      | 44.0 | 66.9 | 81.5  | 1,078      | 31.2      |
| `webp@0.8`       | 2,948      | 55.9 | 89.8 | 138.5 | 1,078      | 9.5       |
| `jpeg`           | 2,255      | 46.1 | 55.5 | 82.0  | 870        | 40.1      |
| `imagedata-webp` | **1,038**  | 17.4 | 50.1 | 72.5  | 244        | 31.2      |

Read together with the retraction, this says something much duller than the original story and much
more useful:

- **Slicing is free.** `draw-only` cuts 50 regions out of a 16 MP page in 5 ms. Whatever a bake costs,
  it is not the `drawImage`.
- **Every codec is in the same order of magnitude**, 1.8–2.9 s for 50 regions, and **PNG is the
  fastest of them.** There is no 45× win waiting to be had by switching format. The `webp` arms are
  ~25% slower than PNG here, not faster.
- **`imagedata-webp` is the fastest arm** (1,038 ms, and only 244 ms of it synchronous) because it
  reads the page back to the CPU **once** and never pays a GPU round trip per region. If a bake ever
  does need to be cheaper, that — not the format — is the lever.
- `png-idle` yields to `requestIdleCallback` between bakes and is within 15% of `png`. On an
  unthrottled tab, idle scheduling costs nothing.

### Off the main thread: the worker arms, and the trap they were nearly measured with

Three arms that are exact twins of the inline ones — same codec, same source residency, differing
only in which thread runs the encode — plus a fan-out sweep (`?workers=1,2,4`) and a per-variant
main-thread occupancy block. The worker source is an inline string behind a `Blob` URL, because the
driver's server answers **every** path with the probe's HTML.

**`sync` is a trap across the worker boundary.** `sync` is defined as "everything before the first
yield". A worker arm's first statement is an `await`, so `sync` can read ~0 **by construction**
whether or not the main thread was freed, and publishing that as "worker sync = 0 ms" would be the
same class of dishonesty as reporting swap rate as fps. So every variant now also carries
`long-animation-frame`'s `blockingDuration`, `longtask` totals, cumulative rAF lateness over a 20 ms
budget, and the rAF rate the page held while it ran. Whether the instruments exist is recorded too
(`instruments` in the JSON), because an absent observer reports zero and a zero meaning "not
measured" is indistinguishable from one meaning "never blocked".

**The guard then earned its place by contradicting the prediction it was written for.**
`worker-webp`'s sync is _not_ ~0 — it is 576 ms, more than half the inline arm's 1,075.
`createImageBitmap` on a GPU-resident source performs its capture **synchronously on the calling
thread**, so shipping the codec to a worker moves the codec and leaves the readback exactly where it
was. That is the "the readback is the cost, not the codec" result `imagedata-webp` implied last
round, now measured directly instead of inferred.

50 regions from a 4096² page, one worker, moto g86 5G, `watchdog.hiddenMs = 0`:

| variant                      | batch ms | setup | sync   | rAF late (>20 ms) | rAF Hz   | worker-side |
| ---------------------------- | -------- | ----- | ------ | ----------------- | -------- | ----------- |
| `webp` (inline, main thread) | 2,043    | —     | 1,075  | 400               | **81.4** | —           |
| `png`                        | 1,089    | —     | 558    | 58                | 90.0     | —           |
| `imagedata-webp`             | 1,238    | —     | 367    | 9                 | 89.9     | —           |
| `worker-webp x1`             | 2,618    | —     | 576    | 43                | 89.9     | 1,951       |
| `worker-png x1`              | 2,337    | —     | 526    | 22                | 89.9     | 1,710       |
| `worker-imagedata x1`        | **709**  | 118   | **12** | **0**             | 90.1     | 638         |

`batch ms` is wall for the whole variant, and it — not the sum of per-region walls — is the number a
fan-out run is read on. Compare **within** a run: `png` reads 1,089 ms here against 1,789 ms in the
nine-variant table above, which is ordinary run-to-run variance on a phone, and is why no row from
one table is subtracted from a row in another.

### The fan-out sweep: one worker is not a win, four is

`?workers=1,2,4`, at a **2048² page** so seven live page copies fit in memory (`worker-imagedata`
gives every worker its own — transferring an `ArrayBuffer` neuters it on the sender, so one readback
cannot be shared out). Halving the page quarters every absolute number; the ratios between fan-out
levels are what this table is for, and the inline arms are measured at the same size as anchors.

| variant                      | batch ms | setup | sync  | rAF Hz   |
| ---------------------------- | -------- | ----- | ----- | -------- |
| `webp` (inline, main thread) | 1,725    | —     | 869   | **86.5** |
| `imagedata-webp`             | 947      | —     | 188   | 90.0     |
| `worker-webp x1`             | 1,827    | —     | 150   | 90.3     |
| `worker-webp x2`             | 896      | —     | 136   | 90.2     |
| `worker-webp x4`             | **255**  | —     | 30    | 88.7     |
| `worker-imagedata x1`        | 479      | 52    | 13    | 89.8     |
| `worker-imagedata x2`        | 198      | 63    | 10    | 89.2     |
| `worker-imagedata x4`        | **113**  | 111   | **5** | 89.1     |

- **One worker is not a win.** `worker-webp x1` at 1,827 ms is _slower_ than encoding inline at 1,725.
  `toBlob` is already partly off the main thread — roughly half the inline arm's wall is not
  main-thread time — so a single worker does not add a core, it adds a round trip. Anyone reaching
  for "just move it to a worker" gets nothing.
- **Fan-out is the lever.** ×2 halves it, ×4 takes it to 255 ms: **6.8× against the inline arm**, and
  better than linear against ×1 because at one worker the main thread's synchronous capture and the
  single encoder serialise against each other.
- **The compound result is the answer to the question.** `worker-imagedata x4` bakes in 113 ms with
  111 ms of setup, against 1,725 ms inline — **7.7× including setup** — while main-thread sync falls
  from 869 ms to 5 ms, a factor of 174.
- **Occupancy agrees with wall.** The inline `webp` arm is the only one that loses frame rate: 86.5 Hz
  and 203 ms of rAF lateness, against ~89–90 Hz and near-zero lateness for every worker arm. On the
  4096² table the same arm sits at 81.4 Hz with 400 ms of lateness.
- Workers have **no `requestIdleCallback`**, so a worker bake is structurally immune to the
  deferred-deadline pathology behind [the retraction](#a-retraction-the-149-second-bake-was-a-throttled-tab-not-a-slow-codec).
- **The output is the same bytes.** On the device run, `webp`, `worker-webp` and `worker-imagedata`
  all emit 31.2 KB/region and `png`/`worker-png` both emit 37.4 KB/region. A worker arm that had
  quietly fallen back to a different encoder would show here before it showed anywhere else.

### `share`: 24 nodes, one image — a proxy, and labelled as one

24 `<img>` at 128 px, timed to `img.decode()`:

| arm                   | total ms | per node |
| --------------------- | -------- | -------- |
| 24 distinct blob URLs | 70.2     | 2.93     |
| one shared blob URL   | **26.3** | **1.10** |

2.7×, which is **consistent with** a single decode and is not a proof of one — blob-URL identity is
the cache key, so this shows the URL cache working and cannot count codec runs. The probe's JSON says
so in a `note` field rather than leaving the reader to infer it. `static-surfaces --param
sharedFrames=true` answers it directly, from `decode.codecRuns` in the trace.

### Fidelity, and the lossless-WebP surprise

Each blob is decoded **back** and diffed against the source pixels. RGB is compared only where the
source is opaque (a lossy codec's colour under a transparent pixel is undefined); alpha is reported
separately, because the real subjects — shader surfaces and particle sprites — are transparent outside
their shape.

| variant          | B/region | rgb mean | rgb max | alpha mean | alpha max |
| ---------------- | -------- | -------- | ------- | ---------- | --------- |
| `png`            | 201,067  | **0**    | **0**   | **0**      | **0**     |
| `webp`           | 185,298  | **0**    | **0**   | **0**      | **0**     |
| `webp@1`         | 185,298  | **0**    | **0**   | **0**      | **0**     |
| `imagedata-webp` | 185,298  | **0**    | **0**   | **0**      | **0**     |
| `webp@0.8`       | 41,870   | 0.588    | 69      | 0          | 0         |
| `jpeg`           | 137,725  | 0.220    | 4       | **119.4**  | **255**   |

**`convertToBlob({type: "image/webp"})` with no quality argument is LOSSLESS in Chrome**, and so is
`quality: 1` — byte-identical output, rgb and alpha error exactly 0, including on a per-pixel-noise
band deliberately added to the source so flat colour could not fake it. `quality: 0.99` is the first
value that switches to the lossy encoder. This was checked because the opposite was assumed, and it
means WebP is both smaller than PNG (185 KB vs 201 KB per region) and exact, with no trade to weigh.

#### `toBlob` and `convertToBlob` are NOT the same call, and a previous round said they were

Every arm above uses `OffscreenCanvas.convertToBlob`. An earlier version of this section stated the
result as being about **`toBlob("image/webp")`** — a method it had never run. It is not the same
method and it does not have the same default. Measured directly (desktop, same source, same regions):

| variant                        | call                     | B/region   | rgb mean  | rgb max |
| ------------------------------ | ------------------------ | ---------- | --------- | ------- |
| `webp` / `webp@1`              | `convertToBlob`          | 185,298    | **0**     | **0**   |
| `toblob-webp` (**no quality**) | `toBlob(cb, type)`       | **41,877** | **0.587** | **71**  |
| `toblob-webp@1`                | `toBlob(cb, type, 1)`    | 185,298    | **0**     | **0**   |
| `toblob-webp@0.92`             | `toBlob(cb, type, 0.92)` | 54,949     | 0.518     | 51      |
| `png` / `toblob-png`           | either                   | 201,066    | **0**     | **0**   |

**`HTMLCanvasElement.toBlob(cb, "image/webp")` with no quality argument is LOSSY** — 4.4× smaller and
up to 71 levels of channel error, which is the profile of `quality ≈ 0.8`. `convertToBlob` is
lossless with the same omission. PNG is identical through both, so this is a WebP-specific default.
Passing `quality: 1` to `toBlob` produces byte-identical output to `convertToBlob`.

It was distorting this harness: S5's `img-webp` arm (`toBlob`) and its `img-worker-webp` arm
(`convertToBlob` in a worker) were encoding **different images with different codecs at 4.4× different
sizes**, so the gap between them was not the thread. Both now pass `quality: 1` explicitly
(`blobQualityFor` in `static-surfaces.ts`), and the S5 tables above are the re-measured, like-for-like
ones. The tell that caught it was a screenshot check: every arm's 24 surface centres matched
`canvas-2d` exactly except `img-webp`, which was off by 4 levels.

**It does NOT affect the consuming project, and a first version of this note claimed it did.** That
project's baker encodes **PNG**, not WebP (`frontend/src/mirror/atlasBaker.ts` — `convertToBlob({type:
"image/png"})`, with a `toBlob(…, "image/png")` fallback), and PNG is byte-identical through both
calls. Nothing there has been shipping lossy frames. The trap is real and worth knowing before anyone
switches that baker to WebP; it has not been sprung.

`jpeg` destroys alpha outright (mean 119.4, max 255) and is unusable for anything transparent,
whatever its timings say.

### The `atlasBaker` diagnosis this contradicts — and what it does NOT license

The consuming project's `frontend/src/mirror/atlasBaker.ts` carries a budget, a backoff and a
kill-switch, and its comments attribute a recorded **3.7 s wall bake** to _"GPU-process contention… a
bake fighting the frames for the GPU"_. Two probe numbers sit against that: slicing costs 0.1 ms per
region, and `imagedata-webp` — which removes the per-region GPU round trip entirely — is only ~40%
cheaper than the GPU-resident arms, not orders of magnitude.

That is evidence, **not a verdict**. The probe bakes into an otherwise idle page; the recorded 3.7 s
was measured during live combat, which is precisely when there is something to contend with. What this
does establish is that the numbers behind the original diagnosis deserve re-measuring under load
before anyone rips the baker's rationing out — and that if a bake there is ever seen pinned near a
round multiple of ~4 s, the first thing to check is whether the tab was foregrounded.

## `perf assert` — relational gates

```bash
mise exec -- pnpm perf -- assert --scenario ancestor-rescale
mise exec -- pnpm perf -- assert --scenario ancestor-rescale artifacts/perf/runs/<timestamp>
```

Exit `0` when every relation holds, `1` when any fails. With a directory argument it re-checks a
finished run without launching Chrome, so a gate can be verified from committed evidence.

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

That is not a way of making the gate pass. It is the measured conclusion of the S2 section above: the
software decode cache re-scales an existing decode instead of re-running the codec, so the stall
cannot occur on this path. Asserting it here would fail every clean run on this box until somebody
appended `|| true`, and the relation would then also be dead on the device runner where it does hold.
It starts being enforced the moment a device run reports the `gpu` family.

Measured output of `pnpm perf -- assert --scenario ancestor-rescale` on this box (exit `0`):

```
PASS  presence: every arm actually rendered
      region-blob 50/50, page-crop 50/50, canvas 50/50
PASS  decode.redecodeCount: page-crop >= 3x every control arm, and >= 3
      page-crop 3, region-blob 0, canvas 0
PASS  decode.maxMs: page-crop's largest single decode >= 3x every control arm's
      page-crop 507 ms, region-blob 94.99 ms, canvas 95.56 ms
PASS  paint.maxSourceToPaintedRatio: page-crop >= 10x every control arm
      page-crop 1820x, region-blob 17.71x, canvas 0x
SKIP  activationGapMs: page-crop stalls past 100 ms and the control arms do not
      decode cacheFamily is "software", not "gpu" — ... Observed anyway: page-crop 0 gap(s) > 100 ms ...

OK — 4/5 relations hold, 1 SKIPPED (not evaluable in this environment — see the detail above; the
gate is not claiming the traced defect reproduced)
```

## Chrome trace event names (observed, not guessed)

**Chrome trace event names drift between versions.** An analyzer coded against remembered names
reports zeroes and nobody notices. `--dump-trace-names` exists so you never have to: run it on the
target Chrome first, then write the matcher against what it actually printed.

Observed on **Chrome for Testing 148.0.7778.56**, headless, SwiftShader (this box):

| expected                   | observed                                                                                                                                                                                                                                                                                                                                  |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ActivateLayerTree`        | present, but **`ph:"I"` (instant), not a complete event** — cat `disabled-by-default-devtools.timeline.frame`, thread `Renderer/Compositor`, args `{frameId, layerTreeId}`                                                                                                                                                                |
| `DrawFrame`                | present, `ph:"I"`, emitted on **both** `Renderer/Compositor` and `GPU Process/VizCompositorThread` at the same timestamp — must be deduplicated by ts or the swap rate doubles                                                                                                                                                            |
| `RunTask`                  | present, `ph:"X"`, cat `disabled-by-default-devtools.timeline`, on every thread including `CrRendererMain`, and it carries `tdur`                                                                                                                                                                                                         |
| `RasterTask`               | present, `ph:"X"`, cat `cc,disabled-by-default-devtools.timeline`, on `Renderer/ThreadPoolForegroundWorker` and `Browser/CompositorTileWorker1`                                                                                                                                                                                           |
| `ImageDecodeTask`          | present, but `args` is **`{pixelRefId}` only — no url**                                                                                                                                                                                                                                                                                   |
| `Decode Image`             | present but rare: it is the **codec run**, nested deep inside the decode task. One capture had 8 of them (368 ms) against 1,019 `ImageDecodeTask`s                                                                                                                                                                                        |
| `PaintImage`               | present, cat `disabled-by-default-devtools.timeline`, `CrRendererMain`; `args.data` carries `{url, srcWidth, srcHeight, width, height, nodeId, nodeName, x, y}` — **the only url-bearing event**                                                                                                                                          |
| `Draw LazyPixelRef`        | present but useless: `args.LazyPixelRef` is `0` on every event                                                                                                                                                                                                                                                                            |
| `RenderSurfaceReasonCount` | **absent**, even with `disabled-by-default-cc.debug` enabled. cc emits one instant _per reason per draw_, so a page with no blend modes / filters / non-axis-aligned clips emits nothing. `CalculateRenderSurfaceLayerList` (cat `cc`, always on) is recorded as `renderSurfaceListPasses` so a `0` can be told apart from "not measured" |
| user-timing marks          | present, `ph:"I"`, cat `blink.user_timing`, name = the mark name                                                                                                                                                                                                                                                                          |

The measured decode nesting chain:

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

### Software vs GPU decode cache — the portability trap

Headless/SwiftShader runs cc's **software** decode path and emits `SoftwareImageDecodeCache::*`. A
real phone with a GPU runs the **GPU** path and emits `GpuImageDecodeCache::*` instead. An analyzer
matching only the software names reports **zero decode on the phone**, and "phones do no image
decoding" is exactly the wrong conclusion to draw.

The analyzer therefore matches both families, and every report carries `decode.cacheFamily`
(`software` | `gpu` | `mixed` | `unknown`). `unknown`, or a `decode.count` of `0`, fails validation:
that state means **unmeasured**, never _fast_.

`*ImageDecodeCache::DecodeImageInTask` is cat `cc,benchmark`, i.e. available without turning on
`disabled-by-default-cc.debug`, which is what makes family detection cheap.

### Two counting traps, both measured

- **Nested totals lie.** A name histogram makes decode look like 3,380 ms of
  `SoftwareImageDecodeCache::DecodeImageIfNecessary`. That is a _nested_ sum. Taking maximal events
  per thread across the whole decode family puts the real decode wall at ~1,754 ms. The analyzer uses
  a containment stack everywhere for this reason.
- **In-raster cache lookups are not in-raster decodes.** The same capture had **1,484** in-raster
  `DecodeImageIfNecessary` calls totalling **2.7 ms** — all cache hits. Counting those as
  `inRasterCount` would fire the hard-failure alarm on every healthy run until everyone ignored it.
  `inRasterCount` counts **codec runs** inside a `RasterTask`; on that capture it was 0.

## Cross-checking with an external browser

`--serve` starts the server, prints one URL per mechanism (with `autorun=1`) and stays up. Point
chrome-devtools-mcp, a phone, or a plain browser at those URLs to check the render visually and to
take an independent trace. A harness whose output nobody can look at is a harness nobody should
trust.

## Measuring on a real phone: `--env device`

```bash
mise exec -- pnpm perf -- --env device --dump-trace-names   # ALWAYS FIRST on a new phone
mise exec -- pnpm perf -- --env device --scenario atlas-sprites --baseline moto-g86-5g
mise exec -- pnpm perf -- --env device --serve              # open the URLs in Chrome ON the phone
```

Same scenarios, same analyzer, same envelope, same presence guard — only the attach mode changes.
A second harness for the phone would have produced numbers that could not be put next to the desktop
ones, which is the only reason to have a device mode at all.

Extra flags: `--device-serial <s>` (default `ANDROID_SERIAL`, or the only connected device),
`--devtools-port <n>` (default 9222), `--adb <path>` (default `GSW_PERF_ADB`, then `adb`).

### Transport: `adb reverse`, not a LAN IP

The harness server stays bound to `127.0.0.1` on the desktop, and

```
adb reverse tcp:<port> tcp:<port>
```

makes the phone's own `127.0.0.1:<port>` tunnel back to it. So the phone loads
**`http://127.0.0.1:<port>/…`** — the byte-identical URL the desktop run uses. This is deliberately
preferred over serving on a LAN IP: it needs no network configuration, survives the phone changing or
losing Wi-Fi, works on a corporate/guest network that blocks peer traffic, and nothing else on the
network can reach the page. No LAN fallback is implemented; if reverse forwarding ever fails, the
error says so rather than quietly binding `0.0.0.0`.

### Attach: flattened, through the browser endpoint

```
adb forward tcp:9222 localabstract:chrome_devtools_remote
GET http://127.0.0.1:9222/json/version   ->   webSocketDebuggerUrl
Target.attachToTarget { flatten: true }  ->   sessionId
```

Exactly the path `src/cdp.ts` already uses, and the only one that works: the legacy per-page endpoint
(`ws://…/devtools/page/<id>`) stopped responding in Chrome 151, and the phone runs a newer Chrome than
this box (Chrome for Testing 148). The DevTools socket name is **discovered** from
`/proc/net/unix` rather than assumed, so Chrome Beta/Dev and WebView (`*_devtools_remote_<pid>`) are
visible instead of being attached to by accident; stock `chrome_devtools_remote` wins when present.

### The Android foreground rule

**CDP drives only the ACTIVE tab.** A backgrounded tab attaches perfectly and then never answers —
`Runtime.evaluate` simply hangs. Every lease therefore:

1. calls `Page.bringToFront`, then
2. probes with a 10 s `Runtime.evaluate("1")`.

A failed probe reports "the attached Android tab never answered" plus what to do about it, instead of
hanging for two minutes and blaming whatever command came next. Lock state is checked **before** any
of that (`adb shell dumpsys window | grep mDreamingLockscreen`), because a locked phone fails the same
way. Mid-run CDP timeouts get the same hint appended.

### What a "repeat" is on a phone

Desktop Chrome gives every repeat a fresh browser context. Android Chrome may refuse that, so the
provider degrades and **records what it actually did** in `env.device.isolation`:

| isolation         | meaning                                                 |
| ----------------- | ------------------------------------------------------- |
| `browser-context` | fresh context per repeat — same as desktop              |
| `new-tab`         | fresh tab, shared caches                                |
| `reused-tab`      | same tab, navigated; HTTP cache cleared between repeats |

In all three the **per-repeat cache-busted image URL** is what keeps each decode cold (Chrome's
decoded-image cache is keyed by URL). Presenting a warm decode as a cold one would be exactly the
quiet lie this harness exists to prevent, hence the field.

### Viewport and fit

The device run measures at the **phone's own viewport, orientation and DPR**. Nothing is emulated.

It used to force a 1280×800 desktop viewport with `Emulation.setDeviceMetricsOverride`, because S1's
stage is ~1064 CSS px wide and a portrait phone's ~412 px viewport pushed most sample points off
screen. That kept the presence guard green **and measured the wrong thing**: content rendered at a
forced desktop size is rastered at a scale the device never uses, and raster scale is precisely what
drives the decode cost this harness exists to measure. A phone baseline taken at a synthetic 1280×800
does not describe what the phone does. It also produced the user-visible symptom that started this
change: on a real portrait phone, not all of the content was inside the viewport.

Instead, the scenario **fits itself into whatever viewport it is given**, in either orientation:

```
scale = min(viewportWidth / stageWidth, viewportHeight / stageHeight)
```

applied as `transform: scale()` on a stage that keeps its px layout, centred in a frame that clips the
letterbox bars. That is not a third strategy invented here — it is the uniform "keep" fit of Godot's
`content_scale_aspect`, which this repo already ships as `observeContentScale` /
`contentScaleStageStyle` (`packages/html`), and which the consuming web client uses to put a
fixed-design-size game stage into an arbitrary browser window. The harness measures what the client
does. What is deliberately NOT borrowed is that client's product specifics (a 1920×1080 design box,
its widescreen stretch, its view-scale table): every scenario declares its own `stageSize`, and
`src/fit.ts` stays product-neutral.

| environment      | viewport                             | fit        |
| ---------------- | ------------------------------------ | ---------- |
| `ci` (default)   | emulated 1280×800 @ DPR 1            | **off**    |
| `--env device`   | the phone's own, whatever it reports | **on**     |
| `--fit`          | unchanged                            | forced on  |
| `--no-fit`       | unchanged                            | forced off |
| `--viewport WxH` | forced (emulated) on either          | unchanged  |

### The grid follows the viewport's aspect

Fitting alone is not enough. A landscape grid fitted into a portrait phone _fits_ — and then renders
tiny, in a band across the middle of an otherwise empty screen. The fit scale collapses (measured:
**0.33** for S1's 1064×544 grid on the moto g86 5G's 349×657 portrait viewport, covering under a
quarter of the screen), so every sprite is rastered far smaller than anything the device would really
draw. That under-loads the exact work the scenario exists to measure.

So a **fitted** run also picks the grid's SHAPE from the viewport's aspect: `gridShapeFor` searches
every column count and takes the one whose grid aspect is closest to the viewport's, comparing in
**log** space so "twice too wide" and "half too wide" cost the same. It takes the cell aspect as an
input, so it serves S1/S2's square sprite cells and S3's 258×126 nine-patch cells alike. On that
phone S1's 50 sprites become **5 × 10** instead of 10 × 5, the fit scale rises to **0.62**, and the
grid covers over 90% of the screen.

**The cell COUNT never changes** — `mounted` is a parameter, and if the workload varied with the
screen no two environments could be compared at all. Only the arrangement moves, and the arrangement
is recorded in `env.geometry.grid` (`"5x10"`) so a reader can see it rather than infer it.

**Unfitted runs keep the authored shape**: 10 columns for S1/S2, 4 for S3. Desktop is a landscape
1280×800 whose aspect-derived shape would be 9 × 6, so the split is gated on `fit`, not on the aspect
— which is what keeps `baselines/linux-chrome-148.json` and the S1–S4 tables below valid. A desktop
`--fit` run does get the adaptive grid, and its geometry line says so.

**`--viewport` on a phone does not do what it says.** Measured on the moto g86 5G (Chrome 151):
asking for `883x412` produced a layout viewport of **712×332**, and the compositor surface came back
at a CSS→image scale of **3.72** for `--dpr 3` and **4.33** for `--dpr 3.4876` — neither the
requested DPR nor the panel's. The harness warns when the viewport it asked for is not the one the
page reports, and the presence guard correctly discards the affected repeats (measured: 45/50 and
27/50 hits, with the sample points landing inside ring-shaped sprites' holes because the art is
resampled off its layout box). Emulation is therefore only useful on a phone for a rough geometry
check, never for a measurement — which is the whole reason the device default emulates nothing.

Desktop keeps its fixed viewport and 1:1 stage **on purpose**: `baselines/linux-chrome-148.json` and
the S1–S4 tables below are this round's measured record, and they only stay comparable if the geometry
does not move. Nothing is inserted into the DOM at all on an unfitted run, so it is byte-identical to
the pre-fit harness.

Every report carries the geometry it was measured at:

```jsonc
"geometry": {
  "viewport": { "width": 349, "height": 657 }, "devicePixelRatio": 3.4876,
  "orientation": "portrait", "fit": true, "fitScale": 0.617647,
  "stage": { "width": 544, "height": 1064 },
  "fittedStage": { "width": 336, "height": 657 },
  "grid": "5x10",
  "emulatedViewport": null,
}
```

and the comparison table prints it, with an explicit warning when `fitScale !== 1`. **Two runs at
different fit scales are not directly comparable on `decode.*`, `rasterMs` or `paint.*`.** A repeat
whose geometry differs from the first measured one — a phone rotated mid-run — is DISCARDED with that
reason rather than averaged into the median, and `perf compare` prints a **GEOMETRY MISMATCH** block
instead of tabling two different experiments as if they were one A/B.

The presence guard is unchanged in strictness and stronger in diagnosis. Scenarios still declare
sample points in their own stage coordinates; the page maps them through the fit (measured stage rect
× scale) before the screenshot is checked, and the guard now counts separately how many misses fell
**outside the viewport entirely** — "the content did not fit" and "the content did not render" are
opposite problems that a bare hit count cannot tell apart. Content that genuinely cannot fit is a
reported scenario failure (`stageSize` too small, or the fitted stage overflowing), never papered
over.

### Recovering a stuck tracing controller

`Tracing.start` fails with **"Tracing has already been started (possibly in another tab)"**. There is
no such tab: Chrome's tracing controller is **browser-global**. Measured on the phone (moto g86 5G,
Chrome 151), the message covers three different situations, and only one of them is recoverable from
inside the harness:

| situation                                                | what actually happens                                                        | recovery                                      |
| -------------------------------------------------------- | ---------------------------------------------------------------------------- | --------------------------------------------- |
| **this** connection left tracing started (wedged repeat) | a browser-level `Tracing.end` releases it                                    | automatic — `startTracing` retries            |
| the connection that started it is **gone**               | Chrome releases the controller itself when the websocket closes              | nothing to do — a Ctrl-C'd run wedges nothing |
| **another live connection** holds it                     | cannot be taken over: `Tracing.end` from anywhere else answers "not started" | **stop the holder**                           |

So the harness sends a browser-level `Tracing.end` (`{ flat: true }`, i.e. **no sessionId**) on attach
and retries `Tracing.start` once. Sending `Tracing.end` per attached PAGE session is not an
alternative — it answers "Tracing is not started" in all three cases and clears nothing, because the
tracing agent is per-connection even though the controller is global.

If it persists, a second client is holding it: another harness process, a `--dump-trace-names` run,
chrome-devtools-mcp, or an open DevTools frontend on the same browser. Stop that. As a last resort:

```bash
adb shell am force-stop com.android.chrome   # then reopen Chrome on the phone; it restores its tabs
```

The failure message says all of this, so nobody has to find this section first.

### GPU on the phone, and what is NOT available there

`--env device` names the GPU from CDP `SystemInfo.getInfo` (`gpu.hardware`:
**`Mali-G615 MC2 (ANGLE)`**, detail
`ANGLE (ARM, Mali-G615 MC2, OpenGL ES 3.2 v1.r44p1-01eac0.9dfad904584e582a866ae268ba67da86)`) and
supplements the trace with `dumpsys gfxinfo com.android.chrome`, reset immediately before the page's
`run()` and read the instant it resolves.

**Read the gfxinfo block for what it is.** Those are **HWUI** frame statistics for Chrome's Android
**View** hierarchy. Web content is composited by the GPU process through a SurfaceControl, so the
percentiles are _not_ the page's frame times and the table says so; `contentUpdateHz` remains the
honest content rate. `Slow bitmap uploads` and `Slow issue draw commands` are HWUI's own
texture-upload / draw-command pressure counters and are aggregated by **worst case** across repeats.
The bracket also covers mount, not only the measured window, because an adb round trip cannot be
placed any tighter than around `run()`.

#### Three things this device cannot give you, measured rather than assumed

Do not spend an hour rediscovering these on a moto g86 5G (Android 15, unrooted):

1. **Hardware GPU busy% is unavailable.** `/proc/mtk_mali/gpu_utilization` and
   `/sys/class/misc/mali0/device/devfreq/*` are **Permission denied** without root. There is no
   unrooted path to Mali utilisation on this device.
2. **perfetto exposes only `android.gpu.memory`** — no `gpu.counters`, no `gpu.renderstages`. So even
   the trace-based route to GPU busy% is closed here. `android.gpu.memory` itself was **deliberately
   skipped**: it costs a second trace session, a pull and a protobuf decoder, to obtain a number that
   `dumpsys gfxinfo`'s `Total GPU memory usage` line already reports, at the same moment, in a dump
   this run takes anyway. That line is what `gpu.device.gpuMemoryBytes` carries.
3. **CDP `SystemInfo.getProcessInfo` returns `cpuTime: 0`** for renderer and GPU processes on Android
   — only the browser process is populated (measured: browser `34022.68`, every renderer `0`). It
   cannot carry the phone's CPU story, which is exactly why `cpu` is derived from trace `tdur`.

What the phone DOES give, and this box cannot, is real GPU op detail: `SurfaceDrawContext::addDrawOp`,
`TextureOp`, `RasterDecoderImpl::DoRasterCHROMIUM`, `Scheduler::RunTask` and friends, on
`CrGpuMain` / `VizCompositorThread` / `CompositorGpuThread`. SwiftShader has none of them.

### Battery and thermal, before AND after

`env.device` carries `batteryPct` / `thermalStatus` sampled **before** the first repeat and an
`after` block sampled once the last one finished, plus `warnings[]`.

A thermally throttled phone silently invalidates a baseline, and **a baseline that cannot be told
apart from a hot-phone run is worse than no baseline at all**. The run prints the drift and stores it:
already-throttled before the run, thermal status rising during it, a battery that heated up ≥3 °C, or
a battery under 20% (Android starts applying its own CPU limits).

### No CPU throttling

`env.cpuThrottle` is `null` for device runs and the validator accepts that for `browser-render` —
throttling the CPU of the slow device you are measuring would measure an emulated phone running on a
phone. `--cpu-throttle` is ignored in device mode.

### What ports between environments and what does not

- **Portable**: `initialRenderMs`, `readyMs`, `frameCostMs`, `contentUpdateHz`, `activationGapMs`,
  `blockedMs`, the whole `decode` block, `paint.*`, `rasterMs`, `mainThreadCpuRatio`.
- **Environment-specific**: `layerCount`, `renderSurfaces`, `swapRateHz`, `presented.nonEmptyRatio`,
  and **the whole `gpu` block**. SwiftShader has no `CompositorGpuThread`, layerises differently, and
  swaps at its own cadence. Comparing a headless layer count with a phone's is meaningless, and
  comparing a SwiftShader `skiaExecute` total with a Mali one is worse — there is no GPU on this box
  at all, so the buckets describe two different machines doing two different things.
- **Environment-specific in a third way — `cpu`**: the numbers are lower bounds from `tdur`, so they
  are only as comparable as the two captures' category sets and thread inventories. `cpu.byThread`
  attribution (which thread holds the work) ports; the absolute milliseconds do not.

Every committed baseline restates this split in its own `portability` block, so a reader of the file
does not have to come back here.

### FU-1 (settled): the mechanism inversion is the GPU CACHE, not the fit scale

Round 1 found that the S1 mechanism ranking **inverts** between this box and the phone:

|             | redecodes (phone / desktop) | contentUpdateHz (phone / desktop) |
| ----------- | --------------------------- | --------------------------------- |
| region-blob | **58** / 0                  | 77.9 / 59.2                       |
| page-crop   | **1** / 3                   | **82.1** / 48.5                   |
| canvas      | 0 / 0                       | 80.8 / 60.3                       |

Shipping a mechanism chosen from the desktop column would have picked the arm that does **worst** on
the real target. But two things differed between those runs — cache family **and** geometry (5×10 at
`fitScale` 0.617 versus 10×5 at 1.0) — so the cause was not isolated.

**The isolation run:** S1 on this box, at the phone's exact geometry.

```bash
mise exec -- pnpm perf -- --scenario atlas-sprites --fit --viewport 349x657 --dpr 3.4876
```

It reproduces the phone's geometry line field for field — `viewport 349x657 @ DPR 3.4876 (portrait)`,
`stage 544x1064`, `grid 5x10`, `fitted x0.617481 -> 335.91x657` — and the geometry-sensitive paint
ratios land on the phone's values exactly (`max source:painted` **1.46x / 150x / 0.00x**, against
17.71x / 1820x at 1280×800). So the geometry really was reproduced.

| S1 region-blob                         | redecodes | codec runs | decode ms | contentUpdate Hz |
| -------------------------------------- | --------- | ---------- | --------- | ---------------- |
| desktop 1280×800, fit off (baseline)   | 0         | 105        | 329       | 59.28            |
| **desktop 349×657 @3.4876, fit 0.617** | **0**     | 115        | 318       | 59.45            |
| phone 349×657 @3.4876, fit 0.617       | **58**    | 116        | 429       | 79.42            |

**Verdict: the fit scale is not the cause.** Holding geometry identical and changing only the cache
family moves region-blob's re-decodes from 0 to 58. `page-crop` moves the same way — 0 re-decodes at
the phone's geometry on this box, against 3 at 1280×800 — so its desktop re-decode advantage is not
geometry either. The inversion belongs to `GpuImageDecodeCache`, and the practical rule stands:
**mechanism choice must be made on a device run.**

### FU-2 (settled): the S2 gate FAILS on the phone — reported as measured

`pnpm perf -- assert --scenario ancestor-rescale --env device`, moto g86 5G / Chrome 151, battery
100%, thermal `none` throughout, geometry 349×657 @ 3.4876 fitted x0.5145, all arms 50/50 presented.
The gate's activation-gap relation auto-enables on `cacheFamily: gpu`, so this run settles it either
way. It settled it as a **FAIL**, verbatim:

```
PASS  presence: every arm actually rendered
      region-blob 50/50, page-crop 50/50, canvas 50/50
FAIL  decode.redecodeCount: page-crop >= 3x every control arm, and >= 3
      page-crop 0, region-blob 107, canvas 0 — below the absolute floor of 3: a ratio against a
      zero baseline would pass an unmeasured run
FAIL  decode.maxMs: page-crop's largest single decode >= 3x every control arm's
      page-crop 151 ms, region-blob 137 ms, canvas 146 ms
PASS  paint.maxSourceToPaintedRatio: page-crop >= 10x every control arm
      page-crop 150x, region-blob 1.46x, canvas 0x
FAIL  activationGapMs: page-crop stalls past 100 ms and the control arms do not
      page-crop 0 gap(s) > 100 ms (p95 15.37 ms, max 40.24 ms), region-blob 0 (p95 18.62 ms,
      max 41.65 ms), canvas 4 (p95 105 ms, max 110 ms)

FAILED — 3/5 relation(s) do not hold.
```

**This is not a flaky run and it has not been retried until it passed.** Read the three failures
together and they are one coherent measurement, in the opposite direction to the gate's hypothesis:

- **page-crop does not re-decode on the GPU cache at all** (0), and its largest single decode
  (151 ms) is within 10% of both control arms'. The gate assumed a 3× separation; the phone gives
  none.
- **The stall the gate hunts is on `canvas`, not `page-crop`.** canvas produced 4 activation gaps
  over 100 ms and its content rate collapsed to **12.91 Hz** against page-crop's 82.99 — while
  page-crop's worst gap was 40 ms. This inverts S1's device reading, where canvas held 80.8 Hz: under
  a per-frame ancestor rescale, the arm that has to redraw every `<canvas>` is the one that falls
  over.
- **region-blob re-decodes 107 times** — up from 58 static — so the re-scale genuinely does drive
  re-decodes on the GPU cache. Just not on the arm the gate accuses.

Only `paint.maxSourceToPaintedRatio` (150× vs 1.46×) still holds, i.e. the **cause class** is present
on page-crop exactly as designed; the phone simply does not pay for it.

The gate has deliberately **not** been rewritten to match. It encodes a hypothesis formed from a
desktop trace, a device run has now contradicted three of its five relations, and whoever owns the
mechanism decision should see the contradiction rather than a gate quietly re-fitted to the data.
What the result does establish is that S2's open question is closed: the traced regression does not
reproduce on `page-crop` on this phone, and the arm that stalls under continuous rescale is `canvas`.

### Decode cache family — verify on the phone FIRST

This box is headless SwiftShader and only ever emits `SoftwareImageDecodeCache::*`. A phone with a
real GPU emits `GpuImageDecodeCache::*`. The analyzer matches both families, but that had only ever
been proved against a synthetic fixture, so on any new phone:

```bash
mise exec -- pnpm perf -- --env device --dump-trace-names
```

The output now leads with an **analyzer matcher probe** — one line per name family the analyzer
depends on (`activation`, `swap`, `main-thread task`, `raster`, `decode task`, `codec run`,
`decode cache family`, `paint`, `scenario marks`), each either `ok` with the names that matched or
`MISS` with the metrics it silently zeroes. Below it, `NEAR MISSES` lists unmatched names that look
like a renamed family member — which is where a Chrome rename announces itself.

`decode.count === 0` is a **validation failure**, not a fast phone. If it happens, the matcher missed.

### Baselines

`packages/perf-harness/baselines/<env>.json`, written by `--baseline [name]` and **committed** — the
one output of this harness that belongs in the repository. Deliberately not under the gitignored
`artifacts/` tree: it is medians per mechanism plus the environment they were measured in, a few KB,
reviewable in a diff, and still there in six months when someone asks whether the phone was always
this slow. Per-repeat `runs`, traces and screenshots stay ignored.

A baseline file holds **one scenario**, so the name has to carry the scenario whenever an environment
has more than one — **and `--baseline` with no name will silently clobber the wrong one.** Bare
`--baseline` writes `<env label>.json`, which is already `atlas-sprites`' file on both environments;
running it from a `static-surfaces` run overwrites S1's committed baseline with S5 medians, and the
diff looks like a legitimate re-capture. Always pass the name:
`--baseline linux-chrome-148-static-surfaces`. Committed today:

| file                                      | scenario                 | environment               |
| ----------------------------------------- | ------------------------ | ------------------------- |
| `linux-chrome-148.json`                   | `atlas-sprites`          | this box                  |
| `moto-g86-5g.json`                        | `atlas-sprites`          | moto g86 5G               |
| `linux-chrome-148-static-surfaces.json`   | `static-surfaces`        | this box                  |
| `moto-g86-5g-static-surfaces.json`        | `static-surfaces`        | moto g86 5G               |
| `linux-chrome-148-effects-runtime.json`   | `effects-runtime`        | this box — **pending**    |
| `moto-g86-5g-effects-runtime.json`        | `effects-runtime`        | moto g86 5G — **pending** |
| `moto-g86-5g-effects-webgpu.json`         | `effects-webgpu`         | moto g86 5G — **pending** |
| `moto-g86-5g-effects-webgpu-runtime.json` | `effects-webgpu-runtime` | moto g86 5G               |

Both `static-surfaces` baselines are the **static** (`updateEveryMs=0`) reading; the update reading is
in the S5 section above and is deliberately not baselined, because it is a second experiment on the
same scenario and a file that could not be told apart from the first would be worse than none.

The two `effects-runtime` rows are **not committed yet**: S6's numbers come off the phone (see [its
traps](#traps)), and baselining the SwiftShader desktop reading first would publish a GL cost that
does not exist on the device as this scenario's record. Capture them with
`--baseline linux-chrome-148-effects-runtime` / `--baseline moto-g86-5g-effects-runtime` — never bare
`--baseline`.

`effects-webgpu` has **no desktop row at all**, which is a stronger statement than "pending": on this
box its WebGPU arms run on a fallback adapter and are void by
[the scenario's own rules](#traps-1), so a committed desktop baseline would be a file full of numbers
about a software rasteriser. Capture the device one with `--baseline moto-g86-5g-effects-webgpu`.

`effects-webgpu-runtime` has no desktop row either, and for a sharper reason than S7's: its two
desktop smoke invocations run in **different display and GPU modes** (headless SwiftShader for the
WebGL arms, headed-under-Xvfb on real hardware for the WebGPU ones), so their columns are not even
comparable with each other — a baseline of them would be two machines in one file. Capture the device
one with `--baseline moto-g86-5g-effects-webgpu-runtime`, at the defaults, and take the `systems=30`
run as a second reading in [the S8 section](#scenario-s8-effects-webgpu-runtime--the-shipped-webgpu-path)
rather than as a second baseline under a name nobody could tell apart.

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
