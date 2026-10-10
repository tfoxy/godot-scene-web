extends SceneTree
## Rs2Decoder / RsTexturePayload / RsMeshPayload self-test against the shared golden vectors
## (protocol/golden-2/, protocol/golden-3/ G4e1, protocol/golden-4/ G5w).
##
##   godot --headless --path receiver --script res://tests/codec2_selftest.gd
##
## RS_SELFTEST_GOLDEN_DIR overrides the golden-2 directory (default
## <receiver>/../protocol/golden-2); golden-3 and golden-4 are always read from their siblings,
## <receiver>/../protocol/golden-3 and golden-4 (not independently overridable -- this self-test
## is the one for ALL THREE directories, per gate4-design.md G4e1: "Renaming files is not part of
## this contract", so separate codec3_selftest.gd/codec4_selftest.gd were not added). Prints
## "[rs2-selftest] ok" and quits 0, or prints each failure and quits 1.
##
## Pure-codec properties only (gate2-design.md G2b1 "Pass criteria", gate4-design.md G4e1's and
## render-stream-4.md G5w's -- the applier, RsApplier, does not speak /4 until G5d):
##   1. decode_record()-equivalent (split_records + decode_record) deep-equals *.decoded.json for
##      full/patch/inline.rs2, .rs3 and .rs4;
##   2. the Stream's resolved state after each transaction deep-equals resolved.json's per-seq
##      state (session_id/stream_id/encoding excepted, as self-test-rs2.ts), for all three streams
##      in each golden directory;
##   3. every invalid/*.rs2/.rs3/.rs4 yields its index.json code, and validate_recording() of all
##      three valid vectors in each directory is [];
##   4. corrupt-meta.rs2/.rs3/.rs4's broken transaction is rejected with "meta-json";
##   5. every payload-invalid/*.grt (golden-2 only: /3 does not change the payload format) yields
##      its code from RsTexturePayload.decode(); every payload-invalid/*.grm (golden-4 only)
##      yields its code from RsMeshPayload.decode();
##   6. every payloads/*.grt hashes to its listed name, decodes to its listed shape, and an Image
##      rebuilt from it (RsTexturePayload.make_image()) has get_data() equal to the payload's data
##      bytes; every golden-4 mesh_payloads/*.grm likewise against RsMeshPayload.decode().

var _failures: Array[String] = []
var _golden: String = ""


func _initialize() -> void:
	_golden = OS.get_environment("RS_SELFTEST_GOLDEN_DIR")
	if _golden == "":
		_golden = ProjectSettings.globalize_path("res://").path_join("../protocol/golden-2").simplify_path()
	var golden3: String = ProjectSettings.globalize_path("res://").path_join("../protocol/golden-3").simplify_path()
	var golden4: String = ProjectSettings.globalize_path("res://").path_join("../protocol/golden-4").simplify_path()
	_run_suite(_golden, 2)
	_run_suite(golden3, 3)
	_run_suite(golden4, 4)
	_finish()


func _run_suite(golden_dir: String, version: int) -> void:
	_golden = golden_dir
	print("[rs2-selftest] golden %s (version %d)" % [_golden, version])
	var index: Dictionary = _read_json("index.json")
	if index.is_empty():
		return
	var resolved_file: String = index["resolved"]
	var resolved: Dictionary = _read_json(resolved_file)
	_test_valid(index, resolved, version)
	_test_invalid(index, version)
	_test_corrupt(index, version)
	_test_payload_invalid(index, version)
	_test_payloads(index, version)
	_test_mesh_payloads(index, version)


func _finish() -> void:
	if _failures.is_empty():
		print("[rs2-selftest] ok")
		quit(0)
	else:
		for failure: String in _failures:
			print("[rs2-selftest] FAIL: " + failure)
		print("[rs2-selftest] %d failure(s)" % _failures.size())
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


