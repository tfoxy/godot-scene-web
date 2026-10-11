class_name RsResourceCache
extends RefCounted
## The receiver's payload sources (gate2-design.md D8, Q5 "Apply order per transaction", G2b2):
## an in-memory map of verified payloads (inline resource records and every payload this process
## already obtained), the content-addressed cache directory RS_RECEIVER_CACHE_DIR
## (`sha256/<hash>.grt`), and, in file mode, the capture's store directory RS_RECEIVER_STORE_DIR
## as the origin for `fetch: "directory"` (reading from it counts as a fetch). In live mode the
## origin is HTTP (G2c2): RsResourceFetcher gets the bytes, add_fetched() verifies, decodes and
## caches them exactly as the directory branch of obtain() does.
##
## Every payload is verified against its name (SHA-256) before it is used and before it is
## written to the cache, and decoded (RsTexturePayload) before it is used. A payload this process
## obtained once is never read again from the cache or the origin. Fetched payloads are written to
## the cache with a temporary file and a rename; inline ones are not (the cache holds exactly what
## was fetched). Nothing here touches the RenderingServer.
##
## Errors are render-stream "<code>: <detail>" strings with the gate 2 replay-failure codes:
## resource-unavailable, resource-hash-mismatch, resource-invalid, cache-not-fresh.
##
## Since G5e (render-stream-4.md "Mesh payload") the same cache holds render-stream-mesh/1 (GRM1)
## surface payloads: their files are `sha256/<hash>.grm` (here and in the store), the callers say
## which kind a hash is (`mesh`), and a payload is decoded by its own magic (RsMeshPayload for
## GRM1, RsTexturePayload otherwise), so decoded() returns the matching shape.
##
## Since G55d (render-stream-5.md "Shader payload", gate5_5-design.md Q5) it also holds
## render-stream-shader/1 (GRP1) code payloads: `sha256/<hash>.grp`, the callers say a hash is a
## shader (`shader`), and decoded() returns RsShaderPayload.decode()'s {ok, code_bytes, code}.
## `library_dir` (RS_RECEIVER_SHADER_LIBRARY, D4) is the operator-local library a `withheld`
## shader's code comes from: library_code() reads `<library>/sha256/<hash>.grp`, verifies it
## against its name and decodes it. A library read is never a fetch and never written to the cache.

const CACHE_SUBDIR: String = "sha256"

var dir: String = ""
var mode: String = "fresh"
var store_dir: String = ""
## RS_RECEIVER_SHADER_LIBRARY (G55d): the operator-local GRP1 library for `withheld` shaders.
var library_dir: String = ""
## RS_RECEIVER_SABOTAGE=ignore-cache: a cache hit is fetched from the origin anyway.
var ignore_cache: bool = false
var entries_before: int = 0
## hash -> decoded payload ({format, width, height, mipmaps, data} for a texture, RsMeshPayload's
## decode() for a mesh surface, RsShaderPayload's decode() for shader code), verified.
var _memory: Dictionary[String, Dictionary] = {}
## hash -> the raw payload length, for the same entries.
var _lengths: Dictionary[String, int] = {}


## Opens the cache directory. `cache_mode` is fresh (the directory must be absent or empty; it is
## created) or warm (it must exist). Returns "" or an error string (cache-not-fresh,
## resource-unavailable for a warm cache that is missing).
func open(cache_dir: String, cache_mode: String, origin_dir: String) -> String:
	dir = cache_dir
	mode = cache_mode
	store_dir = origin_dir
	if dir == "":
		return ""
	if mode == "fresh":
		if DirAccess.dir_exists_absolute(dir) and _has_any_entry(dir):
			return Rs2Decoder.err("cache-not-fresh", "RS_RECEIVER_CACHE_DIR %s is not empty (mode fresh)" % dir)
	elif not DirAccess.dir_exists_absolute(dir):
		return Rs2Decoder.err("cache-not-fresh", "RS_RECEIVER_CACHE_DIR %s does not exist (mode warm)" % dir)
	var made: Error = DirAccess.make_dir_recursive_absolute(dir.path_join(CACHE_SUBDIR))
	if made != OK:
		return Rs2Decoder.err("resource-unavailable", "cannot create %s: %s" % [dir.path_join(CACHE_SUBDIR), error_string(made)])
	entries_before = entries()
	return ""


