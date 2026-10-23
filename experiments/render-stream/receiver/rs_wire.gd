class_name RsWire
extends RefCounted
## The receiver's wire glue (G7gd): record framing, the magics and protocol names, and the small
## helpers every receiver script shares. Decoding, validation, patch resolution and apply are the
## shared Rust core's (rs-core through RsCore, rs_rust_applier.gd); this file only finds where
## each record of a recording or a live message starts and ends, so receiver.gd can hand the core
## one record at a time. G7gd removed the GDScript decoder (Rs2Decoder) this was cut from.
##
## Errors are render-stream "<code>: <detail>" strings (render-stream-0.md "Framing").
##
## JSON.parse returns every number as a float. Every wire integer is below 2^53, so an integer is
## accepted only when it is finite, integral and within +-(2^53 - 1), then converted with int().

## The GRS2 to GRS8 magics (render-stream-2.md to render-stream-7.md), by wire version.
const MAGIC_HEX_BY_VERSION: Dictionary[int, String] = {
	2: "475253320d0a1a0a",
	3: "475253330d0a1a0a",
	4: "475253340d0a1a0a",
	5: "475253350d0a1a0a",
	6: "475253360d0a1a0a",
	7: "475253370d0a1a0a",
	8: "475253380d0a1a0a",
}
const MAGIC_V7_HEX: String = "475253370d0a1a0a"
## G8t: render-stream/8 files (gate 8 recordings, render-stream-8.md) replay at /8.
const MAGIC_V8_HEX: String = "475253380d0a1a0a"
const PROTOCOL_V7: String = "render-stream/7"
const MAX_SAFE_INT: float = 9007199254740991.0


static func err(code: String, detail: String) -> String:
	return code + ": " + detail


static func code_of(error: String) -> String:
	var colon: int = error.find(":")
	return error if colon < 0 else error.substr(0, colon)


static func is_int(value: Variant) -> bool:
	var kind: int = typeof(value)
	if kind == TYPE_INT:
		return true
	if kind != TYPE_FLOAT:
		return false
	var number: float = value
	return is_finite(number) and number == floorf(number) and absf(number) <= MAX_SAFE_INT


static func as_int(value: Variant) -> int:
	if typeof(value) == TYPE_INT:
		var whole: int = value
		return whole
	var number: float = value
	return int(number)


static func int_list(values: Variant) -> Array[int]:
	var source: Array = values
	var out: Array[int] = []
	for value: Variant in source:
		out.append(as_int(value))
	return out


static func sha256_hex(bytes: PackedByteArray) -> String:
	var ctx := HashingContext.new()
	ctx.start(HashingContext.HASH_SHA256)
	ctx.update(bytes)
	return ctx.finish().hex_encode()


## One record's frame at `offset`: {error, end, meta_start, meta_len, blocks: [[start, len]...]}.
static func _frame(data: PackedByteArray, offset: int) -> Dictionary:
	var out: Dictionary = {"error": "", "end": 0, "meta_start": 0, "meta_len": 0, "blocks": []}
	var size: int = data.size()
	if offset + 4 > size:
		out["error"] = err("truncated", "record length prefix at offset %d runs past the end of the input (%d bytes)" % [offset, size])
		return out
	var record_len: int = data.decode_u32(offset)
	var end: int = offset + 4 + record_len
	if end > size:
		out["error"] = err("truncated", "record at offset %d declares record_len %d, which runs past the end of the input (%d bytes)" % [offset, record_len, size])
		return out
	out["end"] = end
	var p: int = offset + 4
	if p + 4 > end:
		out["error"] = err("record-length", "record at offset %d: record_len %d has no room for meta_len" % [offset, record_len])
		return out
	var meta_len: int = data.decode_u32(p)
	p += 4
	if p + meta_len + 4 > end:
		out["error"] = err("record-length", "record at offset %d: meta_len %d and block_count overrun record_len %d" % [offset, meta_len, record_len])
		return out
	out["meta_start"] = p
	out["meta_len"] = meta_len
	p += meta_len
	var block_count: int = data.decode_u32(p)
	p += 4
	var blocks: Array = []
	for i: int in block_count:
		if p + 4 > end:
			out["error"] = err("record-length", "record at offset %d: block %d length prefix overruns record_len %d" % [offset, i, record_len])
			return out
		var block_len: int = data.decode_u32(p)
		p += 4
		if p + block_len > end:
			out["error"] = err("record-length", "record at offset %d: block %d (%d bytes) overruns record_len %d" % [offset, i, block_len, record_len])
			return out
		blocks.append([p, block_len])
		p += block_len
	if p != end:
		out["error"] = err("record-length", "record at offset %d: parts add up to %d bytes, record_len is %d" % [offset, p - offset - 4, record_len])
		return out
	out["blocks"] = blocks
	return out


## Splits a recording (or a live stream's first message) into records: {records: [{offset,
## byte_length}], errors, framed_to}. `version` (2 to 7) selects the expected magic; every other
## magic is refused with bad-magic. The receiver itself speaks /6 (files) and /7 (a /7 live
## connection and its received.rs7 replay); the rest frame the golden vectors in the self-test.
static func split_records(data: PackedByteArray, version: int = 6) -> Dictionary:
	var records: Array[Dictionary] = []
	var errors := PackedStringArray()
	var expected_magic: String = MAGIC_HEX_BY_VERSION[version] if MAGIC_HEX_BY_VERSION.has(version) else MAGIC_HEX_BY_VERSION[2]
	if data.size() < 8 or data.slice(0, 8).hex_encode() != expected_magic:
		errors.append(err("bad-magic", "first 8 bytes are %s, expected %s" % [data.slice(0, 8).hex_encode(), expected_magic]))
		return {"records": records, "errors": errors, "framed_to": 0}
	var pos: int = 8
	while pos < data.size():
		var frame: Dictionary = _frame(data, pos)
		var problem: String = frame["error"]
		if problem != "":
			errors.append(problem)
			break
		var end: int = frame["end"]
		records.append({"offset": pos, "byte_length": end - pos})
		pos = end
	return {"records": records, "errors": errors, "framed_to": pos}
