### G7k — startup, memory, soak (sonnet)

- **Files**: the `g7-k` legs, the samplers' wiring and the soak checks (Q10).
- **Checks**: Q10's startup and soak checks.
- **Sabotages**: `no-evict` and `leak-gl-textures` with exact failure sets.
- *Amended 2026-10-15 (D29):* GSW reports its wasm heap (`rs-gsw-wasm`'s `memory.buffer`, which
  never shrinks) beside the JS heap. `RS_RECEIVER_MEMORY_BUDGET_BYTES` counts the core's payload
  cache in wasm memory and the GL textures.


#### As built

Result: [results/gate7/g7k.md](../../results/gate7/g7k.md).

- **Legs.** `run-gate7.sh --legs g7-k --live` runs `run-gate6.sh --legs g6s` (soak) and
  `--legs g6l` (startup) once per browser kind, with `GATE7_MEM_SAMPLE=1` for the memory samplers
  (`gate7k-samplers.ts`). Knobs: `G7K_SKIP_SOAK`, `G7K_SKIP_STARTUP`, `G7K_SOAK_LEGS`,
  `G7K_STARTUP_LEGS`. Startup is `startup-cold-r0..r5` and `startup-warm-r0..r5`; `r0` is a cold
  load, `r1..r5` are the judged repeats. Warm needs HTTP validators, so run-gate7.sh sets
  `GATE7_STATIC_CACHE=1` for startup runs.
- **Budget.** GSW's budget is store payload bytes plus resident-texture GL bytes
  (`rs-core` accessors `Applier::resident_texture_hashes`, `PayloadStore::bytes_of`; output
  unchanged); the web export's is its GDScript payload cache. Staged payloads in the core (G7o3) are
  copies of cache entries and are unstaged on eviction, so they are not double counted; the wasm heap
  line shows them. The web export's received-bytes mirror is capped by
  `RS_RECEIVER_RECEIVED_MAX_BYTES` (1 MiB for soak legs).
- **Web soak pixels** are judged with G7b's `classifyShot` band against the native
  `reference-step11` (other must be 0; observed 9691/159/0 = G7b's oracle). GSW uses Q7.
- **Sabotage sets** are judged exactly (`G7K_SABOTAGE_SETS`). `leak-gl-textures` does not fail
  `gpu-mem-bounded` (`nvidia-smi` cannot see that allocation path), so that check is typed
  `unavailable` for the leg and the required set is `{residency-bounded:gl-textures}`.
- **Timing.** Startup distributions need a quiet machine (1-min load under about 4); an earlier
  pass under load 12-17 was superseded by a quiet rerun. A 12-leg startup run plus the soaks takes
  about 2 h wall when other agents hold the lock.

#### G7kr: the page's renderer, and `rss-bounded-renderer`'s bound

Until G7kr the sampler kept the first `renderer` pid `SystemInfo.getProcessInfo` listed, an idle
renderer flat at 70 MB, so every `rss-bounded-renderer` pass from G7k to G7kh measured the wrong
process (G7kh's finding; [results/gate7/g7kr.md](../../results/gate7/g7kr.md)).

- **Which renderer is the page's.** The pinned Chromium offers no target-to-pid call headless, so
  the page proves it: the sampler makes it touch a 128 MiB buffer, the renderer whose RSS rises by
  at least half of that is the page's, and the buffer is dropped and collected. Per-leg
  `mem-procs.json` names every process (`browser`, `GPU`, `page-renderer`, `other-renderer-<pid>`,
  the utility processes), and `mem-summary.json` holds each role's start, medians at 60-90 s and
  330-360 s, end, extremes and settled points. `mem-timeline.jsonl` keys `rss_bytes` by role.
- **Settled samples.** Every 30th tick forces a full GC (`HeapProfiler.collectGarbage`) before
  reading RSS and marks the sample `post_gc`. The web export's page renderer is a V8/Oilpan
  sawtooth (395-562 MB in one honest soak), so a median over 30 s of raw samples cannot judge it.
- **Bound.** Q10's 16 MiB growth and 2 MiB/min slope over the post-GC points, plus 5 KiB per
  payload GET (`RSS_BYTES_PER_GET`; the slope's allowance uses the GET rate over the leg). That
  allowance pays for the measurement harness, not for the receiver or for Chromium's fetch path:
  Playwright enables CDP's Network domain on every page it drives, and the DevTools Network agent
  keeps a record per request for the page's lifetime. Post-GC, a content-free cross-origin `fetch`
  loop in the pinned Chromium 1223 (45 GET/s, 375 B bodies, 16,842 GETs in 6 min) costs its
  renderer 0.23 KB/GET bare and 3.9 KB/GET with `Network.enable` on the page's session, in V8's
  Oilpan cage and PartitionAlloc; `maxTotalBufferSize=0` removes only part of it (3.2 KB/GET), and
  a critical memory-pressure notification reclaims none. The honest GSW soak measures 3.6 KB/GET
  (16,539 GETs; 165.5 -> 224.5 MB over 330 s, in the same two places), so 5 KiB is the control's
  figure plus about 28%. An earlier derivation (3.0 KB/GET "Chromium fetch churn", G7kr's first
  pass) read raw RSS with no forced GC and is superseded. The web export fetches about 120
  payloads, so it keeps the base budget.
- **Web export: a known shortfall, report-only.** The web export's page renderer grows linearly,
  7.4-10.3 MB/min post-GC, with no GETs to account for it. About 1-1.4 MB/min of that is JS heap:
  emscripten's GL-id tables, which never reuse ids, while Godot GLES3 creates about 855 GL
  objects/s. About 5.8 MB/min is PartitionAlloc, and none of the one-factor controls on the real
  leg removed it: Playwright's Network domain off, shots off, no MEMFS copy of received bytes, or
  `httpclient` instead of the `fetch()` glue. So `rss-bounded-renderer@web` is typed
  `known-shortfall` (`asKnownShortfall`, `WEB_RENDERER_RSS_SHORTFALL`). It is never a pass and
  never gating. It carries the measured growth and slope, the bound's own verdict and the cause,
  and its owner is the follow-up G7kw2. GSW stays gating.
- **Sabotage sets.** `no-evict` now also trips `rss-bounded-renderer` on GSW (the page renderer
  carries the wasm heap's +11 MB and the JS heap's +5 MB: slope 3.5-3.6 MB/min against 2.2); it is
  an `allowed` consequence, as `js-heap-bounded` is. `leak-gl-textures` is unchanged. No failure
  set counts a known-shortfall row, so the web export's sets are unchanged.

