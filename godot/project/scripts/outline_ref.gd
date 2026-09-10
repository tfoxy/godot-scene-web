extends SceneTree

# ONE FRAME OF GODOT'S OWN OUTLINE RASTERISER, so a claim about how sharp hb-gpu's outline is can be
# graded against the engine the consumer is mirroring instead of against an opinion.
#
# WHAT IT DRAWS: a row of well-separated cells, one glyph each, `draw_char_outline` then `draw_char`
# at the same pen. Both calls are OPAQUE WHITE. The outline call alone leaves a stroked RING (Godot
# strokes both borders), so the fill is what closes it into the dilated silhouette that
# `HbGpuRenderer.setSpread` produces on the other side — the two arms then differ in the rasteriser
# and in nothing else. A translucent fill would leave "is the middle solid" tangled up with "is the
# rim sharp", which are the two questions this fixture exists to keep apart.
#
# WHY NOT A `Label`. A Label brings VERTICAL_ALIGNMENT, its own ascent padding, a stylebox offset
# and a pivot — four conventions between a caller's coordinate and a glyph's pen, and
# `bench_text.gd:_baseline_correction` exists because getting them wrong put every glyph 4.2 px out
# with no vertical cause. `draw_char` takes the pen directly. There is nothing to reproduce.
#
# WHY THE FONT IS BUILT IN CODE. A `.tres` or an `.import` carries the editor's import defaults, and
# the whole value of this fixture is that every rasterisation switch is stated: hinting,
# subpixel positioning, antialiasing, autohinter, system fallback, embedded bitmaps, MSDF, mipmaps.
# All of them are set here and all of them are read BACK off the FontFile into the report, so the
# golden records what Godot did rather than what it was asked to do.
#
# OVERSAMPLING IS PINNED TO 1 IN TWO PLACES. `set_oversampling_override(1.0)` on the root, and the
# `oversampling` argument of every draw call. Godot 4.5 scales a font size by the viewport's
# oversampling before rasterising, so without the pin `font_size` would be a DESIGN size and the
# device ppem the golden is indexed by would be a different number.
#
# THE CALIBRATION PATCH IS NOT DECORATION. Three white rects at alpha 0.25/0.5/0.75 on black must
# decode to 64/128/191. If this frame went through a linear->sRGB conversion on the way to the PNG
# they would read ~137/188/224 instead, every coverage number in the golden would be wrong by a
# transfer curve, and nothing else in the pipeline would notice.
#
# Usage (NOT headless — `--headless` renders nothing and the capture would be blank):
#   xvfb-run -a godot --path godot/project --script res://scripts/outline_ref.gd -- --manifest /abs/path.json
#
# `scripts/godot-outline-ref.ts` is the only intended caller and writes the manifest from
# `GODOT_OUTLINE_CASES`. Nothing here re-derives a case: a second copy of the pen positions in
# GDScript would be a second copy free to drift from the one the browser half draws.

# The painter. An inner class because `_draw` has to be on the CanvasItem itself, and a Control is
# the cheapest CanvasItem that fills the viewport without a transform of its own.
class OutlinePainter extends Control:
	var cells: Array = []
	var fonts: Dictionary = {}
	var patch: Array = []
	var patch_rect_height: int = 40
	var patch_top: int = 160

	func _draw() -> void:
		var item := get_canvas_item()
		for cell_variant in cells:
			var cell: Dictionary = cell_variant
			var font: FontFile = fonts[str(cell.get("fontKey", ""))]
			var font_size := int(cell.get("pixelsPerEm", 12))
			var outline_size := int(cell.get("outlineSize", 0))
			# The pen, in VIEWPORT coordinates: the cell's top-left plus the case's own origin.
			var pen := Vector2(
				float(cell.get("cellX", 0)) + float(cell.get("originX", 0)),
				float(cell.get("cellY", 0)) + float(cell.get("originY", 0))
			)
			var code := int(cell.get("codepoint", 0))
			var white := Color(1, 1, 1, 1)
			# OUTLINE FIRST, THEN FILL, both opaque. See the header on why the fill is here at all.
			if outline_size > 0:
				font.draw_char_outline(item, pen, code, font_size, outline_size, white, 1.0)
			font.draw_char(item, pen, code, font_size, white, 1.0)

		# The calibration patch, drawn last so nothing can be blended over it.
		for i in range(patch.size()):
			var entry: Dictionary = patch[i]
			draw_rect(
				Rect2(
					float(entry.get("x", 0)),
					float(patch_top),
					float(entry.get("width", 0)),
					float(patch_rect_height)
				),
				Color(1, 1, 1, float(entry.get("alpha", 1.0))),
				true
			)

