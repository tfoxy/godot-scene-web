extends Node
## Gate 1 retained-state fixture (../../protocol/gate1-design.md "Q6. Fixture (G1a)").
##
## The root is a plain `Node`; every `CanvasItem` is created in `_ready()`, after `GrcLoader`
## armed the capture extension in its own `_enter_tree()` (gate 0 route (a)), so the mirror sees
## each `canvas_item_create`. Eleven steps each exercise one retained behaviour; expected.json is
## the only source of the numbers below and this script's literals must match it exactly.
##
## Environment (all optional; an invalid value prints an error and quits 2):
##   RS_FIXTURE_STEP_LOG    absolute path: one JSONL line per step at its applied frame
##   RS_FIXTURE_SHOT_DIR    absolute dir: step-<k>.png at each settle frame (rendered runs only)
##   RS_FIXTURE_ROOT_LOG    absolute path: one JSONL root-geometry line per settle frame
##   RS_FIXTURE_START_FRAME S >= 1, default 1
##   RS_FIXTURE_STEP_FRAMES N >= 8, default 10 (step k >= 1 at S+N*k, settled at S+N*k+7)
##   RS_FIXTURE_QUIT_FRAME  >= S+N*10+11 (the default)
##   RS_FIXTURE_SHOT_FRAMES CSV of frames >= 1: also frame-<n>.png at each (rendered runs only)
##   RS_FIXTURE_TIE         disjoint (default) or overlap: whether step 1's new top-level T sits
##                          alone (80,304, 32x32) or over P and Q's children (112,112, 224x32)


## A `Node2D` whose `_draw()` paints a list of axis-aligned (Rect2, Color) pairs, in order.
class RectNode extends Node2D:
	var rects: Array[Rect2] = []
	var colors: Array[Color] = []

	func _draw() -> void:
		for i: int in rects.size():
			draw_rect(rects[i], colors[i])

	func set_rects(new_rects: Array[Rect2], new_colors: Array[Color]) -> void:
		rects = new_rects
		colors = new_colors
		queue_redraw()


const LAST_STEP: int = 10
const SETTLE_OFFSET: int = 7
const START_FRAME_DEFAULT: int = 1
const STEP_FRAMES_DEFAULT: int = 10
const QUIT_AFTER_LAST_SETTLE: int = 4  # quit default S + N*10 + 11 = last settle + 4

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
	Color(0.2, 0.6, 0.2, 1),
]

var p: RectNode
var c: RectNode
var g: RectNode
var q: RectNode
var q1: RectNode
var q2: RectNode
var r: RectNode
var r1: RectNode
var v: RectNode
var v1: RectNode
var k: RectNode
var l: RectNode
var m: RectNode
var m1: RectNode
var d: RectNode
var corner: ColorRect
var marker: RectNode
var l2: RectNode
var t: RectNode
var y: RID
var x: RID

var _frame: int = 0
var _start_frame: int = START_FRAME_DEFAULT
var _step_frames: int = STEP_FRAMES_DEFAULT
var _quit_frame: int = 0
var _shot_dir: String = ""
var _shot_frames: Array[int] = []
var _tie_overlap: bool = false
var _step_log_file: FileAccess
var _root_log_file: FileAccess
var _failed: bool = false


