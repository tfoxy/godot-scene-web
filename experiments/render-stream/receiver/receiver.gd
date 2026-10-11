extends Node
## render-stream/5 receiver (gate0-design.md "Q5. Receiver", extended by gate1-design.md "Q5.
## Receiver", "G1b2" and "G1c2", by gate2-design.md "Q5. Receiver" and "G2b2", since G4e2 by
## gate4-design.md "Q5. Receiver" -- /3 is /2 plus the msdf command -- and since G5d by
## gate5-design.md "Q5. Receiver": /4 adds the immediate geometry ops, add_set_transform and
## add_clip_ignore, replayed in order; since G5e the mesh table: every `ok` mesh a command names
## is made resident from its GRM1 surface payloads and add_mesh replays; since G55d by
## gate5_5-design.md "Q5. Receiver": /5's shader and material tables are compiled and created
## natively from their GRP1 code, items get their material, use_parent_material and instance
## parameters, canvas 1 its modulate -- RsApplier's "Shaders and materials"). Its only input is a
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
##   RS_RECEIVER_FETCH_TIMEOUT_MS live: a GET not complete this many ms after it was issued is
##                                resource-unavailable (default 10000)
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
##                                update); all sixteen exist only to fail checks or compare
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
##                          `transactions` array (shots and failures stay), for soak and perf legs.
## Before a transaction is applied, every `ok` image a command of its resolved state names that is
## not resident (or resident with another hash), and (G5e) every surface payload of an `ok` mesh
## an add_mesh names that is not resident with that hash, and (G55d) the GRP1 code of every `ok`
## `payload` shader a named material names that is not on its RID (plus the textures of those
## materials' parameters and default textures), is made available: from memory (inline resource
## records and earlier fetches), from the cache (a cache hit), or fetched from the store and
## written to the cache. Each is verified against its SHA-256 name and decoded first
## (resource-hash-mismatch, resource-unavailable, resource-invalid otherwise). In live mode with
## `fetch: "http"` (G2c2) a miss is fetched with RsResourceFetcher, `GET <http_path><hash>` on the
## RS_RECEIVER_URL host and port, one keep-alive HTTPClient, sequentially, polled from _process:
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
##   RS_RECEIVER_RECEIVED_OUT    absolute path of the received bytes (default <dirname>/received.rs2)
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
##   RS_RECEIVER_RESYNC          <step> (G1d): refuse the first transaction in that step's window
##                               unapplied, send `resync` for it, and ignore patches until a full
##                               transaction arrives
##   RS_RECEIVER_TOKEN_FILE      G2e (gate2-design.md D13): absolute path to a file holding the
##                               bearer token, sent as "Authorization: Bearer <token>" on the
##                               WebSocket upgrade and on every resource GET. Unset: no token sent
##                               (the session must then declare resources.auth "none" or the host
##                               refuses the upgrade with 401 -> replay-failure live-connect-failed)
## The three G1d options need a shot window for their step.
## On open it sends `hello`. Each binary message is appended to the received file, framed (the
## first is the magic and the session, every later one exactly one record), decoded and accepted
## (Rs2Decoder.Stream resolves patches) and acked `received` (a resource record is kept, not acked). The newest accepted transaction is
## applied at most once per _process and acked `applied`; at the next frame_post_draw a due shot is
## taken and the `submitted` ack sent. `presented` is unavailable in Godot and never guessed. The
## end record finishes the run; a close without it is replay-failure live-disconnected, a host
## `error` message replay-failure host-error.
##
## Every record is decoded and validated completely (Rs2Decoder.decode_record, then
## Rs2Decoder.Stream.accept, which resolves patches) before RsApplier makes any RenderingServer
## call for it; the applier then reconciles the RESOLVED state with its own mirror. A failure
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

const SCHEMA: String = "render-stream-receiver-applied/6"
const EXIT_OK: int = 0
const EXIT_USAGE: int = 2
const EXIT_REPLAY_FAILURE: int = 3
## RS_RECEIVER_SABOTAGE's accepted values (gate2-design.md Q5, gate3-design.md Q5, G3b,
## gate4-design.md Q5, G4e2, gate5-design.md Q5, G5d, G5g, G5e, gate5_5-design.md Q5, G55d,
## gate6-design.md Q6h, G6a).
const SABOTAGES: Array[String] = ["reupload", "ignore-cache", "wrong-http-token", "ignore-clip", "clip-before-clear", "drop-msdf", "ignore-set-transform", "ignore-clip-ignore", "ignore-nine-patch-axis", "drop-mesh-surface", "stale-mesh", "refuse-canvas-texture", "ignore-material", "ignore-canvas-modulate", "stale-param", "stale-texture", "ignore-canvas-stacking", "ignore-presentation"]
## The six per-transaction `resources` counters render-stream-receiver-applied/5 adds (G55d).
const MATERIAL_COUNTERS: Array[String] = ["shaders_created", "shader_code_sets", "shader_payload_fetches", "materials_created", "param_sets", "instance_param_sets"]
## The three per-transaction `resources` counters render-stream-receiver-applied/6 adds (G6b).
const CANVAS_COUNTERS: Array[String] = ["canvases_created", "canvas_attach", "canvas_stacking_sets"]
## File mode carries exactly one stream; transactions and shots name it as stream 1. Live mode
## numbers its connections from 1 (a second one after an RS_RECEIVER_RECONNECT).
const FILE_STREAM: int = 1
const DEFAULT_INBOUND_BYTES: int = 16777216
const DEFAULT_CONNECT_TIMEOUT_MS: int = 10000
## How long the receiver waits for the host's close after the end record before closing itself.
const CLOSE_WAIT_MS: int = 2000

