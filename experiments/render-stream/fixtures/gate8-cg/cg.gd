extends Node
## Gate 8 canvas-group fixture (CG1, render-stream-10.md, README.md): one cell per construction of
## the render-stream/10 item state (`canvas_group` from `clip_children` and `CanvasGroup`,
## `copy_to_backbuffer` from `BackBufferCopy`). Procedural textures only, nearest sampling at
## integer scales (or along a texture axis whose texels are all equal), so no pixel centre's
## colour depends on a texel-boundary tie.
##
##   HPBAR   (40,32)   a full HP bar, the construction results/p3/p3-np.md found in the game: a
##                     background nine-patch, a command-less clip-only `ForegroundContainer`, a
##                     clip-only nine-patch `Mask` (12x10 pointed caps stretched to 232x10) and two
##                     18 px fills under it at y -4 (orange-modulated 229 wide, red self-modulated
##                     232 wide with clip-and-draw). Godot clips the fills to the mask's alpha.
##   HPLOW   (40,72)   the same bar at a lower value: middleground 180, foreground 120 wide, so the
##                     orange shows between them.
##   CLIPDRAW (336,16) a clip-and-draw Sprite2D owner whose 16x16 mask has four alpha rings
##                     (255/192/128/64), over an opaque child overflowing it by 16 px.
##   GROUP   (448,16)  a CanvasGroup (fit_margin 6, clear_margin 12, use_mipmaps, self-modulate
##                     alpha 0.6) over two overlapping translucent ColorRects.
##   NESTED  (544,16)  a clip-only Sprite2D (circle mask) with a child, inside an open CanvasGroup:
##                     GLES3 keeps one open group, so the inner owner draws plainly over its child.
##   BBV     (40,136)  a backdrop, a BackBufferCopy in viewport mode, an overlay square, then a
##                     screen reader (invert) over the cell: the copy predates the overlay.
##   BBR     (136,136) a backdrop, a BackBufferCopy in rect mode over the LEFT half of the cell,
##                     then a screen reader over the whole cell: its right half reads what BBV's
##                     whole-target copy held there (the clear colour), not the backdrop.
##   TGL     (232,136) a diamond mask Sprite2D with a child; step 2 sets its clip_children
##                     disabled -> clip-only (state only: no redraw, so a patch carries it with
##                     `commands: null`).
##   PLAIN   (328,136) a plain sprite (no /10 state: the control cell).
##
## The root is a plain `Node`: every CanvasItem is created in `_ready`, after the loader armed the
## capture in its `_enter_tree` (gate 0's rule), or before a late arm at frame 12 (RS_FIXTURE_ARM=late,
## loader.gd), which the capture then adopts.
##
## Timeline (fixture frames): checkpoint 0 is _ready's scene (applied 1, settles 4); checkpoint 1
## changes nothing (applied 14, settles 17: after a late arm, the adopted scene); step 2 at 20 is
## TGL's toggle (settles 27); quit at 35. The step log holds {"step", "applied_frame",
## "settle_frame"} per checkpoint; under RS_FIXTURE_ARM=late only the checkpoints applied after the
## arm frame are logged (the recording starts there). Environment (all optional):
## RS_FIXTURE_STEP_LOG, RS_FIXTURE_SHOT_DIR (rendered runs only, shots step-<k>.png),
## RS_FIXTURE_QUIT_FRAME (>= 35), RS_FIXTURE_ARM / RS_FIXTURE_ARM_FRAME (loader.gd).

const SIZE: int = 16
const CHECKPOINTS: Array[Array] = [[1, 4], [14, 17], [20, 27]]
const QUIT_DEFAULT: int = 35
const ARM_FRAME_DEFAULT: int = 12

var _frame: int = 0
var _quit_frame: int = QUIT_DEFAULT
var _log_after: int = 0
var _shot_dir: String = ""
var _step_log_file: FileAccess
var _failed: bool = false
var _root: Node2D
var _toggle: Sprite2D


