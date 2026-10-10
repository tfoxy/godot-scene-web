extends Node
## Gate 5.5 CanvasItemMaterial fixture (../../protocol/gate5_5-design.md "Q6b", G55b).
##
## The root is a plain `Node`. Every `CanvasItem` and every `CanvasItemMaterial` is created in
## `_ready()`, after `GrcLoader` armed the capture extension in its own `_enter_tree()` (gate 0
## route (a)), so the hooks see each `canvas_item_create` and `material_create`, and every
## CanvasItemMaterial shader key is first used after arming (D7's process-wide cache). Construction
## order is expected.json `creation_order` (wire ids). make_expected.py models the same scene from
## its own copy of these numbers, and the two must agree.
##
## Environment (all optional; an invalid value prints an error and quits 2):
##   RS_FIXTURE_STEP_LOG    absolute path: one JSONL line per step at its applied frame
##   RS_FIXTURE_SHOT_DIR    absolute dir: step-<k>.png at each settle frame (rendered runs only)
##   RS_FIXTURE_START_FRAME S >= 1, default 1
##   RS_FIXTURE_STEP_FRAMES N >= 8, default 10 (step k >= 1 at S+N*k, settled at S+N*k+7)
##   RS_FIXTURE_QUIT_FRAME  >= S+N*9+11 (the default)
##   RS_FIXTURE_VARIANT     unset (default) or "modulate" (a CanvasModulate on the root canvas:
##                          (1,1,0) at step 0, (0,1,1) at step 2, hidden at step 8); anything
##                          else exits 2

const RectsNode := preload("res://rects.gd")

const LAST_STEP: int = 9
const SETTLE_OFFSET: int = 7
const START_FRAME_DEFAULT: int = 1
const STEP_FRAMES_DEFAULT: int = 10
const QUIT_AFTER_LAST_SETTLE: int = 4  # quit default S + N*9 + 11 = last settle + 4

## G55b's marker colours (gate 3's rect and region, its own colours): distinct as drawn and
## distinct after each step's canvas modulate in variant `modulate`, which changes every one of
## steps 0..7 (make_expected.py asserts both).
const MARKER_COLORS: Array[Color] = [
	Color(0, 0, 0.6, 1),
	Color(1, 1, 0.6, 1),
	Color(0.6, 1, 1, 1),
	Color(0.4, 0, 0.4, 1),
	Color(0.6, 0.4, 0, 1),
	Color(0.4, 0.8, 0, 1),
	Color(0.2, 0.2, 0.6, 1),
	Color(0.8, 0.4, 0.8, 1),
	Color(0.4, 0.6, 0.8, 1),
	Color(0.8, 0.6, 0.4, 1),
]

## CanvasItemMaterial.BlendMode by value: BLEND_MODE_DISABLED (5) is in the C++ enum but not
## bound (scene/resources/canvas_item_material.h:39-46, cim.cpp:260), so GDScript has no name for it.
const BLEND_MIX: int = 0
const BLEND_ADD: int = 1
const BLEND_SUB: int = 2
const BLEND_MUL: int = 3
const BLEND_PREMUL_ALPHA: int = 4
const BLEND_DISABLED: int = 5

## The blend regions, left to right, and their overlay's blend mode.
const BLEND_REGIONS: Array[String] = ["BM", "BA", "BS", "BU", "BP", "BD"]
const BLEND_REGION_MODES: Array[int] = [BLEND_MIX, BLEND_ADD, BLEND_SUB, BLEND_MUL, BLEND_PREMUL_ALPHA, BLEND_DISABLED]
const BLEND_REGION_WIDTH: int = 88

const UNDERLAY_COLOR: Color = Color(0.4, 0.6, 0.2, 1)
const OVERLAY_COLOR: Color = Color(0.4, 0.2, 0.6, 1)
const STRIP_COLOR: Color = Color(0.4, 0.2, 0.6, 0.6)
const LIGHT_COLOR: Color = Color(0.6, 0.4, 1, 1)
const GREY_40: Color = Color(0.4, 0.4, 0.4, 1)
const GREY_20: Color = Color(0.2, 0.2, 0.2, 1)

