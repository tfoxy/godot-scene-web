extends SceneTree
## RsApplier / RsResourceCache / RsLiveClient self-test against the shared golden vectors
## (protocol/golden-4/ since G5d, when the receiver switched to render-stream/4; golden-3/ from
## G4e2; gate2-design.md "G2b2", gate4-design.md "G4e2", gate5-design.md "G5d"). golden-4 is
## golden-3's seven states re-encoded as /4 (golden-2's six plus seq 7, item 6's three msdf
## commands against texture 7), then seq 8 (item 7: one of every immediate op, a set_transform and
## a clip_ignore pair), seq 9 (two meshes, item 8's add_mesh), seq 10 (a mesh change alone) and
## seq 11 (a freed mesh, an unsupported one named by item 9, item 10's unknown-mesh command).
##
##   godot --headless --path receiver --script res://tests/applier2_selftest.gd
##
## RS_SELFTEST_GOLDEN_DIR overrides the golden directory (default <receiver>/../protocol/golden-4).
## RS_SELFTEST_TMP_DIR is an absolute scratch directory for the cache tests (default
## user://applier2-selftest). Prints "[applier2-selftest] ok" and quits 0, or prints each
## failure and quits 1.
##
## The applier, through the receiver's exact path (accept_record, then every payload the resolved
## state needs made available, then apply_state):
##   1. full.rs4, patch.rs4 and inline.rs4, each through a fresh applier, produce identical
##      per-seq stats (rs_calls, created, freed, reparented, commands_replayed, unsupported
##      commands, texture created/updated/replaced/freed/upload_bytes/skipped_commands): the
##      receiver's work does not depend on encoding or delivery. seq 6 equals seq 5 and costs 0
##      calls, as does seq 10 (a mesh version alone); dispose() frees exactly the RIDs the applier
##      still owned.
##   2. The texture rules (D5, D10, D11) on the goldens' content: seq 1 makes resident only the
##      ok images and placeholders a command names (A1 once for ids 1 and 2... only id 1 is drawn;
##      F), skips the unknown-texture and unsupported-texture commands; seq 3's new hash is one
##      texture_2d_update; seq 4 frees F's RID when it becomes a tombstone; nothing is uploaded
##      twice for the same hash.
##   3. The reupload sabotage uploads every resident image at every applied transaction; (G6a) the
##      stale-texture sabotage never re-uploads a resident RGBA8 image.
##   4. A reconnect: one applier replays full.rs4, is disposed, and replays patch.rs4 exactly like
##      a fresh one.
##   4b. (G4e2) seq 7's msdf commands replay as two canvas_item_add_msdf_texture_rect_region calls
##      (texture 7 made resident once), the unknown-texture one is skipped and recorded; the
##      drop-msdf sabotage skips both with no record.
##   4c. (G5d) seq 8's item 7 replays every /4 immediate op, its add_set_transform and both
##      add_clip_ignore calls in wire order, one RS call each; ignore-set-transform and
##      ignore-clip-ignore skip exactly those with no record; (G5e) seq 9's add_mesh (item 8)
##      replays against mesh 1, made resident with both surfaces; seq 10 (mesh 2, named by no
##      command) costs nothing; seq 11 frees mesh 1's RID (a tombstone), skips item 9's add_mesh
##      of an unsupported mesh (unsupported-mesh) and item 10's typed unknown-mesh command.
##   4d. (G5e) mesh residency on hand-built states: create, a same-layout change as region updates
##      per changed buffer, a custom AABB, a layout rebuild, a tombstone, a command naming it;
##      drop-mesh-surface and stale-mesh.
## The cache (RsResourceCache):
##   5. fresh refuses a non-empty directory (cache-not-fresh), warm refuses a missing one; a miss
##      fetches from the store, verifies, writes the cache (temp + rename) and keeps it in memory;
##      a new process in warm mode hits; ignore-cache fetches anyway; a wrong-hash store file is
##      resource-hash-mismatch, a missing one resource-unavailable, an undecodable one
##      resource-invalid.
## The live control messages (RsLiveClient):
##   6. hello (render-stream/5 since G55d), ack and resync encode to exactly golden-5's
##      control/valid/*.json messages, and parse_host_text accepts the golden error message and
##      nothing else.
## Shaders and materials (G55d, gate5_5-design.md Q5) on golden-5 (protocol/golden-5/: golden-4's
## eleven states as /5, then seq 12 -- a builtin CanvasItemMaterial shader and a custom one, three
## materials, items naming them, a use_parent_material child, instance parameters and a non-white
## canvas modulate --, seq 13 one parameter change, seq 14 one code change, seq 15 a shader-time
## shader, an unknown material, a param-type material and instance parameter):
##   7. full.rs5, patch.rs5 and inline.rs5 produce identical per-seq stats, the golden-4 states keep
##      their costs, seq 12 creates and compiles both shaders and the three materials and sets every
##      parameter, the items' materials, use_parent_material, instance parameters and the canvas
##      modulate; seq 13 is one material_set_param, seq 14 one shader_set_code on the same RID,
##      seq 15 never compiles the unsupported shader; every parameter is rebuilt as its exact
##      Variant type and value (material_get_param is no witness: dummy storage drops parameters,
##      so the applier's own recorded calls are asserted).
##   8. ignore-material never calls canvas_item_set_material, ignore-canvas-modulate never calls
##      canvas_set_modulate, stale-param sets parameters only at creation.
##   9. params.rs5 (policy params): the withheld shader is skipped and reported shader-withheld
##      without a library, and compiled from a library built from the golden payloads with one.
##  10. Hand-built: default textures set and reset, removed parameters, instance parameters,
##      materials and shaders freed, an unsupported material never created.

var _failures: Array[String] = []
var _golden: String = ""
var _tmp: String = ""
var _payloads: Dictionary[String, PackedByteArray] = {}
## G55d: golden-5 (render-stream/5) and its payloads (textures, meshes and GRP1 shader code).
var _golden5: String = ""
var _payloads5: Dictionary[String, PackedByteArray] = {}
## G6b: golden-6 (render-stream/6) and its payloads; the control messages are golden-6's.
var _golden6: String = ""
var _payloads6: Dictionary[String, PackedByteArray] = {}


func _initialize() -> void:
	_golden = OS.get_environment("RS_SELFTEST_GOLDEN_DIR")
	if _golden == "":
		_golden = ProjectSettings.globalize_path("res://").path_join("../protocol/golden-4").simplify_path()
	_tmp = OS.get_environment("RS_SELFTEST_TMP_DIR")
	if _tmp == "":
		_tmp = ProjectSettings.globalize_path("user://applier2-selftest")
	_golden5 = ProjectSettings.globalize_path("res://").path_join("../protocol/golden-5").simplify_path()
	_golden6 = ProjectSettings.globalize_path("res://").path_join("../protocol/golden-6").simplify_path()
	print("[applier2-selftest] golden %s and %s, scratch %s" % [_golden, _golden5, _tmp])
	var index: Dictionary = _read_json("index.json")
	if index.is_empty():
		_finish()
		return
	var payloads: Array = index["payloads"]
	for value: Variant in payloads:
		var entry: Dictionary = value
		var file: String = entry["file"]
		var hash: String = entry["hash"]
		_payloads[hash] = _read_bytes(file)
	# G5e: golden-4's GRM1 surface payloads, so out-of-band recordings can make meshes resident.
	var mesh_payloads: Array = index.get("mesh_payloads", [])
	for value: Variant in mesh_payloads:
		var mesh_entry: Dictionary = value
		var mesh_file: String = mesh_entry["file"]
		var mesh_hash: String = mesh_entry["hash"]
		_payloads[mesh_hash] = _read_bytes(mesh_file)
	var index5: Dictionary = _read_json_in(_golden5, "index.json")
	for key: String in ["payloads", "mesh_payloads", "shader_payloads"]:
		var list5: Array = index5.get(key, [])
		for value: Variant in list5:
			var entry5: Dictionary = value
			var file5: String = entry5["file"]
			var hash5: String = entry5["hash"]
			_payloads5[hash5] = _read_bytes_in(_golden5, file5)
	var index6: Dictionary = _read_json_in(_golden6, "index.json")
	for key: String in ["payloads", "mesh_payloads", "shader_payloads"]:
		var list6: Array = index6.get(key, [])
		for value: Variant in list6:
			var entry6: Dictionary = value
			var file6: String = entry6["file"]
			var hash6: String = entry6["hash"]
			_payloads6[hash6] = _read_bytes_in(_golden6, file6)
	_test_control_messages()
	_test_cache(index)
	_test_cache_budgets(index)
	# The root canvas is attached to the root viewport only from the first frame on (SceneTree
	# calls MainLoop::initialize before root->_set_tree); the applier tests need it.
	process_frame.connect(_run_applier_tests, CONNECT_ONE_SHOT)


func _run_applier_tests() -> void:
	_test_applier_encodings()
	_test_applier_textures()
	_test_applier_reupload()
	_test_applier_stale_texture()
	_test_applier_reconnect()
	_test_applier_canvas_texture()
	_test_applier_clip_order()
	_test_applier_sabotage_ignore_clip()
	_test_applier_sabotage_clip_before_clear()
	_test_applier_msdf()
	_test_applier_geometry()
	_test_applier_meshes()
	_test_applier_golden5_encodings()
	_test_applier_golden5_variants()
	_test_applier_golden5_sabotages()
	_test_applier_withheld()
	_test_applier_material_lifetimes()
	_test_applier_golden6_canvases()
	_finish()


func _finish() -> void:
	if _failures.is_empty():
		print("[applier2-selftest] ok")
		quit(0)
	else:
		for failure: String in _failures:
			print("[applier2-selftest] FAIL: " + failure)
		print("[applier2-selftest] %d failure(s)" % _failures.size())
		quit(1)


func _check(condition: Variant, what: String) -> void:
	if not condition:
		_failures.append(what)


func _read_bytes(relative: String) -> PackedByteArray:
	return _read_bytes_in(_golden, relative)


func _read_bytes_in(dir: String, relative: String) -> PackedByteArray:
	var path: String = dir.path_join(relative)
	var data: PackedByteArray = FileAccess.get_file_as_bytes(path)
	_check(not data.is_empty(), "cannot read %s" % path)
	return data


func _read_json(relative: String) -> Dictionary:
	return _read_json_in(_golden, relative)


func _read_json_in(dir: String, relative: String) -> Dictionary:
	var path: String = dir.path_join(relative)
	var json := JSON.new()
	if json.parse(FileAccess.get_file_as_string(path)) != OK or typeof(json.data) != TYPE_DICTIONARY:
		_failures.append("cannot parse %s" % path)
		return {}
	return json.data


# --------------------------------------------------------------------------- applier


func _new_applier() -> RsApplier:
	return RsApplier.new(root.get_viewport_rid(), root.find_world_2d().canvas)


## A cache holding every golden payload in memory (as inline records or earlier fetches would);
## `five`: golden-5's (G55d).
func _memory_cache(five: bool = false) -> RsResourceCache:
	var cache := RsResourceCache.new()
	var source: Dictionary[String, PackedByteArray] = _payloads5 if five else _payloads
	for hash: String in source:
		_check(cache.add_inline(hash, source[hash]) == "", "golden payload %s decodes" % hash)
	return cache


