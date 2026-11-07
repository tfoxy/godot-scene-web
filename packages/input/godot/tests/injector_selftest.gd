extends SceneTree
## GswInputInjector against every packages/input/conformance/v1/injector vector,
## asserting real `Input` state in headless Godot: the three key sets, joypad buttons and axes,
## the test project's actions, the mouse button mask and position, the events `_input` actually
## received (Godot's emulated mouse from touch included), `remote_joypads()`, the joypad
## attach/detach signals and the injector's stats.
##
##   scripts/test-godot.sh            (runs the --import pass, then every tests/*_selftest.gd)
##
## Steps: {recv: object | text, channel?: "a", at?: msec, result?: code}, {close: channel},
## {tick: msec}, {release_all: true}, {focus_lost: true}, {reassert: true}, {isolate: [device]}.
## `focus_lost` stands in for a window focus-out: Input.release_pressed_events() is not bound for
## scripts, so the runner releases every pressed key, virtual button and axis with the probe muted
## (no `_input` delivery, as the engine call dispatches nothing) and every pressed action with
## `Input.action_release()` (what the engine call does, input.cpp:1290-1294), then calls
## on_focus_lost().
## `isolate` runs GswJoypadIsolation.isolate(); the bindings are restored after the vector.
## Target vectors: a vector's `scene` lists nodes created under the root before its first
## step ({path, class: Node|Control|Node2D, position, size, scale, visible, scene_file_path});
## Controls record their `_gui_input` as `gui` lines (control-local positions, ` meta=` with the
## `gsw_target` meta). Scene steps: {move: path, position}, {free: path}, {add: node},
## {hide: path}, {show: path}. `target_signals` lists the injector's pointer_target,
## target_missing and target_mismatch signals. The scene is freed after the vector. Hover only
## reaches `_gui_input` inside the headless root's 64x64 visible rect (viewport.cpp:2064).
## After each step the runner flushes Input; an `expect` entry
## {after: step index, ...} compares the state then. Absent state fields mean empty and absent
## `stats` means no counter; `dispatched` lists the events `_input` received since the previous
## entry; `mouse_position` is checked only where an entry lists it (Input keeps the position across
## vectors). `Input.get_mouse_position()` is not bound for scripts in 4.5.1: the root viewport's
## `get_mouse_position()` reads it on headless (no FEATURE_MOUSE, viewport.cpp:1462-1464).
## Events run from the first `_process` frame: `_input` delivery is not wired during
## `_initialize`. Joypad events from physical devices (ids < 16) are ignored, and physical pads
## are never inspected.
##
## Prints "[injector-selftest] ok N/N vectors" and quits 0, or prints each failure and quits 1.
## A dispatched event tagged with `gsw_target` meta ends with ` meta=<handle>`.

const TAG: String = "[injector-selftest]"
const ACTIONS: Array[String] = ["gsw_test_jump", "gsw_test_right"]
## Injected devices live in 16..MAX_DEVICE (physical pads are 0..15).
const FIRST_VIRTUAL: int = 16
const AXIS_COUNT: int = 10
const AXIS_TOLERANCE: float = 1e-6


