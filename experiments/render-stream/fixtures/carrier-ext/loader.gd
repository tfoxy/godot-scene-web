extends Node
## Carrier fixture autoload (`GrcLoader`), a copy of `fixtures/gate8-tex/loader.gd`: loads the
## capture GDExtension through `GDExtensionManager` from `GRC_EXTENSION` in `_enter_tree()`, ahead
## of the next autoload (`CarrierPeer`, which needs the RenderStreamCarrier class it registers).
## The leg sets GRC_ARM_DEFER_FRAMES, so the capture arms -- and live starts -- in a later frame
## callback, after `CarrierPeer` registered its carrier.

func _enter_tree() -> void:
	if not OS.has_environment("GRC_EXTENSION"):
		print("[fixture] extension load status=skipped (GRC_EXTENSION not set)")
		return
	var extension_path: String = OS.get_environment("GRC_EXTENSION")
	var status: GDExtensionManager.LoadStatus = GDExtensionManager.load_extension(extension_path)
	print("[fixture] extension load status=%d path=%s" % [status, extension_path])
