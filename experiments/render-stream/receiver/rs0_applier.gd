class_name Rs0Applier
extends RefCounted
## Replays render-stream/0 records onto the RenderingServer (gate0-design.md, "Q5. Receiver").
##
## Owns the wire id -> RID maps and makes every RenderingServer call the receiver makes, counting
## each one in `rs_calls`. `apply_record` is the only entry point a replayer needs: it decodes and
## validates a record completely, including the cross-record Stream rules, and touches the
## RenderingServer only when that produced no error. A record that fails costs zero RS calls.

## Every RenderingServer call made through this applier.
var rs_calls: int = 0

var _viewport: RID
var _root_canvas: RID
var _canvases: Dictionary[int, CanvasState] = {}
var _items: Dictionary[int, ItemState] = {}
var _root_xform := PackedFloat32Array()


## Receiver-side mirror of one canvas: its RID and the child list in engine append order.
class CanvasState:
	extends RefCounted
	var rid: RID
	var owned: bool
	var children: Array[int] = []


## Receiver-side mirror of one item: the values last sent to the RenderingServer.
class ItemState:
	extends RefCounted
	var rid: RID
	var parent_key: String = ""
	var children: Array[int] = []
	var xform := PackedFloat32Array()
	var modulate := PackedFloat32Array()
	var self_modulate := PackedFloat32Array()
	var custom_rect_floats := PackedFloat32Array()
	var custom_rect: bool = false
	var visible: bool = true
	var clip: bool = false
	var visibility_layer: int = 0
	var z_index: int = 0
	var draw_index: int = 0
	var content_version: int = -1


## `viewport` is the root viewport; `root_canvas` is its World2D canvas, which wire canvas 1 maps to.
func _init(viewport: RID, root_canvas: RID) -> void:
	_viewport = viewport
	_root_canvas = root_canvas


## Decodes, validates and (only when both succeed) applies the record at `offset`. Returns
## {record: decode_record()'s result, errors: PackedStringArray, kind: String ("" if unknown),
##  stats: Dictionary (transactions only: created, freed, reparented, commands_replayed, rs_calls,
##  unsupported_commands: Array of {item, name})}.
func apply_record(data: PackedByteArray, offset: int, stream: Rs0Decoder.Stream) -> Dictionary:
	var record: Dictionary = Rs0Decoder.decode_record(data, offset)
	var errors: PackedStringArray = record["errors"]
	var out: Dictionary = {"record": record, "errors": errors, "kind": "", "stats": {}}
	if errors.size() > 0:
		return out
	errors = stream.accept(record)
	out["errors"] = errors
	var meta: Dictionary = record["meta"]
	var kind: String = meta["type"]
	out["kind"] = kind
	if errors.size() > 0:
		return out
	var blocks: Array[PackedFloat32Array] = record["blocks"]
	match kind:
		"session":
			begin_session(meta, blocks)
		"transaction":
			out["stats"] = apply_transaction(meta, blocks)
	return out


## Session: clear colour, root canvas transform and cull mask on the root viewport.
func begin_session(meta: Dictionary, blocks: Array[PackedFloat32Array]) -> void:
	var clear: PackedFloat32Array = blocks[0]
	RenderingServer.set_default_clear_color(Color(clear[0], clear[1], clear[2], clear[3]))
	rs_calls += 1
	var root := CanvasState.new()
	root.rid = _root_canvas
	root.owned = false
	_canvases[1] = root
	_root_xform = blocks[1]
	RenderingServer.viewport_set_canvas_transform(_viewport, _root_canvas, _xform(_root_xform, 0))
	rs_calls += 1
	var viewport: Dictionary = meta["viewport"]
	RenderingServer.viewport_set_canvas_cull_mask(_viewport, Rs0Decoder.as_int(viewport["canvas_cull_mask"]))
	rs_calls += 1


## The current canvas 1 transform floats (x.x, x.y, y.x, y.y, origin.x, origin.y).
func root_canvas_xform() -> PackedFloat32Array:
	return _root_xform


