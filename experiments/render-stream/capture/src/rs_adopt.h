// The arm-time late-join adoption pass (gate8-design.md D3-D5, D13; G8w seam, G8a body).
//
// Under GRC_ADOPT=arm a capture that arms after the scene exists (a modder's runtime
// `GDExtensionManager.load_extension`, or any route whose main scene drew before the extension
// armed, Q1a) registers every canvas, canvas layer and canvas item reachable from the root window
// with origin `adopted`, so its first transaction equals what a capture armed at the scene's birth
// would have published (D15.1, modulo Q2's exception list). Two halves:
//
//   - the walk (adopt_at_arm): read-only ClassDB method binds over the node tree, in tree order
//     (internal children included), never a RenderingServer slot -- headless keeps the canvas
//     state but exposes no getters for it (D3). It fills an AdoptPlan.
//   - the application (apply_adopt_plan): engine-free. It drives the mirror through the same
//     setters the hooks call (Mirror::adopt_canvas / adopt_item, then set_parent, set_transform
//     ...), each only where the hooks would have been called, so "adoption declares exactly what
//     the hooks would have declared" (D5's rule) holds by construction, and the unit test
//     (test/rs_adopt_test.cpp) drives it with no engine.
//
// After the application the walk asks the engine for exactly the two things a running game asks
// for constantly (D3): `queue_redraw()` on every adopted item (the next MessageQueue flush re-sends
// `clear`, every command and a Control's transform, custom rect and clip through the hooks,
// before the frame callback publishes, D4) and the top-level re-raise `_top_level_raise_self`,
// called synchronously on every member of each canvas group in tree order (G8a "As built": the
// same calls, in the same order, that the deferred `SceneTree.call_group_flags` D3 names would
// make at the flush, without building Variant arguments for a vararg bind).
//
// Not adopted, by design (each stays typed by the mirror exactly as an unknown RID is today):
// RS-only items and canvases with no node (the residue: TileMapLayer quadrants, a script's
// `RenderingServer.canvas_item_create`, an embedded subwindow's canvas), and every subtree of a
// non-root viewport. Materials and shaders are G8m's (below).
//
// G8r (gate8-design.md D6, D7): pre-arm textures, meshes and glyph atlases are adopted lazily, at
// their first reference by a hooked call (adopt_texture_ref / adopt_mesh_ref, called by every hook
// that names a texture or mesh RID, before its mirror tap), with origin `adopted`:
//
//   - a glyph atlas page: found through the TextServer (fonts from ThemeDB and the resource
//     cache, each expanded by Font.get_rids(); a page whose current image is consistent with the
//     dummy's creation copy is confirmed by font_get_glyph_texture_rid == the RID), its bytes
//     font_get_texture_image's current page: adopted_content `current`, source `textserver`;
//   - a CompressedTexture2D (found in the resource cache, where every one lives: it is loaded by
//     path, and the engine never updates one in place): texture_2d_get's copy is its content,
//     `current`, source `cache`;
//   - any other texture: the dummy's creation-time copy (texture_2d_get), `creation`, source
//     `dummy` -- exact unless the engine updated it in place before arm (an ImageTexture.update,
//     an oversampled atlas page D7 cannot address);
//   - a texture whose first reference is a texture_2d_update: that update's own image, `current`,
//     source `update` (the hooks then apply the update as usual);
//   - a mesh: mesh_get_surface per surface and mesh_get_custom_aabb, `creation`, source `dummy`.
//
// The bytes go through the hooks' own copy path (G8t's host decode, G8kw's worker and hold-back).
// What cannot be read (texture_2d_get returns no image: a placeholder, a proxy, a RID that is no
// dummy texture; a RID that is no mesh) stays the hooks' typed `unknown-texture` /
// `unknown-mesh`, counted once per RID in AdoptResourceStats.
//
// G8m (gate8-design.md D11, D12, Q5): pre-arm materials and shaders are resolved through the
// item's node, at arm (every adopted item's material, before the plan is applied, and its
// instance parameters after) and lazily at the next frame boundary (a hooked call named an
// unknown material or shader: a post-arm item given a pre-arm material, a post-arm material on a
// pre-arm Shader, a CanvasItemMaterial mode first used before arm), before the transaction is
// formed. The node map is the walk's, kept current by a custom callable on SceneTree.node_added.
//
//   - a ShaderMaterial's Shader: its code preprocessed by a capture-owned temporary Shader
//     (set_path_cache to the original's path, so relative includes resolve as they did; then
//     set_code(get_code()) and get_rid(), which reaches the hooked shader_create_from_code under
//     the hooks' reentrancy flag, D4), its default textures; a preprocessing that left an
//     `#include` in the code is the typed `shader-adopt-include` (no code, unsupported);
//   - its parameters: get_shader_parameter for every `uniform` the code declares (a texture
//     value by its RID), as the material_set_param calls that made them;
//   - a CanvasItemMaterial: the template code for its mode, rebuilt from the getters (D12), and
//     the three particles parameters its constructor sets;
//   - instance parameters: canvas_item_get_instance_shader_parameter over the server's list
//     (RendererCanvasCull keeps them headless), the ones that were set.
// Anything else (a material class with no recipe, a material or shader no node holds: raw
// RenderingServer calls) stays the hooks' `unknown-material` / `unknown-shader`, counted.
#ifndef GRC_RS_ADOPT_H
#define GRC_RS_ADOPT_H

