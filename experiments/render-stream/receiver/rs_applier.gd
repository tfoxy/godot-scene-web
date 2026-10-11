class_name RsApplier
extends RefCounted
## Applies RESOLVED render-stream/5 state onto the RenderingServer (gate0-design.md "Q5.
## Receiver", gate1-design.md "Q5. Receiver" and "G1b2", gate2-design.md "Q5. Receiver" and
## "G2b2", gate4-design.md "Q5. Receiver" and "G4e2": /3's add_msdf_texture_rect_region replays
## as RenderingServer.canvas_item_add_msdf_texture_rect_region with the wire's floats, under the
## same residency rules as the other texture commands; gate5-design.md "Q5. Receiver" and "G5d":
## /4's immediate geometry ops, add_set_transform and add_clip_ignore replay in order as the
## engine's own canvas_item_add_* calls with the wire's floats, ints and counts unchanged -- the
## receiver never computes geometry, and the engine's per-item draw transform (reset per item,
## replaced not composed) and clip-ignore spans follow from the in-order replay alone; and since
## G5e /4's mesh table: every `ok` mesh a command names is made resident from its GRM1 surface
## payloads -- see "Meshes" below -- and add_mesh replays as canvas_item_add_mesh; since G55d
## gate5_5-design.md "Q5. Receiver": /5's shader and material tables, the item material fields and
## canvas modulate -- see "Shaders and materials" below). Older streams (/2 to /4) still apply:
## their resolved state simply has no shaders, materials or material fields.
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
## Meshes (gate5-design.md Q5, D5, D8, G5e): a mesh becomes resident when a command of an applied
## state first names it (lazy, as textures), and is freed when its entry leaves the table or
## becomes a `freed` tombstone; its RID never changes. A new one gets mesh_create, one
## mesh_add_surface per surface (the Dictionary bind, from the decoded GRM1 payload: buffers,
## counts, AABB, uv_scale) and mesh_set_custom_aabb. A resident one whose surface layout (count,
## primitive, format, counts, buffer lengths, AABB and uv_scale) is unchanged gets
## mesh_surface_update_{vertex,attribute,skin,index}_region(mesh, s, 0, buffer) for each buffer
## whose bytes changed -- exactly what the host's engine did, so the surface AABB stays the one
## fixed at add_surface (D8) -- and any layout change gets mesh_clear and every surface again. The
## custom AABB is set whenever it changes (a non-zero one wins in mesh_get_aabb). A command naming
## a `freed`, `unsupported` or absent mesh is skipped and recorded (the engine would draw nothing
## for a freed one, Q1d), never drawn with a substitute.
##
## Shaders and materials (gate5_5-design.md Q5, D5, D6, D8, D9, G55d): apply order is textures,
## meshes, shaders, materials, then items. Residency is lazy: a material is resident while an
## item of an applied state names it as its own `material` (that set holds every effective
## material, D9: the parent chain only ever ends at some item's own material), and a shader while
## a resident material names it; the textures their parameters and default textures name are
## made resident with the commands' textures. A shader is RenderingServer.shader_create() plus
## shader_set_code(rid, code) with the code exactly as its verified GRP1 payload carries it --
## never through a Shader resource, which would preprocess already preprocessed code again; a new
## hash is shader_set_code on the same RID (Shader.code =), and `default_textures` are
## shader_set_default_texture_parameter calls (a removed one with RID()). `source: null` (no code
## yet) is a shader_create alone. A `withheld` shader's code comes from RS_RECEIVER_SHADER_LIBRARY
## (RsResourceCache.library_code(), verified by hash); without it the shader is skipped (not
## created, or freed when its resident code is another hash) and reported in `skipped_shaders`
## (`shader-withheld`). An `unsupported` shader is never compiled. A material is
## material_create(), material_set_shader(rid, shader RID or RID() for none, an unsupported or a
## skipped shader -- the engine then draws with its default shader, as GLES3 draws a material
## whose shader it refuses) and one material_set_param per changed parameter (null for a removed
## one), each value rebuilt as the exact Variant type (_param_variant: `float`/`int` from the
## float64, real_t types narrowed to float32 by their constructors, which is exact, packed arrays
## as Packed*Array, `rid` as the receiver's own RID for that texture id). An `unsupported`
## material is never created: an item naming it draws with no material, recorded as an
## unsupported `canvas_item_set_material` command. Removed shaders and materials are freed (D5:
## no tombstones). Items get canvas_item_set_material (own material RID or RID()),
## canvas_item_set_use_parent_material and canvas_item_set_instance_shader_parameter per changed
## instance parameter (null for a removed one), each only when it differs from what this applier
## last sent (a new item starts at RID(), false and none). Wire canvas 1's `modulate` is
## canvas_set_modulate on the receiver's root canvas, only when it differs from the last value
## applied, starting from the engine's white.
##
## Canvases (render-stream/6, G6b; gate6-design.md D3, Q5): every non-root canvas id gets its own
## canvas_create. While its wire entry is `attached`, it is attached to the receiver's root
## viewport (viewport_attach_canvas, which resets the engine's stacking to (0,0) and its transform
## to identity), stacked (viewport_set_canvas_stacking with the wire's layer and sublayer),
## transformed (viewport_set_canvas_transform) and modulated (canvas_set_modulate), each only when
## it differs from what was last applied; leaving `attached` is viewport_remove_canvas, leaving the
## state is free_rid. Items parented to a canvas are parented to the receiver's canvas for that
## id. Canvases apply after materials and before items (gate2-design.md Q5 order). Wire canvas 1
## stays the viewport's own canvas: its attachment is never touched, and its stacking is (0,0).
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
## Every command op that names a texture through `tex` (render-stream-2.md "Commands",
## render-stream-3.md, render-stream-4.md "Command").
const TEXTURE_OPS: Array[String] = [
	"add_texture_rect", "add_texture_rect_region", "add_msdf_texture_rect_region",
	"add_primitive", "add_polygon", "add_triangle_array", "add_nine_patch", "add_mesh",
]
## The engine's default canvas modulate (RendererCanvasCull::Canvas::modulate).
const WHITE: Array[float] = [1.0, 1.0, 1.0, 1.0]
## render-stream-4.md add_nine_patch axis spellings, indexed by RenderingServer.NinePatchAxisMode.
const NINE_PATCH_AXES: Array[String] = ["stretch", "tile", "tile_fit"]

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
## RS_RECEIVER_SABOTAGE=ignore-clip (gate3-design.md Q5, G3b): every canvas_item_set_clip call
## this applier makes passes false, whatever the wire says. The shadow (ItemState.clip) still
## tracks the true wire value, so the call cadence is exactly an honest receiver's -- only the RS
## argument is corrupted. Exists only to fail checks.
var sabotage_ignore_clip: bool = false
## RS_RECEIVER_SABOTAGE=clip-before-clear (gate3-design.md Q5, G3b): restores the pre-gate-3 bug
## (Q1b) -- the clip setter runs before the content block, in its old position between `visible`
## and `custom_rect`, and a content rebuild's canvas_item_clear does not reset the shadow clip to
## false. Exists only to fail checks.
var sabotage_clip_before_clear: bool = false
## RS_RECEIVER_SABOTAGE=drop-msdf (gate4-design.md Q5, G4e2): every add_msdf_texture_rect_region
## is skipped without a typed record -- the pre-/3 receiver's picture, silently. Exists only to
## fail checks.
var sabotage_drop_msdf: bool = false
## RS_RECEIVER_SABOTAGE=ignore-set-transform (gate5-design.md Q5, G5d): every add_set_transform
## is skipped without a record, so later commands draw untransformed. Exists only to fail checks.
var sabotage_ignore_set_transform: bool = false
## RS_RECEIVER_SABOTAGE=ignore-clip-ignore (gate5-design.md Q5, G5d): every add_clip_ignore is
## skipped without a record, so the span stays clipped. Exists only to fail checks.
var sabotage_ignore_clip_ignore: bool = false
## RS_RECEIVER_SABOTAGE=ignore-nine-patch-axis (gate5-design.md "G5g"): every add_nine_patch is
## drawn with both axes `stretch`, whatever the command says. Exists only to fail checks.
var sabotage_ignore_nine_patch_axis: bool = false
## RS_RECEIVER_SABOTAGE=drop-mesh-surface (gate5-design.md Q5, G5e): a mesh build or rebuild never
## adds the surface at index 1 (and in-place updates of it are dropped). Exists only to fail
## checks.
var sabotage_drop_mesh_surface: bool = false
## RS_RECEIVER_SABOTAGE=stale-mesh (gate5-design.md Q5, G5e): in-place payload changes of a resident
## surface are ignored (no region update); layout changes still rebuild. Exists only to fail
## checks.
var sabotage_stale_mesh: bool = false
## RS_RECEIVER_SABOTAGE=refuse-canvas-texture (protocol/canvas-texture-headless.md "Simulated
## refusal"): every draw whose texture names a canvas-texture entry is skipped, logged with the
## reason the default headless capture gives it (`canvas-texture-headless`) and counted in
## skipped_commands. It replays a recording
## made with GRC_HEADLESS_CANVAS_TEXTURE=synthesize as the default capture would have refused it.
## Exists only to compare pictures; never a fidelity mode.
var sabotage_refuse_canvas_texture: bool = false
## RS_RECEIVER_SABOTAGE=ignore-material (gate5_5-design.md Q5, G55d): canvas_item_set_material is
## never called (the shadow still tracks the wire). Exists only to fail checks.
var sabotage_ignore_material: bool = false
## RS_RECEIVER_SABOTAGE=ignore-canvas-modulate (G55d): canvas_set_modulate is never called.
## Exists only to fail checks.
var sabotage_ignore_canvas_modulate: bool = false
## RS_RECEIVER_SABOTAGE=stale-param (G55e): a material's parameters are applied only when the
## material is created; later parameter changes and removals are ignored. Exists only to fail
## checks.
var sabotage_stale_param: bool = false
## RS_RECEIVER_SABOTAGE=stale-texture (gate6-design.md Q6h, G6a): a resident RGBA8 image keeps its
## first payload; later versions are never uploaded (font atlas pages, LA8, still update, so text
## stays honest). Exists only to fail checks.
var sabotage_stale_texture: bool = false
## RS_RECEIVER_SABOTAGE=ignore-canvas-stacking (gate6-design.md Q5, G6b): extra canvases are
## attached but viewport_set_canvas_stacking is never called, so they draw at the attach default
## (0,0) in canvas RID order.
var sabotage_ignore_canvas_stacking: bool = false

