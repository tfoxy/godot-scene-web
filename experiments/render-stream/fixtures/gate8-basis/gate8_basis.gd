extends Node
## Gate 8 Basis fixture (G8ku, texture-delivery-design.md D6, D12, D14, D16). Every texture is made at
## runtime from a procedural source (no import, no committed image) and drawn 1:1 at its own place
## in the receiver's 640x360 viewport, so a /9 `basis-uastc` capture lists a lazy `uastc` variant
## exactly where D12 admits one (every admitted size is >= 128x128 = 16384 texels):
##
##   name     size     format  D12                      drawn at
##   rgba     160x128  RGBA8   uastc                    (4, 4)
##   rgb      192x96   RGB8    uastc                    (168, 4)
##   bc1      136x124  DXT1    uastc (host-decoded to RGBA8; a desktop receiver picks its `block`)
##                                                      (364, 4)
##   small    64x64    RGBA8   none: below 16384 texels (504, 4)
##   gray     224x80   L8      none: format             (4, 276)
##   updated  136x136  RGBA8   none: updated at step 1  (4, 136)
##   npot     150x110  RGBA8   uastc                    (144, 136)
##   mip      128x128  RGBA8   uastc, 8 levels          (298, 136) 1:1, and (430, 136) at half size
##                                                      with linear mipmaps (its level 1)
##   big      1024x512 RGBA8   uastc (0.5 Mpx: the transcode cost per Mpx, native and web)
##                                                      (500, 136): its 128x128 region at (448, 192)
##
## Every KTX2 a uastc variant can carry has its own size, which is how the oracle maps a store's
## `.ktx2` files to these names. Step 0 (frame S) creates them all; step 1 (frame U) updates
## `updated` in place (texture_2d_update: D12(a)), and is the frame the capture legs pass as
## GRC_TEXTURE_ENCODE_WAIT_FRAME, so the lazy variants publish there. A step settles at +7.
##
## Environment (all optional):
##   RS_FIXTURE_SOURCE        procedural (default) | oracle: the `reference-oracle` leg. It reads
##                            every <RS_FIXTURE_KTX2_DIR>/sha256/*.ktx2 with Image.load_ktx_from_buffer
##                            (the independent transcode, D16 `transcode-oracle`), writes
##                            oracle.json and each transcode's CPU decode (<hash>.rgba, every level as
##                            straight RGBA8) to RS_FIXTURE_ORACLE_OUT, and from step 1 on draws
##                            RS_FIXTURE_ORACLE_NAMES (default rgba,rgb,npot,mip,big) from that decode
##   RS_FIXTURE_KTX2_DIR      absolute: a capture's store directory (oracle source)
##   RS_FIXTURE_ORACLE_OUT    absolute dir (oracle source)
##   RS_FIXTURE_ORACLE_NAMES  comma list of the names drawn from the oracle at step 1
##   RS_FIXTURE_ORACLE_DRAW   cpu (default): draw the oracle's CPU decodes (RGBA8); blocks: draw the
##                            oracle's transcoded blocks themselves, sampled by the GPU as the
##                            receiver's upload is (`reference-oracle-hw`)
##   RS_FIXTURE_UPDATE_FRAME  U, the step-1 frame (default 12)
##   RS_FIXTURE_QUIT_FRAME    >= U + 8 (default U + 18)
##   RS_FIXTURE_STEP_LOG      absolute path: one JSONL line per step
##   RS_FIXTURE_SHOT_DIR      absolute dir: step-<k>.png at each settle frame (rendered runs only)
##   RS_FIXTURE_DUMP_RES_DIR  absolute dir: save every step-0 image as <name>.res (an Image resource,
##                            format and mip chain kept) and quit, drawing nothing (G8kf: the
##                            prepare step's list, scripts/prepare-textures.sh --list)

const START_FRAME: int = 1
const UPDATE_FRAME_DEFAULT: int = 12
const SETTLE_OFFSET: int = 7

const TEXTURES: Array[Dictionary] = [
	{"name": "rgba", "w": 160, "h": 128, "format": "RGBA8", "x": 4, "y": 4},
	{"name": "rgb", "w": 192, "h": 96, "format": "RGB8", "x": 168, "y": 4},
	{"name": "bc1", "w": 136, "h": 124, "format": "DXT1", "x": 364, "y": 4},
	{"name": "small", "w": 64, "h": 64, "format": "RGBA8", "x": 504, "y": 4},
	{"name": "gray", "w": 224, "h": 80, "format": "L8", "x": 4, "y": 276},
	{"name": "updated", "w": 136, "h": 136, "format": "RGBA8", "x": 4, "y": 136},
	{"name": "npot", "w": 150, "h": 110, "format": "RGBA8", "x": 144, "y": 136},
	{"name": "mip", "w": 128, "h": 128, "format": "RGBA8", "x": 298, "y": 136, "mipmaps": true},
	{"name": "big", "w": 1024, "h": 512, "format": "RGBA8", "x": 500, "y": 136, "region": [448, 192, 128, 128]},
]


