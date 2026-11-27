extends SceneTree
## Fake-clock cadence, atomic replacement on Linux, notification snapshots and normal exit.

class View extends "res://receiver.gd":
	var exit_code: int = -1
	var short_write: bool = false

	func _staged_bytes(path: String) -> int:
		return FileAccess.get_size(path) - (1 if short_write else 0)

	func _ready() -> void:
		set_process(false)

	func _quit(code: int) -> void:
		_finished = true
		exit_code = code

var _checks: int = 0
var _failed: int = 0


func _initialize() -> void:
	_run.call_deferred()


func _check(label: String, ok: Variant) -> void:
	_checks += 1
	if not ok:
		_failed += 1
		print("[perf-flush-selftest] FAIL: " + label)


func _snapshot(path: String, final: bool, count: int) -> void:
	var parsed: Variant = JSON.parse_string(FileAccess.get_file_as_string(path))
	_check("complete JSON", parsed is Dictionary)
	if not parsed is Dictionary:
		return
	var doc: Dictionary = parsed
	_check("schema", doc.get("schema") == "render-stream-receiver-perf/1")
	_check("final flag", doc.get("final") == final)
	_check("latest histogram replaced prior document", RsWire.as_int(doc["histograms"]["decode_us"]["count"]) == count)
	_check("temporary file renamed", not FileAccess.file_exists(path + ".tmp"))


func _run() -> void:
	var base: String = ProjectSettings.globalize_path("res://../../../.local/perf-flush-%d" % OS.get_process_id())
	var path: String = base.path_join("perf.json")
	var settings: Dictionary = {
		"RS_RECEIVER_OUT": base.path_join("applied.json"),
		"RS_RECEIVER_MODE": "live",
		"RS_RECEIVER_URL": "ws://127.0.0.1:1/render-stream",
		"RS_RECEIVER_PROTOCOL": "6",
		"RS_RECEIVER_RECEIVED_MAX_BYTES": "0",
		"RS_RECEIVER_PERF_OUT": path,
		"RS_RECEIVER_PERF_FLUSH_MS": "",
	}
	var saved: Dictionary = {}
	for key: String in settings:
		saved[key] = OS.get_environment(key) if OS.has_environment(key) else null
		OS.set_environment(key, str(settings[key]))
	var view := View.new()
	root.add_child(view)
	await view._ready_live()
	view.set_process(false)
	_check("startup", view.exit_code == -1)
	_check("default flush interval", view.get("_perf_flush_ms") == 10000)
	var data: PackedByteArray = FileAccess.get_file_as_bytes("res://../protocol/golden-6/inline.rs6")
	var records: Array[Dictionary] = RsWire.split_records(data, 6)["records"]
	view._receive_binary(data.slice(0, 8 + RsWire.as_int(records[0]["byte_length"])))
	view.set("_perf_flush_ms", 10)
	view.set("_perf_flush_due_ms", 10)
	view._maybe_flush_perf(9)
	_check("not early", not FileAccess.file_exists(path))
	view._maybe_flush_perf(10)
	_snapshot(path, false, 0)
	var perf: RsPerf = view.get("_perf")
	perf.decode_us.add(42)
	view._maybe_flush_perf(19)
	_snapshot(path, false, 0)
	view._maybe_flush_perf(20)
	_snapshot(path, false, 1)
	perf.decode_us.add(43)
	view._maybe_flush_perf(55)
	_snapshot(path, false, 2)
	_check("late frame schedules one interval ahead", view.get("_perf_flush_due_ms") == 65)
	view.set("_perf_flush_ms", 0)
	perf.decode_us.add(44)
	view._maybe_flush_perf(999)
	_snapshot(path, false, 2)
	view._notification(Node.NOTIFICATION_APPLICATION_PAUSED)
	_snapshot(path, false, 3)
	perf.decode_us.add(45)
	view._notification(Node.NOTIFICATION_WM_CLOSE_REQUEST)
	_snapshot(path, false, 4)
	var previous: PackedByteArray = FileAccess.get_file_as_bytes(path)
	view.short_write = true
	perf.decode_us.add(46)
	view._write_perf_report(false)
	_check("short write preserves snapshot bytes", FileAccess.get_file_as_bytes(path) == previous)
	_snapshot(path, false, 4)
	view.short_write = false
	view._finish_live()
	_check("normal exit code", view.exit_code == 0)
	_snapshot(path, true, 5)
	view._notification(Node.NOTIFICATION_APPLICATION_PAUSED)
	view._maybe_flush_perf(9999)
	_snapshot(path, true, 5)
	var client: RsLiveClient = view.get("_client")
	client.close(1000, "selftest")
	view._dispose_applier()
	view.free()
	for text: String in ["oops", "-1", "1.5"]:
		OS.set_environment("RS_RECEIVER_PERF_FLUSH_MS", text)
		var invalid := View.new()
		_check("reject malformed flush interval " + text, not invalid._parse_perf_env())
		invalid.free()
	OS.set_environment("RS_RECEIVER_PERF_FLUSH_MS", "0")
	var disabled := View.new()
	_check("zero disables interval", disabled._parse_perf_env() and disabled.get("_perf_flush_ms") == 0)
	disabled.free()
	for key: String in saved:
		if saved[key] == null:
			OS.unset_environment(key)
		else:
			OS.set_environment(key, str(saved[key]))
	print("[perf-flush-selftest] %d checks, %d failed" % [_checks, _failed])
	quit(0 if _failed == 0 else 1)
