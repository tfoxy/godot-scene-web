extends Node
## Gate 4 Latin grayscale text fixture (../../protocol/gate4-design.md "Q6b").
##
## The root is a plain `Node`. Every `CanvasItem` and the runtime `FontFile` are created in
## `_ready()`, after `GrcLoader` armed the capture extension in its own `_enter_tree()` (gate 0
## route (a)), so the mirror sees each `canvas_item_create` and every atlas page's
## `texture_2d_create`. The font is fully configured (D3) before any Label that uses it enters the
## tree, so no setter ever clears a cache that was already captured. Construction order is
## expected.json `creation_order` (wire ids). make_expected.py models the same scene from its own
## copy of these numbers; the two must agree.
##
## Environment (all optional; an invalid value prints an error and quits 2):
##   RS_FIXTURE_STEP_LOG    absolute path: one JSONL line per step at its applied frame
##   RS_FIXTURE_SHOT_DIR    absolute dir: step-<k>.png at each settle frame and early-<k>.png at
##                          S+N*k+1 for k in {1, 4, 7} (rendered runs only)
##   RS_FIXTURE_ENV_LOG     absolute path: env.json (TextServer, font hashes and properties, the
##                          pinned project settings, viewport oversampling, locale)
##   RS_FIXTURE_GLYPH_LOG   absolute path: the glyph oracle (glyph_oracle.gd), one JSONL line per
##                          settle frame, pages under <dir>/pages/. Reference legs only: refused
##                          (exit 2) when any GRC_* capture variable is set.
##   RS_FIXTURE_START_FRAME S >= 1, default 1
##   RS_FIXTURE_STEP_FRAMES N >= 8, default 10 (step k >= 1 at S+N*k, settled at S+N*k+7)
##   RS_FIXTURE_QUIT_FRAME  >= S+N*9+11 (the default)
##   RS_FIXTURE_VARIANT     refused: G4a has no variant

const GlyphOracle := preload("res://glyph_oracle.gd")

## A `Node2D` drawing one axis-aligned rect (the step marker, as gates 1 and 3).
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
## Steps whose first frame after the upload (S+N*k+1) is also shot (Q6b "Intermediate shots").
const EARLY_SHOT_STEPS: Array[int] = [1, 4, 7]

const FONT_FILE: String = "res://fonts/OpenSans_SemiBold.woff2"
## The capture variables whose presence refuses the oracle (it runs on reference legs only).
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

