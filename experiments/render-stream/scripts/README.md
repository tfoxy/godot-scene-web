# render-stream scripts

Build scripts, gate runners, checkers, the smoke tier and their self-tests. Every script documents
its own flags in its header comment; this page is the map and the conventions they share. Paths
below are relative to `experiments/render-stream/scripts/` unless they start at the repo root.

TypeScript entry points run through the repo's toolchain with the source condition:

```bash
mise exec -- pnpm exec tsx --conditions=development experiments/render-stream/scripts/<file>.ts ...
```

## Conventions every runner follows

- **Pinned engine.** Captures and references run on the official Godot 4.5.1 Linux release
  template (`--binary`, default `~/.cache/godot-render-stream/templates/4.5.1-stable/linux_release.x86_64`)
  with the committed calibration record (`--calibration`, normally
  `../calibration/godot-4.5.1-stable-linux-release.json`). Each fixture project is imported once
  with the editor first; the runners do that themselves.
- **No desktop display.** Headless legs strip `DISPLAY` and `WAYLAND_DISPLAY`. Rendered legs
  (references, rendered receivers) share one private `gamescope --backend headless` per run
  (`lib/gamescope.sh`), never Xvfb and never a desktop window.
- **Clean environment per launch.** Every launch strips every inherited `GRC_*` and `RS_*` variable
  and passes only what its leg needs; each leg records it in `env.txt`.
- **Evidence goes to `--out`.** The default is `artifacts/render-stream/<gate>/<UTC>/` at the repo
  root, which is ignored; an explicit `--out` must be empty or absent. Nothing a run writes is
  committed.
- **Exit codes.** `0` when every check passes, `1` when a check fails, `2` for a usage error or a
  refused precondition (nothing run).

## Measurement isolation: the quiet lock

`lib/quiet.sh` (TS twin `lib/quiet-lock.ts`) is one machine-wide lock, shared by every checkout on
the box, so timing measurements are not disturbed by other heavy work. Runners take it **per leg**,
never for a whole run.

- **Path**: `${XDG_RUNTIME_DIR:-/tmp}/godot-scene-web/quiet.lock`. `GSW_QUIET_LOCK` or
  `GSW_QUIET_DIR` override it. `RS_QUIET_LOCK_DIR=<temp dir>` gives a run a **private** lock: use it
  for tooling tests and synthetic runs, never for a gate run that shares the machine.
- **Exclusive** holds are for timing legs (rate, cadence, pacing and bench measurements): nothing
  else heavy runs meanwhile. A runner marks them with `LEGS_TIMING_GROUP` or `timing_leg`
  (`lib/legs.sh`).
- **Shared** holds are for correctness legs, every build script and every checker. Shared holders
  run together but wait while a timing leg holds the lock or is waiting for it. A waiting exclusive
  acquirer leaves a marker, so a stream of shared holders cannot starve it.
- **Nesting** is a logged no-op: a process whose ancestor already holds the lock (a runner calling a
  build script) does not take it again. Never wrap a runner in `quiet.sh` or `flock`; its legs lock
  themselves.
- **Crashes** free the lock: a holder process owns each hold and exits when its owner dies.

```bash
# Heavy work outside a runner (a cargo build, a pnpm suite):
bash experiments/render-stream/scripts/lib/quiet.sh shared -- <command...>
# Exclusive, for a one-off measurement:
bash experiments/render-stream/scripts/lib/quiet.sh exclusive [--label L] [--log F] -- <command...>
# Holds nothing, runs niced (pure self-tests only):
bash experiments/render-stream/scripts/lib/quiet.sh light -- <command...>
# Current holders, waiters and share window:
bash experiments/render-stream/scripts/lib/quiet.sh status
```

Tuning knobs (rarely needed): `GSW_QUIET_MARKER_MAX_S` (stale-marker age, default 3600),
`GSW_QUIET_SHARE_PCT` / `GSW_QUIET_SHARE_MAX_S` / `GSW_QUIET_SHARE_LINGER_S` (the share window after
an exclusive release), `GSW_QUIET_SCHED=v1` (the older admission order), and core pinning with
`RS_TIMING_CPUSET` / `RS_BACKGROUND_CPUSET` (off by default). Each run writes
`<out>/quiet-lock.jsonl` and `<out>/quiet-lock-summary.json`. Self-tests:
`test/self-test-quiet.sh` (private lock) and `test/self-test-quiet-sched.sh` (scheduling).

