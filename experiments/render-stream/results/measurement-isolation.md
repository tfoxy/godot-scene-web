## Measurement isolation: a per-leg quiet lock (2026-10-16)

Timing checks (g6l, g6c, g6s, g1d, g5f, g55f, gate 2's live-animate pins, `gate7-bench.ts`, gate
7's live cadence and rate checks) fail under other agents' CPU load: the credit loops phase-lock to
the wrong frame. Until now agents held `flock <session scratchpad>/quiet-machine.lock` around
whole multi-gate runs, which held the machine for hours when only a few 30–90 s legs need quiet.
The runners now take one machine-wide lock themselves, **per leg**, and release it as soon as
that leg's processes exit.

### What was built

- `scripts/lib/quiet.sh` (bash library and CLI) and `scripts/lib/quiet-lock.ts` (TS twin). The
  lock is `${XDG_RUNTIME_DIR:-/tmp}/godot-scene-web/quiet.lock` (here
  `/run/user/1000/godot-scene-web/quiet.lock`), one path for every worktree; `GSW_QUIET_LOCK` or
  `GSW_QUIET_DIR` override it.
- **Exclusive per timing leg.** `lib/legs.sh` opens a timing leg at a host's
  `start_headless_bg` and closes it at that host's `finish_bg`, so the hold covers the host, the
  receiver(s), the proxy and the samplers, and nothing else. A runner marks a timing group with
  `LEGS_TIMING_GROUP`; `timing_leg <label> <command...>` brackets one leg. The timing legs are:
  g1d; g1c `live-rate-30`; g2c `live-animate` and `sabotage-unpin`; g5f; g55f; g6l; g6s (and its
  realtime `reference-step11`); g6c (the gpu-heavy calibration rounds included); g6p; every live
  host under `GATE7_LIVE_KIND`; each `gate7-bench.ts` arm (after its builds).
- **Shared per correctness leg.** Every other `run_headless`, `run_rendered` and
  `start_headless_bg … finish_bg` launch holds the lock shared, and so do g6c's reference renders,
  gate −1's legs, each gate 7 web/gsw file leg (`lib/gate7-web-legs.ts`), the four build scripts,
  the G7h harness self-test and every runner's checker. A live correctness leg's host and
  receivers share one hold, which is released when the last of them exits.
- **No starvation.** A waiting exclusive acquirer writes a marker in `<lock>.waiters/`. New shared
  acquirers wait while a live marker exists. A marker counts as stale once its pid and start ticks
  no longer match a running process, or once it is older than `GSW_QUIET_MARKER_MAX_S` (3600 s).
  The waiter refreshes it every second.
- **Wrapper for other heavy work:** `scripts/lib/quiet.sh shared -- <command...>`.
- **Core pinning** (off by default): `RS_TIMING_CPUSET` and `RS_BACKGROUND_CPUSET`.
- **Observability.** Each acquire, release and nested event is one JSON line in
  `<out>/quiet-lock.jsonl` and in the machine-wide `<lock>.events.log`; each line carries
  `wait_s` or `hold_s`. Each runner writes `<out>/quiet-lock-summary.json` and prints one summary
  line plus one line per exclusive hold.

### Deviations from the brief's design

1. **A holder process owns each lock**, not a file descriptor in the runner. `quiet.sh hold` is
   spawned per hold, and the runner never has the lock fd open, so the Godot hosts, gamescope and
   the browser daemon it starts cannot inherit it and keep the lock alive. A crash frees the lock
   either way: the holder exits within 0.25 s of its owner dying, and the kernel drops the lock if
   the holder dies. Node cannot `flock`, so the TS twin spawns the same holder. The holder also
   does the nesting check, the pinning and the logging, which keeps one implementation of each.
2. **Nesting is detected by ancestry, not by an environment variable.** A hold is a no-op
   (logged `nested`) when its owner, or any ancestor of the owner, owns a live hold, as recorded
   in `<lock>.holders/`. An exclusive request under an ancestor's *shared* hold cannot be honoured
   without deadlocking on itself. It proceeds unisolated, logged `nested-unisolated` with a
   warning, which is why agents must not wrap a runner in `quiet.sh`. Within one shell an
   exclusive request inside its own shared hold upgrades it (release, then acquire).
3. **More timing legs than the brief listed**, all from the leg tables: g1c `live-rate-30` (its
   check is a published-rate bound), g6p (rates and CPU overhead), g6s `reference-step11` (its
   freeze frame depends on the achieved rate) and g6c's calibration rounds (they measure GPU time).
   Under `GATE7_LIVE_KIND`, every live host is exclusive, because `lib/gate7-live.ts` reports
   cadence and the paced-loop check for every browser live leg, not only the timing groups.
4. **Checkers hold the lock shared.** They only read files, but they are heavy (tsx, pixel
   diffs), so they pause while another agent's timing leg runs. The cost: a timing leg can wait
   for an in-flight checker or cargo build to finish, which was up to 33 s in the demo below.
5. **`gate7-bench.ts` locks per arm, not per input.** An arm's inputs share one browser or device
   session and one device sampler, and the arm's builds (`buildSite`, `build-web-receiver.sh`)
   run before the hold.
6. **Pinning pins the owner's whole process tree**: the runner, gamescope and the XWayland that
   gamescope's session leads, the browser daemon and its Chromium, and everything the leg starts.
   It does this for the hold's duration and restores the original masks on release. Pinning only
   the leg's new processes would have left the compositor unpinned.

### Self-test

`scripts/test/self-test-quiet.sh` runs against a private lock (`GSW_QUIET_DIR` under a temporary
directory). Result: **27/27 pass, twice.** It covers:

- **semantics**: exclusive excludes exclusive and shared, shared excludes exclusive, and shared
  holders run together;
- **the waiter marker**: against a stream of overlapping 0.8-s shared holders, an exclusive
  acquirer got in after 0.95 s, and no shared hold started while it waited. With the marker
  disabled (`GSW_QUIET_SELFTEST_NO_MARKER=1`) the same stream starved it for 7.09 s, the whole
  stream;
- **stale markers**: dead pid, recycled pid, expired age, and a live marker that is honoured;
- **nesting**: CLI inside CLI for all four mode pairs; the library re-entrant and upgrading; a
  runner calling a runner;
- **crash release**: owner SIGKILLed, the lock frees in 0.27 s; holder SIGKILLed, it frees at once;
- **logs and summary**;
- **pinning** of the owner's tree, of new children, and its restore;
- **the TS twin**: acquire and release; nested under a bash hold; excludes a bash exclusive.

### Runs on this branch (all with other agents' unlocked gate runs on the machine)

| Run | Verdict | Exclusive holds | Exclusive total / wall | Shared holds |
| --- | --- | --- | --- | --- |
| gate −1 | PASS | 0 | 0 s / 97 s | 11 (90 s) |
| gate 0 | PASS | 0 | 0 s / 246 s | 22 (240 s) |
| gate 1 (g1a–g1d) | PASS 66/66 | 7: g1d ×6 (18–34 s), live-rate-30 35 s | 211 s / 802 s (26 %) | 33 |
| gate 2 (g2a–g2e) | PASS 85/85 | 2: live-animate 26.7 s, sabotage-unpin 27.0 s | 54 s / 892 s (6 %) | 48 |
| gate 6 `--legs g6a,g6l,g6c` (in the demo below) | 95/95 run checks pass (verdict FAIL only for the 4 not-run groups) | 20: g6l ×5 (32–34 s), g6c ×15 (10–77 s) | 640 s / 2119 s (30 %) | 46 |
| gate 7 `--legs g7-0 --make-sources` (desktop, web + gsw) | PASS | 0 | 0 s / 416 s | 19: 9 web legs, 8 gsw legs, harness self-test, checker. The gate 0 source run had 22 more; `build-web-receiver.sh` held 10.5 s, `build-rs-core.sh` 51 s |
| gate 7 `--live --legs g7-1 --receiver web` | PASS, 38/38 | 10 in its gate 1 run: 3 g1c legs exclusive through the `GATE7_LIVE_KIND` rule, `live-rate-30`, g1d ×6; each ≤ 19.6 s | 190 s / 480 s (40 %) | 20 |

Under the old practice a quiet run held the lock for its whole wall time (and for every gate of a
multi-gate run). The exclusive share is now 6–30 % of a timing run's wall time and 0 % of a
correctness run's, in windows of at most 77 s
(`sabotage-constrained-ignore-credit`). Every timing check passed on the first run; none needed
the allowed rerun.

### Interleaving demo

Gate 6 `--legs g6a,g6l,g6c` ran beside two other loads for its whole 2119 s:

- a loop of gate 1 file legs (`--legs g1a,g1b`, 3 runs, each 34/34 run checks passing);
- a loop of clean `cargo build --release` of `rs-core` through `quiet.sh shared --` (59 builds,
  all rc 0).

Reading the machine-wide event log over that window (`analyze-demo.py` in the evidence below):

- **0 overlaps** between an exclusive hold and any other hold.
- All three pairs of shared sources overlapped one another: the correctness work ran
  concurrently between timing legs.
- 40 shared holds paused more than 1 s behind a timing leg. The cargo loop waited 674 s in total,
  the gate 1 loop 785 s.
- Each of the 20 timing legs waited 8–33 s for the in-flight shared holds to drain (441 s in
  total).

A 15-s strip of the timeline (X = a timing leg holds the lock):

```
  645s . g1-loop
  660s X
  675s X
  690s . cargo,g1-loop
  705s . g1-loop
  720s X
  735s X
  750s X
  765s . cargo,g1-loop
```

### Core pinning (report-only)

g6c's eight rate legs (rate-baseline, rate-15/30/60, rate-uncapped-host60, mismatch-60-recv30,
mismatch-15-recv60, recv-delay) ran under 8 `yes` burners pinned to CPUs 0–3,6–9, which are four
of the Ryzen 5 5500's six physical cores with both SMT threads each. They ran twice:

