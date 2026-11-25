extends SceneTree
## A hosted receiver survives a disconnect until its owner removes it from the tree.
## Run with --verbose to include Godot's real RID leak diagnostics on a rendered backend.

class RidErrors extends Logger:
	var invalid_frees: int = 0
	var mutex := Mutex.new()

	func _log_error(_function: String, _file: String, _line: int, code: String, rationale: String, _editor_notify: bool, _error_type: int, _script_backtraces: Array[ScriptBacktrace]) -> void:
		if "Attempted to free invalid ID" in code or "Attempted to free invalid ID" in rationale:
			mutex.lock()
			invalid_frees += 1
			mutex.unlock()

class View extends "res://receiver.gd":
	var exit_code: int = -1

	func _ready() -> void:
		set_process(false)

	func _quit(code: int) -> void:
		# A shell keeps its main loop alive to display the disconnected state.
		exit_code = code
		_finished = true
		set_process(false)

var _checks: int = 0
var _failed: int = 0


func _initialize() -> void:
	_run.call_deferred()


func _check(label: String, ok: Variant) -> void:
	_checks += 1
	if not ok:
		_failed += 1
		print("[teardown-selftest] FAIL: " + label)


# JSON numbers must retain the wire's integer spelling when re-encoding metadata.
func _integers(value: Variant) -> Variant:
	if value is Dictionary:
		var dict: Dictionary = value
		for key: String in dict:
			dict[key] = _integers(dict[key])
	elif value is Array:
		var array: Array = value
		for i: int in array.size():
			array[i] = _integers(array[i])
	elif RsWire.is_int(value):
		return RsWire.as_int(value)
	return value


func _shader_payload() -> PackedByteArray:
	var code: PackedByteArray = "shader_type canvas_item; uniform sampler2D source_texture; void fragment() { COLOR *= texture(source_texture, UV); }".to_utf8_buffer()
	var meta: PackedByteArray = JSON.stringify({"type": "shader-code", "code_bytes": code.size()}, "", false).to_utf8_buffer()
	var bytes := PackedByteArray([71, 82, 80, 49, 13, 10, 26, 10])
	bytes.resize(12)
	bytes.encode_u32(8, meta.size())
	bytes.append_array(meta)
	bytes.append_array(code)
	return bytes


func _record(meta: Dictionary, body: PackedByteArray) -> PackedByteArray:
	var text: PackedByteArray = JSON.stringify(meta, "", false).to_utf8_buffer()
	var bytes := PackedByteArray()
	bytes.resize(8)
	bytes.encode_u32(4, text.size())
	bytes.append_array(text)
	bytes.append_array(body)
	bytes.encode_u32(0, bytes.size() - 4)
	return bytes


func _canvas_transaction(data: PackedByteArray, record: Dictionary, seq: int = 1, placeholder: bool = false) -> PackedByteArray:
	var offset: int = RsWire.as_int(record["offset"])
	var end: int = offset + RsWire.as_int(record["byte_length"])
	var meta_end: int = offset + 8 + data.decode_u32(offset + 4)
	var meta: Dictionary = _integers(JSON.parse_string(data.slice(offset + 8, meta_end).get_string_from_utf8()))
	meta["seq"] = seq
	meta["frame"] = seq
	var textures: Array = meta["textures"]
	for texture: Dictionary in textures:
		if texture["id"] == 1:
			texture["version"] = seq
			if placeholder:
				texture.merge({"kind": "placeholder", "hash": null, "format": null, "width": 0, "height": 0, "payload_bytes": 0}, true)
	for id: int in [8, 9]:
		textures.append({
			"id": id, "origin": "created", "kind": "canvas", "status": "ok", "reason": null,
			"version": 1, "hash": null, "format": null, "width": 0, "height": 0,
			"mipmaps": false, "payload_bytes": 0,
			"canvas": {"diffuse": id - 7, "filter": "default", "repeat": "default"},
		})
	meta["textures"] = textures
	var shader: PackedByteArray = _shader_payload()
	meta["shaders"] = [{
		"id": 1, "origin": "created", "status": "ok", "reason": null, "version": 1,
		"mode": "canvas_item", "source": "payload", "hash": RsWire.sha256_hex(shader),
		"payload_bytes": shader.size(), "builtin": null, "uses": [], "default_textures": [],
	}]
	meta["materials"] = [{
		"id": 1, "origin": "created", "status": "ok", "reason": null, "version": 1, "shader": 1,
		"params": [{"name": "source_texture", "type": "rid", "n": 1, "tex": 1, "f": 0}],
	}]
	var items: Array = meta["items"]
	for item: Dictionary in items:
		item["material"] = 1
		var commands: Array = item["commands"]
		for command: Dictionary in commands:
			if command.has("tex") and command["tex"] in [1, 2]:
				command["tex"] = 8 + RsWire.as_int(item["id"]) % 2
	return _record(meta, data.slice(meta_end, end))


