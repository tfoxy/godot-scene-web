extends Node2D
## Gate 8 material fixture (G8m, gate8-design.md Q5 "Fixture"). Every item is a box.gd rect, made in
## `_ready` (so before a late arm and after a born one), 48x40 at a fixed position:
##
##   A  (32,32)   ShaderMaterial MA on main.gdshader (which #includes res://inc/tint.gdshaderinc,
##                so the server's code differs from Shader.get_code()), `pal` = PAL (a texture
##                parameter), `tint` changed at frame 5, before arm
##   I  (96,32)   MA too, with an instance uniform `inst` set before arm
##   R  (160,32)  ShaderMaterial MR on rel.gdshader (a relative #include: it resolves only against
##                the original's path; the no-include-path fault types it shader-adopt-include)
##   C  (224,32)  CanvasItemMaterial MC, blend add: the mode is first used before arm
##
## and, held in fields but on no item before arm: MP (a ShaderMaterial on main, `pal` = PAL2, its
## RID made), spare.gdshader (its RID made, a default texture `pal` = PAL2) and a CanvasItemMaterial
## blend mul (its shader built by the flush). The timeline, in fixture frames (K = the loader's arm
## frame, RS_FIXTURE_ARM_FRAME, default 12):
##
##   frame 5    (before arm) MA's tint changes
##   K          the capture arms (late). Checkpoint 0 settles at K+2.
##   K+4        new items: N1 (32,128) takes MP (a pre-arm material on a post-arm node); N2 (96,128)
##              a new ShaderMaterial MN on the pre-arm spare Shader (its default texture shows);
##              N3 (160,128) a new CanvasItemMaterial blend mul (the cached pre-arm mode); N4
##              (224,128) a new CanvasItemMaterial blend add (C's mode). Checkpoint 1: K+11.
##   K+14       MA's tint, I's instance uniform and MN's tint change (hooked calls on adopted and
##              lazily adopted objects). Checkpoint 2: K+21.
##   K+24       quit
##
## Environment (all optional):
##   RS_FIXTURE_STEP_LOG      absolute path: one JSONL line per checkpoint
##   RS_FIXTURE_SHOT_DIR      absolute dir: step-<k>.png at each settle frame (rendered runs only)
##   RS_FIXTURE_MATERIAL_LOG  absolute path: gate 5.5's material oracle (material_oracle.gd) at each
##                            settle frame; refused (exit 2) when GRC_EXTENSION is set (reference
##                            legs only)
##   RS_FIXTURE_QUIT_FRAME    >= K+24 (the default)

const MaterialOracle := preload("res://material_oracle.gd")
const BoxScript := preload("res://box.gd")
const SETTLE_OFFSET: int = 7
const PRE_ARM_FRAME: int = 5
const CIM_PARAMS: Array[String] = ["particles_anim_h_frames", "particles_anim_loop", "particles_anim_v_frames"]

var _frame: int = 0
var _arm_frame: int = 12
var _quit_frame: int = 0
var _shot_dir: String = ""
var _step_log_file: FileAccess
var _failed: bool = false
var _oracle: MaterialOracle
## [applied_frame, settle_frame] per checkpoint
var _checkpoints: Array[Array] = []

var _pal: ImageTexture
var _pal2: ImageTexture
var _main: Shader
var _rel: Shader
var _spare: Shader
var _ma: ShaderMaterial
var _mr: ShaderMaterial
var _mc: CanvasItemMaterial
var _mp: ShaderMaterial
var _keep_mul: CanvasItemMaterial
var _mn: ShaderMaterial
var _m3: CanvasItemMaterial
var _m4: CanvasItemMaterial
var _items: Dictionary = {}


