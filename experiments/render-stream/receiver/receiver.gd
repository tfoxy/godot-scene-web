extends Node
## render-stream/1 receiver (gate0-design.md "Q5. Receiver", extended by gate1-design.md "Q5.
## Receiver", "G1b2" and "G1c2"). Its only input is a render-stream/1 byte stream: a recording
## file (file mode) or the binary messages of one WebSocket connection (live mode).
##
## File mode (RS_RECEIVER_MODE unset or "file"):
##   RS_RECEIVER_RECORDING   absolute .rs1 path (required)
##   RS_RECEIVER_OUT         absolute applied.json path (required); shots go to <dirname>/shots/,
##                           state dumps to <dirname>/state/
##   RS_RECEIVER_SHOT_SEQS   CSV of transaction seqs to screenshot (optional)
##   RS_RECEIVER_STATE_SEQS  CSV of transaction seqs whose resolved state is dumped (optional)
## The whole file is framed first. The session is applied in _ready, then one record per _process
## frame.
##
## Live mode (RS_RECEIVER_MODE=live, G1c2):
##   RS_RECEIVER_URL             ws://127.0.0.1:<port>/render-stream or ws://[::1]:<port>/... (required)
##   RS_RECEIVER_OUT             as in file mode
##   RS_RECEIVER_SHOT_WINDOWS    CSV of <step>:<from>-<to> host-frame windows: the first applied
##                               transaction whose frame is in a window is shot (after
##                               frame_post_draw) and its state dumped (optional)
##   RS_RECEIVER_RECEIVED_OUT    absolute path of the received bytes (default <dirname>/received.rs1)
##   RS_RECEIVER_INBOUND_BYTES   WebSocketPeer.inbound_buffer_size, set before connecting
##                               (default 16777216)
##   RS_RECEIVER_CREDIT_STAGE    submitted (default) or applied; forced to applied under --headless,
##                               where frame_post_draw never fires
##   RS_RECEIVER_CONNECT_TIMEOUT milliseconds to reach STATE_OPEN (default 10000)
## On open it sends `hello`. Each binary message is appended to the received file, framed (the
## first is the magic and the session, every later one exactly one record), decoded and accepted
## (Rs1Decoder.Stream resolves patches) and acked `received`. The newest accepted transaction is
## applied at most once per _process and acked `applied`; at the next frame_post_draw a due shot is
## taken and the `submitted` ack sent. `presented` is unavailable in Godot and never guessed. The
## end record finishes the run; a close without it is replay-failure live-disconnected, a host
## `error` message replay-failure host-error. RS_RECEIVER_STALL / _RECONNECT / _RESYNC land in G1d.
##
## Every record is decoded and validated completely (Rs1Decoder.decode_record, then
## Rs1Decoder.Stream.accept, which resolves patches) before RsApplier makes any RenderingServer
## call for it; the applier then reconciles the RESOLVED state with its own mirror. A failure
## writes applied.json with status replay-failure and quits with 3. A clean end record writes
## status ok and quits with 0. A usage error (missing or malformed environment, or an unsupported
## mode) quits with 2 and writes nothing.

const SCHEMA: String = "render-stream-receiver-applied/2"
const EXIT_OK: int = 0
const EXIT_USAGE: int = 2
const EXIT_REPLAY_FAILURE: int = 3
## File mode carries exactly one stream; transactions and shots name it as stream 1. Live mode
## numbers its connections from 1 (one connection until G1d's reconnect).
const FILE_STREAM: int = 1
const DEFAULT_INBOUND_BYTES: int = 16777216
const DEFAULT_CONNECT_TIMEOUT_MS: int = 10000
## How long the receiver waits for the host's close after the end record before closing itself.
const CLOSE_WAIT_MS: int = 2000