## Runs one recording through `applier` record by record, as receiver.gd does. Returns one row per
## record: {kind, errors, rs_calls (that record's own), stats}. The version is the file's: `.rs4`
## (golden-4, decoded as version 4 since the receiver's default became 5 at G55d) or `.rs5`
## (golden-5).
func _apply(applier: RsApplier, file: String, cache: RsResourceCache) -> Array[Dictionary]:
	var version: int = 4
	var dir: String = _golden
	if file.get_extension() == "rs5":
		version = 5
		dir = _golden5
	elif file.get_extension() == "rs6":
		version = 6
		dir = _golden6
	var data: PackedByteArray = _read_bytes_in(dir, file)
	var records: Array[Dictionary] = Rs2Decoder.split_records(data, version)["records"]
	var stream := Rs2Decoder.Stream.new(version)
	var out: Array[Dictionary] = []
	for raw: Dictionary in records:
		var before: int = applier.rs_calls
		var accepted: Dictionary = RsApplier.accept_record(data, Rs2Decoder.as_int(raw["offset"]), stream)
		var errors: PackedStringArray = accepted["errors"]
		var kind: String = accepted["kind"]
		var stats: Dictionary = {}
		if errors.is_empty():
			var record: Dictionary = accepted["record"]
			var meta: Dictionary = record["meta"]
			match kind:
				"session":
					var blocks: Array = record["blocks"]
					applier.begin_session(meta, blocks)
				"resource":
					var payload: PackedByteArray = Rs2Decoder.raw_resource_payload(data, record)
					var resource_hash: String = meta["hash"]
					_check(cache.add_inline(resource_hash, payload) == "", "%s: inline payload decodes" % file)
				"transaction":
					var need: Dictionary = applier.needed(stream.items, stream.textures, stream.meshes, stream.shaders, stream.materials)
					var hashes: Array = need["hashes"]
					for value: Variant in hashes:
						var hash: String = value
						_check(cache.has_in_memory(hash), "%s seq %d needs %s, which is available" % [file, Rs2Decoder.as_int(meta["seq"]), hash])
					stats = applier.apply_state(stream, cache)
		out.append({"kind": kind, "errors": errors, "rs_calls": applier.rs_calls - before, "stats": stats})
	return out


## `after_dispose`: the applier was disposed before (created_rids and freed_by_apply count since it
## was made, so they do not describe this session alone).
func _dispose_checked(applier: RsApplier, what: String, after_dispose: bool = false) -> void:
	var owned: int = applier.owned_rids()
	_check(after_dispose or owned == applier.created_rids - applier.freed_by_apply,"%s: the applier owns %d RIDs, created %d - freed while applying %d" % [what, owned, applier.created_rids, applier.freed_by_apply])
	var freed: int = applier.dispose()
	_check(freed == owned and applier.owned_rids() == 0, "%s: dispose() freed %d RIDs, the applier owned %d" % [what, freed, owned])


## One comparable row per transaction.
static func _row(result: Dictionary) -> String:
	var stats: Dictionary = result["stats"]
	var resources: Dictionary = stats["resources"]
	return str([result["rs_calls"], stats["created"], stats["freed"], stats["reparented"], stats["commands_replayed"], stats["unsupported_commands"], resources])


func _test_applier_encodings() -> void:
	var rows_by_file: Dictionary[String, Array] = {}
	for file: String in ["full.rs4", "patch.rs4", "inline.rs4"]:
		var applier: RsApplier = _new_applier()
		var cache: RsResourceCache = _memory_cache() if file != "inline.rs4" else RsResourceCache.new()
		var results: Array[Dictionary] = _apply(applier, file, cache)
		var rows: Array[String] = []
		var calls: Array[int] = []
		for result: Dictionary in results:
			var errors: PackedStringArray = result["errors"]
			_check(errors.is_empty(), "%s: %s" % [file, str(errors)])
			if result["kind"] == "transaction":
				rows.append(_row(result))
				calls.append(result["rs_calls"])
			elif result["kind"] == "session":
				_check(result["rs_calls"] == 3, "%s: the session made %d RS calls" % [file, result["rs_calls"]])
			else:
				_check(result["rs_calls"] == 0, "%s: a %s record made RS calls" % [file, result["kind"]])
		rows_by_file[file] = rows
		_check(calls.size() == 11 and calls[0] > 0 and calls[5] == 0 and calls[6] > 0 and calls[7] > 0 and calls[8] > 0 and calls[9] == 0 and calls[10] > 0, "%s: rs_calls per seq %s (seq 1 > 0, seq 6 == seq 5's state: 0, seq 7-9's new items > 0, seq 10 (a mesh version alone, meshes are G5e's): 0, seq 11's new items > 0)" % [file, str(calls)])
		print("[applier2-selftest] %s rs_calls per seq %s" % [file, str(calls)])
		_dispose_checked(applier, file)
	_check(rows_by_file["full.rs4"] == rows_by_file["patch.rs4"], "full and patch per-seq applier stats differ")
	_check(rows_by_file["full.rs4"] == rows_by_file["inline.rs4"], "full and inline per-seq applier stats differ")


func _test_applier_textures() -> void:
	var applier: RsApplier = _new_applier()
	var results: Array[Dictionary] = _apply(applier, "full.rs4", _memory_cache())
	var tx: Array[Dictionary] = []
	for result: Dictionary in results:
		if result["kind"] == "transaction":
			var stats: Dictionary = result["stats"]
			tx.append(stats)
	if tx.size() != 11:
		_failures.append("full.rs4 applied %d transactions" % tx.size())
		return
	var r1: Dictionary = tx[0]["resources"]
	# Commands name texture 1 (A1, items 1 and 2), 5 (F, item 4) and 3 (unsupported, item 5); item 3
	# is an unknown-texture command. Texture 2 (Atwin) and 4 (the placeholder) are named by nothing.
	_check(r1["created"] == 2 and r1["updated"] == 0 and r1["skipped_commands"] == 2, "seq 1 resources %s: created 2 (A1, F), 2 skipped commands" % str(r1))
	var uploads1: Array = tx[0]["uploads"]
	_check(uploads1.size() == 2, "seq 1 uploads %s" % str(uploads1))
	var r2: Dictionary = tx[1]["resources"]
	_check(tx[1]["rs_calls"] == 1 and r2["created"] == 0 and r2["upload_bytes"] == 0, "seq 2 (transform only): %s RS call(s), resources %s" % [str(tx[1]["rs_calls"]), str(r2)])
	var r3: Dictionary = tx[2]["resources"]
	_check(r3["updated"] == 1 and r3["upload_bytes"] == 1024 and r3["created"] == 0, "seq 3: A's new hash is one texture_2d_update of 1024 bytes: %s" % str(r3))
	var r4: Dictionary = tx[3]["resources"]
	_check(r4["freed"] == 1 and r4["created"] == 0, "seq 4: F becomes a tombstone and its RID is freed: %s" % str(r4))
	var r5: Dictionary = tx[4]["resources"]
	_check(r5["freed"] == 0 and r5["created"] == 0, "seq 5: the tombstone leaving the table frees nothing more: %s" % str(r5))
	var r7: Dictionary = tx[6]["resources"]
	_check(r7["created"] == 1 and r7["skipped_commands"] == 1 and tx[6]["msdf_commands"] == 2, "seq 7: the page (texture 7) made resident once, two msdf calls, the unknown-texture msdf command skipped: %s, msdf %s" % [str(r7), str(tx[6]["msdf_commands"])])
	_check(applier.resident_textures() == 2, "after seq 7 (and still after seq 11) two textures (A, the page) are resident, got %d" % applier.resident_textures())
	_dispose_checked(applier, "textures")


func _test_applier_reupload() -> void:
	var applier: RsApplier = _new_applier()
	applier.sabotage_reupload = true
	var results: Array[Dictionary] = _apply(applier, "full.rs4", _memory_cache())
	var uploads: int = 0
	for result: Dictionary in results:
		if result["kind"] == "transaction":
			var stats: Dictionary = result["stats"]
			var list: Array = stats["uploads"]
			uploads += list.size()
	# seq 1: A, F; seq 2-3: A, F again; seq 4-6: A only (F is a tombstone); seq 7-11: A and the page.
	_check(uploads == 2 + 2 + 2 + 1 + 1 + 1 + 2 * 5, "the reupload sabotage uploaded %d times" % uploads)
	_dispose_checked(applier, "reupload")


## G6a: RS_RECEIVER_SABOTAGE=stale-texture keeps a resident RGBA8 image's first payload: seq 3's
## new hash for A (16x16 RGBA8) is never uploaded; creates are unaffected.
func _test_applier_stale_texture() -> void:
	var applier: RsApplier = _new_applier()
	applier.sabotage_stale_texture = true
	var results: Array[Dictionary] = _apply(applier, "full.rs4", _memory_cache())
	var updated: int = 0
	var created: int = 0
	for result: Dictionary in results:
		if result["kind"] == "transaction":
			var stats: Dictionary = result["stats"]
			var resources: Dictionary = stats["resources"]
			var u: int = resources["updated"]
			var c: int = resources["created"]
			updated += u
			created += c
	_check(updated == 0 and created == 3, "the stale-texture sabotage: %d updates (expected 0), %d creates (expected 3: A, F, the page)" % [updated, created])
	_dispose_checked(applier, "stale-texture")


func _test_applier_reconnect() -> void:
	var fresh_applier: RsApplier = _new_applier()
	var fresh: Array[Dictionary] = _apply(fresh_applier, "patch.rs4", _memory_cache())
	_dispose_checked(fresh_applier, "reconnect fresh")
	var applier: RsApplier = _new_applier()
	_apply(applier, "full.rs4", _memory_cache())
	_dispose_checked(applier, "reconnect first session")
	var second: Array[Dictionary] = _apply(applier, "patch.rs4", _memory_cache())
	var a: Array[int] = []
	var b: Array[int] = []
	for row: Dictionary in fresh:
		a.append(row["rs_calls"])
	for row: Dictionary in second:
		b.append(row["rs_calls"])
	_check(a == b, "reconnect: the second session cost %s RS calls per record, a fresh applier %s" % [str(b), str(a)])
	_dispose_checked(applier, "reconnect second session", true)


## (G4e2) seq 7 of golden-3 (and golden-4): the msdf commands replay in place, item 6's call log is the two msdf
## calls (the unknown-texture one is skipped and recorded); RS_RECEIVER_SABOTAGE=drop-msdf skips
## both msdf calls with no record of its own (the typed unknown-texture command stays recorded).
func _test_applier_msdf() -> void:
	for drop: bool in [false, true]:
		var applier: RsApplier = _new_applier()
		applier.sabotage_drop_msdf = drop
		var results: Array[Dictionary] = _apply(applier, "full.rs4", _memory_cache())
		var tx: Array[Dictionary] = _transaction_stats(results)
		if tx.size() < 7:
			_failures.append("msdf (drop %s): %d transactions applied" % [str(drop), tx.size()])
			continue
		var last: Dictionary = tx[6]
		var ops: Array = _item_ops(last["item_calls"], 6)
		var unsupported_commands: Array = last["unsupported_commands"]
		var named: Array = []
		for value: Variant in unsupported_commands:
			var command: Dictionary = value
			named.append([command["item"], command["name"], command["reason"]])
		# The capture's typed unknown-texture command is an `unsupported` command on the wire, not
		# an msdf one: it is skipped and recorded either way. A new item always sets its clip.
		_check(named == [[6, "canvas_item_add_msdf_texture_rect_region", "unknown-texture"]], "msdf (drop %s): the unknown-texture command is skipped and recorded: %s" % [str(drop), str(named)])
		if drop:
			_check(ops == ["set_clip"] and last["msdf_commands"] == 0, "drop-msdf: item 6 makes no msdf call: %s, %s" % [str(ops), str(last["msdf_commands"])])
		else:
			_check(ops == ["add_msdf_texture_rect_region", "add_msdf_texture_rect_region", "set_clip"] and last["msdf_commands"] == 2, "seq 7 replays item 6's two msdf commands: %s" % str(ops))
		_dispose_checked(applier, "msdf (drop %s)" % str(drop))


## The per-transaction apply_state() stats of _apply()'s rows, in seq order.
static func _transaction_stats(results: Array[Dictionary]) -> Array[Dictionary]:
	var out: Array[Dictionary] = []
	for result: Dictionary in results:
		if result["kind"] == "transaction":
			var stats: Dictionary = result["stats"]
			out.append(stats)
	return out


