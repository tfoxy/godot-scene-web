extends SceneTree
## IN9: what the injector vectors cannot see, against real Godot GUI dispatch in headless 4.5.1:
##   - a Control's `gui_input` receives injected presses and releases at the injected position;
##   - right, middle, X1, X2 and the four wheel directions reach it with the right `button_index`,
##     `factor` and `button_mask`;
##   - an injected touch reaches it as exactly one emulated mouse press (device -1) plus the touch;
##   - GswInputPointerFilter: `_input` runs before GUI, so the filter (an INTERNAL_MODE_BACK root
##     child, first in `_input` order even before nodes added after it) blocks device-0 mouse and
##     touch from `_input` handlers and `gui_input`, while injected (virtual device) and emulated
##     (device -1) events pass; Input itself has already applied the physical event (documented
##     limit).
##
##   scripts/test-godot.sh pointer_selftest
##
## Prints "[pointer-selftest] ok N checks" and quits 0, or prints each failure and quits 1.

const TAG: String = "[pointer-selftest]"
## The test Control's rect in root-window pixels.
const PAD_POSITION: Vector2 = Vector2(100, 100)
const PAD_SIZE: Vector2 = Vector2(200, 200)


class Pad:
	extends Control
	var got: Array[String] = []

	func _gui_input(event: InputEvent) -> void:
		got.append(Recorder.describe(event))


class Recorder:
	extends Node
	var got: Array[String] = []

	func _input(event: InputEvent) -> void:
		got.append(describe(event))

	## Positions are as delivered: local to the Control in `gui_input`, root pixels in `_input`.
	static func describe(event: InputEvent) -> String:
		if event is InputEventMouseButton:
			var button: InputEventMouseButton = event
			var line: String = "mouse_button %d %d %s %.2f,%.2f mask=%d" % [
				button.device, button.button_index, "down" if button.pressed else "up", button.position.x,
				button.position.y, button.button_mask,
			]
			if button.factor != 1.0:
				line += " factor=%.2f" % button.factor
			if button.canceled:
				line += " canceled"
			return line
		if event is InputEventMouseMotion:
			var motion: InputEventMouseMotion = event
			return "mouse_motion %d %.2f,%.2f mask=%d" % [
				motion.device, motion.position.x, motion.position.y, motion.button_mask,
			]
		if event is InputEventScreenTouch:
			var touch: InputEventScreenTouch = event
			return "screen_touch %d %d %s %.2f,%.2f%s" % [
				touch.device, touch.index, "down" if touch.pressed else "up", touch.position.x, touch.position.y,
				" canceled" if touch.canceled else "",
			]
		return "other %s" % event.get_class()


var _pad: Pad
var _ran: bool = false
var _checks: int = 0
var _failures: int = 0
var _seq: int = 0


func _initialize() -> void:
	_pad = Pad.new()
	_pad.position = PAD_POSITION
	_pad.size = PAD_SIZE
	root.add_child(_pad)


func _process(_delta: float) -> bool:
	# `_input` and GUI delivery are not wired during _initialize (memory
	# godot-headless-input-dispatch-facts): run from the first frame.
	if _ran:
		return true
	_ran = true
	var injector := GswInputInjector.new()
	_send(injector, '{"type":"hello","format":"gsw-input/1","source":"a","epoch":1}')
	_test_press_release(injector)
	_test_buttons(injector)
	_test_touch(injector)
	_test_filter(injector)
	injector.close_channel("a")
	Input.flush_buffered_events()
	_check("clean mask", Input.get_mouse_button_mask(), 0)
	if _failures == 0:
		print("%s ok %d checks" % [TAG, _checks])
	else:
		print("%s %d of %d checks failed" % [TAG, _failures, _checks])
	quit(1 if _failures > 0 else 0)
	return true


func _check(what: String, got: Variant, want: Variant) -> void:
	_checks += 1
	if got != want:
		_failures += 1
		print("%s FAIL: %s: %s, expected %s" % [TAG, what, got, want])