## Build scripts

| Script                                                              | Builds                                                                                                             |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `build-capture.sh [build type]`                                     | The capture GDExtension (CMake) and its ctest suite; prints the `.gdextension` path under `capture/build/`.        |
| `build-rs-net.sh [--no-test]`                                       | The optional net module `capture/build/librender_stream_net.so` (WebTransport, TLS). Run after `build-capture.sh`. |
| `build-rs-core.sh [--native-only\|--wasm-only]`                     | `rs-core-check` and `rs-gsw-wasm` into `artifacts/render-stream/rs-core/<sha>/` (`latest` points at the newest).   |
| `build-rs-core-ext.sh [--no-test]`                                  | The native receiver's adapter `receiver/ext/build/librs_core_ext.so`. Needed before any native receiver launch.    |
| `build-rs-core-web.sh`                                              | The same adapter as an emscripten side module for the web export.                                                  |
| `build-web-receiver.sh --core rust [--out DIR] [--force]`           | The web-export receiver bundle, from pinned, sha-checked editor and template binaries.                             |
| `build-basis-transcoder.sh`                                         | GSW's KTX2/Basis transcoder wasm.                                                                                  |
| `prepare-textures.sh --cache DIR (--project\|--images\|--list) ...` | Warms the capture's persisted texture cache, headless, before any session.                                         |
| `calibrate.sh [--check]`                                            | Re-derives the committed calibration record (`--check` diffs instead of writing).                                  |

Every build holds the quiet lock shared and is incremental; cargo builds are offline (`--offline`,
pinned lockfiles).

## Gate runners and checkers

Each gate is a runner (`run-gate<N>.sh`) and a checker (`check-gate<N>.ts`). The runner drives the
fixtures under `../fixtures/` through their legs (capture, reference render, receiver replay,
sabotage and fault legs that must fail a named check) and writes evidence under `--out`; then it
runs the checker, which classifies every leg, evaluates every check, writes
`<out>/result.json` and prints one line per check.

| Runner               | Gate                                                                                                                                                     |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `run-gate-minus1.sh` | The capture seam: the hooks on the pinned binary, against the spike fixture, headless and rendered.                                                      |
| `run-gate0.sh`       | First stream: a recording replayed pixel-exact by the receiver.                                                                                          |
| `run-gate1.sh`       | Retained state, patches and the live WebSocket transport (stall, reconnect, resync).                                                                     |
| `run-gate2.sh`       | Textures: payloads, the resource store, cache and live HTTP GETs, auth.                                                                                  |
| `run-gate3.sh`       | Clipping, including transformed clips and `clip_ignore`.                                                                                                 |
| `run-gate4.sh`       | Text: atlases, layout, i18n, MSDF, rich text.                                                                                                            |
| `run-gate5.sh`       | Geometry, meshes and styleboxes.                                                                                                                         |
| `run-gate55.sh`      | Materials and shaders.                                                                                                                                   |
| `run-gate6.sh`       | A full scene at presentation size, canvas layers, HD, live cadence, soak and perf legs.                                                                  |
| `run-gate7.sh`       | The browser receivers (web export and GSW) replaying the other gates' sources, live legs, benches and device legs.                                       |
| `run-gate8.sh`       | Late-join adoption, compressed and float textures, delivery variants, host cache, presentation size, canvas groups, particles, multimesh, item metadata. |

Native runners share one shape:

```bash
bash experiments/render-stream/scripts/run-gate<N>.sh \
  --extension /abs/capture/build/render_stream_capture.gdextension \
  --calibration /abs/experiments/render-stream/calibration/godot-4.5.1-stable-linux-release.json \
  [--binary /abs/linux_release.x86_64] [--out DIR] [--legs <group>,<group>]
```

`--extension` and `--calibration` are required. `--legs` selects leg groups by id (`g1a,g1d`,
`g6a,g6h`, `g8t`, ...); the runner's header lists its groups, and groups not selected are
reported `not-run`. Some experiment groups run only when named. The pnpm aliases
`pnpm render-stream:gate0` … `render-stream:gate8` (and `:gate55`, `:gate-minus1`) run the same
scripts. A checker can be rerun on existing evidence:

