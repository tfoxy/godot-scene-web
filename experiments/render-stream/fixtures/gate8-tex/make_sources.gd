extends SceneTree
## Writes the gate 8 texture fixture's synthetic sources and their import settings into res://tex/
## (gitignored), for the editor's `--import` to compress (release templates cannot encode: the
## S3TC/BPTC/ETC2/ASTC encoders are TOOLS_ENABLED only, gate8-design.md D8). Run by run-gate8.sh's
## import leg with the pinned editor:
##
##   mise exec -- godot --headless --path fixtures/gate8-tex --script res://make_sources.gd
##   mise exec -- godot --headless --path fixtures/gate8-tex --import
##
## Every pixel is a pure function of (x, y) and the pattern, so the sources are identical on every
## host; existing files are rewritten only when their bytes would change (the import then stays
## valid across runs).

const Textures := preload("res://textures.gd")


func _init() -> void:
	var dir_error: Error = DirAccess.make_dir_recursive_absolute(ProjectSettings.globalize_path("res://tex"))
	if dir_error != OK:
		printerr("[make_sources] cannot create res://tex: %s" % error_string(dir_error))
		quit(1)
		return
	var written: int = 0
	for texture: Dictionary in Textures.TEXTURES:
		var path: String = Textures.source_path(texture)
		var size: int = texture["size"]
		var pattern: String = texture["pattern"]
		var params: Dictionary = texture["params"]
		var image: Image = _image(size, pattern)
		var bytes: PackedByteArray = image.save_exr_to_buffer(false) if pattern == "hdr" else image.save_png_to_buffer()
		if _write_if_changed(path, bytes):
			written += 1
		if _write_if_changed(path + ".import", _import_text(params).to_utf8_buffer()):
			written += 1
	print("[make_sources] %d sources, %d files written" % [Textures.TEXTURES.size(), written])
	quit(0)


## The editor rewrites a `.import` file after importing (uid, dest_files, the full parameter
## list), so a settings file it already completed is left alone when its params still match.
func _write_if_changed(path: String, bytes: PackedByteArray) -> bool:
	if path.ends_with(".import") and FileAccess.file_exists(path):
		var config := ConfigFile.new()
		var wanted := ConfigFile.new()
		if config.load(path) == OK and wanted.parse(bytes.get_string_from_utf8()) == OK:
			var same: bool = true
			for key: String in wanted.get_section_keys("params"):
				if not config.has_section_key("params", key) or config.get_value("params", key) != wanted.get_value("params", key):
					same = false
			if same:
				return false
	elif FileAccess.file_exists(path) and FileAccess.get_file_as_bytes(path) == bytes:
		return false
	var file := FileAccess.open(path, FileAccess.WRITE)
	if file == null:
		printerr("[make_sources] cannot write %s" % path)
		return false
	file.store_buffer(bytes)
	file.close()
	return true


func _import_text(params: Dictionary) -> String:
	var lines: PackedStringArray = ["[remap]", "", "importer=\"texture\"", "type=\"CompressedTexture2D\"", "", "[params]", ""]
	# Settings every source shares: no normal-map or 3D detection, no size limit.
	var all: Dictionary = {"compress/normal_map": 2, "detect_3d/compress_to": 0, "mipmaps/generate": false}
	all.merge(params, true)
	for key: String in all.keys():
		var value: Variant = all[key]
		lines.append("%s=%s" % [key, var_to_str(value)])
	return "\n".join(lines) + "\n"


## A smooth gradient with per-pixel hash noise (so blocks are never flat), per pattern.
static func _image(size: int, pattern: String) -> Image:
	if pattern == "hdr":
		var hdr := Image.create_empty(size, size, false, Image.FORMAT_RGBF)
		for y: int in size:
			for x: int in size:
				hdr.set_pixel(x, y, Color(0.25 + 3.0 * x / size, 0.5 + 2.0 * y / size, 1.5, 1.0))
		return hdr
	var channels: int = 3 if pattern == "rgb" else (4 if pattern == "rgba" else 3)
	var data := PackedByteArray()
	data.resize(size * size * channels)
	var i: int = 0
	for y: int in size:
		for x: int in size:
			var noise: int = ((x * 73856093) ^ (y * 19349663)) & 31
			var r: int = (x * 255 / maxi(size - 1, 1) + noise) & 255
			var g: int = (y * 255 / maxi(size - 1, 1) + (noise >> 1)) & 255
			var b: int = ((x + y) * 127 / maxi(size - 1, 1) + ((x >> 3) & 1) * 96) & 255
			if pattern == "r":
				g = 0
				b = 0
			elif pattern == "rg":
				b = 0
			data[i] = r
			data[i + 1] = g
			data[i + 2] = b
			if channels == 4:
				# Opaque, translucent and transparent quarters, plus noise in the alpha ramp.
				var quarter: int = (2 * x / size) + 2 * (2 * y / size)
				var alpha: int = [255, 160 + noise, (x * 255 / maxi(size - 1, 1)) & 255, 0][quarter]
				data[i + 3] = alpha
			i += channels
	return Image.create_from_data(size, size, false, Image.FORMAT_RGBA8 if channels == 4 else Image.FORMAT_RGB8, data)
