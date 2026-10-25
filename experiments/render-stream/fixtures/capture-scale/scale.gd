extends Node2D
## Capture-scale fixture (P3-CAP): a game-sized canvas built straight on the RenderingServer, so the
## capture's per-frame cost can be measured at the scale of a shipped game from the stock template.
## Every count is an environment knob (defaults in brackets, the shape C3 measured in a real game's
## combat scene):
##
##   RS_SCALE_ITEMS [4200]        canvas items, in chains of 10 (depth up to 10) under this node's item
##   RS_SCALE_TEXTURES [700]      resident ImageTextures, each a distinct solid colour (distinct
##                                content hash), RS_SCALE_TEX_W x RS_SCALE_TEX_H [640x512] RGBA8:
##                                about 0.9 GB decoded at the defaults
##   RS_SCALE_FLOAT_TEXTURES [800] small RGBF textures (64x8): unsupported-format table entries
##   RS_SCALE_DRAWN_TEXTURES [170] how many of them an item draws (add_texture_rect); the rest are
##                                resident but undrawn, like a preloaded atlas
##   RS_SCALE_MESHES [187]        meshes, each drawn by one item (add_mesh over a texture)
##   RS_SCALE_MESH_VERTS [24]     vertices per mesh (a 6x4 grid, two triangles per cell)
##   RS_SCALE_MESH_UPDATES [76]   meshes updated every frame (round robin), the way a skeletal
##                                animation runtime does: vertex region, attribute region, custom
##                                AABB, then the item's material set again -- one new mesh payload
##                                each (76 per frame is ~1,700 per second at 23 fps)
##   RS_SCALE_CMDS [4]            extra add_rect commands on every drawing item
##   RS_SCALE_SHADERS [32] RS_SCALE_MATERIALS [560]  canvas_item ShaderMaterials, set on the first
##                                drawing items; every other one also gets a String parameter
##                                (unsupported param-type)
##   RS_SCALE_PARAMS [64]         float uniforms per material (named like a particle material's,
##                                over 15 characters), each set with material_set_param
##   RS_SCALE_PARAM_UPDATES [8]   material_set_param calls per frame (round robin over materials)
##   RS_SCALE_MOVERS [100]        items whose transform changes every frame
##   RS_FIXTURE_QUIT_FRAME [600]  quit after this many frames
##   RS_SCALE_WARMUP [120]        frames before the frame-time window opens
##   RS_SCALE_REPORT              optional absolute path: the frame-time summary (JSON) at quit
##
## The capture is loaded by loader.gd (RS_FIXTURE_ARM=born arms before any of this exists, the
## product's arm-at-init path; late arms at RS_FIXTURE_ARM_FRAME and adopts it). The scene does not
## know about the capture: armed and unarmed runs execute the same calls.

var _items: Array[RID] = []
var _meshes: Array[RID] = []
var _textures: Array[ImageTexture] = []
var _shaders: Array[RID] = []
var _materials: Array[RID] = []
var _mesh_points: Array[PackedVector2Array] = []
var _movers: int = 100
var _mesh_updates: int = 76
var _mesh_items: Array[RID] = []
var _mesh_materials: Array[RID] = []
var _mesh_uvs: Array[PackedByteArray] = []
var _mesh_cursor: int = 0
var _param_updates: int = 8
var _frame: int = 0
var _quit_frame: int = 600
var _warmup: int = 120
var _window_start_us: int = 0
var _last_us: int = 0
var _deltas_us: PackedInt64Array = PackedInt64Array()
var _setup_ms: float = 0.0


func _env_int(name: String, fallback: int) -> int:
	if not OS.has_environment(name):
		return fallback
	var text: String = OS.get_environment(name).strip_edges()
	if not text.is_valid_int() or text.to_int() < 0:
		printerr("[scale] error: %s must be a non-negative integer (got %s)" % [name, JSON.stringify(text)])
		return fallback
	return text.to_int()


