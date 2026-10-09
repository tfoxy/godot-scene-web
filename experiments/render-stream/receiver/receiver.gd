extends Node
## render-stream/2 receiver (gate0-design.md "Q5. Receiver", extended by gate1-design.md "Q5.
## Receiver", "G1b2" and "G1c2", and by gate2-design.md "Q5. Receiver" and "G2b2"). Its only
## input is a render-stream/2 byte stream: a recording file (file mode) or the binary messages of
## one WebSocket connection (live mode), plus the texture payloads that stream names.
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
##   RS_RECEIVER_CACHE_DIR        absolute content-addressed cache (sha256/<hash>.grt); required
##                                when the session's delivery is not inline
##   RS_RECEIVER_CACHE_MODE       fresh (default: the directory must be absent or empty, else
##                                replay-failure cache-not-fresh) or warm (it must exist)
##   RS_RECEIVER_STORE_DIR        file mode: the capture's store, the origin for fetch "directory"
##                                (reading from it counts as a fetch)
##   RS_RECEIVER_FETCH_TIMEOUT_MS live: a GET not complete this many ms after it was issued is
##                                resource-unavailable (default 10000)
##   RS_RECEIVER_FETCH_DELAY_MS   an injected delay before each fetch, default 0 (file mode: a
##                                blocked main loop; live mode: a timed wait, the loop keeps
##                                presenting)
##   RS_RECEIVER_SABOTAGE         reupload (upload every resident texture at every applied
##                                transaction), ignore-cache (fetch even on a cache hit), or
##                                wrong-http-token (live only, G2e: send the correct bearer token
##                                on the WebSocket upgrade but a deliberately wrong one on every
##                                resource GET); all three exist only to fail checks
## Before a transaction is applied, every `ok` image a command of its resolved state names that is
## not resident (or resident with another hash) is made available: from memory (inline resource
## records and earlier fetches), from the cache (a cache hit), or fetched from the store and
## written to the cache. Each is verified against its SHA-256 name and decoded first
## (resource-hash-mismatch, resource-unavailable, resource-invalid otherwise). In live mode with
## `fetch: "http"` (G2c2) a miss is fetched with RsResourceFetcher, `GET <http_path><hash>` on the
## RS_RECEIVER_URL host and port, one keep-alive HTTPClient, sequentially, polled from _process:
## the transaction waits (unapplied, unacknowledged beyond `received`) until every payload it
## needs is in, and the rendered loop keeps presenting the previous state meanwhile. After a
## reconnect the payloads held in memory are dropped, so connection 2 takes them from the cache.
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

const SCHEMA: String = "render-stream-receiver-applied/3"
const EXIT_OK: int = 0
const EXIT_USAGE: int = 2
const EXIT_REPLAY_FAILURE: int = 3
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
var _fetched_hashes: Dictionary[String, bool] = {}
var _summary: Dictionary = {"distinct_fetched": 0, "fetched_bytes": 0, "cache_hits": 0, "uploads": 0, "upload_bytes": 0}
var _fetch_delay_ms: int = 0
var _fetch_timeout_ms: int = 10000
var _inline_since_applied: int = 0
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
		"transactions": _transactions,
		"shots": _shots,
		"shots_missed": [],
		"unsupported": _unsupported,
		"live": null,
		# G2b2 (render-stream-receiver-applied/3, gate2-design.md Q5 "applied.json").
		"cache": null,
		"fetches": _fetches,
		"uploads": _uploads,
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
	if sabotage != "" and sabotage != "reupload" and sabotage != "ignore-cache" and sabotage != "wrong-http-token":
		_log("error: RS_RECEIVER_SABOTAGE must be reupload, ignore-cache or wrong-http-token (got %s)" % JSON.stringify(sabotage))
		return false
	_cache.dir = cache_dir
	_cache.mode = cache_mode
	_cache.store_dir = store_dir
	_cache.ignore_cache = sabotage == "ignore-cache"
	_sabotage = sabotage
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
	_log("cache %s (%s): %d entries; store %s; sabotage %s" % [_cache.dir, _cache.mode, _cache.entries_before, _cache.store_dir if _cache.store_dir != "" else "<none>", _sabotage if _sabotage != "" else "<none>"])
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
## fetch_us) and the report's fetch list. Returns "" or the replay-failure error.
func _obtain_needed(stream_index: int, seq: int, resources: Dictionary) -> String:
	var need: Dictionary = _applier.needed(_stream.items, _stream.textures)
	var hashes: Array = need["hashes"]
	var fetch_us: int = Rs2Decoder.as_int(resources["fetch_us"])
	for value: Variant in hashes:
		var hash: String = value
		if _cache.has_in_memory(hash):
			continue
		if _cache.dir == "" and _delivery != "inline":
			return Rs2Decoder.err("resource-unavailable", "payload %s is needed, and RS_RECEIVER_CACHE_DIR is unset (delivery %s)" % [hash, _delivery])
		var will_fetch: bool = _cache.ignore_cache or not FileAccess.file_exists(_cache.dir.path_join(RsResourceCache.CACHE_SUBDIR).path_join(hash + ".grt"))
		if will_fetch and _fetch_delay_ms > 0:
			OS.delay_msec(_fetch_delay_ms)
		var got: Dictionary = _cache.obtain(hash)
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
				"verified": got["verified"],
			})
			resources["fetched"] = Rs2Decoder.as_int(resources["fetched"]) + 1
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
		"skipped_commands": 0,
	}


