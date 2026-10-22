# Pre-G7v milestone sweep (2026-10-21/22)

The milestone sweep before G7v (phone acceptance): `validate-increment.sh --milestone` at
**c9026a06** (G7o4), the full tier over every target with every sabotage leg, run in
`.worktrees/sweep-pre-g7v` from 2026-10-21 19:56 to 2026-10-22 01:28 (-03:00), 19 966 s wall.
Its evidence is `artifacts/render-stream/validate/sweep-pre-g7v/` in that worktree
(`validate-summary.json`, one directory per run, log `validate/sweep-pre-g7v.log`). It ran
beside another user session: the 1-minute load sat at 10–17 for much of the setup phase.

19 of 25 runs passed, including every native gate −1 to 6, every gate 7 file and live
correctness group on both browser receivers, and the gsw and web timing groups. The six
failures are triaged below. Two were code bugs: `g7live-native-timing`, already fixed on `main`
by ec940e64, and `g7x`, fixed by the triage commit on `rs/sweep-triage`. The other four are the
environment. The supplementary runs, for what the sweep did not cover, are at the end.

## Runs

Wall, lock wait and lock hold are in seconds, from `validate-summary.json`.

| Run | Phase | rc | Wall | Lock wait | Lock hold | Verdict |
| --- | --- | --- | --- | --- | --- | --- |
| `lock-tests` | setup | 1 | 266 | 0 | 0 | environment (load); passes at load 4.3 |
| `pure` | setup | 1 | 1890 | 0 | 0 | environment (load); `self-test-report` passes at load 3.95 |
| `capture-build` | setup | 0 | 5 | 0 | 0 | pass |
| `cargo-rs-core` | setup | 0 | 81 | 0 | 0 | pass |
| `cargo-rs-core-capi` | setup | 0 | 1 | 0 | 0 | pass |
| `cargo-gsw-rs` | setup | 101 | 107 | 0 | 0 | known: wasm32-only crate under native `cargo test` |
| `cargo-decode-proto-rs` | setup | 0 | 24 | 0 | 0 | pass |
| `pnpm-test` | setup | 1 | 78 | 0 | 0 | known: Playwright headless shell missing |
| `native-rust-gate-minus1` | native | 0 | 86 | 46 | 33 | pass |
| `native-rust-gate0` | native | 0 | 99 | 51 | 44 | pass |
| `native-rust-gate1` | native | 0 | 734 | 639 | 165 | pass |
| `native-rust-gate2` | native | 0 | 971 | 730 | 222 | pass |
| `native-rust-gate3` | native | 0 | 289 | 245 | 99 | pass |
| `native-rust-gate4` | native | 0 | 605 | 339 | 192 | pass |
| `native-rust-gate5` | native | 0 | 438 | 213 | 188 | pass |
| `native-rust-gate55` | native | 0 | 623 | 393 | 191 | pass |
| `g7-gsw` | g7 | 0 | 3258 | 6020 | 2872 | pass |
| `g7-web-rust` | g7 | 0 | 5416 | 18095 | 7715 | pass |
| `g7live-gsw` | g7 | 0 | 2627 | 7794 | 1410 | pass |
| `g7live-web-rust` | g7 | 0 | 1713 | 3472 | 1506 | pass |
| `native-rust-gate6` | timing | 0 | 5320 | 2275 | 2795 | pass |
| `g7live-gsw-timing` | timing | 0 | 1320 | 1462 | 1221 | pass (99 checks; 4 desktop `real-suspension@gsw-device` rows `unavailable`) |
| `g7live-web-rust-timing` | timing | 0 | 1223 | 1418 | 1534 | pass (95 checks; 3 desktop `real-suspension@web-device` rows `unavailable`) |
| `g7live-native-timing` | timing | 1 | 1 | 0 | 0 | bug, fixed on `main` by ec940e64 (G7r) |
| `g7x` | timing | 1 | 912 | 210 | 56 | bug, fixed by the triage commit (G7a, G7xd) |

At c9026a06, `g7live-gsw-timing` and `g7live-web-rust-timing` ran `g7-6,g7-lc` only.
4578ce1e added `g7-r,g7-k` on the browser receivers to the planner after the sweep. The
supplementary runs below cover that gap.

## Failures

### `cargo-gsw-rs` (rc 101): known, environment

`error[E0432]: unresolved imports ...canvas_items::CanvasItemsExecutor`: the item is gated
behind `#[cfg(target_arch = "wasm32")]`. The gsw-rs crate is wasm32-only, and the sweep runs it
under native `cargo test`. This is pre-existing and not owned by any increment in the window.

### `pnpm-test` (rc 1): known, environment

