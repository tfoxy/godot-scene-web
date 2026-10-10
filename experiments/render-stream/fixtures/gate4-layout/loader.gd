extends Node
## Gate 4 layout autoload (`GrcLoader`, see project.godot). A copy of `fixtures/spike/loader.gd`: see
## that file for the full rationale. In short, mod-mode loads the capture GDExtension *before the
## main scene draws anything* -- autoloads enter the tree ahead of `run/main_scene` (SceneTree
## brings up `[autoload]` nodes first), so `_enter_tree()` here always runs first. The extension is
## NOT declared in project.godot's own `[gd_extensions]` list -- the fixture loads it itself
## through `GDExtensionManager`, per the capture library's mod-mode contract (see
## experiments/render-stream capture library docs, owned by the sibling work).
##
## `GRC_EXTENSION` (absolute path to a `.gdextension` file) is optional: when unset, this prints a
## "skipped" status and the fixture runs completely unarmed, which is what gate 4's `reference`,
## `reference-repeat` and `import` legs exercise.

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
