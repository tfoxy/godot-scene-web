extends SceneTree
## Writes the hint-scene fixture's two edge sources and their import settings into res://tex/
## (gitignored), for the editor's `--import` to compress to S3TC (release templates cannot encode).
## Run by run-gate8.sh's g8hint import leg with the pinned editor:
##
##   mise exec -- godot --headless --path fixtures/hint-scene --script res://make_sources.gd
##   mise exec -- godot --headless --path fixtures/hint-scene --import
##
## Both sizes are not multiples of 4, so the importer stores them padded to the next multiple of 4
## (the last column and row repeated) and CompressedTexture2D draws them at the source size through
## texture_set_size_override: edge_a 30x18 stored 32x20, edge_b 26x14 stored 28x16.
##
## Each 4x4 block holds two colours, each channel 0 or 255 and one colour at or below the other in
## every channel (black/red, blue/white, ...), in a checker of 2x2 texel squares. Any DXT1 encoder
## keeps such a block's colours as its exact endpoints, so the host's CPU decode and a GPU's own
## sampling agree texel for texel, and a shift of one texel column or row changes colour at every
## square boundary.

const SOURCES: Array[Dictionary] = [
	{"name": "edge_a", "width": 30, "height": 18},
	{"name": "edge_b", "width": 26, "height": 14},
]

## (dark, bright) pairs: dark <= bright in every channel.
const PAIRS: Array[Array] = [
	[Color8(0, 0, 0), Color8(255, 0, 0)],
	[Color8(0, 0, 255), Color8(255, 255, 255)],
	[Color8(0, 0, 0), Color8(0, 255, 0)],
	[Color8(255, 0, 0), Color8(255, 255, 0)],
	[Color8(0, 255, 0), Color8(0, 255, 255)],
	[Color8(0, 0, 0), Color8(255, 255, 255)],
	[Color8(255, 0, 0), Color8(255, 0, 255)],
	[Color8(0, 0, 255), Color8(0, 255, 255)],
]


func _init() -> void:
	var dir_error: Error = DirAccess.make_dir_recursive_absolute(ProjectSettings.globalize_path("res://tex"))
	if dir_error != OK:
		printerr("[make_sources] cannot create res://tex: %s" % error_string(dir_error))
		quit(1)
		return
	var written: int = 0
	for source: Dictionary in SOURCES:
		var name: String = source["name"]
		var path: String = "res://tex/%s.png" % name
		var width: int = source["width"]
		var height: int = source["height"]
		var image: Image = edge_image(width, height, 0 if name == "edge_a" else 3)
		if _write_if_changed(path, image.save_png_to_buffer()):
			written += 1
		if _write_if_changed(path + ".import", _import_text().to_utf8_buffer()):
			written += 1
	print("[make_sources] %d sources, %d files written" % [SOURCES.size(), written])
	quit(0)


## The checker of one source; `shift` rotates the pair table so the two sources differ.
static func edge_image(width: int, height: int, shift: int) -> Image:
	var image := Image.create_empty(width, height, false, Image.FORMAT_RGB8)
	for y: int in height:
		for x: int in width:
			var pair: Array = PAIRS[(x / 4 + 3 * (y / 4) + shift) % PAIRS.size()]
			var c: Color = pair[(x / 2 + y / 2) % 2]
			image.set_pixel(x, y, c)
	return image


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


## VRAM compressed (S3TC: DXT1 for an opaque source), no mipmaps, no normal-map or 3D detection.
func _import_text() -> String:
	return "\n".join([
		"[remap]", "", "importer=\"texture\"", "type=\"CompressedTexture2D\"", "", "[params]", "",
		"compress/mode=2", "compress/normal_map=2", "detect_3d/compress_to=0", "mipmaps/generate=false",
	]) + "\n"
