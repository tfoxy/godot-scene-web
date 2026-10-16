## Runtime contract

Environment, read once at SCENE initialisation:

| Variable                         | Meaning                                                                                                                                                                                                                                                                                                                                                                                                   |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GRC_CALIBRATION`                | absolute path to the record. Absent or unreadable → refuse `no-calibration`; present but malformed → refuse `invalid-calibration`                                                                                                                                                                                                                                                                         |
| `GRC_MODE`                       | `validate` (default; all checks, all evidence, never writes the vptr) or `arm`                                                                                                                                                                                                                                                                                                                            |
| `GRC_EVIDENCE_DIR`               | absolute directory, created if missing. Unset → the same payloads go to stdout as `[grc] evidence <name> …` lines                                                                                                                                                                                                                                                                                         |
| `GRC_DISARM_AFTER_FRAMES`        | integer; disarm after that many armed frame callbacks. Unset → stay armed until the shutdown callback                                                                                                                                                                                                                                                                                                     |
| `GRC_STREAM_OUT`                 | absolute `.rs2` path of the full-encoding sink (render-stream/1 from G1b2, render-stream/2 since G2b2, render-stream/3 since G4e2, render-stream/4 since G5d, render-stream/5 since G55d, render-stream/6 since G6b). When this or `GRC_STREAM_PATCH_OUT` is set and the library armed, enable the canvas mirror, run the root query and publish. Unset → hooks behave as at gate −1                                                                                                                                    |
| `GRC_STREAM_PATCH_OUT`           | G1b2: absolute `.rs2` path of the patch-encoding sink (seq 1 full, then patches on `seq-1`), fed from the same per-frame snapshot as the full sink                                                                                                                                                                                                                                                        |
| `GRC_SABOTAGE`                   | test sabotage: `freeze-frame`, `omit-update`, `perturb-transform` (gate 0), `omit-op`, `patch-drop-item` (G1b2), `drop-message`, `ignore-credit`, `stale-coalesce` (live, need `GRC_LIVE_LISTEN`), G2b2's `stale-texture`, `wrong-hash` (needs a store) and `spurious-texture-update`, G4e2's `perturb-glyph` (the mirror records rect.x + 0.25 on every glyph command from the frame on), G5d's `perturb-vertex` and G55d's `perturb-shader` (the mirror records every non-builtin shader code set from the frame on with `COLOR.rgb` inverted before its last `}`; the engine and the hook log keep the true code). `drop-resource`, `unpin` (G2c2) and any other value refuse to publish (arming is unaffected)                   |
| `GRC_SABOTAGE_OP`                | G1b2: the RenderingServer method `omit-op` drops from `GRC_SABOTAGE_FRAME` on (`free`, `canvas_item_set_visible`, …); required for `omit-op`, refused with any other kind                                                                                                                                                                                                                                 |
| `GRC_SABOTAGE_FRAME`             | first sabotaged frame, an integer ≥ 1, default 21. Read only when `GRC_SABOTAGE` is set                                                                                                                                                                                                                                                                                                                   |
| `GRC_ROOT_SIZE`                  | gate 1 (G1a), read at arm with a stream: `observe` (default; declare only) or `enforce-min-size` (`Window.set_min_size(content_scale_size)` on the root, see below), and since G6b `presentation:<W>x<H>` (decimal, 1..16384 each; `Window.set_min_size(W, H)`: under `canvas_items` the headless host evaluates the stretch, font oversampling and StyleBoxFlat feather of a W×H window, declared as the /6 session's `presentation_size`, `font_oversampling` and `host_final_xform`; under stretch `disabled` a W×H other than the logical size refuses to publish, `root-size-invalid`, gate6-design.md D4). Anything else refuses to publish. Since G6b `host_size_status` compares the window with the presentation size (the logical size unless `presentation:`) |
| `GRC_UNKNOWN_ITEM`               | 2026-10-10, read at arm with a stream: `strict` (default; also unset or empty: gate 0's sticky `pre-existing-object`) or `skip`, the opt-in diagnostic of [protocol/unknown-item-skip.md](../protocol/unknown-item-skip.md): unknown canvas/item RIDs and every known item under one are withheld, the session declares `unknown_item_policy: "skip"` and every transaction carries `unknown_items`. Anything else refuses to publish|
| `GRC_SHADER_POLICY`              | G55d (gate5_5-design.md D4), read at arm with a stream: `source` (default; also unset or empty: shader code travels as `render-stream-shader/1` payloads under the resource policy), `params` (every non-builtin shader entry is `withheld`: hash and size only, no code byte in the stream, the store or HTTP) or `exclude` (every non-builtin shader is `unsupported` / `shader-excluded`). CanvasItemMaterial shaders are engine content and travel under every policy. Declared in the session's `materials.shader_policy`. Anything else refuses to publish |
| `GRC_LIVE_LISTEN`                | G1c2: `127.0.0.1:<port>` or `[::1]:<port>` (0 = ephemeral). Enables the mirror and root query like `GRC_STREAM_OUT` and serves the stream (render-stream/5 since G55d, subprotocol `render-stream.5`; /4 from G5d; /3 from G4e2; /2 from G2b2; out-of-band payloads over `GET /resources/sha256/<hash>` on the same listener since G2c2) over the library's own WebSocket server (one receiver at a time). Since G6b the stream is render-stream/6, subprotocol `render-stream.6`, and each connection's session declares `publication` from `GRC_PUBLISH_FPS`. Any other host refuses (`non-loopback`) |
| `GRC_LIVE_TAP_DIR`               | G1c2: absolute directory for `stream-<n>.rs2` (every binary message formed for connection n, resource records included) and `live-<n>.jsonl` (the live log)                                                                                                                                                                                                                                               |
| `GRC_LIVE_MAX_MESSAGE_BYTES`     | G1c2: default 16777216; the cap is the minimum of this and the receiver's `hello.inbound_buffer_bytes` (larger: `error` + close 1009)                                                                                                                                                                                                                                                                     |
| `GRC_LIVE_HELLO_TIMEOUT_MS`      | G1c2: default 5000; no `hello` in time → close 1002                                                                                                                                                                                                                                                                                                                                                       |
| `GRC_RESOURCE_FORMATS`           | G2a, read at arm with a stream: the `Image` formats whose bytes are copied, a comma-separated subset of `L8,LA8,R8,RG8,RGB8,RGBA8` (the default); any other name refuses to publish                                                                                                                                                                                                                       |
| `GRC_RESOURCE_MAX_PAYLOAD_BYTES` | G2a: the largest canonical payload copied, a decimal integer ≥ 1, default 67108864 (64 MiB); a larger texture is logged `payload-too-large` and not copied. An engine without the `Image` binds or `image_ptr` refuses to publish (`image-access-unavailable`)                                                                                                                                            |
| `GRC_RESOURCE_STORE_DIR`         | G2b2: absolute content-addressed store (`sha256/<hash>.grt`, `.grm` since G5e, `.grp` since G55d, `index.jsonl`) every `ok` payload of each published snapshot is written to; required when a file sink is open and delivery is not inline (else the stream refuses: `resource-store-missing`)                                                                                                                                                 |
| `GRC_RESOURCE_INLINE_MAX_BYTES`  | G2b2: the largest payload a file sink carries in band as a `resource` record, default 0 (out of band); delivery is `inline` when it is at least the max payload size, `mixed` in between. Live connections follow it too (G2c2); above 1 MiB the live listener is refused                                                                                                                                 |
| `GRC_RESOURCE_BUDGET_BYTES`      | G2b2: the payload bytes the capture may retain (the mirror's plus those the last publication pins), default 536870912; above it the stream ends with `resource-budget-exceeded` (result.json `stream.reason`), as a store write failure does with `resource-store-failed`                                                                                                                                 |

Arming happens at the earliest point where the `RenderingServer` singleton is
available. With a runtime `load_extension` from an autoload that is SCENE
initialisation, because the engine singletons are already registered by then —
this is the path the scratch runs exercise, and the one the fixture uses. A
startup-loaded extension reaches SCENE initialisation at `main/main.cpp:3633`,
before `register_server_singletons()` at `main/main.cpp:3704`, so
`global_get_singleton("RenderingServer")` would still be null; the attempt is
then retried from the `startup` callback and from each `frame` callback until the
singleton exists. Only the first successful attempt decides.

That deferred path was first run on 2026-10-09, with the extension listed in a
scratch project's `.godot/extension_list.cfg` on the pinned template. It refused
a correct record as `slot-mask-mismatch`: the retry re-parsed the record into the
same lists and the anchors doubled to 34/17. Loading the record and collecting the
fingerprint now start from empty. With that change the startup-loaded extension
defers at `scene-init` and decides at `startup`: `validated` in validate mode;
`armed` in arm mode, where the scripted `add_rect` is bit-exact, and then
disarmed and restored. A `load_extension` from a `--script` `SceneTree._initialize`
arms at `scene-init` directly.

A mod's managed code always runs after the singletons exist, because
`ScriptServer::init_languages()` follows `register_server_singletons()`
(`main/main.cpp:3707`). So a `GDExtensionManager.LoadExtension` call from mod code
decides at `scene-init` and never needs the deferred path. Gate −0.5 measured the
same on the target game.

Evidence files, exactly as the runner expects:

- `result.json` — `render-stream-capture-result/1`: `status`
  (`armed|validated|refused|error`), `reason`, `vptr_written`, `disarmed`,
  `display_server`, `rendering_driver`, `rendering_method`, and (gate 0, additive)
  `stream`: `{path, patch_path, status: off|open|closed|refused|open-failed, reason,
transactions}` (`patch_path` since G1b2), and (G1c2) `live`: `{status, listen, address, port,
reason, connections}`. Written at decision time and rewritten at disarm and shutdown.
- `live.json` (G1c2, with `GRC_LIVE_LISTEN`) — `render-stream-live/1`: `status`
  (`listening|refused|failed`), `address`, `port`, `reason`; written when the listener is decided.
- `live-summary.json` (G1c2) — `render-stream-live-summary/1`: per connection the transactions
  formed and sent, coalesced callbacks, acks per stage, credit round trips, close code and side.
- `fingerprint.json` — version string, sha256, build-id, pie, load bias, live
  vptr, singleton address, abstract address point, pure placeholder, pid, and the
  `/proc/self/maps` lines of the main binary.
- `calibration-check.json` — every check with `ok` and a detail string.
- `counters.json` — `render-stream-gate-minus1-counters/1`, written at disarm and
  at shutdown. Floats are printed with `%.9g` **and** as IEEE-754 float32 hex
  bits.
- `disarm.json` — `disarmed`, `vptr_was_shadow`, `vptr_restored`, `frame`.
- `resources.jsonl` (G2a, whenever a stream is enabled) — `render-stream-resource-log/1`, the
  texture hook log (`capture/src/rs_resource_log.h`): one line per texture-related
  RenderingServer call after it was forwarded (a free is logged only for a RID created as a
  texture), drained at every frame callback. Keys, in order: gate2-design.md Q3's `frame`, `t_us`
  (since the stream opened), `thread` (`main` or `other`), `op`, `id` and `by_id` (the wire ids
  G2b2's mirror will use: one per-session counter, never reused), `rid`, `version`, `kind`,
  `status`, `reason`, `format`, `width`, `height`, `mipmaps`, `data_bytes`, `payload_bytes`,
  `hash` (SHA-256 of the GRT1 payload, copied and hashed on the calling thread before the call
  was forwarded), `copy_ns`, `hash_ns`, `conn` and `http_status` (set on G2c2's `http-get` lines), then G2a's
  additions `target` (the item, viewport or other texture RID the call names), `ref_id` (that
  texture's id), `value` (the filter, repeat or channel argument), `layer` and `root_viewport`.
  A `texture_replace` line carries the payload fields of the content its target now holds.
  G2b2 adds publisher lines (`op` `store` for a payload written to the store directory, `inline`
  for a resource record written to a sink, with `hash`, `payload_bytes` and `status`) and two
  trailing keys on a sabotage's own lines: `"sabotage":true` (spurious-texture-update's version
  bump) and `"sabotage":true,"omitted":true` (a call the omit-op sabotage dropped from the
  capture: logged, but neither the mirror nor the log's registry applies it, so the two keep
  agreeing and the sabotage shows as pixels).
  G2c2 adds the live serving lines: `pin` (a hash became servable over HTTP; `reason` `current`),
  `retire` (it stopped being servable and its bytes were released; `superseded`, or `unpin` under
  that sabotage) and `http-get` (one GET the server answered: `hash`, `http_status`,
  `payload_bytes`, `conn` the live connection streaming then, thread `other`); a drop-resource
  pin carries `"sabotage":true`.
- `armed.marker` — empty file, created immediately after the vptr store.

Deviations from the drafted contract, all additive:

- `counters.json` adds `image_details_available` (whether the `Image` method
  binds resolved), and each `canvas_item_add_polygon` entry adds `points_total`,
  `colors_total` and `texture`; captured point/colour lists are truncated at 64
  elements per call, which `points_total`/`colors_total` make visible.
- `texture_2d_create`/`texture_2d_update` entries carry `rid`, `details`, `frame`
  and (for updates) `layer` beside the drafted `width`/`height`/`format`/`data_size`.
  `frame` is the 1-based main-loop iteration the call arrived in, the same numbering
  as the fixture's own frame counter (the frame callback runs after process and
  draw), so an expected atlas update can be placed in time.
- `invalid-calibration` is a reason code in addition to the drafted ones, for a
  record that exists but does not parse or carries the wrong schema.
- Calibrator 2 added keys only; the schema string is unchanged. The new
  `counters.json` keys are:
  - `hooks_planned` and `hooks_omitted`, as described in "Calibration records and
    hook versions".
  - one `counts` entry per tier-2 hook, `null` when the hook was omitted.
  - one `captured` array per tier-2 hook, in the shapes listed in the slot table
    above.
  - `captured_dropped`.

  `calibration-check.json` adds the `hook_plan` check.

- Calibrator 3 (gate 0) also added keys only. `counters.json` gains a `counts`
  entry, a `captured` array and a `captured_dropped` entry for each of the 11
  tier-3 hooks, and a `captured.free` array of freed RIDs (with
  `captured_dropped.free`).
- Calibrator 5 (G2a) also added keys only. `counters.json` gains a `counts`
  entry, a `captured` array and a `captured_dropped` entry for each of the 11
  tier-5 hooks; `captured.canvas_item_add_texture_rect` and `_region` arrays with
  the full arguments (256 distinct entries each instead of 32);
  `image_payload_available`; and `texture_update_unknown`. `root.json` gains
  `texture_defaults` (`filter`, `repeat`: the root `Viewport`'s scene enums read at
  arm, −1 when unread).

