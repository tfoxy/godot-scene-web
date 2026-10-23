# Pre-G7z delta milestone sweep (2026-10-22/23)

The delta milestone sweep before G7z: `validate-increment.sh --milestone --base c9026a06` (the
full tier over everything the diff since G7o4 reaches, every sabotage leg), run in
`.worktrees/sweep-pre-g7z` at **d5cc1456** (a46b2e5b plus the guard-script chore; the chore
touches only `scripts/claude-guard-bash.sh` and its test). The plan escalated to every target:
53 targets, 98 changed paths, 6 unmatched (`apps/playground/package.json`, `compose-g7p.sh`,
`validate-summary.py`, `pnpm-workspace.yaml`, the guard script and its test), 25 runs. The plan JSON
is in the evidence directory (`plan.json`).

Command: `scripts/remote-validate.sh --milestone --base c9026a06 --and-local`, started
2026-10-22 23:43 (-03:00). Remote run
[39891069352](https://github.com/tfoxy/godot-scene-web/actions/runs/39891069352), run key
`rv-20261023T024247Z-fe8687e-15990`, snapshot `fe8687ec0448`; its branch was deleted by the workflow.
The local half finished at about 03:30 on 10-23, 11 685 s for the refused runs plus 1 404 s for the
refused live groups, run one after the other. Two agent sessions ran beside it; the 1-minute load
was 2–7 for most of the sweep, with spikes to 10–17 while the first local timing run overlapped
the remote setup and my own supplementary builds. Evidence:
`artifacts/render-stream/gate7/sweep-pre-g7z/` (copied from the worktree's
`artifacts/render-stream/{remote,validate,supp}`).

Of the 25 planned runs, 22 passed outright, `cargo-gsw-rs` is the known failure, `g7live-gsw-timing`
failed on `g7-k` (a real regression, below), and `g7live-web-rust` failed on two group rows (the
g7-1 model gap that has a fix in flight, and one g7-2 flake that passed on rerun).

## Runs

Wall, lock wait and lock hold are seconds from each `validate-summary.json`.

### Remote (hosted runners, 20 runs, 19 pass)

| Run | rc | Wall | Verdict |
| --- | --- | --- | --- |
| `pure` | 0 | 164 | pass (so `self-test-report` passes on a quiet runner) |
| `capture-build`, `cargo-rs-core`, `cargo-rs-core-capi`, `cargo-decode-proto-rs`, `bench-instr` | 0 | 125 / 42 / 60 / 9 / 36 | pass |
| `cargo-gsw-rs` | 101 | 41 | known: wasm32-only crate under native `cargo test` |
| `pnpm-test` | 0 | 86 | pass (the local Playwright headless shell gap does not exist on the runner) |
| `native-rust-gate-minus1` .. `gate55` | 0 | 38–196 | pass; llvmpipe/lavapipe, every sabotage leg |
| `g7-gsw` | 0 | 872 | pass |
| `g7-web-rust` | 0 | 759 | pass |
| `g7live-gsw` (groups g7-5, g7-55) | 0 | 144 | pass |
| `g7live-web-rust` (groups g7-5, g7-55) | 0 | 124 | pass |

The timing groups inside the native gates (`g1c-rate`, `g1d`, `g2c-pins`, `g5f`, `g55f`) are skipped on
the runners, so they ran locally (next table).

### Local (this machine, NVIDIA)

| Run | Phase | rc | Wall | Lock wait | Lock hold | Verdict |
| --- | --- | --- | --- | --- | --- | --- |
| `lock-tests` | setup | 0 | 251 | 0 | 0 | pass (on a quiet setup phase; no load failure this time) |
| `native-rust-gate1` | native (timing groups) | 0 | 1344 | 1157 | 159 | pass |
| `native-rust-gate2` | native | 0 | 830 | 593 | 208 | pass |
| `native-rust-gate5` | native | 0 | 1040 | 826 | 182 | pass |
| `native-rust-gate55` | native | 0 | 2108 | 1900 | 177 | pass |
| `g7live-gsw` (groups g7-1, g7-2) | g7 | 0 | 630 | 1056 | 1022 | pass (g7-1 `resync-full` happened to pass) |
| `g7live-web-rust` (groups g7-1, g7-2) | g7 | 1 | 773 | 1365 | 1159 | 2 failures, below |
| `native-rust-gate6` | timing | 0 | 4031 | 1003 | 2788 | pass |
| `g7live-gsw-timing` | timing | 1 | 4041 | 1740 | 3398 | 173 pass, 2 fail (`g7-k`), 4 desktop `real-suspension@gsw-device` rows `unavailable` |
| `g7live-web-rust-timing` | timing | 0 | 2444 | 153 | 2908 | pass (165 checks; 3 `real-suspension@web-device` rows `unavailable`) |
| `g7live-native-timing` | timing | 0 | 308 | 8 | 288 | pass (31 checks) |
| `g7x` | timing | 0 | 609 | 4 | 47 | pass (36 checks; group checks 29/29) |

The native gate rows are runs of the whole gates, not just the five timing groups; the remote run
already passed their correctness halves. The gate 1, 2, 5, 55 timing groups of `g7-gsw` and
`g7-web-rust` are the same native-receiver legs, so one local pass covers them.

## Failures

### `cargo-gsw-rs` (rc 101): known, environment

Same as the pre-G7v sweep: `CanvasItemsExecutor` is behind `cfg(target_arch = "wasm32")` and the
runner calls native `cargo test`. Not owned by any increment in the window.

### `g7live-gsw-timing`, `g7-k` GSW soak: JS heap slope (reproduced; owner G7wd, likely)

`g7k-soak-scene-js-heap-bounded`: JS heap slope 834 002 B/min against the 524 288 B/min budget,
and `g7k-sabotage-leak-gl-textures-failure-set` then fails "unexpectedly also failed: js-heap-bounded"
(its honest-side slope is the same 793 KB/min). The first run was at load 10–17. The rerun at load
1.3–3.4 (`g7-k` alone, gsw, `supp/g7k-gsw-rerun`) fails the same two checks: 837 354 B/min. So this is
not load. The web receiver's `g7-k` passes. G7k measured +2.0 MB JS heap growth for the gsw soak at
credit window 1 (`results/gate7/g7k.md`); the slope is about twice as steep now.

Owner: **G7wd 2431d26f**, most likely. It made window 2 the default, so `g7-k` soaks at twice the
frame rate and the gsw receiver's per-frame/per-transaction JS records (the tap and sample arrays,
which G7v b6304ff1 bounded only through `RS_RECEIVER_RECEIVED_MAX_BYTES`) grow twice as fast.
Not confirmed: a `g7-k --credit-window 1` rerun would separate it from G7v's `live.ts` change, and
I did not run it. Follow-up: bound the gsw receiver's per-frame records in the soak (as G7v's
note on the g31 soak already says) or set the budget against the window-2 rate. This is a product
or checker decision; I changed nothing.

