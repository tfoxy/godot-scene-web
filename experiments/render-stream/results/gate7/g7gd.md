## Gate 7gd result (2026-10-21)

G7gd removes the GDScript decode/apply core. The user decided this on 2026-10-21, superseding
D34's "removed in the consolidation pass after G7z" ([gate7-design.md](../../protocol/gate7-design.md)
D34, amended). Rust (`rs-core`, through `rs-core-capi` and the `RsCore` GDExtension natively,
the dlink side module in the web export) has been the default core since G7xd. After this
increment it is the only receiver implementation. The TypeScript checker decoder stays the
independent oracle (D29, D33), with the golden vectors, the hand models, the host's rendered
reference and G7b's preserved shots (`artifacts/render-stream/gate7/g7b-r1/`, the web export's
byte oracle).

### Inventory (taken before anything was deleted)

Line counts are at `main` 3b904ca6.

**GDScript decoders, retained state and applier (`receiver/`)**

| File | Lines | What it is | Fate |
| --- | --- | --- | --- |
| `rs2_decoder.gd` (`Rs2Decoder`) | 3165 | /2–/7 record decode, meta schema (`Schema`), `Stream` (patch resolution, retained state), `validate_recording`, lift helpers | deleted; framing (`split_records`, `_frame`), the magic/protocol constants and the small helpers (`err`, `code_of`, `is_int`, `as_int`, `int_list`, `sha256_hex`) move to the new `rs_wire.gd` (`RsWire`) |
| `rs_applier.gd` (`RsApplier`) | 1954 | GDScript applier: `accept_record`, `needed`, `apply_state`, RID bookkeeping, 15 `sabotage_*` flags | deleted; the fields `RsRustApplier` inherited (viewport, root canvas, counters, the sabotage word) move into `RsRustApplier`, which now extends `RefCounted` |
| `rs_texture_payload.gd` (`RsTexturePayload`) | 137 | GRT1 decode + `make_image` | deleted (the core decodes payloads) |
| `rs_mesh_payload.gd` (`RsMeshPayload`) | 153 | GRM1 decode | deleted; `GRM1_MAGIC_HEX` moves to `RsResourceCache` |
| `tests/codec2_selftest.gd` | 728 | GDScript codec vs golden-2..6 (`[rs2-selftest] ok`) | deleted; gate 0/1 `receiver-typecheck`'s selftest sub-leg runs the new `tests/receiver_selftest.gd` |
| `tests/applier2_selftest.gd` | 1474 | `RsApplier` unit self-test (manual) | deleted |
| `tests/decode_profile.gd` | 862 | GDScript decode/apply per-phase profile (manual) | deleted |

Kept as glue: `receiver.gd` (shell, session, transport, evidence, shots), `rs_config.gd`,
`rs_io.gd`, `rs_live_client.gd`, `rs_perf.gd`, `rs_resource_fetcher.gd`, `rs_resource_cache.gd`
(arrival, staging into the core, eviction, the cache and store directories),
`rs_rust_applier.gd` (marshalling into `RsCore`), `ext/`, and `rs_shader_payload.gd`: the core
never sees an operator-local shader library file, only its code (`provide_library(hash, ok,
code)`), so `RsResourceCache.library_code()` still verifies and decodes the `.grp` file there.
Moving that read into the core would change `rs-core-capi`, which this increment does not touch.

**Core selection paths**

