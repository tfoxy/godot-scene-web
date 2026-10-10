extends Node
## Gate 5 mesh fixture (../../protocol/gate5-design.md "Q6d", G5c).
##
## The root is a plain `Node`. Every `CanvasItem`, mesh and texture is created in `_ready()`, after
## `GrcLoader` armed the capture extension in its own `_enter_tree()` (gate 0 route (a)), so the
## hooks see every `canvas_item_create`, `mesh_create`, `mesh_create_from_surfaces`,
## `mesh_add_surface` and `texture_2d_create`. Item construction order is expected.json
## `creation_order` (wire item ids) and mesh creation order its `mesh_order` (the hook log's mesh
## ids). make_expected.py models the same scene from its own copy of these numbers; the two must
## agree.
##
## DF follows spine-godot's draw path (README "spine-godot's draw path"): built on frame 1, rebuilt
## on step 5's frame (`free`, `mesh_create`, `mesh_add_surface`), and on every other frame
## `mesh_surface_update_vertex_region`, `mesh_surface_update_attribute_region` and
## `mesh_set_custom_aabb`; then the item redraws (`canvas_item_clear` + `canvas_item_add_mesh`).
##
## Environment (all optional; an invalid value prints an error and quits 2):
##   RS_FIXTURE_STEP_LOG    absolute path: one JSONL line per step at its applied frame
##   RS_FIXTURE_SHOT_DIR    absolute dir: step-<k>.png at each settle frame (rendered runs only)
##   RS_FIXTURE_MESH_LOG    absolute path: the mesh oracle (mesh_oracle.gd), one JSONL line per
##                          settle frame. Reference legs only: refused (exit 2) when any GRC_*
##                          capture variable is set.
##   RS_FIXTURE_START_FRAME S >= 1, default 1
##   RS_FIXTURE_STEP_FRAMES N >= 8, default 10 (step k >= 1 at S+N*k, settled at S+N*k+7)
##   RS_FIXTURE_QUIT_FRAME  >= S+N*9+11 (the default)
##   RS_FIXTURE_VARIANT     refused: G5c has no variant

const MeshOracle := preload("res://mesh_oracle.gd")

const LAST_STEP: int = 9
const SETTLE_OFFSET: int = 7
const START_FRAME_DEFAULT: int = 1
const STEP_FRAMES_DEFAULT: int = 10
const QUIT_AFTER_LAST_SETTLE: int = 4

## The capture variables whose presence refuses the oracle (it runs on reference legs only).
const CAPTURE_VARIABLES: Array[String] = ["GRC_EXTENSION", "GRC_MODE", "GRC_CALIBRATION", "GRC_EVIDENCE_DIR", "GRC_STREAM_OUT"]

## Gate 3's marker colours (gate 1's first ten).
const MARKER_COLORS: Array[Color] = [
	Color(0, 0, 0, 1),
	Color(1, 1, 0, 1),
	Color(0, 1, 1, 1),
	Color(0.4, 0, 0.4, 1),
	Color(0, 0.4, 0, 1),
	Color(0.4, 0, 0, 1),
	Color(0, 0, 0.4, 1),
	Color(0.8, 0.4, 0.8, 1),
	Color(0.4, 0.6, 0.8, 1),
	Color(0.8, 0.6, 0.4, 1),
]

## Q6a's TEXG: 32x16, a checker of 4x4-texel cells.
const TEXG_COLOURS: Array[Color] = [Color(1, 0.8, 0.4, 1), Color(0.4, 0.2, 0.6, 1)]

