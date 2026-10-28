extends Node
## render-stream/5 receiver (gate0-design.md "Q5. Receiver", extended by gate1-design.md "Q5.
## Receiver", "G1b2" and "G1c2", by gate2-design.md "Q5. Receiver" and "G2b2", since G4e2 by
## gate4-design.md "Q5. Receiver" -- /3 is /2 plus the msdf command -- and since G5d by
## gate5-design.md "Q5. Receiver": /4 adds the immediate geometry ops, add_set_transform and
## add_clip_ignore, replayed in order; since G5e the mesh table: every `ok` mesh a command names
## is made resident from its GRM1 surface payloads and add_mesh replays; since G55d by
## gate5_5-design.md "Q5. Receiver": /5's shader and material tables are compiled and created
## natively from their GRP1 code, items get their material, use_parent_material and instance
## parameters, canvas 1 its modulate). Its only input is a
## render-stream/5 byte stream: a recording file (file mode) or the binary messages of one
## WebSocket connection (live mode), plus the texture, mesh and shader payloads that stream names.
##
## File mode (RS_RECEIVER_MODE unset or "file"):
##   RS_RECEIVER_RECORDING   absolute .rs2 path (required)
##   RS_RECEIVER_OUT         absolute applied.json path (required); shots go to <dirname>/shots/,
##                           state dumps to <dirname>/state/
##   RS_RECEIVER_SHOT_SEQS   CSV of transaction seqs to screenshot (optional)
##   RS_RECEIVER_STATE_SEQS  CSV of transaction seqs whose resolved state is dumped (optional)
## The whole file is framed first. The session is applied in _ready, then one record per _process
## frame.
##
## Resources (G2b2; both modes unless noted):
##   RS_RECEIVER_CACHE_DIR        absolute content-addressed cache (sha256/<hash>.grt, and
##                                <hash>.grm for mesh surfaces since G5e, <hash>.grp for shader
##                                code since G55d); required
##                                when the session's delivery is not inline
##   RS_RECEIVER_CACHE_MODE       fresh (default: the directory must be absent or empty, else
##                                replay-failure cache-not-fresh) or warm (it must exist)
##   RS_RECEIVER_STORE_DIR        file mode: the capture's store, the origin for fetch "directory"
##                                (reading from it counts as a fetch)
##   RS_RECEIVER_WEB_STORE        WX (web export, file mode; results/p3/wx.md): lazy (default)
##                                fetches each payload from RS_RECEIVER_STORE_DIR when the
##                                transaction that needs it is applied (the browser's fetch(),
##                                as live GETs) and drops it from memory once uploaded (64 KiB
##                                and up, RsResourceCache.DROP_MIN_BYTES); staged is
##                                the pre-WX path (the whole store fetched into memory before
##                                _ready). Ignored natively
##   RS_RECEIVER_FETCH_TIMEOUT_MS live, and the web's lazy store (WX): a GET not complete this many
##                                ms after it was issued is resource-unavailable (default 10000)
##   RS_RECEIVER_ACCEPT_ENCODING  G8kz (render-stream-2.md "HTTP (live)"): the Accept-Encoding a native
##                                receiver sends on payload GETs: auto (default, "zstd, gzip"),
##                                zstd, gzip, or off (no header: identity bodies). A coded body is
##                                decoded here and verified after decoding; a web receiver's
##                                browser negotiates and decodes by itself (the variable is unused)
##   RS_RECEIVER_TEXTURE_ENCODINGS G8kp (texture-delivery-design.md D3): the delivery preference a
##                                /9 stream is read with (and a /9 hello states): default
##                                "block,uastc,decoded" (G8ku: `uastc` through Godot's own KTX2
##                                loader, D14); each texture's payload is the first encoding listed
##                                that the entry offers, `block` only for a block format whose
##                                family is in gpu_formats, `decoded` always last
##   RS_RECEIVER_GPU_FORMAT_MASK  G8kp: comma-separated families (s3tc, bptc, rgtc, etc2, astc)
##                                left out of gpu_formats, which is otherwise every family
##                                RenderingServer.has_os_feature reports. G8ku: the web export reads
##                                both too (and may offer /9). G8kwh: on the web a family counts
##                                only when the page's WebGL context also lists its extension
##                                (Godot claims etc2 on every web build), and WebGL's BC alignment
##                                rule applies (set_webgl_rules); RS_RECEIVER_SABOTAGE=
##                                advertise-etc2 states etc2 anyway (the pre-G8kwh hello)
##   RS_RECEIVER_VARIANT_POLICY   G8ku (D6): keep (default) holds a texture's resident payload when a
##                                variant it prefers appears at an equal version; upgrade refetches
##   RS_RECEIVER_TRANSCODE_LOG    G8ku (D16): 1 hashes each KTX2 transcode's uploaded blocks into
##                                the report's transcodes[] (format, size and time are always there)
##   RS_RECEIVER_SHADER_LIBRARY   G55d (gate5_5-design.md D4, Q5): absolute operator-local GRP1
##                                library (sha256/<hash>.grp) a `withheld` shader's code comes
##                                from, verified by hash; without it (or without that hash) the
##                                shader is skipped and applied.json's `unsupported` gains
##                                {seq, item: null, name: "shader_set_code", reason:
##                                "shader-withheld", shader: <id>} once per shader and hash
##   RS_RECEIVER_FETCH_DELAY_MS   an injected delay before each fetch, default 0 (file mode: a
##                                blocked main loop; live mode: a timed wait, the loop keeps
##                                presenting)
##   RS_RECEIVER_SABOTAGE         reupload (upload every resident texture at every applied
##                                transaction), ignore-cache (fetch even on a cache hit),
##                                wrong-http-token (live only, G2e: send the correct bearer token
##                                on the WebSocket upgrade but a deliberately wrong one on every
##                                resource GET), ignore-clip (gate3-design.md Q5, G3b: every
##                                canvas_item_set_clip call passes false) or clip-before-clear
##                                (G3b: the pre-gate-3 apply order, the clip setter before content
##                                with no shadow reset on clear) or drop-msdf (gate4-design.md
##                                Q5, G4e2: every add_msdf_texture_rect_region is skipped with no
##                                typed record, the pre-/3 picture), ignore-set-transform or
##                                ignore-clip-ignore (gate5-design.md Q5, G5d: every
##                                add_set_transform / add_clip_ignore is skipped with no record),
##                                ignore-nine-patch-axis (G5g: every add_nine_patch is drawn
##                                stretch/stretch), drop-mesh-surface (G5e: a mesh build never adds
##                                its surface 1) or stale-mesh (G5e: in-place payload changes of a
##                                resident surface are ignored) or refuse-canvas-texture (every
##                                draw naming a canvas texture is skipped and recorded as
##                                canvas-texture-headless, the default headless capture's
##                                picture) or (G55d) ignore-material (canvas_item_set_material is
##                                never called), ignore-canvas-modulate (canvas_set_modulate is
##                                never called) or stale-param (G55e: a material's parameters are
##                                set only when it is created) or (G6a) stale-texture (a resident
##                                RGBA8 image keeps its first payload; LA8 atlas pages still
##                                update) or (G6s) no-evict (RsResourceCache's budgets are
##                                ignored) or (P3-ST) screen-copy-per-reader (a back-buffer copy
##                                before every item whose material reads the screen texture,
##                                canvas_item_set_copy_to_backbuffer, only where a /10 item sets
##                                no copy of its own) or (P3-VX) vertex-flat-varyings (every
##                                shader varying made `flat` before shader_set_code) or (CG1, /10)
##                                drop-canvas-group (canvas_item_set_canvas_group_mode is never
##                                called) or full-backbuffer-copy (every /10 copy_to_backbuffer is
##                                issued with Rect2(), the whole target); all twenty-one exist only
##                                to fail checks or compare
##
## Resource budgets (G6s, gate6-design.md Q5 "Resource budgets"; both modes; rs_resource_cache.gd):
##   RS_RECEIVER_MEMORY_BUDGET_BYTES  unset: unlimited (off by default, every other gate's
##                                    receiver included); set: in-memory payloads past this many
##                                    bytes are evicted least-recently-used, never a hash the
##                                    current transaction's resolved state needs
##   RS_RECEIVER_CACHE_BUDGET_BYTES   disk; default 0 (unlimited), the same rule
## evictions_memory, evictions_disk and refetch_after_evict land in applied.json's `cache` block.
##
## Perf (G6r, both modes; rs_perf.gd):
##   RS_RECEIVER_PERF_OUT   absolute path; writes render-stream-receiver-perf/1 alongside
##                          applied.json on every exit path: histograms for decode_us (accept_
##                          record), apply_us (apply_state), fetch_us and frame_interval_us;
##                          cpu_render_ms/gpu_render_ms with a status (skipped-headless under
##                          --headless); received/applied/submitted counts; a one-line-per-second
##                          timeline (RSS, RenderingServer.get_rendering_info's texture/buffer/
##                          video memory, the disk cache's entries and bytes). Unset: off.
##   RS_RECEIVER_LOG        full (default) or summary: summary drops applied.json's
##                          `transactions`, `fetches`, `uploads` and `mesh_uploads` arrays (shots,
##                          failures and resources_summary's totals stay), for soak and perf legs
##                          (G6s: all four stop accumulating, not just their report field, so none
##                          grows unbounded over a long soak).
## Before a transaction is applied, every `ok` image a command of its resolved state names that is
## not resident (or resident with another hash), and (G5e) every surface payload of an `ok` mesh
## an add_mesh names that is not resident with that hash, and (G55d) the GRP1 code of every `ok`
## `payload` shader a named material names that is not on its RID (plus the textures of those
## materials' parameters and default textures), is made available: from memory (inline resource
## records and earlier fetches), from the cache (a cache hit), or fetched from the store and
## written to the cache. Each is verified against its SHA-256 name and decoded first
## (resource-hash-mismatch, resource-unavailable, resource-invalid otherwise). In live mode with
## `fetch: "http"` (G2c2) a miss is fetched with RsResourceFetcher, `GET <http_path><hash>` on the
## RS_RECEIVER_URL host and port, one keep-alive HTTPClient (on the web export the browser's
## own fetch() through JavaScriptBridge, G7wf: RS_RECEIVER_WEB_FETCH), sequentially, polled
## from _process:
## the transaction waits (unapplied, unacknowledged beyond `received`) until every payload it
## needs is in, and the rendered loop keeps presenting the previous state meanwhile. After a
## reconnect the payloads held in memory are dropped (RS_RECEIVER_RECONNECT_MEMORY=drop, the
## default), so connection 2 takes them from the cache, or kept (keep, G6l).
##
## Live mode (RS_RECEIVER_MODE=live, G1c2):
##   RS_RECEIVER_URL             ws://127.0.0.1:<port>/render-stream or ws://[::1]:<port>/... (required)
##   RS_RECEIVER_OUT             as in file mode
##   RS_RECEIVER_SHOT_WINDOWS    CSV of <step>:<from>-<to> host-frame windows: the first applied
##                               transaction whose frame is in a window is shot (after
##                               frame_post_draw) and its state dumped (optional)
##   RS_RECEIVER_SHOT_FINAL      1 (G6c): after the end record, shoot the last applied state once
##                               more (shots/final.png, a shot with "final": true and that
##                               transaction's seq and frame) before closing
##   RS_RECEIVER_RECEIVED_OUT    absolute path of the received bytes (default <dirname>/received.rs2)
##   RS_RECEIVER_RECEIVED_MAX_BYTES  (G7k) store at most this many received bytes in the received
##                               file (default: all); the stream report's received_truncated says so
##   RS_RECEIVER_INBOUND_BYTES   WebSocketPeer.inbound_buffer_size, set before connecting
##                               (default 16777216)
##   RS_RECEIVER_CREDIT_STAGE    submitted (default) or applied; forced to applied under --headless,
##                               where frame_post_draw never fires
##   RS_RECEIVER_CONNECT_TIMEOUT milliseconds to reach STATE_OPEN (default 10000)
##   RS_RECEIVER_STALL           <step>:<ms> (G1d): after the shot for <step>, block the main loop
##                               <ms> (OS.delay_msec, an INJECTED receiver delay, not GPU work)
##                               before the `submitted` ack
##   RS_RECEIVER_RECONNECT       <step> (G1d): after the shot for <step> (and its submitted ack),
##                               close with 1000, free every RID the applier made, and connect
##                               again: a fresh session on received-2.rs2
##   RS_RECEIVER_RECONNECT_MEMORY drop (default, G2c2) or keep (G6l, gate6-design.md Q7c): what
##                               the payloads held in memory do across RS_RECEIVER_RECONNECT.
##                               drop: connection 2 takes them from its inline records, the
##                               cache directory or a fetch; keep: they stay (content-addressed,
##                               already verified by hash), so only payloads in neither memory nor
##                               the cache directory are fetched. live.reconnect records the mode
##                               and the hashes in memory and in the cache at that moment
##   RS_RECEIVER_RECONNECT_ON_LOSS 1 (G7u, gate7-design.md D14 as amended): a connection that
##                               closes without an end record, other than a host 1002/1008/1009
##                               close, after a session (a frozen page's socket: 1006 on resume)
##                               is recovered as RS_RECEIVER_RECONNECT's part 2 (dispose, a fresh
##                               session on the next connection) instead of live-disconnected, at
##                               most LOSS_RECONNECTS_MAX times; live.loss_reconnects records each
##   RS_RECEIVER_RESYNC          <step> (G1d): refuse the first transaction in that step's window
##                               unapplied, send `resync` for it, and ignore patches until a full
##                               transaction arrives
##   RS_RECEIVER_TOKEN_FILE      G2e (gate2-design.md D13): absolute path to a file holding the
##                               bearer token, sent as "Authorization: Bearer <token>" on the
##                               WebSocket upgrade and on every resource GET. Unset: no token sent
##                               (the session must then declare resources.auth "none" or the host
##                               refuses the upgrade with 401 -> replay-failure live-connect-failed)
##                               Native only. At /7 the token goes in the hello instead of the
##                               upgrade header (resource GETs keep the header).
##   RS_RECEIVER_PROTOCOL        G7l (gate7-design.md Q4 "Live client"): 6 or 7, the wire version
##                               spoken. Natively the default is 6, so every /6 gate is unchanged;
##                               on the web only 7 is allowed, and it is the default. At /7 the
##                               receiver offers subprotocol render-stream.7, sends the /7 hello
##                               (render-stream-7.md "Hello"), and its received tap defaults to
##                               received.rs7 (received-2.rs7 after a reconnect). A close 1008 (or
##                               an `error`) with reason `unauthorized` before any session is
##                               replay-failure live-connect-failed: the /7 analogue of /6's 401
##                               upgrade (gate7-design.md Q8).
##                               G8g: 8 is render-stream/8's live transport (/7's, natively and on
##                               the web; render-stream-8.md "Live transport"): subprotocol
##                               render-stream.8, the /7 hello with protocol "render-stream/8",
##                               received tap received.rs8. A gate 8 host offers only .8.
##                               G8kp: 9 is render-stream/9 (/7's transport, the /9 hello with
##                               texture_encodings and gpu_formats). CG1: 10 is render-stream/10
##                               (render-stream-10.md "Live transport"): subprotocol
##                               render-stream.10, /9's hello with protocol "render-stream/10",
##                               received tap received.rs10; natively and on the web. In file mode
##                               a GRSA recording replays at /10. Either way the core re-issues
##                               each item's canvas_group and copy_to_backbuffer.
##                               W11d: 11 is render-stream/11 (render-stream-11.md "Live
##                               transport"; native): subprotocol render-stream.11, /10's hello
##                               under "render-stream/11" plus W11t's `live_coding`, received tap
##                               received.rs11 (decoded messages). In file mode a GRSB recording
##                               replays at /11. Either way the core ingests dynamic mesh bodies
##                               and draws them with region uploads, and the retention rule drops
##                               every payload that leaves H from memory.
##   RS_RECEIVER_LIVE_CODING     W11d (W11t's coding, /11 only): unset offers "zstd-base,zstd"
##                               (base-prefix zstd, then per-message zstd), `zstd` offers zstd only,
##                               `off` sends no live_coding. Every binary message is decoded by
##                               the core before it is parsed; a `coding` error with a seq sends
##                               `resync` (reason `coding`) and the transactions the decoder skips
##                               until the full one are neither accepted nor acked.
##   RS_RECEIVER_TOKEN           G7l, web only: the bearer token itself (the shell takes it from
##                               the page's fragment; a browser has no token file). /7 only.
##   RS_RECEIVER_CREDIT_WINDOW   G7l: 2 (default since G7wd) or 1, the hello's credit_window (/7 only; the
##                               host grants min(window, its max); applied.json
##                               receiver.credit_window records the grant from the session)
##   RS_RECEIVER_MANIFEST_SHA256 G7e/G7l: 64 lowercase hex, sent as the /7 hello's manifest_sha256
##                               (null when unset) and recorded in applied.json `receiver`
##   RS_RECEIVER_LATE_POLL       G7r (gate7-design.md Q4 "Late poll", D4): 1 moves the socket read,
##                               the fetch poll and the apply from _process to
##                               RenderingServer.frame_pre_draw (the same main-loop iteration, just
##                               before its draw); the `submitted` ack stays at that frame's
##                               frame_post_draw. Unset (default) or 0: _process, exactly as before.
##                               Rendered only: under --headless nothing draws, so it is a usage
##                               error there. applied.json `live.late_poll` is true only when set.
##   RS_RECEIVER_WEB_FETCH       G7wf (web only; a usage error natively): `fetch` (default) GETs
##                               payloads with the browser's fetch() through JavaScriptBridge,
##                               `httpclient` with Godot's web HTTPClient as before G7wf (four
##                               main-loop iterations per GET, G7r; kept for the A/B). The web's
##                               applied.json `live.fetch_impl` is `browser-fetch` or `httpclient`.
## The /7 hello's presentation integers are the window's backing size and the display scale
## (dpr_milli = round(scale * 1000)); a headless receiver sends the project's viewport size and 1000.
## File mode replays a GRS7 recording (a live receiver's received.rs7) with the /7 decoder; every
## other magic goes to the /6 decoder exactly as before.
## The three G1d options need a shot window for their step.
## On open it sends `hello`. Each binary message is appended to the received file, framed (the
## first is the magic and the session, every later one exactly one record), decoded and accepted
## (the core resolves patches) and acked `received` (a resource record is kept, not acked). The newest accepted transaction is
## applied at most once per _process and acked `applied`; at the next frame_post_draw a due shot is
## taken and the `submitted` ack sent. `presented` is unavailable in Godot and never guessed. The
## end record finishes the run; a close without it is replay-failure live-disconnected, a host
## `error` message replay-failure host-error.
##
## Every record is decoded and validated completely, and patches resolved, by the shared Rust core
## (RsRustApplier) before it makes any RenderingServer call for it; the core then reconciles the
## RESOLVED state with its own mirror. A failure
## writes applied.json with status replay-failure and quits with 3. A clean end record writes
## status ok and quits with 0. A usage error (missing or malformed environment, or an unsupported
## mode) quits with 2 and writes nothing.
##
## applied.json is render-stream-receiver-applied/4 since G5e (gate5-design.md Q5): /3's shape,
## each transaction's `resources` gaining meshes_created, meshes_rebuilt, surface_updates,
## mesh_upload_bytes and skipped_mesh_commands (and the entry mesh_commands), a top-level
## `mesh_uploads` list ({stream, seq, id, op: create|rebuild|update|free|custom_aabb, surfaces,
## buffers, bytes}) and mesh totals in resources_summary; state dumps gain `meshes`.
## render-stream-receiver-applied/5 since G55d (gate5_5-design.md Q5): /4's shape, each
## transaction's `resources` gaining shaders_created, shader_code_sets, shader_payload_fetches,
## materials_created, param_sets and instance_param_sets (their totals in resources_summary too),
## fetches of GRP1 payloads with kind "shader", `unsupported` gaining the receiver's own
## shader-withheld entries; state dumps of a /5 stream gain the canvases' `modulate`, the items'
## `material`, `use_parent_material` and `instance_params`, and the `shaders` and `materials`
## tables, all in render-stream-5.md's resolved shapes and key order.
## render-stream-receiver-applied/6 since G6b (gate6-design.md Q5): /5's shape; `viewport` gains
## presentation_size, window_size, oversampling, presentation_check (ok | mismatch |
## skipped-headless) and stretch_applied; each transaction's `resources` (and resources_summary)
## gains canvases_created, canvas_attach (viewport_attach_canvas and viewport_remove_canvas calls)
## and canvas_stacking_sets; `unsupported` gains the receiver's own typed session entries
## (presentation-mismatch, oversampling-mismatch, stretch-mode: seq null, item null, name
## "viewport"); state dumps of a /6 stream carry each canvas's `layer` and `sublayer`.
## render-stream-receiver-applied/7 since G7e (gate7-design.md Q5): /6's shape plus a top-level
## `receiver` block {kind: native | web-export, build_sha256 (RS_RECEIVER_BUILD_SHA256, else
## null), manifest_sha256 (RS_RECEIVER_MANIFEST_SHA256, else null), protocol, credit_window (1 in
## live mode, null in file mode)}. On a web export `cache` is {dir: null, mode: "http-cache"}: the
## browser's HTTP cache stands in for RS_RECEIVER_CACHE_DIR, which is native only (Q4), and a
## disk budget there is typed `cache-budget-unsupported` (seq null, item null, name "cache").
##
## Core (G7xn, gate7-design.md D34, Q14e; both modes): RsRustApplier -- the shared Rust core,
## experiments/render-stream/rs-core, through the GDExtension adapter receiver/ext/ -- decodes,
## validates, resolves and applies in native code, apply as RenderingServer ptrcalls for what
## changed; this script keeps configuration, I/O, evidence and shots. G7gd (2026-10-21) removed
## the GDScript decoder and applier, so it is the only core; applied.json's `receiver` block still
## records it as `core` ("rust").
##   RS_RECEIVER_CORE       unset or rust; any other value is a usage error (G7gd)
##   RS_RECEIVER_CORE_EXT   the adapter's .gdextension (default res://ext/rs_core.gdextension,
##                          built by scripts/build-rs-core-ext.sh); a missing or unloadable
##                          adapter is a usage error
## State dumps are the core's resolved `state` in render-stream-2.ts's form (the same keys;
## numbers as JavaScript prints them), which statesEqual() compares.
##
## Configuration and I/O (G7e, gate7-design.md Q4): every RS_RECEIVER_* value is read through
## RsConfig.get_env() (the environment, else `--rs-env=NAME=VALUE` after `--`), and RsIo carries
## the web export's sources (fetched into memory before the session is applied) and sinks (PUT to
## RS_RECEIVER_EVIDENCE_URL before the exit). Natively both are what they always were.
##
## Stretch (G6b, Q5): at the session, before any item exists, a `canvas_items` session makes the
## receiver's root window adopt the session's stretch (content_scale_mode, _aspect, _stretch,
## _size = logical_size, _factor), so the engine computes the reference's stretch transform and
## oversampling. `disabled` keeps the project's settings; `viewport` is typed `stretch-mode` and
## drawn with the receiver's own settings. Then (1) the root window size must equal
## presentation_size, else `presentation-mismatch`, and (2) the root viewport's oversampling must
## equal font_oversampling (float32), else `oversampling-mismatch`; both still draw, and a
## headless receiver skips both. (3) The visible rect must equal logical_size (viewport-mismatch,
## a replay failure, as before). RS_RECEIVER_SABOTAGE=ignore-presentation keeps stretch disabled
## whatever the session says and skips (3), so it presents the top-left of the logical frame at
## scale 1 (it exists only to fail pixel checks).