func _ready() -> void:
	var loader: Node = get_node_or_null("/root/GrcLoader")
	if loader != null:
		var frame: int = loader.get("arm_frame")
		_arm_frame = frame
	if not _read_environment():
		_failed = true
		get_tree().quit(2)
		return
	_checkpoints = [
		[_arm_frame, _arm_frame + 2],
		[_arm_frame + 4, _arm_frame + 4 + SETTLE_OFFSET],
		[_arm_frame + 14, _arm_frame + 14 + SETTLE_OFFSET],
	]
	_pal = ImageTexture.create_from_image(_checker(Color(1, 0.8, 0.2, 1), Color(0.2, 0.6, 1, 1)))
	_pal2 = ImageTexture.create_from_image(_checker(Color(0.6, 1, 0.4, 1), Color(1, 0.4, 0.8, 1)))
	_main = load("res://shaders/main.gdshader")
	_rel = load("res://shaders/rel.gdshader")
	_spare = load("res://shaders/spare.gdshader")
	_ma = ShaderMaterial.new()
	_ma.shader = _main
	_ma.set_shader_parameter("pal", _pal)
	_ma.set_shader_parameter("tint", Color(0.4, 0.8, 0.4, 1))
	_mr = ShaderMaterial.new()
	_mr.shader = _rel
	_mr.set_shader_parameter("tint", Color(0.2, 0.6, 1, 1))
	_mc = CanvasItemMaterial.new()
	_mc.blend_mode = CanvasItemMaterial.BLEND_MODE_ADD
	_box("A", Vector2(32, 32), Color(1, 1, 1, 1), _ma)
	var item_i: Node2D = _box("I", Vector2(96, 32), Color(1, 1, 1, 1), _ma)
	item_i.set_instance_shader_parameter("inst", Color(0.5, 1, 1, 1))
	_box("R", Vector2(160, 32), Color(0.8, 0.8, 0.8, 1), _mr)
	_box("C", Vector2(224, 32), Color(0.4, 0.2, 0.2, 1), _mc)
	# Pre-arm objects no item uses before arm: their server RIDs exist all the same.
	_mp = ShaderMaterial.new()
	_mp.shader = _main
	_mp.set_shader_parameter("pal", _pal2)
	_mp.set_shader_parameter("tint", Color(1, 0.6, 0.2, 1))
	var _mp_rid: RID = _mp.get_rid()
	_spare.set_default_texture_parameter("pal", _pal2)
	_keep_mul = CanvasItemMaterial.new()
	_keep_mul.blend_mode = CanvasItemMaterial.BLEND_MODE_MUL
	var material_log: String = _path_env("RS_FIXTURE_MATERIAL_LOG")
	if material_log == "!":
		_failed = true
		get_tree().quit(2)
		return
	if material_log != "":
		if OS.has_environment("GRC_EXTENSION"):
			_error("RS_FIXTURE_MATERIAL_LOG is for reference legs only (GRC_EXTENSION is set)")
			_failed = true
			get_tree().quit(2)
			return
		_oracle = MaterialOracle.new()
		if not _oracle.open(material_log):
			_error("cannot open RS_FIXTURE_MATERIAL_LOG=%s" % material_log)
			_failed = true
			get_tree().quit(2)
			return
	print("[fixture] gate8-mat ready: K=%d quit=%d oracle=%s" % [_arm_frame, _quit_frame, "on" if _oracle != null else "off"])


func _box(item_name: String, at: Vector2, color: Color, material: Material) -> Node2D:
	var box: Node2D = BoxScript.new()
	box.name = item_name
	box.set("size", Vector2(48, 40))
	box.set("color", color)
	box.position = at
	box.material = material
	add_child(box)
	_items[item_name] = box
	return box


func _checker(a: Color, b: Color) -> Image:
	var image := Image.create_empty(4, 4, false, Image.FORMAT_RGBA8)
	for y: int in range(4):
		for x: int in range(4):
			image.set_pixel(x, y, a if (x + y) % 2 == 0 else b)
	return image