var _viewport: RID
var _root_canvas: RID
var _canvases: Dictionary[int, CanvasState] = {}
var _items: Dictionary[int, ItemState] = {}
var _textures: Dictionary[int, TextureState] = {}
var _meshes: Dictionary[int, MeshState] = {}
var _shaders: Dictionary[int, ShaderState] = {}
var _materials: Dictionary[int, MaterialState] = {}
var _root_xform := PackedFloat32Array()
## The root canvas modulate last sent (G55d), starting at the engine's default, white: a scene
## that never modulates costs no canvas_set_modulate call.
var _root_modulate := PackedFloat32Array(WHITE)
var _default_filter: String = ""
var _default_repeat: String = ""


## Receiver-side mirror of one canvas: its RID and the child list in engine append order; for a
## canvas the applier created (G6b), the attachment, stacking, transform and modulate last applied.
class CanvasState:
	extends RefCounted
	var rid: RID
	var owned: bool
	var children: Array[int] = []
	var attached: bool = false
	var layer: int = 0
	var sublayer: int = 0
	## The viewport transform last applied while attached (identity right after an attach).
	var xform := PackedFloat32Array([1.0, 0.0, 0.0, 1.0, 0.0, 0.0])
	var modulate := PackedFloat32Array(WHITE)


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
	## /5 (G55d): the wire `material` last applied (null or an id), the material RID last sent,
	## use_parent_material, and per instance parameter name the _param_key last sent.
	var material_wire: Variant = null
	var material_rid := RID()
	var use_parent_material: bool = false
	var instance_params: Dictionary[String, String] = {}


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


## Receiver-side mirror of one resident mesh (G5e): what was last sent to the RenderingServer.
class MeshState:
	extends RefCounted
	var rid: RID
	## Per wire surface: the hash whose bytes are on the GPU (the wire's, unless stale-mesh kept an
	## older one) and its layout key.
	var hashes: Array[String] = []
	var layouts: Array[String] = []
	var custom_aabb := PackedFloat32Array()


## Receiver-side mirror of one resident shader (G55d): the code hash on its RID ("" for none) and,
## per default texture "<name>/<index>", the texture RID id last sent.
class ShaderState:
	extends RefCounted
	var rid: RID
	var hash: String = ""
	var defaults: Dictionary[String, int] = {}


## Receiver-side mirror of one resident material (G55d): the shader RID last sent and, per
## parameter name, the _param_key last sent.
class MaterialState:
	extends RefCounted
	var rid: RID
	var shader_rid := RID()
	var params: Dictionary[String, String] = {}


## `viewport` is the root viewport; `root_canvas` is its World2D canvas, which wire canvas 1 maps to.
func _init(viewport: RID, root_canvas: RID) -> void:
	_viewport = viewport
	_root_canvas = root_canvas


## Decodes and validates the record at `offset` against `stream` (Rs2Decoder.decode_record, then
## stream.accept). Makes no RenderingServer call. Returns {record: decode_record()'s result,
## errors: PackedStringArray, kind: String ("" when the record did not decode)}.
static func accept_record(data: PackedByteArray, offset: int, stream: Rs2Decoder.Stream) -> Dictionary:
	var record: Dictionary = Rs2Decoder.decode_record(data, offset, stream.version)
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
## G5e (gate5-design.md Q5): `meshes` adds every surface hash of each `ok` mesh an add_mesh names
## that is not resident with that hash at that index; those hashes are also in `mesh_hashes`
## (their payloads are GRM1, `<hash>.grm` in a store or cache). G55d (gate5_5-design.md Q5): the
## `ok` shaders a resident-to-be material names (see "Shaders and materials") whose `payload`
## code is not on their RID add their hash, also listed in `shader_hashes` (GRP1, `<hash>.grp`),
## and the textures those materials' parameters, their shaders' default textures and the items'
## instance parameters name count like the commands' textures.
func needed(items: Dictionary, textures: Dictionary, meshes: Dictionary = {}, shaders: Dictionary = {}, materials: Dictionary = {}) -> Dictionary:
	var hashes: Array[String] = []
	var ids: Array[int] = []
	var mesh_hashes: Array[String] = []
	var shader_hashes: Array[String] = []
	for shader_id: int in _named_shader_ids(_named_material_ids(items, materials), materials, shaders):
		var shader_entry: Dictionary = shaders[shader_id]
		if shader_entry["source"] != "payload" or shader_entry["hash"] == null:
			continue
		var shader_hash: String = shader_entry["hash"]
		if _shaders.has(shader_id) and _shaders[shader_id].hash == shader_hash:
			continue
		if not hashes.has(shader_hash):
			hashes.append(shader_hash)
			shader_hashes.append(shader_hash)
	for mesh_id: int in _named_mesh_ids(items):
		if not meshes.has(mesh_id):
			continue
		var mesh_entry: Dictionary = meshes[mesh_id]
		if mesh_entry["status"] != "ok":
			continue
		var mesh_surfaces: Array = mesh_entry["surfaces"]
		for k: int in mesh_surfaces.size():
			var surface: Dictionary = mesh_surfaces[k]
			var surface_hash: String = surface["hash"]
			if _meshes.has(mesh_id) and k < _meshes[mesh_id].hashes.size() and _meshes[mesh_id].hashes[k] == surface_hash:
				continue
			if not hashes.has(surface_hash):
				hashes.append(surface_hash)
				mesh_hashes.append(surface_hash)
	for id: int in _all_texture_ids(items, shaders, materials):
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
	return {"hashes": hashes, "ids": ids, "mesh_hashes": mesh_hashes, "shader_hashes": shader_hashes}


## G55d: the `ok` material ids an item of `items` names as its own `material` (ascending, each
## once). Every effective material (D9) is in this set.
static func _named_material_ids(items: Dictionary, materials: Dictionary) -> Array[int]:
	var seen: Dictionary[int, bool] = {}
	for item_id: int in items:
		var item: Dictionary = items[item_id]
		var material: Variant = item.get("material")
		if material == null:
			continue
		var material_id: int = Rs2Decoder.as_int(material)
		if not materials.has(material_id):
			continue
		var entry: Dictionary = materials[material_id]
		if entry["status"] == "ok":
			seen[material_id] = true
	var out: Array[int] = []
	out.assign(seen.keys())
	out.sort()
	return out


