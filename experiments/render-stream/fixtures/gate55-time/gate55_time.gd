extends Node
## Gate 5.5 TIME and sampler-default fixture (P3-TM, ../../protocol/gate5_5-design.md "TIME and
## sampler defaults (P3-TM)").
##
## canvas_item ShaderMaterials that read TIME, which Godot 4.5.1's GLES3 rasterizer advances by
## every drawn frame's scaled step (drivers/gles3/rasterizer_gles3.cpp:97-107), and samplers left
## unset under each default hint, which GLES3 binds to its default textures
## (drivers/gles3/storage/material_storage.cpp:928-953). Run with `--fixed-fps 60`, every frame's
## step is 1/60, so TIME at frame F is F steps of 1/60 summed.
##
## Canvas 0 (the root canvas): TP (a sine pulse in TIME through a helper), TS (UV scrolling with
## TIME over a repeating texture), TV (TIME in vertex(): a whole-pixel shift down), and a row of
## 48x48 rects whose sampler `s` is never set: D0 (no hint), DW (hint_default_white), DB
## (hint_default_black), DT (hint_default_transparent), DN (hint_normal), DR
## (hint_roughness_normal), DA (hint_anisotropy), and DS (hint_default_black, set at step 2 and
## cleared at step 3).
##
## TH (P3-CK): a fine band in a half-float (RGBAH) texture's alpha, phased by TIME: GLES3 samples
## the texture at half precision, which an RGBA8 copy of it cannot reproduce.
##
## Every item is created in `_ready()`, after `GrcLoader` armed the capture (gate 0 route (a)).
## Steps: 1 sets TP's `tint`, 2 sets DS's texture, 3 clears it, 4 changes nothing (TIME alone).
##
## Variant `stall` (RS_FIXTURE_VARIANT=stall, P3-CK): run in real time (no --fixed-fps) with the
## capture armed in the rendered host. It adds TC, a clock that writes floor(TIME*1024) into its
## RGB bytes, and stalls the main loop for STALL_MS at each STALL_FRAMES frame. An iteration that
## long wants more physics steps than `max_physics_steps_per_frame` (8), so the next iteration's
## tree delta is clamped (main.cpp:4710-4713) while the draw's TIME step is not. Each stall prints
## `[fixture] stall frame=.. ms=.. next_frame=.. next_delta=..` (the next iteration's tree delta).
##
## Environment (all optional; an invalid value prints an error and quits 2):
##   RS_FIXTURE_STEP_LOG     absolute path: one JSONL line per step at its applied frame
##   RS_FIXTURE_SHOT_DIR     absolute dir: step-<k>.png at each settle frame (rendered runs only)
##   RS_FIXTURE_START_FRAME  S >= 1, default 1
##   RS_FIXTURE_STEP_FRAMES  N >= 8, default 10 (step k >= 1 at S+N*k, settled at S+N*k+7)
##   RS_FIXTURE_QUIT_FRAME   >= S+N*4+11 (the default)
##   RS_FIXTURE_VARIANT      "" (default) or "stall"

const LAST_STEP: int = 4
const SETTLE_OFFSET: int = 7
const START_FRAME_DEFAULT: int = 1
const STEP_FRAMES_DEFAULT: int = 10
const QUIT_AFTER_LAST_SETTLE: int = 4

const DEFAULTS: Array[String] = ["plain", "white", "black", "transparent", "normal", "roughness_normal", "anisotropy"]
const DEFAULT_NAMES: Array[String] = ["D0", "DW", "DB", "DT", "DN", "DR", "DA"]
## TH's ramp: texel i of 256 has alpha 0.25 + i/512, exact in binary16.
const RAMP_TEXELS: int = 256
## The stall variant: a STALL_MS main-loop stall in _process at each of these frames (between
## settle frames 8, 18, 28, 38 and 48).
const STALL_FRAMES: Array[int] = [12, 22, 32, 42]
const STALL_MS: int = 300


## A `Node2D` drawing one rect, or one texture rect when `texture` is set.
class ShapeNode extends Node2D:
	var rect: Rect2 = Rect2()
	var color: Color = Color.WHITE
	var texture: Texture2D

	func _draw() -> void:
		if texture != null:
			draw_texture_rect(texture, rect, false)
		else:
			draw_rect(rect, color)


var m_pulse: ShaderMaterial
var m_set: ShaderMaterial
var set_texture: ImageTexture

var _failed: bool = false
var _frame: int = 0
var _start_frame: int = START_FRAME_DEFAULT
var _step_frames: int = STEP_FRAMES_DEFAULT
var _quit_frame: int = 0
var _shot_dir: String = ""
var _step_log_file: FileAccess
var _variant: String = ""
var _stalled_at: int = -1