func _process(_delta: float) -> void:
	if _failed:
		return
	_frame += 1
	if _frame == PRE_ARM_FRAME:
		_ma.set_shader_parameter("tint", Color(0.8, 0.4, 0.4, 1))
	for k: int in range(_checkpoints.size()):
		var applied: int = _checkpoints[k][0]
		var settle: int = _checkpoints[k][1]
		if _frame == applied:
			match k:
				1:
					_step_1()
				2:
					_step_2()
			_log_step(k, applied, settle)
		if _frame == settle:
			if _oracle != null:
				_oracle.record(k, _frame, _oracle_shaders(), _oracle_materials(k), _oracle_items(), {"PAL": _pal.get_rid(), "PAL2": _pal2.get_rid()})
			_maybe_take_shot("step-%d.png" % k)
	if _frame >= _quit_frame:
		print("[fixture] quitting frame=%d" % _frame)
		get_tree().quit(0)


func _step_1() -> void:
	_box("N1", Vector2(32, 128), Color(1, 1, 1, 1), _mp)
	_mn = ShaderMaterial.new()
	_mn.shader = _spare
	_mn.set_shader_parameter("tint", Color(0.6, 1, 0.6, 1))
	_box("N2", Vector2(96, 128), Color(1, 1, 1, 1), _mn)
	_m3 = CanvasItemMaterial.new()
	_m3.blend_mode = CanvasItemMaterial.BLEND_MODE_MUL
	_box("N3", Vector2(160, 128), Color(1, 0.5, 1, 1), _m3)
	_m4 = CanvasItemMaterial.new()
	_m4.blend_mode = CanvasItemMaterial.BLEND_MODE_ADD
	_box("N4", Vector2(224, 128), Color(0.2, 0.4, 0.2, 1), _m4)


func _step_2() -> void:
	_ma.set_shader_parameter("tint", Color(0.2, 0.4, 1, 1))
	(_items["I"] as Node2D).set_instance_shader_parameter("inst", Color(1, 0.5, 0.5, 1))
	_mn.set_shader_parameter("tint", Color(1, 1, 1, 1))


## The oracle's shaders: the three fixture Shaders (CanvasItemMaterial shaders have no resource;
## adopt-cim-builtin judges them against the born capture).
func _oracle_shaders() -> Array[Dictionary]:
	return [
		{"name": "main", "status": "live", "shader": _main},
		{"name": "rel", "status": "live", "shader": _rel},
		{"name": "spare", "status": "live", "shader": _spare},
	]


func _oracle_materials(step: int) -> Array[Dictionary]:
	var out: Array[Dictionary] = [
		{"name": "MA", "status": "live", "material": _ma, "params": ["pal", "tint"]},
		{"name": "MR", "status": "live", "material": _mr, "params": ["tint"]},
		{"name": "MC", "status": "live", "material": _mc, "params": CIM_PARAMS},
	]
	if step >= 1:
		out.append({"name": "MP", "status": "live", "material": _mp, "params": ["pal", "tint"]})
		out.append({"name": "MN", "status": "live", "material": _mn, "params": ["pal", "tint"]})
		out.append({"name": "M3", "status": "live", "material": _m3, "params": CIM_PARAMS})
		out.append({"name": "M4", "status": "live", "material": _m4, "params": CIM_PARAMS})
	return out


func _oracle_items() -> Array[Dictionary]:
	return [
		{"name": "A", "item": _items["A"], "params": ["inst"]},
		{"name": "I", "item": _items["I"], "params": ["inst"]},
	]


func _read_environment() -> bool:
	var quit_default: int = _arm_frame + 24
	_quit_frame = quit_default
	if OS.has_environment("RS_FIXTURE_QUIT_FRAME"):
		var text: String = OS.get_environment("RS_FIXTURE_QUIT_FRAME").strip_edges()
		if not text.is_valid_int() or text.to_int() < quit_default:
			_error("RS_FIXTURE_QUIT_FRAME must be an integer >= %d (got %s)" % [quit_default, JSON.stringify(text)])
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
func _path_env(env_name: String) -> String:
	if not OS.has_environment(env_name):
		return ""
	var text: String = OS.get_environment(env_name)
	if not text.is_absolute_path():
		_error("%s must be an absolute path (got %s)" % [env_name, JSON.stringify(text)])
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
