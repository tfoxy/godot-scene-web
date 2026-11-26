extends "res://resident_probe.gd"
## Draw getter-backed payloads and lean descriptors created while capture is detached.

var _large_textures: Array[ImageTexture] = []
var _cached_textures: Array[Texture2D] = []
var _late_sprite: Sprite2D
var _late_drawn: bool = false
var _frame_trace: Array[Dictionary] = []
var _previous_tick_us: int = 0

var _attached_size_texture: ImageTexture
var _detached_size_texture: ImageTexture
var _content: Node2D
var _resource_generation: int = 0
var _proxy: RID
var _proxy_frames: Array[Texture2D] = []
var _proxy_client_frames: int = 0
var _proxy_switched: bool = false


func _load_lean() -> void:
	# Load before the extension, outside both its registry and mirror. Keep 184 textures undrawn.
	for index in range(226):
		_cached_textures.append(load("res://rearm-textures/texture-%03d.ctex" % index))
	super._load_lean()
	_make_resources()


func _process(delta: float) -> void:
	var tick_us := Time.get_ticks_usec()
	if _phase != "detached" and _phase != "initial-detached" and _frame_trace.size() < 240:
		_frame_trace.append({"round": _round, "phase": _phase, "frame": _frame,
			"t_us": tick_us, "interval_us": tick_us - _previous_tick_us})
	_previous_tick_us = tick_us
	if _phase == "streaming" and _attached_size_texture == null:
		_attached_size_texture = _size_texture()
		_write("size-attached.json", {"round": _round, "state": _api.call("state")})
		_content.queue_redraw()
	# The receiver's first GPU readback proves publication; a connected client alone can still
	# be waiting for staged adoption. Keep the proxy change after that first snapshot.
	var state: Dictionary = _api.call("state") if is_instance_valid(_api) else {}
	var clients: int = state.get("clients", 0)
	if _phase == "streaming" and not _proxy_switched and clients > 0 and FileAccess.file_exists(_out.path_join("browser-%d/shots/seq-1.png" % _round)):
		_proxy_client_frames += 1
		if _proxy_client_frames == 1:
			RenderingServer.texture_proxy_update(_proxy, _proxy_frames[2].get_rid())
			_proxy_switched = true
			_write("proxy-updates.jsonl", {"round": _round, "frame": _frame})
	# Introduce a preloaded texture on the first host tick after the receiver draws its first snapshot.
	if _phase == "streaming" and not _late_drawn and FileAccess.file_exists(_out.path_join("browser-%d/shots/seq-1.png" % _round)):
		_late_sprite.texture = _cached_textures[41]
		_late_drawn = true
		_write("post-publish.jsonl", {"round": _round, "frame": _frame,
			"rid": _cached_textures[41].get_rid().get_id(), "t_us": tick_us})
	super._process(delta)
	# Leave a full detached interval for the one-shot to finish inside the renderer.
	if _phase == "detached" and _frame == _since:
		_save("adoption-frames-%d.json" % _round, {"frames": _frame_trace,
			"large_texture_bytes": _large_textures.size() * 2048 * 2048 * 4})
		_frame_trace.clear()
		# result.json is load-wide and the next arm replaces it; preserve each arm independently.
		var result_path := OS.get_environment("GRC_EVIDENCE_DIR").path_join("result.json")
		var status := DirAccess.copy_absolute(result_path, _out.path_join("resource-result-%d.json" % _round))
		_check(status == OK, "save per-arm resource result: " + str(status))
		for filename: String in ["fingerprint.json", "calibration-check.json"]:
			status = DirAccess.copy_absolute(OS.get_environment("GRC_EVIDENCE_DIR").path_join(filename),
				_out.path_join("%d-%s" % [_round, filename]))
			_check(status == OK, "save per-arm identity: " + filename)
		_late_drawn = false
		_late_sprite.texture = null
		_proxy_switched = false
		_proxy_client_frames = 0
		RenderingServer.texture_proxy_update(_proxy, _proxy_frames[1].get_rid())


