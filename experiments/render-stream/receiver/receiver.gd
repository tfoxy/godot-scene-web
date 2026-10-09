extends Node
## render-stream/0 receiver (gate0-design.md, "Q5. Receiver"). Its only input is a recording:
##
##   RS_RECEIVER_RECORDING  absolute .rs0 path (required)
##   RS_RECEIVER_OUT        absolute applied.json path (required); shots go to <dirname>/shots/
##   RS_RECEIVER_SHOT_SEQS  CSV of transaction seqs to screenshot (optional)
##
## One record is applied per _process frame. Every record is decoded and validated completely
## before Rs0Applier makes any RenderingServer call for it. A failure writes applied.json with
## status replay-failure and quits with 3. A clean end record writes status ok and quits with 0.
## A usage error (missing or malformed environment) quits with 2 and writes nothing.

const SCHEMA: String = "render-stream-receiver-applied/1"
const EXPECTED_SIZE: Vector2 = Vector2(640, 360)
const EXIT_OK: int = 0
const EXIT_USAGE: int = 2
const EXIT_REPLAY_FAILURE: int = 3

var _data := PackedByteArray()
var _records: Array[Dictionary] = []
var _next_record: int = 0
var _stream := Rs0Decoder.Stream.new()
var _applier: Rs0Applier
var _out_path: String = ""
var _shot_dir: String = ""
var _shot_seqs: Array[int] = []
var _busy: bool = false
var _finished: bool = false
var _last_applied_seq: int = 0
var _previous_unsupported: Dictionary[String, bool] = {}
var _report: Dictionary = {}
var _viewport_report: Dictionary = {}
var _transactions: Array[Dictionary] = []
var _shots: Array[Dictionary] = []
var _unsupported: Array[Dictionary] = []


func _ready() -> void:
	set_process(false)
	var recording_path: String = OS.get_environment("RS_RECEIVER_RECORDING")
	_out_path = OS.get_environment("RS_RECEIVER_OUT")
	if _out_path == "" or not _out_path.is_absolute_path():
		_log("error: RS_RECEIVER_OUT must be an absolute applied.json path (got %s)" % JSON.stringify(_out_path))
		_quit(EXIT_USAGE)
		return
	_shot_dir = _out_path.get_base_dir().path_join("shots")
	var seqs_text: String = OS.get_environment("RS_RECEIVER_SHOT_SEQS").strip_edges()
	if seqs_text != "":
		for part: String in seqs_text.split(","):
			var token: String = part.strip_edges()
			if not token.is_valid_int() or token.to_int() < 1:
				_log("error: RS_RECEIVER_SHOT_SEQS must be a CSV of seqs >= 1 (got %s)" % JSON.stringify(seqs_text))
				_quit(EXIT_USAGE)
				return
			_shot_seqs.append(token.to_int())

	var display_server: String = DisplayServer.get_name()
	var visible_size: Vector2 = get_viewport().get_visible_rect().size
	_viewport_report = {
		"display_server": display_server,
		"size": [visible_size.x, visible_size.y],
		"size_check": "skipped-headless" if display_server == "headless" else "ok",
		"canvas_transform": [],
	}
	_report = {
		"schema": SCHEMA,
		"recording": {"path": recording_path, "sha256": null, "bytes": null},
		"session_id": null,
		"status": "replay-failure",
		"failure": null,
		"end_seen": false,
		"viewport": _viewport_report,
		"transactions": _transactions,
		"shots": _shots,
		"unsupported": _unsupported,
	}
	_log("recording %s, out %s, shot seqs %s, display %s" % [recording_path, _out_path, str(_shot_seqs), display_server])

	if recording_path == "" or not recording_path.is_absolute_path() or not FileAccess.file_exists(recording_path):
		_fail(null, "recording-unreadable", "RS_RECEIVER_RECORDING is not an absolute path to an existing file: %s" % JSON.stringify(recording_path))
		return
	_data = FileAccess.get_file_as_bytes(recording_path)
	if _data.is_empty() and FileAccess.get_open_error() != OK:
		_fail(null, "recording-unreadable", "cannot read %s: %s" % [recording_path, error_string(FileAccess.get_open_error())])
		return
	_report["recording"] = {"path": recording_path, "sha256": Rs0Decoder.sha256_hex(_data), "bytes": _data.size()}

	# Framing first, over the whole file: a framing error stops everything before any RS call.
	var split: Dictionary = Rs0Decoder.split_records(_data)
	var split_errors: PackedStringArray = split["errors"]
	if split_errors.size() > 0:
		_fail_with_error(null, split_errors[0])
		return
	_records = split["records"]

	if display_server != "headless" and visible_size != EXPECTED_SIZE:
		_viewport_report["size_check"] = "mismatch"
		_fail(null, "viewport-mismatch", "visible rect size is %s, expected %s" % [str(visible_size), str(EXPECTED_SIZE)])
		return

	# The session: decoded, validated, then clear colour, canvas 1 and its transform and cull mask.
	_applier = Rs0Applier.new(get_viewport().get_viewport_rid(), get_viewport().find_world_2d().canvas)
	if _records.is_empty():
		_fail_with_error(null, Rs0Decoder.err("missing-session", "the recording has no records"))
		return
	var result: Dictionary = _apply_next()
	var errors: PackedStringArray = result["errors"]
	if errors.size() > 0:
		_fail_with_error(null, errors[0])
		return
	var record: Dictionary = result["record"]
	var meta: Dictionary = record["meta"]
	_report["session_id"] = meta["session_id"]
	_log("session %s applied (%d RS calls)" % [meta["session_id"], _applier.rs_calls])
	set_process(true)


