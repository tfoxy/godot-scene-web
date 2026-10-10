extends RefCounted
## The gate 5 fixture's region nodes (../../protocol/gate5-design.md "Q6b"). Each class issues the
## draw calls of one region in its own local coordinates; gate5.gd builds and steps them, and
## make_expected.py models the same calls from its own copy of these numbers. A property that a
## step changes queues a redraw from its setter, so each step re-records exactly the items its
## row in Q6b names.


## `LN`: wide lines, a thin GL line, a dashed line (`canvas_item_add_multiline`) and an
## antialiased diagonal.
class LinesNode extends Node2D:
	var l2_width: float = 2.0:
		set(value):
			l2_width = value
			queue_redraw()
	var l6_antialiased: bool = true:
		set(value):
			l6_antialiased = value
			queue_redraw()

	func _draw() -> void:
		draw_line(Vector2(8, 8.5), Vector2(136, 8.5), Color(1, 1, 1, 1), 1.0)
		draw_line(Vector2(8, 20), Vector2(136, 20), Color(1, 0.8, 0.2, 1), l2_width)
		draw_line(Vector2(140.5, 4), Vector2(140.5, 76), Color(0.4, 1, 0.4, 1), 3.0)
		draw_line(Vector2(8, 32.5), Vector2(136, 32.5), Color(0.6, 1, 0.6, 1))
		draw_dashed_line(Vector2(8, 44), Vector2(136, 44), Color(1, 0.6, 0.6, 1), 2.0, 8.0)
		draw_line(Vector2(8, 56), Vector2(64, 72), Color(1, 1, 0.2, 1), 4.0, l6_antialiased)


## `PL`: an L-shaped polyline (miter corner), an unfilled rect (a closed 5-point polyline) and a
## polyline with fewer colours than points (hold-last).
class PolylinesNode extends Node2D:
	var p1_color: Color = Color(0.4, 0.8, 1, 1):
		set(value):
			p1_color = value
			queue_redraw()

	func _draw() -> void:
		draw_polyline(PackedVector2Array([Vector2(8, 8), Vector2(64, 8), Vector2(64, 40)]), p1_color, 4.0)
		draw_rect(Rect2(80, 8, 48, 32), Color(1, 0.4, 0.8, 1), false, 2.0)
		draw_polyline_colors(
			PackedVector2Array([Vector2(8, 56), Vector2(48, 56), Vector2(48, 72), Vector2(136, 72)]),
			PackedColorArray([Color(1, 1, 1, 1), Color(0.2, 0.6, 1, 1)]),
			4.0
		)


## `PG`: a concave tie-free arrow, a three-colour triangle and a square textured 1:1 by `TEX16`.
class PolygonsNode extends Node2D:
	const G1: Array[Vector2] = [
		Vector2(8, 16), Vector2(40, 16), Vector2(40, 8), Vector2(64, 25),
		Vector2(40, 42), Vector2(40, 33), Vector2(8, 33),
	]
	var tex16: Texture2D
	var g1_offset: Vector2 = Vector2.ZERO:
		set(value):
			g1_offset = value
			queue_redraw()

	func _draw() -> void:
		var arrow := PackedVector2Array()
		for point: Vector2 in G1:
			arrow.append(point + g1_offset)
		draw_colored_polygon(arrow, Color(0.8, 0.4, 1, 1))
		draw_polygon(
			PackedVector2Array([Vector2(72, 8), Vector2(104, 8), Vector2(72, 41)]),
			PackedColorArray([Color(1, 0, 0, 1), Color(0, 1, 0, 1), Color(0, 0, 1, 1)])
		)
		draw_polygon(
			PackedVector2Array([Vector2(112, 8), Vector2(128, 8), Vector2(128, 24), Vector2(112, 24)]),
			PackedColorArray([Color(1, 1, 1, 1)]),
			PackedVector2Array([Vector2(0, 0), Vector2(1, 0), Vector2(1, 1), Vector2(0, 1)]),
			tex16
		)


## `PR`: a 3-point and a 4-point primitive, and a raw triangle array of two quads drawn with a
## `count` of triangles.
class PrimitivesNode extends Node2D:
	var r3_count: int = 2:
		set(value):
			r3_count = value
			queue_redraw()

	func _draw() -> void:
		draw_primitive(
			PackedVector2Array([Vector2(8, 8), Vector2(40, 8), Vector2(8, 41)]),
			PackedColorArray([Color(1, 0.6, 0.2, 1)]),
			PackedVector2Array()
		)
		draw_primitive(
			PackedVector2Array([Vector2(48, 8), Vector2(80, 8), Vector2(80, 40), Vector2(48, 40)]),
			PackedColorArray([Color(0.2, 1, 0.8, 1)]),
			PackedVector2Array()
		)
		RenderingServer.canvas_item_add_triangle_array(
			get_canvas_item(),
			PackedInt32Array([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7]),
			PackedVector2Array([
				Vector2(8, 48), Vector2(40, 48), Vector2(40, 72), Vector2(8, 72),
				Vector2(48, 48), Vector2(80, 48), Vector2(80, 72), Vector2(48, 72),
			]),
			PackedColorArray([Color(1, 0.2, 0.4, 1)]),
			PackedVector2Array(),
			PackedInt32Array(),
			PackedFloat32Array(),
			RID(),
			r3_count
		)