`browserType.launch: Executable doesn't exist at
~/.cache/ms-playwright/chromium_headless_shell-1223/...`: Playwright's headless shell is not
installed. This is 1 file of 179, while 2489 tests passed. The agents must not run
`playwright install`.

### `pure` (rc 1): environment (load)

57 of 58 self-tests passed. Only `self-test-report` failed, and only on its two throttle-proxy
latency assertions: mean 33.85 ms and 36.55 ms against a configured 30 ± 2 ms, with maxima of
46 and 73 ms. It ran at load 10–17. A rerun alone at load 3.95, on the triage branch with no
change to the proxy, passed 46/46 OK, including both latency assertions
(`artifacts/render-stream/validate/sweep-triage/self-test-report/` in `.worktrees/sweep-triage`).
The cause is scheduler delay on a loaded machine, and the owner is the environment.

### `g7live-native-timing` (rc 1 in 1.2 s): G7r's loop, fixed on `main`

`run-gate7.sh: line 682: GATE7_CREDIT_WINDOW: unbound variable`. The `g7-r` loop read the
variable under `set -u` when `--credit-window` was not passed, and the planner's native timing
run does not pass it. ec940e64 ("default the credit window in run-gate7's g7-r loop") fixes this
on `main`. The supplementary native `g7-r` run below exercises the fix.

### `lock-tests` (rc 1): environment (load)

`self-test-quiet` passed 27/27. `self-test-quiet-sched` passed 23/24. Its one failure was
`FAIL v2 finishes the shared work sooner (v2 39.0s <= 0.8 x v1 42.5s)`. That assertion compares
wall-clock spans of synthetic `sleep` legs: two shared runners against one exclusive runner, on
private locks. Each leg spawns `quiet.sh`, `flock`, `bash` and `python3`. During the sweep the
lock tests ran in the setup phase beside `pure` and the cargo builds, at load 10–17, so every
spawn was slow. v2's shared span stretched from its usual 27 s to 39 s while v1's stayed at
42.5 s, because v1's span is dominated by the exclusive legs it waits behind. The starvation
assertions themselves passed: v2 ran 2.44 shared legs per runner per gap, against v1's 1.00.

The lock code (`lib/quiet.sh`) has not changed since b8ed0e8e (GRT2b). G7q's full validation
before the sweep measured `s_span=27.0` for v2. A rerun at load 4.3 on the triage branch passed
51/51, with v2 at 27.0 s and v1 at 41.7 s (0.65×). The cause is load, and the owner is the
environment, not an increment. The test still judges a wall-clock ratio. It is safe at normal
load but not beside the setup phase's parallel builds. A follow-up could judge `per_gap` alone,
or move `lock-tests` out of the parallel setup phase. Neither is done here.

### `g7x` (rc 1): bench checker leg names, G7a and G7xd

Every `g7-bench` arm ran. All 12 arm-legs had 5/5 valid repeats, and every `summary.json` was
written (`native-rs-bench-*`, `ctl-bench-*-gsw-ts`, `ctl-bench-*-web-rs`). The checker reported
`no summary (missing)` for all 12, and `bench-matches-g6c` failed with no native scene-full
summary. `g7-dev`'s desktop pace legs passed 12/12. Its 24 ctl arms are planned and not
runnable, with `needs` still listing landed increments. G7v (in flight) empties those `needs`
and runs them, so this is not a sweep failure.

**Cause.** `runGate7BenchChecks` (`scripts/lib/gate7d-checks.ts`) looked up each leg by the name
`gate7-dev-legs.ts` planned in G7d: `native-bench-<input>`, `ctl-bench-<input>-gsw`,
`ctl-bench-<input>-web`. `gate7-bench.ts` has since renamed what it writes:

- **G7a** (b499932b, 2026-10-15) named the TypeScript arm's legs `-gsw-ts`. The gsw rows have
  been "missing" since then: G7g's `final2` run on 2026-10-17 already shows
  `ctl-bench-*-gsw-complete` failing with `no summary (missing)`.
- **G7xd** (f303b9b2, 2026-10-18) made `rust` the bench's default core. Native legs became
  `native-rs-bench-<input>` (G7xn's naming for `--core rust`), and web legs `-web-rs` (G7xw's).
  `loadBenchLegs` also skipped `native-rs-bench-*` directories outright.

No full `g7x` ran between these increments and this sweep. G7gd's validation deferred `g7x` to
this sweep, so the drift went unseen. **Not G7gd:** G7gd removed only the `gdscript` value, and
the bench's runs, inputs and arms are unchanged. GRT4a, GRT4b, ea3d3351 and G7o4 do not touch the
bench path either.

