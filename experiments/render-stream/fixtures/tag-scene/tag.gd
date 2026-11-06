extends Node2D
## TAG1's fixture scene (README.md). It knows nothing about the capture: it tags its nodes with
## Godot's own groups and metadata, moves them around on a fixed timeline, and (RS_FIXTURE_TAG_LOG)
## dumps its own identity table -- every CanvasItem in the tree, by canvas-item RID -- as the
## oracle the item_meta rows are checked against (lib/gate8-tag-checks.ts meta-oracle).
##
##   _ready  Hand holds Card1..Card3 (card.tscn: script card.gd, groups and meta set in its
##           _ready), Table and Plain are plain nodes of this scene, Loose is a Label made by code
##           with no owner (scene and path null)
##   5       Board, a TileMapLayer (its rendering quadrant is a canvas item with no node)
##   20      Card2 reparented from Hand to Table (a whole instance: scene and path unchanged)
##   25      Mover, a ColorRect made by code, added to Table (meta rs_tag "mover", int rs_slot 7)
##   30      Early, a ColorRect made by code and NOT added: its item exists a frame before its node
##           enters the tree
##   31      Early added to Table, then put in group rs_hand
##   40      Card3 freed; Card4 instanced into Hand; Plain removed from the tree
##   45      Plain added back (the same node: the same item)
##   50      Mover reparented under VP/Holder (a SubViewport: never adopted, so under a late arm
##           with GRC_UNKNOWN_ITEM=skip its new parent is unknown and Mover is withheld)
##   60      Mover reparented back to Table (late arm: its subtree is re-keyed, fresh ids)
##   70      TAG2 (RS_FIXTURE_TAG_VARIANT set, README.md "Variants"): the variant's change, the game
##           making by hand what a client override makes: `moved` Card1 by (0, -119), `scaled`
##           Card1's DescriptionLabel by 1.24 about its bottom centre, `hidden` Table invisible,
##           `tinted` Hand's modulate (1, 0.5, 0.5, 0.75); `base` nothing
##   80      TAG2 (any variant): Hand moves by (10, 0), a transform-only frame under the overrides
##   100     TAG2 (RS_FIXTURE_TAG_PAUSE_MS): the main thread sleeps that long, so no frame (and no
##           transaction: /12+ carries the shader time in every frame's patch) is made meanwhile;
##           override-redraw animates in that window
##   RS_FIXTURE_QUIT_FRAME (default 200 + start): quit
## RS_FIXTURE_TAG_V2 (ID3, any value; unset: everything above exactly) adds, in _ready, Flipper (a
## ColorRect), Nest (a Control) > NestA (a Panel) > NestB (a ColorRect) > NestC (a ColorRect, PASS)
## with NestD (a Label) beside NestB, Pointy (haspoint.gd: a script _has_point) and Hitbox (a STOP
## Control that draws nothing), all owned by this scene, and the steps
##   40      Card1 and Flipper: set_mouse_filter STOP -> IGNORE
##   50      Card1 and Flipper: set_mouse_filter IGNORE -> PASS
##   60      Nest: mouse_behavior_recursive = DISABLED (every Control below it reads IGNORE)
## with dumps at 40, 50 and 60 too (after the step's change) and at the quit frame.
## RS_FIXTURE_TAG_EXPAND (INP1, any value): the root window stretches canvas_items / expand from
## 640x360, so a GRC_ROOT_SIZE=presentation:<W>x<H> of another aspect is accepted.
## RS_FIXTURE_TAG_START (default 0) delays every step (and dump) by that many frames, so that live
## viewers started beside the host are all connected before the first step.
##
## The oracle lines (JSONL) are written at frames 1, 6, 21, 26, 32, 41, 46, 51, 61 and 150:
## {"frame", "nodes": [{"rid", "class", "script", "scene", "path", "groups", "meta"}]}, groups
## the names of GROUPS the node is in, meta one value per META_KEYS name (a String or StringName
## as itself, an int as its decimal string, else null). Under RS_FIXTURE_TAG_V2 a line also has
## "process_frames" (Engine.get_process_frames() in that _process) and, on a step's frame, "flips"
## ([{"step", "node", "rid", "mouse_filter"}]: the node changed, by its path from this scene, its
## canvas-item RID and its value after), and each node "instance_id" (get_instance_id() in decimal), "mouse_filter"
## (a Control's get_mouse_filter_with_override(), plus 4 when its script implements _has_point;
## null for any other CanvasItem) and "plc_custom" (a Control's custom Callables connected to
## property_list_changed, null otherwise).

