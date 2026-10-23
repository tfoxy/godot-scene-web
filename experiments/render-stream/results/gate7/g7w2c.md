# G7w2c: window-2 checker gaps and the window-1 `g7-r` supplementary runs

Base 23b0e212 (G8a), checker-only diff, no product code. Time: about 1 h implementation (reading,
three fixes, self-tests), about 3 h 20 min validation (almost all of it lock wait behind G7kh's
exclusive timing legs, and the full self-test and native smoke runs).

## Gap 1: `resync-full` at window 2 is a receiver bug, not a model gap (left failing)

The host is right. A third full is the host answering a *second* resync request, and the receiver
sent it. Evidence, from the sweep's failing gsw run (`gate7/sweep-pre-g7z/g71/gsw-w2-r1`, receiver
`applied.json`): seq 653 refused (the injected resync), seq 654 the forced full, seq 655 a patch
on it, both received in one poll. 654 shows `coalesced_into`, 655 is `skipped: "resync"`, and the
receiver log reads "refused seq 655 ... ignoring patches until a full transaction", then "full
transaction seq 656 arrived". The host summary says `resyncs: 2, full: 3`.

The cause is the fold. When the full and the next patch reach the receiver in one apply, only the
newest (the patch) is tested for the awaited full (`web/gsw-receiver/live.ts` `refuseForResync`;
`receiver/receiver.gd` `_apply_newest` / `_refuse_for_resync`), so the pair is refused and a second
resync goes out. f0de33d6's message already names this for receiver.gd. It is worse on the web
receiver than the sweep's 3/3 suggested: `supp/g71-web-w2-r2` refused seqs 611, 612, 613 (a full),
614, 615 (a full), 616: five resyncs, four fulls ("host sent 4 full transactions"), a cascade, each
forced full folded with the patch behind it.

No model change: the expected set (two fulls, one counted resync) is still the protocol's, and
widening it would accept the bug. The check keeps failing it, and the sabotage
(`resyncNoFull`, in-flight mutations) is unchanged. The fix belongs in the receivers: in a fold,
test every folded entry for the awaited full (a full anywhere in the fold ends the wait; the
entries before it are the refused ones, the ones after it apply). Owner: the next receiver
increment; it reaches both browser receivers and receiver.gd, so it is not a checker commit.
The evidence tap for the sweep's failing run was pruned, so the re-judge used `applied.json`
and the live summary, which carry the seqs, `coalesced_into` and the counters.

Fresh runs, g7-1 live at window 2 (fast frames, `RS_FAST_FRAMES=all`), `resync-full`:
gsw 3/3 pass this time (the sweep: 2/3), web/rust 2/3 pass (the sweep: 3/3).

## Gap 2: `live-acks-staged` on `live-reconnect` (fixed)