## decodeRecording() in GDScript: the golden decoded form, built from Rs2Decoder's own API. A u8
## block decodes to {"u8_bytes","sha256"} (unchanged shape from decode_record()); an f32 block to
## a plain float Array.
func _decode_recording(data: PackedByteArray, version: int) -> Dictionary:
	var split: Dictionary = Rs2Decoder.split_records(data, version)
	var records: Array[Dictionary] = split["records"]
	var split_errors: PackedStringArray = split["errors"]
	_check(split_errors.is_empty(), "split_records errors: %s" % str(split_errors))
	var decoded: Array = []
	for raw: Dictionary in records:
		var record: Dictionary = Rs2Decoder.decode_record(data, Rs2Decoder.as_int(raw["offset"]), version)
		var errors: PackedStringArray = record["errors"]
		_check(errors.is_empty(), "decode_record at %d errors: %s" % [Rs2Decoder.as_int(raw["offset"]), str(errors)])
		_check(record["byte_length"] == raw["byte_length"], "byte_length disagrees between split_records and decode_record at %d" % Rs2Decoder.as_int(raw["offset"]))
		var blocks: Array = record["blocks"]
		var block_lists: Array = []
		for block: Variant in blocks:
			if block is PackedFloat32Array:
				var float_block: PackedFloat32Array = block
				var floats: Array = []
				for value: float in float_block:
					floats.append(value)
				block_lists.append(floats)
			elif block is PackedInt32Array:
				var int_block: PackedInt32Array = block
				var ints: Array = []
				for value: int in int_block:
					ints.append(value)
				block_lists.append(ints)
			else:
				block_lists.append(block)
		decoded.append({
			"offset": record["offset"],
			"byte_length": record["byte_length"],
			"sha256": record["sha256"],
			"meta": record["meta"],
			"blocks": block_lists,
		})
	var schema: String = "render-stream-2-decoded/1"
	if version == 3:
		schema = "render-stream-3-decoded/1"
	elif version == 4:
		schema = "render-stream-4-decoded/1"
	return {
		"schema": schema,
		"magic": data.slice(0, 8).hex_encode(),
		"records": decoded,
	}


## The "state" shape resolved.json carries per transaction, read off a Stream right after it
## accepted that transaction's record.
func _snapshot_state(stream: Rs2Decoder.Stream, meta: Dictionary) -> Dictionary:
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
	var texture_ids: Array[int] = []
	for id: int in stream.textures:
		texture_ids.append(id)
	texture_ids.sort()
	var textures_out: Array = []
	for id: int in texture_ids:
		textures_out.append(stream.textures[id])
	var out: Dictionary = {
		"status": meta["status"],
		"failures": meta["failures"],
		"unsupported": meta["unsupported"],
		"default_texture_filter": stream.default_texture_filter,
		"default_texture_repeat": stream.default_texture_repeat,
		"canvases": canvases_out,
		"items": items_out,
		"textures": textures_out,
	}
	if stream.version == 4:
		var mesh_ids: Array[int] = []
		for id: int in stream.meshes:
			mesh_ids.append(id)
		mesh_ids.sort()
		var meshes_out: Array = []
		for id: int in mesh_ids:
			meshes_out.append(stream.meshes[id])
		out["meshes"] = meshes_out
	return out


func _test_valid(index: Dictionary, resolved: Dictionary, version: int) -> void:
	var valid: Array = index["valid"]
	for value: Variant in valid:
		var vector: Dictionary = value
		var file: String = vector["file"]
		var data: PackedByteArray = _read_bytes(file)
		_check(Rs2Decoder.sha256_hex(data) == vector["sha256"], "%s sha256 differs from index.json" % file)

		var decoded_file: String = vector["decoded"]
		var expected_decoded: Dictionary = _read_json(decoded_file)
		var actual_decoded: Dictionary = _decode_recording(data, version)
		var diffs: Array[String] = []
		_deep_equal(actual_decoded, expected_decoded, "$", diffs)
		for diff: String in diffs.slice(0, 20):
			_failures.append("%s decoded form: %s" % [file, diff])

		var split: Dictionary = Rs2Decoder.split_records(data, version)
		var records: Array[Dictionary] = split["records"]
		var stream := Rs2Decoder.Stream.new(version)
		var expected_transactions: Array = resolved["transactions"]
		var resolved_index: int = 0
		for i: int in records.size():
			var raw: Dictionary = records[i]
			var record: Dictionary = Rs2Decoder.decode_record(data, Rs2Decoder.as_int(raw["offset"]), version)
			var record_errors: PackedStringArray = record["errors"]
			_check(record_errors.is_empty(), "%s record %d decode errors: %s" % [file, i, str(record_errors)])
			var accept_errors: PackedStringArray = stream.accept(data, record)
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

		# resources: resolveRecording()'s separate ground truth (never shared across streams).
		var resource_list: Array = []
		for i: int in records.size():
			var raw: Dictionary = records[i]
			var record: Dictionary = Rs2Decoder.decode_record(data, Rs2Decoder.as_int(raw["offset"]), version)
			var meta: Dictionary = record["meta"]
			if meta.get("type") == "resource":
				resource_list.append({"hash": meta["hash"], "bytes": meta["bytes"], "record_index": i})
		var inline_resources: Array = index["inline_resources"]
		var expected_resources: Array = inline_resources if file.begins_with("inline.") else []
		var resource_diffs: Array[String] = []
		_deep_equal(resource_list, expected_resources, "$", resource_diffs)
		for diff: String in resource_diffs:
			_failures.append("%s resources: %s" % [file, diff])

		var errors: PackedStringArray = Rs2Decoder.validate_recording(data, version)
		_check(errors.is_empty(), "%s should validate, got %s" % [file, str(errors)])


