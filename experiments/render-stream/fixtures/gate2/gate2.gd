extends Node
## Gate 2 textures fixture (../../protocol/gate2-design.md "Q6. Fixture `fixtures/gate2/` (G2a)").
##
## The root is a plain `Node`; every `CanvasItem` and every texture is created in `_ready()` or
## later, after `GrcLoader` armed the capture extension in its own `_enter_tree()` (gate 0 route
## (a)) -- except the `unsupported` variant's `PRE`, which `loader.gd` makes before arming on
## purpose. Twelve steps (0..11) each exercise one texture behaviour; expected.json holds the
## derived per-step draws, regions, exclusions and RenderingServer call census, and this
## script's literals must match it exactly.
##
## Every texel component is a multiple of 51 (0, .2, .4, .6, .8, 1) and every image is built from
## bytes, so texel bytes are exact; every modulate is white.
##
## Environment (all optional; an invalid value prints an error and quits 2):
##   RS_FIXTURE_STEP_LOG     absolute path: one JSONL line per step at its applied frame
##   RS_FIXTURE_TEXTURE_LOG  absolute path: one JSONL line per texture operation this script
##                           makes, with the payload SHA-256 of every image it hands to a create
##                           or an update, computed by payload.gd before any mutation
##   RS_FIXTURE_SHOT_DIR     absolute dir: step-<k>.png at each settle frame (rendered runs only)
##   RS_FIXTURE_START_FRAME  S >= 1, default 1
##   RS_FIXTURE_STEP_FRAMES  N >= 8, default 10 (step k >= 1 at S+N*k, settled at S+N*k+7)
##   RS_FIXTURE_QUIT_FRAME   >= S+N*11+11 (the default)
##   RS_FIXTURE_SHOT_FRAMES  CSV of frames >= 1: also frame-<n>.png at each (rendered runs only)
##   RS_FIXTURE_VARIANT      unset (the main fixture), animate (ANIM is update()d every frame),
##                           unsupported (U1, an RGBAF texture, and U2, drawing loader.gd's
##                           pre-arm PRE, draw from step 0), canvas (step 11's SC draws through a
##                           CanvasTexture instead, G2d) or canvas-normal (canvas, plus a
##                           normal_texture: G2d's unsupported leg)

const Payload := preload("res://payload.gd")


## A `Node2D` whose `_draw()` paints a list of axis-aligned (Rect2, Color) pairs, in order.
class RectNode extends Node2D:
	var rects: Array[Rect2] = []
	var colors: Array[Color] = []

	func _draw() -> void:
		for i: int in rects.size():
			draw_rect(rects[i], colors[i])

	func set_rects(new_rects: Array[Rect2], new_colors: Array[Color]) -> void:
		rects = new_rects
		colors = new_colors
		queue_redraw()


## `DR`: one `draw_texture_rect_region` of the shared texture, in one of three modes.
##   0 (step 0): 32x32 from source (4,4,8,8), a region across all four quadrants
##   1 (step 1): 32x32 from source (4,0,8,8), transposed
##   2 (step 5): 32x32 from source (0,0,32,32), beyond a 16x16 texture: the item repeat shows
class RegionNode extends Node2D:
	var texture: Texture2D
	var mode: int = 0

	func _draw() -> void:
		match mode:
			0:
				draw_texture_rect_region(texture, Rect2(0, 0, 32, 32), Rect2(4, 4, 8, 8))
			1:
				draw_texture_rect_region(texture, Rect2(0, 0, 32, 32), Rect2(4, 0, 8, 8), Color(1, 1, 1, 1), true)
			_:
				draw_texture_rect_region(texture, Rect2(0, 0, 32, 32), Rect2(0, 0, 32, 32))

	func set_mode(new_mode: int) -> void:
		mode = new_mode
		queue_redraw()


