extends SceneTree
## The receiver's own self-test since G7gd (gate 0's and gate 1's receiver-typecheck runs it under
## the mise editor, a debug build, so GDScript warnings are live):
##
##   godot --headless --path receiver --script res://tests/receiver_selftest.gd
##
##   1. every glue script at res:// loads and compiles (a parse error or a typed-GDScript warning,
##      which project.godot levels as an error, fails the load and prints a script diagnostic the
##      checker also greps for);
##   2. RsWire.split_records() frames every valid golden recording exactly as its *.decoded.json
##      lists the records (offset, byte_length), for golden-2 to golden-19 (PM5 adds golden-11's
##      GRSB and golden-12's GRSC);
##   3. every golden invalid/ vector whose index.json code is a framing code (bad-magic, truncated,
##      record-length) fails framing with that code;
##   4. (G8kz) RsResourceFetcher decodes a zstd and a gzip Content-Encoding body (frames made by
##      the zstd CLI and gzip, the same format the host's vendored zstd/zlib write) to the exact
##      identity bytes, and refuses a corrupted, content-size-less or unasked-for coding with
##      resource-invalid.
##   5. (P3-HX) RsRowLog keeps evidence rows as bytes (equal rows, keys in order) and writes the
##      report exactly as `JSON.stringify(report, "  ", false) + "\n"` would, rows streamed.
##   6. (P3-SP) RsResourceCache's memory budget: a running byte total and least-recently-used
##      eviction that never drops a needed hash, a re-touched hash moving to the back.
##
## Decoding, validation and resolution of the golden vectors are the Rust core's (rs-core's cargo
## tests) and the TypeScript checker decoder's (scripts/test/self-test-rs*.ts); G7gd removed the
## GDScript codec self-test (codec2_selftest.gd) with the GDScript decoder.
##
## RS_SELFTEST_GOLDEN_DIR names golden-2 (default <receiver>/../protocol/golden-2); golden-3 to
## golden-19 are its siblings. Prints "[receiver-selftest] ok" and quits 0, or prints each failure
## and quits 1.

const FRAMING_CODES: Array[String] = ["bad-magic", "truncated", "record-length"]

var _failures: Array[String] = []
var _checked: int = 0


func _init() -> void:
	_run_checks.call_deferred()


func _run_checks() -> void:
	_check_scripts()
	_check_fetcher_coding()
	_check_resource_base()
	_check_tapped()
	_check_folded_full()
	_check_row_log()
	_check_cache_budget()
	_check_native_queries()
	_check_digest_policies()
	_check_protocol_helpers()
	_check_json_descriptor()
	_check_view_tapped()
	_check_view_tap_presentation()
	_check_live_hello_versions()
	var golden2: String = OS.get_environment("RS_SELFTEST_GOLDEN_DIR").strip_edges()
	if golden2 == "":
		golden2 = ProjectSettings.globalize_path("res://").path_join("../protocol/golden-2").simplify_path()
	var root: String = golden2.get_base_dir()
	for version: int in [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19]:
		var dir: String = golden2 if version == 2 else root.path_join("golden-%d" % version)
		_check_golden(dir, version)
	if _failures.is_empty():
		print("[receiver-selftest] ok (%d checks)" % _checked)
		quit(0)
		return
	for failure: String in _failures:
		print("[receiver-selftest] FAIL %s" % failure)
	quit(1)


func _fail(text: String) -> void:
	_failures.append(text)


const CODING_ZSTD_HEX: String = "28b52ffd64010a050100c0475254312d697368207061796c6f616420000102030405060100984b7e19031d82c33f"
const CODING_ZSTD_NO_SIZE_HEX: String = "28b52ffd0458050100c0475254312d697368207061796c6f616420000102030405060100984b7e19031d82c33f"
const CODING_GZIP_HEX: String = "1f8b0800000000000003730f0a31d4cd2cce502848acccc94f4c51606064626661651ba546a9516a941aa546a9516a941aa546a9614901001f7a420a010b0000"


## The identity bytes the three fixture bodies above decode to.
func _coding_plain() -> PackedByteArray:
	var plain: PackedByteArray = "GRT1-ish payload ".to_utf8_buffer()
	for _i: int in 400:
		plain.append_array(PackedByteArray([0, 1, 2, 3, 4, 5, 6]))
	return plain


func _coded_current(coding: String, body: PackedByteArray) -> Dictionary:
	return {
		"hash": "ab", "status": 200, "bytes": body.size(), "data": body, "start_us": 0, "end_us": 0,
		"delay_us": 0, "headers": {"Content-Encoding": coding}, "error": "", "wire_bytes": body.size(),
		"content_encoding": "identity", "decode_us": 0,
	}


