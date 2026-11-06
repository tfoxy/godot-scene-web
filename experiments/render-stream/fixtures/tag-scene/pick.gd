extends Control
## ID2's pick scene (client-extensions-design.md "Identity v2", the ID2 row; README.md "Pick
## (ID2)"), loaded by tag.gd when RS_FIXTURE_TAG_PICK is set. It lays out one case per Godot GUI
## pick rule the stream must reproduce, tags every CanvasItem with its own name (meta `rs_pick`)
## and its effective filter (meta `rs_mf`: "stop", "pass" or "ignore"; "ignore" for a CanvasItem
## that is not a Control), and at frame start + 20 records Godot's own pick on a 24x16 grid:
## `Viewport.push_input` of a mouse motion at each point, then `gui_get_hovered_control()`.
##
##   Back         full-width PASS ColorRect, the bottom half (what empty points there hit)
##   ZHigh/ZLow   siblings: ZHigh (z_index 5) is drawn over the later ZLow; Godot picks ZLow
##   BParent      a STOP ColorRect with a show_behind_parent child BChild: drawn under it, picked first
##   Card         the STS2 hand card: an IGNORE Control holding an IGNORE Face, a drawn item with no
##                node (made through the RenderingServer at start + 5) and, last, Hitbox, a STOP
##                Control that draws nothing
##   ClipBox      a clip_contents STOP ColorRect whose child Spill reaches outside it, over Under
##   Under/Over   ColorRects in CanvasLayers -1 and 1
##   TopParent    holds TopKid (top_level): a GUI root tried before the later sibling Late
##   Button/Decor a Polygon2D (not a Control) drawn over a STOP ColorRect
##   Rot          a STOP ColorRect rotated 30 degrees
##   Hidden       a hidden STOP ColorRect (with a visible child) over UnderHidden
##   Ghost        a STOP ColorRect at modulate alpha 0 (the walk culls it, Godot picks it) over UnderGhost
##   Veil         a transparent IGNORE ColorRect drawn over VeilButton
##
## RS_FIXTURE_TAG_START (default 0) delays the steps; RS_FIXTURE_QUIT_FRAME (default start + 60)
## quits; RS_FIXTURE_TAG_PICK_LOG names the oracle file, one JSON line:
## {"frame", "size": [w, h], "grid": [24, 16], "filters": {name: rs_mf}, "points": [name|null]},
## points row by row, top first, each at the cell's centre.

const GRID: Vector2i = Vector2i(24, 16)
const STOP: Control.MouseFilter = Control.MOUSE_FILTER_STOP
const PASS: Control.MouseFilter = Control.MOUSE_FILTER_PASS
const IGNORE: Control.MouseFilter = Control.MOUSE_FILTER_IGNORE

var _frame: int = 0
var _start: int = 0
var _quit_frame: int = 60
var _card: Control = null
var _raw: RID = RID()


func _ready() -> void:
	if OS.has_environment("RS_FIXTURE_TAG_START"):
		_start = OS.get_environment("RS_FIXTURE_TAG_START").to_int()
	_quit_frame = 60 + _start
	if OS.has_environment("RS_FIXTURE_QUIT_FRAME"):
		_quit_frame = OS.get_environment("RS_FIXTURE_QUIT_FRAME").to_int()
	_rect(self, "Back", Vector2(0, 175), Vector2(640, 185), PASS, Color(0.15, 0.15, 0.2))
	var zroot: Control = _control(self, "ZRoot", Vector2(5, 5), Vector2(150, 90), IGNORE)
	var zhigh: ColorRect = _rect(zroot, "ZHigh", Vector2(0, 0), Vector2(90, 90), STOP, Color(0.8, 0.2, 0.2))
	zhigh.z_index = 5
	_rect(zroot, "ZLow", Vector2(55, 0), Vector2(90, 90), STOP, Color(0.2, 0.8, 0.2))
	var bparent: ColorRect = _rect(self, "BParent", Vector2(165, 5), Vector2(120, 90), STOP, Color(0.3, 0.3, 0.8))
	var bchild: ColorRect = _rect(bparent, "BChild", Vector2(25, 20), Vector2(70, 50), STOP, Color(0.8, 0.8, 0.2))
	bchild.show_behind_parent = true
	_card = _control(self, "Card", Vector2(305, 5), Vector2(110, 150), IGNORE)
	_rect(_card, "Face", Vector2(0, 0), Vector2(110, 150), IGNORE, Color(0.6, 0.4, 0.2))
	_control(_card, "Hitbox", Vector2(10, 10), Vector2(90, 130), STOP)
	var clip: ColorRect = _rect(self, "ClipBox", Vector2(435, 5), Vector2(80, 90), STOP, Color(0.4, 0.6, 0.6))
	clip.clip_contents = true
	_rect(clip, "Spill", Vector2(45, 10), Vector2(100, 40), STOP, Color(0.9, 0.5, 0.9))
	var top_parent: ColorRect = _rect(self, "TopParent", Vector2(5, 185), Vector2(110, 80), STOP, Color(0.5, 0.5, 0.5))
	var top_kid := ColorRect.new()
	top_kid.top_level = true
	_setup(top_kid, top_parent, "TopKid", Vector2(65, 225), Vector2(90, 60), STOP)
	top_kid.color = Color(0.9, 0.6, 0.1)
	_rect(self, "Late", Vector2(95, 245), Vector2(80, 70), STOP, Color(0.1, 0.6, 0.9))
	_rect(self, "Button", Vector2(195, 185), Vector2(100, 60), STOP, Color(0.7, 0.7, 0.9))
	var decor := Polygon2D.new()
	decor.name = "Decor"
	decor.position = Vector2(180, 200)
	decor.polygon = PackedVector2Array([Vector2(0, 0), Vector2(80, 0), Vector2(80, 80), Vector2(0, 80)])
	decor.color = Color(0.2, 0.5, 0.2, 0.8)
	add_child(decor)
	var rot: ColorRect = _rect(self, "Rot", Vector2(360, 200), Vector2(80, 50), STOP, Color(0.9, 0.3, 0.6))
	rot.rotation = deg_to_rad(30.0)
	_rect(self, "UnderHidden", Vector2(480, 195), Vector2(100, 70), STOP, Color(0.3, 0.9, 0.9))
	var hidden: ColorRect = _rect(self, "Hidden", Vector2(465, 185), Vector2(80, 60), STOP, Color(1, 0, 0))
	_rect(hidden, "HiddenKid", Vector2(0, 0), Vector2(80, 60), STOP, Color(1, 0, 1))
	hidden.visible = false
	_rect(self, "UnderGhost", Vector2(290, 280), Vector2(120, 70), STOP, Color(0.6, 0.9, 0.3))
	var ghost: ColorRect = _rect(self, "Ghost", Vector2(300, 290), Vector2(80, 50), STOP, Color(1, 1, 1))
	ghost.modulate = Color(1, 1, 1, 0)
	_rect(self, "VeilButton", Vector2(470, 290), Vector2(100, 50), STOP, Color(0.9, 0.9, 0.5))
	_rect(self, "Veil", Vector2(440, 280), Vector2(195, 75), IGNORE, Color(0, 0, 0, 0))
	var under := CanvasLayer.new()
	under.name = "UnderLayer"
	under.layer = -1
	add_child(under)
	_rect(under, "Under", Vector2(530, 5), Vector2(105, 90), STOP, Color(0.5, 0.2, 0.7))
	var over := CanvasLayer.new()
	over.name = "OverLayer"
	over.layer = 1
	add_child(over)
	_rect(over, "Over", Vector2(385, 110), Vector2(70, 60), STOP, Color(0.2, 0.2, 0.2))
	set_meta("rs_pick", "Pick")
	set_meta("rs_mf", _mf(self))
	_tag(self)


