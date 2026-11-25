extends SceneTree
## Live startup, reconnect and reporting with disabled, bounded and unlimited byte mirrors.

class View extends "res://receiver.gd":
	var exit_code: int = -1

	func _ready() -> void:
		set_process(false)

	func _quit(code: int) -> void:
		exit_code = code

var _checks: int = 0
var _failed: int = 0


func _initialize() -> void:
	_run.call_deferred()


func _check(label: String, ok: Variant) -> void:
	_checks += 1
	if not ok:
		_failed += 1
		print("[received-selftest] FAIL: " + label)


func _run() -> void:
	var base: String = ProjectSettings.globalize_path("res://../../../.local/received-selftest")
	var data: PackedByteArray = FileAccess.get_file_as_bytes("res://../protocol/golden-6/inline.rs6")
	var records: Array[Dictionary] = RsWire.split_records(data, 6)["records"]
	var session: PackedByteArray = data.slice(0, 8 + RsWire.as_int(records[0]["byte_length"]))
	var saved: Dictionary = {}
	var settings: Dictionary = {
		"RS_RECEIVER_OUT": base.path_join("applied.json"),
		"RS_RECEIVER_URL": "ws://127.0.0.1:1/render-stream",
		"RS_RECEIVER_PROTOCOL": "6",
		"RS_RECEIVER_RECEIVED_OUT": "",
		"RS_RECEIVER_RECEIVED_MAX_BYTES": "",
	}
	for key: String in settings:
		saved[key] = OS.get_environment(key) if OS.has_environment(key) else null
		OS.set_environment(key, str(settings[key]))
	for cap: int in [0, session.size(), -1]:
		var path: String = base.path_join("cap-%d.rs2" % cap)
		var next_path: String = base.path_join("cap-%d-2.rs2" % cap)
		for old: String in [path, next_path]:
			if FileAccess.file_exists(old):
				DirAccess.remove_absolute(old)
		OS.set_environment("RS_RECEIVER_RECEIVED_OUT", path)
		OS.set_environment("RS_RECEIVER_RECEIVED_MAX_BYTES", "" if cap < 0 else str(cap))
		var view := View.new()
		root.add_child(view)
		await view._ready_live()
		_check("startup cap %d" % cap, view.exit_code == -1)
		view._receive_binary(session)
		view._write_report()
		_check_report(view, path, cap, session)
		view.set("_reconnect_record", {})
		view._start_next_connection()
		_check("reconnect cap %d" % cap, view.exit_code == -1)
		var streams: Array = view.get("_streams")
		_check("closed stream hash cap %d" % cap, streams[0]["received_sha256"] == ("".sha256_text() if cap == 0 else RsWire.sha256_hex(session)))
		view._receive_binary(session)
		view._write_report()
		_check_report(view, next_path, cap, session)
		var file: FileAccess = view.get("_received_file")
		if file != null:
			file.close()
		view.set("_received_file", null)
		var client: RsLiveClient = view.get("_client")
		client.close(1000, "selftest")
		view._dispose_applier()
		view.free()
	for key: String in saved:
		if saved[key] == null:
			OS.unset_environment(key)
		else:
			OS.set_environment(key, str(saved[key]))
	print("[received-selftest] %d checks, %d failed" % [_checks, _failed])
	quit(0 if _failed == 0 else 1)


func _check_report(view: Node, path: String, cap: int, session: PackedByteArray) -> void:
	var report: Dictionary = JSON.parse_string(FileAccess.get_file_as_string(str(view.get("_out_path"))))
	var streams: Array = report["streams"]
	var stream: Dictionary = streams.back()
	_check("received path preserved", stream["received_path"] == path)
	var expected: PackedByteArray = PackedByteArray() if cap == 0 else session
	_check("received hash cap %d" % cap, stream["received_sha256"] == ("".sha256_text() if cap == 0 else RsWire.sha256_hex(expected)))
	_check("received count cap %d" % cap, RsWire.as_int(stream["received_bytes"]) == session.size())
	_check("file existence cap %d" % cap, FileAccess.file_exists(path) == (cap != 0))
	if cap != 0:
		_check("received bytes exact", FileAccess.get_file_as_bytes(path) == expected)
