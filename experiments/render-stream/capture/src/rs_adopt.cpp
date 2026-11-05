#include "rs_adopt.h"

#include <algorithm>
#include <atomic>
#include <map>
#include <memory>
#include <set>
#include <chrono>
#include <cstring>
#include <mutex>
#include <thread>
#include <unordered_set>

#include "abi.h"
#include "hooks.h"
#include "iface.h"
#include "rs_mirror.h"
#include "rs_registry.h"
#include "rs_rid_map.h"
#include "rs_shader_payload.h"
#include "rs_texture_payload.h"
#include "rs_variant.h"

namespace grc {
namespace rs {

namespace {

// ------------------------------------------------------------------ the engine-free application

bool same_xform(const rs2::Xform &a, const rs2::Xform &b) { return a == b; }
bool same_color(const rs2::Color4 &a, const rs2::Color4 &b) { return a == b; }

// One adopted item through the mirror's own setters: the calls CanvasItem's
// NOTIFICATION_ENTER_TREE makes (canvas_item.cpp:237-289 set_parent and visibility layer, :354
// visible, :357-358 filter and repeat), the deferred update_draw_order of a child item (:444 draw
// index = get_index()), and each setter whose value differs from the RenderingServer default, as a
// setter only calls the server on a change. Shared by apply_adopt_plan and the node_added adoption.
void apply_adopted_item(Mirror &mirror, const AdoptedItem &item, AdoptSabotage sabotage,
                        std::uint64_t frame, AdoptStats *stats) {
  mirror.adopt_item(item.rid, frame);
  mirror.set_parent(item.rid, item.parent, frame);
  mirror.set_visibility_layer(item.rid, item.visibility_layer, frame);
  mirror.set_visible(item.rid, item.visible, frame);
  mirror.set_texture_filter(item.rid, item.texture_filter, frame);
  mirror.set_texture_repeat(item.rid, item.texture_repeat, frame);
  if (!item.group_member) {
    mirror.set_draw_index(item.rid, item.child_index, frame);
  }
  if (sabotage != AdoptSabotage::SkipState) {
    if (!same_xform(item.xform, rs2::kIdentityXform)) {
      mirror.set_transform(item.rid, item.xform, frame);
    }
    if (!same_color(item.modulate, rs2::kWhite)) {
      mirror.set_modulate(item.rid, item.modulate, frame);
    }
    if (!same_color(item.self_modulate, rs2::kWhite)) {
      mirror.set_self_modulate(item.rid, item.self_modulate, frame);
    }
  }
  if (item.z_index != 0) {
    mirror.set_z_index(item.rid, item.z_index, frame);
  }
  if (!item.z_relative) {
    mirror.set_z_relative(item.rid, false, frame);
  }
  if (item.behind) {
    mirror.set_behind(item.rid, true, frame);
  }
  if (item.material != 0) {
    mirror.set_material(item.rid, item.material, frame);
    ++stats->materials;
  }
  if (item.use_parent_material) {
    mirror.set_use_parent_material(item.rid, true, frame);
  }
  // CG1: the back-buffer state a node set through its setters (render-stream-10.md "Capture").
  if (item.canvas_group_mode != 0) {
    mirror.set_canvas_group_mode(item.rid, item.canvas_group_mode, item.clear_margin,
                                 item.fit_empty, item.fit_margin, item.blur_mipmaps, frame);
    ++stats->canvas_groups;
  }
  if (item.copy_to_backbuffer) {
    mirror.set_copy_to_backbuffer(item.rid, true, item.copy_rect, frame);
    ++stats->backbuffer_copies;
  }
  if (item.use_identity_transform) {
    mirror.set_use_identity_transform(item.rid, true, frame);
    ++stats->identity_transforms;
  }
  if (item.light) {
    mirror.canvas_light_attach_to_canvas(0, item.light_canvas, frame);
    ++stats->lights;
  }
  if (item.mirroring) {
    mirror.canvas_set_item_mirroring(item.parent, item.rid, item.mirroring_xy[0],
                                     item.mirroring_xy[1], frame);
  }
  if (item.repeat) {
    mirror.canvas_set_item_repeat(item.rid, item.repeat_xy[0], item.repeat_xy[1],
                                  item.repeat_times, frame);
  }
  ++stats->items;
  if (!item.visible) {
    ++stats->hidden;
  }
  if (item.group_member) {
    ++stats->top_level;
  }
}

}  // namespace

void apply_adopt_plan(Mirror &mirror, const AdoptPlan &plan, AdoptSabotage sabotage,
                      std::uint64_t frame, AdoptStats *stats) {
  // Canvas layers first (D5 "Per layer"), in the order a CanvasLayer's NOTIFICATION_ENTER_TREE and
  // its deferred update_draw_order issue them (canvas_layer.cpp:181-184, :204-207): attach (which
  // resets the stacking to (0,0)), canvas transform, follow-viewport parent, stacking.
  if (sabotage != AdoptSabotage::SkipLayers) {
    for (const AdoptedLayer &layer : plan.layers) {
      mirror.adopt_canvas(layer.canvas, frame);
      mirror.viewport_attach_canvas(layer.viewport, layer.canvas, frame);
      mirror.viewport_set_canvas_transform(layer.viewport, layer.canvas, layer.xform, frame);
      if (layer.follow_viewport) {
        mirror.canvas_set_parent(layer.canvas, layer.follow_parent, frame);
      }
      mirror.viewport_set_canvas_stacking(layer.viewport, layer.canvas, layer.layer, layer.index,
                                          frame);
      ++stats->canvases;
      ++stats->layers;
    }
  }
  // Items in tree order, so every parent exists before its children are appended to it.
  for (const AdoptedItem &item : plan.items) {
    apply_adopted_item(mirror, item, sabotage, frame, stats);
  }
  // CanvasModulate (canvas_modulate.cpp:33-60): the active one per canvas sets its colour.
  for (const auto &entry : plan.canvas_modulates) {
    mirror.canvas_set_modulate(entry.first, entry.second, frame);
    ++stats->canvas_modulates;
  }
  stats->non_root_viewports = plan.non_root_viewports;
}

namespace {

// ------------------------------------------------------------------------- the engine walk

// Method hashes from `godot --dump-extension-api` of Godot 4.5.1 (4.5.1.stable.official.
// f62fdbde1), as rs_root_query.cpp. A hash that does not match the running engine makes
// classdb_get_method_bind return null, and the stream refuses `adopt-unavailable` before arming
// anything. ptrcall encodes every integer and enum as int64, a bool as uint8, a float as double.
// `_top_level_raise_self` is bound (canvas_item.cpp:1297) but omitted from the dump (a leading
// underscore); a method's hash covers only its signature, so it is queue_redraw's (void, no
// arguments, non-const).
struct BindSpec {
  const char *cls;
  const char *method;
  std::int64_t hash;
};

enum BindId : int {
  kEngineGetMainLoop,
  kEngineGetProcessFrames,
  kOsGetMainThreadId,
  kOsGetThreadCallerId,
  kSceneTreeGetRoot,
  kNodeGetChildCount,
  kNodeGetChild,
  kNodeGetIndex,
  kNodeGetParent,
  kNodeGetViewport,
  kObjectGetInstanceId,
  kViewportGetViewportRid,
  kViewportFindWorld2d,
  kWorld2dGetCanvas,
  kItemGetCanvasItem,
  kItemIsVisibleInTree,
  kItemIsTopLevel,
  kItemGetModulate,
  kItemGetSelfModulate,
  kItemGetZIndex,
  kItemIsZRelative,
  kItemIsBehind,
  kItemGetTransform,
  kItemGetCanvas,
  kItemGetMaterial,
  kItemGetUseParentMaterial,
  kItemGetVisibilityLayer,
  kItemGetTextureFilter,
  kItemGetTextureRepeat,
  kItemQueueRedraw,
  kItemTopLevelRaiseSelf,
  kLayerGetCanvas,
  kLayerGetLayer,
  kLayerGetTransform,
  kLayerIsFollowingViewport,
  kLayerGetFollowViewportScale,
  kLayerGetCustomViewport,
  kModulateGetColor,
  kResourceGetRid,
  kParallaxLayerGetMirroring,
  kParallax2dGetRepeatSize,
  kParallax2dGetRepeatTimes,
  // CG1 (render-stream-10.md "Capture"/"Adoption").
  kItemGetClipChildrenMode,
  kCanvasGroupGetClearMargin,
  kCanvasGroupGetFitMargin,
  kCanvasGroupIsUsingMipmaps,
  kBackBufferCopyGetCopyMode,
  kBackBufferCopyGetRect,
  // UIT (render-stream-11.md "As built (UIT)").
  kCpuParticles2dGetUseLocalCoordinates,
  // G8r: lazy resource adoption (D6, D7).
  kRsTexture2dGet,
  kRsMeshGetSurfaceCount,
  kRsMeshGetSurface,
  kRsMeshGetCustomAabb,
  // PM9 (late-arm multimesh adoption): the multimesh buffer read-back (LAR2: the allocation, mesh,
  // visible count and custom AABB come from the registry).
  kRsMultimeshGetBuffer,
  // PM9 (late-arm canvas texture adoption): the CanvasTexture resource's getters.
  kCtexGetDiffuseTexture,
  kCtexGetNormalTexture,
  kCtexGetSpecularTexture,
  kCtexGetTextureFilter,
  kCtexGetTextureRepeat,
  kTsmGetPrimaryInterface,
  kTsFontGetSizeCacheList,
  kTsFontGetTextureCount,
  kTsFontGetTextureImage,
  kTsFontGetGlyphList,
  kTsFontGetGlyphTextureIdx,
  kTsFontGetGlyphTextureRid,
  kThemeDbGetFallbackFont,
  kThemeDbGetDefaultTheme,
  kThemeDbGetProjectTheme,
  kThemeGetDefaultFont,
  kFontGetRids,
  kLoaderListDirectory,
  kLoaderHasCached,
  kLoaderGetCachedRef,
  kImageGetWidth,
  kImageGetHeight,
  kImageGetFormat,
  kImageHasMipmaps,
  // G8m: pre-arm materials and shaders (D11, D12).
  kShaderGetCode,
  kShaderSetCode,
  kShaderGetDefaultTextureParameter,
  kShaderMaterialGetShader,
  kShaderMaterialGetShaderParameter,
  kCimGetBlendMode,
  kCimGetLightMode,
  kCimGetParticlesAnimation,
  kCimGetParticlesAnimHFrames,
  kCimGetParticlesAnimVFrames,
  kCimGetParticlesAnimLoop,
  kResourceGetPath,
  kResourceSetPathCache,
  kObjectConnect,
  kObjectDisconnect,
  kRsCanvasItemGetInstanceShaderParameterList,
  kRsCanvasItemGetInstanceShaderParameter,
  kRsCanvasItemGetInstanceShaderParameterDefault,
  // TAG1 (client-extensions-design.md §2.3): an item's identity.
  kObjectGetClass,
  kObjectGetScript,
  kObjectHasMeta,
  kObjectGetMeta,
  kNodeGetSceneFilePath,
  kNodeGetOwner,
  kNodeGetPathTo,
  kNodeIsInGroup,
  kBindCount,
};

const BindSpec kBinds[kBindCount] = {
    {"Engine", "get_main_loop", 1016888095LL},
    {"Engine", "get_process_frames", 3905245786LL},
    {"OS", "get_main_thread_id", 3905245786LL},
    {"OS", "get_thread_caller_id", 3905245786LL},
    {"SceneTree", "get_root", 1757182445LL},
    {"Node", "get_child_count", 894402480LL},     // (bool include_internal) -> int
    {"Node", "get_child", 541253412LL},           // (int idx, bool include_internal) -> Node
    {"Node", "get_index", 894402480LL},           // (bool include_internal) -> int
    {"Node", "get_parent", 3160264692LL},         // -> Node (LATE-RES: the item's node parent)
    {"Node", "get_viewport", 3596683776LL},       // -> Viewport
    {"Object", "get_instance_id", 3905245786LL},
    {"Viewport", "get_viewport_rid", 2944877500LL},
    {"Viewport", "find_world_2d", 2339128592LL},  // -> World2D
    {"World2D", "get_canvas", 2944877500LL},
    {"CanvasItem", "get_canvas_item", 2944877500LL},
    {"CanvasItem", "is_visible_in_tree", 36873697LL},
    {"CanvasItem", "is_set_as_top_level", 36873697LL},
    {"CanvasItem", "get_modulate", 3444240500LL},
    {"CanvasItem", "get_self_modulate", 3444240500LL},
    {"CanvasItem", "get_z_index", 3905245786LL},
    {"CanvasItem", "is_z_relative", 36873697LL},
    {"CanvasItem", "is_draw_behind_parent_enabled", 36873697LL},
    {"CanvasItem", "get_transform", 3814499831LL},
    {"CanvasItem", "get_canvas", 2944877500LL},
    {"CanvasItem", "get_material", 5934680LL},    // -> Material (a Ref)
    {"CanvasItem", "get_use_parent_material", 36873697LL},
    {"CanvasItem", "get_visibility_layer", 3905245786LL},
    {"CanvasItem", "get_texture_filter", 121960042LL},
    {"CanvasItem", "get_texture_repeat", 2667158319LL},
    {"CanvasItem", "queue_redraw", 3218959716LL},
    {"CanvasItem", "_top_level_raise_self", 3218959716LL},
    {"CanvasLayer", "get_canvas", 2944877500LL},
    {"CanvasLayer", "get_layer", 3905245786LL},
    {"CanvasLayer", "get_transform", 3814499831LL},
    {"CanvasLayer", "is_following_viewport", 36873697LL},
    {"CanvasLayer", "get_follow_viewport_scale", 1740695150LL},
    {"CanvasLayer", "get_custom_viewport", 3160264692LL},  // -> Node
    {"CanvasModulate", "get_color", 3444240500LL},
    {"Resource", "get_rid", 2944877500LL},
    {"ParallaxLayer", "get_mirroring", 3341600327LL},
    {"Parallax2D", "get_repeat_size", 3341600327LL},
    {"Parallax2D", "get_repeat_times", 3905245786LL},
    // CG1 (render-stream-10.md "Capture"/"Adoption"), every one const.
    {"CanvasItem", "get_clip_children_mode", 3581808349LL},  // -> CanvasItem.ClipChildrenMode
    {"CanvasGroup", "get_clear_margin", 1740695150LL},       // -> float
    {"CanvasGroup", "get_fit_margin", 1740695150LL},         // -> float
    {"CanvasGroup", "is_using_mipmaps", 36873697LL},         // -> bool
    {"BackBufferCopy", "get_copy_mode", 3271169440LL},       // -> BackBufferCopy.CopyMode
    {"BackBufferCopy", "get_rect", 1639390495LL},            // -> Rect2
    // UIT (render-stream-11.md "As built (UIT)"), const.
    {"CPUParticles2D", "get_use_local_coordinates", 36873697LL},  // -> bool
    // G8r (gate8-design.md D6, D7), every one read-only.
    {"RenderingServer", "texture_2d_get", 4206205781LL},          // (RID) -> Image
    {"RenderingServer", "mesh_get_surface_count", 2198884583LL},  // (RID) -> int
    {"RenderingServer", "mesh_get_surface", 186674697LL},         // (RID, int) -> Dictionary
    {"RenderingServer", "mesh_get_custom_aabb", 974181306LL},     // (RID) -> AABB
    // PM9 (late-arm multimesh adoption), read-only and const.
    {"RenderingServer", "multimesh_get_buffer", 3964669176LL},  // (RID) -> PackedFloat32Array
    // PM9 (late-arm canvas texture adoption), every one read-only and const.
    {"CanvasTexture", "get_diffuse_texture", 3635182373LL},   // -> Texture2D
    {"CanvasTexture", "get_normal_texture", 3635182373LL},    // -> Texture2D
    {"CanvasTexture", "get_specular_texture", 3635182373LL},  // -> Texture2D
    {"CanvasTexture", "get_texture_filter", 121960042LL},     // -> CanvasItem.TextureFilter
    {"CanvasTexture", "get_texture_repeat", 2667158319LL},    // -> CanvasItem.TextureRepeat
    {"TextServerManager", "get_primary_interface", 905850878LL},  // -> TextServer
    {"TextServer", "font_get_size_cache_list", 2684255073LL},     // (RID) -> Array[Vector2i]
    {"TextServer", "font_get_texture_count", 1311001310LL},       // (RID, Vector2i) -> int
    {"TextServer", "font_get_texture_image", 2451761155LL},       // (RID, Vector2i, int) -> Image
    {"TextServer", "font_get_glyph_list", 46086620LL},            // (RID, Vector2i) -> int32[]
    {"TextServer", "font_get_glyph_texture_idx", 4292800474LL},   // (RID, Vector2i, int) -> int
    {"TextServer", "font_get_glyph_texture_rid", 1451696141LL},   // (RID, Vector2i, int) -> RID
    {"ThemeDB", "get_fallback_font", 3656929885LL},               // -> Font
    {"ThemeDB", "get_default_theme", 754276358LL},                // -> Theme
    {"ThemeDB", "get_project_theme", 754276358LL},                // -> Theme
    {"Theme", "get_default_font", 3229501585LL},                  // -> Font
    {"Font", "get_rids", 3995934104LL},                           // -> Array[RID]
    {"ResourceLoader", "list_directory", 3538744774LL},           // (String) -> String[]
    {"ResourceLoader", "has_cached", 2323990056LL},               // (String) -> bool
    {"ResourceLoader", "get_cached_ref", 1748875256LL},           // (String) -> Resource
    {"Image", "get_width", 3905245786LL},
    {"Image", "get_height", 3905245786LL},
    {"Image", "get_format", 3847873762LL},
    {"Image", "has_mipmaps", 36873697LL},
    // G8m (gate8-design.md D11, D12). set_code and set_path_cache act on the capture's own
    // temporary Shader only; connect/disconnect add and remove the node map's one callable.
    {"Shader", "get_code", 201670096LL},                          // -> String
    {"Shader", "set_code", 83702148LL},                           // (String)
    {"Shader", "get_default_texture_parameter", 4213877425LL},    // (StringName, int) -> Texture
    {"ShaderMaterial", "get_shader", 2078273437LL},               // -> Shader
    {"ShaderMaterial", "get_shader_parameter", 2760726917LL},     // (StringName) -> Variant
    {"CanvasItemMaterial", "get_blend_mode", 3318684035LL},
    {"CanvasItemMaterial", "get_light_mode", 3863292382LL},
    {"CanvasItemMaterial", "get_particles_animation", 36873697LL},
    {"CanvasItemMaterial", "get_particles_anim_h_frames", 3905245786LL},
    {"CanvasItemMaterial", "get_particles_anim_v_frames", 3905245786LL},
    {"CanvasItemMaterial", "get_particles_anim_loop", 36873697LL},
    {"Resource", "get_path", 201670096LL},                        // -> String
    {"Resource", "set_path_cache", 83702148LL},                   // (String)
    {"Object", "connect", 1518946055LL},                          // (StringName, Callable, int)
    {"Object", "disconnect", 1874754934LL},                       // (StringName, Callable)
    {"RenderingServer", "canvas_item_get_instance_shader_parameter_list", 2684255073LL},
    {"RenderingServer", "canvas_item_get_instance_shader_parameter", 2621281810LL},
    {"RenderingServer", "canvas_item_get_instance_shader_parameter_default_value", 2621281810LL},
    {"Object", "get_class", 201670096LL},               // -> String
    {"Object", "get_script", 1214101251LL},             // -> Variant
    {"Object", "has_meta", 2619796661LL},               // (StringName) -> bool
    {"Object", "get_meta", 3990617847LL},               // (StringName, Variant) -> Variant
    {"Node", "get_scene_file_path", 201670096LL},       // -> String
    {"Node", "get_owner", 3160264692LL},                // -> Node
    {"Node", "get_path_to", 498846349LL},               // (Node, bool) -> NodePath
    {"Node", "is_in_group", 2619796661LL},              // (StringName) -> bool
};

GDExtensionMethodBindPtr g_bind[kBindCount] = {};
bool g_binds_resolved = false;
std::unordered_map<std::uint64_t, std::uint64_t> g_item_nodes;
// G8m: the walk's items that draw with a material (own or inherited), for their instance params.
std::vector<std::uint64_t> g_walk_material_items;
// G8m: guards g_item_nodes once SceneTree.node_added can write it (any thread that adds a node).
std::mutex g_node_mutex;

bool resolve_binds(std::string *missing) {
  if (g_iface.classdb_get_method_bind == nullptr || g_iface.object_method_bind_ptrcall == nullptr ||
      g_iface.classdb_get_class_tag == nullptr || g_iface.object_cast_to == nullptr ||
      g_iface.ref_get_object == nullptr || g_iface.ref_set_object == nullptr ||
      g_iface.image_ptr == nullptr || g_iface.variant_get_ptr_constructor == nullptr ||
      g_iface.variant_get_ptr_destructor == nullptr ||
      g_iface.get_variant_to_type_constructor == nullptr ||
      g_iface.get_variant_from_type_constructor == nullptr || g_iface.variant_destroy == nullptr ||
      g_iface.variant_get_ptr_builtin_method == nullptr ||
      g_iface.array_operator_index_const == nullptr ||
      g_iface.string_new_with_utf8_chars == nullptr || g_iface.string_to_utf8_chars == nullptr ||
      g_iface.classdb_construct_object2 == nullptr || g_iface.object_destroy == nullptr ||
      g_iface.callable_custom_create2 == nullptr ||
      g_iface.object_get_instance_from_id == nullptr || g_iface.get_godot_version2 == nullptr) {
    *missing = "GDExtension interface (method binds, cast_to, refs, variants, arrays, objects, "
               "callables)";
    return false;
  }
  for (int i = 0; i < kBindCount; ++i) {
    if (g_bind[i] == nullptr) {
      g_bind[i] = method_bind(kBinds[i].cls, kBinds[i].method, kBinds[i].hash);
    }
    if (g_bind[i] == nullptr) {
      *missing = std::string(kBinds[i].cls) + "." + kBinds[i].method;
      return false;
    }
  }
  g_binds_resolved = true;
  return true;
}

void ptrcall(BindId id, void *instance, const GDExtensionConstTypePtr *args, void *ret) {
  g_iface.object_method_bind_ptrcall(g_bind[id], instance, args, ret);
}

std::int64_t get_int(BindId id, void *instance) {
  std::int64_t out = 0;
  ptrcall(id, instance, nullptr, &out);
  return out;
}

bool get_bool(BindId id, void *instance) {
  std::uint8_t out = 0;
  ptrcall(id, instance, nullptr, &out);
  return out != 0;
}

std::uint64_t get_rid(BindId id, void *instance) {
  std::uint64_t out = 0;
  ptrcall(id, instance, nullptr, &out);
  return out;
}

void *get_object(BindId id, void *instance) {
  void *out = nullptr;
  ptrcall(id, instance, nullptr, &out);
  return out;
}

// Transform2D and Color are real_t (float) on the release template: six and four floats.
rs2::Xform get_xform(BindId id, void *instance) {
  alignas(16) float raw[8] = {};
  ptrcall(id, instance, nullptr, raw);
  return {raw[0], raw[1], raw[2], raw[3], raw[4], raw[5]};
}

rs2::Color4 get_color(BindId id, void *instance) {
  alignas(16) float raw[4] = {1.0f, 1.0f, 1.0f, 1.0f};
  ptrcall(id, instance, nullptr, raw);
  return {raw[0], raw[1], raw[2], raw[3]};
}

void get_vector2(BindId id, void *instance, float out[2]) {
  alignas(16) float raw[4] = {};
  ptrcall(id, instance, nullptr, raw);
  out[0] = raw[0];
  out[1] = raw[1];
}

std::int64_t child_count(void *node) {
  const std::uint8_t internal = 1;
  const GDExtensionConstTypePtr args[1] = {&internal};
  std::int64_t out = 0;
  ptrcall(kNodeGetChildCount, node, args, &out);
  return out;
}

void *child_at(void *node, std::int64_t index) {
  const std::uint8_t internal = 1;
  const GDExtensionConstTypePtr args[2] = {&index, &internal};
  void *out = nullptr;
  ptrcall(kNodeGetChild, node, args, &out);
  return out;
}

std::int32_t node_index(void *node) {
  const std::uint8_t internal = 1;  // update_draw_order's get_index() default (node.h:543)
  const GDExtensionConstTypePtr args[1] = {&internal};
  std::int64_t out = 0;
  ptrcall(kNodeGetIndex, node, args, &out);
  return static_cast<std::int32_t>(out);
}

// The RID of a Ref<Resource>-returning getter's object, 0 when null.
std::uint64_t ref_rid(BindId getter, void *instance) {
  RefHolder ref;
  if (!ref.call(g_bind[getter], instance) || ref.object() == nullptr) {
    return 0;
  }
  return get_rid(kResourceGetRid, ref.object());
}

std::uint64_t world_canvas_of(void *viewport) {
  RefHolder world;
  if (!world.call(g_bind[kViewportFindWorld2d], viewport) || world.object() == nullptr) {
    return 0;
  }
  return get_rid(kWorld2dGetCanvas, world.object());
}

// Class tags, resolved once per walk (iface.h cast_to builds a StringName per call).
struct Tags {
  void *viewport = nullptr, *canvas_item = nullptr, *canvas_layer = nullptr, *light = nullptr,
       *parallax_layer = nullptr, *parallax2d = nullptr, *canvas_modulate = nullptr,
       *canvas_group = nullptr, *back_buffer_copy = nullptr, *cpu_particles_2d = nullptr;
  static void *tag(const char *name) {
    StringName n(name);
    return g_iface.classdb_get_class_tag(n.ptr());
  }
  void resolve() {
    viewport = tag("Viewport");
    canvas_item = tag("CanvasItem");
    canvas_layer = tag("CanvasLayer");
    light = tag("Light2D");
    parallax_layer = tag("ParallaxLayer");
    parallax2d = tag("Parallax2D");
    canvas_modulate = tag("CanvasModulate");
    canvas_group = tag("CanvasGroup");
    back_buffer_copy = tag("BackBufferCopy");
    cpu_particles_2d = tag("CPUParticles2D");
  }
};

void *as(void *object, void *tag) {
  return object != nullptr && tag != nullptr ? g_iface.object_cast_to(object, tag) : nullptr;
}

// Which node-class extras read_item reads (AdoptConfig's planned hooks, CG1/UIT).
struct ItemReadOptions {
  bool canvas_group = false;        // CG1: AdoptConfig::canvas_group
  bool copy_to_backbuffer = false;  // CG1: AdoptConfig::copy_to_backbuffer
  bool identity_transform = false;  // UIT: AdoptConfig::identity_transform
};

// One CanvasItem node's RS state, as its setters and NOTIFICATION_ENTER_TREE declared it to the
// server -- shared by the arm-time walk and the node_added adoption of a pooled pre-arm item
// (LATE-RES), so both read an item the same way. `parent_item`: the node's parent when it is a
// CanvasItem (else null); `parent_filter` / `parent_repeat` that parent's resolved texture
// filter/repeat caches. A top-level item has no parent item (CanvasItem::get_parent_item,
// canvas_item.cpp:547), so it neither hangs under nor inherits from its node parent.
AdoptedItem read_item(void *node, void *item, void *parent_item, std::int32_t parent_filter,
                      std::int32_t parent_repeat, const Tags &tags, const ItemReadOptions &opts) {
  AdoptedItem a;
  a.rid = get_rid(kItemGetCanvasItem, item);
  const bool top_level = get_bool(kItemIsTopLevel, item);
  // canvas_item.cpp:237-289: the parent item is null for a top-level item and for one whose
  // node parent is not a CanvasItem; such an item joins its canvas's group.
  void *effective_parent = top_level ? nullptr : parent_item;
  if (effective_parent != nullptr) {
    a.parent = get_rid(kItemGetCanvasItem, effective_parent);
    a.child_index = node_index(item);
  } else {
    a.parent = get_rid(kItemGetCanvas, item);
    a.group_member = true;
  }
  a.xform = get_xform(kItemGetTransform, item);
  a.modulate = get_color(kItemGetModulate, item);
  a.self_modulate = get_color(kItemGetSelfModulate, item);
  a.visible = get_bool(kItemIsVisibleInTree, item);
  a.z_index = static_cast<std::int32_t>(get_int(kItemGetZIndex, item));
  a.z_relative = get_bool(kItemIsZRelative, item);
  a.behind = get_bool(kItemIsBehind, item);
  a.visibility_layer = static_cast<std::uint32_t>(get_int(kItemGetVisibilityLayer, item));
  // _refresh_texture_filter_cache (canvas_item.cpp:1585-1599): PARENT_NODE (0) inherits the
  // parent item's cache, or DEFAULT (0) without a parent item; the scene enum's other values
  // equal the server's.
  const std::int32_t filter = static_cast<std::int32_t>(get_int(kItemGetTextureFilter, item));
  const std::int32_t repeat = static_cast<std::int32_t>(get_int(kItemGetTextureRepeat, item));
  a.texture_filter = filter != 0 ? filter : (effective_parent != nullptr ? parent_filter : 0);
  a.texture_repeat = repeat != 0 ? repeat : (effective_parent != nullptr ? parent_repeat : 0);
  a.material = ref_rid(kItemGetMaterial, item);
  a.use_parent_material = get_bool(kItemGetUseParentMaterial, item);
  if (as(node, tags.light) != nullptr) {
    a.light = true;  // light_2d.cpp:206 attaches on every enter
    a.light_canvas = get_rid(kItemGetCanvas, item);
  }
  if (as(node, tags.parallax_layer) != nullptr) {
    get_vector2(kParallaxLayerGetMirroring, node, a.mirroring_xy);
    a.mirroring = a.mirroring_xy[0] != 0.0f || a.mirroring_xy[1] != 0.0f;
  }
  if (as(node, tags.parallax2d) != nullptr) {
    get_vector2(kParallax2dGetRepeatSize, node, a.repeat_xy);
    a.repeat_times = static_cast<std::int32_t>(get_int(kParallax2dGetRepeatTimes, node));
    a.repeat = a.repeat_xy[0] != 0.0f || a.repeat_xy[1] != 0.0f;
  }
  if (opts.canvas_group) {
    if (as(node, tags.canvas_group) != nullptr) {
      // canvas_group.cpp:33-60, :115: every CanvasGroup setter (and its constructor) sends
      // the whole transparent group with fit_empty true; it ignores clip_children
      // (canvas_item.cpp:1699).
      double clear = 5.0;
      double fit = 10.0;
      ptrcall(kCanvasGroupGetClearMargin, node, nullptr, &clear);
      ptrcall(kCanvasGroupGetFitMargin, node, nullptr, &fit);
      a.canvas_group_mode = 3;
      a.clear_margin = static_cast<float>(clear);
      a.fit_empty = true;
      a.fit_margin = static_cast<float>(fit);
      a.blur_mipmaps = get_bool(kCanvasGroupIsUsingMipmaps, node);
    } else {
      // canvas_item.cpp:1688-1704: clip_children_mode 1/2 is the RS mode of the same value,
      // sent with the RS defaults (rendering_server.h:1626).
      const std::int64_t clip = get_int(kItemGetClipChildrenMode, item);
      if (clip == 1 || clip == 2) {
        a.canvas_group_mode = static_cast<std::int32_t>(clip);
      }
    }
  }
  if (opts.identity_transform && as(node, tags.cpu_particles_2d) != nullptr) {
    // cpu_particles_2d.cpp:110-115: the setter (and the constructor, with false) sends
    // !local_coords; nothing else in 4.5.1 makes the call.
    a.use_identity_transform = !get_bool(kCpuParticles2dGetUseLocalCoordinates, node);
  }
  if (opts.copy_to_backbuffer && as(node, tags.back_buffer_copy) != nullptr) {
    // back_buffer_copy.cpp:33-45: rect mode sends the rect, viewport mode Rect2(), disabled
    // nothing the mirror has not already got (null).
    const std::int64_t copy_mode = get_int(kBackBufferCopyGetCopyMode, node);
    if (copy_mode == 1) {
      alignas(16) float raw[4] = {};
      ptrcall(kBackBufferCopyGetRect, node, nullptr, raw);
      a.copy_to_backbuffer = true;
      a.copy_rect = {raw[0], raw[1], raw[2], raw[3]};
    } else if (copy_mode == 2) {
      a.copy_to_backbuffer = true;
      a.copy_rect = rs2::kZeroRect;
    }
  }
  return a;
}

// The tags and options the arm's walk read with, kept for the node_added adoption (LATE-RES).
Tags g_item_tags;
ItemReadOptions g_item_read;

struct Walker {
  Tags tags;
  void *root = nullptr;
  ItemReadOptions opts;
  AdoptPlan plan;
  // canvas RID -> the canvas group's members (top-level items) in tree order
  std::vector<std::pair<std::uint64_t, std::vector<void *>>> groups;
  std::vector<void *> item_nodes;  // every adopted item node, tree order
  std::vector<std::uint64_t> modulated_canvases;

