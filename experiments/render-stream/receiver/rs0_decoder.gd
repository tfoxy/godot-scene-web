class_name Rs0Decoder
extends RefCounted
## render-stream/0 decoder and validator (protocol/render-stream-0.md).
##
## Pure: a PackedByteArray in, records and "<code>: <detail>" strings out. It opens no file and
## makes no RenderingServer call. It validates everything the wire spec lists with the same error
## codes as the TypeScript validator, except `meta-noncanonical`: GDScript has no canonical JSON
## writer to re-serialise with (JSON.stringify sorts keys and prints integers as floats).
##
## JSON.parse returns every number as a float. Every wire integer is below 2^53, so an integer is
## accepted only when it is finite, integral and within +-(2^53 - 1), then converted with int().

const MAGIC_HEX: String = "475253300d0a1a0a"
const PROTOCOL: String = "render-stream/0"
const MAX_SAFE_INT: float = 9007199254740991.0
const U32_MAX: float = 4294967295.0
const ITEM_FLOATS: int = 18
const CANVAS_FLOATS: int = 6
const RECT_FLOATS: int = 8

const SESSION_KEYS: Array = [
	"type", "protocol", "session_id", "engine", "capture", "viewport", "features", "sabotage",
	"blocks",
]
const ENGINE_KEYS: Array = [
	"version_string", "sha256", "display_server", "rendering_driver", "rendering_method",
]
const CAPTURE_KEYS: Array = ["calibrator_version", "hooks_planned", "hooks_omitted"]
const VIEWPORT_KEYS: Array = ["canvas_cull_mask", "root_canvas"]
const FEATURES_KEYS: Array = [
	"ops", "item_state", "observed_unsupported_ops", "unobserved", "publication",
]
const PUBLICATION: String = "complete-snapshot-per-frame"
const SABOTAGE_KEYS: Array = ["kind", "frame"]
const SABOTAGE_KINDS: Array = ["freeze-frame", "omit-update", "perturb-transform"]
const TRANSACTION_KEYS: Array = [
	"type", "seq", "frame", "status", "failures", "unsupported", "canvases", "items", "blocks",
]
const STATUSES: Array = ["ok", "capture-failure"]
const FAILURE_KEYS: Array = ["reason", "detail"]
const FAILURE_REASONS: Array = ["root-query-failed", "pre-existing-object", "mirror-capacity"]
const UNSUPPORTED_KEYS: Array = ["op", "item", "reason"]
const SESSION_UNSUPPORTED_OPS: Array = ["viewport_attach_canvas", "viewport_set_canvas_transform"]
const SESSION_UNSUPPORTED_REASONS: Array = ["non-root-viewport", "extra-canvas"]
const ITEM_UNSUPPORTED_REASONS: Array = ["unsupported-op", "unsupported-state"]
const CANVAS_KEYS: Array = ["id", "origin", "role", "attached", "items"]
const ORIGINS: Array = ["created", "root-query", "adopted"]
const ITEM_KEYS: Array = [
	"id", "origin", "parent", "children", "visible", "draw_index", "z_index", "clip",
	"custom_rect", "visibility_layer", "content_version", "commands",
]
const PARENT_KEYS: Array = ["kind", "id"]
const PARENT_KINDS: Array = ["canvas", "item"]
const ADD_RECT_KEYS: Array = ["op", "aa", "f"]
const UNSUPPORTED_COMMAND_KEYS: Array = ["op", "name"]
const END_KEYS: Array = ["type", "transactions", "reason", "stats", "blocks"]
const END_REASONS: Array = ["shutdown", "disarm"]
const STATS_KEYS: Array = [
	"bytes_total", "encode_ns_total", "snapshot_ns_total", "max_record_bytes",
]
const BLOCK_KEYS: Array = ["name", "type", "count"]
const SESSION_BLOCK_NAMES: Array = ["clear_color", "root_canvas_xform", "host_visible_rect"]
const SESSION_BLOCK_COUNTS: Array = [4, 6, 4]
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


# --------------------------------------------------------------------------- one record


