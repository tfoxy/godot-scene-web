extends Node
## Runner-owned rendered fixture. All detached samples read the resident singleton directly.

var _api: Object
var _out: String
var _frame: int = 0
var _round: int = 0
var _phase: String = "loading"
var _since: int = 0
var _image: Image
var _texture: ImageTexture
var _marker: Sprite2D
var _canvas: Node2D
var _armed_info: Dictionary = {}
var _lean_particles: RID
var _lean_material: RID
var _lean_shader: RID
var _lean_mm: RID
var _lean_ct: RID


func _ready() -> void:
	_out = OS.get_environment("RS_RESIDENT_OUT")
	_image = Image.create(128, 128, false, Image.FORMAT_RGBA8)
	_texture = ImageTexture.create_from_image(_image)
	_canvas = Node2D.new()
	add_child(_canvas)
	var rect := ColorRect.new()
	rect.position = Vector2(40, 40)
	rect.size = Vector2(240, 160)
	rect.color = Color.CORNFLOWER_BLUE
	_canvas.add_child(rect)
	_make_marker()
	# The extension first loads after a rendered scene already exists.
	_phase = "before-load"


func _load_lean() -> void:
	var status: GDExtensionManager.LoadStatus = GDExtensionManager.load_extension(OS.get_environment("GRC_EXTENSION"))
	if status != GDExtensionManager.LOAD_STATUS_OK:
		push_error("resident attach probe: extension load " + str(status))
		get_tree().quit(1)
		return
	_api = Engine.get_singleton("RenderStreamCapture")
	_api.connect("armed", _armed)
	_api.connect("disarmed", _disarmed)
	_api.connect("arm_failed", _arm_failed)
	_save("load-detached.json", {"frame": _frame, "state": _api.call("state")})
	_lean_ct = RenderingServer.canvas_texture_create()
	RenderingServer.canvas_texture_set_channel(_lean_ct, RenderingServer.CANVAS_TEXTURE_CHANNEL_DIFFUSE, _texture.get_rid())
	RenderingServer.canvas_texture_set_shading_parameters(_lean_ct, Color.WHITE, 0.5)
	_lean_mm = RenderingServer.multimesh_create()
	RenderingServer.multimesh_allocate_data(_lean_mm, 1, RenderingServer.MULTIMESH_TRANSFORM_2D, true, true)
	_lean_particles = RenderingServer.particles_create()
	RenderingServer.particles_set_mode(_lean_particles, RenderingServer.PARTICLES_MODE_2D)
	RenderingServer.particles_set_amount(_lean_particles, 4)
	_lean_shader = RenderingServer.shader_create()
	RenderingServer.shader_set_code(_lean_shader, "shader_type canvas_item; uniform float fade = 1.0;")
	_lean_material = RenderingServer.material_create()
	RenderingServer.material_set_shader(_lean_material, _lean_shader)
	RenderingServer.material_set_next_pass(_lean_material, RID())
	RenderingServer.material_set_render_priority(_lean_material, 3)
	_phase = "initial-detached"
	_since = _frame
	_sample()


func _make_marker() -> void:
	# A new item AND texture created after each attach must reach that stream.
	if is_instance_valid(_marker):
		_marker.free()
	var image := Image.create(64, 64, false, Image.FORMAT_RGBA8)
	var colors: Array[Color] = [Color.RED, Color.GREEN, Color.BLUE]
	image.fill(colors[_round])
	_marker = Sprite2D.new()
	_marker.texture = ImageTexture.create_from_image(image)
	_marker.centered = false
	_marker.position = Vector2(400, 100)
	_canvas.add_child(_marker)
	_write("events.jsonl", {"event": "new-content", "round": _round, "frame": _frame})


func _arm() -> void:
	_phase = "arming"
	_invoke("arm", {"GRC_LIVE_AWAIT_HELLO_MS": 120000})


func _armed(info: Dictionary) -> void:
	_armed_info = info
	_phase = "streaming"
	# Private local evidence includes the ephemeral loopback token, never committed.
	_save("ready-%d.json" % _round, {"info": info, "pid": OS.get_process_id(),
		"frame": _frame, "state": _api.call("state")})


func _arm_failed(reason: Variant) -> void:
	_check(false, "arm-failed: " + str(reason))