const LAST_STEP: int = 11
const SETTLE_OFFSET: int = 7
const START_FRAME_DEFAULT: int = 1
const STEP_FRAMES_DEFAULT: int = 10
const QUIT_AFTER_LAST_SETTLE: int = 4  # quit default S + N*11 + 11 = last settle + 4

const MARKER_COLORS: Array[Color] = [
	Color(0, 0, 0, 1),
	Color(1, 1, 0, 1),
	Color(0, 1, 1, 1),
	Color(0.4, 0, 0.4, 1),
	Color(0, 0.4, 0, 1),
	Color(0.4, 0, 0, 1),
	Color(0, 0, 0.4, 1),
	Color(0.8, 0.4, 0.8, 1),
	Color(0.4, 0.6, 0.8, 1),
	Color(0.8, 0.6, 0.4, 1),
	Color(0.2, 0.6, 0.2, 1),
	Color(1, 0.2, 1, 1),
]

# Texture contents as bytes (expected.json "textures"). Rect overrides are [x, y, w, h, r, g, b, a]
# in texels, applied in order over the base colour.
const A0_BASE: Array[int] = [0, 0, 0, 255]
const A0_RECTS: Array[Array] = [
	[0, 0, 8, 8, 255, 0, 0, 255],
	[8, 0, 8, 8, 0, 255, 0, 255],
	[0, 8, 8, 8, 0, 0, 255, 255],
	[8, 8, 8, 8, 255, 255, 255, 255],
]
const A1_RECTS: Array[Array] = [
	[0, 0, 8, 8, 51, 102, 153, 255],
	[8, 0, 8, 8, 204, 153, 102, 255],
	[0, 8, 8, 8, 102, 204, 51, 255],
	[8, 8, 8, 8, 0, 0, 0, 255],
]
const A2_RECTS: Array[Array] = [
	[0, 0, 16, 16, 255, 153, 0, 255],
	[16, 0, 16, 16, 153, 0, 255, 255],
	[0, 16, 16, 16, 0, 153, 153, 255],
	[16, 16, 16, 16, 153, 153, 153, 255],
]
const C_BASE: Array[int] = [102, 204, 255, 255]
const C_RECTS: Array[Array] = [[0, 0, 8, 8, 255, 51, 153, 255]]
const D_BASE: Array[int] = [153, 102, 51, 255]
const D_RECTS: Array[Array] = [[8, 8, 8, 8, 0, 255, 102, 255]]
const E_BASE: Array[int] = [51, 255, 204, 255]
const E_RECTS: Array[Array] = [[0, 0, 4, 1, 255, 102, 0, 255]]
# B (LA8): L=1, A=1 where x+y is even, L=0, A=0 elsewhere; B1 (RGBA8, step 7): white at alpha .4
# where x+y is even, transparent black elsewhere; M (RGBA8 64x64): white where x+y is even, black
# elsewhere, then generate_mipmaps().
const B0_EVEN: Array[int] = [255, 255]
const B0_ODD: Array[int] = [0, 0]
const B1_EVEN: Array[int] = [255, 255, 255, 102]
const B1_ODD: Array[int] = [0, 0, 0, 0]
const M_EVEN: Array[int] = [255, 255, 255, 255]
const M_ODD: Array[int] = [0, 0, 0, 255]
const U1_COLOR: Color = Color(0.2, 0.6, 1, 1)

var g: Node2D
var s1: Sprite2D
var s2: Sprite2D
var tr: TextureRect
var dr: RegionNode
var s3: Sprite2D
var bg: RectNode
var sb: Sprite2D
var sd: Sprite2D
var mm: Sprite2D
var sc: Sprite2D
var anim_sprite: Sprite2D
var u1_sprite: Sprite2D
var u2_sprite: Sprite2D
var marker: RectNode

var _a: ImageTexture
var _atwin: ImageTexture
var _b: ImageTexture
var _m: ImageTexture
var _c: ImageTexture
var _d: ImageTexture
var _anim: ImageTexture
var _u1: ImageTexture
var _p1: RID
var _p2: RID
var _raw1: RID
var _raw2: RID
var _ct: CanvasTexture

