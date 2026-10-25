# GRT6: gate 8 on hosted runners, and the Trim artifact hang (2026-10-25)

Tooling, not a gate. The pre-release delta sweep runs mostly remotely, and two things blocked it:
remote `native-rust-gate8` failed (even on unchanged main), and gate 8 / g7-8 jobs hung in the
workflow's "Trim artifact" step (a cancel then loses the job logs).

## Problem 2: the Trim hang

`.github/workflows/remote-validate.yml`, step "Trim artifact", read each run's `stdout.log` and
`provenance.json` with Python's `glob.glob(".../**/stdout.log", recursive=True)`. `glob` follows
directory symlinks. A gate 8 run dir holds links into itself (the job's own `symlinks-*.txt`
artifact, run 40151175187):

```
run/g8kp/gsw-run/sources/gate8 -> run                    (a link to the run dir's own root)
run/g8ku-web/sources/gate8     -> run/g8ku
run/g8kp-web/sources/gate8     -> run/g8kp
run/g8kp/gsw-run/gsw-bundle    -> run/g8kp/gsw-bundle
run/g8ku-web/web-bundle        -> <checkout>/artifacts/render-stream/web-receiver/<id>/bundle
```

The first link makes the walk re-enter the whole tree up to the kernel's 40-link limit, so it is
exponential in the number of directories. G8ku's earlier 2 h hang was the same family. Gate 8 and
g7-8 jobs reach it because their legs build the GSW and web-export source trees (`sources/gate8`).

Fix: an `os.walk(followlinks=False)` walker that also skips linked directories and linked files; a
`timeout-minutes: 10` on the step; `symlinks-<label>.txt` in the artifact (`find -P` over the run
dir, under `timeout 60`). `scripts/test-remote-validate.sh` pins it (116 checks): the workflow has no
recursive glob and has the timeout, and the walker extracted from the workflow terminates on a tree
with a link back to its own root, finds the one real file and none through links. (The old form is
asserted to double-count on that tree, so the test means something.) The test file's four stale
refuse.groups expectations (g7-2 went remote in GRT5) were refreshed.

## Problem 1: remote native-rust-gate8

The tier verdict listed only two failing checks at G8kb2-era snapshots (runs 40135033784,
40138195722, 40139405185): `transcode-oracle` and `delivery-live`. `decode-cost` and
`worker-hook-time` show as `fail` in the raw `result.json` only because their timing legs are
skipped remotely; the verdict already excuses them (`skipped_remote_groups: ["decode-cost"]`,
`skipped_by_tier`). Nothing to change there.

On main 12c704b1 (G8kf) three further failures appeared, found one at a time, each with its own cause:

1. **`delivery-live` / `transcode-oracle` (live): a harness race.** The g8ku live receiver ran
   with the default `RS_RECEIVER_VARIANT_POLICY=keep`, under which it uploads a uastc variant only
   if the first snapshot naming the texture already lists it. The variants come from the host's
   encode pool (about 1.4 s of CPU on 2 workers), the receiver is a second Godot starting beside it.
   On the dev box the encodes win; on a 4-vCPU runner the receiver joined first on every run of
   the last dispatch (3 of 3: host built 7 variants, `http_gets=11`, the receiver fetched only the
   decoded payloads, 64 RS calls, 0 uastc uploads). Two earlier runs passed it (2 and 2 uploads), so
   it is a margin, not a switch. Fix: the live receiver runs `upgrade`, as the g8l basis live leg
   already did, so it takes the variant whenever it lands (6 of 6 locally, was 5).
2. **`delivery-pending`: a check bug, not a receiver bug.** Texture 1 (800x6, the engine's own
   frame-1 texture) is named by no item. Whether it is still `delivery-pending` in transaction 1
   depends on the capture's first-frame speed: locally it is already `ok` then (so never checked),
   on a runner it is pending until seq 8, and the check demanded an upload for every texture that
   was ever pending. A receiver uploads only textures an item names. Reproduced locally by
   replaying the runner's `recording.rs9` (downloaded as failing evidence) against the local store:
   `texture 1 never uploaded`; an instrumented `Planner::apply` showed `tex_count[1] == 0` and
   `tex_cands` without 1 in every transaction. Fix: the check requires an upload only for pending
   textures some item command names. No receiver change.