func _ready() -> void:
	if not _read_environment():
		_failed = true
		get_tree().quit(2)
		return
	_root = Node2D.new()
	_root.name = "Cells"
	add_child(_root)
	var bg_tex: ImageTexture = ImageTexture.create_from_image(_bar_background())
	var mask_tex: ImageTexture = ImageTexture.create_from_image(_bar_mask())
	var fill_tex: ImageTexture = ImageTexture.create_from_image(_bar_fill())
	_hp_bar("HpBarFull", Vector2(40, 32), bg_tex, mask_tex, fill_tex, 229.0, 232.0)
	_hp_bar("HpBarLow", Vector2(40, 72), bg_tex, mask_tex, fill_tex, 180.0, 120.0)
	_clip_draw()
	_group()
	_nested()
	var invert: ShaderMaterial = ShaderMaterial.new()
	var shader_resource: Resource = load("res://shaders/invert.gdshader")
	invert.shader = shader_resource as Shader
	_bbv(invert)
	_bbr(invert)
	# TGL: clip_children stays disabled until step 2.
	_toggle = _sprite("TglMask", _root, ImageTexture.create_from_image(_diamond()), Vector2(232, 136), 4.0)
	_sprite("TglChild", _toggle, ImageTexture.create_from_image(_pattern(5)), Vector2(4, 4), 1.0)
	_sprite("Plain", _root, ImageTexture.create_from_image(_pattern(6)), Vector2(328, 136), 4.0)
	print("[fixture] gate8-cg ready: quit=%d" % _quit_frame)


## HPBAR / HPLOW: results/p3/p3-np.md's table, node for node.
func _hp_bar(bar_name: String, at: Vector2, bg_tex: Texture2D, mask_tex: Texture2D, fill_tex: Texture2D,
		middle_width: float, fore_width: float) -> void:
	var container: Control = Control.new()
	container.name = bar_name
	container.mouse_filter = Control.MOUSE_FILTER_IGNORE
	container.position = at
	container.size = Vector2(232, 10)
	_root.add_child(container)
	var background: NinePatchRect = _nine_patch("HpBackground", bg_tex, 9)
	background.position = Vector2(-8, -3)
	background.size = Vector2(248, 16)
	background.modulate = Color(0.55, 0.5, 0.6, 1.0)
	container.add_child(background)
	var fore_container: Control = Control.new()
	fore_container.name = "ForegroundContainer"
	fore_container.mouse_filter = Control.MOUSE_FILTER_IGNORE
	fore_container.size = Vector2(232, 10)
	fore_container.clip_children = CanvasItem.CLIP_CHILDREN_ONLY
	container.add_child(fore_container)
	var mask: NinePatchRect = _nine_patch("Mask", mask_tex, 6)
	mask.size = Vector2(232, 10)
	mask.clip_children = CanvasItem.CLIP_CHILDREN_ONLY
	fore_container.add_child(mask)
	var middle: NinePatchRect = _nine_patch("HpMiddleground", fill_tex, 6)
	middle.position = Vector2(0, -4)
	middle.size = Vector2(middle_width, 18)
	middle.modulate = Color(1.0, 0.6, 0.1, 1.0)
	mask.add_child(middle)
	var fore: NinePatchRect = _nine_patch("HpForeground", fill_tex, 6)
	fore.position = Vector2(0, -4)
	fore.size = Vector2(fore_width, 18)
	fore.self_modulate = Color(1.0, 0.25, 0.2, 1.0)
	fore.clip_children = CanvasItem.CLIP_CHILDREN_AND_DRAW
	mask.add_child(fore)


func _nine_patch(node_name: String, texture: Texture2D, side_margin: int) -> NinePatchRect:
	var patch: NinePatchRect = NinePatchRect.new()
	patch.name = node_name
	patch.mouse_filter = Control.MOUSE_FILTER_IGNORE
	patch.texture = texture
	patch.patch_margin_left = side_margin
	patch.patch_margin_right = side_margin
	patch.patch_margin_top = 0
	patch.patch_margin_bottom = 0
	return patch


## CLIPDRAW: a clip-and-draw owner with partial alpha over an overflowing child.
func _clip_draw() -> void:
	var owner_sprite: Sprite2D = _sprite("ClipDrawOwner", _root, ImageTexture.create_from_image(_rings()), Vector2(336, 16), 4.0)
	owner_sprite.clip_children = CanvasItem.CLIP_CHILDREN_AND_DRAW
	_sprite("ClipDrawChild", owner_sprite, ImageTexture.create_from_image(_pattern(1)), Vector2(4, 4), 1.0)


## GROUP: a CanvasGroup with non-default margins and mipmaps over overlapping translucent rects.
func _group() -> void:
	var group: CanvasGroup = CanvasGroup.new()
	group.name = "Group"
	group.position = Vector2(448, 16)
	group.fit_margin = 6.0
	group.clear_margin = 12.0
	group.use_mipmaps = true
	group.self_modulate = Color(1, 1, 1, 0.6)
	_root.add_child(group)
	group.add_child(_color_rect("GroupRed", Color(0.9, 0.2, 0.2, 0.7), Vector2(0, 0), Vector2(40, 40)))
	group.add_child(_color_rect("GroupBlue", Color(0.2, 0.3, 0.9, 0.7), Vector2(20, 20), Vector2(40, 40)))


