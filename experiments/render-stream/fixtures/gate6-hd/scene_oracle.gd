extends RefCounted
## The gate 6 scene oracle (../../protocol/gate6-design.md "Q6f", `render-stream-gate6-oracle/1`).
##
## Runs on reference legs only (gate6_scene.gd refuses it when a GRC_* capture variable is set). At
## each settle frame, at that frame's `frame_post_draw` (after its redraws rasterized their
## glyphs), it writes one JSON line read back from the rendered reference's own engine state:
##   - `oversampling`: the viewport's `get_oversampling()`;
##   - `pages`: every atlas page of every cache of every font the scene draws with (the theme's
##     default font, RichTextLabel's bold font and, in `refused`, the LCD copy), through
##     `font_get_size_cache_info` (memory rs-g4c-layout-facts: it also lists draw-time caches) and
##     `font_get_texture_image` (no side effects), as the `render-stream-texture/1` SHA-256 of the
##     live CPU image. Its own GRT1 encoder, deliberately not shared with the capture;
##   - `scroll`: `SC`'s `scroll_vertical` and its content Control's position;
##   - `canvas_layers`: the HUD's `(layer, sublayer, visible)` (sublayer = the layer node's index,
##     which `CanvasLayer::update_draw_order` passes, cl.cpp:203-207);
##   - `materials`: `SM`'s shader (GRP1 SHA-256 of `shader_get_code`) and the Variant type and value
##     of `material_get_param` for `phase` and `tint` (G55c's view), and `CM`'s blend mode;
##   - `pb_value`: `PB.value`;
##   - `rich_text`: RT's line offsets (`get_line_offset`), content height and scroll value (the
##     model's measured line height and its scroll rule are checked against these);
##   - `line_edit`: the selection and caret rects LineEdit's NOTIFICATION_DRAW computes
##     (le.cpp:1325-1530), re-derived from the TextServer's own shaping of LE's text with LE's
##     font: `shaped_text_get_selection` at (x_ofs, y_ofs) and both `shaped_text_get_carets`
##     rects one caret width wide. The capture's LE commands must carry exactly these.

const GRP1_MAGIC: Array[int] = [0x47, 0x52, 0x50, 0x31, 0x0D, 0x0A, 0x1A, 0x0A]
## Image.Format identifiers without FORMAT_, in enum order (core/io/image.h:75-114).
const FORMAT_NAMES: Array[String] = [
	"L8", "LA8", "R8", "RG8", "RGB8", "RGBA8", "RGBA4444", "RGB565", "RF", "RGF", "RGBF", "RGBAF",
	"RH", "RGH", "RGBH", "RGBAH", "RGBE9995", "DXT1", "DXT3", "DXT5", "RGTC_R", "RGTC_RG",
	"BPTC_RGBA", "BPTC_RGBF", "BPTC_RGBFU", "ETC", "ETC2_R11", "ETC2_R11S", "ETC2_RG11",
	"ETC2_RG11S", "ETC2_RGB8", "ETC2_RGBA8", "ETC2_RGB8A1", "ETC2_RA_AS_RG", "DXT5_RA_AS_RG",
	"ASTC_4x4", "ASTC_4x4_HDR", "ASTC_8x8", "ASTC_8x8_HDR",
]

var _file: FileAccess


func open(path: String) -> bool:
	_file = FileAccess.open(path, FileAccess.WRITE)
	return _file != null


