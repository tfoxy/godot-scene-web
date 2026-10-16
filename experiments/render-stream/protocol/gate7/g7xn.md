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

