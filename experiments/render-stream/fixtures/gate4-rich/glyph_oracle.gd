extends RefCounted
## The gate 4d RichTextLabel glyph oracle (../../protocol/gate4-design.md "Q6c", "G4d",
## `render-stream-gate4-glyphs/1`). Its own copy, independent of `fixtures/gate4/glyph_oracle.gd`
## and `fixtures/gate4-layout/glyph_oracle.gd` (concurrent increments each extend their own copy).
##
## Runs on reference legs only (gate4-rich.gd refuses it when a GRC_* capture variable is set). At
## each settle frame it writes one JSON line: every active BBCode span's glyph **set and count**,
## not quads (Q6c: "For RichTextLabel the oracle reports glyph sets and counts per span, not
## quads"), and every atlas page of every font cache with the `render-stream-texture/1` SHA-256 of
## its live CPU image. Page bytes go to `<log dir>/pages/<sha256>.grt` for the synthesizer.
##
## It does not introspect RichTextLabel's own `Item` tree at all. Instead it independently
## reshapes each span's own plain-text run with TextServer, using the span's own Font resource and
## size, mirroring `_font_draw_glyph`'s fill-pass glyph selection
## (modules/text_server_adv/text_server_adv.cpp:3922-4066) and -- when a span's `outline` > 0 --
## the separate `(size, outline)` bitmap-outline cache that `_font_draw_glyph_outline` draws from
## (ts_adv.h:417-425). The fixture builds the BBCode string and this span list from the same
## literal words (gate4-rich.gd `_spans_upto`), so the two cannot silently drift; `make_expected.py`
## is a third, independent derivation that must agree with both before anything is compared with
## the capture (D7).
##
## A span whose `outline` > 0 queries the outline cache instead of the fill cache and is reported
## under a cache key one letter longer (`font_key + "O"`, e.g. "FO"): the real engine keeps the
## outline cache on the *same* TextServer RID as the fill cache, keyed only by `(size, outline)`,
## so without this relabelling the two would collide under this file's (and gate4-checks.ts's)
## `cacheKeyOf`, which groups by `font_key@size` alone. The relabelling is this oracle's own
## bookkeeping, agreed with `make_expected.py`'s; it is not an engine cache key.
##
## It never calls `font_get_glyph_texture_rid` or `font_get_glyph_texture_size`: both upload a
## dirty page (Q1c). `font_get_texture_image` returns the live CPU image without side effects
## (ts_adv:3081-3093).
##
## Its own GRT1 encoder below is deliberately not shared with the capture (C++) or any fixture:
## independent encoders that agree are evidence.

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


## One line for the settle frame of `step`. `spans` is gate4-rich.gd's `_spans_upto(step)`
## (ordered dictionaries: key, font, font_key, size, text, colour, bgcolor, outline). `font_keys`
## maps a key ("F", "FB", "FI") to its Font, for the page census.
func record_rich(step: int, frame: int, spans: Array[Dictionary], font_keys: Dictionary) -> void:
	var ts: TextServer = TextServerManager.get_primary_interface()
	var out_spans: Array[Dictionary] = []
	for span: Dictionary in spans:
		out_spans.append(_span(ts, span, 0))
		var outline_size: int = span["outline"]
		if outline_size > 0:
			# The engine draws an outlined span's fill pass (above, cache (size, 0)) *and* a
			# separate outline pass from its own (size, outline) cache (_font_draw_glyph_outline,
			# Q1b); both entries share the fixture's `key` so a checker can group them.
			out_spans.append(_span(ts, span, outline_size))
	var pages: Array[Dictionary] = []
	for key: String in font_keys:
		var font: Font = font_keys[key]
		pages.append_array(_pages(ts, key, font))
	var line: Dictionary = {
		"schema": "render-stream-gate4-glyphs/1",
		"step": step,
		"frame": frame,
		"spans": out_spans,
		"pages": pages,
	}
	_file.store_line(JSON.stringify(line, "", false, true))
	_file.flush()


## One span's glyph set/count and the cache (relabelled `font_key`) its glyphs would draw from at
## `want_outline` (0 for the fill pass, or the span's own `outline` for the outline pass),
## re-shaping the span's own plain text with its own Font and size (no RichTextLabel introspection).
func _span(ts: TextServer, span: Dictionary, want_outline: int) -> Dictionary:
	var font: Font = span["font"]
	var font_size: int = span["size"]
	var text: String = span["text"]
	var rids: Array[RID] = font.get_rids()

	var para: RID = ts.create_shaped_text()
	ts.shaped_text_set_direction(para, TextServer.DIRECTION_LTR)
	ts.shaped_text_add_string(para, text, rids, font_size, font.get_opentype_features(), "")
	var glyph_indices: Array[int] = []
	var glyph_count: int = 0
	var page: int = -1
	for glyph: Dictionary in ts.shaped_text_get_glyphs(para):
		var repeat: int = glyph["repeat"]
		var index: int = glyph["index"]
		var glyph_font: RID = glyph["font_rid"]
		var glyph_size: int = glyph["font_size"]
		if index == 0 or not glyph_font.is_valid():
			continue
		var size_key := Vector2i(glyph_size, want_outline)
		var p: int = ts.font_get_glyph_texture_idx(glyph_font, size_key, index)
		if p < 0:
			continue
		for _r: int in range(repeat):
			glyph_count += 1
			if not glyph_indices.has(index):
				glyph_indices.append(index)
		if page < 0:
			page = p
	ts.free_rid(para)
	glyph_indices.sort()

	var base_key: String = span["font_key"]
	var cache_key: String = base_key if want_outline == 0 else (base_key + "O")
	return {
		"key": span["key"],
		"font_key": cache_key,
		"size": font_size,
		"glyph_count": glyph_count,
		"glyph_indices": glyph_indices,
		"page": page,
	}


## Every page of every size cache on `font`'s RID(s), under `key` (or `key + "O"` for an outline
## cache: see the header). Mirrors fixtures/gate4/glyph_oracle.gd's `_pages`, generalized to more
## than one font key and the outline relabelling.
func _pages(ts: TextServer, key: String, font: Font) -> Array[Dictionary]:
	var out: Array[Dictionary] = []
	for rid: RID in font.get_rids():
		var sizes: Array[Vector2i] = []
		for size: Vector2i in ts.font_get_size_cache_list(rid):
			sizes.append(size)
		sizes.sort()
		for size: Vector2i in sizes:
			var cache_key: String = key if size.y == 0 else (key + "O")
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
					"font_key": cache_key,
					"size": size.x,
					"outline": 0,
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