## Decodes and validates one record: framing, meta JSON, meta schema, block framing, and the
## per-record invariants. Returns {offset, byte_length, sha256, meta: Dictionary,
## blocks: Array[PackedFloat32Array], errors: PackedStringArray}. `meta` is the parsed JSON
## (every number a float) whenever it parsed, even if later checks failed.
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

	# Block framing against the declared blocks.
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

	var kind_name: String = kind
	match kind_name:
		"session":
			errors.append_array(_session_invariants(meta, offset))
		"transaction":
			errors.append_array(_transaction_invariants(meta, offset))
	out["errors"] = errors
	return out


static func _session_invariants(meta: Dictionary, offset: int) -> PackedStringArray:
	var errors := PackedStringArray()
	var declared: Array = meta["blocks"]
	for i: int in declared.size():
		var entry: Dictionary = declared[i]
		var expected: int = SESSION_BLOCK_COUNTS[i]
		if as_int(entry["count"]) != expected:
			errors.append(err("block-count", "record at offset %d: session block %s has count %d, expected %d" % [offset, entry["name"], as_int(entry["count"]), expected]))
	var viewport: Dictionary = meta["viewport"]
	if as_int(viewport["root_canvas"]) != 1:
		errors.append(err("root-canvas", "record at offset %d: session viewport.root_canvas is %d, expected 1" % [offset, as_int(viewport["root_canvas"])]))
	return errors


static func container_key(kind: String, id: int) -> String:
	return "%s:%d" % [kind, id]


