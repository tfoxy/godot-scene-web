extends Node
## Gate 5.5 ShaderMaterial fixture (../../protocol/gate5_5-design.md "Q6c", G55c).
##
## The root is a plain `Node`. Every `CanvasItem`, `Shader`, `ShaderMaterial` and texture is
## created in `_ready()`, after `GrcLoader` armed the capture extension in its own `_enter_tree()`
## (gate 0 route (a)), so the hooks see every `shader_create_from_code`,
## `shader_set_default_texture_parameter`, `material_create_from_shader`, `material_set_param`,
## `canvas_item_set_material` and `canvas_item_set_instance_shader_parameter`. Item construction
## order is expected.json `creation_order` (wire item ids); shader and material creation orders are
## its `shader_order` and `material_order`. make_expected.py models the same scene from its own copy
## of these numbers; the two must agree.
##
## Every shader is synthetic, written for this fixture, and lives in shaders/ (`fragment()` last).
## `Shader` and `ShaderMaterial` create their RIDs lazily (scene/resources/shader.cpp:54-60,
## material.cpp:494-517): a shader's RID on its first `get_rid()` (assigning it to a material, or
## `set_default_texture_parameter`), a material's on its first `get_rid()` (assigning it to an item),
## with the parameters cached before that sent right after `material_create_from_shader`.
##
## Environment (all optional; an invalid value prints an error and quits 2):
##   RS_FIXTURE_STEP_LOG     absolute path: one JSONL line per step at its applied frame
##   RS_FIXTURE_SHOT_DIR     absolute dir: step-<k>.png at each settle frame (rendered runs only)
##   RS_FIXTURE_MATERIAL_LOG absolute path: the material oracle (material_oracle.gd), one JSONL line
##                           per settle frame. Reference legs only: refused (exit 2) when any GRC_*
##                           capture variable is set.
##   RS_FIXTURE_START_FRAME  S >= 1, default 1
##   RS_FIXTURE_STEP_FRAMES  N >= 8, default 10 (step k >= 1 at S+N*k, settled at S+N*k+7)
##   RS_FIXTURE_QUIT_FRAME   >= S+N*9+11 (the default)
##   RS_FIXTURE_VARIANT      `refused` adds the TIME, screen-texture, SDF, global-uniform and
##                           spatial regions (Q6c); anything else is refused. The policy variants
##                           are capture settings (GRC_SHADER_POLICY), not scene changes.

const MaterialOracle := preload("res://material_oracle.gd")

const LAST_STEP: int = 9
const SETTLE_OFFSET: int = 7
const START_FRAME_DEFAULT: int = 1
const STEP_FRAMES_DEFAULT: int = 10
const QUIT_AFTER_LAST_SETTLE: int = 4
const VARIANTS: Array[String] = ["refused"]

## The capture variables whose presence refuses the oracle (it runs on reference legs only).
const CAPTURE_VARIABLES: Array[String] = ["GRC_EXTENSION", "GRC_MODE", "GRC_CALIBRATION", "GRC_EVIDENCE_DIR", "GRC_STREAM_OUT"]

## Gate 3's marker colours (gate 1's first ten).
const MARKER_COLORS: Array[Color] = [
	Color(0, 0, 0, 1),
	Color(1, 1, 0, 1),
	Color(0, 1, 1, 1),
	Color(0.4, 0, 0.4, 1),
	Color(0, 0.4, 0, 1),
	Color(0.4, 0, 0, 1),
	Color(0, 0, 0.4, 1),
	Color(0.8, 0.4, 0.8, 1),
	Color(0.4, 0.6, 0.8, 1),
	Color(0.8, 0.6, 0.4, 1),
]

## Q6a's TEX16 and TEX16B: 16x16 RGBA8, four 8x8 quadrants (top-left, top-right, bottom-left,
## bottom-right).
const TEX16_QUADRANTS: Array[Color] = [Color(1, 0.4, 0.2, 1), Color(0.2, 0.8, 0.4, 1), Color(0.4, 0.2, 1, 1), Color(1, 1, 0.2, 1)]
const TEX16B_QUADRANTS: Array[Color] = [Color(0.2, 0.6, 0.8, 1), Color(0.8, 0.2, 0.2, 1), Color(0.6, 1, 0.6, 1), Color(0, 0.4, 0.4, 1)]

const RECT: Rect2 = Rect2(0, 0, 56, 48)
const SQUARE: Rect2 = Rect2(0, 0, 48, 48)
const PA_RECT: Rect2 = Rect2(8, 8, 32, 32)
const WHITE: Color = Color(1, 1, 1, 1)
## What a refused item draws under its material (and so what it shows without one).
const REFUSED_DRAW: Color = Color(0.4, 0.6, 0.2, 1)

