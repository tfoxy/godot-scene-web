class_name RsRustApplier
extends RefCounted
## The receiver's only core (gate7-design.md G7xn, D34, Q14e; G7gd): decode, validation, resolve
## and apply run in the shared Rust core (experiments/render-stream/rs-core) through the native
## GDExtension adapter `RsCore` (receiver/ext/: rs-core-capi plus a C++ shim over raw
## gdextension_interface.h; the web export loads the same adapter as a dlink side module). It was
## the default from G7xd; G7gd (2026-10-21, user decision, D34 amended) removed the GDScript
## decoder and applier it once stood in for.
##
## receiver.gd keeps configuration, I/O, evidence and shots, and calls accept_session() / accept()
## per record (a {record, errors, kind} Dictionary, with record.meta carrying what receiver.gd
## reads), needed(), apply_state(), begin_session(), dispose() and the counters below. The core
## resolves every transaction and keeps the stream; this object only marshals. Apply for changed
## items runs in native code as RenderingServer ptrcalls: the core reconciles the resolved state
## with its own mirror of what it sent (rs-core-capi/src/plan.rs), visiting only what the accepted
## transactions touched.
##
## Payloads: RsResourceCache keeps each payload's raw bytes, and apply_state() hands the ones
## needed() names to the core, which verifies their SHA-256 and decodes them before use; a
## `withheld` shader's library code is looked up here (RsResourceCache.library_code()) and handed
## over the same way. Since G7o3 (D31) the cache stages each payload in the core as it arrives
## (stage(): a fetch completion, an inline record, a cache or store read), so the core verifies
## and decodes it then, ahead of the frame, and the frame's provide() only moves it into the
## apply. A payload with nothing staged (the core was replaced, or it was used once already, or
## the verify-in-frame sabotage) is still verified inside the frame.

## The adapter's .gdextension (RS_RECEIVER_CORE_EXT overrides it). receiver/ext/ carries a
## .gdignore, so the editor never registers the extension for the default path.
const DEFAULT_EXTENSION: String = "res://ext/rs_core.gdextension"
const CLASS_NAME: String = "RsCore"

## The apply sabotages the core implements (RS_RECEIVER_SABOTAGE; rs-core-capi's plan.rs).
const CORE_SABOTAGES: Array[String] = [
	"reupload", "ignore-clip", "clip-before-clear", "drop-msdf", "ignore-set-transform",
	"ignore-clip-ignore", "ignore-nine-patch-axis", "drop-mesh-surface", "stale-mesh",
	"refuse-canvas-texture", "ignore-material", "ignore-canvas-modulate", "stale-param",
	"stale-texture", "ignore-canvas-stacking", "screen-copy-per-reader", "vertex-flat-varyings",
	"drop-canvas-group", "full-backbuffer-copy",
]

## The seq of the last accepted transaction.
var last_seq: int = 0
## Transactions accepted on the current stream.
var transactions: int = 0
## RenderingServer calls made by the core since this applier was made.
var rs_calls: int = 0
## RIDs the last dispose() freed.
var disposed_frees: int = 0
## RIDs the core created, and freed while applying, since this applier was made. Before a
## dispose(), created_rids - freed_by_apply is what the core owns.
var created_rids: int = 0
var freed_by_apply: int = 0
## One of CORE_SABOTAGES, or "" (set before begin_session()).
var sabotage: String = ""

var _viewport: RID
var _root_canvas: RID

var _core: Object = null
## needed()'s answer for the stream as it stands (receiver.gd asks before fetching and again at
## apply); dropped whenever a record is accepted or the applier changes residency.
var _need: Dictionary = {}
## G8kf: the variant hashes screen_variants() refused (their failed transcode rows are not errors).
var _refused: Dictionary = {}
var _counters: Dictionary = {}
var _counters_frame: int = -1
## G7o3: the last apply_state()'s split, in microseconds (receiver.gd's perf.json): the provide
## loop, the core's planner, the op stream's RenderingServer calls, and the stats Variant tree.
var last_provide_us: int = 0
var last_plan_us: int = 0
var last_execute_us: int = 0
var last_stats_us: int = 0


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
	_viewport = viewport
	_root_canvas = root_canvas
	var made: Variant = ClassDB.instantiate(CLASS_NAME)
	_core = made


