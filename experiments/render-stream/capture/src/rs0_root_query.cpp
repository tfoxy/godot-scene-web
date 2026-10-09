#include "rs0_root_query.h"

#include <cstring>

#include "abi.h"
#include "iface.h"
#include "rs0_mirror.h"

namespace grc {
namespace rs0 {

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

  info.ok = info.failed_step.empty();
  return info;
}

void root_query_apply(const RootInfo &info) {
  mirror_set_root(info.viewport_rid, info.canvas_rid, info.canvas_xform);
  if (!info.ok) {
    mirror_fail_root_query(info.failed_step.empty() ? std::string("unknown") : info.failed_step);
  }
}

}  // namespace rs0
}  // namespace grc