const SCHEMA: String = "render-stream-receiver-applied/7"
const EXIT_OK: int = 0
const EXIT_USAGE: int = 2
const EXIT_REPLAY_FAILURE: int = 3
## RS_RECEIVER_SABOTAGE's accepted values (gate2-design.md Q5, gate3-design.md Q5, G3b,
## gate4-design.md Q5, G4e2, gate5-design.md Q5, G5d, G5g, G5e, gate5_5-design.md Q5, G55d,
## gate6-design.md Q6h, G6a).
const SABOTAGES: Array[String] = ["reupload", "ignore-cache", "wrong-http-token", "ignore-clip", "clip-before-clear", "drop-msdf", "ignore-set-transform", "ignore-clip-ignore", "ignore-nine-patch-axis", "drop-mesh-surface", "stale-mesh", "refuse-canvas-texture", "ignore-material", "ignore-canvas-modulate", "stale-param", "stale-texture", "ignore-canvas-stacking", "screen-copy-per-reader", "vertex-flat-varyings", "shader-time-frozen", "drop-canvas-group", "full-backbuffer-copy", "ignore-presentation", "no-evict", "verify-in-frame", "advertise-etc2", "stale-dynamic-rx", "no-prune", "evict-carried", "ignore-released"]
## The six per-transaction `resources` counters render-stream-receiver-applied/5 adds (G55d).
const MATERIAL_COUNTERS: Array[String] = ["shaders_created", "shader_code_sets", "shader_payload_fetches", "materials_created", "param_sets", "instance_param_sets"]
## The three per-transaction `resources` counters render-stream-receiver-applied/6 adds (G6b).
const CANVAS_COUNTERS: Array[String] = ["canvases_created", "canvas_attach", "canvas_stacking_sets"]
## CG1 (render-stream-10.md "Receivers"): the core's canvas_item_set_canvas_group_mode and
## canvas_item_set_copy_to_backbuffer calls, in each transaction's `resources` and in
## resources_summary of a /10 stream only (every older report keeps its shape).
const BACKBUFFER_COUNTERS: Array[String] = ["canvas_group_sets", "backbuffer_copy_sets"]
## File mode carries exactly one stream; transactions and shots name it as stream 1. Live mode
## numbers its connections from 1 (a second one after an RS_RECEIVER_RECONNECT).
const FILE_STREAM: int = 1
const DEFAULT_INBOUND_BYTES: int = 16777216
const DEFAULT_CONNECT_TIMEOUT_MS: int = 10000
## How long the receiver waits for the host's close after the end record before closing itself.
const CLOSE_WAIT_MS: int = 2000
## RS_RECEIVER_RECONNECT_ON_LOSS: the most lost connections one run reconnects after.
const LOSS_RECONNECTS_MAX: int = 3

var _data := PackedByteArray()
var _records: Array[Dictionary] = []
var _next_record: int = 0
var _applier: RsRustApplier = null
var _recording_path: String = ""
var _out_path: String = ""
var _shot_dir: String = ""
var _state_dir: String = ""
var _shot_seqs: Array[int] = []
var _state_seqs: Array[int] = []
var _state_paths: Dictionary[String, String] = {}
var _busy: bool = false
var _finished: bool = false
## WX: the web export's file replay fetches its store per transaction (RS_RECEIVER_WEB_STORE).
var _lazy_store: bool = false
## WX: the file-mode transaction whose payload GETs are running: {meta, record, seq, resources,
## hashes (by GET index), kinds}; empty when none.
var _store_pending: Dictionary = {}
## WX: payloads fetched again after a drop, and their bytes (the web store line).
var _store_rereads: int = 0
var _store_reread_bytes: int = 0
var _last_applied_seq: int = 0
var _previous_unsupported: Dictionary[String, bool] = {}
var _report: Dictionary = {}
var _viewport_report: Dictionary = {}
var _stream_report: Dictionary = {}
var _streams: Array[Dictionary] = []
var _transactions: Array[Dictionary] = []
var _shots: Array[Dictionary] = []
var _unsupported: Array[Dictionary] = []
# Resources (G2b2).
var _cache := RsResourceCache.new()
var _cache_report: Variant = null
var _fetches: RsRowLog = RsRowLog.new()
var _uploads: RsRowLog = RsRowLog.new()
var _mesh_uploads: RsRowLog = RsRowLog.new()
var _fetched_hashes: Dictionary[String, bool] = {}
var _summary: Dictionary = {
	"distinct_fetched": 0, "fetched_bytes": 0, "cache_hits": 0, "uploads": 0, "upload_bytes": 0,
	"meshes_created": 0, "meshes_rebuilt": 0, "surface_updates": 0, "mesh_upload_bytes": 0,
	"shaders_created": 0, "shader_code_sets": 0, "shader_payload_fetches": 0, "materials_created": 0,
	"param_sets": 0, "instance_param_sets": 0,
	"canvases_created": 0, "canvas_attach": 0, "canvas_stacking_sets": 0,
	# G6s (gate6-design.md Q5 "Resource budgets"): unconditionally present (memory eviction needs
	# no RS_RECEIVER_CACHE_DIR), synced from _cache's own counters at _write_report().
	"evictions_memory": 0, "evictions_disk": 0, "refetch_after_evict": 0,
}
## G55d: "<stream>:<shader id>:<hash>" of every shader-withheld skip already reported.
var _withheld_reported: Dictionary[String, bool] = {}
var _fetch_delay_ms: int = 0
var _fetch_timeout_ms: int = 10000
var _inline_since_applied: int = 0
# Perf instrumentation (G6r, Q5 "Perf"): RS_RECEIVER_PERF_OUT (absolute perf.json path, unset:
# off) and RS_RECEIVER_LOG (full default | summary, drops _transactions from applied.json).
var _perf: RsPerf = null
var _perf_out_path: String = ""
var _log_mode: String = "full"
var _perf_headless: bool = false
# G7o3: RS_RECEIVER_PERF_SAMPLES=1 (file mode, with RS_RECEIVER_PERF_OUT): perf.json also lists each
# transaction's timings (`samples`: seq, decode, payload verify, provide, plan, execute, stats and
# apply, in us), for a per-transaction profile. Off by default: a soak's list would grow unbounded.
var _perf_samples: bool = false
## P3-HX: RS_RECEIVER_RSS_EVERY=N (file mode, a diagnostic; 0/unset = off) logs one memory line
## every N applied transactions: process RSS, the engine's tracked static memory, the cache's
## in-memory payload bytes, the receiver's evidence rows and the resident RIDs.
var _rss_every: int = 0
var _payload_totals: Dictionary = {}
var _last_decode_us: int = 0
# G6c: RS_RECEIVER_SHOT_FINAL=1 (live): after the end record, one more shot of the last applied
# state (`final.png`) before the receiver closes.
var _shot_final: bool = false
var _final_shot_done: bool = false
var _last_applied_frame: int = -1
var _fetch_kind: String = ""
var _fetcher: RsResourceFetcher = null
## The transaction waiting for its fetches: {entry, meta, resources (its fetch counters so far)}.
var _pending_apply: Dictionary = {}
var _delivery: String = ""
var _sabotage: String = ""
## G7e: the web export's sources and sinks (no-ops natively).
var _io := RsIo.new()
## G7o2 (D31): the web export's file mode on the Rust core takes each record's digest after the
## frame (RenderingServer.frame_post_draw), not inside decode_us: the offsets of accepted records
## not digested yet, every digest taken (offset -> sha256 hex), and the [entry, record offset]
## pairs of logged transactions still without their record_sha256.
var _digest_deferred: bool = false
var _digest_offsets: Array[int] = []
var _digest_hex: Dictionary = {}
var _digest_entries: Array[Array] = []

# Live mode.
var _live: bool = false
## G7r: RS_RECEIVER_LATE_POLL=1 (_process_live runs from frame_pre_draw instead of _process).
var _late_poll: bool = false
## G7wf: the web export fetches payloads with the browser's fetch() (RS_RECEIVER_WEB_FETCH unset or
## `fetch`), or with HTTPClient as before (`httpclient`, kept for the A/B). Always false natively.
var _web_fetch: bool = false
## G8kz: the Accept-Encoding value the native fetcher sends ("" = none).
var _accept_encoding: String = "zstd, gzip"
var _client: RsLiveClient = null
var _live_report: Dictionary = {}
var _live_phase: String = ""  # connecting | streaming | draining
var _deadline_msec: int = 0
var _url: String = ""
var _credit_stage: String = "submitted"
var _inbound_bytes: int = DEFAULT_INBOUND_BYTES
var _received_path: String = ""
var _received_file: FileAccess = null
## G7k (Q10 soak): RS_RECEIVER_RECEIVED_MAX_BYTES caps what is mirrored into `_received_path`
## (-1: no cap, the default). A web 300-s soak's received.rs7 is ~420 MB in MEMFS, and the exit PUT
## of it alone took ~20 minutes; once the cap is reached, later messages are counted (received_bytes)
## but not stored, and the stream report says so (`received_truncated`).
var _received_cap: int = -1
var _received_stored: int = 0
## G6s (live-buffer trim): `_data` holds at most the one message currently being decoded
## (the core reads a record at an offset local to `_data`, so nothing more is needed); the
## current connection's received byte count, which used to read `_data.size()`, is tracked here
## instead (rs-g6s-live-data-unbounded-growth.md). The whole-stream sha256 is read back from
## `_received_path` -- an exact mirror of `_data`'s old content, flushed every message -- once
## per connection at its end, rather than hashed incrementally on the hot per-message path (a
## benchmark measured incremental HashingContext.update() at +36 us/message, a measurable
## slowdown; a once-per-connection file read-back costs nothing there).
var _data_received_bytes: int = 0
var _session_seen: bool = false
var _stream_id: String = ""
var _windows: Array[Dictionary] = []  # {step, from, to, shot: bool}
var _waiting: Array[Dictionary] = []  # accepted, not yet applied: {entry, meta}
var _submit_pending: bool = false
## G7q (credit window 2, gate7-design.md Q2 "Credit with window w"): the window the session granted
## (publication.credit_window; 1 below /7). At 2 the host may have a second transaction in flight,
## so several accepted transactions can wait for one apply: the resolved state is the newest's, so
## the newest is applied and drawn and the older ones are folded into it (`_coalesced`), each acked
## `applied` with it and `submitted` at its draw (`_coalesced_drawn`), in seq order. At window 1
## nothing is ever folded: the older-waiting path stays exactly what it was.
var _granted_window: int = 1
var _coalesced: Array[Dictionary] = []
var _coalesced_drawn: Array[Dictionary] = []
var _end_seen: bool = false
var _acks_sent: Dictionary = {"received": 0, "applied": 0, "submitted": 0}
var _closing_by_receiver: bool = false
var _received_base: String = ""  # stream 1's received path; stream n inserts "-<n>"
var _connect_timeout_ms: int = DEFAULT_CONNECT_TIMEOUT_MS
## G2e: the bearer token read from RS_RECEIVER_TOKEN_FILE, or "" when unset (no auth). G7l: on
## the web, RS_RECEIVER_TOKEN.
var _token: String = ""
## G7l: the wire version (RS_RECEIVER_PROTOCOL in live mode; the recording's magic in file mode),
## the hello's credit window and manifest sha256 ("" for null).
var _wire_version: int = 6
## G8kp (texture-delivery-design.md D3, Q3): the delivery preference and the GPU families this
## receiver states (RS_RECEIVER_TEXTURE_ENCODINGS, RS_RECEIVER_GPU_FORMAT_MASK); gpu_formats is
## detected once the renderer exists (_new_applier).
const GPU_FAMILIES: Array[String] = ["s3tc", "bptc", "rgtc", "etc2", "astc"]
## G8kwh: the WebGL extension each family needs (lib/gsw-receiver/hello.ts GPU_EXTENSIONS, the GSW
## receiver's own table). Godot's GLES3 config sets etc2_supported unconditionally on any GLES/WebGL
## build (drivers/gles3/storage/config.cpp), so on the web has_os_feature alone is not the context.
const WEBGL_EXTENSIONS: Dictionary = {
	"s3tc": "WEBGL_compressed_texture_s3tc",
	"bptc": "EXT_texture_compression_bptc",
	"rgtc": "EXT_texture_compression_rgtc",
	"etc2": "WEBGL_compressed_texture_etc",
	"astc": "WEBGL_compressed_texture_astc",
}
const TEXTURE_ENCODINGS: Array[String] = ["block", "uastc", "etc1s", "decoded"]
var _texture_encodings: String = "block,uastc,decoded"
## G8ku: RS_RECEIVER_VARIANT_POLICY and RS_RECEIVER_TRANSCODE_LOG.
var _variant_upgrade: bool = false
var _transcode_log: bool = false
var _transcodes: Array[Dictionary] = []
## G8kf (texture-delivery-design.md Q3): each uastc variant whose transcode failed, {stream, seq,
## hash, fallback}: the entry went on with D3's next preference (`decoded` at last).
var _variant_fallbacks: Array[Dictionary] = []
var _gpu_format_mask: Array[String] = []
var _gpu_formats: String = "none"
var _gpu_formats_detected: String = "none"
## G8kwh (web only): what has_os_feature claims, and the context's compressed-texture extensions.
var _gpu_formats_engine: String = "none"
var _webgl_extensions: String = ""
## G8kwh: whether the web export's upload rules apply (the web export, unless sabotaged).
var _webgl_rules: bool = false
var _credit_window: int = 1
var _manifest_sha256: String = ""
## The live connection being read: 1, then 2 after a reconnect. Transactions, shots and state
## dumps name it as their stream.
var _conn_index: int = 1
# G7k (D15 startup marks): each fires once, on connection 1 only (a reconnect's later connections
# are G7u's concern, not a startup leg's).
var _marked_first_applied: bool = false
var _marked_first_submitted: bool = false
# G1d options (-1: off).
var _stall_step: int = -1
var _stall_ms: int = 0
var _reconnect_step: int = -1
var _reconnect_due: bool = false
var _reconnecting: bool = false
## RS_RECEIVER_RECONNECT_MEMORY (G6l): "drop" (G2c2's rule) or "keep".
var _reconnect_memory: String = "drop"
## RS_RECEIVER_RECONNECT_ON_LOSS (G7u).
var _reconnect_on_loss: bool = false
var _loss_reconnects: Array = []
## The record the next connection's dispose and connect attempts fill: live.reconnect (a scheduled
## RS_RECEIVER_RECONNECT) or the newest live.loss_reconnects entry.
var _reconnect_record: Dictionary = {}
var _resync_step: int = -1
var _resync_done: bool = false
var _awaiting_full: bool = false
## W11d: the /11 hello's live_coding offer ("" sends none), whether this connection decodes, and
## the coding resyncs asked; the closed connections' coding stats.
var _live_coding: String = "zstd-base,zstd"
var _coding_on: bool = false
var _coding_resyncs: int = 0
var _coding_reports: Array[Dictionary] = []
## W11d (render-stream-11.md "Receiver retention"): the /11 store evidence, over the whole replay
## (bounded; per transaction only under a full log): the most memory entries after an apply, the
## most beyond |names(S)| + |C|, and the hashes released.
var _w11: Dictionary = {}


func _ready() -> void:
	set_process(false)
	var mode: String = RsConfig.get_env("RS_RECEIVER_MODE").strip_edges()
	if mode == "live":
		_ready_live()
		return
	if mode != "" and mode != "file":
		_log("error: RS_RECEIVER_MODE must be file or live (got %s)" % JSON.stringify(mode))
		_quit(EXIT_USAGE)
		return
	_recording_path = RsConfig.get_env("RS_RECEIVER_RECORDING")
	_out_path = RsConfig.get_env("RS_RECEIVER_OUT")
	if _out_path == "" or not _out_path.is_absolute_path():
		_log("error: RS_RECEIVER_OUT must be an absolute applied.json path (got %s)" % JSON.stringify(_out_path))
		_quit(EXIT_USAGE)
		return
	_shot_dir = _out_path.get_base_dir().path_join("shots")
	_state_dir = _out_path.get_base_dir().path_join("state")
	if not _parse_seqs("RS_RECEIVER_SHOT_SEQS", _shot_seqs) or not _parse_seqs("RS_RECEIVER_STATE_SEQS", _state_seqs):
		_quit(EXIT_USAGE)
		return
	if not _parse_resource_env(false):
		_quit(EXIT_USAGE)
		return
	if not _parse_perf_env() or not _parse_core_env() or not _parse_delivery_env():
		_quit(EXIT_USAGE)
		return

	var display_server: String = _init_report("file")
	if not _open_cache():
		return
	if not await _prepare_sources():
		return
	_log("mode file, recording %s, out %s, shot seqs %s, state seqs %s, display %s" % [_recording_path, _out_path, str(_shot_seqs), str(_state_seqs), display_server])

	if _io.has_recording():
		# WX: the web's lazy store fetched the recording straight into memory.
		_data = _io.take_recording()
	elif _recording_path == "" or not _recording_path.is_absolute_path() or not FileAccess.file_exists(_recording_path):
		_fail(null, "recording-unreadable", "RS_RECEIVER_RECORDING is not an absolute path to an existing file: %s" % JSON.stringify(_recording_path))
		return
	else:
		_data = FileAccess.get_file_as_bytes(_recording_path)
	if _data.is_empty() and FileAccess.get_open_error() != OK:
		_fail(null, "recording-unreadable", "cannot read %s: %s" % [_recording_path, error_string(FileAccess.get_open_error())])
		return
	# G7l: a GRS7 recording (a /7 live receiver's received.rs7) replays at /7; any other magic
	# stays at /6, which refuses everything but GRS6 exactly as before.
	if _data.size() >= 8 and _data.slice(0, 8).hex_encode() == RsWire.MAGIC_V7_HEX:
		_wire_version = 7
		var receiver_block: Dictionary = _report["receiver"]
		receiver_block["protocol"] = RsWire.PROTOCOL_V7
	elif _data.size() >= 8 and _data.slice(0, 8).hex_encode() == RsWire.MAGIC_V9_HEX:
		# G8kp: a texture-delivery recording (render-stream/9 file sink) replays at /9; the core
		# fetches and uploads each texture's payload by D3 (RS_RECEIVER_TEXTURE_ENCODINGS).
		_wire_version = 9
		var receiver_block_v9: Dictionary = _report["receiver"]
		receiver_block_v9["protocol"] = "render-stream/9"
	elif _data.size() >= 8 and _data.slice(0, 8).hex_encode() == RsWire.MAGIC_V10_HEX:
		# CG1: a back-buffer recording (render-stream/10 file sink, GRC_STREAM_VERSION=10) replays
		# at /10 (/9's delivery included); the core re-issues canvas_group and copy_to_backbuffer.
		_wire_version = 10
		var receiver_block_v10: Dictionary = _report["receiver"]
		receiver_block_v10["protocol"] = "render-stream/10"
	elif _data.size() >= 8 and _data.slice(0, 8).hex_encode() == RsWire.MAGIC_V11_HEX:
		# W11d: a render-stream/11 recording (GRC_STREAM_VERSION=11) replays at /11: dynamic mesh
		# bodies by mesh id, the retention rule, inline-fetch-zero.
		_wire_version = 11
		var receiver_block_v11: Dictionary = _report["receiver"]
		receiver_block_v11["protocol"] = RsLiveClient.PROTOCOL_V11
	elif _data.size() >= 8 and _data.slice(0, 8).hex_encode() == RsWire.MAGIC_V8_HEX:
		# G8t: a gate 8 recording (render-stream/8 file sink) replays at /8; the core ignores /8's
		# additions to the tables, so it draws exactly as a /6 recording would.
		_wire_version = 8
		var receiver_block_v8: Dictionary = _report["receiver"]
		receiver_block_v8["protocol"] = "render-stream/8"
	var sha256: String = RsWire.sha256_hex(_data)
	_report["recording"] = {"path": _recording_path, "sha256": sha256, "bytes": _data.size()}
	_stream_report = {
		"stream_id": null,
		"connection": null,
		"received_path": _recording_path,
		"received_sha256": sha256,
		"received_bytes": _data.size(),
		"end_seen": false,
		"closed_by": null,
		"close_code": null,
	}
	_streams.append(_stream_report)

	# Framing first, over the whole file: a framing error stops everything before any RS call.
	var split: Dictionary = RsWire.split_records(_data, _wire_version)
	var split_errors: PackedStringArray = split["errors"]
	if split_errors.size() > 0:
		_fail_with_error(null, split_errors[0])
		return
	_records = split["records"]
	if _records.is_empty():
		_fail_with_error(null, RsWire.err("missing-session", "the recording has no records"))
		return

	_new_applier()
	if _perf != null:
		_perf.enable_render_time_measurement(get_viewport().get_viewport_rid())
	# G7o2 (D31): a browser receiver computes the record digest after the frame. The native
	# receiver and live mode keep it inline.
	if RsConfig.is_web():
		_digest_deferred = true
		_applier.set_digest_deferred(true)
		RenderingServer.frame_post_draw.connect(_flush_digests)
	var raw: Dictionary = _records[_next_record]
	_next_record += 1
	if not _begin_session(_accept_session(_data, RsWire.as_int(raw["offset"]))):
		return
	if _digest_deferred:
		_digest_offsets.append(RsWire.as_int(raw["offset"]))
	set_process(true)