func _initialize() -> void:
	var manifest_path := ""
	var args := OS.get_cmdline_user_args()
	for i in range(args.size()):
		if args[i] == "--manifest" and i + 1 < args.size():
			manifest_path = args[i + 1]
	if manifest_path == "":
		push_error("Usage: godot --path godot/project --script res://scripts/outline_ref.gd -- --manifest manifest.json")
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
	var viewport_width := int(manifest.get("viewportWidth", 768))
	var viewport_height := int(manifest.get("viewportHeight", 224))
	var font_path := str(manifest.get("fontPath", ""))
	var cells: Array = manifest.get("cells", [])
	var faces: Array = manifest.get("faces", [])
	var patch: Array = manifest.get("calibrationPatch", [])
	var screenshot_path := str(manifest.get("screenshot", ""))
	var output_path := str(manifest.get("output", ""))
	var warmup_frames := int(manifest.get("warmupFrames", 8))

	if font_path == "" or cells.is_empty() or faces.is_empty():
		push_error("Manifest needs fontPath, faces and cells.")
		return 2

	var viewport_size := Vector2i(viewport_width, viewport_height)
	DisplayServer.window_set_size(viewport_size)
	get_root().size = viewport_size
	DisplayServer.window_set_vsync_mode(DisplayServer.VSYNC_DISABLED)
	Engine.max_fps = 0
	# BLACK, OPAQUE. White ink on black means the decoded byte IS the coverage, with no background
	# to subtract and no median to estimate — and it is the polarity in which a contrast curve keyed
	# on the foreground (which is what hb-gpu ships) has nothing to hide behind.
	get_root().transparent_bg = false
	RenderingServer.set_default_clear_color(Color(0, 0, 0, 1))
	# THE PIN. See the header: without it `font_size` is a design size, not device ppem.
	get_root().set_oversampling_override(1.0)

	# ONE FontFile PER REQUESTED SETTINGS BUNDLE, keyed by the manifest's own name for it. Two
	# bundles differing only in `hinting` need two faces, because hinting is a property of the face
	# and setting it after a glyph is cached would silently rasterise the two at one setting.
	var fonts := {}
	var face_report := []
	for face_variant in faces:
		var face: Dictionary = face_variant
		var key := str(face.get("key", ""))
		var font := FontFile.new()
		var load_error := font.load_dynamic_font(str(face.get("path", font_path)))
		if load_error != OK:
			push_error("Could not load font: " + str(face.get("path", font_path)))
			return 3
		font.hinting = int(face.get("hinting", TextServer.HINTING_NONE))
		font.subpixel_positioning = int(face.get("subpixelPositioning", TextServer.SUBPIXEL_POSITIONING_DISABLED))
		font.antialiasing = int(face.get("antialiasing", TextServer.FONT_ANTIALIASING_GRAY))
		font.force_autohinter = bool(face.get("forceAutohinter", false))
		font.allow_system_fallback = bool(face.get("allowSystemFallback", false))
		font.disable_embedded_bitmaps = bool(face.get("disableEmbeddedBitmaps", true))
		font.multichannel_signed_distance_field = false
		font.generate_mipmaps = false
		fonts[key] = font
		# READ BACK, not echoed. An enum Godot declined to accept — or renumbered — would otherwise
		# be recorded as the value that was requested and the golden would document a fiction.
		face_report.append({
			"key": key,
			"path": str(face.get("path", font_path)),
			"hinting": font.hinting,
			"subpixelPositioning": font.subpixel_positioning,
			"antialiasing": font.antialiasing,
			"forceAutohinter": font.force_autohinter,
			"allowSystemFallback": font.allow_system_fallback,
			"disableEmbeddedBitmaps": font.disable_embedded_bitmaps,
			"msdf": font.multichannel_signed_distance_field,
			"generateMipmaps": font.generate_mipmaps,
			"fixedSize": font.fixed_size,
			"faceCount": font.get_face_count(),
		})

	var painter := OutlinePainter.new()
	painter.name = "OutlineRef"
	painter.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	painter.cells = cells
	painter.fonts = fonts
	painter.patch = patch
	painter.patch_top = int(manifest.get("calibrationTop", 160))
	painter.patch_rect_height = int(manifest.get("calibrationHeight", 40))
	get_root().add_child(painter)

	# Warm up so the capture never catches a frame drawn while FreeType was still filling the glyph
	# atlas. One frame is enough in practice; several cost nothing and remove the question.
	for _frame in range(warmup_frames):
		await process_frame

	var capture_error := _capture(screenshot_path, viewport_width, viewport_height)

	var version := Engine.get_version_info()
	var report := {
		"schema": "godot-outline-ref/1",
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
		"cells": cells,
		"calibrationPatch": patch,
		"calibrationTop": painter.patch_top,
		"calibrationHeight": painter.patch_rect_height,
		"screenshot": screenshot_path,
		"screenshotError": capture_error,
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
	if capture_error != OK:
		push_error("Could not write capture: " + screenshot_path)
		return 5
	return 0

# `bench_text.gd`'s capture, and the same one deliberately: the viewport's own texture read back as
# an Image, cropped if the window manager gave a larger surface than asked for.
func _capture(path: String, viewport_width: int, viewport_height: int) -> Error:
	if path == "":
		return OK
	var image := get_root().get_texture().get_image()
	if image.get_width() != viewport_width or image.get_height() != viewport_height:
		image = image.get_region(Rect2i(0, 0, viewport_width, viewport_height))
	return image.save_png(path)
