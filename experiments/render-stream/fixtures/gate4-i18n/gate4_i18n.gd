extends Node
## Gate 4 multilingual fixture (../../protocol/gate4-design.md "G4f" and "Q6e"): shaping with the
## pinned fallback fonts. Every Label uses one runtime FontFile `OS` (Open Sans SemiBold) whose
## fallbacks are `VZ` (Vazirmatn), `DV` (Noto Sans Devanagari UI) and `HE` (Noto Sans Hebrew), in
## that order, so the TextServer picks each run's font by the fallback chain
## (modules/text_server_adv/text_server_adv.cpp `_shape_run`, 6642-6960). Each fallback script
## first appears at its own step, so its pages appear only then (`fallback-pages`).
##
## The root is a plain `Node`. Every `CanvasItem` and every runtime `FontFile` is created in
## `_ready()`, after `GrcLoader` armed the capture extension in its own `_enter_tree()` (gate 0
## route (a)). Every font is fully configured (D3) and the fallbacks attached before any Label
## enters the tree; no font setter runs later. Construction order is expected.json
## `creation_order` (wire ids). make_expected.py models the same scene from its own copy of these
## strings; the two must agree.
##
## At startup the fixture checks, through the TextServer, that the font the fallback order picks
## for every codepoint (the first of OS, VZ, DV, HE with `font_has_char`) is the font COVERAGE
## names for that string, that OS maps U+1EBF (the composition HarfBuzz makes of the NFD
## Vietnamese e + U+0302 + U+0301), and that no pinned font maps U+2603; it exits 2 otherwise.
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
##   RS_FIXTURE_VARIANT     refused: this fixture has no variant

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
const EARLY_SHOT_STEPS: Array[int] = [1, 2, 3, 4, 5]
const FONT_SIZE: int = 16

## The four font files, in fallback order (OS first).
const FONT_FILES: Dictionary = {
	"OS": "res://fonts/OpenSans_SemiBold.woff2",
	"VZ": "res://fonts/Vazirmatn_Regular.woff2",
	"DV": "res://fonts/NotoSansDevanagariUI_Regular.woff2",
	"HE": "res://fonts/NotoSansHebrew_Regular.woff2",
}
const FALLBACK_ORDER: Array[String] = ["OS", "VZ", "DV", "HE"]
const CAPTURE_VARIABLES: Array[String] = ["GRC_EXTENSION", "GRC_MODE", "GRC_CALIBRATION", "GRC_EVIDENCE_DIR", "GRC_STREAM_OUT"]

## The strings (codepoints spelled out; expected.json carries the same, written by make_expected.py).
const GREEK: String = "\u039A\u03B1\u03BB\u03B7\u03BC\u03AD\u03C1\u03B1"  # Καλημέρα
const CYRILLIC: String = "\u041F\u0440\u0438\u0432\u0435\u0442"  # Привет
const VIETNAMESE_NFD: String = "Tie\u0302\u0301ng"  # Tiếng, the ế as e + U+0302 + U+0301 (NFD)
const ARABIC: String = "\u0645\u0631\u062D\u0628\u0627 \u0644\u0627"  # مرحبا لا
const PERSIAN: String = "\u0645\u06CC\u200C\u062E\u0648\u0627\u0647\u0645"  # می‌خواهم, with ZWNJ
const HEBREW: String = "\u05E9\u05B8\u05C1\u05DC\u05D5\u05B9\u05DD"  # שָׁלוֹם, with niqqud
const BIDI: String = "abc \u05D0\u05D1\u05D2 123"  # abc אבג 123
const DEVANAGARI_1: String = "\u0915\u094D\u0937\u0924\u094D\u0930\u093F\u092F"  # क्षत्रिय
const DEVANAGARI_2: String = "\u0915\u093F"  # कि
const SNOWMAN: String = "\u2603"  # ☃: no pinned font has it

## The font the fallback order must pick for each string's non-ASCII codepoints (ASCII: OS).
const COVERAGE: Dictionary = {
	GREEK: "OS", CYRILLIC: "OS", VIETNAMESE_NFD: "OS", ARABIC: "VZ", PERSIAN: "VZ", HEBREW: "HE",
	BIDI: "HE", DEVANAGARI_1: "DV", DEVANAGARI_2: "DV",
}
## Codepoints the coverage check skips: the NFD marks (HarfBuzz composes them to U+1EBF, which OS
## must map) and ZWNJ (default-ignorable: the TextServer draws it as a zero-width index 0 glyph).
const COVERAGE_EXEMPT: Array[int] = [0x0302, 0x0301, 0x200C]

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