var _frame: int = 0
var _start_frame: int = START_FRAME_DEFAULT
var _step_frames: int = STEP_FRAMES_DEFAULT
var _quit_frame: int = 0
var _variant: String = ""
var _shot_dir: String = ""
var _shot_frames: Array[int] = []
var _step_log_file: FileAccess
var _texture_log_file: FileAccess
var _failed: bool = false
var _current_step: int = 0


func _ready() -> void:
	if not _read_environment():
		_failed = true
		get_tree().quit(2)
		return

	# Step 0's textures: the shared A, its twin (a separate ImageTexture from a copy of A0's
	# image), B (LA8), M (mipmapped, unused until step 9) and two raw placeholders.
	var a0 := _rgba8(16, 16, A0_BASE, A0_RECTS)
	_a = _create_texture("A", a0)
	_atwin = _create_texture("Atwin", a0.duplicate() as Image)
	_b = _create_texture("B", _checker(4, 4, Image.FORMAT_LA8, B0_EVEN, B0_ODD))
	var m_image := _checker(64, 64, Image.FORMAT_RGBA8, M_EVEN, M_ODD)
	m_image.generate_mipmaps()
	_m = _create_texture("M", m_image)
	_p1 = RenderingServer.texture_2d_placeholder_create()
	_log_op("texture_2d_placeholder_create", "P1")
	_p2 = RenderingServer.texture_2d_placeholder_create()
	_log_op("texture_2d_placeholder_create", "P2")

	# Nodes, in tree (paint) order. Every Sprite2D is centered = false, so its position is its
	# top-left corner and a flip mirrors it in place.
	g = Node2D.new()
	g.name = "G"
	s1 = _sprite("S1", _a, Vector2(40, 40), 2.0)
	s2 = _sprite("S2", _a, Vector2(120, 40), 2.0)
	g.add_child(s1)
	g.add_child(s2)
	tr = TextureRect.new()
	tr.name = "TR"
	tr.texture = _a
	tr.stretch_mode = TextureRect.STRETCH_SCALE
	tr.position = Vector2(200, 40)
	tr.size = Vector2(32, 32)
	dr = RegionNode.new()
	dr.name = "DR"
	dr.texture = _a
	dr.position = Vector2(264, 40)
	s3 = _sprite("S3", _atwin, Vector2(320, 40), 2.0)
	bg = RectNode.new()
	bg.name = "BG"
	bg.position = Vector2(368, 32)
	bg.rects = [Rect2(0, 0, 24, 48), Rect2(24, 0, 24, 48)]
	bg.colors = [Color(0.8, 0.2, 0.2, 1), Color(0.2, 0.8, 0.2, 1)]
	sb = _sprite("SB", _b, Vector2(376, 40), 8.0)
	sd = _sprite("SD", null, Vector2(40, 120), 2.0)
	mm = _sprite("MM", null, Vector2(120, 120), 0.25)
	# SC (G2d): no texture until step 11, when it gets a CanvasTexture (diffuse A).
	sc = _sprite("SC", null, Vector2(200, 120), 1.0)
	var nodes: Array[Node] = [g, tr, dr, s3, bg, sb, sd, mm, sc]
	if _variant == "animate":
		_anim = _create_texture("ANIM", _anim_image(1))
		anim_sprite = _sprite("ANIM", _anim, Vector2(280, 120), 4.0)
		nodes.append(anim_sprite)
	elif _variant == "unsupported":
		var u1_image := Image.create_empty(4, 4, false, Image.FORMAT_RGBAF)
		u1_image.fill(U1_COLOR)
		_u1 = _create_texture("U1", u1_image)
		u1_sprite = _sprite("U1", _u1, Vector2(336, 120), 8.0)
		var loader: Node = get_node("/root/GrcLoader")
		var pre: ImageTexture = loader.get("pre_texture")
		u2_sprite = _sprite("U2", pre, Vector2(392, 120), 8.0)
		nodes.append(u1_sprite)
		nodes.append(u2_sprite)
	marker = RectNode.new()
	marker.name = "Marker"
	marker.position = Vector2(592, 16)
	marker.rects = [Rect2(0, 0, 32, 32)]
	marker.colors = [MARKER_COLORS[0]]
	nodes.append(marker)
	for node: Node in nodes:
		add_child(node)

	# Raw RenderingServer items on the root canvas, through the hooked server, drawing the two
	# placeholders. Draw indices 1000/1001 never tie with the node items' indices.
	var root_canvas: RID = get_viewport().get_world_2d().canvas
	_raw1 = _raw_item(root_canvas, Vector2(432, 40), 1000, _p1)
	_raw2 = _raw_item(root_canvas, Vector2(480, 40), 1001, _p2)

	# Step 0 is the `_ready` state, applied at the frame stamp of everything that runs during
	# `initialize()` (1), settled at S + 7.
	_log_step(0, 1, _start_frame + SETTLE_OFFSET)
	print("[fixture] gate2 ready: S=%d N=%d quit=%d variant=%s" % [_start_frame, _step_frames, _quit_frame, _variant if _variant != "" else "<none>"])


