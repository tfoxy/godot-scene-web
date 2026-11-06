extends SceneTree
## IN7: the GDScript validator against every packages/input/conformance/v1/codec vector. It must
## agree with the TypeScript codec on `ok`, `code`, `path` (when the vector gives one; none when
## it does not) and `skipped`.
##
##   scripts/test-godot.sh            (runs the --import pass, then every tests/*_selftest.gd)
##
## Prints "[codec-selftest] ok N/N vectors" and quits 0, or prints each failure and quits 1.

const TAG: String = "[codec-selftest]"


func _vector_dir() -> String:
	return ProjectSettings.globalize_path("res://").path_join("../conformance/v1/codec").simplify_path()


func _initialize() -> void:
	var dir: String = _vector_dir()
	var files: PackedStringArray = DirAccess.get_files_at(dir)
	var total: int = 0
	var failures: int = 0
	var sorted: Array[String] = []
	for file: String in files:
		if file.ends_with(".json"):
			sorted.append(file)
	sorted.sort()
	for file: String in sorted:
		# The vector files are ours, so Godot's own JSON reads them; only `text` goes through the
		# validator under test.
		var suite_value: Variant = JSON.parse_string(FileAccess.get_file_as_string(dir.path_join(file)))
		if typeof(suite_value) != TYPE_DICTIONARY:
			print("%s FAIL: %s does not parse" % [TAG, file])
			failures += 1
			continue
		var suite: Dictionary = suite_value
		var vectors: Array = suite["vectors"]
		for item: Variant in vectors:
			var vector: Dictionary = item
			total += 1
			var problem: String = _check(vector)
			if problem != "":
				failures += 1
				print("%s FAIL: %s / %s: %s" % [TAG, file, vector["name"], problem])
	if total == 0:
		print("%s FAIL: no vectors under %s" % [TAG, dir])
		failures += 1
	if failures == 0:
		print("%s ok %d/%d vectors" % [TAG, total, total])
	else:
		print("%s %d of %d vectors disagree" % [TAG, failures, total])
	quit(1 if failures > 0 else 0)


func _check(vector: Dictionary) -> String:
	var text: String = vector["text"]
	var result: Dictionary = GswInputCodec.parse(text)
	var want_ok: bool = vector["ok"]
	var got_ok: bool = result["ok"]
	if want_ok != got_ok:
		return "ok %s, expected %s (%s %s: %s)" % [got_ok, want_ok, result.get("code", ""), result.get("path", ""), result.get("detail", "")]
	if not want_ok:
		var want_code: String = vector["code"]
		var got_code: String = result["code"]
		if want_code != got_code:
			return "code %s, expected %s (path %s: %s)" % [got_code, want_code, result["path"], result["detail"]]
		var want_path: String = vector.get("path", "")
		var got_path: String = result["path"]
		if want_path != got_path:
			return "path '%s', expected '%s'" % [got_path, want_path]
		return ""
	var want_skipped: float = vector.get("skipped", 0)
	var got_skipped: int = result["skipped"]
	if int(want_skipped) != got_skipped:
		return "skipped %d, expected %d" % [got_skipped, int(want_skipped)]
	return ""
