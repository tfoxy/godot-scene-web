extends SceneTree
## The Godot 4.5.1 facts virtual joypad devices and GswJoypadIsolation rest on, against real
## `Input` and `InputMap` in headless Godot (the test project's gsw_test_jump = joypad button 0
## + physical W, gsw_test_right = joypad axis 0 +, joypad bindings on all devices):
##   - an injected device >= 16 reads as pressed (buttons, axes, actions) yet is absent from
##     `get_connected_joypads()`, has no name and fires no `joy_connection_changed`;
##   - with all-devices bindings a driver id (0) drives actions too, which is why every process on
##     a machine reacts to a physical pad;
##   - `isolate([64])` stops device 0 matching while device 64 still does, leaves key bindings
##     alone and leaves direct `Input.is_joy_button_pressed(0, ...)` reads working (a documented
##     limit); a second isolate changes nothing; several devices give one binding each; `restore`
##     puts the project bindings back.
##
## Device 0 here is injected, not the machine's pad (a real pad may sit on device 0, so its
## connection state is never asserted). Runs from `_process`: Input state changes at flush.
##
## Prints "[isolation-selftest] ok N checks" and quits 0, or prints each failure and quits 1.

const TAG: String = "[isolation-selftest]"
const VIRTUAL: int = 64
const PHYSICAL: int = 0
const JUMP: StringName = &"gsw_test_jump"
const RIGHT: StringName = &"gsw_test_right"

var _ran: bool = false
var _checks: int = 0
var _failures: int = 0
var _connection_changes: int = 0


func _process(_delta: float) -> bool:
	if _ran:
		return true
	_ran = true
	Input.joy_connection_changed.connect(_on_joy_connection_changed)
	_virtual_device_facts()
	_isolation()
	if _failures == 0:
		print("%s ok %d checks" % [TAG, _checks])
	else:
		print("%s %d of %d checks failed" % [TAG, _failures, _checks])
	quit(1 if _failures > 0 else 0)
	return true


func _on_joy_connection_changed(device: int, _connected: bool) -> void:
	if device >= 16:
		_connection_changes += 1


func _virtual_device_facts() -> void:
	_button(VIRTUAL, true)
	_check("device 64 button reads pressed", Input.is_joy_button_pressed(VIRTUAL, JOY_BUTTON_A))
	_check("device 64 drives an all-devices action", Input.is_action_pressed(JUMP))
	_check("device 64 is not a connected joypad", not Input.get_connected_joypads().has(VIRTUAL))
	_check("device 64 has no joy name", Input.get_joy_name(VIRTUAL) == "")
	_check("device 64 is not a known joypad", not Input.is_joy_known(VIRTUAL))
	_button(VIRTUAL, false)
	_check("device 64 button releases", not Input.is_joy_button_pressed(VIRTUAL, JOY_BUTTON_A))
	_check("device 64 action releases", not Input.is_action_pressed(JUMP))

	_axis(VIRTUAL, 0.75)
	_check("device 64 axis reads its value", absf(Input.get_joy_axis(VIRTUAL, JOY_AXIS_LEFT_X) - 0.75) < 1e-6)
	_check("device 64 axis drives an all-devices action", Input.is_action_pressed(RIGHT))
	_axis(VIRTUAL, 0.0)
	_check("device 64 axis action releases", not Input.is_action_pressed(RIGHT))

	_button(GswInputDevices.MAX_DEVICE, true)
	_check("device 2047 button reads pressed", Input.is_joy_button_pressed(GswInputDevices.MAX_DEVICE, JOY_BUTTON_A))
	_check("device 2047 does not alias device 0", not Input.is_joy_button_pressed(PHYSICAL, JOY_BUTTON_A))
	_button(GswInputDevices.MAX_DEVICE, false)
	_check("injected devices fire no joy_connection_changed", _connection_changes == 0)

	_button(PHYSICAL, true)
	_check("unisolated, device 0 drives an all-devices action", Input.is_action_pressed(JUMP))
	_button(PHYSICAL, false)
	_check("device 0 action releases", not Input.is_action_pressed(JUMP))


