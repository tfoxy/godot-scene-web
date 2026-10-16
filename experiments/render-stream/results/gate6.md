## Gate 6t result (2026-10-11)

G6t ([protocol/gate6-design.md](../protocol/gate6-design.md) "G6t") passes: the measurement/report
tooling landed as new files only, touching no engine, capture or receiver code, per its wave-1
"no dependencies" entry in the Waves table. It owns:

- `scripts/lib/render-stream-report.ts` -- the `render-stream-report/1` schema (D10, Q7f): types,
  `validate()` (schema plus internal-consistency checks: exactly 5 repeats, `presented` always
  `unavailable`, `recv_gpu_render_ms` measured only for a rendered desktop-GL receiver, every
  `measured` value sourced, `memory` leaves as plain finite numbers from `/proc` with no status
  wrapper, and the `aggregate` block recomputed and compared), and `aggregate()` (median/min/max/
  coefficient-of-variation across exactly five repeats, dropping any metric path that any one
  repeat reports unavailable rather than aggregating a mix of real numbers and absent ones).
- `scripts/throttle-proxy.ts` (D12) -- a loopback-only TCP proxy (`node:net` only) in front of a
  host's listener, with a token bucket plus a fixed one-way delay per direction (`constrained`:
  500 000 B/s, 64 KiB burst, 30 ms). Both importable (`startThrottleProxy`) and a standalone CLI.
- `scripts/lib/proc-sampler.ts` -- 1 Hz `/proc/<pid>/status` and `/proc/<pid>/task/*/stat` reads
  (D9: engine memory counters are unavailable in release templates).
- `scripts/lib/provenance.ts` -- host facts, the gamescope version string, `sha256File`.
- `scripts/analyze-deltas.ts` (D15) -- hash-at-publish and mesh region-update delta savings from a
  `resources.jsonl` hook log, reported honestly rather than estimated where the log does not carry
  the needed byte size (mesh whole-buffer bytes; see "What G6t does not prove").
- `scripts/report-gate6.ts` -- `validate <report.json>` and `build <run-set dir> --out <file>
  [--deltas <resources.jsonl>]`, wired to `pnpm render-stream:report`.

**How it was tested**: `scripts/test/self-test-report.ts`, 40 assertions, all green, stable across
repeated runs:

- `validate()`: a fabricated report validates clean; one perturbation per rule each fails with its
  expected code (`bad-schema`, `run-entry`, `repeat-count`, `scenario-entry`, `rate-entry` ×2,
  `dist-entry`, `memory-entry`, `aggregate-mismatch`, `optimizations-entry`).
- `aggregate()`: median/min/max/cov of `[1,2,3,4,5]` computed by hand (cov ≈ 0.527); a metric
  unavailable in one of five repeats is dropped from the result entirely.
- `throttle-proxy.ts` against two real loopback TCP servers: a saturating echo stream stayed within
  5% of the configured 500 000 B/s (measured 97-102% across runs); discrete low-rate messages (one
  byte every 120 ms, well under the bucket's drain rate) stayed within 2 ms of the configured 30 ms
  delay (measured mean 30.0-30.2 ms both directions). The two had to be separate scenarios: a
  saturating stream's per-chunk latency is dominated by token-bucket queueing (measured ~1.5 s at
  saturation), which would otherwise swamp the ±2 ms delay check (memory:
  g6t-report-tooling-facts).
- `proc-sampler.ts` against a real spawned `node` child doing ~1s of CPU work: positive VmRSS, at
  least one thread, and that thread's summed CPU time measurably increasing between two samples.
- `provenance.ts` against this machine (positive logical CPUs/RAM, non-empty kernel string) and a
  real temp file (`sha256File` matches an independently computed digest).
