class_name RsApplier
extends RefCounted
## Applies RESOLVED render-stream/2 state onto the RenderingServer (gate0-design.md "Q5.
## Receiver", gate1-design.md "Q5. Receiver" and "G1b2", gate2-design.md "Q5. Receiver" and
## "G2b2").
##
## The applier never reads a patch. It takes the state Rs2Decoder.Stream resolved for a
## transaction (render-stream-2.md "Decoded and resolved forms": `canvases`/`items`/`textures`
## keyed by wire id, floats inlined, commands with `rect`/`color`/`modulate`/`src`) and
## reconciles it with what it last sent to the RenderingServer, by identity: only state that
## differs from the receiver's own mirror produces RenderingServer calls, so a full and a patch
## encoding of the same frames cost the same calls.
##
## Textures (gate2-design.md D5, D10, D11): a texture becomes resident when a command of an
## applied state first names it, and stays resident until its entry leaves the table or becomes a
## `freed` tombstone (its RID is then freed; a command still naming it draws as the engine draws
## an invalid texture, white, on both sides). A resident image is re-uploaded only when its
## `hash` or `kind` changes: with the same format, size and mipmaps through texture_2d_update,
## otherwise through texture_replace(rid, texture_2d_create(image)) -- exactly ImageTexture's own
## update / set_image -- so its RID never changes and no command is re-recorded because a texture
## changed. Placeholders are the receiver's own texture_2d_placeholder_create(). Commands naming
## an `unsupported` texture, and `unsupported` commands (unknown-texture, unsupported-op), are
## skipped and recorded, never drawn with a substitute.
##
## It owns the wire id -> RID maps and makes every RenderingServer call the receiver makes,
## counting each one in `rs_calls`. `accept_record` decodes and validates one record completely
## (Rs2Decoder.decode_record, then Stream.accept) and touches the RenderingServer only when that
## produced no error, so a record that fails costs zero RS calls. Payloads come from an
## RsResourceCache the caller owns; every payload a transaction needs is available (fetched,
## verified, decoded) before the first RenderingServer call for that transaction.

const FILTERS: Array[String] = [
	"default", "nearest", "linear", "nearest_mipmaps", "linear_mipmaps",
	"nearest_mipmaps_anisotropic", "linear_mipmaps_anisotropic",
]
const REPEATS: Array[String] = ["default", "disabled", "enabled", "mirror"]

## Every RenderingServer call made through this applier.
var rs_calls: int = 0
## How many RIDs the last dispose() freed.
var disposed_frees: int = 0
## Every RID apply_state() created (items, canvases and textures), and every one it freed, since
## this applier was made. Before a dispose(), created_rids - freed_by_apply is what the applier
## owns; a receiver that reconnects (gate1-design.md G1d) checks that dispose() freed exactly that
## many and that nothing is left (owned_rids() == 0).
var created_rids: int = 0
var freed_by_apply: int = 0
## RS_RECEIVER_SABOTAGE=reupload: every resident image is uploaded again at every applied
## transaction (exists only to fail the redundant-upload check).
var sabotage_reupload: bool = false

var _viewport: RID
var _root_canvas: RID
var _canvases: Dictionary[int, CanvasState] = {}
var _items: Dictionary[int, ItemState] = {}
var _textures: Dictionary[int, TextureState] = {}
var _root_xform := PackedFloat32Array()
var _default_filter: String = ""
var _default_repeat: String = ""


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
	var texture_filter: String = "default"
	var texture_repeat: String = "default"
	var content_version: int = -1


## Receiver-side mirror of one resident texture.
class TextureState:
	extends RefCounted
	var rid: RID
	var kind: String = ""  # image | placeholder | canvas
	var hash: String = ""  # the uploaded content (images)
	var format: String = ""
	var width: int = 0
	var height: int = 0
	var mipmaps: bool = false
	## kind canvas only (G2d): the wire version last applied to this RID's diffuse/filter/repeat,
	## -1 before the first apply so a freshly created canvas texture always gets its setters.
	var canvas_version: int = -1


## `viewport` is the root viewport; `root_canvas` is its World2D canvas, which wire canvas 1 maps to.
func _init(viewport: RID, root_canvas: RID) -> void:
	_viewport = viewport
	_root_canvas = root_canvas


