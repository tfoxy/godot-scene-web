class_name Rs2Decoder
extends RefCounted
## render-stream/2 decoder and validator (protocol/render-stream-2.md). render-stream/2 is
## render-stream/1 plus textures.
##
## Pure: a PackedByteArray in, records and "<code>: <detail>" strings out. It opens no file and
## makes no RenderingServer call. Framing, canonical-JSON rules and most error codes are
## unchanged from render-stream-0.md and render-stream-1.md; this file was written independently
## of the gate 1 decoder (Rs1Decoder), matching rs2_codec.cpp's independence from rs1_codec.cpp.
##
## `Stream` (below) holds the resolved state as each transaction is accepted, now including
## `textures` (a Dictionary[int, Dictionary] keyed by wire id, same shape as the wire's texture
## entry) alongside `canvases`/`items`. It also tracks resource records: which hashes have been
## carried so far in this stream, and the decoded shape of each (for resource-payload), so that
## resource-missing/resource-hash/resource-duplicate/resource-payload can be checked as the
## stream is walked.
##
## JSON.parse returns every number as a float. Every wire integer is below 2^53, so an integer is
## accepted only when it is finite, integral and within +-(2^53 - 1), then converted with int().

const MAGIC_HEX: String = "475253320d0a1a0a"
## render-stream-3.md (G4e1): the GRS3 magic, selected by `version == 3` on split_records()/
## validate_recording(). /3 is implemented IN THIS SAME FILE behind that parameter, rather than a
## forked Rs3Decoder, because it is only one new command and one new sabotage kind on top of /2
## (gate4-design.md G4e1: "Renaming files is not part of this contract").
const MAGIC_V3_HEX: String = "475253330d0a1a0a"
## render-stream-4.md (G5w): the GRS4 magic, selected by `version == 4`. /4 is implemented IN
## THIS SAME FILE behind that parameter too (render-stream-4.md, following gate4-design.md
## G4e1's precedent): eleven new commands, a mesh table and the cmd_i32 block.
const MAGIC_V4_HEX: String = "475253340d0a1a0a"
## render-stream-5.md (G55w): the GRS5 magic, selected by `version == 5`. /5 is implemented IN
## THIS SAME FILE too (gate5_5-design.md D1): a shader table, a material table, canvas modulate,
## item material/use_parent_material/instance_params and the param_f64 (f64) block.
const MAGIC_V5_HEX: String = "475253350d0a1a0a"
const PROTOCOL: String = "render-stream/2"
const PROTOCOL_V3: String = "render-stream/3"
const PROTOCOL_V4: String = "render-stream/4"
const PROTOCOL_V5: String = "render-stream/5"
const MAX_SAFE_INT: float = 9007199254740991.0
const U32_MAX: float = 4294967295.0
const ITEM_FLOATS: int = 18
const CANVAS_FLOATS: int = 6
## render-stream-5.md "Canvas": canvas_f32 grows 6 -> 10 floats per canvas (xform 6, modulate 4).
const CANVAS_FLOATS_V5: int = 10

const SESSION_KEYS: Array = [
	"type", "protocol", "session_id", "stream", "engine", "capture", "viewport", "resources",
	"features", "sabotage", "blocks",
]
## render-stream-5.md "Session": a new "materials" key, right after "resources".
const SESSION_KEYS_V5: Array = [
	"type", "protocol", "session_id", "stream", "engine", "capture", "viewport", "resources",
	"materials", "features", "sabotage", "blocks",
]
const STREAM_KEYS: Array = ["stream_id", "connection", "transport", "encoding"]
const TRANSPORTS: Array = ["file", "websocket"]
const ENCODINGS: Array = ["full", "patch"]
const ENGINE_KEYS: Array = [
	"version_string", "sha256", "display_server", "rendering_driver", "rendering_method",
]
const CAPTURE_KEYS: Array = ["calibrator_version", "hooks_planned", "hooks_omitted"]
const VIEWPORT_KEYS: Array = [
	"canvas_cull_mask", "root_canvas", "logical_size", "stretch", "stretch_applied_by",
	"root_size_policy", "host_size_status", "host_window_size",
]
const STRETCH_KEYS: Array = ["mode", "aspect", "scale_mode"]
const STRETCH_MODES: Array = ["disabled", "canvas_items", "viewport"]
const STRETCH_ASPECTS: Array = ["ignore", "keep", "keep_width", "keep_height", "expand"]
const SCALE_MODES: Array = ["fractional", "integer"]
const ROOT_SIZE_POLICIES: Array = ["observe", "enforce-min-size"]
const HOST_SIZE_STATUSES: Array = ["match", "degenerate-visible", "degenerate-window"]
const RESOURCES_KEYS: Array = [
	"hash", "payload", "delivery", "inline_max_bytes", "max_payload_bytes", "permitted_formats",
	"fetch", "http_path", "auth",
]
## render-stream-4.md "Resources": "payload" (a string) becomes "payloads" (a sorted array) at /4.
const RESOURCES_KEYS_V4: Array = [
	"hash", "payloads", "delivery", "inline_max_bytes", "max_payload_bytes", "permitted_formats",
	"fetch", "http_path", "auth",
]
const MESH_PAYLOAD_SCHEMA: String = "render-stream-mesh/1"
const SHADER_PAYLOAD_SCHEMA: String = "render-stream-shader/1"
const DELIVERIES: Array = ["out-of-band", "inline", "mixed"]
const FETCHES: Array = ["http", "directory", "none"]
const AUTHS: Array = ["none", "bearer"]
const FEATURES_KEYS: Array = [
	"ops", "item_state", "resources", "unsupported_resources", "observed_unsupported_ops",
	"unobserved", "publication",
]
## render-stream-5.md "Session": a new "canvas_state" key, right after "item_state".
const FEATURES_KEYS_V5: Array = [
	"ops", "item_state", "canvas_state", "resources", "unsupported_resources",
	"observed_unsupported_ops", "unobserved", "publication",
]
const MATERIALS_KEYS: Array = ["shader_policy"]
const SHADER_POLICIES: Array = ["source", "params", "exclude"]
## features.unsupported_resources entries (G2d): a resource kind the host refuses, and why.
const UNSUPPORTED_RESOURCE_KEYS: Array = ["resource", "reason"]
const UNSUPPORTED_RESOURCE_REASONS: Array = ["canvas-texture-headless"]
const PUBLICATION: String = "snapshot-or-patch"
const SABOTAGE_KEYS: Array = ["kind", "frame", "op"]
const SABOTAGE_KINDS: Array = [
	"freeze-frame", "omit-update", "perturb-transform", "omit-op", "patch-drop-item",
	"drop-message", "ignore-credit", "stale-coalesce", "stale-texture", "wrong-hash",
	"spurious-texture-update", "drop-resource", "unpin", "perturb-glyph", "perturb-vertex",
	"perturb-shader",
]
const TRANSACTION_KEYS: Array = [
	"type", "seq", "frame", "encoding", "base_seq", "status", "failures", "unsupported",
	"default_texture_filter", "default_texture_repeat", "removed_canvases", "removed_items",
	"removed_textures", "canvases", "items", "textures", "blocks",
]
## render-stream-4.md "Mesh table": removed_meshes after removed_textures, meshes after textures.
const TRANSACTION_KEYS_V4: Array = [
	"type", "seq", "frame", "encoding", "base_seq", "status", "failures", "unsupported",
	"default_texture_filter", "default_texture_repeat", "removed_canvases", "removed_items",
	"removed_textures", "removed_meshes", "canvases", "items", "textures", "meshes", "blocks",
]
## render-stream-5.md "Shader table"/"Material table": removed_shaders/removed_materials after
## removed_meshes, shaders/materials after meshes.
const TRANSACTION_KEYS_V5: Array = [
	"type", "seq", "frame", "encoding", "base_seq", "status", "failures", "unsupported",
	"default_texture_filter", "default_texture_repeat", "removed_canvases", "removed_items",
	"removed_textures", "removed_meshes", "removed_shaders", "removed_materials", "canvases",
	"items", "textures", "meshes", "shaders", "materials", "blocks",
]
const STATUSES: Array = ["ok", "capture-failure"]
## protocol/unknown-item-skip.md: a session that opted into skipping unknown canvas/item RIDs adds
## "unknown_item_policy": "skip" right after "sabotage", and then every transaction carries
## "unknown_items" right after "unsupported" -- at /4 and /5 only. Absent = strict.
const UNKNOWN_ITEM_POLICY_KEY: String = "unknown_item_policy"
const UNKNOWN_ITEMS_KEY: String = "unknown_items"
const UNKNOWN_ITEMS_KEYS: Array = ["unknown_rids", "withheld_items", "withheld_commands", "unknown_calls"]
const FAILURE_KEYS: Array = ["reason", "detail"]
const FAILURE_REASONS: Array = [
	"root-query-failed", "pre-existing-object", "mirror-capacity", "root-size-enforce-failed",
]
const UNSUPPORTED_KEYS: Array = ["op", "item", "reason"]
const SESSION_UNSUPPORTED_REASONS: Array = ["non-root-viewport", "extra-canvas", "degenerate-host-size"]
const ITEM_UNSUPPORTED_REASONS: Array = [
	"unsupported-op", "unsupported-state", "draw-index-tie", "unknown-texture", "unsupported-texture",
	"canvas-texture-headless", "unknown-mesh", "skinned-geometry", "unsupported-mesh",
]
## new at /5: the session-level ("item": null) canvas-light entry (gate5_5-design.md D10, D16).
const SESSION_UNSUPPORTED_REASONS_V5: Array = [
	"non-root-viewport", "extra-canvas", "degenerate-host-size", "canvas-light",
]
## render-stream-5.md "Decoders accept 'unsupported-state' for canvas_item_attach_skeleton only
## at /5": canvas_item_set_material's unsupported-state no longer occurs (superseded by item-
## level material state), so /5 decoders reject it -- checked explicitly in
## _check_resolved_invariants(), since this array alone cannot express that per-op restriction.
const ITEM_UNSUPPORTED_REASONS_V5: Array = [
	"unsupported-op", "unsupported-state", "draw-index-tie", "unknown-texture", "unsupported-texture",
	"canvas-texture-headless", "unknown-mesh", "skinned-geometry", "unsupported-mesh",
	"unsupported-material", "unknown-material", "param-type",
]
const CANVAS_KEYS: Array = ["id", "origin", "role", "attached", "items"]
const ORIGINS: Array = ["created", "root-query", "adopted"]
const ITEM_KEYS: Array = [
	"id", "origin", "parent", "children", "visible", "draw_index", "z_index", "z_relative",
	"behind", "clip", "custom_rect", "visibility_layer", "texture_filter", "texture_repeat",
	"content_version", "commands",
]
## render-stream-5.md "Item": material, use_parent_material, instance_params -- in that order,
## before content_version.
const ITEM_KEYS_V5: Array = [
	"id", "origin", "parent", "children", "visible", "draw_index", "z_index", "z_relative",
	"behind", "clip", "custom_rect", "visibility_layer", "texture_filter", "texture_repeat",
	"material", "use_parent_material", "instance_params", "content_version", "commands",
]
const PARENT_KEYS: Array = ["kind", "id"]
const PARENT_KINDS: Array = ["canvas", "item"]
const ADD_RECT_KEYS: Array = ["op", "aa", "f"]
const ADD_TEXTURE_RECT_KEYS: Array = ["op", "tex", "tile", "transpose", "f"]
const ADD_TEXTURE_RECT_REGION_KEYS: Array = ["op", "tex", "transpose", "clip_uv", "f"]
## render-stream-3.md "Command" (new at /3).
const ADD_MSDF_TEXTURE_RECT_REGION_KEYS: Array = ["op", "tex", "outline", "f"]
const UNSUPPORTED_CMD_KEYS: Array = ["op", "name", "reason"]
const UNSUPPORTED_CMD_REASONS: Array = [
	"unsupported-op", "unknown-texture", "canvas-texture-headless", "unknown-mesh", "skinned-geometry",
]
## render-stream-4.md "Command" (new at /4): key order is "op", the extra meta keys in the order
## the spec lists them, then "f" last (or, for add_clip_ignore, "ignore" last with no "f").
const ADD_LINE_KEYS: Array = ["op", "aa", "f"]
const ADD_POLYLINE_KEYS: Array = ["op", "aa", "n", "colors", "f"]
const ADD_CIRCLE_KEYS: Array = ["op", "aa", "f"]
const ADD_PRIMITIVE_KEYS: Array = ["op", "tex", "n", "colors", "uvs", "f"]
const ADD_TRIANGLE_ARRAY_KEYS: Array = ["op", "tex", "n", "colors", "uvs", "indices", "count", "i", "f"]
const ADD_NINE_PATCH_KEYS: Array = ["op", "tex", "x_axis", "y_axis", "draw_center", "f"]
const ADD_MESH_KEYS: Array = ["op", "mesh", "tex", "f"]
const ADD_SET_TRANSFORM_KEYS: Array = ["op", "f"]
const ADD_CLIP_IGNORE_KEYS: Array = ["op", "ignore"]
const AXIS_STRETCH_MODES: Array = ["stretch", "tile", "tile_fit"]
const FILTERS: Array = [
	"default", "nearest", "linear", "nearest_mipmaps", "linear_mipmaps",
	"nearest_mipmaps_anisotropic", "linear_mipmaps_anisotropic",
]
const REPEATS: Array = ["default", "disabled", "enabled", "mirror"]
const TEXTURE_KEYS: Array = [
	"id", "origin", "kind", "status", "reason", "version", "hash", "format", "width", "height",
	"mipmaps", "payload_bytes", "canvas",
]
const TEXTURE_KINDS: Array = ["image", "placeholder", "canvas"]
const TEXTURE_STATUSES: Array = ["ok", "unsupported", "freed"]
const TEXTURE_REASONS: Array = [
	"unsupported-format", "payload-too-large", "payload-unavailable", "update-shape-mismatch",
	"layered-update", "unknown-texture", "canvas-texture-channel",
]
const CANVAS_TEXTURE_KEYS: Array = ["diffuse", "filter", "repeat"]
## render-stream-4.md "Mesh table" (new at /4).
const MESH_KEYS: Array = ["id", "origin", "status", "reason", "version", "f", "surfaces"]
const MESH_SURFACE_KEYS: Array = ["hash", "payload_bytes", "primitive", "format", "vertex_count", "index_count"]
const MESH_STATUSES: Array = ["ok", "unsupported", "freed"]
const MESH_REASONS: Array = ["mesh-format", "mesh-blend-shapes", "payload-too-large"]
const PRIMITIVES: Array = ["points", "lines", "line_strip", "triangles", "triangle_strip"]

# --- new at /5 (render-stream-5.md "Shader table"/"Material table") ---------------------------

const SHADER_KEYS: Array = [
	"id", "origin", "status", "reason", "version", "mode", "source", "hash", "payload_bytes",
	"builtin", "uses", "default_textures",
]
const BUILTIN_KEYS: Array = ["kind", "blend_mode", "light_mode", "particles_animation"]
const DEFAULT_TEXTURE_KEYS: Array = ["name", "index", "tex"]
const MATERIAL_KEYS: Array = ["id", "origin", "status", "reason", "version", "shader", "params"]
const PARAM_KEYS: Array = ["name", "type", "n", "tex", "f"]
const SHADER_STATUSES: Array = ["ok", "unsupported"]
const SHADER_MODES: Array = ["canvas_item", "spatial", "particles", "sky", "fog"]
const SHADER_REASONS: Array = [
	"shader-mode", "shader-screen-texture", "shader-sdf", "shader-time", "shader-global-uniform",
	"shader-excluded", "payload-too-large", "payload-unavailable",
]
const SHADER_SOURCES: Array = ["payload", "withheld"]
const SHADER_USES: Array = ["global_uniform", "instance_uniform", "light", "screen_texture", "sdf", "time"]
const BLEND_MODES: Array = ["mix", "add", "sub", "mul", "premul_alpha", "disabled"]
const LIGHT_MODES: Array = ["normal", "unshaded", "light_only"]
const MATERIAL_STATUSES: Array = ["ok", "unsupported"]
const MATERIAL_REASONS: Array = ["unknown-shader", "unknown-texture", "param-type", "param-range"]
## gate5_5-design.md D8: the Variant type names a material or instance-shader param may carry on
## the wire, plus the numeric packed array types. As built (G55w): these wire spellings
## (snake_case, matching the engine's own type names) are this codec's own decision -- see
## render-stream-5.md "As built".
const VARIANT_TYPES: Array = [
	"nil", "bool", "int", "float", "vector2", "vector2i", "rect2", "rect2i", "vector3",
	"vector3i", "transform2d", "vector4", "vector4i", "plane", "quaternion", "aabb", "basis",
	"transform3d", "projection", "color", "rid", "packed_int32_array", "packed_int64_array",
	"packed_float32_array", "packed_float64_array", "packed_vector2_array",
	"packed_vector3_array", "packed_vector4_array", "packed_color_array",
]
## gate5_5-design.md D8: float64 components per element of a Variant type (0 for nil/rid).
const VARIANT_COMPONENTS: Dictionary = {
	"nil": 0, "bool": 1, "int": 1, "float": 1, "vector2": 2, "vector2i": 2, "rect2": 4,
	"rect2i": 4, "vector3": 3, "vector3i": 3, "transform2d": 6, "vector4": 4, "vector4i": 4,
	"plane": 4, "quaternion": 4, "aabb": 6, "basis": 9, "transform3d": 12, "projection": 16,
	"color": 4, "rid": 0, "packed_int32_array": 1, "packed_int64_array": 1,
	"packed_float32_array": 1, "packed_float64_array": 1, "packed_vector2_array": 2,
	"packed_vector3_array": 3, "packed_vector4_array": 4, "packed_color_array": 4,
}

const RESOURCE_KEYS: Array = ["type", "hash", "bytes", "blocks"]
const END_KEYS: Array = ["type", "transactions", "reason", "stats", "blocks"]
const END_REASONS: Array = ["shutdown", "disarm"]
const STATS_KEYS: Array = [
	"bytes_total", "encode_ns_total", "snapshot_ns_total", "diff_ns_total", "max_record_bytes",
	"full_transactions", "patch_transactions", "resource_records", "resource_bytes",
]
const BLOCK_KEYS: Array = ["name", "type", "count"]
const SESSION_BLOCK_NAMES: Array = [
	"clear_color", "root_canvas_xform", "host_visible_rect", "host_final_xform",
	"content_scale_factor",
]
const SESSION_BLOCK_COUNTS: Array = [4, 6, 4, 6, 1]
const TRANSACTION_BLOCK_NAMES: Array = ["item_f32", "canvas_f32", "cmd_f32"]
## render-stream-4.md "Transaction blocks": five blocks; cmd_i32 is type "i32", the rest "f32".
const TRANSACTION_BLOCK_NAMES_V4: Array = ["item_f32", "canvas_f32", "cmd_f32", "cmd_i32", "mesh_f32"]
const TRANSACTION_BLOCK_TYPES_V4: Array = ["f32", "f32", "f32", "i32", "f32"]
## render-stream-5.md "Transaction blocks": six blocks; param_f64 is type "f64", the rest as /4.
const TRANSACTION_BLOCK_NAMES_V5: Array = [
	"item_f32", "canvas_f32", "cmd_f32", "cmd_i32", "mesh_f32", "param_f64",
]
const TRANSACTION_BLOCK_TYPES_V5: Array = ["f32", "f32", "f32", "i32", "f32", "f64"]


# --------------------------------------------------------------------------- small helpers


static func err(code: String, detail: String) -> String:
	return code + ": " + detail


## `keys` with `key` inserted right after `after`.
static func keys_with(keys: Array, after: String, key: String) -> Array:
	var out: Array = keys.duplicate()
	out.insert(out.find(after) + 1, key)
	return out


## protocol/unknown-item-skip.md "Classification": true when a transaction's state is missing
## something (an unknown RID still live, or a withheld item) -- partial-unknown-items.
static func is_partial_unknown_items(meta: Dictionary) -> bool:
	if not meta.has(UNKNOWN_ITEMS_KEY):
		return false
	var account: Dictionary = meta[UNKNOWN_ITEMS_KEY]
	return as_int(account["unknown_rids"]) + as_int(account["withheld_items"]) > 0


static func code_of(error: String) -> String:
	var colon: int = error.find(":")
	return error if colon < 0 else error.substr(0, colon)


static func is_int(value: Variant) -> bool:
	var kind: int = typeof(value)
	if kind == TYPE_INT:
		return true
	if kind != TYPE_FLOAT:
		return false
	var number: float = value
	return is_finite(number) and number == floorf(number) and absf(number) <= MAX_SAFE_INT