var _data := PackedByteArray()
var _records: Array[Dictionary] = []
var _next_record: int = 0
var _stream := Rs2Decoder.Stream.new()
var _applier: RsApplier
var _recording_path: String = ""
var _out_path: String = ""
var _shot_dir: String = ""
var _state_dir: String = ""
var _shot_seqs: Array[int] = []
var _state_seqs: Array[int] = []
var _state_paths: Dictionary[String, String] = {}
var _busy: bool = false
var _finished: bool = false
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
var _fetches: Array[Dictionary] = []
var _uploads: Array[Dictionary] = []
var _mesh_uploads: Array[Dictionary] = []
var _fetched_hashes: Dictionary[String, bool] = {}
var _summary: Dictionary = {
	"distinct_fetched": 0, "fetched_bytes": 0, "cache_hits": 0, "uploads": 0, "upload_bytes": 0,
	"meshes_created": 0, "meshes_rebuilt": 0, "surface_updates": 0, "mesh_upload_bytes": 0,
	"shaders_created": 0, "shader_code_sets": 0, "shader_payload_fetches": 0, "materials_created": 0,
	"param_sets": 0, "instance_param_sets": 0,
	"canvases_created": 0, "canvas_attach": 0, "canvas_stacking_sets": 0,
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
# Live HTTP fetches (G2c2).
var _fetch_kind: String = ""
var _fetcher: RsResourceFetcher = null
## The transaction waiting for its fetches: {entry, meta, resources (its fetch counters so far)}.
var _pending_apply: Dictionary = {}
var _delivery: String = ""
var _sabotage: String = ""

# Live mode.
var _live: bool = false
var _client: RsLiveClient = null
var _live_report: Dictionary = {}
var _live_phase: String = ""  # connecting | streaming | draining
var _deadline_msec: int = 0
var _url: String = ""
var _credit_stage: String = "submitted"
var _inbound_bytes: int = DEFAULT_INBOUND_BYTES
var _received_path: String = ""
var _received_file: FileAccess = null
var _session_seen: bool = false
var _stream_id: String = ""
var _windows: Array[Dictionary] = []  # {step, from, to, shot: bool}
var _waiting: Array[Dictionary] = []  # accepted, not yet applied: {entry, meta}
var _submit_pending: bool = false
var _end_seen: bool = false
var _acks_sent: Dictionary = {"received": 0, "applied": 0, "submitted": 0}
var _closing_by_receiver: bool = false
var _received_base: String = ""  # stream 1's received path; stream n inserts "-<n>"
var _connect_timeout_ms: int = DEFAULT_CONNECT_TIMEOUT_MS
## G2e: the bearer token read from RS_RECEIVER_TOKEN_FILE, or "" when unset (no auth).
var _token: String = ""
## The live connection being read: 1, then 2 after a reconnect. Transactions, shots and state
## dumps name it as their stream.
var _conn_index: int = 1
# G1d options (-1: off).
var _stall_step: int = -1
var _stall_ms: int = 0
var _reconnect_step: int = -1
var _reconnect_due: bool = false
var _reconnecting: bool = false
## RS_RECEIVER_RECONNECT_MEMORY (G6l): "drop" (G2c2's rule) or "keep".
var _reconnect_memory: String = "drop"
var _resync_step: int = -1
var _resync_done: bool = false
var _awaiting_full: bool = false


func _ready() -> void:
	set_process(false)
	var mode: String = OS.get_environment("RS_RECEIVER_MODE").strip_edges()
	if mode == "live":
		_ready_live()
		return
	if mode != "" and mode != "file":
		_log("error: RS_RECEIVER_MODE must be file or live (got %s)" % JSON.stringify(mode))
		_quit(EXIT_USAGE)
		return
	_recording_path = OS.get_environment("RS_RECEIVER_RECORDING")
	_out_path = OS.get_environment("RS_RECEIVER_OUT")
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
	if not _parse_perf_env():
		_quit(EXIT_USAGE)
		return

	var display_server: String = _init_report("file")
	if not _open_cache():
		return
	_log("mode file, recording %s, out %s, shot seqs %s, state seqs %s, display %s" % [_recording_path, _out_path, str(_shot_seqs), str(_state_seqs), display_server])

	if _recording_path == "" or not _recording_path.is_absolute_path() or not FileAccess.file_exists(_recording_path):
		_fail(null, "recording-unreadable", "RS_RECEIVER_RECORDING is not an absolute path to an existing file: %s" % JSON.stringify(_recording_path))
		return
	_data = FileAccess.get_file_as_bytes(_recording_path)
	if _data.is_empty() and FileAccess.get_open_error() != OK:
		_fail(null, "recording-unreadable", "cannot read %s: %s" % [_recording_path, error_string(FileAccess.get_open_error())])
		return
	var sha256: String = Rs2Decoder.sha256_hex(_data)
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
	var split: Dictionary = Rs2Decoder.split_records(_data)
	var split_errors: PackedStringArray = split["errors"]
	if split_errors.size() > 0:
		_fail_with_error(null, split_errors[0])
		return
	_records = split["records"]
	if _records.is_empty():
		_fail_with_error(null, Rs2Decoder.err("missing-session", "the recording has no records"))
		return

	_applier = RsApplier.new(get_viewport().get_viewport_rid(), get_viewport().find_world_2d().canvas)
	if _perf != null:
		_perf.enable_render_time_measurement(get_viewport().get_viewport_rid())
	var raw: Dictionary = _records[_next_record]
	_next_record += 1
	if not _begin_session(RsApplier.accept_record(_data, Rs2Decoder.as_int(raw["offset"]), _stream)):
		return
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
		# G2b2 (render-stream-receiver-applied/3, gate2-design.md Q5 "applied.json").
		"cache": null,
		"fetches": _fetches,
		"uploads": _uploads,
		# G5e (render-stream-receiver-applied/4).
		"mesh_uploads": _mesh_uploads,
		"resources_summary": _summary,
	}
	return display_server


## RS_RECEIVER_CACHE_DIR / _CACHE_MODE / _STORE_DIR / _FETCH_TIMEOUT_MS / _FETCH_DELAY_MS /
## _SABOTAGE. Logs and returns false when one is malformed (a usage error). The store directory
## is a file-mode variable.
func _parse_resource_env(live: bool) -> bool:
	var cache_dir: String = OS.get_environment("RS_RECEIVER_CACHE_DIR").strip_edges()
	if cache_dir != "" and not cache_dir.is_absolute_path():
		_log("error: RS_RECEIVER_CACHE_DIR must be absolute (got %s)" % JSON.stringify(cache_dir))
		return false
	var cache_mode: String = OS.get_environment("RS_RECEIVER_CACHE_MODE").strip_edges()
	if cache_mode == "":
		cache_mode = "fresh"
	if cache_mode != "fresh" and cache_mode != "warm":
		_log("error: RS_RECEIVER_CACHE_MODE must be fresh or warm (got %s)" % JSON.stringify(cache_mode))
		return false
	var store_dir: String = OS.get_environment("RS_RECEIVER_STORE_DIR").strip_edges()
	if store_dir != "" and (live or not store_dir.is_absolute_path()):
		_log("error: RS_RECEIVER_STORE_DIR must be an absolute directory, and is file-mode only (got %s)" % JSON.stringify(store_dir))
		return false
	_fetch_timeout_ms = _positive_env("RS_RECEIVER_FETCH_TIMEOUT_MS", 10000)
	if _fetch_timeout_ms < 0:
		return false
	var delay_text: String = OS.get_environment("RS_RECEIVER_FETCH_DELAY_MS").strip_edges()
	if delay_text != "":
		if not delay_text.is_valid_int() or delay_text.to_int() < 0:
			_log("error: RS_RECEIVER_FETCH_DELAY_MS must be an integer >= 0 (got %s)" % JSON.stringify(delay_text))
			return false
		_fetch_delay_ms = delay_text.to_int()
	var sabotage: String = OS.get_environment("RS_RECEIVER_SABOTAGE").strip_edges()
	if sabotage != "" and not SABOTAGES.has(sabotage):
		_log("error: RS_RECEIVER_SABOTAGE must be one of %s (got %s)" % [str(SABOTAGES), JSON.stringify(sabotage)])
		return false
	var library_dir: String = OS.get_environment("RS_RECEIVER_SHADER_LIBRARY").strip_edges()
	if library_dir != "" and not library_dir.is_absolute_path():
		_log("error: RS_RECEIVER_SHADER_LIBRARY must be an absolute directory (got %s)" % JSON.stringify(library_dir))
		return false
	_cache.dir = cache_dir
	_cache.mode = cache_mode
	_cache.store_dir = store_dir
	_cache.library_dir = library_dir
	_cache.ignore_cache = sabotage == "ignore-cache"
	_sabotage = sabotage
	return true


## RS_RECEIVER_PERF_OUT / RS_RECEIVER_LOG (G6r, Q5 "Perf"). Logs and returns false when malformed.
func _parse_perf_env() -> bool:
	_perf_out_path = OS.get_environment("RS_RECEIVER_PERF_OUT").strip_edges()
	if _perf_out_path != "" and not _perf_out_path.is_absolute_path():
		_log("error: RS_RECEIVER_PERF_OUT must be an absolute path (got %s)" % JSON.stringify(_perf_out_path))
		return false
	_log_mode = OS.get_environment("RS_RECEIVER_LOG").strip_edges()
	if _log_mode == "":
		_log_mode = "full"
	if _log_mode != "full" and _log_mode != "summary":
		_log("error: RS_RECEIVER_LOG must be full or summary (got %s)" % JSON.stringify(_log_mode))
		return false
	if _perf_out_path != "":
		_perf = RsPerf.new()
	return true


