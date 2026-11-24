extends Node
## A generic script-pack loader. Native libraries belong to the installed shell.

var _http: HTTPRequest


func _ready() -> void:
	_http = HTTPRequest.new()
	_http.timeout = 30.0
	add_child(_http)
	var base := "http://127.0.0.1:8765"
	for arg: String in OS.get_cmdline_user_args():
		if arg.begins_with("--pack-base="):
			base = arg.trim_prefix("--pack-base=").trim_suffix("/")
	var response: Dictionary = await _fetch(base + "/client-pack/manifest.json")
	if response.is_empty():
		return
	var manifest: Variant = JSON.parse_string((response["body"] as PackedByteArray).get_string_from_utf8())
	if not manifest is Dictionary:
		_refuse("invalid manifest JSON")
		return
	var sha: String = str(manifest.get("sha256", ""))
	var entry: String = str(manifest.get("entry", ""))
	if sha.length() != 64 or not sha.is_valid_hex_number(false) or sha != sha.to_lower() or not entry.begins_with("res://") or not entry.ends_with(".tscn") or not manifest.has("packVersion"):
		_refuse("invalid manifest fields")
		return
	var path := "user://packs/%s/pack.pck" % sha
	var bytes := PackedByteArray()
	if FileAccess.file_exists(path):
		bytes = FileAccess.get_file_as_bytes(path)
		if _sha256(bytes) != sha:
			print("[shell] cached pack sha256 mismatch; downloading again")
			bytes.clear()
		else:
			print("[shell] cache hit sha256=%s" % sha)
	if bytes.is_empty():
		print("[shell] downloading pack sha256=%s" % sha)
		response = await _fetch(base + "/client-pack/" + sha + ".pck")
		if response.is_empty():
			return
		bytes = response["body"]
		if _sha256(bytes) != sha:
			_refuse("sha256 mismatch; pack not loaded")
			return
		if DirAccess.make_dir_recursive_absolute(path.get_base_dir()) != OK:
			_refuse("cannot create pack cache")
			return
		var file := FileAccess.open(path, FileAccess.WRITE)
		if file == null:
			_refuse("cannot write pack cache")
			return
		file.store_buffer(bytes)
		file.close()
	print("[shell] sha256 verified: %s" % sha)
	# Replacing files lets Godot refresh the global script class cache carried by this pack.
	if not ProjectSettings.load_resource_pack(path):
		_refuse("load_resource_pack failed")
		return
	print("[shell] load_resource_pack succeeded: %s" % path)
	var scene := load(entry) as PackedScene
	if scene == null or not scene.can_instantiate():
		_refuse("entry scene unavailable")
		return
	print("[shell] verified pack version=%s sha256=%s" % [str(manifest["packVersion"]), sha])
	add_child(scene.instantiate())


func _fetch(url: String) -> Dictionary:
	var error := _http.request(url)
	if error != OK:
		_refuse("HTTP request failed: " + error_string(error))
		return {}
	var result: Array = await _http.request_completed
	if result[0] != HTTPRequest.RESULT_SUCCESS or result[1] != 200:
		_refuse("HTTP failed: result=%s status=%s url=%s" % [result[0], result[1], url])
		return {}
	return {"body": result[3]}


func _sha256(bytes: PackedByteArray) -> String:
	var hash := HashingContext.new()
	hash.start(HashingContext.HASH_SHA256)
	hash.update(bytes)
	return hash.finish().hex_encode()


func _refuse(reason: String) -> void:
	print("[shell] refused: " + reason)
	get_tree().quit(1)
