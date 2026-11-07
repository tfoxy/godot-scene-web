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
## Release all (keys up replaying their press record, actions up, buttons up, axes to 0, then the
## pointer: mouse buttons up and touches canceled at their last position) runs on `reset`,
## `bye`, a new epoch for the source, `close_channel`, `stale_timeout_ms` (from `tick`) and
## `release_all()`.
##
## Scope: key, joypad_button, joypad_motion, the pointer kinds mouse_button, mouse_motion,
## screen_touch and screen_drag (GswInputPointer: one mouse owner, per-source touch ranges)
## and opt-in `action` are injected. Gestures pass the gates and are counted
## `kind-unsupported`. Target declarations fill each source's handle table; a targeted pointer
## record is placed by GswInputTargets (`retarget`, `missing_target`, held-button binding,
## `gsw_target` meta and the target signals). `install_event_filter` adds the physical-pointer
## filter (GswInputPointerFilter).
##
## Joypads: a source's pad slots get virtual device ids from GswInputDevices on first use,
## leased to the source until `lease_ms` after it closes, so a reconnect keeps its devices.
## Godot never lists injected pads, so `joypad_attached`/`joypad_detached` and `remote_joypads()`
## stand in for `joy_connection_changed`/`get_connected_joypads()`. GswJoypadIsolation keeps
## physical pads out of the InputMap. Focus loss (`on_focus_lost`, `reassert`) is handled by
## GswInputInjectorNode, which also calls `tick()` every frame. Mouse and touch events carry the
## first device of the source's leased block (`pointer_device_for`), without attaching a pad.
##
## Typical use, one call per carrier text:
##   var injector := GswInputInjector.new()
##   injector.receive(peer_id, packet_text, Time.get_ticks_msec())
##   injector.close_channel(peer_id)        # on disconnect: releases what the peer held

signal source_opened(source: String, epoch: int)
signal source_closed(source: String)
## A dropped message: a codec code (not `unknown-type`, which is ignored) or a session code.
signal rejected(channel: Variant, code: String, detail: String)
## A virtual pad device came into use: its first holder used pad `slot` (Godot sends no
## `joy_connection_changed` for injected devices).
signal joypad_attached(device: int, source: String, slot: int)
## A virtual pad device's last holder's lease expired.
signal joypad_detached(device: int, source: String, slot: int)
## A targeted event resolved to `node`, just before it is injected (its `gsw_target` meta is set;
## `local` is the point in the node's coordinates).
signal pointer_target(source: String, event: InputEvent, node: Node, local: Vector2)
## A targeted record's node cannot be resolved or is not visible in tree (`identity` is its
## declaration); the event goes by `missing_target`.
signal target_missing(source: String, identity: Dictionary)
## `verify_targets`: after a targeted mouse event, the hovered Control (or null) is neither the
## target nor inside it. Checked on `tick()`.
signal target_mismatch(source: String, identity: Dictionary, hovered: Control)

const DEFAULT_ACCEPT_KINDS: Array[String] = [
	"key", "joypad_button", "joypad_motion", "mouse_button", "mouse_motion", "screen_touch", "screen_drag",
]
## Every virtual device id stays below 2048 (GswInputDevices.MAX_DEVICE).
const MAX_DEVICE: int = GswInputDevices.MAX_DEVICE
const _POINTER_KINDS: Array[String] = ["mouse_button", "mouse_motion", "screen_touch", "screen_drag"]
const _INJECTED_KINDS: Array[String] = [
	"key", "joypad_button", "joypad_motion", "mouse_button", "mouse_motion", "screen_touch", "screen_drag",
	"action",
]
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
## Virtual pad ids (GswInputDevices): a source's pad slots get `device_base + block *
## devices_per_source + slot`, `block` the lowest free when it first uses a pad. Set before the
## first hello.
var device_base: int:
	get:
		return _devices.device_base
	set(value):
		_devices.device_base = value
var devices_per_source: int:
	get:
		return _devices.devices_per_source
	set(value):
		_devices.devices_per_source = value
## All sources share devices `device_base + slot` instead of one block each.
var share_devices: bool:
	get:
		return _devices.share_devices
	set(value):
		_devices.share_devices = value