const MT_TINT: Color = Color(0.4, 0.8, 0.4, 1)
const MT_GAIN: float = 0.5
const MT_TINT_STEP1: Color = Color(0.8, 0.4, 0, 1)
const MP_MUL: Color = Color(1, 1, 1, 1)
const I1_INST: Color = Color(0.2, 0.8, 0.4, 1)
const I2_INST_STEP2: Color = Color(0.8, 0.2, 0.6, 1)
const MY_K: int = 1
const MY_K_STEP7: int = 3
const MY_F: float = 0.6
const MY_V2: Vector2 = Vector2(0.4, 0)
const MY_V3: Vector3 = Vector3(0, 0.8, 0)
const MY_IV: Vector2i = Vector2i(0, 3)
const MY_LV: Array[float] = [0.2, 0.4, 0.6, 0.8]
const MR_TINT: Color = Color(0.8, 0.8, 0.2, 1)
const MR2_TINT: Color = Color(0.2, 0.8, 0.8, 1)

## Declared parameter names per material, sorted (what the oracle reads back).
const PARAMS_TINT: Array[String] = ["gain", "tint"]
const PARAMS_PAL: Array[String] = ["mul", "pal"]
const PARAMS_TYPES: Array[String] = ["f", "iv", "k", "lv", "on", "v2", "v3"]
const PARAMS_PHASE: Array[String] = ["phase"]
const PARAMS_NONE: Array[String] = []
const REFUSED: Array[String] = ["time", "screen", "sdf", "global", "spatial"]
const REFUSED_ITEMS: Array[String] = ["TM", "SC", "SD", "GU", "SP"]
const REFUSED_POSITIONS: Array[Vector2] = [Vector2(208, 128), Vector2(296, 128), Vector2(384, 128), Vector2(472, 128), Vector2(32, 224)]


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

	func set_color(new_color: Color) -> void:
		color = new_color
		queue_redraw()


var tex16: ImageTexture
var tex16b: ImageTexture
var sh_tint: Shader
var sh_pal: Shader
var sh_inst: Shader
var sh_types: Shader
var sh_phase: Shader
var sh_a: Shader
var sh_b: Shader
var sh_refused: Array[Shader] = []
var mt: ShaderMaterial
var mp: ShaderMaterial
var mi: ShaderMaterial
var my: ShaderMaterial
var mph: ShaderMaterial
var mr: ShaderMaterial
var mr2: ShaderMaterial
var ms: ShaderMaterial
var m_refused: Array[ShaderMaterial] = []
var ti: RectNode
var pa: RectNode
var i1: RectNode
var i2: RectNode
var ty: RectNode
var ph: RectNode
var rm: RectNode
var sh: RectNode
var refused_items: Array[RectNode] = []
var marker: RectNode

var _variant: String = ""
var _frame: int = 0
var _start_frame: int = START_FRAME_DEFAULT
var _step_frames: int = STEP_FRAMES_DEFAULT
var _quit_frame: int = 0
var _shot_dir: String = ""
var _step_log_file: FileAccess
var _oracle: MaterialOracle
var _failed: bool = false


