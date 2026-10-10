class_name Rs2Decoder
extends RefCounted
## render-stream/2 decoder and validator (protocol/render-stream-2.md). render-stream/2 is
## render-stream/1 plus textures.
##
## Pure: a PackedByteArray in, records and "<code>: <detail>" strings out. It opens no file and
## makes no RenderingServer call. Framing, canonical-JSON rules and most error codes are
## unchanged from render-stream-0.md and render-stream-1.md; this file was written independently
## of the gate 1 decoder (Rs1Decoder), matching rs2_codec.cpp's independence from rs1_codec.cpp.
##
## `Stream` (below) holds the resolved state as each transaction is accepted, now including
## `textures` (a Dictionary[int, Dictionary] keyed by wire id, same shape as the wire's texture
## entry) alongside `canvases`/`items`. It also tracks resource records: which hashes have been
## carried so far in this stream, and the decoded shape of each (for resource-payload), so that
## resource-missing/resource-hash/resource-duplicate/resource-payload can be checked as the
## stream is walked.
##
## JSON.parse returns every number as a float. Every wire integer is below 2^53, so an integer is
## accepted only when it is finite, integral and within +-(2^53 - 1), then converted with int().

const MAGIC_HEX: String = "475253320d0a1a0a"
## render-stream-3.md (G4e1): the GRS3 magic, selected by `version == 3` on split_records()/
## validate_recording(). /3 is implemented IN THIS SAME FILE behind that parameter, rather than a
## forked Rs3Decoder, because it is only one new command and one new sabotage kind on top of /2
## (gate4-design.md G4e1: "Renaming files is not part of this contract").
const MAGIC_V3_HEX: String = "475253330d0a1a0a"
## render-stream-4.md (G5w): the GRS4 magic, selected by `version == 4`. /4 is implemented IN
## THIS SAME FILE behind that parameter too (render-stream-4.md, following gate4-design.md
## G4e1's precedent): eleven new commands, a mesh table and the cmd_i32 block.
const MAGIC_V4_HEX: String = "475253340d0a1a0a"
const PROTOCOL: String = "render-stream/2"
const PROTOCOL_V3: String = "render-stream/3"
const PROTOCOL_V4: String = "render-stream/4"
const MAX_SAFE_INT: float = 9007199254740991.0
const U32_MAX: float = 4294967295.0
const ITEM_FLOATS: int = 18
const CANVAS_FLOATS: int = 6

const SESSION_KEYS: Array = [
	"type", "protocol", "session_id", "stream", "engine", "capture", "viewport", "resources",
	"features", "sabotage", "blocks",
]
const STREAM_KEYS: Array = ["stream_id", "connection", "transport", "encoding"]
const TRANSPORTS: Array = ["file", "websocket"]
const ENCODINGS: Array = ["full", "patch"]
const ENGINE_KEYS: Array = [
	"version_string", "sha256", "display_server", "rendering_driver", "rendering_method",
]
const CAPTURE_KEYS: Array = ["calibrator_version", "hooks_planned", "hooks_omitted"]
const VIEWPORT_KEYS: Array = [
	"canvas_cull_mask", "root_canvas", "logical_size", "stretch", "stretch_applied_by",
	"root_size_policy", "host_size_status", "host_window_size",
]
const STRETCH_KEYS: Array = ["mode", "aspect", "scale_mode"]
const STRETCH_MODES: Array = ["disabled", "canvas_items", "viewport"]
const STRETCH_ASPECTS: Array = ["ignore", "keep", "keep_width", "keep_height", "expand"]
const SCALE_MODES: Array = ["fractional", "integer"]
const ROOT_SIZE_POLICIES: Array = ["observe", "enforce-min-size"]
const HOST_SIZE_STATUSES: Array = ["match", "degenerate-visible", "degenerate-window"]
const RESOURCES_KEYS: Array = [
	"hash", "payload", "delivery", "inline_max_bytes", "max_payload_bytes", "permitted_formats",
	"fetch", "http_path", "auth",
]
## render-stream-4.md "Resources": "payload" (a string) becomes "payloads" (a sorted array) at /4.
const RESOURCES_KEYS_V4: Array = [
	"hash", "payloads", "delivery", "inline_max_bytes", "max_payload_bytes", "permitted_formats",
	"fetch", "http_path", "auth",
]
const MESH_PAYLOAD_SCHEMA: String = "render-stream-mesh/1"
const DELIVERIES: Array = ["out-of-band", "inline", "mixed"]
const FETCHES: Array = ["http", "directory", "none"]
const AUTHS: Array = ["none", "bearer"]
const FEATURES_KEYS: Array = [
	"ops", "item_state", "resources", "unsupported_resources", "observed_unsupported_ops",
	"unobserved", "publication",
]
## features.unsupported_resources entries (G2d): a resource kind the host refuses, and why.
const UNSUPPORTED_RESOURCE_KEYS: Array = ["resource", "reason"]
const UNSUPPORTED_RESOURCE_REASONS: Array = ["canvas-texture-headless"]
const PUBLICATION: String = "snapshot-or-patch"
const SABOTAGE_KEYS: Array = ["kind", "frame", "op"]
const SABOTAGE_KINDS: Array = [
	"freeze-frame", "omit-update", "perturb-transform", "omit-op", "patch-drop-item",
	"drop-message", "ignore-credit", "stale-coalesce", "stale-texture", "wrong-hash",
	"spurious-texture-update", "drop-resource", "unpin", "perturb-glyph", "perturb-vertex",
]
const TRANSACTION_KEYS: Array = [
	"type", "seq", "frame", "encoding", "base_seq", "status", "failures", "unsupported",
	"default_texture_filter", "default_texture_repeat", "removed_canvases", "removed_items",
	"removed_textures", "canvases", "items", "textures", "blocks",
]
## render-stream-4.md "Mesh table": removed_meshes after removed_textures, meshes after textures.
const TRANSACTION_KEYS_V4: Array = [
	"type", "seq", "frame", "encoding", "base_seq", "status", "failures", "unsupported",
	"default_texture_filter", "default_texture_repeat", "removed_canvases", "removed_items",
	"removed_textures", "removed_meshes", "canvases", "items", "textures", "meshes", "blocks",
]
const STATUSES: Array = ["ok", "capture-failure"]
const FAILURE_KEYS: Array = ["reason", "detail"]
const FAILURE_REASONS: Array = [
	"root-query-failed", "pre-existing-object", "mirror-capacity", "root-size-enforce-failed",
]
const UNSUPPORTED_KEYS: Array = ["op", "item", "reason"]
const SESSION_UNSUPPORTED_REASONS: Array = ["non-root-viewport", "extra-canvas", "degenerate-host-size"]
const ITEM_UNSUPPORTED_REASONS: Array = [
	"unsupported-op", "unsupported-state", "draw-index-tie", "unknown-texture", "unsupported-texture",
	"canvas-texture-headless", "unknown-mesh", "skinned-geometry", "unsupported-mesh",
]
const CANVAS_KEYS: Array = ["id", "origin", "role", "attached", "items"]
const ORIGINS: Array = ["created", "root-query", "adopted"]
const ITEM_KEYS: Array = [
	"id", "origin", "parent", "children", "visible", "draw_index", "z_index", "z_relative",
	"behind", "clip", "custom_rect", "visibility_layer", "texture_filter", "texture_repeat",
	"content_version", "commands",
]
const PARENT_KEYS: Array = ["kind", "id"]
const PARENT_KINDS: Array = ["canvas", "item"]
const ADD_RECT_KEYS: Array = ["op", "aa", "f"]
const ADD_TEXTURE_RECT_KEYS: Array = ["op", "tex", "tile", "transpose", "f"]
const ADD_TEXTURE_RECT_REGION_KEYS: Array = ["op", "tex", "transpose", "clip_uv", "f"]
## render-stream-3.md "Command" (new at /3).
const ADD_MSDF_TEXTURE_RECT_REGION_KEYS: Array = ["op", "tex", "outline", "f"]
const UNSUPPORTED_CMD_KEYS: Array = ["op", "name", "reason"]
const UNSUPPORTED_CMD_REASONS: Array = [
	"unsupported-op", "unknown-texture", "canvas-texture-headless", "unknown-mesh", "skinned-geometry",
]
## render-stream-4.md "Command" (new at /4): key order is "op", the extra meta keys in the order
## the spec lists them, then "f" last (or, for add_clip_ignore, "ignore" last with no "f").
const ADD_LINE_KEYS: Array = ["op", "aa", "f"]
const ADD_POLYLINE_KEYS: Array = ["op", "aa", "n", "colors", "f"]
const ADD_CIRCLE_KEYS: Array = ["op", "aa", "f"]
const ADD_PRIMITIVE_KEYS: Array = ["op", "tex", "n", "colors", "uvs", "f"]
const ADD_TRIANGLE_ARRAY_KEYS: Array = ["op", "tex", "n", "colors", "uvs", "indices", "count", "i", "f"]
const ADD_NINE_PATCH_KEYS: Array = ["op", "tex", "x_axis", "y_axis", "draw_center", "f"]
const ADD_MESH_KEYS: Array = ["op", "mesh", "tex", "f"]
const ADD_SET_TRANSFORM_KEYS: Array = ["op", "f"]
const ADD_CLIP_IGNORE_KEYS: Array = ["op", "ignore"]
const AXIS_STRETCH_MODES: Array = ["stretch", "tile", "tile_fit"]
const FILTERS: Array = [
	"default", "nearest", "linear", "nearest_mipmaps", "linear_mipmaps",
	"nearest_mipmaps_anisotropic", "linear_mipmaps_anisotropic",
]
const REPEATS: Array = ["default", "disabled", "enabled", "mirror"]
const TEXTURE_KEYS: Array = [
	"id", "origin", "kind", "status", "reason", "version", "hash", "format", "width", "height",
	"mipmaps", "payload_bytes", "canvas",
]
const TEXTURE_KINDS: Array = ["image", "placeholder", "canvas"]
const TEXTURE_STATUSES: Array = ["ok", "unsupported", "freed"]
const TEXTURE_REASONS: Array = [
	"unsupported-format", "payload-too-large", "payload-unavailable", "update-shape-mismatch",
	"layered-update", "unknown-texture", "canvas-texture-channel",
]
const CANVAS_TEXTURE_KEYS: Array = ["diffuse", "filter", "repeat"]
## render-stream-4.md "Mesh table" (new at /4).
const MESH_KEYS: Array = ["id", "origin", "status", "reason", "version", "f", "surfaces"]
const MESH_SURFACE_KEYS: Array = ["hash", "payload_bytes", "primitive", "format", "vertex_count", "index_count"]
const MESH_STATUSES: Array = ["ok", "unsupported", "freed"]
const MESH_REASONS: Array = ["mesh-format", "mesh-blend-shapes", "payload-too-large"]
const PRIMITIVES: Array = ["points", "lines", "line_strip", "triangles", "triangle_strip"]
const RESOURCE_KEYS: Array = ["type", "hash", "bytes", "blocks"]
const END_KEYS: Array = ["type", "transactions", "reason", "stats", "blocks"]
const END_REASONS: Array = ["shutdown", "disarm"]
const STATS_KEYS: Array = [
	"bytes_total", "encode_ns_total", "snapshot_ns_total", "diff_ns_total", "max_record_bytes",
	"full_transactions", "patch_transactions", "resource_records", "resource_bytes",
]
const BLOCK_KEYS: Array = ["name", "type", "count"]
const SESSION_BLOCK_NAMES: Array = [
	"clear_color", "root_canvas_xform", "host_visible_rect", "host_final_xform",
	"content_scale_factor",
]
const SESSION_BLOCK_COUNTS: Array = [4, 6, 4, 6, 1]
const TRANSACTION_BLOCK_NAMES: Array = ["item_f32", "canvas_f32", "cmd_f32"]
## render-stream-4.md "Transaction blocks": five blocks; cmd_i32 is type "i32", the rest "f32".
const TRANSACTION_BLOCK_NAMES_V4: Array = ["item_f32", "canvas_f32", "cmd_f32", "cmd_i32", "mesh_f32"]
const TRANSACTION_BLOCK_TYPES_V4: Array = ["f32", "f32", "f32", "i32", "f32"]


# --------------------------------------------------------------------------- small helpers


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


static func sha256_hex(bytes: PackedByteArray) -> String:
	var ctx := HashingContext.new()
	ctx.start(HashingContext.HASH_SHA256)
	ctx.update(bytes)
	return ctx.finish().hex_encode()


static func _is_lower_hex(text: String, length: int) -> bool:
	if text.length() != length:
		return false
	for i: int in text.length():
		var c: int = text.unicode_at(i)
		var digit: bool = c >= 0x30 and c <= 0x39
		var lower: bool = c >= 0x61 and c <= 0x66
		if not (digit or lower):
			return false
	return true


static func int_list(values: Variant) -> Array[int]:
	var source: Array = values
	var out: Array[int] = []
	for value: Variant in source:
		out.append(as_int(value))
	return out


static func _check_id_ordering(label: String, list: Array, seq: int) -> String:
	for i: int in range(1, list.size()):
		var prev_entry: Dictionary = list[i - 1]
		var cur_entry: Dictionary = list[i]
		var prev_id: int = as_int(prev_entry["id"])
		var cur_id: int = as_int(cur_entry["id"])
		if cur_id == prev_id:
			return err("duplicate-id", "seq %d: %s id %d repeats" % [seq, label, cur_id])
		if cur_id < prev_id:
			return err("meta-schema", "seq %d: %s are not sorted by id ascending" % [seq, label])
	return ""


static func _check_id_list_ascending(label: String, ids: Array[int], seq: int) -> String:
	for i: int in range(1, ids.size()):
		if ids[i] <= ids[i - 1]:
			return err("meta-schema", "seq %d: %s is not strictly ascending" % [seq, label])
	return ""


# --------------------------------------------------------------------------- framing


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


## `version` (2, 3 or 4) selects the expected magic -- GRS4 (the default since G5d: the capture
## and receiver speak /4, render-stream-4.md), GRS3 (golden-3/ only; the default from G4e2 to
## G5d) or GRS2 (golden-2/ only).
## A decoder configured for one version refuses every other magic the same way it already
## refuses GRS0/GRS1/anything else that is not its own.
static func split_records(data: PackedByteArray, version: int = 4) -> Dictionary:
	var records: Array[Dictionary] = []
	var errors := PackedStringArray()
	var expected_magic: String = MAGIC_V4_HEX if version == 4 else (MAGIC_V3_HEX if version == 3 else MAGIC_HEX)
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


