extends Node
## Frame-driven singleton controls and view-connection lifecycle checks.

var _api: Object = null
var _carrier: Object = null
var _texture: ImageTexture = null
var _material: ShaderMaterial = null
var _frame: int = 0
var _quit_frame: int = 900
var _events: Array[Dictionary] = []
var _refusals: Array[Dictionary] = []
var _timeouts: Array[String] = []
var _carrier_result: Dictionary = {"started": 0, "stopped": 0}
var _initial: Dictionary = {}
var _ptrcall: Dictionary = {}
var _registry_before_arm: Dictionary = {}
var _arm_failed_capture: Dictionary = {}
var _viewer: WebSocketPeer = null
var _hello_sent: bool = false
var _opened_script_peer: bool = false
var _hello_timeout: bool = false
var _armed_frame: int = -1
var _arm_call_frame: int = -1
var _arm_code: int = -1
var _written: bool = false
var _expect: String = ""
var _disarm_frame: int = -1
var _disarmed_frame: int = -1
var _last_process_us: int = 0
var _max_process_gap_us_disarming: int = 0
var _disarm_texture: ImageTexture = null

func _ready() -> void:
	_expect = OS.get_environment("RS_SWAP_EXPECT")
	var quit: String = OS.get_environment("RS_FIXTURE_QUIT_FRAME")
	if quit.is_valid_int():
		_quit_frame = quit.to_int()
	if not Engine.has_singleton("RenderStreamCapture"):
		_timeouts.append("RenderStreamCapture singleton missing")
		_finish()
		return
	_api = Engine.get_singleton("RenderStreamCapture")
	_initial = _api.call("state")
	if _initial.get("state") != "standby" or _initial.get("can_arm") != true:
		_timeouts.append("initial state is not armable standby")
	for event: String in ["armed", "disarmed", "arm_failed", "stream_ended"]:
		_api.connect(event, _one_signal.bind(event))
	for event: String in ["client_connected", "client_left"]:
		_api.connect(event, _two_signal.bind(event))
	_texture = ImageTexture.create_from_image(Image.create(8, 8, false, Image.FORMAT_RGBA8))
	_material = ShaderMaterial.new()
	var shader: Shader = Shader.new()
	shader.code = "shader_type canvas_item; void fragment() { COLOR = vec4(1.0); }"
	_material.shader = shader
	_material.get_rid()
	_carrier = ClassDB.instantiate("RenderStreamCarrier")
	_carrier_result["index"] = _carrier.call("register", "gdswap")
	_carrier.connect("started", _carrier_started)
	_carrier.connect("stopped", _carrier_stopped)
	_carrier.connect("close", _carrier_close)
	# Compile after runtime registration so native type annotations bind the ptrcall methods.
	var probe_script: GDScript = GDScript.new()
	probe_script.source_code = """extends RefCounted
func probe(api: RenderStreamCapture) -> Dictionary:
	var before: Dictionary = api.state()
	var disarm_default: int = api.disarm()
	var disarm_explicit: int = api.disarm({})
	var arm_invalid: int = api.arm({"GRC_ROOT_SIZE": "banana"})
	var after: Dictionary = api.state()
	return {"before": before, "after": after, "disarm_default": disarm_default,
		"disarm_explicit": disarm_explicit, "arm_invalid": arm_invalid}
"""
	var reload_code: Error = probe_script.reload()
	if reload_code != OK:
		_timeouts.append("ptrcall probe compile failed")
	else:
		var probe: RefCounted = probe_script.new()
		_ptrcall = probe.call("probe", _api)

func _carrier_started() -> void:
	_carrier_result["started"] += 1
	_carrier_result["started_frame"] = _frame

func _carrier_close(local: int, code: int, reason: String) -> void:
	_carrier.call("closed", local, code, reason)

func _carrier_stopped() -> void:
	_carrier_result["stopped"] += 1

func _record_signal(event: String, args: Array) -> void:
	var state: Dictionary = _api.call("state")
	_events.append({"event": event, "frame": _frame, "t_us": Time.get_ticks_usec(),
		"args": args, "state_at": state["state"]})

func _one_signal(arg: Variant, event: String) -> void:
	_record_signal(event, [arg])
	if event == "armed":
		_armed_frame = _frame
		_refusal("R8", "arm")
		_refusal("R6b", "disarm", {}, false, true)
	elif event == "disarmed":
		_disarmed_frame = _frame
		_refusal("R12", "arm")
		_refusal("R13", "disarm", {}, true)
		_viewer = null
	elif event == "arm_failed":
		_refusal("R12", "arm")
		_refusal("R13", "disarm", {}, true)
		# Observe standby before shutdown can stop resources left behind by rollback.
		var path: String = OS.get_environment("GRC_EVIDENCE_DIR").path_join("capture-api.json")
		var captured: Variant = JSON.parse_string(FileAccess.get_file_as_string(path))
		if captured is Dictionary:
			_arm_failed_capture = captured
		_finish()

func _two_signal(a: Variant, b: Variant, event: String) -> void:
	_record_signal(event, [a, b])
	if event == "client_connected":
		var info: Dictionary = b
		if info.get("carrier") == "ws" and not _opened_script_peer:
			_opened_script_peer = true
			_carrier_result["opened"] = _carrier.call("opened", 1, "render-stream.8", "")
			_carrier_result["third_opened"] = _carrier.call("opened", 2, "render-stream.8", "")
			var late: Object = ClassDB.instantiate("RenderStreamCarrier")
			_carrier_result["late_register"] = late.call("register", "gdlate")
	elif event == "client_left" and b == "hello-timeout":
		_hello_timeout = true