```bash
mise exec -- pnpm exec tsx --conditions=development \
  experiments/render-stream/scripts/check-gate0.ts --out <evidence dir>
```

### Gate 7 (browser receivers)

`run-gate7.sh` takes `--legs <group,...>` (`g7-0` … `g7-6`, `g7-55`, `g7-8` file groups; `g7-lc`,
`g7-r`, `g7-k` live lifecycle, pacing and soak groups; `g7-dev` device legs; `g7-bench` decode/apply
benches; `g7-p` the perf matrix) and:

- `--receiver native|gsw|web` limits a run to one receiver; `--web-core rust` is the web export's
  core.
- `--make-sources` first runs the native gates that produce the sources it replays (cached, see
  below); `--source gate0=/abs/run,...` names existing source runs instead.
- `--live` runs the groups' live legs; `--credit-window 1|2` sets the live credit window.
- `--plan-only` writes the plan (`<out>/<group>/plan.json`) without running anything.
- `--bundle`, `--gsw-bundle` and `--rs-build` point at prebuilt receivers; otherwise the runner
  builds what it needs.
- Device legs need **both** `--env device` and `--device <id>`; either alone is a usage error, and
  without them no device arm is selected. `<id>` names an entry in `../fixtures/gate7-devices.json`,
  which supplies the phone's adb serial, model and GPU; a session refuses a phone whose serial or
  model does not match (`device-provenance`). Fill in your own phone's serial there; the harness
  attaches to Chrome on the phone over adb, it never launches it. Without a device, every
  `dev-` arm is reported `not-run`.

Browsers are the repo-pinned Chromium revision (`lib/browser-harness.ts`, checked by sha256), kept
under `~/.cache/godot-render-stream/ms-playwright/` (`RS_PRIVATE_BROWSERS_DIR` overrides). The
harness never downloads a browser. Its own self-test is `test/self-test-browser-harness.ts`.

### Other runners

`run-hc1.sh` (capture-scale quiet-path legs), `run-client-carrier-check.sh` (the client package
over the `ws` and `wt` carriers; needs `build-rs-net.sh`), `run-g7x-*.sh` (the GSW Rust arm's desktop
correctness checks, page-level sabotages and native reference shots), and the benches `bench-capture-scale.sh`, `bench-instr.sh` and
`bench-live-scale.sh`, each with its header usage.

## Smoke tier: `validate-increment.sh`

`validate-increment.sh` maps a diff to the receivers, cores, gates and gate 7 groups it can reach
(`smoke-map.json`, through `lib/smoke-plan.py`) and runs only those, in phases: `setup` (pure
self-tests, lock tests, builds, crates), `native` (native correctness gates), `g7` (gate 7 groups),
then `timing` (timing-sensitive live groups, last so their exclusive legs never stall a correctness
run). A changed file no rule matches reaches every target.

```bash
bash experiments/render-stream/scripts/validate-increment.sh [--base main] [--out DIR] \
  [--plan] [--tier smoke|full] [--milestone] [--only id,id] [-j N] [--timing-jobs N] \
  [--paths p1,p2] [--fast-frames on|off] [--fast-fps N]
```

- `--plan` prints the plan (targets, sabotage decision, runs) and exits.
- `--tier smoke` (default) runs one representative leg per reached live group and receiver and
  one receiver leg per file group; `--tier full` runs every leg of the reached groups.
- `--milestone` runs every target with every sabotage leg; with an explicit `--base REF` it is the
  delta sweep over the targets the diff since `REF` reaches.
- `--base REF` diffs `REF...HEAD` plus uncommitted and untracked files (default `main`); `--paths`
  replaces the diff with an explicit list. `--only` runs selected run ids from the plan.
- Sabotage legs run only when a checker, runner, sabotage or mutation file is in the diff;
  otherwise the runners get `RS_SABOTAGE_TIER=skip` and those checks are reported
  skipped-by-tier.
- `--fast-frames on` (default) runs allowlisted live correctness legs faster than real time; timing
  legs always run in real time.

