# Capture singleton fixture

This headless scene loads the capture extension at runtime and obtains
`RenderStreamCapture` through `Engine.get_singleton()`. Its driver runs the
lifecycle twice, the way a consumer re-arms:

1. Round 1 schedules an arm (`GRC_ROOT_SIZE=presentation:640x360`), connects a
   WebSocket viewer and a script carrier (`gdswap`), waits for a hello timeout,
   and schedules a disarm while a delayed texture job is pending. It keeps the
   viewer alive without polling to exercise carrier teardown.
2. At round 1's `disarmed` it registers a new `RenderStreamCarrier`
   (`gdswap` again, a new object; registration reopens at each disarm), calls `arm()` again
   (row R12: accepted, `standby` to `arming`, no signal before it returns),
   connects a viewer to the new listener, and disarms with reason `fixture2`.

For each round `driver.json` records the `armed` info (`arm_index`, `listen`)
and the root Window's `min_size` before the arm, while armed and after the
disarm. A listener bind failure leg re-arms from `arm_failed` and cancels it at
once with `disarm()` (rows R12 and R12c); the cancelled arm consumes no arm and
queues one `disarmed` with `arm_index` 0.

Run from the repository root with an already built capture extension:

```bash
G8L_ONLY=api bash experiments/render-stream/scripts/run-gate8.sh \
  --extension "$PWD/experiments/render-stream/capture/build/render_stream_capture.gdextension" \
  --calibration "$PWD/experiments/render-stream/calibration/godot-4.5.1-stable-linux-release.json" \
  --legs g8l --out "$PWD/artifacts/render-stream/live-swap"
```

The runner imports the fixture, runs the honest two-round lifecycle and a
listener bind failure, then injects synchronous `armed` emission and main-thread
joins in two sabotage legs. These legs require real time; fast frames are
unsupported. `RS_SABOTAGE_TIER=skip` skips the sabotage legs using the normal
tier markers.

Three more legs cover the re-arm teardown:

- `rearm-inflight` runs the lifecycle with `RS_SWAP_LOADER_THREAD=1`: a thread
  creates and frees 64x64 textures from the first `armed` until the driver
  finishes, across both disarms, while `GRC_TEST_INFLIGHT_DELAY_MS=4000` holds
  each create in flight longer than an arm lasts. The driver then skips its own
  main-thread texture to keep the loader as the only texture-create probe. Each release has to
  wait for the write begun after its `armed`.
- `sabotage-skip-inflight-wait` adds `GRC_REARM_FAULT=skip-inflight-wait`: the
  release does not wait. The delayed test reader records `reader_after_release`
  instead of accessing released arm state. Before each disarm the fixture waits
  for `reader-delay-arm-<n>.json`, proving a reader entered that arm. The check
  requires a positive count for both arms and host exit 0. Run this leg alone
  with `G8L_ONLY=api G8L_API_ONLY=skip-inflight-wait`.
- `sabotage-skip-root-restore` adds `GRC_REARM_FAULT=skip-root-restore`: the
  disarm leaves the arm's `min_size` on the root Window.

Each leg writes `driver/driver.json` (signals, refusals, carrier activity,
rounds, loader counts and final state) and `evidence/capture-api.json` (capture
frames, callback durations and join timing). The file is rewritten by every
disarm, so the driver keeps round 1's copy in `driver.json`. Arm 1 writes
`evidence/teardown.json` and arm 2 `evidence/arm-2/teardown.json`.

`g8l-api-order`, `g8l-api-refusals`, `g8l-main-thread-stall` (round 1),
`g8l-api-arm-failed`, `g8l-root-min-size-restored` (armed `min_size` is 640x360,
each disarm restores the value held before that arm, and both `teardown.json`
files say `restored`), `g8l-rearm-inflight` (every honest accounting rule holds
in both `teardown.json` files, the loader began creates while armed, and each
release waited out a write in flight, with `reader_after_release == 0` in
`evidence/reader-after-release.json`) and the three sabotage checks
(`g8l-sabotage-*`) judge these files. The process gap in `driver.json` is
informational; the stall check uses capture callback time, which excludes
script signal handlers. Every driver wait has a frame limit, with a final cap
at 1500 frames.

The fixture deliberately attempts calls from a script thread, invalid options,
repeated lifecycle calls, excess connections and late carrier registration.
A hello timeout must emit one `client_left`; a refused connection emits none.

`G8L_API_ONLY=admission` runs four focused loader admission legs. With
`GRC_TEST_INFLIGHT_SITE=admission`, `shader_set_code`, `texture_2d_create` and `free` hold immediately
after the native guard decides admission. The fixture releases each hold through
`admission-<site>.release`; `GRC_TEST_INFLIGHT_DELAY_MS` bounds a failed fixture's
hold. The standby leg keeps its shader call held through arm 2's entire lifecycle.
The counted leg holds both a shader update from A to B and a registered RID free
across disarm, then checks B's adoption and the freed RID's absence in arm 2.
`GRC_REARM_FAULT=standby-view-off` exposes the uncounted access that the honest
standby leg prohibits. The standby texture call is released while arm 2 is active:
`admission-texture-hot.json` proves the raw streaming bit is set but admission
still masks it to disarmed. `GRC_REARM_FAULT=hot-view-off` bypasses only that hot-line
mask and must expose the unsafe decision. The counted texture call spans disarm
alongside the shader update and free. Admission teardown evidence includes
`uncounted_arm_accesses` and `held_free_registered`; these probes run only with
the admission test knob.
