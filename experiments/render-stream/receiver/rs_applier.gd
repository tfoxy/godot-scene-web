class_name RsApplier
extends RefCounted
## Applies RESOLVED render-stream/1 state onto the RenderingServer (gate0-design.md "Q5. Receiver",
## gate1-design.md "Q5. Receiver" and "G1b2").
##
## The applier never reads a patch. It takes the state Rs1Decoder.Stream resolved for a
## transaction (render-stream-1.md "Resolution": `canvases`/`items` keyed by wire id, floats
## inlined, commands with `rect`/`color`) and reconciles it with what it last sent to the
## RenderingServer, by identity: only state that differs from the receiver's own mirror produces
## RenderingServer calls, so a full and a patch encoding of the same frames cost the same calls.
##
## It owns the wire id -> RID maps and makes every RenderingServer call the receiver makes,
## counting each one in `rs_calls`. `apply_record` decodes and validates one record completely
## (Rs1Decoder.decode_record, then Stream.accept) and touches the RenderingServer only when that
## produced no error, so a record that fails costs zero RS calls.

## Every RenderingServer call made through this applier.
var rs_calls: int = 0
## How many RIDs the last dispose() freed.
var disposed_frees: int = 0
## Every RID apply_state() created (items and canvases), and every one it freed, since this
## applier was made. Before a dispose(), created_rids - freed_by_apply is what the applier owns;
## a receiver that reconnects (gate1-design.md G1d) checks that dispose() freed exactly that many
## and that nothing is left (owned_rids() == 0).
var created_rids: int = 0
var freed_by_apply: int = 0

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
	var z_relative: bool = true
	var behind: bool = false
	var draw_index: int = 0
	var content_version: int = -1


## `viewport` is the root viewport; `root_canvas` is its World2D canvas, which wire canvas 1 maps to.
func _init(viewport: RID, root_canvas: RID) -> void:
	_viewport = viewport
	_root_canvas = root_canvas


## Decodes and validates the record at `offset` against `stream` (Rs1Decoder.decode_record, then
## stream.accept). Makes no RenderingServer call. Returns {record: decode_record()'s result,
## errors: PackedStringArray, kind: String ("" when the record did not decode)}.
static func accept_record(data: PackedByteArray, offset: int, stream: Rs1Decoder.Stream) -> Dictionary:
	var record: Dictionary = Rs1Decoder.decode_record(data, offset)
	var errors: PackedStringArray = record["errors"]
	var out: Dictionary = {"record": record, "errors": errors, "kind": ""}
	if errors.size() > 0:
		return out
	var meta: Dictionary = record["meta"]
	out["kind"] = meta["type"]
	out["errors"] = stream.accept(record)
	return out


## accept_record(), then (only when it produced no error) begin_session for a session record or
## apply_state(stream.canvases, stream.items) for a transaction. Returns accept_record()'s
## dictionary plus `stats` (apply_state()'s result for a transaction, {} otherwise).
func apply_record(data: PackedByteArray, offset: int, stream: Rs1Decoder.Stream) -> Dictionary:
	var out: Dictionary = accept_record(data, offset, stream)
	out["stats"] = {}
	var errors: PackedStringArray = out["errors"]
	if errors.size() > 0:
		return out
	var record: Dictionary = out["record"]
	var meta: Dictionary = record["meta"]
	var blocks: Array[PackedFloat32Array] = record["blocks"]
	match out["kind"]:
		"session":
			begin_session(meta, blocks)
		"transaction":
			out["stats"] = apply_state(stream.canvases, stream.items)
	return out


## Session: clear colour, root canvas transform and cull mask on the root viewport. Wire canvas 1
## is the viewport's World2D canvas (never created or freed by the applier).
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
	RenderingServer.viewport_set_canvas_cull_mask(_viewport, Rs1Decoder.as_int(viewport["canvas_cull_mask"]))
	rs_calls += 1


## The current canvas 1 transform floats (x.x, x.y, y.x, y.y, origin.x, origin.y).
func root_canvas_xform() -> PackedFloat32Array:
	return _root_xform


