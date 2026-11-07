extends Node
## TRK6 observer autoload (`TrackInject`): a stock
## project with no script receiver and no gsw_input addon. The capture binds `input` itself
## (GRC_LIVE_TRACK_INPUT_INJECT=reference) and adds a node named `RsTrackInputInjector` under the
## root; this script finds it and only watches. It never touches the injector.
##
## It writes the same log as fixtures/track-input (RS_TRACK_INPUT_LOG, one JSON object per line,
## each with its process frame) so gate 8's track checks judge both: the node's signals `opened`,
## `received` (logged as `message`: the byte count and the injector's result code) and `closed`,
## and every change of the watched Input state (keys W, A, S and the left mouse button) plus the
## test Control's gui_input mouse buttons. It never logs a payload.
##
## The client steers it through files in RS_TRACK_INPUT_CONTROL: `unbind` frees the injector node
## (the receiver goes away: the no-receiver phase), `quit` ends the run. RS_FIXTURE_QUIT_FRAME is
## the backstop.
##
## The fixtures/track-inject-addon project is this same script beside a project copy of the
## gsw_input addon (global classes GswInput*): the embedded injector must load beside it.

const NODE_NAME: String = "RsTrackInputInjector"
const KIND: String = "input"
const FORMAT: String = "gsw-input/1"
const WATCHED_KEYS: Array[int] = [KEY_W, KEY_A, KEY_S]

var _node: Node = null
var _seen: bool = false  # the node was found (a freed Object compares equal to null)
var _log: FileAccess = null
var _control_dir: String = ""
var _quit_frame: int = 3600
var _frame: int = 0
var _keys: Dictionary = {}
var _mouse_left: bool = false
var _unbound: bool = false
var _unbound_frame: int = 0
var _unbound_logged: bool = false
var _target_connected: bool = false
var _node_wait: int = 0
var _received: int = 0


func _ready() -> void:
	process_mode = Node.PROCESS_MODE_ALWAYS
	var path: String = OS.get_environment("RS_TRACK_INPUT_LOG")
	if path != "":
		_log = FileAccess.open(path, FileAccess.WRITE)
	_control_dir = OS.get_environment("RS_TRACK_INPUT_CONTROL")
	var quit: String = OS.get_environment("RS_FIXTURE_QUIT_FRAME")
	if quit.is_valid_int():
		_quit_frame = quit.to_int()
	for key: int in WATCHED_KEYS:
		_keys[key] = false
	var shipped: bool = false
	for entry: Dictionary in ProjectSettings.get_global_class_list():
		if str(entry.get("class", "")) == "GswInputInjector":
			shipped = true
	# A project that ships the addon (fixtures/track-inject-addon) must still run ITS copy.
	var project_injector: bool = false
	if ResourceLoader.exists("res://addons/gsw_input/gsw_input_injector.gd"):
		var script: GDScript = load("res://addons/gsw_input/gsw_input_injector.gd") as GDScript
		var own: Object = script.new() if script != null else null
		project_injector = own != null and own.has_method("receive")
	_write({
		"ev": "contract",
		"exists": ClassDB.class_exists("RenderStreamTrack"),
		"mode": "builtin",
		"project_addon": shipped,
		"project_injector": project_injector,
		# HYG2: the effective GDScript warning settings, so a check can require the strict ones.
		"exclude_addons": ProjectSettings.get_setting("debug/gdscript/warnings/exclude_addons", true),
		"untyped_declaration_level": ProjectSettings.get_setting("debug/gdscript/warnings/untyped_declaration", 0),
		"unsafe_call_argument_level": ProjectSettings.get_setting("debug/gdscript/warnings/unsafe_call_argument", 0),
	})


