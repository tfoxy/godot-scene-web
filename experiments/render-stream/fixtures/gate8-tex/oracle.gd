extends SceneTree
## Gate 8's decode oracle (gate8-design.md D15 (3), Q3 `decode-oracle`): a separate headless
## process on the release template that loads every imported `.ctex` of the texture table (both
## families), decodes a duplicate with the engine's `Image.decompress()` and writes, per texture,
## the canonical GRT1 payload's SHA-256 (payload.gd, this fixture's own encoder) to
## `$RS_ORACLE_OUT/oracle.json`, and the payload itself to `$RS_ORACLE_OUT/<name>.<family>.grt1`
## (the `decoded` reference draws those). On the headless dummy renderer `get_image()` returns the
## image `texture_2d_create` was given (gate8-design.md D6), i.e. the block-compressed bytes the
## capture's hook sees.
##
##   <template> --headless --path fixtures/gate8-tex --script res://oracle.gd
##     RS_ORACLE_OUT=<abs dir>  (required)
##     RS_ORACLE_TIMING=1       also time the decode of the cost textures, best of RS_ORACLE_REPEATS
##                              (default 3) fresh duplicates (`decode-cost`, a timing leg)
##
## An entry's `decoded_format` is null when `decompress()` failed or produced a format G8t does not
## carry (half floats), exactly the textures the capture must refuse.

const Textures := preload("res://textures.gd")
const Payload := preload("res://payload.gd")
const CARRIED: Array[String] = ["RGBA8", "R8", "RG8"]
## G8kp: the block formats render-stream-9.md offers as a `block` variant.
const BLOCK_FORMATS: Array[String] = ["DXT1", "DXT3", "DXT5", "RGTC_R", "RGTC_RG", "BPTC_RGBA", "ETC", "ETC2_R11", "ETC2_R11S", "ETC2_RG11", "ETC2_RG11S", "ETC2_RGB8", "ETC2_RGBA8", "ETC2_RGB8A1", "ASTC_4x4", "ASTC_8x8"]


func _init() -> void:
	var out_dir: String = OS.get_environment("RS_ORACLE_OUT")
	if out_dir == "" or not out_dir.is_absolute_path():
		printerr("[oracle] RS_ORACLE_OUT must be an absolute directory")
		quit(2)
		return
	DirAccess.make_dir_recursive_absolute(out_dir)
	var timing: bool = OS.get_environment("RS_ORACLE_TIMING") == "1"
	var repeats: int = maxi(OS.get_environment("RS_ORACLE_REPEATS").to_int(), 1) if OS.has_environment("RS_ORACLE_REPEATS") else 3
	var entries: Array[Dictionary] = []
	var failed: bool = false
	for texture: Dictionary in Textures.TEXTURES:
		var is_cost: bool = texture["cost"]
		if timing and not is_cost:
			continue
		for family: String in ["desktop", "mobile"]:
			var v: Dictionary = Textures.variant(texture, family)
			if v.is_empty():
				continue
			var key: String = v["key"]
			if key == "" and family == "mobile":
				continue  # a lossless import has one variant
			var entry: Dictionary = _decode(texture, family, v, timing and is_cost, repeats, out_dir)
			if entry.has("error"):
				failed = true
			entries.append(entry)
	var report: Dictionary = {
		"schema": "render-stream-gate8-oracle/1",
		"engine": Engine.get_version_info()["string"],
		"timing": timing,
		"repeats": repeats if timing else 0,
		"textures": entries,
	}
	var file := FileAccess.open(out_dir.path_join("oracle.json"), FileAccess.WRITE)
	file.store_string(JSON.stringify(report, "  ", false) + "\n")
	file.close()
	print("[oracle] %d entries -> %s" % [entries.size(), out_dir.path_join("oracle.json")])
	quit(1 if failed else 0)


func _decode(texture: Dictionary, family: String, v: Dictionary, timed: bool, repeats: int, out_dir: String) -> Dictionary:
	var name: String = texture["name"]
	var path: String = v["path"]
	var entry: Dictionary = {"name": name, "family": family, "key": v["key"], "path": path}
	var loaded: Resource = ResourceLoader.load(path, "", ResourceLoader.CACHE_MODE_IGNORE)
	var compressed := loaded as CompressedTexture2D
	if compressed == null:
		entry["error"] = "cannot load %s" % path
		return entry
	var source: Image = compressed.get_image()
	if source == null:
		entry["error"] = "no image behind %s" % path
		return entry
	entry["source_format"] = Payload.format_name(source)
	entry["width"] = source.get_width()
	entry["height"] = source.get_height()
	entry["mipmaps"] = source.has_mipmaps()
	entry["source_data_bytes"] = source.get_data_size()
	# G8kp (texture-delivery-design.md D1 `passthrough`): the .ctex's own block bytes as a GRT1
	# payload in their block format, what a `block` variant must equal byte for byte
	# (`block-exact`); null for a format render-stream-9.md never offers as a variant.
	var source_format: String = entry["source_format"]
	if not timed and source.is_compressed() and BLOCK_FORMATS.has(source_format):
		var block: PackedByteArray = Payload.encode(source)
		entry["block_payload_sha256"] = Payload.sha256_hex(block)
		entry["block_payload_bytes"] = block.size()
		var block_out := FileAccess.open(out_dir.path_join("%s.%s.block.grt1" % [name, family]), FileAccess.WRITE)
		block_out.store_buffer(block)
		block_out.close()
	else:
		entry["block_payload_sha256"] = null
		entry["block_payload_bytes"] = null
	var decoded: Image = source.duplicate() as Image
	var error: Error = OK
	if decoded.is_compressed():
		error = decoded.decompress()
	if timed:
		var best_us: int = -1
		for i: int in repeats:
			var fresh: Image = source.duplicate() as Image
			var t0: int = Time.get_ticks_usec()
			fresh.decompress()
			var us: int = Time.get_ticks_usec() - t0
			best_us = us if best_us < 0 else mini(best_us, us)
		entry["decompress_best_us"] = best_us
		entry["mpx_per_s"] = float(source.get_width() * source.get_height()) / float(maxi(best_us, 1))
	var decoded_format: String = Payload.format_name(decoded)
	entry["decompress_error"] = error
	if error != OK or decoded.is_compressed() or not CARRIED.has(decoded_format):
		entry["decoded_format"] = null
		entry["payload_sha256"] = null
		return entry
	var payload: PackedByteArray = Payload.encode(decoded)
	entry["decoded_format"] = decoded_format
	entry["decoded_data_bytes"] = decoded.get_data_size()
	entry["payload_bytes"] = payload.size()
	entry["payload_sha256"] = Payload.sha256_hex(payload)
	if not timed:
		var out := FileAccess.open(out_dir.path_join("%s.%s.grt1" % [name, family]), FileAccess.WRITE)
		out.store_buffer(payload)
		out.close()
	return entry
