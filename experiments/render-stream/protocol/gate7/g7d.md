### G7d — device harness, pace fixture, decode/apply bench (opus; unattended)

- **Files**:
  - `scripts/lib/browser-harness.ts` gains `env: "device"` and `--device <g31|g86>`. It imports
    `packages/perf-harness/src/device.ts`, copies nothing from it, and passes the device table's
    serial to `selectDevice` (D24, Q13b).
  - `experiments/render-stream/fixtures/gate7-devices.json`, the device table (Q13b), with the
    g31's facts from Q13a and the g86's.
  - `scripts/lib/device-sampler.ts`: `sampleConditions` every 30 s, the CPU frequency caps where
    readable, `dumpsys meminfo` PSS, and gfxinfo GPU memory.
  - The `device-provenance` check, the `device-unavailable` refusal and the watchdog (Q13b).
  - The g31's session settings (stay-awake and landscape lock), recorded and restored (D28).
  - `run-gate7.sh --env device --device <g31|g86>`. Device arms never run without both flags.
  - `fixtures/gate7-pace/`, with its native capture and reference legs and `expected.json`
    (presence markers).
  - `experiments/render-stream/web/bench/`: the GSW bench page and the web-export bench entry
    scene.
  - `build-web-receiver.sh --bench`.
  - The device probes of Q13a and Q13b, implemented and dry-run against a fake `Adb`.
  - `scripts/test/self-test-device-harness.ts`.
- **Checks** (all unattended):
  - `bench-matches-g6c` natively;
  - the bench's desktop arms on D9's harness for both receivers, with their numbers quoted in
    "As built", which is Q13e's early signal;
  - `device-provenance` and the watchdog against recorded `dumpsys` / CDP fixtures for both
    phones, through the fake `Adb` (the g31's from the 2026-10-15 queries);
  - with two fake phones attached, `--device g31` selects the g31's serial and no `--device`
    refuses;
  - the pace fixture's native receiver legs pass;
  - `--legs g7-dev` without `--env device` runs only `ctl-` arms.
- **Sabotage**: a fake device reporting another model (the g86's model under `--device g31`, and
  the reverse), or a SwiftShader renderer, must make `device-provenance` refuse. A fake `adb
  devices` without the selected serial must give `device-unavailable`. A fake trace with 300 ms of
  hidden time must make the watchdog mark the repeat `invalid`.
- G7d never touches a phone. It leaves G7m a single command per phone to run.
- **As built (G7d, 2026-10-15)**, details in the README's "Gate 7d result":
  - The groups are `g7-dev` (Q13d's plan, plus the pace fixture's native legs) and `g7-bench`
    (Q13e). Bench legs are named `native-bench-<input>`, `ctl-bench-<input>-<gsw|web>` and
    `dev-bench-<input>-<gsw|web>-<id>`. The inputs are `scene-full`, `scene-patch` (the gate 6
    `animate` capture's two sinks), `hd-patch` and `pace-patch`. G7m's command is
    `--legs g7-dev,g7-bench --env device --device g31 --receiver gsw --bench-inputs <inputs.json>`.
    The g86 additionally needs `RS_GATE7_OPERATOR_ATTENDED=g86`.
  - GSW's per-transaction validate comes from a new incremental `createRecordingValidator` in
    `render-stream-2.ts`. `validateRecording` is now a loop over it, with identical results. The
    bench page is served cross-origin isolated, for 5-µs timers.
  - **The web-export arm is stubbed `unavailable` until G7e.** `build-web-receiver.sh --bench` and
    the bench entry scene were not built, because they need G7e's preset, shell and shims.
  - The user's standing approval let G7d smoke-test the g31. This contradicts Q13a:
    - **The panel vsyncs at about 58.8 Hz** (rAF 17.02 ms; SurfaceFlinger's VSyncTracker reports
      16.98 ms). A 60 Hz host therefore drifts through every phase about every 0.87 s, instead of
      Q13c/D26's per-run phase lock.
    - Chrome uses ANGLE on the Mali-G52.
    - There is no timer query, so `dev-gpu` has only the fence and headroom paths.
    - RGB10_A2 is renderable and readable.
    - The landscape viewport is 828×330 CSS px.
    - adb-reverse RTT is 3.1 / 4.1 ms (p50 / p95) for 100 B and 67 ms for 813 KB.
    - The A75 was capped at 1.354 GHz while Thermal Status stayed 0.
  - One-repeat GSW smoke totals on the g31 ran 5–16× the desktop's. scene-full's p95 was 13.0 ms,
    and SHA-256 alone took 6.5 ms of it. Q13e's 4–5× factor is therefore optimistic for GSW, and
    hashing is a G7o candidate. G7m's five-repeat run is the measurement.

