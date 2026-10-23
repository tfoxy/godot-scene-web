extends Node
## Gate 8 texture fixture (G8t, gate8-design.md Q3 "Fixture"). Every drawn texture of
## textures.gd's table is drawn four ways, one row each, in one column per texture:
##
##   row A (y 16)   Sprite2D, scale 1, the project's default filter (nearest)
##   row B (y 96)   Sprite2D, scale 1.25, item filter linear (alpha_mip: scale 0.3125, linear
##                  with mipmaps, so its decoded mip chain is sampled)
##   row C (y 186)  NinePatchRect 72x56, patch margins 16, nearest
##   row D (y 260)  a custom item's draw_texture_rect_region(Rect2(0, 0, 48, 48), source (8, 8, 32, 32))
##
## Step 0 (`_ready`, frame 1) draws the desktop family (S3TC/BPTC imports); step 1 (frame S+N)
## swaps every drawer to the mobile family (ETC2/ASTC imports), so both families are created after
## arm, as in the STS2 census (gate8-design.md Q1e). `hdr` (BPTC_RGBFU / ASTC_4x4_HDR) is created
## in both steps and never drawn: G8t refuses it. A step is settled at its frame + 7.
##
## Environment (all optional):
##   RS_FIXTURE_SOURCE       ctex (default): load the imported .ctex, so the RenderingServer gets
##                           the block-compressed image (the capture and `reference-hw`);
##                           decoded: draw the oracle's decoded GRT1 payloads from
##                           RS_FIXTURE_DECODED_DIR instead (the `reference`, the engine's CPU
##                           decode drawn as plain textures)
##   RS_FIXTURE_DECODED_DIR  absolute dir: oracle.gd's output (RS_FIXTURE_SOURCE=decoded)
##   RS_FIXTURE_VARIANT      unset, or cost: create the 2048x2048 cost textures one per frame
##                           (frames 2..), draw nothing, quit (the decode-cost leg)
##   RS_FIXTURE_STEP_LOG     absolute path: one JSONL line per step
##   RS_FIXTURE_TEXTURE_LOG  absolute path: one JSONL line per texture the fixture creates
##   RS_FIXTURE_SHOT_DIR     absolute dir: step-<k>.png at each settle frame (rendered runs only)
##   RS_FIXTURE_START_FRAME  S >= 1, default 1
##   RS_FIXTURE_STEP_FRAMES  N >= 8, default 10
##   RS_FIXTURE_QUIT_FRAME   >= S+N+11 (the default)

const Textures := preload("res://textures.gd")
const Payload := preload("res://payload.gd")

const START_FRAME_DEFAULT: int = 1
const STEP_FRAMES_DEFAULT: int = 10
const SETTLE_OFFSET: int = 7
const LAST_STEP: int = 1
const COLUMN_X0: int = 16
const COLUMN_DX: int = 88


class RegionNode extends Node2D:
	var texture: Texture2D

	func _draw() -> void:
		if texture != null:
			draw_texture_rect_region(texture, Rect2(0, 0, 48, 48), Rect2(8, 8, 32, 32))

	func set_texture(new_texture: Texture2D) -> void:
		texture = new_texture
		queue_redraw()


var _source: String = "ctex"
var _decoded_dir: String = ""
var _variant: String = ""
var _frame: int = 0
var _start_frame: int = START_FRAME_DEFAULT
var _step_frames: int = STEP_FRAMES_DEFAULT
var _quit_frame: int = 0
var _shot_dir: String = ""
var _step_log_file: FileAccess
var _texture_log_file: FileAccess
var _failed: bool = false
var _current_step: int = 0
## name -> Array of the four drawers [Sprite2D, Sprite2D, NinePatchRect, RegionNode]
var _drawers: Dictionary = {}
## Textures held so they stay alive (the undrawn hdr, the cost textures).
var _held: Array[Texture2D] = []
var _cost_queue: Array[Dictionary] = []


func _ready() -> void:
	if not _read_environment():
		_failed = true
		get_tree().quit(2)
		return
	if _variant == "cost":
		for texture: Dictionary in Textures.TEXTURES:
			var is_cost: bool = texture["cost"]
			if is_cost:
				for family: String in ["desktop", "mobile"]:
					_cost_queue.append({"texture": texture, "family": family})
		_log_step(0, 1, 1)
		print("[fixture] gate8-tex ready: variant=cost, %d textures" % _cost_queue.size())
		return
	var column: int = 0
	for texture: Dictionary in Textures.TEXTURES:
		var drawn: bool = texture["drawn"]
		var is_cost: bool = texture["cost"]
		if not drawn or is_cost:
			continue
		var name: String = texture["name"]
		_drawers[name] = _make_drawers(name, COLUMN_X0 + COLUMN_DX * column)
		column += 1
	_apply_family("desktop")
	_log_step(0, 1, _start_frame + SETTLE_OFFSET)
	print("[fixture] gate8-tex ready: S=%d N=%d quit=%d source=%s" % [_start_frame, _step_frames, _quit_frame, _source])