## The drawers are made in _ready (after the capture armed: gate 0's route-a rule), never the
## main scene's own node, whose items would predate the arm.
class Board extends Node2D:
	var textures: Dictionary = {}

	func _draw() -> void:
		for t: Dictionary in TEXTURES:
			var texture: Texture2D = textures.get(t["name"])
			var x: int = t["x"]
			var y: int = t["y"]
			if texture == null:
				continue
			if t.has("region"):
				var r: Array = t["region"]
				var sx: int = r[0]
				var sy: int = r[1]
				var rw: int = r[2]
				var rh: int = r[3]
				draw_texture_rect_region(texture, Rect2(x, y, rw, rh), Rect2(sx, sy, rw, rh))
			else:
				draw_texture(texture, Vector2(x, y))


class HalfMip extends Node2D:
	var texture: Texture2D

	func _draw() -> void:
		if texture != null:
			draw_texture_rect(texture, Rect2(430, 136, 64, 64), false)


var _frame: int = 0
var _update_frame: int = UPDATE_FRAME_DEFAULT
var _quit_frame: int = UPDATE_FRAME_DEFAULT + 18
var _source: String = "procedural"
var _oracle_names: Array[String] = ["rgba", "rgb", "npot", "mip", "big"]
var _oracle_images: Dictionary = {}  # name -> Image (the CPU decode of the oracle's transcode)
var _oracle_blocks: Dictionary = {}  # name -> Image (the oracle's transcode itself)
var _oracle_draw: String = "cpu"
var _textures: Dictionary = {}  # name -> ImageTexture
var _board: Board
var _half: HalfMip
var _shot_dir: String = ""
var _step_log: FileAccess
var _failed: bool = false


func _ready() -> void:
	if OS.has_environment("RS_FIXTURE_DUMP_RES_DIR"):
		_failed = true
		var dir: String = OS.get_environment("RS_FIXTURE_DUMP_RES_DIR")
		var bad: int = 0
		for t: Dictionary in TEXTURES:
			var err: Error = ResourceSaver.save(_make(t, 0), dir.path_join("%s.res" % t["name"]))
			if err != OK:
				bad += 1
				_error("cannot save %s.res (%d)" % [t["name"], err])
		get_tree().quit(1 if bad != 0 else 0)
		return
	if not _parse_env():
		_failed = true
		get_tree().quit(1)
		return
	_board = Board.new()
	add_child(_board)
	_half = HalfMip.new()
	_half.texture_filter = CanvasItem.TEXTURE_FILTER_LINEAR_WITH_MIPMAPS
	add_child(_half)


func _process(_delta: float) -> void:
	if _failed:
		return
	_frame += 1
	if _frame == START_FRAME:
		for t: Dictionary in TEXTURES:
			_textures[t["name"]] = ImageTexture.create_from_image(_make(t, 0))
		_redraw()
		_log_step(0, _frame)
	elif _frame == _update_frame:
		var updated: ImageTexture = _textures["updated"]
		updated.update(_make(TEXTURES[5], 1))
		if _source == "oracle":
			for name: String in _oracle_names:
				if not _oracle_images.has(name):
					_error("the oracle has no KTX2 for %s" % name)
					return
				var oracle: Image = _oracle_blocks[name] if _oracle_draw == "blocks" else _oracle_images[name]
				# set_image: texture_2d_create then texture_replace into the drawn RID, the path the
				# receiver takes when it switches a texture to another payload.
				var drawn: ImageTexture = _textures[name]
				drawn.set_image(oracle)
		_redraw()
		_log_step(1, _frame)
	if _frame == START_FRAME + SETTLE_OFFSET:
		_shot("step-0.png")
	elif _frame == _update_frame + SETTLE_OFFSET:
		_shot("step-1.png")
	if _frame >= _quit_frame:
		print("[fixture] quitting frame=%d" % _frame)
		get_tree().quit(0)


func _redraw() -> void:
	_board.textures = _textures
	_board.queue_redraw()
	_half.texture = _textures["mip"]
	_half.queue_redraw()