func _ready() -> void:
	var t0: int = Time.get_ticks_usec()
	var n_items: int = _env_int("RS_SCALE_ITEMS", 4200)
	var n_textures: int = _env_int("RS_SCALE_TEXTURES", 700)
	var tex_w: int = maxi(1, _env_int("RS_SCALE_TEX_W", 640))
	var tex_h: int = maxi(1, _env_int("RS_SCALE_TEX_H", 512))
	var n_drawn: int = mini(_env_int("RS_SCALE_DRAWN_TEXTURES", 170), n_textures)
	var n_meshes: int = _env_int("RS_SCALE_MESHES", 187)
	var mesh_verts: int = maxi(4, _env_int("RS_SCALE_MESH_VERTS", 24))
	var n_shaders: int = maxi(1, _env_int("RS_SCALE_SHADERS", 32))
	var n_materials: int = _env_int("RS_SCALE_MATERIALS", 560)
	_mesh_updates = mini(_env_int("RS_SCALE_MESH_UPDATES", 76), n_meshes)
	_movers = _env_int("RS_SCALE_MOVERS", 100)
	var n_float: int = _env_int("RS_SCALE_FLOAT_TEXTURES", 800)
	var cmds: int = _env_int("RS_SCALE_CMDS", 4)
	var n_params: int = _env_int("RS_SCALE_PARAMS", 64)
	_param_updates = _env_int("RS_SCALE_PARAM_UPDATES", 8)
	_quit_frame = maxi(2, _env_int("RS_FIXTURE_QUIT_FRAME", 600))
	_warmup = mini(_env_int("RS_SCALE_WARMUP", 120), _quit_frame - 1)

	for i: int in n_textures:
		var image: Image = Image.create_empty(tex_w, tex_h, false, Image.FORMAT_RGBA8)
		image.fill(Color8(i & 255, (i >> 8) & 255, 91, 255))
		_textures.append(ImageTexture.create_from_image(image))
	for i: int in n_float:
		var fimage: Image = Image.create_empty(64, 8, false, Image.FORMAT_RGBF)
		fimage.fill(Color(i / 1024.0, 0.5, 0.25, 1.0))
		_textures.append(ImageTexture.create_from_image(fimage))

	for s: int in n_shaders:
		var shader: RID = RenderingServer.shader_create()
		var code: String = "shader_type canvas_item;\nuniform vec4 tint : source_color = vec4(1.0);\n"
		for q: int in n_params:
			code += "uniform float particle_param_%02d = 0.0;\n" % q
		code += "void fragment() {\n\tCOLOR *= tint * %d.0 / %d.0;\n}\n" % [s + 1, s + 1]
		RenderingServer.shader_set_code(shader, code)
		_shaders.append(shader)
	for m: int in n_materials:
		var material: RID = RenderingServer.material_create()
		RenderingServer.material_set_shader(material, _shaders[m % n_shaders])
		RenderingServer.material_set_param(material, "tint", Color8(255, m & 255, 200, 255))
		for q: int in n_params:
			RenderingServer.material_set_param(material, "particle_param_%02d" % q, float(q + m))
		if m % 2 == 1:
			RenderingServer.material_set_param(material, "label", "material %d" % m)
		_materials.append(material)

	var cols: int = 6
	var rows: int = maxi(1, mesh_verts / cols - 1)
	var indices: PackedInt32Array = PackedInt32Array()
	for r: int in rows:
		for c: int in cols - 1:
			var a: int = r * cols + c
			indices.append_array([a, a + 1, a + cols, a + 1, a + cols + 1, a + cols])
	for k: int in n_meshes:
		var points: PackedVector2Array = PackedVector2Array()
		var uvs: PackedVector2Array = PackedVector2Array()
		for r: int in rows + 1:
			for c: int in cols:
				points.append(Vector2(c * 8.0, r * 8.0))
				uvs.append(Vector2(c / float(cols - 1), r / float(rows)))
		var arrays: Array = []
		arrays.resize(Mesh.ARRAY_MAX)
		arrays[Mesh.ARRAY_VERTEX] = points
		arrays[Mesh.ARRAY_TEX_UV] = uvs
		arrays[Mesh.ARRAY_INDEX] = indices
		var mesh: RID = RenderingServer.mesh_create()
		RenderingServer.mesh_add_surface_from_arrays(mesh, RenderingServer.PRIMITIVE_TRIANGLES, arrays, [], {}, RenderingServer.ARRAY_FLAG_USE_DYNAMIC_UPDATE)
		_meshes.append(mesh)
		_mesh_points.append(points)
		_mesh_uvs.append(uvs.to_byte_array())

	# Items: chains of 10 (each item the previous one's child) under this node's item; the first draw.
	var root: RID = get_canvas_item()
	var parent: RID = root
	var drawn: int = 0
	var mesh_i: int = 0
	var material_i: int = 0
	for i: int in n_items:
		var item: RID = RenderingServer.canvas_item_create()
		if i % 10 == 0:
			RenderingServer.canvas_item_set_parent(item, root)
			parent = item
		else:
			RenderingServer.canvas_item_set_parent(item, parent)
			parent = item
		RenderingServer.canvas_item_set_transform(item, Transform2D(0.0, Vector2((i * 37) % 600, (i * 23) % 330)))
		var draws: bool = false
		if mesh_i < n_meshes:
			RenderingServer.canvas_item_add_mesh(item, _meshes[mesh_i], Transform2D(), Color(1, 1, 1, 1), _textures[mesh_i % maxi(1, n_textures)].get_rid() if n_textures > 0 else RID())
			_mesh_items.append(item)
			mesh_i += 1
			draws = true
		elif drawn < n_drawn:
			RenderingServer.canvas_item_add_texture_rect(item, Rect2(0, 0, 16, 12), _textures[drawn].get_rid())
			drawn += 1
			draws = true
		if draws:
			for c: int in cmds:
				RenderingServer.canvas_item_add_rect(item, Rect2(c * 3.0, 14.0, 2.0, 2.0), Color8(c * 40, 200, 80, 255))
			if n_float > 0 and i % 50 == 0:
				# an unsupported (RGBF) texture drawn: an item-level unsupported-texture entry
				RenderingServer.canvas_item_add_texture_rect(item, Rect2(0, 20, 8, 4), _textures[n_textures + (i / 50) % n_float].get_rid())
		var material: RID = RID()
		if draws and material_i < n_materials:
			material = _materials[material_i]
			RenderingServer.canvas_item_set_material(item, material)
			material_i += 1
		if _mesh_items.size() > _mesh_materials.size():
			_mesh_materials.append(material)
		_items.append(item)
	_setup_ms = (Time.get_ticks_usec() - t0) / 1000.0
	print("[scale] setup items=%d textures=%d float_textures=%d drawn_textures=%d meshes=%d materials=%d shaders=%d setup_ms=%.1f" % [n_items, n_textures, n_float, drawn, n_meshes, n_materials, n_shaders, _setup_ms])


