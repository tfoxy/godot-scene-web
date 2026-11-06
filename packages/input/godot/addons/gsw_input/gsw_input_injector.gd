class_name GswInputInjector
extends RefCounted
## gsw-input/1 reference injector (docs/input.md "Session", "Injector API"): validates each
## message with GswInputCodec, applies the host session rules, and turns key and joypad records
## into NEW InputEvents for `Input.parse_input_event` (reusing one instance in a frame warns,
## core/input/input.cpp:1205-1227).
##
## Ledger, two levels:
##   - per source: the key press records it holds, its held joypad buttons and its nonzero axes;
##   - global "emitted" state: a refcount per Input key set entry (physical_keycode, keycode and
##     key_label are three separate sets in Input) and per joypad button, and the holders of each
##     axis. A press reaches Input only for the entries no other source already holds, and a
##     release only for the entries whose last holder lets go, so two sources holding one control
##     never release it under each other. A shared axis shows the last nonzero value written; when
##     a holder returns to 0 it falls back to the largest-magnitude remaining holder, then to 0.
##
## Release all (keys up replaying their press record, buttons up, axes to 0) runs on `reset`,
## `bye`, a new epoch for the source, `close_channel`, `stale_timeout_ms` (from `tick`) and
## `release_all()`.
##
## Scope (IN7): key, joypad_button and joypad_motion are injected. Pointer records (IN9), `action`
## and gestures pass the gates (`accept_kinds`, `allowed_actions`) and are then counted
## `kind-unsupported`. Joypad devices come from the fixed `device_for()` mapping; IN8 replaces it
## with leased allocation, `GswJoypadIsolation` and the focus-handling `GswInputInjectorNode`.
##
## Typical use, one call per carrier text:
##   var injector := GswInputInjector.new()
##   injector.receive(peer_id, packet_text, Time.get_ticks_msec())
##   injector.close_channel(peer_id)        # on disconnect: releases what the peer held

signal source_opened(source: String, epoch: int)
signal source_closed(source: String)
## A dropped message: a codec code (not `unknown-type`, which is ignored) or a session code.
signal rejected(channel: Variant, code: String, detail: String)

const DEFAULT_ACCEPT_KINDS: Array[String] = [
	"key", "joypad_button", "joypad_motion", "mouse_button", "mouse_motion", "screen_touch", "screen_drag",
]
## Godot packs `device << 20` into joypad button and axis keys (`_combine_device`,
## core/input/input.cpp:357-363), so every device id stays below 2048.
const MAX_DEVICE: int = 2047
const _POINTER_KINDS: Array[String] = ["mouse_button", "mouse_motion", "screen_touch", "screen_drag"]
const _RATE_WINDOW_MS: int = 1000
# Key identity namespaces (a key record is identified by its first nonzero keycode).
const _ID_KEYCODE: int = 1 << 24
const _ID_LABEL: int = 2 << 24
# Ledger keys: device << 7 | button, device << 4 | axis.
const _BUTTON_BITS: int = 7
const _AXIS_BITS: int = 4

## Record kinds the host accepts; any other known kind is dropped and counted `kind-refused`.
var accept_kinds: Array[String] = DEFAULT_ACCEPT_KINDS.duplicate()
## `action` records additionally need their name here (`action-refused` otherwise).
var allowed_actions: Array[String] = []
## First virtual joypad device id (>= Input::JOYPADS_MAX 16, so physical pads never collide).
var device_base: int = 64
var devices_per_source: int = 4
## All sources share devices `device_base + slot` instead of one block each.
var share_devices: bool = false
## The `device` of injected key events.
var key_device: int = 0
## Release a source's state after this long without a message (0 = off). Pair it with the
## sender's heartbeat: >= 3x its interval.
var stale_timeout_ms: int = 0
## Records per source per second; over it a message is dropped (`rate`) but its releases apply.
var max_events_per_second: int = 2000
## Where events go; unset means `Input.parse_input_event`. Called with one InputEvent.
var event_sink: Callable = Callable()


class _Source:
	var id: String = ""
	## Allocation order, for the fixed device mapping.
	var index: int = 0
	var channel: Variant = null
	var open: bool = false
	var epoch: int = -1
	var last_seq: int = 0
	var last_msec: int = 0
	var stale: bool = false
	## key identity -> the press record (Dictionary), in press order.
	var keys: Dictionary = {}
	## device << 7 | button -> true.
	var buttons: Dictionary = {}
	## device << 4 | axis -> nonzero value.
	var axes: Dictionary = {}
	## target handle -> declaration record (pointer targets; resolved in IN9/IN12).
	var handles: Dictionary = {}
	var rate_start: int = 0
	var rate_count: int = 0