## The procedural source of `t` (`variant` 1: `updated`'s step-1 content). Integer arithmetic only,
## so every run makes the same bytes.
static func _make(t: Dictionary, variant: int) -> Image:
	var w: int = t["w"]
	var h: int = t["h"]
	var format: String = t["format"]
	var data := PackedByteArray()
	if format == "DXT1":
		# 4-colour DXT1 blocks (color0 > color1) from a gradient, varied index rows.
		data.resize((w / 4) * (h / 4) * 8)
		var at: int = 0
		for by: int in h / 4:
			for bx: int in w / 4:
				var r: int = (bx * 31) / maxi(1, w / 4 - 1)
				var g: int = (by * 63) / maxi(1, h / 4 - 1)
				var b: int = 31 - r
				var c0: int = (r << 11) | (g << 5) | b
				var c1: int = c0 >> 2
				if c0 <= c1:
					c0 = c1 + 1
				data[at] = c0 & 0xFF
				data[at + 1] = c0 >> 8
				data[at + 2] = c1 & 0xFF
				data[at + 3] = c1 >> 8
				for row: int in 4:
					data[at + 4 + row] = (bx * 7 + by * 13 + row * 57) & 0xFF
				at += 8
		return Image.create_from_data(w, h, false, Image.FORMAT_DXT1, data)
	var channels: int = {"RGBA8": 4, "RGB8": 3, "L8": 1}[format]
	data.resize(w * h * channels)
	var seed: int = t["x"] + t["y"] * 3 + variant * 101
	var at2: int = 0
	for y: int in h:
		for x: int in w:
			# A smooth diagonal ramp with soft rings: colour-correlated, like UI art.
			var dx: int = x - w / 2
			var dy: int = y - h / 2
			var d2: int = (dx * dx + dy * dy) * 1024 / (w * w / 4 + h * h / 4)
			var ring: int = ((d2 * 3 + seed) % 256) / 8
			var ramp: int = ((x * 160) / w + (y * 80) / h + seed) % 256
			var rr: int = clampi(40 + ramp + ring, 0, 255)
			var gg: int = clampi(30 + (ramp * 3) / 4 + ring, 0, 255)
			var bb: int = clampi(90 + ramp / 2 + ring * 2, 0, 255)
			if variant == 1:
				rr = 255 - rr
				bb = 255 - bb
			if channels == 1:
				data[at2] = (rr + gg + bb) / 3
			else:
				data[at2] = rr
				data[at2 + 1] = gg
				data[at2 + 2] = bb
				if channels == 4:
					data[at2 + 3] = clampi(255 - maxi(0, d2 - 640) / 2, 0, 255)
			at2 += channels
	var image_format: Image.Format = Image.FORMAT_RGBA8
	if channels == 3:
		image_format = Image.FORMAT_RGB8
	elif channels == 1:
		image_format = Image.FORMAT_L8
	var image := Image.create_from_data(w, h, false, image_format, data)
	var mipmaps: bool = t.get("mipmaps", false)
	if mipmaps:
		image.generate_mipmaps()
	return image


func _parse_env() -> bool:
	if OS.has_environment("RS_FIXTURE_UPDATE_FRAME"):
		_update_frame = int(OS.get_environment("RS_FIXTURE_UPDATE_FRAME"))
		if _update_frame < START_FRAME + SETTLE_OFFSET + 2:
			_error("RS_FIXTURE_UPDATE_FRAME must be >= %d" % (START_FRAME + SETTLE_OFFSET + 2))
			return false
	_quit_frame = _update_frame + 18
	if OS.has_environment("RS_FIXTURE_QUIT_FRAME"):
		_quit_frame = maxi(int(OS.get_environment("RS_FIXTURE_QUIT_FRAME")), _update_frame + SETTLE_OFFSET + 1)
	_shot_dir = OS.get_environment("RS_FIXTURE_SHOT_DIR")
	if OS.has_environment("RS_FIXTURE_STEP_LOG"):
		_step_log = FileAccess.open(OS.get_environment("RS_FIXTURE_STEP_LOG"), FileAccess.WRITE)
		if _step_log == null:
			_error("cannot open RS_FIXTURE_STEP_LOG")
			return false
	if OS.has_environment("RS_FIXTURE_SOURCE"):
		_source = OS.get_environment("RS_FIXTURE_SOURCE")
		if _source != "procedural" and _source != "oracle":
			_error("RS_FIXTURE_SOURCE must be procedural or oracle (got %s)" % JSON.stringify(_source))
			return false
	if OS.has_environment("RS_FIXTURE_ORACLE_NAMES"):
		_oracle_names.assign(OS.get_environment("RS_FIXTURE_ORACLE_NAMES").split(",", false))
	if OS.has_environment("RS_FIXTURE_ORACLE_DRAW"):
		_oracle_draw = OS.get_environment("RS_FIXTURE_ORACLE_DRAW")
		if _oracle_draw != "cpu" and _oracle_draw != "blocks":
			_error("RS_FIXTURE_ORACLE_DRAW must be cpu or blocks (got %s)" % JSON.stringify(_oracle_draw))
			return false
	if _source == "oracle":
		return _run_oracle(OS.get_environment("RS_FIXTURE_KTX2_DIR"), OS.get_environment("RS_FIXTURE_ORACLE_OUT"))
	return true