const QUAD_INDICES: Array[int] = [0, 1, 2, 0, 2, 3]
const AM1_QUAD: Array[Vector2] = [Vector2(0, 0), Vector2(64, 0), Vector2(64, 48), Vector2(0, 48)]
const AM1_QUAD_STEP1: Array[Vector2] = [Vector2(8, 0), Vector2(72, 0), Vector2(72, 48), Vector2(8, 48)]
const AM1_COLOUR: Color = Color(1, 0.6, 0, 1)
const AM1_STEP8: Array[Vector2] = [Vector2(8, 0), Vector2(56, 0), Vector2(8, 47), Vector2(24, 56), Vector2(72, 56), Vector2(72, 9)]
const AM1_STEP8_COLOUR: Color = Color(0.2, 0.6, 1, 1)
const RMS_QUAD: Array[Vector2] = [Vector2(0, 0), Vector2(64, 0), Vector2(64, 47), Vector2(0, 47)]
const RMS_QUAD_STEP2: Array[Vector2] = [Vector2(8, 4), Vector2(56, 4), Vector2(56, 43), Vector2(8, 43)]
const RMS_COLOUR: Color = Color(0.2, 0.8, 0.4, 1)
## (1, .2, .2) as the engine packs it: uint8(c * 255) (servers/rendering_server.cpp:706-722).
const RMS_COLOUR_STEP3_RGBA8: Array[int] = [255, 51, 51, 255]
const M2_SQUARE: Array[Vector2] = [Vector2(0, 0), Vector2(32, 0), Vector2(32, 32), Vector2(0, 32)]
const M2_TRIANGLE: Array[Vector2] = [Vector2(40, 8), Vector2(64, 8), Vector2(40, 41)]
const M2_SQUARE_COLOUR: Color = Color(1, 1, 1, 1)
const M2_TRIANGLE_COLOUR: Color = Color(0.4, 0.4, 1, 1)
const DF_W: Array[int] = [0, 1, 2, 1, 0, -1, -2, -1]
const DF_SIZE: Vector2 = Vector2(128, 64)
const DF_GRID: Vector2i = Vector2i(9, 5)
const DF2_GRID: Vector2i = Vector2i(5, 3)
const DF_COLOUR_STEP3: Color = Color(0.8, 0.8, 1, 1)
const P2_POLYGON: Array[Vector2] = [Vector2(0, 8), Vector2(32, 8), Vector2(32, 0), Vector2(56, 17), Vector2(32, 34), Vector2(32, 25), Vector2(0, 25)]
const P2_POLYGON_STEP7: Array[Vector2] = [Vector2(0, 8), Vector2(32, 8), Vector2(32, 0), Vector2(72, 21), Vector2(32, 42), Vector2(32, 33), Vector2(0, 33)]
const P2_COLOUR: Color = Color(0.6, 0.2, 1, 1)
const FM_QUAD: Array[Vector2] = [Vector2(0, 0), Vector2(56, 0), Vector2(56, 48), Vector2(0, 48)]
const FM_COLOUR: Color = Color(1, 0.4, 0.6, 1)


## A `Node2D` that draws one mesh with a raw `canvas_item_add_mesh` (identity, white) whenever it
## draws: RM, M2, LD and FR draw once, DF on every frame.
class MeshNode extends Node2D:
	var mesh: RID = RID()
	var texture: RID = RID()

	func _draw() -> void:
		if mesh.is_valid():
			RenderingServer.canvas_item_add_mesh(get_canvas_item(), mesh, Transform2D(), Color(1, 1, 1, 1), texture)


## The step marker (as gates 1 to 5).
class RectNode extends Node2D:
	var rect: Rect2 = Rect2()
	var color: Color = Color.BLACK

	func _draw() -> void:
		draw_rect(rect, color)

	func set_color(new_color: Color) -> void:
		color = new_color
		queue_redraw()


var texg: ImageTexture
var am1: ArrayMesh
var ld_mesh: ArrayMesh
var rms: RID
var m2_mesh: RID
var df_mesh: RID
var fm: RID
var mi: MeshInstance2D
var rm: MeshNode
var m2: MeshNode
var df: MeshNode
var p2: Polygon2D
var ld: MeshNode
var fr: MeshNode
var marker: RectNode

var _df_grid: Vector2i = DF_GRID
var _df_colour: Color = Color(1, 1, 1, 1)
var _df_rebuild: bool = false
var _df_first: RID
var _fm_freed: bool = false
var _p2_mesh: RID

var _frame: int = 0
var _start_frame: int = START_FRAME_DEFAULT
var _step_frames: int = STEP_FRAMES_DEFAULT
var _quit_frame: int = 0
var _shot_dir: String = ""
var _step_log_file: FileAccess
var _oracle: MeshOracle
var _failed: bool = false


