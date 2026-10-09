extends Node
## render-stream/1 receiver (gate0-design.md "Q5. Receiver", extended by gate1-design.md "Q5.
## Receiver" and "G1b2"). Its only input is a recording:
##
##   RS_RECEIVER_MODE        "file" (default when unset); "live" lands in G1c2
##   RS_RECEIVER_RECORDING   absolute .rs1 path (required)
##   RS_RECEIVER_OUT         absolute applied.json path (required); shots go to <dirname>/shots/,
##                           state dumps to <dirname>/state/
##   RS_RECEIVER_SHOT_SEQS   CSV of transaction seqs to screenshot (optional)
##   RS_RECEIVER_STATE_SEQS  CSV of transaction seqs whose resolved state is dumped (optional)
##
## The whole file is framed first. The session is applied in _ready, then one record per _process
## frame. Every record is decoded and validated completely (Rs1Decoder.decode_record, then
## Rs1Decoder.Stream.accept, which resolves patches) before RsApplier makes any RenderingServer
## call for it; the applier then reconciles the RESOLVED state with its own mirror. A failure
## writes applied.json with status replay-failure and quits with 3. A clean end record writes
## status ok and quits with 0. A usage error (missing or malformed environment, or an unsupported
## mode) quits with 2 and writes nothing.

const SCHEMA: String = "render-stream-receiver-applied/2"
const EXIT_OK: int = 0
const EXIT_USAGE: int = 2
const EXIT_REPLAY_FAILURE: int = 3
## File mode carries exactly one stream; transactions and shots name it as stream 1.
const FILE_STREAM: int = 1

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


func _ready() -> void:
	set_process(false)
	var mode: String = OS.get_environment("RS_RECEIVER_MODE").strip_edges()
	if mode == "live":
		_log("error: RS_RECEIVER_MODE=live is not implemented yet; live mode lands in G1c2 (gate1-design.md)")
		_quit(EXIT_USAGE)
		return
	if mode != "" and mode != "file":
		_log("error: RS_RECEIVER_MODE must be file or live (got %s); live mode lands in G1c2" % JSON.stringify(mode))
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
		"mode": "file",
		"recording": {"path": _recording_path, "sha256": null, "bytes": null},
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

	# The session: decoded and validated, then the size check, then clear colour, canvas 1 and
	# its transform and cull mask.
	_applier = RsApplier.new(get_viewport().get_viewport_rid(), get_viewport().find_world_2d().canvas)
	var accepted: Dictionary = _accept_next()
	var errors: PackedStringArray = accepted["errors"]
	if errors.size() > 0:
		_fail_with_error(null, errors[0])
		return
	var record: Dictionary = accepted["record"]
	var meta: Dictionary = record["meta"]
	_report["session_id"] = meta["session_id"]
	var stream_meta: Dictionary = meta["stream"]
	_stream_report["stream_id"] = stream_meta["stream_id"]
	var session_viewport: Dictionary = meta["viewport"]
	var logical: Array = session_viewport["logical_size"]
	var logical_size := Vector2(Rs1Decoder.as_int(logical[0]), Rs1Decoder.as_int(logical[1]))
	_viewport_report["logical_size"] = [int(logical_size.x), int(logical_size.y)]
	if display_server != "headless":
		if visible_size != logical_size:
			_viewport_report["size_check"] = "mismatch"
			_fail(null, "viewport-mismatch", "visible rect size is %s, the session's logical_size is %s" % [str(visible_size), str(logical_size)])
			return
		_viewport_report["size_check"] = "ok"
	var blocks: Array[PackedFloat32Array] = record["blocks"]
	_applier.begin_session(meta, blocks)
	_log("session %s stream %s (%s) applied (%d RS calls)" % [meta["session_id"], stream_meta["stream_id"], stream_meta["encoding"], _applier.rs_calls])
	set_process(true)


func _process(_delta: float) -> void:
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


## Decodes and validates the next record without touching the RenderingServer.
func _accept_next() -> Dictionary:
	var raw: Dictionary = _records[_next_record]
	_next_record += 1
	return RsApplier.accept_record(_data, Rs1Decoder.as_int(raw["offset"]), _stream)


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


