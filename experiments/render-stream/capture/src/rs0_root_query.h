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
};

// Runs the eight read-only queries. Main thread, after the engine singletons
// and the SceneTree exist (the library arms inside the fixture autoload's
// _enter_tree, which satisfies both).
RootInfo root_query_run();

// Feeds a query result to the process-wide mirror: binds the root RIDs and
// canvas 1's transform, and records root-query-failed when !info.ok.
void root_query_apply(const RootInfo &info);

}  // namespace rs0
}  // namespace grc

#endif  // GRC_RS0_ROOT_QUERY_H
