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

## Part 2 (GRT2a): smoke tier, sabotage gating, light self-tests, private Chromium (2026-10-20)

Measured motive: 75% of agent time this session went to waiting on validation runs. G7hp's
80-line change spent 75 of 98 min in `g7-1` file and live runs it did not need in full (one live
leg is about 2.2 min and g7-1 has 11 legs per receiver); writing the code took 1.7 min. Part 2
makes the validation proportional to the diff. It drops no check from the full tier.

- **Planner.** `scripts/validate-increment.sh` (`--plan`, `--tier smoke|full`, `--milestone`,
  `--only`, `-j`), `scripts/smoke-map.json` (path to target rules; unknown paths reach everything;
  docs reach nothing and never trigger sabotage by content) and `scripts/lib/smoke-plan.py`
  (`--self-test` 21 checks). Smoke runs one representative leg per reached live group and browser
  (`RS_SMOKE_LEGS`, honoured at the `lib/legs.sh` launch choke point: every other leg directory gets
  `skipped-by-tier.txt`) and one receiver leg per file group (`GATE7_SMOKE_LEGS=@first`,
  `smokeSkipsLeg` in `lib/gate7-web-legs.ts`; the `--make-sources` native run is untouched so the
  source cache stays complete). A diff reaching 3 or more groups on a receiver is shared code:
  smoke runs the first group and lists the rest in `smoke_deferred`. The full tier runs every leg
  of the reached groups; `--milestone` everything.
- **Verdict.** `lib/tier-verdict.py` (self-test 7/7) judges a filtered run from its own
  `result.json`: a failing gating check is excused only when it names a skipped leg (or, with
  sabotage skipped, "sabotage" in its id); every other failure is real; each smoke entry must have
  run, so a stale name fails; no checks is a failure. Smoke is a weaker verdict than the full tier
  (g7-1 on gsw: 8 of 20 checks passed on evidence, 12 aggregate checks excused because they name the
  skipped legs); the full tier before the commit is the gate.
- **Sabotage gating.** `RS_SABOTAGE_TIER=skip` skips every leg whose directory names `sabotage`.
  Run through `validate-increment.sh` with no checker in the diff: gate 0 passed with its 3 sabotage
  checks skipped-by-tier (633 s wall, 487 s of it lock wait behind other agents), gate 1 passed with
  13 skipped-by-tier (9 `leg-class-sabotage-*` plus 4 aggregate live checks whose details name only
  `sabotage-drop-message`; 53 of 66 checks passed on evidence; 1630 s wall, 1198 s lock wait). With
  `--tier full` or a checker in the diff the sabotage legs run. Gates 2-6 are dry-run plans only
  (`validate-increment.sh --plan` shows `sabotage:false` on every native run and "skipped-by-tier");
  their runners were not executed with the skip.
- **Light self-tests.** `quiet.sh light` (niced, holds nothing) and `test/run-pure-self-tests.sh`:
  48 passed, 0 failed in 1169 s under load average ~5 (no lock wait; `self-test-gate2.ts` alone is
  16 min niced). Heavy builds and `cargo`/`pnpm test` stay under `quiet.sh shared`.
- **Private Chromium.** `resolvePinnedChromium` (`lib/browser-harness.ts`, also used by
  `lib/gate7-live-legs.ts`): `~/.cache/godot-render-stream/ms-playwright/chromium-1223/`, seeded by
  `cp -a` from the shared install after a sha256 check (no download); the shared copy is used only
  if its sha matches; neither matching fails naming both paths. `self-test-pinned-chromium.ts`
  5/5, `self-test-browser-harness.ts` rc 0 (this run seeded the real private copy), and a full
  `g7-0` gsw file run through the tool passed (`browser-provenance@gsw` on the private copy; 455 s
  wall, 396 s lock wait).
- **Smoke legs, measured.** g7-1 on gsw: `import`, `capture`, `reference`, `live` (4 of the group's
  runner dirs, 1 live leg of 11) passed in 183 s with 1.5 s of lock wait. The g7-2/5/55/6 smoke
  entries come from reading the runners and are not yet run; a wrong name fails the verdict loudly.
- **Plans for past diffs** (smoke vs full run counts, `validate-increment.sh --plan --paths ...`):
  - G7hp (6ab7feb1, `gate7-live*.ts` plus docs): smoke is `pure` plus `g7-1` on gsw and on web/rust,
    6 representative legs of 22 (2 x 11 in the full tier), 10 group targets deferred; the full tier
    plans 6 live groups on each browser plus the native `g7-lc`/`g7-r`.
  - G7o3 (49390cb7, `rs-core` and the capi): reaches every receiver; smoke is both cargo crates,
    the native gates under both cores without sabotage legs, `g7-0` per file receiver, `g7-1` live
    per browser (9 representative legs), 35 group targets deferred.
- **Not here (GRT2b).** The parallel file-leg shards (`replay-receiver-legs.sh --shard K/N`,
  measured 15/15 legs and 120/120 shots identical, 1.97x lower lock-held time on gate 3, opt-in
  only, file-mode only) and `--fixed-fps` acceleration.

## Part 2b (GRT2b): sharded file legs, the ownership check, fast frames (2026-10-20)

The motive is the same as part 2's: agents spent most of their time waiting on validation runs.
Part 2b makes the legs themselves cheaper. It drops no check, and every option is opt-in. Evidence
is in the worktree's `artifacts/render-stream/grt2b/`:

- `parta/` holds the native serial vs sharded arms;
- `partb/` holds the fast-frame arms;
- `partc/` holds the g7-0 gsw arms;
- `final/` holds the proof on the merged code;
- `compare.py`, `holds.py` and `lifetimes.py` are the tools.

### Where a leg's time goes

This was measured first, read-only, from existing evidence: gate1/gate2/gate6 runs, the
measurement-isolation runs, G7k's `g7-1`/`final`, and G7g's `final2`. File mtimes, `timings.json`
marks, `perf.json` and lock holds were the sources.

| Leg kind | wall | overhead or startup | streaming |
|---|---|---|---|
| native rendered file receiver/reference | 18-30 s (27 s median hold) | the ownership check, 18-30 s | Godot 1-3 s (3-14 %) |
| native headless capture | ~1.3 s | 0.4 s to calibration | already unthrottled: 400 frames in 0.1-2.7 s |
| native live (host at 60 fps + receiver) | 19-31 s | host 0.4 s; the check's tail | 18 s for 1080 frames (59-94 %) |
| native soak (g6s) | 373 s | 0.4 s | 370 s (99 %) |
| browser live, web / gsw | 19 s | first frame 2.7 s web, 0.2 s gsw; the receiver joins late inside the host's fixed window, adding no wall | 18 s (94 %) |
| browser file replay, web / gsw | 5.1 s / 3.3 s | web 1.35 s engine start + ~1.1 s teardown; gsw 0.07 s | the rest |

So:

- **Native rendered file legs were overhead-bound.** `gs_verify_display_ownership` ran
  `gs_socket_owners`, which forked one `readlink` per open fd on the box. That is ~11k fds today,
  15 s per socket, and two sockets per display. It ran in the foreground, so the leg took
  max(check, Godot).
- **Live legs and the soak are streaming-bound.** Their wall time is frames / 60.
- **Chromium launch is already off the critical path.** The G7l daemon prepares the next leg's
  browser during the current one, and the leg-to-leg gap is about 1 s. Reusing browsers would save
  ~2.5 s of a web file leg's 5 s, and almost nothing on gsw.

### The ownership check (the biggest lever)

`gs_socket_owners` is now one `find /proc/[0-9]*/fd -lname 'socket:[inode]'`. It returns the
same set in the same order, and `display-ownership.json` is unchanged.
`test/self-test-socket-owners.sh` compares the new scan with the old walk on live sockets:
4/4 equal, 0.07 s vs 14.7-15.2 s.

