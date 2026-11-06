class_name GswInputPointer
extends RefCounted
## The pointer half of GswInputInjector (docs/input.md "Pointer", "Injector API"): turns
## `mouse_button`, `mouse_motion`, `screen_touch` and `screen_drag` records into NEW InputEvents,
## keeps the pointer ledger and releases it. The injector owns sessions, gates and devices; it
## calls `apply`, `sync`, `release` and `close` with the source's id, its virtual device and the
## first host touch index of its range.
##
## One mouse. Godot's `Input` has one mouse position and button mask per instance, so one source
## owns the mouse at a time (`mouse_owner`):
##   - "last-active" (default): the first source to send a mouse record owns it; a mouse press
##     (wheel steps included) from another source takes it over;
##   - "first": the first source to send a mouse record owns it until its session closes;
##   - any other value: that source id, and only it.
## Another source's mouse records are dropped and counted `mouse-not-owner`. A takeover first
## releases the previous owner's held buttons. The owner keeps the mouse through `reset`, a new
## epoch and `stale_timeout_ms`; `bye` and `close_channel` give it up.
##
## Touches are multi-source: a source's sender index i is host index `touch_base + i`, so two
## viewers' fingers never collide. Godot's `emulate_mouse_from_touch` (on by default) turns the
## first touch into a LEFT mouse button with device DEVICE_ID_EMULATION (core/input/input.cpp:
## 840-860), so this never emits a mouse twin of a touch, and never calls `warp_mouse` (it moves
## the real OS cursor on a windowed instance).
##
## `button_mask` comes from this ledger, not the record: the owner's held buttons after the edge
## (a wheel press includes its bit, its release does not, as Godot web sends them). Every release
## the host makes up (release all, a takeover, a sync that no longer lists a button or touch) is
## `canceled: true`, at the last position: a game must not read it as a completed click or tap.
##
## Targets (IN12): with `targets` set, a record carrying a declared `target` (and every event of
## a press bound to one) is placed by GswInputTargets before its event is built, and the event
## is tagged with `gsw_target` meta. The mouse binding is the owner's first press's (until every
## button is up); each touch keeps its press's. A record without a target never reaches it.

const LAST_ACTIVE: String = "last-active"
const FIRST: String = "first"
## Sender touch indices are 0..31 (docs/input.md "screen_touch").
const TOUCH_RANGE: int = 32
const _BUTTONS: int = 9

## The ownership policy: "last-active", "first" or a fixed source id.
var mouse_owner: String = LAST_ACTIVE
## Target placement (GswInputInjector sets it); null places nothing.
var targets: GswInputTargets = null

var _emit: Callable
var _count: Callable
## The source owning the mouse, "" for none.
var _owner: String = ""
## The owner's MouseButtonMask bits held in Input.
var _held: int = 0
## The device of the owner's held buttons (their release goes out on it).
var _held_device: int = 0
## The last position a mouse event went out at.
var _position: Vector2 = Vector2.ZERO
## source id -> {host touch index: [position: Vector2, device: int, binding: Dictionary]}, in
## press order.
var _touches: Dictionary = {}
## The owner's mouse press binding (GswInputTargets.place), empty when unbound.
var _mouse_binding: Dictionary = {}


## `emit(event: InputEvent)` sends an event; `count(code: String)` counts a dropped record.
func _init(emit: Callable, count: Callable) -> void:
	_emit = emit
	_count = count


## The source owning the mouse, or "".
func owner_source() -> String:
	return _owner


## One admitted pointer record of `source`. `handles` and `resolved` are the source's target
## declarations and their resolution cache (GswInputTargets).
func apply(source: String, device: int, touch_base: int, record: Dictionary, handles: Dictionary = {}, resolved: Dictionary = {}) -> void:
	match record["event"]:
		"mouse_button":
			var pressed: bool = record["pressed"]
			if _take(source, device, pressed):
				_mouse_button(device, record, source, handles, resolved)
			else:
				_count.call("mouse-not-owner")
		"mouse_motion":
			if _take(source, device, false):
				_mouse_motion(device, record, source, handles, resolved)
			else:
				_count.call("mouse-not-owner")
		"screen_touch":
			_screen_touch(source, device, touch_base, record, handles, resolved)
		"screen_drag":
			_screen_drag(source, device, touch_base, record, handles, resolved)


