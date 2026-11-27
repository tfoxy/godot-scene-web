extends SceneTree
## Headless live apply plus a fake clock: join excluded, first apply starts one session timer.

class View extends "res://receiver.gd":
	var exit_code: int = -1

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
		print("[live-quit-selftest] FAIL: " + label)


func _run() -> void:
	var base: String = ProjectSettings.globalize_path("res://../../../.local/live-quit-%d" % OS.get_process_id())
	var settings: Dictionary = {
		"RS_RECEIVER_OUT": base.path_join("applied.json"),
		"RS_RECEIVER_MODE": "live",
		"RS_RECEIVER_URL": "ws://127.0.0.1:1/render-stream",
		"RS_RECEIVER_PROTOCOL": "6",
		"RS_RECEIVER_RECEIVED_MAX_BYTES": "0",
		"RS_RECEIVER_PERF_OUT": base.path_join("perf.json"),
		"RS_RECEIVER_QUIT_AFTER_S": "2",
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
	_check("parsed seconds", view.get("_quit_after_s") == 2)
	_check("join does not count", not view._maybe_finish_live(999999999))
	var data: PackedByteArray = FileAccess.get_file_as_bytes("res://../protocol/golden-6/inline.rs6")
	var records: Array[Dictionary] = RsWire.split_records(data, 6)["records"]
	view._receive_binary(data.slice(0, 8 + RsWire.as_int(records[0]["byte_length"])))
	_check("session alone does not start timer", view.get("_live_first_applied_us") == -1)
	for index: int in range(1, records.size()):
		var record: Dictionary = records[index]
		var start: int = RsWire.as_int(record["offset"])
		view._receive_binary(data.slice(start, start + RsWire.as_int(record["byte_length"])))
		var waiting: Array = view.get("_waiting")
		if not waiting.is_empty():
			view._apply_newest()
			break
	var first_us: int = view.get("_live_first_applied_us")
	_check("successful transaction starts timer", first_us >= 0 and view.get("_last_applied_seq") == 1)
	view._note_live_applied(first_us + 1000000)
	_check("later applies keep original start", view.get("_live_first_applied_us") == first_us)
	view.set("_quit_after_s", 0)
	_check("zero disables timer", not view._maybe_finish_live(first_us + 9000000))
	view.set("_quit_after_s", 2)
	_check("not before duration", not view._maybe_finish_live(first_us + 1999999))
	_check("ends at duration", view._maybe_finish_live(first_us + 2000000))
	_check("normal exit code", view.exit_code == 0)
	var applied: Dictionary = JSON.parse_string(FileAccess.get_file_as_string(base.path_join("applied.json")))
	var perf: Dictionary = JSON.parse_string(FileAccess.get_file_as_string(base.path_join("perf.json")))
	_check("successful applied report", applied.get("status") == "ok")
	_check("final perf report", perf.get("final") == true)
	_check("ends only once", not view._maybe_finish_live(first_us + 3000000))
	view._dispose_applier()
	view.free()
	for text: String in ["-1", "oops", "1.5"]:
		OS.set_environment("RS_RECEIVER_QUIT_AFTER_S", text)
		var invalid := View.new()
		_check("reject malformed duration " + text, not invalid._parse_perf_env())
		invalid.free()
	for key: String in saved:
		if saved[key] == null:
			OS.unset_environment(key)
		else:
			OS.set_environment(key, str(saved[key]))
	print("[live-quit-selftest] %d checks, %d failed" % [_checks, _failed])
	quit(0 if _failed == 0 else 1)
