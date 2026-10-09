extends SceneTree
## RsApplier / RsResourceCache / RsLiveClient self-test against the shared golden vectors
## (protocol/golden-2/; gate2-design.md "G2b2").
##
##   godot --headless --path receiver --script res://tests/applier2_selftest.gd
##
## RS_SELFTEST_GOLDEN_DIR overrides the golden directory (default <receiver>/../protocol/golden-2).
## RS_SELFTEST_TMP_DIR is an absolute scratch directory for the cache tests (default
## user://applier2-selftest). Prints "[applier2-selftest] ok" and quits 0, or prints each
## failure and quits 1.
##
## The applier, through the receiver's exact path (accept_record, then every payload the resolved
## state needs made available, then apply_state):
##   1. full.rs2, patch.rs2 and inline.rs2, each through a fresh applier, produce identical
##      per-seq stats (rs_calls, created, freed, reparented, commands_replayed, unsupported
##      commands, texture created/updated/replaced/freed/upload_bytes/skipped_commands): the
##      receiver's work does not depend on encoding or delivery. seq 6 equals seq 5 and costs 0
##      calls; dispose() frees exactly the RIDs the applier still owned.
##   2. The texture rules (D5, D10, D11) on the goldens' content: seq 1 makes resident only the
##      ok images and placeholders a command names (A1 once for ids 1 and 2... only id 1 is drawn;
##      F), skips the unknown-texture and unsupported-texture commands; seq 3's new hash is one
##      texture_2d_update; seq 4 frees F's RID when it becomes a tombstone; nothing is uploaded
##      twice for the same hash.
##   3. The reupload sabotage uploads every resident image at every applied transaction.
##   4. A reconnect: one applier replays full.rs2, is disposed, and replays patch.rs2 exactly like
##      a fresh one.
## The cache (RsResourceCache):
##   5. fresh refuses a non-empty directory (cache-not-fresh), warm refuses a missing one; a miss
##      fetches from the store, verifies, writes the cache (temp + rename) and keeps it in memory;
##      a new process in warm mode hits; ignore-cache fetches anyway; a wrong-hash store file is
##      resource-hash-mismatch, a missing one resource-unavailable, an undecodable one
##      resource-invalid.
## The live control messages (RsLiveClient):
##   6. hello (render-stream/2), ack and resync encode to exactly the golden control/valid/*.json
##      messages, and parse_host_text accepts the golden error message and nothing else.

var _failures: Array[String] = []
var _golden: String = ""
var _tmp: String = ""
var _payloads: Dictionary[String, PackedByteArray] = {}


func _initialize() -> void:
	_golden = OS.get_environment("RS_SELFTEST_GOLDEN_DIR")
	if _golden == "":
		_golden = ProjectSettings.globalize_path("res://").path_join("../protocol/golden-2").simplify_path()
	_tmp = OS.get_environment("RS_SELFTEST_TMP_DIR")
	if _tmp == "":
		_tmp = ProjectSettings.globalize_path("user://applier2-selftest")
	print("[applier2-selftest] golden %s, scratch %s" % [_golden, _tmp])
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
	_test_control_messages()
	_test_cache(index)
	# The root canvas is attached to the root viewport only from the first frame on (SceneTree
	# calls MainLoop::initialize before root->_set_tree); the applier tests need it.
	process_frame.connect(_run_applier_tests, CONNECT_ONE_SHOT)


func _run_applier_tests() -> void:
	_test_applier_encodings()
	_test_applier_textures()
	_test_applier_reupload()
	_test_applier_reconnect()
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
	var path: String = _golden.path_join(relative)
	var data: PackedByteArray = FileAccess.get_file_as_bytes(path)
	_check(not data.is_empty(), "cannot read %s" % path)
	return data


func _read_json(relative: String) -> Dictionary:
	var path: String = _golden.path_join(relative)
	var json := JSON.new()
	if json.parse(FileAccess.get_file_as_string(path)) != OK or typeof(json.data) != TYPE_DICTIONARY:
		_failures.append("cannot parse %s" % path)
		return {}
	return json.data


# --------------------------------------------------------------------------- applier


func _new_applier() -> RsApplier:
	return RsApplier.new(root.get_viewport_rid(), root.find_world_2d().canvas)


## A cache holding every golden payload in memory (as inline records or earlier fetches would).
func _memory_cache() -> RsResourceCache:
	var cache := RsResourceCache.new()
	for hash: String in _payloads:
		_check(cache.add_inline(hash, _payloads[hash]) == "", "golden payload %s decodes" % hash)
	return cache


## Runs one recording through `applier` record by record, as receiver.gd does. Returns one row per
## record: {kind, errors, rs_calls (that record's own), stats}.
func _apply(applier: RsApplier, file: String, cache: RsResourceCache) -> Array[Dictionary]:
	var data: PackedByteArray = _read_bytes(file)
	var records: Array[Dictionary] = Rs2Decoder.split_records(data)["records"]
	var stream := Rs2Decoder.Stream.new()
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
					var need: Dictionary = applier.needed(stream.items, stream.textures)
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
	for file: String in ["full.rs2", "patch.rs2", "inline.rs2"]:
		var applier: RsApplier = _new_applier()
		var cache: RsResourceCache = _memory_cache() if file != "inline.rs2" else RsResourceCache.new()
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
		_check(calls.size() == 6 and calls[0] > 0 and calls[5] == 0, "%s: rs_calls per seq %s (seq 1 > 0, seq 6 == seq 5's state: 0)" % [file, str(calls)])
		print("[applier2-selftest] %s rs_calls per seq %s" % [file, str(calls)])
		_dispose_checked(applier, file)
	_check(rows_by_file["full.rs2"] == rows_by_file["patch.rs2"], "full and patch per-seq applier stats differ")
	_check(rows_by_file["full.rs2"] == rows_by_file["inline.rs2"], "full and inline per-seq applier stats differ")


