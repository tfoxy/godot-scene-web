extends Node
## Gate 3 rotated/scaled clipping fixture (../../protocol/gate3-design.md "Q6d", increment G3c).
##
## The root is a plain `Node`; every `CanvasItem` is created in `_ready()`, after `GrcLoader`
## armed the capture extension in its own `_enter_tree()` (gate 0 route (a)), so the mirror sees
## each `canvas_item_create`. Construction order is expected.json `creation_order` (wire ids).
## make_expected.py models the same scene from its own copy of these numbers; the two must agree.
##
## Four groups, each a clip_contents Control under a transformed Node2D parent:
##   rot      RP (rotated 30) > RQ (clip, pivot at its centre) > RQF (covers RQ's bounding box), RQI
##   rotnest  OA (clip, axis-aligned) > RP2 (rotated 20) > RQ2 (clip) > RQ2F
##   half     SP (scale 1.5) > SQ (clip, half-pixel box) > SQF, SR (clip, a 0.75 px sliver) > SRF
##   flip     FP (scale (-1, 1)) > FQ (clip) > FQF, FQI
## The engine clips each to the rounded axis-aligned bounding box of its rect under the full
## transform, intersected with the nearest clipping ancestor's rounded scissor (Q1c).
##
## Environment (all optional; an invalid value prints an error and quits 2):
##   RS_FIXTURE_STEP_LOG    absolute path: one JSONL line per step at its applied frame
##   RS_FIXTURE_SHOT_DIR    absolute dir: step-<k>.png at each settle frame (rendered runs only)
##   RS_FIXTURE_START_FRAME S >= 1, default 1
##   RS_FIXTURE_STEP_FRAMES N >= 8, default 10 (step k >= 1 at S+N*k, settled at S+N*k+7)
##   RS_FIXTURE_QUIT_FRAME  >= S+N*4+11 (the default, 52)
##   RS_FIXTURE_VARIANT     refused: gate3-xform has no variant


## A `Node2D` drawing one axis-aligned rect (the step marker, as gate 1's).
class RectNode extends Node2D:
	var rect: Rect2 = Rect2()
	var color: Color = Color.BLACK

	func _draw() -> void:
		draw_rect(rect, color)

	func set_color(new_color: Color) -> void:
		color = new_color
		queue_redraw()


const LAST_STEP: int = 4
const SETTLE_OFFSET: int = 7
const START_FRAME_DEFAULT: int = 1
const STEP_FRAMES_DEFAULT: int = 10
const QUIT_AFTER_LAST_SETTLE: int = 4  # quit default S + N*4 + 11 = last settle + 4

const MARKER_COLORS: Array[Color] = [
	Color(0, 0, 0, 1),
	Color(1, 1, 0, 1),
	Color(0, 1, 1, 1),
	Color(0.4, 0, 0.4, 1),
	Color(0, 0.4, 0, 1),
]

var rp: Node2D
var rq: Control
var sp: Node2D
var fp: Node2D
var marker: RectNode

var _frame: int = 0
var _start_frame: int = START_FRAME_DEFAULT
var _step_frames: int = STEP_FRAMES_DEFAULT
var _quit_frame: int = 0
var _shot_dir: String = ""
var _step_log_file: FileAccess
var _failed: bool = false


