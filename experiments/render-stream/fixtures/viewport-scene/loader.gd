extends Node
## Gate 8 g8vp autoload (`GrcLoader`, see project.godot). Gate 1's loader plus a late arm through the
## capture's GDScript API, the way a consumer arms (fixtures/live-swap/swap_driver.gd):
##
##   RS_FIXTURE_ARM=born   loads GRC_EXTENSION in `_enter_tree`, before the main scene (res://born.tscn)
##                         creates anything; the runner sets GRC_MODE=arm, so every viewport, proxy,
##                         canvas and item is created armed
##   RS_FIXTURE_ARM=late   (the default) loads it in `_enter_tree` too, but the runner sets
##                         GRC_MODE=standby (GRC_ADOPT=arm implied): the scene is built under the
##                         standby hooks (the registry records), and at fixture frame
##                         K = RS_FIXTURE_ARM_FRAME (default 12, at least 8) this autoload calls
##                         RenderStreamCapture.arm({}); the capture arms at that frame's boundary
##                         and adopts what exists
##
## An autoload processes ahead of the main scene, so the arm call precedes the scene's own frame K.
## RS_FIXTURE_ARM_LOG (absolute path, optional): one JSON line for the arm call (frame, return code,
## state before and after) and one per capture signal (armed, arm_failed, stream_ended).
## GRC_EXTENSION unset: nothing is loaded and nothing armed (the unarmed runs).

const ARM_FRAME_DEFAULT: int = 12

var arm_mode: String = "late"
var arm_frame: int = ARM_FRAME_DEFAULT
var _frame: int = 0
var _api: Object = null
var _arm_called: bool = false
var _log_file: FileAccess


func _enter_tree() -> void:
	if OS.has_environment("RS_FIXTURE_ARM"):
		arm_mode = OS.get_environment("RS_FIXTURE_ARM")
	if arm_mode != "born" and arm_mode != "late":
		printerr("[fixture] error: RS_FIXTURE_ARM must be born or late (got %s)" % JSON.stringify(arm_mode))
		arm_mode = "late"
	if OS.has_environment("RS_FIXTURE_ARM_FRAME"):
		var text: String = OS.get_environment("RS_FIXTURE_ARM_FRAME").strip_edges()
		if text.is_valid_int() and text.to_int() >= 8:
			arm_frame = text.to_int()
		else:
			printerr("[fixture] error: RS_FIXTURE_ARM_FRAME must be an integer >= 8 (got %s)" % JSON.stringify(text))
	var log_path: String = OS.get_environment("RS_FIXTURE_ARM_LOG")
	if log_path != "":
		if not log_path.is_absolute_path():
			printerr("[fixture] error: RS_FIXTURE_ARM_LOG must be an absolute path (got %s)" % JSON.stringify(log_path))
		else:
			_log_file = FileAccess.open(log_path, FileAccess.WRITE)
	if not OS.has_environment("GRC_EXTENSION"):
		print("[fixture] extension load status=skipped (GRC_EXTENSION not set) arm=%s" % arm_mode)
		return
	var extension_path: String = OS.get_environment("GRC_EXTENSION")
	var status: GDExtensionManager.LoadStatus = GDExtensionManager.load_extension(extension_path)
	print("[fixture] extension load status=%d arm=%s path=%s" % [status, arm_mode, extension_path])
	if Engine.has_singleton("RenderStreamCapture"):
		_api = Engine.get_singleton("RenderStreamCapture")
		for event: String in ["armed", "arm_failed", "stream_ended"]:
			_api.connect(event, _on_signal.bind(event))


func _process(_delta: float) -> void:
	_frame += 1
	if arm_mode != "late" or _arm_called or _frame != arm_frame:
		return
	_arm_called = true
	if _api == null:
		if OS.has_environment("GRC_EXTENSION"):
			printerr("[fixture] error: RenderStreamCapture singleton missing at the arm frame")
		_log({"event": "arm-call", "frame": _frame, "code": -1, "state_before": "none", "state_after": "none"})
		return
	var before: Dictionary = _api.call("state")
	var code: int = _api.call("arm", {})
	var after: Dictionary = _api.call("state")
	print("[fixture] api arm frame=%d code=%d state %s -> %s" % [_frame, code, str(before.get("state")), str(after.get("state"))])
	_log({"event": "arm-call", "frame": _frame, "code": code, "state_before": str(before.get("state")),
		"state_after": str(after.get("state"))})


func _on_signal(_arg: Variant, event: String) -> void:
	print("[fixture] capture signal %s frame=%d" % [event, _frame])
	_log({"event": event, "frame": _frame})


func _log(line: Dictionary) -> void:
	if _log_file == null:
		return
	_log_file.store_line(JSON.stringify(line, "", false))
	_log_file.flush()
