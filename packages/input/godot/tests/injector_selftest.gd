extends SceneTree
## IN7/IN8: GswInputInjector against every packages/input/conformance/v1/injector vector,
## asserting real `Input` state in headless Godot: the three key sets, joypad buttons and axes,
## the test project's actions, the events `_input` actually received, `remote_joypads()`, the
## joypad attach/detach signals and the injector's stats.
##
##   scripts/test-godot.sh            (runs the --import pass, then every tests/*_selftest.gd)
##
## Steps: {recv: object | text, channel?: "a", at?: msec, result?: code}, {close: channel},
## {tick: msec}, {release_all: true}, {focus_lost: true}, {reassert: true}, {isolate: [device]}.
## `focus_lost` stands in for a window focus-out: Input.release_pressed_events() is not bound for
## scripts, so the runner releases every pressed key, virtual button and axis with the probe muted
## (no `_input` delivery, as the engine call dispatches nothing), then calls on_focus_lost().
## `isolate` runs GswJoypadIsolation.isolate(); the bindings are restored after the vector.
## After each step the runner flushes Input; an `expect` entry
## {after: step index, ...} compares the state then. Absent state fields mean empty and absent
## `stats` means no counter; `dispatched` lists the events `_input` received since the previous
## entry. Events run from the first `_process` frame: `_input` delivery is not wired during
## `_initialize`. Joypad events from physical devices (ids < 16) are ignored, and physical pads
## are never inspected.
##
## Prints "[injector-selftest] ok N/N vectors" and quits 0, or prints each failure and quits 1.

const TAG: String = "[injector-selftest]"
const ACTIONS: Array[String] = ["gsw_test_jump", "gsw_test_right"]
## Injected devices live in 16..MAX_DEVICE (physical pads are 0..15).
const FIRST_VIRTUAL: int = 16
const AXIS_COUNT: int = 10
const AXIS_TOLERANCE: float = 1e-6


class Probe:
	extends Node
	var got: Array[String] = []
	var muted: bool = false

	func _input(event: InputEvent) -> void:
		if muted:
			return
		var line: String = describe(event)
		if line != "":
			got.append(line)

	## The vectors' `dispatched` notation; "" for events the runner ignores.
	static func describe(event: InputEvent) -> String:
		if event is InputEventKey:
			var key: InputEventKey = event
			var what: String = "echo" if key.echo else ("down" if key.pressed else "up")
			return "key %d/%d/%d %s" % [key.physical_keycode, key.keycode, key.key_label, what]
		if event.device < FIRST_VIRTUAL and (event is InputEventJoypadButton or event is InputEventJoypadMotion):
			return ""
		if event is InputEventJoypadButton:
			var button: InputEventJoypadButton = event
			return "joy_button %d %d %s" % [button.device, button.button_index, "down" if button.pressed else "up"]
		if event is InputEventJoypadMotion:
			var motion: InputEventJoypadMotion = event
			# + 0.0 turns -0.0 into 0.0, as JavaScript's toFixed prints it.
			var value: float = motion.axis_value + 0.0
			return "joy_motion %d %d %.4f" % [motion.device, motion.axis, value]
		return "other %s" % event.get_class()


var _probe: Probe
var _ran: bool = false
var _failures: int = 0
## Joypad attach/detach signals since the previous expect entry.
var _signals: Array[String] = []


func _initialize() -> void:
	_probe = Probe.new()
	root.add_child(_probe)