### `g7live-web-rust` group g7-1 `resync-full@web` (known; owner G7wd, fix in flight)

`the next transaction (seq 612) is patch with base 611, expected full with base null`: the model gap
that f0de33d6 addresses. See "g7-1 after f0de33d6".

### `g7live-web-rust` group g7-2 `leg-class-sabotage-drop-resource@web` (flake)

`receiver failure at seq 594, expected seq 593`: the known window-2 fold flake (two transactions in
one poll). Rerun once (`RS_VALIDATE_GROUPS=g7-2 validate-increment.sh --only g7live-web-rust`,
`supp/g7-2-web-rerun`): rc 0, 877 s. Owner G7wd's fold model (`g7-2-fold-seq-model-archive`), not
a new regression.

## Supplementary runs

### g7-r at `--credit-window 1`

| Receiver | Command (`run-gate7.sh ... --live --legs g7-r --credit-window 1`) | Result |
| --- | --- | --- |
| native | `--receiver native` | rc 0, `gate_passed=true`, 44 PASS, 0 FAIL (`supp/g7r-native-w1`) |
| gsw | `--receiver gsw` | **not run** (started, then stopped for the time budget; the machine was serialising it behind the other exclusive legs) |
| web (rust) | `--receiver web --web-core rust` | **not run** |

The window-1 `g7-r` list (dual-native, late-poll, `sabotage-ack-on-receipt`) is therefore only
confirmed on the native receiver. The pre-G7v sweep passed gsw (60/60) and web (80/80) at window 1 on
c9026a06, before G7v, G7p and G7wd. A reader of this record should take the browser window-1 rows as
open until they run.

### g31 `g7-dev` on this build (gsw, window 2)