static func _has_any_entry(path: String) -> bool:
	var listing: DirAccess = DirAccess.open(path)
	if listing == null:
		return false
	listing.include_hidden = true
	return listing.get_files().size() > 0 or listing.get_directories().size() > 0


## The number of `.grt`, (G5e) `.grm` and (G55d) `.grp` files in the cache.
func entries() -> int:
	if dir == "":
		return 0
	var count: int = 0
	for file_name: String in DirAccess.get_files_at(dir.path_join(CACHE_SUBDIR)):
		if _is_payload_file(file_name):
			count += 1
	return count


## The total size of the cache's `.grt`, `.grm` and `.grp` files.
func bytes() -> int:
	if dir == "":
		return 0
	var total: int = 0
	var base: String = dir.path_join(CACHE_SUBDIR)
	for file_name: String in DirAccess.get_files_at(base):
		if not _is_payload_file(file_name):
			continue
		var file: FileAccess = FileAccess.open(base.path_join(file_name), FileAccess.READ)
		if file != null:
			total += file.get_length()
			file.close()
	return total


static func _is_payload_file(file_name: String) -> bool:
	return file_name.ends_with(".grt") or file_name.ends_with(".grm") or file_name.ends_with(".grp")


## Whether a verified payload for `hash` is in memory already.
func has_in_memory(hash: String) -> bool:
	return _memory.has(hash)


## Records an inline resource record's payload (already verified by Rs2Decoder.Stream: its
## SHA-256 is its hash and it decodes). Returns "" or a resource-invalid error.
## An inline record may also carry a render-stream-mesh/1 (GRM1) payload (render-stream-4.md,
## since G5d): it is decoded by its magic like any other payload.
func add_inline(hash: String, payload: PackedByteArray) -> String:
	var decoded: Dictionary = decode_payload(payload)
	if not decoded["ok"]:
		return Rs2Decoder.err("resource-invalid", "inline payload %s: %s" % [hash, decoded["detail"]])
	_memory[hash] = decoded
	_lengths[hash] = payload.size()
	return ""


## True when `payload` starts with the GRM1 magic (a mesh surface, render-stream-4.md).
static func is_mesh_payload(payload: PackedByteArray) -> bool:
	return payload.size() >= 8 and payload.slice(0, 8).hex_encode() == RsMeshPayload.GRM1_MAGIC_HEX


## True when `payload` starts with the GRP1 magic (shader code, render-stream-5.md, G55d).
static func is_shader_payload(payload: PackedByteArray) -> bool:
	return payload.size() >= 8 and payload.slice(0, 8).hex_encode() == RsShaderPayload.GRP1_MAGIC_HEX


## A payload's kind by its magic: "mesh" (GRM1), "shader" (GRP1) or "texture".
static func payload_kind(payload: PackedByteArray) -> String:
	if is_mesh_payload(payload):
		return "mesh"
	if is_shader_payload(payload):
		return "shader"
	return "texture"


## Decodes a payload by its magic: RsMeshPayload.decode() for GRM1, RsShaderPayload.decode() for
## GRP1 (G55d), RsTexturePayload.decode() otherwise. All return {ok: bool, ..., detail on failure}.
static func decode_payload(payload: PackedByteArray) -> Dictionary:
	if is_mesh_payload(payload):
		return RsMeshPayload.decode(payload)
	if is_shader_payload(payload):
		return RsShaderPayload.decode(payload)
	return RsTexturePayload.decode(payload)