## G55d: the `ok` shader ids the materials `material_ids` name (ascending, each once).
static func _named_shader_ids(material_ids: Array[int], materials: Dictionary, shaders: Dictionary) -> Array[int]:
	var seen: Dictionary[int, bool] = {}
	for material_id: int in material_ids:
		var entry: Dictionary = materials[material_id]
		var shader: Variant = entry["shader"]
		if shader == null:
			continue
		var shader_id: int = Rs2Decoder.as_int(shader)
		if not shaders.has(shader_id):
			continue
		var shader_entry: Dictionary = shaders[shader_id]
		if shader_entry["status"] == "ok":
			seen[shader_id] = true
	var out: Array[int] = []
	out.assign(seen.keys())
	out.sort()
	return out


## Every texture id the commands of `items` name, plus (G55d) the `rid` parameters of the named
## materials, their shaders' default textures and the items' `rid` instance parameters
## (ascending, each once).
static func _all_texture_ids(items: Dictionary, shaders: Dictionary, materials: Dictionary) -> Array[int]:
	var seen: Dictionary[int, bool] = {}
	for id: int in _named_texture_ids(items):
		seen[id] = true
	var material_ids: Array[int] = _named_material_ids(items, materials)
	for material_id: int in material_ids:
		var entry: Dictionary = materials[material_id]
		_note_rid_params(entry["params"], seen)
	for shader_id: int in _named_shader_ids(material_ids, materials, shaders):
		var shader_entry: Dictionary = shaders[shader_id]
		for value: Variant in shader_entry["default_textures"]:
			var default_texture: Dictionary = value
			seen[Rs2Decoder.as_int(default_texture["tex"])] = true
	for item_id: int in items:
		var item: Dictionary = items[item_id]
		if item.has("instance_params"):
			_note_rid_params(item["instance_params"], seen)
	var out: Array[int] = []
	out.assign(seen.keys())
	out.sort()
	return out


## Adds the texture id of every `rid` parameter of a resolved parameter list to `seen`.
static func _note_rid_params(params: Variant, seen: Dictionary[int, bool]) -> void:
	var list: Array = params
	for value: Variant in list:
		var param: Dictionary = value
		if param["type"] != "rid" or param["value"] == null:
			continue
		var link: Dictionary = param["value"]
		seen[Rs2Decoder.as_int(link["tex"])] = true


## Every mesh id an add_mesh command of `items` names (ascending, each once).
static func _named_mesh_ids(items: Dictionary) -> Array[int]:
	var seen: Dictionary[int, bool] = {}
	for item_id: int in items:
		var item: Dictionary = items[item_id]
		for value: Variant in item["commands"]:
			var command: Dictionary = value
			if command["op"] == "add_mesh":
				seen[Rs2Decoder.as_int(command["mesh"])] = true
	var out: Array[int] = []
	out.assign(seen.keys())
	out.sort()
	return out


## Every texture id a command of `items` names (ascending, each once).
static func _named_texture_ids(items: Dictionary) -> Array[int]:
	var seen: Dictionary[int, bool] = {}
	for item_id: int in items:
		var item: Dictionary = items[item_id]
		for value: Variant in item["commands"]:
			var command: Dictionary = value
			var op: String = command["op"]
			if TEXTURE_OPS.has(op) and command["tex"] != null:
				seen[Rs2Decoder.as_int(command["tex"])] = true
	var out: Array[int] = []
	out.assign(seen.keys())
	out.sort()
	return out


