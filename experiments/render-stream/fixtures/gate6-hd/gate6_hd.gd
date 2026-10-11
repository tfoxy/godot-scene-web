extends Node
## Gate 6 HD fixture (../../protocol/gate6-design.md "Q6e", G6h): nine copies of the gate 6 scene
## in a 3x3 `GridContainer` at logical 1920x1080 under `canvas_items` stretch (aspect `keep`). Cell
## c (row-major) is built by the synced `scene_builder.gd` with cell index c (TEXA content offset
## 100c, HUD layer 1 + c) and phase 7c frames, inside a `Cell` Control of minimum size 640x360 that
## the grid places at (640 (c mod 3), 360 floor(c / 3)). The presentation size is the window's:
## `native` runs at 1920x1080 (stretch identity, font oversampling 1), `half` at 960x540
## (`--resolution 960x540`: stretch 0.5, oversampling 0.5); the fixture itself does not know which.
##
## The timelines, time modes, shots and step log are gate6_scene.gd's (Q6c, D6), applied to every
## cell at the same frames. Variants: `animate` (Q6d, per cell) and `gpu-heavy` (Q6e: a transparent
## 1920x1080 `ColorRect` child of cell 0 whose `burn` shader loops RS_FIXTURE_BURN_ITERATIONS
## times). One viewport has one focus owner, so only the last cell built (8) keeps its LineEdit's
## focus; every cell's LineEdit keeps its selection (`deselect_on_focus_loss_enabled = false` is
## set on each before the next cell grabs focus).
##
## Environment (all optional; an invalid value prints an error and quits 2): gate6_scene.gd's
## RS_FIXTURE_VARIANT (`animate`, `gpu-heavy`), RS_FIXTURE_TIME, RS_FIXTURE_TIMELINE,
## RS_FIXTURE_START_FRAME, RS_FIXTURE_STEP_FRAMES, RS_FIXTURE_QUIT_FRAME, RS_FIXTURE_STEP_LOG,
## RS_FIXTURE_SHOT_DIR, RS_FIXTURE_SHOT_FRAMES, RS_FIXTURE_ORACLE_LOG (hd_oracle.gd, reference legs
## only), plus RS_FIXTURE_BURN_ITERATIONS (`gpu-heavy` only; default 1000, G6c calibrates it).

const Builder := preload("res://scene_builder.gd")
const HdOracle := preload("res://hd_oracle.gd")

const CELLS: int = 9
const COLUMNS: int = 3
const CELL_SIZE: Vector2 = Vector2(640, 360)
const PHASE_PER_CELL: int = 7
const BURN_ITERATIONS_DEFAULT: int = 1000

const LAST_STEP: int = 11
const SETTLE_OFFSET: int = 7
const QUIT_AFTER_LAST_SETTLE: int = 4
const VARIANTS: Array[String] = ["animate", "gpu-heavy"]
const TIMELINES: Array[String] = ["file", "live", "rate", "soak"]
const TIME_MODES: Array[String] = ["steps", "realtime"]
const FILE_START: int = 1
const FILE_STEP: int = 10
const FILE_MID_STEPS: Array[int] = [1, 5, 9]
const FILE_MID_OFFSET: int = 2
const LIVE_START: int = 300
const LIVE_STEP: int = 60
const LIVE_QUIT_STEPS: int = 13
const RATE_FIRST: float = 5.0
const RATE_STEP11: float = 28.0
const RATE_QUIT: float = 30.0
const SOAK_STEP11: float = 365.0
const SOAK_QUIT: float = 370.0
const CAPTURE_VARIABLES: Array[String] = ["GRC_EXTENSION", "GRC_MODE", "GRC_CALIBRATION", "GRC_EVIDENCE_DIR", "GRC_STREAM_OUT"]

var grid: GridContainer
var cells: Array[Control] = []
var insts: Array[Builder] = []
var burn: ColorRect
var burn_material: ShaderMaterial

var _variant: String = ""
var _burn_iterations: int = BURN_ITERATIONS_DEFAULT
var _timeline: String = "file"
var _realtime: bool = false
var _start_frame: int = FILE_START
var _step_frames: int = FILE_STEP
var _quit_frame: int = 0
var _shot_dir: String = ""
var _extra_frames: Array[int] = []
var _step_log_file: FileAccess
var _oracle: HdOracle
var _failed: bool = false

var _frame: int = 0
var _game_time: float = 0.0
var _next_step: int = 1
var _settle_at: Dictionary[int, int] = {}


