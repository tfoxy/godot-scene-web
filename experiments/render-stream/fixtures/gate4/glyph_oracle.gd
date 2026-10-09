extends RefCounted
## The gate 4 glyph oracle (../../protocol/gate4-design.md "Q6c", `render-stream-gate4-glyphs/1`).
##
## Runs on reference legs only (gate4.gd refuses it when a GRC_* capture variable is set). At each
## settle frame it writes one JSON line: every visible text node's glyphs in draw order, each with
## the quad and source rect the engine's own `_font_draw_glyph` would compute
## (modules/text_server_adv/text_server_adv.cpp:4027-4061), and every atlas page of every font
## cache with the `render-stream-texture/1` SHA-256 of its live CPU image. Page bytes go to
## `<log dir>/pages/<sha256>.grt` for the synthesizer.
##
## It reproduces Label's single-line, left-aligned draw (scene/gui/label.cpp:725-886,
## label.h:197-250): the paragraph is the text plus U+200B (label.cpp:160-163), shaped with the
## Label's font RIDs, size, OpenType features and language; the line comes from
## `shaped_text_get_line_breaks` + `shaped_text_substr` with no autowrap; the pen starts at x 0 and
## y = ascent, raised to the font height when ascent + descent is short (label.cpp:799-816); each
## glyph is drawn at pen + offset, floored at scale 1, plus the glyph's offset (bearing - margin).
##
## It never calls `font_get_glyph_texture_rid` or `font_get_glyph_texture_size`: both upload a
## dirty page (Q1c). It never shapes a hidden node. `font_get_texture_image` returns the live CPU
## image without side effects (text_server_adv.cpp:3081-3093).
##
## Its own GRT1 encoder below is deliberately not shared with the capture (C++) or the gate 2
## fixture: two encoders that agree are evidence.

## Image.Format identifiers without FORMAT_, in enum order (core/io/image.h:75-114).
const FORMAT_NAMES: Array[String] = [
	"L8", "LA8", "R8", "RG8", "RGB8", "RGBA8", "RGBA4444", "RGB565", "RF", "RGF", "RGBF", "RGBAF",
	"RH", "RGH", "RGBH", "RGBAH", "RGBE9995", "DXT1", "DXT3", "DXT5", "RGTC_R", "RGTC_RG",
	"BPTC_RGBA", "BPTC_RGBF", "BPTC_RGBFU", "ETC", "ETC2_R11", "ETC2_R11S", "ETC2_RG11",
	"ETC2_RG11S", "ETC2_RGB8", "ETC2_RGBA8", "ETC2_RGB8A1", "ETC2_RA_AS_RG", "DXT5_RA_AS_RG",
	"ASTC_4x4", "ASTC_4x4_HDR", "ASTC_8x8", "ASTC_8x8_HDR",
]

var _file: FileAccess
var _pages_dir: String = ""
var _written: Dictionary = {}


func open(path: String) -> bool:
	_file = FileAccess.open(path, FileAccess.WRITE)
	if _file == null:
		return false
	_pages_dir = path.get_base_dir().path_join("pages")
	return DirAccess.make_dir_recursive_absolute(_pages_dir) == OK


## One line for the settle frame of `step`. `font_keys` maps a key ("F", "DF") to its Font.
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
	for key: String in ["F", "DF"]:
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


func _node(ts: TextServer, label: Label, key_of_rid: Dictionary) -> Dictionary:
	var font: Font = label.get_theme_font("font")
	var font_size: int = label.get_theme_font_size("font_size")
	var colour: Color = label.get_theme_color("font_color")
	var rids: Array[RID] = font.get_rids()
	var font_key: String = key_of_rid.get(rids[0], "?")
	var xf: Transform2D = label.get_global_transform()

	var para: RID = ts.create_shaped_text()
	ts.shaped_text_set_direction(para, TextServer.DIRECTION_LTR)
	ts.shaped_text_add_string(para, label.text + String.chr(0x200B), rids, font_size, font.get_opentype_features(), label.language)
	var width: float = label.size.x
	var breaks: PackedInt32Array = ts.shaped_text_get_line_breaks(para, width, 0, TextServer.BREAK_MANDATORY | label.autowrap_trim_flags)
	var glyphs_out: Array[Dictionary] = []
	var shaped: int = 0
	var font_h: float = font.get_height(font_size)
	var ascent: float = 0.0
	var lines: int = 0
	var i: int = 0
	while i < breaks.size():
		var line: RID = ts.shaped_text_substr(para, breaks[i], breaks[i + 1] - breaks[i])
		lines += 1
		var asc: float = ts.shaped_text_get_ascent(line)
		var dsc: float = ts.shaped_text_get_descent(line)
		if asc + dsc < font_h:
			var diff: float = font_h - (asc + dsc)
			asc += diff / 2
		ascent = asc
		var pen := Vector2(0, asc)
		for glyph: Dictionary in ts.shaped_text_get_glyphs(line):
			shaped += 1
			var repeat: int = glyph["repeat"]
			var advance: float = glyph["advance"]
			var offset: Vector2 = glyph["offset"]
			var glyph_font: RID = glyph["font_rid"]
			var glyph_size: int = glyph["font_size"]
			var index: int = glyph["index"]
			for _r: int in range(repeat):
				var pos: Vector2 = pen + offset
				var entry: Dictionary = _glyph(ts, glyph_font, glyph_size, index, pos, key_of_rid)
				if not entry.is_empty():
					glyphs_out.append(entry)
				pen.x += advance
		ts.free_rid(line)
		i += 2
	ts.free_rid(para)
	return {
		"name": String(label.name),
		"text": label.text,
		"font_key": font_key,
		"size": font_size,
		"colour": [colour.r, colour.g, colour.b, colour.a],
		"global_xform": [xf.x.x, xf.x.y, xf.y.x, xf.y.y, xf.origin.x, xf.origin.y],
		"font_height": font_h,
		"ascent": ascent,
		"lines": lines,
		"shaped_glyphs": shaped,
		"glyphs": glyphs_out,
	}


## The command `_font_draw_glyph` makes for one glyph at `pos`, or {} when it makes none (index 0,
## no font, or an empty bitmap: texture_idx -1).
func _glyph(ts: TextServer, font_rid: RID, font_size: int, index: int, pos: Vector2, key_of_rid: Dictionary) -> Dictionary:
	if index == 0 or not font_rid.is_valid():
		return {}
	var size := Vector2i(font_size, 0)
	var page: int = ts.font_get_glyph_texture_idx(font_rid, size, index)
	if page < 0:
		return {}
	var gpos: Vector2 = ts.font_get_glyph_offset(font_rid, size, index)
	var gsize: Vector2 = ts.font_get_glyph_size(font_rid, size, index)
	var uv: Rect2 = ts.font_get_glyph_uv_rect(font_rid, size, index)
	var cpos := Vector2(floorf(pos.x), floorf(pos.y)) + gpos
	return {
		"index": index,
		"font_key": key_of_rid.get(font_rid, "?"),
		"size": font_size,
		"x": pos.x,
		"y": pos.y,
		"quad": [cpos.x, cpos.y, gsize.x, gsize.y],
		"uv": [uv.position.x, uv.position.y, uv.size.x, uv.size.y],
		"page": page,
	}


func _pages(ts: TextServer, key: String, font: Font) -> Array[Dictionary]:
	var out: Array[Dictionary] = []
	for rid: RID in font.get_rids():
		var sizes: Array[Vector2i] = []
		for size: Vector2i in ts.font_get_size_cache_list(rid):
			sizes.append(size)
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