- `analyze-deltas.ts` against fabricated `resources.jsonl` lines: a same-frame texture version bump
  correctly identified as superseded (and its own, not the superseding version's, bytes/hash_ns/
  copy_ns counted); a mesh's two region updates summed to an exact 200-byte delta with
  `whole_version_bytes_available: false`; a texture's delta equalling its whole (`savings_bytes:
  0`); mixed-unit parameter bytes per frame; and `parseHookLog` skipping one malformed line.
- `report-gate6.ts build()` assembling a report from a fabricated run-set directory that then
  validates clean, exercised both in-process and as the real `pnpm render-stream:report -- build
  ...` / `-- validate ...` CLI against a scratch run-set directory (outside the repo, not
  committed).
- `mise exec -- pnpm exec biome check` and `mise exec -- pnpm exec tsc --noEmit -p
  experiments/render-stream/tsconfig.json` both clean on every file this increment touched.

### What G6t does not prove

- That any of this runs against a REAL gate 6 capture, receiver or soak run: no `resources.jsonl`,
  `perf.json` or receiver `applied.json` from an actual Godot session exists yet (G6a/G6k/G6r/G6l
  land those). `report-gate6.ts build()`'s run-set directory layout is this increment's own
  convention, not something another file in the repository already defines; whichever increment
  first calls `build()` on a real measurement run may need to adjust it.
- A true mesh "whole-version bytes" baseline: `MeshSurfaceCopy` lines carry `vertex_count`/
  `index_count`, never a byte size, so `analyze-deltas.ts` cannot compute a mesh savings
  percentage without `rs_mesh_payload.h`'s format-to-stride mapping (out of scope here; memory:
  g6t-report-tooling-facts). The mesh delta total itself (from region updates' own `bytes`) is
  exact.
- `recv_gpu_render_ms`'s "rendered desktop-GL receiver" classification: the committed provenance
  shape has no explicit headless/rendered flag, so `isRenderedDesktopGlReceiver()` in
  `render-stream-report.ts` infers it from `rendering_method === "gl_compatibility"` plus a
  non-empty, non-placeholder `adapter.name` -- a judgment call documented in that file's header,
  not a normative field G6b/G6c's receiver provenance is guaranteed to populate the same way.
- `GRC_LIVE_MAX_CONNECTIONS`, rate control, or anything engine-side: G6t touches none of it (G6r's
  job). The throttle proxy and sampler are ready for G6c/G6l/G6s/G6p to drive against a real host
  and receiver, but have only ever been exercised against synthetic loopback servers here.

## Gate 6k result (2026-10-11)

G6k ([protocol/gate6-design.md](../protocol/gate6-design.md) "G6k", Q2) passes: calibrator 9 hooks the
six slots Q2 predicted, confirmed by `calibrate.py`/`scripts/calibrate.sh` against the pinned
binary exactly as predicted: `viewport_remove_canvas` 314, `viewport_set_global_canvas_transform`
323, `viewport_set_canvas_stacking` 324, `canvas_set_item_mirroring` 436, `canvas_set_item_repeat`
437, `canvas_set_parent` 439. Gate −1 goes from 73 to 79 hooks, none omitted; the committed record
now names 80 slots (79 hooks plus the `get_default_clear_color` probe). `build-capture.sh`
**17/17** ctests (`rs_resource_log` extended, no new
executable), `scripts/calibrate.sh --check` clean, gate −1 **29/29** (79 hooks, all six positive,
`old-record` still arms a calibrator-1 record with 71 hooks omitted), gate 0 **24/24**, gate 1
(groups g1a-g1d) **65/65**, gate 2 (groups g2a-g2e) **85/85** (one `live-animate`
pins-bounded/obsolete-retired rerun, the pre-existing load-timing flake named in
`.agents/memory/preexisting-check-failures.md`; it did not recur). Every pure self-test (checker,
gate 0, gate 1, gate 2) and `tsc --noEmit`/`biome check` on every file this increment touched
stayed clean: checker 75/75, gate 0 237/237, gate 1 402/402, gate 2 406/406.

Decode and hook-log only, exactly as scoped: none of the six calls the mirror, publisher or wire
format (`rs_mirror.*`/`rs_publish.*` untouched, render-stream/4 unchanged) -- that is G6b's job.

What landed:

- **Calibrator 9, six new optional slots** (`capture/src/hooks.cpp`): each hook bumps its
  `counters.json` entry and, with `resources().active()`, writes an `evidence/resources.jsonl`
  `kind:"canvas"` line (`capture/src/rs_resource_log.{h,cpp}`) with no registry and no
  classification -- a canvas's identity and state stay the mirror's field (G6b). New trailing
  columns, null on every other line: `sublayer` (`layer` itself reuses the existing column),
  `transform` (flattened `[a, b, c, d, origin.x, origin.y]`), `parent` (decimal string or null for
  `RID()`; the scale argument is not logged), `mirroring` (`[x, y]`) and `repeat` (`[size.x,
  size.y, times]`). `RESOURCE_LINE_KEYS`/`RESOURCE_LOG_OPS` (`gate2-checks.ts`) and `GATE0_HOOKS`
  (`gate0-checks.ts`) extended to match; `validateResourceLine`'s exact-key-order check means every
  existing line in every gate now carries five more trailing nulls too.
- **`fixtures/spike/`'s `_exercise_calibrator9_hooks`**: a `CanvasLayer`, parented to a throwaway
  `Node` so its stacking sublayer is deterministically 0, gets an explicit `set_layer`, a
  `set_follow_viewport(true)` (a non-null `canvas_set_parent`) and a `remove_child`
  (`viewport_remove_canvas`); a raw canvas item, parented to the world canvas (so
  `canvas_set_item_mirroring`'s own canvas lookup does not log an engine error,
  `renderer_canvas_cull.cpp:514-521`), gets a raw `canvas_set_item_mirroring` and
  `canvas_set_item_repeat`; the root's `global_canvas_transform` is written non-identity then
  reset to identity again before anything draws (stretch is disabled, so both values are exact),
  so every other calibrator's pixel sample keeps its frame-60 position.
- **A new gate −1 leg, `headless-stream`**: the only gate −1 leg with a file sink
  (`GRC_STREAM_OUT`) and resource store (`GRC_RESOURCE_STORE_DIR`) open, so `evidence/
  resources.jsonl` exists to check -- `headless-armed` and every other leg are untouched.
  `GRC_MODE=arm` alone never opens one (`entry.cpp`'s `resources_start()` runs only from the
  stream-open path), and no gate −1 leg had before this. The new `canvas-hook-log` criterion reads
  it alone, matching each of the six ops among resources.jsonl's `kind:"canvas"` lines against the
  fixture's own constants (`expected.json`'s new `canvas9` block).
- **`gate2-checks.ts`'s `census` criterion widened**: every `Viewport` (the root included) calls
  `viewport_remove_canvas` on `NOTIFICATION_EXIT_TREE` (`scene/main/viewport.cpp:611-615`) -- a
  universal engine behaviour, not specific to gate 2's fixture -- so the root viewport's own exit
  at `SceneTree` teardown now logs one after gate 2's quit frame on every stream-enabled leg. The
  "after the quit frame only teardown frees" rule now allows `viewport_remove_canvas` beside
  `free`.

### Findings

- **`canvas_set_item_mirroring`'s real ABI has two RIDs** (`RID p_canvas, RID p_item, const
  Point2 &p_mirroring`, `rendering_server.h:1526`), not the one `gate6-design.md` Q2's ABI
  shorthand ("436 is `(RID, const Vector2 *)`") shows. The slot number it predicted (436) was
  still exactly right -- `calibrate.py` discovers slots by name, independent of the hooked
  function's own decoded ABI -- so this was purely a decode-arity bug, caught by cross-checking
  the real header before writing the `using Fn... = ...` alias, not by any runtime failure (the
  hook still forwards the real pointer to the engine unchanged either way). `canvas_set_item_
  repeat`'s one RID argument is an item, not a canvas, despite the design doc calling that column
  "canvas RID" generically (memory: rs-g6k-canvas-hook-facts).
- **`evidence/resources.jsonl` needs an open stream, not just an armed capture.** Gate −1 never
  set `GRC_STREAM_OUT` on any leg before this increment (git history confirms G5a and G55a added
  `kind:"mesh"`/`"shader"`/`"material"`/`"item-material"` lines to the SAME file without ever
  checking them at gate −1 -- their first hook-log checks land at gate 2/5c/55b/55c, which all
  open streams). Validating a brand-new hook's hook-log content from gate −1 itself needed a new
  leg, not a new check against existing evidence.
- **The root viewport's own teardown call was the only gate 2 regression.** Hooking slot 314 is
  purely additive everywhere else it was already exercised (gate −1's spike, gate 0's and gate
  1's fixtures): only gate 2's `census` criterion asserts an exact, closed set of post-quit-frame
  ops, so it was the one place a new, always-present teardown call needed an explicit allowance.
  `gate5c-checks.ts`/`gate55c-checks.ts` have their own `after_quit` counters but only *report* the
  count, scoped to `kind:"mesh"`/`"shader"`/`"material"` lines that a `kind:"canvas"` line never
  matches, so they were never at risk.

### What G6k does not prove

- That the mirror, publisher or receiver understand any of these six calls: `rs_mirror.*` gained
  no canvas-layer table, no stacking/attach/transform fields, and the wire format did not move
  past render-stream/4. A `CanvasLayer`, `global_canvas_transform`, mirroring or repeat in a real
  scene changes nothing a receiver renders yet -- that is G6b's `fixtures/gate6-scene`/`gate6-hd`
  work.
- `canvas_set_parent`'s `scale` argument, or `viewport_set_canvas_stacking`'s/`canvas_set_item_
  repeat`'s values beyond what the spike fixture's own constants exercise: the hook log carries
  exactly what Q2 named and no more (D2's "no classification yet" rule).
- Rendering or pixels: none of the six calls draws anything, by design (the fixture additions are
  on an empty `CanvasLayer` and orphan/world-canvas items), so this increment proves decode
  correctness and hook-log shape, not visual behaviour.

## Gate 6r result (2026-10-11)

G6r ([protocol/gate6-design.md](../protocol/gate6-design.md) "G6r") passes: rate control, the
`GRC_LIVE_MAX_CONNECTIONS` admission limit and perf instrumentation on render-stream/5, with the
default (`GRC_PUBLISH_FPS=uncapped`) unchanged and no gate 6 wire version. Per the increment's own
scoping rule (`rs_live.cpp`+`entry.cpp` only, not `hooks.cpp`/`rs_resource_store.cpp`/
`rs_texture_payload.cpp`/`rs_mesh_payload.cpp`/`rs_shader_payload.cpp`/`rs_variant.cpp`/`rs_ws.cpp`),
Q3d's `store_write_us`, the texture/mesh/shader `copy_us`/`hash_us` pairs, `param_decode_us` and
`http_serve_us` are declared `unavailable` in `perf.json` rather than wired or guessed, and the
receiver's perf equivalently declares `resolve_us`/`upload_us` unavailable (combined inside
`RsApplier.accept_record`/`apply_state`, which this increment does not split).

- **Rate control (`capture/src/rs_live.{h,cpp}`, Q3c).** Per connection: `period_ns` (0 =
  uncapped), `t0_ns`/`next_due_ns` (started at the connection's own first send, never reset), and
  counters `ticks_due`, `ticks_sent`, `ticks_credit_blocked`, `frames_rate_idle` (all 0 under the
  default). A due tick without credit stays due and is counted; a due tick with credit sends and
  advances the schedule to the first tick strictly after "now", anchored at the *previous*
  `next_due_ns` rather than recomputed from `t0` and raw `now` -- the literal `t0 +
  (⌊(now-t0)/P⌋+1)·P` formula, applied when a send fires slightly *early* inside the due check's
  quarter-period slack (the common case, not an edge case), can floor back to the tick just
  serviced instead of the next one, double-firing on the very next callback. Anchoring at the old
  `next_due_ns` fixes it: `now < next_due_ns` (early/on-time) adds one period; `now >= next_due_ns`
  (credit blocked for a while) jumps straight to the first tick after `now`, skipping every missed
  one -- "never burst" without ever needing to catch up tick by tick.
- **Multi-connection admission (D13).** `GRC_LIVE_MAX_CONNECTIONS=1..4` sets
  `ServerConfig::max_clients`; the `Hub` already tracked every connection independently (pins as
  the union of every open connection's base, one snapshot copy per frame for all of them). The one
  real change: with more than one connection open, `on_http_get` no longer attributes a GET to
  "the newest connection" (which would misattribute a different receiver's fetch) -- it returns 0
  and counts the GET at the host level only.
- **Histogram (`capture/src/rs_histogram.{h,cpp}`, new).** A fixed 400-bucket log-linear
  histogram, 16 linear sub-buckets per octave (25 octaves, covering samples up to 2^25-1 before
  the top bucket clamps), ≤6.25% relative error, plus exact count/sum/min/max/mean. Below octave 4
  (values < 16) 16 equal-width sub-buckets cannot all be distinct -- most stay permanently
  unreachable, harmlessly, since the index formula is still injective over every value that
  actually occurs. `rs_histogram_test.cpp` (218 440 checks: an exhaustive sweep plus a
  reference-formula cross-check) passes clean. The receiver's perf.json reimplements the same
  bucket scheme in GDScript (`rs_perf.gd`'s `Histogram`), since it is a separate process with no
  access to the C++ library.
- **perf.json / perf-timeline.jsonl (`entry.cpp`).** `frame_interval_us`, `frame_callback_us` and
  `snapshot_us` measured directly in `entry.cpp`; `diff_us`, `encode_us`, `enqueue_us`,
  `credit_rtt_us`/`staleness_us` (`{applied, submitted}`) as cross-connection histograms owned by
  the `Hub` (the same costs already accumulated into `EndStats`, now also sampled per call).
  `cpu.main_thread_us` is exact (`CLOCK_THREAD_CPUTIME_ID`); `cpu.io_thread_us` is `null` (no
  handle to the I/O thread without touching `rs_ws.h`). `perf-timeline.jsonl` adds one line per
  second: frame count, RSS (`/proc/self/statm`) and, per connection, `sent`/`credits`/
  `coalesced`/`ticks_credit_blocked`/`max_pending_age_us`/`bytes_sent`.
- **GRC_HOOK_LOG (Q3d).** `off` stops `entry.cpp` from ever opening `resources.jsonl`, and
  `resources_drain()` now always drains (and, with the file closed, discards) the hooks' buffered
  lines every frame rather than only when the file is open -- fixing a latent unbounded-buffer-
  growth risk that existed whenever the file failed to open, not only under the new flag.
  `counters.json` and the mirror read from the hooks directly, never from this file, so they are
  unaffected either way; the per-call line-*building* cost inside `rs_resource_log.cpp` is
  unchanged (out of this increment's file list), so `off`'s measured saving is the file I/O and
  buffer retention only, not the hook's own formatting cost.
- **Receiver (`receiver/receiver.gd`, new `receiver/rs_perf.gd`).** `RS_RECEIVER_LOG=summary`
  drops `applied.json`'s `transactions` array to `null` (shots and failures stay; the backing
  array is never appended to either, so nothing grows unbounded). `RS_RECEIVER_PERF_OUT` writes
  `render-stream-receiver-perf/1` on every exit path (`_fail`/`_finish`/`_finish_live`, via
  `_write_report()`): histograms for `decode_us` (`RsApplier.accept_record`), `apply_us`
  (`RsApplier.apply_state`), `fetch_us` (reusing the fetch stage's own existing timestamps, never
  re-timed) and `frame_interval_us`; `cpu_render_ms`/`gpu_render_ms` via
  `RenderingServer.viewport_get_measured_render_time_{cpu,gpu}` with a status
  (`skipped-headless` under `--headless`, reusing receiver.gd's own existing headless
  vocabulary); `counts` (`received`/`applied`/`submitted`, from the existing `_acks_sent`, `null`
  in file mode, which has no acks); and a one-line-per-second timeline (RSS via `FileAccess` on
  `/proc/self/statm`, `RenderingServer.get_rendering_info`'s texture/buffer/video memory, the disk
  cache's entry count and bytes). Smoke-tested standalone against `protocol/golden-5/inline.rs5`
  in both `RS_RECEIVER_LOG` modes: `applied.json.transactions` is `null` under `summary` and a
  15-entry array under `full`; `perf.json` validates with populated `decode_us`/`apply_us`
  histograms, `fetch_us` exactly 0 (no fetches: an inline session), `render_time` both
  `skipped-headless`, and `counts` correctly `null` (file mode).

**Self-test leg**: `live-rate-30` (gate 1's `g1c` group, `GRC_PUBLISH_FPS=30` on the fixture's
60 fps host and receiver). `checkLiveRate30` (`scripts/lib/gate1-live-checks.ts`) compares it
against the plain `live` leg on the *same fixed timeline*: the file sinks (`recording.rs2`,
`recording-patch.rs2`) must publish exactly as many transactions as `live`'s did, proving rate
control affects only the live connection, never the file publisher.

| Metric | `live-rate-30` (target 30, host/receiver 60 fps) |
| --- | --- |
| requested | 30 fps |
| published (measured) | 518 sent over 1036 streaming frames = **30.00 fps** |
| file sink (full) transactions | 1080, 0 errors -- identical to the `live` leg's 1080, 0 errors |
| file sink (patch) transactions | 1080, 0 errors -- identical to the `live` leg's 1080, 0 errors |
| `ticks_due` / `ticks_sent` / `ticks_credit_blocked` / `frames_rate_idle` | 517 / 517 / 0 / 143 |
| `max_in_flight` | 1 |

The connection's very first send (right after the hello) is not itself a counted tick (it starts
the schedule); `sent` = 1 + `ticks_sent`. `ticks_credit_blocked` is 0: the fixture's receiver
always returns credit well within one 30 fps period. `frames_rate_idle` (143) accounts for the
rest of the 1036 streaming callbacks: `1036 = 1 (first send) + 517 (ticks_sent) + 143
(frames_rate_idle) + 375` -- the remaining callbacks are the ones spent waiting for credit to
return in between (counted in `frames_offered` but not in any of the four rate counters, which
only classify callbacks once streaming and not already accounted for by a send).

**How it was tested**:

- `rs_histogram_test` (218 440 checks), `rs_live_test` (261 checks, including four new rate-
  schedule tests: uncapped unchanged, 15/30/60 fps targets with a no-burst spacing check, a
  credit-blocked stall with no catch-up burst, and two independent connections) -- both via
  `ctest` from `experiments/render-stream/capture/build`, alongside the full existing capture
  suite (18 targets, all green, nothing regressed by the `wants_snapshot()` signature change or
  the `send_transaction()`/`Conn` additions).
- `mise exec -- pnpm exec tsc --noEmit -p experiments/render-stream/tsconfig.json`: clean;
  `mise exec -- pnpm exec biome check` clean on every file this increment touched.
- `scripts/test/self-test-gate1.ts`: 402/402 assertions, 89 fabricated evidence scenarios. Adding
  `checkLiveRate30` to g1c's check list meant the self-test's own fully-passing "good tree"
  fixture needed a `live-rate-30` host built alongside `live`'s (same file sink, same ~30 fps
  send cadence by construction) for that one new check to find evidence for; without it the
  "good tree passes every check" assertion failed (401/402) until `buildLiveLegs()` was extended.
- The receiver smoke-tested standalone (not via a gate) against `protocol/golden-5/inline.rs5` in
  both `RS_RECEIVER_LOG` modes, as described above.
- Gates -1, 0, 1 and 2 green with defaults (gate 1's full `g1a,g1b,g1c,g1d`, now including
  `live-rate-30`, 66/66 checks; gate 2's live-animate checks, sensitive to per-transaction timing
  per memory `rs-g55d-rs5-switch-facts`, are unperturbed by code that only runs under non-default
  `GRC_PUBLISH_FPS`/`GRC_LIVE_MAX_CONNECTIONS`/`GRC_HOOK_LOG`). Gate 5.5 green with defaults.
- `rs-g55d-rs5-switch-facts` also flags G5f specifically: a ~150 µs per-transaction receiver
  slowdown breaks its live checks. A dedicated benchmark (five warm-cache repeats, file-mode
  replay of a real 400-transaction capture through the receiver, `RS_RECEIVER_PERF_OUT` unset)
  measured this increment's receiver.gd within **~5 µs/transaction** of main's (3395-3402 ms
  total both sides; see memory `g5f-stale-coalesce-receiver-vs-reference-flake`). `pnpm
  render-stream:gate5 -- --legs g5c,g5f` (g5f's own checks only run when g5c is also requested)
  then showed one flaky check, `receiver-vs-reference`, on the `sabotage-mesh-stale-coalesce` leg
  alone (two runs, different step each time); A/B testing the identical fixture against main's
  unmodified receiver.gd (G6r's receiver.gd and rs_perf.gd fully reverted/removed) reproduced the
  exact same failure, 33/38, proving it is pre-existing and not a regression from this increment
  -- recorded as `g5f-stale-coalesce-receiver-vs-reference-flake` rather than "fixed" by changing
  code that was already zero-cost.

### Deviations from Q3d's full instrumentation list

Scoped to the files G6r's own section names (`rs_live.{h,cpp}`, `entry.cpp`, `rs_histogram.{h,cpp}`,
`receiver.gd`, `rs_perf.gd`); every omission below is declared in `perf.json`'s
`unavailable_stages` (capture) or the receiver perf's own list, not silently missing:

- `store_write_us`, `texture_copy_us`/`_hash_us`, `mesh_copy_us`/`_hash_us`,
  `shader_copy_us`/`_hash_us`, `param_decode_us` -- need `rs_resource_store.cpp`,
  `rs_texture_payload.cpp`, `rs_mesh_payload.cpp` or `rs_shader_payload.cpp`/`rs_variant.cpp`.
- `http_serve_us`, `cpu.io_thread_us` -- need a handle to the I/O thread, which `rs_ws.h` does not
  expose to `entry.cpp`.
- Receiver `resolve_us`/`upload_us` -- combined with `decode_us`/`apply_us` respectively inside
  `RsApplier.accept_record`/`apply_state`, which this increment does not split (upload bytes are
  already in `applied.json`'s `resources_summary`, not duplicated in perf.json).
- Receiver timeline `pipeline_compilations`, `live_rids`, `cache_entries_memory`/
  `cache_bytes_memory` -- would need new `RsApplier`/`RsResourceCache` accessors, out of this
  increment's two receiver files.
- `rs_perf.gd`'s `Histogram` has no dedicated GDScript unit test (no existing fast per-class
  self-test harness for a standalone RefCounted class in this project; it was instead verified by
  smoke-testing the whole receiver against `protocol/golden-5/inline.rs5` and by the C++
  `Histogram`'s own exhaustive test proving the shared bucket-math algorithm).

### What G6r does not prove

- A true gate 6 measurement matrix, report or deltas analysis (G6p); this increment's own
  `live-rate-30` table above is a single self-test, not the warmup-plus-five-repeats protocol
  D11 requires.
- Rate control under the `constrained` transport profile, dual connections at genuinely different
  *target* rates (both connections here share one `GRC_PUBLISH_FPS`; D13's "two at once, at
  different rates" is proved by independent receiver `--max-fps`, not independent publish
  targets, since GRC_PUBLISH_FPS is one hub-wide setting), or any of G6c's rate legs
  (`rate-15/-30/-60`, `mismatch-*`, `dual-60-15`, `recv-delay`, `gpu-heavy`) -- those are G6c's.
- The full Q3d instrumentation list end to end (see "Deviations" above).

## Gate 6w result (2026-10-11)

G6w ([protocol/gate6-design.md](../protocol/gate6-design.md) "G6w") passes: render-stream/6 is
implemented as a protocol-version switch on the same `rs2_codec.*`/`rs2_diff.*`/
`render-stream-2.ts`/`rs2_decoder.gd` modules /3-/5 already extended (memory:
g4e1-rs3-version-switch-pattern), touching no capture, receiver or runner code -- both still speak
/5 until G6b. [protocol/render-stream-6.md](../protocol/render-stream-6.md) specifies the delta as a
document like render-stream-5.md.

/6 adds, on top of /5: a new magic/protocol/subprotocol string; three new `viewport` keys
(`presentation_size`, `font_oversampling`, `snap_2d`) and a new `root_size_policy` value
(`presentation`); a new top-level session key `publication` (rate control, distinct from
`features.publication`); two new canvas keys (`layer`, `sublayer`); five new session-level
`unsupported` reasons (`canvas-stacking-tie`, `canvas-repeat`, `canvas-follow-viewport`,
`global-canvas-transform`, `snap-2d`); and three `features` list changes. `extra-canvas` stays a
schema-legal spelling but is rejected outright at /6 (mirroring how /5 rejects `unsupported-state`
naming `canvas_item_set_material`). Transactions, blocks, items and commands are byte-identical to
/5.

**As built**: `font_oversampling` is the one deliberate exception to render-stream-0.md's "floats
never appear in JSON" rule (gate6-design.md Q4 marks it `(new, float32)` as a bare JSON number).
Its canonical form -- the shortest fixed-point decimal that round-trips to the float64 widening of
the value, matching JavaScript's `Number::toString` (no trailing `.0`, unlike Python's `repr`) --
is implemented identically in `rs2_codec.cpp`'s `append_json_float()` and `make_golden.py`'s
`_json_float()`; the TypeScript decoder needs no special handling since its generic
`meta-noncanonical` check already re-serialises with native `JSON.stringify`, and GDScript performs
no canonical re-serialisation check at all (render-stream-0.md's existing exemption), so it only
parses the value and checks positivity.

`protocol/golden-6/` re-derives golden-5's fifteen states byte for byte under the new magic/
protocol (presentation_size equal to logical_size, oversampling 1, snap off, publication
every-frame, root canvas at layer 0/sublayer 0), then adds four more: state 16 (a second canvas
attached at layer 1/sublayer 0 with two new items), state 17 (only the layer changes, 1 -> -1), 18
(the canvas is detached, its items stay in the table), 19 (the canvas is reattached at layer 2 --
never carrying forward its detached layer -- alongside a third canvas at the same layer, a
canvas-stacking-tie, plus canvas-repeat/canvas-follow-viewport/global-canvas-transform declared
together). Three dedicated independent small streams follow params.rs5's precedent:
`presentation.rs6` (canvas_items, logical 1920x1080, presentation 960x540, oversampling 0.5),
`snap.rs6` (both flags true, every transaction carries the snap-2d entry), `rate.rs6` (a websocket
stream, publication rate/30). `invalid/` carries the thirteen new failure modes render-stream-6.md
lists; no new payload format at /6, so there is no `payload-invalid/` (golden-3's precedent).

**How it was tested**:

- `protocol/golden-6/make_golden.py --check` (stdlib only): 65 outputs match, deterministic
  regeneration. `make_golden.py --check` for golden-2 through golden-5 still match unchanged (62,
  47, 37 and 51 outputs respectively -- unaffected by this increment).
- `build-capture.sh`: all 18 ctests pass, including the new `rs6_codec_test` (full.rs6/patch.rs6/
  inline.rs6 byte-for-byte against `rs2_codec.cpp`'s V6 output, plus `rs2_diff.cpp`'s
  `make_full()`/`make_patch()`/`resolve()` round-tripping states 16-19 through the version-
  parameterized diff engine) and the unchanged rs2-rs5 codec tests.
- `scripts/test/self-test-rs2.ts` (TypeScript): all golden-2 through golden-6 suites green,
  including all thirteen golden-6 invalid vectors with their exact codes, the three new
  independent legs, and bidirectional bad-magic checks against /5.
- `receiver/tests/codec2_selftest.gd` (GDScript, headless): `[rs2-selftest] ok` against all five
  golden directories, same coverage as the TypeScript suite.
- `mise exec -- pnpm exec biome check` and `mise exec -- pnpm exec tsc --noEmit -p
  experiments/render-stream/tsconfig.json` clean on every file this increment touched.

### What G6w does not prove

- That the capture or receiver speak /6 at all: both still negotiate /5 (G6b's job). This
  increment is pure codec/golden-vector work, exactly as gate5_5-design.md's G55w was for /5.
  `calibrator_version`/`hooks_planned` in the golden-6 session are /5's values unchanged -- the
  real calibrator 9 hooks (canvas stacking, mirroring, repeat, parent, global canvas transform)
  are G6k's job, not this increment's.
- That `canvas-repeat`, `canvas-follow-viewport` or `global-canvas-transform` ever correspond to a
  real engine call: none of the three has a wire-visible argument (a mirroring vector, a parent
  RID, a live transform), so golden-6's vectors declare them directly rather than deriving them
  from any other field -- exactly as `canvas-light` already does at /5. Only `canvas-stacking-tie`
  and `snap-2d` have an independently checkable "actual" signal (the resolved canvas table and the
  session's own `snap_2d` flags, respectively).

## Gate 6a result (2026-10-11)

G6a ([protocol/gate6-design.md](../protocol/gate6-design.md) "G6a") passes: the combined 640×360
scene `fixtures/gate6-scene` (native Controls, a clipped ScrollContainer that scrolls, a Label and a
scrolling RichTextLabel with an inline image, a custom `_draw`, a texture that changes and is freed,
a mesh deformed every frame, a CanvasItemMaterial, a ShaderMaterial driven by an AnimationPlayer, a
Tween, a `top_level` escape and a HUD CanvasLayer) runs its file legs on render-stream/5.
`pnpm render-stream:gate6 -- --legs g6a` is **32/32** in `artifacts/render-stream/gate6/g6a-final/`
(ignored, not committed; 8 min wall clock), on `main` with G6r and G6w merged, and again 32/32 in `gate6/g6a-final2/` after G6k (calibrator 9) landed. The regression
gates on the same build are listed under "Runs" below.

**What was added.** The fixture (`scene_builder.gd`, parameterized by origin, cell and phase for
G6h; `gate6_scene.gd` with the `file`, `live`, `rate` and `soak` timelines, `steps` and `realtime`
time, the `animate` and `refused` variants and `RS_FIXTURE_SHOT_FRAMES`; `scene_oracle.gd`;
`make_expected.py` and `expected.json`), `run-gate6.sh` and `pnpm render-stream:gate6`,
`check-gate6.ts`, `lib/gate6-expected.ts`, `lib/gate6a-checks.ts` and `test/self-test-gate6.ts`
(39 assertions). Two shared files changed: `lib/geometry-raster.ts` gains an undecided box (text
and other hand-undecided content inside exact regions), and the receiver gains
`RS_RECEIVER_SABOTAGE=stale-texture` (with an `applier2_selftest.gd` case).

| Leg | Class | Pixels outside HU (and RF) |
| --- | --- | --- |
| `capture-scene`, `-inline`, `capture-animate` | `unsupported` (`extra-canvas` only) | — |
| `capture-refused` | `unsupported` (`extra-canvas`, `canvas-light`, multimesh and LCD `unsupported-op`, `unsupported-material`) | — |
| `receiver-scene`, `-patch`, `-inline`, `receiver-animate`, `receiver-refused` | `unsupported` | `success`: every pixel of every shot equals the reference |
| `sabotage-freeze` (@11), `-omit-transform` (@21), `-perturb-vertex` (@21) | `unsupported` | `pixel-mismatch` at exactly the predicted (shot, region) sets |
| `sabotage-perturb-shader` (@21) | `unsupported` | `success` (SM's shader is never re-coded; CM's are builtin) |
| `sabotage-receiver-ignore-clip`, `-stale-texture` | `unsupported` | `pixel-mismatch` at exactly the predicted sets |

Before G6b, /5 can only call the HUD's CanvasLayer `extra-canvas`, so every leg is `unsupported`
and the pixel verdict is judged outside `HU` (Q7b). Inside `HU` every honest receiver differs in
exactly the HUD panel's 168×28 pixels while the HUD shows above the root canvas, and nowhere at
steps 8 and 9.

**Measured budgets.** Reference against the hand model: 5 083 944 decided pixels over 30 shots
(twelve settle shots and frames 13, 53 and 93, both variants), 0 beyond their allowance; 80 388 use
delta 1 (the translucent, off-grid theme boxes and MS's gradients). `reference-repeat` and
`reference-armed` against `reference`: 0 of 3 456 000 pixel-shots each, in every region and pixel
class (exact 2 539 436, delta1 88 936, band 115 422, undecided 712 206). Receiver against reference:
0 in every compared pixel of every shot (3 348 992 per leg; 3 176 192 for `refused`), so the Q6g
budget is 0 everywhere.

**Checks** (`lib/gate6a-checks.ts`): `expected-self-consistent`, `leg-class-*` for the 4 captures
and 11 receivers, `headless-no-gpu`, `recordings-decode` (full sink 39.5 MB, patch 1.59 MB over 400
frames), `patch-resolves-to-full`, `step-log`, `draw-index-tie`, `expected-image-reference`,
`presence-reference` (692 shape-shots), `freshness-reference`, `reference-repeat-budget`,
`armed-transparent`, `scroll-parity`, `atlas-parity` (four LA8 pages at every step, both
directions, both sinks), `param-parity`, `line-edit-geometry` (36 selection and caret rects equal
the oracle's), `scene-census` (TEXN, TEXA, TEXB with predicted GRT1 hashes, 111 MS region updates,
34 SM parameter writes, CM builtin add at 1 and sub at 41, the HUD hidden over 81..90; the animate
capture's five TEXA versions) and `receiver-vs-reference`.

**Runs** (same build, all under `artifacts/render-stream/<gate>/g6a-final/`, ignored): gate 6
`--legs g6a` 32/32; gate −1 PASS; gate 0 PASS; gate 1 66/66; gate 2 85/85; gate 3 56/56; gate 4
185/185; gate 5.5 130/130; gate 5 failed 114/116 once on g5f's live `pins-bounded` /
`obsolete-retired` ("servable, named by nothing" at frame 851, the known live timing flake) and
passed 116/116 on the one rerun (`gate5/g6a-final-rerun/`). After merging G6k: gate 6 32/32,
gate −1 PASS (79 hooks) and gate 0 PASS under `<gate>/g6a-final2/`.

### Findings

- **No frame-1 tie.** Items created in `_ready()` get their top-level draw index inside frame 1, so
  Q6b's predicted `Scene`/`TL` tie never appears; Q6b's fallback is not needed.
- **LineEdit's selection draws with or without focus** (a scratch probe on the headless capture),
  and its carets sit on the baseline (`le.cpp:1466`), not at the selection's top.
- **The contract's sets were amended by the model and confirmed by the run**: TR redraws when its
  texture updates; HU is not fresh at step 9 (the layer behind the root canvas is under BG); PB
  redraws on every frame (step 0.01) and needed its box set again inside the tree; RT's image is
  scrolled out from step 5, so `stale-texture` reaches RT at 3 and 4 only; `perturb-vertex` also
  reaches RT through its own scrollbar. All in gate6-design.md "As built (G6a)".
- **Determinism needs quarter-frame clocks.** Sampling AnimationPlayers and the Tween at
  (f + ¼)/60 s keeps every key, loop end and rounding threshold away from accumulated float error.

### Deviations

- The receiver `stale-texture` sabotage did not exist (G2b2's is a host sabotage); G6a adds one,
  scoped to RGBA8 images so font atlases keep text honest.
- `line-edit-geometry` and `step-log` are checks beyond Q7b's list; the HU exactness is added to
  `receiver-vs-reference`.
- Sabotage captures run the default 122 frames, not 400.
- RT's line 3 reads "line 3" so the clip-escape prediction stays inside one region.

### What G6a does not prove

- The HUD layer end to end (G6b on /6), the 1920×1080 `canvas_items` fixture (G6h), live motion,
  stalls and reconnect on this scene (G6l), rates (G6c), stability (G6s) and costs (G6p).
- Text glyph pixels against a hand model: text stays undecided, covered by receiver equality and
  atlas parity only.
- Exactness on another GPU or driver, and browser receivers (gate 7).

Images (under the run directory): `scene/reference/shots/{step-0..11,frame-13,frame-53,frame-93}.png`
against `scene/receiver/shots/seq-<frame>.png`; the refused variant under `refused/`; each
sabotage's shots under `scene/sabotage-*/receiver/shots/` and `scene/sabotage-receiver-*/shots/`.

## Gate 6h result (2026-10-11)

G6h ([protocol/gate6-design.md](../protocol/gate6-design.md) "G6h") passes. The 1920×1080
`canvas_items` fixture `fixtures/gate6-hd` holds nine copies of the combined scene in a 3×3
`GridContainer`, cell c at phase 7c with TEXA offset 100c and HUD layer 1 + c. Its references run at
both presentations, and its native legs run on render-stream/5. `pnpm render-stream:gate6 --
--legs g6a,g6h` passes **52/52** in `artifacts/render-stream/gate6/g6h-final/` (ignored, not
committed; about 15 min wall clock). The first run of `--legs g6h` alone (`gate6/g6h-dev1/`)
already passed all 20 g6h checks.

**What was added.** `fixtures/gate6-hd/`:
- `project.godot` (1920×1080, `canvas_items`, `keep`) and `gate6_hd.gd`: the grid, gate6-scene's
  timelines for every cell, and the variants `animate` and `gpu-heavy`.
- `hd_oracle.gd`.
- `shaders/burn.gdshader`.
- `make_expected.py` and `expected.json`, which compose gate6-scene's model per cell plus the 0.5
  scale.
- The synced builder, oracle, loader and shader. `make_expected.py --sync` copies them and
  `--check` fails when a copy differs.

Gate 6 runner and checker files:
- `scripts/lib/gate6h-legs.sh`, sourced by `run-gate6.sh`.
- `scripts/lib/gate6h-checks.ts`, run by `check-gate6.ts`.
- `scripts/test/self-test-gate6h.ts`, which adds 27 assertions to `self-test-gate6.ts` (66 in all).

No capture, receiver or shared library changed.

| Leg | Class | Pixels |
| --- | --- | --- |
| `capture-hd-native` (headless, `enforce-min-size`: root window 1920×1080) | `unsupported` (`extra-canvas` only: the nine HUD layers) | — |
| `reference-hd-native`, `-repeat`, `-armed` (gamescope 1920×1080) | rendered | equal to each other on every pixel |
| `reference-hd-half`, `-repeat` (gamescope 960×540, `--resolution 960x540`) | rendered | equal to each other on every pixel |
| `receiver-hd-native`, `-patch` (1920×1080) | `unsupported` | `success`: every pixel outside the nine `HU` regions of every shot equals the reference |

**Measured budgets.** Reference against the hand model:

- Native: 23 759 684 decided pixels over 15 shots (twelve settle shots and frames 13, 53 and 93),
  0 beyond their allowance. 361 263 of them use delta 1.
- Half: 5 767 806 decided pixels, 0 beyond their allowance, 45 973 using delta 1. Half is the scene
  under scale(0.5) with StyleBoxFlat's feather at `aa_size / 0.5`, the source's
  `sbf.cpp:497-511`. It matched on the first run.

`reference-repeat` against `reference` is 0 of 31 104 000 pixel-shots at native and 0 of 7 776 000
at half, in every region and pixel class. `reference-armed` against `reference` is 0 of
31 104 000. Receiver against reference is 0 in each receiver's 30 140 928 compared pixel-shots.
Inside each cell's `HU`, the two differ in exactly that cell's HUD panel, 168×28 pixels, while the
HUD shows: 508 032 pixel-shots per receiver. The Q6g budget is 0 at both presentations.

**Costs at HD** (`capture-hd-native`, 496 items and 2 278 commands at the last settle frame, file
sinks only):

| Measure | Value |
| --- | --- |
| Full sink | 99.2 MB over 122 transactions: 813 KB per transaction (max 830 KB) |
| Patch sink | 11.5 MB over 122 transactions: 94 KB per transaction on average (the first, full transaction 788 KB) |
| Atlas at native | 4 LA8 pages of 256×256 at every settle step (525 KB of payload) |
| Atlas at half (reference oracle) | 8 pages: caches at the oversampled 6, 7 and 8 px beside the logical 12, 14 and 16 px |
| Host frame callback | 6.7 ms mean (max 15.7 ms), both sinks |
| Host snapshot | 0.46 ms mean |
| Host CPU | 0.94 s on the main thread for 122 frames |
| Capture leg wall clock | 1.5 s |
| Each rendered 1920×1080 leg | about 25 s (receivers included; 25 to 69 s under other agents' load in the dev run), mostly the fifteen PNG shots |

`census["capture-hd-native"]` in `result.json` carries the sink figures. G6p measures costs
properly (warmup, repeats, arms).

**Checks** (`lib/gate6h-checks.ts`):
- The capture: `leg-class-capture-hd-native`, `hd-session`, `hd-recordings` and
  `hd-draw-index-tie`. `hd-session` requires logical 1920×1080, `canvas_items`/`keep`,
  `enforce-min-size` with the host window at 1920×1080, status `match`, and the host's final
  transform the identity. `hd-draw-index-tie` requires Grid and the nine TLs at distinct indices
  from frame 1.
- The step logs: `hd-step-log`.
- The oracle: `hd-grid-layout`, `hd-oversampling-reference`, `hd-cell-oracle` and
  `hd-atlas-parity`. `hd-oversampling-reference` requires 1.0 and stretch 1 at native, 0.5 and 0.5
  at half. `hd-cell-oracle` covers 432 cell lines, the repeats byte-identical. `hd-atlas-parity`
  runs at native, both sinks, 4 pages at every step.
- The references: `hd-expected-self-consistent`, `hd-expected-image-reference-{native,half}`,
  `hd-presence-reference` (11 586 shape-shots), `hd-freshness-reference` (both presentations),
  `hd-reference-repeat-budget-{native,half}` and `hd-armed-transparent`.
- The receivers: `leg-class-receiver-hd-native{,-patch}` and `hd-receiver-vs-reference`.

**Runs.** `gate6/g6h-dev1/` was `--legs g6h` on the first try: 20/20 g6h checks, with the not-run
g6a group failing the gate by design. `gate6/g6h-final/` is `--legs g6a,g6h`, 52/52.
Gates −1 to 5.5 were not rerun: no capture, receiver or shared library file changed. Only gate 6's
runner, checker and self-test changed, and `--legs g6a` reran inside the final run.

### Findings

- **One viewport, one focus owner.** The builder's `grab_focus()` in every cell leaves only cell
  8's LineEdit focused. The others draw no focus box and no caret. `deselect_on_focus_loss_enabled`
  defaults to true and would also clear their selections, so `gate6_hd.gd` turns it off per cell.
- **The presentation is the window size.** `--resolution 960x540` in a 960×540 gamescope gives
  stretch 0.5 and oversampling 0.5 with the visible rect still 1920×1080. The grid lays out
  identically at both sizes.
- **The half model held on the first run.** The model is gate 5g's StyleBoxFlat port at
  `aa_size / 0.5` plus scale(0.5) on every transform and scissor. Text boxes needed no widening at
  oversampling 0.5.
- **No frame-1 tie** among Grid and the nine TLs, as in G6a.

### Deviations

All recorded in gate6-design.md "As built (G6h)":
- The capture runs the 122-frame file timeline, not 400, so `hd-recordings` replaces
  `recordings-decode`.
- Half-scale pixel classes are decided per pixel by the raster's 1/16 px edge rule, not per shape.
- `gate6_hd.gd` copies gate6_scene.gd's timeline logic rather than sharing it, because of `res://`
  independence.
