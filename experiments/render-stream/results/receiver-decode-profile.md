## Receiver decode profile (2026-10-14)

A diagnosis of where the receivers' per-transaction time goes, for G7o's ranking (gate7-design.md
D27, Q13e). No production file changed. Three tools, kept for re-runs:

- `receiver/tests/decode_profile.gd`: the GDScript receiver, headless on the release template.
  Passes: `accept_record` as `receiver.gd` times `decode_us`; the same work split into
  `decode_record`'s steps and `Stream.accept`'s (three short loops are replicas, marked); per-op
  costs from metas filtered to one op; a packed-lift candidate; and apply. The apply pass compiles
  `rs_applier.gd`'s own source at run time with `_prof_mark()` lines at `apply_state()`'s numbered
  steps. Headless means the dummy rasterizer: RenderingServer's CPU-side recording is in the apply
  numbers and GPU uploads are not. Under `--script` the root canvas is not attached yet, so
  `viewport_set_canvas_transform` logs an engine error (one call per session and per root
  transform change).
- `scripts/profile-decode.ts`: the TS decoder in Node, with the split inside `decodeRecord` and
  `createRecordingValidator().accept()` per transaction. G7d's `gate7-bench.ts` stays the bench of
  record for the phones.
- `decode-proto-rs/`: a Rust **cost prototype**, not a decoder. serde_json into an order-preserving
  `Value`, the same key-order, type and enum checks, flat lifting, patch resolution, the resolved
  invariants (O(state), like the GDScript) and the id rules. It runs natively and as
  `wasm32-unknown-unknown` in Node's V8 (`bench-wasm.mjs`). Unlike the GDScript and TS decoders, it
  has no shader, material or param tables, a simplified unsupported derivation, and no canonical-JSON
  re-check.

```bash
mise exec -- godot --headless --path experiments/render-stream/receiver --import
RS_PROFILE_RECORDING=<rec.rs2> RS_PROFILE_STORE_DIR=<capture store> RS_PROFILE_CACHE_DIR=<empty dir> \
  RS_PROFILE_OUT=<out.json> taskset -c 11 <linux_release.x86_64> --headless \
  --path experiments/render-stream/receiver --script res://tests/decode_profile.gd
mise exec -- pnpm exec tsx --conditions=development experiments/render-stream/scripts/profile-decode.ts \
  <rec.rs2> --repeats 5 --out <out.json>
cd experiments/render-stream/decode-proto-rs && cargo build --offline --release \
  && cargo build --offline --release --lib --target wasm32-unknown-unknown \
  && target/release/rs-decode-proto <rec.rs2> 5 && node bench-wasm.mjs <rec.rs2> 5
```

**Inputs** (all /6, not committed):

| Input | Source | Tx | Bytes/tx | Items/tx (with commands) | Commands/tx | Resolved items / commands |
| --- | --- | --- | --- | --- | --- | --- |
| scene-live | a gate 6 `live-scene` leg's `received.rs2`: the 60/s wire | 824 | 17 690 (meta 4 130, cmd_f32 9 630) | 6.3 (4.6) | 11.8 | 54 / 226 |
| scene-patch | `animate` capture, patch sink | 400 | 6 496 | 2.2 (1.6) | 5.0 | 54 / 245 |
| scene-full | `animate` capture, full sink: G6c's and G7d's bench input | 400 | 98 251 (meta 38 221, cmd_f32 43 147, cmd_i32 12 792) | 54 | 245 | 54 / 245 |
| hd-patch | gate6-hd `animate`, headless capture, 200 frames, patch sink | 200 | 104 651 | 39.3 (29.2) | 90 | 496 / 2 137 |
| hd-full | the same capture, full sink | 200 | 815 843 | 496 | 2 137 | 496 / 2 137 |

Runs were one warmup plus five repeats, pinned to core 11 of the Ryzen 5 5500, and never during a
gate 6 run. Other agents' gates and self-tests shared the machine (load 0.5–3.8). Each figure is the
mean over transactions of the per-transaction median, in µs. Two runs four hours apart agree
within about 5 % (scene-full: 5 923 against 6 227).

### Reconciliation

- **G6c's 6.2–7.6 ms, G7d's 6.53 ms and this profile's 5.9–6.2 ms all measure the full sink.** The
  receiver's file-mode recording is the capture's `recording.rs2`, where every transaction is a
  full 98-KB snapshot of 54 items and 245 commands. Live receivers get patches.
- On the live wire, decode is 1.42 ms standalone and 1.63 ms interleaved with apply (cache effects),
  and apply is 1.25 ms. G6p measured 1.9–2.3 and 1.3–1.6 live, with a frame loop and a socket
  around them.
