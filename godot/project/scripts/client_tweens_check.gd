extends Node
## Generic producer fixture; run through web/client-tweens/run.sh.
const Helper = preload("res://scripts/announced_tween.gd")
var _out: String = OS.get_environment("TWEEN_CHECK_OUT")
var _started: int = 0
var _canceled: bool = false
var _node: Polygon2D
var _control: ColorRect
var _cancel: Helper
var _log: FileAccess
var _materials: Array[ShaderMaterial] = []
var _material_cancel: Helper
var _local_item: ColorRect
var _heartbeat: ColorRect
const DISSOLVE = "shader_type canvas_item; uniform float threshold = 1.0; uniform vec2 shift = vec2(0.0); void fragment() { vec2 p = UV + shift; COLOR = vec4(0.2, 0.8, 0.4, step(p.x, threshold) * step(p.y, 1.0)); }"


func _material() -> ShaderMaterial:
	var shader := Shader.new()
	shader.code = DISSOLVE
	var material := ShaderMaterial.new()
	material.shader = shader
	material.resource_local_to_scene = true
	material.set_shader_parameter("threshold", 1.0)
	material.set_shader_parameter("shift", Vector2.ZERO)
	return material


func _tile(x: float, material: ShaderMaterial) -> ColorRect:
	var tile := ColorRect.new()
	tile.position = Vector2(x, 10)
	tile.size = Vector2(56, 44)
	tile.material = material
	add_child(tile)
	return tile


func _local_pair() -> Array[ColorRect]:
	var template := ColorRect.new()
	template.material = _material()
	template.size = Vector2(56, 44)
	var scene := PackedScene.new()
	# Packing must also run in release templates, where assert expressions are removed.
	var packed: Error = scene.pack(template)
	template.free()
	if packed != OK:
		printerr("local scene pack failed: %d" % packed)
		get_tree().quit(2)
		return []
	var pair: Array[ColorRect] = []
	for x: float in [265.0, 345.0]:
		var instance := scene.instantiate() as ColorRect
		if instance == null:
			printerr("local scene did not instantiate a ColorRect")
			get_tree().quit(2)
			return []
		instance.position = Vector2(x, 10)
		add_child(instance)
		pair.append(instance)
	assert(pair[0].material != pair[1].material)
	return pair


func _ready() -> void:
	if "--self-test" in OS.get_cmdline_user_args():
		_self_test()
		return
	_node = Polygon2D.new()
	_node.name = "Motion"
	_node.polygon = PackedVector2Array([Vector2.ZERO, Vector2(40, 0), Vector2(40, 28), Vector2(0, 28)])
	var parent := Node2D.new()
	parent.name = "TranslatedScaled"
	parent.position = Vector2(30, 40)
	parent.scale = Vector2(2, 0.5)
	add_child(parent)
	_node.position = Vector2(20, 100) # Global (70, 90).
	parent.add_child(_node)
	_control = ColorRect.new()
	_control.name = "Pivoted"
	_control.position = Vector2(70, 240)
	_control.size = Vector2(40, 28)
	_control.pivot_offset = Vector2(20, 14)
	add_child(_control)
	var shared := _material()
	_tile(25, shared)
	_tile(105, shared)
	var vector := _material()
	_tile(185, vector)
	var pair := _local_pair()
	if pair.size() != 2:
		return
	_local_item = pair[0]
	_materials.append(shared)
	_materials.append(vector)
	for instance: ColorRect in pair:
		var local_material: ShaderMaterial = instance.material
		_materials.append(local_material)
	# A valid Godot shader outside the client's supported canvas shader subset.
	var refused := _material()
	refused.shader = Shader.new()
	refused.shader.code = "shader_type canvas_item; uniform mat2 basis; uniform float threshold = 1.0; void fragment() { COLOR.rg = basis * vec2(threshold); }"
	_tile(425, refused)
	_materials.append(refused)
	var extension_tile := ColorRect.new()
	extension_tile.position = Vector2(525, 10)
	extension_tile.size = Vector2(30, 44)
	add_child(extension_tile)
	# Keep host transactions arriving after playback retires, to check redraw quiescence.
	_heartbeat = ColorRect.new()
	_heartbeat.position = Vector2(600, 330)
	_heartbeat.size = Vector2(8, 8)
	add_child(_heartbeat)
	_log = FileAccess.open(_out.path_join("host-poses.jsonl"), FileAccess.WRITE)
	var extension: String = OS.get_environment("GRC_EXTENSION")
	var status: GDExtensionManager.LoadStatus = GDExtensionManager.load_extension(extension)
	if status != GDExtensionManager.LOAD_STATUS_OK:
		printerr("capture load failed: %d" % status)
		get_tree().quit(2)