## Opens the cache (after the report exists, so a cache-not-fresh failure is reported).
func _open_cache() -> bool:
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


## A resource record (render-stream-2.md "Resource record"), already verified by Stream.accept:
## its payload goes to memory. Returns false after failing the replay.
func _receive_resource(record: Dictionary, data: PackedByteArray) -> bool:
	var meta: Dictionary = record["meta"]
	var hash: String = meta["hash"]
	var error: String = _cache.add_inline(hash, Rs2Decoder.raw_resource_payload(data, record))
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
	var need: Dictionary = _applier.needed(_stream.items, _stream.textures, _stream.meshes, _stream.shaders, _stream.materials)
	var hashes: Array = need["hashes"]
	var mesh_hashes: Array = need["mesh_hashes"]
	var shader_hashes: Array = need["shader_hashes"]
	var fetch_us: int = Rs2Decoder.as_int(resources["fetch_us"])
	for value: Variant in hashes:
		var hash: String = value
		if _cache.has_in_memory(hash):
			continue
		if _cache.dir == "" and _delivery != "inline":
			return Rs2Decoder.err("resource-unavailable", "payload %s is needed, and RS_RECEIVER_CACHE_DIR is unset (delivery %s)" % [hash, _delivery])
		var mesh: bool = mesh_hashes.has(hash)
		var shader: bool = shader_hashes.has(hash)
		var will_fetch: bool = _cache.ignore_cache or not _cache.cache_has(hash, mesh, shader)
		if will_fetch and _fetch_delay_ms > 0:
			OS.delay_msec(_fetch_delay_ms)
		var got: Dictionary = _cache.obtain(hash, mesh, shader)
		var source: String = got["source"]
		var got_bytes: int = got["bytes"]
		if source == "cache":
			resources["cache_hits"] = Rs2Decoder.as_int(resources["cache_hits"]) + 1
			_summary["cache_hits"] = Rs2Decoder.as_int(_summary["cache_hits"]) + 1
		elif source == "directory":
			var start_us: int = got["start_us"]
			var end_us: int = got["end_us"]
			fetch_us += end_us - start_us
			_fetches.append({
				"stream": stream_index, "seq": seq, "hash": hash, "source": "directory",
				"status": null, "bytes": got_bytes, "start_us": start_us, "end_us": end_us,
				"verified": got["verified"], "kind": "mesh" if mesh else ("shader" if shader else "texture"),
			})
			resources["fetched"] = Rs2Decoder.as_int(resources["fetched"]) + 1
			if shader:
				resources["shader_payload_fetches"] = Rs2Decoder.as_int(resources["shader_payload_fetches"]) + 1
			resources["fetched_bytes"] = Rs2Decoder.as_int(resources["fetched_bytes"]) + got_bytes
			_summary["fetched_bytes"] = Rs2Decoder.as_int(_summary["fetched_bytes"]) + got_bytes
			_fetched_hashes[hash] = true
			_summary["distinct_fetched"] = _fetched_hashes.size()
		var error: String = got["error"]
		if error != "":
			resources["fetch_us"] = fetch_us
			return error
	resources["fetch_us"] = fetch_us
	return ""


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
	if _perf != null:
		# The whole fetch stage for this transaction, including HTTP fetches live mode may have
		# run across several earlier _process calls (resources["fetch_us"] already carries those
		# through `prefetched`, not re-timed here).
		_perf.fetch_us.add(Rs2Decoder.as_int(resources["fetch_us"]))
	var apply_t0: int = Time.get_ticks_usec() if _perf != null else 0
	var stats: Dictionary = _applier.apply_state(_stream, _cache)
	if _perf != null:
		_perf.apply_us.add(Time.get_ticks_usec() - apply_t0)
	var applied: Dictionary = stats["resources"]
	for key: String in ["created", "updated", "replaced", "freed", "upload_bytes", "skipped_commands"]:
		resources[key] = applied[key]
	var mesh_resources: Dictionary = stats["mesh_resources"]
	for key: String in ["meshes_created", "meshes_rebuilt", "surface_updates", "mesh_upload_bytes", "skipped_mesh_commands"]:
		resources[key] = mesh_resources[key]
		if _summary.has(key):
			_summary[key] = Rs2Decoder.as_int(_summary[key]) + Rs2Decoder.as_int(mesh_resources[key])
	var material_resources: Dictionary = stats["material_resources"]
	for key: String in MATERIAL_COUNTERS:
		if material_resources.has(key):
			resources[key] = material_resources[key]
		_summary[key] = Rs2Decoder.as_int(_summary[key]) + Rs2Decoder.as_int(resources[key])
	var canvas_resources: Dictionary = stats["canvas_resources"]
	for key: String in CANVAS_COUNTERS:
		resources[key] = canvas_resources[key]
		_summary[key] = Rs2Decoder.as_int(_summary[key]) + Rs2Decoder.as_int(resources[key])
	var skipped_shaders: Array = stats["skipped_shaders"]
	for value: Variant in skipped_shaders:
		var skip: Dictionary = value
		var shader_id: int = Rs2Decoder.as_int(skip["id"])
		var skip_hash: String = skip["hash"]
		var reported_key: String = "%d:%d:%s" % [stream_index, shader_id, skip_hash]
		if _withheld_reported.has(reported_key):
			continue
		_withheld_reported[reported_key] = true
		_unsupported.append({"seq": seq, "item": null, "name": "shader_set_code", "reason": skip["reason"], "shader": shader_id})
		_log("seq %d: shader %d (%s) skipped: %s (%s)" % [seq, shader_id, skip_hash, skip["reason"], skip["detail"]])
	stats["resources"] = resources
	var mesh_uploads: Array = stats["mesh_uploads"]
	for value: Variant in mesh_uploads:
		var mesh_upload: Dictionary = value
		mesh_upload["stream"] = stream_index
		mesh_upload["seq"] = seq
		_mesh_uploads.append(mesh_upload)
	var uploads: Array = stats["uploads"]
	for value: Variant in uploads:
		var upload: Dictionary = value
		upload["stream"] = stream_index
		upload["seq"] = seq
		_uploads.append(upload)
		if upload["op"] != "placeholder":
			_summary["uploads"] = Rs2Decoder.as_int(_summary["uploads"]) + 1
			_summary["upload_bytes"] = Rs2Decoder.as_int(_summary["upload_bytes"]) + Rs2Decoder.as_int(upload["data_bytes"])
	return {"ok": true, "stats": stats}


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
		_fail_with_error(null, Rs2Decoder.err("missing-session", "the first record is a %s, not a session" % accepted["kind"]))
		return false
	_report["session_id"] = meta["session_id"]
	var stream_meta: Dictionary = meta["stream"]
	_stream_id = stream_meta["stream_id"]
	_stream_report["stream_id"] = stream_meta["stream_id"]
	_stream_report["connection"] = stream_meta["connection"]
	var session_viewport: Dictionary = meta["viewport"]
	var logical: Array = session_viewport["logical_size"]
	var logical_size := Vector2(Rs2Decoder.as_int(logical[0]), Rs2Decoder.as_int(logical[1]))
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
	if _delivery != "inline" and _cache.dir == "":
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
		_fetcher = RsResourceFetcher.new(origin_host, origin_port, str(http_path), _fetch_timeout_ms, _fetch_delay_ms, fetch_token)
	var blocks: Array = record["blocks"]
	_applier.sabotage_reupload = _sabotage == "reupload"
	_applier.sabotage_ignore_clip = _sabotage == "ignore-clip"
	_applier.sabotage_clip_before_clear = _sabotage == "clip-before-clear"
	_applier.sabotage_drop_msdf = _sabotage == "drop-msdf"
	_applier.sabotage_ignore_set_transform = _sabotage == "ignore-set-transform"
	_applier.sabotage_ignore_clip_ignore = _sabotage == "ignore-clip-ignore"
	_applier.sabotage_ignore_nine_patch_axis = _sabotage == "ignore-nine-patch-axis"
	_applier.sabotage_drop_mesh_surface = _sabotage == "drop-mesh-surface"
	_applier.sabotage_stale_mesh = _sabotage == "stale-mesh"
	_applier.sabotage_refuse_canvas_texture = _sabotage == "refuse-canvas-texture"
	_applier.sabotage_ignore_material = _sabotage == "ignore-material"
	_applier.sabotage_ignore_canvas_modulate = _sabotage == "ignore-canvas-modulate"
	_applier.sabotage_stale_param = _sabotage == "stale-param"
	_applier.sabotage_stale_texture = _sabotage == "stale-texture"
	_applier.sabotage_ignore_canvas_stacking = _sabotage == "ignore-canvas-stacking"
	_applier.begin_session(meta, blocks)
	_log("session %s stream %s (%s, %s) applied (%d RS calls)" % [meta["session_id"], stream_meta["stream_id"], stream_meta["transport"], stream_meta["encoding"], _applier.rs_calls])
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
		root.content_scale_size = Vector2i(Rs2Decoder.as_int(logical[0]), Rs2Decoder.as_int(logical[1]))
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
	var presentation_size := Vector2i(Rs2Decoder.as_int(presentation[0]), Rs2Decoder.as_int(presentation[1]))
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
		_perf.sample_timeline(_cache.entries(), _cache.bytes())
	if _live:
		_process_live()
		return
	if _busy or _finished:
		return
	if _next_record >= _records.size():
		_fail(null, "recording-incomplete", "the recording ends after %d records without an end record" % _records.size())
		return
	var expected_seq: int = _stream.last_seq + 1
	var raw: Dictionary = _records[_next_record]
	_next_record += 1
	# The only place transaction RS calls happen: _fetch_and_apply touches the RenderingServer
	# only after the record decoded, the stream accepted (and resolved) it and every payload it
	# needs is available.
	var decode_t0: int = Time.get_ticks_usec() if _perf != null else 0
	var result: Dictionary = RsApplier.accept_record(_data, Rs2Decoder.as_int(raw["offset"]), _stream)
	if _perf != null:
		_perf.decode_us.add(Time.get_ticks_usec() - decode_t0)
	var errors: PackedStringArray = result["errors"]
	var record: Dictionary = result["record"]
	var meta: Dictionary = record["meta"]
	var kind: String = result["kind"]
	if errors.size() > 0:
		var seq: Variant = null
		if kind == "transaction" or kind == "":
			seq = Rs2Decoder.as_int(meta["seq"]) if Rs2Decoder.is_int(meta.get("seq")) else expected_seq
		_fail_with_error(seq, errors[0])
		return
	match kind:
		"resource":
			_receive_resource(record, _data)
		"transaction":
			var applied: Dictionary = _fetch_and_apply(FILE_STREAM, Rs2Decoder.as_int(meta["seq"]))
			if not applied["ok"]:
				return
			var stats: Dictionary = applied["stats"]
			_record_transaction(meta, record, stats)
		"end":
			_finish()


