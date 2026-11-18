extends Node
## VS5 viewport-perf main scene: a plain Node that instantiates the chosen scene in `_ready`, after
## the loader armed the capture in `_enter_tree` (the `born` pattern of fixtures/viewport-scene), so
## every viewport, proxy, canvas and item is created under the hooks. Every scene is steady: its
## per-frame work does not drift, so receivers that connect one after another to one host (the
## A/B/B/A arms of run-gate7.sh's vp sweeps) measure the same load.
##
## Both scenes keep a root heartbeat (`Heartbeat`, a 48x48 square moving 4 px per 1/60 s of game
## time and wrapping), so the root changes on every host frame and a receiver draws every frame
## even when no surface changes (the `draw` scene's idle phase).
##
## Environment (all optional; an invalid value prints an error and quits 2):
##   RS_FIXTURE_VP_SCENE     `draw` (default) or `vfx6`
##   RS_FIXTURE_VP_PHASE     draw only: `active` (default; a stroke is drawn every frame) or `idle`
##                           (the strokes are complete and nothing on the surface changes)
##   RS_FIXTURE_QUIT_TIME    seconds of game time to quit at, >= 1 (default 60)
##   RS_FIXTURE_QUIT_FILE    absolute path: quit (exit 0) at the first check that finds it; checked
##                           every 30 frames. A sweep's harness touches it after its last arm.
##   RS_FIXTURE_STEP_LOG     absolute path: one JSONL line at `ready` and one at `final`
##   RS_FIXTURE_SHOT_DIR     absolute dir: step-1.png of the root at frame 120 (rendered hosts only)

const DrawScene := preload("res://draw.tscn")
const Vfx6Scene := preload("res://vfx6.tscn")

const ROOT_SIZE: Vector2 = Vector2(1920, 1080)
const QUIT_TIME_DEFAULT: float = 60.0
const QUIT_FILE_EVERY: int = 30
const SHOT_FRAME: int = 120
const HEARTBEAT_SIZE: float = 48.0
const HEARTBEAT_PX_PER_TICK: float = 4.0

var _scene_name: String = "draw"
var _phase: String = "active"
var _quit_time: float = QUIT_TIME_DEFAULT
var _quit_file: String = ""
var _shot_dir: String = ""
var _step_log_file: FileAccess
var _failed: bool = false
var _frame: int = 0
var _game_time: float = 0.0
var _scene: Node
var _heartbeat: ColorRect


func _ready() -> void:
	if not _read_environment():
		_failed = true
		get_tree().quit(2)
		return
	if _scene_name == "vfx6":
		_scene = Vfx6Scene.instantiate()
	else:
		_scene = DrawScene.instantiate()
		_scene.set("phase", _phase)
	add_child(_scene)
	_heartbeat = ColorRect.new()
	_heartbeat.name = "Heartbeat"
	_heartbeat.size = Vector2(HEARTBEAT_SIZE, HEARTBEAT_SIZE)
	_heartbeat.color = Color(0.95, 0.95, 0.95, 1)
	_heartbeat.mouse_filter = Control.MOUSE_FILTER_IGNORE
	_heartbeat.position = Vector2(0, ROOT_SIZE.y - HEARTBEAT_SIZE - 8)
	add_child(_heartbeat)
	var viewports: int = _count_viewports(_scene)
	print("[fixture] viewport-perf ready: scene=%s phase=%s viewports=%d quit=%.1fs" % [
		_scene_name, _phase if _scene_name == "draw" else "-", viewports, _quit_time])
	_log({"event": "ready", "frame": 0, "scene": _scene_name,
		"phase": _phase if _scene_name == "draw" else null, "viewports": viewports})


func _process(delta: float) -> void:
	if _failed:
		return
	_frame += 1
	_game_time += delta
	var ticks: float = floorf(_game_time * 60.0)
	var span: float = ROOT_SIZE.x - HEARTBEAT_SIZE
	_heartbeat.position.x = fmod(ticks * HEARTBEAT_PX_PER_TICK, span)
	_scene.call("tick", _game_time)
	if _frame == SHOT_FRAME and _shot_dir != "" and DisplayServer.get_name() != "headless":
		_shot.call_deferred()
	var quit_now: bool = _game_time >= _quit_time
	if not quit_now and _quit_file != "" and _frame % QUIT_FILE_EVERY == 0:
		quit_now = FileAccess.file_exists(_quit_file)
	if quit_now:
		_failed = true
		_log({"event": "final", "frame": _frame, "t_s": _game_time})
		print("[fixture] viewport-perf quit at frame %d (%.1fs)" % [_frame, _game_time])
		get_tree().quit(0)


func _shot() -> void:
	await RenderingServer.frame_post_draw
	var image: Image = get_viewport().get_texture().get_image()
	var path: String = _shot_dir.path_join("step-1.png")
	var err: Error = image.save_png(path)
	print("[fixture] shot %s err=%d" % [path, err])


func _count_viewports(node: Node) -> int:
	var n: int = 1 if node is SubViewport else 0
	for child: Node in node.get_children():
		n += _count_viewports(child)
	return n


func _read_environment() -> bool:
	if OS.has_environment("RS_FIXTURE_VP_SCENE"):
		_scene_name = OS.get_environment("RS_FIXTURE_VP_SCENE").strip_edges()
		if _scene_name != "draw" and _scene_name != "vfx6":
			return _error("RS_FIXTURE_VP_SCENE must be draw or vfx6 (got %s)" % JSON.stringify(_scene_name))
	if OS.has_environment("RS_FIXTURE_VP_PHASE"):
		_phase = OS.get_environment("RS_FIXTURE_VP_PHASE").strip_edges()
		if _phase != "active" and _phase != "idle":
			return _error("RS_FIXTURE_VP_PHASE must be active or idle (got %s)" % JSON.stringify(_phase))
	if OS.has_environment("RS_FIXTURE_QUIT_TIME"):
		var text: String = OS.get_environment("RS_FIXTURE_QUIT_TIME").strip_edges()
		if not text.is_valid_float() or text.to_float() < 1.0:
			return _error("RS_FIXTURE_QUIT_TIME must be a number >= 1 (got %s)" % JSON.stringify(text))
		_quit_time = text.to_float()
	_quit_file = OS.get_environment("RS_FIXTURE_QUIT_FILE")
	if _quit_file != "" and not _quit_file.is_absolute_path():
		return _error("RS_FIXTURE_QUIT_FILE must be an absolute path (got %s)" % JSON.stringify(_quit_file))
	_shot_dir = OS.get_environment("RS_FIXTURE_SHOT_DIR")
	if _shot_dir != "" and not _shot_dir.is_absolute_path():
		return _error("RS_FIXTURE_SHOT_DIR must be an absolute path (got %s)" % JSON.stringify(_shot_dir))
	var log_path: String = OS.get_environment("RS_FIXTURE_STEP_LOG")
	if log_path != "":
		if not log_path.is_absolute_path():
			return _error("RS_FIXTURE_STEP_LOG must be an absolute path (got %s)" % JSON.stringify(log_path))
		_step_log_file = FileAccess.open(log_path, FileAccess.WRITE)
	return true


func _error(text: String) -> bool:
	printerr("[fixture] error: " + text)
	return false


func _log(line: Dictionary) -> void:
	if _step_log_file == null:
		return
	_step_log_file.store_line(JSON.stringify(line, "", false))
	_step_log_file.flush()
