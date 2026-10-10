class_name RsMeshPayload
extends RefCounted
## render-stream-mesh/1 (GRM1) payload decode and verification (render-stream-4.md "Mesh
## payload"). Pure: a PackedByteArray in, a decoded shape or an error out. Opens no file, makes
## no RenderingServer call -- this is the read side only; a payload is built elsewhere (the
## capture, G5a/G5e; golden-4's vectors build theirs directly in Python).
##
## Parallel to RsTexturePayload's decode()/make_image() for render-stream-texture/1 (GRT1): same
## framing style (magic, u32 meta_len, canonical JSON meta), but the mesh payload's "data"
## section is four concatenated buffers (vertex, attribute, skin, index) whose lengths come from
## the meta fields themselves, plus a fixed 40-byte geometry block (AABB + uv_scale) between meta
## and data that GRT1 does not have.

const GRM1_MAGIC_HEX: String = "47524d310d0a1a0a"
const META_KEYS: Array = [
	"type", "primitive", "format", "vertex_count", "index_count", "vertex_bytes",
	"attribute_bytes", "skin_bytes", "index_bytes",
]
const PRIMITIVES: Array = ["points", "lines", "line_strip", "triangles", "triangle_strip"]

## gate5-design.md Q1e / render-stream-4.md "Mesh payload": the ARRAY_FORMAT_*/ARRAY_FLAG_* bits
## this module needs to compute a surface's expected buffer sizes. `format` on the wire is an
## uninterpreted integer; these constants are only this module's own arithmetic.
const ARRAY_FORMAT_COLOR: int = 1 << 3
const ARRAY_FORMAT_TEX_UV: int = 1 << 4
const ARRAY_FORMAT_BONES: int = 1 << 10
const ARRAY_FORMAT_WEIGHTS: int = 1 << 11
const ARRAY_FORMAT_INDEX: int = 1 << 12
const ARRAY_FLAG_USE_8_BONE_WEIGHTS: int = 1 << 27


static func sha256_hex(bytes: PackedByteArray) -> String:
	var ctx := HashingContext.new()
	ctx.start(HashingContext.HASH_SHA256)
	ctx.update(bytes)
	return ctx.finish().hex_encode()


## render-stream-4.md "Mesh payload": the expected buffer lengths for a shape, from D7/Q1e's
## rules. `vertex_count` is "n".
static func expected_buffer_bytes(format: int, vertex_count: int, index_count: int) -> Dictionary:
	var n: int = vertex_count
	var vertex_bytes: int = 8 * n
	var attribute_bytes: int = n * ((4 if (format & ARRAY_FORMAT_COLOR) != 0 else 0) + (8 if (format & ARRAY_FORMAT_TEX_UV) != 0 else 0))
	var has_skin: bool = (format & ARRAY_FORMAT_BONES) != 0 and (format & ARRAY_FORMAT_WEIGHTS) != 0
	var skin_bytes: int = (n * (32 if (format & ARRAY_FLAG_USE_8_BONE_WEIGHTS) != 0 else 16)) if has_skin else 0
	var index_bytes: int = 0 if index_count == 0 else index_count * (2 if n <= 65536 else 4)
	return {
		"vertex_bytes": vertex_bytes, "attribute_bytes": attribute_bytes,
		"skin_bytes": skin_bytes, "index_bytes": index_bytes,
	}


