class_name RsShaderPayload
extends RefCounted
## render-stream-shader/1 (GRP1) payload decode and verification (render-stream-5.md "Shader
## payload"). Pure: a PackedByteArray in, a decoded shape or an error out. Opens no file, makes
## no RenderingServer call -- this is the read side only; a payload is built elsewhere (the
## capture, G55a; golden-5's vectors build theirs directly in Python).
##
## Parallel to RsMeshPayload's decode() for render-stream-mesh/1 (GRM1): same framing style
## (magic, u32 meta_len, canonical JSON meta), but GRP1's "data" section is just the shader's
## code as UTF-8 -- no 40-byte geometry block (GRM1 has one), no separate data_len (GRT1 has
## one): the payload simply ends where meta.code_bytes says it does.

const GRP1_MAGIC_HEX: String = "475250310d0a1a0a"
const META_KEYS: Array = ["type", "code_bytes"]


static func sha256_hex(bytes: PackedByteArray) -> String:
	var ctx := HashingContext.new()
	ctx.start(HashingContext.HASH_SHA256)
	ctx.update(bytes)
	return ctx.finish().hex_encode()


## Decodes one payload. Returns {"ok": true, "code_bytes": int, "code": String} or
## {"ok": false, "code", "detail"}, `code` one of payload-magic, payload-meta, payload-length,
## payload-utf8.
static func decode(bytes: PackedByteArray) -> Dictionary:
	if bytes.size() < 8 or bytes.slice(0, 8).hex_encode() != GRP1_MAGIC_HEX:
		return {"ok": false, "code": "payload-magic", "detail": "the first 8 bytes are not the GRP1 magic"}
	if bytes.size() < 12:
		return {"ok": false, "code": "payload-length", "detail": "the payload ends inside the meta_len prefix"}
	var meta_len: int = bytes.decode_u32(8)
	if 12 + meta_len > bytes.size():
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
	var code_bytes_value: Variant = meta["code_bytes"]
	if not (type_value is String and type_value == "shader-code"):
		return {"ok": false, "code": "payload-meta", "detail": "meta.type is not \"shader-code\""}
	if not Rs2Decoder.is_int(code_bytes_value):
		return {"ok": false, "code": "payload-meta", "detail": "meta.code_bytes is not an integer"}
	var code_bytes: int = Rs2Decoder.as_int(code_bytes_value)
	if code_bytes < 0:
		return {"ok": false, "code": "payload-meta", "detail": "meta.code_bytes is negative"}

	var data_offset: int = 12 + meta_len
	if data_offset + code_bytes != bytes.size():
		return {"ok": false, "code": "payload-length", "detail": "the trailing bytes do not equal meta.code_bytes"}
	var data: PackedByteArray = bytes.slice(data_offset, data_offset + code_bytes)
	var code: String = data.get_string_from_utf8()
	# PackedByteArray.get_string_from_utf8() silently replaces invalid sequences rather than
	# failing, so invalid UTF-8 is detected by re-encoding the decoded string and checking the
	# byte count round-trips exactly.
	if code.to_utf8_buffer().size() != code_bytes:
		return {"ok": false, "code": "payload-utf8", "detail": "the code bytes are not valid UTF-8"}
	return {"ok": true, "code_bytes": code_bytes, "code": code}
