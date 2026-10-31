---
name: rs-increment
description: Implement one render-stream gate or gate-7 increment in its own worktree — capture hooks, wire codecs, a receiver leg, or a browser/device bench. Use for any scoped render-stream increment that lands as one commit on main.
tools: Bash, Read, Edit, Write, Grep, Glob, Agent
---

# render-stream increment work

You implement exactly one gate or gate-7 increment (one row of
`experiments/render-stream/protocol/gate7-design.md`'s increments table, or one gate's work
package) in a dedicated worktree, and land it as one commit on `main`.

## Setup

```bash
# From the main checkout, create and enter an isolated worktree.
scripts/create-worktree.sh <increment-name>
cd .worktrees/<increment-name>
mise trust mise.toml
experiments/render-stream/scripts/build-capture.sh
mise exec -- godot --headless --path experiments/render-stream/receiver --import
experiments/render-stream/scripts/build-rs-core-ext.sh
```
The `--import` step is required once per fresh worktree — without it every `class_name` reference
in the receiver degrades to `Variant` and every `--script` run fails with parse errors that look
like a code bug but are not.

`build-rs-core-ext.sh` is required once per fresh worktree too: the Rust core is the native
receiver's only core (G7gd removed the GDScript one), so *every* native receiver launch loads
`receiver/ext/rs_core.gdextension` — a GDExtension built from `rs-core-capi`, not a checked-in
binary. Without this step, even a plain
`run-gate0.sh` fails every leg with `RS_RECEIVER_CORE=rust, but the adapter is unavailable`
(`GDExtensionManager.load_extension` returns a nonzero error), which looks like a receiver bug
but is a missing one-time build.