const GROUPS: Array[String] = ["rs_hand", "rs_text", "rs_none"]
const META_KEYS: Array[String] = ["rs_tag", "rs_slot", "rs_missing"]
const DUMP_FRAMES: Array[int] = [1, 6, 21, 26, 32, 41, 46, 51, 61, 150]
const V2_DUMP_FRAMES: Array[int] = [40, 50, 60]

var _frame: int = 0
var _start: int = 0
var _quit_frame: int = 200
var _log: FileAccess = null
var _mover: ColorRect = null
var _early: ColorRect = null
var _plain_held: Node = null
var _variant: String = ""
var _pick: bool = false
var _v2: bool = false
var _flips: Array = []


func _ready() -> void:
	if OS.has_environment("RS_FIXTURE_TAG_PICK"):
		# ID2 (README.md "Pick (ID2)"): the pick scene replaces this one before anything is armed.
		_pick = true
		get_tree().change_scene_to_file.call_deferred("res://pick.tscn")
		return
	if OS.has_environment("RS_FIXTURE_TAG_START"):
		_start = OS.get_environment("RS_FIXTURE_TAG_START").to_int()
	_quit_frame = 200 + _start
	if OS.has_environment("RS_FIXTURE_QUIT_FRAME"):
		_quit_frame = OS.get_environment("RS_FIXTURE_QUIT_FRAME").to_int()
	_variant = OS.get_environment("RS_FIXTURE_TAG_VARIANT")
	_v2 = OS.has_environment("RS_FIXTURE_TAG_V2")
	if OS.has_environment("RS_FIXTURE_TAG_EXPAND"):
		# INP1: a presentation of another aspect than 16:9 (GRC_ROOT_SIZE=presentation:<W>x<H>) needs
		# a stretch the root size policy accepts: canvas_items / expand, so the viewport takes the
		# window's aspect and the scene (absolutely positioned) is laid out as it was.
		var root := get_window()
		root.content_scale_mode = Window.CONTENT_SCALE_MODE_CANVAS_ITEMS
		root.content_scale_aspect = Window.CONTENT_SCALE_ASPECT_EXPAND
		root.content_scale_size = Vector2i(640, 360)
	if OS.has_environment("RS_FIXTURE_TAG_LOG"):
		_log = FileAccess.open(OS.get_environment("RS_FIXTURE_TAG_LOG"), FileAccess.WRITE)
	var loose := Label.new()
	loose.name = "Loose"
	loose.text = "loose"
	loose.position = Vector2(20, 20)
	loose.set_meta("rs_tag", "loose")
	add_child(loose)  # no owner: scene and path are null
	if _v2:
		_make_v2()


## ID3's nodes (RS_FIXTURE_TAG_V2), owned by this scene so they have scene-relative paths.
func _make_v2() -> void:
	var flipper := ColorRect.new()
	flipper.name = "Flipper"
	flipper.position = Vector2(200, 60)
	flipper.size = Vector2(24, 24)
	flipper.color = Color(0.9, 0.4, 0.9, 1.0)
	_own(self, flipper)
	var nest := Control.new()
	nest.name = "Nest"
	nest.position = Vector2(240, 60)
	nest.size = Vector2(80, 80)
	_own(self, nest)
	var a := Panel.new()
	a.name = "NestA"
	a.size = Vector2(70, 70)
	_own(nest, a)
	var b := ColorRect.new()
	b.name = "NestB"
	b.position = Vector2(5, 5)
	b.size = Vector2(50, 50)
	b.color = Color(0.2, 0.6, 0.9, 1.0)
	_own(a, b)
	var c := ColorRect.new()
	c.name = "NestC"
	c.position = Vector2(5, 5)
	c.size = Vector2(20, 20)
	c.color = Color(0.9, 0.6, 0.2, 1.0)
	c.mouse_filter = Control.MOUSE_FILTER_PASS
	_own(b, c)
	var d := Label.new()
	d.name = "NestD"
	d.text = "nest"
	d.position = Vector2(4, 56)
	_own(a, d)
	var pointy := ColorRect.new()
	pointy.name = "Pointy"
	pointy.set_script(load("res://haspoint.gd"))
	pointy.position = Vector2(200, 100)
	pointy.size = Vector2(30, 20)
	pointy.color = Color(0.3, 0.9, 0.3, 1.0)
	_own(self, pointy)
	var hitbox := Control.new()
	hitbox.name = "Hitbox"
	hitbox.position = Vector2(200, 130)
	hitbox.size = Vector2(30, 30)
	_own(self, hitbox)