func _check_fetcher_coding() -> void:
	var plain: PackedByteArray = _coding_plain()
	var zstd_body: PackedByteArray = CODING_ZSTD_HEX.hex_decode()
	var gzip_body: PackedByteArray = CODING_GZIP_HEX.hex_decode()
	_checked += 1
	if RsResourceFetcher.zstd_content_size(zstd_body) != plain.size():
		_fail("zstd_content_size of the CLI frame is %d, not %d" % [RsResourceFetcher.zstd_content_size(zstd_body), plain.size()])
	if RsResourceFetcher.zstd_content_size(CODING_ZSTD_NO_SIZE_HEX.hex_decode()) != -1:
		_fail("a frame without a content size must report -1")
	if RsResourceFetcher.zstd_content_size(PackedByteArray([1, 2, 3, 4, 5, 6])) != -1:
		_fail("a non-zstd body must report -1")
	var cases: Array[Array] = [
		# [name, coding, body, accept, expect_ok]
		["zstd", "zstd", zstd_body, "zstd, gzip", true],
		["gzip", "gzip", gzip_body, "zstd, gzip", true],
		["zstd upper case", "ZSTD", zstd_body, "zstd", true],
		["identity named", "identity", plain, "zstd, gzip", true],
		["zstd not asked for", "zstd", zstd_body, "gzip", false],
		["gzip not asked for", "gzip", gzip_body, "zstd", false],
		["br is never asked for", "br", zstd_body, "zstd, gzip", false],
		["zstd frame without a content size", "zstd", CODING_ZSTD_NO_SIZE_HEX.hex_decode(), "zstd", false],
		["zstd body that is gzip", "zstd", gzip_body, "zstd", false],
		["gzip body that is zstd", "gzip", zstd_body, "gzip", false],
	]
	for item: Array in cases:
		_checked += 1
		var fetcher := RsResourceFetcher.new("127.0.0.1", 1, "/resources/sha256/", 10000, 0)
		fetcher.accept_encoding = str(item[3])
		var case_body: PackedByteArray = item[2]
		var expect_ok: bool = item[4]
		fetcher._current = _coded_current(str(item[1]), case_body)
		var ok: bool = fetcher._decode_content_encoding()
		if ok != expect_ok:
			_fail("fetcher decode '%s': ok %s, expected %s" % [item[0], ok, expect_ok])
			continue
		if ok:
			var data: PackedByteArray = fetcher._current["data"]
			if data != plain or fetcher._current["bytes"] != plain.size():
				_fail("fetcher decode '%s': the decoded bytes are not the identity bytes" % item[0])
		elif not fetcher.error.begins_with("resource-invalid"):
			_fail("fetcher decode '%s': error '%s' is not resource-invalid" % [item[0], fetcher.error])
	# A flipped byte in the middle of a coded body: refused, or decoded to bytes that are not the identity.
	for corrupt_case: Array in [["zstd", zstd_body, "zstd"], ["gzip", gzip_body, "gzip"]]:
		_checked += 1
		var body: PackedByteArray = corrupt_case[1]
		body[body.size() / 2] ^= 0x5A
		var fetcher := RsResourceFetcher.new("127.0.0.1", 1, "/resources/sha256/", 10000, 0)
		fetcher._current = _coded_current(str(corrupt_case[0]), body)
		if fetcher._decode_content_encoding():
			var data: PackedByteArray = fetcher._current["data"]
			if data == plain:
				_fail("a corrupted %s body decoded to the identity bytes" % corrupt_case[0])


## G7rf: a fold holding the forced full and a later patch during a resync wait ends the wait.
func _check_folded_full() -> void:
	var script: GDScript = load("res://receiver.gd")
	var node: Node = script.new()
	node.set("_resync_step", 1)
	node.set("_awaiting_full", true)
	var before: Dictionary = {"seq": 6, "encoding": "patch"}
	var full: Dictionary = {"seq": 7, "encoding": "full"}
	var patch: Dictionary = {"seq": 8, "encoding": "patch"}
	var folded: Array[Dictionary] = [before, full]
	node.set("_coalesced", folded)
	node.call("_end_wait_on_folded_full", patch)
	_checked += 1
	if node.get("_awaiting_full") != false:
		_fail("a full folded with a later patch did not end the resync wait")
	var kept: Array = node.get("_coalesced")
	if kept.size() != 1 or kept[0]["seq"] != 7:
		_fail("the fold kept %s, expected only the full seq 7" % str(kept))
	if before.get("skipped", "") != "resync" or full.has("skipped"):
		_fail("only the entry before the folded full is refused")
	# No full in the fold: the wait stays.
	node.set("_awaiting_full", true)
	var only_patches: Array[Dictionary] = [{"seq": 9, "encoding": "patch"}]
	node.set("_coalesced", only_patches)
	node.call("_end_wait_on_folded_full", {"seq": 10, "encoding": "patch"})
	_checked += 1
	if node.get("_awaiting_full") != true:
		_fail("a fold with no full ended the resync wait")
	node.free()


