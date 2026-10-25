extends Node
## Gate 5.5 vertex() fixture (P3-VX, ../../protocol/gate5_5-design.md "vertex() (P3-VX)").
##
## canvas_item ShaderMaterials with a vertex() function or a vertex render mode, so a receiver must
## run Godot 4.5.1's canvas.glsl vertex stage in its order (drivers/gles3/shaders/canvas.glsl:
## 179-280): COLOR = vertex colour x modulate before vertex(); world_vertex_coords applies the
## model matrix before the code, skip_vertex_transform never; otherwise the model matrix after the
## code, then the canvas transform, then the screen transform; varyings out of vertex() are
## interpolated unless `flat`.
##
## Canvas 0 (the root canvas): VH (STS2's settings-gear HSV shape: COLOR copied into a varying,
## under a non-white modulate), VP (a four-colour polygon through a smooth COLOR varying), VD
## (VERTEX displaced in local space on a 2x node), VU (UV transposed and flipped), VF (flat vec4
## and int varyings), VS1 (skip_vertex_transform without vertex()), VS2 (skip_vertex_transform
## with MODEL_MATRIX applied by the code), VW (world_vertex_coords), VT (TEXTURE_PIXEL_SIZE,
## AT_LIGHT_PASS, INSTANCE_CUSTOM) and VM (SCREEN_MATRIX * CANVAS_MATRIX * MODEL_MATRIX through a
## varying). Canvas 1 (a child CanvasLayer, offset (400, 120), scale 2): VC (skip_vertex_transform,
## MODEL_MATRIX and CANVAS_MATRIX in the code) and VLD (VERTEX displaced before both transforms).
##
## Every item is created in `_ready()`, after `GrcLoader` armed the capture (gate 0 route (a)).
## Steps: 1 sets VH's `s`, 2 moves VD, 3 moves the layer (a new CANVAS_MATRIX), 4 changes VP's
## modulate (folded into COLOR before vertex()).
##
## Environment (all optional; an invalid value prints an error and quits 2):
##   RS_FIXTURE_STEP_LOG     absolute path: one JSONL line per step at its applied frame
##   RS_FIXTURE_SHOT_DIR     absolute dir: step-<k>.png at each settle frame (rendered runs only)
##   RS_FIXTURE_START_FRAME  S >= 1, default 1
##   RS_FIXTURE_STEP_FRAMES  N >= 8, default 10 (step k >= 1 at S+N*k, settled at S+N*k+7)
##   RS_FIXTURE_QUIT_FRAME   >= S+N*4+11 (the default)

const LAST_STEP: int = 4
const SETTLE_OFFSET: int = 7
const START_FRAME_DEFAULT: int = 1
const STEP_FRAMES_DEFAULT: int = 10
const QUIT_AFTER_LAST_SETTLE: int = 4

const WHITE: Color = Color(1, 1, 1, 1)


## A `Node2D` drawing one rect, one texture rect (`texture` set) or one polygon (`colors` set).
class ShapeNode extends Node2D:
	var rect: Rect2 = Rect2()
	var color: Color = Color.WHITE
	var texture: Texture2D
	var colors: PackedColorArray = PackedColorArray()

	func _draw() -> void:
		if colors.size() == 4:
			var points: PackedVector2Array = PackedVector2Array([
				rect.position,
				rect.position + Vector2(rect.size.x, 0),
				rect.end,
				rect.position + Vector2(0, rect.size.y),
			])
			draw_polygon(points, colors)
		elif texture != null:
			draw_texture_rect(texture, rect, false)
		else:
			draw_rect(rect, color)


var tex: ImageTexture
var m_hsv: ShaderMaterial
var vd: ShapeNode
var vp: ShapeNode
var layer: CanvasLayer

var _failed: bool = false
var _frame: int = 0
var _start_frame: int = START_FRAME_DEFAULT
var _step_frames: int = STEP_FRAMES_DEFAULT
var _quit_frame: int = 0
var _shot_dir: String = ""
var _step_log_file: FileAccess