func _process(_delta: float) -> void:
	if _failed:
		return
	_frame += 1

	var apply_step: int = _step_at(_frame, 0)
	if apply_step >= 1:
		_current_step = apply_step
		_apply_step(apply_step)
		_log_step(apply_step, _frame, _frame + SETTLE_OFFSET)

	if _variant == "animate":
		var anim_image := _anim_image(_frame)
		_log_texture("texture_2d_update", "ANIM", "main", Payload.describe(anim_image))
		_anim.update(anim_image)

	var settle_step: int = _step_at(_frame, SETTLE_OFFSET)
	if settle_step >= 0:
		_maybe_take_shot("step-%d.png" % settle_step)
	if _shot_frames.has(_frame):
		_maybe_take_shot("frame-%d.png" % _frame)

	if _frame >= _quit_frame:
		print("[fixture] quitting frame=%d" % _frame)
		get_tree().quit(0)


## The step whose frame S + N*k + offset is `frame` (step 0 included), else -1.
func _step_at(frame: int, offset: int) -> int:
	var since: int = frame - _start_frame - offset
	if since < 0 or since % _step_frames != 0:
		return -1
	var step: int = since / _step_frames
	return step if step <= LAST_STEP else -1


func _apply_step(step: int) -> void:
	match step:
		1:
			# Flips (negative sizes), a region and a transpose.
			s1.flip_h = true
			s2.flip_v = true
			tr.flip_h = true
			dr.set_mode(1)
		2:
			# Transform only: no texture call, no fetch, no upload.
			g.position = Vector2(0, 200)
			s3.transform = Transform2D(Vector2(0, 2), Vector2(-2, 0), Vector2(352, 40))
		3:
			# An item filter, and clip_uv on the wire.
			s2.texture_filter = CanvasItem.TEXTURE_FILTER_LINEAR
			s2.region_enabled = true
			s2.region_rect = Rect2(0, 0, 16, 16)
			s2.region_filter_clip_enabled = true
		4:
			# The root viewport's default filter: no item call, every default-filter drawer changes.
			get_viewport().canvas_item_default_texture_filter = Viewport.DEFAULT_CANVAS_ITEM_TEXTURE_FILTER_LINEAR
		5:
			get_viewport().canvas_item_default_texture_filter = Viewport.DEFAULT_CANVAS_ITEM_TEXTURE_FILTER_NEAREST
			# Tile forces repeat; mirror repeat beyond the texture.
			tr.stretch_mode = TextureRect.STRETCH_TILE
			tr.size = Vector2(48, 32)
			dr.texture_repeat = CanvasItem.TEXTURE_REPEAT_MIRROR
			dr.set_mode(2)
		6:
			# Changing pixels: one update for four drawers; Atwin untouched.
			var a1 := _rgba8(16, 16, A0_BASE, A1_RECTS)
			_log_texture("texture_2d_update", "A", "main", Payload.describe(a1))
			_a.update(a1)
		7:
			# Replacement: same texture, a new 32x32 image (create + replace); B changes format
			# (LA8 -> RGBA8) through replace.
			var a2 := _rgba8(32, 32, A0_BASE, A2_RECTS)
			_log_texture("texture_2d_create", "A", "main", Payload.describe(a2))
			_log_op("texture_replace", "A")
			_a.set_image(a2)
			var b1 := _checker(4, 4, Image.FORMAT_RGBA8, B1_EVEN, B1_ODD)
			_log_texture("texture_2d_create", "B", "main", Payload.describe(b1))
			_log_op("texture_replace", "B")
			_b.set_image(b1)
		8:
			# Lifetime. C on the main thread, its image blacked out right after the create: the
			# capture must show the content at the call (copy at the hook).
			var c_image := _rgba8(16, 16, C_BASE, C_RECTS)
			_c = _create_texture("C", c_image)
			c_image.fill(Color(0, 0, 0, 1))
			s3.texture = _c
			# Atwin's last reference goes: ImageTexture's destructor frees it.
			_log_op("free", "Atwin")
			_atwin = null
			# D on a worker thread, joined before the main thread touches it, never mutated.
			var worker := Thread.new()
			worker.start(_make_d)
			var made: Dictionary = worker.wait_to_finish()
			_d = made["texture"]
			var d_description: Dictionary = made["description"]
			_log_texture("texture_2d_create", "D", "other", d_description)
			sd.texture = _d
			# A freed texture a command still names: RAW1 keeps drawing P1's RID.
			_log_op("free", "P1")
			RenderingServer.free_rid(_p1)
		9:
			# A placeholder becomes an image through replace (the gradient-texture pattern), and
			# M's first reference, with mipmaps.
			var e_image := _rgba8(4, 4, E_BASE, E_RECTS)
			_log_texture("texture_2d_create", "E", "main", Payload.describe(e_image))
			var e_rid: RID = RenderingServer.texture_2d_create(e_image)
			_log_op("texture_replace", "P2")
			RenderingServer.texture_replace(_p2, e_rid)
			mm.texture = _m
			mm.texture_filter = CanvasItem.TEXTURE_FILTER_LINEAR_WITH_MIPMAPS
		10:
			# Transform only again, after every resource change.
			g.position = Vector2(0, 224)
			get_viewport().canvas_transform = Transform2D(0.0, Vector2(8, 4))
		11:
			# SC draws A's 64x64 region (2x2 tiles of A2) at scale 1.125 (72x72, magnified like
			# S1/S2's 2x and kept clear of the animate variant's ANIM next door), nearest with
			# repeat enabled. The main fixture asks for that on the item itself. The canvas
			# variants (G2d) ask for it through a CanvasTexture CT (diffuse A, nearest, enabled)
			# while the item's own filter is LINEAR and its repeat DISABLED: the same pixels only
			# if CT's own filter and repeat override the item's. Magnification is what makes
			# nearest and linear differ here (sabotage-omit-canvas-filter). A headless host
			# never allocates CT (protocol/canvas-texture-headless.md), so the main fixture keeps
			# CanvasTexture out of every headless leg's path.
			if _variant == "canvas" or _variant == "canvas-normal":
				_ct = CanvasTexture.new()
				_log_op("canvas_texture_create", "CT")
				_ct.diffuse_texture = _a
				_ct.texture_filter = CanvasItem.TEXTURE_FILTER_NEAREST
				_ct.texture_repeat = CanvasItem.TEXTURE_REPEAT_ENABLED
				if _variant == "canvas-normal":
					_ct.normal_texture = _b
				sc.texture = _ct
				sc.texture_filter = CanvasItem.TEXTURE_FILTER_LINEAR
				sc.texture_repeat = CanvasItem.TEXTURE_REPEAT_DISABLED
			else:
				sc.texture = _a
				sc.texture_filter = CanvasItem.TEXTURE_FILTER_NEAREST
				sc.texture_repeat = CanvasItem.TEXTURE_REPEAT_ENABLED
			sc.scale = Vector2(1.125, 1.125)
			sc.region_enabled = true
			sc.region_rect = Rect2(0, 0, 64, 64)
	marker.set_rects([Rect2(0, 0, 32, 32)], [MARKER_COLORS[step]])


