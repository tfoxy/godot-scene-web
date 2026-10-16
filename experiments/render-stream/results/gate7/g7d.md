## Gate 7d result (2026-10-15)

G7d ([protocol/gate7-design.md](../../protocol/gate7-design.md) "G7d", D24 to D28, Q13) passes. It adds
the device harness, the pace fixture and the decode/apply microbench, and it leaves G7m one command
per phone and per receiver. `pnpm render-stream:gate7 -- --legs g7-dev,g7-bench` passed 28/28 group
checks and G7h's 7 harness checks on one desktop run (`artifacts/render-stream/gate7/g7d-r1/`).
`self-test-device-harness.ts` passed 57/57 with no phone.

**New files.**

- `fixtures/gate7-devices.json`: the device table (Q13b). It holds the serial, model, GPU, ANGLE
  rule, panel modes, attendance, session settings, required workloads and CPU clusters per id.
- `scripts/lib/browser-harness.ts` gains the device path: `resolveDeviceSelection`,
  `openHarnessDevice` (perf-harness `openDeviceBrowser` with the table's serial, imported and not
  copied), `checkDeviceProvenance`, `watchdogVerdict`, the D28 session settings (recorded, applied,
  restored), `HarnessRefusal` (`device-unavailable`, `device-provenance`, `device-orientation`), and
  a minimal RFC 6455 server with a `/echo` and a 60 Hz `/tick`. `HarnessServer` gains
  `crossOriginIsolated`: the bench page gets 5-µs `performance.now()`, where Chrome otherwise gives
  100 µs.
- `scripts/lib/device-sampler.ts`: conditions every 30 s, CPU frequency caps (`derated`),
  `dumpsys meminfo` PSS at 0.2 Hz, and gfxinfo GPU memory. `scripts/lib/device-probes.ts`: the
  adb-side Q13a/Q13b probes. The trace-names probe is delegated to perf-harness's
  `--dump-trace-names`.
- `fixtures/gate7-pace/`: one 32×32 four-quadrant texture (a `Sprite2D`) on a 640×360 root. It moves
  1 px per host frame and wraps, with x(f) = (f + 300) mod 609. `expected.json` holds the model and
  the presence and freshness markers of 8 shot frames.
- `web/bench/` (`index.html`, `bench.ts`): the GSW bench page. It replays one record per rAF through
  `render-stream-2.ts`'s new incremental `createRecordingValidator`. Timers wrap only `accept()`:
  decode, hash, resolve, and validate as the remainder. `?mode=probe` runs the page probes.
- `render-stream-2.ts`: `validateRecording` is now a wrapper over `createRecordingValidator`, with
  identical behaviour. Every golden and self-test is unchanged. An optional phase timer was added
  (`setValidatorPhaseTimer`, null by default).
- `scripts/gate7-bench.ts` runs the arms. `scripts/gate7-phone-tool.ts` provides the selection check,
  plans and bench inputs. `lib/gate7-dev-legs.ts` holds Q13d's leg vocabulary,
  `lib/gate7-bench-summary.ts` the summaries and Q13e's decision rule, and `lib/gate7d-checks.ts`
  the checks. `run-gate7.sh` gains `--env`, `--device`, `--receiver`, `--bench-inputs`,
  `--repeats`, `--hold-seconds` and `--plan-only`, and the groups `g7-dev` and `g7-bench`.

**Checks (desktop run r1).**

| Group | Check | Result |
| --- | --- | --- |
| g7-dev | `g7-dev-plan-ctl-only` | 24 legs, all `ctl-`. Without `--env device` no `dev-` arm is selected |
| g7-dev | `pace-capture-success`, `pace-one-transform-patch` | both sinks valid. 400 transactions: one full, then 399 single-item transform patches at x(f) |
| g7-dev | `pace-reference-exact-vs-model` | 8/8 rendered shots 0 px from the synthesized model frames |
| g7-dev | `pace-receiver{,-patch}-*` | `ok`, no unsupported. 8/8 shots 0 px against the model and the reference, on both sinks |
| g7-bench | `bench-matches-g6c` | scene-full native decode mean 6 846 µs against G6c's 6 283 µs (+9 %), apply 965 against 890 µs (+8 %). The limit is ±15 % |
| g7-bench | `*-complete` (native, gsw × 4 inputs) | 5/5 valid repeats each |
| g7-bench | `*-web-unavailable-recorded` | `web-export-not-built` (G7e) |
| g7-bench | `bench-gsw-browser-provenance`, `bench-gsw-timer-isolated` | ANGLE/Vulkan RTX 2060; every page cross-origin isolated |

**Desktop microbench** (Q13e's early signal; Ryzen 5 5500, unloaded; one warmup plus 5 repeats;
ms p50/p95 per transaction). Native is `receiver.gd` file mode headless, where decode is
`accept_record` (decode, validation and resolve) and its percentiles come from rs_perf's
1/16-octave buckets. GSW is headless Chromium 148 under D9, where total = decode + validate +
resolve and hash is part of decode. Inputs: scene-full and scene-patch are the gate6-scene
`animate` 400-frame capture's two sinks (39.3 MB and 2.6 MB), hd-patch is gate6-hd native's patch
sink (122 transactions, 11.5 MB), and pace-patch is the pace capture (400, 0.46 MB).

