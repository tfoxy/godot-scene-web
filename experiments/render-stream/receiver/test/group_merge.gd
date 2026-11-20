extends Node
## Pixel fixture for disjoint clip groups sharing back-buffer work. Capture must load before any
## CanvasItem is created. Run through the rendered receiver runner, with the usual shot/step envs.
## The bar is a target write between two groups (no text: receiver sources must never shape); the lower overlapping pair must keep two passes.

var _frame: int = 0
var _moving: Sprite2D
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
	for index: int in 5:
		var owner: Sprite2D = _group(Vector2(64 + index * 112, 92), Color(0.7, 0.3 + index * 0.1, 0.8, 0.8))
		if index == 4:
			_moving = owner
		if index == 1:
			var between: Polygon2D = Polygon2D.new()
			between.polygon = PackedVector2Array([Vector2(235, 155), Vector2(365, 155), Vector2(365, 177), Vector2(235, 177)])
			between.color = Color(0.95, 0.85, 0.3, 1)
			add_child(between)
	_group(Vector2(290, 260), Color(0.2, 0.8, 0.4, 0.8))
	_group(Vector2(306, 268), Color(0.9, 0.3, 0.2, 0.8))
	_log_step(0, 1, 4)


func _group(at: Vector2, color: Color) -> Sprite2D:
	var owner: Sprite2D = _sprite(at, Vector2(48, 40), color)
	owner.clip_children = CanvasItem.CLIP_CHILDREN_AND_DRAW
	add_child(owner)
	owner.add_child(_sprite(Vector2(-12, 0), Vector2(128, 96), Color(0.2, 0.8, 0.4, 0.6)))
	var additive: Sprite2D = _sprite(Vector2(16, 8), Vector2(144, 112), Color(0.7, 0.2, 0.5, 0.5))
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
	if _frame == 14:
		_log_step(1, 14, 17)
	if _frame == 20:
		# Overlap a formerly disjoint group, so a row-only update splits the merged run.
		_moving.position = Vector2(400, 92)
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