## The injector node appeared: what it is, then a script bind of the same kind (refused: the
## built-in receiver holds it), then its signals.
func _found(node: Node) -> void:
	_node = node
	_seen = true
	var script: Script = node.get_script()
	var constants: Dictionary = script.get_script_constant_map()
	var injector: Object = node.get("injector")
	_write({
		"ev": "builtin",
		"name": str(node.name),
		"in_tree": node.is_inside_tree(),
		"parent": str(node.get_parent().get_path()),
		"sha256": str(constants.get("ADDON_SHA256", "")),
		"injector_class": injector.get_class() if injector != null else "",
		"waited_frames": _node_wait,
	})
	if ClassDB.class_exists("RenderStreamTrack"):
		var probe: Object = ClassDB.instantiate("RenderStreamTrack")
		var ok: bool = probe.call("bind", KIND, PackedStringArray([FORMAT]))
		var error: String = probe.call("last_error")
		_write({"ev": "bind_probe", "ok": ok, "error": error})
	node.connect("opened", _on_opened)
	node.connect("received", _on_received)
	node.connect("closed", _on_closed)


func _on_opened(source: int, info: Dictionary) -> void:
	_write({"ev": "opened", "source": source, "info": info})


func _on_received(source: int, bytes: int, result: String) -> void:
	_received += 1
	_write({"ev": "message", "source": source, "bytes": bytes, "result": result})


func _on_closed(source: int, code: int, reason: String) -> void:
	_write({"ev": "closed", "source": source, "code": code, "reason": reason})


func _process(_delta: float) -> void:
	_frame += 1
	if not _seen and not _unbound:
		var found: Node = get_tree().root.get_node_or_null(NODE_NAME)
		if found != null:
			_found(found)
		else:
			_node_wait += 1
	if not _target_connected:
		var scene: Node = get_tree().current_scene
		var target: Control = scene.get_node_or_null("Target") as Control if scene != null else null
		if target != null:
			target.gui_input.connect(_on_target_input)
			_target_connected = true
	for key: int in WATCHED_KEYS:
		var pressed: bool = Input.is_physical_key_pressed(key)
		if pressed != _keys[key]:
			_keys[key] = pressed
			_write({"ev": "key", "key": key, "pressed": pressed})
	var left: bool = Input.is_mouse_button_pressed(MOUSE_BUTTON_LEFT)
	if left != _mouse_left:
		_mouse_left = left
		_write({"ev": "mouse", "button": MOUSE_BUTTON_LEFT, "pressed": left})
	if _control_dir != "":
		if not _unbound and FileAccess.file_exists(_control_dir.path_join("unbind")):
			_unbound = true
			_unbound_frame = _frame
			if _seen and is_instance_valid(_node):
				_node.queue_free()
		if _unbound and not _unbound_logged and _frame > _unbound_frame:
			# One frame later: the capture's flush at the end of the frame the node was freed in has
			# seen the receiver gone, so a hello the client sends now meets an unbound kind.
			_unbound_logged = true
			var gone: bool = _seen and not is_instance_valid(_node)
			_write({"ev": "unbound", "status": "freed" if gone else ("alive" if _seen else "absent")})
		if FileAccess.file_exists(_control_dir.path_join("quit")):
			_finish("control")
			return
	if _frame >= _quit_frame:
		_finish("quit-frame")


func _on_target_input(event: InputEvent) -> void:
	var button: InputEventMouseButton = event as InputEventMouseButton
	if button == null:
		return
	_write({
		"ev": "gui",
		"button": button.button_index,
		"pressed": button.pressed,
		"position": [button.position.x, button.position.y],
		"global": [button.global_position.x, button.global_position.y],
	})


func _finish(why: String) -> void:
	_write({"ev": "end", "why": why, "found": _seen, "received": _received, "freed": _unbound_logged})
	set_process(false)
	get_tree().quit()


func _write(line: Dictionary) -> void:
	line["frame"] = Engine.get_process_frames()
	line["ms"] = Time.get_ticks_msec()
	print("[track-inject] %s" % JSON.stringify(line))
	if _log != null:
		_log.store_line(JSON.stringify(line))
		_log.flush()