- `expected.json` is 3.2 MB.
- The check names carry an `hd-` prefix so they stay unique in the combined report.
- `hd-cell-oracle`, `hd-session`, `hd-step-log` and `hd-draw-index-tie` go beyond the contract's
  check list.

### What G6h does not prove

- The HUD layers end to end, a capture at half (`presentation:960x540`), atlas parity at half,
  and receivers at half. All of these are G6b's on /6.
- HD live, rate, stall or soak behaviour, and the `gpu-heavy` calibration. These belong to G6l,
  G6c, G6s and G6p. `gpu-heavy` and `animate` were only smoke-captured: both classify `unsupported`
  with exactly `extra-canvas`, and `burn` is carried `ok`.
- Text glyph pixels against a hand model (undecided, as in G6a).
- Another GPU, and browser receivers.

Images (under the run directory): `hd/reference-native/shots/{step-0..11,frame-13,frame-53,frame-93}.png`
(1920×1080) against `hd/receiver-native/shots/seq-<frame>.png`, and
`hd/reference-half/shots/*.png` (960×540).

## Gate 6l result (2026-10-11)

G6l ([protocol/gate6-design.md](../protocol/gate6-design.md) "G6l", Q7c) passes. It covers live motion
compared frame for frame with the reference, a 2-s receiver stall across a texture update, a
reconnect and a warm cache, on `fixtures/gate6-scene`'s `animate` variant. The legs use the live
timeline (S=300, N=60, quit 1080), `steps` time and `--max-fps 60` on both ends, on render-stream/5.
`pnpm render-stream:gate6 -- --legs g6a,g6h,g6l` is **74/74** (g6a 32, g6h 20, g6l 22) in
`artifacts/render-stream/gate6/g6l-final/`, on `main` at fd247708 (G6h) merged. The evidence
directories are ignored and not committed. Earlier runs on the same g6l code: `gate6/g6al-run1/`,
`--legs g6a,g6l`, 54/54 before G6h merged; and the trial `gate6/g6l-try1/`, where every g6l check
passed (g6a was not run). Regression gates for the receiver change, all under
`<gate>/g6l-final/`: gate −1 PASS, gate 0 PASS, gate 1 66/66, gate 2 85/85.