## Shared report skeleton. Returns the display server name.
func _init_report(mode: String) -> String:
	var display_server: String = DisplayServer.get_name()
	var visible_size: Vector2 = get_viewport().get_visible_rect().size
	_viewport_report = {
		"display_server": display_server,
		"size": [int(visible_size.x), int(visible_size.y)],
		# Decided once the session's logical_size is known; null until then.
		"size_check": "skipped-headless" if display_server == "headless" else null,
		"logical_size": null,
		"canvas_transform": [],
		# G6b (render-stream-receiver-applied/6): decided at the first session.
		"presentation_size": null,
		"window_size": null,
		"oversampling": null,
		"presentation_check": null,
		"stretch_applied": false,
	}
	_report = {
		"schema": SCHEMA,
		"receiver": {
			"kind": "web-export" if RsConfig.is_web() else "native",
			"build_sha256": _env_or_null("RS_RECEIVER_BUILD_SHA256"),
			"manifest_sha256": _env_or_null("RS_RECEIVER_MANIFEST_SHA256"),
			"protocol": "render-stream/%d" % _wire_version,
			# G7l: at /7 replaced by the session's granted publication.credit_window.
			"credit_window": 1 if mode == "live" else null,
			# G7xn: which core decoded and applied; the Rust core is the only one since G7gd.
			"core": "rust",
		},
		"mode": mode,
		"recording": null if mode == "live" else {"path": _recording_path, "sha256": null, "bytes": null},
		"session_id": null,
		"streams": _streams,
		"status": "replay-failure",
		"failure": null,
		"end_seen": false,
		"viewport": _viewport_report,
		# RS_RECEIVER_LOG=summary (G6r) drops this array (shots and failures stay); _transactions
		# itself is never appended to under summary mode either, so neither grows unbounded.
		"transactions": null if _log_mode == "summary" else _transactions,
		"shots": _shots,
		"shots_missed": [],
		"unsupported": _unsupported,
		"live": null,
		# G2b2 (render-stream-receiver-applied/3, gate2-design.md Q5 "applied.json"). G6s:
		# RS_RECEIVER_LOG=summary drops these too (resources_summary keeps the totals), the same
		# rule as "transactions" above; _fetches/_uploads/_mesh_uploads are never appended to
		# under summary mode either, so none of the three grows unbounded over a long soak.
		"cache": null,
		"fetches": null if _log_mode == "summary" else _fetches,
		"uploads": null if _log_mode == "summary" else _uploads,
		"transcodes": _transcodes,
		"variant_fallbacks": _variant_fallbacks,
		# G5e (render-stream-receiver-applied/4).
		"mesh_uploads": null if _log_mode == "summary" else _mesh_uploads,
		"resources_summary": _summary,
	}
	return display_server


## RS_RECEIVER_CACHE_DIR / _CACHE_MODE / _STORE_DIR / _FETCH_TIMEOUT_MS / _FETCH_DELAY_MS /
## _SABOTAGE. Logs and returns false when one is malformed (a usage error). The store directory
## is a file-mode variable.
func _parse_resource_env(live: bool) -> bool:
	var cache_dir: String = RsConfig.get_env("RS_RECEIVER_CACHE_DIR").strip_edges()
	if cache_dir != "" and not cache_dir.is_absolute_path():
		_log("error: RS_RECEIVER_CACHE_DIR must be absolute (got %s)" % JSON.stringify(cache_dir))
		return false
	var cache_mode: String = RsConfig.get_env("RS_RECEIVER_CACHE_MODE").strip_edges()
	if cache_mode == "":
		cache_mode = "fresh"
	if cache_mode != "fresh" and cache_mode != "warm":
		_log("error: RS_RECEIVER_CACHE_MODE must be fresh or warm (got %s)" % JSON.stringify(cache_mode))
		return false
	var store_dir: String = RsConfig.get_env("RS_RECEIVER_STORE_DIR").strip_edges()
	if store_dir != "" and (live or not store_dir.is_absolute_path()):
		_log("error: RS_RECEIVER_STORE_DIR must be an absolute directory, and is file-mode only (got %s)" % JSON.stringify(store_dir))
		return false
	_fetch_timeout_ms = _positive_env("RS_RECEIVER_FETCH_TIMEOUT_MS", 10000)
	if _fetch_timeout_ms < 0:
		return false
	var web_store: String = RsConfig.get_env("RS_RECEIVER_WEB_STORE").strip_edges()
	if web_store != "" and web_store != "lazy" and web_store != "staged":
		_log("error: RS_RECEIVER_WEB_STORE must be lazy or staged (got %s)" % JSON.stringify(web_store))
		return false
	_lazy_store = RsConfig.is_web() and not live and web_store != "staged"
	_io.lazy_store = _lazy_store
	var delay_text: String = RsConfig.get_env("RS_RECEIVER_FETCH_DELAY_MS").strip_edges()
	if delay_text != "":
		if not delay_text.is_valid_int() or delay_text.to_int() < 0:
			_log("error: RS_RECEIVER_FETCH_DELAY_MS must be an integer >= 0 (got %s)" % JSON.stringify(delay_text))
			return false
		_fetch_delay_ms = delay_text.to_int()
	var accept_encoding: String = RsConfig.get_env("RS_RECEIVER_ACCEPT_ENCODING").strip_edges()
	match accept_encoding:
		"", "auto":
			_accept_encoding = "zstd, gzip"
		"zstd", "gzip":
			_accept_encoding = accept_encoding
		"off":
			_accept_encoding = ""
		_:
			_log("error: RS_RECEIVER_ACCEPT_ENCODING must be auto, zstd, gzip or off (got %s)" % JSON.stringify(accept_encoding))
			return false
	var sabotage: String = RsConfig.get_env("RS_RECEIVER_SABOTAGE").strip_edges()
	if sabotage != "" and not SABOTAGES.has(sabotage):
		_log("error: RS_RECEIVER_SABOTAGE must be one of %s (got %s)" % [str(SABOTAGES), JSON.stringify(sabotage)])
		return false
	var library_dir: String = RsConfig.get_env("RS_RECEIVER_SHADER_LIBRARY").strip_edges()
	if library_dir != "" and not library_dir.is_absolute_path():
		_log("error: RS_RECEIVER_SHADER_LIBRARY must be an absolute directory (got %s)" % JSON.stringify(library_dir))
		return false
	# G6s (gate6-design.md Q5 "Resource budgets"): unset is unlimited for both (-1: RsResourceCache's
	# own "no budget" sentinel; 0 is RS_RECEIVER_CACHE_BUDGET_BYTES's literal "unlimited" instead,
	# so it goes through the shared non-negative parser), so every other gate's receiver -- none of
	# which sets either variable -- keeps budgets off and its existing behaviour unchanged.
	var memory_budget_text: String = RsConfig.get_env("RS_RECEIVER_MEMORY_BUDGET_BYTES").strip_edges()
	var memory_budget: int = -1
	if memory_budget_text != "":
		if not memory_budget_text.is_valid_int() or memory_budget_text.to_int() < 0:
			_log("error: RS_RECEIVER_MEMORY_BUDGET_BYTES must be an integer >= 0 (got %s)" % JSON.stringify(memory_budget_text))
			return false
		memory_budget = memory_budget_text.to_int()
	var cache_budget: int = _non_negative_env("RS_RECEIVER_CACHE_BUDGET_BYTES", 0)
	if cache_budget < 0:
		return false
	if RsConfig.is_web():
		# gate7-design.md Q4: the cache directory is native only; the browser's HTTP cache is the
		# web export's "disk cache", and it cannot be evicted from, so a disk budget is typed.
		if cache_dir != "":
			_log("error: RS_RECEIVER_CACHE_DIR is native only; on the web the cache is the browser's HTTP cache (got %s)" % JSON.stringify(cache_dir))
			return false
		cache_mode = "http-cache"
		if RsConfig.get_env("RS_RECEIVER_CACHE_BUDGET_BYTES").strip_edges() != "":
			_unsupported.append({"seq": null, "item": null, "name": "cache", "reason": "cache-budget-unsupported"})
			cache_budget = 0
	_cache.dir = cache_dir
	_cache.mode = cache_mode
	_cache.store_dir = store_dir
	_cache.library_dir = library_dir
	_cache.ignore_cache = sabotage == "ignore-cache"
	_cache.no_evict = sabotage == "no-evict"
	_cache.memory_budget_bytes = memory_budget
	_cache.cache_budget_bytes = cache_budget
	_sabotage = sabotage
	return true


## A non-negative integer environment value, or `fallback` when unset; -1 (after logging) when
## malformed. Unlike _positive_env, 0 is accepted (RS_RECEIVER_CACHE_BUDGET_BYTES's "unlimited").
func _non_negative_env(variable: String, fallback: int) -> int:
	var text: String = RsConfig.get_env(variable).strip_edges()
	if text == "":
		return fallback
	if not text.is_valid_int() or text.to_int() < 0:
		_log("error: %s must be an integer >= 0 (got %s)" % [variable, JSON.stringify(text)])
		return -1
	return text.to_int()


## RS_RECEIVER_PERF_OUT / RS_RECEIVER_LOG (G6r, Q5 "Perf"). Logs and returns false when malformed.
func _parse_perf_env() -> bool:
	_perf_out_path = RsConfig.get_env("RS_RECEIVER_PERF_OUT").strip_edges()
	if _perf_out_path != "" and not _perf_out_path.is_absolute_path():
		_log("error: RS_RECEIVER_PERF_OUT must be an absolute path (got %s)" % JSON.stringify(_perf_out_path))
		return false
	_log_mode = RsConfig.get_env("RS_RECEIVER_LOG").strip_edges()
	if _log_mode == "":
		_log_mode = "full"
	if _log_mode != "full" and _log_mode != "summary":
		_log("error: RS_RECEIVER_LOG must be full or summary (got %s)" % JSON.stringify(_log_mode))
		return false
	if _perf_out_path != "":
		_perf = RsPerf.new()
		_perf_headless = DisplayServer.get_name() == "headless"
	var samples: String = RsConfig.get_env("RS_RECEIVER_PERF_SAMPLES").strip_edges()
	if samples != "" and samples != "0" and samples != "1":
		_log("error: RS_RECEIVER_PERF_SAMPLES must be 0 or 1 (got %s)" % JSON.stringify(samples))
		return false
	_perf_samples = samples == "1" and _perf != null
	_rss_every = _non_negative_env("RS_RECEIVER_RSS_EVERY", 0)
	return true


## Opens the cache (after the report exists, so a cache-not-fresh failure is reported).
func _open_cache() -> bool:
	if _cache.mode == "http-cache":
		_cache_report = {"dir": null, "mode": "http-cache", "entries_before": null, "entries_after": null, "bytes_after": null}
		_report["cache"] = _cache_report
		return true
	if _cache.dir == "":
		return true
	var error: String = _cache.open(_cache.dir, _cache.mode, _cache.store_dir)
	_cache_report = {
		"dir": _cache.dir,
		"mode": _cache.mode,
		"entries_before": _cache.entries_before if error == "" else null,
		"entries_after": null,
		"bytes_after": null,
	}
	_report["cache"] = _cache_report
	if error != "":
		_fail_with_error(null, error)
		return false
	_log("cache %s (%s): %d entries; store %s; shader library %s; sabotage %s" % [_cache.dir, _cache.mode, _cache.entries_before, _cache.store_dir if _cache.store_dir != "" else "<none>", _cache.library_dir if _cache.library_dir != "" else "<none>", _sabotage if _sabotage != "" else "<none>"])
	return true


## A resource record (render-stream-2.md "Resource record"), already verified by the core:
## its payload goes to memory. Returns false after failing the replay.
func _receive_resource(record: Dictionary) -> bool:
	var meta: Dictionary = record["meta"]
	var hash: String = meta["hash"]
	var payload: PackedByteArray = _applier.resource_payload()
	if _sabotage == "evict-carried" and _wire_version >= 11:
		# W11d receiver sabotage (W11c's): a carried record is dropped on arrival, so the next
		# transaction that needs it asks the origin for an inline-sized hash: inline-fetch-zero.
		_inline_since_applied += 1
		return true
	var error: String = _cache.add_inline(hash, payload)
	if error != "":
		_fail_with_error(_last_seq_or_null(), error)
		return false
	_inline_since_applied += 1
	return true


## gate2-design.md Q5 step 2: every payload the resolved state needs is made available before
## any RenderingServer call for it. Fills `resources` (fetched, fetched_bytes, cache_hits,
## fetch_us, and since G55d shader_payload_fetches) and the report's fetch list. Returns "" or the
## replay-failure error.
func _obtain_needed(stream_index: int, seq: int, resources: Dictionary) -> String:
	var need: Dictionary = _applier.needed()
	var hashes: Array = need["hashes"]
	var mesh_hashes: Array = need["mesh_hashes"]
	var shader_hashes: Array = need["shader_hashes"]
	var ktx2_hashes: Array = need["ktx2_hashes"] if need.has("ktx2_hashes") else []
	# G6s (gate2-design.md Q5, gate6-design.md Q5 "Resource budgets"): eviction must not touch any
	# of these while this loop is making them available, one call at a time, below.
	_cache.set_needed(hashes)
	var fetch_us: int = RsWire.as_int(resources["fetch_us"])
	for value: Variant in hashes:
		var hash: String = value
		if _cache.has_in_memory(hash):
			continue
		if not _has_cache() and _delivery != "inline":
			return RsWire.err("resource-unavailable", "payload %s is needed, and RS_RECEIVER_CACHE_DIR is unset (delivery %s)" % [hash, _delivery])
		var mesh: bool = mesh_hashes.has(hash)
		var shader: bool = shader_hashes.has(hash)
		var ktx2: bool = ktx2_hashes.has(hash)
		var will_fetch: bool = _cache.ignore_cache or not _cache.cache_has(hash, mesh, shader, ktx2)
		if will_fetch and _wire_version >= 11:
			# W11d: inline-fetch-zero, before a read from the origin (the store directory).
			var refused: String = _applier.check_fetch(hash)
			if refused != "":
				resources["fetch_us"] = fetch_us
				return refused
		if will_fetch and _fetch_delay_ms > 0:
			OS.delay_msec(_fetch_delay_ms)
		var got: Dictionary = _cache.obtain(hash, mesh, shader, ktx2)
		var source: String = got["source"]
		var got_bytes: int = got["bytes"]
		if source == "cache":
			resources["cache_hits"] = RsWire.as_int(resources["cache_hits"]) + 1
			_summary["cache_hits"] = RsWire.as_int(_summary["cache_hits"]) + 1
		elif source == "directory":
			fetch_us += _note_directory_fetch(stream_index, seq, hash, got, mesh, shader, resources)
		var error: String = got["error"]
		if error != "":
			resources["fetch_us"] = fetch_us
			return error
	resources["fetch_us"] = fetch_us
	return ""


## A fetch from the store directory (RsResourceCache.obtain()'s `got`, or WX's lazy-store GET in
## the same shape): its fetch row and the transaction's and summary's counters. Returns its time.
func _note_directory_fetch(stream_index: int, seq: int, hash: String, got: Dictionary, mesh: bool, shader: bool, resources: Dictionary) -> int:
	var got_bytes: int = got["bytes"]
	var start_us: int = got["start_us"]
	var end_us: int = got["end_us"]
	# G6s: dropped under RS_RECEIVER_LOG=summary, as the other per-transaction arrays are.
	if _log_mode != "summary":
		_fetches.append({
			"stream": stream_index, "seq": seq, "hash": hash, "source": "directory",
			"status": null, "bytes": got_bytes, "start_us": start_us, "end_us": end_us,
			"verified": got["verified"], "kind": "mesh" if mesh else ("shader" if shader else "texture"),
		})
	resources["fetched"] = RsWire.as_int(resources["fetched"]) + 1
	if shader:
		resources["shader_payload_fetches"] = RsWire.as_int(resources["shader_payload_fetches"]) + 1
	resources["fetched_bytes"] = RsWire.as_int(resources["fetched_bytes"]) + got_bytes
	_summary["fetched_bytes"] = RsWire.as_int(_summary["fetched_bytes"]) + got_bytes
	_fetched_hashes[hash] = true
	_summary["distinct_fetched"] = _fetched_hashes.size()
	return end_us - start_us


## G8kf: records and logs the variants screen_variants() refused at `seq`.
func _note_variant_fallbacks(refused: Array[Dictionary], stream_index: int, seq: int) -> void:
	for row: Dictionary in refused:
		_variant_fallbacks.append({"stream": stream_index, "seq": seq, "hash": row["hash"], "fallback": "next-preference"})
		_log("seq %d: delivery-transcode-failed for variant %s; falling back to the entry's next preference" % [seq, row["hash"]])


## One transaction's `resources` counters, all zero.
static func _empty_resources() -> Dictionary:
	return {
		"fetched": 0, "fetched_bytes": 0, "cache_hits": 0, "inline_received": 0, "created": 0,
		"updated": 0, "replaced": 0, "freed": 0, "upload_bytes": 0, "fetch_us": 0,
		"skipped_commands": 0, "meshes_created": 0, "meshes_rebuilt": 0, "surface_updates": 0,
		"mesh_upload_bytes": 0, "skipped_mesh_commands": 0, "shaders_created": 0,
		"shader_code_sets": 0, "shader_payload_fetches": 0, "materials_created": 0, "param_sets": 0,
		"instance_param_sets": 0, "canvases_created": 0, "canvas_attach": 0, "canvas_stacking_sets": 0,
	}


