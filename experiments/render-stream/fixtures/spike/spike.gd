extends Node2D
## Gate -1 spike: a small, fixed scene that drives engine-internal draws (ColorRect, Label glyphs,
## a StyleBoxFlat Panel, a NinePatchRect) and direct RenderingServer calls (this script's own
## `_draw()` and `_process()`) every frame, so the capture library has one fixture that exercises
## both paths at once. See `expected.json` for the exact values this emits and `README.md` for how
## the runner drives it. Every literal below is an exact sum of powers of two, so it survives
## float32 bit-exact.

const SCRIPT_RECT: Rect2 = Rect2(213.25, 27.5, 101.125, 49.75)
const SCRIPT_RECT_COLOR: Color = Color(0.125, 0.5, 0.75, 1.0)
# `PackedVector2Array`/`PackedColorArray` built from an array of constructor calls are not constant
# expressions to the GDScript parser (only literal-only array constants are), so these are `var`
# rather than `const`; all are set once here and never reassigned.
var _polygon_points: PackedVector2Array = PackedVector2Array([
	Vector2(400.5, 40.25),
	Vector2(480.75, 60.5),
	Vector2(440.125, 120.875),
])
var _polygon_colors: PackedColorArray = PackedColorArray([
	Color(0.25, 0.5, 0.75, 1),
	Color(0.5, 0.25, 0.125, 1),
	Color(0.875, 0.625, 0.375, 1),
])

# canvas_item_add_triangle_array: a quad as two indexed triangles, per-vertex colours and UVs.
var _tri_indices: PackedInt32Array = PackedInt32Array([0, 1, 2, 0, 2, 3])
var _tri_points: PackedVector2Array = PackedVector2Array([
	Vector2(20.5, 220.25),
	Vector2(120.75, 220.25),
	Vector2(120.75, 300.5),
	Vector2(20.5, 300.5),
])
var _tri_colors: PackedColorArray = PackedColorArray([
	Color(0.75, 0.25, 0.5, 1),
	Color(0.25, 0.75, 0.5, 1),
	Color(0.5, 0.25, 0.75, 1),
	Color(1, 1, 0.25, 1),
])
var _tri_uvs: PackedVector2Array = PackedVector2Array([
	Vector2(0, 0), Vector2(1, 0), Vector2(1, 1), Vector2(0, 1),
])

# canvas_item_add_nine_patch, on a 4x4 ImageTexture this script creates (texture_2d_create).
const NINE_TEXTURE_SIZE: int = 4
const NINE_RECT: Rect2 = Rect2(140.5, 220.5, 80.25, 60.75)
const NINE_SOURCE: Rect2 = Rect2(0, 0, 4, 4)
const NINE_TOPLEFT: Vector2 = Vector2(1.25, 1.5)
const NINE_BOTTOMRIGHT: Vector2 = Vector2(1.75, 1.0)
const NINE_MODULATE: Color = Color(1, 0.75, 0.5, 1)

# canvas_item_add_primitive: a textured quad (4 points, 4 colours, 4 UVs).
var _prim_points: PackedVector2Array = PackedVector2Array([
	Vector2(240.25, 220.5),
	Vector2(300.75, 220.5),
	Vector2(300.75, 280.25),
	Vector2(240.25, 280.25),
])
var _prim_colors: PackedColorArray = PackedColorArray([
	Color(1, 1, 1, 1), Color(1, 0.5, 0.5, 1), Color(0.5, 1, 0.5, 1), Color(0.5, 0.5, 1, 1),
])
var _prim_uvs: PackedVector2Array = PackedVector2Array([
	Vector2(0, 0), Vector2(1, 0), Vector2(1, 1), Vector2(0, 1),
])

# canvas_item_add_line / _polyline / _circle (the circle after an add_set_transform).
const LINE_FROM: Vector2 = Vector2(320.5, 220.25)
const LINE_TO: Vector2 = Vector2(400.75, 290.5)
const LINE_COLOR: Color = Color(0.375, 0.875, 0.625, 1)
const LINE_WIDTH: float = 3.5
var _polyline_points: PackedVector2Array = PackedVector2Array([
	Vector2(420.5, 300.5), Vector2(460.25, 340.75), Vector2(490.75, 300.25),
])
var _polyline_colors: PackedColorArray = PackedColorArray([Color(0.875, 0.875, 0.125, 1)])
const POLYLINE_WIDTH: float = 2.5
const SET_TRANSFORM_ORIGIN: Vector2 = Vector2(400.5, 0.25)
const CIRCLE_POSITION: Vector2 = Vector2(40.5, 250.25)
const CIRCLE_RADIUS: float = 20.75
const CIRCLE_COLOR: Color = Color(0.625, 0.375, 0.875, 1)