## Parses a CSV of seqs >= 1 from `variable` into `out`. Logs and returns false when malformed.
func _parse_seqs(variable: String, out: Array[int]) -> bool:
	var text: String = OS.get_environment(variable).strip_edges()
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
		"seq": Rs2Decoder.as_int(meta["seq"]),
		"frame": Rs2Decoder.as_int(meta["frame"]),
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
	var current: Dictionary[String, bool] = {}
	for value: Variant in meta["unsupported"]:
		var unsupported_entry: Dictionary = value
		var key: String = JSON.stringify([unsupported_entry["op"], unsupported_entry["item"], unsupported_entry["reason"]])
		current[key] = true
		if not _previous_unsupported.has(key):
			var item: Variant = null if unsupported_entry["item"] == null else Rs2Decoder.as_int(unsupported_entry["item"])
			_unsupported.append({"seq": seq, "item": item, "name": unsupported_entry["op"], "reason": unsupported_entry["reason"]})
			_log("seq %d: unsupported %s item %s (%s)" % [seq, unsupported_entry["op"], str(item), unsupported_entry["reason"]])
	_previous_unsupported = current


func _record_transaction(meta: Dictionary, record: Dictionary, stats: Dictionary) -> void:
	var entry: Dictionary = _transaction_entry(FILE_STREAM, meta, record)
	if _log_mode != "summary":
		_transactions.append(entry)
	_note_applied(entry, meta, stats)
	var seq: int = entry["seq"]

	if _state_seqs.has(seq) and not _dump_state(seq, meta):
		return

	if _shot_seqs.has(seq):
		if DisplayServer.get_name() == "headless":
			_fail(seq, "shot-unavailable", "a shot of seq %d was requested, but the display server is headless" % seq)
			return
		_busy = true
		RenderingServer.frame_post_draw.connect(_take_shot.bind(seq), CONNECT_ONE_SHOT)


## Writes state/<name>.json: the resolved state just applied, in render-stream-2.md's resolved
## `state` shape and key order. Returns false (after failing the replay) when it cannot write.
func _dump_state(seq: int, meta: Dictionary) -> bool:
	var path: String = _state_dir.path_join("%s.json" % _seq_name(seq))
	var made: Error = DirAccess.make_dir_recursive_absolute(_state_dir)
	if made != OK:
		_fail(seq, "state-failed", "cannot create %s: %s" % [_state_dir, error_string(made)])
		return false
	var file: FileAccess = FileAccess.open(path, FileAccess.WRITE)
	if file == null:
		_fail(seq, "state-failed", "cannot write %s: %s" % [path, error_string(FileAccess.get_open_error())])
		return false
	file.store_string(JSON.stringify(_state_json(meta), "", false, true) + "\n")
	file.close()
	_state_paths[_seq_name(seq)] = path
	_log("state seq %d -> %s" % [seq, path])
	return true


## "seq-<n>" (stream 1). Live connections after the first get "stream-<k>-seq-<n>" (G1d).
func _seq_name(seq: int) -> String:
	if _conn_index > 1:
		return "stream-%d-seq-%d" % [_conn_index, seq]
	return "seq-%d" % seq