func _ready() -> void:
	if not _read_environment():
		_failed = true
		get_tree().quit(2)
		return

	# Construction order is the wire id order: a CanvasItem calls canvas_item_create in its
	# constructor.
	# rot: RQ's 80x40 rect rotates about its own centre (the pivot), which sits on RP's origin.
	rp = _node2d("RP", Vector2(128, 120), 30.0, Vector2(1, 1))
	rq = _control("RQ", Vector2(-40, -20), Vector2(80, 40), true)
	rq.pivot_offset = Vector2(40, 20)
	var rqf: ColorRect = _color_rect("RQF", Vector2(-40, -40), Vector2(160, 120), Color(1, 0.6, 0, 1))
	var rqi: ColorRect = _color_rect("RQI", Vector2(24, 8), Vector2(24, 24), Color(0, 0.6, 1, 1))
	# rotnest: a rotated clip owner inside an axis-aligned one.
	var oa: Control = _control("OA", Vector2(232, 64), Vector2(96, 96), true)
	var rp2: Node2D = _node2d("RP2", Vector2(48, 48), 20.0, Vector2(1, 1))
	var rq2: Control = _control("RQ2", Vector2(-64, -12), Vector2(128, 24), true)
	var rq2f: ColorRect = _color_rect("RQ2F", Vector2(-48, -48), Vector2(224, 120), Color(0.6, 1, 0.2, 1))
	# half: every value is exact in float32; SQ's box lands on half pixels, SR is 0.75 px wide.
	sp = _node2d("SP", Vector2(360, 40), 0.0, Vector2(1.5, 1.5))
	var sq: Control = _control("SQ", Vector2(7, 7), Vector2(21, 15), true)
	var sqf: ColorRect = _color_rect("SQF", Vector2(-8, -8), Vector2(40, 32), Color(0.8, 0.8, 0.2, 1))
	var sr: Control = _control("SR", Vector2(20.0625, 2), Vector2(0.5, 8), true)
	var srf: ColorRect = _color_rect("SRF", Vector2(-4, -4), Vector2(16, 16), Color(1, 0.2, 0.6, 1))
	# flip: a negative scale; the bounding box normalizes it.
	fp = _node2d("FP", Vector2(520, 200), 0.0, Vector2(-1, 1))
	var fq: Control = _control("FQ", Vector2(8, 8), Vector2(64, 48), true)
	var fqf: ColorRect = _color_rect("FQF", Vector2(-8, -8), Vector2(80, 64), Color(0.4, 0.2, 0.8, 1))
	var fqi: ColorRect = _color_rect("FQI", Vector2(0, 0), Vector2(16, 48), Color(0, 0.6, 1, 1))
	marker = RectNode.new()
	marker.name = "Marker"
	marker.position = Vector2(592, 16)
	marker.rect = Rect2(0, 0, 32, 32)
	marker.color = MARKER_COLORS[0]

	rp.add_child(rq)
	rq.add_child(rqf)
	rq.add_child(rqi)
	oa.add_child(rp2)
	rp2.add_child(rq2)
	rq2.add_child(rq2f)
	sp.add_child(sq)
	sq.add_child(sqf)
	sq.add_child(sr)
	sr.add_child(srf)
	fp.add_child(fq)
	fq.add_child(fqf)
	fq.add_child(fqi)
	for node: Node in [rp, oa, sp, fp, marker]:
		add_child(node)

	# Step 0 is the `_ready` state, applied at the frame stamp of everything that runs during
	# `initialize()` (1), settled at S + 7.
	_log_step(0, 1, _start_frame + SETTLE_OFFSET)
	print("[fixture] gate3-xform ready: S=%d N=%d quit=%d" % [_start_frame, _step_frames, _quit_frame])


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


## The step whose frame S + N*k + offset is `frame` (step 0 included), else -1.
func _step_at(frame: int, offset: int) -> int:
	var since: int = frame - _start_frame - offset
	if since < 0 or since % _step_frames != 0:
		return -1
	var step: int = since / _step_frames
	return step if step <= LAST_STEP else -1


func _apply_step(step: int) -> void:
	match step:
		1:
			# A Node2D parent's rotation moves RQ's scissor with no redraw.
			rp.rotation_degrees = 60.0
		2:
			# RQ's own scale redraws it: clear, transform, custom rect, clip (D3).
			rp.rotation_degrees = 30.0
			rq.scale = Vector2(1.25, 1.25)
		3:
			# A Node2D parent's scale; SR's sliver becomes a whole pixel.
			sp.scale = Vector2(2, 2)
		4:
			# Unflip.
			fp.scale = Vector2(1, 1)
	marker.set_color(MARKER_COLORS[step])


func _node2d(node_name: String, at: Vector2, degrees: float, node_scale: Vector2) -> Node2D:
	var node := Node2D.new()
	node.name = node_name
	node.position = at
	node.rotation_degrees = degrees
	node.scale = node_scale
	return node


func _control(node_name: String, at: Vector2, size: Vector2, clip: bool) -> Control:
	var node := Control.new()
	node.name = node_name
	node.position = at
	node.size = size
	node.clip_contents = clip
	return node


func _color_rect(node_name: String, at: Vector2, size: Vector2, color: Color) -> ColorRect:
	var node := ColorRect.new()
	node.name = node_name
	node.position = at
	node.size = size
	node.color = color
	return node


func _read_environment() -> bool:
	if OS.has_environment("RS_FIXTURE_VARIANT"):
		_error("RS_FIXTURE_VARIANT is not supported by the gate3-xform fixture (got %s)" % JSON.stringify(OS.get_environment("RS_FIXTURE_VARIANT")))
		return false
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