## The project settings Q1e pins, recorded in env.json as the engine reads them.
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
var panel: ColorRect
var l1: Label
var l3: Label
var ld: Label
var lt: Label
var l2: Label
var la: Label
var lh: Label
var marker: RectNode
## Text nodes in tree order, with their oracle font keys.
var text_nodes: Array[Label] = []
var font_keys: Dictionary = {}

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

	# The runtime FontFile, configured before anything uses it (D3).
	font_f = FontFile.new()
	var err: Error = font_f.load_dynamic_font(FONT_FILE)
	if err != OK:
		_error("load_dynamic_font(%s) failed: %d" % [FONT_FILE, err])
		_failed = true
		get_tree().quit(2)
		return
	font_f.antialiasing = TextServer.FONT_ANTIALIASING_GRAY
	font_f.hinting = TextServer.HINTING_LIGHT
	font_f.force_autohinter = false
	font_f.subpixel_positioning = TextServer.SUBPIXEL_POSITIONING_DISABLED
	font_f.multichannel_signed_distance_field = false
	font_f.allow_system_fallback = false
	font_f.generate_mipmaps = false
	font_f.disable_embedded_bitmaps = true
	font_f.oversampling = 0.0
	font_f.keep_rounding_remainders = true

	# Construction order is the wire id order: a CanvasItem calls canvas_item_create in its
	# constructor.
	panel = ColorRect.new()
	panel.name = "P"
	panel.position = Vector2(320, 24)
	panel.size = Vector2(248, 240)
	panel.color = Color(1, 1, 0.8, 1)
	l1 = _label("L1", Vector2(24, 32), font_f, 16, Color(1, 1, 1, 1))
	l3 = _label("L3", Vector2(24, 88), font_f, 24, Color(1, 0.8, 0.2, 1))
	ld = _label("LD", Vector2(24, 152), null, 0, Color())
	lt = _label("LT", Vector2(24, 208), font_f, 16, Color(1, 1, 1, 0.6))
	l2 = _label("L2", Vector2(344, 32), font_f, 16, Color(0, 0, 0.2, 1))
	la = _label("LA", Vector2(344, 88), font_f, 16, Color(0, 0, 0, 0.6))
	lh = _label("LH", Vector2(344, 152), font_f, 16, Color(0, 0, 0.2, 1))
	lh.visible = false
	marker = RectNode.new()
	marker.name = "Marker"
	marker.position = Vector2(592, 16)
	marker.rect = Rect2(0, 0, 32, 32)
	marker.color = MARKER_COLORS[0]

	l1.text = "Hello"
	l2.text = "Hello"
	l3.text = "Sphinx"
	ld.text = "Default"
	lt.text = "Hole"
	la.text = "Hole"
	lh.text = ""

	text_nodes = [l1, l3, ld, lt, l2, la, lh]
	for node: Node in [panel, l1, l3, ld, lt, l2, la, lh, marker]:
		add_child(node)
	font_keys = {"F": font_f, "DF": ld.get_theme_font("font")}

	if _env_log != "":
		_write_env()

	# Step 0 is the `_ready` state, applied at the frame stamp of everything that runs during
	# `initialize()` (1), settled at S + 7.
	_log_step(0, 1, _start_frame + SETTLE_OFFSET)
	print("[fixture] gate4 ready: S=%d N=%d quit=%d" % [_start_frame, _step_frames, _quit_frame])


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
			# New glyphs after frame one: Q u a r t z into F16's page, one update.
			l1.text = "Hello Quartz"
		2:
			# Transform only: no texture traffic, no content change.
			l3.position = l3.position + Vector2(8, 0)
		3:
			# A hidden Label shapes nothing (gate4-design.md Q1c).
			lh.text = "Wyvern"
		4:
			# Shown: the deferred rasterization becomes one upload (W y v n).
			lh.visible = true
		5:
			l1.text = ""
		6:
			# New placement, no new glyphs.
			l1.text = "Quartz Hello"
		7:
			# Two Labels introduce glyphs into one page in one frame: two hook versions.
			l2.text = "Jump!"
			l1.text = "Fjord"
		8:
			# Modulate-only redraw.
			l3.add_theme_color_override("font_color", Color(0.4, 1, 0.6, 1))
		9:
			# The default-theme font's own page gains `2`.
			ld.text = "Default 2"
	marker.set_color(MARKER_COLORS[step])


## A Label at `at`. `font` null keeps the default theme's font, size and colour (LD).
func _label(node_name: String, at: Vector2, font: Font, font_size: int, color: Color) -> Label:
	var node := Label.new()
	node.name = node_name
	node.position = at
	if font != null:
		node.add_theme_font_override("font", font)
		node.add_theme_font_size_override("font_size", font_size)
		node.add_theme_color_override("font_color", color)
	return node


func _write_env() -> void:
	var settings: Dictionary = {}
	for key: String in PINNED_SETTINGS:
		settings[key] = ProjectSettings.get_setting(key)
	var fonts: Dictionary = {}
	for key: String in ["F", "DF"]:
		var font: FontFile = font_keys[key]
		fonts[key] = {
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
		_error("RS_FIXTURE_VARIANT is not supported by the gate 4 fixture (G4a has no variant; got %s)" % JSON.stringify(OS.get_environment("RS_FIXTURE_VARIANT")))
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
