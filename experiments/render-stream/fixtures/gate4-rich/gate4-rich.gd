extends Node
## Gate 4 RichTextLabel spans fixture (../../protocol/gate4-design.md "G4d", Q6e
## "fixtures/gate4-rich/"). The root is a plain `Node` (not a `CanvasItem`). Every `CanvasItem`
## and every runtime `Font` are created in `_ready()`, after `GrcLoader` armed the capture
## extension in its own `_enter_tree()` (gate 0 route (a)). Construction order is
## `expected.json` `creation_order` (wire ids 1, 2): `RTL`, then `Marker`.
##
## `RTL` is a `RichTextLabel` with `bbcode_enabled`, `fit_content` and `scroll_active = false`,
## clipping by default (RichTextLabel's constructor calls `set_clip_contents(true)` unconditionally,
## `scene/gui/rich_text_label.cpp:8077`). Its position (24,32) and size (400,190) are fixed and
## never change; `fit_content` only *grows* a free Control's actual size up to its minimum when
## the minimum exceeds the offset-derived size (`scene/gui/control.cpp:1742-1786`), so as long as
## the content's natural height never exceeds 190 px (checked empirically: six cumulative spans at
## up to three wrapped lines), `RTL`'s clip rect stays the fixed rectangle every step -- the
## contract's "gate 3's clip checks on the RichTextLabel's clip" needs exactly this to hand-predict
## the clip rectangle in `make_expected.py` without running the engine.
##
## Six steps cumulatively add one BBCode span each (Q6e): `[color]`, `[font_size=24]` (its own
## `F@24` cache), `[b]` (a `FontVariation` with `variation_embolden 1.2`, its own cache), `[i]` (a
## `FontVariation` with `variation_transform` skewed 0.2, its own cache), `[bgcolor]` (an
## `add_rect`), and `[outline_size=2][outline_color]` (its own bitmap-outline cache, alongside the
## ordinary fill glyphs on `F@16`). Step 5 is `append_text`, which appends a new paragraph without
## re-parsing the existing one. `RS_FIXTURE_VARIANT=underline` wraps the first span's word in
## `[u]...[/u]` (every step), which draws `canvas_item_add_line` inside `RTL`'s own region --
## typed `unsupported` on render-stream/3 (gate4-design.md Q2), a wide line the receiver replays
## since G5d (render-stream/4, gate5-design.md Q6g).
##
## Environment (all optional; an invalid value prints an error and quits 2):
##   RS_FIXTURE_STEP_LOG    absolute path: one JSONL line per step at its applied frame
##   RS_FIXTURE_SHOT_DIR    absolute dir: step-<k>.png at each settle frame (rendered runs only)
##   RS_FIXTURE_ENV_LOG     absolute path: env.json (TextServer, font hashes and properties, the
##                          pinned project settings, viewport oversampling, locale)
##   RS_FIXTURE_GLYPH_LOG   absolute path: the glyph oracle (glyph_oracle.gd), one JSONL line per
##                          settle frame, pages under <dir>/pages/. Reference legs only: refused
##                          (exit 2) when any GRC_* capture variable is set.
##   RS_FIXTURE_START_FRAME S >= 1, default 1
##   RS_FIXTURE_STEP_FRAMES N >= 8, default 10 (step k >= 1 at S+N*k, settled at S+N*k+7)
##   RS_FIXTURE_QUIT_FRAME  >= S+N*5+11 (the default)
##   RS_FIXTURE_VARIANT     "" (default) or "underline"; anything else is refused (exit 2)

const GlyphOracle := preload("res://glyph_oracle.gd")

## A `Node2D` drawing one axis-aligned rect (the step marker, as gates 1, 3 and 4a).
class RectNode extends Node2D:
	var rect: Rect2 = Rect2()
	var color: Color = Color.BLACK

	func _draw() -> void:
		draw_rect(rect, color)

	func set_color(new_color: Color) -> void:
		color = new_color
		queue_redraw()


const LAST_STEP: int = 5
const SETTLE_OFFSET: int = 7
const START_FRAME_DEFAULT: int = 1
const STEP_FRAMES_DEFAULT: int = 10
const QUIT_AFTER_LAST_SETTLE: int = 4  # quit default S + N*5 + 11 = last settle + 4

