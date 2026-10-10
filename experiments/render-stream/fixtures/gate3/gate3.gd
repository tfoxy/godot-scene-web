extends Node
## Gate 3 axis-aligned clipping fixture (../../protocol/gate3-design.md "Q6b").
##
## The root is a plain `Node`; every `CanvasItem` is created in `_ready()`, after `GrcLoader`
## armed the capture extension in its own `_enter_tree()` (gate 0 route (a)), so the mirror sees
## each `canvas_item_create`. Construction order is expected.json `creation_order` (wire ids).
## make_expected.py models the same scene from its own copy of these numbers; the two must agree.
##
## Environment (all optional; an invalid value prints an error and quits 2):
##   RS_FIXTURE_STEP_LOG    absolute path: one JSONL line per step at its applied frame
##   RS_FIXTURE_SHOT_DIR    absolute dir: step-<k>.png at each settle frame (rendered runs only)
##   RS_FIXTURE_START_FRAME S >= 1, default 1
##   RS_FIXTURE_STEP_FRAMES N >= 8, default 10 (step k >= 1 at S+N*k, settled at S+N*k+7)
##   RS_FIXTURE_QUIT_FRAME  >= S+N*9+11 (the default)
##   RS_FIXTURE_VARIANT     unset (default) or "clip-ignore" (G3d); any other value exits 2

const CULL_PROBE: GDScript = preload("res://cull_probe.gd")


## A `Node2D` drawing one axis-aligned rect (the step marker, as gate 1's).
class RectNode extends Node2D:
	var rect: Rect2 = Rect2()
	var color: Color = Color.BLACK

	func _draw() -> void:
		draw_rect(rect, color)

	func set_color(new_color: Color) -> void:
		color = new_color
		queue_redraw()


const LAST_STEP: int = 9
const SETTLE_OFFSET: int = 7
const START_FRAME_DEFAULT: int = 1
const STEP_FRAMES_DEFAULT: int = 10
const QUIT_AFTER_LAST_SETTLE: int = 4  # quit default S + N*9 + 11 = last settle + 4

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

const RC_RECT: Rect2 = Rect2(8, 8, 16, 16)
const RC_COLOR: Color = Color(1, 1, 0.2, 1)

## Variant `clip-ignore` (gate3-design.md Q6b, G3d): a raw item whose second rect's clip is
## ignored by the real GLES3 rasterizer between the two `add_clip_ignore` calls (Q1d). On
## render-stream/3 a receiver saw them only as unsupported commands and clipped both rects; since
## G5d (render-stream/4) they are real commands the receiver replays, so it draws what the
## reference draws. Static: never touched after step 0.
const RI_ORIGIN: Vector2 = Vector2(472, 184)
const RI_CUSTOM_RECT: Rect2 = Rect2(0, 0, 48, 32)
const RI_RECT_1: Rect2 = Rect2(0, 0, 48, 32)
const RI_COLOR_1: Color = Color(0.4, 0.8, 0.4, 1)
const RI_RECT_2: Rect2 = Rect2(32, 16, 32, 32)
const RI_COLOR_2: Color = Color(1, 0.4, 0, 1)

var a: Control
var b: Control
var bf: ColorRect
var s1: ColorRect
var d: ColorRect
var cu: Control
var marker: RectNode
var rc: RID
var rcf: RID
var ri: RID  # variant clip-ignore only

