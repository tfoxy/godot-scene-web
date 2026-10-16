class_name RsRustApplier
extends RsApplier
## RS_RECEIVER_CORE=rust (gate7-design.md G7xn, D34, Q14e): the receiver's decode, validation,
## resolve and apply run in the shared Rust core (experiments/render-stream/rs-core) through the
## native GDExtension adapter `RsCore` (receiver/ext/: rs-core-capi plus a C++ shim over raw
## gdextension_interface.h). The default stays RS_RECEIVER_CORE=gdscript, Rs2Decoder and
## RsApplier, which keep the native receiver an independent triangulation for both browser
## receivers (D8, D34).
##
## This class stands in for RsApplier and for Rs2Decoder.Stream at once: receiver.gd keeps its
## configuration, I/O, evidence and shots, and calls
##   accept_session() / accept() instead of RsApplier.accept_record() (the same {record, errors,
##     kind} Dictionary, with record.meta carrying what receiver.gd reads),
##   needed(), apply_state(), begin_session(), dispose() and the counters as on RsApplier.
## The core resolves every transaction and keeps the stream; this object only marshals. Apply for
## changed items runs in native code as RenderingServer ptrcalls: the core reconciles the resolved
## state with its own mirror of what it sent (rs-core-capi/src/plan.rs, rs_applier.gd's rules
## and order), visiting only what the accepted transactions touched.
##
## Payloads: RsResourceCache keeps each payload's raw bytes in rust mode (`keep_raw`), and
## apply_state() hands the ones needed() names to the core, which verifies their SHA-256 and
## decodes them before use; a `withheld` shader's library code is looked up here
## (RsResourceCache.library_code()) and handed over the same way.

## The adapter's .gdextension (RS_RECEIVER_CORE_EXT overrides it). receiver/ext/ carries a
## .gdignore, so the editor never registers the extension for the default path.
const DEFAULT_EXTENSION: String = "res://ext/rs_core.gdextension"
const CLASS_NAME: String = "RsCore"

## The seq of the last accepted transaction (Rs2Decoder.Stream.last_seq).
var last_seq: int = 0
## Transactions accepted on the current stream (Rs2Decoder.Stream.transactions).
var transactions: int = 0

var _core: Object = null
## needed()'s answer for the stream as it stands (receiver.gd asks before fetching and again at
## apply); dropped whenever a record is accepted or the applier changes residency.
var _need: Dictionary = {}
var _counters: Dictionary = {}
var _counters_frame: int = -1


## Loads the adapter once per process. Returns "" or why it is unavailable.
static func load_core(path: String) -> String:
	if ClassDB.class_exists(CLASS_NAME):
		return ""
	if not FileAccess.file_exists(path):
		return "%s does not exist (build it with experiments/render-stream/scripts/build-rs-core-ext.sh)" % path
	var status: GDExtensionManager.LoadStatus = GDExtensionManager.load_extension(path)
	if status != GDExtensionManager.LOAD_STATUS_OK and status != GDExtensionManager.LOAD_STATUS_ALREADY_LOADED:
		return "GDExtensionManager.load_extension(%s) returned %d" % [path, status]
	if not ClassDB.class_exists(CLASS_NAME):
		return "%s loaded but registered no %s class" % [path, CLASS_NAME]
	return ""


func _init(viewport: RID, root_canvas: RID) -> void:
	super(viewport, root_canvas)
	var made: Variant = ClassDB.instantiate(CLASS_NAME)
	_core = made


## The first record of a stream (file mode: the recording's first record; live: the first
## message): a fresh core stream. RsApplier.accept_record()'s shape, record.meta parsed from the
## session's own meta JSON (as Rs2Decoder.decode_record() parses it) and record.blocks the
## session's float blocks.
func accept_session(data: PackedByteArray, offset: int) -> Dictionary:
	last_seq = 0
	transactions = 0
	_need = {}
	var out: Dictionary = _core.call("session", data, offset)
	var record: Dictionary = out["record"]
	if out["kind"] == "session":
		var text: String = record["meta_json"]
		var parsed: Variant = JSON.parse_string(text)
		record["meta"] = parsed
	return out


## One record after the session (RsApplier.accept_record()'s shape).
func accept(data: PackedByteArray, offset: int) -> Dictionary:
	var out: Dictionary = _core.call("accept", data, offset)
	if out["kind"] == "transaction":
		var record: Dictionary = out["record"]
		var meta: Dictionary = record["meta"]
		var seq: int = meta["seq"]
		last_seq = seq
		transactions += 1
		_need = {}
	return out


## The last resource record's verified inline payload.
func resource_payload() -> PackedByteArray:
	var bytes: PackedByteArray = _core.call("resource_payload")
	return bytes


## The resolved state as a state dump's JSON text (render-stream-2.md's resolved `state`).
func state_json() -> String:
	var text: String = _core.call("state_json")
	return text


