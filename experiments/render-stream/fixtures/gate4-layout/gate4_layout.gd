extends Node
## Gate 4 layout fixture (../../protocol/gate4-design.md "G4c" and "Q6e"): font sizes and atlas
## pages, word and arbitrary wrapping, horizontal and vertical alignment, `clip_text`, a bitmap
## outline, a shadow, subpixel positioning, an atlas page's lifetime and, as variant `lcd`, one LCD
## Label.
##
## The root is a plain `Node`. Every `CanvasItem` and every runtime `FontFile` is created in
## `_ready()`, after `GrcLoader` armed the capture extension in its own `_enter_tree()` (gate 0
## route (a)). Each font is fully configured (D3) before any Label that uses it enters the tree;
## the only later font setter is step 8's `FL.hinting`, which clears FL's cache on purpose
## (Q6e "Lifetime"). Construction order is expected.json `creation_order` (wire ids).
## make_expected.py models the same scene from its own copy of these numbers; the two must agree.
##
## Every Label is configured (font, size, colours, constants, wrapping, alignment, clipping, text)
## before `add_child`, and its box size is set right after, when its minimum size is current: a
## size set while the minimum is stale would keep the stale width (an autowrap Label shrinks to
## its box only when the minimum it is compared with is already the autowrap one).
##
## Environment (all optional; an invalid value prints an error and quits 2):
##   RS_FIXTURE_STEP_LOG    absolute path: one JSONL line per step at its applied frame
##   RS_FIXTURE_SHOT_DIR    absolute dir: step-<k>.png at each settle frame and early-<k>.png at
##                          S+N*k+1 for k in EARLY_SHOT_STEPS (rendered runs only)
##   RS_FIXTURE_ENV_LOG     absolute path: env.json (TextServer, font hashes and properties, the
##                          pinned project settings, viewport oversampling, locale)
##   RS_FIXTURE_GLYPH_LOG   absolute path: the glyph oracle (glyph_oracle.gd), one JSONL line per
##                          settle frame, pages under <dir>/pages/. Reference legs only: refused
##                          (exit 2) when any GRC_* capture variable is set, and refused with the
##                          lcd variant.
##   RS_FIXTURE_START_FRAME S >= 1, default 1
##   RS_FIXTURE_STEP_FRAMES N >= 8, default 10 (step k >= 1 at S+N*k, settled at S+N*k+7)
##   RS_FIXTURE_QUIT_FRAME  >= S+N*9+11 (the default)
##   RS_FIXTURE_VARIANT     "lcd" adds the LCD Label LC (font FC, LCD antialiasing); anything else
##                          is refused

const GlyphOracle := preload("res://glyph_oracle.gd")

## A `Node2D` drawing one axis-aligned rect (the step marker, as gates 1, 3 and 4).
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
## Steps whose first frame after the change (S+N*k+1) is also shot: every step that uploads.
const EARLY_SHOT_STEPS: Array[int] = [1, 2, 3, 4, 6, 7, 8]
## The step that clears FL's cache (Q6e "Lifetime"); the oracle names the new cache FL2 from then.
const LIFETIME_STEP: int = 8

const FONT_FILE: String = "res://fonts/OpenSans_SemiBold.woff2"
const CAPTURE_VARIABLES: Array[String] = ["GRC_EXTENSION", "GRC_MODE", "GRC_CALIBRATION", "GRC_EVIDENCE_DIR", "GRC_STREAM_OUT"]

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

const PINNED_SETTINGS: Array[String] = [
	"internationalization/rendering/text_driver",
	"internationalization/rendering/root_node_layout_direction",
	"internationalization/locale/test",
	"internationalization/locale/fallback",
	"gui/theme/default_font_antialiasing",
	"gui/theme/default_font_hinting",
	"gui/theme/default_font_subpixel_positioning",
	"gui/theme/default_font_multichannel_signed_distance_field",
	"gui/theme/default_font_generate_mipmaps",
	"gui/theme/lcd_subpixel_layout",
	"gui/theme/default_theme_scale",
	"gui/theme/custom",
	"gui/theme/custom_font",
	"gui/common/snap_controls_to_pixels",
	"display/window/stretch/mode",
	"display/window/stretch/scale",
]

var font_f: FontFile
var font_x: FontFile
var font_l: FontFile
var font_c: FontFile
var panel: ColorRect
var lz: Label
var ls: Label
var lw: Label
var lr: Label
var lk: Label
var lo: Label
var lsh: Label
var lx: Label
var al: Label
var ac: Label
var ar: Label
var af: Label
var ll: Label
var lp: Label
var lc: Label
var marker: RectNode
## Text nodes in tree order, and the oracle's font keys (insertion-ordered).
var text_nodes: Array[Label] = []
var font_keys: Dictionary = {}