const FONT_FILE: String = "res://fonts/OpenSans_SemiBold.woff2"
## The capture variables whose presence refuses the oracle (it runs on reference legs only).
const CAPTURE_VARIABLES: Array[String] = ["GRC_EXTENSION", "GRC_MODE", "GRC_CALIBRATION", "GRC_EVIDENCE_DIR", "GRC_STREAM_OUT"]

## Gate 3/4's marker colours (fixtures/gate3/gate3.gd MARKER_COLORS), first six.
const MARKER_COLORS: Array[Color] = [
	Color(0, 0, 0, 1),
	Color(1, 1, 0, 1),
	Color(0, 1, 1, 1),
	Color(0.4, 0, 0.4, 1),
	Color(0, 0.4, 0, 1),
	Color(0.4, 0, 0, 1),
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

## BBCode fragments, cumulative through step k (0..4); step 5 is append_text, not a fragment here.
## "%s" in FRAG_0 is the first span's word, plain or `[u]`-wrapped (RS_FIXTURE_VARIANT=underline).
const FRAG_0: String = "[color=yellow]%s[/color] plain [font_size=24]Big[/font_size]"
const FRAG_1: String = " [b]Bold[/b]"
const FRAG_2: String = " [i]Italic[/i]"
const FRAG_3: String = " [bgcolor=cyan]Marked[/bgcolor]"
const FRAG_4: String = " [outline_size=2][outline_color=black]Outlined[/outline_color][/outline_size]"
const FRAG_5: String = "\n[color=magenta]More[/color]"

var font_f: FontFile
var font_fb: FontVariation
var font_fi: FontVariation
var rtl: RichTextLabel
var marker: RectNode
var font_keys: Dictionary = {}

var _frame: int = 0
var _start_frame: int = START_FRAME_DEFAULT
var _step_frames: int = STEP_FRAMES_DEFAULT
var _quit_frame: int = 0
var _shot_dir: String = ""
var _env_log: String = ""
var _step_log_file: FileAccess
var _oracle: GlyphOracle
var _variant: String = ""
var _failed: bool = false


func _ready() -> void:
	if not _read_environment():
		_failed = true
		get_tree().quit(2)
		return

	# The runtime FontFile, configured before anything uses it (D3), and its two FontVariations.
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

	font_fb = FontVariation.new()
	font_fb.base_font = font_f
	font_fb.variation_embolden = 1.2

	font_fi = FontVariation.new()
	font_fi.base_font = font_f
	font_fi.variation_transform = Transform2D(Vector2(1.0, 0.0), Vector2(0.2, 1.0), Vector2(0.0, 0.0))

	# Construction order is the wire id order: a CanvasItem calls canvas_item_create in its
	# constructor.
	rtl = RichTextLabel.new()
	rtl.name = "RTL"
	rtl.position = Vector2(24, 32)
	rtl.size = Vector2(400, 190)
	rtl.bbcode_enabled = true
	rtl.fit_content = true
	rtl.scroll_active = false
	rtl.add_theme_color_override("default_color", Color.WHITE)
	rtl.add_theme_font_override("normal_font", font_f)
	rtl.add_theme_font_size_override("normal_font_size", 16)
	rtl.add_theme_font_override("bold_font", font_fb)
	rtl.add_theme_font_size_override("bold_font_size", 16)
	rtl.add_theme_font_override("italics_font", font_fi)
	rtl.add_theme_font_size_override("italics_font_size", 16)
	rtl.add_theme_font_override("mono_font", font_f)
	rtl.add_theme_font_size_override("mono_font_size", 16)

	marker = RectNode.new()
	marker.name = "Marker"
	marker.position = Vector2(592, 16)
	marker.rect = Rect2(0, 0, 32, 32)
	marker.color = MARKER_COLORS[0]

	for node: Node in [rtl, marker]:
		add_child(node)

	font_keys = {"F": font_f, "FB": font_fb, "FI": font_fi}

	_set_text_through(0)
	marker.set_color(MARKER_COLORS[0])

	if _env_log != "":
		_write_env()

	# Step 0 is the `_ready` state, applied at the frame stamp of everything that runs during
	# `initialize()` (1), settled at S + 7.
	_log_step(0, 1, _start_frame + SETTLE_OFFSET)
	print("[fixture] gate4-rich ready: S=%d N=%d quit=%d variant=%s" % [_start_frame, _step_frames, _quit_frame, _variant])


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
			_oracle.record_rich(settle_step, _frame, _spans_upto(settle_step), font_keys)
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
	if step == LAST_STEP:
		# append_text: a new paragraph on the existing structure, not a re-parse (Q6e).
		rtl.append_text(FRAG_5)
	else:
		_set_text_through(step)
	marker.set_color(MARKER_COLORS[step])


## Rebuilds RTL's full BBCode text from FRAG_0..FRAG_<step> (steps 0..4; step 5 only appends).
func _set_text_through(step: int) -> void:
	var first_word: String = "Amber"
	if _variant == "underline":
		first_word = "[u]Amber[/u]"
	var text: String = FRAG_0 % first_word
	if step >= 1:
		text += FRAG_1
	if step >= 2:
		text += FRAG_2
	if step >= 3:
		text += FRAG_3
	if step >= 4:
		text += FRAG_4
	rtl.text = text


## The cumulative span list active at `step` (gate4-design.md Q6c: "the oracle reports glyph sets
## and counts per span, not quads"). Each entry names the Font resource and plain-text run a span
## shapes, independently of RichTextLabel's own BBCode parse -- this fixture builds both the
## BBCode string (_set_text_through/FRAG_*) and this list from the same literal words, so they
## cannot drift silently. `outline` > 0 asks the oracle to additionally look up the *outline*
## glyph cache `(size, outline)` instead of the fill cache `(size, 0)`.
func _spans_upto(step: int) -> Array[Dictionary]:
	var spans: Array[Dictionary] = []
	spans.append({"key": "color", "font": font_f, "font_key": "F", "size": 16, "text": "Amber", "colour": Color(1, 1, 0, 1), "bgcolor": null, "outline": 0})
	spans.append({"key": "plain", "font": font_f, "font_key": "F", "size": 16, "text": "plain", "colour": Color.WHITE, "bgcolor": null, "outline": 0})
	spans.append({"key": "font_size", "font": font_f, "font_key": "F", "size": 24, "text": "Big", "colour": Color.WHITE, "bgcolor": null, "outline": 0})
	if step >= 1:
		spans.append({"key": "bold", "font": font_fb, "font_key": "FB", "size": 16, "text": "Bold", "colour": Color.WHITE, "bgcolor": null, "outline": 0})
	if step >= 2:
		spans.append({"key": "italic", "font": font_fi, "font_key": "FI", "size": 16, "text": "Italic", "colour": Color.WHITE, "bgcolor": null, "outline": 0})
	if step >= 3:
		spans.append({"key": "bgcolor", "font": font_f, "font_key": "F", "size": 16, "text": "Marked", "colour": Color.WHITE, "bgcolor": Color.CYAN, "outline": 0})
	if step >= 4:
		spans.append({"key": "outline", "font": font_f, "font_key": "F", "size": 16, "text": "Outlined", "colour": Color.WHITE, "bgcolor": null, "outline": 2})
	if step >= 5:
		spans.append({"key": "append", "font": font_f, "font_key": "F", "size": 16, "text": "More", "colour": Color.MAGENTA, "bgcolor": null, "outline": 0})
	return spans


func _write_env() -> void:
	var settings: Dictionary = {}
	for key: String in PINNED_SETTINGS:
		settings[key] = ProjectSettings.get_setting(key)
	var font: FontFile = font_keys["F"]
	var fonts: Dictionary = {
		"F": {
			"antialiasing": int(font.antialiasing),
			"hinting": int(font.hinting),
			"force_autohinter": font.force_autohinter,
			"subpixel_positioning": int(font.subpixel_positioning),
			"multichannel_signed_distance_field": font.multichannel_signed_distance_field,
			"allow_system_fallback": font.allow_system_fallback,
			"generate_mipmaps": font.generate_mipmaps,
			"disable_embedded_bitmaps": font.disable_embedded_bitmaps,
			"oversampling": font.oversampling,
			"keep_rounding_remainders": font.keep_rounding_remainders,
			"fallbacks": font.fallbacks.size(),
			"font_name": font.get_font_name(),
			"font_style_name": font.get_font_style_name(),
		},
		"FB": {"variation_embolden": font_fb.variation_embolden},
		"FI": {"variation_transform": [font_fi.variation_transform.x.x, font_fi.variation_transform.x.y, font_fi.variation_transform.y.x, font_fi.variation_transform.y.y]},
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
		var variant: String = OS.get_environment("RS_FIXTURE_VARIANT")
		if variant != "underline":
			_error("RS_FIXTURE_VARIANT must be \"underline\" (got %s)" % JSON.stringify(variant))
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