## The first record of a stream (file mode: the recording's first record; live: the first
## message): a fresh core stream. A {record, errors, kind} Dictionary, record.meta parsed from
## the session's own meta JSON and record.blocks the session's float blocks. `version` is the stream's wire version (receiver.gd's _wire_version:
## 6, or 7 on a /7 live connection and its received.rs7 replay, G7xwl); the core validates the
## session, and every record after it, at that version.
func accept_session(data: PackedByteArray, offset: int, version: int) -> Dictionary:
	last_seq = 0
	transactions = 0
	_need = {}
	var out: Dictionary = _core.call("session", data, offset, version)
	var record: Dictionary = out["record"]
	if out["kind"] == "session":
		var text: String = record["meta_json"]
		var parsed: Variant = JSON.parse_string(text)
		record["meta"] = parsed
	return out


## G8kp (texture-delivery-design.md D3): the receiver's texture_encodings and gpu_formats; the core
## then fetches and uploads each ok image texture's chosen payload. "" when accepted, else why not.
func set_delivery(texture_encodings: String, gpu_formats: String) -> String:
	var refused: String = _core.call("set_delivery", texture_encodings, gpu_formats)
	return refused


## G8kwh: the web export's upload rules: WebGL's BC alignment rule in D3 (the core's
## bc_aligned_only), and a KTX2 transcode whose target family the receiver did not state (or BC at a
## size that is not 4-aligned) fails as a transcode does, so the entry falls back (Q3).
func set_webgl_rules(on: bool) -> void:
	_core.call("set_webgl_rules", on)


## G8ku (texture-delivery-design.md D6): `upgrade` (true) refetches when a preferred variant appears
## at an equal version; `keep` (false, the default) holds what is resident.
func set_variant_upgrade(on: bool) -> void:
	_core.call("set_variant_upgrade", on)


## G8ku (D16 `transcode-oracle`): whether each KTX2 transcode's uploaded blocks are hashed into the
## transcode log (off by default: it hashes every transcoded texture).
func set_transcode_log(hash_uploads: bool) -> void:
	_core.call("set_transcode_log", hash_uploads)


## G7o2 (D31): whether the next session defers the per-record digest (record.sha256 is "" in every
## answer until record_digest fills it, after the frame).
func set_digest_deferred(on: bool) -> void:
	_core.call("set_digest_deferred", on)


## G7o2 (D31): the record at `offset` of `data`'s sha256 hex, what an inline record.sha256 would
## have been ("" when there is no record there).
func record_digest(data: PackedByteArray, offset: int) -> String:
	var hex: String = _core.call("record_digest", data, offset)
	return hex


## One record after the session (accept_session()'s shape).
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


func begin_session() -> void:
	var opened: String = _core.call("open", _viewport, _root_canvas, sabotage if CORE_SABOTAGES.has(sabotage) else "")
	if opened != "":
		push_error(opened)
		return
	_core.call("begin_session")
	_refresh_counters()


## G8kf (texture-delivery-design.md Q3): transcodes ahead of the apply every uastc file the stream
## as it stands needs and this process holds (in memory; `load_from_directory` also reads the
## persisted cache's). A file Godot's KTX2 loader refuses is `delivery-transcode-failed`: the core
## refuses that variant, so D3 chooses the entry's next preference (`decoded` at last) and
## needed() names its payload. Returns one {hash} per variant refused (empty: nothing changed),
## after which the caller fetches what needed() now lists. Idempotent: a file already transcoded
## is not transcoded again, and the executor takes the image from here.
func screen_variants(cache: RsResourceCache, load_from_directory: bool = false) -> Array[Dictionary]:
	var out: Array[Dictionary] = []
	var need: Dictionary = needed()
	var listed: Array = need["ktx2_hashes"] if need.has("ktx2_hashes") else []
	for value: Variant in listed:
		var hash: String = value
		if not cache.has_in_memory(hash):
			if not load_from_directory or cache.ignore_cache or not cache.cache_has(hash, false, false, true):
				continue
			var got: Dictionary = cache.obtain(hash, false, false, true)
			var obtain_error: String = got["error"]
			if obtain_error != "":
				continue  # _obtain_needed reports it with the transaction's seq
		var ok: bool = _core.call("pretranscode", hash, cache.raw(hash))
		if ok:
			continue
		_core.call("refuse_variant", hash)
		_refused[hash] = true
		out.append({"hash": hash})
	if not out.is_empty():
		_need = {}
	return out


