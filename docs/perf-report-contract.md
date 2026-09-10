# Perf report contract (`perf-report/1`)

`godot-scene-web` owns this schema. Three repos emit it:

| repo              | profile(s)                                       |
| ----------------- | ------------------------------------------------ |
| `godot-scene-web` | `browser-render`                                 |
| `spirectl`        | `producer-walk`                                  |
| `sts2-couch-coop` | `wire-payload`, `asset-render`, `browser-render` |

**The coupling is the JSON shape only.** No repo builds against another. A sibling repo verifies its
envelope by shelling out:

```bash
mise exec -- pnpm perf -- validate-report path/to/report.json
```

Exit code `0` means the envelope conforms; `1` prints one line per issue.

## Envelope

```jsonc
{
  "schema": "perf-report/1",
  "repo": "godot-scene-web", // | "spirectl" | "sts2-couch-coop"
  "profile": "browser-render", // | "producer-walk" | "wire-payload" | "asset-render"
  "scenario": "atlas-sprites",
  "env": {
    "kind": "ci", // | "host" | "device" — see below
    "label": "linux-chrome-148",
    "cpuThrottle": 6, // >= 1 for browser-render on ci; null on device, and for non-browser profiles
    "device": null, // required when kind === "device"
    "geometry": {
      /* required for browser-render — see below */
    },
  },
  "params": {
    "mechanism": "page-crop",
    "mounted": 50,
    "animated": 10,
    "regions": 100,
    "atlasPage": 4096,
  },
  "repeats": 5,
  "warmups": 1,
  "metrics": {
    /* medians across repeats — see below */
  },
  "runs": [
    /* per-repeat raw metrics, same shape */
  ],
  "artifacts": { "trace": "…json.gz", "screenshot": "…png" },
  "failures": [
    /* optional: repeats that were discarded, and why */
  ],
}
```

## `env.kind`

| value    | meaning                                                                                                |
| -------- | ------------------------------------------------------------------------------------------------------ |
| `ci`     | an automated / local browser run on the measuring box                                                  |
| `host`   | a real process on a developer or host machine — a producer walk, or a capture from a running game host |
| `device` | a phone, over adb                                                                                      |

**`ci` and `host` are the same hardware class**, and both must have `env.device === null`. The split
that decides comparability is _local box vs phone_; `host` exists so a capture taken from a **running
game host** does not have to call itself `ci`, which would be false. The `cpuThrottle` rule follows
the hardware class, not the label: a `browser-render` report on `ci` **or** `host` must state a
throttle `>= 1`, and only `device` may report `null`.

`env.device`, when `kind === "device"`:

```jsonc
{
  "model": "moto g86 5G",
  "androidRelease": "15",
  "chrome": "Chrome/152.0.7300.60",

  // conditions sampled BEFORE the first repeat
  "batteryPct": 84,
  "batteryTemperatureC": 30.1,
  "thermalStatus": "none", // PowerManager.THERMAL_STATUS_* name
  "thermalStatusCode": 0,
  "thermalMaxTempC": 31.5,

  // the same sample, taken AFTER the last repeat
  "after": {
    "batteryPct": 81,
    "batteryTemperatureC": 34.2,
    "thermalStatus": "light",
    "thermalStatusCode": 1,
    "thermalMaxTempC": 41.0,
  },
  // conditions that may invalidate this run as a baseline; [] when clean
  "warnings": ["thermal status ROSE during the run (none -> light) …"],

  // optional provenance
  "serial": "ZY32LL2X8W",
  "manufacturer": "motorola",
  "androidSdk": "35",
  "chromePackage": "com.android.chrome",
  "isolation": "new-tab", // browser-context | new-tab | reused-tab
  "viewport": "412x883@2.625", // what the scenario was ACTUALLY measured at
  "naturalViewport": "412x883@2.625", // what the phone reports with no emulation
}
```

`model`, `androidRelease` and `chrome` are required non-empty strings; `batteryPct` must be a number
or `null` and `thermalStatus` a string or `null` — never a placeholder.