var _sources: Dictionary = {}
var _by_channel: Dictionary = {}
var _next_index: int = 0
## "p87" / "k87" / "l87" -> sources holding that Input key set entry.
var _key_refs: Dictionary = {}
## device << 7 | button -> sources holding it.
var _button_refs: Dictionary = {}
## device << 4 | axis -> {source id: value}, in first-hold order.
var _axis_holders: Dictionary = {}
## device << 4 | axis -> the nonzero value last sent to Input.
var _axis_emitted: Dictionary = {}
var _stats: Dictionary = {}


## Apply settings from a Dictionary (JSON numbers welcome). Returns false on an unknown key or a
## wrong type, applying nothing for that key.
func configure(config: Dictionary) -> bool:
	var ok: bool = true
	for key: Variant in config:
		var value: Variant = config[key]
		var is_number: bool = typeof(value) == TYPE_INT or typeof(value) == TYPE_FLOAT
		match key:
			"accept_kinds", "allowed_actions":
				if typeof(value) != TYPE_ARRAY:
					ok = false
					continue
				var list: Array = value
				var names: Array[String] = []
				for item: Variant in list:
					names.append(str(item))
				if key == "accept_kinds":
					accept_kinds = names
				else:
					allowed_actions = names
			"share_devices":
				if typeof(value) != TYPE_BOOL:
					ok = false
					continue
				share_devices = value
			"device_base", "devices_per_source", "key_device", "stale_timeout_ms", "max_events_per_second":
				if not is_number:
					ok = false
					continue
				var number: float = value
				var property: String = key
				set(property, int(number))
			_:
				push_error("GswInputInjector.configure: unknown setting %s" % key)
				ok = false
	return ok


## The virtual joypad device for a source's pad `slot`, or -1 when it has none.
##
## IN8 seam: this fixed mapping (one block of `devices_per_source` ids per source, in hello order,
## never reused) is what leased allocation replaces; override it in a subclass meanwhile. Keep
## every id in `device_base..MAX_DEVICE`.
func device_for(source: String, slot: int) -> int:
	var state: _Source = _sources.get(source)
	if state == null or slot < 0 or slot >= devices_per_source:
		return -1
	var device: int = device_base + slot
	if not share_devices:
		device += state.index * devices_per_source
	return device if device <= MAX_DEVICE else -1


## Handle one carrier text from `channel` (any Variant that names the connection). Returns "" when
## the message was applied, else the codec or session code it was dropped (or ignored) for.
func receive(channel: Variant, text: String, now_msec: int = -1) -> String:
	if now_msec < 0:
		now_msec = Time.get_ticks_msec()
	var result: Dictionary = GswInputCodec.parse(text)
	if not result["ok"]:
		var code: String = result["code"]
		_count(code)
		if code != "unknown-type":
			rejected.emit(channel, code, "%s %s" % [result["path"], result["detail"]])
		return code
	var skipped: int = result["skipped"]
	if skipped > 0:
		_count("skipped", skipped)
	var message: Dictionary = result["message"]
	var type: String = message["type"]
	if type == "hello":
		return _hello(channel, message, now_msec)

	var source: _Source = _by_channel.get(channel)
	if source == null:
		return _drop(channel, "no-hello", "no accepted hello on this channel")
	var epoch: int = message["epoch"]
	if epoch != source.epoch:
		return _drop(channel, "stale-epoch", "epoch %d is not %d" % [epoch, source.epoch])
	var seq: int = message["seq"]
	if seq <= source.last_seq:
		return _drop(channel, "duplicate", "seq %d <= %d" % [seq, source.last_seq])
	if seq > source.last_seq + 1:
		_count("gap")
	source.last_seq = seq
	source.last_msec = now_msec
	source.stale = false

	match type:
		"events":
			var records: Array = message["events"]
			return _apply_events(source, records, now_msec)
		"sync":
			_apply_sync(source, message)
		"reset":
			_release_source(source)
		"bye":
			_close_source(source)
	return ""


## The carrier connection closed: release what its source held and end the session.
func close_channel(channel: Variant) -> void:
	var source: _Source = _by_channel.get(channel)
	if source != null:
		_close_source(source)


