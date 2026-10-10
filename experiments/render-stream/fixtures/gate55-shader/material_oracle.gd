extends RefCounted
## The gate 5.5 material oracle (../../protocol/gate5_5-design.md "Q6e",
## `render-stream-gate55-materials/1`).
##
## Runs on reference legs only (gate55_shader.gd refuses it when a GRC_* capture variable is set).
## At each settle frame, after the fixture's own calls of that frame, it writes one JSON line:
##   - per fixture `Shader`, by name in creation order: its status (`live`, `freed` or `absent`,
##     which the fixture knows) and for a live one the `render-stream-shader/1` (GRP1) SHA-256 and
##     size of `RenderingServer.shader_get_code(shader.get_rid())`. GLES3 keeps the code the server
##     received (drivers/gles3/storage/material_storage.cpp:2204, :2288-2292): the preprocessed code,
##     `@@>`/`@@<` include markers and all, which is exactly what the capture's hook has to copy.
##   - per fixture material: the Variant type and value of `RenderingServer.material_get_param` for
##     each name the fixture declares (GLES3 returns the stored value, `material_storage.cpp:2475`).
##   - per fixture item with instance parameters: `canvas_item_get_instance_shader_parameter`.
## A texture value is named by fixture name, by matching RIDs. Floats are written in full
## precision; Color and Vector components are float32 widened to double.
##
## It also writes each distinct code it reads as a GRP1 file under `<log dir>/shader-library/
## sha256/<hash>.grp` (G55e's `params` policy leg builds its receiver library from these dumps,
## never from the capture). Synthetic fixture shaders only, under ignored artifacts/.

const GRP1_MAGIC: Array[int] = [0x47, 0x52, 0x50, 0x31, 0x0D, 0x0A, 0x1A, 0x0A]

var _file: FileAccess
var _library: String = ""


func open(path: String) -> bool:
	_file = FileAccess.open(path, FileAccess.WRITE)
	if _file == null:
		return false
	_library = path.get_base_dir().path_join("shader-library").path_join("sha256")
	return DirAccess.make_dir_recursive_absolute(_library) == OK


## One line. `shaders`: {name, status, shader: Shader}; `materials`: {name, status, material:
## Material, params: Array[String]}; `items`: {name, item: CanvasItem, params: Array[String]};
## `textures`: texture name -> RID.
func record(step: int, frame: int, shaders: Array[Dictionary], materials: Array[Dictionary], items: Array[Dictionary], textures: Dictionary) -> void:
	var shader_out: Array = []
	for entry: Dictionary in shaders:
		var name: String = entry["name"]
		var status: String = entry["status"]
		if status != "live":
			shader_out.append({"name": name, "status": status})
			continue
		var shader: Shader = entry["shader"]
		var code: String = RenderingServer.shader_get_code(shader.get_rid())
		var payload: PackedByteArray = grp1(code)
		var digest: String = _sha256(payload)
		_store(digest, payload)
		shader_out.append({
			"name": name,
			"status": status,
			"code_bytes": code.to_utf8_buffer().size(),
			"payload_bytes": payload.size(),
			"include_markers": code.contains("@@>"),
			"sha256": digest,
		})
	var material_out: Array = []
	for entry: Dictionary in materials:
		var name: String = entry["name"]
		var status: String = entry["status"]
		if status != "live":
			material_out.append({"name": name, "status": status})
			continue
		var material: Material = entry["material"]
		var rid: RID = material.get_rid()
		var declared: Array = entry["params"]
		var names: Array[String] = []
		names.assign(declared)
		var params: Array = []
		for param: String in names:
			var view: Dictionary = variant_view(RenderingServer.material_get_param(rid, param), textures)
			view["name"] = param
			params.append(view)
		material_out.append({"name": name, "status": status, "params": params})
	var item_out: Array = []
	for entry: Dictionary in items:
		var name: String = entry["name"]
		var item: CanvasItem = entry["item"]
		var declared: Array = entry["params"]
		var names: Array[String] = []
		names.assign(declared)
		var params: Array = []
		for param: String in names:
			var view: Dictionary = variant_view(RenderingServer.canvas_item_get_instance_shader_parameter(item.get_canvas_item(), param), textures)
			view["name"] = param
			params.append(view)
		item_out.append({"name": name, "instance_params": params})
	var line: Dictionary = {
		"schema": "render-stream-gate55-materials/1",
		"step": step,
		"frame": frame,
		"shaders": shader_out,
		"materials": material_out,
		"items": item_out,
	}
	_file.store_line(JSON.stringify(line, "", false, true))
	_file.flush()


## {type, value}: the Variant type in snake case and its components (floats widened to double).
static func variant_view(v: Variant, textures: Dictionary) -> Dictionary:
	match typeof(v):
		TYPE_NIL:
			return {"type": "nil", "value": null}
		TYPE_BOOL:
			var b: bool = v
			return {"type": "bool", "value": b}
		TYPE_INT:
			var i: int = v
			return {"type": "int", "value": i}
		TYPE_FLOAT:
			var x: float = v
			return {"type": "float", "value": x}
		TYPE_VECTOR2:
			var v2: Vector2 = v
			return {"type": "vector2", "value": [v2.x, v2.y]}
		TYPE_VECTOR2I:
			var v2i: Vector2i = v
			return {"type": "vector2i", "value": [v2i.x, v2i.y]}
		TYPE_VECTOR3:
			var v3: Vector3 = v
			return {"type": "vector3", "value": [v3.x, v3.y, v3.z]}
		TYPE_VECTOR4:
			var v4: Vector4 = v
			return {"type": "vector4", "value": [v4.x, v4.y, v4.z, v4.w]}
		TYPE_COLOR:
			var c: Color = v
			return {"type": "color", "value": [c.r, c.g, c.b, c.a]}
		TYPE_RID:
			var rid: RID = v
			var found: String = "?"
			for name: String in textures:
				var candidate: RID = textures[name]
				if candidate == rid:
					found = name
			return {"type": "rid", "value": {"tex": found}}
		TYPE_PACKED_FLOAT32_ARRAY:
			var a: PackedFloat32Array = v
			var out: Array = []
			for e: float in a:
				out.append(e)
			return {"type": "packed_float32_array", "value": out}
	return {"type": type_string(typeof(v)), "value": str(v)}


## The render-stream-shader/1 payload of a code string (protocol/gate5_5-design.md Q4).
static func grp1(code: String) -> PackedByteArray:
	var data: PackedByteArray = code.to_utf8_buffer()
	var meta: PackedByteArray = ("{\"type\":\"shader-code\",\"code_bytes\":%d}" % data.size()).to_utf8_buffer()
	var out: PackedByteArray = PackedByteArray(GRP1_MAGIC)
	var head: PackedByteArray = PackedByteArray()
	head.resize(4)
	head.encode_u32(0, meta.size())
	out.append_array(head)
	out.append_array(meta)
	out.append_array(data)
	return out


static func _sha256(bytes: PackedByteArray) -> String:
	var ctx: HashingContext = HashingContext.new()
	ctx.start(HashingContext.HASH_SHA256)
	ctx.update(bytes)
	return ctx.finish().hex_encode()


func _store(digest: String, payload: PackedByteArray) -> void:
	var path: String = _library.path_join(digest + ".grp")
	if FileAccess.file_exists(path):
		return
	var out: FileAccess = FileAccess.open(path, FileAccess.WRITE)
	if out != null:
		out.store_buffer(payload)