## Worker thread (step 8): builds D, describes its payload, creates the texture.
func _make_d() -> Dictionary:
	var image := _rgba8(16, 16, D_BASE, D_RECTS)
	var description: Dictionary = Payload.describe(image)
	var texture := ImageTexture.create_from_image(image)
	return {"texture": texture, "description": description}


func _create_texture(texture_name: String, image: Image) -> ImageTexture:
	_log_texture("texture_2d_create", texture_name, "main", Payload.describe(image))
	return ImageTexture.create_from_image(image)


func _sprite(node_name: String, texture: Texture2D, at: Vector2, scale_factor: float) -> Sprite2D:
	var sprite := Sprite2D.new()
	sprite.name = node_name
	sprite.texture = texture
	sprite.centered = false
	sprite.position = at
	sprite.scale = Vector2(scale_factor, scale_factor)
	return sprite


func _raw_item(canvas: RID, at: Vector2, draw_index: int, texture: RID) -> RID:
	var item: RID = RenderingServer.canvas_item_create()
	RenderingServer.canvas_item_set_parent(item, canvas)
	RenderingServer.canvas_item_set_transform(item, Transform2D(0.0, at))
	RenderingServer.canvas_item_set_draw_index(item, draw_index)
	RenderingServer.canvas_item_add_texture_rect(item, Rect2(0, 0, 32, 32), texture)
	return item