## Reconciles the RenderingServer with one resolved state (Rs1Decoder.Stream's `canvases` and
## `items`, keyed by wire id). Steps follow gate0-design.md Q5 "_process" 2-8, plus the /1 item
## fields `z_relative` and `behind`. Returns {created, freed, reparented, commands_replayed,
## rs_calls, unsupported_commands: Array[Dictionary] of {item, name}}.
func apply_state(canvases: Dictionary, items: Dictionary) -> Dictionary:
	var calls_before: int = rs_calls
	var created: int = 0
	var freed: int = 0
	var reparented: int = 0
	var replayed: int = 0
	var unsupported_commands: Array[Dictionary] = []

	var canvas_order: Array[int] = []
	for id: int in canvases:
		canvas_order.append(id)
	canvas_order.sort()
	var item_order: Array[int] = []
	for id: int in items:
		item_order.append(id)
	item_order.sort()

	# 2. Free vanished items, then vanished canvases other than 1.
	var known_items: Array[int] = []
	known_items.assign(_items.keys())
	known_items.sort()
	for id: int in known_items:
		if items.has(id):
			continue
		var gone: ItemState = _items[id]
		RenderingServer.free_rid(gone.rid)
		rs_calls += 1
		freed += 1
		freed_by_apply += 1
		_detach_from_parent(id, gone.parent_key)
		for child: int in gone.children:
			if _items.has(child):
				_items[child].parent_key = ""
		_items.erase(id)
	var known_canvases: Array[int] = []
	known_canvases.assign(_canvases.keys())
	known_canvases.sort()
	for id: int in known_canvases:
		if id == 1 or canvases.has(id):
			continue
		var gone_canvas: CanvasState = _canvases[id]
		RenderingServer.free_rid(gone_canvas.rid)
		rs_calls += 1
		freed += 1
		freed_by_apply += 1
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
		created_rids += 1
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
		created_rids += 1

	# 4. Parent pass, in id order. set_parent appends to the new parent's list.
	for id: int in item_order:
		var resolved: Dictionary = items[id]
		var wire_parent: String = _parent_key(resolved)
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
	# wire list. Containers in ascending id order, canvases then items.
	var containers: Array[String] = []
	for id: int in canvas_order:
		containers.append(container_key("canvas", id))
	for id: int in item_order:
		containers.append(container_key("item", id))
	for key: String in containers:
		var wire_list: Array[int] = _wire_children(key, canvases, items)
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

	# 6. Setters (all for a new item, changed ones otherwise; floats compared as float32) and
	# 7. content (rebuilt only when content_version changed).
	for id: int in item_order:
		var wire: Dictionary = items[id]
		var state: ItemState = _items[id]
		var is_new: bool = fresh.has(id)
		var xform: PackedFloat32Array = _floats(wire["xform"])
		var modulate: PackedFloat32Array = _floats(wire["modulate"])
		var self_modulate: PackedFloat32Array = _floats(wire["self_modulate"])
		var crect: PackedFloat32Array = _floats(wire["custom_rect_rect"])
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
		var layer: int = Rs1Decoder.as_int(wire["visibility_layer"])
		if is_new or layer != state.visibility_layer:
			RenderingServer.canvas_item_set_visibility_layer(state.rid, layer)
			rs_calls += 1
			state.visibility_layer = layer
		var z: int = Rs1Decoder.as_int(wire["z_index"])
		if is_new or z != state.z_index:
			RenderingServer.canvas_item_set_z_index(state.rid, z)
			rs_calls += 1
			state.z_index = z
		var z_relative: bool = wire["z_relative"]
		if is_new or z_relative != state.z_relative:
			RenderingServer.canvas_item_set_z_as_relative_to_parent(state.rid, z_relative)
			rs_calls += 1
			state.z_relative = z_relative
		var behind: bool = wire["behind"]
		if is_new or behind != state.behind:
			RenderingServer.canvas_item_set_draw_behind_parent(state.rid, behind)
			rs_calls += 1
			state.behind = behind
		var draw_index: int = Rs1Decoder.as_int(wire["draw_index"])
		if is_new or draw_index != state.draw_index:
			RenderingServer.canvas_item_set_draw_index(state.rid, draw_index)
			rs_calls += 1
			state.draw_index = draw_index

		var version: int = Rs1Decoder.as_int(wire["content_version"])
		if is_new or version != state.content_version:
			if not is_new:
				RenderingServer.canvas_item_clear(state.rid)
				rs_calls += 1
			var commands: Array = wire["commands"]
			for value: Variant in commands:
				var command: Dictionary = value
				if command["op"] == "add_rect":
					var rect: PackedFloat32Array = _floats(command["rect"])
					var color: PackedFloat32Array = _floats(command["color"])
					var aa: bool = command["aa"]
					RenderingServer.canvas_item_add_rect(state.rid, _rect(rect, 0), _color(color, 0), aa)
					rs_calls += 1
					replayed += 1
				else:
					var op_name: String = command["name"]
					unsupported_commands.append({"item": id, "name": op_name})
			state.content_version = version

	# 8. Canvas 1 transform on the root viewport. Other canvases are never attached.
	var root: Dictionary = canvases[1]
	var root_xform: PackedFloat32Array = _floats(root["xform"])
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


