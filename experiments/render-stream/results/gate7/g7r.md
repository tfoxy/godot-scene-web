## Gate 7r result (2026-10-17)

G7r ([protocol/gate7/g7r.md](../../protocol/gate7/g7r.md); gate7-design.md D4, Q9, Q13c) measures
pacing, rates, the 60/60 clock-phase lock and dual receivers at credit window 1 on all three
receivers: the native Godot receiver and the web export, both on the Rust core, and GSW.

**Native and GSW pass every gating check: 45/45 and 59/59. The web export passes 76/78.** Its two
failures are `rate-achieved` at 15/s and 30/s. Both are the web export's own fetch tail: each
payload GET takes 66 ms, four main-loop iterations. The checker shows that from the leg's evidence
and names it, but the failures stay gating (D1). This held on the merged tree too: `r3`, the
rerun after G7o2's rebase (verify-on-arrival, deferred web digest), landed the same 45/45, 76/78,
59/59 and the same two typed `rate-achieved` failures, same cause.

**The ack-on-receipt sabotage fails exactly as required**: `credit-from-paced-loop` and
`rate-mismatch` on its upper bound.

**No variant holds 60/60 on every clock phase, so D4's negative finding stands for browsers.**
Ten phase runs each:

| Variant | Good runs | Published/s, good runs |
| --- | --- | --- |
| GSW | 10 of 10 | 58.2–59.1 |
| native | 8 of 10 | about 59 |
| native + late poll | 9 of 10 | about 59 |
| web, web + late poll | 9 of 10 each, by the median RTT | about 45 (the fetch tail) |

- GSW was not immune to the bad phase. On the same build, a development run locked bad:
  29.6/s, at a mean RTT of 2.03 frames. The merged-tree run (r3) confirms this is not just a
  development-build artifact: its `dual-native` leg put GSW's own connection A into the same
  bad phase (29.47/s, 2.04-frame mean RTT) in otherwise-ordinary evidence — see "Dual receivers"
  below.
- Late poll changes nothing measurable, which is what Q13c predicted.

The phase table above and its ten-run statistics are from the pre-rebase tree (`r1`/`r2`, base
`5da6d186`); G7o2 (verify-on-arrival, deferred web digest) does not touch pacing, so they stand.
The full `g7-r` run was repeated once more after the rebase (`r3`, base `b631e907`) to confirm the
gating counts and refresh the non-phase rate legs below; a single confirming five-run phase
sample per variant landed the same way (native 5/5 good, native+late-poll 3/5 good + 1 bad + 1
between, web and web+late-poll 0/5 good by mean but 5/5 good by median — the fetch tail again —
and GSW 5/5 good), inside the pattern the ten-run study already established.

```bash
bash experiments/render-stream/scripts/run-gate7.sh --live --legs g7-r --web-core rust \
  --bundle <build-web-receiver.sh --core rust bundle> --gsw-bundle <gsw bundle> \
  --skip-harness-selftest --out artifacts/render-stream/gate7/g7r/r3
# the pre-rebase phase study (r1, then a second five phase runs per variant, r2):
# --receiver native|web|gsw, with
# G7R_LEGS=rate-baseline,phase-60-r1..r5[,phase-60-late-poll-r1..r5]
```

Box: Ryzen 5 5500, RTX 2060, gamescope headless, headless Chromium (`--headless=new`). The
gate 6 scene runs the `rate` timeline, `animate` variant, in realtime with the hook log off. The
window is [6 s, 26 s] of game time, which is 19.0 s between timeline lines. Every timed leg held
the quiet lock exclusive, and no hold was `nested-unisolated`. G7o2's benches shared the machine
through the same lock.

### What was built