func _ready() -> void:
	if not _read_environment():
		_failed = true
		get_tree().quit(2)
		return

	# TEXG (Q6a), after the engine's hue strip.
	var image: Image = Image.create_empty(32, 16, false, Image.FORMAT_RGBA8)
	for cy: int in range(4):
		for cx: int in range(8):
			image.fill_rect(Rect2i(cx * 4, cy * 4, 4, 4), TEXG_COLOURS[(cx + cy) % 2])
	texg = ImageTexture.create_from_image(image)

	# Meshes and items in expected.json's orders. AM1 (mesh 1): ArrayMesh creates its RS mesh
	# lazily on the first surface. MI (item 1) draws it and redraws on its `changed` signal.
	am1 = ArrayMesh.new()
	am1.add_surface_from_arrays(Mesh.PRIMITIVE_TRIANGLES, _arrays(AM1_QUAD, AM1_COLOUR, QUAD_INDICES))
	mi = MeshInstance2D.new()
	mi.name = "MI"
	mi.position = Vector2(40, 40)
	mi.mesh = am1

	# RMS (mesh 2): raw, USE_DYNAMIC_UPDATE. RM (item 2) records it once.
	rms = RenderingServer.mesh_create()
	RenderingServer.mesh_add_surface_from_arrays(rms, RenderingServer.PRIMITIVE_TRIANGLES, _arrays(RMS_QUAD, RMS_COLOUR, QUAD_INDICES), [], {}, RenderingServer.ARRAY_FLAG_USE_DYNAMIC_UPDATE)
	rm = _mesh_node("RM", Vector2(176, 40), rms)

	# M2 (mesh 3): two surfaces, an indexed square and an unindexed triangle.
	m2_mesh = RenderingServer.mesh_create()
	RenderingServer.mesh_add_surface_from_arrays(m2_mesh, RenderingServer.PRIMITIVE_TRIANGLES, _arrays(M2_SQUARE, M2_SQUARE_COLOUR, QUAD_INDICES))
	RenderingServer.mesh_add_surface_from_arrays(m2_mesh, RenderingServer.PRIMITIVE_TRIANGLES, _arrays(M2_TRIANGLE, M2_TRIANGLE_COLOUR, []))
	m2 = _mesh_node("M2", Vector2(288, 40), m2_mesh)

	# DF (mesh 4): the geoclip-like grid, built with frame 1's displacement.
	df_mesh = _df_build(1)
	_df_first = df_mesh
	df = _mesh_node("DF", Vector2(400, 40), df_mesh)
	df.texture = texg.get_rid()
	df.texture_filter = CanvasItem.TEXTURE_FILTER_NEAREST

	# P2 (item 5, mesh 5): Polygon2D makes its mesh in its constructor, right after its item.
	p2 = Polygon2D.new()
	p2.name = "P2"
	p2.position = Vector2(40, 160)
	p2.polygon = PackedVector2Array(P2_POLYGON)
	p2.color = P2_COLOUR
	_p2_mesh = MeshOracle.derive_polygon_mesh(p2.get_canvas_item(), df_mesh)

	# LD (mesh 6): a loaded ArrayMesh resource -> mesh_create_from_surfaces.
	var resource: Resource = load("res://ld_mesh.tres")
	ld_mesh = resource as ArrayMesh
	ld = _mesh_node("LD", Vector2(176, 160), ld_mesh.get_rid())

	# FM (mesh 7), freed at step 7 while FR still names it.
	fm = RenderingServer.mesh_create()
	RenderingServer.mesh_add_surface_from_arrays(fm, RenderingServer.PRIMITIVE_TRIANGLES, _arrays(FM_QUAD, FM_COLOUR, QUAD_INDICES))
	fr = _mesh_node("FR", Vector2(288, 160), fm)

	marker = RectNode.new()
	marker.name = "Marker"
	marker.position = Vector2(592, 16)
	marker.rect = Rect2(0, 0, 32, 32)
	marker.color = MARKER_COLORS[0]

	for node: Node in [mi, rm, m2, df, p2, ld, fr, marker]:
		add_child(node)

	_log_step(0, 1, _start_frame + SETTLE_OFFSET)
	print("[fixture] gate5-mesh ready: S=%d N=%d quit=%d oracle=%s" % [_start_frame, _step_frames, _quit_frame, "on" if _oracle != null else "off"])


func _exit_tree() -> void:
	# Release the raw meshes after the quit frame (teardown), so no RID leaks at exit.
	for rid: RID in [rms, m2_mesh, df_mesh]:
		if rid.is_valid():
			RenderingServer.free_rid(rid)
	if not _fm_freed and fm.is_valid():
		RenderingServer.free_rid(fm)


