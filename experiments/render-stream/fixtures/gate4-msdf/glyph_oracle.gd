extends RefCounted
## The gate 4 glyph oracle, MSDF edition (../../protocol/gate4-design.md "Q6c", "Q1g" and "G4e2",
## `render-stream-gate4-glyphs/1`). fixtures/gate4-layout/glyph_oracle.gd with the glyph
## arithmetic of the MSDF branch of `_font_draw_glyph` / `_font_draw_glyph_outline`
## (modules/text_server_adv/text_server_adv.cpp:4021-4025, :4167-4171): no subpixel shift, no
## floor, and the glyph's rect scaled by size / msdf_size.
##
## Runs on reference legs only (gate4_msdf.gd refuses it when a GRC_* capture variable is set). At
## each settle frame it writes one JSON line: every visible text node's glyph commands in draw
## order (outline pass, then text pass, per line), each with the quad, source rect, outline,
## px_range and scale the engine's MSDF draw computes, and every atlas page of every font cache
## (`font_get_size_cache_info`) with the `render-stream-texture/1` SHA-256 of its live CPU image.
## Page bytes go to `<log dir>/pages/<sha256>.grt`.
##
## It reproduces Label's layout and draw as the layout oracle does (scene/gui/label.cpp, 4.5.1;
## its docstring lists the steps). Per glyph, the MSDF arithmetic is the engine's in the engine's
## precision: `font_get_glyph_offset` / `_size` return `fgl.rect.{position,size} * size /
## msdf_size` computed exactly as the draw computes them (Vector2 * real_t, then / real_t,
## text_server_adv.cpp:3268-3269), and the quad position is the pen (a float32 Vector2) plus that
## offset, a float32 add, unfloored (Q1g).
##
## It never calls `font_get_glyph_texture_rid` or `font_get_glyph_texture_size`: both upload a
## dirty page (Q1c). It never shapes a hidden node. Every glyph it names was rasterized when the
## Label shaped (an MSDF cache is keyed on msdf_size alone, ts_adv.h:408-409, whatever the draw
## size or outline), so its metric getters rasterize nothing. `font_get_texture_image` returns
## the live CPU image without side effects (text_server_adv.cpp:3081-3093).
##
## Its own GRT1 encoder below is deliberately not shared with the capture (C++): two encoders that
## agree are evidence.

## Image.Format identifiers without FORMAT_, in enum order (core/io/image.h:75-114).
const FORMAT_NAMES: Array[String] = [
	"L8", "LA8", "R8", "RG8", "RGB8", "RGBA8", "RGBA4444", "RGB565", "RF", "RGF", "RGBF", "RGBAF",
	"RH", "RGH", "RGBH", "RGBAH", "RGBE9995", "DXT1", "DXT3", "DXT5", "RGTC_R", "RGTC_RG",
	"BPTC_RGBA", "BPTC_RGBF", "BPTC_RGBFU", "ETC", "ETC2_R11", "ETC2_R11S", "ETC2_RG11",
	"ETC2_RG11S", "ETC2_RGB8", "ETC2_RGBA8", "ETC2_RGB8A1", "ETC2_RA_AS_RG", "DXT5_RA_AS_RG",
	"ASTC_4x4", "ASTC_4x4_HDR", "ASTC_8x8", "ASTC_8x8_HDR",
]

## servers/text_server.h:171-172.
const SUBPIXEL_ONE_QUARTER_MAX_SIZE: int = 16
const SUBPIXEL_ONE_HALF_MAX_SIZE: int = 20

var _file: FileAccess
var _pages_dir: String = ""
var _written: Dictionary = {}


func open(path: String) -> bool:
	_file = FileAccess.open(path, FileAccess.WRITE)
	if _file == null:
		return false
	_pages_dir = path.get_base_dir().path_join("pages")
	return DirAccess.make_dir_recursive_absolute(_pages_dir) == OK


