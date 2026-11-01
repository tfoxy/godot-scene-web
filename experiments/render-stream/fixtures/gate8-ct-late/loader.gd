extends Node
## Gate 8 late-arm CanvasTexture autoload (`GrcLoader`, see project.godot): loads the capture
## GDExtension in `_process` at fixture frame K = RS_FIXTURE_ARM_FRAME (default 12), after the main
## scene's `_ready` built every runtime CanvasTexture and item (RS_FIXTURE_ARM=late). The capture
## adopts them from the node map under GRC_ADOPT=arm (RT-CTX). `GRC_EXTENSION` unset: nothing is
## loaded (no `reference` leg here -- the check is capture-only).

const ARM_FRAME_DEFAULT: int = 12

var _arm_frame: int = ARM_FRAME_DEFAULT
var _frame: int = 0
var _armed: bool = false


func _enter_tree() -> void:
	if OS.has_environment("RS_FIXTURE_ARM_FRAME"):
		var text: String = OS.get_environment("RS_FIXTURE_ARM_FRAME").strip_edges()
		if text.is_valid_int() and text.to_int() >= 8 and text.to_int() < 20:
			_arm_frame = text.to_int()
		else:
			printerr("[fixture] error: RS_FIXTURE_ARM_FRAME must be an integer in 8..19 (got %s)" % JSON.stringify(text))


func _process(_delta: float) -> void:
	_frame += 1
	if _frame == _arm_frame:
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
