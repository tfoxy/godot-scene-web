extends SceneTree
## Rs1Decoder self-test against the shared golden vectors (protocol/golden-1/).
##
##   godot --headless --path receiver --script res://tests/codec1_selftest.gd
##
## RS_SELFTEST_GOLDEN_DIR overrides the golden directory (default <receiver>/../protocol/golden-1).
## Prints "[rs1-selftest] ok" and quits 0, or prints each failure and quits 1.
##
## Three properties, per gate1-design.md G1b1 "Pass criteria":
##   1. decodeRecording()-equivalent (split_records + decode_record) deep-equals *.decoded.json;
##   2. the Stream's resolved state after each transaction deep-equals resolved.json's
##      per-seq state (stream_id and per-transaction "encoding" excepted, same as self-test-rs1.ts);
##   3. every invalid/*.rs1 yields its index.json code, and validate_recording() of both valid
##      vectors is [].

var _failures: Array[String] = []
var _golden: String = ""


func _initialize() -> void:
	_golden = OS.get_environment("RS_SELFTEST_GOLDEN_DIR")
	if _golden == "":
		_golden = ProjectSettings.globalize_path("res://").path_join("../protocol/golden-1").simplify_path()
	print("[rs1-selftest] golden %s" % _golden)
	var index: Dictionary = _read_json("index.json")
	if index.is_empty():
		_finish()
		return
	var resolved_file: String = index["resolved"]
	var resolved: Dictionary = _read_json(resolved_file)
	_test_valid(index, resolved)
	_test_invalid(index)
	_test_corrupt(index)
	_finish()


func _finish() -> void:
	if _failures.is_empty():
		print("[rs1-selftest] ok")
		quit(0)
	else:
		for failure: String in _failures:
			print("[rs1-selftest] FAIL: " + failure)
		print("[rs1-selftest] %d failure(s)" % _failures.size())
		quit(1)


func _check(condition: Variant, what: String) -> void:
	if not condition:
		_failures.append(what)


func _read_bytes(relative: String) -> PackedByteArray:
	var path: String = _golden.path_join(relative)
	var data: PackedByteArray = FileAccess.get_file_as_bytes(path)
	_check(not data.is_empty(), "cannot read %s" % path)
	return data


func _read_json(relative: String) -> Dictionary:
	var path: String = _golden.path_join(relative)
	var json := JSON.new()
	if json.parse(FileAccess.get_file_as_string(path)) != OK or typeof(json.data) != TYPE_DICTIONARY:
		_failures.append("cannot parse %s as a JSON object" % path)
		return {}
	var parsed: Dictionary = json.data
	return parsed


## decodeRecording() in GDScript: the golden decoded form, built from Rs1Decoder's own API.
func _decode_recording(data: PackedByteArray) -> Dictionary:
	var split: Dictionary = Rs1Decoder.split_records(data)
	var records: Array[Dictionary] = split["records"]
	var split_errors: PackedStringArray = split["errors"]
	_check(split_errors.is_empty(), "split_records errors: %s" % str(split_errors))
	var decoded: Array = []
	for raw: Dictionary in records:
		var record: Dictionary = Rs1Decoder.decode_record(data, Rs1Decoder.as_int(raw["offset"]))
		var errors: PackedStringArray = record["errors"]
		_check(errors.is_empty(), "decode_record at %d errors: %s" % [Rs1Decoder.as_int(raw["offset"]), str(errors)])
		_check(record["byte_length"] == raw["byte_length"], "byte_length disagrees between split_records and decode_record at %d" % Rs1Decoder.as_int(raw["offset"]))
		var blocks: Array[PackedFloat32Array] = record["blocks"]
		var block_lists: Array = []
		for block: PackedFloat32Array in blocks:
			var floats: Array = []
			for value: float in block:
				floats.append(value)
			block_lists.append(floats)
		decoded.append({
			"offset": record["offset"],
			"byte_length": record["byte_length"],
			"sha256": record["sha256"],
			"meta": record["meta"],
			"blocks": block_lists,
		})
	return {
		"schema": "render-stream-1-decoded/1",
		"magic": data.slice(0, 8).hex_encode(),
		"records": decoded,
	}