func _process(_delta: float) -> bool:
	if _ran:
		return true
	_ran = true
	var dir: String = ProjectSettings.globalize_path("res://").path_join("../conformance/v1/injector").simplify_path()
	var files: Array[String] = []
	for file: String in DirAccess.get_files_at(dir):
		if file.ends_with(".json"):
			files.append(file)
	files.sort()
	var failed_vectors: int = 0
	for file: String in files:
		# GswInputJson, not JSON: the vectors' numbers must read as the TypeScript model reads them.
		var parsed: Array = GswInputJson.parse(FileAccess.get_file_as_string(dir.path_join(file)))
		var before: int = _failures
		if not parsed[0] or typeof(parsed[1]) != TYPE_DICTIONARY:
			_fail(file, "does not parse")
		else:
			var vector: Dictionary = parsed[1]
			_run(file, vector)
		if _failures > before:
			failed_vectors += 1
	if files.is_empty():
		_fail(dir, "no vectors")
	if _failures == 0:
		print("%s ok %d/%d vectors" % [TAG, files.size(), files.size()])
	else:
		print("%s %d of %d vectors failed" % [TAG, failed_vectors, files.size()])
	quit(1 if _failures > 0 else 0)
	return true


func _fail(where: String, detail: String) -> void:
	_failures += 1
	print("%s FAIL: %s: %s" % [TAG, where, detail])


func _run(file: String, vector: Dictionary) -> void:
	# Input.release_pressed_events() is not bound for scripts in 4.5.1: every vector instead ends
	# with release_all(), checked to leave Input clean, so the next one starts clean.
	_probe.got.clear()
	_signals.clear()
	var injector := GswInputInjector.new()
	injector.joypad_attached.connect(_on_joypad.bind("attached"))
	injector.joypad_detached.connect(_on_joypad.bind("detached"))
	var config: Dictionary = vector.get("config", {})
	if not injector.configure(config):
		_fail(file, "bad config")
		return
	var isolation: Dictionary = {}
	_steps(file, vector, injector, isolation)
	GswJoypadIsolation.restore(isolation)


func _on_joypad(device: int, source: String, slot: int, what: String) -> void:
	_signals.append("%s %d %s %d" % [what, device, source, slot])


func _steps(file: String, vector: Dictionary, injector: GswInputInjector, isolation: Dictionary) -> void:
	var steps: Array = vector["steps"]
	var expects: Array = vector["expect"]
	var universe: Dictionary = _universe(vector)
	var now: int = 0
	var next_expect: int = 0
	for index: int in steps.size():
		var step: Dictionary = steps[index]
		var where: String = "%s step %d" % [file, index]
		if step.has("at"):
			var at: float = step["at"]
			now = int(at)
		if step.has("recv"):
			var payload: Variant = step["recv"]
			var text: String = payload if typeof(payload) == TYPE_STRING else JSON.stringify(payload, "", false, true)
			var channel: String = step.get("channel", "a")
			var got: String = injector.receive(channel, text, now)
			var want: String = step.get("result", "")
			if got != want:
				_fail(where, "receive returned '%s', expected '%s'" % [got, want])
		elif step.has("close"):
			var channel: String = step["close"]
			injector.close_channel(channel, now)
		elif step.has("tick"):
			var tick: float = step["tick"]
			now = int(tick)
			injector.tick(now)
		elif step.has("release_all"):
			injector.release_all()
		elif step.has("focus_lost"):
			_release_pressed_events(universe)
			injector.on_focus_lost()
		elif step.has("reassert"):
			injector.reassert()
		elif step.has("isolate"):
			var devices: Array[int] = _ints(step["isolate"])
			isolation.merge(GswJoypadIsolation.isolate(devices))
		else:
			_fail(where, "unknown step %s" % JSON.stringify(step))
			return
		Input.flush_buffered_events()
		while next_expect < expects.size():
			var expect: Dictionary = expects[next_expect]
			var after: float = expect["after"]
			if int(after) != index:
				break
			_compare("%s after %d" % [file, index], expect, injector, universe)
			next_expect += 1
	if next_expect < expects.size():
		_fail(file, "expect entry %d names no step" % next_expect)
	injector.release_all()
	Input.flush_buffered_events()
	var clean: Dictionary = {
		"dispatched": _probe.got.duplicate(),
		"joypads": injector.remote_joypads(),
		"joypad_signals": _signals.duplicate(),
		"stats": injector.stats(),
	}
	_compare("%s after release_all()" % file, clean, injector, universe)