## Fetches what the resolved state needs, then applies it. Returns {ok: bool, stats} (ok false
## after failing the replay at `seq`).
func _fetch_and_apply(stream_index: int, seq: int, prefetched: Dictionary = {}) -> Dictionary:
	var resources: Dictionary = _empty_resources()
	for key: String in ["fetched", "fetched_bytes", "fetch_us", "shader_payload_fetches"]:
		if prefetched.has(key):
			resources[key] = prefetched[key]
	resources["inline_received"] = _inline_since_applied
	_inline_since_applied = 0
	var error: String = _obtain_needed(stream_index, seq, resources)
	if error != "":
		_fail_with_error(seq, error)
		return {"ok": false, "stats": {}}
	# G8kf: a uastc file the loader refuses falls back to the entry's next preference (Q3); what
	# that needs (`decoded`, always servable) is obtained before any RenderingServer call.
	for _round: int in range(64):
		var refused: Array[Dictionary] = _applier.screen_variants(_cache)
		if refused.is_empty():
			break
		_note_variant_fallbacks(refused, stream_index, seq)
		error = _obtain_needed(stream_index, seq, resources)
		if error != "":
			_fail_with_error(seq, error)
			return {"ok": false, "stats": {}}
	if _perf != null:
		# The whole fetch stage for this transaction, including HTTP fetches live mode may have
		# run across several earlier _process calls (resources["fetch_us"] already carries those
		# through `prefetched`, not re-timed here).
		_perf.fetch_us.add(RsWire.as_int(resources["fetch_us"]))
	# G7o3: payload verification on arrival since the last transaction (the cache's stage, or its
	# SHA-256 check under verify-in-frame), outside decode_us and apply_us like D31's evidence_hash_us.
	var verify_us: int = _cache.take_verify_us()
	var apply_t0: int = Time.get_ticks_usec() if _perf != null else 0
	var stats: Dictionary = _applier.apply_state(_cache)
	_take_released()
	if _perf != null:
		var apply_us: int = Time.get_ticks_usec() - apply_t0
		_perf.apply_us.add(apply_us)
		if verify_us > 0:
			_perf.payload_verify_us.add(verify_us)
		_perf.provide_us.add(_applier.last_provide_us)
		_perf.plan_us.add(_applier.last_plan_us)
		_perf.execute_us.add(_applier.last_execute_us)
		_perf.stats_us.add(_applier.last_stats_us)
		if _perf_samples:
			_perf.timeline_seq = seq
			_perf.samples.append({
				"seq": seq, "decode_us": _last_decode_us, "payload_verify_us": verify_us, "apply_us": apply_us,
				"provide_us": _applier.last_provide_us,
				"plan_us": _applier.last_plan_us,
				"execute_us": _applier.last_execute_us,
				"stats_us": _applier.last_stats_us,
			})
	if stats.has("error"):
		# G7xn: a payload the core refuses.
		var apply_error: String = stats["error"]
		_fail_with_error(seq, apply_error)
		return {"ok": false, "stats": {}}
	var applied: Dictionary = stats["resources"]
	for key: String in ["created", "updated", "replaced", "freed", "upload_bytes", "skipped_commands"]:
		resources[key] = applied[key]
	var mesh_resources: Dictionary = stats["mesh_resources"]
	if mesh_resources.has("meshes_dynamic_undrawn"):
		# W11d: a named dynamic mesh whose body never arrived (0 on an honest /11 stream).
		_w11_init()
		_w11["dynamic_undrawn"] = RsWire.as_int(_w11["dynamic_undrawn"]) + RsWire.as_int(mesh_resources["meshes_dynamic_undrawn"])
	for key: String in ["meshes_created", "meshes_rebuilt", "surface_updates", "mesh_upload_bytes", "skipped_mesh_commands"]:
		resources[key] = mesh_resources[key]
		if _summary.has(key):
			_summary[key] = RsWire.as_int(_summary[key]) + RsWire.as_int(mesh_resources[key])
	var material_resources: Dictionary = stats["material_resources"]
	for key: String in MATERIAL_COUNTERS:
		if material_resources.has(key):
			resources[key] = material_resources[key]
		_summary[key] = RsWire.as_int(_summary[key]) + RsWire.as_int(resources[key])
	var canvas_resources: Dictionary = stats["canvas_resources"]
	for key: String in CANVAS_COUNTERS:
		resources[key] = canvas_resources[key]
		_summary[key] = RsWire.as_int(_summary[key]) + RsWire.as_int(resources[key])
	if _wire_version >= 10:
		for key: String in BACKBUFFER_COUNTERS:
			resources[key] = canvas_resources[key]
			_summary[key] = RsWire.as_int(_summary.get(key, 0)) + RsWire.as_int(resources[key])
	var skipped_shaders: Array = stats["skipped_shaders"]
	for value: Variant in skipped_shaders:
		var skip: Dictionary = value
		var shader_id: int = RsWire.as_int(skip["id"])
		var skip_hash: String = skip["hash"]
		var reported_key: String = "%d:%d:%s" % [stream_index, shader_id, skip_hash]
		if _withheld_reported.has(reported_key):
			continue
		_withheld_reported[reported_key] = true
		_unsupported.append({"seq": seq, "item": null, "name": "shader_set_code", "reason": skip["reason"], "shader": shader_id})
		_log("seq %d: shader %d (%s) skipped: %s (%s)" % [seq, shader_id, skip_hash, skip["reason"], skip["detail"]])
	stats["resources"] = resources
	# G6s: RS_RECEIVER_LOG=summary drops these per-transaction arrays too, the same as
	# _transactions (_record_transaction), never just their report field -- a 300-s soak can
	# apply tens of thousands of transactions, and an array appended every one of them, never
	# trimmed, is exactly the unbounded RSS growth the soak measures (summary counters below are
	# O(1) running totals and stay unconditional).
	var mesh_uploads: Array = stats["mesh_uploads"]
	for value: Variant in mesh_uploads:
		var mesh_upload: Dictionary = value
		mesh_upload["stream"] = stream_index
		mesh_upload["seq"] = seq
		if _log_mode != "summary":
			_mesh_uploads.append(mesh_upload)
	# G8ku: the KTX2 transcodes (D14, D16), each with the transaction that ran it.
	var transcodes: Array = stats["transcodes"] if stats.has("transcodes") else []
	for value: Variant in transcodes:
		var transcode: Dictionary = value
		transcode["stream"] = stream_index
		transcode["seq"] = seq
		_transcodes.append(transcode)
	var uploads: Array = stats["uploads"]
	for value: Variant in uploads:
		var upload: Dictionary = value
		upload["stream"] = stream_index
		upload["seq"] = seq
		if _log_mode != "summary":
			_uploads.append(upload)
		if upload["op"] != "placeholder":
			_summary["uploads"] = RsWire.as_int(_summary["uploads"]) + 1
			_summary["upload_bytes"] = RsWire.as_int(_summary["upload_bytes"]) + RsWire.as_int(upload["data_bytes"])
	return {"ok": true, "stats": stats}


## G7k (gate7-design.md Q10 "Startup", D15's navigation-relative marks): a no-op natively (every
## call site here is also guarded by RsConfig.is_web(), but this helper repeats the guard so a
## future web-only call site cannot forget it). Fire-and-forget: performance.mark() returns
## nothing worth reading back, so this needs no JavaScriptBridge.create_callback.
func _web_mark(name: String) -> void:
	if not RsConfig.is_web():
		return
	JavaScriptBridge.eval("performance.mark('%s')" % name)



## The session record (accept_record()'s result): viewport size check, then clear colour, canvas
## 1, its transform and cull mask. Returns false (after failing the replay) on any error.
func _begin_session(accepted: Dictionary) -> bool:
	var errors: PackedStringArray = accepted["errors"]
	if errors.size() > 0:
		_fail_with_error(null, errors[0])
		return false
	var record: Dictionary = accepted["record"]
	var meta: Dictionary = record["meta"]
	if accepted["kind"] != "session":
		_fail_with_error(null, RsWire.err("missing-session", "the first record is a %s, not a session" % accepted["kind"]))
		return false
	_report["session_id"] = meta["session_id"]
	var stream_meta: Dictionary = meta["stream"]
	_stream_id = stream_meta["stream_id"]
	_stream_report["stream_id"] = stream_meta["stream_id"]
	_stream_report["connection"] = stream_meta["connection"]
	if _live and _wire_version >= 7:
		# G7l: the window the host granted (render-stream-7.md "Session": publication.credit_window).
		var publication: Dictionary = meta["publication"]
		var receiver_block: Dictionary = _report["receiver"]
		receiver_block["credit_window"] = RsWire.as_int(publication["credit_window"])
		_granted_window = RsWire.as_int(publication["credit_window"])
	var session_viewport: Dictionary = meta["viewport"]
	var logical: Array = session_viewport["logical_size"]
	var logical_size := Vector2(RsWire.as_int(logical[0]), RsWire.as_int(logical[1]))
	_viewport_report["logical_size"] = [int(logical_size.x), int(logical_size.y)]
	var blocks_for_stretch: Array = record["blocks"]
	_adopt_presentation(session_viewport, blocks_for_stretch)
	if DisplayServer.get_name() != "headless" and _sabotage != "ignore-presentation":
		var visible_size: Vector2 = get_viewport().get_visible_rect().size
		if visible_size != logical_size:
			_viewport_report["size_check"] = "mismatch"
			_fail(null, "viewport-mismatch", "visible rect size is %s, the session's logical_size is %s" % [str(visible_size), str(logical_size)])
			return false
		_viewport_report["size_check"] = "ok"
	elif _sabotage == "ignore-presentation" and DisplayServer.get_name() != "headless":
		_viewport_report["size_check"] = "ignored"
	var resources_meta: Dictionary = meta["resources"]
	_delivery = resources_meta["delivery"]
	var fetch: String = resources_meta["fetch"]
	if _delivery != "inline" and not _has_cache():
		_fail(null, "resource-unavailable", "the session's delivery is %s (fetch %s) and RS_RECEIVER_CACHE_DIR is unset" % [_delivery, fetch])
		return false
	_fetch_kind = fetch
	if _live and fetch == "directory":
		_fail(null, "resource-unavailable", "a live session advertises fetch directory")
		return false
	if _live and fetch == "http":
		var http_path: Variant = resources_meta["http_path"]
		var origin: Dictionary = _url_origin(_url)
		if http_path == null or origin.is_empty():
			_fail(null, "resource-unavailable", "fetch http with http_path %s on %s" % [JSON.stringify(http_path), _url])
			return false
		if _fetcher != null:
			_fetcher.cancel()
		var origin_host: String = origin["host"]
		var origin_port: int = origin["port"]
		# G2e sabotage wrong-http-token: the WebSocket upgrade above already used the correct
		# _token (RsLiveClient.open was called before this session was even received); only the
		# HTTP fetcher's copy is corrupted, so "correct on the upgrade, wrong on GET" holds.
		var fetch_token: String = _token
		if _sabotage == "wrong-http-token" and fetch_token != "":
			fetch_token += "-wrong"
		_fetcher = RsResourceFetcher.new(origin_host, origin_port, str(http_path), _fetch_timeout_ms, _fetch_delay_ms, fetch_token, _web_fetch)
		_fetcher.accept_encoding = _accept_encoding
	var blocks: Array = record["blocks"]
	_applier.sabotage = _sabotage
	_applier.begin_session()
	_log("session %s stream %s (%s, %s) applied (%d RS calls)" % [meta["session_id"], stream_meta["stream_id"], stream_meta["transport"], stream_meta["encoding"], _applier.rs_calls])
	if _live and _conn_index == 1:
		_web_mark("rs-session-decoded")
	return true


## G6b (gate6-design.md D2, Q5): adopts the session's stretch on the receiver's root window, then
## checks the presentation size and the oversampling. Runs once per process (a reconnect's second
## session carries the same declaration). A /5 or older session has no presentation keys: its
## stretch is still adopted, the checks are skipped.
var _presentation_done: bool = false


func _adopt_presentation(session_viewport: Dictionary, blocks: Array) -> void:
	if _presentation_done:
		return
	_presentation_done = true
	var stretch: Dictionary = session_viewport["stretch"]
	var mode: String = stretch["mode"]
	var root: Window = get_tree().root
	var headless: bool = DisplayServer.get_name() == "headless"
	var logical: Array = session_viewport["logical_size"]
	if mode == "canvas_items" and _sabotage != "ignore-presentation":
		var aspect_name: String = stretch["aspect"]
		var scale_mode: String = stretch["scale_mode"]
		match aspect_name:
			"ignore":
				root.content_scale_aspect = Window.CONTENT_SCALE_ASPECT_IGNORE
			"keep_width":
				root.content_scale_aspect = Window.CONTENT_SCALE_ASPECT_KEEP_WIDTH
			"keep_height":
				root.content_scale_aspect = Window.CONTENT_SCALE_ASPECT_KEEP_HEIGHT
			"expand":
				root.content_scale_aspect = Window.CONTENT_SCALE_ASPECT_EXPAND
			_:
				root.content_scale_aspect = Window.CONTENT_SCALE_ASPECT_KEEP
		root.content_scale_stretch = Window.CONTENT_SCALE_STRETCH_INTEGER if scale_mode == "integer" else Window.CONTENT_SCALE_STRETCH_FRACTIONAL
		root.content_scale_size = Vector2i(RsWire.as_int(logical[0]), RsWire.as_int(logical[1]))
		# The session's content_scale_factor block (render-stream-1.md "Session record", blocks[4]).
		var factor: PackedFloat32Array = blocks[4]
		root.content_scale_factor = factor[0]
		root.content_scale_mode = Window.CONTENT_SCALE_MODE_CANVAS_ITEMS
		_viewport_report["stretch_applied"] = true
	elif mode == "viewport":
		_unsupported.append({"seq": null, "item": null, "name": "viewport", "reason": "stretch-mode"})
		_log("session: stretch mode viewport is typed stretch-mode, drawn at the receiver's own settings")
	var window_size: Vector2i = root.size
	var oversampling: float = get_viewport().get_oversampling()
	_viewport_report["window_size"] = [window_size.x, window_size.y]
	_viewport_report["oversampling"] = oversampling
	if not session_viewport.has("presentation_size"):
		_viewport_report["presentation_check"] = "skipped-headless" if headless else null
		return
	var presentation: Array = session_viewport["presentation_size"]
	var presentation_size := Vector2i(RsWire.as_int(presentation[0]), RsWire.as_int(presentation[1]))
	_viewport_report["presentation_size"] = [presentation_size.x, presentation_size.y]
	if headless:
		_viewport_report["presentation_check"] = "skipped-headless"
		return
	var mismatch: bool = false
	if window_size != presentation_size:
		mismatch = true
		_unsupported.append({"seq": null, "item": null, "name": "viewport", "reason": "presentation-mismatch"})
		_log("session: window %s, presentation_size %s: presentation-mismatch (still drawn)" % [str(window_size), str(presentation_size)])
	# Compared as float32, the wire's own precision.
	var declared: float = session_viewport["font_oversampling"]
	var pair := PackedFloat32Array([oversampling, declared])
	if pair[0] != pair[1]:
		mismatch = true
		_unsupported.append({"seq": null, "item": null, "name": "viewport", "reason": "oversampling-mismatch"})
		_log("session: oversampling %s, font_oversampling %s: oversampling-mismatch (still drawn)" % [str(oversampling), str(declared)])
	_viewport_report["presentation_check"] = "mismatch" if mismatch else "ok"


func _process(_delta: float) -> void:
	if _perf != null:
		_perf.record_frame_interval()
		_perf.record_render_time(_perf_headless)
		# G6s: memory-cache entries/bytes and live RIDs per kind fill the fields G6r left
		# unavailable (rs_perf.gd); live_rids is null before the session creates _applier.
		var live_rids: Variant = null
		if _applier != null:
			live_rids = {
				"items": _applier.resident_items(), "textures": _applier.resident_textures(),
				"meshes": _applier.resident_meshes(), "shaders": _applier.resident_shaders(),
				"materials": _applier.resident_materials(),
			}
		_perf.sample_timeline(_cache.entries(), _cache.bytes(), _cache.memory_entries(), _cache.memory_bytes(), live_rids)
	if _live:
		if not _late_poll:
			_process_live()
		return
	if _busy or _finished:
		return
	if not _store_pending.is_empty():
		_poll_store_fetch()
		return
	if _next_record >= _records.size():
		_fail(null, "recording-incomplete", "the recording ends after %d records without an end record" % _records.size())
		return
	var expected_seq: int = _last_seq() + 1
	var raw: Dictionary = _records[_next_record]
	_next_record += 1
	# The only place transaction RS calls happen: _fetch_and_apply touches the RenderingServer
	# only after the record decoded, the stream accepted (and resolved) it and every payload it
	# needs is available.
	var decode_t0: int = Time.get_ticks_usec() if _perf != null else 0
	var result: Dictionary = _accept_record(_data, RsWire.as_int(raw["offset"]))
	if _perf != null:
		_last_decode_us = Time.get_ticks_usec() - decode_t0
		_perf.decode_us.add(_last_decode_us)
	var errors: PackedStringArray = result["errors"]
	var record: Dictionary = result["record"]
	var meta: Dictionary = record["meta"]
	var kind: String = result["kind"]
	if _digest_deferred and errors.size() == 0:
		# D31: every accepted record gets its digest after the frame (summary log mode included).
		_digest_offsets.append(RsWire.as_int(raw["offset"]))
	if errors.size() > 0:
		var seq: Variant = null
		if kind == "transaction" or kind == "":
			seq = RsWire.as_int(meta["seq"]) if RsWire.is_int(meta.get("seq")) else expected_seq
		_fail_with_error(seq, errors[0])
		return
	match kind:
		"resource":
			_receive_resource(record)
		"transaction":
			if _lazy_store:
				_begin_store_fetch(meta, record, RsWire.as_int(meta["seq"]), _empty_resources())
				return
			_apply_file_transaction(meta, record, RsWire.as_int(meta["seq"]), {})
		"end":
			_finish()


## Parses a CSV of seqs >= 1 from `variable` into `out`. Logs and returns false when malformed.
func _parse_seqs(variable: String, out: Array[int]) -> bool:
	var text: String = RsConfig.get_env(variable).strip_edges()
	if text == "":
		return true
	for part: String in text.split(","):
		var token: String = part.strip_edges()
		if not token.is_valid_int() or token.to_int() < 1:
			_log("error: %s must be a CSV of seqs >= 1 (got %s)" % [variable, JSON.stringify(text)])
			return false
		out.append(token.to_int())
	return true


## A transactions[] entry for a decoded record; the apply fields are filled when it is applied.
func _transaction_entry(stream: int, meta: Dictionary, record: Dictionary) -> Dictionary:
	return {
		"stream": stream,
		"seq": RsWire.as_int(meta["seq"]),
		"frame": RsWire.as_int(meta["frame"]),
		"encoding": meta["encoding"],
		"record_sha256": record["sha256"],
		"process_frame": null,
		"created": null,
		"freed": null,
		"reparented": null,
		"commands_replayed": null,
		"msdf_commands": null,
		"mesh_commands": null,
		"rs_calls": null,
		"received_us": null,
		"applied_us": null,
		"submitted_us": null,
		"skipped": null,
		"resources": null,
	}


## Fills an entry's apply fields from apply_state()'s stats, logs unsupported commands and reports
## each top-level unsupported entry that is new since the previous applied transaction.
func _note_applied(entry: Dictionary, meta: Dictionary, stats: Dictionary) -> void:
	var seq: int = entry["seq"]
	_last_applied_seq = seq
	_last_applied_frame = entry["frame"]
	entry["process_frame"] = Engine.get_process_frames()
	entry["created"] = stats["created"]
	entry["freed"] = stats["freed"]
	entry["reparented"] = stats["reparented"]
	entry["commands_replayed"] = stats["commands_replayed"]
	entry["msdf_commands"] = stats["msdf_commands"]
	entry["mesh_commands"] = stats["mesh_commands"]
	entry["rs_calls"] = stats["rs_calls"]
	entry["resources"] = stats["resources"]
	var unsupported_commands: Array[Dictionary] = stats["unsupported_commands"]
	for command: Dictionary in unsupported_commands:
		_log("seq %d item %d: unsupported command %s (%s) logged, not drawn" % [seq, command["item"], command["name"], command["reason"]])
	# G7b: web-only typed refusals (the removed GDScript applier's); the core never makes one.
	var web_refused: Array[Dictionary] = stats["mesh_web_refused"]
	for refused: Dictionary in web_refused:
		_unsupported.append({"seq": seq, "item": null, "name": "mesh_surface_update_index_region", "reason": refused["reason"], "mesh": refused["mesh"], "surface": refused["surface"]})
		_log("seq %d: mesh %d surface %d: mesh_surface_update_index_region refused (%s)" % [seq, refused["mesh"], refused["surface"], refused["reason"]])
	var current: Dictionary[String, bool] = {}
	for value: Variant in meta["unsupported"]:
		var unsupported_entry: Dictionary = value
		var key: String = JSON.stringify([unsupported_entry["op"], unsupported_entry["item"], unsupported_entry["reason"]])
		current[key] = true
		if not _previous_unsupported.has(key):
			var item: Variant = null if unsupported_entry["item"] == null else RsWire.as_int(unsupported_entry["item"])
			_unsupported.append({"seq": seq, "item": item, "name": unsupported_entry["op"], "reason": unsupported_entry["reason"]})
			_log("seq %d: unsupported %s item %s (%s)" % [seq, unsupported_entry["op"], str(item), unsupported_entry["reason"]])
	_previous_unsupported = current
	if _wire_version >= 11:
		_note_w11(entry)