static func as_int(value: Variant) -> int:
	if typeof(value) == TYPE_INT:
		var whole: int = value
		return whole
	var number: float = value
	return int(number)


static func sha256_hex(bytes: PackedByteArray) -> String:
	var ctx := HashingContext.new()
	ctx.start(HashingContext.HASH_SHA256)
	ctx.update(bytes)
	return ctx.finish().hex_encode()


static func _is_lower_hex(text: String, length: int) -> bool:
	if text.length() != length:
		return false
	for i: int in text.length():
		var c: int = text.unicode_at(i)
		var digit: bool = c >= 0x30 and c <= 0x39
		var lower: bool = c >= 0x61 and c <= 0x66
		if not (digit or lower):
			return false
	return true


## gate5_5-design.md D9, Q1c (rcc:309-313): the material id (or null) an item of a resolved /5
## state draws with. While `use_parent_material` is set and the parent is an item, the parent's
## effective material is taken; a top-level item (parent a canvas, or none) keeps its own.
## Matches render-stream-2.ts's effectiveMaterial.
static func effective_material(item_id: int, items: Dictionary) -> Variant:
	var current: Dictionary = items[item_id]
	var steps: int = 0
	while steps <= items.size():
		var use_parent: bool = current.get("use_parent_material", false)
		if not use_parent:
			break
		var parent: Variant = current["parent"]
		if parent == null:
			break
		var link: Dictionary = parent
		if link["kind"] != "item":
			break
		var parent_id: int = as_int(link["id"])
		if not items.has(parent_id):
			break
		current = items[parent_id]
		steps += 1
	return current.get("material")


static func int_list(values: Variant) -> Array[int]:
	var source: Array = values
	var out: Array[int] = []
	for value: Variant in source:
		out.append(as_int(value))
	return out


static func _check_id_ordering(label: String, list: Array, seq: int) -> String:
	for i: int in range(1, list.size()):
		var prev_entry: Dictionary = list[i - 1]
		var cur_entry: Dictionary = list[i]
		var prev_id: int = as_int(prev_entry["id"])
		var cur_id: int = as_int(cur_entry["id"])
		if cur_id == prev_id:
			return err("duplicate-id", "seq %d: %s id %d repeats" % [seq, label, cur_id])
		if cur_id < prev_id:
			return err("meta-schema", "seq %d: %s are not sorted by id ascending" % [seq, label])
	return ""


static func _check_id_list_ascending(label: String, ids: Array[int], seq: int) -> String:
	for i: int in range(1, ids.size()):
		if ids[i] <= ids[i - 1]:
			return err("meta-schema", "seq %d: %s is not strictly ascending" % [seq, label])
	return ""


# --------------------------------------------------------------------------- framing


static func _frame(data: PackedByteArray, offset: int) -> Dictionary:
	var out: Dictionary = {"error": "", "end": 0, "meta_start": 0, "meta_len": 0, "blocks": []}
	var size: int = data.size()
	if offset + 4 > size:
		out["error"] = err("truncated", "record length prefix at offset %d runs past the end of the input (%d bytes)" % [offset, size])
		return out
	var record_len: int = data.decode_u32(offset)
	var end: int = offset + 4 + record_len
	if end > size:
		out["error"] = err("truncated", "record at offset %d declares record_len %d, which runs past the end of the input (%d bytes)" % [offset, record_len, size])
		return out
	out["end"] = end
	var p: int = offset + 4
	if p + 4 > end:
		out["error"] = err("record-length", "record at offset %d: record_len %d has no room for meta_len" % [offset, record_len])
		return out
	var meta_len: int = data.decode_u32(p)
	p += 4
	if p + meta_len + 4 > end:
		out["error"] = err("record-length", "record at offset %d: meta_len %d and block_count overrun record_len %d" % [offset, meta_len, record_len])
		return out
	out["meta_start"] = p
	out["meta_len"] = meta_len
	p += meta_len
	var block_count: int = data.decode_u32(p)
	p += 4
	var blocks: Array = []
	for i: int in block_count:
		if p + 4 > end:
			out["error"] = err("record-length", "record at offset %d: block %d length prefix overruns record_len %d" % [offset, i, record_len])
			return out
		var block_len: int = data.decode_u32(p)
		p += 4
		if p + block_len > end:
			out["error"] = err("record-length", "record at offset %d: block %d (%d bytes) overruns record_len %d" % [offset, i, block_len, record_len])
			return out
		blocks.append([p, block_len])
		p += block_len
	if p != end:
		out["error"] = err("record-length", "record at offset %d: parts add up to %d bytes, record_len is %d" % [offset, p - offset - 4, record_len])
		return out
	out["blocks"] = blocks
	return out


## `version` (2, 3, 4 or 5) selects the expected magic -- GRS5 (the default since G55d: the
## capture and receiver speak /5, render-stream-5.md), GRS4 (golden-4/ only; the default from G5d
## to G55d), GRS3 (golden-3/ only; the default from G4e2 to G5d) or GRS2 (golden-2/ only). A decoder configured for one version refuses
## every other magic the same way it already refuses GRS0/GRS1/anything else that is not its own.
static func split_records(data: PackedByteArray, version: int = 5) -> Dictionary:
	var records: Array[Dictionary] = []
	var errors := PackedStringArray()
	var expected_magic: String = MAGIC_HEX
	if version == 5:
		expected_magic = MAGIC_V5_HEX
	elif version == 4:
		expected_magic = MAGIC_V4_HEX
	elif version == 3:
		expected_magic = MAGIC_V3_HEX
	if data.size() < 8 or data.slice(0, 8).hex_encode() != expected_magic:
		errors.append(err("bad-magic", "first 8 bytes are %s, expected %s" % [data.slice(0, 8).hex_encode(), expected_magic]))
		return {"records": records, "errors": errors, "framed_to": 0}
	var pos: int = 8
	while pos < data.size():
		var frame: Dictionary = _frame(data, pos)
		var problem: String = frame["error"]
		if problem != "":
			errors.append(problem)
			break
		var end: int = frame["end"]
		records.append({"offset": pos, "byte_length": end - pos})
		pos = end
	return {"records": records, "errors": errors, "framed_to": pos}


# --------------------------------------------------------------------------- meta schema


