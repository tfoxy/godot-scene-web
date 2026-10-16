## G5f flake fix (2026-10-11)

`--legs g5c,g5f` failed intermittently, most often `receiver-vs-reference` on
`sabotage-mesh-stale-coalesce` ("640 px differ in DF", a different step each run), sometimes
`warm-host-no-gets` or `pins-bounded`/`obsolete-retired` at frame 851. The receiver was never
wrong. All three checks assumed every host frame reaches the wire.

**Mechanism.** Under CPU load the 60 Hz credit loop phase-locks to every other frame: the
submitted-stage ack lands just after the next frame callback, so the hub coalesces every other
frame (`coalesced` reaches ~270-390 instead of 0-11; memory rs-g55d-rs5-switch-facts). From there,
three things go wrong:

- `GRC_SABOTAGE=stale-coalesce` (armed at frame 360) rewrites *every* coalesced send to carry the
  first missed target, not only the stall's recovery. Each such send is labelled `sent.stale_from`
  in `tap/live-1.jsonl` (24-173 per loaded run). A settle shot on one of them shows a one-frame-old
  DF. It is not `benign`, because the wire is not equal to the full recording at the shot's own
  frame. In every failing shot of every run we have (5 pre-fix runs from other worktrees, plus
  `artifacts/render-stream/gate5/base-load1/`, which reproduced the failure on the first loaded
  run), the tap's state equals the host's full recording at `stale_from` exactly, and DF is the
  only region that differs.
- Each leg's wire carries a different subset of DF's per-frame surfaces. `live-mesh-warm` can
  therefore skip surfaces `live-mesh` fetched (27 hits vs 38) or name one it never fetched (one
  legitimate GET).
- When the quit frame 851 is a pending frame, the last send's DF surface stays pinned as the base
  through 851's callback. The end and close come after that, but `baseAt` treated the connection
  as closed from 851 on.

**Fix (checkers only, no runner, receiver or capture change).**

- `lib/gate5f-checks.ts`: each checkpoint now records `stale_from` (from the host's live log) and
  `stale_exact`: the only mismatching pixels are in DF, and the tap's state at the shot's frame
  equals the full recording at `stale_from`. `receiver-vs-reference` accepts `stale_exact` only on
  the sabotage leg; on a good leg a stale send is still a failure.
- `warm-host-no-gets` is now judged against the warm leg's own tap (`warmCacheReport`):
  - cache hits must equal the payloads its wire named that `live-mesh` fetched;
  - fetches and GETs are allowed only for payloads its wire named that `live-mesh` never fetched.
- `pins-bounded`/`obsolete-retired` use `connTimelinesAtCallback`: a connection whose close line
  follows its close frame's callback line counts as open through that callback.
- The `benign` DF-only test also became stricter: every mismatching pixel must lie inside DF.
- `lib/gate55f-checks.ts` had the same `receiver-vs-reference` weakness: its sabotage leg sends 4-13
  stale sends outside the stall, though none had yet landed on a shot. It gets the same
  `stale_from`/`stale_exact` rule for PH. Its warm and pin checks are not exposed, because PH is a
  parameter, not a served payload.

**Proof.**

- Five consecutive `--legs g5c,g5f` runs under load (the run plus 4 busy-loop burners, all pinned
  to cores 8-11 with `taskset`), `artifacts/render-stream/gate5/fix-load{1..5}/`: each is 34/38,
  with the 4 non-passing checks being the `not-run` groups g5b/d/e/g. Every leg classifies as
  predicted (sabotage `pixel-mismatch`, `stale-coalesce` exact in DF,Marker,RM). 1-5 sabotage
  shots per run were judged `stale_exact`.
- main's checker, re-run on the same five evidence directories, fails all five
  (`receiver-vs-reference` 4/5, `pins-bounded`+`obsolete-retired` 3/5).
- Re-checking the 12 earlier gate 5 run directories on this machine (including the other agents'
  failing ones) gives 15/15 g5f checks each. Re-checking 4 gate55 runs gives 15/15 each.
- Negative controls on real evidence (a copy of fix-load1, tampered):
  - a 4x4 wrong block in RM on a `stale_exact` shot fails ("not stale_exact ... DF,RM");
  - removing that send's `stale_from` label fails (640 px in DF).
- `test/self-test-gate5f.ts` (new) and `test/self-test-gate55f.ts` section 9 cover each tolerance
  with a failing counterpart: a stale shot on a good leg, a wire not equal to full at `stale_from`,
  a fetch of a cached hash, a hit-count mismatch, an unmatched GET, and a close before the
  callback.
- `--legs g55e,g55f` under the same load (`artifacts/render-stream/gate55/g55-load1/`): 67/69,
  with the 2 non-passing checks being the `not-run` groups g55b/g55d. Two sabotage shots (steps 5
  and 9, 2688 px in PH) were judged `stale_exact`. main's gate55f checker fails
  `receiver-vs-reference` on that same evidence, so G55f really did share the flake.
- After merging main at 7ff9cd77 (G6a), both runs were repeated under the same load and gave the
  same result: `gate5/merged-load1/` 34/38 (1 `stale_exact` shot) and `gate55/merged-g55-load1/`
  67/69 (3 `stale_exact` shots), only `not-run` groups failing.

**Still not proved** (unchanged from the `benign` rule): DF's own pixels at an off-frame or stale
shot. reference-live has no shot at that frame, so a receiver that drew DF wrongly but everything
else right would pass there. It would fail at every on-frame shot.