func _process(_delta: float) -> void:
	if _log == null:
		return
	if _started == 0:
		if FileAccess.file_exists(_out.path_join("start")):
			_start()
		return
	var elapsed: float = (Time.get_ticks_usec() - _started) / 1000000.0
	_heartbeat.modulate = Color(0.5 + 0.5 * sin(elapsed * 5.0), 0.4, 0.8)
	if elapsed >= 0.9 and not _canceled:
		_cancel.cancel()
		_material_cancel.cancel()
		_canceled = true
	_log.store_line(JSON.stringify({"t_us": Time.get_ticks_usec(), "elapsed_s": elapsed,
		"params": _material_values(), "cancel": _canceled, "node": _pose(_node), "control": _pose(_control)}))
	_log.flush()
	if elapsed > 3.8:
		get_tree().quit()


func _start() -> void:
	_started = Time.get_ticks_usec()
	# Create and announce in the same frame, after capture and both viewers are active.
	var newborn := ColorRect.new()
	newborn.name = "CreationFrameMotion"
	newborn.position = Vector2(25, 310)
	newborn.size = Vector2(20, 12)
	add_child(newborn)
	Helper.create(newborn, 301).property(^"position:x", 480.0, 2.0).play()
	var newborn_material := _material()
	var newborn_tile := _tile(25, newborn_material)
	newborn_tile.position.y = 70
	Helper.create(newborn_material, 302, self).property(^"shader_parameter/threshold", 0.0, 2.0).play()
	var complete := Helper.create(_node, 101).set_parallel()
	complete.property(^"global_position", Vector2(500, 100), 2.0)
	complete.property(^"rotation", 1.2, 2.0, Tween.TRANS_SINE)
	complete.property(^"scale", Vector2(1.5, 0.7), 2.0)
	complete.property(^"modulate", Color(0.3, 0.8, 0.4, 1), 2.0)
	complete.play()
	_cancel = Helper.create(_control, 102).set_parallel()
	_cancel.property(^"position", Vector2(480, 240), 2.4)
	_cancel.property(^"rotation_degrees", rad_to_deg(-0.7), 2.4)
	_cancel.property(^"scale", Vector2(1.4, 1.2), 2.4)
	_cancel.property(^"modulate", Color(0.9, 0.3, 0.7, 1), 2.4)
	_cancel.play()

	Helper.create(_materials[0], 201, self).property(^"shader_parameter/threshold", 0.0, 2.0).play()
	_material_cancel = Helper.create(_materials[1], 202, self)
	_material_cancel.property(^"shader_parameter/shift", Vector2(0.8, 0.6), 2.4).play()
	# Exercise the convenience path: capture receives the material's ObjectID.
	Helper.create(_local_item, 203).property(^"material:shader_parameter/threshold", 0.0, 2.0).play()
	Helper.create(_materials[4], 204, self).property(^"shader_parameter/threshold", 0.0, 2.0).play()


func _material_values() -> Array:
	var values: Array = []
	for material: ShaderMaterial in _materials:
		var shift: Vector2 = material.get_shader_parameter("shift") if material != _materials[4] else Vector2.ZERO
		values.append({"threshold": material.get_shader_parameter("threshold"), "shift": [shift.x, shift.y]})
	return values


func _pose(item: CanvasItem) -> Dictionary:
	var transform: Transform2D = item.get_transform()
	return {"xform": [transform.x.x, transform.x.y, transform.y.x, transform.y.y,
		transform.origin.x, transform.origin.y], "modulate": [item.modulate.r,
		item.modulate.g, item.modulate.b, item.modulate.a]}