## A closed source keeps its devices (and its block) this long, so a reconnect gets them back;
## then they detach. 0 = detach on close.
var lease_ms: int = 30000
## GswInputInjectorNode calls `reassert()` when the root window regains focus.
var reassert_on_focus_in: bool = false
## The `device` of injected key events.
var key_device: int = 0
## Release a source's state after this long without a message (0 = off). Pair it with the
## sender's heartbeat: >= 3x its interval.
var stale_timeout_ms: int = 0
## Records per source per second; over it a message is dropped (`rate`) but its releases apply.
var max_events_per_second: int = 2000
## Where events go; unset means `Input.parse_input_event`. Called with one InputEvent.
var event_sink: Callable = Callable()
## Which source owns Godot's one mouse: "last-active" (a mouse press takes it over), "first"
## (until its session closes) or a fixed source id. See GswInputPointer.
var mouse_owner: String = GswInputPointer.LAST_ACTIVE:
	set(value):
		mouse_owner = value
		if _pointer != null:
			_pointer.mouse_owner = value
## Where a targeted event goes when its coordinate misses its node: "off", "when-missed"
## (default) or "always" (GswInputTargets).
var retarget: String:
	get:
		return _targets.retarget
	set(value):
		_targets.retarget = value
## A target that cannot be resolved or is hidden: "coordinate" (default) or "drop".
var missing_target: String:
	get:
		return _targets.missing_target
	set(value):
		_targets.missing_target = value
## Emit `target_mismatch` from `tick()`.
var verify_targets: bool:
	get:
		return _targets.verify_targets
	set(value):
		_targets.verify_targets = value
## Host px within which a non-Control CanvasItem's `transform * local` counts as landed.
var target_tolerance: float:
	get:
		return _targets.tolerance
	set(value):
		_targets.tolerance = value


class _Source:
	var id: String = ""
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
	## action name -> its press strength, in press order.
	var actions: Dictionary = {}
	## target handle -> declaration record.
	var handles: Dictionary = {}
	## target handle -> weak refs to its resolved node(s) (GswInputTargets' cache).
	var resolved: Dictionary = {}
	var rate_start: int = 0
	var rate_count: int = 0
	## While closed: when its device lease ends (-1 while open).
	var lease_until: int = -1
	## Held state Godot dropped on focus loss (`on_focus_lost`), same shapes as keys/buttons/axes:
	## not in Input or the emitted refcounts, given back by `reassert()`.
	var lost_keys: Dictionary = {}
	var lost_buttons: Dictionary = {}
	var lost_axes: Dictionary = {}
	var lost_actions: Dictionary = {}
	## Its touch index range (`touch_index_base`): the lowest range free when it first said hello,
	## kept until the source is forgotten at lease end.
	var touch_range: int = 0


var _devices: GswInputDevices = GswInputDevices.new()
## Hello order (a source forgotten at lease end goes to the back on its next hello).
var _sources: Dictionary = {}
var _by_channel: Dictionary = {}
## "p87" / "k87" / "l87" -> sources holding that Input key set entry.
var _key_refs: Dictionary = {}
## device << 7 | button -> sources holding it.
var _button_refs: Dictionary = {}
## device << 4 | axis -> {source id: value}, in first-hold order.
var _axis_holders: Dictionary = {}
## device << 4 | axis -> the nonzero value last sent to Input.
var _axis_emitted: Dictionary = {}
## action name -> number of sources holding it.
var _action_refs: Dictionary = {}
var _pointer: GswInputPointer
var _targets: GswInputTargets = GswInputTargets.new(
	pointer_target.emit, target_missing.emit, target_mismatch.emit, _count
)
var _stats: Dictionary = {}


func _init() -> void:
	_devices.attached.connect(joypad_attached.emit)
	_devices.detached.connect(joypad_detached.emit)
	_pointer = GswInputPointer.new(_emit, _count)
	_pointer.mouse_owner = mouse_owner
	_pointer.targets = _targets


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
			"share_devices", "reassert_on_focus_in":
				if typeof(value) != TYPE_BOOL:
					ok = false
					continue
				var flag: String = key
				set(flag, value)
			"mouse_owner":
				if typeof(value) != TYPE_STRING:
					ok = false
					continue
				mouse_owner = value
			"retarget", "missing_target":
				var allowed: Array[String] = [GswInputTargets.COORDINATE, GswInputTargets.DROP]
				if key == "retarget":
					allowed = [GswInputTargets.OFF, GswInputTargets.WHEN_MISSED, GswInputTargets.ALWAYS]
				if typeof(value) != TYPE_STRING or not allowed.has(value):
					ok = false
					continue
				var policy: String = key
				set(policy, value)
			"verify_targets":
				if typeof(value) != TYPE_BOOL:
					ok = false
					continue
				verify_targets = value
			"target_tolerance":
				if not is_number:
					ok = false
					continue
				var tolerance: float = value
				target_tolerance = tolerance
			"device_base", "devices_per_source", "key_device", "lease_ms", "stale_timeout_ms", "max_events_per_second":
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