## The file name a payload has in a cache or store directory: `<hash>.grm` for a mesh surface,
## `<hash>.grp` for shader code (G55d), `<hash>.grt` for a texture.
static func file_name(hash: String, mesh: bool, shader: bool = false) -> String:
	if shader:
		return hash + ".grp"
	return hash + (".grm" if mesh else ".grt")


## Whether the cache directory holds a file for `hash` (a hit for obtain(), unless ignore_cache).
## `mesh`: the hash names a mesh surface (G5e); `shader`: GRP1 shader code (G55d).
func cache_has(hash: String, mesh: bool = false, shader: bool = false) -> bool:
	return dir != "" and FileAccess.file_exists(dir.path_join(CACHE_SUBDIR).path_join(file_name(hash, mesh, shader)))


## A `withheld` shader's code from the operator-local library (gate5_5-design.md D4, Q5):
## `<library_dir>/sha256/<hash>.grp`, verified against its name and decoded. Returns {ok: bool,
## code: String, detail: String ("" when ok)}. Never an error of the replay: a shader whose code
## is not in the library is skipped and recorded `shader-withheld` by the caller.
func library_code(hash: String) -> Dictionary:
	if library_dir == "":
		return {"ok": false, "code": "", "detail": "RS_RECEIVER_SHADER_LIBRARY is unset"}
	var path: String = library_dir.path_join(CACHE_SUBDIR).path_join(file_name(hash, false, true))
	if not FileAccess.file_exists(path):
		return {"ok": false, "code": "", "detail": "the library has no %s" % path}
	var bytes: PackedByteArray = FileAccess.get_file_as_bytes(path)
	if RsShaderPayload.sha256_hex(bytes) != hash:
		return {"ok": false, "code": "", "detail": "%s does not hash to its name" % path}
	var decoded_payload: Dictionary = RsShaderPayload.decode(bytes)
	if not decoded_payload["ok"]:
		return {"ok": false, "code": "", "detail": "%s: %s" % [path, decoded_payload["detail"]]}
	var code: String = decoded_payload["code"]
	return {"ok": true, "code": code, "detail": ""}


## Forgets every payload held in memory (a live reconnect: the new session's payloads come from
## the stream's inline records, the cache directory or a fetch, never from the old session).
func clear_memory() -> void:
	_memory.clear()
	_lengths.clear()


## A payload fetched over HTTP (G2c2, RsResourceFetcher): verified against its name, decoded,
## written to the cache, kept in memory -- obtain()'s directory branch, with the bytes already in
## hand. Returns "" or the error (resource-hash-mismatch, resource-invalid, resource-unavailable).
func add_fetched(hash: String, payload: PackedByteArray, origin: String) -> String:
	if RsTexturePayload.sha256_hex(payload) != hash:
		return Rs2Decoder.err("resource-hash-mismatch", "%s (%d bytes) does not hash to its name" % [origin, payload.size()])
	var fetched_decoded: Dictionary = decode_payload(payload)
	if not fetched_decoded["ok"]:
		return Rs2Decoder.err("resource-invalid", "%s: %s" % [origin, fetched_decoded["detail"]])
	if dir != "":
		var write_error: String = _write_cache(hash, payload)
		if write_error != "":
			return write_error
	_memory[hash] = fetched_decoded
	_lengths[hash] = payload.size()
	return ""


## The decoded payload for `hash` (in memory: has_in_memory() was true, or obtain() succeeded).
func decoded(hash: String) -> Dictionary:
	return _memory[hash]