func _row_log_rows(count: int) -> Array[Dictionary]:
	var rows: Array[Dictionary] = []
	for index: int in count:
		rows.append({
			"stream": 1, "seq": index, "hash": "ab%062d" % index, "source": "directory",
			"status": null, "bytes": 1 << 40 if index % 5 == 0 else index * 7, "start_us": 0.5 * index,
			"verified": index % 2 == 0, "kind": "mesh", "note": "café \"q\" \\ \n\t 世",
			"surfaces": [0, 1, index], "buffers": [], "nested": {"b": [{"x": 1}, []], "a": {}},
		})
	return rows


func _row_log_json(report: Dictionary) -> String:
	var path: String = "user://receiver_selftest_row_log.json"
	var file: FileAccess = FileAccess.open(path, FileAccess.WRITE)
	RsRowLog.write_report_json(file, report)
	file.close()
	return FileAccess.get_file_as_string(path)


func _check_row_log() -> void:
	var rows: Array[Dictionary] = _row_log_rows(300)
	var log: RsRowLog = RsRowLog.new()
	for row: Dictionary in rows:
		log.append(row)
	_checked += 1
	if log.size() != 300:
		_fail("the row log holds %d rows, expected 300" % log.size())
	for index: int in rows.size():
		if JSON.stringify(log.at(index), "  ", false) != JSON.stringify(rows[index], "  ", false) or log.at(index).keys() != rows[index].keys():
			_fail("row %d does not decode to the row appended" % index)
			break
	var cases: Dictionary = {
		"populated": {"schema": "x/7", "empty_arr": [], "empty_obj": {}, "none": null, "tx": rows.slice(0, 3),
			"fetches": rows, "uploads": [], "f": 1.25, "nested": {"a": [1, 2, {"b": "c"}]}},
		"null log": {"schema": "x", "fetches": null, "uploads": []},
		"one row": {"fetches": rows.slice(0, 1)},
		"empty": {},
	}
	for name: String in cases:
		var report: Dictionary = cases[name]
		var logged: Dictionary = report.duplicate()
		for key: String in ["fetches", "uploads"]:
			if logged.has(key) and logged[key] is Array:
				var made: RsRowLog = RsRowLog.new()
				var list: Array = logged[key]
				for value: Variant in list:
					var row: Dictionary = value
					made.append(row)
				logged[key] = made
		_checked += 1
		if _row_log_json(logged) != JSON.stringify(report, "  ", false) + "\n":
			_fail("the streamed report differs from JSON.stringify's (%s)" % name)


## P3-SP: the memory budget's running total and LRU order (no sum or sort per add).
func _check_cache_budget() -> void:
	var cache: RsResourceCache = RsResourceCache.new()
	cache.memory_budget_bytes = 300
	var payload: PackedByteArray = PackedByteArray()
	payload.resize(100)
	for name: String in ["a", "b", "c"]:
		cache.add_inline(name, payload)
	_checked += 1
	if cache.memory_bytes() != 300 or cache.memory_entries() != 3:
		_fail("three 100-byte payloads hold %d bytes in %d entries" % [cache.memory_bytes(), cache.memory_entries()])
	cache.obtain("a")  # a is now the most recently used
	cache.set_needed(["b"])
	cache.add_inline("d", payload)  # over budget: the oldest that is not needed (c) goes
	_checked += 1
	if cache.has_in_memory("c") or not cache.has_in_memory("a") or not cache.has_in_memory("b"):
		_fail("eviction dropped %s, expected only c" % str(["a", "b", "c"].filter(func(h: String) -> bool: return not cache.has_in_memory(h))))
	_checked += 1
	if cache.memory_bytes() != 300 or cache.evictions_memory != 1:
		_fail("after one eviction: %d bytes, %d evictions" % [cache.memory_bytes(), cache.evictions_memory])
	cache.add_inline("a", payload)  # a replaced in place: the total does not double count it
	_checked += 1
	if cache.memory_bytes() != 300:
		_fail("re-adding a held hash counts %d bytes" % cache.memory_bytes())
	cache.clear_memory()
	_checked += 1
	if cache.memory_bytes() != 0 or cache.memory_entries() != 0:
		_fail("clear_memory leaves %d bytes" % cache.memory_bytes())


func _check_scripts() -> void:
	for file_name: String in DirAccess.get_files_at("res://"):
		if file_name.get_extension() != "gd":
			continue
		_checked += 1
		var script: Script = load("res://" + file_name)
		if script == null or not script.can_instantiate():
			_fail("res://%s does not load and compile" % file_name)


