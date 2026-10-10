extends Node2D
## A region node of fixtures/gate55-cim: draws `rects[i]` filled in `colors[i]` from `_draw`, one
## `canvas_item_add_rect` each, in local coordinates. Only the marker ever redraws (`set_color`);
## every material, light-mode, inheritance and transform change of the timeline leaves the
## recorded commands alone (gate5_5-design.md D9).

var rects: Array[Rect2] = []
var colors: Array[Color] = []


## The marker's step colour (one rect): the only redraw of the run after step 0.
func set_color(color: Color) -> void:
	colors[0] = color
	queue_redraw()


func _draw() -> void:
	for i: int in range(rects.size()):
		draw_rect(rects[i], colors[i])