## What Input.release_pressed_events() does to the state the vectors observe: clear the key sets,
## joypad buttons and axes and release their actions, dispatching nothing.
func _release_pressed_events(universe: Dictionary) -> void:
	_probe.muted = true
	var keys: Array = universe["keys"]
	for item: Variant in keys:
		var code: int = item
		var event := InputEventKey.new()
		if Input.is_physical_key_pressed(code as Key):
			event.physical_keycode = code as Key
		if Input.is_key_pressed(code as Key):
			event.keycode = code as Key
		if Input.is_key_label_pressed(code as Key):
			event.key_label = code as Key
		if event.physical_keycode != KEY_NONE or event.keycode != KEY_NONE or event.key_label != KEY_NONE:
			Input.parse_input_event(event)
	var buttons: Array = universe["buttons"]
	for device: int in range(FIRST_VIRTUAL, GswInputInjector.MAX_DEVICE + 1):
		for item: Variant in buttons:
			var button: int = item
			if Input.is_joy_button_pressed(device, button as JoyButton):
				var release := InputEventJoypadButton.new()
				release.device = device
				release.button_index = button as JoyButton
				Input.parse_input_event(release)
		for axis: int in AXIS_COUNT:
			if Input.get_joy_axis(device, axis as JoyAxis) != 0.0:
				var rest := InputEventJoypadMotion.new()
				rest.device = device
				rest.axis = axis as JoyAxis
				Input.parse_input_event(rest)
	Input.flush_buffered_events()
	_probe.muted = false


## Every key code and joypad button a vector can touch, so "nothing else is pressed" is checkable
## (Input exposes no list of pressed keys).
func _universe(vector: Dictionary) -> Dictionary:
	var keys: Dictionary = {}
	var buttons: Dictionary = {0: true}
	var stack: Array = [vector]
	while not stack.is_empty():
		var node: Variant = stack.pop_back()
		if typeof(node) == TYPE_STRING:
			var text: String = node
			if text.begins_with("{"):
				var parsed: Array = GswInputJson.parse(text)
				if parsed[0]:
					stack.append(parsed[1])
		elif typeof(node) == TYPE_ARRAY:
			var list: Array = node
			stack.append_array(list)
		elif typeof(node) == TYPE_DICTIONARY:
			var object: Dictionary = node
			for field: String in ["physical_keycode", "keycode", "key_label"]:
				if _is_number(object.get(field)):
					var code: float = object[field]
					keys[int(code)] = true
			if _is_number(object.get("button_index")):
				var button: float = object["button_index"]
				buttons[int(button)] = true
			for field: String in ["physical_keys", "keys", "labels"]:
				var listed: Array = object.get(field, [])
				for item: Variant in listed:
					if _is_number(item):
						var code: float = item
						keys[int(code)] = true
			stack.append_array(object.values())
	return {"keys": keys.keys(), "buttons": buttons.keys()}


static func _is_number(value: Variant) -> bool:
	return typeof(value) == TYPE_FLOAT or typeof(value) == TYPE_INT


static func _ints(value: Variant) -> Array[int]:
	var out: Array[int] = []
	if typeof(value) == TYPE_ARRAY:
		var list: Array = value
		for item: Variant in list:
			var number: float = item
			out.append(int(number))
	out.sort()
	return out


