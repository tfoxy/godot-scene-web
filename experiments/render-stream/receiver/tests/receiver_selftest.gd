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
##      lists the records (offset, byte_length), for golden-2 to golden-7;
##   3. every golden invalid/ vector whose index.json code is a framing code (bad-magic, truncated,
##      record-length) fails framing with that code;
##   4. (G8kz) RsResourceFetcher decodes a zstd and a gzip Content-Encoding body (frames made by
##      the zstd CLI and gzip, the same format the host's vendored zstd/zlib write) to the exact
##      identity bytes, and refuses a corrupted, content-size-less or unasked-for coding with
##      resource-invalid.
##
## Decoding, validation and resolution of the golden vectors are the Rust core's (rs-core's cargo
## tests) and the TypeScript checker decoder's (scripts/test/self-test-rs*.ts); G7gd removed the
## GDScript codec self-test (codec2_selftest.gd) with the GDScript decoder.
##
## RS_SELFTEST_GOLDEN_DIR names golden-2 (default <receiver>/../protocol/golden-2); golden-3 to
## golden-7 are its siblings. Prints "[receiver-selftest] ok" and quits 0, or prints each failure
## and quits 1.

const FRAMING_CODES: Array[String] = ["bad-magic", "truncated", "record-length"]

var _failures: Array[String] = []
var _checked: int = 0


func _init() -> void:
	_check_scripts()
	_check_fetcher_coding()
	var golden2: String = OS.get_environment("RS_SELFTEST_GOLDEN_DIR").strip_edges()
	if golden2 == "":
		golden2 = ProjectSettings.globalize_path("res://").path_join("../protocol/golden-2").simplify_path()
	var root: String = golden2.get_base_dir()
	for version: int in range(2, 8):
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


func _check_scripts() -> void:
	for file_name: String in DirAccess.get_files_at("res://"):
		if file_name.get_extension() != "gd":
			continue
		_checked += 1
		var script: Script = load("res://" + file_name)
		if script == null or not script.can_instantiate():
			_fail("res://%s does not load and compile" % file_name)


func _check_golden(dir: String, version: int) -> void:
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
		var code: String = entry["code"]
		if not FRAMING_CODES.has(code):
			continue
		var path: String = dir.path_join(str(entry["file"]))
		var split: Dictionary = RsWire.split_records(FileAccess.get_file_as_bytes(path), version)
		var errors: PackedStringArray = split["errors"]
		_checked += 1
		if errors.is_empty() or RsWire.code_of(errors[0]) != code:
			_fail("%s: expected framing code %s, got %s" % [path, code, errors])
