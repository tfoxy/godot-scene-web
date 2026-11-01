extends Node
## Gate 8 late-arm runtime CanvasTexture fixture (RT-CTX, the deferred follow-up in
## results/p3/late-arm.md): every image is built in code at `_ready` and drawn ONLY through a
## CanvasTexture assigned to the item's `texture` -- no .tres, no command names an image directly.
## The loader arms the capture LATE (RS_FIXTURE_ARM=late at frame 12), after every CanvasTexture
## and item already exists, so the capture must adopt each CanvasTexture from the drawing item's
## node (`texture`) -- the node map -- since the RenderingServer has no canvas-texture channel
## getter and the resource cache has no path for a runtime-built CanvasTexture. Three 64x64 cells:
##
##   SPRITE (40,40)    Sprite2D at scale 4, through CT_A (add_texture_rect)
##   TRECT  (136,40)   TextureRect, through CT_B (a Control's add_texture_rect)
##   MESH   (232,40)   MeshInstance2D, an ArrayMesh quad, through CT_C (add_mesh, the spine shape)
##
## The root is a plain `Node`: every CanvasItem is created in `_ready`, after the autoload's
## `_enter_tree` but before the loader's `_process` arms at frame 12. Timeline: quit at 30. The
## recording (armed at 12) holds the adopted canvas textures and every post-arm draw.

const SIZE: int = 16
const QUIT_DEFAULT: int = 30

var _frame: int = 0
var _quit_frame: int = QUIT_DEFAULT
var _failed: bool = false


func _ready() -> void:
	if not _read_environment():
		_failed = true
		get_tree().quit(2)
		return
	var root := Node2D.new()
	add_child(root)
	# SPRITE: the diffuse exists before its canvas texture (the spine-godot order).
	var ct_a := CanvasTexture.new()
	ct_a.diffuse_texture = ImageTexture.create_from_image(_pattern(1))
	var sprite := Sprite2D.new()
	sprite.texture = ct_a
	sprite.centered = false
	sprite.position = Vector2(40, 40)
	sprite.scale = Vector2(4.0, 4.0)
	root.add_child(sprite)
	# TRECT: a Control's add_texture_rect through a runtime CanvasTexture.
	var ct_b := CanvasTexture.new()
	ct_b.diffuse_texture = ImageTexture.create_from_image(_pattern(2))
	var texture_rect := TextureRect.new()
	texture_rect.texture = ct_b
	texture_rect.expand_mode = TextureRect.EXPAND_IGNORE_SIZE
	texture_rect.stretch_mode = TextureRect.STRETCH_SCALE
	texture_rect.position = Vector2(136, 40)
	texture_rect.size = Vector2(64, 64)
	root.add_child(texture_rect)
	# MESH: MeshInstance2D through a runtime CanvasTexture (the spine-godot shape).
	var ct_c := CanvasTexture.new()
	ct_c.diffuse_texture = ImageTexture.create_from_image(_pattern(3))
	var mesh_instance := MeshInstance2D.new()
	mesh_instance.mesh = _quad_mesh(64.0)
	mesh_instance.texture = ct_c
	mesh_instance.position = Vector2(232, 40)
	root.add_child(mesh_instance)
	print("[fixture] gate8-ct-late ready: quit=%d" % _quit_frame)


func _process(_delta: float) -> void:
	if _failed:
		return
	_frame += 1
	if _frame >= _quit_frame:
		print("[fixture] quitting frame=%d" % _frame)
		get_tree().quit(0)


## A 16x16 opaque RGBA8 image of 4x4-texel blocks, distinct per seed, every channel in 10..239
## (never white, so a diffuse drawn as Godot's white default cannot pass for it).
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


static func _quad_mesh(side: float) -> ArrayMesh:
	var arrays: Array = []
	arrays.resize(Mesh.ARRAY_MAX)
	arrays[Mesh.ARRAY_VERTEX] = PackedVector2Array([Vector2(0, 0), Vector2(side, 0), Vector2(side, side), Vector2(0, side)])
	arrays[Mesh.ARRAY_TEX_UV] = PackedVector2Array([Vector2(0, 0), Vector2(1, 0), Vector2(1, 1), Vector2(0, 1)])
	arrays[Mesh.ARRAY_INDEX] = PackedInt32Array([0, 1, 2, 0, 2, 3])
	var mesh := ArrayMesh.new()
	mesh.add_surface_from_arrays(Mesh.PRIMITIVE_TRIANGLES, arrays)
	return mesh


func _read_environment() -> bool:
	if OS.has_environment("RS_FIXTURE_QUIT_FRAME"):
		var text: String = OS.get_environment("RS_FIXTURE_QUIT_FRAME").strip_edges()
		if not text.is_valid_int() or text.to_int() < QUIT_DEFAULT:
			_error("RS_FIXTURE_QUIT_FRAME must be an integer >= %d (got %s)" % [QUIT_DEFAULT, JSON.stringify(text)])
			return false
		_quit_frame = text.to_int()
	return true


func _error(text: String) -> void:
	printerr("[fixture] error: " + text)
