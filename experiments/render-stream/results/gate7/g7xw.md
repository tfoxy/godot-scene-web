## Gate 7xw result (2026-10-16)

G7xw ([protocol/gate7/g7xw.md](../../protocol/gate7/g7xw.md);
[gate7-design.md](../../protocol/gate7-design.md) D29 to D34, Q4, Q14e, Q13e, fork F4) loads the
shared Rust core into the web export. G7xn's C ABI (`rs-core-capi`) and its C++ shim are built as an
emscripten dlink side module, and a second preset, `Web (rust core)`, exports it with the dlink
template. `RS_RECEIVER_CORE=rust` (through `--rs-env`) then decodes, validates, resolves and applies
through the core, exactly as G7xn does natively.

- **Correctness.** Every web file leg of gates 0 to 6 reproduces G7b on the Rust core. That is 126
  legs, 62 of them sabotages: 4 in gate 0 and 58 in gates 1 to 6. Outside g7-5's mesh legs,
  classes and checks are equal, and 1 275 of 1 311 shots are byte-identical to G7b's own web shots.
  The other 36 are the shots G7b could not draw.
- **`web-index-region-update` is closed.** The adapter uploads the index region through
  `GL_ELEMENT_ARRAY_BUFFER`, so **g7-5 passes on the web** (45/45; G7b 36/45). Its mesh legs now
  fall inside Q7's web band against native, like every other leg.
- **The phone.** On the moto g31, the Rust core passes `scene-patch` and `pace-patch` and misses
  `scene-full` and `hd-patch`. Every input is 3.4× to 11.8× faster at p95 than G7m's GDScript web
  export. The misses are `device-decode-over-budget` (below).

### Step 0: the toolchain probe

It passed on the first pinned nightly tried, so the D34 fallback (the JavaScriptBridge split or
GDScript) did not arise.

- **Toolchain.** `nightly-2025-10-15` is rustc 1.92.0-nightly `844264add`, with LLVM 21.1.3. That is
  the same LLVM major as emcc 4.0.11's clang 21, and that is why this date was chosen. It was
  installed with `rustup toolchain install nightly-2025-10-15 --profile minimal --component rust-src`
  and is used only by `scripts/build-rs-core-web.sh`. Stable 1.95.0 stays the default.
  - The channel-manifest hashes of the four components are in `receiver/ext/build/web/build.json`
    and the bundle's `rs-core-web-build.json`. For example, rust-src xz
    `c4979b87…1276` and rustc xz `ab54f228…ae3c`.
  - The std crates of `-Zbuild-std` came from rust-src's own `library/Cargo.lock`. `rs-core-capi`
    builds `--locked` against its own lockfile and needs no new crates.
- **Build.** `cargo +nightly-2025-10-15 build --release --lib -Zbuild-std=std,panic_abort --target
  wasm32-unknown-emscripten`, with `RUSTFLAGS="-C relocation-model=pic -C panic=abort -Z
  default-visibility=hidden"`. The shim is built with `em++ -fPIC -fno-exceptions`. The link is `em++
  -sSIDE_MODULE=2 -sWASM_BIGINT -sEXPORTED_FUNCTIONS=_rs_core_ext_init`.
- **The one build failure.** Without `-Z default-visibility=hidden`, emcc 4.0.11 refuses the link
  with `invalid export name: _ZN4core3fmt3num3imp54_$LT$impl…`. Rust's PIC objects give every
  symbol default visibility, so wasm-ld would export std's mangled names.
- **The module.** It is 1 117 766 B (sha256 `5a140f2b…b6aa`). It exports only `rs_core_ext_init`
  plus wasm-ld's `__wasm_call_ctors` and `__wasm_apply_data_relocs`. It imports 43 functions, all
  libc/libc++ (`malloc`, `pthread_mutex_*` stubs, `std::string` internals) and its two EM_JS
  functions, which the template's `MAIN_MODULE=1`/`EXPORT_ALL` main module provides. `module-info.json`
  lists them.
