// Test-only ground truth for protocol/golden-2/{full,patch,inline}.rs2 and resolved.json, hand-
// transcribed from protocol/golden-2/make_golden.py's states 1-6 (see that file's module
// docstring for the six-step scenario). Shared by rs2_codec_test.cpp (which builds Transactions
// directly, bypassing rs2_diff) and rs2_diff_test.cpp (which builds these Snapshots and derives
// Transactions through make_full()/make_patch()), mirroring rs1_golden_states.h's role at /1.
#ifndef GRC_RS2_GOLDEN_STATES_H
#define GRC_RS2_GOLDEN_STATES_H

#include <array>
#include <string>
#include <vector>

#include "rs2_snapshot.h"

namespace grc {
namespace rs2 {
namespace golden {

inline const std::string kFullSessionId = "0123456789abcdef0123456789abcdef";
inline const std::string kFullStreamId = std::string(32, '1');
inline const std::string kPatchSessionId = "fedcba9876543210fedcba9876543210";
inline const std::string kPatchStreamId = std::string(32, '2');

// payload_sha256() of protocol/golden-2/payloads/{a1,a2,f,p}.grt (make_golden.py HASH_A1/A2/F/P).
inline const std::string kHashA1 = "e65a0caf1a46175e39e501f3000016c9b56958648fda140874f93c9fcbd03fa9";
inline const std::string kHashA2 = "2caeb3ac168881aa04708631b7cc1427c452c1a0393d096451a9eef6841bc740";
inline const std::string kHashF = "010fa78f5252bba55d7f689e94974819078dbe444ca78233993e50f709184047";
inline const std::string kHashP = "f6627c820b3e0bce58471b2441627478709cf7d6f4886776d91f01ced28d48f3";

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

inline const std::vector<std::string> kFeatureOps = {"add_rect", "add_texture_rect",
                                                       "add_texture_rect_region"};

inline const std::vector<std::string> kFeatureItemState = {
    "behind",  "children",       "clip",           "custom_rect", "draw_index",
    "modulate", "parent",        "self_modulate",  "texture_filter", "texture_repeat",
    "transform", "visibility_layer", "visible",     "z_index",     "z_relative"};

inline const std::vector<std::string> kFeatureResources = {"texture_2d", "texture_2d_placeholder"};

inline const std::vector<std::string> kFeatureObservedUnsupported = {
    "canvas_item_add_circle",
    "canvas_item_add_lcd_texture_rect_region",
    "canvas_item_add_line",
    "canvas_item_add_mesh",
    "canvas_item_add_msdf_texture_rect_region",
    "canvas_item_add_multimesh",
    "canvas_item_add_nine_patch",
    "canvas_item_add_polygon",
    "canvas_item_add_polyline",
    "canvas_item_add_primitive",
    "canvas_item_add_set_transform",
    "canvas_item_add_triangle_array",
    "canvas_item_set_material"};

inline const std::vector<std::string> kFeatureUnobserved = {
    "canvas_item_set_canvas_group_mode",
    "canvas_item_set_instance_shader_parameter",
    "canvas_item_set_light_mask",
    "canvas_item_set_sort_children_by_y",
    "canvas_set_modulate",
    "canvas_texture_set_shading_parameters",
    "texture_set_size_override",
    "viewport_remove_canvas",
    "viewport_set_canvas_cull_mask",
    "viewport_set_global_canvas_transform"};

inline const std::vector<std::string> kPermittedFormats = {"L8", "LA8", "R8", "RG8", "RGB8", "RGBA8"};

inline Session golden_session(Encoding stream_encoding, const std::string &stream_id,
                               const std::string &session_id, Delivery delivery) {
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
  session.resources.delivery = delivery;
  session.resources.permitted_formats = kPermittedFormats;
  session.resources.max_payload_bytes = 16777216;
  if (delivery == Delivery::OutOfBand) {
    session.resources.inline_max_bytes = 0;
    session.resources.fetch = Fetch::Directory;
  } else {
    session.resources.inline_max_bytes = 16777216;
    session.resources.fetch = Fetch::None;
  }
  session.resources.has_http_path = false;
  session.resources.auth = Auth::None;
  session.features.ops = kFeatureOps;
  session.features.item_state = kFeatureItemState;
  session.features.resources = kFeatureResources;
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

inline Command add_rect(Rect4 r, Color4 color, bool aa = false) {
  Command c;
  c.kind = CommandKind::AddRect;
  c.antialiased = aa;
  c.rect = r;
  c.color = color;
  return c;
}

inline Command add_texture_rect(bool has_tex, std::uint32_t tex, bool tile, bool transpose, Rect4 rect,
                                 Color4 modulate = kWhite) {
  Command c;
  c.kind = CommandKind::AddTextureRect;
  c.has_tex = has_tex;
  c.tex = tex;
  c.tile = tile;
  c.transpose = transpose;
  c.rect = rect;
  c.modulate = modulate;
  return c;
}

inline Command add_texture_rect_region(bool has_tex, std::uint32_t tex, bool transpose, bool clip_uv,
                                        Rect4 rect, Rect4 src, Color4 modulate = kWhite) {
  Command c;
  c.kind = CommandKind::AddTextureRectRegion;
  c.has_tex = has_tex;
  c.tex = tex;
  c.transpose = transpose;
  c.clip_uv = clip_uv;
  c.rect = rect;
  c.src = src;
  c.modulate = modulate;
  return c;
}

inline Command unsupported_cmd(std::string name, UnsupportedCmdReason reason) {
  Command c;
  c.kind = CommandKind::Unsupported;
  c.name = std::move(name);
  c.unsupported_reason = reason;
  return c;
}

inline const UnsupportedRef kUnsupportedItem3 = []() {
  UnsupportedRef u;
  u.op = "canvas_item_add_texture_rect";
  u.has_item = true;
  u.item = 3;
  u.reason = UnsupportedReason::UnknownTexture;
  return u;
}();

inline const UnsupportedRef kUnsupportedTextureItem5 = []() {
  UnsupportedRef u;
  u.op = "canvas_item_add_texture_rect";
  u.has_item = true;
  u.item = 5;
  u.reason = UnsupportedReason::UnsupportedTexture;
  return u;
}();

inline const std::vector<UnsupportedRef> kBaseUnsupported = {kUnsupportedItem3, kUnsupportedTextureItem5};

// --- the five items, constant except item 1 (seq 2) and item 4 (seq 5/6) -------------------

inline ItemState item1_v1() {  // states 1: before the transform-only move
  ItemState it;
  it.id = 1;
  it.parent = ParentRef{ParentKind::Canvas, 1};
  it.xform = kIdentityXform;
  it.draw_index = 0;
  it.texture_filter = Filter::Linear;
  it.texture_repeat = Repeat::Enabled;
  it.content_version = 1;
  it.commands = {add_texture_rect(true, 1, true, true, {0.0f, 0.0f, 16.0f, 16.0f})};
  return it;
}

inline ItemState item1_v2() {  // states 2-6: transform-only move, content unchanged
  ItemState it = item1_v1();
  it.xform = {1.0f, 0.0f, 0.0f, 1.0f, 8.0f, 0.0f};
  return it;
}

inline ItemState item2() {  // states 1-6: never changes
  ItemState it;
  it.id = 2;
  it.parent = ParentRef{ParentKind::Canvas, 1};
  it.xform = {1.0f, 0.0f, 0.0f, 1.0f, 20.0f, 0.0f};
  it.draw_index = 1;
  it.content_version = 1;
  it.commands = {add_texture_rect_region(true, 1, true, true, {32.0f, 0.0f, -16.0f, 16.0f},
                                          {16.0f, 0.0f, -16.0f, 16.0f})};
  return it;
}

inline ItemState item3() {  // states 1-6: never changes
  ItemState it;
  it.id = 3;
  it.parent = ParentRef{ParentKind::Canvas, 1};
  it.xform = {1.0f, 0.0f, 0.0f, 1.0f, 40.0f, 0.0f};
  it.draw_index = 2;
  it.content_version = 1;
  it.commands = {unsupported_cmd("canvas_item_add_texture_rect", UnsupportedCmdReason::UnknownTexture)};
  return it;
}

inline ItemState item4_v1() {  // states 1-4: draws texture 5 (F)
  ItemState it;
  it.id = 4;
  it.parent = ParentRef{ParentKind::Canvas, 1};
  it.xform = {1.0f, 0.0f, 0.0f, 1.0f, 60.0f, 0.0f};
  it.draw_index = 3;
  it.content_version = 1;
  it.commands = {add_texture_rect(true, 5, false, false, {0.0f, 0.0f, 4.0f, 4.0f})};
  return it;
}

inline ItemState item4_v2() {  // states 5-6: F's last reference cleared
  ItemState it = item4_v1();
  it.content_version = 2;
  it.commands = {add_texture_rect(false, 0, false, false, {0.0f, 0.0f, 4.0f, 4.0f})};
  return it;
}

inline ItemState item5() {  // states 1-6: never changes; draws unsupported texture 3 (U)
  ItemState it;
  it.id = 5;
  it.parent = ParentRef{ParentKind::Canvas, 1};
  it.xform = {1.0f, 0.0f, 0.0f, 1.0f, 80.0f, 0.0f};
  it.draw_index = 4;
  it.content_version = 1;
  it.commands = {add_texture_rect(true, 3, false, false, {0.0f, 0.0f, 4.0f, 4.0f})};
  return it;
}

// --- the five textures (A, Atwin, U, P, F), plus N (id 6) from state 4 on ------------------

inline TextureEntry texture_a(std::uint64_t version, const std::string &hash) {
  TextureEntry t;
  t.id = 1;
  t.kind = TextureKind::Image;
  t.version = version;
  t.has_hash = true;
  t.hash = hash;
  t.has_format = true;
  t.format = "RGBA8";
  t.width = 16;
  t.height = 16;
  t.payload_bytes = 1135;  // the whole GRT1 payload (render-stream-2.md "Texture")
  return t;
}

inline TextureEntry texture_atwin() {
  TextureEntry t;
  t.id = 2;
  t.kind = TextureKind::Image;
  t.version = 1;
  t.has_hash = true;
  t.hash = kHashA1;
  t.has_format = true;
  t.format = "RGBA8";
  t.width = 16;
  t.height = 16;
  t.payload_bytes = 1135;  // the whole GRT1 payload (render-stream-2.md "Texture")
  return t;
}

inline TextureEntry texture_u() {
  TextureEntry t;
  t.id = 3;
  t.kind = TextureKind::Image;
  t.status = TextureStatus::Unsupported;
  t.has_reason = true;
  t.reason = TextureReason::UnsupportedFormat;
  t.version = 1;
  t.has_format = true;
  t.format = "RGBAF";
  t.width = 4;
  t.height = 4;
  return t;
}

inline TextureEntry texture_p_placeholder() {
  TextureEntry t;
  t.id = 4;
  t.kind = TextureKind::Placeholder;
  t.version = 1;
  return t;
}

inline TextureEntry texture_p_replaced() {
  TextureEntry t;
  t.id = 4;
  t.kind = TextureKind::Image;
  t.version = 2;
  t.has_hash = true;
  t.hash = kHashP;
  t.has_format = true;
  t.format = "RGBA8";
  t.width = 8;
  t.height = 8;
  t.mipmaps = true;
  t.payload_bytes = 447;
  return t;
}

inline TextureEntry texture_f_ok() {
  TextureEntry t;
  t.id = 5;
  t.kind = TextureKind::Image;
  t.version = 1;
  t.has_hash = true;
  t.hash = kHashF;
  t.has_format = true;
  t.format = "LA8";
  t.width = 4;
  t.height = 4;
  t.payload_bytes = 137;
  return t;
}

inline TextureEntry texture_f_freed() {
  TextureEntry t;
  t.id = 5;
  t.kind = TextureKind::Image;
  t.status = TextureStatus::Freed;
  t.version = 1;  // version unchanged while freed with a surviving reference
  return t;
}

inline TextureEntry texture_n() {
  TextureEntry t;
  t.id = 6;
  t.kind = TextureKind::Image;
  t.version = 1;
  t.has_hash = true;
  t.hash = kHashA1;
  t.has_format = true;
  t.format = "RGBA8";
  t.width = 16;
  t.height = 16;
  t.payload_bytes = 1135;  // the whole GRT1 payload (render-stream-2.md "Texture")
  return t;
}

// --- the six states -------------------------------------------------------------------------

inline Snapshot state(int n) {
  Snapshot s;
  s.seq = static_cast<std::uint64_t>(n);
  s.frame = static_cast<std::uint64_t>(n);
  s.unsupported = kBaseUnsupported;
  s.default_texture_repeat = Repeat::Disabled;
  switch (n) {
  case 1:
    s.canvases = {root_canvas({1, 2, 3, 4, 5})};
    s.items = {item1_v1(), item2(), item3(), item4_v1(), item5()};
    s.textures = {texture_a(1, kHashA1), texture_atwin(), texture_u(), texture_p_placeholder(),
                  texture_f_ok()};
    s.default_texture_filter = Filter::Nearest;
    break;
  case 2:
    s.canvases = {root_canvas({1, 2, 3, 4, 5})};
    s.items = {item1_v2(), item2(), item3(), item4_v1(), item5()};
    s.textures = {texture_a(1, kHashA1), texture_atwin(), texture_u(), texture_p_placeholder(),
                  texture_f_ok()};
    s.default_texture_filter = Filter::Nearest;
    break;
  case 3:
    s.canvases = {root_canvas({1, 2, 3, 4, 5})};
    s.items = {item1_v2(), item2(), item3(), item4_v1(), item5()};
    s.textures = {texture_a(2, kHashA2), texture_atwin(), texture_u(), texture_p_placeholder(),
                  texture_f_ok()};
    s.default_texture_filter = Filter::Nearest;
    break;
  case 4:
    s.canvases = {root_canvas({1, 2, 3, 4, 5})};
    s.items = {item1_v2(), item2(), item3(), item4_v1(), item5()};
    s.textures = {texture_a(2, kHashA2), texture_atwin(), texture_u(), texture_p_replaced(),
                  texture_f_freed(), texture_n()};
    s.default_texture_filter = Filter::Linear;
    break;
  case 5:
    s.canvases = {root_canvas({1, 2, 3, 4, 5})};
    s.items = {item1_v2(), item2(), item3(), item4_v2(), item5()};
    s.textures = {texture_a(2, kHashA2), texture_atwin(), texture_u(), texture_p_replaced(),
                  texture_n()};
    s.default_texture_filter = Filter::Linear;
    break;
  case 6:
    s.canvases = {root_canvas({1, 2, 3, 4, 5})};
    s.items = {item1_v2(), item2(), item3(), item4_v2(), item5()};
    s.textures = {texture_a(2, kHashA2), texture_atwin(), texture_u(), texture_p_replaced(),
                  texture_n()};
    s.default_texture_filter = Filter::Linear;
    break;
  default:
    break;
  }
  return s;
}

}  // namespace golden
}  // namespace rs2
}  // namespace grc

#endif  // GRC_RS2_GOLDEN_STATES_H