var _variant: String = ""
var _frame: int = 0
var _start_frame: int = START_FRAME_DEFAULT
var _step_frames: int = STEP_FRAMES_DEFAULT
var _quit_frame: int = 0
var _shot_dir: String = ""
var _env_log: String = ""
var _step_log_file: FileAccess
var _oracle: GlyphOracle
var _failed: bool = false


func _ready() -> void:
	if not _read_environment():
		_failed = true
		get_tree().quit(2)
		return

	# The runtime FontFiles, configured before anything uses them (D3). F is G4a's font; FX differs
	# only in subpixel positioning (auto: quarter pixel at 14 px); FL is F's twin whose cache step 8
	# clears; FC (variant lcd) differs only in LCD antialiasing.
	font_f = _font(TextServer.FONT_ANTIALIASING_GRAY, TextServer.SUBPIXEL_POSITIONING_DISABLED)
	font_x = _font(TextServer.FONT_ANTIALIASING_GRAY, TextServer.SUBPIXEL_POSITIONING_AUTO)
	font_l = _font(TextServer.FONT_ANTIALIASING_GRAY, TextServer.SUBPIXEL_POSITIONING_DISABLED)
	if _variant == "lcd":
		font_c = _font(TextServer.FONT_ANTIALIASING_LCD, TextServer.SUBPIXEL_POSITIONING_DISABLED)
	if font_f == null or font_x == null or font_l == null or (_variant == "lcd" and font_c == null):
		_failed = true
		get_tree().quit(2)
		return

	# Construction order is the wire id order: a CanvasItem calls canvas_item_create in its
	# constructor.
	panel = ColorRect.new()
	panel.name = "P"
	panel.position = Vector2(304, 8)
	panel.size = Vector2(272, 240)
	panel.color = Color(1, 1, 0.8, 1)

	lz = _label("LZ", Vector2(16, 12), font_f, 16, Color(1, 1, 1, 1), "Grow")
	ls = _label("LS", Vector2(160, 12), font_f, 12, Color(1, 0.8, 0.2, 1), "Small text")
	lw = _label("LW", Vector2(16, 72), font_f, 16, Color(1, 1, 1, 1), "Wrap these words")
	lw.autowrap_mode = TextServer.AUTOWRAP_WORD
	lr = _label("LR", Vector2(160, 72), font_f, 16, Color(0.8, 0.8, 1, 0.6), "Arbitrary")
	lr.autowrap_mode = TextServer.AUTOWRAP_ARBITRARY
	lk = _label("LK", Vector2(16, 132), font_f, 16, Color(0.4, 1, 0.6, 1), "Clipped text runs on")
	lk.clip_text = true
	lo = _label("LO", Vector2(160, 132), font_f, 24, Color(1, 1, 1, 1), "Outline")
	lo.add_theme_constant_override("outline_size", 4)
	lo.add_theme_color_override("font_outline_color", Color(0.8, 0.2, 0.2, 1))
	lsh = _label("LSh", Vector2(16, 192), font_f, 24, Color(1, 0.8, 0.2, 1), "Shadow")
	lsh.add_theme_color_override("font_shadow_color", Color(0, 0, 0, 1))
	lsh.add_theme_constant_override("shadow_offset_x", 2)
	lsh.add_theme_constant_override("shadow_offset_y", 2)
	# The default theme's shadow_outline_size is 1, which would draw a shadow outline pass from
	# its own (24, 1) cache; 0 keeps the shadow on the text's page (Q6e).
	lsh.add_theme_constant_override("shadow_outline_size", 0)
	lx = _label("LX", Vector2(160, 192), font_x, 14, Color(1, 1, 1, 1), "Subpixel aqua")
	al = _label("AL", Vector2(312, 12), font_f, 16, Color(0, 0, 0.2, 1), "Left")
	al.horizontal_alignment = HORIZONTAL_ALIGNMENT_LEFT
	al.vertical_alignment = VERTICAL_ALIGNMENT_TOP
	ac = _label("AC", Vector2(448, 12), font_f, 16, Color(0, 0.2, 0, 1), "Centre")
	ac.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	ac.vertical_alignment = VERTICAL_ALIGNMENT_CENTER
	ar = _label("AR", Vector2(312, 92), font_f, 16, Color(0.2, 0, 0, 1), "Right")
	ar.horizontal_alignment = HORIZONTAL_ALIGNMENT_RIGHT
	ar.vertical_alignment = VERTICAL_ALIGNMENT_BOTTOM
	af = _label("AF", Vector2(448, 92), font_f, 16, Color(0, 0, 0, 0.6), "Fill two")
	af.horizontal_alignment = HORIZONTAL_ALIGNMENT_FILL
	af.vertical_alignment = VERTICAL_ALIGNMENT_TOP
	ll = _label("LL", Vector2(312, 172), font_l, 16, Color(0, 0, 0.2, 1), "Lifetime")
	lp = _label("LP", Vector2(16, 147), font_f, 320, Color(0.6, 0.8, 1, 1), "ZYX")
	lp.clip_text = true
	marker = RectNode.new()
	marker.name = "Marker"
	marker.position = Vector2(592, 16)
	marker.rect = Rect2(0, 0, 32, 32)
	marker.color = MARKER_COLORS[0]
	if _variant == "lcd":
		lc = _label("LC", Vector2(448, 172), font_c, 16, Color(0, 0, 0.2, 1), "LCD text")

	text_nodes = [lz, ls, lw, lr, lk, lo, lsh, lx, al, ac, ar, af, ll, lp]
	var children: Array[Node] = [panel, lz, ls, lw, lr, lk, lo, lsh, lx, al, ac, ar, af, ll, lp, marker]
	if lc != null:
		children.append(lc)
		text_nodes.append(lc)
	for node: Node in children:
		add_child(node)
	# Box sizes. A free Label keeps the larger of its box and its minimum size: the wrapping Labels
	# grow to their lines' height, LP to one 320 px line's height (its box is 600 wide, as Q6e
	# asks). A Label shapes at its current width, and an autowrap Label entering the tree is 0 wide,
	# so its first minimum is one word (LW) or one grapheme (LR) per line, and a size only ever
	# grows past a stale minimum. Each box is therefore set, the Label reshaped at the new width
	# (get_minimum_size re-shapes and invalidates the cached minimum), and the box set again.
	var boxes: Array[Array] = [
		[lw, Vector2(120, 23)], [lr, Vector2(48, 23)], [lk, Vector2(80, 28)], [al, Vector2(120, 64)],
		[ac, Vector2(120, 64)], [ar, Vector2(120, 64)], [af, Vector2(120, 64)], [lp, Vector2(600, 120)],
	]
	for entry: Array in boxes:
		var label: Label = entry[0]
		var box: Vector2 = entry[1]
		label.size = box
		label.get_minimum_size()
		label.size = box
	font_keys = {"F": font_f, "FX": font_x, "FL": font_l}

	if _env_log != "":
		_write_env()

	_log_step(0, 1, _start_frame + SETTLE_OFFSET)
	print("[fixture] gate4-layout ready: S=%d N=%d quit=%d variant=%s" % [_start_frame, _step_frames, _quit_frame, _variant if _variant != "" else "-"])


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
		if _oracle != null:
			_oracle.record(settle_step, _frame, text_nodes, font_keys)
		_maybe_take_shot("step-%d.png" % settle_step)

	var early_step: int = _step_at(_frame, 1)
	if early_step in EARLY_SHOT_STEPS:
		_maybe_take_shot("early-%d.png" % early_step)

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
			# Sizes: 16 -> 40 px makes the F@40 cache and its 512x512 page; F@16's page stays.
			lz.add_theme_font_size_override("font_size", 40)
		2:
			# Wrapping: both wrapping Labels rewrap in one frame.
			lw.text = "Words wrap again"
			lr.text = "Breakable"
		3:
			# Outline: new glyphs rasterize into the outline cache at draw time, one upload each.
			lo.text = "Overt"
		4:
			# Subpixel: new (glyph, x shift) variants rasterize at draw time.
			lx.text = "Subpixel wave"
		5:
			# Alignment only: no new glyphs, no texture traffic.
			ac.horizontal_alignment = HORIZONTAL_ALIGNMENT_RIGHT
			ar.vertical_alignment = VERTICAL_ALIGNMENT_TOP
		6:
			# clip_text: new overflowing text.
			lk.text = "Clip me as you can"
		7:
			# Pages: 26 capitals at 320 px fill the first 1024x1024 page and open a second.
			lp.text = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
		8:
			# Lifetime: a hinting change clears FL's cache, freeing its page; the redraw makes a new
			# page with a new RID in the same frame.
			font_l.hinting = TextServer.HINTING_NONE
			font_keys = {"F": font_f, "FX": font_x, "FL2": font_l}
		9:
			# Modulate only: the outline colour.
			lo.add_theme_color_override("font_outline_color", Color(0.2, 0.6, 1, 1))
	marker.set_color(MARKER_COLORS[step])