func _ready() -> void:
	if not _read_environment():
		_failed = true
		get_tree().quit(2)
		return

	# Construction order is the wire id order (expected.json creation_order): a CanvasItem calls
	# canvas_item_create in its constructor.
	p = _rect_node("P", Vector2(80, 80), [Rect2(0, 0, 64, 64)], [Color(1, 1, 1, 1)])
	c = _rect_node("C", Vector2(80, 0), [Rect2(0, 0, 48, 48)], [Color(1, 1, 1, 1)])
	g = _rect_node("G", Vector2(0, 56), [Rect2(0, 0, 32, 32)], [Color(0.6, 0.6, 0.6, 1)])
	q = _rect_node("Q", Vector2(288, 80), [], [])
	q1 = _rect_node("Q1", Vector2(0, 0), [Rect2(0, 0, 64, 64)], [Color(1, 0.4, 0, 1)])
	q2 = _rect_node("Q2", Vector2(32, 32), [Rect2(0, 0, 64, 64)], [Color(0, 0.6, 1, 1)])
	r = _rect_node("R", Vector2(400, 80), [], [])
	r1 = _rect_node("R1", Vector2(0, 0), [Rect2(0, 0, 48, 48)], [Color(0.4, 0.8, 0.4, 1)])
	v = _rect_node("V", Vector2(80, 216), [Rect2(0, 0, 64, 64)], [Color(0.2, 0.8, 0.2, 1)])
	v1 = _rect_node("V1", Vector2(80, 0), [Rect2(0, 0, 48, 48)], [Color(0.8, 0.2, 0.2, 1)])
	k = _rect_node("K", Vector2(240, 216), [Rect2(0, 0, 32, 32), Rect2(40, 0, 32, 32)], [Color(1, 0.6, 0, 1), Color(0.6, 0, 1, 1)])
	l = _rect_node("L", Vector2(360, 216), [Rect2(0, 0, 32, 32)], [Color(1, 1, 0.2, 1)])
	m = _rect_node("M", Vector2(400, 216), [Rect2(0, 0, 32, 32)], [Color(0.6, 0.2, 1, 1)])
	m1 = _rect_node("M1", Vector2(0, 40), [Rect2(0, 0, 16, 16)], [Color(1, 0.6, 0.2, 1)])
	d = _rect_node("D", Vector2(440, 216), [Rect2(0, 0, 32, 32)], [Color(0.2, 1, 1, 1)])
	corner = ColorRect.new()
	corner.name = "Corner"
	corner.color = Color(0.8, 0.8, 0.2, 1)
	corner.anchor_left = 1.0
	corner.anchor_top = 1.0
	corner.anchor_right = 1.0
	corner.anchor_bottom = 1.0
	corner.offset_left = -32.0
	corner.offset_top = -32.0
	corner.offset_right = 0.0
	corner.offset_bottom = 0.0
	marker = _rect_node("Marker", Vector2(592, 16), [Rect2(0, 0, 32, 32)], [MARKER_COLORS[0]])

	c.add_child(g)
	p.add_child(c)
	q.add_child(q1)
	q.add_child(q2)
	r.add_child(r1)
	v.add_child(v1)
	m.add_child(m1)
	for node: Node in [p, q, r, v, k, l, m, d, corner, marker]:
		add_child(node)

	# Raw RenderingServer items, through the hooked server. Y's draw index 1000 never ties with the
	# node items' indices; X is Y's only child.
	var root_canvas: RID = get_viewport().get_world_2d().canvas
	y = RenderingServer.canvas_item_create()
	RenderingServer.canvas_item_set_parent(y, root_canvas)
	RenderingServer.canvas_item_set_transform(y, Transform2D(0.0, Vector2(480, 216)))
	RenderingServer.canvas_item_set_draw_index(y, 1000)
	RenderingServer.canvas_item_add_rect(y, Rect2(0, 0, 32, 32), Color(1, 0.2, 0.6, 1))
	x = RenderingServer.canvas_item_create()
	RenderingServer.canvas_item_set_parent(x, y)
	RenderingServer.canvas_item_add_rect(x, Rect2(0, 40, 16, 16), Color(0.4, 0.4, 1, 1))

	# Step 0 is the `_ready` state, applied at the frame stamp of everything that runs during
	# `initialize()` (1), settled at S + 7.
	_log_step(0, 1, _start_frame + SETTLE_OFFSET)
	print("[fixture] gate1 ready: S=%d N=%d quit=%d" % [_start_frame, _step_frames, _quit_frame])


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
		_log_root(settle_step)
		_maybe_take_shot("step-%d.png" % settle_step)
	if _shot_frames.has(_frame):
		_maybe_take_shot("frame-%d.png" % _frame)

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
			p.modulate = Color(1, 0, 1, 1)
			c.self_modulate = Color(0, 1, 1, 1)
			# A top-level item entering the canvas at runtime keeps the RenderingServer default
			# draw index 0 until the deferred _top_level_raise_self runs next frame, so for this
			# one frame it ties with P (index 0). README "Gate 1b result": the tie is reported.
			# RS_FIXTURE_TIE=overlap: a 224x32 T over P and Q's children, so the tie frame (T drawn
			# right after P, under Q) looks different from the next one (T raised over everything).
			if _tie_overlap:
				t = _rect_node("T", Vector2(112, 112), [Rect2(0, 0, 224, 32)], [Color(0.6, 1, 0.4, 1)])
			else:
				t = _rect_node("T", Vector2(80, 304), [Rect2(0, 0, 32, 32)], [Color(0.6, 1, 0.4, 1)])
			add_child(t)
		2:
			p.position = Vector2(80, 96)
			c.transform = Transform2D(Vector2(0, 1), Vector2(-1, 0), Vector2(160, 0))
			r1.set_rects([Rect2(0, 0, 48, 48)], [Color(0.8, 0.8, 0, 1)])
		3:
			q.move_child(q2, 0)
		4:
			q2.z_index = 1
		5:
			q.remove_child(q1)
			r.add_child(q1)
		6:
			v.visible = false
			k.set_rects([Rect2(0, 0, 72, 32)], [Color(0.4, 0.4, 0.4, 1)])
		7:
			v.visible = true
			v1.visibility_layer = 0
			k.set_rects([], [])
		8:
			l.queue_free()
			m.queue_free()
			RenderingServer.free_rid(y)
			remove_child(d)
			k.set_rects(
				[Rect2(0, 0, 16, 16), Rect2(24, 0, 16, 16), Rect2(48, 0, 16, 16)],
				[Color(1, 0, 0, 1), Color(0, 1, 0, 1), Color(0, 0, 1, 1)])
		9:
			l2 = _rect_node("L2", Vector2(360, 216), [Rect2(0, 0, 32, 32)], [Color(0.2, 0.4, 1, 1)])
			add_child(l2)
			add_child(d)
			RenderingServer.free_rid(x)
			r.remove_child(r1)
			r.add_child(r1)
		10:
			get_viewport().canvas_transform = Transform2D(0.0, Vector2(8, 4))
	marker.set_rects([Rect2(0, 0, 32, 32)], [MARKER_COLORS[step]])