func _process(_delta: float) -> void:
	if _failed:
		return
	_frame += 1

	var apply_step: int = _step_at(_frame, 0)
	if apply_step >= 1:
		_apply_step(apply_step)
		_log_step(apply_step, _frame, _frame + SETTLE_OFFSET)

	# Frame 1 is DF's build frame (in _ready); every later frame runs its draw path.
	if _frame > 1:
		_df_frame(_frame)

	var settle_step: int = _step_at(_frame, SETTLE_OFFSET)
	if settle_step >= 0:
		if _oracle != null:
			_oracle.record(settle_step, _frame, _oracle_meshes(settle_step), "P2", p2.polygon)
		_maybe_take_shot("step-%d.png" % settle_step)

	if _frame >= _quit_frame:
		print("[fixture] quitting frame=%d" % _frame)
		get_tree().quit(0)


## gate5-design.md Q6d's timeline.
func _apply_step(step: int) -> void:
	match step:
		1:
			am1.surface_update_vertex_region(0, 0, PackedVector2Array(AM1_QUAD_STEP1).to_byte_array())
		2:
			RenderingServer.mesh_surface_update_vertex_region(rms, 0, 0, PackedVector2Array(RMS_QUAD_STEP2).to_byte_array())
		3:
			var colours: PackedByteArray = PackedByteArray()
			for i: int in range(4):
				colours.append_array(PackedByteArray(RMS_COLOUR_STEP3_RGBA8))
			RenderingServer.mesh_surface_update_attribute_region(rms, 0, 0, colours)
			_df_colour = DF_COLOUR_STEP3
		4:
			# The second triangle (indices 3..5, bytes 6..11) becomes (0, 0, 0).
			var degenerate: PackedByteArray = PackedByteArray()
			degenerate.resize(6)
			RenderingServer.mesh_surface_update_index_region(rms, 0, 6, degenerate)
		5:
			_df_rebuild = true
		6:
			RenderingServer.mesh_surface_remove(m2_mesh, 0)
		7:
			RenderingServer.free_rid(fm)
			_fm_freed = true
			p2.polygon = PackedVector2Array(P2_POLYGON_STEP7)
		8:
			RenderingServer.canvas_item_clear(fr.get_canvas_item())
			fr.mesh = RID()
			am1.clear_surfaces()
			am1.add_surface_from_arrays(Mesh.PRIMITIVE_TRIANGLES, _arrays(AM1_STEP8, AM1_STEP8_COLOUR, []))
		9:
			get_viewport().canvas_transform = Transform2D(0.0, Vector2(8, 4))
	marker.set_color(MARKER_COLORS[step])


## DF's draw path on one frame (spine-godot's order), then its item redraws.
func _df_frame(frame: int) -> void:
	if _df_rebuild:
		_df_rebuild = false
		RenderingServer.free_rid(df_mesh)
		_df_grid = DF2_GRID
		df_mesh = _df_build(frame)
		df.mesh = df_mesh
	else:
		RenderingServer.mesh_surface_update_vertex_region(df_mesh, 0, 0, _df_points(frame).to_byte_array())
		RenderingServer.mesh_surface_update_attribute_region(df_mesh, 0, 0, _df_attributes())
		RenderingServer.mesh_set_custom_aabb(df_mesh, _df_custom_aabb(frame))
	df.queue_redraw()


func _df_build(frame: int) -> RID:
	var mesh: RID = RenderingServer.mesh_create()
	var arrays: Array = []
	arrays.resize(Mesh.ARRAY_MAX)
	arrays[Mesh.ARRAY_VERTEX] = _df_points(frame)
	var colours: PackedColorArray = PackedColorArray()
	for i: int in range(_df_grid.x * _df_grid.y):
		colours.append(_df_colour)
	arrays[Mesh.ARRAY_COLOR] = colours
	arrays[Mesh.ARRAY_TEX_UV] = _df_uvs()
	arrays[Mesh.ARRAY_INDEX] = _df_indices()
	RenderingServer.mesh_add_surface_from_arrays(mesh, RenderingServer.PRIMITIVE_TRIANGLES, arrays, [], {}, RenderingServer.ARRAY_FLAG_USE_DYNAMIC_UPDATE)
	return mesh