## One line for the settle frame of `step`. `font_keys` maps a key to its Font, in report order.
func record(step: int, frame: int, nodes: Array[Label], font_keys: Dictionary) -> void:
	var ts: TextServer = TextServerManager.get_primary_interface()
	var key_of_rid: Dictionary = {}
	for key: String in font_keys:
		var font: Font = font_keys[key]
		for rid: RID in font.get_rids():
			key_of_rid[rid] = key
	var out_nodes: Array[Dictionary] = []
	for label: Label in nodes:
		if not label.is_visible_in_tree():
			continue
		out_nodes.append(_node(ts, label, key_of_rid))
	var pages: Array[Dictionary] = []
	for key: String in font_keys:
		var font: Font = font_keys[key]
		pages.append_array(_pages(ts, key, font))
	var line: Dictionary = {
		"schema": "render-stream-gate4-glyphs/1",
		"step": step,
		"frame": frame,
		"nodes": out_nodes,
		"pages": pages,
	}
	_file.store_line(JSON.stringify(line, "", false, true))
	_file.flush()


## Label's ascent/descent adjustment: a line shorter than the font height is centred in it
## (label.cpp:503-508 and its copies).
func _line_metrics(ts: TextServer, line: RID, font_h: int) -> Vector2:
	var asc: float = ts.shaped_text_get_ascent(line)
	var dsc: float = ts.shaped_text_get_descent(line)
	if asc + dsc < font_h:
		var diff: float = font_h - (asc + dsc)
		asc += diff / 2
		dsc += diff - (diff / 2)
	return Vector2(asc, dsc)