## NESTED: a clip-only owner inside an open CanvasGroup (default margins).
func _nested() -> void:
	var outer: CanvasGroup = CanvasGroup.new()
	outer.name = "NestedGroup"
	outer.position = Vector2(544, 16)
	outer.self_modulate = Color(1, 1, 1, 0.7)
	_root.add_child(outer)
	outer.add_child(_color_rect("NestedBackdrop", Color(0.2, 0.8, 0.3, 1.0), Vector2(0, 0), Vector2(64, 64)))
	var inner: Sprite2D = _sprite("NestedMask", outer, ImageTexture.create_from_image(_circle()), Vector2(8, 8), 3.0)
	inner.clip_children = CanvasItem.CLIP_CHILDREN_ONLY
	_sprite("NestedChild", inner, ImageTexture.create_from_image(_pattern(2)), Vector2(2, 2), 1.0)


## BBV: backdrop, a viewport-mode BackBufferCopy, an overlay drawn after the copy, a screen reader.
func _bbv(invert: ShaderMaterial) -> void:
	_sprite("BbvBackdrop", _root, ImageTexture.create_from_image(_pattern(3)), Vector2(40, 136), 4.0)
	var copy: BackBufferCopy = BackBufferCopy.new()
	copy.name = "BbvCopy"
	copy.copy_mode = BackBufferCopy.COPY_MODE_VIEWPORT
	_root.add_child(copy)
	_root.add_child(_color_rect("BbvOverlay", Color(1.0, 0.9, 0.1, 1.0), Vector2(64, 160), Vector2(16, 16)))
	var reader: ColorRect = _color_rect("BbvReader", Color(1, 1, 1, 1), Vector2(40, 136), Vector2(64, 64))
	reader.material = invert
	_root.add_child(reader)


## BBR: backdrop, a rect-mode BackBufferCopy over the cell's left half (the node at the origin, so
## its local rect is the target rect), a screen reader over the whole cell.
func _bbr(invert: ShaderMaterial) -> void:
	_sprite("BbrBackdrop", _root, ImageTexture.create_from_image(_pattern(4)), Vector2(136, 136), 4.0)
	var copy: BackBufferCopy = BackBufferCopy.new()
	copy.name = "BbrCopy"
	copy.copy_mode = BackBufferCopy.COPY_MODE_RECT
	copy.rect = Rect2(136, 136, 32, 64)
	_root.add_child(copy)
	var reader: ColorRect = _color_rect("BbrReader", Color(1, 1, 1, 1), Vector2(136, 136), Vector2(64, 64))
	reader.material = invert
	_root.add_child(reader)


func _process(_delta: float) -> void:
	if _failed:
		return
	_frame += 1
	for k: int in range(CHECKPOINTS.size()):
		var applied: int = CHECKPOINTS[k][0]
		var settle: int = CHECKPOINTS[k][1]
		if _frame == applied:
			if k == 2:
				_toggle.clip_children = CanvasItem.CLIP_CHILDREN_ONLY
			if applied > _log_after:
				_log_step(k, applied, settle)
		if _frame == settle:
			_maybe_take_shot("step-%d.png" % k)
	if _frame >= _quit_frame:
		print("[fixture] quitting frame=%d" % _frame)
		get_tree().quit(0)


## A 16x16 opaque RGBA8 image of 4x4-texel blocks, distinct per seed (gate8-ct's pattern).
static func _pattern(seed: int) -> Image:
	var image: Image = Image.create_empty(SIZE, SIZE, false, Image.FORMAT_RGBA8)
	for y: int in range(SIZE):
		for x: int in range(SIZE):
			var i: int = x / 4
			var j: int = y / 4
			image.set_pixel(x, y, Color8(
				10 + (20 + 11 * seed + 40 * i) % 230,
				10 + (60 + 17 * seed + 45 * j) % 230,
				10 + (200 + 23 * seed + 35 * (i + j)) % 230,
				255))
	return image


## HpBackground's 20x16: a dark frame with a lighter inner band and transparent corners. Columns 9
## and 10 (the stretched centre) are equal.
static func _bar_background() -> Image:
	var image: Image = Image.create_empty(20, 16, false, Image.FORMAT_RGBA8)
	for y: int in range(16):
		for x: int in range(20):
			var edge_x: int = mini(x, 19 - x)
			var edge_y: int = mini(y, 15 - y)
			var alpha: int = 0 if edge_x + edge_y < 2 else 255
			var inner: bool = edge_x >= 2 and edge_y >= 2
			var c: Color = Color8(90, 70, 80, alpha) if inner else Color8(30, 20, 25, alpha)
			image.set_pixel(x, y, c)
	return image