## Frees every RID this applier created (items, then owned canvases; canvas 1 is the viewport's)
## and forgets all state, so a later begin_session starts clean. Returns how many RIDs it freed,
## also kept in `disposed_frees`.
func dispose() -> int:
	var count: int = 0
	var item_ids: Array[int] = []
	item_ids.assign(_items.keys())
	item_ids.sort()
	for id: int in item_ids:
		RenderingServer.free_rid(_items[id].rid)
		rs_calls += 1
		count += 1
	_items.clear()
	var canvas_ids: Array[int] = []
	canvas_ids.assign(_canvases.keys())
	canvas_ids.sort()
	for id: int in canvas_ids:
		var canvas: CanvasState = _canvases[id]
		if canvas.owned:
			RenderingServer.free_rid(canvas.rid)
			rs_calls += 1
			count += 1
	_canvases.clear()
	_root_xform = PackedFloat32Array()
	disposed_frees = count
	return count


## How many RIDs the applier currently owns (items plus canvases it created).
func owned_rids() -> int:
	var count: int = _items.size()
	for id: int in _canvases:
		if _canvases[id].owned:
			count += 1
	return count


# --------------------------------------------------------------------------- helpers


## "canvas:<id>" / "item:<id>": the key of a container (a canvas or an item with children).
static func container_key(kind: String, id: int) -> String:
	return "%s:%d" % [kind, id]


static func _parent_key(item: Dictionary) -> String:
	var parent: Variant = item["parent"]
	if parent == null:
		return ""
	var link: Dictionary = parent
	var kind: String = link["kind"]
	return container_key(kind, Rs1Decoder.as_int(link["id"]))


static func _wire_children(key: String, canvases: Dictionary, items: Dictionary) -> Array[int]:
	var id: int = key.get_slice(":", 1).to_int()
	if key.begins_with("canvas:"):
		var canvas: Dictionary = canvases[id]
		return Rs1Decoder.int_list(canvas["items"])
	var item: Dictionary = items[id]
	return Rs1Decoder.int_list(item["children"])


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


## A resolved float list as float32 values: comparing two of these compares float32 patterns.
static func _floats(values: Variant) -> PackedFloat32Array:
	var list: Array = values
	return PackedFloat32Array(list)


static func _xform(f: PackedFloat32Array, at: int) -> Transform2D:
	return Transform2D(Vector2(f[at], f[at + 1]), Vector2(f[at + 2], f[at + 3]), Vector2(f[at + 4], f[at + 5]))


static func _color(f: PackedFloat32Array, at: int) -> Color:
	return Color(f[at], f[at + 1], f[at + 2], f[at + 3])


static func _rect(f: PackedFloat32Array, at: int) -> Rect2:
	return Rect2(f[at], f[at + 1], f[at + 2], f[at + 3])