## Reconciles the RenderingServer with one resolved state (Rs2Decoder.Stream's `canvases`,
## `items`, `textures` and default filter/repeat). Every payload needed() named must already be
## in `cache`. Steps follow gate2-design.md Q5 "Apply order per transaction" 3-4 (textures, the
## root defaults, then gate 0/1's canvases and items with the /2 item fields). Per item, the
## `clip` setter runs after the content block (gate3-design.md Q5, D3, G3b): a content rebuild's
## canvas_item_clear first resets the shadow clip to false (the engine's own reset,
## renderer_canvas_render.h:455), and the setter below only calls canvas_item_set_clip when the
## wire value then differs from that shadow -- RS_RECEIVER_SABOTAGE=clip-before-clear restores the
## pre-gate-3 order and skips the shadow reset; RS_RECEIVER_SABOTAGE=ignore-clip keeps the ordering
## but corrupts the RS argument to false. Returns {created, freed, reparented, commands_replayed,
## rs_calls, unsupported_commands: Array[Dictionary] of {item, name, reason}, resources: {created,
## updated, replaced, freed, upload_bytes, skipped_commands}, uploads: Array[Dictionary] of {id,
## hash, op, data_bytes}, item_calls: Array[Dictionary] of {item, op}, the per-item
## canvas_item_clear / canvas_item_add_rect / canvas_item_add_texture_rect /
## canvas_item_add_texture_rect_region / canvas_item_set_clip calls this apply actually made, in
## call order (test instrumentation for Q5's apply-order cases), msdf_commands: the
## canvas_item_add_msdf_texture_rect_region calls it made (G4e2), geometry_commands: the /4
## immediate-geometry, add_set_transform and add_clip_ignore calls it made (G5d), mesh_commands:
## the canvas_item_add_mesh calls it made, mesh_resources: {meshes_created, meshes_rebuilt,
## meshes_freed, surface_updates, mesh_upload_bytes, skipped_mesh_commands}, mesh_uploads:
## Array[Dictionary] of {id, op (create | rebuild | update | free | custom_aabb), surfaces,
## buffers, bytes} (G5e), material_resources: {shaders_created, shader_code_sets, shaders_freed,
## default_texture_sets, materials_created, materials_freed, material_shader_sets, param_sets,
## instance_param_sets, material_sets, use_parent_material_sets, modulate_sets} (G55d),
## skipped_shaders: Array[Dictionary] of {id, hash, reason ("shader-withheld"), detail},
## param_calls: Array[Dictionary] of {target ("material" | "instance"), id (material or item),
## name, value (the exact Variant sent)} (test instrumentation)}.
func apply_state(stream: Rs2Decoder.Stream, cache: RsResourceCache) -> Dictionary:
	var calls_before: int = rs_calls
	var created: int = 0
	var freed: int = 0
	var reparented: int = 0
	var replayed: int = 0
	var msdf_replayed: int = 0
	var geometry_replayed: int = 0
	var unsupported_commands: Array[Dictionary] = []
	var canvases: Dictionary = stream.canvases
	var items: Dictionary = stream.items
	var textures: Dictionary = stream.textures
	var meshes: Dictionary = stream.meshes
	var shaders: Dictionary = stream.shaders
	var materials: Dictionary = stream.materials
	var mesh_commands: int = 0
	var skipped_mesh: int = 0
	var material_stats: Dictionary = {
		"shaders_created": 0, "shader_code_sets": 0, "shaders_freed": 0, "default_texture_sets": 0,
		"materials_created": 0, "materials_freed": 0, "material_shader_sets": 0, "param_sets": 0,
		"instance_param_sets": 0, "material_sets": 0, "use_parent_material_sets": 0,
		"modulate_sets": 0,
	}
	var skipped_shaders: Array[Dictionary] = []
	var param_calls: Array[Dictionary] = []

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
	for id: int in _all_texture_ids(items, shaders, materials):
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
		if sabotage_stale_texture and resident and _textures[id].kind == "image" and _textures[id].format == "RGBA8":
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

	# Meshes (gate5-design.md Q5 step 3b, G5e).
	var mesh_stats: Dictionary = _apply_meshes(items, meshes, cache)

	# Shaders, then materials (gate5_5-design.md Q5 steps 3c and 3d, G55d).
	_apply_shaders(items, shaders, materials, textures, cache, material_stats, skipped_shaders)
	_apply_materials(items, shaders, materials, textures, material_stats, param_calls)

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

	# 3. Create new canvases and new items.
	var canvas_stats: Dictionary = {"canvases_created": 0, "canvas_attach": 0, "canvas_stacking_sets": 0}
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
		canvas_stats["canvases_created"] = Rs2Decoder.as_int(canvas_stats["canvases_created"]) + 1
	# 3b. (G6b, render-stream/6) attach, stack, transform and modulate the non-root canvases.
	for id: int in canvas_order:
		if id == 1:
			continue
		var wire_canvas: Dictionary = canvases[id]
		_apply_canvas(_canvases[id], wire_canvas, canvas_stats)
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
	# 7. content (rebuilt only when content_version changed). `clip` moves after the content
	# block (render-stream-2.md "Item", D3, G3b): see apply_state()'s docstring for the shadow
	# reset and the two sabotages.
	var skipped: int = 0
	var item_calls: Array[Dictionary] = []
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
		if sabotage_clip_before_clear:
			_apply_clip(state, clip, is_new, id, item_calls)
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
		# /5 item fields (gate5_5-design.md Q5, D9, G55d): item state, never content.
		if wire.has("material"):
			_apply_item_material(id, state, wire, materials, textures, material_stats, unsupported_commands, item_calls, param_calls)

		var version: int = Rs2Decoder.as_int(wire["content_version"])
		if is_new or version != state.content_version:
			if not is_new:
				RenderingServer.canvas_item_clear(state.rid)
				rs_calls += 1
				item_calls.append({"item": id, "op": "clear"})
				# D3 (gate3-design.md Q1b): the engine's own clear resets its clip flag, so the
				# shadow does too -- unless the clip-before-clear sabotage keeps the pre-gate-3 bug.
				if not sabotage_clip_before_clear:
					state.clip = false
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
						item_calls.append({"item": id, "op": "add_rect"})
					"add_texture_rect", "add_texture_rect_region":
						var texture: Dictionary = _texture_for(command, textures)
						if not texture["drawable"]:
							skipped += 1
							unsupported_commands.append({"item": id, "name": "canvas_item_" + op_name, "reason": texture.get("reason", "unsupported-texture")})
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
						item_calls.append({"item": id, "op": op_name})
					"add_msdf_texture_rect_region":
						# gate4-design.md Q5 (G4e2): the engine's own call with the wire's floats.
						if sabotage_drop_msdf:
							continue
						var msdf_texture: Dictionary = _texture_for(command, textures)
						if not msdf_texture["drawable"]:
							skipped += 1
							unsupported_commands.append({"item": id, "name": "canvas_item_" + op_name, "reason": msdf_texture.get("reason", "unsupported-texture")})
							continue
						var msdf_rid: RID = msdf_texture["rid"]
						var msdf_dest: PackedFloat32Array = _floats(command["rect"])
						var msdf_src: PackedFloat32Array = _floats(command["src"])
						var msdf_tint: PackedFloat32Array = _floats(command["modulate"])
						var outline: int = Rs2Decoder.as_int(command["outline"])
						var px_range: float = command["px_range"]
						var scale: float = command["scale"]
						RenderingServer.canvas_item_add_msdf_texture_rect_region(state.rid, _rect(msdf_dest, 0), msdf_rid, _rect(msdf_src, 0), _color(msdf_tint, 0), outline, px_range, scale)
						rs_calls += 1
						replayed += 1
						msdf_replayed += 1
						item_calls.append({"item": id, "op": op_name})
					"add_line", "add_polyline", "add_multiline", "add_circle", "add_primitive", "add_polygon", "add_triangle_array", "add_nine_patch", "add_set_transform", "add_clip_ignore":
						# gate5-design.md Q5 (G5d): the engine's own call, the wire's values unchanged.
						if op_name == "add_set_transform" and sabotage_ignore_set_transform:
							continue
						if op_name == "add_clip_ignore" and sabotage_ignore_clip_ignore:
							continue
						var geometry_tex := RID()
						if TEXTURE_OPS.has(op_name):
							var geometry_texture: Dictionary = _texture_for(command, textures)
							if not geometry_texture["drawable"]:
								skipped += 1
								unsupported_commands.append({"item": id, "name": "canvas_item_" + op_name, "reason": geometry_texture.get("reason", "unsupported-texture")})
								continue
							geometry_tex = geometry_texture["rid"]
						_replay_geometry(state.rid, command, geometry_tex)
						rs_calls += 1
						replayed += 1
						geometry_replayed += 1
						item_calls.append({"item": id, "op": op_name})
					"add_mesh":
						# gate5-design.md Q5 (G5e): the resident mesh's RID, the wire's transform and
						# modulate. A freed, unsupported or absent mesh is skipped and recorded.
						var mesh_id: int = Rs2Decoder.as_int(command["mesh"])
						var mesh_reason: String = ""
						if not meshes.has(mesh_id):
							mesh_reason = "unknown-mesh"
						else:
							var named: Dictionary = meshes[mesh_id]
							var named_status: String = named["status"]
							if named_status == "freed":
								mesh_reason = "mesh-freed"
							elif named_status != "ok":
								mesh_reason = "unsupported-mesh"
							elif not _meshes.has(mesh_id):
								mesh_reason = "mesh-not-resident"
						if mesh_reason != "":
							skipped_mesh += 1
							unsupported_commands.append({"item": id, "name": "canvas_item_add_mesh", "reason": mesh_reason})
							continue
						var mesh_texture: Dictionary = _texture_for(command, textures)
						if not mesh_texture["drawable"]:
							skipped += 1
							unsupported_commands.append({"item": id, "name": "canvas_item_add_mesh", "reason": mesh_texture.get("reason", "unsupported-texture")})
							continue
						var mesh_tex: RID = mesh_texture["rid"]
						var mesh_xform: PackedFloat32Array = _floats(command["transform"])
						var mesh_modulate: PackedFloat32Array = _floats(command["modulate"])
						RenderingServer.canvas_item_add_mesh(state.rid, _meshes[mesh_id].rid, _xform(mesh_xform, 0), _color(mesh_modulate, 0), mesh_tex)
						rs_calls += 1
						replayed += 1
						mesh_commands += 1
						item_calls.append({"item": id, "op": op_name})
					_:
						skipped += 1
						var name: String = command["name"]
						var reason: String = command["reason"]
						unsupported_commands.append({"item": id, "name": name, "reason": reason})
			state.content_version = version

		if not sabotage_clip_before_clear:
			_apply_clip(state, clip, is_new, id, item_calls)

	# 8. Canvas 1 transform on the root viewport (the other canvases' at step 3b).
	var root: Dictionary = canvases[1]
	var root_xform: PackedFloat32Array = _floats(root["xform"])
	if root_xform != _root_xform:
		RenderingServer.viewport_set_canvas_transform(_viewport, _root_canvas, _xform(root_xform, 0))
		rs_calls += 1
		_root_xform = root_xform
	# 9. Canvas 1 modulate (/5, gate5_5-design.md D10, Q5) on the receiver's root canvas.
	if root.has("modulate"):
		var root_modulate: PackedFloat32Array = _floats(root["modulate"])
		if root_modulate != _root_modulate:
			if not sabotage_ignore_canvas_modulate:
				RenderingServer.canvas_set_modulate(_root_canvas, _color(root_modulate, 0))
				rs_calls += 1
				material_stats["modulate_sets"] = Rs2Decoder.as_int(material_stats["modulate_sets"]) + 1
			_root_modulate = root_modulate

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
		"item_calls": item_calls,
		"msdf_commands": msdf_replayed,
		"geometry_commands": geometry_replayed,
		"mesh_commands": mesh_commands,
		"mesh_resources": {
			"meshes_created": mesh_stats["meshes_created"],
			"meshes_rebuilt": mesh_stats["meshes_rebuilt"],
			"meshes_freed": mesh_stats["meshes_freed"],
			"surface_updates": mesh_stats["surface_updates"],
			"mesh_upload_bytes": mesh_stats["mesh_upload_bytes"],
			"skipped_mesh_commands": skipped_mesh,
		},
		"mesh_uploads": mesh_stats["uploads"],
		"material_resources": material_stats,
		"skipped_shaders": skipped_shaders,
		"param_calls": param_calls,
		"canvas_resources": canvas_stats,
	}


## One non-root canvas (G6b, see "Canvases" in the class docs). Counts viewport_attach_canvas and
## viewport_remove_canvas calls in canvas_attach, stacking calls in canvas_stacking_sets.
func _apply_canvas(state: CanvasState, wire: Dictionary, stats: Dictionary) -> void:
	var want_attached: bool = wire["attached"]
	if want_attached and not state.attached:
		RenderingServer.viewport_attach_canvas(_viewport, state.rid)
		rs_calls += 1
		stats["canvas_attach"] = Rs2Decoder.as_int(stats["canvas_attach"]) + 1
		state.attached = true
		# rv.cpp:1264-1266: a fresh CanvasData at (0,0) with an identity transform.
		state.layer = 0
		state.sublayer = 0
		state.xform = PackedFloat32Array([1.0, 0.0, 0.0, 1.0, 0.0, 0.0])
	elif not want_attached and state.attached:
		RenderingServer.viewport_remove_canvas(_viewport, state.rid)
		rs_calls += 1
		stats["canvas_attach"] = Rs2Decoder.as_int(stats["canvas_attach"]) + 1
		state.attached = false
	if state.attached:
		var layer: int = Rs2Decoder.as_int(wire.get("layer", 0))
		var sublayer: int = Rs2Decoder.as_int(wire.get("sublayer", 0))
		if (layer != state.layer or sublayer != state.sublayer) and not sabotage_ignore_canvas_stacking:
			RenderingServer.viewport_set_canvas_stacking(_viewport, state.rid, layer, sublayer)
			rs_calls += 1
			stats["canvas_stacking_sets"] = Rs2Decoder.as_int(stats["canvas_stacking_sets"]) + 1
			state.layer = layer
			state.sublayer = sublayer
		var xform: PackedFloat32Array = _floats(wire["xform"])
		if xform != state.xform:
			RenderingServer.viewport_set_canvas_transform(_viewport, state.rid, _xform(xform, 0))
			rs_calls += 1
			state.xform = xform
	if wire.has("modulate"):
		var modulate: PackedFloat32Array = _floats(wire["modulate"])
		if modulate != state.modulate:
			RenderingServer.canvas_set_modulate(state.rid, _color(modulate, 0))
			rs_calls += 1
			state.modulate = modulate