func _refusal(id: String, method: String, options: Dictionary = {}, no_arg: bool = false,
		on_thread: bool = false) -> void:
	var before: Dictionary = _api.call("state")
	var signal_count: int = _events.size()
	var code: int = -1
	if on_thread:
		var worker: Thread = Thread.new()
		var start_code: Error = worker.start(_thread_call.bind(method))
		if start_code != OK:
			_timeouts.append("Thread.start failed")
		else:
			code = worker.wait_to_finish()
	elif no_arg:
		code = _api.call(method)
	else:
		code = _api.call(method, options)
	var after: Dictionary = _api.call("state")
	_refusals.append({"id": id, "call": method, "code": code,
		"last_refusal": after["last_refusal"], "state_before": before["state"],
		"state_after": after["state"], "signals_during": _events.size() - signal_count})

func _thread_call(method: String) -> int:
	var code: int = _api.call(method, {})
	return code

func _process(_delta: float) -> void:
	_frame += 1
	var now_us: int = Time.get_ticks_usec()
	if _disarm_frame >= 0 and _disarmed_frame < 0 and _last_process_us != 0:
		_max_process_gap_us_disarming = maxi(_max_process_gap_us_disarming, now_us - _last_process_us)
	_last_process_us = now_us
	if _frame == 5 and _api != null:
		_refusal("R1", "disarm", {}, true)
		_refusal("R2", "arm", {"GRC_STREAM_VERSION": "9"})
		_refusal("R3", "arm", {"GRC_NOT_A_KNOB": "1"})
		_refusal("R4", "arm", {"GRC_ROOT_SIZE": "banana"})
		_refusal("R5", "arm", {"GRC_LIVE_MAX_CONNECTIONS": [2]})
		_refusal("R5b", "arm", {"GRC_LIVE_MAX_CONNECTIONS": "9"})
		_refusal("R6", "arm", {}, false, true)
	if _frame == 10 and _api != null:
		var state: Dictionary = _api.call("state")
		_registry_before_arm = state["registry"]
		_arm_call_frame = state["frame"]
		var options: Dictionary = {"GRC_ROOT_SIZE": "presentation:640x360", "GRC_LIVE_MAX_CONNECTIONS": 2}
		if _expect == "arm-failed":
			options = {}
		_arm_code = _api.call("arm", options)
		_record_signal("arm-returned", [_arm_code])
		_refusal("R7", "arm")
	if _api != null and _viewer == null and _disarm_frame < 0 and _expect != "arm-failed":
		var state: Dictionary = _api.call("state")
		if state.get("state") == "armed":
			_viewer = WebSocketPeer.new()
			_viewer.supported_protocols = PackedStringArray(["render-stream.8"])
			var listen: String = state.get("listen", "")
			var code: Error = _viewer.connect_to_url("ws://" + listen + "/render-stream")
			if code != OK:
				_timeouts.append("viewer connect failed")
	if _viewer != null and _disarm_frame < 0:
		_viewer.poll()
		if _viewer.get_ready_state() == WebSocketPeer.STATE_OPEN:
			if not _hello_sent:
				_hello_sent = true
				var hello: Dictionary = {"type": "hello", "protocol": "render-stream/8",
					"receiver": "live-swap-viewer", "receiver_kind": "gsw-canvas",
					"credit_stage": "submitted", "credit_window": 1, "inbound_buffer_bytes": 16777216,
					"token": null, "manifest_sha256": null, "presentation_backing_w": 640,
					"presentation_backing_h": 360, "presentation_css_w": 640,
					"presentation_css_h": 360, "dpr_milli": 1000}
				_viewer.send_text(JSON.stringify(hello, "", false))
			while _viewer.get_available_packet_count() > 0:
				_viewer.get_packet()
	if _armed_frame >= 0 and _hello_timeout and _frame >= _armed_frame + 65 and _disarm_frame < 0:
		_refusal("R14", "disarm", {"linger_ms": -1})
		_refusal("R15", "disarm", {"foo": 1})
		_disarm_texture = ImageTexture.create_from_image(Image.create(64, 64, false, Image.FORMAT_RGBA8))
		_disarm_frame = _frame
		var code: int = _api.call("disarm", {"reason": "fixture", "linger_ms": 300})
		_record_signal("disarm-returned", [code])
		_refusal("R10", "arm")
		_refusal("R11", "disarm", {}, true)
	if _disarmed_frame >= 0 and _frame >= _disarmed_frame + 30:
		_finish()
	if _frame == 190 and _armed_frame < 0:
		_timeouts.append("scheduled arm deadline")
		_finish()
	if _armed_frame >= 0 and not _hello_timeout and _frame >= _armed_frame + 240:
		_timeouts.append("hello-timeout deadline")
		_finish()
	if _disarm_frame >= 0 and _disarmed_frame < 0 and _frame >= _disarm_frame + 300:
		_timeouts.append("scheduled disarm deadline")
		_finish()
	if _frame >= _quit_frame:
		_timeouts.append("driver frame deadline")
		_finish()

func _finish() -> void:
	if _written:
		return
	_written = true
	var out: String = OS.get_environment("RS_SWAP_OUT")
	if out != "":
		DirAccess.make_dir_recursive_absolute(out)
		var file: FileAccess = FileAccess.open(out.path_join("driver.json"), FileAccess.WRITE)
		if file != null:
			file.store_string(JSON.stringify({"events": _events, "refusals": _refusals,
				"carrier": _carrier_result, "initial": _initial, "ptrcall": _ptrcall, "timeouts": _timeouts,
				"arm_call_frame": _arm_call_frame, "arm_code": _arm_code,
				"registry_before_arm": _registry_before_arm, "arm_failed_capture": _arm_failed_capture,
				"max_process_gap_us_disarming": _max_process_gap_us_disarming,
				"final": _api.call("state")}))
	get_tree().quit()