- HD: G7d's hd-patch measured 12.54 / 10.50 ms (decode / apply), against 12.24 / 9.99 here. G6p's live
  HD measured 16–20 / 13–15.6 ms at 174 KB/tx, coalesced at about 13/s.
- **The cost is per field, not per byte.** It is 63 ns/B on the full sink, 81 ns/B on the live
  wire and 117 ns/B on hd-patch. Every per-byte step is native: blocks via `to_float32_array` cost
  0.2–0.6 %, and the ASCII check about 1 %.

### Where the GDScript time goes

`accept_record` (decode, validation and resolve), in µs and % of its total:

| Stage | scene-live | scene-patch | scene-full | hd-patch | hd-full |
| --- | --- | --- | --- | --- | --- |
| **total** (p95) | **1 425** (1 639) | **977** (1 624) | **6 227** (6 755) | **12 243** (17 932) | **76 292** (84 446) |
| record SHA-256 (HashingContext) | 96 (7 %) | 38 (4 %) | 445 (7 %) | 409 (3 %) | 3 498 (5 %) |
| meta ASCII + JSON.parse | 131 (9 %) | 66 (7 %) | 946 (15 %) | 628 (5 %) | 13 876 (18 %) |
| Schema.transaction | 201 (14 %) | 96 (10 %) | 1 605 (26 %) | 940 (8 %) | 15 479 (20 %) |
| frame + blocks | 14 (1 %) | 10 (1 %) | 34 (1 %) | 27 (0 %) | 191 (0 %) |
| id lists, patch rules, offset walks | 37 (3 %) | 22 (2 %) | 213 (3 %) | 134 (1 %) | 2 897 (4 %) |
| lift (`_lift_item` and others) | 340 (24 %) | 113 (12 %) | 1 740 (28 %) | 1 893 (15 %) | 16 646 (22 %) |
| `_check_resolved_invariants` | **595 (42 %)** | **595 (61 %)** | 617 (10 %) | **5 642 (46 %)** | 6 330 (8 %) |
| rest of accept: state writes, version, resource and id rules, known-id rebuild | 153 (11 %) | 72 (7 %) | 1 017 (16 %) | 1 412 (12 %) | 19 229 (25 %) |

Apply, after `needed()` and the cache's `obtain()`:

| Step | scene-live | scene-patch | scene-full | hd-patch | hd-full |
| --- | --- | --- | --- | --- | --- |
| `needed()` (walks every item) | 189 | 185 | 219 | 1 772 | 8 752 |
| **`apply_state()`** (p95) | **1 249** (1 564) | **926** (1 328) | **1 248** (1 627) | **9 994** (13 184) | **13 060** (16 604) |
| textures (`_all_texture_ids` over every command) | 127 | 129 | 141 | 1 124 | 2 709 |
| meshes, shaders, materials | 132 | 115 | 145 | 862 | 1 160 |
| defaults, id sort, free, create, canvases | 59 | 38 | 244 | 218 | 238 |
| parent pass + order pass (every container) | 174 | 169 | 187 | 1 683 | 2 083 |
| item setters (every item, compared field by field) | 338 | 297 | 324 | **3 167** | 3 863 |
| content replay (changed `content_version` only) | 389 | 154 | 168 | 2 820 | 2 802 |

- **The patch path re-walks the whole resolved state every transaction.** Only 4–6 of 54 items
  change per live transaction, and 29–39 of 496 on hd-patch. The receiver still re-validates the whole
  state. `_check_resolved_invariants` runs about eight passes over every item and command, and costs
  595 µs whatever the patch. `needed()` walks every item, and `apply_state` compares every item's
  setters and re-runs the parent, order and texture passes over everything.
  - scene-live: about 1.6 of 2.9 ms (decode, needed and apply) is O(resolved state).
  - hd-patch: about 14 of 24 ms is.
- **Schema cost is GDScript call overhead.** Every field is a method call that formats a path
  string, even when it passes. A `"%s.commands[%d]" %` format is 350 ns, and a 4-key Dictionary
  literal is 300 ns (`floors` in the JSON). With the path strings removed (a scratch copy of
  `Schema`, not committed), scene-full's schema went from 1 536 to 1 239 µs.
