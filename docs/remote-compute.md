# Remote compute for long validation runs

Status: **implemented**, 2026-10-23. The rungs R0–R4 landed on `main`:

| Rung | What it moved | Commits |
| --- | --- | --- |
| R0 | Pure self-tests, cargo crates, `capture-build`, `pnpm test`, toolchain builds | 0230907c, 40021ac1, d6ffe1a8, 0e11f3fc |
| R1 | Gate 0 on a software rasterizer | 3489dd79 |
| R2 | Native gates −1, 1, 2, 3, 4, 5 and 5.5 | c78ea103 |
| R3 | Gate 7 browser correctness | 88019d65 |
| R4 | Instruction-count benches for the Rust core | 1dc35f80 |

See [Status and what stays local](#status-and-what-stays-local) for measured times and limits.
The assessment below dates from 2026-10-22 (`24ec89be`). The R1–R4 sections record what each rung
found.

## Goal

- **Offload:** take validation load off the development machine. It is also used for other work, and
  that load skews timing legs. The quiet lock only coordinates with this repo (`g7r-pacing-facts`).
- **Faster wall time:** fan legs out across parallel remote machines.
- **Consistent benchmarks,** where this is achievable.
- **Callable by a worker agent mid-increment,** as a drop-in for a local `validate-increment.sh` run.

Not a goal: CI on pull requests, status checks or merge gates. GitHub Actions is used here only as an
on-demand compute farm, dispatched by us and read back by us. No `pull_request` trigger exists, so
the fork and self-hosted concerns in [contribution-review.md](contribution-review.md) do not apply.

No extra hardware: no spare machine is available, and buying one is out of scope.

## Why it is worth doing

- **Agent time:** 75% of measured agent time is spent waiting on validation runs (`agent-time-breakdown`,
  2026-10-20). In G7hp, an ~80-line change, 73 of 98 minutes were g7-1 file and live runs.
- **Sweep time:** the pre-G7v milestone sweep took 19,966 s (5.5 h) at `-j 2` with `RS_LEG_SHARDS=2`
  (`sweep-pre-g7v`). Much of that wall time is waiting on the quiet lock, not work:
  - g7-web-rust waited 18 ks for 7.7 ks of hold.
  - G7o3 spent ~2.9 h of 8.7 h in lock dead time (`gate-runtime-speedups`).
- Parallel machines remove the lock wait entirely, because each leg owns its VM.

## What free GitHub Actions gives a public repo

Checked 2026-10-22 against the [limits](https://docs.github.com/en/actions/reference/limits),
[billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions) and
[runner](https://docs.github.com/en/actions/reference/runners/github-hosted-runners) docs:

| Item | Free, public repo |
| --- | --- |
| Minutes | Unlimited on standard runners |
| Concurrency | 20 jobs (5 macOS) |
| Runner | 4 vCPU, 16 GB RAM, ~14 GB free SSD; x64 and arm64 |
| Job / run limit | 6 h per job; 35 days per run; matrix ≤ 256 jobs |
| Cache | 10 GB per repo |
| Artifacts | 90-day maximum retention |
| GPU | **None.** The T4 runner is paid (~$0.052/min) and needs an organization on Team/Enterprise |

A planned $0.002/min charge for self-hosted runners was announced on 2025-12-16 and then postponed
([changelog](https://github.blog/changelog/2025-12-16-coming-soon-simpler-pricing-and-a-better-experience-for-github-actions/)).
It would not have applied to public repos either way, and self-hosting needs hardware we don't have.

## Why the sweep cannot simply move

This was the assessment before R1–R3. The GPU parts are now handled by the CI-only
software-renderer modes described below. The NVIDIA track stays the local default and the pixel
authority.

- **Browser legs need a real NVIDIA GPU.**
  - `experiments/render-stream/scripts/lib/browser-harness.ts:389` refuses any renderer that does
    not name ANGLE, NVIDIA and Vulkan together, and `:1335` fails on SwiftShader, llvmpipe or other
    software rasterizers.
  - The pixel baselines were taken on this machine's RTX 2060.
- **Native rendered legs need a Vulkan device.**
  - They run `--rendering-driver opengl3 --display-driver x11` (`lib/legs.sh:761`) inside
    `gamescope --backend headless`, which picks a Vulkan device.
  - `lib/gamescope.sh` never falls back to Xvfb locally.
  - gamescope cannot run on lavapipe: 3.16.19 stops at "physical device doesn't support
    VK_EXT_physical_device_drm", because its headless backend needs a DRM-backed device (R1, run
    39764689493). Hosted runners therefore use a CI-only `RS_DISPLAY_MODE=xvfb-llvmpipe` display
    instead (see "Software-raster gate 0" below).
- **Pinned inputs live outside the repo.** All are sha-pinned and must be provisioned and cached per
  runner:
  - The 4.5.1 `linux_release.x86_64` template.
  - `web_dlink_nothreads_release.zip`, cut from the 1.36 GB `.tpz`.
  - The mise Godot editor.
  - emsdk 4.0.11.
  - Rust stable plus `nightly-2025-10-15`, with `-Zbuild-std`.
  - wasm-bindgen 0.2.129.
  - Chrome for Testing 148 (chromium-1223).
  - The gate 4 fonts from `../godot-4.5.1-stable`.
- **Disk.**
  - Sweep evidence is 17 GB+ and the source cache is 14–15 GB (`disk-space-artifacts`).
  - A runner has ~14 GB free, so each shard must prune as it goes and upload only verdicts plus
    failing-leg evidence.
- **Timing legs are load-sensitive by design.** That covers:
  - g6l, g6s, g6c, g6p.
  - g7-6 timing, g7-lc, g7-r, g7-k.
  - g7-bench and the lock self-tests.

## Verdict by family

| Family | Remote? | What it takes |
| --- | --- | --- |
| Pure self-tests, cargo crates, builds, `pnpm test` | **Yes (R0)** | Toolchain setup plus a cache of the pinned inputs; `pure` is sharded 6 ways |
| Native gates −1..5.5 correctness | **Yes (R1, R2)** | CI-only Xvfb + llvmpipe; no own baselines were needed. Their timing groups (g1c-rate, g1d, g2c-pins, g5f, g55f) stay local |
| Rust core instruction counts | **Yes (R4)** | cachegrind `Ir` against a committed baseline, 1% threshold |
| Gate 7 file/live correctness (browser) | **Yes (R3)** | Chromium on ANGLE-Vulkan over lavapipe, a CI-only provenance mode; no own baselines were needed. Live g7-1/g7-2 stay local. The NVIDIA track stays authoritative. |
| Gate 6 and gate 7 timing legs, perf benches | **No** (wall-clock) | Stay local; see below |
| Phone legs (g31) | **No** | The device is attached to this machine |
| STS2 game, recovered project, spirectl fonts | **Never** | Proprietary |

A software rasterizer proves the pipeline and wire format, not NVIDIA pixel parity. The local NVIDIA
run stays the authority for pixels. A remote green means "safe to spend a local GPU run on", not
"landed".

## Software-raster gate 0 (R1, 2026-10-22)

- **Display:** `RS_DISPLAY_MODE=xvfb-llvmpipe` in `lib/gamescope.sh` `gs_start`.
  - Xvfb runs under `setsid`, with the display number from `-displayfd` and the same globals, pid +
    start-ticks identity and socket-ownership proof. `gamescope.json` records `"backend":"xvfb"`.
  - It refuses to start unless `GITHUB_ACTIONS=true` and `RUNNER_ENVIRONMENT=github-hosted`.
  - Godot's `opengl3` renders on Mesa llvmpipe ("OpenGL API 4.5 (Core Profile) Mesa 25.2.8 ... llvmpipe
    (LLVM 20.1.2, 256 bits)"). The rs-setup `swrast` input installs it and writes
    `swrast-provenance.json` (CPU model, Mesa and LLVM versions); the run adds Godot's GL string.
- **Determinism:** `scripts/remote-validate.sh --only native-rust-gate0 --tier full --paths
  experiments/render-stream/scripts/run-gate0.sh --determinism 3,1` runs gate 0 three times on one
  runner and once on another. `lib/remote-determinism.ts` then compares every shot by sha256, and
  every dump under `canonicalEqual` with the run-volatile fields masked.
  - Result: every run passed gate 0, every one of the 60 shots was byte-identical across all four runs
    and every dump agreed. This held in two acceptance runs (39765496604, 39766507305) on three host
    CPUs: an Intel Xeon Platinum 8573C, an AMD EPYC 9V45 and an AMD EPYC 7763. llvmpipe ran at its
    default thread count; no Mesa knob was needed.
  - The 30 shots that local runs also take (sabotage legs skipped) are byte-identical to the local
    RTX 2060's as well. Gate 0 needs no separate swrast baseline.
- **Cost:** a gate 0 run takes ~40–60 s on a runner. Locally it takes ~2 min, plus the quiet-lock wait.

## Software-raster native gates (R2, 2026-10-22)

Gates −1, 1, 2, 3, 4, 5 and 5.5 run on the same Xvfb + llvmpipe route, one matrix job per gate
(`native-rust-<gate>`, `RS_LEG_SHARDS=2` on 4 vCPU, gate 4 with the font checkout, every native job
with the receiver project's `--import`).

- **Result:** `scripts/remote-validate.sh --milestone --only <the seven> --determinism 2,1` passed 7/7
  (every sabotage leg included) and every gate's three runs agreed (run 39776739430, four host CPU
  models: EPYC 7763, EPYC 9V74, Xeon 8573C, Xeon 8370C). Dispatch to summary: 676 s. Job wall per gate for
  one run: −1 52 s, 1 89 s, 2 188 s, 3 83 s, 4 224 s, 5 135 s, 5.5 170 s; setup 44–272 s (a cold cache
  restore is the long end).
- **No `swrast` pixel baselines or checker-model tables were needed.** The within-run exact-pixel
  checks (receiver against reference, oracle against shots) are the authority, and they hold on
  llvmpipe: the G55b RGB10_A2 alpha, the G5b hand-lowered raster and every readback model pass
  unchanged. Should one ever differ, add a table keyed by `swrast-provenance.json`, beside the NVIDIA
  one.
- **Timing groups stay local.** `RS_SKIP_TIMING_GROUPS=1` (set only by the workflow) skips
  `g1c-rate`, `g1d`, `g2c-pins`, `g5f` and `g55f`: each leg directory gets `skipped-remote.txt`,
  `lib/tier-verdict.py` excuses the checks about those legs (named in id, detail or criterion), and
  `validate-summary.json` lists them as `skipped_remote[]`. The wrapper prints each skipped group with its
  local command (`run-gate1.sh --legs g1a,g1d`, ...).
- **Live legs and determinism.** A live leg names its shots by the wire seq they landed at, which follows
  the credit loop's timing (and differs run to run on NVIDIA too). `lib/remote-determinism.ts`
  therefore compares such a directory as a content set (distinct images and masked states must be
  equal across runs) and lists its `applied.json` as live-timed instead of comparing transaction
  boundaries; file-mode legs stay compared file by file. All 12 gate 2 and 6 gate 1 live sets matched.
- **`--only X` when the plan does not reach X:** `validate-increment.sh` warns, `remote-validate.sh`
  fails (rc 2) naming `--paths` and `--milestone`; a job whose run never executed merges as `missing`.

## Gate 7 browser correctness on lavapipe (R3, 2026-10-22)

- **Decision 10, the renderer allowance:** `RS_BROWSER_PROVENANCE=lavapipe` (`lib/browser-renderer.ts`)
  lets a browser leg render on Chromium's ANGLE-Vulkan over Mesa lavapipe, with
  `--ignore-gpu-blocklist` (without it the page gets no WebGL2).
  - It applies only on a GitHub-hosted runner (`GITHUB_ACTIONS=true`,
    `RUNNER_ENVIRONMENT=github-hosted`). Set anywhere else, it is a hard error.
  - Every leg's `provenance.json` records it. Locally every leg must still be ANGLE + NVIDIA +
    Vulkan, and the SwiftShader sabotage is refused under both rules.
  - SwiftShader was tried and rejected: it is deterministic, but it misses the gsw AA/MSDF bands and
    the web line edges.
- **No baselines of its own.** The NVIDIA checker models hold unchanged, because the native sources
  render on the same llvmpipe (R2). The file groups g7-0..g7-6 pass for both receivers (gsw, web-rust)
  with their sources' timing groups skipped.
- **Determinism:** `--determinism 2,1` runs each group three times on two runners.
  - gsw: every file group agreed over three runs (2,506 shots and every dump, run 39852773945).
  - web: every file group agreed (1,762 shots, run 39842615880) once a web pck is compared by content.
    Godot 4.5.1's web export writes the same 17 entries but in a data order that varies by machine,
    so `receiver.pck`'s sha256 (the dumps' `receiver.build_sha256`) drifts with no content change.
    `lib/remote-determinism.ts` maps each raw digest to the pck's content digest
    (`godot-pck.ts pckContentDigest`: sorted path, size, md5, recorded in `build.json` as
    `pck.content_sha256`). It reports raw drift as information; a content difference still fails.
  - Live g7-5 and g7-55: an animated leg (g5f's live-mesh, g55f's live-shader, g2c's live-animate)
    catches a different animation frame per settle in each run, so its images and states differ
    together. Such a set is compared as a function from state to image: every state applied in two
    runs must render the same.
- **Live groups.** g7-5 and g7-55 run remotely (their rate group g1c-rate skipped).
  - g7-1 and g7-2 stay local (`smoke-map.json` `remote.refuse.groups`). Each failed a check
    intermittently at credit window 2 on 4 vCPU, and neither check is loosened:
    - g7-2: the drop-resource and no-cors failure seq. Two transactions arrived in one poll and were
      folded, so the failure landed at the other seq. Seen only on runners: load-sensitive.
    - g7-1: `resync-full`. A patch was already in flight when the host logged the resync. This also
      failed once on local NVIDIA at main 2431d26f's code, so it is a G7wd model gap for main to
      fix, not a runner artifact.
  - A full-tier `g7live-*` run keeps its other groups remotely. `--and-local` runs the refused
    groups locally with `RS_VALIDATE_GROUPS`.
- **Environment fixes:**
  - the browser daemon gets `RS_BROWSER_PROVENANCE` back after `gs_strip_env_args`;
  - Chromium's system libraries survive a broken third-party apt source;
  - every failing repeat's evidence is uploaded.
- **gsw g7-5 `receiver-vs-reference`:** gate 5 reports that id twice (g5d's file legs, then g5f's live
  legs). The gsw fold now judges the gate's own first check (`gate7-gsw.ts judgedCheck`), so the gsw
  file-leg comparison is gated. Before, g5f's check shadowed it, which also forced a remote run to
  excuse the whole check.
- **Known, pre-existing:** on NVIDIA, gsw g7-5's non-gating `gsw-vs-native@gsw` (2478 px, max delta 1
  on every mesh shot) and `compositor-equals-readback-g5-mesh@gsw` fail identically on main and in
  every gsw g7-5 run since G7t (2026-10-15).

## Consistent benchmarks

Hosted VMs are noisier than this machine, not quieter:
- CodSpeed measured a 2.66% coefficient of variation in wall time across runners
  ([post](https://codspeed.io/blog/benchmarks-in-ci-without-noise)).
- Projects report up to 1.9× swings on short benchmarks.

Moving wall-clock benchmarks to hosted runners would make them worse. What does work remotely:

1. **Instruction counts,** via cachegrind/callgrind: ~0.3% run-to-run spread. This fits the
   CPU-bound Rust core decode/apply work that g7-bench times today, and gives a regression signal
   that load cannot touch.
2. **Interleaved A/B inside one job,** on the same VM. This is the relational style
   [perf-harness.md](perf-harness.md) already requires.
3. **Fan-out repeats:** N repeats on N runners, gated on the median or an interval rather than a
   single number.

### Instruction counts for the Rust core (R4, 2026-10-23)

- **Bench:** `rs-core-bench-instr` (cargo feature `bench-instr`, off by default, so the library and
  wasm builds are unchanged) decodes and applies one committed golden recording per process.
  `scripts/bench-instr.sh` builds it on rustc 1.95.0 with no RUSTFLAGS, runs it under
  `valgrind --tool=cachegrind --cache-sim=no`, writes `bench-instr.json` and compares against
  `benches/instr-baseline.json`. Cases (all self-contained, inline payloads): `g3-inline`,
  `g4-inline`, `g5-inline`, `g6-inline` (the scene-sized one), `g6-snap`, `g7-window2`. The
  `full`/`patch` goldens need a payload store and are not cases.
- **Run id:** `bench-instr` (setup phase, not timing, remote-capable; rs-setup `valgrind` input
  installs the Ubuntu package). The tier verdict has one check per case. Locally it exits 3 when
  valgrind is not installed.
- **Noise (three runners, one binary, same sha256 on all of them):** AMD EPYC 7763, AMD EPYC 9V45
  and Intel Xeon Platinum 8573C differ by at most 0.29% on a case (g5-inline 92.64-92.91 M,
  g6-inline 110.21-110.50 M, g3/g4 below 0.04%, snap/window2 identical). That is CPU-feature
  dispatch (memchr/sha2), not run-to-run noise: the same runner type repeats exactly. One baseline
  (the median) and a 1% threshold per case therefore hold on every runner type seen, with 3x margin
  over the spread. A new CPU family that exceeds 1% would get `threshold_pct` on the affected case.
- **Sabotage proof:** one extra pass over each /5 record in `Validator::accept` moved only
  `g5-inline`, 92908617 to 95073722 Ir (+2.33%, fail); the other cases moved under 0.03% (code
  layout). Reverting it passes.
- **In the summary:** the `bench-instr` row of `validate-summary.json` (passing or failing) carries an
  additive `bench_instr` key: `{cpu_model, baseline_cpu_model, cases: [{case, ir, baseline_ir,
  delta_pct, threshold_pct, status}]}`, built by `lib/validate-summary.py` from `run/result.json`
  (whose checks now also keep those four numbers; `tier-verdict.py` ignores them) and
  `run/bench-instr.json`. The key is omitted when there is no `result.json` (valgrind missing, build
  failed). With `--determinism`, the repeats fold into one row: the first repeat's block stays on
  top and `bench_instr.repeats` lists every repeat's `{cpu_model, cases}`. The wrapper prints one
  `bench-instr: <case> Ir N (+x% vs baseline, cpu ...)` line per case. No workflow change: the key
  rides on the row.
- **Local:** this machine has no valgrind, so the remote job is the only producer; the script
  names the missing tool and exits 3 rather than skipping.

None of these covers GPU frame time, frame pacing or the phone. Those stay local and still need a
quiet machine (`uptime`), as today.

## Agent-callable interface

The primary consumer is a worker agent (e.g. `rs-increment`) mid-task. It takes the same planning
flags as `validate-increment.sh`; the full list is in the script header:

```bash
scripts/remote-validate.sh [--base main] [--tier smoke|full] [--only id,id] [--paths p1,p2] \
  [--milestone] [--and-local] [--determinism 3,1] [--no-wait | --collect RUN_KEY] [--dry-run]
```

1. **Plans locally** with `validate-increment.sh --plan`, then splits the runs.
   - Remote-capable runs come from the `smoke-map.json` `remote` table.
   - Always refused: timing-phase runs, `lock-tests`, `g7x` and device legs. The live groups g7-1
     and g7-2 are refused per group.
   - `--and-local` runs the refused ones through local `validate-increment.sh` while the remote run
     is in flight.
   - A requested `--only` id that the plan does not reach is an error (rc 2), not a silent pass.
2. **Snapshots** the worktree state, uncommitted edits included, as a throwaway commit built with a
   temporary `GIT_INDEX_FILE`. The worktree's branch, HEAD and index stay untouched.
3. **Pushes** only `<sha>:refs/heads/remote-run/<worktree>-<shortsha>`.
4. **Dispatches** `.github/workflows/remote-validate.yml` **on that run branch**. GitHub only
   requires the workflow file to exist on `main`; the definition that runs is the snapshot's own.
   The workflow fans out one matrix job per run id, with `pure` in 6 shards and gate 7 one job per
   group. Each job calls `validate-increment.sh --only <id>` with the same base and tier.
5. **Waits** with `gh run watch`, which works under a background Bash call. It then downloads only
   the merged `validate-summary.json` and the failing runs' evidence into
   `artifacts/render-stream/remote/<UTC>/`, and exits non-zero when any run failed.
   - The summary has the local shape plus a `remote{run_url, sha, run_key, setup_s, refused,
     skipped_remote}` block, built by the same `lib/validate-summary.py`.

Rules:

- **The runner logic travels with the snapshot.** A worktree can change the workflow by dispatching
  its own run branch. Changes only need `main` (and a push) when the janitor, the seed workflow or
  an action allow-list entry must change.
- **Timing legs are refused** or handed to local `validate-increment.sh`, so no agent gets a
  noisy-VM timing number without noticing.
- **Contention:** the 20 concurrent jobs are shared by all agents, and one dispatch uses at most
  10 (`max-parallel`). Each worktree gets one `concurrency` group, so a new dispatch from the same
  worktree cancels its previous one. Two parallel dispatches from one worktree therefore don't work;
  run them one at a time.
- **Allowed actions:** the repo allows only GitHub-owned, owner-owned and `pnpm/action-setup`
  actions. Every other tool is installed by a shell step with a sha check in
  `.github/actions/rs-setup`.
- **Caches are saved only from `main`.** An Actions cache saved on a run branch is invisible to
  every other branch. `remote-cache-seed.yml` (dispatch and weekly) saves them; run branches only
  restore.

### Run branches never accumulate

Pushing is acceptable here only if the branches clean themselves up. Three layers:

1. A final workflow job with `if: always()` and `contents: write` deletes its own run branch.
2. The wrapper deletes the branch on cancel or a failed dispatch, via a shell trap.
3. A scheduled janitor workflow, every 6 h, deletes any `remote-run/*` branch older than 24 h.

A deleted run commit survives only as an unreachable object on GitHub. Run branches cannot publish
anything, because `publish.yml` fires only on `v*` tags. The no-push rule is policy (CLAUDE.md), not
blocked by `scripts/claude-guard-bash.sh`. The wrapper is the one sanctioned push path, and it pushes
as a child process the guard never sees, so the guard warns (never blocks) on any literal `git push`,
with stronger text for main, tags, force and bare pushes. Codex users re-trust the hook via `/hooks`
after a guard edit.

All three layers were seen working on real runs (R0):
- the cleanup job deleted every run branch;
- SIGINT on the wrapper cancelled the run (rc 130) and deleted its branch;
- a janitor dispatch deleted a ref aged 3 days and nothing else.

The logic is covered synthetically by `scripts/test-remote-validate.sh` (112 checks).

Rejected transports:

- **Hidden custom refs** (`refs/runs/*`): GitHub support is unverified.
- **A `git bundle` as a release asset or gist:** a second store to clean up.
- **A separate "runs" repo:** needs `main` synced plus a second token.
- **A private runs repo:** only 2,000 free minutes, on 2-vCPU runners.

## Other services

| Service | Note (2026-10-22) |
| --- | --- |
| GitLab for Open Source | 50k compute min/month by application; GPU runners are Premium/Ultimate only |
| Blacksmith | OSS program; 3k free min/month |
| Oracle Always Free | Ampere A1 cut to 2 OCPU / 12 GB on 2026-06-15 ([InfoQ](https://www.infoq.com/news/2026/07/oracle-cloud-free-tier-limits/)); idle instances reclaimed |
| Firebase Test Lab / AWS Device Farm | Small free quotas; no substitute for the g31 perf numbers |
| Cirrus CI, Equinix Metal | Shut down 2026-06-01 and 2026-06-30 |
| Hetzner (paid, reference) | Dedicated €46–100/month without GPU; GEX44 GPU €232/month |

GitHub Actions is the best free option, and none of these changes the GPU or phone constraints.

## Status and what stays local

Measured 2026-10-22/23. Remote and local runs were at the same sha and agreed on pass/fail for
every run. Local times include quiet-lock waits behind other agents' timing legs. The machine load
is given for each.

| Run set | Remote (dispatch → summary) | Local |
| --- | --- | --- |
| pure, pnpm-test, cargo-*, capture-build (R0b) | ~225 s | 2,475 s (load 7→16) |
| Same set before sharding `pure` (R0a) | 1,008 s | 1,319 s (load 8–10) |
| Toolchain builds: rs-core-ext, gsw wasm, rs-core web, web receiver | 177 s | 626 s |
| Native gates −1..5.5 (R2) | 676 s | 4,215 s (load 14) |
| Gate 0 alone (R1) | 40–60 s per run | ~2 min + lock wait |
| Gate 7 file groups + live g7-5/g7-55 (R3) | slowest job 867 s (gsw), 1,160 s (web); plain live dispatch 552 s | 4,666 s at `-j 2` (load 3.7–14) |
| bench-instr (R4) | ~37 s per run | no valgrind here |

A `--determinism 2,1` dispatch of all of gate 7 takes 22–70 min, because it runs every group three
times through 10 parallel slots. Use it once per change to the renderer or the checkers, not while
iterating.

**Setup overhead per job:**
- warm caches: 21–34 s;
- native and gate 7 jobs: 44–97 s, because they also install Mesa/Xvfb and import the project;
- the first run after a seed misses: up to ~270 s.

**Cache:** ~810 MB of the 10 GB, 7 entries, all saved on `main`:

| Entry | Size |
| --- | --- |
| emsdk | 492 MB |
| pnpm store | 144 MB |
| capture build | 111 MB |
| godot templates (the two extracted files, never the `.tpz`) | 34 MB |
| cargo registry | 19 MB |
| rs-core-ext | 3 MB |
| wasm-bindgen | 2 MB |

**Stays local, and why:**

| What | Why |
| --- | --- |
| Gate 6 and the gate 7 timing legs (g6l, g6s, g6c, g6p, g7-6 timing, g7-lc, g7-r, g7-k, g7-bench) and the lock self-tests | Wall-clock measurements; hosted VMs are noisier than this machine |
| The timing groups inside correctness gates (g1c-rate, g1d, g2c-pins, g5f, g55f) | Same reason. They are skipped remotely, and the wrapper prints their local commands |
| Live g7-2 | Load-sensitive on 4 vCPU runners: two transactions folded into one poll |
| Live g7-1 | Its `resync-full` check fails intermittently at credit window 2 on NVIDIA as well, since G7wd (2431d26f). That is a model gap on `main` to fix first |
| Phone legs (g31) | The device is attached to this machine |
| NVIDIA pixel authority | A remote green on llvmpipe/lavapipe means "safe to spend a local GPU run on", not "landed". Llvmpipe has matched the RTX 2060 byte for byte so far, but that is evidence, not the contract |

Risks that remain:
- **Runner image updates** can change Mesa, so each run records its `swrast-provenance.json` /
  `provenance.json`. Read those first if a remote-only pixel failure appears.
- **The Godot 4.5.1 web export is not byte-reproducible across machines.** Packs are compared by
  content digest.
- **Queueing** when several agents dispatch at once.

Possible next steps (not started):
- fix g7-1's window-2 model on `main`, then move g7-1 remote.

## Sources

Retrieved 2026-10-22: GitHub Actions [limits](https://docs.github.com/en/actions/reference/limits),
[billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions),
[runners](https://docs.github.com/en/actions/reference/runners/github-hosted-runners),
[larger runners](https://docs.github.com/en/actions/reference/runners/larger-runners) and
[secure use](https://docs.github.com/en/actions/reference/security/secure-use);
[CodSpeed on CI noise](https://codspeed.io/blog/benchmarks-in-ci-without-noise);
[luma.gl SwiftShader WebGPU recipe](https://github.com/visgl/luma.gl/issues/2874);
[GitLab OSS program](https://docs.gitlab.com/ee/subscriptions/community_programs.html);
[Equinix Metal shutdown](https://docs.equinix.com/goodbye-metal/);
[Hetzner price adjustment](https://docs.hetzner.com/general/infrastructure-and-availability/price-adjustment/).
