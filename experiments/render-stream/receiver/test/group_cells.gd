extends Node
## Pixel fixture for dead clip-group cells. Run through the repo's rendered capture runner,
## with GRC_EXTENSION, RS_FIXTURE_STEP_LOG and RS_FIXTURE_SHOT_DIR as in group_scissor.gd.
## Two disjoint owners have large alpha holes and overlapping mixed/additive children.
## Steps move an owner, revise its texture, then enable/disable a later screen sampler.

var _frame: int = 0
var _owner: Sprite2D
var _reader: Sprite2D
var _steps: FileAccess


func _enter_tree() -> void:
	var extension: String = OS.get_environment("GRC_EXTENSION")
	if extension != "":
		var status: GDExtensionManager.LoadStatus = GDExtensionManager.load_extension(extension)
		print("[fixture] extension load status=%d" % status)


func _ready() -> void:
	var log_path: String = OS.get_environment("RS_FIXTURE_STEP_LOG")
	if log_path != "":
		_steps = FileAccess.open(log_path, FileAccess.WRITE)
	var background: Polygon2D = Polygon2D.new()
	background.polygon = PackedVector2Array([Vector2.ZERO, Vector2(640, 0), Vector2(640, 360), Vector2(0, 360)])
	background.color = Color(0.12, 0.18, 0.24, 1)
	add_child(background)
	_owner = _clip_owner(Vector2(160, 144))
	_clip_owner(Vector2(448, 144))
	_reader = _sprite(Vector2(320, 312), Vector2(640, 48), Color.WHITE)
	var shader: Shader = Shader.new()
	shader.code = """shader_type canvas_item;
uniform sampler2D screen_texture : hint_screen_texture, repeat_disable, filter_nearest;
void fragment() { COLOR = texture(screen_texture, SCREEN_UV); }
"""
	var material: ShaderMaterial = ShaderMaterial.new()
	material.shader = shader
	_reader.material = material
	_reader.visible = false
	add_child(_reader)
	_log_step(0, 1, 4)


func _owner_image(revised: bool) -> Image:
	var image: Image = Image.create(192, 128, false, Image.FORMAT_RGBA8)
	image.fill(Color(0.6, 0.3, 0.9, 1))
	# Transparent RGB remains nonzero: only alpha determines whether a cell can be rejected.
	image.fill_rect(Rect2i(32 if revised else 48, 32, 96, 64), Color(0.6, 0.3, 0.9, 0))
	return image


func _clip_owner(at: Vector2) -> Sprite2D:
	var owner: Sprite2D = Sprite2D.new()
	owner.texture = ImageTexture.create_from_image(_owner_image(false))
	owner.position = at
	owner.clip_children = CanvasItem.CLIP_CHILDREN_AND_DRAW
	add_child(owner)
	owner.add_child(_sprite(Vector2(-24, 0), Vector2(260, 160), Color(0.2, 0.8, 0.4, 0.6)))
	var additive: Sprite2D = _sprite(Vector2(40, 16), Vector2(240, 160), Color(0.7, 0.2, 0.5, 0.5))
	var material: CanvasItemMaterial = CanvasItemMaterial.new()
	material.blend_mode = CanvasItemMaterial.BLEND_MODE_ADD
	additive.material = material
	owner.add_child(additive)
	return owner


func _sprite(at: Vector2, size: Vector2, color: Color) -> Sprite2D:
	var image: Image = Image.create(int(size.x), int(size.y), false, Image.FORMAT_RGBA8)
	image.fill(color)
	var sprite: Sprite2D = Sprite2D.new()
	sprite.texture = ImageTexture.create_from_image(image)
	sprite.position = at
	return sprite


func _process(_delta: float) -> void:
	_frame += 1
	if _frame == 10:
		_owner.position += Vector2(7.25, 3.5)
		_owner.rotation = 0.15
		_log_step(1, 10, 17)
	if _frame == 20:
		var texture: ImageTexture = _owner.texture as ImageTexture
		texture.update(_owner_image(true))
		_log_step(2, 20, 27)
	if _frame == 30:
		_reader.visible = true
		_log_step(3, 30, 37)
	if _frame == 40:
		_reader.visible = false
		_log_step(4, 40, 47)
	for step: int in 5:
		if _frame == [4, 17, 27, 37, 47][step]:
			_take_shot(step)
	if _frame >= 55:
		get_tree().quit()


func _log_step(step: int, applied: int, settled: int) -> void:
	if _steps != null:
		_steps.store_line(JSON.stringify({"step": step, "applied_frame": applied, "settle_frame": settled}))
		_steps.flush()


func _take_shot(step: int) -> void:
	var directory: String = OS.get_environment("RS_FIXTURE_SHOT_DIR")
	if directory == "" or DisplayServer.get_name() == "headless":
		return
	await RenderingServer.frame_post_draw
	var image: Image = get_viewport().get_texture().get_image()
	var status: Error = image.save_png(directory.path_join("step-%d.png" % step))
	print("[fixture] shot step=%d status=%d" % [step, status])
