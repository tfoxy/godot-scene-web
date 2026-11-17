extends Node
## Gate 8 g8hint fixture (render-stream-15.md "Resource hints" and "Size override"). One Node2D
## (`Board`) draws every texture once it is shown; until then a texture exists undrawn. The capture
## arms late (GRC_ARM_DEFER_FRAMES=K-1, GRC_ADOPT=arm), so the pre-arm textures reach the host's
## late-arm warm pass and the armed ones its create path. K = RS_FIXTURE_ARM_FRAME (default 10).
##
##   frame 1 (_ready)  pre-arm, undrawn: p1, p2, p3, p4 (96x96 RGBA8 ImageTextures, each given a
##                     res://hint/<name>.tres path with take_over_path) and edge_a (the S3TC import
##                     of a 30x18 source, stored 32x20, drawn at 30x18 by its size override)
##   frame 3           p2.update(): its content is no longer the one created with its path
##   frame K+5         armed, undrawn: a1, a3, a4 (with paths), a2 (no path) and edge_b (the S3TC
##                     import of a 26x14 source, stored 28x16, loaded with CACHE_MODE_IGNORE)
##   step 1, K+15      Board shows p1, p2, a1, a2 (48x48 each) and the edges magnified 10x
##                     through draw_texture_rect_region over their whole logical size
##   step 2, K+30      p3 and a3 are freed and p4 and a4 updated, all still undrawn
##   step 3, K+45      Board shows p4 and a4 (their new content)
##
## Step 0 is the armed state before any of that (settle K+2); a step settles 7 frames after it is
## applied. The default quit is K+65.
##
## Environment (all optional):
##   RS_FIXTURE_ARM_FRAME    K >= 4, default 10 (the capture's arm frame; the timeline follows it)
##   RS_FIXTURE_STEP_LOG     absolute path: one JSONL line per step
##   RS_FIXTURE_TEXTURE_LOG  absolute path: one JSONL line per texture created, updated or freed
##   RS_FIXTURE_SHOT_DIR     absolute dir: step-<k>.png at each settle frame (rendered runs only)
##   RS_FIXTURE_QUIT_FRAME   >= the default

const SETTLE_OFFSET: int = 7
const SIDE: int = 96
const SMALL: int = 48
const MAGNIFY: int = 10


class Board extends Node2D:
	## Each entry: {"texture": Texture2D, "rect": Rect2, "src": Rect2 (absent: the whole texture)}.
	var entries: Array[Dictionary] = []

	func show_texture(texture: Texture2D, rect: Rect2, src: Rect2 = Rect2()) -> void:
		entries.append({"texture": texture, "rect": rect, "src": src})
		queue_redraw()

	func _draw() -> void:
		for e: Dictionary in entries:
			var texture: Texture2D = e["texture"]
			var rect: Rect2 = e["rect"]
			var src: Rect2 = e["src"]
			if src.has_area():
				draw_texture_rect_region(texture, rect, src)
			else:
				draw_texture_rect(texture, rect, false)


var _frame: int = 0
var _arm_frame: int = 10
var _quit_frame: int = 0
var _shot_dir: String = ""
var _step_log_file: FileAccess
var _texture_log_file: FileAccess
var _failed: bool = false
var _board: Board
var _textures: Dictionary = {}  # name -> Texture2D, while the fixture holds it
var _small_slot: int = 0


func _ready() -> void:
	if not _read_environment():
		_failed = true
		get_tree().quit(2)
		return
	_board = Board.new()
	_board.name = "Board"
	add_child(_board)
	for name: String in ["p1", "p2", "p3", "p4"]:
		_make(name, true)
	var edge_a: Texture2D = _load_edge("edge_a", ResourceLoader.CACHE_MODE_REUSE)
	if edge_a == null:
		_failed = true
		get_tree().quit(2)
		return
	_log_step(0, 1, _arm_frame + 2)
	print("[fixture] hint-scene ready: K=%d quit=%d" % [_arm_frame, _quit_frame])


func _process(_delta: float) -> void:
	if _failed:
		return
	_frame += 1
	var k: int = _arm_frame
	if _frame == 3:
		_update("p2", 1)
	elif _frame == k + 5:
		_make("a1", true)
		_make("a2", false)
		_make("a3", true)
		_make("a4", true)
		if _load_edge("edge_b", ResourceLoader.CACHE_MODE_IGNORE) == null:
			_failed = true
			get_tree().quit(2)
			return
	elif _frame == k + 15:
		for name: String in ["p1", "p2", "a1", "a2"]:
			_show_small(name)
		_show_edge("edge_a", Vector2(8, 8))
		_show_edge("edge_b", Vector2(324, 8))
		_log_step(1, _frame, _frame + SETTLE_OFFSET)
	elif _frame == k + 30:
		_free("p3")
		_free("a3")
		_update("p4", 2)
		_update("a4", 2)
		_log_step(2, _frame, _frame + SETTLE_OFFSET)
	elif _frame == k + 45:
		_show_small("p4")
		_show_small("a4")
		_log_step(3, _frame, _frame + SETTLE_OFFSET)
	var settle: Dictionary = {k + 2: 0, k + 15 + SETTLE_OFFSET: 1, k + 30 + SETTLE_OFFSET: 2,
		k + 45 + SETTLE_OFFSET: 3}
	if settle.has(_frame):
		var step: int = settle[_frame]
		_maybe_take_shot("step-%d.png" % step)
	if _frame >= _quit_frame:
		print("[fixture] quitting frame=%d" % _frame)
		get_tree().quit(0)