func _check_golden(dir: String, version: int) -> void:
	if version >= 16:
		_check_recent_goldens(dir, version)
		return
	if not DirAccess.dir_exists_absolute(dir):
		_fail("%s does not exist" % dir)
		return
	var framed: int = 0
	for file_name: String in DirAccess.get_files_at(dir):
		if not file_name.ends_with(".decoded.json"):
			continue
		var recording: String = dir.path_join(file_name.trim_suffix(".decoded.json") + ".rs%d" % version)
		var parsed: Variant = JSON.parse_string(FileAccess.get_file_as_string(dir.path_join(file_name)))
		if not (parsed is Dictionary) or not FileAccess.file_exists(recording):
			_fail("%s: unreadable, or %s is missing" % [file_name, recording])
			continue
		var decoded: Dictionary = parsed
		var expected: Array = decoded["records"]
		var data: PackedByteArray = FileAccess.get_file_as_bytes(recording)
		var split: Dictionary = RsWire.split_records(data, version)
		var errors: PackedStringArray = split["errors"]
		var records: Array[Dictionary] = split["records"]
		_checked += 1
		framed += 1
		if not errors.is_empty():
			_fail("%s: %s" % [recording, errors[0]])
			continue
		if records.size() != expected.size():
			_fail("%s: %d records framed, %s lists %d" % [recording, records.size(), file_name, expected.size()])
			continue
		for i: int in records.size():
			var want: Dictionary = expected[i]
			var got: Dictionary = records[i]
			if RsWire.as_int(want["offset"]) != RsWire.as_int(got["offset"]) or RsWire.as_int(want["byte_length"]) != RsWire.as_int(got["byte_length"]):
				_fail("%s record %d: framed at %s, %s lists %s" % [recording, i, got, file_name, {"offset": want["offset"], "byte_length": want["byte_length"]}])
	if framed == 0:
		_fail("%s has no *.decoded.json" % dir)
	_check_invalid(dir, version)


func _check_invalid(dir: String, version: int) -> void:
	var index_text: String = FileAccess.get_file_as_string(dir.path_join("index.json"))
	var parsed: Variant = JSON.parse_string(index_text)
	if not (parsed is Dictionary):
		_fail("%s/index.json is unreadable" % dir)
		return
	var index: Dictionary = parsed
	var invalid: Array = index.get("invalid", [])
	for value: Variant in invalid:
		var entry: Dictionary = value
		var code: String = str(entry.get("code", entry.get("error", "")))
		if not FRAMING_CODES.has(code):
			continue
		var path: String = dir.path_join(str(entry["file"]))
		var split: Dictionary = RsWire.split_records(FileAccess.get_file_as_bytes(path), version)
		var errors: PackedStringArray = split["errors"]
		_checked += 1
		if errors.is_empty() or RsWire.code_of(errors[0]) != code:
			_fail("%s: expected framing code %s, got %s" % [path, code, errors])


## Exercise the dynamic GDExtension boundary, including packed array argument/return types.
func _check_native_queries() -> void:
	_checked += 1
	var load_error: String = RsRustApplier.load_core(RsRustApplier.DEFAULT_EXTENSION)
	if load_error != "":
		_fail("native query adapter unavailable: " + load_error)
		return
	var core: RefCounted = ClassDB.instantiate("RsCore")
	for method: String in ["set_hit_filters", "hit_test", "to_game"]:
		if not core.has_method(method):
			_fail("native query adapter missing " + method)
			return
	if core.call("hit_test", 10.0, 20.0) != -1:
		_fail("native hit_test before a session must return -1")
	var point: Variant = core.call("to_game", 10.0, 20.0)
	if not point is PackedFloat64Array or point != PackedFloat64Array([-1.0, 10.0, 20.0]):
		_fail("native to_game before a session has the wrong packed result")
	if core.call("set_hit_filters", PackedInt32Array([1]), PackedByteArray([1])) != "":
		_fail("native set_hit_filters rejected INPUT")
	if core.call("set_hit_filters", PackedInt32Array([1]), PackedByteArray()) == "":
		_fail("native set_hit_filters accepted mismatched lengths")
	if core.call("set_hit_filters", PackedInt32Array([1]), PackedByteArray([0])) == "":
		_fail("native set_hit_filters accepted an invalid filter")


## Later golden sets also contain standalone .record decodes and recordings without JSON.
func _check_recent_goldens(dir: String, version: int) -> void:
	var framed: int = 0
	for file_name: String in DirAccess.get_files_at(dir):
		if not file_name.ends_with(".rs%d" % version) or file_name.begins_with("corrupt"):
			continue
		var data: PackedByteArray = FileAccess.get_file_as_bytes(dir.path_join(file_name))
		var split: Dictionary = RsWire.split_records(data, version)
		var errors: PackedStringArray = split["errors"]
		var records: Array[Dictionary] = split["records"]
		_checked += 1
		framed += 1
		if not errors.is_empty() or records.is_empty():
			_fail("%s: %s" % [file_name, errors])
			continue
		var end: int = 8
		for record: Dictionary in records:
			if RsWire.as_int(record["offset"]) != end:
				_fail("%s: non-contiguous record" % file_name)
			end += RsWire.as_int(record["byte_length"])
		if end != data.size():
			_fail("%s: framing left bytes" % file_name)
	if framed == 0:
		_fail("%s has no recordings" % dir)
	_check_invalid(dir, version)