static func _transaction_invariants(meta: Dictionary, offset: int) -> PackedStringArray:
	var errors := PackedStringArray()
	var where: String = "record at offset %d (seq %d)" % [offset, as_int(meta["seq"])]
	var canvases: Array = meta["canvases"]
	var items: Array = meta["items"]

	# 1. Sorted, unique ids.
	var canvas_by_id: Dictionary[int, Dictionary] = {}
	var previous: int = 0
	for value: Variant in canvases:
		var canvas: Dictionary = value
		var id: int = as_int(canvas["id"])
		if canvas_by_id.has(id):
			errors.append(err("duplicate-id", "%s: canvas id %d appears twice" % [where, id]))
			return errors
		if id < previous:
			errors.append(err("meta-schema", "%s: canvas ids are not ascending (%d after %d)" % [where, id, previous]))
			return errors
		canvas_by_id[id] = canvas
		previous = id
	var item_by_id: Dictionary[int, Dictionary] = {}
	previous = 0
	for value: Variant in items:
		var item: Dictionary = value
		var id: int = as_int(item["id"])
		if item_by_id.has(id):
			errors.append(err("duplicate-id", "%s: item id %d appears twice" % [where, id]))
			return errors
		if id < previous:
			errors.append(err("meta-schema", "%s: item ids are not ascending (%d after %d)" % [where, id, previous]))
			return errors
		item_by_id[id] = item
		previous = id

	# 2. Exactly one root canvas, and it is canvas 1.
	var roots: Array[int] = []
	for id: int in canvas_by_id:
		if canvas_by_id[id]["role"] != null:
			roots.append(id)
	if not canvas_by_id.has(1):
		errors.append(err("root-canvas", "%s: no canvas 1" % where))
	elif roots.size() != 1 or roots[0] != 1:
		errors.append(err("root-canvas", "%s: canvases with role root are %s, expected [1]" % [where, str(roots)]))

	# Container lists by key, as ints.
	var lists: Dictionary[String, Array] = {}
	for id: int in canvas_by_id:
		lists[container_key("canvas", id)] = int_list(canvas_by_id[id]["items"])
	for id: int in item_by_id:
		lists[container_key("item", id)] = int_list(item_by_id[id]["children"])

	# 3. Parents resolve, and each child is listed exactly once by its parent.
	var parent_key: Dictionary[int, String] = {}
	var dangling: bool = false
	for id: int in item_by_id:
		var parent: Variant = item_by_id[id]["parent"]
		if parent == null:
			parent_key[id] = ""
			continue
		var link: Dictionary = parent
		var kind: String = link["kind"]
		var target: int = as_int(link["id"])
		var exists: bool = canvas_by_id.has(target) if kind == "canvas" else item_by_id.has(target)
		if not exists:
			errors.append(err("dangling-parent", "%s: item %d names parent %s %d, which is not in the transaction" % [where, id, kind, target]))
			dangling = true
			continue
		var key: String = container_key(kind, target)
		parent_key[id] = key
		var listed: int = lists[key].count(id)
		if listed != 1:
			errors.append(err("child-list-mismatch", "%s: item %d appears %d times in its parent %s's list" % [where, id, listed, key]))

	# 4. Every listed id is an item whose parent is that container.
	for key: String in lists:
		for child: Variant in lists[key]:
			var child_id: int = child
			if not item_by_id.has(child_id):
				errors.append(err("child-list-mismatch", "%s: %s lists item %d, which is not in the transaction" % [where, key, child_id]))
			elif parent_key.get(child_id, "") != key:
				errors.append(err("child-list-mismatch", "%s: %s lists item %d, whose parent is %s" % [where, key, child_id, JSON.stringify(parent_key.get(child_id, ""))]))

	# 5. No parent cycles (only meaningful once every parent resolves).
	if not dangling:
		for id: int in item_by_id:
			var seen: Dictionary[int, bool] = {}
			var cursor: int = id
			while true:
				if seen.has(cursor):
					errors.append(err("parent-cycle", "%s: following parents from item %d revisits item %d" % [where, id, cursor]))
					break
				seen[cursor] = true
				var key: String = parent_key[cursor]
				if not key.begins_with("item:"):
					break
				cursor = key.substr(5).to_int()

	# 6. add_rect offsets and block counts.
	var rects: int = 0
	var command_pairs: Dictionary[String, bool] = {}
	for id: int in item_by_id:
		var commands: Array = item_by_id[id]["commands"]
		for value: Variant in commands:
			var command: Dictionary = value
			if command["op"] == "add_rect":
				var f: int = as_int(command["f"])
				if f != RECT_FLOATS * rects:
					errors.append(err("cmd-offset", "%s: item %d add_rect #%d has f %d, expected %d" % [where, id, rects, f, RECT_FLOATS * rects]))
				rects += 1
			else:
				command_pairs["%d|%s" % [id, command["name"]]] = true
	var declared: Array = meta["blocks"]
	var expected_counts: Array[int] = [
		ITEM_FLOATS * items.size(), CANVAS_FLOATS * canvases.size(), RECT_FLOATS * rects,
	]
	for i: int in declared.size():
		var entry: Dictionary = declared[i]
		if as_int(entry["count"]) != expected_counts[i]:
			errors.append(err("block-count", "%s: block %s has count %d, expected %d" % [where, entry["name"], as_int(entry["count"]), expected_counts[i]]))

	# 7. status agrees with failures.
	var failures: Array = meta["failures"]
	var status: String = meta["status"]
	if (status == "capture-failure") != (failures.size() > 0):
		errors.append(err("meta-schema", "%s: status %s with %d failures" % [where, status, failures.size()]))

	# 8. Unsupported entries: session-level first, then item-level sorted by (item, op), one per
	# distinct unsupported (item, name) command pair.
	var unsupported: Array = meta["unsupported"]
	var item_level_started: bool = false
	var last_item: int = -1
	var last_op: String = ""
	var session_seen: Dictionary[String, bool] = {}
	var entry_pairs: Dictionary[String, bool] = {}
	for value: Variant in unsupported:
		var entry: Dictionary = value
		var op: String = entry["op"]
		var reason: String = entry["reason"]
		if entry["item"] == null:
			if item_level_started:
				errors.append(err("unsupported-mismatch", "%s: session-level entry %s follows an item-level entry" % [where, op]))
			var session_key: String = op + "|" + reason
			if session_seen.has(session_key):
				errors.append(err("unsupported-mismatch", "%s: session-level entry %s/%s repeats" % [where, op, reason]))
			session_seen[session_key] = true
			continue
		item_level_started = true
		var item_id: int = as_int(entry["item"])
		if not item_by_id.has(item_id):
			errors.append(err("dangling-parent", "%s: unsupported entry names item %d, which is not in the transaction" % [where, item_id]))
			continue
		if item_id < last_item or (item_id == last_item and op <= last_op):
			errors.append(err("unsupported-mismatch", "%s: unsupported entry (%d, %s) is out of order or repeated" % [where, item_id, op]))
		last_item = item_id
		last_op = op
		if reason == "unsupported-op":
			var pair: String = "%d|%s" % [item_id, op]
			if not command_pairs.has(pair):
				errors.append(err("unsupported-mismatch", "%s: unsupported-op entry (%d, %s) has no matching command" % [where, item_id, op]))
			entry_pairs[pair] = true
		elif op != "canvas_item_set_material":
			errors.append(err("unsupported-mismatch", "%s: unsupported-state entry for item %d names %s, expected canvas_item_set_material" % [where, item_id, op]))
	for pair: String in command_pairs:
		if not entry_pairs.has(pair):
			errors.append(err("unsupported-mismatch", "%s: unsupported command (%s) has no unsupported-op entry" % [where, pair.replace("|", ", ")]))
	return errors