- **The probe.** A throwaway project with only `rs_core.gdextension` and a script calling the new
  constant method `RsCore.op_count()` was exported with the dlink template and opened in harness
  Chromium (D9). It printed `RS_PROBE class_exists=true op_count=66
  extensions=["res://ext/rs_core.gdextension"]`.
  - The engine banner reads **`Build configuration: Emscripten 4.0.10, single-threaded, GDExtension
    support`**. The official 4.5.1 template was built with emscripten 4.0.10, not the 4.0.11 that
    Q13e names. The 4.0.11 side module loads into it without complaint.

### What was built

- **`scripts/build-rs-core-web.sh`** (new) builds the staticlib and links the side module into
  `receiver/ext/build/web/librs_core_ext.wasm`, which is ignored. It checks the exports and writes
  `build.json`: the nightly's `rustc -vV`, the manifest component hashes, emcc's version and every
  artifact's sha256. `scripts/lib/wasm-side-module-info.mjs` summarizes the module's dylink, export
  and import sections.
- **`receiver/export_presets.cfg`** gains `preset.1`, `Web (rust core)`. It is `preset.0` with
  `variant/extensions_support=true` and `@RS_WEB_DLINK_TEMPLATE@`, which is
  `web_dlink_nothreads_release.zip`, sha256 `68162ae9…d454` and checked before every export.
  `rs_core.gdextension` gains `web.wasm32 = "build/web/librs_core_ext.wasm"`.
- **`build-web-receiver.sh --core rust`** does five things:
  - runs `build-rs-core-web.sh`;
  - stages `ext/` without its `.gdignore`, so the editor lists the extension in
    `extension_list.cfg` and the export plugin copies the side module beside the engine;
  - adds the module's sha256 to the source digest;
  - refuses a bundle whose copy of the module differs;
  - records `core`, the preset index and `rs_core_web` in `build.json`.

  The default (`gdscript`) build is G7e's. Its `.pck` lists 18 entries, and the rust bundle's
  lists 20: the same 18 (all identical except `uid_cache.bin`), plus `ext/rs_core.gdextension` and
  `.godot/extension_list.cfg`.
- **The index-region guard** (`rs_core_ext.cpp`, `#ifdef __EMSCRIPTEN__`). It applies to the one
  opcode that ends in `mesh_surface_update_index_region`. Two EM_JS functions wrap that
  RenderingServer call, which the nothreads build runs synchronously, so the engine's own three GL
  calls are redirected:
  - `glBindBuffer(GL_ARRAY_BUFFER, b)` binds `b` to `GL_ELEMENT_ARRAY_BUFFER`, with the vertex array
    unbound;
  - `glBufferSubData(GL_ARRAY_BUFFER, …)` uploads there;
  - the closing `glBindBuffer(GL_ARRAY_BUFFER, 0)` unbinds the element buffer and restores the
    vertex array.

  The engine's index buffer handle is never needed. EM_JS bodies run inside the main module's scope
  through libdylink's direct `eval`, so they see `GLctx`. Natively, the shim only gains `op_count`.
- **Harness.**
  - `gate7-tool.ts web-legs --core rust` adds `RS_RECEIVER_CORE=rust` to every leg, and refuses a
    bundle that is not `--core rust`.
  - `run-gate7.sh --web-core gdscript|rust` drives the bundle, the web legs and the web bench arm.
  - `gate7-bench.ts --arm web --core rust` names its legs `*-web-rs[-<id>]`.
  - The web arm's harness server is now cross-origin isolated, like the gsw arm's.
    `Time.get_ticks_usec()` then resolves to 5 µs rather than Chrome's coarsened 100 µs, which the
    sub-millisecond Rust phases need. G7m's numbers, tens of ms, were taken without it.
- **`check-gate7.ts`.** `applied-equals-native` across cores (a `rust` web leg against its
  `gdscript` native leg) compares a failure's `seq` and `reason` but not its `detail` prose. That is
  G7xn's `detail_only` rule. Gate 0's `corrupt` leg is the only case: the GDScript decoder reports
  "meta byte 0 is 0x00, not printable ASCII", and the core reports "meta contains a
  non-printable-ASCII byte".