var _data := PackedByteArray()
var _records: Array[Dictionary] = []
var _next_record: int = 0
var _stream := Rs1Decoder.Stream.new()
var _applier: RsApplier
var _recording_path: String = ""
var _out_path: String = ""
var _shot_dir: String = ""
var _state_dir: String = ""
var _shot_seqs: Array[int] = []
var _state_seqs: Array[int] = []
var _state_paths: Dictionary[int, String] = {}
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

	var display_server: String = _init_report("file")
	_log("mode file, recording %s, out %s, shot seqs %s, state seqs %s, display %s" % [_recording_path, _out_path, str(_shot_seqs), str(_state_seqs), display_server])

	if _recording_path == "" or not _recording_path.is_absolute_path() or not FileAccess.file_exists(_recording_path):
		_fail(null, "recording-unreadable", "RS_RECEIVER_RECORDING is not an absolute path to an existing file: %s" % JSON.stringify(_recording_path))
		return
	_data = FileAccess.get_file_as_bytes(_recording_path)
	if _data.is_empty() and FileAccess.get_open_error() != OK:
		_fail(null, "recording-unreadable", "cannot read %s: %s" % [_recording_path, error_string(FileAccess.get_open_error())])
		return
	var sha256: String = Rs1Decoder.sha256_hex(_data)
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
	var split: Dictionary = Rs1Decoder.split_records(_data)
	var split_errors: PackedStringArray = split["errors"]
	if split_errors.size() > 0:
		_fail_with_error(null, split_errors[0])
		return
	_records = split["records"]
	if _records.is_empty():
		_fail_with_error(null, Rs1Decoder.err("missing-session", "the recording has no records"))
		return

	_applier = RsApplier.new(get_viewport().get_viewport_rid(), get_viewport().find_world_2d().canvas)
	var raw: Dictionary = _records[_next_record]
	_next_record += 1
	if not _begin_session(RsApplier.accept_record(_data, Rs1Decoder.as_int(raw["offset"]), _stream)):
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
	}
	return display_server


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
		_fail_with_error(null, Rs1Decoder.err("missing-session", "the first record is a %s, not a session" % accepted["kind"]))
		return false
	_report["session_id"] = meta["session_id"]
	var stream_meta: Dictionary = meta["stream"]
	_stream_id = stream_meta["stream_id"]
	_stream_report["stream_id"] = stream_meta["stream_id"]
	_stream_report["connection"] = stream_meta["connection"]
	var session_viewport: Dictionary = meta["viewport"]
	var logical: Array = session_viewport["logical_size"]
	var logical_size := Vector2(Rs1Decoder.as_int(logical[0]), Rs1Decoder.as_int(logical[1]))
	_viewport_report["logical_size"] = [int(logical_size.x), int(logical_size.y)]
	if DisplayServer.get_name() != "headless":
		var visible_size: Vector2 = get_viewport().get_visible_rect().size
		if visible_size != logical_size:
			_viewport_report["size_check"] = "mismatch"
			_fail(null, "viewport-mismatch", "visible rect size is %s, the session's logical_size is %s" % [str(visible_size), str(logical_size)])
			return false
		_viewport_report["size_check"] = "ok"
	var blocks: Array[PackedFloat32Array] = record["blocks"]
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
	# The only place transaction RS calls happen: apply_record touches the RenderingServer only
	# after the record decoded and the stream accepted (and resolved) it.
	var result: Dictionary = _applier.apply_record(_data, Rs1Decoder.as_int(raw["offset"]), _stream)
	var errors: PackedStringArray = result["errors"]
	var record: Dictionary = result["record"]
	var meta: Dictionary = record["meta"]
	var kind: String = result["kind"]
	if errors.size() > 0:
		var seq: Variant = null
		if kind == "transaction" or kind == "":
			seq = Rs1Decoder.as_int(meta["seq"]) if Rs1Decoder.is_int(meta.get("seq")) else expected_seq
		_fail_with_error(seq, errors[0])
		return
	match kind:
		"transaction":
			var stats: Dictionary = result["stats"]
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
		"seq": Rs1Decoder.as_int(meta["seq"]),
		"frame": Rs1Decoder.as_int(meta["frame"]),
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
	var unsupported_commands: Array[Dictionary] = stats["unsupported_commands"]
	for command: Dictionary in unsupported_commands:
		_log("seq %d item %d: unsupported command %s logged, not drawn" % [seq, command["item"], command["name"]])
	var current: Dictionary[String, bool] = {}
	for value: Variant in meta["unsupported"]:
		var unsupported_entry: Dictionary = value
		var key: String = JSON.stringify([unsupported_entry["op"], unsupported_entry["item"], unsupported_entry["reason"]])
		current[key] = true
		if not _previous_unsupported.has(key):
			var item: Variant = null if unsupported_entry["item"] == null else Rs1Decoder.as_int(unsupported_entry["item"])
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