func _isolation() -> void:
	var original_jump: int = InputMap.action_get_events(JUMP).size()
	var devices: Array[int] = [VIRTUAL]
	var saved: Dictionary = GswJoypadIsolation.isolate(devices)
	_check("isolate reports the two joypad actions", saved.size() == 2 and saved.has(JUMP) and saved.has(RIGHT))
	_check("isolate keeps one binding per joypad binding", InputMap.action_get_events(JUMP).size() == original_jump)
	_check("joypad binding is now device 64", _joypad_devices(JUMP) == devices)
	_check("key binding stays on all devices", _key_devices(JUMP) == [GswJoypadIsolation.ALL_DEVICES])

	_button(PHYSICAL, true)
	_check("isolated, device 0 no longer drives the action", not Input.is_action_pressed(JUMP))
	_check("isolated, device 0 still reads pressed directly (limit)", Input.is_joy_button_pressed(PHYSICAL, JOY_BUTTON_A))
	_button(PHYSICAL, false)
	_button(VIRTUAL, true)
	_check("isolated, device 64 still drives the action", Input.is_action_pressed(JUMP))
	_button(VIRTUAL, false)
	_check("device 64 action releases under isolation", not Input.is_action_pressed(JUMP))
	_key(true)
	_check("isolated, the key binding still drives the action", Input.is_action_pressed(JUMP))
	_key(false)

	_axis(PHYSICAL, 1.0)
	_check("isolated, device 0 axis no longer drives the action", not Input.is_action_pressed(RIGHT))
	_axis(PHYSICAL, 0.0)
	_axis(VIRTUAL, 1.0)
	_check("isolated, device 64 axis still drives the action", Input.is_action_pressed(RIGHT))
	_axis(VIRTUAL, 0.0)

	var again: Dictionary = GswJoypadIsolation.isolate([VIRTUAL, VIRTUAL + 1] as Array[int])
	_check("a second isolate finds nothing to rewrite", again.is_empty() and _joypad_devices(JUMP) == devices)

	GswJoypadIsolation.restore(saved)
	_check("restore puts the all-devices binding back", _joypad_devices(JUMP) == [GswJoypadIsolation.ALL_DEVICES])
	_check("restore keeps the binding count", InputMap.action_get_events(JUMP).size() == original_jump)

	var several: Array[int] = [VIRTUAL, VIRTUAL + 1, VIRTUAL + 4]
	var saved_several: Dictionary = GswJoypadIsolation.isolate(several)
	_check("several devices give one binding each", _joypad_devices(JUMP) == several)
	_button(VIRTUAL + 4, true)
	_check("each listed device drives the action", Input.is_action_pressed(JUMP))
	_button(VIRTUAL + 4, false)
	_button(VIRTUAL + 2, true)
	_check("an unlisted virtual device does not", not Input.is_action_pressed(JUMP))
	_button(VIRTUAL + 2, false)
	GswJoypadIsolation.restore(saved_several)
	_check("restore after several", _joypad_devices(JUMP) == [GswJoypadIsolation.ALL_DEVICES])


func _joypad_devices(action: StringName) -> Array[int]:
	var out: Array[int] = []
	for event: InputEvent in InputMap.action_get_events(action):
		if event is InputEventJoypadButton or event is InputEventJoypadMotion:
			out.append(event.device)
	return out


func _key_devices(action: StringName) -> Array[int]:
	var out: Array[int] = []
	for event: InputEvent in InputMap.action_get_events(action):
		if event is InputEventKey:
			out.append(event.device)
	return out


func _button(device: int, pressed: bool) -> void:
	var event := InputEventJoypadButton.new()
	event.device = device
	event.button_index = JOY_BUTTON_A
	event.pressed = pressed
	Input.parse_input_event(event)
	Input.flush_buffered_events()


func _axis(device: int, value: float) -> void:
	var event := InputEventJoypadMotion.new()
	event.device = device
	event.axis = JOY_AXIS_LEFT_X
	event.axis_value = value
	Input.parse_input_event(event)
	Input.flush_buffered_events()


func _key(pressed: bool) -> void:
	var event := InputEventKey.new()
	event.physical_keycode = KEY_W
	event.pressed = pressed
	Input.parse_input_event(event)
	Input.flush_buffered_events()


func _check(what: String, ok: bool) -> void:
	_checks += 1
	if not ok:
		_failures += 1
		print("%s FAIL: %s" % [TAG, what])
