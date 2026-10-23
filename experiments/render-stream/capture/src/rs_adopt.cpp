#include "rs_adopt.h"

#include <chrono>
#include <cstring>

#include "iface.h"
#include "rs_mirror.h"

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
};

GDExtensionMethodBindPtr g_bind[kBindCount] = {};
bool g_binds_resolved = false;
std::unordered_map<std::uint64_t, std::uint64_t> g_item_nodes;

bool resolve_binds(std::string *missing) {
  if (g_iface.classdb_get_method_bind == nullptr || g_iface.object_method_bind_ptrcall == nullptr ||
      g_iface.classdb_get_class_tag == nullptr || g_iface.object_cast_to == nullptr ||
      g_iface.ref_get_object == nullptr) {
    *missing = "GDExtension interface (method binds, cast_to, ref_get_object)";
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
       *parallax_layer = nullptr, *parallax2d = nullptr, *canvas_modulate = nullptr;
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
  }
};

void *as(void *object, void *tag) {
  return object != nullptr && tag != nullptr ? g_iface.object_cast_to(object, tag) : nullptr;
}

struct Walker {
  Tags tags;
  void *root = nullptr;
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
  g_item_nodes.clear();
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

}  // namespace rs
}  // namespace grc