| Gate (groups) | lock-held before (cited) | after, serial | ratio |
|---|---|---|---|
| gate 0 (all) | 239.7 s (`measurement-isolation/runs/gate0-a`) | 43.3 s | 5.5x |
| gate 1 (g1a, g1b) | 456.6 s (gate1-a's g1a/g1b holds + checker) | 71.1 s | 6.4x |
| gate 2 (g2a, g2b, g2d) | 546.3 s (gate2-a's) | 104.6 s | 5.2x |
| gate 3 (all) | 15 receiver legs alone were 647 s (part 2's measurement) | 83.8 s, the whole gate | — |

A rendered leg's median hold fell from 27.0 s to 2.1 s. Lock-held time is the sum of a run's
holds, and serially it equals their union. Wall time is not comparable on this box: other agents'
timing legs made the waits 0.2-1236 s per run.

### Part A: sharded file-mode legs (`RS_LEG_SHARDS`)

- **Natively** (`lib/legs.sh` "Parallel file-mode legs", wired into gates 0-3):
  - each runner's all-file-mode rendered block is a region;
  - each `run_rendered_receiver`, `run_rendered` and `run_headless` in a region runs on one of N
    workers;
  - each worker has its own private gamescope (slot 0 is the runner's) and its own per-leg shared
    hold;
  - gate 2's cold→warm cache pair is one unit (`legs_par_unit g2b_cache_pair`), and g2d's
    receivers wait for its rendered captures (`legs_par_wait`);
  - live receivers, background hosts, timing groups and legs, and the native runners' browser
    substitution (`GATE7_LIVE_KIND`) stay serial;
  - `test/self-test-par-legs.sh` passed 10/10.
- **Browser file legs** (`lib/gate7-web-legs.ts` `runWebLegs`, every g7 file group, gsw and web):
  - N legs run at once on the run's one harness server, each in its own fresh browser;
  - the applied.json hook is keyed per leg nonce;
  - a leg whose native env warms from another leg's cache waits for every earlier leg
    (`dependsOnEarlier`; `test/self-test-web-legs-shards.ts` 10/10);
  - each leg's quiet hold is owned by its own owner process (new `owner` option of `quietAcquire`).
    One process's second hold would only *nest* in its first, and the first leg's release would
    then unlock the second leg. The owner polls its parent, so a crashed run frees the lock within
    0.5 s.
  - The prototype's `--shard K/N` on `replay-receiver-legs.sh` was not taken: the runners now
    shard themselves.

Proof: identical check verdicts and per-leg classes, and every PNG byte-identical, against the
serial arm.

| Gate | checks | PNGs | serial | 2 workers | 3 workers |
|---|---|---|---|---|---|
| gate 0 | 24 | 60 | 43.3 s | 36.3 s (1.19x) | 32.7 s (1.32x) |
| gate 1 (g1a, g1b) | 36 | 312 | 71.1 s | 52.8 s (1.35x) | 50.0 s (1.42x) |
| gate 2 (g2a, g2b, g2d) | 57 | 204 | 104.6 s | 90.0 s (1.16x) | 80.6 s (1.30x) |
| gate 3 | 56 | 175 | 83.8 s | 70.5 s (1.19x) | 60.5 s (1.39x) |
| g7-0 gsw (one source) | result.json identical | 58 | 41.8 s | 32.2 s (1.30x) | — |

Times are lock-held union. These arms ran beside each other and beside other agents' runs, so
the ratios are noisy. On g7-0, the 8 gsw legs alone took 28.1 s serially and spanned 18.4 s
on 2 workers (1.53x). Differences outside the verdicts are run-to-run capture noise, and capture
legs are never sharded: `/proc` maps line counts, encode/hash ns, and one byte of a recording's ns
stats. Two serial runs differ in the same fields.

**Final proof, on the code merged with GRT2a** (`final/`, a quiet box with lock waits of 0.1-0.4 s
per run):

- **Gates 0-3, serial vs 2 workers:** all four are again identical in verdicts and PNGs, and gate
  3's whole `result.json` is identical.

  | Gate | serial wall | 2-worker wall | ratio | lock-held union |
  |---|---|---|---|---|
  | gate 0 | 45.9 s | 39.8 s | 1.15x | 40.1 → 33.8 s |
  | gate 1 | 79.9 s | 70.9 s | 1.13x | 61.2 → 55.4 s |
  | gate 2 | 120.5 s | 110.3 s | 1.09x | 101.2 → 91.4 s |
  | gate 3 | 97.9 s | 87.0 s | 1.13x | 79.7 → 70.3 s |

- **g7-0 gsw, on `final/gate0-serial` as the source:**
  - `result.json` is identical and all 58 PNGs are identical;
  - each arm passed 31 checks and failed 1: `source-run-valid@gsw`, because a plain runner output
    has no `gate7-source.json`. `partc/` used a `--make-sources` source and passed fully;
  - wall fell from 45.6 s to 37.3 s, lock-held from 42.4 s to 34.2 s.
- Two serial gate 0 runs differ from each other in exactly the same noise fields.

After the ownership fix, sharding is modest. On a quiet box, 2 workers give 1.09-1.15x on
wall time and 1.10-1.19x on lock-held time. Under load, 3 workers gave up to 1.42x. The rest of a
gate is serial:
- imports, captures and checkers;
- the parent's per-leg setup in gate helpers (`g2_receiver`'s tsx settle-seqs);
- legs outside the regions.

It is worth having for the full tier and sweeps. It is not a substitute for the fix.

### Part B: faster-than-real-time live legs (`RS_FAST_FRAMES`, prototype)

`RS_FAST_FRAMES=all|host|receiver` rewrites a correctness launch's `--max-fps 60`. It does so
never inside a timing group or a timing leg, except for `GATE7_FAST_FRAMES=1`'s gate 7 live legs.
`GATE7_FAST_FRAMES=1` also adds `--disable-gpu-vsync --disable-frame-rate-limit` to the live
browser. All arms ran on gate 1 `--legs g1a,g1c` unless noted. Its correctness live legs are
`live-headless`, `live`, `live-replay` and `sabotage-drop-message`; `live-rate-30` is a timing
leg and stays at 60.

| Arm | live leg (host lifetime) | checks vs real time | what broke |
|---|---|---|---|
| real time, native | 18.4 s (59 fps) | 38/40 (the 2 not-run groups) | — |
| `--fixed-fps 60 --max-fps 0`, all or host only | 0.46 s (~2350 fps) | 23/40 | every live leg: the host finishes its 1080 frames before the receiver connects (0 connections) |
| `--fixed-fps 60 --max-fps 240` | 0.46 s | 23/40 | the same: Godot 4.5.1 ignores `--max-fps` under `--fixed-fps` (`Main::iteration` returns before `add_frame_delay`) |
| `--max-fps 120` (x2) | 9.4 s (115 fps) | identical verdicts | — |
| `--max-fps 240` (x4) | 7.8 s (138 fps) | identical verdicts | — |
| real time, gsw | 18.4 s; browser live-replay 18.1 s | 38/40 | — |
| `--fixed-fps` + unthrottled Chromium, gsw | 0.8 s | 23/40 | as native |
| `--max-fps 240` + unthrottled Chromium, gsw | 7.8 s; browser live-replay 0.72 s | identical verdicts | — |
| gate 2 `--legs g2a,g2c`, real time | 16.7-17.8 s | 40/43 (3 not-run) | — |
| gate 2 `--legs g2a,g2c`, `--max-fps 240` | 7.1-8.4 s | 37/43 | `live-stall`: its `5:1300` ms stall now spans ~2.3x the frames, so steps 6 and 7 get no shot (`live-vs-reference`, `stall-newest-texture`, `leg-class-live-stall`) |

Notes on those arms:

- **The headless host tops out near 145 fps.** The headless display cannot draw, so
  `OS::add_frame_delay` sleeps `low_processor_mode_sleep_usec` (6900 µs) whatever `--max-fps` is.
  So "x4" is really 2.35x on headless hosts, and x2 is 1.95x.
- **Matching verdicts are not matching bytes.** Live shot seqs and harmless-tie seqs move with the
  receiver's join frame. That is equally true between two real-time runs. The checker's own
  `live-vs-reference` (every step's shot equals the reference) is the pixel proof, and it passed.
- **Lock-held time** for the gate 1 g1a,g1c run fell from 137.5 s to 96.2 s at x4 (1.43x). On
  gsw it fell from 144.6 s to 92.7 s (1.56x). Gate 2 g2a,g2c fell from 199.1 s to 132.0 s.
- **An unthrottled browser speeds up rAF-paced file replays too.** The gsw `live-replay` of
  received.rs7 took 18.1 s at real time and 0.72 s here. The g7 file legs' own browser
  (`lib/gate7-web-legs.ts`) does not take `GATE7_FAST_FRAMES` yet.

### Checks that are wall-clock and must stay real time

- **Rate.** g1c `live-rate-30` / G6r publish rate, g6c's rate and mismatch arms, g6p overhead,
  every `gate7-bench.ts` arm.
- **Pacing, cadence and phase.** g6l live cadence (gaps > 2), G7r pacing per phase, the
  credit-window phase lock (g6c 60/60), `live-credit-bounded` under a real receiver frame clock.
- **Startup and lifecycle.** G7k startup (first-frame ms), G7u suspension and lifecycle (hidden
  tabs, CDP freeze), memory soak growth over time.
- **Millisecond-defined stalls.**
  - `RS_RECEIVER_STALL` is `<step>:<ms>`: g1d `1:2000`, `sabotage-ignore-credit` `3:500`, g2c
    `live-stall` `5:1300` (measured broken at x2.35), g5f and g55f `1:2000`. Coalesced counts and
    the shot windows after a stall depend on frames-per-ms.
  - `RS_RECEIVER_FETCH_DELAY_MS` (g2c `live-animate` pins, 100 ms).
- **Timeouts.** `RS_RECEIVER_FETCH_TIMEOUT_MS`, `RS_RECEIVER_CONNECT_TIMEOUT`,
  `GRC_LIVE_HELLO_TIMEOUT_MS`, g1d's kill/reconnect/resync timing.
- **The live join window.** `LIVE_START_FRAME=300` frames is a real-time budget for the receiver
  to connect: 5 s at 60 fps, 2.2 s at x2.35, ~0.1 s unthrottled. The web export needs 2.7 s to
  its first frame, so web live legs at x2.35 would likely join after step 0's window. This is
  inferred, not run.
- **Device legs** (g31/g86).

To run faster than real time, these would need to count frames instead:
- the stall specs (`<step>:<frames>`);
- the fetch delay;
- the join window. A host that holds its timeline until the first subscriber is the fix; it needs
  the fixture's `_frame` and the capture's frame stamps to start together, in every live fixture.

### Recommendation

1. **Ship the ownership-check fix as is** (done here). It applies to every native rendered leg of
   every gate and tier, and the evidence is unchanged. Measured on gates 0-3: a rendered leg went
   from 27 s to 2.1 s, and gates 0-2 hold the lock 5.2-6.4x less.
2. **Adopt `RS_LEG_SHARDS=2` for the full tier and milestone sweeps' native gates 0-3 and the g7
   file groups.** It gives 1.1-1.2x at 2 workers on a quiet box and up to 1.4x at 3, with
   byte-identical verdicts and shots. Use 3 workers where the box is quiet. Wire gates 4-6 the same
   way next; their rendered blocks have the same shape.
3. **Adopt fast frames as an opt-in `fast` mode for smoke only, scoped to measured groups.** That
   means `RS_FAST_FRAMES=all RS_FAST_FRAMES_MAX_FPS=120..240` on native and gsw live correctness
   legs whose checks count frames (g1c's measured: 2.35x per live leg, identical verdicts).
   - Never use it for timing groups, ms-stall legs (g1d, g2c `live-stall`, g5f, g55f), web live
     legs (join window) or device legs.
   - Never use `--fixed-fps` unlimited: it breaks every live leg until hosts gate their timeline on
     a subscriber.
   - Milestone sweeps and timing legs stay real time.
4. **Next levers:**
   - frame-counted stall and fetch-delay specs, plus a subscriber-gated host timeline. That would
     make fixed-fps (40 µs per frame) usable: about 0.5 s per live leg instead of 18 s, and the
     370 s soak's correctness half in seconds;
   - `GATE7_FAST_FRAMES` for the g7 file legs' browsers (rAF-paced replays: 18 s → 0.7 s
     measured on one leg).
   - Reusing the browser and host across legs is not worth it yet. Startup is under 1 s per leg
     except the web export's ~2.5 s.

Time: 1.8 h wall in all. About 0.8 h went to implementation and docs, and about 1.0 h to
validation and measurement, overlapping, since code and docs were written while runs went. About
25 min of the validation was waiting on other agents' lock holds.

## Out of scope

- A real-runner before/after contention run. One "before" arm ran 55 min under v1 beside two
  other increments, then was stopped on the orchestrator's change of plan. Its partial evidence was
  deleted.
- Checker cost: `run-gate7:checker` blocked drains for 2.4 h. Backfill helps only once its label
  has history.
- **Pinning off.** `RS_TIMING_CPUSET` is unchanged (`measurement-isolation.md`).

## Part 3 (GRT3): live correctness legs faster than real time (2026-10-20)

Part 2b's prototype broke every millisecond-defined stall and left the 300-frame join window as a
real-time budget. Part 3 removes both causes and turns fast frames into a tier mode with an
explicit allowlist. Evidence is in the worktree's `artifacts/render-stream/grt3/`: one directory per
arm (`<gate>-rt-a`, `<gate>-fast240-a`, `g7-<n>-<receiver>-{rt,fast}`, `g1c-fast{120,145,240}`),
with `compare3.py` (verdicts, shots, lifetimes) and `verdicts.py`.

### What was built

- **Stalls and the fetch delay are in frames** at 60 fps: 120 (g1d, g5f, g55f: 2000 ms), 78 (g2c:
  1300 ms), 30 (ignore-credit: 500 ms), 6 (g2c pins' fetch delay: 100 ms). `lib/legs.sh`
  `legs_frames_ms`/`legs_stall_spec` turn them into the receiver's milliseconds at the leg's own
  host rate, so a real-time leg passes exactly the old `1:2000`, `5:1300`, `3:500` and `100`. No
  receiver changed: GDScript, GSW and the web export all still take `<step>:<ms>`.
  `check-gate1.ts`'s `sim-kept-running` reads the host's `--max-fps` from its `argv.txt` and asks
  for 0.8 x the stall's frames at an average interval <= 1.25 / that rate. Every other stall
  check (missed windows, the post-stall step, `stall-newest-texture`, coalescing) was already
  frame-based.
- **The host holds its timeline for its first receiver.** `GRC_LIVE_AWAIT_HELLO_MS=<ms>` makes
  `capture/src/entry.cpp` block its frame callback at the first armed publish, draining the
  listener every millisecond, until a connection's hello has arrived (a non-empty `stream_id` in
  `Hub::summaries()`) or the timeout passes. The main loop, the fixture's frame counter and the
  capture's frame stamps all wait together. It is one function and one call in `stream_publish`;
  `rs_live.{h,cpp}` are untouched. Unset (every real-time leg), it does nothing.
- **A headless host reaches its cap.** `GRC_LOW_PROCESSOR_SLEEP_USEC=0` calls
  `OS.set_low_processor_usage_mode_sleep_usec(0)` at extension init. Part 2b's ~145 fps ceiling was
  that 6900 µs sleep (`OS::add_frame_delay`, `!p_can_draw`); with it off, 1080 frames at
  `--max-fps 240` took 4.49 s, exactly 240 fps.
- **The allowlist and denylist** live in `lib/legs.sh` (`RS_FAST_ALLOW_LEGS`,
  `RS_FAST_ALLOW_GROUPS`, `RS_FAST_DENY_LEGS`) and `scripts/README.md` "Fast frames (GRT3)". The
  rewrite now reaches browser receivers too (`--max-fps N` alone), and `RS_FAST_FRAMES_MAX_FPS`
  defaults to 240 and refuses anything outside 61..1000 (no unbounded `--fixed-fps` path is left).
- **`validate-increment.sh --fast-frames on|off`** (default on for smoke and full, off under
  `--milestone`) passes `RS_FAST_FRAMES=all RS_FAST_FRAMES_MAX_FPS=240` to every native run and adds
  `GATE7_FAST_FRAMES=1` to the g7-1/g7-2/g7-5/g7-55 live runs only.
- Tests: `test/self-test-fast-frames.sh` (rewrite, host words, both lists, conversion: 34 cases) and
  `test/self-test-fast-frames-checks.ts` (`hostFpsOfArgv`, `stallFrames`, `sim-kept-running` on
  synthetic evidence, including a host that missed its rate).

### Identity: fast vs real time on the same code

Every arm ran the full legs of its groups, sabotage legs included. "Checks" compares every check
id's status; "shots" compares the shot PNGs by sha256, per leg and step and per host frame.

| Arms (groups) | checks, real time = fast | shots at a common host frame | shot sets per step |
|---|---|---|---|
| gate 1 (g1a, g1c, g1d) | 54 = 54 (53 pass, g1b not run) | 78/78 identical | 94/94 identical |
| gate 2 (g2a, g2c) | 43 = 43 (40 pass, 3 groups not run) | 40/40 | 56/60 (4: `live-animate`) |
| gate 5 (g5c, g5f) | 38 = 38 (34 pass, 4 not run) | 31/32 (1: the stale-coalesce sabotage) | 32/38 |
| gate 5.5 (g55f) | 19 = 19 (15 pass, 4 not run) | 27/27 | 31/38 |
| g7-1 live, gsw | 38 = 38, all pass | 16/16 | 94/94 |
| g7-1 live, web-rust | 40 = 40, all pass | 75/75 | 94/94 |
| g7-2 live, gsw | 35 = 35, all pass | 21/21 | 60/72 (12: `live-animate`) |
| g7-2 live, web-rust | 37 = 37, all pass | 33/33 | 63/72 (9: `live-animate`) |

- **Shots.** Every shot taken at the same host frame in both arms is byte-identical. Per step,
  shots differ only where the receiver shot a different frame of an *animated* fixture (g2c's
  `live-animate`, g55f's per-frame shader phase, g5f's every-frame geometry), which two real-time
  runs do as well: the checkers' own `live-vs-reference` (every shot equals the reference at its
  frame) passed in every arm.
- **Stalls in frames.** The stall legs behave the same in frames. g1d `live-stall`: the receiver
  blocked 2000.1 ms vs 500.1 ms, the host ran 122 vs 123 frames between the stalled send and its
  credit (16.67 vs 4.17 ms each), coalesced +69 vs +70, and the same windows were missed (`{2}`).
  g2c `live-stall`: the stall after seq 492 at frame 607 ended at frame 687 vs 688, and step 6's
  texture arrived in the first post-stall transaction in both. g5f and g55f stale-coalesce: the
  recovery at frame 488 vs 490 (g5f) and 489 vs 489 (g55f), stale from 368 in all four, failing on
  exactly the same regions. Part 2b's `--max-fps 240` broke g2c `live-stall` (steps 6 and 7 got no
  shot); in frames it passes.
- **The one frame-level difference** is g5f `sabotage-mesh-stale-coalesce`'s step-1 shot at frame
  367. Under that sabotage a send is labelled with the current frame but carries the first missed
  target, so its content depends on when credit returned, not on the frame. Both arms classify it
  `pixel-mismatch`, as expected.

### Speed-ups

Per live leg, process lifetimes (argv.txt write to the last stdout.log write) from the same pairs.
Real time is ~18.4 s per gate 1 live leg (1080 frames at 60 fps; Part 2b measured the same) and
~16.9 s per gate 2 one.

| Leg kind (example) | real time | fast (240) | ratio |
|---|---|---|---|
| native live, rendered receiver (gate 1 `live`, host) | 18.40 s | 5.78 s | 3.2x |
| native live, headless receiver (gate 1 `live-headless`) | 18.53 s | 7.02 s | 2.6x |
| native g1d stall leg (`live-stall`) | 18.37 s | 5.62 s | 3.3x |
| native g2c live (`live`) / pins (`live-animate`) | 16.95 / 16.66 s | 5.92 / 5.32 s | 2.9x / 3.1x |
| native g5f `live-mesh` / g55f `live-shader` | 14.73 / 14.61 s | 4.68 / 4.68 s | 3.1x / 3.1x |
| gsw live (g7-1 `live`, host / receiver) | 18.36 / 18.07 s | 5.01 / 4.65 s | 3.7x / 3.9x |
| gsw `live-replay` (file mode, unthrottled Chromium) | 18.14 s | 1.28 s | 14x |
| web-rust live (g7-1 `live`, host) | 18.39 s | 6.78 s | 2.7x |
| web-rust `live-replay` | 20.35 s | 5.40 s | 3.8x |
| gsw g7-2 `live` (host) | 16.77 s | 4.78 s | 3.5x |
| web-rust g7-2 `live` (host) | 17.24 s | 7.03 s | 2.5x |
| denylisted g2e `live-auth` (stays real time) | 16.87 s | 16.97 s | 1.0x |

A fast host's lifetime is start-up (0.4 s), the hold for its first hello and 1080 frames / 240
(4.5 s). The hold was 0.10-0.18 s for a gsw receiver, 0.7-2.1 s for a native rendered one and
1.6-1.9 s for the web export, which now costs no frames. Per run, lock-held time (exclusive plus
shared) fell 1.65-2.1x: gate 1 264 -> 142 s, gate 2 211 -> 110 s, gate 5 135 -> 63 s, gate 5.5
90 -> 48 s, g7-1 gsw 277 -> 134 s, g7-1 web 300 -> 154 s, g7-2 gsw 329 -> 200 s (its g2e legs
stay real time). Run wall times are not comparable: every arm ran beside the others and beside
other agents' g6c timing legs (lock waits of minutes).

**240 vs 145 vs 120** (gate 1 g1c, rendered `live` host lifetime; all three identical in verdicts):
120 fps 11.6 s (1.6x), 145 fps 9.45 s (1.95x), 240 fps 5.78 s (3.2x). With the sleep override
the host held exactly 240 fps (1080 frames in 4.49 s), so 240 is the default. A higher cap was not
tried: the shot windows are 53 frames (220 ms at 240), and the rendered receivers' own frame rate
then starts to matter.

### Traps

- **A plain `--max-fps` above ~145 is not honoured on a headless host** without the sleep override:
  Part 2b's "x4" was 2.35x for that reason, and a stall converted at the cap but run at 145 fails
  `sim-kept-running` (the synthetic case in `self-test-fast-frames-checks.ts`).
- **Same frame, not same step.** Animated fixtures' shots are a function of the host frame; compare
  them by frame.
- **The await must not block refusal legs.** g2e's auth/origin legs may never see a hello, so they
  are denylisted rather than waiting out the timeout.
- **Chromium unthrottling is run-wide.** The daemon prepares the next leg's browser ahead, so
  `GATE7_FAST_FRAMES=1` covers a run's denylisted legs too (g7-1's `live-rate-30`): those keep
  `--max-fps 60` on host and receiver, and the receiver paces itself (GSW's tick rule, the export's
  `web_main.cpp`). `validate-increment.sh` never sets it for g7-6, g7-r, g7-lc or g7-k.

### Validation and scope

Ran: the arms above (each runner's full legs, sabotage included, both modes); the pure self-tests
(`run-pure-self-tests.sh`, 53/53, both new tests in it); `self-test-fast-frames.sh` 34/34;
`tsc --noEmit` over the experiment (0 errors); biome on the touched TS; `validate-increment.sh
--tier smoke --only native-rust-gate0,native-rust-gate1,g7live-gsw-g7-1` (fast frames on through
the tier). 3/3 runs pass: native-rust-gate0, native-rust-gate1 (all 66 gate 1
checks, hosts at 240 with `1:500`, `live-rate-30` left at 60) and the g7-1 gsw smoke (4 legs in
117 s, on the restructured `lib/legs.sh`). Gate 0 and 1's 1171 s and 2322 s walls were 1088 s
and 2108 s of lock waits behind other agents' timing legs.

Not run, with the reason: the plan reaches all 65 targets, because `lib/legs.sh` and
`capture/src/entry.cpp` match every rule, and a full tier of that size is a milestone sweep, not
an increment's run (hours). The capture change is inert unless one of its two new variables is set
(no runner sets them outside fast frames); the `lib/legs.sh` change is inert while
`RS_FAST_FRAMES` is off (`self-test-fast-frames.sh`'s "off" cases, and every real-time arm above
passing with the old specs). The gdscript core, gates -1/3/4/6, the file groups and g7-5/g7-55/g7-6
live were therefore left to the next milestone sweep, which runs real time.

**G7q.** `git merge-tree` of this branch with `rs/g7q` is clean. G7q edits `rs_live.{h,cpp}`
(window-w credit), `entry.cpp`'s header, `Live` struct, `is_listener_sabotage` and `stream_start`,
and `lib/legs.sh`'s `run_browser_receiver` and `legs__start_headless_bg` (between `gate7_host_env`
and `legs__fast_argv "$@"`). This change leaves `rs_live.{h,cpp}` untouched, adds its two functions
next to `stream_publish` and `initialize`, and keeps `legs__fast_argv "$@"`'s call line as it was
(the leg directory comes in `LEGS_FAST_DIR`), so neither side's hunks touch.

The arms ran on the first cut of `lib/legs.sh`; the G7q restructure after them only moved where the
leg directory comes from (`LEGS_FAST_DIR`) and is covered by `self-test-fast-frames.sh` and the
tier run.

Time: about 2.5 h wall. About 1.0 h went to implementation and docs (the code in the first 25 min,
then restructuring `lib/legs.sh` for a clean G7q merge, and the docs), and about 2.1 h to
validation, overlapping: 19 arms plus the tier run, most of it queued on the exclusive lock behind
each other and behind another agent's g6c run.

## Part 4a (GRT4a): gate-runtime follow-ups (2026-10-21)

Eight follow-ups from G7q's full tier, all user-approved, landed before the milestone sweep they
shape. Proved synthetically (stub runners, a private lock, a private cache), then by one real
smoke run.

### What was built

1. **No `g7live-native` + `g7-lc` pair.** `smoke-plan.py`'s universe let `g7-lc` onto the native
   receiver, so every full or milestone plan's `g7live-native` run exited 2 in a second
   (`run-gate7.sh`: "g7-lc runs browser receivers only"). The native receiver now plans `g7-r` only,
   and `runs()` asserts it.
2. **Typed `unavailable` rows.** `tier-verdict.py --runner-rc N` re-judges a native or gate 7 run
   whose runner exited 1: failing rows with status `unavailable`/`device-unavailable` are listed,
   not failed. A runner exit with every check passing, or an exit >= 2, still fails. Gate 7's
   harness checks (`{id, ok}`) now count as checks too (a failing one used to be invisible to the
   verdict). On G7q's evidence: `g7live-gsw` (4 UNAV rows) and `g7live-web-rust` (3) at both
   windows now pass; `g7-web-gdscript`'s checker crash (no checks written) still fails.
3. **Single flight on the source key.** `source-cache.sh flight`/`land` around run-gate7.sh's
   lookup, make and publish: a second run missing the same key and gate waits for the first maker,
   then hits. Chosen over a validate-increment.sh source phase because it also covers two
   worktrees (or a hand run beside a tier) with the same inputs.
4. **Timing phase.** Each planned run has a `phase` (`setup`, `native`, `g7`, `timing`) and the
   map's `"timing"` targets (native gate 6, `g7-6`/`g7-lc`/`g7-r` live, `g7x`) run last, at
   `--timing-jobs` (default 1). A receiver's live groups split into `g7live-<r>` (correctness, which
   now gets fast frames in the full tier too: the mixed run used to get none) and
   `g7live-<r>-timing`.