- **G6c, unforked, with receiver kinds.** `run-gate7.sh --live --legs g7-r` runs
  `run-gate6.sh --legs g6c` once per kind into `<out>/gate6/rates-<kind>/`. Each kind's legs come
  from `G7R_LEGS_<kind>`:
  - native: rate-baseline, phase-60 ×5, phase-60-late-poll ×5;
  - web: rate-baseline, rate-15/30/60, rate-uncapped-host60, rate-uncapped, mismatch-60-recv30,
    phase-60 ×5, phase-60-late-poll ×5, dual-native, constrained;
  - gsw: web's legs without the late-poll runs, plus sabotage-ack-on-receipt.

  In `lib/gate6c-legs.sh`, a browser replaces each receiver under `GATE7_LIVE_KIND`. Where native
  runs at 60, the browser is rAF-bound (`--max-fps 0`). `dual-native`'s receiver-b stays native
  on /6. The G7r legs run only when named, so a gate 6 run is unchanged. The native receivers run
  on `RS_RECEIVER_CORE=rust` (D34 as amended).
- **`RS_RECEIVER_LATE_POLL=1`** (`receiver.gd`, native and web) reads, polls fetches and applies
  at `frame_pre_draw` instead of `_process`. The `submitted` ack stays at `frame_post_draw`.
- **GSW perf** gains a per-second `timeline`: paced callbacks as `frames`, and `drawn`. It also
  gains `raf_after_submit_us`, the next rAF's timestamp after a submitted ack.
- **`throttle-proxy.ts`** observes HTTP/1.1 exchanges and times each CORS preflight. Under
  `GATE7_LIVE_KIND`, `constrained` uses bearer authorization, because only the `Authorization`
  header triggers a preflight.
- **The browser daemon's `--spare after`** launches the next browser only after a leg ends, so
  no Chromium start-up runs inside a timed window.
- **`lib/gate7r-checks.ts`** (`check-gate7.ts --live --legs g7-r`) runs G6c's own evaluators per
  leg and adds:
  - `phase-classified` and the phase table;
  - `dual-independent` with the connections' versions;
  - Q7's band on browser final shots;
  - per browser leg: provenance, console, hello, `credit-from-paced-loop`, `token-not-logged`
    and `receiver-core`;
  - `late-poll-active`;
  - `preflight-latency`;
  - the sabotage rule;
  - `fetchTailCause`.

  Each kind's numbers are in `g7r-summary.json`. Two small G6c checker changes:
  - `evaluateMismatch60Recv30` reports each bound on its own line;
  - `evaluateDual` takes an absolute hold slack. It defaults to 0, so G6c is unchanged.
- **`test/self-test-gate7r.ts`** passes 24/24.

### The phase study (published/s per run, credit window 1)

Each run has the rate-60 configuration (`GRC_PUBLISH_FPS=60`, host `--max-fps 60`). The table
reports:

- the class, from the window's mean credit RTT in host frames (Q9: good at 1.1 or less, bad at
  1.9 or more), and the class of the whole-run median beside it;
- the hold (`received_us` to `submitted_us`), p50/p95 in ms. Native and web start it at the
  socket read, so it is phase-free work. GSW starts it at `onmessage`, so it is Q13c's hold:
  arrival to the drawing rAF, plus work. GSW's phase-free part (rAF timestamp to ack) is listed
  after it.

Every run passes G6c's bound (`rate-achieved`, decided).

| Variant | r1 set (runs 1–5) | r2 set (runs 1–5) | Good / bad / between (mean) | By median |
| --- | --- | --- | --- | --- |
| native | 56.3, **38.4**, 59.0, 59.1, 59.1 | 56.8, **44.9**, 59.1, 58.9, 59.0 | 8 / 0 / 2 | 9 / 1 / 0 |
| native + late poll | 59.0, 58.9, 59.1, 59.0, 59.1 | **52.9**, 58.6, 59.1, 58.4, 59.1 | 9 / 0 / 1 | 10 / 0 / 0 |
| web | **21.8**, 44.6, 44.7, 45.2, 45.1 | **39.2**, 45.0, 45.1, 44.9, 43.4 | 0 / 1 / 9 | 9 / 1 / 0 |
| web + late poll | 45.2, **26.5**, 45.2, 43.7, 45.0 | 45.0, 44.9, 44.4, 42.8, 44.6 | 0 / 1 / 9 | 9 / 1 / 0 |
| gsw | 58.4, 58.8, 58.2, 59.0, 58.6 | 59.1, 59.0, 59.1, 59.0, 59.0 | 10 / 0 / 0 | 10 / 0 / 0 |

Per-run detail (mean RTT in frames; hold p50/p95 in ms):