## (G5d) golden-4 seq 8: item 7 replays one of every /4 immediate op in wire order, each as the
## engine's own call; the two receiver sabotages skip only their own command; (G5e) add_mesh
## replays against the resident mesh, and only the unsupported and unknown meshes are skipped.
func _test_applier_geometry() -> void:
	var all_ops: Array = [
		"add_line", "add_polyline", "add_multiline", "add_circle", "add_primitive", "add_polygon",
		"add_triangle_array", "add_set_transform", "add_nine_patch", "add_clip_ignore",
		"add_clip_ignore", "set_clip",
	]
	for sabotage: String in ["", "ignore-set-transform", "ignore-clip-ignore"]:
		var applier: RsApplier = _new_applier()
		applier.sabotage_ignore_set_transform = sabotage == "ignore-set-transform"
		applier.sabotage_ignore_clip_ignore = sabotage == "ignore-clip-ignore"
		var results: Array[Dictionary] = _apply(applier, "full.rs4", _memory_cache())
		var tx: Array[Dictionary] = _transaction_stats(results)
		if tx.size() != 11:
			_failures.append("geometry (%s): %d transactions applied" % [sabotage, tx.size()])
			continue
		var want: Array = []
		for op: Variant in all_ops:
			if sabotage == "ignore-set-transform" and op == "add_set_transform":
				continue
			if sabotage == "ignore-clip-ignore" and op == "add_clip_ignore":
				continue
			want.append(op)
		var seq8: Dictionary = tx[7]
		var ops: Array = _item_ops(seq8["item_calls"], 7)
		var seq8_unsupported: Array = seq8["unsupported_commands"]
		_check(ops == want and seq8["geometry_commands"] == want.size() - 1 and seq8_unsupported.is_empty(), "geometry (%s): seq 8 item 7 calls %s, geometry_commands %s, skipped %s" % [sabotage, str(ops), str(seq8["geometry_commands"]), str(seq8_unsupported)])
		var seq9_named: Array = _named_unsupported(tx[8])
		var seq9_meshes: Dictionary = tx[8]["mesh_resources"]
		var seq9_uploads: Array = tx[8]["mesh_uploads"]
		_check(seq9_named.is_empty() and tx[8]["mesh_commands"] == 1 and seq9_meshes["meshes_created"] == 1 and seq9_uploads.size() == 1, "geometry (%s): seq 9's add_mesh replays against mesh 1, created once: %s %s %s" % [sabotage, str(seq9_named), str(seq9_meshes), str(seq9_uploads)])
		var seq10_uploads: Array = tx[9]["mesh_uploads"]
		_check(seq10_uploads.is_empty(), "geometry (%s): seq 10's mesh 2 change (named by no command) uploads nothing: %s" % [sabotage, str(seq10_uploads)])
		var seq11_named: Array = _named_unsupported(tx[10])
		var seq11_meshes: Dictionary = tx[10]["mesh_resources"]
		_check(seq11_named == [[9, "canvas_item_add_mesh", "unsupported-mesh"], [10, "canvas_item_add_mesh", "unknown-mesh"]] and seq11_meshes["meshes_freed"] == 1, "geometry (%s): seq 11 frees mesh 1 and skips the two mesh commands: %s %s" % [sabotage, str(seq11_named), str(seq11_meshes)])
		_dispose_checked(applier, "geometry (%s)" % sabotage)


static func _named_unsupported(stats: Dictionary) -> Array:
	var named: Array = []
	var list: Array = stats["unsupported_commands"]
	for value: Variant in list:
		var command: Dictionary = value
		named.append([command["item"], command["name"], command["reason"]])
	return named


## (G5e) A GRM1 payload (render-stream-4.md "Mesh payload") built here byte for byte: triangles,
## 2D vertices `xy`, one RGBA8 colour per vertex (`colour`), `indices` (u16), and a fixed geometry
## block -- so two payloads differing only in vertex or colour bytes share a layout.
static func _grm1(xy: Array[float], colour: int, indices: Array[int]) -> PackedByteArray:
	var n: int = xy.size() / 2
	var format: int = 1 | (1 << 3) | (1 << 25) | ((1 << 12) if not indices.is_empty() else 0)
	var meta: String = '{"type":"mesh-surface","primitive":"triangles","format":%d,"vertex_count":%d,"index_count":%d,"vertex_bytes":%d,"attribute_bytes":%d,"skin_bytes":0,"index_bytes":%d}' % [format, n, indices.size(), 8 * n, 4 * n, 2 * indices.size()]
	var out: PackedByteArray = "47524d310d0a1a0a".hex_decode()
	var meta_len := PackedByteArray()
	meta_len.resize(4)
	meta_len.encode_u32(0, meta.length())
	out.append_array(meta_len)
	out.append_array(meta.to_ascii_buffer())
	out.append_array(PackedFloat32Array([0.0, 0.0, 0.0, 16.0, 16.0, 0.0, 1.0, 1.0, 0.0, 0.0]).to_byte_array())
	out.append_array(PackedFloat32Array(xy).to_byte_array())
	for _i: int in n:
		var rgba := PackedByteArray()
		rgba.resize(4)
		rgba.encode_u32(0, colour)
		out.append_array(rgba)
	for index: int in indices:
		var pair := PackedByteArray()
		pair.resize(2)
		pair.encode_u16(0, index)
		out.append_array(pair)
	return out


static func _mesh_entry(id: int, version: int, surfaces: Array, aabb: Array, status: String = "ok") -> Dictionary:
	var listed: Array = []
	for value: Variant in surfaces:
		var payload: PackedByteArray = value
		var decoded: Dictionary = RsMeshPayload.decode(payload)
		listed.append({
			"hash": RsMeshPayload.sha256_hex(payload), "payload_bytes": payload.size(),
			"primitive": decoded["primitive"], "format": decoded["format"],
			"vertex_count": decoded["vertex_count"], "index_count": decoded["index_count"],
		})
	return {
		"id": id, "origin": "created", "status": status, "reason": null, "version": version,
		"custom_aabb": aabb, "surfaces": listed if status == "ok" else [],
	}


static func _mesh_item(id: int, mesh: int, version: int) -> Dictionary:
	var item: Dictionary = _clip_test_item(id)
	item["clip"] = false
	item["content_version"] = version
	item["commands"] = [{"op": "add_mesh", "mesh": mesh, "tex": null, "transform": [1.0, 0.0, 0.0, 1.0, 0.0, 0.0], "modulate": [1.0, 1.0, 1.0, 1.0]}]
	return item


## (G5e, gate5-design.md Q5) Mesh residency through hand-built resolved states: a named mesh is
## created with every surface and its custom AABB; a same-layout payload change is one region
## update per changed buffer (no rebuild, no item re-record); a custom AABB change is one call; a
## layout change is mesh_clear and every surface again; a freed tombstone frees the RID and the
## still-recorded add_mesh is left alone; drop-mesh-surface never adds surface 1; stale-mesh makes
## no in-place update.
func _test_applier_meshes() -> void:
	var tri: Array[float] = [0.0, 0.0, 8.0, 0.0, 0.0, 8.0]
	var tri_moved: Array[float] = [1.0, 0.0, 8.0, 0.0, 0.0, 8.0]
	var quad: Array[float] = [0.0, 0.0, 8.0, 0.0, 8.0, 8.0, 0.0, 8.0]
	var s_a: PackedByteArray = _grm1(tri, 0xff0000ff, [])
	var s_b: PackedByteArray = _grm1(tri_moved, 0xff0000ff, [])
	var s_c: PackedByteArray = _grm1(tri_moved, 0xff00ff00, [])
	var s_q: PackedByteArray = _grm1(quad, 0xffffffff, [0, 1, 2, 0, 2, 3])
	var zero: Array = [0.0, 0.0, 0.0, 0.0, 0.0, 0.0]
	for sabotage: String in ["", "drop-mesh-surface", "stale-mesh"]:
		var cache := RsResourceCache.new()
		for payload: PackedByteArray in [s_a, s_b, s_c, s_q]:
			_check(cache.add_inline(RsMeshPayload.sha256_hex(payload), payload) == "", "mesh payload decodes")
		var applier: RsApplier = _new_applier()
		applier.sabotage_drop_mesh_surface = sabotage == "drop-mesh-surface"
		applier.sabotage_stale_mesh = sabotage == "stale-mesh"
		var stream := Rs2Decoder.Stream.new()
		stream.canvases = {1: {"items": [40], "xform": [1.0, 0.0, 0.0, 1.0, 0.0, 0.0]}}
		stream.textures = {}
		stream.items = {40: _mesh_item(40, 1, 1)}
		stream.meshes = {1: _mesh_entry(1, 3, [s_a, s_q], zero), 2: _mesh_entry(2, 1, [s_q], zero)}
		var need: Dictionary = applier.needed(stream.items, stream.textures, stream.meshes)
		var need_meshes: Array = need["mesh_hashes"]
		_check(need_meshes.size() == 2 and need_meshes.has(RsMeshPayload.sha256_hex(s_a)), "meshes (%s): only the named mesh's two surfaces are needed: %s" % [sabotage, str(need_meshes)])
		var r1: Dictionary = applier.apply_state(stream, cache)
		var m1: Dictionary = r1["mesh_resources"]
		var up1: Array = r1["mesh_uploads"]
		var first: Dictionary = up1[0] if not up1.is_empty() else {}
		var want_surfaces: Array = [0] if sabotage == "drop-mesh-surface" else [0, 1]
		_check(m1["meshes_created"] == 1 and up1.size() == 1 and first.get("op") == "create" and first.get("surfaces") == want_surfaces and r1["mesh_commands"] == 1 and applier.resident_meshes() == 1, "meshes (%s): one create (surfaces %s) and one add_mesh, mesh 2 (never named) not resident: %s %s" % [sabotage, str(want_surfaces), str(m1), str(up1)])
		# A vertex change in the same layout: one vertex region update, nothing re-recorded.
		stream.meshes = {1: _mesh_entry(1, 4, [s_b, s_q], zero)}
		var need2: Dictionary = applier.needed(stream.items, stream.textures, stream.meshes)
		var need2_meshes: Array = need2["mesh_hashes"]
		_check(need2_meshes == [RsMeshPayload.sha256_hex(s_b)], "meshes (%s): only the changed surface is needed: %s" % [sabotage, str(need2_meshes)])
		var r2: Dictionary = applier.apply_state(stream, cache)
		var m2: Dictionary = r2["mesh_resources"]
		var up2: Array = r2["mesh_uploads"]
		var item_ops2: Array = _item_ops(r2["item_calls"], 40)
		if sabotage == "stale-mesh":
			_check(m2["surface_updates"] == 0 and up2.is_empty(), "stale-mesh: no in-place update: %s" % str(up2))
		else:
			var update: Dictionary = up2[0] if not up2.is_empty() else {}
			_check(m2["surface_updates"] == 1 and m2["meshes_rebuilt"] == 0 and update.get("op") == "update" and update.get("buffers") == ["vertex"] and update.get("surfaces") == [0] and item_ops2.is_empty(), "meshes (%s): a same-layout vertex change is one vertex region update, no item call: %s %s" % [sabotage, str(up2), str(item_ops2)])
		# A colour change and a custom AABB: one attribute update and one custom AABB call.
		stream.meshes = {1: _mesh_entry(1, 6, [s_c, s_q], [0.0, -2.0, 0.0, 16.0, 20.0, 0.0])}
		var r3: Dictionary = applier.apply_state(stream, cache)
		var up3: Array = r3["mesh_uploads"]
		var ops3: Array = []
		for value: Variant in up3:
			var row: Dictionary = value
			ops3.append([row["op"], row["buffers"]])
		var want3: Array = [["custom_aabb", []]] if sabotage == "stale-mesh" else [["update", ["attribute"]], ["custom_aabb", []]]
		_check(ops3 == want3, "meshes (%s): colour + custom AABB: %s, expected %s" % [sabotage, str(ops3), str(want3)])
		# A layout change (surface 0 becomes the quad): clear and every surface again.
		stream.meshes = {1: _mesh_entry(1, 8, [s_q, s_a], [0.0, -2.0, 0.0, 16.0, 20.0, 0.0])}
		var r4: Dictionary = applier.apply_state(stream, cache)
		var m4: Dictionary = r4["mesh_resources"]
		var up4: Array = r4["mesh_uploads"]
		var rebuild: Dictionary = up4[0] if not up4.is_empty() else {}
		_check(m4["meshes_rebuilt"] == 1 and up4.size() == 1 and rebuild.get("op") == "rebuild" and rebuild.get("surfaces") == want_surfaces, "meshes (%s): a layout change rebuilds: %s" % [sabotage, str(up4)])
		# A tombstone: the RID is freed, the item's recorded add_mesh is not re-recorded.
		stream.meshes = {1: _mesh_entry(1, 8, [], zero, "freed")}
		var r5: Dictionary = applier.apply_state(stream, cache)
		var m5: Dictionary = r5["mesh_resources"]
		_check(m5["meshes_freed"] == 1 and applier.resident_meshes() == 0 and _item_ops(r5["item_calls"], 40).is_empty(), "meshes (%s): a freed tombstone frees the mesh RID: %s" % [sabotage, str(m5)])
		# The item redraws naming the tombstone: skipped and recorded mesh-freed.
		stream.items = {40: _mesh_item(40, 1, 2)}
		var r6: Dictionary = applier.apply_state(stream, cache)
		var m6: Dictionary = r6["mesh_resources"]
		_check(_named_unsupported(r6) == [[40, "canvas_item_add_mesh", "mesh-freed"]] and m6["skipped_mesh_commands"] == 1 and r6["mesh_commands"] == 0, "meshes (%s): an add_mesh naming a tombstone is skipped and recorded: %s" % [sabotage, str(_named_unsupported(r6))])
		_dispose_checked(applier, "meshes (%s)" % sabotage)