## What the stream as it stands needs: {hashes: Array (payload hashes), library: Array (withheld
## shaders' library hashes), ...} as rs-core-capi answers it.
func needed() -> Dictionary:
	if _need.is_empty():
		var need: Dictionary = _core.call("needed")
		_need = need
	return _need


## Hands the needed payloads (and library code) to the core, then applies. On a payload the core
## refuses, returns {"error": "<code>: <detail>"} (receiver.gd fails the replay with it).
func apply_state(cache: RsResourceCache) -> Dictionary:
	var provide_t0: int = Time.get_ticks_usec()
	var need: Dictionary = needed()
	_need = {}
	var hashes: Array = need["hashes"]
	for value: Variant in hashes:
		var hash: String = value
		if not cache.has_in_memory(hash):
			return {"error": RsWire.err("resource-unavailable", "payload %s is needed and not in memory" % hash)}
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
	last_provide_us = Time.get_ticks_usec() - provide_t0
	var result: Variant = _core.call("apply")
	var timing: int = _core.call("apply_timing")
	last_plan_us = timing & 0x1FFFFF
	last_execute_us = (timing >> 21) & 0x1FFFFF
	last_stats_us = (timing >> 42) & 0x1FFFFF
	if result is String:
		var error: String = result
		return {"error": error}
	var stats: Dictionary = result
	# G8ku: the KTX2 transcodes this apply ran (Image.load_ktx_from_buffer, D14). A failed one is
	# the typed `delivery-transcode-failed` (texture-delivery-design.md Q3).
	var transcodes_text: String = _core.call("take_transcodes")
	var transcodes: Variant = JSON.parse_string(transcodes_text)
	var transcode_rows: Array = transcodes if transcodes is Array else []
	for value: Variant in transcode_rows:
		var row: Dictionary = value
		var ok: bool = row["ok"]
		var row_hash: String = row["hash"]
		if not ok and not _refused.has(row_hash):
			return {"error": RsWire.err("delivery-transcode-failed", "Image.load_ktx_from_buffer refused KTX2 %s (error %s, %sx%s)" % [row["hash"], row["error"], row["width"], row["height"]])}
	stats["transcodes"] = transcode_rows
	# receiver.gd's _note_applied() reads a typed Array[Dictionary] here; the adapter's Arrays are
	# untyped.
	var listed: Array = stats["unsupported_commands"]
	var unsupported_commands: Array[Dictionary] = []
	unsupported_commands.assign(listed)
	stats["unsupported_commands"] = unsupported_commands
	# G7b's web-only index-region refusals: the GDScript applier's (G7gd removed it); the core's
	# executor never refuses one, so always empty.
	var mesh_web_refused: Array[Dictionary] = []
	stats["mesh_web_refused"] = mesh_web_refused
	rs_calls += RsWire.as_int(stats["rs_calls"])
	_counters_frame = -1
	return stats


## G7o3 (D31): a payload as it arrives (RsResourceCache's stager): the core verifies its SHA-256
## against `hash` and decodes it now, and holds it for the apply that first uses it. Returns "" or
## the refusal, "<code>: <detail>" (resource-hash-mismatch, resource-invalid).
func stage(hash: String, payload: PackedByteArray) -> String:
	var staged: String = _core.call("stage", hash, payload)
	return staged


## G7o3: the cache evicted `hash` from memory; the core drops its staged copy, if any.
func unstage(hash: String) -> void:
	_core.call("unstage", hash)


## G7o3: where the core verified payloads, since it was made: {staged, refused, unstaged,
## provided_staged, provided_in_frame, provided_in_frame_bytes, staged_now}.
func payload_counters() -> Dictionary:
	_refresh_counters()
	var out: Dictionary = {}
	for key: String in ["staged", "refused", "unstaged", "provided_staged", "provided_in_frame", "provided_in_frame_bytes", "staged_now"]:
		out[key] = RsWire.as_int(_counters["payloads_" + key])
	return out


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
	rs_calls = RsWire.as_int(_counters["rs_calls"])
	created_rids = RsWire.as_int(_counters["created_rids"])
	freed_by_apply = RsWire.as_int(_counters["freed_by_apply"])


func _counter(key: String) -> int:
	if _counters_frame != Engine.get_process_frames():
		_refresh_counters()
	return RsWire.as_int(_counters[key])


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