`lib/gate2c-checks.ts checkLiveAcksStaged` allowed a receiver that closes first one send it never
read (`sent - n <= 1`). At window w the host may have up to w unread sends in flight. The bound is
now the granted window (`deliveryReport(c.host).window`, the hello's `credit_window_granted`).
G8t's failing run (`gate8/g8t/validate/g8t-live-full/g7live-web-rust`) read "662 sent, 660 read"
and its receiver log says window 2: 662 - 660 = 2 <= 2, so it passes now (the tap was pruned; the
check line and the log are the evidence). Self-test (`self-test-gate2.ts`, 416/416): window-1 host
with 2 unread fails, window 2 with 2 unread passes (new pass-scenario helper), window 2 with 3
unread fails; the message names the window.

## Gap 3: g7-55 `native-legs@web` "no stall recovery evidence" (cause clear, fixed)

`g55fStallReport` (and g5f's copy) took the first post-stall shot's step as the window that
*contains* the recovery frame, and null when it falls in a gap. The stall is 2000 ms wall clock
(`RS_RECEIVER_STALL=1:2000`); it starts at frame 367 and step 3's window starts at 487, so the
recovery frame is 487 plus the host's frame-rate margin. Across all retained evidence (1500+
stall legs) the recovery frame is 488 at the earliest, 489 in the mode: a margin of one or two
frames. A runner a few percent slower than 60 frames/s recovers at 480-486, in the 7-frame gap,
and `checkShaderFetchesLatestOnly` (and the stale-coalesce check) fail with "no stall recovery
evidence". The hosted runners' 2 of 3 failures on G8a's branch and 0 of 2 on main are consistent
with that. The failing runs' stall evidence was pruned, so this is the model, not a re-judge.

Fix: `postStallStepOf` (gate1-g1d-checks.ts) returns the window holding the recovery frame or, in a
gap, the next window: the first shot after the recovery is what the check wants. Both g55f and g5f
use it. Self-test (`self-test-gate55f.ts`): recovery at 489, 487, 484, 480 gives step 3, 479 gives
step 2, and `expected_missed_steps` for 484 is [2]. Before the fix 484 and 480 were null.

## What ran

- `self-test-gate2.ts` 416/416 (the three new scenarios), `self-test-gate55f.ts` pass.
- `validate-increment.sh --tier smoke` (6 changed paths, reach everything, sabotage legs run):
  pure, native gate 1, 2, 5, 55 pass; g7-web-rust smoke pass; g7live gsw and web/rust g7-1 smoke
  pass; g7-gsw smoke fails only `sabotage-ignore-z@gsw` ("shot seq-8 missing"): the check is not
  skipped-by-tier in a smoke run that leaves that leg out, so it reads missing evidence. Not caused
  by this diff (a smoke-map gap).
- `scripts/remote-validate.sh --tier full --and-local` (run
  [39943896631](https://github.com/tfoxy/godot-scene-web/actions/runs/39943896631)): every job
  passed (pure 6/6, native gates 1/2/5/55, g7-gsw and g7-web-rust g7-1/2/5/55 file groups, live g7-5
  and g7-55 on gsw and web/rust) except `g7live-web-rust@g7-5`, which hung 80 min on the runner (it
  takes 2 min) and was cancelled; the rerun
  ([39955167439](https://github.com/tfoxy/godot-scene-web/actions/runs/39955167439)) passed g7-5 and
  g7-55. The local half (`g7live-gsw` and `g7live-web-rust`, groups g7-1 and g7-2, full, with
  sabotage legs, window 2) passed 2/2, including gate 2's `live-reconnect` on web.
- g7-1 live, plain `run-gate7.sh --legs g7-1 --live` with fast frames:

  | Receiver | Window | Runs | Result |
  | --- | --- | --- | --- |
  | gsw | 2 | 3 | 3/3 pass (38 PASS) |
  | web (rust) | 2 | 3 | 2/3: r2 `resync-full@web` (gap 1) |
  | gsw | 1 | 1 | pass (38 PASS) |
  | web (rust) | 1 | 1 | pass (39 PASS) |

- Not run: the timing phase except the two `g7-r` runs below; the other full-tier runs
  (`g7-5`/`g7-55` local groups were covered by the remote half).

## Window-1 `g7-r` supplementary runs

Real time, one at a time, load under 4 (the lock serialised them behind G7kh's exclusive legs).
`run-gate7.sh --live --legs g7-r --credit-window 1`, at 23b0e212 plus this diff (the diff touches
nothing `g7-r` reads):

| Receiver | Result |
| --- | --- |
| gsw | `gate_passed=true`, 61 PASS, 0 FAIL (dual-native, `sabotage-ack-on-receipt`, phase legs; good phases 58.2-59.1/s) |
| web (rust) | `gate_passed=true`, 81 PASS, 0 FAIL (including the late-poll legs) |

Recorded as an addendum in [sweep-pre-g7z.md](../sweep-pre-g7z.md). Evidence:
`artifacts/render-stream/gate7/g7w2c/`.

## Traps

- `resync-full` at window 2 is a receiver bug on both browser receivers; do not widen the model.
- A smoke run of g7-gsw reports `sabotage-ignore-z@gsw` failed (it is not skipped by tier).
- A hosted-runner job can hang (g7live-web-rust@g7-5, 80 min); cancel and rerun with
  `remote-validate.sh --tier full --only g7live-web-rust`.
