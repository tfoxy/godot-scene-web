# G8ku: the UASTC level bench's input step. Converts PNG files (any path, read only) to raw straight
# RGBA8 files in <out-dir> and writes <out-dir>/manifest.tsv for capture/build/rs_basis_level_bench.
# The outputs belong in a scratch directory, never in the repository (game art stays outside it).
#
#   godot --headless --path experiments/render-stream/receiver \
#       --script <abs>/scripts/test/g8ku-png-to-rgba.gd -- <out-dir> <name>=<png> ...
#
# Run it under `timeout`: a headless script that errors can hang.
extends SceneTree


func _init() -> void:
	var args := OS.get_cmdline_user_args()
	var out: String = args[0]
	var manifest := FileAccess.open(out.path_join("manifest.tsv"), FileAccess.WRITE)
	for i: int in range(1, args.size()):
		var pair := args[i].split("=", true, 1)
		var img := Image.load_from_file(pair[1])
		if img == null or img.is_empty():
			push_error("cannot load " + pair[1])
			quit(1)
			return
		img.clear_mipmaps()
		img.convert(Image.FORMAT_RGBA8)
		var raw := out.path_join(pair[0] + ".rgba")
		var f := FileAccess.open(raw, FileAccess.WRITE)
		f.store_buffer(img.get_data())
		f.close()
		manifest.store_line("%s\t%d\t%d\t%s" % [pair[0], img.get_width(), img.get_height(), raw])
		print("%s %dx%d" % [pair[0], img.get_width(), img.get_height()])
	manifest.close()
	quit(0)