func _node(ts: TextServer, label: Label, key_of_rid: Dictionary) -> Dictionary:
	var font: Font = label.get_theme_font("font")
	var font_size: int = label.get_theme_font_size("font_size")
	var font_h: int = int(font.get_height(font_size))
	var colour: Color = label.get_theme_color("font_color")
	var shadow_colour: Color = label.get_theme_color("font_shadow_color")
	var outline_colour: Color = label.get_theme_color("font_outline_color")
	var shadow_ofs := Vector2(label.get_theme_constant("shadow_offset_x"), label.get_theme_constant("shadow_offset_y"))
	var outline_size: int = label.get_theme_constant("outline_size")
	var shadow_outline_size: int = label.get_theme_constant("shadow_outline_size")
	var line_spacing: int = label.get_theme_constant("line_spacing")
	var paragraph_spacing: int = label.get_theme_constant("paragraph_spacing")
	var rids: Array[RID] = font.get_rids()
	var font_key: String = key_of_rid.get(rids[0], "?")
	var xf: Transform2D = label.get_global_transform()
	var box: Vector2 = label.size
	# The `normal` stylebox is the default theme's StyleBoxEmpty: no margins, no offset.
	var width: int = int(box.x)

	# _shape: one paragraph (the fixture's texts have no paragraph separator).
	var para_text: String = label.text + String.chr(0x200B)
	var para: RID = ts.create_shaped_text()
	ts.shaped_text_set_direction(para, TextServer.DIRECTION_LTR)
	ts.shaped_text_add_string(para, para_text, rids, font_size, font.get_opentype_features(), label.language)
	var autowrap_flags: int = TextServer.BREAK_MANDATORY
	match label.autowrap_mode:
		TextServer.AUTOWRAP_WORD_SMART:
			autowrap_flags = TextServer.BREAK_WORD_BOUND | TextServer.BREAK_ADAPTIVE | TextServer.BREAK_MANDATORY
		TextServer.AUTOWRAP_WORD:
			autowrap_flags = TextServer.BREAK_WORD_BOUND | TextServer.BREAK_MANDATORY
		TextServer.AUTOWRAP_ARBITRARY:
			autowrap_flags = TextServer.BREAK_GRAPHEME_BOUND | TextServer.BREAK_MANDATORY
	autowrap_flags = autowrap_flags | label.autowrap_trim_flags
	var breaks: PackedInt32Array = ts.shaped_text_get_line_breaks(para, width, 0, autowrap_flags)
	var lines: Array[RID] = []
	var line_texts: Array[String] = []
	var i: int = 0
	while i < breaks.size():
		lines.append(ts.shaped_text_substr(para, breaks[i], breaks[i + 1] - breaks[i]))
		line_texts.append(para_text.substr(breaks[i], breaks[i + 1] - breaks[i]).replace(String.chr(0x200B), ""))
		i += 2

	# Justification and overrun, as Label does them (no overrun behaviour, no tab stops, no
	# visible-character limit, so only fill alignment changes a line).
	var jst_flags: int = label.justification_flags
	var fill: bool = label.horizontal_alignment == HORIZONTAL_ALIGNMENT_FILL
	var overrun_flags: int = TextServer.OVERRUN_NO_TRIM
	var jst_to_line: int = lines.size()
	if not (lines.size() == 1 and (jst_flags & TextServer.JUSTIFICATION_DO_NOT_SKIP_SINGLE_LINE) != 0):
		if (jst_flags & TextServer.JUSTIFICATION_SKIP_LAST_LINE) != 0:
			jst_to_line = lines.size() - 1
		if (jst_flags & TextServer.JUSTIFICATION_SKIP_LAST_LINE_WITH_VISIBLE_CHARS) != 0:
			for j: int in range(lines.size() - 1, -1, -1):
				if ts.shaped_text_has_visible_chars(lines[j]):
					jst_to_line = j
					break
	if label.autowrap_mode != TextServer.AUTOWRAP_OFF:
		if fill:
			for j: int in range(lines.size()):
				if j < jst_to_line:
					ts.shaped_text_fit_to_width(lines[j], width, jst_flags)
	else:
		for j: int in range(lines.size()):
			if j < jst_to_line and fill:
				ts.shaped_text_fit_to_width(lines[j], width, jst_flags)
				ts.shaped_text_set_custom_ellipsis(lines[j], 0x2026)
				ts.shaped_text_overrun_trim_to_width(lines[j], width, overrun_flags | TextServer.OVERRUN_JUSTIFICATION_AWARE)
				ts.shaped_text_fit_to_width(lines[j], width, jst_flags | TextServer.JUSTIFICATION_CONSTRAIN_ELLIPSIS)
			else:
				ts.shaped_text_set_custom_ellipsis(lines[j], 0x2026)
				ts.shaped_text_overrun_trim_to_width(lines[j], width, overrun_flags)

	# get_layout_data: the lines that fit the box, the real total height, the vertical alignment.
	var total_h: float = 0.0
	var lines_visible: int = 0
	for line: RID in lines:
		var m: Vector2 = _line_metrics(ts, line, font_h)
		total_h += m.x + m.y + line_spacing
		if total_h > ceilf(box.y + line_spacing):
			break
		lines_visible += 1
	var last_line: int = mini(lines.size(), lines_visible)
	total_h = 0.0
	for j: int in range(last_line):
		var m: Vector2 = _line_metrics(ts, lines[j], font_h)
		total_h += m.x + m.y + line_spacing
	total_h += paragraph_spacing
	var vbegin: int = 0
	var vsep: int = 0
	if lines_visible > 0:
		match label.vertical_alignment:
			VERTICAL_ALIGNMENT_CENTER:
				vbegin = int((box.y - (total_h - line_spacing - paragraph_spacing)) / 2)
			VERTICAL_ALIGNMENT_BOTTOM:
				vbegin = int(box.y - (total_h - line_spacing - paragraph_spacing))
			VERTICAL_ALIGNMENT_FILL:
				if lines_visible > 1:
					vsep = int((box.y - (total_h - line_spacing - paragraph_spacing)) / (lines_visible - 1))
	var ofs := Vector2(0, vbegin)
	var spacing: int = line_spacing + vsep

	# NOTIFICATION_DRAW: per line, shadow outline, shadow, outline, text.
	var glyphs_out: Array[Dictionary] = []
	var shaped: int = 0
	var line_rects: Array[Array] = []
	for j: int in range(last_line):
		var line: RID = lines[j]
		var line_size: Vector2 = ts.shaped_text_get_size(line)
		var m: Vector2 = _line_metrics(ts, line, font_h)
		match label.horizontal_alignment:
			HORIZONTAL_ALIGNMENT_CENTER:
				# label.cpp:532: int(size.width - line_size.width) / 2, an integer division.
				@warning_ignore("integer_division")
				ofs.x = int(box.x - line_size.x) / 2
			HORIZONTAL_ALIGNMENT_RIGHT:
				ofs.x = int(box.x - line_size.x)
			_:
				ofs.x = 0
		line_rects.append([ofs.x, ofs.y, line_size.x, m.x + m.y])
		ofs.y += m.x
		var glyphs: Array[Dictionary] = ts.shaped_text_get_glyphs(line)
		shaped += glyphs.size()
		var trim_pos: int = ts.shaped_text_get_trim_pos(line)
		if ts.shaped_text_get_ellipsis_pos(line) >= 0:
			push_error("gate4-msdf oracle: %s line %d has an ellipsis, which the oracle does not model" % [label.name, j])
		if shadow_colour.a != 0 and shadow_outline_size > 0:
			_pass(ts, glyphs, trim_pos, ofs, shadow_ofs, shadow_outline_size, shadow_colour, "shadow-outline", key_of_rid, glyphs_out)
		if shadow_colour.a > 0:
			_pass(ts, glyphs, trim_pos, ofs, shadow_ofs, 0, shadow_colour, "shadow", key_of_rid, glyphs_out)
		if outline_size > 0 and outline_colour.a != 0:
			_pass(ts, glyphs, trim_pos, ofs, Vector2(), outline_size, outline_colour, "outline", key_of_rid, glyphs_out)
		_pass(ts, glyphs, trim_pos, ofs, Vector2(), 0, colour, "text", key_of_rid, glyphs_out)
		ofs.y += m.y + spacing
	for line: RID in lines:
		ts.free_rid(line)
	ts.free_rid(para)
	return {
		"name": String(label.name),
		"text": label.text,
		"font_key": font_key,
		"size": font_size,
		"colour": [colour.r, colour.g, colour.b, colour.a],
		"shadow_colour": [shadow_colour.r, shadow_colour.g, shadow_colour.b, shadow_colour.a],
		"shadow_offset": [shadow_ofs.x, shadow_ofs.y],
		"outline_colour": [outline_colour.r, outline_colour.g, outline_colour.b, outline_colour.a],
		"outline_size": outline_size,
		"shadow_outline_size": shadow_outline_size,
		"global_xform": [xf.x.x, xf.x.y, xf.y.x, xf.y.y, xf.origin.x, xf.origin.y],
		"box": [box.x, box.y],
		"clip": label.clip_text,
		"autowrap": int(label.autowrap_mode),
		"horizontal_alignment": int(label.horizontal_alignment),
		"vertical_alignment": int(label.vertical_alignment),
		"font_height": font_h,
		"line_spacing": line_spacing,
		"lines": lines.size(),
		"lines_drawn": last_line,
		"line_texts": line_texts,
		"line_rects": line_rects,
		"shaped_glyphs": shaped,
		"glyphs": glyphs_out,
	}