## Release everything every source holds; sessions stay open (their next `sync` restores state).
func release_all() -> void:
	for state: Variant in _sources.values():
		var source: _Source = state
		_release_source(source)


## Drive time-based rules: `stale_timeout_ms`.
func tick(now_msec: int = -1) -> void:
	if stale_timeout_ms <= 0:
		return
	if now_msec < 0:
		now_msec = Time.get_ticks_msec()
	for state: Variant in _sources.values():
		var source: _Source = state
		if source.open and not source.stale and now_msec - source.last_msec >= stale_timeout_ms:
			source.stale = true
			_count("stale-timeout")
			_release_source(source)


## Counters of everything dropped, ignored or refused (codec codes, session codes, `skipped`,
## `kind-refused`, ...). Only nonzero counters are present.
func stats() -> Dictionary:
	return _stats.duplicate()


func _count(code: String, n: int = 1) -> void:
	var count: int = _stats.get(code, 0)
	_stats[code] = count + n


func _drop(channel: Variant, code: String, detail: String) -> String:
	_count(code)
	rejected.emit(channel, code, detail)
	return code


func _hello(channel: Variant, message: Dictionary, now_msec: int) -> String:
	var id: String = message["source"]
	var epoch: int = message["epoch"]
	var source: _Source = _sources.get(id)
	if source == null:
		source = _Source.new()
		source.id = id
		source.index = _next_index
		_next_index += 1
		_sources[id] = source
	elif source.open and source.epoch == epoch:
		return _drop(channel, "duplicate", "hello repeats epoch %d" % epoch)
	var bound: _Source = _by_channel.get(channel)
	if bound != null and bound != source:
		_close_source(bound)
	if source.open:
		# A new epoch: the old one's state goes, the source (and its devices) stays.
		_release_source(source)
		source.handles.clear()
		_by_channel.erase(source.channel)
	source.open = true
	source.epoch = epoch
	source.last_seq = message.get("seq", 0)
	source.last_msec = now_msec
	source.stale = false
	source.rate_start = now_msec
	source.rate_count = 0
	source.channel = channel
	_by_channel[channel] = source
	source_opened.emit(id, epoch)
	return ""


func _close_source(source: _Source) -> void:
	_release_source(source)
	source.open = false
	source.epoch = -1
	source.handles.clear()
	_by_channel.erase(source.channel)
	source.channel = null
	source_closed.emit(source.id)


static func _is_release(record: Dictionary) -> bool:
	match record["event"]:
		"key", "joypad_button":
			return record["pressed"] == false
		"joypad_motion":
			return record.get("axis_value", 0.0) == 0.0
	return false


func _apply_events(source: _Source, records: Array, now_msec: int) -> String:
	if max_events_per_second > 0:
		if now_msec - source.rate_start >= _RATE_WINDOW_MS or now_msec < source.rate_start:
			source.rate_start = now_msec
			source.rate_count = 0
		if source.rate_count + records.size() > max_events_per_second:
			_count("rate")
			# Never lose a release to the cap.
			for item: Variant in records:
				var record: Dictionary = item
				if _is_release(record):
					_apply_record(source, record)
			rejected.emit(source.channel, "rate", "over %d records per second" % max_events_per_second)
			return "rate"
		source.rate_count += records.size()
	for item: Variant in records:
		var record: Dictionary = item
		_apply_record(source, record)
	return ""


## The gates every record passes; true when it is a key or joypad record to apply.
func _admit(source: _Source, record: Dictionary) -> bool:
	var kind: String = record["event"]
	if kind == "target":
		var handle: int = record["handle"]
		source.handles[handle] = record
		return false
	if not accept_kinds.has(kind):
		_count("kind-refused")
		return false
	if kind == "action":
		var action: String = record["action"]
		if not allowed_actions.has(action):
			_count("action-refused")
			return false
	elif _POINTER_KINDS.has(kind):
		var handle: int = record.get("target", 0)
		if handle != 0 and not source.handles.has(handle):
			_count("undeclared-target")
	if kind != "key" and kind != "joypad_button" and kind != "joypad_motion":
		_count("kind-unsupported")
		return false
	return true


func _apply_record(source: _Source, record: Dictionary) -> void:
	if not _admit(source, record):
		return
	match record["event"]:
		"key":
			_key(source, record)
		"joypad_button":
			_joypad_button(source, record)
		"joypad_motion":
			_joypad_motion(source, record)


# --- keys --------------------------------------------------------------------------------------