## An RGBA8 image: `base` everywhere, then each [x, y, w, h, r, g, b, a] override in order.
static func _rgba8(width: int, height: int, base: Array[int], rects: Array[Array]) -> Image:
	var data := PackedByteArray()
	data.resize(width * height * 4)
	for y: int in height:
		for x: int in width:
			var color: Array = base
			for rect: Array in rects:
				var rx: int = rect[0]
				var ry: int = rect[1]
				var rw: int = rect[2]
				var rh: int = rect[3]
				if x >= rx and x < rx + rw and y >= ry and y < ry + rh:
					color = rect.slice(4, 8)
			var at: int = (y * width + x) * 4
			for i: int in 4:
				var value: int = color[i]
				data[at + i] = value
	return Image.create_from_data(width, height, false, Image.FORMAT_RGBA8, data)


## A one-texel checker: `even` where x + y is even, `odd` elsewhere, in `format`'s channel layout.
static func _checker(width: int, height: int, format: Image.Format, even: Array[int], odd: Array[int]) -> Image:
	var data := PackedByteArray()
	for y: int in height:
		for x: int in width:
			for value: int in (even if (x + y) % 2 == 0 else odd):
				data.append(value)
	return Image.create_from_data(width, height, false, format, data)


## ANIM's content at `frame`: k = frame mod 6 -> (k*.2, 1-k*.2, .4).
static func _anim_image(frame: int) -> Image:
	var k: int = frame % 6
	var empty: Array[Array] = []
	return _rgba8(8, 8, [k * 51, 255 - k * 51, 102, 255], empty)