## One line for the settle frame of `step`. `inst` is the scene_builder.gd instance.
func record(step: int, frame: int, inst: RefCounted, viewport: Viewport) -> void:
	var sc: ScrollContainer = inst.get("sc")
	var vbox: Control = inst.get("vbox")
	var hud: CanvasLayer = inst.get("hud")
	var pb: ProgressBar = inst.get("pb")
	var rt: RichTextLabel = inst.get("rt")
	var sm_material: ShaderMaterial = inst.get("sm_material")
	var cm_material: CanvasItemMaterial = inst.get("cm_material")
	var lcd: FontFile = inst.get("rf_lcd_font")
	var le: LineEdit = inst.get("le")

	var fonts: Array[Dictionary] = [
		{"key": "default", "font": ThemeDB.fallback_font},
		{"key": "bold", "font": rt.get_theme_font("bold_font")},
	]
	if lcd != null:
		fonts.append({"key": "lcd", "font": lcd})

	var shader: Shader = sm_material.shader
	var code: String = RenderingServer.shader_get_code(shader.get_rid())
	var params: Array = []
	for name: String in ["phase", "tint"]:
		var view: Dictionary = variant_view(RenderingServer.material_get_param(sm_material.get_rid(), name))
		view["name"] = name
		params.append(view)

	var line: Dictionary = {
		"schema": "render-stream-gate6-oracle/1",
		"step": step,
		"frame": frame,
		"oversampling": viewport.get_oversampling(),
		"scroll": {
			"v_scroll": sc.scroll_vertical,
			"content_position": [vbox.position.x, vbox.position.y],
		},
		"canvas_layers": [{
			"name": "HUD",
			"layer": hud.layer,
			"sublayer": hud.get_index(),
			"visible": hud.visible,
		}],
		"materials": {
			"SM": {"shader_sha256": _sha256(grp1(code)), "params": params},
			"CM": {"blend_mode": int(cm_material.blend_mode)},
		},
		"pb_value": pb.value,
		"rich_text": _rich_text(rt),
		"line_edit": _line_edit(le),
		"pages": _pages(fonts),
	}
	_file.store_line(JSON.stringify(line, "", false, true))
	_file.flush()


func _rich_text(rt: RichTextLabel) -> Dictionary:
	var offsets: Array = []
	for i: int in range(rt.get_line_count()):
		offsets.append(rt.get_line_offset(i))
	var bar: VScrollBar = rt.get_v_scroll_bar()
	return {"line_offsets": offsets, "content_height": rt.get_content_height(), "v_scroll": bar.value}


## le.cpp:1325-1530 for a left-aligned, LTR, unscrolled, editable LineEdit with no icon.
func _line_edit(le: LineEdit) -> Dictionary:
	var ts: TextServer = TextServerManager.get_primary_interface()
	var font: Font = le.get_theme_font("font")
	var font_size: int = le.get_theme_font_size("font_size")
	var shaped: RID = ts.create_shaped_text()
	ts.shaped_text_add_string(shaped, le.text, font.get_rids(), font_size, font.get_opentype_features(), "")
	var size: Vector2 = ts.shaped_text_get_size(shaped)
	var text_height: float = size.y
	var style: StyleBox = le.get_theme_stylebox("normal")
	var x_ofs: int = int(style.get_margin(SIDE_LEFT))
	var y_area: int = int(le.size.y - style.get_minimum_size().y)
	var y_offset: float = style.get_offset().y + (float(y_area) - text_height) / 2.0
	var y_ofs: int = int(y_offset)
	var ofs_max: int = int(le.size.x - style.get_margin(SIDE_RIGHT))
	var selection: Array = []
	if le.has_selection():
		var spans: PackedVector2Array = ts.shaped_text_get_selection(shaped, le.get_selection_from_column(), le.get_selection_to_column())
		for span: Vector2 in spans:
			var rect: Rect2 = Rect2(span.x + x_ofs, y_ofs, span.y - span.x, text_height)
			if rect.position.x + rect.size.x <= x_ofs or rect.position.x > ofs_max:
				continue
			if rect.position.x < x_ofs:
				rect.size.x -= x_ofs - rect.position.x
				rect.position.x = x_ofs
			if rect.position.x + rect.size.x > ofs_max:
				rect.size.x = ofs_max - rect.position.x
			selection.append([rect.position.x, rect.position.y, rect.size.x, rect.size.y])
	# The carets are drawn after the text, whose pass moved ofs.y down by the ascent (le.cpp:1466).
	var carets: Array = []
	var info: Dictionary = ts.shaped_text_get_carets(shaped, le.caret_column)
	var caret_width: int = le.get_theme_constant("caret_width")
	var baseline: float = float(y_ofs) + ts.shaped_text_get_ascent(shaped)
	for side: String in ["leading_rect", "trailing_rect"]:
		var caret: Rect2 = info[side]
		caret.position += Vector2(x_ofs, baseline)
		caret.size.x = caret_width
		carets.append([caret.position.x, caret.position.y, caret.size.x, caret.size.y])
	ts.free_rid(shaped)
	return {"text": le.text, "text_height": text_height, "selection": selection, "carets": carets}