func _rect_node(node_name: String, at: Vector2, rects: Array[Rect2], colors: Array[Color]) -> RectNode:
	var node := RectNode.new()
	node.name = node_name
	node.position = at
	node.rects = rects
	node.colors = colors
	return node


func _read_environment() -> bool:
	if OS.has_environment("RS_FIXTURE_VARIANT"):
		_error("RS_FIXTURE_VARIANT is a gate 0 variable; the gate 1 fixture's only variant knob is RS_FIXTURE_TIE")
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

	var tie: String = OS.get_environment("RS_FIXTURE_TIE") if OS.has_environment("RS_FIXTURE_TIE") else "disjoint"
	if tie != "disjoint" and tie != "overlap":
		_error("RS_FIXTURE_TIE must be disjoint or overlap (got %s)" % JSON.stringify(tie))
		return false
	_tie_overlap = tie == "overlap"
	if OS.has_environment("RS_FIXTURE_SHOT_FRAMES"):
		var frames_text: String = OS.get_environment("RS_FIXTURE_SHOT_FRAMES").strip_edges()
		for part: String in frames_text.split(","):
			var token: String = part.strip_edges()
			if not token.is_valid_int() or token.to_int() < 1:
				_error("RS_FIXTURE_SHOT_FRAMES must be a CSV of frames >= 1 (got %s)" % JSON.stringify(frames_text))
				return false
			_shot_frames.append(token.to_int())

	var step_log: String = _path_env("RS_FIXTURE_STEP_LOG")
	var shot_dir: String = _path_env("RS_FIXTURE_SHOT_DIR")
	var root_log: String = _path_env("RS_FIXTURE_ROOT_LOG")
	if step_log == "!" or shot_dir == "!" or root_log == "!":
		return false
	_shot_dir = shot_dir
	if step_log != "":
		_step_log_file = FileAccess.open(step_log, FileAccess.WRITE)
		if _step_log_file == null:
			_error("cannot open RS_FIXTURE_STEP_LOG=%s" % step_log)
			return false
	if root_log != "":
		_root_log_file = FileAccess.open(root_log, FileAccess.WRITE)
		if _root_log_file == null:
			_error("cannot open RS_FIXTURE_ROOT_LOG=%s" % root_log)
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


## One root-geometry line per settle frame (gate1-design.md Q1 "What is compared with the
## reference"), written the same way by the rendered reference and the headless host.
func _log_root(step: int) -> void:
	if _root_log_file == null:
		return
	var viewport: Viewport = get_viewport()
	var window: Window = get_window()
	var rect: Rect2 = viewport.get_visible_rect()
	var line: Dictionary = {
		"step": step,
		"frame": _frame,
		"display_server": DisplayServer.get_name(),
		"window_size": [window.size.x, window.size.y],
		"visible_rect": [rect.position.x, rect.position.y, rect.size.x, rect.size.y],
		"canvas_transform": _xform_list(viewport.canvas_transform),
		"final_transform": _xform_list(viewport.get_final_transform()),
		"content_scale_size": [window.content_scale_size.x, window.content_scale_size.y],
		"content_scale_mode": int(window.content_scale_mode),
	}
	_root_log_file.store_line(JSON.stringify(line, "", false, true))
	_root_log_file.flush()


static func _xform_list(t: Transform2D) -> Array[float]:
	return [t.x.x, t.x.y, t.y.x, t.y.y, t.origin.x, t.origin.y]


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
