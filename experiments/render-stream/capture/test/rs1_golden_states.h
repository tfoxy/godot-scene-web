// Test-only ground truth for protocol/golden-1/{full,patch}.rs1 and resolved.json, hand-
// transcribed from protocol/golden-1/make_golden.py's states 1-6 (see that file's module
// docstring for the six-step scenario). Shared by rs1_codec_test.cpp (which builds Transactions
// directly, bypassing rs1_diff) and rs1_diff_test.cpp (which builds these Snapshots and derives
// Transactions through make_full()/make_patch()), so the two tests check two independent paths
// to the same golden bytes without duplicating the fiddly per-item data twice.
#ifndef GRC_RS1_GOLDEN_STATES_H
#define GRC_RS1_GOLDEN_STATES_H

#include <array>
#include <string>
#include <vector>

#include "rs1_snapshot.h"

namespace grc {
namespace rs1 {
namespace golden {

inline const std::string kFullSessionId = "0123456789abcdef0123456789abcdef";
inline const std::string kFullStreamId = std::string(32, '1');
inline const std::string kPatchSessionId = "fedcba9876543210fedcba9876543210";
inline const std::string kPatchStreamId = std::string(32, '2');

inline const std::vector<std::string> kHooksPlanned = {
    "canvas_create",
    "canvas_item_add_circle",
    "canvas_item_add_line",
    "canvas_item_add_mesh",
    "canvas_item_add_msdf_texture_rect_region",
    "canvas_item_add_multimesh",
    "canvas_item_add_nine_patch",
    "canvas_item_add_polygon",
    "canvas_item_add_polyline",
    "canvas_item_add_primitive",
    "canvas_item_add_rect",
    "canvas_item_add_set_transform",
    "canvas_item_add_texture_rect",
    "canvas_item_add_texture_rect_region",
    "canvas_item_add_triangle_array",
    "canvas_item_clear",
    "canvas_item_create",
    "canvas_item_set_clip",
    "canvas_item_set_custom_rect",
    "canvas_item_set_draw_index",
    "canvas_item_set_material",
    "canvas_item_set_modulate",
    "canvas_item_set_parent",
    "canvas_item_set_self_modulate",
    "canvas_item_set_transform",
    "canvas_item_set_visibility_layer",
    "canvas_item_set_visible",
    "canvas_item_set_z_index",
    "free",
    "material_set_param",
    "mesh_add_surface",
    "mesh_clear",
    "mesh_create",
    "mesh_set_custom_aabb",
    "mesh_surface_update_attribute_region",
    "mesh_surface_update_vertex_region",
    "shader_create_from_code",
    "shader_set_code",
    "texture_2d_create",
    "texture_2d_update",
    "viewport_attach_canvas",
    "viewport_set_canvas_transform"};

// render-stream-1.md "Session": gate 0's item_state plus "behind" and "z_relative", sorted
// ascending by byte value.
inline const std::vector<std::string> kFeatureItemState = {
    "behind",  "children", "clip",           "custom_rect",      "draw_index",
    "modulate", "parent",   "self_modulate",  "transform",        "visibility_layer",
    "visible",  "z_index",  "z_relative"};

inline const std::vector<std::string> kFeatureObservedUnsupported = {
    "canvas_item_add_circle",
    "canvas_item_add_line",
    "canvas_item_add_mesh",
    "canvas_item_add_msdf_texture_rect_region",
    "canvas_item_add_multimesh",
    "canvas_item_add_nine_patch",
    "canvas_item_add_polygon",
    "canvas_item_add_polyline",
    "canvas_item_add_primitive",
    "canvas_item_add_set_transform",
    "canvas_item_add_texture_rect",
    "canvas_item_add_texture_rect_region",
    "canvas_item_add_triangle_array",
    "canvas_item_set_material"};

// gate 0's unobserved list plus "viewport_set_global_canvas_transform", sorted ascending.
inline const std::vector<std::string> kFeatureUnobserved = {
    "canvas_item_set_canvas_group_mode",
    "canvas_item_set_default_texture_filter",
    "canvas_item_set_default_texture_repeat",
    "canvas_item_set_draw_behind_parent",
    "canvas_item_set_instance_shader_parameter",
    "canvas_item_set_light_mask",
    "canvas_item_set_sort_children_by_y",
    "canvas_item_set_z_as_relative_to_parent",
    "canvas_set_modulate",
    "viewport_remove_canvas",
    "viewport_set_canvas_cull_mask",
    "viewport_set_global_canvas_transform"};

inline Session golden_session(Encoding stream_encoding, const std::string &stream_id,
                               const std::string &session_id) {
  Session session;
  session.session_id = session_id;
  session.stream.stream_id = stream_id;
  session.stream.has_connection = false;
  session.stream.transport = Transport::File;
  session.stream.encoding = stream_encoding;
  session.engine.version_string = "Godot Engine v4.5.1.stable.official";
  session.engine.sha256 = "54cc228405e5be61934192e3bc5461c91dcb4a3275578b29a869557a4322e79c";
  session.engine.display_server = "headless";
  session.engine.rendering_driver = "opengl3";
  session.engine.rendering_method = "gl_compatibility";
  session.capture.calibrator_version = 3;
  session.capture.hooks_planned = kHooksPlanned;
  session.capture.hooks_omitted = {};
  session.viewport.canvas_cull_mask = 4294967295u;
  session.viewport.root_canvas = 1;
  session.viewport.logical_size = {640, 360};
  session.viewport.stretch.mode = StretchMode::Disabled;
  session.viewport.stretch.aspect = StretchAspect::Ignore;
  session.viewport.stretch.scale_mode = ScaleMode::Fractional;
  session.viewport.root_size_policy = RootSizePolicy::Observe;
  session.viewport.host_size_status = HostSizeStatus::Match;
  session.viewport.host_window_size = {640, 360};
  session.features.ops = {"add_rect"};
  session.features.item_state = kFeatureItemState;
  session.features.observed_unsupported_ops = kFeatureObservedUnsupported;
  session.features.unobserved = kFeatureUnobserved;
  session.features.publication = "snapshot-or-patch";
  session.sabotage.kind = SabotageKind::None;
  session.clear_color = {0.25f, 0.25f, 0.5f, 1.0f};
  session.root_canvas_xform = kIdentityXform;
  session.host_visible_rect = {0.0f, 0.0f, 640.0f, 360.0f};
  session.host_final_xform = kIdentityXform;
  session.content_scale_factor = 1.0f;
  return session;
}

inline CanvasState root_canvas(std::vector<std::uint32_t> items) {
  CanvasState c;
  c.id = 1;
  c.origin = Origin::RootQuery;
  c.role = CanvasRole::Root;
  c.attached = true;
  c.xform = kIdentityXform;
  c.items = std::move(items);
  return c;
}

inline Command rect(Rect4 r, Color4 color, bool aa = false) {
  Command c;
  c.kind = CommandKind::AddRect;
  c.antialiased = aa;
  c.rect = r;
  c.color = color;
  return c;
}

inline Command unsupported_cmd(std::string name) {
  Command c;
  c.kind = CommandKind::Unsupported;
  c.name = std::move(name);
  return c;
}

inline const UnsupportedRef kUnsupportedItem2 = []() {
  UnsupportedRef u;
  u.op = "canvas_item_add_circle";
  u.has_item = true;
  u.item = 2;
  u.reason = UnsupportedReason::UnsupportedOp;
  return u;
}();

inline const UnsupportedRef kTieItem3 = []() {
  UnsupportedRef u;
  u.op = "canvas_item_set_draw_index";
  u.has_item = true;
  u.item = 3;
  u.reason = UnsupportedReason::DrawIndexTie;
  return u;
}();

// --- items, by id and "version" (the state range each shape is used in) -------------------

inline ItemState item1_v1() {  // states 1-2: top-level, child {3}
  ItemState it;
  it.id = 1;
  it.parent = ParentRef{ParentKind::Canvas, 1};
  it.children = {3};
  it.xform = {1.0f, 0.0f, 0.0f, 1.0f, 10.0f, 10.0f};
  it.draw_index = 0;
  it.content_version = 1;
  it.commands = {rect({0.0f, 0.0f, 20.0f, 20.0f}, {1.0f, 0.0f, 0.0f, 1.0f})};
  return it;
}

inline ItemState item1_v2() {  // states 3-4: recoloured, content_version 2
  ItemState it = item1_v1();
  it.content_version = 2;
  it.commands = {rect({0.0f, 0.0f, 20.0f, 20.0f}, {0.5f, 0.0f, 0.5f, 1.0f})};
  return it;
}

inline ItemState item1_v3() {  // states 5-6: gains child 5
  ItemState it = item1_v2();
  it.children = {3, 5};
  return it;
}

inline ItemState item2_v1() {  // state 1
  ItemState it;
  it.id = 2;
  it.parent = ParentRef{ParentKind::Canvas, 1};
  it.xform = {1.0f, 0.0f, 0.0f, 1.0f, 50.0f, 10.0f};
  it.draw_index = 1;
  it.z_relative = false;
  it.content_version = 1;
  it.commands = {rect({0.0f, 0.0f, 16.0f, 16.0f}, {0.0f, 1.0f, 0.0f, 1.0f}, true),
                 unsupported_cmd("canvas_item_add_circle")};
  return it;
}

inline ItemState item2_v2() {  // state 2: transform-only move
  ItemState it = item2_v1();
  it.xform = {1.0f, 0.0f, 0.0f, 1.0f, 50.0f, 40.0f};
  return it;
}

inline ItemState item2_v3() {  // states 3-6: draw_index change, content unchanged
  ItemState it = item2_v2();
  it.draw_index = 4;
  return it;
}

inline ItemState item3_v1() {  // states 1-6: never changes
  ItemState it;
  it.id = 3;
  it.parent = ParentRef{ParentKind::Item, 1};
  it.xform = {1.0f, 0.0f, 0.0f, 1.0f, 0.0f, 30.0f};
  it.draw_index = 0;
  it.content_version = 1;
  it.commands = {rect({0.0f, 0.0f, 8.0f, 8.0f}, {0.0f, 0.0f, 1.0f, 1.0f})};
  return it;
}

inline ItemState item4_v1() {  // states 1-2 only: freed at state 3
  ItemState it;
  it.id = 4;
  it.parent = ParentRef{ParentKind::Canvas, 1};
  it.xform = {1.0f, 0.0f, 0.0f, 1.0f, 90.0f, 10.0f};
  it.draw_index = 2;
  it.behind = true;
  it.content_version = 1;
  it.commands = {rect({0.0f, 0.0f, 12.0f, 12.0f}, {1.0f, 1.0f, 0.0f, 1.0f})};
  return it;
}

inline ItemState item5_v1() {  // states 3-4: created, top-level
  ItemState it;
  it.id = 5;
  it.parent = ParentRef{ParentKind::Canvas, 1};
  it.xform = {1.0f, 0.0f, 0.0f, 1.0f, 130.0f, 10.0f};
  it.draw_index = 3;
  it.content_version = 1;
  it.commands = {rect({0.0f, 0.0f, 10.0f, 10.0f}, {1.0f, 0.0f, 1.0f, 1.0f})};
  return it;
}

inline ItemState item5_v2() {  // states 5-6: reparented under item 1, ties with item 3
  ItemState it = item5_v1();
  it.parent = ParentRef{ParentKind::Item, 1};
  it.draw_index = 0;
  return it;
}

// --- the six states ------------------------------------------------------------------------

inline Snapshot state(int n) {
  Snapshot s;
  s.seq = static_cast<std::uint64_t>(n);
  s.frame = static_cast<std::uint64_t>(n);
  switch (n) {
  case 1:
    s.canvases = {root_canvas({1, 2, 4})};
    s.items = {item1_v1(), item2_v1(), item3_v1(), item4_v1()};
    s.unsupported = {kUnsupportedItem2};
    break;
  case 2:
    s.canvases = {root_canvas({1, 2, 4})};
    s.items = {item1_v1(), item2_v2(), item3_v1(), item4_v1()};
    s.unsupported = {kUnsupportedItem2};
    break;
  case 3:
    s.canvases = {root_canvas({1, 2, 5})};
    s.items = {item1_v2(), item2_v3(), item3_v1(), item5_v1()};
    s.unsupported = {kUnsupportedItem2};
    break;
  case 4:
    s.canvases = {root_canvas({1, 2, 5})};
    s.items = {item1_v2(), item2_v3(), item3_v1(), item5_v1()};
    s.unsupported = {kUnsupportedItem2};
    break;
  case 5:
    s.canvases = {root_canvas({1, 2})};
    s.items = {item1_v3(), item2_v3(), item3_v1(), item5_v2()};
    s.unsupported = {kUnsupportedItem2, kTieItem3};
    break;
  case 6:
    s.canvases = {root_canvas({1, 2})};
    s.items = {item1_v3(), item2_v3(), item3_v1(), item5_v2()};
    s.unsupported = {kUnsupportedItem2, kTieItem3};
    break;
  default:
    break;
  }
  return s;
}

}  // namespace golden
}  // namespace rs1
}  // namespace grc

#endif  // GRC_RS1_GOLDEN_STATES_H