const MODULATE_STEP0: Color = Color(1, 1, 0, 1)
const MODULATE_STEP2: Color = Color(0, 1, 1, 1)

var underlays: Array[RectsNode] = []
var overlays: Array[RectsNode] = []
var ln: RectsNode
var lm: RectsNode
var lu: RectsNode
var lo: RectsNode
var ub: RectsNode
var up: RectsNode
var uc: RectsNode
var rb: RectsNode
var ri: RectsNode
var marker: RectsNode
var canvas_modulate: CanvasModulate

## The materials the timeline changes. RI's material is deliberately NOT held here: step 4's
## `ri.material = null` must drop its last reference so that the engine frees it (Q1a).
var mat_bd: CanvasItemMaterial
var mat_lo: CanvasItemMaterial
var mat_lu: CanvasItemMaterial
var mat_up: CanvasItemMaterial

var _frame: int = 0
var _start_frame: int = START_FRAME_DEFAULT
var _step_frames: int = STEP_FRAMES_DEFAULT
var _quit_frame: int = 0
var _shot_dir: String = ""
var _variant: String = ""
var _step_log_file: FileAccess
var _failed: bool = false


func _ready() -> void:
	if not _read_environment():
		_failed = true
		get_tree().quit(2)
		return

	# Construction order is the wire id order: a CanvasItem calls canvas_item_create in its
	# constructor. Blend regions: underlay U then overlay O, left to right.
	for k: int in range(BLEND_REGIONS.size()):
		var origin: Vector2 = Vector2(16 + BLEND_REGION_WIDTH * k, 16)
		var u: RectsNode = _rects("U_" + BLEND_REGIONS[k], origin, [Rect2(8, 8, 56, 48)], [UNDERLAY_COLOR])
		var o: RectsNode = _rects("O_" + BLEND_REGIONS[k], origin, [Rect2(24, 16, 48, 24), Rect2(24, 44, 48, 16)], [OVERLAY_COLOR, STRIP_COLOR])
		underlays.append(u)
		overlays.append(o)
	ln = _rects("LN", Vector2(16, 112), [Rect2(16, 16, 56, 48)], [LIGHT_COLOR])
	lm = _rects("LM", Vector2(104, 112), [Rect2(16, 16, 56, 48)], [LIGHT_COLOR])
	lu = _rects("LU", Vector2(192, 112), [Rect2(16, 16, 56, 48)], [LIGHT_COLOR])
	lo = _rects("LO", Vector2(280, 112), [Rect2(16, 16, 56, 48)], [LIGHT_COLOR])
	ub = _rects("UB", Vector2(16, 208), [Rect2(8, 8, 120, 48)], [GREY_40])
	up = _rects("UP", Vector2(16, 208), [Rect2(8, 24, 60, 48)], [GREY_20])
	uc = _rects("UC", Vector2(0, 0), [Rect2(68, 24, 60, 48)], [GREY_20])
	rb = _rects("RB", Vector2(168, 208), [Rect2(8, 8, 56, 48)], [GREY_40])
	ri = _rects("RI", Vector2(168, 208), [Rect2(24, 24, 56, 40)], [GREY_20])
	marker = _rects("Marker", Vector2(592, 16), [Rect2(0, 0, 32, 32)], [MARKER_COLORS[0]])
	if _variant == "modulate":
		# A Node2D: its own (empty) canvas item comes last, so every other wire id is unchanged.
		canvas_modulate = CanvasModulate.new()
		canvas_modulate.name = "CM"
		canvas_modulate.color = MODULATE_STEP0

	# Materials (one CanvasItemMaterial each; material_create and three material_set_param in the
	# constructor, the shader at this frame's idle flush, cim.cpp:279-290 and :55-148).
	for k: int in range(overlays.size()):
		var m: CanvasItemMaterial = _cim(BLEND_REGION_MODES[k], CanvasItemMaterial.LIGHT_MODE_NORMAL)
		overlays[k].material = m
		if BLEND_REGIONS[k] == "BD":
			mat_bd = m
	lm.material = _cim(BLEND_MIX, CanvasItemMaterial.LIGHT_MODE_NORMAL)
	mat_lu = _cim(BLEND_MIX, CanvasItemMaterial.LIGHT_MODE_UNSHADED)
	lu.material = mat_lu
	mat_lo = _cim(BLEND_MIX, CanvasItemMaterial.LIGHT_MODE_LIGHT_ONLY)
	lo.material = mat_lo
	mat_up = _cim(BLEND_ADD, CanvasItemMaterial.LIGHT_MODE_NORMAL)
	up.material = mat_up
	ri.material = _cim(BLEND_SUB, CanvasItemMaterial.LIGHT_MODE_NORMAL)

	# Tree order is paint order: each underlay under its overlay, UB under UP and its child UC,
	# RB under RI, the marker last.
	up.add_child(uc)
	for k: int in range(overlays.size()):
		add_child(underlays[k])
		add_child(overlays[k])
	for node: Node in [ln, lm, lu, lo, ub, up, rb, ri, marker]:
		add_child(node)
	if canvas_modulate != null:
		add_child(canvas_modulate)

	# Step 0 is the `_ready` state, applied at the frame stamp of everything that runs during
	# `initialize()` (1), settled at S + 7.
	_log_step(0, 1, _start_frame + SETTLE_OFFSET)
	print("[fixture] gate55-cim ready: S=%d N=%d quit=%d variant=%s" % [_start_frame, _step_frames, _quit_frame, _variant if _variant != "" else "none"])


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


