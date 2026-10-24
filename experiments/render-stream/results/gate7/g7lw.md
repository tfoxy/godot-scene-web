## Gate 7 G7lw result (2026-10-24)

G7lw closes the open defect "live g7-2 on web/rust fails `live-vs-reference` under contention"
(G8f's report). The pixel numbers were never the failure. The real failure is a checker model gap:
under load, at credit window 2, the receiver folds the sabotaged transaction into the next one.
The fix is a fold-exact failure-seq model in the checker. The receivers are unchanged.

### The reported symptom was the exact view

The numbers G8f quoted (252/61/512/512 px, off-by-one channels in two 32×32 texture regions at
steps 4 and 6–11) come from gate 2's own checker run on the web legs:
`live-web-gate2-result.json`, the `live-vs-reference` row. That view compares exactly, and those
diffs are there in every web run:

- **What the regions are:** `SB` at (376,40), the LA8 4×4 `B` at scale 8. At step 4 it is LINEAR
  (root filter), and from step 7 it is an RGBA8 alpha .4 blend. The other region is `S2` at
  (120,240): item LINEAR after step 6's `A.update`. These are web vs native readback/delta1
  differences, Q7's band (see memory `g7b-web-export-facts`).
- **Same pixels as a passing run:** this increment's loaded live shots are byte-identical to G7z's
  passing run (`artifacts/render-stream/gate7/g7z/live/web-g7-2/`). That holds for all 12 steps,
  and the references are identical too.
- **The gate 7 verdict reads the band view:** G7z reports `live-vs-reference@web` passed, with the
  detail "band (Q7 readback/delta1, 49 shots substituted) … | exact: live step 4 … 252 px differ".
- **What actually failed in G8f's run:** its validate summary
  (`artifacts/render-stream/gate8/g8f/live-web-validate-summary.json`) failed one check only:
  `leg-class-sabotage-wrong-hash-live@web` ("receiver failure at seq 624, expected seq 623").
- **Smoke runs:** `live-vs-reference@web` also prints the exact detail whenever the banded verdict
  fails. In smoke that always happens, because live-warm and the other legs have no checkpoints.
  The tier verdict excuses that row (`skipped_by_tier`), so the smoke failure G8f saw at b32b9d51
  was the known `warm-host-no-gets@web`.

### Cause

At credit window 2, a slow poll (CPU contention) delivers two transactions in one receiver poll.
`receiver.gd` `_apply_newest` folds them into one apply (G7q). `_mark_coalesced` records
`coalesced_into` on the older one, so a fetch made for it, or a failure while applying, is
attributed to the apply. When the folded transaction is the first one naming the sabotaged
payload, the receiver fails at the next seq.

Three checks wanted exactly one seq and ignored the fold:
- gate2c's `leg-class-sabotage-drop-resource` and `leg-class-sabotage-wrong-hash-live`
  (`failure.seq === <first naming A1>`);
- gate2e's `no-cors-withheld` (seq 1).

This is the gap memory `g7-2-fold-seq-model-archive` describes, and the reason `smoke-map.json`
gives for keeping g7-2 off hosted runners.

**The receiver output is legal.** All 17 folded failures observed (below) share these properties:
- the two transactions have the same `received_process_frame`, so they arrived in one poll;
- the older one carries `coalesced_into` = the failing seq;
- the one GET of the sabotaged hash (404 for drop-resource, a 200 that fails `verified` for
  wrong-hash, the withheld seq-1 payload for no-cors) is logged at the failing seq;
- the failure reason is the expected one.

That is the G7q fold contract ("any check that ties a seq to a shot, fetch or failure must go
through the apply that seq was folded into"). `fetch-before-applied` already reads it through
`appliedAs`.

### Fix

- **`gate2c-checks.ts` `failureSeqs(txs, want)`:** returns `[want]`, or `[want, as]` when the
  receiver's own applied.json says `want` was folded into `as` (via `appliedAs`). The fold must be
  logged, and nothing else is accepted.
- **Checks that use it:**
  - `runG2c`'s drop-resource / wrong-hash-live leg check;
  - `gate2e-checks.ts` `checkNoCors`, which now also reads the applied transactions.
- **Self-tests:** `self-test-gate2.ts` has 4 new scenarios, `sabotage-{drop-resource,wrong-hash-live}-folded`
  (logged fold: passes) and `…-folded-unlogged` (the same seq shift without `coalesced_into`:
  fails). Result: 454/454.
- **No-cors:** no fixture covers it (the leg is browser-only, G2E_V7_LEGS). It was judged directly
  on the real evidence below.

### Repro statistics

Synthetic load: 12 `nice 0` bash busy loops on the 12-CPU host, killed by pid. Plain
`run-gate7.sh --live --legs g7-2 --receiver web --web-core rust` with fast frames (240) at
window 2, load average 15–30 (other agents' load included). Each run was judged twice on the same
evidence: by main's checker (bc709e08) and by this one.

| Runs | Legs | Main's checker | This checker |
| --- | --- | --- | --- |
| `full-load12-a` | full g7-2 (all legs) | fails `leg-class-sabotage-wrong-hash-live` (454 vs 453) | gate_passed=true |
| `sab-1`…`sab-8` | capture, reference, live, drop-resource, wrong-hash-live (no-cors hit the trap below) | 8 of 8 fail (10 folded failures) | 8 of 8 pass these checks |
| `cors-1`…`cors-5` | the same + origin-refused, so no-cors ran properly | 4 of 5 fail (6 folded failures, including `no-cors-withheld` folded 1→2 twice) | 5 of 5 pass |

Before the fix, 13 of 14 loaded runs failed; after it, 0 of 14 failed. Every other failing row in
the smoke-legged runs names a leg the run skipped.

### What ran

- `self-test-gate2.ts`: 454/454.
- The loaded repro runs above, with the evidence in `artifacts/render-stream/gate7/g7lw/`.
- **Full tier,** from a clean worktree: `remote-validate.sh --tier full --and-local`. Plan: pure,
  native-rust-gate2, g7-gsw, g7-web-rust and g7live-gsw / g7live-web-rust, with sabotage legs, all
  for g7-2.
  - Remote run 40078614353: 4 of 4 pass.
  - Local: `g7live-gsw` rc 0 (565 s) and `g7live-web-rust` rc 0 (495 s), both full g7-2, at
    load 2–6.
- **GSW:** in the gsw run, its sabotage folds landed with the failing seq as the newest, so main's
  checker passes there too.
- `tsc -p experiments/render-stream`: only the 5 known `gate2b-checks.ts` errors.
- **Synthetic load windows** (12 busy loops, other agents' timing could be skewed): 04:18–04:21,
  04:22–04:33, 04:45–05:13 and 05:16–05:32 (-03, 2026-10-24).

### Time

- **Implementation:** about 45 min (setup builds, diagnosis from the evidence, the checker fix and
  its self-tests).
- **Validation:** about 1 h 25 min (the 14 loaded repro runs and their re-judging, the gate 2
  self-test, the full tier).

### Out of scope

- **Moving g7-2 to hosted runners:** its refusal reason (folds at window 2) is what this fixes, but
  lifting the refusal needs a remote determinism run. That is a follow-up.
- **The 2026-10-22 flake's other symptoms** (missed shots at steps 7–9, resource traffic at
  step 10 in live-warm): not seen in any of these runs.

### Trap found

A smoke run with a custom `RS_SMOKE_LEGS` that names `sabotage-no-cors` but not `origin-refused`
fails no-cors with `live-connect-failed` (403). The cause is run-gate2.sh: it sets `GATE7_PAGE_PORT`
before the skipped origin-refused launch, and only a real launch resets it, so no-cors inherits the
non-allowed page origin. The default smoke legs never hit it. It is left alone, because `lib/legs.sh`
reaches every gate.
