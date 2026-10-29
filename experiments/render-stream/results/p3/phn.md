# PHN: the moto g31 as a live viewer through the client package (2026-10-29)

PHN puts the moto g31 (adb `ZY22FD8XP3`, Chrome 156.0.8078.47, Mali-G52 MC2 over ANGLE) in front of a
live render-stream host on this machine, through `@godot-scene-web/render-stream-client` (MIR-1). The
host is capture-scale at `/12`, credit window 2, W11t `zstd-base` coding and token auth. No phone
had been a live viewer of the `/11`–`/12` stack before.

**Verdict: the phone misses the bar by 4.5×, and one function causes most of it.**

- **Rate.** The g31 draws **12.8 distinct applies/s** on capture-scale (bar: ≥ 58/s). Its frame
  time is 68 ms at p50 and 85 ms at p95. The credit round trip is 132 ms at p50 and 147 ms at p95.
- **Main thread.** It is saturated: 0.99 of a core on `CrRendererMain`, 95% of it in wasm.
- **The cause.** Wasm's `memcmp` takes 48% of the main thread, called from `Applier::apply`. Its
  source is rs-core's `MaterialResidency::apply`:
  - it walks every named material's every parameter on every frame;
  - it checks the stale names in O(params²) string comparisons;
  - wasm's `memcmp` is a byte loop. Natively it is SIMD, so the native receivers never showed this.
- **A/B on the host only.** `RS_SCALE_PARAMS=4` instead of 64, with no client change: memcmp drops to
  4%. The rate rises to **40–41 distinct applies/s** (47/s with folds), at a 17.0 ms frame p95 and a
  credit RTT of 29.6 / 43.5 ms.
- **Mount/dispose ×3 passes on the phone.** Each dispose gives the instance back: the page renderer
  drops from 410 to 76–79 MiB PSS. Nothing grows across four mounts, and every instance starts at
  the same 1.25 MiB heap. MIR-1's desktop one-time ~220 MiB residue does not appear here: the
  renderer stays 24–27 MiB above its level before the first mount.
- **Memory.** A 323 MiB wasm heap puts the renderer at 410–428 MiB PSS (510–530 MiB RSS) on a
  3.8 GB phone with ~1.7 GB available, with no tab kill. MIR-D's 561 MB STS2 heap was not run (see
  "Heap").

## How the phone is reached

`scripts/client-device-check.ts` is `client-live-check.ts`'s phone edition. It runs as
`bench-live-scale.sh --receiver host-only --rx-cmd …`, so the host's tap judges the connection.

- It opens the device-table entry (`fixtures/gate7-devices.json` `g31`) through
  `browser-harness.ts` `openHarnessDevice`:
  - an `adb forward` to `chrome_devtools_remote`;
  - an `adb reverse` of the page port (8954) and of the host port (8956), so the page and the host
    are both `127.0.0.1` on the phone, and the host's allowed origin matches;
  - the session settings (stay-awake, landscape lock).
- It opens a fresh tab in its own browser context, loads `web/client-phone/`, and closes the tab at
  the end. Every forward, reverse and setting is undone, on every exit path.
- `web/client-phone/page.ts` mounts the package full screen as a phone viewer would: a 16:9 canvas
  that fills the landscape viewport, its backing at the DPR. On the g31 that is 587×330 CSS px and
  a 1540×866 backing. Like `web/client-check/`, the page loads nothing of the harness receiver.
- `web/client-phone/probe.ts` wraps `requestAnimationFrame`, `WebSocket.onmessage`, `fetch` and
  `longtask`, plus every WebGL2 method on demand. It times the package from outside, without
  changing it.
- The page is not cross-origin isolated (product-like). `performance.now()` is therefore 100 µs,
  which is fine for millisecond-scale callbacks.

The measured window is mount 1's 180 s from its first frame:
- page side: per-second `stats()`, the probes, and cpufreq every 15 s;
- nothing runs `dumpsys` inside the window.

Then come three 10 s attribution windows, in order:
1. the GL probe;
2. a CDP trace of the renderer, GPU and browser processes (`perf-harness` `startTracing` +
   `computeCpu`);
3. a CDP CPU profile at 500 µs sampling. The wasm keeps its name section, so wasm functions are
   named.

After each dispose, the driver runs two `HeapProfiler.collectGarbage` passes, then `dumpsys
meminfo` for every Chrome renderer and the GPU process. Battery, temperature and thermal status are
read before and after.