func _self_test() -> void:
	var target := Node2D.new()
	add_child(target)
	var builder := Helper.create(target, 1)
	builder.property(^"position:x", 10.0, 0.02)
	builder.parallel().property(^"rotation", 0.2, 0.04, Tween.TRANS_LINEAR, Tween.EASE_IN, 0.01)
	builder.interval(0.01).property(^"position:y", 20.0, 0.02)
	builder.chain().property(^"scale:x", 2.0, 0.01)
	assert(is_equal_approx(builder.steps[0]["start_ms"], 0.0))
	assert(is_equal_approx(builder.steps[1]["start_ms"], 10.0))
	assert(is_equal_approx(builder.steps[2]["start_ms"], 60.0))
	assert(is_equal_approx(builder.steps[3]["start_ms"], 80.0))
	await builder.play().finished
	assert(target.position.is_equal_approx(Vector2(10, 20)))
	assert(is_equal_approx(target.rotation, 0.2) and is_equal_approx(target.scale.x, 2.0))
	var canceled := Helper.create(target, 2)
	var canceled_tween: Tween = canceled.property(^"position:x", 100.0, 1.0).play()
	canceled.cancel()
	assert(not canceled_tween.is_valid())
	var x: float = target.position.x
	await get_tree().create_timer(0.04).timeout
	assert(is_equal_approx(target.position.x, x))
	var native: Tween = target.create_tween()
	native.tween_property(target, ^"position:x", 33.0, 0.02)
	var schedule: Array[Dictionary] = [{"property": "position:x", "to": 33.0,
		"start_ms": 0, "duration_ms": 20, "trans": Tween.TRANS_LINEAR, "ease": Tween.EASE_IN}]
	Helper.announce(target, 3, schedule, Time.get_ticks_usec())
	await native.finished
	assert(is_equal_approx(target.position.x, 33.0))
	Helper.cancel_announcement(3)
	var material := _material()
	material.set_shader_parameter("v3", Vector3.ZERO)
	material.set_shader_parameter("v4", Vector4.ZERO)
	var direct := Helper.create(material, 4, self).set_parallel()
	direct.property(^"shader_parameter/threshold", 0.0, 0.02)
	direct.property(^"shader_parameter/shift", Vector2(0.2, 0.4), 0.02)
	direct.property(^"shader_parameter/v3", Vector3(1, 2, 3), 0.02)
	direct.property(^"shader_parameter/v4", Vector4(1, 2, 3, 4), 0.02)
	await direct.play().finished
	assert(is_equal_approx(material.get_shader_parameter("threshold"), 0.0))
	assert(material.get_shader_parameter("shift") == Vector2(0.2, 0.4))
	assert(material.get_shader_parameter("v3") == Vector3(1, 2, 3))
	assert(material.get_shader_parameter("v4") == Vector4(1, 2, 3, 4))
	var pair := _local_pair()
	var alias := Helper.create(pair[0], 5)
	alias.property(^"material:shader_parameter/threshold", 0.0, 0.02)
	var resolved := Helper.resolve_target(pair[0], alias.steps)
	assert(resolved["target"] == pair[0].material)
	assert(resolved["steps"][0]["property"] == "shader_parameter/threshold")
	assert(alias.steps[0]["property"] == "material:shader_parameter/threshold")
	await alias.play().finished
	assert(is_equal_approx(pair[0].material.get_shader_parameter("threshold"), 0.0))
	assert(is_equal_approx(pair[1].material.get_shader_parameter("threshold"), 1.0))
	var stopped := Helper.create(material, 6, self).property(^"shader_parameter/threshold", 1.0, 1.0)
	var native_material := stopped.play()
	stopped.cancel()
	assert(not native_material.is_valid())
	await get_tree().create_timer(0.04).timeout
	assert(is_equal_approx(material.get_shader_parameter("threshold"), 0.0))
	print("helper: 20 assertions passed (no capture singleton)")
	get_tree().quit()
