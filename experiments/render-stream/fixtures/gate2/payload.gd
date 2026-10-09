extends RefCounted
## The gate 2 fixture's own `render-stream-texture/1` encoder (render-stream-2.md "Texture
## payload"): it builds the canonical GRT1 bytes of an `Image` and hashes them with
## `HashingContext` SHA-256, so the fixture's texture log carries an independent
## `payload_sha256` for every create and update it makes. The checker compares those hashes with
## the ones the capture computed at the hook (C++), which is the `hook-bytes-exact` check.
##
## Deliberately not shared with the receiver (gate2-design.md Q6 "Fixture environment"): two
## encoders that agree are evidence; one encoder used twice is not.
##
##   magic      8 bytes   47 52 54 31 0D 0A 1A 0A
##   u32le      meta_len
##   meta       {"type":"texture-2d","format":<name>,"width":<int>,"height":<int>,
##              "mipmaps":<bool>,"data_bytes":<int>}
##   u32le      data_len
##   data       Image.get_data()

## Image.Format identifiers without FORMAT_, in enum order (core/io/image.h:75-114).
const FORMAT_NAMES: Array[String] = [
	"L8", "LA8", "R8", "RG8", "RGB8", "RGBA8", "RGBA4444", "RGB565", "RF", "RGF", "RGBF", "RGBAF",
	"RH", "RGH", "RGBH", "RGBAH", "RGBE9995", "DXT1", "DXT3", "DXT5", "RGTC_R", "RGTC_RG",
	"BPTC_RGBA", "BPTC_RGBF", "BPTC_RGBFU", "ETC", "ETC2_R11", "ETC2_R11S", "ETC2_RG11",
	"ETC2_RG11S", "ETC2_RGB8", "ETC2_RGBA8", "ETC2_RGB8A1", "ETC2_RA_AS_RG", "DXT5_RA_AS_RG",
	"ASTC_4x4", "ASTC_4x4_HDR", "ASTC_8x8", "ASTC_8x8_HDR",
]


static func format_name(image: Image) -> String:
	return FORMAT_NAMES[int(image.get_format())]


## The canonical payload of `image` as it is now.
static func encode(image: Image) -> PackedByteArray:
	var data: PackedByteArray = image.get_data()
	var meta: String = "{\"type\":\"texture-2d\",\"format\":\"%s\",\"width\":%d,\"height\":%d,\"mipmaps\":%s,\"data_bytes\":%d}" % [
		format_name(image), image.get_width(), image.get_height(),
		"true" if image.has_mipmaps() else "false", data.size(),
	]
	var meta_bytes: PackedByteArray = meta.to_ascii_buffer()
	var out := PackedByteArray([0x47, 0x52, 0x54, 0x31, 0x0D, 0x0A, 0x1A, 0x0A])
	out.append_array(_u32le(meta_bytes.size()))
	out.append_array(meta_bytes)
	out.append_array(_u32le(data.size()))
	out.append_array(data)
	return out


static func sha256_hex(bytes: PackedByteArray) -> String:
	var context := HashingContext.new()
	context.start(HashingContext.HASH_SHA256)
	context.update(bytes)
	return context.finish().hex_encode()


## The log fields of `image` (format, size, mipmaps, data bytes, payload SHA-256), read before
## anything mutates it.
static func describe(image: Image) -> Dictionary:
	return {
		"format": format_name(image),
		"width": image.get_width(),
		"height": image.get_height(),
		"mipmaps": image.has_mipmaps(),
		"data_bytes": image.get_data_size(),
		"payload_sha256": sha256_hex(encode(image)),
	}


static func _u32le(value: int) -> PackedByteArray:
	return PackedByteArray([value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >> 24) & 0xff])
