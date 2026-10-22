# Remote compute for long validation runs

Status: recommendation, not implemented. Assessed 2026-10-22 at `24ec89be`.

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

- **Browser legs need a real NVIDIA GPU.**
  - `experiments/render-stream/scripts/lib/browser-harness.ts:389` refuses any renderer that does
    not name ANGLE, NVIDIA and Vulkan together, and `:1335` fails on SwiftShader, llvmpipe or other
    software rasterizers.
  - The pixel baselines were taken on this machine's RTX 2060.
- **Native rendered legs need a Vulkan device.**
  - They run `--rendering-driver opengl3 --display-driver x11` (`lib/legs.sh:761`) inside
    `gamescope --backend headless`, which picks a Vulkan device.
  - `lib/gamescope.sh` deliberately never falls back to Xvfb.
  - Whether gamescope runs on lavapipe is untested.
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
| Pure self-tests, cargo crates, builds, `pnpm test` | **Yes, now** | Toolchain setup plus a cache of the pinned inputs |
| Native gates −1..5.5 correctness | **Maybe** | A determinism spike on a software rasterizer, then a separate `swrast` baseline set |
| Gate 7 file/live correctness (browser) | **Maybe** | A SwiftShader/lavapipe provenance mode with its own baselines. The NVIDIA track stays authoritative. |
| Gate 6 and gate 7 timing legs, perf benches | **No** (wall-clock) | Stay local; see below |
| Phone legs (g31) | **No** | The device is attached to this machine |
| STS2 game, recovered project, spirectl fonts | **Never** | Proprietary |

A software rasterizer proves the pipeline and wire format, not NVIDIA pixel parity. The local NVIDIA
run stays the authority for pixels. A remote green means "safe to spend a local GPU run on", not
"landed".

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

None of these covers GPU frame time, frame pacing or the phone. Those stay local and still need a
quiet machine (`uptime`), as today.

## Agent-callable interface

The primary consumer is a worker agent (e.g. `rs-increment`) mid-task. The proposed shape:

```bash
scripts/remote-validate.sh --legs g7-1,g0 [--tier smoke|full] [--wait]
```

It mirrors `validate-increment.sh` and does four things:

1. **Snapshots** the worktree state, uncommitted edits included, as a throwaway commit built with a
   temporary `GIT_INDEX_FILE`. The worktree's branch, HEAD and index stay untouched.
2. **Pushes** only `HEAD:refs/heads/remote-run/<worktree>-<shortsha>`.
3. **Dispatches** the remote workflow from `main` with `gh workflow run`, passing `sha`, `run-id`
   and the leg list as inputs. The workflow fans out one matrix job per gate, leg group, receiver or
   shard.
4. **Waits** with `gh run watch`, which works under a background Bash call. Then it runs
   `gh run download` for only the verdict JSON and failing-leg evidence, and writes the same
   `validate-summary.json` shape so `lib/tier-verdict.py` and agents read it unchanged.

Rules:

- **Workflow definition from `main`:** a worktree cannot change the runner logic. Changes to the
  remote workflow itself land on `main` first.
- **Timing legs are refused** or handed to local `validate-increment.sh`, so no agent gets a
  noisy-VM timing number without noticing.
- **Contention:** the 20 concurrent jobs are shared by all agents. Each worktree gets one
  `concurrency` group, where a new run cancels the old one. Expect queueing when several agents fan
  out at once.

### Run branches never accumulate

Pushing is acceptable here only if the branches clean themselves up. Three layers:

1. A final workflow job with `if: always()` and `contents: write` deletes its own run branch.
2. The wrapper deletes the branch on cancel or a failed dispatch, via a shell trap.
3. A scheduled janitor workflow, every 6 h, deletes any `remote-run/*` branch older than 24 h.

A deleted run commit survives only as an unreachable object on GitHub. Run branches cannot publish
anything, because `publish.yml` fires only on `v*` tags. The no-push rule is policy (CLAUDE.md), not
enforced by `scripts/claude-guard-bash.sh`. The wrapper becomes the one sanctioned push path, and the
guard could be taught to warn on any other `git push`.

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

## Recommended path

1. **Remote tier for GPU-free families.** Low effort. One `workflow_dispatch` workflow plus
   `scripts/remote-validate.sh` with its cleanup layers, running the pure self-tests, cargo crates,
   builds and `pnpm test`. Pinned inputs are cached by sha (extracted files only, not the `.tpz`).
   - Payoff: that CPU load leaves this machine and the run plumbing gets proven on cheap legs.
2. **Software-raster spike,** about a day.
   - Run gate 0 on a hosted runner under lavapipe: gamescope if it starts, otherwise a CI-only
     Xvfb + llvmpipe display.
   - Do three runs on one runner and one on another.
   - Accept only if the dumps match canonically (`g7xd-rust-default-facts`) and the shots are
     byte-stable run to run.
3. **`swrast` baselines and the matrix,** only if step 2 passes.
   - Add a provenance mode beside the NVIDIA one, with its own expected shots.
   - Use one matrix job per gate, leg group, receiver or shard.
   - Estimate: the correctness legs are roughly 70% of a sweep (~13.8 ks of 20 ks, lock wait
     included). They could finish in tens of minutes of wall time, leaving the ~1.7 h timing phase
     local.
4. **Instruction-count benches** for the Rust core, so CPU regressions can be judged remotely.

Risks:
- A second baseline set is ongoing maintenance.
- A software rasterizer may expose nondeterminism that the GPU hides.
- Per-job setup costs minutes, and is bounded by the 10 GB cache.
- Queueing when several agents fan out at once.

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
