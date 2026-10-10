extends RefCounted
## The gate 4 glyph oracle, multilingual edition (../../protocol/gate4-design.md "Q6c" and "G4f",
## `render-stream-gate4-glyphs/1`). fixtures/gate4-layout/glyph_oracle.gd reduced to what this
## fixture draws (single-line, left/top-aligned Labels with only the text pass) and extended with
## the shaped clusters, the font each glyph came from through the fallback chain, and hex-code
## boxes for glyphs no font has.
##
## Runs on reference legs only (gate4_i18n.gd refuses it when a GRC_* capture variable is set).
## At each settle frame it writes one JSON line: every visible text node's shaped glyphs (visual
## order, with their clusters `start`/`end`/`count`, flags, advance, offset, pen position and font
## key), its draw commands in order -- an `add_texture_rect_region` per glyph with a bitmap, with
## the quad and source rect `_font_draw_glyph` would compute
## (modules/text_server_adv/text_server_adv.cpp:3922-4066), or the `add_rect`s of
## `TextServer::draw_hex_code_box` (servers/text_server.cpp:731-799) for a glyph with no font --,
## every size cache of each font (`font_get_size_cache_info`) and every atlas page with the
## `render-stream-texture/1` SHA-256 of its live CPU image. Page bytes go to
## `<log dir>/pages/<sha256>.grt` for the synthesizer.
##
## It reproduces Label's layout and draw (scene/gui/label.cpp, 4.5.1) for these Labels:
## - `_shape` (:139-326): one paragraph, the text plus U+200B (:160-163), shaped in the Label's
##   direction (AUTO by default, label.h:70: the first strong character's) with its font RIDs --
##   OS and, through `Font::get_rids`, its fallbacks VZ, DV and HE -- size, features and language;
##   no autowrap, so one line per paragraph (`shaped_text_get_line_breaks` with BREAK_MANDATORY);
## - `get_layout_data` and `_get_line_rect` (:494-650) for top/left alignment;
## - NOTIFICATION_DRAW (:725-886) and `draw_text` (label.h:197-245): the text pass only (no
##   shadow, no outline), walking the line's glyphs in visual order from the line offset with the
##   pen advancing by each glyph's advance; `draw_glyph` (label.cpp:419-425): a glyph with a font
##   goes to `font_draw_glyph`, one without (index = the codepoint) to `draw_hex_code_box` unless
##   it is virtual or an embedded object.
##
## It never calls `font_get_glyph_texture_rid` or `font_get_glyph_texture_size`: both upload a
## dirty page (Q1c). It never shapes a hidden node. Its glyph metric getters only name glyphs the
## draw already rasterized (subpixel positioning is off). Its cmap probes (`font_get_glyph_index`)
## only run on a font that already has the fixture's size cache, so the oracle never creates a
## cache the capture does not have. `font_get_texture_image` returns the live CPU image without
## side effects (text_server_adv.cpp:3081-3093).
##
## Its GRT1 encoder and hex-box geometry are deliberately not shared with the capture or the
## checker: two derivations that agree are evidence.

## Image.Format identifiers without FORMAT_, in enum order (core/io/image.h:75-114).
const FORMAT_NAMES: Array[String] = [
	"L8", "LA8", "R8", "RG8", "RGB8", "RGBA8", "RGBA4444", "RGB565", "RF", "RGF", "RGBF", "RGBAF",
	"RH", "RGH", "RGBH", "RGBAH", "RGBE9995", "DXT1", "DXT3", "DXT5", "RGTC_R", "RGTC_RG",
	"BPTC_RGBA", "BPTC_RGBF", "BPTC_RGBFU", "ETC", "ETC2_R11", "ETC2_R11S", "ETC2_RG11",
	"ETC2_RG11S", "ETC2_RGB8", "ETC2_RGBA8", "ETC2_RGB8A1", "ETC2_RA_AS_RG", "DXT5_RA_AS_RG",
	"ASTC_4x4", "ASTC_4x4_HDR", "ASTC_8x8", "ASTC_8x8_HDR",
]