```
S=<core dir from packages/render-stream-client/scripts/build-web.sh>
RS_BENCH_PORT=8956 RS_BENCH_PAGE_PORT=8954 bash experiments/render-stream/scripts/bench-live-scale.sh \
  --extension <capture>/render_stream_capture.gdextension --receiver host-only --protocol 12 --window 2 \
  --frames 30000 --out <out> \
  --rx-cmd 'mise exec -- pnpm exec tsx --conditions=development experiments/render-stream/scripts/client-device-check.ts
    --dir "$RS_BENCH_RX_DIR" --port "$RS_BENCH_PAGE_PORT" --ws "$RS_BENCH_WS_URL" --http "$RS_BENCH_HTTP_ORIGIN"
    --token-file "$RS_BENCH_TOKEN_FILE" --protocol 12 --window 2 --core $S
    --main-s 180 --remounts 3 --cycle-s 20 --attrib-s 10' \
  -- GRC_LIVE_AUTH=token [RS_SCALE_...=...]
```

All four legs ran in real time under the bench's exclusive quiet lock, with the capture and the
client core built at 900afa5c, before HC5 moved transaction forming off the host's main thread. That
change is host-side, and every leg here is phone-bound. The phone was on USB power
at 100% battery throughout, with thermal status `none` (0) before and after every leg.

## Leg 1: capture-scale, `/12`, window 2, W11t, token (180 s + attribution + 3 remounts)

The fixture defaults: 4,200 items, 700 textures (170 drawn), 187 meshes (76 updated every frame),
560 materials × 64 parameters (8 updated a frame) and 100 movers.

| | value |
| --- | ---: |
| distinct applies/s, host tap (bar ≥ 58) | **12.8** (sent 12.9, folded 4) |
| applies/s, page (`stats().applied` over the window, folds included) | 13.7 |
| credit RTT p50 / p95, host tap | 132.0 / 147.1 ms |
| latency p50 / p95, host tap | 128.3 / 143.0 ms |
| rAF rate; frame interval p50 / p95 / p99 | 19.3/s; 68.0 / 85.1 / 85.2 ms |
| rAF callback (apply + lower + draw submit) p50 / p95 | 57.9 / 60.8 ms (795 ms busy per s) |
| `onmessage` (zstd + accept) per message p50 / p95 | 12.3 / 13.8 ms (165 ms per s) |
| long tasks (> 50 ms) | 2,436 in 180 s |
| wire (coded), page side | 253 KB/s; 18.8 KB a message p50 (tap: 370 KiB uncoded patch p50) |
| first frame after `mount()` | 13.35 s (session at 0.49 s) |
| wasm heap; JS heap | 322.7 MiB; 3.8 MiB |
| page renderer PSS / RSS: before mount, streaming | 52.3 / 137.8 MiB, then 411.9 / 512.7 MiB |
| GPU process PSS / RSS: before mount, streaming | 64.9 / 148.2 MiB, then 74.1 / 163.8 MiB |
| host fps | 57.9 |
| machine load (1 min) at leg start / driver start / end | 3.77 / 1.98 / 3.92 |
| battery temperature; thermal status | 26.3 → 28.1 °C; none → none |
| cpufreq in the window | A75 2.0 GHz (one sample 1.35), A55 1.0–1.6 GHz |

## Leg 2: an STS2-shaped load, capture-scale churn (180 s + attribution)

No tool replays a kept STS2 recording live through a host:
- `replay-native.sh` and `replay-gsw.sh` (C3), `gate8-delivery-tool.ts` and the gate replays all
  feed recordings to receivers as files;
- the hub is only fed by the capture.

Writing a recording→hub replayer was not cheap, so this leg uses capture-scale's churn
(`RS_SCALE_REDRAWS=170 RS_SCALE_REDRAW_VARY=17`): 170 items re-recorded each frame, 17 of them with a
real change. STS2 itself was not launched (MIR-3 holds the game lease).