- **Triangle arrays dominate lifting.** One `add_triangle_array` costs 67–77 µs to lift, plus 4 µs
  JSON and 11 µs schema: `[x, y]` and `[r, g, b, a]` Arrays per vertex. The
  applier then re-packs them (`_points`, `_colors`). A glyph (`add_texture_rect_region`) costs about
  9 µs in all, and `add_set_transform` about 5 µs.
  - Candidate pass: lifting a triangle array straight to packed arrays with
    `PackedByteArray.to_vector2_array`/`to_color_array` and `PackedInt32Array.slice` costs 8.6–11.5 µs.
- The native parts are 15–25 %: `JSON.parse` (23–31 µs/KB) and `HashingContext` SHA-256 (185–235
  MB/s).

### The same recordings in TypeScript (Node 24 V8) and Rust

Decode, validate and resolve per transaction, mean (p95), µs:

| Arm | scene-live | scene-patch | scene-full | hd-patch | hd-full |
| --- | --- | --- | --- | --- | --- |
| GDScript `accept_record` (native) | 1 425 (1 639) | 977 (1 624) | 6 227 (6 755) | 12 243 (17 932) | 76 292 (84 446) |
| TS, pure SHA-256 (what GSW runs) | 392 (455) | 194 (452) | 2 108 (2 188) | 2 697 (4 685) | 21 156 (26 199) |
| TS, node:crypto SHA-256 | 188 (247) | 124 (236) | 913 (974) | 1 396 (2 213) | 10 967 (16 057) |
| Rust native, hardware SHA | 75 (92) | 44 (85) | 545 (559) | 567 (974) | 4 472 (4 678) |
| Rust native, software SHA | 118 (139) | 61 (135) | 773 (788) | 825 (1 404) | 6 438 (6 667) |
| Rust wasm in V8, software SHA | 138 (158) | 77 (160) | 849 (867) | 985 (1 723) | 7 333 (7 748) |

- TS's own split of scene-full (pure): SHA-256 1 225 (58 %), `bytesToAscii` 147, `JSON.parse` 265,
  canonical re-stringify 94, blocks 62, and 284 beyond `decodeRecord` (108 of it resolve). On scene-live, SHA is
  222 of 392 (57 %); on hd-patch it is 1 305 of 2 697 (48 %), and validation beyond decode is 821
  (O(state), plus `applyTransaction`'s per-patch Map copies).
- `lib/sha256.ts` runs at about 80 MB/s. Rust's software SHA-256 in wasm runs at 340 MB/s,
  Godot's HashingContext at 185–235 MB/s, and node:crypto at 2 GB/s.
- GDScript against V8: 3.0–4.5× against the pure hash and 6.8–8.8× against node:crypto. Rust wasm
  against GDScript: 7–12×. Rust wasm against TS once its hash is fixed: about 1.1–1.4×. V8's `JSON.parse`
  matches serde_json's `Value` parse, and both carry the same O(state) validation.
- Is the record hash required? The record SHA-256 is evidence, not validation: render-stream-0.md
  "Decoded form", `applied.json`'s `record_sha256`, and gate 0's `receiver-consumed-stream`. Nothing
  compares it at receive time. A receiver may compute it off the critical path: after submit, in
  idle time, or with async `crypto.subtle.digest`. Resource payload hashes (`resource-hash`) must be
  verified before use, but they arrive only with resource records and fetches, not per
  transaction.

### G7o candidates, ranked against the g31

Scaled by G7m's measured g31/desktop ratios for GSW (5.6–7×; big cores capped at 1.35 GHz). The
web export has no measurement yet (G7e). It is GDScript in wasm, so 7–14× is assumed (V8's ratio
times a 1.3–2× wasm-interpreter penalty). These are estimates from the desktop split, not phone
measurements.

**GSW, tier 1 (TypeScript).** On the g31 it is at 11.79 / 12.99 ms on scene-full and
10.57 / 16.79 on hd-patch (misses), and 3.04 / 7.40 on scene-patch (a pass).

1. **Take the record SHA-256 off the decode path** (lazy, idle or async), and use a wasm SHA-256
   for the resource payloads that must be verified. This is 48–58 % of the desktop time.
   - scene-full ≈ 11.8 → 5.0 ms p50: a pass.
   - hd-patch ≈ 10.6 → 5.5 ms p50, about 9–10 ms p95: still over.
2. **Delta-driven validation and resolve.** Re-check only the touched items, their parents,
   children and tie groups, and the commands that name a changed texture or mesh. Patch
   `ResolvedState` in place instead of copying its Maps.
   - hd-patch validation is 821 µs, so this saves about 0.6 ms desktop and 3–4 ms on the g31.
   - It removes most of G7m's validate jitter (3.55 → 7.22 ms), which is what keeps hd-patch's p95
     over.
3. **Typed-array blocks and a native ASCII check.** Use `Float32Array`/`Int32Array` instead of
   `number[]` through `DataView` (hd-patch −0.2 ms), and `TextDecoder("latin1")` plus one regex for
   the per-byte string append, G55d's GDScript fix (scene-full −0.13 ms, and hd-full's 2–8 ms GC
   jitter).
   - Together, about −1.3 to −1.5 ms on the g31.
