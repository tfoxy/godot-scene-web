extends SceneTree
## The texture prepare step's headless script (texture-delivery-design.md D9b, G8kc), run by
## scripts/prepare-textures.sh on the pinned stock 4.5.1 release template with the capture armed
## (GRC_EXTENSION), GRC_TEXTURE_CACHE_DIR set and a throwaway stream sink.
##
## It loads every file of RS_PREPARE_LIST (one absolute path per line) exactly as a game would:
## a `.ctex` through ResourceLoader (so the engine's own CompressedTexture2D loader creates the
## texture), a `.res` as an Image resource (any format and mip chain; G8kf's fixture dumps) turned
## into an ImageTexture, any other file as an Image turned into an ImageTexture. The capture's texture hooks
## then see the same texture_2d_create the game would make, compute the same D7 source key and
## fill the cache through the same code as a live session. One texture per frame, released at the
## next frame, so a large pack never holds more than one texture beside the mirror.
##
## Environment: RS_PREPARE_LIST (absolute path of the list), RS_PREPARE_LOG (optional: one JSONL
## line per file), GRC_EXTENSION (absolute path of the .gdextension).

var _items: Array[String] = []
var _next: int = 0
var _held: Variant = null
var _log: FileAccess
var _failed: int = 0


func _initialize() -> void:
	var extension_path: String = OS.get_environment("GRC_EXTENSION")
	if extension_path != "":
		var status: GDExtensionManager.LoadStatus = GDExtensionManager.load_extension(extension_path)
		print("[prepare] extension load status=%d path=%s" % [status, extension_path])
	var list_path: String = OS.get_environment("RS_PREPARE_LIST")
	var list := FileAccess.open(list_path, FileAccess.READ)
	if list == null:
		push_error("prepare: cannot read RS_PREPARE_LIST=%s" % list_path)
		quit(2)
		return
	while not list.eof_reached():
		var line: String = list.get_line().strip_edges()
		if line != "":
			_items.append(line)
	var log_path: String = OS.get_environment("RS_PREPARE_LOG")
	if log_path != "":
		_log = FileAccess.open(log_path, FileAccess.WRITE)


func _process(_delta: float) -> bool:
	_held = null  # the previous texture is released here, before the next one is made
	if _next >= _items.size():
		print("[prepare] done files=%d failed=%d" % [_items.size(), _failed])
		# A file this build cannot load (an EXR, a corrupt ctex) is reported, not fatal: the rest
		# are prepared. Only a run that loaded nothing fails.
		quit(1 if _failed >= _items.size() else 0)
		return true
	var path: String = _items[_next]
	_next += 1
	var resource: Variant = null
	var kind: String = "ctex"
	if path.get_extension() == "ctex":
		resource = ResourceLoader.load(path, "", ResourceLoader.CACHE_MODE_IGNORE)
	elif path.get_extension() == "res":
		kind = "image-res"
		var loaded: Variant = ResourceLoader.load(path, "", ResourceLoader.CACHE_MODE_IGNORE)
		if loaded is Image and not (loaded as Image).is_empty():
			resource = ImageTexture.create_from_image(loaded as Image)
	else:
		kind = "image"
		var image := Image.load_from_file(path)
		if image != null and not image.is_empty():
			resource = ImageTexture.create_from_image(image)
	var ok: bool = resource != null
	if not ok:
		_failed += 1
		push_error("prepare: cannot load %s" % path)
	if _log != null:
		_log.store_line(JSON.stringify({"path": path, "kind": kind, "loaded": ok}))
		_log.flush()
	_held = resource
	return false