## A JSON array of integers (already schema-checked) as Array[int].
static func int_list(values: Variant) -> Array[int]:
	var source: Array = values
	var out: Array[int] = []
	for value: Variant in source:
		out.append(as_int(value))
	return out


# --------------------------------------------------------------------------- whole recording


## Validates a whole recording. Returns "<code>: <detail>" strings; empty means valid. Stops at
## the first framing error and at the first record that fails to decode, because later records
## would only repeat that failure as cascade errors.
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
		if stream.end_seen:
			var end_at: int = as_int(record["offset"]) + as_int(record["byte_length"])
			if end_at < data.size():
				errors.append(err("trailing-bytes", "%d bytes follow the end record at offset %d" % [data.size() - end_at, as_int(record["offset"])]))
			return errors
	errors.append_array(split_errors)
	errors.append_array(stream.finish())
	return errors


## Cross-record state: session first and once, contiguous seqs, increasing frames, ids never
## reused, and the end record's counts.
class Stream:
	extends RefCounted

	var records_accepted: int = 0
	var session_seen: bool = false
	var end_seen: bool = false
	var last_seq: int = 0
	var last_frame: int = 0
	var transactions: int = 0
	var max_record_bytes: int = 0
	var _previous_items: Dictionary[int, bool] = {}
	var _previous_canvases: Dictionary[int, bool] = {}
	var _max_item_id: int = 0
	var _max_canvas_id: int = 0

	## The seq a transaction arriving now must carry.
	func expected_seq() -> int:
		return last_seq + 1

	## Accepts one decoded record (decode_record's result, without errors).
	func accept(record: Dictionary) -> PackedStringArray:
		var errors := PackedStringArray()
		var meta: Dictionary = record["meta"]
		var kind: String = meta["type"]
		var offset: int = Rs0Decoder.as_int(record["offset"])
		var byte_length: int = Rs0Decoder.as_int(record["byte_length"])
		var index: int = records_accepted
		records_accepted += 1
		if end_seen:
			errors.append(Rs0Decoder.err("trailing-bytes", "record %d at offset %d follows the end record" % [index, offset]))
			return errors
		if index == 0 and kind != "session":
			errors.append(Rs0Decoder.err("missing-session", "the first record is a %s, not a session" % kind))
		match kind:
			"session":
				if index != 0:
					errors.append(Rs0Decoder.err("duplicate-session", "record %d at offset %d is a second session" % [index, offset]))
				session_seen = true
				max_record_bytes = maxi(max_record_bytes, byte_length)
			"transaction":
				errors.append_array(_accept_transaction(meta, offset))
				max_record_bytes = maxi(max_record_bytes, byte_length)
			"end":
				end_seen = true
				var counted: int = Rs0Decoder.as_int(meta["transactions"])
				if counted != transactions:
					errors.append(Rs0Decoder.err("end-count-mismatch", "end record says %d transactions, the recording has %d" % [counted, transactions]))
				var stats: Dictionary = meta["stats"]
				var bytes_total: int = Rs0Decoder.as_int(stats["bytes_total"])
				if bytes_total != offset:
					errors.append(Rs0Decoder.err("end-stats-mismatch", "stats.bytes_total is %d, the end record starts at offset %d" % [bytes_total, offset]))
				var max_bytes: int = Rs0Decoder.as_int(stats["max_record_bytes"])
				if max_bytes != max_record_bytes:
					errors.append(Rs0Decoder.err("end-stats-mismatch", "stats.max_record_bytes is %d, the largest earlier record is %d bytes" % [max_bytes, max_record_bytes]))
		return errors

	## Errors for a recording that ran out of records here.
	func finish() -> PackedStringArray:
		var errors := PackedStringArray()
		if records_accepted == 0:
			errors.append(Rs0Decoder.err("missing-session", "the recording has no records"))
		if not end_seen:
			errors.append(Rs0Decoder.err("recording-incomplete", "the input ends after %d records without an end record" % records_accepted))
		return errors

	func _accept_transaction(meta: Dictionary, offset: int) -> PackedStringArray:
		var errors := PackedStringArray()
		var seq: int = Rs0Decoder.as_int(meta["seq"])
		var frame: int = Rs0Decoder.as_int(meta["frame"])
		if seq != last_seq + 1:
			errors.append(Rs0Decoder.err("seq-gap", "transaction at offset %d has seq %d, expected %d" % [offset, seq, last_seq + 1]))
		if frame <= last_frame:
			errors.append(Rs0Decoder.err("frame-order", "transaction seq %d has frame %d, not after %d" % [seq, frame, last_frame]))
		var canvases: Array = meta["canvases"]
		var items: Array = meta["items"]
		var canvas_ids: Dictionary[int, bool] = {}
		var item_ids: Dictionary[int, bool] = {}
		var new_max_canvas: int = _max_canvas_id
		var new_max_item: int = _max_item_id
		for value: Variant in canvases:
			var canvas: Dictionary = value
			var id: int = Rs0Decoder.as_int(canvas["id"])
			canvas_ids[id] = true
			if not _previous_canvases.has(id) and id <= _max_canvas_id:
				errors.append(Rs0Decoder.err("id-reused", "transaction seq %d: canvas id %d is absent from the previous transaction and not above %d" % [seq, id, _max_canvas_id]))
			new_max_canvas = maxi(new_max_canvas, id)
		for value: Variant in items:
			var item: Dictionary = value
			var id: int = Rs0Decoder.as_int(item["id"])
			item_ids[id] = true
			if not _previous_items.has(id) and id <= _max_item_id:
				errors.append(Rs0Decoder.err("id-reused", "transaction seq %d: item id %d is absent from the previous transaction and not above %d" % [seq, id, _max_item_id]))
			new_max_item = maxi(new_max_item, id)
		_previous_canvases = canvas_ids
		_previous_items = item_ids
		_max_canvas_id = new_max_canvas
		_max_item_id = new_max_item
		last_seq = seq
		last_frame = frame
		transactions += 1
		return errors


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
		if not Rs0Decoder.is_int(value):
			fail("%s is %s, not an integer" % [path, JSON.stringify(value)])
			return 0
		var number: float = value
		if number < low or number > high:
			fail("%s is %d, outside %d..%d" % [path, int(number), int(low), int(high)])
			return 0
		return int(number)

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
		if ok and not Rs0Decoder._is_lower_hex(text, length):
			fail("%s is not %d lowercase hex digits" % [path, length])

	func sorted_strings(value: Variant, path: String) -> void:
		var list: Array = array(value, path)
		var last: String = ""
		for i: int in list.size():
			var text: String = string(list[i], "%s[%d]" % [path, i])
			if ok and i > 0 and not (last < text):
				fail("%s is not sorted ascending without repeats at %d" % [path, i])
			last = text

	func int_list(value: Variant, path: String) -> void:
		var list: Array = array(value, path)
		for i: int in list.size():
			integer(list[i], "%s[%d]" % [path, i], 1, Rs0Decoder.MAX_SAFE_INT)

	func blocks(value: Variant, names: Array) -> void:
		var list: Array = array(value, "meta.blocks")
		if ok and list.size() != names.size():
			fail("meta.blocks has %d entries, expected %s" % [list.size(), JSON.stringify(names)])
		for i: int in list.size():
			var path: String = "meta.blocks[%d]" % i
			var entry: Dictionary = object(list[i], Rs0Decoder.BLOCK_KEYS, path)
			var expected_name: String = names[i]
			exact(entry.get("name"), expected_name, path + ".name")
			exact(entry.get("type"), "f32", path + ".type")
			integer(entry.get("count"), path + ".count", 0, Rs0Decoder.U32_MAX)

	func session(meta: Dictionary) -> void:
		object(meta, Rs0Decoder.SESSION_KEYS, "meta")
		exact(meta.get("protocol"), Rs0Decoder.PROTOCOL, "meta.protocol")
		hex(meta.get("session_id"), 32, "meta.session_id")
		var engine: Dictionary = object(meta.get("engine"), Rs0Decoder.ENGINE_KEYS, "meta.engine")
		string(engine.get("version_string"), "meta.engine.version_string")
		hex(engine.get("sha256"), 64, "meta.engine.sha256")
		string(engine.get("display_server"), "meta.engine.display_server")
		string(engine.get("rendering_driver"), "meta.engine.rendering_driver")
		string(engine.get("rendering_method"), "meta.engine.rendering_method")
		var capture: Dictionary = object(meta.get("capture"), Rs0Decoder.CAPTURE_KEYS, "meta.capture")
		integer(capture.get("calibrator_version"), "meta.capture.calibrator_version", 0, Rs0Decoder.MAX_SAFE_INT)
		sorted_strings(capture.get("hooks_planned"), "meta.capture.hooks_planned")
		sorted_strings(capture.get("hooks_omitted"), "meta.capture.hooks_omitted")
		var viewport: Dictionary = object(meta.get("viewport"), Rs0Decoder.VIEWPORT_KEYS, "meta.viewport")
		integer(viewport.get("canvas_cull_mask"), "meta.viewport.canvas_cull_mask", 0, Rs0Decoder.U32_MAX)
		integer(viewport.get("root_canvas"), "meta.viewport.root_canvas", -Rs0Decoder.MAX_SAFE_INT, Rs0Decoder.MAX_SAFE_INT)
		var features: Dictionary = object(meta.get("features"), Rs0Decoder.FEATURES_KEYS, "meta.features")
		sorted_strings(features.get("ops"), "meta.features.ops")
		sorted_strings(features.get("item_state"), "meta.features.item_state")
		sorted_strings(features.get("observed_unsupported_ops"), "meta.features.observed_unsupported_ops")
		sorted_strings(features.get("unobserved"), "meta.features.unobserved")
		exact(features.get("publication"), Rs0Decoder.PUBLICATION, "meta.features.publication")
		var sabotage: Variant = meta.get("sabotage")
		if ok and sabotage != null:
			var spec: Dictionary = object(sabotage, Rs0Decoder.SABOTAGE_KEYS, "meta.sabotage")
			one_of(spec.get("kind"), Rs0Decoder.SABOTAGE_KINDS, "meta.sabotage.kind")
			integer(spec.get("frame"), "meta.sabotage.frame", 1, Rs0Decoder.MAX_SAFE_INT)
		blocks(meta.get("blocks"), Rs0Decoder.SESSION_BLOCK_NAMES)

	func transaction(meta: Dictionary) -> void:
		object(meta, Rs0Decoder.TRANSACTION_KEYS, "meta")
		integer(meta.get("seq"), "meta.seq", 1, Rs0Decoder.MAX_SAFE_INT)
		integer(meta.get("frame"), "meta.frame", 1, Rs0Decoder.MAX_SAFE_INT)
		one_of(meta.get("status"), Rs0Decoder.STATUSES, "meta.status")
		var failures: Array = array(meta.get("failures"), "meta.failures")
		for i: int in failures.size():
			var path: String = "meta.failures[%d]" % i
			var failure: Dictionary = object(failures[i], Rs0Decoder.FAILURE_KEYS, path)
			one_of(failure.get("reason"), Rs0Decoder.FAILURE_REASONS, path + ".reason")
			string(failure.get("detail"), path + ".detail")
		var unsupported: Array = array(meta.get("unsupported"), "meta.unsupported")
		for i: int in unsupported.size():
			var path: String = "meta.unsupported[%d]" % i
			var entry: Dictionary = object(unsupported[i], Rs0Decoder.UNSUPPORTED_KEYS, path)
			if not ok:
				return
			if entry["item"] == null:
				one_of(entry["op"], Rs0Decoder.SESSION_UNSUPPORTED_OPS, path + ".op")
				one_of(entry["reason"], Rs0Decoder.SESSION_UNSUPPORTED_REASONS, path + ".reason")
			else:
				string(entry["op"], path + ".op")
				integer(entry["item"], path + ".item", 1, Rs0Decoder.MAX_SAFE_INT)
				one_of(entry["reason"], Rs0Decoder.ITEM_UNSUPPORTED_REASONS, path + ".reason")
		var canvases: Array = array(meta.get("canvases"), "meta.canvases")
		for i: int in canvases.size():
			var path: String = "meta.canvases[%d]" % i
			var canvas: Dictionary = object(canvases[i], Rs0Decoder.CANVAS_KEYS, path)
			integer(canvas.get("id"), path + ".id", 1, Rs0Decoder.MAX_SAFE_INT)
			one_of(canvas.get("origin"), Rs0Decoder.ORIGINS, path + ".origin")
			var role: Variant = canvas.get("role")
			if ok and role != null:
				exact(role, "root", path + ".role")
			boolean(canvas.get("attached"), path + ".attached")
			int_list(canvas.get("items"), path + ".items")
		var items: Array = array(meta.get("items"), "meta.items")
		for i: int in items.size():
			var path: String = "meta.items[%d]" % i
			var item: Dictionary = object(items[i], Rs0Decoder.ITEM_KEYS, path)
			integer(item.get("id"), path + ".id", 1, Rs0Decoder.MAX_SAFE_INT)
			one_of(item.get("origin"), Rs0Decoder.ORIGINS, path + ".origin")
			var parent: Variant = item.get("parent")
			if ok and parent != null:
				var link: Dictionary = object(parent, Rs0Decoder.PARENT_KEYS, path + ".parent")
				one_of(link.get("kind"), Rs0Decoder.PARENT_KINDS, path + ".parent.kind")
				integer(link.get("id"), path + ".parent.id", 1, Rs0Decoder.MAX_SAFE_INT)
			int_list(item.get("children"), path + ".children")
			boolean(item.get("visible"), path + ".visible")
			integer(item.get("draw_index"), path + ".draw_index", -Rs0Decoder.MAX_SAFE_INT, Rs0Decoder.MAX_SAFE_INT)
			integer(item.get("z_index"), path + ".z_index", -Rs0Decoder.MAX_SAFE_INT, Rs0Decoder.MAX_SAFE_INT)
			boolean(item.get("clip"), path + ".clip")
			boolean(item.get("custom_rect"), path + ".custom_rect")
			integer(item.get("visibility_layer"), path + ".visibility_layer", 0, Rs0Decoder.U32_MAX)
			integer(item.get("content_version"), path + ".content_version", 0, Rs0Decoder.MAX_SAFE_INT)
			var commands: Array = array(item.get("commands"), path + ".commands")
			for j: int in commands.size():
				var cpath: String = "%s.commands[%d]" % [path, j]
				if not ok:
					return
				if typeof(commands[j]) != TYPE_DICTIONARY:
					fail(cpath + " is not an object")
					return
				var command: Dictionary = commands[j]
				var op: Variant = command.get("op")
				if op is String and op == "add_rect":
					object(command, Rs0Decoder.ADD_RECT_KEYS, cpath)
					boolean(command.get("aa"), cpath + ".aa")
					integer(command.get("f"), cpath + ".f", 0, Rs0Decoder.MAX_SAFE_INT)
				elif op is String and op == "unsupported":
					object(command, Rs0Decoder.UNSUPPORTED_COMMAND_KEYS, cpath)
					string(command.get("name"), cpath + ".name")
				else:
					fail("%s.op is %s, expected add_rect or unsupported" % [cpath, JSON.stringify(op)])
		blocks(meta.get("blocks"), Rs0Decoder.TRANSACTION_BLOCK_NAMES)

	func end(meta: Dictionary) -> void:
		object(meta, Rs0Decoder.END_KEYS, "meta")
		integer(meta.get("transactions"), "meta.transactions", 0, Rs0Decoder.MAX_SAFE_INT)
		one_of(meta.get("reason"), Rs0Decoder.END_REASONS, "meta.reason")
		var stats: Dictionary = object(meta.get("stats"), Rs0Decoder.STATS_KEYS, "meta.stats")
		for key: Variant in Rs0Decoder.STATS_KEYS:
			var stat: String = key
			integer(stats.get(stat), "meta.stats." + stat, 0, Rs0Decoder.MAX_SAFE_INT)
		blocks(meta.get("blocks"), [])