## G2d: canvas_texture_create, canvas_texture_set_channel(DIFFUSE), filter, repeat. No golden-2
## vector carries a canvas texture (golden-2 predates G2d, gate2-design.md G2d "As built"), so
## this hand-builds a resolved Rs2Decoder.Stream (its fields are plain public Dictionaries) to
## exercise the applier's kind == "canvas" branch directly, the one path neither golden-2 nor a
## headless gate 2 run can reach (a headless capture's canvas_texture_create always returns
## RID(), so CT never reaches the wire table there).
func _test_applier_canvas_texture() -> void:
	var applier: RsApplier = _new_applier()
	var cache: RsResourceCache = _memory_cache()
	var payload_hashes: Array[String] = _payloads.keys()
	var image_hash: String = payload_hashes[0]
	var decoded: Dictionary = cache.decoded(image_hash)
	var stream := Rs2Decoder.Stream.new()
	stream.canvases = {1: {"items": [10, 11], "xform": [1.0, 0.0, 0.0, 1.0, 0.0, 0.0]}}
	var image_entry: Dictionary = {
		"id": 1, "kind": "image", "status": "ok", "hash": image_hash,
		"format": decoded["format"], "width": decoded["width"], "height": decoded["height"],
		"mipmaps": decoded["mipmaps"], "payload_bytes": 0, "canvas": null,
	}
	var canvas_entry: Dictionary = {
		"id": 2, "kind": "canvas", "status": "ok", "version": 4, "hash": null,
		"format": null, "width": 0, "height": 0, "mipmaps": false, "payload_bytes": 0,
		"canvas": {"diffuse": 1, "filter": "nearest", "repeat": "enabled"},
	}
	stream.textures = {1: image_entry, 2: canvas_entry}
	var base_item: Dictionary = {
		"parent": {"kind": "canvas", "id": 1}, "children": [],
		"xform": [1.0, 0.0, 0.0, 1.0, 0.0, 0.0], "modulate": [1.0, 1.0, 1.0, 1.0],
		"self_modulate": [1.0, 1.0, 1.0, 1.0], "visible": true, "clip": false,
		"custom_rect": false, "custom_rect_rect": [0.0, 0.0, 0.0, 0.0],
		"visibility_layer": 1, "z_index": 0, "z_relative": true, "behind": false,
		"draw_index": 0, "texture_filter": "default", "texture_repeat": "default",
		"content_version": 1,
	}
	# Item 10 draws A directly (D5 lazy residency: A must already be resident before item 11's
	# canvas texture can resolve its diffuse, exactly as the real fixture's SC relies on A already
	# being drawn elsewhere).
	var item_a: Dictionary = base_item.duplicate(true)
	item_a["id"] = 10
	item_a["commands"] = [{"op": "add_texture_rect", "tex": 1, "tile": false, "transpose": false,
		"rect": [0.0, 0.0, 4.0, 4.0], "modulate": [1.0, 1.0, 1.0, 1.0]}]
	var item_ct: Dictionary = base_item.duplicate(true)
	item_ct["id"] = 11
	item_ct["texture_filter"] = "linear"
	item_ct["commands"] = [{"op": "add_texture_rect", "tex": 2, "tile": false, "transpose": false,
		"rect": [0.0, 0.0, 10.0, 10.0], "modulate": [1.0, 1.0, 1.0, 1.0]}]
	stream.items = {10: item_a, 11: item_ct}

	var need: Dictionary = applier.needed(stream.items, stream.textures)
	var need_ids: Array = need["ids"]
	_check(need_ids == [1], "only the image (A) needs a fetch, not the canvas texture: %s" % str(need))

	var stats: Dictionary = applier.apply_state(stream, cache)
	var resources: Dictionary = stats["resources"]
	_check(resources["created"] == 2, "A and CT both counted created: %s" % str(resources))
	_check(applier.resident_textures() == 2, "two resident textures (image + canvas), got %d" % applier.resident_textures())
	var unsupported_commands: Array = stats["unsupported_commands"]
	_check(unsupported_commands.is_empty(), "the canvas-texture draw is not skipped: %s" % str(unsupported_commands))

	# Re-apply the same (unchanged) state: version-driven, so CT's setters are not re-issued and A
	# is not re-uploaded (same hash) -- no RS calls at all for either texture.
	var before: int = applier.rs_calls
	var stats2: Dictionary = applier.apply_state(stream, cache)
	_check(applier.rs_calls == before, "an unchanged canvas texture and image make no further RS calls: %d -> %d" % [before, applier.rs_calls])
	var resources2: Dictionary = stats2["resources"]
	_check(resources2["created"] == 0, "re-applying creates nothing: %s" % str(resources2))

	# Bump CT's version (diffuse cleared to null): the setters are re-issued once.
	var cleared: Dictionary = canvas_entry.duplicate(true)
	cleared["version"] = 5
	var cleared_canvas: Dictionary = cleared["canvas"]
	cleared_canvas["diffuse"] = null
	stream.textures = {1: image_entry, 2: cleared}
	var calls_before: int = applier.rs_calls
	applier.apply_state(stream, cache)
	_check(applier.rs_calls > calls_before, "a version bump re-issues CT's setters: %d -> %d" % [calls_before, applier.rs_calls])

	_dispose_checked(applier, "canvas texture")


## Every `item_calls` op recorded for one item id, in call order (test instrumentation,
## apply_state()'s docstring).
static func _item_ops(item_calls: Variant, id: int) -> Array:
	var list: Array = item_calls
	var out: Array = []
	for value: Variant in list:
		var entry: Dictionary = value
		if entry["item"] == id:
			out.append(entry["op"])
	return out


## A hand-built resolved item (gate3-design.md Q5, G3b): one clipping item with a single
## add_rect, parented straight to canvas 1.
static func _clip_test_item(id: int) -> Dictionary:
	return {
		"id": id, "parent": {"kind": "canvas", "id": 1}, "children": [],
		"xform": [1.0, 0.0, 0.0, 1.0, 0.0, 0.0], "modulate": [1.0, 1.0, 1.0, 1.0],
		"self_modulate": [1.0, 1.0, 1.0, 1.0], "visible": true, "clip": true,
		"custom_rect": false, "custom_rect_rect": [0.0, 0.0, 0.0, 0.0],
		"visibility_layer": 1, "z_index": 0, "z_relative": true, "behind": false,
		"draw_index": 0, "texture_filter": "default", "texture_repeat": "default",
		"content_version": 1,
		"commands": [{"op": "add_rect", "aa": false, "rect": [0.0, 0.0, 10.0, 10.0], "color": [1.0, 1.0, 1.0, 1.0]}],
	}


## gate3-design.md Q5 "Apply order (G3b)": the clip setter moves after the content block, and a
## content rebuild's clear resets the shadow clip to false, asserted through apply_state()'s
## item_calls log (the recorded RS call sequence; the three cases of the contract plus the new
## item's path, which keeps today's ordering since a new item never clears).
func _test_applier_clip_order() -> void:
	var applier: RsApplier = _new_applier()
	var cache := RsResourceCache.new()
	var stream := Rs2Decoder.Stream.new()
	stream.canvases = {1: {"items": [30], "xform": [1.0, 0.0, 0.0, 1.0, 0.0, 0.0]}}
	stream.textures = {}

	# Setup: a new item with clip true -- no clear, and the setter still fires (is_new).
	stream.items = {30: _clip_test_item(30)}
	var setup: Dictionary = applier.apply_state(stream, cache)
	_check(_item_ops(setup["item_calls"], 30) == ["add_rect", "set_clip"], "new item: item_calls %s" % str(_item_ops(setup["item_calls"], 30)))

	# Case 1: content changed (version bump, an extra command), clip unchanged (true): clear, the
	# adds, then set_clip(true) -- the post-clear shadow (false) differs from the wire (true).
	var case1: Dictionary = _clip_test_item(30)
	case1["content_version"] = 2
	case1["commands"] = [
		{"op": "add_rect", "aa": false, "rect": [0.0, 0.0, 10.0, 10.0], "color": [1.0, 1.0, 1.0, 1.0]},
		{"op": "add_rect", "aa": false, "rect": [2.0, 2.0, 4.0, 4.0], "color": [0.0, 1.0, 0.0, 1.0]},
	]
	stream.items = {30: case1}
	var r1: Dictionary = applier.apply_state(stream, cache)
	_check(_item_ops(r1["item_calls"], 30) == ["clear", "add_rect", "add_rect", "set_clip"], "case 1 (content changed, clip unchanged true): item_calls %s" % str(_item_ops(r1["item_calls"], 30)))

	# Case 2: only the transform changed (same content_version, same clip): no set_clip, no clear.
	var case2: Dictionary = case1.duplicate(true)
	case2["xform"] = [1.0, 0.0, 0.0, 1.0, 5.0, 0.0]
	stream.items = {30: case2}
	var r2: Dictionary = applier.apply_state(stream, cache)
	_check(_item_ops(r2["item_calls"], 30) == [], "case 2 (transform only): item_calls %s" % str(_item_ops(r2["item_calls"], 30)))

	# Case 3: clip true -> false together with a content change: clear, adds, and no set_clip
	# call, because the shadow is already false after the clear.
	var case3: Dictionary = case2.duplicate(true)
	case3["clip"] = false
	case3["content_version"] = 3
	case3["commands"] = [{"op": "add_rect", "aa": false, "rect": [0.0, 0.0, 6.0, 6.0], "color": [0.0, 0.0, 1.0, 1.0]}]
	stream.items = {30: case3}
	var r3: Dictionary = applier.apply_state(stream, cache)
	_check(_item_ops(r3["item_calls"], 30) == ["clear", "add_rect"], "case 3 (clip true -> false with content change): item_calls %s" % str(_item_ops(r3["item_calls"], 30)))

	_dispose_checked(applier, "clip order")


