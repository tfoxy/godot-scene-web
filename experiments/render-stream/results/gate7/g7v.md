## Gate 7v result (2026-10-21)

G7v ([protocol/gate7/g7v.md](../../protocol/gate7/g7v.md), gate7-design.md Q13, D24 to D28) runs
Q13d's phone legs on the moto g31 for both browser receivers, at credit windows 1 and 2, with
their desktop control arms. It judges every decided check on all five repeats and states the
acceptance per receiver and window. **The g86 is descoped by the user (2026-10-22): the g31 is the
only phone G7v measures**, and its `hd` stretch miss (GSW's hd-patch bench p95 ≈ 9.99 ms against
8.51, G7o4; the live hd legs below) is accepted as measured by the same decision.

**Acceptance on the g31 (D25, Q13d; one build: GSW bundle `f4548380`, web bundle
`6d70a83d5d065b56`, both on the Rust core, base `c9026a06`).** Neither browser receiver meets the
phone target, at either window. F3 (a) is therefore not satisfied by G7v's numbers.

| Receiver | Window 1 | Window 2 (opt-in, F1) | `hd` stretch |
| --- | --- | --- | --- |
| gsw | not met: `dev-rate`, `dev-cadence` on pace and scene (every repeat 35–49/s, the phase drifts through the window) | not met: scene `dev-rate` (drawn 54.4/s against 58.2 published) and `dev-cadence`; pace passes `dev-rate` (58.1 drawn, 5 of 5), `dev-main-thread` (p95 4.8 ms) and `dev-gpu`, and misses `dev-cadence` on one repeat of five (r5: one 68-ms interval and 6 intervals above 34 ms, where 5.8 are allowed); `dev-gpu-headroom` fails with it on pace and with `dev-rate` on scene | fails `dev-rate` (4.4 / 8.5 drawn), `dev-main-thread` (p95 30 ms), `dev-gpu` (`gpu_complete` p95 56–66 ms) at both windows; accepted as measured (user, 2026-10-22) |
| web | not met: pace 27.8/s and scene 8.7/s, `dev-main-thread` p95 17 / 36 ms per iteration, warm startup median 4.9 s | not met: pace 55.9 drawn (57.6 published), scene 15.8; `dev-main-thread` p95 14.6 / 36.8 ms | 0.2–0.3 frames/s; Godot's iteration p95 63–85 ms |

What passes on the g31: `device-provenance` (every repeat: moto g31, Mali-G52 MC2 through ANGLE,
Chrome 154.0.8037.127, landscape, thermal `none`, battery 100 % on USB), `dev-presence` and
`dev-presentation-typed` on pace and scene, GSW's `dev-gpu` (`gpu_complete` p95 17–19 ms against
34) and its warm startup (median 569 ms, max 654 ms, against 3 s), and `credit-from-paced-loop` on
every honest leg.

