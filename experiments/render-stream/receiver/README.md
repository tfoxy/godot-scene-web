# render-stream/2 receiver (gate 0, extended by gates 1 and 2)

A Godot project whose only input is a `render-stream/2` byte stream: a recording file (file mode)
or one WebSocket connection to a capture host (live mode, G1c2), plus the texture payloads that
stream names (inline resource records, a content-addressed cache directory, or the capture's
store directory). It replays the stream onto the RenderingServer and writes `applied.json`. It has
no autoload, no extension and no file from `fixtures/`. The contract is
[`../protocol/gate2-design.md`](../protocol/gate2-design.md) ("Q5. Receiver", "G2b2"), extending
[`../protocol/gate1-design.md`](../protocol/gate1-design.md) ("Q5. Receiver", "G1b2", "G1c2") and
[`../protocol/gate0-design.md`](../protocol/gate0-design.md) ("Q5. Receiver"); the bytes are
[`../protocol/render-stream-2.md`](../protocol/render-stream-2.md) (render-stream/1 was
superseded at G2b2). G1d added the live options for a stall, a reconnect and a resync
(`RS_RECEIVER_STALL`, `_RECONNECT`, `_RESYNC`).

**Since G6b the receiver speaks `render-stream/6`** ([`../protocol/render-stream-6.md`](../protocol/render-stream-6.md),
contract [`../protocol/gate6-design.md`](../protocol/gate6-design.md) "Q5. Receiver"): `rs2_decoder.gd`'s
module-wide default version is 6 (5 from G55d, 4 from G5d, 3 from G4e2), the live client's subprotocol is
`render-stream.6` and its `hello` says `render-stream/6`. A `GRS5` recording is refused with `bad-magic`; the
self-tests decode golden-2 to golden-5 at their own versions explicitly. See "Presentation and canvas layers
(G6b)" and "Shaders and materials (G55d)" below.

### Presentation and canvas layers (G6b)

- **Stretch.** At the session, before any item exists, a `canvas_items` session makes the root window
  adopt the session's stretch (`content_scale_mode`, `_aspect`, `_stretch` from `scale_mode`,
  `content_scale_size = logical_size`, `content_scale_factor` from the session block), so the engine
  computes the reference's stretch transform and oversampling. `disabled` keeps the project's
  settings; `viewport` is typed `stretch-mode` and drawn with the receiver's own settings. Then (1) the
  root window size must equal `presentation_size`, else `presentation-mismatch`, and (2) the root
  viewport's `get_oversampling()` must equal `font_oversampling` (float32), else
  `oversampling-mismatch`; both are typed and still drawn, a headless receiver skips both. (3) The
  visible rect must equal `logical_size` (`viewport-mismatch`, a replay failure, as before). Run a
  half presentation with `--resolution 960x540` in a 960x540 gamescope.
