extends Node2D
## Gate 8 g8vp fixture (render-stream-16.md viewport surfaces). The
## scene (viewport_scene.tscn) holds eleven non-root viewports before a late arm; two more are made
## after it. Every viewport has its own size, so a checker can name each one by its parent chain
## and size without ids. K = RS_FIXTURE_ARM_FRAME (default 12, the loader's arm frame).
##
##   _ready     the scene as authored, plus: the eraser's falloff texture (a synthetic 32x32 radial
##              alpha, tile mode, `blend_sub`), each TextureRect bound to its viewport's
##              get_texture(), ShareB given ShareA's World2D, SnapVP switched to `once` twice, the
##              AnimatedTexture (two frames, paused, so no host's clock moves it)
##   frame 3    (before a late arm) Stroke1 grows and AccumDot moves
##   K          late: the capture arms through its API and adopts
##   K+5        step 1: LateVP (SubViewport.new(), 50x30) shown through its get_texture(), and
##              late_drawing.tscn instantiated (a scene ViewportTexture re-pointed after the arm)
##   K+8        DrawViewport update -> when_visible; Stroke2 grows
##   K+12       the eraser stroke grows; AccumDot moves
##   K+14       the AnimatedTexture shows frame 1
##   K+16       step 2: DrawViewport update -> always; SnapVP -> once again; AccumDot moves
##   K+20       LateVP resized to 70x30
##   K+24       InnerPoly turns, the canvas group fades, the popup window moves
##   K+28       step 3: DrawViewport update -> when_visible; Stroke1 grows
##   K+44       quit (default)
##
## Steps settle 6 frames after they are applied (step 0, the armed state, settles at K+2).
##
## Environment (all optional):
##   RS_FIXTURE_ARM_FRAME    K >= 8, default 12
##   RS_FIXTURE_STEP_LOG     absolute path: one JSONL line per step
##   RS_FIXTURE_SHOT_DIR     absolute dir: step-<k>.png at each settle frame (rendered runs only)
##   RS_FIXTURE_QUIT_FRAME   >= the default

const SETTLE_OFFSET: int = 6
const QUIT_OFFSET: int = 44
const STEP_OFFSETS: Array[int] = [0, 5, 16, 28]

var _frame: int = 0
var _arm_frame: int = 12
var _quit_frame: int = 0
var _shot_dir: String = ""
var _step_log_file: FileAccess
var _failed: bool = false
var _anim: AnimatedTexture
var _late_vp: SubViewport
var _late_view: TextureRect


func _ready() -> void:
	if not _read_environment():
		_failed = true
		get_tree().quit(2)
		return
	var eraser: Line2D = $DrawViewport/Eraser
	eraser.texture = ImageTexture.create_from_image(_falloff(32))
	_show($View3D as TextureRect, $VP3D as SubViewport)
	_show($ViewEmpty as TextureRect, $EmptyCamVP as SubViewport)
	_show($ViewSnap as TextureRect, $SnapVP as SubViewport)
	_show($ViewAccum as TextureRect, $AccumVP as SubViewport)
	_show($ViewShareA as TextureRect, $ShareA as SubViewport)
	_show($ViewShareB as TextureRect, $ShareB as SubViewport)
	_show($ViewOpaque as TextureRect, $OpaqueVP as SubViewport)
	var share_a: SubViewport = $ShareA
	var share_b: SubViewport = $ShareB
	share_b.world_2d = share_a.world_2d
	var snap: SubViewport = $SnapVP
	snap.render_target_update_mode = SubViewport.UPDATE_ONCE
	snap.render_target_update_mode = SubViewport.UPDATE_ONCE
	_anim = AnimatedTexture.new()
	_anim.frames = 2
	_anim.pause = true
	_anim.set_frame_texture(0, ImageTexture.create_from_image(_solid(8, Color(0.9, 0.2, 0.2, 1))))
	_anim.set_frame_texture(1, ImageTexture.create_from_image(_solid(8, Color(0.2, 0.2, 0.9, 1))))
	var anim_rect: TextureRect = $Anim
	anim_rect.texture = _anim
	print("[fixture] viewport-scene ready: K=%d quit=%d viewports=%d" % [_arm_frame, _quit_frame, _viewport_count()])


func _process(_delta: float) -> void:
	if _failed:
		return
	_frame += 1
	var k: int = _frame - _arm_frame
	if _frame == 3:
		_grow($DrawViewport/Stroke1 as Line2D, Vector2(380, 220))
		_move_accum(Vector2(20, 14))
	if _frame == _arm_frame:
		print("[fixture] viewports frame=%d count=%d" % [_frame, _viewport_count()])
	match k:
		5:
			_make_late()
		8:
			_set_update($DrawViewport as SubViewport, SubViewport.UPDATE_WHEN_VISIBLE)
			_grow($DrawViewport/Stroke2 as Line2D, Vector2(300, 520))
		12:
			_grow($DrawViewport/Eraser as Line2D, Vector2(330, 210))
			_move_accum(Vector2(34, 30))
		14:
			_anim.current_frame = 1
		16:
			_set_update($DrawViewport as SubViewport, SubViewport.UPDATE_ALWAYS)
			_set_update($SnapVP as SubViewport, SubViewport.UPDATE_ONCE)
			_move_accum(Vector2(48, 44))
		20:
			_late_vp.size = Vector2i(70, 30)
			_late_view.offset_right = _late_view.offset_left + 70.0
		24:
			var inner: Polygon2D = $OuterBox/OuterVP/InnerBox/InnerVP/InnerPoly
			inner.rotation = 0.4
			var group: CanvasGroup = $OuterBox/OuterVP/Group
			group.self_modulate = Color(1, 1, 1, 0.6)
			var popup: Window = $Popup
			popup.position = Vector2i(492, 282)
		28:
			_set_update($DrawViewport as SubViewport, SubViewport.UPDATE_WHEN_VISIBLE)
			_grow($DrawViewport/Stroke1 as Line2D, Vector2(420, 300))
	for step: int in range(STEP_OFFSETS.size()):
		var applied: int = _arm_frame + STEP_OFFSETS[step]
		var settle: int = (_arm_frame + 2) if step == 0 else (applied + SETTLE_OFFSET)
		if _frame == applied:
			_log_step(step, applied, settle)
		if _frame == settle:
			_maybe_take_shot("step-%d.png" % step)
	if _frame >= _quit_frame:
		print("[fixture] quitting frame=%d viewports=%d" % [_frame, _viewport_count()])
		get_tree().quit(0)