# --------------------------------------------------------------------------- meta schema


class Schema:
	extends RefCounted

	var ok: bool = true
	var first_error: String = ""
	var _where: String

	func _init(where: String) -> void:
		_where = where

	func fail(detail: String) -> void:
		if ok:
			ok = false
			first_error = "%s: %s" % [_where, detail]

	func object(value: Variant, keys: Array, path: String) -> Dictionary:
		if not ok:
			return {}
		if typeof(value) != TYPE_DICTIONARY:
			fail("%s is not an object" % path)
			return {}
		var dict: Dictionary = value
		if dict.keys() != keys:
			fail("%s has keys %s, expected %s in that order" % [path, JSON.stringify(dict.keys()), JSON.stringify(keys)])
			return {}
		return dict

	func array(value: Variant, path: String) -> Array:
		if not ok:
			return []
		if typeof(value) != TYPE_ARRAY:
			fail("%s is not an array" % path)
			return []
		var list: Array = value
		return list

	func integer(value: Variant, path: String, low: float, high: float) -> int:
		if not ok:
			return 0
		if not Rs2Decoder.is_int(value):
			fail("%s is %s, not an integer" % [path, JSON.stringify(value)])
			return 0
		var number: float = value
		if number < low or number > high:
			fail("%s is %d, outside %d..%d" % [path, int(number), int(low), int(high)])
			return 0
		return int(number)

	func nullable_integer(value: Variant, path: String, low: float, high: float) -> void:
		if ok and value != null:
			integer(value, path, low, high)

	func boolean(value: Variant, path: String) -> bool:
		if not ok:
			return false
		if typeof(value) != TYPE_BOOL:
			fail("%s is %s, not a boolean" % [path, JSON.stringify(value)])
			return false
		var flag: bool = value
		return flag

	func string(value: Variant, path: String) -> String:
		if not ok:
			return ""
		if typeof(value) != TYPE_STRING:
			fail("%s is %s, not a string" % [path, JSON.stringify(value)])
			return ""
		var text: String = value
		return text

	func nullable_string(value: Variant, path: String) -> void:
		if ok and value != null:
			string(value, path)

	func one_of(value: Variant, allowed: Array, path: String) -> String:
		var text: String = string(value, path)
		if ok and not allowed.has(text):
			fail("%s is %s, expected one of %s" % [path, JSON.stringify(text), JSON.stringify(allowed)])
		return text

	func exact(value: Variant, expected: String, path: String) -> void:
		var text: String = string(value, path)
		if ok and text != expected:
			fail("%s is %s, expected %s" % [path, JSON.stringify(text), JSON.stringify(expected)])

	func hex(value: Variant, length: int, path: String) -> void:
		var text: String = string(value, path)
		if ok and not Rs2Decoder._is_lower_hex(text, length):
			fail("%s is not %d lowercase hex digits" % [path, length])

	func nullable_hex(value: Variant, length: int, path: String) -> void:
		if ok and value != null:
			hex(value, length, path)

	func sorted_strings(value: Variant, path: String) -> void:
		var list: Array = array(value, path)
		var last: String = ""
		for i: int in list.size():
			var text: String = string(list[i], "%s[%d]" % [path, i])
			if ok and i > 0 and not (last < text):
				fail("%s is not sorted ascending without repeats at %d" % [path, i])
			last = text

	## features.unsupported_resources (G2d): {resource, reason} objects sorted strictly ascending by
	## resource, each reason a known one.
	func unsupported_resources(value: Variant, path: String) -> void:
		var list: Array = array(value, path)
		var last: String = ""
		for i: int in list.size():
			var entry: Dictionary = object(list[i], Rs2Decoder.UNSUPPORTED_RESOURCE_KEYS, "%s[%d]" % [path, i])
			if not ok:
				return
			var resource: String = string(entry.get("resource"), "%s[%d].resource" % [path, i])
			one_of(entry.get("reason"), Rs2Decoder.UNSUPPORTED_RESOURCE_REASONS, "%s[%d].reason" % [path, i])
			if ok and i > 0 and not (last < resource):
				fail("%s is not sorted ascending by resource without repeats at %d" % [path, i])
			last = resource

	func int_pair(value: Variant, path: String) -> void:
		var list: Array = array(value, path)
		if ok and list.size() != 2:
			fail("%s does not have exactly 2 entries" % path)
			return
		integer(list[0], path + "[0]", -Rs2Decoder.MAX_SAFE_INT, Rs2Decoder.MAX_SAFE_INT)
		integer(list[1], path + "[1]", -Rs2Decoder.MAX_SAFE_INT, Rs2Decoder.MAX_SAFE_INT)

	func int_list(value: Variant, path: String) -> void:
		var list: Array = array(value, path)
		for i: int in list.size():
			integer(list[i], "%s[%d]" % [path, i], 1, Rs2Decoder.MAX_SAFE_INT)

	## render-stream-4.md "Block type i32": `types` (one "f32"/"i32" per block) lets the mesh_f32/
	## cmd_i32 transaction blocks share this same check; omitted, every block must be "f32".
	func blocks(value: Variant, names: Array, types: Array = []) -> void:
		var list: Array = array(value, "meta.blocks")
		if ok and list.size() != names.size():
			fail("meta.blocks has %d entries, expected %s" % [list.size(), JSON.stringify(names)])
		for i: int in list.size():
			var path: String = "meta.blocks[%d]" % i
			var entry: Dictionary = object(list[i], Rs2Decoder.BLOCK_KEYS, path)
			var expected_name: String = names[i]
			var expected_type: String = types[i] if types.size() > i else "f32"
			exact(entry.get("name"), expected_name, path + ".name")
			exact(entry.get("type"), expected_type, path + ".type")
			integer(entry.get("count"), path + ".count", 0, Rs2Decoder.U32_MAX)

	func resources(meta: Dictionary, version: int) -> void:
		var keys: Array = Rs2Decoder.RESOURCES_KEYS_V4 if version == 4 else Rs2Decoder.RESOURCES_KEYS
		var resources_dict: Dictionary = object(meta.get("resources"), keys, "meta.resources")
		exact(resources_dict.get("hash"), "sha256", "meta.resources.hash")
		if version == 4:
			# render-stream-4.md "Resources": "payloads" is a sorted array of schema strings.
			sorted_strings(resources_dict.get("payloads"), "meta.resources.payloads")
		else:
			string(resources_dict.get("payload"), "meta.resources.payload")
		var delivery: String = one_of(resources_dict.get("delivery"), Rs2Decoder.DELIVERIES, "meta.resources.delivery")
		var inline_max: int = integer(resources_dict.get("inline_max_bytes"), "meta.resources.inline_max_bytes", 0, Rs2Decoder.MAX_SAFE_INT)
		var max_payload: int = integer(resources_dict.get("max_payload_bytes"), "meta.resources.max_payload_bytes", 1, Rs2Decoder.MAX_SAFE_INT)
		sorted_strings(resources_dict.get("permitted_formats"), "meta.resources.permitted_formats")
		var fetch: String = one_of(resources_dict.get("fetch"), Rs2Decoder.FETCHES, "meta.resources.fetch")
		var http_path: Variant = resources_dict.get("http_path")
		nullable_string(http_path, "meta.resources.http_path")
		one_of(resources_dict.get("auth"), Rs2Decoder.AUTHS, "meta.resources.auth")
		if ok:
			if (fetch == "http") != (http_path != null):
				fail("meta.resources.http_path must be non-null exactly for fetch \"http\"")
		if ok:
			var expected_delivery: String = "out-of-band" if inline_max == 0 else ("inline" if inline_max >= max_payload else "mixed")
			if delivery != expected_delivery:
				fail("meta.resources.delivery is %s, expected %s" % [delivery, expected_delivery])
		if ok:
			if (delivery == "inline") != (fetch == "none"):
				fail("meta.resources.fetch must be \"none\" exactly when delivery is \"inline\"")

	func session(meta: Dictionary, version: int) -> void:
		object(meta, Rs2Decoder.SESSION_KEYS, "meta")
		var expected_protocol: String = Rs2Decoder.PROTOCOL_V4 if version == 4 else (Rs2Decoder.PROTOCOL_V3 if version == 3 else Rs2Decoder.PROTOCOL)
		exact(meta.get("protocol"), expected_protocol, "meta.protocol")
		hex(meta.get("session_id"), 32, "meta.session_id")
		var stream: Dictionary = object(meta.get("stream"), Rs2Decoder.STREAM_KEYS, "meta.stream")
		hex(stream.get("stream_id"), 32, "meta.stream.stream_id")
		var connection: Variant = stream.get("connection")
		if ok and connection != null:
			integer(connection, "meta.stream.connection", 1, Rs2Decoder.MAX_SAFE_INT)
		one_of(stream.get("transport"), Rs2Decoder.TRANSPORTS, "meta.stream.transport")
		one_of(stream.get("encoding"), Rs2Decoder.ENCODINGS, "meta.stream.encoding")
		var engine: Dictionary = object(meta.get("engine"), Rs2Decoder.ENGINE_KEYS, "meta.engine")
		string(engine.get("version_string"), "meta.engine.version_string")
		hex(engine.get("sha256"), 64, "meta.engine.sha256")
		string(engine.get("display_server"), "meta.engine.display_server")
		string(engine.get("rendering_driver"), "meta.engine.rendering_driver")
		string(engine.get("rendering_method"), "meta.engine.rendering_method")
		var capture: Dictionary = object(meta.get("capture"), Rs2Decoder.CAPTURE_KEYS, "meta.capture")
		integer(capture.get("calibrator_version"), "meta.capture.calibrator_version", 0, Rs2Decoder.MAX_SAFE_INT)
		sorted_strings(capture.get("hooks_planned"), "meta.capture.hooks_planned")
		sorted_strings(capture.get("hooks_omitted"), "meta.capture.hooks_omitted")
		var viewport: Dictionary = object(meta.get("viewport"), Rs2Decoder.VIEWPORT_KEYS, "meta.viewport")
		integer(viewport.get("canvas_cull_mask"), "meta.viewport.canvas_cull_mask", 0, Rs2Decoder.U32_MAX)
		integer(viewport.get("root_canvas"), "meta.viewport.root_canvas", -Rs2Decoder.MAX_SAFE_INT, Rs2Decoder.MAX_SAFE_INT)
		int_pair(viewport.get("logical_size"), "meta.viewport.logical_size")
		var stretch: Dictionary = object(viewport.get("stretch"), Rs2Decoder.STRETCH_KEYS, "meta.viewport.stretch")
		one_of(stretch.get("mode"), Rs2Decoder.STRETCH_MODES, "meta.viewport.stretch.mode")
		one_of(stretch.get("aspect"), Rs2Decoder.STRETCH_ASPECTS, "meta.viewport.stretch.aspect")
		one_of(stretch.get("scale_mode"), Rs2Decoder.SCALE_MODES, "meta.viewport.stretch.scale_mode")
		exact(viewport.get("stretch_applied_by"), "receiver", "meta.viewport.stretch_applied_by")
		one_of(viewport.get("root_size_policy"), Rs2Decoder.ROOT_SIZE_POLICIES, "meta.viewport.root_size_policy")
		one_of(viewport.get("host_size_status"), Rs2Decoder.HOST_SIZE_STATUSES, "meta.viewport.host_size_status")
		int_pair(viewport.get("host_window_size"), "meta.viewport.host_window_size")
		resources(meta, version)
		var features: Dictionary = object(meta.get("features"), Rs2Decoder.FEATURES_KEYS, "meta.features")
		sorted_strings(features.get("ops"), "meta.features.ops")
		sorted_strings(features.get("item_state"), "meta.features.item_state")
		sorted_strings(features.get("resources"), "meta.features.resources")
		unsupported_resources(features.get("unsupported_resources"), "meta.features.unsupported_resources")
		sorted_strings(features.get("observed_unsupported_ops"), "meta.features.observed_unsupported_ops")
		sorted_strings(features.get("unobserved"), "meta.features.unobserved")
		exact(features.get("publication"), Rs2Decoder.PUBLICATION, "meta.features.publication")
		var sabotage: Variant = meta.get("sabotage")
		if ok and sabotage != null:
			var spec: Dictionary = object(sabotage, Rs2Decoder.SABOTAGE_KEYS, "meta.sabotage")
			var kind: String = one_of(spec.get("kind"), Rs2Decoder.SABOTAGE_KINDS, "meta.sabotage.kind")
			integer(spec.get("frame"), "meta.sabotage.frame", 1, Rs2Decoder.MAX_SAFE_INT)
			var op: Variant = spec.get("op")
			if ok:
				if op != null:
					string(op, "meta.sabotage.op")
				if ok and (kind == "omit-op") != (op != null):
					fail("meta.sabotage.op must be non-null exactly for kind \"omit-op\"")
		blocks(meta.get("blocks"), Rs2Decoder.SESSION_BLOCK_NAMES)
		if ok:
			var declared: Array = meta["blocks"]
			for i: int in declared.size():
				var entry: Dictionary = declared[i]
				var expected: int = Rs2Decoder.SESSION_BLOCK_COUNTS[i]
				if Rs2Decoder.as_int(entry["count"]) != expected:
					fail("session block %s has count %d, expected %d" % [entry["name"], Rs2Decoder.as_int(entry["count"]), expected])

	func texture_entry(t: Variant, path: String) -> void:
		var entry: Dictionary = object(t, Rs2Decoder.TEXTURE_KEYS, path)
		integer(entry.get("id"), path + ".id", 1, Rs2Decoder.MAX_SAFE_INT)
		exact(entry.get("origin"), "created", path + ".origin")
		one_of(entry.get("kind"), Rs2Decoder.TEXTURE_KINDS, path + ".kind")
		one_of(entry.get("status"), Rs2Decoder.TEXTURE_STATUSES, path + ".status")
		var reason: Variant = entry.get("reason")
		if ok and reason != null:
			one_of(reason, Rs2Decoder.TEXTURE_REASONS, path + ".reason")
		integer(entry.get("version"), path + ".version", 1, Rs2Decoder.MAX_SAFE_INT)
		nullable_hex(entry.get("hash"), 64, path + ".hash")
		nullable_string(entry.get("format"), path + ".format")
		integer(entry.get("width"), path + ".width", 0, Rs2Decoder.MAX_SAFE_INT)
		integer(entry.get("height"), path + ".height", 0, Rs2Decoder.MAX_SAFE_INT)
		boolean(entry.get("mipmaps"), path + ".mipmaps")
		integer(entry.get("payload_bytes"), path + ".payload_bytes", 0, Rs2Decoder.MAX_SAFE_INT)
		var canvas: Variant = entry.get("canvas")
		if ok and canvas != null:
			var canvas_dict: Dictionary = object(canvas, Rs2Decoder.CANVAS_TEXTURE_KEYS, path + ".canvas")
			var diffuse: Variant = canvas_dict.get("diffuse")
			if ok and diffuse != null:
				integer(diffuse, path + ".canvas.diffuse", 1, Rs2Decoder.MAX_SAFE_INT)
			one_of(canvas_dict.get("filter"), Rs2Decoder.FILTERS, path + ".canvas.filter")
			one_of(canvas_dict.get("repeat"), Rs2Decoder.REPEATS, path + ".canvas.repeat")

	## render-stream-4.md "Mesh table" (new at /4): the wire shape of one mesh entry. The
	## status/reason/f/surfaces coupling ("mesh-entry") is checked later, once the running
	## mesh_f32 offset is known (_check_resolved_invariants).
	func mesh_surface(s: Variant, path: String) -> void:
		var entry: Dictionary = object(s, Rs2Decoder.MESH_SURFACE_KEYS, path)
		hex(entry.get("hash"), 64, path + ".hash")
		integer(entry.get("payload_bytes"), path + ".payload_bytes", 1, Rs2Decoder.MAX_SAFE_INT)
		one_of(entry.get("primitive"), Rs2Decoder.PRIMITIVES, path + ".primitive")
		integer(entry.get("format"), path + ".format", -Rs2Decoder.MAX_SAFE_INT, Rs2Decoder.MAX_SAFE_INT)
		integer(entry.get("vertex_count"), path + ".vertex_count", 0, Rs2Decoder.MAX_SAFE_INT)
		integer(entry.get("index_count"), path + ".index_count", 0, Rs2Decoder.MAX_SAFE_INT)

	func mesh_entry(m: Variant, path: String) -> void:
		var entry: Dictionary = object(m, Rs2Decoder.MESH_KEYS, path)
		integer(entry.get("id"), path + ".id", 1, Rs2Decoder.MAX_SAFE_INT)
		exact(entry.get("origin"), "created", path + ".origin")
		one_of(entry.get("status"), Rs2Decoder.MESH_STATUSES, path + ".status")
		var reason: Variant = entry.get("reason")
		if ok and reason != null:
			one_of(reason, Rs2Decoder.MESH_REASONS, path + ".reason")
		integer(entry.get("version"), path + ".version", 1, Rs2Decoder.MAX_SAFE_INT)
		nullable_integer(entry.get("f"), path + ".f", 0, Rs2Decoder.MAX_SAFE_INT)
		var surfaces: Array = array(entry.get("surfaces"), path + ".surfaces")
		for i: int in surfaces.size():
			mesh_surface(surfaces[i], "%s.surfaces[%d]" % [path, i])

	func transaction(meta: Dictionary, version: int) -> void:
		var is_v4: bool = version == 4
		object(meta, Rs2Decoder.TRANSACTION_KEYS_V4 if is_v4 else Rs2Decoder.TRANSACTION_KEYS, "meta")
		integer(meta.get("seq"), "meta.seq", 1, Rs2Decoder.MAX_SAFE_INT)
		integer(meta.get("frame"), "meta.frame", 1, Rs2Decoder.MAX_SAFE_INT)
		one_of(meta.get("encoding"), Rs2Decoder.ENCODINGS, "meta.encoding")
		nullable_integer(meta.get("base_seq"), "meta.base_seq", 1, Rs2Decoder.MAX_SAFE_INT)
		one_of(meta.get("status"), Rs2Decoder.STATUSES, "meta.status")
		var failures: Array = array(meta.get("failures"), "meta.failures")
		for i: int in failures.size():
			var path: String = "meta.failures[%d]" % i
			var failure: Dictionary = object(failures[i], Rs2Decoder.FAILURE_KEYS, path)
			one_of(failure.get("reason"), Rs2Decoder.FAILURE_REASONS, path + ".reason")
			string(failure.get("detail"), path + ".detail")
		var unsupported: Array = array(meta.get("unsupported"), "meta.unsupported")
		for i: int in unsupported.size():
			var path: String = "meta.unsupported[%d]" % i
			var entry: Dictionary = object(unsupported[i], Rs2Decoder.UNSUPPORTED_KEYS, path)
			if not ok:
				return
			string(entry["op"], path + ".op")
			if entry["item"] == null:
				one_of(entry["reason"], Rs2Decoder.SESSION_UNSUPPORTED_REASONS, path + ".reason")
			else:
				integer(entry["item"], path + ".item", 1, Rs2Decoder.MAX_SAFE_INT)
				one_of(entry["reason"], Rs2Decoder.ITEM_UNSUPPORTED_REASONS, path + ".reason")
		var filt: String = one_of(meta.get("default_texture_filter"), Rs2Decoder.FILTERS, "meta.default_texture_filter")
		if ok and filt == "default":
			fail("meta.default_texture_filter must never be \"default\"")
		var rep: String = one_of(meta.get("default_texture_repeat"), Rs2Decoder.REPEATS, "meta.default_texture_repeat")
		if ok and rep == "default":
			fail("meta.default_texture_repeat must never be \"default\"")
		int_list(meta.get("removed_canvases"), "meta.removed_canvases")
		int_list(meta.get("removed_items"), "meta.removed_items")
		int_list(meta.get("removed_textures"), "meta.removed_textures")
		if is_v4:
			int_list(meta.get("removed_meshes"), "meta.removed_meshes")
		var canvases: Array = array(meta.get("canvases"), "meta.canvases")
		for i: int in canvases.size():
			var path: String = "meta.canvases[%d]" % i
			var canvas: Dictionary = object(canvases[i], Rs2Decoder.CANVAS_KEYS, path)
			integer(canvas.get("id"), path + ".id", 1, Rs2Decoder.MAX_SAFE_INT)
			one_of(canvas.get("origin"), Rs2Decoder.ORIGINS, path + ".origin")
			var role: Variant = canvas.get("role")
			if ok and role != null:
				exact(role, "root", path + ".role")
			boolean(canvas.get("attached"), path + ".attached")
			int_list(canvas.get("items"), path + ".items")
		var items: Array = array(meta.get("items"), "meta.items")
		for i: int in items.size():
			var path: String = "meta.items[%d]" % i
			var item: Dictionary = object(items[i], Rs2Decoder.ITEM_KEYS, path)
			integer(item.get("id"), path + ".id", 1, Rs2Decoder.MAX_SAFE_INT)
			one_of(item.get("origin"), Rs2Decoder.ORIGINS, path + ".origin")
			var parent: Variant = item.get("parent")
			if ok and parent != null:
				var link: Dictionary = object(parent, Rs2Decoder.PARENT_KEYS, path + ".parent")
				one_of(link.get("kind"), Rs2Decoder.PARENT_KINDS, path + ".parent.kind")
				integer(link.get("id"), path + ".parent.id", 1, Rs2Decoder.MAX_SAFE_INT)
			int_list(item.get("children"), path + ".children")
			boolean(item.get("visible"), path + ".visible")
			integer(item.get("draw_index"), path + ".draw_index", -Rs2Decoder.MAX_SAFE_INT, Rs2Decoder.MAX_SAFE_INT)
			integer(item.get("z_index"), path + ".z_index", -Rs2Decoder.MAX_SAFE_INT, Rs2Decoder.MAX_SAFE_INT)
			boolean(item.get("z_relative"), path + ".z_relative")
			boolean(item.get("behind"), path + ".behind")
			boolean(item.get("clip"), path + ".clip")
			boolean(item.get("custom_rect"), path + ".custom_rect")
			integer(item.get("visibility_layer"), path + ".visibility_layer", 0, Rs2Decoder.U32_MAX)
			one_of(item.get("texture_filter"), Rs2Decoder.FILTERS, path + ".texture_filter")
			one_of(item.get("texture_repeat"), Rs2Decoder.REPEATS, path + ".texture_repeat")
			integer(item.get("content_version"), path + ".content_version", 0, Rs2Decoder.MAX_SAFE_INT)
			var commands: Variant = item.get("commands")
			if ok and commands != null:
				var list: Array = array(commands, path + ".commands")
				for j: int in list.size():
					var cpath: String = "%s.commands[%d]" % [path, j]
					if not ok:
						return
					if typeof(list[j]) != TYPE_DICTIONARY:
						fail(cpath + " is not an object")
						return
					var command: Dictionary = list[j]
					var op: Variant = command.get("op")
					if op is String and op == "add_rect":
						object(command, Rs2Decoder.ADD_RECT_KEYS, cpath)
						boolean(command.get("aa"), cpath + ".aa")
						integer(command.get("f"), cpath + ".f", 0, Rs2Decoder.MAX_SAFE_INT)
					elif op is String and op == "add_texture_rect":
						object(command, Rs2Decoder.ADD_TEXTURE_RECT_KEYS, cpath)
						var tex: Variant = command.get("tex")
						if ok and tex != null:
							integer(tex, cpath + ".tex", 1, Rs2Decoder.MAX_SAFE_INT)
						boolean(command.get("tile"), cpath + ".tile")
						boolean(command.get("transpose"), cpath + ".transpose")
						integer(command.get("f"), cpath + ".f", 0, Rs2Decoder.MAX_SAFE_INT)
					elif op is String and op == "add_texture_rect_region":
						object(command, Rs2Decoder.ADD_TEXTURE_RECT_REGION_KEYS, cpath)
						var tex2: Variant = command.get("tex")
						if ok and tex2 != null:
							integer(tex2, cpath + ".tex", 1, Rs2Decoder.MAX_SAFE_INT)
						boolean(command.get("transpose"), cpath + ".transpose")
						boolean(command.get("clip_uv"), cpath + ".clip_uv")
						integer(command.get("f"), cpath + ".f", 0, Rs2Decoder.MAX_SAFE_INT)
					elif op is String and op == "add_msdf_texture_rect_region":
						object(command, Rs2Decoder.ADD_MSDF_TEXTURE_RECT_REGION_KEYS, cpath)
						var tex3: Variant = command.get("tex")
						if ok and tex3 != null:
							integer(tex3, cpath + ".tex", 1, Rs2Decoder.MAX_SAFE_INT)
						integer(command.get("outline"), cpath + ".outline", 0, Rs2Decoder.MAX_SAFE_INT)
						integer(command.get("f"), cpath + ".f", 0, Rs2Decoder.MAX_SAFE_INT)
					elif op is String and op == "add_line":
						object(command, Rs2Decoder.ADD_LINE_KEYS, cpath)
						boolean(command.get("aa"), cpath + ".aa")
						integer(command.get("f"), cpath + ".f", 0, Rs2Decoder.MAX_SAFE_INT)
					elif op is String and (op == "add_polyline" or op == "add_multiline"):
						object(command, Rs2Decoder.ADD_POLYLINE_KEYS, cpath)
						boolean(command.get("aa"), cpath + ".aa")
						integer(command.get("n"), cpath + ".n", 0, Rs2Decoder.MAX_SAFE_INT)
						integer(command.get("colors"), cpath + ".colors", 0, Rs2Decoder.MAX_SAFE_INT)
						integer(command.get("f"), cpath + ".f", 0, Rs2Decoder.MAX_SAFE_INT)
					elif op is String and op == "add_circle":
						object(command, Rs2Decoder.ADD_CIRCLE_KEYS, cpath)
						boolean(command.get("aa"), cpath + ".aa")
						integer(command.get("f"), cpath + ".f", 0, Rs2Decoder.MAX_SAFE_INT)
					elif op is String and (op == "add_primitive" or op == "add_polygon"):
						object(command, Rs2Decoder.ADD_PRIMITIVE_KEYS, cpath)
						var tex4: Variant = command.get("tex")
						if ok and tex4 != null:
							integer(tex4, cpath + ".tex", 1, Rs2Decoder.MAX_SAFE_INT)
						integer(command.get("n"), cpath + ".n", 0, Rs2Decoder.MAX_SAFE_INT)
						integer(command.get("colors"), cpath + ".colors", 0, Rs2Decoder.MAX_SAFE_INT)
						integer(command.get("uvs"), cpath + ".uvs", 0, Rs2Decoder.MAX_SAFE_INT)
						integer(command.get("f"), cpath + ".f", 0, Rs2Decoder.MAX_SAFE_INT)
					elif op is String and op == "add_triangle_array":
						object(command, Rs2Decoder.ADD_TRIANGLE_ARRAY_KEYS, cpath)
						var tex5: Variant = command.get("tex")
						if ok and tex5 != null:
							integer(tex5, cpath + ".tex", 1, Rs2Decoder.MAX_SAFE_INT)
						integer(command.get("n"), cpath + ".n", 0, Rs2Decoder.MAX_SAFE_INT)
						integer(command.get("colors"), cpath + ".colors", 0, Rs2Decoder.MAX_SAFE_INT)
						integer(command.get("uvs"), cpath + ".uvs", 0, Rs2Decoder.MAX_SAFE_INT)
						integer(command.get("indices"), cpath + ".indices", 0, Rs2Decoder.MAX_SAFE_INT)
						integer(command.get("count"), cpath + ".count", -Rs2Decoder.MAX_SAFE_INT, Rs2Decoder.MAX_SAFE_INT)
						integer(command.get("i"), cpath + ".i", 0, Rs2Decoder.MAX_SAFE_INT)
						integer(command.get("f"), cpath + ".f", 0, Rs2Decoder.MAX_SAFE_INT)
					elif op is String and op == "add_nine_patch":
						object(command, Rs2Decoder.ADD_NINE_PATCH_KEYS, cpath)
						var tex6: Variant = command.get("tex")
						if ok and tex6 != null:
							integer(tex6, cpath + ".tex", 1, Rs2Decoder.MAX_SAFE_INT)
						one_of(command.get("x_axis"), Rs2Decoder.AXIS_STRETCH_MODES, cpath + ".x_axis")
						one_of(command.get("y_axis"), Rs2Decoder.AXIS_STRETCH_MODES, cpath + ".y_axis")
						boolean(command.get("draw_center"), cpath + ".draw_center")
						integer(command.get("f"), cpath + ".f", 0, Rs2Decoder.MAX_SAFE_INT)
					elif op is String and op == "add_mesh":
						object(command, Rs2Decoder.ADD_MESH_KEYS, cpath)
						integer(command.get("mesh"), cpath + ".mesh", 1, Rs2Decoder.MAX_SAFE_INT)
						var tex7: Variant = command.get("tex")
						if ok and tex7 != null:
							integer(tex7, cpath + ".tex", 1, Rs2Decoder.MAX_SAFE_INT)
						integer(command.get("f"), cpath + ".f", 0, Rs2Decoder.MAX_SAFE_INT)
					elif op is String and op == "add_set_transform":
						object(command, Rs2Decoder.ADD_SET_TRANSFORM_KEYS, cpath)
						integer(command.get("f"), cpath + ".f", 0, Rs2Decoder.MAX_SAFE_INT)
					elif op is String and op == "add_clip_ignore":
						object(command, Rs2Decoder.ADD_CLIP_IGNORE_KEYS, cpath)
						boolean(command.get("ignore"), cpath + ".ignore")
					elif op is String and op == "unsupported":
						object(command, Rs2Decoder.UNSUPPORTED_CMD_KEYS, cpath)
						string(command.get("name"), cpath + ".name")
						one_of(command.get("reason"), Rs2Decoder.UNSUPPORTED_CMD_REASONS, cpath + ".reason")
					else:
						fail("%s.op is %s, an unknown command op" % [cpath, JSON.stringify(op)])
		var textures: Array = array(meta.get("textures"), "meta.textures")
		for i: int in textures.size():
			texture_entry(textures[i], "meta.textures[%d]" % i)
		if is_v4:
			var meshes: Array = array(meta.get("meshes"), "meta.meshes")
			for i: int in meshes.size():
				mesh_entry(meshes[i], "meta.meshes[%d]" % i)
		if is_v4:
			blocks(meta.get("blocks"), Rs2Decoder.TRANSACTION_BLOCK_NAMES_V4, Rs2Decoder.TRANSACTION_BLOCK_TYPES_V4)
		else:
			blocks(meta.get("blocks"), Rs2Decoder.TRANSACTION_BLOCK_NAMES)

	func resource(meta: Dictionary) -> void:
		object(meta, Rs2Decoder.RESOURCE_KEYS, "meta")
		hex(meta.get("hash"), 64, "meta.hash")
		var declared_bytes: int = integer(meta.get("bytes"), "meta.bytes", 1, Rs2Decoder.MAX_SAFE_INT)
		var list: Array = array(meta.get("blocks"), "meta.blocks")
		if ok and (list.size() != 1):
			fail("meta.blocks must have exactly one entry")
		if ok:
			var entry: Dictionary = object(list[0], Rs2Decoder.BLOCK_KEYS, "meta.blocks[0]")
			exact(entry.get("name"), "payload", "meta.blocks[0].name")
			exact(entry.get("type"), "u8", "meta.blocks[0].type")
			var count: int = integer(entry.get("count"), "meta.blocks[0].count", 0, Rs2Decoder.U32_MAX)
			if ok and count != declared_bytes:
				fail("meta.blocks[0].count disagrees with meta.bytes")

	func end(meta: Dictionary) -> void:
		object(meta, Rs2Decoder.END_KEYS, "meta")
		integer(meta.get("transactions"), "meta.transactions", 0, Rs2Decoder.MAX_SAFE_INT)
		one_of(meta.get("reason"), Rs2Decoder.END_REASONS, "meta.reason")
		var stats: Dictionary = object(meta.get("stats"), Rs2Decoder.STATS_KEYS, "meta.stats")
		for key: Variant in Rs2Decoder.STATS_KEYS:
			var stat: String = key
			integer(stats.get(stat), "meta.stats." + stat, 0, Rs2Decoder.MAX_SAFE_INT)
		blocks(meta.get("blocks"), [])


