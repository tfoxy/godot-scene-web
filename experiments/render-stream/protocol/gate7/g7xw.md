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
- **As built (G7xw, 2026-10-16; [results/gate7/g7xw.md](../../results/gate7/g7xw.md)).** Step 0
  passed. Every web file leg of gates 0 to 6 reproduces G7b on the Rust core, and g7-5 now passes on
  the web.
  - **Toolchain (F4).** `nightly-2025-10-15` (rustc 1.92.0-nightly `844264add`, LLVM 21.1.3, the
    same major as emcc 4.0.11's clang) with `rust-src`, used only by
    `scripts/build-rs-core-web.sh`. The flags are `-Zbuild-std=std,panic_abort` and `RUSTFLAGS="-C
    relocation-model=pic -C panic=abort -Z default-visibility=hidden"`. Without the last flag,
    emcc refuses the link: Rust's PIC objects export every mangled std symbol. The link is `em++
    -sSIDE_MODULE=2 -sWASM_BIGINT -sEXPORTED_FUNCTIONS=_rs_core_ext_init`. The 1.1 MB module
    imports 43 libc/libc++ functions from the template's `MAIN_MODULE=1`/`EXPORT_ALL` main module.
    `build.json` records the nightly's manifest hashes, emcc and every sha256. The official
    4.5.1 dlink template's engine reports Emscripten **4.0.10**, and the 4.0.11 side module loads
    into it.
  - **Preset and loading.** `preset.1` `Web (rust core)` (dlink template, extensions on) is
    exported only by `build-web-receiver.sh --core rust`, which stages `ext/` without its
    `.gdignore`. The editor then lists `rs_core.gdextension` (`web.wasm32`) in
    `extension_list.cfg`, the export copies the module beside the engine, the engine preloads it
    and loads the extension at startup, and `RsRustApplier.load_core()` finds `RsCore`
    registered. No receiver GDScript changed.
  - **`web-index-region-update` closed.** Around the one RenderingServer call
    `mesh_surface_update_index_region`, the shim's EM_JS guard redirects the engine's
    `GL_ARRAY_BUFFER` bind and `bufferSubData` to `GL_ELEMENT_ARRAY_BUFFER`, with the vertex array
    unbound and then restored. The nothreads build runs that call synchronously, and libdylink
    evaluates EM_JS in the main module's scope (`GLctx`). Gate 5's mesh legs then match native in
    Q7's band, and g7-5 passes 45/45.
  - **Harness.** `run-gate7.sh --web-core rust`, `gate7-tool.ts web-legs --core rust` and
    `gate7-bench.ts --arm web --core rust` (legs `*-web-rs*`). The web bench arm is now
    cross-origin isolated (5 µs timers). Across cores, `applied-equals-native` compares a failure's
    seq and reason, not its prose. The shell's heap probe reads the dlink build's imported memory.
  - **Limits.** A core panic aborts the page on the web (`panic=abort`, no C++ exception runtime);
    natively it is caught as `internal`. On the g31 the Rust core passes `scene-patch` (6.34 ms)
    and `pace-patch` (2.69 ms) at p95 and misses `scene-full` (10.56 ms) and `hd-patch` (14.98 ms)
    against 8.51 ms, 3.4× to 11.8× better than G7m's GDScript web export. `hd-patch` is bound by
    the engine's own apply work. `scene-full`'s decode carries the inline record digest that D31
    would move off the frame.

