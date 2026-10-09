class_name Rs1Decoder
extends RefCounted
## render-stream/1 decoder and validator (protocol/render-stream-1.md).
##
## Pure: a PackedByteArray in, records and "<code>: <detail>" strings out. It opens no file and
## makes no RenderingServer call. Framing, canonical-JSON rules and most error codes are
## unchanged from render-stream-0.md; this file was written independently of the gate 0 decoder
## (removed in G1b2), matching rs1_codec.cpp's independence from rs0_codec.cpp.
##
## `Stream` (below) is this decoder's novelty: because a patch transaction only carries the
## entries that are new or different, every invariant beyond framing and per-record schema has to
## be checked against the RESOLVED state (render-stream-1.md "Resolution"), not the raw record.
## `Stream` therefore holds that resolved state -- `canvases`/`items`, each a Dictionary[int,
## Dictionary] keyed by wire id, with every float inlined and every command's `rect`/`color`
## filled in (never an `f` offset) -- and updates it as each transaction is accepted.
##
## JSON.parse returns every number as a float. Every wire integer is below 2^53, so an integer is
## accepted only when it is finite, integral and within +-(2^53 - 1), then converted with int().

const MAGIC_HEX: String = "475253310d0a1a0a"
const PROTOCOL: String = "render-stream/1"
const MAX_SAFE_INT: float = 9007199254740991.0
const U32_MAX: float = 4294967295.0
const ITEM_FLOATS: int = 18
const CANVAS_FLOATS: int = 6
const RECT_FLOATS: int = 8