# --------------------------------------------------------------------------- one record


## Decodes one record: framing, meta JSON, meta schema, block framing. Returns {offset,
## byte_length, sha256, meta: Dictionary, blocks: Array, errors: PackedStringArray}. Each `blocks`
## entry is a PackedFloat32Array (f32 block) or {"u8_bytes", "sha256"} (u8 block, render-stream-
## 2.md "Decoded and resolved forms" -- the raw bytes are NOT kept here; use raw_resource_payload()
## for that). `meta` is the parsed JSON whenever it parsed, even if later checks failed.
static func decode_record(data: PackedByteArray, offset: int, version: int = 4) -> Dictionary:
	var blocks: Array = []
	var errors := PackedStringArray()
	var out: Dictionary = {
		"offset": offset, "byte_length": 0, "sha256": "", "meta": {}, "blocks": blocks,
		"errors": errors,
	}
	var frame: Dictionary = _frame(data, offset)
	var problem: String = frame["error"]
	if problem != "":
		errors.append(problem)
		out["errors"] = errors
		return out
	var end: int = frame["end"]
	out["byte_length"] = end - offset
	out["sha256"] = sha256_hex(data.slice(offset, end))

	var meta_start: int = frame["meta_start"]
	var meta_len: int = frame["meta_len"]
	var meta_bytes: PackedByteArray = data.slice(meta_start, meta_start + meta_len)
	for i: int in meta_bytes.size():
		var b: int = meta_bytes[i]
		if b < 0x20 or b > 0x7e:
			errors.append(err("meta-json", "record at offset %d: meta byte %d is 0x%02x, not printable ASCII" % [offset, i, b]))
			out["errors"] = errors
			return out
	var json := JSON.new()
	if json.parse(meta_bytes.get_string_from_ascii()) != OK:
		errors.append(err("meta-json", "record at offset %d: %s (line %d)" % [offset, json.get_error_message(), json.get_error_line()]))
		out["errors"] = errors
		return out
	var parsed: Variant = json.data
	if typeof(parsed) != TYPE_DICTIONARY:
		errors.append(err("meta-schema", "record at offset %d: meta is not a JSON object" % offset))
		out["errors"] = errors
		return out
	var meta: Dictionary = parsed
	out["meta"] = meta

	var check := Schema.new("record at offset %d" % offset)
	var kind: Variant = meta.get("type")
	if kind is String and kind == "session":
		check.session(meta, version)
	elif kind is String and kind == "transaction":
		check.transaction(meta, version)
	elif kind is String and kind == "resource":
		check.resource(meta)
	elif kind is String and kind == "end":
		check.end(meta)
	else:
		check.fail("meta.type is %s, expected session, transaction, resource or end" % JSON.stringify(kind))
	if not check.ok:
		errors.append(err("meta-schema", check.first_error))
		out["errors"] = errors
		return out

	var declared: Array = meta["blocks"]
	var spans: Array = frame["blocks"]
	if spans.size() != declared.size():
		errors.append(err("block-count", "record at offset %d: block_count is %d, meta.blocks has %d entries" % [offset, spans.size(), declared.size()]))
		out["errors"] = errors
		return out
	for i: int in spans.size():
		var span: Array = spans[i]
		var entry: Dictionary = declared[i]
		var count: int = as_int(entry["count"])
		var start: int = span[0]
		var length: int = span[1]
		var block_type: String = entry["type"]
		# render-stream-4.md "Block type i32": same four-byte-per-element width as f32.
		var expected_len: int = count if block_type == "u8" else 4 * count
		if length != expected_len:
			errors.append(err("block-length", "record at offset %d: block %d (%s) carries %d bytes, count %d needs %d" % [offset, i, entry["name"], length, count, expected_len]))
			out["errors"] = errors
			return out
		if block_type == "f32":
			blocks.append(data.slice(start, start + length).to_float32_array())
		elif block_type == "i32":
			blocks.append(data.slice(start, start + length).to_int32_array())
		else:
			var payload: PackedByteArray = data.slice(start, start + length)
			blocks.append({"u8_bytes": length, "sha256": sha256_hex(payload)})
	out["blocks"] = blocks
	return out