3. **`--determinism 2,1` disagreement** (run 40153318460, all three runs passing their own
   checks): the seq-8 shot and applied.json of `g8ku/pending` and `g8ku-web/web-pending`, and the
   applied.json of `g8l/basis/replay`. All three replay recordings whose content follows wall-clock
   timing on the capturing machine (250 ms worker jobs against the frame rate; the live host's lazy
   variants landing at whichever seq the encode finishes). Two local runs differ too (variant
   patch at seq 53 vs 57). Fix: `TIMED_RECORDING_LEG` in `lib/remote-determinism.ts` lists those
   applied.json files (and the pending legs' shots) as live-timed, not compared; the checker still
   holds each run to its own exact pixel and upload checks. The self-test pins both the exemption and
   that the same difference in `g8ku/receiver` still disagrees.

Failing-run evidence now carries the small per-leg files (`evidence/<label>/legs/`), which is what
made 1 and 2 diagnosable from one failed dispatch.

## Dispatches

All on the same snapshot lineage (main 12c704b1 plus this diff), `--tier full --only native-rust-gate8`
unless stated; sabotage legs ran (a runner file is in the diff).

| Run | What | Result |
| --- | --- | --- |
| 40139405185 (main 06c453ce, before) | baseline | fail: `transcode-oracle`, `delivery-live` |
| 40150148181 | trim fix + leg files | fail: `delivery-pending` only; Trim step instant |
| 40151175187 | + recordings in the evidence | same; `symlinks-*.txt` shows the cycle |
| 40153318460 `--determinism 2,1` | + pending check fix | 3/3 pass; DISAGREES 150/152 shots, 116/119 dumps (the timed legs) |
| 40154939352 `--determinism 2,1` | + timed legs exempt | `delivery-live` fails 3/3 (keep-policy race); determinism AGREES 148/148 shots, 116/116 dumps over 3 runs (all AMD EPYC 7763) |
| 40156476992 `--determinism 2,1` | + live receiver `upgrade` | 3/3 pass; DISAGREES 132/148, 104/116: the three runners were AMD EPYC 9V45 (x2) and Intel Xeon 8573C |
| 40158766044 `--determinism 2,1` | + CPU models in the report | 3/3 pass; the same 132/148, 104/116 with the same two CPU models |
| 40157713785 g7-8 (`g7-gsw`, `g7-web-rust`, `g7live-gsw`, `g7live-web-rust`) | no hang | 4/4 pass (360, 424, 208, 169 s); every Trim step 0 s |

**What the determinism rows mean.** The runs that landed on one CPU family agree on every shot and
dump. The two that included the Intel Xeon 8573C disagree on exactly the same 16 shots and 12
dump files, and the disagreeing shots include the plain Godot `reference/step-0.png` that no
receiver touches, so it looks like llvmpipe's output following the CPU (the Xeon lists avx512_fp16; the AMD
parts do not; not isolated further), not a gate 8 nondeterminism. Each run's own checks pass against its own reference,
so a gate 8 verdict stands on any runner. `--determinism` now records every job's CPU model
(`cpu_models` in determinism.json, a "runner CPUs" line in the wrapper) and says so when a
disagreement spans CPU vendors. A clean cross-runner agreement needs a dispatch whose jobs share a
CPU family; the earlier gate 7 agreement runs (12 and 3 runs) were AMD-only too, which is why this
had not shown.

An accident to record: while waiting for the g7-8 dispatch I looked up "the latest run" with
`gh run list --limit 1` and cancelled another agent's run (40157872013, branch `remote-run/g8kwh-...`).
Always select by this worktree's own run id or `--branch`. The other agent re-dispatches.


## Not done / remaining exclusion

- `decode-cost` and `worker-hook-time` stay local (timing groups), as before.
- No remote exclusion was added to `smoke-map.json`: the live-leg difference between llvmpipe and
  NVIDIA was a leg race, not a renderer property.
- The G8kb2-era failure of `delivery-live` was not re-run on its own commit; it has the same
  signature as cause 1 (0 uastc uploads at the default `keep`), and the fix was verified at G8kf.