func _send(injector: GswInputInjector, text: String) -> void:
	var result: String = injector.receive("a", text, 0)
	_check("receive %s" % text.left(60), result, "")
	Input.flush_buffered_events()


func _events(injector: GswInputInjector, records: Array) -> void:
	_seq += 1
	var message: Dictionary = {"type": "events", "epoch": 1, "seq": _seq, "events": records}
	_send(injector, JSON.stringify(message))


static func _button(index: int, pressed: bool, at: Vector2, mask: int, factor: float = 1.0) -> Dictionary:
	var record: Dictionary = {
		"event": "mouse_button", "button_index": index, "pressed": pressed, "position": [at.x, at.y],
		"button_mask": mask,
	}
	if factor != 1.0:
		record["factor"] = factor
	return record


func _test_press_release(injector: GswInputInjector) -> void:
	_pad.got.clear()
	_events(injector, [_button(1, true, Vector2(150, 160), 1)])
	_check("press: Input mask", Input.get_mouse_button_mask(), MOUSE_BUTTON_MASK_LEFT)
	_check("press: mouse position", root.get_mouse_position(), Vector2(150, 160))
	_events(injector, [{"event": "mouse_motion", "position": [170, 165], "button_mask": 1}])
	_check("drag: mouse position", root.get_mouse_position(), Vector2(170, 165))
	_events(injector, [_button(1, false, Vector2(172, 165), 0)])
	_check("release: Input mask", Input.get_mouse_button_mask(), 0)
	_check("release: mouse position", root.get_mouse_position(), Vector2(172, 165))
	var want: Array[String] = [
		"mouse_button 64 1 down 50.00,60.00 mask=1",
		"mouse_motion 64 70.00,65.00 mask=1",
		"mouse_button 64 1 up 72.00,65.00 mask=0",
	]
	_check("gui_input press/drag/release", _pad.got, want)


func _test_buttons(injector: GswInputInjector) -> void:
	var at := Vector2(120, 130)
	# [button_index, factor]: right, middle, X1, X2, then the wheel up/down/left/right.
	var cases: Array = [[2, 1.0], [3, 1.0], [8, 1.0], [9, 1.0], [4, 2.5], [5, 0.5], [6, 1.5], [7, 3.0]]
	for item: Variant in cases:
		var entry: Array = item
		var index: int = entry[0]
		var factor: float = entry[1]
		var bit: int = 1 << (index - 1)
		_pad.got.clear()
		_events(injector, [_button(index, true, at, bit, factor)])
		_check("button %d: Input mask while pressed" % index, Input.get_mouse_button_mask(), bit)
		_events(injector, [_button(index, false, at, 0, factor)])
		var suffix: String = "" if factor == 1.0 else " factor=%.2f" % factor
		var want: Array[String] = [
			"mouse_button 64 %d down 20.00,30.00 mask=%d%s" % [index, bit, suffix],
			"mouse_button 64 %d up 20.00,30.00 mask=0%s" % [index, suffix],
		]
		_check("button %d: gui_input" % index, _pad.got, want)
	# A wheel step while RIGHT is held: the press mask has both bits, the release keeps RIGHT.
	_pad.got.clear()
	_events(injector, [_button(2, true, at, 2), _button(5, true, at, 18, 2.0), _button(5, false, at, 2, 2.0)])
	_events(injector, [_button(2, false, at, 0)])
	var held: Array[String] = [
		"mouse_button 64 2 down 20.00,30.00 mask=2",
		"mouse_button 64 5 down 20.00,30.00 mask=18 factor=2.00",
		"mouse_button 64 5 up 20.00,30.00 mask=2 factor=2.00",
		"mouse_button 64 2 up 20.00,30.00 mask=0",
	]
	_check("wheel while RIGHT held: gui_input", _pad.got, held)