  void add_group_member(std::uint64_t canvas, void *node) {
    for (auto &g : groups) {
      if (g.first == canvas) {
        g.second.push_back(node);
        return;
      }
    }
    groups.push_back({canvas, {node}});
  }

  // `parent_item`: the parent node when it is a CanvasItem (else null); `parent_filter` and
  // `parent_repeat` its resolved texture filter/repeat caches.
  void visit(void *node, void *parent_item, std::int32_t parent_filter, std::int32_t parent_repeat) {
    if (node != root && as(node, tags.viewport) != nullptr) {
      ++plan.non_root_viewports;  // its subtree draws into another viewport: never walked (D5)
      return;
    }
    void *item = as(node, tags.canvas_item);
    std::int32_t filter_cache = 0;
    std::int32_t repeat_cache = 0;
    if (as(node, tags.canvas_layer) != nullptr) {
      AdoptedLayer layer;
      layer.canvas = get_rid(kLayerGetCanvas, node);
      void *custom = get_object(kLayerGetCustomViewport, node);
      void *vp = custom != nullptr ? as(custom, tags.viewport) : nullptr;
      if (vp == nullptr) {
        vp = get_object(kNodeGetViewport, node);
      }
      layer.viewport = vp != nullptr ? get_rid(kViewportGetViewportRid, vp) : 0;
      layer.xform = get_xform(kLayerGetTransform, node);
      layer.layer = static_cast<std::int32_t>(get_int(kLayerGetLayer, node));
      layer.index = node_index(node);
      layer.follow_viewport = get_bool(kLayerIsFollowingViewport, node);
      if (layer.follow_viewport) {
        double scale = 1.0;
        ptrcall(kLayerGetFollowViewportScale, node, nullptr, &scale);
        layer.follow_scale = static_cast<float>(scale);
        layer.follow_parent = vp != nullptr ? world_canvas_of(vp) : 0;
      }
      if (layer.canvas != 0) {
        plan.layers.push_back(layer);
      }
    } else if (item != nullptr) {
      const AdoptedItem a =
          read_item(node, item, parent_item, parent_filter, parent_repeat, tags, opts);
      filter_cache = a.texture_filter;
      repeat_cache = a.texture_repeat;
      if (as(node, tags.canvas_modulate) != nullptr && a.visible) {
        const std::uint64_t canvas = get_rid(kItemGetCanvas, item);
        bool seen = false;
        for (std::uint64_t c : modulated_canvases) {
          seen = seen || c == canvas;
        }
        if (!seen && canvas != 0) {
          modulated_canvases.push_back(canvas);
          plan.canvas_modulates.push_back({canvas, get_color(kModulateGetColor, node)});
        }
      }
      if (a.rid != 0) {
        plan.items.push_back(a);
        item_nodes.push_back(item);
        g_item_nodes[a.rid] = static_cast<std::uint64_t>(get_int(kObjectGetInstanceId, item));
        if (a.material != 0 || a.use_parent_material) {
          g_walk_material_items.push_back(a.rid);
        }
        if (a.group_member) {
          add_group_member(a.parent, item);
        }
      }
    }
    const std::int64_t count = child_count(node);
    for (std::int64_t i = 0; i < count; ++i) {
      void *child = child_at(node, i);
      if (child != nullptr) {
        visit(child, item, filter_cache, repeat_cache);
      }
    }
  }
};

std::uint64_t now_ns() {
  return static_cast<std::uint64_t>(std::chrono::duration_cast<std::chrono::nanoseconds>(
                                        std::chrono::steady_clock::now().time_since_epoch())
                                        .count());
}

}  // namespace

bool adopt_binds_ready(std::string *missing) {
  if (g_binds_resolved) {
    return true;
  }
  std::string what;
  const bool ok = resolve_binds(&what);
  if (!ok && missing != nullptr) {
    *missing = what;
  }
  return ok;
}

bool adopt_on_main_thread(std::string *detail) {
  std::string missing;
  if (!adopt_binds_ready(&missing)) {
    if (detail != nullptr) {
      *detail = "cannot read the thread ids (" + missing + ")";
    }
    return false;
  }
  void *os = singleton_object("OS");
  if (os == nullptr) {
    if (detail != nullptr) {
      *detail = "no OS singleton";
    }
    return false;
  }
  const std::int64_t main_id = get_int(kOsGetMainThreadId, os);
  const std::int64_t caller_id = get_int(kOsGetThreadCallerId, os);
  if (main_id != caller_id && detail != nullptr) {
    *detail = "armed on thread " + std::to_string(caller_id) + ", main thread " +
              std::to_string(main_id);
  }
  return main_id == caller_id;
}

std::int64_t adopt_engine_process_frames() {
  if (!adopt_binds_ready(nullptr)) {
    return -1;
  }
  void *engine = singleton_object("Engine");
  return engine != nullptr ? get_int(kEngineGetProcessFrames, engine) : -1;
}

const std::unordered_map<std::uint64_t, std::uint64_t> &adopted_item_nodes() {
  return g_item_nodes;
}

AdoptStats adopt_at_arm(const AdoptConfig &config) {
  AdoptStats stats;
  stats.ran = true;
  {
    std::lock_guard<std::mutex> lock(g_node_mutex);
    g_item_nodes.clear();
  }
  g_walk_material_items.clear();
  const std::uint64_t t0 = now_ns();
  std::string missing;
  if (!adopt_binds_ready(&missing)) {
    stats.error = "adopt-unavailable: " + missing;
    return stats;
  }
  void *engine = singleton_object("Engine");
  void *tree = engine != nullptr ? cast_to(get_object(kEngineGetMainLoop, engine), "SceneTree")
                                 : nullptr;
  void *root = tree != nullptr ? cast_to(get_object(kSceneTreeGetRoot, tree), "Viewport")
                               : nullptr;
  if (root == nullptr) {
    stats.error = "no SceneTree root";
    return stats;
  }
  Walker walker;
  walker.tags.resolve();
  walker.root = root;
  walker.opts.canvas_group = config.canvas_group;
  walker.opts.copy_to_backbuffer = config.copy_to_backbuffer;
  walker.opts.identity_transform = config.identity_transform;
  g_item_tags = walker.tags;  // LATE-RES: node_added reads a pooled item as the walk does
  g_item_read = walker.opts;
  walker.visit(root, nullptr, 0, 0);
  const std::uint64_t t1 = now_ns();
  apply_adopt_plan(mirror_instance(), walker.plan, config.sabotage, config.arm_frame, &stats);
  const std::uint64_t t2 = now_ns();
  // D3's two engine requests. Every queue_redraw is deferred to this iteration's MessageQueue
  // flush, which runs before the frame callback publishes (D4); the re-raise runs now, through
  // the hooks, on items the mirror already holds.
  if (config.sabotage != AdoptSabotage::NoRedraw) {
    for (void *node : walker.item_nodes) {
      ptrcall(kItemQueueRedraw, node, nullptr, nullptr);
      ++stats.redraws;
    }
  }
  for (const auto &group : walker.groups) {
    for (void *node : group.second) {
      ptrcall(kItemTopLevelRaiseSelf, node, nullptr, nullptr);
    }
  }
  const std::uint64_t t3 = now_ns();
  stats.walk_ns = t1 - t0;
  stats.apply_ns = t2 - t1;
  stats.engine_ns = t3 - t2;
  stats.total_ns = t3 - t0;
  return stats;
}


// ===================================================================== G8r: resources by RID
//
// gate8-design.md D6, D7 and rs_adopt.h. Everything below runs inside a hook, before its mirror
// tap, so it never holds a hook lock while it calls the engine (the TextServer read-back may
// itself flush a page through the hooked texture_2d_update).

namespace {

std::atomic<bool> g_res_active{false};
// LAR2: the RenderingServer is the dummy (adopt_resources_begin), for the multimesh rules (O3).
std::atomic<bool> g_res_dummy_host{false};
std::atomic<int> g_res_fault{0};
std::thread::id g_res_main;
std::mutex g_res_mutex;  // guards the census, the refused map and the stats
AdoptResourceStats g_res_stats;
thread_local bool t_res_inside = false;

// LAR6 (late-arm-registry-design.md Q4 "Refused sets"): the one refused map, RID -> reason, for
// every family adoption refuses (textures, meshes, multimeshes, emitters, process materials; RID
// values are unique across the engine's owners, so one map holds them all). It replaces G8r's
// three sets and PM7's two, with their one rule: cleared at stream begin, erased on free. Under
// g_res_mutex. The typed counters stay per family (AdoptResourceStats, EmitterAdoptStats). The
// residual reader's (item, material) and (material, shader) pairs (g_mat_refused_*) are not RIDs
// and stay with it (M12-M14).
enum class Refusal : std::uint8_t { Texture = 1, Mesh, Multimesh, Particles, ProcessMaterial };
RidMap<Refusal> g_refused;

bool refused_locked(std::uint64_t rid) { return g_refused.find(rid) != g_refused.end(); }

// True when `rid` was not refused before (the caller counts it once).
bool refuse_locked(std::uint64_t rid, Refusal why) {
  if (refused_locked(rid)) {
    return false;
  }
  g_refused[rid] = why;
  return true;
}

bool is_refused(std::uint64_t rid) {
  std::lock_guard<std::mutex> lock(g_res_mutex);
  return refused_locked(rid);
}

bool refuse(std::uint64_t rid, Refusal why) {
  std::lock_guard<std::mutex> lock(g_res_mutex);
  return refuse_locked(rid, why);
}

// LAR6 (design R4 "Off-main references"): a reference from another thread to a kind whose adoption
// reads a getter (the getters, the TextServer and the resource cache are main-thread only, R6) is
// queued here, once per RID, and materialized at the frame boundary (adopt_frame_drain). It
// replaces "stays unknown until a main-thread reference". g_queue_mutex is a leaf: never held
// across an engine, mirror, registry or g_res_mutex call.
std::mutex g_queue_mutex;
std::vector<std::pair<std::uint64_t, RefKind>> g_queue;
RidMap<std::uint8_t> g_queued;  // 1: queued; 0: freed while queued (skipped at the drain)
std::atomic<bool> g_queue_nonempty{false};

void queue_offmain(std::uint64_t rid, RefKind ref) {
  {
    std::lock_guard<std::mutex> lock(g_queue_mutex);
    const auto it = g_queued.find(rid);
    if (it != g_queued.end() && it->second != 0) {
      return;  // already queued
    }
    g_queued[rid] = 1;
    g_queue.emplace_back(rid, ref);
    g_queue_nonempty.store(true, std::memory_order_release);
  }
  std::lock_guard<std::mutex> lock(g_res_mutex);
  ++g_res_stats.offmain_queued;
}

void queue_reset() {
  std::lock_guard<std::mutex> lock(g_queue_mutex);
  g_queue.clear();
  g_queued.clear();
  g_queue_nonempty.store(false, std::memory_order_release);
}

// One glyph atlas page the census found (D7): its font cache and index.
struct FontPage {
  std::uint64_t font = 0;
  std::int32_t size[2] = {0, 0};  // the cache key font_get_size_cache_list names (size, outline)
  std::int64_t page = 0;
};

struct Census {
  bool built = false;
  std::vector<FontPage> pages;
  std::unordered_set<std::uint64_t> compressed;  // CompressedTexture2D RIDs in the cache
  std::unordered_map<std::uint64_t, std::string> canvas_textures;  // PM9: CanvasTexture RID -> path
};
Census g_census;

// LAR1: a CanvasTexture's channels are the registry's (rs_registry.h RegistryCanvasTexture), not
// a map of this file's: LATE-SPINE's g_ctex_channels moved there, recorded with GRC_ADOPT=arm only
// and armed or not.

AdoptFault fault() { return static_cast<AdoptFault>(g_res_fault.load(std::memory_order_acquire)); }

// A Ref<T> return slot: one pointer, released through ref_set_object.
struct RefSlot {
  void *slot = nullptr;
  RefSlot() = default;
  RefSlot(const RefSlot &) = delete;
  RefSlot &operator=(const RefSlot &) = delete;
  ~RefSlot() {
    if (slot != nullptr) {
      g_iface.ref_set_object(&slot, nullptr);
    }
  }
  void *object() const { return slot != nullptr ? g_iface.ref_get_object(&slot) : nullptr; }
};

// A builtin value (String, Array, Dictionary, a packed array, Variant): default-constructed through
// the engine's own constructor and destroyed through its destructor.
struct Builtin {
  GDExtensionVariantType type;
  alignas(16) unsigned char data[32] = {};
  explicit Builtin(GDExtensionVariantType t) : type(t) {
    const GDExtensionPtrConstructor ctor = g_iface.variant_get_ptr_constructor(type, 0);
    if (ctor != nullptr) {
      ctor(data, nullptr);
    }
  }
  Builtin(const Builtin &) = delete;
  Builtin &operator=(const Builtin &) = delete;
  ~Builtin() {
    const GDExtensionPtrDestructor dtor = g_iface.variant_get_ptr_destructor(type);
    if (dtor != nullptr) {
      dtor(data);
    }
  }
  void *ptr() { return data; }
};

// A String built from UTF-8 (string_new_with_utf8_chars constructs in place).
struct OwnedString {
  alignas(8) unsigned char data[8] = {};
  explicit OwnedString(const std::string &text) {
    g_iface.string_new_with_utf8_chars(data, text.c_str());
  }
  OwnedString(const OwnedString &) = delete;
  OwnedString &operator=(const OwnedString &) = delete;
  ~OwnedString() {
    const GDExtensionPtrDestructor dtor =
        g_iface.variant_get_ptr_destructor(GDEXTENSION_VARIANT_TYPE_STRING);
    if (dtor != nullptr) {
      dtor(data);
    }
  }
};

// A Variant slot (24 bytes; all zero is NIL), destroyed through variant_destroy.
struct VariantSlot {
  alignas(8) unsigned char data[24] = {};
  VariantSlot() = default;
  VariantSlot(const VariantSlot &) = delete;
  VariantSlot &operator=(const VariantSlot &) = delete;
  ~VariantSlot() { g_iface.variant_destroy(data); }
  GDExtensionVariantType type() const {
    return g_iface.variant_get_type(const_cast<unsigned char *>(data));
  }
};

std::string utf8_of(const void *string) {
  const GDExtensionInt n = g_iface.string_to_utf8_chars(string, nullptr, 0);
  if (n <= 0) {
    return std::string();
  }
  std::string out(static_cast<std::size_t>(n), '\0');
  g_iface.string_to_utf8_chars(string, &out[0], n);
  return out;
}

std::int64_t array_size(void *array) {
  static GDExtensionPtrBuiltInMethod size = nullptr;
  if (size == nullptr) {
    StringName name("size");
    size = g_iface.variant_get_ptr_builtin_method(GDEXTENSION_VARIANT_TYPE_ARRAY, name.ptr(),
                                                   3173160232LL);
  }
  std::int64_t out = 0;
  if (size != nullptr) {
    size(array, nullptr, &out, 0);
  }
  return out;
}

// Element `i` of an Array converted to a concrete type (false when the element is not `type`).
template <typename T>
bool array_element(void *array, std::int64_t i, GDExtensionVariantType type, T *out) {
  void *variant = g_iface.array_operator_index_const(array, i);
  if (variant == nullptr || g_iface.variant_get_type(variant) != type) {
    return false;
  }
  const GDExtensionTypeFromVariantConstructorFunc ctor =
      g_iface.get_variant_to_type_constructor(type);
  if (ctor == nullptr) {
    return false;
  }
  ctor(out, variant);
  return true;
}

std::vector<std::uint64_t> rids_of_font(void *font) {
  std::vector<std::uint64_t> out;
  Builtin array(GDEXTENSION_VARIANT_TYPE_ARRAY);
  ptrcall(kFontGetRids, font, nullptr, array.ptr());
  const std::int64_t n = array_size(array.ptr());
  for (std::int64_t i = 0; i < n; ++i) {
    std::uint64_t rid = 0;
    if (array_element(array.ptr(), i, GDEXTENSION_VARIANT_TYPE_RID, &rid) && rid != 0) {
      out.push_back(rid);
    }
  }
  return out;
}

void *text_server(RefSlot *holder) {
  void *manager = singleton_object("TextServerManager");
  if (manager == nullptr) {
    return nullptr;
  }
  ptrcall(kTsmGetPrimaryInterface, manager, nullptr, &holder->slot);
  return holder->object();
}

struct ImageShape {
  std::int64_t width = -1, height = -1, format = -1;
  bool mipmaps = false;
  const std::uint8_t *data = nullptr;
  std::int64_t level0_bytes = -1;
};

ImageShape shape_of(void *image) {
  ImageShape out;
  if (image == nullptr) {
    return out;
  }
  out.width = get_int(kImageGetWidth, image);
  out.height = get_int(kImageGetHeight, image);
  out.format = get_int(kImageGetFormat, image);
  out.mipmaps = get_bool(kImageHasMipmaps, image);
  out.data = g_iface.image_ptr(image);
  out.level0_bytes = expected_data_bytes(out.format, out.width, out.height, false);
  return out;
}

// D7's page test, without touching the page: the dummy's creation copy `c` is a page state the
// current page `i` grew from (glyphs are only ever added to a shelf atlas), so every non-zero byte
// of `c` equals `i`'s and `c` is not blank. Only a page that passes is confirmed by RID.
bool page_consistent(const ImageShape &c, const ImageShape &i) {
  if (c.width != i.width || c.height != i.height || c.format != i.format ||
      c.mipmaps != i.mipmaps || c.data == nullptr || i.data == nullptr || c.level0_bytes <= 0 ||
      c.level0_bytes != i.level0_bytes) {
    return false;
  }
  bool any = false;
  for (std::int64_t k = 0; k < c.level0_bytes; ++k) {
    if (c.data[k] != 0) {
      any = true;
      if (c.data[k] != i.data[k]) {
        return false;
      }
    }
  }
  return any;
}

// The resource-cache walk (D7: ResourceLoader.list_directory + has_cached + get_cached_ref):
// every Font found contributes its RIDs, every CompressedTexture2D its RID.
void scan_directory(void *loader, const std::string &dir, int depth, std::vector<std::uint64_t> *fonts,
                    void *font_tag, void *ctex_tag, void *canvas_tag, std::uint32_t *paths) {
  if (depth > 32 || *paths > 200000) {
    return;
  }
  Builtin list(GDEXTENSION_VARIANT_TYPE_PACKED_STRING_ARRAY);
  {
    OwnedString arg(dir);
    const GDExtensionConstTypePtr args[1] = {arg.data};
    ptrcall(kLoaderListDirectory, loader, args, list.ptr());
  }
  // PackedStringArray is a Vector<String>: the write proxy word, then the CowData pointer to
  // 8-byte Strings (abi.h, memory godot-vector-abi-two-words).
  const unsigned char *cow = nullptr;
  std::memcpy(&cow, list.data + 8, sizeof(cow));
  const std::int64_t count = cowdata_size(cow);
  std::vector<std::string> names;
  for (std::int64_t i = 0; i < count; ++i) {
    names.push_back(utf8_of(cow + i * 8));
  }
  for (const std::string &name : names) {
    const std::string path = dir.back() == '/' ? dir + name : dir + "/" + name;
    if (!name.empty() && name.back() == '/') {
      scan_directory(loader, path, depth + 1, fonts, font_tag, ctex_tag, canvas_tag, paths);
      continue;
    }
    ++*paths;
    OwnedString arg(path);
    const GDExtensionConstTypePtr args[1] = {arg.data};
    std::uint8_t cached = 0;
    ptrcall(kLoaderHasCached, loader, args, &cached);
    if (cached == 0) {
      continue;
    }
    RefSlot res;
    ptrcall(kLoaderGetCachedRef, loader, args, &res.slot);
    void *object = res.object();
    if (object == nullptr) {
      continue;
    }
    if (g_iface.object_cast_to(object, font_tag) != nullptr) {
      for (std::uint64_t rid : rids_of_font(object)) {
        fonts->push_back(rid);
      }
    } else if (g_iface.object_cast_to(object, ctex_tag) != nullptr) {
      g_census.compressed.insert(get_rid(kResourceGetRid, object));
    } else if (canvas_tag != nullptr && g_iface.object_cast_to(object, canvas_tag) != nullptr) {
      // PM9: a cached CanvasTexture, by its RID and path (re-fetched at adoption).
      g_census.canvas_textures[get_rid(kResourceGetRid, object)] = path;
    }
  }
}

void add_theme_fonts(std::vector<std::uint64_t> *fonts) {
  void *db = singleton_object("ThemeDB");
  if (db == nullptr) {
    return;
  }
  {
    RefSlot font;
    ptrcall(kThemeDbGetFallbackFont, db, nullptr, &font.slot);
    if (font.object() != nullptr) {
      for (std::uint64_t rid : rids_of_font(font.object())) fonts->push_back(rid);
    }
  }
  for (BindId theme_bind : {kThemeDbGetDefaultTheme, kThemeDbGetProjectTheme}) {
    RefSlot theme;
    ptrcall(theme_bind, db, nullptr, &theme.slot);
    if (theme.object() == nullptr) {
      continue;
    }
    RefSlot font;
    ptrcall(kThemeGetDefaultFont, theme.object(), nullptr, &font.slot);
    if (font.object() != nullptr) {
      for (std::uint64_t rid : rids_of_font(font.object())) fonts->push_back(rid);
    }
  }
}

// The one-time census, on the main thread, at the first unknown texture (every resource that
// existed at arm is loaded by then; anything loaded later is created under the hooks).
void build_census() {
  const std::uint64_t t0 = now_ns();
  g_census = Census();
  g_census.built = true;
  std::vector<std::uint64_t> fonts;
  add_theme_fonts(&fonts);
  std::uint32_t paths = 0;
  void *loader = singleton_object("ResourceLoader");
  if (loader != nullptr) {
    StringName font_name("Font");
    StringName ctex_name("CompressedTexture2D");
    StringName canvas_name("CanvasTexture");
    void *font_tag = g_iface.classdb_get_class_tag(font_name.ptr());
    void *ctex_tag = g_iface.classdb_get_class_tag(ctex_name.ptr());
    void *canvas_tag = g_iface.classdb_get_class_tag(canvas_name.ptr());
    if (font_tag != nullptr && ctex_tag != nullptr) {
      scan_directory(loader, "res://", 0, &fonts, font_tag, ctex_tag, canvas_tag, &paths);
    }
  }
  std::vector<std::uint64_t> unique;
  for (std::uint64_t rid : fonts) {
    bool seen = false;
    for (std::uint64_t u : unique) seen = seen || u == rid;
    if (!seen) unique.push_back(rid);
  }
  RefSlot ts_holder;
  void *ts = text_server(&ts_holder);
  if (ts != nullptr) {
    for (std::uint64_t font : unique) {
      Builtin sizes(GDEXTENSION_VARIANT_TYPE_ARRAY);
      const GDExtensionConstTypePtr a1[1] = {&font};
      ptrcall(kTsFontGetSizeCacheList, ts, a1, sizes.ptr());
      const std::int64_t n = array_size(sizes.ptr());
      for (std::int64_t i = 0; i < n; ++i) {
        std::int32_t size[2] = {0, 0};
        if (!array_element(sizes.ptr(), i, GDEXTENSION_VARIANT_TYPE_VECTOR2I, &size)) {
          continue;
        }
        const GDExtensionConstTypePtr a2[2] = {&font, size};
        std::int64_t count = 0;
        ptrcall(kTsFontGetTextureCount, ts, a2, &count);
        for (std::int64_t page = 0; page < count; ++page) {
          FontPage fp;
          fp.font = font;
          fp.size[0] = size[0];
          fp.size[1] = size[1];
          fp.page = page;
          g_census.pages.push_back(fp);
        }
      }
    }
  }
  g_res_stats.fonts = static_cast<std::uint32_t>(unique.size());
  g_res_stats.cached_compressed = static_cast<std::uint32_t>(g_census.compressed.size());
  g_res_stats.cache_paths = paths;
  g_res_stats.census_ns = now_ns() - t0;
}

// The page `rid` is, confirmed through the TextServer (font_get_glyph_texture_rid of a glyph on
// it), or false. `creation` is the dummy's copy; `*current` receives the page's current image.
bool find_atlas_page(void *ts, std::uint64_t rid, const ImageShape &creation, RefSlot *current) {
  for (const FontPage &fp : g_census.pages) {
    RefSlot page_image;
    const GDExtensionConstTypePtr a3[3] = {&fp.font, fp.size, &fp.page};
    ptrcall(kTsFontGetTextureImage, ts, a3, &page_image.slot);
    if (!page_consistent(creation, shape_of(page_image.object()))) {
      continue;
    }
    // A glyph on that page (font_get_glyph_list is the cache's glyph map).
    Builtin glyphs(GDEXTENSION_VARIANT_TYPE_PACKED_INT32_ARRAY);
    const GDExtensionConstTypePtr a2[2] = {&fp.font, fp.size};
    ptrcall(kTsFontGetGlyphList, ts, a2, glyphs.ptr());
    const std::int32_t *cow = nullptr;
    std::memcpy(&cow, glyphs.data + 8, sizeof(cow));
    const std::int64_t count = cowdata_size(cow);
    for (std::int64_t g = 0; g < count; ++g) {
      const std::int64_t glyph = cow[g];
      const GDExtensionConstTypePtr ag[3] = {&fp.font, fp.size, &glyph};
      std::int64_t idx = -1;
      ptrcall(kTsFontGetGlyphTextureIdx, ts, ag, &idx);
      if (idx != fp.page) {
        continue;
      }
      std::uint64_t page_rid = 0;
      ptrcall(kTsFontGetGlyphTextureRid, ts, ag, &page_rid);
      if (page_rid != rid) {
        break;  // this page is another texture; keep looking
      }
      ptrcall(kTsFontGetTextureImage, ts, a3, &current->slot);
      return current->object() != nullptr;
    }
  }
  return false;
}

rs2::AdoptedContent declared(rs2::AdoptedContent honest) {
  return fault() == AdoptFault::ClaimCurrent ? rs2::AdoptedContent::Current : honest;
}

void materialize_texture(std::uint64_t rid);  // forward
void *node_of(std::uint64_t item_rid);  // forward (defined in the G8m section, below)

// PM9: read a cached CanvasTexture resource's channels and register the adopted entry, as
// canvas_texture_create + set_channel + set_filter + set_repeat would have (the residual path,
// adopt_canvas_texture_locked_out). `canvas` is the CanvasTexture resource object.
bool adopt_canvas_texture_resource(void *canvas, std::uint64_t rid) {
  std::uint64_t diffuse = 0;
  std::uint64_t normal = 0;
  std::uint64_t specular = 0;
  {
    RefSlot slot;
    ptrcall(kCtexGetDiffuseTexture, canvas, nullptr, &slot.slot);
    if (slot.object() != nullptr) diffuse = get_rid(kResourceGetRid, slot.object());
  }
  {
    RefSlot slot;
    ptrcall(kCtexGetNormalTexture, canvas, nullptr, &slot.slot);
    if (slot.object() != nullptr) normal = get_rid(kResourceGetRid, slot.object());
  }
  {
    RefSlot slot;
    ptrcall(kCtexGetSpecularTexture, canvas, nullptr, &slot.slot);
    if (slot.object() != nullptr) specular = get_rid(kResourceGetRid, slot.object());
  }
  std::int64_t filter = 0;
  std::int64_t repeat = 0;
  ptrcall(kCtexGetTextureFilter, canvas, nullptr, &filter);
  ptrcall(kCtexGetTextureRepeat, canvas, nullptr, &repeat);
  // The channel textures are adopted first (a canvas texture's diffuse must be a known texture);
  // one the mirror knows or this stream refused is not read back again (CanvasTextures share
  // atlas pages).
  materialize_texture(diffuse);
  materialize_texture(normal);
  materialize_texture(specular);
  return hooks_adopt_canvas_texture(rid, diffuse, normal, specular, static_cast<std::int32_t>(filter),
                                    static_cast<std::int32_t>(repeat));
}

// PM9 (late-arm canvas texture adoption), the residual path only since LAR1 (design Q3): a
// CanvasTexture the registry never saw created (it predates the extension's load) whose channels
// are read from its resource, found in the resource cache by the census. The channel textures are
// adopted through G8r first, then the canvas texture entry is registered.
bool adopt_canvas_texture_locked_out(std::uint64_t rid) {
  std::string path;
  {
    std::lock_guard<std::mutex> lock(g_res_mutex);
    const auto it = g_census.canvas_textures.find(rid);
    if (it == g_census.canvas_textures.end()) {
      return false;
    }
    path = it->second;
  }
  void *loader = singleton_object("ResourceLoader");
  if (loader == nullptr) {
    return false;
  }
  RefSlot res;
  {
    OwnedString arg(path);
    const GDExtensionConstTypePtr args[1] = {arg.data};
    ptrcall(kLoaderGetCachedRef, loader, args, &res.slot);
  }
  void *canvas = res.object();
  void *ct_tag = Tags::tag("CanvasTexture");
  // As the node path: the cached resource at the census path must still be this CanvasTexture
  // (the path may have been re-cached by another resource since the census).
  if (canvas == nullptr || ct_tag == nullptr || as(canvas, ct_tag) == nullptr ||
      get_rid(kResourceGetRid, canvas) != rid) {
    return false;
  }
  return adopt_canvas_texture_resource(canvas, rid);
}

// LAR1 (design R4, M8 generalized): a registered CanvasTexture -- one whose canvas_texture_create
// the hooks saw, before or after the arm -- adopted from the registry's recorded channels, filter
// and repeat, its channel textures first. No getter runs on the CanvasTexture RID itself (it has
// none, and the kind is the registry's, not inferred from texture_2d_get's empty answer). Refused,
// typed `canvas-empty`, when no diffuse was ever set: a CanvasTexture with no diffuse has nothing
// to draw from, so there is nothing to adopt. Main thread (the channel read-backs).
void adopt_canvas_texture_registered(std::uint64_t rid, const rs::RegistryCanvasTexture &c) {
  const std::uint64_t t0 = now_ns();
  bool adopted = false;
  if (c.diffuse_set && c.diffuse != 0) {
    materialize_texture(c.diffuse);
    materialize_texture(c.normal);
    materialize_texture(c.specular);
    adopted = hooks_adopt_canvas_texture(rid, c.diffuse, c.normal, c.specular, c.filter, c.repeat);
  }
  std::lock_guard<std::mutex> lock(g_res_mutex);
  if (adopted) {
    ++g_res_stats.textures;
    ++g_res_stats.textures_canvas;
    ++g_res_stats.canvas_registry;
  } else if (refuse_locked(rid, Refusal::Texture)) {
    ++g_res_stats.textures_refused;
    if (!c.diffuse_set || c.diffuse == 0) {
      ++g_res_stats.refused_canvas_empty;
    }
  }
  g_res_stats.lookup_ns += now_ns() - t0;
}

// The texture family's read-back for a RID the registry does not hold as a CanvasTexture: a
// registered 2D texture (its getter is the payload) or any unregistered RID (the residual path,
// design Q3). LAR6 (design R4, Q4 M3): a registered texture whose `updated` bit is clear was never
// changed since its create, so the getter's creation copy IS its content: `current`, provably,
// with no census and no TextServer read. Anything updated (an ImageTexture.update, a glyph page
// growing, a texture_replace) keeps G8r's rule: an atlas page or a cached compressed texture is
// current, anything else creation. The census is built only when such a texture needs it.
void adopt_texture_locked_out(std::uint64_t rid) {
  const std::uint64_t t0 = now_ns();
  const bool main = std::this_thread::get_id() == g_res_main;
  rs::RegistryKind kind = rs::RegistryKind::Texture2d;
  bool updated = true;
  const bool pristine = rs::registry_on() && rs::registry_lookup(rid, &kind, &updated) &&
                        rs::registry_family(kind) == rs::RegistryFamily::Texture && !updated;
  {
    std::lock_guard<std::mutex> lock(g_res_mutex);
    if (main && !pristine && !g_census.built) {
      build_census();
    }
  }
  RefSlot creation;
  {
    void *rs_singleton = singleton_object("RenderingServer");
    if (rs_singleton != nullptr) {
      const GDExtensionConstTypePtr args[1] = {&rid};
      ptrcall(kRsTexture2dGet, rs_singleton, args, &creation.slot);
    }
  }
  void *creation_image = creation.object();
  if (creation_image == nullptr) {
    // No image (design Q3's residual): a CanvasTexture created before the extension loaded, which
    // only a cached `.tres` (PM9, the census) can describe. Anything else -- a runtime-built
    // CanvasTexture the hooks never saw (a load-late arm, F1), a placeholder, a proxy -- is
    // refused, typed `no-image`. RT-CTX's node read (M7) is gone: the registry covers every
    // CanvasTexture created under the hooks, and load-late is not a fidelity target (F1).
    const bool adopted_canvas = main && adopt_canvas_texture_locked_out(rid);
    std::lock_guard<std::mutex> lock(g_res_mutex);
    if (adopted_canvas) {
      ++g_res_stats.textures;
      ++g_res_stats.textures_canvas;
      ++g_res_stats.canvas_residual;
    } else if (refuse_locked(rid, Refusal::Texture)) {
      ++g_res_stats.textures_refused;
      ++g_res_stats.refused_no_image;
    }
    g_res_stats.lookup_ns += now_ns() - t0;
    return;
  }
  bool compressed = false;
  if (!pristine) {
    std::lock_guard<std::mutex> lock(g_res_mutex);
    compressed = g_census.compressed.count(rid) != 0;
  }
  void *image = creation_image;
  rs2::AdoptedContent content = rs2::AdoptedContent::Creation;
  const char *source = "dummy";
  bool atlas = false;
  RefSlot current;
  if (pristine) {
    content = rs2::AdoptedContent::Current;  // LAR6: never updated, so the creation copy is current
    source = "registry";
  } else if (compressed) {
    content = rs2::AdoptedContent::Current;  // never updated in place (D6, render-stream-8.md)
    source = "cache";
  } else if (main) {
    RefSlot ts_holder;
    void *ts = text_server(&ts_holder);
    if (ts != nullptr && find_atlas_page(ts, rid, shape_of(creation_image), &current)) {
      atlas = true;
      content = rs2::AdoptedContent::Current;
      if (fault() == AdoptFault::AtlasFromDummy) {
        source = "dummy";  // the fault: the stale copy, still declared current
      } else {
        image = current.object();
        source = "textserver";
      }
    }
  }
  bool decoded = false;
  bool adopted = false;
  // The page test may have flushed a dirty page through the hooked update, which adopted it.
  if (!mirror_instance().knows_texture(rid)) {
    adopted = hooks_adopt_texture(rid, image, declared(content), source, &decoded);
  }
  std::lock_guard<std::mutex> lock(g_res_mutex);
  if (adopted) {
    ++g_res_stats.textures;
    if (declared(content) == rs2::AdoptedContent::Current) {
      ++g_res_stats.textures_current;
    } else {
      ++g_res_stats.textures_creation;
    }
    if (atlas) ++g_res_stats.atlas_pages;
    if (compressed) ++g_res_stats.compressed;
    if (pristine) ++g_res_stats.textures_registry;
    if (decoded) ++g_res_stats.decoded;
  }
  g_res_stats.lookup_ns += now_ns() - t0;
}

// LAR1 (design R4; M9 folded in): the texture family's dispatch (materialize's RefKind::Texture,
// every CanvasTexture's channels). A RID the mirror already knows, or one this stream refused, is
// never read back again; otherwise it dispatches on the kind the registry recorded -- a
// CanvasTexture from its recorded channels, anything else through the texture read-back. Main
// thread (materialize queues an off-main reference).
void materialize_texture(std::uint64_t rid) {
  if (rid == 0 || mirror_instance().knows_texture(rid) || is_refused(rid)) {
    return;
  }
  rs::RegistryCanvasTexture canvas;
  if (rs::registry_on() && rs::registry_canvas_texture(rid, &canvas)) {
    adopt_canvas_texture_registered(rid, canvas);
    return;
  }
  adopt_texture_locked_out(rid);
}

// mesh_get_surface's Dictionary value under `key`, into `out` (a Variant slot).
void dict_get(void *dict, const char *key, VariantSlot *out) {
  static GDExtensionPtrBuiltInMethod get = nullptr;
  if (get == nullptr) {
    StringName name("get");
    get = g_iface.variant_get_ptr_builtin_method(GDEXTENSION_VARIANT_TYPE_DICTIONARY, name.ptr(),
                                                  2205440559LL);
  }
  if (get == nullptr) {
    return;
  }
  OwnedString key_string(key);
  VariantSlot key_variant;
  g_iface.get_variant_from_type_constructor(GDEXTENSION_VARIANT_TYPE_STRING)(key_variant.data,
                                                                             key_string.data);
  VariantSlot fallback;
  const GDExtensionConstTypePtr args[2] = {key_variant.data, fallback.data};
  get(dict, args, out->data, 2);
}

template <typename T>
bool variant_as(VariantSlot *v, GDExtensionVariantType type, T *out) {
  if (v->type() != type) {
    return false;
  }
  g_iface.get_variant_to_type_constructor(type)(out, v->data);
  return true;
}

// A PackedByteArray value copied out of the Dictionary (owned bytes).
std::vector<std::uint8_t> dict_bytes(void *dict, const char *key) {
  std::vector<std::uint8_t> out;
  VariantSlot v;
  dict_get(dict, key, &v);
  if (v.type() != GDEXTENSION_VARIANT_TYPE_PACKED_BYTE_ARRAY) {
    return out;
  }
  Builtin bytes(GDEXTENSION_VARIANT_TYPE_PACKED_BYTE_ARRAY);
  g_iface.get_variant_to_type_constructor(GDEXTENSION_VARIANT_TYPE_PACKED_BYTE_ARRAY)(bytes.ptr(),
                                                                                    v.data);
  const std::uint8_t *cow = nullptr;
  std::memcpy(&cow, bytes.data + 8, sizeof(cow));
  const std::int64_t count = cowdata_size(cow);
  if (cow != nullptr && count > 0) {
    out.assign(cow, cow + count);
  }
  return out;
}

std::int64_t dict_int(void *dict, const char *key) {
  VariantSlot v;
  dict_get(dict, key, &v);
  std::int64_t out = 0;
  variant_as(&v, GDEXTENSION_VARIANT_TYPE_INT, &out);
  return out;
}

void adopt_mesh_locked_out(std::uint64_t rid) {
  const std::uint64_t t0 = now_ns();
  void *rs_singleton = singleton_object("RenderingServer");
  if (rs_singleton == nullptr) {
    return;
  }
  const GDExtensionConstTypePtr a1[1] = {&rid};
  std::int64_t count = 0;
  ptrcall(kRsMeshGetSurfaceCount, rs_singleton, a1, &count);
  struct Owned {
    std::vector<std::uint8_t> vertex, attribute, skin, index;
  };
  std::vector<Owned> owned(static_cast<std::size_t>(count > 0 ? count : 0));
  std::vector<AdoptSurface> surfaces;
  for (std::int64_t i = 0; i < count; ++i) {
    Builtin dict(GDEXTENSION_VARIANT_TYPE_DICTIONARY);
    const GDExtensionConstTypePtr a2[2] = {&rid, &i};
    ptrcall(kRsMeshGetSurface, rs_singleton, a2, dict.ptr());
    Owned &o = owned[static_cast<std::size_t>(i)];
    AdoptSurface a;
    a.primitive = static_cast<std::int32_t>(dict_int(dict.ptr(), "primitive"));
    a.format = static_cast<std::uint64_t>(dict_int(dict.ptr(), "format"));
    a.vertex_count = static_cast<std::uint32_t>(dict_int(dict.ptr(), "vertex_count"));
    a.index_count = static_cast<std::uint32_t>(dict_int(dict.ptr(), "index_count"));
    o.vertex = dict_bytes(dict.ptr(), "vertex_data");
    o.attribute = dict_bytes(dict.ptr(), "attribute_data");
    o.skin = dict_bytes(dict.ptr(), "skin_data");
    o.index = dict_bytes(dict.ptr(), "index_data");
    {
      VariantSlot v;
      dict_get(dict.ptr(), "aabb", &v);
      variant_as(&v, GDEXTENSION_VARIANT_TYPE_AABB, &a.aabb);
    }
    {
      VariantSlot v;
      dict_get(dict.ptr(), "uv_scale", &v);
      variant_as(&v, GDEXTENSION_VARIANT_TYPE_VECTOR4, &a.uv_scale);
    }
    {
      VariantSlot v;
      dict_get(dict.ptr(), "blend_shapes", &v);
      a.blend_shape_bytes = v.type() != GDEXTENSION_VARIANT_TYPE_NIL ? 1 : 0;
    }
    a.vertex = o.vertex.data();
    a.vertex_bytes = o.vertex.size();
    a.attribute = o.attribute.data();
    a.attribute_bytes = o.attribute.size();
    a.skin = o.skin.data();
    a.skin_bytes = o.skin.size();
    a.index = o.index.data();
    a.index_bytes = o.index.size();
    surfaces.push_back(a);
  }
  float aabb[6] = {};
  ptrcall(kRsMeshGetCustomAabb, rs_singleton, a1, aabb);
  const bool adopted = hooks_adopt_mesh(rid, surfaces, aabb);
  std::lock_guard<std::mutex> lock(g_res_mutex);
  if (adopted) {
    ++g_res_stats.meshes;
    g_res_stats.mesh_surfaces += static_cast<std::uint32_t>(surfaces.size());
  } else if (refuse_locked(rid, Refusal::Mesh)) {
    ++g_res_stats.meshes_refused;  // never read back again this stream
  }
  g_res_stats.lookup_ns += now_ns() - t0;
}

}  // namespace

bool parse_adopt_fault(const char *value, bool adopt, AdoptFault *out, std::string *error) {
  *out = AdoptFault::None;
  const std::string text = value != nullptr ? value : "";
  if (text.empty()) {
    return true;
  }
  if (text == "no-resources") {
    *out = AdoptFault::NoResources;
  } else if (text == "atlas-from-dummy") {
    *out = AdoptFault::AtlasFromDummy;
  } else if (text == "claim-current") {
    *out = AdoptFault::ClaimCurrent;
  } else if (text == "no-include-path") {
    *out = AdoptFault::NoIncludePath;
  } else if (text == "no-particles") {
    *out = AdoptFault::NoParticles;
  } else if (text == "registry-off") {
    *out = AdoptFault::RegistryOff;
  } else if (text == "registry-mm-stride") {
    *out = AdoptFault::RegistryMmStride;
  } else if (text == "registry-keep-freed") {
    *out = AdoptFault::RegistryKeepFreed;
  } else if (text == "registry-skip-params") {
    *out = AdoptFault::RegistrySkipParams;
  } else if (text == "registry-drop-binding") {
    *out = AdoptFault::RegistryDropBinding;
  } else if (text == "registry-skip-particles") {
    *out = AdoptFault::RegistrySkipParticles;
  } else if (text == "registry-queue-drop") {
    *out = AdoptFault::RegistryQueueDrop;
  } else {
    *error = "invalid GRC_ADOPT_FAULT=" + text +
             " (expected no-resources, atlas-from-dummy, claim-current, no-include-path, "
             "no-particles, registry-off, registry-keep-freed, registry-mm-stride, "
             "registry-skip-params, registry-drop-binding, registry-skip-particles or "
             "registry-queue-drop)";
    return false;
  }
  if (!adopt) {
    *error = "GRC_ADOPT_FAULT=" + text + " acts on lazy adoption; set GRC_ADOPT=arm";
    return false;
  }
  return true;
}

const char *adopt_fault_name(AdoptFault f) {
  switch (f) {
  case AdoptFault::None: return "none";
  case AdoptFault::NoResources: return "no-resources";
  case AdoptFault::AtlasFromDummy: return "atlas-from-dummy";
  case AdoptFault::ClaimCurrent: return "claim-current";
  case AdoptFault::NoIncludePath: return "no-include-path";
  case AdoptFault::NoParticles: return "no-particles";
  case AdoptFault::RegistryOff: return "registry-off";
  case AdoptFault::RegistryKeepFreed: return "registry-keep-freed";
  case AdoptFault::RegistryMmStride: return "registry-mm-stride";
  case AdoptFault::RegistrySkipParams: return "registry-skip-params";
  case AdoptFault::RegistryDropBinding: return "registry-drop-binding";
  case AdoptFault::RegistrySkipParticles: return "registry-skip-particles";
  case AdoptFault::RegistryQueueDrop: return "registry-queue-drop";
  }
  return "none";
}

void adopt_emitters_reset();                  // PM7, below
void adopt_emitters_forget(std::uint64_t rid);  // PM7, below

void adopt_resources_begin(AdoptFault f, bool dummy_host) {
  adopt_emitters_reset();
  queue_reset();
  std::lock_guard<std::mutex> lock(g_res_mutex);
  g_res_stats = AdoptResourceStats();
  g_refused.clear();  // LAR6: every family's refusals, PM7's emitters and process materials too
  g_census = Census();
  g_res_main = std::this_thread::get_id();
  g_res_fault.store(static_cast<int>(f), std::memory_order_release);
  g_res_dummy_host.store(dummy_host, std::memory_order_relaxed);
  g_res_active.store(true, std::memory_order_release);
}

void node_map_disconnect();  // G8m, below

void adopt_resources_end() {
  g_res_active.store(false, std::memory_order_release);
  node_map_disconnect();  // G8m: the SceneTree.node_added callable leaves with the stream
}

bool adopt_resources_active() { return g_res_active.load(std::memory_order_acquire); }

AdoptResourceStats adopt_resource_stats() {
  std::lock_guard<std::mutex> lock(g_res_mutex);
  AdoptResourceStats out = g_res_stats;
  out.refused_live = static_cast<std::uint32_t>(g_refused.size());
  return out;
}

namespace {

// materialize()'s main-thread handlers (LAR6): the gates every family shares (a null RID, adoption
// inactive or faulted off, the mirror off), a known RID, a refused RID and the off-main queue are
// materialize's; these hold what each family adds.
void ref_texture(std::uint64_t rid) {
  t_res_inside = true;
  materialize_texture(rid);
  t_res_inside = false;
}

void ref_mesh(std::uint64_t rid) {
  t_res_inside = true;
  adopt_mesh_locked_out(rid);
  t_res_inside = false;
}

}  // namespace

// LAR2's sabotage only (registry-mm-stride): PM9's format guess from the buffer's per-instance
// stride ((3d ? 12 : 8) + 4 x colors + 4 x custom). The ambiguous strides prefer the 2D reading,
// and colors over custom, so 2d + custom (12) and 3d (12) read as 2d + colors, and 3d + one of
// them (16) as 2d + both. The honest adoption never guesses: the registry recorded the allocation.
bool stride_guess_sabotage(std::int32_t instances, std::size_t floats, std::int32_t *format,
                           bool *colors, bool *custom) {
  *format = 0;
  *colors = false;
  *custom = false;
  if (instances <= 0) {
    return true;
  }
  if (floats % static_cast<std::size_t>(instances) != 0) {
    return false;
  }
  switch (floats / static_cast<std::size_t>(instances)) {
  case 8:
    return true;
  case 12:
    *colors = true;
    return true;
  case 16:
    *colors = true;
    *custom = true;
    return true;
  case 20:
    *format = 1;
    *colors = true;
    *custom = true;
    return true;
  default:
    return false;
  }
}

// Why a multimesh adoption refused (AdoptResourceStats' typed counters).
enum class MultimeshRefusal { None, Preload, EditedDummy, Buffer };

// LAR2 (late-arm-registry-design.md R2, R4, O3, F1): a multimesh is adopted from the registry's
// recorded allocation, mesh, visible count and custom AABB -- exact on every renderer, where the
// getters answer 0 / RID() / AABB() on the dummy -- with the buffer from multimesh_get_buffer
// (payload-sized, so never recorded). PM9's stride guess and its read of the drawing node's
// MultiMesh are gone:
//   - not registered (created before the hooks: a load-late arm, or GRC_ADOPT_FAULT=registry-off):
//     refused, typed `preload-multimesh` (F1: a guessed format is worse than a refusal);
//   - on the dummy host, edited per instance since its last buffer (`edited`): the dummy dropped
//     those setters, so the getter is stale; refused, typed (O3);
//   - a buffer of the allocation's size: adopted with it (GLES3 always, the dummy after a
//     set_buffer); an empty one on the dummy (never set): the allocation's zeros, which is what
//     the engine holds; any other size: refused, typed `buffer`.
void adopt_multimesh_locked_out(std::uint64_t rid) {
  const std::uint64_t t0 = now_ns();
  rs::RegistryMultimesh reg;
  MultimeshRefusal refusal = MultimeshRefusal::None;
  bool adopted = false;
  if (!registry_multimesh(rid, &reg)) {
    refusal = MultimeshRefusal::Preload;
  } else if (g_res_dummy_host.load(std::memory_order_relaxed) && reg.edited) {
    refusal = MultimeshRefusal::EditedDummy;
  } else {
    void *rs_singleton = singleton_object("RenderingServer");
    if (rs_singleton == nullptr) {
      return;
    }
    const GDExtensionConstTypePtr a1[1] = {&rid};
    Builtin buffer(GDEXTENSION_VARIANT_TYPE_PACKED_FLOAT32_ARRAY);
    ptrcall(kRsMultimeshGetBuffer, rs_singleton, a1, buffer.ptr());
    std::vector<float> floats;
    {
      const std::uint8_t *cow = nullptr;
      std::memcpy(&cow, buffer.data + 8, sizeof(cow));
      const std::int64_t count = cowdata_size(cow);
      if (cow != nullptr && count > 0) {
        const float *data = reinterpret_cast<const float *>(cow);
        floats.assign(data, data + count);
      }
    }
    const std::size_t expected =
        static_cast<std::size_t>(reg.instances) *
        static_cast<std::size_t>(rs::registry_multimesh_stride(reg.format, reg.colors, reg.custom));
    if (floats.empty() && expected > 0 && g_res_dummy_host.load(std::memory_order_relaxed)) {
      floats.assign(expected, 0.0f);  // the dummy keeps no buffer until a set_buffer
    }
    Mirror::MultimeshAdopt adopt;
    adopt.instances = reg.instances;
    adopt.format = reg.format;
    adopt.colors = reg.colors;
    adopt.custom = reg.custom;
    adopt.indirect = reg.indirect;
    adopt.visible = reg.visible;
    adopt.mesh = reg.mesh;
    adopt.custom_aabb = reg.custom_aabb;
    bool ok = floats.size() == expected;
    if (fault() == AdoptFault::RegistryMmStride) {
      // The sabotage: the recorded format ignored, PM9's guess from the buffer's stride instead.
      ok = stride_guess_sabotage(reg.instances, floats.size(), &adopt.format, &adopt.colors,
                                 &adopt.custom);
    }
    adopt.buffer = std::move(floats);
    if (!ok) {
      refusal = MultimeshRefusal::Buffer;
    } else {
      materialize(reg.mesh, RefKind::Mesh);  // G8r: the multimesh's mesh, before the entry links it
      adopted = hooks_adopt_multimesh(rid, std::move(adopt));
    }
  }
  std::lock_guard<std::mutex> lock(g_res_mutex);
  if (adopted) {
    ++g_res_stats.multimeshes;
  } else if (refuse_locked(rid, Refusal::Multimesh)) {
    // Refused once: a refused multimesh is never read back again this stream (the buffer read is
    // a GPU stall on GLES3 and blocks the main thread on a threaded RenderingServer).
    ++g_res_stats.multimeshes_refused;
    if (refusal == MultimeshRefusal::Preload) {
      ++g_res_stats.refused_preload_multimesh;
    } else if (refusal == MultimeshRefusal::EditedDummy) {
      ++g_res_stats.refused_mm_edited_dummy;
    } else if (refusal == MultimeshRefusal::Buffer) {
      ++g_res_stats.refused_mm_buffer;
    }
  }
  g_res_stats.lookup_ns += now_ns() - t0;
}

// Forgets a freed RID's per-stream refusal (a RID value the engine hands out again starts fresh,
// and the map does not grow with freed resources) and cancels its off-main queue entry (LAR6: the
// drain must not read a freed RID's getter). The registry's own free tap erases its entry.
void adopt_resource_freed(std::uint64_t rid) {
  if (rid == 0) {
    return;
  }
  if (!g_res_active.load(std::memory_order_acquire)) {
    return;
  }
  {
    std::lock_guard<std::mutex> lock(g_res_mutex);
    g_refused.erase(rid);
  }
  bool cancelled = false;
  if (g_queue_nonempty.load(std::memory_order_acquire)) {
    std::lock_guard<std::mutex> lock(g_queue_mutex);
    const auto it = g_queued.find(rid);
    if (it != g_queued.end() && it->second != 0) {
      it->second = 0;
      cancelled = true;
    }
  }
  if (cancelled) {
    std::lock_guard<std::mutex> lock(g_res_mutex);
    ++g_res_stats.offmain_dropped;
  }
  adopt_emitters_forget(rid);
}

bool adopt_from_update_begin() {
  if (!g_res_active.load(std::memory_order_acquire) || fault() == AdoptFault::NoResources) {
    return false;
  }
  std::lock_guard<std::mutex> lock(g_res_mutex);
  ++g_res_stats.textures;
  ++g_res_stats.textures_current;
  ++g_res_stats.from_update;
  return true;
}


// ===================================================================== G8m: materials, shaders
//
// gate8-design.md D11, D12, Q5 and rs_adopt.h. Everything below runs on the main thread (at arm
// and in the frame callback, before the transaction is formed), never under a hook lock: the
// hooks_adopt_* calls take the hooks' own locks. The node map is the one structure another thread
// (a node_added emitted off the main thread) may write; g_node_mutex guards it.

// FOG-U: the kind and component count of a GLSL scalar/vector type (sampler/matrix/other -> None).
void uniform_type(const std::string &type, UniformDecl *decl) {
  const bool vec = type.rfind("vec", 0) == 0 || type.rfind("ivec", 0) == 0 ||
                   type.rfind("uvec", 0) == 0 || type.rfind("bvec", 0) == 0;
  if (vec && type.size() >= 4) {
    const char c = type[type.size() - 1];
    decl->kind = UniformDecl::Kind::Vector;
    decl->components = c >= '2' && c <= '4' ? c - '0' : 0;
    if (decl->components == 0) decl->kind = UniformDecl::Kind::None;
    return;
  }
  if (type == "float") {
    decl->kind = UniformDecl::Kind::Float;
    decl->components = 1;
  } else if (type == "int" || type == "uint") {
    decl->kind = UniformDecl::Kind::Int;
    decl->components = 1;
  } else if (type == "bool") {
    decl->kind = UniformDecl::Kind::Bool;
    decl->components = 1;
  } else {
    decl->kind = UniformDecl::Kind::None;
    decl->components = 0;
  }
}

// FOG-U: whether `token` starts a numeric literal (the tokenizer keeps digits and dots together).
bool uniform_number(const std::string &token) {
  if (token.empty()) return false;
  const char c = token[0];
  return c == '.' || (c >= '0' && c <= '9');
}

// FOG-U: the default literal of a declaration, from tokens[j] (just after `=`) up to `;` or `:`.
void uniform_default(UniformDecl *decl, const std::vector<std::string> &tokens, std::size_t j) {
  if (j >= tokens.size() || decl->components <= 0) return;
  if (tokens[j] == "true" || tokens[j] == "false") {
    decl->has_default = true;
    decl->default_[0] = tokens[j] == "true" ? 1.0f : 0.0f;
    return;
  }
  // A `vecN(...)` / `ivecN(...)` constructor: one number splats, N numbers fill.
  const bool ctor = tokens[j].rfind("vec", 0) == 0 || tokens[j].rfind("ivec", 0) == 0 ||
                    tokens[j].rfind("uvec", 0) == 0 || tokens[j].rfind("bvec", 0) == 0;
  if (ctor && j + 1 < tokens.size() && tokens[j + 1] == "(") {
    std::vector<float> nums;
    for (std::size_t p = j + 2; p < tokens.size() && tokens[p] != ")" && tokens[p] != ";" &&
                              tokens[p] != ":";
         ++p) {
      if (uniform_number(tokens[p])) nums.push_back(std::strtof(tokens[p].c_str(), nullptr));
    }
    if (nums.empty()) return;
    decl->has_default = true;
    for (std::int32_t c = 0; c < decl->components; ++c) {
      decl->default_[c] = nums.size() == 1 ? nums[0] : nums[static_cast<std::size_t>(c) % nums.size()];
    }
    return;
  }
  if (uniform_number(tokens[j])) {
    decl->has_default = true;
    const float v = std::strtof(tokens[j].c_str(), nullptr);
    for (int c = 0; c < 4; ++c) decl->default_[c] = v;
  }
}

std::vector<UniformDecl> scan_uniforms(const std::string &code) {
  std::vector<UniformDecl> out;
  std::vector<std::string> tokens;
  const std::size_t n = code.size();
  std::size_t i = 0;
  const auto ident_start = [](char c) {
    return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c == '_';
  };
  const auto ident_char = [&](char c) { return ident_start(c) || (c >= '0' && c <= '9'); };
  while (i < n) {
    const char c = code[i];
    if (c == '/' && i + 1 < n && code[i + 1] == '/') {
      while (i < n && code[i] != '\n') ++i;
      continue;
    }
    if (c == '/' && i + 1 < n && code[i + 1] == '*') {
      const std::size_t end = code.find("*/", i + 2);
      i = end == std::string::npos ? n : end + 2;
      continue;
    }
    if (ident_start(c)) {
      std::size_t j = i + 1;
      while (j < n && ident_char(code[j])) ++j;
      tokens.push_back(code.substr(i, j - i));
      i = j;
      continue;
    }
    // FOG-U: keep a numeric literal (digits and dots) as one token, so `0.0`/`1.0` parse as a
    // single default rather than `0`, `.`, `0`.
    if ((c >= '0' && c <= '9') || (c == '.' && i + 1 < n && code[i + 1] >= '0' && code[i + 1] <= '9')) {
      std::size_t j = i;
      while (j < n && ((code[j] >= '0' && code[j] <= '9') || code[j] == '.')) ++j;
      tokens.push_back(code.substr(i, j - i));
      i = j;
      continue;
    }
    if (c != ' ' && c != '\t' && c != '\n' && c != '\r') {
      tokens.push_back(std::string(1, c));
    }
    ++i;
  }
  for (std::size_t k = 0; k < tokens.size(); ++k) {
    if (tokens[k] != "uniform") continue;
    if (k > 0 && (tokens[k - 1] == "instance" || tokens[k - 1] == "global")) continue;
    std::size_t t = k + 1;
    if (t < tokens.size() &&
        (tokens[t] == "lowp" || tokens[t] == "mediump" || tokens[t] == "highp")) {
      ++t;
    }
    if (t + 1 >= tokens.size() || !ident_start(tokens[t][0]) || !ident_start(tokens[t + 1][0])) {
      continue;
    }
    UniformDecl decl;
    decl.name = tokens[t + 1];
    const std::string &type = tokens[t];
    decl.sampler = type.rfind("sampler", 0) == 0 || type.rfind("isampler", 0) == 0 ||
                   type.rfind("usampler", 0) == 0;
    uniform_type(type, &decl);
    std::size_t j = t + 2;
    if (j < tokens.size() && tokens[j] == "[") {  // an array: no default parsed
      while (j < tokens.size() && tokens[j] != "]") ++j;
      if (j < tokens.size()) ++j;
    } else if (j < tokens.size() && tokens[j] == "=") {
      uniform_default(&decl, tokens, j + 1);
    }
    out.push_back(std::move(decl));
  }
  return out;
}

bool has_include_directive(const std::string &code) {
  std::size_t line = 0;
  while (line < code.size()) {
    std::size_t p = line;
    while (p < code.size() && (code[p] == ' ' || code[p] == '\t')) ++p;
    if (code.compare(p, 8, "#include") == 0) {
      return true;
    }
    const std::size_t next = code.find('\n', line);
    if (next == std::string::npos) break;
    line = next + 1;
  }
  return false;
}

const char *adopt_material_sabotage_name(AdoptMaterialSabotage s) {
  switch (s) {
  case AdoptMaterialSabotage::RawShaderCode: return "adopt-raw-shader-code";
  case AdoptMaterialSabotage::SkipParams: return "adopt-skip-params";
  case AdoptMaterialSabotage::None: break;
  }
  return "none";
}

namespace {

std::atomic<int> g_mat_sabotage{0};
std::mutex g_mat_mutex;  // the stats
AdoptMaterialStats g_mat_stats;
std::set<std::pair<std::uint64_t, std::uint64_t>> g_mat_refused_items;    // (item, material)
std::set<std::pair<std::uint64_t, std::uint64_t>> g_mat_refused_shaders;  // (material, shader)
// D12: a CanvasItemMaterial template shader adopted before its engine RID was named (no getter
// returns it), keyed by mode, under a key no engine RID can take (RID validators are 31-bit, so
// the top bit is never set); re-keyed to the RID the first hooked call names.
std::map<int, std::uint64_t> g_cim_synthetic;
constexpr std::uint64_t kSyntheticShader = 1ull << 63;
std::size_t g_node_prune_at = 4096;

struct MatTags {
  void *canvas_item = nullptr, *shader_material = nullptr, *cim = nullptr, *resource = nullptr;
  void resolve() {
    canvas_item = Tags::tag("CanvasItem");
    shader_material = Tags::tag("ShaderMaterial");
    cim = Tags::tag("CanvasItemMaterial");
    resource = Tags::tag("Resource");
  }
};
MatTags g_mat_tags;

// TAG1: the node map's second user (client-extensions-design.md §2.2), and the sabotage
// meta-before-ready's early identities (resolved in node_added, before the node's _ready).
std::atomic<bool> g_tag_active{false};
bool g_tag_before_ready = false;
void tag_resolve_early(std::uint64_t rid);

// The node_added callable (one per process; connected for a stream's lifetime).
alignas(8) unsigned char g_node_added_callable[16] = {};
bool g_node_added_made = false;
bool g_node_added_connected = false;
std::uint64_t g_node_added_tree = 0;  // the SceneTree's instance id
int g_node_added_userdata = 0;

AdoptMaterialSabotage mat_sabotage() {
  return static_cast<AdoptMaterialSabotage>(g_mat_sabotage.load(std::memory_order_acquire));
}

template <typename F>
void mat_stat(F f) {
  std::lock_guard<std::mutex> lock(g_mat_mutex);
  f(g_mat_stats);
}

void adopt_instance_params(std::uint64_t item);  // G8m, below

// The RS filter/repeat an item's RS state holds (CanvasItem::_refresh_texture_filter_cache,
// canvas_item.cpp:1585-1599, :1639-1661): the scene enum's PARENT_NODE (0) inherits the parent
// item's resolved value (recursively), or the RS Default (0) without a parent item. A top-level
// item has no parent item (get_parent_item, canvas_item.cpp:547), exactly as the walk's
// effective_parent threads parent_filter / parent_repeat.
std::int32_t resolved_cache(void *item, BindId getter) {
  const std::int32_t raw = static_cast<std::int32_t>(get_int(getter, item));
  if (raw != 0 || get_bool(kItemIsTopLevel, item)) {
    return raw;
  }
  void *parent_node = get_object(kNodeGetParent, item);
  void *parent_item = parent_node != nullptr ? as(parent_node, g_item_tags.canvas_item) : nullptr;
  return parent_item != nullptr ? resolved_cache(parent_item, getter) : 0;
}

// LATE-RES (fidelity gap #5): a pre-arm CanvasItem whose RID the mirror does not know (its
// canvas_item_create happened before the arm, while the node was pooled or otherwise out of the
// tree) is adopted at its first node_added after the arm. The node is read by the walk's own
// read_item and applied by apply_adopt_plan's own apply_adopted_item, so a pooled node that
// enters the tree after the arm draws like one the walk adopted (node-class extras included).
// The item's parent arrives from the tree (get_parent), not from a walk thread: the enter-tree
// set_parent already fired before node_added (canvas_item.cpp:237-289) and, naming an unknown
// RID, was dropped under the unknown-item policy. Main thread only. Returns false when the
// mirror already knew the RID. [[maybe_unused]]: its only call is from node_added_call, which
// GCC sees as merely address-taken (the node map's callable), so it reports the otherwise-called
// helper as unused.
[[maybe_unused]] bool adopt_item_node(void *item, std::uint64_t rid, std::uint64_t frame) {
  Mirror &mirror = mirror_instance();
  if (mirror.knows_item(rid)) {
    return false;
  }
  if (g_item_tags.canvas_item == nullptr) {
    g_item_tags.resolve();
  }
  void *parent_node = get_object(kNodeGetParent, item);
  void *parent_item = parent_node != nullptr ? as(parent_node, g_item_tags.canvas_item) : nullptr;
  const std::int32_t parent_filter =
      parent_item != nullptr ? resolved_cache(parent_item, kItemGetTextureFilter) : 0;
  const std::int32_t parent_repeat =
      parent_item != nullptr ? resolved_cache(parent_item, kItemGetTextureRepeat) : 0;
  AdoptedItem a = read_item(item, item, parent_item, parent_filter, parent_repeat, g_item_tags,
                            g_item_read);
  a.rid = rid;
  AdoptStats stats;
  apply_adopted_item(mirror, a, AdoptSabotage::None, frame, &stats);
  if ((a.material != 0 || a.use_parent_material) &&
      mat_sabotage() != AdoptMaterialSabotage::SkipParams) {
    adopt_instance_params(rid);  // as adopt_materials_at_arm does for the walk's material items
  }
  return true;
}

void node_added_call(void * /*userdata*/, const GDExtensionConstVariantPtr *args,
                     GDExtensionInt count, GDExtensionVariantPtr /*ret*/,
                     GDExtensionCallError *error) {
  if (error != nullptr) {
    error->error = GDEXTENSION_CALL_OK;
  }
  if (count < 1 || args == nullptr ||
      !(g_res_active.load(std::memory_order_acquire) ||
        g_tag_active.load(std::memory_order_acquire)) ||
      g_iface.variant_get_type(const_cast<GDExtensionVariantPtr>(args[0])) !=
          GDEXTENSION_VARIANT_TYPE_OBJECT) {
    return;
  }
  void *object = nullptr;
  g_iface.get_variant_to_type_constructor(GDEXTENSION_VARIANT_TYPE_OBJECT)(
      &object, const_cast<GDExtensionVariantPtr>(args[0]));
  void *item = as(object, g_mat_tags.canvas_item);
  if (item == nullptr) {
    return;
  }
  const std::uint64_t rid = get_rid(kItemGetCanvasItem, item);
  const std::uint64_t id = static_cast<std::uint64_t>(get_int(kObjectGetInstanceId, item));
  if (rid == 0) {
    return;
  }
  {
    std::lock_guard<std::mutex> lock(g_node_mutex);
    g_item_nodes[rid] = id;
  }
  // LATE-RES (gap #5): a pre-arm item not in the tree at arm (a pooled node) is adopted at its
  // first node_added after the arm, so its enter-tree and draw calls land on a known item.
  if (g_res_active.load(std::memory_order_acquire) && mirror_enabled() &&
      fault() != AdoptFault::NoResources && std::this_thread::get_id() == g_res_main &&
      adopt_item_node(item, rid, hooks_current_frame())) {
    mat_stat([](AdoptMaterialStats &s) { ++s.items_adopted; });
  }
  if (g_tag_before_ready && g_tag_active.load(std::memory_order_acquire)) {
    tag_resolve_early(rid);  // sabotage meta-before-ready: the identity before the node's _ready
  }
  mat_stat([](AdoptMaterialStats &s) { ++s.nodes_added; });
}

void *scene_tree() {
  void *engine = singleton_object("Engine");
  return engine != nullptr ? cast_to(get_object(kEngineGetMainLoop, engine), "SceneTree") : nullptr;
}

void node_map_connect() {
  void *tree = scene_tree();
  if (tree == nullptr || g_node_added_connected) {  // TAG1: adoption and TAG share one connection
    return;
  }
  if (!g_node_added_made) {
    GDExtensionCallableCustomInfo2 info;
    std::memset(&info, 0, sizeof(info));
    info.callable_userdata = &g_node_added_userdata;
    info.token = g_iface.library;
    info.call_func = &node_added_call;
    g_iface.callable_custom_create2(g_node_added_callable, &info);
    g_node_added_made = true;
  }
  StringName signal("node_added");
  const std::int64_t flags = 0;
  const GDExtensionConstTypePtr args[3] = {signal.ptr(), g_node_added_callable, &flags};
  std::int64_t result = -1;
  ptrcall(kObjectConnect, tree, args, &result);
  g_node_added_connected = result == 0;
  g_node_added_tree = static_cast<std::uint64_t>(get_int(kObjectGetInstanceId, tree));
  mat_stat([](AdoptMaterialStats &s) { s.node_map_connected = g_node_added_connected; });
}

// The adopted (or node_added) CanvasItem node of `item_rid`, null when the map has none or the
// node is gone.
void *node_of(std::uint64_t item_rid) {
  std::uint64_t id = 0;
  {
    std::lock_guard<std::mutex> lock(g_node_mutex);
    const auto it = g_item_nodes.find(item_rid);
    if (it != g_item_nodes.end()) {
      id = it->second;
    }
  }
  if (id == 0) {
    return nullptr;
  }
  void *item = as(g_iface.object_get_instance_from_id(id), g_mat_tags.canvas_item);
  return item != nullptr && get_rid(kItemGetCanvasItem, item) == item_rid ? item : nullptr;
}

// Drops the map's dead nodes once it has doubled (a long session adds and frees many nodes).
void node_map_prune() {
  std::lock_guard<std::mutex> lock(g_node_mutex);
  if (g_item_nodes.size() < g_node_prune_at) {
    return;
  }
  for (auto it = g_item_nodes.begin(); it != g_item_nodes.end();) {
    it = g_iface.object_get_instance_from_id(it->second) == nullptr ? g_item_nodes.erase(it)
                                                                    : std::next(it);
  }
  g_node_prune_at = std::max<std::size_t>(4096, g_item_nodes.size() * 2);
}

std::string string_of(BindId id, void *object) {
  Builtin text(GDEXTENSION_VARIANT_TYPE_STRING);
  ptrcall(id, object, nullptr, text.ptr());
  return utf8_of(text.ptr());
}

// The material a CanvasItem node holds (its own, not an inherited one), in `slot`.
void *node_material(void *node, RefSlot *slot) {
  ptrcall(kItemGetMaterial, node, nullptr, &slot->slot);
  return slot->object();
}

// D11: the code a capture-owned temporary Shader sends the server for `raw`: set_path_cache to the
// original's path (so a relative #include resolves as it did for the original; the cache entry
// stays the original's, ~Resource only unregisters itself), set_code(raw), then get_rid(), which
// creates the server shader through the hooked shader_create_from_code under the reentrancy flag
// (D4) and hands the code here; destroying the temporary frees its RID through the hooked free,
// also passed straight through. False when nothing reached the server.
bool preprocess_with_temp(const std::string &raw, const std::string &path, std::string *out) {
  StringName cls("Shader");
  void *temp = g_iface.classdb_construct_object2(cls.ptr());
  if (temp == nullptr) {
    return false;
  }
  std::uint64_t made = 0;
  hooks_internal_begin(out, &made);
  if (!path.empty() && fault() != AdoptFault::NoIncludePath) {
    OwnedString text(path);
    const GDExtensionConstTypePtr args[1] = {text.data};
    ptrcall(kResourceSetPathCache, temp, args, nullptr);
  }
  {
    OwnedString text(raw);
    const GDExtensionConstTypePtr args[1] = {text.data};
    ptrcall(kShaderSetCode, temp, args, nullptr);
  }
  get_rid(kResourceGetRid, temp);
  g_iface.object_destroy(temp);
  hooks_internal_end();
  return made != 0;
}

// Ensures the mirror knows the Shader resource `shader` (RID `rid`), adopting it with its
// preprocessed code (or the typed shader-adopt-include) and its default textures.
bool ensure_shader(void *shader, std::uint64_t rid) {
  if (rid == 0 || shader == nullptr) {
    return false;
  }
  Mirror &m = mirror_instance();
  if (m.knows_shader(rid)) {
    return true;
  }
  const std::string raw = string_of(kShaderGetCode, shader);
  std::string code;
  bool refused = false;
  if (mat_sabotage() == AdoptMaterialSabotage::RawShaderCode) {
    code = raw;  // the sabotage: get_code() as the server never received it
  } else if (!preprocess_with_temp(raw, string_of(kResourceGetPath, shader), &code)) {
    code = raw;  // no code reached the server (an empty source): what the original got too
  } else if (has_include_directive(code)) {
    refused = true;  // Q5: the preprocessor left the #include (it could not resolve it)
  }
  const bool adopted = refused
                           ? hooks_adopt_shader_refused(rid, rs2::ShaderReason::ShaderAdoptInclude)
                           : hooks_adopt_shader(rid, code);
  if (adopted) {
    mat_stat([refused](AdoptMaterialStats &s) {
      ++s.shaders;
      if (refused) ++s.shaders_include_refused;
    });
  }
  if (adopted && !refused) {
    // Shader defaults (Shader::set_default_texture_parameter): index 0 of every sampler uniform.
    for (const UniformDecl &u : scan_uniforms(code)) {
      if (!u.sampler) continue;
      RefSlot texture;
      StringName name(u.name.c_str());
      const std::int64_t index = 0;
      const GDExtensionConstTypePtr args[2] = {name.ptr(), &index};
      ptrcall(kShaderGetDefaultTextureParameter, shader, args, &texture.slot);
      const std::uint64_t tex =
          texture.object() != nullptr ? get_rid(kResourceGetRid, texture.object()) : 0;
      if (tex != 0) {
        hooks_adopt_default_texture(rid, u.name, tex, 0);
        mat_stat([](AdoptMaterialStats &s) { ++s.default_textures; });
      }
    }
  }
  return m.knows_shader(rid);
}

// D12: the template shader of a CanvasItemMaterial's mode. `named` is the RID a hooked call named
// (0 when none did: an adopted material's shader RID has no getter). Returns the RID the mirror
// knows the shader by, 0 when none.
std::uint64_t ensure_cim_shader(void *cim, std::uint64_t named) {
  Mirror &m = mirror_instance();
  if (named != 0 && m.knows_shader(named)) {
    return named;
  }
  const int blend = static_cast<int>(get_int(kCimGetBlendMode, cim));
  const int light = static_cast<int>(get_int(kCimGetLightMode, cim));
  const bool particles = get_bool(kCimGetParticlesAnimation, cim);
  const int key = blend | (light << 4) | ((particles ? 1 : 0) << 8);
  const auto synthetic = g_cim_synthetic.find(key);
  if (synthetic != g_cim_synthetic.end() && m.knows_shader(synthetic->second)) {
    if (named == 0) {
      return synthetic->second;
    }
    m.shader_rebind(synthetic->second, named);
    g_cim_synthetic.erase(synthetic);
    return m.knows_shader(named) ? named : 0;
  }
  GDExtensionGodotVersion2 version;
  std::memset(&version, 0, sizeof(version));
  g_iface.get_godot_version2(&version);
  const std::string code = canvas_item_material_code(
      canvas_item_material_version_text(version.string != nullptr ? version.string : "",
                                        version.build != nullptr ? version.build : ""),
      blend, light, particles);
  if (code.empty()) {
    return 0;
  }
  const std::uint64_t rid = named != 0 ? named : (kSyntheticShader | static_cast<std::uint64_t>(key));
  if (hooks_adopt_shader(rid, code)) {
    mat_stat([](AdoptMaterialStats &s) {
      ++s.shaders;
      ++s.shaders_builtin;
    });
    if (named == 0) {
      g_cim_synthetic[key] = rid;
    }
  }
  return m.knows_shader(rid) ? rid : 0;
}

std::unique_ptr<VariantSlot> int_variant(std::int64_t value) {
  auto v = std::make_unique<VariantSlot>();
  g_iface.get_variant_from_type_constructor(GDEXTENSION_VARIANT_TYPE_INT)(v->data, &value);
  return v;
}

std::unique_ptr<VariantSlot> bool_variant(bool value) {
  auto v = std::make_unique<VariantSlot>();
  GDExtensionBool b = value ? 1 : 0;
  g_iface.get_variant_from_type_constructor(GDEXTENSION_VARIANT_TYPE_BOOL)(v->data, &b);
  return v;
}

// FOG-U: a declared default as its Variant (null when the declaration has no default or an
// unsupported kind). A Float is widened to float64, an Int to int64, a Bool to bool, a Vector to
// Vector2/3/4 of floats -- the types `material_set_param` carries.
std::unique_ptr<VariantSlot> uniform_default_variant(const UniformDecl &decl) {
  if (!decl.has_default || decl.kind == UniformDecl::Kind::None || decl.components < 1) {
    return nullptr;
  }
  auto v = std::make_unique<VariantSlot>();
  switch (decl.kind) {
    case UniformDecl::Kind::Float: {
      double value = static_cast<double>(decl.default_[0]);
      g_iface.get_variant_from_type_constructor(GDEXTENSION_VARIANT_TYPE_FLOAT)(v->data, &value);
      return v;
    }
    case UniformDecl::Kind::Int: {
      std::int64_t value = static_cast<std::int64_t>(decl.default_[0]);
      g_iface.get_variant_from_type_constructor(GDEXTENSION_VARIANT_TYPE_INT)(v->data, &value);
      return v;
    }
    case UniformDecl::Kind::Bool: {
      GDExtensionBool b = decl.default_[0] != 0.0f ? 1 : 0;
      g_iface.get_variant_from_type_constructor(GDEXTENSION_VARIANT_TYPE_BOOL)(v->data, &b);
      return v;
    }
    case UniformDecl::Kind::Vector: {
      const GDExtensionVariantType t =
          decl.components == 2   ? GDEXTENSION_VARIANT_TYPE_VECTOR2
          : decl.components == 3 ? GDEXTENSION_VARIANT_TYPE_VECTOR3
                                 : GDEXTENSION_VARIANT_TYPE_VECTOR4;
      alignas(8) float buf[4] = {decl.default_[0], decl.default_[1], decl.default_[2],
                                 decl.default_[3]};
      g_iface.get_variant_from_type_constructor(t)(v->data, buf);
      return v;
    }
    case UniformDecl::Kind::None:
      return nullptr;
  }
  return nullptr;
}

// A parameter value as the server received it: a texture Object becomes its RID
// (ShaderMaterial::set_shader_parameter, material.cpp:465-475); null when there is none to send.
std::unique_ptr<VariantSlot> server_value(std::unique_ptr<VariantSlot> v) {
  if (v->type() == GDEXTENSION_VARIANT_TYPE_NIL) {
    return nullptr;
  }
  if (v->type() != GDEXTENSION_VARIANT_TYPE_OBJECT) {
    return v;
  }
  void *object = nullptr;
  g_iface.get_variant_to_type_constructor(GDEXTENSION_VARIANT_TYPE_OBJECT)(&object, v->data);
  void *resource = as(object, g_mat_tags.resource);
  std::uint64_t rid = resource != nullptr ? get_rid(kResourceGetRid, resource) : 0;
  if (rid == 0) {
    return nullptr;
  }
  auto out = std::make_unique<VariantSlot>();
  g_iface.get_variant_from_type_constructor(GDEXTENSION_VARIANT_TYPE_RID)(out->data, &rid);
  return out;
}

// D11/D12: adopts the Material resource `material` (RID `rid`) with its shader and parameters.
bool adopt_material_object(void *material, std::uint64_t rid, bool at_arm) {
  Mirror &m = mirror_instance();
  if (m.knows_material(rid)) {
    return true;
  }
  const bool skip = mat_sabotage() == AdoptMaterialSabotage::SkipParams;
  std::uint64_t shader_rid = 0;
  std::vector<std::unique_ptr<VariantSlot>> values;
  std::vector<AdoptParam> params;
  bool shader_material = false;
  if (as(material, g_mat_tags.shader_material) != nullptr) {
    shader_material = true;
    RefSlot shader;
    ptrcall(kShaderMaterialGetShader, material, nullptr, &shader.slot);
    if (shader.object() != nullptr) {
      shader_rid = get_rid(kResourceGetRid, shader.object());
      ensure_shader(shader.object(), shader_rid);
    }
    std::string code;
    if (shader_rid != 0 && !m.shader_code_of(shader_rid, &code)) {
      // shader-adopt-include: no recovered code, so the parameter names come from the source
      // (an included file's uniforms are missed; the material is unsupported through its shader).
      code = string_of(kShaderGetCode, shader.object());
    }
    if (!skip && shader_rid != 0 && !code.empty()) {
      std::set<std::string> seen;
      for (const UniformDecl &u : scan_uniforms(code)) {
        if (!seen.insert(u.name).second) continue;
        auto v = std::make_unique<VariantSlot>();
        StringName name(u.name.c_str());
        const GDExtensionConstTypePtr args[1] = {name.ptr()};
        ptrcall(kShaderMaterialGetShaderParameter, material, args, v->data);
        auto sent = server_value(std::move(v));
        if (sent != nullptr) {
          params.push_back({u.name, sent->data});
          values.push_back(std::move(sent));
        }
      }
    }
  } else if (as(material, g_mat_tags.cim) != nullptr) {
    shader_rid = ensure_cim_shader(material, 0);
    if (!skip) {
      // The three parameters CanvasItemMaterial's constructor and setters send
      // (canvas_item_material.cpp:199-220, :283-285).
      values.push_back(int_variant(get_int(kCimGetParticlesAnimHFrames, material)));
      params.push_back({"particles_anim_h_frames", values.back()->data});
      values.push_back(int_variant(get_int(kCimGetParticlesAnimVFrames, material)));
      params.push_back({"particles_anim_v_frames", values.back()->data});
      values.push_back(bool_variant(get_bool(kCimGetParticlesAnimLoop, material)));
      params.push_back({"particles_anim_loop", values.back()->data});
    }
  } else {
    return false;  // no recipe for this class: the hooks' unknown-material stays
  }
  if (hooks_adopt_material(rid, shader_rid, params)) {
    const std::uint32_t count = static_cast<std::uint32_t>(params.size());
    mat_stat([&](AdoptMaterialStats &s) {
      ++s.materials;
      if (shader_material) ++s.shader_materials;
      else ++s.canvas_item_materials;
      if (at_arm) ++s.at_arm;
      s.params += count;
    });
  }
  return m.knows_material(rid);
}

// LAR3 (late-arm-registry-design.md R2, R4): a shader the registry holds, adopted from the code
// the server was given (the preprocessed code a born capture carries: no temporary Shader, no
// include to resolve) and its recorded default textures. No getter is read, so the dummy
// renderer's empty shader_get_code does not matter. True when the mirror knows the shader.
bool adopt_shader_registered(std::uint64_t rid, const rs::RegistryShader &reg) {
  Mirror &m = mirror_instance();
  if (m.knows_shader(rid)) {
    return true;
  }
  const std::string code = reg.code != nullptr ? rs::decode_string(reg.code.get()) : std::string();
  if (hooks_adopt_shader(rid, code)) {
    mat_stat([](AdoptMaterialStats &s) {
      ++s.shaders;
      ++s.shaders_registry;
    });
    for (const rs::RegistryDefaultTexture &d : reg.defaults) {
      hooks_adopt_default_texture(rid, d.name, d.texture, d.index);
      mat_stat([](AdoptMaterialStats &s) { ++s.default_textures; });
    }
  }
  return m.knows_shader(rid);
}

// The shader `rid` from the registry, when it holds one (false: unregistered or unadoptable).
bool materialize_shader(std::uint64_t rid) {
  if (rid == 0) {
    return false;
  }
  if (mirror_instance().knows_shader(rid)) {
    return true;
  }
  rs::RegistryShader reg;
  return rs::registry_on() && rs::registry_shader(rid, &reg) && adopt_shader_registered(rid, reg);
}

// LAR3: a material the registry holds, adopted from its recorded shader binding (the shader
// adopted first, from the registry when registered; a pre-load shader stays the mirror's pending
// reference, for the residual) and its recorded parameters (texture values adopted by
// hooks_adopt_material). No getter is read, so the dummy's NIL material_get_param does not matter.
bool adopt_material_registered(std::uint64_t rid, const rs::RegistryMaterial &reg, bool at_arm) {
  Mirror &m = mirror_instance();
  if (m.knows_material(rid)) {
    return true;
  }
  if (reg.shader != 0) {
    materialize_shader(reg.shader);
  }
  std::vector<AdoptParam> params;
  if (mat_sabotage() != AdoptMaterialSabotage::SkipParams) {
    params.reserve(reg.params.size());
    for (const rs::RegistryParam &p : reg.params) {
      params.push_back({p.name, p.value.get()});
    }
  }
  if (hooks_adopt_material(rid, reg.shader, params)) {
    const std::uint32_t count = static_cast<std::uint32_t>(params.size());
    mat_stat([&](AdoptMaterialStats &s) {
      ++s.materials;
      ++s.materials_registry;
      if (at_arm) ++s.at_arm;
      s.params += count;
    });
  }
  return m.knows_material(rid);
}

bool materialize_material(std::uint64_t rid, bool at_arm) {
  if (rid == 0) {
    return false;
  }
  if (mirror_instance().knows_material(rid)) {
    return true;
  }
  rs::RegistryMaterial reg;
  return rs::registry_on() && rs::registry_material(rid, &reg) &&
         adopt_material_registered(rid, reg, at_arm);
}

// One drain of the mirror's pending queue (rs_mirror.h take_pending_material_refs; LAR3 replaced
// G8m's epoch-gated scan). A RID the registry holds is adopted from it; anything else goes to the
// residual reader (M12-M14: the drawing item's node, its Material's and Shader's getters).
void resolve_pending_once(bool at_arm) {
  Mirror &m = mirror_instance();
  const Mirror::PendingMaterialRefs pending = m.take_pending_material_refs();
  const std::uint32_t taken =
      static_cast<std::uint32_t>(pending.items.size() + pending.materials.size());
  mat_stat([taken](AdoptMaterialStats &s) { s.pending_refs += taken; });
  for (const auto &ref : pending.items) {
    if (g_mat_refused_items.count(ref) != 0) continue;
    rs::RegistryMaterial reg;
    if (rs::registry_on() && rs::registry_material(ref.second, &reg)) {
      if (adopt_material_registered(ref.second, reg, at_arm)) {
        hooks_adopt_item_material(ref.first, ref.second);
      } else {
        g_mat_refused_items.insert(ref);
        mat_stat([](AdoptMaterialStats &s) { ++s.materials_refused; });
      }
      continue;
    }
    void *node = node_of(ref.first);
    RefSlot slot;
    void *material = node != nullptr ? node_material(node, &slot) : nullptr;
    if (material != nullptr && get_rid(kResourceGetRid, material) == ref.second &&
        adopt_material_object(material, ref.second, at_arm)) {
      hooks_adopt_item_material(ref.first, ref.second);
    } else {
      g_mat_refused_items.insert(ref);
      mat_stat([](AdoptMaterialStats &s) { ++s.materials_refused; });
    }
  }
  for (const auto &ref : pending.materials) {
    const auto key = std::make_pair(ref.material, ref.shader);
    if (g_mat_refused_shaders.count(key) != 0) continue;
    if (materialize_shader(ref.shader)) {  // LAR3: a registered shader needs no item
      hooks_adopt_material_shader(ref.material, ref.shader);
      mat_stat([](AdoptMaterialStats &s) { ++s.shaders_lazy; });
      continue;
    }
    if (ref.items.empty()) continue;  // no holder yet: its first item queues it again
    bool done = false;
    for (std::uint64_t item : ref.items) {
      void *node = node_of(item);
      RefSlot slot;
      void *material = node != nullptr ? node_material(node, &slot) : nullptr;
      if (material == nullptr || get_rid(kResourceGetRid, material) != ref.material) continue;
      std::uint64_t got = 0;
      if (as(material, g_mat_tags.shader_material) != nullptr) {
        RefSlot shader;
        ptrcall(kShaderMaterialGetShader, material, nullptr, &shader.slot);
        if (shader.object() != nullptr &&
            get_rid(kResourceGetRid, shader.object()) == ref.shader &&
            ensure_shader(shader.object(), ref.shader)) {
          got = ref.shader;
        }
      } else if (as(material, g_mat_tags.cim) != nullptr) {
        got = ensure_cim_shader(material, ref.shader);
      }
      if (got == ref.shader) {
        hooks_adopt_material_shader(ref.material, ref.shader);
        mat_stat([](AdoptMaterialStats &s) { ++s.shaders_lazy; });
        done = true;
      }
      break;
    }
    if (!done) {
      g_mat_refused_shaders.insert(key);
      mat_stat([](AdoptMaterialStats &s) { ++s.shaders_refused; });
    }
  }
}

// Drains until nothing is queued: adopting a registered material whose shader predates the load
// (the process-global CanvasItemMaterial cache) queues that shader reference, resolved in the same
// frame. Bounded: a reference is refused or resolved once, and the refused sets keep it so.
void resolve_pending(bool at_arm) {
  Mirror &m = mirror_instance();
  for (int round = 0; round < 4 && m.has_pending_material_refs(); ++round) {
    resolve_pending_once(at_arm);
  }
}

bool same_value(const void *a, const void *b) {
  const DecodedParam x = decode_variant(a);
  const DecodedParam y = decode_variant(b);
  return x.status == "ok" && y.status == "ok" && x.type == y.type && x.packed == y.packed &&
         x.n == y.n && x.f == y.f && x.tex_rid == y.tex_rid;
}

// The instance parameters the server holds for an adopted item and a script set
// (canvas_item_get_instance_shader_parameter over the item's list, renderer_canvas_cull.cpp:1943,
// :1957; an unset one reads back NIL, instance_uniforms.cpp:103-108).
void adopt_instance_params(std::uint64_t item) {
  void *rs_singleton = singleton_object("RenderingServer");
  if (rs_singleton == nullptr) {
    return;
  }
  Builtin list(GDEXTENSION_VARIANT_TYPE_ARRAY);
  {
    const GDExtensionConstTypePtr args[1] = {&item};
    ptrcall(kRsCanvasItemGetInstanceShaderParameterList, rs_singleton, args, list.ptr());
  }
  const std::int64_t n = array_size(list.ptr());
  for (std::int64_t i = 0; i < n; ++i) {
    void *element = g_iface.array_operator_index_const(list.ptr(), i);
    if (element == nullptr || g_iface.variant_get_type(element) != GDEXTENSION_VARIANT_TYPE_DICTIONARY) {
      continue;
    }
    Builtin dict(GDEXTENSION_VARIANT_TYPE_DICTIONARY);
    g_iface.get_variant_to_type_constructor(GDEXTENSION_VARIANT_TYPE_DICTIONARY)(dict.ptr(), element);
    VariantSlot name_v;
    dict_get(dict.ptr(), "name", &name_v);
    std::string name;
    if (name_v.type() == GDEXTENSION_VARIANT_TYPE_STRING) {
      Builtin text(GDEXTENSION_VARIANT_TYPE_STRING);
      g_iface.get_variant_to_type_constructor(GDEXTENSION_VARIANT_TYPE_STRING)(text.ptr(), name_v.data);
      name = utf8_of(text.ptr());
    }  // PropertyInfo::operator Dictionary writes the name as a String (object.cpp)
    if (name.empty()) continue;
    VariantSlot value;
    VariantSlot fallback;
    StringName param(name.c_str());
    const GDExtensionConstTypePtr args[2] = {&item, param.ptr()};
    ptrcall(kRsCanvasItemGetInstanceShaderParameter, rs_singleton, args, value.data);
    ptrcall(kRsCanvasItemGetInstanceShaderParameterDefault, rs_singleton, args, fallback.data);
    // An unset parameter reads back its default (instance_uniforms.cpp:161-163), which no call
    // carried: skip a value that equals the default, type included.
    if (value.type() == GDEXTENSION_VARIANT_TYPE_NIL || same_value(value.data, fallback.data)) {
      continue;
    }
    hooks_adopt_instance_param(item, name, value.data);
    mat_stat([](AdoptMaterialStats &s) { ++s.instance_params; });
  }
}

}  // namespace

void node_map_disconnect_now() {
  if (!g_node_added_connected) {
    return;
  }
  g_node_added_connected = false;
  void *tree = g_iface.object_get_instance_from_id != nullptr
                   ? g_iface.object_get_instance_from_id(g_node_added_tree)
                   : nullptr;
  if (tree != nullptr) {
    StringName signal("node_added");
    const GDExtensionConstTypePtr args[2] = {signal.ptr(), g_node_added_callable};
    ptrcall(kObjectDisconnect, tree, args, nullptr);
  }
}

// G8m: adoption's end. TAG1: the connection stays while TAG still holds the map.
void node_map_disconnect() {
  if (!g_tag_active.load(std::memory_order_acquire)) {
    node_map_disconnect_now();
  }
}

void adopt_materials_configure(AdoptMaterialSabotage sabotage) {
  {
    std::lock_guard<std::mutex> lock(g_mat_mutex);
    g_mat_stats = AdoptMaterialStats();
  }
  g_mat_sabotage.store(static_cast<int>(sabotage), std::memory_order_release);
  g_mat_refused_items.clear();
  g_mat_refused_shaders.clear();
  g_cim_synthetic.clear();
  g_node_prune_at = 4096;
  // LAR3: the mirror queues unresolved material and shader references from the walk on (the
  // mirror was enabled, and reset, just before; entry.cpp calls this before adopt_at_arm).
  mirror_instance().set_material_refs_queue(g_res_active.load(std::memory_order_acquire) &&
                                            fault() != AdoptFault::NoResources);
  // LAR4: and the emitters whose process material needs work (adopt_particles_resolve's queue).
  mirror_instance().set_ppm_queue(true);
}

AdoptMaterialStats adopt_material_stats() {
  std::lock_guard<std::mutex> lock(g_mat_mutex);
  return g_mat_stats;
}

void adopt_materials_at_arm() {
  if (!g_res_active.load(std::memory_order_acquire) || fault() == AdoptFault::NoResources ||
      !mirror_enabled() ||
      !adopt_binds_ready(nullptr) || std::this_thread::get_id() != g_res_main) {
    return;
  }
  const std::uint64_t t0 = now_ns();
  g_mat_tags.resolve();
  node_map_connect();
  resolve_pending(true);
  if (mat_sabotage() != AdoptMaterialSabotage::SkipParams) {
    for (std::uint64_t item : g_walk_material_items) {
      adopt_instance_params(item);
    }
  }
  const std::uint64_t t1 = now_ns();
  mat_stat([&](AdoptMaterialStats &s) { s.arm_ns += t1 - t0; });
}

void adopt_materials_resolve() {
  if (!g_res_active.load(std::memory_order_acquire) || fault() == AdoptFault::NoResources ||
      !mirror_enabled() || !g_binds_resolved ||
      std::this_thread::get_id() != g_res_main) {
    return;
  }
  if (!mirror_instance().has_pending_material_refs()) {
    return;  // LAR3: nothing queued since the last drain
  }
  const std::uint64_t t0 = now_ns();
  node_map_prune();
  resolve_pending(false);
  const std::uint64_t t1 = now_ns();
  mat_stat([&](AdoptMaterialStats &s) {
    ++s.resolve_passes;
    s.resolve_ns += t1 - t0;
  });
}


// --- PM5: the particle_process_material builtin and the pre-draw pump -----------------------

namespace {

struct PpmBinds {
  bool tried = false;
  bool ok = false;
  GDExtensionMethodBindPtr get_process_material = nullptr;  // GPUParticles2D
  GDExtensionMethodBindPtr get_emission_shape = nullptr;
  GDExtensionMethodBindPtr get_particle_flag = nullptr;
  GDExtensionMethodBindPtr get_param_texture = nullptr;
  GDExtensionMethodBindPtr get_color_ramp = nullptr;
  GDExtensionMethodBindPtr get_color_initial_ramp = nullptr;
  GDExtensionMethodBindPtr get_alpha_curve = nullptr;
  GDExtensionMethodBindPtr get_emission_curve = nullptr;
  GDExtensionMethodBindPtr get_velocity_limit_curve = nullptr;
  GDExtensionMethodBindPtr get_emission_color_texture = nullptr;
  GDExtensionMethodBindPtr get_sub_emitter_mode = nullptr;
  GDExtensionMethodBindPtr is_attractor_interaction_enabled = nullptr;
  GDExtensionMethodBindPtr get_collision_mode = nullptr;
  GDExtensionMethodBindPtr is_collision_using_scale = nullptr;
  GDExtensionMethodBindPtr get_turbulence_enabled = nullptr;
  GDExtensionMethodBindPtr resource_get_rid = nullptr;
  void *tag_gpu_particles = nullptr;
  void *tag_ppm = nullptr;
  void *tag_curve_xyz = nullptr;
};
PpmBinds g_ppm;
std::mutex g_ppm_mutex;
PpmStats g_ppm_stats;
std::set<std::uint64_t> g_ppm_unresolved;  // shader RIDs counted unresolved (once each)

bool ppm_binds() {
  if (g_ppm.tried) {
    return g_ppm.ok;
  }
  g_ppm.tried = true;
  if (g_iface.object_method_bind_ptrcall == nullptr || g_iface.classdb_get_class_tag == nullptr ||
      g_iface.object_cast_to == nullptr || g_iface.ref_get_object == nullptr) {
    return false;
  }
  const char *ppm = "ParticleProcessMaterial";
  g_ppm.get_process_material = method_bind("GPUParticles2D", "get_process_material", 5934680LL);
  g_ppm.get_emission_shape = method_bind(ppm, "get_emission_shape", 3719733018LL);
  g_ppm.get_particle_flag = method_bind(ppm, "get_particle_flag", 3895316907LL);
  g_ppm.get_param_texture = method_bind(ppm, "get_param_texture", 3489372978LL);
  g_ppm.get_color_ramp = method_bind(ppm, "get_color_ramp", 3635182373LL);
  g_ppm.get_color_initial_ramp = method_bind(ppm, "get_color_initial_ramp", 3635182373LL);
  g_ppm.get_alpha_curve = method_bind(ppm, "get_alpha_curve", 3635182373LL);
  g_ppm.get_emission_curve = method_bind(ppm, "get_emission_curve", 3635182373LL);
  g_ppm.get_velocity_limit_curve = method_bind(ppm, "get_velocity_limit_curve", 3635182373LL);
  g_ppm.get_emission_color_texture = method_bind(ppm, "get_emission_color_texture", 3635182373LL);
  g_ppm.get_sub_emitter_mode = method_bind(ppm, "get_sub_emitter_mode", 2399052877LL);
  g_ppm.is_attractor_interaction_enabled =
      method_bind(ppm, "is_attractor_interaction_enabled", 36873697LL);
  g_ppm.get_collision_mode = method_bind(ppm, "get_collision_mode", 139371864LL);
  g_ppm.is_collision_using_scale = method_bind(ppm, "is_collision_using_scale", 36873697LL);
  g_ppm.get_turbulence_enabled = method_bind(ppm, "get_turbulence_enabled", 36873697LL);
  g_ppm.resource_get_rid = method_bind("Resource", "get_rid", 2944877500LL);
  g_ppm.tag_gpu_particles = Tags::tag("GPUParticles2D");
  g_ppm.tag_ppm = Tags::tag(ppm);
  g_ppm.tag_curve_xyz = Tags::tag("CurveXYZTexture");
  g_ppm.ok = g_ppm.get_process_material != nullptr && g_ppm.get_emission_shape != nullptr &&
             g_ppm.get_particle_flag != nullptr && g_ppm.get_param_texture != nullptr &&
             g_ppm.get_color_ramp != nullptr && g_ppm.get_color_initial_ramp != nullptr &&
             g_ppm.get_alpha_curve != nullptr && g_ppm.get_emission_curve != nullptr &&
             g_ppm.get_velocity_limit_curve != nullptr &&
             g_ppm.get_emission_color_texture != nullptr &&
             g_ppm.get_sub_emitter_mode != nullptr &&
             g_ppm.is_attractor_interaction_enabled != nullptr &&
             g_ppm.get_collision_mode != nullptr && g_ppm.is_collision_using_scale != nullptr &&
             g_ppm.get_turbulence_enabled != nullptr && g_ppm.resource_get_rid != nullptr &&
             g_ppm.tag_gpu_particles != nullptr && g_ppm.tag_ppm != nullptr;
  return g_ppm.ok;
}

std::int64_t ppm_int(GDExtensionMethodBindPtr bind, void *object, const std::int64_t *arg) {
  std::int64_t out = 0;
  const GDExtensionConstTypePtr args[1] = {arg};
  g_iface.object_method_bind_ptrcall(bind, object, arg != nullptr ? args : nullptr, &out);
  return out;
}

bool ppm_bool(GDExtensionMethodBindPtr bind, void *object, const std::int64_t *arg) {
  std::uint8_t out = 0;
  const GDExtensionConstTypePtr args[1] = {arg};
  g_iface.object_method_bind_ptrcall(bind, object, arg != nullptr ? args : nullptr, &out);
  return out != 0;
}

// A Ref<Texture2D> getter: whether it returns a valid texture (and, with `tag`, of that class).
bool ppm_texture(GDExtensionMethodBindPtr bind, void *object, const std::int64_t *arg,
                 void *tag = nullptr) {
  RefSlot slot;
  const GDExtensionConstTypePtr args[1] = {arg};
  g_iface.object_method_bind_ptrcall(bind, object, arg != nullptr ? args : nullptr, &slot.slot);
  void *texture = slot.object();
  return texture != nullptr && (tag == nullptr || as(texture, tag) != nullptr);
}

// ParticleProcessMaterial::_compute_key (scene/resources/particle_process_material.h:158-188).
rs2::BuiltinParticleProcessMaterial ppm_key(void *m) {
  rs2::BuiltinParticleProcessMaterial k;
  k.color_ramp = ppm_texture(g_ppm.get_color_ramp, m, nullptr);
  const std::int64_t shape = ppm_int(g_ppm.get_emission_shape, m, nullptr);
  k.emission_shape = static_cast<std::uint8_t>(shape >= 0 && shape < rs2::kPpmEmissionShapes ? shape
                                                                                              : 0);
  k.emission_color_texture =
      shape >= 4 /* EMISSION_SHAPE_POINTS */ &&
      ppm_texture(g_ppm.get_emission_color_texture, m, nullptr);
  const std::int64_t sub = ppm_int(g_ppm.get_sub_emitter_mode, m, nullptr);
  k.sub_emitter = static_cast<std::uint8_t>(sub >= 0 && sub < rs2::kPpmSubEmitterModes ? sub : 0);
  const std::int64_t collision = ppm_int(g_ppm.get_collision_mode, m, nullptr);
  k.collision = static_cast<std::uint8_t>(
      collision >= 0 && collision < rs2::kPpmCollisionModes ? collision : 0);
  k.attractor = ppm_bool(g_ppm.is_attractor_interaction_enabled, m, nullptr);
  k.collision_scale = ppm_bool(g_ppm.is_collision_using_scale, m, nullptr);
  k.turbulence = ppm_bool(g_ppm.get_turbulence_enabled, m, nullptr);
  k.velocity_limit_curve = ppm_texture(g_ppm.get_velocity_limit_curve, m, nullptr);
  k.alpha_curve = ppm_texture(g_ppm.get_alpha_curve, m, nullptr);
  k.emission_curve = ppm_texture(g_ppm.get_emission_curve, m, nullptr);
  k.color_initial_ramp = ppm_texture(g_ppm.get_color_initial_ramp, m, nullptr);
  const std::int64_t orbit = 2;  // PARAM_ORBIT_VELOCITY
  k.orbit_velocity_curve_xyz = g_ppm.tag_curve_xyz != nullptr &&
                               ppm_texture(g_ppm.get_param_texture, m, &orbit, g_ppm.tag_curve_xyz);
  for (std::int64_t i = 0; i < rs2::kPpmParamCount; ++i) {
    if (ppm_texture(g_ppm.get_param_texture, m, &i)) {
      k.textures |= 1u << i;
    }
  }
  for (std::int64_t i = 0; i < rs2::kPpmFlagCount; ++i) {
    if (ppm_bool(g_ppm.get_particle_flag, m, &i)) {
      k.particle_flags |= 1u << i;
    }
  }
  return k;
}

// The pre-draw pump's callable and flag.
alignas(8) unsigned char g_pump_callable[16] = {};
bool g_pump_made = false;
bool g_pump_connected = false;
int g_pump_userdata = 0;
std::atomic<bool> g_pump_fired{false};
std::atomic<bool> g_pump_emitting{false};
GDExtensionMethodBindPtr g_pump_connect = nullptr;
GDExtensionMethodBindPtr g_pump_disconnect = nullptr;
GDExtensionMethodBindPtr g_pump_emit = nullptr;

void pump_call(void * /*userdata*/, const GDExtensionConstVariantPtr * /*args*/,
               GDExtensionInt /*count*/, GDExtensionVariantPtr /*ret*/,
               GDExtensionCallError *error) {
  if (error != nullptr) {
    error->error = GDEXTENSION_CALL_OK;
  }
  if (!g_pump_emitting.load(std::memory_order_acquire)) {
    g_pump_fired.store(true, std::memory_order_release);  // the engine's own emission
  }
}

// LATE-PPM: a synthetic process shader's capture-reserved RID and code. An engine whose
// ParticleProcessMaterial assigns its shader outside get_rid() (MegaDot 4.5.1.m.12) names no
// shader to the duplicate, and no server getter returns a material's shader
// (Material.get_shader_rid is not bound, gate8-design.md D12). The particle_process_material
// builtin key, though, is readable from the material's own getters (ppm_key), so a synthetic
// `particles` shader carrying that key is adopted under a reserved RID (the top two bits set, which
// no 31-bit-validator RID takes) and re-keyed if a hooked call ever names the engine's RID. A
// builtin-driven receiver (GSW) then simulates and draws the emitter; the GL receivers still draw
// nothing (a Forward+ host's process shader is RD-only, PM7 follow-up 1), as before the fix.
// LATE-CMBT reuses the same reserved-RID synthetic shader to key a post-arm process material whose
// material_create_from_shader / material_set_shader named a pre-arm shader RID.
constexpr std::uint64_t kSyntheticPpmShader = (1ull << 63) | (1ull << 62);
// FOG-U: the synthetic code also declares the process shader's always-declared default-valued
// uniforms (the stock 4.5.1 `particle_process_material` code declares these with a default and no
// property setter ever sets them), so the shader-aware read supplies their declared defaults when
// `material_get_param` has no value. The builtin-driven receivers ignore the code (they simulate
// from the builtin key), so the extra declarations change nothing for them.
const char kPpmSyntheticCode[] =
    "shader_type particles;\n\n"
    "// Synthetic: this engine assigns the process material's shader outside get_rid().\n"
    "uniform float inherit_emitter_velocity_ratio = 0.0;\n"
    "uniform vec3 emission_shape_offset = vec3(0.0);\n"
    "uniform vec3 emission_shape_scale = vec3(1.0);\n"
    "uniform vec3 velocity_pivot = vec3(0.0);\n"
    "void process() {\n"
    "\tfloat _t = TIME;\n"
    "}\n";

std::uint64_t adopt_ppm_builtin(void *material);  // PM7, below

// LAR4: whether the shader the registry recorded for material `rid` is itself registered (a
// shader made under the hooks, which the registry adopts with its real code).
bool material_shader_registered(std::uint64_t rid) {
  if (!rs::registry_on()) {
    return false;
  }
  rs::RegistryMaterial reg;
  rs::RegistryKind kind = rs::RegistryKind::Texture2d;
  return rs::registry_material(rid, &reg) && reg.shader != 0 &&
         rs::registry_lookup(reg.shader, &kind) && kind == rs::RegistryKind::Shader;
}

}  // namespace

// LATE-RES (gap #5): at the frame boundary, after the LATE-CMBT loop. Defined after the PM7
// helpers it uses (pta_process_material, adopt_ppm).
void adopt_particles_resolve_unknown_material(
    const std::vector<Mirror::PpmUnknownMaterialCandidate> &candidates);

std::uint64_t ppm_key_bits(const rs2::BuiltinParticleProcessMaterial &k) {
  // 40 bits, each field in its own range (ppm_key clamps the enums), so two keys share a synthetic
  // RID exactly when they are equal -- materials on one key share one entry, as the engine's
  // shader_map does, and a hit never needs a key comparison.
  std::uint64_t bits = 0;
  int at = 0;
  auto put = [&bits, &at](std::uint64_t value, int width) {
    bits |= (value & ((1ull << width) - 1)) << at;
    at += width;
  };
  put(k.emission_shape, 3);                     // < kPpmEmissionShapes (7)
  put(k.particle_flags, rs2::kPpmFlagCount);    // 4
  put(k.textures, rs2::kPpmParamCount);         // 18
  put(k.color_ramp ? 1 : 0, 1);
  put(k.color_initial_ramp ? 1 : 0, 1);
  put(k.alpha_curve ? 1 : 0, 1);
  put(k.emission_curve ? 1 : 0, 1);
  put(k.velocity_limit_curve ? 1 : 0, 1);
  put(k.orbit_velocity_curve_xyz ? 1 : 0, 1);
  put(k.emission_color_texture ? 1 : 0, 1);
  put(k.sub_emitter, 3);                        // < kPpmSubEmitterModes (5)
  put(k.attractor ? 1 : 0, 1);
  put(k.collision, 2);                          // < kPpmCollisionModes (3)
  put(k.collision_scale ? 1 : 0, 1);
  put(k.turbulence ? 1 : 0, 1);
  return bits;  // at == 40: far below the two reserved top bits
}
static_assert(rs2::kPpmEmissionShapes <= 8 && rs2::kPpmSubEmitterModes <= 8 &&
                  rs2::kPpmCollisionModes <= 4 && rs2::kPpmFlagCount + rs2::kPpmParamCount <= 32,
              "ppm_key_bits: a builtin key field outgrew its width");

void adopt_particles_resolve() {
  if (!mirror_enabled()) {
    return;
  }
  Mirror &m = mirror_instance();
  // LAR4 (late-arm-registry-design.md R4, Q4 M18): the mirror's queue replaces the ppm epoch. A
  // frame that queued nothing costs this one atomic load; otherwise only the queued emitters are
  // looked at (rs_mirror.h take_ppm_candidates).
  if (!m.has_pending_ppm() || !m.particles_options().enabled || !ppm_binds()) {
    return;
  }
  const Mirror::PpmResolveCandidates candidates = m.take_ppm_candidates();
  {
    std::lock_guard<std::mutex> lock(g_ppm_mutex);
    ++g_ppm_stats.drains;
  }
  for (const Mirror::PpmCandidate &c : candidates.builtin) {
    bool done = false;
    for (const auto &pair : c.pairs) {
      void *node = node_of(pair.second);
      if (node == nullptr || as(node, g_ppm.tag_gpu_particles) == nullptr) {
        continue;
      }
      RefSlot slot;
      g_iface.object_method_bind_ptrcall(g_ppm.get_process_material, node, nullptr, &slot.slot);
      void *material = slot.object();
      if (material == nullptr || as(material, g_ppm.tag_ppm) == nullptr) {
        continue;
      }
      std::uint64_t rid = 0;
      g_iface.object_method_bind_ptrcall(g_ppm.resource_get_rid, material, nullptr, &rid);
      if (rid != pair.first) {
        continue;
      }
      m.set_shader_ppm(c.shader_rid, ppm_key(material));
      std::lock_guard<std::mutex> lock(g_ppm_mutex);
      ++g_ppm_stats.builtin_resolved;
      g_ppm_unresolved.erase(c.shader_rid);
      done = true;
      break;
    }
    if (!done) {
      std::lock_guard<std::mutex> lock(g_ppm_mutex);
      if (g_ppm_unresolved.insert(c.shader_rid).second) {
        ++g_ppm_stats.builtin_unresolved;
      }
    }
  }
  // LATE-CMBT: a post-arm process material whose material_create_from_shader / material_set_shader
  // named a shader RID the mirror does not know is `unknown-shader`. Key it through its
  // particle_process_material builtin: adopt a synthetic `particles` shader carrying the key, then
  // re-key the material to it, so a builtin-driven receiver simulates the emitter. LAR4: only for a
  // shader older than the hooks (the residual). A registered shader is the registry's: the hook
  // sites and the material queue (adopt_materials_resolve, which runs first) adopt its real code,
  // so the material is left for them and never re-keyed to the placeholder.
  for (const auto &pair : candidates.unknown_shader) {
    if (material_shader_registered(pair.first)) {
      std::lock_guard<std::mutex> lock(g_ppm_mutex);
      ++g_ppm_stats.unknown_shader_registered;
      continue;
    }
    void *node = node_of(pair.second);
    if (node == nullptr || as(node, g_ppm.tag_gpu_particles) == nullptr) {
      continue;
    }
    RefSlot slot;
    g_iface.object_method_bind_ptrcall(g_ppm.get_process_material, node, nullptr, &slot.slot);
    void *material = slot.object();
    if (material == nullptr || as(material, g_ppm.tag_ppm) == nullptr) {
      continue;
    }
    std::uint64_t rid = 0;
    g_iface.object_method_bind_ptrcall(g_ppm.resource_get_rid, material, nullptr, &rid);
    if (rid != pair.first) {
      continue;
    }
    const std::uint64_t synth = adopt_ppm_builtin(material);
    if (synth == 0) {
      continue;  // no synthetic shader: the material stays unknown-shader
    }
    hooks_adopt_material_shader(pair.first, synth);
    std::lock_guard<std::mutex> lock(g_ppm_mutex);
    ++g_ppm_stats.unknown_shader_keyed;
  }
  // LATE-RES (gap #5): a pre-arm process material an emitter was given is `unknown-material` (its
  // material RID was never adopted). Adopt it through the node map and re-link the emitter.
  adopt_particles_resolve_unknown_material(candidates.unknown_material);
}

PpmStats adopt_particles_stats() {
  std::lock_guard<std::mutex> lock(g_ppm_mutex);
  PpmStats out = g_ppm_stats;
  // A shader counted unresolved and later keyed is resolved, not both.
  out.builtin_unresolved = g_ppm_unresolved.size();
  return out;
}

bool predraw_pump_connect(std::string *why) {
  void *rs_singleton = singleton_object("RenderingServer");
  g_pump_connect = method_bind("Object", "connect", 1518946055LL);
  g_pump_disconnect = method_bind("Object", "disconnect", 1874754934LL);
  g_pump_emit = method_bind("Object", "emit_signal", 4047867050LL);
  if (rs_singleton == nullptr || g_pump_connect == nullptr || g_pump_emit == nullptr ||
      g_iface.callable_custom_create2 == nullptr || g_iface.object_method_bind_call == nullptr ||
      g_iface.get_variant_from_type_constructor == nullptr) {
    *why = "predraw-pump-unavailable";
    return false;
  }
  if (!g_pump_made) {
    GDExtensionCallableCustomInfo2 info;
    std::memset(&info, 0, sizeof(info));
    info.callable_userdata = &g_pump_userdata;
    info.token = g_iface.library;
    info.call_func = &pump_call;
    g_iface.callable_custom_create2(g_pump_callable, &info);
    g_pump_made = true;
  }
  StringName signal("frame_pre_draw");
  const std::int64_t flags = 0;
  const GDExtensionConstTypePtr args[3] = {signal.ptr(), g_pump_callable, &flags};
  std::int64_t result = -1;
  g_iface.object_method_bind_ptrcall(g_pump_connect, rs_singleton, args, &result);
  g_pump_connected = result == 0;
  g_pump_fired.store(false);
  if (!g_pump_connected) {
    *why = "predraw-pump-connect-failed";
  }
  return g_pump_connected;
}

void predraw_pump_disconnect() {
  void *rs_singleton = singleton_object("RenderingServer");
  if (!g_pump_connected || rs_singleton == nullptr || g_pump_disconnect == nullptr) {
    return;
  }
  StringName signal("frame_pre_draw");
  const GDExtensionConstTypePtr args[2] = {signal.ptr(), g_pump_callable};
  g_iface.object_method_bind_ptrcall(g_pump_disconnect, rs_singleton, args, nullptr);
  g_pump_connected = false;
}

bool predraw_pump_frame() {
  if (!g_pump_connected) {
    return false;
  }
  if (g_pump_fired.exchange(false, std::memory_order_acq_rel)) {
    return false;  // the engine drew this iteration (RenderingServer::draw emitted it)
  }
  void *rs_singleton = singleton_object("RenderingServer");
  if (rs_singleton == nullptr) {
    return false;
  }
  StringName signal("frame_pre_draw");
  VariantSlot name;
  g_iface.get_variant_from_type_constructor(GDEXTENSION_VARIANT_TYPE_STRING_NAME)(name.data,
                                                                                  const_cast<void *>(signal.ptr()));
  const GDExtensionConstVariantPtr args[1] = {name.data};
  VariantSlot ret;
  GDExtensionCallError error;
  std::memset(&error, 0, sizeof(error));
  g_pump_emitting.store(true, std::memory_order_release);
  g_iface.object_method_bind_call(g_pump_emit, rs_singleton, args, 1, ret.data, &error);
  g_pump_emitting.store(false, std::memory_order_release);
  return error.error == GDEXTENSION_CALL_OK;
}

// --- PM7: pre-arm GPUParticles2D emitters (render-stream-12.md "As built (PM7)") --------------

namespace {

// LAR5: the emitter itself is adopted from the registry (no getter); these binds serve only the
// residual process-material reads (pta_process_material, adopt_ppm's FOG-U read-back), whose
// material comes from the drawing node.
struct PtaBinds {
  bool tried = false;
  bool ok = false;
  GDExtensionMethodBindPtr process_material = nullptr, resource_get_rid = nullptr,
                           material_get_param = nullptr;
  void *tag_gpu_particles = nullptr, *tag_ppm = nullptr, *tag_resource = nullptr;
};
PtaBinds g_pta;
std::mutex g_pta_mutex;  // the stats and the subemitter waits
EmitterAdoptStats g_pta_stats;
// LAR6: refused emitters and process materials (PM7's g_pta_refused and g_pta_refused_materials)
// are the one refused map's (Refusal::Particles, Refusal::ProcessMaterial), never retried.
// An adopted emitter whose recorded subemitter the mirror did not know yet: subemitter RID ->
// parent RID, linked when that emitter is adopted.
std::multimap<std::uint64_t, std::uint64_t> g_pta_sub_wait;

bool pta_binds() {
  if (g_pta.tried) {
    return g_pta.ok;
  }
  g_pta.tried = true;
  if (g_iface.object_method_bind_ptrcall == nullptr || g_iface.classdb_get_class_tag == nullptr ||
      g_iface.object_cast_to == nullptr || g_iface.ref_get_object == nullptr) {
    return false;
  }
  // 4.5.1's hashes (extension_api.json).
  g_pta.process_material = method_bind("GPUParticles2D", "get_process_material", 5934680LL);
  g_pta.resource_get_rid = method_bind("Resource", "get_rid", 2944877500LL);
  g_pta.material_get_param = method_bind("RenderingServer", "material_get_param", 2621281810LL);
  g_pta.tag_gpu_particles = Tags::tag("GPUParticles2D");
  g_pta.tag_ppm = Tags::tag("ParticleProcessMaterial");
  g_pta.tag_resource = Tags::tag("Resource");
  g_pta.ok = g_pta.tag_gpu_particles != nullptr && g_pta.tag_resource != nullptr &&
             g_pta.process_material != nullptr && g_pta.resource_get_rid != nullptr &&
             g_pta.material_get_param != nullptr;
  return g_pta.ok;
}

template <typename F>
void pta_stat(F f) {
  std::lock_guard<std::mutex> lock(g_pta_mutex);
  f(g_pta_stats);
}

std::uint64_t pta_rid(void *resource) {
  std::uint64_t out = 0;
  g_iface.object_method_bind_ptrcall(g_pta.resource_get_rid, resource, nullptr, &out);
  return out;
}

// Adopts (or returns) the synthetic process shader for `material`'s builtin key: a `particles`
// shader with the particle_process_material builtin, under a reserved RID. 0 when the key cannot be
// read or the shader cannot be adopted.
std::uint64_t adopt_ppm_builtin(void *material) {
  if (!ppm_binds()) {
    return 0;
  }
  const rs2::BuiltinParticleProcessMaterial key = ppm_key(material);
  const std::uint64_t synth = kSyntheticPpmShader | ppm_key_bits(key);
  Mirror &m = mirror_instance();
  if (!m.knows_shader(synth)) {
    if (!hooks_adopt_shader(synth, kPpmSyntheticCode)) {
      return 0;
    }
    m.set_shader_ppm(synth, key);
    pta_stat([](EmitterAdoptStats &s) { ++s.ppm_shaders; });
  }
  return synth;
}

// LAR4 (late-arm-registry-design.md Q4 M16, M17): a pre-arm ParticleProcessMaterial (`material`,
// RID `rid`). PM7's duplicate trick is gone.
//   - Registered (made under the hooks): adopted from the registry, as any material (LAR3): the
//     shader material_set_shader named, with the code the server was given, and every recorded
//     parameter. No getter is read, so the dummy renderer's empty shader_get_code and NIL
//     material_get_param do not matter: a headless capture carries the real values.
//   - Older than the hooks (the residual, Q3), or registered with no recorded binding (a shader
//     older than the hooks, or registry-drop-binding): LATE-PPM's placeholder, a synthetic
//     `particles` shader carrying the material's particle_process_material builtin key (M17),
//     with the recorded parameters when registered and, when not, the placeholder's declared
//     uniforms (FOG-U: read back, or their declared default). Nothing else names the residual's
//     parameters without the duplicate; F1 retired load-late as a fidelity target.
// False: unknown-material stays.
// The registered branch of adopt_ppm, by RID alone (LAR5: an emitter adopted from the registry, and
// particles_set_process_material's reference site, have no material object): a registered process
// material with a recorded shader the registry can materialize, adopted as any material (LAR3).
// `*tried`: it was registered with such a shader (false: the caller falls to the residual).
bool adopt_ppm_registered(std::uint64_t rid, const rs::RegistryMaterial &reg, bool *tried) {
  *tried = false;
  if (reg.shader == 0 || !materialize_shader(reg.shader)) {
    return false;
  }
  *tried = true;
  if (!adopt_material_registered(rid, reg, false)) {
    pta_stat([](EmitterAdoptStats &s) { ++s.ppm_refused_material; });
    return false;
  }
  const std::uint32_t count = static_cast<std::uint32_t>(reg.params.size());
  pta_stat([count](EmitterAdoptStats &s) {
    ++s.ppm_materials;
    ++s.ppm_registry;
    s.ppm_params += count;
  });
  return true;
}

bool adopt_ppm(void *material, std::uint64_t rid) {
  Mirror &m = mirror_instance();
  rs::RegistryMaterial reg;
  const bool registered = rs::registry_on() && rs::registry_material(rid, &reg);
  if (registered) {
    bool tried = false;
    const bool adopted = adopt_ppm_registered(rid, reg, &tried);
    if (tried) {
      return adopted;
    }
  }
  // The residual: no shader the mirror can name.
  pta_stat([](EmitterAdoptStats &s) { ++s.ppm_refused_no_shader; });
  const std::uint64_t shader = adopt_ppm_builtin(material);
  if (shader == 0) {
    return false;  // the builtin key could not be read
  }
  pta_stat([](EmitterAdoptStats &s) { ++s.ppm_builtin; });
  std::vector<std::unique_ptr<VariantSlot>> values;
  std::vector<AdoptParam> params;
  std::set<std::string> seen;
  if (registered) {
    for (const rs::RegistryParam &p : reg.params) {
      if (seen.insert(p.name).second) params.push_back({p.name, p.value.get()});
    }
  }
  // FOG-U: the placeholder's declared uniforms no setter ever set, read back from the server when
  // it keeps a value (GLES3), else their declared default (the dummy).
  std::string code;
  void *rs_singleton = singleton_object("RenderingServer");
  if (m.shader_code_of(shader, &code)) {
    for (const UniformDecl &u : scan_uniforms(code)) {
      if (!seen.insert(u.name).second) continue;
      auto v = std::make_unique<VariantSlot>();
      if (!registered && rs_singleton != nullptr) {
        StringName sn(u.name.c_str());
        const GDExtensionConstTypePtr a2[2] = {&rid, sn.ptr()};
        g_iface.object_method_bind_ptrcall(g_pta.material_get_param, rs_singleton, a2, v->data);
      }
      if (v->type() == GDEXTENSION_VARIANT_TYPE_NIL) {
        v = uniform_default_variant(u);
        if (v == nullptr) continue;
      }
      params.push_back({u.name, v->data});
      values.push_back(std::move(v));
    }
  }
  if (!hooks_adopt_material(rid, shader, params)) {
    if (!m.knows_material(rid)) pta_stat([](EmitterAdoptStats &s) { ++s.ppm_refused_material; });
    return m.knows_material(rid);
  }
  const std::uint32_t count = static_cast<std::uint32_t>(params.size());
  pta_stat([count](EmitterAdoptStats &s) {
    ++s.ppm_materials;
    s.ppm_params += count;
  });
  return true;
}

// The process material of `node`: its RID, adopted first when the mirror does not know it.
std::uint64_t pta_process_material(void *node) {
  RefSlot slot;
  g_iface.object_method_bind_ptrcall(g_pta.process_material, node, nullptr, &slot.slot);
  void *material = slot.object();
  if (material == nullptr) {
    return 0;
  }
  const std::uint64_t rid = pta_rid(material);
  Mirror &m = mirror_instance();
  if (rid == 0 || m.knows_material(rid)) {
    return rid;
  }
  if (is_refused(rid)) {
    return rid;  // refused before: still unknown-material, not read again
  }
  bool adopted = false;
  if (g_pta.tag_ppm != nullptr && as(material, g_pta.tag_ppm) != nullptr) {
    adopted = adopt_ppm(material, rid);
  } else {
    if (g_mat_tags.resource == nullptr) g_mat_tags.resolve();
    adopted = adopt_material_object(material, rid, false);
    if (adopted) pta_stat([](EmitterAdoptStats &s) { ++s.other_materials; });
  }
  if (!adopted && refuse(rid, Refusal::ProcessMaterial)) {
    std::lock_guard<std::mutex> lock(g_pta_mutex);
    ++g_pta_stats.ppm_refused;
  }
  return rid;  // an unknown one makes the entry unknown-material, as a hooked call would
}

// LAR5 (late-arm-registry-design.md Q4 M19): the adoption entry of a registered emitter, built from
// the registry's record alone: the configuration and floats as the engine's setters declared them,
// the trail poses the last particles_set_trail_bind_poses gave, the recorded draw passes, process
// material and subemitter. PM7's node getters, its collision-size and transform-align inferences
// and its thread-local draw note are gone.
Mirror::ParticlesAdopt pta_config(const rs::RegistryParticles &r) {
  Mirror::ParticlesAdopt a;
  a.mode_2d = r.mode_2d;
  a.emitting = r.emitting;
  a.one_shot = r.one_shot;
  a.interpolate = r.interpolate;
  a.fractional_delta = r.fractional_delta;
  a.local = r.local;
  a.trails = r.trails;
  a.amount = r.amount;
  a.fixed_fps = r.fixed_fps;
  a.draw_order = r.draw_order;
  a.transform_align = r.transform_align;
  a.seed = r.seed;
  a.material = r.process_material;
  a.passes = r.passes;
  a.floats.assign(r.floats.begin(), r.floats.end());
  a.floats.insert(a.floats.end(), r.poses.begin(), r.poses.end());
  return a;
}

}  // namespace

namespace {

// materialize()'s RefKind::ProcessMaterial (LAR5's reference site), any thread: registry-only.
bool ref_process_material(std::uint64_t rid) {
  if (t_res_inside || fault() == AdoptFault::NoParticles || !rs::registry_on()) {
    return false;
  }
  Mirror &m = mirror_instance();
  if (!m.particles_options().enabled || m.knows_material(rid) || is_refused(rid)) {
    return false;
  }
  rs::RegistryMaterial reg;
  if (!rs::registry_material(rid, &reg)) {
    return false;  // older than the hooks: the LATE-RES re-link reads it from the node
  }
  bool tried = false;
  const bool adopted = adopt_ppm_registered(rid, reg, &tried);
  if (tried && !adopted && refuse(rid, Refusal::ProcessMaterial)) {
    std::lock_guard<std::mutex> lock(g_pta_mutex);
    ++g_pta_stats.ppm_refused;
  }
  return adopted;
}

// materialize()'s RefKind::Particles on the main thread (its gates, the known check, the refused
// map and the off-main queue are materialize's).
void ref_particles(std::uint64_t particles) {
  Mirror &m = mirror_instance();
  const std::uint64_t t0 = now_ns();
  rs::RegistryParticles rec;
  if (!rs::registry_on() || !rs::registry_particles(particles, &rec)) {
    // F1: an emitter older than the hooks (or past the family's cap) has no record, and RS has no
    // particles getter: a typed refusal, `preload-particles`; its draws stay unknown-particles.
    if (refuse(particles, Refusal::Particles)) {
      std::lock_guard<std::mutex> lock(g_pta_mutex);
      ++g_pta_stats.refused;
      ++g_pta_stats.refused_preload_particles;
    }
    return;
  }
  // Dependencies first (design R4): the draw-pass meshes (G8r's read-back; the mesh family keeps
  // its getter) and a registered process material. A process material the registry cannot supply
  // (older than the hooks, or with no recorded binding) leaves the entry unknown-material, and the
  // mirror queues it for adopt_particles_resolve's LATE-RES re-link (M17's placeholder, the
  // residual).
  std::uint32_t meshes = 0;
  for (std::uint64_t mesh : rec.passes) {
    if (mesh == 0 || m.knows_mesh(mesh)) continue;
    materialize(mesh, RefKind::Mesh);
    if (m.knows_mesh(mesh)) ++meshes;
  }
  if (rec.process_material != 0) {
    materialize(rec.process_material, RefKind::ProcessMaterial);
  }
  Mirror::ParticlesAdopt a = pta_config(rec);
  bool waits = false;
  if (rec.subemitter != 0 && rec.subemitter != particles) {
    if (m.knows_particles(rec.subemitter)) {
      a.subemitter = rec.subemitter;
    } else {
      waits = true;  // linked when that emitter is adopted
    }
  }
  if (!hooks_adopt_particles(particles, a)) {
    return;
  }
  std::vector<std::uint64_t> parents;
  {
    std::lock_guard<std::mutex> lock(g_pta_mutex);
    if (waits) g_pta_sub_wait.emplace(rec.subemitter, particles);
    const auto range = g_pta_sub_wait.equal_range(particles);
    for (auto it = range.first; it != range.second; ++it) parents.push_back(it->second);
    g_pta_sub_wait.erase(range.first, range.second);
    ++g_pta_stats.emitters;
    g_pta_stats.meshes += meshes;
    if (a.subemitter != 0) ++g_pta_stats.subemitters;
  }
  for (std::uint64_t parent : parents) {
    if (m.knows_particles(parent)) {
      hooks_adopt_particles_subemitter(parent, particles);
      pta_stat([](EmitterAdoptStats &s) { ++s.subemitters; });
    }
  }
  pta_stat([t0](EmitterAdoptStats &s) { s.adopt_ns += now_ns() - t0; });
}

}  // namespace

void adopt_emitters_reset() {
  std::lock_guard<std::mutex> lock(g_pta_mutex);
  g_pta_stats = EmitterAdoptStats();
  g_pta_sub_wait.clear();  // LAR6: the refusals are the refused map's (adopt_resources_begin)
}

void adopt_emitters_forget(std::uint64_t rid) {
  std::lock_guard<std::mutex> lock(g_pta_mutex);
  g_pta_sub_wait.erase(rid);  // LAR6: the refusal goes with adopt_resource_freed's erase
}

// --- LAR6: the one entry, the off-main queue and the frame drain ------------------------------
//
// late-arm-registry-design.md R4, Q4 (M9 removed, "Refused sets" simplified, M14/M18 queue-driven).

namespace {

bool knows(Mirror &m, RefKind ref, std::uint64_t rid) {
  switch (ref) {
  case RefKind::Texture: return m.knows_texture(rid);
  case RefKind::Mesh: return m.knows_mesh(rid);
  case RefKind::Multimesh: return m.knows_multimesh(rid);
  case RefKind::Particles: return m.knows_particles(rid);
  case RefKind::Shader: return m.knows_shader(rid);
  case RefKind::Material:
  case RefKind::ProcessMaterial: return m.knows_material(rid);
  }
  return false;
}

}  // namespace

bool materialize(std::uint64_t rid, RefKind ref) {
  // The pure path (GRC_ADOPT=off, or not armed): one atomic load, as every adopt_*_ref before it.
  if (rid == 0 || !g_res_active.load(std::memory_order_acquire)) {
    return false;
  }
  if (fault() == AdoptFault::NoResources || !mirror_enabled()) {
    return false;
  }
  Mirror &m = mirror_instance();
  switch (ref) {
  case RefKind::Shader:
    return materialize_shader(rid);  // LAR3: registry-only, any thread
  case RefKind::Material:
    return materialize_material(rid, false);  // LAR3: registry-only, any thread
  case RefKind::ProcessMaterial:
    return ref_process_material(rid);  // LAR5: registry-only, any thread
  case RefKind::Texture:
  case RefKind::Mesh:
  case RefKind::Multimesh:
  case RefKind::Particles:
    break;
  }
  // The getter kinds. A multimesh's adoption calls no hooked method, so it needs no re-entry guard
  // (and must leave it clear for its mesh's read-back); the others are skipped inside an adoption.
  if (ref != RefKind::Multimesh && t_res_inside) {
    return false;
  }
  if (ref == RefKind::Particles &&
      (fault() == AdoptFault::NoParticles || !m.particles_options().enabled)) {
    return false;
  }
  if (knows(m, ref, rid)) {
    return true;
  }
  if (is_refused(rid)) {
    return false;  // refused once this stream: never read back again
  }
  if (std::this_thread::get_id() != g_res_main) {
    queue_offmain(rid, ref);  // design R4: drained at the frame boundary, on the main thread
    return false;
  }
  switch (ref) {
  case RefKind::Texture: ref_texture(rid); break;
  case RefKind::Mesh: ref_mesh(rid); break;
  case RefKind::Multimesh: adopt_multimesh_locked_out(rid); break;
  case RefKind::Particles: ref_particles(rid); break;
  default: break;
  }
  return knows(m, ref, rid);
}

namespace {

// The off-main queue's drain (main thread, frame boundary). Each live entry is materialized as its
// reference would have been on the main thread; one freed while queued is skipped.
void drain_offmain() {
  if (!g_queue_nonempty.load(std::memory_order_acquire)) {
    return;
  }
  std::vector<std::pair<std::uint64_t, RefKind>> queue;
  RidMap<std::uint8_t> queued;
  {
    std::lock_guard<std::mutex> lock(g_queue_mutex);
    queue.swap(g_queue);
    std::swap(queued, g_queued);
    g_queue_nonempty.store(false, std::memory_order_release);
  }
  if (fault() == AdoptFault::RegistryQueueDrop) {
    std::lock_guard<std::mutex> lock(g_res_mutex);  // the sabotage: every queued reference lost
    g_res_stats.offmain_dropped += static_cast<std::uint32_t>(queue.size());
    return;
  }
  Mirror &m = mirror_instance();
  std::uint32_t drained = 0;
  std::uint32_t adopted = 0;
  for (const auto &entry : queue) {
    const auto it = queued.find(entry.first);
    if (it == queued.end() || it->second == 0) {
      continue;  // freed while queued (counted dropped by adopt_resource_freed)
    }
    ++drained;
    if (materialize(entry.first, entry.second) || knows(m, entry.second, entry.first)) {
      ++adopted;
    }
  }
  std::lock_guard<std::mutex> lock(g_res_mutex);
  g_res_stats.offmain_drained += drained;
  g_res_stats.offmain_adopted += adopted;
}

}  // namespace

void adopt_frame_drain() {
  // Gated as the drains always were: lazy adoption active (entry.cpp calls this only for a
  // GRC_ADOPT=arm stream while armed).
  if (g_res_active.load(std::memory_order_acquire) && fault() != AdoptFault::NoResources &&
      mirror_enabled() && std::this_thread::get_id() == g_res_main) {
    drain_offmain();
  }
  adopt_materials_resolve();  // LAR3's material queue
  adopt_particles_resolve();  // LAR4's process-material queue
}

std::uint64_t adopt_resolve_scans() {
  const Mirror &m = mirror_instance();
  return m.material_refs_scans() + m.ppm_scans();
}

EmitterAdoptStats adopt_emitter_stats() {
  std::lock_guard<std::mutex> lock(g_pta_mutex);
  return g_pta_stats;
}

// LATE-RES (gap #5): an emitter whose process material is `unknown-material` (a pre-arm
// ParticleProcessMaterial a post-arm emitter was given). Adopt the material from the node (its
// getters, as adopt_ppm does) and re-link the emitter's process material (SetProcessMaterial now
// sees the adopted RID), so a builtin-driven receiver simulates the emitter. Defined here, after
// the PM7 helpers (pta_process_material, adopt_ppm) it uses.
void adopt_particles_resolve_unknown_material(
    const std::vector<Mirror::PpmUnknownMaterialCandidate> &candidates) {
  // pta_process_material reads through the PM7 binds, which only adopt_particles_ref resolved
  // before: a post-arm emitter given a pre-arm process material, with no pre-arm emitter adopted
  // yet, would otherwise call the engine through a null method bind.
  if (candidates.empty() || !pta_binds()) {
    return;
  }
  Mirror &m = mirror_instance();
  for (const Mirror::PpmUnknownMaterialCandidate &c : candidates) {
    void *node = node_of(c.item);
    if (node == nullptr || as(node, g_ppm.tag_gpu_particles) == nullptr) {
      continue;
    }
    const std::uint64_t rid = pta_process_material(node);
    if (rid == 0 || !m.knows_material(rid)) {
      continue;  // nothing adoptable: the emitter stays unknown-material
    }
    Mirror::ParticlesArgs a;
    a.rid = rid;
    m.particles_call(c.particles, Mirror::ParticlesOp::SetProcessMaterial, a, hooks_current_frame());
    std::lock_guard<std::mutex> lock(g_ppm_mutex);
    ++g_ppm_stats.unknown_material_keyed;
  }
}

// ===================================================================== TAG1: item identity
//
// client-extensions-design.md §2.2, §2.3: the node map's second user, and what one item's node
// says about itself. Main thread only (ObjectDB), in the frame callback.

namespace {

IdentityQuery g_tag_query;
std::vector<std::unique_ptr<StringName>> g_tag_group_names;
std::vector<std::unique_ptr<StringName>> g_tag_meta_names;
std::unordered_map<std::uint64_t, Identity> g_tag_early;  // meta-before-ready

void fill_map(void *node, void *canvas_item_tag) {
  void *item = as(node, canvas_item_tag);
  if (item != nullptr) {
    const std::uint64_t rid = get_rid(kItemGetCanvasItem, item);
    if (rid != 0) {
      g_item_nodes[rid] = static_cast<std::uint64_t>(get_int(kObjectGetInstanceId, item));
    }
  }
  const std::int64_t count = child_count(node);
  for (std::int64_t i = 0; i < count; ++i) {
    void *child = child_at(node, i);
    if (child != nullptr) {
      fill_map(child, canvas_item_tag);
    }
  }
}

std::string string_from(GDExtensionVariantType from, int ctor_index, const void *value) {
  alignas(8) unsigned char text[8] = {};
  const GDExtensionPtrConstructor ctor =
      g_iface.variant_get_ptr_constructor(GDEXTENSION_VARIANT_TYPE_STRING, ctor_index);
  if (ctor == nullptr) {
    return std::string();
  }
  const GDExtensionConstTypePtr args[1] = {value};
  ctor(text, args);
  std::string out = utf8_of(text);
  g_iface.variant_get_ptr_destructor(GDEXTENSION_VARIANT_TYPE_STRING)(text);
  (void)from;
  return out;
}

// A meta value: a String or StringName as itself, an int as its decimal string, else null.
bool meta_text(VariantSlot &v, std::string *out) {
  switch (v.type()) {
    case GDEXTENSION_VARIANT_TYPE_STRING: {
      alignas(8) unsigned char text[8] = {};
      g_iface.get_variant_to_type_constructor(GDEXTENSION_VARIANT_TYPE_STRING)(text, v.data);
      *out = utf8_of(text);
      g_iface.variant_get_ptr_destructor(GDEXTENSION_VARIANT_TYPE_STRING)(text);
      return true;
    }
    case GDEXTENSION_VARIANT_TYPE_STRING_NAME: {
      alignas(8) unsigned char name[8] = {};
      g_iface.get_variant_to_type_constructor(GDEXTENSION_VARIANT_TYPE_STRING_NAME)(name, v.data);
      *out = string_from(GDEXTENSION_VARIANT_TYPE_STRING_NAME, 2, name);  // String(StringName)
      g_iface.variant_get_ptr_destructor(GDEXTENSION_VARIANT_TYPE_STRING_NAME)(name);
      return true;
    }
    case GDEXTENSION_VARIANT_TYPE_INT: {
      std::int64_t value = 0;
      g_iface.get_variant_to_type_constructor(GDEXTENSION_VARIANT_TYPE_INT)(&value, v.data);
      *out = std::to_string(value);
      return true;
    }
    default:
      return false;
  }
}

void resolve_node(void *node, Identity *out) {
  const IdentityQuery &q = g_tag_query;
  out->node = true;
  if ((q.fields & 1u) != 0) {  // class: Object.get_class
    out->field[0] = string_of(kObjectGetClass, node);
    out->has[0] = true;
  }
  if ((q.fields & 2u) != 0) {  // script: the attached script's resource path
    VariantSlot script;
    ptrcall(kObjectGetScript, node, nullptr, script.data);
    if (script.type() == GDEXTENSION_VARIANT_TYPE_OBJECT) {
      void *object = nullptr;
      g_iface.get_variant_to_type_constructor(GDEXTENSION_VARIANT_TYPE_OBJECT)(&object,
                                                                               script.data);
      if (object != nullptr) {
        out->field[1] = string_of(kResourceGetPath, object);
        out->has[1] = !out->field[1].empty();
      }
    }
  }
  if ((q.fields & (4u | 8u)) != 0) {
    // The instance root: the node itself when it has a scene file, else its owner.
    void *root = node;
    std::string scene = string_of(kNodeGetSceneFilePath, node);
    if (scene.empty()) {
      root = get_object(kNodeGetOwner, node);
      scene = root != nullptr ? string_of(kNodeGetSceneFilePath, root) : std::string();
    }
    if ((q.fields & 4u) != 0 && !scene.empty()) {
      out->field[2] = scene;
      out->has[2] = true;
    }
    if ((q.fields & 8u) != 0 && root != nullptr) {
      Builtin path(GDEXTENSION_VARIANT_TYPE_NODE_PATH);
      const std::uint8_t unique = 0;
      const GDExtensionConstTypePtr args[2] = {&node, &unique};
      ptrcall(kNodeGetPathTo, root, args, path.ptr());
      out->field[3] = string_from(GDEXTENSION_VARIANT_TYPE_NODE_PATH, 3, path.ptr());
      out->has[3] = true;
    }
  }
  out->in_group.assign(g_tag_group_names.size(), false);
  for (std::size_t i = 0; i < g_tag_group_names.size(); ++i) {
    const GDExtensionConstTypePtr args[1] = {g_tag_group_names[i]->ptr()};
    std::uint8_t in = 0;
    ptrcall(kNodeIsInGroup, node, args, &in);
    out->in_group[i] = in != 0;
  }
  out->meta.assign(g_tag_meta_names.size(), {false, std::string()});
  for (std::size_t i = 0; i < g_tag_meta_names.size(); ++i) {
    const GDExtensionConstTypePtr has_args[1] = {g_tag_meta_names[i]->ptr()};
    std::uint8_t has = 0;
    ptrcall(kObjectHasMeta, node, has_args, &has);
    if (has == 0) {
      continue;  // get_meta without a default would print an error
    }
    VariantSlot fallback;
    VariantSlot value;
    const GDExtensionConstTypePtr args[2] = {g_tag_meta_names[i]->ptr(), fallback.data};
    ptrcall(kObjectGetMeta, node, args, value.data);
    out->meta[i].first = meta_text(value, &out->meta[i].second);
  }
}

void tag_resolve_early(std::uint64_t rid) {
  void *node = node_of(rid);
  if (node != nullptr) {
    Identity identity;
    resolve_node(node, &identity);
    g_tag_early[rid] = std::move(identity);
  }
}

}  // namespace

bool node_map_acquire_tag(std::string *error) {
  if (!adopt_binds_ready(error)) {
    return false;
  }
  if (g_tag_active.load(std::memory_order_acquire)) {
    return true;
  }
  g_mat_tags.resolve();
  void *tree = scene_tree();
  void *root = tree != nullptr ? get_object(kSceneTreeGetRoot, tree) : nullptr;
  if (root == nullptr) {
    if (error != nullptr) {
      *error = "no SceneTree root";
    }
    return false;
  }
  g_tag_active.store(true, std::memory_order_release);
  node_map_connect();
  {
    // §2.6 "Late join": the arm walker's visit fills the map before the first resolution.
    std::lock_guard<std::mutex> lock(g_node_mutex);
    fill_map(root, g_mat_tags.canvas_item);
  }
  return true;
}

void node_map_release_tag() {
  if (!g_tag_active.load(std::memory_order_acquire)) {
    return;
  }
  g_tag_active.store(false, std::memory_order_release);
  g_tag_early.clear();
  if (!g_res_active.load(std::memory_order_acquire)) {
    node_map_disconnect_now();
    std::lock_guard<std::mutex> lock(g_node_mutex);
    g_item_nodes.clear();
  }
}

void tag_set_query(const IdentityQuery &query, bool before_ready) {
  g_tag_before_ready = before_ready;
  g_tag_query = query;
  g_tag_group_names.clear();
  for (const std::string &name : query.groups) {
    g_tag_group_names.push_back(std::make_unique<StringName>(name.c_str()));
  }
  g_tag_meta_names.clear();
  for (const std::string &name : query.meta_keys) {
    g_tag_meta_names.push_back(std::make_unique<StringName>(name.c_str()));
  }
  g_tag_early.clear();
}

bool item_identity(std::uint64_t rid, Identity *out) {
  if (g_tag_before_ready) {
    const auto early = g_tag_early.find(rid);
    if (early != g_tag_early.end()) {
      *out = std::move(early->second);
      g_tag_early.erase(early);
      return true;
    }
  }
  void *node = node_of(rid);
  if (node == nullptr) {
    return false;
  }
  resolve_node(node, out);
  return true;
}

void tag_prune_map() { node_map_prune(); }

}  // namespace rs
}  // namespace grc
