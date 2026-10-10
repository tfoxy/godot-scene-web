extends RefCounted
## The gate 5 mesh oracle (../../protocol/gate5-design.md "Q6e", `render-stream-gate5-meshes/1`).
##
## Runs on reference legs only (gate5_mesh.gd refuses it when a GRC_* capture variable is set). At
## each settle frame, after the fixture's own mesh calls of that frame, it writes one JSON line:
## `step`, `frame` and, per fixture mesh by name in creation order, its status (`live`, `freed`
## or `absent`, which the fixture knows) and for a live one `surface_count`, the custom AABB and
## per surface `{primitive, format, vertex_count, index_count, sha256}`, where `sha256` is the
## `render-stream-mesh/1` (GRM1) hash of what `RenderingServer.mesh_get_surface` returns: on GLES3
## the reference's own GPU buffers read back with glMapBufferRange
## (drivers/gles3/storage/mesh_storage.cpp:614-669). The GRM1 layout is capture/src/
## rs_mesh_payload.cpp's (protocol/render-stream-4.md "Mesh payload").
##
## Polygon2D keeps its mesh RID private. The oracle derives it from the RID allocator's scheme
## (core/templates/rid_owner.h:160-175: id = validator << 32 | slot, validator = 1 + a global
## counter): Polygon2D's constructor calls mesh_create right after CanvasItem's canvas_item_create
## (scene/2d/polygon_2d.cpp:727), so its validator is the item's + 1, and its slot follows the
## previous fixture mesh's. Every line says whether the derived RID read back as the polygon the
## fixture set (`p2_rid_verified`); the checker requires it.

const PRIMITIVES: Array[String] = ["points", "lines", "line_strip", "triangles", "triangle_strip"]
const GRM1_MAGIC: Array[int] = [0x47, 0x52, 0x4D, 0x31, 0x0D, 0x0A, 0x1A, 0x0A]

var _file: FileAccess


func open(path: String) -> bool:
	_file = FileAccess.open(path, FileAccess.WRITE)
	return _file != null


## The RID Polygon2D's constructor made right after `item` (see above), given the slot of the
## fixture mesh created just before it.
static func derive_polygon_mesh(item: RID, previous_mesh: RID) -> RID:
	var validator: int = (item.get_id() >> 32) + 1
	var slot: int = (previous_mesh.get_id() & 0xFFFFFFFF) + 1
	return rid_from_int64((validator << 32) | slot)


## One line. `meshes` holds, in creation order, {name: String, status: String, rid: RID}.
## `p2_points` are the points Polygon2D was last given, for the RID check.
func record(step: int, frame: int, meshes: Array[Dictionary], p2_name: String, p2_points: PackedVector2Array) -> void:
	var out: Array = []
	var p2_verified: bool = false
	for entry: Dictionary in meshes:
		var name: String = entry["name"]
		var status: String = entry["status"]
		if status != "live":
			out.append({"name": name, "status": status})
			continue
		var rid: RID = entry["rid"]
		var count: int = RenderingServer.mesh_get_surface_count(rid)
		var aabb: AABB = RenderingServer.mesh_get_custom_aabb(rid)
		var surfaces: Array = []
		for s: int in range(count):
			var d: Dictionary = RenderingServer.mesh_get_surface(rid, s)
			surfaces.append(_surface_view(d))
			if name == p2_name and s == 0:
				var vertex_data: PackedByteArray = d.get("vertex_data", PackedByteArray())
				p2_verified = vertex_data == p2_points.to_byte_array()
		out.append({
			"name": name,
			"status": status,
			"surface_count": count,
			"custom_aabb": [aabb.position.x, aabb.position.y, aabb.position.z, aabb.size.x, aabb.size.y, aabb.size.z],
			"surfaces": surfaces,
		})
	var line: Dictionary = {
		"schema": "render-stream-gate5-meshes/1",
		"step": step,
		"frame": frame,
		"p2_rid_verified": p2_verified,
		"meshes": out,
	}
	_file.store_line(JSON.stringify(line, "", false, true))
	_file.flush()


static func _surface_view(d: Dictionary) -> Dictionary:
	var primitive: int = d.get("primitive", -1)
	var format: int = d.get("format", 0)
	var vertex_count: int = d.get("vertex_count", 0)
	var index_count: int = d.get("index_count", 0)
	return {
		"primitive": PRIMITIVES[primitive] if primitive >= 0 and primitive < PRIMITIVES.size() else str(primitive),
		"format": format,
		"vertex_count": vertex_count,
		"index_count": index_count,
		"sha256": _sha256(grm1(d)),
	}


static func _sha256(bytes: PackedByteArray) -> String:
	var ctx: HashingContext = HashingContext.new()
	ctx.start(HashingContext.HASH_SHA256)
	ctx.update(bytes)
	return ctx.finish().hex_encode()


## The render-stream-mesh/1 payload of a `mesh_get_surface` dictionary.
static func grm1(d: Dictionary) -> PackedByteArray:
	var primitive: int = d.get("primitive", -1)
	var format: int = d.get("format", 0)
	var vertex_count: int = d.get("vertex_count", 0)
	var index_count: int = d.get("index_count", 0)
	var vertex_data: PackedByteArray = d.get("vertex_data", PackedByteArray())
	var attribute_data: PackedByteArray = d.get("attribute_data", PackedByteArray())
	var skin_data: PackedByteArray = d.get("skin_data", PackedByteArray())
	var index_data: PackedByteArray = d.get("index_data", PackedByteArray())
	var aabb: AABB = d.get("aabb", AABB())
	var uv_scale: Vector4 = d.get("uv_scale", Vector4())
	var name: String = PRIMITIVES[primitive] if primitive >= 0 and primitive < PRIMITIVES.size() else ""
	var meta: String = "{\"type\":\"mesh-surface\",\"primitive\":\"%s\",\"format\":%d,\"vertex_count\":%d,\"index_count\":%d,\"vertex_bytes\":%d,\"attribute_bytes\":%d,\"skin_bytes\":%d,\"index_bytes\":%d}" % [
		name, format, vertex_count, index_count, vertex_data.size(), attribute_data.size(), skin_data.size(), index_data.size()
	]
	var meta_bytes: PackedByteArray = meta.to_utf8_buffer()
	var out: PackedByteArray = PackedByteArray(GRM1_MAGIC)
	var head: PackedByteArray = PackedByteArray()
	head.resize(4)
	head.encode_u32(0, meta_bytes.size())
	out.append_array(head)
	out.append_array(meta_bytes)
	var geometry: PackedByteArray = PackedByteArray()
	geometry.resize(40)
	var values: Array[float] = [aabb.position.x, aabb.position.y, aabb.position.z, aabb.size.x, aabb.size.y, aabb.size.z, uv_scale.x, uv_scale.y, uv_scale.z, uv_scale.w]
	for k: int in range(values.size()):
		geometry.encode_float(k * 4, values[k])
	out.append_array(geometry)
	out.append_array(vertex_data)
	out.append_array(attribute_data)
	out.append_array(skin_data)
	out.append_array(index_data)
	return out
