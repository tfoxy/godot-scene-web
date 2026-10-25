extends Node
## Gate 8 adoption autoload (`GrcLoader`, see project.godot). Gate 1's loader (`fixtures/gate1/loader.gd`)
## plus a late arm: it loads the capture GDExtension through `GDExtensionManager.load_extension`
##
##   RS_FIXTURE_ARM=born        in `_enter_tree`, before the main scene creates anything (the
##                              `born` leg, main scene res://born.tscn: every object is created
##                              armed, gate 0's rule)
##   RS_FIXTURE_ARM=late        (default) in `_process` at fixture frame K = RS_FIXTURE_ARM_FRAME
##                              (default 12), after adopt.tscn has drawn, moved, raised top-level
##                              items, hidden a subtree and changed a filter (the `late` leg: the
##                              capture adopts the scene, GRC_ADOPT=arm)
##   RS_FIXTURE_ARM=thread      at frame K too, but from a worker Thread (the `late-thread` leg:
##                              adoption refuses `adopt-thread`, gate8-design.md D4)
##
## An autoload enters the tree, and processes, ahead of the main scene, so at frame K the capture
## arms before the scene's own `_process` of that frame. `GRC_EXTENSION` unset: nothing is loaded
## (the `reference` leg).

const ARM_FRAME_DEFAULT: int = 12

var arm_mode: String = "late"
var arm_frame: int = ARM_FRAME_DEFAULT
var _frame: int = 0
var _armed: bool = false
var _thread: Thread


func _enter_tree() -> void:
	if OS.has_environment("RS_FIXTURE_ARM"):
		arm_mode = OS.get_environment("RS_FIXTURE_ARM")
	if OS.has_environment("RS_FIXTURE_ARM_FRAME"):
		var text: String = OS.get_environment("RS_FIXTURE_ARM_FRAME").strip_edges()
		if text.is_valid_int() and text.to_int() >= 8:
			arm_frame = text.to_int()
		else:
			printerr("[fixture] error: RS_FIXTURE_ARM_FRAME must be an integer >= 8 (got %s)" % JSON.stringify(text))
	if arm_mode != "born" and arm_mode != "late" and arm_mode != "thread":
		printerr("[fixture] error: RS_FIXTURE_ARM must be born, late or thread (got %s)" % JSON.stringify(arm_mode))
		arm_mode = "late"
	if arm_mode == "born":
		_load("born")


func _process(_delta: float) -> void:
	_frame += 1
	if arm_mode == "late" and _frame == arm_frame:
		_load("late frame=%d" % _frame)
	elif arm_mode == "thread" and _frame == arm_frame:
		_thread = Thread.new()
		_thread.start(_load.bind("thread frame=%d" % _frame))
		_thread.wait_to_finish()


func _load(when: String) -> void:
	if _armed:
		return
	_armed = true
	if not OS.has_environment("GRC_EXTENSION"):
		print("[fixture] extension load status=skipped (GRC_EXTENSION not set) arm=%s" % when)
		return
	var extension_path: String = OS.get_environment("GRC_EXTENSION")
	var status: GDExtensionManager.LoadStatus = GDExtensionManager.load_extension(extension_path)
	print("[fixture] extension load status=%s (%d) arm=%s path=%s" % [_status_name(status), status, when, extension_path])


func _status_name(status: GDExtensionManager.LoadStatus) -> String:
	match status:
		GDExtensionManager.LOAD_STATUS_OK:
			return "OK"
		GDExtensionManager.LOAD_STATUS_FAILED:
			return "FAILED"
		GDExtensionManager.LOAD_STATUS_ALREADY_LOADED:
			return "ALREADY_LOADED"
		GDExtensionManager.LOAD_STATUS_NOT_LOADED:
			return "NOT_LOADED"
		GDExtensionManager.LOAD_STATUS_NEEDS_RESTART:
			return "NEEDS_RESTART"
		_:
			return "UNKNOWN"
