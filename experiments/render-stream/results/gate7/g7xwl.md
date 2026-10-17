## Gate 7xwl result (2026-10-17)

G7xwl ([protocol/gate7/g7xwl.md](../../protocol/gate7/g7xwl.md); gate7-design.md Q2, Q4, Q14e)
runs the web export's live legs on the shared Rust core. Before it, `run-gate7.sh --web-core rust`
refused `--live`, because the adapter validated every stream at render-stream/6. **On `Web (rust
core)`, G7l's four live groups pass every gating check: g7-1 39/39, g7-2 36/36, g7-5 20/20 and
g7-55 20/20.** g7-5 is new: G7l's GDScript web core fails five mesh checks there on
`web-index-region-update`, and it still does on this tree. On the Rust core nothing is excused.

```bash
bash experiments/render-stream/scripts/run-gate7.sh --live --legs g7-1,g7-2,g7-5,g7-55 \
  --receiver web --web-core rust --bundle <build-web-receiver.sh --core rust bundle> \
  --out artifacts/render-stream/gate7/g7xwl/live-rs --skip-harness-selftest
```

### What changed

- **`rs-core` needed nothing.** A /7 stream's records are /6's byte for byte. Only three things
  differ, and the validator has gated all three on `version` since G7w:
  - the magic;
  - the protocol string;
  - the session's `publication.credit_window`.

  GSW has spoken /7 through `rs-core` since G7l.
- **`rs-core-capi`.** The adapter now takes the stream's version:
  - `Core::session(data, offset, version)` and `rsc_session(…, version)` accept only 6 or 7, and
    anything else is `bad-magic`;
  - the stream keeps that version for `begin_session`, `provide` and the failure decode;
  - `rs-core-capi-check` reads the version from the recording's magic.
- **The shim.** `session` takes a third argument.
- **The GDScript side.** `RsRustApplier.accept_session` and `receiver.gd` pass `_wire_version`.
  It is 7 on a /7 live connection and on a GRS7 file replay (the live-replay of
  `received.rs7`), and 6 everywhere else.
- **Harness.**
  - `run-gate7.sh --live --web-core rust` builds a `--core rust` bundle, or refuses a `--bundle`
    that is not one. It hands the gate runners `GATE7_WEB_CORE`.
  - The browser daemon (`webCoreOf` and `coreEnv` in `lib/gate7-live-legs.ts`) adds
    `RS_RECEIVER_CORE=rust` to every web leg, live or replay.
  - `check-gate7.ts --live --web-core` judges the run and adds `receiver-core@web`.
  - `LIVE_KNOWN_FAILURES` is keyed by core, so G7l's `web-index-region-update` note applies only
    to `gdscript`.

### Live legs, both web cores and GSW, on this tree

All runs are `--max-fps 60` at both ends with credit window 1, and none was rerun.

- `live-rs` is the Rust web core.
- `live-gd` is the GDScript web core, with GSW alongside.
- `live-rs2` repeats `live-rs` for g7-1 and g7-2 (see "Evidence" below).

| Group | `web`, rust core (`live-rs`) | `web`, rust core again (`live-rs2`) | `web`, gdscript core (`live-gd`) | `gsw` (`live-gd`) | G7l (`web` / `gsw`) |
| --- | --- | --- | --- | --- | --- |
| `g7-1` | 39/39 | 39/39 | 39/39 | 38/38 | 38/38 / 38/38 |
| `g7-2` | 36/36 (8 band-passed) | 36/36 | 36/36 | 35/35 | 35/35 / 35/35 |
| `g7-5` | **20/20** | — | 15/20 (the five known) | 19/19 | 14/19 / 19/19 |
| `g7-55` | 20/20 | — | 20/20 | 19/19 | 19/19 / 19/19 |

- **The extra web check is `receiver-core@web`.** It passes in every web run: 34 legs on `rust`
  and 34 on `gdscript`.
- **`g7-2` band-passes as in G7l.** Its eight exact-pixel checks pass only in the banded view,
  with every differing pixel within one level (49 shots substituted).