## Decodes and validates the record at `offset` against `stream` (Rs2Decoder.decode_record, then
## stream.accept). Makes no RenderingServer call. Returns {record: decode_record()'s result,
## errors: PackedStringArray, kind: String ("" when the record did not decode)}.
static func accept_record(data: PackedByteArray, offset: int, stream: Rs2Decoder.Stream) -> Dictionary:
	var record: Dictionary = Rs2Decoder.decode_record(data, offset)
	var errors: PackedStringArray = record["errors"]
	var out: Dictionary = {"record": record, "errors": errors, "kind": ""}
	if errors.size() > 0:
		return out
	var meta: Dictionary = record["meta"]
	out["kind"] = meta["type"]
	out["errors"] = stream.accept(data, record)
	return out


## Session: clear colour, root canvas transform and cull mask on the root viewport. Wire canvas 1
## is the viewport's World2D canvas (never created or freed by the applier).
func begin_session(meta: Dictionary, blocks: Array) -> void:
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
	RenderingServer.viewport_set_canvas_cull_mask(_viewport, Rs2Decoder.as_int(viewport["canvas_cull_mask"]))
	rs_calls += 1


## The current canvas 1 transform floats (x.x, x.y, y.x, y.y, origin.x, origin.y).
func root_canvas_xform() -> PackedFloat32Array:
	return _root_xform


## The `ok` image and placeholder entries a command of `items` names that are not resident, or
## resident with another content (gate2-design.md Q5 step 2): {images: Array[String] of hashes to
## have available, ids: Array[int]}. With the reupload sabotage every resident image counts.
func needed(items: Dictionary, textures: Dictionary) -> Dictionary:
	var hashes: Array[String] = []
	var ids: Array[int] = []
	for id: int in _named_texture_ids(items):
		if not textures.has(id):
			continue
		var entry: Dictionary = textures[id]
		if entry["kind"] != "image" or entry["status"] != "ok":
			continue
		var hash: String = entry["hash"]
		var resident: bool = _textures.has(id)
		var same: bool = resident and _textures[id].kind == "image" and _textures[id].hash == hash
		if same and not sabotage_reupload:
			continue
		ids.append(id)
		if not hashes.has(hash):
			hashes.append(hash)
	return {"hashes": hashes, "ids": ids}


## Every texture id a command of `items` names (ascending, each once).
static func _named_texture_ids(items: Dictionary) -> Array[int]:
	var seen: Dictionary[int, bool] = {}
	for item_id: int in items:
		var item: Dictionary = items[item_id]
		for value: Variant in item["commands"]:
			var command: Dictionary = value
			var op: String = command["op"]
			if (op == "add_texture_rect" or op == "add_texture_rect_region") and command["tex"] != null:
				seen[Rs2Decoder.as_int(command["tex"])] = true
	var out: Array[int] = []
	out.assign(seen.keys())
	out.sort()
	return out