# canvas_item_add_mesh over an ArrayMesh built here (mesh_create + mesh_add_surface), the shape of
# spine-godot's SpineMesh2D path: one dynamic surface, then per-frame vertex and attribute region
# updates plus a custom AABB, then canvas_item_add_mesh.
var _mesh_points: PackedVector2Array = PackedVector2Array([
	Vector2(20.25, 310.5), Vector2(100.75, 310.5), Vector2(60.5, 350.25),
])
var _mesh_colors: PackedColorArray = PackedColorArray([
	Color(1, 0, 0, 1), Color(0, 1, 0, 1), Color(0, 0, 1, 1),
])
# Transforms are built from explicit axes: the rotation constructor would put -0.0 in the y axis.
const MESH_ORIGIN: Vector2 = Vector2(130.5, 0.25)
const MESH_MODULATE: Color = Color(1, 0.875, 0.75, 1)
# Vertex 1 moves to MESH_MOVED_VERTEX (8 bytes at byte offset 1 * vertex stride); vertex 2's RGBA8
# colour becomes MESH_NEW_COLOR_BYTES (4 bytes at byte offset 2 * attribute stride).
const MESH_MOVED_VERTEX: Vector2 = Vector2(110.25, 330.5)
const MESH_NEW_COLOR_BYTES: Array[int] = [255, 255, 0, 255]
const MESH_CUSTOM_AABB: AABB = AABB(Vector3(20.25, 310.5, 0), Vector3(90, 39.75, 0))
# canvas_item_add_multimesh: one 2D instance of the same mesh, shifted right.
const MULTIMESH_OFFSET: Vector2 = Vector2(260.5, 0)

const TINT_SHADER_A: String = "shader_type canvas_item;\nuniform vec4 tint = vec4(1.0);\nvoid fragment() { COLOR *= tint; }\n"
const TINT_SHADER_B: String = "shader_type canvas_item;\nuniform vec4 tint = vec4(1.0);\nvoid fragment() { COLOR = COLOR * tint; }\n"
const PANEL_MODULATE: Color = Color(0.875, 1, 1, 1)

# Calibrator-3 state hooks, on the empty post-arm Node2D (see _ready).
const LATE_Z_INDEX: int = 1
const LATE_SELF_MODULATE: Color = Color(0.5, 0.75, 1, 1)

const RELABEL_FRAME: int = 30
const QUIT_FRAME: int = 400
const DEFAULT_SCREENSHOT_FRAME: int = 60

@onready var label: Label = $Label
@onready var panel: Panel = $Panel
@onready var nine_patch_rect: NinePatchRect = $NinePatch

var frame_count: int = 0
var draw_count: int = 0
var _screenshot_frame: int = DEFAULT_SCREENSHOT_FRAME
var _screenshot_taken: bool = false

var _nine_texture: ImageTexture
var _mesh: ArrayMesh = ArrayMesh.new()
var _vertex_stride: int = 0
var _attribute_stride: int = 0
var _vertex_update: PackedByteArray
var _attribute_update: PackedByteArray = PackedByteArray(MESH_NEW_COLOR_BYTES)
var _multimesh: MultiMesh = MultiMesh.new()
var _canvas_texture: CanvasTexture