func _record_transaction(meta: Dictionary, record: Dictionary, stats: Dictionary) -> void:
	var seq: int = Rs1Decoder.as_int(meta["seq"])
	_last_applied_seq = seq
	_transactions.append({
		"stream": FILE_STREAM,
		"seq": seq,
		"frame": Rs1Decoder.as_int(meta["frame"]),
		"encoding": meta["encoding"],
		"record_sha256": record["sha256"],
		"process_frame": Engine.get_process_frames(),
		"created": stats["created"],
		"freed": stats["freed"],
		"reparented": stats["reparented"],
		"commands_replayed": stats["commands_replayed"],
		"rs_calls": stats["rs_calls"],
		"received_us": null,
		"applied_us": null,
		"submitted_us": null,
		"skipped": null,
	})
	var unsupported_commands: Array[Dictionary] = stats["unsupported_commands"]
	for command: Dictionary in unsupported_commands:
		_log("seq %d item %d: unsupported command %s logged, not drawn" % [seq, command["item"], command["name"]])

	# Report each top-level unsupported entry that is new since the previous transaction.
	var current: Dictionary[String, bool] = {}
	for value: Variant in meta["unsupported"]:
		var entry: Dictionary = value
		var key: String = JSON.stringify([entry["op"], entry["item"], entry["reason"]])
		current[key] = true
		if not _previous_unsupported.has(key):
			var item: Variant = null if entry["item"] == null else Rs1Decoder.as_int(entry["item"])
			_unsupported.append({"seq": seq, "item": item, "name": entry["op"], "reason": entry["reason"]})
			_log("seq %d: unsupported %s item %s (%s)" % [seq, entry["op"], str(item), entry["reason"]])
	_previous_unsupported = current

	if _state_seqs.has(seq) and not _dump_state(seq, meta):
		return

	if _shot_seqs.has(seq):
		if DisplayServer.get_name() == "headless":
			_fail(seq, "shot-unavailable", "a shot of seq %d was requested, but the display server is headless" % seq)
			return
		_busy = true
		RenderingServer.frame_post_draw.connect(_take_shot.bind(seq), CONNECT_ONE_SHOT)


## Writes state/seq-<seq>.json: the resolved state just applied, in render-stream-1.md's resolved
## `state` shape and key order. Returns false (after failing the replay) when it cannot write.
func _dump_state(seq: int, meta: Dictionary) -> bool:
	var path: String = _state_dir.path_join("seq-%d.json" % seq)
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


func _take_shot(seq: int) -> void:
	if _finished:
		return
	var image: Image = get_viewport().get_texture().get_image()
	var path: String = _shot_dir.path_join("seq-%d.png" % seq)
	var made: Error = DirAccess.make_dir_recursive_absolute(_shot_dir)
	if image == null or made != OK:
		_fail(seq, "shot-failed", "no image or no shot directory (%s)" % error_string(made))
		return
	var saved: Error = image.save_png(path)
	if saved != OK:
		_fail(seq, "shot-failed", "save_png(%s) failed: %s" % [path, error_string(saved)])
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


func _fail_with_error(seq: Variant, error: String) -> void:
	var colon: int = error.find(": ")
	if colon < 0:
		_fail(seq, error, "")
	else:
		_fail(seq, error.substr(0, colon), error.substr(colon + 2))


func _fail(seq: Variant, reason: String, detail: String) -> void:
	_report["status"] = "replay-failure"
	_report["failure"] = {"seq": seq, "reason": reason, "detail": detail}
	_write_report()
	_log("replay-failure: seq %s %s: %s" % [str(seq), reason, detail])
	_quit(EXIT_REPLAY_FAILURE)


func _write_report() -> void:
	if _applier != null:
		var floats: Array[float] = []
		for value: float in _applier.root_canvas_xform():
			floats.append(value)
		_viewport_report["canvas_transform"] = floats
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
	if _applier != null:
		var freed: int = _applier.dispose()
		_log("disposed: %d RIDs freed" % freed)
	get_tree().quit(code)


func _log(text: String) -> void:
	print("[receiver] " + text)
