class_name GswInputPointerFilter
extends Node
## The optional physical-pointer filter (docs/input.md "Many instances on one machine"): on a
## windowed instance driven by GswInputInjector, the local physical mouse, touchscreen and
## trackpad gestures (device 0) would interleave with the remote pointer. Injected mouse and touch
## events carry a virtual device id, so this drops device-0 pointer events and lets everything
## else through. `DEVICE_ID_EMULATION` (-1) events always pass: they are Godot's mouse from an
## (injected) touch.
##
##   GswInputInjector.install_event_filter(get_tree().root)
##
## How it blocks: `Viewport.push_input` calls `_input` before GUI and `_unhandled_input`
## (scene/main/viewport.cpp:3447-3458), and `_input` runs in reverse tree order
## (SceneTree._call_input_pause, scene/main/scene_tree.cpp:1433). The filter is an
## INTERNAL_MODE_BACK child of the root, so it stays the last node in tree order (scenes added
## later are external children and come before it) and sees each event first; it marks a dropped
## event handled, so no `_input`, `gui_input` or `_unhandled_input` receives it.
##
## Limits: it cannot undo what Godot does before `_input`. `Input` has already applied the event
## (mouse position, `get_mouse_button_mask()`, actions bound to mouse buttons), and the root
## viewport has already updated its hovered Control from it (viewport.cpp:3431-3436).

## Godot's device id for the local physical mouse and touchscreen.
const PHYSICAL_DEVICE: int = 0

## Events dropped so far.
var dropped: int = 0


func _init() -> void:
	name = "GswInputPointerFilter"
	process_mode = Node.PROCESS_MODE_ALWAYS


## Add a filter as the last internal child of `root` (normally `get_tree().root`).
static func install(root: Node) -> GswInputPointerFilter:
	var filter := GswInputPointerFilter.new()
	root.add_child(filter, false, Node.INTERNAL_MODE_BACK)
	return filter


## True for the events the filter drops.
static func is_physical_pointer(event: InputEvent) -> bool:
	if event.device != PHYSICAL_DEVICE:
		return false
	return event is InputEventMouse or event is InputEventScreenTouch or event is InputEventScreenDrag \
		or event is InputEventGesture


func _input(event: InputEvent) -> void:
	if is_physical_pointer(event):
		dropped += 1
		get_viewport().set_input_as_handled()