## D16 `transcode-oracle`: every KTX2 in the store through Image.load_ktx_from_buffer, on this
## renderer (so D14 picks this GPU's target), its uploaded blocks hashed and its CPU decode kept.
func _run_oracle(ktx2_dir: String, out_dir: String) -> bool:
	if ktx2_dir == "" or out_dir == "":
		_error("RS_FIXTURE_SOURCE=oracle needs RS_FIXTURE_KTX2_DIR and RS_FIXTURE_ORACLE_OUT")
		return false
	DirAccess.make_dir_recursive_absolute(out_dir)
	var rows: Array[Dictionary] = []
	var sha_dir: String = ktx2_dir.path_join("sha256")
	var files: PackedStringArray = DirAccess.get_files_at(sha_dir)
	for file_name: String in files:
		if not file_name.ends_with(".ktx2"):
			continue
		var hash: String = file_name.get_basename()
		var bytes: PackedByteArray = FileAccess.get_file_as_bytes(sha_dir.path_join(file_name))
		var row: Dictionary = {"hash": hash, "ktx2_bytes": bytes.size(), "hash_ok": _sha256(bytes) == hash}
		var image := Image.new()
		var t0: int = Time.get_ticks_usec()
		var err: Error = image.load_ktx_from_buffer(bytes)
		row["transcode_us"] = Time.get_ticks_usec() - t0
		row["error"] = err
		if err == OK:
			row["format"] = image.get_format()
			row["width"] = image.get_width()
			row["height"] = image.get_height()
			row["mipmaps"] = image.has_mipmaps()
			row["data_bytes"] = image.get_data_size()
			row["data_sha256"] = _sha256(image.get_data())
			var decoded: Image = image.duplicate()
			if decoded.is_compressed():
				decoded.decompress()
			decoded.convert(Image.FORMAT_RGBA8)
			var raw: String = out_dir.path_join(hash + ".rgba")
			var f := FileAccess.open(raw, FileAccess.WRITE)
			f.store_buffer(decoded.get_data())
			f.close()
			row["decoded_sha256"] = _sha256(decoded.get_data())
			for t: Dictionary in TEXTURES:
				if t["w"] == image.get_width() and t["h"] == image.get_height() and t["format"] != "L8":
					row["name"] = t["name"]
					_oracle_images[t["name"]] = decoded
					_oracle_blocks[t["name"]] = image
		rows.append(row)
	rows.sort_custom(func(a: Dictionary, b: Dictionary) -> bool: return str(a["hash"]) < str(b["hash"]))
	var report := FileAccess.open(out_dir.path_join("oracle.json"), FileAccess.WRITE)
	report.store_string(JSON.stringify({
		"schema": "g8ku-oracle/1",
		"renderer": RenderingServer.get_current_rendering_driver_name(),
		"adapter": RenderingServer.get_video_adapter_name(),
		"features": ["s3tc", "bptc", "rgtc", "etc2", "astc"].filter(func(f: String) -> bool: return RenderingServer.has_os_feature(f)),
		"ktx2": rows,
	}, "  "))
	report.close()
	print("[fixture] oracle: %d KTX2 files" % rows.size())
	return true


static func _sha256(bytes: PackedByteArray) -> String:
	var ctx := HashingContext.new()
	ctx.start(HashingContext.HASH_SHA256)
	ctx.update(bytes)
	return ctx.finish().hex_encode()


func _log_step(step: int, frame: int) -> void:
	if _step_log == null:
		return
	_step_log.store_line("{\"step\":%d,\"applied_frame\":%d,\"settle_frame\":%d}" % [step, frame, frame + SETTLE_OFFSET])
	_step_log.flush()


func _shot(file_name: String) -> void:
	if _shot_dir == "" or DisplayServer.get_name() == "headless":
		return
	await RenderingServer.frame_post_draw
	var image: Image = get_viewport().get_texture().get_image()
	var err: Error = image.save_png(_shot_dir.path_join(file_name))
	print("[fixture] shot saved=%s err=%d" % [file_name, err])


func _error(message: String) -> void:
	push_error("[fixture] " + message)
	print("[fixture] error: " + message)
	_failed = true
	get_tree().quit(1)
