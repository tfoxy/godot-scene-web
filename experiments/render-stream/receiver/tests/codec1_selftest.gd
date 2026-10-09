extends SceneTree
## Rs1Decoder self-test against the shared golden vectors (protocol/golden-1/).
##
##   godot --headless --path receiver --script res://tests/codec1_selftest.gd
##
## RS_SELFTEST_GOLDEN_DIR overrides the golden directory (default <receiver>/../protocol/golden-1).
## Prints "[rs1-selftest] ok" and quits 0, or prints each failure and quits 1.
##
## Three decoder properties, per gate1-design.md G1b1 "Pass criteria":
##   1. decodeRecording()-equivalent (split_records + decode_record) deep-equals *.decoded.json;
##   2. the Stream's resolved state after each transaction deep-equals resolved.json's
##      per-seq state (stream_id and per-transaction "encoding" excepted, same as self-test-rs1.ts);
##   3. every invalid/*.rs1 yields its index.json code, and validate_recording() of both valid
##      vectors is [].
## And the applier (RsApplier, G1b2), through the receiver's exact path (apply_record):
##   4. full.rs1 and patch.rs1, each through a fresh applier, produce identical per-seq stats
##      (rs_calls, created, freed, reparented, commands_replayed, unsupported commands): the
##      receiver's work does not depend on encoding. The first seq makes RS calls; every seq whose
##      resolved state equals the previous one in resolved.json (seq 4 must be one) makes none;
##      dispose() frees exactly the RIDs the applier still owned;
##   5. corrupt-meta.rs1's broken transaction is rejected with zero RS calls, after the earlier
##      records applied.

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
	# _initialize runs before the root window enters the tree (SceneTree::initialize calls
	# MainLoop::initialize, then root->_set_tree), so the root canvas is attached to the root
	# viewport only from the first frame on. The applier tests need that attachment.
	process_frame.connect(_run_applier_tests.bind(index, resolved), CONNECT_ONE_SHOT)


func _run_applier_tests(index: Dictionary, resolved: Dictionary) -> void:
	_test_applier_encodings(index, resolved)
	_test_applier_corrupt(index)
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


func _new_applier() -> RsApplier:
	return RsApplier.new(root.get_viewport_rid(), root.find_world_2d().canvas)


## Runs one recording through a fresh applier, record by record, as the receiver does. Returns
## one {kind, errors, rs_calls (that record's own), stats} per record. Disposes the applier and
## checks that dispose() freed exactly the RIDs it still owned.
func _apply_recording(file: String) -> Array[Dictionary]:
	var data: PackedByteArray = _read_bytes(file)
	var records: Array[Dictionary] = Rs1Decoder.split_records(data)["records"]
	var stream := Rs1Decoder.Stream.new()
	var applier: RsApplier = _new_applier()
	var out: Array[Dictionary] = []
	for raw: Dictionary in records:
		var before: int = applier.rs_calls
		var result: Dictionary = applier.apply_record(data, Rs1Decoder.as_int(raw["offset"]), stream)
		out.append({
			"kind": result["kind"],
			"errors": result["errors"],
			"rs_calls": applier.rs_calls - before,
			"stats": result["stats"],
		})
	var owned: int = applier.owned_rids()
	var freed: int = applier.dispose()
	_check(freed == owned and applier.disposed_frees == owned and applier.owned_rids() == 0, "%s: dispose() freed %d RIDs, the applier owned %d" % [file, freed, owned])
	return out