func _record_transaction(meta: Dictionary, record: Dictionary, stats: Dictionary) -> void:
	var entry: Dictionary = _transaction_entry(FILE_STREAM, meta, record)
	if _log_mode != "summary":
		_transactions.append(entry)
		if _digest_deferred:
			_digest_entries.append([entry, RsWire.as_int(record["offset"])])
	_note_applied(entry, meta, stats)
	var seq: int = entry["seq"]
	if _rss_every > 0 and seq % _rss_every == 0:
		_log_memory(seq)

	if _state_seqs.has(seq) and not _dump_state(seq):
		return

	if _shot_seqs.has(seq):
		if DisplayServer.get_name() == "headless":
			_fail(seq, "shot-unavailable", "a shot of seq %d was requested, but the display server is headless" % seq)
			return
		_busy = true
		RenderingServer.frame_post_draw.connect(_take_shot.bind(seq), CONNECT_ONE_SHOT)


## P3-HX: the RS_RECEIVER_RSS_EVERY line.
func _log_memory(seq: int) -> void:
	_log("mem seq=%d rss_mb=%d static_mb=%d cache_mem_mb=%d cache_mem_n=%d tx_rows=%d fetch_rows=%d upload_rows=%d mesh_upload_rows=%d items=%d textures=%d meshes=%d" % [
		seq, RsPerf.read_rss_bytes() >> 20, OS.get_static_memory_usage() >> 20,
		_cache.memory_bytes() >> 20, _cache.memory_entries(), _transactions.size(), _fetches.size(),
		_uploads.size(), _mesh_uploads.size(), _applier.resident_items(), _applier.resident_textures(),
		_applier.resident_meshes()])


## Writes state/<name>.json: the resolved state just applied, in render-stream-2.md's resolved
## `state` shape and key order (the core's). Returns false (after failing the replay) when it
## cannot write.
func _dump_state(seq: int) -> bool:
	var path: String = _state_dir.path_join("%s.json" % _seq_name(seq))
	var made: Error = DirAccess.make_dir_recursive_absolute(_state_dir)
	if made != OK:
		_fail(seq, "state-failed", "cannot create %s: %s" % [_state_dir, error_string(made)])
		return false
	var file: FileAccess = FileAccess.open(path, FileAccess.WRITE)
	if file == null:
		_fail(seq, "state-failed", "cannot write %s: %s" % [path, error_string(FileAccess.get_open_error())])
		return false
	file.store_string(_applier.state_json() + "\n")
	file.close()
	_state_paths[_seq_name(seq)] = path
	_log("state seq %d -> %s" % [seq, path])
	return true


## "seq-<n>" (stream 1). Live connections after the first get "stream-<k>-seq-<n>" (G1d).
func _seq_name(seq: int) -> String:
	if _conn_index > 1:
		return "stream-%d-seq-%d" % [_conn_index, seq]
	return "seq-%d" % seq


## Saves the viewport after frame_post_draw as shots/<name>.png. Returns the path, or "" after
## failing the replay.
func _save_shot(seq: int) -> String:
	var image: Image = get_viewport().get_texture().get_image()
	var path: String = _shot_dir.path_join("%s.png" % _seq_name(seq))
	var made: Error = DirAccess.make_dir_recursive_absolute(_shot_dir)
	if image == null or made != OK:
		_fail(seq, "shot-failed", "no image or no shot directory (%s)" % error_string(made))
		return ""
	var saved: Error = image.save_png(path)
	if saved != OK:
		_fail(seq, "shot-failed", "save_png(%s) failed: %s" % [path, error_string(saved)])
		return ""
	return path


func _take_shot(seq: int) -> void:
	if _finished:
		return
	var path: String = _save_shot(seq)
	if path == "":
		return
	_shots.append({
		"stream": FILE_STREAM,
		"seq": seq,
		"step": null,
		"path": path,
		"state_path": _state_paths.get(_seq_name(seq)),
		"process_frame": Engine.get_process_frames(),
		"applied_through": _last_applied_seq,
	})
	_log("shot seq %d -> %s (applied through %d)" % [seq, path, _last_applied_seq])
	_busy = false


func _finish() -> void:
	_stream_report["end_seen"] = true
	_report["end_seen"] = true
	for seq: int in _shot_seqs:
		var taken: bool = false
		for shot: Dictionary in _shots:
			if shot["seq"] == seq:
				taken = true
		if not taken:
			_fail(seq, "shot-unavailable", "a shot of seq %d was requested, but the recording has no such transaction" % seq)
			return
	for seq: int in _state_seqs:
		if not _state_paths.has(_seq_name(seq)):
			_fail(seq, "state-unavailable", "a state dump of seq %d was requested, but the recording has no such transaction" % seq)
			return
	# D31 record-digest-complete: every accepted record has its digest, and every applied
	# transaction carries it, before the evidence is written.
	_flush_digests()
	if _digest_deferred and _digest_hex.size() != _accepted_records():
		_fail(null, "record-digest-incomplete", "%d accepted record(s), %d digests" % [_accepted_records(), _digest_hex.size()])
		return
	for entry: Dictionary in _transactions:
		if entry["record_sha256"] == "":
			_fail(entry["seq"], "record-digest-incomplete", "transaction seq %d has no record digest" % entry["seq"])
			return
	_report["status"] = "ok"
	_write_report()
	_log("ok: %d transactions applied, %d shots, %d state dumps, %d unsupported, %d RS calls" % [_transactions.size(), _shots.size(), _state_paths.size(), _unsupported.size(), _applier.rs_calls])
	_quit(EXIT_OK)


# --------------------------------------------------------------------------- live mode (G1c2)


func _ready_live() -> void:
	_live = true
	_data_received_bytes = 0
	_out_path = RsConfig.get_env("RS_RECEIVER_OUT")
	if _out_path == "" or not _out_path.is_absolute_path():
		_log("error: RS_RECEIVER_OUT must be an absolute applied.json path (got %s)" % JSON.stringify(_out_path))
		_quit(EXIT_USAGE)
		return
	for variable: String in ["RS_RECEIVER_RECORDING", "RS_RECEIVER_SHOT_SEQS", "RS_RECEIVER_STATE_SEQS"]:
		if RsConfig.get_env(variable) != "":
			_log("error: %s is a file-mode variable; live mode uses RS_RECEIVER_URL and RS_RECEIVER_SHOT_WINDOWS" % variable)
			_quit(EXIT_USAGE)
			return
	_url = RsConfig.get_env("RS_RECEIVER_URL").strip_edges()
	if not (_url.begins_with("ws://127.0.0.1:") or _url.begins_with("ws://[::1]:")):
		_log("error: RS_RECEIVER_URL must be ws://127.0.0.1:<port>/... or ws://[::1]:<port>/... (loopback only; got %s)" % JSON.stringify(_url))
		_quit(EXIT_USAGE)
		return
	_shot_dir = _out_path.get_base_dir().path_join("shots")
	_state_dir = _out_path.get_base_dir().path_join("state")
	if not _parse_windows() or not _parse_g1d_options():
		_quit(EXIT_USAGE)
		return
	var shot_final: String = RsConfig.get_env("RS_RECEIVER_SHOT_FINAL").strip_edges()
	if shot_final != "" and shot_final != "1":
		_log("error: RS_RECEIVER_SHOT_FINAL must be 1 or unset (got %s)" % JSON.stringify(shot_final))
		_quit(EXIT_USAGE)
		return
	_shot_final = shot_final == "1"
	var late_poll: String = RsConfig.get_env("RS_RECEIVER_LATE_POLL").strip_edges()
	if late_poll != "" and late_poll != "0" and late_poll != "1":
		_log("error: RS_RECEIVER_LATE_POLL must be 0, 1 or unset (got %s)" % JSON.stringify(late_poll))
		_quit(EXIT_USAGE)
		return
	_late_poll = late_poll == "1"
	if _late_poll and DisplayServer.get_name() == "headless":
		# frame_pre_draw never fires under --headless (main/main.cpp draws nothing).
		_log("error: RS_RECEIVER_LATE_POLL=1 needs a drawing main loop (frame_pre_draw never fires under --headless)")
		_quit(EXIT_USAGE)
		return
	var web_fetch: String = RsConfig.get_env("RS_RECEIVER_WEB_FETCH").strip_edges()
	if web_fetch != "" and not RsConfig.is_web():
		_log("error: RS_RECEIVER_WEB_FETCH is web only; a native receiver fetches through HTTPClient")
		_quit(EXIT_USAGE)
		return
	if web_fetch != "" and web_fetch != "fetch" and web_fetch != "httpclient":
		_log("error: RS_RECEIVER_WEB_FETCH must be fetch, httpclient or unset (got %s)" % JSON.stringify(web_fetch))
		_quit(EXIT_USAGE)
		return
	_web_fetch = RsConfig.is_web() and web_fetch != "httpclient"
	if not _parse_wire_env():
		_quit(EXIT_USAGE)
		return
	_received_path = RsConfig.get_env("RS_RECEIVER_RECEIVED_OUT")
	if _received_path == "":
		_received_path = _out_path.get_base_dir().path_join(("received.rs%d" % _wire_version) if _wire_version >= 7 else "received.rs2")
	elif not _received_path.is_absolute_path():
		_log("error: RS_RECEIVER_RECEIVED_OUT must be absolute (got %s)" % JSON.stringify(_received_path))
		_quit(EXIT_USAGE)
		return
	_received_base = _received_path
	var received_cap_text: String = RsConfig.get_env("RS_RECEIVER_RECEIVED_MAX_BYTES").strip_edges()
	if received_cap_text != "":
		if not received_cap_text.is_valid_int() or received_cap_text.to_int() < 0:
			_log("error: RS_RECEIVER_RECEIVED_MAX_BYTES must be a non-negative integer (got %s)" % JSON.stringify(received_cap_text))
			_quit(EXIT_USAGE)
			return
		_received_cap = received_cap_text.to_int()
	var token_file: String = RsConfig.get_env("RS_RECEIVER_TOKEN_FILE").strip_edges()
	var token_text: String = RsConfig.get_env("RS_RECEIVER_TOKEN").strip_edges()
	if RsConfig.is_web() and token_file != "":
		_log("error: RS_RECEIVER_TOKEN_FILE is native only; on the web the token is RS_RECEIVER_TOKEN (the page's fragment)")
		_quit(EXIT_USAGE)
		return
	if token_text != "":
		if not RsConfig.is_web():
			_log("error: RS_RECEIVER_TOKEN is web only; a native receiver reads RS_RECEIVER_TOKEN_FILE")
			_quit(EXIT_USAGE)
			return
		if _wire_version < 7 or not RsLiveClient.is_hex64(token_text):
			_log("error: RS_RECEIVER_TOKEN must be 64 lowercase hex on a render-stream/7, /8 or /9 connection")
			_quit(EXIT_USAGE)
			return
		_token = token_text
	if token_file != "":
		if not token_file.is_absolute_path() or not FileAccess.file_exists(token_file):
			_log("error: RS_RECEIVER_TOKEN_FILE is not an absolute path to an existing file (got %s)" % JSON.stringify(token_file))
			_quit(EXIT_USAGE)
			return
		_token = FileAccess.get_file_as_string(token_file).strip_edges()
		if _token == "":
			_log("error: RS_RECEIVER_TOKEN_FILE %s is empty" % JSON.stringify(token_file))
			_quit(EXIT_USAGE)
			return
		if _wire_version >= 7 and not RsLiveClient.is_hex64(_token):
			_log("error: RS_RECEIVER_TOKEN_FILE %s does not hold 64 lowercase hex (a /7 hello token)" % JSON.stringify(token_file))
			_quit(EXIT_USAGE)
			return
	var inbound: int = _positive_env("RS_RECEIVER_INBOUND_BYTES", DEFAULT_INBOUND_BYTES)
	var timeout_ms: int = _positive_env("RS_RECEIVER_CONNECT_TIMEOUT", DEFAULT_CONNECT_TIMEOUT_MS)
	if inbound < 0 or timeout_ms < 0:
		_quit(EXIT_USAGE)
		return
	_inbound_bytes = inbound
	_connect_timeout_ms = timeout_ms
	var stage: String = RsConfig.get_env("RS_RECEIVER_CREDIT_STAGE").strip_edges()
	if stage == "":
		stage = "submitted"
	if not RsLiveClient.CREDIT_STAGES.has(stage):
		_log("error: RS_RECEIVER_CREDIT_STAGE must be submitted or applied (got %s)" % JSON.stringify(stage))
		_quit(EXIT_USAGE)
		return
	if not _parse_resource_env(true):
		_quit(EXIT_USAGE)
		return
	if not _parse_perf_env() or not _parse_core_env() or not _parse_delivery_env():
		_quit(EXIT_USAGE)
		return
	var display_server: String = _init_report("live")
	if not _open_cache():
		return
	if not await _prepare_sources():
		return
	if display_server == "headless" and stage == "submitted":
		# frame_post_draw never fires under --headless (main/main.cpp:4814-4839).
		_log("credit stage forced to applied under --headless")
		stage = "applied"
	_credit_stage = stage
	_live_report = {
		"url": _url,
		"credit_stage": _credit_stage,
		"inbound_buffer_bytes": _inbound_bytes,
		"presented": "unavailable",
		"acks_sent": _acks_sent,
		"stall": null,
		"reconnect": null,
		"resync": null,
	}
	if _late_poll:
		# Only when set, so every other live leg's applied.json is byte-for-byte what it was.
		_live_report["late_poll"] = true
	if _reconnect_on_loss:
		# Only when set, likewise.
		_live_report["loss_reconnects"] = _loss_reconnects
	if RsConfig.is_web():
		# G7wf: the web export's payload GET mechanism (never on a native receiver's report).
		_live_report["fetch_impl"] = "browser-fetch" if _web_fetch else "httpclient"
	_report["live"] = _live_report
	_stream_report = {
		"stream_id": null,
		"connection": null,
		"received_path": _received_path,
		"received_sha256": null,
		"received_bytes": 0,
		"end_seen": false,
		"closed_by": null,
		"close_code": null,
	}
	_streams.append(_stream_report)
	_log("mode live, url %s, out %s, received %s, credit %s, inbound %d, windows %s, stall %s, reconnect %s, resync %s, display %s" % [_url, _out_path, _received_path, _credit_stage, _inbound_bytes, JSON.stringify(_windows), "%d:%d" % [_stall_step, _stall_ms] if _stall_step >= 0 else "off", str(_reconnect_step) if _reconnect_step >= 0 else "off", str(_resync_step) if _resync_step >= 0 else "off", display_server])
	if _wire_version >= 7:
		# Never the token itself (token-not-logged): only whether one is held.
		_log("protocol %s, credit window %d asked, token %s, manifest %s" % ["render-stream/%d" % _wire_version, _credit_window, "held" if _token != "" else "none", _manifest_sha256 if _manifest_sha256 != "" else "none"])
	if display_server == "headless" and (not _windows.is_empty() or _shot_final):
		_fail(null, "shot-unavailable", "shot windows were requested, but the display server is headless")
		return

	DirAccess.make_dir_recursive_absolute(_received_path.get_base_dir())
	_received_stored = 0
	_received_file = FileAccess.open(_received_path, FileAccess.WRITE)
	if _received_file == null:
		_fail(null, "received-unwritable", "cannot write %s: %s" % [_received_path, error_string(FileAccess.get_open_error())])
		return
	_new_applier()
	if _perf != null:
		_perf.enable_render_time_measurement(get_viewport().get_viewport_rid())
	_client = RsLiveClient.new()
	var opened: Error = _client.open(_url, _inbound_bytes, _token, _wire_version)
	if opened != OK:
		_fail(null, "live-connect-failed", "connect_to_url(%s): %s" % [_url, error_string(opened)])
		return
	_live_phase = "connecting"
	_deadline_msec = Time.get_ticks_msec() + timeout_ms
	if _late_poll:
		# G7r: read, fetch-poll and apply just before this iteration's draw; the submitted ack is
		# still the same frame's frame_post_draw (_finish_apply connects it).
		RenderingServer.frame_pre_draw.connect(_process_live)
		_log("late poll: socket read and apply at frame_pre_draw")
	set_process(true)


## G7l: RS_RECEIVER_PROTOCOL (6 natively by default, 7 on the web, where it is the default; G8g: 8,
## render-stream/8's live transport, natively and on the web; a gate 8 host offers only .8),
## RS_RECEIVER_CREDIT_WINDOW (1 or 2, /7 only) and RS_RECEIVER_MANIFEST_SHA256 (64 lowercase hex,
## checked at /7). Logs and returns false when one is malformed (a usage error).
func _parse_wire_env() -> bool:
	var protocol_text: String = RsConfig.get_env("RS_RECEIVER_PROTOCOL").strip_edges()
	if protocol_text == "":
		protocol_text = "7" if RsConfig.is_web() else "6"
	if not ["6", "7", "8", "9", "10", "11"].has(protocol_text):
		_log("error: RS_RECEIVER_PROTOCOL must be 6, 7, 8, 9, 10 or 11 (got %s)" % JSON.stringify(protocol_text))
		return false
	if protocol_text == "11" and RsConfig.is_web():
		_log("error: render-stream/11 live is native only until W11e (RS_RECEIVER_PROTOCOL 11)")
		return false
	if RsConfig.is_web() and not ["7", "8", "9", "10"].has(protocol_text):
		_log("error: a web receiver speaks only render-stream/7, /8, (G8ku) /9 or (CG1) /10 (RS_RECEIVER_PROTOCOL %s)" % protocol_text)
		return false
	_wire_version = protocol_text.to_int()
	# G7wd (fork F1): a /7 hello asks for window 2 unless RS_RECEIVER_CREDIT_WINDOW=1; /6 has none.
	_credit_window = 2 if _wire_version >= 7 else 1
	var window_text: String = RsConfig.get_env("RS_RECEIVER_CREDIT_WINDOW").strip_edges()
	if window_text != "":
		if window_text != "1" and window_text != "2":
			_log("error: RS_RECEIVER_CREDIT_WINDOW must be 1 or 2 (got %s)" % JSON.stringify(window_text))
			return false
		if _wire_version < 7 and window_text != "1":
			_log("error: RS_RECEIVER_CREDIT_WINDOW %s needs RS_RECEIVER_PROTOCOL=7 (render-stream/6 has no window)" % window_text)
			return false
		_credit_window = window_text.to_int()
	# W11d: W11t's live coding offer (/11 only).
	var coding_text: String = RsConfig.get_env("RS_RECEIVER_LIVE_CODING").strip_edges()
	match coding_text:
		"":
			_live_coding = "zstd-base,zstd"
		"zstd":
			_live_coding = "zstd"
		"off":
			_live_coding = ""
		_:
			_log("error: RS_RECEIVER_LIVE_CODING must be zstd or off (got %s)" % JSON.stringify(coding_text))
			return false
	if coding_text != "" and _wire_version < 11:
		_log("error: RS_RECEIVER_LIVE_CODING needs RS_RECEIVER_PROTOCOL=11")
		return false
	_manifest_sha256 = RsConfig.get_env("RS_RECEIVER_MANIFEST_SHA256").strip_edges()
	if _wire_version >= 7 and _manifest_sha256 != "" and not RsLiveClient.is_hex64(_manifest_sha256):
		_log("error: RS_RECEIVER_MANIFEST_SHA256 must be 64 lowercase hex (got %s)" % JSON.stringify(_manifest_sha256))
		return false
	return true


## G7l: the /7 hello for this receiver: kind, window, token, manifest and the presentation
## integers (the window's backing size and the display scale; headless: the project's viewport
## size and 1000, gate7-design.md Q2).
func _hello_v7() -> Dictionary:
	var kind: String = "web-export" if RsConfig.is_web() else "native"
	var backing := Vector2i(0, 0)
	var dpr_milli: int = 1000
	if DisplayServer.get_name() == "headless":
		var width: int = ProjectSettings.get_setting("display/window/size/viewport_width", 0)
		var height: int = ProjectSettings.get_setting("display/window/size/viewport_height", 0)
		backing = Vector2i(width, height)
	else:
		backing = DisplayServer.window_get_size()
		var scale: float = DisplayServer.screen_get_scale()
		if scale > 0.0:
			dpr_milli = roundi(scale * 1000.0)
	var css := Vector2i(backing.x * 1000 / dpr_milli, backing.y * 1000 / dpr_milli)
	return RsLiveClient.hello_v7("gate1-receiver-%s" % DisplayServer.get_name(), kind, _credit_stage, _credit_window, _inbound_bytes, _token, _manifest_sha256, backing, css, dpr_milli, "render-stream/%d" % _wire_version)


## A positive integer environment value, or `fallback` when unset; -1 (after logging) when
## malformed.
func _positive_env(variable: String, fallback: int) -> int:
	var text: String = RsConfig.get_env(variable).strip_edges()
	if text == "":
		return fallback
	if not text.is_valid_int() or text.to_int() < 1:
		_log("error: %s must be an integer >= 1 (got %s)" % [variable, JSON.stringify(text)])
		return -1
	return text.to_int()


