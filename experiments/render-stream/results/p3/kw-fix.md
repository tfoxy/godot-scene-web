# KW-FIX: g8ku live probe waits for the host's pin

## Cause (confirmed by reading the code path, then by the fix)

`run_g8ku_live` (`scripts/run-gate8.sh`) GETs the first `.ktx2` as soon as the file sink stores it.
Since HC1 the host snapshots and pins only once `Hub::has_viewer()` is true, so a GET that races
ahead of the late receiver's hello finds nothing pinned and gets 404. Capture is correct (a viewer
that said hello gets its resources); the probe was wrong. It failed on main 3111688e and in remote
run 40727924253.

## Fix

`run-gate8.sh`, `run_g8ku_live` probe subshell: before the curl, wait (up to 20 s) for a `"pin"`
line naming the hash in `host/evidence/resources.jsonl`.

## Verdicts

- Before: `native-rust-gate8` `ktx2-wire` fails (404), on main locally and remotely (see hc2.md).
- After: `validate-increment.sh --only native-rust-gate8` (smoke tier, sabotage legs run because
  the runner is in the diff), run 20261028T182320Z: rc=0, the whole native gate 8 passes,
  `ktx2-wire` included.
- Scope: the diff is one gate 8 runner script; the plan's other runs (g7 g7-8) are not reached
  by the change and were not run; no remote full tier.
