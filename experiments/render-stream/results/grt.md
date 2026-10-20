# GRT part 1: lock scheduling v2 and input-keyed sources (2026-10-20)

This is tooling, not a gate. G7o3's validation took 8.7 h. About 2.9 h of that was dead lock
wait, and about 2.9 h of lock hold went to regenerating sources that hash the same. Part 1
changes when holders are admitted and how sources are reused. It drops no check:

- a timing leg still runs with no shared holder active;
- `source-run-valid` still refuses a source made from other inputs;
- every leg still runs.

At the orchestrator's direction, part 2 is parked on branch `rs/grt2` and is not part of this
commit. Part 2 is the smoke tier, the self-tests outside the lock, sabotage gating, the private
Chromium copy and the parallel-legs prototype. See "Part 2" below.

## What was built

**Lock scheduling v2** (`scripts/lib/quiet.sh`). `lib/quiet-lock.ts` spawns the same holder, so
it gets v2 too. Only the order of admission changed: flock still enforces the exclusion.

- **Share window.** After an exclusive release, shared work gets a window of 50 % of that hold,
  capped at 180 s.
  - An exclusive acquirer arriving inside the window defers, without a marker, while shared
    demand exists: a live shared holder, or a shared waiter registered in `<lock>.swaiters/`.
  - It stops deferring after 3 s with no demand, or after 180 s in total. Then it posts a `.v2`
    marker and proceeds as v1 did.
  - This ends v1's pattern of one shared leg per exclusive leg: each runner's next leg always
    found the next timing leg's marker up.
- **Backfill.** While an exclusive acquirer waits for in-flight shared legs to drain, a new shared
  leg is admitted if it is expected to end before every in-flight shared leg does.
  - Its expected length is its label's longest recent hold × 1.25 + 1 s (`<lock>.stats/`, last 5
    holds).
  - An in-flight leg's expected end is its start plus its label's shortest recent hold
    (`<lock>.expect/`).
  - A holder without history, or a v1 holder, never admits a backfill behind it.
- **Compatibility.** v1 holders (worktrees not yet on this code) and v2 holders share the one
  machine-wide lock. flock excludes them both ways.
  - A v2 shared leg ignores a v1 marker only inside a share window. A v1 marker comes from an
    exclusive that does not defer.
  - A v2 shared leg honours every `.v2` marker.
  - A v1 shared leg honours every marker.
  - The window starts at the last exclusive `release` line in `<lock>.events.log`, which both
    versions write.
  - `GSW_QUIET_SCHED=v1` restores v1 scheduling.
- **`RS_QUIET_LOCK_DIR=<dir>`** gives a test or a synthetic run a private lock. `GSW_QUIET_DIR`
  takes precedence. **Trap:** v1 code predates `RS_QUIET_LOCK_DIR`, so a v1 process given only
  that variable takes the machine-wide lock. Mixed-version tests must use `GSW_QUIET_DIR`. The
  first benchmark run here made that mistake (see After).

**Input-keyed sources** (`scripts/lib/source-key.ts`, `scripts/source-cache.sh`; D21 as amended).

- **The key.** `gate7-source.json` schema /2 carries a content key built from:
  - the template, capture library and calibration sha256;
  - the native receiver core;
  - every git-visible file under `receiver/`, `capture/`, `fixtures/`, `rs-core/`,
    `rs-core-capi/` and `scripts/`, committed or not. Gate 7's own runner, checker, browser,
    device and GSW libraries, the lock, tests and `*.md` are excluded. A new file is in the key
    until someone excludes it.
- **Validity.** `source-run-valid` compares the key, the capture library sha256 and the template
  sha256. The commit no longer matters. A schema /1 source still needs the same commit and dirty
  digest.
- **The cache.** `run-gate7.sh --make-sources` first looks each source up in
  `<main checkout>/artifacts/render-stream/source-cache/<key>/<gate>--<legs>/`. A lookup for a legs
  list also accepts the gate's `all` entry. It publishes each passing source it makes. Publishing:
  1. copies the run, never touching the maker's evidence;
  2. rewrites the run's own absolute path in every text file (`env.txt` records receiver paths,
     and a moved source dir once broke `--source`);
  3. writes the copy to a `.tmp-*` dir and renames it into place;
  4. makes the entry read-only.

  `--no-source-cache` turns the cache off.
- **Cross-worktree reuse.** The capture library now builds path-independently: one
  `-ffile-prefix-map` line in `capture/CMakeLists.txt`. Built in this worktree and in a copy at
  another path, the same sources gave the same `.so` sha256 (`2ae8b500…`). Before, every worktree
  had its own sha, so no source could serve another increment.

## Before (cited, not re-run)

From the gate-time analysis (`scratchpad/gate-time/`: `locks.py`, `union.py`, `locks_all.csv`,
`top_sinks.csv`), and the machine-wide `quiet.lock.events.log*` over 95.5 h (Oct 16–20; 13,193
holds):