## RS_RECEIVER_SHOT_WINDOWS: CSV of <step>:<from>-<to>, from <= to, each step once.
func _parse_windows() -> bool:
	var text: String = RsConfig.get_env("RS_RECEIVER_SHOT_WINDOWS").strip_edges()
	if text == "":
		return true
	var steps: Dictionary[int, bool] = {}
	for part: String in text.split(","):
		var token: String = part.strip_edges()
		var colon: int = token.find(":")
		var dash: int = token.find("-", colon + 1)
		var ok: bool = colon > 0 and dash > colon + 1 and dash < token.length() - 1
		var step_text: String = token.substr(0, colon) if ok else ""
		var from_text: String = token.substr(colon + 1, dash - colon - 1) if ok else ""
		var to_text: String = token.substr(dash + 1) if ok else ""
		ok = ok and step_text.is_valid_int() and from_text.is_valid_int() and to_text.is_valid_int()
		if ok:
			ok = step_text.to_int() >= 0 and from_text.to_int() >= 1 and from_text.to_int() <= to_text.to_int() and not steps.has(step_text.to_int())
		if not ok:
			_log("error: RS_RECEIVER_SHOT_WINDOWS must be a CSV of <step>:<from>-<to> (got %s)" % JSON.stringify(text))
			return false
		steps[step_text.to_int()] = true
		_windows.append({"step": step_text.to_int(), "from": from_text.to_int(), "to": to_text.to_int(), "shot": false})
	return true


## RS_RECEIVER_STALL (<step>:<ms>), RS_RECEIVER_RECONNECT (<step>) and RS_RECEIVER_RESYNC
## (<step>), each optional; every step must have a shot window (gate1-design.md Q5, G1d).
func _parse_g1d_options() -> bool:
	var stall: String = RsConfig.get_env("RS_RECEIVER_STALL").strip_edges()
	if stall != "":
		var parts: PackedStringArray = stall.split(":")
		if parts.size() != 2 or not parts[0].is_valid_int() or not parts[1].is_valid_int() or parts[0].to_int() < 0 or parts[1].to_int() < 1:
			_log("error: RS_RECEIVER_STALL must be <step>:<ms> with ms >= 1 (got %s)" % JSON.stringify(stall))
			return false
		_stall_step = parts[0].to_int()
		_stall_ms = parts[1].to_int()
	for variable: String in ["RS_RECEIVER_RECONNECT", "RS_RECEIVER_RESYNC"]:
		var text: String = RsConfig.get_env(variable).strip_edges()
		if text == "":
			continue
		if not text.is_valid_int() or text.to_int() < 0:
			_log("error: %s must be a step >= 0 (got %s)" % [variable, JSON.stringify(text)])
			return false
		if variable == "RS_RECEIVER_RECONNECT":
			_reconnect_step = text.to_int()
		else:
			_resync_step = text.to_int()
	var memory: String = RsConfig.get_env("RS_RECEIVER_RECONNECT_MEMORY").strip_edges()
	if memory != "":
		if memory != "drop" and memory != "keep":
			_log("error: RS_RECEIVER_RECONNECT_MEMORY must be drop or keep (got %s)" % JSON.stringify(memory))
			return false
		_reconnect_memory = memory
	var on_loss: String = RsConfig.get_env("RS_RECEIVER_RECONNECT_ON_LOSS").strip_edges()
	if on_loss != "" and on_loss != "1":
		_log("error: RS_RECEIVER_RECONNECT_ON_LOSS must be 1 or unset (got %s)" % JSON.stringify(on_loss))
		return false
	_reconnect_on_loss = on_loss == "1"
	for named: Array in [["RS_RECEIVER_STALL", _stall_step], ["RS_RECEIVER_RECONNECT", _reconnect_step], ["RS_RECEIVER_RESYNC", _resync_step]]:
		var step: int = named[1]
		if step >= 0 and _window_of(step).is_empty():
			_log("error: %s names step %d, which has no RS_RECEIVER_SHOT_WINDOWS window" % [named[0], step])
			return false
	return true


## The shot window of `step` ({} when there is none).
func _window_of(step: int) -> Dictionary:
	for window: Dictionary in _windows:
		if window["step"] == step:
			return window
	return {}


func _process_live() -> void:
	if _finished:
		return
	_client.poll()
	var state: WebSocketPeer.State = _client.state()
	if _reconnect_due and _live_phase == "streaming" and not _submit_pending:
		_begin_reconnect()
		return
	match _live_phase:
		"connecting":
			if state == WebSocketPeer.STATE_OPEN:
				_live_phase = "streaming"
				if _reconnect_record.has("opened_us") and _reconnect_record["opened_us"] == null:
					_reconnect_record["opened_us"] = Time.get_ticks_usec()
				if _conn_index == 1:
					_web_mark("rs-socket-open")
				if _wire_version >= 11:
					# W11d: /10's hello under render-stream/11, W11t's live_coding last (golden-11's
					# control hello); the connection's decoder opens with the same offer.
					var hello_v11: Dictionary = RsLiveClient.hello_v9(_hello_v7(), _texture_encodings, _gpu_formats, RsLiveClient.PROTOCOL_V11)
					if _live_coding != "":
						hello_v11["live_coding"] = _live_coding
					_applier.coding_open(_live_coding, _inbound_bytes)
					_coding_on = true
					_send(hello_v11)
				elif _wire_version >= 9:
					# CG1: /10's hello is /9's under protocol render-stream/10.
					_send(RsLiveClient.hello_v9(_hello_v7(), _texture_encodings, _gpu_formats, "render-stream/%d" % _wire_version))
				elif _wire_version >= 7:
					_send(_hello_v7())
				else:
					_send(RsLiveClient.hello("gate1-receiver-%s" % DisplayServer.get_name(), _credit_stage, _inbound_bytes))
				_log("connected to %s as connection %d (subprotocol %s); hello sent" % [_url, _conn_index, _client.peer.get_selected_protocol()])
			elif Time.get_ticks_msec() > _deadline_msec:
				_fail(null, "live-connect-failed", "no open connection to %s (state %d, close code %d)" % [_url, state, _client.close_code()])
			elif state == WebSocketPeer.STATE_CLOSED:
				if not _reconnecting:
					_fail(null, "live-connect-failed", "no open connection to %s (state %d, close code %d)" % [_url, state, _client.close_code()])
					return
				# A reconnect can race the host's teardown of connection 1 (one receiver at a time: a
				# second gets 503), so it retries until the connect timeout.
				var reconnect: Dictionary = _reconnect_record
				reconnect["connect_attempts"] = RsWire.as_int(reconnect["connect_attempts"]) + 1
				var opened: Error = _client.open(_url, _inbound_bytes, _token, _wire_version)
				if opened != OK:
					_fail(null, "live-connect-failed", "connect_to_url(%s): %s" % [_url, error_string(opened)])
			return
		"reconnect-closing":
			# Connection 1 closes (1000) before anything of connection 2 starts.
			if state == WebSocketPeer.STATE_CLOSED or Time.get_ticks_msec() > _deadline_msec:
				_start_next_connection()
			return
		"draining":
			# The receiver closed after the end record; wait for the close handshake.
			if state == WebSocketPeer.STATE_CLOSED or Time.get_ticks_msec() > _deadline_msec:
				_stream_report["closed_by"] = "receiver"
				_stream_report["close_code"] = 1000
				_finish_live()
			return
	_drain_packets()
	if _finished:
		return
	# A transaction waiting for its HTTP fetches (G2c2) is applied once they are all in.
	if not _pending_apply.is_empty():
		_poll_fetches()
		if _finished or not _pending_apply.is_empty():
			return
	# Apply the newest accepted transaction, at most one per _process, never while a submit is
	# pending (the host waits for it under submitted credit anyway).
	if not _waiting.is_empty() and not _submit_pending:
		_apply_newest()
		if _finished:
			return
	if _end_seen and _waiting.is_empty() and not _submit_pending:
		if _shot_final and not _final_shot_done:
			# RS_RECEIVER_SHOT_FINAL: the last applied state, drawn once more, before the close.
			_final_shot_done = true
			_submit_pending = true
			RenderingServer.frame_post_draw.connect(_after_final_shot, CONNECT_ONE_SHOT)
			return
		# The receiver closes: the host lingers for this close after sending the end record, because
		# a WebSocketPeer loses any message that arrives in the same poll() as a close frame
		# (wsl_peer.cpp: no packets once the state is not OPEN; a clean close clears in_buffer).
		_live_phase = "draining"
		_closing_by_receiver = true
		_client.close(1000, "end seen")
		_deadline_msec = Time.get_ticks_msec() + CLOSE_WAIT_MS
		return
	if state != WebSocketPeer.STATE_OPEN and not _end_seen:
		var code: int = _client.close_code()
		var reason: String = _client.close_reason()
		if state == WebSocketPeer.STATE_CLOSING:
			return  # wait for the handshake to finish; the code is final then
		_stream_report["closed_by"] = "host"
		_stream_report["close_code"] = code
		# The host's error text and its close arrive together, so the close reason (which repeats
		# the error's reason) is what a Godot client can rely on.
		if code == 1008 and reason == "unauthorized" and not _session_seen:
			# G7l: the /7 host checks the hello's token after the upgrade; its refusal before any
			# session is the /7 analogue of /6's 401 upgrade (gate7-design.md Q8).
			_fail(null, "live-connect-failed", "unauthorized: the host closed with %d before any session" % code)
		elif code == 1002 or code == 1008 or code == 1009:
			_fail(_last_seq_or_null(), "host-error", "%s: the host closed with %d" % [reason, code])
		elif _reconnect_on_loss and _session_seen and _loss_reconnects.size() < LOSS_RECONNECTS_MAX:
			_begin_loss_reconnect(code, reason)
		else:
			_fail(_last_seq_or_null(), "live-disconnected", "the connection closed (code %d %s) without an end record" % [code, JSON.stringify(reason)])


## RS_RECEIVER_RECONNECT, part 1: after the reconnect step's shot and submitted ack, close
## connection 1 with 1000. Anything the host sent after that ack is never read (a stream the
## receiver closed may stop short of the host's tap).
func _begin_reconnect() -> void:
	_reconnect_due = false
	_live_phase = "reconnect-closing"
	_closing_by_receiver = true
	_stream_report["closed_by"] = "receiver"
	_stream_report["close_code"] = 1000
	_client.close(1000, "reconnect")
	_deadline_msec = Time.get_ticks_msec() + CLOSE_WAIT_MS
	_log("reconnect: closing connection %d after seq %d" % [_conn_index, _last_applied_seq])


## RS_RECEIVER_RECONNECT_ON_LOSS (G7u, gate7-design.md D14 as amended): the connection closed
## without an end record and not by a host error (a frozen page's socket, 1006 on resume). The
## recovery is RS_RECEIVER_RECONNECT's part 2, unscheduled: dispose, then a fresh session whose
## first transaction is the host's newest state. The host treats the lost connection as gate 1d's
## killed receiver. A submit still pending waits for its frame_post_draw first.
func _begin_loss_reconnect(code: int, reason: String) -> void:
	if _submit_pending:
		return
	var record: Dictionary = {
		"connection": _conn_index,
		"code": code,
		"reason": reason,
		"after_seq": _last_applied_seq,
		"after_frame": _last_applied_frame,
		"lost_us": Time.get_ticks_usec(),
		"connect_attempts": 1,
		"created_rids": null,
		"freed_by_apply": null,
		"owned_before_dispose": null,
		"freed_rids": null,
		"leftover_rids": null,
		"closed_us": null,
		"opened_us": null,
	}
	_loss_reconnects.append(record)
	_reconnect_record = record
	_log("reconnect-on-loss: connection %d lost (code %d %s) after seq %d; reconnecting" % [_conn_index, code, JSON.stringify(reason), _last_applied_seq])
	_start_next_connection()


## RS_RECEIVER_RECONNECT, part 2: finish connection 1's received file, free every RID the applier
## made (dispose), and open connection 2 with a new received file and a new decoder stream; its
## first message is a fresh session.
func _start_next_connection() -> void:
	_received_file.flush()
	_received_file.close()
	_received_file = null
	# G6s (live-buffer trim): `_data` no longer holds the whole connection; `_received_path` is
	# its exact byte-for-byte mirror (every message was store_buffer()+flush()ed as it arrived),
	# so the final sha256 is read back from disk once here rather than carried in memory.
	_stream_report["received_sha256"] = RsWire.sha256_hex(FileAccess.get_file_as_bytes(_received_path))
	_stream_report["received_bytes"] = _data_received_bytes
	var owned_before: int = _applier.owned_rids()
	var freed: int = _applier.dispose()
	var leftover: int = _applier.owned_rids()
	var reconnect: Dictionary = _reconnect_record
	reconnect["created_rids"] = _applier.created_rids
	reconnect["freed_by_apply"] = _applier.freed_by_apply
	reconnect["owned_before_dispose"] = owned_before
	reconnect["freed_rids"] = freed
	reconnect["leftover_rids"] = leftover
	reconnect["closed_us"] = Time.get_ticks_usec()
	_log("reconnect: disposed %d RIDs (created %d, freed while applying %d, left %d)" % [freed, _applier.created_rids, _applier.freed_by_apply, leftover])

	if _coding_on:
		# W11d: the closed connection's coding stats; the next opens its own decoder.
		_coding_reports.append(_applier.coding_stats())
		_coding_on = false
	_conn_index += 1
	_received_path = "%s-%d.%s" % [_received_base.get_basename(), _conn_index, _received_base.get_extension()]
	_received_stored = 0
	_received_file = FileAccess.open(_received_path, FileAccess.WRITE)
	if _received_file == null:
		_fail(null, "received-unwritable", "cannot write %s: %s" % [_received_path, error_string(FileAccess.get_open_error())])
		return
	_data = PackedByteArray()
	_data_received_bytes = 0
	_inline_since_applied = 0
	# G2c2: connection 2 owes nothing to connection 1: payloads come from its own inline records,
	# the cache directory or a fetch, never from this process's memory. G6l (keep): the memory
	# map survives, content-addressed and verified by hash, so nothing held is fetched again.
	reconnect["memory"] = _reconnect_memory
	reconnect["memory_hashes"] = _cache.memory_hashes()
	reconnect["cache_hashes"] = _cache.cache_hashes()
	if _reconnect_memory == "drop":
		_cache.clear_memory()
	_pending_apply = {}
	if _fetcher != null:
		_fetcher.cancel()
	_session_seen = false
	_stream_id = ""
	_waiting.clear()
	_coalesced.clear()
	_coalesced_drawn = []
	_previous_unsupported = {}
	_stream_report = {
		"stream_id": null,
		"connection": null,
		"received_path": _received_path,
		"received_sha256": null,
		"received_bytes": 0,
		"end_seen": false,
		"closed_by": null,
		"close_code": null,
	}
	_streams.append(_stream_report)
	_closing_by_receiver = false
	_reconnecting = true
	var opened: Error = _client.open(_url, _inbound_bytes, _token, _wire_version)
	if opened != OK:
		_fail(null, "live-connect-failed", "connect_to_url(%s): %s" % [_url, error_string(opened)])
		return
	_live_phase = "connecting"
	_deadline_msec = Time.get_ticks_msec() + _connect_timeout_ms


## Receives every available packet (binary records, or the host's error text).
func _drain_packets() -> void:
	for packet: Dictionary in _client.take_packets():
		var data: PackedByteArray = packet["data"]
		if not packet["binary"]:
			var parsed: Dictionary = RsLiveClient.parse_host_text(data.get_string_from_utf8())
			var detail: String = "%s: %s" % [parsed["reason"], parsed["detail"]] if parsed["ok"] else "unexpected text message %s" % JSON.stringify(data.get_string_from_utf8())
			if parsed["ok"] and parsed["reason"] == "unauthorized" and not _session_seen:
				# G7l: as the close 1008 `unauthorized` below (a browser may deliver both).
				_fail(null, "live-connect-failed", detail)
				return
			_fail(_last_seq_or_null(), "host-error", detail)
			return
		if _coding_on:
			# W11d (render-stream-11.md "As built (W11t)" 7, 10): decoded before anything parses it.
			var code: int = _applier.coding_decode(data)
			if code == 0:
				continue  # a based transaction the decoder skips until the resync's full: no accept, no ack
			if code < 0:
				var coding_seq: int = _applier.coding_seq()
				var coding_error: String = _applier.coding_error()
				if coding_seq == 0:
					_fail_with_error(_last_seq_or_null(), coding_error)
					return
				_coding_resyncs += 1
				_applier.transport_skip()
				_send(RsLiveClient.resync(_stream_id, coding_seq, "coding"))
				_log("coding: seq %d did not decode (%s); resync asked" % [coding_seq, coding_error])
				continue
			if code == 1:
				data = _applier.coding_output()
		_receive_binary(data)
		if _finished:
			return


## W11d: forgets from memory every payload the /11 retention rule dropped (the core ran it in the
## accept or apply just made); a no-op below /11, unless RS_RECEIVER_SABOTAGE=ignore-released (the
## core then hands nothing back).
func _take_released() -> void:
	if _wire_version < 11:
		return
	for value: Variant in _applier.take_released():
		var hash: String = value
		_cache.release(hash)


## W11d: the /11 store evidence after an apply: memory entries against |names(S)| + |C| (the bound
## `store-bounded` judges), the dynamic geometry held and the rule's drops; the per-transaction row
## (and, under a full log, the held bodies' SHA-256) on `entry`.
func _note_w11(entry: Dictionary) -> void:
	var w: Dictionary = _applier.w11_counters()
	var entries: int = _cache.memory_entries()
	var bound: int = RsWire.as_int(w.get("names", 0)) + RsWire.as_int(w.get("carried", 0))
	_w11_init()
	_w11["applied"] = RsWire.as_int(_w11["applied"]) + 1
	_w11["store_max_entries"] = maxi(RsWire.as_int(_w11["store_max_entries"]), entries)
	_w11["store_max_excess"] = maxi(RsWire.as_int(_w11["store_max_excess"]), entries - bound)
	_w11["names_max"] = maxi(RsWire.as_int(_w11["names_max"]), RsWire.as_int(w.get("names", 0)))
	_w11["carried_max"] = maxi(RsWire.as_int(_w11["carried_max"]), RsWire.as_int(w.get("carried", 0)))
	_w11["dynamic_meshes_max"] = maxi(RsWire.as_int(_w11["dynamic_meshes_max"]), RsWire.as_int(w.get("dynamic_meshes", 0)))
	_w11["dynamic_bytes_max"] = maxi(RsWire.as_int(_w11["dynamic_bytes_max"]), RsWire.as_int(w.get("dynamic_bytes", 0)))
	_w11["released_total"] = w.get("released_total", 0)
	_w11["dynamic_bodies_total"] = w.get("bodies_total", 0)
	_w11["dynamic_body_bytes_total"] = w.get("body_bytes_total", 0)
	_w11["cache_released"] = _cache.released
	_w11["cache_released_bytes"] = _cache.released_bytes
	if _log_mode != "summary":
		entry["w11"] = {"store_entries": entries, "names": w.get("names", 0), "carried": w.get("carried", 0), "dynamic_meshes": w.get("dynamic_meshes", 0), "dynamic_surfaces": w.get("dynamic_surfaces", 0)}
		entry["dynamic_sha256"] = _applier.dynamic_sha256()
		var after: Dictionary = _applier.w11_counters()
		_w11["dynamic_checked"] = after.get("dynamic_checked", 0)
		var mismatched: int = RsWire.as_int(after.get("dynamic_mismatched", 0))
		if mismatched > RsWire.as_int(_w11["dynamic_mismatched"]) and _w11["first_mismatch_seq"] == null:
			_w11["first_mismatch_seq"] = entry["seq"]
		_w11["dynamic_mismatched"] = mismatched


## W11d: the /11 evidence block, in GSW's `gsw.w11` key names (W11c) where they mean the same.
func _w11_init() -> void:
	if not _w11.is_empty():
		return
	_w11 = {
		"applied": 0, "store_max_entries": 0, "store_max_excess": 0, "released_total": 0,
		"dynamic_bodies_total": 0, "dynamic_body_bytes_total": 0, "dynamic_checked": 0,
		"dynamic_mismatched": 0, "first_mismatch_seq": null, "dynamic_undrawn": 0, "names_max": 0,
		"carried_max": 0, "dynamic_meshes_max": 0, "dynamic_bytes_max": 0, "cache_released": 0,
		"cache_released_bytes": 0,
	}