func _ready() -> void:
	if not _read_environment():
		_failed = true
		get_tree().quit(2)
		return
	grid = GridContainer.new()
	grid.name = "Grid"
	grid.columns = COLUMNS
	grid.add_theme_constant_override("h_separation", 0)
	grid.add_theme_constant_override("v_separation", 0)
	grid.mouse_filter = Control.MOUSE_FILTER_IGNORE
	add_child(grid)
	grid.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	var builder_variant: String = _variant if _variant == "animate" else ""
	for c: int in range(CELLS):
		var cell: Control = Control.new()
		cell.name = "Cell%d" % c
		cell.custom_minimum_size = CELL_SIZE
		cell.mouse_filter = Control.MOUSE_FILTER_IGNORE
		grid.add_child(cell)
		var origin: Vector2 = Vector2(CELL_SIZE.x * float(c % COLUMNS), CELL_SIZE.y * float(c / COLUMNS))
		var inst: Builder = Builder.new()
		# `origin` places the cell's top_level TL and its HUD panel (both outside the cell's
		# transform); the Scene itself sits at the cell's own origin.
		inst.build(cell, origin, c, PHASE_PER_CELL * c, builder_variant, _realtime)
		inst.scene.position = Vector2.ZERO
		# The next cell's grab_focus takes the focus away; keep the selection on focus loss.
		inst.le.deselect_on_focus_loss_enabled = false
		cells.append(cell)
		insts.append(inst)
	if _variant == "gpu-heavy":
		_build_burn()
	var settle0: int = (_start_frame if _frame_indexed() else 1) + SETTLE_OFFSET
	_settle_at[0] = settle0
	_log_step(0, 1, settle0)
	print("[fixture] gate6-hd ready: variant=%s timeline=%s time=%s S=%d N=%d quit=%d window=%s oversampling=%s focus=%s" % [
		_variant if _variant != "" else "default", _timeline, "realtime" if _realtime else "steps",
		_start_frame, _step_frames, _quit_frame, str(get_window().size), str(get_viewport().get_oversampling()),
		JSON.stringify(insts.map(func(i: Builder) -> bool: return i.le.has_focus()))])


## Q6e `gpu-heavy`: a transparent full-frame rect whose fragment loop cannot be folded away.
func _build_burn() -> void:
	var shader: Shader = load("res://shaders/burn.gdshader") as Shader
	burn_material = ShaderMaterial.new()
	burn_material.shader = shader
	burn_material.set_shader_parameter("iterations", _burn_iterations)
	burn = ColorRect.new()
	burn.name = "Burn"
	burn.position = Vector2.ZERO
	burn.size = Vector2(1920, 1080)
	burn.material = burn_material
	burn.mouse_filter = Control.MOUSE_FILTER_IGNORE
	cells[0].add_child(burn)


func _process(delta: float) -> void:
	if _failed:
		return
	_frame += 1
	_game_time += delta

	if _frame_indexed():
		var apply_step: int = _step_at(_frame, 0)
		if apply_step >= 1:
			_apply_step(apply_step)
			_log_step(apply_step, _frame, _frame + SETTLE_OFFSET)
	else:
		while _next_step <= LAST_STEP and _game_time >= _step_time(_next_step):
			var settle: int = _frame + SETTLE_OFFSET
			_settle_at[_next_step] = settle
			_apply_step(_next_step)
			_log_step(_next_step, _frame, settle)
			_next_step += 1

	var game_frame: int = floori(_game_time * Builder.FPS)
	for inst: Builder in insts:
		inst.on_frame(game_frame if _realtime else _frame)

	var settle_step: int = _settle_step(_frame)
	if settle_step >= 0:
		_maybe_take_shot("step-%d.png" % settle_step, settle_step)
	if _extra_frames.has(_frame):
		_maybe_take_shot("frame-%d.png" % _frame, -1)

	if _quit_due():
		print("[fixture] quitting frame=%d time=%.3f" % [_frame, _game_time])
		get_tree().quit(0)


func _frame_indexed() -> bool:
	return _timeline == "file" or _timeline == "live"


func _apply_step(step: int) -> void:
	for inst: Builder in insts:
		inst.apply_step(step)
	if step == 10:
		# The root canvas transform: every root-canvas item of every cell moves by (8, 4) logical
		# pixels; the HUD layers do not.
		get_viewport().canvas_transform = Transform2D(0.0, Vector2(8, 4))


func _step_at(frame: int, offset: int) -> int:
	var since: int = frame - _start_frame - offset
	if since < 0 or since % _step_frames != 0:
		return -1
	var step: int = since / _step_frames
	if offset == 0 and step == 0:
		return -1
	return step if step <= LAST_STEP else -1


func _settle_step(frame: int) -> int:
	if _frame_indexed():
		return _step_at(frame, SETTLE_OFFSET)
	for step: int in _settle_at:
		if _settle_at[step] == frame:
			return step
	return -1


func _step_time(step: int) -> float:
	if step == LAST_STEP:
		return RATE_STEP11 if _timeline == "rate" else SOAK_STEP11
	return RATE_FIRST + float(step)


func _quit_due() -> bool:
	if _frame_indexed():
		return _frame >= _quit_frame
	return _game_time >= (RATE_QUIT if _timeline == "rate" else SOAK_QUIT) and _next_step > LAST_STEP