## Column c moves by W[(frame + c) mod 8] px in y.
func _df_points(frame: int) -> PackedVector2Array:
	var out: PackedVector2Array = PackedVector2Array()
	var dx: float = DF_SIZE.x / (_df_grid.x - 1)
	var dy: float = DF_SIZE.y / (_df_grid.y - 1)
	for j: int in range(_df_grid.y):
		for i: int in range(_df_grid.x):
			out.append(Vector2(dx * i, dy * j + DF_W[(frame + i) % 8]))
	return out


func _df_uvs() -> PackedVector2Array:
	var out: PackedVector2Array = PackedVector2Array()
	for j: int in range(_df_grid.y):
		for i: int in range(_df_grid.x):
			out.append(Vector2(float(i) / (_df_grid.x - 1), float(j) / (_df_grid.y - 1)))
	return out


func _df_indices() -> PackedInt32Array:
	var out: PackedInt32Array = PackedInt32Array()
	for j: int in range(_df_grid.y - 1):
		for i: int in range(_df_grid.x - 1):
			var a: int = j * _df_grid.x + i
			var b: int = a + 1
			out.append_array(PackedInt32Array([a, b, b + _df_grid.x, a, b + _df_grid.x, a + _df_grid.x]))
	return out


## The attribute buffer as the engine packs it: per vertex RGBA8 (truncated) then float32 UV.
func _df_attributes() -> PackedByteArray:
	var uvs: PackedVector2Array = _df_uvs()
	var out: PackedByteArray = PackedByteArray()
	out.resize(uvs.size() * 12)
	var c: Color = _df_colour
	for k: int in range(uvs.size()):
		out[k * 12 + 0] = int(clampf(c.r * 255.0, 0.0, 255.0))
		out[k * 12 + 1] = int(clampf(c.g * 255.0, 0.0, 255.0))
		out[k * 12 + 2] = int(clampf(c.b * 255.0, 0.0, 255.0))
		out[k * 12 + 3] = int(clampf(c.a * 255.0, 0.0, 255.0))
		out.encode_float(k * 12 + 4, uvs[k].x)
		out.encode_float(k * 12 + 8, uvs[k].y)
	return out


func _df_custom_aabb(frame: int) -> AABB:
	var lo: int = 0
	var hi: int = 0
	for i: int in range(_df_grid.x):
		var d: int = DF_W[(frame + i) % 8]
		lo = mini(lo, d) if i > 0 else d
		hi = maxi(hi, d) if i > 0 else d
	return AABB(Vector3(0, lo, 0), Vector3(DF_SIZE.x, DF_SIZE.y + hi - lo, 0))


func _arrays(points: Array[Vector2], colour: Color, indices: Array[int]) -> Array:
	var arrays: Array = []
	arrays.resize(Mesh.ARRAY_MAX)
	arrays[Mesh.ARRAY_VERTEX] = PackedVector2Array(points)
	var colours: PackedColorArray = PackedColorArray()
	for i: int in range(points.size()):
		colours.append(colour)
	arrays[Mesh.ARRAY_COLOR] = colours
	if not indices.is_empty():
		arrays[Mesh.ARRAY_INDEX] = PackedInt32Array(indices)
	return arrays


func _mesh_node(node_name: String, at: Vector2, mesh: RID) -> MeshNode:
	var node: MeshNode = MeshNode.new()
	node.name = node_name
	node.position = at
	node.mesh = mesh
	return node


## The oracle's view of which fixture mesh is which, in creation order (expected.json mesh_order).
func _oracle_meshes(step: int) -> Array[Dictionary]:
	var rebuilt: bool = step >= 5
	var out: Array[Dictionary] = [
		{"name": "AM1", "status": "live", "rid": am1.get_rid()},
		{"name": "RMS", "status": "live", "rid": rms},
		{"name": "M2", "status": "live", "rid": m2_mesh},
		{"name": "DF", "status": "freed" if rebuilt else "live", "rid": _df_first},
		{"name": "P2", "status": "live", "rid": _p2_mesh},
		{"name": "LD", "status": "live", "rid": ld_mesh.get_rid()},
		{"name": "FM", "status": "freed" if _fm_freed else "live", "rid": fm},
		{"name": "DF2", "status": "live" if rebuilt else "absent", "rid": df_mesh},
	]
	return out


