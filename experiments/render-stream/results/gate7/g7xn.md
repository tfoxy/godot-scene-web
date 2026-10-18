## Gate 7xn result (2026-10-16)

G7xn ([protocol/gate7/g7xn.md](../../protocol/gate7/g7xn.md);
[gate7-design.md](../../protocol/gate7-design.md) D34, Q14e) gives the native receiver a second
core: `RS_RECEIVER_CORE=rust` decodes, validates, resolves and applies through `render-stream-core`,
via a GDExtension adapter. The default stays `gdscript` (D34). *(G7xd, 2026-10-17, flipped the
native default to `rust` behind a full milestone sweep; `gdscript` is frozen at /7 and stays
selectable.)* **Every native receiver leg of gates
0 to 6 reproduces under `rust`:** same classes and checks on every gate (after one gate 4 harness
fix and the one allowed gate 6 timing rerun), and on a same-source replay every file leg's shots are
byte-identical and every `applied.json` and state dump is equal. The one exception is decoder error
prose on gate 0's `corrupt` leg (same reason code). The default path (as it stood at the time) was unchanged.

**What was built** (no godot-rust, no new crates, no nightly: stable Rust 1.95.0 and g++ 13):

- `rs-core-capi/` (`rs-core-capi`, a staticlib; Cargo.lock = rs-core's crates plus itself): a C ABI
  over `render-stream-core`. `core.rs` wraps the `Validator` (render-stream/6, `Inline` digest,
  payload hashes verified) and answers in `receiver.gd`'s shapes as tagged Variant trees (`vt.rs`).
  `plan.rs` is a Rust port of `rs_applier.gd`, with the same rules, order, `rs_calls`, stats and
  all 15 applier sabotages. It emits a RenderingServer call stream (`ops.rs`, 65 opcodes, RIDs as
  per-kind handles). It is delta-driven: it visits only what the accepted transactions touched,
  plus items whose material RID or `rid` instance parameters depend on a created or freed
  resource. `full_scan` keeps `rs_applier.gd`'s O(state) walk as the cross-check.
  `rs-core-capi-check legs` replays recorded receiver legs through both and compares them with
  the GDScript receiver's per-transaction stats.
- `receiver/ext/`: `rs_core_ext.cpp`, C++ over the raw `gdextension_interface.h` (the capture's
  vendored copy, no godot-cpp). It registers `RsCore` (RefCounted) and runs the call stream as
  ptrcalls, with method hashes from 4.5.1's `extension_api.json`. Also `rs_core_capi.h`,
  `rs_core.gdextension`, and a `.gdignore`, so the editor never registers the extension.
  `scripts/build-rs-core-ext.sh` builds it into the ignored `ext/build/` (`cargo test`, link,
  `build.json` with both sha256s). The library is 14.3 MB unstripped.
- `receiver/rs_rust_applier.gd` (`RsRustApplier extends RsApplier`) stands in for both
  `RsApplier` and `Rs2Decoder.Stream`. `receiver.gd` reads `RS_RECEIVER_CORE=gdscript|rust` and
  `RS_RECEIVER_CORE_EXT`, loads the adapter only under `rust` (a missing or unloadable adapter is a
  usage error), and records the core in `applied.json` `receiver.core`. Under `rust`,
  `RsResourceCache` keeps raw payloads (`keep_raw`) and the core re-verifies and decodes them.
  State dumps are `canon::write_state` (TypeScript form, `statesEqual`-equal to GDScript's).
- Runners: `lib/legs.sh` `receiver_core_env` forwards the runner's own `RS_RECEIVER_CORE(_EXT)`
  to every receiver launch (headless, background and rendered). The default adds nothing, so a
  `gdscript` leg's argv and env are what they were.
- Tools: `scripts/replay-receiver-legs.sh` re-runs a finished gate run's file-mode receiver legs
  under another core against the same recordings, stores and libraries. Rendered legs run in a
  private `gamescope --backend headless` of the original size. `scripts/compare-receiver-cores.ts`
  compares two runs leg by leg (`applied.json` minus `receiver` and timing keys, shots by sha256,
  state dumps by `statesEqual`), or by classes and checks with `--classes`.
  `gate7-bench.ts --arm native` gains `--core`, `--core-ext` and `--taskset`.

**Refusals and limits.** The core decodes render-stream/6 only, which is what every native leg
speaks. G7b's web-only `mesh_web_refused` list is always empty under `rust`, because the adapter is
native-only until G7xw. Payload and decoder error prose (`failure.detail`) is the core's own; the
reason codes are the same.

### Pass counts

`artifacts/render-stream/gate7/g7xn/gd` (`gdscript`, the default) and `…/rs` (`rust`), one build
on `main` `3a93116e` plus this change (the final rebase onto `8d9ee4c4` changed no receiver,
capture or runner file; its rebuild passed `cargo test`, clippy, the capi check and a gate 0
replay, `…/postrebase/`). Gates −1 to 5.5 ran beside the G7t and G7s agents' runs.
Gate 6 and the bench ran under the quiet-machine lock after 5 quiet minutes:

| Gate | `gdscript` | `rust` |
| --- | --- | --- |
| −1 | 29/29 | (no receiver) |
| 0 | 24/24 | 24/24 |
| 1 | 66/66 | 66/66 |
| 2 | 85/85 | 85/85 |
| 3 | 56/56 | 56/56 |
| 4 | 185/185 | 185/185 (rerun, below) |
| 5 | 116/116 | 116/116 |
| 5.5 | 130/130 | 130/130 |
| 6, default groups | 144/154, then g6l and g6c rerun 63/63 | 154/154 |

`compare-receiver-cores.ts --classes` finds every leg class and every check equal between the cores
on every gate (`rs/classes.json`, `rs-rerun/classes-gate4.json`; gate 6 after the rerun below).

The first `rust` gate 4 failed 4 checks (5 lines), all `receiver-never-loaded-fixture*`. The cause
was the new `receiver/ext/.gdignore`: it was empty, so it was byte-identical to the empty
`.gdignore` in gate 4's font fixtures, which that check forbids. It now carries a comment. The
`gdscript` gate 4 judged after the fix and passed, and the `rust` rerun passed 185/185
(`…/rs-rerun/gate4`). Godot ignores a `.gdignore`'s content, so no leg changed.

### Same-source replay

`replay-receiver-legs.sh --run gd/gate<N> --core rust`, then `compare-receiver-cores.ts`
(`…/rs-replay/compare-gate<N>.json`):

| Gate | Legs | Shots byte-identical | State dumps equal |
| --- | --- | --- | --- |
| 0 | 9/9 (1 detail-only) | 25/25 | — |
| 1 | 14/14 | 164/164 | 39/39 |
| 2 | 18/18 | 132/132 | 210/210 |
| 3 | 15/15 | 120/120 | 10/10 |
| 4 | 24/24 | 222/222 | — |
| 5 | 21/21 | 180/180 | 30/30 |
| 5.5 | 21/21 | 210/210 | 30/30 |
| 6 | 19/19 | 285/285 | 36/36 |

`process_frame` is equal on every replayed leg as well. The detail-only leg is gate 0's `corrupt`:
the GDScript decoder reports "meta byte 0 is 0x00, not printable ASCII" and the core reports "meta
contains a non-printable-ASCII byte", with the same reason `replay-failure`. Live legs are not
replayed, because they need their host. The whole-gate `rust` runs above cover them, judged by
the same checkers.

`rs-core-capi-check legs` over every `gdscript` leg of gates 0 to 6 (`…/capi-check-gd.txt`,
`…/capi-check-gd6.txt`): 186 match per applied transaction (stats, `rs_calls`, uploads, mesh
uploads, `record_sha256`; live, reconnect, resync, rate and sabotage legs included), with
delta == `full_scan` on all of them. 9 are skipped: gate 2's token and unpin sabotages fail before
any apply, and gate 6's soak and calibration legs record no transactions. After the final rebase,
the same check over these runs and the gate 6 rerun matched 204 legs (`…/postrebase/`).

Validating on the rebased build turned up three harness bugs and one merge gap, all fixed here:

- `replay-receiver-legs.sh` did not seed a warm cache the runner had prepared itself (gate 2's
  `sabotage-receiver-ignore-cache` copies `receiver-cold`'s cache). It now copies the run's copy
  when no earlier replayed leg filled it. A warm leg reads its cache and never adds to it; the
  run's copy was checked identical to `receiver-cold`'s.
- `compare-receiver-cores.ts` normalized only each side's own run root. A replayed leg reads the
  source run's stores, so both roots are now normalized on both sides.
- `rs-core-capi-check` found no payloads for gate 6's rates legs, whose host keeps its store in
  memory. It now falls back to the leg's `RS_RECEIVER_CACHE_DIR`.
- G7b added `mesh_web_refused` to `rs_applier.gd`'s stats after this branch began, and
  `receiver.gd` reads it as a typed array. `RsRustApplier.apply_state()` now supplies the typed
  empty list.

### Gate 6

The first `gdscript` gate 6 (`…/gd/gate6`) failed 10 checks. Nine of them are g6l and g6c timing
checks: `motion-monotonic`, `rate-achieved-rate-{15,30,60}` (receiver frame rate 41.6 to 55.2/s),
`host-unperturbed-{mismatch-60-recv30,constrained}`, `dual-independent-dual-60-15`,
`leg-class-sabotage-constrained-ignore-credit` (via `host-unperturbed`) and `separation-gpu-heavy`.
The tenth is `manifest-evidence`, which only fails because the manifest cites three of those g6c
checks. The machine was not quiet. The run started after five minutes with no other gate run, but
during it a SlayTheSpire2 pair (left alone), another agent's Playwright Chromium and a Node
self-test were running, and the 15-minute load average reached 11. The one allowed rerun, of g6l and
g6c on a quiet machine (`…/gd-rerun/gate6`), passed all 63 of their checks, including all nine. Its
other 5 lines are `group-*` placeholders for the groups it did not run. g6z needs g6a and g6b in the
same run, so `manifest-evidence` was not re-judged. Every check it cites passed in the rerun. The
`rust` gate 6 ran quiet and passed 154/154 first time. The gate 6 replay is byte-identical (above),
so the failures were timing, not the core.

### Native bench

`gate7-bench.ts --arm native --core gdscript|rust --taskset 11` on G7x's four inputs (the
`g7m-inputs` copy, its recordings and stores sha256-identical to `gate7/g7x/inputs`), on the release
template, headless, one warmup and 5 repeats, under the quiet-machine lock
(`…/bench-gdscript`, `…/bench-rust`; every repeat valid, every transaction applied). For `rust`,
`decode_us` is `accept` (frame, meta, validation, resolve and the `Inline` record digest), and
`apply_us` is `needed` + `provide` + `apply`, including the RenderingServer ptrcalls. Milliseconds,
pooled over the repeats, p50/p95:

| Input | Tx | Decode `gdscript` | Decode `rust` | Apply `gdscript` | Apply `rust` | Decode profile GDScript, decode / apply p50 (p95) |
| --- | --- | --- | --- | --- | --- | --- |
| `scene-full` | 400 | 5.760 / 6.528 | **0.132 / 0.164** | 0.720 / 1.184 | **0.053 / 0.106** | 6.227 (6.755) / 1.248 (1.627) |
| `scene-patch` | 400 | 0.816 / 1.696 | **0.021 / 0.066** | 0.752 / 1.184 | **0.022 / 0.078** | 0.977 (1.624) / 0.926 (1.328) |
| `hd-patch` | 122 | 11.008 / 14.080 | **0.188 / 0.312** | 8.960 / 10.496 | **0.196 / 0.392** | 12.243 (17.932) / 9.994 (13.184), 200 tx |
| `pace-patch` | 400 | 0.280 / 0.360 | **0.025 / 0.039** | 0.070 / 0.102 | **0.025 / 0.035** | not profiled |

At p95, `rust` decodes 40× (`scene-full`), 26×, 45× (`hd-patch`) and 9× (`pace-patch`) faster
than `gdscript`, and applies 11×, 15×, 27× and 2.9× faster. This session's `gdscript` arm lands
within the decode profile's spread
([results/receiver-decode-profile.md](../receiver-decode-profile.md); its `hd-patch` had 200
transactions, this one 122). The `rust` apply mostly avoids `rs_applier.gd`'s O(state) walks,
because it visits only what each transaction touched. Desktop numbers only: they say nothing about
the g31 or the web export (G7xw).

### For G7xw (the dlink adapter)

- The same shim and staticlib need emscripten `SIDE_MODULE` build flags (no `-Wl,-z,defs` or
  `--exclude-libs` there). The method hashes are 4.5.1's, the same on the web.
- The extension is loaded at run time through `GDExtensionManager.load_extension()`. The dlink
  export may need it in `extension_list.cfg` instead. `receiver/ext/.gdignore` keeps it out of
  the default export.
- `plan.rs` does not port G7b's `web-index-region-update` refusal. On the web, either port it or
  upload index data through `GL_ELEMENT_ARRAY_BUFFER` (G7b Finding 2).
- `replay-receiver-legs.sh` and `compare-receiver-cores.ts` are native-only. G7b's web legs and
  `gate7-tool.ts web-legs` are the web-side equivalents.

### What G7xn does not prove

It does not cover the web export (G7xw), any phone, or the GSW receiver. The native default stays
`gdscript` through gate 7 (D34).
