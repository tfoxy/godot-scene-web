extends Node
## Load before the driver: runtime-loaded singleton names are resolved through Engine.

func _enter_tree() -> void:
	if not OS.has_environment("GRC_EXTENSION"):
		return
	var extension_path: String = OS.get_environment("GRC_EXTENSION")
	var status: GDExtensionManager.LoadStatus = GDExtensionManager.load_extension(extension_path)
	print("[fixture] extension load status=%d path=%s" % [status, extension_path])