**What was added.** `run-gate6.sh` gains group `g6l` and `lib/gate6l-checks.ts` holds its checks.
`check-gate6.ts` adds a per-leg `live` timing block. `test/self-test-gate6l.ts` adds 34 assertions,
run from `self-test-gate6.ts` (100 in all with G6h's). One shared file changed: the receiver gains
`RS_RECEIVER_RECONNECT_MEMORY=drop|keep`, whose default `drop` keeps G2c2's rule.

| Leg | Class (/5) | Pixels outside HU |
| --- | --- | --- |
| `live-scene` (fresh cache) | `unsupported` (`extra-canvas` only) | `success`: 52/52 shots (12 settle, 40 motion) equal the reference at their frame |
| `live-scene-warm` (live-scene's cache) | `unsupported` | `success`, 52/52 |
| `live-stall` (`RS_RECEIVER_STALL=2:2000`) | `unsupported` | `success`, 44/44 (8 windows fall inside the stall) |
| `live-reconnect` (`RS_RECEIVER_RECONNECT=5`, memory kept) | `unsupported` | `success`, 52/52 (30 on connection 2) |
| `sabotage-live-stale-coalesce` (the stall, `stale-coalesce` @420) | `unsupported` | `pixel-mismatch` at stale sends only |

**How shots are judged.** Each shot names one transaction. The host's live log gives the frame it
was sent at, and under the sabotage the frame its snapshot came from (`stale_from`). The tap's
state at that seq must equal the full recording at that frame. The shot must equal
`reference-live-frames`' shot of that exact host frame: whole frame outside HU, budget 0. That
reference runs after the live legs and shoots every frame any receiver shot, plus every
`stale_from` frame (94 frames in this run). All 244 receiver shots matched pixel for pixel. On the
honest legs every shot's wire frame was its send frame. On the sabotage leg 47 transactions were
stale-coalesce copies, each equal to the full recording at its `stale_from`.

**Measured timing.** Times are on the host clock unless noted. Staleness is the host-clock age of
what the receiver had applied or submitted at that ack, from `perf.json`'s histograms. Fetch latency
is per HTTP GET, on the receiver's clock.

| Leg | Credit RTT median / p95 | Staleness p50 applied / submitted | Fetches, p50 / p95 | Applied |
| --- | --- | --- | --- | --- |
| `live-scene` | 22.0 / 43.1 ms | 19.5 / 21.5 ms | 124, 13.8 / 16.7 ms | 459 |
| `live-scene-warm` | 8.5 / 26.8 ms | 6.9 / 8.2 ms | 4, 13.9 / 14.3 ms | 971 |
| `live-stall` | 9.6 / 29.0 ms | 6.9 / 9.2 ms | 125, 14.1 / 16.7 ms | 737 |
| `live-reconnect` | 13.7 / 32.9 ms | 11.8 / 14.8 ms | 128, 14.1 / 16.7 ms | 656 |
| `sabotage-live-stale-coalesce` | 10.9 / 31.7 ms | 8.2 / 10.8 ms | 125, 14.0 / 16.7 ms | 668 |

In this run `live-scene` phase-locked to every other frame: 253 of its gaps were 2 and none were 1,
hence its higher credit RTT and staleness. In `g6al-run1` the same leg ran mostly at gap 1, with a
14.6 ms median credit RTT and 732 applied.

- **Stall.** The receiver blocked for 2000.1 ms after its step-2 shot. The host had sent frame 427,
  and the credit came back at frame 550, 123 frames later. The recovery went out at the credit's
  own callback, 15.1 ms after the ack. Its `submitted` ack arrived 76.5 ms after the credit, after
  one TEXA fetch, the apply and the shot. Steps 3 and 4 fell inside the stall, and `coalesced` grew
  by 122. Five TEXA versions landed in the stall (frames 450, 480 twice, 510, 540). Only the one
  current at frame 550 was fetched, for the recovery seq. On the sabotage leg the stall also ran
  from 427 to 550, and the recovery carried frame 428's snapshot.
- **Reconnect.** After the step-5 shot (frame 607) the receiver closed with 1000 and disposed 66
  RIDs, leaving none. Connection 2's seq 1 (full, frame 612, new `stream_id`) was applied 37.2 ms
  after the dispose. Memory held 119 payloads, all of them also in the cache. Connection 2 hit the
  cache directory 0 times and fetched 9 payloads, all TEXA versions and atlas pages created after
  the reconnect.
- **Warm.** live-scene cached 124 payloads. The warm receiver hit all 124 and fetched 4 MS surfaces
  that the phase-locked cold run never carried, and nothing it had cached. In `g6al-run1` the cold
  run carried all 90 surfaces, and the warm leg fetched nothing.
- **Cadence.** The host sent every transaction at the first frame callback after its
  predecessor's credit: 3 485 sends in this run. From frame 320 on, gaps of 3 or 4 between applied
  frames occurred 82 times on live-scene, 4 on the warm leg, 9 on live-stall, 47 on live-reconnect
  and 16 on the sabotage. Every one followed a transaction the receiver held for longer than a
  frame between receipt and its `submitted` ack: a shot with its state dump, or an HTTP fetch.

### Findings

- **Q7c's "consecutive applied frames differ by at most 2" fails as stated, and the cause is the
  receiver.** A shot, a state dump or a frame-quantized fetch (about 14 ms) costs the receiver a
  frame before its `submitted` ack. Under load a frame occasionally overruns on its own: one per run
  in `g6l-try1` and `g6al-run1`. The check as built requires a host that never sits on a credit. It
  attributes each gap above 2 to the stall, the reconnect, or a receiver hold longer than one frame,
  as measured by the receiver. A gap above 2 behind a fast receiver still fails
  (gate6-design.md "As built (G6l)" 2).
- **`coalesced` grows once per stalled frame here (122).** MS, SM, AN and PB change the mirror every
  frame. G1d's step-only fixture grew it by 69.
- **A window can be missed outside the stall.** The recovery transaction falls in both settle window
  4 and motion window 112. The settle window is listed first and takes it. Missed windows are
  judged by candidates: a window is missed legitimately only if it holds no applied transaction
  left unshot.
- **`steps` time makes the warm cache depend only on what the cold wire carried.** Every TEXA
  version, atlas page and MS pose is identical across runs. "Only TEXA versions newer than the cold
  run's last" is therefore empty. A warm leg fetches exactly the MS poses a phase-locked cold run
  skipped (0 or 4 so far).
- **The contract's stall frames** (about 427 to 549) measured 427 or 428 to 550 or 551.

### Deviations

- `RS_RECEIVER_RECONNECT_MEMORY=keep` is opt-in. Retaining memory by default would contradict
  G2c2's rule and gate 2's `reconnect-no-refetch`, which expects disk-cache hits on connection 2.
- `motion-monotonic` attributes gaps above 2 rather than failing all of them (see Findings).
  `live-steps` compares the step-determined regions with an extra file-timeline `reference-file`
  leg; `live-motion` already compares the whole frame with the live reference.
- `warm-fetch` requires that no cold-cached or static payload is fetched, not zero fetches overall.
- On /5 every g6l leg classifies `unsupported` (`extra-canvas`), as in G6a. G6b's re-run flips the
  expected class to `success`.
- No 304, 404 or bearer case arises on these legs; gate 2 keeps them.
- The checker digests each leg and drops its decoded recordings. Five legs' full, patch and tap
  recordings overflowed the default Node heap.

### What G6l does not prove

- The HUD layer over the live stream (G6b on /6). Rates other than 60/60, two receivers and a
  constrained transport (G6c). Stability over minutes (G6s).
- Pixels of frames no receiver shot: each leg shoots 52 windows, not every frame.
- Presentation: shots are taken at `frame_post_draw`, and presented time is `unavailable` (D9).
- Exactness on another GPU or driver, or in browser receivers (gate 7).

Images, under `artifacts/render-stream/gate6/g6l-final/live/`:

- `sabotage-live-stale-coalesce/receiver/shots/seq-194.png` is the stale recovery shot: frame 550
  carrying frame 428's snapshot. It equals `reference-live-frames/shots/frame-428.png`. Against
  `frame-550.png` it differs in AN, CM, LB, MS, Marker, PB, RT, SC, SM and TR.
- `live-stall/receiver/shots/seq-258.png`, the stall's recovery shot, equals `frame-550.png`.
- `live-reconnect/receiver/shots/stream-2-seq-<n>.png` are connection 2's shots.

## Gate 6b result (2026-10-11)

G6b ([protocol/gate6-design.md](../protocol/gate6-design.md) "G6b") passes. It moves the capture, the
receiver and every gate runner to [protocol/render-stream-6.md](../protocol/render-stream-6.md).
`pnpm render-stream:gate6 -- --legs g6a,g6h,g6l,g6b` passes **92/92** (g6a 32, g6h 20, g6l 22, g6b
18) in `artifacts/render-stream/gate6/g6b-m1-gate6-174100/`, on `main` at d0df9b8e (G6l) merged.
The pre-merge run `gate6/g6b-r2-gate6-171316/` (`--legs g6a,g6h,g6b`) was 69/70 on its first
attempt. `atlas-parity-half` failed it, see finding 1. After the fix it re-checked 70/70 on the same
evidence.

Every earlier gate was re-run on /6 after the merge. The directories are under
`artifacts/render-stream/<gate>/g6b-m1-*` and are ignored, not committed:

| Gate | Result |
| --- | --- |
| −1 | PASS, 29/29 |
| 0 | 24/24 |
| 1 | 66/66 |
| 2 | 85/85 |
| 3 | 56/56 |
| 4 | 185/185 |
| 5 | 116/116 |
| 5.5 | 130/130 |

The pre-merge runs (`g6b-r2-*`) also passed gate 0 (24/24), gate 1 (66/66), gate 2 (85/85) and gate 3
(56/56).

**What changed.**
- **Capture.** The mirror (`rs_mirror.*`) keeps each canvas's `layer` and `sublayer`. Attaching a
  canvas to the root viewport is supported and resets its stacking to (0,0). Removing it detaches
  the canvas and keeps its items. The mirror derives `canvas-stacking-tie`, `snap-2d` and
  `global-canvas-transform`, the last compared bitwise with the arm-time `host_final_xform`, and
  it types `canvas-repeat` and `canvas-follow-viewport` as sticky entries. Calibrator 9's six hooks
  now tap the mirror. Every snapshot is stamped V6.
- **Arm.** `entry.cpp` and `rs_root_query.*` add `GRC_ROOT_SIZE=presentation:<W>x<H>`: one
  `Window.set_min_size(W, H)` at arm. Under stretch `disabled` a size other than the logical one
  is refused before anything opens (`root-size-invalid`). The new `host_size_status` compares the
  window with the presentation size. The capture reads oversampling, the snap flags and the stretch
  transform through method binds.
- **Publication.** The session carries `publication`: every-frame/null on file sinks, and on a live
  connection the `GRC_PUBLISH_FPS` target. The live listener speaks `render-stream.6`.
- **Receiver.** It adopts a `canvas_items` session's stretch. It checks the window size against
  `presentation_size` and its oversampling against `font_oversampling`, typing
  `presentation-mismatch`, `oversampling-mismatch` and `stretch-mode` while still drawing. It
  creates, attaches, stacks, transforms and modulates its own canvases. It writes
  `render-stream-receiver-applied/6`. Two sabotages are new, `ignore-canvas-stacking` and
  `ignore-presentation`.
- **Runners and checkers.** Every runner and checker switched to /6, following memory
  rs-g55d-rs5-switch-facts' checklist. g6a, g6h and g6l now classify `success` (sabotages
  `pixel-mismatch`) and compare HU. The `refused` variant gains a `follow_viewport` layer. Group
  `g6b` is `lib/gate6b-legs.sh` with `lib/gate6b-checks.ts`. `test/self-test-gate6b.ts` adds 27
  assertions, so `self-test-gate6.ts` has 132.

| Leg | Class | Pixels |
| --- | --- | --- |
| `capture-hd-half`, `-inline` (`presentation:960x540`) | `success` | — |
| `capture-hd-half-at-logical` (the hazard's capture, `enforce-min-size`) | `success` | — |
| `capture-snap` (`snap_2d_transforms_to_pixel=true`) | `unsupported`: `snap-2d` in each of 122 transactions | — |
| `receiver-hd-half`, `-patch`, `-inline` (960×540) | `success` | every pixel of all 15 shots equals `reference-hd-half` (7 776 000 per leg) |
| `receiver-hd-half-at-logical` (the hazard) | `unsupported`: `presentation-mismatch`, `oversampling-mismatch` | flat regions equal; text and antialiased regions differ |
| `sabotage-receiver-ignore-presentation` | `unsupported`: `oversampling-mismatch` | every region of every cell and BG differs at all 15 shots |
| `sabotage-receiver-ignore-canvas-stacking` (scene) | `pixel-mismatch` | HU at step 9 and frame 93 only, as predicted |
| g6a's default and `animate` legs; g6h's native legs; g6l's honest legs | `success` | every pixel, HU included |
| g6a `refused` | `unsupported`: `canvas-follow-viewport` replaces `extra-canvas` | every pixel outside RF |

**The hazard, measured** (`presentation-hazard-measured`: differing pixel-shots over 15 shots, nine
cells). These are the evidence for D1 and D2:

- The flat regions are 0 each: AN, BG, CD, CM, MS, Marker, NP, SM, TL and TR.
- The text-only regions differ: RT 110 511, LB 38 178 and HU 6 156.
- The antialiased-only region differs: HB 3 780.
- The mixed regions differ: SC 53 829, LE 29 910, BT 15 840 and PB 10 240.

**Other checks.** `canvas-commands` holds on both sinks: 400 transactions of the scene's HUD and
1 098 canvas-transactions of the nine HD layers equal the hook log's stacking. `canvas-stacking-parity`
compares 240 canvas-steps with the oracles. `stylebox-aa-scale` holds for 768 triangle arrays over
45 items at half and 768 at native, with no ulp used. `atlas-parity-half` holds for 48 drawn page
cells. `receiver-typed-clean` holds for 13 receivers: g6a's 8, g6h's 2 and g6b's 3 half ones.

**Costs.** The HD half capture's full sink is 99 209 334 B (122 transactions), the patch sink
11 471 140 B and the inline capture 101 544 312 B, about native's. Receiver per-transaction cost was
benchmarked on a headless file-mode replay of a real 400-transaction gate6-scene capture: main's
receiver on main's /5 capture against this branch's receiver on its /6 capture, one warmup plus 5
warm-cache repeats, `RS_RECEIVER_PERF_OUT` on. The medians per transaction over 401 records:

| Receiver | decode | apply | decode + apply + fetch |
| --- | --- | --- | --- |
| main | 6 061.7 µs | 793.9 µs | 6 855.6 µs (6 782–6 970) |
| this branch | 6 072.7 µs | 805.8 µs | 6 878.6 µs (6 785–7 084) |

That is +23 µs (0.3 %), inside the run-to-run spread and far below the ~150 µs that tipped G5f's
live checks (memory rs-g55d-rs5-switch-facts). Wall time was 4.31 s for both. Gate 5's live g5f
and gate 6's g6l legs passed on /6.

### Findings

1. **The half oracle's logical-size atlas pages are shaping-only.** The first run failed
   `atlas-parity-half` because the 12/14/16 px pages the half reference's oracle lists are on no
   wire texture. The TextServer rasterizes glyphs at the logical size to measure text, but nothing
   draws them, so no texture is created. The check now compares the oversampled pages (native
   sizes × 0.5) both ways, and requires that no logical-size page appears on the wire.
2. **`ignore-canvas-stacking` differs only at a negative layer.** An unstacked canvas ties the root
   canvas at (0,0). The renderer orders the tie by RID, and the receiver's canvas is the newer one,
   so it draws above, exactly as layer 1 does. Q6h's {0..7, 10} is amended to {9, frame 93}.
3. **The hazard types `oversampling-mismatch` too**, and `ignore-presentation` must skip the
   visible-rect check to present anything at all (gate6-design.md "As built (G6b)" 2 and 3).
4. **The stacking lands in the attach frame** (Q1e's prediction held). No transaction of any capture
   carries a tie.
5. Only gate 0's receiver-typecheck caught `float(<Variant>)` in `receiver.gd`. The headless
   self-tests never load `receiver.gd` (memory rs-g6b-rs6-switch-facts).

### Deviations

- `capture-hd-half-inline` is an added leg, because `receiver-hd-half-inline` needs an inline
  capture. `capture-hd-half-at-logical` is its own capture, configured like `capture-hd-native`.
- g6b reuses g6a's `scene/capture` and g6h's `reference-half`, so `run-gate6.sh` refuses g6b without
  g6a and g6h and runs it last.
- `canvas-commands` joins canvases to RIDs by their first stacking line. No hook-log line was added
  for attach or create.
- The session-level order is degenerate-host-size, snap-2d, the sticky entries, then the
  per-snapshot global-canvas-transform and canvas-stacking-tie (As built 7).

### What G6b does not prove

- Snap replay, follow-viewport and parallax repeat stay typed, never replayed (gate 8). The same
  holds for `global-canvas-transform`, which no fixture changes at runtime.
- Stretch modes other than `canvas_items` with aspect `keep`. `viewport` is typed `stretch-mode` and
  no leg runs it.
- More than one presentation per capture session (gate 7), live rates and two receivers (G6c), and
  stability (G6s).

Images, under `artifacts/render-stream/gate6/g6b-m1-gate6-174100/`:

- `hd/receiver-half/shots/seq-28.png` equals `hd/reference-half/shots/step-2.png`.
- `hd/receiver-half-at-logical/shots/seq-28.png` is the hazard: full-size glyph atlases drawn at
  half, and the narrower feather.
- `hd/sabotage-receiver-ignore-presentation/shots/seq-28.png` shows the top-left quarter at scale 1.
- `scene/sabotage-receiver-ignore-canvas-stacking/shots/seq-98.png` is step 9, with the HUD over BG.

## Gate 6s result (2026-10-11)

G6s ([protocol/gate6-design.md](../protocol/gate6-design.md) "G6s", Q5 "Resource budgets", Q7e
"Stability") adds receiver cache budgets with LRU eviction that never evicts the needed set, a
host sabotage that never retires a hash, and a 300-s-plus soak against `fixtures/gate6-scene`'s
`animate` variant on the `soak` timeline (`realtime` time, `GRC_HOOK_LOG=off`).
`pnpm render-stream:gate6 -- --legs g6a,g6l,g6s` was **67/73** (g6a 32, g6l 22, g6s 19) in
`artifacts/render-stream/gate6/g6s-final/`, on `main` at 02e6f4dc (G6b) merged. The 6 checks that
did not pass were all `rss-bounded`, one per g6s leg (Finding 5, below). **Fixed 2026-10-14** --
see "G6s live-buffer fix (2026-10-14)" below: `rss-bounded` now passes on every leg, and the
rest of this section's table and findings are left as they read at the time, for the negative
result's own record.

| Leg | Window | `residency-bounded` | `cache-budget-respected` | `rss-bounded` | `soak-pixels` |
| --- | --- | --- | --- | --- | --- |
| `soak-scene` (fresh cache, memory 1 MiB / disk 4 MiB) | 370 s | pass | pass | **fail** (below) | pass, 0 px |
| `soak-inline` (every payload inline, memory budget off) | 370 s | pass | pass | **fail** | pass, 0 px |
| `sabotage-soak-no-evict` | 370 s | pass (fails exactly `receiver memory-cache entries`) | pass | **fail** | pass, 0 px |
| `sabotage-soak-retain-superseded` | 370 s | pass (fails exactly `host retained payloads`) | pass | **fail** | pass, 0 px |

**Residency, per leg** (host mirror hash-backed resources = textures + meshes + materials;
receiver memory-cache bytes against its 1 MiB budget + one payload; host retained against
4 × live mirror + 16, see "As built (G6s)" 3):

| Leg | Host mirror (tex/mesh/mat) | Host retained (bound 56) | Receiver memory-cache entries | Receiver memory-cache bytes (bound ~1.06 MiB) |
| --- | --- | --- | --- | --- |
| `soak-scene` | 7/1/2 | 10 | 120 | 1 048 436 B |
| `soak-inline` | 7/1/2 | 10 | 131 (no bound: inline, no budget) | 1 577 664 B (no bound) |
| `sabotage-soak-no-evict` | 7/1/2 | 10 | **128, over bound (1 525 360 B > 1 065 088 B)** | 1 525 360 B |
| `sabotage-soak-retain-superseded` | 7/1/2 | **139, over bound (56)** | 120 | 1 048 436 B |

**Eviction and refetch, per leg** (`applied.json`'s `resources_summary`): `soak-scene` --
`evictions_memory` 9, `evictions_disk` 0, `refetch_after_evict` 0; `soak-inline` -- 0/0/0 (by
design: no cache directory or store, so an evicted recurring hash would be unrecoverable);
`sabotage-soak-no-evict` -- 0/0/0 (the sabotage turns eviction off, and it stayed off);
`sabotage-soak-retain-superseded` -- 9/0/0 (the sabotage is host-side; the receiver's own budget
is exercised exactly as in the honest leg). That an evicted hash was never in the needed set at
eviction time is proven by `receiver/tests/applier2_selftest.gd`'s `_test_cache_budgets()`, not
re-derived from this run's evidence: `RS_RECEIVER_LOG=summary` and `GRC_HOOK_LOG=off` leave no
per-event trail for a 300-s soak to reconstruct it from externally.

**RSS, per leg** (`/proc`-sampled, median of the last 30 s minus median of the first 30 s of the
measured window; budgets 4 MiB / 0.5 MiB/min host, 16 MiB / 2 MiB/min receiver): host stayed flat
on every leg (well under budget); receiver rose 305.9, 304.7, 305.9 and 305.9 MiB (slope ~68
MiB/min) on `soak-scene`, `soak-inline`, `sabotage-soak-no-evict` and `sabotage-soak-retain-
superseded` respectively. Timelines: `g6s/<leg>/host/proc-samples.jsonl` and
`g6s/<leg>/receiver/proc-samples.jsonl`; residency curves: `g6s/<leg>/host/evidence/perf-timeline.
jsonl` (`host_retained`, `mirror_items`/`_textures`/`_meshes`/`_materials`, each connection's
`carried_size`) and `g6s/<leg>/receiver/perf.json`'s `timeline` (`cache_entries_memory`/`_disk`,
`cache_bytes_memory`/`_disk`, `live_rids`).

### Findings

1. **`reference-step11` must run the soak timeline at the same capped rate as every leg.** The
   file timeline or an uncapped rate freezes step 11's continuous state (SC, PB, SM, MS, AN, LB)
   at a different phase -- either mismatch alone cost thousands of pixels before this reference
   was fixed (gate6-design.md "As built (G6s)" 1).
2. **A fixed, uniform shot-window scheme picked a pre-freeze transaction for the "final" shot.**
   `g6s_windows()`'s last window started well before the real step-11 trigger frame on one run
   (21350 against 21896), so its "first transaction in the window" was 546 frames stale: 15 347
   mismatched pixels, every one in a region step 11 resets and none anywhere else. Fixed by
   placing the last window strictly after step 11's nominal trigger frame (21900 = 60 fps × 365 s),
   which the `--max-fps 60` cap guarantees the real trigger can never exceed (As built 2).
   `soak-pixels` has been 0 mismatched pixels on every leg since.
3. **`residency-bounded`'s two Q7e halves need independent evaluation.** The receiver memory-
   cache entry count swings on its own under active LRU eviction near a byte budget (measured:
   113 to 120 within one honest leg's own window, bytes flat under budget throughout) -- ANDing
   the growth half into the budget-bound half would fail an honest leg. As built, a metric with a
   budget-derived bound is judged on that bound alone; a metric with neither keeps the growth
   half, with a small slack (2) for an ordinary transient tick. Both sabotages' extra residency is
   already at its full, flat, elevated level before the measured window even starts (the burst is
   fixture setup, finished by game time ~15 s), so only the budget-bound half can catch either one
   (As built 3).
4. **`soak-inline`'s carried-hash set cannot shrink, by protocol.** render-stream-2.md's
   `resource-duplicate` rule (each hash carried at most once, ever) ruled out an earlier draft that
   pruned it; "bounded" is a growth-rate ceiling (200/min) instead. Measured rate: 0/min, not
   TEXA's assumed ~120/min -- `_animate` stops updating TEXA once `apply_step(9)` frees the last
   reference, at game time ~14 s, before the measured window starts (As built 4).
5. **`rss-bounded` fails on every leg, root-caused to `receiver.gd`'s live-mode `_data` buffer**
   (memory rs-g6s-live-data-unbounded-growth): every incoming byte is appended and never trimmed
   except on reconnect, because records are resolved by absolute offset into it. `received.rs2`'s
   file size matched the measured RSS delta almost exactly, and the growth rate dropped from
   ~1.1-1.2 MB/s to ~40-45 KB/s exactly at the step-11 freeze. This is shared, live-mode-wide
   architecture (every gate with a live leg uses the same offset-indexed decode), not something a
   cache-budget-scoped increment should change; it is reported here as a genuine, documented
   negative result (As built 5).

### Deviations

- `RS_RECEIVER_MEMORY_BUDGET_BYTES` defaults to unlimited (`-1`, off), not the `268435456` the
  design text originally named: a literal numeric default would have turned budgets on for every
  gate's receiver, not just g6s's (As built 7).
- `soak-inline` keeps the receiver's generous default memory budget rather than Q7e's tight one
  (no fallback source for an evicted recurring hash) and so checks only the carried-growth rate,
  never eviction.
- `rss-bounded` fails on every leg (Finding 5); not relaxed, not silently passed.

### What G6s does not prove

- That the receiver's own RSS is bounded over a live connection this long (Finding 5): the
  resource-cache budgets this increment adds are themselves proven bounded (`cache-budget-
  respected` passes on every leg), but the surrounding live-mode buffer is not.
- Anything about rates, two receivers, or a constrained transport (G6c); a measurement matrix or a
  `render-stream-report/1` (G6p); the supported-feature manifest (G6z).
- Stability under a leg longer than ~370 s, or with more than one connection.

Evidence, under `artifacts/render-stream/gate6/g6s-final/g6s/`:

- `reference-step11/shots/step-11.png` is the soak-timeline reference's frozen final state.
- `<leg>/receiver/shots/seq-<n>.png` is each leg's own final shot (picked by the highest recorded
  `frame`), pixel-identical to the reference on every leg.
- `sabotage-soak-no-evict/receiver/perf.json`'s `timeline` shows `cache_bytes_memory` crossing the
  1 MiB budget and staying there; `sabotage-soak-retain-superseded/host/evidence/perf-timeline.
  jsonl` shows `host_retained` at 139 against the honest legs' 10.

## Gate 6c result (2026-10-14)

G6c ([protocol/gate6-design.md](../protocol/gate6-design.md) "G6c", Q7d; decisions in "As built
(G6c)") passes. Before G6s merged, `pnpm render-stream:gate6 -- --legs g6a,g6h,g6l,g6b,g6c` was
133/133 (`artifacts/render-stream/gate6/r1/`): g6c's 41 checks over 13 legs plus the 92 earlier
gate-6 checks. Gates −1 (29/29), 0 (24/24), 1 (66/66) and 2 (85/85) passed on that build.

After merging G6s (main `f4720922`), on the final build:

- Gates −1 (29/29), 0 (24/24), 1 (66/66) and 2 (85/85) passed again.
- `self-test-gate6` passed 217/217 and `self-test-report` 46/46.
- `--legs g6a,g6h,g6l,g6b,g6s,g6c` was 147/150 (`artifacts/render-stream/gate6/r2/`). Every g6a,
  g6h, g6l, g6b and g6s check passed.
- The three failures were g6c timing checks, run while another agent's gate 6 shared the machine
  (load average 5.0). On mismatch-60-recv30 the host frame-interval p95 was 19.9 ms against the
  baseline's 17.4 ms. mismatch-15-recv60's receiver drew 56.9 frames/s. On dual-60-15, A's hold p95
  was 23.4 ms against a contended rate-uncapped-host60's 32.3 ms. In the same run, that receiver
  drew 49.9 frames/s and its host p95 was 20.3 ms.
- The g6c rerun (`--legs g6c`, `artifacts/render-stream/gate6/r2-g6c/`) passed all 41 g6c checks;
  the other groups were not run, as reported.

The table below is r1. The rerun matched it: rate-60 57.8/s, rate-uncapped-host60 57.7, uncapped
121.6, mismatch-60-recv30 28.8 against a 30.0 receiver, dual 51.2/11.6 (both credit-limited),
constrained 5.0, recv-delay `injected-delay`, gpu-heavy `gpu-limited`, host p95 17 357–17 360 µs.

**Supported, measured on this box** (Ryzen 5 5500, RTX 2060, gamescope 3.16.19 headless; rate
timeline, `realtime`, animate, hook log off, window [6 s, 26 s] of game time = 19.0 s between
timeline lines; rates per second, host clock; `presented` unavailable on every leg):

| Leg | Requested | Host frame | Published | Applied | Submitted | Receiver frame | Credit capacity | limited_by |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| rate-baseline | — (no subscriber) | 60.0 | — | — | — | — | — | — |
| rate-15 | 15 | 60.0 | 15.0 | 15.0 | 15.0 | 60.0 | 56.3 | (target) |
| rate-30 | 30 | 60.0 | 30.0 | 30.0 | 30.0 | 60.0 | 58.2 | (target) |
| rate-60 | 60 | 60.0 | 58.3 | 58.3 | 58.3 | 60.0 | 58.3 | host-frame |
| rate-uncapped-host60 | uncapped | 60.0 | 58.8 | 58.8 | 58.8 | 60.0 | 58.8 | host-frame |
| rate-uncapped | uncapped, `--max-fps 0` | 24 047 | 137.0 | 137.0 | 137.0 | 137.8 | 137.0 | credit |
| mismatch-60-recv30 | 60 | 60.0 | 26.7 | 26.7 | 26.7 | 30.0 | 26.7 | credit |
| mismatch-15-recv60 | 15 | 60.0 | 15.0 | 15.0 | 15.0 | 60.0 | 29.1 | (target) |
| dual-60-15 A / B | uncapped | 60.0 | 59.1 / 13.2 | 59.1 / 13.2 | 59.1 / 13.2 | 60.0 / 15.0 | 59.1 / 13.2 | host-frame / credit |
| recv-delay | 60 | 60.0 | 17.1 | 17.1 | 17.1 | 20.4 | 17.1 | credit |
| constrained | 60 | 60.0 | 4.95 | 4.9 | 4.9 | 60.0 | 5.0 | transport |
| sabotage-constrained-ignore-credit | 60 | 60.0 | 34.6 | 15.3 | 15.3 | 60.0 | 5.9 | transport |
| gpu-heavy (HD native) | 60 | 60.0 | 1.95 | 1.9 | 1.9 | 19.0 | 2.0 | credit |

Credit RTT median / p95 (µs): rate-60 14 982 / 27 152, rate-uncapped-host60 14 388 / 26 493,
rate-uncapped 6 939 / 8 170, mismatch-60-recv30 32 235 / 62 254, dual A 9 318 / 21 582 and B
55 853 / 122 579, recv-delay 42 638 / 94 725, constrained 175 948 / 296 425. Host frame callback
p50: 87 µs idle, 289 µs at 60/s, 27 µs at `--max-fps 0` (snapshot 19 µs, nearly nothing changes
between two 41 µs frames), 637 µs on gate6-hd. Host frame-interval p95: 17 357–17 360 µs on every
leg and the baseline. Every `host-unperturbed` holds. Wire: 19.6 KB median transaction, 1.17 MB/s at
60/s, 1.93 MB/s at 137/s.

- **Mismatch.** At target 60 behind a 30 fps receiver: 632 credit-blocked ticks in the window,
  `coalesced` 944, oldest pending 333 ms. The receiver loses frames to its own frame-quantized
  fetches (published/receiver frame 0.89), and the credit capacity accounts for exactly that.
- **Separation.** recv-delay (`--frame-delay 40`): receiver frame interval p50 49.1 ms, GPU render
  p50 0.38 ms, CPU render p50 0.35 ms: `injected-delay`. gpu-heavy (`iterations` 6510, calibrated in
  two rounds, `rates/gpu-heavy-calibration/calibration.json`): frame interval p50 49.3 ms, GPU p50
  40.8 ms (0.83), CPU render p50 1.65 ms: `gpu-limited`.
- **Constrained** (`throttle-proxy.ts constrained`): credit RTT p50 176 ms (≥ 60 ms), `max_pending`
  1, `max_in_flight` 1, `max_queued_bytes` 94 802 (largest message 94 792); the proxy's
  server-to-client latency mean was 40.8 ms (30 ms floor). The sabotage (ignore-credit from frame
  900, inline payloads, quit at 75 s) failed exactly `pending-bounded` (1 123 in flight) and
  `queue-bounded` (594 924 B queued). It classified `delivery-violation`, and its final shot was
  0 px.
- **final-latest-state**: every receiver's final shot (`RS_RECEIVER_SHOT_FINAL`) named a frame
  after step 11's and was 0 px from its reference (the fixture rendered with the host's own step-11
  leftovers, `RS_FIXTURE_FREEZE_STATE`).
- **Reports**: 13 single-repeat `render-stream-report/1` files validate (`--repeats 1`). Receiver
  CPU over a 30-s rate-60 leg: 15.8 s (decode p50 2.1 ms and apply 1.5 ms per transaction).
- **Receiver RSS** (the `/proc` sampler over the window, 8–28 s after the receiver started):
  - **Before G6s (r1)**, while the live `_data` buffer grew: rate-60 grew from 197.8 to 240.1 MiB
    (+42.3, 134 MiB/min), rate-uncapped +51.6 MiB, constrained +7.2 MiB. Peaks were up to 330.6 MiB.
  - **After G6s (r2-g6c):**

    | Leg | Window growth (MiB) | Peak (MiB) |
    | --- | --- | --- |
    | constrained | +2.3 | 183.8 |
    | rate-15 | +9.8 | 197.6 |
    | gpu-heavy | +9.0 | 221.0 |
    | recv-delay | +10.9 | 198.6 |
    | rate-30 | +15.1 | 213.7 |
    | rate-uncapped | +17.4 | 215.8 |
    | rate-60 | +21.2 | 238.5 |
    | rate-uncapped-host60 | +25.5 | 235.1 |

  - Growth is no longer proportional to bytes received. What remains is warm-up while steps 1–10
    add content (atlas pages, TEXA versions, caches). The window covers 20 s and ends inside the
    timeline, so it cannot show the plateau.
  - G6s's 300-s soak in the same r2 run shows the plateau: the receiver held 226.2 → 226.3 MB
    (`g6s-rss-bounded` pass).
  - Host RSS stayed 81–83 MiB on every scene leg and 87–97 MiB on gate6-hd.
- **Receiver cost unchanged**: a headless file-mode replay of the 400-transaction animate capture,
  main against this branch, two alternating rounds of five timed runs each.
  - Against `02e6f4dc`: wall time 3.47–3.85 s per run on both sides (frame-paced); decode_us mean
    6193/6479 µs (main) against 6247/6212 µs (branch); apply_us 885/898 against 897/878.
  - Against `f4720922`, with G6s and under another agent's load: decode 7435/9508 µs against
    7648/7231 µs; apply 984/1223 against 1003/1008.
  - The branch adds one integer store per applied transaction, plus per-frame work only under
    `RS_RECEIVER_PERF_OUT`.

**Findings** (gate6-design.md "As built (G6c)" 2–4, 7). These are not proven, or they are
proven false:

- At 60 published against a 60 fps receiver, 60 per second depends on the phase of two
  independent 60 Hz loops. With one transaction in flight and a host that sends only at frame
  callbacks, a credit RTT just over one frame halves the rate. That happened on 5 of 11 dev and
  final 60/60 legs (28.7–29.95/s, mean RTT 2.04–2.09 host frames), and the host stays prompt (every
  check holds against the credit capacity). Lifting it needs credit window 2 or a receiver that
  acks closer to the draw: gate 7.
- A slow receiver publishes below its frame rate because each HTTP fetch costs it a whole frame
  (B at 15 fps: 0.73–0.88 of its frames).
- Over HTTP, ignore-credit on a slow link fails the receiver (`resource-unavailable`, a 404): D7's
  pin relies on credit.
- G6t's proxy applied no backpressure and dropped its backlog on close (fixed here).

**What G6c does not prove**: presentation rate (unavailable, D9); five-repeat stability or cold
against warm (G6p); any rate on a non-loopback network or a second machine (gate 8); the
constrained leg's numbers for a link other than 4 Mbit/s and 30 ms.
## Gate 6p result (2026-10-15)

G6p ([protocol/gate6-design.md](../protocol/gate6-design.md) "G6p", Q7g) passes: the measurement
matrix, D15's deltas analysis and a validated `render-stream-report/1` over all 20 Q7g scenarios.
`pnpm render-stream:gate6 -- --legs g6p` is **6/6 on g6p's own checks** (`clean-exit`,
`after-window-shots`, `deltas-input`, `report-valid`, `report-complete`, `repeat-stability`),
`artifacts/render-stream/gate6/g6p-r1/`. The overall gate exit is non-zero only because `g6p` is
not in the default `--legs` set (by design: the matrix takes about 80 minutes, so a plain
`pnpm render-stream:gate6` stays fast) and the other six groups therefore report `not-run` in a
`--legs g6p`-only invocation -- the same convention G6c's own standalone rerun used (README "Gate
6c result"). Measured on a quiet machine (load average 0.69/1.02/1.13 just before the run started,
no other Godot or gamescope process on the box; Ryzen 5 5500, RTX 2060, gamescope 3.16.19
headless), one warmup plus five repeats per scenario, about 80 minutes end to end.

**Files**: `scripts/lib/gate6p-legs.sh` (the matrix driver: `g6p_run_unarmed`, `g6p_run_armed_idle`,
`g6p_run_scenario`, all reusing `lib/gate6c-legs.sh`'s host/receiver/proxy/reference helpers on the
same `rate` timeline G6c measures) and `scripts/lib/gate6p-checks.ts` (the 20-scenario registry,
`unarmedRepeatOf` for the `unarmed` arm's bespoke mostly-`unavailable` repeat, and `runGate6p`,
which writes `report-gate6.ts build`'s own run-set directory layout and calls `buildReport`/
`validate` unchanged). `scripts/sample-rate.ts` is new: the `unarmed` arm loads no capture
extension at all, so it has none of the other arms' `perf-timeline.jsonl`, and its host frame rate
comes instead from a least-squares slope of `RS_FIXTURE_STEP_LOG`'s wall-clock-timestamped step
lines (D6's realtime pacing makes one game second one wall-clock second here). `run-gate6.sh`
gains a `DEFAULT_GROUPS` array distinct from `LANDED_GROUPS`: `g6p` is landed (selectable via
`--legs`) but excluded from the implicit default run, mirroring the contract's "excluded from
default `--legs`" instruction. `gate6c-checks.ts` gained `export` on eight already-pure helpers
(`dist`, `rate`, `exactDist`, `memoryOf`, `cpuOf`, `slopePerMin`, `gamescopeVersion`, `gitInfo`,
`parseJsonl`) so `gate6p-checks.ts` could reuse them verbatim instead of duplicating them --
no behaviour change, confirmed by self-test-gate6c's existing cases still passing unmodified.

### The matrix

Nine `gate6-scene` scenarios (`unarmed`, `armed-idle`, `streaming` at 15/30/60/uncapped-host60/
uncapped, a cold-cache repeat of 60, a `GRC_HOOK_LOG=on` repeat of 60), the same eight on
`gate6-hd` native (no hook-log pair), `gate6-hd` half streaming at 60 (warm), and `constrained`
plus `dual-60-15` on `gate6-scene` -- 20 in all, each one discarded warmup plus five measured
repeats. `unarmed`'s two scenarios load no extension; `armed-idle`'s two are G6c's own
`rate-baseline` shape (armed, listening, no subscriber). Warm cache (the default) points every
repeat's receiver at one shared cache directory the warmup fills; cold gives every repeat
(warmup included) its own fresh, never-reused cache directory.

### Headline costs

**Capture and publication overhead**, from `cpu.host_process_s` (cumulative host CPU over the
fixture's fixed ~30 s `rate`-timeline lifetime, so every arm of one fixture is directly
comparable without needing `unarmed`'s missing frame-interval distribution):

| Fixture | unarmed | armed-idle | capture overhead | streaming-60 | publish overhead |
| --- | --- | --- | --- | --- | --- |
| gate6-scene (640x360) | 0.58 s | 1.04 s | +0.46 s/30 s (≈256 µs/host frame) | 1.27 s | +0.23 s/30 s (≈128 µs/frame) |
| gate6-hd native (1920x1080) | 1.38 s | 4.00 s | +2.62 s/30 s (≈1456 µs/frame) | 4.11 s | +0.11 s/30 s (≈61 µs/frame) |

The hook-log pair (`scene-rate-60-hooklog`, `GRC_HOOK_LOG=on`, against `scene-rate-60`'s `off`):
1.66 s against 1.27 s -- **+0.39 s/30 s, ≈217 µs/host frame** for the hook log's own cost on this
fixture, the same order of magnitude as the capture and publish overheads above.

**Bytes per published transaction** (`bytes.transaction` median): gate6-scene ≈ 19.5-19.9 KB;
gate6-hd, native and half alike, ≈ 173.7 KB. Presentation scale does not move it -- the wire
payload is driven by scene content (textures, meshes), not by the pixel count the host renders at.

**Maximum sustained published rate.** gate6-hd native's published rate lands at **≈13.0-13.3/s
on every one of rate-15, rate-30, rate-60, rate-uncapped-host60 and rate-uncapped** -- the request
stops mattering once the receiver cannot keep up. The receiver's own `recv_decode_us` + `recv_apply_us`
medians there are ≈19-20 ms + 13-16 ms ≈ 33-35 ms per transaction, which alone caps throughput near
30/s before credit RTT (submitted median 61-72 ms) tightens it further to the observed ≈13/s.
gate6-hd half reaches ≈16.0/s (credit RTT ≈52 ms) -- a smaller receiver-side raster cost than
native, consistent with less GPU work at half resolution on the same wire content. gate6-scene's
ceiling is far higher: uncapped-both-ends reached **105.7/s** (credit RTT median 9.0 ms, host frame
rate ≈22 200/s -- nothing on the host side is the limit). At the capped target 60, gate6-scene
split across repeats the same way G6c's own rate-60 did ("As built (G6c)" 2): `scene-rate-60`
landed in the bad credit-RTT phase (published 30.05/s, median credit RTT 18.1 ms, ≈ two host
frames), `scene-rate-60-cold` landed in the good phase (58.84/s) on the very same configuration.
This is the known credit-window-1 / 60 Hz phase effect, now reproduced independently in G6p's own
data, not a new finding.

**Cold vs warm startup.** Every warm-cache repeat (the default) fetched nothing over HTTP in its
measured window -- `scene-rate-60` and `hd-native-rate-60` both show `bytes.fetches: 0`,
`bytes.http_bytes: 0` on every one of their five repeats, confirming the shared warmup cache is
doing its job. The cold-cache repeats of 60 re-fetch from nothing every time: `scene-rate-60-cold`
128 fetches / 1 525 360 bytes per repeat (≈11.9 KB/fetch), `hd-native-rate-60-cold` 932 fetches /
5 256 316 bytes (≈5.6 KB/fetch, many more, smaller atlas-page fetches on the larger fixture).

**Receiver apply/upload/GPU cost** (`recv_decode_us`/`recv_apply_us`/`recv_gpu_render_ms`
medians; upload is reported `unavailable` everywhere -- "combined with apply_us in the receiver",
`gate6c-checks.ts repeatOf`): gate6-scene ≈ 1.9-2.3 ms decode, 1.3-1.6 ms apply, 0.26-0.37 ms GPU;
gate6-hd (native and half) ≈ 16-20 ms decode, 13-15.6 ms apply, 1.6-2.0 ms GPU -- an 8-10x jump
tracking the ≈9x bytes-per-transaction increase, consistent with decode/apply being dominated by
texture copy and hashing over the payload rather than a fixed per-transaction cost.

**Memory.** Host RSS stays small and mostly flat across every scenario (84-101 MB, slope 0.3-11
MB/min over the 20 s window). Receiver RSS grows faster (gate6-scene ≈17-78 MB/min, gate6-hd
≈85-102 MB/min) -- every repeat starts a brand-new receiver process with an empty in-memory cache
that fills from the local disk cache (warm) or the network (cold) during the measured window, so
this is first-fill growth, not a soak leak; G6s's 300 s soak (README "G6s live-buffer fix") is the
one that measures leak-shaped growth.

### D15: deltas and parameter bytes (`scripts/analyze-deltas.ts`, from `scene-rate-60-hooklog`'s
### `resources.jsonl`)

| Kind | resources | version-creating ops | superseded versions | superseded payload bytes | delta bytes total | whole-version bytes available |
| --- | --- | --- | --- | --- | --- | --- |
| image (texture) | 8 | 51 | 2 | 147 681 | 2 614 287 | no |
| mesh | 1 | 1 675 | 2 | 0 | 214 016 | no (g6t-report-tooling-facts: no whole-buffer byte size in the hook log) |
| shader | 3 | 8 | 2 | 0 | 1 158 | no |
| material | 2 | 436 | 13 | 0 | 0 | no (param-only, no payload) |

`param_bytes_per_frame`: 419 frames, 429 elements total, mean **1.02 elements/frame** -- on this
fixture's content, parameters change barely at all frame to frame, so a parameter-delta
optimization would save little here specifically (the candidate still stands on gate 5.5's own
material findings for scenes with more active parameter animation). Every `savings_bytes` is
`null`: the hook log never carries a byte size that would let a whole-version baseline be computed
for any of these kinds (texture lines here came back `whole_version_bytes_available: false` too,
on this particular hook log), so `analyze-deltas.ts` reports the real numbers it has rather than
estimating one it does not, exactly as G6t built it.

### Stability

`repeat-stability` never fails on a high CoV by design -- it only fails if a scenario is missing
its aggregate block. On this run it named **162 metrics above 10% CoV** across the 20 scenarios,
concentrated in small-integer-count and bursty fields that are expected to be noisy over only five
repeats: `bytes.fetches`/`bytes.http_bytes` (0 on every warm repeat, so any cold-adjacent reading
swings the CoV to 200%+), `cpu.host_io_thread_s`, `queues.max_pending_age_us`, and
`stages.recv_fetch_us.p50` on scenarios with few or no fetches. Densely-sampled fields
(`rates.published.value`, `stages.recv_decode_us.p50`, `stages.recv_apply_us.p50`,
`memory.*_rss_start/end`) stayed well under 10% everywhere they were measured. The full per-metric
list is in `render-stream-report.json`'s `scenarios[].aggregate`, not reproduced here.

### What G6p does not prove

Per-leg pass/fail semantics (G6a-G6c's own `leg-class-*`/`rate-achieved`/etc. checks do that; G6p
only measures cost, it does not re-judge correctness). A true mesh whole-version byte baseline
(g6t-report-tooling-facts, unchanged). Stability over minutes (G6s's soak, not a 20 s window).
Rates or costs on a non-loopback network beyond `constrained`'s one throttle-proxy profile (gate
8). `recv_gpu_render_ms`'s classification depends on `isRenderedDesktopGlReceiver`'s provenance
heuristic (render-stream-report.ts header note 2), unchanged here. The `unarmed` arm's host frame
rate is a wall-clock slope over ≈9 s of step lines (game time 6-15 s), not a 20 s windowed
distribution like every other arm's -- a cruder but honestly-labelled measurement (D11 gives it no
extension to measure with).

## Gate 6z result (2026-10-15)

G6z ([protocol/gate6-design.md](../protocol/gate6-design.md) "G6z", Q8) closes gate 6: the committed,
generated, checked supported-feature manifest. `scripts/make-features.ts` builds
[protocol/features/render-stream-6.json](../protocol/features/render-stream-6.json) (schema
`render-stream-features/1`) from two sources -- the render-stream/6 wire lists `capture/src/
rs_publish.cpp`'s `gate2_features()` actually emits (copied in literally, with a line-range
citation, and cross-checked against the hand-maintained map so the two cannot drift apart
silently) and `scripts/lib/feature-evidence.ts`'s editorial content (status, reason, owner, notes
and evidence per entry). Four checks in `scripts/lib/gate6z-checks.ts` (group `g6z`, which runs
last against whichever earlier groups' recordings this run produced -- no capture of its own).

`pnpm render-stream:gate6 -- --legs g6a,g6h,g6b,g6l,g6s,g6c,g6z` is **154/154**
(`artifacts/render-stream/gate6/20261015T050313Z/`; load average 3.78/3.46/3.21 just before the
run started -- other agents' short benchmarks, paused for this run per the orchestrator -- and
0.41/1.16/1.24 just after). Gate 5 (`g5b,g5c,g5d,g5e,g5f,g5g`) is 116/116 and gate 5.5
(`g55b,g55c,g55d,g55e,g55f`) is 130/130 on the same build
(`artifacts/render-stream/gate5/20261015T073315Z/`, `artifacts/render-stream/gate55/
20261015T074834Z/`); gates −1, 0, 1 and 2 were last reconfirmed green on this lineage in "Gate 6c
result" (main `f4720922`/`9b125e1d`) and this increment touches no capture, receiver or fixture
code, so they were not re-run.

**The one real failure, fixed in one iteration.** The first run was 153/154: `manifest-evidence`
named four "delivery"-kind entries that cited a check id copied from gate6-design.md's prose
(`rate-achieved`, `dual-independent`, `host-unperturbed`, `cache-budget-respected`) rather than the
real, leg-suffixed id a run actually writes (`rate-achieved-rate-60`, `dual-independent-dual-60-
15`, `host-unperturbed-constrained`, `g6s-cache-budget-respected-soak-scene`). Fixed in
`feature-evidence.ts`; every other evidence entry matched a real check id on the first try (memory
`rs-g6z-manifest-check-id-suffix`). Re-running just `check-gate6.ts --out <the same run dir>`
(g6z has no capture of its own, so no need to redo the ~70-minute capture) confirmed the fix:
154/154.

**The four checks, this run:**

| Check | Result |
| --- | --- |
| `manifest-check` | pass -- `make-features.ts --check` regenerates the committed JSON byte-for-byte |
| `manifest-matches-session` | pass -- 4 sessions checked (`scene/capture`, `scene/capture-inline`, `animate/capture`, `hd/capture-native`), all matched the manifest's `ops`/`item_state`/`canvas_state`/`resources` lists exactly |
| `manifest-evidence` | pass -- every `supported` entry's gate-6-cited check appears as `pass` in this run's own report |
| `manifest-refused` | pass -- every reason `refused/capture` and `snap/capture` produced on the wire (`canvas-light`, `canvas-follow-viewport`, `unsupported-op`, `unsupported-material`, `snap-2d`) is a `typed-unsupported` manifest entry |

## Gate 6 summary

Gate 6 ([protocol/gate6-design.md](../protocol/gate6-design.md), "What gate 6 proves") is complete:
twelve increments (G6a, G6w, G6k, G6r, G6t, G6h, G6b, G6l, G6s, G6c, G6p, G6z), one commit each on
`main`:

| Increment | Commit | Subject |
| --- | --- | --- |
| G6a | `7ff9cd77` | test(render-stream): add gate 6a combined scene and its file legs |
| G6w | `b85fd28c` | feat(render-stream): add render-stream/6 codecs and golden-6 |
| G6k | `ea3e9954` | feat(render-stream): add calibrator 9 CanvasLayer hooks and hook log |
| G6r | `aa181ac6` | feat(render-stream): add live rate control and perf instrumentation |
| G6t | `ca027eed` | feat(render-stream): add gate 6 report, proxy, sampler and deltas tools |
| G6h | `fd247708` | test(render-stream): add gate 6h HD canvas_items fixture and its legs |
| G6b | `02e6f4dc` | feat(render-stream): switch capture and receivers to render-stream/6 |
| G6l | `d0df9b8e` | test(render-stream): add gate 6l live motion, stall, reconnect and warm |
| G6s | `f4720922` | feat(render-stream): add receiver cache budgets, eviction and soak gate |
| G6c | `9b125e1d` | test(render-stream): add gate 6c rates, mismatch, dual and transport |
| G6p | `de39ff81` | test(render-stream): add gate 6p measurement matrix and report |
| G6z | *(this commit)* | test(render-stream): add gate 6 feature manifest and summary |

(`91eba6b6`, "docs(render-stream): add the gate 6 design contract", is the contract itself, not an
increment.)

### Run directories and images, per group

| Group | Run directory | Reference/receiver images |
| --- | --- | --- |
| g6a | `artifacts/render-stream/gate6/20261015T050313Z/scene/` | `reference*/shots/step-*.png`, `receiver*/shots/seq-*.png` |
| g6h | `.../hd/` | `reference-native*/shots/`, `reference-half*/shots/`, `receiver-native*/shots/` |
| g6b | `.../hd/` (half captures), `.../snap/` | `receiver-half*/shots/`, presentation-hazard diff images under `hd/sabotage-receiver-ignore-presentation/` |
| g6l | `.../live/` | `reference-live-frames/shots/`, `live-*/receiver/shots/` |
| g6s | `.../g6s/` | `reference-step11/shots/step-11.png`, `<leg>/receiver/shots/seq-*.png` |
| g6c | `.../rates/` | `<leg>/reference/shots/`, `<leg>/receiver/shots/` |
| g6p | `artifacts/render-stream/gate6/20261015T061914Z/matrix/` | one shot after each repeat's measured window |
| g6z | (reads the above; writes nothing of its own) | — |

### Per-leg classes

Every g6a and g6h leg classifies `success` since G6b (the HUD `CanvasLayer` travels with its
stacking); the four g6a host sabotages classify `pixel-mismatch` at their predicted region sets
except `perturb-shader`, which classifies `success` (both fixture shaders are builtin, never
re-coded after frame 1); the two g6a receiver sabotages (`ignore-clip`, `stale-texture`) and the
two g6b receiver sabotages (`ignore-canvas-stacking`, `ignore-presentation`) classify
`pixel-mismatch` at their predicted sets; `refused` classifies `unsupported` with exactly
`canvas-light`, `canvas-follow-viewport`, `unsupported-op` (the multimesh and LCD commands) and
`unsupported-material` (the TIME shader). Every g6l live leg classifies `success` except
`sabotage-live-stale-coalesce` (`pixel-mismatch` at the stale-coalesce region set). Every g6s soak
leg classifies `success`; both g6s sabotages classify `success` too (G6s's checks judge residency
bounds, not pixel class) but fail exactly their predicted `residency-bounded` metric. Every g6c
rate/mismatch/separation/constrained leg classifies `success` except
`sabotage-constrained-ignore-credit`, which classifies `delivery-violation` and fails exactly
`pending-bounded` and `queue-bounded`. Full detail, per leg, is each group's own "Gate 6* result"
section above.

### Budgets, per region (Q6g)

- **Receiver against reference**: 0 in every pixel of every shot, whole frame, on every honest leg
  of every group -- reconfirmed this run (`reference-repeat budget: max delta 0 over 3 456 000
  pixel-shots` on gate6-scene; `max delta 0` over 31 104 000 / 7 776 000 / 31 104 000 pixel-shots on
  gate6-hd native/half/armed-native).
- **Reference against the hand model**: `exact` regions 0; `delta1` regions (antialiased
  `StyleBoxFlat` panels, scrollbars and buttons, off the 0.2 colour grid and translucent) max
  channel delta 1, 80 388 pixels on gate6-scene (gate6-design.md "As built (G6a)" 10); `undecided`
  regions (text glyphs, LineEdit content, the HUD label) are compared only receiver against
  reference, never against the hand model.
- No budget was ever relaxed to make a leg pass; every mismatch not already a predicted sabotage
  set was explained from source and folded into the model (each group's "As built" / "Findings").

### Supported-feature manifest

[`protocol/features/render-stream-6.json`](../protocol/features/render-stream-6.json), schema
`render-stream-features/1`: **115 entries** -- 60 `supported`, 20 `typed-unsupported`, 30
`unobserved`, 5 `declared-unverified` -- generated by `scripts/make-features.ts`, checked by
`--check` against a hand-maintained evidence map (`scripts/lib/feature-evidence.ts`) and, every
gate 6 run, against the real wire (`manifest-matches-session`) and the real refusal reasons
(`manifest-refused`).

**Supported** (60; one evidence entry each, at minimum): all 15 render-stream/4+ draw ops
(`add_rect`, `add_circle`, `add_mesh`, `add_set_transform`, ...); all 18 item-state fields
(`transform`, `material`, `instance_params`, `visibility_layer`, ...); all 3 canvas-state fields
(`layer`, `modulate`, `transform` -- CanvasLayer stacking, gate6-design.md D3); 5 resource kinds
(`texture_2d`, `mesh`, `shader`, `material`, `texture_2d_placeholder`); the three shader delivery
policies (`source`/`params`/`exclude`) and their `shader-withheld`/`shader-excluded` typed outcomes
on the receiver; presentation declaration and snap-to-pixel declaration (viewport); and six
higher-level control/delivery/text/payload capabilities: ScrollContainer offset, ProgressBar
per-frame fill, LineEdit focus/selection/caret, AnimationPlayer/Tween deterministic sampling,
reference repeatability, StyleBoxFlat antialiasing under stretch, publication rate control with
coalescing, multiple live connections, constrained transport, receiver resource budgets, the
content-addressed store/HTTP/inline delivery mechanism, and payload size/format limits.

**Typed-unsupported** (20, reason and owner each):

| Reason | Fires on | Owner |
| --- | --- | --- |
| `unsupported-op` | `canvas_item_add_animation_slice`, `_lcd_texture_rect_region`, `_multimesh`, `_particles` | post-gate-6 capabilities (shader TIME/particles/multimesh/LCD text), unscheduled |
| `unsupported-state` | `canvas_item_attach_skeleton` | unscheduled (gate5-design.md Deferred: skeletons, skinning) |
| `canvas-light` | `canvas_light_attach_to_canvas` | post-gate-6 capabilities (Light2D), unscheduled |
| `canvas-repeat` | `canvas_set_item_mirroring`, `canvas_set_item_repeat` | gate 8 (follow_viewport layers and parallax repeat census) |
| `canvas-follow-viewport` | `canvas_set_parent` | gate 8 (same census) |
| `canvas-texture-headless` | the `canvas_texture` resource kind | gate 8 (headless CanvasTexture shim) |
| `unsupported-material`, `unknown-material`, `unknown-shader`, `param-type`, `param-range` | an item's effective material/shader/instance parameter | post-gate-6 (shader TIME) or unscheduled |
| `degenerate-host-size` | `root_size_policy: observe` | gate 8 (STS2's host size policy) |
| `non-root-viewport` | any call on a non-root Viewport | gate 8 (census, typed since gate 0) |
| `presentation-mismatch`, `oversampling-mismatch` | a receiver at a different presentation size/oversampling | gate 7 (several presentation sizes, size negotiation) |
| `snap-2d` | snap-to-pixel settings declared but not replayed | gate 8 (snap-to-pixel replay census) |

**Unobserved** (30) and **declared-unverified** (5): mostly hooked RenderingServer slots no
committed fixture ever calls (`global_shader_parameter_*`, `material_set_next_pass`,
`canvas_set_disable_scale`, the two snap-to-pixel runtime setters, ...), plus whole capabilities
gate 6 does not implement at all (non-loopback serving, presentation timing, payload deltas, late-
join adoption, browser receivers, arm-on-subscribe, Light2D rendering, Windows/macOS) and five wire
enum values no committed fixture exercises (`canvas-stacking-tie`, `global-canvas-transform`,
`stretch.mode: viewport`, `stretch.aspect` other than `keep`, `stretch.scale_mode: integer`). Full
list and owners: the manifest file itself.

### Measured costs

From G6p's regenerated `render-stream-report/1` (2026-10-15; see "G6p report regenerated" above
for the full agreement-and-drift comparison against the original run),
`artifacts/render-stream/gate6/20261015T061914Z/render-stream-report.json` (20 scenarios, one
warmup plus five repeats each):

- **Capture and publication overhead** (`cpu.host_process_s`, cumulative over the fixed ~30 s
  `rate`-timeline lifetime): gate6-scene unarmed 0.56 s, armed-idle 1.02 s (capture overhead
  +0.46 s/30 s), streaming-60 1.24 s (publish overhead +0.22 s/30 s); gate6-hd native unarmed
  1.15 s, armed-idle 2.76 s (+1.61 s/30 s), streaming-60 3.51 s (+0.75 s/30 s).
- **Bytes per published transaction** (median): gate6-scene 19 744 B; gate6-hd (native and half
  alike) 173 715 B -- driven by scene content, not presentation pixel count.
- **Maximum sustained published rate and its limit**: gate6-hd native lands at 15.0-15.7/s on every
  one of rate-15 through rate-uncapped (`limited_by` the receiver's own decode+apply+credit-RTT
  budget, not the request); gate6-hd half reaches 15.9/s; gate6-scene's ceiling is far higher,
  136.0/s uncapped-both-ends (`limited_by credit`, 9 ms RTT -- nothing on the host side is the
  limit).
- **Cold against warm**: every warm-cache repeat fetches nothing (`bytes.fetches: 0`); cold repeats
  refetch everything (gate6-scene 128 fetches / 1.53 MB; gate6-hd native 949 fetches / 5.26 MB).
- **Receiver apply, upload and GPU cost** (median): gate6-scene ≈2.0 ms decode, 1.3 ms apply,
  0.37 ms GPU; gate6-hd (native/half) ≈16.1-16.2 ms decode, 12.9-13.0 ms apply, 1.8-2.5 ms GPU --
  an 8-10x jump tracking the ≈9x bytes-per-transaction increase.
- **Staleness and stability**: `repeat-stability` flags any metric above 10% CoV without failing
  the gate (by design); every densely-sampled field (published rate, decode/apply medians, RSS
  start/end) stays well under 10% everywhere it is measured, and the flagged ones are exactly the
  small-integer-count or bursty fields expected to be noisy over five repeats (zero-or-few fetch
  counts, I/O-thread CPU).
- **D15 optimizations** (`scripts/analyze-deltas.ts`, from `scene-rate-60-hooklog`): image textures
  8 resources / 51 version-creating ops / 2 superseded / 147 681 B superseded payload / 2 614 287 B
  delta bytes total; mesh 1/1676/2/0 B/214 144 B; shader 3/8/2/0 B/1 158 B; material 2/436/13/0 B/0
  B; every `savings_bytes` is `null` because the hook log never carries a whole-version byte size to
  diff against (memory `g6t-report-tooling-facts`) -- these are the real numbers available, not a
  fabricated estimate. `param_bytes_per_frame`: 419 frames, 429 elements, mean 1.02/frame -- little
  to save on this fixture's content specifically.

### What gate 6 does not prove

- Several presentation sizes or receiver-advertised size negotiation for one capture session
  (gate 7); the typed `presentation-mismatch`/`oversampling-mismatch` hazard is measured, not
  fixed.
- Compressed or float texture payloads, non-loopback serving, late-join adoption of anything
  (items, canvases, textures, meshes, materials, shaders), or the target game's own host-size
  policy (all gate 8).
- Browser receivers of any kind, or presentation timing for them (gate 7) or for native (no engine
  hook exists).
- Payload deltas, atlas/mesh-region deltas, parameter deltas, hash-at-publish, lazy hashing,
  spill-to-disk or parallel fetches -- measured offline (D15, above), not implemented.
- Shader `TIME`, screen texture, `CanvasGroup`/clip-children, `Light2D` rendering, GPU/CPU
  particles, multimesh, global shader uniforms, RichTextLabel effects, `TextEdit`/IME, or
  Windows/macOS hosts -- every one is typed or deferred with an owner (the manifest and "Deferred,
  with owners" in gate6-design.md).
- Stability over a connection longer than G6s's ~370 s soak, or with more than the two connections
  G6c measured.
- Rates or costs on a real (non-loopback) network, or with more than one machine.
- `recv_gpu_render_ms`'s classification depends on a provenance heuristic
  (`isRenderedDesktopGlReceiver`), unchanged since G6c.

### Next bounded capability

Gate 7: browser receivers (web export and the GSW canvas receiver), with their own pacing,
suspension, startup and memory gates and their own `render-stream-features/2` manifests, measured
against gate 6's fixtures, expectations and `render-stream-report/1` as the conformance and cost
baseline (gate7-design.md, already under way in parallel on several of this repository's disjoint
files per its D23). The first gate-8-bound items gate 6 leaves fully specified but unimplemented
are late-join adoption and compressed texture formats.
