## Gate 7 G7rf result (2026-10-23)

G7rf ends the resync wait on a folded full in both receivers. G7w2c's "Gap 1" left `resync-full`
failing at credit window 2 because of a receiver bug; this fixes it.

### Cause

With RS_RECEIVER_RESYNC the receiver refuses one transaction unapplied and waits for the forced
full. At window 2 the full and the next patch can reach it in one poll and fold into one apply.
`refuseForResync` (GSW `live.ts`) and `_refuse_for_resync` (`receiver.gd`) test only the newest
transaction of the fold (the patch) for the awaited full, so the fold was refused as a whole, a
second resync went out and the host answered with a third full: "3 full transactions, expected 2",
and on web a cascade (seqs 611-616, five resyncs, four fulls).

### Fix

The decision lives in the glue (rs-core is untouched): a fold that contains the awaited full ends
the wait before the refusal test.

- GSW: `live.ts` `takeQueued` calls `endWaitOnFoldedFull` (window 2 only) before
  `refuseForResync`. It uses the pure `fold.ts` `foldedFullIndex`; the entries before the full are
  marked `skipped: "resync"` without a resync message (the host already has one outstanding) and
  leave the fold, the full and the later ones apply with the newest, and the rebuild runs (the
  wasm state holds every accepted delta).
- Native /7 and web export: `receiver.gd` `_end_wait_on_folded_full`, called from `_apply_newest`
  and from the fold-after-fetch path before `_refuse_for_resync`, with the same rule.
- Unchanged: `gate1-g1d-checks.ts` and every sabotage. A newest that is itself the full still goes
  through the old path.

Self-tests: `scripts/test/self-test-gate7rf.ts` (6 checks: full + patch, patch/full/patch, full in
the middle, newest is the full, no full, empty fold; added to `pure-shard-weights.json`) and
`receiver/tests/receiver_selftest.gd` `_check_folded_full` (39 checks in all).

### Live g7-1 repeats

`run-gate7.sh --live --legs g7-1 --receiver <kind>` (full, 11 legs, fast frames):

| Receiver | Window 2 | Window 1 |
| --- | --- | --- |
| gsw | 5 of 5 `resync-full` pass, no other failing check | 1 of 1 |
| web/rust | 5 of 5 | 1 of 1 |

(`gate_passed` reads false because g1b is not-run in a `--legs g1a,g1c,g1d` run; no check failed.)

### What ran

- Remote full tier (run 39962751814): 14 of 15 runs pass; `cargo-gsw-rs` rc 101 is the known failure.
  Live g7-1 was refused remotely (see below), the rest of the plan ran.
- Remote determinism, `--determinism 3,1`, live g7-1 on both receivers (run 39982714414), with the
  g7-1 refusal lifted for the dispatch: web-rust agreed over 4 runs (519/519 shots, 37/37 dumps);
  gsw disagreed on 2 of 519 shots. One runner's `live-resync` leg shot no step 2 (before the
  resync, so not this fix; every check passed): its step-2 image and diff were absent. g7-1
  therefore stays refused remotely; the entry's reason in `smoke-map.json` and
  `docs/remote-compute.md` are updated.
- Local, real time, one run at a time: `g7live-gsw-timing` rc 0, `g7live-native-timing` rc 0,
  native gate 2 rc 0. `g7live-web-rust-timing` failed once with exactly two rows,
  `rate-achieved-phase-60-r1@web` ("no connection was streaming through the window") and
  `phase-classified-phase-60-r1@web` ("no credit round trip inside the window"), at a load average
  of 8 to 9 from other agents' builds; rerun once at load 2 to 4, it passed (rc 0). Neither row
  touches the resync path (`_end_wait_on_folded_full` returns at once without RS_RECEIVER_RESYNC).
  Unavailable device rows (real-suspension) are the typed `unavailable` kind.
- Local smoke: pure rc 0; native gates -1, 0, 1, 3 rc 0 (gate 2 killed once by my own `pkill`, rerun
  rc 0); `cargo-gsw-rs` rc 101 (known). g7 / g7live g7-1 smoke runs: all rc 0.

### Out of scope

Native gate 6, `g7x` and `lock-tests` (deferred to the pre-release delta sweep: no rs-core change);
g7-2 stays refused (needs the fold-seq model).

### Time

Implementation about 40 min (two receivers, helper, self-tests); validation the rest, mostly lock
waits behind G7kr's exclusive gate 6 legs and the serial local smoke tier.