- **`receiver/web/shell.html`.** The dlink main module imports its memory, which it shares with the
  side modules, rather than exporting it. The D16 heap probe `__rsWasmHeap()` now also takes the
  `env.memory` passed to `WebAssembly.instantiate`. Without that it read `null` on the rust bundle
  (it now reads 55 MB median on g7-0, the same as nothreads).

**Not done here.** Natively a core panic is caught and reported as `internal`. On the web, with
`panic=abort` and no C++ exception runtime in the main module, a panic aborts the page instead.
No leg panicked.

### Correctness: gates 0 to 6 web file legs on the Rust core

Two complete runs, each on fresh native sources from `run-gate7.sh --make-sources`.
`source-run-valid@web` passes in each, because every source was made on the same build.

- **First run: this change on `main` `c9f47553`** (`815a022b`), sources in `…/g7xw/gd/sources-made/`.
  - `gd/` is the `gdscript` web legs, with the G7b method and G7b's bundle shape: a same-build
    baseline.
  - `rs-a` to `rs-e` are the `rust` web legs on the same sources, one run per group as each source
    landed, on bundle `07696042…`.
- **Second run: after rebasing onto `main` `f85ec159`**, which brings in G7l's live-path
  `receiver.gd` and the per-leg quiet lock (`324fa962`). Fresh sources are in `…/g7xw/post/`, and
  the `rust` web legs, again per group as sources landed, are in `post-0` to `post-6` on bundle
  `6e4abd72…`.
  - Every check verdict and every shot is the same as in the first run. That is the "Post-rebase"
    column below.
  - The bench's desktop arm and the startup legs ran on this build. The g31 arm ran on the first.
- **The side module is the same file in every build:** sha256 `5a140f2b…b6aa` in both bundles and
  in the final tree. After the runs, only comments changed under `receiver/` (the shim's guard
  comment and `receiver/README.md`).

| Group | Legs (sabotages) | `rust` gating checks | G7b | Same-build `gdscript` | Shots identical to G7b's web shots | `rust` vs same-build `gdscript` (compare-receiver-cores) | Post-rebase `rust`: checks, shots identical to G7b |
| --- | --- | --- | --- | --- | --- | --- | --- |
| g7-0 | 9 | 20/20 | 20/20 | 20/20 | 35/35 | 9/9 legs (1 detail-only), 35/35 shots | 20/20, 35/35 |
| g7-1 | 11 (7) | 26/26 | 26/26 | 26/26 | 151/151 | 11/11, 151/151, states 26/26 | 26/26, 151/151 |
| g7-2 | 14 (7) | 29/29 | 29/29 | 29/29 | 108/108 | 14/14, 108/108, states 162/162 | 29/29, 108/108 |
| g7-3 | 14 (8) | 32/32 | 32/32 | 32/32 | 120/120 | 14/14, 120/120, states 10/10 | 32/32, 120/120 |
| g7-4 | 20 (8) | 70/70 | 70/70 | 70/70 | 222/222 | 20/20, 222/222 | 70/70, 222/222 |
| g7-5 | 18 (11) | **45/45** | 36/45 | 36/45 | 144/180 | 12/18, 144/180, states 30/30 (below) | 45/45, 144/180 |
| g7-55 | 21 (9) | 45/45 | 45/45 | 45/45 | 210/210 | 21/21, 210/210, states 30/30 | 45/45, 210/210 |
| g7-6 | 19 (8) | 31/31 | 31/31 | 31/31 | 285/285 | 19/19, 285/285, states 36/36 | 31/31, 285/285 |

- **Results equal check by check.** `cmp-results.py` finds every check's verdict equal between the
  same-build `gdscript` run and G7b's `result.json`, including g7-5's nine failures. Between the
  `rust` runs and G7b, every verdict is equal outside g7-5.
