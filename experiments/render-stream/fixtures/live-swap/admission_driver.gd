extends Node
## Deterministic loader admission probes: release files end each bounded native hold.

const CODE_A: String = "shader_type canvas_item; void fragment() { COLOR = vec4(0.25); }"
const CODE_B: String = "shader_type canvas_item; void fragment() { COLOR = vec4(0.75); }"
var _api: Object
var _shader: RID
var _freed: RID
var _material: RID
var _rect: ColorRect
var _worker: Thread
var _texture_worker: Thread
var _texture: RID
var _image: Image
var _free_worker: Thread
var _frame: int = 0
var _phase: String = "start"
var _since: int = 0
var _counted: bool = false
var _fault: bool = false
var _events: Array[Dictionary] = []
var _timeouts: Array[String] = []
var _held_at_arm2: bool = false
var _held_at_release: bool = false
var _dir: String

func _ready() -> void:
	_api = Engine.get_singleton("RenderStreamCapture")
	_dir = OS.get_environment("GRC_EVIDENCE_DIR")
	_counted = OS.get_environment("RS_SWAP_ADMISSION") == "counted"
	_fault = OS.get_environment("GRC_REARM_FAULT") == "standby-view-off"
	_image = Image.create(4, 4, false, Image.FORMAT_RGBA8)
	_shader = RenderingServer.shader_create()
	RenderingServer.shader_set_code(_shader, CODE_A)
	_freed = RenderingServer.shader_create()
	RenderingServer.shader_set_code(_freed, CODE_A)
	_material = RenderingServer.material_create()
	RenderingServer.material_set_shader(_material, _shader)
	_rect = ColorRect.new()
	_rect.size = Vector2(64, 64)
	add_child(_rect)
	_api.connect("armed", _armed)
	_api.connect("disarmed", _disarmed)
	_arm()

func _arm() -> void:
	_api.call("arm", {"GRC_LIVE_AWAIT_HELLO_MS": 1})

func _armed(info: Dictionary) -> void:
	_events.append({"event": "armed", "arm": info["arm_index"], "frame": _frame})
	RenderingServer.canvas_item_set_material(_rect.get_canvas_item(), _material)
	if info["arm_index"] == 1:
		if _counted:
			_start_workers()
			_phase = "wait-counted"
		else:
			_disarm()
	else:
		_held_at_arm2 = _worker != null and _worker.is_alive()
		_phase = "armed2"
		_since = _frame

func _disarm() -> void:
	_api.call("disarm", {"linger_ms": 0})
	_since = _frame
	_phase = "disarming1" if _events.size() == 1 else "disarming2"

func _disarmed(info: Dictionary) -> void:
	_events.append({"event": "disarmed", "arm": info["arm_index"], "frame": _frame})
	if info["arm_index"] == 1:
		if _counted:
			_join()
			_arm()
		else:
			_start_workers()
			_phase = "wait-standby"
	else:
		_held_at_release = _worker != null and _worker.is_alive()
		_release()
		_join()
		_finish()

func _start_workers() -> void:
	_worker = Thread.new()
	_worker.start(_set_code)
	_texture_worker = Thread.new()
	_texture_worker.start(_create_texture)
	if _counted:
		_free_worker = Thread.new()
		_free_worker.start(_free_rid)
	_since = _frame

func _set_code() -> void:
	RenderingServer.shader_set_code(_shader, CODE_B)

func _create_texture() -> void:
	_texture = RenderingServer.texture_2d_create(_image)

func _free_rid() -> void:
	RenderingServer.free_rid(_freed)

func _release() -> void:
	for site: String in ["shader-set-code", "free", "texture-create"]:
		var file: FileAccess = FileAccess.open(_dir.path_join("admission-" + site + ".release"), FileAccess.WRITE)
		if file != null:
			file.close()

func _join() -> void:
	if _texture_worker != null:
		_texture_worker.wait_to_finish()
		_texture_worker = null
	if _worker != null:
		_worker.wait_to_finish()
		_worker = null
	if _free_worker != null:
		_free_worker.wait_to_finish()
		_free_worker = null

func _process(_delta: float) -> void:
	_frame += 1
	if _phase in ["wait-counted", "wait-standby"]:
		var ready: bool = FileAccess.file_exists(_dir.path_join("admission-shader-set-code.json"))
		ready = ready and FileAccess.file_exists(_dir.path_join("admission-texture-create.json"))
		if _counted:
			ready = ready and FileAccess.file_exists(_dir.path_join("admission-free.json"))
		if ready:
			if _counted:
				_disarm()
			else:
				_phase = "arming2"
				_arm()
	elif _phase == "disarming1" and _counted and _frame >= _since + 60:
		_release()
	elif _phase == "armed2":
		if not _counted and _frame == _since + 5:
			var release_file: FileAccess = FileAccess.open(_dir.path_join("admission-texture-create.release"), FileAccess.WRITE)
			if release_file != null:
				release_file.close()
			_texture_worker.wait_to_finish()
			_texture_worker = null
		if _fault and _frame >= _since + 5:
			_release()
			_join()
		if _frame >= _since + 30:
			_disarm()
	if _frame > 900:
		_timeouts.append("admission fixture deadline: " + _phase)
		_release()
		_join()
		_finish()

func _finish() -> void:
	set_process(false)
	var marker: Variant = JSON.parse_string(FileAccess.get_file_as_string(_dir.path_join("admission-shader-set-code.json")))
	var free_marker: Variant = null
	if _counted:
		free_marker = JSON.parse_string(FileAccess.get_file_as_string(_dir.path_join("admission-free.json")))
	var file: FileAccess = FileAccess.open(OS.get_environment("RS_SWAP_OUT").path_join("driver.json"), FileAccess.WRITE)
	if file != null:
		file.store_string(JSON.stringify({"timeouts": _timeouts, "events": _events,
			"admission": marker, "free_admission": free_marker,
			"texture_admission": JSON.parse_string(FileAccess.get_file_as_string(_dir.path_join("admission-texture-create.json"))),
			"texture_hot": JSON.parse_string(FileAccess.get_file_as_string(_dir.path_join("admission-texture-hot.json"))),
			"held_at_arm2": _held_at_arm2, "held_at_release": _held_at_release, "final": _api.call("state")}))
	RenderingServer.canvas_item_set_material(_rect.get_canvas_item(), RID())
	RenderingServer.free_rid(_texture)
	RenderingServer.free_rid(_material)
	RenderingServer.free_rid(_shader)
	if not _counted:
		RenderingServer.free_rid(_freed)
	get_tree().quit()
