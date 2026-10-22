extends Node
## Gate 7 pace fixture (../../protocol/gate7-design.md Q13d `pace`, G7d): one 32x32 opaque texture
## (a Sprite2D) on a 640x360 root, moving 1 px per host frame and wrapping. Nothing else changes, so
## the first transaction carries the sprite and its texture and every later one is one transform
## patch: the workload that isolates a receiver's fixed per-frame cost (socket, decode, apply,
## submit, rAF).
##
## Position at host frame f (the capture's transaction frame, this script's `_frame`):
##   x(f) = (f + X0) mod SPAN, y = Y, with X0 = 300 and SPAN = 609 (= 640 - 32 + 1), so the square
##   is always whole on the root and the default 400-frame file timeline wraps once (x = 0 at frame
##   308). In `realtime` mode f is the game frame floor(game_time * 60) + 1 instead, so a host whose
##   pacing skips frames still moves 1 px per 1/60 s.
## The texture's four 16x16 quadrants are red, green, blue and white (top-left, top-right,
## bottom-left, bottom-right), so a presence check also proves orientation; the clear colour is the
## project's (0.2, 0.2, 0.4). expected.json is the model (presence and freshness markers).
##
## Environment (all optional; an invalid value prints an error and quits 2):
##   RS_FIXTURE_TIME        `steps` (default) or `realtime`
##   RS_FIXTURE_QUIT_FRAME  steps: the frame to quit at, >= 400 (default 400 -> transactions at
##                          frames 1..400)
##   RS_FIXTURE_QUIT_TIME   realtime: seconds of game time to quit at, >= 1 (default 30)
##   RS_FIXTURE_STEP_LOG    absolute path: one JSONL line per shot point (`step` k at its frame,
##                          applied_frame == settle_frame: nothing settles here); realtime (G7v):
##                          one `final` line at the quit frame with the square's last position, the
##                          presence and freshness marker of a live leg's final readback
##   RS_FIXTURE_SHOT_DIR    absolute dir: step-<k>.png at each shot frame (rendered runs only)

const X0: int = 300
const SPAN: int = 609
const Y: int = 164
const SIZE: int = 32
const FPS: int = 60
## The shot points (steps mode): frame of step k. Step 6 is the first frame after the wrap.
const SHOT_FRAMES: Array[int] = [10, 60, 110, 160, 210, 260, 308, 360]
const QUIT_FRAME_MIN: int = 400
const QUIT_TIME_DEFAULT: float = 30.0
const QUADRANTS: Array[Color] = [Color(1, 0, 0, 1), Color(0, 1, 0, 1), Color(0, 0, 1, 1), Color(1, 1, 1, 1)]

var _sprite: Sprite2D
var _realtime: bool = false
var _quit_frame: int = QUIT_FRAME_MIN
var _quit_time: float = QUIT_TIME_DEFAULT
var _shot_dir: String = ""
var _step_log_file: FileAccess
var _failed: bool = false
var _frame: int = 0
var _game_time: float = 0.0


static func x_at(frame: int) -> int:
	return (frame + X0) % SPAN


func _ready() -> void:
	if not _read_environment():
		_failed = true
		get_tree().quit(2)
		return
	var image: Image = Image.create_empty(SIZE, SIZE, false, Image.FORMAT_RGBA8)
	var half: int = SIZE / 2
	for qy: int in range(2):
		for qx: int in range(2):
			image.fill_rect(Rect2i(qx * half, qy * half, half, half), QUADRANTS[qy * 2 + qx])
	_sprite = Sprite2D.new()
	_sprite.name = "Square"
	_sprite.centered = false
	_sprite.texture_filter = CanvasItem.TEXTURE_FILTER_NEAREST
	_sprite.texture = ImageTexture.create_from_image(image)
	_sprite.position = Vector2(x_at(1), Y)
	add_child(_sprite)
	print("[fixture] gate7-pace ready: time=%s quit=%s" % [
		"realtime" if _realtime else "steps",
		("%.1fs" % _quit_time) if _realtime else ("frame %d" % _quit_frame)])


func _process(delta: float) -> void:
	if _failed:
		return
	_frame += 1
	_game_time += delta
	var index: int = (floori(_game_time * FPS) + 1) if _realtime else _frame
	_sprite.position = Vector2(x_at(index), Y)

	if not _realtime:
		var step: int = SHOT_FRAMES.find(_frame)
		if step >= 0:
			_log_step(step, _frame)
			_maybe_take_shot("step-%d.png" % step)
		if _frame >= _quit_frame:
			print("[fixture] quitting frame=%d time=%.3f" % [_frame, _game_time])
			get_tree().quit(0)
	elif _game_time >= _quit_time:
		if _step_log_file != null:
			_step_log_file.store_line(JSON.stringify({"final": true, "frame": _frame, "index": index, "x": x_at(index), "y": Y, "size": SIZE}))
			_step_log_file.flush()
		print("[fixture] quitting frame=%d time=%.3f index=%d" % [_frame, _game_time, index])
		get_tree().quit(0)


func _read_environment() -> bool:
	if OS.has_environment("RS_FIXTURE_TIME"):
		var mode: String = OS.get_environment("RS_FIXTURE_TIME")
		if mode != "steps" and mode != "realtime":
			_error("RS_FIXTURE_TIME must be steps or realtime (got %s)" % JSON.stringify(mode))
			return false
		_realtime = mode == "realtime"
	if OS.has_environment("RS_FIXTURE_QUIT_FRAME"):
		var text: String = OS.get_environment("RS_FIXTURE_QUIT_FRAME").strip_edges()
		if _realtime or not text.is_valid_int() or text.to_int() < QUIT_FRAME_MIN:
			_error("RS_FIXTURE_QUIT_FRAME needs steps mode and an integer >= %d (got %s)" % [QUIT_FRAME_MIN, JSON.stringify(text)])
			return false
		_quit_frame = text.to_int()
	if OS.has_environment("RS_FIXTURE_QUIT_TIME"):
		var quit_text: String = OS.get_environment("RS_FIXTURE_QUIT_TIME").strip_edges()
		if not _realtime or not quit_text.is_valid_float() or quit_text.to_float() < 1.0:
			_error("RS_FIXTURE_QUIT_TIME needs realtime mode and seconds >= 1 (got %s)" % JSON.stringify(quit_text))
			return false
		_quit_time = quit_text.to_float()
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


func _log_step(step: int, frame: int) -> void:
	if _step_log_file == null:
		return
	_step_log_file.store_line("{\"step\":%d,\"applied_frame\":%d,\"settle_frame\":%d}" % [step, frame, frame])
	_step_log_file.flush()


## Rendered runs only: headless has no draw path, so frame_post_draw never fires there. Called
## without `await` from `_process`, so the coroutine finishes while frames keep advancing.
func _maybe_take_shot(file_name: String) -> void:
	if DisplayServer.get_name() == "headless" or _shot_dir == "":
		return
	await RenderingServer.frame_post_draw
	var out_path: String = _shot_dir.path_join(file_name)
	var image: Image = get_viewport().get_texture().get_image()
	var err: Error = image.save_png(out_path)
	print("[fixture] shot saved=%s err=%d" % [out_path, err])