func _disarmed(_info: Dictionary) -> void:
	# Do not change callback registration from inside the capture's signal delivery stack.
	_phase = "detach-next-process"


func _process(_delta: float) -> void:
	_frame += 1
	# Busy RS traffic continues across detach: texture uploads, item creation/free and draws.
	_image.set_pixel(0, 0, Color.RED if _frame % 2 else Color.BLUE)
	_texture.update(_image)
	_canvas.queue_redraw()
	if _lean_particles.is_valid():
		RenderingServer.particles_set_emission_transform(_lean_particles, Transform3D(Basis.IDENTITY, Vector3(_frame, 0, 0)))
		# These values are readable and must not enter the detached table.
		RenderingServer.material_set_param(_lean_material, "fade", float(_frame % 2))
		RenderingServer.multimesh_set_buffer(_lean_mm, PackedFloat32Array([1, 0, 0, 0, 0, 1, 0, 0, 1, 1, 1, 1, 0, 0, 0, 0]))
	var item: RID = RenderingServer.canvas_item_create()
	RenderingServer.canvas_item_set_parent(item, _canvas.get_canvas_item())
	RenderingServer.canvas_item_add_rect(item, Rect2(-20, -20, 4, 4), Color.WHITE)
	RenderingServer.free_rid(item)
	if _phase == "before-load" and _frame == 10:
		_load_lean()
	elif _phase == "initial-detached":
		_sample()
		if _frame >= _since + 120:
			_invoke("attach", {})
			_arm()
	elif _phase == "streaming" and FileAccess.file_exists(_out.path_join("stream-%d.done" % _round)):
		get_viewport().get_texture().get_image().save_png(_out.path_join("native-%d.png" % _round))
		_save("streamed-%d.json" % _round, {"frame": _frame, "state": _api.call("state")})
		_phase = "disarming"
		_invoke("disarm", {"linger_ms": 0})
	elif _phase == "detach-next-process":
		if OS.get_environment("RS_RESIDENT_SKIP_DETACH") != "1":
			_invoke("detach", {})
		_phase = "detached"
		_since = _frame
		_sample()
		_save("detached-%d.json" % _round, {"frame": _frame, "state": _api.call("state"),
			"listen": _armed_info.get("listen"), "pid": OS.get_process_id()})
	elif _phase == "detached":
		_sample()
		if _frame == _since + 120:
			_save("busy-%d.done" % _round, {"frame": _frame})
		if _frame >= _since + 120 and FileAccess.file_exists(_out.path_join("resume-%d.done" % _round)):
			if _round == 2:
				_save("finished.json", {"frame": _frame, "state": _api.call("state")})
				get_tree().quit()
				return
			_round += 1
			_make_marker()
			_invoke("attach", {})
			_arm()
	if _frame > 18000:
		_check(false, "fixture deadline: " + _phase)


func _sample() -> void:
	# These are independent live reads on EVERY busy detached frame, never counters.json.
	_write("detached-samples.jsonl", {"round": _round, "frame": _frame,
		"t_us": Time.get_ticks_usec(), "initial": _phase == "initial-detached", "state": _api.call("state")})


func _invoke(method: String, options: Dictionary) -> void:
	var status: int = _api.call(method, options)
	_check(status == 0, method + ": " + str(status))


func _check(ok: bool, reason: String) -> void:
	if not ok:
		push_error("resident attach probe: " + reason)
		_save("failure.json", {"reason": reason, "frame": _frame, "state": _api.call("state")})
		get_tree().quit(1)


func _save(name: String, row: Dictionary) -> void:
	var file := FileAccess.open(_out.path_join(name), FileAccess.WRITE)
	file.store_string(JSON.stringify(row))
	file.close()


func _write(name: String, row: Dictionary) -> void:
	var path: String = _out.path_join(name)
	var file := FileAccess.open(path, FileAccess.READ_WRITE if FileAccess.file_exists(path) else FileAccess.WRITE)
	file.seek_end()
	file.store_line(JSON.stringify(row))
	file.close()


func _exit_tree() -> void:
	for rid: RID in [_lean_ct, _lean_mm, _lean_particles, _lean_material, _lean_shader]:
		if rid.is_valid():
			RenderingServer.free_rid(rid)