## The raw bytes of a "resource" record's single u8 block, read directly from `data` (decode_
## record() discards them into {"u8_bytes","sha256"}). `record` is decode_record()'s result for
## a record whose meta.type == "resource".
static func raw_resource_payload(data: PackedByteArray, record: Dictionary) -> PackedByteArray:
	var offset: int = as_int(record["offset"])
	var frame: Dictionary = _frame(data, offset)
	var spans: Array = frame["blocks"]
	var span: Array = spans[0]
	var start: int = span[0]
	var length: int = span[1]
	return data.slice(start, start + length)


# --------------------------------------------------------------------------- resolution helpers


static func _lift_item(item: Dictionary, item_f32: PackedFloat32Array, cmd_f32: PackedFloat32Array, cmd_i32: PackedInt32Array) -> Dictionary:
	var commands: Array[Dictionary] = []
	if item["commands"] != null:
		var raw: Array = item["commands"]
		for value: Variant in raw:
			var command: Dictionary = value
			var op: String = command["op"]
			if op == "add_rect":
				var f: int = as_int(command["f"])
				commands.append({
					"op": "add_rect", "aa": command["aa"],
					"rect": [cmd_f32[f], cmd_f32[f + 1], cmd_f32[f + 2], cmd_f32[f + 3]],
					"color": [cmd_f32[f + 4], cmd_f32[f + 5], cmd_f32[f + 6], cmd_f32[f + 7]],
				})
			elif op == "add_texture_rect":
				var f2: int = as_int(command["f"])
				commands.append({
					"op": "add_texture_rect", "tex": command["tex"], "tile": command["tile"],
					"transpose": command["transpose"],
					"rect": [cmd_f32[f2], cmd_f32[f2 + 1], cmd_f32[f2 + 2], cmd_f32[f2 + 3]],
					"modulate": [cmd_f32[f2 + 4], cmd_f32[f2 + 5], cmd_f32[f2 + 6], cmd_f32[f2 + 7]],
				})
			elif op == "add_texture_rect_region":
				var f3: int = as_int(command["f"])
				commands.append({
					"op": "add_texture_rect_region", "tex": command["tex"],
					"transpose": command["transpose"], "clip_uv": command["clip_uv"],
					"rect": [cmd_f32[f3], cmd_f32[f3 + 1], cmd_f32[f3 + 2], cmd_f32[f3 + 3]],
					"src": [cmd_f32[f3 + 4], cmd_f32[f3 + 5], cmd_f32[f3 + 6], cmd_f32[f3 + 7]],
					"modulate": [cmd_f32[f3 + 8], cmd_f32[f3 + 9], cmd_f32[f3 + 10], cmd_f32[f3 + 11]],
				})
			elif op == "add_msdf_texture_rect_region":
				# render-stream-3.md "Command": 14 floats (rect 4, src 4, modulate 4, px_range, scale).
				var f4: int = as_int(command["f"])
				commands.append({
					"op": "add_msdf_texture_rect_region", "tex": command["tex"],
					"outline": command["outline"],
					"rect": [cmd_f32[f4], cmd_f32[f4 + 1], cmd_f32[f4 + 2], cmd_f32[f4 + 3]],
					"src": [cmd_f32[f4 + 4], cmd_f32[f4 + 5], cmd_f32[f4 + 6], cmd_f32[f4 + 7]],
					"modulate": [cmd_f32[f4 + 8], cmd_f32[f4 + 9], cmd_f32[f4 + 10], cmd_f32[f4 + 11]],
					"px_range": cmd_f32[f4 + 12], "scale": cmd_f32[f4 + 13],
				})
			elif op == "add_line":
				var fl: int = as_int(command["f"])
				commands.append({
					"op": "add_line", "aa": command["aa"],
					"from": [cmd_f32[fl], cmd_f32[fl + 1]], "to": [cmd_f32[fl + 2], cmd_f32[fl + 3]],
					"colour": [cmd_f32[fl + 4], cmd_f32[fl + 5], cmd_f32[fl + 6], cmd_f32[fl + 7]],
					"width": cmd_f32[fl + 8],
				})
			elif op == "add_polyline" or op == "add_multiline":
				var fp: int = as_int(command["f"])
				var n: int = as_int(command["n"])
				var ncolors: int = as_int(command["colors"])
				var width: float = cmd_f32[fp]
				var points: Array = []
				var p: int = fp + 1
				for i: int in n:
					points.append([cmd_f32[p], cmd_f32[p + 1]])
					p += 2
				var colors: Array = []
				for i: int in ncolors:
					colors.append([cmd_f32[p], cmd_f32[p + 1], cmd_f32[p + 2], cmd_f32[p + 3]])
					p += 4
				commands.append({"op": op, "aa": command["aa"], "width": width, "points": points, "colors": colors})
			elif op == "add_circle":
				var fc: int = as_int(command["f"])
				commands.append({
					"op": "add_circle", "aa": command["aa"],
					"position": [cmd_f32[fc], cmd_f32[fc + 1]], "radius": cmd_f32[fc + 2],
					"colour": [cmd_f32[fc + 3], cmd_f32[fc + 4], cmd_f32[fc + 5], cmd_f32[fc + 6]],
				})
			elif op == "add_primitive" or op == "add_polygon":
				var fpr: int = as_int(command["f"])
				var npr: int = as_int(command["n"])
				var ncolorspr: int = as_int(command["colors"])
				var nuvs: int = as_int(command["uvs"])
				var pointspr: Array = []
				var pp: int = fpr
				for i: int in npr:
					pointspr.append([cmd_f32[pp], cmd_f32[pp + 1]])
					pp += 2
				var colorspr: Array = []
				for i: int in ncolorspr:
					colorspr.append([cmd_f32[pp], cmd_f32[pp + 1], cmd_f32[pp + 2], cmd_f32[pp + 3]])
					pp += 4
				var uvspr: Array = []
				for i: int in nuvs:
					uvspr.append([cmd_f32[pp], cmd_f32[pp + 1]])
					pp += 2
				commands.append({"op": op, "tex": command["tex"], "points": pointspr, "colors": colorspr, "uvs": uvspr})
			elif op == "add_triangle_array":
				var fta: int = as_int(command["f"])
				var ita: int = as_int(command["i"])
				var nta: int = as_int(command["n"])
				var ncolorsta: int = as_int(command["colors"])
				var nuvsta: int = as_int(command["uvs"])
				var nindices: int = as_int(command["indices"])
				var pointsta: Array = []
				var pta: int = fta
				for i: int in nta:
					pointsta.append([cmd_f32[pta], cmd_f32[pta + 1]])
					pta += 2
				var colorsta: Array = []
				for i: int in ncolorsta:
					colorsta.append([cmd_f32[pta], cmd_f32[pta + 1], cmd_f32[pta + 2], cmd_f32[pta + 3]])
					pta += 4
				var uvsta: Array = []
				for i: int in nuvsta:
					uvsta.append([cmd_f32[pta], cmd_f32[pta + 1]])
					pta += 2
				var indices: Array[int] = []
				for i: int in nindices:
					indices.append(cmd_i32[ita + i])
				commands.append({
					"op": "add_triangle_array", "tex": command["tex"], "count": as_int(command["count"]),
					"points": pointsta, "colors": colorsta, "uvs": uvsta, "indices": indices,
				})
			elif op == "add_nine_patch":
				var fnp: int = as_int(command["f"])
				commands.append({
					"op": "add_nine_patch", "tex": command["tex"],
					"rect": [cmd_f32[fnp], cmd_f32[fnp + 1], cmd_f32[fnp + 2], cmd_f32[fnp + 3]],
					"source": [cmd_f32[fnp + 4], cmd_f32[fnp + 5], cmd_f32[fnp + 6], cmd_f32[fnp + 7]],
					"margins": [cmd_f32[fnp + 8], cmd_f32[fnp + 9], cmd_f32[fnp + 10], cmd_f32[fnp + 11]],
					"x_axis": command["x_axis"], "y_axis": command["y_axis"], "draw_center": command["draw_center"],
					"modulate": [cmd_f32[fnp + 12], cmd_f32[fnp + 13], cmd_f32[fnp + 14], cmd_f32[fnp + 15]],
				})
			elif op == "add_mesh":
				var fm: int = as_int(command["f"])
				commands.append({
					"op": "add_mesh", "mesh": as_int(command["mesh"]), "tex": command["tex"],
					"transform": [cmd_f32[fm], cmd_f32[fm + 1], cmd_f32[fm + 2], cmd_f32[fm + 3], cmd_f32[fm + 4], cmd_f32[fm + 5]],
					"modulate": [cmd_f32[fm + 6], cmd_f32[fm + 7], cmd_f32[fm + 8], cmd_f32[fm + 9]],
				})
			elif op == "add_set_transform":
				var fst: int = as_int(command["f"])
				commands.append({
					"op": "add_set_transform",
					"transform": [cmd_f32[fst], cmd_f32[fst + 1], cmd_f32[fst + 2], cmd_f32[fst + 3], cmd_f32[fst + 4], cmd_f32[fst + 5]],
				})
			elif op == "add_clip_ignore":
				commands.append({"op": "add_clip_ignore", "ignore": command["ignore"]})
			else:
				commands.append({"op": "unsupported", "name": command["name"], "reason": command["reason"]})
	var parent: Variant = item["parent"]
	return {
		"id": as_int(item["id"]), "origin": item["origin"],
		"parent": null if parent == null else {"kind": parent["kind"], "id": as_int(parent["id"])},
		"children": int_list(item["children"]), "visible": item["visible"],
		"draw_index": as_int(item["draw_index"]), "z_index": as_int(item["z_index"]),
		"z_relative": item["z_relative"], "behind": item["behind"], "clip": item["clip"],
		"custom_rect": item["custom_rect"], "visibility_layer": as_int(item["visibility_layer"]),
		"texture_filter": item["texture_filter"], "texture_repeat": item["texture_repeat"],
		"content_version": as_int(item["content_version"]),
		"xform": [item_f32[0], item_f32[1], item_f32[2], item_f32[3], item_f32[4], item_f32[5]],
		"modulate": [item_f32[6], item_f32[7], item_f32[8], item_f32[9]],
		"self_modulate": [item_f32[10], item_f32[11], item_f32[12], item_f32[13]],
		"custom_rect_rect": [item_f32[14], item_f32[15], item_f32[16], item_f32[17]],
		"commands": commands,
	}