## A test Control: records its `_gui_input` into the runner's shared `gui` list.
class GuiProbe:
	extends Control
	var lines: Array[String] = []

	func _gui_input(event: InputEvent) -> void:
		var path: String = str(get_tree().root.get_path_to(self))
		var line: String = ""
		if event is InputEventMouseButton:
			var button: InputEventMouseButton = event
			line = "mouse_button %d %d %s %s" % [
				button.device, button.button_index, "down" if button.pressed else "up", Probe.xy(button.position),
			]
		elif event is InputEventMouseMotion:
			var motion: InputEventMouseMotion = event
			line = "mouse_motion %d %s" % [motion.device, Probe.xy(motion.position)]
		elif event is InputEventScreenTouch:
			var touch: InputEventScreenTouch = event
			line = "screen_touch %d %s %s" % [touch.index, "down" if touch.pressed else "up", Probe.xy(touch.position)]
		elif event is InputEventScreenDrag:
			var drag: InputEventScreenDrag = event
			line = "screen_drag %d %s" % [drag.index, Probe.xy(drag.position)]
		else:
			return
		if event.has_meta(GswInputTargets.META):
			var meta: Dictionary = event.get_meta(GswInputTargets.META)
			var handle: int = meta["handle"]
			var meta_path: String = meta["path"]
			var local: Vector2 = meta["local"]
			line += " meta=%d:%s@%s" % [handle, meta_path, Probe.xy(local)]
		lines.append("%s %s" % [path, line])


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
		var line: String = describe_event(event)
		if line != "" and event.has_meta(GswInputTargets.META):
			var meta: Dictionary = event.get_meta(GswInputTargets.META)
			var handle: int = meta["handle"]
			line += " meta=%d" % handle
		return line

	static func describe_event(event: InputEvent) -> String:
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
		if event is InputEventMouseButton:
			var button: InputEventMouseButton = event
			var line: String = "mouse_button %d %d %s %s mask=%d" % [
				button.device, button.button_index, "down" if button.pressed else "up", xy(button.position),
				button.button_mask,
			]
			if button.factor != 1.0:
				line += " factor=%.2f" % button.factor
			if button.canceled:
				line += " canceled"
			if button.double_click:
				line += " double"
			return line + mods(button)
		if event is InputEventMouseMotion:
			var mouse: InputEventMouseMotion = event
			var line: String = "mouse_motion %d %s rel=%s mask=%d" % [
				mouse.device, xy(mouse.position), xy(mouse.relative), mouse.button_mask,
			]
			return line + pen(mouse.pressure, mouse.tilt, mouse.pen_inverted) + mods(mouse)
		if event is InputEventScreenTouch:
			var touch: InputEventScreenTouch = event
			var line: String = "screen_touch %d %d %s %s" % [
				touch.device, touch.index, "down" if touch.pressed else "up", xy(touch.position),
			]
			if touch.canceled:
				line += " canceled"
			if touch.double_tap:
				line += " double"
			return line
		if event is InputEventScreenDrag:
			var drag: InputEventScreenDrag = event
			var line: String = "screen_drag %d %d %s rel=%s" % [drag.device, drag.index, xy(drag.position), xy(drag.relative)]
			return line + pen(drag.pressure, drag.tilt, drag.pen_inverted)
		if event is InputEventAction:
			var action: InputEventAction = event
			return "action %s %s %.2f" % [action.action, "down" if action.pressed else "up", action.strength]
		return "other %s" % event.get_class()

	static func xy(point: Vector2) -> String:
		return "%.2f,%.2f" % [point.x + 0.0, point.y + 0.0]

	static func pen(pressure: float, tilt: Vector2, inverted: bool) -> String:
		var line: String = ""
		if pressure != 0.0:
			line += " pressure=%.2f" % pressure
		if tilt != Vector2.ZERO:
			line += " tilt=%s" % xy(tilt)
		if inverted:
			line += " inverted"
		return line

	static func mods(event: InputEventWithModifiers) -> String:
		var line: String = ""
		if event.shift_pressed:
			line += " +shift"
		if event.ctrl_pressed:
			line += " +ctrl"
		if event.alt_pressed:
			line += " +alt"
		if event.meta_pressed:
			line += " +meta"
		return line


var _probe: Probe
var _ran: bool = false
var _failures: int = 0
## Joypad attach/detach signals since the previous expect entry.
var _signals: Array[String] = []
## Target signals since the previous expect entry.
var _target_signals: Array[String] = []
## `_gui_input` lines of the vector's Controls since the previous expect entry (shared by every
## GuiProbe of the vector).
var _gui: Array[String] = []
## The vector's top-level scene nodes (freed after it).
var _scene: Array[Node] = []


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
	_target_signals.clear()
	_gui.clear()
	var injector := GswInputInjector.new()
	injector.joypad_attached.connect(_on_joypad.bind("attached"))
	injector.joypad_detached.connect(_on_joypad.bind("detached"))
	injector.pointer_target.connect(_on_pointer_target)
	injector.target_missing.connect(_on_target_missing)
	injector.target_mismatch.connect(_on_target_mismatch)
	var config: Dictionary = vector.get("config", {})
	if not injector.configure(config):
		_fail(file, "bad config")
		return
	var scene: Array = vector.get("scene", [])
	for item: Variant in scene:
		var spec: Dictionary = item
		if not _add_node(spec):
			_fail(file, "bad scene node %s" % JSON.stringify(spec))
	var isolation: Dictionary = {}
	_steps(file, vector, injector, isolation)
	GswJoypadIsolation.restore(isolation)
	for node: Node in _scene:
		if is_instance_valid(node):
			node.free()
	_scene.clear()


