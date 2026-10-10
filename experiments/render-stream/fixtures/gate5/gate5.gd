extends Node
## Gate 5 immediate-geometry fixture (../../protocol/gate5-design.md "Q6b", G5b).
##
## The root is a plain `Node`. Every `CanvasItem` and both textures are created in `_ready()`,
## after `GrcLoader` armed the capture extension in its own `_enter_tree()` (gate 0 route (a)), so
## the mirror sees each `canvas_item_create` and `texture_2d_create`. Construction order is
## expected.json `creation_order` (wire ids). The region classes live in regions.gd;
## make_expected.py models the same scene from its own copy of these numbers, and the two must
## agree.
##
## Environment (all optional; an invalid value prints an error and quits 2):
##   RS_FIXTURE_STEP_LOG    absolute path: one JSONL line per step at its applied frame
##   RS_FIXTURE_SHOT_DIR    absolute dir: step-<k>.png at each settle frame (rendered runs only)
##   RS_FIXTURE_START_FRAME S >= 1, default 1
##   RS_FIXTURE_STEP_FRAMES N >= 8, default 10 (step k >= 1 at S+N*k, settled at S+N*k+7)
##   RS_FIXTURE_QUIT_FRAME  >= S+N*9+11 (the default)
##   RS_FIXTURE_VARIANT     unset (default) or "canvas" (one CanvasTexture created in `_ready`,
##                          gate5-design.md D11); any other value exits 2

const Regions := preload("res://regions.gd")

const LAST_STEP: int = 9
const SETTLE_OFFSET: int = 7
const START_FRAME_DEFAULT: int = 1
const STEP_FRAMES_DEFAULT: int = 10
const QUIT_AFTER_LAST_SETTLE: int = 4  # quit default S + N*9 + 11 = last settle + 4

## Gate 3's marker colours (gate 1's first ten).
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

## Q6a's textures: `TEX16`, four 8x8 quadrants (top-left, top-right, bottom-left, bottom-right);
## `TEX9`, a 4-texel border around a uniform 4x4 centre.
const TEX16_QUADRANTS: Array[Color] = [
	Color(1, 0.2, 0.2, 1),
	Color(0.2, 1, 0.2, 1),
	Color(0.2, 0.2, 1, 1),
	Color(1, 1, 0.2, 1),
]
const TEX9_BORDER: Color = Color(1, 1, 0.6, 1)
const TEX9_CENTRE: Color = Color(0.4, 0.2, 0.8, 1)