## `CI`: a filled circle, an antialiased one and an unfilled one (a 65-point polyline).
class CirclesNode extends Node2D:
	var c1_radius: float = 24.0:
		set(value):
			c1_radius = value
			queue_redraw()

	func _draw() -> void:
		draw_circle(Vector2(32, 40), c1_radius, Color(1, 0.8, 0.4, 1))
		draw_circle(Vector2(88, 40), 16.0, Color(0.4, 0.8, 1, 1), true, -1.0, true)
		draw_circle(Vector2(128, 40), 12.0, Color(1, 1, 1, 1), false, 2.0)


## `ST`: draw-transform commands. B under a translate+scale, C under an exact 90-degree matrix, D
## under a pure translation that replaces (does not compose with) C's.
class TransformsNode extends Node2D:
	var b_scale: float = 2.0:
		set(value):
			b_scale = value
			queue_redraw()

	func _draw() -> void:
		draw_rect(Rect2(4, 4, 24, 16), Color(1, 0.4, 0.4, 1))
		draw_set_transform(Vector2(32, 0), 0.0, Vector2(b_scale, b_scale))
		draw_rect(Rect2(2, 2, 8, 8), Color(0.4, 1, 0.4, 1))
		draw_set_transform_matrix(Transform2D(Vector2(0, 1), Vector2(-1, 0), Vector2(88, 8)))
		draw_rect(Rect2(0, 0, 24, 8), Color(0.4, 0.4, 1, 1))
		draw_set_transform_matrix(Transform2D(Vector2(1, 0), Vector2(0, 1), Vector2(0, 40)))
		draw_rect(Rect2(4, 4, 24, 16), Color(1, 1, 0.4, 1))


## A `Node2D` drawing one axis-aligned rect: `STC` (ST's child, untouched by ST's draw
## transform) and the step marker.
class RectNode extends Node2D:
	var rect: Rect2 = Rect2()
	var color: Color = Color.BLACK

	func _draw() -> void:
		draw_rect(rect, color)

	func set_color(new_color: Color) -> void:
		color = new_color
		queue_redraw()


## `CG`: a clipping Control. A full rect, then a rect overhanging right-bottom between
## `add_clip_ignore(true)` and `(false)` (drawn unclipped), then a rect overhanging top-left
## (clipped).
class ClipIgnoreNode extends Control:
	func _draw() -> void:
		draw_rect(Rect2(0, 0, 64, 48), Color(0.2, 0.6, 0.4, 1))
		RenderingServer.canvas_item_add_clip_ignore(get_canvas_item(), true)
		draw_rect(Rect2(48, 32, 32, 24), Color(1, 0.8, 0.6, 1))
		RenderingServer.canvas_item_add_clip_ignore(get_canvas_item(), false)
		draw_rect(Rect2(-8, -8, 24, 16), Color(0.6, 0.2, 0.2, 1))


## `NP`: two raw nine-patches of `TEX9` (4-texel margins): `stretch`/`stretch` with its centre,
## and `tile`/`tile` without.
class NinePatchNode extends Node2D:
	var tex9: Texture2D

	func _draw() -> void:
		var rid: RID = tex9.get_rid()
		RenderingServer.canvas_item_add_nine_patch(
			get_canvas_item(), Rect2(8, 8, 56, 40), Rect2(), rid, Vector2(4, 4), Vector2(4, 4),
			RenderingServer.NINE_PATCH_STRETCH, RenderingServer.NINE_PATCH_STRETCH, true, Color(1, 1, 1, 1)
		)
		RenderingServer.canvas_item_add_nine_patch(
			get_canvas_item(), Rect2(72, 8, 56, 40), Rect2(), rid, Vector2(4, 4), Vector2(4, 4),
			RenderingServer.NINE_PATCH_TILE, RenderingServer.NINE_PATCH_TILE, false, Color(1, 1, 1, 1)
		)


## `RA`: an antialiased filled rect (eight feather primitives around it).
class AaRectNode extends Node2D:
	func _draw() -> void:
		draw_rect(Rect2(8, 8, 48, 32), Color(1, 1, 1, 1), true, -1.0, true)


## `BL`: a white panel, then a polygon at alpha .6 over it and over the background.
class BlendNode extends Node2D:
	func _draw() -> void:
		draw_rect(Rect2(0, 0, 64, 48), Color(1, 1, 1, 1))
		draw_colored_polygon(
			PackedVector2Array([Vector2(32, 16), Vector2(96, 16), Vector2(96, 64), Vector2(32, 64)]),
			Color(0.2, 0.4, 1, 0.6)
		)