## The same vectors cross the native String ABI as the Rust and browser tests.
func _check_protocol_helpers() -> void:
	var client := RsLiveClient.new()
	var path: String = ProjectSettings.globalize_path("res://../rs-core/src/client/vectors.json")
	var parsed: Variant = JSON.parse_string(FileAccess.get_file_as_string(path))
	if not parsed is Array:
		_fail("shared client vectors are unreadable")
		return
	var vectors: Array = parsed
	for value: Variant in vectors:
		var vector: Dictionary = value
		var operation: String = vector["op"]
		var input: String = vector["input"]
		var output: String = client.protocol_call(operation, input)
		_checked += 1
		if vector.has("error"):
			var error: Dictionary = JSON.parse_string(output)
			if error.get("error") != vector["error"]:
				_fail("shared client vector %s: wrong error" % vector["name"])
		elif output != vector["output"]:
			_fail("shared client vector %s: wrong output" % vector["name"])


func _check_resource_base() -> void:
	for value: Array in [
		["http://example.test", "http", "example.test", 80, "/resources/sha256/"],
		["https://example.test", "https", "example.test", 443, "/resources/sha256/"],
		["https://example.test:8443/prefix", "https", "example.test", 8443, "/prefix/resources/sha256/"],
		["http://[::1]:8080/prefix", "http", "::1", 8080, "/prefix/resources/sha256/"],
	]:
		var fetcher := RsResourceFetcher.new("", 0, "/resources/sha256/", 1000, 0)
		_checked += 1
		var base: String = value[0]
		if fetcher.configure_base(base) != OK or [fetcher.scheme, fetcher.host, fetcher.port, fetcher.path_prefix] != value.slice(1):
			_fail("resourceBase HTTPClient adaptation: " + base)
	for base: String in ["ws://example.test", "https://example.test:0", "https://example.test:65536", "/relative"]:
		var fetcher := RsResourceFetcher.new("", 0, "/resources/sha256/", 1000, 0)
		_checked += 1
		if fetcher.configure_base(base) == OK:
			_fail("resourceBase accepted invalid HTTPClient address")
		if fetcher.host != "" or fetcher.port != 0:
			_fail("resourceBase failure changed the fetcher")


class TapCore extends RefCounted:
	var point := PackedFloat64Array()

	func to_game(_x: float, _y: float) -> PackedFloat64Array:
		return point


func _check_tapped() -> void:
	var client := RsLiveClient.new()
	var core := TapCore.new()
	var events: Array[Dictionary] = []
	client.tapped.connect(func(screen: Vector2, item: int, game: Vector2) -> void:
		events.append({"screen": screen, "item": item, "game": game})
	)
	_checked += 1
	client.tap(Vector2(2, 3), core)
	if not events.is_empty():
		_fail("an empty coordinate mapping emitted tapped")
	_checked += 1
	core.point = PackedFloat64Array([7, 10, 20])
	client.tap(Vector2(2, 3), core)
	if events != [{"screen": Vector2(2, 3), "item": 7, "game": Vector2(10, 20)}]:
		_fail("tapped did not carry the mapped point and item")
	_checked += 1
	core.point = PackedFloat64Array([-1, 2, 3])
	client.tap(Vector2(2, 3), core)
	if events.size() != 2 or events[1]["item"] != -1:
		_fail("a bare point must emit tapped with item -1")


## Packs receive JSON numbers as FLOATs; the native boundary must accept and normalize them.
func _check_json_descriptor() -> void:
	var client := RsLiveClient.new()
	client.origin = "http://127.0.0.1:5190"
	var descriptor: Dictionary = JSON.parse_string('{"url":"/rs","resourceBase":"","token":null,"protocol":19,"presentation":[640,360]}')
	_checked += 1
	if typeof(descriptor["protocol"]) != TYPE_FLOAT:
		_fail("JSON descriptor fixture must exercise Godot FLOAT numbers")
	var result: Error = client.connect_descriptor(descriptor)
	_checked += 1
	if result != OK or client.descriptor != JSON.parse_string('{"url":"ws://127.0.0.1:5190/rs","resourceBase":"http://127.0.0.1:5190","token":null,"protocol":19,"presentation":[640,360]}'):
		_fail("JSON-parsed descriptor failed to resolve: " + client.last_error)
	_checked += 1
	var hello: Variant = JSON.parse_string(client._descriptor_hello)
	if not hello is Dictionary:
		_fail("JSON-parsed descriptor failed to construct hello")
		return
	var hello_dict: Dictionary = hello
	if hello_dict.get("protocol") != "render-stream/19" or hello_dict.get("credit_window") != 2:
		_fail("JSON-parsed descriptor failed to construct hello")
	if client.peer != null:
		client.peer.close()