const SESSION_KEYS: Array = [
	"type", "protocol", "session_id", "stream", "engine", "capture", "viewport", "features",
	"sabotage", "blocks",
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
const FEATURES_KEYS: Array = [
	"ops", "item_state", "observed_unsupported_ops", "unobserved", "publication",
]
const PUBLICATION: String = "snapshot-or-patch"
const SABOTAGE_KEYS: Array = ["kind", "frame", "op"]
const SABOTAGE_KINDS: Array = [
	"freeze-frame", "omit-update", "perturb-transform", "omit-op", "patch-drop-item",
	"drop-message", "ignore-credit", "stale-coalesce",
]
const TRANSACTION_KEYS: Array = [
	"type", "seq", "frame", "encoding", "base_seq", "status", "failures", "unsupported",
	"removed_canvases", "removed_items", "canvases", "items", "blocks",
]
const STATUSES: Array = ["ok", "capture-failure"]
const FAILURE_KEYS: Array = ["reason", "detail"]
const FAILURE_REASONS: Array = [
	"root-query-failed", "pre-existing-object", "mirror-capacity", "root-size-enforce-failed",
]
const UNSUPPORTED_KEYS: Array = ["op", "item", "reason"]
const SESSION_UNSUPPORTED_REASONS: Array = ["non-root-viewport", "extra-canvas", "degenerate-host-size"]
const ITEM_UNSUPPORTED_REASONS: Array = ["unsupported-op", "unsupported-state", "draw-index-tie"]
const CANVAS_KEYS: Array = ["id", "origin", "role", "attached", "items"]
const ORIGINS: Array = ["created", "root-query", "adopted"]
const ITEM_KEYS: Array = [
	"id", "origin", "parent", "children", "visible", "draw_index", "z_index", "z_relative",
	"behind", "clip", "custom_rect", "visibility_layer", "content_version", "commands",
]
const PARENT_KEYS: Array = ["kind", "id"]
const PARENT_KINDS: Array = ["canvas", "item"]
const ADD_RECT_KEYS: Array = ["op", "aa", "f"]
const UNSUPPORTED_COMMAND_KEYS: Array = ["op", "name"]
const END_KEYS: Array = ["type", "transactions", "reason", "stats", "blocks"]
const END_REASONS: Array = ["shutdown", "disarm"]
const STATS_KEYS: Array = [
	"bytes_total", "encode_ns_total", "snapshot_ns_total", "diff_ns_total", "max_record_bytes",
	"full_transactions", "patch_transactions",
]
const BLOCK_KEYS: Array = ["name", "type", "count"]
const SESSION_BLOCK_NAMES: Array = [
	"clear_color", "root_canvas_xform", "host_visible_rect", "host_final_xform",
	"content_scale_factor",
]
const SESSION_BLOCK_COUNTS: Array = [4, 6, 4, 6, 1]
const TRANSACTION_BLOCK_NAMES: Array = ["item_f32", "canvas_f32", "cmd_f32"]


# --------------------------------------------------------------------------- small helpers


static func err(code: String, detail: String) -> String:
	return code + ": " + detail


## The code of a "<code>: <detail>" string.
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


## int() of a value already accepted by is_int().
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


## A JSON array of integers (already schema-checked) as Array[int].
static func int_list(values: Variant) -> Array[int]:
	var source: Array = values
	var out: Array[int] = []
	for value: Variant in source:
		out.append(as_int(value))
	return out


## `label` is "canvases" or "items": a transaction's own canvases[]/items[] list (as written,
## full or patch) must be sorted by id ascending with no duplicates. Returns "" when ok.
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


# --------------------------------------------------------------------------- framing


## Walks one record's framing at `offset` without parsing meta. Returns
## {error: String ("" when the framing is sound), end: int, meta_start: int, meta_len: int,
##  blocks: Array of [payload_start, payload_len]}.
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


## Splits the input into records by framing alone (no meta parse). Returns
## {records: Array[Dictionary] of {offset, byte_length}, errors: PackedStringArray,
##  framed_to: int (the byte offset where framing stopped)}.
## Stops at the first framing error (bad-magic, truncated, record-length).
static func split_records(data: PackedByteArray) -> Dictionary:
	var records: Array[Dictionary] = []
	var errors := PackedStringArray()
	if data.size() < 8 or data.slice(0, 8).hex_encode() != MAGIC_HEX:
		errors.append(err("bad-magic", "first 8 bytes are %s, expected %s" % [data.slice(0, 8).hex_encode(), MAGIC_HEX]))
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


## Meta schema checker. Records the first problem and turns every later check into a no-op, so
## the checks read top to bottom without early returns.
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
		if not Rs1Decoder.is_int(value):
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
		if ok and not Rs1Decoder._is_lower_hex(text, length):
			fail("%s is not %d lowercase hex digits" % [path, length])

	func sorted_strings(value: Variant, path: String) -> void:
		var list: Array = array(value, path)
		var last: String = ""
		for i: int in list.size():
			var text: String = string(list[i], "%s[%d]" % [path, i])
			if ok and i > 0 and not (last < text):
				fail("%s is not sorted ascending without repeats at %d" % [path, i])
			last = text

	func int_pair(value: Variant, path: String) -> void:
		var list: Array = array(value, path)
		if ok and list.size() != 2:
			fail("%s does not have exactly 2 entries" % path)
			return
		integer(list[0], path + "[0]", -Rs1Decoder.MAX_SAFE_INT, Rs1Decoder.MAX_SAFE_INT)
		integer(list[1], path + "[1]", -Rs1Decoder.MAX_SAFE_INT, Rs1Decoder.MAX_SAFE_INT)

	func int_list(value: Variant, path: String) -> void:
		var list: Array = array(value, path)
		for i: int in list.size():
			integer(list[i], "%s[%d]" % [path, i], 1, Rs1Decoder.MAX_SAFE_INT)

	func blocks(value: Variant, names: Array) -> void:
		var list: Array = array(value, "meta.blocks")
		if ok and list.size() != names.size():
			fail("meta.blocks has %d entries, expected %s" % [list.size(), JSON.stringify(names)])
		for i: int in list.size():
			var path: String = "meta.blocks[%d]" % i
			var entry: Dictionary = object(list[i], Rs1Decoder.BLOCK_KEYS, path)
			var expected_name: String = names[i]
			exact(entry.get("name"), expected_name, path + ".name")
			exact(entry.get("type"), "f32", path + ".type")
			integer(entry.get("count"), path + ".count", 0, Rs1Decoder.U32_MAX)

	func session(meta: Dictionary) -> void:
		object(meta, Rs1Decoder.SESSION_KEYS, "meta")
		exact(meta.get("protocol"), Rs1Decoder.PROTOCOL, "meta.protocol")
		hex(meta.get("session_id"), 32, "meta.session_id")
		var stream: Dictionary = object(meta.get("stream"), Rs1Decoder.STREAM_KEYS, "meta.stream")
		hex(stream.get("stream_id"), 32, "meta.stream.stream_id")
		var connection: Variant = stream.get("connection")
		if ok and connection != null:
			integer(connection, "meta.stream.connection", 1, Rs1Decoder.MAX_SAFE_INT)
		one_of(stream.get("transport"), Rs1Decoder.TRANSPORTS, "meta.stream.transport")
		one_of(stream.get("encoding"), Rs1Decoder.ENCODINGS, "meta.stream.encoding")
		var engine: Dictionary = object(meta.get("engine"), Rs1Decoder.ENGINE_KEYS, "meta.engine")
		string(engine.get("version_string"), "meta.engine.version_string")
		hex(engine.get("sha256"), 64, "meta.engine.sha256")
		string(engine.get("display_server"), "meta.engine.display_server")
		string(engine.get("rendering_driver"), "meta.engine.rendering_driver")
		string(engine.get("rendering_method"), "meta.engine.rendering_method")
		var capture: Dictionary = object(meta.get("capture"), Rs1Decoder.CAPTURE_KEYS, "meta.capture")
		integer(capture.get("calibrator_version"), "meta.capture.calibrator_version", 0, Rs1Decoder.MAX_SAFE_INT)
		sorted_strings(capture.get("hooks_planned"), "meta.capture.hooks_planned")
		sorted_strings(capture.get("hooks_omitted"), "meta.capture.hooks_omitted")
		var viewport: Dictionary = object(meta.get("viewport"), Rs1Decoder.VIEWPORT_KEYS, "meta.viewport")
		integer(viewport.get("canvas_cull_mask"), "meta.viewport.canvas_cull_mask", 0, Rs1Decoder.U32_MAX)
		integer(viewport.get("root_canvas"), "meta.viewport.root_canvas", -Rs1Decoder.MAX_SAFE_INT, Rs1Decoder.MAX_SAFE_INT)
		int_pair(viewport.get("logical_size"), "meta.viewport.logical_size")
		var stretch: Dictionary = object(viewport.get("stretch"), Rs1Decoder.STRETCH_KEYS, "meta.viewport.stretch")
		one_of(stretch.get("mode"), Rs1Decoder.STRETCH_MODES, "meta.viewport.stretch.mode")
		one_of(stretch.get("aspect"), Rs1Decoder.STRETCH_ASPECTS, "meta.viewport.stretch.aspect")
		one_of(stretch.get("scale_mode"), Rs1Decoder.SCALE_MODES, "meta.viewport.stretch.scale_mode")
		exact(viewport.get("stretch_applied_by"), "receiver", "meta.viewport.stretch_applied_by")
		one_of(viewport.get("root_size_policy"), Rs1Decoder.ROOT_SIZE_POLICIES, "meta.viewport.root_size_policy")
		one_of(viewport.get("host_size_status"), Rs1Decoder.HOST_SIZE_STATUSES, "meta.viewport.host_size_status")
		int_pair(viewport.get("host_window_size"), "meta.viewport.host_window_size")
		var features: Dictionary = object(meta.get("features"), Rs1Decoder.FEATURES_KEYS, "meta.features")
		sorted_strings(features.get("ops"), "meta.features.ops")
		sorted_strings(features.get("item_state"), "meta.features.item_state")
		sorted_strings(features.get("observed_unsupported_ops"), "meta.features.observed_unsupported_ops")
		sorted_strings(features.get("unobserved"), "meta.features.unobserved")
		exact(features.get("publication"), Rs1Decoder.PUBLICATION, "meta.features.publication")
		var sabotage: Variant = meta.get("sabotage")
		if ok and sabotage != null:
			var spec: Dictionary = object(sabotage, Rs1Decoder.SABOTAGE_KEYS, "meta.sabotage")
			var kind: String = one_of(spec.get("kind"), Rs1Decoder.SABOTAGE_KINDS, "meta.sabotage.kind")
			integer(spec.get("frame"), "meta.sabotage.frame", 1, Rs1Decoder.MAX_SAFE_INT)
			var op: Variant = spec.get("op")
			if ok:
				if op != null:
					string(op, "meta.sabotage.op")
				if ok and (kind == "omit-op") != (op != null):
					fail("meta.sabotage.op must be non-null exactly for kind \"omit-op\"")
		blocks(meta.get("blocks"), Rs1Decoder.SESSION_BLOCK_NAMES)
		if ok:
			var declared: Array = meta["blocks"]
			for i: int in declared.size():
				var entry: Dictionary = declared[i]
				var expected: int = Rs1Decoder.SESSION_BLOCK_COUNTS[i]
				if Rs1Decoder.as_int(entry["count"]) != expected:
					fail("session block %s has count %d, expected %d" % [entry["name"], Rs1Decoder.as_int(entry["count"]), expected])

	func transaction(meta: Dictionary) -> void:
		object(meta, Rs1Decoder.TRANSACTION_KEYS, "meta")
		integer(meta.get("seq"), "meta.seq", 1, Rs1Decoder.MAX_SAFE_INT)
		integer(meta.get("frame"), "meta.frame", 1, Rs1Decoder.MAX_SAFE_INT)
		one_of(meta.get("encoding"), Rs1Decoder.ENCODINGS, "meta.encoding")
		nullable_integer(meta.get("base_seq"), "meta.base_seq", 1, Rs1Decoder.MAX_SAFE_INT)
		one_of(meta.get("status"), Rs1Decoder.STATUSES, "meta.status")
		var failures: Array = array(meta.get("failures"), "meta.failures")
		for i: int in failures.size():
			var path: String = "meta.failures[%d]" % i
			var failure: Dictionary = object(failures[i], Rs1Decoder.FAILURE_KEYS, path)
			one_of(failure.get("reason"), Rs1Decoder.FAILURE_REASONS, path + ".reason")
			string(failure.get("detail"), path + ".detail")
		var unsupported: Array = array(meta.get("unsupported"), "meta.unsupported")
		for i: int in unsupported.size():
			var path: String = "meta.unsupported[%d]" % i
			var entry: Dictionary = object(unsupported[i], Rs1Decoder.UNSUPPORTED_KEYS, path)
			if not ok:
				return
			string(entry["op"], path + ".op")
			if entry["item"] == null:
				one_of(entry["reason"], Rs1Decoder.SESSION_UNSUPPORTED_REASONS, path + ".reason")
			else:
				integer(entry["item"], path + ".item", 1, Rs1Decoder.MAX_SAFE_INT)
				one_of(entry["reason"], Rs1Decoder.ITEM_UNSUPPORTED_REASONS, path + ".reason")
		int_list(meta.get("removed_canvases"), "meta.removed_canvases")
		int_list(meta.get("removed_items"), "meta.removed_items")
		var canvases: Array = array(meta.get("canvases"), "meta.canvases")
		for i: int in canvases.size():
			var path: String = "meta.canvases[%d]" % i
			var canvas: Dictionary = object(canvases[i], Rs1Decoder.CANVAS_KEYS, path)
			integer(canvas.get("id"), path + ".id", 1, Rs1Decoder.MAX_SAFE_INT)
			one_of(canvas.get("origin"), Rs1Decoder.ORIGINS, path + ".origin")
			var role: Variant = canvas.get("role")
			if ok and role != null:
				exact(role, "root", path + ".role")
			boolean(canvas.get("attached"), path + ".attached")
			int_list(canvas.get("items"), path + ".items")
		var items: Array = array(meta.get("items"), "meta.items")
		for i: int in items.size():
			var path: String = "meta.items[%d]" % i
			var item: Dictionary = object(items[i], Rs1Decoder.ITEM_KEYS, path)
			integer(item.get("id"), path + ".id", 1, Rs1Decoder.MAX_SAFE_INT)
			one_of(item.get("origin"), Rs1Decoder.ORIGINS, path + ".origin")
			var parent: Variant = item.get("parent")
			if ok and parent != null:
				var link: Dictionary = object(parent, Rs1Decoder.PARENT_KEYS, path + ".parent")
				one_of(link.get("kind"), Rs1Decoder.PARENT_KINDS, path + ".parent.kind")
				integer(link.get("id"), path + ".parent.id", 1, Rs1Decoder.MAX_SAFE_INT)
			int_list(item.get("children"), path + ".children")
			boolean(item.get("visible"), path + ".visible")
			integer(item.get("draw_index"), path + ".draw_index", -Rs1Decoder.MAX_SAFE_INT, Rs1Decoder.MAX_SAFE_INT)
			integer(item.get("z_index"), path + ".z_index", -Rs1Decoder.MAX_SAFE_INT, Rs1Decoder.MAX_SAFE_INT)
			boolean(item.get("z_relative"), path + ".z_relative")
			boolean(item.get("behind"), path + ".behind")
			boolean(item.get("clip"), path + ".clip")
			boolean(item.get("custom_rect"), path + ".custom_rect")
			integer(item.get("visibility_layer"), path + ".visibility_layer", 0, Rs1Decoder.U32_MAX)
			integer(item.get("content_version"), path + ".content_version", 0, Rs1Decoder.MAX_SAFE_INT)
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
						object(command, Rs1Decoder.ADD_RECT_KEYS, cpath)
						boolean(command.get("aa"), cpath + ".aa")
						integer(command.get("f"), cpath + ".f", 0, Rs1Decoder.MAX_SAFE_INT)
					elif op is String and op == "unsupported":
						object(command, Rs1Decoder.UNSUPPORTED_COMMAND_KEYS, cpath)
						string(command.get("name"), cpath + ".name")
					else:
						fail("%s.op is %s, expected add_rect or unsupported" % [cpath, JSON.stringify(op)])
		blocks(meta.get("blocks"), Rs1Decoder.TRANSACTION_BLOCK_NAMES)

	func end(meta: Dictionary) -> void:
		object(meta, Rs1Decoder.END_KEYS, "meta")
		integer(meta.get("transactions"), "meta.transactions", 0, Rs1Decoder.MAX_SAFE_INT)
		one_of(meta.get("reason"), Rs1Decoder.END_REASONS, "meta.reason")
		var stats: Dictionary = object(meta.get("stats"), Rs1Decoder.STATS_KEYS, "meta.stats")
		for key: Variant in Rs1Decoder.STATS_KEYS:
			var stat: String = key
			integer(stats.get(stat), "meta.stats." + stat, 0, Rs1Decoder.MAX_SAFE_INT)
		blocks(meta.get("blocks"), [])


# --------------------------------------------------------------------------- one record


## Decodes one record: framing, meta JSON, meta schema, block framing. Returns {offset,
## byte_length, sha256, meta: Dictionary, blocks: Array[PackedFloat32Array],
## errors: PackedStringArray}. `meta` is the parsed JSON whenever it parsed, even if later checks
## failed. Does NOT run the cross-record / resolved-state invariants -- see Stream.accept().
static func decode_record(data: PackedByteArray, offset: int) -> Dictionary:
	var blocks: Array[PackedFloat32Array] = []
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
		check.session(meta)
	elif kind is String and kind == "transaction":
		check.transaction(meta)
	elif kind is String and kind == "end":
		check.end(meta)
	else:
		check.fail("meta.type is %s, expected session, transaction or end" % JSON.stringify(kind))
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
		if length != 4 * count:
			errors.append(err("block-length", "record at offset %d: block %d (%s) carries %d bytes, count %d needs %d" % [offset, i, entry["name"], length, count, 4 * count]))
			out["errors"] = errors
			return out
		blocks.append(data.slice(start, start + length).to_float32_array())
	out["blocks"] = blocks
	return out


# --------------------------------------------------------------------------- resolution helpers


## This item's own fields with floats inlined from `item_f32` and commands expanded from
## `cmd_f32` (render-stream-1.md "Decoded and resolved forms"). `commands` is [] when the wire
## entry's commands are null -- the caller (Stream._apply_transaction) fills them in from the
## base.
static func _lift_item(item: Dictionary, item_f32: PackedFloat32Array, cmd_f32: PackedFloat32Array) -> Dictionary:
	var commands: Array[Dictionary] = []
	if item["commands"] != null:
		var raw: Array = item["commands"]
		for value: Variant in raw:
			var command: Dictionary = value
			if command["op"] == "add_rect":
				var f: int = as_int(command["f"])
				commands.append({
					"op": "add_rect", "aa": command["aa"],
					"rect": [cmd_f32[f], cmd_f32[f + 1], cmd_f32[f + 2], cmd_f32[f + 3]],
					"color": [cmd_f32[f + 4], cmd_f32[f + 5], cmd_f32[f + 6], cmd_f32[f + 7]],
				})
			else:
				commands.append({"op": "unsupported", "name": command["name"]})
	var parent: Variant = item["parent"]
	return {
		"id": as_int(item["id"]), "origin": item["origin"],
		"parent": null if parent == null else {"kind": parent["kind"], "id": as_int(parent["id"])},
		"children": int_list(item["children"]), "visible": item["visible"],
		"draw_index": as_int(item["draw_index"]), "z_index": as_int(item["z_index"]),
		"z_relative": item["z_relative"], "behind": item["behind"], "clip": item["clip"],
		"custom_rect": item["custom_rect"], "visibility_layer": as_int(item["visibility_layer"]),
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


# --------------------------------------------------------------------------- whole recording


## Validates a whole recording, resolving it along the way. Returns "<code>: <detail>" strings;
## empty means valid. Stops at the first framing error and at the first record that fails to
## decode or violates an invariant.
static func validate_recording(data: PackedByteArray) -> PackedStringArray:
	var errors := PackedStringArray()
	var split: Dictionary = split_records(data)
	var records: Array[Dictionary] = split["records"]
	var split_errors: PackedStringArray = split["errors"]
	if split_errors.size() > 0 and code_of(split_errors[0]) == "bad-magic":
		return split_errors
	var stream := Stream.new()
	for index: int in records.size():
		var raw: Dictionary = records[index]
		var record: Dictionary = decode_record(data, as_int(raw["offset"]))
		var record_errors: PackedStringArray = record["errors"]
		if record_errors.size() > 0:
			for e: String in record_errors:
				errors.append("%s (record %d)" % [e, index])
			return errors
		errors.append_array(stream.accept(record))
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


## Cross-record state AND the resolved canvas/item tree (render-stream-1.md "Resolution").
## `canvases`/`items` are Dictionary[int, Dictionary], always reflecting the state after the
## last-accepted transaction; a caller that needs the resolved state of a specific seq must read
## them right after that transaction's accept() call.
class Stream:
	extends RefCounted

	var canvases: Dictionary = {}  # int -> resolved canvas Dictionary
	var items: Dictionary = {}     # int -> resolved item Dictionary

	var records_accepted: int = 0
	var session_seen: bool = false
	var end_seen: bool = false
	var last_seq: int = 0
	var last_frame: int = 0
	var transactions: int = 0
	var full_transactions: int = 0
	var patch_transactions: int = 0
	var max_record_bytes: int = 0
	var bytes_total: int = 8  # the 8-byte magic, present before any record (render-stream-0.md)
	var session_encoding: String = ""
	var _max_item_id: int = 0
	var _max_canvas_id: int = 0

	## Accepts one decoded record (decode_record's result, without errors).
	func accept(record: Dictionary) -> PackedStringArray:
		var errors := PackedStringArray()
		var meta: Dictionary = record["meta"]
		var kind: String = meta["type"]
		var offset: int = Rs1Decoder.as_int(record["offset"])
		var byte_length: int = Rs1Decoder.as_int(record["byte_length"])
		var index: int = records_accepted
		records_accepted += 1
		if end_seen:
			errors.append(Rs1Decoder.err("trailing-bytes", "record %d at offset %d follows the end record" % [index, offset]))
			return errors
		if index == 0 and kind != "session":
			errors.append(Rs1Decoder.err("missing-session", "the first record is a %s, not a session" % kind))
			return errors
		match kind:
			"session":
				if index != 0:
					errors.append(Rs1Decoder.err("duplicate-session", "record %d at offset %d is a second session" % [index, offset]))
					return errors
				session_seen = true
				var stream_meta: Dictionary = meta["stream"]
				session_encoding = stream_meta["encoding"]
				if Rs1Decoder.as_int(meta["viewport"]["root_canvas"]) != 1:
					errors.append(Rs1Decoder.err("root-canvas", "session.viewport.root_canvas is %d, not 1" % Rs1Decoder.as_int(meta["viewport"]["root_canvas"])))
					return errors
				bytes_total += byte_length
				max_record_bytes = maxi(max_record_bytes, byte_length)
			"transaction":
				var record_blocks: Array[PackedFloat32Array] = record["blocks"]
				errors.append_array(_accept_transaction(meta, offset, record_blocks))
				if errors.is_empty():
					bytes_total += byte_length
					max_record_bytes = maxi(max_record_bytes, byte_length)
			"end":
				end_seen = true
				var counted: int = Rs1Decoder.as_int(meta["transactions"])
				if counted != transactions:
					errors.append(Rs1Decoder.err("end-count-mismatch", "end record says %d transactions, the recording has %d" % [counted, transactions]))
					return errors
				var stats: Dictionary = meta["stats"]
				var declared_bytes: int = Rs1Decoder.as_int(stats["bytes_total"])
				if declared_bytes != bytes_total:
					errors.append(Rs1Decoder.err("end-stats-mismatch", "stats.bytes_total is %d, the recording's own total is %d" % [declared_bytes, bytes_total]))
					return errors
				var max_bytes: int = Rs1Decoder.as_int(stats["max_record_bytes"])
				if max_bytes != max_record_bytes:
					errors.append(Rs1Decoder.err("end-stats-mismatch", "stats.max_record_bytes is %d, the largest earlier record is %d bytes" % [max_bytes, max_record_bytes]))
					return errors
				var declared_full: int = Rs1Decoder.as_int(stats["full_transactions"])
				var declared_patch: int = Rs1Decoder.as_int(stats["patch_transactions"])
				if declared_full != full_transactions or declared_patch != patch_transactions or declared_full + declared_patch != counted:
					errors.append(Rs1Decoder.err("end-stats-mismatch", "stats full/patch_transactions (%d, %d) disagree with the recording (%d, %d)" % [declared_full, declared_patch, full_transactions, patch_transactions]))
					return errors
		return errors

	## Errors for a recording that ran out of records here.
	func finish() -> PackedStringArray:
		var errors := PackedStringArray()
		if records_accepted == 0:
			errors.append(Rs1Decoder.err("missing-session", "the recording has no records"))
		if not end_seen:
			errors.append(Rs1Decoder.err("recording-incomplete", "the input ends after %d records without an end record" % records_accepted))
		return errors

	func _accept_transaction(meta: Dictionary, offset: int, blocks: Array[PackedFloat32Array]) -> PackedStringArray:
		var errors := PackedStringArray()
		var seq: int = Rs1Decoder.as_int(meta["seq"])
		var frame: int = Rs1Decoder.as_int(meta["frame"])
		var encoding: String = meta["encoding"]
		var canvases_meta: Array = meta["canvases"]
		var items_meta: Array = meta["items"]
		var removed_canvases: Array[int] = Rs1Decoder.int_list(meta["removed_canvases"])
		var removed_items: Array[int] = Rs1Decoder.int_list(meta["removed_items"])

		# Record-level id ordering (the lists as THIS record writes them).
		var canvas_order_error: String = Rs1Decoder._check_id_ordering("canvases", canvases_meta, seq)
		if canvas_order_error != "":
			errors.append(canvas_order_error)
			return errors
		var item_order_error: String = Rs1Decoder._check_id_ordering("items", items_meta, seq)
		if item_order_error != "":
			errors.append(item_order_error)
			return errors
		for i: int in range(1, removed_canvases.size()):
			if removed_canvases[i] <= removed_canvases[i - 1]:
				errors.append(Rs1Decoder.err("meta-schema", "seq %d: removed_canvases is not strictly ascending" % seq))
				return errors
		for i: int in range(1, removed_items.size()):
			if removed_items[i] <= removed_items[i - 1]:
				errors.append(Rs1Decoder.err("meta-schema", "seq %d: removed_items is not strictly ascending" % seq))
				return errors

		# Patch rules (render-stream-1.md "Patch error codes").
		var patch_error: String = _check_patch_rules(encoding, seq, meta, removed_canvases, removed_items, canvases_meta, items_meta)
		if patch_error != "":
			errors.append(patch_error)
			return errors

		if seq != last_seq + 1:
			errors.append(Rs1Decoder.err("seq-gap", "transaction at offset %d has seq %d, expected %d" % [offset, seq, last_seq + 1]))
			return errors
		if frame <= last_frame:
			errors.append(Rs1Decoder.err("frame-order", "transaction seq %d has frame %d, not after %d" % [seq, frame, last_frame]))
			return errors

		# cmd-offset / block-count, against this record's own lists.
		var item_f32: PackedFloat32Array = blocks[0]
		var canvas_f32: PackedFloat32Array = blocks[1]
		var cmd_f32: PackedFloat32Array = blocks[2]
		var rects: int = 0
		for value: Variant in items_meta:
			var item: Dictionary = value
			if item["commands"] == null:
				continue
			var commands: Array = item["commands"]
			for cvalue: Variant in commands:
				var command: Dictionary = cvalue
				if command["op"] == "add_rect":
					var f: int = Rs1Decoder.as_int(command["f"])
					if f != Rs1Decoder.RECT_FLOATS * rects:
						errors.append(Rs1Decoder.err("cmd-offset", "seq %d: add_rect #%d has f %d, expected %d" % [seq, rects, f, Rs1Decoder.RECT_FLOATS * rects]))
						return errors
					rects += 1
		if item_f32.size() != Rs1Decoder.ITEM_FLOATS * items_meta.size() or canvas_f32.size() != Rs1Decoder.CANVAS_FLOATS * canvases_meta.size() or cmd_f32.size() != Rs1Decoder.RECT_FLOATS * rects:
			errors.append(Rs1Decoder.err("block-count", "seq %d: decoded block lengths disagree with items/canvases/commands counts" % seq))
			return errors

		var failures: Array = meta["failures"]
		var status: String = meta["status"]
		if (status == "capture-failure") != (failures.size() > 0):
			errors.append(Rs1Decoder.err("meta-schema", "seq %d: status %s with %d failures" % [seq, status, failures.size()]))
			return errors

		# Resolve: merge this transaction onto the running state.
		if encoding == "full":
			canvases = {}
			items = {}
		for id: int in removed_canvases:
			canvases.erase(id)
		for id: int in removed_items:
			items.erase(id)
		for i: int in canvases_meta.size():
			var canvas: Dictionary = canvases_meta[i]
			var lifted: Dictionary = Rs1Decoder._lift_canvas(canvas, canvas_f32.slice(i * Rs1Decoder.CANVAS_FLOATS, (i + 1) * Rs1Decoder.CANVAS_FLOATS))
			canvases[Rs1Decoder.as_int(canvas["id"])] = lifted
		for i: int in items_meta.size():
			var item: Dictionary = items_meta[i]
			var id: int = Rs1Decoder.as_int(item["id"])
			var lifted_item: Dictionary = Rs1Decoder._lift_item(item, item_f32.slice(i * Rs1Decoder.ITEM_FLOATS, (i + 1) * Rs1Decoder.ITEM_FLOATS), cmd_f32)
			if item["commands"] == null:
				var base_commands: Array = []
				if items.has(id):
					var base_item: Dictionary = items[id]
					base_commands = base_item["commands"]
				lifted_item["commands"] = base_commands
			items[id] = lifted_item

		# Resolved-state invariants (render-stream-0.md 1-8, extended by invariant 9).
		var unsupported_meta: Array = meta["unsupported"]
		var resolved_error: String = _check_resolved_invariants(seq, unsupported_meta)
		if resolved_error != "":
			errors.append(resolved_error)
			return errors

		# id-reused: an id written by THIS record (new or changed; an unchanged, carried-over
		# entry cannot be a reappearance) that is <= the highest id of its kind ever seen, and
		# was not already known as of the previous transaction, has come back after being gone.
		var new_canvas_ids: Array[int] = []
		for value: Variant in canvases_meta:
			var c: Dictionary = value
			new_canvas_ids.append(Rs1Decoder.as_int(c["id"]))
		var new_item_ids: Array[int] = []
		for value: Variant in items_meta:
			var it: Dictionary = value
			new_item_ids.append(Rs1Decoder.as_int(it["id"]))
		for id: int in new_canvas_ids:
			if id <= _max_canvas_id and not _known_canvas_ids.has(id):
				errors.append(Rs1Decoder.err("id-reused", "transaction seq %d: canvas id %d is absent from the previous transaction and not above %d" % [seq, id, _max_canvas_id]))
				return errors
		for id: int in new_item_ids:
			if id <= _max_item_id and not _known_item_ids.has(id):
				errors.append(Rs1Decoder.err("id-reused", "transaction seq %d: item id %d is absent from the previous transaction and not above %d" % [seq, id, _max_item_id]))
				return errors
		_known_canvas_ids = {}
		for id: int in canvases:
			_known_canvas_ids[id] = true
			_max_canvas_id = maxi(_max_canvas_id, id)
		_known_item_ids = {}
		for id: int in items:
			_known_item_ids[id] = true
			_max_item_id = maxi(_max_item_id, id)

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

	## render-stream-1.md "Patch error codes". Returns "" when ok, else one "<code>: <detail>".
	func _check_patch_rules(encoding: String, seq: int, meta: Dictionary, removed_canvases: Array[int], removed_items: Array[int], canvases_meta: Array, items_meta: Array) -> String:
		if encoding == "full":
			var base_seq: Variant = meta["base_seq"]
			if base_seq != null or removed_canvases.size() > 0 or removed_items.size() > 0:
				return Rs1Decoder.err("patch-encoding", "seq %d: a full transaction carries a non-null base_seq or a non-empty removed list" % seq)
			return ""
		if session_encoding == "full":
			return Rs1Decoder.err("patch-encoding", "seq %d: a patch transaction in a stream whose session says encoding \"full\"" % seq)
		if transactions == 0:
			return Rs1Decoder.err("patch-base", "seq %d: the stream's first transaction is a patch" % seq)
		var base_seq: int = Rs1Decoder.as_int(meta["base_seq"])
		if base_seq != last_seq:
			return Rs1Decoder.err("patch-base", "seq %d: base_seq %d is not the previous transaction's seq %d" % [seq, base_seq, last_seq])

		var removed_canvas_set: Dictionary[int, bool] = {}
		for id: int in removed_canvases:
			if removed_canvas_set.has(id):
				return Rs1Decoder.err("patch-removed", "seq %d: canvas %d is removed twice" % [seq, id])
			removed_canvas_set[id] = true
			if not canvases.has(id):
				return Rs1Decoder.err("patch-removed", "seq %d: removed canvas %d is absent from the base" % [seq, id])
		var removed_item_set: Dictionary[int, bool] = {}
		for id: int in removed_items:
			if removed_item_set.has(id):
				return Rs1Decoder.err("patch-removed", "seq %d: item %d is removed twice" % [seq, id])
			removed_item_set[id] = true
			if not items.has(id):
				return Rs1Decoder.err("patch-removed", "seq %d: removed item %d is absent from the base" % [seq, id])
		for value: Variant in canvases_meta:
			var c: Dictionary = value
			var id: int = Rs1Decoder.as_int(c["id"])
			if removed_canvas_set.has(id):
				return Rs1Decoder.err("patch-removed", "seq %d: canvas %d is both removed and present" % [seq, id])
		for value: Variant in items_meta:
			var it: Dictionary = value
			var id: int = Rs1Decoder.as_int(it["id"])
			if removed_item_set.has(id):
				return Rs1Decoder.err("patch-removed", "seq %d: item %d is both removed and present" % [seq, id])

		for value: Variant in items_meta:
			var it: Dictionary = value
			var id: int = Rs1Decoder.as_int(it["id"])
			if it["commands"] != null:
				continue
			if not items.has(id):
				return Rs1Decoder.err("patch-commands", "seq %d: item %d is new but carries commands:null" % [seq, id])
			var base: Dictionary = items[id]
			var base_cv: int = Rs1Decoder.as_int(base["content_version"])
			var cur_cv: int = Rs1Decoder.as_int(it["content_version"])
			if base_cv != cur_cv:
				return Rs1Decoder.err("patch-commands", "seq %d: item %d's content_version changed but it carries commands:null" % [seq, id])
		return ""

	## render-stream-0.md invariants 1-8 (ported to the resolved state) plus invariant 9
	## (draw-index ties). Returns "" when ok, else one "<code>: <detail>".
	func _check_resolved_invariants(seq: int, unsupported_meta: Array) -> String:
		var where: String = "transaction seq %d" % seq
		var canvas_ids: Dictionary[int, bool] = {}
		for id: int in canvases:
			canvas_ids[id] = true
		var item_ids: Dictionary[int, bool] = {}
		for id: int in items:
			item_ids[id] = true

		var roots: Array[int] = []
		for id: int in canvases:
			var canvas: Dictionary = canvases[id]
			if canvas["role"] != null:
				roots.append(id)
		if roots.size() != 1 or roots[0] != 1:
			return Rs1Decoder.err("root-canvas", "%s: expected exactly one canvas with role root and id 1" % where)

		var claimed: Dictionary[String, Array] = {}
		for id: int in items:
			var item: Dictionary = items[id]
			var parent: Variant = item["parent"]
			if parent == null:
				continue
			var link: Dictionary = parent
			var kind: String = link["kind"]
			var target: int = Rs1Decoder.as_int(link["id"])
			var exists: bool = canvas_ids.has(target) if kind == "canvas" else item_ids.has(target)
			if not exists:
				return Rs1Decoder.err("dangling-parent", "%s: item %d names parent %s %d, which does not exist" % [where, id, kind, target])
			var key: String = "%s:%d" % [kind, target]
			var list: Array = claimed.get(key, [])
			list.append(id)
			claimed[key] = list
		for id: int in canvases:
			var canvas_for_check: Dictionary = canvases[id]
			var declared_items: Array = canvas_for_check["items"]
			var claimed_canvas_list: Array = claimed.get("canvas:%d" % id, [])
			if not _same_id_set(declared_items, claimed_canvas_list):
				return Rs1Decoder.err("child-list-mismatch", "%s: canvas %d's items[] disagrees with items' parent fields" % [where, id])
		for id: int in items:
			var item_for_check: Dictionary = items[id]
			var declared_children: Array = item_for_check["children"]
			var claimed_item_list: Array = claimed.get("item:%d" % id, [])
			if not _same_id_set(declared_children, claimed_item_list):
				return Rs1Decoder.err("child-list-mismatch", "%s: item %d's children[] disagrees with items' parent fields" % [where, id])

		for id: int in items:
			var seen: Dictionary[int, bool] = {}
			var cursor: int = id
			while true:
				if seen.has(cursor):
					return Rs1Decoder.err("parent-cycle", "%s: following parents from item %d revisits item %d" % [where, id, cursor])
				seen[cursor] = true
				var cur_item: Dictionary = items[cursor]
				var parent: Variant = cur_item["parent"]
				if parent == null:
					break
				var parent_link: Dictionary = parent
				if parent_link["kind"] != "item":
					break
				cursor = Rs1Decoder.as_int(parent_link["id"])

		# Invariant 9: draw-index ties, over every container.
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
				var di: int = Rs1Decoder.as_int(child["draw_index"])
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

		var actual_unsupported_ops: Dictionary[String, bool] = {}
		for id: int in items:
			var item: Dictionary = items[id]
			var commands: Array = item["commands"]
			var names: Dictionary[String, bool] = {}
			for value: Variant in commands:
				var command: Dictionary = value
				if command["op"] == "unsupported":
					names[command["name"]] = true
			for name: String in names:
				actual_unsupported_ops["%d:%s" % [id, name]] = true

		var last_item: int = -1
		var last_op: String = ""
		var item_level_started: bool = false
		var declared_unsupported_ops: Dictionary[String, bool] = {}
		var declared_tie_items: Dictionary[int, bool] = {}
		for value: Variant in unsupported_meta:
			var entry: Dictionary = value
			var op: String = entry["op"]
			var reason: String = entry["reason"]
			if entry["item"] == null:
				if item_level_started:
					return Rs1Decoder.err("unsupported-mismatch", "%s: session-level entry %s follows an item-level entry" % [where, op])
				continue
			item_level_started = true
			var item_id: int = Rs1Decoder.as_int(entry["item"])
			if not item_ids.has(item_id):
				return Rs1Decoder.err("dangling-parent", "%s: unsupported entry names item %d, which does not exist" % [where, item_id])
			if item_id < last_item or (item_id == last_item and op <= last_op):
				return Rs1Decoder.err("unsupported-mismatch", "%s: unsupported entry (%d, %s) is out of order or repeated" % [where, item_id, op])
			last_item = item_id
			last_op = op
			if reason == "unsupported-op":
				var pair: String = "%d:%s" % [item_id, op]
				if not actual_unsupported_ops.has(pair):
					return Rs1Decoder.err("unsupported-mismatch", "%s: unsupported-op entry (%d, %s) has no matching command" % [where, item_id, op])
				declared_unsupported_ops[pair] = true
			elif reason == "draw-index-tie":
				if op != "canvas_item_set_draw_index":
					return Rs1Decoder.err("unsupported-mismatch", "%s: draw-index-tie entry for item %d names op %s, expected canvas_item_set_draw_index" % [where, item_id, op])
				if not expected_tie_items.has(item_id):
					return Rs1Decoder.err("unsupported-mismatch", "%s: draw-index-tie entry for item %d does not correspond to an actual tie" % [where, item_id])
				declared_tie_items[item_id] = true
			elif reason == "unsupported-state":
				if op != "canvas_item_set_material":
					return Rs1Decoder.err("unsupported-mismatch", "%s: unsupported-state entry for item %d names %s, expected canvas_item_set_material" % [where, item_id, op])
		for pair: String in actual_unsupported_ops:
			if not declared_unsupported_ops.has(pair):
				return Rs1Decoder.err("unsupported-mismatch", "%s: unsupported command (%s) has no unsupported-op entry" % [where, pair.replace(":", ", ")])
		for id: int in expected_tie_items:
			if not declared_tie_items.has(id):
				return Rs1Decoder.err("unsupported-mismatch", "%s: items tie on draw_index under item/canvas with smallest id %d, but no draw-index-tie entry is declared" % [where, id])
		return ""

	static func _same_id_set(declared: Array, claimed: Array) -> bool:
		if declared.size() != claimed.size():
			return false
		var declared_set: Dictionary[int, bool] = {}
		for value: Variant in declared:
			var id: int = Rs1Decoder.as_int(value)
			if declared_set.has(id):
				return false
			declared_set[id] = true
		for value: Variant in claimed:
			var id: int = value
			if not declared_set.has(id):
				return false
		return true
