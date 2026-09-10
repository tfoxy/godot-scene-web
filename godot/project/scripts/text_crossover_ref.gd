extends SceneTree

# ARM (d) OF THE TEXT-FIDELITY CROSSOVER SWEEP: Godot's own rasteriser, drawing the exact grid the
# browser arms draw, so "our interior is mottled and the game's is not" can be settled by diffing two
# crops of the same rectangle instead of by looking at two screenshots.
#
# WHAT IT DRAWS. One frame per (face, variant). A frame is the background, then every cell of the
# grid — `draw_string_outline` then `draw_string` at the SAME pen, outline first and therefore
# underneath — then the calibration patch last so nothing can blend over it.
#
# IT DERIVES NOTHING. Every cell rectangle, pen position, colour, ppem and outline size arrives in
# the manifest, which `scripts/godot-text-crossover.ts` generates from
# `packages/perf-harness/probes/text-crossover-cases.ts`. A second copy of `cellRect` here would be
# free to drift half a pixel from the browser half, and half a pixel is the entire subject of the
# byte-diff metric. The only geometry this file invents is the full-canvas background rect and the
# black band under the calibration swatches.
#
# WHY NOT A `Label`. Same reason `outline_ref.gd` states: a Label brings VERTICAL_ALIGNMENT, its own
# ascent padding, a stylebox offset and a pivot — four conventions between a caller's coordinate and
# a glyph's pen. `draw_string` takes the pen directly and there is nothing to reproduce.
#
# WHY THE FONT IS BUILT IN CODE. A `.tres` or an `.import` carries the editor's import defaults, and
# the axis under test here IS an import setting (`multichannel_signed_distance_field`). Every
# rasterisation switch is set here from the manifest and every one is read BACK off the `FontFile`
# into the report, so the report records what Godot did rather than what it was asked to do. The two
# faces differ in exactly one bit — MSDF on and MSDF off — which is what makes the pair a control.
#
# OVERSAMPLING IS PINNED TO 1 IN TWO PLACES. `set_oversampling_override(1.0)` on the root, and the
# `oversampling` argument of every draw call. Godot 4.5 scales a font size by the viewport's
# oversampling before rasterising, so without the pin `font_size` would be a DESIGN size and the
# device ppem the sweep is indexed by would be a different number.
#
# THE BACKGROUND IS A DRAWN RECT, NOT ONLY THE CLEAR COLOUR. Both are set to the manifest's colour,
# but the visible background has to be a 2D draw in the same pipeline as the ink: the product variant
# is a light fill over a black outline over a dark card, and the whole question is what byte an
# interior pixel holds. A clear colour that took a different path to the framebuffer than the glyphs
# would put an unshared transfer step under half the comparison. The driver reads the background byte
# back out of the PNG and asserts it.
#
# THE CALIBRATION PATCH IS NOT DECORATION, and it sits on its own BLACK band in every variant. Three
# white rects at alpha 0.25/0.5/0.75 on black must decode to 64/128/191. If this frame went through a
# linear->sRGB conversion they would read ~137/188/224 instead, every byte in the sweep would be
# wrong by a transfer curve, and nothing else in the pipeline would notice. The band is black even in
# `product`, whose background is not, because `round(255 * alpha)` is only the answer over black.
#
# Usage (NOT headless — `--headless` renders nothing and the capture would be blank):
#   xvfb-run -a godot --path godot/project --script res://scripts/text_crossover_ref.gd \
#     -- --manifest /abs/path.json
#
# `scripts/godot-text-crossover.ts` is the only intended caller.

