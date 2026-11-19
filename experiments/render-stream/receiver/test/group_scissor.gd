extends Node
## Pixel fixture: run this scene in the receiver project. The capture arm loads before _ready
## creates the items, as in gate8-cg. Use the repo's rendered runner, GRC_EXTENSION for capture,
## RS_FIXTURE_STEP_LOG and RS_FIXTURE_SHOT_DIR for the usual step log and reference images.
## A clip-and-draw owner has additive and mixed children extending beyond its quad. A transparent
## CanvasGroup follows it. No screen reader or mip chain disables the scissor gates.
## Keep the root a plain Node: every CanvasItem must be created after the capture loads.

var _frame: int = 0
var _owner: Sprite2D
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
	_owner = _sprite(Vector2(160, 120), Vector2(96, 64), Color(0.6, 0.3, 0.9, 1))
	_owner.clip_children = CanvasItem.CLIP_CHILDREN_AND_DRAW
	add_child(_owner)
	var mixed: Sprite2D = _sprite(Vector2(-16, 0), Vector2(240, 160), Color(0.2, 0.8, 0.4, 0.6))
	_owner.add_child(mixed)
	var additive: Sprite2D = _sprite(Vector2(48, 24), Vector2(200, 160), Color(0.7, 0.2, 0.5, 0.5))
	var material: CanvasItemMaterial = CanvasItemMaterial.new()
	material.blend_mode = CanvasItemMaterial.BLEND_MODE_ADD
	additive.material = material
	_owner.add_child(additive)
	var transparent: CanvasGroup = CanvasGroup.new()
	transparent.position = Vector2(448, 180)
	transparent.fit_margin = 0
	transparent.clear_margin = 8
	add_child(transparent)
	transparent.add_child(_sprite(Vector2.ZERO, Vector2(120, 80), Color(0.3, 0.6, 0.9, 0.5)))
	transparent.add_child(_sprite(Vector2(48, 24), Vector2(100, 100), Color(0.9, 0.3, 0.2, 0.6)))
	_log_step(0, 1, 4)


func _sprite(at: Vector2, size: Vector2, color: Color) -> Sprite2D:
	var image: Image = Image.create(int(size.x), int(size.y), false, Image.FORMAT_RGBA8)
	image.fill(color)
	var sprite: Sprite2D = Sprite2D.new()
	sprite.texture = ImageTexture.create_from_image(image)
	sprite.position = at
	return sprite


func _process(_delta: float) -> void:
	_frame += 1
	if _frame == 14:
		_log_step(1, 14, 17)
	if _frame == 20:
		_owner.position += Vector2(7.25, 3.5)
		_owner.rotation = 0.1
		_log_step(2, 20, 27)
	for step: int in 3:
		if _frame == [4, 17, 27][step]:
			_take_shot(step)
	if _frame >= 35:
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