## Writes state/<name>.json: the resolved state just applied, in render-stream-1.md's resolved
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
	_state_paths[seq] = path
	_log("state seq %d -> %s" % [seq, path])
	return true


## "seq-<n>" (one stream). Live connections after the first get "stream-<k>-seq-<n>" (G1d).
func _seq_name(seq: int) -> String:
	return "seq-%d" % seq


## The resolved `state` object (render-stream-1.md "Decoded and resolved forms"): integers as
## ints, floats as float32 values, keys in the spec's order.
func _state_json(meta: Dictionary) -> Dictionary:
	var failures: Array = []
	for value: Variant in meta["failures"]:
		var failure: Dictionary = value
		failures.append({"reason": failure["reason"], "detail": failure["detail"]})
	var unsupported: Array = []
	for value: Variant in meta["unsupported"]:
		var entry: Dictionary = value
		var item: Variant = null if entry["item"] == null else Rs1Decoder.as_int(entry["item"])
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
			"items": Rs1Decoder.int_list(canvas["items"]),
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
			parent_out = {"kind": link["kind"], "id": Rs1Decoder.as_int(link["id"])}
		var commands: Array = []
		for value: Variant in item["commands"]:
			var command: Dictionary = value
			if command["op"] == "add_rect":
				commands.append({
					"op": "add_rect",
					"aa": command["aa"],
					"rect": _float_list(command["rect"]),
					"color": _float_list(command["color"]),
				})
			else:
				commands.append({"op": "unsupported", "name": command["name"]})
		items.append({
			"id": id,
			"origin": item["origin"],
			"parent": parent_out,
			"children": Rs1Decoder.int_list(item["children"]),
			"visible": item["visible"],
			"draw_index": Rs1Decoder.as_int(item["draw_index"]),
			"z_index": Rs1Decoder.as_int(item["z_index"]),
			"z_relative": item["z_relative"],
			"behind": item["behind"],
			"clip": item["clip"],
			"custom_rect": item["custom_rect"],
			"visibility_layer": Rs1Decoder.as_int(item["visibility_layer"]),
			"content_version": Rs1Decoder.as_int(item["content_version"]),
			"xform": _float_list(item["xform"]),
			"modulate": _float_list(item["modulate"]),
			"self_modulate": _float_list(item["self_modulate"]),
			"custom_rect_rect": _float_list(item["custom_rect_rect"]),
			"commands": commands,
		})
	return {
		"status": meta["status"],
		"failures": failures,
		"unsupported": unsupported,
		"canvases": canvases,
		"items": items,
	}


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
		"state_path": _state_paths.get(seq),
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
		if not _state_paths.has(seq):
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
	for variable: String in ["RS_RECEIVER_STALL", "RS_RECEIVER_RECONNECT", "RS_RECEIVER_RESYNC"]:
		if OS.get_environment(variable) != "":
			_log("error: %s is not implemented yet; it lands in G1d (gate1-design.md)" % variable)
			_quit(EXIT_USAGE)
			return
	_url = OS.get_environment("RS_RECEIVER_URL").strip_edges()
	if not (_url.begins_with("ws://127.0.0.1:") or _url.begins_with("ws://[::1]:")):
		_log("error: RS_RECEIVER_URL must be ws://127.0.0.1:<port>/... or ws://[::1]:<port>/... (loopback only; got %s)" % JSON.stringify(_url))
		_quit(EXIT_USAGE)
		return
	_shot_dir = _out_path.get_base_dir().path_join("shots")
	_state_dir = _out_path.get_base_dir().path_join("state")
	if not _parse_windows():
		_quit(EXIT_USAGE)
		return
	_received_path = OS.get_environment("RS_RECEIVER_RECEIVED_OUT")
	if _received_path == "":
		_received_path = _out_path.get_base_dir().path_join("received.rs1")
	elif not _received_path.is_absolute_path():
		_log("error: RS_RECEIVER_RECEIVED_OUT must be absolute (got %s)" % JSON.stringify(_received_path))
		_quit(EXIT_USAGE)
		return
	var inbound: int = _positive_env("RS_RECEIVER_INBOUND_BYTES", DEFAULT_INBOUND_BYTES)
	var timeout_ms: int = _positive_env("RS_RECEIVER_CONNECT_TIMEOUT", DEFAULT_CONNECT_TIMEOUT_MS)
	if inbound < 0 or timeout_ms < 0:
		_quit(EXIT_USAGE)
		return
	_inbound_bytes = inbound
	var stage: String = OS.get_environment("RS_RECEIVER_CREDIT_STAGE").strip_edges()
	if stage == "":
		stage = "submitted"
	if not RsLiveClient.CREDIT_STAGES.has(stage):
		_log("error: RS_RECEIVER_CREDIT_STAGE must be submitted or applied (got %s)" % JSON.stringify(stage))
		_quit(EXIT_USAGE)
		return
	var display_server: String = _init_report("live")
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
	_log("mode live, url %s, out %s, received %s, credit %s, inbound %d, windows %s, display %s" % [_url, _out_path, _received_path, _credit_stage, _inbound_bytes, JSON.stringify(_windows), display_server])
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
	var opened: Error = _client.open(_url, _inbound_bytes)
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


