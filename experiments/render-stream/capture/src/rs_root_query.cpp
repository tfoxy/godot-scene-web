#include "rs_root_query.h"

#include <cstring>

#include "abi.h"
#include "iface.h"
#include "rs_mirror.h"

namespace grc {
namespace rs {

namespace {

// Method hashes from `godot --dump-extension-api` of Godot 4.5.1
// (4.5.1.stable.official.f62fdbde1, the commit the release template is built
// from). A hash that does not match the running engine makes
// classdb_get_method_bind return null, which fails the query; it never calls
// a different method.
constexpr int64_t kEngineGetMainLoop = 1016888095LL;       // Engine.get_main_loop() -> MainLoop
constexpr int64_t kSceneTreeGetRoot = 1757182445LL;        // SceneTree.get_root() -> Window
constexpr int64_t kViewportGetViewportRid = 2944877500LL;  // Viewport.get_viewport_rid() -> RID
constexpr int64_t kViewportGetWorld2d = 2339128592LL;      // Viewport.get_world_2d() -> World2D
constexpr int64_t kWorld2dGetCanvas = 2944877500LL;        // World2D.get_canvas() -> RID
constexpr int64_t kViewportGetCanvasTransform = 3814499831LL;  // Viewport.get_canvas_transform() -> Transform2D
constexpr int64_t kViewportGetCanvasCullMask = 3905245786LL;   // Viewport.get_canvas_cull_mask() -> int (uint32)
constexpr int64_t kViewportGetVisibleRect = 1639390495LL;      // Viewport.get_visible_rect() -> Rect2
constexpr int64_t kRenderingServerGetDefaultClearColor = 3200896285LL;  // RenderingServer.get_default_clear_color() -> Color

// Gate 1 (G1a) root geometry, same dump. Every integer and enum return is
// encoded as int64 and a float return as double (core/variant/method_ptrcall.h).
constexpr int64_t kWindowGetContentScaleSize = 3690982128LL;     // Window.get_content_scale_size() -> Vector2i
constexpr int64_t kWindowGetContentScaleMode = 161585230LL;      // Window.get_content_scale_mode() -> Window.ContentScaleMode
constexpr int64_t kWindowGetContentScaleAspect = 4158790715LL;   // Window.get_content_scale_aspect() -> Window.ContentScaleAspect
constexpr int64_t kWindowGetContentScaleStretch = 536857316LL;   // Window.get_content_scale_stretch() -> Window.ContentScaleStretch
constexpr int64_t kWindowGetContentScaleFactor = 1740695150LL;   // Window.get_content_scale_factor() -> float (double on ptrcall)
constexpr int64_t kWindowGetSize = 3690982128LL;                 // Window.get_size() -> Vector2i
constexpr int64_t kViewportGetFinalTransform = 3814499831LL;     // Viewport.get_final_transform() -> Transform2D
// Gate 2 (G2a): the root viewport's default canvas-item texture filter and repeat, read once at
// arm because main.cpp sets them before the extension loads (gate2-design.md Q1d). Hashes from
// the same dump. Evidence only in G2a; G2b2 makes them the transaction scalars.
constexpr int64_t kViewportGetDefaultTextureFilter = 896601198LL;   // -> Viewport.DefaultCanvasItemTextureFilter
constexpr int64_t kViewportGetDefaultTextureRepeat = 4049774160LL;  // -> Viewport.DefaultCanvasItemTextureRepeat
// The one write (GRC_ROOT_SIZE=enforce-min-size only).
constexpr int64_t kWindowSetMinSize = 1130785943LL;              // Window.set_min_size(Vector2i) -> void

void note(RootInfo *info, const char *step) {
  if (info->failed_step.empty()) {
    info->failed_step = step;
  }
}

}  // namespace

RootInfo root_query_run() {
  RootInfo info;

  // 8 does not depend on the scene tree, so it runs whatever happens above it.
  {
    void *rs = singleton_object("RenderingServer");
    GDExtensionMethodBindPtr bind = method_bind("RenderingServer", "get_default_clear_color",
                                                kRenderingServerGetDefaultClearColor);
    Color color = {};
    if (call_value_getter(bind, rs, &color, sizeof(color))) {
      info.clear_color = {color.r, color.g, color.b, color.a};
    } else {
      note(&info, "RenderingServer.get_default_clear_color");
    }
  }

  // 1. Engine.get_main_loop() -> SceneTree.
  void *tree = nullptr;
  {
    void *engine = singleton_object("Engine");
    void *loop = nullptr;
    if (!call_object_getter(method_bind("Engine", "get_main_loop", kEngineGetMainLoop), engine,
                            &loop) ||
        loop == nullptr) {
      note(&info, "Engine.get_main_loop");
    } else {
      tree = cast_to(loop, "SceneTree");
      if (tree == nullptr) {
        note(&info, "Engine.get_main_loop:not-a-SceneTree");
      }
    }
  }

  // 2. SceneTree.get_root() -> Window (a Viewport).
  void *root = nullptr;
  if (tree != nullptr) {
    void *window = nullptr;
    if (!call_object_getter(method_bind("SceneTree", "get_root", kSceneTreeGetRoot), tree,
                            &window) ||
        window == nullptr) {
      note(&info, "SceneTree.get_root");
    } else {
      root = cast_to(window, "Viewport");
      if (root == nullptr) {
        note(&info, "SceneTree.get_root:not-a-Viewport");
      }
    }
  }

  if (root == nullptr) {
    // Steps 3-7 need the root viewport; their values stay zero.
    note(&info, "SceneTree.get_root");
    info.ok = false;
    return info;
  }

  // 3. Viewport.get_viewport_rid().
  {
    uint64_t rid = 0;
    if (!call_rid_getter(method_bind("Viewport", "get_viewport_rid", kViewportGetViewportRid),
                         root, &rid) ||
        rid == 0) {
      note(&info, "Viewport.get_viewport_rid");
    } else {
      info.viewport_rid = rid;
    }
  }

  // 4. Viewport.get_world_2d() -> Ref<World2D>, then World2D.get_canvas().
  {
    RefHolder world;
    if (!world.call(method_bind("Viewport", "get_world_2d", kViewportGetWorld2d), root) ||
        world.object() == nullptr) {
      note(&info, "Viewport.get_world_2d");
    } else {
      uint64_t rid = 0;
      if (!call_rid_getter(method_bind("World2D", "get_canvas", kWorld2dGetCanvas),
                           world.object(), &rid) ||
          rid == 0) {
        note(&info, "World2D.get_canvas");
      } else {
        info.canvas_rid = rid;
      }
    }
    // ~RefHolder drops the reference the ptrcall took.
  }

  // 5. Viewport.get_canvas_transform().
  {
    Transform2D xform = {};
    if (call_value_getter(
            method_bind("Viewport", "get_canvas_transform", kViewportGetCanvasTransform), root,
            &xform, sizeof(xform))) {
      info.canvas_xform = {xform.columns[0].x, xform.columns[0].y, xform.columns[1].x,
                           xform.columns[1].y, xform.columns[2].x, xform.columns[2].y};
    } else {
      note(&info, "Viewport.get_canvas_transform");
    }
  }

  // 6. Viewport.get_canvas_cull_mask(): ptrcall encodes every integer as int64.
  {
    int64_t mask = 0;
    if (call_int_getter(
            method_bind("Viewport", "get_canvas_cull_mask", kViewportGetCanvasCullMask), root,
            &mask)) {
      info.canvas_cull_mask = static_cast<uint32_t>(mask);
    } else {
      note(&info, "Viewport.get_canvas_cull_mask");
    }
  }

  // 7. Viewport.get_visible_rect().
  {
    Rect2 rect = {};
    if (call_value_getter(method_bind("Viewport", "get_visible_rect", kViewportGetVisibleRect),
                          root, &rect, sizeof(rect))) {
      info.visible_rect = {rect.position.x, rect.position.y, rect.size.x, rect.size.y};
    } else {
      note(&info, "Viewport.get_visible_rect");
    }
  }

  // 9-11. The root Window's content scale and size (gate 1, G1a).
  void *window = cast_to(root, "Window");
  if (window == nullptr) {
    note(&info, "SceneTree.get_root:not-a-Window");
  } else {
    info.window = window;
    int32_t size[2] = {0, 0};
    if (call_value_getter(
            method_bind("Window", "get_content_scale_size", kWindowGetContentScaleSize), window,
            size, sizeof(size))) {
      info.logical_size[0] = size[0];
      info.logical_size[1] = size[1];
    } else {
      note(&info, "Window.get_content_scale_size");
    }
    if (!call_int_getter(
            method_bind("Window", "get_content_scale_mode", kWindowGetContentScaleMode), window,
            &info.content_scale_mode)) {
      note(&info, "Window.get_content_scale_mode");
    }
    if (!call_int_getter(
            method_bind("Window", "get_content_scale_aspect", kWindowGetContentScaleAspect),
            window, &info.content_scale_aspect)) {
      note(&info, "Window.get_content_scale_aspect");
    }
    if (!call_int_getter(
            method_bind("Window", "get_content_scale_stretch", kWindowGetContentScaleStretch),
            window, &info.content_scale_stretch)) {
      note(&info, "Window.get_content_scale_stretch");
    }
    if (!call_value_getter(
            method_bind("Window", "get_content_scale_factor", kWindowGetContentScaleFactor),
            window, &info.content_scale_factor, sizeof(info.content_scale_factor))) {
      note(&info, "Window.get_content_scale_factor");
    }
    int32_t window_size[2] = {0, 0};
    if (call_value_getter(method_bind("Window", "get_size", kWindowGetSize), window, window_size,
                          sizeof(window_size))) {
      info.window_size[0] = window_size[0];
      info.window_size[1] = window_size[1];
    } else {
      note(&info, "Window.get_size");
    }
  }

  // 12. Viewport.get_final_transform().
  {
    Transform2D xform = {};
    if (call_value_getter(
            method_bind("Viewport", "get_final_transform", kViewportGetFinalTransform), root,
            &xform, sizeof(xform))) {
      info.final_transform = {xform.columns[0].x, xform.columns[0].y, xform.columns[1].x,
                              xform.columns[1].y, xform.columns[2].x, xform.columns[2].y};
    } else {
      note(&info, "Viewport.get_final_transform");
    }
  }

  // 13. Viewport.get_default_canvas_item_texture_filter/_repeat (G2a, evidence only: a failed
  // read leaves -1 and does not fail the root query, which gates 0 and 1 rely on).
  {
    int64_t value = 0;
    if (call_int_getter(method_bind("Viewport", "get_default_canvas_item_texture_filter",
                                    kViewportGetDefaultTextureFilter),
                        root, &value)) {
      info.default_texture_filter = value;
    }
    value = 0;
    if (call_int_getter(method_bind("Viewport", "get_default_canvas_item_texture_repeat",
                                    kViewportGetDefaultTextureRepeat),
                        root, &value)) {
      info.default_texture_repeat = value;
    }
  }

  info.ok = info.failed_step.empty();
  return info;
}

bool root_enforce_min_size(const RootInfo &info, std::string *detail) {
  if (info.window == nullptr) {
    *detail = "no root Window";
    return false;
  }
  if (info.logical_size[0] <= 0 || info.logical_size[1] <= 0) {
    *detail = "content_scale_size is " + std::to_string(info.logical_size[0]) + "x" +
              std::to_string(info.logical_size[1]);
    return false;
  }
  if (!call_void_vector2i(method_bind("Window", "set_min_size", kWindowSetMinSize), info.window,
                          info.logical_size[0], info.logical_size[1])) {
    *detail = "Window.set_min_size bind unavailable";
    return false;
  }
  return true;
}

const char *content_scale_mode_name(std::int64_t mode) {
  switch (mode) {
  case 0: return "disabled";
  case 1: return "canvas_items";
  case 2: return "viewport";
  }
  return "unknown";
}

const char *content_scale_aspect_name(std::int64_t aspect) {
  switch (aspect) {
  case 0: return "ignore";
  case 1: return "keep";
  case 2: return "keep_width";
  case 3: return "keep_height";
  case 4: return "expand";
  }
  return "unknown";
}

const char *content_scale_stretch_name(std::int64_t stretch) {
  switch (stretch) {
  case 0: return "fractional";
  case 1: return "integer";
  }
  return "unknown";
}

bool stretch_from_window(const RootInfo &info, rs1::Stretch *out) {
  bool ok = true;
  switch (info.content_scale_mode) {
  case 0: out->mode = rs1::StretchMode::Disabled; break;
  case 1: out->mode = rs1::StretchMode::CanvasItems; break;
  case 2: out->mode = rs1::StretchMode::Viewport; break;
  default: ok = false; break;
  }
  switch (info.content_scale_aspect) {
  case 0: out->aspect = rs1::StretchAspect::Ignore; break;
  case 1: out->aspect = rs1::StretchAspect::Keep; break;
  case 2: out->aspect = rs1::StretchAspect::KeepWidth; break;
  case 3: out->aspect = rs1::StretchAspect::KeepHeight; break;
  case 4: out->aspect = rs1::StretchAspect::Expand; break;
  default: ok = false; break;
  }
  switch (info.content_scale_stretch) {
  case 0: out->scale_mode = rs1::ScaleMode::Fractional; break;
  case 1: out->scale_mode = rs1::ScaleMode::Integer; break;
  default: ok = false; break;
  }
  return ok;
}

void root_query_apply(const RootInfo &info) {
  mirror_set_root(info.viewport_rid, info.canvas_rid, info.canvas_xform);
  if (!info.ok) {
    mirror_fail_root_query(info.failed_step.empty() ? std::string("unknown") : info.failed_step);
  }
}

}  // namespace rs
}  // namespace grc