## Applies one validated transaction. Steps follow gate0-design.md Q5 "_process" 2-8.
func apply_transaction(meta: Dictionary, blocks: Array[PackedFloat32Array]) -> Dictionary:
	var calls_before: int = rs_calls
	var created: int = 0
	var freed: int = 0
	var reparented: int = 0
	var replayed: int = 0
	var unsupported_commands: Array[Dictionary] = []
	var item_f32: PackedFloat32Array = blocks[0]
	var canvas_f32: PackedFloat32Array = blocks[1]
	var cmd_f32: PackedFloat32Array = blocks[2]

	var wire_canvases: Dictionary[int, Dictionary] = {}
	var canvas_order: Array[int] = []
	for value: Variant in meta["canvases"]:
		var canvas: Dictionary = value
		var id: int = Rs0Decoder.as_int(canvas["id"])
		wire_canvases[id] = canvas
		canvas_order.append(id)
	var wire_items: Dictionary[int, Dictionary] = {}
	var item_order: Array[int] = []
	for value: Variant in meta["items"]:
		var item: Dictionary = value
		var id: int = Rs0Decoder.as_int(item["id"])
		wire_items[id] = item
		item_order.append(id)

	# 2. Free vanished items, then vanished canvases other than 1.
	var known_items: Array[int] = []
	known_items.assign(_items.keys())
	known_items.sort()
	for id: int in known_items:
		if wire_items.has(id):
			continue
		var gone: ItemState = _items[id]
		RenderingServer.free_rid(gone.rid)
		rs_calls += 1
		freed += 1
		_detach_from_parent(id, gone.parent_key)
		for child: int in gone.children:
			if _items.has(child):
				_items[child].parent_key = ""
		_items.erase(id)
	var known_canvases: Array[int] = []
	known_canvases.assign(_canvases.keys())
	known_canvases.sort()
	for id: int in known_canvases:
		if id == 1 or wire_canvases.has(id):
			continue
		var gone_canvas: CanvasState = _canvases[id]
		RenderingServer.free_rid(gone_canvas.rid)
		rs_calls += 1
		freed += 1
		for child: int in gone_canvas.children:
			if _items.has(child):
				_items[child].parent_key = ""
		_canvases.erase(id)

	# 3. Create new canvases (never attached) and new items.
	for id: int in canvas_order:
		if _canvases.has(id):
			continue
		var canvas_state := CanvasState.new()
		canvas_state.rid = RenderingServer.canvas_create()
		rs_calls += 1
		canvas_state.owned = true
		_canvases[id] = canvas_state
		created += 1
	var fresh: Dictionary[int, bool] = {}
	for id: int in item_order:
		if _items.has(id):
			continue
		var item_state := ItemState.new()
		item_state.rid = RenderingServer.canvas_item_create()
		rs_calls += 1
		_items[id] = item_state
		fresh[id] = true
		created += 1

	# 4. Parent pass, in id order. set_parent appends to the new parent's list.
	for id: int in item_order:
		var wire_parent: String = _wire_parent_key(wire_items[id])
		var state: ItemState = _items[id]
		if wire_parent == state.parent_key:
			continue
		RenderingServer.canvas_item_set_parent(state.rid, _container_rid(wire_parent))
		rs_calls += 1
		reparented += 1
		_detach_from_parent(id, state.parent_key)
		state.parent_key = wire_parent
		if wire_parent != "":
			_children_of(wire_parent).append(id)

	# 5. Order pass: re-append every child from the first divergence, in wire order. This is the
	# engine's own append-on-set_parent semantics, so the engine's child vector ends up equal to the
	# wire list.
	var containers: Array[String] = []
	for id: int in canvas_order:
		containers.append(Rs0Decoder.container_key("canvas", id))
	for id: int in item_order:
		containers.append(Rs0Decoder.container_key("item", id))
	for key: String in containers:
		var wire_list: Array[int] = _wire_children(key, wire_canvases, wire_items)
		var current: Array[int] = _children_of(key)
		var first: int = _first_divergence(current, wire_list)
		if first < 0:
			continue
		var container_rid: RID = _container_rid(key)
		for i: int in range(first, wire_list.size()):
			var child: int = wire_list[i]
			RenderingServer.canvas_item_set_parent(_items[child].rid, container_rid)
			rs_calls += 1
			reparented += 1
			current.erase(child)
			current.append(child)

	# 6. Setters (all for a new item, changed ones otherwise) and 7. content.
	for index: int in item_order.size():
		var id: int = item_order[index]
		var wire: Dictionary = wire_items[id]
		var state: ItemState = _items[id]
		var is_new: bool = fresh.has(id)
		var base: int = Rs0Decoder.ITEM_FLOATS * index
		var xform: PackedFloat32Array = item_f32.slice(base, base + 6)
		var modulate: PackedFloat32Array = item_f32.slice(base + 6, base + 10)
		var self_modulate: PackedFloat32Array = item_f32.slice(base + 10, base + 14)
		var crect: PackedFloat32Array = item_f32.slice(base + 14, base + 18)
		if is_new or xform != state.xform:
			RenderingServer.canvas_item_set_transform(state.rid, _xform(xform, 0))
			rs_calls += 1
			state.xform = xform
		if is_new or modulate != state.modulate:
			RenderingServer.canvas_item_set_modulate(state.rid, _color(modulate, 0))
			rs_calls += 1
			state.modulate = modulate
		if is_new or self_modulate != state.self_modulate:
			RenderingServer.canvas_item_set_self_modulate(state.rid, _color(self_modulate, 0))
			rs_calls += 1
			state.self_modulate = self_modulate
		var visible: bool = wire["visible"]
		if is_new or visible != state.visible:
			RenderingServer.canvas_item_set_visible(state.rid, visible)
			rs_calls += 1
			state.visible = visible
		var clip: bool = wire["clip"]
		if is_new or clip != state.clip:
			RenderingServer.canvas_item_set_clip(state.rid, clip)
			rs_calls += 1
			state.clip = clip
		var custom_rect: bool = wire["custom_rect"]
		if is_new or custom_rect != state.custom_rect or crect != state.custom_rect_floats:
			RenderingServer.canvas_item_set_custom_rect(state.rid, custom_rect, _rect(crect, 0))
			rs_calls += 1
			state.custom_rect = custom_rect
			state.custom_rect_floats = crect
		var layer: int = Rs0Decoder.as_int(wire["visibility_layer"])
		if is_new or layer != state.visibility_layer:
			RenderingServer.canvas_item_set_visibility_layer(state.rid, layer)
			rs_calls += 1
			state.visibility_layer = layer
		var z: int = Rs0Decoder.as_int(wire["z_index"])
		if is_new or z != state.z_index:
			RenderingServer.canvas_item_set_z_index(state.rid, z)
			rs_calls += 1
			state.z_index = z
		var draw_index: int = Rs0Decoder.as_int(wire["draw_index"])
		if is_new or draw_index != state.draw_index:
			RenderingServer.canvas_item_set_draw_index(state.rid, draw_index)
			rs_calls += 1
			state.draw_index = draw_index

		var commands: Array = wire["commands"]
		var version: int = Rs0Decoder.as_int(wire["content_version"])
		var rebuild: bool = is_new or version != state.content_version
		if rebuild and not is_new:
			RenderingServer.canvas_item_clear(state.rid)
			rs_calls += 1
		for value: Variant in commands:
			var command: Dictionary = value
			if not rebuild:
				break
			if command["op"] == "add_rect":
				var f: int = Rs0Decoder.as_int(command["f"])
				var aa: bool = command["aa"]
				RenderingServer.canvas_item_add_rect(state.rid, _rect(cmd_f32, f), _color(cmd_f32, f + 4), aa)
				rs_calls += 1
				replayed += 1
			else:
				var op_name: String = command["name"]
				unsupported_commands.append({"item": id, "name": op_name})
		state.content_version = version

	# 8. Canvas 1 transform on the root viewport. Other canvases are never attached.
	var root_index: int = canvas_order.find(1)
	var root_xform: PackedFloat32Array = canvas_f32.slice(Rs0Decoder.CANVAS_FLOATS * root_index, Rs0Decoder.CANVAS_FLOATS * root_index + 6)
	if root_xform != _root_xform:
		RenderingServer.viewport_set_canvas_transform(_viewport, _root_canvas, _xform(root_xform, 0))
		rs_calls += 1
		_root_xform = root_xform

	return {
		"created": created,
		"freed": freed,
		"reparented": reparented,
		"commands_replayed": replayed,
		"rs_calls": rs_calls - calls_before,
		"unsupported_commands": unsupported_commands,
	}


