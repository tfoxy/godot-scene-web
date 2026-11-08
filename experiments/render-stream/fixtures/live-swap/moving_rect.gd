extends Node2D

var _frame: int = 0

func _process(_delta: float) -> void:
	_frame += 1
	queue_redraw()

func _draw() -> void:
	draw_rect(Rect2(10 + (_frame % 100), 20, 64, 48), Color.CORAL)
