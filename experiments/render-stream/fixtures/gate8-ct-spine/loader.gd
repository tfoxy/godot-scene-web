extends Node
## Gate 8 late-arm spine CanvasTexture autoload (`GrcLoader`, see project.godot): loads the capture
## GDExtension in `_process` at fixture frame K = RS_FIXTURE_ARM_FRAME (default 8), BEFORE the main
## scene builds the runtime CanvasTexture at frame 10, so the canvas_texture_* hooks are installed
## when the CanvasTexture's channels are set. The capture's arm is then deferred (GRC_ARM_DEFER_FRAMES,
## read by the capture at load) to a later frame, so the CanvasTexture is pre-arm and adopted from the
## hooks' registry (LATE-SPINE), not from a node's `texture` (there is none). `GRC_EXTENSION` unset:
## nothing is loaded (the `reference` leg).

const ARM_FRAME_DEFAULT: int = 8

var _arm_frame: int = ARM_FRAME_DEFAULT
var _frame: int = 0
var _armed: bool = false


func _enter_tree() -> void:
	if OS.has_environment("RS_FIXTURE_ARM_FRAME"):
		var text: String = OS.get_environment("RS_FIXTURE_ARM_FRAME").strip_edges()
		if text.is_valid_int() and text.to_int() >= 4 and text.to_int() < 20:
			_arm_frame = text.to_int()
		else:
			printerr("[fixture] error: RS_FIXTURE_ARM_FRAME must be an integer in 4..19 (got %s)" % JSON.stringify(text))


func _process(_delta: float) -> void:
	_frame += 1
	if _frame == _arm_frame:
		_load("early frame=%d" % _frame)


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