func _ready() -> void:
	if not _read_environment():
		_failed = true
		get_tree().quit(2)
		return

	tex = _pattern_texture()

	# Canvas 0, in draw order.
	m_hsv = _material("hsv")
	m_hsv.set_shader_parameter("h", 0.9)
	m_hsv.set_shader_parameter("s", 1.3)
	m_hsv.set_shader_parameter("v", 0.9)
	var vh: ShapeNode = _shape("VH", self, Vector2(16, 16), Rect2(0, 0, 96, 96), m_hsv)
	vh.texture = tex
	vh.modulate = Color(1, 0.8, 0.6, 1)
	vp = _shape("VP", self, Vector2(128, 16), Rect2(0, 0, 96, 96), _material("vary_color"))
	vp.colors = PackedColorArray([Color(0.8, 0.2, 0.2), Color(0.2, 0.8, 0.2), Color(0.2, 0.2, 0.8), Color(0.95, 0.95, 0.95)])
	vd = _shape("VD", self, Vector2(240, 16), Rect2(0, 0, 32, 32), _material("displace"))
	vd.scale = Vector2(2, 2)
	vd.color = Color(0.2, 0.6, 0.85, 1)
	var vu: ShapeNode = _shape("VU", self, Vector2(336, 16), Rect2(0, 0, 96, 96), _material("uv_flip"))
	vu.texture = tex
	_shape("VF", self, Vector2(448, 16), Rect2(0, 0, 64, 64), _material("flat"))
	_shape("VS1", self, Vector2(300, 200), Rect2(16, 128, 32, 32), _material("skip_plain"))
	_shape("VS2", self, Vector2(64, 0), Rect2(0, 128, 32, 32), _material("skip_model"))
	var vw: ShapeNode = _shape("VW", self, Vector2(112, 128), Rect2(0, 0, 16, 16), _material("world"))
	vw.scale = Vector2(2, 2)
	var vt: ShapeNode = _shape("VT", self, Vector2(176, 128), Rect2(0, 0, 32, 32), _material("builtins"))
	vt.texture = tex
	_shape("VM", self, Vector2(224, 128), Rect2(0, 0, 96, 64), _material("screen_matrix"))

	# Canvas 1: a scaled child CanvasLayer.
	layer = CanvasLayer.new()
	layer.name = "Layer1"
	layer.layer = 1
	layer.offset = Vector2(400, 120)
	layer.scale = Vector2(2, 2)
	add_child(layer)
	_shape("VC", layer, Vector2(8, 8), Rect2(0, 0, 16, 16), _material("canvas_skip"))
	_shape("VLD", layer, Vector2(40, 8), Rect2(0, 0, 16, 16), _material("layer_shift"))

	_log_step(0, 1, _start_frame + SETTLE_OFFSET)
	print("[fixture] gate55-vertex ready: S=%d N=%d quit=%d" % [_start_frame, _step_frames, _quit_frame])


func _process(_delta: float) -> void:
	if _failed:
		return
	_frame += 1

	var apply_step: int = _step_at(_frame, 0)
	if apply_step >= 1:
		_apply_step(apply_step)
		_log_step(apply_step, _frame, _frame + SETTLE_OFFSET)

	var settle_step: int = _step_at(_frame, SETTLE_OFFSET)
	if settle_step >= 0:
		_maybe_take_shot("step-%d.png" % settle_step)

	if _frame >= _quit_frame:
		print("[fixture] quitting frame=%d" % _frame)
		get_tree().quit(0)


func _apply_step(step: int) -> void:
	match step:
		1:
			m_hsv.set_shader_parameter("s", 0.7)
		2:
			vd.position = Vector2(248, 20)
		3:
			layer.offset = Vector2(408, 124)
		4:
			vp.modulate = Color(0.6, 1, 0.8, 1)


