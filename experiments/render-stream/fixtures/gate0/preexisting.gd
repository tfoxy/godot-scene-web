extends Node2D
## The `Preexisting` node of `preexisting.tscn` (../../protocol/gate0-design.md "Unknown-RID
## policy", ../../protocol/unknown-item-skip.md "Evidence"). It is declared in the `.tscn`, so it
## is constructed while the packed scene is instantiated -- before `GrcLoader` arms the capture --
## and its canvas item is a RID the mirror never saw created. Everything it does afterwards names
## that unknown RID: entering the tree (`canvas_item_set_parent`), every redraw
## (`canvas_item_clear`, `canvas_item_add_rect`).
##
## `PreChild`, created in `_ready()`, is the opposite case: created strictly after arming (the
## mirror sees its `canvas_item_create`) but parented to the unknown item, so under
## `GRC_UNKNOWN_ITEM=skip` it is a known item withheld with its unknown parent.
##
## Both draw one opaque rect outside every Subject/Marker rect of the gate 0 timeline. Step 2 recolours
## `Preexisting` (more calls on the unknown RID); step 3 recolours `PreChild` (new commands on a
## withheld item). The frame counter matches gate0.gd's: both nodes count their own `_process`
## calls from 1, so frame 21 is step 2's applied frame and 31 step 3's. expected.json
## `preexisting` is the single source of these numbers; the literals below must match it.


## `PreChild`: one rect, recoloured on demand.
class ChildRect extends Node2D:
	var rect: Rect2
	var color: Color

	func _draw() -> void:
		draw_rect(rect, color)


const RECT: Rect2 = Rect2(0, 0, 64, 64)
const COLOR_INITIAL: Color = Color(0.6, 0.2, 1, 1)
const COLOR_FROM_STEP_2: Color = Color(1, 0.8, 0.2, 1)
const CHILD_POSITION: Vector2 = Vector2(96, 0)
const CHILD_RECT: Rect2 = Rect2(0, 0, 48, 48)
const CHILD_COLOR_INITIAL: Color = Color(0.2, 0.8, 0.4, 1)
const CHILD_COLOR_FROM_STEP_3: Color = Color(0.4, 0.4, 0.8, 1)
const STEP_2_FRAME: int = 21
const STEP_3_FRAME: int = 31

var color: Color = COLOR_INITIAL
var child: ChildRect
var _frame: int = 0


func _ready() -> void:
	child = ChildRect.new()
	child.name = "PreChild"
	child.rect = CHILD_RECT
	child.color = CHILD_COLOR_INITIAL
	child.position = CHILD_POSITION
	add_child(child)


func _draw() -> void:
	draw_rect(RECT, color)


func _process(_delta: float) -> void:
	_frame += 1
	if _frame == STEP_2_FRAME:
		color = COLOR_FROM_STEP_2
		queue_redraw()
	elif _frame == STEP_3_FRAME:
		child.color = CHILD_COLOR_FROM_STEP_3
		child.queue_redraw()