func _sabotage_name() -> String:
	var flags: Dictionary[String, bool] = {
		"reupload": sabotage_reupload, "ignore-clip": sabotage_ignore_clip,
		"clip-before-clear": sabotage_clip_before_clear, "drop-msdf": sabotage_drop_msdf,
		"ignore-set-transform": sabotage_ignore_set_transform,
		"ignore-clip-ignore": sabotage_ignore_clip_ignore,
		"ignore-nine-patch-axis": sabotage_ignore_nine_patch_axis,
		"drop-mesh-surface": sabotage_drop_mesh_surface, "stale-mesh": sabotage_stale_mesh,
		"refuse-canvas-texture": sabotage_refuse_canvas_texture,
		"ignore-material": sabotage_ignore_material,
		"ignore-canvas-modulate": sabotage_ignore_canvas_modulate,
		"stale-param": sabotage_stale_param, "stale-texture": sabotage_stale_texture,
		"ignore-canvas-stacking": sabotage_ignore_canvas_stacking,
	}
	for name: String in flags:
		if flags[name]:
			return name
	return ""


func begin_session(_meta: Dictionary, _blocks: Array) -> void:
	var opened: String = _core.call("open", _viewport, _root_canvas, _sabotage_name())
	if opened != "":
		push_error(opened)
		return
	_core.call("begin_session")
	_refresh_counters()


func needed(_items: Dictionary, _textures: Dictionary, _meshes: Dictionary = {}, _shaders: Dictionary = {}, _materials: Dictionary = {}) -> Dictionary:
	if _need.is_empty():
		var need: Dictionary = _core.call("needed")
		_need = need
	return _need


## Hands the needed payloads (and library code) to the core, then applies. On a payload the core
## refuses, returns {"error": "<code>: <detail>"} (receiver.gd fails the replay with it).
func apply_state(_stream: Rs2Decoder.Stream, cache: RsResourceCache) -> Dictionary:
	var need: Dictionary = needed({}, {})
	_need = {}
	var hashes: Array = need["hashes"]
	for value: Variant in hashes:
		var hash: String = value
		if not cache.has_in_memory(hash):
			return {"error": Rs2Decoder.err("resource-unavailable", "payload %s is needed and not in memory" % hash)}
		var provided: String = _core.call("provide", hash, cache.raw(hash))
		if provided != "":
			return {"error": provided}
	var library: Array = need["library"]
	for value: Variant in library:
		var library_hash: String = value
		var got: Dictionary = cache.library_code(library_hash)
		var ok: bool = got["ok"]
		var body: String = got["code"] if ok else got["detail"]
		_core.call("provide_library", library_hash, ok, body)
	var result: Variant = _core.call("apply")
	if result is String:
		var error: String = result
		return {"error": error}
	var stats: Dictionary = result
	# RsApplier's stats carry a typed Array[Dictionary] here (receiver.gd's _note_applied() reads
	# it as one); the adapter's Arrays are untyped.
	var listed: Array = stats["unsupported_commands"]
	var unsupported_commands: Array[Dictionary] = []
	unsupported_commands.assign(listed)
	stats["unsupported_commands"] = unsupported_commands
	# G7b's web-only index-region refusals (rs_applier.gd "Meshes"): always empty natively, and the
	# core runs only natively until G7xw ports the refusal into plan.rs.
	var mesh_web_refused: Array[Dictionary] = []
	stats["mesh_web_refused"] = mesh_web_refused
	rs_calls += Rs2Decoder.as_int(stats["rs_calls"])
	_counters_frame = -1
	return stats


func dispose() -> int:
	_need = {}
	var freed: int = _core.call("dispose")
	_refresh_counters()
	disposed_frees = freed
	return freed


func _refresh_counters() -> void:
	var counters: Dictionary = _core.call("counters")
	_counters = counters
	_counters_frame = Engine.get_process_frames()
	rs_calls = Rs2Decoder.as_int(_counters["rs_calls"])
	created_rids = Rs2Decoder.as_int(_counters["created_rids"])
	freed_by_apply = Rs2Decoder.as_int(_counters["freed_by_apply"])


func _counter(key: String) -> int:
	if _counters_frame != Engine.get_process_frames():
		_refresh_counters()
	return Rs2Decoder.as_int(_counters[key])


func owned_rids() -> int:
	_refresh_counters()
	return _counter("owned_rids")


func resident_items() -> int:
	return _counter("items")


func resident_textures() -> int:
	return _counter("textures")


func resident_meshes() -> int:
	return _counter("meshes")


func resident_shaders() -> int:
	return _counter("shaders")


func resident_materials() -> int:
	return _counter("materials")


func root_canvas_xform() -> PackedFloat32Array:
	if _counters_frame != Engine.get_process_frames():
		_refresh_counters()
	var xform: PackedFloat32Array = _counters["root_canvas_xform"]
	return xform