4. **Decode and validate in a Worker,** posting a transferable delta.
   - This takes everything above off the main thread, which is what D25 judges, for one hop of
     latency on the credit loop.
   - A g31 worker may land on an A55 core.

**GSW, tier 2 (shared Rust core in wasm): not justified by this profile.** After tier 1, TS is
within about 1.1–1.4× of the Rust wasm prototype. V8's JIT and JSON parser already run at
near-native speed.

**Web export, tier 1 (GDScript).** On the live scene wire, a transaction costs decode 1.42 +
needed 0.19 + apply 1.25 ≈ 2.9 ms on desktop, about 20–40 ms on the g31. hd-patch costs about 24 ms
on desktop.

1. **Make validation, `needed()` and apply delta-driven,** O(changed) instead of O(state). About
   −1.6 ms (55 %) on scene-live and −14 ms (58 %) on hd-patch.
2. **Lift to packed arrays and hand them to apply** (measured 77 → 11 µs per triangle array, and no
   re-pack in `_replay_geometry`). About −0.25 ms decode and −0.1 ms apply on scene-live, and about
   −1.7 ms decode on hd-patch (29 triangle arrays per transaction).
3. **Build schema paths only on failure, and fuse schema with lifting** (one pass per command
   Dictionary instead of three). Measured −19 % of schema for paths alone: −0.1 ms scene-live,
   −0.8 ms scene-full.
4. **Record digest off the critical path:** −0.1 ms scene-live, −0.4 ms hd-patch.

Tier 1 combined: scene-live ≈ 2.9 → 1.0–1.2 ms desktop, about 7–17 ms on the g31. That still
misses the 8.5 ms budget at most of that range, which bears out D27's prediction.

**Web export, tier 2: the shared Rust core,** decode, validate and resolve, delta-driven.

- The prototype, not yet delta-driven, costs 0.14 ms (scene-live) and 0.98 ms (hd-patch) in V8 wasm
  with software SHA, so 0.8–1 ms and 5.5–7 ms on the g31.
- Apply stays GDScript unless the same module also calls RenderingServer through the GDExtension
  interface. Apply is 1.25 ms (scene-live) and 10 ms (hd-patch) on desktop today, nearly all of it
  GDScript overhead: scene-live makes only 21 RenderingServer calls per transaction.
- With tier-1 apply in GDScript, scene-live projects to about 0.9 + 3–6 ms on the g31.

Integration constraints:

- **Web export.** The `web_dlink_nothreads_release.zip` template and emscripten 4.0.11 are fetched
  (21d7937f). The core must be an emscripten `SIDE_MODULE` built with that same emscripten.
  - Rust needs `wasm32-unknown-emscripten`, which is not installed here. godot-rust documents a
    nightly toolchain with `-Zbuild-std` for web builds (not verified here). Alternatively, link a C
    ABI static lib into an emcc-built C++ side module: the capture extension's pattern, raw
    `gdextension_interface.h` with no godot-cpp.
  - The nothreads dlink template needs no cross-origin isolation:
    `platform/web/js/engine/features.js:94-101` requires it only with threads, although the docs say
    otherwise. Its dlink main module is larger (`EXPORT_ALL`), and its startup cost is unmeasured.
- **JavaScriptBridge**, without dlink, cannot pass a `PackedByteArray` to JS. Its `_variant2js`
  takes only bool, int, float, String and JavaScriptObject. The JS side would have to own the
  WebSocket and the decode, and Godot would pull each result with `js_buffer_to_packed_byte_array`
  (one copy). That splits the transport and leaves apply in GDScript.
- **The native receiver** would gain its first GDExtension (it has none by design).
- **Handoff.** Decode output must reach apply as packed arrays (one memcpy each), never as
  per-command Variants: a Dictionary literal is 0.3 µs and a key read 55 ns, ×7–14 on the g31.

### Caveats

- The apply numbers are headless (dummy rasterizer), so they leave out the GPU driver.
- The phone factors are G7m's GSW ratios, applied per stage.
- The Rust prototype's wasm runs in Node's V8, not Chrome on Android.
- The scene-live recording is one live run, and HD is a headless capture, not a live HD wire.