class InputView extends "res://receiver.gd":
	func _ready() -> void:
		set_process(false)


## Leave the real _begin_apply HTTP transaction open without starting a network request.
class HeldHttpFetcher extends RsResourceFetcher:
	func poll() -> bool:
		return false


## Re-encode the /6 query fixture after changing its session and custom hit rects.
func _tap_meta(value: Variant) -> Variant:
	if value is Dictionary:
		var dict: Dictionary = value
		for key: String in dict:
			dict[key] = _tap_meta(dict[key])
	elif value is Array:
		var array: Array = value
		for index: int in array.size():
			array[index] = _tap_meta(array[index])
	elif RsWire.is_int(value):
		return RsWire.as_int(value)
	return value


func _tap_record(record: Dictionary) -> PackedByteArray:
	var meta: Dictionary = _tap_meta(record["meta"])
	var text: PackedByteArray = JSON.stringify(meta, "", false).to_utf8_buffer()
	var bytes := PackedByteArray()
	bytes.resize(8)
	bytes.encode_u32(4, text.size())
	bytes.append_array(text)
	var blocks: Array = record["blocks"]
	var count := PackedByteArray()
	count.resize(4)
	count.encode_u32(0, blocks.size())
	bytes.append_array(count)
	for index: int in blocks.size():
		var values: Array = blocks[index]
		var kind: String = meta["blocks"][index]["type"]
		var width: int = 8 if kind == "f64" else 4
		var block := PackedByteArray()
		block.resize(4 + values.size() * width)
		block.encode_u32(0, values.size() * width)
		for at: int in values.size():
			var value: float = values[at]
			if kind == "f64":
				block.encode_double(4 + at * width, value)
			elif kind == "i32":
				block.encode_s32(4 + at * width, RsWire.as_int(values[at]))
			else:
				block.encode_float(4 + at * width, value)
		bytes.append_array(block)
	bytes.encode_u32(0, bytes.size() - 4)
	return bytes


## Localized input must use the host's presentation transform, even in a smaller receiver.
func _check_view_tap_presentation() -> void:
	var path: String = ProjectSettings.globalize_path("res://../protocol/golden-6/full.decoded.json")
	var fixture: Dictionary = JSON.parse_string(FileAccess.get_file_as_string(path))
	var session: Dictionary = fixture["records"][0]
	var viewport: Dictionary = session["meta"]["viewport"]
	viewport["logical_size"] = [1920, 1080]
	viewport["presentation_size"] = [960, 540]
	viewport["host_window_size"] = [960, 540]
	viewport["root_size_policy"] = "presentation"
	viewport["stretch"] = {"mode": "canvas_items", "aspect": "keep", "scale_mode": "fractional"}
	session["blocks"][2] = [0, 0, 1920, 1080]
	session["blocks"][3] = [0.5, 0, 0, 0.5, 0, 0]
	var transaction: Dictionary = fixture["records"][1]
	var items: Array = transaction["meta"]["items"]
	for index: int in items.size():
		transaction["meta"]["items"][index]["custom_rect"] = true
		var floats: Array = transaction["blocks"][0]
		# Only item 1 covers logical (120, 30); the faulty (80, 20) misses it.
		floats[18 * index + 14] = 110 if index == 0 else 1000
		floats[18 * index + 15] = 20
		floats[18 * index + 16] = 20
		floats[18 * index + 17] = 20
	var view := InputView.new()
	root.add_child(view)
	var saved_size: Vector2i = root.size
	root.size = Vector2i(640, 360)
	var applier := RsRustApplier.new(RID(), RID())
	var accepted: Dictionary = applier.accept_session(_tap_record(session), 0, 6)
	var applied: Dictionary = applier.accept(_tap_record(transaction), 0)
	var session_errors: PackedStringArray = accepted["errors"]
	var apply_errors: PackedStringArray = applied["errors"]
	_checked += 1
	if not session_errors.is_empty() or not apply_errors.is_empty():
		_fail("tap presentation fixture rejected: %s / %s" % [accepted["errors"], applied["errors"]])
	else:
		view.set("_applier", applier)
		view.set("_last_applied_frame", 1)
		var blocks: Array = accepted["record"]["blocks"]
		view._adopt_presentation(viewport, blocks)
		var native: Object = applier.get("_core")
		native.call("set_hit_filters", PackedInt32Array([1, 2, 3, 4, 5]), PackedByteArray([1, 1, 1, 1, 1]))
		var events: Array[Dictionary] = []
		view.live_client().tapped.connect(func(screen: Vector2, item: int, game: Vector2) -> void:
			events.append({"screen": screen, "item": item, "game": game})
		)
		# Godot localizes receiver pixels (40, 10) to logical coordinates before dispatch.
		var local: Vector2 = root.get_final_transform().affine_inverse() * Vector2(40, 10)
		_checked += 1
		if not local.is_equal_approx(Vector2(120, 30)):
			_fail("tap fixture receiver transform did not localize (40, 10) to (120, 30): %s" % local)
		for touch: bool in [true, false]:
			var event: InputEvent
			if touch:
				var release := InputEventScreenTouch.new()
				release.position = local
				event = release
			else:
				var release := InputEventMouseButton.new()
				release.position = local
				release.button_index = MOUSE_BUTTON_LEFT
				event = release
			view._unhandled_input(event)
			_checked += 1
			var tapped: Dictionary = events.back() if not events.is_empty() else {}
			var screen: Vector2 = tapped.get("screen", Vector2.ZERO)
			var game: Vector2 = tapped.get("game", Vector2.ZERO)
			if events.size() != (1 if touch else 2) or tapped.get("item") != 1 or not screen.is_equal_approx(Vector2(60, 15)) or not game.is_equal_approx(Vector2(60, 15)):
				_fail("tap with different host/receiver presentations: %s" % str(events))
		# Accept another state, then hold its resource GETs while frame 1 remains on screen.
		transaction["meta"]["seq"] = 2
		transaction["meta"]["frame"] = 2
		applied = applier.accept(_tap_record(transaction), 0)
		apply_errors = applied["errors"]
		var fetcher := HeldHttpFetcher.new("127.0.0.1", 9, "/resources/sha256/", 1000, 60000)
		view.set("_fetcher", fetcher)
		view.set("_wire_version", 6)
		var next_meta: Dictionary = transaction["meta"]
		view._begin_apply({"seq": 2}, next_meta, {})
		var pending: Dictionary = view.get("_pending_apply")
		_checked += 1
		if not apply_errors.is_empty() or pending.is_empty() or fetcher.done():
			_fail("tap fixture did not leave an HTTP apply pending")
		var before: int = events.size()
		var touch := InputEventScreenTouch.new()
		touch.position = local
		view._unhandled_input(touch)
		var mouse := InputEventMouseButton.new()
		mouse.position = local
		mouse.button_index = MOUSE_BUTTON_LEFT
		view._unhandled_input(mouse)
		_checked += 1
		if events.size() != before:
			_fail("pending HTTP apply emitted %d taps" % (events.size() - before))
		fetcher.cancel()
	root.content_scale_mode = Window.CONTENT_SCALE_MODE_DISABLED
	root.content_scale_size = Vector2i.ZERO
	root.size = saved_size
	view.free()