## One `draw_text` pass over a line's glyphs (label.h:197-245; no ellipsis, no visible-character
## limit): the pen starts at the line offset and advances by each glyph's advance.
func _pass(ts: TextServer, glyphs: Array[Dictionary], trim_pos: int, ofs: Vector2, extra: Vector2, outline: int, colour: Color, pass_name: String, key_of_rid: Dictionary, out: Array[Dictionary]) -> void:
	var step := Vector2(ofs)
	for j: int in range(glyphs.size()):
		if trim_pos >= 0 and j >= trim_pos:
			break
		var glyph: Dictionary = glyphs[j]
		var repeat: int = glyph["repeat"]
		var advance: float = glyph["advance"]
		var offset: Vector2 = glyph["offset"]
		var glyph_font: RID = glyph["font_rid"]
		var glyph_size: int = glyph["font_size"]
		var index: int = glyph["index"]
		for _r: int in range(repeat):
			# draw_glyph / draw_glyph_shadow / draw_glyph_outline: p_ofs + (x_off, y_off) [+ shadow].
			var pos: Vector2 = step + offset
			if extra != Vector2():
				pos = pos + extra
			var entry: Dictionary = _glyph(ts, glyph_font, glyph_size, outline, index, pos, key_of_rid)
			if not entry.is_empty():
				entry["pass"] = pass_name
				entry["colour"] = [colour.r, colour.g, colour.b, colour.a]
				out.append(entry)
			step.x += advance


