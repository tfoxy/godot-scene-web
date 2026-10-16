### G7xn — native GDExtension adapter for the core (opus)

D34's first adapter, proven natively, where it is easiest to debug, before the web export loads
it. Void if F4 is declined, because G7xn has no other consumer in gate 7.

- **Files**:
  - `experiments/render-stream/rs-core-capi/` (Q14e's C ABI).
  - `receiver/ext/`: the C++ shim over raw `gdextension_interface.h`, its `.gdextension` file and
    `scripts/build-rs-core-ext.sh` (native).
  - `RS_RECEIVER_CORE=gdscript|rust` in `rs_config.gd`, default `gdscript`.
  - `receiver.gd`'s decode and apply call sites routed through the core. Apply for changed items
    runs from native code as RenderingServer ptrcalls, while GDScript keeps config, IO, evidence
    and shots.
  - The native bench arm for both cores.
- **Checks**:
  - every native receiver leg of gates 0 to 6 under `rust`, with the same classes and shots
    byte-identical to the `gdscript` legs of the same source run;
  - `applied.json` equal except timings and `receiver`;
  - the default path unchanged (gates 0 to 6 natively);
  - the native bench on desktop for both cores, with the per-phase table in "Gate 7xn result".
- **Sabotages**: each gate's receiver sabotages under `rust`, with their native sets.

- **As built (G7xn, 2026-10-16; [results/gate7/g7xn.md](../../results/gate7/g7xn.md)).** Every
  native receiver leg of gates 0 to 6 reproduces under `rust`. The default stays `gdscript`.
  - **Shape.** `rs-core-capi` is a staticlib on stable 1.95.0 with no new crates. `core.rs` wraps
    the `Validator` (render-stream/6, `Inline` digest). `plan.rs` ports `rs_applier.gd` (its rules,
    order, `rs_calls`, stats and 15 sabotages) into a RenderingServer call stream of 65 opcodes. It
    visits only what each transaction touched, and `full_scan` is the cross-check.
    `receiver/ext/rs_core_ext.cpp` registers `RsCore` over the raw `gdextension_interface.h` and
    runs the stream as ptrcalls. The switch is read in `receiver.gd` (`_parse_core_env`, through
    `RsConfig.get_env`), not in `rs_config.gd`. `RsRustApplier` stands in for `RsApplier` and
    `Rs2Decoder.Stream`. The adapter loads through `GDExtensionManager` only under `rust`.
  - **Checks.** Classes and checks are equal per gate: −1 29/29 (no receiver), 0 24/24, 1 66/66,
    2 85/85, 3 56/56, 4 185/185, 5 116/116, 5.5 130/130 and 6 154/154 on both cores. The
    `gdscript` gate 6 got there through its one allowed rerun of g6l and g6c (63/63), after a
    loaded first run (144/154). A same-source replay of the `gdscript` runs' file legs covered
    gates 0 to 6: 141 legs, 1 338 shots byte-identical, 355 state dumps equal. `applied.json` was
    equal everywhere except one decoder-prose `failure.detail` (gate 0 `corrupt`, same reason).
    `rs-core-capi-check legs` matched 186 legs per transaction, live and rate legs included.
  - **Found while validating.** An empty `receiver/ext/.gdignore` was byte-identical to gate 4's
    fixture `.gdignore`, which failed `receiver-never-loaded-fixture`; it now has a comment. The
    replay tool now seeds a warm cache the runner prepared (gate 2 ignore-cache). The compare tool
    now normalizes both run roots. The capi check falls back to the receiver cache when a host
    keeps its store in memory. G7b's `mesh_web_refused` stat is supplied empty under `rust`.
  - **Bench** (desktop, `--taskset 11`, p95 ms, `gdscript` → `rust`): decode 6.528 → 0.164
    (`scene-full`), 1.696 → 0.066 (`scene-patch`), 14.080 → 0.312 (`hd-patch`) and 0.360 → 0.039
    (`pace-patch`). Apply 1.184 → 0.106, 1.184 → 0.078, 10.496 → 0.392 and 0.102 → 0.035.
  - **For G7xw.** It needs `SIDE_MODULE` flags without `-z defs` or `--exclude-libs`. The dlink
    export may need the extension in `extension_list.cfg`. `plan.rs` lacks G7b's
    `web-index-region-update` refusal.