**Why both samples are mandatory in practice.** A thermally throttled phone silently invalidates a
baseline, and a baseline that cannot be told apart from a hot-phone run is worse than no baseline.
`isolation` is here for the same reason: on Android the harness may not be able to give every repeat
a fresh browser context, and a warm decode cache presented as a cold one is exactly the kind of quiet
lie the rest of this contract is built to prevent.

## `env.geometry` — required for `browser-render`

**What the run was measured at.** Not a cosmetic annotation: raster and decode cost scale with the
raster scale, so **two runs at different `fitScale` are not directly comparable** on `decode.*`,
`rasterMs` or `paint.*`.

```jsonc
{
  "viewport": { "width": 412, "height": 883 }, // the page's own viewport, CSS px
  "devicePixelRatio": 2.625,
  "orientation": "portrait", // portrait | landscape | square
  "fit": true, // was the scenario's stage scaled to fit the viewport
  "fitScale": 0.387218, // the uniform scale applied; exactly 1 when fit is false
  "stage": { "width": 544, "height": 1064 }, // the scenario's design box, CSS px
  "fittedStage": { "width": 336, "height": 657 }, // stage x fitScale, on screen
  "grid": "5x10", // columns x rows the scenario arranged its cells in, or null
  "emulatedViewport": null, // the FORCED viewport, or null when the browser's own was used
}
```

Rules the validator enforces:

- every `width`/`height`, plus `devicePixelRatio` and `fitScale`, must be a finite number `> 0`;
- `orientation` is one of the three names above;
- `fit: false` **must** carry `fitScale: 1` — that pair cannot be true any other way;
- `emulatedViewport` is a string (e.g. `"1280x800@1"`) or `null`, never absent;
- `grid` is `"<columns>x<rows>"` or `null`. The cell COUNT lives in `params` and never changes with
  the viewport — only the arrangement does — so `grid` says how the same workload was laid out, not
  how much of it there was.

**Why it is required rather than optional.** For a whole round the device runner force-emulated a
1280x800 desktop viewport onto a phone — so the phone's raster scale, and therefore every decode
number, described a size the device never uses — and nothing in the report said so. A browser number
whose geometry is unknown cannot be compared with another one, so the envelope now refuses to carry
one. Non-browser profiles (`producer-walk`, `wire-payload`, `asset-render`) have no viewport and are
not asked for the block.

**`cpuThrottle` is `null` for `kind: "device"`**, including for `browser-render`. Throttling the CPU
of the slow device you are measuring would measure an emulated phone running on a phone; a device
report must not have to invent a factor it never applied.

## Why `profile` exists

The envelope is shared; the **metrics block is not**. Only a `browser-render` report has activations,
image decode, compositor layers or a screenshot. A producer walk has capture times and node counts; a
wire-payload report has bytes per frame. Forcing every repo to fabricate browser fields would make
the schema worse, not more uniform.

So validation splits:

- **Envelope shell** — checked for every profile: `schema`, `repo`, `profile`, `scenario`, `env`,
  `params`, `repeats`, `warmups`, non-empty `runs`, `artifacts` an object of string paths.
- **`browser-render`** — additionally checked against the full metric contract below, including the
  presence guard. This path is strict on purpose.
- **Every other profile** — checked for anti-degeneracy only: `metrics` is a non-empty object, every
  numeric leaf (one level of nesting, so `{p50,p95,max}` blocks and per-category maps are covered) is
  finite, and **at least one leaf is > 0**.
- **Two rules cross every profile**, so the answer lives in the contract once instead of in every
  scenario: `cpu` is required for `browser-render` and validated wherever else it appears, and `gpu`
  is **rejected outright** on any profile other than `browser-render`.

That last rule is the one that matters across all profiles. An all-zero envelope is the shape a
_broken_ measurement takes, not a fast one, and it must never validate.

## `browser-render` metrics