## The virtual joypad device a source's pad `slot` is on, or -1 when the source has not used
## that slot (or its lease ended).
func device_for(source: String, slot: int) -> int:
	return _devices.device_for(source, slot)


## Attached virtual pad device ids, ascending: what a game reads instead of
## `Input.get_connected_joypads()`, which never lists injected devices.
func remote_joypads() -> Array[int]:
	return _devices.attached_devices()


## Every id the first `sources` sources can be handed (for `GswJoypadIsolation.isolate()`).
func virtual_devices(sources: int = 1) -> Array[int]:
	return _devices.virtual_devices(sources)


## The virtual device of a source's mouse and touch events, or -1 when none is free: the first
## id of its leased device block (`device_base` with `share_devices`), taken on first use without
## attaching a pad, so it is the id its pad slot 0 gets too. Never 0, so `install_event_filter`
## can tell the local physical pointer apart.
func pointer_device_for(source: String) -> int:
	return _devices.block_device(source)


## The first host touch index of a source's range: its sender index i is host index `base + i`.
## Each source gets the lowest free range of 32 at its first hello and keeps it until forgotten.
func touch_index_base(source: String) -> int:
	var state: _Source = _sources.get(source)
	return 0 if state == null else state.touch_range * GswInputPointer.TOUCH_RANGE


func _free_touch_range() -> int:
	var used: Dictionary = {}
	for state: Variant in _sources.values():
		var other: _Source = state
		used[other.touch_range] = true
	var range_index: int = 0
	while used.has(range_index):
		range_index += 1
	return range_index


## The source owning the mouse, or "".
func mouse_source() -> String:
	return _pointer.owner_source()


## Add the physical-pointer filter (GswInputPointerFilter) to `root`, normally
## `get_tree().root`: it drops the local mouse and touch (device 0) before `_input` handlers and
## GUI see them, and never drops `DEVICE_ID_EMULATION` events.
static func install_event_filter(root: Node) -> GswInputPointerFilter:
	return GswInputPointerFilter.install(root)


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
			_close_source(source, now_msec)
	return ""


## The carrier connection closed: release what its source held and end the session. The
## source's devices stay leased for `lease_ms`.
func close_channel(channel: Variant, now_msec: int = -1) -> void:
	var source: _Source = _by_channel.get(channel)
	if source != null:
		if now_msec < 0:
			now_msec = Time.get_ticks_msec()
		_close_source(source, now_msec)


## Release everything every source holds; sessions stay open (their next `sync` restores state).
func release_all() -> void:
	for state: Variant in _sources.values():
		var source: _Source = state
		_release_source(source)


## Drive time-based rules: device leases of closed sources (`lease_ms`) and `stale_timeout_ms`.
func tick(now_msec: int = -1) -> void:
	if now_msec < 0:
		now_msec = Time.get_ticks_msec()
	_expire_leases(now_msec)
	if _targets.verify_targets:
		var tree: SceneTree = Engine.get_main_loop() as SceneTree
		_targets.verify(tree.root if tree != null else null)
	if stale_timeout_ms <= 0:
		return
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
	_expire_leases(now_msec)
	var source: _Source = _sources.get(id)
	if source == null:
		source = _Source.new()
		source.id = id
		source.touch_range = _free_touch_range()
		_sources[id] = source
	elif source.open and source.epoch == epoch:
		return _drop(channel, "duplicate", "hello repeats epoch %d" % epoch)
	var bound: _Source = _by_channel.get(channel)
	if bound != null and bound != source:
		_close_source(bound, now_msec)
	if source.open:
		# A new epoch: the old one's state goes, the source (and its devices) stays.
		_release_source(source)
		source.handles.clear()
		source.resolved.clear()
		_by_channel.erase(source.channel)
	source.open = true
	source.lease_until = -1
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


func _close_source(source: _Source, now_msec: int) -> void:
	_release_source(source)
	_pointer.close(source.id)
	source.open = false
	source.epoch = -1
	source.handles.clear()
	source.resolved.clear()
	_by_channel.erase(source.channel)
	source.channel = null
	source_closed.emit(source.id)
	source.lease_until = now_msec + lease_ms
	if lease_ms <= 0:
		_forget(source)