- **native**:
  - r1 set: 1.07 / **1.56** / 1.02 / 1.02 / 1.02. Holds 3.1/16.2, 1.9/18.6, 1.9/18.1, 2.0/18.1,
    2.0/18.1.
  - r2 set: 1.06 / **1.34** / 1.02 / 1.02 / 1.02. Holds 1.8–2.5 / 18.0–18.4.
- **native + late poll**:
  - r1 set: 1.02 ×5. Holds 1.8–2.4 / 17.8–18.0.
  - r2 set: **1.14**, then 1.02 ×4. Holds 1.9–2.4 / 17.7–18.0.
- **web**:
  - r1 set: **2.76** (bad), then 1.34–1.35. Medians 2, 1, 1, 1, 1.
  - r2 set: **1.54**, then 1.34–1.38. Every median 1.
  - Holds 1.9–2.5 / 68.6–69.2 everywhere. The p95 is the GET.
- **web + late poll**:
  - r1 set: 1.34, **2.27** (bad, median 2), 1.34, 1.38, 1.34.
  - r2 set: 1.34–1.41, every median 1.
  - Holds 1.8–2.5 / 68.4–69.1.
- **gsw**:
  - r1 set: 1.02–1.03. Holds 10.2/26.7, 5.7/22.0, 12.9/29.1, 10.3/26.9, 2.1/18.6. Phase-free
    0.7–1.1 / 1.2–2.8.
  - r2 set: 1.02 ×5. Holds 8.2/24.8, 13.3/29.9, 12.5/29.1, 6.8/23.3, 8.9/25.3. Phase-free
    0.6–0.8 / 0.8–1.4.

Findings:

1. **GSW's hold p50 is the run's clock phase φ, as Q13c models it.** It stays put for the whole
   run and differs between runs: 2.1, 5.7, 6.8, 8.2, 8.9, 10.2, 10.3, 12.5, 12.9 and 13.3 ms. The
   work is under 1 ms. So a run is good while φ plus transport plus host slack stays within a
   frame, which is about 14.5 ms here. All ten r runs fell inside that.
   - The development run (`dev-gsw1`, same bundle and capture) locked bad: 29.63/s at a mean RTT
     of 2.03 frames (median 2).
   - Its dual-native receiver-a drifted, at 47.4/s and 1.27 frames.

   On this desktop, GSW's good fraction is about (16.7 − ~2) / 16.7. That is higher than Q13c's
   g31 estimate, because loopback adds about 0.1 ms where USB adds 1–3 ms.
2. **Native on the Rust core is now mostly good.** Its hold p50 is about 2 ms, against 5.9–6.4 ms
   on G6c's GDScript core. G6c measured 5 of 11 runs bad. G7r measured 0 bad and 2 `between` of
   10, and 1 between of 10 with late poll. The `between` runs (38.4, 44.9 and 52.9/s) drift
   across the boundary: native's two loops are a gamescope frame clock and the host's own timer,
   and they do not hold one phase for 20 s.
3. **Late poll changes nothing measurable, on either Godot receiver.** Natively,
   `frame_pre_draw` comes right after `_process` in one main-loop iteration. Hold p50 is 1.8–2.4
   ms with late poll and 1.8–3.1 ms without. 9 of 10 runs were good against 8 of 10, which is
   within chance: at a good fraction near 0.85, five good runs in a row happen about 44 % of the
   time. On the web it is the same: 9/10 against 9/10 by median, and the same holds. Q13c
   predicted this: late poll shrinks the work, not the hold.
