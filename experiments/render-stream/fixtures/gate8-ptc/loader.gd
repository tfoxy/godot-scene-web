extends Node
## Gate 8 particle colour autoload (`GrcLoader`, see project.godot): loads the capture GDExtension
## in `_enter_tree`, before the main scene creates anything (gate 0's rule), so every emitter,
## process material, mesh, texture and item of ptc.tscn is created under the hooks.
## `GRC_EXTENSION` unset: nothing is loaded.


func _enter_tree() -> void:
	if not OS.has_environment("GRC_EXTENSION"):
		print("[fixture] extension load status=skipped (GRC_EXTENSION not set)")
		return
	var extension_path: String = OS.get_environment("GRC_EXTENSION")
	var status: GDExtensionManager.LoadStatus = GDExtensionManager.load_extension(extension_path)
	print("[fixture] extension load status=%d path=%s" % [status, extension_path])