static func _key_identity(record: Dictionary) -> int:
	var physical: int = record.get("physical_keycode", 0)
	if physical != 0:
		return physical
	var keycode: int = record.get("keycode", 0)
	if keycode != 0:
		return _ID_KEYCODE | keycode
	var label: int = record.get("key_label", 0)
	return _ID_LABEL | label


func _key(source: _Source, record: Dictionary) -> void:
	var id: int = _key_identity(record)
	var pressed: bool = record["pressed"]
	if pressed and record.get("echo", false) == true:
		if not source.keys.has(id):
			_count("unheld")
			return
		var physical: int = record.get("physical_keycode", 0)
		var keycode: int = record.get("keycode", 0)
		var label: int = record.get("key_label", 0)
		_emit_key(record, physical, keycode, label, true, true)
		return
	if pressed:
		if source.keys.has(id):
			_count("repeat")
			return
		source.keys[id] = record
		_press_key(record)
		return
	if not source.keys.has(id):
		_count("unheld")
		return
	var held: Dictionary = source.keys[id]
	source.keys.erase(id)
	_release_key(held)


## +1 on the entry; returns `code` when this source is its first holder, else 0.
func _ref_key(prefix: String, code: int) -> int:
	if code == 0:
		return 0
	var entry: String = prefix + str(code)
	var count: int = _key_refs.get(entry, 0)
	count += 1
	_key_refs[entry] = count
	return code if count == 1 else 0


## -1 on the entry; returns `code` when this was its last holder, else 0.
func _unref_key(prefix: String, code: int) -> int:
	if code == 0:
		return 0
	var entry: String = prefix + str(code)
	var count: int = _key_refs.get(entry, 0)
	count -= 1
	if count > 0:
		_key_refs[entry] = count
		return 0
	_key_refs.erase(entry)
	return code


func _press_key(record: Dictionary) -> void:
	var physical: int = _ref_key("p", record.get("physical_keycode", 0))
	var keycode: int = _ref_key("k", record.get("keycode", 0))
	var label: int = _ref_key("l", record.get("key_label", 0))
	if physical != 0 or keycode != 0 or label != 0:
		_emit_key(record, physical, keycode, label, true, false)


## Releases replay the press record (modifiers, location, unicode included) with pressed: false.
func _release_key(held: Dictionary) -> void:
	var physical: int = _unref_key("p", held.get("physical_keycode", 0))
	var keycode: int = _unref_key("k", held.get("keycode", 0))
	var label: int = _unref_key("l", held.get("key_label", 0))
	if physical != 0 or keycode != 0 or label != 0:
		_emit_key(held, physical, keycode, label, false, false)


func _emit_key(record: Dictionary, physical: int, keycode: int, label: int, pressed: bool, echo: bool) -> void:
	var event := InputEventKey.new()
	event.device = key_device
	event.physical_keycode = physical as Key
	event.keycode = keycode as Key
	event.key_label = label as Key
	var unicode: int = record.get("unicode", 0)
	event.unicode = unicode
	var location: int = record.get("location", 0)
	event.location = location as KeyLocation
	event.pressed = pressed
	event.echo = echo
	event.shift_pressed = record.get("shift_pressed", false)
	event.ctrl_pressed = record.get("ctrl_pressed", false)
	event.alt_pressed = record.get("alt_pressed", false)
	event.meta_pressed = record.get("meta_pressed", false)
	_emit(event)


# --- joypads -----------------------------------------------------------------------------------

func _joypad_button(source: _Source, record: Dictionary) -> void:
	var device: int = device_for(source.id, record.get("device", 0))
	if device < 0:
		_count("device-refused")
		return
	var button: int = record.get("button_index", 0)
	var key: int = (device << _BUTTON_BITS) | button
	if record["pressed"]:
		if source.buttons.has(key):
			_count("repeat")
			return
		_press_button(source, key)
	elif not source.buttons.has(key):
		_count("unheld")
	else:
		_release_button(source, key)


func _press_button(source: _Source, key: int) -> void:
	source.buttons[key] = true
	var count: int = _button_refs.get(key, 0)
	count += 1
	_button_refs[key] = count
	if count == 1:
		_emit_button(key, true)


func _release_button(source: _Source, key: int) -> void:
	source.buttons.erase(key)
	var count: int = _button_refs.get(key, 0)
	count -= 1
	if count > 0:
		_button_refs[key] = count
		return
	_button_refs.erase(key)
	_emit_button(key, false)