func _own(parent: Node, child: Node) -> void:
	parent.add_child(child)
	child.owner = self


## ID3's steps (RS_FIXTURE_TAG_V2), after the step's TAG1 work.
func _v2_step(step: int) -> void:
	match step:
		40:
			_flip($Hand/Card1 as Control, Control.MOUSE_FILTER_IGNORE)
			_flip($Flipper as Control, Control.MOUSE_FILTER_IGNORE)
		50:
			_flip($Hand/Card1 as Control, Control.MOUSE_FILTER_PASS)
			_flip($Flipper as Control, Control.MOUSE_FILTER_PASS)
		60:
			var nest := $Nest as Control
			nest.mouse_behavior_recursive = Control.MOUSE_BEHAVIOR_DISABLED
			for n: Node in [nest, $Nest/NestA, $Nest/NestA/NestB, $Nest/NestA/NestB/NestC, $Nest/NestA/NestD]:
				_flips.append(_flip_entry(step, n as Control))


func _flip(control: Control, filter: Control.MouseFilter) -> void:
	control.set_mouse_filter(filter)
	_flips.append(_flip_entry(_frame - _start, control))


func _flip_entry(step: int, control: Control) -> Dictionary:
	return {
		"step": step,
		"node": String(get_path_to(control)),
		"rid": str(control.get_canvas_item().get_id()),
		"mouse_filter": _filter(control),
	}


func _make_board() -> void:
	var image := Image.create(32, 32, false, Image.FORMAT_RGBA8)
	image.fill(Color(0.3, 0.3, 0.8, 1.0))
	var atlas := TileSetAtlasSource.new()
	atlas.texture = ImageTexture.create_from_image(image)
	atlas.texture_region_size = Vector2i(16, 16)
	atlas.create_tile(Vector2i(0, 0))
	var tile_set := TileSet.new()
	tile_set.tile_size = Vector2i(16, 16)
	tile_set.add_source(atlas, 0)
	var board := TileMapLayer.new()
	board.name = "Board"
	board.tile_set = tile_set
	board.position = Vector2(20, 60)
	for x: int in range(6):
		for y: int in range(3):
			board.set_cell(Vector2i(x, y), 0, Vector2i(0, 0))
	add_child(board)
	board.owner = self


func _process(_delta: float) -> void:
	if _pick:
		return
	_frame += 1
	match _frame - _start:
		5:
			_make_board()
		20:
			($Hand/Card2 as Node).reparent($Table)
		25:
			_mover = ColorRect.new()
			_mover.name = "Mover"
			_mover.size = Vector2(30, 30)
			_mover.color = Color(0.9, 0.9, 0.1, 1.0)
			_mover.set_meta("rs_tag", "mover")
			_mover.set_meta("rs_slot", 7)
			$Table.add_child(_mover)
		30:
			_early = ColorRect.new()
			_early.name = "Early"
			_early.size = Vector2(20, 20)
			_early.position = Vector2(0, 120)
			_early.set_meta("rs_slot", -3)
			_early.queue_redraw()
		31:
			$Table.add_child(_early)
			_early.add_to_group("rs_hand")
		40:
			($Hand/Card3 as Node).queue_free()
			var card: Control = (load("res://card.tscn") as PackedScene).instantiate()
			card.name = "Card4"
			card.set("slot", 4)
			card.position = Vector2(300, 0)
			$Hand.add_child(card)
			card.owner = self
			_plain_held = $Plain
			remove_child(_plain_held)
		45:
			add_child(_plain_held)
			_plain_held.owner = self
		50:
			_mover.reparent($VP/Holder)
		60:
			_mover.reparent($Table)
		70:
			_apply_variant()
		80:
			if _variant != "":
				($Hand as Node2D).position.x += 10.0
		100:
			if OS.has_environment("RS_FIXTURE_TAG_PAUSE_MS"):
				OS.delay_msec(OS.get_environment("RS_FIXTURE_TAG_PAUSE_MS").to_int())
	if _v2:
		_v2_step(_frame - _start)
	if (
		DUMP_FRAMES.has(_frame - _start)
		or _frame == 1
		or (_v2 and (V2_DUMP_FRAMES.has(_frame - _start) or _frame >= _quit_frame))
	):
		_dump()
	if _frame >= _quit_frame:
		if _log != null:
			_log.close()
		get_tree().quit()