## Every page of every cache of every font, by RID (each RID once), sorted by (size, outline).
func _pages(fonts: Array[Dictionary]) -> Array[Dictionary]:
	var ts: TextServer = TextServerManager.get_primary_interface()
	var out: Array[Dictionary] = []
	var seen: Dictionary = {}
	for entry: Dictionary in fonts:
		var key: String = entry["key"]
		var font: Font = entry["font"]
		for rid: RID in font.get_rids():
			if seen.has(rid):
				continue
			seen[rid] = true
			var sizes: Array[Vector2i] = []
			for info: Dictionary in ts.font_get_size_cache_info(rid):
				var size_px: Vector2i = info["size_px"]
				sizes.append(size_px)
			sizes.sort()
			for size: Vector2i in sizes:
				var count: int = ts.font_get_texture_count(rid, size)
				for index: int in range(count):
					var image: Image = ts.font_get_texture_image(rid, size, index)
					out.append({
						"font_key": key,
						"size": size.x,
						"outline": size.y,
						"index": index,
						"width": image.get_width(),
						"height": image.get_height(),
						"format": FORMAT_NAMES[int(image.get_format())],
						"sha256": _sha256(_encode(image)),
					})
	return out


## {type, value}: the Variant type in snake case and its components (floats widened to double).
static func variant_view(v: Variant) -> Dictionary:
	match typeof(v):
		TYPE_NIL:
			return {"type": "nil", "value": null}
		TYPE_INT:
			var i: int = v
			return {"type": "int", "value": i}
		TYPE_FLOAT:
			var x: float = v
			return {"type": "float", "value": x}
		TYPE_COLOR:
			var c: Color = v
			return {"type": "color", "value": [c.r, c.g, c.b, c.a]}
		TYPE_VECTOR4:
			var v4: Vector4 = v
			return {"type": "vector4", "value": [v4.x, v4.y, v4.z, v4.w]}
	return {"type": type_string(typeof(v)), "value": str(v)}


## The render-stream-shader/1 payload of a code string (gate5_5-design.md Q4).
static func grp1(code: String) -> PackedByteArray:
	var data: PackedByteArray = code.to_utf8_buffer()
	var meta: PackedByteArray = ("{\"type\":\"shader-code\",\"code_bytes\":%d}" % data.size()).to_utf8_buffer()
	var out: PackedByteArray = PackedByteArray(GRP1_MAGIC)
	var head: PackedByteArray = PackedByteArray()
	head.resize(4)
	head.encode_u32(0, meta.size())
	out.append_array(head)
	out.append_array(meta)
	out.append_array(data)
	return out


## render-stream-2.md "Texture payload": GRT1 magic, u32le meta_len, canonical meta, u32le
## data_len, Image.get_data().
static func _encode(image: Image) -> PackedByteArray:
	var data: PackedByteArray = image.get_data()
	var meta: String = "{\"type\":\"texture-2d\",\"format\":\"%s\",\"width\":%d,\"height\":%d,\"mipmaps\":%s,\"data_bytes\":%d}" % [
		FORMAT_NAMES[int(image.get_format())], image.get_width(), image.get_height(),
		"true" if image.has_mipmaps() else "false", data.size(),
	]
	var meta_bytes: PackedByteArray = meta.to_ascii_buffer()
	var out: PackedByteArray = PackedByteArray([0x47, 0x52, 0x54, 0x31, 0x0D, 0x0A, 0x1A, 0x0A])
	var head: PackedByteArray = PackedByteArray()
	head.resize(4)
	head.encode_u32(0, meta_bytes.size())
	out.append_array(head)
	out.append_array(meta_bytes)
	var len_bytes: PackedByteArray = PackedByteArray()
	len_bytes.resize(4)
	len_bytes.encode_u32(0, data.size())
	out.append_array(len_bytes)
	out.append_array(data)
	return out


static func _sha256(bytes: PackedByteArray) -> String:
	var ctx: HashingContext = HashingContext.new()
	ctx.start(HashingContext.HASH_SHA256)
	ctx.update(bytes)
	return ctx.finish().hex_encode()