func _read_environment() -> bool:
	if OS.has_environment("RS_FIXTURE_VARIANT"):
		var variant: String = OS.get_environment("RS_FIXTURE_VARIANT")
		if not VARIANTS.has(variant):
			_error("RS_FIXTURE_VARIANT must be one of %s (got %s)" % [JSON.stringify(VARIANTS), JSON.stringify(variant)])
			return false
		_variant = variant
	var iterations: int = _int_env("RS_FIXTURE_BURN_ITERATIONS", BURN_ITERATIONS_DEFAULT, 0)
	if iterations < 0:
		return false
	_burn_iterations = iterations
	if OS.has_environment("RS_FIXTURE_TIMELINE"):
		var timeline: String = OS.get_environment("RS_FIXTURE_TIMELINE")
		if not TIMELINES.has(timeline):
			_error("RS_FIXTURE_TIMELINE must be one of %s (got %s)" % [JSON.stringify(TIMELINES), JSON.stringify(timeline)])
			return false
		_timeline = timeline
	_realtime = not _frame_indexed()
	if OS.has_environment("RS_FIXTURE_TIME"):
		var mode: String = OS.get_environment("RS_FIXTURE_TIME")
		if not TIME_MODES.has(mode):
			_error("RS_FIXTURE_TIME must be one of %s (got %s)" % [JSON.stringify(TIME_MODES), JSON.stringify(mode)])
			return false
		_realtime = mode == "realtime"
		if not _realtime and not _frame_indexed():
			_error("RS_FIXTURE_TIME=steps needs a frame-indexed timeline (file or live), not %s" % _timeline)
			return false

	var start_default: int = FILE_START if _timeline == "file" else LIVE_START
	var span_default: int = FILE_STEP if _timeline == "file" else LIVE_STEP
	var start: int = _int_env("RS_FIXTURE_START_FRAME", start_default, 1)
	var span: int = _int_env("RS_FIXTURE_STEP_FRAMES", span_default, SETTLE_OFFSET + 1)
	if start < 0 or span < 0:
		return false
	_start_frame = start
	_step_frames = span
	var quit_default: int = _start_frame + _step_frames * LAST_STEP + SETTLE_OFFSET + QUIT_AFTER_LAST_SETTLE
	if _timeline == "live":
		quit_default = _start_frame + _step_frames * LIVE_QUIT_STEPS
	var quit: int = _int_env("RS_FIXTURE_QUIT_FRAME", quit_default, quit_default)
	if quit < 0:
		return false
	_quit_frame = quit

	if _timeline == "file":
		for k: int in FILE_MID_STEPS:
			_extra_frames.append(_start_frame + _step_frames * k + FILE_MID_OFFSET)
	if OS.has_environment("RS_FIXTURE_SHOT_FRAMES"):
		for part: String in OS.get_environment("RS_FIXTURE_SHOT_FRAMES").split(",", false):
			var text: String = part.strip_edges()
			if not text.is_valid_int() or text.to_int() < 1:
				_error("RS_FIXTURE_SHOT_FRAMES must be a CSV of frames >= 1 (got %s)" % JSON.stringify(text))
				return false
			if not _extra_frames.has(text.to_int()):
				_extra_frames.append(text.to_int())

	var step_log: String = _path_env("RS_FIXTURE_STEP_LOG")
	var shot_dir: String = _path_env("RS_FIXTURE_SHOT_DIR")
	var oracle_log: String = _path_env("RS_FIXTURE_ORACLE_LOG")
	if step_log == "!" or shot_dir == "!" or oracle_log == "!":
		return false
	_shot_dir = shot_dir
	if step_log != "":
		_step_log_file = FileAccess.open(step_log, FileAccess.WRITE)
		if _step_log_file == null:
			_error("cannot open RS_FIXTURE_STEP_LOG=%s" % step_log)
			return false
	if oracle_log != "":
		for name: String in CAPTURE_VARIABLES:
			if OS.has_environment(name):
				_error("RS_FIXTURE_ORACLE_LOG runs on reference legs only, but %s is set" % name)
				return false
		_oracle = HdOracle.new()
		if not _oracle.open(oracle_log):
			_error("cannot open RS_FIXTURE_ORACLE_LOG=%s" % oracle_log)
			return false
	return true


func _int_env(name: String, fallback: int, minimum: int) -> int:
	if not OS.has_environment(name):
		return fallback
	var text: String = OS.get_environment(name).strip_edges()
	if not text.is_valid_int() or text.to_int() < minimum:
		_error("%s must be an integer >= %d (got %s)" % [name, minimum, JSON.stringify(text)])
		return -1
	return text.to_int()


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


## Rendered runs only (headless never reaches frame_post_draw). The oracle line of a settle step
## is written at that frame's frame_post_draw, after its draws rasterized their glyphs.
func _maybe_take_shot(file_name: String, settle_step: int) -> void:
	if DisplayServer.get_name() == "headless":
		return
	if _shot_dir == "" and (_oracle == null or settle_step < 0):
		return
	var frame: int = _frame
	await RenderingServer.frame_post_draw
	if _oracle != null and settle_step >= 0:
		_oracle.record(settle_step, frame, grid, cells, insts, get_viewport())
	if _shot_dir == "":
		return
	var out_path: String = _shot_dir.path_join(file_name)
	var image: Image = get_viewport().get_texture().get_image()
	var err: Error = image.save_png(out_path)
	print("[fixture] shot saved=%s err=%d" % [out_path, err])