## Frees every RID this applier created (items, then owned canvases). Canvas 1 is the viewport's.
func dispose() -> void:
	for id: int in _items:
		RenderingServer.free_rid(_items[id].rid)
		rs_calls += 1
	_items.clear()
	for id: int in _canvases:
		var canvas: CanvasState = _canvases[id]
		if canvas.owned:
			RenderingServer.free_rid(canvas.rid)
			rs_calls += 1
	_canvases.clear()


# --------------------------------------------------------------------------- helpers


func _wire_parent_key(item: Dictionary) -> String:
	var parent: Variant = item["parent"]
	if parent == null:
		return ""
	var link: Dictionary = parent
	var kind: String = link["kind"]
	return Rs0Decoder.container_key(kind, Rs0Decoder.as_int(link["id"]))


func _wire_children(key: String, wire_canvases: Dictionary[int, Dictionary], wire_items: Dictionary[int, Dictionary]) -> Array[int]:
	var id: int = key.get_slice(":", 1).to_int()
	if key.begins_with("canvas:"):
		return Rs0Decoder.int_list(wire_canvases[id]["items"])
	return Rs0Decoder.int_list(wire_items[id]["children"])


## The receiver's model of a container's child list (a reference: callers mutate it in place).
func _children_of(key: String) -> Array[int]:
	var id: int = key.get_slice(":", 1).to_int()
	if key.begins_with("canvas:"):
		return _canvases[id].children
	return _items[id].children