static func _lift_canvas(canvas: Dictionary, canvas_f32: PackedFloat32Array) -> Dictionary:
	return {
		"id": as_int(canvas["id"]), "origin": canvas["origin"], "role": canvas["role"],
		"attached": canvas["attached"], "items": int_list(canvas["items"]),
		"xform": [canvas_f32[0], canvas_f32[1], canvas_f32[2], canvas_f32[3], canvas_f32[4], canvas_f32[5]],
	}


## render-stream-4.md "Mesh table": lifts one wire mesh entry, resolving "f" to the actual
## custom_aabb values (6 floats from mesh_f32; all zero, with "f" null, exactly for "freed").
static func _lift_mesh(m: Dictionary, mesh_f32: PackedFloat32Array) -> Dictionary:
	var f: Variant = m["f"]
	var custom_aabb: Array
	if f == null:
		custom_aabb = [0.0, 0.0, 0.0, 0.0, 0.0, 0.0]
	else:
		var fi: int = as_int(f)
		custom_aabb = [mesh_f32[fi], mesh_f32[fi + 1], mesh_f32[fi + 2], mesh_f32[fi + 3], mesh_f32[fi + 4], mesh_f32[fi + 5]]
	return {
		"id": as_int(m["id"]), "origin": m["origin"], "status": m["status"], "reason": m["reason"],
		"version": as_int(m["version"]), "custom_aabb": custom_aabb, "surfaces": m["surfaces"],
	}


static func _command_float_count(command: Dictionary) -> int:
	var op: String = command["op"]
	if op == "add_rect" or op == "add_texture_rect":
		return 8
	if op == "add_texture_rect_region":
		return 12
	if op == "add_msdf_texture_rect_region":
		return 14
	if op == "add_line":
		return 9
	if op == "add_polyline" or op == "add_multiline":
		return 1 + 2 * as_int(command["n"]) + 4 * as_int(command["colors"])
	if op == "add_circle":
		return 7
	if op == "add_primitive" or op == "add_polygon":
		return 2 * as_int(command["n"]) + 4 * as_int(command["colors"]) + 2 * as_int(command["uvs"])
	if op == "add_triangle_array":
		return 2 * as_int(command["n"]) + 4 * as_int(command["colors"]) + 2 * as_int(command["uvs"])
	if op == "add_nine_patch":
		return 16
	if op == "add_mesh":
		return 10
	if op == "add_set_transform":
		return 6
	return 0


## add_triangle_array is the only /4 op with an "i" (cmd_i32 offset) key.
static func _command_int_count(command: Dictionary) -> int:
	if command["op"] == "add_triangle_array":
		return as_int(command["indices"])
	return 0


## The RenderingServer method name a derived unsupported-texture entry names for a tex-bearing
## wire op (render-stream-2.md "Item-level unsupported entries", extended at /4 for the new ops).
static func _rs_method_for_op(op: String) -> String:
	match op:
		"add_texture_rect":
			return "canvas_item_add_texture_rect"
		"add_texture_rect_region":
			return "canvas_item_add_texture_rect_region"
		"add_msdf_texture_rect_region":
			return "canvas_item_add_msdf_texture_rect_region"
		"add_primitive":
			return "canvas_item_add_primitive"
		"add_polygon":
			return "canvas_item_add_polygon"
		"add_triangle_array":
			return "canvas_item_add_triangle_array"
		"add_nine_patch":
			return "canvas_item_add_nine_patch"
		"add_mesh":
			return "canvas_item_add_mesh"
	return op


## True when `cur`'s version/content is an invalid continuation of `previous` (texture-version:
## "within one stream, an id's version never decreases; at an equal version the entry is
## identical except for a change to status: 'freed' and the nulls that implies").
static func _texture_version_regressed(previous: Variant, cur: Dictionary) -> bool:
	if previous == null:
		return false
	var prev: Dictionary = previous
	var prev_version: int = as_int(prev["version"])
	var cur_version: int = as_int(cur["version"])
	if cur_version < prev_version:
		return true
	if cur_version > prev_version:
		return false
	if _dicts_equal(prev, cur):
		return false
	if prev["status"] == "freed" or cur["status"] != "freed":
		return true
	return false


## render-stream-4.md "Mesh table" ("mesh-version"): the texture-version rule, mirrored for
## meshes. Takes the LIFTED (resolved) mesh, not the raw wire entry: "f" is a running offset into
## that transaction's own mesh_f32 block, so it legitimately differs between two transactions
## whose mesh content is byte-identical whenever some other mesh earlier in the table gains or
## loses its own "f" span (e.g. a sibling mesh is freed) -- _lift_mesh() already resolves that
## away into an actual custom_aabb, so comparing the lifted forms avoids a false "regressed".
static func _mesh_version_regressed(previous: Variant, cur: Dictionary) -> bool:
	if previous == null:
		return false
	var prev: Dictionary = previous
	var prev_version: int = as_int(prev["version"])
	var cur_version: int = as_int(cur["version"])
	if cur_version < prev_version:
		return true
	if cur_version > prev_version:
		return false
	if _dicts_equal(prev, cur):
		return false
	if prev["status"] == "freed" or cur["status"] != "freed":
		return true
	return false


static func _dicts_equal(a: Dictionary, b: Dictionary) -> bool:
	if a.keys() != b.keys():
		return false
	for key: Variant in a.keys():
		var av: Variant = a[key]
		var bv: Variant = b[key]
		if typeof(av) == TYPE_DICTIONARY and typeof(bv) == TYPE_DICTIONARY:
			var av_dict: Dictionary = av
			var bv_dict: Dictionary = bv
			if not _dicts_equal(av_dict, bv_dict):
				return false
		elif av != bv:
			return false
	return true


# --------------------------------------------------------------------------- whole recording


static func validate_recording(data: PackedByteArray, version: int = 4) -> PackedStringArray:
	var errors := PackedStringArray()
	var split: Dictionary = split_records(data, version)
	var records: Array[Dictionary] = split["records"]
	var split_errors: PackedStringArray = split["errors"]
	if split_errors.size() > 0 and code_of(split_errors[0]) == "bad-magic":
		return split_errors
	var stream := Stream.new(version)
	for index: int in records.size():
		var raw: Dictionary = records[index]
		var record: Dictionary = decode_record(data, as_int(raw["offset"]), version)
		var record_errors: PackedStringArray = record["errors"]
		if record_errors.size() > 0:
			for e: String in record_errors:
				errors.append("%s (record %d)" % [e, index])
			return errors
		errors.append_array(stream.accept(data, record))
		if errors.size() > 0:
			return errors
		if stream.end_seen:
			var end_at: int = as_int(record["offset"]) + as_int(record["byte_length"])
			if end_at < data.size():
				errors.append(err("trailing-bytes", "%d bytes follow the end record at offset %d" % [data.size() - end_at, as_int(record["offset"])]))
			return errors
	errors.append_array(split_errors)
	errors.append_array(stream.finish())
	return errors


