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


func _ready() -> void:
	if "--self-test" in OS.get_cmdline_user_args():
		_self_test()
		return
	_node = Polygon2D.new()
	_node.name = "Motion"
	_node.polygon = PackedVector2Array([Vector2.ZERO, Vector2(40, 0), Vector2(40, 28), Vector2(0, 28)])
	_node.position = Vector2(70, 90)
	add_child(_node)
	_control = ColorRect.new()
	_control.name = "Pivoted"
	_control.position = Vector2(70, 240)
	_control.size = Vector2(40, 28)
	_control.pivot_offset = Vector2(20, 14)
	add_child(_control)
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
	if elapsed >= 0.9 and not _canceled:
		_cancel.cancel()
		_canceled = true
	_log.store_line(JSON.stringify({"t_us": Time.get_ticks_usec(), "elapsed_s": elapsed,
		"cancel": _canceled, "node": _pose(_node), "control": _pose(_control)}))
	_log.flush()
	if elapsed > 3.8:
		get_tree().quit()


func _start() -> void:
	_started = Time.get_ticks_usec()
	var complete := Helper.create(_node, 101).set_parallel()
	complete.property(^"position", Vector2(500, 100), 2.0)
	complete.property(^"rotation", 1.2, 2.0, Tween.TRANS_SINE)
	complete.property(^"scale", Vector2(1.5, 0.7), 2.0)
	complete.property(^"modulate", Color(0.3, 0.8, 0.4, 1), 2.0)
	complete.play()
	_cancel = Helper.create(_control, 102).set_parallel()
	_cancel.property(^"position", Vector2(480, 240), 2.4)
	_cancel.property(^"rotation", -0.7, 2.4)
	_cancel.property(^"scale", Vector2(1.4, 1.2), 2.4)
	_cancel.property(^"modulate", Color(0.9, 0.3, 0.7, 1), 2.4)
	_cancel.play()


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
	print("helper: 9 assertions passed (no capture singleton)")
	get_tree().quit()