var tex16: ImageTexture
var tex9: ImageTexture
var canvas_texture: CanvasTexture
var ln: Regions.LinesNode
var pl: Regions.PolylinesNode
var pg: Regions.PolygonsNode
var pr: Regions.PrimitivesNode
var ci: Regions.CirclesNode
var st: Regions.TransformsNode
var stc: Regions.RectNode
var cg: Regions.ClipIgnoreNode
var np: Regions.NinePatchNode
var ra: Regions.AaRectNode
var bl: Regions.BlendNode
var l2: Line2D
var marker: Regions.RectNode

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

	# Textures first (Q6a): two texture_2d_create calls in _ready, after the engine's hue strip.
	var image16: Image = Image.create_empty(16, 16, false, Image.FORMAT_RGBA8)
	image16.fill_rect(Rect2i(0, 0, 8, 8), TEX16_QUADRANTS[0])
	image16.fill_rect(Rect2i(8, 0, 8, 8), TEX16_QUADRANTS[1])
	image16.fill_rect(Rect2i(0, 8, 8, 8), TEX16_QUADRANTS[2])
	image16.fill_rect(Rect2i(8, 8, 8, 8), TEX16_QUADRANTS[3])
	tex16 = ImageTexture.create_from_image(image16)
	var image9: Image = Image.create_empty(12, 12, false, Image.FORMAT_RGBA8)
	image9.fill(TEX9_BORDER)
	image9.fill_rect(Rect2i(4, 4, 4, 4), TEX9_CENTRE)
	tex9 = ImageTexture.create_from_image(image9)
	if _variant == "canvas":
		# D11: from this canvas_texture_create on, a headless host cannot tell RID() from a
		# CanvasTexture.
		canvas_texture = CanvasTexture.new()

	# Construction order is the wire id order: a CanvasItem calls canvas_item_create in its
	# constructor.
	ln = Regions.LinesNode.new()
	ln.name = "LN"
	ln.position = Vector2(16, 16)
	pl = Regions.PolylinesNode.new()
	pl.name = "PL"
	pl.position = Vector2(176, 16)
	pg = Regions.PolygonsNode.new()
	pg.name = "PG"
	pg.position = Vector2(336, 16)
	pg.tex16 = tex16
	pg.texture_filter = CanvasItem.TEXTURE_FILTER_NEAREST
	pr = Regions.PrimitivesNode.new()
	pr.name = "PR"
	pr.position = Vector2(472, 16)
	ci = Regions.CirclesNode.new()
	ci.name = "CI"
	ci.position = Vector2(16, 112)
	st = Regions.TransformsNode.new()
	st.name = "ST"
	st.position = Vector2(176, 112)
	stc = Regions.RectNode.new()
	stc.name = "STC"
	stc.position = Vector2(96, 44)
	stc.rect = Rect2(0, 0, 24, 24)
	stc.color = Color(1, 0.6, 1, 1)
	cg = Regions.ClipIgnoreNode.new()
	cg.name = "CG"
	cg.position = Vector2(344, 120)
	cg.size = Vector2(64, 48)
	cg.clip_contents = true
	np = Regions.NinePatchNode.new()
	np.name = "NP"
	np.position = Vector2(472, 112)
	np.tex9 = tex9
	np.texture_filter = CanvasItem.TEXTURE_FILTER_NEAREST
	ra = Regions.AaRectNode.new()
	ra.name = "RA"
	ra.position = Vector2(16, 208)
	bl = Regions.BlendNode.new()
	bl.name = "BL"
	bl.position = Vector2(176, 208)
	l2 = Line2D.new()
	l2.name = "L2"
	l2.position = Vector2(328, 216)
	l2.points = PackedVector2Array([Vector2(8, 8), Vector2(72, 8), Vector2(72, 56)])
	l2.width = 6.0
	l2.joint_mode = Line2D.LINE_JOINT_SHARP
	l2.begin_cap_mode = Line2D.LINE_CAP_NONE
	l2.end_cap_mode = Line2D.LINE_CAP_NONE
	l2.default_color = Color(1, 0.6, 0.2, 1)
	l2.antialiased = false
	marker = Regions.RectNode.new()
	marker.name = "Marker"
	marker.position = Vector2(592, 16)
	marker.rect = Rect2(0, 0, 32, 32)
	marker.color = MARKER_COLORS[0]

	st.add_child(stc)
	for node: Node in [ln, pl, pg, pr, ci, st, cg, np, ra, bl, l2, marker]:
		add_child(node)

	# Step 0 is the `_ready` state, applied at the frame stamp of everything that runs during
	# `initialize()` (1), settled at S + 7.
	_log_step(0, 1, _start_frame + SETTLE_OFFSET)
	print("[fixture] gate5 ready: S=%d N=%d quit=%d variant=%s" % [_start_frame, _step_frames, _quit_frame, _variant if _variant != "" else "none"])


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


## gate5-design.md Q6b's timeline.
func _apply_step(step: int) -> void:
	match step:
		1:
			ln.l2_width = 4.0
		2:
			pg.g1_offset = Vector2(0, 8)
		3:
			pl.p1_color = Color(1, 0.8, 0.2, 1)
			# Line2D stores `antialiased` and never passes it on: same bytes, same pixels.
			l2.antialiased = true
		4:
			pr.r3_count = 4
		5:
			st.b_scale = 3.0
		6:
			ci.c1_radius = 20.0
		7:
			# A Control's position change redraws nothing: clip and clip-ignored content move.
			cg.position = cg.position + Vector2(16, 8)
		8:
			ln.l6_antialiased = false
		9:
			get_viewport().canvas_transform = Transform2D(0.0, Vector2(8, 4))
	marker.set_color(MARKER_COLORS[step])


func _read_environment() -> bool:
	if OS.has_environment("RS_FIXTURE_VARIANT"):
		var variant: String = OS.get_environment("RS_FIXTURE_VARIANT")
		if variant != "canvas":
			_error("RS_FIXTURE_VARIANT must be unset or \"canvas\" (got %s)" % JSON.stringify(variant))
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