#include <cstddef>
#include <cstdint>
#include <string>
#include <unordered_map>
#include <vector>

#include "rs2_snapshot.h"

namespace grc {
namespace rs {

class Mirror;

// What the adoption walk found and did, for `result.json` (gate8-design.md Q2 "adopt-account").
struct AdoptStats {
  bool ran = false;
  std::string error;            // empty, or why the walk adopted nothing (a missing object)
  std::uint32_t canvases = 0;   // canvases adopted (one per adopted CanvasLayer)
  std::uint32_t layers = 0;     // CanvasLayer nodes adopted
  std::uint32_t items = 0;      // CanvasItem nodes adopted
  std::uint32_t residue = 0;    // RS-only canvas/item RIDs named after arm (filled at result time)
  std::uint32_t hidden = 0;     // adopted items not visible in tree at arm (no commands until shown)
  std::uint32_t top_level = 0;  // canvas-group members re-raised (_top_level_raise_self)
  std::uint32_t redraws = 0;    // queue_redraw requests made
  std::uint32_t canvas_modulates = 0;  // canvases given a CanvasModulate colour
  std::uint32_t lights = 0;             // Light2D nodes declared (canvas-light, sticky)
  std::uint32_t non_root_viewports = 0; // viewport subtrees not walked (non-root-viewport)
  std::uint32_t materials = 0;          // adopted items with a material (resolved by G8m)
  std::uint32_t canvas_groups = 0;      // CG1: items given a canvas group (clip_children/CanvasGroup)
  std::uint32_t backbuffer_copies = 0;  // CG1: BackBufferCopy items given a copy
  std::uint64_t walk_ns = 0;   // the read-only tree walk
  std::uint64_t apply_ns = 0;  // the mirror application
  std::uint64_t engine_ns = 0; // the redraw requests and the re-raises
  std::uint64_t total_ns = 0;
};

// The sabotages that act on the walk (gate8-design.md Q2 "Sabotages").
enum class AdoptSabotage : std::uint8_t {
  None,
  SkipState,   // adopt-skip-state: structure without transforms, modulate or self-modulate
  NoRedraw,    // adopt-no-redraw: no queue_redraw (commands never re-sent)
  SkipLayers,  // adopt-skip-layers: CanvasLayer canvases left unknown
};

struct AdoptConfig {
  // The capture host's frame counter at arm, dated into the session's `adoption.frame` (>= 1).
  // Since G8a it is the main-loop iteration the walk runs in (entry.cpp aligns the capture's
  // frame counter with Engine.get_process_frames() under GRC_ADOPT=arm).
  std::uint64_t arm_frame = 1;
  AdoptSabotage sabotage = AdoptSabotage::None;
  // CG1 (render-stream-10.md "Capture"/"Adoption"): read each back-buffer state only when its
  // conditional hook is planned (GRC_STREAM_VERSION=10 and the record names the slot), so a
  // session that declares the setter unobserved never carries adopted state for it.
  bool canvas_group = false;        // canvas_item_set_canvas_group_mode is hooked
  bool copy_to_backbuffer = false;  // canvas_item_set_copy_to_backbuffer is hooked
};

// One adopted CanvasLayer (D5 "Per layer"), in tree order.
struct AdoptedLayer {
  std::uint64_t canvas = 0;    // CanvasLayer.get_canvas()
  std::uint64_t viewport = 0;  // the viewport it attaches to (custom viewport, else its own)
  rs2::Xform xform = rs2::kIdentityXform;  // CanvasLayer.get_transform()
  std::int32_t layer = 1;      // CanvasLayer.get_layer()
  std::int32_t index = 0;      // Node.get_index(): the stacking sublayer (canvas_layer.cpp:206)
  bool follow_viewport = false;
  float follow_scale = 1.0f;
  std::uint64_t follow_parent = 0;  // the world canvas a following layer parents to
};

// One adopted CanvasItem (D5 "Per item"), in tree order (parents before children).
struct AdoptedItem {
  std::uint64_t rid = 0;     // CanvasItem.get_canvas_item()
  std::uint64_t parent = 0;  // the parent item's RID, or get_canvas() for a canvas-group member
  bool group_member = false; // no parent item: top level, or under a non-CanvasItem / layer
  std::int32_t child_index = 0;  // Node.get_index(true): the draw index of a child item
  rs2::Xform xform = rs2::kIdentityXform;
  rs2::Color4 modulate = rs2::kWhite;
  rs2::Color4 self_modulate = rs2::kWhite;
  bool visible = true;       // is_visible_in_tree(): the RS flag a hooked capture holds
  std::int32_t z_index = 0;
  bool z_relative = true;
  bool behind = false;
  std::uint32_t visibility_layer = 1;
  std::int32_t texture_filter = 0;  // resolved through the parent chain (the node's cache)
  std::int32_t texture_repeat = 0;
  std::uint64_t material = 0;       // get_material()->get_rid(), 0 when none
  bool use_parent_material = false;
  // Node-specific RS state the hooks type (D5's rule), declared as the node would have.
  bool light = false;               // a Light2D: canvas_light_attach_to_canvas(get_canvas())
  std::uint64_t light_canvas = 0;
  bool mirroring = false;           // a ParallaxLayer with non-zero mirroring
  float mirroring_xy[2] = {0.0f, 0.0f};
  bool repeat = false;              // a Parallax2D with a non-zero repeat size
  float repeat_xy[2] = {0.0f, 0.0f};
  std::int32_t repeat_times = 1;
  // CG1 (render-stream-10.md "Capture"/"Adoption"), each filled only when its hook is planned:
  // the canvas_item_set_canvas_group_mode call the node made (a CanvasItem's clip_children_mode
  // with the RS defaults, or a CanvasGroup's transparent group), and a BackBufferCopy's
  // canvas_item_set_copy_to_backbuffer (rect mode: its rect; viewport mode: Rect2()).
  std::int32_t canvas_group_mode = 0;  // RS CanvasGroupMode; 0 = none (never set)
  float clear_margin = 5.0f;
  bool fit_empty = false;
  float fit_margin = 0.0f;
  bool blur_mipmaps = false;
  bool copy_to_backbuffer = false;
  rs2::Rect4 copy_rect = rs2::kZeroRect;
};

struct AdoptPlan {
  std::vector<AdoptedLayer> layers;
  std::vector<AdoptedItem> items;
  // The active CanvasModulate colour per canvas (the first visible-in-tree one in tree order).
  std::vector<std::pair<std::uint64_t, rs2::Color4>> canvas_modulates;
  std::uint32_t non_root_viewports = 0;
};

// Drives `mirror` through the hooks' own setters for every object in `plan` (engine-free). Fills
// the canvas/layer/item/hidden/... counts of `stats`.
void apply_adopt_plan(Mirror &mirror, const AdoptPlan &plan, AdoptSabotage sabotage,
                      std::uint64_t frame, AdoptStats *stats);

// True when every method bind the walk needs resolves at its 4.5.1 hash; otherwise names the
// first missing one in `missing` (the stream refuses `adopt-unavailable`).
bool adopt_binds_ready(std::string *missing);

// True when the caller is the engine's main thread (OS.get_thread_caller_id() ==
// OS.get_main_thread_id()); otherwise describes both ids (the stream refuses `adopt-thread`, D4).
bool adopt_on_main_thread(std::string *detail);

// The engine's main-loop iteration counter now (Engine.get_process_frames(); it advances after
// the frame callback, main.cpp:4852, so it is the 0-based index of the iteration running), or -1.
std::int64_t adopt_engine_process_frames();

// Called once at arm on the main thread, when GRC_ADOPT=arm, after the root query and before the
// size policy (D4): walk, apply to the process-wide mirror, request the redraws and re-raises.
AdoptStats adopt_at_arm(const AdoptConfig &config);

// The adopted item RID -> node ObjectID map the walk built (D11's node map; G8m keeps it current).
const std::unordered_map<std::uint64_t, std::uint64_t> &adopted_item_nodes();

// ------------------------------------------------------------------- G8r: resources by RID

// GRC_ADOPT_FAULT (G8r's fault knob, not a GRC_SABOTAGE kind: a new kind is a wire change, as
// G8kw's GRC_TEXTURE_WORKER_FAULT; the bug each models would not declare itself either).
enum class AdoptFault : std::uint8_t {
  None,
  NoResources,     // no-resources: nothing adopted lazily (G8a's typed refusals come back)
  AtlasFromDummy,  // atlas-from-dummy: atlas pages read from the dummy's stale copy, still
                   // declared `current`
  ClaimCurrent,    // claim-current: every adopted texture and mesh declared `current`
  // G8m: no-include-path: the temporary Shader gets no path (gate8-design.md D11 as written), so
  // a relative #include cannot resolve and its shader is the typed shader-adopt-include.
  NoIncludePath,
};

// Parses GRC_ADOPT_FAULT (null or "" -> None). False with `error` set for any other value, or
// for a fault without GRC_ADOPT=arm (`adopt` false).
bool parse_adopt_fault(const char *value, bool adopt, AdoptFault *out, std::string *error);
const char *adopt_fault_name(AdoptFault fault);

// What lazy resource adoption did (result.json stream.gate8.adopt_stats.resources).
struct AdoptResourceStats {
  std::uint32_t textures = 0;          // adopted textures, every source
  std::uint32_t textures_current = 0;  // ... declared current
  std::uint32_t textures_creation = 0; // ... declared creation
  std::uint32_t atlas_pages = 0;       // ... of which TextServer readbacks
  std::uint32_t compressed = 0;        // ... of which CompressedTexture2D (resource cache)
  std::uint32_t from_update = 0;       // ... of which first met as a texture_2d_update
  std::uint32_t decoded = 0;           // ... whose payload is a host decode (G8t)
  std::uint32_t textures_refused = 0;  // RIDs nothing could read: unknown-texture stays
  std::uint32_t meshes = 0;            // adopted meshes (creation)
  std::uint32_t mesh_surfaces = 0;
  std::uint32_t meshes_refused = 0;    // RIDs mesh_get_surface_count could not read
  std::uint32_t fonts = 0;             // TextServer font RIDs the census found
  std::uint32_t cached_compressed = 0; // CompressedTexture2D RIDs the census found
  std::uint32_t cache_paths = 0;       // resource paths the census listed
  std::uint64_t census_ns = 0;         // the one-time census (fonts, resource cache)
  std::uint64_t lookup_ns = 0;         // every adoption's read-back, census excluded
};

// Starts lazy adoption for this stream (GRC_ADOPT=arm, after the walk; the TextServer and
// resource-cache reads run on the main thread only, any other thread gets the dummy's copy).
// Ends with the stream.
void adopt_resources_begin(AdoptFault fault);
void adopt_resources_end();
bool adopt_resources_active();
AdoptResourceStats adopt_resource_stats();

// Called by a hook before its mirror tap: adopts `rid` if it is non-null, lazy adoption is
// active and the mirror does not know it. Cheap otherwise (an atomic load).
void adopt_texture_ref(std::uint64_t rid);
void adopt_mesh_ref(std::uint64_t rid);
// Called by the texture_2d_update hook for a whole-image update of a RID the mirror does not
// know: true (and counted as one `current` adoption from an update) when lazy adoption is active
// and not faulted off; the hook then registers the texture from the update's own image.
bool adopt_from_update_begin();

// One surface read back through mesh_get_surface, for hooks_adopt_mesh (pointers valid for the
// call only).
struct AdoptSurface {
  std::int32_t primitive = 0;
  std::uint64_t format = 0;
  std::uint32_t vertex_count = 0;
  std::uint32_t index_count = 0;
  float aabb[6] = {};
  float uv_scale[4] = {};
  const std::uint8_t *vertex = nullptr;
  std::size_t vertex_bytes = 0;
  const std::uint8_t *attribute = nullptr;
  std::size_t attribute_bytes = 0;
  const std::uint8_t *skin = nullptr;
  std::size_t skin_bytes = 0;
  const std::uint8_t *index = nullptr;
  std::size_t index_bytes = 0;
  std::int64_t blend_shape_bytes = 0;  // non-zero when the surface has blend shapes (refused)
};

// ------------------------------------------------------------------- G8m: materials, shaders

// One parameter read back from a material (a Variant the caller keeps alive for the call).
struct AdoptParam {
  std::string name;
  const void *variant = nullptr;
};

// The two G8m sabotages (render-stream-8.md "Sabotage kinds", gate8-design.md Q5).
enum class AdoptMaterialSabotage : std::uint8_t {
  None,
  RawShaderCode,  // adopt-raw-shader-code: an adopted shader publishes get_code() unpreprocessed
  SkipParams,     // adopt-skip-params: adopted materials and items publish no parameters
};

// One `uniform` declaration a shader's code makes (instance and global uniforms excluded).
struct UniformDecl {
  std::string name;
  bool sampler = false;  // a sampler type (its default texture is a shader default)
};
// The token scan G8m reads parameter names with: `//` and `/* */` comments skipped, `uniform`
// preceded by `instance` or `global` skipped, an optional precision qualifier, then the type and
// the name. Engine-free.
std::vector<UniformDecl> scan_uniforms(const std::string &code);
// True when `code` still holds an `#include` directive (a line whose first token is #include):
// the preprocessor failed and left the source as it was (Q5's shader-adopt-include).
bool has_include_directive(const std::string &code);

// What material adoption did (result.json stream.gate8.adopt_stats.material_adoption).
struct AdoptMaterialStats {
  std::uint32_t materials = 0;             // adopted materials, every class
  std::uint32_t shader_materials = 0;      // ... ShaderMaterial
  std::uint32_t canvas_item_materials = 0; // ... CanvasItemMaterial
  std::uint32_t at_arm = 0;                // ... adopted by the walk (the rest lazily)
  std::uint32_t materials_refused = 0;     // material refs nothing could resolve (counted once)
  std::uint32_t shaders = 0;               // adopted shaders
  std::uint32_t shaders_builtin = 0;       // ... CanvasItemMaterial templates (D12)
  std::uint32_t shaders_include_refused = 0;  // ... shader-adopt-include
  std::uint32_t shaders_lazy = 0;          // material shaders resolved at a frame boundary
  std::uint32_t shaders_refused = 0;       // material-shader refs nothing could resolve
  std::uint32_t params = 0;                // material parameters published
  std::uint32_t default_textures = 0;      // shader default textures published
  std::uint32_t instance_params = 0;       // item instance parameters published
  std::uint32_t resolve_passes = 0;        // frame boundaries with pending references
  std::uint32_t nodes_added = 0;           // CanvasItems node_added mapped after arm
  bool node_map_connected = false;         // SceneTree.node_added connected
  std::uint64_t arm_ns = 0;                // the walk's material and instance-parameter reads
  std::uint64_t resolve_ns = 0;            // every frame-boundary resolution
};

// Called by entry.cpp before adopt_at_arm (with the stream's sabotage kind).
void adopt_materials_configure(AdoptMaterialSabotage sabotage);
const char *adopt_material_sabotage_name(AdoptMaterialSabotage sabotage);
AdoptMaterialStats adopt_material_stats();
// At arm, once the hook log is open (entry.cpp, after the walk; same main-loop iteration, before
// the first transaction): connects the node map to SceneTree.node_added, resolves every adopted
// item's material and reads the adopted items' instance parameters.
void adopt_materials_at_arm();
// The frame boundary (entry.cpp's frame callback, main thread, before the transaction is
// formed): resolves the mirror's pending material and shader references through the node map.
// Cheap when nothing changed since the last call (one epoch read).
void adopt_materials_resolve();

// PM5 (render-stream-12.md "The `particle_process_material` builtin"): at the frame boundary
// (after adopt_materials_resolve), keys every `particles`-mode shader the mirror lists
// (Mirror::ppm_candidates) through the node map: the drawing item's node is a GPUParticles2D whose
// process_material is a ParticleProcessMaterial with the emitter's material RID; its class getters
// give ParticleProcessMaterial::MaterialKey (_compute_key). Cheap when the mirror's ppm epoch did
// not move. A shader it cannot key stays shader-mode (counted unresolved, once per shader).
void adopt_particles_resolve();
struct PpmStats {
  std::uint64_t builtin_resolved = 0;    // shaders keyed
  std::uint64_t builtin_unresolved = 0;  // shaders tried with no ParticleProcessMaterial found
};
PpmStats adopt_particles_stats();

// PM5 (render-stream-12.md "Headless shims", GRC_PREDRAW_PUMP=1): connects a capture callable to
// RenderingServer.frame_pre_draw (false, with `*why`, when the binds or the signal are missing).
bool predraw_pump_connect(std::string *why);
void predraw_pump_disconnect();
// The frame callback, before the snapshot: emits frame_pre_draw when the engine did not this
// iteration (true: the pump fired), then clears the flag.
bool predraw_pump_frame();

}  // namespace rs
}  // namespace grc

#endif  // GRC_RS_ADOPT_H