## The resolved `state` object (render-stream-2.md "Decoded and resolved forms"): integers as
## ints, floats as float32 values, keys in the spec's order (the order render-stream-2.ts
## resolveRecording() emits, so a state dump compares with statesEqual()).
func _state_json(meta: Dictionary) -> Dictionary:
	var failures: Array = []
	for value: Variant in meta["failures"]:
		var failure: Dictionary = value
		failures.append({"reason": failure["reason"], "detail": failure["detail"]})
	var unsupported: Array = []
	for value: Variant in meta["unsupported"]:
		var entry: Dictionary = value
		var item: Variant = null if entry["item"] == null else Rs2Decoder.as_int(entry["item"])
		unsupported.append({"op": entry["op"], "item": item, "reason": entry["reason"]})
	var canvas_ids: Array[int] = []
	for id: int in _stream.canvases:
		canvas_ids.append(id)
	canvas_ids.sort()
	var canvases: Array = []
	for id: int in canvas_ids:
		var canvas: Dictionary = _stream.canvases[id]
		var canvas_out: Dictionary = {
			"id": id,
			"origin": canvas["origin"],
			"role": canvas["role"],
			"attached": canvas["attached"],
		}
		# render-stream-6.md "Decoded and resolved forms" (G6b): layer and sublayer, right after
		# attached and before items.
		if canvas.has("layer"):
			canvas_out["layer"] = Rs2Decoder.as_int(canvas["layer"])
			canvas_out["sublayer"] = Rs2Decoder.as_int(canvas["sublayer"])
		canvas_out["items"] = Rs2Decoder.int_list(canvas["items"])
		canvas_out["xform"] = _float_list(canvas["xform"])
		if canvas.has("modulate"):
			# render-stream-5.md "Canvas" (G55d).
			canvas_out["modulate"] = _float_list(canvas["modulate"])
		canvases.append(canvas_out)
	var item_ids: Array[int] = []
	for id: int in _stream.items:
		item_ids.append(id)
	item_ids.sort()
	var items: Array = []
	for id: int in item_ids:
		var item: Dictionary = _stream.items[id]
		var parent: Variant = item["parent"]
		var parent_out: Variant = null
		if parent != null:
			var link: Dictionary = parent
			parent_out = {"kind": link["kind"], "id": Rs2Decoder.as_int(link["id"])}
		var commands: Array = []
		for value: Variant in item["commands"]:
			var command: Dictionary = value
			match command["op"]:
				"add_rect":
					commands.append({
						"op": "add_rect",
						"aa": command["aa"],
						"rect": _float_list(command["rect"]),
						"color": _float_list(command["color"]),
					})
				"add_texture_rect":
					commands.append({
						"op": "add_texture_rect",
						"tex": _int_or_null(command["tex"]),
						"tile": command["tile"],
						"transpose": command["transpose"],
						"rect": _float_list(command["rect"]),
						"modulate": _float_list(command["modulate"]),
					})
				"add_texture_rect_region":
					commands.append({
						"op": "add_texture_rect_region",
						"tex": _int_or_null(command["tex"]),
						"transpose": command["transpose"],
						"clip_uv": command["clip_uv"],
						"rect": _float_list(command["rect"]),
						"src": _float_list(command["src"]),
						"modulate": _float_list(command["modulate"]),
					})
				"add_msdf_texture_rect_region":
					commands.append({
						"op": "add_msdf_texture_rect_region",
						"tex": _int_or_null(command["tex"]),
						"outline": Rs2Decoder.as_int(command["outline"]),
						"rect": _float_list(command["rect"]),
						"src": _float_list(command["src"]),
						"modulate": _float_list(command["modulate"]),
						"px_range": _float32(command["px_range"]),
						"scale": _float32(command["scale"]),
					})
				"add_line":
					commands.append({
						"op": "add_line",
						"aa": command["aa"],
						"from": _float_list(command["from"]),
						"to": _float_list(command["to"]),
						"colour": _float_list(command["colour"]),
						"width": _float32(command["width"]),
					})
				"add_polyline", "add_multiline":
					commands.append({
						"op": command["op"],
						"aa": command["aa"],
						"width": _float32(command["width"]),
						"points": _float_lists(command["points"]),
						"colors": _float_lists(command["colors"]),
					})
				"add_circle":
					commands.append({
						"op": "add_circle",
						"aa": command["aa"],
						"position": _float_list(command["position"]),
						"radius": _float32(command["radius"]),
						"colour": _float_list(command["colour"]),
					})
				"add_primitive", "add_polygon":
					commands.append({
						"op": command["op"],
						"tex": _int_or_null(command["tex"]),
						"points": _float_lists(command["points"]),
						"colors": _float_lists(command["colors"]),
						"uvs": _float_lists(command["uvs"]),
					})
				"add_triangle_array":
					commands.append({
						"op": "add_triangle_array",
						"tex": _int_or_null(command["tex"]),
						"count": Rs2Decoder.as_int(command["count"]),
						"points": _float_lists(command["points"]),
						"colors": _float_lists(command["colors"]),
						"uvs": _float_lists(command["uvs"]),
						"indices": Rs2Decoder.int_list(command["indices"]),
					})
				"add_nine_patch":
					commands.append({
						"op": "add_nine_patch",
						"tex": _int_or_null(command["tex"]),
						"rect": _float_list(command["rect"]),
						"source": _float_list(command["source"]),
						"margins": _float_list(command["margins"]),
						"x_axis": command["x_axis"],
						"y_axis": command["y_axis"],
						"draw_center": command["draw_center"],
						"modulate": _float_list(command["modulate"]),
					})
				"add_mesh":
					commands.append({
						"op": "add_mesh",
						"mesh": Rs2Decoder.as_int(command["mesh"]),
						"tex": _int_or_null(command["tex"]),
						"transform": _float_list(command["transform"]),
						"modulate": _float_list(command["modulate"]),
					})
				"add_set_transform":
					commands.append({"op": "add_set_transform", "transform": _float_list(command["transform"])})
				"add_clip_ignore":
					commands.append({"op": "add_clip_ignore", "ignore": command["ignore"]})
				_:
					commands.append({"op": "unsupported", "name": command["name"], "reason": command["reason"]})
		var item_out: Dictionary = {
			"id": id,
			"origin": item["origin"],
			"parent": parent_out,
			"children": Rs2Decoder.int_list(item["children"]),
			"visible": item["visible"],
			"draw_index": Rs2Decoder.as_int(item["draw_index"]),
			"z_index": Rs2Decoder.as_int(item["z_index"]),
			"z_relative": item["z_relative"],
			"behind": item["behind"],
			"clip": item["clip"],
			"custom_rect": item["custom_rect"],
			"visibility_layer": Rs2Decoder.as_int(item["visibility_layer"]),
			"texture_filter": item["texture_filter"],
			"texture_repeat": item["texture_repeat"],
		}
		if item.has("material"):
			# render-stream-5.md "Item" (G55d): before content_version, in this order.
			item_out["material"] = _int_or_null(item["material"])
			item_out["use_parent_material"] = item["use_parent_material"]
			item_out["instance_params"] = _params_json(item["instance_params"])
		item_out["content_version"] = Rs2Decoder.as_int(item["content_version"])
		item_out["xform"] = _float_list(item["xform"])
		item_out["modulate"] = _float_list(item["modulate"])
		item_out["self_modulate"] = _float_list(item["self_modulate"])
		item_out["custom_rect_rect"] = _float_list(item["custom_rect_rect"])
		item_out["commands"] = commands
		items.append(item_out)
	var texture_ids: Array[int] = []
	for id: int in _stream.textures:
		texture_ids.append(id)
	texture_ids.sort()
	var textures: Array = []
	for id: int in texture_ids:
		var t: Dictionary = _stream.textures[id]
		var canvas_out: Variant = null
		if t["canvas"] != null:
			var info: Dictionary = t["canvas"]
			canvas_out = {"diffuse": _int_or_null(info["diffuse"]), "filter": info["filter"], "repeat": info["repeat"]}
		textures.append({
			"id": id,
			"origin": t["origin"],
			"kind": t["kind"],
			"status": t["status"],
			"reason": t["reason"],
			"version": Rs2Decoder.as_int(t["version"]),
			"hash": t["hash"],
			"format": t["format"],
			"width": Rs2Decoder.as_int(t["width"]),
			"height": Rs2Decoder.as_int(t["height"]),
			"mipmaps": t["mipmaps"],
			"payload_bytes": Rs2Decoder.as_int(t["payload_bytes"]),
			"canvas": canvas_out,
		})
	var state: Dictionary = {
		"status": meta["status"],
		"failures": failures,
		"unsupported": unsupported,
		"default_texture_filter": _stream.default_texture_filter,
		"default_texture_repeat": _stream.default_texture_repeat,
		"canvases": canvases,
		"items": items,
		"textures": textures,
	}
	if _stream.version >= 4:
		# render-stream-4.md "Decoded and resolved forms" (G5e): the mesh table, custom_aabb lifted.
		var mesh_ids: Array[int] = []
		for id: int in _stream.meshes:
			mesh_ids.append(id)
		mesh_ids.sort()
		var meshes: Array = []
		for id: int in mesh_ids:
			var m: Dictionary = _stream.meshes[id]
			var surfaces: Array = []
			for value: Variant in m["surfaces"]:
				var surface: Dictionary = value
				surfaces.append({
					"hash": surface["hash"],
					"payload_bytes": Rs2Decoder.as_int(surface["payload_bytes"]),
					"primitive": surface["primitive"],
					"format": Rs2Decoder.as_int(surface["format"]),
					"vertex_count": Rs2Decoder.as_int(surface["vertex_count"]),
					"index_count": Rs2Decoder.as_int(surface["index_count"]),
				})
			meshes.append({
				"id": id,
				"origin": m["origin"],
				"status": m["status"],
				"reason": m["reason"],
				"version": Rs2Decoder.as_int(m["version"]),
				"custom_aabb": _float_list(m["custom_aabb"]),
				"surfaces": surfaces,
			})
		state["meshes"] = meshes
	if _stream.version >= 5:
		# render-stream-5.md "Decoded and resolved forms" (G55d): the shader and material tables,
		# parameters as {name, type, value}.
		var shader_ids: Array[int] = []
		for id: int in _stream.shaders:
			shader_ids.append(id)
		shader_ids.sort()
		var shaders: Array = []
		for id: int in shader_ids:
			var sh: Dictionary = _stream.shaders[id]
			var default_textures: Array = []
			for value: Variant in sh["default_textures"]:
				var default_texture: Dictionary = value
				default_textures.append({
					"name": default_texture["name"],
					"index": Rs2Decoder.as_int(default_texture["index"]),
					"tex": Rs2Decoder.as_int(default_texture["tex"]),
				})
			var uses: Array = []
			for value: Variant in sh["uses"]:
				uses.append(value)
			shaders.append({
				"id": id,
				"origin": sh["origin"],
				"status": sh["status"],
				"reason": sh["reason"],
				"version": Rs2Decoder.as_int(sh["version"]),
				"mode": sh["mode"],
				"source": sh["source"],
				"hash": sh["hash"],
				"payload_bytes": Rs2Decoder.as_int(sh["payload_bytes"]),
				"builtin": sh["builtin"],
				"uses": uses,
				"default_textures": default_textures,
			})
		state["shaders"] = shaders
		var material_ids: Array[int] = []
		for id: int in _stream.materials:
			material_ids.append(id)
		material_ids.sort()
		var materials: Array = []
		for id: int in material_ids:
			var mat: Dictionary = _stream.materials[id]
			materials.append({
				"id": id,
				"origin": mat["origin"],
				"status": mat["status"],
				"reason": mat["reason"],
				"version": Rs2Decoder.as_int(mat["version"]),
				"shader": _int_or_null(mat["shader"]),
				"params": _params_json(mat["params"]),
			})
		state["materials"] = materials
	return state


