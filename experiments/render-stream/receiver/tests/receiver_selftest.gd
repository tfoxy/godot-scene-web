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
##      record-length) fails framing with that code.
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