## TAG2's variants: what the game does to the node at the top of a subtree, which an extension's
## override on that item must draw identically (the override-oracle check).
func _apply_variant() -> void:
	match _variant:
		"", "base":
			pass
		"moved":
			($Hand/Card1 as Control).position.y -= 119.0
		"scaled":
			var label: Control = $Hand/Card1/CardContainer/DescriptionLabel
			label.pivot_offset = Vector2(label.size.x / 2.0, label.size.y)
			label.scale = Vector2(1.24, 1.24)
		"hidden":
			($Table as CanvasItem).visible = false
		"tinted":
			($Hand as CanvasItem).modulate = Color(1.0, 0.5, 0.5, 0.75)
		_:
			push_error("tag.gd: unknown RS_FIXTURE_TAG_VARIANT " + _variant)
			get_tree().quit(2)


func _dump() -> void:
	if _log == null:
		return
	var nodes: Array = []
	_collect(get_tree().root, nodes)
	var line: Dictionary = {"frame": _frame, "nodes": nodes}
	if _v2:
		line["process_frames"] = Engine.get_process_frames()
		if not _flips.is_empty():
			line["flips"] = _flips
			_flips = []
	_log.store_line(JSON.stringify(line))
	_log.flush()


func _collect(node: Node, out: Array) -> void:
	var item := node as CanvasItem
	if item != null:
		out.append(_identity(item))
	for child: Node in node.get_children(true):
		_collect(child, out)


func _identity(node: CanvasItem) -> Dictionary:
	var script: Variant = null
	var s: Script = node.get_script() as Script
	if s != null and s.resource_path != "":
		script = s.resource_path
	var root: Node = node
	var scene: String = node.scene_file_path
	if scene == "":
		root = node.owner
		scene = root.scene_file_path if root != null else ""
	var groups: Array = []
	for g: String in GROUPS:
		if node.is_in_group(g):
			groups.append(g)
	var meta: Dictionary = {}
	for k: String in META_KEYS:
		var v: Variant = null
		if node.has_meta(k):
			var raw: Variant = node.get_meta(k)
			if raw is String or raw is StringName:
				v = String(raw)
			elif raw is int:
				v = str(raw)
		meta[k] = v
	var out: Dictionary = {
		"rid": str(node.get_canvas_item().get_id()),
		"class": node.get_class(),
		"script": script,
		"scene": scene if scene != "" else null,
		"path": String(root.get_path_to(node)) if root != null else null,
		"groups": groups,
		"meta": meta,
	}
	if _v2:
		out["instance_id"] = str(node.get_instance_id())
		var control := node as Control
		out["mouse_filter"] = _filter(control) if control != null else null
		var custom: Variant = null
		if control != null:
			custom = 0
			for c: Dictionary in control.get_signal_connection_list("property_list_changed"):
				if (c["callable"] as Callable).is_custom():
					custom += 1
		out["plc_custom"] = custom
	return out


## The pick filter as ID3 defines it: get_mouse_filter_with_override(), plus 4 when the Control's
## script implements _has_point (its rect is then only an upper bound).
func _filter(control: Control) -> int:
	var value: int = control.get_mouse_filter_with_override()
	var s: Script = control.get_script() as Script
	if s != null:
		for m: Dictionary in s.get_script_method_list():
			if m["name"] == "_has_point":
				return value + 4
	return value
