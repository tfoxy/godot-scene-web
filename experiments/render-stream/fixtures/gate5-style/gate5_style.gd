extends Node
## Gate 5 nine-patch and stylebox fixture (../../protocol/gate5-design.md "Q6f", G5g).
##
## The root is a plain `Node`. Every `CanvasItem` and the texture are created in `_ready()`, after
## `GrcLoader` armed the capture extension in its own `_enter_tree()` (gate 0 route (a)), so the
## mirror sees each `canvas_item_create` and `texture_2d_create`. Construction order is
## expected.json `creation_order` (wire ids; the RichTextLabel's constructor makes its internal
## VScrollBar right after itself). make_expected.py models the same scene from its own copy of
## these numbers, and the two must agree.
##
## Environment (all optional; an invalid value prints an error and quits 2):
##   RS_FIXTURE_STEP_LOG    absolute path: one JSONL line per step at its applied frame
##   RS_FIXTURE_SHOT_DIR    absolute dir: step-<k>.png at each settle frame (rendered runs only)
##   RS_FIXTURE_START_FRAME S >= 1, default 1
##   RS_FIXTURE_STEP_FRAMES N >= 8, default 10 (step k >= 1 at S+N*k, settled at S+N*k+7)
##   RS_FIXTURE_QUIT_FRAME  >= S+N*9+11 (the default)
##   RS_FIXTURE_VARIANT     must be unset (this fixture has no variants)

const Regions := preload("res://style_regions.gd")

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

## `TEXN`: 16x16 RGBA8, a uniform 4-texel border around an 8x8 centre of 2x2-texel cells: the
## top-left cell `TEXN_MARK`, the others a checker of `TEXN_A` (cell x + y even) and `TEXN_B`.
const TEXN_BORDER: Color = Color(1, 1, 0.6, 1)
const TEXN_MARK: Color = Color(1, 0.4, 0.4, 1)
const TEXN_A: Color = Color(0.4, 0.2, 0.8, 1)
const TEXN_B: Color = Color(0.2, 0.8, 0.6, 1)
const NP_SIZE: Vector2 = Vector2(52, 40)
const NP_SIZE_STEP2: Vector2 = Vector2(68, 56)

var texn: ImageTexture
var ns: NinePatchRect
var nt: NinePatchRect
var nf: NinePatchRect
var nh: NinePatchRect
var tx: Regions.StyleNode
var sf: Regions.StyleNode
var sb: Regions.StyleNode
var sr: Regions.StyleNode
var ss: Regions.StyleNode
var sk: Regions.StyleNode
var dp: Panel
var fl: Regions.StyleNode
var rt: RichTextLabel
var marker: Regions.RectNode

