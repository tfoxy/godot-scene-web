# G8kv: round-trip the capture's KTX2 files through STOCK Godot 4.5.1's own transcoder
# (Image.load_ktx_from_buffer) and report PSNR against the source RGBA8 levels.
#
#   godot --headless --path experiments/render-stream/receiver --script <abs>/capture/test/g8kv_transcode.gd -- <emit-dir>
#
# Always run under `timeout`: a headless script that errors can hang. Prints one line per case and
# level, then "RESULT ok|fail". The PSNR floor is per case (manifest column 5), a smoke bound well below what UASTC L2
# reaches on these colour-correlated images; the measured table is in results/gate8/g8kv.md.
extends SceneTree


func _psnr(a: PackedByteArray, b: PackedByteArray) -> Array:
	# [psnr over RGB+A, max abs diff]
	var se := 0.0
	var mx := 0
	for i: int in a.size():
		var d: int = absi(int(a[i]) - int(b[i]))
		se += float(d * d)
		mx = maxi(mx, d)
	if se == 0.0:
		return [INF, mx]
	return [10.0 * log(255.0 * 255.0 / (se / float(a.size()))) / log(10.0), mx]


func _init() -> void:
	var dir: String = OS.get_cmdline_user_args()[0]
	var manifest := FileAccess.get_file_as_string(dir.path_join("manifest.tsv")).strip_edges().split("\n")
	var ok := true
	for line: String in manifest:
		var f := line.split("\t")
		var name: String = f[0]
		var w: int = int(f[1])
		var h: int = int(f[2])
		var n_levels: int = int(f[3])
		var floor_db: float = float(f[4])
		var img := Image.new()
		var err := img.load_ktx_from_buffer(FileAccess.get_file_as_bytes(dir.path_join(name + ".ktx2")))
		if err != OK:
			print("FAIL ", name, " load_ktx_from_buffer error ", err)
			ok = false
			continue
		var fmt_name := img.get_format()
		var has_mips := img.has_mipmaps()
		if img.is_compressed():
			img.decompress()
		img.convert(Image.FORMAT_RGBA8)
		if img.get_width() != w or img.get_height() != h or (img.get_mipmap_count() + 1 != n_levels):
			print("FAIL ", name, " shape ", img.get_width(), "x", img.get_height(), " mips ", img.get_mipmap_count(), " want ", w, "x", h, " levels ", n_levels)
			ok = false
			continue
		for lvl: int in n_levels:
			var src := FileAccess.get_file_as_bytes(dir.path_join("%s.%d.rgba" % [name, lvl]))
			var lw: int = maxi(1, w >> lvl)
			var lh: int = maxi(1, h >> lvl)
			var off: int = img.get_mipmap_offset(lvl)
			var nxt: int = img.get_mipmap_offset(lvl + 1) if lvl + 1 <= img.get_mipmap_count() else img.get_data().size()
			var got := img.get_data().slice(off, nxt)
			if got.size() != lw * lh * 4 or src.size() != got.size():
				print("FAIL ", name, " level ", lvl, " bytes ", got.size(), " vs ", src.size())
				ok = false
				continue
			var r := _psnr(src, got)
			var good: bool = r[0] >= floor_db
			print("%s %s L%d %dx%d psnr=%.2f maxdiff=%d" % ["ok  " if good else "FAIL", name, lvl, lw, lh, r[0], r[1]])
			ok = ok and good
		print("info ", name, " decoded format ", fmt_name, " mips ", has_mips)
	print("RESULT ", "ok" if ok else "fail")
	quit(0 if ok else 1)
