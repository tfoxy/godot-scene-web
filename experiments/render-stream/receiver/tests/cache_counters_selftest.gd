extends SceneTree
## Disk counters match a real scan after every mutation, and getters never inspect the disk.

class ShortWriteCache extends RsResourceCache:
	var truncate_to: int = -1

	func _staged_bytes(path: String) -> int:
		if truncate_to >= 0:
			var payload: PackedByteArray = FileAccess.get_file_as_bytes(path)
			var file: FileAccess = FileAccess.open(path, FileAccess.WRITE)
			file.store_buffer(payload.slice(0, truncate_to))
			file.close()
		return FileAccess.get_size(path)

var _checks: int = 0
var _failed: int = 0


func _initialize() -> void:
	_run.call_deferred()


func _check(label: String, ok: bool) -> void:
	_checks += 1
	if not ok:
		_failed += 1
		print("[cache-counters-selftest] FAIL: " + label)


func _scan(cache: RsResourceCache) -> void:
	var entries: int = 0
	var bytes: int = 0
	for name: String in DirAccess.get_files_at(cache.dir.path_join("sha256")):
		if not RsResourceCache._is_payload_file(name):
			continue
		entries += 1
		var file: FileAccess = FileAccess.open(cache.dir.path_join("sha256").path_join(name), FileAccess.READ)
		bytes += file.get_length()
		file.close()
	_check("entries equal scan", cache.entries() == entries)
	_check("bytes equal scan", cache.bytes() == bytes)


func _run() -> void:
	var base: String = ProjectSettings.globalize_path("res://../../../.local/cache-counters-%d" % OS.get_process_id())
	DirAccess.make_dir_recursive_absolute(base.path_join("sha256"))
	for name: String in ["a.grt", "b.grm", "c.grp", "d.ktx2", ".ignored.tmp", "ignored.txt"]:
		var file: FileAccess = FileAccess.open(base.path_join("sha256").path_join(name), FileAccess.WRITE)
		file.store_buffer(PackedByteArray([1, 2, 3]))
		file.close()
	var cache := ShortWriteCache.new()
	cache.dir = base
	cache.mode = "warm"
	_check("warm open", cache.open(base, "warm", "") == "")
	_check("warm entries_before", cache.entries_before == 4)
	_scan(cache)
	var payload: PackedByteArray = PackedByteArray([1, 2, 3, 4, 5])
	var hash: String = RsWire.sha256_hex(payload)
	_check("fetched add", cache.add_fetched(hash, payload, "selftest") == "")
	_scan(cache)
	_check("same-hash replacement", cache.add_fetched(hash, payload, "selftest") == "")
	_scan(cache)
	# Exercise changed-length replacement accounting directly (normal fetches verify hashes).
	_check("replace different length", cache._write_cache(hash, PackedByteArray([9])) == "")
	_scan(cache)
	cache.cache_budget_bytes = 1
	cache.set_needed([hash])
	cache._evict_disk_over_budget()
	_check("evicted all unneeded payloads", cache.evictions_disk == 4)
	_scan(cache)
	cache.set_needed([])
	cache.cache_budget_bytes = 0
	_check("another add", cache.add_fetched("payload".sha256_text(), "payload".to_utf8_buffer(), "selftest") == "")
	_scan(cache)
	cache.cache_budget_bytes = 1
	cache._evict_disk_over_budget()
	_scan(cache)
	_check("empty after eviction", cache.entries() == 0 and cache.bytes() == 0)
	cache.cache_budget_bytes = 0
	cache.truncate_to = 2
	_check("short disk write preserves success", cache.add_fetched(hash, payload, "selftest") == "")
	_scan(cache)
	_check("short disk write keeps complete payload in memory", cache.raw(hash) == payload)
	_check("short payload stored", FileAccess.get_size(base.path_join("sha256").path_join(hash + ".grt")) == 2)
	cache.truncate_to = 0
	_check("empty replacement preserves success", cache.add_fetched(hash, payload, "selftest") == "")
	_scan(cache)
	_check("empty replacement keeps complete payload in memory", cache.raw(hash) == payload)
	_check("empty replacement counted", cache.entries() == 1 and cache.bytes() == 0)
	cache.truncate_to = -1
	_check("add before detached getter check", cache.add_fetched(hash, payload, "selftest") == "")
	_check("detach cache directory", DirAccess.rename_absolute(base, base + "-detached") == OK)
	_check("getters retain totals without disk", cache.entries() == 1 and cache.bytes() == payload.size())
	DirAccess.rename_absolute(base + "-detached", base)
	for name: String in DirAccess.get_files_at(base.path_join("sha256")):
		DirAccess.remove_absolute(base.path_join("sha256").path_join(name))
	DirAccess.remove_absolute(base.path_join("sha256"))
	DirAccess.remove_absolute(base)
	if _failed == 0:
		print("[cache-counters-selftest] ok (%d checks)" % _checks)
	else:
		print("[cache-counters-selftest] %d checks, %d failed" % [_checks, _failed])
	quit(0 if _failed == 0 else 1)