## Resolved /5 parameters ({name, type, value}, render-stream-5.md) for a state dump: the float64
## values unchanged, a `rid` value as {"tex": <int>}.
static func _params_json(params: Variant) -> Array:
	var list: Array = params
	var out: Array = []
	for value: Variant in list:
		var param: Dictionary = value
		var param_value: Variant = param["value"]
		if param["type"] == "rid" and param_value != null:
			var link: Dictionary = param_value
			param_value = {"tex": Rs2Decoder.as_int(link["tex"])}
		out.append({"name": param["name"], "type": param["type"], "value": param_value})
	return out


static func _int_or_null(value: Variant) -> Variant:
	return null if value == null else Rs2Decoder.as_int(value)


## One float as a float32 value (JSON keeps it as a double holding that value).
static func _float32(value: Variant) -> float:
	var one: PackedFloat32Array = PackedFloat32Array([value])
	return one[0]


## A list of float lists (points, colours, UVs), each element a float32 value.
static func _float_lists(values: Variant) -> Array:
	var list: Array = values
	var out: Array = []
	for value: Variant in list:
		out.append(_float_list(value))
	return out


## A float list as JSON floats holding float32 values.
static func _float_list(values: Variant) -> Array[float]:
	var list: Array = values
	var out: Array[float] = []
	for value: float in PackedFloat32Array(list):
		out.append(value)
	return out


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
	_report["status"] = "ok"
	_write_report()
	_log("ok: %d transactions applied, %d shots, %d state dumps, %d unsupported, %d RS calls" % [_transactions.size(), _shots.size(), _state_paths.size(), _unsupported.size(), _applier.rs_calls])
	_quit(EXIT_OK)


# --------------------------------------------------------------------------- live mode (G1c2)


func _ready_live() -> void:
	_live = true
	_out_path = OS.get_environment("RS_RECEIVER_OUT")
	if _out_path == "" or not _out_path.is_absolute_path():
		_log("error: RS_RECEIVER_OUT must be an absolute applied.json path (got %s)" % JSON.stringify(_out_path))
		_quit(EXIT_USAGE)
		return
	for variable: String in ["RS_RECEIVER_RECORDING", "RS_RECEIVER_SHOT_SEQS", "RS_RECEIVER_STATE_SEQS"]:
		if OS.get_environment(variable) != "":
			_log("error: %s is a file-mode variable; live mode uses RS_RECEIVER_URL and RS_RECEIVER_SHOT_WINDOWS" % variable)
			_quit(EXIT_USAGE)
			return
	_url = OS.get_environment("RS_RECEIVER_URL").strip_edges()
	if not (_url.begins_with("ws://127.0.0.1:") or _url.begins_with("ws://[::1]:")):
		_log("error: RS_RECEIVER_URL must be ws://127.0.0.1:<port>/... or ws://[::1]:<port>/... (loopback only; got %s)" % JSON.stringify(_url))
		_quit(EXIT_USAGE)
		return
	_shot_dir = _out_path.get_base_dir().path_join("shots")
	_state_dir = _out_path.get_base_dir().path_join("state")
	if not _parse_windows() or not _parse_g1d_options():
		_quit(EXIT_USAGE)
		return
	_received_path = OS.get_environment("RS_RECEIVER_RECEIVED_OUT")
	if _received_path == "":
		_received_path = _out_path.get_base_dir().path_join("received.rs2")
	elif not _received_path.is_absolute_path():
		_log("error: RS_RECEIVER_RECEIVED_OUT must be absolute (got %s)" % JSON.stringify(_received_path))
		_quit(EXIT_USAGE)
		return
	_received_base = _received_path
	var token_file: String = OS.get_environment("RS_RECEIVER_TOKEN_FILE").strip_edges()
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
	var inbound: int = _positive_env("RS_RECEIVER_INBOUND_BYTES", DEFAULT_INBOUND_BYTES)
	var timeout_ms: int = _positive_env("RS_RECEIVER_CONNECT_TIMEOUT", DEFAULT_CONNECT_TIMEOUT_MS)
	if inbound < 0 or timeout_ms < 0:
		_quit(EXIT_USAGE)
		return
	_inbound_bytes = inbound
	_connect_timeout_ms = timeout_ms
	var stage: String = OS.get_environment("RS_RECEIVER_CREDIT_STAGE").strip_edges()
	if stage == "":
		stage = "submitted"
	if not RsLiveClient.CREDIT_STAGES.has(stage):
		_log("error: RS_RECEIVER_CREDIT_STAGE must be submitted or applied (got %s)" % JSON.stringify(stage))
		_quit(EXIT_USAGE)
		return
	if not _parse_resource_env(true):
		_quit(EXIT_USAGE)
		return
	if not _parse_perf_env():
		_quit(EXIT_USAGE)
		return
	var display_server: String = _init_report("live")
	if not _open_cache():
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
	if display_server == "headless" and not _windows.is_empty():
		_fail(null, "shot-unavailable", "shot windows were requested, but the display server is headless")
		return

	DirAccess.make_dir_recursive_absolute(_received_path.get_base_dir())
	_received_file = FileAccess.open(_received_path, FileAccess.WRITE)
	if _received_file == null:
		_fail(null, "received-unwritable", "cannot write %s: %s" % [_received_path, error_string(FileAccess.get_open_error())])
		return
	_applier = RsApplier.new(get_viewport().get_viewport_rid(), get_viewport().find_world_2d().canvas)
	if _perf != null:
		_perf.enable_render_time_measurement(get_viewport().get_viewport_rid())
	_client = RsLiveClient.new()
	var opened: Error = _client.open(_url, _inbound_bytes, _token)
	if opened != OK:
		_fail(null, "live-connect-failed", "connect_to_url(%s): %s" % [_url, error_string(opened)])
		return
	_live_phase = "connecting"
	_deadline_msec = Time.get_ticks_msec() + timeout_ms
	set_process(true)


