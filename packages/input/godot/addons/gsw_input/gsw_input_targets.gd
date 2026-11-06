class_name GswInputTargets
extends RefCounted
## Pointer targets for GswInputInjector (docs/input.md "Pointer targets", IN12): resolves a
## source's declared handles to live nodes, places a targeted event by the `retarget` policy,
## applies `missing_target`, tags the event with `gsw_target` meta and reports mismatches.
## GswInputPointer calls `place()` before it builds an event; a record without `target` (or with
## target 0) never reaches it, so a sender without targets costs nothing here.
##
## Resolution, once per handle (the weak refs are re-resolved only when a node is freed or leaves
## the tree):
##   - with `scene`: every instance root whose `scene_file_path` is `scene` (one walk of the tree
##     per resolution), then `path` under it ("." is the root itself). Several live instances make
##     the path ambiguous: the one the coordinate lands on wins, else the target is missing
##     (counted `target-ambiguous`), never a guess;
##   - without `scene`: an absolute NodePath ("/root/...") from the tree root, a relative one
##     from the current scene (the tree root when there is none);
##   - an identity with only `item` names no node here (a renderer id): missing.
##
## Placement (host root-window px, `CanvasItem.get_screen_transform()`):
##   - a Control "lands" when the point is inside `Rect2(Vector2.ZERO, size)` through the inverse
##     of its screen transform; another CanvasItem when `transform * local` is within
##     `tolerance` px of the point; a node that is not a CanvasItem is never moved;
##   - "off" keeps the coordinate, "when-missed" moves a missed event to `transform * local`,
##     "always" moves every targeted event there;
##   - a press binds its target and the offset it was moved by until its release: every event of
##     that held button (or touch) moves by the same offset and carries the press's target, so
##     drags and sliders stay on their node.
## A node that cannot be resolved or is not visible in tree is missing: `target_missing` is
## emitted and the event goes by its coordinate ("coordinate") or is dropped ("drop"; releases
## are never dropped, so nothing stays held).

const OFF: String = "off"
const WHEN_MISSED: String = "when-missed"
const ALWAYS: String = "always"
const COORDINATE: String = "coordinate"
const DROP: String = "drop"
const META: StringName = &"gsw_target"

## "off", "when-missed" (default) or "always".
var retarget: String = WHEN_MISSED
## "coordinate" (default) or "drop".
var missing_target: String = COORDINATE
## Emit `target_mismatch` from `verify()` (driven by `GswInputInjector.tick`).
var verify_targets: bool = false
## How far (host px) a non-Control CanvasItem's `transform * local` may sit from the point and
## still count as landed.
var tolerance: float = 1.0

## `pointer_target(source, event, node, local)`, `target_missing(source, identity)`,
## `target_mismatch(source, identity, hovered)`, `count(code)`.
var _on_target: Callable
var _on_missing: Callable
var _on_mismatch: Callable
var _count: Callable
## The last targeted mouse event to verify: [source, declaration, node WeakRef].
var _verify: Array = []


func _init(on_target: Callable, on_missing: Callable, on_mismatch: Callable, count: Callable) -> void:
	_on_target = on_target
	_on_missing = on_missing
	_on_mismatch = on_mismatch
	_count = count


## Where a targeted event goes. `handles` and `resolved` are the source's declaration table and
## its resolution cache; `binding` is the held press's (empty when none). Returns
## {position: Vector2, drop: bool, meta: Dictionary (empty: none), node: Node or null,
## local: Vector2, binding: Dictionary (what a press binds)}.
func place(source: String, handles: Dictionary, resolved: Dictionary, record: Dictionary, position: Vector2, binding: Dictionary, release: bool) -> Dictionary:
	if not binding.is_empty():
		return _bound(binding, position)
	var out: Dictionary = {"position": position, "drop": false, "meta": {}, "node": null, "local": Vector2.ZERO, "binding": {}}
	var handle: int = record.get("target", 0)
	if handle == 0 or not handles.has(handle):
		return out
	var declaration: Dictionary = handles[handle]
	var local: Vector2 = GswInputPointer._vec(record.get("local"))
	out["local"] = local
	out["meta"] = {"path": declaration.get("path", ""), "local": local, "handle": handle}
	var node: Node = _resolve(handles, resolved, handle, position, local)
	var item: CanvasItem = node as CanvasItem
	if node == null or (item != null and not item.is_visible_in_tree()):
		_on_missing.call(source, declaration)
		if missing_target == DROP and not release:
			out["drop"] = true
			return out
		out["binding"] = {"handle": handle, "offset": Vector2.ZERO, "declaration": declaration, "node": null, "local": local}
		return out
	var placed: Vector2 = position
	if item != null and retarget != OFF:
		var xf: Transform2D = item.get_screen_transform()
		if retarget == ALWAYS or not _lands(item, xf, position, local, tolerance):
			placed = xf * local
	out["position"] = placed
	out["node"] = node
	out["binding"] = {"handle": handle, "offset": placed - position, "declaration": declaration, "node": weakref(node), "local": local}
	return out