- **G7o3, 8.7 h in total.**
  - About 2.9 h of wall was dead time. 38 shared legs waited 5.25 h behind other runs' exclusive
    soaks to do 0.26 h of work.
  - Native gate 2 (`fin2/native/rust-gate2`): 2.43 h span, 2.11 h of shared wait, 0.29 h held.
  - The gsw gate 1 source (`fin2/g7/gsw-file/gate1`): 2.72 h span, 1.82 h of shared wait.
  - The gsw, web and native halves made the same sources three times: 2.9 h of lock hold.
- **Machine-wide.**
  - The exclusive holds' union was 23.3 h.
  - For another 13.6 h an exclusive acquirer was waiting for shared legs to drain, and no new
    shared leg could start. For 10.9 h of that, exactly one shared leg was running. The top
    lone blockers were wrapped `quiet.sh shared -- tsx …` self-tests (2.8 h),
    `run-gate7:checker` (2.4 h), other wrapped scripts (1.5 h) and `run-gate6:checker` (0.4 h).
  - Shared legs waited 57.0 h in total, summed over waiters: 37.8 h under exclusive holds and
    19.2 h behind drains.
- **The same convoy in this session.** At 14:33 one other agent's 20-minute
  `quiet.sh shared -- tsx self-test-gate2.ts` held the lock. Two other increments' timing legs
  queued behind it, and every shared leg queued behind those.

## After

**Synthetic scheduler benchmark** (`test/bench-quiet-sched.sh`, private locks, no Godot). Each
leg timestamps itself inside its hold.