func _process(_delta: float) -> void:
	_frame += 1
	var now: int = Time.get_ticks_usec()
	if _frame == _warmup + 1:
		_window_start_us = now
	elif _frame > _warmup + 1:
		_deltas_us.append(now - _last_us)
	_last_us = now
	var n: int = _items.size()
	for j: int in mini(_movers, n):
		var i: int = (j * 29) % n
		var x: float = float((i * 37) % 600) + float((_frame + j) % 16)
		RenderingServer.canvas_item_set_transform(_items[i], Transform2D(0.0, Vector2(x, (i * 23) % 330)))
	var m: int = _meshes.size()
	for u: int in _mesh_updates:
		var k: int = (_mesh_cursor + u) % m
		var points: PackedVector2Array = _mesh_points[k]
		for v: int in points.size():
			points[v] = Vector2(points[v].x, (v / 6) * 8.0 + float((_frame + v + k) % 5) + _frame * 0.001 + k * 0.37)
		_mesh_points[k] = points
		RenderingServer.mesh_surface_update_vertex_region(_meshes[k], 0, 0, points.to_byte_array())
		RenderingServer.mesh_surface_update_attribute_region(_meshes[k], 0, 0, _mesh_uvs[k])
		RenderingServer.mesh_set_custom_aabb(_meshes[k], AABB(Vector3(0, 0, 0), Vector3(48, 40 + (_frame % 5), 0)))
		if k < _mesh_materials.size() and _mesh_materials[k].is_valid():
			RenderingServer.canvas_item_set_material(_mesh_items[k], _mesh_materials[k])
	if m > 0:
		_mesh_cursor = (_mesh_cursor + _mesh_updates) % m
	var nm: int = _materials.size()
	for u: int in (_param_updates if nm > 0 else 0):
		var mi: int = (_frame * _param_updates + u) % nm
		RenderingServer.material_set_param(_materials[mi], "particle_param_00", float(_frame + u))
	if _frame >= _quit_frame:
		_report()
		get_tree().quit()


func _report() -> void:
	var sorted: PackedInt64Array = _deltas_us.duplicate()
	sorted.sort()
	var count: int = sorted.size()
	var window_s: float = (_last_us - _window_start_us) / 1000000.0
	var summary: Dictionary = {
		"frames": count,
		"window_s": window_s,
		"fps": (count / window_s) if window_s > 0.0 else 0.0,
		"frame_us_p50": sorted[count / 2] if count > 0 else 0,
		"frame_us_p95": sorted[mini(count - 1, (count * 95) / 100)] if count > 0 else 0,
		"frame_us_max": sorted[count - 1] if count > 0 else 0,
		"setup_ms": _setup_ms,
	}
	var line: String = JSON.stringify(summary)
	print("[scale] report " + line)
	if OS.has_environment("RS_SCALE_REPORT"):
		var file: FileAccess = FileAccess.open(OS.get_environment("RS_SCALE_REPORT"), FileAccess.WRITE)
		if file != null:
			file.store_line(line)
			file.close()


func _exit_tree() -> void:
	for item: RID in _items:
		RenderingServer.free_rid(item)
	for mesh: RID in _meshes:
		RenderingServer.free_rid(mesh)
	for material: RID in _materials:
		RenderingServer.free_rid(material)
	for shader: RID in _shaders:
		RenderingServer.free_rid(shader)
