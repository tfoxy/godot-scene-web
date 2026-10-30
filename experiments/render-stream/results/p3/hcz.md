# HCz: STS2 acceptance of the host-cost chain (2026-10-30)

HCz of `protocol/host-cost-design.md` (Increments table): the capture's main-thread cost in real
STS2, after HC1–HC6, against the design's targets of combat ≤ 3 ms and map and menu ≤ 1 ms per
frame. The capture was built from main `adf97029`, so it includes HC5 and HC6. No code changed.

**Every target is met, on both hosts.**

| scene | GPU host, arm at init (`hcz-c3-2`) | headless product seat (`hcz-mir3-*`) | MX baseline (`mx.md`) | target |
| ----- | ---------------------------------: | -----------------------------------: | --------------------: | -----: |
| menu ¹ | **0.40** (hooks 0.14, callback 0.26) | **0.70** (hooks 0.26, callback 0.44); 1v−0v 0.65 | 2.7–3.7 | ≤ 1 |
| map | **0.32** (hooks 0.07, callback 0.25) | **0.23** (hooks 0.07, callback 0.17); 1v−0v ≈ 0.39 ² | 6.2–6.4 | ≤ 1 |
| combat, idle | **1.52** (hooks 0.47, callback 1.05) | **1.56** (hooks 0.57, callback 0.99); 1v−0v 0.70 + hooks 0.45 = 1.15 | 9.0 / 8.9 | ≤ 3 |

The figures are main-thread ms per frame at 60 fps, with one GSW viewer at /12, window 2, and W11t
coding on (zstd-base). The capture's share is taken from `perf record -g -F 499` over 8 s, through
`perf-capture-split.py`. "1v−0v" is the seat's `/proc` main-thread ticks with one viewer minus the
same seat with no viewer.

1. The GPU host's menu is C3's main menu. The seat's "menu" is the co-op lobby's character select,
   where it waits for the run to start.
2. The map comes from two launches. A random lobby seed gave each launch a different map, and the
   seat's quiet main thread (16–40 ms/s) makes that a small error.

- **Like for like with MX.** The capture's own frame-callback histogram (`evidence/perf.json`,
  every armed frame of the leg) has a mean of **1.00 ms**, p50 0.86 and p95 2.43. MX measured
  7.0 / 7.4 ms mean and 9.7 / 10.2 ms p95. In combat the whole capture fell from 9.0 ms to
  1.5 ms (−83 %).
- **Fidelity is unchanged.** Paired live shots against the game's own frame, one per scene: map
  **65.54 dB** (W11c/PM7: 65.5); combat **60.39 dB** (max delta 2, nothing over 16; PM7:
  60.83–60.88); menu **38.92 dB** (brief: 40.2–41.0). All of the menu's difference is the fog and
  sparkle particles, which GSW simulates client-side, so their phase varies from shot to shot
  (`artifacts/…/hcz-c3-2/menu-diff.png`). One shot sits 1.3 dB under a range that came from three.
