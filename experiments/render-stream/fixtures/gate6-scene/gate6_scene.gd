extends Node
## Gate 6 combined scene (../../protocol/gate6-design.md "Q6b" to "Q6d", G6a): one 640x360 copy of
## `scene_builder.gd` at the origin (cell 0, phase 0), the timelines, the time modes, the variants,
## the shots, the step log and the reference-side oracle (`scene_oracle.gd`).
##
## The root is a plain `Node`; the builder adds the top-level `Scene` Control as child 0 in
## `_ready()`, after `GrcLoader` armed the capture extension in its own `_enter_tree()`.
##
## Environment (all optional; an invalid value prints an error and quits 2):
##   RS_FIXTURE_VARIANT      "" (default), `animate` or `refused` (Q6d)
##   RS_FIXTURE_TIME         `steps` (default for file/live) or `realtime` (default for rate/soak) (D6)
##   RS_FIXTURE_TIMELINE     `file` (default), `live`, `rate` or `soak` (Q6c)
##   RS_FIXTURE_START_FRAME / RS_FIXTURE_STEP_FRAMES   override S / N (file and live)
##   RS_FIXTURE_QUIT_FRAME   >= the timeline's default quit frame (file and live)
##   RS_FIXTURE_STEP_LOG     absolute path: one JSONL line per step at its applied frame
##   RS_FIXTURE_SHOT_DIR     absolute dir: step-<k>.png at each settle frame and frame-<f>.png at
##                           each extra frame (rendered runs only)
##   RS_FIXTURE_SHOT_FRAMES  CSV of extra host frames to shoot (Q7c); the file timeline always adds
##                           S + N k + 2 for k in {1, 5, 9}
##   RS_FIXTURE_ORACLE_LOG   absolute path: scene_oracle.gd's JSONL (reference legs only: refused,
##                           exit 2, when a GRC_* capture variable is set)
##   RS_FIXTURE_QUIT_TIME    rate and soak only: seconds of game time to quit at, at least the
##                           timeline's own (30 / 370); G6c's constrained sabotage drains a backlog
##   RS_FIXTURE_TIME_OFFSET_S rate and soak only (G7v): seconds >= 0 added to every step time and
##                           to the quit time, so the timeline starts later and the scene animates
##                           unchanged until then (default 0: the timeline as Q6c defines it)
##   RS_FIXTURE_FREEZE_STATE a JSON array with one builder `freeze_state()` object (G6c): applied
##                           right after step 11, so a reference ends in a realtime host's exact
##                           frozen state. Rate and soak step logs carry `freeze` at step 11

const Builder := preload("res://scene_builder.gd")
const SceneOracle := preload("res://scene_oracle.gd")

const LAST_STEP: int = 11
const SETTLE_OFFSET: int = 7
const QUIT_AFTER_LAST_SETTLE: int = 4
const VARIANTS: Array[String] = ["animate", "refused"]
const TIMELINES: Array[String] = ["file", "live", "rate", "soak"]
const TIME_MODES: Array[String] = ["steps", "realtime"]
## Q6c: frame-indexed timelines (S, N); the file timeline's intermediate shots at S + N k + 2.
const FILE_START: int = 1
const FILE_STEP: int = 10
const FILE_MID_STEPS: Array[int] = [1, 5, 9]
const FILE_MID_OFFSET: int = 2
const LIVE_START: int = 300
const LIVE_STEP: int = 60
const LIVE_QUIT_STEPS: int = 13
## Q6c: time-indexed timelines (seconds of game time): step k at 5 + k for k <= 10.
const RATE_FIRST: float = 5.0
const RATE_STEP11: float = 28.0
const RATE_QUIT: float = 30.0
const SOAK_STEP11: float = 365.0
const SOAK_QUIT: float = 370.0
const CAPTURE_VARIABLES: Array[String] = ["GRC_EXTENSION", "GRC_MODE", "GRC_CALIBRATION", "GRC_EVIDENCE_DIR", "GRC_STREAM_OUT"]

var inst: Builder

var _variant: String = ""
var _timeline: String = "file"
var _realtime: bool = false
var _start_frame: int = FILE_START
var _step_frames: int = FILE_STEP
var _quit_frame: int = 0
var _shot_dir: String = ""
var _extra_frames: Array[int] = []
var _step_log_file: FileAccess
var _oracle: SceneOracle
var _failed: bool = false

var _frame: int = 0
var _game_time: float = 0.0
var _next_step: int = 1
## Time-indexed timelines: the frame at which each applied step settles (-1 until applied).
var _settle_at: Dictionary[int, int] = {}
var _quit_time: float = 0.0
## G7v: RS_FIXTURE_TIME_OFFSET_S (rate and soak timelines).
var _time_offset: float = 0.0
## G6c: the frozen leftovers to apply after step 11 (empty: none).
var _freeze_override: Dictionary = {}