## A 96x96 RGBA8 image, a pure function of (name, generation): each texture and each update has
## its own content, hence its own hash.
static func _image(name: String, generation: int) -> Image:
	var base: int = (name.hash() & 0xFFFF) + generation * 977
	var data := PackedByteArray()
	data.resize(SIDE * SIDE * 4)
	var i: int = 0
	for y: int in SIDE:
		for x: int in SIDE:
			data[i] = (x * 5 + base) & 255
			data[i + 1] = (y * 3 + (base >> 4)) & 255
			data[i + 2] = ((x ^ y) + base * 7) & 255
			data[i + 3] = 255
			i += 4
	return Image.create_from_data(SIDE, SIDE, false, Image.FORMAT_RGBA8, data)


func _make(name: String, with_path: bool) -> void:
	var texture: ImageTexture = ImageTexture.create_from_image(_image(name, 0))
	var path: String = ""
	if with_path:
		path = "res://hint/%s.tres" % name
		texture.take_over_path(path)
	_textures[name] = texture
	_log_texture("create", name, texture, path)


func _update(name: String, generation: int) -> void:
	var texture: ImageTexture = _textures[name]
	texture.update(_image(name, generation))
	_log_texture("update", name, texture, "")


## Drops the fixture's only reference: the ImageTexture frees its RID now.
func _free(name: String) -> void:
	var texture: Texture2D = _textures[name]
	_log_texture("free", name, texture, "")
	_textures.erase(name)


## The S3TC import of res://tex/<name>.png, loaded by its .ctex path (as gate8-tex does), so every
## run samples the same block-compressed image.
func _load_edge(name: String, mode: ResourceLoader.CacheMode) -> Texture2D:
	var config := ConfigFile.new()
	if config.load("res://tex/%s.png.import" % name) != OK or not config.has_section_key("remap", "path.s3tc"):
		_error("no s3tc import of res://tex/%s.png (run the import leg)" % name)
		return null
	var path: String = config.get_value("remap", "path.s3tc")
	var texture: Texture2D = ResourceLoader.load(path, "", mode)
	if texture == null:
		_error("cannot load %s" % path)
		return null
	_textures[name] = texture
	_log_texture("create", name, texture, path)
	return texture


func _show_small(name: String) -> void:
	var texture: Texture2D = _textures[name]
	_board.show_texture(texture, Rect2(8 + 56 * _small_slot, 200, SMALL, SMALL))
	_small_slot += 1


## The edge's whole logical size, magnified: Godot normalizes the source rectangle by the logical
## size, so the padded stored columns and rows are sampled too.
func _show_edge(name: String, at: Vector2) -> void:
	var texture: Texture2D = _textures[name]
	var size: Vector2 = Vector2(texture.get_width(), texture.get_height())
	_board.show_texture(texture, Rect2(at, size * MAGNIFY), Rect2(Vector2.ZERO, size))


func _read_environment() -> bool:
	_arm_frame = _int_env("RS_FIXTURE_ARM_FRAME", 10, 4)
	var quit_default: int = _arm_frame + 65
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
	var text: String = OS.get_environment(name)
	if not text.is_valid_int() or text.to_int() < minimum:
		_error("%s must be an integer >= %d (got %s); using %d" % [name, minimum, JSON.stringify(text), fallback])
		return fallback
	return text.to_int()


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


func _log_texture(op: String, name: String, texture: Texture2D, path: String) -> void:
	if _texture_log_file == null:
		return
	var line: Dictionary = {"frame": 1 if _frame == 0 else _frame, "op": op, "name": name,
		"rid": texture.get_rid().get_id(), "width": texture.get_width(), "height": texture.get_height(),
		"path": path}
	_texture_log_file.store_line(JSON.stringify(line, "", false))
	_texture_log_file.flush()


## Rendered runs only: headless has no draw path, so frame_post_draw never fires there.
func _maybe_take_shot(file_name: String) -> void:
	if _shot_dir == "":
		return
	if DisplayServer.get_name() == "headless":
		return
	var out_path: String = _shot_dir.path_join(file_name)
	await RenderingServer.frame_post_draw
	var image: Image = get_viewport().get_texture().get_image()
	var err: Error = image.save_png(out_path)
	print("[fixture] shot saved=%s err=%d" % [out_path, err])
