## Gate 7mm result (2026-10-20): `motion-monotonic` counts holds in frames and is a timing check

G7mm applies the G7uf recommendation. The bound of 2 is unchanged and the check still gates.

### What changed

1. **Holds in frames.** Each receiver records two fields per live transaction in applied.json:
   - `received_process_frame`: the receiver frame whose poll read the transaction.
   - `submitted_process_frame`: the frame of its `submitted` ack.

   Where they are written:
   - `receiver/receiver.gd` (native and the web export; the web export already had
     `submitted_process_frame`, native now writes it too);
   - `web/gsw-receiver/live.ts` + `evidence.ts` (GSW: `processFrames + 1` at receipt, the rAF
     callback that would first handle the record).

   Nothing in the frozen core's decode or apply changed. `compare-receiver-cores.ts` treats both
   as frame-clock timings, like `process_frame`.
2. **The check.** `heldOverFrame` (`lib/gate6l-checks.ts`) counts a transaction as held when it was
   submitted in a later frame than it was received in. It also counts one held for more than
   16.667 ms from receipt to `submitted`. Evidence without the frame fields has the microsecond
   rule only, so older runs judge exactly as before. The report says which rule excused each gap
   (`hold_basis`, printed as "hold judged by frames N, us M").
3. **Timing check.** The g6l legs were already in the `g6l` timing group, so they already hold the
   exclusive quiet lock. `run-gate6.sh` `g6l_motion_leg` now records `/proc/loadavg`'s 1-min figure
   at each motion leg's start (before its host launches) and end (receiver done, host still
   holding the lock), judges the leg through `scripts/g6l-motion-leg.ts` (the same `judgeMotionLeg`
   the check uses), and reruns a failed leg exactly once when either figure exceeds
   `G6L_RERUN_LOAD` (4). The failed attempt moves to `<out>/g6l-attempts/<leg>-attempt1`; gate 7's
   leg discovery skips that directory. `<leg>/attempts.json` holds both attempts and the check's
   note prints them. Applies to the five motion legs (scene, warm, stall, reconnect, sabotage), not
   the G7u lifecycle legs.

### Deviation from the decision: a frame count alone failed the first live run

The decision said to use the frame rule where the field exists. Run **web1** did, and failed:
12 gaps of 3 behind a transaction received and submitted in the same process frame. One example is
seq 98 of live-scene: received at 5 621 200 us, submitted at 5 642 000 us, 20.8 ms later, both in
process frame 264. A frame iteration that long is a slow frame, which the microsecond rule has
always excused as a receiver cause (G6l finding 2). Frame counts cannot see it. A frame-only rule
would have failed verdicts that pass today. So a hold counts if either rule says so.

The same evidence judged with the final rule: all five legs pass. Across the new runs, many
excused gaps rest on the microsecond rule alone (web2: "frames 6, us 30" in one leg), so
the frame rule is the added excuse for a deferred fetch, not the main one.

### Re-judging existing evidence (fallback must equal today's verdicts)

Tool: `g6l-motion-leg.ts`, per leg. Neither set has the new fields.

| Evidence | Legs | Result |
| --- | --- | --- |
| G7uf web, 18 runs (13 `runs/`, 5 `final/F*`) | 90 | 90 of 90 legs agree with G7uf's `mm.py` verdict (pass iff 0 unexcused gaps) |
| G7k native gate 6, `gate6-first` and `gate6-rerun` | 10 | same failing legs and first failing gaps as the recorded `result.json` (e.g. live-scene 545→548, 468→471; live-stall 322→325; live-reconnect 765→768; warm 375→378) |

The G7k host directories were pruned, so the tool also prints "no host evidence"; only the motion
problems are compared. The G7uf judgments were against the final rule; the first frame-only
version agreed on them too, because they carry no frame fields.

### Self-tests

`self-test-gate6.ts` (253 assertions, section 2 extended): a fetch deferred one frame with a 15 ms
hold passes by frames; the same 15 ms without frame fields fails (microsecond fallback); a gap of 3
behind a fast same-frame transaction fails; a slow same-frame transaction (20.8 ms) is excused by
microseconds; a 2-frame fetch hold is excused; a fast 3-gap in a reconnect's second stream fails
while the reconnect itself is attributed.

