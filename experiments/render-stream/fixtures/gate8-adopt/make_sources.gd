extends SceneTree
## Writes the adoption fixture's two imported textures (G8r, gate8-design.md D6) and their import
## settings into res://tex/ (gitignored), for the editor's `--import` to turn into
## CompressedTexture2D resources (release templates cannot import). Run by run-gate8.sh's g8a import
## leg with the pinned editor:
##
##   mise exec -- godot --headless --path fixtures/gate8-adopt --script res://make_sources.gd
##   mise exec -- godot --headless --path fixtures/gate8-adopt --import
##
## chip.png is imported lossless (an RGBA8 CompressedTexture2D), chip_bc.png VRAM-compressed (DXT5
## on a desktop host, decoded by the capture under GRC_TEXTURE_DECODE=engine). Every pixel is a pure
## function of (x, y), and a file is rewritten only when its bytes would change.

const SIZE: int = 32


func _init() -> void:
	var dir_error: Error = DirAccess.make_dir_recursive_absolute(ProjectSettings.globalize_path("res://tex"))
	if dir_error != OK:
		printerr("[make_sources] cannot create res://tex: %s" % error_string(dir_error))
		quit(1)
		return
	var written: int = 0
	for entry: Array in [["chip", 0, 0], ["chip_bc", 2, 1]]:
		var name: String = entry[0]
		var mode: int = entry[1]
		var variant: int = entry[2]
		var path: String = "res://tex/%s.png" % name
		if _write_if_changed(path, _image(variant).save_png_to_buffer()):
			written += 1
		if _write_if_changed(path + ".import", _import_text(mode).to_utf8_buffer()):
			written += 1
	print("[make_sources] 2 sources, %d files written" % written)
	quit(0)


## The editor rewrites a `.import` file after importing (uid, dest_files, every parameter), so a
## settings file it already completed is left alone while its params still match.
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


func _import_text(mode: int) -> String:
	var lines: PackedStringArray = ["[remap]", "", "importer=\"texture\"", "type=\"CompressedTexture2D\"", "", "[params]", ""]
	lines.append("compress/mode=%d" % mode)
	lines.append("compress/normal_map=2")
	lines.append("detect_3d/compress_to=0")
	lines.append("mipmaps/generate=false")
	return "\n".join(lines) + "\n"


## An RGBA pattern: two diagonal colour ramps, a hard-edged ring and a translucent corner.
static func _image(variant: int) -> Image:
	var data := PackedByteArray()
	data.resize(SIZE * SIZE * 4)
	var i: int = 0
	for y: int in SIZE:
		for x: int in SIZE:
			var dx: int = x - SIZE / 2
			var dy: int = y - SIZE / 2
			var ring: bool = absi(dx * dx + dy * dy - 100) < 28
			var r: int = (x * 8) & 255
			var g: int = (y * 8) & 255
			var b: int = 200 if variant == 0 else 40
			if ring:
				r = 255
				g = 255 if variant == 0 else 64
				b = 255
			data[i] = r
			data[i + 1] = g
			data[i + 2] = b
			data[i + 3] = 128 if (x < 8 and y < 8) else 255
			i += 4
	return Image.create_from_data(SIZE, SIZE, false, Image.FORMAT_RGBA8, data)
