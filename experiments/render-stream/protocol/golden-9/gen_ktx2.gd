# Generates golden-9's two synthetic KTX2 payloads (render-stream-9.md "Golden vectors").
#
# Not part of any test run: the .ktx2 files it writes are committed, and make_golden.py reads
# them. It needs Godot 4.5.1's EDITOR binary (the encoder is editor-only; the repo's
# `mise exec -- godot` is one) and never touches game content: the two images are procedural.
#
#   mise exec -- godot --headless --path experiments/render-stream/receiver \
#     --script $PWD/experiments/render-stream/protocol/golden-9/gen_ktx2.gd -- <out-dir>
#
# PortableCompressedTexture2D.create_from_image(..., COMPRESSION_MODE_BASIS_UNIVERSAL) packs the
# image with the engine's vendored basisu (UASTC LDR 4x4, level 1, no RDO) into a KTX2 file with
# Zstandard supercompression, and keeps `[20-byte portable header][u32 decompress format | KTX2 flag][KTX2 file]` as its
# `_data` (portable_compressed_texture.cpp:154-236, image_compress_basisu.cpp:259). The KTX2 file
# is bytes 24.. of that buffer.
extends SceneTree


func _image(size: int, mips: bool) -> Image:
	var img := Image.create(size, size, false, Image.FORMAT_RGBA8)
	for y: int in size:
		for x: int in size:
			var cell: int = (x * 4 / size) + (y * 4 / size)
			var blue: int = 160 if cell % 2 == 0 else 32
			img.set_pixel(x, y, Color8(x * 255 / (size - 1), y * 255 / (size - 1), blue, 255))
	if mips:
		img.generate_mipmaps()
	return img


func _write(path: String, size: int, mips: bool) -> void:
	var t := PortableCompressedTexture2D.new()
	t.set_keep_compressed_buffer(true)
	t.set_basisu_compressor_params(1, 0.0)
	t.create_from_image(_image(size, mips), PortableCompressedTexture2D.COMPRESSION_MODE_BASIS_UNIVERSAL, false, 0.8)
	var data: Variant = t.get("_data")
	if not (data is PackedByteArray):
		push_error("no _data")
		return
	var packed: PackedByteArray = data
	var f := FileAccess.open(path, FileAccess.WRITE)
	f.store_buffer(packed.slice(24))
	f.close()
	print("wrote ", path, " ", packed.size() - 24, " bytes")


func _init() -> void:
	var out_dir: String = OS.get_cmdline_user_args()[0]
	_write(out_dir.path_join("ktx2-16x16-mips.ktx2"), 16, true)
	_write(out_dir.path_join("ktx2-4x4.ktx2"), 4, false)
	quit()
