# Capture singleton fixture

This headless scene loads the capture extension at runtime and obtains
`RenderStreamCapture` through `Engine.get_singleton()`. Its driver schedules an
arm, connects a WebSocket viewer and a script carrier, waits for a hello timeout,
and schedules disarm while a delayed texture job is pending. It keeps the viewer
alive without polling to exercise carrier teardown.

Run from the repository root with an already built capture extension:

```bash
G8L_ONLY=api bash experiments/render-stream/scripts/run-gate8.sh \
  --extension "$PWD/experiments/render-stream/capture/build/render_stream_capture.gdextension" \
  --calibration "$PWD/experiments/render-stream/calibration/godot-4.5.1-stable-linux-release.json" \
  --legs g8l --out "$PWD/artifacts/render-stream/live-swap"
```

The runner imports the fixture, runs the honest lifecycle and a listener bind
failure, then injects synchronous `armed` emission and main-thread joins in two
sabotage legs. These legs require real time; fast frames are unsupported.
`RS_SABOTAGE_TIER=skip` skips the sabotage legs using the normal tier markers.

Each leg writes `driver/driver.json` (signals, refusals, carrier activity and
final state) and `evidence/capture-api.json` (capture frames, callback durations
and join timing). `g8l-api-order`, `g8l-api-refusals`, `g8l-main-thread-stall`,
`g8l-api-arm-failed` and the two sabotage checks judge these files. The process
gap in `driver.json` is informational; the stall check uses capture callback
time, which excludes script signal handlers. Every driver wait has a frame
limit, with a final cap at 900 frames.

The fixture deliberately attempts calls from a script thread, invalid options,
repeated lifecycle calls, excess connections and late carrier registration.
A hello timeout must emit one `client_left`; a refused connection emits none.