| | value |
| --- | ---: |
| distinct applies/s, host tap | **12.1** (folded 2) |
| credit RTT p50 / p95; latency p50 / p95 | 143.8 / 155.2 ms; 140.4 / 151.1 ms |
| frame interval p50 / p95; rAF callback p50 / p95 | 68.0 / 85.1 ms; 59.3 / 62.0 ms |
| `onmessage` p50 / p95 | 15.1 / 16.7 ms (196 ms per s) |
| wire (coded) | 290 KB/s; 22.7 KB a message p50 (482 KiB uncoded patch p50) |
| first frame | 13.8 s |
| wasm heap; renderer PSS / RSS streaming | 323.0 MiB; 428.1 / 529.9 MiB |
| host fps; load at driver start / end | 59.4; **13.76** / 3.03 (other agents' builds started after the gate) |
| battery temperature; thermal status | 27.5 → 28.4 °C; none |

Churn costs the phone about 3 ms more per message and per frame, but the rate is set by the same
material walk as leg 1. The host held 59.4 fps despite the load spike, and the phone is the
bottleneck, so the load does not move this leg's result.

## Leg 3: mount/dispose ×3 (leg 1's mounts 2–4, 20 s each)

| mount | first frame | applies/s | renderer PSS streaming → after dispose + GC | GPU PSS after | wasm heap at start |
| --- | ---: | ---: | --- | ---: | ---: |
| before mount 1 | — | — | 52.3 | 64.9 | — |
| 1 (180 s) | 13.35 s | 13.7 | 411.9 → 79.3 | 66.7 | 1,310,720 |
| 2 | 11.21 s | 14.4 | 409.9 → 79.0 | 66.4 | 1,310,720 |
| 3 | 10.84 s | 14.4 | 409.2 → 79.1 | 66.3 | 1,310,720 |
| 4 | 11.15 s | 14.4 | 409.7 → 76.1 | 64.4 | 1,310,720 |

All five driver checks pass:
- `mounts-streamed` 4/4;
- `instance-released`: each dispose drops ≥ 330 MiB against a 322.7 MiB heap;
- `remount-no-growth`;
- `heap-baseline`;
- `device-provenance`.

The JS heap returns to 1.2–1.3 MiB after each dispose. On the phone, the post-dispose renderer sits
24–27 MiB above the cold level. That is not the desktop's ~220 MiB one-time `partition_alloc`
residue.

## Attribution

Main-thread split from the CPU profile, by the client's core entry point (L1 / L2 / L3 = leg 1,
leg 2, the A/B):

| | L1 default | L2 churn | L3 params=4 |
| --- | ---: | ---: | ---: |
| `GswRs::apply` (resolve, residency, lower) | 75% | 72% | 32% |
| `GswRs::live_accept` (validate, record SHA-256) | 14% | 16% | 22% |
| `GswRs::draw` (executor) | 4% | 4% | 10% |
| zstd decode (ruzstd) | 3% | 3% | 6% |
| idle | 0% | 0% | 16% |
| self `memcmp` | **48%** | **47%** | 4% |
| self `sha2::compress256` | 7% | 7% | 10% |

- **Core apply.** All 4,838 ms of leg 1's `memcmp` samples (10 s window) sit directly under
  `render_stream_core::apply::Applier::apply`, where `MaterialResidency::apply` is inlined. Every
  frame, that function does two things for each named material, whatever the delta:
  - it looks up each of its 64 parameters in a `BTreeMap<Box<str>, Param>`;
  - it scans `m.params.keys()` against `entry.params` linearly (`any(|p| &p.name == *n)`).

  That is ~560 × 64²/2 ≈ 1.1 M equal-length name comparisons a frame, each a wasm byte-loop
  `memcmp`: about 35 ms of each ~58 ms apply on the g31. Cutting the parameters to 4 (leg L3, host
  side only) removes the term: memcmp 48% → 4%, rate 12.8 → 41.2/s. A 30 s repeat (L3b) gave
  40.0/s.
- **GL draw.** It is not the limit. The GL probe counts ~1,217 WebGL calls per applied frame
  (`drawElements`/`bindTexture` ~350, `useProgram` ~175 and `texSubImage2D` ~97 each). Their time
  inside the rAF callback is p50 2.4 / p95 3.1 ms, an upper bound since the probe adds its own
  overhead (callback p50 57.9 → 61.8 ms with it on). The trace shows the GPU process's
  `CrGpuMain` at 0.43 of a core in leg 1 and 0.55 at L3b's ~40/s.
- **Transport and credit.** Not the limit either. On the host tap, the credit round trip is the
  phone's own frame time twice over (window 2): 132 ms at 13/s, 29.6 ms at 41/s. The adb reverse
  carries the coded stream at 0.25–0.45 MB/s, against a measured ~19 MB/s each way.
- **The next limit after the fix** (L3, ~41/s): the main thread is ~72% busy. `onmessage` takes
  6 ms p50 per message (310 ms/s), of which the record SHA-256 in `Validator::accept` is 10% of the
  thread. The rAF callback takes 8.3 ms p50 and 13.8 ms p95.