func _test_applier_encodings(index: Dictionary, resolved: Dictionary) -> void:
	var expected_transactions: Array = resolved["transactions"]
	var files: Array[String] = []
	var per_file: Array[Array] = []
	var valid: Array = index["valid"]
	for value: Variant in valid:
		var vector: Dictionary = value
		var file: String = vector["file"]
		var results: Array[Dictionary] = _apply_recording(file)
		# One row per transaction: [rs_calls, created, freed, reparented, commands_replayed,
		# unsupported_commands as text].
		var rows: Array = []
		for i: int in results.size():
			var result: Dictionary = results[i]
			var errors: PackedStringArray = result["errors"]
			var calls: int = result["rs_calls"]
			_check(errors.is_empty(), "%s record %d: applier errors %s" % [file, i, str(errors)])
			match result["kind"]:
				"session":
					_check(calls == 3, "%s: the session made %d RS calls, expected 3" % [file, calls])
				"transaction":
					var stats: Dictionary = result["stats"]
					_check(stats["rs_calls"] == calls, "%s record %d: stats.rs_calls disagrees with the applier's counter" % [file, i])
					rows.append([calls, stats["created"], stats["freed"], stats["reparented"], stats["commands_replayed"], str(stats["unsupported_commands"])])
				"end":
					_check(calls == 0, "%s: the end record made %d RS calls" % [file, calls])
		_check(rows.size() == expected_transactions.size(), "%s: applied %d transactions, resolved.json has %d" % [file, rows.size(), expected_transactions.size()])
		files.append(file)
		per_file.append(rows)
		var per_seq: Array[int] = []
		for row: Array in rows:
			per_seq.append(row[0])
		print("[rs1-selftest] applier %s rs_calls per seq %s" % [file, str(per_seq)])

	_check(files.size() == 2, "index.json lists %d valid vectors, expected 2" % files.size())
	if files.size() != 2:
		return
	var a: Array = per_file[0]
	var b: Array = per_file[1]
	_check(str(a) == str(b), "per-seq applier stats differ: %s %s vs %s %s" % [files[0], str(a), files[1], str(b)])
	if a.is_empty():
		return
	var first: Array = a[0]
	_check(first[0] > 0, "seq 1 made no RS calls")

	# Against the golden's actual content: a seq whose resolved state equals the previous seq's
	# must cost nothing, and seq 4 is documented (render-stream-1.md "Golden vectors") as one.
	var unchanged: Array[int] = []
	for i: int in range(1, mini(a.size(), expected_transactions.size())):
		var previous: Dictionary = expected_transactions[i - 1]
		var current: Dictionary = expected_transactions[i]
		var diffs: Array[String] = []
		_deep_equal(current["state"], previous["state"], "$", diffs)
		if diffs.is_empty():
			unchanged.append(i + 1)
			var row: Array = a[i]
			_check(row[0] == 0, "seq %d's resolved state equals seq %d's, yet it made %s RS calls" % [i + 1, i, str(row[0])])
	_check(unchanged.has(4), "resolved.json seq 4 should equal seq 3; the unchanged seqs are %s" % str(unchanged))
	print("[rs1-selftest] applier stats identical across encodings; unchanged seqs %s cost 0 RS calls" % str(unchanged))


## The corrupt transaction must cost zero RS calls: everything is decoded, validated and resolved
## before the applier touches the RenderingServer.
func _test_applier_corrupt(index: Dictionary) -> void:
	var corrupt: Array = index["corrupt"]
	for value: Variant in corrupt:
		var vector: Dictionary = value
		var file: String = vector["file"]
		var record_index: int = Rs1Decoder.as_int(vector["record_index"])
		var results: Array[Dictionary] = _apply_recording(file)
		_check(results.size() > record_index, "%s has only %d records" % [file, results.size()])
		for i: int in mini(record_index + 1, results.size()):
			var result: Dictionary = results[i]
			var errors: PackedStringArray = result["errors"]
			var calls: int = result["rs_calls"]
			if i < record_index:
				_check(errors.is_empty() and calls > 0, "%s record %d should apply (errors %s, %d RS calls)" % [file, i, str(errors), calls])
			else:
				_check(errors.size() > 0 and Rs1Decoder.code_of(errors[0]) == vector["code"], "%s record %d should fail with %s, got %s" % [file, i, vector["code"], str(errors)])
				_check(calls == 0, "%s record %d made %d RS calls, expected 0" % [file, i, calls])
				print("[rs1-selftest] applier %s record %d: %s, rs_calls %d" % [file, i, Rs1Decoder.code_of(errors[0]) if errors.size() > 0 else "(none)", calls])


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