## gate5-design.md Q5 step 3b (G5e): frees every resident mesh whose entry left the table or became
## a tombstone, then makes every `ok` mesh an add_mesh names resident and current (see "Meshes" in
## the class docs). Every payload needed() named must be in `cache`. Returns {meshes_created,
## meshes_rebuilt, meshes_freed, surface_updates, mesh_upload_bytes, uploads}.
func _apply_meshes(items: Dictionary, meshes: Dictionary, cache: RsResourceCache) -> Dictionary:
	var created: int = 0
	var rebuilt: int = 0
	var mesh_freed: int = 0
	var updates: int = 0
	var upload_bytes: int = 0
	var uploads: Array[Dictionary] = []
	var resident: Array[int] = []
	resident.assign(_meshes.keys())
	resident.sort()
	for id: int in resident:
		var gone: bool = not meshes.has(id)
		if not gone:
			var entry: Dictionary = meshes[id]
			gone = entry["status"] == "freed"
		if not gone:
			continue
		RenderingServer.free_rid(_meshes[id].rid)
		rs_calls += 1
		freed_by_apply += 1
		mesh_freed += 1
		_meshes.erase(id)
		uploads.append({"id": id, "op": "free", "surfaces": [], "buffers": [], "bytes": 0})
	for id: int in _named_mesh_ids(items):
		if not meshes.has(id):
			continue
		var entry: Dictionary = meshes[id]
		if entry["status"] != "ok":
			continue
		var surfaces: Array = entry["surfaces"]
		var wire_hashes: Array[String] = []
		var decoded: Array[Dictionary] = []
		var layouts: Array[String] = []
		for value: Variant in surfaces:
			var surface: Dictionary = value
			var surface_hash: String = surface["hash"]
			wire_hashes.append(surface_hash)
			var payload: Dictionary = cache.decoded(surface_hash)
			decoded.append(payload)
			layouts.append(_layout_key(payload))
		var custom_aabb: PackedFloat32Array = _floats(entry["custom_aabb"])
		if not _meshes.has(id) or layouts != _meshes[id].layouts:
			var op: String = "rebuild"
			if not _meshes.has(id):
				var fresh_state := MeshState.new()
				fresh_state.rid = RenderingServer.mesh_create()
				rs_calls += 1
				created_rids += 1
				_meshes[id] = fresh_state
				created += 1
				op = "create"
			else:
				RenderingServer.mesh_clear(_meshes[id].rid)
				rs_calls += 1
				rebuilt += 1
			var mesh_state: MeshState = _meshes[id]
			var added: Array[int] = []
			var built_bytes: int = 0
			for k: int in decoded.size():
				if sabotage_drop_mesh_surface and k == 1:
					continue
				RenderingServer.mesh_add_surface(mesh_state.rid, _surface_dictionary(decoded[k]))
				rs_calls += 1
				added.append(k)
				built_bytes += _data_bytes(decoded[k])
			mesh_state.hashes = wire_hashes
			mesh_state.layouts = layouts
			upload_bytes += built_bytes
			uploads.append({"id": id, "op": op, "surfaces": added, "buffers": [], "bytes": built_bytes})
			# A new mesh always gets its custom AABB (part of its create row); a rebuild keeps the
			# old one (GLES3's mesh_clear does not reset it) and sets it only when it changed.
			if op == "create" or custom_aabb != mesh_state.custom_aabb:
				RenderingServer.mesh_set_custom_aabb(mesh_state.rid, _aabb(custom_aabb))
				rs_calls += 1
				mesh_state.custom_aabb = custom_aabb
				if op == "rebuild":
					uploads.append({"id": id, "op": "custom_aabb", "surfaces": [], "buffers": [], "bytes": 0})
			continue
		var current: MeshState = _meshes[id]
		for k: int in wire_hashes.size():
			if current.hashes[k] == wire_hashes[k]:
				continue
			if sabotage_stale_mesh:
				continue
			if sabotage_drop_mesh_surface and k == 1:
				current.hashes[k] = wire_hashes[k]
				continue
			var before: Dictionary = cache.decoded(current.hashes[k])
			var after: Dictionary = decoded[k]
			var changed: Array[String] = []
			var surface_bytes: int = 0
			for buffer: String in ["vertex", "attribute", "skin", "index"]:
				var key: String = buffer + "_data"
				var old_bytes: PackedByteArray = before[key]
				var new_bytes: PackedByteArray = after[key]
				if old_bytes == new_bytes:
					continue
				match buffer:
					"vertex":
						RenderingServer.mesh_surface_update_vertex_region(current.rid, k, 0, new_bytes)
					"attribute":
						RenderingServer.mesh_surface_update_attribute_region(current.rid, k, 0, new_bytes)
					"skin":
						RenderingServer.mesh_surface_update_skin_region(current.rid, k, 0, new_bytes)
					"index":
						RenderingServer.mesh_surface_update_index_region(current.rid, k, 0, new_bytes)
				rs_calls += 1
				updates += 1
				changed.append(buffer)
				surface_bytes += new_bytes.size()
			current.hashes[k] = wire_hashes[k]
			upload_bytes += surface_bytes
			uploads.append({"id": id, "op": "update", "surfaces": [k], "buffers": changed, "bytes": surface_bytes})
		if custom_aabb != current.custom_aabb:
			RenderingServer.mesh_set_custom_aabb(current.rid, _aabb(custom_aabb))
			rs_calls += 1
			current.custom_aabb = custom_aabb
			uploads.append({"id": id, "op": "custom_aabb", "surfaces": [], "buffers": [], "bytes": 0})
	return {
		"meshes_created": created, "meshes_rebuilt": rebuilt, "meshes_freed": mesh_freed,
		"surface_updates": updates, "mesh_upload_bytes": upload_bytes, "uploads": uploads,
	}


## gate5_5-design.md Q5 step 3c (G55d): frees every resident shader whose entry left the table
## or is no longer `ok`, then makes every `ok` shader a named material names resident and current
## (see "Shaders and materials" in the class docs). Payload code must be in `cache` (needed());
## `withheld` code comes from the cache's library or the shader is skipped.
func _apply_shaders(items: Dictionary, shaders: Dictionary, materials: Dictionary, textures: Dictionary, cache: RsResourceCache, stats: Dictionary, skipped: Array[Dictionary]) -> void:
	var resident: Array[int] = []
	resident.assign(_shaders.keys())
	resident.sort()
	for id: int in resident:
		var gone: bool = not shaders.has(id)
		if not gone:
			var entry: Dictionary = shaders[id]
			gone = entry["status"] != "ok"
		if gone:
			_free_shader(id, stats)
	for id: int in _named_shader_ids(_named_material_ids(items, materials), materials, shaders):
		var entry: Dictionary = shaders[id]
		var source: Variant = entry["source"]
		var hash: String = ""
		if entry["hash"] != null:
			hash = entry["hash"]
		var code: String = ""
		var current: bool = _shaders.has(id) and _shaders[id].hash == hash
		if not current and source == "payload":
			var decoded: Dictionary = cache.decoded(hash)
			code = decoded["code"]
		elif not current and source == "withheld":
			var library: Dictionary = cache.library_code(hash)
			if not library["ok"]:
				skipped.append({"id": id, "hash": hash, "reason": "shader-withheld", "detail": library["detail"]})
				if _shaders.has(id):
					_free_shader(id, stats)  # its resident code is another hash: never draw stale code
				continue
			code = library["code"]
		if not _shaders.has(id):
			var fresh := ShaderState.new()
			fresh.rid = RenderingServer.shader_create()
			rs_calls += 1
			created_rids += 1
			_shaders[id] = fresh
			stats["shaders_created"] = Rs2Decoder.as_int(stats["shaders_created"]) + 1
		var state: ShaderState = _shaders[id]
		if state.hash != hash:
			# Shader.code = (scene/resources/shader.cpp): shader_set_code on the same RID.
			RenderingServer.shader_set_code(state.rid, code)
			rs_calls += 1
			state.hash = hash
			stats["shader_code_sets"] = Rs2Decoder.as_int(stats["shader_code_sets"]) + 1
		# default_textures (sorted by name, index): one call per changed or removed entry.
		var wanted: Dictionary[String, bool] = {}
		for value: Variant in entry["default_textures"]:
			var default_texture: Dictionary = value
			var name: String = default_texture["name"]
			var index: int = Rs2Decoder.as_int(default_texture["index"])
			var key: String = "%s/%d" % [name, index]
			wanted[key] = true
			var texture_rid: RID = _texture_rid(Rs2Decoder.as_int(default_texture["tex"]), textures)
			if state.defaults.has(key) and state.defaults[key] == texture_rid.get_id():
				continue
			RenderingServer.shader_set_default_texture_parameter(state.rid, name, texture_rid, index)
			rs_calls += 1
			state.defaults[key] = texture_rid.get_id()
			stats["default_texture_sets"] = Rs2Decoder.as_int(stats["default_texture_sets"]) + 1
		var stale_keys: Array[String] = []
		stale_keys.assign(state.defaults.keys())
		for key: String in stale_keys:
			if wanted.has(key):
				continue
			var slash: int = key.rfind("/")
			RenderingServer.shader_set_default_texture_parameter(state.rid, key.substr(0, slash), RID(), key.substr(slash + 1).to_int())
			rs_calls += 1
			state.defaults.erase(key)
			stats["default_texture_sets"] = Rs2Decoder.as_int(stats["default_texture_sets"]) + 1


