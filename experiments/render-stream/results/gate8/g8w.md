## Gate 8w result (2026-10-23)

G8w ([protocol/gate8-design.md](../../protocol/gate8-design.md) "G8w") passes: render-stream/8 is
implemented as a protocol-version switch on the same modules /3 to /7 extended (memory
g4e1-rs3-version-switch-pattern), with its own document
([protocol/render-stream-8.md](../../protocol/render-stream-8.md), "As built (G8w)") and
`protocol/golden-8/`. **/8 is opt-in and /7 stays the default**: every /2 to /7 byte is unchanged.

### What /8 adds (Q6, nothing more)

- magic `GRS8`, `render-stream/8`, subprotocol `render-stream.8`;
- session keys `adoption` (always present at /8, after `unknown_item_policy`/`sabotage`) and
  `resources.decode` (after `auth`);
- `origin: "created" | "adopted"` in the texture, mesh, shader and material tables;
  `adopted_content` (texture, mesh) right after `origin`; `source_format` (texture) right after
  `format`;
- the eight float payload formats, sized by D9's table (decoders size them at /8 only);
- seven sabotage kinds, refused below /8 by both decoders and by the capture without a /8 sink;
- new validator codes `adoption-entry` and `decode-entry`, in the TypeScript oracle and in rs-core.

Capture: `GRC_STREAM_VERSION=6|8` (file sinks, default 6); `GRC_ADOPT`, `GRC_TEXTURE_DECODE`, a float
format in `GRC_RESOURCE_FORMATS` and a /8 `GRC_SABOTAGE` kind are gate 8 policies: with a file sink
that is not /8 the stream refuses (`stream.status` `refused`, reason `policy-needs-v8: ...`); a
live-only stream's listener then offers `render-stream.8` alone. The listener otherwise offers
`.7, .6, .8` (`.8, .7, .6` under `GRC_STREAM_VERSION=8`). Empty seams with their call sites landed:
`rs_adopt.{h,cpp}` (called in `entry.cpp` after the root query, before the size policy) and
`rs_texture_decode.{h,cpp}` (asked by `hooks.cpp`'s texture copy under `GRC_TEXTURE_DECODE=engine`).

### Evidence that /2 to /7 are byte-identical

- `git diff main --stat -- 'experiments/render-stream/protocol/golden-[2-7]'` is empty: no file of
  golden-2 to golden-7 changed, and every `make_golden.py --check` and `self-test-rs2.ts` run
  passes (the `pure` run, 65 self-tests, rc 0 for all).
- `rs7_codec_test`, `rs6_codec_test` ... `rs2_codec_test` and `rs_live_window_test` (which pins
  the window-1 transcripts in `capture/test/golden/live-window1-transcripts.txt`) pass unchanged;
  `rs8_codec_test` also builds a /7 transaction and a /7 session from /8-shaped structs and
  checks them byte-equal to the created-defaults encodings.
- A real capture with no /8 variable set (`/tmp`-scratch `e2e.sh`, gate-0 fixture, 60 frames) writes
  a GRS6 recording that both the TypeScript oracle and `rs-core-check validate` accept, and
  `GRC_STREAM_VERSION=8` (with and without `GRC_ADOPT=arm`) writes GRS8 recordings that both
  accept; the items and canvases of the /6 and /8 captures are equal state for state.
- bench-instr on the remote runner: g3..g7 inline cases within 0.8% of baseline (all noise).

### What ran

| where | runs | result |
| ----- | ---- | ------ |
| local, no lock | `pure` (65 self-tests, golden-2..8 `--check`) | 65/65 rc 0 |
| local | `capture-build` (23 ctests: rs8_codec, rs_gate8_policy, rs_live incl. `test_v8_connection`, rs_live_window ...), `cargo-rs-core` (44 tests; `rs-core-check goldens`: golden-8 98/98), `cargo-rs-core-capi`, `cargo-decode-proto-rs` | pass |
| local smoke | `native-rust-gate-minus1`, `native-rust-gate0`, `native-rust-gate1`, `native-rust-gate2` (smoke, sabotage legs skipped by tier except as the plan says) | pass |
| local, by hand | real headless captures: default /6, `GRC_STREAM_VERSION=8`, `GRC_ADOPT=arm` (refused without /8, accepted with), `GRC_TEXTURE_DECODE=engine` and a /8 `GRC_SABOTAGE` (refused), `GRC_STREAM_VERSION=7` (invalid), and the listener's upgrade negotiation per policy | as designed |
| remote full tier | run 39896399279, key `rv-20261023T034156Z-907b733-26239`, https://github.com/tfoxy/godot-scene-web/actions/runs/39896399279 (evidence `artifacts/render-stream/remote/20261023T042815Z`): 19 of 20 runs pass: pure, capture-build, cargo-rs-core, cargo-rs-core-capi, cargo-decode-proto-rs, pnpm-test, bench-instr, native gates -1, 0, 1, 2, 3, 4, 5, 55 (full, sabotage legs run), g7-gsw and g7-web-rust (all eight groups), g7live-gsw and g7live-web-rust (g7-5, g7-55) | the 20th, `cargo-gsw-rs`, is the known failure (E0432: `canvas_items` gated behind `wasm32`), unrelated to this diff |
| local live smoke | `g7live-gsw-g7-1`, `g7live-web-rust-g7-1`, `g7live-gsw-g7-2`, `g7live-web-rust-g7-2` (the groups the remote planner refuses) | g7-1 passes on both receivers (gsw 154 s, web/rust 239 s). g7-2 smoke fails on both with exactly one failing check, `warm-host-no-gets` ("the receiver's cache mode is not warm": the smoke legs `import,capture,reference,live` never run the warm leg that check needs); every other g7-2 check passed or was skipped by tier. A full g7-2 live run was started and killed by a session restart, so g7-2 live is NOT verified locally; the diff touches no live-path behaviour for /6 or /7 (rs_live_window_test and the transcripts are unchanged) |

Local native smoke stopped after gate 2: gate 3 onward were already green in the remote full tier on
a clean runner, and the machine was shared with a milestone sweep's timing legs (gate 2 alone waited
37 minutes for the lock). That is a deviation from "smoke on every reached run locally"; nothing in
the diff is local-GPU-specific.

