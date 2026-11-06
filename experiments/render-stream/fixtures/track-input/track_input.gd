extends Node
## TRK2 track receiver autoload (`TrackInput`; tracks-design.md Q6, "As built (TRK2)"): binds the
## `input` track kind through the capture's RenderStreamTrack class and wires it to the gsw-input/1
## reference injector, exactly as the design's example does:
##
##   track.connect("message", func(source, text): injector.receive(source, text))
##   track.connect("closed", func(source, _code, _reason): injector.close_channel(source))
##
## Everything it sees goes to RS_TRACK_INPUT_LOG, one JSON object per line, flushed per line so
## gate 8's Node track client (scripts/lib/track-input-client.ts) can wait on it: the class
## contract before the arm (bind refusals, status), each signal with the process frame it ran in,
## and every change of the watched Input state (keys W, A, S and the left mouse button) with the
## frame `_process` saw it in, plus the test Control's gui_input mouse buttons. It never logs a
## payload, only its size and the injector's result.
##
## The client steers it through files in RS_TRACK_INPUT_CONTROL: `unbind` makes it unbind (the
## no-receiver phase), `quit` ends the run. RS_FIXTURE_QUIT_FRAME is the backstop.
##
## Fixture sabotages (RS_TRACK_INPUT_SABOTAGE), each for one g8l-trk check to catch:
##   drop-messages  message payloads never reach the injector      (g8l-trk-delivered)
##   keep-held      closed() never calls close_channel             (g8l-trk-release-on-idle)
##   stay-bound     the `unbind` request is ignored                (g8l-trk-no-receiver)
## The capture's own GRC_SABOTAGE=track-no-release is g8l-trk-release-on-kill's.

const KIND: String = "input"
const FORMAT: String = "gsw-input/1"
const WATCHED_KEYS: Array[int] = [KEY_W, KEY_A, KEY_S]

var _track: Object = null
var _host: GswInputInjectorNode = null
var _log: FileAccess = null
var _control_dir: String = ""
var _sabotage: String = ""
var _quit_frame: int = 3600
var _frame: int = 0
var _status: String = ""
var _keys: Dictionary = {}
var _mouse_left: bool = false
var _unbound: bool = false
var _target_connected: bool = false


func _ready() -> void:
	process_mode = Node.PROCESS_MODE_ALWAYS
	var path: String = OS.get_environment("RS_TRACK_INPUT_LOG")
	if path != "":
		_log = FileAccess.open(path, FileAccess.WRITE)
	_control_dir = OS.get_environment("RS_TRACK_INPUT_CONTROL")
	_sabotage = OS.get_environment("RS_TRACK_INPUT_SABOTAGE")
	var quit: String = OS.get_environment("RS_FIXTURE_QUIT_FRAME")
	if quit.is_valid_int():
		_quit_frame = quit.to_int()
	for key: int in WATCHED_KEYS:
		_keys[key] = false
	_host = GswInputInjectorNode.new()
	_host.name = "GswInputInjectorNode"
	add_child(_host)
	if not ClassDB.class_exists("RenderStreamTrack"):
		_write({"ev": "class", "exists": false})
		return
	_track = ClassDB.instantiate("RenderStreamTrack")
	_contract()
	_track.connect("opened", _on_opened)
	_track.connect("message", _on_message)
	_track.connect("closed", _on_closed)


## The class contract before the arm: refusals and status, then the real bind.
func _contract() -> void:
	var facts: Dictionary = {"ev": "contract", "exists": true, "sabotage": _sabotage}
	facts["status_unbound"] = _call_string(_track, "status")
	facts["bad_kind"] = _bind_fact(_track, "Input!", PackedStringArray([FORMAT]))
	facts["bad_formats"] = _bind_fact(_track, KIND, PackedStringArray(["not a format"]))
	facts["no_formats"] = _bind_fact(_track, KIND, PackedStringArray())
	facts["bound"] = _bind_fact(_track, KIND, PackedStringArray([FORMAT]))
	facts["again"] = _bind_fact(_track, KIND, PackedStringArray([FORMAT]))
	var other: Object = ClassDB.instantiate("RenderStreamTrack")
	facts["other"] = _bind_fact(other, KIND, PackedStringArray([FORMAT]))
	facts["status_bound"] = _call_string(_track, "status")
	var closed: bool = _track.call("close", 1, 1000, "kicked")
	facts["close_reason_refused"] = not closed and _call_string(_track, "last_error") == "track-close-invalid"
	var sent: bool = _track.call("send", 1, "x")
	facts["send_unknown_refused"] = not sent and _call_string(_track, "last_error") == "track-source-unknown"
	var sources: PackedInt64Array = _track.call("sources")
	facts["sources_empty"] = sources.is_empty()
	_write(facts)