## RS_RECEIVER_SABOTAGE=ignore-clip: the call cadence is exactly case 1's (the shadow still
## tracks the true wire value), only the RS argument is corrupted to false -- unobservable through
## item_calls (which logs the op, not its argument), so this proves the cadence is unchanged.
func _test_applier_sabotage_ignore_clip() -> void:
	var applier: RsApplier = _new_applier()
	applier.sabotage_ignore_clip = true
	var cache := RsResourceCache.new()
	var stream := Rs2Decoder.Stream.new()
	stream.canvases = {1: {"items": [31], "xform": [1.0, 0.0, 0.0, 1.0, 0.0, 0.0]}}
	stream.textures = {}
	stream.items = {31: _clip_test_item(31)}
	var setup: Dictionary = applier.apply_state(stream, cache)
	_check(_item_ops(setup["item_calls"], 31) == ["add_rect", "set_clip"], "ignore-clip setup: the call still happens, only its argument is corrupted")

	var case1: Dictionary = _clip_test_item(31)
	case1["content_version"] = 2
	stream.items = {31: case1}
	var r1: Dictionary = applier.apply_state(stream, cache)
	_check(_item_ops(r1["item_calls"], 31) == ["clear", "add_rect", "set_clip"], "ignore-clip case 1 (content changed, clip unchanged true): same cadence as an honest receiver, %s" % str(_item_ops(r1["item_calls"], 31)))
	_dispose_checked(applier, "sabotage ignore-clip")


## RS_RECEIVER_SABOTAGE=clip-before-clear: the pre-gate-3 order (Q1b's receiver bug) -- the clip
## setter runs before the content block, and a clear does not reset the shadow, so a clipping
## item's next content rebuild loses its clip for good (no set_clip call, because the un-reset
## shadow already agrees with the unchanged wire value).
func _test_applier_sabotage_clip_before_clear() -> void:
	var applier: RsApplier = _new_applier()
	applier.sabotage_clip_before_clear = true
	var cache := RsResourceCache.new()
	var stream := Rs2Decoder.Stream.new()
	stream.canvases = {1: {"items": [32], "xform": [1.0, 0.0, 0.0, 1.0, 0.0, 0.0]}}
	stream.textures = {}
	stream.items = {32: _clip_test_item(32)}
	var setup: Dictionary = applier.apply_state(stream, cache)
	_check(_item_ops(setup["item_calls"], 32) == ["set_clip", "add_rect"], "clip-before-clear setup: the old order, clip before content, %s" % str(_item_ops(setup["item_calls"], 32)))

	var case1: Dictionary = _clip_test_item(32)
	case1["content_version"] = 2
	stream.items = {32: case1}
	var r1: Dictionary = applier.apply_state(stream, cache)
	_check(_item_ops(r1["item_calls"], 32) == ["clear", "add_rect"], "clip-before-clear case 1: no set_clip call -- the bug this sabotage reproduces, %s" % str(_item_ops(r1["item_calls"], 32)))
	_dispose_checked(applier, "sabotage clip-before-clear")


# --------------------------------------------------------------------------- cache


func _clean(path: String) -> void:
	if not DirAccess.dir_exists_absolute(path):
		return
	for file_name: String in DirAccess.get_files_at(path):
		DirAccess.remove_absolute(path.path_join(file_name))
	for dir_name: String in DirAccess.get_directories_at(path):
		_clean(path.path_join(dir_name))
	DirAccess.remove_absolute(path)


func _write(path: String, bytes: PackedByteArray) -> void:
	DirAccess.make_dir_recursive_absolute(path.get_base_dir())
	var file: FileAccess = FileAccess.open(path, FileAccess.WRITE)
	file.store_buffer(bytes)
	file.close()


## The error code of an RsResourceCache.obtain() result ("" when it worked).
static func _code(result: Dictionary) -> String:
	var error: String = result["error"]
	return Rs2Decoder.code_of(error) if error != "" else ""


func _test_cache(index: Dictionary) -> void:
	_clean(_tmp)
	var store: String = _tmp.path_join("store")
	for hash: String in _payloads:
		_write(store.path_join("sha256").path_join(hash + ".grt"), _payloads[hash])
	var hashes: Array[String] = []
	hashes.assign(_payloads.keys())
	hashes.sort()
	var good: String = hashes[0]

	# fresh refuses a non-empty directory; warm refuses a missing one.
	var dirty: String = _tmp.path_join("dirty")
	_write(dirty.path_join("leftover.txt"), PackedByteArray([1]))
	var refused := RsResourceCache.new()
	_check(Rs2Decoder.code_of(refused.open(dirty, "fresh", store)) == "cache-not-fresh", "fresh refuses a non-empty cache")
	_check(Rs2Decoder.code_of(RsResourceCache.new().open(_tmp.path_join("absent"), "warm", store)) == "cache-not-fresh", "warm refuses a missing cache")

	# A cold process: a miss fetches from the store and writes the cache; a second need is memory.
	var cache_dir: String = _tmp.path_join("cache")
	var cold := RsResourceCache.new()
	_check(cold.open(cache_dir, "fresh", store) == "" and cold.entries_before == 0, "fresh opens an absent cache")
	var first: Dictionary = cold.obtain(good)
	_check(first["error"] == "" and first["source"] == "directory" and first["verified"], "a miss is a verified fetch from the store: %s" % str(first))
	_check(FileAccess.file_exists(cache_dir.path_join("sha256").path_join(good + ".grt")) and cold.entries() == 1, "the fetched payload is in the cache")
	_check(DirAccess.get_files_at(cache_dir.path_join("sha256")).size() == 1, "no temporary file is left behind")
	var again: Dictionary = cold.obtain(good)
	_check(again["source"] == "memory", "a second need in the same process is memory, not a fetch")

	# A warm process hits; ignore-cache fetches anyway.
	var warm := RsResourceCache.new()
	_check(warm.open(cache_dir, "warm", store) == "" and warm.entries_before == 1, "warm opens the existing cache")
	_check(warm.obtain(good)["source"] == "cache", "a warm process reads the cache (a hit)")
	var ignoring := RsResourceCache.new()
	ignoring.ignore_cache = true
	ignoring.open(cache_dir, "warm", store)
	_check(ignoring.obtain(good)["source"] == "directory", "ignore-cache fetches although the cache holds it")

	# Origin failures.
	var other: String = hashes[1]
	var wrong_store: String = _tmp.path_join("wrong-store")
	var corrupted: PackedByteArray = _payloads[other].duplicate()
	corrupted[corrupted.size() - 1] = corrupted[corrupted.size() - 1] ^ 0xFF
	_write(wrong_store.path_join("sha256").path_join(other + ".grt"), corrupted)
	var wrong := RsResourceCache.new()
	wrong.open(_tmp.path_join("cache-wrong"), "fresh", wrong_store)
	var mismatch: Dictionary = wrong.obtain(other)
	_check(_code(mismatch) == "resource-hash-mismatch" and not mismatch["verified"], "a store file that does not hash to its name: %s" % str(mismatch))
	_check(not FileAccess.file_exists(_tmp.path_join("cache-wrong").path_join("sha256").path_join(other + ".grt")), "a mismatched payload is never written to the cache")
	_check(_code(wrong.obtain(good)) == "resource-unavailable", "a hash the store lacks is resource-unavailable")
	# The texture payload format is unchanged at /3 and /4 (render-stream-texture/1): golden-3
	# carries no payload_invalid vectors and golden-4's are GRM1 (mesh) ones, so the undecodable
	# texture payload comes from golden-2's (G4e2, G5d).
	var payload_golden: Dictionary = index
	var payload_dir: String = _golden
	var own_invalid: Array = index.get("payload_invalid", [])
	var own_first: Dictionary = own_invalid[0] if not own_invalid.is_empty() else {}
	var own_file: String = own_first.get("file", "")
	if not own_file.ends_with(".grt"):
		payload_dir = _golden.path_join("../golden-2").simplify_path()
		var json := JSON.new()
		_check(json.parse(FileAccess.get_file_as_string(payload_dir.path_join("index.json"))) == OK, "golden-2/index.json parses")
		payload_golden = json.data
	var invalid_entries: Array = payload_golden["payload_invalid"]
	var invalid_entry: Dictionary = invalid_entries[0]
	var invalid_file: String = invalid_entry["file"]
	var invalid_bytes: PackedByteArray = FileAccess.get_file_as_bytes(payload_dir.path_join(invalid_file))
	_check(not invalid_bytes.is_empty(), "cannot read %s" % payload_dir.path_join(invalid_file))
	var invalid_hash: String = RsTexturePayload.sha256_hex(invalid_bytes)
	_write(wrong_store.path_join("sha256").path_join(invalid_hash + ".grt"), invalid_bytes)
	_check(_code(wrong.obtain(invalid_hash)) == "resource-invalid", "a payload that hashes right but does not decode is resource-invalid")
	var no_store := RsResourceCache.new()
	no_store.open(_tmp.path_join("cache-nostore"), "fresh", "")
	_check(_code(no_store.obtain(good)) == "resource-unavailable", "no store directory: resource-unavailable")
	_clean(_tmp)
	print("[applier2-selftest] cache: fresh/warm/ignore-cache/hash-mismatch/unavailable/invalid as specified")