# The painter. An inner class because `_draw` has to be on the CanvasItem itself, and a Control is
# the cheapest CanvasItem that fills the viewport without a transform of its own.
class CrossoverPainter extends Control:
	var cells: Array = []
	var fonts: Dictionary = {}
	var background: Color = Color(0, 0, 0, 1)
	var swatches: Array = []
	var calibration_top: int = 0
	var calibration_height: int = 40
	var canvas_width: int = 0
	var canvas_height: int = 0

	func _draw() -> void:
		var item := get_canvas_item()
		# The card. See the header: the background the ink blends against is a 2D draw.
		draw_rect(Rect2(0, 0, float(canvas_width), float(canvas_height)), background, true)

		for cell_variant in cells:
			var cell: Dictionary = cell_variant
			var font: FontFile = fonts[str(cell.get("fontKey", ""))]
			var font_size := int(cell.get("pixelsPerEm", 16))
			var outline_size := int(cell.get("outlineSize", 0))
			var text := str(cell.get("text", ""))
			# The pen, in VIEWPORT coordinates, straight out of the manifest. Nothing added.
			var pen := Vector2(float(cell.get("penX", 0)), float(cell.get("penY", 0)))
			var outline_color := _rgb(cell.get("outline", [255, 255, 255]))
			var fill_color := _rgb(cell.get("fill", [255, 255, 255]))
			var draw_outline := bool(cell.get("drawOutline", false)) and outline_size > 0
			var draw_fill := bool(cell.get("drawFill", true))
			# OUTLINE FIRST, THEN FILL, at the same pen. `oversampling` 1.0 on both — see the header.
			if draw_outline:
				font.draw_string_outline(
					item,
					pen,
					text,
					HORIZONTAL_ALIGNMENT_LEFT,
					-1.0,
					font_size,
					outline_size,
					outline_color,
					TextServer.JUSTIFICATION_KASHIDA | TextServer.JUSTIFICATION_WORD_BOUND,
					TextServer.DIRECTION_AUTO,
					TextServer.ORIENTATION_HORIZONTAL,
					1.0
				)
			if draw_fill:
				font.draw_string(
					item,
					pen,
					text,
					HORIZONTAL_ALIGNMENT_LEFT,
					-1.0,
					font_size,
					fill_color,
					TextServer.JUSTIFICATION_KASHIDA | TextServer.JUSTIFICATION_WORD_BOUND,
					TextServer.DIRECTION_AUTO,
					TextServer.ORIENTATION_HORIZONTAL,
					1.0
				)

		# The calibration band, drawn LAST so nothing can blend over it: an opaque black plate, then
		# the alpha swatches on top of it. Black in every variant — see the header.
		draw_rect(
			Rect2(0.0, float(calibration_top), float(canvas_width), float(calibration_height)),
			Color(0, 0, 0, 1),
			true
		)
		for swatch_variant in swatches:
			var swatch: Dictionary = swatch_variant
			draw_rect(
				Rect2(
					float(swatch.get("x", 0)),
					float(calibration_top),
					float(swatch.get("width", 0)),
					float(calibration_height)
				),
				Color(1, 1, 1, float(swatch.get("alpha", 1.0))),
				true
			)

	# A manifest `[r, g, b]` in 0..255 as an opaque Color. `Color8` divides by 255 and applies no
	# transfer curve, which is the whole point: the byte asked for is the byte drawn.
	func _rgb(value: Variant) -> Color:
		var rgb: Array = value if value is Array else [255, 255, 255]
		if rgb.size() < 3:
			return Color(1, 1, 1, 1)
		return Color8(int(rgb[0]), int(rgb[1]), int(rgb[2]), 255)


func _initialize() -> void:
	var manifest_path := ""
	var args := OS.get_cmdline_user_args()
	for i in range(args.size()):
		if args[i] == "--manifest" and i + 1 < args.size():
			manifest_path = args[i + 1]
	if manifest_path == "":
		push_error("Usage: godot --path godot/project --script res://scripts/text_crossover_ref.gd -- --manifest manifest.json")
		quit(2)
		return
	var manifest_file := FileAccess.open(manifest_path, FileAccess.READ)
	if manifest_file == null:
		push_error("Could not open manifest: " + manifest_path)
		quit(2)
		return
	var parsed: Variant = JSON.parse_string(manifest_file.get_as_text())
	manifest_file.close()
	if not parsed is Dictionary:
		push_error("Manifest must be a JSON object: " + manifest_path)
		quit(2)
		return
	var exit_code := await _run(parsed as Dictionary)
	quit(exit_code)


