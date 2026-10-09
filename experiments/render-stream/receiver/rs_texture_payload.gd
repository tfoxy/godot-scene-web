class_name RsTexturePayload
extends RefCounted
## render-stream-texture/1 payload decode and verification (protocol/render-stream-2.md "Texture
## payload"). Pure: a PackedByteArray in, a decoded shape or an error out. Opens no file, makes
## no RenderingServer call -- this is the read side only; a payload is built elsewhere (the
## capture's rs_texture_payload, G2a).
##
## The receiver (G2b2) uses decode() on a fetched/cached/inline payload, then make_image() to get
## an Image it can hand to texture_2d_create()/update().

const GRT1_MAGIC_HEX: String = "475254310d0a1a0a"
const META_KEYS: Array = ["type", "format", "width", "height", "mipmaps", "data_bytes"]

## format name -> bytes/texel, for the six permitted uncompressed formats (render-stream-2.md
## "Texture payload"). Any other Image.Format name is a legal `format` string on an unsupported
## table entry, but no expected size is ever computed for it.
const PIXEL_SIZES: Dictionary[String, int] = {
	"L8": 1, "LA8": 2, "R8": 1, "RG8": 2, "RGB8": 3, "RGBA8": 4,
}

## format name -> Image.Format, for the six permitted formats (the only ones make_image() builds).
const IMAGE_FORMATS: Dictionary[String, int] = {
	"L8": Image.FORMAT_L8, "LA8": Image.FORMAT_LA8, "R8": Image.FORMAT_R8,
	"RG8": Image.FORMAT_RG8, "RGB8": Image.FORMAT_RGB8, "RGBA8": Image.FORMAT_RGBA8,
}


static func sha256_hex(bytes: PackedByteArray) -> String:
	var ctx := HashingContext.new()
	ctx.start(HashingContext.HASH_SHA256)
	ctx.update(bytes)
	return ctx.finish().hex_encode()


## -1 when `format` is not one of the six permitted formats.
static func expected_data_bytes(format: String, width: int, height: int, mipmaps: bool) -> int:
	if not PIXEL_SIZES.has(format):
		return -1
	var pixel_size: int = PIXEL_SIZES[format]
	var w: int = width
	var h: int = height
	var total: int = w * h
	if mipmaps:
		while w > 1 or h > 1:
			w = maxi(1, w / 2)
			h = maxi(1, h / 2)
			total += w * h
	return pixel_size * total