class Schema:
	extends RefCounted

	var ok: bool = true
	var code: String = "meta-schema"
	var first_error: String = ""
	var _where: String

	func _init(where: String) -> void:
		_where = where

	## render-stream-5.md "Shader table"/"Material table": every other schema check's failure is
	## reported with the generic "meta-schema" code (the default), but shader_entry()/
	## material_entry()/param_entry() are entirely self-coded -- EVERY failure inside them,
	## structural or coupling, is reported with their own top-level code ("shader-entry"/
	## "material-entry"/"param-entry"), mirroring render-stream-2.ts's checkShaderEntrySchema()/
	## checkMaterialEntrySchema()/checkParamEntrySchema() (each has its own local `err` helper
	## baking in its own code, never wrapped generically).
	func fail(detail: String, fail_code: String = "meta-schema") -> void:
		if ok:
			ok = false
			code = fail_code
			first_error = "%s: %s" % [_where, detail]

	func object(value: Variant, keys: Array, path: String, fail_code: String = "meta-schema") -> Dictionary:
		if not ok:
			return {}
		if typeof(value) != TYPE_DICTIONARY:
			fail("%s is not an object" % path, fail_code)
			return {}
		var dict: Dictionary = value
		if dict.keys() != keys:
			fail("%s has keys %s, expected %s in that order" % [path, JSON.stringify(dict.keys()), JSON.stringify(keys)], fail_code)
			return {}
		return dict

	func array(value: Variant, path: String, fail_code: String = "meta-schema") -> Array:
		if not ok:
			return []
		if typeof(value) != TYPE_ARRAY:
			fail("%s is not an array" % path, fail_code)
			return []
		var list: Array = value
		return list

	func integer(value: Variant, path: String, low: float, high: float, fail_code: String = "meta-schema") -> int:
		if not ok:
			return 0
		if not Rs2Decoder.is_int(value):
			fail("%s is %s, not an integer" % [path, JSON.stringify(value)], fail_code)
			return 0
		var number: float = value
		if number < low or number > high:
			fail("%s is %d, outside %d..%d" % [path, int(number), int(low), int(high)], fail_code)
			return 0
		return int(number)

	func nullable_integer(value: Variant, path: String, low: float, high: float) -> void:
		if ok and value != null:
			integer(value, path, low, high)

	func boolean(value: Variant, path: String, fail_code: String = "meta-schema") -> bool:
		if not ok:
			return false
		if typeof(value) != TYPE_BOOL:
			fail("%s is %s, not a boolean" % [path, JSON.stringify(value)], fail_code)
			return false
		var flag: bool = value
		return flag

	func string(value: Variant, path: String, fail_code: String = "meta-schema") -> String:
		if not ok:
			return ""
		if typeof(value) != TYPE_STRING:
			fail("%s is %s, not a string" % [path, JSON.stringify(value)], fail_code)
			return ""
		var text: String = value
		return text

	func nullable_string(value: Variant, path: String) -> void:
		if ok and value != null:
			string(value, path)

	func one_of(value: Variant, allowed: Array, path: String, fail_code: String = "meta-schema") -> String:
		var text: String = string(value, path, fail_code)
		if ok and not allowed.has(text):
			fail("%s is %s, expected one of %s" % [path, JSON.stringify(text), JSON.stringify(allowed)], fail_code)
		return text

	func exact(value: Variant, expected: String, path: String, fail_code: String = "meta-schema") -> void:
		var text: String = string(value, path, fail_code)
		if ok and text != expected:
			fail("%s is %s, expected %s" % [path, JSON.stringify(text), JSON.stringify(expected)], fail_code)

	func hex(value: Variant, length: int, path: String, fail_code: String = "meta-schema") -> void:
		var text: String = string(value, path, fail_code)
		if ok and not Rs2Decoder._is_lower_hex(text, length):
			fail("%s is not %d lowercase hex digits" % [path, length], fail_code)

	func nullable_hex(value: Variant, length: int, path: String, fail_code: String = "meta-schema") -> void:
		if ok and value != null:
			hex(value, length, path, fail_code)

	func sorted_strings(value: Variant, path: String) -> void:
		var list: Array = array(value, path)
		var last: String = ""
		for i: int in list.size():
			var text: String = string(list[i], "%s[%d]" % [path, i])
			if ok and i > 0 and not (last < text):
				fail("%s is not sorted ascending without repeats at %d" % [path, i])
			last = text

	## features.unsupported_resources (G2d): {resource, reason} objects sorted strictly ascending by
	## resource, each reason a known one.
	func unsupported_resources(value: Variant, path: String) -> void:
		var list: Array = array(value, path)
		var last: String = ""
		for i: int in list.size():
			var entry: Dictionary = object(list[i], Rs2Decoder.UNSUPPORTED_RESOURCE_KEYS, "%s[%d]" % [path, i])
			if not ok:
				return
			var resource: String = string(entry.get("resource"), "%s[%d].resource" % [path, i])
			one_of(entry.get("reason"), Rs2Decoder.UNSUPPORTED_RESOURCE_REASONS, "%s[%d].reason" % [path, i])
			if ok and i > 0 and not (last < resource):
				fail("%s is not sorted ascending by resource without repeats at %d" % [path, i])
			last = resource

	func int_pair(value: Variant, path: String) -> void:
		var list: Array = array(value, path)
		if ok and list.size() != 2:
			fail("%s does not have exactly 2 entries" % path)
			return
		integer(list[0], path + "[0]", -Rs2Decoder.MAX_SAFE_INT, Rs2Decoder.MAX_SAFE_INT)
		integer(list[1], path + "[1]", -Rs2Decoder.MAX_SAFE_INT, Rs2Decoder.MAX_SAFE_INT)

	func int_list(value: Variant, path: String) -> void:
		var list: Array = array(value, path)
		for i: int in list.size():
			integer(list[i], "%s[%d]" % [path, i], 1, Rs2Decoder.MAX_SAFE_INT)

	## render-stream-4.md "Block type i32": `types` (one "f32"/"i32" per block) lets the mesh_f32/
	## cmd_i32 transaction blocks share this same check; omitted, every block must be "f32".
	func blocks(value: Variant, names: Array, types: Array = []) -> void:
		var list: Array = array(value, "meta.blocks")
		if ok and list.size() != names.size():
			fail("meta.blocks has %d entries, expected %s" % [list.size(), JSON.stringify(names)])
		for i: int in list.size():
			var path: String = "meta.blocks[%d]" % i
			var entry: Dictionary = object(list[i], Rs2Decoder.BLOCK_KEYS, path)
			var expected_name: String = names[i]
			var expected_type: String = types[i] if types.size() > i else "f32"
			exact(entry.get("name"), expected_name, path + ".name")
			exact(entry.get("type"), expected_type, path + ".type")
			integer(entry.get("count"), path + ".count", 0, Rs2Decoder.U32_MAX)

	func resources(meta: Dictionary, version: int) -> void:
		var is_v4_or_later: bool = version == 4 or version == 5
		var keys: Array = Rs2Decoder.RESOURCES_KEYS_V4 if is_v4_or_later else Rs2Decoder.RESOURCES_KEYS
		var resources_dict: Dictionary = object(meta.get("resources"), keys, "meta.resources")
		exact(resources_dict.get("hash"), "sha256", "meta.resources.hash")
		if is_v4_or_later:
			# render-stream-4.md "Resources": "payloads" is a sorted array of schema strings
			# (mesh and texture share one resource policy; /5 adds shader to that set).
			sorted_strings(resources_dict.get("payloads"), "meta.resources.payloads")
		else:
			string(resources_dict.get("payload"), "meta.resources.payload")
		var delivery: String = one_of(resources_dict.get("delivery"), Rs2Decoder.DELIVERIES, "meta.resources.delivery")
		var inline_max: int = integer(resources_dict.get("inline_max_bytes"), "meta.resources.inline_max_bytes", 0, Rs2Decoder.MAX_SAFE_INT)
		var max_payload: int = integer(resources_dict.get("max_payload_bytes"), "meta.resources.max_payload_bytes", 1, Rs2Decoder.MAX_SAFE_INT)
		sorted_strings(resources_dict.get("permitted_formats"), "meta.resources.permitted_formats")
		var fetch: String = one_of(resources_dict.get("fetch"), Rs2Decoder.FETCHES, "meta.resources.fetch")
		var http_path: Variant = resources_dict.get("http_path")
		nullable_string(http_path, "meta.resources.http_path")
		one_of(resources_dict.get("auth"), Rs2Decoder.AUTHS, "meta.resources.auth")
		if ok:
			if (fetch == "http") != (http_path != null):
				fail("meta.resources.http_path must be non-null exactly for fetch \"http\"")
		if ok:
			var expected_delivery: String = "out-of-band" if inline_max == 0 else ("inline" if inline_max >= max_payload else "mixed")
			if delivery != expected_delivery:
				fail("meta.resources.delivery is %s, expected %s" % [delivery, expected_delivery])
		if ok:
			if (delivery == "inline") != (fetch == "none"):
				fail("meta.resources.fetch must be \"none\" exactly when delivery is \"inline\"")

	func session(meta: Dictionary, version: int) -> void:
		var is_v5: bool = version == 5
		var session_keys: Array = Rs2Decoder.SESSION_KEYS_V5 if is_v5 else Rs2Decoder.SESSION_KEYS
		# protocol/unknown-item-skip.md "Session": an optional key, legal only at /4 and /5.
		var skip_declared: bool = version >= 4 and meta.has(Rs2Decoder.UNKNOWN_ITEM_POLICY_KEY)
		if skip_declared:
			session_keys = Rs2Decoder.keys_with(session_keys, "sabotage", Rs2Decoder.UNKNOWN_ITEM_POLICY_KEY)
		object(meta, session_keys, "meta")
		if skip_declared:
			exact(meta.get(Rs2Decoder.UNKNOWN_ITEM_POLICY_KEY), "skip", "meta.unknown_item_policy")
		var expected_protocol: String = Rs2Decoder.PROTOCOL
		if is_v5:
			expected_protocol = Rs2Decoder.PROTOCOL_V5
		elif version == 4:
			expected_protocol = Rs2Decoder.PROTOCOL_V4
		elif version == 3:
			expected_protocol = Rs2Decoder.PROTOCOL_V3
		exact(meta.get("protocol"), expected_protocol, "meta.protocol")
		hex(meta.get("session_id"), 32, "meta.session_id")
		var stream: Dictionary = object(meta.get("stream"), Rs2Decoder.STREAM_KEYS, "meta.stream")
		hex(stream.get("stream_id"), 32, "meta.stream.stream_id")
		var connection: Variant = stream.get("connection")
		if ok and connection != null:
			integer(connection, "meta.stream.connection", 1, Rs2Decoder.MAX_SAFE_INT)
		one_of(stream.get("transport"), Rs2Decoder.TRANSPORTS, "meta.stream.transport")
		one_of(stream.get("encoding"), Rs2Decoder.ENCODINGS, "meta.stream.encoding")
		var engine: Dictionary = object(meta.get("engine"), Rs2Decoder.ENGINE_KEYS, "meta.engine")
		string(engine.get("version_string"), "meta.engine.version_string")
		hex(engine.get("sha256"), 64, "meta.engine.sha256")
		string(engine.get("display_server"), "meta.engine.display_server")
		string(engine.get("rendering_driver"), "meta.engine.rendering_driver")
		string(engine.get("rendering_method"), "meta.engine.rendering_method")
		var capture: Dictionary = object(meta.get("capture"), Rs2Decoder.CAPTURE_KEYS, "meta.capture")
		integer(capture.get("calibrator_version"), "meta.capture.calibrator_version", 0, Rs2Decoder.MAX_SAFE_INT)
		sorted_strings(capture.get("hooks_planned"), "meta.capture.hooks_planned")
		sorted_strings(capture.get("hooks_omitted"), "meta.capture.hooks_omitted")
		var viewport: Dictionary = object(meta.get("viewport"), Rs2Decoder.VIEWPORT_KEYS, "meta.viewport")
		integer(viewport.get("canvas_cull_mask"), "meta.viewport.canvas_cull_mask", 0, Rs2Decoder.U32_MAX)
		integer(viewport.get("root_canvas"), "meta.viewport.root_canvas", -Rs2Decoder.MAX_SAFE_INT, Rs2Decoder.MAX_SAFE_INT)
		int_pair(viewport.get("logical_size"), "meta.viewport.logical_size")
		var stretch: Dictionary = object(viewport.get("stretch"), Rs2Decoder.STRETCH_KEYS, "meta.viewport.stretch")
		one_of(stretch.get("mode"), Rs2Decoder.STRETCH_MODES, "meta.viewport.stretch.mode")
		one_of(stretch.get("aspect"), Rs2Decoder.STRETCH_ASPECTS, "meta.viewport.stretch.aspect")
		one_of(stretch.get("scale_mode"), Rs2Decoder.SCALE_MODES, "meta.viewport.stretch.scale_mode")
		exact(viewport.get("stretch_applied_by"), "receiver", "meta.viewport.stretch_applied_by")
		one_of(viewport.get("root_size_policy"), Rs2Decoder.ROOT_SIZE_POLICIES, "meta.viewport.root_size_policy")
		one_of(viewport.get("host_size_status"), Rs2Decoder.HOST_SIZE_STATUSES, "meta.viewport.host_size_status")
		int_pair(viewport.get("host_window_size"), "meta.viewport.host_window_size")
		resources(meta, version)
		if is_v5:
			# render-stream-5.md "Session": a new "materials" key, right after "resources".
			var materials_dict: Dictionary = object(meta.get("materials"), Rs2Decoder.MATERIALS_KEYS, "meta.materials")
			one_of(materials_dict.get("shader_policy"), Rs2Decoder.SHADER_POLICIES, "meta.materials.shader_policy")
		var features: Dictionary = object(meta.get("features"), Rs2Decoder.FEATURES_KEYS_V5 if is_v5 else Rs2Decoder.FEATURES_KEYS, "meta.features")
		sorted_strings(features.get("ops"), "meta.features.ops")
		sorted_strings(features.get("item_state"), "meta.features.item_state")
		if is_v5:
			# render-stream-5.md "Session": a new "canvas_state" key, right after "item_state".
			sorted_strings(features.get("canvas_state"), "meta.features.canvas_state")
		sorted_strings(features.get("resources"), "meta.features.resources")
		unsupported_resources(features.get("unsupported_resources"), "meta.features.unsupported_resources")
		sorted_strings(features.get("observed_unsupported_ops"), "meta.features.observed_unsupported_ops")
		sorted_strings(features.get("unobserved"), "meta.features.unobserved")
		exact(features.get("publication"), Rs2Decoder.PUBLICATION, "meta.features.publication")
		var sabotage: Variant = meta.get("sabotage")
		if ok and sabotage != null:
			var spec: Dictionary = object(sabotage, Rs2Decoder.SABOTAGE_KEYS, "meta.sabotage")
			var kind: String = one_of(spec.get("kind"), Rs2Decoder.SABOTAGE_KINDS, "meta.sabotage.kind")
			integer(spec.get("frame"), "meta.sabotage.frame", 1, Rs2Decoder.MAX_SAFE_INT)
			var op: Variant = spec.get("op")
			if ok:
				if op != null:
					string(op, "meta.sabotage.op")
				if ok and (kind == "omit-op") != (op != null):
					fail("meta.sabotage.op must be non-null exactly for kind \"omit-op\"")
		blocks(meta.get("blocks"), Rs2Decoder.SESSION_BLOCK_NAMES)
		if ok:
			var declared: Array = meta["blocks"]
			for i: int in declared.size():
				var entry: Dictionary = declared[i]
				var expected: int = Rs2Decoder.SESSION_BLOCK_COUNTS[i]
				if Rs2Decoder.as_int(entry["count"]) != expected:
					fail("session block %s has count %d, expected %d" % [entry["name"], Rs2Decoder.as_int(entry["count"]), expected])

	func texture_entry(t: Variant, path: String) -> void:
		var entry: Dictionary = object(t, Rs2Decoder.TEXTURE_KEYS, path)
		integer(entry.get("id"), path + ".id", 1, Rs2Decoder.MAX_SAFE_INT)
		exact(entry.get("origin"), "created", path + ".origin")
		one_of(entry.get("kind"), Rs2Decoder.TEXTURE_KINDS, path + ".kind")
		one_of(entry.get("status"), Rs2Decoder.TEXTURE_STATUSES, path + ".status")
		var reason: Variant = entry.get("reason")
		if ok and reason != null:
			one_of(reason, Rs2Decoder.TEXTURE_REASONS, path + ".reason")
		integer(entry.get("version"), path + ".version", 1, Rs2Decoder.MAX_SAFE_INT)
		nullable_hex(entry.get("hash"), 64, path + ".hash")
		nullable_string(entry.get("format"), path + ".format")
		integer(entry.get("width"), path + ".width", 0, Rs2Decoder.MAX_SAFE_INT)
		integer(entry.get("height"), path + ".height", 0, Rs2Decoder.MAX_SAFE_INT)
		boolean(entry.get("mipmaps"), path + ".mipmaps")
		integer(entry.get("payload_bytes"), path + ".payload_bytes", 0, Rs2Decoder.MAX_SAFE_INT)
		var canvas: Variant = entry.get("canvas")
		if ok and canvas != null:
			var canvas_dict: Dictionary = object(canvas, Rs2Decoder.CANVAS_TEXTURE_KEYS, path + ".canvas")
			var diffuse: Variant = canvas_dict.get("diffuse")
			if ok and diffuse != null:
				integer(diffuse, path + ".canvas.diffuse", 1, Rs2Decoder.MAX_SAFE_INT)
			one_of(canvas_dict.get("filter"), Rs2Decoder.FILTERS, path + ".canvas.filter")
			one_of(canvas_dict.get("repeat"), Rs2Decoder.REPEATS, path + ".canvas.repeat")

	## render-stream-4.md "Mesh table" (new at /4): the wire shape of one mesh entry. The
	## status/reason/f/surfaces coupling ("mesh-entry") is checked later, once the running
	## mesh_f32 offset is known (_check_resolved_invariants).
	func mesh_surface(s: Variant, path: String) -> void:
		var entry: Dictionary = object(s, Rs2Decoder.MESH_SURFACE_KEYS, path)
		hex(entry.get("hash"), 64, path + ".hash")
		integer(entry.get("payload_bytes"), path + ".payload_bytes", 1, Rs2Decoder.MAX_SAFE_INT)
		one_of(entry.get("primitive"), Rs2Decoder.PRIMITIVES, path + ".primitive")
		integer(entry.get("format"), path + ".format", -Rs2Decoder.MAX_SAFE_INT, Rs2Decoder.MAX_SAFE_INT)
		integer(entry.get("vertex_count"), path + ".vertex_count", 0, Rs2Decoder.MAX_SAFE_INT)
		integer(entry.get("index_count"), path + ".index_count", 0, Rs2Decoder.MAX_SAFE_INT)

	func mesh_entry(m: Variant, path: String) -> void:
		var entry: Dictionary = object(m, Rs2Decoder.MESH_KEYS, path)
		integer(entry.get("id"), path + ".id", 1, Rs2Decoder.MAX_SAFE_INT)
		exact(entry.get("origin"), "created", path + ".origin")
		one_of(entry.get("status"), Rs2Decoder.MESH_STATUSES, path + ".status")
		var reason: Variant = entry.get("reason")
		if ok and reason != null:
			one_of(reason, Rs2Decoder.MESH_REASONS, path + ".reason")
		integer(entry.get("version"), path + ".version", 1, Rs2Decoder.MAX_SAFE_INT)
		nullable_integer(entry.get("f"), path + ".f", 0, Rs2Decoder.MAX_SAFE_INT)
		var surfaces: Array = array(entry.get("surfaces"), path + ".surfaces")
		for i: int in surfaces.size():
			mesh_surface(surfaces[i], "%s.surfaces[%d]" % [path, i])

	## render-stream-5.md "Material table" (new at /5): the wire shape of one <param> object.
	## "param-entry"'s type/n/tex coupling (tex non-null iff type "rid") is checked here; "param-
	## offset" (the running "f" sequence) needs the whole material/item context and is checked
	## later (_check_resolved_invariants).
	## render-stream-5.md "Material table" param-entry: self-coded ("param-entry"), unlike most
	## other schema checks -- see the comment above fail(). Used both for a materials[] entry's
	## own params[] and an items[] entry's instance_params[] (render-stream-2.ts
	## checkParamEntrySchema() is likewise shared between the two call sites, same code either
	## way).
	func param_entry(p: Variant, path: String) -> String:
		const C := "param-entry"
		var entry: Dictionary = object(p, Rs2Decoder.PARAM_KEYS, path, C)
		var name: String = string(entry.get("name"), path + ".name", C)
		var type_name: String = one_of(entry.get("type"), Rs2Decoder.VARIANT_TYPES, path + ".type", C)
		integer(entry.get("n"), path + ".n", 1, Rs2Decoder.MAX_SAFE_INT, C)
		var tex: Variant = entry.get("tex")
		if ok and tex != null:
			integer(tex, path + ".tex", 1, Rs2Decoder.MAX_SAFE_INT, C)
		if ok and (type_name == "rid") != (tex != null):
			fail(path + ".tex must be non-null exactly for type \"rid\"", C)
		integer(entry.get("f"), path + ".f", 0, Rs2Decoder.MAX_SAFE_INT, C)
		return name

	## render-stream-5.md "Shader table" shader-entry: self-coded ("shader-entry") -- see the
	## comment above fail().
	func shader_entry(s: Variant, path: String) -> void:
		const C := "shader-entry"
		var entry: Dictionary = object(s, Rs2Decoder.SHADER_KEYS, path, C)
		integer(entry.get("id"), path + ".id", 1, Rs2Decoder.MAX_SAFE_INT, C)
		exact(entry.get("origin"), "created", path + ".origin", C)
		var status: String = one_of(entry.get("status"), Rs2Decoder.SHADER_STATUSES, path + ".status", C)
		var reason: Variant = entry.get("reason")
		if ok and reason != null:
			one_of(reason, Rs2Decoder.SHADER_REASONS, path + ".reason", C)
		if ok and (status == "ok") != (reason == null):
			fail(path + ".reason must be null exactly for status \"ok\"", C)
		integer(entry.get("version"), path + ".version", 1, Rs2Decoder.MAX_SAFE_INT, C)
		var mode: Variant = entry.get("mode")
		if ok and mode != null:
			one_of(mode, Rs2Decoder.SHADER_MODES, path + ".mode", C)
		var source: Variant = entry.get("source")
		if ok and source != null:
			one_of(source, Rs2Decoder.SHADER_SOURCES, path + ".source", C)
		if ok and (mode == null) != (source == null):
			fail(path + ".mode and .source must be null together (no code yet)", C)
		nullable_hex(entry.get("hash"), 64, path + ".hash", C)
		integer(entry.get("payload_bytes"), path + ".payload_bytes", 0, Rs2Decoder.MAX_SAFE_INT, C)
		var builtin: Variant = entry.get("builtin")
		if ok and builtin != null:
			var builtin_dict: Dictionary = object(builtin, Rs2Decoder.BUILTIN_KEYS, path + ".builtin", C)
			exact(builtin_dict.get("kind"), "canvas_item_material", path + ".builtin.kind", C)
			one_of(builtin_dict.get("blend_mode"), Rs2Decoder.BLEND_MODES, path + ".builtin.blend_mode", C)
			one_of(builtin_dict.get("light_mode"), Rs2Decoder.LIGHT_MODES, path + ".builtin.light_mode", C)
			boolean(builtin_dict.get("particles_animation"), path + ".builtin.particles_animation", C)
		var uses: Array = array(entry.get("uses"), path + ".uses", C)
		var last_use: String = ""
		for i: int in uses.size():
			var use: String = one_of(uses[i], Rs2Decoder.SHADER_USES, "%s.uses[%d]" % [path, i], C)
			if ok and i > 0 and not (last_use < use):
				fail("%s.uses is not sorted ascending without repeats at %d" % [path, i], C)
			last_use = use
		var default_textures: Array = array(entry.get("default_textures"), path + ".default_textures", C)
		var last_name: String = ""
		var last_index: int = -1
		for i: int in default_textures.size():
			var dpath: String = "%s.default_textures[%d]" % [path, i]
			var dentry: Dictionary = object(default_textures[i], Rs2Decoder.DEFAULT_TEXTURE_KEYS, dpath, C)
			var dname: String = string(dentry.get("name"), dpath + ".name", C)
			var dindex: int = integer(dentry.get("index"), dpath + ".index", 0, Rs2Decoder.MAX_SAFE_INT, C)
			integer(dentry.get("tex"), dpath + ".tex", 1, Rs2Decoder.MAX_SAFE_INT, C)
			if ok and i > 0 and not (last_name < dname or (last_name == dname and last_index < dindex)):
				fail("%s.default_textures is not sorted strictly ascending by (name, index) at %d" % [path, i], C)
			last_name = dname
			last_index = dindex

	## render-stream-5.md "Material table" material-entry: self-coded ("material-entry") -- see
	## the comment above fail().
	func material_entry(m: Variant, path: String) -> void:
		const C := "material-entry"
		var entry: Dictionary = object(m, Rs2Decoder.MATERIAL_KEYS, path, C)
		integer(entry.get("id"), path + ".id", 1, Rs2Decoder.MAX_SAFE_INT, C)
		exact(entry.get("origin"), "created", path + ".origin", C)
		var status: String = one_of(entry.get("status"), Rs2Decoder.MATERIAL_STATUSES, path + ".status", C)
		var reason: Variant = entry.get("reason")
		if ok and reason != null:
			one_of(reason, Rs2Decoder.MATERIAL_REASONS, path + ".reason", C)
		if ok and (status == "ok") != (reason == null):
			fail(path + ".reason must be null exactly for status \"ok\"", C)
		integer(entry.get("version"), path + ".version", 1, Rs2Decoder.MAX_SAFE_INT, C)
		var shader: Variant = entry.get("shader")
		if ok and shader != null:
			integer(shader, path + ".shader", 1, Rs2Decoder.MAX_SAFE_INT, C)
		var params: Array = array(entry.get("params"), path + ".params", C)
		var last_name: String = ""
		for i: int in params.size():
			var name: String = param_entry(params[i], "%s.params[%d]" % [path, i])
			if ok and i > 0 and not (last_name < name):
				fail("%s.params is not sorted strictly ascending by name at %d" % [path, i], C)
			last_name = name

	func transaction(meta: Dictionary, version: int) -> void:
		var is_v5: bool = version == 5
		var is_v4: bool = is_v5 or version == 4
		var transaction_keys: Array = Rs2Decoder.TRANSACTION_KEYS
		if is_v5:
			transaction_keys = Rs2Decoder.TRANSACTION_KEYS_V5
		elif is_v4:
			transaction_keys = Rs2Decoder.TRANSACTION_KEYS_V4
		# protocol/unknown-item-skip.md "Transaction": legal only at /4 and /5; whether it must be
		# present is the session's call (Stream checks the coupling).
		var has_unknown_items: bool = is_v4 and meta.has(Rs2Decoder.UNKNOWN_ITEMS_KEY)
		if has_unknown_items:
			transaction_keys = Rs2Decoder.keys_with(transaction_keys, "unsupported", Rs2Decoder.UNKNOWN_ITEMS_KEY)
		object(meta, transaction_keys, "meta")
		if has_unknown_items:
			var account: Dictionary = object(meta.get(Rs2Decoder.UNKNOWN_ITEMS_KEY), Rs2Decoder.UNKNOWN_ITEMS_KEYS, "meta.unknown_items")
			for i: int in Rs2Decoder.UNKNOWN_ITEMS_KEYS.size():
				var key: String = Rs2Decoder.UNKNOWN_ITEMS_KEYS[i]
				integer(account.get(key), "meta.unknown_items." + key, 0, Rs2Decoder.MAX_SAFE_INT)
		integer(meta.get("seq"), "meta.seq", 1, Rs2Decoder.MAX_SAFE_INT)
		integer(meta.get("frame"), "meta.frame", 1, Rs2Decoder.MAX_SAFE_INT)
		one_of(meta.get("encoding"), Rs2Decoder.ENCODINGS, "meta.encoding")
		nullable_integer(meta.get("base_seq"), "meta.base_seq", 1, Rs2Decoder.MAX_SAFE_INT)
		one_of(meta.get("status"), Rs2Decoder.STATUSES, "meta.status")
		var failures: Array = array(meta.get("failures"), "meta.failures")
		for i: int in failures.size():
			var path: String = "meta.failures[%d]" % i
			var failure: Dictionary = object(failures[i], Rs2Decoder.FAILURE_KEYS, path)
			one_of(failure.get("reason"), Rs2Decoder.FAILURE_REASONS, path + ".reason")
			string(failure.get("detail"), path + ".detail")
		var unsupported: Array = array(meta.get("unsupported"), "meta.unsupported")
		for i: int in unsupported.size():
			var path: String = "meta.unsupported[%d]" % i
			var entry: Dictionary = object(unsupported[i], Rs2Decoder.UNSUPPORTED_KEYS, path)
			if not ok:
				return
			string(entry["op"], path + ".op")
			if entry["item"] == null:
				one_of(entry["reason"], Rs2Decoder.SESSION_UNSUPPORTED_REASONS_V5 if is_v5 else Rs2Decoder.SESSION_UNSUPPORTED_REASONS, path + ".reason")
			else:
				integer(entry["item"], path + ".item", 1, Rs2Decoder.MAX_SAFE_INT)
				one_of(entry["reason"], Rs2Decoder.ITEM_UNSUPPORTED_REASONS_V5 if is_v5 else Rs2Decoder.ITEM_UNSUPPORTED_REASONS, path + ".reason")
		var filt: String = one_of(meta.get("default_texture_filter"), Rs2Decoder.FILTERS, "meta.default_texture_filter")
		if ok and filt == "default":
			fail("meta.default_texture_filter must never be \"default\"")
		var rep: String = one_of(meta.get("default_texture_repeat"), Rs2Decoder.REPEATS, "meta.default_texture_repeat")
		if ok and rep == "default":
			fail("meta.default_texture_repeat must never be \"default\"")
		int_list(meta.get("removed_canvases"), "meta.removed_canvases")
		int_list(meta.get("removed_items"), "meta.removed_items")
		int_list(meta.get("removed_textures"), "meta.removed_textures")
		if is_v4:
			int_list(meta.get("removed_meshes"), "meta.removed_meshes")
		if is_v5:
			int_list(meta.get("removed_shaders"), "meta.removed_shaders")
			int_list(meta.get("removed_materials"), "meta.removed_materials")
		var canvases: Array = array(meta.get("canvases"), "meta.canvases")
		for i: int in canvases.size():
			var path: String = "meta.canvases[%d]" % i
			var canvas: Dictionary = object(canvases[i], Rs2Decoder.CANVAS_KEYS, path)
			integer(canvas.get("id"), path + ".id", 1, Rs2Decoder.MAX_SAFE_INT)
			one_of(canvas.get("origin"), Rs2Decoder.ORIGINS, path + ".origin")
			var role: Variant = canvas.get("role")
			if ok and role != null:
				exact(role, "root", path + ".role")
			boolean(canvas.get("attached"), path + ".attached")
			int_list(canvas.get("items"), path + ".items")
		var items: Array = array(meta.get("items"), "meta.items")
		for i: int in items.size():
			var path: String = "meta.items[%d]" % i
			var item: Dictionary = object(items[i], Rs2Decoder.ITEM_KEYS_V5 if is_v5 else Rs2Decoder.ITEM_KEYS, path)
			integer(item.get("id"), path + ".id", 1, Rs2Decoder.MAX_SAFE_INT)
			one_of(item.get("origin"), Rs2Decoder.ORIGINS, path + ".origin")
			var parent: Variant = item.get("parent")
			if ok and parent != null:
				var link: Dictionary = object(parent, Rs2Decoder.PARENT_KEYS, path + ".parent")
				one_of(link.get("kind"), Rs2Decoder.PARENT_KINDS, path + ".parent.kind")
				integer(link.get("id"), path + ".parent.id", 1, Rs2Decoder.MAX_SAFE_INT)
			int_list(item.get("children"), path + ".children")
			boolean(item.get("visible"), path + ".visible")
			integer(item.get("draw_index"), path + ".draw_index", -Rs2Decoder.MAX_SAFE_INT, Rs2Decoder.MAX_SAFE_INT)
			integer(item.get("z_index"), path + ".z_index", -Rs2Decoder.MAX_SAFE_INT, Rs2Decoder.MAX_SAFE_INT)
			boolean(item.get("z_relative"), path + ".z_relative")
			boolean(item.get("behind"), path + ".behind")
			boolean(item.get("clip"), path + ".clip")
			boolean(item.get("custom_rect"), path + ".custom_rect")
			integer(item.get("visibility_layer"), path + ".visibility_layer", 0, Rs2Decoder.U32_MAX)
			one_of(item.get("texture_filter"), Rs2Decoder.FILTERS, path + ".texture_filter")
			one_of(item.get("texture_repeat"), Rs2Decoder.REPEATS, path + ".texture_repeat")
			if is_v5:
				var item_material: Variant = item.get("material")
				if ok and item_material != null:
					integer(item_material, path + ".material", 1, Rs2Decoder.MAX_SAFE_INT)
				boolean(item.get("use_parent_material"), path + ".use_parent_material")
				var instance_params: Array = array(item.get("instance_params"), path + ".instance_params")
				var last_param_name: String = ""
				for j: int in instance_params.size():
					var pname: String = param_entry(instance_params[j], "%s.instance_params[%d]" % [path, j])
					if ok and j > 0 and not (last_param_name < pname):
						fail("%s.instance_params is not sorted strictly ascending by name at %d" % [path, j])
					last_param_name = pname
			integer(item.get("content_version"), path + ".content_version", 0, Rs2Decoder.MAX_SAFE_INT)
			var commands: Variant = item.get("commands")
			if ok and commands != null:
				var list: Array = array(commands, path + ".commands")
				for j: int in list.size():
					var cpath: String = "%s.commands[%d]" % [path, j]
					if not ok:
						return
					if typeof(list[j]) != TYPE_DICTIONARY:
						fail(cpath + " is not an object")
						return
					var command: Dictionary = list[j]
					var op: Variant = command.get("op")
					if op is String and op == "add_rect":
						object(command, Rs2Decoder.ADD_RECT_KEYS, cpath)
						boolean(command.get("aa"), cpath + ".aa")
						integer(command.get("f"), cpath + ".f", 0, Rs2Decoder.MAX_SAFE_INT)
					elif op is String and op == "add_texture_rect":
						object(command, Rs2Decoder.ADD_TEXTURE_RECT_KEYS, cpath)
						var tex: Variant = command.get("tex")
						if ok and tex != null:
							integer(tex, cpath + ".tex", 1, Rs2Decoder.MAX_SAFE_INT)
						boolean(command.get("tile"), cpath + ".tile")
						boolean(command.get("transpose"), cpath + ".transpose")
						integer(command.get("f"), cpath + ".f", 0, Rs2Decoder.MAX_SAFE_INT)
					elif op is String and op == "add_texture_rect_region":
						object(command, Rs2Decoder.ADD_TEXTURE_RECT_REGION_KEYS, cpath)
						var tex2: Variant = command.get("tex")
						if ok and tex2 != null:
							integer(tex2, cpath + ".tex", 1, Rs2Decoder.MAX_SAFE_INT)
						boolean(command.get("transpose"), cpath + ".transpose")
						boolean(command.get("clip_uv"), cpath + ".clip_uv")
						integer(command.get("f"), cpath + ".f", 0, Rs2Decoder.MAX_SAFE_INT)
					elif op is String and op == "add_msdf_texture_rect_region":
						object(command, Rs2Decoder.ADD_MSDF_TEXTURE_RECT_REGION_KEYS, cpath)
						var tex3: Variant = command.get("tex")
						if ok and tex3 != null:
							integer(tex3, cpath + ".tex", 1, Rs2Decoder.MAX_SAFE_INT)
						integer(command.get("outline"), cpath + ".outline", 0, Rs2Decoder.MAX_SAFE_INT)
						integer(command.get("f"), cpath + ".f", 0, Rs2Decoder.MAX_SAFE_INT)
					elif op is String and op == "add_line":
						object(command, Rs2Decoder.ADD_LINE_KEYS, cpath)
						boolean(command.get("aa"), cpath + ".aa")
						integer(command.get("f"), cpath + ".f", 0, Rs2Decoder.MAX_SAFE_INT)
					elif op is String and (op == "add_polyline" or op == "add_multiline"):
						object(command, Rs2Decoder.ADD_POLYLINE_KEYS, cpath)
						boolean(command.get("aa"), cpath + ".aa")
						integer(command.get("n"), cpath + ".n", 0, Rs2Decoder.MAX_SAFE_INT)
						integer(command.get("colors"), cpath + ".colors", 0, Rs2Decoder.MAX_SAFE_INT)
						integer(command.get("f"), cpath + ".f", 0, Rs2Decoder.MAX_SAFE_INT)
					elif op is String and op == "add_circle":
						object(command, Rs2Decoder.ADD_CIRCLE_KEYS, cpath)
						boolean(command.get("aa"), cpath + ".aa")
						integer(command.get("f"), cpath + ".f", 0, Rs2Decoder.MAX_SAFE_INT)
					elif op is String and (op == "add_primitive" or op == "add_polygon"):
						object(command, Rs2Decoder.ADD_PRIMITIVE_KEYS, cpath)
						var tex4: Variant = command.get("tex")
						if ok and tex4 != null:
							integer(tex4, cpath + ".tex", 1, Rs2Decoder.MAX_SAFE_INT)
						integer(command.get("n"), cpath + ".n", 0, Rs2Decoder.MAX_SAFE_INT)
						integer(command.get("colors"), cpath + ".colors", 0, Rs2Decoder.MAX_SAFE_INT)
						integer(command.get("uvs"), cpath + ".uvs", 0, Rs2Decoder.MAX_SAFE_INT)
						integer(command.get("f"), cpath + ".f", 0, Rs2Decoder.MAX_SAFE_INT)
					elif op is String and op == "add_triangle_array":
						object(command, Rs2Decoder.ADD_TRIANGLE_ARRAY_KEYS, cpath)
						var tex5: Variant = command.get("tex")
						if ok and tex5 != null:
							integer(tex5, cpath + ".tex", 1, Rs2Decoder.MAX_SAFE_INT)
						integer(command.get("n"), cpath + ".n", 0, Rs2Decoder.MAX_SAFE_INT)
						integer(command.get("colors"), cpath + ".colors", 0, Rs2Decoder.MAX_SAFE_INT)
						integer(command.get("uvs"), cpath + ".uvs", 0, Rs2Decoder.MAX_SAFE_INT)
						integer(command.get("indices"), cpath + ".indices", 0, Rs2Decoder.MAX_SAFE_INT)
						integer(command.get("count"), cpath + ".count", -Rs2Decoder.MAX_SAFE_INT, Rs2Decoder.MAX_SAFE_INT)
						integer(command.get("i"), cpath + ".i", 0, Rs2Decoder.MAX_SAFE_INT)
						integer(command.get("f"), cpath + ".f", 0, Rs2Decoder.MAX_SAFE_INT)
					elif op is String and op == "add_nine_patch":
						object(command, Rs2Decoder.ADD_NINE_PATCH_KEYS, cpath)
						var tex6: Variant = command.get("tex")
						if ok and tex6 != null:
							integer(tex6, cpath + ".tex", 1, Rs2Decoder.MAX_SAFE_INT)
						one_of(command.get("x_axis"), Rs2Decoder.AXIS_STRETCH_MODES, cpath + ".x_axis")
						one_of(command.get("y_axis"), Rs2Decoder.AXIS_STRETCH_MODES, cpath + ".y_axis")
						boolean(command.get("draw_center"), cpath + ".draw_center")
						integer(command.get("f"), cpath + ".f", 0, Rs2Decoder.MAX_SAFE_INT)
					elif op is String and op == "add_mesh":
						object(command, Rs2Decoder.ADD_MESH_KEYS, cpath)
						integer(command.get("mesh"), cpath + ".mesh", 1, Rs2Decoder.MAX_SAFE_INT)
						var tex7: Variant = command.get("tex")
						if ok and tex7 != null:
							integer(tex7, cpath + ".tex", 1, Rs2Decoder.MAX_SAFE_INT)
						integer(command.get("f"), cpath + ".f", 0, Rs2Decoder.MAX_SAFE_INT)
					elif op is String and op == "add_set_transform":
						object(command, Rs2Decoder.ADD_SET_TRANSFORM_KEYS, cpath)
						integer(command.get("f"), cpath + ".f", 0, Rs2Decoder.MAX_SAFE_INT)
					elif op is String and op == "add_clip_ignore":
						object(command, Rs2Decoder.ADD_CLIP_IGNORE_KEYS, cpath)
						boolean(command.get("ignore"), cpath + ".ignore")
					elif op is String and op == "unsupported":
						object(command, Rs2Decoder.UNSUPPORTED_CMD_KEYS, cpath)
						string(command.get("name"), cpath + ".name")
						one_of(command.get("reason"), Rs2Decoder.UNSUPPORTED_CMD_REASONS, cpath + ".reason")
					else:
						fail("%s.op is %s, an unknown command op" % [cpath, JSON.stringify(op)])
		var textures: Array = array(meta.get("textures"), "meta.textures")
		for i: int in textures.size():
			texture_entry(textures[i], "meta.textures[%d]" % i)
		if is_v4:
			var meshes: Array = array(meta.get("meshes"), "meta.meshes")
			for i: int in meshes.size():
				mesh_entry(meshes[i], "meta.meshes[%d]" % i)
		if is_v5:
			var shaders: Array = array(meta.get("shaders"), "meta.shaders")
			for i: int in shaders.size():
				shader_entry(shaders[i], "meta.shaders[%d]" % i)
			var materials: Array = array(meta.get("materials"), "meta.materials")
			for i: int in materials.size():
				material_entry(materials[i], "meta.materials[%d]" % i)
		if is_v5:
			blocks(meta.get("blocks"), Rs2Decoder.TRANSACTION_BLOCK_NAMES_V5, Rs2Decoder.TRANSACTION_BLOCK_TYPES_V5)
		elif is_v4:
			blocks(meta.get("blocks"), Rs2Decoder.TRANSACTION_BLOCK_NAMES_V4, Rs2Decoder.TRANSACTION_BLOCK_TYPES_V4)
		else:
			blocks(meta.get("blocks"), Rs2Decoder.TRANSACTION_BLOCK_NAMES)

	func resource(meta: Dictionary) -> void:
		object(meta, Rs2Decoder.RESOURCE_KEYS, "meta")
		hex(meta.get("hash"), 64, "meta.hash")
		var declared_bytes: int = integer(meta.get("bytes"), "meta.bytes", 1, Rs2Decoder.MAX_SAFE_INT)
		var list: Array = array(meta.get("blocks"), "meta.blocks")
		if ok and (list.size() != 1):
			fail("meta.blocks must have exactly one entry")
		if ok:
			var entry: Dictionary = object(list[0], Rs2Decoder.BLOCK_KEYS, "meta.blocks[0]")
			exact(entry.get("name"), "payload", "meta.blocks[0].name")
			exact(entry.get("type"), "u8", "meta.blocks[0].type")
			var count: int = integer(entry.get("count"), "meta.blocks[0].count", 0, Rs2Decoder.U32_MAX)
			if ok and count != declared_bytes:
				fail("meta.blocks[0].count disagrees with meta.bytes")

	func end(meta: Dictionary) -> void:
		object(meta, Rs2Decoder.END_KEYS, "meta")
		integer(meta.get("transactions"), "meta.transactions", 0, Rs2Decoder.MAX_SAFE_INT)
		one_of(meta.get("reason"), Rs2Decoder.END_REASONS, "meta.reason")
		var stats: Dictionary = object(meta.get("stats"), Rs2Decoder.STATS_KEYS, "meta.stats")
		for key: Variant in Rs2Decoder.STATS_KEYS:
			var stat: String = key
			integer(stats.get(stat), "meta.stats." + stat, 0, Rs2Decoder.MAX_SAFE_INT)
		blocks(meta.get("blocks"), [])


