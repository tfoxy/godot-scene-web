extends Node
## Gate 8 CanvasTexture fixture (P3-CT, gate8-design.md "As built (P3-CT)", README.md). Every image
## texture here is drawn ONLY through a CanvasTexture's diffuse channel: no command names an image
## directly, which is how spine-godot draws its atlas pages (a MeshInstance2D-style add_mesh whose
## texture is a CanvasTexture). Eight 64x64 regions, nearest sampling at integer scales so no pixel
## centre falls on a texel boundary:
##
##   MESH  (40,40)    MeshInstance2D, an ArrayMesh quad, through CT_A (diffuse created first)
##   POLY  (136,40)   Polygon2D through CT_B, whose diffuse is created AFTER CT_B (higher wire id)
##   RECT  (232,40)   Sprite2D region 32x32 of a 16x16 diffuse at scale 2: CT_C's own nearest and
##                    repeat-enabled override the item's linear and repeat-disabled
##   TRECT (328,40)   TextureRect (add_texture_rect) through CT_D
##   SWAP  (40,136)   Sprite2D through CT_E; step 1 sets CT_E's diffuse to a new image
##   UPD   (136,136)  Sprite2D through CT_F; step 1 updates its diffuse's pixels in place
##   NORM  (232,136)  Sprite2D through CT_G with a normal map: `canvas-texture-channel`, refused
##   SPEC  (328,136)  Sprite2D through CT_H with a specular map: `canvas-texture-channel`, refused
##
## The root is a plain `Node`: every CanvasItem is created in `_ready`, after the loader armed the
## capture in its `_enter_tree` (gate 0's rule: the main scene's own nodes exist before that).
##
## Timeline (fixture frames): checkpoint 0 is _ready's scene (applied 1, settles 4); step 1 at 10
## (settles 17); quit at 25. The step log holds {"step", "applied_frame", "settle_frame"} per
## checkpoint. Environment (all optional): RS_FIXTURE_STEP_LOG, RS_FIXTURE_SHOT_DIR (rendered runs
## only, shots step-<k>.png), RS_FIXTURE_QUIT_FRAME (>= 25).

const SIZE: int = 16
const CHECKPOINTS: Array[Array] = [[1, 4], [10, 17]]
const QUIT_DEFAULT: int = 25

var _frame: int = 0
var _quit_frame: int = QUIT_DEFAULT
var _shot_dir: String = ""
var _step_log_file: FileAccess
var _failed: bool = false
var _ct_e: CanvasTexture
var _d_f: ImageTexture
var _root: Node2D