func _run(manifest: Dictionary) -> int:
	var viewport_width := int(manifest.get("viewportWidth", 1280))
	var viewport_height := int(manifest.get("viewportHeight", 1160))
	var faces: Array = manifest.get("faces", [])
	var frames: Array = manifest.get("frames", [])
	var calibration: Dictionary = manifest.get("calibration", {})
	var swatches: Array = calibration.get("swatches", [])
	var calibration_top := int(calibration.get("top", viewport_height - 40))
	var calibration_height := int(calibration.get("height", 40))
	var output_path := str(manifest.get("output", ""))
	var warmup_frames := int(manifest.get("warmupFrames", 12))

	if faces.is_empty() or frames.is_empty():
		push_error("Manifest needs faces and frames.")
		return 2

	var viewport_size := Vector2i(viewport_width, viewport_height)
	DisplayServer.window_set_size(viewport_size)
	get_root().size = viewport_size
	DisplayServer.window_set_vsync_mode(DisplayServer.VSYNC_DISABLED)
	Engine.max_fps = 0
	get_root().transparent_bg = false
	# THE PIN. See the header: without it `font_size` is a design size, not device ppem.
	get_root().set_oversampling_override(1.0)

	# ONE FontFile PER SETTINGS BUNDLE, keyed by the manifest's own name for it. Two bundles that
	# differ only in `multichannel_signed_distance_field` need two faces: MSDF decides how the glyph
	# is CACHED, and flipping it after a glyph is cached would silently rasterise both at one setting.
	var fonts := {}
	var face_report := []
	for face_variant in faces:
		var face: Dictionary = face_variant
		var key := str(face.get("key", ""))
		var path := str(face.get("path", ""))
		var font := FontFile.new()
		font.load_dynamic_font(path)
		# `load_dynamic_font` returns OK even when the file does not exist — it hands `set_data` an
		# empty vector and says nothing. The byte count is the only honest check.
		var data_bytes := font.get_data().size()
		if data_bytes == 0:
			push_error("Font loaded 0 bytes: " + path)
			return 3

		# EVERY RASTERISATION SWITCH, STATED. `msdf` is the axis under test; the rest are held
		# byte-identical between the two faces so that the pair is a control and not a comparison of
		# two unrelated bundles.
		font.hinting = int(face.get("hinting", TextServer.HINTING_LIGHT))
		font.subpixel_positioning = int(face.get("subpixelPositioning", TextServer.SUBPIXEL_POSITIONING_AUTO))
		font.antialiasing = int(face.get("antialiasing", TextServer.FONT_ANTIALIASING_GRAY))
		font.force_autohinter = bool(face.get("forceAutohinter", false))
		font.allow_system_fallback = bool(face.get("allowSystemFallback", true))
		font.disable_embedded_bitmaps = bool(face.get("disableEmbeddedBitmaps", true))
		font.generate_mipmaps = bool(face.get("generateMipmaps", false))
		font.modulate_color_glyphs = bool(face.get("modulateColorGlyphs", false))
		# Size and range BEFORE the flag, so the first cached glyph is built at the requested range
		# rather than at the default 8 and re-derived afterwards.
		font.msdf_pixel_range = int(face.get("msdfPixelRange", 8))
		font.msdf_size = int(face.get("msdfSize", 48))
		font.multichannel_signed_distance_field = bool(face.get("msdf", false))
		font.fixed_size = int(face.get("fixedSize", 0))
		# 0.0 means "follow the viewport", which is pinned to 1 above. The product's own import says
		# 0.0, so this face says 0.0.
		font.oversampling = float(face.get("oversampling", 0.0))
		if _has_property(font, "keep_rounding_remainders"):
			font.set("keep_rounding_remainders", bool(face.get("keepRoundingRemainders", true)))
		fonts[key] = font

		# READ BACK, not echoed. An enum Godot declined to accept — or clamped, or renumbered — would
		# otherwise be recorded as the value that was requested and the report would document a
		# fiction. `msdf` is the whole axis, so this is where the run proves Godot took it.
		var entry := {
			"key": key,
			"path": path,
			"dataBytes": data_bytes,
			"faceCount": font.get_face_count(),
			"fontName": font.get_font_name(),
			"styleName": font.get_font_style_name(),
			"hinting": font.hinting,
			"subpixelPositioning": font.subpixel_positioning,
			"antialiasing": font.antialiasing,
			"forceAutohinter": font.force_autohinter,
			"allowSystemFallback": font.allow_system_fallback,
			"disableEmbeddedBitmaps": font.disable_embedded_bitmaps,
			"msdf": font.multichannel_signed_distance_field,
			"msdfPixelRange": font.msdf_pixel_range,
			"msdfSize": font.msdf_size,
			"generateMipmaps": font.generate_mipmaps,
			"modulateColorGlyphs": font.modulate_color_glyphs,
			"fixedSize": font.fixed_size,
			"oversampling": font.oversampling,
		}
		if _has_property(font, "keep_rounding_remainders"):
			entry["keepRoundingRemainders"] = font.get("keep_rounding_remainders")
		else:
			entry["keepRoundingRemainders"] = null
		face_report.append(entry)

	var painter := CrossoverPainter.new()
	painter.name = "TextCrossoverRef"
	painter.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	painter.fonts = fonts
	painter.swatches = swatches
	painter.calibration_top = calibration_top
	painter.calibration_height = calibration_height
	painter.canvas_width = viewport_width
	painter.canvas_height = viewport_height
	get_root().add_child(painter)

	var frame_report := []
	var first_error := OK
	for frame_variant in frames:
		var frame: Dictionary = frame_variant
		var clear: Array = frame.get("clearColor", [0, 0, 0])
		var clear_color := Color8(int(clear[0]), int(clear[1]), int(clear[2]), 255)
		RenderingServer.set_default_clear_color(clear_color)
		painter.background = clear_color
		painter.cells = frame.get("cells", [])
		painter.queue_redraw()

		# Warm up so the capture never catches a frame drawn while FreeType (or msdfgen) was still
		# filling the glyph atlas. Every frame changes font_size on 28 cells, so the atlas work is
		# real; several frames cost nothing and remove the question.
		for _frame in range(warmup_frames):
			await process_frame

		var screenshot_path := str(frame.get("screenshot", ""))
		var capture_error := _capture(screenshot_path, viewport_width, viewport_height)
		if capture_error != OK and first_error == OK:
			first_error = capture_error
		frame_report.append({
			"face": str(frame.get("face", "")),
			"variant": str(frame.get("variant", "")),
			"screenshot": screenshot_path,
			"clearColor": clear,
			"cells": painter.cells.size(),
			"captureError": capture_error,
		})
		print("captured %s (%d cells) -> %s" % [
			str(frame.get("face", "")) + "-" + str(frame.get("variant", "")),
			painter.cells.size(),
			screenshot_path,
		])

	var version := Engine.get_version_info()
	var report := {
		"schema": "godot-text-crossover-ref/1",
		"godot": str(version.get("string", "")),
		"godotMajor": int(version.get("major", 0)),
		"godotMinor": int(version.get("minor", 0)),
		"godotPatch": int(version.get("patch", 0)),
		"renderer": str(ProjectSettings.get_setting("rendering/renderer/rendering_method", "")),
		"adapter": RenderingServer.get_video_adapter_name(),
		"adapterApi": RenderingServer.get_video_adapter_api_version(),
		"viewport": {"width": viewport_width, "height": viewport_height},
		# BOTH oversampling numbers: the override that was set and what the viewport reports using.
		# They must agree, and a reader should not have to take that on trust.
		"oversamplingOverride": get_root().get_oversampling_override(),
		"oversampling": get_root().get_oversampling(),
		# The two project settings that could move a whole glyph off its pen without touching a rim.
		"snap2dTransforms": bool(ProjectSettings.get_setting("rendering/2d/snap/snap_2d_transforms_to_pixel", false)),
		"snap2dVertices": bool(ProjectSettings.get_setting("rendering/2d/snap/snap_2d_vertices_to_pixel", false)),
		"faces": face_report,
		"frames": frame_report,
		"calibration": calibration,
		"warmupFrames": warmup_frames,
	}

	if output_path != "":
		var out := FileAccess.open(output_path, FileAccess.WRITE)
		if out == null:
			push_error("Could not open output: " + output_path)
			return 4
		out.store_string(JSON.stringify(report, "\t"))
		out.close()
	else:
		print(JSON.stringify(report))

	get_root().remove_child(painter)
	painter.queue_free()
	await process_frame
	if first_error != OK:
		push_error("At least one capture could not be written")
		return 5
	return 0


# Does this build expose the property at all? 4.5.1 does; asking keeps the report honest on a build
# that does not instead of erroring out on a name.
func _has_property(object: Object, property: String) -> bool:
	for info in object.get_property_list():
		if str(info.get("name", "")) == property:
			return true
	return false


# `outline_ref.gd`'s capture, and the same one deliberately: the viewport's own texture read back as
# an Image, cropped if the window manager gave a larger surface than asked for.
func _capture(path: String, viewport_width: int, viewport_height: int) -> Error:
	if path == "":
		return OK
	var image := get_root().get_texture().get_image()
	if image.get_width() != viewport_width or image.get_height() != viewport_height:
		if image.get_width() < viewport_width or image.get_height() < viewport_height:
			push_error("Capture is %dx%d, smaller than the requested %dx%d — the X screen is too small for this window" % [
				image.get_width(), image.get_height(), viewport_width, viewport_height,
			])
			return ERR_INVALID_DATA
		image = image.get_region(Rect2i(0, 0, viewport_width, viewport_height))
	return image.save_png(path)
