### G7xw — web-export dlink adapter for the core (opus; g31 run unattended)

- **Prerequisite**: F4, a pinned nightly with `rust-src`. If it is not approved, the increment is
  void (D33, D34).
- **Step 0, the toolchain probe.** Build a Rust staticlib for `wasm32-unknown-emscripten` with
  `-Zbuild-std` and `-C relocation-model=pic`. Link it with the shim into a `SIDE_MODULE` using
  emcc 4.0.11, load it in the dlink template, and make one call that returns a constant. If that
  fails, stop and report the error. The fallback choice goes to the user: the JavaScriptBridge
  split of D34, or GDScript with G7o's GDScript tier 1.
- **Files**:
  - a second preset, `Web (rust core)`, with `variant/extensions_support=true` and the dlink
    template, its sha256 pinned;
  - `build-web-receiver.sh --core rust`;
  - the side-module build;
  - `build.json` recording the nightly's version, emcc's version and each artifact's sha256.
- **Checks**:
  - `g7-0..g7-6` web file legs under `rust`, with classes equal and shots byte-identical to G7b's
    GDScript web legs;
  - G7m's web bench arm on desktop and then the g31, under Q13e's rule against the D25 budget;
  - startup (D15) of the dlink build against the nothreads build, reported.
- **Sabotages**: the gate 0 receiver sabotages through `--rs-env` under `rust`, with their native
  sets.