func _process(_delta: float) -> void:
	if _failed:
		return
	_frame += 1
	if _variant == "cost":
		# One cost texture per frame from frame 2, so each create's decode is its own hook line.
		if _frame >= 2 and not _cost_queue.is_empty():
			var next: Dictionary = _cost_queue.pop_front()
			var texture: Dictionary = next["texture"]
			var family: String = next["family"]
			var made: Texture2D = _load(texture, family)
			if made != null:
				_held.append(made)
		if _frame >= _quit_frame:
			print("[fixture] quitting frame=%d" % _frame)
			get_tree().quit(0)
		return
	var apply_step: int = _step_at(_frame, 0)
	if apply_step >= 1:
		_current_step = apply_step
		_apply_family("mobile")
		_log_step(apply_step, _frame, _frame + SETTLE_OFFSET)
	var settle_step: int = _step_at(_frame, SETTLE_OFFSET)
	if settle_step >= 0:
		_maybe_take_shot("step-%d.png" % settle_step)
	if _frame >= _quit_frame:
		print("[fixture] quitting frame=%d" % _frame)
		get_tree().quit(0)


func _make_drawers(name: String, x: int) -> Array[Node]:
	var a := Sprite2D.new()
	a.name = "A_" + name
	a.centered = false
	a.position = Vector2(x, 16)
	var b := Sprite2D.new()
	b.name = "B_" + name
	b.centered = false
	b.position = Vector2(x, 96)
	if name == "alpha_mip":
		b.scale = Vector2(0.3125, 0.3125)
		b.texture_filter = CanvasItem.TEXTURE_FILTER_LINEAR_WITH_MIPMAPS
	else:
		b.scale = Vector2(1.25, 1.25)
		b.texture_filter = CanvasItem.TEXTURE_FILTER_LINEAR
	var c := NinePatchRect.new()
	c.name = "C_" + name
	c.position = Vector2(x, 186)
	c.size = Vector2(72, 56)
	c.patch_margin_left = 16
	c.patch_margin_top = 16
	c.patch_margin_right = 16
	c.patch_margin_bottom = 16
	var d := RegionNode.new()
	d.name = "D_" + name
	d.position = Vector2(x, 260)
	var nodes: Array[Node] = [a, b, c, d]
	for node: Node in nodes:
		add_child(node)
	return nodes


func _apply_family(family: String) -> void:
	for texture: Dictionary in Textures.TEXTURES:
		var is_cost: bool = texture["cost"]
		if is_cost:
			continue
		var name: String = texture["name"]
		var drawn: bool = texture["drawn"]
		var made: Texture2D = _load(texture, family)
		if not drawn:
			_held.append(made)
			continue
		var nodes: Array[Node] = _drawers[name]
		(nodes[0] as Sprite2D).texture = made
		(nodes[1] as Sprite2D).texture = made
		(nodes[2] as NinePatchRect).texture = made
		(nodes[3] as RegionNode).set_texture(made)


## The texture of `texture` for `family`: the imported .ctex (ctex), or the oracle's decoded payload
## as an ImageTexture (decoded). A lossless import has one variant, used by both families. Under
## `decoded` a refused texture (no payload) is null.
func _load(texture: Dictionary, family: String) -> Texture2D:
	var name: String = texture["name"]
	var v: Dictionary = Textures.variant(texture, family)
	if v.is_empty():
		_error("no %s import of %s (run the import leg)" % [family, name])
		return null
	var key: String = v["key"]
	var path: String = v["path"]
	var used_family: String = "desktop" if key == "" else family
	var made: Texture2D = null
	var described: Dictionary = {}
	if _source == "decoded":
		var payload_path: String = _decoded_dir.path_join("%s.%s.grt1" % [name, used_family])
		if FileAccess.file_exists(payload_path):
			var decoded: Dictionary = Payload.decode(FileAccess.get_file_as_bytes(payload_path))
			var ok: bool = decoded["ok"]
			if ok:
				var image: Image = decoded["image"]
				made = ImageTexture.create_from_image(image)
				described = {"format": Payload.format_name(image), "width": image.get_width(), "height": image.get_height(), "mipmaps": image.has_mipmaps()}
	else:
		var compressed := ResourceLoader.load(path, "", ResourceLoader.CACHE_MODE_IGNORE) as CompressedTexture2D
		made = compressed
		if compressed != null:
			# Headless (the dummy renderer) returns the image texture_2d_create was given
			# (gate8-design.md D6); a rendered run reads it back, format and shape included.
			var image: Image = compressed.get_image()
			if image != null:
				described = {"format": Payload.format_name(image), "width": image.get_width(), "height": image.get_height(), "mipmaps": image.has_mipmaps()}
	_log_texture(name, family, key, path, described)
	return made