func _bind_fact(track: Object, kind: String, formats: PackedStringArray) -> Dictionary:
	var ok: bool = track.call("bind", kind, formats)
	return {"ok": ok, "error": _call_string(track, "last_error")}


func _call_string(target: Object, method: String) -> String:
	var value: String = target.call(method)
	return value


func _on_opened(source: int, info: Dictionary) -> void:
	var listed: PackedInt64Array = _track.call("sources")
	var queried: Dictionary = _track.call("info", source)
	_write({"ev": "opened", "source": source, "info": info, "sources": Array(listed), "info_call": queried})


func _on_message(source: int, text: String) -> void:
	var result: String = "sabotaged"
	if _sabotage != "drop-messages":
		result = _host.injector.receive(source, text)
	_write({"ev": "message", "source": source, "bytes": text.to_utf8_buffer().size(), "result": result})


func _on_closed(source: int, code: int, reason: String) -> void:
	if _sabotage != "keep-held":
		_host.injector.close_channel(source)
	_write({"ev": "closed", "source": source, "code": code, "reason": reason})


func _process(_delta: float) -> void:
	_frame += 1
	if not _target_connected:
		var scene: Node = get_tree().current_scene
		var target: Control = scene.get_node_or_null("Target") as Control if scene != null else null
		if target != null:
			target.gui_input.connect(_on_target_input)
			_target_connected = true
	if _track != null:
		var status: String = _call_string(_track, "status")
		if status != _status:
			_status = status
			_write({"ev": "status", "status": status})
	for key: int in WATCHED_KEYS:
		var pressed: bool = Input.is_physical_key_pressed(key)
		if pressed != _keys[key]:
			_keys[key] = pressed
			_write({"ev": "key", "key": key, "pressed": pressed})
	var left: bool = Input.is_mouse_button_pressed(MOUSE_BUTTON_LEFT)
	if left != _mouse_left:
		_mouse_left = left
		_write({"ev": "mouse", "button": MOUSE_BUTTON_LEFT, "pressed": left})
	if _control_dir != "":
		if not _unbound and FileAccess.file_exists(_control_dir.path_join("unbind")):
			_unbound = true
			if _sabotage != "stay-bound" and _track != null:
				_track.call("unbind")
			_write({"ev": "unbound", "status": _call_string(_track, "status") if _track != null else ""})
		if FileAccess.file_exists(_control_dir.path_join("quit")):
			_finish("control")
			return
	if _frame >= _quit_frame:
		_finish("quit-frame")


func _on_target_input(event: InputEvent) -> void:
	var button: InputEventMouseButton = event as InputEventMouseButton
	if button == null:
		return
	_write({
		"ev": "gui",
		"button": button.button_index,
		"pressed": button.pressed,
		"position": [button.position.x, button.position.y],
		"global": [button.global_position.x, button.global_position.y],
	})


func _finish(why: String) -> void:
	var stats: Dictionary = _track.call("stats") if _track != null else {}
	_write({
		"ev": "end",
		"why": why,
		"status": _call_string(_track, "status") if _track != null else "",
		"stats": stats,
		"injector": _host.injector.stats(),
	})
	set_process(false)
	get_tree().quit()


func _write(line: Dictionary) -> void:
	line["frame"] = Engine.get_process_frames()
	line["ms"] = Time.get_ticks_msec()
	print("[track-input] %s" % JSON.stringify(line))
	if _log != null:
		_log.store_line(JSON.stringify(line))
		_log.flush()