func _ready() -> void:
	if not _read_environment():
		_failed = true
		get_tree().quit(2)
		return
	_root = Node2D.new()
	add_child(_root)
	# MESH: the diffuse exists before its canvas texture (the spine-godot order).
	var d_a: ImageTexture = ImageTexture.create_from_image(_pattern(1))
	var ct_a := CanvasTexture.new()
	ct_a.diffuse_texture = d_a
	var mesh_instance := MeshInstance2D.new()
	mesh_instance.mesh = _quad_mesh(64.0)
	mesh_instance.texture = ct_a
	mesh_instance.position = Vector2(40, 40)
	_root.add_child(mesh_instance)
	# POLY: the canvas texture first, its diffuse after it.
	var ct_b := CanvasTexture.new()
	var d_b: ImageTexture = ImageTexture.create_from_image(_pattern(2))
	ct_b.diffuse_texture = d_b
	var poly := Polygon2D.new()
	poly.polygon = PackedVector2Array([Vector2(0, 0), Vector2(64, 0), Vector2(64, 64), Vector2(0, 64)])
	poly.uv = PackedVector2Array([Vector2(0, 0), Vector2(SIZE, 0), Vector2(SIZE, SIZE), Vector2(0, SIZE)])
	poly.texture = ct_b
	poly.position = Vector2(136, 40)
	_root.add_child(poly)
	# RECT: the canvas texture's own filter and repeat override the item's.
	var ct_c := CanvasTexture.new()
	ct_c.diffuse_texture = ImageTexture.create_from_image(_pattern(3))
	ct_c.texture_filter = CanvasItem.TEXTURE_FILTER_NEAREST
	ct_c.texture_repeat = CanvasItem.TEXTURE_REPEAT_ENABLED
	var rect := _sprite(ct_c, Vector2(232, 40), 2.0)
	rect.region_enabled = true
	rect.region_rect = Rect2(0, 0, 2 * SIZE, 2 * SIZE)
	rect.texture_filter = CanvasItem.TEXTURE_FILTER_LINEAR
	rect.texture_repeat = CanvasItem.TEXTURE_REPEAT_DISABLED
	# TRECT: a Control's add_texture_rect.
	var ct_d := CanvasTexture.new()
	ct_d.diffuse_texture = ImageTexture.create_from_image(_pattern(4))
	var texture_rect := TextureRect.new()
	texture_rect.texture = ct_d
	texture_rect.expand_mode = TextureRect.EXPAND_IGNORE_SIZE
	texture_rect.stretch_mode = TextureRect.STRETCH_SCALE
	texture_rect.position = Vector2(328, 40)
	texture_rect.size = Vector2(64, 64)
	_root.add_child(texture_rect)
	# SWAP and UPD: changed at step 1.
	_ct_e = CanvasTexture.new()
	_ct_e.diffuse_texture = ImageTexture.create_from_image(_pattern(5))
	_sprite(_ct_e, Vector2(40, 136), 4.0)
	var ct_f := CanvasTexture.new()
	_d_f = ImageTexture.create_from_image(_pattern(6))
	ct_f.diffuse_texture = _d_f
	_sprite(ct_f, Vector2(136, 136), 4.0)
	# NORM and SPEC: a lighting channel makes the entry unsupported (canvas-texture-channel).
	var ct_g := CanvasTexture.new()
	ct_g.diffuse_texture = ImageTexture.create_from_image(_pattern(7))
	ct_g.normal_texture = ImageTexture.create_from_image(_pattern(8))
	_sprite(ct_g, Vector2(232, 136), 4.0)
	var ct_h := CanvasTexture.new()
	ct_h.diffuse_texture = ImageTexture.create_from_image(_pattern(9))
	ct_h.specular_texture = ImageTexture.create_from_image(_pattern(10))
	_sprite(ct_h, Vector2(328, 136), 4.0)
	print("[fixture] gate8-ct ready: quit=%d" % _quit_frame)


func _process(_delta: float) -> void:
	if _failed:
		return
	_frame += 1
	for k: int in range(CHECKPOINTS.size()):
		var applied: int = CHECKPOINTS[k][0]
		var settle: int = CHECKPOINTS[k][1]
		if _frame == applied:
			if k == 1:
				_step_1()
			_log_step(k, applied, settle)
		if _frame == settle:
			_maybe_take_shot("step-%d.png" % k)
	if _frame >= _quit_frame:
		print("[fixture] quitting frame=%d" % _frame)
		get_tree().quit(0)


func _step_1() -> void:
	_ct_e.diffuse_texture = ImageTexture.create_from_image(_pattern(11))
	_d_f.update(_pattern(12))


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


static func _quad_mesh(side: float) -> ArrayMesh:
	var arrays: Array = []
	arrays.resize(Mesh.ARRAY_MAX)
	arrays[Mesh.ARRAY_VERTEX] = PackedVector2Array([Vector2(0, 0), Vector2(side, 0), Vector2(side, side), Vector2(0, side)])
	arrays[Mesh.ARRAY_TEX_UV] = PackedVector2Array([Vector2(0, 0), Vector2(1, 0), Vector2(1, 1), Vector2(0, 1)])
	arrays[Mesh.ARRAY_INDEX] = PackedInt32Array([0, 1, 2, 0, 2, 3])
	var mesh := ArrayMesh.new()
	mesh.add_surface_from_arrays(Mesh.PRIMITIVE_TRIANGLES, arrays)
	return mesh


func _sprite(texture: Texture2D, at: Vector2, scale_factor: float) -> Sprite2D:
	var sprite := Sprite2D.new()
	sprite.texture = texture
	sprite.centered = false
	sprite.position = at
	sprite.scale = Vector2(scale_factor, scale_factor)
	_root.add_child(sprite)
	return sprite


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