| field                                             | meaning                                                                                                                                                                   |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `initialRenderMs`                                 | `mark("scenario:mount")` → first `ActivateLayerTree` at/after `mark("scenario:ready")`. **Activation-derived, never rAF-derived.**                                        |
| `readyMs`                                         | mount → the scenario's `ready()` promise resolving. JS-visible: "content available", not "content presented".                                                             |
| `frameCostMs`                                     | `{p50,p95,max}` of main-thread busy time per activation interval (top-level `RunTask` on `CrRendererMain`).                                                               |
| `contentUpdateHz`                                 | `ActivateLayerTree` rate over the window. **The honest frame rate.**                                                                                                      |
| `swapRateHz`                                      | `DrawFrame` rate. **NOT a frame rate** — see `docs/perf-harness.md`.                                                                                                      |
| `activationGapMs`                                 | `{p50,p95,max,over100msCount,count}` of gaps between consecutive activations.                                                                                             |
| `blockedMs`                                       | total `blockingDuration` from in-page `long-animation-frame` entries.                                                                                                     |
| `longTaskCount`, `longAnimationFrames`            | counts from the same observers.                                                                                                                                           |
| `decode`                                          | see below.                                                                                                                                                                |
| `paint`                                           | `{count, distinctUrls, maxSourceMegapixels, maxSourceToPaintedRatio}` — the "small element, large source image" cause class.                                              |
| `rasterMs`                                        | total `RasterTask` on raster workers.                                                                                                                                     |
| `layerCount`                                      | CDP `LayerTree` snapshot after the window. Comparable **within an environment only**.                                                                                     |
| `renderSurfaces`                                  | from cc `RenderSurfaceReasonCount` instants; `renderSurfaceListPasses` records how many times the census actually ran, so a `0` can be distinguished from "not measured". |
| `mainThreadCpuRatio`                              | `tdur/dur` over long tasks. Separates _computing_ from _parked waiting_.                                                                                                  |
| `mainThreadBusyMs`, `windowMs`, `activationCount` | window accounting.                                                                                                                                                        |
| `cpu`                                             | CPU across **every** traced process — renderer, browser, GPU. See below.                                                                                                  |
| `gpu`                                             | GPU-process op attribution. **`browser-render` only.** See below.                                                                                                         |
| `presented`                                       | `{nonEmptyRatio, sampleHits, sampleCount, screenshot}` from a post-window screenshot.                                                                                     |
| `watchedImage`                                    | **optional** — per-image paint attribution, present only when the scenario declared a `watchImageUrl`. See below.                                                         |
| `scenario`                                        | **optional** — flat counters the scenario reported about itself. See below.                                                                                               |

### `cpu` — every process, not just the renderer

Required for `browser-render`; **optional but validated** on the other profiles, which are adding it
independently so their numbers can be read in the same table.

```jsonc
{
  "windowMs": 2500,
  "totalCpuMs": 812.4, // LOWER BOUND — see below
  "totalCoreRatio": 0.32, // totalCpuMs / windowMs: fraction of ONE core. May exceed 1.
  "cpuCoverage": 1.0, // share of top-level wall time that carried a `tdur` at all
  "byProcess": {
    // keys: renderer | browser | gpu | a slug of any other process_name
    "renderer": {
      "cpuMs": 649,
      "wallMs": 721,
      "coreRatio": 0.2586,
      "threads": 22,
      "processes": 1,
    },
  },
  "byThread": [
    // sorted by cpuMs desc; `process`/`thread` are the trace's own names
    {
      "process": "Renderer",
      "thread": "CrRendererMain",
      "cpuMs": 164,
      "wallMs": 175,
      "coreRatio": 0.0652,
      "instances": 4,
    },
  ],
}
```

**`totalCpuMs` is a lower bound, not process CPU.** `tdur` is thread CPU time recorded _inside a
traced task_. Work in a category this capture did not enable — and every process Chrome did not
instrument — contributes exactly zero. So this is a floor on what those processes burned, and
`totalCoreRatio` is **not** a `top`-style CPU%. Presenting it as one would be the same class of
dishonesty as reporting the compositor swap rate as fps, which this harness refuses to do. The table
marks the affected rows `(>=)` and prints the caveat above the grid, so the number is never read
without it.

