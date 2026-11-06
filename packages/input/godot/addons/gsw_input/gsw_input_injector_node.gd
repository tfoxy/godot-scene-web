class_name GswInputInjectorNode
extends Node
## Hosts a GswInputInjector in the scene tree (docs/input.md "Injector API"):
##   - ticks it every frame (`lease_ms` and `stale_timeout_ms`), paused tree included;
##   - on focus loss calls `on_focus_lost()`: a windowed instance that loses OS focus has had
##     `Input.release_pressed_events()` run by its display server, which drops injected keys,
##     buttons and axes without release events. With `reassert_on_focus_in` it calls
##     `reassert()` when focus comes back; otherwise held controls return with the sender's next
##     `sync` or press;
##   - releases everything when it leaves the tree, so no injected hold outlives it.
##
## Focus is the root window's `focus_exited`/`focus_entered` plus the application focus
## notifications. Both may fire for one loss, in either order relative to the release (Wayland
## notifies first, X11 releases first); `on_focus_lost` emits nothing and is idempotent, so the
## order does not matter. Not covered: Godot also releases on a Windows window drag
## (WM_ENTERSIZEMOVE) and a macOS window move with no focus notification; holds then come back
## with the next `sync`, or the product calls `injector.on_focus_lost()` itself.
## Headless instances never lose focus.
##
##   var host := GswInputInjectorNode.new()
##   host.injector.configure({"lease_ms": 10000})
##   add_child(host)
##   host.injector.receive(peer_id, text)

var injector: GswInputInjector = GswInputInjector.new()


func _init() -> void:
	process_mode = Node.PROCESS_MODE_ALWAYS


func _enter_tree() -> void:
	var root: Window = get_tree().root
	if not root.focus_exited.is_connected(_on_focus_out):
		root.focus_exited.connect(_on_focus_out)
		root.focus_entered.connect(_on_focus_in)


func _exit_tree() -> void:
	var root: Window = get_tree().root
	if root.focus_exited.is_connected(_on_focus_out):
		root.focus_exited.disconnect(_on_focus_out)
		root.focus_entered.disconnect(_on_focus_in)
	injector.release_all()


func _process(_delta: float) -> void:
	injector.tick(Time.get_ticks_msec())


func _notification(what: int) -> void:
	match what:
		NOTIFICATION_APPLICATION_FOCUS_OUT:
			_on_focus_out()
		NOTIFICATION_APPLICATION_FOCUS_IN:
			_on_focus_in()


func _on_focus_out() -> void:
	injector.on_focus_lost()


func _on_focus_in() -> void:
	if injector.reassert_on_focus_in:
		injector.reassert()