func _compare(where: String, expect: Dictionary, injector: GswInputInjector, universe: Dictionary) -> void:
	var keys: Array = universe["keys"]
	var physical: Array[int] = []
	var keycodes: Array[int] = []
	var labels: Array[int] = []
	for item: Variant in keys:
		var code: int = item
		if Input.is_physical_key_pressed(code as Key):
			physical.append(code)
		if Input.is_key_pressed(code as Key):
			keycodes.append(code)
		if Input.is_key_label_pressed(code as Key):
			labels.append(code)
	physical.sort()
	keycodes.sort()
	labels.sort()
	_same(where, "physical_keys", physical, _ints(expect.get("physical_keys", [])))
	_same(where, "keys", keycodes, _ints(expect.get("keys", [])))
	_same(where, "labels", labels, _ints(expect.get("labels", [])))

	var buttons: Array = universe["buttons"]
	var got_buttons: Array[String] = []
	var got_axes: Array[String] = []
	var got_values: Array[float] = []
	for device: int in range(FIRST_VIRTUAL, GswInputInjector.MAX_DEVICE + 1):
		for item: Variant in buttons:
			var button: int = item
			if Input.is_joy_button_pressed(device, button as JoyButton):
				got_buttons.append("%d:%d" % [device, button])
		for axis: int in AXIS_COUNT:
			var value: float = Input.get_joy_axis(device, axis as JoyAxis)
			if value != 0.0:
				got_axes.append("%d:%d" % [device, axis])
				got_values.append(value)
	var want_buttons: Array[String] = []
	var expected_buttons: Array = expect.get("joy_buttons", [])
	for item: Variant in expected_buttons:
		var entry: Array = item
		var device: float = entry[0]
		var button: float = entry[1]
		want_buttons.append("%d:%d" % [int(device), int(button)])
	got_buttons.sort()
	want_buttons.sort()
	_same(where, "joy_buttons", got_buttons, want_buttons)
	var want_axes: Array[String] = []
	var want_values: Dictionary = {}
	var expected_axes: Array = expect.get("joy_axes", [])
	for item: Variant in expected_axes:
		var entry: Array = item
		var device: float = entry[0]
		var axis: float = entry[1]
		var value: float = entry[2]
		var name: String = "%d:%d" % [int(device), int(axis)]
		want_axes.append(name)
		want_values[name] = value
	var sorted_axes: Array[String] = got_axes.duplicate()
	sorted_axes.sort()
	want_axes.sort()
	if sorted_axes != want_axes:
		_fail(where, "joy_axes %s, expected %s" % [sorted_axes, want_axes])
	else:
		for i: int in got_axes.size():
			var want_value: float = want_values[got_axes[i]]
			if absf(got_values[i] - want_value) > AXIS_TOLERANCE:
				_fail(where, "joy axis %s is %f, expected %f" % [got_axes[i], got_values[i], want_value])

	var actions: Array[String] = []
	for action: String in ACTIONS:
		if Input.is_action_pressed(action):
			actions.append(action)
	var want_actions: Array[String] = []
	var listed_actions: Array = expect.get("actions", [])
	want_actions.assign(listed_actions)
	want_actions.sort()
	_same(where, "actions", actions, want_actions)

	var want_dispatched: Array[String] = []
	var listed_dispatched: Array = expect.get("dispatched", [])
	want_dispatched.assign(listed_dispatched)
	_same(where, "dispatched", _probe.got, want_dispatched)
	_probe.got.clear()

	_same(where, "joypads", injector.remote_joypads(), _ints(expect.get("joypads", [])))
	var want_signals: Array[String] = []
	var listed_signals: Array = expect.get("joypad_signals", [])
	want_signals.assign(listed_signals)
	_same(where, "joypad_signals", _signals, want_signals)
	_signals.clear()

	var stats: Dictionary = injector.stats()
	var want_stats: Dictionary = expect.get("stats", {})
	var names: Dictionary = {}
	for name: Variant in stats:
		names[name] = true
	for name: Variant in want_stats:
		names[name] = true
	for name: Variant in names:
		var got_count: int = stats.get(name, 0)
		var want_count: float = want_stats.get(name, 0)
		if got_count != int(want_count):
			_fail(where, "stats[%s] %d, expected %d" % [name, got_count, int(want_count)])


func _same(where: String, what: String, got: Variant, want: Variant) -> void:
	if got != want:
		_fail(where, "%s %s, expected %s" % [what, got, want])
