extends SceneTree
## Rs0Decoder / Rs0Applier self-test against the shared golden vectors (protocol/golden/).
##
##   godot --headless --path receiver --script res://tests/codec_selftest.gd
##
## RS_SELFTEST_GOLDEN_DIR overrides the golden directory (default <receiver>/../protocol/golden).
## Prints "[rs0-selftest] ok" and quits 0, or prints each failure and quits 1.

var _failures: Array[String] = []
var _golden: String = ""


func _initialize() -> void:
	_golden = OS.get_environment("RS_SELFTEST_GOLDEN_DIR")
	if _golden == "":
		_golden = ProjectSettings.globalize_path("res://").path_join("../protocol/golden").simplify_path()
	print("[rs0-selftest] golden %s" % _golden)
	var index: Dictionary = _read_json("index.json")
	if index.is_empty():
		_finish()
		return
	_test_minimal(index)
	_test_invalid(index)
	_test_corrupt(index)
	# _initialize runs before the root window enters the tree (SceneTree::initialize calls
	# MainLoop::initialize, then root->_set_tree), so the root canvas is attached to the root
	# viewport only from the first frame on. The applier tests need that attachment.
	process_frame.connect(_run_applier_tests.bind(index), CONNECT_ONE_SHOT)


func _run_applier_tests(index: Dictionary) -> void:
	_test_applier_minimal()
	_test_applier_corrupt(index)
	_finish()


func _finish() -> void:
	if _failures.is_empty():
		print("[rs0-selftest] ok")
		quit(0)
	else:
		for failure: String in _failures:
			print("[rs0-selftest] FAIL: " + failure)
		print("[rs0-selftest] %d failure(s)" % _failures.size())
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


## decodeRecording() in GDScript: the golden decoded form, built from Rs0Decoder's own API.
func _decode_recording(data: PackedByteArray) -> Dictionary:
	var split: Dictionary = Rs0Decoder.split_records(data)
	var records: Array[Dictionary] = split["records"]
	var split_errors: PackedStringArray = split["errors"]
	_check(split_errors.is_empty(), "split_records errors: %s" % str(split_errors))
	var decoded: Array = []
	for raw: Dictionary in records:
		var record: Dictionary = Rs0Decoder.decode_record(data, Rs0Decoder.as_int(raw["offset"]))
		var errors: PackedStringArray = record["errors"]
		_check(errors.is_empty(), "decode_record at %d errors: %s" % [Rs0Decoder.as_int(raw["offset"]), str(errors)])
		_check(record["byte_length"] == raw["byte_length"], "byte_length disagrees between split_records and decode_record at %d" % Rs0Decoder.as_int(raw["offset"]))
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
		"schema": "render-stream-0-decoded/1",
		"magic": data.slice(0, 8).hex_encode(),
		"records": decoded,
	}


func _test_minimal(index: Dictionary) -> void:
	var valid: Array = index["valid"]
	for value: Variant in valid:
		var vector: Dictionary = value
		var file: String = vector["file"]
		var data: PackedByteArray = _read_bytes(file)
		_check(Rs0Decoder.sha256_hex(data) == vector["sha256"], "%s sha256 differs from index.json" % file)
		var errors: PackedStringArray = Rs0Decoder.validate_recording(data)
		_check(errors.is_empty(), "%s should validate, got %s" % [file, str(errors)])
		var decoded_file: String = vector["decoded"]
		var expected: Dictionary = _read_json(decoded_file)
		var actual: Dictionary = _decode_recording(data)
		var diffs: Array[String] = []
		_deep_equal(actual, expected, "$", diffs)
		for diff: String in diffs.slice(0, 20):
			_failures.append("%s decoded form: %s" % [file, diff])


func _test_invalid(index: Dictionary) -> void:
	var invalid: Array = index["invalid"]
	_check(invalid.size() == 6, "index.json lists %d invalid vectors, expected 6" % invalid.size())
	for value: Variant in invalid:
		var vector: Dictionary = value
		var file: String = vector["file"]
		var code: String = vector["code"]
		var errors: PackedStringArray = Rs0Decoder.validate_recording(_read_bytes(file))
		var found: bool = false
		for error: String in errors:
			if Rs0Decoder.code_of(error) == code:
				found = true
		_check(found, "%s should be rejected with %s, got %s" % [file, code, str(errors)])
		print("[rs0-selftest] %s -> %s" % [file, errors[0] if errors.size() > 0 else "(accepted)"])


func _test_corrupt(index: Dictionary) -> void:
	var corrupt: Array = index["corrupt"]
	for value: Variant in corrupt:
		var vector: Dictionary = value
		var file: String = vector["file"]
		var code: String = vector["code"]
		var record_index: int = Rs0Decoder.as_int(vector["record_index"])
		var data: PackedByteArray = _read_bytes(file)
		var split: Dictionary = Rs0Decoder.split_records(data)
		var split_errors: PackedStringArray = split["errors"]
		_check(split_errors.is_empty(), "%s: framing must be intact, got %s" % [file, str(split_errors)])
		var records: Array[Dictionary] = split["records"]
		var first_bad: int = -1
		var first_code: String = ""
		for i: int in records.size():
			var record: Dictionary = Rs0Decoder.decode_record(data, Rs0Decoder.as_int(records[i]["offset"]))
			var errors: PackedStringArray = record["errors"]
			if not errors.is_empty():
				first_bad = i
				first_code = Rs0Decoder.code_of(errors[0])
				break
		_check(first_bad == record_index and first_code == code, "%s: first bad record is %d (%s), expected %d (%s)" % [file, first_bad, first_code, record_index, code])
		var whole: PackedStringArray = Rs0Decoder.validate_recording(data)
		_check(whole.size() > 0 and Rs0Decoder.code_of(whole[0]) == code, "%s: validate_recording gave %s" % [file, str(whole)])
		print("[rs0-selftest] %s -> record %d %s" % [file, first_bad, first_code])