func _control(parent: Node, n: String, pos: Vector2, sz: Vector2, filter: Control.MouseFilter) -> Control:
	var c := Control.new()
	_setup(c, parent, n, pos, sz, filter)
	return c


func _rect(parent: Node, n: String, pos: Vector2, sz: Vector2, filter: Control.MouseFilter, color: Color) -> ColorRect:
	var r := ColorRect.new()
	r.color = color
	_setup(r, parent, n, pos, sz, filter)
	return r


func _setup(c: Control, parent: Node, n: String, pos: Vector2, sz: Vector2, filter: Control.MouseFilter) -> void:
	c.name = n
	c.mouse_filter = filter
	parent.add_child(c)
	c.position = pos
	c.size = sz


func _mf(n: Node) -> String:
	var c := n as Control
	if c == null:
		return "ignore"
	match c.get_mouse_filter_with_override():
		Control.MOUSE_FILTER_STOP:
			return "stop"
		Control.MOUSE_FILTER_PASS:
			return "pass"
	return "ignore"


func _tag(n: Node) -> void:
	for child: Node in n.get_children():
		if child is CanvasItem:
			child.set_meta("rs_pick", String(child.name))
			child.set_meta("rs_mf", _mf(child))
		_tag(child)


func _process(_delta: float) -> void:
	_frame += 1
	match _frame - _start:
		5:
			# A drawn item with no node over the card (STS2 draws its cards' art this way), made
			# after the capture armed so that a late arm streams it.
			_raw = RenderingServer.canvas_item_create()
			RenderingServer.canvas_item_set_parent(_raw, _card.get_canvas_item())
			RenderingServer.canvas_item_add_rect(_raw, Rect2(0, 0, 110, 150), Color(0.9, 0.7, 0.3))
		20:
			_oracle()
	if _frame >= _quit_frame:
		get_tree().quit()


func _exit_tree() -> void:
	# Freed at teardown, after the last frame: the stream's last transaction still holds it (a free
	# at the quit frame would reach the client's last frame).
	if _raw.is_valid():
		RenderingServer.free_rid(_raw)
		_raw = RID()


func _oracle() -> void:
	if not OS.has_environment("RS_FIXTURE_TAG_PICK_LOG"):
		return
	var vp: Viewport = get_viewport()
	var size: Vector2 = vp.get_visible_rect().size
	var points: Array = []
	for j: int in range(GRID.y):
		for i: int in range(GRID.x):
			var p := Vector2((i + 0.5) * size.x / GRID.x, (j + 0.5) * size.y / GRID.y)
			var ev := InputEventMouseMotion.new()
			ev.position = p
			ev.global_position = p
			vp.push_input(ev, true)
			var c: Control = vp.gui_get_hovered_control()
			points.append(null if c == null else String(c.get_meta("rs_pick", "?" + String(c.name))))
	var filters: Dictionary = {}
	_filters(self, filters)
	var f := FileAccess.open(OS.get_environment("RS_FIXTURE_TAG_PICK_LOG"), FileAccess.WRITE)
	f.store_line(JSON.stringify({
		"frame": _frame,
		"size": [size.x, size.y],
		"grid": [GRID.x, GRID.y],
		"filters": filters,
		"points": points,
	}))
	f.close()
	print("[fixture] pick oracle frame=%d points=%d" % [_frame, points.size()])


func _filters(n: Node, out: Dictionary) -> void:
	if n is CanvasItem:
		out[String(n.get_meta("rs_pick", n.name))] = String(n.get_meta("rs_mf", ""))
	for child: Node in n.get_children():
		_filters(child, out)