4. **The web export's good phase is about 45/s, not 59/s.** Each payload GET in the web export
   takes 66.1–66.2 ms (p50; p95 66.8). That is four main-loop iterations, against 16.6 ms (one
   iteration) for native and 1.5–1.7 ms for GSW's `fetch`. About 100 of the leg's roughly 1 150
   transactions fetch, and each holds its credit for about 4 frames. That adds about 0.34 frames
   to every run's mean RTT. The median, 1 frame, still shows the phase. The p95 holds of
   68.4–69.2 ms in every web run are these GETs. This is the "web export's g5f tail" that G7l
   left unattributed.
   - Every web run passes G6c's bound, because its credit capacity is set by the same mean.
   - Q9's mean-RTT class calls the web's good-phase runs `between`.

   The cause is Godot's web `HTTPClient`. Every state change is a JavaScript promise that resolves
   between rAF callbacks, so one GET needs about four iterations however fast the link is. GSW
   proves the browser itself is not slow. The fix is a JavaScript-side fetcher for the web export,
   which is G7p's (fetch) or G7v's call. G7r only measures it. *(G7wf, 2026-10-18, built it:
   the browser's `fetch` through `JavaScriptBridge`, 2.8 ms per GET; the web's `g7-r` is 79/79,
   [g7wf.md](g7wf.md).)*

### Rates per receiver (r3, the merged-tree headline run)