## Makes `hash` available in memory. Returns {error: "" or "<code>: <detail>", source:
## "memory" | "cache" | "directory", bytes: int, verified: bool, start_us: int, end_us: int}.
## A cache hit is a read of the cache; a miss (or ignore_cache) is a fetch from the store
## directory, verified, decoded and written to the cache. `mesh`: the hash names a mesh surface
## (G5e), whose files are `<hash>.grm`; `shader`: GRP1 shader code (G55d), `<hash>.grp`.
func obtain(hash: String, mesh: bool = false, shader: bool = false) -> Dictionary:
	var out: Dictionary = {"error": "", "source": "memory", "bytes": 0, "verified": true, "start_us": 0, "end_us": 0}
	if _memory.has(hash):
		out["bytes"] = _lengths[hash]
		return out
	var cached: String = dir.path_join(CACHE_SUBDIR).path_join(file_name(hash, mesh, shader)) if dir != "" else ""
	if cached != "" and not ignore_cache and FileAccess.file_exists(cached):
		var cache_bytes: PackedByteArray = FileAccess.get_file_as_bytes(cached)
		out["source"] = "cache"
		out["bytes"] = cache_bytes.size()
		if RsTexturePayload.sha256_hex(cache_bytes) != hash:
			out["verified"] = false
			out["error"] = Rs2Decoder.err("resource-hash-mismatch", "cached %s does not hash to its name" % cached)
			return out
		var cache_decoded: Dictionary = decode_payload(cache_bytes)
		if not cache_decoded["ok"]:
			out["error"] = Rs2Decoder.err("resource-invalid", "cached %s: %s" % [cached, cache_decoded["detail"]])
			return out
		_memory[hash] = cache_decoded
		_lengths[hash] = cache_bytes.size()
		return out
	# A fetch from the origin (file mode: the capture's store directory).
	out["source"] = "directory"
	out["start_us"] = Time.get_ticks_usec()
	if store_dir == "":
		out["end_us"] = Time.get_ticks_usec()
		out["verified"] = false
		out["error"] = Rs2Decoder.err("resource-unavailable", "payload %s is not in memory or the cache, and RS_RECEIVER_STORE_DIR is unset" % hash)
		return out
	var origin: String = store_dir.path_join(CACHE_SUBDIR).path_join(file_name(hash, mesh, shader))
	if not FileAccess.file_exists(origin):
		out["end_us"] = Time.get_ticks_usec()
		out["verified"] = false
		out["error"] = Rs2Decoder.err("resource-unavailable", "the store has no %s" % origin)
		return out
	var fetched: PackedByteArray = FileAccess.get_file_as_bytes(origin)
	out["end_us"] = Time.get_ticks_usec()
	out["bytes"] = fetched.size()
	if RsTexturePayload.sha256_hex(fetched) != hash:
		out["verified"] = false
		out["error"] = Rs2Decoder.err("resource-hash-mismatch", "%s (%d bytes) does not hash to its name" % [origin, fetched.size()])
		return out
	var fetched_decoded: Dictionary = decode_payload(fetched)
	if not fetched_decoded["ok"]:
		out["error"] = Rs2Decoder.err("resource-invalid", "%s: %s" % [origin, fetched_decoded["detail"]])
		return out
	if dir != "":
		var write_error: String = _write_cache(hash, fetched)
		if write_error != "":
			out["error"] = write_error
			return out
	_memory[hash] = fetched_decoded
	_lengths[hash] = fetched.size()
	return out


## Writes a verified payload to the cache: a temporary file, then a rename (`.grm` for a GRM1
## payload, `.grp` for a GRP1 one, `.grt` otherwise).
func _write_cache(hash: String, payload: PackedByteArray) -> String:
	var base: String = dir.path_join(CACHE_SUBDIR)
	var final_path: String = base.path_join(file_name(hash, is_mesh_payload(payload), is_shader_payload(payload)))
	var temp_path: String = base.path_join(".%s.tmp" % hash)
	var file: FileAccess = FileAccess.open(temp_path, FileAccess.WRITE)
	if file == null:
		return Rs2Decoder.err("resource-unavailable", "cannot write %s: %s" % [temp_path, error_string(FileAccess.get_open_error())])
	file.store_buffer(payload)
	file.close()
	var renamed: Error = DirAccess.rename_absolute(temp_path, final_path)
	if renamed != OK:
		return Rs2Decoder.err("resource-unavailable", "cannot rename %s: %s" % [temp_path, error_string(renamed)])
	return ""
