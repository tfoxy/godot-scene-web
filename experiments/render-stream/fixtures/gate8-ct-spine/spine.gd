extends Node
## Gate 8 late-arm spine CanvasTexture fixture (LATE-SPINE): one 64x64 cell drawn by a custom
## Node2D whose `_draw` calls `draw_mesh(quad, CanvasTexture)` -- the spine-godot shape -- so the
## drawing node has NO `texture` property and the CanvasTexture is reachable only through the draw's
## own texture reference. The capture is loaded at fixture frame 8 and its arm deferred
## (GRC_ARM_DEFER_FRAMES) to frame 14, so the CanvasTexture (created at frame 10, after the hooks
## are installed but before the arm) must be adopted from the canvas_texture_* hooks' registry, not
## the node map (RT-CTX) -- the node's `texture` is nil.

const SIZE: int = 16
const CHECKPOINTS: Array[Array] = [[1, 17]]
const QUIT_DEFAULT: int = 30
const CT_CREATE_FRAME: int = 10

var _frame: int = 0
var _quit_frame: int = QUIT_DEFAULT
var _failed: bool = false
var _shot_dir: String = ""
var _step_log_file: FileAccess
var _draw: SpineLike


func _ready() -> void:
	if not _read_environment():
		_failed = true
		get_tree().quit(2)
		return
	# MESH: a custom Node2D whose _draw calls draw_mesh through a runtime CanvasTexture (the
	# spine-godot shape). The CanvasTexture is created later (frame 10), after the capture loads
	# but before the arm, so it is never on a node's `texture` property.
	_draw = SpineLike.new()
	_draw.position = Vector2(40, 40)
	add_child(_draw)


func _process(_delta: float) -> void:
	if _failed:
		return
	_frame += 1
	if _frame == CT_CREATE_FRAME:
		var ct := CanvasTexture.new()
		ct.diffuse_texture = ImageTexture.create_from_image(_pattern(3))
		_draw.ct = ct
		_draw.queue_redraw()
	for k: int in range(CHECKPOINTS.size()):
		var applied: int = CHECKPOINTS[k][0]
		var settle: int = CHECKPOINTS[k][1]
		if _frame == applied:
			_log_step(k, applied, settle)
		if _frame == settle:
			_maybe_take_shot("step-%d.png" % k)
	if _frame >= _quit_frame:
		print("[fixture] quitting frame=%d" % _frame)
		get_tree().quit(0)


class SpineLike:
	extends Node2D
	## The spine shape: the drawing node has no `texture` property; it draws a mesh straight through
	## a runtime CanvasTexture (as spine-godot's SpineMesh2D does), so RT-CTX's node-map path cannot
	## reach it and the capture must adopt it from the draw's own texture reference.
	var ct: CanvasTexture = null


	func _draw() -> void:
		if ct == null:
			return
		draw_mesh(_quad_mesh(64.0), ct, Transform2D(), Color.WHITE)


	static func _quad_mesh(side: float) -> ArrayMesh:
		var arrays: Array = []
		arrays.resize(Mesh.ARRAY_MAX)
		arrays[Mesh.ARRAY_VERTEX] = PackedVector2Array([Vector2(0, 0), Vector2(side, 0), Vector2(side, side), Vector2(0, side)])
		arrays[Mesh.ARRAY_TEX_UV] = PackedVector2Array([Vector2(0, 0), Vector2(1, 0), Vector2(1, 1), Vector2(0, 1)])
		arrays[Mesh.ARRAY_INDEX] = PackedInt32Array([0, 1, 2, 0, 2, 3])
		var mesh := ArrayMesh.new()
		mesh.add_surface_from_arrays(Mesh.PRIMITIVE_TRIANGLES, arrays)
		return mesh


## A 16x16 opaque RGBA8 image of 4x4-texel blocks, distinct per seed, every channel in 10..239
## (never white, so a diffuse drawn as Godot's white default cannot pass for it).
static func _pattern(seed: int) -> Image:
	var image: Image = Image.create_empty(SIZE, SIZE, false, Image.FORMAT_RGBA8)
	for y: int in range(SIZE):
		for x: int in range(SIZE):
			var i: int = x / 4
			var j: int = y / 4
			image.set_pixel(x, y, Color8(
				10 + (20 + 11 * seed + 40 * i) % 230,
				10 + (60 + 17 * seed + 45 * j) % 230,
				10 + (200 + 23 * seed + 35 * (i + j)) % 230,
				255))
	return image


func _read_environment() -> bool:
	if OS.has_environment("RS_FIXTURE_QUIT_FRAME"):
		var text: String = OS.get_environment("RS_FIXTURE_QUIT_FRAME").strip_edges()
		if not text.is_valid_int() or text.to_int() < QUIT_DEFAULT:
			_error("RS_FIXTURE_QUIT_FRAME must be an integer >= %d (got %s)" % [QUIT_DEFAULT, JSON.stringify(text)])
			return false
		_quit_frame = text.to_int()
	var step_log: String = _path_env("RS_FIXTURE_STEP_LOG")
	_shot_dir = _path_env("RS_FIXTURE_SHOT_DIR")
	if step_log == "!" or _shot_dir == "!":
		return false
	if step_log != "":
		_step_log_file = FileAccess.open(step_log, FileAccess.WRITE)
		if _step_log_file == null:
			_error("cannot open RS_FIXTURE_STEP_LOG=%s" % step_log)
			return false
	return true


## "" when unset, "!" when set but not absolute.
func _path_env(name: String) -> String:
	if not OS.has_environment(name):
		return ""
	var text: String = OS.get_environment(name)
	if not text.is_absolute_path():
		_error("%s must be an absolute path (got %s)" % [name, JSON.stringify(text)])
		return "!"
	return text


func _error(text: String) -> void:
	printerr("[fixture] error: " + text)


func _log_step(step: int, applied_frame: int, settle_frame: int) -> void:
	if _step_log_file == null:
		return
	_step_log_file.store_line("{\"step\":%d,\"applied_frame\":%d,\"settle_frame\":%d}" % [step, applied_frame, settle_frame])
	_step_log_file.flush()


## Rendered runs only: headless has no draw path, so frame_post_draw never fires there.
func _maybe_take_shot(file_name: String) -> void:
	if _shot_dir == "":
		return
	if DisplayServer.get_name() == "headless":
		print("[fixture] shot skipped (headless)")
		return
	var out_path: String = _shot_dir.path_join(file_name)
	await RenderingServer.frame_post_draw
	var image: Image = get_viewport().get_texture().get_image()
	var err: Error = image.save_png(out_path)
	print("[fixture] shot saved=%s err=%d" % [out_path, err])