## Font key -> FontFile, in fallback order.
var fonts: Dictionary = {}
var panel: ColorRect
var lg: Label
var lcy: Label
var lv: Label
var lar: Label
var lbi: Label
var lx: Label
var ld1: Label
var ld2: Label
var lhe: Label
var lfa: Label
var marker: RectNode
## Text nodes in tree order.
var text_nodes: Array[Label] = []

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

	# The runtime FontFiles, configured before anything uses them (D3), then OS's fallbacks.
	for key: String in FALLBACK_ORDER:
		var path: String = FONT_FILES[key]
		var font: FontFile = _font(path)
		if font == null:
			_failed = true
			get_tree().quit(2)
			return
		fonts[key] = font
	var os_font: FontFile = fonts["OS"]
	var fallbacks: Array[Font] = []
	for key: String in FALLBACK_ORDER.slice(1):
		var fallback: FontFile = fonts[key]
		fallbacks.append(fallback)
	os_font.fallbacks = fallbacks
	if not _check_coverage():
		_failed = true
		get_tree().quit(2)
		return

	# Construction order is the wire id order: a CanvasItem calls canvas_item_create in its
	# constructor.
	panel = ColorRect.new()
	panel.name = "P"
	panel.position = Vector2(400, 8)
	panel.size = Vector2(176, 240)
	panel.color = Color(1, 1, 0.8, 1)

	lg = _label("LG", Vector2(16, 16), Color(1, 1, 1, 1), GREEK)
	lcy = _label("LCy", Vector2(208, 16), Color(1, 0.8, 0.2, 1), CYRILLIC)
	lv = _label("LV", Vector2(16, 72), Color(0.8, 0.8, 1, 1), VIETNAMESE_NFD)
	lar = _label("LAr", Vector2(208, 72), Color(1, 1, 1, 1), "")
	lbi = _label("LBi", Vector2(16, 128), Color(1, 1, 1, 0.6), "")
	lx = _label("LX", Vector2(208, 128), Color(1, 0.6, 0.6, 1), "")
	ld1 = _label("LD1", Vector2(416, 24), Color(0, 0, 0.2, 1), "")
	ld2 = _label("LD2", Vector2(416, 72), Color(0.2, 0, 0, 1), "")
	lhe = _label("LHe", Vector2(416, 120), Color(0, 0, 0, 0.6), "")
	lfa = _label("LFa", Vector2(416, 168), Color(0, 0.2, 0, 1), "")
	marker = RectNode.new()
	marker.name = "Marker"
	marker.position = Vector2(592, 16)
	marker.rect = Rect2(0, 0, 32, 32)
	marker.color = MARKER_COLORS[0]

	text_nodes = [lg, lcy, lv, lar, lbi, lx, ld1, ld2, lhe, lfa]
	var children: Array[Node] = [panel, lg, lcy, lv, lar, lbi, lx, ld1, ld2, lhe, lfa, marker]
	for node: Node in children:
		add_child(node)

	if _env_log != "":
		_write_env()

	_log_step(0, 1, _start_frame + SETTLE_OFFSET)
	print("[fixture] gate4-i18n ready: S=%d N=%d quit=%d" % [_start_frame, _step_frames, _quit_frame])


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
			_oracle.record(settle_step, _frame, text_nodes, fonts)
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
			# Arabic: Vazirmatn's first glyphs, so its first page; lam-alef is one glyph.
			lar.text = ARABIC
		2:
			# Persian with ZWNJ: new Vazirmatn glyphs into its page.
			lfa.text = PERSIAN
		3:
			# Hebrew with niqqud: Noto Sans Hebrew's first page.
			lhe.text = HEBREW
		4:
			# Mixed bidi: new Latin and digit glyphs on OS's page, new letters on HE's.
			lbi.text = BIDI
		5:
			# Devanagari: two Labels in one frame, so DV's page is created by LD1's draw and
			# updated by LD2's (standalone ka is a new glyph; in LD1 it lives in the kssa conjunct).
			ld1.text = DEVANAGARI_1
			ld2.text = DEVANAGARI_2
		6:
			# Modulate only.
			lar.add_theme_color_override("font_color", Color(0.4, 1, 0.6, 1))
		7:
			# A codepoint no pinned font has: a hex box of add_rects, no texture command.
			lx.text = SNOWMAN
		8:
			# Transform only.
			lbi.position.x += 8
		9:
			# New placement across two scripts from glyphs already on OS's page.
			lcy.text = CYRILLIC + " " + GREEK
	marker.set_color(MARKER_COLORS[step])


