extends "res://demo/receiver/receiver.gd"
## Replay is the receiver's unmodified file-mode code, copied by build-android-shell.sh.
## This subclass supplies defaults and keeps the final frame alive for the shell.


func _ready() -> void:
	# Preserve the receiver's environment / --rs-env overrides, including on Android.
	RsConfig._parse_args()
	var defaults: Dictionary = {
		"RS_RECEIVER_RECORDING": "res://demo/recording.rs8",
		"RS_RECEIVER_OUT": ProjectSettings.globalize_path("user://replay/applied.json"),
		"RS_RECEIVER_MODE": "file",
	}
	for name: String in defaults:
		if RsConfig.get_env(name) == "":
			RsConfig._args[name] = str(defaults[name])
	await super._ready()


func _quit(code: int) -> void:
	_finished = true
	set_process(false)
	if code != EXIT_OK:
		print("[pack-demo] replay failed code=%d" % code)
		get_tree().quit(code)
		return
	var core: Object = _applier.get("_core")
	if core == null or not core.is_class("RsCore"):
		push_error("pack did not instantiate RsCore")
		get_tree().quit(1)
		return
	print("[pack-demo] RsCore instantiated by pack")
	var state: String = _applier.state_json()
	var hash := HashingContext.new()
	hash.start(HashingContext.HASH_SHA256)
	hash.update(state.to_utf8_buffer())
	print("[pack-demo] digest=%s records=%d" % [hash.finish().hex_encode(), _records.size()])
	var args := OS.get_cmdline_user_args()
	for arg: String in args:
		if arg.begins_with("--pack-shot="):
			if DisplayServer.get_name() == "headless":
				push_error("pack screenshot needs a rendered runner")
				get_tree().quit(1)
				return
			await RenderingServer.frame_post_draw
			var path := arg.trim_prefix("--pack-shot=")
			DirAccess.make_dir_recursive_absolute(path.get_base_dir())
			# The viewport texture contains the fitted canvas, excluding window bars.
			if get_tree().root.get_texture().get_image().save_png(path) != OK:
				get_tree().quit(1)
				return
	if "--pack-quit" in args:
		get_tree().quit(0)


func _exit_tree() -> void:
	if _applier != null:
		_dispose_applier()
		_applier = null