## G6s (gate6-design.md Q5 "Resource budgets", Q7e): LRU eviction at both layers, needed-set
## protection (never drops a needed hash), no-evict and refetch_after_evict. Texture (GRT1)
## hashes only, named straight from `index["payloads"]` -- `_payloads` also mixes in G5e's GRM1
## mesh surfaces by the same combined dict, which this test's plain RsTexturePayload.decode()
## path (mesh/shader both false) cannot decode.
func _test_cache_budgets(index: Dictionary) -> void:
	_clean(_tmp)
	var store: String = _tmp.path_join("budget-store")
	var texture_entries: Array = index["payloads"]
	var hashes: Array[String] = []
	for value: Variant in texture_entries:
		var entry: Dictionary = value
		hashes.append(entry["hash"])
	hashes.sort()
	_check(hashes.size() >= 4, "the golden texture payload set has at least 4 distinct hashes (got %d)" % hashes.size())
	var h1: String = hashes[0]
	var h2: String = hashes[1]
	var h3: String = hashes[2]
	var h4: String = hashes[3]
	var max_size: int = 0
	for hash: String in [h1, h2, h3, h4]:
		_write(store.path_join("sha256").path_join(hash + ".grt"), _payloads[hash])
		max_size = max(max_size, _payloads[hash].size())
	# Room for exactly one of these four payloads (whichever is largest) plus a little slack, but
	# never two: every assertion below relies on that to predict exactly which hash survives.
	var one_payload_budget: int = max_size + 8

	# Memory: a budget just over one payload's size evicts an older, non-needed hash to make
	# room for a new one, and never a hash the caller just protected with set_needed().
	var cache := RsResourceCache.new()
	cache.open(_tmp.path_join("budget-cache"), "fresh", store)
	cache.obtain(h1)
	cache.memory_budget_bytes = one_payload_budget
	cache.obtain(h2)
	_check(cache.evictions_memory == 1 and not cache.has_in_memory(h1) and cache.has_in_memory(h2),
		"a tight memory budget evicts the older hash (h1), not the one just added (h2)")
	# Needed protection: h2 is needed, so adding h3 (which alone would evict h2 next) must not.
	cache.set_needed([h2])
	cache.obtain(h3)
	_check(cache.evictions_memory == 2 and cache.has_in_memory(h2) and not cache.has_in_memory(h3),
		"set_needed([h2]) protects h2 even past budget: h3 (not needed) is evicted instead")

	# refetch_after_evict counts a genuine re-fetch from the origin, which needs h1 gone from
	# BOTH layers (an eviction from memory alone is just a free disk-cache hit next time).
	var both := RsResourceCache.new()
	both.open(_tmp.path_join("budget-cache-both"), "fresh", store)
	both.memory_budget_bytes = one_payload_budget
	both.cache_budget_bytes = one_payload_budget
	both.obtain(h1)
	both.obtain(h2)  # evicts h1 from memory AND disk: the budget fits only one of each.
	_check(not both.has_in_memory(h1) and not FileAccess.file_exists(_tmp.path_join("budget-cache-both").path_join("sha256").path_join(h1 + ".grt")),
		"h1 is gone from memory and disk alike")
	_check(both.refetch_after_evict == 0, "no refetch yet: h1 has not been asked for again")
	both.obtain(h1)
	_check(both.refetch_after_evict == 1 and both.has_in_memory(h1),
		"obtaining h1 again, with it gone from both layers, counts refetch_after_evict")

	# no-evict (RS_RECEIVER_SABOTAGE=no-evict): the same tight budget, nothing is ever dropped.
	var kept := RsResourceCache.new()
	kept.open(_tmp.path_join("budget-cache-kept"), "fresh", store)
	kept.no_evict = true
	kept.memory_budget_bytes = one_payload_budget
	kept.obtain(h1)
	kept.obtain(h2)
	kept.obtain(h3)
	_check(kept.evictions_memory == 0 and kept.has_in_memory(h1) and kept.has_in_memory(h2) and kept.has_in_memory(h3),
		"no-evict keeps every payload although the budget is exceeded")

	# Disk: a tight cache_budget_bytes (memory budget generous) evicts the oldest file on disk,
	# by access order, once a new one is written past it; set_needed() protects it there too.
	var disk := RsResourceCache.new()
	disk.open(_tmp.path_join("budget-disk"), "fresh", store)
	disk.memory_budget_bytes = 1 << 30
	disk.obtain(h1)
	disk.cache_budget_bytes = one_payload_budget
	disk.obtain(h2)
	var cache_sha: String = _tmp.path_join("budget-disk").path_join("sha256")
	_check(disk.evictions_disk == 1 and not FileAccess.file_exists(cache_sha.path_join(h1 + ".grt")) and
			FileAccess.file_exists(cache_sha.path_join(h2 + ".grt")),
		"a tight disk budget evicts the older file (h1) from the cache directory")
	disk.set_needed([h2])
	disk.obtain(h3)
	_check(disk.evictions_disk == 2 and FileAccess.file_exists(cache_sha.path_join(h2 + ".grt")) and
			not FileAccess.file_exists(cache_sha.path_join(h3 + ".grt")),
		"set_needed([h2]) protects h2's disk file too: h3's is evicted instead")

	# A warm cache's pre-existing files are ordered by mtime for eviction, oldest first.
	var warm_dir: String = _tmp.path_join("budget-warm")
	_write(warm_dir.path_join("sha256").path_join(h1 + ".grt"), _payloads[h1])
	# get_modified_time()'s resolution is whole seconds on common filesystems (ext4 included), so
	# less than that would leave h1 and h2 tied and the eviction order undetermined.
	OS.delay_msec(1100)
	_write(warm_dir.path_join("sha256").path_join(h2 + ".grt"), _payloads[h2])
	var warm := RsResourceCache.new()
	warm.open(warm_dir, "warm", store)
	warm.memory_budget_bytes = 1 << 30
	# Room for exactly two of these payloads: h1, h2 and the newly fetched h4 are three, so
	# exactly one of h1/h2 is evicted -- the older one (h1) by mtime, if the seeding worked.
	warm.cache_budget_bytes = 2 * max_size + 8
	warm.obtain(h4)
	_check(warm.evictions_disk == 1 and not FileAccess.file_exists(warm_dir.path_join("sha256").path_join(h1 + ".grt")) and
			FileAccess.file_exists(warm_dir.path_join("sha256").path_join(h2 + ".grt")) and
			FileAccess.file_exists(warm_dir.path_join("sha256").path_join(h4 + ".grt")),
		"a warm cache evicts its oldest-by-mtime file (h1) first, keeping h2 and the new h4")

	_clean(_tmp)
	print("[applier2-selftest] cache budgets: LRU eviction, needed-set protection, no-evict, refetch_after_evict as specified")


# --------------------------------------------------------------------------- control messages


func _test_control_messages() -> void:
	var stream_id: String = "0123456789abcdef0123456789abcdef"
	var encoded: Dictionary[String, Dictionary] = {
		"hello-submitted": RsLiveClient.hello("gate6-selftest", "submitted", 16777216),
		"hello-applied": RsLiveClient.hello("gate6-selftest-headless", "applied", 65535),
		"ack-received": RsLiveClient.ack(stream_id, 1, "received", 1000),
		"ack-applied": RsLiveClient.ack(stream_id, 1, "applied", 2500),
		"ack-submitted": RsLiveClient.ack(stream_id, 1, "submitted", 4200),
		"resync": RsLiveClient.resync(stream_id, 7, "unapplied-stale"),
	}
	for name: String in encoded:
		var golden: Dictionary = _read_json_in(_golden6, "control/valid/%s.json" % name)
		var text: String = RsLiveClient.encode(encoded[name])
		var json := JSON.new()
		if json.parse(text) != OK or typeof(json.data) != TYPE_DICTIONARY:
			_failures.append("control %s: encode() is not a JSON object: %s" % [name, text])
			continue
		var got: Dictionary = json.data
		_check(got.keys() == golden.keys(), "control %s: keys %s, golden %s" % [name, str(got.keys()), str(golden.keys())])
		_check(JSON.stringify(got) == JSON.stringify(golden), "control %s differs from the golden: %s vs %s" % [name, JSON.stringify(got), JSON.stringify(golden)])
		_check(not text.contains(" "), "control %s is compact: %s" % [name, text])
		_check(not RsLiveClient.parse_host_text(text)["ok"], "parse_host_text refuses a %s message" % name)
	_check(RsLiveClient.SUBPROTOCOL == "render-stream.6" and RsLiveClient.PROTOCOL == "render-stream/6", "the live client speaks render-stream/6")
	var error_text: String = FileAccess.get_file_as_string(_golden6.path_join("control/valid/error-message-too-large.json"))
	var parsed: Dictionary = RsLiveClient.parse_host_text(error_text)
	_check(parsed["ok"] and parsed["reason"] == "message-too-large", "parse_host_text reads the golden error message")
	_check(not RsLiveClient.parse_host_text("not json")["ok"], "parse_host_text refuses non-JSON")

# --------------------------------------------------------------------------- shaders and materials (G55d)


## One comparable row per transaction with the G55d material counters.
static func _row5(result: Dictionary) -> String:
	var stats: Dictionary = result["stats"]
	return _row(result) + str(stats["material_resources"])


static func _mres(stats: Dictionary) -> Dictionary:
	return stats["material_resources"]


## (7) golden-5 through the three encodings: identical stats, and the material work per seq.
func _test_applier_golden5_encodings() -> void:
	var rows_by_file: Dictionary[String, Array] = {}
	for file: String in ["full.rs5", "patch.rs5", "inline.rs5"]:
		var applier: RsApplier = _new_applier()
		var cache: RsResourceCache = _memory_cache(true) if file != "inline.rs5" else RsResourceCache.new()
		var results: Array[Dictionary] = _apply(applier, file, cache)
		var rows: Array[String] = []
		var calls: Array[int] = []
		for result: Dictionary in results:
			var errors: PackedStringArray = result["errors"]
			_check(errors.is_empty(), "%s: %s" % [file, str(errors)])
			if result["kind"] == "transaction":
				rows.append(_row5(result))
				calls.append(result["rs_calls"])
		rows_by_file[file] = rows
		print("[applier2-selftest] %s rs_calls per seq %s" % [file, str(calls)])
		var tx: Array[Dictionary] = _transaction_stats(results)
		if tx.size() != 15:
			_failures.append("%s applied %d transactions, expected 15" % [file, tx.size()])
			_dispose_checked(applier, file)
			continue
		# golden-4's states: unchanged costs (a white canvas modulate is the engine's default: no call).
		_check(calls[5] == 0 and calls[9] == 0, "%s: seq 6 and seq 10 still cost 0 calls: %s" % [file, str(calls)])
		var m1: Dictionary = _mres(tx[0])
		_check(m1["modulate_sets"] == 0 and m1["materials_created"] == 0 and m1["shaders_created"] == 0, "%s seq 1: a white root canvas modulate costs no call, no material work: %s" % [file, str(m1)])
		_check(calls.slice(0, 11) == [74, 1, 1, 2, 2, 0, 16, 24, 18, 0, 27], "%s: golden-5's first eleven seqs cost exactly golden-4's calls: %s" % [file, str(calls)])
		for i: int in range(1, 11):
			var mi: Dictionary = _mres(tx[i])
			var total: int = 0
			for key: String in mi:
				total += Rs2Decoder.as_int(mi[key])
			_check(total == 0, "%s seq %d: golden-4's state makes no material call: %s" % [file, i + 1, str(mi)])
		# seq 12: shader 1 (CIM add) and 2 (tint) created and compiled; materials 1-3 created;
		# material 1's shader 1, material 2's shader 2, material 3 none; 3 + 29 parameters; items
		# 11, 12 and 14 name materials, 13 sets use_parent_material, item 12's two instance
		# parameters; the non-white canvas modulate.
		var m12: Dictionary = _mres(tx[11])
		var want12: Dictionary = {
			"shaders_created": 2, "shader_code_sets": 2, "shaders_freed": 0, "default_texture_sets": 0,
			"materials_created": 3, "materials_freed": 0, "material_shader_sets": 2, "param_sets": 32,
			"instance_param_sets": 2, "material_sets": 3, "use_parent_material_sets": 1,
			"modulate_sets": 1,
		}
		_check(str(m12) == str(want12), "%s seq 12 material work %s, expected %s" % [file, str(m12), str(want12)])
		var set_material_items: Array = []
		for value: Variant in tx[11]["item_calls"]:
			var call: Dictionary = value
			if call["op"] == "set_material":
				set_material_items.append(call["item"])
		_check(set_material_items == [11, 12, 14], "%s seq 12: canvas_item_set_material for items %s, expected [11, 12, 14]" % [file, str(set_material_items)])
		# seq 13: one parameter (p_float 2.5 -> 9.5); seq 14: one code change on the same RID.
		var m13: Dictionary = _mres(tx[12])
		_check(m13["param_sets"] == 1 and m13["materials_created"] == 0 and m13["shader_code_sets"] == 0 and tx[12]["rs_calls"] == 1, "%s seq 13: one material_set_param and nothing else: %s, %d calls" % [file, str(m13), tx[12]["rs_calls"]])
		var calls13: Array = tx[12]["param_calls"]
		var call13: Dictionary = calls13[0] if calls13.size() == 1 else {}
		_check(call13.get("name") == "p_float" and typeof(call13.get("value")) == TYPE_FLOAT and call13.get("value") == 9.5, "%s seq 13: p_float set to 9.5 (float): %s" % [file, str(calls13)])
		var m14: Dictionary = _mres(tx[13])
		_check(m14["shader_code_sets"] == 1 and m14["shaders_created"] == 0 and tx[13]["rs_calls"] == 1, "%s seq 14: one shader_set_code on the same RID: %s, %d calls" % [file, str(m14), tx[13]["rs_calls"]])
		# seq 15: material 4 (shader 3, shader-time, never compiled) created with no shader for item
		# 15; material 5 (param-type) is named by nobody; item 16 (unknown-material) has none.
		var m15: Dictionary = _mres(tx[14])
		_check(m15["shaders_created"] == 0 and m15["materials_created"] == 1 and m15["material_shader_sets"] == 0 and m15["material_sets"] == 1, "%s seq 15: the shader-time shader is never compiled, material 4 is created without it: %s" % [file, str(m15)])
		_check(applier.resident_shaders() == 2 and applier.resident_materials() == 4, "%s: 2 shaders and 4 materials resident at the end, got %d and %d" % [file, applier.resident_shaders(), applier.resident_materials()])
		_dispose_checked(applier, file)
	_check(rows_by_file["full.rs5"] == rows_by_file["patch.rs5"], "golden-5: full and patch per-seq applier stats differ")
	_check(rows_by_file["full.rs5"] == rows_by_file["inline.rs5"], "golden-5: full and inline per-seq applier stats differ")
	# needed() before seq 12: both shader payloads (GRP1) are named, and nothing once resident.
	var probe: RsApplier = _new_applier()
	var data: PackedByteArray = _read_bytes_in(_golden5, "full.rs5")
	var records: Array[Dictionary] = Rs2Decoder.split_records(data, 5)["records"]
	var stream := Rs2Decoder.Stream.new(5)
	var cache: RsResourceCache = _memory_cache(true)
	for raw: Dictionary in records:
		var accepted: Dictionary = RsApplier.accept_record(data, Rs2Decoder.as_int(raw["offset"]), stream)
		if accepted["kind"] == "session":
			var record: Dictionary = accepted["record"]
			var session_meta: Dictionary = record["meta"]
			var session_blocks: Array = record["blocks"]
			probe.begin_session(session_meta, session_blocks)
		elif accepted["kind"] == "transaction":
			var need: Dictionary = probe.needed(stream.items, stream.textures, stream.meshes, stream.shaders, stream.materials)
			var shader_hashes: Array = need["shader_hashes"]
			if stream.last_seq == 12:
				shader_hashes.sort()
				_check(shader_hashes == ["2c874800cd97ba181708fd009b2ec9ab5c49e666c285a39427cf5f8ccf761310", "a8a44694faba8c68274a255d14ebf9a300a51baaa4c15e338ad10df6a58bcd17"], "needed() at seq 12 names both shader payloads: %s" % str(shader_hashes))
			elif stream.last_seq == 14:
				_check(shader_hashes == ["586e44786613868036df5a0a72e1c2a512397d6300502e87d927be6ff7329dbe"], "needed() at seq 14 names only the new code: %s" % str(shader_hashes))
			else:
				_check(shader_hashes.is_empty(), "needed() at seq %d names no shader payload: %s" % [stream.last_seq, str(shader_hashes)])
			probe.apply_state(stream, cache)
	_dispose_checked(probe, "golden-5 needed")