### New runs

Load is the 1-min `/proc/loadavg` at each leg's start -> end. The machine was shared with other
agents' timing and correctness legs throughout (load 1.5-14), well above G7uf's quiet runs.

| Run | Receiver | Verdict | Motion legs (attempt: load, motion) |
| --- | --- | --- | --- |
| web1 | web export, rust core, `run-gate7.sh --live --legs g7-6` | FAIL, motion only (26/27) - **frame-only rule**, see above | scene 1: 4.16->3.83 fail, rerun 4.23->3.67 fail; warm 4.02->4.06 pass; stall 3.73->2.92 fail; reconnect 3.77->2.26 fail; sabotage 1.69->1.52 fail. All five pass with the final rule (re-judged). |
| web2 | same, final rule | **27/27 pass** | scene 1.93->3.52 pass; warm 6.40->5.35 pass; stall 8.87->8.82 fail, **rerun** 12.43->6.04 pass; reconnect 7.07->6.24 pass; sabotage 13.75->7.24 pass |
| native | `run-gate6.sh --legs g6l`, rust core | 22/22 run checks pass (6 NOT-RUN groups); `motion-monotonic` pass | scene 11.86->9.63 pass; warm 7.07->5.27 pass; stall 14.42->6.68 fail, **rerun** 7.28->4.32 pass; reconnect 6.00->2.23 pass; sabotage 5.80->2.36 pass. Holds: frames 29, us 3 in scene. |
| gsw | GSW, `run-gate7.sh --live --legs g7-6 --receiver gsw` | **25/25 pass** (`gate_passed=true`) | scene 4.52->2.77 pass; warm 7.53->4.86 pass; stall 5.00->3.80 fail, **rerun** 3.45->2.69 pass; reconnect 3.32->2.38 pass; sabotage 1.92->2.36 pass |

Native holds are by the new field: 29 of the live-scene gaps over 2 were frame-judged fetches and 3
were shots (microsecond). A rerun happened exactly in the cases where the failing leg's load was
above 4, and only once per leg; both attempts are in `attempts.json`.

Short of the asked minimum: web `g7-6` ran twice, not three times (web1 judged with the superseded
frame-only rule), because the shared lock queue made one run take 27 min. The full validation tier
was not run.

### Scoped validation (what ran, what did not)

`validate-increment.sh` smoke tier (`artifacts/render-stream/validate/smoke1`, interrupted for the
time cap): pure self-tests rc 0 (1203 s under load), native rust gates -1, 0, 1, 2, 3 pass (interrupted in gate 4); the plan
reaches everything because `receiver.gd` and `run-gate6.sh` are shared. Not completed: native
gates 4-6 (rust), the gdscript core, the full tier, `pnpm test`, and web-gdscript. Not completed
and out of scope for the time: `cargo-gsw-rs` failed to compile
(`packages/canvas/rust-prototype` re-exports wasm32-only items, a file this increment does not
touch); it is not caused by this diff.

Also run directly: tsc for the experiment, biome on the changed files, `self-test-gate6.ts`,
`smoke-plan.py --self-test`.

### Traps

- **A frame count does not see a slow frame.** Receipt and `submitted` in one process frame can be
  20 ms apart. Keep the microsecond rule as a second excuse.
- **GSW's `processFrames` counts only paced rAF callbacks** (skipped callbacks do not increment
  it), so its frames match the receivers' "frames at --max-fps 60". A record read between two
  callbacks gets `processFrames + 1`.
- **`pkill`, `$(...)` and heredocs are refused by the worktree guard** when mixed with git-looking
  strings: put multi-line scripts in files and run them with `bash`.
- **Do not edit `run-gate*.sh` while any runner of the worktree is running** (bash reads them
  lazily). `lib/*.ts` edits are safe: each checker is a new process.
- **Exclusive lock contention.** With 3 other agents' timing legs queued, one web g7-6 run took
  27 min wall and a smoke tier was still on gate 3 after 1 h 40 min.