func _receive_binary(message: PackedByteArray) -> void:
	var now_us: int = Time.get_ticks_usec()
	var offset: int = _data.size()
	_data.append_array(message)
	if _received_cap < 0 or _received_stored + message.size() <= _received_cap:
		_received_file.store_buffer(message)
		_received_file.flush()
		_received_stored += message.size()
	elif not _stream_report.get("received_truncated", false):
		_stream_report["received_truncated"] = true
	_data_received_bytes += message.size()
	_stream_report["received_bytes"] = _data_received_bytes
	if not _session_seen:
		# The first message is the magic followed by exactly the session record.
		var split: Dictionary = RsWire.split_records(message, _wire_version)
		var split_errors: PackedStringArray = split["errors"]
		if split_errors.size() > 0:
			_fail_with_error(null, split_errors[0])
			return
		var records: Array[Dictionary] = split["records"]
		if records.size() != 1:
			_fail(null, "live-framing", "the first message holds %d records, expected exactly the session" % records.size())
			return
		_session_seen = true
		_begin_session(_accept_session(_data, 8))
		# G6s (live-buffer trim): the session record is the whole of this message; nothing of
		# it is needed once applied, so `_data` goes back to empty rather than growing for the
		# rest of the connection.
		_data = PackedByteArray()
		return
	var expected_seq: int = _last_seq() + 1
	var decode_t0: int = Time.get_ticks_usec() if _perf != null else 0
	var accepted: Dictionary = _accept_record(_data, offset)
	if _perf != null:
		_perf.decode_us.add(Time.get_ticks_usec() - decode_t0)
	var errors: PackedStringArray = accepted["errors"]
	var record: Dictionary = accepted["record"]
	var meta: Dictionary = record["meta"]
	var kind: String = accepted["kind"]
	if errors.size() > 0:
		var seq: Variant = null
		if kind == "transaction" or kind == "":
			seq = RsWire.as_int(meta["seq"]) if RsWire.is_int(meta.get("seq")) else expected_seq
		_fail_with_error(seq, errors[0])
		return
	if RsWire.as_int(record["byte_length"]) != message.size():
		_fail(null, "live-framing", "a message of %d bytes holds a %d-byte record; every message after the first is exactly one record" % [message.size(), RsWire.as_int(record["byte_length"])])
		return
	match kind:
		"resource":
			# Inline payloads (render-stream-2.md "Live transport"): kept for the transactions that
			# follow; no ack.
			_receive_resource(record)
		"transaction":
			var entry: Dictionary = _transaction_entry(_conn_index, meta, record)
			entry["received_us"] = now_us
			# G7mm: the main-loop iteration whose poll read the transaction; motion-monotonic counts
			# a hold in frames (submitted_process_frame - received_process_frame).
			entry["received_process_frame"] = Engine.get_process_frames()
			if _log_mode != "summary":
				_transactions.append(entry)
			var received_seq: int = entry["seq"]
			_send(RsLiveClient.ack(_stream_id, received_seq, "received", now_us))
			_acks_sent["received"] = RsWire.as_int(_acks_sent["received"]) + 1
			# Only the resolved state after the newest accepted transaction can be applied; an older
			# waiting one is superseded (never happens under credit: one in flight).
			_waiting.append({"entry": entry, "meta": meta})
		"end":
			_end_seen = true
			_stream_report["end_seen"] = true
			_report["end_seen"] = true
			_log("end record after %d transactions" % _applier.transactions)
		_:
			_fail(null, "live-framing", "unexpected %s record" % kind)
	# G6s (live-buffer trim): every message after the first is exactly one record (enforced
	# above), so `_data` holds nothing more to decode once this one is accepted; the next
	# message's `offset := _data.size()` starts back at 0. Bounds receiver RSS by the largest
	# in-flight record instead of growing with total bytes received
	# (rs-g6s-live-data-unbounded-growth.md).
	_data = PackedByteArray()


func _apply_newest() -> void:
	var newest: Dictionary = _waiting[_waiting.size() - 1]
	if _granted_window > 1:
		# G7q: every older waiting transaction is applied with the newest (the resolved state).
		for index: int in range(_waiting.size() - 1):
			_coalesced.append(_waiting[index]["entry"])
	_waiting.clear()
	var entry: Dictionary = newest["entry"]
	var meta: Dictionary = newest["meta"]
	_end_wait_on_folded_full(entry)
	_mark_coalesced(entry)
	if _refuse_for_resync(entry):
		_refuse_coalesced()
		return
	_begin_apply(entry, meta, _empty_resources())


## G7rf: a fold applied during a resync wait can hold the forced full and a later patch. The full
## ends the wait: the folded transactions before it are refused without a second resync (the host
## already has one outstanding), the full and the ones after it apply with the newest, so the
## newest is never refused. No-op unless waiting and the newest is not itself the full.
func _end_wait_on_folded_full(newest_entry: Dictionary) -> void:
	if _resync_step < 0 or not _awaiting_full or newest_entry["encoding"] == "full":
		return
	var at: int = -1
	for index: int in range(_coalesced.size()):
		if _coalesced[index]["encoding"] == "full":
			at = index
	if at < 0:
		return
	_awaiting_full = false
	_log("resync: full transaction seq %d arrived (folded with seq %d)" % [RsWire.as_int(_coalesced[at]["seq"]), RsWire.as_int(newest_entry["seq"])])
	var kept: Array[Dictionary] = []
	for index: int in range(_coalesced.size()):
		if index < at:
			_coalesced[index]["skipped"] = "resync"
		else:
			kept.append(_coalesced[index])
	_coalesced = kept


## G7q: marks every folded transaction with the seq it is applied with, as soon as it is folded
## (so a fetch made for it, or a failure while applying, is attributed to that seq).
func _mark_coalesced(newest_entry: Dictionary) -> void:
	for folded: Dictionary in _coalesced:
		folded["coalesced_into"] = newest_entry["seq"]


## G7q: the newest was refused for a resync, so the transactions folded into it are refused with
## it, each with its own resync (the host frees every later window slot on the first, and the rest
## arrive stale).
func _refuse_coalesced() -> void:
	for folded: Dictionary in _coalesced:
		folded.erase("coalesced_into")
		folded["skipped"] = "resync"
		_send(RsLiveClient.resync(_stream_id, RsWire.as_int(folded["seq"]), "injected"))
	_coalesced.clear()


## Applies one file-mode transaction (its payloads fetched or in memory) and records it. Under
## WX's lazy store (and no memory budget), then drops the store payloads its apply uploaded.
func _apply_file_transaction(meta: Dictionary, record: Dictionary, seq: int, prefetched: Dictionary) -> void:
	var applied: Dictionary = _fetch_and_apply(FILE_STREAM, seq, prefetched)
	if not applied["ok"]:
		return
	var stats: Dictionary = applied["stats"]
	# A memory budget (G6s) keeps its own LRU rule exactly, so it turns the drop off.
	if _lazy_store and _cache.memory_budget_bytes < 0:
		var need: Dictionary = _applier.needed()
		var still_needed: Array = need["hashes"]
		_cache.drop_droppable(still_needed)
	_record_transaction(meta, record, stats)


## WX (web, file mode, RS_RECEIVER_WEB_STORE=lazy): the GETs of every payload the accepted
## transaction `seq` needs that is not in memory, from the store's `sha256/` directory; the
## transaction waits (_poll_store_fetch, one step per _process) and the previous state stays on
## screen meanwhile. With nothing to fetch it applies at once. `resources` carries the fetch
## counters of the passes so far (a G8kf variant fallback makes a second pass).
func _begin_store_fetch(meta: Dictionary, record: Dictionary, seq: int, resources: Dictionary) -> void:
	var need: Dictionary = _applier.needed()
	var hashes: Array = need["hashes"]
	var mesh_hashes: Array = need["mesh_hashes"]
	var shader_hashes: Array = need["shader_hashes"]
	var ktx2_hashes: Array = need["ktx2_hashes"] if need.has("ktx2_hashes") else []
	_cache.set_needed(hashes)
	var wanted: Array[String] = []
	var files: Array[String] = []
	var kinds: Array[Dictionary] = []
	for value: Variant in hashes:
		var hash: String = value
		if _cache.has_in_memory(hash):
			continue
		var mesh: bool = mesh_hashes.has(hash)
		var shader: bool = shader_hashes.has(hash)
		var ktx2: bool = ktx2_hashes.has(hash)
		wanted.append(hash)
		files.append(RsResourceCache.file_name(hash, mesh, shader, ktx2))
		kinds.append({"mesh": mesh, "shader": shader})
	if wanted.is_empty():
		_apply_file_transaction(meta, record, seq, resources)
		return
	_store_pending = {"meta": meta, "record": record, "seq": seq, "resources": resources, "hashes": wanted, "files": files, "kinds": kinds}
	_io.start_store_fetch(files, _fetch_timeout_ms, _fetch_delay_ms)
	_poll_store_fetch()


## WX: one step of the pending transaction's store GETs. Once all are in, each is verified,
## staged and kept (RsResourceCache.add_fetched, exactly obtain()'s directory branch) and recorded
## as a `directory` fetch, in needed() order, the first failure failing the replay at that
## transaction as a store read would; then G8kf's variant screen runs (a refused variant makes a
## second pass for what it now needs), and the transaction is applied.
func _poll_store_fetch() -> void:
	if not _io.poll_store_fetch():
		return
	var pending: Dictionary = _store_pending
	_store_pending = {}
	var seq: int = pending["seq"]
	var resources: Dictionary = pending["resources"]
	var wanted: Array[String] = pending["hashes"]
	var files: Array[String] = pending["files"]
	var kinds: Array[Dictionary] = pending["kinds"]
	var store_dir: String = _cache.store_dir.path_join(RsResourceCache.CACHE_SUBDIR)
	for index: int in range(wanted.size()):
		var hash: String = wanted[index]
		var origin: String = store_dir.path_join(files[index])
		var result: Dictionary = _io.store_results[index]
		var got: Dictionary = {"error": "", "source": "directory", "bytes": 0, "verified": false, "start_us": 0, "end_us": 0}
		if result.is_empty():
			got["error"] = RsWire.err("resource-unavailable", "GET %s: no result" % origin)
		else:
			got["start_us"] = result["start_us"]
			got["end_us"] = result["end_us"]
			var status: Variant = result["status"]
			var fetch_error: String = result["error"]
			if status is int and RsWire.as_int(status) == 404:
				# A store file that is absent: obtain()'s own wording for it.
				got["error"] = RsWire.err("resource-unavailable", "the store has no %s" % origin)
			elif fetch_error != "":
				got["error"] = fetch_error
			else:
				var body: PackedByteArray = result["data"]
				result["data"] = PackedByteArray()
				got["bytes"] = body.size()
				if _cache.was_dropped(hash):
					_store_rereads += 1
					_store_reread_bytes += body.size()
				var add_error: String = _cache.add_fetched(hash, body, origin)
				got["verified"] = not add_error.begins_with("resource-hash-mismatch")
				got["error"] = add_error
				if add_error == "":
					_cache.mark_droppable(hash)
		var kind: Dictionary = kinds[index]
		var mesh: bool = kind["mesh"]
		var shader: bool = kind["shader"]
		resources["fetch_us"] = RsWire.as_int(resources["fetch_us"]) + _note_directory_fetch(FILE_STREAM, seq, hash, got, mesh, shader, resources)
		var error: String = got["error"]
		if error != "":
			_fail_with_error(seq, error)
			return
	_io.store_results.clear()
	var meta: Dictionary = pending["meta"]
	var record: Dictionary = pending["record"]
	for _round: int in range(64):
		var refused: Array[Dictionary] = _applier.screen_variants(_cache)
		if refused.is_empty():
			break
		_note_variant_fallbacks(refused, FILE_STREAM, seq)
	_begin_store_fetch(meta, record, seq, resources)


## The payloads the current resolved state needs that are neither in memory nor in the cache
## directory (or every one not in memory, under ignore-cache): what live mode fetches over HTTP.
func _http_misses() -> Array[String]:
	var out: Array[String] = []
	if _fetcher == null:
		return out
	var need: Dictionary = _applier.needed()
	var mesh_hashes: Array = need["mesh_hashes"]
	var shader_hashes: Array = need["shader_hashes"]
	var ktx2_hashes: Array = need["ktx2_hashes"] if need.has("ktx2_hashes") else []
	for value: Variant in need["hashes"]:
		var hash: String = value
		if _cache.has_in_memory(hash):
			continue
		if not _cache.ignore_cache and _cache.cache_has(hash, mesh_hashes.has(hash), shader_hashes.has(hash), ktx2_hashes.has(hash)):
			continue
		out.append(hash)
	return out


## Applies `entry` once every payload it needs is available; until then its HTTP fetches run
## (_poll_fetches) and the previous state stays on screen. `resources` carries the fetch counters
## of the passes so far.
func _begin_apply(entry: Dictionary, meta: Dictionary, resources: Dictionary) -> void:
	# G8kf: transcode what is already here first; a refused variant makes the entry need `decoded`,
	# which the miss check below then fetches.
	var entry_seq: int = entry["seq"]
	for _round: int in range(64):
		var refused: Array[Dictionary] = _applier.screen_variants(_cache, true)
		if refused.is_empty():
			break
		_note_variant_fallbacks(refused, _conn_index, entry_seq)
	var misses: Array[String] = _http_misses()
	if _wire_version >= 11:
		# W11d: inline-fetch-zero, before every GET.
		for miss: String in misses:
			var refused: String = _applier.check_fetch(miss)
			if refused != "":
				_fail_with_error(entry_seq, refused)
				return
	if not misses.is_empty():
		_pending_apply = {"entry": entry, "meta": meta, "resources": resources}
		_fetcher.start(misses)
		_poll_fetches()
		return
	_finish_apply(entry, meta, resources)


## One _process step of the pending transaction's fetches: each completed GET is verified,
## decoded and cached (RsResourceCache.add_fetched) and recorded; an error fails the replay at
## that transaction; when the queue is done the transaction is applied (after one more miss check:
## a newer state accepted meanwhile may need more).
func _poll_fetches() -> void:
	var done: bool = _fetcher.poll()
	if not done:
		return
	var pending: Dictionary = _pending_apply
	_pending_apply = {}
	var entry: Dictionary = pending["entry"]
	var resources: Dictionary = pending["resources"]
	var seq: int = entry["seq"]
	for result: Dictionary in _fetcher.results:
		var hash: String = result["hash"]
		var start_us: int = result["start_us"]
		var end_us: int = result["end_us"]
		var got_bytes: int = result["bytes"]
		var error: String = result["error"]
		var fetch_entry: Dictionary = {
			"stream": _conn_index, "seq": seq, "hash": hash, "source": "http",
			"status": result["status"], "bytes": got_bytes, "start_us": start_us, "end_us": end_us,
			"verified": false, "delay_us": result["delay_us"], "headers": result["headers"],
			# G8kz: the bytes that crossed the wire (the coded body's length), the coding the
			# response named, and the time spent decoding it; `bytes` is the identity size.
			"wire_bytes": result["wire_bytes"], "content_encoding": result["content_encoding"],
			"decode_us": result["decode_us"],
		}
		if result.has("browser"):
			# G7wf (web, browser fetch only): the page clock's headers_ms/body_ms/callback_ms.
			fetch_entry["browser"] = result["browser"]
		resources["fetch_us"] = RsWire.as_int(resources["fetch_us"]) + (end_us - start_us)
		if error == "":
			# A 200 body: verified against its name first (a mismatch leaves verified false).
			var body: PackedByteArray = result["data"]
			fetch_entry["kind"] = RsResourceCache.payload_kind(body)
			if fetch_entry["kind"] == "shader":
				resources["shader_payload_fetches"] = RsWire.as_int(resources.get("shader_payload_fetches", 0)) + 1
			error = _cache.add_fetched(hash, body, "GET %s" % hash)
			fetch_entry["verified"] = not error.begins_with("resource-hash-mismatch")
		# G6s: dropped under RS_RECEIVER_LOG=summary (fetch_entry is still mutated above, just
		# never kept). P3-HX: the row log snapshots a row, so it is appended once it is final.
		if _log_mode != "summary":
			_fetches.append(fetch_entry)
		if error != "":
			_fail_with_error(seq, error)
			return
		resources["fetched"] = RsWire.as_int(resources["fetched"]) + 1
		resources["fetched_bytes"] = RsWire.as_int(resources["fetched_bytes"]) + got_bytes
		_summary["fetched_bytes"] = RsWire.as_int(_summary["fetched_bytes"]) + got_bytes
		_fetched_hashes[hash] = true
		_summary["distinct_fetched"] = _fetched_hashes.size()
	var meta: Dictionary = pending["meta"]
	if _granted_window > 1 and not _waiting.is_empty():
		# G7q: newer transactions arrived while this one fetched, and the resolved state is the
		# newest's: this one folds into it (after one more miss check, as below).
		_coalesced.append(entry)
		var newest: Dictionary = _waiting[_waiting.size() - 1]
		for index: int in range(_waiting.size() - 1):
			_coalesced.append(_waiting[index]["entry"])
		_waiting.clear()
		var newest_entry: Dictionary = newest["entry"]
		var newest_meta: Dictionary = newest["meta"]
		_end_wait_on_folded_full(newest_entry)
		_mark_coalesced(newest_entry)
		if _refuse_for_resync(newest_entry):
			_refuse_coalesced()
			return
		_begin_apply(newest_entry, newest_meta, resources)
		return
	_begin_apply(entry, meta, resources)


func _finish_apply(entry: Dictionary, meta: Dictionary, prefetched: Dictionary) -> void:
	var seq_applied: int = entry["seq"]
	var applied: Dictionary = _fetch_and_apply(_conn_index, seq_applied, prefetched)
	if not applied["ok"]:
		return
	var stats: Dictionary = applied["stats"]
	var now_us: int = Time.get_ticks_usec()
	entry["applied_us"] = now_us
	_note_applied(entry, meta, stats)
	var seq: int = entry["seq"]
	# G7q: the transactions folded into this apply first, in seq order.
	for folded: Dictionary in _coalesced:
		folded["process_frame"] = entry["process_frame"]
		folded["applied_us"] = now_us
		folded["coalesced_into"] = seq
		_send(RsLiveClient.ack(_stream_id, RsWire.as_int(folded["seq"]), "applied", now_us))
		_acks_sent["applied"] = RsWire.as_int(_acks_sent["applied"]) + 1
	if not _coalesced.is_empty():
		_log("seq %d applied with %s (credit window %d)" % [seq, str(_coalesced.map(func(f: Dictionary) -> int: return RsWire.as_int(f["seq"]))), _granted_window])
	var folded_now: Array[Dictionary] = _coalesced
	_coalesced = []
	_send(RsLiveClient.ack(_stream_id, seq, "applied", now_us))
	_acks_sent["applied"] = RsWire.as_int(_acks_sent["applied"]) + 1
	if _conn_index == 1 and not _marked_first_applied:
		_marked_first_applied = true
		_web_mark("rs-first-applied")
	var step: int = -1
	var frame: int = entry["frame"]
	for window: Dictionary in _windows:
		if not window["shot"] and frame >= RsWire.as_int(window["from"]) and frame <= RsWire.as_int(window["to"]):
			step = window["step"]
			window["shot"] = true
			break
	if step >= 0 and not _dump_state(seq):
		return
	if _credit_stage == "submitted" or step >= 0:
		_coalesced_drawn = folded_now
		_submit_pending = true
		RenderingServer.frame_post_draw.connect(_after_post_draw.bind(entry, step), CONNECT_ONE_SHOT)


## The first frame_post_draw after an apply: a due shot, then the `submitted` ack.
func _after_post_draw(entry: Dictionary, step: int) -> void:
	if _finished:
		return
	var seq: int = entry["seq"]
	if step >= 0:
		var path: String = _save_shot(seq)
		if path == "":
			return
		_shots.append({
			"stream": _conn_index,
			"seq": seq,
			"step": step,
			"path": path,
			"state_path": _state_paths.get(_seq_name(seq)),
			"process_frame": Engine.get_process_frames(),
			"applied_through": _last_applied_seq,
			# G6s (gate6-design.md Q7e): the wire frame this shot's transaction was published at,
			# so a realtime-timeline checker can find the right shot without the per-transaction
			# array RS_RECEIVER_LOG=summary drops.
			"frame": RsWire.as_int(entry["frame"]),
		})
		_log("shot step %d seq %d frame %d -> %s" % [step, seq, RsWire.as_int(entry["frame"]), path])
	if step >= 0 and step == _stall_step and _live_report["stall"] == null:
		# RS_RECEIVER_STALL: an injected receiver delay (a blocked main loop), not GPU-limited work;
		# the host sees it only as a credit that does not come back.
		var start_us: int = Time.get_ticks_usec()
		OS.delay_msec(_stall_ms)
		var end_us: int = Time.get_ticks_usec()
		_live_report["stall"] = {
			"step": step,
			"ms": _stall_ms,
			"after_seq": seq,
			"after_frame": RsWire.as_int(entry["frame"]),
			"start_us": start_us,
			"end_us": end_us,
			"injected": true,
			"mechanism": "OS.delay_msec on the receiver main thread after frame_post_draw, before the submitted ack",
		}
		_log("stall: blocked %d us after the step %d shot (seq %d), injected" % [end_us - start_us, step, seq])
	var now_us: int = Time.get_ticks_usec()
	entry["submitted_us"] = now_us
	# G7l (gate7-design.md Q9 `credit-from-paced-loop`): the main-loop iteration of this submitted
	# ack. Equal to the entry's process_frame when the transaction was applied and drawn in one
	# iteration (the web runs one per rAF callback). G7mm records it on native too, next to
	# received_process_frame, for motion-monotonic's hold-in-frames rule.
	entry["submitted_process_frame"] = Engine.get_process_frames()
	# G7q: each transaction folded into this draw gets its own submitted ack first.
	for folded: Dictionary in _coalesced_drawn:
		folded["submitted_us"] = now_us
		folded["submitted_process_frame"] = Engine.get_process_frames()
		_send(RsLiveClient.ack(_stream_id, RsWire.as_int(folded["seq"]), "submitted", now_us))
		_acks_sent["submitted"] = RsWire.as_int(_acks_sent["submitted"]) + 1
	_coalesced_drawn = []
	_send(RsLiveClient.ack(_stream_id, seq, "submitted", now_us))
	_acks_sent["submitted"] = RsWire.as_int(_acks_sent["submitted"]) + 1
	if _conn_index == 1 and not _marked_first_submitted:
		_marked_first_submitted = true
		_web_mark("rs-first-submitted")
	_submit_pending = false
	if step >= 0 and step == _reconnect_step and _live_report["reconnect"] == null:
		_live_report["reconnect"] = {
			"step": step,
			"after_seq": seq,
			"after_frame": RsWire.as_int(entry["frame"]),
			"connect_attempts": 1,
			"created_rids": null,
			"freed_by_apply": null,
			"owned_before_dispose": null,
			"freed_rids": null,
			"leftover_rids": null,
			"closed_us": null,
		}
		_reconnect_record = _live_report["reconnect"]
		_reconnect_due = true