func _free_shader(id: int, stats: Dictionary) -> void:
	RenderingServer.free_rid(_shaders[id].rid)
	rs_calls += 1
	freed_by_apply += 1
	_shaders.erase(id)
	stats["shaders_freed"] = Rs2Decoder.as_int(stats["shaders_freed"]) + 1


## gate5_5-design.md Q5 step 3d (G55d): frees every resident material whose entry left the table
## or is no longer `ok` (D5), then makes every `ok` material an item names resident and current:
## material_set_shader when its shader RID changed (RID() for none, an unsupported or a skipped
## shader), material_set_param per changed parameter and null per removed one (D6: the map
## survives shader changes). RS_RECEIVER_SABOTAGE=stale-param sets parameters only at creation.
func _apply_materials(items: Dictionary, shaders: Dictionary, materials: Dictionary, textures: Dictionary, stats: Dictionary, param_calls: Array[Dictionary]) -> void:
	var resident: Array[int] = []
	resident.assign(_materials.keys())
	resident.sort()
	for id: int in resident:
		var gone: bool = not materials.has(id)
		if not gone:
			var entry: Dictionary = materials[id]
			gone = entry["status"] != "ok"
		if not gone:
			continue
		RenderingServer.free_rid(_materials[id].rid)
		rs_calls += 1
		freed_by_apply += 1
		_materials.erase(id)
		stats["materials_freed"] = Rs2Decoder.as_int(stats["materials_freed"]) + 1
	for id: int in _named_material_ids(items, materials):
		var entry: Dictionary = materials[id]
		var is_new: bool = not _materials.has(id)
		if is_new:
			var fresh := MaterialState.new()
			fresh.rid = RenderingServer.material_create()
			rs_calls += 1
			created_rids += 1
			_materials[id] = fresh
			stats["materials_created"] = Rs2Decoder.as_int(stats["materials_created"]) + 1
		var state: MaterialState = _materials[id]
		var shader_rid := RID()
		var shader: Variant = entry["shader"]
		if shader != null and _shaders.has(Rs2Decoder.as_int(shader)):
			shader_rid = _shaders[Rs2Decoder.as_int(shader)].rid
		if shader_rid != state.shader_rid:
			RenderingServer.material_set_shader(state.rid, shader_rid)
			rs_calls += 1
			state.shader_rid = shader_rid
			stats["material_shader_sets"] = Rs2Decoder.as_int(stats["material_shader_sets"]) + 1
		if sabotage_stale_param and not is_new:
			continue
		var wanted: Dictionary[String, bool] = {}
		for value: Variant in entry["params"]:
			var param: Dictionary = value
			var name: String = param["name"]
			wanted[name] = true
			var variant: Variant = _param_variant(param, textures)
			var key: String = _param_key(param, variant)
			if state.params.has(name) and state.params[name] == key:
				continue
			RenderingServer.material_set_param(state.rid, name, variant)
			rs_calls += 1
			state.params[name] = key
			stats["param_sets"] = Rs2Decoder.as_int(stats["param_sets"]) + 1
			param_calls.append({"target": "material", "id": id, "name": name, "value": variant})
		var stale_names: Array[String] = []
		stale_names.assign(state.params.keys())
		for name: String in stale_names:
			if wanted.has(name):
				continue
			RenderingServer.material_set_param(state.rid, name, null)
			rs_calls += 1
			state.params.erase(name)
			stats["param_sets"] = Rs2Decoder.as_int(stats["param_sets"]) + 1
			param_calls.append({"target": "material", "id": id, "name": name, "value": null})


## /5 item fields (gate5_5-design.md Q5, D9, G55d), each a call only when it differs from what
## this applier last sent: canvas_item_set_material (the own material's RID, RID() for none or a
## material that is not resident -- an `unsupported` one, recorded as an unsupported
## canvas_item_set_material command when the wire value changes), canvas_item_set_use_parent_material
## and canvas_item_set_instance_shader_parameter per changed instance parameter (null for a
## removed one). RS_RECEIVER_SABOTAGE=ignore-material never calls canvas_item_set_material.
func _apply_item_material(id: int, state: ItemState, wire: Dictionary, materials: Dictionary, textures: Dictionary, stats: Dictionary, unsupported_commands: Array[Dictionary], item_calls: Array[Dictionary], param_calls: Array[Dictionary]) -> void:
	var material_wire: Variant = wire["material"]
	var material_rid := RID()
	var reason: String = ""
	if material_wire != null:
		var material_id: int = Rs2Decoder.as_int(material_wire)
		if _materials.has(material_id):
			material_rid = _materials[material_id].rid
		elif materials.has(material_id):
			reason = "unsupported-material"
		else:
			reason = "unknown-material"
	var wire_changed: bool = typeof(material_wire) != typeof(state.material_wire) or material_wire != state.material_wire
	if reason != "" and wire_changed:
		unsupported_commands.append({"item": id, "name": "canvas_item_set_material", "reason": reason})
	state.material_wire = material_wire
	if material_rid != state.material_rid:
		if not sabotage_ignore_material:
			RenderingServer.canvas_item_set_material(state.rid, material_rid)
			rs_calls += 1
			stats["material_sets"] = Rs2Decoder.as_int(stats["material_sets"]) + 1
			item_calls.append({"item": id, "op": "set_material"})
		state.material_rid = material_rid
	var use_parent: bool = wire["use_parent_material"]
	if use_parent != state.use_parent_material:
		RenderingServer.canvas_item_set_use_parent_material(state.rid, use_parent)
		rs_calls += 1
		state.use_parent_material = use_parent
		stats["use_parent_material_sets"] = Rs2Decoder.as_int(stats["use_parent_material_sets"]) + 1
		item_calls.append({"item": id, "op": "set_use_parent_material"})
	var wanted: Dictionary[String, bool] = {}
	for value: Variant in wire["instance_params"]:
		var param: Dictionary = value
		var name: String = param["name"]
		wanted[name] = true
		var variant: Variant = _param_variant(param, textures)
		var key: String = _param_key(param, variant)
		if state.instance_params.has(name) and state.instance_params[name] == key:
			continue
		RenderingServer.canvas_item_set_instance_shader_parameter(state.rid, name, variant)
		rs_calls += 1
		state.instance_params[name] = key
		stats["instance_param_sets"] = Rs2Decoder.as_int(stats["instance_param_sets"]) + 1
		param_calls.append({"target": "instance", "id": id, "name": name, "value": variant})
	var stale_names: Array[String] = []
	stale_names.assign(state.instance_params.keys())
	for name: String in stale_names:
		if wanted.has(name):
			continue
		RenderingServer.canvas_item_set_instance_shader_parameter(state.rid, name, null)
		rs_calls += 1
		state.instance_params.erase(name)
		stats["instance_param_sets"] = Rs2Decoder.as_int(stats["instance_param_sets"]) + 1
		param_calls.append({"target": "instance", "id": id, "name": name, "value": null})