## (7) The exact Variant type and value of every parameter seq 12 sets (D8).
func _test_applier_golden5_variants() -> void:
	var applier: RsApplier = _new_applier()
	var results: Array[Dictionary] = _apply(applier, "full.rs5", _memory_cache(true))
	var tx: Array[Dictionary] = _transaction_stats(results)
	if tx.size() != 15:
		_failures.append("variants: %d transactions" % tx.size())
		return
	var got: Dictionary = {}
	var instance: Dictionary = {}
	for value: Variant in tx[11]["param_calls"]:
		var call: Dictionary = value
		if call["target"] == "material" and call["id"] == 2:
			got[call["name"]] = call["value"]
		elif call["target"] == "instance" and call["id"] == 12:
			instance[call["name"]] = call["value"]
	var want: Dictionary = {
		"p_aabb": AABB(Vector3(1, 2, 3), Vector3(4, 5, 6)),
		"p_basis": Basis.IDENTITY,
		"p_bool": true,
		"p_color": Color(0.2, 0.4, 0.6, 1.0),
		"p_float": 2.5,
		"p_int": 7,
		"p_nil": null,
		"p_packed_color_array": PackedColorArray([Color(0, 0, 0, 1), Color(1, 1, 1, 1)]),
		"p_packed_float32_array": PackedFloat32Array([0.1, 0.2, 0.3]),
		"p_packed_float64_array": PackedFloat64Array([1.5, -1.5]),
		"p_packed_int32_array": PackedInt32Array([1, 2, 3]),
		"p_packed_int64_array": PackedInt64Array([100, 200]),
		"p_packed_vector2_array": PackedVector2Array([Vector2(1, 2), Vector2(3, 4)]),
		"p_packed_vector3_array": PackedVector3Array([Vector3(1, 2, 3), Vector3(4, 5, 6)]),
		"p_packed_vector4_array": PackedVector4Array([Vector4(1, 2, 3, 4)]),
		"p_plane": Plane(0, 0, 1, 5),
		"p_projection": Projection.IDENTITY,
		"p_quaternion": Quaternion(0, 0, 0, 1),
		"p_rect2": Rect2(1, 2, 3, 4),
		"p_rect2i": Rect2i(0, 0, 8, 8),
		"p_transform2d": Transform2D.IDENTITY,
		"p_transform3d": Transform3D.IDENTITY,
		"p_vector2": Vector2(1, 2),
		"p_vector2i": Vector2i(3, 4),
		"p_vector3": Vector3(1, 2, 3),
		"p_vector3i": Vector3i(4, 5, 6),
		"p_vector4": Vector4(1, 2, 3, 4),
		"p_vector4i": Vector4i(5, 6, 7, 8),
	}
	for name: String in want:
		var expected: Variant = want[name]
		var actual: Variant = got.get(name, "<missing>")
		_check(typeof(actual) == typeof(expected) and actual == expected, "seq 12 material 2 %s: %s (%s), expected %s (%s)" % [name, str(actual), type_string(typeof(actual)), str(expected), type_string(typeof(expected))])
	var rid_value: Variant = got.get("p_rid")
	var rid_typed := RID()
	if typeof(rid_value) == TYPE_RID:
		rid_typed = rid_value
	_check(rid_typed.is_valid(), "seq 12 material 2 p_rid is the receiver's RID for texture 7: %s" % str(rid_value))
	_check(got.size() == 29, "seq 12 sets material 2's 29 parameters, got %d" % got.size())
	_check(instance.size() == 2 and typeof(instance.get("glow")) == TYPE_FLOAT and instance.get("glow") == 0.5 and instance.has("hidden_default") and instance["hidden_default"] == null, "seq 12 item 12's instance parameters (glow 0.5, hidden_default null): %s" % str(instance))
	# Member order on non-symmetric values (basis row-major, transform2d columns, projection by
	# column, transform3d basis then origin, plane normal then d, int64 beyond 2^31).
	var basis: Variant = applier._param_variant({"name": "b", "type": "basis", "value": [1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0, 9.0]}, {})
	var basis_typed := Basis()
	if typeof(basis) == TYPE_BASIS:
		basis_typed = basis
	_check(basis_typed.x == Vector3(1, 4, 7) and basis_typed.y == Vector3(2, 5, 8), "basis is row-major: %s" % str(basis))
	var xform: Variant = applier._param_variant({"name": "t", "type": "transform2d", "value": [1.0, 2.0, 3.0, 4.0, 5.0, 6.0]}, {})
	_check(xform == Transform2D(Vector2(1, 2), Vector2(3, 4), Vector2(5, 6)), "transform2d is /0's xform order: %s" % str(xform))
	var xform3: Variant = applier._param_variant({"name": "t", "type": "transform3d", "value": [1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0, 9.0, 10.0, 11.0, 12.0]}, {})
	var xform3_typed := Transform3D()
	if typeof(xform3) == TYPE_TRANSFORM3D:
		xform3_typed = xform3
	_check(xform3_typed.basis.x == Vector3(1, 4, 7) and xform3_typed.origin == Vector3(10, 11, 12), "transform3d is a row-major basis then the origin: %s" % str(xform3))
	var projection: Variant = applier._param_variant({"name": "p", "type": "projection", "value": [1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0, 9.0, 10.0, 11.0, 12.0, 13.0, 14.0, 15.0, 16.0]}, {})
	var projection_typed := Projection()
	if typeof(projection) == TYPE_PROJECTION:
		projection_typed = projection
	_check(projection_typed.y == Vector4(5, 6, 7, 8), "projection is by column: %s" % str(projection))
	# float(int): GDScript's own float-literal parser rounds 16-digit literals; the wire's float64
	# (decode_double) is exact.
	var big: Variant = applier._param_variant({"name": "i", "type": "packed_int64_array", "value": [4294967296.0, float(-9007199254740991)]}, {})
	_check(big == PackedInt64Array([4294967296, -9007199254740991]), "packed_int64_array keeps 53-bit integers: %s" % str(big))
	var tiny: Variant = applier._param_variant({"name": "v", "type": "vector2", "value": [0.1, 0.2]}, {})
	_check(tiny == Vector2(0.1, 0.2), "vector2 narrows to float32 exactly as the engine's Vector2 does: %s" % str(tiny))
	_dispose_checked(applier, "variants")


## (8) The receiver sabotages.
func _test_applier_golden5_sabotages() -> void:
	for sabotage: String in ["ignore-material", "ignore-canvas-modulate", "stale-param"]:
		var applier: RsApplier = _new_applier()
		applier.sabotage_ignore_material = sabotage == "ignore-material"
		applier.sabotage_ignore_canvas_modulate = sabotage == "ignore-canvas-modulate"
		applier.sabotage_stale_param = sabotage == "stale-param"
		var results: Array[Dictionary] = _apply(applier, "full.rs5", _memory_cache(true))
		var tx: Array[Dictionary] = _transaction_stats(results)
		if tx.size() != 15:
			_failures.append("%s: %d transactions" % [sabotage, tx.size()])
			continue
		var material_sets: int = 0
		var modulate_sets: int = 0
		var set_material_calls: int = 0
		for stats: Dictionary in tx:
			var m: Dictionary = _mres(stats)
			material_sets += Rs2Decoder.as_int(m["material_sets"])
			modulate_sets += Rs2Decoder.as_int(m["modulate_sets"])
			for value: Variant in stats["item_calls"]:
				var call: Dictionary = value
				if call["op"] == "set_material":
					set_material_calls += 1
		match sabotage:
			"ignore-material":
				_check(material_sets == 0 and set_material_calls == 0 and modulate_sets == 1, "ignore-material: no canvas_item_set_material (%d, %d), modulate untouched (%d)" % [material_sets, set_material_calls, modulate_sets])
			"ignore-canvas-modulate":
				_check(modulate_sets == 0 and material_sets == 4, "ignore-canvas-modulate: no canvas_set_modulate (%d), materials untouched (%d)" % [modulate_sets, material_sets])
			"stale-param":
				var m12: Dictionary = _mres(tx[11])
				var m13: Dictionary = _mres(tx[12])
				_check(m12["param_sets"] == 32 and m13["param_sets"] == 0 and tx[12]["rs_calls"] == 0, "stale-param: parameters at creation only (seq 12 %s, seq 13 %s)" % [str(m12["param_sets"]), str(m13["param_sets"])])
		_dispose_checked(applier, sabotage)


## (9) params.rs5: the withheld shader without and with RS_RECEIVER_SHADER_LIBRARY.
func _test_applier_withheld() -> void:
	var withheld_hash: String = "2c874800cd97ba181708fd009b2ec9ab5c49e666c285a39427cf5f8ccf761310"
	var library: String = _tmp.path_join("shader-library")
	_clean(library)
	_write(library.path_join("sha256").path_join(withheld_hash + ".grp"), _payloads5[withheld_hash])
	var wrong_library: String = _tmp.path_join("shader-library-wrong")
	_clean(wrong_library)
	var tampered: PackedByteArray = _payloads5[withheld_hash].duplicate()
	tampered[tampered.size() - 2] = tampered[tampered.size() - 2] ^ 0x01
	_write(wrong_library.path_join("sha256").path_join(withheld_hash + ".grp"), tampered)
	for library_dir: String in ["", wrong_library, library]:
		var applier: RsApplier = _new_applier()
		# The memory cache holds every golden payload, the withheld code included: the applier must
		# still never take a withheld shader's code from anywhere but the library.
		var cache: RsResourceCache = _memory_cache(true)
		cache.library_dir = library_dir
		var results: Array[Dictionary] = _apply(applier, "params.rs5", cache)
		var tx: Array[Dictionary] = _transaction_stats(results)
		var what: String = "params.rs5 (library %s)" % (library_dir if library_dir != "" else "<unset>")
		if tx.size() != 1:
			_failures.append("%s: %d transactions" % [what, tx.size()])
			continue
		var skipped: Array = tx[0]["skipped_shaders"]
		var m: Dictionary = _mres(tx[0])
		if library_dir == library:
			_check(skipped.is_empty() and m["shaders_created"] == 2 and m["shader_code_sets"] == 2 and m["material_shader_sets"] == 2 and applier.resident_shaders() == 2, "%s: the withheld shader is compiled from the library: %s %s" % [what, str(skipped), str(m)])
		else:
			var first: Dictionary = skipped[0] if skipped.size() == 1 else {}
			_check(first.get("id") == 2 and first.get("reason") == "shader-withheld" and first.get("hash") == withheld_hash, "%s: the withheld shader is skipped as shader-withheld: %s" % [what, str(skipped)])
			_check(m["shaders_created"] == 1 and m["materials_created"] == 2 and m["material_shader_sets"] == 1 and applier.resident_shaders() == 1, "%s: only the CIM shader is compiled; material 2 has no shader: %s" % [what, str(m)])
		_dispose_checked(applier, what)
	_clean(library)
	_clean(wrong_library)