## Each codepoint's font by the fallback order (the first font whose TextServer face maps it) is
## the one COVERAGE names (ASCII: OS); OS maps U+1EBF; no font maps U+2603.
func _check_coverage() -> bool:
	var ts: TextServer = TextServerManager.get_primary_interface()
	var ok: bool = true
	for text: String in COVERAGE:
		var want_script: String = COVERAGE[text]
		for i: int in range(text.length()):
			var cp: int = text.unicode_at(i)
			if cp in COVERAGE_EXEMPT:
				continue
			var want: String = "OS" if cp < 0x80 else want_script
			var got: String = _picked(ts, cp)
			if got != want:
				_error("U+%04X in %s: the fallback order picks %s, expected %s" % [cp, JSON.stringify(text), got, want])
				ok = false
	if _picked(ts, 0x1EBF) != "OS":
		_error("OS does not map U+1EBF (the NFD Vietnamese composition)")
		ok = false
	var snowman: String = _picked(ts, SNOWMAN.unicode_at(0))
	if snowman != "":
		_error("U+2603 is mapped by %s; the hex box needs a codepoint no pinned font has" % snowman)
		ok = false
	return ok


func _picked(ts: TextServer, cp: int) -> String:
	for key: String in FALLBACK_ORDER:
		var font: FontFile = fonts[key]
		if ts.font_has_char(font.get_rids()[0], cp):
			return key
	return ""


func _font(path: String) -> FontFile:
	var font := FontFile.new()
	var err: Error = font.load_dynamic_font(path)
	if err != OK:
		_error("load_dynamic_font(%s) failed: %d" % [path, err])
		return null
	font.antialiasing = TextServer.FONT_ANTIALIASING_GRAY
	font.hinting = TextServer.HINTING_LIGHT
	font.force_autohinter = false
	font.subpixel_positioning = TextServer.SUBPIXEL_POSITIONING_DISABLED
	font.multichannel_signed_distance_field = false
	font.allow_system_fallback = false
	font.generate_mipmaps = false
	font.disable_embedded_bitmaps = true
	font.oversampling = 0.0
	font.keep_rounding_remainders = true
	return font


func _label(node_name: String, at: Vector2, color: Color, text: String) -> Label:
	var node := Label.new()
	node.name = node_name
	node.position = at
	var os_font: FontFile = fonts["OS"]
	node.add_theme_font_override("font", os_font)
	node.add_theme_font_size_override("font_size", FONT_SIZE)
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
	var default_variant: Variant = lg.get_theme_default_font()
	var default_font: FontFile = default_variant
	var font_entries: Dictionary = {"DF": _font_entry(default_font)}
	var files: Dictionary = {}
	for key: String in FALLBACK_ORDER:
		var font: FontFile = fonts[key]
		font_entries[key] = _font_entry(font)
		var path: String = FONT_FILES[key]
		files[path.get_file()] = FileAccess.get_sha256(path)
	var order: Array[String] = []
	var os_font: FontFile = fonts["OS"]
	for fallback: Font in os_font.fallbacks:
		var fallback_file: FontFile = fallback
		for key: String in FALLBACK_ORDER:
			if fonts[key] == fallback_file:
				order.append(key)
	var data: Dictionary = {
		"schema": "render-stream-gate4-env/1",
		"text_server": TextServerManager.get_primary_interface().get_name(),
		"font_files": files,
		"fonts": font_entries,
		"fallback_order": order,
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
		_error("RS_FIXTURE_VARIANT is not supported by gate4-i18n (got %s)" % JSON.stringify(OS.get_environment("RS_FIXTURE_VARIANT")))
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