## Decodes one payload. Returns {"ok": true, "format", "width", "height", "mipmaps", "data":
## PackedByteArray} or {"ok": false, "code", "detail"}, `code` one of payload-magic, payload-meta,
## payload-length, payload-size.
static func decode(bytes: PackedByteArray) -> Dictionary:
	if bytes.size() < 16 or bytes.slice(0, 8).hex_encode() != GRT1_MAGIC_HEX:
		return {"ok": false, "code": "payload-magic", "detail": "the first 8 bytes are not the GRT1 magic"}
	var meta_len: int = bytes.decode_u32(8)
	if 12 + meta_len + 4 > bytes.size():
		return {"ok": false, "code": "payload-length", "detail": "meta_len runs past the end of the payload"}
	var meta_bytes: PackedByteArray = bytes.slice(12, 12 + meta_len)
	for i: int in meta_bytes.size():
		var b: int = meta_bytes[i]
		if b < 0x20 or b > 0x7e:
			return {"ok": false, "code": "payload-meta", "detail": "meta byte %d is not printable ASCII" % i}
	var json := JSON.new()
	if json.parse(meta_bytes.get_string_from_ascii()) != OK:
		return {"ok": false, "code": "payload-meta", "detail": json.get_error_message()}
	var parsed: Variant = json.data
	if typeof(parsed) != TYPE_DICTIONARY:
		return {"ok": false, "code": "payload-meta", "detail": "meta is not a JSON object"}
	var meta: Dictionary = parsed
	if meta.keys() != META_KEYS:
		return {"ok": false, "code": "payload-meta", "detail": "meta has the wrong keys or order"}
	var type_value: Variant = meta["type"]
	var format_value: Variant = meta["format"]
	var width_value: Variant = meta["width"]
	var height_value: Variant = meta["height"]
	var mipmaps_value: Variant = meta["mipmaps"]
	var data_bytes_value: Variant = meta["data_bytes"]
	if not (type_value is String and type_value == "texture-2d"):
		return {"ok": false, "code": "payload-meta", "detail": "meta.type is not \"texture-2d\""}
	if not (format_value is String):
		return {"ok": false, "code": "payload-meta", "detail": "meta.format is not a string"}
	if not (Rs2Decoder.is_int(width_value) and Rs2Decoder.as_int(width_value) >= 1):
		return {"ok": false, "code": "payload-meta", "detail": "meta.width is not an integer >= 1"}
	if not (Rs2Decoder.is_int(height_value) and Rs2Decoder.as_int(height_value) >= 1):
		return {"ok": false, "code": "payload-meta", "detail": "meta.height is not an integer >= 1"}
	if typeof(mipmaps_value) != TYPE_BOOL:
		return {"ok": false, "code": "payload-meta", "detail": "meta.mipmaps is not a boolean"}
	if not (Rs2Decoder.is_int(data_bytes_value) and Rs2Decoder.as_int(data_bytes_value) >= 0):
		return {"ok": false, "code": "payload-meta", "detail": "meta.data_bytes is not a non-negative integer"}
	# No JSON.stringify() canonical-form re-check here: GDScript's JSON.stringify sorts keys and
	# prints integers as floats (Rs2Decoder's own doc comment, and rs1_decoder.gd's precedent), so
	# it would never match the canonical compact form a real payload carries. meta.keys() ==
	# META_KEYS above already enforces the field order the canonical form requires.

	var format: String = format_value
	var width: int = Rs2Decoder.as_int(width_value)
	var height: int = Rs2Decoder.as_int(height_value)
	var mipmaps: bool = mipmaps_value
	var data_bytes: int = Rs2Decoder.as_int(data_bytes_value)

	var data_len_offset: int = 12 + meta_len
	var data_len: int = bytes.decode_u32(data_len_offset)
	if data_len != data_bytes:
		return {"ok": false, "code": "payload-length", "detail": "data_len disagrees with meta.data_bytes"}
	var data_offset: int = data_len_offset + 4
	if data_offset + data_len != bytes.size():
		return {"ok": false, "code": "payload-length", "detail": "the trailing bytes do not equal data_len"}

	var expected: int = expected_data_bytes(format, width, height, mipmaps)
	if expected >= 0 and expected != data_len:
		return {
			"ok": false, "code": "payload-size",
			"detail": "data_bytes is %d, expected %d for %s %dx%d mipmaps=%s" % [data_len, expected, format, width, height, mipmaps],
		}

	return {
		"ok": true, "format": format, "width": width, "height": height, "mipmaps": mipmaps,
		"data": bytes.slice(data_offset, data_offset + data_len),
	}


## An Image rebuilt from a successfully decode()d payload, for the six permitted formats. Returns
## null if `format` is not one of them (should not happen for a payload that decoded with no
## payload-size error, since that check only fires for permitted formats, but a capture-side
## policy change could in principle carry a payload for an unpermitted format).
static func make_image(decoded: Dictionary) -> Image:
	var format: String = decoded["format"]
	if not IMAGE_FORMATS.has(format):
		return null
	var image_format: int = IMAGE_FORMATS[format]
	var width: int = decoded["width"]
	var height: int = decoded["height"]
	var mipmaps: bool = decoded["mipmaps"]
	var data: PackedByteArray = decoded["data"]
	return Image.create_from_data(width, height, mipmaps, image_format, data)