## The command `_font_draw_glyph[_outline]` makes for one glyph at `pos`, or {} when it makes none
## (index 0, no font, or an empty bitmap: texture_idx -1).
func _glyph(ts: TextServer, font_rid: RID, font_size: int, outline: int, index: int, pos: Vector2, key_of_rid: Dictionary) -> Dictionary:
	if index == 0 or not font_rid.is_valid():
		return {}
	if ts.font_is_multichannel_signed_distance_field(font_rid):
		return _msdf_glyph(ts, font_rid, font_size, outline, index, pos, key_of_rid)
	var size := Vector2i(font_size, outline)
	# Subpixel x shift (text_server_adv.cpp:3974-3981) and the matching pen offset (:4031-4035);
	# both depend on the cache size font_size x 64 at oversampling 1 (D12).
	var subpixel: int = ts.font_get_subpixel_positioning(font_rid)
	var xshift: int = 0
	var cpos := Vector2(pos)
	if subpixel == TextServer.SUBPIXEL_POSITIONING_ONE_QUARTER or (subpixel == TextServer.SUBPIXEL_POSITIONING_AUTO and font_size <= SUBPIXEL_ONE_QUARTER_MAX_SIZE):
		xshift = int(floorf(4 * (pos.x + 0.125)) - 4 * floorf(pos.x + 0.125))
		cpos.x = pos.x + 0.125
	elif subpixel == TextServer.SUBPIXEL_POSITIONING_ONE_HALF or (subpixel == TextServer.SUBPIXEL_POSITIONING_AUTO and font_size <= SUBPIXEL_ONE_HALF_MAX_SIZE):
		xshift = int(floorf(2 * (pos.x + 0.25)) - 2 * floorf(pos.x + 0.25))
		cpos.x = pos.x + 0.25
	var variant: int = index | (xshift << 27)
	var page: int = ts.font_get_glyph_texture_idx(font_rid, size, variant)
	if page < 0:
		return {}
	var gpos: Vector2 = ts.font_get_glyph_offset(font_rid, size, variant)
	var gsize: Vector2 = ts.font_get_glyph_size(font_rid, size, variant)
	var uv: Rect2 = ts.font_get_glyph_uv_rect(font_rid, size, variant)
	var quad_pos := Vector2(floorf(cpos.x), floorf(cpos.y)) + gpos
	return {
		"index": index,
		"xshift": xshift,
		"font_key": key_of_rid.get(font_rid, "?"),
		"size": font_size,
		"outline": outline,
		"x": pos.x,
		"y": pos.y,
		"quad": [quad_pos.x, quad_pos.y, gsize.x, gsize.y],
		"uv": [uv.position.x, uv.position.y, uv.size.x, uv.size.y],
		"page": page,
	}