func _make_resources() -> void:
	if is_instance_valid(_content):
		_content.free()
	if _proxy.is_valid():
		RenderingServer.free_rid(_proxy)
	_proxy_frames.clear()
	_proxy_client_frames = 0
	_proxy_switched = false
	for color: Color in [Color.WHITE, Color.BLUE, Color.GREEN]:
		var frame := Image.create(8, 8, false, Image.FORMAT_RGBA8)
		frame.fill(color)
		_proxy_frames.append(ImageTexture.create_from_image(frame))
	# Both creation and the first re-point happen while detached. The second re-point happens
	# after attach, so the browser must keep a Proxy RID throughout adoption.
	_proxy = RenderingServer.texture_proxy_create(_proxy_frames[0].get_rid())
	RenderingServer.texture_proxy_update(_proxy, _proxy_frames[1].get_rid())
	_detached_size_texture = _size_texture()
	_content = Node2D.new()
	_content.draw.connect(func() -> void:
		RenderingServer.canvas_item_add_texture_rect(_content.get_canvas_item(), Rect2(376, 176, 8, 8), _proxy)
		_content.draw_texture_rect_region(_detached_size_texture, Rect2(420, 40, 16, 16), Rect2(0, 0, 8, 8))
		if _attached_size_texture != null:
			_content.draw_texture_rect_region(_attached_size_texture, Rect2(460, 40, 16, 16), Rect2(0, 0, 8, 8)))
	_canvas.add_child(_content)
	for index in range(41):
		var cached_sprite := Sprite2D.new()
		cached_sprite.texture = _cached_textures[index]
		cached_sprite.position = Vector2(12 + (index % 21) * 12, 320 + (index / 21) * 12)
		_content.add_child(cached_sprite)
	_late_sprite = Sprite2D.new()
	_late_sprite.position = Vector2(280, 320)
	_content.add_child(_late_sprite)
	_write("cached-textures.jsonl", {"rids": _cached_textures.map(func(texture: Texture2D) -> int: return texture.get_rid().get_id())})
	_large_textures.clear()
	if OS.get_environment("RS_RESIDENT_LARGE_TEXTURES") == "1":
		for index: int in range(8):
			var large_image := Image.create(2048, 2048, false, Image.FORMAT_RGBA8)
			large_image.fill(Color(0.1 + index * 0.08, 0.4, 0.2, 1.0))
			var large_texture := ImageTexture.create_from_image(large_image)
			_large_textures.append(large_texture)
			var large_sprite := Sprite2D.new()
			large_sprite.texture = large_texture
			large_sprite.scale = Vector2(0.00390625, 0.00390625)
			large_sprite.position = Vector2(490 + index * 12, 40)
			_content.add_child(large_sprite)
	_resource_generation += 1
	var image := Image.create(16, 16, false, Image.FORMAT_RGBA8)
	image.fill(Color.YELLOW)
	var texture := ImageTexture.create_from_image(image)
	var canvas_texture := CanvasTexture.new()
	canvas_texture.diffuse_texture = texture
	canvas_texture.texture_filter = CanvasItem.TEXTURE_FILTER_NEAREST
	var sprite := Sprite2D.new()
	sprite.texture = canvas_texture
	sprite.position = Vector2(320, 40)
	_content.add_child(sprite)

	var shader := Shader.new()
	shader.code = "shader_type canvas_item; uniform vec4 tint : source_color = vec4(1.0); uniform sampler2D paint; uniform sampler2D overlay; void fragment() { COLOR = texture(paint, UV) * texture(overlay, UV) * tint; }"
	var material := ShaderMaterial.new()
	material.shader = shader
	material.set_shader_parameter("tint", Color(1, 0, 1, 1))
	var white := Image.create(8, 8, false, Image.FORMAT_RGBA8)
	white.fill(Color.WHITE)
	var white_texture := ImageTexture.create_from_image(white)
	shader.set_default_texture_parameter("paint", white_texture)
	material.set_shader_parameter("overlay", white_texture)
	var shaded := Sprite2D.new()
	shaded.texture = texture
	shaded.material = material
	shaded.position = Vector2(320, 80)
	_content.add_child(shaded)

	var compressed_sprite := Sprite2D.new()
	compressed_sprite.texture = _cached_textures[0]
	compressed_sprite.position = Vector2(380, 40)
	_content.add_child(compressed_sprite)

	var array_shader := Shader.new()
	array_shader.code = "shader_type canvas_item; uniform sampler2D paints; void fragment() { COLOR = texture(paints, UV); }"
	var green := Image.create(8, 8, false, Image.FORMAT_RGBA8)
	green.fill(Color.GREEN)
	# RS stores indexed defaults independently of declarations. Exercise that binding map while
	# drawing a scalar sampler: the browser translator does not support sampler-array GLSL.
	array_shader.set_default_texture_parameter("paints", ImageTexture.create_from_image(green), 0)
	array_shader.set_default_texture_parameter("paints", white_texture, 1)
	array_shader.set_default_texture_parameter("paints", white_texture, 2)
	array_shader.set_default_texture_parameter("paints", null, 2)
	var array_material := ShaderMaterial.new()
	array_material.shader = array_shader
	var array_sprite := Sprite2D.new()
	array_sprite.texture = texture
	array_sprite.material = array_material
	array_sprite.position = Vector2(380, 80)
	_content.add_child(array_sprite)

	var mesh := ArrayMesh.new()
	var arrays: Array = []
	arrays.resize(Mesh.ARRAY_MAX)
	arrays[Mesh.ARRAY_VERTEX] = PackedVector2Array([Vector2(-6, -6), Vector2(6, -6), Vector2(6, 6), Vector2(-6, 6)])
	arrays[Mesh.ARRAY_TEX_UV] = PackedVector2Array([Vector2.ZERO, Vector2.RIGHT, Vector2.ONE, Vector2.DOWN])
	arrays[Mesh.ARRAY_INDEX] = PackedInt32Array([0, 1, 2, 0, 2, 3])
	mesh.add_surface_from_arrays(Mesh.PRIMITIVE_TRIANGLES, arrays)
	var multimesh := MultiMesh.new()
	multimesh.transform_format = MultiMesh.TRANSFORM_2D
	multimesh.use_colors = true
	multimesh.use_custom_data = true
	multimesh.mesh = mesh
	multimesh.instance_count = 3
	for i in range(3):
		multimesh.set_instance_transform_2d(i, Transform2D(0, Vector2(300 + i * 20, 130)))
		multimesh.set_instance_color(i, Color.GREEN)
		multimesh.set_instance_custom_data(i, Color(0.25, 0.5, 0.75, 1))
	multimesh.visible_instance_count = 2
	multimesh.custom_aabb = AABB(Vector3(280, 110, 0), Vector3(80, 40, 1))
	var instances := MultiMeshInstance2D.new()
	instances.multimesh = multimesh
	_content.add_child(instances)

	var cpu := CPUParticles2D.new()
	cpu.position = Vector2(320, 180)
	cpu.amount = 4
	cpu.lifetime = 1
	cpu.preprocess = 1
	cpu.gravity = Vector2.ZERO
	cpu.initial_velocity_min = 0
	cpu.initial_velocity_max = 0
	cpu.texture = white_texture
	cpu.color = Color.CYAN
	_content.add_child(cpu)

	var pm := ParticleProcessMaterial.new()
	pm.particle_flag_disable_z = true
	pm.gravity = Vector3.ZERO
	pm.initial_velocity_min = 0
	pm.initial_velocity_max = 0
	pm.color = Color.RED
	var gpu := GPUParticles2D.new()
	gpu.position = Vector2(320, 230)
	gpu.amount = 4
	gpu.lifetime = 1
	gpu.preprocess = 1
	gpu.fixed_fps = 60
	gpu.use_fixed_seed = true
	gpu.seed = 123
	gpu.process_material = pm
	gpu.texture = white_texture
	_content.add_child(gpu)
	# Stop internally while detached; no observed set_emitting(false) may be needed to finish.
	var completed := GPUParticles2D.new()
	completed.position = Vector2(360, 230)
	completed.amount = 4
	completed.lifetime = 0.1
	completed.one_shot = true
	completed.explosiveness = 1
	completed.use_fixed_seed = true
	completed.seed = 456
	completed.process_material = pm
	completed.texture = white_texture
	_content.add_child(completed)
	# The parent is drawn before its child. Even a child with no independent emission must be
	# installed and linked before the adopted parent's restart reaches the first snapshot.
	var child := GPUParticles2D.new()
	child.name = "Subemitter"
	child.position = Vector2(360, 280)
	child.emitting = false
	child.amount = 4
	child.lifetime = 1
	child.use_fixed_seed = true
	child.seed = 890
	child.process_material = pm
	child.texture = white_texture
	var parent := GPUParticles2D.new()
	parent.position = Vector2(320, 280)
	parent.amount = 4
	parent.lifetime = 1
	parent.preprocess = 1
	parent.use_fixed_seed = true
	parent.seed = 789
	parent.process_material = pm
	parent.texture = white_texture
	parent.add_child(child)
	parent.sub_emitter = parent.get_path_to(child)
	_content.add_child(parent)
	_write("resource-generations.jsonl", {"generation": _resource_generation, "frame": _frame,
		"state": _api.call("state")})


func _size_texture() -> ImageTexture:
	var image := Image.create(8, 8, false, Image.FORMAT_RGBA8)
	image.fill(Color.GREEN)
	image.fill_rect(Rect2i(0, 0, 4, 4), Color.RED)
	var texture := ImageTexture.create_from_image(image)
	texture.set_size_override(Vector2i(16, 16))
	return texture