var tx_box: StyleBoxTexture
var sf_box: StyleBoxFlat
var sb_box: StyleBoxFlat
var sr_box: StyleBoxFlat
var ss_box: StyleBoxFlat

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

	# The texture first: one texture_2d_create in _ready, after the engine's hue strip.
	var image: Image = Image.create_empty(16, 16, false, Image.FORMAT_RGBA8)
	image.fill(TEXN_BORDER)
	for cy: int in 4:
		for cx: int in 4:
			var cell: Color = TEXN_MARK if cx == 0 and cy == 0 else (TEXN_A if (cx + cy) % 2 == 0 else TEXN_B)
			image.fill_rect(Rect2i(4 + cx * 2, 4 + cy * 2, 2, 2), cell)
	texn = ImageTexture.create_from_image(image)

	# Construction order is the wire id order: a CanvasItem calls canvas_item_create in its
	# constructor.
	ns = _nine_patch("NS", Vector2(16, 16), NinePatchRect.AXIS_STRETCH_MODE_STRETCH, true)
	nt = _nine_patch("NT", Vector2(112, 16), NinePatchRect.AXIS_STRETCH_MODE_TILE, true)
	nf = _nine_patch("NF", Vector2(208, 16), NinePatchRect.AXIS_STRETCH_MODE_TILE_FIT, true)
	nh = _nine_patch("NH", Vector2(304, 16), NinePatchRect.AXIS_STRETCH_MODE_STRETCH, false)

	tx_box = StyleBoxTexture.new()
	tx_box.texture = texn
	tx_box.set_texture_margin_all(4.0)
	tx_box.set_expand_margin_all(4.0)
	tx_box.modulate_color = Color(0.6, 0.6, 1, 1)
	tx = _style_node("TX", Vector2(404, 20), Vector2(56, 40), tx_box)
	tx.texture_filter = CanvasItem.TEXTURE_FILTER_NEAREST

	sf_box = StyleBoxFlat.new()
	sf_box.bg_color = Color(0.4, 0.8, 0.4, 1)
	sf = _style_node("SF", Vector2(16, 116), Vector2(64, 48), sf_box)

	sb_box = StyleBoxFlat.new()
	sb_box.bg_color = Color(0.2, 0.4, 0.8, 1)
	sb_box.border_color = Color(1, 1, 0.6, 1)
	sb_box.border_width_left = 2
	sb_box.border_width_top = 4
	sb_box.border_width_right = 6
	sb_box.border_width_bottom = 8
	sb = _style_node("SB", Vector2(112, 116), Vector2(64, 48), sb_box)

	sr_box = StyleBoxFlat.new()
	sr_box.bg_color = Color(1, 0.4, 0.4, 1)
	sr_box.set_corner_radius_all(8)
	sr = _style_node("SR", Vector2(208, 116), Vector2(64, 48), sr_box)

	ss_box = StyleBoxFlat.new()
	ss_box.bg_color = Color(0.8, 0.8, 0.2, 1)
	ss_box.shadow_size = 4
	ss_box.shadow_offset = Vector2(2, 2)
	ss = _style_node("SS", Vector2(312, 116), Vector2(56, 40), ss_box)

	var sk_box: StyleBoxFlat = StyleBoxFlat.new()
	sk_box.bg_color = Color(0.6, 0.4, 1, 1)
	sk_box.skew = Vector2(0.2, 0)
	sk = _style_node("SK", Vector2(408, 116), Vector2(56, 40), sk_box)

	# The default theme's Panel box (radius 3, corner_detail 5, antialiased, bg (0.1,0.1,0.1,0.6)).
	dp = Panel.new()
	dp.name = "DP"
	dp.position = Vector2(504, 116)
	dp.size = Vector2(56, 40)
	dp.mouse_filter = Control.MOUSE_FILTER_IGNORE

	var fl_box: StyleBoxFlat = StyleBoxFlat.new()
	fl_box.bg_color = Color(0.2, 0.6, 0.6, 1)
	fl_box.border_color = Color(1, 0.8, 0.4, 1)
	fl_box.border_width_left = 2
	fl_box.border_width_top = 2
	fl_box.border_width_right = 2
	fl_box.border_width_bottom = 6
	fl = _style_node("FL", Vector2(16, 212), Vector2(64, 48), fl_box)
	fl.flip = true

	# Empty text: the only draws are the (empty) normal box and, while focused, the default theme's
	# focus box between clip_ignore(true) and clip_ignore(false) (rich_text_label.cpp:2466-2476).
	rt = RichTextLabel.new()
	rt.name = "RT"
	rt.position = Vector2(124, 220)
	rt.size = Vector2(56, 40)
	rt.scroll_active = false
	rt.focus_mode = Control.FOCUS_ALL
	rt.mouse_filter = Control.MOUSE_FILTER_IGNORE

	marker = Regions.RectNode.new()
	marker.name = "Marker"
	marker.position = Vector2(592, 16)
	marker.rect = Rect2(0, 0, 32, 32)
	marker.color = MARKER_COLORS[0]

	for node: Node in [ns, nt, nf, nh, tx, sf, sb, sr, ss, sk, dp, fl, rt, marker]:
		add_child(node)
	rt.grab_focus()

	# Step 0 is the `_ready` state, applied at the frame stamp of everything that runs during
	# `initialize()` (1), settled at S + 7.
	_log_step(0, 1, _start_frame + SETTLE_OFFSET)
	print("[fixture] gate5-style ready: S=%d N=%d quit=%d focus=%s" % [_start_frame, _step_frames, _quit_frame, rt.has_focus()])


func _nine_patch(node_name: String, at: Vector2, mode: NinePatchRect.AxisStretchMode, centre: bool) -> NinePatchRect:
	var np: NinePatchRect = NinePatchRect.new()
	np.name = node_name
	np.position = at
	np.size = NP_SIZE
	np.texture = texn
	np.patch_margin_left = 4
	np.patch_margin_top = 4
	np.patch_margin_right = 4
	np.patch_margin_bottom = 4
	np.axis_stretch_horizontal = mode
	np.axis_stretch_vertical = mode
	np.draw_center = centre
	np.texture_filter = CanvasItem.TEXTURE_FILTER_NEAREST
	np.mouse_filter = Control.MOUSE_FILTER_IGNORE
	return np


func _style_node(node_name: String, at: Vector2, box_size: Vector2, box: StyleBox) -> Regions.StyleNode:
	var node: Regions.StyleNode = Regions.StyleNode.new()
	node.name = node_name
	node.position = at
	node.size = box_size
	node.box = box
	node.mouse_filter = Control.MOUSE_FILTER_IGNORE
	return node


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


## The step table of fixtures/gate5-style/README.md.
func _apply_step(step: int) -> void:
	match step:
		1:
			sf_box.bg_color = Color(1, 0.6, 0.2, 1)
			sf.queue_redraw()
		2:
			# A Control's size change redraws it (CanvasItem::item_rect_changed).
			for np: NinePatchRect in [ns, nt, nf, nh]:
				np.size = NP_SIZE_STEP2
		3:
			sb_box.border_width_left = 6
			sb.queue_redraw()
		4:
			# FOCUS_EXIT queues the redraw (control.cpp:3917-3919); the focus box and its
			# clip_ignore pair go.
			rt.release_focus()
		5:
			# A Control's position change redraws nothing: the Panel's commands move unchanged.
			dp.position = dp.position + Vector2(8, 4)
		6:
			sr_box.set_corner_radius_all(12)
			sr.queue_redraw()
		7:
			ss_box.shadow_offset = Vector2(-2, 2)
			ss.queue_redraw()
		8:
			tx_box.modulate_color = Color(1, 0.6, 0.6, 1)
			tx.queue_redraw()
		9:
			get_viewport().canvas_transform = Transform2D(0.0, Vector2(8, 4))
	marker.set_color(MARKER_COLORS[step])


func _read_environment() -> bool:
	if OS.has_environment("RS_FIXTURE_VARIANT"):
		_error("RS_FIXTURE_VARIANT must be unset: gate5-style has no variants (got %s)" % JSON.stringify(OS.get_environment("RS_FIXTURE_VARIANT")))
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