`cpuCoverage` is how you tell how bad the under-count is: it is the fraction of summed top-level
**wall** time that carried a `tdur`. A row with high wall and low coverage is a thread whose CPU is
**unknown**, not one that was idle. On the desktop reference run it is `1.000`.

Rows are folded by the `(process, thread)` NAME pair, not by `pid:tid`: a browser hosting several
renderer processes (a phone with a hundred background tabs does) yields one `Renderer/CrRendererMain`
row, with `instances` saying how many OS threads were summed and `byProcess.*.processes` how many
pids. CPU is taken from **maximal** events only, so nested ops are never double-counted, and an event
straddling a window edge contributes its `tdur` scaled by the clamped fraction.

### `gpu` — `browser-render` only

**A `gpu` block on a `producer-walk`, `wire-payload` or `asset-render` report is invalid**, and
`validateReport` rejects it. A tree walk has no compositor, no GPU process and no frames; a GPU block
there is a claim nothing measured. The rule lives here, once, rather than in every scenario.

```jsonc
{
  "available": true, // false = NOT MEASURED (--no-gpu, or no GPU process), never "idle"
  "hardware": "Mali-G615 MC2 (ANGLE)", // or "swiftshader" on the linux box
  "hardwareDetail": "ANGLE (ARM, Mali-G615 MC2, OpenGL ES 3.2 v1.r44p1-…)",
  "processCpuMs": 431.2, // same LOWER-BOUND caveat as `cpu`
  "processWallMs": 470.0,
  "threads": 4,
  "opDetail": true, // false = GPU threads carry only RunTask: op cost UNKNOWN, not zero
  "byBucket": {
    "uploadDecode": 0,
    "rasterPlayback": 0,
    "skiaPrepare": 0,
    "skiaExecute": 2.31,
    "presentSwap": 0.49,
    "clear": 0,
    "schedulerIpc": 48.38,
    "other": 62.89,
  },
  "topUnbucketedOps": [
    { "name": "SoftwareRenderer::DoDrawQuad", "selfMs": 38.96, "count": 753 },
  ],
  "device": null, // device runs only; see below
}
```

**GPU numbers are comparable WITHIN AN ENVIRONMENT ONLY**, exactly like `layerCount` and
`renderSurfaces`. This box is SwiftShader — a software rasteriser, with no hardware GPU at all — and
the phone is a Mali behind ANGLE. A bucket total from one says nothing about the other, which is why
`hardware` is a required non-empty string: an unnamed environment makes the warning unenforceable.