## The receiver's RID for texture `id` (G55d: a `rid` parameter or a default texture): the
## resident RID of an `ok` entry, RID() otherwise (absent, unsupported, a tombstone).
func _texture_rid(id: int, textures: Dictionary) -> RID:
	if not textures.has(id) or not _textures.has(id):
		return RID()
	var entry: Dictionary = textures[id]
	if entry["status"] != "ok":
		return RID()
	return _textures[id].rid


## One resolved parameter ({name, type, value}, render-stream-5.md "Decoded and resolved forms")
## as the exact Variant the host's engine received (gate5_5-design.md D8, Q5): `float` and `int`
## from the float64 (exact), real_t types narrowed to float32 by their constructors (exact: they
## were float32), the integer vectors and packed integer arrays as ints, packed arrays as their
## Packed*Array, `rid` as this receiver's RID for the texture id, `nil` as null. Member orders are
## the wire's: transform2d as /0's xforms (columns), basis row-major, transform3d its basis
## row-major then the origin, projection by column, plane normal then d.
func _param_variant(param: Dictionary, textures: Dictionary) -> Variant:
	var type_name: String = param["type"]
	var raw: Variant = param["value"]
	if type_name == "nil" or raw == null:
		return null
	if type_name == "rid":
		var link: Dictionary = raw
		return _texture_rid(Rs2Decoder.as_int(link["tex"]), textures)
	if type_name == "bool" or type_name == "int" or type_name == "float":
		var number: float = raw
		if type_name == "bool":
			return number != 0.0
		if type_name == "int":
			return int(number)
		return number
	var list: Array = raw
	if type_name.begins_with("packed_"):
		return _packed_variant(type_name, list)
	var f := PackedFloat64Array(list)
	match type_name:
		"vector2":
			return Vector2(f[0], f[1])
		"vector2i":
			return Vector2i(int(f[0]), int(f[1]))
		"rect2":
			return Rect2(f[0], f[1], f[2], f[3])
		"rect2i":
			return Rect2i(int(f[0]), int(f[1]), int(f[2]), int(f[3]))
		"vector3":
			return Vector3(f[0], f[1], f[2])
		"vector3i":
			return Vector3i(int(f[0]), int(f[1]), int(f[2]))
		"transform2d":
			return Transform2D(Vector2(f[0], f[1]), Vector2(f[2], f[3]), Vector2(f[4], f[5]))
		"vector4":
			return Vector4(f[0], f[1], f[2], f[3])
		"vector4i":
			return Vector4i(int(f[0]), int(f[1]), int(f[2]), int(f[3]))
		"plane":
			return Plane(f[0], f[1], f[2], f[3])
		"quaternion":
			return Quaternion(f[0], f[1], f[2], f[3])
		"aabb":
			return AABB(Vector3(f[0], f[1], f[2]), Vector3(f[3], f[4], f[5]))
		"basis":
			return _basis_rows(f, 0)
		"transform3d":
			return Transform3D(_basis_rows(f, 0), Vector3(f[9], f[10], f[11]))
		"projection":
			return Projection(Vector4(f[0], f[1], f[2], f[3]), Vector4(f[4], f[5], f[6], f[7]), Vector4(f[8], f[9], f[10], f[11]), Vector4(f[12], f[13], f[14], f[15]))
		"color":
			return Color(f[0], f[1], f[2], f[3])
	return null


## A row-major basis (rows[0].xyz, rows[1].xyz, rows[2].xyz) from `f` at `at`. Basis(x, y, z)
## takes columns.
static func _basis_rows(f: PackedFloat64Array, at: int) -> Basis:
	return Basis(Vector3(f[at], f[at + 3], f[at + 6]), Vector3(f[at + 1], f[at + 4], f[at + 7]), Vector3(f[at + 2], f[at + 5], f[at + 8]))


## A resolved packed-array parameter value as its Packed*Array.
static func _packed_variant(type_name: String, list: Array) -> Variant:
	match type_name:
		"packed_int32_array":
			var ints32 := PackedInt32Array()
			for value: float in PackedFloat64Array(list):
				ints32.append(int(value))
			return ints32
		"packed_int64_array":
			var ints64 := PackedInt64Array()
			for value: float in PackedFloat64Array(list):
				ints64.append(int(value))
			return ints64
		"packed_float32_array":
			return PackedFloat32Array(list)
		"packed_float64_array":
			return PackedFloat64Array(list)
	var out_v2 := PackedVector2Array()
	var out_v3 := PackedVector3Array()
	var out_v4 := PackedVector4Array()
	var out_c := PackedColorArray()
	for element: Variant in list:
		var components: Array = element
		var e := PackedFloat64Array(components)
		match type_name:
			"packed_vector2_array":
				out_v2.append(Vector2(e[0], e[1]))
			"packed_vector3_array":
				out_v3.append(Vector3(e[0], e[1], e[2]))
			"packed_vector4_array":
				out_v4.append(Vector4(e[0], e[1], e[2], e[3]))
			"packed_color_array":
				out_c.append(Color(e[0], e[1], e[2], e[3]))
	match type_name:
		"packed_vector2_array":
			return out_v2
		"packed_vector3_array":
			return out_v3
		"packed_vector4_array":
			return out_v4
		"packed_color_array":
			return out_c
	return null


## What a parameter's last sent value is compared by: its type and resolved value at full
## precision, and for `rid` the RID actually sent (a texture made resident later changes it).
static func _param_key(param: Dictionary, variant: Variant) -> String:
	var type_name: String = param["type"]
	if type_name == "rid":
		var rid: RID = variant
		return "rid:%d" % rid.get_id()
	return type_name + ":" + JSON.stringify(param["value"], "", true, true)


## A decoded GRM1 payload's layout (Q5): everything but the buffer contents -- primitive, format,
## counts, the four buffer lengths and the 40-byte geometry block (the AABB fixed at add_surface,
## uv_scale) -- as one comparable string.
static func _layout_key(payload: Dictionary) -> String:
	var aabb: PackedFloat32Array = payload["aabb"]
	var uv_scale: PackedFloat32Array = payload["uv_scale"]
	return "%s/%d/%d/%d/%d/%d/%d/%d/%s/%s" % [
		payload["primitive"], Rs2Decoder.as_int(payload["format"]),
		Rs2Decoder.as_int(payload["vertex_count"]), Rs2Decoder.as_int(payload["index_count"]),
		Rs2Decoder.as_int(payload["vertex_bytes"]), Rs2Decoder.as_int(payload["attribute_bytes"]),
		Rs2Decoder.as_int(payload["skin_bytes"]), Rs2Decoder.as_int(payload["index_bytes"]),
		aabb.to_byte_array().hex_encode(), uv_scale.to_byte_array().hex_encode(),
	]


static func _data_bytes(payload: Dictionary) -> int:
	return Rs2Decoder.as_int(payload["vertex_bytes"]) + Rs2Decoder.as_int(payload["attribute_bytes"]) + Rs2Decoder.as_int(payload["skin_bytes"]) + Rs2Decoder.as_int(payload["index_bytes"])


## The RenderingServer.mesh_add_surface Dictionary (rendering_server.cpp _dict_to_surf) for one
## decoded GRM1 payload: the surface exactly as the host's SurfaceData held it.
static func _surface_dictionary(payload: Dictionary) -> Dictionary:
	var aabb: PackedFloat32Array = payload["aabb"]
	var uv_scale: PackedFloat32Array = payload["uv_scale"]
	var primitive_name: String = payload["primitive"]
	var surface: Dictionary = {
		"primitive": RsMeshPayload.PRIMITIVES.find(primitive_name),
		"format": Rs2Decoder.as_int(payload["format"]),
		"vertex_data": payload["vertex_data"],
		"attribute_data": payload["attribute_data"],
		"skin_data": payload["skin_data"],
		"vertex_count": Rs2Decoder.as_int(payload["vertex_count"]),
		"aabb": AABB(Vector3(aabb[0], aabb[1], aabb[2]), Vector3(aabb[3], aabb[4], aabb[5])),
		"uv_scale": Vector4(uv_scale[0], uv_scale[1], uv_scale[2], uv_scale[3]),
	}
	var index_count: int = Rs2Decoder.as_int(payload["index_count"])
	if index_count > 0:
		surface["index_data"] = payload["index_data"]
		surface["index_count"] = index_count
	return surface


static func _aabb(f: PackedFloat32Array) -> AABB:
	return AABB(Vector3(f[0], f[1], f[2]), Vector3(f[3], f[4], f[5]))