## Decodes one payload. Returns {"ok": true, "primitive", "format", "vertex_count",
## "index_count", "vertex_bytes", "attribute_bytes", "skin_bytes", "index_bytes", "aabb":
## PackedFloat32Array(6), "uv_scale": PackedFloat32Array(4), "vertex_data", "attribute_data",
## "skin_data", "index_data": PackedByteArray} or {"ok": false, "code", "detail"}, `code` one of
## payload-magic, payload-meta, payload-length, payload-size.
static func decode(bytes: PackedByteArray) -> Dictionary:
	if bytes.size() < 8 or bytes.slice(0, 8).hex_encode() != GRM1_MAGIC_HEX:
		return {"ok": false, "code": "payload-magic", "detail": "the first 8 bytes are not the GRM1 magic"}
	if bytes.size() < 12:
		return {"ok": false, "code": "payload-length", "detail": "the payload ends inside the meta_len prefix"}
	var meta_len: int = bytes.decode_u32(8)
	if 12 + meta_len + 40 > bytes.size():
		return {"ok": false, "code": "payload-length", "detail": "meta_len and the geometry block run past the end of the payload"}
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
	var primitive_value: Variant = meta["primitive"]
	var format_value: Variant = meta["format"]
	var vertex_count_value: Variant = meta["vertex_count"]
	var index_count_value: Variant = meta["index_count"]
	var vertex_bytes_value: Variant = meta["vertex_bytes"]
	var attribute_bytes_value: Variant = meta["attribute_bytes"]
	var skin_bytes_value: Variant = meta["skin_bytes"]
	var index_bytes_value: Variant = meta["index_bytes"]
	if not (type_value is String and type_value == "mesh-surface"):
		return {"ok": false, "code": "payload-meta", "detail": "meta.type is not \"mesh-surface\""}
	if not (primitive_value is String and PRIMITIVES.has(primitive_value)):
		return {"ok": false, "code": "payload-meta", "detail": "meta.primitive is not a known primitive"}
	if not Rs2Decoder.is_int(format_value):
		return {"ok": false, "code": "payload-meta", "detail": "meta.format is not an integer"}
	if not (Rs2Decoder.is_int(vertex_count_value) and Rs2Decoder.as_int(vertex_count_value) >= 0):
		return {"ok": false, "code": "payload-meta", "detail": "meta.vertex_count is not a non-negative integer"}
	if not (Rs2Decoder.is_int(index_count_value) and Rs2Decoder.as_int(index_count_value) >= 0):
		return {"ok": false, "code": "payload-meta", "detail": "meta.index_count is not a non-negative integer"}
	if not (Rs2Decoder.is_int(vertex_bytes_value) and Rs2Decoder.as_int(vertex_bytes_value) >= 0):
		return {"ok": false, "code": "payload-meta", "detail": "meta.vertex_bytes is not a non-negative integer"}
	if not (Rs2Decoder.is_int(attribute_bytes_value) and Rs2Decoder.as_int(attribute_bytes_value) >= 0):
		return {"ok": false, "code": "payload-meta", "detail": "meta.attribute_bytes is not a non-negative integer"}
	if not (Rs2Decoder.is_int(skin_bytes_value) and Rs2Decoder.as_int(skin_bytes_value) >= 0):
		return {"ok": false, "code": "payload-meta", "detail": "meta.skin_bytes is not a non-negative integer"}
	if not (Rs2Decoder.is_int(index_bytes_value) and Rs2Decoder.as_int(index_bytes_value) >= 0):
		return {"ok": false, "code": "payload-meta", "detail": "meta.index_bytes is not a non-negative integer"}
	# No JSON.stringify() canonical-form re-check here, for the same reason RsTexturePayload.decode()
	# skips one: GDScript's JSON.stringify sorts keys and prints integers as floats, so it would
	# never match the canonical compact form a real payload carries. meta.keys() == META_KEYS
	# above already enforces the field order the canonical form requires.

	var primitive: String = primitive_value
	var format: int = Rs2Decoder.as_int(format_value)
	var vertex_count: int = Rs2Decoder.as_int(vertex_count_value)
	var index_count: int = Rs2Decoder.as_int(index_count_value)
	var vertex_bytes: int = Rs2Decoder.as_int(vertex_bytes_value)
	var attribute_bytes: int = Rs2Decoder.as_int(attribute_bytes_value)
	var skin_bytes: int = Rs2Decoder.as_int(skin_bytes_value)
	var index_bytes: int = Rs2Decoder.as_int(index_bytes_value)

	var geometry_offset: int = 12 + meta_len
	var aabb: PackedFloat32Array = bytes.slice(geometry_offset, geometry_offset + 24).to_float32_array()
	var uv_scale: PackedFloat32Array = bytes.slice(geometry_offset + 24, geometry_offset + 40).to_float32_array()

	var data_offset: int = geometry_offset + 40
	var declared_data_len: int = vertex_bytes + attribute_bytes + skin_bytes + index_bytes
	if data_offset + declared_data_len != bytes.size():
		return {"ok": false, "code": "payload-length", "detail": "the trailing bytes do not equal vertex_bytes+attribute_bytes+skin_bytes+index_bytes"}

	var expected: Dictionary = expected_buffer_bytes(format, vertex_count, index_count)
	if Rs2Decoder.as_int(expected["vertex_bytes"]) != vertex_bytes or Rs2Decoder.as_int(expected["attribute_bytes"]) != attribute_bytes or Rs2Decoder.as_int(expected["skin_bytes"]) != skin_bytes or Rs2Decoder.as_int(expected["index_bytes"]) != index_bytes:
		return {
			"ok": false, "code": "payload-size",
			"detail": "buffer lengths (%d, %d, %d, %d) disagree with the shape computed from format/vertex_count/index_count" % [vertex_bytes, attribute_bytes, skin_bytes, index_bytes],
		}

	var p: int = data_offset
	var vertex_data: PackedByteArray = bytes.slice(p, p + vertex_bytes)
	p += vertex_bytes
	var attribute_data: PackedByteArray = bytes.slice(p, p + attribute_bytes)
	p += attribute_bytes
	var skin_data: PackedByteArray = bytes.slice(p, p + skin_bytes)
	p += skin_bytes
	var index_data: PackedByteArray = bytes.slice(p, p + index_bytes)

	return {
		"ok": true, "primitive": primitive, "format": format, "vertex_count": vertex_count,
		"index_count": index_count, "vertex_bytes": vertex_bytes, "attribute_bytes": attribute_bytes,
		"skin_bytes": skin_bytes, "index_bytes": index_bytes, "aabb": aabb, "uv_scale": uv_scale,
		"vertex_data": vertex_data, "attribute_data": attribute_data, "skin_data": skin_data,
		"index_data": index_data,
	}