- **Wire** (`ss` bytes_sent on the listener port, both connections):

  | scene | GPU host | MX (/11) | seat |
  | ----- | -------: | -------: | ---: |
  | menu | 0.425 Mbps | 0.43 | 3.76 (lobby) |
  | map | 0.148 Mbps | 0.155 | 0.126 |
  | combat | 6.09 Mbps | 5.9 | 8.45 (HSD: 8.4) |

  HC changes no wire byte (each increment's byte-identity proof). The ±3–5 % against MX is /12
  against /11 (particles) and a different scene instance, not HC.
- **Viewer:** 55.8–57 applies/s against 59.4–60 host fps. GSW total per transaction is 1.2 ms
  (menu), 2.2 ms (map) and 2.2 ms (combat). `coalesced` was 1,107 of 16,363 transactions.

## Why `/proc` on−off cannot measure this on the GPU host

MX's method is main-thread ticks with the capture on, minus off. On the GPU host it now gives
**negative** numbers. In `hcz-c3-1` (late arm, off windows before the arm and after the disarm),
on−off was −1.7 ms (menu), −0.35 ms (map) and −0.49 ms (combat).

The reason is in the profile (`perf-attribute.py`, `attr-*.json`). The NVIDIA Vulkan driver
spends 3–5 ms of every frame on the main thread, spin-waiting under `libnvidia-*` with a
`[vdso]` `clock_gettime` leaf. The capture's work displaces that spin. In combat the driver took
3.36 ms/frame with the capture on and 4.71 with it off: −1.35 ms, which matches the capture's
+1.33. On−off is therefore near zero whenever the capture fits inside the vsync slack.

MX's 9 ms did not fit, so its on−off was real. At 1–1.5 ms the spin absorbs it.

Off-window noise adds to this. The game's per-second main-thread ms vary between 60 and 520 on
the map, and the off windows were other scene instances: the first minute after start, and
fixtures re-entered after the disarm. So on the GPU host the capture's cost is its own samples.
On the headless seat there is no driver and the main thread is quiet (16–140 ms/s), so `/proc`
works there, and it agrees with perf.

## Where the remaining time goes (combat, both hosts)

| share | GPU host | seat |
| ----- | -------: | ---: |
| snapshot: item walk and copies | 0.28 | 0.22 |
| snapshot: textures, meshes, shaders | 0.23 | 0.23 |
| budget and serving (pin/retire/union) | 0.27 | 0.26 |
| hub (connections, restamp) | 0.11 | 0.07 |
| cv digests, release, other callback | 0.15 | 0.21 |
| hooks (vertex/attribute regions 0.18–0.20, `canvas_item_clear` 0.06–0.08, mirror updates 0.09–0.10, the rest ≤ 0.05 each) | 0.47 | 0.57 |
| **capture** | **1.52** | **1.56** |

The seat's hooks at 0 viewers are 0.45 ms (combat) and 0.16 ms (lobby): hooks cost the same with
or without a viewer, as D6 expects. The frame callback at 0 viewers is 0.03–0.05 ms (HC1).

No target is missed, so HCz names no follow-up. If one is wanted, the largest share left is the
per-frame snapshot (≈ 0.5 ms in combat) plus serving (≈ 0.26 ms). Both still scale with the
spine and particle churn of an idle combat, not with item count.

## Method

- **The GPU host (C3 harness).** One owned STS2 from a private farm (the MIR-3 mod build), GPU
  rendered under `gamescope --backend headless`. It ran the product seat's GRC table: /12, inline
  4096, `GRC_MESH_DYNAMIC=auto`, the /12 formats, `GRC_HOOK_LOG=off`, `GRC_LIVE_MAX_CONNECTIONS=2`,
  `GRC_LIVE_CODING=zstd-base`. Live only: no file sink, and an empty `GRC_RESOURCE_STORE_DIR` (the
  product sets none). One GSW viewer (`gate7-tool.ts browser-receiver --kind gsw`, bundle
  `rs_core_build sha=adf97029fb80`) ran at /12, window 2. The calibration was
  `…m12.uit.json`. Each scene was held 72 s.
  - Measure window [12, 42) s: `/proc` ticks at 1 Hz and `ss`.
  - perf window [43, 52) s.
  - Then a probe shot, and a reference shot scheduled on the viewer's next 600-frame shot window
    (`c3_shot.gd` `@F` against `RS_RECEIVER_SHOT_WINDOWS`), so the timed windows hold no shot.
  - `hcz-c3-1` (`late12`): route `menu, arm, menu, map, combat, waitdisarm, map, combat`, so that
    on and off sat in one process. The late arm withholds pre-arm items (fidelity gap 5: no menu
    background and no hand cards; menu 12.5 dB and combat 17.7 dB). Its cost figures (menu 0.36,
    map 0.16, combat 1.35) are therefore a lower bound, and it served the on−off analysis above.
  - `hcz-c3-2` (`a12`, armed at mod init as the product is): route `menu, map, combat`, all on.
    This leg gives the headline numbers and the fidelity.
- **The product seat (MIR-3 harness).** A real co-op host spawns one `--headless` streaming seat
  with `StreamingSeatLaunch.Environment` (/12) and this worktree's capture. The couch-coop mirror
  runs in headless pinned Chromium with renderer = stream. Driving:
  - `act ready` on the host and on the seat (`MIR3_TARGET=seat`);
  - then `act mouse click --x 907 --y 768` in `--mode dangerous` on both, to vote the first map
    node (the start node sits there on every seed seen).
  - The seat runs at 60 fps.
  - The 0-viewer state comes from the stage's own hidden-tab path: `driver.mjs` `hide` fakes
    `visibilityState`, and the stage disposes its client after 60 s.
  - Two launches were needed. In `hcz-mir3-1` the reconnect after `show` closed 17 ms after the
    101, and the stage went `failed` (blank page). So that launch only gave 0-viewer windows
    (lobby, map, combat). `hcz-mir3-2` ran on in all three scenes, then hid once, for combat's
    same-process 1v−0v.
- **Load.** Each leg waited for a 1-minute load below 4 and held GSW's quiet lock exclusive.
  The C3 legs ran at load 1.4–2.9 and 5.2–6.7 (the second bursts came from other repositories,
  which the lock cannot see); the seat legs ran at 0.9–2.9 and 1.6–4.3.

## Product note (couch-coop, not GSW)

In `hcz-mir3-1` the mirror's stage did not recover from a hidden-tab dispose. On `show` it
opened a fresh socket (101), which closed after 17 ms; the phase went `failed` and the page went
blank. Visibility was faked, and rAF kept running, so this may not reproduce on a real hidden
tab. It was seen once and not chased here.

## Validation

None was needed: the diff is this doc and a note in the design doc. The harness lives in
couch-coop's ignored research directory.

## Evidence

`artifacts/render-stream/p3/hcz/` (ignored):

- **`hcz-c3-1/`, `hcz-c3-2/`:** `analysis.json` (`mx-analyze.py`), `persec.json`, `split-*`,
  `attr-*` (driver spin), capture `perf.json`, `live-summary.json`, `counters.json`,
  `gsw-perf.json`, `compare-rx-gsw.json` (paired dB), `wire.txt`, steps, notes and hash compares,
  and the late-arm sheet and menu diff.
- **`hcz-mir3-1/`, `hcz-mir3-2/`:** marks, `persec`, `split-*`, `wire.txt`, the driver log, the
  viewer's windows, seat profile lines, evidence `live.json` and `result.json`, and hash
  compares.
- **`harness/`:** copies of the scripts and the exact leg commands: `hcz-driver.py`,
  `hcz-hook.sh`, `run-leg.sh` (new route step `waitdisarm`), `hcz-sampler.py`, `hcz-window.sh`,
  `driver.mjs` (`hide`/`show`), `common.sh` (`MIR3_ROOT_DIR`), `hcz-leg-cmd*.sh`,
  `hcz-mir3-cmd.sh`, and the reducers.

The perf data is kept only as summaries. On all five launches, every hash was unchanged (Steam
remote store, operator profile, install binaries and mods, mod build), every leg ended
`survivors: none`, and `pgrep -c SlayTheSpire2` was 0 at the end.