## Reconciles the RenderingServer with one resolved state (Rs2Decoder.Stream's `canvases`,
## `items`, `textures` and default filter/repeat). Every payload needed() named must already be
## in `cache`. Steps follow gate2-design.md Q5 "Apply order per transaction" 3-4 (textures, the
## root defaults, then gate 0/1's canvases and items with the /2 item fields). Returns {created,
## freed, reparented, commands_replayed, rs_calls, unsupported_commands: Array[Dictionary] of
## {item, name, reason}, resources: {created, updated, replaced, freed, upload_bytes,
## skipped_commands}, uploads: Array[Dictionary] of {id, hash, op, data_bytes}}.
func apply_state(stream: Rs2Decoder.Stream, cache: RsResourceCache) -> Dictionary:
	var calls_before: int = rs_calls
	var created: int = 0
	var freed: int = 0
	var reparented: int = 0
	var replayed: int = 0
	var unsupported_commands: Array[Dictionary] = []
	var canvases: Dictionary = stream.canvases
	var items: Dictionary = stream.items
	var textures: Dictionary = stream.textures

	# Textures (Q5 step 3): free what left the table or became a tombstone, then make resident
	# (or re-upload) every texture a command names.
	var tex_created: int = 0
	var tex_updated: int = 0
	var tex_replaced: int = 0
	var tex_freed: int = 0
	var upload_bytes: int = 0
	var uploads: Array[Dictionary] = []
	var resident_ids: Array[int] = []
	resident_ids.assign(_textures.keys())
	resident_ids.sort()
	for id: int in resident_ids:
		var gone: bool = not textures.has(id)
		if not gone:
			var entry: Dictionary = textures[id]
			gone = entry["status"] == "freed"
		if not gone:
			continue
		RenderingServer.free_rid(_textures[id].rid)
		rs_calls += 1
		freed_by_apply += 1
		tex_freed += 1
		_textures.erase(id)
	for id: int in _named_texture_ids(items):
		if not textures.has(id):
			continue
		var entry: Dictionary = textures[id]
		var kind: String = entry["kind"]
		var status: String = entry["status"]
		if status != "ok":
			continue  # unsupported: skipped at the command; freed: drawn as RID()
		if kind == "placeholder":
			if _textures.has(id) and _textures[id].kind == "placeholder":
				continue
			var placeholder: RID = RenderingServer.texture_2d_placeholder_create()
			rs_calls += 1
			if _textures.has(id):
				RenderingServer.texture_replace(_textures[id].rid, placeholder)
				rs_calls += 1
				_textures[id].kind = "placeholder"
				_textures[id].hash = ""
				tex_replaced += 1
			else:
				var state := TextureState.new()
				state.rid = placeholder
				state.kind = "placeholder"
				_textures[id] = state
				created_rids += 1
				tex_created += 1
			uploads.append({"id": id, "hash": null, "op": "placeholder", "data_bytes": 0})
			continue
		if kind == "canvas":
			# gate2-design.md Q5/G2d: canvas_texture_create, then diffuse/filter/repeat
			# (canvas_texture_set_channel(DIFFUSE), _set_texture_filter, _set_texture_repeat),
			# version-driven: re-applied only when the wire version actually changed. The
			# diffuse's own RID must already be resident (it is always also named by a plain
			# draw command in this fixture; D5's lazy residency covers it).
			var wire_version: int = Rs2Decoder.as_int(entry["version"])
			if not _textures.has(id):
				var ct_rid: RID = RenderingServer.canvas_texture_create()
				rs_calls += 1
				var state := TextureState.new()
				state.rid = ct_rid
				state.kind = "canvas"
				_textures[id] = state
				created_rids += 1
				tex_created += 1
				uploads.append({"id": id, "hash": null, "op": "canvas", "data_bytes": 0})
			var canvas_state: TextureState = _textures[id]
			if canvas_state.canvas_version != wire_version:
				var canvas_info: Dictionary = entry["canvas"]
				var diffuse_rid := RID()
				if canvas_info["diffuse"] != null:
					var diffuse_id: int = Rs2Decoder.as_int(canvas_info["diffuse"])
					if _textures.has(diffuse_id):
						diffuse_rid = _textures[diffuse_id].rid
				RenderingServer.canvas_texture_set_channel(canvas_state.rid, RenderingServer.CANVAS_TEXTURE_CHANNEL_DIFFUSE, diffuse_rid)
				rs_calls += 1
				var ct_filter: String = canvas_info["filter"]
				RenderingServer.canvas_texture_set_texture_filter(canvas_state.rid, FILTERS.find(ct_filter) as RenderingServer.CanvasItemTextureFilter)
				rs_calls += 1
				var ct_repeat: String = canvas_info["repeat"]
				RenderingServer.canvas_texture_set_texture_repeat(canvas_state.rid, REPEATS.find(ct_repeat) as RenderingServer.CanvasItemTextureRepeat)
				rs_calls += 1
				canvas_state.canvas_version = wire_version
			continue
		if kind != "image":
			continue
		var hash: String = entry["hash"]
		var resident: bool = _textures.has(id)
		if resident and _textures[id].kind == "image" and _textures[id].hash == hash and not sabotage_reupload:
			continue
		var decoded: Dictionary = cache.decoded(hash)
		var image: Image = RsTexturePayload.make_image(decoded)
		var data: PackedByteArray = decoded["data"]
		var format: String = decoded["format"]
		var width: int = decoded["width"]
		var height: int = decoded["height"]
		var mipmaps: bool = decoded["mipmaps"]
		var op: String = ""
		if not resident:
			var state := TextureState.new()
			state.rid = RenderingServer.texture_2d_create(image)
			rs_calls += 1
			state.kind = "image"
			_textures[id] = state
			created_rids += 1
			tex_created += 1
			op = "create"
		else:
			var state: TextureState = _textures[id]
			if state.kind == "image" and state.format == format and state.width == width and state.height == height and state.mipmaps == mipmaps:
				# ImageTexture::update (scene/resources/image_texture.cpp:114-124).
				RenderingServer.texture_2d_update(state.rid, image, 0)
				rs_calls += 1
				tex_updated += 1
				op = "update"
			else:
				# ImageTexture::set_image (image_texture.cpp:97-103): the RID stays.
				var replacement: RID = RenderingServer.texture_2d_create(image)
				rs_calls += 1
				RenderingServer.texture_replace(state.rid, replacement)
				rs_calls += 1
				tex_replaced += 1
				op = "replace"
		var texture_state: TextureState = _textures[id]
		texture_state.kind = "image"
		texture_state.hash = hash
		texture_state.format = format
		texture_state.width = width
		texture_state.height = height
		texture_state.mipmaps = mipmaps
		upload_bytes += data.size()
		uploads.append({"id": id, "hash": hash, "op": op, "data_bytes": data.size()})

	# The root viewport's defaults (Q5 step 3), only when they change.
	var default_filter: String = stream.default_texture_filter
	var default_repeat: String = stream.default_texture_repeat
	if default_filter != _default_filter:
		RenderingServer.viewport_set_default_canvas_item_texture_filter(_viewport, FILTERS.find(default_filter) as RenderingServer.CanvasItemTextureFilter)
		rs_calls += 1
		_default_filter = default_filter
	if default_repeat != _default_repeat:
		RenderingServer.viewport_set_default_canvas_item_texture_repeat(_viewport, REPEATS.find(default_repeat) as RenderingServer.CanvasItemTextureRepeat)
		rs_calls += 1
		_default_repeat = default_repeat

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
		var gone_item: ItemState = _items[id]
		RenderingServer.free_rid(gone_item.rid)
		rs_calls += 1
		freed += 1
		freed_by_apply += 1
		_detach_from_parent(id, gone_item.parent_key)
		for child: int in gone_item.children:
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
	var skipped: int = 0
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
		var layer: int = Rs2Decoder.as_int(wire["visibility_layer"])
		if is_new or layer != state.visibility_layer:
			RenderingServer.canvas_item_set_visibility_layer(state.rid, layer)
			rs_calls += 1
			state.visibility_layer = layer
		var z: int = Rs2Decoder.as_int(wire["z_index"])
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
		var draw_index: int = Rs2Decoder.as_int(wire["draw_index"])
		if is_new or draw_index != state.draw_index:
			RenderingServer.canvas_item_set_draw_index(state.rid, draw_index)
			rs_calls += 1
			state.draw_index = draw_index
		# /2 item fields (gate2-design.md Q5 step 4): the item's own default filter and repeat. A
		# new RenderingServer item starts at DEFAULT, so only a different value is a call.
		var texture_filter: String = wire["texture_filter"]
		if texture_filter != state.texture_filter:
			RenderingServer.canvas_item_set_default_texture_filter(state.rid, FILTERS.find(texture_filter) as RenderingServer.CanvasItemTextureFilter)
			rs_calls += 1
			state.texture_filter = texture_filter
		var texture_repeat: String = wire["texture_repeat"]
		if texture_repeat != state.texture_repeat:
			RenderingServer.canvas_item_set_default_texture_repeat(state.rid, REPEATS.find(texture_repeat) as RenderingServer.CanvasItemTextureRepeat)
			rs_calls += 1
			state.texture_repeat = texture_repeat

		var version: int = Rs2Decoder.as_int(wire["content_version"])
		if is_new or version != state.content_version:
			if not is_new:
				RenderingServer.canvas_item_clear(state.rid)
				rs_calls += 1
			var commands: Array = wire["commands"]
			for value: Variant in commands:
				var command: Dictionary = value
				var op_name: String = command["op"]
				match op_name:
					"add_rect":
						var rect: PackedFloat32Array = _floats(command["rect"])
						var color: PackedFloat32Array = _floats(command["color"])
						var aa: bool = command["aa"]
						RenderingServer.canvas_item_add_rect(state.rid, _rect(rect, 0), _color(color, 0), aa)
						rs_calls += 1
						replayed += 1
					"add_texture_rect", "add_texture_rect_region":
						var texture: Dictionary = _texture_for(command, textures)
						if not texture["drawable"]:
							skipped += 1
							unsupported_commands.append({"item": id, "name": "canvas_item_" + op_name, "reason": "unsupported-texture"})
							continue
						var tex_rid: RID = texture["rid"]
						var dest: PackedFloat32Array = _floats(command["rect"])
						var tint: PackedFloat32Array = _floats(command["modulate"])
						var transpose: bool = command["transpose"]
						if op_name == "add_texture_rect":
							var tile: bool = command["tile"]
							RenderingServer.canvas_item_add_texture_rect(state.rid, _rect(dest, 0), tex_rid, tile, _color(tint, 0), transpose)
						else:
							var src: PackedFloat32Array = _floats(command["src"])
							var clip_uv: bool = command["clip_uv"]
							RenderingServer.canvas_item_add_texture_rect_region(state.rid, _rect(dest, 0), tex_rid, _rect(src, 0), _color(tint, 0), transpose, clip_uv)
						rs_calls += 1
						replayed += 1
					_:
						skipped += 1
						var name: String = command["name"]
						var reason: String = command["reason"]
						unsupported_commands.append({"item": id, "name": name, "reason": reason})
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
		"resources": {
			"created": tex_created,
			"updated": tex_updated,
			"replaced": tex_replaced,
			"freed": tex_freed,
			"upload_bytes": upload_bytes,
			"skipped_commands": skipped,
		},
		"uploads": uploads,
	}


