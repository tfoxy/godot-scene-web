extends Node
## Gate 2 autoload (`GrcLoader`, see project.godot). A copy of `fixtures/gate1/loader.gd` (see
## `fixtures/spike/loader.gd` for the full rationale): autoloads enter the tree ahead of
## `run/main_scene`, so `_enter_tree()` here runs first and loads the capture GDExtension through
## `GDExtensionManager` before the main scene creates anything.
##
## One addition (gate2-design.md Q6 "Textures"): under `RS_FIXTURE_VARIANT=unsupported` it makes
## the texture `PRE` (RGBA8 4x4) BEFORE loading the extension, so its `texture_2d_create` is never
## hooked and every later draw of it names a RID the capture never saw created
## (`unknown-texture`). The main scene reads it back through `pre_texture`.
##
## `GRC_EXTENSION` (absolute path to a `.gdextension` file) is optional: when unset, this prints a
## "skipped" status and the fixture runs completely unarmed, which is what gate 2's `reference`,
## `reference-repeat` and `import` legs exercise.

const PRE_RGBA8: Array[int] = [204, 51, 204, 255]

var pre_texture: ImageTexture


func _enter_tree() -> void:
	if OS.get_environment("RS_FIXTURE_VARIANT") == "unsupported":
		var data := PackedByteArray()
		for i: int in 16:
			for c: int in PRE_RGBA8:
				data.append(c)
		pre_texture = ImageTexture.create_from_image(Image.create_from_data(4, 4, false, Image.FORMAT_RGBA8, data))
		print("[fixture] PRE created before the extension loads (variant unsupported)")

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
