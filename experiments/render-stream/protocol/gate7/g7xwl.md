### G7xwl — the web export's live legs on the Rust core (opus)

- **Why.** G7xw put the shared Rust core into the web export, but `run-gate7.sh --web-core rust`
  refused `--live`. The adapter validated every stream at render-stream/6 (`rs-core-capi`'s fixed
  `VERSION`), and the web's live legs speak /7 (G7l). G7v's and G7k's phone legs want the fast
  core live.
- **What /7 asks of the core.** Nothing new in `rs-core`. A /7 stream's records are /6's byte
  for byte. Only the magic, the protocol string and the session's `publication.credit_window`
  differ (render-stream-7.md), and `rs-core`'s validator already gates all three on its `version`
  (G7w, golden-7). The gap was in the adapter alone.
- **Files.**
  - `rs-core-capi`: `Core::session(data, offset, version)` and `rsc_session(…, version)` take the
    stream's version. Only 6 and 7 are accepted (`VERSIONS`), and anything else fails
    `bad-magic`. The version is kept per stream for `begin_session`, `provide` and the failure
    decode. `rs-core-capi-check` reads it from the recording's magic.
  - The shim (`receiver/ext/rs_core_ext.cpp`, `rs_core_capi.h`): `session` takes a third
    argument. `RsRustApplier.accept_session(data, offset, version)` and `receiver.gd` pass
    `_wire_version`. That is 7 on a /7 live connection and on a GRS7 file replay (a live-replay
    of `received.rs7`), and 6 otherwise.
  - Harness: `run-gate7.sh --live --web-core rust` (no longer refused) builds or checks a
    `--core rust` bundle and gives the gate runners `GATE7_WEB_CORE=rust`. The browser daemon
    (`gate7-tool.ts browser-daemon --core`, `lib/gate7-live-legs.ts` `webCoreOf`/`coreEnv`) then
    adds `RS_RECEIVER_CORE=rust` to every web leg, live or replay, and refuses a bundle that is
    not `--core rust`. `check-gate7.ts --live --web-core rust` judges the result.
- **Checks.**
  - `g7-1`, `g7-2`, `g7-5` and `g7-55` live on `web` under `rust` pass every gating check G7l
    defines. That includes g7-5's five mesh pixel checks, which G7l's GDScript web core fails on
    `web-index-region-update`. Under `rust` the known-failure note no longer applies
    (`LIVE_KNOWN_FAILURES` is keyed by core), so nothing there is excused.
  - New `receiver-core@web`, on every web live run. Each browser leg must show three things:
    - receiver.gd's `core rust (<path>)` log line, written when the adapter loads and before any
      record, in `stdout.log` or `console.jsonl` (a SIGKILLed leg keeps only the latter);
    - applied.json's `receiver.core` set to `rust`, when the leg wrote one (a SIGKILLed leg does
      not);
    - the side module `librs_core_ext.wasm` in the page's resource timing (except on a leg
      aborted before its page state was read).

    A `gdscript` run must show neither the log line nor `core` `rust`.
  - Same tree, same day: the same groups on the `gdscript` web core (G7l's baseline, the five
    known failures expected) and on `gsw`, which is unchanged.
  - `cargo test` in `rs-core-capi`:
    - golden-7's `rate.rs7` issues exactly golden-6's `rate.rs6` RenderingServer calls under
      every sabotage, with delta equal to `full_scan`;
    - `window2.rs7` issues those calls plus two empty batches for its idle patches;
    - a /6 session read at /7 is refused, and so is the reverse;
    - golden-7's two `publication-entry` invalids fail at the session.
- **Sabotages.**
  - `GATE7_WEB_CORE_SABOTAGE=drop-env` keeps the `rust` run and its `--core rust` bundle but
    leaves `RS_RECEIVER_CORE` out. The bundle still loads the side module, and the receiver
    silently runs GDScript. `receiver-core@web` must fail on every browser leg and nothing else
    may fail. This is the fallback a silent build or flag regression would produce.
  - `--web-core rust` with a `gdscript` bundle is refused by `run-gate7.sh` and by the daemon,
    never run.
- **Re-runs** (gate7-design.md "Re-runs": `receiver/` and the Rust crates):
  - native gates 0 to 6 under both `RS_RECEIVER_CORE` values;
  - `cargo test` in `rs-core` and `rs-core-capi`;
  - `rs-core-check goldens`, natively and as wasm in Node;
  - `self-test-rs-core.ts` on the four bench inputs;
  - every pure self-test;
  - every landed `g7-*` web file group on both cores, with shots compared to G7b's.
- **Native `/7` under `rust`.** The native receiver speaks /7 only under an explicit
  `RS_RECEIVER_PROTOCOL=7`, and no native gate leg sets it. The same adapter path covers it, so
  it falls out of this change without a leg of its own (results file).