func _test_touch(injector: GswInputInjector) -> void:
	_pad.got.clear()
	_events(injector, [{"event": "screen_touch", "index": 0, "pressed": true, "position": [140, 150]}])
	_check("touch: emulated LEFT in Input", Input.get_mouse_button_mask(), MOUSE_BUTTON_MASK_LEFT)
	_events(injector, [{"event": "screen_touch", "index": 0, "pressed": false, "position": [140, 150]}])
	var want: Array[String] = [
		"mouse_button -1 1 down 40.00,50.00 mask=1",
		"screen_touch 64 0 down 40.00,50.00",
		"mouse_button -1 1 up 40.00,50.00 mask=0",
		"screen_touch 64 0 up 40.00,50.00",
	]
	_check("touch: one emulated press and release, no twin", _pad.got, want)


static func _physical_button(pressed: bool, at: Vector2) -> InputEventMouseButton:
	var event := InputEventMouseButton.new()
	event.device = 0
	event.button_index = MOUSE_BUTTON_LEFT
	event.pressed = pressed
	event.position = at
	event.global_position = at
	if pressed:
		event.button_mask = MOUSE_BUTTON_MASK_LEFT
	return event


func _test_filter(injector: GswInputInjector) -> void:
	var filter: GswInputPointerFilter = GswInputInjector.install_event_filter(root)
	# Added after the filter, as a scene loaded later would be: the filter must still come first.
	var late := Recorder.new()
	root.add_child(late)
	_pad.got.clear()

	Input.parse_input_event(_physical_button(true, Vector2(150, 150)))
	Input.flush_buffered_events()
	_check("filter: Input already applied the physical press", Input.get_mouse_button_mask(), MOUSE_BUTTON_MASK_LEFT)
	Input.parse_input_event(_physical_button(false, Vector2(150, 150)))
	var touch := InputEventScreenTouch.new()
	touch.device = 0
	touch.index = 9
	touch.pressed = true
	touch.position = Vector2(160, 160)
	Input.parse_input_event(touch)
	var lift := InputEventScreenTouch.new()
	lift.device = 0
	lift.index = 9
	lift.position = Vector2(160, 160)
	Input.parse_input_event(lift)
	var key := InputEventKey.new()
	key.device = 0
	key.physical_keycode = KEY_F13
	key.pressed = true
	Input.parse_input_event(key)
	var key_up := InputEventKey.new()
	key_up.device = 0
	key_up.physical_keycode = KEY_F13
	Input.parse_input_event(key_up)
	Input.flush_buffered_events()
	# The physical touch's emulated mouse (device -1) is not the filter's to drop.
	var physical: Array[String] = [
		"mouse_button -1 1 down 160.00,160.00 mask=1",
		"mouse_button -1 1 up 160.00,160.00 mask=0",
		"other InputEventKey",
		"other InputEventKey",
	]
	_check("filter: later _input node sees no device-0 pointer event", late.got, physical)
	var emulated: Array[String] = [
		"mouse_button -1 1 down 60.00,60.00 mask=1", "mouse_button -1 1 up 60.00,60.00 mask=0",
	]
	_check("filter: gui_input sees no device-0 pointer event", _pad.got, emulated)
	_check("filter: dropped count (2 buttons, 2 touches)", filter.dropped, 4)

	late.got.clear()
	_pad.got.clear()
	_events(injector, [_button(1, true, Vector2(150, 150), 1), _button(1, false, Vector2(150, 150), 0)])
	_events(injector, [{"event": "screen_touch", "index": 1, "pressed": true, "position": [155, 150]}])
	_events(injector, [{"event": "screen_touch", "index": 1, "pressed": false, "position": [155, 150]}])
	var injected: Array[String] = [
		"mouse_button 64 1 down 50.00,50.00 mask=1",
		"mouse_button 64 1 up 50.00,50.00 mask=0",
		"mouse_button -1 1 down 55.00,50.00 mask=1",
		"screen_touch 64 1 down 55.00,50.00",
		"mouse_button -1 1 up 55.00,50.00 mask=0",
		"screen_touch 64 1 up 55.00,50.00",
	]
	_check("filter: injected and emulated events reach gui_input", _pad.got, injected)
	_check("filter: injected events reach later _input nodes", late.got.size(), injected.size())
	_check("filter: dropped nothing injected", filter.dropped, 4)
	filter.queue_free()
	late.queue_free()
