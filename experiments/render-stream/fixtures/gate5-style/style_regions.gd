extends RefCounted
## The gate 5 style fixture's custom nodes (../../protocol/gate5-design.md "Q6f", G5g). The
## NinePatchRects, the default-theme Panel and the RichTextLabel are engine nodes configured by
## gate5_style.gd; these two classes draw what no engine node draws on its own terms.


## A Control that draws one StyleBox over its own rect from `_draw`. Steps change the box's
## properties and queue this node's redraw themselves: the box is not a theme override, so its
## `changed` signal reaches nothing. `flip` wraps the draw in TabBar's vertical flip
## (scene/gui/tab_bar.cpp:634-638): `draw_set_transform((0, h), 0, (1, -1))`, the box, then a reset
## to identity. TabBar takes `h` from `get_draw_rect(rect).size.y`, which equals `size.y` for a box
## with no expand margin and no shadow (the only kind flipped here).
class StyleNode extends Control:
	var box: StyleBox
	var flip: bool = false

	func _draw() -> void:
		var rect: Rect2 = Rect2(Vector2.ZERO, size)
		if flip:
			draw_set_transform(Vector2(0, size.y), 0.0, Vector2(1, -1))
		draw_style_box(box, rect)
		if flip:
			draw_set_transform(Vector2(), 0.0, Vector2(1, 1))


## The step marker: a `Node2D` drawing one axis-aligned rect (gate 5's RectNode).
class RectNode extends Node2D:
	var rect: Rect2 = Rect2()
	var color: Color = Color.BLACK

	func _draw() -> void:
		draw_rect(rect, color)

	func set_color(new_color: Color) -> void:
		color = new_color
		queue_redraw()