## The command the MSDF branch of `_font_draw_glyph[_outline]` makes for one glyph at `pos`
## (text_server_adv.cpp:4021-4025, :4167-4171), or {} when it makes none (texture_idx -1). The
## cache is (msdf_size, 0) for every draw size and outline (`_get_size_outline`, ts_adv.h:417-419);
## the getters take the draw size and scale by size / msdf_size themselves.
func _msdf_glyph(ts: TextServer, font_rid: RID, font_size: int, outline: int, index: int, pos: Vector2, key_of_rid: Dictionary) -> Dictionary:
	var size := Vector2i(font_size, 0)
	var page: int = ts.font_get_glyph_texture_idx(font_rid, size, index)
	if page < 0:
		return {}
	var msdf_size: int = ts.font_get_msdf_size(font_rid)
	var gpos: Vector2 = ts.font_get_glyph_offset(font_rid, size, index)
	var gsize: Vector2 = ts.font_get_glyph_size(font_rid, size, index)
	var uv: Rect2 = ts.font_get_glyph_uv_rect(font_rid, size, index)
	var quad_pos: Vector2 = pos + gpos
	return {
		"index": index,
		"xshift": 0,
		"font_key": key_of_rid.get(font_rid, "?"),
		"size": font_size,
		"cache_size": msdf_size,
		"outline": outline,
		"x": pos.x,
		"y": pos.y,
		"quad": [quad_pos.x, quad_pos.y, gsize.x, gsize.y],
		"uv": [uv.position.x, uv.position.y, uv.size.x, uv.size.y],
		"page": page,
		"msdf": true,
		"px_range": float(ts.font_get_msdf_pixel_range(font_rid)),
		"scale": float(font_size) / float(msdf_size),
	}


## Every page of every cache of `font`, plain and outline, sorted by (size, outline).
func _pages(ts: TextServer, key: String, font: Font) -> Array[Dictionary]:
	var out: Array[Dictionary] = []
	for rid: RID in font.get_rids():
		var sizes: Array[Vector2i] = []
		for info: Dictionary in ts.font_get_size_cache_info(rid):
			var size_px: Vector2i = info["size_px"]
			sizes.append(size_px)
		sizes.sort()
		for size: Vector2i in sizes:
			var count: int = ts.font_get_texture_count(rid, size)
			for index: int in range(count):
				var image: Image = ts.font_get_texture_image(rid, size, index)
				var bytes: PackedByteArray = _encode(image)
				var sha: String = _sha256_hex(bytes)
				if not _written.has(sha):
					var file: FileAccess = FileAccess.open(_pages_dir.path_join(sha + ".grt"), FileAccess.WRITE)
					if file != null:
						file.store_buffer(bytes)
						file.close()
					_written[sha] = true
				out.append({
					"font_key": key,
					"size": size.x,
					"outline": size.y,
					"index": index,
					"width": image.get_width(),
					"height": image.get_height(),
					"format": FORMAT_NAMES[int(image.get_format())],
					"mipmaps": image.has_mipmaps(),
					"data_bytes": image.get_data_size(),
					"sha256": sha,
				})
	return out


## render-stream-2.md "Texture payload": GRT1 magic, u32le meta_len, canonical meta, u32le
## data_len, Image.get_data().
func _encode(image: Image) -> PackedByteArray:
	var data: PackedByteArray = image.get_data()
	var meta: String = "{\"type\":\"texture-2d\",\"format\":\"%s\",\"width\":%d,\"height\":%d,\"mipmaps\":%s,\"data_bytes\":%d}" % [
		FORMAT_NAMES[int(image.get_format())], image.get_width(), image.get_height(),
		"true" if image.has_mipmaps() else "false", data.size(),
	]
	var meta_bytes: PackedByteArray = meta.to_ascii_buffer()
	var out := PackedByteArray([0x47, 0x52, 0x54, 0x31, 0x0D, 0x0A, 0x1A, 0x0A])
	out.append_array(_u32le(meta_bytes.size()))
	out.append_array(meta_bytes)
	out.append_array(_u32le(data.size()))
	out.append_array(data)
	return out


func _sha256_hex(bytes: PackedByteArray) -> String:
	var context := HashingContext.new()
	context.start(HashingContext.HASH_SHA256)
	context.update(bytes)
	return context.finish().hex_encode()


func _u32le(value: int) -> PackedByteArray:
	return PackedByteArray([value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >> 24) & 0xff])