func _ready() -> void:
	if not _read_environment():
		_failed = true
		get_tree().quit(2)
		return

	# TEX16 and TEX16B (Q6a), after the engine's hue strip.
	tex16 = _quadrant_texture(TEX16_QUADRANTS)
	tex16b = _quadrant_texture(TEX16B_QUADRANTS)

	# Loading a .gdshader preprocesses its code (the include becomes @@> / @@< markers) but makes
	# no RID (shader.cpp:85-135, :54-60).
	sh_tint = _load_shader("res://shaders/tint.gdshader")
	sh_pal = _load_shader("res://shaders/pal.gdshader")
	sh_inst = _load_shader("res://shaders/inst.gdshader")
	sh_types = _load_shader("res://shaders/types.gdshader")
	sh_phase = _load_shader("res://shaders/phase.gdshader")
	sh_a = _load_shader("res://shaders/sh_a.gdshader")

	# pal's default texture forces its RID: shader_create_from_code, then the default texture.
	sh_pal.set_default_texture_parameter("pal", tex16)

	# Materials and items in expected.json's orders. Assigning a shader to a material makes the
	# shader's RID; assigning the material to an item makes the material's RID.
	mt = _material(sh_tint)
	mt.set_shader_parameter("tint", MT_TINT)
	mt.set_shader_parameter("gain", MT_GAIN)
	ti = _rect_node("TI", Vector2(32, 32), RECT, WHITE)
	ti.material = mt

	mp = _material(sh_pal)
	mp.set_shader_parameter("mul", MP_MUL)
	pa = _rect_node("PA", Vector2(120, 24), PA_RECT, WHITE)
	pa.texture = tex16
	pa.texture_filter = CanvasItem.TEXTURE_FILTER_NEAREST
	pa.material = mp

	mi = _material(sh_inst)
	i1 = _rect_node("I1", Vector2(208, 32), SQUARE, WHITE)
	i1.material = mi
	i2 = _rect_node("I2", Vector2(264, 32), SQUARE, WHITE)
	i2.material = mi
	i1.set_instance_shader_parameter("inst_color", I1_INST)

	my = _material(sh_types)
	my.set_shader_parameter("on", false)
	my.set_shader_parameter("k", MY_K)
	my.set_shader_parameter("f", MY_F)
	my.set_shader_parameter("v2", MY_V2)
	my.set_shader_parameter("v3", MY_V3)
	my.set_shader_parameter("iv", MY_IV)
	my.set_shader_parameter("lv", PackedFloat32Array(MY_LV))
	ty = _rect_node("TY", Vector2(344, 32), RECT, WHITE)
	ty.material = my

	mph = _material(sh_phase)
	ph = _rect_node("PH", Vector2(432, 32), RECT, WHITE)
	ph.material = mph

	mr = _material(sh_tint)
	mr.set_shader_parameter("tint", MR_TINT)
	rm = _rect_node("RM", Vector2(32, 128), RECT, WHITE)
	rm.material = mr

	ms = _material(sh_a)
	sh = _rect_node("SH", Vector2(120, 128), RECT, WHITE)
	sh.material = ms

	if _variant == "refused":
		for k: int in range(REFUSED.size()):
			var shader: Shader = _load_shader("res://shaders/refused/%s.gdshader" % REFUSED[k])
			sh_refused.append(shader)
			var material: ShaderMaterial = _material(shader)
			m_refused.append(material)
			var node: RectNode = _rect_node(REFUSED_ITEMS[k], REFUSED_POSITIONS[k], RECT, REFUSED_DRAW)
			node.material = material
			refused_items.append(node)

	marker = _rect_node("Marker", Vector2(592, 16), Rect2(0, 0, 32, 32), MARKER_COLORS[0])

	for node: RectNode in [ti, pa, i1, i2, ty, ph, rm, sh]:
		add_child(node)
	for node: RectNode in refused_items:
		add_child(node)
	add_child(marker)

	_log_step(0, 1, _start_frame + SETTLE_OFFSET)
	print("[fixture] gate55-shader ready: S=%d N=%d quit=%d variant=%s oracle=%s" % [_start_frame, _step_frames, _quit_frame, _variant if _variant != "" else "none", "on" if _oracle != null else "off"])


func _process(_delta: float) -> void:
	if _failed:
		return
	_frame += 1

	# PH: the fixture frame counter, written every frame (Q6c).
	mph.set_shader_parameter("phase", _frame)

	var apply_step: int = _step_at(_frame, 0)
	if apply_step >= 1:
		_apply_step(apply_step)
		_log_step(apply_step, _frame, _frame + SETTLE_OFFSET)

	var settle_step: int = _step_at(_frame, SETTLE_OFFSET)
	if settle_step >= 0:
		if _oracle != null:
			_oracle.record(settle_step, _frame, _oracle_shaders(settle_step), _oracle_materials(settle_step), _oracle_items(), {"TEX16": tex16.get_rid(), "TEX16B": tex16b.get_rid()})
		_maybe_take_shot("step-%d.png" % settle_step)

	if _frame >= _quit_frame:
		print("[fixture] quitting frame=%d" % _frame)
		get_tree().quit(0)


## gate5_5-design.md Q6c's timeline (as built: see README).
func _apply_step(step: int) -> void:
	match step:
		1:
			mt.set_shader_parameter("tint", MT_TINT_STEP1)
		2:
			i2.set_instance_shader_parameter("inst_color", I2_INST_STEP2)
		3:
			# The tint Shader's code becomes tint_b: one shader_set_code on the same RID.
			sh_tint.code = FileAccess.get_file_as_string("res://shaders/tint_b.gdshader")
		4:
			mt.set_shader_parameter("gain", null)
		5:
			# Recreation: RM's item holds the only reference to MR, so assigning MR2 frees MR before
			# MR2's RID is made (canvas_item.cpp:1169-1177).
			mr2 = _material(sh_tint)
			mr2.set_shader_parameter("tint", MR2_TINT)
			mr = null
			rm.material = mr2
		6:
			mp.set_shader_parameter("pal", tex16b)
		7:
			my.set_shader_parameter("on", true)
			my.set_shader_parameter("k", MY_K_STEP7)
		8:
			# sh_b's RID is made by the assignment; sh_a's last reference goes with it.
			sh_b = _load_shader("res://shaders/sh_b.gdshader")
			ms.shader = sh_b
			sh_a = null
		9:
			get_viewport().canvas_transform = Transform2D(0.0, Vector2(8, 4))
	marker.set_color(MARKER_COLORS[step])