Buckets are name-matched (regexes ported from couch-coop's `scripts/analyze-gpu-trace.mjs`), and
`topUnbucketedOps` always lists what landed in `other`, so **the taxonomy can never hide a cost**.
The reference script's `texture lifetime` bucket is deliberately not part of this taxonomy: those ops
fall into `other` and surface there by name.

`device` is **the driver's number for this process** — the one GPU-memory figure in this contract that
nothing self-counted. It is filled at the same out-of-band bracket around the page's `run()` by
whichever instrument the environment has, and `source` says which:

| `source`            | environment               | command                                      | what the bytes are                                                                  |
| ------------------- | ------------------------- | -------------------------------------------- | ----------------------------------------------------------------------------------- |
| `"dumpsys-gfxinfo"` | `--env device`            | `adb shell dumpsys gfxinfo <chrome package>` | HWUI's `Total GPU memory usage` for the whole package                               |
| `"nvidia-smi"`      | desktop **headed** NVIDIA | `nvidia-smi -q -x`                           | the driver's per-process figure for the GPU process of the Chrome this run launched |

```jsonc
{
  "source": "dumpsys-gfxinfo",
  "gfxinfo": {
    "totalFrames": 364,
    "jankPct": 0.0,
    "p50Ms": 8,
    "p95Ms": 9,
    "p99Ms": 10,
    "slowBitmapUploads": 0,
    "slowIssueDrawCommands": 0,
  },
  "gpuMemoryBytes": 19723742,
  "gpuMemoryDeltaBytes": null, // this rung RESETS instead of reading twice — no before-byte exists
  "attribution": "dumpsys gfxinfo com.android.chrome (whole package, HWUI's Total GPU memory usage)",
  "memoryDump": null, // --memory-dump only
}
```

The `gfxinfo` sub-block is **Android-only**. On a desktop run every field in it is `null` — NOT
MEASURED, not zero — and the table drops those rows rather than printing seven em dashes under a
heading about an Android View hierarchy that does not exist on that machine.

These are **HWUI** statistics for Chrome's Android **View** hierarchy. Web content is composited by
the GPU process through a SurfaceControl, so the percentiles are _not_ the page's frame times and
must never be printed as such — `contentUpdateHz` remains the honest content rate. What does carry is
`slowBitmapUploads` / `slowIssueDrawCommands`, HWUI's own texture-upload and draw-command pressure
read-out, aggregated by **worst case** across repeats like `decode.inRasterCount`. A counter the dump
did not report is `null`, never `0`.

On a desktop NVIDIA run the same block carries the per-process VRAM instead:

```jsonc
{
  "source": "nvidia-smi",
  "gfxinfo": { "totalFrames": null /* …every field null: Android-only */ },
  "gpuMemoryBytes": 132120576, // AFTER the window: what the driver says the process holds
  "gpuMemoryDeltaBytes": 2097152, // after − before: what mount + the measured window added
  "attribution": "nvidia-smi per-process, pid 1002 (C+G) under chrome pid 1000",
  "memoryDump": null,
}
```

**It is never `<fb_memory_usage><used>`.** That is the whole card (measured on the reference box: 981
MiB, carrying the desktop shell, the editor and the developer's own browser). The bytes come from a
`<process_info>` whose pid is a **descendant of the Chrome the run launched** — found by walking
`/proc` transitively, because Chrome forks the GPU process off a zygote — and whose command line
carries `--type=gpu-process`. **No matching process means `null` (NOT MEASURED), never `0`.**

Both readings are published because they answer different questions. The **absolute** is honest but
carries Chrome's fixed cost (a headed GPU process holds framebuffers, UI tiles and a shader cache
before the page mounts anything), so it cannot price a scenario. The **delta** can: the bracket spans
mount + the measured window. It is also the fragile one — the driver reports whole MiB, so a delta
under ~1.05 MB is _below the instrument_, and a negative delta is memory reclaimed inside the window.

`memoryDump` is the optional `--memory-dump` cross-check: Chrome's own memory-infra totals for
`gpu/gl/textures`, `gpu/shared_images` and `skia/gpu_resources/*`, `after` and `delta`, read from
`size` and **never** `effective_size` (which deduplicates a shared allocation across processes and
would hide a texture the renderer owns and shares into the GPU process). It is **self-counted**:
where it disagrees with `gpuMemoryBytes`, **the driver number is the truth**.

### `watchedImage` (optional)

| field                  | meaning                                                                                       |
| ---------------------- | --------------------------------------------------------------------------------------------- |
| `url`                  | the URL substring that selected the image.                                                    |
| `paintCount`           | `PaintImage` records referencing it, anywhere in the capture.                                 |
| `paintCountInWindow`   | ...and the subset inside the measured window: **records here mean the image was re-painted.** |
| `distinctPaintedSizes` | distinct painted box sizes — each is a separate scaled decode the browser may have to keep.   |
| `sourceMegapixels`     | the source image's size.                                                                      |

Why it exists: run-wide totals cannot answer "was THAT image re-painted?". `decode` is keyed by cc's
opaque pixelRef/content ids, which carry **no URL**, and `paint.count` lumps every image together.
`PaintImage` is the only url-bearing event in a Chrome trace, so a scenario whose claim is about one
specific image (S4: "the 2520×1080 background is not re-painted while unrelated content churns") has
no other way to pick it out.

`paintCount`, `paintCountInWindow` and `distinctPaintedSizes` are aggregated by **worst case**, not
median — like `decode.inRasterCount` and `presented.sampleHits`, they are failure signals, and four
clean repeats must not smooth away a fifth that re-painted the image on every frame.

### `scenario` (optional)

Counters the scenario reported **about itself**, read once after the measured window closes.
`metrics.scenario` — not to be confused with the envelope's top-level `scenario`, which is the
scenario's name:

```jsonc
{
  "simSteps": 37,
  "drawCalls": 1482,
  "loopWakeups": 0, // a MEASURED zero is a finding; an ABSENT key is not one
}
```

A flat `Record<string, number>`: one level deep, numbers only, every value finite. The validator
enforces that shape and rejects an **empty** block — a scenario that counted nothing must omit the
block rather than report `{}`, which cannot be told apart from a read-out that failed.

Why it exists: a CDP trace shows that a page got cheaper, but it cannot say **which of an arm's own
switches** made it cheaper. "The frozen arm's loop really parked" and "the sim-capped arm suppressed
its simulation steps while the draws kept ticking" are JS-visible facts about the scenario's own
mechanism, invisible to trace attribution, and an arm making that claim has to be able to prove it
instead of being believed. Producers on the other profiles may use the block for the same purpose.

**Absent means NOT MEASURED, never zero** — per block and per key alike. A key that only some arms (or
only some repeats) report stays absent on the others and prints `—` in the table; it is never filled
in with a `0` nothing counted. Values are medianed **per key over the repeats that carried that key**,
the same rule as `cpu.byThread`, and the medians keep 4 significant digits without ever losing an
integer digit (a counter is usually a count, and the median of `[12345, 12346]` must not be reported
as `12350`).

The block is **optional and additive**: `perf-report/1` stays valid without it, on every profile, so a
repo adopts the seam when it has something to count rather than at a schema bump.

### `decode`

| field                         | meaning                                                                                                                                                                                                                                  |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `count`, `totalMs`, `maxMs`   | **maximal** decode-family events on decode worker threads and their wall time. Maximal because the families nest (`ImageDecodeTask` > `DecodeImageInTask` > `Decode Image`), and summing all levels triple-counts the same microseconds. |
| `codecRuns`, `codecMs`        | the subset that actually ran the image codec.                                                                                                                                                                                            |
| `distinctImages`, `imageKey`  | distinct images decoded and which trace field the identity came from (`pixelRefId`, `contentId`, `url`).                                                                                                                                 |
| `redecodeCount`, `redecodeMs` | **codec runs beyond the first for the same image.** A decode task that hits the discardable cache costs ~0 and is not a re-decode.                                                                                                       |
| `inRasterCount`, `inRasterMs` | **codec runs that happened inside a `RasterTask`.** Any value > 0 is a hard failure — see below.                                                                                                                                         |
| `cacheFamily`                 | `software` \| `gpu` \| `mixed` \| `unknown`.                                                                                                                                                                                             |

`inRasterCount > 0` means an image was too large for the discardable decode cache, so its decode is
re-paid on **every re-raster, forever**. Report it as a failure, not as a slow number.

`cacheFamily === "unknown"` (or `count === 0`) means no `SoftwareImageDecodeCache::*` /
`GpuImageDecodeCache::*` event matched. That is **unmeasured, not fast** — the validator rejects it.

## Aggregation rules

- `metrics` is the **median** across `runs`, field by field. Medians, not means: one
  thermally-throttled or GC-interrupted repeat must not move the number.
- Medians are rounded to **4 significant digits, not 2 decimal places**. Decimal rounding annihilates
  ratios: real `mainThreadCpuRatio` readings of `[0.003, 0.0029, 0.0029, 0.0029, 0.0033]` have a
  median of `0.0029`, which a 2-decimal round reports as `0` — indistinguishable from "not measured".
- Two fields are aggregated by **worst case**, never median: `decode.inRasterCount` /
  `decode.inRasterMs` and `presented.sampleHits`. Both are failure signals, and four clean repeats
  must not smooth away a fifth broken one.
- A repeat that fails the presence guard is **excluded from `runs`** and listed in `failures`.