# --------------------------------------------------------------------------- one record


## Decodes one record: framing, meta JSON, meta schema, block framing. Returns {offset,
## byte_length, sha256, meta: Dictionary, blocks: Array, errors: PackedStringArray}. Each `blocks`
## entry is a PackedFloat32Array (f32 block) or {"u8_bytes", "sha256"} (u8 block, render-stream-
## 2.md "Decoded and resolved forms" -- the raw bytes are NOT kept here; use raw_resource_payload()
## for that). `meta` is the parsed JSON whenever it parsed, even if later checks failed.
static var _non_printable_regex: RegEx = null


## Any character outside printable ASCII (0x20-0x7e), compiled once.
static func _non_printable() -> RegEx:
	if _non_printable_regex == null:
		_non_printable_regex = RegEx.create_from_string("[^\\x20-\\x7e]")
	return _non_printable_regex


static func decode_record(data: PackedByteArray, offset: int, version: int = 5) -> Dictionary:
	var blocks: Array = []
	var errors := PackedStringArray()
	var out: Dictionary = {
		"offset": offset, "byte_length": 0, "sha256": "", "meta": {}, "blocks": blocks,
		"errors": errors,
	}
	var frame: Dictionary = _frame(data, offset)
	var problem: String = frame["error"]
	if problem != "":
		errors.append(problem)
		out["errors"] = errors
		return out
	var end: int = frame["end"]
	out["byte_length"] = end - offset
	out["sha256"] = sha256_hex(data.slice(offset, end))

	var meta_start: int = frame["meta_start"]
	var meta_len: int = frame["meta_len"]
	var meta_bytes: PackedByteArray = data.slice(meta_start, meta_start + meta_len)
	# G55d: the printable-ASCII rule checked natively first (a Latin-1 decode plus one regex
	# search), so the per-byte GDScript loop -- most of a live receiver's per-transaction decode
	# time on a busy stream -- runs only to name the first bad byte of a record that has one.
	var meta_text: String = meta_bytes.get_string_from_ascii()
	if meta_text.length() != meta_bytes.size() or _non_printable().search(meta_text) != null:
		for i: int in meta_bytes.size():
			var b: int = meta_bytes[i]
			if b < 0x20 or b > 0x7e:
				errors.append(err("meta-json", "record at offset %d: meta byte %d is 0x%02x, not printable ASCII" % [offset, i, b]))
				out["errors"] = errors
				return out
	var json := JSON.new()
	if json.parse(meta_text) != OK:
		errors.append(err("meta-json", "record at offset %d: %s (line %d)" % [offset, json.get_error_message(), json.get_error_line()]))
		out["errors"] = errors
		return out
	var parsed: Variant = json.data
	if typeof(parsed) != TYPE_DICTIONARY:
		errors.append(err("meta-schema", "record at offset %d: meta is not a JSON object" % offset))
		out["errors"] = errors
		return out
	var meta: Dictionary = parsed
	out["meta"] = meta

	var check := Schema.new("record at offset %d" % offset)
	var kind: Variant = meta.get("type")
	if kind is String and kind == "session":
		check.session(meta, version)
	elif kind is String and kind == "transaction":
		check.transaction(meta, version)
	elif kind is String and kind == "resource":
		check.resource(meta)
	elif kind is String and kind == "end":
		check.end(meta)
	else:
		check.fail("meta.type is %s, expected session, transaction, resource or end" % JSON.stringify(kind))
	if not check.ok:
		errors.append(err(check.code, check.first_error))
		out["errors"] = errors
		return out

	var declared: Array = meta["blocks"]
	var spans: Array = frame["blocks"]
	if spans.size() != declared.size():
		errors.append(err("block-count", "record at offset %d: block_count is %d, meta.blocks has %d entries" % [offset, spans.size(), declared.size()]))
		out["errors"] = errors
		return out
	for i: int in spans.size():
		var span: Array = spans[i]
		var entry: Dictionary = declared[i]
		var count: int = as_int(entry["count"])
		var start: int = span[0]
		var length: int = span[1]
		var block_type: String = entry["type"]
		# render-stream-4.md "Block type i32": same four-byte-per-element width as f32.
		# render-stream-5.md "Block type f64": 8 bytes per element.
		var expected_len: int = count
		if block_type == "f32" or block_type == "i32":
			expected_len = 4 * count
		elif block_type == "f64":
			expected_len = 8 * count
		if length != expected_len:
			errors.append(err("block-length", "record at offset %d: block %d (%s) carries %d bytes, count %d needs %d" % [offset, i, entry["name"], length, count, expected_len]))
			out["errors"] = errors
			return out
		if block_type == "f32":
			blocks.append(data.slice(start, start + length).to_float32_array())
		elif block_type == "i32":
			blocks.append(data.slice(start, start + length).to_int32_array())
		elif block_type == "f64":
			blocks.append(data.slice(start, start + length).to_float64_array())
		else:
			var payload: PackedByteArray = data.slice(start, start + length)
			blocks.append({"u8_bytes": length, "sha256": sha256_hex(payload)})
	out["blocks"] = blocks
	return out


## The raw bytes of a "resource" record's single u8 block, read directly from `data` (decode_
## record() discards them into {"u8_bytes","sha256"}). `record` is decode_record()'s result for
## a record whose meta.type == "resource".
static func raw_resource_payload(data: PackedByteArray, record: Dictionary) -> PackedByteArray:
	var offset: int = as_int(record["offset"])
	var frame: Dictionary = _frame(data, offset)
	var spans: Array = frame["blocks"]
	var span: Array = spans[0]
	var start: int = span[0]
	var length: int = span[1]
	return data.slice(start, start + length)


# --------------------------------------------------------------------------- resolution helpers


static func _lift_item(item: Dictionary, item_f32: PackedFloat32Array, cmd_f32: PackedFloat32Array, cmd_i32: PackedInt32Array, param_f64: PackedFloat64Array) -> Dictionary:
	var commands: Array[Dictionary] = []
	if item["commands"] != null:
		var raw: Array = item["commands"]
		for value: Variant in raw:
			var command: Dictionary = value
			var op: String = command["op"]
			if op == "add_rect":
				var f: int = as_int(command["f"])
				commands.append({
					"op": "add_rect", "aa": command["aa"],
					"rect": [cmd_f32[f], cmd_f32[f + 1], cmd_f32[f + 2], cmd_f32[f + 3]],
					"color": [cmd_f32[f + 4], cmd_f32[f + 5], cmd_f32[f + 6], cmd_f32[f + 7]],
				})
			elif op == "add_texture_rect":
				var f2: int = as_int(command["f"])
				commands.append({
					"op": "add_texture_rect", "tex": command["tex"], "tile": command["tile"],
					"transpose": command["transpose"],
					"rect": [cmd_f32[f2], cmd_f32[f2 + 1], cmd_f32[f2 + 2], cmd_f32[f2 + 3]],
					"modulate": [cmd_f32[f2 + 4], cmd_f32[f2 + 5], cmd_f32[f2 + 6], cmd_f32[f2 + 7]],
				})
			elif op == "add_texture_rect_region":
				var f3: int = as_int(command["f"])
				commands.append({
					"op": "add_texture_rect_region", "tex": command["tex"],
					"transpose": command["transpose"], "clip_uv": command["clip_uv"],
					"rect": [cmd_f32[f3], cmd_f32[f3 + 1], cmd_f32[f3 + 2], cmd_f32[f3 + 3]],
					"src": [cmd_f32[f3 + 4], cmd_f32[f3 + 5], cmd_f32[f3 + 6], cmd_f32[f3 + 7]],
					"modulate": [cmd_f32[f3 + 8], cmd_f32[f3 + 9], cmd_f32[f3 + 10], cmd_f32[f3 + 11]],
				})
			elif op == "add_msdf_texture_rect_region":
				# render-stream-3.md "Command": 14 floats (rect 4, src 4, modulate 4, px_range, scale).
				var f4: int = as_int(command["f"])
				commands.append({
					"op": "add_msdf_texture_rect_region", "tex": command["tex"],
					"outline": command["outline"],
					"rect": [cmd_f32[f4], cmd_f32[f4 + 1], cmd_f32[f4 + 2], cmd_f32[f4 + 3]],
					"src": [cmd_f32[f4 + 4], cmd_f32[f4 + 5], cmd_f32[f4 + 6], cmd_f32[f4 + 7]],
					"modulate": [cmd_f32[f4 + 8], cmd_f32[f4 + 9], cmd_f32[f4 + 10], cmd_f32[f4 + 11]],
					"px_range": cmd_f32[f4 + 12], "scale": cmd_f32[f4 + 13],
				})
			elif op == "add_line":
				var fl: int = as_int(command["f"])
				commands.append({
					"op": "add_line", "aa": command["aa"],
					"from": [cmd_f32[fl], cmd_f32[fl + 1]], "to": [cmd_f32[fl + 2], cmd_f32[fl + 3]],
					"colour": [cmd_f32[fl + 4], cmd_f32[fl + 5], cmd_f32[fl + 6], cmd_f32[fl + 7]],
					"width": cmd_f32[fl + 8],
				})
			elif op == "add_polyline" or op == "add_multiline":
				var fp: int = as_int(command["f"])
				var n: int = as_int(command["n"])
				var ncolors: int = as_int(command["colors"])
				var width: float = cmd_f32[fp]
				var points: Array = []
				var p: int = fp + 1
				for i: int in n:
					points.append([cmd_f32[p], cmd_f32[p + 1]])
					p += 2
				var colors: Array = []
				for i: int in ncolors:
					colors.append([cmd_f32[p], cmd_f32[p + 1], cmd_f32[p + 2], cmd_f32[p + 3]])
					p += 4
				commands.append({"op": op, "aa": command["aa"], "width": width, "points": points, "colors": colors})
			elif op == "add_circle":
				var fc: int = as_int(command["f"])
				commands.append({
					"op": "add_circle", "aa": command["aa"],
					"position": [cmd_f32[fc], cmd_f32[fc + 1]], "radius": cmd_f32[fc + 2],
					"colour": [cmd_f32[fc + 3], cmd_f32[fc + 4], cmd_f32[fc + 5], cmd_f32[fc + 6]],
				})
			elif op == "add_primitive" or op == "add_polygon":
				var fpr: int = as_int(command["f"])
				var npr: int = as_int(command["n"])
				var ncolorspr: int = as_int(command["colors"])
				var nuvs: int = as_int(command["uvs"])
				var pointspr: Array = []
				var pp: int = fpr
				for i: int in npr:
					pointspr.append([cmd_f32[pp], cmd_f32[pp + 1]])
					pp += 2
				var colorspr: Array = []
				for i: int in ncolorspr:
					colorspr.append([cmd_f32[pp], cmd_f32[pp + 1], cmd_f32[pp + 2], cmd_f32[pp + 3]])
					pp += 4
				var uvspr: Array = []
				for i: int in nuvs:
					uvspr.append([cmd_f32[pp], cmd_f32[pp + 1]])
					pp += 2
				commands.append({"op": op, "tex": command["tex"], "points": pointspr, "colors": colorspr, "uvs": uvspr})
			elif op == "add_triangle_array":
				var fta: int = as_int(command["f"])
				var ita: int = as_int(command["i"])
				var nta: int = as_int(command["n"])
				var ncolorsta: int = as_int(command["colors"])
				var nuvsta: int = as_int(command["uvs"])
				var nindices: int = as_int(command["indices"])
				var pointsta: Array = []
				var pta: int = fta
				for i: int in nta:
					pointsta.append([cmd_f32[pta], cmd_f32[pta + 1]])
					pta += 2
				var colorsta: Array = []
				for i: int in ncolorsta:
					colorsta.append([cmd_f32[pta], cmd_f32[pta + 1], cmd_f32[pta + 2], cmd_f32[pta + 3]])
					pta += 4
				var uvsta: Array = []
				for i: int in nuvsta:
					uvsta.append([cmd_f32[pta], cmd_f32[pta + 1]])
					pta += 2
				var indices: Array[int] = []
				for i: int in nindices:
					indices.append(cmd_i32[ita + i])
				commands.append({
					"op": "add_triangle_array", "tex": command["tex"], "count": as_int(command["count"]),
					"points": pointsta, "colors": colorsta, "uvs": uvsta, "indices": indices,
				})
			elif op == "add_nine_patch":
				var fnp: int = as_int(command["f"])
				commands.append({
					"op": "add_nine_patch", "tex": command["tex"],
					"rect": [cmd_f32[fnp], cmd_f32[fnp + 1], cmd_f32[fnp + 2], cmd_f32[fnp + 3]],
					"source": [cmd_f32[fnp + 4], cmd_f32[fnp + 5], cmd_f32[fnp + 6], cmd_f32[fnp + 7]],
					"margins": [cmd_f32[fnp + 8], cmd_f32[fnp + 9], cmd_f32[fnp + 10], cmd_f32[fnp + 11]],
					"x_axis": command["x_axis"], "y_axis": command["y_axis"], "draw_center": command["draw_center"],
					"modulate": [cmd_f32[fnp + 12], cmd_f32[fnp + 13], cmd_f32[fnp + 14], cmd_f32[fnp + 15]],
				})
			elif op == "add_mesh":
				var fm: int = as_int(command["f"])
				commands.append({
					"op": "add_mesh", "mesh": as_int(command["mesh"]), "tex": command["tex"],
					"transform": [cmd_f32[fm], cmd_f32[fm + 1], cmd_f32[fm + 2], cmd_f32[fm + 3], cmd_f32[fm + 4], cmd_f32[fm + 5]],
					"modulate": [cmd_f32[fm + 6], cmd_f32[fm + 7], cmd_f32[fm + 8], cmd_f32[fm + 9]],
				})
			elif op == "add_set_transform":
				var fst: int = as_int(command["f"])
				commands.append({
					"op": "add_set_transform",
					"transform": [cmd_f32[fst], cmd_f32[fst + 1], cmd_f32[fst + 2], cmd_f32[fst + 3], cmd_f32[fst + 4], cmd_f32[fst + 5]],
				})
			elif op == "add_clip_ignore":
				commands.append({"op": "add_clip_ignore", "ignore": command["ignore"]})
			else:
				commands.append({"op": "unsupported", "name": command["name"], "reason": command["reason"]})
	var parent: Variant = item["parent"]
	var out: Dictionary = {
		"id": as_int(item["id"]), "origin": item["origin"],
		"parent": null if parent == null else {"kind": parent["kind"], "id": as_int(parent["id"])},
		"children": int_list(item["children"]), "visible": item["visible"],
		"draw_index": as_int(item["draw_index"]), "z_index": as_int(item["z_index"]),
		"z_relative": item["z_relative"], "behind": item["behind"], "clip": item["clip"],
		"custom_rect": item["custom_rect"], "visibility_layer": as_int(item["visibility_layer"]),
		"texture_filter": item["texture_filter"], "texture_repeat": item["texture_repeat"],
		"content_version": as_int(item["content_version"]),
		"xform": [item_f32[0], item_f32[1], item_f32[2], item_f32[3], item_f32[4], item_f32[5]],
		"modulate": [item_f32[6], item_f32[7], item_f32[8], item_f32[9]],
		"self_modulate": [item_f32[10], item_f32[11], item_f32[12], item_f32[13]],
		"custom_rect_rect": [item_f32[14], item_f32[15], item_f32[16], item_f32[17]],
		"commands": commands,
	}
	# new at /5 (render-stream-5.md "Item"): present only when decoded at version 5.
	if item.has("material"):
		var material: Variant = item["material"]
		out["material"] = null if material == null else as_int(material)
		out["use_parent_material"] = item["use_parent_material"]
		var instance_params_raw: Array = item["instance_params"]
		var instance_params: Array = []
		for value: Variant in instance_params_raw:
			var p: Dictionary = value
			instance_params.append(_lift_param(p, param_f64))
		out["instance_params"] = instance_params
	return out