## Touch input and its synthesized mouse event describe one physical release.
func _check_view_tapped() -> void:
	var view := InputView.new()
	root.add_child(view)
	var client: RsLiveClient = view.live_client()
	var core := TapCore.new()
	core.point = PackedFloat64Array([7, 10, 20])
	var applier := RsRustApplier.new(RID(), RID())
	applier.set("_core", core)
	view.set("_applier", applier)
	var events: Array[int] = []
	client.tapped.connect(func(_screen: Vector2, item: int, _game: Vector2) -> void:
		events.append(item)
	)
	var touch := InputEventScreenTouch.new()
	touch.position = Vector2(2, 3)
	touch.pressed = false
	view._unhandled_input(touch)
	_checked += 1
	if not events.is_empty():
		_fail("touch before first presented frame emitted tapped")
	events.clear()
	var early_mouse := InputEventMouseButton.new()
	early_mouse.position = touch.position
	early_mouse.button_index = MOUSE_BUTTON_LEFT
	view._unhandled_input(early_mouse)
	_checked += 1
	if not events.is_empty():
		_fail("mouse before first presented frame emitted tapped")
	events.clear()
	view.set("_last_applied_frame", 1)
	view._unhandled_input(touch)
	var mouse := InputEventMouseButton.new()
	mouse.position = touch.position
	mouse.button_index = MOUSE_BUTTON_LEFT
	mouse.pressed = false
	mouse.device = InputEvent.DEVICE_ID_EMULATION
	view._unhandled_input(mouse)
	_checked += 1
	if events != [7]:
		_fail("one touch plus emulated mouse must emit one tapped (got %d)" % events.size())
	mouse.device = 0
	view._unhandled_input(mouse)
	_checked += 1
	if events != [7, 7]:
		_fail("a real left mouse release must still emit one tapped (got %d total)" % events.size())
	view.free()


