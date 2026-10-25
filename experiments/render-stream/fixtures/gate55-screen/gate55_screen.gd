extends Node
## Gate 5.5 screen-texture fixture (P3-ST, ../../protocol/gate5_5-design.md "Screen texture (P3-ST)").
##
## Screen-reading `ShaderMaterial`s (`hint_screen_texture`) over textured content, so a receiver
## must take GLES3's back-buffer copies at the same points as the reference
## (drivers/gles3/rasterizer_canvas_gles3.cpp:397-540):
##
## - Canvas 0 (the root canvas): three nearest-filtered textures, then RA (invert): the first
##   screen reader, so the automatic full copy is taken right before it. LC, a solid rect drawn
##   after RA, sits entirely under RB (swizzle): the second reader in the same canvas reuses RA's
##   copy (`material_screen_texture_cached`), so RB shows T2 without LC and LC is never visible.
##   RF reads SCREEN_UV itself (the orientation probe). RE (blur) samples a mip level with a mipmap
##   filter: the copy is cached without mips, so GLES3 builds the gaussian mip chain of that same
##   copy at RE (`material_screen_texture_mipmaps_cached`), still without RA, LC, RB or RF. RT
##   reads the screen and TIME: the capture refuses its shader (shader-time), and receivers drop
##   the item (gate5_5-design.md "Refused materials"), so the back buffer itself shows there.
## - Canvas 1 (a child `CanvasLayer`, layer 1): a new `canvas_render_items` call resets the cache,
##   so RC (invert) gets a fresh copy of everything canvas 0 drew (RA's and RB's outputs included).
##   RD (swizzle) is the second reader there, inside a clipping `Control` (`clip_contents`) over
##   RB's output, T2 and the clear colour: its output is clipped, its copy is RC's.
##
## Every item is created in `_ready()`, after `GrcLoader` armed the capture (gate 0 route (a)).
## Steps 1 to 5 move content so a stale copy (from an earlier frame) shows: T1's texture offset,
## LC, the layer's offset, RE's mix and lod, and T2's texture.
##
## Environment (all optional; an invalid value prints an error and quits 2):
##   RS_FIXTURE_STEP_LOG     absolute path: one JSONL line per step at its applied frame
##   RS_FIXTURE_SHOT_DIR     absolute dir: step-<k>.png at each settle frame (rendered runs only)
##   RS_FIXTURE_START_FRAME  S >= 1, default 1
##   RS_FIXTURE_STEP_FRAMES  N >= 8, default 10 (step k >= 1 at S+N*k, settled at S+N*k+7)
##   RS_FIXTURE_QUIT_FRAME   >= S+N*5+11 (the default)

const LAST_STEP: int = 5
const SETTLE_OFFSET: int = 7
const START_FRAME_DEFAULT: int = 1
const STEP_FRAMES_DEFAULT: int = 10
const QUIT_AFTER_LAST_SETTLE: int = 4

const WHITE: Color = Color(1, 1, 1, 1)
const LC_COLOUR: Color = Color(0.8, 0.4, 0, 1)
const T_SIZE: Vector2 = Vector2(128, 128)


## A `Node2D` drawing one rect, or one texture rect when `texture` is set.
class RectNode extends Node2D:
	var rect: Rect2 = Rect2()
	var color: Color = Color.WHITE
	var texture: Texture2D

	func _draw() -> void:
		if texture != null:
			draw_texture_rect(texture, rect, false)
		else:
			draw_rect(rect, color)

	func redraw_with(new_rect: Rect2, new_texture: Texture2D) -> void:
		rect = new_rect
		texture = new_texture
		queue_redraw()