func _read_environment() -> bool:
	if OS.has_environment("RS_FIXTURE_VARIANT"):
		_error("RS_FIXTURE_VARIANT is refused: G5c has no variant (got %s)" % JSON.stringify(OS.get_environment("RS_FIXTURE_VARIANT")))
		return false
	var start: int = _int_env("RS_FIXTURE_START_FRAME", START_FRAME_DEFAULT, 1)
	var span: int = _int_env("RS_FIXTURE_STEP_FRAMES", STEP_FRAMES_DEFAULT, SETTLE_OFFSET + 1)
	if start < 0 or span < 0:
		return false
	_start_frame = start
	_step_frames = span
	var quit_default: int = _start_frame + _step_frames * LAST_STEP + SETTLE_OFFSET + QUIT_AFTER_LAST_SETTLE
	var quit: int = _int_env("RS_FIXTURE_QUIT_FRAME", quit_default, quit_default)
	if quit < 0:
		return false
	_quit_frame = quit

	var step_log: String = _path_env("RS_FIXTURE_STEP_LOG")
	var shot_dir: String = _path_env("RS_FIXTURE_SHOT_DIR")
	var mesh_log: String = _path_env("RS_FIXTURE_MESH_LOG")
	if step_log == "!" or shot_dir == "!" or mesh_log == "!":
		return false
	_shot_dir = shot_dir
	if step_log != "":
		_step_log_file = FileAccess.open(step_log, FileAccess.WRITE)
		if _step_log_file == null:
			_error("cannot open RS_FIXTURE_STEP_LOG=%s" % step_log)
			return false
	if mesh_log != "":
		for name: String in CAPTURE_VARIABLES:
			if OS.has_environment(name):
				_error("RS_FIXTURE_MESH_LOG runs on reference legs only, but %s is set" % name)
				return false
		_oracle = MeshOracle.new()
		if not _oracle.open(mesh_log):
			_error("cannot open RS_FIXTURE_MESH_LOG=%s" % mesh_log)
			return false
	return true


## The integer value of `name`, `fallback` when unset, -1 (after printing why) when invalid.
func _int_env(name: String, fallback: int, minimum: int) -> int:
	if not OS.has_environment(name):
		return fallback
	var text: String = OS.get_environment(name).strip_edges()
	if not text.is_valid_int() or text.to_int() < minimum:
		_error("%s must be an integer >= %d (got %s)" % [name, minimum, JSON.stringify(text)])
		return -1
	return text.to_int()


## The absolute path in `name`, "" when unset, "!" (after printing why) when invalid.
func _path_env(name: String) -> String:
	if not OS.has_environment(name):
		return ""
	var text: String = OS.get_environment(name)
	if text == "" or not text.is_absolute_path():
		_error("%s must be an absolute path (got %s)" % [name, JSON.stringify(text)])
		return "!"
	return text


func _error(text: String) -> void:
	printerr("[fixture] error: " + text)


## The step whose frame S + N*k + offset is `frame` (step 0 included), else -1.
func _step_at(frame: int, offset: int) -> int:
	var since: int = frame - _start_frame - offset
	if since < 0 or since % _step_frames != 0:
		return -1
	var step: int = since / _step_frames
	return step if step <= LAST_STEP else -1


func _log_step(step: int, applied_frame: int, settle_frame: int) -> void:
	if _step_log_file == null:
		return
	_step_log_file.store_line("{\"step\":%d,\"applied_frame\":%d,\"settle_frame\":%d}" % [step, applied_frame, settle_frame])
	_step_log_file.flush()


## Rendered runs only: headless has no draw path, so frame_post_draw never fires there. Called
## without `await` from `_process`, so the coroutine finishes while frames keep advancing.
func _maybe_take_shot(file_name: String) -> void:
	if _shot_dir == "":
		return
	if DisplayServer.get_name() == "headless":
		print("[fixture] shot skipped (headless)")
		return
	var out_path: String = _shot_dir.path_join(file_name)
	await RenderingServer.frame_post_draw
	var image: Image = get_viewport().get_texture().get_image()
	var err: Error = image.save_png(out_path)
	print("[fixture] shot saved=%s err=%d" % [out_path, err])