- **On `rust`, g7-5's mesh legs match native.** `receiver-vs-reference`, `warm-host-no-gets` and
  the three `leg-class-live-mesh*` checks all pass. The adapter issues the index-region update
  through `GL_ELEMENT_ARRAY_BUFFER` (G7xw), where the GDScript core refuses it.
- **GSW is unchanged.** The only files GSW shares with this change are the checker and the
  daemon, and its counts are G7l's.

**Cadence** (host live summaries, `sent/offered` and credit RTT in host frames at p50/p95). G6c's
60/60 phase lock shows on both cores, as in G7l. Each run lands in one of two phases at random:

- the good phase has an RTT of 1 and publishes about 0.98 of offered frames;
- the bad phase has an RTT of 2 and publishes about 0.5.

| Leg | `web` rust (`live-rs`) | `web` rust (`live-rs2`) | `web` gdscript (`live-gd`) |
| --- | --- | --- | --- |
| gate 1 live | 482/974, 2/2 (bad phase) | 937/956, 1/1 | 958/986, 1/1 |
| gate 1 resync | 966/981, 1/1 | 950/974, 1/1 | 969/987, 1/1 |
| gate 2 live | 800/853, 1/1 | 815/867, 1/1 | 418/881, 2/2 (bad phase) |
| gate 2 live-animate | 699/869, 1/1 | 679/849, 1/1 | 706/881, 1/1 |
| g5f live-mesh | 302/745, 2/6 | — | 587/750, 1/2 |
| g5f live-mesh-stall | 440/738, 1/5 | — | 244/761, 2/6 |
| g55f live-shader | 618/710, 1/2 | — | 694/761, 1/1 |

**The g5f tail is not the GDScript core.** G7l attributed g5f's credit RTT p95 of 5 frames on the
web to the web receiver's per-transaction cost. Here the same tail, a p95 of 5 to 6 frames with
`submitted` ack p95 of 70 to 85 ms, appears on both cores, on different legs in each run. The
Rust core decodes and applies these transactions in well under a millisecond (G7xn, G7xw), so the
tail lies elsewhere. Likely candidates are the engine's own mesh upload or the receiver's shot
and dump holds (G6l). G7r and G7v own that measurement. No desktop cost was measured here beyond
these summaries, and the `submitted` ack latency is not a cost figure, because it includes the
wait for the next drawing rAF.

### Sabotages

- **`GATE7_WEB_CORE_SABOTAGE=drop-env`** (`sab-drop-env`, g7-55). The run keeps `--web-core rust`
  and the rust bundle but omits `RS_RECEIVER_CORE`. The bundle still loads the side module, and
  every receiver silently ran GDScript.
  - `receiver-core@web` **fails** on all four legs: no `core rust` line, and applied.json says
    `receiver.core` `gdscript`.
  - The other 19 g7-55 checks pass. This is the silent fallback the check exists to catch: on
    g7-55, nothing else would notice it.
- **`--web-core rust` with a `gdscript` bundle** is refused by `run-gate7.sh` before any host
  starts, and by the daemon's `webCoreOf` (self-test).
- **The checker's own unit cases** (`self-test-gate7l.ts` §8):
  - `webCoreOf` refusals, and `coreEnv` under rust, gdscript, drop-env and gsw;
  - `receiverCoreProblems` on an honest leg, a killed leg, a killed drop-env leg, drop-env, a
    leg with no module fetch, a pre-G7xn `gdscript` leg, and a rust leg judged as gdscript;
  - `knownFailure` never excusing on the rust core.

**One fix during the run.** The first judgment of `live-rs` failed `receiver-core@web` on one
leg, gate 1's `live-receiver-killed`. A SIGKILLed browser leaves an empty `stdout.log` and
`timings.json` `aborted` with no resources, because its page state is never read back. Its
`console.jsonl` still streams the engine's `core rust (…)` line. The check now reads the line
from either file, and it skips the module-fetch signal only for an aborted leg with no
resources. Re-judged with that fix (`live-rs-rejudge.log`), every check passes. `live-rs2` and
the sabotage ran with the fixed check.

### Native /7 under `rust`

The native receiver speaks /7 only when `RS_RECEIVER_PROTOCOL=7` is set, and no native gate leg
sets it. It goes through the same `accept_session(…, _wire_version)`, so it falls out of this
change without code of its own.

