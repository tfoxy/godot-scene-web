extends Node
## Gate 8 adoption fixture (G8a, gate8-design.md Q2 "Fixture"). The scene (adopt.tscn) holds nested
## Node2D/Control transforms, modulate and self-modulate, z and behind-parent, a subtree hidden
## before arm and shown after it, a clip_contents Control, two top-level items, a CanvasLayer
## (layer 2) with a CanvasModulate, texture filter/repeat inheritance, and one RS-only item
## (`_residue`, RenderingServer.canvas_item_create in `_ready`: the residue adoption cannot reach).
## Textures are created after arm only (pre-arm resources are G8r's). The timeline, in fixture
## frames (the main-loop iteration; the loader arms at K = RS_FIXTURE_ARM_FRAME, default 12):
##
##   _ready     the scene as authored; the residue item (root canvas, draw index 1000, no commands)
##   frame 5    (before arm) World moves, TopA is raised above TopB (move_to_front), Hidden hides,
##              World's filter becomes linear, UI moves
##   K          the capture arms (late). Checkpoint 0 settles at K+2.
##   K+4        Hidden shows; a 4x4 checker ImageTexture is created and drawn by Sprite (scaled
##              8x, filter inherited from World) and Tiled (TextureRect tile, repeat enabled); the
##              residue item is moved (RenderingServer.canvas_item_set_transform); World's
##              modulate changes. Checkpoint 1 settles at K+11.
##   K+14       Behind moves to index 0 (move_child), TopB is raised again, Spin turns, Inner
##              clips, the CanvasModulate colour and the layer offset change. Checkpoint 2: K+21.
##   K+24       the layer hides, a new item `Late` is added under World, ZHigh is freed, UI
##              moves. Checkpoint 3: K+31.
##   K+38       quit
##
## The step log holds the four checkpoints only ({"step": 0..3, "applied_frame", "settle_frame"})
## in every leg, so born, late and the reference shoot the same frames.
##
## Environment (all optional):
##   RS_FIXTURE_STEP_LOG    absolute path: one JSONL line per checkpoint
##   RS_FIXTURE_SHOT_DIR    absolute dir: step-<k>.png at each settle frame (rendered runs only)
##   RS_FIXTURE_PROBE_LOG   absolute path: adopt-no-scene-mutation's probe, one JSONL line at K-1
##                          and one at K+1 (a hash of every node's stored properties, and the
##                          number of `draw` signals so far)
##   RS_FIXTURE_QUIT_FRAME  >= K+38 (the default)

const SETTLE_OFFSET: int = 7
const PRE_ARM_FRAME: int = 5

var _frame: int = 0
var _arm_frame: int = 12
var _quit_frame: int = 0
var _shot_dir: String = ""
var _step_log_file: FileAccess
var _probe_log_file: FileAccess
var _failed: bool = false
var _residue: RID = RID()
var _draws: int = 0
## [applied_frame, settle_frame] per checkpoint
var _checkpoints: Array[Array] = []


func _ready() -> void:
	var loader: Node = get_node_or_null("/root/GrcLoader")
	if loader != null:
		var frame: int = loader.get("arm_frame")
		_arm_frame = frame
	if not _read_environment():
		_failed = true
		get_tree().quit(2)
		return
	_checkpoints = [
		[_arm_frame, _arm_frame + 2],
		[_arm_frame + 4, _arm_frame + 4 + SETTLE_OFFSET],
		[_arm_frame + 14, _arm_frame + 14 + SETTLE_OFFSET],
		[_arm_frame + 24, _arm_frame + 24 + SETTLE_OFFSET],
	]
	# The residue: an RS-only item with no node, parented to the root canvas, drawn nothing.
	_residue = RenderingServer.canvas_item_create()
	RenderingServer.canvas_item_set_parent(_residue, get_viewport().find_world_2d().canvas)
	RenderingServer.canvas_item_set_draw_index(_residue, 1000)
	for node: Node in _all_nodes(self):
		var item := node as CanvasItem
		if item != null:
			item.draw.connect(_on_draw)
	print("[fixture] gate8-adopt ready: K=%d quit=%d" % [_arm_frame, _quit_frame])


func _exit_tree() -> void:
	if _residue.is_valid():
		RenderingServer.free_rid(_residue)
		_residue = RID()


func _on_draw() -> void:
	_draws += 1


func _process(_delta: float) -> void:
	if _failed:
		return
	_frame += 1
	if _frame == _arm_frame - 1 or _frame == _arm_frame + 1:
		_probe()
	if _frame == PRE_ARM_FRAME:
		_step_pre_arm()
	for k: int in range(_checkpoints.size()):
		var applied: int = _checkpoints[k][0]
		var settle: int = _checkpoints[k][1]
		if _frame == applied:
			match k:
				1:
					_step_1()
				2:
					_step_2()
				3:
					_step_3()
			_log_step(k, applied, settle)
		if _frame == settle:
			_maybe_take_shot("step-%d.png" % k)
	if _frame >= _quit_frame:
		print("[fixture] quitting frame=%d draws=%d" % [_frame, _draws])
		get_tree().quit(0)