## The "state" shape resolved.json carries per transaction, read off a Stream right after it
## accepted that transaction's record.
func _snapshot_state(stream: Rs1Decoder.Stream, meta: Dictionary) -> Dictionary:
	var canvas_ids: Array[int] = []
	for id: int in stream.canvases:
		canvas_ids.append(id)
	canvas_ids.sort()
	var canvases_out: Array = []
	for id: int in canvas_ids:
		canvases_out.append(stream.canvases[id])
	var item_ids: Array[int] = []
	for id: int in stream.items:
		item_ids.append(id)
	item_ids.sort()
	var items_out: Array = []
	for id: int in item_ids:
		items_out.append(stream.items[id])
	return {
		"status": meta["status"],
		"failures": meta["failures"],
		"unsupported": meta["unsupported"],
		"canvases": canvases_out,
		"items": items_out,
	}


func _test_valid(index: Dictionary, resolved: Dictionary) -> void:
	var valid: Array = index["valid"]
	for value: Variant in valid:
		var vector: Dictionary = value
		var file: String = vector["file"]
		var data: PackedByteArray = _read_bytes(file)
		_check(Rs1Decoder.sha256_hex(data) == vector["sha256"], "%s sha256 differs from index.json" % file)

		var decoded_file: String = vector["decoded"]
		var expected_decoded: Dictionary = _read_json(decoded_file)
		var actual_decoded: Dictionary = _decode_recording(data)
		var diffs: Array[String] = []
		_deep_equal(actual_decoded, expected_decoded, "$", diffs)
		for diff: String in diffs.slice(0, 20):
			_failures.append("%s decoded form: %s" % [file, diff])

		# render-stream-1.md "Golden vectors": resolved.json omits the top-level stream_id and
		# the per-transaction "encoding" field (full.rs1 and patch.rs1 legitimately differ
		# there), so only the per-seq "state" object is compared.
		var split: Dictionary = Rs1Decoder.split_records(data)
		var records: Array[Dictionary] = split["records"]
		var stream := Rs1Decoder.Stream.new()
		var expected_transactions: Array = resolved["transactions"]
		var resolved_index: int = 0
		for i: int in records.size():
			var raw: Dictionary = records[i]
			var record: Dictionary = Rs1Decoder.decode_record(data, Rs1Decoder.as_int(raw["offset"]))
			var record_errors: PackedStringArray = record["errors"]
			_check(record_errors.is_empty(), "%s record %d decode errors: %s" % [file, i, str(record_errors)])
			var accept_errors: PackedStringArray = stream.accept(record)
			_check(accept_errors.is_empty(), "%s record %d accept errors: %s" % [file, i, str(accept_errors)])
			var meta: Dictionary = record["meta"]
			if meta.get("type") == "transaction":
				_check(resolved_index < expected_transactions.size(), "%s: more transactions than resolved.json has" % file)
				if resolved_index < expected_transactions.size():
					var expected_txn: Dictionary = expected_transactions[resolved_index]
					var actual_state: Dictionary = _snapshot_state(stream, meta)
					var expected_state: Dictionary = expected_txn["state"]
					var state_diffs: Array[String] = []
					_deep_equal(actual_state, expected_state, "$", state_diffs)
					for diff: String in state_diffs.slice(0, 20):
						_failures.append("%s seq %d resolved state: %s" % [file, resolved_index + 1, diff])
				resolved_index += 1
		_check(stream.end_seen, "%s: the stream did not see the end record" % file)
		_check(resolved_index == expected_transactions.size(), "%s: saw %d transactions, resolved.json has %d" % [file, resolved_index, expected_transactions.size()])

		var errors: PackedStringArray = Rs1Decoder.validate_recording(data)
		_check(errors.is_empty(), "%s should validate, got %s" % [file, str(errors)])