## (c): a SubViewport made by script after the arm, displayed through its own get_texture(); and a
## scene with a `viewport_path` ViewportTexture, whose proxy is re-pointed after the arm.
func _make_late() -> void:
	_late_vp = SubViewport.new()
	_late_vp.name = "LateVP"
	_late_vp.size = Vector2i(50, 30)
	_late_vp.transparent_bg = true
	_late_vp.disable_3d = true
	_late_vp.render_target_update_mode = SubViewport.UPDATE_ALWAYS
	var poly: Polygon2D = Polygon2D.new()
	poly.color = Color(0.95, 0.95, 0.4, 1)
	poly.polygon = PackedVector2Array([Vector2(4, 4), Vector2(46, 4), Vector2(25, 26)])
	_late_vp.add_child(poly)
	add_child(_late_vp)
	_late_view = TextureRect.new()
	_late_view.name = "ViewLate"
	_late_view.mouse_filter = Control.MOUSE_FILTER_IGNORE
	_late_view.expand_mode = TextureRect.EXPAND_IGNORE_SIZE
	_late_view.position = Vector2(312, 220)
	_late_view.size = Vector2(50, 30)
	_late_view.texture = _late_vp.get_texture()
	add_child(_late_view)
	var scene: PackedScene = load("res://late_drawing.tscn")
	var drawing: Node2D = scene.instantiate() as Node2D
	drawing.position = Vector2(400, 220)
	add_child(drawing)


func _show(rect: TextureRect, viewport: SubViewport) -> void:
	rect.texture = viewport.get_texture()


func _set_update(viewport: SubViewport, mode: SubViewport.UpdateMode) -> void:
	viewport.render_target_update_mode = mode


func _grow(line: Line2D, point: Vector2) -> void:
	line.add_point(point)


func _move_accum(to: Vector2) -> void:
	var dot: Polygon2D = $AccumVP/AccumDot
	dot.position = to


func _viewport_count() -> int:
	var count: int = 0
	for node: Node in _all_nodes(self):
		if node is Viewport:
			count += 1
	return count


func _all_nodes(root: Node) -> Array[Node]:
	var out: Array[Node] = [root]
	for child: Node in root.get_children(true):
		out.append_array(_all_nodes(child))
	return out


## A radial alpha falloff (white, alpha 1 at the centre to 0 at the rim): the eraser's brush.
func _falloff(side: int) -> Image:
	var image: Image = Image.create_empty(side, side, false, Image.FORMAT_RGBA8)
	var c: float = (side - 1) * 0.5
	for y: int in range(side):
		for x: int in range(side):
			var d: float = Vector2(x - c, y - c).length() / c
			image.set_pixel(x, y, Color(1, 1, 1, clampf(1.0 - d * d, 0.0, 1.0)))
	return image


func _solid(side: int, color: Color) -> Image:
	var image: Image = Image.create_empty(side, side, false, Image.FORMAT_RGBA8)
	image.fill(color)
	return image


func _read_environment() -> bool:
	if OS.has_environment("RS_FIXTURE_ARM_FRAME"):
		var text: String = OS.get_environment("RS_FIXTURE_ARM_FRAME").strip_edges()
		if not text.is_valid_int() or text.to_int() < 8:
			_error("RS_FIXTURE_ARM_FRAME must be an integer >= 8 (got %s)" % JSON.stringify(text))
			return false
		_arm_frame = text.to_int()
	var quit_default: int = _arm_frame + QUIT_OFFSET
	_quit_frame = quit_default
	if OS.has_environment("RS_FIXTURE_QUIT_FRAME"):
		var text: String = OS.get_environment("RS_FIXTURE_QUIT_FRAME").strip_edges()
		if not text.is_valid_int() or text.to_int() < quit_default:
			_error("RS_FIXTURE_QUIT_FRAME must be an integer >= %d (got %s)" % [quit_default, JSON.stringify(text)])
			return false
		_quit_frame = text.to_int()
	var step_log: String = _path_env("RS_FIXTURE_STEP_LOG")
	_shot_dir = _path_env("RS_FIXTURE_SHOT_DIR")
	if step_log == "!" or _shot_dir == "!":
		return false
	if step_log != "":
		_step_log_file = FileAccess.open(step_log, FileAccess.WRITE)
		if _step_log_file == null:
			_error("cannot open RS_FIXTURE_STEP_LOG=%s" % step_log)
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