As a direct check, the two `received.rs7` copies from `live-rs`'s browser live-replay legs
(gates 1 and 2) were replayed natively, headless, on both cores with `replay-receiver-legs.sh`
(`native7/`). Both cores applied 482 and 800 transactions with 458 and 286 RS calls.
`compare-receiver-cores.ts` found applied.json equal on 2/2 legs, states equal on 25/25, and
`process_frame` equal. Before this change the Rust core refused a /7 session (the `cargo test`
case `the_session_is_at_the_streams_version` pins that a /7 session read at 6 is refused).

### Re-runs (gate7-design.md "Re-runs": `receiver/` and the Rust crates)

| What | Result | Evidence (ignored, `artifacts/render-stream/gate7/g7xwl/`) |
| --- | --- | --- |
| Native gates 0–6, `RS_RECEIVER_CORE=gdscript` | 0 PASS 24/24, 1 66/66, 2 85/85, 3 56/56, 4 185/185, 5 116/116, 5.5 130/130, 6 154/154 | `native/gdscript/` |
| Native gates 0–6, `RS_RECEIVER_CORE=rust` | the same: 24/24, 66/66, 85/85, 56/56, 185/185, 116/116, 130/130, 154/154 | `native/rust/` |
| `cargo test`: `rs-core`, `rs-core-capi` | pass; capi 5/5, including the two new /7 tests | `pure/cargo-*.log` |
| `rs-core-check goldens` natively, and through the wasm module in Node | pass, pass | `pure/goldens-*.log` |
| `self-test-rs-core.ts`, `self-test-record-digest.ts` on G7x's four bench inputs | both pass: every input's canonical state and unsupported list match the TypeScript decoder (`pace-patch`: 400 transactions, 0 mismatches) | `pure/self-test-rs-core-bench.log` |
| golden-2…7 `make_golden.py --check` | 6/6 pass | `pure/make-golden-*.log` |
| Every `self-test-*.ts`, except the browser harness's (which launches Chromium), plus `self-test-quiet.sh` | all pass | `pure/` |
| Web file groups g7-0…g7-6 on both cores, same fresh sources | `gdscript`: G7b exactly, 20, 26, 29, 32, 70, **36/45**, 45 and 31, with g7-5's nine `web-index-region-update` failures. `rust`: G7xw exactly, 20, 26, 29, 32, 70, **45/45**, 45 and 31. Shots (every PNG under each `web/` leg) against G7b's own web shots: `gdscript` 1339/1339 byte-identical; `rust` 1302/1339, where the 37 others are the six mesh legs' 36 shots from step 4 on, plus `mesh/receiver`'s compositor screenshot. Those are the shots G7b could not draw (G7xw) | `file-gd/`, `file-rs/`, `file-*-shots-vs-g7b.txt` |

The bench inputs' `inputs.json` names an old worktree's paths. It was rewritten to point at the
main checkout's sha256-identical copy (`pure/bench-inputs.json`).

### Evidence and one error

- **Directories.** All of this run's evidence is under `artifacts/render-stream/gate7/g7xwl/`:
  `live-rs`, `live-rs2`, `live-gd` and `sab-drop-env`; `native7` and `native` for the native
  runs; and `pure`, `file-gd` and `file-rs`.
- **The error.** A first native-replay attempt here pointed `RS_RECEIVER_OUT` and the cache at
  `live-rs`'s own gate 1 and 2 `live-replay` leg directories. It overwrote their applied.json,
  `state/` and `cache/` after `check-gate7` had judged them. Both directories carry a
  `TAINTED.txt`. That is why `live-rs2` reran g7-1 and g7-2 on the Rust core, from scratch:
  39/39 and 36/36, with the same verdicts. The native replay was then rerun with every path
  inside its own run directory (`native7/`).

### What G7xwl does not prove

- **Phones.** It runs nothing on a phone. G7v's and G7k's device legs can now ask for the Rust core
  live.
- **Q9's rate legs.** `phase-60`, `dual-*` and `constrained` belong to G7r, on either core.
- **The g5f tail.** It is measured here, but not explained.
