extends Node2D
## The LATE-RES item-adoption cell: a pre-arm Node2D whose `_draw` draws a plain 64x64 rect (no
## texture, so the check can separate the item case from the texture case).


func _draw() -> void:
	draw_rect(Rect2(0, 0, 64, 64), Color(0.9, 0.35, 0.25, 1.0))
