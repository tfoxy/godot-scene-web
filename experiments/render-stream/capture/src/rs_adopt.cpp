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
#include "rs_shader_payload.h"
#include "rs_texture_payload.h"
#include "rs_variant.h"

namespace grc {
namespace rs {

namespace {

// ------------------------------------------------------------------ the engine-free application

bool same_xform(const rs2::Xform &a, const rs2::Xform &b) { return a == b; }
bool same_color(const rs2::Color4 &a, const rs2::Color4 &b) { return a == b; }

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
  // Items in tree order, so every parent exists before its children are appended to it: the
  // calls CanvasItem's NOTIFICATION_ENTER_TREE makes (canvas_item.cpp:237-289 set_parent and
  // visibility layer, :354 visible, :357-358 filter and repeat), the deferred update_draw_order
  // of a child item (:444 draw index = get_index()), and each setter whose value differs from the
  // RenderingServer default, as a setter only calls the server on a change.
  for (const AdoptedItem &item : plan.items) {
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
  // G8r: lazy resource adoption (D6, D7).
  kRsTexture2dGet,
  kRsMeshGetSurfaceCount,
  kRsMeshGetSurface,
  kRsMeshGetCustomAabb,
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
    // G8r (gate8-design.md D6, D7), every one read-only.
    {"RenderingServer", "texture_2d_get", 4206205781LL},          // (RID) -> Image
    {"RenderingServer", "mesh_get_surface_count", 2198884583LL},  // (RID) -> int
    {"RenderingServer", "mesh_get_surface", 186674697LL},         // (RID, int) -> Dictionary
    {"RenderingServer", "mesh_get_custom_aabb", 974181306LL},     // (RID) -> AABB
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
       *canvas_group = nullptr, *back_buffer_copy = nullptr;
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
  }
};

void *as(void *object, void *tag) {
  return object != nullptr && tag != nullptr ? g_iface.object_cast_to(object, tag) : nullptr;
}

struct Walker {
  Tags tags;
  void *root = nullptr;
  bool read_canvas_group = false;        // CG1: AdoptConfig::canvas_group
  bool read_copy_to_backbuffer = false;  // CG1: AdoptConfig::copy_to_backbuffer
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
      filter_cache = filter != 0 ? filter : (effective_parent != nullptr ? parent_filter : 0);
      repeat_cache = repeat != 0 ? repeat : (effective_parent != nullptr ? parent_repeat : 0);
      a.texture_filter = filter_cache;
      a.texture_repeat = repeat_cache;
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
      if (read_canvas_group) {
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
      if (read_copy_to_backbuffer && as(node, tags.back_buffer_copy) != nullptr) {
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
  walker.read_canvas_group = config.canvas_group;
  walker.read_copy_to_backbuffer = config.copy_to_backbuffer;
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
std::atomic<int> g_res_fault{0};
std::thread::id g_res_main;
std::mutex g_res_mutex;  // guards the census, the refused sets and the stats
AdoptResourceStats g_res_stats;
std::unordered_set<std::uint64_t> g_res_refused_textures;
std::unordered_set<std::uint64_t> g_res_refused_meshes;
thread_local bool t_res_inside = false;

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
};
Census g_census;

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
                    void *font_tag, void *ctex_tag, std::uint32_t *paths) {
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
      scan_directory(loader, path, depth + 1, fonts, font_tag, ctex_tag, paths);
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
    void *font_tag = g_iface.classdb_get_class_tag(font_name.ptr());
    void *ctex_tag = g_iface.classdb_get_class_tag(ctex_name.ptr());
    if (font_tag != nullptr && ctex_tag != nullptr) {
      scan_directory(loader, "res://", 0, &fonts, font_tag, ctex_tag, &paths);
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

void adopt_texture_locked_out(std::uint64_t rid) {
  const std::uint64_t t0 = now_ns();
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
    std::lock_guard<std::mutex> lock(g_res_mutex);
    if (g_res_refused_textures.insert(rid).second) {
      ++g_res_stats.textures_refused;
    }
    g_res_stats.lookup_ns += now_ns() - t0;
    return;
  }
  const bool main = std::this_thread::get_id() == g_res_main;
  {
    std::lock_guard<std::mutex> lock(g_res_mutex);
    if (main && !g_census.built) {
      build_census();
    }
  }
  bool compressed = false;
  {
    std::lock_guard<std::mutex> lock(g_res_mutex);
    compressed = g_census.compressed.count(rid) != 0;
  }
  void *image = creation_image;
  rs2::AdoptedContent content = rs2::AdoptedContent::Creation;
  const char *source = "dummy";
  bool atlas = false;
  RefSlot current;
  if (compressed) {
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
    if (decoded) ++g_res_stats.decoded;
  }
  g_res_stats.lookup_ns += now_ns() - t0;
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
  } else {
    *error = "invalid GRC_ADOPT_FAULT=" + text +
             " (expected no-resources, atlas-from-dummy, claim-current or no-include-path)";
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
  }
  return "none";
}

void adopt_resources_begin(AdoptFault f) {
  std::lock_guard<std::mutex> lock(g_res_mutex);
  g_res_stats = AdoptResourceStats();
  g_res_refused_textures.clear();
  g_res_refused_meshes.clear();
  g_census = Census();
  g_res_main = std::this_thread::get_id();
  g_res_fault.store(static_cast<int>(f), std::memory_order_release);
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
  return g_res_stats;
}

void adopt_texture_ref(std::uint64_t rid) {
  if (rid == 0 || !g_res_active.load(std::memory_order_acquire) || t_res_inside ||
      fault() == AdoptFault::NoResources || !mirror_enabled() ||
      mirror_instance().knows_texture(rid)) {
    return;
  }
  // Off the main thread only the main thread's next reference adopts (the dummy's storage and
  // the TextServer are read from the main thread only); the command stays unknown-texture.
  if (std::this_thread::get_id() != g_res_main) {
    return;
  }
  {
    std::lock_guard<std::mutex> lock(g_res_mutex);
    if (g_res_refused_textures.count(rid) != 0) {
      return;
    }
  }
  t_res_inside = true;
  adopt_texture_locked_out(rid);
  t_res_inside = false;
}

void adopt_mesh_ref(std::uint64_t rid) {
  if (rid == 0 || !g_res_active.load(std::memory_order_acquire) || t_res_inside ||
      fault() == AdoptFault::NoResources || !mirror_enabled() ||
      mirror_instance().knows_mesh(rid) || std::this_thread::get_id() != g_res_main) {
    return;
  }
  {
    std::lock_guard<std::mutex> lock(g_res_mutex);
    if (g_res_refused_meshes.count(rid) != 0) {
      return;
    }
  }
  t_res_inside = true;
  adopt_mesh_locked_out(rid);
  t_res_inside = false;
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
bool g_mat_epoch_valid = false;
std::uint64_t g_mat_epoch_seen = 0;
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

void node_added_call(void * /*userdata*/, const GDExtensionConstVariantPtr *args,
                     GDExtensionInt count, GDExtensionVariantPtr /*ret*/,
                     GDExtensionCallError *error) {
  if (error != nullptr) {
    error->error = GDEXTENSION_CALL_OK;
  }
  if (count < 1 || args == nullptr || !g_res_active.load(std::memory_order_acquire) ||
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
  mat_stat([](AdoptMaterialStats &s) { ++s.nodes_added; });
}

void *scene_tree() {
  void *engine = singleton_object("Engine");
  return engine != nullptr ? cast_to(get_object(kEngineGetMainLoop, engine), "SceneTree") : nullptr;
}

void node_map_connect() {
  void *tree = scene_tree();
  if (tree == nullptr) {
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

// One pass over the mirror's unresolved references (rs_mirror.h pending_material_refs).
void resolve_pending(bool at_arm) {
  Mirror &m = mirror_instance();
  const Mirror::PendingMaterialRefs pending = m.pending_material_refs();
  for (const auto &ref : pending.items) {
    if (g_mat_refused_items.count(ref) != 0) continue;
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
    if (ref.items.empty() || g_mat_refused_shaders.count(key) != 0) continue;
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

void node_map_disconnect() {
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

void adopt_materials_configure(AdoptMaterialSabotage sabotage) {
  {
    std::lock_guard<std::mutex> lock(g_mat_mutex);
    g_mat_stats = AdoptMaterialStats();
  }
  g_mat_sabotage.store(static_cast<int>(sabotage), std::memory_order_release);
  g_mat_epoch_valid = false;
  g_mat_epoch_seen = 0;
  g_mat_refused_items.clear();
  g_mat_refused_shaders.clear();
  g_cim_synthetic.clear();
  g_node_prune_at = 4096;
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
  g_mat_epoch_seen = mirror_instance().material_refs_epoch();
  g_mat_epoch_valid = true;
  const std::uint64_t t1 = now_ns();
  mat_stat([&](AdoptMaterialStats &s) { s.arm_ns += t1 - t0; });
}

void adopt_materials_resolve() {
  if (!g_res_active.load(std::memory_order_acquire) || fault() == AdoptFault::NoResources ||
      !mirror_enabled() || !g_binds_resolved ||
      std::this_thread::get_id() != g_res_main) {
    return;
  }
  Mirror &m = mirror_instance();
  if (g_mat_epoch_valid && m.material_refs_epoch() == g_mat_epoch_seen) {
    return;
  }
  const std::uint64_t t0 = now_ns();
  node_map_prune();
  resolve_pending(false);
  g_mat_epoch_seen = m.material_refs_epoch();
  g_mat_epoch_valid = true;
  const std::uint64_t t1 = now_ns();
  mat_stat([&](AdoptMaterialStats &s) {
    ++s.resolve_passes;
    s.resolve_ns += t1 - t0;
  });
}

}  // namespace rs
}  // namespace grc