`bench-matches-g6c` had a second, latent break. It required the native scene-full means to fall
within ±15 % of G6c's GDScript replay means (decode 6283 µs, apply 890 µs). Since G7xd the
native arm is the Rust core, and since G7gd it can be nothing else. The sweep's Rust means were
213 µs and 101 µs. The check could never pass again.

**Fix** (the triage commit, `scripts/lib/gate7d-checks.ts` only, so G7v's edits to
`gate7-bench.ts` and `gate7-dev-legs.ts` rebase cleanly):

- `benchLegNames(planned)` resolves a planned arm-leg to the directory the bench writes: the
  planned name, `native-rs-bench-*`, `-gsw-ts` or `-web-rs`. `loadBenchLegs` reads
  `native-rs-bench-*`.
- `bench-matches-g6c` keeps its id, which `gate7-design.md` and G7d's results cite, and its
  reference. It now bounds the Rust core's scene-full means at a tenth of G6c's decode mean
  (≤ 628 µs) and a quarter of its apply mean (≤ 222 µs). G7xn measured the Rust core 40× and 11×
  faster at p95, so the bound passes at twice the cost G7xn measured. It still fails a bench that
  lost the Rust core or its transactions. `gate7-design.md`'s bench arms line records the
  change.

Proof against the sweep's own evidence: the leg summaries, plans and results were copied to a
scratch directory and `check-gate7.ts --legs g7-dev,g7-bench` was re-run. It passed 29/29
(bench-matches-g6c: decode 213 µs ≤ 628, apply 101 µs ≤ 222). Then two sabotages on the copy:
removing `ctl-bench-hd-patch-web-rs/summary.json` fails `ctl-bench-hd-patch-web-complete` with
`no summary (missing)`, and setting the native scene-full decode mean to G6c's 6283 µs fails
`bench-matches-g6c`. The fresh re-run is below.

## Supplementary runs

These ran from `.worktrees/sweep-triage` on `rs/sweep-triage`: `main` at ec940e64 (4578ce1e's
planner change and the G7r credit-window fix) plus the triage commit. They ran on the desktop
only, with no `--env device`, because G7v owns the phone. The four `run-gate7.sh` runs started
together at 01:42 on 2026-10-22, and the quiet lock serialized their exclusive legs. They ran as
plain runners rather than `validate-increment.sh --milestone --only ...`, because that planner's
browser timing runs also repeat `g7-6,g7-lc`, which the sweep had already passed. The 1-minute
load was 9.2 at the start. It rose to 16–19 from about 02:55, when another repo's headless Godot
and Python jobs started. Every timing check passed on the first run, so none was rerun. Evidence
is under `artifacts/render-stream/validate/sweep-triage/<id>/` (`run.log`, `rc`, `wall_s`,
`uptime.txt`, `run/`).

| Run | Command (`run-gate7.sh ...`) | Wall (s) | Result |
| --- | --- | --- | --- |
| `g7r-native` | `--live --legs g7-r --receiver native --credit-window 1` | 1640 | 45/45 `g7-r` |
| `g7rk-gsw` | `--live --legs g7-r,g7-k --receiver gsw --credit-window 1` | 6059 | 100/100: `g7-r` 60, `g7-k` 40 (`g7k-sabotage-leak-gl-textures-gpu-mem-bounded` typed `unavailable`, as in G7k) |
| `g7rk-web` | `--live --legs g7-r,g7-k --receiver web --web-core rust --credit-window 1` | 6143 | 111/111: `g7-r` 80, `g7-k` 31 |
| `g7x` | `--legs g7-dev,g7-bench` | 2140 | 36/36: `g7-bench` 17 (group checks 29/29), `g7-dev` 12, harness probes 7 |

The native `g7-r` run passes with the planner's default credit window, so ec940e64 is confirmed.
The `g7x` re-run passes with the fixed checker: `bench-matches-g6c` reports a Rust scene-full
decode mean of 191 µs (≤ 628) and an apply mean of 92 µs (≤ 222). As in the sweep, native
`phase-60-r4` published 29.7/s, the known window-1 phase lock (G7r), and `rate-achieved` passes
it.

The two load-sensitive self-tests, rerun at low load on the same branch before the timing runs:

| Run | Load at start | Result |
| --- | --- | --- |
| `self-test-report` | 3.95 | 46/46 OK, throttle-proxy latency within 30 ± 2 ms both ways |
| `lock-tests` | 4.27 | 51/51 (`self-test-quiet` 27, `self-test-quiet-sched` 24; v2 shared span 27.0 s vs v1 41.7 s) |

With these, every run in the pre-G7v sweep's plan has passed, or has a recorded environment cause
(`cargo-gsw-rs` and `pnpm-test`, both known). The planner's browser timing runs now include
`g7-r,g7-k` (4578ce1e). The next milestone sweep covers them without supplementary runs.