func _ready() -> void:
	if not _read_environment():
		_failed = true
		get_tree().quit(2)
		return
	inst = Builder.new()
	inst.build(self, Vector2.ZERO, 0, 0, _variant, _realtime)
	# Step 0 is the `_ready` state, applied at the frame stamp of everything that runs during
	# `initialize()` (1), settled at S + 7 (file and live) or 7 frames in (rate and soak).
	var settle0: int = (_start_frame if _frame_indexed() else 1) + SETTLE_OFFSET
	_settle_at[0] = settle0
	_log_step(0, 1, settle0)
	print("[fixture] gate6-scene ready: variant=%s timeline=%s time=%s S=%d N=%d quit=%d focus=%s" % [
		_variant if _variant != "" else "default", _timeline, "realtime" if _realtime else "steps",
		_start_frame, _step_frames, _quit_frame, inst.le.has_focus()])


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
			_log_step(_next_step, _frame, settle, [inst.freeze_state()] if _next_step == LAST_STEP else [])
			_next_step += 1

	var game_frame: int = floori(_game_time * Builder.FPS)
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
	inst.apply_step(step)
	if step == LAST_STEP and not _freeze_override.is_empty():
		inst.apply_freeze_state(_freeze_override)
	if step == 10:
		# The root canvas transform: every root-canvas item moves by (8, 4), the HUD does not.
		get_viewport().canvas_transform = Transform2D(0.0, Vector2(8, 4))


## The step whose frame S + N*k + offset is `frame` (k >= 1; step 0 only settles), else -1.
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
		return _time_offset + (RATE_STEP11 if _timeline == "rate" else SOAK_STEP11)
	return _time_offset + RATE_FIRST + float(step)


func _quit_due() -> bool:
	if _frame_indexed():
		return _frame >= _quit_frame
	return _game_time >= _quit_time and _next_step > LAST_STEP


func _read_environment() -> bool:
	if OS.has_environment("RS_FIXTURE_VARIANT"):
		var variant: String = OS.get_environment("RS_FIXTURE_VARIANT")
		if not VARIANTS.has(variant):
			_error("RS_FIXTURE_VARIANT must be one of %s (got %s)" % [JSON.stringify(VARIANTS), JSON.stringify(variant)])
			return false
		_variant = variant
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

	_quit_time = RATE_QUIT if _timeline == "rate" else SOAK_QUIT
	if OS.has_environment("RS_FIXTURE_QUIT_TIME"):
		var quit_text: String = OS.get_environment("RS_FIXTURE_QUIT_TIME").strip_edges()
		if _frame_indexed() or not quit_text.is_valid_float() or quit_text.to_float() < _quit_time:
			_error("RS_FIXTURE_QUIT_TIME needs the rate or soak timeline and seconds >= %s (got %s)" % [_quit_time, JSON.stringify(quit_text)])
			return false
		_quit_time = quit_text.to_float()
	if OS.has_environment("RS_FIXTURE_TIME_OFFSET_S"):
		var offset_text: String = OS.get_environment("RS_FIXTURE_TIME_OFFSET_S").strip_edges()
		if _frame_indexed() or not offset_text.is_valid_float() or offset_text.to_float() < 0.0:
			_error("RS_FIXTURE_TIME_OFFSET_S needs the rate or soak timeline and seconds >= 0 (got %s)" % JSON.stringify(offset_text))
			return false
		_time_offset = offset_text.to_float()
		_quit_time += _time_offset
	if OS.has_environment("RS_FIXTURE_FREEZE_STATE"):
		var parsed: Variant = JSON.parse_string(OS.get_environment("RS_FIXTURE_FREEZE_STATE"))
		var ok: bool = parsed is Array
		if ok:
			var states: Array = parsed
			ok = states.size() == 1 and states[0] is Dictionary
			if ok:
				_freeze_override = states[0]
				ok = _freeze_override.has("sc") and _freeze_override.has("lb") and _freeze_override.has("cd_k")
		if not ok:
			_error("RS_FIXTURE_FREEZE_STATE must be a JSON array of one freeze_state() object")
			return false

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
		_oracle = SceneOracle.new()
		if not _oracle.open(oracle_log):
			_error("cannot open RS_FIXTURE_ORACLE_LOG=%s" % oracle_log)
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


func _log_step(step: int, applied_frame: int, settle_frame: int, freeze: Array = []) -> void:
	if _step_log_file == null:
		return
	if not freeze.is_empty():
		_step_log_file.store_line("{\"step\":%d,\"applied_frame\":%d,\"settle_frame\":%d,\"freeze\":%s}" % [step, applied_frame, settle_frame, JSON.stringify(freeze)])
		_step_log_file.flush()
		return
	_step_log_file.store_line("{\"step\":%d,\"applied_frame\":%d,\"settle_frame\":%d}" % [step, applied_frame, settle_frame])
	_step_log_file.flush()


## Rendered runs only: headless has no draw path, so frame_post_draw never fires there. Called
## without `await` from `_process`, so the coroutine finishes while frames keep advancing. The
## oracle line of a settle step is written at the same frame_post_draw, after this frame's draws
## (glyphs rasterized by this frame's redraws are in their pages by then).
func _maybe_take_shot(file_name: String, settle_step: int) -> void:
	if DisplayServer.get_name() == "headless":
		return
	if _shot_dir == "" and (_oracle == null or settle_step < 0):
		return
	var frame: int = _frame
	await RenderingServer.frame_post_draw
	if _oracle != null and settle_step >= 0:
		_oracle.record(settle_step, frame, inst, get_viewport())
	if _shot_dir == "":
		return
	var out_path: String = _shot_dir.path_join(file_name)
	var image: Image = get_viewport().get_texture().get_image()
	var err: Error = image.save_png(out_path)
	print("[fixture] shot saved=%s err=%d" % [out_path, err])