## The step whose frame S + N*k + offset is `frame` (step 0 included), else -1.
func _step_at(frame: int, offset: int) -> int:
	var since: int = frame - _start_frame - offset
	if since < 0 or since % _step_frames != 0:
		return -1
	var step: int = since / _step_frames
	return step if step <= LAST_STEP else -1


func _read_environment() -> bool:
	if OS.has_environment("RS_FIXTURE_SOURCE"):
		_source = OS.get_environment("RS_FIXTURE_SOURCE")
		if _source != "ctex" and _source != "decoded":
			_error("RS_FIXTURE_SOURCE must be ctex or decoded (got %s)" % JSON.stringify(_source))
			return false
	if _source == "decoded":
		_decoded_dir = _path_env("RS_FIXTURE_DECODED_DIR")
		if _decoded_dir == "" or _decoded_dir == "!":
			_error("RS_FIXTURE_SOURCE=decoded needs RS_FIXTURE_DECODED_DIR (oracle.gd's output)")
			return false
	if OS.has_environment("RS_FIXTURE_VARIANT"):
		_variant = OS.get_environment("RS_FIXTURE_VARIANT")
		if _variant != "cost":
			_error("RS_FIXTURE_VARIANT must be cost (got %s)" % JSON.stringify(_variant))
			return false
	_start_frame = _int_env("RS_FIXTURE_START_FRAME", START_FRAME_DEFAULT, 1)
	_step_frames = _int_env("RS_FIXTURE_STEP_FRAMES", STEP_FRAMES_DEFAULT, SETTLE_OFFSET + 1)
	var quit_default: int = _start_frame + _step_frames * LAST_STEP + 11
	if _variant == "cost":
		quit_default = 2 + 4 + 4  # the four cost creates (frames 2..5), then a few frames
	_quit_frame = _int_env("RS_FIXTURE_QUIT_FRAME", quit_default, quit_default)
	var step_log: String = _path_env("RS_FIXTURE_STEP_LOG")
	_shot_dir = _path_env("RS_FIXTURE_SHOT_DIR")
	var texture_log: String = _path_env("RS_FIXTURE_TEXTURE_LOG")
	if step_log == "!" or _shot_dir == "!" or texture_log == "!":
		return false
	if step_log != "":
		_step_log_file = FileAccess.open(step_log, FileAccess.WRITE)
		if _step_log_file == null:
			_error("cannot open RS_FIXTURE_STEP_LOG=%s" % step_log)
			return false
	if texture_log != "":
		_texture_log_file = FileAccess.open(texture_log, FileAccess.WRITE)
		if _texture_log_file == null:
			_error("cannot open RS_FIXTURE_TEXTURE_LOG=%s" % texture_log)
			return false
	return true


func _int_env(name: String, fallback: int, minimum: int) -> int:
	if not OS.has_environment(name):
		return fallback
	var text: String = OS.get_environment(name).strip_edges()
	if not text.is_valid_int() or text.to_int() < minimum:
		_error("%s must be an integer >= %d (got %s)" % [name, minimum, JSON.stringify(text)])
		_failed = true
		return fallback
	return text.to_int()


## "" when unset, "!" when set but not absolute.
func _path_env(name: String) -> String:
	if not OS.has_environment(name):
		return ""
	var text: String = OS.get_environment(name)
	if not text.is_absolute_path():
		_error("%s must be an absolute path (got %s)" % [name, JSON.stringify(text)])
		return "!"
	return text


func _error(text: String) -> void:
	printerr("[fixture] error: " + text)


func _log_step(step: int, applied_frame: int, settle_frame: int) -> void:
	if _step_log_file == null:
		return
	_step_log_file.store_line("{\"step\":%d,\"applied_frame\":%d,\"settle_frame\":%d}" % [step, applied_frame, settle_frame])
	_step_log_file.flush()


func _log_texture(name: String, family: String, key: String, path: String, described: Dictionary) -> void:
	if _texture_log_file == null:
		return
	var line: Dictionary = {
		"step": _current_step,
		"frame": 1 if _frame == 0 else _frame,
		"name": name,
		"family": family,
		"key": key,
		"path": path,
		"source": _source,
		"format": described.get("format"),
		"width": described.get("width"),
		"height": described.get("height"),
		"mipmaps": described.get("mipmaps"),
	}
	_texture_log_file.store_line(JSON.stringify(line, "", false))
	_texture_log_file.flush()


## Rendered runs only: headless has no draw path, so frame_post_draw never fires there.
func _maybe_take_shot(file_name: String) -> void:
	if _shot_dir == "":
		return
	if DisplayServer.get_name() == "headless":
		print("[fixture] shot skipped (headless)")
		return
	var out_path: String = _shot_dir.path_join(file_name)
	await RenderingServer.frame_post_draw
	var image: Image = get_viewport().get_texture().get_image()
	var err: Error = image.save_png(out_path)
	print("[fixture] shot saved=%s err=%d" % [out_path, err])
