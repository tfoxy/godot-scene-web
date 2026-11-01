extends Node
## Gate 8 multimesh autoload (`GrcLoader`, see project.godot): loads the capture GDExtension.
##
##   RS_FIXTURE_ARM=born   (default) in `_enter_tree`, before the main scene creates anything: every
##                         multimesh, mesh, texture, material and item of mm.tscn is created under
##                         the hooks (gate 0's rule; PM1's legs)
##   RS_FIXTURE_ARM=late   in `_process` at fixture frame K = RS_FIXTURE_ARM_FRAME (default 12),
##                         after every multimesh and draw exists: the capture adopts them
##                         (GRC_ADOPT=arm, PM9's late legs)
##
## An autoload processes ahead of the main scene, so at frame K the capture arms before the scene's
## own `_process` of that frame. `GRC_EXTENSION` unset: nothing is loaded (PM2's `reference` legs).

const ARM_FRAME_DEFAULT: int = 12

var _arm_mode: String = "born"
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
	if _arm_mode != "born" and _arm_mode != "late":
		printerr("[fixture] error: RS_FIXTURE_ARM must be born or late (got %s)" % JSON.stringify(_arm_mode))
		_arm_mode = "born"
	if _arm_mode == "born":
		_load("born")


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