It writes `<out>/plan.json`, one directory per run (with `command.txt`: the env and argv it
launched) and `<out>/validate-summary.json`, prints one line per run and exits non-zero when any
run fails. `python3 lib/smoke-plan.py --self-test --map smoke-map.json` tests the map.

**Source cache.** `source-cache.sh` keeps passing native source runs, keyed by their inputs
(template, capture library, calibration, receiver core and every source-shaping file;
`gate7-tool.ts source-key` prints the key), so the native and browser halves of a validation share
one set. Entries live in the main checkout's ignored `artifacts/render-stream/source-cache/`
(`GSW_SOURCE_CACHE` overrides) and are read-only. `run-gate7.sh --no-source-cache` or
`RS_SOURCE_CACHE=0` bypasses it; `source-cache.sh list` and `source-cache.sh prune [--keep N |
--keep-days N]` manage it (`GSW_SOURCE_CACHE_KEEP`, default 3 keys).

## Common environment

Most runs need none of these; runners set what their legs need.

| Variable                                                       | Effect                                                                                                                    |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `RS_QUIET_LOCK_DIR`                                            | A private quiet-lock directory (tooling tests and synthetic runs only).                                                   |
| `RS_LEG_SHARDS=N`                                              | Run file-mode legs on N parallel workers, each with its own gamescope (gates 0–3 and gate 7 file groups; default serial). |
| `RS_FAST_FRAMES=all\|host\|receiver`, `RS_FAST_FRAMES_MAX_FPS` | Run allowlisted live correctness legs unthrottled (default off; 61..1000 fps, default 240).                               |
| `RS_SABOTAGE_TIER=skip`                                        | Skip sabotage legs; their checks are reported skipped-by-tier.                                                            |
| `RS_SMOKE_LEGS`, `GATE7_SMOKE_LEGS`                            | The smoke tier's leg selection (set by `validate-increment.sh`).                                                          |
| `RS_SKIP_TIMING_GROUPS=1`                                      | Skip exclusive-lock timing groups (set only by the hosted-runner workflow).                                               |
| `RS_SOURCE_CACHE=0`                                            | Do not look up or publish gate 7 sources in the cache.                                                                    |
| `GATE7_CREDIT_WINDOW`                                          | The live credit window for gate 7 runs (same as `--credit-window`).                                                       |
| `RS_PRIVATE_BROWSERS_DIR`                                      | The root of the pinned Chromium copy.                                                                                     |
| `RS_RECEIVER_*`                                                | Receiver configuration, normally set per leg by the runner; see [../receiver/README.md](../receiver/README.md).           |
| `GRC_*`                                                        | Capture configuration, set per leg by the runner; see [../protocol/streaming-host.md](../protocol/streaming-host.md).     |
| `RS_FIXTURE_*`                                                 | Fixture-scene controls (frames to quit at, shot frames, variants), read by the fixtures' own scripts.                     |

## Self-tests

- `bash test/run-pure-self-tests.sh [--out DIR] [-j N] [--lock-tests] [--only name,name] [--list]`
  runs every golden directory's `make_golden.py --check` and every `test/self-test-*.ts` that needs
  no engine, browser or build, niced and holding no lock. `--lock-tests` adds the two lock
  self-tests. Each prints PASS/FAIL; the script exits non-zero on any failure.
- Shell self-tests under `test/`: `self-test-quiet.sh`, `self-test-quiet-sched.sh`,
  `self-test-source-cache.sh`, `self-test-validate-tier.sh`, `self-test-par-legs.sh`,
  `self-test-fast-frames.sh`, `self-test-socket-owners.sh`, `self-test-free-port.sh`,
  `self-test-wire-budget.sh` and the bench self-tests. All use private locks and temporary
  directories.
- Checkers are tested against fabricated evidence trees: each `test/self-test-gate*.ts` drives its
  gate's `lib/gate*-checks.ts`. `python3 lib/tier-verdict.py --self-test` tests the tier verdict.
- `test/self-test-browser-harness.ts` (needs Chromium), `test/self-test-rs-core.ts` and
  `test/self-test-rs-core-wasm.mjs` (need a core build) are not pure; `run-gate7.sh` runs them.
- `test/run-rs-ws-interop.sh` checks the capture's WebSocket server against Node and Godot clients.