| Where | What | Fate |
| --- | --- | --- |
| `receiver/receiver.gd` | `RS_RECEIVER_CORE` (`gdscript`\|`rust`), `_core_kind`, `_stream` (`Rs2Decoder.Stream`), `_applier: RsApplier`, every `_rust != null` branch, the GDScript state dump (`_stream` → state JSON, ~340 lines), `Rs2Decoder.raw_resource_payload` | GDScript branches deleted; `RS_RECEIVER_CORE` accepts only `rust` (unset means rust), anything else fails the run with a message naming G7gd |
| `receiver/export_presets.cfg` | preset 0 `Web` (GDScript, `web_nothreads` template) | deleted; `Web (rust core)` becomes preset 0 |
| `scripts/build-web-receiver.sh` | `--core gdscript\|rust` | accepts only `rust` |
| `scripts/web-build-json.ts` | `--core`, `--preset-index` | `--core` accepts only `rust` |
| `scripts/run-gate7.sh` | `--web-core gdscript\|rust`, `G7R_NATIVE_CORE`, bundle-core guard | `--web-core` accepts only `rust`; the bundle guard stays (an old GDScript bundle is refused) |
| `scripts/gate7-tool.ts` | `--core gdscript\|rust`, `webCoreOf`, `GATE7_WEB_CORE`, `GATE7_WEB_CORE_SABOTAGE` | `--core` and both variables removed (only `run-gate7.sh` passed them); `requireRustBundle` refuses a GDScript bundle |
| `scripts/gate7-bench.ts` | `--core gdscript\|rust`, `RS_RECEIVER_CORE=gdscript` env on native and web arms | `--core` accepts only `rust`; the report keeps `core: "rust"` |
| `scripts/lib/gate7-live-legs.ts` | `WebCore`, `webCoreOf`, `coreEnv`, `coreSabotage` (`drop-env`) | reduced to the rust-bundle guard |
| `scripts/lib/gate7-web-legs.ts` | `core?: "gdscript"\|"rust"` | removed |
| `scripts/lib/legs.sh` | `RECEIVER_CORE`, `receiver_core_env` | forwards only `RS_RECEIVER_CORE_EXT`; a runner started with `RS_RECEIVER_CORE` set to anything but `rust` refuses to run |
| `scripts/lib/gate6c-legs.sh` | `receiver-kind.json`'s `web_core`/`native_core` | removed (they fed only `receiver-core`) |
| `scripts/replay-receiver-legs.sh`, `scripts/compare-receiver-cores.ts` | replay a gate's file legs under the other core and compare | deleted (no second core) |
| `scripts/lib/source-key.ts` | `receiver_core` key field | stays, always `rust` (the key format is GRT4a's) |

**Planner targets (`scripts/smoke-map.json`, `scripts/lib/smoke-plan.py`, `validate-increment.sh`)**

- `cores: ["rust", "gdscript"]` yields `native:<gate>@gdscript` targets; now `["rust"]`.
- `g7_receivers: [..., "web/gdscript"]` yields `g7:<group>@web/gdscript`; removed, with the two
  rule `reach` lists naming it.
- Path rules for the deleted files are removed.
- `smoke-plan.py`'s self-test asserted the `@gdscript` targets; it now asserts their absence.
- `validate-increment.sh` needs no change: it already passes `RS_RECEIVER_CORE=$core` and
  `--web-core ${recv#web/}`, which are now always `rust`.

**Checks, legs, sabotages, manifests and self-tests that existed only for the GDScript core**

| Item | Fate and reason |
| --- | --- |
| `receiver-core@web` (`lib/gate7-live.ts` `receiverCoreProblems`), `receiver-core` in G7u (`lib/gate7u-checks.ts`) and G7r (`lib/gate7r-checks.ts`) | retired. It asserted which of two cores ran a leg. With one core there is nothing to fall back to: the receiver refuses to start without the adapter (`RS_RECEIVER_CORE=rust, but the adapter is unavailable`), so every other check of that leg fails. A stale GDScript bundle is still refused before any host runs, by the bundle guard in `run-gate7.sh` and `gate7-tool.ts`. |
| `GATE7_WEB_CORE_SABOTAGE=drop-env` | retired with `receiver-core@web`: dropping the env word now changes nothing. |
| `web:gdscript:gate5` known failure (`lib/gate7-live.ts`) | removed: the 4.5.1 WebGL index-region refusal only the GDScript web core hit. |
| `compare-receiver-cores.ts` (the G7xn/G7xd byte-identity comparison) | retired. Its job was proving the Rust core equal to the GDScript one, which G7xn, G7xw, G7xwl and G7xd did on every leg. Each gate's checker still judges the receiver against the TypeScript decoder's resolved state and the host's reference, and the web export against the g7b-r1 shots. |
| gate 0/1 `receiver-typecheck` selftest sub-leg (`codec2_selftest.gd`, `[rs2-selftest] ok`) | kept as a leg, new contents: `tests/receiver_selftest.gd` loads every receiver glue script under the debug editor and frames every golden recording with `RsWire.split_records` (`[receiver-selftest] ok`). Codec coverage of the golden vectors stays with the TypeScript self-tests and `rs-core`'s cargo tests. |
| `self-test-gate7l.ts` cases for `webCoreOf`/`coreEnv`/drop-env/`receiverCoreProblems` | rewritten for the rust-only guard; the `receiver-core` cases go with the check. |
| per-core feature manifests | none existed (`protocol/features/` has no per-core entries). |
| bench arms | none were GDScript-only: `native` and `web` arms keep running, on rust. |

### What changed

`git diff --stat main`: 54 files, +1035 / −10587. The seven deleted GDScript-core files and the two
core-comparison tools account for 9070 of the deleted lines; `receiver.gd` lost 539 (the GDScript
state dump, `_stream`, every `_rust != null` branch and the core switch).

- `receiver/rs_wire.gd` (new, `RsWire`): framing, magics and helpers cut from `Rs2Decoder`.
- `receiver/rs_rust_applier.gd`: extends `RefCounted` now. It carries the counters it inherited
  from `RsApplier`, and one `sabotage` word replaces the 15 `sabotage_*` booleans (the core's
  sabotages, `CORE_SABOTAGES`). `needed()` and `apply_state(cache)` lost the GDScript-only
  arguments.
- `receiver/rs_resource_cache.gd`: memory keeps raw bytes only (no `keep_raw`, no `decoded()`). With
  a stager the core verifies and decodes on arrival as before. Without one (`verify-in-frame`)
  only the SHA-256 is checked on arrival, and the core decodes in the frame. That is the
  sabotage's own point; a GDScript decode before it is gone.
- `receiver/tests/receiver_selftest.gd` (new): gate 0's and gate 1's `receiver-typecheck`
  selftest sub-leg, `[receiver-selftest] ok (37 checks)`. Failing it on purpose, by pointing
  `RS_SELFTEST_GOLDEN_DIR` at golden-3, gives 5 FAIL lines and exit 1.
- `receiver/export_presets.cfg`: `Web (rust core)` is `preset.0`, the only preset.
  `build-web-receiver.sh` and `web-build-json.ts` export it alone.
- Selector choice: **kept, rust-only**. `RS_RECEIVER_CORE` (receiver and `lib/legs.sh`),
  `run-gate7.sh --web-core`, `check-gate7.ts --web-core`, `build-web-receiver.sh --core` and
  `gate7-bench.ts --core` accept `rust` (or unset) and refuse anything else with a message naming
  G7gd. A stale `RS_RECEIVER_CORE=gdscript` therefore fails loudly instead of silently running
  rust, and `validate-increment.sh` (GRT4a's file) needed no change. `gate7-tool.ts --core` was
  removed: only `run-gate7.sh` passed it. A GDScript-core bundle is refused by
  `requireRustBundle` (`lib/gate7-live-legs.ts`) and `run-gate7.sh`'s `require_rust_bundle`.
- `lib/gate6c-legs.sh`'s `receiver-kind.json` lost `web_core`/`native_core`. Only `receiver-core`
  read them, and `native_core` came from the removed `RECEIVER_CORE`.
- Docs: gate7-design.md (D34 amended, a G7gd row, the sweep and smoke-rule sentences, Q14d's
  "no decoder is deleted" rule annotated), the README row, `receiver/README.md`,
  `scripts/README.md` and `agents/rs-increment.md`. `docs/` and `protocol/features/` had nothing
  core-specific.

### Checks retired

- `receiver-core@web` (G7l live), `receiver-core` (G7u) and `@<kind>:receiver-core` (G7r): see
  the inventory. They asked which of two cores ran. One core cannot be swapped silently. A
  receiver without its adapter exits 2 (usage) before any record, and a GDScript bundle is refused
  before any host runs.
- `GATE7_WEB_CORE_SABOTAGE=drop-env`, with the check it existed to fail.
- `compare-receiver-cores.ts` (G7xn's byte-identity comparison of the two cores): nothing is left
  to compare. Each gate's checker still judges the receiver against the TypeScript decoder's
  resolved state and the host's reference. The web export is still judged against the native
  legs within G7b's band, with g7b-r1 as its oracle.
- The `web:gdscript:gate5` known failure: only the GDScript web core hit it.

### `gdscript` references left in `scripts/`, `receiver/` and `web/`

All are glue or history:

- `receiver/project.godot`'s `gdscript/warnings/*` (the language's typed-warning levels).
- "GDScript" meaning the receiver's glue language: `rs_perf.gd`, `rs_resource_fetcher.gd`,
  `export_presets.cfg`, `ext/rs_core_ext.cpp`, `gate7-gsw*.ts`'s `receiver-typed-clean` texts,
  `gate7-bench.ts`'s "the GDScript receiver reports no rAF timing", and the `receiver-typecheck`
  comments in `run-gate0.sh` and `run-gate1.sh`.
- The G7gd refusal messages and comments themselves.
- `lib/gate7-adapters.ts`'s `appliedCore()` default and `dropCrossCoreDetail`, plus its
  `gate7b-adapters.ts` use. They read evidence that older source runs (such as g7b-r1's) wrote
  under the GDScript core, so they stay.
- `run-gate7.sh`'s and `requireRustBundle`'s `"gdscript"` fallback when naming an old bundle.
- `test/self-test-gate7l.ts`'s refused-bundle cases.
- `test/self-test-source-key.ts` (GRT's key derivation, unchanged).
- Historical comments in `render-stream-0/1.ts` and `self-test-rs0/1.ts` about the long-gone /0
  and /1 GDScript decoders.

The Rust crates' doc comments still cite `rs_applier.gd` as the origin of a rule (`rs-core`,
`rs-core-capi/src/plan.rs`, `core.rs`). No crate changed in this increment, and the file is in
history at 3b904ca6. The same holds for `web/gsw-receiver/evidence.ts`'s three comments.

### Validation

All runs used `validate-increment.sh` with fast frames on and `RS_LEG_SHARDS=2`, on the Rust
core only. The plan maps 54 changed paths to every target, because the deleted
`compare-receiver-cores.ts` and `replay-receiver-legs.sh` and the pre-existing `profile-decode.ts`
are unmatched. The full tier has sabotage legs, since checkers and runners are in the diff.

- **Pure tier**: green on the pre-rebase base (3b904ca6, 2/2 with the lock tests), on the GRT4a
  base (0917af47; `artifacts/render-stream/validate/g7gd-full-pure/validate-summary.json`), and
  on the final GRT4b base (eb0dae46; `test/run-pure-self-tests.sh`, 57 passed, 0 failed,
  `artifacts/render-stream/validate/g7gd-pure-rebased/`).
- **Smoke**: `native-rust-gate0` passed, including `receiver-typed-clean` with the new selftest.
  The `g7-web-rust` smoke failed in its harness, not in the receiver. `checkGate0Web` reads
  `sabotage-css-opacity/exit-code.txt` unconditionally, and the smoke tier's `@first` leg filter
  never runs that leg (ENOENT, no checks written). This is a pre-existing smoke-tier gap for the
  g7-0 web half: the run selected one leg, and that leg exited 0. The full tier ran the whole
  group and passed.
- **Full tier**, on the GRT4a base: 13 runs, all rc 0, every correctness phase.
  - Native: capture-build, gate −1, 0, 1, 2, 3, 4, 5, 5.5.
  - `g7-gsw`, all file groups (2649 s).
  - `g7-web-rust`, every web-export file group g7-0 to g7-6 on the rebuilt Rust-only bundle,
    within G7b's band (3772 s).
  - `g7live-gsw` and `g7live-web-rust` (g7-1, g7-2, g7-5, g7-55).

  Per-run `rc` and `wall_s` are under `artifacts/render-stream/validate/g7gd-full2/`, with the
  log at `validate.log`. The run was stopped at the timing phase, so no `validate-summary.json`
  was written.
- **Load-deferred to the pre-G7v milestone sweep** (timing phase, GRT4a's last phase):
  `native-rust-gate6`, `g7live-gsw-timing`, `g7live-web-rust-timing`, `g7live-native-timing` and
  `g7x`. The machine's 1-min load sat at 5–16 for most of the afternoon (another user session,
  per the orchestrator). It was 3.2 when the correctness phases finished at 17:54, the six-hour
  budget point, and these runs need roughly 2–3 h more. The orchestrator's instruction allows
  leaving them for the milestone sweep.
- Not run: `cargo-*` (no crate changed), `pnpm-test` (packages untouched; known headless-shell
  failure), `lock-tests` after the rebase (no lock code changed; green pre-rebase).
- `tsc --noEmit -p experiments/render-stream` is clean on every base.
