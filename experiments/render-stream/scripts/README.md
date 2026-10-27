# Measurement isolation: the quiet lock

Every runner here takes one machine-wide lock **per leg**, so timing checks are not disturbed by
other agents' work, without a lock held for a whole multi-gate run (`lib/quiet.sh`, TS twin
`lib/quiet-lock.ts`; result and measurements in `../results/measurement-isolation.md`).

- **Path**: `${XDG_RUNTIME_DIR:-/tmp}/godot-scene-web/quiet.lock`, the same for every worktree
  (`GSW_QUIET_LOCK` or `GSW_QUIET_DIR` override it; `RS_QUIET_LOCK_DIR=<temp dir>` gives a test or
  synthetic run a private lock, never a gate run sharing the machine). `<lock>.events.log` logs every hold on the
  machine.
- **Exclusive, per timing leg**: a leg's host, receiver(s), proxy and samplers hold it from the
  host's start to its `finish_bg`, and nothing else heavy runs meanwhile. Timing legs: g1d, g1c's
  `live-rate-30`, g2c's `live-animate` and `sabotage-unpin` (the live-animate pins), g5f, g55f,
  g6l, g6s (and its realtime `reference-step11`), g6c (calibration rounds included), g6p, every
  live host under `GATE7_LIVE_KIND` (gate 7's live legs: cadence and rate checks), and each
  `gate7-bench.ts` arm, after its builds. A runner marks a timing group with `LEGS_TIMING_GROUP`
  (or brackets one leg with `timing_leg`, `lib/legs.sh`).
- **Shared, per correctness leg**: every other `run_headless`, `run_rendered` and
  `start_headless_bg ... finish_bg` launch, each gate 7 web/gsw file leg, the build scripts
  (`build-capture.sh`, `build-rs-core.sh`, `build-rs-core-ext.sh`, `build-rs-core-web.sh`,
  `build-web-receiver.sh`, `build-basis-transcoder.sh`) and
  each runner's checker. Shared holders run together, but wait while a timing leg holds the lock
  or waits for it (a waiter marker in `<lock>.waiters/`, so a stream of shared holders cannot
  starve it; a marker whose process is gone, or older than `GSW_QUIET_MARKER_MAX_S`, default
  3600 s, is ignored).
- **Heavy work outside a runner** (a cargo build, a `pnpm test` suite, a wasm build): run it as
  `experiments/render-stream/scripts/lib/quiet.sh shared -- <command...>`. Never wrap a runner in
  `quiet.sh` or `flock` (its own legs lock themselves; an exclusive leg inside an outer shared
  hold cannot be isolated and is logged `nested-unisolated`).
- **Nesting** is safe: a hold taken by a process whose ancestor already holds the lock (a runner
  calling a runner, a build script inside a leg) is a logged no-op.
- **Crashes** free it: a holder process (`quiet.sh hold`) owns each hold, and exits within 0.25 s
  of its owner dying; if the holder itself dies, the kernel drops the lock.
- **Core pinning** (off by default): `RS_TIMING_CPUSET=8-11` pins a timing leg's whole process tree
  (the runner, gamescope and its XWayland, hosts, receivers, browsers) for the leg;
  `RS_BACKGROUND_CPUSET=0-7` does the same for shared holds.
- **Evidence**: each run writes `<out>/quiet-lock.jsonl` (one line per acquire, release and
  nested event, with `wait_s` and `hold_s`) and `<out>/quiet-lock-summary.json`, and the runner
  prints one summary line (holds, exclusive total against wall time).
- **Scheduling v2** (GRT, `../results/grt.md`; the exclusion above is unchanged, only admission
  order moved). *Share window*: after an exclusive release, shared work gets 50 % of that hold
  (`GSW_QUIET_SHARE_PCT`, capped at `GSW_QUIET_SHARE_MAX_S`=180 s): a new exclusive acquirer defers,
  with no marker yet, while a shared holder or a registered shared waiter (`<lock>.swaiters/`)
  exists, and stops after 3 s without demand (`GSW_QUIET_SHARE_LINGER_S`); then it posts a `.v2`
  marker and proceeds as before. *Backfill*: behind a drain (an exclusive acquirer waiting for
  in-flight shared legs), a new shared leg is admitted when its label's longest recent hold
  (`<lock>.stats/`) ends before every in-flight shared leg is expected to (`<lock>.expect/`).
  *Compatibility*: v1 holders (worktrees not yet on this code) and v2 ones share the lock safely:
  flock does the exclusion for both; a v2 shared leg ignores a v1 marker only inside a share
  window; a v1 shared leg honours every marker. `GSW_QUIET_SCHED=v1` restores the old scheduling.
- **Light work**: `quiet.sh light -- <command...>` holds nothing and runs the command under
  `nice -n 10` (logged as a `light` event): for the pure self-tests only
  (`test/run-pure-self-tests.sh`), never for a build or a leg.
- `bash experiments/render-stream/scripts/lib/quiet.sh status` shows the current holders, waiters,
  deferring exclusive acquirers and the share window; `test/self-test-quiet.sh` is the lock's
  self-test (a private lock, ~40 s) and `test/self-test-quiet-sched.sh` the v2 scheduling's (the
  G7o3 starvation reproduced under v1 and fixed under v2, mixed v1/v2 holders, the deferral bound,
  backfill, light; ~5 min); `test/bench-quiet-sched.sh` is the synthetic v1/v2 benchmark (fake
  runners, private locks, wall and per-leg waits per mix; `../results/grt.md`).

# Source cache and smoke tier (GRT)

**Source cache** (`source-cache.sh`; `lib/source-key.ts`; D21 as amended). A gate 7 source run is
valid for a build when its content key matches: the template, capture library and calibration
sha256, the native receiver core, and every git-visible file (committed or not) under `receiver/`,
`capture/`, `fixtures/`, `rs-core/`, `rs-core-capi/` and `scripts/`, minus gate 7's own runner,
checker, browser/device/GSW libraries, the lock, tests and `*.md` (`SOURCE_EXCLUDES`). A new file
under those roots is in the key until excluded. `gate7-tool.ts source-key [--json]` prints it.

- `run-gate7.sh --make-sources` looks each source up first, then publishes each passing source it
  makes (`--no-source-cache` or `RS_SOURCE_CACHE=0`: neither). `<out>/sources.json` records
  `source_key` and per gate `hit`, `miss`, `published` or `not-published`.
- Entries live in the main checkout's `artifacts/render-stream/source-cache/<key>/<gate>--<legs>/`
  (`GSW_SOURCE_CACHE` overrides): a copy, never the maker's evidence, with the run's own absolute
  path rewritten to the entry's in every text file (`env.txt` records receiver paths), written to a
  `.tmp-*` dir and renamed into place, then made read-only. A lookup for a legs list also takes the
  gate's `all` entry. `source-cache.sh list` / `prune [--keep N | --keep-days 14]`.
- **Single flight** (GRT4a). `run-gate7.sh` takes `source-cache.sh flight <key> <gate> <pid>` before
  its lookup and `land`s after its publish, so two runs missing the same key and gate at once
  (validate-increment.sh's `g7-gsw` and `g7-web-rust`, or two worktrees) make that source once: the
  second waits on `<root>/.flight/<key>--<gate>/`, then hits. A flight whose owner process is gone
  is taken over; a wait past `GSW_SOURCE_FLIGHT_MAX_S` (7200) makes the source unshared.
- **Keep-N / LRU pruning** (GRT4a). Every publish prunes the cache to the `GSW_SOURCE_CACHE_KEEP`
  (default 3; `0` = never) most recently used keys (`<key>/.last-used`, touched by each publish and
  lookup hit). A key with a live lease (`lookup --lease <pid>`; run-gate7.sh passes its own pid, so
  a run replaying an old entry keeps it), a live flight, or a key used within
  `GSW_SOURCE_CACHE_MIN_AGE_S` (default 6 h; runners from before GRT4a take no lease) is never
  pruned, so the cache can sit above N while keys are in use. Entries are read-only: pruning does
  `chmod -R u+w`, then `rm -rf`.
- **Checkers never write into a source** (GRT4a). A gate 7 view links its legs to the source run,
  often a read-only cache entry, and the gate 0/1 checkers used to write `diff/step-<k>.png` through
  that link (G7q: EACCES, worked around with `RS_SOURCE_CACHE=0`). `checkerDiffDir`
  (`lib/gate0-checks.ts`) keeps a run's own legs' diffs at `<receiver>/diff/` and puts a linked
  leg's under `<view>/view-diff/<leg>/receiver/diff/`.
- The capture library builds path-independently (`-ffile-prefix-map`, `capture/CMakeLists.txt`), so
  the same capture sources give the same library sha256 in every worktree and a cached source
  serves later increments.

**Smoke tier** (`validate-increment.sh`, `smoke-map.json`, `lib/smoke-plan.py`). `bash
validate-increment.sh --plan` maps the diff (`git diff --name-only main...HEAD`, or `<ref>...HEAD`
with `--base <ref>`, plus uncommitted and untracked files) through `smoke-map.json` to targets: native gates per core, gate 7 groups per
receiver and web core, live groups, crates, the lock tests. A path no rule matches reaches every
target. Without `--plan` it runs them: the pure self-tests (`test/run-pure-self-tests.sh`, light),
builds and crates, native gates (each passing rust-core full run is published to the source
cache), then gate 7 with `--make-sources` (which then hits the cache). Native sabotage legs run
only when a checker, runner, sabotage or mutation file is in the diff; otherwise the runners get
`RS_SABOTAGE_TIER=skip` (`lib/legs.sh` skips any leg directory naming `sabotage`, leaving
`skipped-by-tier.txt`) and the run's `tier-verdict.json` lists the sabotage checks as
skipped-by-tier, failing on any other check. `--milestone` runs every target with sabotage;
`--milestone --base <commit>` is the delta sweep (GRT4a): the full tier over the targets the diff
since `<commit>` reaches, with every sabotage leg of those (a capture, wire or unmatched path still
reaches everything). `python3 lib/smoke-plan.py --self-test --map smoke-map.json` tests the map.
`--only <id>` for an id the plan does not reach prints a WARNING (nothing runs for it; force it in
with `--paths <a file it covers>` or `--milestone`); `scripts/remote-validate.sh` fails (rc 2) instead.

**Timing groups on hosted runners (R2).** `RS_SKIP_TIMING_GROUPS=1` is set only by
`.github/workflows/remote-validate.yml` (never a default, never by the planner). The timing groups
inside the correctness gates (`g1c-rate`, `g1d`, `g2c-pins`, `g5f`, `g55f`: exclusive-lock wall-clock
legs) then skip every leg (`lib/legs.sh` `legs_skip_group`, one `skipped-remote.txt` per leg dir),
`lib/tier-verdict.py` excuses the checks about those legs (named in the check's id, detail or
criterion) like skipped-by-tier, and `validate-summary.json` lists them per run as
`skipped_remote[]` / `skipped_remote_groups[]`. `remote-validate.sh` prints each skipped group and the
local command to run it (`run-gate1.sh --legs g1a,g1d` ...). Unset, nothing changes.

**Phases** (GRT4a). Each planned run has a `phase`, run in order: `setup` (pure, lock tests, builds,
crates), `native` (native correctness gates), `g7` (file groups and correctness live groups), then
`timing`: the map's `"timing"` targets (native gate 6, the g7-6/g7-lc/g7-r/g7-k live groups, `g7x`),
at `--timing-jobs` (default 1). A receiver's live groups split into `g7live-<r>` and
`g7live-<r>-timing`; the complete sweep plans g7-r on gsw, web/rust and native and g7-k on both
browsers, and the native receiver only ever plans `g7-r` (run-gate7.sh refuses any other
live group there). Smoke defers g7-k (the map's `smoke.defer`: its 300 s soak legs) to the full tier. G7q's full tier ran gate 6's and the timing live groups' exclusive legs beside
the browser groups, whose own lock wait reached 3.8–4.9 ks of a 6–7 ks run.

**Typed unavailable rows and the summary** (GRT4a). A native or gate 7 run whose runner exits 1 is
re-judged by `lib/tier-verdict.py --runner-rc 1`: failing rows typed `unavailable` or
`device-unavailable` (desktop g7-lc's real-suspension rows) do not fail it but are listed; any
other failing row, a runner exit with every check passing, or an exit >= 2 still fails.
`validate-summary.json` (`render-stream-validate-summary/2`) gives each run its phase, wall time,
quiet-lock wait and hold per mode summed over the run's own `quiet-lock-summary.json` files
(symlinked directories are not followed: a view links its source, often another run's cache
entry, and following it counted G7q's g7-gsw wait as 18.6 ks instead of its own 6.2 ks), its
unavailable rows, and per-phase totals. Each run dir has `command.txt` (the env and argv it got).
`test/self-test-validate-tier.sh` (a stubbed sweep on a private lock) and
`test/self-test-source-cache.sh` (a private cache) cover the phases, verdicts, summary, fast-frame
env, `--base`, single flight and pruning; both are pure.

`--tier smoke` (default) vs `--tier full`. Smoke runs one representative leg per reached live
group and browser: `smoke-map.json` "smoke" names each group's leg directories (g7-1: `import`, `capture`,
`reference`, `live`, 3 of its 11 legs), `validate-increment.sh` passes them as `RS_SMOKE_LEGS` to
that group's own `run-gate7.sh --live` run (`lib/legs.sh` leaves `skipped-by-tier.txt` in every
other leg directory), and one receiver leg per file group as `GATE7_SMOKE_LEGS=@first`
(`smokeSkipsLeg` in `lib/gate7-web-legs.ts`; the `--make-sources` native run is untouched, so the
source cache stays complete). A diff reaching 3 or more groups on a receiver is shared code: smoke
runs the first group there and lists the rest, and the groups without a smoke entry, in the plan's
`smoke_deferred`. The full tier runs every leg of the reached groups; run it once before the commit.
`lib/tier-verdict.py` judges a filtered run: a failing check is excused only when it names a skipped
leg (or, for skipped sabotage legs, "sabotage" in its id), every other failure stays real, and each
smoke entry must have run, so a stale entry fails loudly. Unset, neither variable changes any
runner. `python3 lib/tier-verdict.py --self-test` tests it.

**Pinned Chromium, repo-private** (`lib/browser-harness.ts` `resolvePinnedChromium`). Every gate 7
browser launch uses `~/.cache/godot-render-stream/ms-playwright/chromium-1223/`
(`RS_PRIVATE_BROWSERS_DIR` overrides the root), not Playwright's shared `~/.cache/ms-playwright/`,
which any repo's `playwright install` garbage-collects (it deleted `chromium-1223` on 2026-10-20 and
every browser leg failed). When the private copy's `chrome` does not match
`EXPECTED_CHROMIUM_SHA256` and the shared cache's does, the harness seeds the private copy from it
(`cp -a` of the revision directory, sha-checked, moved into place under a flock) and launches that;
if seeding fails it launches the verified shared copy; if neither matches it refuses, naming both
paths. It never downloads a browser. `checkBrowserProvenance` still hashes whatever was launched
against the same pin. `test/self-test-pinned-chromium.ts` covers it (no browser launched).

# Sharded legs and fast frames (GRT2b)

Measured in `../results/grt.md` "Part 2b".

- **The display-ownership check is fast now.** `lib/gamescope.sh` `gs_socket_owners` finds the
  holders of a gamescope X socket with one `find /proc/*/fd -lname`. It used to fork one `readlink`
  per open fd on the box: ~15 s per socket, two sockets per rendered leg. That was ~90 % of every
  native rendered leg (27 s → 2.1 s median). The evidence (`display-ownership.json`) is unchanged.
  `test/self-test-socket-owners.sh` checks the new scan against the old one
  (`gs_socket_owners_slow`) on live sockets.
- **Credit window default (G7wd, fork F1).** `GATE7_CREDIT_WINDOW` is 2 for gate 7's live runs
  (`run-gate7.sh --live` exports it; a browser `GATE7_LIVE_KIND` implies it) and 1 for the native
  gates run directly, which stay on /6. `--credit-window 1` (or `GATE7_CREDIT_WINDOW=1`) is the
  explicit window-1 run: every live host gets `GRC_LIVE_CREDIT_WINDOW_MAX=1` and every browser
  receiver `RS_RECEIVER_CREDIT_WINDOW=1`. g7-r's default list follows the window (the window-2
  list at 2, `G7R_LEGS_<kind>` at 1).
- **Sharded file-mode legs: `RS_LEG_SHARDS=N`** (`on` = 2; unset, `0`, `1` or `off` = serial, the
  default). It is opt-in. Natively it is wired into gates 0–3; for browsers, into every gate 7
  file group.
  - Natively, each rendered block of a runner whose legs are all file-mode is a parallel region:
    `legs_par_begin` after its `gs_start`, `legs_par_end` before its `gs_teardown` (`lib/legs.sh`
    "Parallel file-mode legs").
  - Inside a region, each `run_rendered_receiver`, `run_rendered` and `run_headless` runs on one of
    N workers. Each worker has its own private gamescope and its own per-leg shared quiet-lock hold.
  - Legs that must stay in order form one unit through `legs_par_unit <fn>`: gate 2's
    `receiver-cold` → `receiver-warm` cache pair is `g2b_cache_pair`. `legs_par_wait` is a barrier:
    in g2d, the receivers wait for the rendered captures they replay.
  - Live receivers, background hosts, timing groups and timing legs never shard. Neither do the
    native runners' gate 7 browser receivers (`GATE7_LIVE_KIND`), whose daemon, page port and host
    port are per run.
  - Gate 7's file legs (`gate7-tool.ts gsw-legs` / `web-legs`, `lib/gate7-web-legs.ts`) run N
    legs at once, each in its own browser on the run's one harness server. Each leg's applied.json
    hook is keyed by its nonce. Each leg's quiet hold is owned by its own owner process
    (`quietAcquire`'s `owner`): a second hold owned by the same process would only nest. A leg
    whose native env warms from another leg's cache (`dependsOnEarlier`) waits for every earlier
    leg.
  - `test/self-test-par-legs.sh` covers the bash library with stub launches.
    `test/self-test-web-legs-shards.ts` covers the TS helpers.
  - Verdicts and shots are byte-identical to serial on gates 0–3, at both 2 and 3 workers, and on
    g7-0 gsw.

  ```bash
  RS_LEG_SHARDS=2 bash experiments/render-stream/scripts/run-gate3.sh --extension … --calibration …
  ```
- **Fast frames** (`RS_FAST_FRAMES`) were a GRT2b prototype; GRT3 made them a tier mode, below.

# Fast frames (GRT3)

Measured in `../results/grt.md` "Part 3". `RS_FAST_FRAMES=all|host|receiver` (default off) runs the
**allowlisted** live correctness legs faster than real time, and `validate-increment.sh` turns it on
for every tier, `--milestone` included since GRT4a (`--fast-frames on|off`, `--fast-fps N`, default
240). A plain runner keeps real time. `lib/legs.sh` "Fast frames" holds the lists and the rewrite.

- **What changes in a fast leg.**
  - The `--max-fps 60` of an allowlisted launch becomes `--max-fps $RS_FAST_FRAMES_MAX_FPS
    --disable-vsync` (61..1000, default 240). A browser receiver gets the `--max-fps` alone, and
    `GATE7_FAST_FRAMES=1` unthrottles its Chromium (`--disable-gpu-vsync
    --disable-frame-rate-limit`, run-wide: the daemon prepares browsers ahead). The web export
    honours `--max-fps` itself (`platform/web/web_main.cpp` skips rAF callbacks), so no export
    change is needed.
  - A fast host gets `GRC_LOW_PROCESSOR_SLEEP_USEC=0`: a headless host cannot draw, so Godot sleeps
    `low_processor_mode_sleep_usec` (6900 µs) per frame whatever `--max-fps` says, and topped out
    near 145 fps (GRT2b). With 0, `--max-fps` alone paces it.
  - A fast live host gets `GRC_LIVE_AWAIT_HELLO_MS=60000`: it holds its whole timeline (the frame
    callback, so the main loop, the fixture's frame counter and every capture frame stamp) at the
    first armed frame until the first receiver's hello, so the 300-frame join window costs no real
    time and a receiver that starts slowly (the web export: 2.7 s) cannot miss step 0. Only the
    first hello is awaited; a reconnect joins a running timeline. Unset, nothing waits.
  - Never unbounded `--fixed-fps`: Godot 4.5.1 ignores `--max-fps` beside it, and a host that ends
    its timeline before a receiver joins breaks every live leg. `RS_FAST_FRAMES_MAX_FPS=0` is
    refused.
- **Stalls and delays are in frames.** Every receiver stall and fetch delay a correctness leg uses
  is a frame count at 60 fps, converted to the receiver's milliseconds at the leg's own host rate
  (`legs_frames_ms`, `legs_stall_spec`). At real time the milliseconds are exactly the old ones,
  so a real-time leg's env.txt and evidence are unchanged:

  | Leg | frames | real time | at 240 fps |
  |---|---|---|---|
  | g1d `live-stall`, `sabotage-stale-coalesce` (step 1) | 120 | `1:2000` | `1:500` |
  | g1d `sabotage-ignore-credit` (step 3) | 30 | `3:500` | `3:125` |
  | g2c `live-stall` (step 5) | 78 | `5:1300` | `5:325` |
  | g2c `live-animate`, `sabotage-unpin` fetch delay | 6 | 100 ms | 25 ms |
  | g5f `live-mesh-stall`, g55f `live-shader-stall` and their stale-coalesce sabotages | 120 | `1:2000` | `1:500` |

  The checks count host frames: check-gate1.ts's `sim-kept-running` reads the host's `--max-fps`
  from its `argv.txt` (`hostFpsOfArgv`) and asks for 0.8 x the stall's frames at an average
  interval <= 1.25 / that rate; the missed-step and post-stall windows were already frame-based.
  Wall-clock guards (`RS_RECEIVER_FETCH_TIMEOUT_MS`, `RS_RECEIVER_CONNECT_TIMEOUT`,
  `GRC_LIVE_HELLO_TIMEOUT_MS`, the runners' kill and wait budgets) stay wall clock: a fast leg only
  ever finishes sooner, so none fires spuriously.
- **The allowlist** (`RS_FAST_ALLOW_LEGS`, `<runner>:<leg dir>` globs; gate 7's live groups run the
  same runners, so g7-1, g7-2, g7-5 and g7-55 follow it leg by leg):
  - gate 1 g1c: `live-headless`, `live`, `sabotage-drop-message`;
  - gate 1 g1d (timing group, allowlisted): `live-receiver-killed`, `live-stall`, `live-reconnect`,
    `live-resync`, `sabotage-ignore-credit`, `sabotage-stale-coalesce`;
  - gate 2: g2b's `live-inline`; g2c's `live-headless`, `sabotage-drop-resource`,
    `sabotage-wrong-hash-live`, `live`, `live-warm`, `live-stall`, `live-reconnect`, and the
    g2c-pins timing group's `live-animate` and `sabotage-unpin`;
  - gate 5 g5f: `mesh/live-mesh*`, `mesh/sabotage-mesh-stale-coalesce`;
  - gate 5.5 g55f: `shader-live/live-shader*`, `shader-live/sabotage-shader-stale-coalesce`.

  The allowlisted timing groups (`RS_FAST_ALLOW_GROUPS`: g1d, g2c-pins, g5f, g55f) and gate 7's live
  legs keep their **exclusive** quiet-lock hold: they run fast under it, never outside it.
- **The denylist** (real time whatever is set):
  - every other timing group: g1c-rate (`live-rate-30`, G6r publish rate), g6l (cadence), g6s
    (soak), g6c (rates, phase lock, credit window), g6p (overhead);
  - every `timing_leg` label (g6s `reference-step11`);
  - `RS_FAST_DENY_LEGS`: g2e's `sabotage-no-token`, `sabotage-bad-http-token`, `origin-refused`,
    `sabotage-no-cors` and `live-auth` (refusal legs: a host may never see a hello), every gate 6
    leg;
  - every leg not in the allowlist, file-mode legs (no `--max-fps 60` to rewrite) included;
  - everything outside these runners: run-gate7.sh's g7-r (G7r pacing), g7-lc (G7u lifecycle),
    g7-k (G7k startup and soak) and g7-6 (gate 6) groups, which `validate-increment.sh` never gives
    the fast env; every `gate7-bench.ts` arm; every device leg.
- **When to use it.** For validating correctness: every tier, milestone sweeps included (GRT4a),
  or a runner by hand. Never for a rate, pacing, phase, cadence, startup, lifecycle or soak number,
  a bench or a device leg: those legs are denylisted, so they stay real time in a sweep too. The
  lists are policy: a new live leg is real time until it is added to `RS_FAST_ALLOW_LEGS`, which
  needs its checks to count frames (a stall or delay given in frames, no wall-clock rate or
  interval judged).
- `test/self-test-fast-frames.sh` covers the rewrite, the host words, both lists and the frame
  conversion; `test/self-test-fast-frames-checks.ts` covers `hostFpsOfArgv`, `stallFrames` and
  `sim-kept-running` on synthetic evidence.

  ```bash
  RS_FAST_FRAMES=all bash experiments/render-stream/scripts/run-gate1.sh --legs g1a,g1c,g1d …
  bash experiments/render-stream/scripts/validate-increment.sh --tier full   # fast frames on
  bash experiments/render-stream/scripts/validate-increment.sh --fast-frames off   # real time
  ```

# Checker cost and byte identity (GRT4b)

The checkers share one decoder and a few hot helpers (`results/grt.md` "Part 4b"): `node:crypto`
behind the decoders' hash seam (`lib/node-hash.ts`, imported first by every `check-gate*.ts`), one
decode per record per reader (`withRecordMemo`), item interning across a recording's transactions
(`internItems`), state comparison without building strings (`lib/json-key-equal.ts`,
`statesEqual`), and a cell grid in `meshActions`. `test/self-test-grt4b.ts` proves each against
the code it replaced. A checker change that should not move a verdict is checked on real evidence
with `test/checker-identity.py`: `run` copies an evidence dir to a fixed work path, runs the
checker (shared quiet lock, `/usr/bin/time -v`, optionally `--cpu-prof`) and keeps every file it
wrote, canonicalised; `compare` diffs two runs (before from a detached `main` checkout, after from
the worktree). Use unpruned evidence (a source-cache entry, a fresh run): pruned recordings send a
checker down its "no host evidence" paths.

  ```bash
  T=experiments/render-stream/scripts/test/checker-identity.py
  python3 -I $T run --work W --save S --label before --name g6 --pristine <evidence dir> \
    --map <old abs prefix>=@OUT@ -- mise exec -- pnpm exec tsx --conditions=development \
    <before checkout>/experiments/render-stream/scripts/check-gate6.ts --out @OUT@
  python3 -I $T run … --label after …   # the same, from this checkout
  python3 -I $T compare --save S --name g6 before after
  ```

# Gate −1 runner

Drives `../fixtures/spike/` through every leg of the capture library's runtime contract
(`../README.md` "Runtime contract") and checks the gate's pass criteria. Run it from the repo root:

```bash
experiments/render-stream/scripts/build-capture.sh
mise exec -- pnpm render-stream:gate-minus1 -- \
  --extension "$PWD/experiments/render-stream/capture/build/render_stream_capture.gdextension" \
  --calibration "$PWD/experiments/render-stream/calibration/godot-4.5.1-stable-linux-release.json" \
  [--binary /abs/path/to/linux_release.x86_64] [--out /abs/path/to/evidence/dir]
```

`--extension` and `--calibration` are required; the script refuses immediately rather than running
a partial gate. `--binary` defaults to the pinned official 4.5.1 release template
(`~/.cache/godot-render-stream/templates/4.5.1-stable/linux_release.x86_64`, sha256
`54cc228405e5be61934192e3bc5461c91dcb4a3275578b29a869557a4322e79c`; a mismatch only warns). `--out`
defaults to `artifacts/render-stream/gate-minus1/<UTC timestamp>/` (ignored). Needs `strace`,
`gamescope` and `readelf` on `PATH`; without `strace` two criteria are `unavailable` and the gate
fails.

The rendered legs run only inside a private `gamescope --backend headless` started by
`lib/gamescope.sh`, with `DISPLAY`/`WAYLAND_DISPLAY` stripped and reset, never Xvfb and never a
desktop window. On any exit the runner stops the Godot process it owns and tears down its own
compositor (by recorded pid plus start ticks, never a pattern). gamescope 3.16.19 segfaults in its
own exit path after SIGTERM; bash prints that, it is harmless, and core files are suppressed.

## Files

- `run-gate-minus1.sh`: the orchestrator.
- `lib/gamescope.sh`: sourced private-gamescope lifecycle: start, ownership and liveness checks,
  display-connection proof, Godot launch with display, `GRC_*` and `RS_*` environment stripped and
  reset (`GS_STRIP_VARS`, `gs_strip_env_args`, shared with gate 0's headless launches).
- `lib/tamper-calibration.mjs`: writes the `refuse-sha` / `refuse-prefix` tampered record copies,
  and the `old-record` leg's version-1 record.
- `lib/gate-minus1-checks.ts`: every criterion as a pure function over an evidence directory.
- `check-gate-minus1.ts`: runs them, writes `<out>/result.json` (`render-stream-gate-report/1`,
  each entry numbered with its handoff criterion), exits non-zero unless every check passed.
- `test/self-test-checker.ts`: proves each check can fail (see below).

## Legs and evidence under `--out`

| Leg                  | What it runs                                                                                                                                                   |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `headless-armed`     | `--headless`, `GRC_MODE=arm`, disarm after 60 armed frames, under `strace -f -e trace=mprotect,openat`; `/proc` maps and fds sampled once `result.json` exists |
| `headless-validate`  | `--headless`, `GRC_MODE=validate`                                                                                                                              |
| `refuse-sha`         | record with one sha256 digit changed                                                                                                                           |
| `refuse-prefix`      | record with `object_prefix` and every slot and anchor index +1                                                                                                 |
| `refuse-nocal`       | no `GRC_CALIBRATION`                                                                                                                                           |
| `refuse-binary-byte` | a copy of the template with one byte flipped in the unmapped `.comment` section                                                                                |
| `old-record`         | `GRC_MODE=arm` with the record a version-1 calibrator would have written (gate −1 slots only, `tamper-calibration.mjs v1`); must arm with the rest omitted     |
| `rendered-unarmed`   | OpenGL under private gamescope, capture extension **absent**, screenshot at frame 60                                                                           |
| `rendered-armed`     | OpenGL under private gamescope, `GRC_MODE=arm`, disarmed only at shutdown, screenshot at frame 60                                                              |

Each headless leg writes `invocation.txt`, `stdout.txt`, `stderr.txt`, `exit-code.txt` and the
library's `evidence/` (`result.json`, `fingerprint.json`, `calibration-check.json`, and when armed
`counters.json`, `disarm.json`, `armed.marker`). `headless-armed` adds `strace.txt`, `maps.txt` and
`fd.txt`. The rendered legs write `godot.log`, the PNG, `display-ownership.json` and (armed only)
`evidence/`; `gamescope/` holds the compositor's own log and identity. The checker writes
`diff.png` and `result.json` at the top.

## Criteria

| #   | Check ids                                                                                | Passes when                                                                                                                                                                                                                                                   |
| --- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `frame-callback-ticked`, `headless-no-gpu`                                               | `frames_total >= 300`; the host reports display server `headless`, and neither a whole-run strace (successful `openat`) nor the maps/fd sample shows `/dev/dri`, `/dev/nvidia*`, `libvulkan`, `libGL*`, `libEGL`, `libnvidia*`, `libdrm`, `libgbm`            |
| 2   | `validate-no-write`, `refuse-sha`, `refuse-prefix`, `refuse-nocal`, `refuse-binary-byte` | the expected status and reason, `vptr_written: false`                                                                                                                                                                                                         |
| 3   | `colorrect-add-rect`, `label-glyph-path`                                                 | the native ColorRect's local-space rect and colour captured bit-exact; glyph `texture_rect_region` calls, an atlas `texture_2d_create`, and a `texture_2d_update` stamped at or after the relabel frame                                                       |
| 4   | `script-add-rect`                                                                        | the scripted rect and colour captured bit-exact                                                                                                                                                                                                               |
| 5   | `polygon-bit-exact`                                                                      | the scripted polygon's 3 points and 3 colours bit-exact, `uvs_count` 0                                                                                                                                                                                        |
| 6   | `disarm-restored`, `fixture-completed`, `frames-after-disarm`                            | `disarmed` and `vptr_restored`; `frames=400` and exit 0; at least 300 frames ran after disarm                                                                                                                                                                 |
| 7   | `armed-vs-unarmed-pixels`, `unarmed-not-blank`, `rendered-legs-armed-and-absent`         | the PNGs are byte-identical RGBA (`maxChannelDelta: 0`); the unarmed one shows the ColorRect and clear colour; the armed leg really armed under X11 with hooks hit and stayed armed through the screenshot, and the unarmed leg ran with the extension absent |
| 7   | `new-drawings-visible`                                                                   | every calibrator-2 drawing in `expected.json` `draw_paths.visible_samples` covers its sample pixel in `unarmed.png` (so also in the byte-identical `armed.png`), including a pixel only the per-frame mesh vertex update reaches                              |
| 8   | `no-mprotect-after-arm`                                                                  | no `mprotect` after the `armed.marker` `openat` intersects any range in `fingerprint.json`'s `exe_maps`                                                                                                                                                       |
| 9   | `optional-hook-counts`                                                                   | every optional hook (calibrators 2 and 3) is installed (`hooks_omitted` empty) and its count is > 0                                                                                                                                                           |
| 9   | `triangle-array-bit-exact`                                                               | the scripted triangle array's indices, points, colours, UVs, empty bones/weights, texture and count, bit-exact                                                                                                                                                |
| 9   | `stylebox-panel-native`                                                                  | a native triangle array on another item whose every colour is the StyleBoxFlat `bg_color` (opaque fill, alpha-0 feather), plus the Panel's `canvas_item_set_modulate` on that item                                                                            |
| 9   | `shader-material-path`                                                                   | `canvas_item_set_material` on the Panel's item; `material_set_param` on that material; `shader_set_code` on a shader `shader_create_from_code` returned                                                                                                       |
| 9   | `nine-patch-bit-exact`                                                                   | the scripted nine-patch's every argument (including the stack-passed modes, `draw_center` and modulate) bit-exact on the 4×4 texture's RID; the NinePatchRect's native one on the same RID                                                                    |
| 9   | `scripted-shapes-bit-exact`                                                              | the scripted primitive, line, polyline, `add_set_transform` and circle, bit-exact                                                                                                                                                                             |
| 9   | `mesh-surface-and-draw`                                                                  | `mesh_create` → `mesh_add_surface` (primitive, format, counts, buffer sizes, AABB read from `SurfaceData`) → `canvas_item_add_mesh` (transform, modulate) on one RID; an `add_multimesh`; a `mesh_clear` on the other mesh                                    |
| 9   | `mesh-region-updates`                                                                    | vertex/attribute region writes on that mesh with exact surface, offset, size and bytes, at least 55 times in the 60 armed frames; `mesh_set_custom_aabb` with the exact AABB                                                                                  |
| 10  | `older-record-loads`                                                                     | the `old-record` leg armed and disarmed cleanly, `hooks_omitted` is exactly the optional (calibrator 2 and 3) set with `null` counts, gate −1 counts > 0, and `calibration-check.json` `hook_plan` is ok and names each omitted hook                          |

Criteria 9 and 10 go beyond the handoff's gate −1 list. They cover the draw paths
gate −0.25 counts on the real game, and the rule that a record from an older
calibrator still loads (`../README.md` "Calibration records and hook versions").
`rendered-legs-armed-and-absent` also requires the triangle-array, nine-patch,
mesh, multimesh and vertex-region counts to be > 0 on the GPU renderer.

## Checker self-test

```bash
mise exec -- pnpm exec tsx --conditions=development experiments/render-stream/scripts/test/self-test-checker.ts
```

Builds a fabricated passing evidence tree in the real library's shapes, then one perturbation per
failure mode, and asserts each check's verdict: 30 scenarios, 73 assertions.

# Gate 0

Drives `../fixtures/gate0/` (capture host and rendered reference) and `../receiver/` through every
leg of [`../protocol/gate0-design.md`](../protocol/gate0-design.md) "Q6", then checks the gate.
Since G5d it runs on render-stream/4 (`recording.rs2`, full encoding; the file keeps its `.rs2`
name; render-stream/3 from G4e2 to G5d, render-stream/2 from G2b2 to G4e2, render-stream/1 from
G1b2 to G2b2), and every capture leg sets `GRC_ROOT_SIZE=enforce-min-size`: without it the 64×64
headless host would declare `degenerate-host-size` and every leg would classify `unsupported`.
Every capture also writes its out-of-band resource store to `<capture>/store`
(`GRC_RESOURCE_STORE_DIR`; without it the capture refuses to publish with
`resource-store-missing`), and every file-mode receiver gets a fresh content-addressed cache at
`<receiver>/cache` (`RS_RECEIVER_CACHE_DIR`) and that store (`RS_RECEIVER_STORE_DIR`). Nothing in
the fixture draws a texture, so the only table entry is the one the engine creates itself in
frame 1 (the default theme's 800×6 RGBA8 ColorPicker hue strip, unreferenced), and a correct
receiver never fetches it. Run it from the repo root:

```bash
mise exec -- pnpm render-stream:gate0 -- \
  --extension "$PWD/experiments/render-stream/capture/build/render_stream_capture.gdextension" \
  --calibration "$PWD/experiments/render-stream/calibration/godot-4.5.1-stable-linux-release.json" \
  [--binary /abs/path/to/linux_release.x86_64] [--out /abs/path/to/fresh/dir]
```

As at gate −1, `--extension` and `--calibration` are required and the runner refuses at once
without them. `--binary` defaults to the pinned template (a sha256 mismatch only warns). `--out`
defaults to `artifacts/render-stream/gate0/<UTC>/` (ignored) and must not already hold files.
The runner needs `strace`, `gamescope` and the mise editor (`mise exec -- godot`).

Every rendered leg (`reference`, `receiver` and the three sabotage receivers) runs in **one**
private `gamescope --backend headless`, never Xvfb and never a desktop window. Headless legs strip
`DISPLAY` and `WAYLAND_DISPLAY`. Every launch, headless or rendered, first unsets every variable in
`lib/gamescope.sh` `GS_STRIP_VARS` (the gate −1 `GRC_*` set, `GRC_STREAM_OUT`, `GRC_SABOTAGE`,
`GRC_SABOTAGE_FRAME` and the documented `RS_*`) plus any other inherited `RS_*`. It then passes
only what its leg wants, and `env.txt` records that. The exit trap stops the owned Godot process
and tears down the compositor.

## Gate 0 files

- `run-gate0.sh`: the orchestrator.
- `gate0-tool.ts`: helpers the runners call between legs, on the checker's own decoder.
  `settle-seqs` is the step join that becomes `RS_RECEIVER_SHOT_SEQS`. `corrupt` writes the
  `corrupt` leg's copy, with the first meta byte of transaction seq 3 set to `0x00`.
  `seq-at-frame` names the transaction published at a frame (gate 1's tie-frame shots).
- `lib/gate0-checks.ts`: `summarizeRecording` (validates and resolves a /2 recording, patches
  included, to full per-transaction states with the texture table; resource records are skipped,
  so transactions are always by seq), `drawIndexTies` / `harmlessTieKeys` (invariant 9
  groups and their paint footprints), `classifyLeg` (pure), every check, and `runGate0`, which
  builds the report. It reuses gate −1's `checkHeadlessNoGpu(outDir, "capture")`,
  `successfulOpenats` and PNG decoding.
- `check-gate0.ts`: writes `<out>/result.json` (`render-stream-gate0-report/1`) and exits non-zero
  unless `gate_passed`.
- `test/self-test-gate0.ts`: see "Gate 0 self-test" below.

## Gate 0 legs and evidence under `--out`

Every process directory holds `argv.txt` (one argument per line), `env.txt`, `stdout.log` (stdout
and stderr together) and `exit-code.txt`. `binary.json` at the top holds the template path and
sha256, and `gamescope/` holds the compositor's log and identity.

| Leg                       | Directory                                | Runs                                                                                                                                                                                           | Expected class                           |
| ------------------------- | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| `import`                  | `import/{fixture,receiver}/`             | `mise exec -- godot --headless --path <project> --import`. The runner stops if either fails                                                                                                    | — (exit 0)                               |
| `receiver-typecheck`      | `receiver-typecheck/{selftest,minimal}/` | mise editor: `--script res://tests/receiver_selftest.gd` (G7gd; `codec2_selftest.gd` before) with `RS_SELFTEST_GOLDEN_DIR=protocol/golden-2`, then a headless replay of `golden-4/inline.rs4` (inline, no store; a fresh cache; `golden-3/inline.rs3` from G4e2 to G5d, `golden-2/inline.rs2` before)      | —                                        |
| `capture`                 | `capture/`                               | template `--headless`, `GRC_MODE=arm`, `GRC_STREAM_OUT`, `GRC_ROOT_SIZE=enforce-min-size`, `RS_FIXTURE_STEP_LOG`, `RS_FIXTURE_QUIT_FRAME=400`, under strace; maps/fd sampled at `armed.marker` | `success`                                |
| `preexisting`             | `preexisting/`                           | the capture host on `res://preexisting.tscn`, quit 52                                                                                                                                          | `capture-failure`                        |
| `preexisting-skip`        | `preexisting-skip/{capture,receiver}/`   | the same capture with `GRC_UNKNOWN_ITEM=skip` (../protocol/unknown-item-skip.md), then a gamescope receiver with the settle shots                                                              | `partial-unknown-items`                  |
| `unsupported`             | `unsupported/{capture,receiver}/`        | capture with `RS_FIXTURE_VARIANT=unsupported`, quit 52, then a headless receiver                                                                                                               | `unsupported`                            |
| `sabotage-<kind>`         | `sabotage-<kind>/{capture,receiver}/`    | capture, quit 52, `GRC_SABOTAGE` `freeze-frame` / `omit-update` / `perturb-transform`, `GRC_SABOTAGE_FRAME=21`, then a gamescope receiver with the settle shots                                | `pixel-mismatch` {2,3,4} / {2} / {2,3,4} |
| `corrupt`                 | `corrupt/`                               | headless receiver on a copy of `capture/recording.rs2` whose transaction seq 3 has its first meta byte set to `0x00`                                                                           | `replay-failure` (seq 3, `meta-json`)    |
| `receiver-headless-trace` | `receiver-headless-trace/`               | headless receiver on a copy of the capture recording, under `strace -f -e trace=openat`                                                                                                        | — (applied ok)                           |
| `reference`               | `reference/`                             | template in gamescope, extension absent, `RS_FIXTURE_SHOT_DIR` → `shots/step-<k>.png`, `RS_FIXTURE_STEP_LOG`                                                                                   | — (5 shots)                              |
| `receiver`                | `receiver/`                              | template in gamescope on a copy of the capture recording, `RS_RECEIVER_SHOT_SEQS` set to the settle seqs (`shot-seqs.txt`)                                                                     | `success`                                |
| `preexisting-reference`   | `preexisting-reference/`                 | as `reference`, on `res://preexisting.tscn` (its two pre-existing rects included)                                                                                                              | — (5 shots)                              |

Capture directories add `evidence/` (`GRC_EVIDENCE_DIR`, with `resources.jsonl` since G2b2),
`recording.rs2`, `store/` and `steps.jsonl`, and the `capture` leg adds `strace.txt`, `maps.txt`
and `fd.txt`. Receiver directories add their own `recording.rs2` copy, `cache/` and `applied.json`
(`render-stream-receiver-applied/4` since G5e). Rendered ones also add `shots/seq-<n>.png`,
`display-ownership.json` and the checker's `diff/step-<k>.png`. A rendered receiver whose step join
fails is not launched: `step-join.log` says why, and the leg classifies as `capture-failure`.

## Gate 0 classification

`classifyLeg` takes the capture `result.json`, the host recording (its `validateRecording()` errors
and decoded transactions; for `corrupt`, the uncorrupted capture recording), the step join, the
receiver's `applied.json` and shots, and the checkpoints. It never reads `session.sabotage`. The
first class that fires wins, and `reasons` lists every rule that fired:

1. `capture-failure`: status not `armed`; `stream.status` not `closed`; recording missing; any
   `validateRecording` error; any `capture-failure` transaction; `step-join-failed`.
2. `unsupported`: any transaction `unsupported` entry or `unsupported` command, or a non-empty
   `applied.json` `unsupported`, except a `draw-index-tie` entry whose tie is harmless: its
   drawing members' paint footprints (every visible `add_rect` of the subtree, mapped through the
   transforms, grown by 1 px; unbounded with an unsupported command) are pairwise disjoint, so no
   order of the group changes a pixel (gate1-design.md D7 as amended by G1b2). The leg lists
   those in `harmless_ties`.
3. `replay-failure`: `applied.json` missing or unparseable, status not `ok`, `end_seen` false,
   applied seqs not exactly 1..N with the host's `record_sha256`s, or a requested shot missing.
4. `pixel-mismatch`: any checkpoint (full frame, subject or marker region) with mismatched pixels
   or a non-zero channel delta against the reference. The `preexisting-skip` leg compares against
   `preexisting-reference` with the two pre-existing rects blanked in both images.
5. `partial-unknown-items` (../protocol/unknown-item-skip.md "Classification"): any transaction
   whose `unknown_items` has `unknown_rids + withheld_items > 0`. Only a `GRC_UNKNOWN_ITEM=skip`
   session carries the account, so no other leg, and no other gate, can fire it.
6. `success`.

Legs without a receiver (`capture`, `preexisting`) stop after rule 2.

## Gate 0 criteria

| Check                           | Passes when                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `capture-armed`                 | `capture` `result.json` is `armed` with `stream.status` `closed`; `counters.json` and session `hooks_omitted` are empty; `hooks_planned` is exactly the 44 hooks named by the committed calibration record (calibrators 3 and 4)                                                                                                                                                                     |
| `headless-no-gpu`               | gate −1's check over `capture/`: display server `headless`, and no GPU device or library in the successful `openat`s, `maps.txt` or `fd.txt`                                                                                                                                                                                                                                                         |
| `recording-decodes`             | `validateRecording` is `[]`, the first transaction has frame 1, and there are 400 transactions                                                                                                                                                                                                                                                                                                       |
| `manifest-present`              | session `protocol` `render-stream/4` (since G5d; `render-stream/3` from G4e2), a full file stream, the exact /4 `features` (fifteen `ops`, the six still-refused methods in `observed_unsupported_ops`, `resources` with `mesh`), the file sinks' `resources` (`payloads` mesh and texture, out-of-band, `directory` fetch, the six permitted formats), `engine.display_server` `headless`, `viewport.root_canvas` 1, `root_size_policy` `enforce-min-size` with `host_size_status` `match` and 640×360 logical and window sizes, and `sabotage` null |
| `step-alignment`                | `capture` and `reference` `steps.jsonl` equal `expected.json`'s frames, and each step's marker colour (as float32) first appears at its applied frame                                                                                                                                                                                                                                                |
| `expected-image-reference`      | every `reference/shots/step-<k>.png` equals `synthesizeExpected(k)` exactly                                                                                                                                                                                                                                                                                                                          |
| `expected-image-receiver`       | every receiver settle shot equals `synthesizeExpected(k)` exactly                                                                                                                                                                                                                                                                                                                                    |
| `receiver-vs-reference`         | receiver vs reference at every step, full frame and both regions: 0 mismatched pixels and max channel delta 0 (`compareRgbaBuffers` with exact budgets)                                                                                                                                                                                                                                              |
| `receiver-consumed-stream`      | `receiver` `applied.json` is `render-stream-receiver-applied/4` (/3 before G5e), seqs 1..N, each `record_sha256` equal to the host's, every shot `applied_through == seq`, `recording.sha256` equal to the capture file's, and `resources_summary` shows nothing fetched and nothing uploaded                                                                                                                        |
| `receiver-never-loaded-fixture` | the traced receiver opens its recording and nothing under `fixtures/`; no file in `receiver/` (outside `.godot/`) is byte-identical to one in `fixtures/gate0/`; no receiver log has a `[fixture]` line; argv has `--path <abs receiver>`                                                                                                                                                            |
| `receiver-typed-clean`          | no `SCRIPT ERROR`, `SCRIPT WARNING`, `Parse Error` or `Failed to load script` in the typecheck logs; the selftest printed `[receiver-selftest] ok` (`[rs2-selftest] ok` before G7gd) and exited 0; the `golden-4/inline.rs4` replay (since G5d) is ok and reports exactly the golden's unsupported entries, each at its first seq                                                                                                                       |
| `preexisting-skip-account`      | the skip capture's session and `result.json` declare `unknown_item_policy` `skip` (one unknown RID named); every transaction is `ok` with `unknown_items` `{unknown_rids 1, withheld_items 1, withheld_commands 1}`, `unknown_calls` non-decreasing and growing across step 2, exactly 2 published items and no published `add_rect` in a pre-existing colour                                     |
| `preexisting-skip-reference`    | every `preexisting-reference/shots/step-<k>.png` equals `synthesizePreexistingReference(k)` exactly, and its `steps.jsonl` is the gate 0 timeline                                                                                                                                                                                                                                                  |
| `preexisting-skip-receiver`     | every skip receiver settle shot equals `synthesizeExpected(k)` exactly (nothing of `Preexisting` or `PreChild` drawn)                                                                                                                                                                                                                                                                                |
| `preexisting-skip-excluded-region` | at every step the skip receiver differs from `preexisting-reference` in exactly the two pre-existing rects, every pixel of them, and nowhere else                                                                                                                                                                                                                                                |
| `leg-class-<leg>`               | each classified leg has its expected class; sabotage legs mismatch at exactly the expected steps with steps 0–1 matching; `preexisting` names `pre-existing-object`; `preexisting-skip` names `unknown_items`; `corrupt` fails at `{seq:3, reason:"meta-json"}`                                                                                                                                  |

`gate_passed` is true only when every check passed.

## Gate 0 self-test

```bash
mise exec -- pnpm exec tsx --conditions=development experiments/render-stream/scripts/test/self-test-gate0.ts
```

It runs `classifyLeg` over:

- every class alone;
- every pair of classes, checking precedence and that both reasons are listed;
- each sub-rule;
- a leg without a receiver;
- a session whose `sabotage` is set, or whose getter throws;
- draw-index ties: disjoint (harmless, `success`) against overlapping (`unsupported`), hidden or
  culled members, an unbounded footprint, adjacent rects, a child's rect through its parent.

It then builds a passing evidence tree for the whole layout, with recordings encoded in
render-stream/4 (since G5d; /3 from G4e2) by `test/rs2-test-encoder.ts` (every texture table holding the engine's hue
strip), `applied.json` on `/3`, and PNGs synthesized from the timeline, plus one perturbation per
failure mode (since G2b2 also: an applied `/2` schema, a receiver that fetched the hue strip, an
inline capture session; since the unknown-item skip mode (2026-10-10) also: a skip capture that
never declared skip, one that withholds two items, a skip receiver painting a pre-existing rect or
wrong outside them, and a reference missing the rects). It runs the real `runGate0` on each: 45
scenarios, 237 assertions. It
also checks that `corruptTransactionMeta(golden-2/patch.rs2, 3)` reproduces
`golden-2/corrupt-meta.rs2` byte for byte, and that on an inline stream (a resource record before
seq 1) it still breaks transaction seq 3, not record 3. `test/rs1-test-encoder.ts` (render-stream/1)
stays only while `self-test-gate2.ts` uses it.

# Gate 1

Drives `../fixtures/gate1/` and `../receiver/` through the leg groups of
[`../protocol/gate1-design.md`](../protocol/gate1-design.md) "Q7", then checks them. Groups `g1a`
(increment G1a: retained-state fixture, root geometry), `g1b` (G1b2: the patch sink and its
equivalence with the full sink, the omit-op and patch-drop sabotages, the one-frame
draw-index tie), `g1c` (G1c2: live delivery over the capture library's WebSocket server, credit,
recording/live equivalence, the drop-message sabotage) and `g1d` (G1d: a two-second receiver stall
with coalescing and newest-state recovery, resync, reconnect, a killed receiver, and the
ignore-credit and stale-coalesce sabotages) have landed. Since G2b2 every group runs on
render-stream/4 since G5d (render-stream/3 from G4e2, render-stream/2 from G2b2, render-stream/1 from G1b2 to G2b2). Run it from the repo root:

```bash
mise exec -- pnpm render-stream:gate1 -- \
  --extension "$PWD/experiments/render-stream/capture/build/render_stream_capture.gdextension" \
  --calibration "$PWD/experiments/render-stream/calibration/godot-4.5.1-stable-linux-release.json" \
  [--binary /abs/path/to/linux_release.x86_64] [--out /abs/path/to/fresh/dir] [--legs g1a,g1b,g1c,g1d]
```

The arguments and the refusals are gate 0's. `--out` defaults to
`artifacts/render-stream/gate1/<UTC>/`. `--legs` takes a comma-separated list of groups and
defaults to every landed group. `g1b`, `g1c` and `g1d` without `g1a` refuse with exit 2: g1b
compares against g1a's capture, reference and receiver, g1c and g1d against g1a's reference.
`legs.json` records the groups that ran. The checker evaluates only the checks of groups that ran.
A landed group that did not run is reported as `not-run` and fails the gate. The runner takes about
8 minutes.

The process plumbing is shared with `run-gate0.sh` through `lib/legs.sh`: `write_invocation`,
`wait_owned`, `run_headless`, `run_capture`, `prepare_recording`, `run_receiver_headless`,
`settle_seqs`, `seq_at_frame`, `run_rendered` and `run_rendered_receiver`. `run_capture` takes an
empty quit frame to mean the fixture's own default, and with `CAPTURE_WITH_PATCH=1` (every gate 1
capture) also sets `GRC_STREAM_PATCH_OUT`, so each capture writes `recording.rs2` (full) and
`recording-patch.rs2` (patch). Since G2b2 `run_capture` also sets `GRC_RESOURCE_STORE_DIR`:
`CAPTURE_STORE_DIR` unset or empty means `<capture>/store`, the literal `none` omits the variable,
anything else is used as the store (reset after the call, like `CAPTURE_EXTRA_ENV`).
`run_receiver_headless <dir>` always sets `RS_RECEIVER_CACHE_DIR=<dir>/cache`, and
`RS_RECEIVER_STORE_DIR` when `RECEIVER_STORE_DIR` is non-empty (reset after the call).
`run_rendered_receiver` takes `RECEIVER_SOURCE` (replay the patch recording),
`RECEIVER_EXTRA_SHOTS` (the tie seq), `RECEIVER_STATE=1` (`RS_RECEIVER_STATE_SEQS` at the settle
seqs) and `RECEIVER_EXTRA_ENV` (an array of extra `NAME=value` words), all reset after the call; it
always sets `RS_RECEIVER_CACHE_DIR=<receiver>/cache`, and `RS_RECEIVER_STORE_DIR=<capture>/store`
when that directory exists. Every launch strips `GS_STRIP_VARS`, which lists every variable
gate1-design.md introduces plus `RS_FIXTURE_SHOT_FRAMES` and `RS_FIXTURE_TIE`, and every other
inherited `GRC_*` and `RS_*`. Each group's rendered legs share one private gamescope. G1c2 added
`start_headless_bg`/`finish_bg` (a live host runs in the background while its receiver runs) and
`RENDERED_EXTRA_ARGS` (a rendered live receiver gets `--max-fps 60`). G1d added
`LIVE_RECEIVER_ENV` (the receiver's G1d option for one leg) and `killed_receiver` (a background
headless live receiver, SIGKILLed once the host's `tap/live-1.jsonl` reaches a frame).

## Gate 1 files

- `run-gate1.sh`: the orchestrator (`--legs` groups; `run_g1a`, `run_g1b`, `run_g1c` with
  `start_live_host`, `live_receiver` and `live_windows`; `run_g1d` with `killed_receiver`).
- `lib/legs.sh`: the shared leg plumbing (above).
- `lib/gate1-expected.ts`: the `render-stream-gate1-expected/1` types (with `draw_index_ties`),
  `stepFrames`, and `synthesizeGate1(expected, step)` (clear colour, then every draw in paint
  order, clipped).
- `lib/gate1-checks.ts`: `statesOf` (resolved per-transaction states from gate 0's
  `summarizeRecording`), `mapNames`, `evaluateInvariants`, `patchDivergence`, `classifyGate1`,
  `recordingTies`, every check and `runGate1`. It reuses gate 0's `classifyLeg`, the capture,
  manifest, consumption, fixture-access and typed-receiver checks, the step join and the tie
  analysis.
- `lib/gate1-live-checks.ts` (G1c2): the live legs' evaluation and classification
  (`evaluateLiveLeg`, `deliveryReport`, which recomputes in-flight transactions from the host's
  live log), the g1c checks and the report's `live` object.
- `lib/gate1-g1d-checks.ts` (G1d): the g1d legs' evaluation and classification
  (`evaluateG1dLeg`, per host connection; `stallReport`, which reads the stall, the pending target
  and the recovery off the host's live log), the g1d checks and the report's `g1d` object.
- `gate0-tool.ts live-shot-seqs <applied.json>`: the seqs a live receiver shot (for `live-replay`).
- `check-gate1.ts`: writes `<out>/result.json` (`render-stream-gate1-report/1`) and exits
  non-zero unless `gate_passed`.
- `test/self-test-gate1.ts` and `test/rs2-test-encoder.ts`: see "Gate 1 self-test" below.

## Gate 1 legs and evidence under `--out`

Process directories are laid out as at gate 0. Capture directories hold both recordings, the
resource store `store/` and `evidence/root.json` (`render-stream-root-geometry/1`, quoted in the
report; the root geometry the checks use is the session's). The `capture` and `root-size-observe` captures and the
`reference` also hold `root.jsonl` (`RS_FIXTURE_ROOT_LOG`). The tie frames are `S + N` (11, step
1's `T`) and, since G1e, `S + 11N` (111, step 11's `ZP`) and `S + 12N` (121, step 12's `ZB`/`BP`).

| Group | Leg                       | Directory                                   | Runs                                                                                                                                                                  | Expected class                                                                                                                                    |
| ----- | ------------------------- | ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| g1a   | `import`                  | `import/{fixture,receiver}/`                | mise editor `--import` of `fixtures/gate1` and `receiver`                                                                                                             | — (exit 0)                                                                                                                                        |
| g1a   | `receiver-typecheck`      | `receiver-typecheck/{selftest,minimal}/`    | as gate 0, for `receiver-typed-clean`                                                                                                                                 | —                                                                                                                                                 |
| g1a   | `capture`                 | `capture/`                                  | template `--headless`, `GRC_MODE=arm`, `GRC_ROOT_SIZE=enforce-min-size`, both sinks, quit 400, root log, under strace; maps/fd at `armed.marker`                      | `success` (its three ties, at frames 11, 111 and 121, are harmless)                                                                               |
| g1a   | `sabotage-omit-<name>`    | `sabotage-omit-<name>/{capture,receiver}/`  | capture (enforce, default quit 132) with `GRC_SABOTAGE=omit-update` at step k's frame `1+10k`, then a rendered receiver                                               | `pixel-mismatch`: modulate (k=1) {1..12}, transform (2) {2..12}, order (3) {3}, visibility (7) {7..12}                                            |
| g1a   | `root-size-observe`       | `root-size-observe/{capture,receiver}/`     | capture with `GRC_ROOT_SIZE` unset (root log), then a rendered receiver                                                                                               | `unsupported` (`degenerate-host-size`), mismatching only in `corner` and `corner-degenerate`                                                      |
| g1a   | `receiver-headless-trace` | `receiver-headless-trace/`                  | headless receiver on the capture recording under `strace -e openat`                                                                                                   | — (applied ok)                                                                                                                                    |
| g1a   | `reference`               | `reference/`                                | template in gamescope, extension absent, shots `step-0..12` and `frame-{11,111,121}` (`RS_FIXTURE_SHOT_FRAMES`), step log, root log                                   | — (16 shots)                                                                                                                                      |
| g1a   | `receiver`                | `receiver/`                                 | template in gamescope on `capture/recording.rs2`, shots at the 13 settle seqs and the 3 tie seqs, state dumps at the settle seqs                                      | `success`                                                                                                                                         |
| g1b   | `receiver-patch`          | `receiver-patch/`                           | as `receiver`, on `capture/recording-patch.rs2`                                                                                                                       | `success`                                                                                                                                         |
| g1b   | `sabotage-omit-free`      | `sabotage-omit-free/{capture,receiver}/`    | capture with `GRC_SABOTAGE=omit-op`, `GRC_SABOTAGE_OP=free` from step 8's frame (81), then a rendered receiver                                                        | `pixel-mismatch` {8,9,10,11,12}                                                                                                                   |
| g1b   | `sabotage-omit-visible`   | `sabotage-omit-visible/{capture,receiver}/` | `omit-op` `canvas_item_set_visible` from step 6's frame (61)                                                                                                          | `pixel-mismatch` {6}                                                                                                                              |
| g1b   | `sabotage-patch-drop`     | `sabotage-patch-drop/{capture,receiver}/`   | capture with `GRC_SABOTAGE=patch-drop-item` at step 5's frame (51), then a rendered receiver on its patch recording                                                   | `capture-failure` (`patch-divergence`)                                                                                                            |
| g1c   | `live-headless`           | `live-headless/{host,receiver}/`            | live host (below) + headless live receiver under `strace -e openat`, credit stage `applied`, no shots                                                                 | `success`                                                                                                                                         |
| g1c   | `live`                    | `live/{host,receiver}/`                     | live host + rendered live receiver (`--max-fps 60`), shot windows `k:[S+Nk+7, S+N(k+1)-1]` for steps 0..12, the last ending at the quit frame                         | `success`                                                                                                                                         |
| g1c   | `live-replay`             | `live-replay/`                              | rendered file-mode receiver on `live/receiver/received.rs2` (inline: no store, a fresh cache), shooting (and dumping) the live shots' seqs                            | `success`                                                                                                                                         |
| g1c   | `sabotage-drop-message`   | `sabotage-drop-message/{host,receiver}/`    | live host with `GRC_SABOTAGE=drop-message`, `GRC_SABOTAGE_FRAME=S+4N+20` (560), + rendered live receiver                                                              | `replay-failure` (`seq-gap`), failing at the seq after the dropped one                                                                            |
| g1b   | `tie-overlap`             | `tie-overlap/{capture,reference,receiver}/` | capture with `RS_FIXTURE_TIE=overlap` (T over P), the variant's rendered reference with `frame-11`, a rendered receiver shooting the tie seq                          | `unsupported` (`draw-index-tie`); only the step-1 tie is not harmless, the two G1e ties still are; the tie frame's pixels are measured, not gated |
| g1d   | `live-stall`              | `live-stall/{host,receiver}/`               | live host + rendered live receiver with `RS_RECEIVER_STALL=1:2000` (blocks 2 s after its step 1 shot, before that seq's `submitted` ack)                              | `success`; the step windows wholly inside the stall (step 2) may be missed                                                                        |
| g1d   | `live-reconnect`          | `live-reconnect/{host,receiver}/`           | live host + rendered live receiver with `RS_RECEIVER_RECONNECT=4` (close 1000, dispose, connection 2)                                                                 | `success`                                                                                                                                         |
| g1d   | `live-resync`             | `live-resync/{host,receiver}/`              | live host + rendered live receiver with `RS_RECEIVER_RESYNC=6` (refuses step 6's first transaction, sends `resync`)                                                   | `success`                                                                                                                                         |
| g1d   | `live-receiver-killed`    | `live-receiver-killed/{host,receiver}/`     | live host + headless live receiver, SIGKILLed once the host log shows frame `S+5N` (600); `receiver/killed.json`                                                      | — (`host-survives-receiver-loss`)                                                                                                                 |
| g1d   | `sabotage-ignore-credit`  | `sabotage-ignore-credit/{host,receiver}/`   | live host with `GRC_SABOTAGE=ignore-credit` from `S+3N` (480) + rendered live receiver with `RS_RECEIVER_STALL=3:500` (holds its credit 500 ms after the step 3 shot) | `delivery-violation` (in flight, sent without credit), every violation at or after 480                                                            |
| g1d   | `sabotage-stale-coalesce` | `sabotage-stale-coalesce/{host,receiver}/`  | live host with `GRC_SABOTAGE=stale-coalesce` from `S+N` (360) + rendered live receiver with `RS_RECEIVER_STALL=1:2000`                                                | `delivery-violation` (`stale-state`), naming the first post-stall transaction                                                                     |

A live host is the template, `--headless --max-fps 60`, armed, `GRC_ROOT_SIZE=enforce-min-size`,
both file sinks with their store (`GRC_RESOURCE_STORE_DIR=<host>/store`), `GRC_LIVE_LISTEN=127.0.0.1:0`, `GRC_LIVE_TAP_DIR=<host>/tap`, and the live timeline
`RS_FIXTURE_START_FRAME=300`, `RS_FIXTURE_STEP_FRAMES=60`, `RS_FIXTURE_QUIT_FRAME=1080` (`S + 13N`; 960 before G1e). The runner
waits for `evidence/live.json` and passes its port to the receiver. Host directories hold
`evidence/{result,live,live-summary,root}.json`, both recordings, `steps.jsonl`,
`tap/stream-1.rs2` (every binary message formed for connection 1) and `tap/live-1.jsonl` (the live
log); live receiver directories hold `applied.json` (`mode: live`), `received.rs2`,
`shots/seq-<n>.png` and `state/seq-<n>.json`. After a reconnect (G1d) the host also holds
`tap/stream-2.rs2` and `tap/live-2.jsonl`, and the receiver `received-2.rs2`,
`shots/stream-2-seq-<n>.png` and `state/stream-2-seq-<n>.json`. Frame lines of the live log carry
`pending_since` (the frame the pending target became pending, or null) and the summary
`max_pending`, `pending_episodes`, `max_pending_frames`, `max_pending_age_us`,
`sent_without_credit` and `stale_sent`. Since G4e2 the subprotocol is `render-stream.3` (`render-stream.2` from G2b2). A live
connection carries payloads of at most `inline_max_bytes` as resource records, one binary message
each, right before the transaction that first needs them (a `resource` event line; the summary's
`resource_records`/`resource_bytes`), and since G2c2 serves larger ones over HTTP: gate 1's hosts
run the default out-of-band policy, so every live receiver gets a fresh `cache/`, although no
gate 1 command names a texture and nothing is fetched. Not every message after the first is
necessarily a transaction, so the checks find transactions by seq only.

## Gate 1 classification

`classifyGate1` takes gate 0's `classifyLeg` result (draw-index ties included: a harmless tie is
listed, not a reason), the leg's session and the frame-by-frame comparison of its capture's two
sinks (canvases, items, the default texture filter/repeat and the texture table). It adds three rules. A recording without a session is `capture-failure`. A patch sink that
does not resolve, bit for bit, to the full sink's state at every frame is `capture-failure`
(`patch-divergence`). A session `host_size_status` other than `match` is `unsupported`
(`degenerate-host-size`); under `enforce-min-size` the recording also carries the
`root-size-enforce-failed` failure, which gate 0's rules already make `capture-failure`. The
precedence is gate1-design.md Q7's: `capture-failure`, `unsupported`, `replay-failure`,
`delivery-violation`, `pixel-mismatch`, `success`. Checkpoints
compare the full frame, all eleven `expected.json` regions (nine plus G1e's `z-relative` and
`behind`), and count the mismatching pixels outside every region; a checkpoint names its leg and stream (`full` or `patch`).

Live legs (`gate1-live-checks.ts`) add: `capture-failure` for a host that did not listen or a tap
that is not a valid stream (a tap the receiver closed before the end record may lack it);
`replay-failure` for the receiver's status, end record, transactions that are not exactly the
received stream, received bytes that differ from the host's tap, a receiver that joined late (its
first applied frame at or after step 0's settle frame), and a step window without a shot
(rendered legs); `delivery-violation` for two transactions in flight (recomputed from the log's
own ack lines), a send logged without credit, queued bytes above the largest credit window (a
transaction plus the messages sent ahead of it since the previous one: resource records, and for
seq 1 the magic and session) + 4096, and
`stale-state`: a tapped transaction whose resolved state differs from the full recording's at its
frame; `pixel-mismatch` for a step shot that differs from the reference. `live-replay` is
classified as a file-mode receiver on the received stream, shooting the live shots' seqs.

G1d legs (`gate1-g1d-checks.ts`) apply the same rules to every host connection, with two
exceptions. A connection the receiver closed itself (the first one of a reconnect) may stop short
of the host's tap: what it received must be a byte prefix of the tap, and may lack the end record.
A stall leg may miss exactly the step windows that lie wholly between the stalled seq's send and
the recovery send, as the host log places them; any other missing shot is `replay-failure`.

## Gate 1 criteria

| Check                                                                                                                           | Passes when                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `expected-self-consistent`                                                                                                      | `expected.json` obeys its rules: 640×360, steps 0..12, every colour on the 51-step grid with alpha 255, every draw inside a region and none in `[0,0,72,72]`, one marker colour per step used by nothing else, known names, step 10 = step 9 shifted                                                                                                                                                                                                                                                             |
| `capture-armed`, `headless-no-gpu`, `recording-decodes`, `manifest-present`, `receiver-consumed-stream`, `receiver-typed-clean` | gate 0's checks, on the gate 1 layout (400 transactions, the /2 feature arrays and file `resources`, an enforced `match` host, applied `/3` with no texture traffic)                                                                                                                                                                                                                                                                                                                                             |
| `step-alignment`                                                                                                                | capture and reference `steps.jsonl` list 0..12 at `S+N·k` (settle `+7`); each step's marker colour first appears at its applied frame                                                                                                                                                                                                                                                                                                                                                                            |
| `expected-image-reference`, `expected-image-receiver`                                                                           | every reference shot, and every receiver settle shot, equals `synthesizeGate1(k)` exactly                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `receiver-vs-reference`                                                                                                         | 13 steps, full frame and every region, 0 mismatched pixels and max channel delta 0                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `retained-invariants`                                                                                                           | every `expected.json` invariant holds on its step's settle transaction. Names map to wire ids in creation order, cross-checked against the step-0 rect colours                                                                                                                                                                                                                                                                                                                                                   |
| `root-geometry`                                                                                                                 | gate1-design.md Q1 1–3 from the session: logical size = the reference's content scale size, visible size and window size; the enforced host declares `match`, `host_visible_rect` `0,0,640,360`, identity `host_final_xform` and a 640×360 window, and its `root.jsonl` equals the reference's except `display_server`; canvas 1's transform at every settle equals the reference's (float32)                                                                                                                    |
| `receiver-never-loaded-fixture`                                                                                                 | gate 0's check, against `fixtures/gate1/`, scanning every g1a and g1b receiver log                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `patch-resolves-to-full` (g1b)                                                                                                  | the capture's patch sink is valid and resolves to the full sink's state at every frame (texture table and default filter/repeat included), floats bit for bit                                                                                                                                                                                                                                                                                                                                                    |
| `patch-first-full` (g1b)                                                                                                        | patch sink: seq 1 full, every later seq a patch on `seq-1`; full sink all full; one `session_id`, two `stream_id`s; end stats agree                                                                                                                                                                                                                                                                                                                                                                              |
| `patch-transform-only` (g1b)                                                                                                    | at step 2's frame `P` and `C` carry `commands:null` (`G` unchanged, absent) and `cmd_f32` holds only `R1`'s and the `Marker`'s floats; at step 10's frame canvas 1 is present and every item entry but the `Marker`'s carries `commands:null`; neither patch has a `textures` entry or a `removed_textures` id                                                                                                                                                                                                   |
| `patch-vs-full-pixels` (g1b)                                                                                                    | `receiver-patch`'s 13 settle shots equal `receiver`'s and the reference's exactly                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `patch-vs-full-receiver-state` (g1b)                                                                                            | at every settle seq both receivers' state dumps equal each other and the full recording's resolved state, and both made the same RenderingServer calls at every seq                                                                                                                                                                                                                                                                                                                                              |
| `patch-bytes` (g1b)                                                                                                             | recorded, not gated: both sinks' end stats and per-transaction bytes                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `draw-index-ties` (g1b)                                                                                                         | the capture recording's invariant-9 ties are exactly `expected.json`'s `draw_index_ties` (frame 11 `{P, T}`, frame 111 `{P, ZP}`, frame 121 `{P, ZB, BP}`, all harmless), each declared on the wire                                                                                                                                                                                                                                                                                                              |
| `tie-frame-pixels` (g1b)                                                                                                        | `reference/shots/frame-<f>.png` equals both receivers' shot of that transaction exactly, for each of frames 11, 111 and 121                                                                                                                                                                                                                                                                                                                                                                                      |
| `live-listening` (g1c)                                                                                                          | every live host's `evidence/live.json` says `listening` on 127.0.0.1 or ::1 with an ephemeral port, `result.json` `live.port` agrees, and the receiver's URL used that port                                                                                                                                                                                                                                                                                                                                      |
| `live-handshake` (g1c)                                                                                                          | `live`, `live-headless`: subprotocol `render-stream.3` (since G4e2) negotiated, the host logged the hello (credit stage `submitted` / `applied`, the receiver's inbound buffer), one connection, no host error, the end record sent, and the receiver closed with 1000 after reading it                                                                                                                                                                                                                                       |
| `live-tap-equals-received` (g1c)                                                                                                | `live`, `live-headless`: `received.rs2` is byte-identical to the host's `tap/stream-1.rs2`, as `applied.json` `streams[0]` reports                                                                                                                                                                                                                                                                                                                                                                               |
| `live-decodes` (g1c)                                                                                                            | `validateRecording(received.rs2)` is `[]` for `live` and `live-headless`                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `live-first-full-then-patch` (g1c)                                                                                              | the live session is `websocket`, connection 1, `patch`, the capture's `session_id`, a fresh `stream_id`; seq 1 full, every later seq a patch on `seq-1`                                                                                                                                                                                                                                                                                                                                                          |
| `live-resolves-to-recording` (g1c)                                                                                              | every live transaction, resolved, equals the full recording's state at its frame (texture table included), bit for bit                                                                                                                                                                                                                                                                                                                                                                                           |
| `live-replay-equals-live` (g1c)                                                                                                 | `live-replay` applied the same seqs with the same record hashes, and its shots and state dumps at the live shots' seqs equal the live receiver's                                                                                                                                                                                                                                                                                                                                                                 |
| `live-vs-reference` (g1c)                                                                                                       | `live` shot every step window, each shot equal to the reference's `step-<k>.png` and `synthesizeGate1(k)` exactly                                                                                                                                                                                                                                                                                                                                                                                                |
| `live-credit-bounded` (g1c)                                                                                                     | every live host log: at most one transaction in flight (recomputed), no send without credit, `queued_bytes` within the largest credit window + 4096                                                                                                                                                                                                                                                                                                                                                              |
| `live-acks-staged` (g1c)                                                                                                        | per seq `received_us <= applied_us <= submitted_us` (`submitted_us` null headless); the host saw every stage of every sent seq, matching the receiver's ack counts; `presented` is `"unavailable"`                                                                                                                                                                                                                                                                                                               |
| `live-receiver-late` (g1c)                                                                                                      | every live receiver's first applied transaction has a frame before step 0's settle frame (`S+7`)                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `receiver-never-loaded-fixture-live` (g1c)                                                                                      | the headless live receiver's trace opens nothing under `fixtures/` and opens its `received.rs2`; its argv passes `--path <receiver>`; no live receiver log has a `[fixture]` line                                                                                                                                                                                                                                                                                                                                |
| `stall-observed` (g1d)                                                                                                          | `live-stall`: the receiver's `live.stall` is the requested step, declared `injected`, blocked at least the requested 2000 ms, right after that step's shot                                                                                                                                                                                                                                                                                                                                                       |
| `sim-kept-running` (g1d)                                                                                                        | `live-stall`: from the stalled seq's send to its credit the host logged a frame line for every frame, at least 0.8 × 60 × 2 = 96 of them, at an average interval of at most 1.25 × 1/60 s, and the fixture applied at least one step in between                                                                                                                                                                                                                                                                  |
| `pending-bounded` (g1d)                                                                                                         | `live-stall`: through the whole leg at most one transaction in flight (recomputed) and one pending target, queued bytes within the largest credit window + 4096, nothing sent between the stalled seq and its credit                                                                                                                                                                                                                                                                                             |
| `coalesced` (g1d)                                                                                                               | `live-stall`: the coalesced counter grew by one per pending frame line, at least (frames from the first in-stall pending target to the credit) − 2, and the target became pending at the first in-stall step's frame (or the next)                                                                                                                                                                                                                                                                               |
| `newest-after-stall` (g1d)                                                                                                      | `live-stall`: the first transaction after the credit is a patch on the stalled seq, sent at most 2 frames after the credit, not stale, and equal to the full recording's state at its frame                                                                                                                                                                                                                                                                                                                      |
| `stall-pixels` (g1d)                                                                                                            | `live-stall`: the missed steps are exactly the windows inside the stall, every shot equals the reference, and the first post-stall shot shows every pixel the in-stall step changed that still shows then                                                                                                                                                                                                                                                                                                        |
| `reconnect-fresh-session` (g1d)                                                                                                 | `live-reconnect`: connection 1 closed by the receiver with 1000; connection 2 has a fresh `stream_id`, the same `session_id`, seq 1 full and equal to the full recording, then patches on its own seqs only, and validates                                                                                                                                                                                                                                                                                       |
| `reconnect-clean-slate` (g1d)                                                                                                   | `live-reconnect`: `dispose` freed exactly the RIDs the applier owned (created − freed while applying), none left; every connection-2 shot equals the reference                                                                                                                                                                                                                                                                                                                                                   |
| `resync-full` (g1d)                                                                                                             | `live-resync`: the refused seq is `skipped: "resync"`, never acked past `received`; the host logged the credited `resync`, the next transaction is full with `base_seq` null (2 full in all, 1 resync); the shots from step 6 on equal the reference                                                                                                                                                                                                                                                             |
| `host-survives-receiver-loss` (g1d)                                                                                             | `live-receiver-killed`: the receiver was SIGKILLed at or after frame 600, the host's connection closed 1006, the fixture logged its quit frame, the host exited 0, and both file sinks validate with an end record and reach the quit frame                                                                                                                                                                                                                                                                      |
| `leg-class-<leg>`                                                                                                               | each classified leg has its expected class; ignore-credit's violations start at or after its sabotage frame and the host counted sends without credit; stale-coalesce's first post-stall transaction is the stale one; sabotage legs mismatch at exactly their step sets; `root-size-observe` names `degenerate-host-size`, declares `degenerate-visible` with a 64×64 `host_visible_rect`, and mismatches in exactly `corner` and `corner-degenerate`; `tie-overlap`'s only tie is the step-1 tie, not harmless |

## Gate 1 self-test

```bash
mise exec -- pnpm exec tsx --conditions=development experiments/render-stream/scripts/test/self-test-gate1.ts
```

It first runs unit cases: `classifyGate1` (no session or a divergent patch sink is
`capture-failure`, a degenerate host is `unsupported`, and the precedence against gate 0's
classes) and `synthesizeGate1`, `mapNames`, `evaluateInvariants` and `recordingTies` on a model of
the fixture's retained state (the three harmless ties: T+P at step 1, and, since G1e, ZP+P at
step 11 and ZB+BP+P at step 12; the overlapping variant; a step-3 tie under
`Q`). It then builds a passing g1a+g1b evidence tree from that model, encoded in render-stream/2
in both encodings by `test/rs2-test-encoder.ts` (the hue strip in every texture table; live streams
inline, its resource record and `resource` event line ahead of seq 1, which seq 1's queued bytes
cover), with `applied.json` on `/3` and PNGs synthesized from `expected.json`.
Each check gets at least one failing perturbation, and the real `runGate1` runs on each tree. The
g1c legs are fabricated from the same model on a short live timeline (S = 30, N = 10): a host tap
and live log with one send every second frame, a receiver that shoots each step window, the
replay, the headless leg and the drop leg; the g1c perturbations cover a send without credit or
with a transaction in flight, oversized queues, a stale target, a tap that differs from the
received bytes, a late receiver, a missed window, wrong live and replay pixels, a missing
`submitted` ack, a host-side close, a non-loopback listener, a drop leg that never failed, a
fixture open, a full transaction after seq 1, a cut stream and missing groups. The g1d legs come
from a small simulation of the host's hub and the receiver on the same timeline (one send every
second frame, a 15-frame stall after the step 1 shot, a reconnect after step 4, a resync in step
6's window, the two sabotages and a killed receiver); the g1d perturbations cover a short stall, a
stall the host barely saw, a send during the stall, a coalesced counter that stops, a stale
recovery, a post-stall shot without the in-stall update, a missed window outside the stall, a
reused `stream_id`, leftover RIDs, a first connection that is not a prefix of its tap, a resync
answered by a patch, a host that did not survive or closed cleanly, sabotages that did not
sabotage (or did so too early), and missing groups. Since G2b2 also: a hue-strip change in a
transform-only patch, receiver state dumps without the texture table or with another default
filter, an applied `/2` schema, a live texture table that differs from the file recording's, queued
bytes past seq 1's credit window, and a `render-stream.1` handshake. 89 scenarios, 402 assertions.

# Gate 1, G1c1: `rs_ws` interop

`rs_ws` (`../capture/src/rs_ws.{h,cpp}`, `../protocol/gate1-design.md` G1c1) is a dependency-free
RFC 6455 WebSocket server on its own I/O thread. Its C++ unit test (`rs_ws` in `ctest`, run by
`build-capture.sh`) covers the handshake, framing, masking and limits against an in-process raw
socket. These two interop tests additionally prove it against two real WebSocket clients, driving
`../capture/test/rs_ws_echo.cpp` (a test-only echo server built alongside the unit test, not linked
into `render_stream_capture`): a text message that is all ASCII digits requests a binary push of
that many bytes (deterministic, `byte[i] = i % 256`); anything else is echoed back as text.

Run both from the repo root, after `build-capture.sh`:

```bash
experiments/render-stream/scripts/build-capture.sh
experiments/render-stream/scripts/test/run-rs-ws-interop.sh
```

Or by hand:

```bash
# Node (built-in WebSocket, Node >= 22; this repo pins Node 24 and has no `ws` package):
# spawns and kills its own rs_ws_echo.
mise exec -- pnpm exec tsx --conditions=development \
  experiments/render-stream/scripts/test/self-test-rs-ws.ts

# Godot (WebSocketPeer), against a separately started rs_ws_echo:
experiments/render-stream/capture/build/rs_ws_echo --port=0   # note the printed port
mise exec -- godot --headless --path experiments/render-stream/receiver --import   # once
RS_WS_ECHO_PORT=<port> mise exec -- godot --headless \
  --path experiments/render-stream/receiver --script res://tests/ws_selftest.gd
```

`self-test-rs-ws.ts` checks: the subprotocol negotiates, a text message is echoed verbatim, a
1 MiB and an 8 MiB binary push arrive byte-exact, and the close is clean. `ws_selftest.gd` checks
the same shapes from the engine's own client: with `inbound_buffer_size` raised to 16 MiB before
`connect_to_url`, an 8 MiB push arrives byte-exact; with the engine's 65535-byte default left in
place, a 1 MiB push closes the connection with 1009 (`modules/websocket/wsl_peer.cpp:405-410`).

**G7n (render-stream/7's listener).** `self-test-rs-ws.ts` also drives `test/rs-ws-g7n.ts`
against `capture/build/rs_live_host`, a test-only host that wires the production `rs_ws` server
and `rs_live` hub around a fixed one-item scene and reads `GRC_LIVE_ALLOWED_ORIGINS`,
`GRC_LIVE_CREDIT_WINDOW_MAX` and the listener sabotages from `GRC_SABOTAGE` as `entry.cpp` does.
It checks /6 and /7 on one listener at once (each stream validates as its own version with
`validateRecording`), the /7 hello token (`error` `unauthorized`, close 1008 with that reason),
403 for a foreign `Origin` on the upgrade, a GET and an `OPTIONS`, CORS headers on GET, the exact
preflight, and the host's evidence. Each listener sabotage must fail exactly its predicted
checks: `token-ignored` the wrong-token and null-token cases, `accept-any-origin` the 403 cases,
`no-cors` the two CORS-header cases. `self-test-rs-ws.ts --capture` runs the same checks against
the real capture library in a headless release template on `../fixtures/gate1/` (imported once;
gate 1's runner does it), which also covers `entry.cpp`'s wiring, `evidence/live.json`, the
`live: 403 origin …` lines and the hook log's preflight line. `RS_G7N_OUT=<dir>` keeps each
host's evidence.

# Gate 2

Drives `../fixtures/gate2/` through the leg groups of
[`../protocol/gate2-design.md`](../protocol/gate2-design.md) "Q7", then checks them. Groups `g2a`
(increment G2a: the fixture, its rendered reference and a same-build repeat, the extension-armed
reference, the RenderingServer texture-call census and the copy and hash at the hook) and `g2b`
(G2b2: render-stream/2 with textures -- the texture table against the hook log, the store and
inline records, cold/warm/patch/inline receivers, a live inline host, the unsupported variant and
the sabotages), `g2c` (G2c2: live resources over HTTP -- hosts serving payloads by hash with
pins and retirement, live receivers fetching before they apply, warm, replay, stall, reconnect and
animate legs, and the unpin, drop-resource and live wrong-hash sabotages), `g2d` (G2d:
`CanvasTexture` -- the typed refusal on a headless host, and per-command filter and repeat, the
`canvas-normal` variant and the omit-canvas-filter sabotage on a rendered host) and `g2e` (G2e:
bearer-token authorization) have landed. g2b, g2c and g2d need g2a's captures and reference, and g2d also
g2b's (`runG2b` judges g2d's legs with g2b's receiver checks), so `--legs g2b`, `--legs g2c` or
`--legs g2a,g2d` is refused. Group `g2f` is **opt-in**: the headless `CanvasTexture` shim
experiment (`GRC_HEADLESS_CANVAS_TEXTURE=synthesize`,
[`../protocol/canvas-texture-headless.md`](../protocol/canvas-texture-headless.md) "Experiment (a)
result"). It is never in the default set and never reported not-run. Name it in `--legs`, alone or
with the others. It is standalone, with its own import when g2a did not run. Run it from the repo
root:

```bash
mise exec -- pnpm render-stream:gate2 -- \
  --extension "$PWD/experiments/render-stream/capture/build/render_stream_capture.gdextension" \
  --calibration "$PWD/experiments/render-stream/calibration/godot-4.5.1-stable-linux-release.json" \
  [--binary /abs/path/to/linux_release.x86_64] [--out /abs/path/to/fresh/dir] [--legs g2a,g2b,g2c,g2d,g2e[,g2f]]
```

The arguments and refusals are gate 1's; `--out` defaults to `artifacts/render-stream/gate2/<UTC>/`.
The runner takes about fifteen minutes for all five groups (g2c's nine and g2e's three live hosts
run 971 frames at 60 frames per second each). It uses `lib/legs.sh` (`run_headless`, `run_capture`,
`run_rendered`, `settle_seqs`, `start_headless_bg`) and one private gamescope per group.
`GS_STRIP_VARS` lists every `GRC_*` and `RS_*` variable gate2-design.md introduces, landed or not.

## Gate 2 files

- `run-gate2.sh`: the orchestrator (`run_g2a`, `run_g2b`, `run_g2c`, `run_g2d`, `run_g2e`, `run_g2f`,
  `run_reference`, `g2_capture`, `g2_capture_rendered`, `g2_receiver`, `start_live_host`,
  `live_windows`, `g2c_receiver`, `g2c_leg`).
- `lib/gate2-expected.ts`: the `render-stream-gate2-expected/1` types, `stepFrames2`,
  `stepOfFrame` (the census windows), `texel`, `sampleAt` and `synthesizeGate2(expected, step,
{variant, frame})`: the clear colour, then every draw in paint order, flat or sampled the way the
  GLES3 canvas shader samples (flip, transpose, then nearest at pixel centres with clamp, modulo or
  mirror wrap), alpha 255 replacing and 0 skipping. Since G2b2 every step also carries
  `receiver_resources`, the fresh-cache receiver's texture traffic derived from D5.
- `lib/gate2-checks.ts`: the hook-log and fixture-log parsers (`render-stream-resource-log/1`
  lines are validated key by key, in order; G2b2's `store`/`inline` lines and trailing
  `sabotage`/`omitted` keys allowed and kept out of the census), `censusOf`/`expectedCensus`,
  every G2a check, `copyCosts` and `runGate2`. It reuses gate 0's capture, no-GPU and recording
  checks and its `classifyLeg`.
- `lib/gate2b-checks.ts`: group g2b: recording loading and resolution (render-stream-2.ts), the
  hook log replayed as ground truth (`textureLogDivergence`), fixture names to wire ids, every
  g2b check, `classifyG2bLeg`/`classifyLive` (gate2-design.md Q7's precedence, resource-violation
  included) and `runG2b`, which also judges g2d's four legs and checks when g2d ran (they reuse
  g2b's reference and receiver checks).
- `lib/gate2c-checks.ts`: group g2c: each live leg's host (per connection: tap, live log, gate 1's
  `deliveryReport`) and receiver, `pinsReport` (the pin and retire lines replayed against the full
  recording's state united with every open connection's base, frame by frame),
  `unadvertisedGets`, `getsVsFetches`, `fetchesAfterApplied`, the live checkpoints (the animate
  variant's anim region against `synthesizeGate2` at the shot's frame), every g2c check,
  `classifyG2cLeg` and `runG2c`.
- `lib/gate2e-checks.ts`: group g2e: `classifyG2eLeg` (host health plus the receiver's own
  `applied.json` status -- no pixel or resource-traffic comparison, unlike g2b/g2c, since
  gate2-design.md G2e's own checks ask for neither), `checkAuthRequired` (the host log shows
  401s exactly for the sabotage requests), `checkTokenNotLogged` (a raw byte search of every file
  under each g2e leg for its own host-generated token, `evidence/live-token` itself excepted) and
  `runG2e`.
- `lib/gate2f-checks.ts`: group g2f (opt-in): the shim's evidence (`canvas-texture-shim.json`,
  `result.json` `canvas_texture_shim`), private-RID helpers (`isSyntheticRid`, `ridIndex`), every
  g2f check and `runG2f` (classification through `classifyG2bLeg`).
- `check-gate2.ts`: writes `<out>/result.json` (`render-stream-gate2-report/1`) and exits non-zero
  unless `gate_passed`.
- `test/self-test-gate2.ts`, `test/gate2b-fixture.ts`, `test/gate2c-fixture.ts`: see below.

## Gate 2 legs and evidence under `--out`

| Leg                           | Group | Directory                             | Runs                                                                                                                                                                                                              |
| ----------------------------- | ----- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `import`                      | g2a   | `import/{fixture,receiver}/`          | the mise editor's `--import` of `fixtures/gate2` and `receiver/`                                                                                                                                                  |
| `capture`                     | g2a   | `capture/`                            | the release template, `--headless`, armed, both sinks, the store, `GRC_ROOT_SIZE=enforce-min-size`, quit 400, strace + maps                                                                                       |
| `capture-unsupported`         | g2a   | `capture-unsupported/`                | the same with `RS_FIXTURE_VARIANT=unsupported`, the fixture's own quit frame, no strace                                                                                                                           |
| `reference`                   | g2a   | `reference/`                          | rendered in gamescope, extension absent: `shots/step-0..11.png`                                                                                                                                                   |
| `reference-repeat`            | g2a   | `reference-repeat/`                   | the same again                                                                                                                                                                                                    |
| `reference-armed`             | g2a   | `reference-armed/`                    | rendered, extension armed with `GRC_STREAM_OUT` and a store (so the hooks copy and hash), shots                                                                                                                   |
| `capture-inline`              | g2b   | `capture-inline/`                     | capture with `GRC_RESOURCE_INLINE_MAX_BYTES` = `GRC_RESOURCE_MAX_PAYLOAD_BYTES` = 16 MiB (delivery `inline`), no store, quit 400                                                                                  |
| `receiver-cold`               | g2b   | `receiver-cold/`                      | rendered receiver on `capture/recording.rs2`, fresh `cache/`, store = `capture/store`, shots and state dumps at the 12 settle seqs                                                                                |
| `receiver-warm`               | g2b   | `receiver-warm/`                      | a new rendered receiver on `receiver-cold/cache` with `RS_RECEIVER_CACHE_MODE=warm`                                                                                                                               |
| `receiver-patch`              | g2b   | `receiver-patch/`                     | rendered receiver on `capture/recording-patch.rs2`, its own fresh cache                                                                                                                                           |
| `receiver-inline`             | g2b   | `receiver-inline/`                    | rendered receiver on `capture-inline/recording.rs2`, fresh cache, no store                                                                                                                                        |
| `receiver-headless-trace`     | g2b   | `receiver-headless-trace/`            | headless receiver on `capture/` under `strace -e openat`                                                                                                                                                          |
| `live-inline`                 | g2b   | `live-inline/{host,receiver}/`        | host (`GRC_LIVE_LISTEN`, S = 300, N = 60, both sinks and a store) + headless live receiver (`applied` credit)                                                                                                     |
| `reference-unsupported`       | g2b   | `reference-unsupported/`              | rendered fixture, `RS_FIXTURE_VARIANT=unsupported`, extension absent                                                                                                                                              |
| `unsupported-textures`        | g2b   | `unsupported-textures/receiver/`      | rendered receiver on `capture-unsupported/`                                                                                                                                                                       |
| `sabotage-<name>`             | g2b   | `sabotage-<name>/{capture,receiver}/` | omit-update (`omit-op texture_2d_update` @61), omit-replace (`omit-op texture_replace` @71): captures + rendered receivers; stale-texture @61, wrong-hash @61, spurious-update @21: captures + headless receivers |
| `sabotage-receiver-*`         | g2b   | `sabotage-receiver-*/receiver/`       | headless receivers on `capture/`: `RS_RECEIVER_SABOTAGE=reupload` (fresh cache), `ignore-cache` (warm, on a copy of `receiver-cold/cache`)                                                                        |
| `live`                        | g2c   | `live/{host,receiver}/`               | live host (S = 300, N = 60, quit 971, both sinks, store, tap; fetch http) + rendered live receiver, fresh `cache/`, shot windows for the 12 steps                                                                 |
| `live-replay`                 | g2c   | `live-replay/`                        | rendered file-mode receiver on `live/receiver/received.rs2`, store = `live/receiver/cache`, shots and state dumps at live's shot seqs                                                                             |
| `live-warm`                   | g2c   | `live-warm/{host,receiver}/`          | a new host + a new rendered receiver on `live/receiver/cache`, mode warm                                                                                                                                          |
| `live-headless`               | g2c   | `live-headless/{host,receiver}/`      | host + headless receiver (`applied` credit) under `strace -e openat`                                                                                                                                              |
| `live-stall`                  | g2c   | `live-stall/{host,receiver}/`         | `RS_RECEIVER_STALL=5:1300`: the stall ends inside step 6's window, after step 6's texture update                                                                                                                  |
| `live-reconnect`              | g2c   | `live-reconnect/{host,receiver}/`     | `RS_RECEIVER_RECONNECT=7`                                                                                                                                                                                         |
| `live-animate`                | g2c   | `live-animate/{host,receiver}/`       | host `RS_FIXTURE_VARIANT=animate`, receiver `RS_RECEIVER_FETCH_DELAY_MS=100`                                                                                                                                      |
| `sabotage-unpin`              | g2c   | `sabotage-unpin/{host,receiver}/`     | as `live-animate`, host `GRC_SABOTAGE=unpin` from frame 1                                                                                                                                                         |
| `sabotage-drop-resource`      | g2c   | `sabotage-drop-resource/{host,…}/`    | host `drop-resource` @660 (step 6), headless receiver                                                                                                                                                             |
| `sabotage-wrong-hash-live`    | g2c   | `sabotage-wrong-hash-live/{host,…}/`  | host `wrong-hash` @660 (the store's corrupted copy served over HTTP), headless receiver                                                                                                                           |
| `canvas-headless`             | g2d   | `canvas-headless/{capture,receiver}/` | headless capture with `RS_FIXTURE_VARIANT=canvas` (step 11's SC draws through a `CanvasTexture`) + headless receiver: the typed refusal                                                                           |
| `canvas-host`                 | g2d   | `canvas-host/{capture,receiver}/`     | RENDERED capture host (gamescope, armed, store, its own `shots/`; `canvas` variant) + rendered receiver -- host-renderer evidence, not headless support                                                           |
| `canvas-normal`               | g2d   | `canvas-normal/{capture,receiver}/`   | rendered capture host, `RS_FIXTURE_VARIANT=canvas-normal` (CT also gets `normal_texture = B`) + rendered receiver -- host-renderer evidence                                                                       |
| `sabotage-omit-canvas-filter` | g2d   | `sabotage-omit-canvas-filter/{…}/`    | rendered capture host, `canvas` variant with `omit-op canvas_texture_set_texture_filter` @111 (step 11) + rendered receiver -- host-renderer evidence                                                             |
| `live-auth`                   | g2e   | `live-auth/{host,receiver}/`          | host `GRC_LIVE_AUTH=token` (writes `evidence/live-token`) + rendered live receiver, `RS_RECEIVER_TOKEN_FILE` the host's token, shot windows for the 12 steps                                                      |
| `sabotage-no-token`           | g2e   | `sabotage-no-token/{host,receiver}/`  | same host; headless receiver, no `RS_RECEIVER_TOKEN_FILE` -- the upgrade itself is refused (401)                                                                                                                  |
| `sabotage-bad-http-token`     | g2e   | `sabotage-bad-http-token/{host,…}/`   | same host; headless receiver, `RS_RECEIVER_TOKEN_FILE` the host's token (correct on the upgrade) and `RS_RECEIVER_SABOTAGE=wrong-http-token` (wrong on every resource GET)                                        |
| `coding-gzip`                 | g2e   | `coding-gzip/{host,…}/`               | G8kz: host `GRC_HTTP_ENCODING=gzip`; headless receiver (a browser under g7-2) -- gzip-coded bodies |
| `coding-off`                  | g2e   | `coding-off/{host,…}/`                | G8kz: host `GRC_HTTP_ENCODING=off`; headless receiver -- identity bodies, no coding keys in the hook log |
| `coding-receiver-off`         | g2e   | `coding-receiver-off/{host,…}/`       | G8kz, native receivers only: default host (zstd), receiver `RS_RECEIVER_ACCEPT_ENCODING=off` -- identity bodies |
| `sabotage-corrupt-coded-body` | g2e   | `sabotage-corrupt-coded-body/{host,…}/` | G8kz: host `GRC_SABOTAGE=corrupt-coded-body` (a listener sabotage: one byte of every coded body flipped); headless receiver must refuse |
| `reference-canvas`            | g2f   | `reference-canvas/`                   | rendered in gamescope, extension absent, `RS_FIXTURE_VARIANT=canvas`: Godot's own `shots/step-0..11.png` for the variant                                                                                         |
| `shim-headless`               | g2f   | `shim-headless/{capture,receiver}/`   | headless capture, `canvas` variant, `GRC_HEADLESS_CANVAS_TEXTURE=synthesize`, quit 400, strace + maps; rendered receiver -- success                                                                              |
| `shim-sabotage-omit-canvas-filter` | g2f | `shim-sabotage-omit-canvas-filter/{…}/` | as `shim-headless` (fixture quit), `omit-op canvas_texture_set_texture_filter` @111; rendered receiver -- pixel-mismatch {11}                                                                              |
| `shim-off`                    | g2f   | `shim-off/{capture,receiver}/`        | headless capture, `canvas`, `GRC_HEADLESS_CANVAS_TEXTURE=off`; headless receiver -- unsupported (`canvas-texture-headless`), the default                                                                          |
| `shim-refused-rendered`       | g2f   | `shim-refused-rendered/capture/`      | RENDERED capture host (gamescope), `canvas`, the opt-in set: refused `canvas-texture-shim-not-headless`, nothing hooked, the fixture's own `shots/`                                                               |
| `shim-invalid`                | g2f   | `shim-invalid/capture/`               | headless, `GRC_HEADLESS_CANVAS_TEXTURE=bogus`: refused `canvas-texture-shim-invalid`                                                                                                                              |
| `shim-gate5-canvas`           | g2f   | `shim-gate5-canvas/`                  | headless capture of `fixtures/gate5` (its own import under `import/gate5-fixture/`), `RS_FIXTURE_VARIANT=canvas`, the opt-in: gate 5's D11 refuses nothing -- success                                          |

Every fixture run writes `steps.jsonl` and `textures.jsonl` (`RS_FIXTURE_TEXTURE_LOG`). Every armed
run writes `evidence/resources.jsonl` (the hook log) and `evidence/root.json`, whose additive
`texture_defaults` holds the arm-time root filter and repeat. Payloads are written only under the
run directory: each capture's `store/`, each receiver's `cache/`.

## Gate 2 criteria (g2a)

`capture-armed` (56 hooks), `headless-no-gpu` and `recording-decodes` (400 transactions) are gate
0's. `step-alignment` reads the four step logs and the capture's marker colours.
`expected-image-reference` compares every reference shot with `synthesizeGate2` exactly outside the
step's `synth_exclude` regions. `reference-repeat-budget` diffs `reference` against
`reference-repeat` per region per step, fails on any difference outside `synth_exclude`, and
records the per-region maxima as the budget for later increments (`result.json` `repeat_budget`).
`armed-transparent` requires `reference-armed`'s shots to equal `reference`'s byte for byte.
`census` counts the hook log per step window in the capture and in `reference-armed` and requires
`expected.json` `census` exactly; only frees may follow the quit frame (scene teardown).
`hook-bytes-exact` pairs every fixture create and update in a permitted format with a hook line at
the same frame and thread and the same SHA-256, and every other content line with an
`engine_textures` entry. `worker-thread-create` requires D's create to be the only `other`-thread
line. `replace-retires-temp` follows each `texture_replace` back to its by-texture's create in the
same frame and forward to make sure that RID never appears again. `viewport-defaults` checks
`root.json` and the two root viewport filter calls. `unsupported-variant` checks U1's uncopied
`unsupported-format` line, the census with the variant's extras, and the drawn texture RIDs
(`counters.json` texture-rect captures) the log never saw created: none in `capture`, exactly
`PRE` in `capture-unsupported`. `leg-class-capture` requires class `success` (since G2b2 the
texture draws are commands, not unsupported entries) with `add_texture_rect` and
`add_texture_rect_region` in the recording.

## Gate 2 criteria (g2b)

| Check                                   | Passes when                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `recordings-decode-2`                   | both sinks of `capture`, `capture-inline` and `capture-unsupported` pass render-stream-2.ts `validateRecording`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `patch-resolves-to-full`                | each patch sink resolves to its full sink at every seq and frame, textures and defaults included                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `store-complete`                        | every ok hash of either sink is a `sha256/<hash>.grt` in the capture's store that hashes to its name, nothing else is there, `index.jsonl` names each once                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `inline-equals-store`                   | `capture-inline` declares delivery inline / fetch none, equals `capture` at every frame, and every inline payload equals the store's file                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `texture-versions-current`              | every transaction's table (both sinks of three captures and the live host) agrees with the hook log replayed to its frame: version, kind, status, hash; nothing missing, nothing extra                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `texture-invariants`                    | every `expected.json` texture invariant on the capture's settle transactions; no replaced-away (temporary) id ever appears                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `receiver-vs-reference`                 | the cold, warm, patch and inline receivers' settle shots equal the reference's exactly, full frame                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `canvas-texture-headless-refused` (g2d) | `canvas-headless`'s session lists `canvas_texture` under `unsupported_resources` (`canvas-texture-headless`) and not under `resources`; every `canvas_texture_*` hook line is `unsupported`/`canvas-texture-headless` with no id; no transaction has a canvas entry; from step 11 on exactly one item draws an `unsupported` `canvas-texture-headless` command (with its entry), none before; its receiver skips and reports it; `canvas-host` declares `canvas_texture` supported                                                                                                                                                                       |
| `canvas-texture-override` (g2d)         | at step 11 region `sc` of `canvas-host`'s own rendered frame equals `synthesizeGate2` (nearest, repeat enabled), although SC's own item filter is linear and its repeat disabled (the `CanvasTexture`'s own filter and repeat win)                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `canvas-texture-wire` (g2d)             | `canvas-host` carries `CT` as a `kind: "canvas"` entry, diffuse naming `A`'s id, nearest/enabled, its version bumped per setter                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `canvas-normal-region` (g2d)            | `canvas-normal`'s receiver differs from the reference only in region `sc`, and only from step 11 on                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `expected-image-receiver`               | `receiver-cold`'s shots equal `synthesizeGate2` outside `synth_exclude`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `transform-only-no-resource-traffic`    | steps 2 and 10: no texture call in the hook log, empty `textures`/`removed_textures` in the patch sink, every receiver resource counter 0                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `upload-accounting`                     | per step the cold and patch receivers' fetched/created/updated/replaced/freed equal `receiver_resources`; the inline receiver the same uploads with 0 fetches and its payloads inline                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `warm-cache`                            | `receiver-warm` fetches nothing, its hits equal `receiver-cold`'s fetches, and its uploads, `rs_calls`, shots and state dumps are identical                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `fresh-cache`                           | `receiver-cold`'s cache started empty and ends holding exactly its verified fetches                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `freed-draws-default`                   | at step 8 RAW1's rect is white in the reference and the receiver (D11)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `copy-at-hook`                          | at step 8 region `s3` equals the synthesis of C's pre-fill content in the reference and the receiver                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `unsupported-regions`                   | `unsupported-textures` differs from `reference-unsupported` in `u1` and `u2` at every step and nowhere else                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `live-inline`                           | the live session is inline / fetch none, every ok hash arrives as a resource record, `received.rs2` equals the tap, the receiver fetches nothing, and every live transaction equals the host recording at its frame                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `receiver-consumed-stream`              | every file-mode receiver read its own copy of the capture recording                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `receiver-never-loaded-fixture`         | the traced receiver opens nothing under `fixtures/`, opens its recording and reads the store                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `receiver-typed-clean`                  | no receiver log has a SCRIPT ERROR / WARNING / Parse Error                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `leg-class-<leg>`                       | each leg at gate2-design.md G2b2's expected class: receivers and `live-inline` success; `unsupported-textures` unsupported; omit-update pixel-mismatch {6}; omit-replace pixel-mismatch {7..11}; stale-texture capture-failure (texture-log-divergence); wrong-hash replay-failure (resource-hash-mismatch at step 6's seq); spurious-update, reupload, ignore-cache resource-violation (transform-only-resource-traffic, redundant-upload, warm-cache-fetch); g2d: `canvas-headless` unsupported (canvas-texture-headless), `canvas-host` success, `canvas-normal` unsupported (unsupported-texture), `sabotage-omit-canvas-filter` pixel-mismatch {11} |

Classification (`classifyG2bLeg`) takes gate 0's `classifyLeg` for capture-failure, unsupported and
replay-failure, adds capture-failure for a stream reason (store failure, budget) and for
texture-log-divergence, resource-violation for transform-only traffic, redundant fetches and
uploads and warm-cache fetches, and pixel-mismatch from the receiver's settle shots against the
reference; the first class in Q7's precedence wins.

## Gate 2 criteria (g2c)

| Check                                     | Passes when                                                                                                                                                                                                                         |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `live-tap-equals-received`                | each connection's received stream is its tap byte for byte (a prefix only for the connection the reconnecting receiver closed itself)                                                                                               |
| `live-resolves-to-recording`              | every tapped transaction of every g2c host equals the full recording's state at its frame, texture table included                                                                                                                   |
| `live-credit-bounded`                     | per connection, recomputed from its log: one transaction in flight at most, no send without credit, queued bytes within the largest credit window + 4096                                                                            |
| `live-acks-staged`                        | received <= applied <= submitted per seq; per connection the host saw exactly the acks of what the receiver read; presented `unavailable`                                                                                           |
| `live-vs-reference`                       | every rendered live shot per step equals the reference exactly (live-animate: its anim region equals `synthesizeGate2` at the shot's frame instead)                                                                                 |
| `live-replay-equals-live`                 | the file replay of `received.rs2` with live's cache as its store: same seqs and record hashes, same payloads, identical shots and state dumps                                                                                       |
| `http-gets-match-fetches`                 | the host's `http-get` lines equal the receiver's http fetches, hash for hash, byte for byte, in order; each hash at most once per process; every fetch a verified 200 with the immutable headers                                    |
| `gets-advertised`                         | every GET names a hash a transaction already sent on its connection (at an earlier frame callback) names                                                                                                                            |
| `fetch-before-applied`                    | every fetch for seq n ends before n's applied ack (receiver clock), and its GET reached the host no later than that ack (host frames)                                                                                               |
| `pins-bounded`                            | after every frame callback the servable set (replayed from `pin`/`retire`) equals the full recording's ok hashes united with every open connection's base, within `GRC_RESOURCE_BUDGET_BYTES`                                       |
| `obsolete-retired`                        | nothing stays servable once nothing names it, nothing is retired while something does; live-animate's fetched hashes were all sent, fewer ANIM versions were sent than updated, superseded versions retired (counts reported)       |
| `stall-newest-texture`                    | live-stall: step 6's update lands in the stall, the first post-stall transaction carries A1, A1 is fetched once (for it), and its shot equals the reference                                                                         |
| `reconnect-no-refetch`                    | live-reconnect: connection 2 starts full with 0 fetches (cache hits only) and one upload per resident texture; C and D are then fetched once each on connection 2                                                                   |
| `transform-only-no-resource-traffic-live` | steps 2 and 10 on every main-variant live leg: no GET, every receiver resource counter 0                                                                                                                                            |
| `warm-host-no-gets`                       | live-warm's host answers no GET, its receiver hits its cache once per payload live fetched, and its shots equal live's                                                                                                              |
| `leg-class-<leg>`                         | the live legs success; `sabotage-unpin` and `sabotage-drop-resource` replay-failure (`resource-unavailable`), `sabotage-wrong-hash-live` replay-failure (`resource-hash-mismatch`), the last two at the first transaction naming A1 |

Classification (`classifyG2cLeg`) follows Q7: capture-failure (host status and stream reason, the
listener, invalid recordings or taps, texture-log-divergence), unsupported, replay-failure (the
receiver's status and failure, received bytes against the tap, the applied list against the
received stream, a late join, missed shot windows), delivery-violation (gate 1's per-connection
delivery report), resource-violation (redundant fetches or uploads, warm-cache fetches,
unadvertised GETs, transform-only traffic), pixel-mismatch.

## Gate 2 criteria (g2e)

| Check              | Passes when                                                                                                                                                                                                  |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `auth-required`    | the host log shows a 401 upgrade rejection for `sabotage-no-token`, a 401 resource-GET for `sabotage-bad-http-token`, and neither for `live-auth`                                                            |
| `token-not-logged` | each leg's own `evidence/live-token` string appears in no other file under that leg's directory (recordings, hook log, `stdout.log`, `applied.json`, shots -- a raw byte search, so a binary hit counts too) |
| `leg-class-<leg>`  | `live-auth` success; `sabotage-no-token` replay-failure (`live-connect-failed`); `sabotage-bad-http-token` replay-failure (`resource-unavailable`)                                                           |
| `http-content-coding` | G8kz: the default host (`live-auth`) zstd-codes GRT1 bodies smaller than their identity bytes; `coding-gzip` gzip-codes them, `coding-off` logs no coding at all, `coding-receiver-off` gets identity; every receiver fetch matches the host's GET log (coding, `wire_bytes`, Content-Length, per-coding ETag) and is verified on the decoded bytes |
| `corrupt-coded-body` | G8kz: `sabotage-corrupt-coded-body` sent coded bodies with a byte flipped and the receiver refused (`resource-invalid`, `resource-hash-mismatch`, or a browser's `resource-unavailable`); `leg-class-` for the four coding legs: `coding-*` success, the sabotage replay-failure |

Classification (`classifyG2eLeg`) is narrower than g2b/g2c's: host health (armed, stream closed
cleanly, no texture-log-divergence) for capture-failure, and the receiver's own `applied.json`
`status`/`end_seen`/`failure.reason` for replay-failure -- no pixel or resource-traffic comparison,
since gate2-design.md G2e's "Checks" list asks for neither. The WebSocket-upgrade 401 is logged by
entry.cpp's `live_drain()` to the host's `stdout.log` (`rs_ws`'s `AuthRejected` event carries no
hash to put in the structured hook log); the resource-GET 401 is an ordinary `http-get` line in
`evidence/resources.jsonl` with `http_status` 401, already covered by G2c2's logging path.

## Gate 2 criteria (g2f, opt-in)

Each maps onto a pass criterion of canvas-texture-headless.md's experiment (a):

| Check                              | Pass condition                                                                                                                                                                                                                                                                    |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `shim-headless-no-gpu`             | the shim capture host is `headless` and never opens or maps a GPU device or driver library (gate −1's check on `shim-headless/capture`)                                                                                                                                         |
| `shim-reference-canvas`            | `reference-canvas` shot every step; its step-11 region `sc` equals `synthesizeGate2` (nearest, repeat enabled)                                                                                                                                                                  |
| `shim-receiver-vs-reference` (1)   | `shim-headless`'s rendered receiver equals `reference-canvas` byte for byte at every settle seq, full frame; step 11's region `sc` is 0 px off both the reference and `synthesizeGate2`                                                                                          |
| `shim-wire`                        | the headless session declares `canvas_texture` supported, no `unsupported_resources`; every `canvas_texture_*` hook line ok with an id and a private RID; nothing refused; CT at step 11 is canvas/ok/diffuse A/nearest/enabled, version > 1                                      |
| `shim-private-rids` (2)            | every private RID is `0x47524354 << 32` with index ≥ 2^31; disjoint from every RID the hooked creators logged (none dropped, engine indices < 2^31); the create log names exactly the private RIDs; each freed once through `free()`; `engine_allocated` and `foreign_frees` 0 |
| `shim-stdout-clean` (2)            | `shim-headless`'s engine `ERROR`/`WARNING` lines equal `shim-off`'s exactly, and none names a canvas texture or a private RID                                                                                                                                                     |
| `shim-refuses-off-headless` (3)    | `shim-refused-rendered` refused `canvas-texture-shim-not-headless` (non-headless display server, no vptr write, no private RID, no recording, SC still rendered right); `shim-invalid` refused `canvas-texture-shim-invalid`                                                       |
| `shim-off-is-default` (4)          | `=off`: the shim off, no private RID, `canvas_texture` under `unsupported_resources` (`canvas-texture-headless`), every `canvas_texture_*` hook line the typed refusal                                                                                                         |
| `shim-gate5-canvas`                | gate 5's D11 under the shim: `shim-gate5-canvas` classifies success with no unsupported entry, every settle frame's commands are the main gate 5 fixture's expected /4 commands (gate 5's `evaluateCaptureCanvas` with no refusals), one private RID                                  |
| `leg-class-<leg>`                  | `shim-headless` success, `shim-sabotage-omit-canvas-filter` pixel-mismatch {11}, `shim-off` unsupported (`canvas-texture-headless`)                                                                                                                                           |

`test/self-test-gate2f.ts` fails every g2f check except `shim-gate5-canvas` (gate 5's own
`evaluateCaptureCanvas`, covered by `self-test-gate5.ts`) at least once on small fabricated evidence (JSON,
stdout logs, PNGs from `synthesizeGate2`) and passes each on its unperturbed form.

## Gate 2 self-test

```bash
mise exec -- pnpm exec tsx --conditions=development experiments/render-stream/scripts/test/self-test-gate2.ts
```

Unit cases cover `sampleAt` (flips, transpose, S3's rotation, the region across four quadrants,
tile, mirror, clamp, LA8 alpha), `synthesizeGate2` (binary alpha over BG, the freed RAW1, C's
pre-fill content, partial alpha, the animate variant), the step windows, the census helpers, the
hook-log line validation and `checkExpectedSelfConsistent` on the committed file and five broken
copies. A passing g2a-g2e tree is then fabricated (render-stream/2 capture recordings from
`test/rs2-test-encoder.ts`, hook and fixture logs from a model of the fixture's texture calls,
`CanvasTexture` lines included, receivers' applied.json, PNGs from `synthesizeGate2`;
`test/gate2c-fixture.ts` adds every g2c live host with its D7 pin and retire lines, taps and live
logs, and its receiver with http fetches, and the three g2e legs with their tokens, the upgrade
401 and the GET 401), and each check gets at least one failing perturbation; the real `runGate2`
runs on every tree. Group selection is covered too: g2a alone (g2b-g2e not-run), nothing run, and
g2b without g2d (G2d's checks absent, only `group-g2d` not-run).

## Gate 3 files

```bash
mise exec -- pnpm render-stream:gate3 -- \
  --extension "$PWD/experiments/render-stream/capture/build/render_stream_capture.gdextension" \
  --calibration "$PWD/experiments/render-stream/calibration/godot-4.5.1-stable-linux-release.json" \
  [--legs g3a,g3b,g3c,g3d]
```

- `run-gate3.sh`: the orchestrator (`run_g3a`, `run_g3b`, `run_g3c`, `run_g3d`, `run_reference`).
  All four groups have landed.
- `lib/gate3-expected.ts`: the `render-stream-gate3-expected/1` types, `stepFrames3`,
  `synthesizeGate3(expected, step, {clips})` (the clear colour, then every draw in paint order,
  each intersected with its integer scissor; `clips: false` gives the unclipped scene),
  `probesOf`, `pixelAt` and `visibleRect`.
- `lib/clip-derive.ts`: `deriveClipRects(state, viewport, {cullMask, canvas})`. It derives each
  visited item's final scissor from a resolved render-stream/2 state by gate3-design.md Q1c:
  transforms composed from the canvas down in float32, the custom rect or command bounds (texture
  rect flips normalized, transpose swapped), the bounding box, intersection with the rounded
  ancestor scissor, the 0.5 px skip, and position and size rounded half away from zero. An
  uncustomized clip whose bounds hang on an unsupported command derives as `unknown`. It is the
  reference implementation for gate 7's browser receiver.
- `lib/gate3-checks.ts`: every G3a check, `evaluateCapture` (gate 0's `classifyLeg` plus gate 1's
  `classifyGate1`, which adds patch divergence and the root-size declaration), `clipCensusOf` and
  `runGate3`. It reuses gate 0's capture, no-GPU and recording checks and gate 1's name mapping,
  tie detection and patch resolution. G3b adds `gate3LegLayout`, `evaluateG3bLeg` (one
  `Gate3LegEvaluation` per leg of `G3B_CLASSIFIED_LEGS`, built the way gate 1's `evaluateGate1Leg`
  is: `classifyLeg` then `classifyGate1` over that leg's own capture and receiver),
  `computeGate3ReceiverCheckpoints` (the receiver analogue of `compareShotsWithSynth`, joining
  `seq-<n>.png` shots through the capture's `steps.jsonl`), `probeTallyReceiver` and
  `checkLegClass3`, which reads every mismatching-steps / mismatching-regions / failing-probes
  expectation straight from `expected.json` `predictions[leg]` rather than a hand-typed table.
  `checkClipRectsDerived` gained an optional fourth argument so the same check also runs
  `deriveClipRects` over `receiver-patch`'s own resolved `state/seq-<n>.json` dumps.
  `checkReceiverTypedCleanG3b` is g3b's own lighter version of gate 1's receiver-typed-clean
  (gate2b-checks.ts's pattern): g3b has no `receiver-typecheck` leg of its own, so it scans every
  g3b receiver leg's `stdout.log` directly instead. G3d adds `checkCaptureClipIgnoreArmed` (a
  second capture leg under a different directory name, so it cannot reuse gate 0's
  `checkCaptureArmed`, which hardcodes `capture/`), `checkClipIgnoreTyped`,
  `checkExpectedImageReferenceClipIgnore`, `checkCaptureClipIgnoreLegClass` and
  `checkClipIgnoreRegionSet` (the receiver leg's class plus its region-mismatch set over every
  step, reusing G3b's `computeGate3ReceiverCheckpoints`, folded into one `leg-class-*` check).
- `lib/gate3x-expected.ts` (G3c): the `gate3-xform` expected types, `synthesizeGate3x(expected,
  step, {clips})` and `paintDraws`: pixel-centre coverage of each draw (an axis-aligned
  `rect_px`, or a `quad` under rotation) inside its integer scissor, plus the `band` mask, the
  pixels whose centre lies within `band_px` (1.0) of a non-axis-aligned edge inside that draw's
  scissor. The arithmetic (squared segment distances) is make_expected.py's.
- `lib/gate3x-checks.ts` (G3c): every g3c check, `bandDiff`/`overBudget` (exact outside the band,
  a budget inside it), `evaluateLegX` (gate 0's `classifyLeg` and gate 1's `classifyGate1` with
  band-aware checkpoints against `reference-xform`) and `runG3c`, which `runGate3` calls when g3c
  ran.
- `check-gate3.ts`: writes `<out>/result.json` (`render-stream-gate3-report/1`: gate 1's shape
  plus `probes`, per leg and step `{total, decisive, failed}`, `clip_rects`, the clip-derive
  table per fixture and step, `census`, `ties`, and for g3c `band` (budget, band sizes, the
  repeat's band differences) and `semantic_probes`, the reference's pixel at each D7 probe) and
  exits non-zero unless `gate_passed`.
- `test/self-test-gate3.ts`, `test/gate3-fixture.ts`, `test/gate3x-cases.ts`: see below.

## Gate 3 legs and evidence under `--out`

| Leg                | Group | Directory           | Runs                                                                                                                             |
| ------------------ | ----- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `import`           | g3a   | `import/fixture/`   | the mise editor's `--import` of `fixtures/gate3`                                                                                 |
| `capture`          | g3a   | `capture/`          | the release template, `--headless`, armed, both sinks, the store, `GRC_ROOT_SIZE=enforce-min-size`, quit 400, strace + maps/fd |
| `reference`        | g3a   | `reference/`        | rendered in gamescope, extension absent: `shots/step-0..9.png`                                                                  |
| `reference-repeat` | g3a   | `reference-repeat/` | the same again                                                                                                                   |
| `reference-armed`  | g3a   | `reference-armed/`  | rendered, extension armed with `GRC_STREAM_OUT` and a store, shots                                                               |
| `import` (receiver) | g3b  | `import/receiver/`  | the mise editor's `--import` of `receiver/`                                                                                      |
| `receiver`          | g3b  | `receiver/`         | rendered receiver on `capture/recording.rs2`: `shots/seq-<n>.png` at the 10 settle seqs, `applied.json`                         |
| `receiver-patch`    | g3b  | `receiver-patch/`   | the same on `capture/recording-patch.rs2`, plus `state/seq-<n>.json` resolved-state dumps                                       |
| `receiver-headless-trace` | g3b | `receiver-headless-trace/` | headless receiver on a copy of `capture/recording.rs2` under `strace -e openat`                                          |
| `sabotage-freeze`, `sabotage-perturb` | g3b | `sabotage-{freeze,perturb}/{capture,receiver}/` | its own fresh capture, `GRC_SABOTAGE=freeze-frame`/`perturb-transform` at step 2's/1's frame, then a rendered receiver |
| `sabotage-omit-clip`, `sabotage-omit-custom-rect` | g3b | `sabotage-omit-{clip,custom-rect}/{capture,receiver}/` | its own fresh capture, `GRC_SABOTAGE=omit-op` dropping `canvas_item_set_clip`/`canvas_item_set_custom_rect` at step 3's/7's frame |
| `sabotage-receiver-ignore-clip` | g3b | `sabotage-receiver-ignore-clip/` | rendered receiver on `capture/recording.rs2`, `RS_RECEIVER_SABOTAGE=ignore-clip`                                         |
| `sabotage-receiver-clip-before-clear` | g3b | `sabotage-receiver-clip-before-clear/` | the same, `RS_RECEIVER_SABOTAGE=clip-before-clear`                                                                 |
| `root-size-observe` | g3b  | `root-size-observe/{capture,receiver}/` | its own fresh capture with `GRC_ROOT_SIZE` unset, then a rendered receiver                                               |
| `capture-clip-ignore`   | g3d | `capture-clip-ignore/`   | the release template, `--headless`, armed, `RS_FIXTURE_VARIANT=clip-ignore`, both sinks, `GRC_ROOT_SIZE=enforce-min-size`, quit 400 |
| `reference-clip-ignore` | g3d | `reference-clip-ignore/` | rendered in the same gamescope, extension absent, `RS_FIXTURE_VARIANT=clip-ignore`: `shots/step-0..9.png`                           |
| `receiver-clip-ignore`  | g3d | `receiver-clip-ignore/`  | rendered receiver on `capture-clip-ignore`'s recording: `shots/seq-<n>.png` at the 10 settle seqs, `applied.json` |

Group g3c runs `fixtures/gate3-xform` (one private gamescope, `gamescope-xform/`):

| Leg                                   | Directory                                          | Runs                                                                                                     |
| ------------------------------------- | -------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `import-xform`                        | `import-xform/{fixture,receiver}/`                 | the mise editor's `--import` of `fixtures/gate3-xform` and of the receiver                               |
| `capture-xform`                       | `capture-xform/`                                   | the release template, `--headless`, armed, both sinks, the store, `enforce-min-size`, quit 52           |
| `reference-xform`                     | `reference-xform/`                                 | rendered, extension absent: `shots/step-0..4.png`                                                        |
| `reference-xform-repeat`              | `reference-xform-repeat/`                          | the same again (the band budget)                                                                         |
| `reference-xform-armed`               | `reference-xform-armed/`                           | rendered, extension armed with `GRC_STREAM_OUT` and a store                                              |
| `receiver-xform`                      | `receiver-xform/`                                  | rendered receiver on `capture-xform`'s full sink, shots at the five settle seqs                          |
| `receiver-xform-patch`                | `receiver-xform-patch/`                            | the same on the patch sink                                                                               |
| `sabotage-xform-perturb`              | `sabotage-xform-perturb/{capture,receiver}/`       | capture with `perturb-transform` at frame 11 (step 1), rendered receiver                                 |
| `sabotage-xform-receiver-ignore-clip` | `sabotage-xform-receiver-ignore-clip/`             | rendered receiver on `capture-xform`'s full sink with `RS_RECEIVER_SABOTAGE=ignore-clip` (G3b's value)  |

## Gate 3 criteria (g3a)

`capture-armed` (56 hooks) and `headless-no-gpu` are gate 0's. `recording-decodes` runs gate 0's
check on both sinks. `patch-resolves-to-full` requires the patch sink to resolve bit-identically to
the full sink at every frame. `step-alignment` reads the four step logs and the capture's marker
colours. `no-draw-index-ties` fails on any tie whose members' footprints overlap (G1b2's harmless
rule) and lists harmless ones. `expected-image-reference` compares every reference shot with
`synthesizeGate3` exactly, full frame and per region. `probes-reference` reads every named probe
in the reference shots and fails by name. `reference-repeat-budget` requires `reference` and
`reference-repeat` to be identical (budget 0, D8). `armed-transparent` requires
`reference-armed`'s shots to equal `reference`'s byte for byte. `clip-state-invariants` evaluates
every `expected.json` invariant on both sinks' settle transactions. `clip-rects-derived` runs
`deriveClipRects` over both sinks' settle transactions against `clip_rects` (and, once g3b has
run, over `receiver-patch`'s own resolved `state/seq-<n>.json` dumps too).
`clip-call-census` sums `counters.json` `captured.canvas_item_set_clip` by value and
`canvas_item_set_custom_rect` by enabled, reads `counts.canvas_item_clear`, and requires
`census_totals` with nothing dropped. `support-legs-exit` requires the import and rendered legs
to exit 0. `leg-class-capture` requires class `success` and no unsupported entry or command.

## Gate 3 criteria (g3b)

`expected-image-receiver` and `receiver-vs-reference` compare `receiver`'s `seq-<n>.png` shots
with `synthesizeGate3`, full frame and every region, exactly (g3b has no sabotage on this leg:
every step must match). `probes-receiver` reads every named probe in `receiver`'s shots and fails
by name. `receiver-consumed-stream` is gate 1's: `receiver`'s `applied.json` schema, status,
`end_seen`, the transaction list's seq/sha256 sequence, every shot's `applied_through` and
`recording.sha256` against the capture file's. `receiver-never-loaded-fixture` is gate 1's own
strace-based proof, now over `fixtures/gate3/`. `receiver-typed-clean` is g3b's own lighter
version (gate2b-checks.ts's pattern, since g3b has no `receiver-typecheck` leg): it scans every
g3b receiver leg's own `stdout.log` for `SCRIPT ERROR` / `SCRIPT WARNING` / `Parse Error` /
`Failed to load script`. `leg-class-<leg>` runs for every leg of `G3B_CLASSIFIED_LEGS`: the
class, then, read straight from `expected.json` `predictions[leg]`, the exact mismatching-step
set, the exact mismatching-region set per predicted step (root-size-observe: `anchored` only,
with zero mismatching pixels outside every region), and for
`sabotage-receiver-ignore-clip`, the exact failing-probe set (G3a's "As built" amendment: every
decisive outside probe plus 34 inside probes `BF`/`BZ`/`CF` cover once unclipped).

## Gate 3 criteria (g3c)

`expected-self-consistent-xform` holds `fixtures/gate3-xform/expected.json` to its rules: the colour
rule, regions, the Q6d hand table, the probe pairs (outside the band, colours equal to the
synthesized and unclipped frames), decisive coverage, the band size equal to `synthesizeGate3x`'s,
the six semantic probes equal to Q6d's table with each alternative differing from the engine
somewhere, and the sabotage step sets equal to the contract's. `step-alignment-xform` reads the
capture's and the three references' step logs and the capture's marker colours.
`expected-image-reference-xform` compares every reference shot with `synthesizeGate3x` exactly
outside the band, full frame and per region. `band-budget` requires `reference-xform` and
`reference-xform-repeat` to be identical outside the band and turns their band differences into
the budget. `semantic-probes` requires the reference to equal the engine model at all six D7 probes
and each of `rotated-exact`, `edge-round` and `pixel-centre` to miss at least one.
`probes-reference-xform` and `probes-receiver-xform` read every named probe. `armed-transparent-xform`
requires `reference-xform-armed` to equal the reference byte for byte, band included.
`clip-state-invariants-xform` and `clip-rects-derived-xform` are g3a's checks over both
`capture-xform` sinks. `receiver-vs-reference-xform` and `expected-image-receiver-xform` hold both
receivers exact outside the band, the former within the budget inside it.
`support-legs-exit-xform` requires the two imports and the three references to exit 0. Five
`leg-class-*` checks: `capture-xform`, `receiver-xform` and `receiver-xform-patch` classify
`success`; `sabotage-xform-perturb` is `pixel-mismatch` at exactly {1..4}; and
`sabotage-xform-receiver-ignore-clip` is `pixel-mismatch` at exactly {0..4}, with exactly the
predicted failing probes (two that the unclipped scene puts in its own band are left out). The
receiver legs need G3b's apply order (clear before clip) and its `ignore-clip` sabotage.

## Gate 3 criteria (g3d)

`capture-armed-clip-ignore` is `capture-armed`'s own check against `capture-clip-ignore/`'s
`evidence/`, since `checkCaptureArmed` always reads `capture/`. `manifest-present` is gate 0's,
confirming the current wire's exact features (since G5d `ops` carries `add_clip_ignore`; on /3
`observed_unsupported_ops` carried `canvas_item_add_clip_ignore`) and that `unobserved` carries
`canvas_item_set_visibility_notifier`. `recording-decodes-clip-ignore` runs gate 0's check
on both of `capture-clip-ignore`'s sinks. `expected-image-reference-clip-ignore` compares every
`reference-clip-ignore` shot with `synthesizeGate3` plus `expected.json`'s
`variant_clip_ignore.reference_draws` appended (the second rect drawn unclipped, Q1d).
`clip-ignore-commands` (`clip-ignore-typed` before G5d) reads the capture's last transaction for
the one item with RI's exact four commands (`add_rect`, `add_clip_ignore(true)`, `add_rect`,
`add_clip_ignore(false)`) and requires no item-level unsupported entry. Since G5d
(render-stream/4, gate5-design.md D10 and Q6g) `leg-class-capture-clip-ignore` requires class
`success` with no unsupported entry or command, and `leg-class-receiver-clip-ignore` requires the
receiver to classify `success`, its step join to be clean, and every one of its `seq-<n>.png` shots
(all ten settle steps) to equal `reference-clip-ignore`'s matching `step-<k>.png` in every region,
`ri` included: the receiver replays both `add_clip_ignore` commands. On render-stream/3 both legs
were `unsupported` and the receiver's shots differed in region `ri` alone.

## Gate 3 self-test

```bash
mise exec -- pnpm exec tsx --conditions=development experiments/render-stream/scripts/test/self-test-gate3.ts
python3 experiments/render-stream/fixtures/gate3/make_expected.py --check
python3 experiments/render-stream/fixtures/gate3-xform/make_expected.py --check
```

The unit cases are of three kinds. `deriveClipRects` runs on hand cases: nesting, a non-clipping
intermediate, both zero-area skips, half rounding including negatives, the sub-0.5 px skip, a
negative scale, 90° and 30° rotations (gate3-xform's `RQ`), command bounds with a flipped,
transposed texture rect, unknown bounds, an invisible subtree and the canvas transform.
`synthesizeGate3` and the probes run against `expected.json`, with the predictions' sanity and the
TS call model's census against `census_totals`. `checkExpectedSelfConsistent` runs on the
committed file and on six broken copies (plus, since G3d, `variant_clip_ignore`'s own shape). A
passing g3a+g3b+g3d tree is then fabricated: `test/gate3-fixture.ts`'s `buildFullTree` calls
`buildTree` (g3a: models the fixture's RS calls independently of `make_expected.py`, writes both
sinks through `test/rs2-test-encoder.ts`, and synthesizes the PNGs), `writeG3bTree` (every g3b
leg's `applied.json` from the capture bytes it actually replays, `summarizeRecording`, and its
shots as `synthesizeGate3`, a sabotage's predicted-mismatch steps getting one recoloured pixel
instead; `sabotage-receiver-ignore-clip` writes the actual unclipped render,
`synthesizeGate3(..., {clips: false})`, not a stand-in) and `writeG3dTree` (`buildStatesWithRI`
adds the variant's static item `RI`, wire id 19, the same the real fixture gives it, to every
frame alongside the base g3a model, for `writeClipIgnoreCaptureDir`/`-Reference`/`-Receiver`).
Tiny stand-in `receiver/` and `fixtures/gate3/` project directories back
`receiver-never-loaded-fixture`'s file-hash scan. Every check gets at least one failing
perturbation, the pre-gate-3 mirror (clear keeps clip), the pre-gate-3 receiver order (clip before
clear) and G3d's five levers (an omitted hook, a wrong transaction count, RI never calling
`add_clip_ignore`, a perturbed reference pixel, and a receiver that matches the reference exactly,
so the predicted `ri` mismatch never fires) among them, and the real `runGate3` runs on every
tree. Scenarios that rewrite the shared `capture/` directory (`recapture`) run g3b and g3d out of
scope (`g3aOnly`): their receiver legs replay that capture by reference, so keeping them "honest"
against a capture nobody is testing them against would mean regenerating several legs' worth of
evidence for every g3a-only perturbation. `manifest-present` has no failing lever here, since
every fabricated session is encoded straight from the live `RS2_FEATURES` constant; its failure
path is `self-test-gate0.ts`'s.

`test/gate3x-cases.ts` covers g3c, and `make_expected.py --check` for `fixtures/gate3-xform` joins
the list. It checks `synthesizeGate3x`'s coverage and band on a hand-computed 8×8 diamond (24
covered pixels, a 36-pixel band, both confined by a scissor) and `bandDiff`/`overBudget`. It holds
the six semantic probes to Q6d's table, typed in independently, and runs
`checkExpectedSelfConsistentX` on the committed file and seven broken copies. The reference-side
checks run on small trees of synthesized PNGs: a passing tree, a band pixel off (passes, budget
1 px), `half.sliver` painted as the alternatives predict, a probe off, and an alternative that
agrees everywhere. The fabricated g3a + g3b trees run `runGate3` with the landed groups narrowed
to g3a and g3b.

## Gate 4 files

```bash
mise exec -- pnpm render-stream:gate4 -- \
  --extension "$PWD/experiments/render-stream/capture/build/render_stream_capture.gdextension" \
  --calibration "$PWD/experiments/render-stream/calibration/godot-4.5.1-stable-linux-release.json" \
  [--legs g4a,g4b,g4c,g4d,g4e,g4f]
```

- `run-gate4.sh`: the orchestrator (`run_g4a`, `run_g4b`, `run_reference` with `REFERENCE_ORACLE`
  and `REFERENCE_ARMED`, `g4_capture` for a sabotage capture at the fixture's own default quit
  frame, `early_shots_csv` for Q6b's "Intermediate shots" on a receiver). It provisions fonts
  before the import and stops on any mismatch. `g4b` needs `g4a` in the same `--legs` (one
  capture and reference, shared). `run_g4c` runs `fixtures/gate4-layout` under `<out>/layout/`
  (it also imports `receiver/`, which a fresh worktree has never imported); `run_reference` takes
  `REFERENCE_FIXTURE_DIR` and `REFERENCE_VARIANT` for it, and `layout_early_csv` its early
  steps. `run_g4f` runs `fixtures/gate4-i18n` under `<out>/i18n/` the same way (four fonts
  provisioned, the fixture and `receiver/` imported, `i18n_early_csv` for its early steps).
  `run_g4e` (G4e2) runs `fixtures/gate4-msdf` under `<out>/msdf/` (it imports the fixture and
  `receiver/`; `msdf_early_csv` gives its early steps 1 and 7) plus `sabotage-gray-perturb-glyph`
  on `fixtures/gate4`, so `g4e` needs `g4a` in the same `--legs`. Every capture speaks
  render-stream/4 since G5d (/3 from G4e2); the recordings keep their `.rs2` names.
- `lib/provision-fonts.sh <fixture>`: copies each `fonts.lock.json` entry into `<fixture>/fonts/`
  after checking the source's and the copy's size and SHA-256 and that its licence file exists.
  A source starting with `../` (the engine checkout) also resolves against the main checkout's
  root, so worktrees find it. Exit 2 on any mismatch or missing source.
- `lib/gate4-expected.ts`: the `render-stream-gate4-expected/1` and
  `render-stream-gate4-glyphs/1` types, `stepFrames4`, `stepOfFrame4`, `synthesizeGate4` (the
  clear colour, the panel and the marker, with a mask of the text regions), `inkPixels`,
  `boxEqual`, `deriveCensus` (gate4-design.md Q1c over expected.json's own strings and draws),
  `appendOnlyViolations`, and G4b's `synthesizeText`/`compareSynthesizedText` (D8: one oracle
  node's glyphs, straight-alpha blended over its region's background from its page's LA8 alpha,
  against a real frame).
- `lib/gate4-checks.ts`: every G4a and G4b check, each a pure `evaluate*` function plus a thin
  loader, and `runGate4`. It reuses gate 0's capture, no-GPU and
  `classifyLeg`/`joinSettleSeqs`/`checkReceiverNeverLoadedFixture` machinery, gate 2's
  `store-complete` and `texture-versions-current`, and gate 3's recording, patch, tie and
  capture-class checks. G4b adds `receiverStepSeqs`/`loadReceiverShots` (a receiver's wire-seq
  shots re-keyed to the reference's filenames, so every G4a shot evaluator runs over a receiver
  unchanged), `computeGate4Checkpoints` plus `checkLegClass` (classifyLeg against a leg's class
  and, for a sabotage, its exact predicted mismatching steps), `loadAtlasPageImages`/
  `loadPagesByStep`, `evaluateExpectedText`/`checkExpectedText`, `evaluateResourceQuiet`,
  `checkReceiverNeverShapes`, `checkReceiverConsumedStream`, `checkReceiverTypedClean` and
  `checkAtlasHashParitySabotage`.
- `lib/gate4c-checks.ts`: group g4c (`runG4c`, loaded on demand by `runGate4`). It points G4a's
  and G4b's evidence-root helpers at `<out>/layout/` and adds what layout needs:
  `deriveLayoutCensus` (a TypeScript re-derivation of `make_expected.py`'s upload model),
  `evaluateLayoutOracle`, `evaluateLayoutGlyphCommands` (shadow, outline and text passes, each
  with its own colour and page), `layoutCensusFromLog`/`evaluateLayoutCensus` (per page key,
  frees included), `newSubpixelPairs`/`evaluateSubpixelCensus`, `evaluatePageLifetime`,
  `evaluateLayoutClips` (gate 3's `deriveClipRects`), `synthesizeLayoutText`/`evaluateLayoutText`
  (D8 with per-glyph colours, outline pages and the Labels' clips), `evaluateLcdCommands` and
  `evaluateLcdRegions`. Its check ids end in `-layout` or name the leg.
- `lib/gate4f-checks.ts`: group g4f (`runG4f`, loaded on demand by `runGate4`). It points the
  same helpers at `<out>/i18n/` (G4c's `layoutCensusFromLog`, `evaluateLayoutCensus` and
  `loadLayoutPages` included) and adds `unitsOf`/`deriveI18nCensus` (a TypeScript re-derivation
  of `make_expected.py`'s glyph-unit model from `expected.json` `units_model`),
  `evaluateI18nEnv` (OS with three fallbacks), `evaluateI18nOracle` (each shaped glyph from the
  font the fallback order gives its codepoint), `evaluateI18nCommands` (texture glyphs and
  hex-box `add_rect`s in draw order), `evaluateFallbackPages`, `evaluateScriptPredictions` and
  `synthesizeI18nText`/`evaluateI18nText` (D8 with each glyph's own font page and the hex box's
  half-open pixel-centre rects). Its check ids end in `-i18n` or name the check.
- `check-gate4.ts`: writes `<out>/result.json` (`render-stream-gate4-report/1`: gate 3's shape
  with `text` per fixture and step (glyph commands, pages with wire id, hook and wire versions and
  payload bytes, bytes published, copy and hash ns), `parity` (each oracle page against the
  capture's table per step), `budgets` (reference against repeat per region), `census` and `ink`)
  and exits non-zero unless `gate_passed`; g4c adds `layout`, g4f `i18n` (census, script
  predictions, fallback pages) and g4e `msdf` (its census, the measured budget and the receiver's
  maxima). It passes `receiverDir`/`fixtureDir` (G4b) in `Gate4Context`. When group `g4d` ran, it separately loads `fixtures/gate4-rich/expected.json`,
  calls `runGate4d` (lib/gate4d-checks.ts) and merges its checks/legs/text/parity/budgets/census/
  ink into the same report under the fixture key `"gate4-rich"`, ANDing `gate_passed` -- `runGate4`
  itself stays unaware of G4d (no circular import: gate4d-checks.ts already imports gate4-checks.ts
  for the pieces it reuses).
- `fixtures/gate4-rich/`: G4d's own fixture (a `RichTextLabel`), see its own `README.md`.
- `lib/gate4d-checks.ts`: G4d's checks (fixtures/gate4-rich/, `RichTextLabel` spans). Every check
  id is prefixed `rich-` so it never collides with g4a/g4b's identically-shaped checks in the same
  flat `report.checks` array. It reuses G4a/G4b's `shotsOf`/`loadShots`/`gate4Regions`/
  `compareLegs`/`evaluateExpectedImage`/`evaluateInkPresence`/`markerAlignment`/
  `receiverStepSeqs`/`loadReceiverShots`/`computeGate4Checkpoints`/`checkLegClass`/
  `evaluateResourceQuiet`/`checkAtlasHashParity`/`checkAtlasAppendOnly`/`checkAtlasCensus`/
  `textReport` unchanged (none of them depend on `OracleLine.nodes`'s per-glyph quads, which this
  fixture's oracle never produces: Q6c, "the oracle reports glyph sets and counts per span, not
  quads"). New: `evaluateRichOracleAgrees` (groups an outlined span's two expanded oracle entries
  -- fill and outline pass, sharing its `key` -- rather than assuming one entry per span),
  `evaluateRichGlyphCommands` (per-wire-id glyph counts against the oracle, bold/italic "own page",
  `[bgcolor]` `add_rect`s), `checkRichClipRects` (gate 3's `deriveClipRects` over `RTL`'s fixed
  clip rect), `evaluateRichCapture`/`checkRichCaptureArmed`/`checkRichHeadlessNoGpu`/
  `checkRichStepAlignment`/`checkRichFixtureEnv` (directory-parameterized equivalents of gate0/
  gate2b/gate3/gate4's own helpers, which hardcode the leg name `"capture"`; this fixture's legs
  live under `rich-*/`), and `checkRichUnderlineCaptureClass` for the underline variant
  (`checkRichUnsupportedCaptureClass`/`checkMismatchConfinedToRegion` before G5d).
- `fixtures/gate4-msdf/`: G4e2's fixture (five Labels on one MSDF `FontFile`, msdf_size 48, range
  24), see its own `README.md`.
- `lib/gate4e-checks.ts`: group g4e (`runG4e`, loaded on demand by `runGate4`). It points G4a's and
  G4b's evidence-root helpers at `<out>/msdf/` and adds what MSDF needs: `deriveMsdfCensus` (a
  TypeScript re-derivation of `make_expected.py`'s one-cache upload model),
  `evaluateMsdfOracle`, `evaluateMsdfGlyphCommands` (msdf commands against the oracle's float32
  quads, outline, px_range and scale), `evaluateMsdfArgs`, `evaluateWithinBudget` (D8: a receiver
  within the reference repeat's measured per-region maxima), `evaluatePredictedRegions` and
  `evaluatePerturbRecorded` (a perturb-glyph capture against the clean one, +0.25 on exactly the
  predicted Labels' rects). It reuses G4c's `layoutCensusFromLog`/`evaluateLayoutCensus` over
  the MSDF expected. Its check ids end in `-msdf` or name the leg.
- `test/self-test-gate4.ts`, `test/self-test-gate4d.ts`: see below.

## Gate 4 legs and evidence under `--out`

| Leg                                      | Group | Directory                | Runs                                                                                                                                         |
| ----------------------------------------- | ----- | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `import`                                 | g4a   | `import/`                 | `provision-fonts.sh` (`fonts.log`), then the mise editor's `--import` of `fixtures/gate4` (`fixture/`)                                       |
| `capture`                                | g4a   | `capture/`                | the release template, `--headless`, armed, both sinks, the store, `GRC_ROOT_SIZE=enforce-min-size`, `env.json`, quit 400, strace + maps/fd |
| `reference`                              | g4a   | `reference/`              | rendered in gamescope, extension absent, oracle on: `shots/step-0..9.png`, `shots/early-{1,4,7}.png`, `oracle/glyphs.jsonl`, `oracle/pages/` |
| `reference-repeat`                       | g4a   | `reference-repeat/`       | the same again                                                                                                                               |
| `reference-armed`                        | g4a   | `reference-armed/`        | rendered, extension armed with `GRC_STREAM_OUT` and a store, oracle off, shots                                                              |
| `receiver`                               | g4b   | `receiver/`               | the unchanged receiver, rendered, on a copy of `capture`'s full sink, settle and early (12, 42, 72) shots |
| `receiver-patch`                         | g4b   | `receiver-patch/`         | the same, on a copy of `capture`'s patch sink (same seq space as the full sink) |
| `receiver-headless-trace`                | g4b   | `receiver-headless-trace/` | the receiver, headless, `strace -f -e openat` (`receiver-never-shapes`, `receiver-never-loaded-fixture`) |
| `sabotage-freeze/{capture,receiver}`     | g4b   | `sabotage-freeze/`        | a fresh headless capture (`GRC_SABOTAGE=freeze-frame` at frame 11, step 1) at the fixture's own default quit (102), then its rendered receiver |
| `sabotage-perturb/{capture,receiver}`    | g4b   | `sabotage-perturb/`       | `GRC_SABOTAGE=perturb-transform` at frame 21 (step 2), then its receiver |
| `sabotage-omit-atlas/{capture,receiver}` | g4b   | `sabotage-omit-atlas/`    | `GRC_SABOTAGE=omit-op GRC_SABOTAGE_OP=texture_2d_update` at frame 41 (step 4), then its receiver |
| `import` (layout)                        | g4c   | `layout/import/`          | `provision-fonts.sh fixtures/gate4-layout` (`fonts.log`), then `--import` of the fixture (`fixture/`) and of `receiver/` (`receiver/`) |
| `capture-layout`                         | g4c   | `layout/capture/`         | as `capture`, on `fixtures/gate4-layout` (quit 400, both sinks, store, strace + maps/fd, `env.json`) |
| `reference-layout`, `-repeat`            | g4c   | `layout/reference/`, `layout/reference-repeat/` | rendered, extension absent, the layout oracle on: `shots/step-0..9.png`, `shots/early-{1,2,3,4,6,7,8}.png`, `oracle/` |
| `reference-layout-armed`                 | g4c   | `layout/reference-armed/` | rendered, extension armed with a stream and a store, oracle off |
| `receiver-layout`, `-patch`              | g4c   | `layout/receiver/`, `layout/receiver-patch/` | the receiver on `capture-layout`'s full and patch sinks, settle and early shots |
| `receiver-layout-headless-trace`         | g4c   | `layout/receiver-headless-trace/` | the receiver, headless, `strace -f -e openat`, on `capture-layout`'s full sink |
| `sabotage-layout-omit-atlas`             | g4c   | `layout/sabotage-omit-atlas/{capture,receiver}` | `omit-op texture_2d_update` at frame 71 (step 7, the multi-page step), default quit 102, then its receiver |
| `capture-lcd`, `reference-lcd`, `receiver-lcd` | g4c | `layout/lcd/{capture,reference,receiver}` | `RS_FIXTURE_VARIANT=lcd` (one LCD Label `LC`): headless capture (quit 102), rendered reference (oracle off), receiver |
| `rich-import`                            | g4d   | `rich-import/`            | `provision-fonts.sh` and `--import` of `fixtures/gate4-rich` |
| `rich-capture`                           | g4d   | `rich-capture/`           | headless, armed, both sinks, the store, `env.json`, quit 400, strace + maps/fd |
| `rich-reference`, `rich-reference-repeat`, `rich-reference-armed` | g4d | `rich-reference*/` | as g4a's `reference`/`reference-repeat`/`reference-armed`, for `fixtures/gate4-rich` (no "early" shots) |
| `rich-receiver`, `rich-receiver-patch`   | g4d   | `rich-receiver*/`         | the unchanged receiver on `rich-capture`'s full and patch sinks |
| `rich-underline/capture`                 | g4d   | `rich-underline/capture/` | headless, `RS_FIXTURE_VARIANT=underline`, the fixture's own default quit (62) |
| `rich-underline/reference`               | g4d   | `rich-underline/reference/` | rendered, `RS_FIXTURE_VARIANT=underline`, no oracle (ground truth for the real underline stroke; not named in gate4-design.md's leg list, added here as built, mirroring G4c's three-leg LCD variant) |
| `rich-underline/receiver`                | g4d   | `rich-underline/receiver/` | the receiver on `rich-underline/capture`'s recording |
| `import` (i18n)                          | g4f   | `i18n/import/`            | `provision-fonts.sh fixtures/gate4-i18n` (`fonts.log`, four fonts), then `--import` of the fixture (`fixture/`) and of `receiver/` (`receiver/`) |
| `capture-i18n`                           | g4f   | `i18n/capture/`           | as `capture`, on `fixtures/gate4-i18n` (quit 400, both sinks, store, strace + maps/fd, `env.json`) |
| `reference-i18n`, `-repeat`              | g4f   | `i18n/reference/`, `i18n/reference-repeat/` | rendered, extension absent, the i18n oracle on: `shots/step-0..9.png`, `shots/early-{1,2,3,4,5}.png`, `oracle/` |
| `reference-i18n-armed`                   | g4f   | `i18n/reference-armed/`   | rendered, extension armed with a stream and a store, oracle off |
| `receiver-i18n`, `-patch`                | g4f   | `i18n/receiver/`, `i18n/receiver-patch/` | the receiver on `capture-i18n`'s full and patch sinks, settle and early shots |
| `receiver-i18n-headless-trace`           | g4f   | `i18n/receiver-headless-trace/` | the receiver, headless, `strace -f -e openat`, on `capture-i18n`'s full sink |
| `sabotage-i18n-omit-atlas`               | g4f   | `i18n/sabotage-omit-atlas/{capture,receiver}` | `omit-op texture_2d_update` at frame 51 (step 5, the first Devanagari), default quit 102, then its receiver |
| `import` (msdf)                          | g4e   | `msdf/import/`            | `provision-fonts.sh fixtures/gate4-msdf` (`fonts.log`), then `--import` of the fixture (`fixture/`) and of `receiver/` (`receiver/`) |
| `capture-msdf`                           | g4e   | `msdf/capture/`           | as `capture`, on `fixtures/gate4-msdf` (quit 400, both sinks, store, strace + maps/fd, `env.json`) |
| `reference-msdf`, `-repeat`              | g4e   | `msdf/reference/`, `msdf/reference-repeat/` | rendered, extension absent, the MSDF oracle on: `shots/step-0..9.png`, `shots/early-{1,7}.png`, `oracle/` |
| `reference-msdf-armed`                   | g4e   | `msdf/reference-armed/`   | rendered, extension armed with a stream and a store, oracle off |
| `receiver-msdf`, `-patch`                | g4e   | `msdf/receiver/`, `msdf/receiver-patch/` | the receiver on `capture-msdf`'s full and patch sinks, settle and early shots |
| `receiver-msdf-headless-trace`           | g4e   | `msdf/receiver-headless-trace/` | the receiver, headless, `strace -f -e openat`, on `capture-msdf`'s full sink |
| `sabotage-msdf-perturb-glyph`            | g4e   | `msdf/sabotage-perturb-glyph/{capture,receiver}` | `GRC_SABOTAGE=perturb-glyph` at frame 11 (step 1, the new-glyph step), default quit 102, then its receiver |
| `sabotage-msdf-receiver-drop`            | g4e   | `msdf/sabotage-receiver-drop/receiver/` | the receiver on `capture-msdf`'s full sink with `RS_RECEIVER_SABOTAGE=drop-msdf` |
| `sabotage-gray-perturb-glyph`            | g4e   | `msdf/sabotage-gray-perturb-glyph/{capture,receiver}` | `perturb-glyph` at frame 11 on `fixtures/gate4` (default quit 102), then its receiver, judged against g4a's `reference/` |

## Gate 4 criteria (g4a)

`capture-armed` (55 hooks), `headless-no-gpu`, `recording-decodes` (both sinks),
`patch-resolves-to-full`, `no-draw-index-ties` and `leg-class-capture` are gate 3's;
`store-complete` and `texture-versions-current` are gate 2's. `step-alignment` reads the four step
logs and the capture's marker colours. `fixture-env` requires `env.json` to be identical across
capture, reference and repeat and to equal the lock's font hash, D3's `FontFile` properties, Q1e's
settings, oversampling 1.0 and the Advanced TextServer. `oracle-agrees` requires the oracle's
visible nodes, texts, fonts, colours, ink-glyph counts, pages and distinct glyphs per cache to
equal `expected.json`, and both oracle logs to be byte-identical. `glyph-commands` compares every
text item's commands on both sinks' settle transactions with the oracle's quads, source rects,
colours and pages, float32 exact. `atlas-hash-parity` requires each oracle page's GRT1 hash to be
the hash of exactly one wire texture at every settle step, with a fixed wire id per page.
`atlas-append-only` decodes consecutive published versions of each page from the store and
requires every changed texel to have been empty (LA8 `(255,0)`). `atlas-census` reads the hook log
per step window: creates and updates per page, all in the applied frame, hook and wire versions,
nothing in the quiet steps, and the engine's hue strip as the only other upload.
`expected-image-reference` compares every shot with `synthesizeGate4` exactly outside the text
regions. `ink-presence-reference` counts ink pixels per region (≥ 6 per glyph, 0 when blank),
checks freshness against the previous step and requires each early shot's text to equal its
settle shot. `reference-repeat-budget` requires identical shots (budget 0) and reports per-region
maxima. `armed-transparent` requires `reference-armed`'s shots to equal the reference's.
`support-legs-exit` requires a provisioned font and the import and rendered legs to exit 0.

## Gate 4 criteria (g4b)

`leg-class-receiver`/`leg-class-receiver-patch` require class `success` (classifyLeg over
checkpoints built from the receiver's re-keyed shots against the reference's). `leg-class-
sabotage-{freeze,perturb,omit-atlas}` require class `pixel-mismatch` with exactly the predicted
mismatching steps (`expected.json` `predictions`, from `make_expected.py`; never hand-edited) and
every other step matching. `receiver-vs-reference` requires the receiver and receiver-patch legs'
shots to equal the reference's exactly, full frame and every region. `expected-image-receiver`
and `ink-presence-receiver` are g4a's `expected-image-reference`/`ink-presence-reference` run
over the receiver's shots. `expected-text-reference` and `expected-text-receiver` compare
`synthesizeText` (D8: an oracle node's glyph quads sampled against its page's LA8 alpha, in the
node's font colour, straight-alpha blended over the region's background) with the real shot
inside every visible text node's region, budget `maxChannelDelta` 1 (UNORM8 blend rounding).
`resource-quiet` requires the quiet steps (2, 3, 5, 6, 8) to fetch and upload nothing on either
sink's receiver (`applied.json`'s per-transaction `resources`). `receiver-never-shapes` requires
`receiver-headless-trace`'s openat trace to open no `*.ttf`/`*.otf`/`*.woff`/`*.woff2`/`*.fnt`/
`*.fontdata`, and no file under `receiver/**/*.gd` to reference `TextServer`,
`TextServerManager`, `Font`, `FontFile`, `Label`, `RichTextLabel`, `draw_string` or `draw_char`.
`receiver-consumed-stream` requires every file-mode receiver's `applied.json` to report status
`ok`, `end_seen` true and `recording.sha256` equal to its own local copy. `receiver-never-loaded-
fixture` (gate 0's check, with `fixtureProjectDir` = `fixtures/gate4/`) and `receiver-typed-clean`
cover the same six receiver legs. `atlas-hash-parity-sabotage-omit-atlas` re-runs
`evaluateAtlasParity` against `sabotage-omit-atlas`'s own recording and requires its failing
cells to equal `predictions["sabotage-omit-atlas"].atlas_hash_parity_fails` exactly.

## Gate 4 criteria (g4c)

G4a's and G4b's checks run on the layout fixture with a `-layout` suffix (`capture-armed-layout`
… `receiver-typed-clean-layout`), with these differences: `oracle-agrees-layout` also compares
the word-wrapped line texts, the arbitrary-wrapped line counts, every pass's command count, the
clip flags and the pages per cache (outline caches included) against `expected.json`;
`glyph-commands-layout` compares every pass's commands with the pass colour and the glyph's own
page; `atlas-census-layout` counts creates, updates and frees per cache (plain caches once per
dirty page, outline caches once per new outline glyph, the subpixel cache only "some exactly when
it gains glyphs"); `ink-presence-*-layout` uses `ink_min_glyphs` (a clipped Label must show at
least `clip width // size` glyphs); `expected-text-*-layout` synthesizes every pass with its own
colour and page and the Label's clip. New: `atlas-pages` (each cache's oracle pages equal the
mapped wire textures in count, format and side; F@320 has ≥ 2 1024² LA8 pages), `subpixel-census`
(FX@14's uploads per step ≤ the oracle's new (glyph, x shift) pairs and ≥ 1 when any),
`page-lifetime` (step 8: FL's page freed and out of the table, FL2's page created with a new id,
in one frame, both sinks), `clip-rects-derived-layout` (gate 3's `deriveClipRects` gives LK and LP
exactly `clip_rects` and no other Label a clip), `leg-class-sabotage-layout-omit-atlas` (steps
{7,8,9}), `sabotage-layout-omit-atlas-regions` (every differing pixel inside LP),
`atlas-hash-parity-sabotage-layout-omit-atlas` (F@320 {7,8,9}), `leg-class-capture-lcd`
(`unsupported` for `canvas_item_add_lcd_texture_rect_region` only, LC's 7 commands typed
`unsupported-op`, its RGBA8 page `ok`) and `leg-class-receiver-lcd` (`unsupported`, differing
from `reference-lcd` only inside LC's region).

## Gate 4 criteria (g4d)

`rich-capture-armed`, `rich-headless-no-gpu`, `rich-step-alignment`, `rich-fixture-env`,
`rich-leg-class-capture`, `rich-receiver-vs-reference`, `rich-expected-image-{reference,receiver}`,
`rich-ink-presence-{reference,receiver}`, `rich-reference-repeat-budget`, `rich-armed-transparent`,
`rich-resource-quiet` and `rich-leg-class-receiver{,-patch}` are g4a/g4b's own checks run over
`fixtures/gate4-rich/` (its own `RTL` region in place of the seven Label regions, no panel).
`rich-atlas-hash-parity`, `rich-atlas-append-only` and `rich-atlas-census` are g4a's
`checkAtlasHashParity`/`checkAtlasAppendOnly`/`checkAtlasCensus` reused unchanged, over the five
caches `F@16`, `F@24`, `FB@16`, `FI@16` and `FO@16` (the outlined span's outline-pass cache,
relabelled so it never collides with `F@16` under `cacheKeyOf`'s `font_key@size` grouping).
`rich-oracle-agrees` requires the oracle's per-span glyph_count and cache (an outlined span's two
expanded entries, grouped by `key`) to equal `expected.json`'s independent derivation, and both
reference legs to write byte-identical oracle logs. `rich-glyph-commands` groups `RTL`'s
`add_texture_rect_region` commands by wire id and requires the sum to equal the oracle's per-span
glyph_count grouped by the same id (through `rich-atlas-hash-parity`'s mapping), requires bold and
italic to map to a wire id distinct from the plain fill cache ("own page"), and requires each
`[bgcolor]` span to have exactly one colour-matching `add_rect`. `rich-clip-rects-derived` requires
`deriveClipRects` (lib/clip-derive.ts) over `RTL` on each settle transaction of both sinks to equal
`expected.json`'s fixed clip rect for every step. Since G5d (render-stream/4, gate5-design.md Q6g)
every G4d leg classifies `success`: `rich-leg-class-capture` requires no unsupported op at all and
`RTL`'s per-glyph `add_set_transform` set/reset pairs as real commands, every one identity, at
every settle step (it reports the count per step); `rich-leg-class-receiver{,-patch}` require
`success` with no mismatching step. `rich-underline-capture-class` requires
`rich-underline/capture`'s own recording to classify `success` with the `[u]` stroke as real, wide
`add_line` commands (no receiver or pixel comparison); `leg-class-rich-underline-receiver` requires
`success`, and `rich-underline-receiver-vs-reference` (`rich-underline-confined` before G5d)
requires its shots to equal `rich-underline/reference`'s exactly at every step. On render-stream/3
every one of these legs was `unsupported`, the underline receiver's mismatch confined to `RTL`.

## Gate 4 criteria (g4f)

G4a's and G4b's checks run on the multilingual fixture with an `-i18n` suffix
(`capture-armed-i18n` … `receiver-typed-clean-i18n`), with these differences: `fixture-env-i18n`
pins OS (three fallbacks, in the order VZ, DV, HE) and each fallback with D3's properties and all
four font hashes; `oracle-agrees-i18n` compares glyph counts only where `make_expected.py`
predicts them (OS strings and the bidi string; the oracle is the only source for complex
scripts), the hex-box `add_rect` counts, the font of every shaped glyph (the first of the
fallback chain that maps its codepoint) and the pages per cache; `glyph-commands-i18n` compares
every command in draw order, texture glyphs against their own font's page and hex-box bars as
`add_rect`; `ink-presence-*-i18n` uses `ink_min_glyphs` (spacing clusters); `expected-text-*-i18n`
synthesizes texture glyphs and hex-box rects (pixel centres in the half-open rect). New:
`script-predictions` (Q6e's eight hand predictions, on the oracle and on both sinks: NFD
composition to OS's U+1EBF glyph, lam-alef one glyph, ZWNJ an invisible index-0 glyph, niqqud
marks in their base's cluster over its quad, Devanagari fewer glyphs than codepoints, the i-matra
left of KA, the Hebrew run's x decreasing in logical order, the hex box with 26 `add_rect`s and
no texture command), `fallback-pages` (each font's page absent from the oracle before its first
script, created once at that step's applied frame and first in either sink's table there),
`leg-class-sabotage-i18n-omit-atlas` (steps {5..9}), `sabotage-i18n-omit-atlas-regions` (every
differing pixel inside LD2) and `atlas-hash-parity-sabotage-i18n-omit-atlas` (DV@16 {5..9}).

## Gate 4 criteria (g4e)

G4a's and G4b's checks run on the MSDF fixture with a `-msdf` suffix (`capture-armed-msdf` …
`receiver-typed-clean-msdf`), with these differences: `fixture-env-msdf` pins `FM` as `F` with
MSDF on at msdf_size 48 and msdf_pixel_range 24; `oracle-agrees-msdf` requires every glyph to be an
MSDF glyph of the one `FM@48` cache with `outline` its pass's, px_range 24 and scale size/48, and
one 512×512 RGBA8 page; `glyph-commands-msdf` compares every command as
`add_msdf_texture_rect_region` bit for bit with the oracle's float32 quad and source rect, the pass
colour, outline, px_range, scale and page; `atlas-append-only-msdf` decodes RGBA8 pages with the
empty texel `(0,0,0,0)`; `atlas-census-msdf` (G4c's evaluator) requires one create at step 0, one
update per Label draw that adds glyphs (two at step 7), and nothing at the size change, the outline
toggle or any other quiet step; there is no synthesized MSDF ink (`expected-text-*`), because MSDF
coverage comes from the GPU's `fwidth`; `reference-repeat-budget-msdf` measures the budget per
region (expected 0) and `receiver-vs-reference-msdf` holds both receivers within it. New:
`msdf-args` (every msdf command on every transaction of both sinks: px_range 24, a known scale,
outline 0 or 4, no typed msdf refusal, no plain region glyph; per settle step each Label's own
scale and outline commands), `atlas-pages-msdf`, `receiver-msdf-commands` (`applied.json`
`msdf_commands` on every transaction; seq 1 replays all 25 step-0 commands),
`leg-class-sabotage-msdf-perturb-glyph` ({1..9}), `sabotage-msdf-perturb-glyph-regions`
(per-step regions from `predictions`: a Label mismatches from its first redraw after frame 11; MR
never redraws), `sabotage-msdf-perturb-glyph-recorded` (+0.25 on exactly those Labels' rects, as
recorded), `leg-class-sabotage-msdf-receiver-drop` ({0..9}), `-regions` (every Label at every
step), `-silent` (zero msdf calls, no msdf unsupported record), `leg-class-sabotage-gray-perturb-
glyph` ({1..9}, `fixtures/gate4/expected.json` `predictions`), `-regions` and `-recorded`.

## Gate 4 self-test

```bash
mise exec -- pnpm exec tsx --conditions=development experiments/render-stream/scripts/test/self-test-gate4.ts
python3 experiments/render-stream/fixtures/gate4/make_expected.py --check
python3 experiments/render-stream/fixtures/gate4-layout/make_expected.py --check
mise exec -- pnpm exec tsx --conditions=development experiments/render-stream/scripts/test/self-test-gate4d.ts
python3 experiments/render-stream/fixtures/gate4-rich/make_expected.py --check
python3 experiments/render-stream/fixtures/gate4-i18n/make_expected.py --check
python3 experiments/render-stream/fixtures/gate4-msdf/make_expected.py --check
```

Group g4e's cases are in `test/gate4e-cases.ts`: `expected.json`'s rules (an upload at the size
change and msdf_size 128 both fail); a synthetic MSDF oracle and recording (oracle, glyph commands
and arguments: a wrong outline, an old scale, a dropped glyph, a quarter-pixel quad, a plain region
command, px_range 14 and a typed msdf refusal each fail); the census (an upload at the size change
fails); `evaluateWithinBudget`, `evaluatePredictedRegions` and `evaluatePerturbRecorded` on
hand-built frames, checkpoints and recordings — each passing and failing.

Group g4c's cases are in `test/gate4c-cases.ts`: `expected.json`'s rules and hand-typed census
facts of `deriveLayoutCensus`; a synthetic layout oracle and recording (oracle, glyph commands,
census, lifetime); the subpixel bound on hand-built pairs; `synthesizeLayoutText` on a 4×4 page
(per-glyph colour, outline page keys, clip); and the LCD region rule — each passing and failing.
Group g4f's are in `test/gate4f-cases.ts`: `expected.json`'s rules, `unitsOf` and
`deriveI18nCensus`; a synthetic shaped world (oracle, commands, script predictions, fallback
pages) that passes and then fails on a glyph from the wrong fallback, a moved quad or hex bar, an
i-matra right of KA, a left-to-right Hebrew run, a texture command in the hex box, an early
fallback page and a late create; and a half-pixel hex bar in `synthesizeI18nText`.

GRT1 hashing is checked against SHA-256 values computed independently with Python (an empty
256×256 LA8 page, the size of every gate 4 page, and an 8×8 one), and append-only on a hand-built
8×8 LA8 pair. A synthetic world is then built from `expected.json` alone: an oracle log, a
recording whose settle transactions carry matching glyph commands and page versions, a hook log, a
store and shots. Every check passes on it and fails on at least one perturbation, among them a
quarter-pixel glyph shift, the omit-atlas sabotage (failing exactly at `predictions`' parity
cells), a single upload at step 7, an upload in a quiet step, an atlas published a frame late, and
a rewritten inked texel. `synthesizeText`/`compareSynthesizedText` (G4b, D8) are covered directly:
a hand-built 8×8 LA8 page and a one-glyph oracle node blend red ink at exactly 2/3 coverage over a
background whose channels are hand-computed (no rounding ambiguity), a pixel outside the glyph
stays the background, an identical copy compares with zero mismatch, a perturbed pixel is reported
with its exact delta, and a glyph naming a page the caller never loaded is recorded as missing
rather than synthesized wrong.

`self-test-gate4d.ts` covers only what G4d adds (every reused check already has its own case
above, against the same functions): `evaluateRichOracleAgrees` over an oracle synthesized from
`fixtures/gate4-rich/expected.json`'s own `spans` (independent of `glyph_oracle.gd`, as
`buildWorld` is independent of `fixtures/gate4/glyph_oracle.gd`) passes, then fails on a
byte-differing second leg, a wrong `glyph_count`, a missing outline-pass entry for the outlined
span (an outlined span needs exactly two oracle entries sharing its key, not one), and a wrong
`page_glyphs` prediction. Since G5d `checkRichCaptureLegClass` passes on per-glyph identity
`add_set_transform` pairs and fails on the /3 class (`unsupported`), on a set_transform still typed
`unsupported`, on an `RTL` with no `add_set_transform` and on a non-identity one;
`checkRichUnderlineCaptureClass` passes on a wide `add_line` and fails with no `add_line`, on a thin
one and on one still typed `unsupported`.

## Gate 5 files

```bash
mise exec -- pnpm render-stream:gate5 -- \
  --extension "$PWD/experiments/render-stream/capture/build/render_stream_capture.gdextension" \
  --calibration "$PWD/experiments/render-stream/calibration/godot-4.5.1-stable-linux-release.json" \
  [--legs g5b,g5c,g5d,g5e,g5g]
```

- `run-gate5.sh`: the orchestrator (`run_g5b`, `run_g5c`, `run_g5d`, `run_g5e`, `run_g5g`,
  `run_reference` with `REFERENCE_ARMED`, `REFERENCE_VARIANT`, `REFERENCE_FIXTURE_DIR` and
  `REFERENCE_MESH_ORACLE`, `g5_capture` for g5d's and g5e's variant and sabotage captures). g5d
  needs g5b's capture and reference in the same run, g5e g5c's; g5g imports the receiver itself.
  Group g5f is known but has not landed, so asking for it exits 2.
  Every capture speaks render-stream/4 since G5d (/3 before) and writes both sinks under gate 2's
  `.rs2` names.
- `check-gate5.ts`: the checker CLI; writes `<out>/result.json` (`render-stream-gate5-report/1`:
  gate 4's shape with `geometry` (the hook census as measured, the capture's commands per op per
  step, the raster's pixel classes per step), `meshes` (G5c: per fixture mesh its hook-log lines,
  last version and median copy/hash cost, and `_parity`, the agreed hash per mesh and step), `g5d`
  (the /4 commands compared and how many used their 2-ulp allowance, the lowering counts, CG's
  derived scissor and clip-ignored commands per step, the receivers' mismatches against the
  reference, each sabotage leg's mismatching regions per step and the `canvas` variant's refused
  entries), `budgets` (reference against repeat per region and pixel class) and `freshness`). With
  g5c it merges `runGate5c`'s checks and legs into the same report; `runGate5` merges g5g's; and
  with g5e `runGate5e`'s, whose `g5e` key holds the wire's mesh tables per frame, the surface-steps
  equal to the oracle, the store's GRM1 payloads, each receiver's mesh uploads and fetches, each
  sabotage leg's mismatching regions per step and the hook's mesh cost per step (lines, payloads
  made, median copy and hash ns, live surface bytes).
- `lib/gate5-expected.ts`: `expected.json`'s types, `stepFrames5`, transforms and texel decoding.
- `lib/geometry-raster.ts`: the reference rasterizer (`rasterizeGate5`, `rasterizeItems`). Pixel
  centre coverage, undecided within 1/16 px of a boundary edge (welded vertices; shared edges are
  not boundaries), flat colours exact, gradients and `.6` blends delta 1, nearest sampling decided
  only where the texels within 1/16 texel agree, `map_ninepatch_axis` per axis, draw transforms
  replaced (D9), clip-ignore spans (D10), band pixels for antialiased shapes and thin lines.
- `lib/gate5-checks.ts`: the g5b checks, pure over evidence already read, and the g5d
  orchestration (`runG5d`).
- `lib/gate5d-checks.ts`: the g5d evaluators: expected.json `calls` as /4 commands
  (`wireCommandOf`, `expectedCommandsByStep`), `ulpDistance`/`sameValue`, geometry-commands,
  lowering-predictions, clip-rects-derived over sink states and receiver state dumps, receiver
  shots by settle seq, per-region checkpoints and `evaluateLegClass5`, and capture-canvas.
- `lib/clip-derive.ts` (gate 3's, extended by G5d and G5e): `itemRect` follows `Item::get_rect` for
  the /4 commands with D9's draw transform (replaced, never composed; every later command's rect
  goes through it), and `clipIgnoredCommands`/`DerivedClip.ignored` report D10's clip-ignore spans.
  An `add_mesh` rect is `meshRects`' (G5e, Q1f): the entry's non-zero custom AABB, else the merge of
  its surfaces' AABBs supplied by hash (`DeriveOptions.surfaceAabbs`; unknown without them), a
  tombstone's zero rect, never the command's own transform.
- `lib/gate5c-checks.ts`: the g5c checks (fixtures/gate5-mesh): `expected.json`'s types, the census
  expansion, the hook-log hash replay, the oracle and parity checks, `runGate5c`.
- `lib/gate5g-checks.ts`: the g5g checks on `fixtures/gate5-style` (evidence under `style/`),
  reusing every g5b and g5d helper on that root, plus `stylebox-lowering`, `nine-patch-args`, the
  focus box's clip-ignore pair and the ignore-axis prediction (`runG5g`).
- `lib/gate5e-checks.ts`: the g5e checks (meshes on the wire and the receivers): the hook log
  replayed by wire id (`replayMeshLog`, `meshLogDivergence`, D15's `classifyMeshLeg`), the wire
  against `expected.json` (hash parity, the mesh lifetimes, fresh-without-redraw), the GRM1 store,
  the receivers' predicted uploads and quiet fetches, each host sabotage's signature against the
  log, `runGate5e`.
- `test/self-test-gate5.ts` (with `test/gate5g-cases.ts`), `test/self-test-gate5c.ts`,
  `test/self-test-gate5e.ts`: below.

## Gate 5 legs and evidence under `--out`

| Leg                | Group | Directory           | Runs                                                                                                                  |
| ------------------ | ----- | ------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `import`           | g5b   | `import/fixture/`   | the mise editor's `--import` of `fixtures/gate5`                                                                      |
| `capture`          | g5b   | `capture/`          | the release template, `--headless`, armed, both sinks, the store, `GRC_ROOT_SIZE=enforce-min-size`, quit 400, strace + maps/fd |
| `reference`        | g5b   | `reference/`        | rendered in gamescope, extension absent: `shots/step-0..9.png`, `steps.jsonl`                                         |
| `reference-repeat` | g5b   | `reference-repeat/` | the same again                                                                                                        |
| `reference-armed`  | g5b   | `reference-armed/`  | rendered, extension armed with `GRC_STREAM_OUT` and a store, shots                                                    |
| `import-mesh`      | g5c   | `mesh/import/fixture/` | the mise editor's `--import` of `fixtures/gate5-mesh`                                                              |
| `capture-mesh`     | g5c   | `mesh/capture/`     | as `capture`, on `fixtures/gate5-mesh`; `evidence/resources.jsonl`'s mesh lines are the census                        |
| `reference-mesh`   | g5c   | `mesh/reference/`   | rendered, extension absent, mesh oracle on (`RS_FIXTURE_MESH_LOG`): shots, `steps.jsonl`, `meshes.jsonl`             |
| `reference-mesh-repeat` | g5c | `mesh/reference-repeat/` | the same again                                                                                               |
| `reference-mesh-armed` | g5c | `mesh/reference-armed/` | rendered, extension armed with a stream and a store, oracle off: shots and its own hook log                    |
| `import` (receiver) | g5d  | `import/receiver/`  | the mise editor's `--import` of `receiver/`                                                                           |
| `receiver-headless-trace` | g5d | `receiver-headless-trace/` | the template, `--headless`, on `capture/`'s full sink under strace (openat)                              |
| `capture-canvas`   | g5d   | `capture-canvas/`   | headless capture, `RS_FIXTURE_VARIANT=canvas` (one CanvasTexture in `_ready`, D11), the fixture's own 102 frames      |
| `sabotage-freeze`, `sabotage-perturb-vertex`, `sabotage-omit-polygon` | g5d | `sabotage-<kind>/capture/` | headless captures with `freeze-frame` @11, `perturb-vertex` @21, `omit-op canvas_item_add_polygon` @21 |
| `receiver`         | g5d   | `receiver/`         | rendered receiver on `capture/recording.rs2`: `applied.json`, `shots/seq-<n>.png` at the settle seqs                  |
| `receiver-patch`   | g5d   | `receiver-patch/`   | the same on `recording-patch.rs2`, plus `state/seq-<n>.json` at the settle seqs                                       |
| sabotage receivers | g5d   | `sabotage-<kind>/receiver/` | rendered receivers on the three sabotage captures                                                         |
| `sabotage-receiver-ignore-set-transform`, `-ignore-clip-ignore` | g5d | `sabotage-receiver-<kind>/` | rendered receivers on `capture/` with `RS_RECEIVER_SABOTAGE=<kind>` |
| `import` (receiver) | g5e  | `mesh/import/receiver/` | the mise editor's `--import` of `receiver/`                                                                       |
| `receiver-headless-trace` (mesh) | g5e | `mesh/receiver-headless-trace/` | the template, `--headless`, on `mesh/capture/`'s full sink under strace (openat)                  |
| `capture-mesh-inline` | g5e | `mesh/capture-inline/` | as `capture-mesh` (quit 400), every payload inline: `GRC_RESOURCE_INLINE_MAX_BYTES` and `GRC_RESOURCE_MAX_PAYLOAD_BYTES` 16 MiB, no store |
| `receiver-mesh`, `receiver-mesh-patch` | g5e | `mesh/receiver/`, `mesh/receiver-patch/` | rendered receivers on `mesh/capture/`'s full and patch sinks (`applied.json` /4 with `mesh_uploads`; the patch one also `state/seq-<n>.json`) |
| `receiver-mesh-inline` | g5e | `mesh/receiver-inline/` | rendered receiver on `capture-inline`'s full sink, no store                                       |
| `sabotage-mesh-freeze`, `-omit-vertex-region`, `-perturb-vertex` | g5e | `mesh/sabotage-mesh-<kind>/{capture,receiver}/` | headless captures of the mesh fixture's own 102 frames with `freeze-frame` @11, `omit-op mesh_surface_update_vertex_region` @21, `perturb-vertex` @21, each with a rendered receiver |
| `sabotage-mesh-receiver-drop-surface`, `-stale` | g5e | `mesh/sabotage-mesh-receiver-<kind>/` | rendered receivers on `mesh/capture/` with `RS_RECEIVER_SABOTAGE=drop-mesh-surface` / `stale-mesh` |
| `import-style`     | g5g   | `style/import/{fixture,receiver}/` | the mise editor's `--import` of `fixtures/gate5-style` and of `receiver/`                       |
| `capture-style`    | g5g   | `style/capture/`    | as `capture`, on `fixtures/gate5-style`                                                                               |
| `reference-style`, `reference-style-repeat`, `reference-style-armed` | g5g | `style/reference{,-repeat,-armed}/` | as g5b's three, on `fixtures/gate5-style` (own gamescope)               |
| `receiver-headless-trace` (style) | g5g | `style/receiver-headless-trace/` | the template, `--headless`, on `style/capture/`'s full sink under strace (openat)                 |
| `receiver-style`, `receiver-style-patch` | g5g | `style/receiver/`, `style/receiver-patch/` | as g5d's receivers, on `style/capture/` (the patch one with state dumps)                 |
| `sabotage-style-receiver-ignore-axis` | g5g | `style/sabotage-receiver-ignore-axis/` | rendered receiver on `style/capture/` with `RS_RECEIVER_SABOTAGE=ignore-nine-patch-axis` |

## Gate 5 criteria (g5b)

`capture-armed`, `headless-no-gpu`, `recording-decodes` (both sinks), `patch-resolves-to-full` and
`no-draw-index-ties` are gate 3's; `step-alignment` reads the four step logs and the capture's
marker colours. `expected-self-consistent` re-derives in TypeScript what `make_expected.py`
asserts: grid colours (alpha 1, the blend polygon .6), disjoint regions with nothing synthesized
outside them, tie-freeness of every integer non-axis boundary edge of an exact mesh, the census
columns, and `fresh` against the raster. `geometry-hook-census` requires `counters.json`'s counts
per draw op to equal `hook_census` (an op the record does not hook yet, `add_multiline` before
calibrator 7, must be absent and is reported), every other draw op 0, and three texture creates.
`expected-image-reference` compares every shot with `rasterizeGate5` on every decided pixel (exact,
or within 1 where colours interpolate or blend). `presence-reference` requires every sub-shape,
band included, to change at least half its covered pixel count from what the raster has beneath
it. `freshness-reference` requires a region to change between consecutive shots exactly when
`fresh` says. `reference-repeat-budget` requires identical shots and reports the maxima per region
and pixel class (exact, delta1, band, undecided). `armed-transparent` requires the armed
reference's shots to equal the reference's. `leg-class-capture` requires class `success` on
render-stream/4 (it was `unsupported`, every op but `add_rect` typed, on /3 before G5d): no
unsupported entry or command, and at every settle frame each item's commands carry exactly its
expected calls' /4 ops in call order. `support-legs-exit` requires the import and rendered legs to
exit 0.

## Gate 5 criteria (g5c)

The capture checks run on `mesh/` under `mesh-` names (`mesh-capture-armed`, `mesh-headless-no-gpu`,
`mesh-recording-decodes`, `mesh-patch-resolves-to-full`, `mesh-step-alignment`,
`mesh-no-draw-index-ties`). `mesh-expected-self-consistent` re-derives the colour, texel, region,
raster and `fresh` rules, each live mesh's surface count and the census versions (+1 per accepted
call, a free carrying the last). `mesh-draw-census` requires `counters.json` to equal `draw_census`
(one `add_mesh` per item draw, `DF` on every frame, every mesh call, `attach_skeleton` per
`Polygon2D` draw plus its destructor's at teardown) and every other draw op 0. `mesh-census` requires
the hook log's mesh lines, frame by frame up to the quit frame, to equal the census expanded with
`DF`'s per-frame rule, on the capture (quit 400) and on the armed reference (quit 102): ids 1.. in
`mesh_order`, all on the main thread and `applied`. `oracle-agrees` requires both oracle logs to
report every mesh's status, surface count, custom AABB, primitives, formats and counts as
`expected.json`, the derived `Polygon2D` RID verified, and the two logs byte-identical.
`mesh-hook-hash-parity` requires, at every settle step and for every live surface, the hook log's
last hash (capture and armed reference), the oracle's readback hash and `make_expected.py`'s GRM1
model to be one hash. `mesh-expected-image-reference` compares every shot with the raster on the
exact regions (`DF` is band), `mesh-presence-reference` every surface's presence,
`mesh-freshness-reference` `fresh` with `RM` changing at 2, 3 and 4 without a redraw,
`mesh-reference-repeat-budget` and `mesh-armed-transparent` the legs pixel for pixel.
`leg-class-capture-mesh` requires class `success` since G5e (`unsupported` with
`canvas_item_add_mesh` the only unsupported op before): nothing unsupported, each item's commands
per settle frame -- `add_mesh` naming the hook log's id of its mesh (`DF2` from step 5, `FM`'s
tombstone at 7) with identity, white and `TEXG` for `DF`, `FR`'s empty from 8 -- and `RM`'s
`content_version` constant over the run. `mesh-support-legs-exit` requires the import and rendered
legs to exit 0.

## Gate 5 criteria (g5d)

`geometry-commands` requires, at every settle frame of both sinks, each item's commands to equal
`expected.json`'s calls as /4 commands (render-stream-4.md's resolved forms), set_transform and
clip_ignore included: passthrough arguments float32-exact, computed ones (`ulp: 2`) within 2 ulp,
texture names mapped to the capture's wire ids. `lowering-predictions` checks the capture against
`lowering_predictions` (Line2D one triangle array of 6 vertices, 12 indices, count -1; the dashed
line one multiline of 16 points; the unfilled rect and circle closed polylines of 5 and 65 points)
at every settle frame, and that L2's command is identical across step 3 although it redraws.
`leg-class-receiver` and `leg-class-receiver-patch` require `success` with every region of every
shot equal to the reference's; `receiver-vs-reference` requires identical shots (budget 0);
`expected-image-receiver` and `presence-receiver` are g5b's image checks on the receiver's shots.
`clip-rects-derived` runs `deriveClipRects` over both sinks' settle states and receiver-patch's state
dumps (each dump must also equal the recording's resolved state): every item's scissor is its
`clip_px` and CG's clip-ignored commands are exactly those between its `add_clip_ignore` pair.
`leg-class-capture-canvas` requires `unsupported` with exactly `predictions["capture-canvas"]`'s
(item, op) pairs refused as `canvas-texture-headless`, in place, every other command as on the main
capture. The five sabotage legs (`leg-class-sabotage-*`) require `pixel-mismatch` with exactly the
predicted steps (freeze) or, per step, exactly the predicted regions (the others).
`receiver-never-loaded-fixture` is gate 0's, over every g5d receiver log; `receiver-typed-clean`
scans them for script errors.

## Gate 5 criteria (g5e)

`mesh-versions-current` requires every transaction of both sinks of `capture-mesh` and of
`capture-mesh-inline` to carry, per mesh entry, the hook log's id, version, status and surface
hashes at the end of its frame (the log replayed by wire id, omitted lines excluded), and every
mesh the log holds live. `mesh-hash-parity` requires, at every settle step and on all three
recordings, each mesh the oracle reads back live to be the wire entry of its hook-log id with the
oracle's GRM1 hashes in order. `mesh-census-wire` requires the wire's mesh table per frame to be
`predictions["mesh-lifetimes"]` (`DF`'s id leaves and `DF2`'s arrives at 51, `FM` a named `freed`
tombstone 71-80, gone at 81) and the patch sink to remove each id the frame it leaves.
`fresh-without-redraw-wire` requires `RM`'s `content_version` constant over the run while `RMS`'s
version and hash change exactly on the census's `RMS` frames (21, 31, 41). `store-complete-mesh`
requires every ok mesh surface of either sink to be `sha256/<hash>.grm` in the store, hashing to
its name, with a `mesh-surface` index line (textures `.grt`, `texture-2d`), nothing else, and the
inline capture to have no store. `leg-class-capture-mesh-inline` requires `success`.
`leg-class-receiver-mesh`, `-patch` and `-inline` require `success` (D15: classifyLeg plus
`mesh-log-divergence` -- ids, versions and statuses against the log -- as a capture-failure);
`receiver-vs-reference-mesh` requires all three receivers' settle shots to equal the reference's at
every pixel, `DF`'s band region included. `receiver-mesh-uploads` requires each receiver's
`mesh_uploads` to equal `predictions["receiver-mesh-uploads"]` frame by frame over the 400 frames
(creates, in-place updates naming exactly the changed buffers, rebuilds on a layout change, custom
AABBs, frees, bytes). `resource-quiet-mesh` requires no mesh payload fetched twice or outside its
mesh's census frames (`DF`/`DF2` excepted), each fetched at the frame its hash first appears on the
wire, and the inline receiver to fetch none. `fresh-without-redraw-receiver` is the freshness check
on `receiver-mesh`'s shots (`RM` at 2, 3, 4). `receiver-state-dumps-mesh` requires
`receiver-mesh-patch`'s dumps, meshes included, to equal the recording's resolved state. The five
sabotage legs require `pixel-mismatch` with `predictions`' steps (freeze) or regions per step;
`sabotage-mesh-log-signature` requires omit-op's wire to equal the log, perturb-vertex to keep ids
and versions and re-hash exactly the payloads taken from its frame on, and freeze to republish the
log's frame-10 mesh table. `receiver-typed-clean-mesh`, `receiver-never-loaded-fixture-mesh` and
`mesh-receiver-support-legs-exit` are g5d's over the g5e receivers.

## Gate 5 criteria (g5g)

Every g5b and g5d check that applies runs again on `style/` with a `-style` suffix
(`capture-armed-style` ... `leg-class-capture-style`, `geometry-commands-style`,
`leg-class-receiver-style{,-patch}`, `receiver-vs-reference-style`, `expected-image-receiver-style`,
`presence-receiver-style`, `clip-rects-derived-style`, `receiver-never-loaded-fixture-style`,
`receiver-typed-clean-style`), against `fixtures/gate5-style/expected.json`: its colour rule exempts
`theme_shapes` (the default theme's Panel box, off the 0.2 grid) and lets `translucent_shapes` (the
shadow fill) and band rings carry alpha .6 or 0, and `hidden_items` (the RichTextLabel's hidden
scrollbar) have no derived scissor. `stylebox-lowering-style` requires each StyleBoxFlat triangle
array, in the expected calls and at every settle frame of the capture, to have Q1h's hand-typed
vertex and index counts (`lowering_predictions`), one colour and uv per vertex and whole in-range
triangles, every box drawn. `nine-patch-args-style` requires every `add_nine_patch` on both sinks to
equal its call float32-exact. `focus-clip-ignore-style` requires RT's commands to be
`clip_ignore(true)`, the focus box, `clip_ignore(false)` exactly at
`predictions["focus-clip-ignore"]`'s steps and empty otherwise, and no other item to carry one.
`ignore-axis-prediction-style` rasterizes the model with every nine-patch axis forced to `stretch`
and requires it to differ exactly in `sabotage-style-receiver-ignore-axis`'s predicted regions and
steps (`NT`, `NF`, every step); `leg-class-sabotage-style-receiver-ignore-axis` requires the real
sabotaged receiver to mismatch exactly there.

## Gate 5 self-test

```bash
mise exec -- pnpm exec tsx --conditions=development experiments/render-stream/scripts/test/self-test-gate5.ts
python3 experiments/render-stream/fixtures/gate5/make_expected.py --check
python3 experiments/render-stream/fixtures/gate5-style/make_expected.py --check
mise exec -- pnpm exec tsx --conditions=development experiments/render-stream/scripts/test/self-test-gate5c.ts
python3 experiments/render-stream/fixtures/gate5-mesh/make_expected.py --check
mise exec -- pnpm exec tsx --conditions=development experiments/render-stream/scripts/test/self-test-gate5e.ts
```

The rasterizer is checked on hand cases whose answers are typed in, not computed by it: a tie-free
triangle against its edge equation (coverage, the 1/16 px decision inside and outside, a near-edge
pixel), a set-transform that replaces rather than composes, a clip-ignore span, a gradient and a
`.6` blend with hand-computed bytes, `map_ninepatch_axis` in `stretch`, `tile`, `tile_fit` and the
end margin, a hollow nine-patch, a thin line and an antialiased rect's band, and a welded closed
strip. `checkExpectedSelfConsistent` passes on the committed file and fails on an off-grid colour,
overlapping regions, an even-parity edge, a census cell and a wrong `fresh`. The image checks run
on frames built from the raster (band areas painted) and fail on an exact pixel off by 1, a
delta-1 pixel off by 2, a missing polygon or thin line, a stale or a spuriously changed region and
a differing band pixel. `geometry-hook-census` runs on synthetic counters, before and after
calibrator 7 hooks `add_multiline`, and fails on a count, an unexpected op and the texture creates.
`leg-class-capture` runs on a synthetic /4 recording built from `expected.json` and fails on a
class, a command still typed `unsupported` and a command order. The g5d evaluators run on the same
synthetic recording: `geometry-commands` passes, accepts a computed value 2 ulp off (and counts
it), and fails on 3 ulp, on a passthrough argument 1 ulp off, a missing `add_clip_ignore` and a
wrong texture id; `lowering-predictions` fails on a changed Line2D command and a missing dash;
`evaluateLegClass5` passes perturb-vertex's predicted regions and freeze's steps and fails on an
extra region, a missing one and a mismatch where `success` is expected; `capture-canvas` passes the
predicted refusals and fails on `tex: null` draws and a refused textured polygon. `clip-derive.ts`
is checked on hand cases: rects after a `set_transform` go through it and a second one replaces the
first, two in a row do not compose, a wide line's rect is its quad, a circle's is unknown, the
clip-ignore span is the commands between the pair and is reported only under a clip owner; and
`clip-rects-derived` passes on synthetic states built from `expected.json` and fails without CG's
`add_clip_ignore` pair.

`test/gate5g-cases.ts` adds g5g's: `tile_fit` at `NF`'s width and TabBar's flip against typed-in
values, a modulated texel off the UNORM8 levels at delta 1, the style file's colour rule (failing
without the theme exemption or the translucent shadow fill, or with a ring alpha .75),
`stylebox-lowering` on the calls and on a synthetic /4 recording (failing on a dropped vertex and a
missing focus box), the ignore-axis prediction (failing with `NS` added), `nine-patch-args`
(failing with `NT` drawn stretch), `focus-clip-ignore` and `leg-class-capture` (failing when the
pair outlives the focus), the census, and the image checks on the style raster (the theme Panel's
blend off by 2, the focus box missing, no resize at step 2).

`self-test-gate5c.ts` runs `checkMeshExpectedSelfConsistent` on the committed mesh expected.json
and fails it on a wrong `fresh`, a surface count and a census version; checks `expandCensus`'s
shape (three `DF` lines a frame, `DF2` at 2 + 3 × 349 by frame 400, bounded at the quit frame);
runs `evaluateMeshCensus` on the census written out as a log (with a teardown free after quit) and
fails it on a missing line, a version, an extra mesh, a line off the main thread and a rejected
update; replays a hand hook log (adds, an update, a remove, a clear, a free, a single-surface
`create_from_surfaces`); and runs the oracle, parity, draw-census and capture checks on synthetic
values, failing each on one field, hash, flag or command (G5e: the capture's `add_mesh` commands,
failing on a class, an `unknown-mesh` entry, `FR` not cleared, `DF` naming its freed mesh, `DF`
untextured and `RM` redrawn).

`self-test-gate5e.ts` runs `meshLogDivergence` on a hand log and wire (one wire version per frame,
an omitted line ignored) and fails it on a version, a missing live mesh and (with hashes) a hash;
`classifyMeshLeg` turns a divergence into `capture-failure`; perturb-vertex's log signature passes
and fails on an unperturbed late payload and a perturbed early one. A wire synthesized from
`expected.json` passes `mesh-hash-parity`, `mesh-census-wire` and `fresh-without-redraw-wire`, which
fail on a hash, a tombstone gone early, a patch not removing `DF` and `RM` redrawn. An applied.json
synthesized from `predictions["receiver-mesh-uploads"]` passes and fails on a missing index update,
a re-uploaded unchanged buffer and an in-place `P2` change; `resource-quiet-mesh` fails on a hash
fetched twice and on `LD` fetched off its census. `meshRects`/`itemRect` are checked on hand
cases: a custom AABB wins, surface AABBs merge, a tombstone is a zero rect, a missing surface AABB
or id is unknown, and the draw transform applies but not the command's own.

## Gate 5.5 files

```bash
mise exec -- pnpm render-stream:gate55 -- \
  --extension "$PWD/experiments/render-stream/capture/build/render_stream_capture.gdextension" \
  --calibration "$PWD/experiments/render-stream/calibration/godot-4.5.1-stable-linux-release.json" \
  [--legs g55b,g55c,g55d,g55e]
```

- `run-gate55.sh`: the orchestrator (`run_g55b` with `run_cim_capture` and `run_cim_rendered`,
  `run_g55c`, `run_g55d` with `run_cim_capture_inline`, `cim_sabotage_capture` and
  `run_cim_receivers`, `run_g55e` with `shader_capture`, `run_reference` with `REFERENCE_ARMED`,
  `REFERENCE_VARIANT`, `REFERENCE_FIXTURE_DIR` and `REFERENCE_MATERIAL_ORACLE`). g55d replays
  g55b's captures and compares with g55b's references, so `--legs g55d` adds g55b (and says so);
  g55e likewise adds g55c, whose captures, references and oracle library it uses. Groups run in
  landed order. Group g55f is known but has not landed, so asking for it exits 2. The
  captures write both sinks under gate 2's `.rs2` names; they speak render-stream/5 since G55d.
- `check-gate55.ts`: the checker CLI; writes `<out>/result.json` (`render-stream-gate55-report/1`:
  gate 5's shape with `materials` (per fixture: the material `counters.json` counts, the oracle's
  shader hash per step and the capture's `content_version`s per item; g55b: per variant the
  material census as measured and predicted, calibrator 8's state, `content_version`s and the
  raster's pixel classes; g55d: per variant under `g55d` the shader policy, the GRP1 store, receiver
  budgets, sabotage regions, receiver counter totals, the wire census events and `per_step`:
  shader and material counts at the settle frame, GRP1 payload bytes first published, `param_f64`
  bytes on the patch sink and in one full transaction, the hook log's `copy_ns`/`hash_ns`/
  `scan_ns`/`decode_ns`, and per receiver its shader fetches, material calls and `rs_calls`; g55e:
  under `gate55-shader.g55e` the same `per_step` for `capture-shader` and its receivers and
  `per_step_params` for `capture-policy-params` and its two receivers, the GRP1 store, the oracle
  shader -> wire id pairing, receiver budgets, sabotage regions, the receivers' typed refusals and
  the policy scan summary), `budgets` and `freshness`).
- `lib/gate55b-expected.ts`: `fixtures/gate55-cim/expected.json`'s types, `asGate5` (one variant
  as a gate 5 scene), `rasterize55` (the raster on the 2-bit-alpha target) and
  `expectedItemMaterials` (each item's CimSim material and `use_parent_material` per step).
- `lib/gate55b-checks.ts`: the g55b checks: self-consistency against the Python blend twin's
  probes, the material census (counters before calibrator 8, the hook log per step window after),
  the /5 capture (`evaluateCimCapture5`), `runGate55b`.
- `lib/gate55-wire.ts`: `loadWire5`, a recording decoded at an explicit version (5 from G55d, 6 since G6b):
  per transaction its wire meta (a patch's partial lists, the `param_f64` size) beside its resolved
  state (shader and material tables, item material fields, canvas modulate), plus the resource
  records.
- `lib/gate55d-checks.ts`: the g55d checks: the hook-log replay with D5 (`replayMaterialLog`,
  `materialLogDivergence`), `classifyMaterialLeg` (D15), the builtin-mode, canvas-modulate,
  census, freshness, quiet, typed-clean, state-dump and store evaluators, `materialsPerStep`,
  `runGate55d`.
- `lib/geometry-raster.ts` (gate 5's) gained a per-mesh `blend` (`add`, `sub`, `mul`,
  `premul_alpha`, `disabled`; absent is `mix`) and `targetAlphaBits`; an alpha-0 shape under an
  alpha-scaled blend covers nothing.
- `lib/gate55c-checks.ts`: the g55c checks (fixtures/gate55-shader): `expected.json`'s types, the
  refused variant's view, the oracle checks, the capture typing, `runGate55c`. Image, presence,
  freshness and leg comparisons are gate 5's (`lib/gate5-checks.ts`, `lib/geometry-raster.ts`).
- `lib/gate55e-checks.ts`: the g55e checks (fixtures/gate55-shader end to end): `applyPolicyToLog`
  (D4 on the hook log's view), `evaluateShaderHashParity`, `evaluateParamParity` (with
  `textureHashNames`/`wireParamView`), `evaluatePolicyRespected` (with `codeBytesIn`),
  `evaluateReceiverTyped`, `residentShaderVersions`, `viewExpected` (a receiver view as a scene),
  `runGate55e`. It reuses g55d's log replay, store, state-dump and per-step evaluators.
- `lib/gate55f-checks.ts`: the g55f checks (live legs on fixtures/gate55-shader, gate 1's live
  timeline): `g55fWindows`/`g55fStallReport` (gate 1's G1d stall report, unmodified),
  `g55fCheckpoints` (a settle shot against `reference-live`'s, `PH`-only benign when the wire's
  own state at that frame equals the host's full recording), `checkShaderFetchesLatestOnly`,
  `checkStaleCoalesce` (the expected mismatch set derived from `expected.json`'s per-step `fresh`
  table unioned over `StallReport.steps_applied_during`), gate 2's live pin/retire/HTTP checks
  generalized with `okShaderHashes`/`shaderTableHashes` (gate2c-checks.ts), `runGate55f`.
- `test/self-test-gate55b.ts`, `test/self-test-gate55c.ts`, `test/self-test-gate55d.ts`,
  `test/self-test-gate55e.ts`, `test/self-test-gate55f.ts`: below.

## Gate 5.5 legs and evidence under `--out`

| Leg                       | Group | Directory                    | Runs                                                                                              |
| ------------------------- | ----- | ---------------------------- | ------------------------------------------------------------------------------------------------- |
| `import-cim`              | g55b  | `cim/import/fixture/`        | the mise editor's `--import` of `fixtures/gate55-cim`                                             |
| `capture-cim`             | g55b  | `cim/capture/`               | the release template, `--headless`, armed, both sinks, the store, `GRC_ROOT_SIZE=enforce-min-size`, quit 400, strace + maps/fd |
| `capture-cim-modulate`    | g55b  | `cim-modulate/capture/`      | the same with `RS_FIXTURE_VARIANT=modulate`                                                       |
| `reference-cim`           | g55b  | `cim/reference/`             | rendered in gamescope, extension absent: `shots/step-0..9.png`, `steps.jsonl`                     |
| `reference-cim-repeat`    | g55b  | `cim/reference-repeat/`      | the same again                                                                                    |
| `reference-cim-armed`     | g55b  | `cim/reference-armed/`       | rendered, extension armed with `GRC_STREAM_OUT` and a store                                       |
| `reference-cim-modulate`, `-repeat`, `-armed` | g55b | `cim-modulate/reference*/` | the same three with `RS_FIXTURE_VARIANT=modulate`                                   |
| `import-shader`           | g55c  | `shader/import/fixture/`     | the mise editor's `--import` of `fixtures/gate55-shader`                                          |
| `capture-shader`          | g55c  | `shader/capture/`            | the release template, `--headless`, armed, both sinks, the store, `GRC_ROOT_SIZE=enforce-min-size`, quit 400, strace + maps/fd |
| `capture-refused`         | g55c  | `shader-refused/capture/`    | the same with `RS_FIXTURE_VARIANT=refused`                                                        |
| `reference-shader`        | g55c  | `shader/reference/`          | rendered in gamescope, extension absent, material oracle on (`RS_FIXTURE_MATERIAL_LOG`): `shots/step-0..9.png`, `steps.jsonl`, `materials.jsonl`, `shader-library/sha256/*.grp` |
| `reference-shader-repeat` | g55c  | `shader/reference-repeat/`   | the same again                                                                                    |
| `reference-shader-armed`  | g55c  | `shader/reference-armed/`    | rendered, extension armed with `GRC_STREAM_OUT` and a store, oracle off                           |
| `reference-refused`       | g55c  | `shader-refused/reference/`  | rendered, variant `refused`, oracle on                                                            |
| `import-receiver-cim`     | g55d  | `cim/import/receiver/`       | the mise editor's `--import` of `receiver/`                                                       |
| `capture-cim-inline`      | g55d  | `cim/capture-inline/`        | as `capture-cim` with no store and `GRC_RESOURCE_INLINE_MAX_BYTES`/`GRC_RESOURCE_MAX_PAYLOAD_BYTES` 16 MiB: every payload, GRP1 included, a resource record |
| `receiver-cim`            | g55d  | `cim/receiver/`              | rendered receiver on `capture/`'s full sink and store: `applied.json`, `shots/seq-<n>.png` at the settle seqs |
| `receiver-cim-patch`      | g55d  | `cim/receiver-patch/`        | the same on the patch sink, plus `state/seq-<n>.json` at the settle seqs                          |
| `receiver-cim-inline`     | g55d  | `cim/receiver-inline/`       | rendered receiver on `capture-inline/`                                                            |
| `sabotage-cim-freeze`     | g55d  | `cim/sabotage-freeze/{capture,receiver}/` | a 102-frame capture with `GRC_SABOTAGE=freeze-frame` @11 and its rendered receiver   |
| `sabotage-cim-omit-material-set-shader` | g55d | `cim/sabotage-omit-material-set-shader/{capture,receiver}/` | `GRC_SABOTAGE=omit-op`, `GRC_SABOTAGE_OP=material_set_shader` @21 |
| `sabotage-cim-receiver-ignore-material` | g55d | `cim/sabotage-receiver-ignore-material/` | `RS_RECEIVER_SABOTAGE=ignore-material` on `capture/`                          |
| `capture-cim-modulate-inline`, `receiver-cim-modulate`, `-patch`, `-inline` | g55d | `cim-modulate/…` | the same four with `RS_FIXTURE_VARIANT=modulate`                         |
| `sabotage-cim-modulate-receiver-ignore-canvas-modulate` | g55d | `cim-modulate/sabotage-receiver-ignore-canvas-modulate/` | `RS_RECEIVER_SABOTAGE=ignore-canvas-modulate` on `cim-modulate/capture/` |
| `import-receiver-shader`  | g55e  | `shader/import/receiver/`    | the mise editor's `--import` of `receiver/`                                                       |
| `capture-shader-inline`   | g55e  | `shader/capture-inline/`     | as `capture-shader` with no store and both payload thresholds at 16 MiB: every payload a resource record |
| `capture-policy-params`   | g55e  | `shader-policy-params/capture/` | as `capture-shader` (no strace) with `GRC_SHADER_POLICY=params`                                |
| `capture-policy-exclude`  | g55e  | `shader-policy-exclude/capture/` | as `capture-shader` (no strace) with `GRC_SHADER_POLICY=exclude`                              |
| `receiver-shader`, `-patch`, `-inline` | g55e | `shader/receiver{,-patch,-inline}/` | rendered receivers on `capture/`'s full sink, its patch sink (state dumps at the settle seqs) and `capture-inline/` |
| `receiver-refused`        | g55e  | `shader-refused/receiver/`   | rendered receiver on `capture-refused`'s full sink                                                |
| `receiver-params-nolib`   | g55e  | `shader-policy-params/receiver-nolib/` | rendered receiver on `capture-policy-params`, no shader library                        |
| `receiver-params-lib`     | g55e  | `shader-policy-params/receiver-lib/`   | the same with `RS_RECEIVER_SHADER_LIBRARY=<out>/shader-policy-params/library`, a copy of `reference-shader`'s oracle `shader-library/` |
| `sabotage-shader-freeze`, `-omit-param`, `-perturb-shader` | g55e | `shader/sabotage-{freeze,omit-param,perturb-shader}/{capture,receiver}/` | 102-frame captures with `freeze-frame` @11, `omit-op material_set_param` @21, `perturb-shader` @21, each with its rendered receiver |
| `sabotage-shader-receiver-ignore-material`, `-stale-param` | g55e | `shader/sabotage-receiver-{ignore-material,stale-param}/` | `RS_RECEIVER_SABOTAGE` on `shader/capture/` |
| `import-fixture-g55f`, `import-receiver-g55f` | g55f | `shader-live/import/{fixture,receiver}-g55f/` | the mise editor's `--import` of `fixtures/gate55-shader` and `receiver/` (g55f imports both itself) |
| `reference-live`           | g55f  | `shader-live/reference-live/`  | rendered, extension absent, gate 1's live timeline (`RS_FIXTURE_START_FRAME=300`, `_STEP_FRAMES=60`, `_QUIT_FRAME=851`): `shots/step-0..9.png` |
| `live-shader`              | g55f  | `shader-live/live-shader/{host,receiver}/` | a live host (armed, both sinks, the store, `GRC_LIVE_LISTEN`) and a rendered live receiver, fresh cache |
| `live-shader-warm`         | g55f  | `shader-live/live-shader-warm/{host,receiver}/` | a new host and receiver, `RS_RECEIVER_CACHE_DIR=live-shader/receiver/cache`, `RS_RECEIVER_CACHE_MODE=warm` |
| `live-shader-stall`        | g55f  | `shader-live/live-shader-stall/{host,receiver}/` | `RS_RECEIVER_STALL=1:2000` (after step 1's shot) |
| `sabotage-shader-stale-coalesce` | g55f | `shader-live/sabotage-shader-stale-coalesce/{host,receiver}/` | the same stall, host `GRC_SABOTAGE=stale-coalesce` from step 1's frame |

## Gate 5.5 criteria (g55b)

`cim-expected-self-consistent` re-derives in TypeScript what `make_expected.py` asserts, for both
variants: grid colours with alpha 1, .6 (the strips) or 0 (`light_only`), marker colours distinct
as drawn and as shown under the canvas modulate, disjoint regions with every rect inside its own,
the blend-aware raster equal to every probe of the Python twin (colour, alpha and allowed delta)
with every pixel decided and nothing but the clear colour outside the regions, probes exactly in the
fresh regions, `fresh` against the raster, `typed_entries` the items with a material, and
`hook_census` the sum of the steps. Per variant (ids prefixed `cim-` and `cim-modulate-`): the
capture checks are gate 3's (`capture-armed`, `headless-no-gpu`, `recording-decodes`,
`patch-resolves-to-full`, `step-alignment` on the unmodulated marker colours, `no-draw-index-ties`).
`material-census` requires `counters.json` to equal `hook_census` for the material ops the record
hooks before calibrator 8 (`canvas_item_set_material`, `material_set_param`, `shader_set_code`,
`shader_create_from_code`), `canvas_item_add_rect` and `texture_2d_create`, and reports
calibrator 8's ops `unhooked`; once the record plans all of them, the hook log's material lines
(`op` or `call`, `free` split by `kind`, omitted lines skipped) must equal each step's `census`
between its applied frame and the next one's. `expected-image-reference` compares every shot with
the raster on every pixel (exact; within 1 for `mul` and the .6 strips but `disabled`'s, whose
alpha is exact). `presence-reference` requires every visible rect present, `freshness-reference`
`fresh` with only the marker redrawn after step 0 (`UC` at 6), `reference-repeat-budget` and
`armed-transparent` the legs pixel for pixel, alpha included. `leg-class-capture-cim` and
`leg-class-capture-cim-modulate` require class `success` on render-stream/5 with no unsupported
entry, each item's `add_rect` commands float32-exact and unmodulated, each item's `material` the
one CimSim gave it at every settle frame (CimSim's attached ids paired with the wire's in ascending
order: `RI` null at 4, a new id from 5) and its `use_parent_material` CimSim's (`UC` from 6), and
every item's `content_version` constant but the marker's (before G55d: `unsupported`, every item
naming a material typed `unsupported-state`). `cim-support-legs-exit` requires the import and the
six rendered legs to exit 0.

## Gate 5.5 criteria (g55c)

`shader-expected-self-consistent` and `refused-expected-self-consistent` re-derive in TypeScript
what `make_expected.py` asserts: grid colours at alpha 1, disjoint regions with nothing synthesized
outside them, `fresh` against the raster, only the marker redrawn after step 0, the oracle views in
shader and material order with their declared parameters and statuses moving absent → live →
freed, and `PH`'s phase the settle frame. The capture checks are gate 3's under `shader-` and
`refused-` names (`shader-capture-armed`, `shader-headless-no-gpu`, `shader-recording-decodes`,
`shader-patch-resolves-to-full`, `shader-step-alignment`, `shader-no-draw-index-ties`,
`refused-capture-armed`, `refused-recording-decodes`, `refused-step-alignment`). `shader-counters`
requires both captures' `counters.json` to equal `expected.json` `counters`: the four material calls
the record hooks before calibrator 8, with `PH`'s `phase` on every frame, the draws and three
textures. `capture-shader-log-clean` requires neither capture host to print `SHADER ERROR` or
`Shader compilation failed`. `oracle-agrees` requires every oracle log (both references and
`reference-refused`) to report each shader's and material's status and every declared parameter
and instance parameter with `expected.json`'s Variant type and value (float32 components widened,
compared exactly), and the two reference logs to be byte-identical. `shader-code-model` requires
each live shader's GRP1 hash, size and include markers, as the oracle reads them through
`shader_get_code`, to equal `make_expected.py`'s preprocessor port. The image checks are gate 5's
on the shader fixture (`shader-expected-image-reference`, `shader-presence-reference`,
`shader-freshness-reference` with `TI` fresh at 1, 3 and 4 and its `content_version` constant,
`shader-reference-repeat-budget`, `shader-armed-transparent`) and on the refused reference
(`refused-expected-image-reference`, every region exact). On render-stream/5 (since G55d)
`leg-class-capture-shader` requires class `success` with no unsupported entry and every shader
entry `ok`; `leg-class-capture-refused` requires class `unsupported`, its only entries item-level
`canvas_item_set_material` / `unsupported-material` on exactly `TM`, `SC`, `SD`, `GU` and `SP` at
every settle frame, and its shader entries (wire ids ascending paired with `shader_order`) `ok`
except the five refused ones, `unsupported` with exactly `shader_scan`'s reason (`shader-time`,
`shader-screen-texture`, `shader-sdf`, `shader-global-uniform`, `shader-mode`). Both require every
item's `content_version` constant but the marker's. `shader-support-legs-exit`
requires the import and rendered legs to exit 0.

Three checks read G55a's shader and material hook log (`evidence/resources.jsonl`, kinds `shader`,
`material` and `item-material`):

- `material-census` requires the log, frame by frame up to each quit frame, to equal the census
  expanded with `PH`'s per-frame rule. It reads `capture-shader` (to 400),
  `reference-shader-armed` (to 102) and `capture-refused` (to 400). The comparison covers op,
  entity, version and the shader or material named, or `param:type` in D8's spelling, with ids
  1.. in `shader_order` and `material_order`. Lines must be on the main thread and `applied`.
  Teardown frees after the quit frame are reported, not compared.
- `shader-hook-hash-parity` requires, at every settle step, each shader's last hook hash to equal
  the reference oracle's `shader_get_code` hash and the model's, on both hosts and the refused
  variant. A freed shader must be freed in the log too.
- `shader-scan` requires every code line's mode, `uses` and status and reason to equal
  `shader_scan`: the five refused reasons, and `inst`'s `instance_uniform`.

## Gate 5.5 criteria (g55d)

Per scene, ids prefixed `cim-` and `cim-modulate-` (G55b amendment 8); every wire read decodes at
version 5 explicitly (`lib/gate55-wire.ts`). The hook log (`evidence/resources.jsonl`) is replayed
with D5: a `free` of a shader nulls every material naming it at version + 1 with no line of its
own, as the log's registry and the mirror do.

- `material-commands`: at every transaction of both capture sinks (and of `capture-inline` against
  its own log), the shader and material tables equal the replay at the end of that frame: shader
  id, version, status, reason, mode, source, hash, payload size, builtin descriptor, uses and
  default textures; material id, version, status, reason, shader and parameter names, types and
  counts (the log carries no values; a packed array's log type is its element type). Nothing on
  the wire the log lacks, nothing live in the log missing (D15 `material-log-divergence`).
- `builtin-modes`: at every settle frame of both sinks each item's `material` and
  `use_parent_material` are CimSim's, each item in `effective` reaches through item → parent (while
  `use_parent_material`) → material → shader a builtin descriptor with exactly that blend and light
  mode, each own CanvasItemMaterial's shader carries `builtin` exactly, and every other item draws
  with no material.
- `canvas-modulate-wire`: the root canvas's `modulate` equals `canvas_modulate` at every settle
  frame of both sinks.
- `material-census-wire`: each table event CimSim predicts after step 0 lands in exactly one patch
  transaction at its applied frame: the freed shaders in `removed_shaders` (11, 21, 31), step 3's
  new shader id, step 4's material in `removed_materials` (41), step 5's recreation as a new id
  larger than every earlier one (51), and `RI`'s material null at 41 and the new id at 51 on the
  patch item entry and the full sink.
- `shader-store`: every `ok`/`payload` shader hash of either sink is `store/sha256/<hash>.grp`,
  hashing to its name, a valid GRP1 payload of its entry's size, with an `index.jsonl` line typed
  `shader-code`; `capture-inline` has no store and sends each shader hash as a resource record
  before the first transaction naming it.
- `fresh-without-redraw`: `UC`'s `use_parent_material` flips at step 6's applied frame while its
  `content_version` keeps one value; the patch transaction carries `UC` with commands null; the
  `receiver-cim` UP region changes at 6 and every receiver region changes exactly when `fresh`.
- `resource-quiet`: no patch transaction in steps 7's and 9's windows carries a shader or material
  entry or removal; every honest receiver's `applied.json` shows zero `shaders_created`,
  `shader_code_sets`, `shader_payload_fetches`, `materials_created`, `param_sets` and
  `instance_param_sets` there, and over the run creates each shader and material id once.
- `receiver-vs-reference`: the three honest receivers equal the reference on every pixel of every
  settle shot, raw per channel with alpha (budget 0). `expected-image-receiver`: the same shots
  against the blend-aware raster with g55b's classes.
- `receiver-state-dumps`: `receiver-patch`'s dumps equal the patch recording's resolved /5 state
  (`statesEqual`, shaders, materials, item material fields and canvas modulate included).
- `leg-class-capture-cim-inline`: `success`, inline delivery, no material-log-divergence.
  `leg-class-receiver-cim`, `-patch`, `-inline`: `success` by `classifyLeg` plus D15
  (`classifyMaterialLeg`: a material-log-divergence is `capture-failure`, a receiver `SHADER ERROR`
  is `replay-failure` / `shader-compile`). Each sabotage's `leg-class-<leg>` requires
  `pixel-mismatch` with mismatching regions per step exactly `expected.json` `predictions[<dir>]`,
  shots aligned by requested sequence (`shot-seqs.txt`).
- `receiver-typed-clean`: honest receivers record no `applied.json` `unsupported` and no `skipped*`
  counter; no receiver stdout (sabotages included) has `SHADER ERROR`, `Shader compilation failed`
  or a script error. `cim-receiver-import-exit`: the receiver import exited 0.

applied.json fields read (`render-stream-receiver-applied/5`): `status`, `end_seen`,
`transactions[].{seq, frame, record_sha256, rs_calls, resources.{shaders_created,
shader_code_sets, shader_payload_fetches, materials_created, param_sets, instance_param_sets,
skipped*}}`, `shots[].seq`, `unsupported[]`; state dumps: the whole resolved /5 `state`.

## Gate 5.5 criteria (g55e)

Every wire read decodes at version 5 explicitly. The reference oracle (`shader/reference/` and
`shader-refused/reference/` `materials.jsonl`) is what the wire must equal; the hook logs are the
tables' ground truth per frame, with D4 applied to their view (`applyPolicyToLog`: the hook writes
`source: payload` whatever the policy; the policy is applied at publication).

- `shader-material-commands`: g55d's `materialLogDivergence` on both sinks of `capture-shader`,
  `capture-refused`, `capture-policy-params` and `capture-policy-exclude`, and on
  `capture-shader-inline`.
- `shader-hash-parity`: at every settle step each live oracle shader's GRP1 hash is the hash of
  exactly one wire shader entry (with its payload size), on both sinks of `capture-shader` and
  `capture-policy-params`, on `capture-shader-inline` and `capture-policy-exclude` (withheld
  entries keep the hash) and on `capture-refused` against the refused oracle; the oracle shader ->
  wire id pairing never moves and is the creation-order one; freed shaders are off the wire.
- `param-parity`: on the same sinks, every live material's declared parameters carry the oracle's
  type and value exactly (bool as true/false, a `rid` as the fixture texture its id's GRT1 pixels
  name), nil ones are absent, no undeclared one; instance parameters likewise, except one the
  script never set (absent on the wire, the oracle's `Vector4` default exempt).
- `shader-policy-respected`: under `params` and `exclude`, the declared policy, every fixture
  shader `withheld` with its hash (`ok` / `unsupported` `shader-excluded`), no GRP1 file or
  `shader-code` index line in the store, no shader resource record, and no file the capture wrote
  (both recordings, store, `evidence/`, stdout) containing the GRP1 magic, `shader_type` or any
  library code; the same scan must find code in `capture-shader`.
- `shader-store`: g55d's evaluator on `capture-shader` and `capture-shader-inline`.
- `shader-receiver-vs-reference`: `receiver-shader`, `-patch`, `-inline` and `receiver-params-lib`
  equal `reference-shader` on every pixel of every settle shot (budget 0).
  `shader-expected-image-receiver`: every receiver against its raster; `receiver-refused` and
  `receiver-params-nolib` against `expected.json` `receiver_views` (the refused items, or every
  item, drawn with no material).
- `shader-receiver-state-dumps`: `receiver-shader-patch`'s dumps equal the patch recording's
  resolved state.
- `shader-receiver-typed`: honest receivers type and skip nothing; `receiver-refused` types exactly
  `canvas_item_set_material` / `unsupported-material` on the five refused items;
  `receiver-params-nolib` exactly one `shader_set_code` / `shader-withheld` per withheld (id, hash)
  pair it would make resident (`residentShaderVersions`) and sets no code; `receiver-params-lib`
  fetches nothing and sets that many codes; no receiver stdout has a shader or script error.
- `g55e-capture-log-clean`: no g55e capture host printed a shader compile error.
  `shader-receiver-import-exit`: the receiver import exited 0.
- `leg-class-capture-shader-inline` and `-capture-policy-params`: `success` (every shader `ok`, no
  entry, no material-log-divergence); `leg-class-capture-policy-exclude`: `unsupported`, entries
  exactly `unsupported-material` on the eight items with a ShaderMaterial, every fixture shader
  `shader-excluded`. `leg-class-receiver-*`: `success` for the honest four; `unsupported` for
  `receiver-refused` and `receiver-params-nolib` with mismatching regions exactly
  `predictions[<leg>]`. Each sabotage's `leg-class-<leg>`: `pixel-mismatch` with regions exactly
  `predictions[<leg>]`.

## Gate 5.5 criteria (g55f)

Live legs on `fixtures/gate55-shader` with gate 1's live timeline (S=300, N=60, `LAST_STEP`=9,
quit=851, identical to gate5-design.md G5f's); `reference-live` is the fixture at that same
timeline, extension absent, so `PH`'s per-frame phase lines up with a live shot's actual frame.
`live-tap-equals-received` and `live-resolves-to-recording` are gate 1's generic checks over every
leg's connection. `pins-bounded`/`obsolete-retired`/`gets-advertised` replay the host's pin/retire/
GET lines against the full recording's `okImageHashes(t) ∪ okShaderHashes(t)` (the fixture also
serves TEX16/TEX16B and the engine's hue strip over the same mechanism), `http-gets-match-fetches`
and `fetch-before-applied` are gate 2's. `shader-fetches-latest-only` requires
`live-shader-stall`'s recovery transaction to equal the host's full recording at its frame
(`statesEqual`, covering `phase` and the tint code hash in one proof) and every fetch tied to the
recovery seq to name only a hash that state actually holds. `receiver-vs-reference` requires every
leg's settle shot outside its stall window to equal `reference-live`'s exactly, a `PH`-only
difference tolerated when the wire's own state at that frame equals the host's full recording
there. `stale-coalesce` requires `sabotage-shader-stale-coalesce`'s recovery transaction to be
labelled `stale_from` and unequal to the full recording, and its post-stall shot to mismatch
exactly the regions `expected.json`'s per-step `fresh` table says `StallReport.
steps_applied_during` touches (measured: `IN`, `Marker`, `PH`, `RM`, `TI` — memory
`rs-g55f-stale-coalesce-region-set`). `warm-host-no-gets` requires zero GETs, the warm receiver's
cache hits to equal `live-shader`'s fetch count, and its shots to equal `reference-live`'s too.
`leg-class-*` requires the four legs' classes (`success`, `success`, `success`, `pixel-mismatch`).

## Gate 5.5 self-test

```bash
mise exec -- pnpm exec tsx --conditions=development experiments/render-stream/scripts/test/self-test-gate55b.ts
python3 experiments/render-stream/fixtures/gate55-cim/make_expected.py --check
mise exec -- pnpm exec tsx --conditions=development experiments/render-stream/scripts/test/self-test-gate55c.ts
python3 experiments/render-stream/fixtures/gate55-shader/make_expected.py --check
mise exec -- pnpm exec tsx --conditions=development experiments/render-stream/scripts/test/self-test-gate55d.ts
mise exec -- pnpm exec tsx --conditions=development experiments/render-stream/scripts/test/self-test-gate55e.ts
mise exec -- pnpm exec tsx --conditions=development experiments/render-stream/scripts/test/self-test-gate55f.ts
```

`self-test-gate55b.ts` checks the rasterizer's blend modes on bytes typed in by hand: `add`, `sub`
(clamped), `mul` (delta 1), `premul_alpha` and `add` at .6, `disabled` writing alpha 153 on an
8-bit target and 170 on a 2-bit one, `mix` unchanged, and alpha-0 rects that paint and cover
nothing (`mix`, `add`) or still multiply (`mul`). `cim-expected-self-consistent` passes on the
committed file and fails on a probe off by 1, a wrong `fresh`, a census cell, an off-grid colour,
overlapping regions and `RI` typed at step 4. The image checks pass on frames built from the raster
and fail on the contract's alpha 153 for `BD`'s strip, a `mul` pixel off by 2 (off by 1 passes),
an exact `add` pixel off by 1, `UC` not following its parent at 6, `LO` drawn as `normal` and a
repeat differing in one alpha byte. `material-census` passes before calibrator 8 and, on a hook log
built from `rs_material_calls`, after it (teardown frees ignored), and fails on a short
`material_set_param`, a `shader_create` logged a step late, an omitted `material_set_shader` and a
half-planned calibrator. `leg-class-capture-cim` passes on synthetic /5 recordings of both
variants (wire material ids offset from CimSim's) and fails on class `unsupported`, an
`unsupported-material` entry, `RI` still naming its freed material at 4, `UC` not inheriting at 6,
a modulated marker command and a moved `content_version`.

`self-test-gate55c.ts` runs both self-consistency checks on the committed `expected.json` and
fails them on an off-grid colour, a wrong `fresh`, overlapping regions, a freed shader coming back
and a phase off its settle frame. It runs `oracle-agrees` and `shader-code-model` on oracle lines
made from `expected.json`, then fails them on a parameter typed `int`, a colour written as a
double instead of float32, `I2`'s default typed `color`, `MR` not freed, a frame off, the repeat's
bytes differing, `tint`'s hash unchanged at step 3 and include markers on `pal`. The counter,
stdout, step-log and /5 capture checks run on synthetic values, failing on a short count, an
unexpected draw, a compile error, a missing step, class `unsupported` for `capture-shader`, a
redrawn item, a refused item not typed, a pre-/5 `unsupported-state` entry, the `TIME` shader
carried `ok` and a base item typed `unsupported-material`. The hook-log checks run on a log written out from the census itself (passing, with a
teardown free after the quit frame, for both variants and the armed reference's quit). They then
fail on a `material_set_shader` missing, a version off, `gain`'s erase not typed `nil`, an extra
material, a line off the main thread, the step-3 code change never hooked, `sh_a` never freed and
`TIME` not refused.

`self-test-gate55d.ts` synthesizes, from `expected.json`'s `rs_material_calls`, a hook log (D5
applied silently in its registry), both /5 sinks frame by frame and an `applied.json`, for both
scenes. `material-commands` passes and fails on the step-1 shader free missing from the log, a
material version, a shader hash, a parameter type and a material the log lacks (an omitted line is
ignored); `classifyMaterialLeg`'s precedence is checked. `builtin-modes` fails on `UP`'s sub shader
reading `add` at 8, `RI` still naming its freed material at 4 and `UC` not inheriting at 6;
`canvas-modulate-wire` on a white canvas in `modulate`. `material-census-wire` names the step 3, 4
and 5 events and fails on the recreation a frame late, a removal missing from `removed_materials`
and a freed shader still on the full sink. `fresh-without-redraw` fails on `UC` redrawn, its
`content_version` moving and the receiver's `UP` unchanged at 6; `resource-quiet` on a parameter
set at step 7, a material entry at step 9, a receiver without the /5 counters and a shader created
twice. The typed-clean, state-dump, sabotage-prediction (through `evaluateLegClass5`), report and
store (a temporary GRP1 store) evaluators each pass and fail.

`self-test-gate55e.ts` synthesizes /5 tables from `expected.json`'s oracle views, one transaction
per settle step. `applyPolicyToLog` withholds non-builtin code under `params`, also refuses it under
`exclude` (a D11 reason wins) and leaves a builtin alone. `shader-hash-parity` passes and fails on
tint moving to a new id at its code change, a hash on two entries, the freed `sh_a` still on the
wire and a payload size off; `param-parity` passes (I2's unset parameter exempt twice) and fails on
`MT.tint` one ulp off, `MT.gain` surviving its erase, an undeclared parameter, `MP.pal` naming
TEX16, `MY.on` still false at 7 and I2's set parameter missing. `codeBytesIn` finds code and the
GRP1 magic and nothing in a hash-only line; `shader-policy-respected` passes under both policies and
fails on a `payload` entry, a GRP1 file in the store, code in a log, a blind control and the wrong
declared policy. `shader-receiver-typed` and `residentShaderVersions` pass and fail. Last, each
receiver view's raster differs from the reference raster in exactly its predicted regions and
steps, and the freeze prediction holds the marker at {1..9}.

`self-test-gate55f.ts` (G5f, gate5-design.md's structural template, had none) drives
`lib/gate55f-checks.ts`'s pure evaluators on fabricated evidence, never a real run: `g55fWindows`
against the ten hand-computed `[from, to]` windows; `stepShots55f` (first shot per step wins,
invalid entries skipped); `wireStateEqualsFullAtFrame` (equal states, differing states, no
transaction at that frame, no frame given); `mismatchingRegionNames`. `checkShaderFetchesLatestOnly`
passes when the recovery transaction equals a fabricated "newest" state and its own fetch names
that state's hash, and fails on a stale recovery and on a fetch (at the recovery seq) naming a
hash the newest state does not hold -- an unrelated earlier fetch (a fresh cache's other five
shaders) must not trip it. `checkStaleCoalesce` passes when a checkpoint's mismatching regions
equal a hand-built `fresh` table's union over `steps_applied_during`, and fails on a narrower
region set, a benign mismatch, `state_equals_full: true` and a missing `stale_from`.
`checkReceiverVsReferenceShader` passes on exact and benign (`PH`-only) checkpoints and fails on a
real mismatch, while confirming the sabotage leg's own post-stall step and a window wholly inside
the stall are both excluded. `checkWarmHostNoGetsShader` passes on zero GETs with matching
cache-hit/fetch counts and fails on any GET, any receiver fetch, a cache-hit mismatch or a
non-warm cache mode.

# Gate 6

Gate 6's increments are tracked in [../protocol/gate6-design.md](../protocol/gate6-design.md)
"Increments". Each lands its own subsection here as it completes.

## Gate 6 files (g6t)

G6t ([../protocol/gate6-design.md](../protocol/gate6-design.md) "G6t") is the measurement/report
tooling: new files only, no engine or capture change, no gate legs of its own.

- `lib/render-stream-report.ts`: the `render-stream-report/1` types (D10, Q7f), `validate()`
  (schema plus internal-consistency checks, collecting every problem rather than stopping at the
  first) and `aggregate()` (the scenario-level `aggregate` block, recomputed from exactly five
  repeats; both `report-gate6.ts build` and `validate()` call it, so a report this module builds
  always round-trips).
- `lib/provenance.ts`: host facts (`/proc/cpuinfo`, `os`), the gamescope version string and
  `sha256File`, all best-effort and engine-free.
- `lib/proc-sampler.ts`: 1 Hz `/proc/<pid>/status` (VmRSS, VmHWM, Threads) and
  `/proc/<pid>/task/*/stat` (per-thread utime/stime, USER_HZ assumed 100) for a process this
  runner already owns (D9: engine memory counters are unavailable in release templates, so
  residency is measured from `/proc` instead).
- `throttle-proxy.ts` (D12): a loopback TCP proxy (`node:net` only) between a receiver and the
  host's single listener, with a token bucket (rate + burst) and a fixed one-way delay per
  direction. Profile `constrained`: 500 000 B/s, 64 KiB burst, 30 ms delay. Importable
  (`startThrottleProxy`) or a standalone CLI; prints `{"listening_port":<port>}` once bound and
  writes a `render-stream-throttle-proxy-stats/1` document (bytes and latency per direction) on
  `--duration-s`, SIGINT or SIGTERM.
- `analyze-deltas.ts` (D15): reads a `resources.jsonl` hook log and computes, per resource kind,
  hash-at-publish savings (version bumps superseded within the same engine frame) and mesh
  region-update deltas (`mesh_surface_update_region`'s own `bytes`, exact). Deliberately reports
  `whole_version_bytes_available: false` rather than estimating a mesh's whole-buffer byte size,
  which the hook log never logs (memory: g6t-report-tooling-facts). Texture updates have no
  partial-update path in this hook log, so their delta always equals the whole.
- `report-gate6.ts`: `validate <report.json>` and `build <run-set dir> --out <file> [--deltas
  <resources.jsonl>]`. `build`'s run-set directory layout is this file's own convention (documented
  in its header): `run.json`, `provenance.json`, and per scenario
  `scenarios/<id>/{meta.json,warmup/repeat.json,repeat-1..5/repeat.json}`. Refuses to write a
  report that fails `validate()`. `pnpm render-stream:report -- validate|build …` forwards a
  literal `--` into this script's own argv (memory: pnpm-script-dashdash-forwarding), handled in
  `main()`.
- `test/self-test-report.ts`: see below.
- `package.json` `render-stream:report`.

## Gate 6 self-test (g6t)

```bash
mise exec -- pnpm exec tsx --conditions=development experiments/render-stream/scripts/test/self-test-report.ts
```

40 assertions: a fabricated `render-stream-report/1` validates clean, then one perturbation per
`validate()` rule each fails with its expected code (`bad-schema`, `run-entry`, `repeat-count`,
`scenario-entry`, `rate-entry` ×2, `dist-entry`, `memory-entry`, `aggregate-mismatch`,
`optimizations-entry`); `aggregate()` against five hand-picked values (median/min/max/cov) and a
metric dropped entirely when any one repeat reports it unavailable; the throttle proxy measured
against two real loopback TCP servers -- a saturating echo stream stays within 5% of the configured
rate, and discrete low-rate messages stay within 2ms of the configured delay, both read from the
proxy's own `stats.json` (memory: g6t-report-tooling-facts explains why rate and delay need
separate scenarios); the `/proc` sampler against a real spawned child process (positive VmRSS, at
least one thread, thread CPU time increasing after it does work); `provenance.ts`'s host probe and
`sha256File` against a real temp file; `analyze-deltas.ts` against fabricated hook-log lines
(hash-at-publish supersession, mesh region-update deltas, texture whole-equals-delta, parameter
bytes per frame, and a malformed line skipped during parsing); and a `report-gate6.ts build()` +
`validate()` round trip through a fabricated run-set directory.

## Gate 6 files (g6a)

G6a ([../protocol/gate6-design.md](../protocol/gate6-design.md) "G6a") runs the combined scene
`fixtures/gate6-scene` through its file legs (render-stream/5 when it landed, /6 since G6b):

```bash
mise exec -- pnpm render-stream:gate6 -- \
  --extension "$PWD/experiments/render-stream/capture/build/render_stream_capture.gdextension" \
  --calibration "$PWD/experiments/render-stream/calibration/godot-4.5.1-stable-linux-release.json" \
  [--binary /abs/path] [--out /abs/dir] [--legs g6a]
```

- `run-gate6.sh`: the orchestrator (gate 5.5's shape: `lib/legs.sh`, one private gamescope per
  group at 640×360, every capture with `GRC_ROOT_SIZE=enforce-min-size`). `--out` defaults to
  `artifacts/render-stream/gate6/<UTC>/`. Landed groups: `g6a`; the other gate 6 groups are known
  names and refused until their increment lands.
- `check-gate6.ts`: writes `<out>/result.json` (`render-stream-gate6-report/1`: gate 5.5's shape
  plus `mismatch_tables` per receiver leg, `census`, and the `rates` and `stability` blocks later
  increments fill) and exits non-zero unless every check passed.
- `lib/gate6-expected.ts`: `expected.json`'s types, the per-shot raster (`rasterOfShot`), the
  refused variant's view and the per-pixel region map.
- `lib/gate6a-checks.ts`: every g6a criterion, pure over values read from the evidence, and
  `runGate6a`.
- `lib/geometry-raster.ts` gains `UndecidedShape` (`kind: "undecided"`): a box whose pixels the hand
  model leaves undecided (text, the RichTextLabel, RF); a later opaque paint decides them again.
- `receiver/` gains `RS_RECEIVER_SABOTAGE=stale-texture` (a resident RGBA8 image keeps its first
  payload; LA8 atlas pages still update), the receiver half of Q6h's `stale-texture` leg.
- `test/self-test-gate6.ts`: see below.

## Gate 6 legs and evidence under `--out` (g6a)

| Leg                       | Directory                         | Runs |
| ------------------------- | --------------------------------- | ---- |
| `import`                  | `scene/import/{fixture,receiver}/` | the mise editor's `--import` of `fixtures/gate6-scene` and `receiver/` |
| `capture-scene`           | `scene/capture/`                  | the release template, `--headless`, armed, both sinks, the store, quit 400, strace + maps/fd |
| `capture-scene-inline`    | `scene/capture-inline/`           | the same with no store and both payload thresholds at 16 MiB |
| `capture-animate`, `capture-refused` | `animate/capture/`, `refused/capture/` | `RS_FIXTURE_VARIANT=animate` / `refused`, quit 400 |
| `reference-scene`, `-repeat` | `scene/reference{,-repeat}/`   | rendered in gamescope, extension absent, oracle on: `shots/step-0..11.png`, `shots/frame-{13,53,93}.png`, `steps.jsonl`, `oracle.jsonl` |
| `reference-scene-armed`   | `scene/reference-armed/`          | rendered, extension armed with a full-sink stream and a store, oracle off |
| `reference-animate`, `reference-refused` | `animate/reference/`, `refused/reference/` | rendered, the variant, oracle on |
| `receiver-scene`, `-patch`, `-inline` | `scene/receiver{,-patch,-inline}/` | rendered receivers on the full sink, the patch sink (state dumps at the settle seqs) and `capture-inline`: `shots/seq-<n>.png` at the settle seqs and the seqs of frames 13, 53, 93 |
| `receiver-animate`, `receiver-refused` | `animate/receiver/`, `refused/receiver/` | rendered receivers on the variant captures |
| `sabotage-freeze`, `-omit-transform`, `-perturb-vertex`, `-perturb-shader` | `scene/sabotage-*/{capture,receiver}/` | 122-frame captures with `freeze-frame` @11, `omit-op canvas_item_set_transform` @21, `perturb-vertex` @21, `perturb-shader` @21, each with a rendered receiver |
| `sabotage-receiver-ignore-clip`, `-stale-texture` | `scene/sabotage-receiver-*/` | `RS_RECEIVER_SABOTAGE` on `scene/capture/` |

## Gate 6 criteria (g6a)

`expected-self-consistent` re-derives in TypeScript what `make_expected.py` asserts, for both
variants (regions disjoint at every shot, the colour and texel grid with the theme boxes exempt,
only BG's panel, the clear colour or band outside the regions, nothing but `TL` in the bottom
strip before step 10, `fresh` against the raster and the undecided content, SM's phase and PB's
value against D6's formulas). The capture checks are gate 3's (`headless-no-gpu`,
`recordings-decode`, `patch-resolves-to-full`) plus `step-log` on every capture and reference and
one `leg-class-capture-*` per capture: `unsupported` with exactly the `/5` reasons expected.json
lists (`viewport_attach_canvas`/`extra-canvas`; the refused variant adds `canvas-light`, two
`unsupported-op` commands and `unsupported-material`). `draw-index-tie` requires no tie anywhere and
Scene and TL at distinct draw indices from frame 1 (Q6b's predicted tie does not happen, As built).
`expected-image-reference` compares every reference shot (settle and intermediate,
`reference-scene` and `reference-refused`) with the model on every decided pixel;
`presence-reference` requires every modelled shape present; `freshness-reference` requires the
reference's region changes to equal `fresh` and checks on the wire that SC's steps 1 and 5 are a
content transform, that TR changes through TEXA's version with identical commands and that TL never
changes before step 10. `reference-repeat-budget` and `armed-transparent` compare legs pixel for
pixel. `scroll-parity` compares the oracle's scroll, content position and RichTextLabel layout with
the model and the wire's content transform with the floored offset; `atlas-parity` the oracle's
atlas pages with the capture's settle textures (both ways); `param-parity` SM's and CM's material
state on both sinks with the model; `line-edit-geometry` the capture's LineEdit selection and caret
rects with the oracle's; `scene-census` the hook log with the census (textures by predicted hash,
MS's per-frame region updates, SM's parameter writes, CM's builtin shaders, the canvas counters and
the HUD's hidden frames; and the `animate` capture's TEXA versions). Each receiver leg's
`leg-class-*` requires `unsupported` with exactly the capture's reasons (also in `applied.json`) and
the pixel verdict outside `HU` (and `RF`): honest receivers `success`, sabotages `pixel-mismatch` at
exactly `predictions[leg]`'s regions per shot (`perturb-shader`: `success`).
`receiver-vs-reference` collects the honest receivers' comparison (budget 0).

## Gate 6 self-test (g6a)

```bash
mise exec -- pnpm exec tsx --conditions=development experiments/render-stream/scripts/test/self-test-gate6.ts
```

39 assertions: both variants of the committed `expected.json` pass `expected-self-consistent`, and
broken copies (an off-grid colour, a wrong `fresh`, overlapping regions, a phase off D6's formula)
fail; the undecided box marks its pixels undecided, an opaque rect decides them again and a
translucent one does not; frame diffs ignore HU, and the pixel verdict passes the predicted
sabotage regions but fails an extra, a missing or an unpredicted region, an honest leg that differs
and a missing shot; oracle lines made from `expected.json` pass and fail with a scroll, a tint, an
RT line offset or the repeat's bytes off; atlas parity and the LineEdit's rects pass and fail on
synthetic wire states; a hook log synthesized from the census passes and fails with TEXA's update
missing, TEXB's hash off, an extra mesh call or the HUD hidden one frame too long; and the
unsupported class and the frame-1 tie each pass and fail.

## Gate 6 files (g6h)

G6h ([../protocol/gate6-design.md](../protocol/gate6-design.md) "G6h") runs the 1920×1080
`canvas_items` fixture `fixtures/gate6-hd` (nine copies of the combined scene in a 3×3 grid) at
both presentations (render-stream/5 when it landed, /6 since G6b): `--legs g6h` (and `g6a,g6h` for the
increment's pass).

- `lib/gate6h-legs.sh`: `run_g6h`, sourced by `run-gate6.sh` (kept apart so concurrent groups
  merge trivially). One private gamescope at 1920×1080 for the native legs, one at 960×540 for the
  half references; every rendered leg passes `--resolution` explicitly.
- `lib/gate6h-checks.ts`: expected.json's types (`render-stream-gate6-hd-expected/1`), the
  presentation transform (`hdItems`: scale(0.5) composed onto every item transform and scissor,
  `ops_half` where the half lowering differs), the per-pixel region index, every g6h criterion, and
  `runGate6h`, which walks the shots one at a time (a 1920×1080 raster and seven frames per shot).
- `check-gate6.ts` runs `runGate6h` when `g6h` ran; the report's `legs` take G6h entries, its
  `budgets` the per-region-family `hd-reference-repeat-{native,half}` and `hd-reference-armed-native`
  tables, and `census["capture-hd-native"]` the HD costs (bytes per transaction on both sinks, the
  items, commands and atlas pages at the last settle frame).
- `test/self-test-gate6h.ts`: see "Gate 6 self-test (g6h)".

## Gate 6 legs and evidence under `--out` (g6h)

| Leg | Directory | Runs |
| --- | --- | --- |
| `import` | `hd/import/{fixture,receiver}/` | the mise editor's `--import` of `fixtures/gate6-hd` and `receiver/` |
| `capture-hd-native` | `hd/capture-native/` | the release template, `--headless`, armed, both sinks, the store, `GRC_ROOT_SIZE=enforce-min-size` (the headless root becomes the logical 1920×1080: stretch identity), the 122-frame file timeline |
| `reference-hd-native`, `-repeat` | `hd/reference-native{,-repeat}/` | rendered in the 1920×1080 gamescope, `--resolution 1920x1080`, oracle on: `shots/step-0..11.png`, `shots/frame-{13,53,93}.png`, `steps.jsonl`, `oracle.jsonl` |
| `reference-hd-native-armed` | `hd/reference-native-armed/` | the same, extension armed with a full-sink stream and a store, oracle off |
| `receiver-hd-native`, `-patch` | `hd/receiver-native{,-patch}/` | rendered 1920×1080 receivers on `capture-native`'s full and patch sinks (patch: state dumps at the settle seqs), shooting the settle seqs and the seqs of frames 13, 53, 93 |
| `reference-hd-half`, `-repeat` | `hd/reference-half{,-repeat}/` | rendered in the 960×540 gamescope, `--resolution 960x540` (stretch 0.5, oversampling 0.5), oracle on |

## Gate 6 criteria (g6h)

On the capture: `leg-class-capture-hd-native` (`unsupported` with exactly
`viewport_attach_canvas`/`extra-canvas`: the nine HUD layers before G6b), `hd-session` (logical
1920×1080, `canvas_items`/`keep`, `enforce-min-size` with the host window at 1920×1080 and status
`match`, the host's final transform the identity), `hd-recordings` (both sinks decode with 122
transactions; the patch sink resolves to the full one), `hd-draw-index-tie` (no tie; Grid and the
nine top-level TLs at distinct draw indices from frame 1) and `hd-step-log` (the capture's and every
reference's). On the oracle: `hd-grid-layout` (the grid at (0,0) 1920×1080 and each Cell at its
3×3 origin, 640×360, at both presentations), `hd-oversampling-reference` (1.0, 1920×1080 and stretch
1 at native; 0.5, 960×540 and 0.5 at half; the step's canvas transform), `hd-cell-oracle` (every
cell's scroll, HUD layer, PB, SM, CM, RichTextLabel and LineEdit focus against the model at the
cell's phase; repeat oracles byte-identical) and `hd-atlas-parity` (native: the reference's atlas
pages are exactly the capture's LA8 textures at every settle step, both sinks). On the references:
`hd-expected-self-consistent` (the static rules, then each presentation's raster: only BG panels,
the clear colour or band outside the regions, clear bottom strips, `fresh` as the rasters say),
`hd-expected-image-reference-{native,half}` (every decided pixel of every cell of every shot equals
the model), `hd-presence-reference`, `hd-freshness-reference` (both presentations),
`hd-reference-repeat-budget-{native,half}` and `hd-armed-transparent` (pixel for pixel). On the
receivers: `leg-class-receiver-hd-native{,-patch}` (`unsupported` with the capture's reasons, also
in `applied.json`, every seq applied, every pixel outside the nine `HU` regions equal to the
reference) and `hd-receiver-vs-reference` (budget 0; inside each `HU` exactly the HUD panel's pixels
differ while that cell's HUD shows above the root canvas).

## Gate 6 self-test (g6h)

`test/self-test-gate6.ts` runs `test/self-test-gate6h.ts` on the committed
`fixtures/gate6-hd/expected.json` (27 of its 66 assertions): the static rules pass, and overlapping
regions, an odd region edge, an SM phase off D6, focus on two cells and a shared HUD layer each
fail; the half presentation draws `ops_half` under scale(0.5); the half rasters of steps 0 and 1
keep BG clean and agree with `fresh` (a painted strip pixel and a flipped flag fail); synthetic
frames with each cell's HUD panel differing pass the HU rule, a missing panel fails and a
difference outside HU is a mismatch; oracle lines made from the model pass the grid, oversampling
and cell checks, and a moved cell, the half oracle at oversampling 1, an off PB value and differing
repeat bytes fail; the HD session passes at the logical window and fails at 64×64; Grid and nine
TLs pass at distinct draw indices and fail tied.

## Gate 6 files (g6l)

G6l ([../protocol/gate6-design.md](../protocol/gate6-design.md) "G6l", Q7c) runs live motion, the
2-s stall, reconnect and the warm cache on `fixtures/gate6-scene`'s `animate` variant with the live
timeline (S=300, N=60, quit 1080) and `steps` time (render-stream/5 when it landed, /6 since G6b;
`--legs g6l`).

- `run-gate6.sh` `run_g6l`: one private gamescope at 640×360; `start_live_scene_host`,
  `g6l_receiver`, `g6l_leg` (gate 5.5f's live-leg pattern), `g6l_windows` (12 settle windows, then
  40 motion windows of 10 frames from frame 320 at a spacing of 18.5, labels 100..139) and
  `g6l_shot_frames` (a stdlib `python3` heredoc listing every frame a receiver shot and every
  `stale_from` frame those shots carried, for `reference-live-frames`).
- `lib/gate6l-checks.ts`: every g6l criterion, pure over values read from the evidence, and
  `runGate6l`. It reuses gate 1's `stallReport`, `deliveryReport` and `connectionSummary`, gate 2's
  `loadHost`, `pinsReport`, `unadvertisedGets`, `getsVsFetches` and `fetchesAfterApplied` (hashes
  unioned over textures, mesh surfaces and shaders) and gate 5f's `connTimelinesAtCallback`. Each
  leg is digested and its decoded recordings released before the next loads.
- `check-gate6.ts` adds `live` to the report: per g6l leg, credit RTT, staleness p50, fetch
  latency, applied transactions and shots, the stall's and the reconnect's timing.
- `receiver/` gains `RS_RECEIVER_RECONNECT_MEMORY=drop|keep` (default `drop`, G2c2's rule). `keep`
  keeps the verified memory map across `RS_RECEIVER_RECONNECT`. `live.reconnect` gains `memory`,
  `memory_hashes` and `cache_hashes`.
- `test/self-test-gate6l.ts`: the g6l cases, run from `self-test-gate6.ts`.

## Gate 6 legs and evidence under `--out` (g6l)

| Leg | Directory | Runs |
| --- | --- | --- |
| `import` | `live/import/{fixture,receiver}/` | the editor's `--import` of both projects |
| `live-scene` | `live/live-scene/{host,receiver}/` | host: release template, `--headless --max-fps 60`, armed, both sinks, store, tap, `RS_FIXTURE_VARIANT=animate RS_FIXTURE_TIMELINE=live`; receiver: rendered live, `--max-fps 60`, fresh cache, the 52 windows |
| `live-scene-warm` | `live/live-scene-warm/` | a new host and receiver on `live-scene/receiver/cache`, `RS_RECEIVER_CACHE_MODE=warm` |
| `live-stall` | `live/live-stall/` | `RS_RECEIVER_STALL=2:2000` |
| `live-reconnect` | `live/live-reconnect/` | `RS_RECEIVER_RECONNECT=5 RS_RECEIVER_RECONNECT_MEMORY=keep` (connection 2: `received-2.rs2`, `shots/stream-2-seq-<n>.png`) |
| `sabotage-live-stale-coalesce` | `live/sabotage-live-stale-coalesce/` | the stall, host `GRC_SABOTAGE=stale-coalesce GRC_SABOTAGE_FRAME=420` |
| `reference-live-frames` | `live/reference-live-frames/` | rendered reference, animate, live timeline, `RS_FIXTURE_SHOT_FRAMES` = every shot frame and `stale_from` frame: `shots/frame-<f>.png` (and `step-<k>.png`) |
| `reference-file` | `live/reference-file/` | rendered reference, animate, file timeline: `shots/step-<k>.png` |

## Gate 6 criteria (g6l)

`live-step-log` (every host and `reference-live-frames` log steps 0..11 on the live timeline);
`live-tap-equals-received` (connection 1 of the reconnect is a prefix of the tap);
`live-resolves-to-recording` (every tapped transaction equals the full recording at its frame, the
sabotage's rewritten sends at their `stale_from`); `live-motion` (every shot equals the reference's
shot of its wire frame, whole frame outside HU, budget 0; on honest legs the wire frame is the send
frame); `motion-monotonic` (frames strictly increase; the host sends at the first callback after
every credit; a gap above 2 must follow the stalled seq, the reconnect, or a receiver hold longer
than one frame from receipt to `submitted`); `live-steps` (each settle-window shot equals the file
reference's step shot in NP, Marker, BT, LE, CM, HB and TL); `pending-bounded`; `stall-latest`;
`fetch-latest-only` (of TEXA's in-stall versions from the hook log, exactly the one current at the
recovery frame is fetched, for the recovery seq); `stall-recovery`; `reconnect` (new `stream_id`,
seq 1 full, RIDs disposed with none left, memory kept, no fetch of anything held, zero cache-
directory hits on connection 2, its shots equal the reference); `warm-fetch` (no cold-cached or
static payload is fetched); gate 2's `pins-bounded`, `obsolete-retired`, `http-gets-match-fetches`,
`gets-advertised` and `fetch-before-applied` on the honest legs; and `leg-class-*` per leg:
`unsupported` with exactly `extra-canvas` on /5. Honest legs must have pixels `success`. The
sabotage must have pixels `pixel-mismatch` only at stale sends, and its recovery shot must equal
the reference at `stale_from` and differ from its own frame in MS, SM, AN and every region the
fresh table marks at the swallowed steps.

## Gate 6 self-test (g6l)

`self-test-gate6.ts` section 9 runs `test/self-test-gate6l.ts`: 34 assertions over the windows,
the live step and region lookup, motion attribution (each cause passes and a fast-receiver gap
fails), the host's credit-to-send, missed-window candidates, `fetch-latest-only`, the reconnect and
warm fetch rules, the stale region set, the wire frame of a stale send, HU exclusion and the close
frame rule, each with a failing case. Since G6b HU is compared (the HUD layer travels on /6), and
the HU case asserts that a difference inside HU counts.

## Gate 6 files (g6b)

G6b ([../protocol/gate6-design.md](../protocol/gate6-design.md) "G6b") switches the capture, the
receiver and every gate runner to render-stream/6 and adds group `g6b`: `--legs g6a,g6h,g6l,g6b`
(g6b needs g6a's scene capture and g6h's half reference in the same run; `run-gate6.sh` refuses it
alone and runs it last whatever order `--legs` names).

- `lib/gate6b-legs.sh`: `run_g6b`, sourced by `run-gate6.sh`. Headless captures of
  `fixtures/gate6-hd` at `GRC_ROOT_SIZE=presentation:960x540` (both sinks and, separately, all
  inline) and at `enforce-min-size` (the hazard), a scratch copy of `fixtures/gate6-scene` with an
  `override.cfg` setting `rendering/2d/snap/snap_2d_transforms_to_pixel=true` (imported, then
  captured), one private gamescope at 960×540 for the half receivers, the hazard and
  `ignore-presentation`, and one at 640×360 for `ignore-canvas-stacking`.
- `lib/gate6b-checks.ts`: every g6b criterion, pure over values read from the evidence, and
  `runGate6b`, which walks the HD shots once at 960×540 for all five half legs.
- `check-gate6.ts` runs `runGate6b` when `g6b` ran; the report gains `hazard` (the hazard's
  differing pixel-shots per region).
- G6b also changed g6a, g6h and g6l's checks for /6: the default scene and the HD fixture classify
  `success` (`wantedClass`), sabotage receivers `pixel-mismatch`, the refused variant `unsupported`
  with `canvas-follow-viewport` in place of `extra-canvas`, and every receiver comparison covers HU.
- `test/self-test-gate6b.ts`: see "Gate 6 self-test (g6b)".

## Gate 6 legs and evidence under `--out` (g6b)

| Leg | Directory | Runs |
| --- | --- | --- |
| `capture-hd-half` | `hd/capture-half/` | the release template, `--headless`, armed, both sinks, the store, `GRC_ROOT_SIZE=presentation:960x540` (root window 960×540: stretch 0.5, oversampling 0.5), 122 frames |
| `capture-hd-half-inline` | `hd/capture-half-inline/` | the same, every payload inline, no store |
| `capture-hd-half-at-logical` | `hd/capture-half-at-logical/` | the hazard's capture: `enforce-min-size` (window 1920×1080, oversampling 1) |
| `capture-snap` | `snap/{project,import,capture}/` | a scratch copy of gate6-scene with snap-to-pixel transforms on, imported, captured headless (122 frames) |
| `receiver-hd-half`, `-patch`, `-inline` | `hd/receiver-half{,-patch,-inline}/` | rendered 960×540 receivers (`--resolution 960x540`) on `capture-half`'s full and patch sinks (patch: state dumps) and `capture-half-inline` |
| `receiver-hd-half-at-logical` | `hd/receiver-half-at-logical/` | the hazard: a 960×540 receiver on `capture-half-at-logical` |
| `sabotage-receiver-ignore-presentation` | `hd/sabotage-receiver-ignore-presentation/` | `RS_RECEIVER_SABOTAGE=ignore-presentation`, 960×540, on `capture-half` |
| `sabotage-receiver-ignore-canvas-stacking` | `scene/sabotage-receiver-ignore-canvas-stacking/` | `RS_RECEIVER_SABOTAGE=ignore-canvas-stacking`, 640×360, on g6a's `scene/capture` |

## Gate 6 criteria (g6b)

`leg-class-capture-hd-half{,-inline,-at-logical}` (`success`: nothing typed) and
`leg-class-capture-snap` (`unsupported` with exactly
`viewport_set_snap_2d_transforms_to_pixel`/`snap-2d`). `presentation-declared`: every /6 capture's
session (policy, `presentation_size`, window, status `match`, `font_oversampling`, `snap_2d`, the
logical `host_visible_rect`, `host_final_xform` scale 0.5 at half and the identity elsewhere, a
file sink's `publication` every-frame/null). `snap-typed`: exactly one session-level `snap-2d` entry
in every transaction of both sinks. `canvas-commands`: on both sinks of `capture-scene` and
`capture-hd-half`, every layer canvas's wire layer, sublayer and attachment equal the hook log's last
calibrator-9 stacking/removal line at each frame (each canvas joined to its RID by its first
stacking line), the root canvas stays attached at (0,0), no `canvas-stacking-tie` occurs and every
layer is first published on its own key (the stacking lands in the attach frame).
`canvas-stacking-parity`: at every settle step the wire's layers equal the oracle's `(layer,
get_index())` (the scene's HUD; the nine HD HUDs at half). `atlas-parity-half`: the half oracle's
pages at the oversampled sizes equal `capture-hd-half`'s LA8 textures both ways on both sinks; its
pages at the logical sizes are shaping-only and on no wire texture. `stylebox-aa-scale`: every
antialiased StyleBoxFlat's triangle arrays at every settle step equal gate 5g's port at
`aa_size / 0.5` (half) and `aa_size` (native): indices exact, points within 2 ulp, colours exact.
`leg-class-receiver-hd-half{,-patch,-inline}` and `receiver-vs-reference-half`: `success`, the
stretch adopted, presentation and oversampling checks ok, every pixel of every shot equal to
`reference-hd-half`. `presentation-hazard-measured`: the hazard receiver classifies `unsupported`,
typed `presentation-mismatch` and `oversampling-mismatch`; against `reference-hd-half` every flat
region is equal and the text-only and antialiased-only regions each differ (counts reported).
`leg-class-sabotage-receiver-ignore-presentation`: every region of every cell and BG differs at
every shot, typed `oversampling-mismatch`. `leg-class-sabotage-receiver-ignore-canvas-stacking`:
`pixel-mismatch` at exactly `predictions["sabotage-receiver-ignore-canvas-stacking"]` with no
stacking call made. `receiver-typed-clean`: every honest rendered receiver of g6a, g6h and g6b writes
`render-stream-receiver-applied/6` with `presentation_check` ok, `stretch_applied` exactly for
`canvas_items` sessions and no receiver-typed entry.

## Gate 6 self-test (g6b)

`self-test-gate6.ts` section 11 runs `test/self-test-gate6b.ts` on synthetic sessions, hook-log
lines, wire states and `applied.json`, and on the committed `fixtures/gate6-hd/expected.json`: a
half session passes `presentation-declared` and oversampling 1, a degenerate status, a rate
publication and an identity final transform each fail; `snap-2d` in every transaction passes and a
missing one fails; a HUD stacked in its attach frame passes `canvas-commands` and a lagging layer, a
first publication at (0,0) and a tie each fail; wire stacking against oracle HUDs passes and fails;
the model's half triangle arrays for c0.BT pass against themselves, a point 2 ulp off passes using
the allowance, 3 ulp, a missing array and the native lowering fail; a clean applied.json passes and a
typed `presentation-mismatch` or an unadopted stretch fails; the hazard kinds (TR flat, RT text, HB
antialiased, BT both) and a flat region that differs fails.

## Gate 6 files (g6s)

G6s ([../protocol/gate6-design.md](../protocol/gate6-design.md) "G6s", Q5 "Resource budgets", Q7e
"Stability (g6s)") runs a 300-s-measured (370-s total) soak on `fixtures/gate6-scene`'s `animate`
variant, the `soak` timeline, `realtime` time and `GRC_HOOK_LOG=off`, on render-stream/5
(`--legs g6s`).

- `receiver/rs_resource_cache.gd`: `memory_budget_bytes`/`cache_budget_bytes` (defaults 268435456 /
  0 -- unlimited, so every other gate's behaviour is unchanged), `no_evict`, `set_needed()` (the
  current transaction's needed-hash set, gate2-design.md Q5), a shared LRU counter for both layers
  (a warm cache's existing files seed it from mtime), `_evict_memory_over_budget`/
  `_evict_disk_over_budget` and the `evictions_memory`/`evictions_disk`/`refetch_after_evict`
  counters. `memory_entries()`/`memory_bytes()` are new read accessors.
- `receiver/receiver.gd`: `RS_RECEIVER_MEMORY_BUDGET_BYTES`/`_CACHE_BUDGET_BYTES` parsing,
  `no-evict` added to `SABOTAGES`, `_obtain_needed` calls `set_needed()` before its fetch loop, a
  live shot's dict gains `frame` (RS_RECEIVER_LOG=summary drops the transaction array a realtime
  checker would otherwise use to find it), `_summary` gains the three eviction counters
  (unconditionally: memory eviction needs no cache directory), and `_process` passes the memory
  cache's entries/bytes and `RsApplier`'s `resident_items()`/`resident_textures()`/`_meshes()`/
  `_shaders()`/`_materials()` (all four of the last pre-existing) into `rs_perf.gd`.
- `receiver/rs_perf.gd`: `sample_timeline()` gains `cache_entries_memory`/`cache_bytes_memory` and
  `live_rids`, filling in fields G6r declared `unavailable`.
- `receiver/rs_applier.gd`: one new one-line accessor, `resident_items()`, beside the pre-existing
  `resident_textures()`/`_meshes()`/`_shaders()`/`_materials()`.
- `receiver/tests/applier2_selftest.gd`: `_test_cache_budgets()` (LRU eviction at both layers,
  `set_needed()` protection, `no-evict`, `refetch_after_evict`, a warm cache's mtime seeding), run
  from `_initialize()`. (G7gd removed this self-test with the GDScript applier.)
- `capture/src/rs2_snapshot.h`, `rs_publish.cpp`: a new `SabotageKind::RetainSuperseded`
  (`retain-superseded`), the usual mechanical plumbing (parse table, `to_wire`).
- `capture/src/rs_resource_store.{h,cpp}`: `ServedResources::set_retain_superseded_frame()`; from
  that frame on, `retire()` retires nothing at all, so the host's retained set and bytes grow for
  as long as content keeps changing.
- `capture/src/rs_live.cpp`, `rs_live.h`: `ConnectionSummary` gains `carried_size` (current, not a
  lifetime total), filled by `Hub::summaries()`. `carried` itself is unchanged -- never pruned.
  An earlier draft pruned it to the connection's current base and re-sent a hash that returned,
  which broke the first real `soak-inline` run with `resource-duplicate` (render-stream-2.md:
  "each hash at most once" per stream; MS's mesh surface recurs every 90 frames under its
  sine-wave motion). `carried` necessarily holds one entry per distinct hash ever sent, for the
  connection's whole life; `checkCarriedGrowthBounded` checks the rate instead (below).
- `capture/src/entry.cpp`: the `RetainSuperseded` dispatch (needs `GRC_LIVE_LISTEN`, like `unpin`/
  `drop-resource`); `perf_timeline_tick()` gains `mirror_items`/`_textures`/`_meshes`/`_materials`
  (`rs::mirror_stats()`, pre-existing), `host_retained`/`_bytes` (`ServedResources::retained()`/
  `retained_bytes()`, pre-existing) and each connection's `carried_size` -- the only host-side time
  series available for a 300-s-plus leg, since the hook log is off.
- `scripts/sample-proc.ts`: a CLI wrapping `lib/proc-sampler.ts` for a long-running background
  process, appending one `ProcSample` JSON line per tick so a hard `kill`/`kill -9` (the runner's
  own cleanup convention) never loses collected data. Sampled on the host pid only (easy: it is
  already backgrounded via `start_headless_bg` before the receiver's blocking `run_rendered`); the
  receiver's RSS/video-mem comes from its own `RS_RECEIVER_PERF_OUT` timeline instead, a documented
  simplification (self-test-gate6s.ts case 4 covers the fallback).
- `run-gate6.sh` `run_g6s`: one private gamescope at 640×360; `reference-step11` (a rendered
  `animate` reference on the SOAK timeline itself at the SAME `--max-fps 60` as every host and
  receiver here, not the file timeline and not uncapped: step 11's freeze stops every continuous
  update -- MS, SM, AN, and animate's SC/LB/CD/TEXA -- wherever it happened to be on the frame
  before the freeze fired, and that frame depends on both the timeline and the achieved frame
  rate, so this reference also takes ~370 s); `start_soak_scene_host`,
  `g6s_receiver`, `g6s_leg` (the live-leg pattern, plus starting/stopping `sample-proc.ts` on the
  host pid around the receiver call); `g6s_windows` (11 early/mid windows spread 1000..19499 for
  motion sampling, unrelated to step 11, plus a 12th window placed at 21910..22190, strictly after
  step 11's nominal trigger frame of 21900 = 60 fps × 365 s. Realtime pacing means the real trigger
  frame is unknown in advance, but the `--max-fps 60` cap means the achieved rate is never above
  60, so a slower run only reaches fewer frames in the same 365 s of real time -- the real trigger
  can therefore only be ≤ 21900, never above it, so this window always lands after the freeze. The
  uniform 12-window scheme this replaced could instead pick its "first transaction in the window"
  from before the real trigger: measured, a 546-frame-early shot (frame 21350 against a real
  trigger at 21896), 15 347 mismatched pixels in exactly the continuous-formula regions step 11
  freezes -- SC, PB, SM, MS, AN, LB); generous 420-s `HEADLESS_TIMEOUT_S`/`RENDERED_TIMEOUT_S`,
  restored after the group.
- `lib/gate6s-checks.ts`: every g6s criterion, pure over values read from the evidence --
  `residencyMetrics`/`checkResidencyBounded` (two halves, matching Q7e's "and": first-third vs.
  last-third max with a small slack for an ordinary ±1-2 transient tick; and, for the two metrics
  Q5 actually budgets or structurally caps (receiver memory-cache bytes against its configured
  budget; host retained payloads against 4× the live mirror's hash-backed resource count + 16,
  Q5's "current ∪ bases" with one connection), the window's own max against that bound. Once a
  metric has a bound, the bound alone decides it, not both halves ANDed -- active LRU eviction makes
  the receiver's memory-cache entry count swing by itself near a byte budget, independent of any
  real growth: measured on a real honest soak-scene run, 113 in the first third, 120 in the last,
  while bytes stayed under budget throughout -- so ANDing the growth half in would have flagged an
  honest leg. An honest leg's check fails on any growth or over-bound metric; a sabotage's fails
  only when exactly its named metric does), `checkCacheBudgetRespected` (bytes within budget plus
  payload, eviction actually exercised; the needed-set clause is proven by
  `applier2_selftest.gd`'s `_test_cache_budgets()` (until G7gd removed it), not re-derived here: a 300-s soak's
  `GRC_HOOK_LOG=off`/`RS_RECEIVER_LOG=summary` evidence has no per-event trail for it),
  `checkRssBounded` (the `/proc` sampler, or the engines' own `rss_bytes` with no sampler file),
  `checkSoakPixels` (the final shot -- by its own recorded `frame`, the highest one reached --
  against `reference-step11`) and `checkCarriedGrowthBounded` (soak-inline only: the carried-hash
  set's growth rate, never its flatness -- see "Deviations" in the README result).
- `check-gate6.ts` adds `g6s` to `LANDED_GROUPS` and `report.stability` per leg
  (`residencyMetrics` plus the eviction counters).
- `test/self-test-gate6s.ts`: the g6s cases, run from `self-test-gate6.ts`.
- Additive, shared: `gate2b-checks.ts`'s `Applied3.resources_summary` gains the three eviction
  counters and its `shots` entries gain `frame`; `gate2c-checks.ts`'s `G2cApplied` reuses both.

## Gate 6 legs and evidence under `--out` (g6s)

| Leg | Directory | Runs |
| --- | --- | --- |
| `import` | `g6s/import/{fixture,receiver}/` | the editor's `--import` of both projects |
| `reference-step11` | `g6s/reference-step11/` | rendered reference, `animate`, SOAK timeline (its own ~370-s natural quit): `shots/step-11.png` |
| `soak-scene` | `g6s/soak-scene/{host,receiver}/` | host: release template, `--headless --max-fps 60`, armed, `GRC_HOOK_LOG=off`, no file sinks, live listener, `RS_FIXTURE_VARIANT=animate RS_FIXTURE_TIMELINE=soak`, `scripts/sample-proc.ts` on its pid; receiver: rendered live, `--max-fps 60`, fresh cache, memory 1 MiB / disk 4 MiB, `RS_RECEIVER_LOG=summary`, `RS_RECEIVER_PERF_OUT` |
| `soak-inline` | `g6s/soak-inline/` | host `GRC_RESOURCE_INLINE_MAX_BYTES=GRC_RESOURCE_MAX_PAYLOAD_BYTES=1048576` (live mode's own inline cap); receiver: no cache directory or store, the generous default memory budget (eviction never runs: a carried hash is never resent, so an evicted recurring one -- MS, SM -- would be unrecoverable) |
| `sabotage-soak-no-evict` | `g6s/sabotage-soak-no-evict/` | receiver `RS_RECEIVER_SABOTAGE=no-evict`, the same budgets |
| `sabotage-soak-retain-superseded` | `g6s/sabotage-soak-retain-superseded/` | host `GRC_SABOTAGE=retain-superseded GRC_SABOTAGE_FRAME=1`, the same budgets |

## Gate 6 criteria (g6s)

`residency-bounded` (host mirror items/textures/meshes/materials, host retained payloads, receiver
memory-cache entries, receiver live RIDs per kind: max over the measured window's last third ≤ max
over its first third plus a small slack, `and` -- for the two metrics with a budget-derived bound
(receiver memory-cache bytes, host retained payloads), where the bound alone decides it instead --
the window's own max ≤ that bound; an honest leg's check fails on any flagged metric, a sabotage's
fails only when exactly its named metric is); `cache-budget-respected` (memory- and disk-cache bytes ≤ their
budget plus one payload, `evictions_memory` > 0 -- the opposite for `no-evict`); `rss-bounded`
(host RSS median delta ≤ 4 MiB and slope ≤ 0.5 MiB/min; receiver ≤ 16 MiB and ≤ 2 MiB/min; receiver
`VIDEO_MEM_USED` at the end ≤ its value at 60 s + 1 MiB); `soak-pixels` (the final shot equals
`reference-step11`'s, whole frame outside HU, budget 0); `soak-inline`'s extra
`carried-growth-bounded` (the carried-hash set's growth rate stays near what genuinely novel
inline content explains, at most 200/min against TEXA's own ~120/min under `animate` -- not that
it stops growing: render-stream-2.md's resource-duplicate rule means it never can, see "Deviations"
in the README result).

## Gate 6 self-test (g6s)

`self-test-gate6.ts` section 10 runs `test/self-test-gate6s.ts`: the windowing math
(`relativeSeries`, `maxInWindowThird`, `medianInWindowEnd`, `slopePerMinute`) on synthetic points,
then each check on fabricated evidence -- `checkResidencyBounded` (flat passes; an honest leg's
growth fails; each sabotage passes when exactly its metric grew and fails when the wrong metric (or
an extra one) grew; a metric that plateaus BEFORE the window even starts -- the real shape both
G6s sabotages produce -- is still caught, via the budget-derived-bound half rather than the growth
half; an honest leg's ordinary ±1 transient tick is NOT flagged, via the growth slack),
`checkCacheBudgetRespected` (within budget with evictions passes; over budget,
or never evicting, fails; `no-evict` passes only truly un-evicted), `checkRssBounded` (flat passes;
a rise past either side's delta or slope fails; the no-`/proc`-samples fallback) and
`checkCarriedGrowthBounded` (flat passes; growth at TEXA's own rate passes; runaway growth fails).

## Gate 6 files (g6c)

G6c ([../protocol/gate6-design.md](../protocol/gate6-design.md) "G6c", Q7d) measures publication
rates, rate mismatch, two receivers on one host, an injected receiver delay against a GPU-limited
receiver, and a constrained transport, on the fixtures' `rate` timeline in `realtime` time
(`--legs g6c`; "As built (G6c)" in the design records every decision).

- `lib/gate6c-legs.sh` (`run_g6c`): hosts in the background (armed, `GRC_LIVE_LISTEN=127.0.0.1:0`,
  `GRC_HOOK_LOG=off` unless the sabotage, no file sink, no tap), rendered receivers launched in the
  background in the private gamescope (`RS_RECEIVER_PERF_OUT`, `RS_RECEIVER_SHOT_FINAL=1`), a
  `/proc` sampler (`sample-proc.ts`, G6s's CLI) on every host and receiver, `throttle-proxy.ts`
  between receiver and host on the constrained legs, each leg's final-state reference (the
  fixture's file timeline with `RS_FIXTURE_FREEZE_STATE` from the host's own step-11 log line), and
  the `gpu-heavy` calibration (short gate6-hd `gpu-heavy` hosts until the 1920×1080 receiver's GPU
  p50 is within 15 % of 40 ms; `calibration.json`). The display proof is split: the X socket's
  ownership once per gamescope session (`display-socket-proof-<size>.json`), each receiver's own
  `DISPLAY`/`WAYLAND_DISPLAY` in `display-ownership.json` (the full walk takes ~30 s of a busy core
  and would overlap a measured window). `G6C_LEGS=<csv>` (runner environment) runs a subset.
- `run-gate6.sh`: group `g6c`, `EXTRA_CHILD_PIDS` (stopped by the cleanup trap only while their
  command line still names this run's binary or a render-stream script).
- `lib/gate6c-checks.ts`: the window (step 1's frame plus 20 s of the host clock, from
  `perf-timeline.jsonl`), rates from the timeline's cumulative counters, the receiver frame rate from
  its perf timeline's `frames` moved onto its clock, the credit capacity, every Q7d evaluator, the
  leg classes, `final-latest-state`, and one `render-stream-report/1` per leg (`repeatOf`,
  `writeLegReport`: `<leg>/report-set/` and `<leg>/render-stream-report.json`, `--repeats 1`).
- Capture: `perf-timeline.jsonl` connection entries gain `acks` (received, applied, submitted),
  `max_in_flight`, `max_queued_bytes` and the credit RTT's running totals (`credit_rtt_count`,
  `_sum_us`, `_frames_sum`); the WebSocket I/O thread is named `rs-ws-io` (the report's
  `host_io_thread_s` from `/proc`).
- Receiver: `RS_RECEIVER_SHOT_FINAL`; `rs_perf.gd` adds `gpu_render_us`/`cpu_render_us` per frame,
  `frames` per timeline line and the adapter.
- Fixtures: `RS_FIXTURE_FREEZE_STATE`, step 11's `freeze` in rate and soak step logs,
  `RS_FIXTURE_QUIT_TIME` (gate6-scene).
- `throttle-proxy.ts`: a bounded link buffer per connection and direction (one burst plus the
  bandwidth-delay product; the source is paused above it, so TCP backpressure reaches the sender),
  drain-then-end when a side stops sending, stats summed over every connection
  (`max_pending_bytes`, `pauses`, `queue_limit_bytes`), and its pid on the first stdout line.
- `lib/render-stream-report.ts` `validate(report, {repeats: 1})` and `report-gate6.ts --repeats 1`:
  a single functional repeat (`warmup` and `aggregate` null), validated, not aggregated.
- `test/self-test-gate6c.ts` (run from `self-test-gate6.ts` section 11); `test/self-test-report.ts`
  gains the single-repeat and the proxy backpressure cases.

## Gate 6 legs and evidence under `--out` (g6c)

| Leg | Host | Receiver(s) |
| --- | --- | --- |
| `rate-baseline` | `--max-fps 60`, listening, no subscriber | none |
| `rate-15`, `-30`, `-60` | `GRC_PUBLISH_FPS=15/30/60`, `--max-fps 60` | `--max-fps 60` |
| `rate-uncapped-host60` | uncapped, `--max-fps 60` | `--max-fps 60` |
| `rate-uncapped` | uncapped, `--max-fps 0` | `--max-fps 0` |
| `mismatch-60-recv30` | `GRC_PUBLISH_FPS=60`, `--max-fps 60` | `--max-fps 30` |
| `mismatch-15-recv60` | `GRC_PUBLISH_FPS=15`, `--max-fps 60` | `--max-fps 60` |
| `dual-60-15` | uncapped, `--max-fps 60`, `GRC_LIVE_MAX_CONNECTIONS=2` | `receiver-a` `--max-fps 60`, `receiver-b` `--max-fps 15` |
| `recv-delay` | `GRC_PUBLISH_FPS=60` | `--max-fps 60 --frame-delay 40` |
| `constrained` | `GRC_PUBLISH_FPS=60` | through `throttle-proxy.ts --profile constrained` (`proxy/stats.json`) |
| `sabotage-constrained-ignore-credit` | as `constrained`, `GRC_SABOTAGE=ignore-credit` from frame 900, `GRC_HOOK_LOG=on`, every payload inline, `RS_FIXTURE_QUIT_TIME=75` | through the proxy |
| `gpu-heavy` | gate6-hd `gpu-heavy` (native), the calibrated `RS_FIXTURE_BURN_ITERATIONS`, `GRC_PUBLISH_FPS=60` | `--max-fps 60 --resolution 1920x1080` |

All under `rates/<leg>/{host,receiver*,proxy,reference}/`, with `rates/gpu-heavy-calibration/`,
`rates/provenance-input.json` and `rates/legs-run.txt`.

## Gate 6 criteria (g6c)

Per leg `leg-class-<leg>` (`success`; the sabotage `delivery-violation` failing exactly
`pending-bounded` and `queue-bounded`) and `final-latest-state-<leg>` (every receiver's final shot
names a transaction at or after step 11's frame and equals the leg's reference, whole frame, budget
0). `baseline-recorded`; `rate-achieved` (rate-15/-30/-60, mismatch-15-recv60: published in [0.95 ×
min(target, credit capacity), 1.02 × target], applied within 2 %, submitted = applied ± 1 (not for
mismatch-15), receiver frame rate in [57, 61]); `published-vs-host` and `limited-by` (published ≥
0.95 × min(host frame rate, credit capacity); `limited_by` host-frame, credit or transport with its
evidence); `rate-mismatch` and `host-unperturbed` (mismatch-60-recv30); `dual-independent`;
`separation` (recv-delay `injected-delay`, gpu-heavy `gpu-limited`); `credit-rtt`, `pending-bounded`,
`queue-bounded` and `host-unperturbed` (constrained); `g6c-reports-valid`. The credit capacity is
the host frame rate over the window's mean credit RTT in host frames ("As built (G6c)" 2).

## Gate 6 self-test (g6c)

`self-test-gate6.ts` section 11 runs `test/self-test-gate6c.ts`: histogram percentiles, the window
and the timeline rates, the receiver frame rate on its own clock, every rate evaluator with a
passing case (including a phase-locked 60/60 leg at 30) and failing cases (a host sitting on
credits, a burst above the target, a slow receiver, a missing credit-blocked tick, B above its frame
rate, two snapshots per frame), `limited_by` (host-frame, credit, transport), the separation
classes, the transport bounds and the leg classes.

## Gate 7 files (g7-0 web export, G7e)

G7e ([../protocol/gate7-design.md](../protocol/gate7-design.md) "G7e", D5, Q4) exports the
native receiver to the web and replays gate 0's receiver legs in it
(`pnpm render-stream:gate7 -- --legs g7-0 …`).

The build inputs live outside the repository and are pinned by sha256. Only these two are
accepted:

- **Template** (D5, fork F2): `~/.cache/godot-render-stream/templates/4.5.1-stable/web_nothreads_release.zip`,
  sha256 `7f6c5efc9952f6f02509adfb92298161c0152a1f6a81c0bf9b9f4f913676e9c8`. It is the official
  4.5.1-stable export templates' no-threads, no-dlink web build.
- **Editor**: the non-mono 4.5.1 editor,
  `~/.local/share/mise/installs/godot/4.5.1-stable/Godot_v4.5.1-stable_linux.x86_64`, sha256
  `db07cae7de644278a1884d4552bdf2bca3f5d30131b18faf3a0c4d730080b199`. `mise exec -- godot` is the
  mono build, which has no web template.

The files:

- `../receiver/export_presets.cfg` (committed). It holds D5's keys and the `@RS_WEB_TEMPLATE@`
  placeholder. It sets `script_export_mode=0` (scripts as text) and `exclude_filter="tests/*"`.
- `../receiver/web/shell.html`, Q4's shell. It does the following:
  - removes the fragment token;
  - turns `?env=<base64url JSON>` into `--rs-env=NAME=VALUE` words after `--`, and adds
    `RS_RECEIVER_PAGE_ORIGIN`;
  - places performance marks;
  - exposes `__rsWasmHeap()`;
  - on context loss, PUTs a stub, then reloads;
  - sizes the canvas;
  - applies the `css-opacity` sabotage;
  - records `window.__rsShell` (the exit code and the engine's printed lines with their times).
- `../receiver/rs_config.gd` and `../receiver/rs_io.gd`, Q4's shims (`../receiver/README.md`).
- `build-web-receiver.sh [--out DIR] [--force] [--core rust]` builds the bundle: `Web (rust
  core)`, `preset.0` and the only preset since G7gd (G7xw; `--core` accepts only `rust`). It:
  - runs `build-rs-core-web.sh`, which builds `rs-core-capi` with the pinned F4 nightly
    (`-Zbuild-std`, PIC, `panic=abort`, hidden default visibility) and links it with the shim by
    emcc 4.0.11 into the side module `../receiver/ext/build/web/librs_core_ext.wasm`;
  - checks the editor's and the dlink template's digests;
  - stages the receiver's git-visible files into
    `artifacts/render-stream/web-receiver/<sha16>/project/`, `ext/` without its `.gdignore`;
  - fills in the template placeholder;
  - runs `--import` and `--export-release "Web (rust core)"`, and checks that the export copied
    the module beside the engine;
  - writes `bundle/build.json` (`render-stream-web-build/1`). It records the git commit, the
    editor, the template, the preset's sha256 and options, `core` (`rust`), every bundle file's
    size and sha256, the `.pck`'s file list (`lib/godot-pck.ts`) and the module's own
    `build.json` (`rs_core_web`).

  A build of the same source is reused unless `--force`. The last line printed is the bundle
  directory. G7gd removed the GDScript-core `Web` preset (G7e's and G7b's build); G7b's preserved
  shots (`artifacts/render-stream/gate7/g7b-r1/`) stay the web export's byte oracle.

  `run-gate7.sh` (its `--web-core` accepts only `rust`), `gate7-tool.ts web-legs` and
  `gate7-bench.ts --arm web` (legs `*-web-rs*`) run on that bundle, and add no core word to a
  leg's env. `run-gate7.sh` and `gate7-tool.ts` (`requireRustBundle`) refuse a bundle whose
  `build.json` does not say `core: "rust"` (an old GDScript build). G7gd retired
  `receiver-core@web` and its `GATE7_WEB_CORE_SABOTAGE=drop-env` sabotage: with one core there is
  nothing to fall back to, and a receiver whose adapter does not load refuses to start.
  `lib/wasm-side-module-info.mjs` lists a side module's dylink info, exports and imports.
- `lib/godot-pck.ts` reads the directory of a `.pck` (format 2 or 3, from
  `core/io/file_access_pack.cpp`). `web-build-json.ts` writes `build.json`.
- `lib/gate7-web-legs.ts` (`runWebLegs`, `mapNativeLeg`) derives each web leg from its native
  leg's `env.txt` and `argv.txt`:
  - the recording is copied into the web leg and named by its URL path;
  - `RS_RECEIVER_OUT` moves to the web leg;
  - `RS_RECEIVER_CACHE_DIR` is dropped;
  - store and library paths become `/sources/<gate>/…`;
  - every other value is passed verbatim;
  - `--resolution` becomes the canvas size.

  A leg runs as follows:
  - one fresh browser through `browser-harness.ts`;
  - `browser-provenance` on `about:blank`;
  - the page `/web-bundle/receiver.html?env=…`, with evidence PUT to the leg's own directory (a
    per-leg nonce);
  - a CDP screenshot of the canvas while the `applied.json` PUT is held, for
    `compositor-equals-readback`;
  - `console.jsonl`, `stdout.log`, `exit-code.txt`, `timings.json`, `provenance.json`,
    `page-config.json` and `env.txt`.
- `lib/browser-harness.ts` (G7h's `HarnessServer`) gains these features:
  - `GET <dir>/?list` (a JSON array of the relative paths under it);
  - per-nonce evidence directories (`evidenceDirs`, `addLeg`, `removeLeg`);
  - an awaited `onPut` hook.
- `lib/gate7-adapters.ts` holds the gate 0 adapter (`checkGate0Web`). It builds a view of the
  source run in which every receiver leg links to its web leg, runs `runGate0()` on it, and keeps
  the receiver checks as `<id>@web`. It adds gate 7's checks and records the build's D21
  provenance (`currentBuildProvenance`).
- `gate7-tool.ts` provides the runner's helpers, `source-provenance` and `web-legs`.
- `run-gate7.sh` / `check-gate7.ts` take g7-0 with these flags:
  - `--source gate0=<run>` or `--make-sources` (the latter runs `run-gate0.sh` and writes
    `gate7-source.json`);
  - `--extension`, plus `--calibration` for `--make-sources`;
  - `--bundle` (default: build it);
  - `--skip-harness-selftest`.
- `test/self-test-gate7e.ts` covers the pck reader, the leg mapping, the applied normalization and
  the view.

## Gate 7 legs and evidence under `--out` (g7-0 web)

`sources-made/gate0/` is the native source run (with `--make-sources`), `sources/gate0` and
`web-bundle` are symlinks the harness serves, and `gate0/web/<leg>/` holds each web leg, where
`<leg>` is the native leg's own path. `gate0/web-view/` is the checker's view.

| Web leg | Replays | Expected |
| --- | --- | --- |
| `receiver` (+ compositor screenshot) | `receiver` | `success` |
| `preexisting-skip/receiver` | same | `partial-unknown-items` |
| `sabotage-{freeze,omit,perturb}/receiver` | same | `pixel-mismatch` at their native steps |
| `unsupported/receiver`, `corrupt` | the native headless legs, rendered (D11 note in [results/gate7/g7e.md](../results/gate7/g7e.md)) | `unsupported`; `replay-failure` seq 3 `meta-json` |
| `sabotage-css-opacity` | `receiver`, shell `opacity: 0.99` | fails exactly `compositor-equals-readback` |
| `probe-render-time` | `receiver` + `RS_RECEIVER_PERF_OUT` | report only |

## Gate 7 criteria (g7-0 web)

- **gate 0's receiver checks, judged by gate 0's own checker on the view, `@web`:**
  `expected-image-receiver`, `receiver-vs-reference`, `receiver-consumed-stream`,
  `preexisting-skip-receiver`, `preexisting-skip-excluded-region`, and `leg-class-<leg>` for the
  seven receiver legs.
- **`source-run-valid`** (D21, amended by GRT): the source run passed with every native receiver
  leg in its class, and its `gate7-source.json` was made from the same inputs: the same content
  key (`lib/source-key.ts`: template, capture library and calibration sha256, the native receiver
  core, and every git-visible file under `receiver/`, `capture/`, `fixtures/`, `rs-core*/` and
  `scripts/` except gate 7's own and docs), and the same capture library and template sha256. The
  commit no longer matters; a schema /1 source (no key) still needs the same commit and dirty
  digest.
- **`browser-provenance`** passes on every leg.
- **`console-clean`**: no `SHADER ERROR`, no `WebGL: ` and no page error.
- **`evidence-complete`**: every file a native leg wrote exists for its web leg. The exceptions are
  the native runner's own files: `cache/`, `diff/`, display ownership, strace, the shot-seqs file,
  the step join and the corrupt tool's log.
- **`applied-equals-native`**: the documents are equal except for `*_us`, `process_frame`, the
  paths, `receiver`, `cache` and `display_server`. On natively headless legs, `viewport` is
  excluded as well.
- **`no-source-scene`**: nothing in the `.pck` lies under `fixtures/`, and no `.pck` path carries
  a fixture script's name.
- **`compositor-equals-readback`**: exact on opaque frames. It applies only when the last shot's
  resolved state equals the last applied one, which is checked from the recording.
- **`sabotage-css-opacity`**: it fails exactly that check, its shots equal the honest leg's, and it
  exits 0.
- **Reported, not gating:** `probe-render-time` and `pw1-web-equals-native` (Q7 P-W1, every shot
  byte-equal to native).

## Gate 7 files, legs and criteria (g7-1 to g7-6 web export, G7b)

G7b ([../protocol/gate7-design.md](../protocol/gate7-design.md) "G7b", Q4, Q7, Q8, D11, D21, D34)
replays every **file** receiver leg of gates 1 to 6 in the G7e web export (on the GDScript decoder
until G7xd, the Rust core since; G7gd removed the GDScript one), and judges each gate with that gate's own checker:

```bash
pnpm render-stream:gate7 -- --legs g7-1,g7-2,g7-3,g7-4,g7-5,g7-55,g7-6 \
  --source gate1=<run>,gate2=<run>,gate3=<run>,gate4=<run>,gate5=<run>,gate55=<run>,gate6=<run>
# or --make-sources: runs run-gate<N>.sh with only the file-leg groups into <out>/sources-made/
```

A source needs `gate7-source.json` (`gate7-tool.ts source-provenance --extension E [--calibration
C] --out <run>/gate7-source.json`, written right after the run). `--make-sources` looks each
source up in the input-keyed source cache first and publishes every passing source it makes
(`source-cache.sh`, below). A full native run of a gate serves as its
source. The view keeps only the file-leg groups (g1a,g1b / g2a,g2b,g2d / g3a-g3d / g4a-g4f /
g5b,g5c,g5d,g5e,g5g / g55b-g55e / g6a,g6h,g6b); the live groups are G7l's and G7g's.

- `lib/gate7b-adapters.ts`:
  - `discoverFileReceiverLegs` finds every leg of the source whose `env.txt` sets
    `RS_RECEIVER_RECORDING` (not `RS_RECEIVER_URL`) and whose `argv.txt` runs the receiver
    project. Four kinds are typed, not replayed: `native-only-trace` (an strace leg),
    `native-only-editor` (a debug-editor support leg), `native-only-warm-cache`
    (`RS_RECEIVER_CACHE_MODE=warm`; Q4: the web has no cache directory) and `live-derived` (a
    replay of a live receiver's received tap).
  - `buildMirrorView` makes a view of the source. Every entry links to the source and a replaced
    leg links to its target. Strace legs are relocated: `strace.txt` is copied with the source
    path rewritten to the view's. `result.json` is dropped, and `legs.json` names only the view's
    groups.
  - `checkGateWeb` runs the gate's CLI checker (`check-gate<N>.ts --out <view>`) on four views:
    - `native-view`: no leg replaced;
    - `blank-view`: every replayed leg is an empty directory;
    - `web-view`: the web legs;
    - `banded-view`: the web legs, except that every shot whose differing pixels are all
      `readback` or `delta1` is replaced by the native shot.

    A check whose verdict differs between `native-view` and `blank-view` reads a replayed leg. It
    is reported as `<id>@web` and judged on the banded view; when the raw web verdict differs, the
    detail quotes it. Every other check is source-only. `<out>/gate<N>/classification.json` records
    the legs, the web and source-only check ids, the checks that fail raw, and every shot's
    classes.
  - `classifyShot` sorts each differing pixel into one of three classes:
    - `readback`: some 10-bit value v gives the native byte `floor(v/4)` and the web byte
      `round(v*255/1023)`, and alpha is equal;
    - `delta1`: every colour channel is within 1, and alpha is equal;
    - `other`: anything else.
  - `NOT_APPLICABLE_AT_WEB` lists gate 2's `fresh-cache` and `warm-cache` (Q4). They are reported
    and do not gate.
- `gate7-tool.ts`:
  - `discover --source <run>` lists the source's file receiver legs.
  - `web-legs --group g7-<N> --source <run> --bundle <dir> --out <run> [--only a,b]
    [--repeat-differing]` replays them into `<out>/gate<N>/web/<leg>`. With `--repeat-differing`,
    it then replays every leg whose shots differ from native once more, into
    `<out>/gate<N>/web-repeat/<leg>`.
- `lib/gate7-web-legs.ts` copies the native leg's `shot-seqs.txt` into the web leg, because gate
  5.5d's checker reads it.
- `test/self-test-gate7b.ts` covers `classifyShot`, discovery and the view.

Gate 7's own checks for each gate, all suffixed `@web`:

| Check | Gating | What it requires |
| --- | --- | --- |
| the gate's own receiver checks | yes | they pass on the banded view (Q7 band; gate7-design.md "As built (G7b)") |
| `source-run-valid` | yes | the native view passes every web check, and `gate7-source.json` matches the build (D21) |
| `browser-provenance`, `console-clean`, `evidence-complete` | yes | as for g7-0 |
| `applied-equals-native` | yes | as for g7-0, with source paths inside values mapped to their URL paths; a leg with a `web-*` refusal is reported by `web-refusals` instead |
| `compositor-equals-readback` | yes | on the honest `receiver` legs and the HD presentation legs, when the last shot is of the exit state and opaque |
| `pw1-classes` | yes | no `other` pixel, except on a leg with a `web-*` refusal |
| `web-repeat-identical` | yes | each differing leg's repeat is byte-identical to its first run |
| `raw-web-checks`, `pw1-web-equals-native`, `web-refusals`, `legs-not-replayed`, `fresh-cache`, `warm-cache` | no | reported only |

### Gate 7l: live legs in both browsers

G7l ([../protocol/gate7/g7l.md](../protocol/gate7/g7l.md)) runs the **live** groups of gates 1, 2,
5 and 5.5 (g1c, g1d, g2c, g2e, g5f, g55f) in the web export and the GSW receiver over
render-stream/7:

```bash
bash experiments/render-stream/scripts/run-gate7.sh --live --legs g7-1,g7-2,g7-5,g7-55 \
  [--receiver web|gsw] [--bundle <web bundle>] [--gsw-bundle <dir>] --out <dir>
```

A live leg has no source run. Its host paces against the receiver it serves, so `--live` runs each
gate's own runner again, with `GATE7_LIVE_KIND=web|gsw` and `GATE7_BUNDLE_DIR`, into
`<out>/<gate>/live-<kind>/`. A gate runner can also be called that way by hand. Optional variables:
`GATE7_HARNESS_PORT`, `GATE7_HOST_PORT`, `GATE7_BUILD_SHA256`, `GATE7_MANIFEST_SHA256`.

- `lib/legs.sh` makes the GATE7-mode substitutions:
  - Every live host gets `GRC_LIVE_ALLOWED_ORIGINS=http://127.0.0.1:<harness port>` and the fixed
    host port.
  - Every receiver launch with `RS_RECEIVER_MODE=live`, and every file replay of a GRS7
    recording, goes to the browser daemon. Each leg is one `curl` to it. `native-env.txt` and
    `native-argv.txt` record what the native leg would have run.
- `lib/gate7-live-legs.ts` is the daemon (`gate7-tool.ts browser-daemon`). It keeps a spare
  Chromium, already provenance-checked, and runs one fresh profile per cold leg. A warm leg starts
  on a copy of its cold leg's profile. It maps env words to URL paths, passes the token in the
  fragment only, and writes the per-leg files. `gate7-tool.ts browser-receiver` is the one-shot
  form. **G7hp**: every profile lives in a `gsw-chromium-profile-*` directory under the system
  temp dir, never under `--out` (its GPUCache/ShaderCache/GraphiteDawnCache have no evidence value
  and ran ~250 MB per leg); the daemon removes its whole root at shutdown, and the one-shot form
  removes its own after its one leg.
- `lib/gate7-live.ts` (`check-gate7.ts --live`) judges the run through views:
  - Full, blank and banded views of the run tell which checks read a browser leg; those are
    reported `<id>@<kind>`, and every other check counts toward `native-legs@<kind>`.
  - The banded view is Q7's delta1/readback band, snapped per pixel against the nearest native
    image.
  - `LIVE_KNOWN_FAILURES` names a failure an earlier typed refusal explains, such as web g5f's
    `web-index-region-update`. Those checks still fail.
  - Gate 7's own checks: `browser-provenance`, `console-clean`, `hello-recorded`,
    `credit-from-paced-loop`, `token-not-logged`, `live-vs-replay`.
  - Per-connection cadence lines report sent/offered, the credit RTT in frames, and the
    `submitted` ack latency.
- `test/self-test-gate7l.ts` covers the browser leg mapping, the `.rs7` tap discovery and /7
  decoding, the http-cache fetch and warm rules, `credit-from-paced-loop` and the known-failure rule.

### G7g: gate 6 on both browsers

G7g ([../protocol/gate7/g7g.md](../protocol/gate7/g7g.md)) extends the GSW canvas receiver and the
web export to gate 6 (the scene, the HD fixture at both presentations, the presentation hazard):

```bash
bash experiments/render-stream/scripts/run-gate7.sh --legs g7-6 --receiver gsw --make-sources --out <dir>
bash experiments/render-stream/scripts/run-gate7.sh --live --legs g7-6 --receiver web --web-core rust --out <dir>
```

- `lib/gate7-gsw-g6.ts`: the gsw receiver's 19 legs of g6a/g6h/g6b, the 23 of gate 6's own checks
  kept `@gsw`, and the Q7 plans (the model's per-shot raster, the native leg's `applied.json`
  mapping a receiver shot seq to its model shot index, and the sabotage/honest-leg pairing).
- `lib/gate7-g6-checks.ts`: `presentationCheck` (each browser leg's canvas backing store, read
  from the page at exit, equals the session's `presentation_size`; the hazard's is its window
  instead) and `q7RegionsReport` (`q7-regions-g6@gsw`, a report-only per-size, per-region pixel
  count against the rendered reference). Both are shared by file legs (`gate7-web-legs.ts`,
  `gate7-gsw-checks.ts`) and live legs (`gate7-live-legs.ts`, `gate7-live.ts`), and by both
  browsers.
- `web/gsw-rs`'s presentation adoption (`set_window`, `presentation_json`) and `rs-core`'s
  `canvas_attach`/`canvas_stacking_sets` counters are gate 6 specific; see
  [../results/gate7/g7g.md](../results/gate7/g7g.md) "What was built" for both.

### G7r: pacing, rates, the phase study and dual receivers

G7r ([../protocol/gate7/g7r.md](../protocol/gate7/g7r.md), gate7-design.md Q9) runs G6c's g6c
group again on all three receivers, unforked, and judges it with G6c's own evaluators:

```bash
bash experiments/render-stream/scripts/run-gate7.sh --live --legs g7-r --web-core rust \
  [--receiver native|web|gsw] [--bundle <web bundle>] [--gsw-bundle <gsw bundle>] --out <dir>
```

- `run-gate7.sh` runs `run-gate6.sh --legs g6c` once per receiver kind, with `G6C_LEGS` set to
  that kind's legs (`G7R_LEGS_<kind>`; `G7R_LEGS` replaces every kind's list), into
  `<out>/gate6/rates-<kind>/`. Every receiver runs on the Rust core (the only one since G7gd).
- `lib/gate6c-legs.sh` takes receiver kinds: under `GATE7_LIVE_KIND` every g6c receiver is that
  browser (`run_browser_receiver`), rAF-bound where native runs at 60 (`G6C_RECV60`), unless the
  leg keeps it native (`G6C_RECEIVER_NATIVE=1`). G7r's own legs (`phase-60-r1..r5`,
  `phase-60-late-poll-r1..r5`, `dual-native`, `sabotage-ack-on-receipt`) run only when named in
  `G6C_LEGS`, so a gate 6 run is unchanged. Under `GATE7_LIVE_KIND`, `constrained` has bearer
  authorization, so its payload GETs are preflighted.
- The browser daemon's `--spare after` (`GATE7_BROWSER_SPARE=after`, set by g7-r) launches the
  next leg's browser only after a leg ends, so no Chromium start-up runs in a timed window.
- `receiver.gd`'s `RS_RECEIVER_LATE_POLL=1` moves the live read, fetch poll and apply to
  `RenderingServer.frame_pre_draw` (native and web; a usage error under `--headless`). GSW's
  `perf.json` gains a per-second `timeline` (`frames`, its paced callbacks, and `drawn`) and
  `raf_after_submit_us`.
- `throttle-proxy.ts` observes each connection's HTTP/1.1 exchanges without changing them:
  `stats.json` `http.preflight` (an OPTIONS to its 204 delivered) and `http.get`.
- `lib/gate7r-checks.ts` (`check-gate7.ts --live --legs g7-r`), per kind: G6c's checks on every
  leg; `phase-classified` and the phase table (good at a mean credit RTT <= 1.1 host frames, bad
  at >= 1.9, and the whole-run median's class beside it); `dual-independent` with the connection
  versions; Q7's band on browser final shots; the browser legs' provenance, console, hello, paced
  loop, token and core; `late-poll-active`; the preflight report; and the ack-on-receipt sabotage.
  Each kind's numbers are written to `<out>/gate6/rates-<kind>/g7r-summary.json`.
- `test/self-test-gate7r.ts` covers the leg lists against the runner, the phase classes, G6c's
  bound in both phases, the mismatch bounds and the sabotage rule, GSW's phase-free hold, the
  fetch-tail attribution and the proxy's HTTP observer.

### G7hp: Chromium profiles out of gate 7 evidence

G7hp ([../results/gate7/g7hp.md](../results/gate7/g7hp.md)) moves every gate 7 live leg's
Chromium profile out of `--out` and into the system temp dir, since a profile's
GPUCache/ShaderCache/GraphiteDawnCache have no evidence value and ran ~250 MB per leg.

- `lib/gate7-live-legs.ts`'s `serveBrowserDaemon` (`gate7-tool.ts browser-daemon`) now
  `mkdtemp`s one `gsw-chromium-profile-*` root per daemon under `os.tmpdir()` instead of
  `<out>/gate7-browser/profiles/`; every leg's (and warm leg's copy-from) subdirectory lives
  there, removed whole on `shutdown` (SIGTERM or the parent-gone poll), with a synchronous
  `process.on("exit", …)` net for a crash that skips it. `runBrowserReceiver` (the one-shot
  `browser-receiver` form) keeps its own already-temp-dir profile but now removes it after its
  one leg on every path: normal return, a thrown error, and SIGTERM (after `leg.abort()`
  SIGKILLs the leg's Chromium processes).
- Nothing reads file content out of a profile for evidence: `checkBrowserProvenance` reads the
  Chromium binary and CDP, never the profile directory; the existing `gate7-browser/profiles/`
  skips in `lib/gate7-live.ts` (`grepTree`, `discoverBrowserLegs`, `bandSubstitutions`) are now
  defensive no-ops, since no profile lands under `--out` any more.
- No check or sabotage changed; see the result doc for what was re-run.

### G7wf: the web export's payload GETs through the browser's `fetch`

G7wf ([../protocol/gate7/g7wf.md](../protocol/gate7/g7wf.md),
[../results/gate7/g7wf.md](../results/gate7/g7wf.md)) moves the web export's live payload GETs
from Godot's web `HTTPClient` (four main-loop iterations, about 66 ms, per GET; G7r) to the
browser's own `fetch()` through `JavaScriptBridge` (`receiver/rs_resource_fetcher.gd`).

- `run-gate7.sh --live --web-fetch fetch|httpclient` (default `fetch`) passes `GATE7_WEB_FETCH` to
  every gate runner's browser daemon. `httpclient` makes `coreEnv` (`lib/gate7-live-legs.ts`)
  add `RS_RECEIVER_WEB_FETCH=httpclient` to every web leg: the pre-G7wf path, kept for the A/B.
- `check-gate7.ts --live --web-fetch <mechanism>` adds `fetch-impl@web` to every live web group
  and to `g7-r@web`. It fails a live web leg whose applied.json `live.fetch_impl` is not
  `browser-fetch` (or `httpclient` on the A/B arm). The sabotage is the A/B arm judged as `fetch`.
- On the browser path each applied.json `fetches[]` entry gains `browser`: `headers_ms`,
  `body_ms` and `callback_ms` on the page clock after the `fetch()` call, and `process_frames`,
  the main-loop iterations completed before the callback.

## Gate 8 files (g8t, G8t; g8a, G8a and G8r; g8h, G8h; g8f, G8f; g8m, G8m; g8kp, G8kp; g8ku, G8ku; g8kc, G8kc; g8c, P3-CT; g8cg, CG1)

```bash
mise exec -- pnpm render-stream:gate8 -- \
  --extension "$PWD/experiments/render-stream/capture/build/render_stream_capture.gdextension" \
  --calibration "$PWD/experiments/render-stream/calibration/godot-4.5.1-stable-linux-release.json" \
  [--legs g8t,g8a]
```

- `run-gate8.sh`: the orchestrator (`run_g8t` with `run_import_g8t`, `run_oracle` and
  `run_reference_g8t`; `run_g8a` with `run_import_g8a` and `run_capture_g8a`, which G8r extends;
  `run_g8h` with `run_import_g8h` and `run_capture_g8h`; G8f adds `run_g8f`; `run_g8m` with
  `run_import_g8m` and `run_capture_g8m`; `run_g8kp` with `run_g8kp_live`; `run_g8ku` with
  `run_import_g8ku`, `run_capture_g8ku`, `run_reference_g8ku` and `run_g8ku_live`; P3-CT's
  `run_g8c` with `run_import_g8c` and `run_capture_rendered_g8c`; CG1's `run_g8cg` with
  `run_import_g8cg` and `run_capture_g8cg`).
- `gate8-delivery-tool.ts` (G8kp): builds the rs-core wasm and the GSW bundle, then replays the
  native leg `g8kp/receiver` in the GSW receiver page three times (as is, BC masked, the
  ignore-format-mask sabotage) through gate 7's `runWebLegs`, into `g8kp/gsw-run/`. G8ku's
  `web-legs` builds the web export (`build-web-receiver.sh`) and replays `g8ku/receiver-upgrade`
  in it, into `g8ku-web/web` (beside `g8ku/`, whose harness link targets `g8ku/` alone: a second
  link to the whole run would make the remote artifact trim's recursive glob never end).
  G8kf and G8kwh: `gsw-legs` also replays `g8kp/receiver` in the web export into `g8kp-web/`: as
  is (`web`), BC masked (`web-masked`) and with the `advertise-etc2` sabotage.
- `check-gate8.ts`: the checker CLI; writes `<out>/result.json` (`render-stream-gate8-report/1`:
  `checks`, and under `g8t` the legs, the `decode_cost` table, the largest calling-thread `hitch`
  and the informative `hardware_band`; under `g8a` the legs, the adoption `cost`, the
  `equivalence` summary, the per-checkpoint `pixels` diffs and the `sabotages`).
- `lib/gate8-tex-checks.ts`: the g8t checks (`runG8t`) and their pure helpers (`pairTextures`,
  `censusProblems`, `oracleProblems`).
- `test/self-test-gate8.ts`: the helpers on `fixtures/gate8-tex/expected.json` and synthetic hook,
  fixture and oracle lines, each with a passing and a failing case.
- `lib/gate8-adopt-checks.ts`: the g8a checks (`runG8a`) and their pure helpers (`canonicalState`,
  `compareStates`, `equivalence`, `censusProblems`, G8r's `resourceException`): born-armed
  equivalence through an id bijection built per container in draw order, with exactly Q2's
  exceptions and G8r's two declared resource exceptions (creation copies, refused textures).
- `test/self-test-gate8-adopt.ts`: those helpers on `fixtures/gate8-adopt/expected.json` and
  synthetic resolved states.
- `lib/gate8-size-checks.ts`: the g8h checks (`runG8h`) and their pure helpers (`sizeProblems`,
  `probeProblems`, `atlasProblems`, `accountProblems`); it reuses g8a's `equivalence`.
- `test/self-test-gate8-size.ts`: those helpers on `fixtures/gate8-size/expected.json` and
  synthetic sessions, probes and recordings.
- `lib/gate8-ct-checks.ts` (P3-CT): the g8c checks (`runG8c`) and their pure helpers
  (`premiseProblems`, `regionProblems`, `uploadProblems`); `test/self-test-gate8-ct.ts` drives them
  on `fixtures/gate8-ct/expected.json` and synthetic recordings, images and upload lists.
- `lib/gate8-cg-checks.ts` (CG1): the g8cg checks (`runG8cg`) and their pure helpers
  (`wireStateProblems`, `toggleProblems`, `sessionProblems`, `itemKeyProblems`,
  `hookCountProblems`, `cellDiff`, `cellProblems`, `exactProblems`, `modelProblems`);
  `test/self-test-gate8-cg.ts` drives them on `fixtures/gate8-cg/expected.json` and synthetic items,
  sessions, counters and images, including that each receiver sabotage's picture is caught.
- `lib/gate8-mat-checks.ts`: the g8m checks (`runG8m`) and their pure helpers (`shaderHashParity`,
  `paramParity`, `cimBuiltin`, `includeRefused`, `itemAt`); it reuses g8a's `equivalence`, whose
  `canonicalState` compares materials by content since G8m.
- `test/self-test-gate8-mat.ts`: those helpers on `fixtures/gate8-mat/expected.json` and synthetic
  resolved states.
- `lib/gate8-delivery-checks.ts`: the g8kp checks (`runG8kp`) and their pure helpers (`predictD3`,
  D3 written independently of rs-core's `delivery.rs`; `deliverySelectProblems`;
  `gswBlockAgainstHw`).
- `lib/gate8-basis-checks.ts` (G8ku): the g8ku checks (`runG8ku`) on
  `fixtures/gate8-basis/expected.json`, and `psnrRgba`.
- `test/g8ku-png-to-rgba.gd` (G8ku): the UASTC level bench's input step (PNG files anywhere, read
  only, to raw RGBA8 in a scratch directory); the bench is `capture/build/rs_basis_level_bench`.
- `test/self-test-gate8kp.ts`: those helpers and the GSW receiver's `hello.ts` on synthetic
  entries, uploads and pixels, each with a passing and a failing case.

## Gate 8 legs and evidence under `--out` (g8t)

| leg | what |
| --- | ---- |
| `import/sources`, `import/fixture`, `import/receiver` | the editor: `make_sources.gd` (synthetic sources and `.import` settings into the fixture's ignored `tex/`), `--import` (S3TC/BPTC and ETC2/ASTC variants), the receiver's import |
| `oracle` | `oracle.gd` on the template, headless: `oracle.json` (per `.ctex`: source format, `Image.decompress` result, GRT1 payload SHA-256) and `<name>.<family>.grt1` |
| `capture` | headless, `GRC_STREAM_VERSION=8 GRC_TEXTURE_DECODE=engine`, both sinks (`recording.rs8`, `recording-patch.rs8`), store, `textures.jsonl` |
| `decode-off/capture` | headless, no gate 8 policy (the default /6 sink, `recording.rs2`): today's refusals |
| `sabotage-perturb-decode/{capture,receiver}` | `GRC_SABOTAGE=perturb-decode` from frame 11 (step 1), and the native receiver on it |
| `reference` | rendered, `RS_FIXTURE_SOURCE=decoded`: the oracle's payloads drawn as plain textures |
| `reference-hw` | rendered, the `.ctex` itself (GPU-sampled, or GLES3's own CPU fallback): informative |
| `receiver`, `receiver-patch` | the native receiver on `capture`'s full and patch sinks |
| `workers/capture` | G8kw: `capture` again under `GRC_TEXTURE_WORKERS=2 GRC_TEXTURE_WORKER_MIN_BYTES=0 GRC_TEXTURE_WORKER_DELAY_MS=8` (every copy, decode and hash on a worker, each job delayed so publication is held back) |
| `workers/sabotage-publish-before-ready/capture` | the same with `GRC_TEXTURE_WORKER_FAULT=publish-before-ready` (a pending texture published at once, hash all zeros) |
| `decode-cost/oracle-timing`, `decode-cost/capture`, `decode-cost/capture-workers` | timing group `decode-cost` (`timing_leg`, real time, skipped on hosted runners): best-of-3 `Image.decompress` of the 2048×2048 cost textures, the hook's own decode, copy and hash times on them (`RS_FIXTURE_VARIANT=cost`), and (G8kw) the same creates at `GRC_TEXTURE_WORKERS=2`: the calling thread's `hook_ns` |

## Gate 8 legs and evidence under `--out/g8a` (g8a)

| leg | what |
| --- | ---- |
| `import/sources`, `import/fixture`, `import/receiver` | the editor: `make_sources.gd` (G8r's two textures into the fixture's ignored `tex/`), the `--import` of `fixtures/gate8-adopt` and of the receiver |
| `born/capture` | headless, `GRC_STREAM_VERSION=8 GRC_UNKNOWN_ITEM=skip GRC_TEXTURE_DECODE=engine`, main scene `res://born.tscn`, armed in the loader's `_enter_tree`: every object created armed; both sinks, store, `steps.jsonl`, `probe.jsonl` |
| `born-adopt/capture` | `born` with `GRC_ADOPT=arm`: adoption at birth, nothing to adopt |
| `late/capture` | `adopt.tscn` as the main scene, armed at frame K=12 with `GRC_ADOPT=arm` |
| `late-strict/capture` | `late` without `GRC_UNKNOWN_ITEM=skip`: the residue's first call fails `pre-existing-object` |
| `late-thread/capture` | `late`, the extension loaded from a worker thread (`RS_FIXTURE_ARM=thread`): the stream refuses `adopt-thread` |
| `late-workers/capture` | G8r: `late` at `GRC_TEXTURE_WORKERS=2 GRC_TEXTURE_WORKER_MIN_BYTES=0 GRC_TEXTURE_WORKER_DELAY_MS=8`: adopted copies on delayed workers |
| `fault-{no-resources,atlas-from-dummy,claim-current}/capture`, `fault-{no-resources,atlas-from-dummy}/receiver` | G8r: `late` under `GRC_ADOPT_FAULT`, and the native receiver on the two whose pixels differ |
| `sabotage-adopt-{skip-state,no-redraw,skip-layers}/{capture,receiver}` | `late` with the walk sabotage, and the native receiver on it |
| `reference` | rendered, unarmed: shots `step-<k>.png` at the four checkpoints |
| `born/receiver`, `late/receiver`, `late/receiver-patch` | the native receiver on born's and late's full sink and late's patch sink |

## Gate 8 legs and evidence under `--out/g8h` (g8h)

| leg | what |
| --- | ---- |
| `import/fixture`, `import/receiver` | the editor's `--import` of `fixtures/gate8-size` and of the receiver |
| `born/capture` | headless (the 64x64 host), `GRC_STREAM_VERSION=8 GRC_UNKNOWN_ITEM=skip GRC_ROOT_SIZE=presentation:640x360`, main scene `res://born.tscn`, armed at birth |
| `late/capture` | `size.tscn` as the main scene, armed at frame K=12 with `GRC_ADOPT=arm` and the same policy; `size.jsonl` is the fixture's own read of the engine at K-1 and K+1 |
| `late-observe/capture` | `late` without the policy: the degenerate control |
| `sabotage-size-before-adopt/{capture,receiver}`, `sabotage-size-before-adopt-strict/capture` | `GRC_SABOTAGE=size-before-adopt` under skip (and the receiver on it) and under strict |
| `reference` | rendered at 640x360, unarmed: shots `step-<k>.png` at the three checkpoints |
| `born/receiver`, `late/receiver`, `late/receiver-patch`, `late-observe/receiver` | the native receiver on born's and late's full sink, late's patch sink and the control |

## Gate 8 legs and evidence under `--out/g8c` (g8c, P3-CT)

| leg | what |
| --- | ---- |
| `import/fixture`, `import/receiver` | the editor's `--import` of `fixtures/gate8-ct` and of the receiver |
| `reference` | rendered at 640x360, unarmed: shots `step-<k>.png` at the two checkpoints |
| `capture` | the same private gamescope (a rendered host: headless allocates no canvas texture), armed at birth, `GRC_STREAM_VERSION=8`, both sinks, the store and its own shots |
| `receiver`, `receiver-patch` | the native receiver on the full and the patch sink |

## Gate 8 criteria (g8c)

`g8c-legs`, `ct-premise`, `ct-reference-textured`, `ct-reference` (exact outside the two refused
cells), `ct-channel-refused` and `ct-diffuse-uploaded`; each criterion is spelled out in
`lib/gate8-ct-checks.ts` and [`../protocol/gate8-design.md`](../protocol/gate8-design.md) "As built
(P3-CT)".

## Gate 8 legs and evidence under `--out/g8cg` (g8cg, CG1)

| leg | what |
| --- | ---- |
| `import/fixture`, `import/receiver` | the editor's `--import` of `fixtures/gate8-cg` and of the receiver |
| `capture` | headless, armed at birth, `GRC_STREAM_VERSION=10`: both sinks (`recording.rs10`, `recording-patch.rs10`), the store, `steps.jsonl` |
| `late/capture` | headless, armed at fixture frame 12 (`RS_FIXTURE_ARM=late`) with `GRC_ADOPT=arm GRC_UNKNOWN_ITEM=skip GRC_TEXTURE_DECODE=engine` at /10: the scene's /10 state adopted from its nodes |
| `capture-v9` | headless, armed at birth, `GRC_STREAM_VERSION=9`: the negative control (the pre-/10 wire) |
| `reference`, `reference-repeat` | rendered at 640x360, unarmed: shots `step-<k>.png` at the three checkpoints |
| `receiver`, `receiver-patch` | the native receiver on the /10 full and patch sinks |
| `receiver-v9` | the native receiver on the /9 capture (fills full height, no group, no forced copy) |
| `late/receiver` | the native receiver on the late capture (shots at checkpoints 1 and 2) |
| `sabotage-drop-canvas-group/receiver`, `sabotage-full-backbuffer-copy/receiver` | the native receiver on the /10 full sink with `RS_RECEIVER_SABOTAGE` |

## Gate 8 criteria (g8cg)

`g8cg-legs`, `cg-hooks` (both hooks planned, neither unobserved, every armed call counted),
`cg-below-10` (the /9 session unchanged), `cg-wire` (every checkpoint's items carry exactly
expected.json's state, both sinks decode at /10), `cg-toggle-patch` (a state-only patch entry),
`cg-reference-repeat`, `cg-reference-model`, `cg-native-exact`, `cg-negative-control`,
`cg-sabotage-drop-group`, `cg-sabotage-full-copy` (each differs exactly in the cells whose state it
loses) and `cg-adopt` (the late capture's state and replay); each criterion is spelled out in
`lib/gate8-cg-checks.ts` and [`../fixtures/gate8-cg/README.md`](../fixtures/gate8-cg/README.md).
In g7-8 both browsers replay every g8cg receiver leg (the web export through `GATE8_FILE_GROUPS`,
GSW through `GATE8_LEGS`), the /9 negative control and both receiver sabotages included; since CG3
GSW composites the groups and copies itself, so g8cg's own checks judge its legs through the gate 8
band (channel 1 of the native shot), with `cg-gsw-untyped@gsw` beside them.

## Gate 8 legs and evidence under `--out/g8m` (g8m)

| leg | what |
| --- | ---- |
| `import/fixture`, `import/receiver` | the editor's `--import` of `fixtures/gate8-mat` and of the receiver |
| `born/capture` | headless, `GRC_STREAM_VERSION=8 GRC_UNKNOWN_ITEM=skip`, main scene `res://born.tscn`, armed at birth; both sinks, store, `steps.jsonl` |
| `late/capture` | `mat.tscn` as the main scene, armed at frame K=12 with `GRC_ADOPT=arm` |
| `sabotage-adopt-{raw-shader-code,skip-params}/capture` | `late` with the Q5 sabotage (from K) |
| `fault-no-include-path/{capture,receiver}` | `late` under `GRC_ADOPT_FAULT=no-include-path` (the typed `shader-adopt-include`), and the native receiver on it |
| `reference` | rendered, unarmed: shots `step-<k>.png` at the three checkpoints and gate 5.5's material oracle (`materials.jsonl`, `shader-library/`) |
| `born/receiver`, `late/receiver`, `late/receiver-patch` | the native receiver on born's and late's full sink and late's patch sink |

## Gate 8 legs and evidence under `--out/g8kp` (g8kp)

| leg | what |
| --- | ---- |
| `capture` | headless, `GRC_STREAM_VERSION=9 GRC_TEXTURE_DECODE=engine GRC_TEXTURE_DELIVERY=passthrough`; both sinks (`recording.rs9`, `recording-patch.rs9`), store, `textures.jsonl` |
| `workers/capture` | the same at `GRC_TEXTURE_WORKERS=2` (G8kw's delayed workers) |
| `refused-basis/capture` | `GRC_TEXTURE_DELIVERY=basis-etc1s` at /9 (basis-uastc before G8ku): the typed refusal |
| `reference`, `reference-hw` | rendered fixture: the oracle's decoded payloads, and the `.ctex` sampled by the GPU |
| `receiver`, `receiver-patch`, `receiver-masked` | the native receiver on the full and patch sinks (`block,decoded`), and with `RS_RECEIVER_GPU_FORMAT_MASK=s3tc,bptc,rgtc` |
| `live/host`, `live/receiver` | a /9 passthrough live host (desktop step for 600 frames) and the rendered native receiver at `RS_RECEIVER_PROTOCOL=9` |
| `gsw-run/gsw`, `gsw-run/gsw-masked`, `gsw-run/sabotage-ignore-format-mask/gsw` | GSW in headless Chromium on `receiver`'s launch: as is, BC masked, the mask stated but not applied |
| `../g8kp-web/web`, `../g8kp-web/web-masked`, `../g8kp-web/sabotage-advertise-etc2/web` | (G8kf, G8kwh) the web export in headless Chromium on `receiver`'s launch: as is, BC masked, and `RS_RECEIVER_SABOTAGE=advertise-etc2` (etc2 stated without the context's extension, WebGL's rules off: the pre-G8kwh hello) |

The import and `oracle/` (which also writes `<name>.<family>.block.grt1`, each `.ctex`'s block
bytes) are g8t's, run once when both groups run.

## Gate 8 criteria (g8kp)

`delivery-capture`, `block-exact`, `delivery-workers`, `delivery-refused`, `delivery-select`,
`sabotage-ignore-format-mask`, `delivery-live`, `delivery-pixels-native` (exact against
`reference-hw`), `delivery-pixels-gsw` (delta 1 on GSW's decided pixels), `delivery-select-web`
(G8kf; G8kwh: only the families its WebGL context lists), `delivery-pixels-web` and
`sabotage-advertise-etc2` (G8kwh); each criterion is spelled out in `lib/gate8-delivery-checks.ts` and
[`../protocol/texture-delivery-design.md`](../protocol/texture-delivery-design.md) "As built (G8kp)"
and "As built (G8kwh)".

## Gate 8 legs and evidence under `--out/g8kc` (g8kc, G8kc)

All headless, no gamescope. Capture legs are `GRC_STREAM_VERSION=9 GRC_TEXTURE_DECODE=engine
GRC_TEXTURE_DELIVERY=passthrough` on `fixtures/gate8-tex` (adopt legs: gate8-adopt at /8); a cache
directory lives under `$XDG_CACHE_HOME` (else `~/.cache`) in `godot-render-stream/g8kc.XXXXXX` and
is removed at exit (never inside the repository).

| leg | what |
| --- | ---- |
| `off/capture` | no `GRC_TEXTURE_CACHE_DIR`: the control (79 hooks, no cache block, no `texture-cache.json`) |
| `cold/capture`, `cold/cache/` | an empty cache directory: every decode derived and stored; the index and file listing afterwards |
| `warm/capture`, `warm-workers/capture` | a second session on that directory, synchronous and at `GRC_TEXTURE_WORKERS=2` |
| `prepare/`, `prepare/out/` | `scripts/prepare-textures.sh --list` over the fixture's imported `.ctex` files (not the 2048x2048 cost ones) into a second, empty directory; `out/evidence/texture-cache.json` is the prepare run's own view |
| `prepared/capture` | a session on the prepared directory |
| `bounded/capture`, `bounded/cache/` | `GRC_TEXTURE_CACHE_MAX_BYTES=60000` |
| `adopt-cold/capture`, `adopt-warm/capture` | gate8-adopt armed late (`GRC_ADOPT=arm`) twice on one directory |
| `uastc-cold/capture`, `uastc-warm/capture`, `uastc-{cold,warm}/cache/` | G8ku: `fixtures/gate8-basis` under `basis-uastc` (g8ku's wait frame) twice on one directory: every UASTC encode stored, then served |
| `uastc-prepare/dump`, `uastc-prepare/`, `uastc-prepare/out/`, `uastc-prepared/capture` | G8kf: the basis fixture's step-0 images saved as Image `.res` files (`RS_FIXTURE_DUMP_RES_DIR`, an unarmed run), `scripts/prepare-textures.sh --list` over them into an empty directory (its /9 basis-uastc sink, drained at stream end), then one basis-uastc session on that directory: zero encodes (`prepare-uastc-warm`) |
| `sabotage-corrupt/{capture,after/capture}`, `damaged.json`, `index-before.jsonl` | a copy of the warm cache with a flipped byte, a truncated file and a deleted file; then the session after the repair |

Criteria (`lib/gate8-cache-checks.ts`, driven by `test/self-test-gate8kc.ts`): `cache-off-identical`,
`cache-paths`, `cache-cold`, `cache-warm`, `prepare-key-match`, `cache-corrupt`, `cache-lru`, `prepare-uastc-warm` (G8kf),
`cache-adopt`; see [`../protocol/texture-delivery-design.md`](../protocol/texture-delivery-design.md)
"As built (G8kc)". `prepare-textures.sh --help` documents the prepare step.

## Gate 8 legs and evidence under `--out/g8l` (g8l, G8g)

One live leg per fixture at render-stream/8 (`../protocol/gate8-design.md` "As built (G8g)"), then
D14's reverse-proxy leg. `run-gate7.sh --live --legs g7-8` runs the same group with a browser
receiver (`GATE7_LIVE_KIND`); every receiver and replay leg below is then that browser.

| leg | what |
| --- | ---- |
| `<f>/host` (`tex`, `float`, `adopt`, `size`, `mat`) | headless at `--max-fps 60` under the fixture's own gate 8 policy (tex: g8t's decode; float: g8f's formats; adopt, size, mat: armed late at K=12 with `GRC_ADOPT=arm`, skip, and size's `presentation:640x360`); its /8 file sink and store, a live listener on `127.0.0.1:0`, `GRC_LIVE_AWAIT_HELLO_MS=60000`, `RS_FIXTURE_QUIT_FRAME=300` |
| `<f>/receiver` | rendered live receiver, `RS_RECEIVER_PROTOCOL=8` (subprotocol `render-stream.8`), `RS_RECEIVER_SHOT_FINAL=1` (`shots/final.png`), tap `received.rs8` |
| `<f>/replay` | the same receiver on the host's `recording.rs8` (`run_rendered_receiver`, its checkpoints) |
| `proxy/{host,proxy,receiver,replay}` | tex again; `proxy/` is `lib/reverse-proxy.ts` in front of the host (`ports.json`, `requests.jsonl`, `stats.json`), and the receiver connects to the proxy's port |

## Gate 8 criteria (g8l, G8g)

`lib/gate8-live-checks.ts`: `g8l-<f>-host` (published, listening, one connection at /8),
`g8l-<f>-live` (render-stream/8, no failure, final shot), `g8l-<f>-states` (every transaction of
`received.rs8` is the file sink's state at its frame; the last is the sink's final state),
`live-replay-equals-live-g8l-<f>` (the final image equals the replay's last checkpoint, exactly),
`g8l-<f>-replay-equals-file` (a native run with the file groups: the replay's checkpoints equal
the file group's honest receiver's), `g8l-proxy-fronted` (D14: the receiver's URL is the proxy's
port; one 101 upgrade and every GET, each 200, went through it; the final image equals tex's).

## Gate 8 legs and evidence under `--out/g8ku` (g8ku)

| leg | what |
| --- | ---- |
| `import/fixture` | the editor import of `fixtures/gate8-basis` |
| `capture` | headless, `GRC_STREAM_VERSION=9 GRC_TEXTURE_DECODE=engine GRC_TEXTURE_DELIVERY=basis-uastc GRC_TEXTURE_ENCODE_WAIT_FRAME=12`; both sinks, store (`<hash>.grt`, `<hash>.ktx2`) |
| `workers/capture` | the same at `GRC_TEXTURE_WORKERS=2` |
| `sabotage-perturb-ktx2/capture`, `.../receiver` | `GRC_TEXTURE_ENCODE_FAULT=perturb-ktx2` (one byte of each KTX2 flipped after hashing), and the native receiver under `upgrade`, which must refuse |
| `pending/capture`, `pending/receiver` | G8kf: `workers/capture` again with `GRC_TEXTURE_PENDING=publish` (a texture whose worker is not done goes out as `delivery-pending` and returns as `ok` at the next version), and the native receiver replaying it |
| `sabotage-corrupt-ktx2/capture`, `.../receiver` | G8kf: `GRC_TEXTURE_ENCODE_FAULT=corrupt-ktx2` (level 0 of each KTX2 damaged before hashing: every hash and header check passes, the transcode fails) and the native receiver under `upgrade`, which must fall back to `decoded` |
| `reference`, `reference-oracle`, `reference-oracle-hw` | rendered fixture: procedural; every stored KTX2 through `Image.load_ktx_from_buffer` (`oracle/oracle.json`, `oracle/<hash>.rgba`), its CPU decode drawn from step 1; and the same drawing the transcoded blocks (GPU-sampled) |
| `receiver`, `receiver-upgrade` | the native receiver, D6 `keep` and `upgrade` (`RS_RECEIVER_TRANSCODE_LOG=1`) |
| `live/host`, `live/receiver` | a /9 basis-uastc live host without the wait knob and the rendered native receiver at `RS_RECEIVER_PROTOCOL=9`; `live/host/ktx2-get.*` is one KTX2 GET with `Accept-Encoding: zstd` |
| `../g8ku-web/web`, `../g8ku-web/web-fallback`, `../g8ku-web/web-pending`, `../g8ku-web/web-masked` | the web export in headless Chromium on `receiver-upgrade`'s launch (its harness root beside `g8ku/`), (G8kf) on `sabotage-corrupt-ktx2/receiver`'s and `pending/receiver`'s, and (G8kwh) on `receiver-upgrade`'s with `s3tc,bptc,rgtc` masked |

## Gate 8 criteria (g8ku)

`basis-capture`, `ktx2-wire`, `delivery-lazy`, `delivery-keep`, `transcode-oracle`,
`delivery-reference` (exact), `quality-band`, `sabotage-perturb-ktx2`, `delivery-live`,
`delivery-web`, `delivery-pending` and `delivery-fallback` (G8kf), `delivery-pixels-web` and `delivery-web-masked` (G8kwh); each criterion is spelled out in `lib/gate8-basis-checks.ts` and
[`../protocol/texture-delivery-design.md`](../protocol/texture-delivery-design.md) "As built (G8ku)".

## Gate 8 criteria (g8m)

`g8m-legs`, `g8m-wire`, `shader-hash-parity`, `param-parity`, `adopt-cim-builtin`,
`adopt-equivalence`, `adopt-material-account`, `adopt-reference` (exact), `adopt-include-refused`,
`sabotage-adopt-raw-shader-code` and `sabotage-adopt-skip-params`; each criterion is spelled out in
`lib/gate8-mat-checks.ts` and [`../protocol/gate8-design.md`](../protocol/gate8-design.md) Q5 "As
built (G8m)".

## Gate 8 criteria (g8h)

`g8h-legs`, `late-size-match`, `late-size-reference` (exact), `late-size-needed`,
`late-size-equivalence`, `late-size-atlas`, `late-size-account`, `sabotage-size-before-adopt` and
`sabotage-size-before-adopt-strict`; each criterion is spelled out in `lib/gate8-size-checks.ts` and
[`../protocol/gate8-design.md`](../protocol/gate8-design.md) Q4 "As built (G8h)".

## Gate 8 criteria (g8a)

`g8a-legs`, `adopt-wire`, `adopt-equivalence`, `adopt-noop-at-birth`, `adopt-account`,
`adopt-thread-refused`, `adopt-no-scene-mutation`, `adopt-reference` (exact outside G8r's two
declared regions) and the three `sabotage-adopt-*` checks; G8r adds `adopt-resources-account`,
`adopt-resources-workers` and `fault-no-resources`, `fault-atlas-from-dummy`, `fault-claim-current`.
Each criterion is spelled out in `lib/gate8-adopt-checks.ts` and
[`../protocol/gate8-design.md`](../protocol/gate8-design.md) Q2 "As built (G8a)" and "As built
(G8r)".

## Gate 8 criteria (g8t)

`g8t-import`, `decode-census`, `decode-oracle`, `decode-wire`, `decode-off`, `decode-reference`
(exact), `sabotage-perturb-decode`, `decode-cost` (measured, no budget) and the informative,
non-gating `decode-hardware-band`; each criterion is spelled out in `lib/gate8-tex-checks.ts` and
[`../protocol/gate8-design.md`](../protocol/gate8-design.md) Q3 "As built (G8t)". G8kw adds
`worker-states-equal`, `worker-hook-log`, `sabotage-publish-before-ready` and the timing check
`worker-hook-time` (≤ 2 ms on the calling thread per 2048² create);
[`../protocol/texture-delivery-design.md`](../protocol/texture-delivery-design.md) "As built (G8kw)".