func _run() -> void:
	var rid_errors := RidErrors.new()
	OS.add_logger(rid_errors)
	var base: String = ProjectSettings.globalize_path("res://../../../.local/teardown-selftest")
	var data: PackedByteArray = FileAccess.get_file_as_bytes("res://../protocol/golden-6/inline.rs6")
	var records: Array[Dictionary] = RsWire.split_records(data, 6)["records"]
	var session: PackedByteArray = data.slice(0, 8 + RsWire.as_int(records[0]["byte_length"]))
	var transaction := PackedByteArray()
	var transaction_record: Dictionary = {}
	var resources: Array[PackedByteArray] = []
	for record: Dictionary in records:
		var offset: int = RsWire.as_int(record["offset"])
		var meta: Dictionary = JSON.parse_string(data.slice(offset + 8, offset + 8 + data.decode_u32(offset + 4)).get_string_from_utf8())
		if meta["type"] == "resource":
			resources.append(data.slice(offset, offset + RsWire.as_int(record["byte_length"])))
		if meta["type"] == "transaction":
			transaction_record = record
			transaction = _canvas_transaction(data, record)
			break
	var shader: PackedByteArray = _shader_payload()
	var shader_body := PackedByteArray()
	shader_body.resize(8)
	shader_body.encode_u32(0, 1)
	shader_body.encode_u32(4, shader.size())
	shader_body.append_array(shader)
	resources.append(_record({
		"type": "resource", "hash": RsWire.sha256_hex(shader), "bytes": shader.size(),
		"blocks": [{"name": "payload", "type": "u8", "count": shader.size()}],
	}, shader_body))
	var saved: Dictionary = {}
	var settings: Dictionary = {
		"RS_RECEIVER_OUT": base.path_join("applied.json"),
		"RS_RECEIVER_URL": "ws://127.0.0.1:1/render-stream",
		"RS_RECEIVER_PROTOCOL": "6", "RS_RECEIVER_RECEIVED_MAX_BYTES": "0",
	}
	for key: String in settings:
		saved[key] = OS.get_environment(key) if OS.has_environment(key) else null
		OS.set_environment(key, str(settings[key]))
	for mode: String in ["normal", "disconnect", "reconnect", "disposed"]:
		var viewport := SubViewport.new()
		viewport.size = Vector2i(640, 360)
		viewport.render_target_update_mode = SubViewport.UPDATE_ALWAYS
		root.add_child(viewport)
		var view := View.new()
		viewport.add_child(view)
		await view._ready_live()
		# Drive the fake transport explicitly, independently of renderer frame scheduling.
		view.set_process(false)
		view._receive_binary(session)
		for resource: PackedByteArray in resources:
			view._receive_binary(resource)
		var applier: RsRustApplier = view.get("_applier")
		var accepted: Dictionary = applier.accept(transaction, 0)
		var errors: PackedStringArray = accepted["errors"]
		_check(mode + " accepts CanvasTextures", accepted["kind"] == "transaction" and errors.is_empty())
		if not errors.is_empty():
			print(errors)
			viewport.free()
			quit(1)
			return
		var applied: Dictionary = view._fetch_and_apply(1, 1)
		_check(mode + " applies CanvasTextures", applied["ok"])
		var stats: Dictionary = applied["stats"]
		var canvas_uploads: int = 0
		var uploads: Array = stats["uploads"]
		for upload: Dictionary in uploads:
			if upload["op"] == "canvas":
				canvas_uploads += 1
		_check(mode + " creates both CanvasTextures", canvas_uploads == 2)
		var material_resources: Dictionary = stats["material_resources"]
		_check(mode + " creates a material with a texture parameter", material_resources["materials_created"] == 1 and material_resources["param_sets"] == 1)
		# Exercise both texture_replace paths and their consumed temporary RIDs before drawing.
		for seq: int in [2, 3]:
			accepted = applier.accept(_canvas_transaction(data, transaction_record, seq, seq == 2), 0)
			errors = accepted["errors"]
			_check(mode + " accepts replacement %d" % seq, errors.is_empty())
			applied = view._fetch_and_apply(seq, 1)
			_check(mode + " applies replacement %d" % seq, applied["ok"])
			stats = applied["stats"]
			var texture_resources: Dictionary = stats["resources"]
			_check(mode + " replaces one texture %d" % seq, texture_resources["replaced"] == 1)
		if mode == "reconnect":
			var before: int = applier.owned_rids()
			view.set("_reconnect_record", {})
			view._start_next_connection()
			_check("reconnect frees all first-connection RIDs", applier.disposed_frees == before and applier.owned_rids() == 0)
			view._receive_binary(session)
			for resource: PackedByteArray in resources:
				view._receive_binary(resource)
			applier.accept(transaction, 0)
			view._fetch_and_apply(2, 1)
		# Exercise real rendering before the owner removes the borrowed viewport canvas.
		await process_frame
		if DisplayServer.get_name() != "headless":
			await RenderingServer.frame_post_draw
		if mode in ["disconnect", "reconnect"]:
			# An unopened local peer has the same closed transport state as a lost host.
			view.set("_live_phase", "streaming")
			view._process_live()
			var report: Dictionary = view.get("_report")
			_check(mode + " handles live disconnect", report["failure"]["reason"] == "live-disconnected")
		var owned: int = applier.owned_rids()
		_check(mode + " owns RIDs before tree exit", owned >= 2)
		if mode == "disposed":
			view._dispose_applier()
		viewport.free()
		_check(mode + " frees all RIDs on tree exit", applier.owned_rids() == 0)
		_check(mode + " frees each RID once", applier.disposed_frees == owned)
		# Do not hide a missing teardown by cleaning up its leaked RIDs in this assertion.
		_check(mode + " repeated dispose frees nothing", applier.owned_rids() == 0 and applier.dispose() == 0)
	for key: String in saved:
		if saved[key] == null:
			OS.unset_environment(key)
		else:
			OS.set_environment(key, str(saved[key]))
	RenderingServer.force_sync()
	_check("no invalid RD frees", rid_errors.invalid_frees == 0)
	OS.remove_logger(rid_errors)
	print("[teardown-selftest] %d checks, %d failed" % [_checks, _failed])
	quit(0 if _failed == 0 else 1)
