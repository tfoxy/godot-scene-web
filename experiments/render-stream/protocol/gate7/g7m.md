### G7m — decode/apply microbench on both phones, g31 first (sonnet; g86 arm operator-attended)

- **Before anything runs** (D28):
  - The g31: no go-ahead is needed. The agent checks that it is attached, authorized and unlocked.
    The harness sets stay-awake and the landscape lock for the session and restores them after.
    If the g31 is absent or locked, its arm is `device-unavailable` and the increment stops and
    reports. It never waits on a device or retries one on its own.
  - The g86: the agent asks the user for the go-ahead and for the phone, attached over USB with
    debugging enabled, unlocked, in landscape and with the screen kept on. Without them, the g86
    arm is recorded as not run, and G7m lands on the g31's result. The g86 arm then runs first
    thing in G7v's attended g86 session, before any g86 acceptance leg.
- **Runs**, on the g31 first and then the g86:
  - the Q13a and Q13b device probes: trace names, panel mode and T_p, the panel-phase drift rate
    (hold p50 over time, on the g31), timer-query exposure, RGB10_A2 renderable and readable,
    whether Chrome reaches the GPU through ANGLE, the "unavailable unrooted" list, CPU frequency
    cap readability, `dumpsys meminfo` readability, the landscape viewport, and adb-reverse RTT,
    jitter and throughput;
  - Q13e's bench on that phone, for both receivers, one warmup plus five repeats per input.
- **Files**: `evidence/device-probes.json` (one block per phone), the bench results as
  `render-stream-report/2` device rows, and README "Gate 7m result": the g31/g86/desktop/native
  table per input and phase, the probe results, and the decision per phone.
- **Checks**: `device-provenance` and the watchdog on every repeat. Then Q13e's decision rule:
  pass, or `device-decode-over-budget` per receiver, input and phone. The finding is a result, and
  it passes the increment.
- **Consequence**: a probe that contradicts Q13a or Q13b is recorded "As built" here, as G7h did
  for Q1b, before G7v relies on it.
- **As built (G7m, 2026-10-15)**, details in the README's "Gate 7m result": the g31's five-repeat
  GSW bench (web stubbed `unavailable`, pending G7e; g86 not attached). `device-decode-over-budget`
  on `scene-full` (p95 12.990 ms, +53 %) and `hd-patch` (p95 16.790 ms, +97 %) against the measured
  0.5·T_p ≈ 8.50–8.51 ms (T_p ~17.0 ms, as G7d found); `scene-patch` and `pace-patch` pass. This
  **triggers G7o** for GSW, ranked: SHA-256 hashing first, decode-minus-hash second, validate's
  jitter on `hd-patch` a secondary watch item. **Contradicts G7d's one-repeat smoke on CPU caps**:
  this run's A55 and A75 both ran uncapped (`derated: false` throughout, all probes and samples),
  where G7d's single repeat saw the A75 capped at 1.354 GHz. The cap is not a fixed device property
  and must be sampled per run, not assumed from one prior probe.
- **As built, web export (G7m, 2026-10-15)**, details in the README's "Gate 7m (web export)
  result": once G7e landed, the web arm needed no new build mode -- G7e's HTTPClient source-fetch
  path already generalizes to a bench input, so `gate7-bench.ts` drives the one `build-web-
  receiver.sh` bundle through one fresh page per warmup/repeat instead of a second, embedded-
  recording export. `device-decode-over-budget` on **all four inputs** (p95 54.528 / 29.440 /
  176.128 / 9.152 ms against the same 8.500 ms budget), 4.0x–10.5x worse than GSW's own g31
  numbers on the same inputs -- a materially worse outcome than GSW, which passed two of four.
  Desktop web-export numbers (now also measured, closing G7d's "stubbed `unavailable`" gap) are
  1.35x–1.74x over native desktop's, confirming the 1.3–2x wasm-overhead estimate. This **triggers
  G7o** for the web export too, with the same tier-1 candidates already ranked below.

