extends Node
## Read-only resource census and an optional in-process extension lifecycle probe.
## Installed only into a runner-owned copy of the existing rendered fixtures.

var _frame: int = 0
var _image: Image
var _texture: ImageTexture


func _ready() -> void:
	_image = Image.create(128, 128, false, Image.FORMAT_RGBA8)
	_image.fill(Color.CORNFLOWER_BLUE)
	_texture = ImageTexture.create_from_image(_image)
	# Keep the synthetic upload off screen; screenshots contain only the original fixture.


func _process(_delta: float) -> void:
	_frame += 1
	# A production standby hook sees a whole-image update each frame, without a file sink.
	_image.set_pixel(0, 0, Color.RED if _frame % 2 else Color.BLUE)
	_texture.update(_image)
	if _frame in [10, 15, 17, 23, 26, 60, 119]:
		var resources: Array[Dictionary] = []
		_census(get_tree().root, resources)
		var maps: Array[String] = []
		var file := FileAccess.open("/proc/self/maps", FileAccess.READ)
		if file != null:
			# procfs reports size zero; get_as_text() would silently return no mappings.
			while not file.eof_reached():
				var line: String = file.get_line()
				if "librender_stream_capture" in line:
					maps.append(line)
		var state: Dictionary = {}
		if Engine.has_singleton("RenderStreamCapture"):
			var capture: Object = Engine.get_singleton("RenderStreamCapture")
			state = capture.call("state")
		var evidence: Dictionary = {}
		for name: String in ["counters.json", "result.json"]:
			var path: String = OS.get_environment("GRC_EVIDENCE_DIR").path_join(name)
			if FileAccess.file_exists(path):
				evidence[name] = JSON.parse_string(FileAccess.get_file_as_string(path))
		_write({"frame": _frame, "resources": resources, "capture_maps": maps,
			"capture_state": state, "evidence": evidence,
			"loaded": GDExtensionManager.is_extension_loaded(OS.get_environment("GRC_EXTENSION"))})
	if OS.get_environment("RS_ATTACH_CYCLE") == "1":
		var path: String = OS.get_environment("GRC_EXTENSION")
		if _frame == 16:
			var status: int = GDExtensionManager.unload_extension(path)
			_write({"frame": _frame, "action": "unload", "status": status,
				"loaded": GDExtensionManager.is_extension_loaded(path)})
		if _frame == 24:
			var status: int = GDExtensionManager.load_extension(path)
			_write({"frame": _frame, "action": "load", "status": status,
				"loaded": GDExtensionManager.is_extension_loaded(path)})
		if _frame == 28 and Engine.has_singleton("RenderStreamCapture"):
			var capture: Object = Engine.get_singleton("RenderStreamCapture")
			var status: int = capture.call("arm", {})
			var state: Dictionary = capture.call("state")
			_write({"frame": _frame, "action": "arm-after-reload", "status": status,
				"capture_state": state})


func _census(node: Node, rows: Array[Dictionary]) -> void:
	if node is MultiMeshInstance2D:
		var mm: MultiMesh = (node as MultiMeshInstance2D).multimesh
		if mm != null:
			var buffer: PackedFloat32Array = RenderingServer.multimesh_get_buffer(mm.get_rid())
			rows.append({"node": str(node.get_path()), "kind": "multimesh",
				"instances": mm.instance_count, "format": mm.transform_format,
				"colors": mm.use_colors, "custom": mm.use_custom_data,
				"visible": mm.visible_instance_count, "buffer_floats": buffer.size(),
				"buffer": Array(buffer)})
	if node is GPUParticles2D:
		var particles := node as GPUParticles2D
		rows.append({"node": str(node.get_path()), "kind": "particles",
			"amount": particles.amount, "emitting": particles.emitting,
			"lifetime": particles.lifetime, "one_shot": particles.one_shot,
			"fixed_fps": particles.fixed_fps, "seed": particles.seed,
			"local_coords": particles.local_coords,
			"process_material": particles.process_material != null})
	for child in node.get_children():
		_census(child, rows)


func _write(row: Dictionary) -> void:
	var path: String = OS.get_environment("RS_ATTACH_PROBE_LOG")
	if path.is_empty():
		return
	var file := FileAccess.open(path, FileAccess.READ_WRITE if FileAccess.file_exists(path) else FileAccess.WRITE)
	if file == null:
		push_error("cannot open attach probe log: " + path)
		get_tree().quit(1)
		return
	file.seek_end()
	file.store_line(JSON.stringify(row))