## A `pointer` sync: the admitted `held` records (mouse buttons, at most one meaningful motion,
## touches). Mouse first (release what is not listed, move to the listed motion, press what is
## listed and not held), then touches (release, then press).
func sync(source: String, device: int, touch_base: int, held: Array[Dictionary], handles: Dictionary = {}, resolved: Dictionary = {}) -> void:
	var buttons: Dictionary = {}
	var motion: Dictionary = {}
	var touches: Dictionary = {}
	for record: Dictionary in held:
		match record["event"]:
			"mouse_button":
				var button: int = record["button_index"]
				buttons[button] = record
			"mouse_motion":
				motion = record
			"screen_touch":
				var index: int = record.get("index", 0)
				touches[touch_base + index] = record
	var listed: int = buttons.size() + (0 if motion.is_empty() else 1)
	if listed > 0 and not _take(source, device, not buttons.is_empty()):
		_count.call("mouse-not-owner", listed)
	elif _owner == source:
		for button: int in range(1, _BUTTONS + 1):
			if (_held & _bit(button)) != 0 and not buttons.has(button):
				_release_button(button)
		if not motion.is_empty():
			_mouse_motion(device, motion, source, handles, resolved)
		for button: int in range(1, _BUTTONS + 1):
			if buttons.has(button) and (_held & _bit(button)) == 0:
				var record: Dictionary = buttons[button]
				_mouse_button(device, record, source, handles, resolved)
	var held_touches: Dictionary = _touches.get(source, {})
	for index: Variant in held_touches.keys():
		if not touches.has(index):
			var host_index: int = index
			_cancel_touch(source, host_index)
	for index: Variant in touches:
		if not held_touches.has(index):
			var record: Dictionary = touches[index]
			_screen_touch(source, device, touch_base, record, handles, resolved)


## Release what `source` holds: its mouse buttons when it owns the mouse (ascending button
## index, at the last position), then its touches (press order); all `canceled`. Ownership stays.
func release(source: String) -> void:
	if _owner == source:
		_release_held()
	var held_touches: Dictionary = _touches.get(source, {})
	for index: Variant in held_touches.keys():
		var host_index: int = index
		_cancel_touch(source, host_index)
	_touches.erase(source)


## `release`, then give up the mouse.
func close(source: String) -> void:
	release(source)
	if _owner == source:
		_owner = ""


## True when `source` owns the mouse for this record, taking it over when the policy allows.
## `press` marks an activation ("last-active" takes over on one).
func _take(source: String, device: int, press: bool) -> bool:
	if _owner == source:
		return true
	var allowed: bool
	match mouse_owner:
		LAST_ACTIVE:
			allowed = _owner == "" or press
		FIRST:
			allowed = _owner == ""
		_:
			allowed = source == mouse_owner
	if not allowed:
		return false
	_release_held()
	_owner = source
	_held_device = device
	return true


static func _bit(button: int) -> int:
	return 1 << (button - 1)


static func _vec(value: Variant, fallback: Vector2 = Vector2.ZERO) -> Vector2:
	if typeof(value) != TYPE_ARRAY:
		return fallback
	var pair: Array = value
	var x: float = pair[0]
	var y: float = pair[1]
	return Vector2(x, y)


static func _modifiers(event: InputEventWithModifiers, record: Dictionary) -> void:
	event.shift_pressed = record.get("shift_pressed", false)
	event.ctrl_pressed = record.get("ctrl_pressed", false)
	event.alt_pressed = record.get("alt_pressed", false)
	event.meta_pressed = record.get("meta_pressed", false)


## Where a record's event goes: GswInputTargets' placement, or {} (by its coordinate) when the
## record names no target and nothing is bound.
func _place(source: String, handles: Dictionary, resolved: Dictionary, record: Dictionary, position: Vector2, binding: Dictionary, release: bool) -> Dictionary:
	if targets == null or (binding.is_empty() and record.get("target", 0) == 0):
		return {}
	var placement: Dictionary = targets.place(source, handles, resolved, record, position, binding, release)
	if placement["drop"]:
		_count.call("target-dropped")
	return placement


func _tag(source: String, event: InputEvent, placement: Dictionary) -> void:
	if not placement.is_empty():
		targets.tag(source, event, placement)


func _mouse_button(device: int, record: Dictionary, source: String = "", handles: Dictionary = {}, resolved: Dictionary = {}) -> void:
	var button: int = record["button_index"]
	var pressed: bool = record["pressed"]
	var bit: int = _bit(button)
	if pressed == ((_held & bit) != 0):
		_count.call("repeat" if pressed else "unheld")
		return
	var position: Vector2 = _vec(record["position"])
	var placement: Dictionary = _place(source, handles, resolved, record, position, _mouse_binding, not pressed)
	if not placement.is_empty():
		if placement["drop"]:
			return
		position = placement["position"]
		if pressed and _held == 0:
			_mouse_binding = placement["binding"]
	if pressed:
		_held |= bit
	else:
		_held &= ~bit
		if _held == 0:
			_mouse_binding = {}
	_held_device = device
	_position = position
	var event := InputEventMouseButton.new()
	event.device = device
	event.button_index = button as MouseButton
	event.pressed = pressed
	event.position = _position
	event.global_position = _position
	event.button_mask = _held as MouseButtonMask
	event.double_click = record.get("double_click", false)
	event.canceled = record.get("canceled", false)
	var factor: float = record.get("factor", 1.0)
	event.factor = factor
	_modifiers(event, record)
	_tag(source, event, placement)
	_emit.call(event)


