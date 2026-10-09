// Arm-time root viewport query (gate 0, WP1; protocol/gate0-design.md
// "Root adoption").
//
// The root viewport and its canvas exist before the capture library loads, so
// their RIDs and state cannot be observed through the hooks. They are read back
// once, right after the vptr store, through read-only ClassDB method binds
// (ptrcall), never through a RenderingServer slot:
//
//   1. Engine.get_main_loop()            -> SceneTree (checked with object_cast_to)
//   2. SceneTree.get_root()              -> Window, a Viewport (checked likewise)
//   3. Viewport.get_viewport_rid()       -> root viewport RID
//   4. Viewport.get_world_2d()           -> Ref<World2D>; World2D.get_canvas() -> root canvas RID
//   5. Viewport.get_canvas_transform()   -> session root_canvas_xform, canvas 1's transform
//   6. Viewport.get_canvas_cull_mask()   -> session viewport.canvas_cull_mask
//   7. Viewport.get_visible_rect()       -> session host_visible_rect (64x64 under --headless)
//   8. RenderingServer.get_default_clear_color() -> session clear_color
//
// Gate 1 (G1a, protocol/gate1-design.md "Q1") adds the root geometry the
// session will declare, read through more read-only binds on the root Window:
//
//   9. Window.get_content_scale_size()     -> logical size (the project's viewport size)
//  10. Window.get_content_scale_mode/aspect/stretch/factor()
//  11. Window.get_size()                   -> host window size
//  12. Viewport.get_final_transform()      -> stretch transform * global canvas transform
//
// and the one write, Window.set_min_size(content_scale_size), made only under
// GRC_ROOT_SIZE=enforce-min-size (root_enforce_min_size).
//
// Any failure (a null bind, a null or wrongly typed object, a null RID) still
// returns every value it could read, with zeros in place of the rest, and names
// the first failed step in `failed_step`. The caller turns that into the sticky
// `root-query-failed` capture failure (mirror_fail_root_query).
#ifndef GRC_RS0_ROOT_QUERY_H
#define GRC_RS0_ROOT_QUERY_H

#include <cstdint>
#include <string>

#include "rs0_snapshot.h"

namespace grc {
namespace rs0 {

struct RootInfo {
  bool ok = false;
  std::string failed_step;  // e.g. "Viewport.get_world_2d"; empty when ok
  std::uint64_t viewport_rid = 0;
  std::uint64_t canvas_rid = 0;
  Xform canvas_xform = {0, 0, 0, 0, 0, 0};
  std::uint32_t canvas_cull_mask = 0;
  Rect4 visible_rect = kZeroRect;
  Color4 clear_color = {0, 0, 0, 0};

  // Gate 1 root geometry (zeros where a read failed).
  std::int32_t logical_size[2] = {0, 0};  // Window.content_scale_size
  std::int64_t content_scale_mode = 0;    // Window.ContentScaleMode
  std::int64_t content_scale_aspect = 0;  // Window.ContentScaleAspect
  std::int64_t content_scale_stretch = 0; // Window.ContentScaleStretch
  double content_scale_factor = 0.0;
  std::int32_t window_size[2] = {0, 0};   // Window.size
  Xform final_transform = {0, 0, 0, 0, 0, 0};

  // The root Window object (not owned; valid on the main thread at arm). Only
  // root_enforce_min_size uses it.
  void *window = nullptr;
};

// host_size_status (gate1-design.md Q1 "Policy").
enum class HostSizeStatus : std::uint8_t { Match, DegenerateVisible, DegenerateWindow };

inline const char *to_wire(HostSizeStatus v) {
  switch (v) {
  case HostSizeStatus::Match: return "match";
  case HostSizeStatus::DegenerateVisible: return "degenerate-visible";
  case HostSizeStatus::DegenerateWindow: return "degenerate-window";
  }
  return "degenerate-visible";
}

// match: window size == logical size and visible rect size == logical size;
// degenerate-visible: visible rect size != logical size (layout input differs);
// degenerate-window: visible rect right, window size wrong (stretch differs).
inline HostSizeStatus host_size_status(const RootInfo &info) {
  const float lw = static_cast<float>(info.logical_size[0]);
  const float lh = static_cast<float>(info.logical_size[1]);
  if (info.visible_rect[2] != lw || info.visible_rect[3] != lh) {
    return HostSizeStatus::DegenerateVisible;
  }
  if (info.window_size[0] != info.logical_size[0] || info.window_size[1] != info.logical_size[1]) {
    return HostSizeStatus::DegenerateWindow;
  }
  return HostSizeStatus::Match;
}

// Spellings for evidence/root.json `stretch` (Window enums, scene/main/window.h).
const char *content_scale_mode_name(std::int64_t mode);
const char *content_scale_aspect_name(std::int64_t aspect);
const char *content_scale_stretch_name(std::int64_t stretch);

// Runs the read-only queries (1-12). Main thread, after the engine singletons
// and the SceneTree exist (the library arms inside the fixture autoload's
// _enter_tree, which satisfies both).
RootInfo root_query_run();

// GRC_ROOT_SIZE=enforce-min-size: Window.set_min_size(info.logical_size) on the
// root window, so the min-size clamp (scene/main/window.cpp:1144-1152) gives a
// headless root the logical size. Returns false with `detail` when the call
// could not be made; whether it worked is read back by a second
// root_query_run().
bool root_enforce_min_size(const RootInfo &info, std::string *detail);

// Feeds a query result to the process-wide mirror: binds the root RIDs and
// canvas 1's transform, and records root-query-failed when !info.ok.
void root_query_apply(const RootInfo &info);

}  // namespace rs0
}  // namespace grc

#endif  // GRC_RS0_ROOT_QUERY_H