## render-stream-5.md "Decoded and resolved forms": lifts one <param> from the wire's {name,type,
## n,tex,f} into {name,type,value}, reading its floats out of param_f64 starting at "f".
static func _lift_param(p: Dictionary, param_f64: PackedFloat64Array) -> Dictionary:
	var name: String = p["name"]
	var type_name: String = p["type"]
	var n: int = as_int(p["n"])
	var f: int = as_int(p["f"])
	var components: int = Rs2Decoder.VARIANT_COMPONENTS.get(type_name, 0)
	var value: Variant = null
	if type_name == "nil":
		value = null
	elif type_name == "rid":
		value = {"tex": as_int(p["tex"])}
	elif type_name.begins_with("packed_"):
		var flat: Array = []
		for i: int in n * components:
			flat.append(param_f64[f + i])
		if components == 1:
			value = flat
		else:
			var grouped: Array = []
			for i: int in n:
				grouped.append(flat.slice(i * components, i * components + components))
			value = grouped
	else:
		var flat2: Array = []
		for i: int in components:
			flat2.append(param_f64[f + i])
		value = flat2[0] if components == 1 else flat2
	return {"name": name, "type": type_name, "value": value}


static func _lift_shader(s: Dictionary) -> Dictionary:
	return {
		"id": as_int(s["id"]), "origin": s["origin"], "status": s["status"], "reason": s["reason"],
		"version": as_int(s["version"]), "mode": s["mode"], "source": s["source"],
		"hash": s["hash"], "payload_bytes": as_int(s["payload_bytes"]), "builtin": s["builtin"],
		"uses": s["uses"], "default_textures": s["default_textures"],
	}


static func _lift_material(m: Dictionary, param_f64: PackedFloat64Array) -> Dictionary:
	var params_raw: Array = m["params"]
	var params: Array = []
	for value: Variant in params_raw:
		var p: Dictionary = value
		params.append(_lift_param(p, param_f64))
	var shader: Variant = m["shader"]
	return {
		"id": as_int(m["id"]), "origin": m["origin"], "status": m["status"], "reason": m["reason"],
		"version": as_int(m["version"]), "shader": null if shader == null else as_int(shader),
		"params": params,
	}


## `canvas_floats` is the canvas's full slice of canvas_f32: 6 floats (xform only) before /5, 10
## at /5 (xform 6, modulate 4 -- render-stream-5.md "Canvas").
static func _lift_canvas(canvas: Dictionary, canvas_floats: PackedFloat32Array) -> Dictionary:
	var out: Dictionary = {
		"id": as_int(canvas["id"]), "origin": canvas["origin"], "role": canvas["role"],
		"attached": canvas["attached"], "items": int_list(canvas["items"]),
		"xform": [canvas_floats[0], canvas_floats[1], canvas_floats[2], canvas_floats[3], canvas_floats[4], canvas_floats[5]],
	}
	if canvas_floats.size() >= 10:
		out["modulate"] = [canvas_floats[6], canvas_floats[7], canvas_floats[8], canvas_floats[9]]
	return out


## render-stream-4.md "Mesh table": lifts one wire mesh entry, resolving "f" to the actual
## custom_aabb values (6 floats from mesh_f32; all zero, with "f" null, exactly for "freed").
static func _lift_mesh(m: Dictionary, mesh_f32: PackedFloat32Array) -> Dictionary:
	var f: Variant = m["f"]
	var custom_aabb: Array
	if f == null:
		custom_aabb = [0.0, 0.0, 0.0, 0.0, 0.0, 0.0]
	else:
		var fi: int = as_int(f)
		custom_aabb = [mesh_f32[fi], mesh_f32[fi + 1], mesh_f32[fi + 2], mesh_f32[fi + 3], mesh_f32[fi + 4], mesh_f32[fi + 5]]
	return {
		"id": as_int(m["id"]), "origin": m["origin"], "status": m["status"], "reason": m["reason"],
		"version": as_int(m["version"]), "custom_aabb": custom_aabb, "surfaces": m["surfaces"],
	}


static func _command_float_count(command: Dictionary) -> int:
	var op: String = command["op"]
	if op == "add_rect" or op == "add_texture_rect":
		return 8
	if op == "add_texture_rect_region":
		return 12
	if op == "add_msdf_texture_rect_region":
		return 14
	if op == "add_line":
		return 9
	if op == "add_polyline" or op == "add_multiline":
		return 1 + 2 * as_int(command["n"]) + 4 * as_int(command["colors"])
	if op == "add_circle":
		return 7
	if op == "add_primitive" or op == "add_polygon":
		return 2 * as_int(command["n"]) + 4 * as_int(command["colors"]) + 2 * as_int(command["uvs"])
	if op == "add_triangle_array":
		return 2 * as_int(command["n"]) + 4 * as_int(command["colors"]) + 2 * as_int(command["uvs"])
	if op == "add_nine_patch":
		return 16
	if op == "add_mesh":
		return 10
	if op == "add_set_transform":
		return 6
	return 0


## add_triangle_array is the only /4 op with an "i" (cmd_i32 offset) key.
static func _command_int_count(command: Dictionary) -> int:
	if command["op"] == "add_triangle_array":
		return as_int(command["indices"])
	return 0


## The RenderingServer method name a derived unsupported-texture entry names for a tex-bearing
## wire op (render-stream-2.md "Item-level unsupported entries", extended at /4 for the new ops).
static func _rs_method_for_op(op: String) -> String:
	match op:
		"add_texture_rect":
			return "canvas_item_add_texture_rect"
		"add_texture_rect_region":
			return "canvas_item_add_texture_rect_region"
		"add_msdf_texture_rect_region":
			return "canvas_item_add_msdf_texture_rect_region"
		"add_primitive":
			return "canvas_item_add_primitive"
		"add_polygon":
			return "canvas_item_add_polygon"
		"add_triangle_array":
			return "canvas_item_add_triangle_array"
		"add_nine_patch":
			return "canvas_item_add_nine_patch"
		"add_mesh":
			return "canvas_item_add_mesh"
	return op


## True when `cur`'s version/content is an invalid continuation of `previous` (texture-version:
## "within one stream, an id's version never decreases; at an equal version the entry is
## identical except for a change to status: 'freed' and the nulls that implies").
static func _texture_version_regressed(previous: Variant, cur: Dictionary) -> bool:
	if previous == null:
		return false
	var prev: Dictionary = previous
	var prev_version: int = as_int(prev["version"])
	var cur_version: int = as_int(cur["version"])
	if cur_version < prev_version:
		return true
	if cur_version > prev_version:
		return false
	if _dicts_equal(prev, cur):
		return false
	if prev["status"] == "freed" or cur["status"] != "freed":
		return true
	return false


## render-stream-4.md "Mesh table" ("mesh-version"): the texture-version rule, mirrored for
## meshes. Takes the LIFTED (resolved) mesh, not the raw wire entry: "f" is a running offset into
## that transaction's own mesh_f32 block, so it legitimately differs between two transactions
## whose mesh content is byte-identical whenever some other mesh earlier in the table gains or
## loses its own "f" span (e.g. a sibling mesh is freed) -- _lift_mesh() already resolves that
## away into an actual custom_aabb, so comparing the lifted forms avoids a false "regressed".
static func _mesh_version_regressed(previous: Variant, cur: Dictionary) -> bool:
	if previous == null:
		return false
	var prev: Dictionary = previous
	var prev_version: int = as_int(prev["version"])
	var cur_version: int = as_int(cur["version"])
	if cur_version < prev_version:
		return true
	if cur_version > prev_version:
		return false
	if _dicts_equal(prev, cur):
		return false
	if prev["status"] == "freed" or cur["status"] != "freed":
		return true
	return false


## render-stream-5.md ("shader-version"): the texture-version rule, mirrored for shaders --
## within one stream, an id's version never decreases; at an equal version the entry must be
## identical (no "freed" exception: shaders have no freed status).
static func _shader_version_regressed(previous: Variant, cur: Dictionary) -> bool:
	if previous == null:
		return false
	var prev: Dictionary = previous
	var prev_version: int = as_int(prev["version"])
	var cur_version: int = as_int(cur["version"])
	if cur_version < prev_version:
		return true
	if cur_version > prev_version:
		return false
	return not _dicts_equal(prev, cur)


## render-stream-5.md ("material-version"): the same rule, mirrored for materials.
static func _material_version_regressed(previous: Variant, cur: Dictionary) -> bool:
	if previous == null:
		return false
	var prev: Dictionary = previous
	var prev_version: int = as_int(prev["version"])
	var cur_version: int = as_int(cur["version"])
	if cur_version < prev_version:
		return true
	if cur_version > prev_version:
		return false
	return not _dicts_equal(prev, cur)


static func _dicts_equal(a: Dictionary, b: Dictionary) -> bool:
	if a.keys() != b.keys():
		return false
	for key: Variant in a.keys():
		var av: Variant = a[key]
		var bv: Variant = b[key]
		if typeof(av) == TYPE_DICTIONARY and typeof(bv) == TYPE_DICTIONARY:
			var av_dict: Dictionary = av
			var bv_dict: Dictionary = bv
			if not _dicts_equal(av_dict, bv_dict):
				return false
		elif av != bv:
			return false
	return true


# --------------------------------------------------------------------------- whole recording


static func validate_recording(data: PackedByteArray, version: int = 5) -> PackedStringArray:
	var errors := PackedStringArray()
	var split: Dictionary = split_records(data, version)
	var records: Array[Dictionary] = split["records"]
	var split_errors: PackedStringArray = split["errors"]
	if split_errors.size() > 0 and code_of(split_errors[0]) == "bad-magic":
		return split_errors
	var stream := Stream.new(version)
	for index: int in records.size():
		var raw: Dictionary = records[index]
		var record: Dictionary = decode_record(data, as_int(raw["offset"]), version)
		var record_errors: PackedStringArray = record["errors"]
		if record_errors.size() > 0:
			for e: String in record_errors:
				errors.append("%s (record %d)" % [e, index])
			return errors
		errors.append_array(stream.accept(data, record))
		if errors.size() > 0:
			return errors
		if stream.end_seen:
			var end_at: int = as_int(record["offset"]) + as_int(record["byte_length"])
			if end_at < data.size():
				errors.append(err("trailing-bytes", "%d bytes follow the end record at offset %d" % [data.size() - end_at, as_int(record["offset"])]))
			return errors
	errors.append_array(split_errors)
	errors.append_array(stream.finish())
	return errors