## Seven-segment digits of `_draw_hex_code_box_number` (servers/text_server.cpp:732).
const HEX_SEGMENTS: Array[int] = [0x7E, 0x30, 0x6D, 0x79, 0x33, 0x5B, 0x5F, 0x70, 0x7F, 0x7B, 0x77, 0x1F, 0x4E, 0x3D, 0x4F, 0x47, 0x00]

## The cmap probes the script predictions name (font key, codepoint): the precomposed U+1EBF the
## NFD Vietnamese composes to, and the Devanagari consonant KA whose i-matra reorders.
const CMAP_PROBES: Array[Array] = [["OS", 0x1EBF], ["DV", 0x0915], ["DV", 0x093F]]

var _file: FileAccess
var _pages_dir: String = ""
var _written: Dictionary = {}


func open(path: String) -> bool:
	_file = FileAccess.open(path, FileAccess.WRITE)
	if _file == null:
		return false
	_pages_dir = path.get_base_dir().path_join("pages")
	return DirAccess.make_dir_recursive_absolute(_pages_dir) == OK


## One line for the settle frame of `step`. `fonts` maps a key to its FontFile, in fallback order.
func record(step: int, frame: int, nodes: Array[Label], fonts: Dictionary) -> void:
	var ts: TextServer = TextServerManager.get_primary_interface()
	# Each font's own TextServer RID (get_rids()[0]: Font::get_rids also lists the fallbacks).
	var key_of_rid: Dictionary = {}
	for key: String in fonts:
		var font: Font = fonts[key]
		key_of_rid[font.get_rids()[0]] = key
	var out_nodes: Array[Dictionary] = []
	var font_size: int = 0
	for label: Label in nodes:
		if not label.is_visible_in_tree():
			continue
		out_nodes.append(_node(ts, label, key_of_rid))
		font_size = label.get_theme_font_size("font_size")
	var pages: Array[Dictionary] = []
	var caches: Array[Dictionary] = []
	var cmap: Dictionary = {}
	for key: String in fonts:
		var font: Font = fonts[key]
		var rid: RID = font.get_rids()[0]
		pages.append_array(_pages(ts, key, rid))
		var has_size: bool = false
		for info: Dictionary in ts.font_get_size_cache_info(rid):
			var size_px: Vector2i = info["size_px"]
			var glyph_count: int = info["glyphs"]
			var texture_count: int = info["textures"]
			caches.append({"font_key": key, "size": size_px.x, "outline": size_px.y, "glyphs": glyph_count, "textures": texture_count})
			if size_px == Vector2i(font_size, 0):
				has_size = true
		for probe: Array in CMAP_PROBES:
			var probe_key: String = probe[0]
			var cp: int = probe[1]
			if probe_key == key and has_size:
				cmap["%s:%04X" % [key, cp]] = ts.font_get_glyph_index(rid, font_size, cp, 0)
	var line: Dictionary = {
		"schema": "render-stream-gate4-glyphs/1",
		"step": step,
		"frame": frame,
		"nodes": out_nodes,
		"pages": pages,
		"caches": caches,
		"cmap": cmap,
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
	# Font::get_height is the maximum over the font and its fallbacks (scene/resources/font.cpp:209-219).
	var font_h: int = int(font.get_height(font_size))
	var colour: Color = label.get_theme_color("font_color")
	var line_spacing: int = label.get_theme_constant("line_spacing")
	var paragraph_spacing: int = label.get_theme_constant("paragraph_spacing")
	var rids: Array[RID] = font.get_rids()
	var font_key: String = key_of_rid.get(rids[0], "?")
	var xf: Transform2D = label.get_global_transform()
	var box: Vector2 = label.size
	var width: int = int(box.x)
	var problems: Array[String] = []
	if label.autowrap_mode != TextServer.AUTOWRAP_OFF or label.horizontal_alignment != HORIZONTAL_ALIGNMENT_LEFT or label.vertical_alignment != VERTICAL_ALIGNMENT_TOP:
		problems.append("the oracle models unwrapped, left/top-aligned Labels only")
	if label.get_theme_constant("outline_size") > 0 or label.get_theme_color("font_shadow_color").a > 0:
		problems.append("the oracle models the text pass only (no outline, no shadow)")

	# _shape: one paragraph (the fixture's texts have no paragraph separator).
	var para_text: String = label.text + String.chr(0x200B)
	var para: RID = ts.create_shaped_text()
	# Label's text_direction defaults to AUTO (label.h:70): the paragraph takes the direction of
	# its first strong character (label.cpp:175-180).
	var direction: TextServer.Direction = TextServer.DIRECTION_AUTO
	match label.text_direction:
		Control.TEXT_DIRECTION_INHERITED:
			direction = TextServer.DIRECTION_RTL if label.is_layout_rtl() else TextServer.DIRECTION_LTR
		Control.TEXT_DIRECTION_LTR:
			direction = TextServer.DIRECTION_LTR
		Control.TEXT_DIRECTION_RTL:
			direction = TextServer.DIRECTION_RTL
	ts.shaped_text_set_direction(para, direction)
	ts.shaped_text_add_string(para, para_text, rids, font_size, font.get_opentype_features(), label.language)
	var inferred: int = ts.shaped_text_get_inferred_direction(para)
	var breaks: PackedInt32Array = ts.shaped_text_get_line_breaks(para, width, 0, TextServer.BREAK_MANDATORY | label.autowrap_trim_flags)
	var lines: Array[RID] = []
	var i: int = 0
	while i < breaks.size():
		lines.append(ts.shaped_text_substr(para, breaks[i], breaks[i + 1] - breaks[i]))
		i += 2
	# No fill alignment: Label only sets the ellipsis and the no-trim overrun on each line.
	for line: RID in lines:
		ts.shaped_text_set_custom_ellipsis(line, 0x2026)
		ts.shaped_text_overrun_trim_to_width(line, width, TextServer.OVERRUN_NO_TRIM)

	# get_layout_data: the lines that fit the box (top alignment: vbegin 0).
	var total_h: float = 0.0
	var lines_visible: int = 0
	for line: RID in lines:
		var m: Vector2 = _line_metrics(ts, line, font_h)
		total_h += m.x + m.y + line_spacing
		if total_h > ceilf(box.y + line_spacing):
			break
		lines_visible += 1
	var last_line: int = mini(lines.size(), lines_visible)
	var ofs := Vector2(0, 0)

	var shaped_out: Array[Dictionary] = []
	var glyphs_out: Array[Dictionary] = []
	var commands_out: Array[Dictionary] = []
	var line_rects: Array[Array] = []
	for j: int in range(last_line):
		var line: RID = lines[j]
		var line_size: Vector2 = ts.shaped_text_get_size(line)
		var m: Vector2 = _line_metrics(ts, line, font_h)
		ofs.x = 0
		line_rects.append([ofs.x, ofs.y, line_size.x, m.x + m.y])
		ofs.y += m.x
		var glyphs: Array[Dictionary] = ts.shaped_text_get_glyphs(line)
		var trim_pos: int = ts.shaped_text_get_trim_pos(line)
		if ts.shaped_text_get_ellipsis_pos(line) >= 0:
			problems.append("line %d has an ellipsis, which the oracle does not model" % j)
		_text_pass(ts, glyphs, trim_pos, ofs, colour, key_of_rid, shaped_out, glyphs_out, commands_out)
		ofs.y += m.y + line_spacing
	for line: RID in lines:
		ts.free_rid(line)
	ts.free_rid(para)
	for p: String in problems:
		push_error("gate4-i18n oracle: %s: %s" % [label.name, p])
	var codepoints: Array[int] = []
	for k: int in range(label.text.length()):
		codepoints.append(label.text.unicode_at(k))
	return {
		"name": String(label.name),
		"text": label.text,
		"codepoints": codepoints,
		"font_key": font_key,
		"size": font_size,
		"colour": [colour.r, colour.g, colour.b, colour.a],
		"global_xform": [xf.x.x, xf.x.y, xf.y.x, xf.y.y, xf.origin.x, xf.origin.y],
		"box": [box.x, box.y],
		"direction": int(direction),
		"inferred_direction": inferred,
		"font_height": font_h,
		"line_spacing": line_spacing,
		"paragraph_spacing": paragraph_spacing,
		"lines": lines.size(),
		"lines_drawn": last_line,
		"line_rects": line_rects,
		"shaped": shaped_out,
		"shaped_glyphs": shaped_out.size(),
		"glyphs": glyphs_out,
		"commands": commands_out,
		"problems": problems,
	}


## The text pass of `draw_text` over one line's glyphs (label.h:197-245; LTR paragraph, no
## ellipsis, no visible-character limit): the pen starts at the line offset and advances by each
## glyph's advance; each glyph is drawn by `draw_glyph` (label.cpp:419-425).
func _text_pass(ts: TextServer, glyphs: Array[Dictionary], trim_pos: int, ofs: Vector2, colour: Color, key_of_rid: Dictionary, shaped_out: Array[Dictionary], glyphs_out: Array[Dictionary], commands_out: Array[Dictionary]) -> void:
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
		var flags: int = glyph["flags"]
		var start: int = glyph["start"]
		var end: int = glyph["end"]
		var count: int = glyph["count"]
		var glyph_key: Variant = null
		if glyph_font.is_valid():
			glyph_key = key_of_rid.get(glyph_font, "?")
		for _r: int in range(repeat):
			var pos: Vector2 = step + offset
			var entry: Dictionary = {
				"index": index,
				"font_key": glyph_key,
				"start": start,
				"end": end,
				"count": count,
				"flags": flags,
				"advance": advance,
				"offset": [offset.x, offset.y],
				"pen": [step.x, step.y],
				"command": -1,
				"hex_rects": 0,
			}
			if glyph_font.is_valid():
				var g: Dictionary = _glyph(ts, glyph_font, glyph_size, index, pos, key_of_rid)
				if not g.is_empty():
					g["pass"] = "text"
					g["colour"] = [colour.r, colour.g, colour.b, colour.a]
					g["start"] = start
					g["end"] = end
					entry["command"] = glyphs_out.size()
					commands_out.append({"op": "add_texture_rect_region", "glyph": glyphs_out.size()})
					glyphs_out.append(g)
			elif (flags & TextServer.GRAPHEME_IS_VIRTUAL) != TextServer.GRAPHEME_IS_VIRTUAL and (flags & TextServer.GRAPHEME_IS_EMBEDDED_OBJECT) != TextServer.GRAPHEME_IS_EMBEDDED_OBJECT:
				var rects: Array[Array] = _hex_box(glyph_size, pos, index)
				entry["hex_rects"] = rects.size()
				for rect: Array in rects:
					commands_out.append({"op": "add_rect", "rect": rect, "colour": [colour.r, colour.g, colour.b, colour.a], "codepoint": index})
			shaped_out.append(entry)
			step.x += advance


## The command `_font_draw_glyph` makes for one glyph at `pos`, or {} when it makes none (index 0,
## or an empty bitmap: texture_idx -1). Subpixel positioning is off, so there is no x shift and the
## quad is floored at scale 1 (:4027-4056).
func _glyph(ts: TextServer, font_rid: RID, font_size: int, index: int, pos: Vector2, key_of_rid: Dictionary) -> Dictionary:
	if index == 0:
		return {}
	var size := Vector2i(font_size, 0)
	if ts.font_get_subpixel_positioning(font_rid) != TextServer.SUBPIXEL_POSITIONING_DISABLED:
		push_error("gate4-i18n oracle: a font with subpixel positioning on")
	var page: int = ts.font_get_glyph_texture_idx(font_rid, size, index)
	if page < 0:
		return {}
	var gpos: Vector2 = ts.font_get_glyph_offset(font_rid, size, index)
	var gsize: Vector2 = ts.font_get_glyph_size(font_rid, size, index)
	var uv: Rect2 = ts.font_get_glyph_uv_rect(font_rid, size, index)
	var quad_pos := Vector2(floorf(pos.x), floorf(pos.y)) + gpos
	return {
		"index": index,
		"xshift": 0,
		"font_key": key_of_rid.get(font_rid, "?"),
		"size": font_size,
		"outline": 0,
		"x": pos.x,
		"y": pos.y,
		"quad": [quad_pos.x, quad_pos.y, gsize.x, gsize.y],
		"uv": [uv.position.x, uv.position.y, uv.size.x, uv.size.y],
		"page": page,
	}


## `TextServer::draw_hex_code_box` (servers/text_server.cpp:757-799) as [x, y, w, h] rects in draw
## order: the frame's four sides, then each hex digit's lit segments.
func _hex_box(font_size: int, pos: Vector2, index: int) -> Array[Array]:
	var out: Array[Array] = []
	if index == 0:
		return out
	var w: int = 1 if index <= 0xFF else (2 if index <= 0xFFFF else 3)
	var sp: int = maxi(0, w - 1)
	var sz: int = maxi(1, int(roundf(font_size / 15.0)))
	var box := Vector2(4 + 3 * w + sp, 15) * sz
	var origin: Vector2 = pos - Vector2(Vector2i(0, int(box.y * 0.85)))
	out.append(_rect(origin, Vector2(sz, box.y)))
	out.append(_rect(origin + Vector2(box.x - sz, 0), Vector2(sz, box.y)))
	out.append(_rect(origin, Vector2(box.x, sz)))
	out.append(_rect(origin + Vector2(0, box.y - sz), Vector2(box.x, sz)))
	var digits: Array[int] = []
	var cells: Array[Vector2] = []
	if index <= 0xFF:
		digits = [(index >> 4) & 0xF, index & 0xF]
		cells = [Vector2(2, 2), Vector2(2, 8)]
	elif index <= 0xFFFF:
		digits = [(index >> 12) & 0xF, (index >> 8) & 0xF, (index >> 4) & 0xF, index & 0xF]
		cells = [Vector2(2, 2), Vector2(6, 2), Vector2(2, 8), Vector2(6, 8)]
	else:
		digits = [(index >> 20) & 0xF, (index >> 16) & 0xF, (index >> 12) & 0xF, (index >> 8) & 0xF, (index >> 4) & 0xF, index & 0xF]
		cells = [Vector2(2, 2), Vector2(6, 2), Vector2(10, 2), Vector2(2, 8), Vector2(6, 8), Vector2(10, 8)]
	for d: int in range(digits.size()):
		var at: Vector2 = origin + cells[d] * sz
		var bits: int = HEX_SEGMENTS[digits[d]]
		# Segments in _draw_hex_code_box_number's order, bit 6 down to bit 0.
		var segments: Array[Array] = [
			[6, Vector2(0, 0), Vector2(3, 1)],
			[5, Vector2(2, 0), Vector2(1, 3)],
			[4, Vector2(2, 2), Vector2(1, 3)],
			[3, Vector2(0, 4), Vector2(3, 1)],
			[2, Vector2(0, 2), Vector2(1, 3)],
			[1, Vector2(0, 0), Vector2(1, 3)],
			[0, Vector2(0, 2), Vector2(3, 1)],
		]
		for seg: Array in segments:
			var bit: int = seg[0]
			var seg_ofs: Vector2 = seg[1]
			var seg_size: Vector2 = seg[2]
			if bits & (1 << bit):
				out.append(_rect(at + seg_ofs * sz, seg_size * sz))
	return out


func _rect(at: Vector2, size: Vector2) -> Array:
	return [at.x, at.y, size.x, size.y]


## Every page of every cache of the font with TextServer RID `rid` (not its fallbacks), sorted by
## (size, outline).
func _pages(ts: TextServer, key: String, rid: RID) -> Array[Dictionary]:
	var out: Array[Dictionary] = []
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
