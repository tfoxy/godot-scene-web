# GTS: the GSW receiver survives a /11 live-coding resync

## The bug
W11t's `coding` resync makes the decoder skip every based transaction until the next full one, so
that full arrives with a seq gap. W11d added rs-core `Validator::transport_skip()` and the native and
web-export receivers call it before sending `resync`; GSW's `codingResync` did not, so a GSW coding
resync failed `seq-gap` on the next full.

## The fix
- `web/gsw-rs/src/lib.rs`: `GswRs::transport_skip()` forwards to the validator.
- `web/gsw-receiver/live.ts` `codingResync`: calls `g.transport_skip()` before sending `resync`
  (the same point as receiver.gd `_applier.transport_skip()`).
- No other state needed: the fresh applier from `live_rebuild` walks the validator's resolved state
  (the full), and the validator prunes C to names(S) after the full (W11d decision 1), so the
  retention state agrees; GSW's payloads are content-addressed and stay.
- Wire unchanged (receiver-only).

## The leg and check
- New gate 8 group `g8w11c` (run-gate8.sh `run_g8w11c`, not in the default group list: g8w11 already
  runs the native half): the two coding resync legs alone, under `g8w11c/`:
  `native-sabotage-drop-base` (`drop-message` @120) and `native-sabotage-wrong-prefix`
  (`coding-wrong-prefix` @120), one coded receiver each. Under `GATE7_LIVE_KIND` lib/legs.sh routes
  the live receiver launch to the browser, so g7-8's live half (`run-gate7.sh --live --legs g7-8`,
  `g8l,g8w11c`) runs them in GSW (and the web export).
- Checks: the existing `native-coding-drop-base-caught` (now a shared `resyncCheck` in
  `lib/gate8-w11-native-checks.ts`, same criterion on the native g8w11 leg and on the browser's) plus
  the new `native-coding-wrong-prefix-caught`: status ok, at least one coding resync, every received
  message is in the host's tap in order. Judged `@gsw` in gate 7.
- Also fixed: the g7-8 live smoke leg list lacked `g8ku/import`, which `run_g8l` needs (smoke died
  at `cat g8ku/import/.../exit-code.txt`); added to smoke-map.json.

## Before / after (g7-8 live, `--receiver gsw`, smoke legs)
| | `native-coding-drop-base-caught@gsw` | applied.json |
|---|---|---|
| before (fix removed, same tree) | FAIL `replay-failure: seq-gap record at offset 13435145: seq 80, expected 78` | 77 txs, 1 resync |
| after | PASS `resyncs 1` | status ok, 336 txs, 1 resync |
| after, wrong-prefix leg | PASS `resyncs 1` (`native-coding-wrong-prefix-caught@gsw`) | |

Evidence: `artifacts/render-stream/p3/gts/` (before/after applied.json and the check lines).

## Validation
Implementation ~1 h; validation ~2 h wall (mostly waiting on the machine lock and runners).

- Smoke / iteration: `run-gate7.sh --live --legs g7-8 --receiver gsw` and `--receiver web --web-core rust`
  with RS_SMOKE_LEGS (g8l/tex plus both g8w11c legs): `native-coding-drop-base-caught@{gsw,web}` and
  `native-coding-wrong-prefix-caught@{gsw,web}` pass. `pure` smoke: self-test-gate8z failed once on
  the missing `GROUP_COVERAGE_8` decision for g8w11c (fixed in feature-evidence-8.ts; 43/43 after).
- Full tier, remote (run 40636808644): pure, cargo-gsw-rs, native-rust-gate8 (the refactored native
  `native-coding-drop-base-caught` holds), g7-gsw, g7-web-rust, g7live-gsw pass. g7live-web-rust failed only
  the two new checks on the web export: its canvas was 640x360 where the capture-scale session is
  1920x1080 (`viewport-mismatch`). Fixed by passing `--resolution 1920x1080` to the g8w11c receiver
  launch. Re-run remote (run 40644389228, `--only g7live-gsw,g7live-web-rust`): 2/2 pass.
- Refused locally (g7-1 of the live runs, `validate-increment.sh --tier full --only g7live-gsw,g7live-web-rust`):
  g7live-gsw rc=0 (all five groups). g7live-web-rust: g7-1 all pass; its g7-2 `live-vs-reference@web`
  failed under a heavily loaded machine (lock wait 3137 s) and passed on the remote run; g7-8 failed
  there only because that local run began before the resolution fix.
- Skipped: timing runs (milestone sweep), native/capture/wire (untouched), device legs.