func _process_live() -> void:
	if _finished:
		return
	_client.poll()
	var state: WebSocketPeer.State = _client.state()
	match _live_phase:
		"connecting":
			if state == WebSocketPeer.STATE_OPEN:
				_live_phase = "streaming"
				_send(RsLiveClient.hello("gate1-receiver-%s" % DisplayServer.get_name(), _credit_stage, _inbound_bytes))
				_log("connected to %s (subprotocol %s); hello sent" % [_url, _client.peer.get_selected_protocol()])
			elif state == WebSocketPeer.STATE_CLOSED or Time.get_ticks_msec() > _deadline_msec:
				_fail(null, "live-connect-failed", "no open connection to %s (state %d, close code %d)" % [_url, state, _client.close_code()])
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
		var split: Dictionary = Rs1Decoder.split_records(message)
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
			seq = Rs1Decoder.as_int(meta["seq"]) if Rs1Decoder.is_int(meta.get("seq")) else expected_seq
		_fail_with_error(seq, errors[0])
		return
	if Rs1Decoder.as_int(record["byte_length"]) != message.size():
		_fail(null, "live-framing", "a message of %d bytes holds a %d-byte record; every message after the first is exactly one record" % [message.size(), Rs1Decoder.as_int(record["byte_length"])])
		return
	match kind:
		"transaction":
			var entry: Dictionary = _transaction_entry(FILE_STREAM, meta, record)
			entry["received_us"] = now_us
			_transactions.append(entry)
			var received_seq: int = entry["seq"]
			_send(RsLiveClient.ack(_stream_id, received_seq, "received", now_us))
			_acks_sent["received"] = Rs1Decoder.as_int(_acks_sent["received"]) + 1
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
	var stats: Dictionary = _applier.apply_state(_stream.canvases, _stream.items)
	var now_us: int = Time.get_ticks_usec()
	entry["applied_us"] = now_us
	_note_applied(entry, meta, stats)
	var seq: int = entry["seq"]
	_send(RsLiveClient.ack(_stream_id, seq, "applied", now_us))
	_acks_sent["applied"] = Rs1Decoder.as_int(_acks_sent["applied"]) + 1
	var step: int = -1
	var frame: int = entry["frame"]
	for window: Dictionary in _windows:
		if not window["shot"] and frame >= Rs1Decoder.as_int(window["from"]) and frame <= Rs1Decoder.as_int(window["to"]):
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
			"stream": FILE_STREAM,
			"seq": seq,
			"step": step,
			"path": path,
			"state_path": _state_paths.get(seq),
			"process_frame": Engine.get_process_frames(),
			"applied_through": _last_applied_seq,
		})
		_log("shot step %d seq %d frame %d -> %s" % [step, seq, Rs1Decoder.as_int(entry["frame"]), path])
	var now_us: int = Time.get_ticks_usec()
	entry["submitted_us"] = now_us
	_send(RsLiveClient.ack(_stream_id, seq, "submitted", now_us))
	_acks_sent["submitted"] = Rs1Decoder.as_int(_acks_sent["submitted"]) + 1
	_submit_pending = false


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
	if _applier != null:
		var floats: Array[float] = []
		for value: float in _applier.root_canvas_xform():
			floats.append(value)
		_viewport_report["canvas_transform"] = floats
	if _live:
		if _received_file != null:
			_received_file.flush()
		var sha256: String = Rs1Decoder.sha256_hex(_data)
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