- with `RS_TIMING_CPUSET=4,5,10,11` (the other two physical cores, both threads; 7 processes pinned
  per leg);
- without pinning.

A third-party agent's unpinned `run-gate7.sh` was also running throughout, on every CPU.

| leg | pinned: published/s, host p95 ms | unpinned: published/s, host p95 ms |
| --- | --- | --- |
| rate-baseline | –, 20.1 | –, 18.3 |
| rate-15 | 15.0, 19.9 | 15.1, 19.0 |
| rate-30 | 29.2, 19.4 | 29.5, 19.0 |
| rate-60 | 32.6, 19.2 | 35.9, 18.9 |
| mismatch-60-recv30 | 20.3, 21.1 | 27.0, 19.4 |
| recv-delay | 14.6, 19.2 | 15.2, 18.8 |

- **Pinned:** 23/25 run checks pass. `rate-achieved-rate-30` failed (receiver 56.84 frames/s,
  outside [57, 61]), and so did `host-unperturbed-mismatch-60-recv30` (p95 +5.2 % against a
  5 % bound). An earlier pinned run without rate-baseline passed every check it could judge
  (22/22).
- **Unpinned:** 24/25 pass, failing `host-unperturbed-mismatch-60-recv30` (+5.9 %).

The same legs passed 95/95 in the demo, with no burners and with the lock keeping the
correctness load out.

**Result: pinning to two physical cores did not keep the timing checks stable.** The pinned
host's own baseline p95 got *worse* (20.1 ms against 18.3 ms), because host, receiver,
gamescope, XWayland and the tsx samplers then share four threads. Pinning also cannot keep out a
process that never pins itself to the background set. **Recommendation: keep pinning off by
default.** The lock alone held every timing check green under real concurrent load. Pinning is
worth retrying only with a wider timing set (e.g. four physical cores) and with
`RS_BACKGROUND_CPUSET` adopted by every agent.

### Evidence

Copied out of the worktree (whose `artifacts/` goes away with it) to the session scratchpad
`measurement-isolation-evidence/`:

- each run's `quiet-lock.jsonl` and `quiet-lock-summary.json`;
- the demo's `timeline.json` and strip;
- the self-test log;
- the g6c rate tables.
