// Arm-time root viewport query (gate 0, WP1; protocol/gate0-design.md
// "Root adoption"). Version-neutral since G1b2: it fills render-stream/1
// (rs1_snapshot.h) values.
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
// Gate 2 (G2a) adds, as evidence only (a failure does not fail the query):
//
//  13. Viewport.get_default_canvas_item_texture_filter/_repeat() -> the root's texture defaults
//
// and the one write, Window.set_min_size(content_scale_size), made only under
// GRC_ROOT_SIZE=enforce-min-size (root_enforce_min_size). Since G1b2 these
// are the session's `viewport` object and its `host_*` / `content_scale_factor`
// blocks (render-stream-1.md "Session record").
//
// Any failure (a null bind, a null or wrongly typed object, a null RID) still
// returns every value it could read, with zeros in place of the rest, and names
// the first failed step in `failed_step`. The caller turns that into the sticky
// `root-query-failed` capture failure (mirror_fail_root_query).
#ifndef GRC_RS_ROOT_QUERY_H
#define GRC_RS_ROOT_QUERY_H

#include <cstdint>
#include <string>

#include "rs1_snapshot.h"

namespace grc {
namespace rs {

struct RootInfo {
  bool ok = false;
  std::string failed_step;  // e.g. "Viewport.get_world_2d"; empty when ok
  std::uint64_t viewport_rid = 0;
  std::uint64_t canvas_rid = 0;
  rs1::Xform canvas_xform = {0, 0, 0, 0, 0, 0};
  std::uint32_t canvas_cull_mask = 0;
  rs1::Rect4 visible_rect = rs1::kZeroRect;
  rs1::Color4 clear_color = {0, 0, 0, 0};

  // Gate 1 root geometry (zeros where a read failed).
  std::int32_t logical_size[2] = {0, 0};  // Window.content_scale_size
  std::int64_t content_scale_mode = 0;    // Window.ContentScaleMode
  std::int64_t content_scale_aspect = 0;  // Window.ContentScaleAspect
  std::int64_t content_scale_stretch = 0; // Window.ContentScaleStretch
  double content_scale_factor = 0.0;
  std::int32_t window_size[2] = {0, 0};   // Window.size
  rs1::Xform final_transform = {0, 0, 0, 0, 0, 0};

  // Gate 2 (G2a), evidence only: Viewport.get_default_canvas_item_texture_filter/_repeat on the
  // root, as the scene enums (filter 0 Nearest, 1 Linear, 2 Linear Mipmap, 3 Nearest Mipmap;
  // repeat 0 Disabled, 1 Enabled, 2 Mirror), -1 when the read failed (13).
  std::int64_t default_texture_filter = -1;
  std::int64_t default_texture_repeat = -1;

  // The root Window object (not owned; valid on the main thread at arm). Only
  // root_enforce_min_size uses it.
  void *window = nullptr;
};

// host_size_status (gate1-design.md Q1 "Policy"):
// match: window size == logical size and visible rect size == logical size;
// degenerate-visible: visible rect size != logical size (layout input differs);
// degenerate-window: visible rect right, window size wrong (stretch differs).
inline rs1::HostSizeStatus host_size_status(const RootInfo &info) {
  const float lw = static_cast<float>(info.logical_size[0]);
  const float lh = static_cast<float>(info.logical_size[1]);
  if (info.visible_rect[2] != lw || info.visible_rect[3] != lh) {
    return rs1::HostSizeStatus::DegenerateVisible;
  }
  if (info.window_size[0] != info.logical_size[0] || info.window_size[1] != info.logical_size[1]) {
    return rs1::HostSizeStatus::DegenerateWindow;
  }
  return rs1::HostSizeStatus::Match;
}

// Spellings for evidence/root.json `stretch` (Window enums, scene/main/window.h).
const char *content_scale_mode_name(std::int64_t mode);
const char *content_scale_aspect_name(std::int64_t aspect);
const char *content_scale_stretch_name(std::int64_t stretch);

// The session's `viewport.stretch` from the Window enums: content_scale_mode
// 0 disabled / 1 canvas_items / 2 viewport; content_scale_aspect 0 ignore /
// 1 keep / 2 keep_width / 3 keep_height / 4 expand; content_scale_stretch
// 0 fractional / 1 integer. Returns false (leaving the RS-default value in
// place for that field) when a value is outside its enum.
bool stretch_from_window(const RootInfo &info, rs1::Stretch *out);

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

}  // namespace rs
}  // namespace grc

#endif  // GRC_RS_ROOT_QUERY_H