**First frame (11–14 s) is transport-bound, not core-bound.** The session opens in 0.2–0.5 s. Then
the join GETs 207 textures, **234 MiB** of decoded RGBA (the package offers `decoded` texture
encodings only), over the adb reverse at ~19 MB/s. MIR-1 measured 3.9–4.5 s on desktop. A phone on
Wi-Fi depends on the link, and KTX2/zstd delivery in the client (gate 8's G8k path) is what would
change this.

## Heap

MIR-D's concern: STS2 combat's wasm heap is 561 MB. On the g31 (3.8 GB RAM, ~1.7 GB available at
rest), capture-scale's 323 MiB heap streams with the renderer at 410–428 MiB PSS and the GPU
process at 68–74 MiB. The phone killed no tab and gave no memory warning. The renderer runs about
90 MiB above the heap, so a 561 MB heap would put it at ~650 MiB PSS. That was not measured here.
The STS2-shaped leg stands in with capture-scale churn, whose heap is the same 323 MiB.

STS2 combat carries 561 materials with 23,749 parameters (p3-cap.md), so it sits in the same
`MaterialResidency` regime as leg 1. Expect the same per-frame walk to dominate its phone apply,
less steeply: about 42 parameters per material on average, against 64 here.

## Against the bar

| bar | leg 1 | leg 2 | after the A/B (no code change) |
| --- | ---: | ---: | ---: |
| ≥ 58 distinct applies/s | **12.8, fail** | **12.1, fail** | 40.0–41.2, fail |
| 60 fps presentation (rAF at 58.8 Hz vsync) | 19.3/s, p95 85 ms, fail | 17.2/s, fail | 58.0/s, p95 17.1 ms, pass |
| credit RTT p50 ≤ 100 ms (bench) | 132.0, fail | 143.8, fail | 29.6, pass |
| mount/dispose: released, no growth | pass | — | — |

## Next bounded fix (not implemented here)

**rs-core `MaterialResidency::apply`: make the per-frame cost follow the delta, not the resident
set.**
- Walk only `delta.materials_upserted`, plus the materials whose naming or shader changed (the full
  walk stays for `all`/first).
- Replace the O(P²) stale-name scan with an O(P) one: skip it when the sorted names are unchanged,
  or use a set.

Natively this is invisible (SIMD `memcmp`); in wasm on the g31 it is ~35 ms a frame. The check is a
leg-1 rerun with this driver, expecting ≈ L3's 40/s. Second in line, once that lands: the live
record SHA-256 in `Validator::accept` (10% of the thread at L3). Both fixes reach every receiver, so
they need rs-core goldens and the native gates.

## Deviations

- **STS2 recording.** Not replayed live: no recording→hub replayer exists (leg 2 above). Capture-scale
  churn stands in.
- **Remount count.** Mount/dispose ×3 ran as leg 1's mounts 2–4, after its 180 s mount 1: four
  disposes in all.
- **Context loss.** MIR-1's mid-mount context loss/restore was not run on the phone, to keep mount 1's
  window clean.
- **Credit RTT.** The page's `stats().creditRttMsP50` is the client's own definition (a submitted ack
  to the next arrival: 13.4 ms in leg 1). The bar's credit RTT is the host tap's.
- **`rate-60`.** The driver reports it and does not gate on it. The bench's `update-rate` and
  `credit-rtt` fail on legs 1–2 (exit 1) and pass on L3/L3b.
- **The trace in leg L3.** It failed in the driver (`Math.min(...events)` overflowed the stack).
  This is fixed, and L3b re-ran the configuration with the trace.

## Validation

`validate-increment.sh --plan` reaches `pure` only:
- the new files have their own exclusive `smoke-map.json` rule, like `client-live-check.ts`;
- the client package and the harness receiver are untouched.

`validate-increment.sh --tier full` ran the pure self-tests. `tsc` over
`experiments/render-stream/tsconfig.json` is clean for the new files.

## Evidence

`artifacts/render-stream/p3/phn/` (main checkout), one directory per leg (`L1`, `L2`, `L3`, `L3b`).
Each holds:
- `client-device.json` (every number above, with the per-second series and cpufreq);
- `cpu-profile.json`;
- `bench-live-scale.json` and `result.json` (the host tap);
- `launcher.out`;
- the host's `scale-report.json`.

`L1/trace.json.gz` is the leg 1 trace. `tools/` holds the three summary scripts that produced the
tables.

## Memory-worthy facts

- On the g31, wasm `memcmp` is a byte loop. A per-frame O(materials × params²) name comparison costs
  35 ms there and nothing measurable natively. Profile the phone; don't extrapolate from desktop.
- The client wasm keeps its name section, so a CDP `Profiler` profile on the phone names every wasm
  function (`render_stream_core::…`). Group samples by the `rs_gsw_wasm::GswRs::*` frame for phase
  attribution.
- `Math.min(...array)` over a phone trace's events overflows the stack: use a loop.
- A capture-scale join is 234 MiB of decoded texture GETs, so the first frame over adb takes
  11–14 s.
- The g31's Chrome auto-updated to 156.0.8078.47 (the table says 154). Provenance still passes.