func _rects(node_name: String, origin: Vector2, rects: Array[Rect2], colors: Array[Color]) -> RectsNode:
	var node: RectsNode = RectsNode.new()
	node.name = node_name
	node.position = origin
	node.rects = rects
	node.colors = colors
	return node


func _cim(blend: int, light: CanvasItemMaterial.LightMode) -> CanvasItemMaterial:
	var m: CanvasItemMaterial = CanvasItemMaterial.new()
	m.blend_mode = blend as CanvasItemMaterial.BlendMode
	m.light_mode = light
	return m


## The step whose frame S + N*k + offset is `frame` (step 0 included), else -1.
func _step_at(frame: int, offset: int) -> int:
	var since: int = frame - _start_frame - offset
	if since < 0 or since % _step_frames != 0:
		return -1
	var step: int = since / _step_frames
	return step if step <= LAST_STEP else -1


## gate5_5-design.md Q6b's timeline. None of it redraws a region: only the marker re-records.
func _apply_step(step: int) -> void:
	match step:
		1:
			mat_bd.blend_mode = BLEND_MIX as CanvasItemMaterial.BlendMode
		2:
			mat_lo.light_mode = CanvasItemMaterial.LIGHT_MODE_NORMAL
			if canvas_modulate != null:
				canvas_modulate.color = MODULATE_STEP2
		3:
			mat_lu.light_mode = CanvasItemMaterial.LIGHT_MODE_LIGHT_ONLY
		4:
			# The last reference: the material (and its use of the shared sub shader) goes here.
			ri.material = null
		5:
			# Recreation: a new material id (material_create, three params), then
			# canvas_item_set_material, then the shared add shader at the idle flush.
			var m: CanvasItemMaterial = _cim(BLEND_ADD, CanvasItemMaterial.LIGHT_MODE_NORMAL)
			ri.material = m
		6:
			uc.use_parent_material = true
		7:
			overlays[BLEND_REGIONS.find("BA")].position += Vector2(4, 0)
		8:
			mat_up.blend_mode = BLEND_SUB as CanvasItemMaterial.BlendMode
			if canvas_modulate != null:
				# The last visible CanvasModulate hides: the canvas goes back to white.
				canvas_modulate.visible = false
		9:
			get_viewport().canvas_transform = Transform2D(0.0, Vector2(8, 4))
	marker.set_color(MARKER_COLORS[step])


func _read_environment() -> bool:
	if OS.has_environment("RS_FIXTURE_VARIANT"):
		var variant: String = OS.get_environment("RS_FIXTURE_VARIANT")
		if variant != "modulate":
			_error("RS_FIXTURE_VARIANT must be unset or \"modulate\" (got %s)" % JSON.stringify(variant))
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