### Out of scope, and why

Not run: `lock-tests` (load-sensitive, refused remotely; no lock file changed), the timing phase
(`native-rust-gate6`, `g7live-*-timing`, `g7x`, the timing groups inside gates 1, 2, 5 and 55) and
the native `g7live` timing legs. Justified because /7 is byte-identical by goldens and transcripts
and /8 is opt-in: no default path of any gate reaches /8 or a new code path beyond one environment
read per variable. They run in the pre-release delta sweep (`--milestone --base`), which covers `*`
regardless. Known failures ignored: `cargo-gsw-rs` rc 101; live g7-1 `resync-full` at window 2
(`g7-1-window2` is fixing it on main).

### Deviations from the design

- **Sabotage kinds are version-gated** (the design says only "new sabotage kinds"): every earlier
  version left kinds representable at any version; /8's seven are refused below /8.
- **Key positions** were open in Q6 and are fixed in render-stream-8.md "As built (G8w)".
- **A /8-only sabotage kind counts as a gate 8 policy** for D2's refusal, so it cannot reach a
  /6 or /7 session.
- **Float formats in `GRC_RESOURCE_FORMATS`** trigger D2's refusal but are still refused by the
  format parser afterwards: the capture-side float table is G8f's.
- **`GRC_STREAM_VERSION=7` is invalid** (/7 has no file sinks, and D2 says `6|8`).
- The smoke-map rule for the seams is `exclusive` (placed before the capture rule) and maps to
  `capture-build`, `pure` and `native:gate0@*`; `entry.cpp`/`hooks.cpp` remain `*`.

### Implementation versus validation time

Writing was a few hours; validation wall time was longer and mostly lock waiting: gate 1 smoke took 896 s and gate 2 smoke 2236 s behind the milestone sweep's exclusive legs, `pure` took 598 s, and the remote full tier took about 47 minutes from dispatch to collection. Times are not itemised further.