func _read_environment() -> bool:
	if OS.has_environment("RS_FIXTURE_TIE"):
		_error("RS_FIXTURE_TIE is a gate 1 variable; the gate 2 fixture's variant knob is RS_FIXTURE_VARIANT")
		return false
	if OS.has_environment("RS_FIXTURE_VARIANT"):
		_variant = OS.get_environment("RS_FIXTURE_VARIANT")
		if not ["animate", "unsupported", "canvas", "canvas-normal"].has(_variant):
			_error("RS_FIXTURE_VARIANT must be animate, unsupported, canvas or canvas-normal (got %s)" % JSON.stringify(_variant))
			return false
	var start: int = _int_env("RS_FIXTURE_START_FRAME", START_FRAME_DEFAULT, 1)
	var span: int = _int_env("RS_FIXTURE_STEP_FRAMES", STEP_FRAMES_DEFAULT, SETTLE_OFFSET + 1)
	if start < 0 or span < 0:
		return false
	_start_frame = start
	_step_frames = span
	var quit_default: int = _start_frame + _step_frames * LAST_STEP + SETTLE_OFFSET + QUIT_AFTER_LAST_SETTLE
	var quit: int = _int_env("RS_FIXTURE_QUIT_FRAME", quit_default, quit_default)
	if quit < 0:
		return false
	_quit_frame = quit

	if OS.has_environment("RS_FIXTURE_SHOT_FRAMES"):
		var frames_text: String = OS.get_environment("RS_FIXTURE_SHOT_FRAMES").strip_edges()
		for part: String in frames_text.split(","):
			var token: String = part.strip_edges()
			if not token.is_valid_int() or token.to_int() < 1:
				_error("RS_FIXTURE_SHOT_FRAMES must be a CSV of frames >= 1 (got %s)" % JSON.stringify(frames_text))
				return false
			_shot_frames.append(token.to_int())

	var step_log: String = _path_env("RS_FIXTURE_STEP_LOG")
	var shot_dir: String = _path_env("RS_FIXTURE_SHOT_DIR")
	var texture_log: String = _path_env("RS_FIXTURE_TEXTURE_LOG")
	if step_log == "!" or shot_dir == "!" or texture_log == "!":
		return false
	_shot_dir = shot_dir
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


## The integer value of `name`, `fallback` when unset, -1 (after printing why) when invalid.
func _int_env(name: String, fallback: int, minimum: int) -> int:
	if not OS.has_environment(name):
		return fallback
	var text: String = OS.get_environment(name).strip_edges()
	if not text.is_valid_int() or text.to_int() < minimum:
		_error("%s must be an integer >= %d (got %s)" % [name, minimum, JSON.stringify(text)])
		return -1
	return text.to_int()


## The absolute path in `name`, "" when unset, "!" (after printing why) when invalid.
func _path_env(name: String) -> String:
	if not OS.has_environment(name):
		return ""
	var text: String = OS.get_environment(name)
	if text == "" or not text.is_absolute_path():
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


## One texture-log line (gate2-design.md Q6 "Fixture environment"). `description` comes from
## Payload.describe() for creates and updates; every other operation logs nulls.
func _log_texture(op: String, texture_name: String, thread: String, description: Dictionary) -> void:
	if _texture_log_file == null:
		return
	var frame: int = 1 if _frame == 0 else _frame
	var line: Dictionary = {
		"step": _current_step,
		"frame": frame,
		"op": op,
		"name": texture_name,
		"thread": thread,
		"format": description.get("format"),
		"width": description.get("width"),
		"height": description.get("height"),
		"mipmaps": description.get("mipmaps"),
		"data_bytes": description.get("data_bytes"),
		"payload_sha256": description.get("payload_sha256"),
	}
	_texture_log_file.store_line(JSON.stringify(line, "", false))
	_texture_log_file.flush()


func _log_op(op: String, texture_name: String) -> void:
	_log_texture(op, texture_name, "main", {})


## Rendered runs only: headless has no draw path, so frame_post_draw never fires there. Called
## without `await` from `_process`, so the coroutine finishes while frames keep advancing.
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
