class_name GswJoypadIsolation
extends RefCounted
## Keep physical pads out of a Godot instance's actions (docs/input.md "Many instances on one
## machine").
##
## InputMap matches a binding when `binding.device == ALL_DEVICES (-1) || binding.device ==
## event.device` (InputMap::_find_event, core/input/input_map.cpp:143-160), and project bindings
## are -1, so every Godot process on a machine reacts to a pad plugged into it. `isolate(devices)`
## replaces each all-devices joypad binding (InputEventJoypadButton, InputEventJoypadMotion) with
## one copy per id in `devices`, in place, so injected events on those virtual ids still match
## and driver pads (ids 0..15) no longer do. Key and mouse bindings are untouched.
##
## Limits:
##   - Only the InputMap is isolated. `Input.is_joy_button_pressed(0..15)`, `get_joy_axis()` and
##     `_input` handlers that read joypad events directly still see physical pads.
##   - Steam Input never consults the InputMap; isolate it in the product (couch does it with a
##     Harmony patch).
##   - Bindings added later (a remap screen, `InputMap.load_from_project_settings()`) are -1
##     again: call `isolate()` after them. Isolating again leaves already-rewritten bindings alone,
##     so widening the device list needs `restore()` first.
##   - Isolate while no joypad action is held: a press that matched a -1 binding is released by
##     an event that must match the rewritten one.
##   - Each listed id is one more binding per joypad binding; keep `devices` to the ids the host
##     really hands out (`GswInputInjector.virtual_devices()`).
##
##   var saved := GswJoypadIsolation.isolate(injector.virtual_devices(2))
##   GswJoypadIsolation.restore(saved)       # optional: put the original bindings back

## InputMap::ALL_DEVICES (not bound for scripts).
const ALL_DEVICES: int = -1


## Rewrite every all-devices joypad binding to `devices`. Returns the replaced bindings
## ({action: Array[InputEvent]} for each changed action), for `restore()`. Refuses (empty
## result, error logged) an empty list or an id outside 0..GswInputDevices.MAX_DEVICE.
static func isolate(devices: Array[int]) -> Dictionary:
	var saved: Dictionary = {}
	if devices.is_empty():
		push_error("GswJoypadIsolation.isolate: no devices")
		return saved
	for device: int in devices:
		if device < 0 or device > GswInputDevices.MAX_DEVICE:
			push_error("GswJoypadIsolation.isolate: device %d out of range" % device)
			return saved
	for action: StringName in InputMap.get_actions():
		var events: Array[InputEvent] = InputMap.action_get_events(action)
		var rewritten: Array[InputEvent] = []
		var changed: bool = false
		for event: InputEvent in events:
			if _is_joypad(event) and event.device == ALL_DEVICES:
				changed = true
				for device: int in devices:
					var copy: InputEvent = event.duplicate()
					copy.device = device
					rewritten.append(copy)
			else:
				rewritten.append(event)
		if changed:
			saved[action] = events
			_replace(action, rewritten)
	return saved


## Put back the bindings `isolate()` replaced. Actions erased since are skipped.
static func restore(saved: Dictionary) -> void:
	for key: Variant in saved:
		var action: StringName = key
		if not InputMap.has_action(action):
			continue
		var events: Array[InputEvent] = []
		var listed: Array = saved[key]
		events.assign(listed)
		_replace(action, events)


static func _is_joypad(event: InputEvent) -> bool:
	return event is InputEventJoypadButton or event is InputEventJoypadMotion


static func _replace(action: StringName, events: Array[InputEvent]) -> void:
	InputMap.action_erase_events(action)
	for event: InputEvent in events:
		InputMap.action_add_event(action, event)