| Input | native decode | native apply | gsw decode | gsw hash | gsw validate | gsw resolve | gsw total |
| --- | --- | --- | --- | --- | --- | --- | --- |
| scene-full | 6.53 / 9.47 | 0.82 / 1.57 | 1.41 / 2.03 | 0.75 / 1.15 | 0.17 / 0.26 | 0.11 / 0.20 | 1.69 / 2.44 |
| scene-patch | 1.06 / 2.24 | 0.91 / 1.57 | 0.06 / 0.40 | 0.02 / 0.22 | 0.13 / 0.19 | 0.01 / 0.07 | 0.21 / 0.61 |
| hd-patch | 12.54 / 18.94 | 10.50 / 14.59 | 1.09 / 1.81 | 0.73 / 1.24 | 0.67 / 0.85 | 0.16 / 0.27 | 1.89 / 2.89 |
| pace-patch | 0.34 / 0.49 | 0.09 / 0.13 | 0.07 / 0.11 | 0.02 / 0.03 | 0.04 / 0.07 | 0.01 / 0.02 | 0.12 / 0.19 |

Against D27's lines:

- GSW's desktop p95 is under the g31's ~1.7 ms line on scene-patch and pace, and over it on
  scene-full (2.44 ms) and hd-patch (2.89 ms).
- Native decode plus apply p95 is over the 8.3 ms budget on scene-full (11.0) and hd-patch (33.5).
- The web arm is `unavailable` until G7e.

**g31 smoke** (moto g31, Chrome 154.0.8037.127, standing approval). Three runs:

- golden-6 inputs with probes;
- a 30-s probe-only run;
- the G7m command itself with `--repeats 1`.

On each run the harness attached over adb, passed `device-provenance`, ran and closed its tab, and
restored the session settings (stay-awake 2, auto-rotate 0, rotation 0, as found). No forward or
reverse was left behind. Battery was 34 → 43 % on USB, at 23.9–24.0 °C, and thermal status was
`none` throughout. The facts (memory g31-device-probe-facts):

- **The panel vsyncs at about 58.8 Hz, not 60.** The rAF median was 17.02–17.03 ms (p95 17.03).
  SurfaceFlinger's VSyncTracker reports `period = 16.98ms` for its 16.67 ms mode.
  - Against the 60 Hz `/tick` host, the hold steps +0.32 ms per host frame and wraps about every
    0.87 s, so no run keeps one phase.
  - The hold p50 sat at 8.5–9.2 ms in every 5-s window, which is T_p/2.
  - The `dev-rate` floor of 57/s has a margin of about 1.8 frames/s.
- Chrome reaches the GPU through ANGLE: `ANGLE (ARM, Mali-G52 MC2, OpenGL ES 3.2)`.
  - `EXT_disjoint_timer_query_webgl2` is **not exposed**.
  - RGB10_A2 is renderable, and readable as RGBA/`UNSIGNED_INT_2_10_10_10_REV` with the exact value.
- **Viewport and timing.** The landscape viewport is 828×330 CSS px at DPR 2.625; Q13a predicted
  about 914×377. The page UA is Chrome's reduced one. `crossOriginIsolated` holds, with 5-µs timers.
- **adb-reverse transport.** A 100-B WebSocket echo took 3.1 / 4.1 ms (p50 / p95), against the
  1–3 ms prediction. An 813-KB echo took 67–69 ms. Echoed throughput was 38.6 MB/s.
- **Unrooted access.**
  - cpufreq is readable. During the bench the A75 `scaling_max_freq` was capped at 1.354 GHz (of
    2.0) and the A55 at 1.5 GHz, with Thermal Status 0. This is the `derated` case.
  - devfreq is empty, and the GED/Mali GPU-utilization nodes are unreadable.
  - Per-pid `dumpsys meminfo` and gfxinfo GPU memory are readable.
  - CDP `SystemInfo.getProcessInfo` returns the renderer and GPU PIDs, with cpuTime 0.
  - Isolation was `browser-context`.
- **One-repeat GSW numbers on the g31** (not G7m's result: one repeat, so the five-repeat
  `-complete` checks fail by design). These are ms p50/p95 totals, with the phone/desktop ratio on
  the p50:
  - scene-full: 11.80 / 12.96 (7×). Hash alone took 6.52 / 7.22.
  - scene-patch: 3.46 / 8.57.
  - hd-patch: 10.66 / 16.66 (5.6×).
  - pace-patch: 1.89 / 2.34 (16×).
  - Only pace is under 0.5·T_p = 8.5 ms. The ratio is well above D27's estimated 4–5×.

**For G7m**, one command per phone and per receiver (the g86 also needs
`RS_GATE7_OPERATOR_ATTENDED=g86` and the user's go-ahead):

```bash
pnpm render-stream:gate7 -- --legs g7-dev,g7-bench --env device --device g31 --receiver gsw \
  --bench-inputs <desktop run>/g7-bench/inputs/inputs.json
```

### Deviations

- **The web-export arm is stubbed `unavailable`** (`web-export-not-built`).
  `build-web-receiver.sh --bench` and the bench entry scene are not built. They need G7e's export
  preset, shell and `rs_config`/`rs_io` shims, and nothing could export without them (Q13e's apply
  fallback). G7m's web numbers wait for G7e.
- **Native bench percentiles are histogram-derived.** rs_perf keeps no per-transaction samples.
  `total_p95` = p95(decode) + p95(apply), which is an upper bound.
- **G7d touched a phone**, against the contract's "G7d never touches a phone". The user's standing
  approval allowed it, and it was used for the smoke runs above only.
- The g86's fixture dumps are synthesized from its committed perf-harness baseline. Gate 7 has never
  queried it.

### What G7d does not prove

It proves nothing about live rates, cadence, soak or startup: every `dev-`/`ctl-` live leg needs
G7a/G7e, G7n and G7l, plus G7q for window 2 and G7k for soak and startup. It does not provide G7m's
five-repeat phone numbers, or any g86 measurement.