func _quadrant_texture(colours: Array[Color]) -> ImageTexture:
	var image: Image = Image.create_empty(16, 16, false, Image.FORMAT_RGBA8)
	for q: int in range(4):
		image.fill_rect(Rect2i((q % 2) * 8, (q / 2) * 8, 8, 8), colours[q])
	return ImageTexture.create_from_image(image)


func _load_shader(path: String) -> Shader:
	var resource: Resource = load(path)
	var shader: Shader = resource as Shader
	return shader


func _material(shader: Shader) -> ShaderMaterial:
	var material: ShaderMaterial = ShaderMaterial.new()
	material.shader = shader
	return material


func _rect_node(node_name: String, at: Vector2, rect: Rect2, colour: Color) -> RectNode:
	var node: RectNode = RectNode.new()
	node.name = node_name
	node.position = at
	node.rect = rect
	node.color = colour
	return node


## The oracle's view of which fixture shader is which, in creation order (expected.json
## shader_order).
func _oracle_shaders(step: int) -> Array[Dictionary]:
	var out: Array[Dictionary] = [
		{"name": "pal", "status": "live", "shader": sh_pal},
		{"name": "tint", "status": "live", "shader": sh_tint},
		{"name": "inst", "status": "live", "shader": sh_inst},
		{"name": "types", "status": "live", "shader": sh_types},
		{"name": "phase", "status": "live", "shader": sh_phase},
		{"name": "sh_a", "status": "freed" if step >= 8 else "live", "shader": sh_a},
	]
	for k: int in range(sh_refused.size()):
		out.append({"name": REFUSED[k], "status": "live", "shader": sh_refused[k]})
	out.append({"name": "sh_b", "status": "live" if step >= 8 else "absent", "shader": sh_b})
	return out


## The same for materials (expected.json material_order) with their declared parameter names.
func _oracle_materials(step: int) -> Array[Dictionary]:
	var out: Array[Dictionary] = [
		{"name": "MT", "status": "live", "material": mt, "params": PARAMS_TINT},
		{"name": "MP", "status": "live", "material": mp, "params": PARAMS_PAL},
		{"name": "MI", "status": "live", "material": mi, "params": PARAMS_NONE},
		{"name": "MY", "status": "live", "material": my, "params": PARAMS_TYPES},
		{"name": "MPh", "status": "live", "material": mph, "params": PARAMS_PHASE},
		{"name": "MR", "status": "freed" if step >= 5 else "live", "material": mr, "params": PARAMS_TINT},
		{"name": "MS", "status": "live", "material": ms, "params": PARAMS_NONE},
	]
	for k: int in range(m_refused.size()):
		out.append({"name": "M_" + REFUSED[k], "status": "live", "material": m_refused[k], "params": PARAMS_NONE})
	out.append({"name": "MR2", "status": "live" if step >= 5 else "absent", "material": mr2, "params": PARAMS_TINT})
	return out


func _oracle_items() -> Array[Dictionary]:
	var out: Array[Dictionary] = [
		{"name": "I1", "item": i1, "params": ["inst_color"]},
		{"name": "I2", "item": i2, "params": ["inst_color"]},
	]
	return out


func _read_environment() -> bool:
	if OS.has_environment("RS_FIXTURE_VARIANT"):
		var variant: String = OS.get_environment("RS_FIXTURE_VARIANT")
		if not VARIANTS.has(variant):
			_error("RS_FIXTURE_VARIANT must be one of %s (got %s)" % [JSON.stringify(VARIANTS), JSON.stringify(variant)])
			return false
		_variant = variant
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
	var material_log: String = _path_env("RS_FIXTURE_MATERIAL_LOG")
	if step_log == "!" or shot_dir == "!" or material_log == "!":
		return false
	_shot_dir = shot_dir
	if step_log != "":
		_step_log_file = FileAccess.open(step_log, FileAccess.WRITE)
		if _step_log_file == null:
			_error("cannot open RS_FIXTURE_STEP_LOG=%s" % step_log)
			return false
	if material_log != "":
		for name: String in CAPTURE_VARIABLES:
			if OS.has_environment(name):
				_error("RS_FIXTURE_MATERIAL_LOG runs on reference legs only, but %s is set" % name)
				return false
		_oracle = MaterialOracle.new()
		if not _oracle.open(material_log):
			_error("cannot open RS_FIXTURE_MATERIAL_LOG=%s" % material_log)
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