func _font(antialiasing: TextServer.FontAntialiasing, subpixel: TextServer.SubpixelPositioning) -> FontFile:
	var font := FontFile.new()
	var err: Error = font.load_dynamic_font(FONT_FILE)
	if err != OK:
		_error("load_dynamic_font(%s) failed: %d" % [FONT_FILE, err])
		return null
	font.antialiasing = antialiasing
	font.hinting = TextServer.HINTING_LIGHT
	font.force_autohinter = false
	font.subpixel_positioning = subpixel
	font.multichannel_signed_distance_field = false
	font.allow_system_fallback = false
	font.generate_mipmaps = false
	font.disable_embedded_bitmaps = true
	font.oversampling = 0.0
	font.keep_rounding_remainders = true
	return font


func _label(node_name: String, at: Vector2, font: Font, font_size: int, color: Color, text: String) -> Label:
	var node := Label.new()
	node.name = node_name
	node.position = at
	node.add_theme_font_override("font", font)
	node.add_theme_font_size_override("font_size", font_size)
	node.add_theme_color_override("font_color", color)
	node.text = text
	return node


func _font_entry(font: FontFile) -> Dictionary:
	return {
		"antialiasing": int(font.antialiasing),
		"hinting": int(font.hinting),
		"force_autohinter": font.force_autohinter,
		"subpixel_positioning": int(font.subpixel_positioning),
		"multichannel_signed_distance_field": font.multichannel_signed_distance_field,
		"msdf_size": font.msdf_size,
		"msdf_pixel_range": font.msdf_pixel_range,
		"allow_system_fallback": font.allow_system_fallback,
		"generate_mipmaps": font.generate_mipmaps,
		"disable_embedded_bitmaps": font.disable_embedded_bitmaps,
		"oversampling": font.oversampling,
		"keep_rounding_remainders": font.keep_rounding_remainders,
		"fallbacks": font.fallbacks.size(),
		"font_name": font.get_font_name(),
		"font_style_name": font.get_font_style_name(),
	}