## Tag `event`, emit `pointer_target`, and remember a mouse event for `verify()`.
func tag(source: String, event: InputEvent, placement: Dictionary) -> void:
	var meta: Dictionary = placement["meta"]
	if meta.is_empty():
		return
	event.set_meta(META, meta)
	var node: Node = placement["node"]
	if node != null:
		var local: Vector2 = placement["local"]
		_on_target.call(source, event, node, local)
	if verify_targets and event is InputEventMouse:
		var handle: int = meta["handle"]
		var declaration: Dictionary = {"handle": handle, "path": meta["path"]}
		_verify = [source, declaration, weakref(node) if node != null else null]


## `target_mismatch` for the last targeted mouse event, when the hovered Control is neither its
## target nor inside it (or nothing is hovered). Only Control targets are verified.
func verify(root: Viewport) -> void:
	if _verify.is_empty():
		return
	var pending: Array = _verify
	_verify = []
	var ref: WeakRef = pending[2]
	var target: Control = (ref.get_ref() as Control) if ref != null else null
	if target == null or root == null:
		return
	var hovered: Control = root.gui_get_hovered_control()
	if hovered == target or (hovered != null and target.is_ancestor_of(hovered)):
		return
	var source: String = pending[0]
	var declaration: Dictionary = pending[1]
	_on_mismatch.call(source, declaration, hovered)


## A held press's binding: the press's offset and target.
static func _bound(binding: Dictionary, position: Vector2) -> Dictionary:
	var offset: Vector2 = binding["offset"]
	var placed: Vector2 = position + offset
	var declaration: Dictionary = binding["declaration"]
	var handle: int = binding["handle"]
	var local: Vector2 = binding["local"]
	var node: Node = null
	var ref: WeakRef = binding["node"]
	if ref != null:
		node = ref.get_ref() as Node
	var item: CanvasItem = node as CanvasItem
	if item != null and item.is_inside_tree():
		local = item.get_screen_transform().affine_inverse() * placed
	elif node != null and not node.is_inside_tree():
		node = null
	return {
		"position": placed, "drop": false, "node": node, "local": local, "binding": binding,
		"meta": {"path": declaration.get("path", ""), "local": local, "handle": handle},
	}


static func _lands(item: CanvasItem, xf: Transform2D, position: Vector2, local: Vector2, tolerance_px: float) -> bool:
	var control: Control = item as Control
	if control != null:
		return Rect2(Vector2.ZERO, control.size).has_point(xf.affine_inverse() * position)
	return (xf * local).distance_to(position) <= tolerance_px


## The live node of `handle`, resolving (and caching weak refs to the candidates) when needed.
func _resolve(handles: Dictionary, resolved: Dictionary, handle: int, position: Vector2, local: Vector2) -> Node:
	var candidates: Array[Node] = []
	var cached: Array = resolved.get(handle, [])
	var stale: bool = cached.is_empty()
	for item: Variant in cached:
		var ref: WeakRef = item
		var node: Node = ref.get_ref() as Node
		if node == null or not node.is_inside_tree():
			stale = true
			break
		candidates.append(node)
	if stale:
		var declaration: Dictionary = handles[handle]
		candidates = _find(declaration)
		var refs: Array = []
		for node: Node in candidates:
			refs.append(weakref(node))
		resolved[handle] = refs
		if candidates.is_empty():
			# Nothing to cache: the next event looks again (the node may be added later).
			resolved.erase(handle)
	if candidates.size() == 1:
		return candidates[0]
	if candidates.is_empty():
		return null
	var landed: Node = null
	for node: Node in candidates:
		var item: CanvasItem = node as CanvasItem
		if item != null and item.is_visible_in_tree() and _lands(item, item.get_screen_transform(), position, local, tolerance):
			if landed != null:
				landed = null
				break
			landed = node
	if landed == null:
		_count.call("target-ambiguous")
	return landed


static func _find(declaration: Dictionary) -> Array[Node]:
	var out: Array[Node] = []
	var path_text: String = declaration.get("path", "")
	var tree: SceneTree = Engine.get_main_loop() as SceneTree
	if path_text == "" or tree == null:
		return out
	var path := NodePath(path_text)
	if declaration.has("scene"):
		var scene: String = declaration["scene"]
		for root: Node in _instances(tree, scene):
			var node: Node = root.get_node_or_null(path)
			if node != null:
				out.append(node)
		return out
	var base: Node = tree.root
	if not path.is_absolute() and tree.current_scene != null:
		base = tree.current_scene
	var found: Node = base.get_node_or_null(path)
	if found != null:
		out.append(found)
	return out


## Every node under the tree root whose `scene_file_path` is `scene`, in tree order.
static func _instances(tree: SceneTree, scene: String) -> Array[Node]:
	var out: Array[Node] = []
	var stack: Array[Node] = [tree.root]
	while not stack.is_empty():
		var node: Node = stack.pop_back()
		if node.scene_file_path == scene:
			out.append(node)
		var children: Array[Node] = node.get_children()
		children.reverse()
		stack.append_array(children)
	return out