func _mouse_motion(device: int, record: Dictionary, source: String = "", handles: Dictionary = {}, resolved: Dictionary = {}) -> void:
	var position: Vector2 = _vec(record["position"])
	var placement: Dictionary = _place(source, handles, resolved, record, position, _mouse_binding, false)
	if not placement.is_empty():
		if placement["drop"]:
			return
		position = placement["position"]
	_position = position
	var relative: Vector2 = _vec(record.get("relative"))
	var event := InputEventMouseMotion.new()
	event.device = device
	event.position = _position
	event.global_position = _position
	event.relative = relative
	event.screen_relative = relative
	event.velocity = Input.get_last_mouse_velocity()
	event.screen_velocity = Input.get_last_mouse_screen_velocity()
	event.button_mask = _held as MouseButtonMask
	var pressure: float = record.get("pressure", 0.0)
	event.pressure = pressure
	event.tilt = _vec(record.get("tilt"))
	event.pen_inverted = record.get("pen_inverted", false)
	_modifiers(event, record)
	_tag(source, event, placement)
	_emit.call(event)


## Every held button up at the last position, `canceled`.
func _release_held() -> void:
	for button: int in range(1, _BUTTONS + 1):
		if (_held & _bit(button)) != 0:
			_release_button(button)


func _release_button(button: int) -> void:
	_held &= ~_bit(button)
	if _held == 0:
		_mouse_binding = {}
	var event := InputEventMouseButton.new()
	event.device = _held_device
	event.button_index = button as MouseButton
	event.pressed = false
	event.canceled = true
	event.position = _position
	event.global_position = _position
	event.button_mask = _held as MouseButtonMask
	_emit.call(event)


func _screen_touch(source: String, device: int, touch_base: int, record: Dictionary, handles: Dictionary = {}, resolved: Dictionary = {}) -> void:
	var sender_index: int = record.get("index", 0)
	var index: int = touch_base + sender_index
	var pressed: bool = record["pressed"]
	var held: Dictionary = _touches.get(source, {})
	if pressed == held.has(index):
		_count.call("repeat" if pressed else "unheld")
		return
	var position: Vector2 = _vec(record["position"])
	var binding: Dictionary = {}
	if not pressed:
		var entry: Array = held[index]
		binding = entry[2]
	var placement: Dictionary = _place(source, handles, resolved, record, position, binding, not pressed)
	if not placement.is_empty():
		if placement["drop"]:
			return
		position = placement["position"]
		if pressed:
			binding = placement["binding"]
	if pressed:
		held[index] = [position, device, binding]
		_touches[source] = held
	else:
		held.erase(index)
	var event := InputEventScreenTouch.new()
	event.device = device
	event.index = index
	event.pressed = pressed
	event.position = position
	event.canceled = record.get("canceled", false)
	event.double_tap = record.get("double_tap", false)
	_tag(source, event, placement)
	_emit.call(event)


func _screen_drag(source: String, device: int, touch_base: int, record: Dictionary, handles: Dictionary = {}, resolved: Dictionary = {}) -> void:
	var sender_index: int = record.get("index", 0)
	var index: int = touch_base + sender_index
	var held: Dictionary = _touches.get(source, {})
	if not held.has(index):
		_count.call("unheld")
		return
	var position: Vector2 = _vec(record["position"])
	var entry: Array = held[index]
	var binding: Dictionary = entry[2]
	var placement: Dictionary = _place(source, handles, resolved, record, position, binding, false)
	if not placement.is_empty():
		if placement["drop"]:
			return
		position = placement["position"]
	held[index] = [position, device, binding]
	var relative: Vector2 = _vec(record.get("relative"))
	var event := InputEventScreenDrag.new()
	event.device = device
	event.index = index
	event.position = position
	event.relative = relative
	event.screen_relative = relative
	var pressure: float = record.get("pressure", 0.0)
	event.pressure = pressure
	event.tilt = _vec(record.get("tilt"))
	event.pen_inverted = record.get("pen_inverted", false)
	_tag(source, event, placement)
	_emit.call(event)


func _cancel_touch(source: String, index: int) -> void:
	var held: Dictionary = _touches.get(source, {})
	var entry: Array = held[index]
	held.erase(index)
	var event := InputEventScreenTouch.new()
	var position: Vector2 = entry[0]
	var device: int = entry[1]
	event.device = device
	event.index = index
	event.pressed = false
	event.canceled = true
	event.position = position
	_emit.call(event)