- **Every leg class is equal**, including all 62 receiver and host sabotage legs (gate 0's
  freeze/omit/perturb/css-opacity, and every gate's `RS_RECEIVER_SABOTAGE` legs). Each kept its
  native set through `--rs-env` under `rust`. The exception is g7-5's three mesh sabotages, which
  classify as they do natively again, where G7b's were `unsupported`.
- **Shots are byte for byte the same.** The recordings differ from G7b's at the byte level (each
  session has its own ids), yet every shot G7b drew is byte-identical. Q7's `readback`/`delta1` band
  against native is the same pixel for pixel: `pw1-classes@web` reports the same counts as G7b
  everywhere outside g7-5.
- **`process_frame` differs on many web legs.** That is the frame on which a fetch completed or a
  shot was taken, and the web's HTTP fetch timing is not repeatable. It is excluded as timing, as in
  G7xn.

**g7-5, the index-region update.**

- The six legs that differ from the same-build `gdscript` run are the six mesh legs: `receiver`,
  `-patch`, `-inline` and the three mesh sabotages. They differ only by that update:
  - `gdscript` refuses it at seq 41 (`web-index-region-update` in `unsupported`);
  - `rust` issues it, which adds one `rs_calls` entry, one `surface_updates`, 12 more
    `mesh_upload_bytes` and the index buffer in `mesh_uploads`, exactly as native does.
- Their 36 shots, from step 4 on, are the 36 `other` shots of G7b's table. They now fall in the
  band.
- The nine checks G7b failed pass:
  - `leg-class-receiver-mesh{,-patch,-inline}`;
  - `receiver-vs-reference-mesh`, `receiver-mesh-uploads` and `fresh-without-redraw-receiver`;
  - the three mesh sabotages, which classify as `pixel-mismatch` again instead of `unsupported`.
- `web-refusals@web` reports none. `applied-equals-native@web` is now exact on the mesh legs.
- `pw1-classes@web` counts 180 shots: 80 identical, 18 readback-only, 82 with delta1 pixels, and 0
  other. G7b had 44 identical, 18, 82 and 36.

**Native, after the shim change.** The native shim changed only by gaining `op_count`. As a
sanity check, `replay-receiver-legs.sh --core rust` was run over the new gate 5 source, and
`compare-receiver-cores.ts` found 21/21 legs, 180/180 shots and 30/30 states equal to the
`gdscript` source (`…/native-rs-replay/`). No GDScript file changed, so the native gates were not
rerun.

### The g31 bench (Q13e, G7m's method)

The command was `gate7-bench.ts --arm web --core rust --env device --device g31 --inputs
<inputs.json>`, with one warmup and five repeats per input, every repeat valid. It ran on 2026-10-16
from 15:11 to 15:20 UTC, under the standing approval.

- **Inputs.** G7x's four bench recordings. They were copied from the main checkout's
  `artifacts/render-stream/gate7/g7x/inputs/` into this worktree, and all 978 files of the copy
  (recordings and stores) are sha256-identical to the source (`inputs-sha256.txt`). The recordings
  are `scene/capture/recording.rs2` `3a1a0875…831c`, `recording-patch.rs2` `0a7daa1c…29df`,
  `hd/…/recording-patch.rs2` `c9aaaacc…967b` and `pace/…/recording-patch.rs2` `6b26220e…a006`.
  These are the same recordings G7m's and G7xn's benches used.
- **Budget.** The run's rAF probe gave 0.5·T_p = **8.510 ms** (T_p 17.02 ms).
- **cpufreq**, sampled every 30 s over 19 samples. The A75 stayed at 2.0 GHz uncapped, with dips to
  1.71 GHz, and the A55 had normal DVFS. Only the final sample, taken at teardown after the last
  repeat, shows the A75 capped at 1.354 GHz (`derated`), which is the same teardown artifact G7m saw.
  Thermal status stayed `none` (the hottest sensor peaked at 48.6 °C), the battery stayed at 100 %,
  and the battery temperature rose from 21.5 °C to 24.2 °C.
- **Session.** The settings were restored, and no adb forward or reverse was left.

Milliseconds, pooled over the five repeats. `total` is p95(decode) + p95(apply), G7m's upper
bound. `decode` is `accept`: framing, meta, validation, resolve and the `Inline` record digest.
`apply` is `needed` + `provide` + `apply`, including the engine's own RenderingServer work.