## Fetches what the resolved state needs, then applies it. Returns {ok: bool, stats} (ok false
## after failing the replay at `seq`).
func _fetch_and_apply(stream_index: int, seq: int, prefetched: Dictionary = {}) -> Dictionary:
	var resources: Dictionary = _empty_resources()
	for key: String in ["fetched", "fetched_bytes", "fetch_us"]:
		if prefetched.has(key):
			resources[key] = prefetched[key]
	resources["inline_received"] = _inline_since_applied
	_inline_since_applied = 0
	var error: String = _obtain_needed(stream_index, seq, resources)
	if error != "":
		_fail_with_error(seq, error)
		return {"ok": false, "stats": {}}
	var stats: Dictionary = _applier.apply_state(_stream, _cache)
	var applied: Dictionary = stats["resources"]
	for key: String in ["created", "updated", "replaced", "freed", "upload_bytes", "skipped_commands"]:
		resources[key] = applied[key]
	stats["resources"] = resources
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
	if DisplayServer.get_name() != "headless":
		var visible_size: Vector2 = get_viewport().get_visible_rect().size
		if visible_size != logical_size:
			_viewport_report["size_check"] = "mismatch"
			_fail(null, "viewport-mismatch", "visible rect size is %s, the session's logical_size is %s" % [str(visible_size), str(logical_size)])
			return false
		_viewport_report["size_check"] = "ok"
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
	_applier.begin_session(meta, blocks)
	_log("session %s stream %s (%s, %s) applied (%d RS calls)" % [meta["session_id"], stream_meta["stream_id"], stream_meta["transport"], stream_meta["encoding"], _applier.rs_calls])
	return true


func _process(_delta: float) -> void:
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
	var result: Dictionary = RsApplier.accept_record(_data, Rs2Decoder.as_int(raw["offset"]), _stream)
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
		canvases.append({
			"id": id,
			"origin": canvas["origin"],
			"role": canvas["role"],
			"attached": canvas["attached"],
			"items": Rs2Decoder.int_list(canvas["items"]),
			"xform": _float_list(canvas["xform"]),
		})
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
				_:
					commands.append({"op": "unsupported", "name": command["name"], "reason": command["reason"]})
		items.append({
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
			"content_version": Rs2Decoder.as_int(item["content_version"]),
			"xform": _float_list(item["xform"]),
			"modulate": _float_list(item["modulate"]),
			"self_modulate": _float_list(item["self_modulate"]),
			"custom_rect_rect": _float_list(item["custom_rect_rect"]),
			"commands": commands,
		})
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
	return {
		"status": meta["status"],
		"failures": failures,
		"unsupported": unsupported,
		"default_texture_filter": _stream.default_texture_filter,
		"default_texture_repeat": _stream.default_texture_repeat,
		"canvases": canvases,
		"items": items,
		"textures": textures,
	}


static func _int_or_null(value: Variant) -> Variant:
	return null if value == null else Rs2Decoder.as_int(value)


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
	# the cache directory or a fetch, never from this process's memory.
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
	var accepted: Dictionary = RsApplier.accept_record(_data, offset, _stream)
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
	var need: Dictionary = _applier.needed(_stream.items, _stream.textures)
	for value: Variant in need["hashes"]:
		var hash: String = value
		if _cache.has_in_memory(hash):
			continue
		if not _cache.ignore_cache and _cache.cache_has(hash):
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