func _step_pre_arm() -> void:
	var world := $World as Node2D
	world.position += Vector2(4, 0)
	($World/TopA as Node2D).move_to_front()
	($World/Hidden as Node2D).hide()
	world.texture_filter = CanvasItem.TEXTURE_FILTER_LINEAR
	($UI as Control).position += Vector2(0, 4)


func _step_1() -> void:
	($World/Hidden as Node2D).show()
	var image := Image.create_empty(4, 4, false, Image.FORMAT_RGBA8)
	for y: int in range(4):
		for x: int in range(4):
			var on: bool = (x + y) % 2 == 0
			image.set_pixel(x, y, Color(1, 0.8, 0.2, 1) if on else Color(0.2, 0.4, 0.6, 1))
	var texture := ImageTexture.create_from_image(image)
	($World/Sprite as Sprite2D).texture = texture
	($UI/Tiled as TextureRect).texture = texture
	RenderingServer.canvas_item_set_transform(_residue, Transform2D(0.0, Vector2(5, 5)))
	($World as Node2D).modulate = Color(1, 1, 0.8, 1)


func _step_2() -> void:
	var world := $World as Node2D
	world.move_child($World/Behind, 0)
	($World/TopB as Node2D).move_to_front()
	($World/Spin as Node2D).rotation += 0.2
	($UI/Inner as Control).clip_contents = true
	($Layer/Tint as CanvasModulate).color = Color(0.8, 1, 1, 1)
	($Layer as CanvasLayer).offset = Vector2(10, 210)


func _step_3() -> void:
	($Layer as CanvasLayer).hide()
	var box_script: GDScript = load("res://box.gd")
	var late: Node2D = box_script.new()
	late.name = "Late"
	late.set("size", Vector2(50, 20))
	late.set("color", Color(0.6, 1, 0.6, 1))
	late.position = Vector2(30, 250)
	($World as Node2D).add_child(late)
	($World/ZHigh as Node2D).queue_free()
	($UI as Control).position += Vector2(-4, 0)


## adopt-no-scene-mutation (Q2): a hash of every node's stored properties under this one (itself
## included), and the draw signals counted so far. Adoption may move only the draw count.
func _probe() -> void:
	if _probe_log_file == null:
		return
	var text: String = ""
	var count: int = 0
	for node: Node in _all_nodes(self):
		count += 1
		text += str(get_path_to(node)) + "\n"
		for p: Dictionary in node.get_property_list():
			var usage: int = p["usage"]
			if usage & PROPERTY_USAGE_STORAGE == 0:
				continue
			var prop: String = p["name"]
			text += "  %s=%s\n" % [prop, var_to_str(node.get(prop))]
	var line: Dictionary = {
		"frame": _frame,
		"nodes": count,
		"hash": text.sha256_text(),
		"draws": _draws,
	}
	_probe_log_file.store_line(JSON.stringify(line, "", false))
	_probe_log_file.flush()


func _all_nodes(root: Node) -> Array[Node]:
	var out: Array[Node] = [root]
	for child: Node in root.get_children(true):
		out.append_array(_all_nodes(child))
	return out


func _read_environment() -> bool:
	var quit_default: int = _arm_frame + 38
	_quit_frame = quit_default
	if OS.has_environment("RS_FIXTURE_QUIT_FRAME"):
		var text: String = OS.get_environment("RS_FIXTURE_QUIT_FRAME").strip_edges()
		if not text.is_valid_int() or text.to_int() < quit_default:
			_error("RS_FIXTURE_QUIT_FRAME must be an integer >= %d (got %s)" % [quit_default, JSON.stringify(text)])
			return false
		_quit_frame = text.to_int()
	var step_log: String = _path_env("RS_FIXTURE_STEP_LOG")
	_shot_dir = _path_env("RS_FIXTURE_SHOT_DIR")
	var probe_log: String = _path_env("RS_FIXTURE_PROBE_LOG")
	if step_log == "!" or _shot_dir == "!" or probe_log == "!":
		return false
	if step_log != "":
		_step_log_file = FileAccess.open(step_log, FileAccess.WRITE)
		if _step_log_file == null:
			_error("cannot open RS_FIXTURE_STEP_LOG=%s" % step_log)
			return false
	if probe_log != "":
		_probe_log_file = FileAccess.open(probe_log, FileAccess.WRITE)
		if _probe_log_file == null:
			_error("cannot open RS_FIXTURE_PROBE_LOG=%s" % probe_log)
			return false
	return true


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