func _write_env() -> void:
	var settings: Dictionary = {}
	for key: String in PINNED_SETTINGS:
		settings[key] = ProjectSettings.get_setting(key)
	# The default theme font (no Label here uses it): env.json records it as fixtures/gate4 does.
	var default_variant: Variant = lz.get_theme_default_font()
	var default_font: FontFile = default_variant
	var fonts: Dictionary = {"F": _font_entry(font_f), "FX": _font_entry(font_x), "FL": _font_entry(font_l), "DF": _font_entry(default_font)}
	if font_c != null:
		fonts["FC"] = _font_entry(font_c)
	var data: Dictionary = {
		"schema": "render-stream-gate4-env/1",
		"text_server": TextServerManager.get_primary_interface().get_name(),
		"font_files": {FONT_FILE.get_file(): FileAccess.get_sha256(FONT_FILE)},
		"fonts": fonts,
		"settings": settings,
		"viewport_oversampling": get_viewport().get_oversampling(),
		"tool_locale": TranslationServer.get_tool_locale(),
	}
	var file: FileAccess = FileAccess.open(_env_log, FileAccess.WRITE)
	if file == null:
		_error("cannot open RS_FIXTURE_ENV_LOG=%s" % _env_log)
		return
	file.store_string(JSON.stringify(data, "  ") + "\n")
	file.close()


func _read_environment() -> bool:
	if OS.has_environment("RS_FIXTURE_VARIANT"):
		var variant: String = OS.get_environment("RS_FIXTURE_VARIANT")
		if variant != "lcd":
			_error("RS_FIXTURE_VARIANT must be lcd (got %s)" % JSON.stringify(variant))
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
	var env_log: String = _path_env("RS_FIXTURE_ENV_LOG")
	var glyph_log: String = _path_env("RS_FIXTURE_GLYPH_LOG")
	if step_log == "!" or shot_dir == "!" or env_log == "!" or glyph_log == "!":
		return false
	_shot_dir = shot_dir
	_env_log = env_log
	if step_log != "":
		_step_log_file = FileAccess.open(step_log, FileAccess.WRITE)
		if _step_log_file == null:
			_error("cannot open RS_FIXTURE_STEP_LOG=%s" % step_log)
			return false
	if glyph_log != "":
		for name: String in CAPTURE_VARIABLES:
			if OS.has_environment(name):
				_error("RS_FIXTURE_GLYPH_LOG runs on reference legs only, but %s is set" % name)
				return false
		if _variant != "":
			_error("RS_FIXTURE_GLYPH_LOG does not run with RS_FIXTURE_VARIANT=%s" % _variant)
			return false
		_oracle = GlyphOracle.new()
		if not _oracle.open(glyph_log):
			_error("cannot open RS_FIXTURE_GLYPH_LOG=%s" % glyph_log)
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