5. **Cache pruning and read-only entries.** Every publish prunes to `GSW_SOURCE_CACHE_KEEP` (3)
   most recently used keys; lookup hits refresh a key, a live lease (`lookup --lease <run-gate7
   pid>`), a live flight or use within `GSW_SOURCE_CACHE_MIN_AGE_S` (6 h) protects it, and entries
   are `chmod -R u+w`'d before `rm -rf`. The recency guard exists because runners from before
   GRT4a (other worktrees until they rebase) take no lease and refresh nothing. `prune` with no
   argument now keeps N (`--keep-days` still works). The gate 0/1 checkers write a linked leg's
   diffs under `<view>/view-diff/` (`checkerDiffDir`), never through a view's symlink into the
   source: G7q's `g7-web-gdscript` failed with EACCES on a cache hit's `diff/step-0.png`.
6. **Summary.** `validate-summary.json` is `render-stream-validate-summary/2`: per run its phase,
   wall, lock wait and hold per mode, unavailable rows; per-phase totals; every run dir has
   `command.txt`.
7. **Fast frames in milestones.** `--fast-frames` defaults on for every tier. Native runs and the
   correctness live runs get the fast env; `lib/legs.sh`'s allow/deny lists keep every timing leg
   real time, and the timing live runs, file groups and `g7x` never get it.