`run-gate7.sh --live --legs g7-dev --env device --device g31 --receiver gsw`, `G7V_WINDOWS=2`
(the run covers window 2 only; the default also runs window 1). Moto g31 ZY22FD8XP3, USB, battery
100 % before and after, 24.6 to 25.3 degrees C; evidence `supp/g31-gsw/`, summary `g7v-summary.json`.
Five repeats per workload, means; a first attempt at both windows was cut after window 1's first
21 legs to keep the budget (`supp/g31-gsw-w1-cut`, unjudged).

| Workload | Published /s | Drawn /s | Main thread p95 (ms) | `gpu_complete` p95 (ms) |
| --- | --- | --- | --- | --- |
| pace | 59.94 | 58.21 | 4.2–4.9 | 16.8–16.9 |
| scene | 57.91 | 54.06 | 7.5–8.0 | 16.6–16.9 |
| hd | 8.97 | 5.10 | 27.3–31.5 | 57.5–60.1 |
| gpu-headroom-pace | 60.0 | 58.34 | 4.2–4.7 | 16.8–17.1 |
| gpu-headroom-scene | 58.12 | 54.33 | 7.2–8.1 | 16.4–16.9 |
| gpu-headroom-hd | 8.47 | 4.76 | 30.6–32.6 | 56.0–62.8 |

Acceptance reads "not met" for gsw at window 2, exactly as at G7v: `dev-rate@scene` drawn
53.8–54.6/s against 57 (G7v: 54.4), `dev-cadence@scene`, `dev-cadence@pace` (2 repeats, one 51-ms gap and
seven intervals over 34 ms) and `dev-gpu-headroom@gpu-headroom-scene`. hd and gpu-headroom-hd fail
as stretch, as accepted at G7v (4.5–5.4 drawn/s). Startup and soak were not run in this pass (the
`g7v-summary.json` lists them as "not run"). The numbers match G7v's gsw window-2 table within
noise (pace 58.1, scene 54.4, hd 8.5 published), so G7wd's hello change did not move the phone.
The **web g31 run was not done** (time). Dropped scope from G7v (no web soak) is unchanged.

## g7-1 after f0de33d6

f0de33d6 (`test(render-stream): model in-flight patches in g7-1 resync-full`) landed on `main` while
the sweep ran. `main` also holds G8w b129dd0c (render-stream/8, opt-in; /7 unchanged). Rerun in a
second worktree from f0de33d6 (`sweep-pre-g7z-g71`), plain `run-gate7.sh --live --legs g7-1`, window 2,
fast frames off (the plain runner), evidence `g71/` (copied beside the sweep's):

| Receiver | Window | Runs | Result |
| --- | --- | --- | --- |
| gsw | 2 | r1, r2, r3 | r1 **fails** `resync-full@gsw` ("the host sent 3 full transactions, expected 2 (seq 1 and the resync); the host counted 2 resyncs"); r2 and r3 pass (38+ PASS) |
| web (rust) | 2 | r1, r2, r3 | 3/3 pass (39 PASS each) |
| gsw | 1 | once | pass (38 PASS) |
| web (rust) | 1 | once | pass (39 PASS) |
| native | | n/a | `run-gate7.sh --live --receiver native` runs `g7-r` only; there is no native g7-1 live group (rc 2, "runs g7-r only") |

The fix holds on web (4/4 across both windows) and on gsw at window 1, but `resync-full@gsw`
still fails once in three at window 2, with a different message from the pre-fix one: the host
sent three fulls where the checker expects two. The model accounts for an in-flight patch but not,
apparently, a second host resync full on the gsw path. One failure in three runs is a lead for the
g7-1 owner, not a conclusion. The local sweep's own g7-1 pass at d5cc1456 (gsw) was the same
intermittency running the other way.

## Out of scope

- Browser `g7-r` at window 1 (gsw, web): not run (above); g7-1 native has no live group.
- g31 web `g7-dev` and the g31 gsw startup/soak legs: not run.
- Device legs that G7z's pass rule owns beyond `g7-dev` (real hidden/frozen `g7-lc` rows): typed
  `unavailable` on the desktop (4 gsw, 3 web), as before.
- `--determinism` repeats of the remote half: not asked for.
- `pure`'s and `lock-tests`' load-sensitive rows passed first time on this sweep; no rerun was
  needed.
- Nothing was out of reach of the plan: it escalated to every target.