## Closed sources whose lease ended: their devices detach and the source is forgotten (a later
## hello starts it afresh).
func _expire_leases(now_msec: int) -> void:
	var ended: Array[_Source] = []
	for state: Variant in _sources.values():
		var source: _Source = state
		if not source.open and source.lease_until >= 0 and now_msec >= source.lease_until:
			ended.append(source)
	for source: _Source in ended:
		_forget(source)


func _forget(source: _Source) -> void:
	_sources.erase(source.id)
	_devices.release(source.id)


static func _is_release(record: Dictionary) -> bool:
	match record["event"]:
		"key", "joypad_button", "mouse_button", "screen_touch", "action":
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


## The gates every record passes; true when it is a record to inject.
func _admit(source: _Source, record: Dictionary) -> bool:
	var kind: String = record["event"]
	if kind == "target":
		var handle: int = record["handle"]
		source.handles[handle] = record
		source.resolved.erase(handle)
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
	if not _INJECTED_KINDS.has(kind):
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
		"action":
			_action(source, record)
		_:
			var device: int = pointer_device_for(source.id)
			if device < 0:
				_count("device-refused")
				return
			_pointer.apply(source.id, device, touch_index_base(source.id), record, source.handles, source.resolved)


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
	var echo: bool = pressed and record.get("echo", false) == true
	if not echo and _take_lost(source.lost_keys, id, pressed):
		return
	if echo:
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
	var physical_code: int = record.get("physical_keycode", 0)
	var keycode_code: int = record.get("keycode", 0)
	var label_code: int = record.get("key_label", 0)
	var physical: int = _ref_key("p", physical_code)
	var keycode: int = _ref_key("k", keycode_code)
	var label: int = _ref_key("l", label_code)
	if physical != 0 or keycode != 0 or label != 0:
		_emit_key(record, physical, keycode, label, true, false)


## Releases replay the press record (modifiers, location, unicode included) with pressed: false.
func _release_key(held: Dictionary) -> void:
	var physical_code: int = held.get("physical_keycode", 0)
	var keycode_code: int = held.get("keycode", 0)
	var label_code: int = held.get("key_label", 0)
	var physical: int = _unref_key("p", physical_code)
	var keycode: int = _unref_key("k", keycode_code)
	var label: int = _unref_key("l", label_code)
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


# --- actions -----------------------------------------------------------------------------------

## `action` records (allow-listed): refcounted per name like keys; a press of a held action is
## `repeat`, a release of one the source does not hold `unheld`. Releases carry strength 0.
func _action(source: _Source, record: Dictionary) -> void:
	var action: String = record["action"]
	var pressed: bool = record["pressed"]
	# Focus loss already released it in Godot (release_pressed_events releases every action).
	if source.lost_actions.erase(action) and not pressed:
		return
	if pressed == source.actions.has(action):
		_count("repeat" if pressed else "unheld")
		return
	if pressed:
		var strength: float = record.get("strength", 1.0)
		_press_action(source, action, strength)
	else:
		_release_action(source, action)


func _press_action(source: _Source, action: String, strength: float) -> void:
	source.actions[action] = strength
	var count: int = _action_refs.get(action, 0)
	_action_refs[action] = count + 1
	if count == 0:
		_emit_action(action, true, strength)


func _release_action(source: _Source, action: String) -> void:
	source.actions.erase(action)
	var count: int = _action_refs.get(action, 0)
	count -= 1
	if count > 0:
		_action_refs[action] = count
		return
	_action_refs.erase(action)
	_emit_action(action, false, 0.0)


func _emit_action(action: String, pressed: bool, strength: float) -> void:
	var event := InputEventAction.new()
	event.device = key_device
	event.action = action
	event.pressed = pressed
	event.strength = strength
	_emit(event)


# --- joypads -----------------------------------------------------------------------------------

func _joypad_button(source: _Source, record: Dictionary) -> void:
	var pad_slot: int = record.get("device", 0)
	var device: int = _devices.acquire(source.id, pad_slot)
	if device < 0:
		_count("device-refused")
		return
	var button: int = record.get("button_index", 0)
	var key: int = (device << _BUTTON_BITS) | button
	var pressed: bool = record["pressed"]
	if _take_lost(source.lost_buttons, key, pressed):
		return
	if pressed:
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
	var pad_slot: int = record.get("device", 0)
	var device: int = _devices.acquire(source.id, pad_slot)
	if device < 0:
		_count("device-refused")
		return
	var axis: int = record.get("axis", 0)
	var value: float = record.get("axis_value", 0.0)
	var key: int = (device << _AXIS_BITS) | axis
	source.lost_axes.erase(key)
	_set_axis(source, key, value + 0.0)


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


# --- focus loss --------------------------------------------------------------------------------

