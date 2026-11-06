extends SceneTree
## IN8: GswInputInjectorNode wiring in headless Godot (headless never loses focus, so the test
## sends the signals and notifications a desktop display server would):
##   - the root window's `focus_exited` and the application FOCUS_OUT notification both reach
##     `on_focus_lost()`: after Godot's release (emulated with a direct release event, as
##     Input.release_pressed_events() is not bound for scripts) the sender's release sends
##     nothing;
##   - with `reassert_on_focus_in`, `focus_entered` and FOCUS_IN press the held key again;
##   - it ticks while the tree is paused (`stale_timeout_ms` fires);
##   - leaving the tree releases what it injected.
##
## Prints "[injector-node-selftest] ok N checks" and quits 0, or prints each failure and quits 1.

const TAG: String = "[injector-node-selftest]"
const STALE_MS: int = 30
const PRESSED: Array[String] = ["87 down"]

var _host: GswInputInjectorNode
var _phase: int = 0
var _seq: int = 0
var _epoch: int = 0
var _paused_at: int = 0
var _checks: int = 0
var _failures: int = 0
var _dispatched: Array[String] = []


func _initialize() -> void:
	_host = GswInputInjectorNode.new()
	_host.injector.configure({"reassert_on_focus_in": true, "stale_timeout_ms": STALE_MS})
	_host.injector.event_sink = _sink
	root.add_child(_host)


## Records what the injector emits, then hands it to Input as the default sink would.
func _sink(event: InputEvent) -> void:
	var key: InputEventKey = event
	_dispatched.append("%d %s" % [key.physical_keycode, "down" if key.pressed else "up"])
	Input.parse_input_event(event)


func _process(_delta: float) -> bool:
	match _phase:
		0:
			_focus()
			paused = true
			_paused_at = Time.get_ticks_msec()
			_phase = 1
		1:
			# Wait (paused) for the node's own tick to time the source out.
			if Time.get_ticks_msec() - _paused_at > STALE_MS * 10:
				_check("a paused tree still ticks: stale-timeout fired", false)
				_phase = 2
			elif _host.injector.stats().get("stale-timeout", 0) == 1:
				Input.flush_buffered_events()
				_check("stale timeout released the key", not Input.is_physical_key_pressed(KEY_W))
				paused = false
				_phase = 2
		2:
			_exit()
			_finish()
	return false


func _focus() -> void:
	_hello()
	_send(true)
	Input.flush_buffered_events()
	_check("injected key is pressed", Input.is_physical_key_pressed(KEY_W))

	for via: String in ["window", "application"]:
		_godot_release()
		if via == "window":
			root.focus_exited.emit()
		else:
			notification(NOTIFICATION_APPLICATION_FOCUS_OUT)
		_dispatched.clear()
		_check("%s focus-out: Godot released the key" % via, not Input.is_physical_key_pressed(KEY_W))
		if via == "window":
			root.focus_entered.emit()
		else:
			notification(NOTIFICATION_APPLICATION_FOCUS_IN)
		Input.flush_buffered_events()
		_check("%s focus-in reasserts the held key" % via, _dispatched == PRESSED)
		_check("%s focus-in: key pressed again" % via, Input.is_physical_key_pressed(KEY_W))

	_godot_release()
	root.focus_exited.emit()
	_dispatched.clear()
	_send(false)
	Input.flush_buffered_events()
	_check("a release after focus loss sends nothing", _dispatched.is_empty())
	_check("... and counts nothing", _host.injector.stats().is_empty())
	_send(true)
	Input.flush_buffered_events()
	_check("a fresh press after focus loss presses", _dispatched == PRESSED)


func _exit() -> void:
	_hello()
	_send(true)
	Input.flush_buffered_events()
	_check("pressed again before leaving the tree", Input.is_physical_key_pressed(KEY_W))
	root.remove_child(_host)
	Input.flush_buffered_events()
	_check("leaving the tree releases", not Input.is_physical_key_pressed(KEY_W))
	_host.free()


func _finish() -> void:
	if _failures == 0:
		print("%s ok %d checks" % [TAG, _checks])
	else:
		print("%s %d of %d checks failed" % [TAG, _failures, _checks])
	quit(1 if _failures > 0 else 0)
	_phase = 3


func _hello() -> void:
	_seq = 0
	var epoch: int = Time.get_ticks_usec() % 4000000000
	_host.injector.receive("c", JSON.stringify({"type": "hello", "format": "gsw-input/1", "source": "n", "epoch": epoch}))
	_epoch = epoch


func _send(pressed: bool) -> void:
	_seq += 1
	var record: Dictionary = {"event": "key", "physical_keycode": KEY_W, "pressed": pressed}
	var message: Dictionary = {"type": "events", "epoch": _epoch, "seq": _seq, "events": [record]}
	var code: String = _host.injector.receive("c", JSON.stringify(message))
	if code != "":
		_check("receive returned '%s'" % code, false)


## Stand-in for the display server's Input.release_pressed_events(): Input forgets the key.
func _godot_release() -> void:
	var event := InputEventKey.new()
	event.physical_keycode = KEY_W
	event.pressed = false
	Input.parse_input_event(event)
	Input.flush_buffered_events()


func _check(what: String, ok: bool) -> void:
	_checks += 1
	if not ok:
		_failures += 1
		print("%s FAIL: %s" % [TAG, what])