func _test_invalid(index: Dictionary) -> void:
	var invalid: Array = index["invalid"]
	_check(invalid.size() == 11, "index.json lists %d invalid vectors, expected 11" % invalid.size())
	for value: Variant in invalid:
		var vector: Dictionary = value
		var file: String = vector["file"]
		var code: String = vector["code"]
		var errors: PackedStringArray = Rs1Decoder.validate_recording(_read_bytes(file))
		var found: bool = false
		for error: String in errors:
			if Rs1Decoder.code_of(error) == code:
				found = true
		_check(found, "%s should be rejected with %s, got %s" % [file, code, str(errors)])
		print("[rs1-selftest] %s -> %s" % [file, errors[0] if errors.size() > 0 else "(accepted)"])


func _test_corrupt(index: Dictionary) -> void:
	var corrupt: Array = index["corrupt"]
	for value: Variant in corrupt:
		var vector: Dictionary = value
		var file: String = vector["file"]
		var code: String = vector["code"]
		var record_index: int = Rs1Decoder.as_int(vector["record_index"])
		var data: PackedByteArray = _read_bytes(file)
		var split: Dictionary = Rs1Decoder.split_records(data)
		var split_errors: PackedStringArray = split["errors"]
		_check(split_errors.is_empty(), "%s: framing must be intact, got %s" % [file, str(split_errors)])
		var records: Array[Dictionary] = split["records"]
		var first_bad: int = -1
		var first_code: String = ""
		for i: int in records.size():
			var record: Dictionary = Rs1Decoder.decode_record(data, Rs1Decoder.as_int(records[i]["offset"]))
			var errors: PackedStringArray = record["errors"]
			if not errors.is_empty():
				first_bad = i
				first_code = Rs1Decoder.code_of(errors[0])
				break
		_check(first_bad == record_index and first_code == code, "%s: first bad record is %d (%s), expected %d (%s)" % [file, first_bad, first_code, record_index, code])
		var whole: PackedStringArray = Rs1Decoder.validate_recording(data)
		_check(whole.size() > 0 and Rs1Decoder.code_of(whole[0]) == code, "%s: validate_recording gave %s" % [file, str(whole)])
		print("[rs1-selftest] %s -> record %d %s" % [file, first_bad, first_code])


## Deep equality after JSON parsing: any two numbers compare as floats.
func _deep_equal(a: Variant, b: Variant, path: String, diffs: Array[String]) -> void:
	var ta: int = typeof(a)
	var tb: int = typeof(b)
	var a_number: bool = ta == TYPE_INT or ta == TYPE_FLOAT
	var b_number: bool = tb == TYPE_INT or tb == TYPE_FLOAT
	if a_number and b_number:
		var fa: float = a
		var fb: float = b
		if fa != fb:
			diffs.append("%s: %s != %s" % [path, str(fa), str(fb)])
		return
	if ta != tb:
		diffs.append("%s: type %s != %s" % [path, type_string(ta), type_string(tb)])
		return
	if ta == TYPE_DICTIONARY:
		var da: Dictionary = a
		var db: Dictionary = b
		for key: Variant in da:
			if not db.has(key):
				diffs.append("%s: unexpected key %s" % [path, str(key)])
			else:
				_deep_equal(da[key], db[key], "%s.%s" % [path, str(key)], diffs)
		for key: Variant in db:
			if not da.has(key):
				diffs.append("%s: missing key %s" % [path, str(key)])
		return
	if ta == TYPE_ARRAY:
		var la: Array = a
		var lb: Array = b
		if la.size() != lb.size():
			diffs.append("%s: length %d != %d" % [path, la.size(), lb.size()])
			return
		for i: int in la.size():
			_deep_equal(la[i], lb[i], "%s[%d]" % [path, i], diffs)
		return
	if a != b:
		diffs.append("%s: %s != %s" % [path, str(a), str(b)])