func _new_applier() -> Rs0Applier:
	return Rs0Applier.new(root.get_viewport_rid(), root.find_world_2d().canvas)


## Runs minimal.bin through the receiver's exact path (Rs0Applier.apply_record). Expected RS call
## counts per transaction, worked out by hand from gate0-design.md Q5:
##   seq 1: 2 creates + 2 set_parent + 2 x 9 setters + 2 add_rect                  = 24
##   seq 2: 1 free + 1 create + 1 set_parent + 9 setters + 1 add_rect; item 1 untouched = 13
func _test_applier_minimal() -> void:
	var data: PackedByteArray = _read_bytes("minimal.bin")
	var records: Array[Dictionary] = Rs0Decoder.split_records(data)["records"]
	var stream := Rs0Decoder.Stream.new()
	var applier: Rs0Applier = _new_applier()
	var expected: Array[Dictionary] = [
		{"kind": "session", "rs_calls": 3},
		{"kind": "transaction", "created": 2, "freed": 0, "reparented": 2, "commands_replayed": 2, "rs_calls": 24, "unsupported": 1},
		{"kind": "transaction", "created": 1, "freed": 1, "reparented": 1, "commands_replayed": 1, "rs_calls": 13, "unsupported": 0},
		{"kind": "end", "rs_calls": 0},
	]
	_check(records.size() == expected.size(), "minimal.bin has %d records, expected %d" % [records.size(), expected.size()])
	for i: int in mini(records.size(), expected.size()):
		var want: Dictionary = expected[i]
		var before: int = applier.rs_calls
		var result: Dictionary = applier.apply_record(data, Rs0Decoder.as_int(records[i]["offset"]), stream)
		var errors: PackedStringArray = result["errors"]
		_check(errors.is_empty(), "applier record %d errors: %s" % [i, str(errors)])
		_check(result["kind"] == want["kind"], "applier record %d kind %s, expected %s" % [i, result["kind"], want["kind"]])
		var calls: int = applier.rs_calls - before
		_check(calls == want["rs_calls"], "applier record %d made %d RS calls, expected %d" % [i, calls, want["rs_calls"]])
		if want["kind"] != "transaction":
			continue
		var stats: Dictionary = result["stats"]
		for key: String in ["created", "freed", "reparented", "commands_replayed", "rs_calls"]:
			_check(stats[key] == want[key], "applier record %d %s is %s, expected %s" % [i, key, str(stats[key]), str(want[key])])
		var unsupported: Array[Dictionary] = stats["unsupported_commands"]
		_check(unsupported.size() == want["unsupported"], "applier record %d logged %d unsupported commands, expected %d" % [i, unsupported.size(), want["unsupported"]])
		if unsupported.size() == 1:
			_check(unsupported[0]["item"] == 2 and unsupported[0]["name"] == "canvas_item_add_circle", "unexpected unsupported command %s" % str(unsupported[0]))
	_check(stream.end_seen, "the applier's stream did not see the end record")
	applier.dispose()


## The corrupt transaction must cost zero RS calls: everything is decoded and validated first.
func _test_applier_corrupt(index: Dictionary) -> void:
	var corrupt: Array = index["corrupt"]
	for value: Variant in corrupt:
		var vector: Dictionary = value
		var file: String = vector["file"]
		var record_index: int = Rs0Decoder.as_int(vector["record_index"])
		var data: PackedByteArray = _read_bytes(file)
		var records: Array[Dictionary] = Rs0Decoder.split_records(data)["records"]
		var stream := Rs0Decoder.Stream.new()
		var applier: Rs0Applier = _new_applier()
		for i: int in record_index + 1:
			var before: int = applier.rs_calls
			var result: Dictionary = applier.apply_record(data, Rs0Decoder.as_int(records[i]["offset"]), stream)
			var errors: PackedStringArray = result["errors"]
			var calls: int = applier.rs_calls - before
			if i < record_index:
				_check(errors.is_empty() and calls > 0, "%s record %d should apply (errors %s, %d RS calls)" % [file, i, str(errors), calls])
			else:
				_check(errors.size() > 0 and Rs0Decoder.code_of(errors[0]) == vector["code"], "%s record %d should fail with %s, got %s" % [file, i, vector["code"], str(errors)])
				_check(calls == 0, "%s record %d made %d RS calls, expected 0" % [file, i, calls])
				print("[rs0-selftest] %s record %d: %s, rs_calls 0" % [file, i, Rs0Decoder.code_of(errors[0]) if errors.size() > 0 else "(none)"])
		applier.dispose()


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
