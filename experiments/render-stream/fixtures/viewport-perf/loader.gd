extends Node
## VS5 viewport-perf autoload (`GrcLoader`, see project.godot): a copy of fixtures/gate7-pace/loader.gd
## (whose ancestor, fixtures/spike/loader.gd, carries the full rationale). It loads the capture
## GDExtension in `_enter_tree()`, before the main scene creates anything, because autoloads enter
## the tree ahead of `run/main_scene`. The extension is never declared in project.godot.
##
## `GRC_EXTENSION` (absolute path to a `.gdextension` file) is optional: when unset, this prints a
## "skipped" status and the fixture runs unarmed (the `--import` and reference runs).

func _enter_tree() -> void:
	if not OS.has_environment("GRC_EXTENSION"):
		print("[fixture] extension load status=skipped (GRC_EXTENSION not set)")
		return

	var extension_path: String = OS.get_environment("GRC_EXTENSION")
	var status: GDExtensionManager.LoadStatus = GDExtensionManager.load_extension(extension_path)
	print("[fixture] extension load status=%s (%d) path=%s" % [_status_name(status), status, extension_path])


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
