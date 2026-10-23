extends Node2D
## A custom-drawn item: one rect of `size` and `color` at the origin, and a circle when `radius` > 0.

@export var size: Vector2 = Vector2(40, 40)
@export var color: Color = Color(1, 1, 1, 1)
@export var offset: Vector2 = Vector2.ZERO
@export var radius: float = 0.0


func _draw() -> void:
	draw_rect(Rect2(offset, size), color)
	if radius > 0.0:
		draw_circle(offset + size * 0.5, radius, Color(1, 1, 1, 1))
