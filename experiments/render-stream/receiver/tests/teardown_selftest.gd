extends SceneTree
## A hosted receiver survives a disconnect until its owner removes it from the tree.
## Run with --verbose to include Godot's real RID leak diagnostics on a rendered backend.

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


func _canvas_transaction(data: PackedByteArray, record: Dictionary) -> PackedByteArray:
	var offset: int = RsWire.as_int(record["offset"])
	var end: int = offset + RsWire.as_int(record["byte_length"])
	var meta_end: int = offset + 8 + data.decode_u32(offset + 4)
	var meta: Dictionary = _integers(JSON.parse_string(data.slice(offset + 8, meta_end).get_string_from_utf8()))
	var textures: Array = meta["textures"]
	for id: int in [8, 9]:
		textures.append({
			"id": id, "origin": "created", "kind": "canvas", "status": "ok", "reason": null,
			"version": 1, "hash": null, "format": null, "width": 0, "height": 0,
			"mipmaps": false, "payload_bytes": 0,
			"canvas": {"diffuse": null, "filter": "default", "repeat": "default"},
		})
	meta["textures"] = textures
	var items: Array = meta["items"]
	for item: Dictionary in items:
		var commands: Array = item["commands"]
		for command: Dictionary in commands:
			if command.has("tex") and command["tex"] in [1, 2]:
				command["tex"] = 8 + RsWire.as_int(item["id"]) % 2
	var text: PackedByteArray = JSON.stringify(meta, "", false).to_utf8_buffer()
	var bytes := PackedByteArray()
	bytes.resize(8)
	bytes.encode_u32(4, text.size())
	bytes.append_array(text)
	bytes.append_array(data.slice(meta_end, end))
	bytes.encode_u32(0, bytes.size() - 4)
	return bytes


func _run() -> void:
	var base: String = ProjectSettings.globalize_path("res://../../../.local/teardown-selftest")
	var data: PackedByteArray = FileAccess.get_file_as_bytes("res://../protocol/golden-6/inline.rs6")
	var records: Array[Dictionary] = RsWire.split_records(data, 6)["records"]
	var session: PackedByteArray = data.slice(0, 8 + RsWire.as_int(records[0]["byte_length"]))
	var transaction := PackedByteArray()
	var resources: Array[PackedByteArray] = []
	for record: Dictionary in records:
		var offset: int = RsWire.as_int(record["offset"])
		var meta: Dictionary = JSON.parse_string(data.slice(offset + 8, offset + 8 + data.decode_u32(offset + 4)).get_string_from_utf8())
		if meta["type"] == "resource":
			resources.append(data.slice(offset, offset + RsWire.as_int(record["byte_length"])))
		if meta["type"] == "transaction":
			transaction = _canvas_transaction(data, record)
			break
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
	print("[teardown-selftest] %d checks, %d failed" % [_checks, _failed])
	quit(0 if _failed == 0 else 1)