## Every native live allow-list entry offers and announces the same protocol version.
func _check_live_hello_versions() -> void:
	var saved: Dictionary = {}
	for key: String in ["RS_RECEIVER_PROTOCOL", "RS_RECEIVER_CREDIT_WINDOW", "RS_RECEIVER_LIVE_CODING", "RS_RECEIVER_MANIFEST_SHA256"]:
		saved[key] = OS.get_environment(key) if OS.has_environment(key) else null
		OS.unset_environment(key)
	var view := InputView.new()
	var client: RsLiveClient = view.live_client()
	for version: int in range(6, 20):
		OS.set_environment("RS_RECEIVER_PROTOCOL", str(version))
		_checked += 1
		if not view._parse_wire_env():
			_fail("live allow-list refused protocol %d" % version)
			continue
		var opened: Error = client.open("ws://127.0.0.1:1/rs", 16777216, "", version)
		_checked += 1
		if opened != OK or client.peer.supported_protocols != PackedStringArray(["render-stream.%d" % version]):
			_fail("live subprotocol disagrees with protocol %d" % version)
		var hello: Dictionary
		if version >= 16:
			hello = JSON.parse_string(client.protocol_call("client_hello", JSON.stringify(view._native_hello_facts())))
		else:
			hello = view._legacy_live_hello()
		_checked += 1
		if hello.get("protocol") != "render-stream/%d" % version:
			_fail("live hello for /%d sent %s" % [version, str(hello.get("protocol"))])
		client.peer.close()
	view.free()
	for key: String in saved:
		if saved[key] == null:
			OS.unset_environment(key)
		else:
			OS.set_environment(key, str(saved[key]))


## Full evidence stays byte-identical; opting out crosses the GDScript/C++/C boundary.
func _check_digest_policies() -> void:
	var data: PackedByteArray = FileAccess.get_file_as_bytes("res://../protocol/golden-11/full.rs11")
	var records: Array[Dictionary] = RsWire.split_records(data, 11)["records"]
	var core: RefCounted = ClassDB.instantiate("RsCore")
	for policy: int in [0, 1, 2]:
		_checked += 1
		if not core.call("set_digest_policy", policy):
			_fail("digest policy %d rejected" % policy)
		if core.call("set_digest_policy", 3):
			_fail("invalid digest policy accepted")
		for i: int in range(records.size()):
			var offset: int = RsWire.as_int(records[i]["offset"])
			var out: Dictionary = core.call("session", data, offset, 11) if i == 0 else core.call("accept", data, offset)
			_checked += 1
			var errors: PackedStringArray = out["errors"]
			if not errors.is_empty():
				_fail("digest policy %d rejected golden-11 record %d" % [policy, i])
			var expected: String = RsWire.sha256_hex(data.slice(offset, offset + RsWire.as_int(records[i]["byte_length"]))) if policy == 0 else ""
			if out["record"]["sha256"] != expected:
				_fail("digest policy %d: record %d digest changed" % [policy, i])
	# The compatibility setter must replace Never in both directions.
	for deferred: bool in [true, false]:
		core.call("set_digest_deferred", deferred)
		var out: Dictionary = core.call("session", data, RsWire.as_int(records[0]["offset"]), 11)
		_checked += 1
		if (out["record"]["sha256"] == "") != deferred:
			_fail("legacy digest setter did not replace policy")
	var receiver_script: GDScript = load("res://receiver.gd")
	var receiver: Node = receiver_script.new()
	var old_log: String = OS.get_environment("RS_RECEIVER_LOG")
	var old_digest: String = OS.get_environment("RS_RECEIVER_DIGEST")
	for mode: String in ["full", "summary"]:
		OS.set_environment("RS_RECEIVER_LOG", mode)
		for digest: String in ["", "inline", "none"]:
			OS.set_environment("RS_RECEIVER_DIGEST", digest)
			for with_states: bool in [false, true]:
				var states: Array[int] = []
				if with_states:
					states.append(1)
				receiver.set("_state_seqs", states)
				_checked += 1
				var ok: bool = receiver.call("_parse_perf_env")
				var expected: bool = digest == "none" or (digest == "" and mode == "summary" and states.is_empty())
				if not ok or receiver.get("_digest_none") != expected:
					_fail("receiver digest selection %s/%s/%s" % [mode, digest, states])
	# Live shot windows request state dumps without populating the file-mode state seqs.
	var no_states: Array[int] = []
	var windows: Array[Dictionary] = [{"step": 1, "from": 1, "to": 2, "shot": false}]
	receiver.set("_state_seqs", no_states)
	receiver.set("_windows", windows)
	OS.set_environment("RS_RECEIVER_LOG", "summary")
	for digest: String in ["", "none"]:
		OS.set_environment("RS_RECEIVER_DIGEST", digest)
		_checked += 1
		var ok: bool = receiver.call("_parse_perf_env")
		if not ok or receiver.get("_digest_none") != (digest == "none"):
			_fail("receiver shot-window digest selection %s" % (digest if digest != "" else "default"))
	windows.clear()
	receiver.set("_windows", windows)
	OS.set_environment("RS_RECEIVER_LOG", old_log)
	OS.set_environment("RS_RECEIVER_DIGEST", old_digest)
	receiver.free()