func _ready() -> void:
	if OS.has_environment("GRC_SCREENSHOT_FRAME"):
		_screenshot_frame = int(OS.get_environment("GRC_SCREENSHOT_FRAME"))

	var image: Image = Image.create_empty(NINE_TEXTURE_SIZE, NINE_TEXTURE_SIZE, false, Image.FORMAT_RGBA8)
	for y: int in NINE_TEXTURE_SIZE:
		for x: int in NINE_TEXTURE_SIZE:
			image.set_pixel(x, y, Color(0.25 * x, 0.25 * y, 0.5, 1))
	_nine_texture = ImageTexture.create_from_image(image)
	nine_patch_rect.texture = _nine_texture

	var arrays: Array = []
	arrays.resize(Mesh.ARRAY_MAX)
	arrays[Mesh.ARRAY_VERTEX] = _mesh_points
	arrays[Mesh.ARRAY_COLOR] = _mesh_colors
	_mesh.add_surface_from_arrays(Mesh.PRIMITIVE_TRIANGLES, arrays, [], {}, Mesh.ARRAY_FLAG_USE_DYNAMIC_UPDATE)
	var format: int = _mesh.surface_get_format(0)
	_vertex_stride = RenderingServer.mesh_surface_get_format_vertex_stride(format, _mesh_points.size())
	_attribute_stride = RenderingServer.mesh_surface_get_format_attribute_stride(format, _mesh_points.size())
	_vertex_update = PackedFloat32Array([MESH_MOVED_VERTEX.x, MESH_MOVED_VERTEX.y]).to_byte_array()
	print("[fixture] mesh format=%d vertex_stride=%d attribute_stride=%d" % [format, _vertex_stride, _attribute_stride])

	_multimesh.transform_format = MultiMesh.TRANSFORM_2D
	_multimesh.mesh = _mesh
	_multimesh.instance_count = 1
	_multimesh.set_instance_transform_2d(0, Transform2D(Vector2(1, 0), Vector2(0, 1), MULTIMESH_OFFSET))

	# A node created after the capture armed: its constructor calls canvas_item_create. It draws
	# nothing, so its z_index (canvas_item_set_z_index), self_modulate
	# (canvas_item_set_self_modulate), z_as_relative (canvas_item_set_z_as_relative_to_parent) and
	# show_behind_parent (canvas_item_set_draw_behind_parent) change no pixels. The self_modulate is
	# not white, and z_as_relative/show_behind_parent are not left at their defaults (true/false),
	# because CanvasItem's setters return early on an unchanged value and would never reach the
	# RenderingServer (scene/main/canvas_item.cpp:556, :655-661, :1155-1161; calibrator 4,
	# gate1-design.md G1e).
	var late: Node2D = Node2D.new()
	late.z_index = LATE_Z_INDEX
	late.self_modulate = LATE_SELF_MODULATE
	late.z_as_relative = false
	late.show_behind_parent = true
	add_child(late)
	# Calibrator-5 texture hooks (gate2-design.md Q2), on the same post-arm Node2D and on objects
	# nothing draws, so the pixels do not change. The item's own filter/repeat are set to
	# non-default values (canvas_item_set_default_texture_filter/_repeat; its tree entry above
	# already called both with DEFAULT): CanvasItem's setters return early on an unchanged value
	# (scene/main/canvas_item.cpp:1626-1628, :1680-1682).
	late.texture_filter = CanvasItem.TEXTURE_FILTER_NEAREST
	late.texture_repeat = CanvasItem.TEXTURE_REPEAT_ENABLED
	_exercise_texture_hooks()

	# An empty CanvasLayer created after arming: canvas_create in its constructor, then
	# viewport_attach_canvas and viewport_set_canvas_transform when it enters the tree. It has no
	# items, so the pixels do not change.
	add_child(CanvasLayer.new())

	# A throwaway mesh, cleared again: mesh_clear.
	var scratch: ArrayMesh = ArrayMesh.new()
	scratch.add_surface_from_arrays(Mesh.PRIMITIVE_TRIANGLES, arrays)
	scratch.clear_surfaces()

	# Shader created from code, then re-coded (shader_create_from_code, shader_set_code), on a
	# material with a parameter (material_set_param) assigned to the Panel (canvas_item_set_material).
	# The tint is white both times, so the pixels do not change.
	var shader: Shader = Shader.new()
	shader.code = TINT_SHADER_A
	var _created: RID = shader.get_rid()
	shader.code = TINT_SHADER_B
	var material: ShaderMaterial = ShaderMaterial.new()
	material.shader = shader
	material.set_shader_parameter("tint", Color(1, 1, 1, 1))
	panel.material = material
	panel.modulate = PANEL_MODULATE

	queue_redraw()


## The other nine calibrator-5 hooks, each with a non-default value, on objects that never reach
## the screen: a placeholder replaced by a 2x2 image (texture_2d_placeholder_create,
## texture_replace), a RenderingServer viewport that is never attached or drawn
## (viewport_set_default_canvas_item_texture_filter/_repeat), a CanvasTexture no item uses
## (canvas_texture_create, _set_channel, _set_texture_filter, _set_texture_repeat), and an LCD
## text rect on a canvas item with no parent canvas (canvas_item_add_lcd_texture_rect_region).
func _exercise_texture_hooks() -> void:
	var placeholder: RID = RenderingServer.texture_2d_placeholder_create()
	var by_texture: RID = RenderingServer.texture_2d_create(Image.create_empty(2, 2, false, Image.FORMAT_RGBA8))
	RenderingServer.texture_replace(placeholder, by_texture)
	RenderingServer.free_rid(placeholder)

	var offscreen_viewport: RID = RenderingServer.viewport_create()
	RenderingServer.viewport_set_default_canvas_item_texture_filter(offscreen_viewport, RenderingServer.CANVAS_ITEM_TEXTURE_FILTER_NEAREST)
	RenderingServer.viewport_set_default_canvas_item_texture_repeat(offscreen_viewport, RenderingServer.CANVAS_ITEM_TEXTURE_REPEAT_ENABLED)
	RenderingServer.free_rid(offscreen_viewport)

	_canvas_texture = CanvasTexture.new()
	_canvas_texture.diffuse_texture = _nine_texture
	_canvas_texture.texture_filter = CanvasItem.TEXTURE_FILTER_NEAREST
	_canvas_texture.texture_repeat = CanvasItem.TEXTURE_REPEAT_ENABLED

	var orphan_item: RID = RenderingServer.canvas_item_create()
	RenderingServer.canvas_item_add_lcd_texture_rect_region(orphan_item, Rect2(0, 0, 4, 4), _nine_texture.get_rid(), Rect2(0, 0, 4, 4), Color(1, 1, 1, 1))
	RenderingServer.free_rid(orphan_item)