- **Canvases.** Each non-root canvas id gets its own `canvas_create`; while `attached` it is attached to
  the root viewport (`viewport_attach_canvas`, which resets the engine's stacking to (0,0) and its
  transform to identity), stacked (`viewport_set_canvas_stacking` with the wire's `layer`, `sublayer`),
  transformed and modulated, each only on change; leaving `attached` is `viewport_remove_canvas`,
  leaving the state `free`. Canvases apply after materials and before items. Wire canvas 1 stays the
  viewport's own canvas.
- **Typed session entries** (`canvas-stacking-tie`, `canvas-repeat`, `canvas-follow-viewport`,
  `global-canvas-transform`, `snap-2d`) are reported in `applied.json` and not replayed: no repeat, no
  follow, the receiver's own stretch only, no snap.

| File                         | Role                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `project.godot`              | 640×360, stretch disabled, `gl_compatibility`, typed-GDScript warnings at error level. `default_clear_color` is magenta on purpose: the session's `clear_color` must replace it.                                                                                                                                                                                                                                                                                                                                        |
| `main.tscn`                  | A root `Node` with `receiver.gd`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `receiver.gd`                | Orchestration: environment, framing pass, session and viewport check, one record per `_process`, state dumps, shots, `applied.json`, exit code; in live mode the connection, the acks, the step-window shots and the close after the end record.                                                                                                                                                                                                                                                                        |
| `rs_live_client.gd`          | `RsLiveClient` (G1c2, G2e): the `WebSocketPeer` client (`inbound_buffer_size` and, when a token is given, the `Authorization: Bearer` handshake header, both set before `connect_to_url`; `get_packet()` before `was_string_packet()`), the `hello`/`ack`/`resync` encoders and the host `error` parser.                                                                                                                                                                                                                |
| `rs2_decoder.gd`             | `Rs2Decoder` (G2b1): pure `PackedByteArray` → records, with the wire spec's error codes (`split_records`, `decode_record`, `validate_recording`, `raw_resource_payload`). `Rs2Decoder.Stream.accept` checks the cross-record rules (resource records included) and resolves patches into the full state (`canvases`/`items`/`textures`, the default filter/repeat). Since G4e1, `split_records`/`validate_recording` take an optional `version` (2, the default, or 3) and also decode `render-stream/3`'s one new command, `add_msdf_texture_rect_region` -- implemented in this same file behind that parameter rather than a forked `Rs3Decoder` (`../protocol/render-stream-3.md`; nothing in the receiver speaks /3 yet, that is G4e2).                                                                                                                                                     |
| `rs_texture_payload.gd`      | `RsTexturePayload` (G2b1): `render-stream-texture/1` decode (`payload-magic`/`-meta`/`-length`/`-size`), SHA-256, and the `Image` rebuilt from it.                                                                                                                                                                                                                                                                                                                                                                      |
| `rs_resource_cache.gd`       | `RsResourceCache` (G2b2): the in-memory map of verified payloads (inline records and everything obtained this process), the content-addressed cache directory (`fresh`/`warm`, temp file + rename, verified on read and before write) and the store directory as the file-mode origin; `resource-unavailable`, `resource-hash-mismatch`, `resource-invalid`, `cache-not-fresh`. Since G6s: `RS_RECEIVER_MEMORY_BUDGET_BYTES`/`_CACHE_BUDGET_BYTES` LRU-evict each layer past its byte budget, never a hash `set_needed()` names; `evictions_memory`/`_disk`/`refetch_after_evict` count it; `no-evict` (sabotage) disables both.                                                                                                                                        |
| `rs_resource_fetcher.gd`     | `RsResourceFetcher` (G2c2, G2e): live mode's `GET <http_path><hash>` on the WebSocket's host and port, one keep-alive `HTTPClient`, sequential, polled from `_process` (several non-blocking polls per call while they progress), a per-GET timeout and the injected delay as a timed wait, and (when a token is given) an `Authorization: Bearer` header on every request; non-200 (401 included), connection loss and timeout are `resource-unavailable`. The fetched bytes go through `RsResourceCache.add_fetched`. |
| `rs_applier.gd`              | `RsApplier`: wire id → RID maps and every RenderingServer call, counted in `rs_calls`. It applies the **resolved** state, never a patch, reconciling it with its own mirror so only changed state costs calls; since G2b2 also texture residency (D5), the root's default filter/repeat, the items' filter/repeat and the texture draws, skipping (and recording) commands that name an unsupported texture.                                                                                                            |
| `rs_rust_applier.gd`         | `RsRustApplier` (G7xn, gate7-design.md D34, Q14e): `RS_RECEIVER_CORE=rust`. It stands in for `RsApplier` and `Rs2Decoder.Stream` at once, over the `RsCore` class of the GDExtension adapter in `ext/`: the shared Rust core (`../rs-core`, through `../rs-core-capi`) decodes, validates and resolves every record and applies the resolved state from native code as RenderingServer ptrcalls, by `rs_applier.gd`'s rules and order, visiting only what the accepted transactions touched. This class only marshals (records in, `accept_record()`-shaped Dictionaries, `needed()`, the payloads and `apply_state()`'s stats out). |
| `ext/`                       | The adapter (G7xn): `rs_core_ext.cpp` (C++ over the raw `gdextension_interface.h`, the capture's vendored copy, no godot-cpp), `rs_core_capi.h` (the Rust staticlib's C ABI), `rs_core.gdextension` (loaded at run time by `RsRustApplier.load_core()` only), and a `.gdignore`, so the editor never registers the extension and only the explicit `gdscript` path (frozen, D34) skips loading it. Build: `../scripts/build-rs-core-ext.sh` (into the ignored `ext/build/`). The web export (G7xw): the same shim and staticlib as an emscripten side module (`../scripts/build-rs-core-web.sh`, `ext/build/web/`, `web.wasm32` in the `.gdextension`), exported by `export_presets.cfg`'s `Web (rust core)` preset, which stages `ext/` without the `.gdignore`; on the web the shim also routes `mesh_surface_update_index_region`'s upload to `GL_ELEMENT_ARRAY_BUFFER` (G7b's `web-index-region-update`). |
| `rs_config.gd`               | `RsConfig` (G7e, gate7-design.md Q4): every `RS_RECEIVER_*` read goes through `get_env()`: the environment first, then `--rs-env=NAME=VALUE` after `--` (a web export's only source; the shell builds them). `is_web()`. |
| `rs_io.gd`                   | `RsIo` (G7e, Q4): natively nothing. On the web, `prepare_sources()` fetches the recording, the store and the shader library (same-origin URL paths; a directory's list from the harness's `GET <dir>/?list`) through `HTTPClient` into the in-memory filesystem at the same paths before the session, and `finish()` PUTs every file under `RS_RECEIVER_OUT`'s directory to `RS_RECEIVER_EVIDENCE_URL` before disposing and quitting. On the web `RS_RECEIVER_CACHE_DIR` is refused and the cache is `http-cache`. |
| `export_presets.cfg`         | The web export's preset (G7e, D5); export only through `../scripts/build-web-receiver.sh`, which pins the editor and template sha256 and fills in `@RS_WEB_TEMPLATE@`. |
| `web/shell.html`             | The web export's HTML shell (G7e, Q4 "Shell"): fragment token, `?env=` to `--rs-env`, performance marks, wasm heap, context loss, canvas size, `window.__rsShell`. |
| `tests/codec2_selftest.gd`   | Golden-vector self-test against `../protocol/golden-2/` (G2b1) AND `../protocol/golden-3/` (G4e1): decoded form, resolved state per seq for `full`/`patch`/`inline.rs2`/`.rs3`, every invalid vector, `corrupt-meta.rs2`/`.rs3`, every payload vector. One file, not a separate `codec3_selftest.gd` (render-stream-3.md is implemented in `rs2_decoder.gd` itself).                                                                                                                                                                                                                                                                                                                          |
| `tests/applier2_selftest.gd` | G2b2: the applier on the goldens (identical per-seq stats for full, patch and inline delivery, 0 calls for an unchanged seq, the texture residency rules, the reupload sabotage, a reconnect), the cache's fresh/warm/ignore-cache and origin failures, and the live control messages against `control/valid/`. Since G6s, `_test_cache_budgets()`: memory and disk LRU eviction under a tight budget, `set_needed()` protection, `no-evict`, `refetch_after_evict` and a warm cache's mtime seeding.                                                                                                                                       |
| `tests/ws_selftest.gd`       | `WebSocketPeer` interop self-test against the capture library's `rs_ws` echo server (G1c1), plus a bearer-token phase against a second, auth-enabled echo instance (G2e).                                                                                                                                                                                                                                                                                                                                               |
| `tests/http_selftest.gd`     | `HTTPClient` interop self-test against `rs_ws`'s resource GET serving (G2c1), plus a bearer-token phase against the same auth-enabled echo instance (G2e).                                                                                                                                                                                                                                                                                                                                                              |

## Running

Import once with the editor (it writes the ignored `.godot/` cache the release template needs):

```bash
mise exec -- godot --headless --path experiments/render-stream/receiver --import
mise exec -- godot --headless --path experiments/render-stream/receiver --script res://tests/codec2_selftest.gd
mise exec -- godot --headless --path experiments/render-stream/receiver --script res://tests/applier2_selftest.gd
```

The self-tests print `[rs2-selftest] ok` / `[applier2-selftest] ok` and exit 0, or print each
failure and exit 1. Since G55d `applier2_selftest.gd` runs golden-4 (decoded as version 4) and
golden-5 (`full`/`patch`/`inline.rs5`: identical per-seq stats, `[74, 1, 1, 2, 2, 0, 16, 24, 18, 0, 27, 104, 1, 1, 44]`
-- golden-4's eleven seqs cost exactly what they cost on /4, since a white canvas modulate is the
engine's default and makes no call --
RenderingServer calls; seq 12's shaders, materials and every parameter's exact Variant type; the
`ignore-material`, `ignore-canvas-modulate` and `stale-param` sabotages; `params.rs5` with no, a
tampered and a real shader library), and checks the live control messages against golden-5's
`control/valid/`. golden-4 state 8's `add_triangle_array` prints `Condition "count > p_indices.size()"`
(engine-rejected on purpose); that line is expected. `RS_SELFTEST_GOLDEN_DIR` overrides the golden-2 directory (default
`<receiver>/../protocol/golden-2`); `RS_SELFTEST_TMP_DIR` the applier test's scratch directory.
`codec2_selftest.gd` always also runs against its sibling `<receiver>/../protocol/golden-3`
(version 3), which is not independently overridable.
On the goldens the applier makes `[74, 1, 1, 2, 2, 0]` RenderingServer calls for seqs 1–6 of
`full.rs2`, `patch.rs2` and `inline.rs2` alike (plus 3 for the session).

A replay:

```bash
RS_RECEIVER_RECORDING=/abs/recording.rs2 RS_RECEIVER_OUT=/abs/leg/applied.json \
RS_RECEIVER_CACHE_DIR=/abs/leg/cache RS_RECEIVER_STORE_DIR=/abs/capture/store \
RS_RECEIVER_SHOT_SEQS=1,2 RS_RECEIVER_STATE_SEQS=1,2 <godot or template> --path experiments/render-stream/receiver
```

| Variable                 | Meaning                                                                                                                                                                         |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RS_RECEIVER_MODE`       | `file` (default when unset) or `live` (below); any other value is a usage error.                                                                                                |
| `RS_RECEIVER_RECORDING`  | absolute `.rs2` path. Missing or unreadable → replay-failure `recording-unreadable`.                                                                                            |
| `RS_RECEIVER_OUT`        | absolute `applied.json` path. Shots go to `<dirname>/shots/seq-<seq>.png`, state dumps to `<dirname>/state/seq-<seq>.json`.                                                     |
| `RS_RECEIVER_SHOT_SEQS`  | optional CSV of transaction seqs to screenshot after `RenderingServer.frame_post_draw`.                                                                                         |
| `RS_RECEIVER_STATE_SEQS` | optional CSV of transaction seqs whose resolved state is dumped right after that seq is applied, in render-stream-2.md's resolved `state` shape (compact JSON, full precision). |

Resources (G2b2, gate2-design.md Q5 "Environment"; both modes unless noted):

| Variable                       | Meaning                                                                                                                                                                                                                                                |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `RS_RECEIVER_CACHE_DIR`        | absolute content-addressed cache (`sha256/<hash>.grt`, `.grm` for mesh surfaces since G5e, `.grp` for shader code since G55d); required when the session's delivery is not inline (replay-failure `resource-unavailable` otherwise)                   |
| `RS_RECEIVER_SHADER_LIBRARY`   | G55d (gate5_5-design.md D4, Q5): absolute operator-local library (`sha256/<hash>.grp`) a `withheld` shader's code comes from, verified by hash. Without it, or without that hash, the shader is skipped and `unsupported` gains `{seq, item: null, name: "shader_set_code", reason: "shader-withheld", shader}` once per shader and hash. Never a fetch, never cached |
| `RS_RECEIVER_CACHE_MODE`       | `fresh` (default: the directory must be absent or empty, else replay-failure `cache-not-fresh`) or `warm` (it must exist)                                                                                                                              |
| `RS_RECEIVER_STORE_DIR`        | file mode: the capture's store, the origin for `fetch: "directory"`; reading from it is a fetch                                                                                                                                                        |
| `RS_RECEIVER_FETCH_TIMEOUT_MS` | live: a GET not complete this long after it was issued is `resource-unavailable` (default 10000)                                                                                                                                                       |
| `RS_RECEIVER_FETCH_DELAY_MS`   | an injected delay before each fetch, default 0                                                                                                                                                                                                         |
| `RS_RECEIVER_SABOTAGE`         | `reupload` (upload every resident texture at every applied transaction), `ignore-cache` (fetch even on a cache hit), `wrong-http-token` (live only, G2e: correct token on the upgrade, wrong one on every GET), `ignore-clip` (gate3-design.md Q5, G3b: every `canvas_item_set_clip` call passes `false`), `clip-before-clear` (G3b: the pre-gate-3 apply order -- the clip setter before content, with no shadow reset on clear), `drop-msdf` (G4e2), `ignore-set-transform` and `ignore-clip-ignore` (G5d), `drop-mesh-surface` (G5e: a mesh build never adds its surface 1) `stale-mesh` (G5e: in-place payload changes of a resident surface are ignored) or `refuse-canvas-texture` (every draw naming a canvas-texture entry is skipped, logged with reason `canvas-texture-headless` and counted in `skipped_commands`: a recording made with the headless CanvasTexture shim replayed as the default capture would have refused it, [canvas-texture-headless.md](../protocol/canvas-texture-headless.md) "Simulated refusal"), `ignore-material` (G55d: `canvas_item_set_material` is never called), `ignore-canvas-modulate` (G55d: `canvas_set_modulate` is never called) `stale-param` (G55e: a material's parameters are set only when the material is created), `stale-texture` (G6a: a resident RGBA8 image keeps its first payload, LA8 atlas pages still update), `ignore-canvas-stacking` (G6b: extra canvases are attached but never stacked, so they draw at (0,0) in canvas RID order) or `ignore-presentation` (G6b: stretch stays disabled whatever the session says and the visible-rect check is skipped, so a half presentation shows the top-left of the logical frame at scale 1); all exist only to fail checks or to compare pictures |

Core (G7xn, gate7-design.md D34; G7xd flipped the default; both modes). **Run
`../scripts/build-rs-core-ext.sh` once per fresh worktree first**: since `rust` is the default,
*any* native receiver launch that does not explicitly pick `gdscript` now loads
`ext/rs_core.gdextension`, and that adapter is a build output, not a checked-in binary. Skipping
this step fails every default-core leg with "`RS_RECEIVER_CORE=rust, but the adapter is
unavailable`", which reads like a receiver bug.

| Variable               | Meaning |
| ---------------------- | ------- |
| `RS_RECEIVER_CORE`     | `rust` (default since G7xd: `RsRustApplier` over the GDExtension adapter: the shared Rust core decodes, validates, resolves and applies; this project keeps configuration, I/O, evidence and shots) or `gdscript` (`Rs2Decoder` and `RsApplier`; frozen at /7, milestone sweeps only). `applied.json`'s `receiver` block records the chosen one as `core`. Under `rust`, state dumps are the core's resolved `state` in render-stream-2.ts's form (same keys, JavaScript's number printing), compared with `statesEqual()` as before, and the cache keeps each payload's raw bytes for the core to verify and decode. |
| `RS_RECEIVER_CORE_EXT` | `rust` only: the adapter's `.gdextension` (default `res://ext/rs_core.gdextension`). A missing or unloadable adapter, or any other `RS_RECEIVER_CORE`, is a usage error. |

The gate runners pass their own `RS_RECEIVER_CORE`/`RS_RECEIVER_CORE_EXT` to every receiver launch
(`../scripts/lib/legs.sh` `receiver_core_env`), so `RS_RECEIVER_CORE=gdscript bash run-gateN.sh ...`
runs a whole gate on the frozen GDScript core; `../scripts/replay-receiver-legs.sh` re-runs a
finished run's file-mode receiver legs on another core against the same source, and
`../scripts/compare-receiver-cores.ts` compares the two.

Exit codes: `0` status `ok`; `3` replay-failure (`applied.json` written); `2` usage error
(`RS_RECEIVER_OUT` missing or not absolute, a malformed `RS_RECEIVER_SHOT_SEQS` or
`RS_RECEIVER_STATE_SEQS`, `RS_RECEIVER_MODE` neither `file` nor `live`, or a malformed live
variable), with nothing written. Every output line starts with `[receiver]`.

Rendered runs go only through a private `gamescope --backend headless`
(`../scripts/lib/gamescope.sh`), never Xvfb or a desktop display. Under `--headless` a requested
shot is replay-failure `shot-unavailable`; state dumps work headless.

## Live mode (G1c2)

```bash
RS_RECEIVER_MODE=live RS_RECEIVER_URL=ws://127.0.0.1:<port>/render-stream \
RS_RECEIVER_OUT=/abs/leg/applied.json RS_RECEIVER_SHOT_WINDOWS=0:307-359,1:367-419 \
<template> --max-fps 60 --path experiments/render-stream/receiver
```

| Variable                      | Meaning                                                                                                                                                                        |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `RS_RECEIVER_URL`             | required; loopback only: `ws://127.0.0.1:<port>/…` or `ws://[::1]:<port>/…` (the port is the host's `evidence/live.json`)                                                      |
| `RS_RECEIVER_OUT`             | as in file mode                                                                                                                                                                |
| `RS_RECEIVER_SHOT_WINDOWS`    | optional CSV of `<step>:<from>-<to>` host-frame windows: the first applied transaction whose `frame` is inside a window is shot after `frame_post_draw`, and its state dumped  |
| `RS_RECEIVER_SHOT_FINAL`      | G6c, `1`: after the end record, the last applied state is drawn once more and shot (`shots/final.png`, a shot with `"final": true`, that transaction's `seq` and host `frame`) before the receiver closes; for realtime legs whose freeze lands at no predictable host frame |
| `RS_RECEIVER_RECEIVED_OUT`    | absolute path of the received bytes, default `<dirname>/received.rs2`                                                                                                          |
| `RS_RECEIVER_INBOUND_BYTES`   | `WebSocketPeer.inbound_buffer_size`, set before connecting and announced in `hello`; default 16777216                                                                          |
| `RS_RECEIVER_CREDIT_STAGE`    | `submitted` (default) or `applied`; forced to `applied` under `--headless`, where `frame_post_draw` never fires                                                                |
| `RS_RECEIVER_CONNECT_TIMEOUT` | milliseconds to reach `STATE_OPEN`, default 10000 (replay-failure `live-connect-failed`)                                                                                       |
| `RS_RECEIVER_STALL`           | G1d, `<step>:<ms>`: after the shot for `<step>`, block the main loop `<ms>` (`OS.delay_msec`, an injected delay, not GPU work) before that seq's `submitted` ack               |
| `RS_RECEIVER_RECONNECT`       | G1d, `<step>`: after the shot for `<step>` and its `submitted` ack, close with 1000, `dispose()` the applier and connect again (connection 2: a fresh session)                 |
| `RS_RECEIVER_RECONNECT_MEMORY` | G6l, `drop` (default, G2c2's rule: connection 2 takes payloads from its inline records, the cache directory or a fetch) or `keep` (the verified, content-addressed memory map survives the reconnect); `live.reconnect` records the mode and the hashes in memory and in the cache at that moment |
| `RS_RECEIVER_RESYNC`          | G1d, `<step>`: refuse the first transaction in that step's window unapplied, send `resync` for it, and refuse patches until a full transaction arrives                         |
| `RS_RECEIVER_TOKEN_FILE`      | G2e, gate2-design.md D13: absolute path to a file holding the bearer token, sent as `Authorization: Bearer <token>` on the upgrade and on every resource GET; unset sends none |

The file-mode variables (`RS_RECEIVER_RECORDING`, `_SHOT_SEQS`, `_STATE_SEQS`) are usage errors in
live mode, and so is a G1d option whose step has no shot window. On open the receiver sends
`hello`. Each binary message is appended to the received file, framed (the first is the magic and
the session, every later one exactly one record, else `live-framing`), decoded, accepted and
acked `received`. The newest accepted transaction is applied, at most one per `_process`, and
acked `applied`; at the next `frame_post_draw` a due shot is taken and `submitted` is sent.
`presented` is reported as `"unavailable"`. After the end record the receiver closes with 1000
itself (Godot's `WebSocketPeer` would drop an end record that arrived together with the host's
close frame, so the host waits for this close), then writes `applied.json` and exits 0. A close
without an end record is replay-failure `live-disconnected`; a close with 1002, 1008 or 1009 is
`host-error`, with the close reason (the host repeats its error's reason there). Shots and state
dumps are `shots/seq-<n>.png` and `state/seq-<n>.json`; shot entries carry their `step`;
`shots_missed` lists the windows without one. Transactions carry `received_us`, `applied_us` and
`submitted_us` (`Time.get_ticks_usec()`); `live` holds the URL, the credit stage, the inbound
buffer size and the acks sent.

G1d options. The stall runs in the `frame_post_draw` callback that takes the step's shot, so the
host sees only a credit that does not return; `live.stall` records `step`, `ms`, `after_seq`,
`after_frame`, `start_us`, `end_us`, `injected: true` and the mechanism. A reconnect waits for the
close handshake of connection 1 (2 s at most), writes its received file, calls
`RsApplier.dispose()` (which frees every RID the applier still owns), and opens connection 2,
retrying while the host still refuses a second receiver (503) until the connect timeout;
`live.reconnect` records the step, the seq, `created_rids`, `freed_by_apply`,
`owned_before_dispose`, `freed_rids`, `leftover_rids` and the connect attempts. Connection 2 writes
`received-2.rs2` (`RS_RECEIVER_RECEIVED_OUT` with `-2` before the extension), a second `streams[]`
entry, transactions and shots with `stream: 2`, and `shots/stream-2-seq-<n>.png` /
`state/stream-2-seq-<n>.json`. A refused transaction (resync) keeps its `transactions[]` entry with
`skipped: "resync"` and no `applied_us`; it is acked `received` only; `live.resync` records the
step, seq and frame.

## `applied.json` (`render-stream-receiver-applied/6`)

Since G6b (gate6-design.md Q5) `/6`: `/5`'s shape; `viewport` gains `presentation_size`, `window_size`,
`oversampling` (the root viewport's `get_oversampling()`), `presentation_check`
(`ok | mismatch | skipped-headless`) and `stretch_applied`; each applied transaction's `resources` (and
`resources_summary`) gains `canvases_created`, `canvas_attach` (`viewport_attach_canvas` and
`viewport_remove_canvas` calls) and `canvas_stacking_sets`; `unsupported` may carry the receiver's own
typed session entries (`seq` null, `item` null, `name` `viewport`, `reason` `presentation-mismatch`,
`oversampling-mismatch` or `stretch-mode`). State dumps of a `/6` stream carry each canvas's `layer`
and `sublayer` (after `attached`), as render-stream-6.md's resolved form.

Since G55d (gate5_5-design.md Q5) `/5`: `/4`'s shape, each applied transaction's `resources` gaining
`shaders_created`, `shader_code_sets`, `shader_payload_fetches` (GRP1 payloads fetched from the store or
over HTTP), `materials_created`, `param_sets` (`material_set_param` calls, removals included) and
`instance_param_sets` (`canvas_item_set_instance_shader_parameter` calls, removals included), all
integers; `resources_summary` gains their totals; `fetches[]` `kind` may be `shader`; `unsupported`
may carry the receiver's own `shader-withheld` entries (above). State dumps of a `/5` stream gain the
canvases' `modulate`, the items' `material`, `use_parent_material` and `instance_params` (between
`texture_repeat` and `content_version`), and the `shaders` and `materials` tables (after `meshes`),
all in render-stream-5.md's resolved shapes and key order (parameters as `{name, type, value}`, a
`rid` value as `{"tex": <id>}`), so a dump compares with the capture's resolved state.

Since G5e (gate5-design.md Q5) `/4`: `/3`'s shape below, each applied transaction's `resources`
gaining `meshes_created`, `meshes_rebuilt`, `surface_updates`, `mesh_upload_bytes` and
`skipped_mesh_commands` (and the entry `mesh_commands`), `fetches[]` entries a `kind`
(`texture | mesh`), a top-level `mesh_uploads[]`
(`{id, op: create|rebuild|update|free|custom_aabb, surfaces, buffers, bytes, stream, seq}`) and
`resources_summary` the mesh totals. State dumps gain `meshes` (render-stream-4.md's resolved
form). `/3` was gate2-design.md Q5: gate1-design.md Q5's `/2` plus `cache`
(`{dir, mode, entries_before, entries_after, bytes_after}` or `null` without a cache dir), a
`resources` object on every applied transaction (`fetched`, `fetched_bytes`, `cache_hits`,
`inline_received`, `created`, `updated`, `replaced`, `freed`, `upload_bytes`, `fetch_us`,
`skipped_commands`; `null` for a transaction not applied), `fetches[]`
(`{stream, seq, hash, source, status, bytes, start_us, end_us, verified}`), `uploads[]`
(`{id, hash, op: create|update|replace|placeholder, data_bytes, stream, seq}`; G2b2's own key,
what the redundant-upload check reads) and `resources_summary`
(`{distinct_fetched, fetched_bytes, cache_hits, uploads, upload_bytes}`). In file mode: `mode: "file"`; `recording` and the single
`streams[0]` describe the input file (`stream_id` from the session, `null` until the session
decoded; `connection`, `closed_by`, `close_code` are `null`); every `transactions[]` and `shots[]`
entry has `stream: 1`; transactions carry `encoding` and `null` `received_us`/`applied_us`/
`submitted_us`/`skipped`; shots carry `step: null` and `state_path` (the seq's state dump, if it was
also requested, else `null`); `shots_missed` is `[]`; `live` is `null`. `viewport.size_check` is
`skipped-headless` under `--headless`, otherwise `ok` or `mismatch` against the session's
`logical_size`, and `null` if the run failed before the session was decoded.

## Behaviour notes

- **Order of work.** The whole file is framed first (`split_records`); a framing error fails with
  `seq: null` before any RenderingServer call. The session is decoded and validated, the viewport
  size is checked, then the session is applied in `_ready` (clear colour, canvas 1 → the root
  viewport's World2D canvas, its transform, the cull mask), and one record per `_process` frame
  after that.
- **Textures (G2b2).** Before a transaction is applied, every `ok` image a command of its resolved
  state names that is not resident (or resident with another hash) is made available -- from
  memory (inline records, earlier fetches), from the cache (a hit), or fetched from the store and
  written to the cache -- verified and decoded first. A texture becomes resident when a command
  first names it and stays until its entry leaves the table or becomes a `freed` tombstone (its RID
  is freed then; the command draws as an invalid texture, white, as on the capture side). A
  resident image is re-uploaded only when its hash or kind changes: `texture_2d_update` with the
  same format, size and mipmaps, else `texture_replace(rid, texture_2d_create(image))`, so its RID
  never changes. Placeholders are the receiver's own `texture_2d_placeholder_create()`. Commands
  naming an `unsupported` texture and `unsupported` commands are skipped and recorded.
- **Meshes (G5e).** Every surface payload (GRM1, `sha256/<hash>.grm`) of an `ok` mesh an
  `add_mesh` names that is not resident with that hash is made available like a texture. A mesh
  becomes resident when first named (`mesh_create`, one `mesh_add_surface` Dictionary per surface,
  `mesh_set_custom_aabb`) and is freed when its entry leaves or becomes a tombstone; its RID never
  changes. A same-layout payload change is one `mesh_surface_update_*_region(mesh, s, 0, buffer)`
  per changed buffer (what the host's engine did, so the surface AABB stays the one fixed at
  `add_surface`), a layout change (counts, buffer lengths, AABB, uv_scale) `mesh_clear` and every
  surface again; a custom AABB change one call. An `add_mesh` naming a freed, unsupported or
  absent mesh is skipped and recorded.
- **Shaders and materials (G55d, gate5_5-design.md Q5).** Apply order: textures, meshes, shaders,
  materials, items, canvas 1. Residency is lazy: a material is resident while an item names it as
  its own `material` (every effective material, D9, is one of those), a shader while a resident
  material names it, and the textures of those materials' `rid` parameters, their shaders'
  `default_textures` and the items' `rid` instance parameters count as named. A shader is
  `RenderingServer.shader_create()` plus `shader_set_code(rid, code)` with the code exactly as its
  verified GRP1 payload (`sha256/<hash>.grp`, fetched and cached like a texture, or inline) carries
  it -- never through a `Shader` resource, which would run the preprocessor again; a new hash is
  `shader_set_code` on the same RID; `default_textures` are
  `shader_set_default_texture_parameter` calls (a removed one with `RID()`); `source: null` is a
  `shader_create` alone. A `withheld` shader's code comes from `RS_RECEIVER_SHADER_LIBRARY` or the
  shader is skipped (`shader-withheld`). An `unsupported` shader is never compiled. A material is
  `material_create()`, `material_set_shader` (`RID()` for none, an unsupported or a skipped shader:
  the engine then draws its default shader) and one `material_set_param` per changed parameter,
  `null` for a removed one, each rebuilt as the exact Variant type (`float`/`int` from the float64;
  real_t types narrowed to float32 by their constructors, which is exact; packed arrays as
  `Packed*Array`; `rid` as the receiver's RID for that texture; transform2d as /0's xforms, basis
  row-major, transform3d basis then origin, projection by column). An `unsupported` material is never
  created; an item naming it draws without one (an unsupported `canvas_item_set_material` command
  is logged). Removed shaders and materials are freed (D5: no tombstones). Items get
  `canvas_item_set_material`, `canvas_item_set_use_parent_material` and
  `canvas_item_set_instance_shader_parameter` (`null` for a removed one) only when the value
  differs from what was last sent; canvas 1's `modulate` is `canvas_set_modulate` on the root canvas
  only when it differs from the last value applied, starting from the engine's white (a scene that
  never modulates costs no call; `dispose()` puts it back to white only if a non-white value was
  applied). A shader compile error is the engine's own `SHADER ERROR`
  print, which the runner classifies `replay-failure` / `shader-compile`. Headless,
  `material_get_param` cannot witness any of this (dummy storage drops parameters), so the
  self-test asserts on the applier's recorded calls.
- **Resolved state, identity reconciliation.** Each transaction is decoded and accepted by
  `Rs2Decoder.Stream`, which resolves a patch against the previous state. `RsApplier.apply_state`
  then follows gate 0's Q5 steps 2–8 against the resolved state: free vanished, create new, parent
  pass, order pass (re-`set_parent` from the first divergence), setters only for new items or
  changed values (floats compared as float32; `z_relative` and `behind` included), content rebuild
  only on a `content_version` change, canvas 1 transform. A full and a patch encoding of the same
  frames therefore cost the same calls, and an unchanged transaction costs none.
- **Viewport size.** A rendered receiver requires its visible rect to equal the session's
  `viewport.logical_size` (replay-failure `viewport-mismatch` otherwise). Headless, the size is 64×64
  (`SceneTree` sets the root's minimum size, `scene/main/scene_tree.cpp:2035`, and
  `Window::_update_window_size` clamps to it, `scene/main/window.cpp:1150`) and the check is skipped.
- **Missing seqs.** A requested shot or state dump whose seq never appears is replay-failure
  `shot-unavailable` / `state-unavailable` at the end record.
- **Failure `seq`.** A transaction whose meta cannot be parsed (`meta-json`) has no readable `seq`;
  the receiver reports the seq it was expecting at that position (previous + 1). Errors from the
  session or end record report `seq: null`.
- **Codes the spec leaves open.** `block_count` ≠ `meta.blocks.length` is `block-count`. A
  non-printable meta byte is `meta-json`. An out-of-order or repeated `unsupported` entry is
  `unsupported-mismatch`. `validate_recording` stops at the first record that fails to decode, so a
  bad record is not followed by cascade errors.
- **Unsupported** commands are logged (`[receiver] seq N item I: unsupported command …`) when an
  item's content is (re)built, and not drawn. Top-level `unsupported` entries are reported in
  `applied.json` `unsupported` once, at the seq where they first appear, not treated as a failure.
- **Teardown.** On exit the applier's `dispose()` frees every RID it created (logged as
  `[receiver] disposed: N RIDs freed`).
- **Quantization.** A colour component of 0.5 (the golden's clear colour blue, item 1 green) lands
  on 127 in an 8-bit shot on the RTX 2060 / NVIDIA GL driver, not 128. The gate 0 fixture avoids
  this by using components in {0, .2, .4, .6, .8, 1}.