## A texture command's texture (gate2-design.md Q5 step 4): {drawable: bool, rid: RID}. `tex:
## null` and a `freed` tombstone draw with RID() (the engine's default white texture, D11); an
## `unsupported` entry is not drawable (skipped and recorded, D10).
func _texture_for(command: Dictionary, textures: Dictionary) -> Dictionary:
	if command["tex"] == null:
		return {"drawable": true, "rid": RID()}
	var id: int = Rs2Decoder.as_int(command["tex"])
	if not textures.has(id):
		return {"drawable": false, "rid": RID()}
	var entry: Dictionary = textures[id]
	var status: String = entry["status"]
	if status == "freed":
		return {"drawable": true, "rid": RID()}
	if status != "ok" or not _textures.has(id):
		return {"drawable": false, "rid": RID()}
	return {"drawable": true, "rid": _textures[id].rid}


## Frees every RID this applier created (items, then owned canvases, then textures; canvas 1 is
## the viewport's) and forgets all state, so a later begin_session starts clean. Returns how many
## RIDs it freed, also kept in `disposed_frees`.
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
	var texture_ids: Array[int] = []
	texture_ids.assign(_textures.keys())
	texture_ids.sort()
	for id: int in texture_ids:
		RenderingServer.free_rid(_textures[id].rid)
		rs_calls += 1
		count += 1
	_textures.clear()
	_root_xform = PackedFloat32Array()
	_default_filter = ""
	_default_repeat = ""
	disposed_frees = count
	return count


## How many RIDs the applier currently owns (items, canvases it created, resident textures).
func owned_rids() -> int:
	var count: int = _items.size() + _textures.size()
	for id: int in _canvases:
		if _canvases[id].owned:
			count += 1
	return count


## How many textures are resident.
func resident_textures() -> int:
	return _textures.size()


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
	return container_key(kind, Rs2Decoder.as_int(link["id"]))


static func _wire_children(key: String, canvases: Dictionary, items: Dictionary) -> Array[int]:
	var id: int = key.get_slice(":", 1).to_int()
	if key.begins_with("canvas:"):
		var canvas: Dictionary = canvases[id]
		return Rs2Decoder.int_list(canvas["items"])
	var item: Dictionary = items[id]
	return Rs2Decoder.int_list(item["children"])


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