func _test_invalid(index: Dictionary, version: int) -> void:
	var invalid: Array = index["invalid"]
	# golden-2 has 12 invalid vectors (its full /2 rule set); golden-3 has exactly the 5 new
	# failure modes /3 adds; golden-4 has the 11 new failure modes /4 adds (each contract: every
	# rule left unchanged is already covered by an earlier golden directory's own vectors, and is
	# not re-derived there).
	var expected_count: int = 12
	if version == 3:
		expected_count = 5
	elif version == 4:
		expected_count = 11
	_check(invalid.size() == expected_count, "index.json lists %d invalid vectors, expected %d" % [invalid.size(), expected_count])
	for value: Variant in invalid:
		var vector: Dictionary = value
		var file: String = vector["file"]
		var code: String = vector["code"]
		var errors: PackedStringArray = Rs2Decoder.validate_recording(_read_bytes(file), version)
		var found: bool = false
		for error: String in errors:
			if Rs2Decoder.code_of(error) == code:
				found = true
		_check(found, "%s should be rejected with %s, got %s" % [file, code, str(errors)])
		print("[rs2-selftest] %s -> %s" % [file, errors[0] if errors.size() > 0 else "(accepted)"])


func _test_corrupt(index: Dictionary, version: int) -> void:
	var corrupt: Array = index["corrupt"]
	for value: Variant in corrupt:
		var vector: Dictionary = value
		var file: String = vector["file"]
		var code: String = vector["code"]
		var record_index: int = Rs2Decoder.as_int(vector["record_index"])
		var data: PackedByteArray = _read_bytes(file)
		var split: Dictionary = Rs2Decoder.split_records(data, version)
		var split_errors: PackedStringArray = split["errors"]
		_check(split_errors.is_empty(), "%s: framing must be intact, got %s" % [file, str(split_errors)])
		var records: Array[Dictionary] = split["records"]
		var first_bad: int = -1
		var first_code: String = ""
		for i: int in records.size():
			var record: Dictionary = Rs2Decoder.decode_record(data, Rs2Decoder.as_int(records[i]["offset"]), version)
			var errors: PackedStringArray = record["errors"]
			if not errors.is_empty():
				first_bad = i
				first_code = Rs2Decoder.code_of(errors[0])
				break
		_check(first_bad == record_index and first_code == code, "%s: first bad record is %d (%s), expected %d (%s)" % [file, first_bad, first_code, record_index, code])
		var whole: PackedStringArray = Rs2Decoder.validate_recording(data, version)
		_check(whole.size() > 0 and Rs2Decoder.code_of(whole[0]) == code, "%s: validate_recording gave %s" % [file, str(whole)])
		print("[rs2-selftest] %s -> record %d %s" % [file, first_bad, first_code])


func _test_payload_invalid(index: Dictionary, version: int) -> void:
	# golden-3 carries no "payload_invalid" key: render-stream-3.md does not change the
	# render-stream-texture/1 payload format, so golden-2's vectors are the only ones that exist.
	# golden-4's are GRM1 (render-stream-mesh/1), decoded with RsMeshPayload instead.
	if not index.has("payload_invalid"):
		return
	var payload_invalid: Array = index["payload_invalid"]
	_check(payload_invalid.size() == 4, "index.json lists %d payload-invalid vectors, expected 4" % payload_invalid.size())
	for value: Variant in payload_invalid:
		var vector: Dictionary = value
		var file: String = vector["file"]
		var code: String = vector["code"]
		var data: PackedByteArray = _read_bytes(file)
		var decoded: Dictionary = RsMeshPayload.decode(data) if version == 4 else RsTexturePayload.decode(data)
		_check(not decoded["ok"] and decoded["code"] == code, "%s should decode with code %s, got %s" % [file, code, str(decoded)])
		print("[rs2-selftest] %s -> %s" % [file, decoded.get("code", "(ok)")])