func _ready() -> void:
	if not _read_environment():
		_failed = true
		get_tree().quit(2)
		return

	m_pulse = _material("pulse")
	_shape("TP", Vector2(16, 16), Rect2(0, 0, 96, 96), m_pulse)
	var m_scroll: ShaderMaterial = _material("scroll")
	m_scroll.set_shader_parameter("stripes", _stripes_texture())
	_shape("TS", Vector2(128, 16), Rect2(0, 0, 96, 96), m_scroll)
	_shape("TV", Vector2(240, 16), Rect2(0, 0, 32, 32), _material("shift"))
	for i: int in range(DEFAULTS.size()):
		_shape(DEFAULT_NAMES[i], Vector2(16 + 64 * i, 160), Rect2(0, 0, 48, 48), _material("default_" + DEFAULTS[i]))
	m_set = _material("default_black")
	_shape("DS", Vector2(464, 160), Rect2(0, 0, 48, 48), m_set)
	set_texture = _solid_texture(Color8(200, 100, 50, 255))
	var th: ShapeNode = _shape("TH", Vector2(16, 240), Rect2(0, 0, RAMP_TEXELS, 16), _material("half_band"))
	th.texture = _half_ramp_texture()
	if _variant == "stall":
		_shape("TC", Vector2(288, 240), Rect2(0, 0, 32, 16), _material("clock"))

	_log_step(0, 1, _start_frame + SETTLE_OFFSET)
	print("[fixture] gate55-time ready: S=%d N=%d quit=%d variant=%s" % [_start_frame, _step_frames, _quit_frame, _variant])


func _process(_delta: float) -> void:
	if _failed:
		return
	_frame += 1

	if _stalled_at >= 0:
		# The iteration after a stall: the tree's (clamped) delta and the physics steps it ran.
		print("[fixture] stall frame=%d ms=%d next_frame=%d next_delta=%s" % [_stalled_at, STALL_MS, _frame, var_to_str(get_process_delta_time())])
		_stalled_at = -1
	if _variant == "stall" and STALL_FRAMES.has(_frame):
		OS.delay_msec(STALL_MS)
		_stalled_at = _frame

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
			m_pulse.set_shader_parameter("tint", Vector4(0.5, 1.0, 0.75, 1.0))
		2:
			m_set.set_shader_parameter("s", set_texture)
		3:
			m_set.set_shader_parameter("s", null)
		4:
			pass


## A 16x16 RGBA8 texture of four 4-texel vertical stripes (the scroll's pattern).
func _stripes_texture() -> ImageTexture:
	var colors: Array[Color] = [Color8(230, 60, 60), Color8(60, 200, 90), Color8(70, 90, 220), Color8(240, 220, 80)]
	var image: Image = Image.create_empty(16, 16, false, Image.FORMAT_RGBA8)
	for y: int in range(16):
		for x: int in range(16):
			image.set_pixel(x, y, colors[x / 4])
	return ImageTexture.create_from_image(image)


## TH's RAMP_TEXELS x 1 RGBAH texture: white, alpha 0.25 + i/512 at texel i (each exact in binary16).
func _half_ramp_texture() -> ImageTexture:
	var data: PackedByteArray = PackedByteArray()
	data.resize(RAMP_TEXELS * 8)
	for i: int in range(RAMP_TEXELS):
		for c: int in range(3):
			data.encode_half(i * 8 + c * 2, 1.0)
		data.encode_half(i * 8 + 6, 0.25 + float(i) / 512.0)
	var image: Image = Image.create_from_data(RAMP_TEXELS, 1, false, Image.FORMAT_RGBAH, data)
	return ImageTexture.create_from_image(image)


## A 4x4 single-colour RGBA8 texture.
func _solid_texture(color: Color) -> ImageTexture:
	var image: Image = Image.create_empty(4, 4, false, Image.FORMAT_RGBA8)
	image.fill(color)
	return ImageTexture.create_from_image(image)


func _material(shader_name: String) -> ShaderMaterial:
	var resource: Resource = load("res://shaders/%s.gdshader" % shader_name)
	var material: ShaderMaterial = ShaderMaterial.new()
	material.shader = resource as Shader
	return material


func _shape(node_name: String, at: Vector2, rect: Rect2, material: ShaderMaterial) -> ShapeNode:
	var node: ShapeNode = ShapeNode.new()
	node.name = node_name
	node.position = at
	node.rect = rect
	node.material = material
	node.texture_filter = CanvasItem.TEXTURE_FILTER_NEAREST
	add_child(node)
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

	_variant = OS.get_environment("RS_FIXTURE_VARIANT")
	if _variant != "" and _variant != "stall":
		_error("RS_FIXTURE_VARIANT must be \"\" or \"stall\" (got %s)" % JSON.stringify(_variant))
		return false
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
