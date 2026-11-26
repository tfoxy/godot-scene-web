extends Node2D
## Raw renderer RIDs created before extension load, including a first use after arm.

var _api: Object
var _textures: Array[ImageTexture] = []
var _canvases: Array[RID] = []
var _mesh: ArrayMesh
var _frame: int = 0
var _late: bool = false
var _armed: bool = false
var _arm_number: int = 0
var _out: String


func _ready() -> void:
	_out = OS.get_environment("RS_CTRES_OUT")
	var sources: Array[Dictionary] = []
	for page in range(2):
		var bytes := PackedByteArray()
		for pixel in range(64):
			bytes.append_array(PackedByteArray([pixel * 3, page * 127, 255 - pixel * 3, 255]))
		var image := Image.create_from_data(8, 8, false, Image.FORMAT_RGBA8, bytes)
		var texture := ImageTexture.create_from_image(image)
		_textures.append(texture)
		var hash := HashingContext.new()
		hash.start(HashingContext.HASH_SHA256)
		hash.update(bytes)
		sources.append({"rid": str(texture.get_rid().get_id()), "pixel_sha256": hash.finish().hex_encode(),
			"hex": bytes.hex_encode()})
	for index in range(3):
		var canvas := RenderingServer.canvas_texture_create()
		RenderingServer.canvas_texture_set_channel(canvas, RenderingServer.CANVAS_TEXTURE_CHANNEL_DIFFUSE,
			_textures[index % 2].get_rid())
		if index == 0:
			RenderingServer.canvas_texture_set_channel(canvas, RenderingServer.CANVAS_TEXTURE_CHANNEL_NORMAL,
				_textures[1].get_rid())
		RenderingServer.canvas_texture_set_texture_filter(canvas, RenderingServer.CANVAS_ITEM_TEXTURE_FILTER_NEAREST)
		_canvases.append(canvas)
	_mesh = ArrayMesh.new()
	var arrays: Array = []
	arrays.resize(Mesh.ARRAY_MAX)
	arrays[Mesh.ARRAY_VERTEX] = PackedVector2Array([Vector2(16, 16), Vector2(80, 16), Vector2(16, 80)])
	arrays[Mesh.ARRAY_TEX_UV] = PackedVector2Array([Vector2(0, 0), Vector2(1, 0), Vector2(0, 1)])
	_mesh.add_surface_from_arrays(Mesh.PRIMITIVE_TRIANGLES, arrays)
	_save("source.json", {"sources": sources, "canvases": _canvases.map(func(r: RID) -> String: return str(r.get_id())),
		"initial_filter": RenderingServer.CANVAS_ITEM_TEXTURE_FILTER_NEAREST,
		"rearm_filter": RenderingServer.CANVAS_ITEM_TEXTURE_FILTER_LINEAR})
	queue_redraw()


func _exit_tree() -> void:
	for canvas in _canvases:
		RenderingServer.free_rid(canvas)


func _draw() -> void:
	if _canvases.is_empty():
		return
	RenderingServer.canvas_item_add_mesh(get_canvas_item(), _mesh.get_rid(), Transform2D.IDENTITY,
		Color.WHITE, _canvases[0])
	RenderingServer.canvas_item_add_texture_rect(get_canvas_item(), Rect2(100, 16, 64, 64), _canvases[1])
	if _late:
		RenderingServer.canvas_item_add_texture_rect(get_canvas_item(), Rect2(180, 16, 64, 64), _canvases[2])


func _process(_delta: float) -> void:
	_frame += 1
	if _frame == 10:
		var status := GDExtensionManager.load_extension(OS.get_environment("GRC_EXTENSION"))
		_check(status == GDExtensionManager.LOAD_STATUS_OK, "extension load: " + str(status))
		_api = Engine.get_singleton("RenderStreamCapture")
		_api.connect("armed", func(_info: Dictionary) -> void: _armed = true)
		_api.connect("arm_failed", func(reason: Variant) -> void: _check(false, "arm failed: " + str(reason)))
	elif _frame == 20:
		_invoke("attach")
		_copy_resolver("attached.json")
		_invoke("arm")
	elif _frame == 23:
		# The one-us drain has resolved both wrappers but has not adopted their channels yet.
		var state: Dictionary = _api.call("state")
		RenderingServer.canvas_texture_set_channel(_canvases[1], RenderingServer.CANVAS_TEXTURE_CHANNEL_DIFFUSE,
			_textures[0].get_rid())
		RenderingServer.canvas_texture_set_texture_filter(_canvases[1], RenderingServer.CANVAS_ITEM_TEXTURE_FILTER_LINEAR)
		_save("pending-mutation.json", {"fixture_frame": _frame, "capture_frame_upper": int(state["frame"]) + 1,
			"canvas": str(_canvases[1].get_id()), "diffuse": str(_textures[0].get_rid().get_id()),
			"filter": RenderingServer.CANVAS_ITEM_TEXTURE_FILTER_LINEAR})
	elif _frame == 45:
		_check(_armed, "capture armed")
		_late = true
		queue_redraw()
	elif _frame == 70:
		_invoke("disarm")
	elif _frame == 75:
		RenderingServer.canvas_texture_set_channel(_canvases[0], RenderingServer.CANVAS_TEXTURE_CHANNEL_DIFFUSE,
			_textures[1].get_rid())
		RenderingServer.canvas_texture_set_texture_filter(_canvases[0], RenderingServer.CANVAS_ITEM_TEXTURE_FILTER_LINEAR)
	elif _frame == 80:
		_copy_resolver("resolved.json")
		_invoke("arm")
		queue_redraw()
	elif _frame == 110:
		_invoke("disarm")
	elif _frame == 120:
		_copy_resolver("rearmed.json")
		_invoke("detach")
		_invoke("attach")
		_copy_resolver("reattached.json")
		_invoke("arm")
		queue_redraw()
	elif _frame == 150:
		_invoke("disarm")
	elif _frame == 160:
		_copy_resolver("final.json")
		_save("finished.json", {"frame": _frame, "state": _api.call("state")})
		get_viewport().get_texture().get_image().save_png(_out.path_join("native.png"))
		get_tree().quit()


func _invoke(method: String) -> void:
	if method == "arm":
		_arm_number += 1
	var status: int = _api.call(method, {"linger_ms": 0} if method == "disarm" else {})
	_check(status == 0, method + ": " + str(status))


func _copy_resolver(name: String) -> void:
	var root := OS.get_environment("GRC_EVIDENCE_DIR")
	if name in ["resolved.json", "rearmed.json", "final.json"]:
		# Result counters belong to the latest arm, at the attachment root. Preserve each arm.
		_check(DirAccess.copy_absolute(root.path_join("result.json"),
			_out.path_join("arm-" + str(_arm_number) + "-result.json")) == OK, "copy arm result")
	if _arm_number >= 2 and name not in ["attached.json", "reattached.json"]:
		root = root.path_join("arm-" + str(_arm_number))
	var path := root.path_join("canvas-texture-resolver.json")
	_check(DirAccess.copy_absolute(path, _out.path_join(name)) == OK, "copy " + name)


func _save(name: String, row: Dictionary) -> void:
	var file := FileAccess.open(_out.path_join(name), FileAccess.WRITE)
	file.store_string(JSON.stringify(row))


func _check(ok: bool, reason: String) -> void:
	if not ok:
		push_error("canvas texture probe: " + reason)
		_save("failure.json", {"reason": reason, "frame": _frame})
		get_tree().quit(1)