Rates per second on the host clock. `presented` is unavailable on every leg (D13). A slash
separates dual-native's receiver-a (browser, /7) from receiver-b (native, /6). r1's numbers (pre-
rebase, pre-G7o2 core) are kept in git history; r3 reruns the same legs on the merged tree
(G7o2's verify-on-arrival / deferred web digest) and the pattern is unchanged, leg by leg, within
ordinary run-to-run phase noise.

**web export (rust core)**:

| Leg | Requested | Host frame | Published | Applied | Submitted | Receiver frame | Credit capacity | RTT mean (frames) | RTT p50 / p95 (ms) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| rate-15 | 15 | 60.0 | **13.90** | 13.95 | 13.95 | 60.0 | 27.28 | 2.20 | 15.1 / 84.4 |
| rate-30 | 30 | 60.0 | **25.21** | 25.16 | 25.21 | 60.0 | 33.65 | 1.78 | 16.5 / 83.4 |
| rate-60 | 60 | 60.0 | 24.53 | 24.53 | 24.53 | 60.0 | 24.36 | 2.46 | 18.8 / 85.9 |
| rate-uncapped-host60 | uncapped | 60.0 | 44.26 | 44.26 | 44.26 | 60.0 | 43.96 | 1.37 | 3.4 / 69.9 |
| rate-uncapped | uncapped, `--max-fps 0` | 22 683 | 45.11 | 45.11 | 45.11 | 60.0 | 44.85 | 505.7 | 16.6 / 83.2 |
| mismatch-60-recv30 | 60 | 60.0 | 6.84 | 6.84 | 6.84 | 30.0 | 6.81 | 8.81 | 50.9 / 333.1 |
| dual-native | uncapped | 60.0 | 44.53 / 59.06 | 44.53 / 59.06 | 44.53 / 59.06 | 60.0 / 60.0 | 44.53 / 59.06 | 1.35 / 1.02 | 4.6 / 71.2, 12.5 / 27.2 |
| constrained | 60 | 60.0 | 3.79 | 3.79 | 3.79 | 60.0 | 3.80 | 15.81 | 145.7 / 490.4 |

**GSW**:

| Leg | Requested | Host frame | Published | Applied | Submitted | Receiver frame | Credit capacity | RTT mean (frames) | RTT p50 / p95 (ms) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| rate-15 | 15 | 60.0 | 15.00 | 15.00 | 15.00 | 60.0 | 42.75 | 1.40 | 1.5 / 34.6 |
| rate-30 | 30 | 60.0 | 30.00 | 30.00 | 30.00 | 60.0 | 58.07 | 1.03 | 10.3 / 27.0 |
| rate-60 | 60 | 60.0 | 59.00 | 59.00 | 59.00 | 60.0 | 59.00 | 1.02 | 7.0 / 23.7 |
| rate-uncapped-host60 | uncapped | 60.0 | 59.06 | 59.06 | 59.06 | 60.0 | 59.06 | 1.02 | 4.4 / 21.1 |
| rate-uncapped | uncapped, `--max-fps 0` | 24 366 | 59.05 | 59.05 | 59.05 | 60.0 | 59.06 | 412.6 | 16.6 / 33.2 |
| mismatch-60-recv30 | 60 | 60.0 | 29.05 | 29.05 | 29.05 | 30.0 | 29.00 | 2.07 | 28.7 / 62.1 |
| dual-native | uncapped | 60.0 | 29.47 / 58.90 | 29.47 / 58.90 | 29.47 / 58.90 | 60.0 / 60.0 | 29.47 / 58.90 | 2.04 / 1.02 | 16.9 / 33.7, 4.4 / 19.9 |
| constrained | 60 | 60.0 | 3.68 | 3.68 | 3.68 | 60.0 | 3.66 | 16.40 | 235.6 / 419.4 |
| sabotage-ack-on-receipt | 60 | 60.0 | 60.00 | **30.00** | 60.00 | 30.0 | 60.00 | 1.00 | 0.7 / 0.9 |

GSW's browser-only metrics, over every leg at 60:

- `raf_after_submit` (the next rAF timestamp after a submitted ack): p50 15.8–16.3 ms, p95
  16.2–16.4 ms. That is one frame, never `presented`.
- `gpu_complete` (the fence, polled on later frames): p50 16.2–16.4 ms. It is frame-quantized,
  because it can only be observed at the next poll. At 30 fps it is 33.0 ms.

Notes on these tables:

- **`limited_by`**: `credit` for both browsers at `--max-fps 0`, as Q9 predicts (rAF-bound).
  The host ran at 22 700–24 400 fps, and its credit RTT was about one rAF (16.6 ms for both
  browsers this run).
- **Missed targets.** The web's rate-15 and rate-30 miss their targets. GSW's rate-30 this run
  sits almost exactly on target (30.00/s, 1.03-frame RTT); r1 (pre-rebase) caught it mid-phase at
  29.47/s, 2.04 frames — both inside G6c's bound, the phase lock moving the number, not the
  verdict.
- **Mismatch.** At 30 fps GSW publishes 29.05/s, 0.97 of its frame rate, like G6c's native
  receiver (0.89). The web publishes 6.84/s, 0.23 of its frame rate: at 30 fps, a 4-iteration
  GET is 133 ms. Its median credit RTT is 50.9 ms, though most of its transactions fetch
  nothing, so the web export at `--max-fps 30` (wm.cpp's `target_ticks` skip) also reads its
  socket late. That is measured, not attributed.
- **GSW was not immune to the bad phase here either.** Unlike r1 (where only the `dev-gsw1`
  development run, not the headline evidence, hit it), r3's `dual-native` drew receiver-a into
  the bad phase: 29.47/s at a 2.04-frame mean RTT (hold p50 16.3 ms, against B's 2.5 ms), while
  B (native, /6) stayed good at 58.90/s. `dual-independent` still passed: A's phase-free hold
  (p50 0.6 ms, p95 0.8 ms) stayed within the 1 ms slack of a lone connection's, and B was
  unaffected — the phases are independent, as D7 requires, whichever way each one lands.

**Native rate-baseline**: host 60.0 frames/s, frame-interval p95 17 360 µs, the reference for
`host-unperturbed`.

### Dual receivers, constrained transport, the sabotage

(r3 numbers; r1's pre-rebase numbers were the same shape, see git history.)

- **`dual-native`** passes on both browsers. In each, A is the browser on /7 and B is the native
  receiver on /6, and the host's summary shows versions [7, 6]. One snapshot copy is made per host
  frame. A's phase-free hold is within 10 % or 1 ms of rate-uncapped-host60's:
  - web (hold is already phase-free) p95 68.7 against 68.6 ms;
  - GSW (`phase_free_hold`) p95 0.8 against 0.6 ms.

  A plain 10 % rule failed GSW in development (1.1 against 0.9 ms, 22 %). That is two quanta of
  the browser's 100 µs clock, so G7r adds the 1 ms slack. B is unaffected: 59.06 and 58.90/s,
  hold p95 18.1 and 18.3 ms, the same as a lone native receiver (17.7–18.0 in this run's phase
  table). This time it is A, not B, that is affected: GSW's own connection A landed in the bad
  phase (29.47/s, 2.04-frame mean RTT, hold p50 16.3 ms) while B stayed good — `dual-independent`
  passed regardless, because it judges A's phase-free part, not its raw hold.
- **`constrained`** (4 Mbit/s, 30 ms each way, bearer token) passes G6c's four criteria on both
  browsers: credit RTT p50 145.7 ms (web) and 235.6 ms (GSW), one transaction in flight, the
  queue bounded, the host unperturbed. Preflight latency, OPTIONS to its 204 as delivered:
  - web: 62 preflights, p50 60.0 ms, p95 61 ms, max 61 ms;
  - GSW: 100 preflights, p50 60.0 ms, p95 61 ms, max 61 ms.

  Each preflight costs one link round trip before its GET (60.0 ms p50), so on this link a new
  payload costs at least 120 ms before its bytes arrive; the rest of the credit RTT above is
  queueing and the GSW/web stacks' own overhead. The token appears in no file of either run
  (`token-not-logged`).
- **`sabotage-ack-on-receipt`** (GSW at 30 fps acks `submitted` from `onmessage`; host
  `GRC_PUBLISH_FPS=60`; payloads inline) fails exactly the two checks required:
  - `credit-from-paced-loop`, on every acked seq;
  - `rate-mismatch`, on its upper bound: published 60.00/s > 1.05 × 30.00, and no tick was
    credit-blocked.

  `leg-class`, `host-unperturbed` and `final-latest-state` pass. The host cannot see the
  sabotage: `max_in_flight` is 1, no send goes without credit, and the credit RTT is well under
  1 ms (p50 0.7 ms). The receiver applied 30/s, superseding every other transaction. Over HTTP,
  the first attempt failed `resource-unavailable` (a 404) instead: credit on receipt let the
  host retire D7's pins before the fetch. That is G6c's ignore-credit finding again, and it is
  why the leg runs inline.

### Pixels

`final-latest-state` passes on every leg. Native shots are exact (0 px). Every browser final shot
is within Q7's band against the native reference, with 0 pixels outside it:

| Receiver | Identical | `readback` | `delta1` |
| --- | --- | --- | --- |
| web | 220 537 | 9 706 | 157 |
| GSW | 220 715 | 9 519 | 166 |

Out of 230 400 pixels, the same on every leg. Unchanged on r3 (the merged tree): every leg's
final shot, on both the pre-rebase and the merged-tree run, lands on these exact counts — the
scene and the codecs did not move, only the timing did.

### Re-runs (scoped)

| What changed | Re-run | Result | Evidence |
| --- | --- | --- | --- |
| everything, pre-rebase | pure self-tests: every `self-test-*.ts` except the browser harness's (launches Chromium) and the two that need bench inputs, plus `self-test-quiet.sh` and golden-2…7 `make_golden.py --check` | 43/43 pass | `pure/` |
| everything, pre-rebase | `g7-r` on native, web (rust) and GSW | 45/45, 76/78 (the fetch tail), 59/59 gating | `r1/`, `r2-phase-*/` |
| everything, merged tree (G7o2: verify-on-arrival, deferred web digest) | `g7-r` on native, web (rust) and GSW | same: 45/45, 76/78 (the fetch tail, same per-fetch latency and hold counts), 59/59 gating | `r3/` |
| everything, merged tree | pure self-tests, same 43-item set | 43/43 pass | `pure2/` |
| `receiver.gd` shell (late poll), `gate6c-legs.sh`, `throttle-proxy.ts`, `gate6c-checks.ts`, merged tree | native gates 1, 2 and 6 (`--legs g6l,g6c`) under `RS_RECEIVER_CORE=rust` | gate 1 66/66, gate 2 85/85, gate 6 63/63 (plus the five `group-*` lines for groups not asked for) | `native2/` |
| `receiver.gd` (web), GSW `live.ts`/`perf.ts`, `gate7-live.ts`, `gate7-live-legs.ts`, `check-gate7.ts`, merged tree | `g7-1`, `g7-2`, `g7-5`, `g7-55`, `g7-6 --live` on web (rust) and GSW | web: g7-1 39/39, g7-2 36/36, g7-5 20/20, g7-55 20/20, g7-6 26/26; GSW: 38/38, 35/35, 19/19, 19/19, 25/25 — all gating, `gate_passed: true` | `live-regress3/` |

**External load during the live scoped rerun.** Another repo's campaign (`open-slix-reference`, up
to 6 `dosbox-x` processes at ~99 % CPU each, outside this experiment's quiet lock) ran in bursts
through the evening and pushed 1-minute load average from the usual ~1 to 15–20+ on this 6C/12T
box. `r3` and `native2` (gates 1, 2, 6) finished at 17:19–18:21, well before any of it, so they
stand. A first attempt (`live-regress2`, not kept — see below) was contaminated from
`gate2/live-web`'s `sabotage-no-token` onward and was abandoned before `g7-5`/`g7-55`/`g7-6` ran.
`live-regress3` reran the full scope after the `dosbox-x` process count read 0 and 1-minute load
read <6; the campaign resumed twice more during the rerun (confirmed via `ps` process-start times:
one burst ~20:01–20:17 local, one ~22:01–beyond completion), but cross-checking every timing leg's
own exclusive quiet-lock window (`gate1`'s `g1d`, `gate2`'s `g2c-pins`, `gate5`'s `g5f`, `gate55`'s
`g55f`, `gate6`'s `g6l`, each kind) against those bursts' process-start timestamps shows every one
of `live-regress3`'s exclusive holds landed inside the quiet gaps between bursts (the last, GSW
`g6l`, finished at 22:26:54, 25 s before the next burst's first `dosbox-x` child appeared at
22:27:19). None of `live-regress3`'s timing legs ran under the external load.

Out of scope, and why:

- **The GDScript cores**, native and web, under D34 as amended. Late poll lives in the shell
  above both cores. The default path changes only by one `if not _late_poll` guard.
- **Native gates 0, 3, 4, 5 and 5.5.** Their receiver legs are file legs or use no live shell
  that changed. Gate 5's g5f and gate 5.5's g55f run live, but `gate5f`/`gate55f`'s code is
  untouched, and the shell they use is the one gates 1, 2 and 6 re-ran.
- **The g7-0…g7-6 file legs.** The file path is unchanged: `perf.ts`'s timeline only adds keys,
  and late poll is live only.
- **Capture and `rs_ws`**: not touched.
- **`rs-core` and the crates**: not touched.
- **The phones**: G7v's.

### What G7r does not prove

- **Window 2**: G7q, fork F1. Every hello asked for 1, and every host granted 1.
- **60/60 on every phase.** No variant was shown to hold it. GSW's 10/10 good runs are a sample
  of a phase distribution with a bad region, which `dev-gsw1` hit.
- **The phones' rates (G7v)**, and a real display's presentation (D13: unavailable).
- **The web export's 30 fps socket latency** (`mismatch-60-recv30`'s 50.9 ms median RTT, most
  transactions not fetching) is measured but not attributed.

### Evidence (ignored; `artifacts/render-stream/gate7/g7r/`)

Pre-rebase (base `5da6d186`, before G7o2):

- `r1/`: the full run. `result.json` is the checker's report, and `gate6/rates-<kind>/` holds
  each kind's run and its `g7r-summary.json`.
- `r2-phase-{native,web,gsw}/`: the second phase set. Each `g7r-run` and `token-not-logged`
  check fails there only because the set ran the phase legs alone.
- `dev-native1/`, `dev-web1/`, `dev-gsw1/`, `dev-gsw2/`: development runs. `dev-gsw1` has GSW's
  bad phase and the HTTP-sabotage 404. `dev-gsw2` has the inline sabotage.
- `pure/`: the self-test logs. `native/`: gates 1, 2 and 6. `live-regress/`: the live re-runs.
- `gsw-bundle-1/`: the pre-rebase GSW bundle built for `r1`/`r2-phase-*`/`dev-*`.

Merged tree (base `b631e907`, G7o2's verify-on-arrival and deferred web digest included):

- `r3/`: the headline `g7-r` run. Same layout as `r1/`.
- `pure2/`: the self-test logs, same 43-item set as `pure/`.
- `native2/`: gates 1, 2 and 6 under `RS_RECEIVER_CORE=rust`.
- `live-regress3/`: `g7-1,g7-2,g7-5,g7-55,g7-6 --live` on web (rust) and GSW, clean of the external
  load (see above); a first attempt, `live-regress2`, was contaminated partway and discarded.
- `gsw-bundle-2/`: the merged-tree GSW bundle built for `r3`/`pure2`/`live-regress3`.