8. **`--base`.** `smoke-plan.py --base REF` (and `--print-paths`) computes `REF...HEAD` plus
   uncommitted and untracked files; validate-increment.sh uses it. `--milestone --base <commit>` is
   the delta sweep: the full tier over that diff's targets with every sabotage leg; capture, the
   wire, `rs-core` and unmatched paths still reach everything (the escalation).

### Before (cited, not re-run)

G7q's full tier (`artifacts/render-stream/gate7/g7q/.claude/worktrees/agent-a21460591887c87cb/
artifacts/render-stream/validate/g7q-full3-w{1,2}/`): `g7live-native` rc 2 in 1 s at both windows;
`g7live-gsw` and `g7live-web-rust` rc 1 with only UNAV rows; `g7-web-gdscript` rc 1 on EACCES.

The lock-wait numbers it reported were inflated. The old summary summed every
`quiet-lock-summary.json` under a run, following symlinks, so a gate 7 view's link to its source run
(often a cache entry made by another run) counted that run's holds again:

| run (G7q) | wall s | reported wait s | own wait s (shared + exclusive) | own hold s |
| --- | ---: | ---: | ---: | ---: |
| w1 `g7-gsw` | 8674 | 18608 | 4838 + 1371 | 2939 |
| w1 `g7-web-rust` | 9751 | 34397 | 5815 + 686 | 5297 |
| w2 `g7live-gsw` | 7328 | 13802 | 916 + 3987 | 2145 |
| w2 `g7live-web-rust` | 6138 | 11919 | 1410 + 2394 | 2042 |
| full2 `native-rust-gate6` | 7179 | 3801 | 690 + 3110 | 3043 |

So the browser live runs' real wait was 3.8–4.9 ks, not 11.9–13.8 ks, most of it exclusive: their
own exclusive live legs queued behind each other and behind gate 6's timing legs. The timing phase
removes the second cause; the first is inherent (every gate 7 live leg holds the lock exclusively).

### Validation and scope

Synthetic first (no Godot, no browser; private lock, private cache), all in the pure tier:

- `test/self-test-validate-tier.sh` (20 checks, ~9 s): `smoke-plan.py --self-test` (now 28 cases:
  the native/g7-lc pairing over complete, full and smoke plans, phases, no mixed live runs, the
  delta sweep and its escalation, `--base` in a throwaway git repo) and `tier-verdict.py
  --self-test` (13 cases); then a stubbed `--milestone -j 4` sweep (`RS_VALIDATE_STUB`): every
  timing run starts after the last correctness run ends, no shared hold overlaps an exclusive one,
  the stubbed UNAV-only run passes with its rows listed, per-run lock numbers exclude a symlinked
  foreign summary, the fast env reaches native and correctness live runs only, and `lib/legs.sh`
  under the captured env runs g1d `live-stall` fast and keeps g6l, g6c and `live-rate-30` real time.
- `test/self-test-source-cache.sh` (17 checks, ~2 s): three concurrent makers build once, a dead
  owner's flight is taken over, a live one's wait is bounded, LRU (a hit refreshes), a read-only
  entry pruned and a kept one byte-identical, leases, the recency guard, `KEEP=0`, `--keep N`.
- `test/self-test-checker-diff-dir.ts` (7 checks): a view linked into a read-only entry writes its
  diff under `view-diff/` and the entry is unchanged; the old path is refused; a native run's own
  legs (also through a symlinked `--out`, or not yet created) keep `<receiver>/diff`.

The pure tier: 56/56 (`run-pure-self-tests.sh`, 1280 s at load 5–9 while the machine was in use,
no lock held). `tsc --noEmit` over the experiment: 0 errors; biome clean on the touched TS.

One real smoke, at load < 4 (an earlier start was stopped when the user's load passed 8):
`validate-increment.sh --tier smoke --only native-rust-gate0,g7-gsw`
(`artifacts/render-stream/validate/grt4a-smoke/`), 2/2 pass in 149 s: gate 0 with its sabotage
legs (a checker is in the diff) in 53 s, published as key `e6ea8ff6…`, which pruned the least
recently used key `f2b5051f…` (no process had it open); `g7-gsw`'s g7-0 smoke then took the flight,
hit that entry and judged its `gsw-view` with the diffs in `gsw-view/view-diff/`, 96 s. The summary
carries the new per-run phase, wall, wait and hold. The recency guard was added after this run;
`self-test-source-cache.sh` covers it.

Not run: the full tier and any sweep (the plan reaches 42 targets through `run-gate7.sh` and the
gate 0/1 checkers; that size is the milestone sweep this increment shapes), the lock tests (the
lock is unchanged) and the GDScript targets (G7gd deletes them; milestone-only under D34).

Traps: the old summary's recursive glob followed view symlinks into source runs and cache entries
(3–6x inflated waits); `git diff main...HEAD` was computed in bash, so the planner could not be
tested on a base without a repo (now `changed_paths` in Python, tested on a throwaway repo);
`create-worktree.sh` fails on `mise exec` before `mise trust` in a fresh worktree (worked around by
hand: `git worktree add`, `mise trust`, `install-agent-config.sh`, `pnpm install`).
