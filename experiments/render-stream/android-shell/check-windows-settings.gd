extends SceneTree
## Run headless with --main-pack build/windows/shell.pck to inspect exported settings.


func _initialize() -> void:
	var expected: Dictionary = {
		"rendering/renderer/rendering_method.windows": "forward_plus",
		"rendering/rendering_device/driver.windows": "vulkan",
		"display/window/size/mode.windows": Window.MODE_FULLSCREEN,
		# Windows overrides must leave Android's renderer and pacing intact.
		"rendering/renderer/rendering_method.mobile": "mobile",
		"display/window/frame_pacing/android/enable_frame_pacing": false,
	}
	for key: String in expected:
		if ProjectSettings.get_setting(key) != expected[key]:
			printerr("[windows-settings] %s: expected %s, got %s" % [key, expected[key], ProjectSettings.get_setting(key)])
			quit(1)
			return
	print("[windows-settings] 5/5 passed")
	quit(0)
