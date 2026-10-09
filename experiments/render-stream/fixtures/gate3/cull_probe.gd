extends Control
## `CU`, the cull probe (../../protocol/gate3-design.md Q6b, Q1c step 7). A plain Control with no
## clip whose own draw lies 56 px to the right of its rect. Control's NOTIFICATION_DRAW sets the
## item's custom rect to Rect2(0, size) (scene/gui/control.cpp:3900), and the canvas cull draws an
## item only when that rect touches the viewport (servers/rendering/renderer_canvas_cull.cpp:249),
## so while the rect lies wholly left of x = 0 nothing is drawn, even though the command would land
## on screen.

var color: Color = Color(0.6, 0.4, 1, 1)


func _draw() -> void:
	draw_rect(Rect2(56, 0, 32, 32), color)