func _on_pointer_target(source: String, _event: InputEvent, node: Node, local: Vector2) -> void:
	_target_signals.append("pointer_target %s %s %s" % [source, root.get_path_to(node), Probe.xy(local)])


func _on_target_missing(source: String, identity: Dictionary) -> void:
	var handle: int = identity["handle"]
	_target_signals.append("target_missing %s %d" % [source, handle])


func _on_target_mismatch(source: String, identity: Dictionary, hovered: Control) -> void:
	var handle: int = identity["handle"]
	var where: String = str(root.get_path_to(hovered)) if hovered != null else "-"
	_target_signals.append("target_mismatch %s %d %s" % [source, handle, where])


## Create a scene node under the root ({path, class, position, size, scale, visible,
## scene_file_path}); false when its parent is missing or its class unknown.
func _add_node(spec: Dictionary) -> bool:
	var path: String = spec.get("path", "")
	var parent_path: String = path.get_base_dir()
	var parent: Node = root if parent_path == "" else root.get_node_or_null(NodePath(parent_path))
	if parent == null:
		return false
	var node: Node
	match spec.get("class", ""):
		"Node":
			node = Node.new()
		"Control":
			var control := GuiProbe.new()
			control.lines = _gui
			control.size = _vec2(spec.get("size"))
			control.position = _vec2(spec.get("position"))
			node = control
		"Node2D":
			var node_2d := Node2D.new()
			node_2d.position = _vec2(spec.get("position"))
			node_2d.scale = _vec2(spec.get("scale"), Vector2.ONE)
			node = node_2d
		_:
			return false
	node.name = path.get_file()
	var canvas: CanvasItem = node as CanvasItem
	if canvas != null:
		canvas.visible = spec.get("visible", true)
	node.scene_file_path = spec.get("scene_file_path", "")
	parent.add_child(node)
	if parent == root:
		_scene.append(node)
	return true


static func _vec2(value: Variant, fallback: Vector2 = Vector2.ZERO) -> Vector2:
	if typeof(value) != TYPE_ARRAY:
		return fallback
	var pair: Array = value
	var x: float = pair[0]
	var y: float = pair[1]
	return Vector2(x, y)


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
		elif step.has("move") or step.has("free") or step.has("hide") or step.has("show"):
			var key: String = "move" if step.has("move") else "free" if step.has("free") else "hide" if step.has("hide") else "show"
			var node_path: String = step[key]
			var node: Node = root.get_node_or_null(NodePath(node_path))
			if node == null:
				_fail(where, "no scene node %s" % node_path)
				return
			match key:
				"move":
					var item: CanvasItem = node as CanvasItem
					if item is Control:
						var control: Control = item
						control.position = _vec2(step["position"])
					elif item is Node2D:
						var node_2d: Node2D = item
						node_2d.position = _vec2(step["position"])
				"free":
					_scene.erase(node)
					node.free()
				_:
					var item: CanvasItem = node as CanvasItem
					item.visible = key == "show"
		elif step.has("add"):
			var spec: Dictionary = step["add"]
			if not _add_node(spec):
				_fail(where, "bad scene node %s" % JSON.stringify(spec))
				return
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
		"gui": _gui.duplicate(),
		"target_signals": _target_signals.duplicate(),
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
	for action: StringName in InputMap.get_actions():
		if Input.is_action_pressed(action):
			Input.action_release(action)
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

	var mask: int = Input.get_mouse_button_mask()
	var want_mask: float = expect.get("mouse_mask", 0)
	_same(where, "mouse_mask", mask, int(want_mask))
	if expect.has("mouse_position"):
		var listed_position: Array = expect["mouse_position"]
		var want_x: float = listed_position[0]
		var want_y: float = listed_position[1]
		_same(where, "mouse_position", root.get_mouse_position(), Vector2(want_x, want_y))

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

	var want_gui: Array[String] = []
	var listed_gui: Array = expect.get("gui", [])
	want_gui.assign(listed_gui)
	_same(where, "gui", _gui, want_gui)
	_gui.clear()
	var want_targets: Array[String] = []
	var listed_targets: Array = expect.get("target_signals", [])
	want_targets.assign(listed_targets)
	_same(where, "target_signals", _target_signals, want_targets)
	_target_signals.clear()

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
