### G7xd — flip the default receiver core to rust (sonnet, rs-increment agent)

D34's amendment (2026-10-17, user-approved): the GDScript decode/apply path is demoted, frozen at
/7, milestone sweeps only. "An increment flips the native and web-export default to
`RS_RECEIVER_CORE=rust` behind a full sweep" — this is that increment. No decode, validate,
resolve or apply code changes: every byte G7xn, G7xw, G7xwl and G7o2 already proved equal between
the two cores stays equal. Only the "which value wins when nothing says otherwise" plumbing moves.

- **Files**:
  - `receiver/receiver.gd`: `_parse_core_env()`'s empty-env fallback (`"gdscript"` -> `"rust"`),
    `_core_kind`'s initial value, and the `RS_RECEIVER_CORE`/`RS_RECEIVER_CORE_EXT` doc comment.
  - `receiver/rs_rust_applier.gd`, `receiver/ext/rs_core.gdextension`: prose only (no longer "the
    default stays gdscript" / "the default path never loads it").
  - `scripts/lib/legs.sh`: `RECEIVER_CORE`'s fallback and `receiver_core_env`'s "already the
    default, add nothing" guard both flip to `rust`; a non-empty `RECEIVER_CORE_EXT` now still
    forwards even when `RECEIVER_CORE` reads the (new) default, since `rust`+a custom extension
    path is a now-meaningful combination that `rust`+none-at-all used not to be.
  - `scripts/replay-receiver-legs.sh`: the sourcing-time placeholder that keeps its own per-leg
    `RS_RECEIVER_CORE` from clashing with `lib/legs.sh`'s `receiver_core_env` flips to `rust`
    (the new default `receiver_core_env` no-ops on).
  - `scripts/build-web-receiver.sh`, `scripts/web-build-json.ts`: `--core`'s own default flips to
    `rust` (dead in every orchestrated caller, which always passes `--core` explicitly, but kept
    consistent for a bare manual invocation).
  - `scripts/run-gate7.sh`, `scripts/check-gate7.ts`, `scripts/gate7-tool.ts`,
    `scripts/gate7-bench.ts`: every `--web-core`/`--core` default flips to `rust`; `gdscript` stays
    explicitly selectable everywhere.
  - `scripts/lib/gate7-live-legs.ts`: `webCoreOf()`'s empty-`GATE7_WEB_CORE` resolution flips to
    `rust` (and now refuses a plain `gdscript`-only bundle under the *default*, not just under an
    explicit `--web-core rust`); `coreEnv()` flips which selection adds the env word
    (`RS_RECEIVER_CORE=gdscript` on a `gdscript` run, nothing on `rust`, default or explicit); the
    `drop-env` sabotage's meaningful case flips from "`rust` run silently falls back to gdscript"
    to "`gdscript` run silently falls back to rust" (the rust-capable bundle's own unset-env
    default, post-flip).
  - `scripts/lib/gate7-web-legs.ts`: the file-leg replay path's env-forwarding flips the same way.
  - `scripts/lib/gate7-live.ts`: `knownFailure`'s and `checkGateLive`'s default-core parameters
    flip to `rust`; `receiverCoreProblems`'s doc comment updated (the function's own pass/fail
    logic is symmetric in `core` and needed no change).
  - `scripts/test/self-test-gate7l.ts`: the `webCoreOf`/`coreEnv` cases rewritten for the flipped
    defaults (a default `rust` run now needs a rust-capable bundle; `gdscript` is the one that
    adds the env word; `drop-env` is meaningful on `gdscript`, a no-op on `rust`), and the two
    `knownFailure` calls that relied on its default parameter meaning "gdscript" now say so
    explicitly.
  - `scripts/lib/gate1-live-checks.ts`, `scripts/lib/gate2c-checks.ts`: found by the sweep itself,
    not planned ahead of it — `checkLiveReplayEqualsLive`'s state-dump comparison was raw text
    (`sa !== sb`) instead of parsed-and-canonical like every sibling state-dump check in the same
    files; byte-identical only by coincidence while both sides' JSON float spelling happened to
    agree, which the flip broke (native's `rust`-core dump now spells whole floats the way
    `canon::write_state`'s JS-number mode does, not GSW's). Switched both to `readJson` +
    `canonicalEqual`/`statesEqual` (results doc "What changed" has the detail).
  - `receiver/README.md`, `scripts/README.md`, `experiments/render-stream/README.md`,
    `protocol/gate7-design.md` (D34), `protocol/gate7/g7xn.md`, `protocol/gate7/g7xwl.md`,
    `results/gate7/g7xn.md`, `results/gate7/g7xw.md`: every present-tense "the default stays/is
    gdscript" sentence gets a dated amendment note; nothing is rewritten as if it were never true.
- **Not touched**: `rs-core`, `rs-core-capi`, `rs_core_ext.cpp`, any decoder, validator, resolver
  or applier code, any wire format, `export_presets.cfg`'s preset contents (only its surrounding
  prose), and the frozen GDScript decode/apply path itself (D34: still reachable, still
  byte-identical, just no longer the unlabelled choice).
- **Checks**: a full milestone sweep (gate7-design.md "Scoped re-runs and milestone sweeps"),
  because this increment is explicitly one of the three sweep triggers ("before anything adopts a
  new receiver default"): every landed `g7-*` group on GSW and on the web export on both cores
  (file and `--live`), native gates 0 to 6 under both `RS_RECEIVER_CORE` values, every pure
  self-test, `cargo test` in `rs-core` and `rs-core-capi`, `rs-core-check goldens` natively and as
  wasm in Node, and `self-test-rs-core.ts`/`self-test-record-digest.ts` on the G7x bench inputs.
  Results: [results/gate7/g7xd.md](../../results/gate7/g7xd.md).
- **Known, expected failures** (D34, G7b; unaffected by this increment, not fixed here): the web
  export on the GDScript core's g7-5 mesh legs (`web-index-region-update`, the Godot 4.5.1 WebGL
  bug); `RS_RECEIVER_MEMORY_BUDGET_BYTES=200000` on the GDScript receiver on gate 6
  (pre-existing segfault); `pnpm typecheck` in `packages/test-harness/src/canvas-pixel/
  upload-bench-entry.ts`; `pnpm check` red on baseline.
- **Commit**: `feat(render-stream): …` with `Changelog: none` (experiment code; no published
  `packages/*` export changes).

#### As built

See [results/gate7/g7xd.md](../../results/gate7/g7xd.md) for the sweep table, wall time, reruns
and any regression found.