class Stream:
	extends RefCounted

	var canvases: Dictionary = {}   # int -> resolved canvas Dictionary
	var items: Dictionary = {}      # int -> resolved item Dictionary
	var textures: Dictionary = {}   # int -> wire texture entry Dictionary
	var meshes: Dictionary = {}     # int -> resolved mesh Dictionary (custom_aabb lifted); /4 only
	var shaders: Dictionary = {}    # int -> resolved shader Dictionary; /5 only
	var materials: Dictionary = {}  # int -> resolved material Dictionary (params lifted); /5 only
	var default_texture_filter: String = "nearest"
	var default_texture_repeat: String = "disabled"

	## render-stream-5.md (G55w): 2, 3, 4 or 5. `Stream.new()` with no args defaults to 5 since
	## G55d, matching this file's module-wide default (4 from G5d to G55d, 3 from G4e2 to G5d).
	var version: int = 5

	func _init(v: int = 5) -> void:
		version = v

	var records_accepted: int = 0
	var session_seen: bool = false
	var end_seen: bool = false
	var last_seq: int = 0
	var last_frame: int = 0
	var transactions: int = 0
	var full_transactions: int = 0
	var patch_transactions: int = 0
	var max_record_bytes: int = 0
	var bytes_total: int = 8
	var session_encoding: String = ""
	## protocol/unknown-item-skip.md: the session declared unknown_item_policy "skip".
	var unknown_item_skip: bool = false
	var inline_max_bytes: int = 0
	var resource_records: int = 0
	var resource_bytes: int = 0
	var _max_item_id: int = 0
	var _max_canvas_id: int = 0
	var _max_texture_id: int = 0
	var _max_mesh_id: int = 0
	var _max_shader_id: int = 0
	var _max_material_id: int = 0
	var _carried_hashes: Dictionary[String, bool] = {}
	var _resource_shapes: Dictionary = {}   # hash -> decoded GRT1 payload shape Dictionary
	var _mesh_resource_shapes: Dictionary = {}  # hash -> decoded GRM1 payload shape Dictionary; /4 only
	var _shader_resource_shapes: Dictionary = {}  # hash -> decoded GRP1 payload shape Dictionary; /5 only
	var _last_seen_texture: Dictionary = {}  # id -> wire texture entry Dictionary
	var _last_seen_mesh: Dictionary = {}     # id -> resolved mesh Dictionary; /4 only
	var _last_seen_shader: Dictionary = {}   # id -> resolved shader Dictionary; /5 only
	var _last_seen_material: Dictionary = {} # id -> resolved material Dictionary; /5 only

	func accept(data: PackedByteArray, record: Dictionary) -> PackedStringArray:
		var errors := PackedStringArray()
		var meta: Dictionary = record["meta"]
		var kind: String = meta["type"]
		var offset: int = Rs2Decoder.as_int(record["offset"])
		var byte_length: int = Rs2Decoder.as_int(record["byte_length"])
		var index: int = records_accepted
		records_accepted += 1
		if end_seen:
			errors.append(Rs2Decoder.err("trailing-bytes", "record %d at offset %d follows the end record" % [index, offset]))
			return errors
		if index == 0 and kind != "session":
			errors.append(Rs2Decoder.err("missing-session", "the first record is a %s, not a session" % kind))
			return errors
		match kind:
			"session":
				if index != 0:
					errors.append(Rs2Decoder.err("duplicate-session", "record %d at offset %d is a second session" % [index, offset]))
					return errors
				session_seen = true
				var stream_meta: Dictionary = meta["stream"]
				session_encoding = stream_meta["encoding"]
				var resources_meta: Dictionary = meta["resources"]
				inline_max_bytes = Rs2Decoder.as_int(resources_meta["inline_max_bytes"])
				unknown_item_skip = meta.has(Rs2Decoder.UNKNOWN_ITEM_POLICY_KEY)
				if Rs2Decoder.as_int(meta["viewport"]["root_canvas"]) != 1:
					errors.append(Rs2Decoder.err("root-canvas", "session.viewport.root_canvas is %d, not 1" % Rs2Decoder.as_int(meta["viewport"]["root_canvas"])))
					return errors
				bytes_total += byte_length
				max_record_bytes = maxi(max_record_bytes, byte_length)
			"resource":
				var hash: String = meta["hash"]
				if _carried_hashes.has(hash):
					errors.append(Rs2Decoder.err("resource-duplicate", "record %d at offset %d: hash %s already carried earlier in this stream" % [index, offset, hash]))
					return errors
				var payload: PackedByteArray = Rs2Decoder.raw_resource_payload(data, record)
				var actual_hash: String = Rs2Decoder.sha256_hex(payload)
				if actual_hash != hash:
					errors.append(Rs2Decoder.err("resource-hash", "record %d at offset %d: payload sha256 %s disagrees with declared hash %s" % [index, offset, actual_hash, hash]))
					return errors
				# render-stream-4.md "Resources": mesh (GRM1), shader (GRP1, new at /5) and texture
				# (GRT1) payloads share one hash namespace and one resource record shape; tell
				# them apart by their own 8-byte magic.
				var is_v4_or_later: bool = version == 4 or version == 5
				var is_shader_payload: bool = version == 5 and payload.size() >= 8 and payload.slice(0, 8).hex_encode() == RsShaderPayload.GRP1_MAGIC_HEX
				var is_mesh_payload: bool = is_v4_or_later and payload.size() >= 8 and payload.slice(0, 8).hex_encode() == RsMeshPayload.GRM1_MAGIC_HEX
				if is_shader_payload:
					var shader_decoded: Dictionary = RsShaderPayload.decode(payload)
					if not shader_decoded["ok"]:
						var shader_payload_code: String = shader_decoded["code"]
						var shader_payload_detail: String = shader_decoded["detail"]
						errors.append(Rs2Decoder.err(shader_payload_code, "record %d at offset %d: %s" % [index, offset, shader_payload_detail]))
						return errors
					shader_decoded["payload_length"] = payload.size()
					_shader_resource_shapes[hash] = shader_decoded
				elif is_mesh_payload:
					var mesh_decoded: Dictionary = RsMeshPayload.decode(payload)
					if not mesh_decoded["ok"]:
						var mesh_payload_code: String = mesh_decoded["code"]
						var mesh_payload_detail: String = mesh_decoded["detail"]
						errors.append(Rs2Decoder.err(mesh_payload_code, "record %d at offset %d: %s" % [index, offset, mesh_payload_detail]))
						return errors
					mesh_decoded["payload_length"] = payload.size()
					_mesh_resource_shapes[hash] = mesh_decoded
				else:
					var decoded: Dictionary = RsTexturePayload.decode(payload)
					if not decoded["ok"]:
						var payload_code: String = decoded["code"]
						var payload_detail: String = decoded["detail"]
						errors.append(Rs2Decoder.err(payload_code, "record %d at offset %d: %s" % [index, offset, payload_detail]))
						return errors
					decoded["payload_length"] = payload.size()
					_resource_shapes[hash] = decoded
				_carried_hashes[hash] = true
				resource_records += 1
				resource_bytes += Rs2Decoder.as_int(meta["bytes"])
				bytes_total += byte_length
				max_record_bytes = maxi(max_record_bytes, byte_length)
			"transaction":
				# protocol/unknown-item-skip.md: the account is in every transaction of a skip
				# session and in no other.
				if meta.has(Rs2Decoder.UNKNOWN_ITEMS_KEY) != unknown_item_skip:
					errors.append(Rs2Decoder.err("meta-schema", "record %d at offset %d: \"unknown_items\" must be present exactly when the session declares unknown_item_policy \"skip\"" % [index, offset]))
					return errors
				var record_blocks: Array = record["blocks"]
				errors.append_array(_accept_transaction(meta, offset, record_blocks))
				if errors.is_empty():
					bytes_total += byte_length
					max_record_bytes = maxi(max_record_bytes, byte_length)
			"end":
				end_seen = true
				var counted: int = Rs2Decoder.as_int(meta["transactions"])
				if counted != transactions:
					errors.append(Rs2Decoder.err("end-count-mismatch", "end record says %d transactions, the recording has %d" % [counted, transactions]))
					return errors
				var stats: Dictionary = meta["stats"]
				var declared_bytes: int = Rs2Decoder.as_int(stats["bytes_total"])
				if declared_bytes != bytes_total:
					errors.append(Rs2Decoder.err("end-stats-mismatch", "stats.bytes_total is %d, the recording's own total is %d" % [declared_bytes, bytes_total]))
					return errors
				var max_bytes: int = Rs2Decoder.as_int(stats["max_record_bytes"])
				if max_bytes != max_record_bytes:
					errors.append(Rs2Decoder.err("end-stats-mismatch", "stats.max_record_bytes is %d, the largest earlier record is %d bytes" % [max_bytes, max_record_bytes]))
					return errors
				var declared_full: int = Rs2Decoder.as_int(stats["full_transactions"])
				var declared_patch: int = Rs2Decoder.as_int(stats["patch_transactions"])
				if declared_full != full_transactions or declared_patch != patch_transactions or declared_full + declared_patch != counted:
					errors.append(Rs2Decoder.err("end-stats-mismatch", "stats full/patch_transactions (%d, %d) disagree with the recording (%d, %d)" % [declared_full, declared_patch, full_transactions, patch_transactions]))
					return errors
				var declared_rr: int = Rs2Decoder.as_int(stats["resource_records"])
				var declared_rb: int = Rs2Decoder.as_int(stats["resource_bytes"])
				if declared_rr != resource_records or declared_rb != resource_bytes:
					errors.append(Rs2Decoder.err("end-stats-mismatch", "stats resource_records/resource_bytes (%d, %d) disagree with the recording (%d, %d)" % [declared_rr, declared_rb, resource_records, resource_bytes]))
					return errors
		return errors

	func finish() -> PackedStringArray:
		var errors := PackedStringArray()
		if records_accepted == 0:
			errors.append(Rs2Decoder.err("missing-session", "the recording has no records"))
		if not end_seen:
			errors.append(Rs2Decoder.err("recording-incomplete", "the input ends after %d records without an end record" % records_accepted))
		return errors

	func _accept_transaction(meta: Dictionary, offset: int, blocks: Array) -> PackedStringArray:
		var errors := PackedStringArray()
		var is_v5: bool = version == 5
		var is_v4: bool = is_v5 or version == 4
		var seq: int = Rs2Decoder.as_int(meta["seq"])
		var frame: int = Rs2Decoder.as_int(meta["frame"])
		var encoding: String = meta["encoding"]
		var canvases_meta: Array = meta["canvases"]
		var items_meta: Array = meta["items"]
		var textures_meta: Array = meta["textures"]
		var meshes_meta: Array = []
		if is_v4:
			meshes_meta = meta["meshes"]
		var shaders_meta: Array = []
		var materials_meta: Array = []
		if is_v5:
			shaders_meta = meta["shaders"]
			materials_meta = meta["materials"]
		var removed_canvases: Array[int] = Rs2Decoder.int_list(meta["removed_canvases"])
		var removed_items: Array[int] = Rs2Decoder.int_list(meta["removed_items"])
		var removed_textures: Array[int] = Rs2Decoder.int_list(meta["removed_textures"])
		var removed_meshes: Array[int] = []
		if is_v4:
			removed_meshes = Rs2Decoder.int_list(meta["removed_meshes"])
		var removed_shaders: Array[int] = []
		var removed_materials: Array[int] = []
		if is_v5:
			removed_shaders = Rs2Decoder.int_list(meta["removed_shaders"])
			removed_materials = Rs2Decoder.int_list(meta["removed_materials"])

		var canvas_order_error: String = Rs2Decoder._check_id_ordering("canvases", canvases_meta, seq)
		if canvas_order_error != "":
			errors.append(canvas_order_error)
			return errors
		var item_order_error: String = Rs2Decoder._check_id_ordering("items", items_meta, seq)
		if item_order_error != "":
			errors.append(item_order_error)
			return errors
		var texture_order_error: String = Rs2Decoder._check_id_ordering("textures", textures_meta, seq)
		if texture_order_error != "":
			errors.append(texture_order_error)
			return errors
		var rc_order: String = Rs2Decoder._check_id_list_ascending("removed_canvases", removed_canvases, seq)
		if rc_order != "":
			errors.append(rc_order)
			return errors
		var ri_order: String = Rs2Decoder._check_id_list_ascending("removed_items", removed_items, seq)
		if ri_order != "":
			errors.append(ri_order)
			return errors
		var rt_order: String = Rs2Decoder._check_id_list_ascending("removed_textures", removed_textures, seq)
		if rt_order != "":
			errors.append(rt_order)
			return errors
		if is_v4:
			var mesh_order_error: String = Rs2Decoder._check_id_ordering("meshes", meshes_meta, seq)
			if mesh_order_error != "":
				errors.append(mesh_order_error)
				return errors
			var rm_order: String = Rs2Decoder._check_id_list_ascending("removed_meshes", removed_meshes, seq)
			if rm_order != "":
				errors.append(rm_order)
				return errors
		if is_v5:
			var shader_order_error: String = Rs2Decoder._check_id_ordering("shaders", shaders_meta, seq)
			if shader_order_error != "":
				errors.append(shader_order_error)
				return errors
			var material_order_error: String = Rs2Decoder._check_id_ordering("materials", materials_meta, seq)
			if material_order_error != "":
				errors.append(material_order_error)
				return errors
			var rsh_order: String = Rs2Decoder._check_id_list_ascending("removed_shaders", removed_shaders, seq)
			if rsh_order != "":
				errors.append(rsh_order)
				return errors
			var rma_order: String = Rs2Decoder._check_id_list_ascending("removed_materials", removed_materials, seq)
			if rma_order != "":
				errors.append(rma_order)
				return errors

		if seq != last_seq + 1:
			errors.append(Rs2Decoder.err("seq-gap", "transaction at offset %d has seq %d, expected %d" % [offset, seq, last_seq + 1]))
			return errors

		var patch_error: String = _check_patch_rules(encoding, seq, meta, removed_canvases, removed_items, removed_textures, removed_meshes, removed_shaders, removed_materials, canvases_meta, items_meta, textures_meta, meshes_meta, shaders_meta, materials_meta, is_v4, is_v5)
		if patch_error != "":
			errors.append(patch_error)
			return errors
		if frame <= last_frame:
			errors.append(Rs2Decoder.err("frame-order", "transaction seq %d has frame %d, not after %d" % [seq, frame, last_frame]))
			return errors

		var item_f32: PackedFloat32Array = blocks[0]
		var canvas_f32: PackedFloat32Array = blocks[1]
		var cmd_f32: PackedFloat32Array = blocks[2]
		var cmd_i32: PackedInt32Array = PackedInt32Array()
		var mesh_f32: PackedFloat32Array = PackedFloat32Array()
		if is_v4:
			cmd_i32 = blocks[3]
			mesh_f32 = blocks[4]
		var param_f64: PackedFloat64Array = PackedFloat64Array()
		if is_v5:
			param_f64 = blocks[5]
		var running: int = 0
		var running_int: int = 0
		for value: Variant in items_meta:
			var item: Dictionary = value
			if item["commands"] == null:
				continue
			var commands: Array = item["commands"]
			for cvalue: Variant in commands:
				var command: Dictionary = cvalue
				var cmd_op: String = command["op"]
				# "unsupported" and "add_clip_ignore" carry no floats and no "f" key at all.
				if cmd_op == "unsupported" or cmd_op == "add_clip_ignore":
					continue
				var fcount: int = Rs2Decoder._command_float_count(command)
				var f: int = Rs2Decoder.as_int(command["f"])
				if f != running:
					errors.append(Rs2Decoder.err("cmd-offset", "seq %d: %s f=%d, expected %d" % [seq, command["op"], f, running]))
					return errors
				running += fcount
				if cmd_op == "add_triangle_array":
					var i_off: int = Rs2Decoder.as_int(command["i"])
					if i_off != running_int:
						errors.append(Rs2Decoder.err("cmd-int-offset", "seq %d: %s i=%d, expected %d" % [seq, cmd_op, i_off, running_int]))
						return errors
					running_int += Rs2Decoder._command_int_count(command)
		var running_mesh: int = 0
		if is_v4:
			for value: Variant in meshes_meta:
				var m: Dictionary = value
				var mf: Variant = m["f"]
				if mf == null:
					continue
				var mfi: int = Rs2Decoder.as_int(mf)
				if mfi != running_mesh:
					errors.append(Rs2Decoder.err("mesh-offset", "seq %d: mesh %d f=%d, expected %d" % [seq, Rs2Decoder.as_int(m["id"]), mfi, running_mesh]))
					return errors
				running_mesh += 6
		# param-offset (render-stream-5.md "Material table", gate5_5-design.md D8): a running
		# offset into param_f64 over materials IN TABLE ORDER FIRST, then items' instance_params
		# in item order -- mirroring cmd-offset/mesh-offset, but spanning two different arrays.
		var running_param: int = 0
		if is_v5:
			for value: Variant in materials_meta:
				var mat: Dictionary = value
				var mat_params: Array = mat["params"]
				for pvalue: Variant in mat_params:
					var p: Dictionary = pvalue
					var pf: int = Rs2Decoder.as_int(p["f"])
					if pf != running_param:
						errors.append(Rs2Decoder.err("param-offset", "seq %d: material %d param \"%s\" f=%d, expected %d" % [seq, Rs2Decoder.as_int(mat["id"]), p["name"], pf, running_param]))
						return errors
					var pn: int = Rs2Decoder.as_int(p["n"])
					var pcomponents: int = Rs2Decoder.VARIANT_COMPONENTS.get(p["type"], 0)
					running_param += pn * pcomponents
			for value: Variant in items_meta:
				var it_for_params: Dictionary = value
				if not it_for_params.has("instance_params"):
					continue
				var iparams: Array = it_for_params["instance_params"]
				for pvalue: Variant in iparams:
					var p: Dictionary = pvalue
					var pf: int = Rs2Decoder.as_int(p["f"])
					if pf != running_param:
						errors.append(Rs2Decoder.err("param-offset", "seq %d: item %d instance param \"%s\" f=%d, expected %d" % [seq, Rs2Decoder.as_int(it_for_params["id"]), p["name"], pf, running_param]))
						return errors
					var pn: int = Rs2Decoder.as_int(p["n"])
					var pcomponents: int = Rs2Decoder.VARIANT_COMPONENTS.get(p["type"], 0)
					running_param += pn * pcomponents

		var canvas_stride: int = 10 if is_v5 else Rs2Decoder.CANVAS_FLOATS
		var expected_canvas_floats: int = canvas_stride * canvases_meta.size()
		if canvas_f32.size() != expected_canvas_floats:
			# canvas-offset (render-stream-5.md "Canvas"): canvas_f32's own expected length gets
			# its own named code at /5 (10 floats per canvas: xform 6, modulate 4); pre-/5, a
			# mismatch is still reported generically as block-count.
			if is_v5:
				errors.append(Rs2Decoder.err("canvas-offset", "seq %d: block canvas_f32 declares count %d, expected %d (10 floats per canvas: xform 6, modulate 4)" % [seq, canvas_f32.size(), expected_canvas_floats]))
			else:
				errors.append(Rs2Decoder.err("block-count", "seq %d: block canvas_f32 declares count %d, expected %d" % [seq, canvas_f32.size(), expected_canvas_floats]))
			return errors
		if item_f32.size() != Rs2Decoder.ITEM_FLOATS * items_meta.size() or cmd_f32.size() != running or (is_v4 and (cmd_i32.size() != running_int or mesh_f32.size() != running_mesh)) or (is_v5 and param_f64.size() != running_param):
			errors.append(Rs2Decoder.err("block-count", "seq %d: decoded block lengths disagree with items/canvases/commands/meshes/materials counts" % seq))
			return errors

		var failures: Array = meta["failures"]
		var status: String = meta["status"]
		if (status == "capture-failure") != (failures.size() > 0):
			errors.append(Rs2Decoder.err("meta-schema", "seq %d: status %s with %d failures" % [seq, status, failures.size()]))
			return errors

		if encoding == "full":
			canvases = {}
			items = {}
			textures = {}
			if is_v4:
				meshes = {}
			if is_v5:
				shaders = {}
				materials = {}
		for id: int in removed_canvases:
			canvases.erase(id)
		for id: int in removed_items:
			items.erase(id)
		for id: int in removed_textures:
			textures.erase(id)
		if is_v4:
			for id: int in removed_meshes:
				meshes.erase(id)
		if is_v5:
			for id: int in removed_shaders:
				shaders.erase(id)
			for id: int in removed_materials:
				materials.erase(id)
		for i: int in canvases_meta.size():
			var canvas: Dictionary = canvases_meta[i]
			var lifted: Dictionary = Rs2Decoder._lift_canvas(canvas, canvas_f32.slice(i * canvas_stride, (i + 1) * canvas_stride))
			canvases[Rs2Decoder.as_int(canvas["id"])] = lifted
		# render-stream-5.md "Material table" (D8 "param-offset"): materials claim their param_f64
		# offsets before any item's instance_params, so lift them first.
		if is_v5:
			for value: Variant in materials_meta:
				var mat: Dictionary = value
				materials[Rs2Decoder.as_int(mat["id"])] = Rs2Decoder._lift_material(mat, param_f64)
		for i: int in items_meta.size():
			var item: Dictionary = items_meta[i]
			var id: int = Rs2Decoder.as_int(item["id"])
			var lifted_item: Dictionary = Rs2Decoder._lift_item(item, item_f32.slice(i * Rs2Decoder.ITEM_FLOATS, (i + 1) * Rs2Decoder.ITEM_FLOATS), cmd_f32, cmd_i32, param_f64)
			if item["commands"] == null:
				var base_commands: Array = []
				if items.has(id):
					var base_item: Dictionary = items[id]
					base_commands = base_item["commands"]
				lifted_item["commands"] = base_commands
			items[id] = lifted_item
		for value: Variant in textures_meta:
			var t: Dictionary = value
			textures[Rs2Decoder.as_int(t["id"])] = t
		if is_v4:
			for value: Variant in meshes_meta:
				var m2: Dictionary = value
				meshes[Rs2Decoder.as_int(m2["id"])] = Rs2Decoder._lift_mesh(m2, mesh_f32)
		if is_v5:
			for value: Variant in shaders_meta:
				var sh: Dictionary = value
				shaders[Rs2Decoder.as_int(sh["id"])] = Rs2Decoder._lift_shader(sh)
		default_texture_filter = meta["default_texture_filter"]
		default_texture_repeat = meta["default_texture_repeat"]

		# texture-version / mesh-version, across the whole stream so far.
		for value: Variant in textures_meta:
			var t: Dictionary = value
			var id: int = Rs2Decoder.as_int(t["id"])
			var previous: Variant = _last_seen_texture.get(id)
			if Rs2Decoder._texture_version_regressed(previous, t):
				errors.append(Rs2Decoder.err("texture-version", "seq %d: texture %d's version/content is inconsistent with its earlier entry" % [seq, id]))
				return errors
			_last_seen_texture[id] = t
		if is_v4:
			for value: Variant in meshes_meta:
				var m3: Dictionary = value
				var mid: int = Rs2Decoder.as_int(m3["id"])
				var lifted_mesh: Dictionary = meshes[mid]
				var mesh_previous: Variant = _last_seen_mesh.get(mid)
				if Rs2Decoder._mesh_version_regressed(mesh_previous, lifted_mesh):
					errors.append(Rs2Decoder.err("mesh-version", "seq %d: mesh %d's version/content is inconsistent with its earlier entry" % [seq, mid]))
					return errors
				_last_seen_mesh[mid] = lifted_mesh
		if is_v5:
			for value: Variant in shaders_meta:
				var sh2: Dictionary = value
				var shid: int = Rs2Decoder.as_int(sh2["id"])
				var lifted_shader: Dictionary = shaders[shid]
				var shader_previous: Variant = _last_seen_shader.get(shid)
				if Rs2Decoder._shader_version_regressed(shader_previous, lifted_shader):
					errors.append(Rs2Decoder.err("shader-version", "seq %d: shader %d's version/content is inconsistent with its earlier entry" % [seq, shid]))
					return errors
				_last_seen_shader[shid] = lifted_shader
			for value: Variant in materials_meta:
				var mat2: Dictionary = value
				var matid: int = Rs2Decoder.as_int(mat2["id"])
				var lifted_material: Dictionary = materials[matid]
				var material_previous: Variant = _last_seen_material.get(matid)
				if Rs2Decoder._material_version_regressed(material_previous, lifted_material):
					errors.append(Rs2Decoder.err("material-version", "seq %d: material %d's version/content is inconsistent with its earlier entry" % [seq, matid]))
					return errors
				_last_seen_material[matid] = lifted_material

		var unsupported_meta: Array = meta["unsupported"]
		var resolved_error: String = _check_resolved_invariants(seq, unsupported_meta, is_v4, is_v5)
		if resolved_error != "":
			errors.append(resolved_error)
			return errors

		# resource-missing / resource-payload, over the RESOLVED table (every ok image entry, and,
		# at /4, every ok mesh surface; at /5, every "payload"-sourced shader).
		for id: int in textures:
			var t: Dictionary = textures[id]
			if t["kind"] != "image" or t["status"] != "ok" or t["hash"] == null:
				continue
			var hash: String = t["hash"]
			var payload_bytes: int = Rs2Decoder.as_int(t["payload_bytes"])
			if payload_bytes > inline_max_bytes:
				continue
			if not _carried_hashes.has(hash):
				errors.append(Rs2Decoder.err("resource-missing", "seq %d: texture %d's hash %s (payload_bytes %d <= inline_max_bytes %d) never arrived as a resource record" % [seq, id, hash, payload_bytes, inline_max_bytes]))
				return errors
			if _resource_shapes.has(hash):
				var shape: Dictionary = _resource_shapes[hash]
				# payload_bytes is the whole payload's length (render-stream-2.md "Texture"), not its data.
				var payload_length: int = Rs2Decoder.as_int(shape["payload_length"])
				if shape["format"] != t["format"] or Rs2Decoder.as_int(shape["width"]) != Rs2Decoder.as_int(t["width"]) or Rs2Decoder.as_int(shape["height"]) != Rs2Decoder.as_int(t["height"]) or shape["mipmaps"] != t["mipmaps"] or payload_length != payload_bytes:
					errors.append(Rs2Decoder.err("resource-payload", "seq %d: the resource for hash %s decodes as %s %dx%d, texture %d declares %s %dx%d" % [seq, hash, shape["format"], Rs2Decoder.as_int(shape["width"]), Rs2Decoder.as_int(shape["height"]), id, t["format"], Rs2Decoder.as_int(t["width"]), Rs2Decoder.as_int(t["height"])]))
					return errors
		if is_v4:
			for mid2: int in meshes:
				var m4: Dictionary = meshes[mid2]
				if m4["status"] != "ok":
					continue
				var surfaces: Array = m4["surfaces"]
				for value: Variant in surfaces:
					var s: Dictionary = value
					var shash: String = s["hash"]
					var spayload_bytes: int = Rs2Decoder.as_int(s["payload_bytes"])
					if spayload_bytes > inline_max_bytes:
						continue
					if not _carried_hashes.has(shash):
						errors.append(Rs2Decoder.err("resource-missing", "seq %d: mesh %d's surface hash %s (payload_bytes %d <= inline_max_bytes %d) never arrived as a resource record" % [seq, mid2, shash, spayload_bytes, inline_max_bytes]))
						return errors
					if _mesh_resource_shapes.has(shash):
						var mshape: Dictionary = _mesh_resource_shapes[shash]
						var mpayload_length: int = Rs2Decoder.as_int(mshape["payload_length"])
						if mshape["primitive"] != s["primitive"] or Rs2Decoder.as_int(mshape["format"]) != Rs2Decoder.as_int(s["format"]) or Rs2Decoder.as_int(mshape["vertex_count"]) != Rs2Decoder.as_int(s["vertex_count"]) or Rs2Decoder.as_int(mshape["index_count"]) != Rs2Decoder.as_int(s["index_count"]) or mpayload_length != spayload_bytes:
							errors.append(Rs2Decoder.err("resource-payload", "seq %d: the resource for hash %s decodes as %s vertex_count %d, mesh %d declares %s vertex_count %d" % [seq, shash, mshape["primitive"], Rs2Decoder.as_int(mshape["vertex_count"]), mid2, s["primitive"], Rs2Decoder.as_int(s["vertex_count"])]))
							return errors
		if is_v5:
			# shader source "withheld" (gate5_5-design.md D4) never has a resource record -- the
			# policy deliberately keeps the code byte off the wire, the store and HTTP.
			for shid2: int in shaders:
				var sh3: Dictionary = shaders[shid2]
				if sh3["status"] != "ok" or sh3["hash"] == null or sh3["source"] != "payload":
					continue
				var shash2: String = sh3["hash"]
				var shpayload_bytes: int = Rs2Decoder.as_int(sh3["payload_bytes"])
				if shpayload_bytes > inline_max_bytes:
					continue
				if not _carried_hashes.has(shash2):
					errors.append(Rs2Decoder.err("resource-missing", "seq %d: shader %d's hash %s (payload_bytes %d <= inline_max_bytes %d) never arrived as a resource record" % [seq, shid2, shash2, shpayload_bytes, inline_max_bytes]))
					return errors
				if _shader_resource_shapes.has(shash2):
					var shshape: Dictionary = _shader_resource_shapes[shash2]
					var shpayload_length: int = Rs2Decoder.as_int(shshape["payload_length"])
					if shpayload_length != shpayload_bytes:
						errors.append(Rs2Decoder.err("resource-payload", "seq %d: the resource for hash %s is %d bytes, shader %d declares payload_bytes %d" % [seq, shash2, shpayload_length, shid2, shpayload_bytes]))
						return errors

		# id-reused.
		var new_canvas_ids: Array[int] = []
		for value: Variant in canvases_meta:
			var c: Dictionary = value
			new_canvas_ids.append(Rs2Decoder.as_int(c["id"]))
		var new_item_ids: Array[int] = []
		for value: Variant in items_meta:
			var it: Dictionary = value
			new_item_ids.append(Rs2Decoder.as_int(it["id"]))
		var new_texture_ids: Array[int] = []
		for value: Variant in textures_meta:
			var t2: Dictionary = value
			new_texture_ids.append(Rs2Decoder.as_int(t2["id"]))
		for id: int in new_canvas_ids:
			if id <= _max_canvas_id and not _known_canvas_ids.has(id):
				errors.append(Rs2Decoder.err("id-reused", "transaction seq %d: canvas id %d is absent from the previous transaction and not above %d" % [seq, id, _max_canvas_id]))
				return errors
		for id: int in new_item_ids:
			if id <= _max_item_id and not _known_item_ids.has(id):
				errors.append(Rs2Decoder.err("id-reused", "transaction seq %d: item id %d is absent from the previous transaction and not above %d" % [seq, id, _max_item_id]))
				return errors
		for id: int in new_texture_ids:
			if id <= _max_texture_id and not _known_texture_ids.has(id):
				errors.append(Rs2Decoder.err("id-reused", "transaction seq %d: texture id %d is absent from the previous transaction and not above %d" % [seq, id, _max_texture_id]))
				return errors
		if is_v4:
			var new_mesh_ids: Array[int] = []
			for value: Variant in meshes_meta:
				var m5: Dictionary = value
				new_mesh_ids.append(Rs2Decoder.as_int(m5["id"]))
			for id: int in new_mesh_ids:
				if id <= _max_mesh_id and not _known_mesh_ids.has(id):
					errors.append(Rs2Decoder.err("id-reused", "transaction seq %d: mesh id %d is absent from the previous transaction and not above %d" % [seq, id, _max_mesh_id]))
					return errors
		if is_v5:
			var new_shader_ids: Array[int] = []
			for value: Variant in shaders_meta:
				var sh4: Dictionary = value
				new_shader_ids.append(Rs2Decoder.as_int(sh4["id"]))
			for id: int in new_shader_ids:
				if id <= _max_shader_id and not _known_shader_ids.has(id):
					errors.append(Rs2Decoder.err("id-reused", "transaction seq %d: shader id %d is absent from the previous transaction and not above %d" % [seq, id, _max_shader_id]))
					return errors
			var new_material_ids: Array[int] = []
			for value: Variant in materials_meta:
				var mat3: Dictionary = value
				new_material_ids.append(Rs2Decoder.as_int(mat3["id"]))
			for id: int in new_material_ids:
				if id <= _max_material_id and not _known_material_ids.has(id):
					errors.append(Rs2Decoder.err("id-reused", "transaction seq %d: material id %d is absent from the previous transaction and not above %d" % [seq, id, _max_material_id]))
					return errors
		_known_canvas_ids = {}
		for id: int in canvases:
			_known_canvas_ids[id] = true
			_max_canvas_id = maxi(_max_canvas_id, id)
		_known_item_ids = {}
		for id: int in items:
			_known_item_ids[id] = true
			_max_item_id = maxi(_max_item_id, id)
		_known_texture_ids = {}
		for id: int in textures:
			_known_texture_ids[id] = true
			_max_texture_id = maxi(_max_texture_id, id)
		if is_v4:
			_known_mesh_ids = {}
			for id: int in meshes:
				_known_mesh_ids[id] = true
				_max_mesh_id = maxi(_max_mesh_id, id)
		if is_v5:
			_known_shader_ids = {}
			for id: int in shaders:
				_known_shader_ids[id] = true
				_max_shader_id = maxi(_max_shader_id, id)
			_known_material_ids = {}
			for id: int in materials:
				_known_material_ids[id] = true
				_max_material_id = maxi(_max_material_id, id)

		last_seq = seq
		last_frame = frame
		transactions += 1
		if encoding == "full":
			full_transactions += 1
		else:
			patch_transactions += 1
		return errors

	var _known_canvas_ids: Dictionary[int, bool] = {}
	var _known_item_ids: Dictionary[int, bool] = {}
	var _known_texture_ids: Dictionary[int, bool] = {}
	var _known_mesh_ids: Dictionary[int, bool] = {}
	var _known_shader_ids: Dictionary[int, bool] = {}
	var _known_material_ids: Dictionary[int, bool] = {}

	func _check_patch_rules(encoding: String, seq: int, meta: Dictionary, removed_canvases: Array[int], removed_items: Array[int], removed_textures: Array[int], removed_meshes: Array[int], removed_shaders: Array[int], removed_materials: Array[int], canvases_meta: Array, items_meta: Array, textures_meta: Array, meshes_meta: Array, shaders_meta: Array, materials_meta: Array, is_v4: bool, is_v5: bool) -> String:
		if encoding == "full":
			var base_seq: Variant = meta["base_seq"]
			if base_seq != null or removed_canvases.size() > 0 or removed_items.size() > 0 or removed_textures.size() > 0 or (is_v4 and removed_meshes.size() > 0) or (is_v5 and (removed_shaders.size() > 0 or removed_materials.size() > 0)):
				return Rs2Decoder.err("patch-encoding", "seq %d: a full transaction carries a non-null base_seq or a non-empty removed list" % seq)
			return ""
		if session_encoding == "full":
			return Rs2Decoder.err("patch-encoding", "seq %d: a patch transaction in a stream whose session says encoding \"full\"" % seq)
		if transactions == 0:
			return Rs2Decoder.err("patch-base", "seq %d: the stream's first transaction is a patch" % seq)
		var base_seq: int = Rs2Decoder.as_int(meta["base_seq"])
		if base_seq != last_seq:
			return Rs2Decoder.err("patch-base", "seq %d: base_seq %d is not the previous transaction's seq %d" % [seq, base_seq, last_seq])

		var removed_canvas_set: Dictionary[int, bool] = {}
		for id: int in removed_canvases:
			if removed_canvas_set.has(id):
				return Rs2Decoder.err("patch-removed", "seq %d: canvas %d is removed twice" % [seq, id])
			removed_canvas_set[id] = true
			if not canvases.has(id):
				return Rs2Decoder.err("patch-removed", "seq %d: removed canvas %d is absent from the base" % [seq, id])
		var removed_item_set: Dictionary[int, bool] = {}
		for id: int in removed_items:
			if removed_item_set.has(id):
				return Rs2Decoder.err("patch-removed", "seq %d: item %d is removed twice" % [seq, id])
			removed_item_set[id] = true
			if not items.has(id):
				return Rs2Decoder.err("patch-removed", "seq %d: removed item %d is absent from the base" % [seq, id])
		var removed_texture_set: Dictionary[int, bool] = {}
		for id: int in removed_textures:
			if removed_texture_set.has(id):
				return Rs2Decoder.err("patch-removed", "seq %d: texture %d is removed twice" % [seq, id])
			removed_texture_set[id] = true
			if not textures.has(id):
				return Rs2Decoder.err("patch-removed", "seq %d: removed texture %d is absent from the base" % [seq, id])
		for value: Variant in canvases_meta:
			var c: Dictionary = value
			var id: int = Rs2Decoder.as_int(c["id"])
			if removed_canvas_set.has(id):
				return Rs2Decoder.err("patch-removed", "seq %d: canvas %d is both removed and present" % [seq, id])
		for value: Variant in items_meta:
			var it: Dictionary = value
			var id: int = Rs2Decoder.as_int(it["id"])
			if removed_item_set.has(id):
				return Rs2Decoder.err("patch-removed", "seq %d: item %d is both removed and present" % [seq, id])
		for value: Variant in textures_meta:
			var t: Dictionary = value
			var id: int = Rs2Decoder.as_int(t["id"])
			if removed_texture_set.has(id):
				return Rs2Decoder.err("patch-removed", "seq %d: texture %d is both removed and present" % [seq, id])
		if is_v4:
			var removed_mesh_set: Dictionary[int, bool] = {}
			for id: int in removed_meshes:
				if removed_mesh_set.has(id):
					return Rs2Decoder.err("patch-removed", "seq %d: mesh %d is removed twice" % [seq, id])
				removed_mesh_set[id] = true
				if not meshes.has(id):
					return Rs2Decoder.err("patch-removed", "seq %d: removed mesh %d is absent from the base" % [seq, id])
			for value: Variant in meshes_meta:
				var m: Dictionary = value
				var mid: int = Rs2Decoder.as_int(m["id"])
				if removed_mesh_set.has(mid):
					return Rs2Decoder.err("patch-removed", "seq %d: mesh %d is both removed and present" % [seq, mid])
		if is_v5:
			var removed_shader_set: Dictionary[int, bool] = {}
			for id: int in removed_shaders:
				if removed_shader_set.has(id):
					return Rs2Decoder.err("patch-removed", "seq %d: shader %d is removed twice" % [seq, id])
				removed_shader_set[id] = true
				if not shaders.has(id):
					return Rs2Decoder.err("patch-removed", "seq %d: removed shader %d is absent from the base" % [seq, id])
			for value: Variant in shaders_meta:
				var sh: Dictionary = value
				var shid: int = Rs2Decoder.as_int(sh["id"])
				if removed_shader_set.has(shid):
					return Rs2Decoder.err("patch-removed", "seq %d: shader %d is both removed and present" % [seq, shid])
			var removed_material_set: Dictionary[int, bool] = {}
			for id: int in removed_materials:
				if removed_material_set.has(id):
					return Rs2Decoder.err("patch-removed", "seq %d: material %d is removed twice" % [seq, id])
				removed_material_set[id] = true
				if not materials.has(id):
					return Rs2Decoder.err("patch-removed", "seq %d: removed material %d is absent from the base" % [seq, id])
			for value: Variant in materials_meta:
				var mat: Dictionary = value
				var matid: int = Rs2Decoder.as_int(mat["id"])
				if removed_material_set.has(matid):
					return Rs2Decoder.err("patch-removed", "seq %d: material %d is both removed and present" % [seq, matid])

		for value: Variant in items_meta:
			var it: Dictionary = value
			var id: int = Rs2Decoder.as_int(it["id"])
			if it["commands"] != null:
				continue
			if not items.has(id):
				return Rs2Decoder.err("patch-commands", "seq %d: item %d is new but carries commands:null" % [seq, id])
			var base: Dictionary = items[id]
			var base_cv: int = Rs2Decoder.as_int(base["content_version"])
			var cur_cv: int = Rs2Decoder.as_int(it["content_version"])
			if base_cv != cur_cv:
				return Rs2Decoder.err("patch-commands", "seq %d: item %d's content_version changed but it carries commands:null" % [seq, id])
		return ""

	func _texture_entry_field_error(t: Dictionary) -> String:
		var id: int = Rs2Decoder.as_int(t["id"])
		var kind: String = t["kind"]
		var status: String = t["status"]
		var tag: String = "texture %d: " % id
		if status == "freed":
			if t["hash"] != null or t["format"] != null or Rs2Decoder.as_int(t["width"]) != 0 or Rs2Decoder.as_int(t["height"]) != 0 or t["mipmaps"] != false or Rs2Decoder.as_int(t["payload_bytes"]) != 0 or t["canvas"] != null or t["reason"] != null:
				return tag + "a \"freed\" entry must have hash/format/canvas/reason null and width/height/payload_bytes 0, mipmaps false"
			return ""
		if kind == "image":
			if t["canvas"] != null:
				return tag + "kind \"image\" must have canvas null"
			if status == "ok":
				if t["hash"] == null or t["format"] == null or Rs2Decoder.as_int(t["width"]) < 1 or Rs2Decoder.as_int(t["height"]) < 1 or Rs2Decoder.as_int(t["payload_bytes"]) < 1 or t["reason"] != null:
					return tag + "kind \"image\" status \"ok\" needs a hex hash, a format, width/height >= 1, payload_bytes >= 1 and reason null"
			else:
				if t["hash"] != null or Rs2Decoder.as_int(t["payload_bytes"]) != 0 or t["reason"] == null:
					return tag + "kind \"image\" status \"unsupported\" needs hash null, payload_bytes 0 and a non-null reason"
			return ""
		if kind == "placeholder":
			if t["hash"] != null or t["format"] != null or Rs2Decoder.as_int(t["width"]) != 0 or Rs2Decoder.as_int(t["height"]) != 0 or t["mipmaps"] != false or Rs2Decoder.as_int(t["payload_bytes"]) != 0 or t["canvas"] != null:
				return tag + "kind \"placeholder\" must have hash/format/canvas null and width/height/payload_bytes 0, mipmaps false"
			if status == "ok" and t["reason"] != null:
				return tag + "kind \"placeholder\" status \"ok\" must have reason null"
			if status == "unsupported" and t["reason"] == null:
				return tag + "kind \"placeholder\" status \"unsupported\" must have a non-null reason"
			return ""
		# kind == "canvas"
		if t["hash"] != null or t["format"] != null or Rs2Decoder.as_int(t["width"]) != 0 or Rs2Decoder.as_int(t["height"]) != 0 or t["mipmaps"] != false or Rs2Decoder.as_int(t["payload_bytes"]) != 0 or t["canvas"] == null:
			return tag + "kind \"canvas\" must have hash/format null, width/height/payload_bytes 0, mipmaps false, and a non-null canvas"
		if status == "ok" and t["reason"] != null:
			return tag + "kind \"canvas\" status \"ok\" must have reason null"
		if status == "unsupported" and t["reason"] == null:
			return tag + "kind \"canvas\" status \"unsupported\" must have a non-null reason"
		return ""

	## render-stream-4.md "Mesh table" ("mesh-entry"): the same shape rule
	## _texture_entry_field_error() checks, mirrored for a mesh entry's status/reason/surfaces
	## coupling (the lifted mesh dict has no "f"/custom_aabb coupling to check here).
	func _mesh_entry_field_error(m: Dictionary) -> String:
		var id: int = Rs2Decoder.as_int(m["id"])
		var status: String = m["status"]
		var tag: String = "mesh %d: " % id
		var surfaces: Array = m["surfaces"]
		if status == "freed":
			if m["reason"] != null or surfaces.size() > 0:
				return tag + "a \"freed\" entry must have reason null and surfaces []"
			return ""
		if status == "unsupported":
			if m["reason"] == null or surfaces.size() > 0:
				return tag + "an \"unsupported\" entry needs a non-null reason and surfaces []"
			return ""
		# "ok"
		if m["reason"] != null:
			return tag + "an \"ok\" entry must have reason null"
		return ""


	## render-stream-5.md "Shader table"/"Material table" ("shader-entry"/"material-entry"):
	## status "ok" has reason null, "unsupported" has a non-null reason.
	func _shader_entry_field_error(s: Dictionary) -> String:
		var status: String = s["status"]
		var reason: Variant = s["reason"]
		if (status == "ok") != (reason == null):
			return "shader %d: \"reason\" must be null exactly for status \"ok\"" % Rs2Decoder.as_int(s["id"])
		return ""


	func _material_entry_field_error(m: Dictionary) -> String:
		var status: String = m["status"]
		var reason: Variant = m["reason"]
		if (status == "ok") != (reason == null):
			return "material %d: \"reason\" must be null exactly for status \"ok\"" % Rs2Decoder.as_int(m["id"])
		return ""

	func _check_resolved_invariants(seq: int, unsupported_meta: Array, is_v4: bool, is_v5: bool) -> String:
		var where: String = "transaction seq %d" % seq
		var canvas_ids: Dictionary[int, bool] = {}
		for id: int in canvases:
			canvas_ids[id] = true
		var item_ids: Dictionary[int, bool] = {}
		for id: int in items:
			item_ids[id] = true
		var texture_ids: Dictionary[int, bool] = {}
		for id: int in textures:
			texture_ids[id] = true
		var mesh_ids: Dictionary[int, bool] = {}
		if is_v4:
			for id: int in meshes:
				mesh_ids[id] = true
		var shader_ids: Dictionary[int, bool] = {}
		var material_ids: Dictionary[int, bool] = {}
		if is_v5:
			for id: int in shaders:
				shader_ids[id] = true
			for id: int in materials:
				material_ids[id] = true

		for id: int in textures:
			var t: Dictionary = textures[id]
			var field_error: String = _texture_entry_field_error(t)
			if field_error != "":
				return Rs2Decoder.err("texture-entry", "%s: %s" % [where, field_error])
		if is_v4:
			for id: int in meshes:
				var m0: Dictionary = meshes[id]
				var mesh_field_error: String = _mesh_entry_field_error(m0)
				if mesh_field_error != "":
					return Rs2Decoder.err("mesh-entry", "%s: %s" % [where, mesh_field_error])
		if is_v5:
			for id: int in shaders:
				var sh0: Dictionary = shaders[id]
				var shader_field_error: String = _shader_entry_field_error(sh0)
				if shader_field_error != "":
					return Rs2Decoder.err("shader-entry", "%s: %s" % [where, shader_field_error])
			for id: int in materials:
				var mat0: Dictionary = materials[id]
				var material_field_error: String = _material_entry_field_error(mat0)
				if material_field_error != "":
					return Rs2Decoder.err("material-entry", "%s: %s" % [where, material_field_error])
			# shader-ref: every material's non-null "shader" must name an entry in the resolved
			# shader table.
			for id: int in materials:
				var mat1: Dictionary = materials[id]
				var mat_shader: Variant = mat1["shader"]
				if mat_shader != null and not shader_ids.has(Rs2Decoder.as_int(mat_shader)):
					return Rs2Decoder.err("shader-ref", "%s: material %d names shader %d, which has no entry" % [where, id, Rs2Decoder.as_int(mat_shader)])
			# material-ref: every item's non-null "material" must name an entry in the resolved
			# material table.
			for id: int in items:
				var item_for_material: Dictionary = items[id]
				if not item_for_material.has("material"):
					continue
				var item_material: Variant = item_for_material["material"]
				if item_material != null and not material_ids.has(Rs2Decoder.as_int(item_material)):
					return Rs2Decoder.err("material-ref", "%s: item %d names material %d, which has no entry" % [where, id, Rs2Decoder.as_int(item_material)])
			# canvas-offset itself (canvas_f32 must carry 10 floats per canvas) is checked earlier,
			# in _accept_transaction(), alongside cmd-offset/mesh-offset/param-offset.

		var roots: Array[int] = []
		for id: int in canvases:
			var canvas: Dictionary = canvases[id]
			if canvas["role"] != null:
				roots.append(id)
		if roots.size() != 1 or roots[0] != 1:
			return Rs2Decoder.err("root-canvas", "%s: expected exactly one canvas with role root and id 1" % where)

		var claimed: Dictionary[String, Array] = {}
		for id: int in items:
			var item: Dictionary = items[id]
			var parent: Variant = item["parent"]
			if parent == null:
				continue
			var link: Dictionary = parent
			var kind: String = link["kind"]
			var target: int = Rs2Decoder.as_int(link["id"])
			var exists: bool = canvas_ids.has(target) if kind == "canvas" else item_ids.has(target)
			if not exists:
				return Rs2Decoder.err("dangling-parent", "%s: item %d names parent %s %d, which does not exist" % [where, id, kind, target])
			var key: String = "%s:%d" % [kind, target]
			var list: Array = claimed.get(key, [])
			list.append(id)
			claimed[key] = list
		for id: int in canvases:
			var canvas_for_check: Dictionary = canvases[id]
			var declared_items: Array = canvas_for_check["items"]
			var claimed_canvas_list: Array = claimed.get("canvas:%d" % id, [])
			if not _same_id_set(declared_items, claimed_canvas_list):
				return Rs2Decoder.err("child-list-mismatch", "%s: canvas %d's items[] disagrees with items' parent fields" % [where, id])
		for id: int in items:
			var item_for_check: Dictionary = items[id]
			var declared_children: Array = item_for_check["children"]
			var claimed_item_list: Array = claimed.get("item:%d" % id, [])
			if not _same_id_set(declared_children, claimed_item_list):
				return Rs2Decoder.err("child-list-mismatch", "%s: item %d's children[] disagrees with items' parent fields" % [where, id])

		for id: int in items:
			var seen: Dictionary[int, bool] = {}
			var cursor: int = id
			while true:
				if seen.has(cursor):
					return Rs2Decoder.err("parent-cycle", "%s: following parents from item %d revisits item %d" % [where, id, cursor])
				seen[cursor] = true
				var cur_item: Dictionary = items[cursor]
				var parent: Variant = cur_item["parent"]
				if parent == null:
					break
				var parent_link: Dictionary = parent
				if parent_link["kind"] != "item":
					break
				cursor = Rs2Decoder.as_int(parent_link["id"])

		# texture-ref: every command's non-null tex, and every canvas texture's non-null diffuse,
		# must name an existing table entry; a diffuse must name an image or placeholder.
		# render-stream-4.md "Command": every new /4 op that carries a "tex" field follows the
		# same rule as the existing texture-rect ops.
		var tex_bearing_ops: Dictionary[String, bool] = {
			"add_texture_rect": true, "add_texture_rect_region": true,
			"add_msdf_texture_rect_region": true, "add_primitive": true, "add_polygon": true,
			"add_triangle_array": true, "add_nine_patch": true, "add_mesh": true,
		}
		for id: int in items:
			var item: Dictionary = items[id]
			var commands: Array = item["commands"]
			for value: Variant in commands:
				var command: Dictionary = value
				var op: String = command["op"]
				if not tex_bearing_ops.has(op):
					continue
				var tex: Variant = command["tex"]
				if tex == null:
					continue
				if not texture_ids.has(Rs2Decoder.as_int(tex)):
					return Rs2Decoder.err("texture-ref", "%s: item %d's %s names texture %d, which has no entry" % [where, id, op, Rs2Decoder.as_int(tex)])
		for id: int in textures:
			var t: Dictionary = textures[id]
			var canvas_info: Variant = t["canvas"]
			if canvas_info == null:
				continue
			var canvas_dict: Dictionary = canvas_info
			var diffuse: Variant = canvas_dict["diffuse"]
			if diffuse == null:
				continue
			var diffuse_id: int = Rs2Decoder.as_int(diffuse)
			if not texture_ids.has(diffuse_id):
				return Rs2Decoder.err("texture-ref", "%s: canvas texture %d's diffuse names texture %d, which has no entry" % [where, id, diffuse_id])
			var diffuse_entry: Dictionary = textures[diffuse_id]
			if diffuse_entry["kind"] != "image" and diffuse_entry["kind"] != "placeholder":
				return Rs2Decoder.err("texture-ref", "%s: canvas texture %d's diffuse names texture %d, whose kind is %s (must be image or placeholder)" % [where, id, diffuse_id, diffuse_entry["kind"]])

		# mesh-ref (render-stream-4.md "Mesh table"): every add_mesh command's "mesh" id must name
		# an entry present in the resolved mesh table (any status -- a "freed" tombstone counts).
		if is_v4:
			for id: int in items:
				var item2: Dictionary = items[id]
				var commands2: Array = item2["commands"]
				for value: Variant in commands2:
					var command2: Dictionary = value
					if command2["op"] != "add_mesh":
						continue
					var mesh_id: int = Rs2Decoder.as_int(command2["mesh"])
					if not mesh_ids.has(mesh_id):
						return Rs2Decoder.err("mesh-ref", "%s: item %d's add_mesh names mesh %d, which has no entry" % [where, id, mesh_id])

		# Invariant 9: draw-index ties.
		var expected_tie_items: Dictionary[int, bool] = {}
		var containers: Array[Array] = []
		for id: int in canvases:
			var canvas: Dictionary = canvases[id]
			var canvas_items: Array = canvas["items"]
			containers.append(canvas_items)
		for id: int in items:
			var item_for_children: Dictionary = items[id]
			var item_children: Array = item_for_children["children"]
			containers.append(item_children)
		for container: Array in containers:
			var by_draw_index: Dictionary[int, Array] = {}
			for value: Variant in container:
				var child_id: int = value
				if not items.has(child_id):
					continue
				var child: Dictionary = items[child_id]
				var di: int = Rs2Decoder.as_int(child["draw_index"])
				var list: Array = by_draw_index.get(di, [])
				list.append(child_id)
				by_draw_index[di] = list
			for di: int in by_draw_index:
				var group: Array = by_draw_index[di]
				var drawing: Array[int] = []
				for value: Variant in group:
					var child_id: int = value
					var child: Dictionary = items[child_id]
					var commands: Array = child["commands"]
					var children: Array = child["children"]
					if commands.size() > 0 or children.size() > 0:
						drawing.append(child_id)
				if drawing.size() >= 2:
					var smallest: int = drawing[0]
					for id: int in drawing:
						smallest = mini(smallest, id)
					expected_tie_items[smallest] = true

		# Expected derived unsupported[] entries.
		var actual_unsupported_ops: Dictionary[String, String] = {}  # "item:op" -> reason
		var actual_unsupported_texture: Dictionary[String, bool] = {}  # "item:rs_method" -> true
		var actual_unsupported_mesh: Dictionary[String, bool] = {}  # "item:canvas_item_add_mesh" -> true
		# new at /5 (render-stream-5.md "Derived item-level entries"): unsupported-material is the
		# only one of the three new derived reasons that is independently reconstructable from the
		# resolved state (an item's EFFECTIVE material -- gate5_5-design.md D9, effective_material()
		# -- is unsupported, names an unsupported shader, or names a texture parameter or default
		# texture whose entry is unsupported).
		# unknown-material and the instance param-type entry describe a value the wire could not
		# represent at all, so there is no independent "actual" signal for them -- those two are
		# checked forward-only in the per-entry loop below.
		var actual_unsupported_material: Dictionary[String, bool] = {}  # "item:canvas_item_set_material" -> true
		if is_v5:
			for id: int in items:
				var item_for_mat: Dictionary = items[id]
				if not item_for_mat.has("material"):
					continue
				var mat_ref: Variant = Rs2Decoder.effective_material(id, items)
				if mat_ref == null:
					continue
				var mat_id: int = Rs2Decoder.as_int(mat_ref)
				if not materials.has(mat_id):
					continue
				var mat: Dictionary = materials[mat_id]
				var unsupported: bool = mat["status"] == "unsupported"
				var mat_shader: Variant = mat["shader"]
				if not unsupported and mat_shader != null:
					var shader_id: int = Rs2Decoder.as_int(mat_shader)
					if shaders.has(shader_id):
						var shader_entry: Dictionary = shaders[shader_id]
						if shader_entry["status"] == "unsupported":
							unsupported = true
						var default_textures: Array = shader_entry["default_textures"]
						for dvalue: Variant in default_textures:
							var dtex: Dictionary = dvalue
							var dtex_id: int = Rs2Decoder.as_int(dtex["tex"])
							if textures.has(dtex_id):
								var dtex_entry: Dictionary = textures[dtex_id]
								if dtex_entry["status"] == "unsupported":
									unsupported = true
				var mat_params: Array = mat["params"]
				for pvalue: Variant in mat_params:
					var p: Dictionary = pvalue
					if p["type"] != "rid":
						continue
					var pvalue_variant: Variant = p["value"]
					if pvalue_variant == null:
						continue
					var pvalue_dict: Dictionary = pvalue_variant
					var ptex_id: int = Rs2Decoder.as_int(pvalue_dict["tex"])
					if textures.has(ptex_id):
						var ptex_entry: Dictionary = textures[ptex_id]
						if ptex_entry["status"] == "unsupported":
							unsupported = true
				if unsupported:
					actual_unsupported_material["%d:canvas_item_set_material" % id] = true
		for id: int in items:
			var item: Dictionary = items[id]
			var commands: Array = item["commands"]
			var seen_ops: Dictionary[String, bool] = {}
			for value: Variant in commands:
				var command: Dictionary = value
				var op: String = command["op"]
				if op == "unsupported":
					var name: String = command["name"]
					if not seen_ops.has(name):
						seen_ops[name] = true
						var cmd_reason: String = command["reason"]
						var reason: String = cmd_reason if (cmd_reason == "unknown-texture" or cmd_reason == "canvas-texture-headless" or cmd_reason == "unknown-mesh" or cmd_reason == "skinned-geometry") else "unsupported-op"
						actual_unsupported_ops["%d:%s" % [id, name]] = reason
				elif tex_bearing_ops.has(op) and command["tex"] != null:
					# NOTE: an early "continue" here would also skip the add_mesh check below
					# (same loop iteration) -- this branch only ever falls through, never
					# continues, so it stays a plain "if" inside the "elif".
					var tex: Variant = command["tex"]
					var target_id: int = Rs2Decoder.as_int(tex)
					if textures.has(target_id):
						var target: Dictionary = textures[target_id]
						var unsupported_via_diffuse: bool = false
						if target["kind"] == "canvas" and target["canvas"] != null:
							var canvas_dict2: Dictionary = target["canvas"]
							var diffuse: Variant = canvas_dict2["diffuse"]
							if diffuse != null and textures.has(Rs2Decoder.as_int(diffuse)):
								var diffuse_entry2: Dictionary = textures[Rs2Decoder.as_int(diffuse)]
								unsupported_via_diffuse = diffuse_entry2["status"] == "unsupported"
						if target["status"] == "unsupported" or unsupported_via_diffuse:
							# The derived entry's `op` is the RenderingServer method name, not
							# the wire command's own op (render-stream-2.md "Item-level
							# unsupported entries").
							var rs_method: String = Rs2Decoder._rs_method_for_op(op)
							actual_unsupported_texture["%d:%s" % [id, rs_method]] = true
				if is_v4 and op == "add_mesh":
					var mesh_id2: Variant = command["mesh"]
					var mtarget_id: int = Rs2Decoder.as_int(mesh_id2)
					if meshes.has(mtarget_id):
						var mtarget: Dictionary = meshes[mtarget_id]
						if mtarget["status"] == "unsupported":
							actual_unsupported_mesh["%d:canvas_item_add_mesh" % id] = true

		var last_item: int = -1
		var last_op: String = ""
		var item_level_started: bool = false
		var declared_unsupported_ops: Dictionary[String, bool] = {}
		var declared_tie_items: Dictionary[int, bool] = {}
		var declared_unsupported_texture: Dictionary[String, bool] = {}
		var declared_unsupported_mesh: Dictionary[String, bool] = {}
		var declared_unsupported_material: Dictionary[String, bool] = {}
		for value: Variant in unsupported_meta:
			var entry: Dictionary = value
			var op: String = entry["op"]
			var reason: String = entry["reason"]
			if entry["item"] == null:
				if item_level_started:
					return Rs2Decoder.err("unsupported-mismatch", "%s: session-level entry %s follows an item-level entry" % [where, op])
				# new at /5: the sticky canvas-light entry (gate5_5-design.md D10) has no
				# independent "actual" signal to cross-check against -- forward-only
				# (well-formedness) is all this validator can do.
				if reason == "canvas-light" and op != "canvas_light_attach_to_canvas":
					return Rs2Decoder.err("unsupported-mismatch", "%s: canvas-light entry names op %s, expected canvas_light_attach_to_canvas" % [where, op])
				continue
			item_level_started = true
			var item_id: int = Rs2Decoder.as_int(entry["item"])
			if not item_ids.has(item_id):
				return Rs2Decoder.err("dangling-parent", "%s: unsupported entry names item %d, which does not exist" % [where, item_id])
			if item_id < last_item or (item_id == last_item and op <= last_op):
				return Rs2Decoder.err("unsupported-mismatch", "%s: unsupported entry (%d, %s) is out of order or repeated" % [where, item_id, op])
			last_item = item_id
			last_op = op
			if reason == "unsupported-op" or reason == "unknown-texture" or reason == "canvas-texture-headless" or reason == "unknown-mesh" or reason == "skinned-geometry":
				var pair: String = "%d:%s" % [item_id, op]
				if not actual_unsupported_ops.has(pair) or actual_unsupported_ops[pair] != reason:
					return Rs2Decoder.err("unsupported-mismatch", "%s: %s entry (%d, %s) has no matching command" % [where, reason, item_id, op])
				declared_unsupported_ops[pair] = true
			elif reason == "draw-index-tie":
				if op != "canvas_item_set_draw_index":
					return Rs2Decoder.err("unsupported-mismatch", "%s: draw-index-tie entry for item %d names op %s, expected canvas_item_set_draw_index" % [where, item_id, op])
				if not expected_tie_items.has(item_id):
					return Rs2Decoder.err("unsupported-mismatch", "%s: draw-index-tie entry for item %d does not correspond to an actual tie" % [where, item_id])
				declared_tie_items[item_id] = true
			elif reason == "unsupported-state":
				# unsupported-state covers canvas_item_set_material (/2-/4) and, new at /4,
				# calibrator-7's canvas_item_attach_skeleton. render-stream-5.md "Derived
				# item-level entries": /4's unsupported-state for canvas_item_set_material no
				# longer occurs at /5 (superseded by item-level material state), and /5 decoders
				# reject it.
				if is_v5 and op == "canvas_item_set_material":
					return Rs2Decoder.err("unsupported-mismatch", "%s: unsupported-state entry for item %d names canvas_item_set_material, which /5 decoders reject (superseded by unsupported-material/unknown-material)" % [where, item_id])
				if op != "canvas_item_set_material" and op != "canvas_item_attach_skeleton":
					return Rs2Decoder.err("unsupported-mismatch", "%s: unsupported-state entry for item %d names %s, expected canvas_item_set_material or canvas_item_attach_skeleton" % [where, item_id, op])
			elif reason == "unsupported-texture":
				var pair2: String = "%d:%s" % [item_id, op]
				if not actual_unsupported_texture.has(pair2):
					return Rs2Decoder.err("unsupported-mismatch", "%s: unsupported-texture entry (%d, %s) does not correspond to a command naming an unsupported texture" % [where, item_id, op])
				declared_unsupported_texture[pair2] = true
			elif reason == "unsupported-mesh":
				var pair3: String = "%d:%s" % [item_id, op]
				if not actual_unsupported_mesh.has(pair3):
					return Rs2Decoder.err("unsupported-mismatch", "%s: unsupported-mesh entry (%d, %s) does not correspond to an add_mesh naming an unsupported mesh" % [where, item_id, op])
				declared_unsupported_mesh[pair3] = true
			elif reason == "unsupported-material":
				if op != "canvas_item_set_material":
					return Rs2Decoder.err("unsupported-mismatch", "%s: unsupported-material entry for item %d names %s, expected canvas_item_set_material" % [where, item_id, op])
				var pair4: String = "%d:%s" % [item_id, op]
				if not actual_unsupported_material.has(pair4):
					return Rs2Decoder.err("unsupported-mismatch", "%s: unsupported-material entry (%d, %s) does not correspond to an item whose effective material is unsupported" % [where, item_id, op])
				declared_unsupported_material[pair4] = true
			elif reason == "unknown-material":
				# No independent "actual" signal exists for this reason: forward-only. The
				# referenced item's resolved "material" must be null, matching Q3b's "an unknown
				# non-null RID -> material: null".
				if op != "canvas_item_set_material":
					return Rs2Decoder.err("unsupported-mismatch", "%s: unknown-material entry for item %d names %s, expected canvas_item_set_material" % [where, item_id, op])
				if items.has(item_id):
					var item_for_unknown: Dictionary = items[item_id]
					if item_for_unknown.has("material") and item_for_unknown["material"] != null:
						return Rs2Decoder.err("unsupported-mismatch", "%s: unknown-material entry for item %d, whose resolved material is non-null" % [where, item_id])
			elif reason == "param-type":
				# Likewise forward-only: an instance parameter of an unsupported type is never
				# carried in instance_params at all.
				if op != "canvas_item_set_instance_shader_parameter":
					return Rs2Decoder.err("unsupported-mismatch", "%s: param-type entry for item %d names %s, expected canvas_item_set_instance_shader_parameter" % [where, item_id, op])
		for pair: String in actual_unsupported_ops:
			if not declared_unsupported_ops.has(pair):
				return Rs2Decoder.err("unsupported-mismatch", "%s: %s command (%s) has no matching unsupported[] entry" % [where, actual_unsupported_ops[pair], pair.replace(":", ", ")])
		for id: int in expected_tie_items:
			if not declared_tie_items.has(id):
				return Rs2Decoder.err("unsupported-mismatch", "%s: items tie on draw_index under item/canvas with smallest id %d, but no draw-index-tie entry is declared" % [where, id])
		for pair: String in actual_unsupported_texture:
			if not declared_unsupported_texture.has(pair):
				return Rs2Decoder.err("unsupported-mismatch", "%s: tex-bearing command (%s) names an unsupported texture, with no unsupported-texture entry" % [where, pair.replace(":", ", ")])
		if is_v4:
			for pair: String in actual_unsupported_mesh:
				if not declared_unsupported_mesh.has(pair):
					return Rs2Decoder.err("unsupported-mismatch", "%s: add_mesh command (%s) names an unsupported mesh, with no unsupported-mesh entry" % [where, pair.replace(":", ", ")])
		if is_v5:
			for pair: String in actual_unsupported_material:
				if not declared_unsupported_material.has(pair):
					return Rs2Decoder.err("unsupported-mismatch", "%s: item (%s)'s effective material is unsupported, with no unsupported-material entry" % [where, pair.replace(":", ", ")])
		return ""

	static func _same_id_set(declared: Array, claimed: Array) -> bool:
		if declared.size() != claimed.size():
			return false
		var declared_set: Dictionary[int, bool] = {}
		for value: Variant in declared:
			var id: int = Rs2Decoder.as_int(value)
			if declared_set.has(id):
				return false
			declared_set[id] = true
		for value: Variant in claimed:
			var id: int = value
			if not declared_set.has(id):
				return false
		return true
