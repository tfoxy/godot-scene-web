extends Control
## Gate 8 size fixture (G8h, gate8-design.md Q4 "Fixture"). A 640x360 `canvas_items` / `expand`
## scene: a Panel with a feathered StyleBoxFlat (rounded, bordered, AA), a corner Panel and a Note
## Label anchored to the bottom-right corner, an Edge strip anchored to the right edge, and a
## Title Label. Under the headless host the root window is the 64x64 SceneTree minimum, so
## before a `presentation:640x360` arm the stretch scale is 0.1 and the visible rect is 640x640
## (expand, a square window); the arm's Window.set_min_size makes it 640x360 at scale 1.
## The timeline, in fixture frames (the main-loop iteration; the loader arms at K =
## RS_FIXTURE_ARM_FRAME, default 12):
##
##   _ready     the scene as authored
##   K          the capture arms (late). Checkpoint 0 settles at K+2.
##   K+4        Title gets new glyphs; the Corner panel changes colour. Checkpoint 1: K+11.
##   K+14       Note's font size grows; Back's border widens. Checkpoint 2: K+21.
##   K+26       quit
##
## The step log holds the three checkpoints ({"step", "applied_frame", "settle_frame"}) in every
## leg. RS_FIXTURE_SIZE_LOG (absolute path) gets one JSONL line at K-1 and K+1: the window size,
## the visible rect, the root stretch and the viewport's oversampling as the engine reports them
## (late-size-match's independent read).
##
## Environment (all optional): RS_FIXTURE_STEP_LOG, RS_FIXTURE_SHOT_DIR (rendered runs only),
## RS_FIXTURE_SIZE_LOG, RS_FIXTURE_QUIT_FRAME (>= K+26, the default).

const SETTLE_OFFSET: int = 7

var _frame: int = 0
var _arm_frame: int = 12
var _quit_frame: int = 0
var _shot_dir: String = ""
var _step_log_file: FileAccess
var _size_log_file: FileAccess
var _failed: bool = false
## [applied_frame, settle_frame] per checkpoint
var _checkpoints: Array[Array] = []


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
	print("[fixture] gate8-size ready: K=%d quit=%d" % [_arm_frame, _quit_frame])


func _process(_delta: float) -> void:
	if _failed:
		return
	_frame += 1
	if _frame == _arm_frame - 1 or _frame == _arm_frame + 1:
		_probe()
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
			_maybe_take_shot("step-%d.png" % k)
	if _frame >= _quit_frame:
		print("[fixture] quitting frame=%d" % _frame)
		get_tree().quit(0)


func _step_1() -> void:
	($Title as Label).text = "Late presentation: glyphs 0123"
	($Corner as Panel).self_modulate = Color(1, 0.8, 0.6, 1)


func _step_2() -> void:
	($Note as Label).add_theme_font_size_override("font_size", 20)
	var back := $Back as Panel
	var style: StyleBoxFlat = (back.get_theme_stylebox("panel") as StyleBoxFlat).duplicate()
	style.set_border_width_all(7)
	back.add_theme_stylebox_override("panel", style)


## late-size-match's independent read: what the engine reports about the root window.
func _probe() -> void:
	if _size_log_file == null:
		return
	var window: Window = get_window()
	var visible: Rect2 = get_viewport().get_visible_rect()
	var line: Dictionary = {
		"frame": _frame,
		"window": [window.size.x, window.size.y],
		"visible": [visible.size.x, visible.size.y],
		"content_scale_size": [window.content_scale_size.x, window.content_scale_size.y],
		"oversampling": get_viewport().get_oversampling(),
		"stretch": [get_viewport().get_stretch_transform().x.x, get_viewport().get_stretch_transform().y.y],
	}
	_size_log_file.store_line(JSON.stringify(line, "", false))
	_size_log_file.flush()


func _read_environment() -> bool:
	var quit_default: int = _arm_frame + 26
	_quit_frame = quit_default
	if OS.has_environment("RS_FIXTURE_QUIT_FRAME"):
		var text: String = OS.get_environment("RS_FIXTURE_QUIT_FRAME").strip_edges()
		if not text.is_valid_int() or text.to_int() < quit_default:
			_error("RS_FIXTURE_QUIT_FRAME must be an integer >= %d (got %s)" % [quit_default, JSON.stringify(text)])
			return false
		_quit_frame = text.to_int()
	var step_log: String = _path_env("RS_FIXTURE_STEP_LOG")
	_shot_dir = _path_env("RS_FIXTURE_SHOT_DIR")
	var size_log: String = _path_env("RS_FIXTURE_SIZE_LOG")
	if step_log == "!" or _shot_dir == "!" or size_log == "!":
		return false
	if step_log != "":
		_step_log_file = FileAccess.open(step_log, FileAccess.WRITE)
		if _step_log_file == null:
			_error("cannot open RS_FIXTURE_STEP_LOG=%s" % step_log)
			return false
	if size_log != "":
		_size_log_file = FileAccess.open(size_log, FileAccess.WRITE)
		if _size_log_file == null:
			_error("cannot open RS_FIXTURE_SIZE_LOG=%s" % size_log)
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