func _process(_delta: float) -> void:
	frame_count += 1

	if frame_count == RELABEL_FRAME:
		label.text = "Spike Ag Qz!"

	# The SpineMesh2D shape: rewrite part of the surface every frame.
	var mesh_rid: RID = _mesh.get_rid()
	RenderingServer.mesh_surface_update_vertex_region(mesh_rid, 0, _vertex_stride, _vertex_update)
	RenderingServer.mesh_surface_update_attribute_region(mesh_rid, 0, 2 * _attribute_stride, _attribute_update)
	RenderingServer.mesh_set_custom_aabb(mesh_rid, MESH_CUSTOM_AABB)

	if frame_count == _screenshot_frame and not _screenshot_taken:
		_screenshot_taken = true
		_maybe_take_screenshot()

	if frame_count >= QUIT_FRAME:
		print("[fixture] draws=%d frames=%d" % [draw_count, frame_count])
		get_tree().quit(0)
		return

	queue_redraw()


func _draw() -> void:
	draw_count += 1
	var item: RID = get_canvas_item()
	RenderingServer.canvas_item_add_rect(item, SCRIPT_RECT, SCRIPT_RECT_COLOR)
	RenderingServer.canvas_item_add_polygon(item, _polygon_points, _polygon_colors)
	RenderingServer.canvas_item_add_triangle_array(item, _tri_indices, _tri_points, _tri_colors, _tri_uvs)
	RenderingServer.canvas_item_add_nine_patch(item, NINE_RECT, NINE_SOURCE, _nine_texture.get_rid(),
			NINE_TOPLEFT, NINE_BOTTOMRIGHT, RenderingServer.NINE_PATCH_TILE,
			RenderingServer.NINE_PATCH_TILE_FIT, false, NINE_MODULATE)
	RenderingServer.canvas_item_add_primitive(item, _prim_points, _prim_colors, _prim_uvs, _nine_texture.get_rid())
	RenderingServer.canvas_item_add_line(item, LINE_FROM, LINE_TO, LINE_COLOR, LINE_WIDTH)
	RenderingServer.canvas_item_add_polyline(item, _polyline_points, _polyline_colors, POLYLINE_WIDTH)
	RenderingServer.canvas_item_add_mesh(item, _mesh.get_rid(), Transform2D(Vector2(1, 0), Vector2(0, 1), MESH_ORIGIN), MESH_MODULATE)
	RenderingServer.canvas_item_add_multimesh(item, _multimesh.get_rid())
	# Last: everything after an add_set_transform is drawn in its space.
	RenderingServer.canvas_item_add_set_transform(item, Transform2D(Vector2(1, 0), Vector2(0, 1), SET_TRANSFORM_ORIGIN))
	RenderingServer.canvas_item_add_circle(item, CIRCLE_POSITION, CIRCLE_RADIUS, CIRCLE_COLOR)


## Rendered legs only: a truly headless run has no draw/present path to wait on (frame_post_draw
## is not relied upon there -- see experiments/render-stream fixtures/spike/README.md).
func _maybe_take_screenshot() -> void:
	if not OS.has_environment("GRC_SCREENSHOT"):
		return
	if DisplayServer.get_name() == "headless":
		print("[fixture] screenshot skipped (headless)")
		return

	var out_path: String = OS.get_environment("GRC_SCREENSHOT")
	await RenderingServer.frame_post_draw
	var image: Image = get_viewport().get_texture().get_image()
	var err: Error = image.save_png(out_path)
	print("[fixture] screenshot saved=%s err=%d" % [out_path, err])