## The window lost OS focus and Godot already ran `Input.release_pressed_events()` (every desktop
## display server does on focus-out, core/input/input.cpp:1281): keys, joypad buttons, axes and
## actions are gone from Input without any release event. Forget that they were emitted, without emitting
## anything; each source's holds move aside, so its later release of one sends nothing, a fresh
## press presses again, a `sync` replaces them and `reassert()` presses them again. Pointer state
## is untouched (release_pressed_events keeps the mouse button mask).
func on_focus_lost() -> void:
	for state: Variant in _sources.values():
		var source: _Source = state
		source.lost_keys.merge(source.keys)
		source.lost_buttons.merge(source.buttons)
		source.lost_axes.merge(source.axes, true)
		source.lost_actions.merge(source.actions)
		source.keys.clear()
		source.buttons.clear()
		source.axes.clear()
		source.actions.clear()
	_key_refs.clear()
	_action_refs.clear()
	_button_refs.clear()
	_axis_holders.clear()
	_axis_emitted.clear()


## Press again what focus loss dropped and the sources still hold: keys (press order), actions
## (press order, at their strength), buttons, axes, source by source in hello order. GswInputInjectorNode calls it on focus-in when
## `reassert_on_focus_in` is set.
func reassert() -> void:
	for state: Variant in _sources.values():
		var source: _Source = state
		for id: Variant in source.lost_keys:
			if not source.keys.has(id):
				var record: Dictionary = source.lost_keys[id]
				source.keys[id] = record
				_press_key(record)
		for action: Variant in source.lost_actions:
			var name: String = action
			var strength: float = source.lost_actions[action]
			if not source.actions.has(name):
				_press_action(source, name, strength)
		for key: Variant in source.lost_buttons:
			var button_key: int = key
			if not source.buttons.has(button_key):
				_press_button(source, button_key)
		for key: Variant in source.lost_axes:
			var axis_key: int = key
			var value: float = source.lost_axes[key]
			_set_axis(source, axis_key, value)
		source.lost_keys.clear()
		source.lost_actions.clear()
		source.lost_buttons.clear()
		source.lost_axes.clear()


## A record for a control focus loss dropped: it leaves the lost set. True when the record is
## done (a release: Godot already released it); a press goes on as a fresh press.
static func _take_lost(lost: Dictionary, id: int, pressed: bool) -> bool:
	if not lost.erase(id):
		return false
	return not pressed


## A joypad sync for `device` supersedes what focus loss dropped on it.
static func _drop_lost_device(source: _Source, device: int) -> void:
	for key: Variant in source.lost_buttons.keys():
		var button_key: int = key
		if button_key >> _BUTTON_BITS == device:
			source.lost_buttons.erase(button_key)
	for key: Variant in source.lost_axes.keys():
		var axis_key: int = key
		if axis_key >> _AXIS_BITS == device:
			source.lost_axes.erase(axis_key)


# --- sync and release ----------------------------------------------------------------------------

func _apply_sync(source: _Source, message: Dictionary) -> void:
	var held: Array = message["held"]
	match message["scope"]:
		"keyboard":
			# A sync is the sender's whole held state: it supersedes what focus loss dropped.
			source.lost_keys.clear()
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
			var device: int = _devices.acquire(source.id, slot)
			if device < 0:
				_count("device-refused")
				return
			_drop_lost_device(source, device)
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
			var records: Array[Dictionary] = []
			for item: Variant in held:
				var record: Dictionary = item
				if _admit(source, record):
					records.append(record)
			var device: int = pointer_device_for(source.id)
			if device < 0:
				if not records.is_empty():
					_count("device-refused")
				return
			_pointer.sync(source.id, device, touch_index_base(source.id), records, source.handles, source.resolved)


func _release_source(source: _Source) -> void:
	source.lost_keys.clear()
	source.lost_buttons.clear()
	source.lost_axes.clear()
	source.lost_actions.clear()
	for id: Variant in source.keys.keys():
		var press: Dictionary = source.keys[id]
		_release_key(press)
	source.keys.clear()
	for action: Variant in source.actions.keys():
		var name: String = action
		_release_action(source, name)
	for key: Variant in source.buttons.keys():
		var button_key: int = key
		_release_button(source, button_key)
	for key: Variant in source.axes.keys():
		var axis_key: int = key
		_set_axis(source, axis_key, 0.0)
	_pointer.release(source.id)


func _emit(event: InputEvent) -> void:
	if event_sink.is_valid():
		event_sink.call(event)
	else:
		Input.parse_input_event(event)