## A 32x32 RGBA8 pattern with a distinct colour per texel: r = 8x, g = 8y, b = 0.8 or 0.2 by
## 8-texel checker.
func _pattern_texture() -> ImageTexture:
	var image: Image = Image.create_empty(32, 32, false, Image.FORMAT_RGBA8)
	for y: int in range(32):
		for x: int in range(32):
			var checker: bool = ((x / 8) + (y / 8)) % 2 == 0
			image.set_pixel(x, y, Color8(x * 8, y * 8, 204 if checker else 51, 255))
	return ImageTexture.create_from_image(image)


func _material(shader_name: String) -> ShaderMaterial:
	var resource: Resource = load("res://shaders/%s.gdshader" % shader_name)
	var material: ShaderMaterial = ShaderMaterial.new()
	material.shader = resource as Shader
	return material


func _shape(node_name: String, parent: Node, at: Vector2, rect: Rect2, material: ShaderMaterial) -> ShapeNode:
	var node: ShapeNode = ShapeNode.new()
	node.name = node_name
	node.position = at
	node.rect = rect
	node.material = material
	node.texture_filter = CanvasItem.TEXTURE_FILTER_NEAREST
	parent.add_child(node)
	return node


func _read_environment() -> bool:
	var start: int = _int_env("RS_FIXTURE_START_FRAME", START_FRAME_DEFAULT, 1)
	var span: int = _int_env("RS_FIXTURE_STEP_FRAMES", STEP_FRAMES_DEFAULT, SETTLE_OFFSET + 1)
	if start < 0 or span < 0:
		return false
	_start_frame = start
	_step_frames = span
	var quit_default: int = _start_frame + _step_frames * LAST_STEP + SETTLE_OFFSET + QUIT_AFTER_LAST_SETTLE
	var quit: int = _int_env("RS_FIXTURE_QUIT_FRAME", quit_default, quit_default)
	if quit < 0:
		return false
	_quit_frame = quit

	var step_log: String = _path_env("RS_FIXTURE_STEP_LOG")
	var shot_dir: String = _path_env("RS_FIXTURE_SHOT_DIR")
	if step_log == "!" or shot_dir == "!":
		return false
	_shot_dir = shot_dir
	if step_log != "":
		_step_log_file = FileAccess.open(step_log, FileAccess.WRITE)
		if _step_log_file == null:
			_error("cannot open RS_FIXTURE_STEP_LOG=%s" % step_log)
			return false
	return true


## The integer value of `name`, `fallback` when unset, -1 (after printing why) when invalid.
func _int_env(name: String, fallback: int, minimum: int) -> int:
	if not OS.has_environment(name):
		return fallback
	var text: String = OS.get_environment(name).strip_edges()
	if not text.is_valid_int() or text.to_int() < minimum:
		_error("%s must be an integer >= %d (got %s)" % [name, minimum, JSON.stringify(text)])
		return -1
	return text.to_int()


## The absolute path in `name`, "" when unset, "!" (after printing why) when invalid.
func _path_env(name: String) -> String:
	if not OS.has_environment(name):
		return ""
	var text: String = OS.get_environment(name)
	if text == "" or not text.is_absolute_path():
		_error("%s must be an absolute path (got %s)" % [name, JSON.stringify(text)])
		return "!"
	return text


func _error(text: String) -> void:
	printerr("[fixture] error: " + text)


## The step whose frame S + N*k + offset is `frame` (step 0 included), else -1.
func _step_at(frame: int, offset: int) -> int:
	var since: int = frame - _start_frame - offset
	if since < 0 or since % _step_frames != 0:
		return -1
	var step: int = since / _step_frames
	return step if step <= LAST_STEP else -1


func _log_step(step: int, applied_frame: int, settle_frame: int) -> void:
	if _step_log_file == null:
		return
	_step_log_file.store_line("{\"step\":%d,\"applied_frame\":%d,\"settle_frame\":%d}" % [step, applied_frame, settle_frame])
	_step_log_file.flush()


## Rendered runs only: headless has no draw path, so frame_post_draw never fires there. Called
## without `await` from `_process`, so the coroutine finishes while frames keep advancing.
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