func _test_payloads(index: Dictionary, version: int) -> void:
	var payloads: Array = index["payloads"]
	# golden-3 and golden-4 have one more payload than golden-2: the 512x512 "page" (state 7).
	var expected_count: int = 5 if (version == 3 or version == 4) else 4
	_check(payloads.size() == expected_count, "index.json lists %d payloads, expected %d" % [payloads.size(), expected_count])
	for value: Variant in payloads:
		var vector: Dictionary = value
		var file: String = vector["file"]
		var data: PackedByteArray = _read_bytes(file)
		_check(Rs2Decoder.sha256_hex(data) == vector["hash"], "%s sha256 differs from index.json" % file)
		var decoded: Dictionary = RsTexturePayload.decode(data)
		_check(decoded["ok"], "%s should decode, got %s" % [file, str(decoded)])
		if not decoded["ok"]:
			continue
		_check(decoded["format"] == vector["format"], "%s format %s, expected %s" % [file, decoded["format"], vector["format"]])
		_check(decoded["width"] == Rs2Decoder.as_int(vector["width"]), "%s width %d, expected %d" % [file, decoded["width"], Rs2Decoder.as_int(vector["width"])])
		_check(decoded["height"] == Rs2Decoder.as_int(vector["height"]), "%s height %d, expected %d" % [file, decoded["height"], Rs2Decoder.as_int(vector["height"])])
		_check(decoded["mipmaps"] == vector["mipmaps"], "%s mipmaps %s, expected %s" % [file, decoded["mipmaps"], vector["mipmaps"]])
		_check(data.size() == Rs2Decoder.as_int(vector["bytes"]), "%s total bytes %d, expected %d" % [file, data.size(), Rs2Decoder.as_int(vector["bytes"])])
		var image: Image = RsTexturePayload.make_image(decoded)
		_check(image != null, "%s: make_image() returned null" % file)
		if image != null:
			var image_data: PackedByteArray = image.get_data()
			var payload_data: PackedByteArray = decoded["data"]
			_check(image_data == payload_data, "%s: Image.get_data() (size %d) differs from the payload's data bytes (size %d)" % [file, image_data.size(), payload_data.size()])


## golden-4 only (render-stream-4.md "Mesh payload"): every mesh_payloads/*.grm hashes to its
## listed name and decodes to its listed shape via RsMeshPayload.
func _test_mesh_payloads(index: Dictionary, version: int) -> void:
	if not index.has("mesh_payloads"):
		return
	var mesh_payloads: Array = index["mesh_payloads"]
	_check(mesh_payloads.size() == 4, "index.json lists %d mesh_payloads, expected 4" % mesh_payloads.size())
	for value: Variant in mesh_payloads:
		var vector: Dictionary = value
		var file: String = vector["file"]
		var data: PackedByteArray = _read_bytes(file)
		_check(Rs2Decoder.sha256_hex(data) == vector["hash"], "%s sha256 differs from index.json" % file)
		var decoded: Dictionary = RsMeshPayload.decode(data)
		_check(decoded["ok"], "%s should decode, got %s" % [file, str(decoded)])
		if not decoded["ok"]:
			continue
		_check(decoded["primitive"] == vector["primitive"], "%s primitive %s, expected %s" % [file, decoded["primitive"], vector["primitive"]])
		_check(decoded["format"] == Rs2Decoder.as_int(vector["format"]), "%s format %d, expected %d" % [file, decoded["format"], Rs2Decoder.as_int(vector["format"])])
		_check(decoded["vertex_count"] == Rs2Decoder.as_int(vector["vertex_count"]), "%s vertex_count %d, expected %d" % [file, decoded["vertex_count"], Rs2Decoder.as_int(vector["vertex_count"])])
		_check(decoded["index_count"] == Rs2Decoder.as_int(vector["index_count"]), "%s index_count %d, expected %d" % [file, decoded["index_count"], Rs2Decoder.as_int(vector["index_count"])])
		_check(data.size() == Rs2Decoder.as_int(vector["bytes"]), "%s total bytes %d, expected %d" % [file, data.size(), Rs2Decoder.as_int(vector["bytes"])])


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