| Input | Decode p50 / p95 | Apply p50 / p95 | Total p95 | vs 8.510 | G7m web export p95 | Gain |
| --- | --- | --- | --- | --- | --- | --- |
| `scene-full` | 4.224 / 6.528 | 1.504 / 4.032 | **10.560** | **over** (+24 %) | 54.528 | 5.2× |
| `scene-patch` | 0.784 / 2.112 | 0.880 / 4.224 | **6.336** | pass (2.17 ms headroom) | 29.440 | 4.6× |
| `hd-patch` | 2.880 / 4.992 | 4.480 / 9.984 | **14.976** | **over** (+76 %) | 176.128 | 11.8× |
| `pace-patch` | 0.880 / 1.376 | 0.816 / 1.312 | **2.688** | pass (5.82 ms headroom) | 9.152 | 3.4× |

**D27 verdict for the web export on the Rust core, g31: not met on `scene-full` and `hd-patch`.**
These are `device-decode-over-budget` (receiver `web`, core `rust`). The web export now sits below
GSW's TypeScript decoder on the same phone and inputs (G7m: scene-full p95 12.99 ms, hd-patch
16.79 ms, which do not include an apply), where G7m had it 4× to 10.5× above.

The shape of the two misses:

- **`hd-patch` is apply-bound.** Apply is 67 % of its p95. `apply_us` includes the engine's own
  wasm RenderingServer work for the items each transaction redraws (a 496-item scene) as well as
  the adapter's. This bench does not separate the two. The same apply p95 is 0.39 ms natively on
  desktop (G7xn) and 1.44 ms in the desktop web export (below).
- **`scene-full` is decode-bound.** Every transaction is a full record, and `decode_us` includes
  its inline record digest: the Godot adapters keep D31's digest `Inline`. D31 lets a browser
  receiver compute it after the frame. That lever is not measured here, and it is left to an owner
  (below).
- **Small transactions show a fixed per-call cost.** `pace-patch` carries a single transform per
  transaction. It costs about 0.9 ms of decode and 0.8 ms of apply on the phone, against 0.09 and
  0.06 ms on desktop: a 9× to 13× ratio, above the 5.7× to 7.6× of the large inputs. The likeliest
  cause is the GDScript marshalling around the core (Variant trees, `needed()`, counters), which is
  not profiled here. It is still well inside the budget.

### Desktop bench and startup (D15)

**Desktop arm** (Ryzen 5 5500, headless Chromium (D9), the same inputs, one warmup and five
repeats, every repeat valid). The command was `gate7-bench.ts --arm web --core gdscript|rust`.
Each arm held the machine-wide quiet lock exclusive (`quiet-lock.jsonl`), on the rebased build:
bundles `cfaa67b9…` (nothreads) and `6e4abd72…` (dlink). Milliseconds, p50/p95:

| Input | `gdscript` decode | `gdscript` apply | `gdscript` total p95 | `rust` decode | `rust` apply | `rust` total p95 | Gain | g31 / desktop (`rust`, total p95) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `scene-full` | 10.496 / 16.896 | 1.504 / 3.264 | 20.160 | 0.624 / 0.944 | 0.148 / 0.816 | 1.760 | 11.5× | 6.0× |
| `scene-patch` | 1.888 / 4.992 | 1.504 / 3.776 | 8.768 | 0.074 / 0.328 | 0.066 / 0.504 | 0.832 | 10.5× | 7.6× |
| `hd-patch` | 16.896 / 25.088 | 15.104 / 20.992 | 46.080 | 0.560 / 1.184 | 0.592 / 1.440 | 2.624 | 17.6× | 5.7× |
| `pace-patch` | 0.656 / 0.880 | 0.164 / 0.252 | 1.132 | 0.094 / 0.132 | 0.061 / 0.090 | 0.222 | 5.1× | 12.1× |