var tex_a: ImageTexture
var tex_b: ImageTexture
var sh_invert: Shader
var sh_swizzle: Shader
var sh_screen_uv: Shader
var sh_blur: Shader
var sh_time_screen: Shader
var m_blur: ShaderMaterial
var t1: RectNode
var t2: RectNode
var lc: RectNode
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

	tex_a = _pattern_texture(false)
	tex_b = _pattern_texture(true)
	sh_invert = _load_shader("res://shaders/invert.gdshader")
	sh_swizzle = _load_shader("res://shaders/swizzle.gdshader")
	sh_screen_uv = _load_shader("res://shaders/screen_uv.gdshader")
	sh_blur = _load_shader("res://shaders/blur.gdshader")
	sh_time_screen = _load_shader("res://shaders/time_screen.gdshader")

	# Canvas 0, in draw order.
	t1 = _texture_node("T1", Vector2(16, 16), tex_a)
	t2 = _texture_node("T2", Vector2(176, 16), tex_b)
	_texture_node("T3", Vector2(416, 16), tex_a)
	_reader("RA", Rect2(48, 48, 64, 64), _material(sh_invert), self)
	lc = _rect_node("LC", Rect2(208, 48, 32, 32), LC_COLOUR, self)
	_reader("RB", Rect2(192, 32, 96, 96), _material(sh_swizzle), self)
	_reader("RF", Rect2(336, 160, 64, 64), _material(sh_screen_uv), self)
	m_blur = _material(sh_blur)
	_reader("RE", Rect2(432, 32, 96, 96), m_blur, self)
	_reader("RT", Rect2(16, 120, 24, 24), _material(sh_time_screen), self)

	# Canvas 1: a child CanvasLayer.
	layer = CanvasLayer.new()
	layer.name = "Layer1"
	layer.layer = 1
	add_child(layer)
	_reader("RC", Rect2(64, 96, 96, 64), _material(sh_invert), layer)
	var clip: Control = Control.new()
	clip.name = "Clip"
	clip.position = Vector2(176, 100)
	clip.size = Vector2(64, 64)
	clip.clip_contents = true
	clip.mouse_filter = Control.MOUSE_FILTER_IGNORE
	layer.add_child(clip)
	# RD's rect is larger than the clip on every side (local to the clip control).
	_reader("RD", Rect2(-16, -20, 128, 96), _material(sh_swizzle), clip)

	_log_step(0, 1, _start_frame + SETTLE_OFFSET)
	print("[fixture] gate55-screen ready: S=%d N=%d quit=%d" % [_start_frame, _step_frames, _quit_frame])


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
			# T1's texture shifts right by 8 px inside its node (RA reads the new content).
			t1.redraw_with(Rect2(Vector2(8, 0), T_SIZE), tex_a)
		2:
			# LC moves; it stays entirely under RB.
			lc.redraw_with(Rect2(232, 56, 32, 32), null)
		3:
			# The layer moves: RC and RD read a different part of canvas 0.
			layer.offset = Vector2(8, 4)
		4:
			m_blur.set_shader_parameter("mix_amount", 0.4)
			m_blur.set_shader_parameter("lod", 1.0)
		5:
			# T2 swaps textures: RB and RD (through RB) change, RA does not.
			t2.redraw_with(Rect2(Vector2.ZERO, T_SIZE), tex_a)


## A 32x32 RGBA8 pattern with a distinct colour per texel along both axes (drawn at 4x, nearest):
## r = 8x, g = 8y, b = 0.8 or 0.2 by 8-texel checker; `transposed` swaps x and y and inverts b.
func _pattern_texture(transposed: bool) -> ImageTexture:
	var image: Image = Image.create_empty(32, 32, false, Image.FORMAT_RGBA8)
	for y: int in range(32):
		for x: int in range(32):
			var u: int = y if transposed else x
			var v: int = x if transposed else y
			var checker: bool = ((u / 8) + (v / 8)) % 2 == 0
			if transposed:
				checker = not checker
			image.set_pixel(x, y, Color8(u * 8, v * 8, 204 if checker else 51, 255))
	return ImageTexture.create_from_image(image)


func _load_shader(path: String) -> Shader:
	var resource: Resource = load(path)
	var shader: Shader = resource as Shader
	return shader


func _material(shader: Shader) -> ShaderMaterial:
	var material: ShaderMaterial = ShaderMaterial.new()
	material.shader = shader
	return material


func _texture_node(node_name: String, at: Vector2, texture: Texture2D) -> RectNode:
	var node: RectNode = RectNode.new()
	node.name = node_name
	node.position = at
	node.rect = Rect2(Vector2.ZERO, T_SIZE)
	node.texture = texture
	node.texture_filter = CanvasItem.TEXTURE_FILTER_NEAREST
	add_child(node)
	return node


func _rect_node(node_name: String, rect: Rect2, colour: Color, parent: Node) -> RectNode:
	var node: RectNode = RectNode.new()
	node.name = node_name
	node.rect = rect
	node.color = colour
	parent.add_child(node)
	return node


func _reader(node_name: String, rect: Rect2, material: ShaderMaterial, parent: Node) -> RectNode:
	var node: RectNode = _rect_node(node_name, rect, WHITE, parent)
	node.material = material
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