## One /4 immediate-geometry or command-list-state command as the engine's own
## RenderingServer.canvas_item_add_* call (gate5-design.md Q5, D3, D9, D10): points, colours, UVs
## and indices are rebuilt as packed arrays from the wire's float32/int32 values in order, counts
## and flags as given. `texture` is the command's resolved texture RID (RID() for tex null or a
## tombstone).
func _replay_geometry(item: RID, command: Dictionary, texture: RID) -> void:
	var op_name: String = command["op"]
	match op_name:
		"add_line":
			var from: PackedFloat32Array = _floats(command["from"])
			var to: PackedFloat32Array = _floats(command["to"])
			var line_color: PackedFloat32Array = _floats(command["colour"])
			var line_width: float = command["width"]
			var line_aa: bool = command["aa"]
			RenderingServer.canvas_item_add_line(item, Vector2(from[0], from[1]), Vector2(to[0], to[1]), _color(line_color, 0), line_width, line_aa)
		"add_polyline", "add_multiline":
			var poly_points: PackedVector2Array = _points(command["points"])
			var poly_colors: PackedColorArray = _colors(command["colors"])
			var poly_width: float = command["width"]
			var poly_aa: bool = command["aa"]
			if op_name == "add_polyline":
				RenderingServer.canvas_item_add_polyline(item, poly_points, poly_colors, poly_width, poly_aa)
			else:
				RenderingServer.canvas_item_add_multiline(item, poly_points, poly_colors, poly_width, poly_aa)
		"add_circle":
			var position: PackedFloat32Array = _floats(command["position"])
			var circle_color: PackedFloat32Array = _floats(command["colour"])
			var radius: float = command["radius"]
			var circle_aa: bool = command["aa"]
			RenderingServer.canvas_item_add_circle(item, Vector2(position[0], position[1]), radius, _color(circle_color, 0), circle_aa)
		"add_primitive":
			RenderingServer.canvas_item_add_primitive(item, _points(command["points"]), _colors(command["colors"]), _points(command["uvs"]), texture)
		"add_polygon":
			RenderingServer.canvas_item_add_polygon(item, _points(command["points"]), _colors(command["colors"]), _points(command["uvs"]), texture)
		"add_triangle_array":
			var indices: PackedInt32Array = _ints(command["indices"])
			var count: int = Rs2Decoder.as_int(command["count"])
			RenderingServer.canvas_item_add_triangle_array(item, indices, _points(command["points"]), _colors(command["colors"]), _points(command["uvs"]), PackedInt32Array(), PackedFloat32Array(), texture, count)
		"add_nine_patch":
			var np_rect: PackedFloat32Array = _floats(command["rect"])
			var np_source: PackedFloat32Array = _floats(command["source"])
			var margins: PackedFloat32Array = _floats(command["margins"])
			var np_modulate: PackedFloat32Array = _floats(command["modulate"])
			var x_axis: String = command["x_axis"]
			var y_axis: String = command["y_axis"]
			if sabotage_ignore_nine_patch_axis:
				x_axis = "stretch"
				y_axis = "stretch"
			var draw_center: bool = command["draw_center"]
			RenderingServer.canvas_item_add_nine_patch(item, _rect(np_rect, 0), _rect(np_source, 0), texture, Vector2(margins[0], margins[1]), Vector2(margins[2], margins[3]), NINE_PATCH_AXES.find(x_axis) as RenderingServer.NinePatchAxisMode, NINE_PATCH_AXES.find(y_axis) as RenderingServer.NinePatchAxisMode, draw_center, _color(np_modulate, 0))
		"add_set_transform":
			var transform: PackedFloat32Array = _floats(command["transform"])
			RenderingServer.canvas_item_add_set_transform(item, _xform(transform, 0))
		"add_clip_ignore":
			var ignore: bool = command["ignore"]
			RenderingServer.canvas_item_add_clip_ignore(item, ignore)


## The `clip` setter (apply_state()'s docstring, D3/G3b): a call only when the wire value differs
## from the shadow (always true for a new item). RS_RECEIVER_SABOTAGE=ignore-clip corrupts the RS
## argument to false without touching the shadow, so the call cadence still matches an honest
## receiver's; the shadow always ends up holding the true wire value. `item_calls` logs the call
## (test instrumentation).
func _apply_clip(state: ItemState, clip: bool, is_new: bool, id: int, item_calls: Array[Dictionary]) -> void:
	if is_new or clip != state.clip:
		RenderingServer.canvas_item_set_clip(state.rid, false if sabotage_ignore_clip else clip)
		rs_calls += 1
		state.clip = clip
		item_calls.append({"item": id, "op": "set_clip"})


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
	if sabotage_refuse_canvas_texture and entry["kind"] == "canvas":
		return {"drawable": false, "rid": RID(), "reason": "canvas-texture-headless"}
	return {"drawable": true, "rid": _textures[id].rid}


## Frees every RID this applier created (items, then owned canvases, textures, meshes, materials,
## shaders; canvas 1 is the viewport's, whose modulate goes back to white) and forgets all state, so a later begin_session starts clean. Returns how many
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
	var mesh_ids: Array[int] = []
	mesh_ids.assign(_meshes.keys())
	mesh_ids.sort()
	for id: int in mesh_ids:
		RenderingServer.free_rid(_meshes[id].rid)
		rs_calls += 1
		count += 1
	_meshes.clear()
	# G55d: materials before shaders (freeing a shader would null the materials' shader first).
	var material_ids: Array[int] = []
	material_ids.assign(_materials.keys())
	material_ids.sort()
	for id: int in material_ids:
		RenderingServer.free_rid(_materials[id].rid)
		rs_calls += 1
		count += 1
	_materials.clear()
	var shader_ids: Array[int] = []
	shader_ids.assign(_shaders.keys())
	shader_ids.sort()
	for id: int in shader_ids:
		RenderingServer.free_rid(_shaders[id].rid)
		rs_calls += 1
		count += 1
	_shaders.clear()
	# The root canvas is the viewport's, not ours: leave it with the engine's default modulate
	# (a call only when a non-white value was actually applied).
	if _root_modulate != PackedFloat32Array(WHITE) and not sabotage_ignore_canvas_modulate:
		RenderingServer.canvas_set_modulate(_root_canvas, Color(1, 1, 1, 1))
		rs_calls += 1
	_root_modulate = PackedFloat32Array(WHITE)
	_root_xform = PackedFloat32Array()
	_default_filter = ""
	_default_repeat = ""
	disposed_frees = count
	return count


## How many RIDs the applier currently owns (items, canvases it created, resident textures,
## meshes, shaders and materials).
func owned_rids() -> int:
	var count: int = _items.size() + _textures.size() + _meshes.size() + _shaders.size() + _materials.size()
	for id: int in _canvases:
		if _canvases[id].owned:
			count += 1
	return count


## How many textures are resident.
func resident_textures() -> int:
	return _textures.size()


## How many meshes are resident (G5e).
func resident_meshes() -> int:
	return _meshes.size()


## How many shaders are resident (G55d).
func resident_shaders() -> int:
	return _shaders.size()


## How many materials are resident (G55d).
func resident_materials() -> int:
	return _materials.size()


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


## A resolved [[x, y], ...] list as a PackedVector2Array (float32 values unchanged).
static func _points(values: Variant) -> PackedVector2Array:
	var list: Array = values
	var out := PackedVector2Array()
	for value: Variant in list:
		var pair: PackedFloat32Array = _floats(value)
		out.append(Vector2(pair[0], pair[1]))
	return out


## A resolved [[r, g, b, a], ...] list as a PackedColorArray.
static func _colors(values: Variant) -> PackedColorArray:
	var list: Array = values
	var out := PackedColorArray()
	for value: Variant in list:
		var rgba: PackedFloat32Array = _floats(value)
		out.append(Color(rgba[0], rgba[1], rgba[2], rgba[3]))
	return out


## A resolved int list as a PackedInt32Array.
static func _ints(values: Variant) -> PackedInt32Array:
	var list: Array = values
	var out := PackedInt32Array()
	for value: Variant in list:
		out.append(Rs2Decoder.as_int(value))
	return out


static func _xform(f: PackedFloat32Array, at: int) -> Transform2D:
	return Transform2D(Vector2(f[at], f[at + 1]), Vector2(f[at + 2], f[at + 3]), Vector2(f[at + 4], f[at + 5]))


static func _color(f: PackedFloat32Array, at: int) -> Color:
	return Color(f[at], f[at + 1], f[at + 2], f[at + 3])


static func _rect(f: PackedFloat32Array, at: int) -> Rect2:
	return Rect2(f[at], f[at + 1], f[at + 2], f[at + 3])
