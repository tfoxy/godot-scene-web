# PHG: the g31's GPU frame cost, the backing lever, and the two draw-list levers (2026-10-31)

PHG measures the moto g31's GPU cost on a real STS2 streaming seat and judges the two client levers the
plan names — **static background** (draw a tagged background subtree once and cache it) and **backstop
occlusion** (skip items fully under an opaque item) — plus the **canvas-backing-at-display-size** lever
and the **TAG3 module on-cost**. It re-points PHV's phone harness (`…/phv/harness/`, which was tied to
the removed `phv` worktree) at the current builds: couch main `acb09e86` (TAG3 `raisedHand`/`viewScale`
+ INP2) and GSW main `ce77b4de` (W13r, TAG2, INP1, PRES-C, FRZ-D), built in dedicated `phg` worktrees.

One leg (`phg-1`) ran a real co-op host + its headless streaming seat (`gamescope --backend headless`,
`--force-steam off`, private farm + XDG, `GRC_HOOK_LOG=off`, `pc-lobby-host` fixture) with the g31 as the
viewer, real time, each timed window under GSW's quiet lock exclusive, machine load < 4. The scene is
the **character-select lobby** (the streaming seat is wide: PRES-A presents at the phone's 2.34:1 aspect,
so the canvas backing is **2520×1080**, not PHV's 1920×1080). Combat was not reached this leg — see
"Deviations".

**Verdict.**

- **The g31's GPU cost is GL draw submission, not compositing and not fragments.**
  - An 8 s Chrome GPU-process trace in the lobby puts `CrGpuMain` at **0.53 core** (4271 ms CPU) and the
    compositor `VizCompositorThread` at only **0.09 core** (739 ms). The GPU process's time is dominated
    by `WebGL` command processing: **233 flushes, 7047 ms** (0.88 core over the window), plus
    `CommandBuffer::Flush` 7044 ms, against `Display::DrawAndSwap` 311 ms and
    `SkiaOutputSurfaceImplOnGpu::FinishPaintRenderPass` 513 ms.
  - The renderer's main thread is **0.57 core (43 % idle)**, matching PHV's "40 % idle" — the phone is not
    main-thread-bound.
- **The backing-at-display-size lever does not pay.** A back-to-back A/B in the settled lobby
  (2024×866 = 1.75 Mpx vs 2520×1080 = 2.72 Mpx, a 36 % pixel cut) moved the phone from 53.3 to
  **55.2 rAF/s (+3.5 %)**; frame interval p50 17.1 → 17.0 ms. The settled lobby already runs near the
  phone's ~58.8 Hz panel rate, so fewer pixels buy almost nothing.
- **Both levers must therefore attack the draw list, which is the real cost.** The GL probe (on for
  ~15 s spanning the 10 s `lobby-gl` window) counts **~8.3 k `drawElements`/s and ~8.5 k
  `bindTexture`/s** — ~260 and ~270 per frame at the lobby's 31.6 rAF/s, with only ~27
  `useProgram`/frame — and the seat's capture holds **3989 items / 1562 textures / 553 materials**, so
  the client's executor already culls ~90 % of items (3989 → ~260 drawn). Static-background caching and
  backstop occlusion both save *draw-list entries*, not pixels — the right target — but their per-scene
  ms needs the item-level walk (deferred; the phone re-join broke after scene fixture reloads, see
  "Deviations"). The backing lever is the one this measurement rules **out**.

**Renderer PSS** stayed 579–612 MiB in the lobby (PHV: 584 MiB lobby; the risk is combat's 840–1040 MiB,
not reached here). Seat-side `perf-timeline.jsonl` ends at mirror_items 3989, host_retained 1062 items /
846 MB, seat RSS 1.85 GB, credit RTT mean 22.3 ms.

## Per window (phone, real time)

| window | span | rAF/s | frame p50 / p95 (ms) | applies/s | `onmessage` p50 (ms) | rAF busy p50 (ms) | renderer PSS (MiB) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| lobby-base | 60 s | 31.0 | 34.0 / 54.4 | 42.7 | 9.4 | 2.0 | 587 → 579 |
| lobby-gl (GL probe on) | 10 s | 31.6 | 33.1 / 55.0 | 41.9 | 8.5 | 7.1 | 582 → 587 |
| lobby-backing-small (2024×866) | 30 s | **55.2** | **17.0** / 33.3 | 54.7 | 8.1 | 2.5 | 598 |
| lobby-backing-full (2520×1080) | 30 s | **53.3** | **17.1** / 34.6 | 52.9 | 8.3 | 2.5 | 593 → 583 |

`lobby-base` is the early window (the stage was still settling: 31 rAF/s, frame p50 34 ms); the backing
A/B windows are the settled lobby and are the clean comparison. cpufreq was sampled per window and was
**not** fixed at the A75's 2.0 GHz (one A75 sample at 1.0 GHz, A55 0.77–1.5 GHz), thermal status 0,
battery 100 % on USB throughout — the same non-fixed cap G7m recorded, so every rate above is a
per-run fact, not a device constant.

## GPU attribution (lobby, 8 s CDP trace, `phg-trace-sum.mjs`)

Per-thread (maximal events), over the 8.0 s window:

| process / thread | wall ms | CPU ms | core ratio |
| --- | ---: | ---: | ---: |
| Renderer / CrRendererMain | 4696 | 4592 | 0.572 |
| **GPU Process / CrGpuMain** | 7460 | **4272** | **0.532** |
| Renderer / Compositor | 1201 | 1126 | 0.140 |
| GPU Process / CompositorGpuThread | 1206 | 932 | 0.116 |
| **GPU Process / VizCompositorThread** | 789 | **740** | **0.092** |

GPU-process event names (by total ms): `WebGL` 233 × 7047 ms, `GPUTask` 233 × 7078 ms,
`CommandBuffer::Flush` 697 × 7044 ms, `FinishPaintRenderPass` 192 × 514 ms, `DrawAndSwap` 193 × 311 ms,
`OnCreateSharedImage` 15 × 276 ms. The GL probe's own window (`lobby-gl`) confirms the same shape from the
main thread: `drawElements` 316.8 ms + `bindTexture` 295.1 ms of 1222.9 ms total GL time (probe-inclusive),
with `texSubImage2D` only 25.6 ms — uploads are ~1/frame, so the cost is draw + bind overhead, not texture
upload.

## TAG3 on-cost

Deferred. The clean A/B (page reload with `raiseHand`/`uiScale` off vs on, pure hello vs both modules)
needs the phone page to re-load with those flags; the re-navigation (and a fresh `open` with the query)
left the phone without its join form (`watch=0`, no picker) after the earlier scene fixture reloads. The
driver and a page-side `phgMeasure` extension module were built for it (below); the leg that runs it is
the follow-up. The harness now supports `open … <query>` and a `measure` command, so the re-run is
mechanical.

## Harness (re-pointed, kept in couch's ignored research dir)

`.sts2/research/render-stream-p3-20261025/phg/harness/` is PHV's harness re-pointed: `common.sh` →
`MIR3_WT`/`PHV_GSW_WT` = the `phg` worktrees, `MIR3_GSW` = the GSW `phg` worktree, private root
`/tmp/claude-1000/phg/scratchpad/phg-root`. The capture (`.so` + MIR-3's calibration) and the client core
(`rs_core_tree=54566470a1e2`, `sha=ce77b4de3907`) and the mod (couch `acb09e86`, dirty with the two
measurement-only files below) were built by `prepare.sh`. `phv-driver.mjs` gained: a GL probe
(`gl <name> on|off|read`, PHN's `probe.ts` logic), `resize`, `trace` (CDP `Tracing.*`, GPU categories),
`measure`/`nav`/`open … <query>`, and `phg-trace-sum.mjs` (per-thread CPU over a trace gz). Two
throwaway couch files — `frontend/src/stream-ext/phgMeasure.ts` and the `phgMeasure` gate in
`extensions.ts` — are the item-tree walk module, **not landed** (they live only in the couch `phg`
worktree; GSW is unchanged).

## Deviations

- **Combat not reached.** Starting a co-op run works (`act ready` on host + seat → embark → map), but the
  map travel to a combat node is a vote (`map.view.isAcceptingVotes`), and `select-map-node` answers
  `wrong_player` from both the host and the seat bridge; `dev fixture load <combat>` resets the run and
  kills the streaming seat. Driving the vote needs image feedback this session could not read. Combat's
  numbers stay PHV's (38 applies/s, renderer PSS 840–1040 MiB, full-screen fog/particles/background).
- **Static-background and backstop ms not item-attributed.** The `phgMeasure` walk needs the page loaded
  with `?phgMeasure`; the phone re-join broke after the scene fixture reloads (see TAG3 above), so the
  walk never ran against a live scene. The lever direction is measured (draw-submission-bound → draw-list
  levers); the per-lever ms is the follow-up, not estimated here.
- **Backing baseline.** The lever was specified as "1541×866 vs 1920×1080", but PRES-A presents at the
  viewer's aspect, so the backing is 2520×1080 and the display-size backing is 2024×866 (the stage's CSS
  box × DPR 2.625). The A/B is those two, a 36 % pixel cut.

## Evidence

`artifacts/render-stream/p3/phg/` (main checkout, ignored): `phg-1/` (`marks.jsonl`, `probe-Phone.jsonl`,
`trace-lobby.json.gz` + its `phg-trace-sum.mjs` output, `gl-Phone-*.json`, `windows.txt`, `seats.jsonl`,
`steps.txt`, the seat's `evidence-*` and `samples.txt`), `harness/` (the re-pointed scripts), and the
hash compares (steam-remote, operator-profile, install binaries/mods, mod build — all unchanged). The leg
ended `survivors: none`; no SlayTheSpire2/crashpad/gamescope process remains and the adb reverses and
forwards were removed.

## Memory-worthy facts

- **The g31's GPU cost is draw/bind overhead, not pixels.** The backing cut (36 % fewer pixels) bought
  +3.5 % frames/s; `CrGpuMain` is 0.53 core and the compositor 0.09 core. Rate the client levers by draw
  calls saved, not by fragments.
- **The executor already culls ~90 %** (3989 capture items → ~260 `drawElements`/frame), so backstop
  occlusion's upside is bounded by the remaining ~260 draw calls, of which only the truly-occluded ones
  count.
- **`dev fixture load` kills the streaming seat** (it resets the run); reach combat by the run's own
  embark + map vote, not by a fixture load. The map vote is `map.view.isAcceptingVotes`, and
  `select-map-node` is `wrong_player` from both bridges — the vote needs a raw click at the node.
- **Re-navigating an already-joined phone page (or opening with a URL query) loses the join form**
  (`watch=0`, no picker); use a fresh `open` at the base URL, then drive settings by localStorage before
  the renderer toggle, not by URL flags.