## Mask's 12x10: white, alpha 255 inside two pointed caps meeting at columns 5 and 6 (both full
## height, so the zero-width stretched centre samples a full column whichever neighbour it picks),
## alpha 0 outside the point.
static func _bar_mask() -> Image:
	var image: Image = Image.create_empty(12, 10, false, Image.FORMAT_RGBA8)
	for y: int in range(10):
		for x: int in range(12):
			var c: int = mini(x, 11 - x)
			var half: float = float(c + 1) * 5.0 / 6.0
			var inside: bool = absf(float(y) + 0.5 - 5.0) < half
			image.set_pixel(x, y, Color8(255, 255, 255, 255 if inside else 0))
	return image


## The fills' 15x16: light, constant down every column (the 16 -> 18 stretch's ties are harmless),
## brighter towards the caps' tips; columns 6..8 (the stretched centre) equal.
static func _bar_fill() -> Image:
	var image: Image = Image.create_empty(15, 16, false, Image.FORMAT_RGBA8)
	for y: int in range(16):
		for x: int in range(15):
			var c: int = mini(mini(x, 14 - x), 6)
			var v: int = 250 - 14 * c
			image.set_pixel(x, y, Color8(v, v, v - 20, 255))
	return image


## CLIPDRAW's mask: four square rings of alpha 255/192/128/64 from the centre out, warm colour.
static func _rings() -> Image:
	var image: Image = Image.create_empty(SIZE, SIZE, false, Image.FORMAT_RGBA8)
	var alphas: Array[int] = [255, 192, 128, 64]
	for y: int in range(SIZE):
		for x: int in range(SIZE):
			var d: int = maxi(absi(2 * x - 15), absi(2 * y - 15)) / 4
			image.set_pixel(x, y, Color8(200, 120, 60, alphas[mini(d, 3)]))
	return image


## NESTED's mask: an opaque magenta disc, alpha 0 outside.
static func _circle() -> Image:
	var image: Image = Image.create_empty(SIZE, SIZE, false, Image.FORMAT_RGBA8)
	for y: int in range(SIZE):
		for x: int in range(SIZE):
			var dx: float = float(x) + 0.5 - 8.0
			var dy: float = float(y) + 0.5 - 8.0
			var inside: bool = dx * dx + dy * dy < 49.0
			image.set_pixel(x, y, Color8(220, 40, 200, 255 if inside else 0))
	return image


## TGL's mask: an opaque yellow diamond, alpha 0 outside.
static func _diamond() -> Image:
	var image: Image = Image.create_empty(SIZE, SIZE, false, Image.FORMAT_RGBA8)
	for y: int in range(SIZE):
		for x: int in range(SIZE):
			var inside: bool = absi(2 * x - 15) + absi(2 * y - 15) < 16
			image.set_pixel(x, y, Color8(230, 210, 40, 255 if inside else 0))
	return image


func _sprite(node_name: String, parent: Node, texture: Texture2D, at: Vector2, scale_factor: float) -> Sprite2D:
	var sprite: Sprite2D = Sprite2D.new()
	sprite.name = node_name
	sprite.texture = texture
	sprite.centered = false
	sprite.position = at
	sprite.scale = Vector2(scale_factor, scale_factor)
	parent.add_child(sprite)
	return sprite


static func _color_rect(node_name: String, color: Color, at: Vector2, size: Vector2) -> ColorRect:
	var rect: ColorRect = ColorRect.new()
	rect.name = node_name
	rect.mouse_filter = Control.MOUSE_FILTER_IGNORE
	rect.color = color
	rect.position = at
	rect.size = size
	return rect


func _read_environment() -> bool:
	if OS.has_environment("RS_FIXTURE_QUIT_FRAME"):
		var text: String = OS.get_environment("RS_FIXTURE_QUIT_FRAME").strip_edges()
		if not text.is_valid_int() or text.to_int() < QUIT_DEFAULT:
			_error("RS_FIXTURE_QUIT_FRAME must be an integer >= %d (got %s)" % [QUIT_DEFAULT, JSON.stringify(text)])
			return false
		_quit_frame = text.to_int()
	if OS.get_environment("RS_FIXTURE_ARM") == "late":
		_log_after = ARM_FRAME_DEFAULT
		var arm_text: String = OS.get_environment("RS_FIXTURE_ARM_FRAME").strip_edges()
		if arm_text.is_valid_int():
			_log_after = arm_text.to_int()
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
func _path_env(env_name: String) -> String:
	if not OS.has_environment(env_name):
		return ""
	var text: String = OS.get_environment(env_name)
	if not text.is_absolute_path():
		_error("%s must be an absolute path (got %s)" % [env_name, JSON.stringify(text)])
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