func _emit_button(key: int, pressed: bool) -> void:
	var event := InputEventJoypadButton.new()
	event.device = key >> _BUTTON_BITS
	var button: int = key & ((1 << _BUTTON_BITS) - 1)
	event.button_index = button as JoyButton
	event.pressed = pressed
	_emit(event)


func _joypad_motion(source: _Source, record: Dictionary) -> void:
	var device: int = device_for(source.id, record.get("device", 0))
	if device < 0:
		_count("device-refused")
		return
	var axis: int = record.get("axis", 0)
	var value: float = record.get("axis_value", 0.0)
	_set_axis(source, (device << _AXIS_BITS) | axis, value + 0.0)


func _set_axis(source: _Source, key: int, value: float) -> void:
	var holders: Dictionary = _axis_holders.get(key, {})
	var target: float = value
	if value != 0.0:
		source.axes[key] = value
		holders[source.id] = value
	else:
		source.axes.erase(key)
		holders.erase(source.id)
		for held: Variant in holders.values():
			var other: float = held
			if absf(other) > absf(target):
				target = other
	if holders.is_empty():
		_axis_holders.erase(key)
	else:
		_axis_holders[key] = holders
	var emitted: float = _axis_emitted.get(key, 0.0)
	if target == emitted:
		return
	if target == 0.0:
		_axis_emitted.erase(key)
	else:
		_axis_emitted[key] = target
	var event := InputEventJoypadMotion.new()
	event.device = key >> _AXIS_BITS
	var axis: int = key & ((1 << _AXIS_BITS) - 1)
	event.axis = axis as JoyAxis
	event.axis_value = target
	_emit(event)


# --- sync and release ----------------------------------------------------------------------------

func _apply_sync(source: _Source, message: Dictionary) -> void:
	var held: Array = message["held"]
	match message["scope"]:
		"keyboard":
			var listed: Dictionary = {}
			for item: Variant in held:
				var record: Dictionary = item
				if _admit(source, record):
					listed[_key_identity(record)] = record
			for id: Variant in source.keys.keys():
				if not listed.has(id):
					var press: Dictionary = source.keys[id]
					source.keys.erase(id)
					_release_key(press)
			for id: Variant in listed:
				if not source.keys.has(id):
					var record: Dictionary = listed[id]
					source.keys[id] = record
					_press_key(record)
		"joypad":
			var slot: int = message["device"]
			var device: int = device_for(source.id, slot)
			if device < 0:
				_count("device-refused")
				return
			var buttons: Dictionary = {}
			var axes: Dictionary = {}
			for item: Variant in held:
				var record: Dictionary = item
				if not _admit(source, record):
					continue
				if record["event"] == "joypad_button":
					var button: int = record.get("button_index", 0)
					buttons[(device << _BUTTON_BITS) | button] = true
				else:
					var axis: int = record.get("axis", 0)
					var value: float = record.get("axis_value", 0.0)
					var key: int = (device << _AXIS_BITS) | axis
					axes.erase(key)
					if value != 0.0:
						axes[key] = value + 0.0
			for key: Variant in source.buttons.keys():
				var button_key: int = key
				if button_key >> _BUTTON_BITS == device and not buttons.has(button_key):
					_release_button(source, button_key)
			for key: Variant in source.axes.keys():
				var axis_key: int = key
				if axis_key >> _AXIS_BITS == device and not axes.has(axis_key):
					_set_axis(source, axis_key, 0.0)
			for key: Variant in buttons:
				var button_key: int = key
				if not source.buttons.has(button_key):
					_press_button(source, button_key)
			for key: Variant in axes:
				var axis_key: int = key
				var value: float = axes[key]
				_set_axis(source, axis_key, value)
		"pointer":
			# IN9: pointer held state. Declarations apply; the rest is gated and counted.
			for item: Variant in held:
				var record: Dictionary = item
				_admit(source, record)


func _release_source(source: _Source) -> void:
	for id: Variant in source.keys.keys():
		var press: Dictionary = source.keys[id]
		_release_key(press)
	source.keys.clear()
	for key: Variant in source.buttons.keys():
		var button_key: int = key
		_release_button(source, button_key)
	for key: Variant in source.axes.keys():
		var axis_key: int = key
		_set_axis(source, axis_key, 0.0)


func _emit(event: InputEvent) -> void:
	if event_sink.is_valid():
		event_sink.call(event)
	else:
		Input.parse_input_event(event)
