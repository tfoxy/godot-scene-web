extends Node
## Gate 4 MSDF fixture (../../protocol/gate4-design.md "G4e2" and "Q6e"): MSDF text on
## render-stream/3. Every Label draws from one runtime MSDF FontFile `FM` of the pinned bytes with
## the target game's parameters, msdf_size 48 and msdf_pixel_range 24 (D5), at 16, 24 and 40 px.
## One Label's outline is toggled on, one Label sits under a Node2D rotated by 20 degrees and
## scaled by 1.5. Steps cover new glyphs, a size change, the outline toggle, colour changes and a
## parent rotation.
##
## The root is a plain `Node`. Every `CanvasItem` and the runtime `FontFile` are created in
## `_ready()`, after `GrcLoader` armed the capture extension in its own `_enter_tree()` (gate 0
## route (a)). FM is fully configured (D3) before any Label that uses it enters the tree, so no
## setter ever clears a cache that was already captured. Construction order is expected.json
## `creation_order` (wire ids). make_expected.py models the same scene from its own copy of these
## numbers; the two must agree.
##
## Environment (all optional; an invalid value prints an error and quits 2):
##   RS_FIXTURE_STEP_LOG    absolute path: one JSONL line per step at its applied frame
##   RS_FIXTURE_SHOT_DIR    absolute dir: step-<k>.png at each settle frame and early-<k>.png at
##                          S+N*k+1 for k in EARLY_SHOT_STEPS (rendered runs only)
##   RS_FIXTURE_ENV_LOG     absolute path: env.json (TextServer, font hashes and properties, the
##                          pinned project settings, viewport oversampling, locale)
##   RS_FIXTURE_GLYPH_LOG   absolute path: the glyph oracle (glyph_oracle.gd), one JSONL line per
##                          settle frame, pages under <dir>/pages/. Reference legs only: refused
##                          (exit 2) when any GRC_* capture variable is set.
##   RS_FIXTURE_START_FRAME S >= 1, default 1
##   RS_FIXTURE_STEP_FRAMES N >= 8, default 10 (step k >= 1 at S+N*k, settled at S+N*k+7)
##   RS_FIXTURE_QUIT_FRAME  >= S+N*9+11 (the default)
##   RS_FIXTURE_VARIANT     refused: G4e2 has no variant

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
const EARLY_SHOT_STEPS: Array[int] = [1, 7]

const FONT_FILE: String = "res://fonts/OpenSans_SemiBold.woff2"
## D5: the target game's MSDF import values (not FontFile.new()'s 128 / 14).
const MSDF_SIZE: int = 48
const MSDF_PIXEL_RANGE: int = 24
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