- **The `gdscript` arm reproduces G7m's desktop web numbers.** The p50s are the same within
  timer resolution. The p95s are higher here: scene-full decode is 16.9 ms against G7m's 12.5 ms.
- **The `rust` arm costs 3× to 6.5× the native adapter's G7xn desktop totals** (p95 decode plus
  apply: 0.270, 0.144, 0.704 and 0.074 ms). That is wasm, plus the GDScript marshalling around the
  core.
- **The phone ratio is high for small transactions.** The g31/desktop ratio is 5.7× to 7.6× on the
  three large inputs, a little over D27's 4× to 5× core factor, and 12× on `pace-patch`, where the
  per-call fixed cost dominates.

**Startup (D15).** g7-0's nine web legs were run back to back on each bundle in two alternating
rounds, 18 cold legs per bundle with a fresh browser per leg. Times are navigation-relative, in
ms, median / p95, with check-gate7's definitions. The wasm heap is the shell's `__rsWasmHeap()` at
exit.

| Build | Engine.init | startGame resolved | First receiver line | Session applied | wasm heap |
| --- | --- | --- | --- | --- | --- |
| nothreads (`Web`, gdscript) | 265 / 278 | 1 342 / 1 372 | 1 321 / 1 350 | 1 477 / 1 505 | 55 / 66 MB |
| dlink (`Web (rust core)`, rust) | 455 / 484 | 1 527 / 1 549 | 1 506 / 1 529 | 1 693 / 1 711 | 55 / 66 MB |

- **The dlink build starts about 190 ms later**, almost all of it before the engine runs:
  - `Engine.init` (fetch and compile) is +190 ms;
  - the gap from `Engine.init` to the first receiver line is unchanged (1 056 ms against 1 051 ms);
  - the session is applied +216 ms later.
- **Its bundle is 48.5 MB against 38.8 MB.** That is the 41.3 MB `.side.wasm` engine, the 1.6 MB
  main module, the 1.1 MB core and a 4.0 MB `EXPORT_ALL` JavaScript glue file, against nothreads'
  38.0 MB wasm and 0.3 MB of JavaScript.
- **The heap is the same.** G7k owns warm startup, memory over time and the phone.

### Deviations from the contract

- **Order.** The g31 arm ran before the desktop arm, on the orchestrator's instruction to
  parallelize. The phone's inputs do not depend on the gate sources, and a phone run puts little
  load on the desktop.
- **The baseline.** The `rust` legs were compared web-to-web with G7b's `g7b-r1` and with a
  same-build `gdscript` baseline. G7b's own native sources are gone (their worktree was removed), so
  new sources were made. Its shots and check verdicts reproduce G7b's exactly.
- **rustup.** Installing the nightly also self-updated rustup from 1.29.0 to 1.29.1. That was rustup's
  automatic self-update, not a requested download.

### For the owners

- **The web export on the g31.** The two misses need different fixes. `hd-patch` needs a cut in
  apply, and this bench does not split the adapter's share of apply from the engine's. `scene-full`
  could use D31's deferred digest in the Godot adapters, which would take the digest out of its
  decode. A web owner (G7v or a G7o follow-up) decides. The native default stays `gdscript` (D34), and the web export's default
  stays the `Web` preset.
- **Startup and memory** (G7k). See D15 above.

Evidence (ignored, in this worktree's `artifacts/render-stream/g7xw/`):

- `probe/` (step 0);
- the first run: `gd/` (sources and the `gdscript` web legs) and `rs-a` to `rs-e` (the `rust`
  web legs);
- the second run: `post/sources-made/` and `post-0` to `post-6`;
- `cores/compare-gate*.json`;
- `bench-g31/` (`web-rs-device-g31.json`, `device-samples-g31-web-rs.json`);
- `bench-desktop-*`, `startup-*` and `native-rs-replay/`;
- `inputs-sha256.txt`;
- `cmp-results.py`, `cmp-shots.sh` and `startup.py`, the comparisons quoted above;
- the bundles under `artifacts/render-stream/web-receiver/`: `07696042…` and `6e4abd72…` (rust),
  `329e1288…` and `cfaa67b9…` (gdscript).