class Stream:
	extends RefCounted

	var canvases: Dictionary = {}   # int -> resolved canvas Dictionary
	var items: Dictionary = {}      # int -> resolved item Dictionary
	var textures: Dictionary = {}   # int -> wire texture entry Dictionary
	var meshes: Dictionary = {}     # int -> resolved mesh Dictionary (custom_aabb lifted); /4 only
	var default_texture_filter: String = "nearest"
	var default_texture_repeat: String = "disabled"

	## render-stream-4.md (G5w): 2, 3 or 4. `Stream.new()` with no args defaults to 4 since G5d,
	## matching this file's module-wide default (3 from G4e2 to G5d).
	var version: int = 4

	func _init(v: int = 4) -> void:
		version = v

	var records_accepted: int = 0
	var session_seen: bool = false
	var end_seen: bool = false
	var last_seq: int = 0
	var last_frame: int = 0
	var transactions: int = 0
	var full_transactions: int = 0
	var patch_transactions: int = 0
	var max_record_bytes: int = 0
	var bytes_total: int = 8
	var session_encoding: String = ""
	var inline_max_bytes: int = 0
	var resource_records: int = 0
	var resource_bytes: int = 0
	var _max_item_id: int = 0
	var _max_canvas_id: int = 0
	var _max_texture_id: int = 0
	var _max_mesh_id: int = 0
	var _carried_hashes: Dictionary[String, bool] = {}
	var _resource_shapes: Dictionary = {}   # hash -> decoded GRT1 payload shape Dictionary
	var _mesh_resource_shapes: Dictionary = {}  # hash -> decoded GRM1 payload shape Dictionary; /4 only
	var _last_seen_texture: Dictionary = {}  # id -> wire texture entry Dictionary
	var _last_seen_mesh: Dictionary = {}     # id -> resolved mesh Dictionary; /4 only

	func accept(data: PackedByteArray, record: Dictionary) -> PackedStringArray:
		var errors := PackedStringArray()
		var meta: Dictionary = record["meta"]
		var kind: String = meta["type"]
		var offset: int = Rs2Decoder.as_int(record["offset"])
		var byte_length: int = Rs2Decoder.as_int(record["byte_length"])
		var index: int = records_accepted
		records_accepted += 1
		if end_seen:
			errors.append(Rs2Decoder.err("trailing-bytes", "record %d at offset %d follows the end record" % [index, offset]))
			return errors
		if index == 0 and kind != "session":
			errors.append(Rs2Decoder.err("missing-session", "the first record is a %s, not a session" % kind))
			return errors
		match kind:
			"session":
				if index != 0:
					errors.append(Rs2Decoder.err("duplicate-session", "record %d at offset %d is a second session" % [index, offset]))
					return errors
				session_seen = true
				var stream_meta: Dictionary = meta["stream"]
				session_encoding = stream_meta["encoding"]
				var resources_meta: Dictionary = meta["resources"]
				inline_max_bytes = Rs2Decoder.as_int(resources_meta["inline_max_bytes"])
				if Rs2Decoder.as_int(meta["viewport"]["root_canvas"]) != 1:
					errors.append(Rs2Decoder.err("root-canvas", "session.viewport.root_canvas is %d, not 1" % Rs2Decoder.as_int(meta["viewport"]["root_canvas"])))
					return errors
				bytes_total += byte_length
				max_record_bytes = maxi(max_record_bytes, byte_length)
			"resource":
				var hash: String = meta["hash"]
				if _carried_hashes.has(hash):
					errors.append(Rs2Decoder.err("resource-duplicate", "record %d at offset %d: hash %s already carried earlier in this stream" % [index, offset, hash]))
					return errors
				var payload: PackedByteArray = Rs2Decoder.raw_resource_payload(data, record)
				var actual_hash: String = Rs2Decoder.sha256_hex(payload)
				if actual_hash != hash:
					errors.append(Rs2Decoder.err("resource-hash", "record %d at offset %d: payload sha256 %s disagrees with declared hash %s" % [index, offset, actual_hash, hash]))
					return errors
				# render-stream-4.md "Resources": mesh (GRM1) and texture (GRT1) payloads share
				# one hash namespace and one resource record shape; tell them apart by magic.
				var is_mesh_payload: bool = version == 4 and payload.size() >= 8 and payload.slice(0, 8).hex_encode() == RsMeshPayload.GRM1_MAGIC_HEX
				if is_mesh_payload:
					var mesh_decoded: Dictionary = RsMeshPayload.decode(payload)
					if not mesh_decoded["ok"]:
						var mesh_payload_code: String = mesh_decoded["code"]
						var mesh_payload_detail: String = mesh_decoded["detail"]
						errors.append(Rs2Decoder.err(mesh_payload_code, "record %d at offset %d: %s" % [index, offset, mesh_payload_detail]))
						return errors
					mesh_decoded["payload_length"] = payload.size()
					_mesh_resource_shapes[hash] = mesh_decoded
				else:
					var decoded: Dictionary = RsTexturePayload.decode(payload)
					if not decoded["ok"]:
						var payload_code: String = decoded["code"]
						var payload_detail: String = decoded["detail"]
						errors.append(Rs2Decoder.err(payload_code, "record %d at offset %d: %s" % [index, offset, payload_detail]))
						return errors
					decoded["payload_length"] = payload.size()
					_resource_shapes[hash] = decoded
				_carried_hashes[hash] = true
				resource_records += 1
				resource_bytes += Rs2Decoder.as_int(meta["bytes"])
				bytes_total += byte_length
				max_record_bytes = maxi(max_record_bytes, byte_length)
			"transaction":
				var record_blocks: Array = record["blocks"]
				errors.append_array(_accept_transaction(meta, offset, record_blocks))
				if errors.is_empty():
					bytes_total += byte_length
					max_record_bytes = maxi(max_record_bytes, byte_length)
			"end":
				end_seen = true
				var counted: int = Rs2Decoder.as_int(meta["transactions"])
				if counted != transactions:
					errors.append(Rs2Decoder.err("end-count-mismatch", "end record says %d transactions, the recording has %d" % [counted, transactions]))
					return errors
				var stats: Dictionary = meta["stats"]
				var declared_bytes: int = Rs2Decoder.as_int(stats["bytes_total"])
				if declared_bytes != bytes_total:
					errors.append(Rs2Decoder.err("end-stats-mismatch", "stats.bytes_total is %d, the recording's own total is %d" % [declared_bytes, bytes_total]))
					return errors
				var max_bytes: int = Rs2Decoder.as_int(stats["max_record_bytes"])
				if max_bytes != max_record_bytes:
					errors.append(Rs2Decoder.err("end-stats-mismatch", "stats.max_record_bytes is %d, the largest earlier record is %d bytes" % [max_bytes, max_record_bytes]))
					return errors
				var declared_full: int = Rs2Decoder.as_int(stats["full_transactions"])
				var declared_patch: int = Rs2Decoder.as_int(stats["patch_transactions"])
				if declared_full != full_transactions or declared_patch != patch_transactions or declared_full + declared_patch != counted:
					errors.append(Rs2Decoder.err("end-stats-mismatch", "stats full/patch_transactions (%d, %d) disagree with the recording (%d, %d)" % [declared_full, declared_patch, full_transactions, patch_transactions]))
					return errors
				var declared_rr: int = Rs2Decoder.as_int(stats["resource_records"])
				var declared_rb: int = Rs2Decoder.as_int(stats["resource_bytes"])
				if declared_rr != resource_records or declared_rb != resource_bytes:
					errors.append(Rs2Decoder.err("end-stats-mismatch", "stats resource_records/resource_bytes (%d, %d) disagree with the recording (%d, %d)" % [declared_rr, declared_rb, resource_records, resource_bytes]))
					return errors
		return errors

	func finish() -> PackedStringArray:
		var errors := PackedStringArray()
		if records_accepted == 0:
			errors.append(Rs2Decoder.err("missing-session", "the recording has no records"))
		if not end_seen:
			errors.append(Rs2Decoder.err("recording-incomplete", "the input ends after %d records without an end record" % records_accepted))
		return errors

	func _accept_transaction(meta: Dictionary, offset: int, blocks: Array) -> PackedStringArray:
		var errors := PackedStringArray()
		var is_v4: bool = version == 4
		var seq: int = Rs2Decoder.as_int(meta["seq"])
		var frame: int = Rs2Decoder.as_int(meta["frame"])
		var encoding: String = meta["encoding"]
		var canvases_meta: Array = meta["canvases"]
		var items_meta: Array = meta["items"]
		var textures_meta: Array = meta["textures"]
		var meshes_meta: Array = []
		if is_v4:
			meshes_meta = meta["meshes"]
		var removed_canvases: Array[int] = Rs2Decoder.int_list(meta["removed_canvases"])
		var removed_items: Array[int] = Rs2Decoder.int_list(meta["removed_items"])
		var removed_textures: Array[int] = Rs2Decoder.int_list(meta["removed_textures"])
		var removed_meshes: Array[int] = []
		if is_v4:
			removed_meshes = Rs2Decoder.int_list(meta["removed_meshes"])

		var canvas_order_error: String = Rs2Decoder._check_id_ordering("canvases", canvases_meta, seq)
		if canvas_order_error != "":
			errors.append(canvas_order_error)
			return errors
		var item_order_error: String = Rs2Decoder._check_id_ordering("items", items_meta, seq)
		if item_order_error != "":
			errors.append(item_order_error)
			return errors
		var texture_order_error: String = Rs2Decoder._check_id_ordering("textures", textures_meta, seq)
		if texture_order_error != "":
			errors.append(texture_order_error)
			return errors
		var rc_order: String = Rs2Decoder._check_id_list_ascending("removed_canvases", removed_canvases, seq)
		if rc_order != "":
			errors.append(rc_order)
			return errors
		var ri_order: String = Rs2Decoder._check_id_list_ascending("removed_items", removed_items, seq)
		if ri_order != "":
			errors.append(ri_order)
			return errors
		var rt_order: String = Rs2Decoder._check_id_list_ascending("removed_textures", removed_textures, seq)
		if rt_order != "":
			errors.append(rt_order)
			return errors
		if is_v4:
			var mesh_order_error: String = Rs2Decoder._check_id_ordering("meshes", meshes_meta, seq)
			if mesh_order_error != "":
				errors.append(mesh_order_error)
				return errors
			var rm_order: String = Rs2Decoder._check_id_list_ascending("removed_meshes", removed_meshes, seq)
			if rm_order != "":
				errors.append(rm_order)
				return errors

		if seq != last_seq + 1:
			errors.append(Rs2Decoder.err("seq-gap", "transaction at offset %d has seq %d, expected %d" % [offset, seq, last_seq + 1]))
			return errors

		var patch_error: String = _check_patch_rules(encoding, seq, meta, removed_canvases, removed_items, removed_textures, removed_meshes, canvases_meta, items_meta, textures_meta, meshes_meta, is_v4)
		if patch_error != "":
			errors.append(patch_error)
			return errors
		if frame <= last_frame:
			errors.append(Rs2Decoder.err("frame-order", "transaction seq %d has frame %d, not after %d" % [seq, frame, last_frame]))
			return errors

		var item_f32: PackedFloat32Array = blocks[0]
		var canvas_f32: PackedFloat32Array = blocks[1]
		var cmd_f32: PackedFloat32Array = blocks[2]
		var cmd_i32: PackedInt32Array = PackedInt32Array()
		var mesh_f32: PackedFloat32Array = PackedFloat32Array()
		if is_v4:
			cmd_i32 = blocks[3]
			mesh_f32 = blocks[4]
		var running: int = 0
		var running_int: int = 0
		for value: Variant in items_meta:
			var item: Dictionary = value
			if item["commands"] == null:
				continue
			var commands: Array = item["commands"]
			for cvalue: Variant in commands:
				var command: Dictionary = cvalue
				var cmd_op: String = command["op"]
				# "unsupported" and "add_clip_ignore" carry no floats and no "f" key at all.
				if cmd_op == "unsupported" or cmd_op == "add_clip_ignore":
					continue
				var fcount: int = Rs2Decoder._command_float_count(command)
				var f: int = Rs2Decoder.as_int(command["f"])
				if f != running:
					errors.append(Rs2Decoder.err("cmd-offset", "seq %d: %s f=%d, expected %d" % [seq, command["op"], f, running]))
					return errors
				running += fcount
				if cmd_op == "add_triangle_array":
					var i_off: int = Rs2Decoder.as_int(command["i"])
					if i_off != running_int:
						errors.append(Rs2Decoder.err("cmd-int-offset", "seq %d: %s i=%d, expected %d" % [seq, cmd_op, i_off, running_int]))
						return errors
					running_int += Rs2Decoder._command_int_count(command)
		var running_mesh: int = 0
		if is_v4:
			for value: Variant in meshes_meta:
				var m: Dictionary = value
				var mf: Variant = m["f"]
				if mf == null:
					continue
				var mfi: int = Rs2Decoder.as_int(mf)
				if mfi != running_mesh:
					errors.append(Rs2Decoder.err("mesh-offset", "seq %d: mesh %d f=%d, expected %d" % [seq, Rs2Decoder.as_int(m["id"]), mfi, running_mesh]))
					return errors
				running_mesh += 6
		if item_f32.size() != Rs2Decoder.ITEM_FLOATS * items_meta.size() or canvas_f32.size() != Rs2Decoder.CANVAS_FLOATS * canvases_meta.size() or cmd_f32.size() != running or (is_v4 and (cmd_i32.size() != running_int or mesh_f32.size() != running_mesh)):
			errors.append(Rs2Decoder.err("block-count", "seq %d: decoded block lengths disagree with items/canvases/commands/meshes counts" % seq))
			return errors

		var failures: Array = meta["failures"]
		var status: String = meta["status"]
		if (status == "capture-failure") != (failures.size() > 0):
			errors.append(Rs2Decoder.err("meta-schema", "seq %d: status %s with %d failures" % [seq, status, failures.size()]))
			return errors

		if encoding == "full":
			canvases = {}
			items = {}
			textures = {}
			if is_v4:
				meshes = {}
		for id: int in removed_canvases:
			canvases.erase(id)
		for id: int in removed_items:
			items.erase(id)
		for id: int in removed_textures:
			textures.erase(id)
		if is_v4:
			for id: int in removed_meshes:
				meshes.erase(id)
		for i: int in canvases_meta.size():
			var canvas: Dictionary = canvases_meta[i]
			var lifted: Dictionary = Rs2Decoder._lift_canvas(canvas, canvas_f32.slice(i * Rs2Decoder.CANVAS_FLOATS, (i + 1) * Rs2Decoder.CANVAS_FLOATS))
			canvases[Rs2Decoder.as_int(canvas["id"])] = lifted
		for i: int in items_meta.size():
			var item: Dictionary = items_meta[i]
			var id: int = Rs2Decoder.as_int(item["id"])
			var lifted_item: Dictionary = Rs2Decoder._lift_item(item, item_f32.slice(i * Rs2Decoder.ITEM_FLOATS, (i + 1) * Rs2Decoder.ITEM_FLOATS), cmd_f32, cmd_i32)
			if item["commands"] == null:
				var base_commands: Array = []
				if items.has(id):
					var base_item: Dictionary = items[id]
					base_commands = base_item["commands"]
				lifted_item["commands"] = base_commands
			items[id] = lifted_item
		for value: Variant in textures_meta:
			var t: Dictionary = value
			textures[Rs2Decoder.as_int(t["id"])] = t
		if is_v4:
			for value: Variant in meshes_meta:
				var m2: Dictionary = value
				meshes[Rs2Decoder.as_int(m2["id"])] = Rs2Decoder._lift_mesh(m2, mesh_f32)
		default_texture_filter = meta["default_texture_filter"]
		default_texture_repeat = meta["default_texture_repeat"]

		# texture-version / mesh-version, across the whole stream so far.
		for value: Variant in textures_meta:
			var t: Dictionary = value
			var id: int = Rs2Decoder.as_int(t["id"])
			var previous: Variant = _last_seen_texture.get(id)
			if Rs2Decoder._texture_version_regressed(previous, t):
				errors.append(Rs2Decoder.err("texture-version", "seq %d: texture %d's version/content is inconsistent with its earlier entry" % [seq, id]))
				return errors
			_last_seen_texture[id] = t
		if is_v4:
			for value: Variant in meshes_meta:
				var m3: Dictionary = value
				var mid: int = Rs2Decoder.as_int(m3["id"])
				var lifted_mesh: Dictionary = meshes[mid]
				var mesh_previous: Variant = _last_seen_mesh.get(mid)
				if Rs2Decoder._mesh_version_regressed(mesh_previous, lifted_mesh):
					errors.append(Rs2Decoder.err("mesh-version", "seq %d: mesh %d's version/content is inconsistent with its earlier entry" % [seq, mid]))
					return errors
				_last_seen_mesh[mid] = lifted_mesh

		var unsupported_meta: Array = meta["unsupported"]
		var resolved_error: String = _check_resolved_invariants(seq, unsupported_meta, is_v4)
		if resolved_error != "":
			errors.append(resolved_error)
			return errors

		# resource-missing / resource-payload, over the RESOLVED table (every ok image entry, and,
		# at /4, every ok mesh surface).
		for id: int in textures:
			var t: Dictionary = textures[id]
			if t["kind"] != "image" or t["status"] != "ok" or t["hash"] == null:
				continue
			var hash: String = t["hash"]
			var payload_bytes: int = Rs2Decoder.as_int(t["payload_bytes"])
			if payload_bytes > inline_max_bytes:
				continue
			if not _carried_hashes.has(hash):
				errors.append(Rs2Decoder.err("resource-missing", "seq %d: texture %d's hash %s (payload_bytes %d <= inline_max_bytes %d) never arrived as a resource record" % [seq, id, hash, payload_bytes, inline_max_bytes]))
				return errors
			if _resource_shapes.has(hash):
				var shape: Dictionary = _resource_shapes[hash]
				# payload_bytes is the whole payload's length (render-stream-2.md "Texture"), not its data.
				var payload_length: int = Rs2Decoder.as_int(shape["payload_length"])
				if shape["format"] != t["format"] or Rs2Decoder.as_int(shape["width"]) != Rs2Decoder.as_int(t["width"]) or Rs2Decoder.as_int(shape["height"]) != Rs2Decoder.as_int(t["height"]) or shape["mipmaps"] != t["mipmaps"] or payload_length != payload_bytes:
					errors.append(Rs2Decoder.err("resource-payload", "seq %d: the resource for hash %s decodes as %s %dx%d, texture %d declares %s %dx%d" % [seq, hash, shape["format"], Rs2Decoder.as_int(shape["width"]), Rs2Decoder.as_int(shape["height"]), id, t["format"], Rs2Decoder.as_int(t["width"]), Rs2Decoder.as_int(t["height"])]))
					return errors
		if is_v4:
			for mid2: int in meshes:
				var m4: Dictionary = meshes[mid2]
				if m4["status"] != "ok":
					continue
				var surfaces: Array = m4["surfaces"]
				for value: Variant in surfaces:
					var s: Dictionary = value
					var shash: String = s["hash"]
					var spayload_bytes: int = Rs2Decoder.as_int(s["payload_bytes"])
					if spayload_bytes > inline_max_bytes:
						continue
					if not _carried_hashes.has(shash):
						errors.append(Rs2Decoder.err("resource-missing", "seq %d: mesh %d's surface hash %s (payload_bytes %d <= inline_max_bytes %d) never arrived as a resource record" % [seq, mid2, shash, spayload_bytes, inline_max_bytes]))
						return errors
					if _mesh_resource_shapes.has(shash):
						var mshape: Dictionary = _mesh_resource_shapes[shash]
						var mpayload_length: int = Rs2Decoder.as_int(mshape["payload_length"])
						if mshape["primitive"] != s["primitive"] or Rs2Decoder.as_int(mshape["format"]) != Rs2Decoder.as_int(s["format"]) or Rs2Decoder.as_int(mshape["vertex_count"]) != Rs2Decoder.as_int(s["vertex_count"]) or Rs2Decoder.as_int(mshape["index_count"]) != Rs2Decoder.as_int(s["index_count"]) or mpayload_length != spayload_bytes:
							errors.append(Rs2Decoder.err("resource-payload", "seq %d: the resource for hash %s decodes as %s vertex_count %d, mesh %d declares %s vertex_count %d" % [seq, shash, mshape["primitive"], Rs2Decoder.as_int(mshape["vertex_count"]), mid2, s["primitive"], Rs2Decoder.as_int(s["vertex_count"])]))
							return errors

		# id-reused.
		var new_canvas_ids: Array[int] = []
		for value: Variant in canvases_meta:
			var c: Dictionary = value
			new_canvas_ids.append(Rs2Decoder.as_int(c["id"]))
		var new_item_ids: Array[int] = []
		for value: Variant in items_meta:
			var it: Dictionary = value
			new_item_ids.append(Rs2Decoder.as_int(it["id"]))
		var new_texture_ids: Array[int] = []
		for value: Variant in textures_meta:
			var t2: Dictionary = value
			new_texture_ids.append(Rs2Decoder.as_int(t2["id"]))
		for id: int in new_canvas_ids:
			if id <= _max_canvas_id and not _known_canvas_ids.has(id):
				errors.append(Rs2Decoder.err("id-reused", "transaction seq %d: canvas id %d is absent from the previous transaction and not above %d" % [seq, id, _max_canvas_id]))
				return errors
		for id: int in new_item_ids:
			if id <= _max_item_id and not _known_item_ids.has(id):
				errors.append(Rs2Decoder.err("id-reused", "transaction seq %d: item id %d is absent from the previous transaction and not above %d" % [seq, id, _max_item_id]))
				return errors
		for id: int in new_texture_ids:
			if id <= _max_texture_id and not _known_texture_ids.has(id):
				errors.append(Rs2Decoder.err("id-reused", "transaction seq %d: texture id %d is absent from the previous transaction and not above %d" % [seq, id, _max_texture_id]))
				return errors
		if is_v4:
			var new_mesh_ids: Array[int] = []
			for value: Variant in meshes_meta:
				var m5: Dictionary = value
				new_mesh_ids.append(Rs2Decoder.as_int(m5["id"]))
			for id: int in new_mesh_ids:
				if id <= _max_mesh_id and not _known_mesh_ids.has(id):
					errors.append(Rs2Decoder.err("id-reused", "transaction seq %d: mesh id %d is absent from the previous transaction and not above %d" % [seq, id, _max_mesh_id]))
					return errors
		_known_canvas_ids = {}
		for id: int in canvases:
			_known_canvas_ids[id] = true
			_max_canvas_id = maxi(_max_canvas_id, id)
		_known_item_ids = {}
		for id: int in items:
			_known_item_ids[id] = true
			_max_item_id = maxi(_max_item_id, id)
		_known_texture_ids = {}
		for id: int in textures:
			_known_texture_ids[id] = true
			_max_texture_id = maxi(_max_texture_id, id)
		if is_v4:
			_known_mesh_ids = {}
			for id: int in meshes:
				_known_mesh_ids[id] = true
				_max_mesh_id = maxi(_max_mesh_id, id)

		last_seq = seq
		last_frame = frame
		transactions += 1
		if encoding == "full":
			full_transactions += 1
		else:
			patch_transactions += 1
		return errors

	var _known_canvas_ids: Dictionary[int, bool] = {}
	var _known_item_ids: Dictionary[int, bool] = {}
	var _known_texture_ids: Dictionary[int, bool] = {}
	var _known_mesh_ids: Dictionary[int, bool] = {}

	func _check_patch_rules(encoding: String, seq: int, meta: Dictionary, removed_canvases: Array[int], removed_items: Array[int], removed_textures: Array[int], removed_meshes: Array[int], canvases_meta: Array, items_meta: Array, textures_meta: Array, meshes_meta: Array, is_v4: bool) -> String:
		if encoding == "full":
			var base_seq: Variant = meta["base_seq"]
			if base_seq != null or removed_canvases.size() > 0 or removed_items.size() > 0 or removed_textures.size() > 0 or (is_v4 and removed_meshes.size() > 0):
				return Rs2Decoder.err("patch-encoding", "seq %d: a full transaction carries a non-null base_seq or a non-empty removed list" % seq)
			return ""
		if session_encoding == "full":
			return Rs2Decoder.err("patch-encoding", "seq %d: a patch transaction in a stream whose session says encoding \"full\"" % seq)
		if transactions == 0:
			return Rs2Decoder.err("patch-base", "seq %d: the stream's first transaction is a patch" % seq)
		var base_seq: int = Rs2Decoder.as_int(meta["base_seq"])
		if base_seq != last_seq:
			return Rs2Decoder.err("patch-base", "seq %d: base_seq %d is not the previous transaction's seq %d" % [seq, base_seq, last_seq])

		var removed_canvas_set: Dictionary[int, bool] = {}
		for id: int in removed_canvases:
			if removed_canvas_set.has(id):
				return Rs2Decoder.err("patch-removed", "seq %d: canvas %d is removed twice" % [seq, id])
			removed_canvas_set[id] = true
			if not canvases.has(id):
				return Rs2Decoder.err("patch-removed", "seq %d: removed canvas %d is absent from the base" % [seq, id])
		var removed_item_set: Dictionary[int, bool] = {}
		for id: int in removed_items:
			if removed_item_set.has(id):
				return Rs2Decoder.err("patch-removed", "seq %d: item %d is removed twice" % [seq, id])
			removed_item_set[id] = true
			if not items.has(id):
				return Rs2Decoder.err("patch-removed", "seq %d: removed item %d is absent from the base" % [seq, id])
		var removed_texture_set: Dictionary[int, bool] = {}
		for id: int in removed_textures:
			if removed_texture_set.has(id):
				return Rs2Decoder.err("patch-removed", "seq %d: texture %d is removed twice" % [seq, id])
			removed_texture_set[id] = true
			if not textures.has(id):
				return Rs2Decoder.err("patch-removed", "seq %d: removed texture %d is absent from the base" % [seq, id])
		for value: Variant in canvases_meta:
			var c: Dictionary = value
			var id: int = Rs2Decoder.as_int(c["id"])
			if removed_canvas_set.has(id):
				return Rs2Decoder.err("patch-removed", "seq %d: canvas %d is both removed and present" % [seq, id])
		for value: Variant in items_meta:
			var it: Dictionary = value
			var id: int = Rs2Decoder.as_int(it["id"])
			if removed_item_set.has(id):
				return Rs2Decoder.err("patch-removed", "seq %d: item %d is both removed and present" % [seq, id])
		for value: Variant in textures_meta:
			var t: Dictionary = value
			var id: int = Rs2Decoder.as_int(t["id"])
			if removed_texture_set.has(id):
				return Rs2Decoder.err("patch-removed", "seq %d: texture %d is both removed and present" % [seq, id])
		if is_v4:
			var removed_mesh_set: Dictionary[int, bool] = {}
			for id: int in removed_meshes:
				if removed_mesh_set.has(id):
					return Rs2Decoder.err("patch-removed", "seq %d: mesh %d is removed twice" % [seq, id])
				removed_mesh_set[id] = true
				if not meshes.has(id):
					return Rs2Decoder.err("patch-removed", "seq %d: removed mesh %d is absent from the base" % [seq, id])
			for value: Variant in meshes_meta:
				var m: Dictionary = value
				var mid: int = Rs2Decoder.as_int(m["id"])
				if removed_mesh_set.has(mid):
					return Rs2Decoder.err("patch-removed", "seq %d: mesh %d is both removed and present" % [seq, mid])

		for value: Variant in items_meta:
			var it: Dictionary = value
			var id: int = Rs2Decoder.as_int(it["id"])
			if it["commands"] != null:
				continue
			if not items.has(id):
				return Rs2Decoder.err("patch-commands", "seq %d: item %d is new but carries commands:null" % [seq, id])
			var base: Dictionary = items[id]
			var base_cv: int = Rs2Decoder.as_int(base["content_version"])
			var cur_cv: int = Rs2Decoder.as_int(it["content_version"])
			if base_cv != cur_cv:
				return Rs2Decoder.err("patch-commands", "seq %d: item %d's content_version changed but it carries commands:null" % [seq, id])
		return ""

	func _texture_entry_field_error(t: Dictionary) -> String:
		var id: int = Rs2Decoder.as_int(t["id"])
		var kind: String = t["kind"]
		var status: String = t["status"]
		var tag: String = "texture %d: " % id
		if status == "freed":
			if t["hash"] != null or t["format"] != null or Rs2Decoder.as_int(t["width"]) != 0 or Rs2Decoder.as_int(t["height"]) != 0 or t["mipmaps"] != false or Rs2Decoder.as_int(t["payload_bytes"]) != 0 or t["canvas"] != null or t["reason"] != null:
				return tag + "a \"freed\" entry must have hash/format/canvas/reason null and width/height/payload_bytes 0, mipmaps false"
			return ""
		if kind == "image":
			if t["canvas"] != null:
				return tag + "kind \"image\" must have canvas null"
			if status == "ok":
				if t["hash"] == null or t["format"] == null or Rs2Decoder.as_int(t["width"]) < 1 or Rs2Decoder.as_int(t["height"]) < 1 or Rs2Decoder.as_int(t["payload_bytes"]) < 1 or t["reason"] != null:
					return tag + "kind \"image\" status \"ok\" needs a hex hash, a format, width/height >= 1, payload_bytes >= 1 and reason null"
			else:
				if t["hash"] != null or Rs2Decoder.as_int(t["payload_bytes"]) != 0 or t["reason"] == null:
					return tag + "kind \"image\" status \"unsupported\" needs hash null, payload_bytes 0 and a non-null reason"
			return ""
		if kind == "placeholder":
			if t["hash"] != null or t["format"] != null or Rs2Decoder.as_int(t["width"]) != 0 or Rs2Decoder.as_int(t["height"]) != 0 or t["mipmaps"] != false or Rs2Decoder.as_int(t["payload_bytes"]) != 0 or t["canvas"] != null:
				return tag + "kind \"placeholder\" must have hash/format/canvas null and width/height/payload_bytes 0, mipmaps false"
			if status == "ok" and t["reason"] != null:
				return tag + "kind \"placeholder\" status \"ok\" must have reason null"
			if status == "unsupported" and t["reason"] == null:
				return tag + "kind \"placeholder\" status \"unsupported\" must have a non-null reason"
			return ""
		# kind == "canvas"
		if t["hash"] != null or t["format"] != null or Rs2Decoder.as_int(t["width"]) != 0 or Rs2Decoder.as_int(t["height"]) != 0 or t["mipmaps"] != false or Rs2Decoder.as_int(t["payload_bytes"]) != 0 or t["canvas"] == null:
			return tag + "kind \"canvas\" must have hash/format null, width/height/payload_bytes 0, mipmaps false, and a non-null canvas"
		if status == "ok" and t["reason"] != null:
			return tag + "kind \"canvas\" status \"ok\" must have reason null"
		if status == "unsupported" and t["reason"] == null:
			return tag + "kind \"canvas\" status \"unsupported\" must have a non-null reason"
		return ""

	## render-stream-4.md "Mesh table" ("mesh-entry"): the same shape rule
	## _texture_entry_field_error() checks, mirrored for a mesh entry's status/reason/surfaces
	## coupling (the lifted mesh dict has no "f"/custom_aabb coupling to check here).
	func _mesh_entry_field_error(m: Dictionary) -> String:
		var id: int = Rs2Decoder.as_int(m["id"])
		var status: String = m["status"]
		var tag: String = "mesh %d: " % id
		var surfaces: Array = m["surfaces"]
		if status == "freed":
			if m["reason"] != null or surfaces.size() > 0:
				return tag + "a \"freed\" entry must have reason null and surfaces []"
			return ""
		if status == "unsupported":
			if m["reason"] == null or surfaces.size() > 0:
				return tag + "an \"unsupported\" entry needs a non-null reason and surfaces []"
			return ""
		# "ok"
		if m["reason"] != null:
			return tag + "an \"ok\" entry must have reason null"
		return ""

	func _check_resolved_invariants(seq: int, unsupported_meta: Array, is_v4: bool) -> String:
		var where: String = "transaction seq %d" % seq
		var canvas_ids: Dictionary[int, bool] = {}
		for id: int in canvases:
			canvas_ids[id] = true
		var item_ids: Dictionary[int, bool] = {}
		for id: int in items:
			item_ids[id] = true
		var texture_ids: Dictionary[int, bool] = {}
		for id: int in textures:
			texture_ids[id] = true
		var mesh_ids: Dictionary[int, bool] = {}
		if is_v4:
			for id: int in meshes:
				mesh_ids[id] = true

		for id: int in textures:
			var t: Dictionary = textures[id]
			var field_error: String = _texture_entry_field_error(t)
			if field_error != "":
				return Rs2Decoder.err("texture-entry", "%s: %s" % [where, field_error])
		if is_v4:
			for id: int in meshes:
				var m0: Dictionary = meshes[id]
				var mesh_field_error: String = _mesh_entry_field_error(m0)
				if mesh_field_error != "":
					return Rs2Decoder.err("mesh-entry", "%s: %s" % [where, mesh_field_error])

		var roots: Array[int] = []
		for id: int in canvases:
			var canvas: Dictionary = canvases[id]
			if canvas["role"] != null:
				roots.append(id)
		if roots.size() != 1 or roots[0] != 1:
			return Rs2Decoder.err("root-canvas", "%s: expected exactly one canvas with role root and id 1" % where)

		var claimed: Dictionary[String, Array] = {}
		for id: int in items:
			var item: Dictionary = items[id]
			var parent: Variant = item["parent"]
			if parent == null:
				continue
			var link: Dictionary = parent
			var kind: String = link["kind"]
			var target: int = Rs2Decoder.as_int(link["id"])
			var exists: bool = canvas_ids.has(target) if kind == "canvas" else item_ids.has(target)
			if not exists:
				return Rs2Decoder.err("dangling-parent", "%s: item %d names parent %s %d, which does not exist" % [where, id, kind, target])
			var key: String = "%s:%d" % [kind, target]
			var list: Array = claimed.get(key, [])
			list.append(id)
			claimed[key] = list
		for id: int in canvases:
			var canvas_for_check: Dictionary = canvases[id]
			var declared_items: Array = canvas_for_check["items"]
			var claimed_canvas_list: Array = claimed.get("canvas:%d" % id, [])
			if not _same_id_set(declared_items, claimed_canvas_list):
				return Rs2Decoder.err("child-list-mismatch", "%s: canvas %d's items[] disagrees with items' parent fields" % [where, id])
		for id: int in items:
			var item_for_check: Dictionary = items[id]
			var declared_children: Array = item_for_check["children"]
			var claimed_item_list: Array = claimed.get("item:%d" % id, [])
			if not _same_id_set(declared_children, claimed_item_list):
				return Rs2Decoder.err("child-list-mismatch", "%s: item %d's children[] disagrees with items' parent fields" % [where, id])

		for id: int in items:
			var seen: Dictionary[int, bool] = {}
			var cursor: int = id
			while true:
				if seen.has(cursor):
					return Rs2Decoder.err("parent-cycle", "%s: following parents from item %d revisits item %d" % [where, id, cursor])
				seen[cursor] = true
				var cur_item: Dictionary = items[cursor]
				var parent: Variant = cur_item["parent"]
				if parent == null:
					break
				var parent_link: Dictionary = parent
				if parent_link["kind"] != "item":
					break
				cursor = Rs2Decoder.as_int(parent_link["id"])

		# texture-ref: every command's non-null tex, and every canvas texture's non-null diffuse,
		# must name an existing table entry; a diffuse must name an image or placeholder.
		# render-stream-4.md "Command": every new /4 op that carries a "tex" field follows the
		# same rule as the existing texture-rect ops.
		var tex_bearing_ops: Dictionary[String, bool] = {
			"add_texture_rect": true, "add_texture_rect_region": true,
			"add_msdf_texture_rect_region": true, "add_primitive": true, "add_polygon": true,
			"add_triangle_array": true, "add_nine_patch": true, "add_mesh": true,
		}
		for id: int in items:
			var item: Dictionary = items[id]
			var commands: Array = item["commands"]
			for value: Variant in commands:
				var command: Dictionary = value
				var op: String = command["op"]
				if not tex_bearing_ops.has(op):
					continue
				var tex: Variant = command["tex"]
				if tex == null:
					continue
				if not texture_ids.has(Rs2Decoder.as_int(tex)):
					return Rs2Decoder.err("texture-ref", "%s: item %d's %s names texture %d, which has no entry" % [where, id, op, Rs2Decoder.as_int(tex)])
		for id: int in textures:
			var t: Dictionary = textures[id]
			var canvas_info: Variant = t["canvas"]
			if canvas_info == null:
				continue
			var canvas_dict: Dictionary = canvas_info
			var diffuse: Variant = canvas_dict["diffuse"]
			if diffuse == null:
				continue
			var diffuse_id: int = Rs2Decoder.as_int(diffuse)
			if not texture_ids.has(diffuse_id):
				return Rs2Decoder.err("texture-ref", "%s: canvas texture %d's diffuse names texture %d, which has no entry" % [where, id, diffuse_id])
			var diffuse_entry: Dictionary = textures[diffuse_id]
			if diffuse_entry["kind"] != "image" and diffuse_entry["kind"] != "placeholder":
				return Rs2Decoder.err("texture-ref", "%s: canvas texture %d's diffuse names texture %d, whose kind is %s (must be image or placeholder)" % [where, id, diffuse_id, diffuse_entry["kind"]])

		# mesh-ref (render-stream-4.md "Mesh table"): every add_mesh command's "mesh" id must name
		# an entry present in the resolved mesh table (any status -- a "freed" tombstone counts).
		if is_v4:
			for id: int in items:
				var item2: Dictionary = items[id]
				var commands2: Array = item2["commands"]
				for value: Variant in commands2:
					var command2: Dictionary = value
					if command2["op"] != "add_mesh":
						continue
					var mesh_id: int = Rs2Decoder.as_int(command2["mesh"])
					if not mesh_ids.has(mesh_id):
						return Rs2Decoder.err("mesh-ref", "%s: item %d's add_mesh names mesh %d, which has no entry" % [where, id, mesh_id])

		# Invariant 9: draw-index ties.
		var expected_tie_items: Dictionary[int, bool] = {}
		var containers: Array[Array] = []
		for id: int in canvases:
			var canvas: Dictionary = canvases[id]
			var canvas_items: Array = canvas["items"]
			containers.append(canvas_items)
		for id: int in items:
			var item_for_children: Dictionary = items[id]
			var item_children: Array = item_for_children["children"]
			containers.append(item_children)
		for container: Array in containers:
			var by_draw_index: Dictionary[int, Array] = {}
			for value: Variant in container:
				var child_id: int = value
				if not items.has(child_id):
					continue
				var child: Dictionary = items[child_id]
				var di: int = Rs2Decoder.as_int(child["draw_index"])
				var list: Array = by_draw_index.get(di, [])
				list.append(child_id)
				by_draw_index[di] = list
			for di: int in by_draw_index:
				var group: Array = by_draw_index[di]
				var drawing: Array[int] = []
				for value: Variant in group:
					var child_id: int = value
					var child: Dictionary = items[child_id]
					var commands: Array = child["commands"]
					var children: Array = child["children"]
					if commands.size() > 0 or children.size() > 0:
						drawing.append(child_id)
				if drawing.size() >= 2:
					var smallest: int = drawing[0]
					for id: int in drawing:
						smallest = mini(smallest, id)
					expected_tie_items[smallest] = true

		# Expected derived unsupported[] entries.
		var actual_unsupported_ops: Dictionary[String, String] = {}  # "item:op" -> reason
		var actual_unsupported_texture: Dictionary[String, bool] = {}  # "item:rs_method" -> true
		var actual_unsupported_mesh: Dictionary[String, bool] = {}  # "item:canvas_item_add_mesh" -> true
		for id: int in items:
			var item: Dictionary = items[id]
			var commands: Array = item["commands"]
			var seen_ops: Dictionary[String, bool] = {}
			for value: Variant in commands:
				var command: Dictionary = value
				var op: String = command["op"]
				if op == "unsupported":
					var name: String = command["name"]
					if not seen_ops.has(name):
						seen_ops[name] = true
						var cmd_reason: String = command["reason"]
						var reason: String = cmd_reason if (cmd_reason == "unknown-texture" or cmd_reason == "canvas-texture-headless" or cmd_reason == "unknown-mesh" or cmd_reason == "skinned-geometry") else "unsupported-op"
						actual_unsupported_ops["%d:%s" % [id, name]] = reason
				elif tex_bearing_ops.has(op) and command["tex"] != null:
					# NOTE: an early "continue" here would also skip the add_mesh check below
					# (same loop iteration) -- this branch only ever falls through, never
					# continues, so it stays a plain "if" inside the "elif".
					var tex: Variant = command["tex"]
					var target_id: int = Rs2Decoder.as_int(tex)
					if textures.has(target_id):
						var target: Dictionary = textures[target_id]
						var unsupported_via_diffuse: bool = false
						if target["kind"] == "canvas" and target["canvas"] != null:
							var canvas_dict2: Dictionary = target["canvas"]
							var diffuse: Variant = canvas_dict2["diffuse"]
							if diffuse != null and textures.has(Rs2Decoder.as_int(diffuse)):
								var diffuse_entry2: Dictionary = textures[Rs2Decoder.as_int(diffuse)]
								unsupported_via_diffuse = diffuse_entry2["status"] == "unsupported"
						if target["status"] == "unsupported" or unsupported_via_diffuse:
							# The derived entry's `op` is the RenderingServer method name, not
							# the wire command's own op (render-stream-2.md "Item-level
							# unsupported entries").
							var rs_method: String = Rs2Decoder._rs_method_for_op(op)
							actual_unsupported_texture["%d:%s" % [id, rs_method]] = true
				if is_v4 and op == "add_mesh":
					var mesh_id2: Variant = command["mesh"]
					var mtarget_id: int = Rs2Decoder.as_int(mesh_id2)
					if meshes.has(mtarget_id):
						var mtarget: Dictionary = meshes[mtarget_id]
						if mtarget["status"] == "unsupported":
							actual_unsupported_mesh["%d:canvas_item_add_mesh" % id] = true

		var last_item: int = -1
		var last_op: String = ""
		var item_level_started: bool = false
		var declared_unsupported_ops: Dictionary[String, bool] = {}
		var declared_tie_items: Dictionary[int, bool] = {}
		var declared_unsupported_texture: Dictionary[String, bool] = {}
		var declared_unsupported_mesh: Dictionary[String, bool] = {}
		for value: Variant in unsupported_meta:
			var entry: Dictionary = value
			var op: String = entry["op"]
			var reason: String = entry["reason"]
			if entry["item"] == null:
				if item_level_started:
					return Rs2Decoder.err("unsupported-mismatch", "%s: session-level entry %s follows an item-level entry" % [where, op])
				continue
			item_level_started = true
			var item_id: int = Rs2Decoder.as_int(entry["item"])
			if not item_ids.has(item_id):
				return Rs2Decoder.err("dangling-parent", "%s: unsupported entry names item %d, which does not exist" % [where, item_id])
			if item_id < last_item or (item_id == last_item and op <= last_op):
				return Rs2Decoder.err("unsupported-mismatch", "%s: unsupported entry (%d, %s) is out of order or repeated" % [where, item_id, op])
			last_item = item_id
			last_op = op
			if reason == "unsupported-op" or reason == "unknown-texture" or reason == "canvas-texture-headless" or reason == "unknown-mesh" or reason == "skinned-geometry":
				var pair: String = "%d:%s" % [item_id, op]
				if not actual_unsupported_ops.has(pair) or actual_unsupported_ops[pair] != reason:
					return Rs2Decoder.err("unsupported-mismatch", "%s: %s entry (%d, %s) has no matching command" % [where, reason, item_id, op])
				declared_unsupported_ops[pair] = true
			elif reason == "draw-index-tie":
				if op != "canvas_item_set_draw_index":
					return Rs2Decoder.err("unsupported-mismatch", "%s: draw-index-tie entry for item %d names op %s, expected canvas_item_set_draw_index" % [where, item_id, op])
				if not expected_tie_items.has(item_id):
					return Rs2Decoder.err("unsupported-mismatch", "%s: draw-index-tie entry for item %d does not correspond to an actual tie" % [where, item_id])
				declared_tie_items[item_id] = true
			elif reason == "unsupported-state":
				# unsupported-state covers canvas_item_set_material (/2) and, new at /4,
				# calibrator-7's canvas_item_attach_skeleton.
				if op != "canvas_item_set_material" and op != "canvas_item_attach_skeleton":
					return Rs2Decoder.err("unsupported-mismatch", "%s: unsupported-state entry for item %d names %s, expected canvas_item_set_material or canvas_item_attach_skeleton" % [where, item_id, op])
			elif reason == "unsupported-texture":
				var pair2: String = "%d:%s" % [item_id, op]
				if not actual_unsupported_texture.has(pair2):
					return Rs2Decoder.err("unsupported-mismatch", "%s: unsupported-texture entry (%d, %s) does not correspond to a command naming an unsupported texture" % [where, item_id, op])
				declared_unsupported_texture[pair2] = true
			elif reason == "unsupported-mesh":
				var pair3: String = "%d:%s" % [item_id, op]
				if not actual_unsupported_mesh.has(pair3):
					return Rs2Decoder.err("unsupported-mismatch", "%s: unsupported-mesh entry (%d, %s) does not correspond to an add_mesh naming an unsupported mesh" % [where, item_id, op])
				declared_unsupported_mesh[pair3] = true
		for pair: String in actual_unsupported_ops:
			if not declared_unsupported_ops.has(pair):
				return Rs2Decoder.err("unsupported-mismatch", "%s: %s command (%s) has no matching unsupported[] entry" % [where, actual_unsupported_ops[pair], pair.replace(":", ", ")])
		for id: int in expected_tie_items:
			if not declared_tie_items.has(id):
				return Rs2Decoder.err("unsupported-mismatch", "%s: items tie on draw_index under item/canvas with smallest id %d, but no draw-index-tie entry is declared" % [where, id])
		for pair: String in actual_unsupported_texture:
			if not declared_unsupported_texture.has(pair):
				return Rs2Decoder.err("unsupported-mismatch", "%s: tex-bearing command (%s) names an unsupported texture, with no unsupported-texture entry" % [where, pair.replace(":", ", ")])
		if is_v4:
			for pair: String in actual_unsupported_mesh:
				if not declared_unsupported_mesh.has(pair):
					return Rs2Decoder.err("unsupported-mismatch", "%s: add_mesh command (%s) names an unsupported mesh, with no unsupported-mesh entry" % [where, pair.replace(":", ", ")])
		return ""

	static func _same_id_set(declared: Array, claimed: Array) -> bool:
		if declared.size() != claimed.size():
			return false
		var declared_set: Dictionary[int, bool] = {}
		for value: Variant in declared:
			var id: int = Rs2Decoder.as_int(value)
			if declared_set.has(id):
				return false
			declared_set[id] = true
		for value: Variant in claimed:
			var id: int = value
			if not declared_set.has(id):
				return false
		return true