## A positive integer environment value, or `fallback` when unset; -1 (after logging) when
## malformed.
func _positive_env(variable: String, fallback: int) -> int:
	var text: String = OS.get_environment(variable).strip_edges()
	if text == "":
		return fallback
	if not text.is_valid_int() or text.to_int() < 1:
		_log("error: %s must be an integer >= 1 (got %s)" % [variable, JSON.stringify(text)])
		return -1
	return text.to_int()


## RS_RECEIVER_SHOT_WINDOWS: CSV of <step>:<from>-<to>, from <= to, each step once.
func _parse_windows() -> bool:
	var text: String = OS.get_environment("RS_RECEIVER_SHOT_WINDOWS").strip_edges()
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
	var stall: String = OS.get_environment("RS_RECEIVER_STALL").strip_edges()
	if stall != "":
		var parts: PackedStringArray = stall.split(":")
		if parts.size() != 2 or not parts[0].is_valid_int() or not parts[1].is_valid_int() or parts[0].to_int() < 0 or parts[1].to_int() < 1:
			_log("error: RS_RECEIVER_STALL must be <step>:<ms> with ms >= 1 (got %s)" % JSON.stringify(stall))
			return false
		_stall_step = parts[0].to_int()
		_stall_ms = parts[1].to_int()
	for variable: String in ["RS_RECEIVER_RECONNECT", "RS_RECEIVER_RESYNC"]:
		var text: String = OS.get_environment(variable).strip_edges()
		if text == "":
			continue
		if not text.is_valid_int() or text.to_int() < 0:
			_log("error: %s must be a step >= 0 (got %s)" % [variable, JSON.stringify(text)])
			return false
		if variable == "RS_RECEIVER_RECONNECT":
			_reconnect_step = text.to_int()
		else:
			_resync_step = text.to_int()
	var memory: String = OS.get_environment("RS_RECEIVER_RECONNECT_MEMORY").strip_edges()
	if memory != "":
		if memory != "drop" and memory != "keep":
			_log("error: RS_RECEIVER_RECONNECT_MEMORY must be drop or keep (got %s)" % JSON.stringify(memory))
			return false
		_reconnect_memory = memory
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
				var reconnect: Dictionary = _live_report["reconnect"]
				reconnect["connect_attempts"] = Rs2Decoder.as_int(reconnect["connect_attempts"]) + 1
				var opened: Error = _client.open(_url, _inbound_bytes, _token)
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
		if code == 1002 or code == 1008 or code == 1009:
			_fail(_last_seq_or_null(), "host-error", "%s: the host closed with %d" % [reason, code])
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


## RS_RECEIVER_RECONNECT, part 2: finish connection 1's received file, free every RID the applier
## made (dispose), and open connection 2 with a new received file and a new decoder stream; its
## first message is a fresh session.
func _start_next_connection() -> void:
	_received_file.flush()
	_received_file.close()
	_received_file = null
	_stream_report["received_sha256"] = Rs2Decoder.sha256_hex(_data)
	_stream_report["received_bytes"] = _data.size()
	var owned_before: int = _applier.owned_rids()
	var freed: int = _applier.dispose()
	var leftover: int = _applier.owned_rids()
	var reconnect: Dictionary = _live_report["reconnect"]
	reconnect["created_rids"] = _applier.created_rids
	reconnect["freed_by_apply"] = _applier.freed_by_apply
	reconnect["owned_before_dispose"] = owned_before
	reconnect["freed_rids"] = freed
	reconnect["leftover_rids"] = leftover
	reconnect["closed_us"] = Time.get_ticks_usec()
	_log("reconnect: disposed %d RIDs (created %d, freed while applying %d, left %d)" % [freed, _applier.created_rids, _applier.freed_by_apply, leftover])

	_conn_index += 1
	_received_path = "%s-%d.%s" % [_received_base.get_basename(), _conn_index, _received_base.get_extension()]
	_received_file = FileAccess.open(_received_path, FileAccess.WRITE)
	if _received_file == null:
		_fail(null, "received-unwritable", "cannot write %s: %s" % [_received_path, error_string(FileAccess.get_open_error())])
		return
	_data = PackedByteArray()
	_stream = Rs2Decoder.Stream.new()
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
	var opened: Error = _client.open(_url, _inbound_bytes, _token)
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
			_fail(_last_seq_or_null(), "host-error", detail)
			return
		_receive_binary(data)
		if _finished:
			return


func _receive_binary(message: PackedByteArray) -> void:
	var now_us: int = Time.get_ticks_usec()
	var offset: int = _data.size()
	_data.append_array(message)
	_received_file.store_buffer(message)
	_received_file.flush()
	_stream_report["received_bytes"] = _data.size()
	if not _session_seen:
		# The first message is the magic followed by exactly the session record.
		var split: Dictionary = Rs2Decoder.split_records(message)
		var split_errors: PackedStringArray = split["errors"]
		if split_errors.size() > 0:
			_fail_with_error(null, split_errors[0])
			return
		var records: Array[Dictionary] = split["records"]
		if records.size() != 1:
			_fail(null, "live-framing", "the first message holds %d records, expected exactly the session" % records.size())
			return
		_session_seen = true
		_begin_session(RsApplier.accept_record(_data, 8, _stream))
		return
	var expected_seq: int = _stream.last_seq + 1
	var decode_t0: int = Time.get_ticks_usec() if _perf != null else 0
	var accepted: Dictionary = RsApplier.accept_record(_data, offset, _stream)
	if _perf != null:
		_perf.decode_us.add(Time.get_ticks_usec() - decode_t0)
	var errors: PackedStringArray = accepted["errors"]
	var record: Dictionary = accepted["record"]
	var meta: Dictionary = record["meta"]
	var kind: String = accepted["kind"]
	if errors.size() > 0:
		var seq: Variant = null
		if kind == "transaction" or kind == "":
			seq = Rs2Decoder.as_int(meta["seq"]) if Rs2Decoder.is_int(meta.get("seq")) else expected_seq
		_fail_with_error(seq, errors[0])
		return
	if Rs2Decoder.as_int(record["byte_length"]) != message.size():
		_fail(null, "live-framing", "a message of %d bytes holds a %d-byte record; every message after the first is exactly one record" % [message.size(), Rs2Decoder.as_int(record["byte_length"])])
		return
	match kind:
		"resource":
			# Inline payloads (render-stream-2.md "Live transport"): kept for the transactions that
			# follow; no ack.
			_receive_resource(record, _data)
		"transaction":
			var entry: Dictionary = _transaction_entry(_conn_index, meta, record)
			entry["received_us"] = now_us
			if _log_mode != "summary":
				_transactions.append(entry)
			var received_seq: int = entry["seq"]
			_send(RsLiveClient.ack(_stream_id, received_seq, "received", now_us))
			_acks_sent["received"] = Rs2Decoder.as_int(_acks_sent["received"]) + 1
			# Only the resolved state after the newest accepted transaction can be applied; an older
			# waiting one is superseded (never happens under credit: one in flight).
			_waiting.append({"entry": entry, "meta": meta})
		"end":
			_end_seen = true
			_stream_report["end_seen"] = true
			_report["end_seen"] = true
			_log("end record after %d transactions" % _stream.transactions)
		_:
			_fail(null, "live-framing", "unexpected %s record" % kind)