## RS_RECEIVER_SHOT_FINAL (G6c): `final.png`, the last applied transaction's state after the end
## record, so a realtime leg's final state is shot whatever host frame its freeze landed at.
func _after_final_shot() -> void:
	if _finished:
		return
	var image: Image = get_viewport().get_texture().get_image()
	var path: String = _shot_dir.path_join("final.png")
	var made: Error = DirAccess.make_dir_recursive_absolute(_shot_dir)
	if image == null or made != OK or image.save_png(path) != OK:
		_fail(_last_seq_or_null(), "shot-failed", "the final shot could not be saved to %s" % path)
		return
	_shots.append({
		"stream": _conn_index,
		"seq": _last_applied_seq,
		"step": null,
		"final": true,
		"frame": _last_applied_frame,
		"path": path,
		"state_path": null,
		"process_frame": Engine.get_process_frames(),
		"applied_through": _last_applied_seq,
	})
	_log("final shot seq %d frame %d -> %s" % [_last_applied_seq, _last_applied_frame, path])
	_submit_pending = false


## RS_RECEIVER_RESYNC: the first transaction applied inside the resync step's window is refused
## unapplied (`skipped: "resync"`, a `resync` message instead of the applied ack), and so is every
## patch after it until a full transaction arrives. Returns true when `entry` was refused.
func _refuse_for_resync(entry: Dictionary) -> bool:
	if _resync_step < 0:
		return false
	var seq: int = entry["seq"]
	var frame: int = entry["frame"]
	if _awaiting_full:
		if entry["encoding"] == "full":
			_awaiting_full = false
			_log("resync: full transaction seq %d arrived" % seq)
			return false
	elif not _resync_done:
		var window: Dictionary = _window_of(_resync_step)
		if window["shot"] or frame < RsWire.as_int(window["from"]) or frame > RsWire.as_int(window["to"]):
			return false
		_resync_done = true
		_awaiting_full = true
		_live_report["resync"] = {"step": _resync_step, "seq": seq, "frame": frame, "reason": "injected"}
	else:
		return false
	entry["skipped"] = "resync"
	_send(RsLiveClient.resync(_stream_id, seq, "injected"))
	_log("resync: refused seq %d (frame %d) unapplied; ignoring patches until a full transaction" % [seq, frame])
	return true


## {host, port} of a ws://127.0.0.1:<port>/... or ws://[::1]:<port>/... URL ({} otherwise): the
## HTTP fetches go to the WebSocket's own host and port (render-stream-2.md "HTTP (live)").
static func _url_origin(url: String) -> Dictionary:
	var rest: String = url.trim_prefix("ws://")
	var host: String = ""
	var port_text: String = ""
	if rest.begins_with("[::1]:"):
		host = "::1"
		port_text = rest.substr(6)
	elif rest.begins_with("127.0.0.1:"):
		host = "127.0.0.1"
		port_text = rest.substr(10)
	else:
		return {}
	var slash: int = port_text.find("/")
	if slash >= 0:
		port_text = port_text.substr(0, slash)
	if not port_text.is_valid_int() or port_text.to_int() < 1 or port_text.to_int() > 65535:
		return {}
	return {"host": host, "port": port_text.to_int()}


## The last accepted seq, or null before the first transaction (a failure's `seq`).
func _last_seq_or_null() -> Variant:
	if _last_seq() > 0:
		return _last_seq()
	return null


## The seq of the last accepted transaction (0 before the first).
func _last_seq() -> int:
	return _applier.last_seq if _applier != null else 0


## G7xn: RS_RECEIVER_CORE and RS_RECEIVER_CORE_EXT. Loads the adapter. Logs and returns false (a
## usage error) when RS_RECEIVER_CORE names anything but rust (G7gd removed the GDScript core) or
## the adapter does not load.
func _parse_core_env() -> bool:
	var kind: String = RsConfig.get_env("RS_RECEIVER_CORE").strip_edges()
	if kind != "" and kind != "rust":
		_log("error: RS_RECEIVER_CORE must be rust or unset (got %s); G7gd removed the GDScript core" % JSON.stringify(kind))
		return false
	var path: String = RsConfig.get_env("RS_RECEIVER_CORE_EXT").strip_edges()
	if path == "":
		path = RsRustApplier.DEFAULT_EXTENSION
	var problem: String = RsRustApplier.load_core(path)
	if problem != "":
		_log("error: RS_RECEIVER_CORE=rust, but the adapter is unavailable: %s" % problem)
		return false
	_log("core rust (%s)" % path)
	return true


## G7o2 (D31): the deferred record digests of the transactions applied since the last call, after
## the frame's draw; timed as evidence_hash_us, outside decode_us.
func _flush_digests() -> void:
	if _digest_offsets.is_empty() and _digest_entries.is_empty():
		return
	var t0: int = Time.get_ticks_usec()
	for offset: int in _digest_offsets:
		var hex: String = _applier.record_digest(_data, offset)
		if hex != "":
			_digest_hex[offset] = hex
	_digest_offsets.clear()
	var waiting: Array[Array] = []
	for pair: Array in _digest_entries:
		var entry: Dictionary = pair[0]
		var offset: int = pair[1]
		if _digest_hex.has(offset):
			entry["record_sha256"] = _digest_hex[offset]
		else:
			waiting.append(pair)
	_digest_entries = waiting
	if _perf != null:
		_perf.evidence_hash_us.add(Time.get_ticks_usec() - t0)


## The records accepted so far in file mode, the session included: what D31's deferred digest
## covers.
func _accepted_records() -> int:
	return _next_record


## A fresh core (RsRustApplier).
func _new_applier() -> void:
	var viewport: RID = get_viewport().get_viewport_rid()
	var canvas: RID = get_viewport().find_world_2d().canvas
	_applier = RsRustApplier.new(viewport, canvas)
	_apply_delivery()
	# G7o3 (D31): payloads are verified and decoded by the core as they arrive (the cache stages
	# them), not in the frame; the verify-in-frame sabotage keeps the pre-G7o3 path.
	_cache.stager = null if _sabotage == "verify-in-frame" else _applier


## G8kp (texture-delivery-design.md D3, Q3): RS_RECEIVER_TEXTURE_ENCODINGS and
## RS_RECEIVER_GPU_FORMAT_MASK, checked against render-stream-9.md's hello grammar and names, and
## (G8ku) RS_RECEIVER_VARIANT_POLICY and RS_RECEIVER_TRANSCODE_LOG; the web export reads them too.
## Logs and returns false on a malformed value.
func _parse_delivery_env() -> bool:
	var policy: String = RsConfig.get_env("RS_RECEIVER_VARIANT_POLICY").strip_edges()
	if policy != "" and policy != "keep" and policy != "upgrade":
		_log("error: RS_RECEIVER_VARIANT_POLICY must be keep or upgrade (got %s)" % JSON.stringify(policy))
		return false
	_variant_upgrade = policy == "upgrade"
	_transcode_log = RsConfig.get_env("RS_RECEIVER_TRANSCODE_LOG").strip_edges() == "1"
	var encodings: String = RsConfig.get_env("RS_RECEIVER_TEXTURE_ENCODINGS").strip_edges()
	if encodings != "":
		var seen: Array[String] = []
		for name: String in encodings.split(","):
			if not TEXTURE_ENCODINGS.has(name) or seen.has(name):
				_log("error: RS_RECEIVER_TEXTURE_ENCODINGS must list distinct names from %s (got %s)" % [",".join(TEXTURE_ENCODINGS), JSON.stringify(encodings)])
				return false
			seen.append(name)
		_texture_encodings = encodings
	_webgl_rules = OS.has_feature("web") and _sabotage != "advertise-etc2"
	var mask: String = RsConfig.get_env("RS_RECEIVER_GPU_FORMAT_MASK").strip_edges()
	_gpu_format_mask = []
	if mask != "":
		for family: String in mask.split(","):
			if not GPU_FAMILIES.has(family):
				_log("error: RS_RECEIVER_GPU_FORMAT_MASK must list families from %s (got %s)" % [",".join(GPU_FAMILIES), JSON.stringify(mask)])
				return false
			_gpu_format_mask.append(family)
	return true


## G8kp: gpu_formats from RenderingServer.has_os_feature (Godot's feature names, Q3) minus the mask,
## handed to the core with the preference; the report states both at /9 (_accept_session). G8ku:
## the web export too (its WebGL2 context's features through the same engine call).
func _apply_delivery() -> void:
	var web: bool = OS.has_feature("web")
	# (Not a ternary: an untyped `[]` branch cannot be assigned to Array[String].)
	var extensions: Array[String] = []
	if web:
		extensions = _webgl_compressed_extensions()
	var engine: Array[String] = []
	var detected: Array[String] = []
	var effective: Array[String] = []
	for family: String in GPU_FAMILIES:
		if not RenderingServer.has_os_feature(family):
			continue
		engine.append(family)
		# G8kwh: on the web the context must list the family's extension too.
		var ext_name: String = WEBGL_EXTENSIONS[family]
		if web and not extensions.has(ext_name) and not (family == "etc2" and _sabotage == "advertise-etc2"):
			continue
		detected.append(family)
		if not _gpu_format_mask.has(family):
			effective.append(family)
	_gpu_formats_engine = ",".join(engine) if not engine.is_empty() else "none"
	_webgl_extensions = ",".join(extensions)
	_gpu_formats_detected = ",".join(detected) if not detected.is_empty() else "none"
	_gpu_formats = ",".join(effective) if not effective.is_empty() else "none"
	var refused: String = _applier.set_delivery(_texture_encodings, _gpu_formats)
	if refused != "":
		_log("warning: the core refused the delivery preference (%s); every texture stays decoded" % refused)
	# G8kwh: WebGL's upload rules (the stated families bound the KTX2 loader's target; BC level 0
	# must be 4-aligned). The advertise-etc2 sabotage drops them too: the pre-G8kwh web export.
	if _webgl_rules:
		_applier.set_webgl_rules(true)
	_applier.set_variant_upgrade(_variant_upgrade)
	_applier.set_transcode_log(_transcode_log)


## G8kwh: the compressed-texture extensions (WEBGL_EXTENSIONS' values) the page's WebGL 2 context
## supports, read through JavaScriptBridge from the engine's own canvas (getContext returns the
## context the engine made; emscripten enables every supported compressed-texture extension by
## default, and Godot's config reads the same list). Empty when it cannot be read: no family is
## then stated, and every texture is `decoded`.
func _webgl_compressed_extensions() -> Array[String]:
	var out: Array[String] = []
	var got: Variant = JavaScriptBridge.eval("(function () { var c = document.getElementById('canvas') || document.querySelector('canvas'); var gl = c ? c.getContext('webgl2') : null; var e = gl ? gl.getSupportedExtensions() : null; return e ? e.join(',') : ''; })()", true)
	if not got is String:
		_log("warning: the WebGL extension list could not be read; stating no gpu_formats")
		return out
	var text: String = got
	for name: String in text.split(",", false):
		if WEBGL_EXTENSIONS.values().has(name):
			out.append(name)
	out.sort()
	return out


## A stream's first record (a session), at the stream's wire version (G7xwl: /6, or /7).
func _accept_session(data: PackedByteArray, offset: int) -> Dictionary:
	if _wire_version >= 10:
		for key: String in BACKBUFFER_COUNTERS:
			if not _summary.has(key):
				_summary[key] = 0
	if _wire_version >= 9:
		var receiver_block: Dictionary = _report["receiver"]
		receiver_block["texture_delivery"] = {
			"texture_encodings": _texture_encodings,
			"gpu_formats": _gpu_formats,
			"gpu_formats_detected": _gpu_formats_detected,
			"gpu_format_mask": ",".join(_gpu_format_mask),
			"variant_policy": "upgrade" if _variant_upgrade else "keep",
		}
		# G8kwh: the web export also states where its families came from and WebGL's BC rule.
		if OS.has_feature("web"):
			var block: Dictionary = receiver_block["texture_delivery"]
			block["gpu_formats_engine"] = _gpu_formats_engine
			block["webgl_extensions"] = _webgl_extensions
			block["bc_aligned_only"] = _webgl_rules
	return _applier.accept_session(data, offset, _wire_version)


## Any later record.
func _accept_record(data: PackedByteArray, offset: int) -> Dictionary:
	var accepted: Dictionary = _applier.accept(data, offset)
	_take_released()
	return accepted


func _send(message: Dictionary) -> void:
	var sent: Error = _client.send(message)
	if sent != OK:
		_log("warning: could not send %s (%s)" % [RsLiveClient.encode(message), error_string(sent)])


func _finish_live() -> void:
	var missed: Array[int] = []
	for window: Dictionary in _windows:
		if not window["shot"]:
			missed.append(window["step"])
	_report["shots_missed"] = missed
	_report["status"] = "ok"
	_write_report()
	_log("ok: %d transactions received, %d shots, %d missed windows, acks %s, %d RS calls, closed by %s (%s)" % [_transactions.size(), _shots.size(), missed.size(), JSON.stringify(_acks_sent), _applier.rs_calls, str(_stream_report["closed_by"]), str(_stream_report["close_code"])])
	_quit(EXIT_OK)


# --------------------------------------------------------------------------- shared exit paths


func _fail_with_error(seq: Variant, error: String) -> void:
	var colon: int = error.find(": ")
	if colon < 0:
		_fail(seq, error, "")
	else:
		_fail(seq, error.substr(0, colon), error.substr(colon + 2))


func _fail(seq: Variant, reason: String, detail: String) -> void:
	_report["status"] = "replay-failure"
	_report["failure"] = {"seq": seq, "reason": reason, "detail": detail}
	if _live and _client != null and _client.state() == WebSocketPeer.STATE_OPEN:
		_client.close(1000, "replay-failure")
		_stream_report["closed_by"] = "receiver"
		_stream_report["close_code"] = 1000
	_write_report()
	_log("replay-failure: seq %s %s: %s" % [str(seq), reason, detail])
	_quit(EXIT_REPLAY_FAILURE)


func _write_report() -> void:
	_flush_digests()
	if _cache_report != null and _cache.dir != "":
		var cache_report: Dictionary = _cache_report
		cache_report["entries_after"] = _cache.entries()
		cache_report["bytes_after"] = _cache.bytes()
	# G6s: unconditional (memory eviction needs no cache dir at all).
	_summary["evictions_memory"] = _cache.evictions_memory
	_summary["evictions_disk"] = _cache.evictions_disk
	_summary["refetch_after_evict"] = _cache.refetch_after_evict
	if _lazy_store:
		# WX: the lazy store's own line (applied.json is unchanged by it).
		_log("web store: lazy, %d GETs (%d bytes), %d payloads dropped after upload (%d bytes), %d fetched again after a drop (%d bytes), %d still in memory (%d bytes)" % [_io.store_gets, _io.store_bytes, _cache.dropped, _cache.dropped_bytes, _store_rereads, _store_reread_bytes, _cache.memory_entries(), _cache.memory_bytes()])
	if _wire_version >= 11:
		# W11d: the /11 store evidence (bounded), and each connection's coding stats.
		_report["w11"] = _w11
		if _live and _coding_on and _applier != null:
			var connections: Array[Dictionary] = _coding_reports.duplicate()
			connections.append(_applier.coding_stats())
			_live_report["coding"] = {"offer": _live_coding, "connections": connections, "resyncs": _coding_resyncs}
	if _applier != null:
		var floats: Array[float] = []
		for value: float in _applier.root_canvas_xform():
			floats.append(value)
		_viewport_report["canvas_transform"] = floats
	if _live:
		if _received_file != null:
			_received_file.flush()
		# G6s (live-buffer trim): `_data` only ever holds the message in flight; `_received_path`
		# is its exact byte-for-byte mirror, so the whole connection's sha256 is read back from
		# disk once here instead of carried in memory (rs-g6s-live-data-unbounded-growth.md).
		var sha256: String = RsWire.sha256_hex(FileAccess.get_file_as_bytes(_received_path))
		_stream_report["received_sha256"] = sha256
		_stream_report["received_bytes"] = _data_received_bytes
		_report["recording"] = {"path": _received_path, "sha256": sha256, "bytes": _data_received_bytes}
	DirAccess.make_dir_recursive_absolute(_out_path.get_base_dir())
	var file: FileAccess = FileAccess.open(_out_path, FileAccess.WRITE)
	if file == null:
		_log("error: cannot write %s: %s" % [_out_path, error_string(FileAccess.get_open_error())])
		return
	RsRowLog.write_report_json(file, _report)
	file.close()
	_write_perf_report()


## RS_RECEIVER_PERF_OUT (G6r): render-stream-receiver-perf/1, written alongside applied.json on
## every exit path (_fail, _finish, _finish_live all call _write_report()).
func _write_perf_report() -> void:
	if _perf == null:
		return
	var headless: bool = DisplayServer.get_name() == "headless"
	var viewport_rid: RID = get_viewport().get_viewport_rid() if is_inside_tree() else RID()
	# Acks (received/applied/submitted) are a live-transport concept; file mode has none, so
	# `counts` stays null there rather than a misleading all-zero (D9: declared, not guessed).
	_perf.payloads = _payload_counters(true)
	var doc: Dictionary = _perf.to_dict(viewport_rid, headless, _acks_sent if _live else null)
	DirAccess.make_dir_recursive_absolute(_perf_out_path.get_base_dir())
	var file: FileAccess = FileAccess.open(_perf_out_path, FileAccess.WRITE)
	if file == null:
		_log("error: cannot write %s: %s" % [_perf_out_path, error_string(FileAccess.get_open_error())])
		return
	file.store_string(JSON.stringify(doc, "  ", false) + "\n")
	file.close()


func _quit(code: int) -> void:
	_finished = true
	set_process(false)
	if _received_file != null:
		_received_file.close()
		_received_file = null
	if _client != null:
		_client.close(1000, "receiver exit")
	# G7e: natively the applier is disposed and the process quits at once, as before; on the web
	# RsIo uploads the evidence first (over several frames, the last applied state still drawn),
	# then disposes and quits.
	_io.finish(get_tree(), _out_path, code, _dispose_applier)


func _dispose_applier() -> void:
	if _applier != null:
		_note_payload_counters()
		var freed: int = _applier.dispose()
		_log("disposed: %d RIDs freed" % freed)
	_cache.stager = null


## G7o3: the Rust core's payload counters (staged on arrival, refused, unstaged by an eviction,
## and at apply provided from the stage or verified in the frame) for perf.json's `payloads`:
## those of the cores this run disposed already, plus the live one's (`include_live`).
func _payload_counters(include_live: bool) -> Dictionary:
	var out: Dictionary = _payload_totals.duplicate()
	if include_live and _applier != null:
		var counters: Dictionary = _applier.payload_counters()
		for key: String in counters:
			out[key] = RsWire.as_int(out.get(key, 0)) + RsWire.as_int(counters[key])
	return out


func _note_payload_counters() -> void:
	_payload_totals = _payload_counters(true)


## G7e: whether payloads have somewhere to come from besides inline records -- a cache directory
## natively, the browser's HTTP cache (`http-cache`) on the web.
func _has_cache() -> bool:
	return _cache.dir != "" or _cache.mode == "http-cache"


## G7e: on the web, checks that every sink lies under RS_RECEIVER_OUT's directory and fetches the
## configured sources into memory (RsIo.prepare_sources); natively returns true at once. Returns
## false after failing the replay (a source that cannot be fetched) or quitting with a usage error.
func _prepare_sources() -> bool:
	if not RsConfig.is_web():
		return true
	var sinks: Array[String] = [_perf_out_path, _received_path]
	var sink_error: String = _io.check_sink_paths(_out_path, sinks)
	if sink_error != "":
		_log("error: " + sink_error)
		_quit(EXIT_USAGE)
		return false
	_log("web: --rs-env %s" % JSON.stringify(RsConfig.arg_names()))
	var error: String = await _io.prepare_sources(get_tree())
	if error != "":
		_fail_with_error(null, error)
		return false
	_log("web: %d sources staged in memory (%d bytes, %d ms)%s" % [_io.source_files, _io.source_bytes, _io.source_ms, "; store lazy" if _lazy_store else ""])
	return true


## An RS_RECEIVER_* value, or null when unset.
static func _env_or_null(variable: String) -> Variant:
	var value: String = RsConfig.get_env(variable).strip_edges()
	return null if value == "" else value


func _log(text: String) -> void:
	print("[receiver] " + text)
