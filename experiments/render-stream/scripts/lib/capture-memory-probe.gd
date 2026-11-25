extends Node2D
## Retain only GPU textures across the cycle; capture must read them back at arm.

var _api: Object
var _textures: Array[ImageTexture] = []
var _frame: int = 0
var _phase: String = "initial"
var _since: int = 0
var _idle_callbacks: int = 0
var _arm_start_us: int = 0
var _arm_to_armed_us: int = 0


func _ready() -> void:
	var status := GDExtensionManager.load_extension(OS.get_environment("GRC_EXTENSION"))
	if status != GDExtensionManager.LOAD_STATUS_OK:
		push_error("extension load failed: " + str(status))
		get_tree().quit(1)
		return
	_api = Engine.get_singleton("RenderStreamCapture")
	_api.connect("arm_failed", func(reason: Variant) -> void:
		push_error(str(reason))
		get_tree().quit(1))
	_api.connect("armed", func(_info: Dictionary) -> void:
		_arm_to_armed_us = Time.get_ticks_usec() - _arm_start_us
		_phase = "armed"
		_since = _frame)
	_api.connect("disarmed", func(_info: Dictionary) -> void: _phase = "detach")
	for i in range(12):
		var image: Image
		if OS.get_environment("GRC_TEST_MEMORY_COMPRESSED") == "1":
			# Constant opaque DXT5 blocks, distinct 565 endpoints for each texture.
			var blocks := PackedByteArray()
			blocks.resize(2048 * 2048)
			for block in range(0, blocks.size(), 16):
				blocks[block] = 255
				blocks[block + 1] = 255
				blocks[block + 8] = 31 + i * 32
				blocks[block + 9] = 120
			image = Image.create_from_data(2048, 2048, false, Image.FORMAT_DXT5, blocks)
		else:
			image = Image.create(2048, 2048, false, Image.FORMAT_RGBA8)
			image.fill(Color(float(i) / 12.0, 0.4, 0.8, 1))
		_textures.append(ImageTexture.create_from_image(image))
	queue_redraw()


func _draw() -> void:
	for i in range(_textures.size()):
		draw_texture_rect(_textures[i], Rect2(i * 20, 40, 16, 16), false)


func _sample(phase: String) -> bool:
	OS.set_environment("GRC_TEST_MEMORY_PHASE", phase)
	var state: Dictionary = _api.call("state")
	if phase == "armed":
		var file := FileAccess.open(OS.get_environment("GRC_EVIDENCE_DIR") + "/arm-timing.json", FileAccess.WRITE)
		# procfs reports a zero file size; stream a line instead of using get_as_text().
		var load_file := FileAccess.open("/proc/loadavg", FileAccess.READ)
		var loadavg := load_file.get_line() if load_file != null else "unavailable"
		file.store_string(JSON.stringify({"arm_to_armed_us": _arm_to_armed_us,
			"loadavg_at_armed": loadavg}))
		file.close()
		if state.get("state") != "armed":
			push_error("memory probe " + phase + ": state == armed failed: " + str(state.get("state")))
			get_tree().quit(1)
			return false
	else:
		if state.get("attachment_state") != "detached":
			push_error("memory probe " + phase + ": attachment_state == detached failed: " + str(state.get("attachment_state")))
			get_tree().quit(1)
			return false
		if state.get("table") != "lean":
			push_error("memory probe " + phase + ": table == lean failed: " + str(state.get("table")))
			get_tree().quit(1)
			return false
		if state.get("frame_callback_registered", true):
			push_error("memory probe " + phase + ": !frame_callback_registered failed: " + str(state.get("frame_callback_registered")))
			get_tree().quit(1)
			return false
	if phase == "detached" and int(state.get("frame_callbacks", -1)) != _idle_callbacks:
		push_error("memory probe " + phase + ": frame_callbacks == _idle_callbacks failed: " + str(state.get("frame_callbacks")) + " expected " + str(_idle_callbacks))
		get_tree().quit(1)
		return false
	print("memory probe ", phase, ": state=", state.get("state"),
		" attachment=", state.get("attachment_state"), " table=", state.get("table"),
		" callbacks=", state.get("frame_callbacks"))
	return true


func _process(_delta: float) -> void:
	_frame += 1
	if _phase == "initial" and _frame == 120:
		if not _sample("lean"):
			return
		_invoke("attach", {})
		_phase = "arming"
		_arm_start_us = Time.get_ticks_usec()
		_invoke("arm", {})
	elif _phase == "armed" and _frame >= _since + 60:
		if not _sample("armed"):
			return
		_phase = "disarming"
		_invoke("disarm", {"linger_ms": 0})
	elif _phase == "detach":
		_invoke("detach", {})
		var state: Dictionary = _api.call("state")
		_idle_callbacks = int(state.get("frame_callbacks", -1))
		_phase = "idle"
		_since = _frame
	elif _phase == "idle" and _frame >= _since + 60:
		if not _sample("detached"):
			return
		get_tree().quit()
	if _frame > 3600:
		push_error("memory probe deadline: " + _phase)
		get_tree().quit(1)


func _invoke(method: String, options: Dictionary) -> void:
	var status: int = _api.call(method, options)
	if status != 0:
		push_error(method + " failed: " + str(status))
		get_tree().quit(1)