**Window 2 recommendation: make it the default.** On the g31 it raises every receiver's drawn rate,
and never lowers one beyond noise (drawn new frames per second, mean of five repeats, window 1 →
window 2): gsw pace 47.0 → 58.1, scene 35.9 → 54.4, hd 4.4 → 8.5; web pace 27.8 → 55.9, scene
8.7 → 15.8, hd 0.30 → 0.20. Window 1 cannot meet 57 on this phone at all: its panel vsyncs at
58.8 Hz (T_p 17.00 ms on every repeat), so the 60 Hz host's arrivals drift across every rAF phase
within each 20-s window, and every gsw repeat is a `between` run (credit RTT 1.28–1.67 host
frames), as Q13c predicted. G7q measured window 2 at ≥ 0.95 × 60 on 15 of 15 desktop phase runs.
G7v does not flip the default (fork F1 stays the user's call); the user flipped it on 2026-10-22 ([g7wd.md](g7wd.md)).

**`phase-alias` occurred** (Q13c's named risk) on every gsw window-2 repeat: 31–42 drawing
callbacks per 20-s window applied two seqs on pace, 71–85 on scene, which is what keeps drawn below
published. Part of it is the panel itself: at 58.8 Hz a receiver can draw at most ~58.8 new frames
per second from a 60/s host, so the 57 floor has a 1.8/s margin, and the alias costs 1.8/s (pace)
to 3.8/s (scene). Candidates (named, not built): Q13c's one-tick present queue (draw queued seqs one
per tick, dropping the oldest past one), or pacing the host to the receiver's measured panel rate
(gate 8's negotiation).

**Live against the bench (G7o4).** The g31 bench put GSW's hd-patch step transaction at p95
9.99 ms against 8.51. Live, the whole drawing callback is what matters: GSW's own timers give
`total_us` p95 24–49 ms on hd and 4.6–5.9 ms on scene, and the probe's main-thread work per drawn
frame is p95 22–30 ms (hd) and 7.8–8.0 ms (scene, under the 8.5-ms half tick). hd is GPU-bound as
well (`gpu_complete` p95 47–66 ms). The web export's live iteration
(scene p95 36 ms, pace 14.6–17 ms) is far above its bench decode and apply (G7o3: scene-full 7.5 ms),
so on this phone it is Godot's own frame, not the shared core, that misses. Deadline misses are
tabulated below as new-frame intervals above 34 ms per 20-s window.


### What G7v adds

- `run-gate7.sh --live --legs g7-dev [--env device --device g31]`: G6c's group, unforked
  (`lib/gate6c-legs.sh` "G7v"), one `run-gate6.sh --legs g6c` per receiver kind and window with
  `G6C_LEGS` naming `dev-<base>-r<N>` legs (r0 the warmup) into
  `<out>/gate6/<ctl|dev-<id>>-<kind>-w<w>/`. Bases: `pace`, `scene`, `hd`,
  `gpu-headroom-<workload>` (gsw, window 2), `maxfps60-scene` (web, window 1),
  `startup-cold`, `startup-warm` (window 1), `soak-scene` (`G7V_SOAK_WINDOW`), and the sabotages
  `sabotage-ack-on-receipt-scene`, `sabotage-draw-repeat-8-<workload>` and
  `sabotage-soak-leak-gl-textures-scene` (named by `G7V_LEGS`).
- The device daemon (`lib/gate7-device-legs.ts`, G7u's) now runs plain legs too: the dev probe,
  the phone's samplers (`light`: conditions and CPU caps every 30 s; `soak`: plus PSS every 5 s,
  gfxinfo GPU memory and the CDP JS heap), `device.json` before/after conditions, and a kept tab
  for warm startup.
- `lib/browser-probes/dev-probe.js`, injected before any page script on desktop and device: every
  rAF callback and WebSocket `message` handler timed, hidden time, JS and wasm heaps, and on a
  phone Godot's `keep` CSS fit (Q13a).
- `lib/gate7v-checks.ts` (check-gate7.ts `--live --legs g7-dev`): Q13d's checks per leg, the
  acceptance statement and the report/2 device rows in `<out>/g7v-summary.json`.
- GSW: `RS_RECEIVER_DRAW_REPEAT` (each drawing callback draws N times), and
  `RS_RECEIVER_RECEIVED_MAX_BYTES`, the native receiver's G7k tap cap, which GSW had silently
  ignored. Without it a phone could not hold an hd or soak leg's tap: GSW's evidence write failed
  with `NotReadableError` reading a ~30 MB blob on the g31, and the soak's tap alone would have
  grown the renderer by ~250 MB.
- gate6-scene and gate6-hd: `RS_FIXTURE_TIME_OFFSET_S` (rate and soak timelines start later;
  default 0, every existing run unchanged). gate7-pace logs its final position in realtime mode.

### The g31 tables

Every row is five repeats (r1 to r5, after the r0 warmup), each a 20-s window from the connection
+ 6 s, the host at `GRC_PUBLISH_FPS=60`, `--max-fps 60`, realtime, hook log off; receivers at
`--max-fps 0`. Panel: one mode, 60.00 Hz by `dumpsys`; T_p measured 17.00 ms (58.8 Hz) on every
gsw repeat. Rates are the mean (minimum) per second; NFI is the new-frame interval p95 / max over
the five repeats (ms); ">34" and "multi" list each repeat's intervals above 34 ms and its
multi-apply callbacks; main thread is the probe's work per drawn frame, p95 / p99 (worst repeat,
ms); "own" is GSW's `total_us` p95; `gpu_complete` p95; RTT the mean credit round trip in host
frames; phase the window-1 class per repeat (`~` between, `B` bad, Q9's thresholds).
The gsw window-2 rows are the repeated whole run (`g7v-g31-gsw-w2/`); the first one, cut short at
`gpu-headroom-scene-r3`, measured the same (pace drawn 58.2, scene 53.5).

| Receiver | Window | Leg | Published /s | Drawn /s | T_p ms | NFI p95 / max | >34 | multi | Main p95 / p99 | Own p95 | `gpu_complete` p95 | RTT | Phase | Failing checks |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| web | 1 | hd | 0.28 (0.26) | 0.30 (0.28) | 61.26 | 4718.9 / 4718.9 | 5,5,4,6,5 | 0,0,0,0,0 | 84.6 / 113.6 | - | - | 214.90 | BBBBB | dev-rate, dev-cadence, dev-main-thread, dev-presence |
| web | 1 | maxfps60-scene | 9.31 (8.84) | 9.24 (8.77) | 17.10 | 235.6 / 323.0 | 182,184,198,182,174 | 0,0,0,0,0 | 35.9 / 39.1 | - | - | 6.47 | BBBBB | dev-rate, dev-cadence, dev-main-thread |
| web | 1 | pace | 27.78 (27.35) | 27.81 (27.36) | 17.00 | 51.3 / 91.1 | 318,313,311,321,311 | 0,0,0,0,0 | 17.3 / 18.6 | - | - | 2.16 | BBBBB | dev-rate, dev-cadence, dev-main-thread |
| web | 1 | scene | 8.75 (8.53) | 8.74 (8.61) | 20.48 | 238.3 / 356.3 | 173,174,174,175,171 | 0,0,0,0,0 | 36.0 / 39.1 | - | - | 6.87 | BBBBB | dev-rate, dev-cadence, dev-main-thread |
| web | 2 | hd | 0.35 (0.32) | 0.20 (0.17) | 68.00 | 6501.8 / 6501.8 | 5,2,2,3,2 | 5,3,3,4,3 | 70.9 / 105.2 | - | - | 319.73 | - | dev-rate, dev-cadence, dev-main-thread, dev-presence |
| web | 2 | pace | 57.57 (56.79) | 55.94 (55.19) | 17.00 | 26.8 / 75.2 | 18,27,19,17,13 | 30,33,31,32,30 | 14.6 / 18.1 | - | - | 1.99 | - | dev-rate, dev-cadence, dev-main-thread |
| web | 2 | scene | 19.00 (16.90) | 15.80 (13.95) | 23.82 | 202.8 / 334.1 | 204,232,223,239,237 | 61,52,60,64,66 | 36.8 / 41.5 | - | - | 6.23 | - | dev-rate, dev-cadence, dev-main-thread |
| gsw | 1 | hd | 4.44 (3.74) | 4.41 (3.71) | 17.00 | 459.4 / 493.5 | 87,89,92,76,72 | 0,0,0,0,0 | 30.1 / 38.1 | 49.3 | 65.5 | 13.75 | BBBBB | dev-rate, dev-cadence, dev-main-thread, dev-gpu |
| gsw | 1 | pace | 46.98 (45.42) | 47.02 (45.60) | 17.00 | 34.1 / 289.3 | 86,100,75,70,84 | 0,0,0,0,0 | 4.5 / 6.0 | 2.0 | 18.1 | 1.28 | ~~~~~ | dev-rate, dev-cadence, dev-unthrottled |
| gsw | 1 | scene | 36.02 (34.79) | 35.85 (34.72) | 17.00 | 50.9 / 919.6 | 123,154,189,193,188 | 0,0,0,0,0 | 7.8 / 9.2 | 5.9 | 19.3 | 1.67 | ~~~~~ | dev-rate, dev-cadence, dev-unthrottled |
| gsw | 2 | gpu-headroom-hd | 12.62 (11.47) | 7.45 (6.80) | 17.00 | 406.3 / 561.5 | 109,119,120,119,116 | 100,102,110,105,96 | 25.1 / 29.2 | 26.3 | 48.8 | 9.20 | - | dev-rate, dev-cadence, dev-main-thread, dev-gpu, dev-gpu-headroom |
| gsw | 2 | gpu-headroom-pace | 59.90 (59.84) | 57.99 (57.67) | 17.00 | 17.2 / 51.0 | 1,16,5,7,4 | 32,43,41,39,37 | 4.8 / 6.6 | 2.0 | 17.5 | 1.43 | - | dev-cadence, dev-gpu-headroom |
| gsw | 2 | gpu-headroom-scene | 57.94 (57.75) | 54.18 (53.81) | 17.00 | 34.0 / 102.0 | 37,41,30,36,36 | 79,78,77,69,73 | 8.0 / 10.0 | 5.0 | 16.6 | 1.61 | - | dev-rate, dev-cadence, dev-gpu-headroom |
| gsw | 2 | hd | 13.83 (13.32) | 8.54 (8.14) | 17.00 | 374.3 / 442.4 | 122,126,126,133,116 | 112,106,108,116,109 | 22.5 / 29.6 | 24.1 | 46.5 | 8.33 | - | dev-rate, dev-cadence, dev-main-thread, dev-gpu |
| gsw | 2 | pace | 59.94 (59.79) | 58.12 (57.87) | 17.00 | 17.1 / 68.0 | 4,5,3,3,6 | 33,42,31,35,39 | 4.8 / 6.3 | 2.0 | 17.5 | 1.42 | - | dev-cadence |
| gsw | 2 | scene | 58.19 (57.69) | 54.35 (53.61) | 17.00 | 34.0 / 102.1 | 42,33,33,26,27 | 85,71,73,80,81 | 7.9 / 9.8 | 4.6 | 17.2 | 1.56 | - | dev-rate, dev-cadence |

New-frame interval shapes against Q13c's (one tick on the g31): at window 2 gsw pace is unimodal at
17.0 ms (p50 17.0, p95 17.1); scene's p50 is 17.0 but its p95 is 34.0, the alias's skipped tick.
At window 1 every gsw run alternates one- and two-tick intervals in drifting stretches (p50 17 or
34, p95 34.1), and the web export's are two to five ticks.

**Startup** (navigation → first `submitted`, five repeats, ms): gsw warm 563 / 561 / 611 / 569 / 654
(median 569, passes), cold 1116–1221; web warm 4506 / 4847 / 7605 / 7333 / 4884 (median 4884,
fails 3 s and 5 s), cold 8275–9027. The web export's warm load re-navigates the same tab (same
browser context); its compiled wasm is cached, so the 4.9 s is engine start-up and the first
GLES3 shader compiles on the Mali-G52, as Q13d predicted (2–5 s).

**Watchdog.** gsw window 1 pace r4 (a 289-ms rAF gap) and scene r1 (903 ms) are `invalid` under
Q13b's watchdog (`dev-unthrottled` fails). They were not re-run: every window-1 repeat fails
`dev-rate` well apart from them. No repeat had hidden time; thermal status was `none` before and
after every leg; the battery stayed at 100 % on USB at 24–27 °C; the A75 `scaling_max_freq` cap
read below `cpuinfo_max_freq` on some 30-s samples (`derated`, report-only, as G7d found).

**Presentation.** Both receivers' hellos carry `dpr_milli` 2625 and the check is typed `ok` on
every repeat (backing equals `presentation_size`), not Q13a's predicted `presentation-mismatch`:
the check compares the backing store only. The hello's CSS size is taken before the harness fit
(gsw 640×360, web 243×137, the web shell's 1:1 device pixels); the probe then fits the canvas to
586×330 CSS px (hd: 586×330 of a 1920×1080 backing) in the 828×330 landscape viewport.

**Soak** (gsw, window 2, `soak-scene`: 60-s warmup then 600 s, `g7v-g31-gsw-w2b/`). Thermal
status `none` on all 26 30-s samples (the A75 cap read `derated` on some, report-only); gfxinfo GPU
memory 9.5 → 7.6 MiB (passes); drawn 53.4/s over the first 60 s and 53.2/s over the last (fails
57, the same window-2 alias as `scene`, and steady); main-thread p95 6.2 → 6.9 ms (fails the 1.1×
drift clause by 0.1 ms); renderer PSS +35.3 MiB at 3.9 MiB/min, peak 504 MiB (fails 16 MiB and
2 MiB/min; under 512 MiB), browser process −42 MiB, JS heap +23.5 MiB at 2.1 MiB/min (fails 4 MiB).
The memory growth is not separable from the receiver's own evidence: the page keeps every
transaction's record and every drawn frame's sample until the end (`applied.json` 73 MB and
`perf-timeline.jsonl` 19 MB for this leg). A soak needs those records bounded (as
`RS_RECEIVER_RECEIVED_MAX_BYTES` bounds the tap) before its memory clauses measure the receiver.
The web soak was dropped for scope (user, 2026-10-22): web fails the target at both windows on rate and main thread already, and G7k's desktop soak covers its memory.

**Sabotages** (g31):

| Sabotage | Leg | Result |
| --- | --- | --- |
| gsw `ack-on-receipt` | `dev-scene-w1` | fails `credit-from-paced-loop` (every submitted ack from `onmessage`), but **not exactly**: with credit returned on receipt the 60/s host floods the phone, and the receiver also fails `dev-rate`, `dev-cadence`, `dev-main-thread` and `dev-gpu` (`gpu_complete` p95 134 ms). Desktop G7r's version ran the receiver at 30 with inline payloads |
| gsw `RS_RECEIVER_DRAW_REPEAT=8` | `dev-scene-w2` (`g7v-g31-gsw-w2b/`) | fails `dev-gpu-headroom` and `dev-rate` (drawn 53.1/s), but not discriminatingly: honest `scene` already fails both at window 2, and eight draws of the 640×360 scene left `gpu_complete` at 26.6 ms and the main thread at 8.1 ms |
| gsw `RS_RECEIVER_DRAW_REPEAT=8` | `dev-pace-w2` (`g7v-g31-sab-w2/`) | **does not fail** (`sabotage-fails` fails): drawn 58.2/s, `gpu_complete` p95 17.4 ms. Eight clears and blits of a 640×360 RGB10_A2 target are within the Mali-G52's budget, so on the g31 neither phone workload shows the headroom leg failing for GPU reasons; only `hd` (which fails anyway) is GPU-bound. A discriminating version needs a heavier repeat or a GPU-meaningful passing workload |
| gsw `leak-gl-textures` soak | `soak-scene-w2` | not run: dropped for scope (user, 2026-10-22). The honest g31 soak already fails its memory clauses on evidence growth, so it could not have failed "exactly the GPU-memory clause"; G7k's desktop leg is the sabotage's evidence |

**Phone / desktop ratios** (desktop control arms `g7v-ctl/`: headless Chromium under D9 on the
Ryzen 5 5500, r1 after an r0 warmup, report-only; window 2 unless noted):

| Stage (p95 per drawn frame) | gsw pace | gsw scene | web pace | web scene |
| --- | --- | --- | --- | --- |
| main thread, g31 / desktop (ms) | 4.8 / 0.6 (8×) | 7.9 / 1.0 (8×) | 14.6 / 2.9 (5×) | 36.8 / 3.6 (10×) |
| GSW `total_us`, g31 / desktop (ms) | 2.0 / 0.3 (7×) | 4.6 / 0.6 (8×) | — | — |
| `gpu_complete`, g31 / desktop (ms) | 17.5 / 16.6 | 17.2 / 16.5 | — | — |
| drawn /s, g31 / desktop | 58.1 / 59.9 | 54.4 / 58.0 | 55.9 / 59.9 | 15.8 / 58.1 |

The desktop holds 58–60 drawn per second at window 2 on both receivers with T_p 16.70 ms, and at
window 1 its phase stays `good` (credit RTT 1.00–1.07 frames). The g31 is 5–10× slower per frame on
the main thread, above D27's 4–5× core estimate, as G7m's bench found.


### Runs

All under `artifacts/render-stream/gate7/` of the G7v worktree (ignored evidence):

- `g7v-g31-web/`: web, windows 1 and 2 (pace, scene, hd; window 1 also maxfps60-scene,
  startup-cold, startup-warm), 54 legs.
- `g7v-g31-gsw/`: gsw window 1 (pace, scene, hd, startup-cold, startup-warm), 30 legs, judged by
  hand after the run was cut (`check-gate7.ts --live --legs g7-dev --receiver gsw`); its
  `cut-short-dev-g31-gsw-w2/` is the window-2 run the agent cut at `gpu-headroom-scene-r3` by
  stopping the wrong process group.
- `g7v-g31-gsw-w2/`: gsw window 2 repeated whole (pace, scene, hd, `gpu-headroom-*`), 36 legs.
- `g7v-g31-gsw-w2b/`: the gsw soak (window 2) and the scene draw-repeat sabotage;
  `g7v-g31-sab-w1/` the ack-on-receipt sabotage; `g7v-g31-sab-w2/` the pace draw-repeat sabotage.
- `g7v-ctl/`: the desktop control arms (pace and scene, both windows, both receivers, r0 + r1).
- Host load: the milestone sweep `sweep-pre-g7v` ran throughout (load average 2–25); every timing
  leg held the quiet lock exclusive for its own 43–45 s, so lock waits stretched the session
  (46 s per leg uncontended, 70–90 s contended), never a leg's window.

### Validation

Rebased onto main `0230907c`; `tsc --noEmit -p experiments/render-stream` shows only main's five
`gate2b-checks.ts` errors; `self-test-gate7v.ts` 30/30. The full tier (`validate-increment.sh
--tier full`, 11 runs) was dispatched through `scripts/remote-validate.sh --and-local`. The remote
half (`pure`, `cargo-gsw-rs`) failed on infrastructure: the repository's Actions policy refuses
`jdx/mise-action` (rs-setup), and `validate-summary.py --merge` then crashed on a `None` wall time;
both ran locally instead: `pure` passed (971 s), `cargo-gsw-rs` failed as it does on main (wasm32-only
crate under native `cargo test`). Local runs under a heavily shared quiet lock (other agents' timing
legs): `g7-gsw` passed (rc 0, 329 PASS, 5981 s) and `g7-web-rust` passed (rc 0, 1579 s).
`g7live-gsw` then passed (rc 0, 4458 s). The orchestrator ran the remaining six on base `d6ffe1a8`
(`artifacts/render-stream/gate7/g7v-full-rest/`): `native-rust-gate6`, `g7live-gsw-timing`,
`g7live-web-rust-timing` (g7-6, g7-lc, g7-r, g7-k; typed `unavailable` 4 and 3, the desktop
real-suspension rows), `g7live-native-timing` and `g7x` all passed. `g7live-web-rust` failed once
(g7-2 live-warm: 252-512 px diffs from step 4, shots missed at steps 7-9, resource traffic on
transform-only step 10) and passed on an immediate rerun (`g7v-rerun-web-live/`), so it is recorded
as a flake. Every full-tier run therefore passes except `cargo-gsw-rs`, the known pre-existing failure.

### Acceptance decision (user, 2026-10-22)

GSW at credit window 2 is accepted as gate 7's phone receiver under F3(a), met with a measured
shortfall (scene 54.4/s drawn against 58.2 published; pace 58.1/s with one `dev-cadence` repeat
missed of five). The web export is recorded not-met with the numbers above. The hd stretch miss is
accepted as measured, the g86 is descoped, and credit window 2 becomes the default (fork F1) in a
separate increment.

### Deviations

- **The measured window is anchored at the connection**, and scene and hd shift their `rate`
  timeline 12 s later (`RS_FIXTURE_TIME_OFFSET_S`), because the web export takes ~8.5 s (cold) to
  connect on the g31. Q13d's "20 s after 6 s" is kept, relative to the stream's start.
- **The receivers' perf timelines are unchanged.** The new-frame interval, `multi_apply_ticks` and
  main-thread accounting are computed from evidence both receivers already wrote plus the page probe,
  so `receiver/` (every native gate's reach) did not change. The web export's main-thread number is
  its rAF callback (one Godot iteration), not trace `tdur` split by rs_perf's timers.
- **No trace**: `contentUpdateHz`, activation gaps and `CrRendererMain` busy are `unavailable`;
  the probe's page-script busy share (rAF callbacks plus message handlers) is judged against 50 %
  in their place. GPU time per drawn frame is `unavailable` on both receivers.
- **Watchdog-invalid repeats are reported, not re-run** (two gsw window-1 repeats; see above).
- **`dev-gpu-headroom` runs at window 2 only**, the window predicted to meet the target.
- **Control arms**: one warmup plus one repeat, pace and scene only, no control soak or startup
  (G7k's desktop soak and startup are the controls); they are report-only by Q13d.
- **`dev-presence` on a device** allows 1 % of pixels beyond Q7's band against the desktop
  reference (it measured 0 beyond the band on every scene repeat); pace checks its square within
  2 px of the host's last x.
- **report/2**: the device rows are `g7v-summary.json`'s `device_rows` in Q12's stage names; the
  report itself is G7p's.

### Out of scope

- **The g86: descoped by the user, 2026-10-22.** Its arms exist on the same path (`--device g86`)
  and are not run; no g31/g86 ratio or 3:2 cadence is measured, and nothing is pending for it.
- **g31 optimization**: none (user decision, 2026-10-22). The `hd` stretch miss is accepted.
- The `gsw-ts` bench arm is not dropped here (29 references across `gate7-bench.ts`,
  `lib/gate7x-bench.ts` and `run-gate7.sh`, plus g7x's timing validation): a follow-up.