## A hand-built /5 item naming `material` with `instance_params`.
static func _material_item(id: int, material: Variant, instance_params: Array, use_parent: bool = false) -> Dictionary:
	var item: Dictionary = _clip_test_item(id)
	item["clip"] = false
	item["material"] = material
	item["use_parent_material"] = use_parent
	item["instance_params"] = instance_params
	return item


static func _shader_entry(id: int, version: int, hash: Variant, defaults: Array, status: String = "ok", source: Variant = "payload") -> Dictionary:
	return {
		"id": id, "origin": "created", "status": status, "reason": null if status == "ok" else "shader-time",
		"version": version, "mode": "canvas_item", "source": source, "hash": hash,
		"payload_bytes": 0, "builtin": null, "uses": [], "default_textures": defaults,
	}


static func _material_entry(id: int, version: int, shader: Variant, params: Array, status: String = "ok") -> Dictionary:
	return {
		"id": id, "origin": "created", "status": status, "reason": null if status == "ok" else "param-type",
		"version": version, "shader": shader, "params": params,
	}


## (10) Hand-built lifetimes: default textures, removed parameters and instance parameters,
## freed materials and shaders, an unsupported material, a codeless shader.
func _test_applier_material_lifetimes() -> void:
	var tint_v1: String = "2c874800cd97ba181708fd009b2ec9ab5c49e666c285a39427cf5f8ccf761310"
	var cache: RsResourceCache = _memory_cache(true)
	var image_hash: String = "e65a0caf1a46175e39e501f3000016c9b56958648fda140874f93c9fcbd03fa9"
	var decoded: Dictionary = cache.decoded(image_hash)
	var image_entry: Dictionary = {
		"id": 1, "kind": "image", "status": "ok", "hash": image_hash, "format": decoded["format"],
		"width": decoded["width"], "height": decoded["height"], "mipmaps": decoded["mipmaps"],
		"payload_bytes": 0, "canvas": null, "version": 1,
	}
	var applier: RsApplier = _new_applier()
	var stream := Rs2Decoder.Stream.new(5)
	stream.canvases = {1: {"items": [50, 51], "xform": [1.0, 0.0, 0.0, 1.0, 0.0, 0.0], "modulate": [1.0, 1.0, 1.0, 1.0]}}
	stream.textures = {1: image_entry}
	stream.shaders = {
		1: _shader_entry(1, 1, tint_v1, [{"name": "tex", "index": 0, "tex": 1}]),
		2: _shader_entry(2, 1, null, [], "ok", null),
	}
	stream.materials = {
		1: _material_entry(1, 1, 1, [{"name": "a", "type": "float", "value": 1.0}, {"name": "t", "type": "rid", "value": {"tex": 1}}]),
		2: _material_entry(2, 1, 2, []),
		3: _material_entry(3, 1, null, [], "unsupported"),
	}
	stream.items = {
		50: _material_item(50, 1, [{"name": "glow", "type": "float", "value": 0.5}]),
		51: _material_item(51, 3, [], true),
	}
	var need: Dictionary = applier.needed(stream.items, stream.textures, stream.meshes, stream.shaders, stream.materials)
	_check(need["ids"] == [1] and need["shader_hashes"] == [tint_v1], "lifetimes: the parameter/default texture and the named shader's code are needed: %s" % str(need))
	var r1: Dictionary = applier.apply_state(stream, cache)
	var m1: Dictionary = _mres(r1)
	_check(m1["shaders_created"] == 1 and m1["materials_created"] == 1 and m1["default_texture_sets"] == 1 and m1["param_sets"] == 2 and m1["instance_param_sets"] == 1 and m1["use_parent_material_sets"] == 1 and m1["material_sets"] == 1 and m1["modulate_sets"] == 0, "lifetimes setup: %s" % str(m1))
	_check(_named_unsupported(r1) == [[51, "canvas_item_set_material", "unsupported-material"]], "lifetimes: the unsupported material is never created, its item recorded: %s" % str(_named_unsupported(r1)))
	_check(applier.resident_shaders() == 1 and applier.resident_materials() == 1 and applier.resident_textures() == 1, "lifetimes: shader 2 and material 2 (named by nobody) are not resident")
	var t_call: Variant = null
	for value: Variant in r1["param_calls"]:
		var call: Dictionary = value
		if call["name"] == "t":
			t_call = call["value"]
	var t_rid := RID()
	if typeof(t_call) == TYPE_RID:
		t_rid = t_call
	_check(t_rid.is_valid(), "lifetimes: the rid parameter is the resident texture's RID: %s" % str(t_call))
	# Unchanged: no call at all.
	var before: int = applier.rs_calls
	applier.apply_state(stream, cache)
	_check(applier.rs_calls == before, "lifetimes: an unchanged state makes no call (%d)" % (applier.rs_calls - before))
	# Remove the default texture, parameter `a` and the instance parameter; item 51 names material 2
	# (a codeless shader): shader_create alone, then the material with it.
	stream.shaders = {1: _shader_entry(1, 2, tint_v1, []), 2: _shader_entry(2, 1, null, [], "ok", null)}
	stream.materials = {
		1: _material_entry(1, 2, 1, [{"name": "t", "type": "rid", "value": {"tex": 1}}]),
		2: _material_entry(2, 1, 2, []),
	}
	stream.items = {50: _material_item(50, 1, []), 51: _material_item(51, 2, [], true)}
	var r2: Dictionary = applier.apply_state(stream, cache)
	var m2: Dictionary = _mres(r2)
	_check(m2["default_texture_sets"] == 1 and m2["param_sets"] == 1 and m2["instance_param_sets"] == 1 and m2["shaders_created"] == 1 and m2["shader_code_sets"] == 0 and m2["materials_created"] == 1 and m2["material_shader_sets"] == 1 and m2["material_sets"] == 1, "lifetimes removals and a codeless shader: %s" % str(m2))
	var nulls: Array = []
	for value: Variant in r2["param_calls"]:
		var call: Dictionary = value
		nulls.append([call["target"], call["name"], call["value"]])
	_check(nulls == [["material", "a", null], ["instance", "glow", null]], "lifetimes: removed parameters are set to null: %s" % str(nulls))
	# Material 1 and shader 1 leave the tables (D5): both freed, item 50's material reset to none.
	stream.shaders = {2: _shader_entry(2, 1, null, [], "ok", null)}
	stream.materials = {2: _material_entry(2, 1, 2, [])}
	stream.items = {50: _material_item(50, null, []), 51: _material_item(51, 2, [], true)}
	var r3: Dictionary = applier.apply_state(stream, cache)
	var m3: Dictionary = _mres(r3)
	_check(m3["materials_freed"] == 1 and m3["shaders_freed"] == 1 and m3["material_sets"] == 1 and _item_ops(r3["item_calls"], 50) == ["set_material"], "lifetimes: removed material and shader freed, item 50 reset: %s %s" % [str(m3), str(_item_ops(r3["item_calls"], 50))])
	# The shader becomes unsupported: freed, the material's shader reset to none.
	stream.shaders = {2: _shader_entry(2, 2, null, [], "unsupported", null)}
	var r4: Dictionary = applier.apply_state(stream, cache)
	var m4: Dictionary = _mres(r4)
	_check(m4["shaders_freed"] == 1 and m4["material_shader_sets"] == 1 and applier.resident_shaders() == 0, "lifetimes: an unsupported shader is freed and unset: %s" % str(m4))
	_dispose_checked(applier, "material lifetimes")


# --------------------------------------------------------------------------- canvases (G6b)


## A cache holding golden-6's payloads in memory.
func _memory_cache6() -> RsResourceCache:
	var cache := RsResourceCache.new()
	for hash: String in _payloads6:
		_check(cache.add_inline(hash, _payloads6[hash]) == "", "golden-6 payload %s decodes" % hash)
	return cache


static func _cres(result: Dictionary) -> Dictionary:
	var stats: Dictionary = result["stats"]
	return stats["canvas_resources"]


## (10) golden-6 (render-stream/6, gate6-design.md Q5): the three encodings give identical stats;
## states 16-19's extra canvas is created, attached, stacked, re-stacked, removed and re-attached
## with a second canvas at the same key, each counted once; ignore-canvas-stacking never stacks.
func _test_applier_golden6_canvases() -> void:
	var rows: Dictionary[String, Array] = {}
	for file: String in ["full.rs6", "patch.rs6", "inline.rs6"]:
		var applier: RsApplier = _new_applier()
		var cache: RsResourceCache = _memory_cache6() if file != "inline.rs6" else RsResourceCache.new()
		var results: Array[Dictionary] = _apply(applier, file, cache)
		var file_rows: Array = []
		var counters: Array = []
		for result: Dictionary in results:
			var errors: PackedStringArray = result["errors"]
			_check(errors.is_empty(), "%s: a record is rejected: %s" % [file, str(errors)])
			if result["kind"] == "transaction":
				file_rows.append(_row(result) + str(_cres(result)))
				var c: Dictionary = _cres(result)
				counters.append([c["canvases_created"], c["canvas_attach"], c["canvas_stacking_sets"]])
		rows[file] = file_rows
		# seq 16: canvas 2 created, attached and stacked at layer 1; 17: re-stacked at -1; 18:
		# removed; 19: canvas 2 re-attached (stacking reset, then 2) and canvas 3 created, attached
		# and stacked at the same key.
		var want: Array = [[1, 1, 1], [0, 0, 1], [0, 1, 0], [1, 2, 2]]
		_check(counters.size() == 19 and counters.slice(15, 19) == want and counters.slice(0, 15).all(func(c: Array) -> bool: return c == [0, 0, 0]),
			"%s: canvas counters per seq %s, want zeros through seq 15 then %s" % [file, str(counters), str(want)])
		_dispose_checked(applier, "golden-6 %s" % file)
	_check(rows["full.rs6"] == rows["patch.rs6"], "golden-6: full and patch per-seq applier stats differ")
	_check(rows["full.rs6"] == rows["inline.rs6"], "golden-6: full and inline per-seq applier stats differ")

	var sabotaged: RsApplier = _new_applier()
	sabotaged.sabotage_ignore_canvas_stacking = true
	var sabotaged_results: Array[Dictionary] = _apply(sabotaged, "full.rs6", _memory_cache6())
	var stacking: int = 0
	var attaches: int = 0
	for result: Dictionary in sabotaged_results:
		if result["kind"] == "transaction":
			stacking += Rs2Decoder.as_int(_cres(result)["canvas_stacking_sets"])
			attaches += Rs2Decoder.as_int(_cres(result)["canvas_attach"])
	_check(stacking == 0 and attaches == 4, "ignore-canvas-stacking: %d stacking calls (want 0), %d attach/remove calls (want 4)" % [stacking, attaches])
	_dispose_checked(sabotaged, "golden-6 ignore-canvas-stacking")