var font_m: FontFile
var panel: ColorRect
var m16: Label
var m24: Label
var m40: Label
var mt: Label
var rotor: Node2D
var mr: Label
var marker: RectNode
## Text nodes in tree order, and the oracle's font keys.
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

	# The runtime MSDF FontFile, configured before anything uses it (D3, D5). Every MSDF setter
	# clears the cache (text_server_adv.cpp:2446-2471); nothing has been rasterized yet.
	font_m = FontFile.new()
	var err: Error = font_m.load_dynamic_font(FONT_FILE)
	if err != OK:
		_error("load_dynamic_font(%s) failed: %d" % [FONT_FILE, err])
		_failed = true
		get_tree().quit(2)
		return
	font_m.antialiasing = TextServer.FONT_ANTIALIASING_GRAY
	font_m.hinting = TextServer.HINTING_LIGHT
	font_m.force_autohinter = false
	font_m.subpixel_positioning = TextServer.SUBPIXEL_POSITIONING_DISABLED
	font_m.msdf_size = MSDF_SIZE
	font_m.msdf_pixel_range = MSDF_PIXEL_RANGE
	font_m.multichannel_signed_distance_field = true
	font_m.allow_system_fallback = false
	font_m.generate_mipmaps = false
	font_m.disable_embedded_bitmaps = true
	font_m.oversampling = 0.0
	font_m.keep_rounding_remainders = true

	# Construction order is the wire id order: a CanvasItem calls canvas_item_create in its
	# constructor.
	panel = ColorRect.new()
	panel.name = "P"
	panel.position = Vector2(344, 24)
	panel.size = Vector2(232, 312)
	panel.color = Color(1, 1, 0.8, 1)
	m16 = _label("M16", Vector2(24, 24), 16, Color(1, 1, 1, 1), "Hello")
	m24 = _label("M24", Vector2(24, 64), 24, Color(1, 0.8, 0.2, 1), "Sphinx")
	m40 = _label("M40", Vector2(24, 160), 40, Color(0.4, 1, 0.6, 1), "Quartz")
	mt = _label("MT", Vector2(360, 40), 24, Color(0, 0, 0, 0.6), "Jump")
	rotor = Node2D.new()
	rotor.name = "R"
	rotor.position = Vector2(400, 120)
	rotor.rotation_degrees = 20
	rotor.scale = Vector2(1.5, 1.5)
	mr = _label("MR", Vector2(0, 0), 16, Color(0.2, 0, 0.4, 1), "Turn")
	marker = RectNode.new()
	marker.name = "Marker"
	marker.position = Vector2(592, 16)
	marker.rect = Rect2(0, 0, 32, 32)
	marker.color = MARKER_COLORS[0]

	rotor.add_child(mr)
	text_nodes = [m16, m24, m40, mt, mr]
	for node: Node in [panel, m16, m24, m40, mt, rotor, marker]:
		add_child(node)
	font_keys = {"FM": font_m}

	if _env_log != "":
		_write_env()

	_log_step(0, 1, _start_frame + SETTLE_OFFSET)
	print("[fixture] gate4-msdf ready: S=%d N=%d quit=%d" % [_start_frame, _step_frames, _quit_frame])


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
			# New glyphs after frame one: W y v into FM's one page, one update.
			m16.text = "Hello Wyvern"
		2:
			# A size change 24 -> 56: the MSDF cache is keyed on msdf_size, so no upload (D5).
			m24.add_theme_font_size_override("font_size", 56)
		3:
			# Outline toggled on: the outline pass draws from the same page (ts_adv:4167).
			m40.add_theme_constant_override("outline_size", 4)
			m40.add_theme_color_override("font_outline_color", Color(1, 0.4, 0, 1))
		4:
			# Colour only.
			m16.add_theme_color_override("font_color", Color(1, 0.6, 0.6, 1))
		5:
			# Parent rotation: R's transform only; MR does not redraw.
			rotor.rotation_degrees = 35
		6:
			# Outline colour only.
			m40.add_theme_color_override("font_outline_color", Color(0.4, 1, 1, 1))
		7:
			# Two Labels introduce glyphs into the one page in one frame: two hook versions.
			mt.text = "Jump!"
			m16.text = "Wizard"
		8:
			# New placement, no new glyphs, at 56 px.
			m24.text = "Ship"
		9:
			# New text with the outline on, no new glyphs.
			m40.text = "Quartz Quiz"
	marker.set_color(MARKER_COLORS[step])


func _label(node_name: String, at: Vector2, font_size: int, color: Color, text: String) -> Label:
	var node := Label.new()
	node.name = node_name
	node.position = at
	node.add_theme_font_override("font", font_m)
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
	var default_variant: Variant = m16.get_theme_default_font()
	var default_font: FontFile = default_variant
	var data: Dictionary = {
		"schema": "render-stream-gate4-env/1",
		"text_server": TextServerManager.get_primary_interface().get_name(),
		"font_files": {FONT_FILE.get_file(): FileAccess.get_sha256(FONT_FILE)},
		"fonts": {"FM": _font_entry(font_m), "DF": _font_entry(default_font)},
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
		_error("RS_FIXTURE_VARIANT is not supported by the gate 4 MSDF fixture (got %s)" % JSON.stringify(OS.get_environment("RS_FIXTURE_VARIANT")))
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
