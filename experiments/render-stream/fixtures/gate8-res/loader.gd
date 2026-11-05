extends Node
## Gate 8 pre-arm resources autoload (`GrcLoader`, see project.godot): loads the capture
## GDExtension
##
##   RS_FIXTURE_ARM=late      (default) in `_process` at fixture frame K = RS_FIXTURE_ARM_FRAME
##                            (default 12), after the main scene's `_ready` built every pre-arm
##                            resource. The capture adopts the texture and items at their first
##                            post-arm draw (LATE-RES); the pre-arm emitter is refused
##                            `preload-particles` (LAR5)
##   RS_FIXTURE_ARM=deferred  in `_enter_tree`, before the main scene creates anything, so every
##                            create is registered; the runner defers the arm to fixture frame K
##                            with GRC_ARM_DEFER_FRAMES=K-1 and the emitter and its process
##                            materials are adopted from the registry (LAR5)
##
## `GRC_EXTENSION` unset: nothing is loaded (no `reference` leg here -- the check is capture-only).

const ARM_FRAME_DEFAULT: int = 12

var _arm_mode: String = "late"
var _arm_frame: int = ARM_FRAME_DEFAULT
var _frame: int = 0
var _armed: bool = false


func _enter_tree() -> void:
	if OS.has_environment("RS_FIXTURE_ARM"):
		_arm_mode = OS.get_environment("RS_FIXTURE_ARM")
	if OS.has_environment("RS_FIXTURE_ARM_FRAME"):
		var text: String = OS.get_environment("RS_FIXTURE_ARM_FRAME").strip_edges()
		if text.is_valid_int() and text.to_int() >= 8 and text.to_int() < 20:
			_arm_frame = text.to_int()
		else:
			printerr("[fixture] error: RS_FIXTURE_ARM_FRAME must be an integer in 8..19 (got %s)" % JSON.stringify(text))
	if _arm_mode != "late" and _arm_mode != "deferred":
		printerr("[fixture] error: RS_FIXTURE_ARM must be late or deferred (got %s)" % JSON.stringify(_arm_mode))
		_arm_mode = "late"
	if _arm_mode == "deferred":
		_load(_arm_mode)


func _process(_delta: float) -> void:
	_frame += 1
	if _arm_mode == "late" and _frame == _arm_frame:
		_load("late frame=%d" % _frame)


func _load(when: String) -> void:
	if _armed:
		return
	_armed = true
	if not OS.has_environment("GRC_EXTENSION"):
		print("[fixture] extension load status=skipped (GRC_EXTENSION not set) arm=%s" % when)
		return
	var extension_path: String = OS.get_environment("GRC_EXTENSION")
	var status: GDExtensionManager.LoadStatus = GDExtensionManager.load_extension(extension_path)
	print("[fixture] extension load status=%d arm=%s path=%s" % [status, when, extension_path])