var _variant: String = ""
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
	a = _control("A", Vector2(96, 88), Vector2(160, 120), true)
	var af: ColorRect = _color_rect("AF", Vector2(-16, -16), Vector2(192, 152), Color(1, 0.6, 0, 1))
	s1 = _color_rect("S1", Vector2(20, 8), Vector2(24, 24), Color(1, 1, 1, 1))
	b = _control("B", Vector2(100, 60), Vector2(100, 80), true)
	bf = _color_rect("BF", Vector2(-20, -20), Vector2(140, 120), Color(0, 0.6, 1, 1))
	var n: Control = _control("N", Vector2(-60, 30), Vector2(10, 10), false)
	var nf: ColorRect = _color_rect("NF", Vector2(0, 0), Vector2(200, 16), Color(0.6, 1, 0.2, 1))
	var c: Control = _control("C", Vector2(40, 40), Vector2(40, 40), true)
	var cf: ColorRect = _color_rect("CF", Vector2(-8, -8), Vector2(56, 56), Color(1, 0.2, 0.6, 1))
	var bz: ColorRect = _color_rect("BZ", Vector2(40, -10), Vector2(40, 30), Color(0.2, 1, 0.8, 1))
	bz.z_index = 1
	d = _color_rect("D", Vector2(344, 88), Vector2(64, 48), Color(0.2, 0.6, 0.2, 1))
	d.clip_contents = true
	var df: ColorRect = _color_rect("DF", Vector2(32, -12), Vector2(48, 72), Color(0.8, 0.8, 0.2, 1))
	cu = CULL_PROBE.new()
	cu.name = "CU"
	cu.position = Vector2(-48, 264)
	cu.size = Vector2(40, 40)
	var an: Control = Control.new()
	an.name = "AN"
	an.clip_contents = true
	an.anchor_left = 0.0
	an.anchor_top = 1.0
	an.anchor_right = 1.0
	an.anchor_bottom = 1.0
	an.offset_left = 88.0
	an.offset_top = -40.0
	an.offset_right = -24.0
	an.offset_bottom = -16.0
	var anf: ColorRect = _color_rect("ANF", Vector2(-8, -4), Vector2(544, 32), Color(0.8, 0.4, 0.6, 1))
	marker = RectNode.new()
	marker.name = "Marker"
	marker.position = Vector2(592, 16)
	marker.rect = Rect2(0, 0, 32, 32)
	marker.color = MARKER_COLORS[0]

	a.add_child(af)
	a.add_child(s1)
	a.add_child(b)
	b.add_child(bf)
	b.add_child(n)
	n.add_child(nf)
	b.add_child(c)
	c.add_child(cf)
	b.add_child(bz)
	d.add_child(df)
	an.add_child(anf)
	for node: Node in [a, d, cu, an, marker]:
		add_child(node)

	# Raw RenderingServer items, through the hooked server. RC clips to its own custom rect with no
	# commands of its own; RCF, its only child, overhangs it on every side. Draw index 1000 never
	# ties with the scene items' indices.
	var root_canvas: RID = get_viewport().get_world_2d().canvas
	rc = RenderingServer.canvas_item_create()
	RenderingServer.canvas_item_set_parent(rc, root_canvas)
	RenderingServer.canvas_item_set_transform(rc, Transform2D(0.0, Vector2(464, 88)))
	RenderingServer.canvas_item_set_draw_index(rc, 1000)
	RenderingServer.canvas_item_set_custom_rect(rc, true, Rect2(0, 0, 64, 48))
	RenderingServer.canvas_item_set_clip(rc, true)
	rcf = RenderingServer.canvas_item_create()
	RenderingServer.canvas_item_set_parent(rcf, rc)
	RenderingServer.canvas_item_add_rect(rcf, Rect2(-16, -8, 96, 64), Color(0.4, 0.2, 0.8, 1))

	if _variant == "clip-ignore":
		ri = RenderingServer.canvas_item_create()
		RenderingServer.canvas_item_set_parent(ri, root_canvas)
		RenderingServer.canvas_item_set_transform(ri, Transform2D(0.0, RI_ORIGIN))
		RenderingServer.canvas_item_set_draw_index(ri, 1002)
		RenderingServer.canvas_item_set_custom_rect(ri, true, RI_CUSTOM_RECT)
		RenderingServer.canvas_item_set_clip(ri, true)
		RenderingServer.canvas_item_add_rect(ri, RI_RECT_1, RI_COLOR_1)
		RenderingServer.canvas_item_add_clip_ignore(ri, true)
		RenderingServer.canvas_item_add_rect(ri, RI_RECT_2, RI_COLOR_2)
		RenderingServer.canvas_item_add_clip_ignore(ri, false)

	# Step 0 is the `_ready` state, applied at the frame stamp of everything that runs during
	# `initialize()` (1), settled at S + 7.
	_log_step(0, 1, _start_frame + SETTLE_OFFSET)
	print("[fixture] gate3 ready: S=%d N=%d quit=%d" % [_start_frame, _step_frames, _quit_frame])


## The raw items are the fixture's own; scene teardown frees every node item.
func _exit_tree() -> void:
	if rcf.is_valid():
		RenderingServer.free_rid(rcf)
	if rc.is_valid():
		RenderingServer.free_rid(rc)
	if ri.is_valid():
		RenderingServer.free_rid(ri)


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
			# Moving content: S1 crosses A's right edge; a transform-only change.
			s1.position = Vector2(148, 8)
		2:
			# B's clip window slides with no redraw; BF keeps its global place. CU's custom rect now
			# touches the viewport's left edge, which is enough to draw it.
			b.position = Vector2(80, 50)
			bf.position = Vector2(0, -10)
			cu.position = Vector2(-40, 264)
		3:
			# A resize redraws B: clear, custom rect, clip (the receiver's D3 trap).
			b.size = Vector2(60, 50)
		4:
			a.clip_contents = false
		5:
			# A toggles back on; D redraws with its clip unchanged.
			a.clip_contents = true
			d.color = Color(0.6, 0.2, 0.2, 1)
		6:
			# Clear resets clip (Q1b): no set_clip follows, so RCF is drawn whole.
			RenderingServer.canvas_item_clear(rc)
			RenderingServer.canvas_item_add_rect(rc, RC_RECT, RC_COLOR)
		7:
			# A clip with no custom rect uses the command bounds.
			RenderingServer.canvas_item_clear(rc)
			RenderingServer.canvas_item_add_rect(rc, RC_RECT, RC_COLOR)
			RenderingServer.canvas_item_set_custom_rect(rc, false)
			RenderingServer.canvas_item_set_clip(rc, true)
		8:
			# No commands and no custom rect: a zero-area clip skips RC and its subtree.
			RenderingServer.canvas_item_clear(rc)
			RenderingServer.canvas_item_set_clip(rc, true)
		9:
			get_viewport().canvas_transform = Transform2D(0.0, Vector2(8, 4))
	marker.set_color(MARKER_COLORS[step])


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
		var variant: String = OS.get_environment("RS_FIXTURE_VARIANT")
		if variant != "clip-ignore":
			_error("RS_FIXTURE_VARIANT must be unset or \"clip-ignore\" (got %s)" % JSON.stringify(variant))
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