Browser legs launch the pinned Chromium from `~/.cache/godot-render-stream/ms-playwright/`, a
repo-private copy that other repos' `playwright install` cannot garbage-collect. The first browser
launch on a machine seeds it by copying Playwright's shared `~/.cache/ms-playwright/chromium-1223/`
(sha-checked against the pin), so there is nothing to do unless the harness reports that neither
copy matches; then restore one of them with the pinned build (don't download a different one).

## Commit rules

One squash commit on current `main` when the increment is finished and verified — don't ask.
Conventional Commits: `type(scope)!: imperative subject`, subject ≤72 chars, no trailing period;
body prose ≤100 cols. `type` is `feat`/`test`/`docs` with scope `render-stream` and
`Changelog: none` for anything confined to `experiments/render-stream`; a real one-sentence
`Changelog:` line only when the increment also changes a published `packages/*` export. Verify
with `scripts/githooks/commit-msg` before committing (it only enforces on `main`, so test with
`COMMIT_HOOK_BRANCH=main scripts/githooks/commit-msg <msgfile>` from the branch). Never push,
never tag.

## Safety rules

Rendered Godot runs only headless through this experiment's own runners, which use a private
`gamescope --backend headless` session — never launch a headed Chromium or Godot window, and
never wrap a runner in `xvfb-run` (it does not reliably isolate on Wayland and the guard blocks
nested `xvfb-run` anyway). Never touch `~/.steam` or launch a real game. Never `git push` or create
a tag. Don't download anything beyond what the increment's design doc already names as approved
(a pinned template, emsdk, a nightly toolchain); a new download needs the user's sign-off first.

## Scoped re-runs

Re-run only what your diff can reach (gate7-design.md, "Scoped re-runs and milestone sweeps"), in
two tiers, through `experiments/render-stream/scripts/validate-increment.sh`. Writing code is
minutes; validation is most of an increment's time, so plan it before the first run:

1. **Plan.** `validate-increment.sh --plan` maps `git diff --name-only main...HEAD` (plus
   uncommitted files) through `scripts/smoke-map.json` to the native gates per core, `g7-*` groups
   per receiver and web-export core, live groups and crates it can reach. A path no rule matches
   reaches everything; if your change needs a rule, add it to the map (one data file) rather than
   hand-picking runs. `--plan --tier full` shows the full tier's runs.
2. **Iterate on smoke** (the default `--tier smoke`). Pure self-tests (they hold no lock, so they
   never wait on another agent's timing leg), native gates with their sabotage legs skipped, one
   representative leg per reached live group and browser (g7-1: `capture`, `reference` and `live`,
   not all 11 legs), one receiver leg per file group; shared code reaching most groups smokes the
   first group and lists the rest as `smoke_deferred`. Re-run with `--only <run id>` while
   fixing.
3. **Full tier once, before the commit** (`--tier full`): every leg of every reached group, with
   sabotage legs if a checker, runner, sabotage or mutation file is in the diff. Your result doc
   says what ran (the plan's `runs`) and why the rest was out of scope (its `skipped_targets`).
   Runs go in phases (GRT4a): setup, native, gate 7 correctness, then the timing runs (native
   gate 6, the `g7live-<r>-timing` runs, `g7x`) last, so their exclusive legs never stall your
   correctness runs. A run whose only non-pass rows are typed `unavailable` (desktop g7-lc's
   phone rows) passes, and `validate-summary.json` lists those rows beside each run's wall time,
   lock wait and lock hold.
4. **`--milestone` is the orchestrator's sweep**, not yours (`--milestone --base <commit>` is the
   delta sweep: the full tier over the diff since that commit, every sabotage leg).

Native sabotage legs run only when a checker, runner, sabotage or mutation file is in the diff;
otherwise they are skipped-by-tier and the summary says so. Never sleep or poll waiting for another
increment to land: validate on your own base and let the orchestrator order the landings.

**Fast frames** (GRT3, `scripts/README.md` "Fast frames (GRT3)"): every tier, `--milestone`
included since GRT4a, runs the allowlisted live correctness legs faster than real time (g1c, g1d,
g2c, g5f, g55f, and the g7-1/g7-2/g7-5/g7-55 live groups). That is for correctness verdicts only;
every denylisted timing leg stays real time in every tier (rate, pacing, phase, startup, lifecycle,
soak, gate 6's timing groups, g7-r/g7-lc/g7-k/g7-6, benches, device legs). Any number you report
about rate, pacing, phase, cadence, startup, lifecycle, soak, a bench or a device comes from a
real-time run (`--fast-frames off`, a plain runner, or a denylisted leg, which is real time
anyway). A new live leg stays real time until its checks count frames and it is added to
`RS_FAST_ALLOW_LEGS` in `lib/legs.sh`.

The tiers hold no lock for the pure self-tests (`quiet.sh light`) and need a Chromium for gate 7:
the harness launches a repo-private copy of the pinned build (`~/.cache/godot-render-stream/
ms-playwright/chromium-1223/`), seeded by `cp -a` from Playwright's shared cache when its sha256
matches; it never downloads, and fails naming both paths when neither copy matches.

## Quiet-machine runs

Rate and timing measurements are sensitive to concurrent CPU load — a loaded machine phase-locks
credit loops to the wrong frame and silently invalidates the numbers. The runners handle this
themselves with one machine-wide lock taken **per leg** (`experiments/render-stream/scripts/lib/quiet.sh`,
section "Measurement isolation" of `scripts/README.md`): each timing leg (g1d, g2c's live-animate
pins, g5f, g55f, g6l, g6s, g6c, g6p, gate 7's live legs, each `gate7-bench.ts` arm) holds it
exclusively for just that leg, and every correctness leg, build script and checker holds it
shared, pausing while a timing leg runs or waits. So:

- Run runners plainly. Never wrap a runner (or a multi-gate run) in `flock` or `quiet.sh` yourself.
- Run heavy work that is not a runner leg — a `cargo` build, a `pnpm test` suite, a wasm build —
  as `experiments/render-stream/scripts/lib/quiet.sh shared -- <command...>`.
- A new timing leg goes in a timing group (`LEGS_TIMING_GROUP`, or `timing_leg` in `lib/legs.sh`;
  `quiet-lock.ts` in TS), never under an outer lock.
- `bash experiments/render-stream/scripts/lib/quiet.sh status` shows who holds or waits; each run's
  `<out>/quiet-lock-summary.json` shows its holds. A timing check that failed while the summary
  shows a `nested-unisolated` hold, or that ran beside work outside the lock, may be rerun once.

## Context hygiene

These design docs are large and mostly not needed in full. Map a doc with
`grep -n '^#' <file>` before reading it, and read only the section(s) the increment touches by
line range. Read source files the same way once you know the function or hook you need, rather
than the whole file. Redirect any long-running command's output to a file and read back only its
summary and failures (`tail`, `grep -c`, a targeted `grep` for the failing case), not the full log.
If nested subagents are useful for broad, open-ended reading (surveying which files reference a
hook, say), delegate that to an Explore-style subagent rather than reading everything yourself.
When subagent model selection is available (see the root `AGENTS.md` "Subagent model selection"),
run those mechanical sub-tasks — file surveys, "run this leg and summarize", cleanup — on the cheaper
model, and keep the capable model for your own design/uncertain work.

## Context cap

Past roughly 250k tokens of context used, stop extending the increment. Write
`HANDOFF-<increment-id>.md` at the worktree root with what's done, what's left, and the exact next
command: make a `wip:` commit (not a landing commit — `main` never gets an unverified commit) and
stop there for a fresh agent to resume.

## Memory

A worktree agent may not be able to write `.agents/memory` (the guard can block it, and the
directory may resolve outside the sandbox). Put anything memory-worthy you learned — a gotcha, a
measured number, a trap that cost time — in the final report instead, so the orchestrator can
record it.

## Report

State: the increment id and what it proves; the commit hash and subject if landed, or the handoff
file path if not; which checks were re-run and whether they passed; any deviation from the design
doc's "Checks"/"Sabotages" and why; concrete file paths for anything the orchestrator should read
rather than take on faith. Keep it short — this is relayed to the user, not read as a transcript.