func _test_applier_textures() -> void:
	var applier: RsApplier = _new_applier()
	var results: Array[Dictionary] = _apply(applier, "full.rs2", _memory_cache())
	var tx: Array[Dictionary] = []
	for result: Dictionary in results:
		if result["kind"] == "transaction":
			var stats: Dictionary = result["stats"]
			tx.append(stats)
	if tx.size() != 6:
		_failures.append("full.rs2 applied %d transactions" % tx.size())
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
	_check(applier.resident_textures() == 1, "after seq 6 one texture (A) is resident, got %d" % applier.resident_textures())
	_dispose_checked(applier, "textures")


func _test_applier_reupload() -> void:
	var applier: RsApplier = _new_applier()
	applier.sabotage_reupload = true
	var results: Array[Dictionary] = _apply(applier, "full.rs2", _memory_cache())
	var uploads: int = 0
	for result: Dictionary in results:
		if result["kind"] == "transaction":
			var stats: Dictionary = result["stats"]
			var list: Array = stats["uploads"]
			uploads += list.size()
	# seq 1: A, F; seq 2-3: A, F again; seq 4-6: A only (F is a tombstone).
	_check(uploads == 2 + 2 + 2 + 1 + 1 + 1, "the reupload sabotage uploaded %d times" % uploads)
	_dispose_checked(applier, "reupload")


func _test_applier_reconnect() -> void:
	var fresh_applier: RsApplier = _new_applier()
	var fresh: Array[Dictionary] = _apply(fresh_applier, "patch.rs2", _memory_cache())
	_dispose_checked(fresh_applier, "reconnect fresh")
	var applier: RsApplier = _new_applier()
	_apply(applier, "full.rs2", _memory_cache())
	_dispose_checked(applier, "reconnect first session")
	var second: Array[Dictionary] = _apply(applier, "patch.rs2", _memory_cache())
	var a: Array[int] = []
	var b: Array[int] = []
	for row: Dictionary in fresh:
		a.append(row["rs_calls"])
	for row: Dictionary in second:
		b.append(row["rs_calls"])
	_check(a == b, "reconnect: the second session cost %s RS calls per record, a fresh applier %s" % [str(b), str(a)])
	_dispose_checked(applier, "reconnect second session", true)


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
	var invalid_entries: Array = index["payload_invalid"]
	var invalid_entry: Dictionary = invalid_entries[0]
	var invalid_file: String = invalid_entry["file"]
	var invalid_bytes: PackedByteArray = _read_bytes(invalid_file)
	var invalid_hash: String = RsTexturePayload.sha256_hex(invalid_bytes)
	_write(wrong_store.path_join("sha256").path_join(invalid_hash + ".grt"), invalid_bytes)
	_check(_code(wrong.obtain(invalid_hash)) == "resource-invalid", "a payload that hashes right but does not decode is resource-invalid")
	var no_store := RsResourceCache.new()
	no_store.open(_tmp.path_join("cache-nostore"), "fresh", "")
	_check(_code(no_store.obtain(good)) == "resource-unavailable", "no store directory: resource-unavailable")
	_clean(_tmp)
	print("[applier2-selftest] cache: fresh/warm/ignore-cache/hash-mismatch/unavailable/invalid as specified")


# --------------------------------------------------------------------------- control messages


func _test_control_messages() -> void:
	var stream_id: String = "0123456789abcdef0123456789abcdef"
	var encoded: Dictionary[String, Dictionary] = {
		"hello-submitted": RsLiveClient.hello("gate2-selftest", "submitted", 16777216),
		"hello-applied": RsLiveClient.hello("gate2-selftest-headless", "applied", 65535),
		"ack-received": RsLiveClient.ack(stream_id, 1, "received", 1000),
		"ack-applied": RsLiveClient.ack(stream_id, 1, "applied", 2500),
		"ack-submitted": RsLiveClient.ack(stream_id, 1, "submitted", 4200),
		"resync": RsLiveClient.resync(stream_id, 6, "unapplied-stale"),
	}
	for name: String in encoded:
		var golden: Dictionary = _read_json("control/valid/%s.json" % name)
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
	_check(RsLiveClient.SUBPROTOCOL == "render-stream.2" and RsLiveClient.PROTOCOL == "render-stream/2", "the live client speaks render-stream/2")
	var error_text: String = FileAccess.get_file_as_string(_golden.path_join("control/valid/error-message-too-large.json"))
	var parsed: Dictionary = RsLiveClient.parse_host_text(error_text)
	_check(parsed["ok"] and parsed["reason"] == "message-too-large", "parse_host_text reads the golden error message")
	_check(not RsLiveClient.parse_host_text("not json")["ok"], "parse_host_text refuses non-JSON")