func _process(_delta: float) -> void:
	if _busy or _finished:
		return
	if _next_record >= _records.size():
		_fail(null, "recording-incomplete", "the recording ends after %d records without an end record" % _records.size())
		return
	var expected_seq: int = _stream.expected_seq()
	var result: Dictionary = _apply_next()
	var errors: PackedStringArray = result["errors"]
	var record: Dictionary = result["record"]
	var meta: Dictionary = record["meta"]
	var kind: String = result["kind"]
	if errors.size() > 0:
		var seq: Variant = null
		if kind == "transaction" or kind == "":
			seq = Rs0Decoder.as_int(meta["seq"]) if Rs0Decoder.is_int(meta.get("seq")) else expected_seq
		_fail_with_error(seq, errors[0])
		return
	match kind:
		"transaction":
			var stats: Dictionary = result["stats"]
			_record_transaction(meta, record, stats)
		"end":
			_finish()


## Applies the next record through the applier; that call is the only place RS calls happen.
func _apply_next() -> Dictionary:
	var raw: Dictionary = _records[_next_record]
	_next_record += 1
	return _applier.apply_record(_data, Rs0Decoder.as_int(raw["offset"]), _stream)


func _record_transaction(meta: Dictionary, record: Dictionary, stats: Dictionary) -> void:
	var seq: int = Rs0Decoder.as_int(meta["seq"])
	_last_applied_seq = seq
	_transactions.append({
		"seq": seq,
		"frame": Rs0Decoder.as_int(meta["frame"]),
		"record_sha256": record["sha256"],
		"process_frame": Engine.get_process_frames(),
		"created": stats["created"],
		"freed": stats["freed"],
		"reparented": stats["reparented"],
		"commands_replayed": stats["commands_replayed"],
		"rs_calls": stats["rs_calls"],
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
			var item: Variant = null if entry["item"] == null else Rs0Decoder.as_int(entry["item"])
			_unsupported.append({"seq": seq, "item": item, "name": entry["op"], "reason": entry["reason"]})
			_log("seq %d: unsupported %s item %s (%s)" % [seq, entry["op"], str(item), entry["reason"]])
	_previous_unsupported = current

	if _shot_seqs.has(seq):
		if DisplayServer.get_name() == "headless":
			_fail(seq, "shot-unavailable", "a shot of seq %d was requested, but the display server is headless" % seq)
			return
		_busy = true
		RenderingServer.frame_post_draw.connect(_take_shot.bind(seq), CONNECT_ONE_SHOT)


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
		"seq": seq,
		"path": path,
		"process_frame": Engine.get_process_frames(),
		"applied_through": _last_applied_seq,
	})
	_log("shot seq %d -> %s (applied through %d)" % [seq, path, _last_applied_seq])
	_busy = false


func _finish() -> void:
	for seq: int in _shot_seqs:
		var taken: bool = false
		for shot: Dictionary in _shots:
			if shot["seq"] == seq:
				taken = true
		if not taken:
			_fail(seq, "shot-unavailable", "a shot of seq %d was requested, but the recording has no such transaction" % seq)
			return
	_report["status"] = "ok"
	_report["end_seen"] = true
	_write_report()
	_log("ok: %d transactions applied, %d shots, %d unsupported, %d RS calls" % [_transactions.size(), _shots.size(), _unsupported.size(), _applier.rs_calls])
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
		var xform: PackedFloat32Array = _applier.root_canvas_xform()
		var floats: Array[float] = []
		for value: float in xform:
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
		_applier.dispose()
	get_tree().quit(code)


func _log(text: String) -> void:
	print("[receiver] " + text)