func _container_rid(key: String) -> RID:
	if key == "":
		return RID()
	var id: int = key.get_slice(":", 1).to_int()
	if key.begins_with("canvas:"):
		return _canvases[id].rid
	return _items[id].rid


func _detach_from_parent(id: int, parent_key: String) -> void:
	if parent_key == "":
		return
	var parent_id: int = parent_key.get_slice(":", 1).to_int()
	if parent_key.begins_with("canvas:"):
		if _canvases.has(parent_id):
			_canvases[parent_id].children.erase(id)
	elif _items.has(parent_id):
		_items[parent_id].children.erase(id)


## Index of the first difference between two lists, or -1 when they are equal.
static func _first_divergence(current: Array[int], wire: Array[int]) -> int:
	var shared: int = mini(current.size(), wire.size())
	for i: int in shared:
		if current[i] != wire[i]:
			return i
	if current.size() == wire.size():
		return -1
	return shared


static func _xform(f: PackedFloat32Array, at: int) -> Transform2D:
	return Transform2D(Vector2(f[at], f[at + 1]), Vector2(f[at + 2], f[at + 3]), Vector2(f[at + 4], f[at + 5]))


static func _color(f: PackedFloat32Array, at: int) -> Color:
	return Color(f[at], f[at + 1], f[at + 2], f[at + 3])


static func _rect(f: PackedFloat32Array, at: int) -> Rect2:
	return Rect2(f[at], f[at + 1], f[at + 2], f[at + 3])