func _apply_newest() -> void:
	var newest: Dictionary = _waiting[_waiting.size() - 1]
	_waiting.clear()
	var entry: Dictionary = newest["entry"]
	var meta: Dictionary = newest["meta"]
	if _refuse_for_resync(entry):
		return
	_begin_apply(entry, meta, _empty_resources())


## The payloads the current resolved state needs that are neither in memory nor in the cache
## directory (or every one not in memory, under ignore-cache): what live mode fetches over HTTP.
func _http_misses() -> Array[String]:
	var out: Array[String] = []
	if _fetcher == null:
		return out
	var need: Dictionary = _applier.needed(_stream.items, _stream.textures, _stream.meshes, _stream.shaders, _stream.materials)
	var mesh_hashes: Array = need["mesh_hashes"]
	var shader_hashes: Array = need["shader_hashes"]
	for value: Variant in need["hashes"]:
		var hash: String = value
		if _cache.has_in_memory(hash):
			continue
		if not _cache.ignore_cache and _cache.cache_has(hash, mesh_hashes.has(hash), shader_hashes.has(hash)):
			continue
		out.append(hash)
	return out


## Applies `entry` once every payload it needs is available; until then its HTTP fetches run
## (_poll_fetches) and the previous state stays on screen. `resources` carries the fetch counters
## of the passes so far.
func _begin_apply(entry: Dictionary, meta: Dictionary, resources: Dictionary) -> void:
	var misses: Array[String] = _http_misses()
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
		}
		_fetches.append(fetch_entry)
		resources["fetch_us"] = Rs2Decoder.as_int(resources["fetch_us"]) + (end_us - start_us)
		if error == "":
			# A 200 body: verified against its name first (a mismatch leaves verified false).
			var body: PackedByteArray = result["data"]
			fetch_entry["kind"] = RsResourceCache.payload_kind(body)
			if fetch_entry["kind"] == "shader":
				resources["shader_payload_fetches"] = Rs2Decoder.as_int(resources.get("shader_payload_fetches", 0)) + 1
			error = _cache.add_fetched(hash, body, "GET %s" % hash)
			fetch_entry["verified"] = not error.begins_with("resource-hash-mismatch")
		if error != "":
			_fail_with_error(seq, error)
			return
		resources["fetched"] = Rs2Decoder.as_int(resources["fetched"]) + 1
		resources["fetched_bytes"] = Rs2Decoder.as_int(resources["fetched_bytes"]) + got_bytes
		_summary["fetched_bytes"] = Rs2Decoder.as_int(_summary["fetched_bytes"]) + got_bytes
		_fetched_hashes[hash] = true
		_summary["distinct_fetched"] = _fetched_hashes.size()
	var meta: Dictionary = pending["meta"]
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
	_send(RsLiveClient.ack(_stream_id, seq, "applied", now_us))
	_acks_sent["applied"] = Rs2Decoder.as_int(_acks_sent["applied"]) + 1
	var step: int = -1
	var frame: int = entry["frame"]
	for window: Dictionary in _windows:
		if not window["shot"] and frame >= Rs2Decoder.as_int(window["from"]) and frame <= Rs2Decoder.as_int(window["to"]):
			step = window["step"]
			window["shot"] = true
			break
	if step >= 0 and not _dump_state(seq, meta):
		return
	if _credit_stage == "submitted" or step >= 0:
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
		})
		_log("shot step %d seq %d frame %d -> %s" % [step, seq, Rs2Decoder.as_int(entry["frame"]), path])
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
			"after_frame": Rs2Decoder.as_int(entry["frame"]),
			"start_us": start_us,
			"end_us": end_us,
			"injected": true,
			"mechanism": "OS.delay_msec on the receiver main thread after frame_post_draw, before the submitted ack",
		}
		_log("stall: blocked %d us after the step %d shot (seq %d), injected" % [end_us - start_us, step, seq])
	var now_us: int = Time.get_ticks_usec()
	entry["submitted_us"] = now_us
	_send(RsLiveClient.ack(_stream_id, seq, "submitted", now_us))
	_acks_sent["submitted"] = Rs2Decoder.as_int(_acks_sent["submitted"]) + 1
	_submit_pending = false
	if step >= 0 and step == _reconnect_step and _live_report["reconnect"] == null:
		_live_report["reconnect"] = {
			"step": step,
			"after_seq": seq,
			"after_frame": Rs2Decoder.as_int(entry["frame"]),
			"connect_attempts": 1,
			"created_rids": null,
			"freed_by_apply": null,
			"owned_before_dispose": null,
			"freed_rids": null,
			"leftover_rids": null,
			"closed_us": null,
		}
		_reconnect_due = true


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
		if window["shot"] or frame < Rs2Decoder.as_int(window["from"]) or frame > Rs2Decoder.as_int(window["to"]):
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
	if _stream.last_seq > 0:
		return _stream.last_seq
	return null


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
	if _cache_report != null and _cache.dir != "":
		var cache_report: Dictionary = _cache_report
		cache_report["entries_after"] = _cache.entries()
		cache_report["bytes_after"] = _cache.bytes()
	if _applier != null:
		var floats: Array[float] = []
		for value: float in _applier.root_canvas_xform():
			floats.append(value)
		_viewport_report["canvas_transform"] = floats
	if _live:
		if _received_file != null:
			_received_file.flush()
		var sha256: String = Rs2Decoder.sha256_hex(_data)
		_stream_report["received_sha256"] = sha256
		_stream_report["received_bytes"] = _data.size()
		_report["recording"] = {"path": _received_path, "sha256": sha256, "bytes": _data.size()}
	DirAccess.make_dir_recursive_absolute(_out_path.get_base_dir())
	var file: FileAccess = FileAccess.open(_out_path, FileAccess.WRITE)
	if file == null:
		_log("error: cannot write %s: %s" % [_out_path, error_string(FileAccess.get_open_error())])
		return
	file.store_string(JSON.stringify(_report, "  ", false) + "\n")
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
	if _applier != null:
		var freed: int = _applier.dispose()
		_log("disposed: %d RIDs freed" % freed)
	get_tree().quit(code)


func _log(text: String) -> void:
	print("[receiver] " + text)