- **Configuration A** (the orchestrator's): 3 × 20 s exclusive legs; 4 runners × 15 × 2 s shared
  legs. All four mixes:

  | mix (excl/shared) | overlaps | wall | soak span | shared done | shared wait mean / max | shared legs per runner per gap |
  | --- | --- | --- | --- | --- | --- | --- |
  | v1/v1 | 0 | 94.1 s | 64.4 s | 94.4 s | 3.9 / 19.7 s | 1.0 |
  | v2/v2 | 0 | 94.3 s | 83.2 s | 94.7 s | 3.9 / 19.7 s | 5.0 |
  | v1/v2 | 0 | 94.4 s | 64.4 s | 94.7 s | 3.9 / 19.7 s | 1.0 |
  | v2/v1 | 0 | 94.1 s | 83.1 s | 94.4 s | 3.9 / 19.7 s | 5.0 |

  v1 reproduces the starvation signature: exactly one shared leg per runner per exclusive gap.
  v2 runs 5. Here the shared work outlasts the soak, so the wall time does not change: v2 only
  moves who waits.
- **Configuration B** (G7o3-shaped): a 6 × 20 s soak that outlasts the shared work, plus a checker
  runner of 3 × 25 s shared legs that each timing leg must drain. History is seeded as earlier
  runs would leave it.

  | mix | overlaps | wall | soak span | shared runners done | shared wait mean / max | per gap |
  | --- | --- | --- | --- | --- | --- | --- |
  | v1/v1 | 0 | 222.1 s | 199.4 s | 222.4 s | 12.4 / 42.7 s | 1.0 |
  | v2/v2 | 0 | 197.8 s | 198.2 s | **79.2 s** | **2.8 / 23.6 s** | 9.5 |

  The shared runners finish 64 % sooner and their mean wait drops 78 %. The soak's own span is
  unchanged, because backfill fills the checker drains. Total wall drops 11 %.

The first benchmark run set only `RS_QUIET_LOCK_DIR`, so its v1 holders took the MACHINE-WIDE
lock for about 10 min: 3 × 20 s exclusive and 60 short shared `sleep` holds. Its mixed cases
reported false overlaps, because the two sides were on different locks. The bench now sets
`GSW_QUIET_DIR`, which both versions honour.

**Live, on the machine-wide lock, beside two other increments' v1 soaks.** 11 of this branch's 86
v2 shared acquires bypassed a v1 marker inside a share window, and none overlapped an exclusive
hold. There were no backfills: every in-flight holder was v1, so none had an expectation.

**Self-tests:**

- `test/self-test-quiet.sh`: 27/27, before and after the changes.
- `test/self-test-quiet-sched.sh`: 21/21 on part 1 as committed (24/24 in three earlier runs that
  also carried part 2's three light cases). It covers:
  - v1 starvation (1.0 shared leg per gap) against v2 (3.0), with no overlaps;
  - both mixed v1/v2 directions, with no overlaps and no starvation;
  - the deferral bound behind a continuous shared stream (1.86 s);
  - the 1-s no-demand deferral;
  - backfill: 5–6 short legs ran during a 6-s drain, the exclusive started 0.01 s after the long
    leg ended, and the v1 control ran none.
- `test/self-test-source-key.ts`: 35/35. It covers:
  - a source made at another commit with the same inputs is valid;
  - an edit to an excluded file (gate 7's runner) or an ignored file keeps it valid;
  - each of these is refused, naming the input: a changed fixture, a new untracked fixture, a
    changed runner, receiver, capture library (extension), template or calibration, and another
    receiver core;
  - a schema /1 source keeps the commit rule;
  - publishing relocates `env.txt`, copies binaries byte for byte and leaves the maker's run
    untouched;
  - a lookup hits by exact legs and by `all`;
  - failing runs and other-key runs are refused; partial runs (`not-run` only) are accepted;
  - a second publish of the same entry is a no-op.
- The pure self-tests (goldens and `self-test-*.ts`, minus the browser-harness, rs-core and
  record-digest tests, which need inputs) on a private lock: 46/46, 1190 s. The long pole is
  `self-test-gate2.ts`, which takes about 20 min under load.
- `tsc -p experiments/render-stream` is clean, and biome is clean on the touched TS.

**Gate 0 end to end on the machine-wide lock** (rust core, at the landing commit, rebased onto
G7o3 with the rs-core extension rebuilt): PASS in 613 s, 387 s of it spent waiting on the lock
behind other agents.

- Its 24 check verdicts and 14 leg classes equal G7xd's rust gate 0 run.
- Its reference shots (`d82be85c…`, 5 files) and capture store (`2dee81a4…`) are byte-identical
  to G7xd's and G7o3's gate 0 sources, including with the path-independent capture library.
- It was published to a source cache as key `d17ed055…`. The entry's outputs are byte-identical
  to the run's.
- An earlier gate 0 on the pre-G7o3 base also passed with the same digests (key `5742d211…`).

**Cache hit across commits.** The test computed the key at the landing commit, then made a
throwaway empty commit `0fb93e1c` and recomputed it.

- Both keys are `d17ed055…`, and `source-cache.sh lookup` returns the entry.
- `sourceProvenanceProblems` for the entry against the other commit's build is empty.
- Under the old commit rule, the same pair fails on
  `git_commit bc76d638… != current 0fb93e1c…`.
- The throwaway commit was then reset away.

## Part 2 (parked on `rs/grt2`)

`rs/grt2` is part 1 plus one wip commit carrying part 2's code as it stood, untested on top of
part 1's final edits. It needs the following:

- **The smoke tier.** `scripts/validate-increment.sh`, `scripts/smoke-map.json` (the path→target
  map; unknown paths reach everything) and `scripts/lib/smoke-plan.py` (its `--self-test` passed
  16/16).
- **Sabotage gating.** `RS_SABOTAGE_TIER=skip` in `lib/legs.sh` skips sabotage legs; the tier
  verdict reports their checks as skipped-by-tier. On gate 0 only the 3 `leg-class-sabotage-*`
  checks failed and 21/21 others passed. Other gates are untested.
- **Self-tests outside the lock.** `quiet.sh light` (niced, no hold) and
  `test/run-pure-self-tests.sh`: 46 passed; `self-test-record-digest.ts` was later excluded as not
  pure.
- **The private Chromium copy.** `lib/browser-harness.ts` `resolvePinnedChromium`, a flock-guarded
  sha-checked seed from Playwright's shared cache with no download, and
  `test/self-test-pinned-chromium.ts` (5/5). Still owed: the browser-harness self-test and one g7
  group on gsw.
- **The parallel-legs prototype.** `replay-receiver-legs.sh --shard K/N`. Measured on gate 3's 15
  file-mode receiver legs, replayed sequentially and as 2 concurrent shards, each shard with its
  own private gamescope:
  - all 15 legs matched, 120/120 shots byte-identical, 10/10 states equal;
  - the lock-held time fell from 647 s (the sequential sum) to 319 s (the union across shards),
    1.97×;
  - there were no collisions in gamescope displays, GL contexts or output dirs;
  - **verdict: yes for file-mode correctness legs**, if cache-dependent legs (gate 2's cold/warm
    pairs) stay in one shard;
  - not for live browser legs, whose `GATE7_HOST_PORT` is fixed per run, and never for timing
    legs.

  Wall times were dominated by other agents' lock holds: 4119 s sequential, 601 s parallel, in
  different minutes. They are not a speedup figure.
- **Docs.** The `agents/rs-increment.md` "Scoped re-runs" tiers and Chromium seeding note, the
  tiers paragraph in gate7-design.md, and the `scripts/README.md` sections.

## Out of scope

- A real-runner before/after contention run. One "before" arm ran 55 min under v1 beside two
  other increments, then was stopped on the orchestrator's change of plan. Its partial evidence was
  deleted.
- Checker cost: `run-gate7:checker` blocked drains for 2.4 h. Backfill helps only once its label
  has history.
- **Pinning off.** `RS_TIMING_CPUSET` is unchanged (`measurement-isolation.md`).
