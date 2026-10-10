// Test-only ground truth for protocol/golden-2/{full,patch,inline}.rs2 and resolved.json, hand-
// transcribed from protocol/golden-2/make_golden.py's states 1-6 (see that file's module
// docstring for the six-step scenario). Shared by rs2_codec_test.cpp (which builds Transactions
// directly, bypassing rs2_diff) and rs2_diff_test.cpp (which builds these Snapshots and derives
// Transactions through make_full()/make_patch()), mirroring rs1_golden_states.h's role at /1.
//
// state(7) and its helpers (below the six /2 states) are new at G4e1: the ground truth for
// protocol/golden-3/{full,patch,inline}.rs3's seventh transaction, hand-transcribed from
// protocol/golden-3/make_golden.py's state7() -- state(6) plus one new item (6) drawing three
// add_msdf_texture_rect_region commands against one new texture (7, "the page"). Shared by
// rs3_codec_test.cpp the same way the six base states are shared by rs2_codec_test.cpp.
//
// state(8)..state(11) and their helpers are new at G5w: the ground truth for protocol/golden-4/
// {full,patch,inline}.rs4's eighth through eleventh transactions, hand-transcribed from
// protocol/golden-4/make_golden.py's state8()..state11(). As built (G5w): gate5-design.md's Q4
// describes three new states (8, 9, 10); this splits the "mesh version change with no item
// change" proof point into its own state (10) so it is never conflated with another mesh
// becoming "freed" or "unsupported" in the same transaction, and moves that content to a fourth
// new state (11). Shared by rs4_codec_test.cpp the same way state(7) is shared by
// rs3_codec_test.cpp.
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
    "canvas_item_add_clip_ignore",
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
    "canvas_item_set_visibility_notifier",
    "canvas_set_modulate",
    "canvas_texture_set_shading_parameters",
    "texture_set_size_override",
    "viewport_remove_canvas",
    "viewport_set_canvas_cull_mask",
    "viewport_set_global_canvas_transform"};

inline const std::vector<std::string> kPermittedFormats = {"L8", "LA8", "R8", "RG8", "RGB8", "RGBA8"};

// new at /3 (render-stream-3.md "Features"): kFeatureOps plus add_msdf_texture_rect_region, and
// kFeatureObservedUnsupported without it, both re-sorted ascending by byte value.
// canvas_item_add_clip_ignore (gate3-design.md D4, calibrator 6) stays refused at /3 too.
inline const std::vector<std::string> kFeatureOpsV3 = {
    "add_msdf_texture_rect_region", "add_rect", "add_texture_rect", "add_texture_rect_region"};

inline const std::vector<std::string> kFeatureObservedUnsupportedV3 = {
    "canvas_item_add_circle",
    "canvas_item_add_clip_ignore",
    "canvas_item_add_lcd_texture_rect_region",
    "canvas_item_add_line",
    "canvas_item_add_mesh",
    "canvas_item_add_multimesh",
    "canvas_item_add_nine_patch",
    "canvas_item_add_polygon",
    "canvas_item_add_polyline",
    "canvas_item_add_primitive",
    "canvas_item_add_set_transform",
    "canvas_item_add_triangle_array",
    "canvas_item_set_material"};

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

// new at /3 (G4e1): golden_session() with Session::version flipped to V3 and the two features
// lists /3 changes (render-stream-3.md "Features").
inline Session golden_session_v3(Encoding stream_encoding, const std::string &stream_id,
                                  const std::string &session_id, Delivery delivery) {
  Session session = golden_session(stream_encoding, stream_id, session_id, delivery);
  session.version = ProtocolVersion::V3;
  session.features.ops = kFeatureOpsV3;
  session.features.observed_unsupported_ops = kFeatureObservedUnsupportedV3;
  return session;
}

// new at /4 (G5w, render-stream-4.md "Features"): the fifteen ops, the six still-refused
// calibrator-7 slots, "mesh" added to resources, and the two viewport snap settings added to
// unobserved.
inline const std::vector<std::string> kFeatureOpsV4 = {
    "add_circle", "add_clip_ignore", "add_line", "add_mesh", "add_msdf_texture_rect_region",
    "add_multiline", "add_nine_patch", "add_polygon", "add_polyline", "add_primitive", "add_rect",
    "add_set_transform", "add_texture_rect", "add_texture_rect_region", "add_triangle_array"};

inline const std::vector<std::string> kFeatureObservedUnsupportedV4 = {
    "canvas_item_add_animation_slice", "canvas_item_add_lcd_texture_rect_region",
    "canvas_item_add_multimesh", "canvas_item_add_particles", "canvas_item_attach_skeleton",
    "canvas_item_set_material"};

inline const std::vector<std::string> kFeatureResourcesV4 = {"mesh", "texture_2d",
                                                               "texture_2d_placeholder"};

inline const std::vector<std::string> kFeatureUnobservedV4 = {
    "canvas_item_set_canvas_group_mode", "canvas_item_set_instance_shader_parameter",
    "canvas_item_set_light_mask", "canvas_item_set_sort_children_by_y",
    "canvas_item_set_visibility_notifier", "canvas_set_modulate",
    "canvas_texture_set_shading_parameters", "texture_set_size_override",
    "viewport_remove_canvas", "viewport_set_canvas_cull_mask",
    "viewport_set_global_canvas_transform", "viewport_set_snap_2d_transforms_to_pixel",
    "viewport_set_snap_2d_vertices_to_pixel"};

inline Session golden_session_v4(Encoding stream_encoding, const std::string &stream_id,
                                  const std::string &session_id, Delivery delivery) {
  Session session = golden_session(stream_encoding, stream_id, session_id, delivery);
  session.version = ProtocolVersion::V4;
  session.features.ops = kFeatureOpsV4;
  session.features.resources = kFeatureResourcesV4;
  session.features.observed_unsupported_ops = kFeatureObservedUnsupportedV4;
  session.features.unobserved = kFeatureUnobservedV4;
  return session;
}

// new at /5 (G55w, render-stream-5.md "Session"): the fifteen ops unchanged; item_state gains
// instance_params/material/use_parent_material; a new canvas_state key; resources gains
// material/shader; observed_unsupported_ops loses canvas_item_set_material (now item state, never
// unsupported-state at /5) and gains canvas_light_attach_to_canvas; unobserved loses
// canvas_item_set_instance_shader_parameter and canvas_set_modulate (now observed item/canvas
// state) and gains D16's five newly-declared-unobserved names; five new hooks (shader_create,
// shader_set_default_texture_parameter, material_create, material_create_from_shader,
// material_set_shader), calibrator version 8.
inline const std::vector<std::string> kHooksPlannedV5 = {
    "canvas_create", "canvas_item_add_circle", "canvas_item_add_line", "canvas_item_add_mesh",
    "canvas_item_add_msdf_texture_rect_region", "canvas_item_add_multimesh",
    "canvas_item_add_nine_patch", "canvas_item_add_polygon", "canvas_item_add_polyline",
    "canvas_item_add_primitive", "canvas_item_add_rect", "canvas_item_add_set_transform",
    "canvas_item_add_texture_rect", "canvas_item_add_texture_rect_region",
    "canvas_item_add_triangle_array", "canvas_item_clear", "canvas_item_create",
    "canvas_item_set_clip", "canvas_item_set_custom_rect", "canvas_item_set_draw_index",
    "canvas_item_set_material", "canvas_item_set_modulate", "canvas_item_set_parent",
    "canvas_item_set_self_modulate", "canvas_item_set_transform",
    "canvas_item_set_visibility_layer", "canvas_item_set_visible", "canvas_item_set_z_index",
    "free", "material_create", "material_create_from_shader", "material_set_param",
    "material_set_shader", "mesh_add_surface", "mesh_clear", "mesh_create",
    "mesh_set_custom_aabb", "mesh_surface_update_attribute_region",
    "mesh_surface_update_vertex_region", "shader_create", "shader_create_from_code",
    "shader_set_code", "shader_set_default_texture_parameter", "texture_2d_create",
    "texture_2d_update", "viewport_attach_canvas", "viewport_set_canvas_transform"};

inline const std::vector<std::string> kFeatureItemStateV5 = {
    "behind", "children", "clip", "custom_rect", "draw_index", "instance_params", "material",
    "modulate", "parent", "self_modulate", "texture_filter", "texture_repeat", "transform",
    "use_parent_material", "visibility_layer", "visible", "z_index", "z_relative"};

inline const std::vector<std::string> kFeatureCanvasStateV5 = {"modulate", "transform"};

inline const std::vector<std::string> kFeatureResourcesV5 = {
    "material", "mesh", "shader", "texture_2d", "texture_2d_placeholder"};

inline const std::vector<std::string> kFeatureObservedUnsupportedV5 = {
    "canvas_item_add_animation_slice", "canvas_item_add_lcd_texture_rect_region",
    "canvas_item_add_multimesh", "canvas_item_add_particles", "canvas_item_attach_skeleton",
    "canvas_light_attach_to_canvas"};

inline const std::vector<std::string> kFeatureUnobservedV5 = {
    "canvas_item_set_canvas_group_mode", "canvas_item_set_copy_to_backbuffer",
    "canvas_item_set_light_mask", "canvas_item_set_sort_children_by_y",
    "canvas_item_set_visibility_notifier", "canvas_texture_set_shading_parameters",
    "global_shader_parameter_add", "global_shader_parameter_remove",
    "global_shader_parameter_set", "global_shader_parameter_set_override",
    "material_set_next_pass", "material_set_render_priority", "shader_set_path_hint",
    "texture_set_size_override", "viewport_remove_canvas", "viewport_set_canvas_cull_mask",
    "viewport_set_global_canvas_transform", "viewport_set_snap_2d_transforms_to_pixel",
    "viewport_set_snap_2d_vertices_to_pixel"};

inline Session golden_session_v5(Encoding stream_encoding, const std::string &stream_id,
                                  const std::string &session_id, Delivery delivery) {
  Session session = golden_session(stream_encoding, stream_id, session_id, delivery);
  session.version = ProtocolVersion::V5;
  session.capture.calibrator_version = 8;
  session.capture.hooks_planned = kHooksPlannedV5;
  session.features.ops = kFeatureOpsV4;
  session.features.item_state = kFeatureItemStateV5;
  session.features.canvas_state = kFeatureCanvasStateV5;
  session.features.resources = kFeatureResourcesV5;
  session.features.observed_unsupported_ops = kFeatureObservedUnsupportedV5;
  session.features.unobserved = kFeatureUnobservedV5;
  session.materials.shader_policy = ShaderPolicy::Source;
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

// new at /3 (render-stream-3.md "Command"): rect/src/modulate as add_texture_rect_region, plus
// the engine's int outline_size, px_range and size/msdf_size scale.
inline Command add_msdf_texture_rect_region(bool has_tex, std::uint32_t tex, std::int32_t outline,
                                             Rect4 rect, Rect4 src, float px_range, float scale,
                                             Color4 modulate = kWhite) {
  Command c;
  c.kind = CommandKind::AddMsdfTextureRectRegion;
  c.has_tex = has_tex;
  c.tex = tex;
  c.msdf_outline = outline;
  c.rect = rect;
  c.src = src;
  c.modulate = modulate;
  c.msdf_px_range = px_range;
  c.msdf_scale = scale;
  return c;
}

// --- new at /4 (G5w, render-stream-4.md "Command"): the eleven new command builders ----------

inline Command add_line(Point2 from, Point2 to, Color4 color, float width, bool aa = false) {
  Command c;
  c.kind = CommandKind::AddLine;
  c.antialiased = aa;
  c.line_from = from;
  c.line_to = to;
  c.color = color;
  c.width = width;
  return c;
}

inline Command add_polyline(std::vector<Point2> points, std::vector<Color4> colors, float width,
                             bool aa = false, bool multiline = false) {
  Command c;
  c.kind = multiline ? CommandKind::AddMultiline : CommandKind::AddPolyline;
  c.antialiased = aa;
  c.points = std::move(points);
  c.colors = std::move(colors);
  c.width = width;
  return c;
}

inline Command add_circle(Point2 position, float radius, Color4 color, bool aa = false) {
  Command c;
  c.kind = CommandKind::AddCircle;
  c.antialiased = aa;
  c.circle_position = position;
  c.circle_radius = radius;
  c.color = color;
  return c;
}

inline Command add_primitive(std::vector<Point2> points, std::vector<Color4> colors,
                              std::vector<Point2> uvs, bool has_tex = false,
                              std::uint32_t tex = 0, bool polygon = false) {
  Command c;
  c.kind = polygon ? CommandKind::AddPolygon : CommandKind::AddPrimitive;
  c.has_tex = has_tex;
  c.tex = tex;
  c.points = std::move(points);
  c.colors = std::move(colors);
  c.uvs = std::move(uvs);
  return c;
}

inline Command add_triangle_array(std::vector<Point2> points, std::vector<Color4> colors,
                                   std::vector<Point2> uvs, std::vector<std::int32_t> indices,
                                   std::int32_t count, bool has_tex = false,
                                   std::uint32_t tex = 0) {
  Command c;
  c.kind = CommandKind::AddTriangleArray;
  c.has_tex = has_tex;
  c.tex = tex;
  c.points = std::move(points);
  c.colors = std::move(colors);
  c.uvs = std::move(uvs);
  c.indices = std::move(indices);
  c.triangle_count = count;
  return c;
}

inline Command add_nine_patch(Rect4 rect, Rect4 source, Point2 margin_tl, Point2 margin_br,
                                AxisStretchMode x_axis, AxisStretchMode y_axis, bool draw_center,
                                bool has_tex, std::uint32_t tex, Color4 modulate = kWhite) {
  Command c;
  c.kind = CommandKind::AddNinePatch;
  c.has_tex = has_tex;
  c.tex = tex;
  c.rect = rect;
  c.src = source;
  c.np_margin_tl = margin_tl;
  c.np_margin_br = margin_br;
  c.x_axis = x_axis;
  c.y_axis = y_axis;
  c.draw_center = draw_center;
  c.modulate = modulate;
  return c;
}

inline Command add_mesh(std::uint32_t mesh_id, Xform transform, bool has_tex = false,
                         std::uint32_t tex = 0, Color4 modulate = kWhite) {
  Command c;
  c.kind = CommandKind::AddMesh;
  c.mesh = mesh_id;
  c.has_tex = has_tex;
  c.tex = tex;
  c.transform = transform;
  c.modulate = modulate;
  return c;
}

inline Command add_set_transform(Xform transform) {
  Command c;
  c.kind = CommandKind::AddSetTransform;
  c.transform = transform;
  return c;
}

inline Command add_clip_ignore(bool ignore) {
  Command c;
  c.kind = CommandKind::AddClipIgnore;
  c.clip_ignore = ignore;
  return c;
}

inline MeshSurface mesh_surface(std::string hash, std::uint64_t payload_bytes,
                                 Primitive primitive, std::int64_t format,
                                 std::int32_t vertex_count, std::int32_t index_count) {
  MeshSurface s;
  s.hash = std::move(hash);
  s.payload_bytes = payload_bytes;
  s.primitive = primitive;
  s.format = format;
  s.vertex_count = vertex_count;
  s.index_count = index_count;
  return s;
}

inline MeshEntry mesh_entry(MeshStatus status, std::uint64_t version,
                             std::vector<MeshSurface> surfaces = {}, bool has_reason = false,
                             MeshReason reason = MeshReason::MeshFormat) {
  MeshEntry m;
  m.status = status;
  m.has_reason = has_reason;
  m.reason = reason;
  m.version = version;
  m.has_aabb = status != MeshStatus::Freed;
  m.custom_aabb = {0.0f, 0.0f, 0.0f, 0.0f, 0.0f, 0.0f};
  m.surfaces = std::move(surfaces);
  return m;
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

// new at /3, state 7: item 6's third msdf command names an RID the capture never saw
// (render-stream-3.md "Command": unsupported/unknown-texture, as for the other texture commands).
inline const UnsupportedRef kUnsupportedMsdfItem6 = []() {
  UnsupportedRef u;
  u.op = "canvas_item_add_msdf_texture_rect_region";
  u.has_item = true;
  u.item = 6;
  u.reason = UnsupportedReason::UnknownTexture;
  return u;
}();

inline const std::vector<UnsupportedRef> kState7Unsupported = {kUnsupportedItem3, kUnsupportedTextureItem5,
                                                                 kUnsupportedMsdfItem6};

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

// --- item 6 and texture 7 ("the page"), new at /3's state 7 --------------------------------

// payload_sha256() of protocol/golden-3/payloads/page.grt (make_golden.py HASH_PAGE): a 16x16
// RGBA8 quadrant image -- a stand-in; the real atlas is 512x512 at msdf_size 48 (gate4-design.md
// D5), but a codec-level golden only needs to exercise the wire shape, and 512x512 bloated
// golden-3/ to 4.9 MB against golden-2's 0.8 MB (amended, "As built").
inline const std::string kHashPage =
    "6d5f7f065ce133348fc1ebbd94ff4ab2dd51dd36fc5a2b8209a073126dcc2437";

inline ItemState item6_msdf() {
  ItemState it;
  it.id = 6;
  it.parent = ParentRef{ParentKind::Canvas, 1};
  it.xform = {1.0f, 0.0f, 0.0f, 1.0f, 100.0f, 0.0f};
  it.draw_index = 5;
  it.content_version = 1;
  it.commands = {
      add_msdf_texture_rect_region(true, 7, 0, {100.0f, 0.0f, 24.0f, 24.0f},
                                    {0.0f, 0.0f, 48.0f, 48.0f}, 24.0f, 0.5f),
      add_msdf_texture_rect_region(true, 7, 4, {140.0f, 0.0f, -24.0f, 24.0f},
                                    {48.0f, 0.0f, 48.0f, 48.0f}, 24.0f, 0.5f),
      unsupported_cmd("canvas_item_add_msdf_texture_rect_region", UnsupportedCmdReason::UnknownTexture),
  };
  return it;
}

inline TextureEntry texture_page() {
  TextureEntry t;
  t.id = 7;
  t.kind = TextureKind::Image;
  t.version = 1;
  t.has_hash = true;
  t.hash = kHashPage;
  t.has_format = true;
  t.format = "RGBA8";
  t.width = 16;
  t.height = 16;
  t.payload_bytes = 1135;  // the whole GRT1 payload (render-stream-2.md "Texture")
  return t;
}

// --- item 7 and state 8, new at /4 (G5w): one of every new immediate op --------------------

// ARRAY_FORMAT_*/ARRAY_FLAG_* bits this test needs (gate5-design.md Q1e; render-stream-4.md
// "Mesh payload"), carried as plain ints, never as a Mesh.ArrayFormat enum.
inline constexpr std::int64_t kArrayFormatColor = 1 << 3;
inline constexpr std::int64_t kArrayFormatTexUv = 1 << 4;
inline constexpr std::int64_t kArrayFormatIndex = 1 << 12;
inline constexpr std::int64_t kArrayFlagUse2dVertices = static_cast<std::int64_t>(1) << 25;
inline constexpr std::int64_t kArrayFlagCompressAttributes = static_cast<std::int64_t>(1) << 29;

inline ItemState item7_immediate_ops() {
  ItemState it;
  it.id = 7;
  it.parent = ParentRef{ParentKind::Canvas, 1};
  it.xform = {1.0f, 0.0f, 0.0f, 1.0f, 120.0f, 0.0f};
  it.draw_index = 6;
  it.content_version = 1;
  it.commands = {
      add_line({0.0f, 0.0f}, {10.0f, 0.0f}, kWhite, 1.0f),
      add_polyline({{0.0f, 10.0f}, {10.0f, 10.0f}, {10.0f, 20.0f}, {0.0f, 20.0f}},
                   {{1.0f, 0.0f, 0.0f, 1.0f}, {0.0f, 1.0f, 0.0f, 1.0f}}, 2.0f),
      add_polyline({{0.0f, 30.0f}, {10.0f, 30.0f}, {0.0f, 40.0f}, {10.0f, 40.0f}},
                   {{0.25f, 0.25f, 1.0f, 1.0f}}, 1.0f, false, true),
      add_circle({5.0f, 50.0f}, 4.0f, {0.25f, 0.75f, 1.0f, 1.0f}, true),
      add_primitive({{0.0f, 60.0f}, {10.0f, 60.0f}, {0.0f, 70.0f}}, {{1.0f, 1.0f, 0.25f, 1.0f}},
                    {}),
      add_primitive({{0.0f, 80.0f}, {10.0f, 80.0f}, {10.0f, 90.0f}, {0.0f, 90.0f}},
                    {{1.0f, 1.0f, 1.0f, 1.0f}},
                    {{0.0f, 0.0f}, {1.0f, 0.0f}, {1.0f, 1.0f}, {0.0f, 1.0f}}, true, 7, true),
      add_triangle_array({{0.0f, 100.0f}, {10.0f, 100.0f}, {10.0f, 110.0f}, {0.0f, 110.0f}},
                         {{0.75f, 1.0f, 0.75f, 1.0f}}, {}, {0, 1, 2, 0, 2, 3}, 3),
      add_set_transform({1.0f, 0.0f, 0.0f, 1.0f, 2.0f, 2.0f}),
      add_nine_patch({0.0f, 120.0f, 16.0f, 16.0f}, {0.0f, 0.0f, 16.0f, 16.0f}, {4.0f, 4.0f},
                     {4.0f, 4.0f}, AxisStretchMode::TileFit, AxisStretchMode::TileFit, true, true,
                     7),
      add_clip_ignore(true),
      add_clip_ignore(false),
  };
  return it;
}

// --- item 8/9/10, meshes 1/2/3 and states 9-11, new at /4 (G5w) -----------------------------

// payload_sha256() of protocol/golden-4/payloads/mesh1-{a,b}.grm and mesh2-v{1,2}.grm
// (make_golden.py HASH_MESH1_A/B, HASH_MESH2_V1/V2).
inline const std::string kHashMesh1A =
    "42532dc3a4f775e3426da84ca155a52da8b598594a396e68f364e1b220aa933a";
inline const std::string kHashMesh1B =
    "4353a1d85e83235c0041d2563ae73b0e54dfe6f37f7a859a5acb88aedae49474";
inline const std::string kHashMesh2V1 =
    "62c07418eb102e442122992cdacefc057a530ee24bb47e3ea3034bd7c75f387a";
inline const std::string kHashMesh2V2 =
    "1c68b94d68817069d53580212d0fcceac80eec854e5d1bd6399b9b7160e98bbc";

inline constexpr std::int64_t kMesh1SurfaceAFormat = kArrayFormatColor | kArrayFlagUse2dVertices;
inline constexpr std::int64_t kMesh1SurfaceBFormat =
    kArrayFormatTexUv | kArrayFormatIndex | kArrayFlagUse2dVertices;
inline constexpr std::int64_t kMesh2SurfaceFormat =
    kArrayFormatColor | kArrayFormatIndex | kArrayFlagUse2dVertices;

inline ItemState item8_mesh() {
  ItemState it;
  it.id = 8;
  it.parent = ParentRef{ParentKind::Canvas, 1};
  it.xform = {1.0f, 0.0f, 0.0f, 1.0f, 140.0f, 0.0f};
  it.draw_index = 7;
  it.content_version = 1;
  it.commands = {add_mesh(1, kIdentityXform, true, 7)};
  return it;
}

inline ItemState item9_unsupported_mesh() {
  ItemState it;
  it.id = 9;
  it.parent = ParentRef{ParentKind::Canvas, 1};
  it.xform = {1.0f, 0.0f, 0.0f, 1.0f, 160.0f, 0.0f};
  it.draw_index = 8;
  it.content_version = 1;
  it.commands = {add_mesh(3, kIdentityXform)};
  return it;
}

inline ItemState item10_unknown_mesh() {
  ItemState it;
  it.id = 10;
  it.parent = ParentRef{ParentKind::Canvas, 1};
  it.xform = {1.0f, 0.0f, 0.0f, 1.0f, 180.0f, 0.0f};
  it.draw_index = 9;
  it.content_version = 1;
  it.commands = {unsupported_cmd("canvas_item_add_mesh", UnsupportedCmdReason::UnknownMesh)};
  return it;
}

inline const UnsupportedRef kUnsupportedMeshItem9 = []() {
  UnsupportedRef u;
  u.op = "canvas_item_add_mesh";
  u.has_item = true;
  u.item = 9;
  u.reason = UnsupportedReason::UnsupportedMesh;
  return u;
}();

inline const UnsupportedRef kUnsupportedUnknownMeshItem10 = []() {
  UnsupportedRef u;
  u.op = "canvas_item_add_mesh";
  u.has_item = true;
  u.item = 10;
  u.reason = UnsupportedReason::UnknownMesh;
  return u;
}();

// Sorted ascending by (item, op), matching validateRecording()'s unsupported[] ordering rule.
inline const std::vector<UnsupportedRef> kState11Unsupported = {
    kUnsupportedItem3, kUnsupportedTextureItem5, kUnsupportedMsdfItem6, kUnsupportedMeshItem9,
    kUnsupportedUnknownMeshItem10};

// --- new at /5 (G55w): shaders, materials, canvas modulate, item material state ---------------
// Ground truth for protocol/golden-5/{full,patch,inline}.rs5's twelfth through fifteenth
// transactions, hand-transcribed from protocol/golden-5/make_golden.py's state12()..state15().
// Shared by rs5_codec_test.cpp the same way state(8) is shared by rs4_codec_test.cpp. Param "f"
// offsets are never transcribed by hand: encode_transaction()'s append_material_entry()/
// append_param_entry() compute them automatically from table/item order, exactly as
// make_golden.py's _material_json()/_param_json() do (memory: g4e1-rs3-version-switch-pattern,
// "verify golden vector values by actually decoding").

inline Param make_param(std::string name, VariantType type, std::vector<double> floats,
                         std::int32_t n = 1, bool has_tex = false, std::uint32_t tex = 0) {
  Param p;
  p.name = std::move(name);
  p.type = type;
  p.n = n;
  p.has_tex = has_tex;
  p.tex = tex;
  p.floats = std::move(floats);
  return p;
}

inline BuiltinCanvasItemMaterial builtin_cim(BlendMode blend_mode,
                                              LightMode light_mode = LightMode::Normal,
                                              bool particles_animation = false) {
  BuiltinCanvasItemMaterial b;
  b.blend_mode = blend_mode;
  b.light_mode = light_mode;
  b.particles_animation = particles_animation;
  return b;
}

inline ShaderEntry shader_entry(ShaderStatus status, std::uint64_t version, std::string hash,
                                 std::uint64_t payload_bytes, bool has_reason = false,
                                 ShaderReason reason = ShaderReason::ShaderMode,
                                 bool has_builtin = false,
                                 BuiltinCanvasItemMaterial builtin = BuiltinCanvasItemMaterial{},
                                 std::vector<ShaderUse> uses = {}) {
  ShaderEntry s;
  s.status = status;
  s.has_reason = has_reason;
  s.reason = reason;
  s.version = version;
  s.has_mode = true;
  s.mode = ShaderMode::CanvasItem;
  s.has_source = true;
  s.source = ShaderSource::Payload;
  s.has_hash = true;
  s.hash = std::move(hash);
  s.payload_bytes = payload_bytes;
  s.has_builtin = has_builtin;
  s.builtin = builtin;
  s.uses = std::move(uses);
  return s;
}

inline MaterialEntry material_entry(MaterialStatus status, std::uint64_t version, bool has_shader,
                                     std::uint32_t shader, std::vector<Param> params,
                                     bool has_reason = false,
                                     MaterialReason reason = MaterialReason::UnknownShader) {
  MaterialEntry m;
  m.status = status;
  m.has_reason = has_reason;
  m.reason = reason;
  m.version = version;
  m.has_shader = has_shader;
  m.shader = shader;
  m.params = std::move(params);
  return m;
}

// Shader 1: the builtin CanvasItemMaterial "add" blend template (gate5_5-design.md Q1e), payload
// sha256 of protocol/golden-5/payloads/shader1-add.grp (make_golden.py HASH_SHADER1).
inline const std::string kHashShader1 =
    "a8a44694faba8c68274a255d14ebf9a300a51baaa4c15e338ad10df6a58bcd17";
inline constexpr std::uint64_t kShader1PayloadBytes = 203;
// Shader 2 (custom "source" shader, material 2's), version 1 then 2 (state 14's code change).
inline const std::string kHashShader2V1 =
    "2c874800cd97ba181708fd009b2ec9ab5c49e666c285a39427cf5f8ccf761310";
inline constexpr std::uint64_t kShader2V1PayloadBytes = 157;
inline const std::string kHashShader2V2 =
    "586e44786613868036df5a0a72e1c2a512397d6300502e87d927be6ff7329dbe";
inline constexpr std::uint64_t kShader2V2PayloadBytes = 163;
// Shader 3, state 15: uses TIME (gate5_5-design.md D11 -> shader-time).
inline const std::string kHashShader3 =
    "f50e1b48065c02d118f568210a9bb22b6923f89b2810db7d041ffc9da440394c";
inline constexpr std::uint64_t kShader3PayloadBytes = 131;

// Material 1: the builtin CIM's own three params (gate5_5-design.md Q1a), sorted by name.
inline std::vector<Param> material1_params() {
  return {
      make_param("particles_anim_h_frames", VariantType::Int, {1.0}),
      make_param("particles_anim_loop", VariantType::Bool, {0.0}),
      make_param("particles_anim_v_frames", VariantType::Int, {1.0}),
  };
}

// Material 2: one param of EVERY supported Variant type (gate5_5-design.md D8), sorted by name.
// p_rid names texture 7 ("the page"), already present in the resolved table from state 7 on.
inline std::vector<Param> material2_params_v1() {
  return {
      make_param("p_aabb", VariantType::Aabb, {1.0, 2.0, 3.0, 4.0, 5.0, 6.0}),
      make_param("p_basis", VariantType::Basis, {1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0}),
      make_param("p_bool", VariantType::Bool, {1.0}),
      make_param("p_color", VariantType::Color, {0.2, 0.4, 0.6, 1.0}),
      make_param("p_float", VariantType::Float, {2.5}),
      make_param("p_int", VariantType::Int, {7.0}),
      make_param("p_nil", VariantType::Nil, {}),
      make_param("p_packed_color_array", VariantType::PackedColorArray,
                 {0.0, 0.0, 0.0, 1.0, 1.0, 1.0, 1.0, 1.0}, 2),
      make_param("p_packed_float32_array", VariantType::PackedFloat32Array, {0.1, 0.2, 0.3}, 3),
      make_param("p_packed_float64_array", VariantType::PackedFloat64Array, {1.5, -1.5}, 2),
      make_param("p_packed_int32_array", VariantType::PackedInt32Array, {1.0, 2.0, 3.0}, 3),
      make_param("p_packed_int64_array", VariantType::PackedInt64Array, {100.0, 200.0}, 2),
      make_param("p_packed_vector2_array", VariantType::PackedVector2Array,
                 {1.0, 2.0, 3.0, 4.0}, 2),
      make_param("p_packed_vector3_array", VariantType::PackedVector3Array,
                 {1.0, 2.0, 3.0, 4.0, 5.0, 6.0}, 2),
      make_param("p_packed_vector4_array", VariantType::PackedVector4Array,
                 {1.0, 2.0, 3.0, 4.0}, 1),
      make_param("p_plane", VariantType::Plane, {0.0, 0.0, 1.0, 5.0}),
      make_param("p_projection", VariantType::Projection,
                 {1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0}),
      make_param("p_quaternion", VariantType::Quaternion, {0.0, 0.0, 0.0, 1.0}),
      make_param("p_rect2", VariantType::Rect2, {1.0, 2.0, 3.0, 4.0}),
      make_param("p_rect2i", VariantType::Rect2i, {0.0, 0.0, 8.0, 8.0}),
      make_param("p_rid", VariantType::Rid, {}, 1, true, 7),
      make_param("p_transform2d", VariantType::Transform2D, {1.0, 0.0, 0.0, 1.0, 0.0, 0.0}),
      make_param("p_transform3d", VariantType::Transform3D,
                 {1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0}),
      make_param("p_vector2", VariantType::Vector2, {1.0, 2.0}),
      make_param("p_vector2i", VariantType::Vector2i, {3.0, 4.0}),
      make_param("p_vector3", VariantType::Vector3, {1.0, 2.0, 3.0}),
      make_param("p_vector3i", VariantType::Vector3i, {4.0, 5.0, 6.0}),
      make_param("p_vector4", VariantType::Vector4, {1.0, 2.0, 3.0, 4.0}),
      make_param("p_vector4i", VariantType::Vector4i, {5.0, 6.0, 7.0, 8.0}),
  };
}

// state 13: ONE parameter change on material 2 (p_float 2.5 -> 9.5).
inline std::vector<Param> material2_params_v2() {
  std::vector<Param> params = material2_params_v1();
  for (Param &p : params) {
    if (p.name == "p_float") {
      p.floats = {9.5};
    }
  }
  return params;
}

inline Xform kItem11Xform() { return {1.0f, 0.0f, 0.0f, 1.0f, 200.0f, 0.0f}; }

inline ItemState item11_cim_material() {
  ItemState it;
  it.id = 11;
  it.parent = ParentRef{ParentKind::Canvas, 1};
  it.xform = kItem11Xform();
  it.draw_index = 10;
  it.content_version = 1;
  it.commands = {add_rect({0.0f, 0.0f, 16.0f, 16.0f}, {0.25f, 0.75f, 0.25f, 1.0f})};
  it.has_material = true;
  it.material = 1;
  return it;
}

inline ItemState item12_custom_material() {
  ItemState it;
  it.id = 12;
  it.parent = ParentRef{ParentKind::Canvas, 1};
  it.xform = {1.0f, 0.0f, 0.0f, 1.0f, 220.0f, 0.0f};
  it.draw_index = 11;
  it.content_version = 1;
  it.commands = {add_rect({0.0f, 0.0f, 16.0f, 16.0f}, {0.25f, 0.75f, 0.5f, 1.0f})};
  it.has_material = true;
  it.material = 2;
  it.instance_params = {make_param("glow", VariantType::Float, {0.5}),
                         make_param("hidden_default", VariantType::Nil, {})};
  return it;
}

inline ItemState item13_use_parent_material() {
  ItemState it;
  it.id = 13;
  it.parent = ParentRef{ParentKind::Canvas, 1};
  it.xform = {1.0f, 0.0f, 0.0f, 1.0f, 240.0f, 0.0f};
  it.draw_index = 12;
  it.content_version = 1;
  it.commands = {add_rect({0.0f, 0.0f, 16.0f, 16.0f}, {0.75f, 0.75f, 0.75f, 1.0f})};
  it.use_parent_material = true;
  return it;
}

inline ItemState item14_null_shader_material() {
  ItemState it;
  it.id = 14;
  it.parent = ParentRef{ParentKind::Canvas, 1};
  it.xform = {1.0f, 0.0f, 0.0f, 1.0f, 260.0f, 0.0f};
  it.draw_index = 13;
  it.content_version = 1;
  it.commands = {add_rect({0.0f, 0.0f, 16.0f, 16.0f}, {0.75f, 0.75f, 0.25f, 1.0f})};
  it.has_material = true;
  it.material = 3;
  return it;
}

inline constexpr Color4 kCanvas12Modulate = {0.5f, 0.75f, 1.0f, 1.0f};

inline ItemState item15_unsupported_material() {
  ItemState it;
  it.id = 15;
  it.parent = ParentRef{ParentKind::Canvas, 1};
  it.xform = {1.0f, 0.0f, 0.0f, 1.0f, 280.0f, 0.0f};
  it.draw_index = 14;
  it.content_version = 1;
  it.commands = {add_rect({0.0f, 0.0f, 16.0f, 16.0f}, {0.25f, 0.25f, 0.25f, 1.0f})};
  it.has_material = true;
  it.material = 4;
  return it;
}

inline ItemState item16_unknown_material() {
  // gate5_5-design.md Q3b: an unknown non-null material RID -> wire "material": null, plus the
  // derived unknown-material entry.
  ItemState it;
  it.id = 16;
  it.parent = ParentRef{ParentKind::Canvas, 1};
  it.xform = {1.0f, 0.0f, 0.0f, 1.0f, 300.0f, 0.0f};
  it.draw_index = 15;
  it.content_version = 1;
  it.commands = {add_rect({0.0f, 0.0f, 16.0f, 16.0f}, {0.25f, 0.25f, 0.25f, 1.0f})};
  return it;
}

inline ItemState item17_instance_param_type() {
  // The attempted instance param had an unsupported type: nothing representable to carry, so
  // instance_params stays empty and only the derived param-type entry proves it happened.
  ItemState it;
  it.id = 17;
  it.parent = ParentRef{ParentKind::Canvas, 1};
  it.xform = {1.0f, 0.0f, 0.0f, 1.0f, 320.0f, 0.0f};
  it.draw_index = 16;
  it.content_version = 1;
  it.commands = {add_rect({0.0f, 0.0f, 16.0f, 16.0f}, {0.25f, 0.25f, 0.25f, 1.0f})};
  return it;
}

inline const UnsupportedRef kUnsupportedMaterialItem15 = []() {
  UnsupportedRef u;
  u.op = "canvas_item_set_material";
  u.has_item = true;
  u.item = 15;
  u.reason = UnsupportedReason::UnsupportedMaterial;
  return u;
}();

inline const UnsupportedRef kUnknownMaterialItem16 = []() {
  UnsupportedRef u;
  u.op = "canvas_item_set_material";
  u.has_item = true;
  u.item = 16;
  u.reason = UnsupportedReason::UnknownMaterial;
  return u;
}();

inline const UnsupportedRef kParamTypeItem17 = []() {
  UnsupportedRef u;
  u.op = "canvas_item_set_instance_shader_parameter";
  u.has_item = true;
  u.item = 17;
  u.reason = UnsupportedReason::ParamType;
  return u;
}();

// Session-level (item: null), sticky. As built (G55w): sorts FIRST among unsupported[] entries --
// every protocol version's validator already requires every session-level entry to precede
// every item-level one, so a sticky entry observed mid-stream (gate5_5-design.md D10) is still
// reported at the front, not at the position it was first observed.
inline const UnsupportedRef kCanvasLight = []() {
  UnsupportedRef u;
  u.op = "canvas_light_attach_to_canvas";
  u.has_item = false;
  u.reason = UnsupportedReason::CanvasLight;
  return u;
}();

inline const std::vector<UnsupportedRef> kState15Unsupported = []() {
  std::vector<UnsupportedRef> v = {kCanvasLight, kUnsupportedItem3, kUnsupportedTextureItem5,
                                    kUnsupportedMsdfItem6, kUnsupportedMeshItem9,
                                    kUnsupportedUnknownMeshItem10, kUnsupportedMaterialItem15,
                                    kUnknownMaterialItem16, kParamTypeItem17};
  return v;
}();

// --- the fifteen states -----------------------------------------------------------------------

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
  case 7:
    // new at /3 (render-stream-3.md, G4e1): state 6 plus item 6 (three msdf commands) and
    // texture 7 ("the page").
    s.unsupported = kState7Unsupported;
    s.canvases = {root_canvas({1, 2, 3, 4, 5, 6})};
    s.items = {item1_v2(), item2(), item3(), item4_v2(), item5(), item6_msdf()};
    s.textures = {texture_a(2, kHashA2), texture_atwin(), texture_u(), texture_p_replaced(),
                  texture_n(), texture_page()};
    s.default_texture_filter = Filter::Linear;
    break;
  case 8:
    // new at /4 (render-stream-4.md, G5w): state 7 plus item 7, one of every new immediate op.
    s.version = ProtocolVersion::V4;
    s.unsupported = kState7Unsupported;
    s.canvases = {root_canvas({1, 2, 3, 4, 5, 6, 7})};
    s.items = {item1_v2(), item2(), item3(), item4_v2(), item5(), item6_msdf(),
               item7_immediate_ops()};
    s.textures = {texture_a(2, kHashA2), texture_atwin(), texture_u(), texture_p_replaced(),
                  texture_n(), texture_page()};
    s.default_texture_filter = Filter::Linear;
    break;
  case 9:
    // new at /4: mesh 1 (two surfaces) and mesh 2 (one surface) created; item 8 draws mesh 1,
    // textured.
    s.version = ProtocolVersion::V4;
    s.unsupported = kState7Unsupported;
    s.canvases = {root_canvas({1, 2, 3, 4, 5, 6, 7, 8})};
    s.items = {item1_v2(), item2(), item3(), item4_v2(), item5(), item6_msdf(),
               item7_immediate_ops(), item8_mesh()};
    s.textures = {texture_a(2, kHashA2), texture_atwin(), texture_u(), texture_p_replaced(),
                  texture_n(), texture_page()};
    s.meshes = {
        mesh_entry(MeshStatus::Ok, 1,
                   {mesh_surface(kHashMesh1A, 256, Primitive::Triangles, kMesh1SurfaceAFormat, 3, 0),
                    mesh_surface(kHashMesh1B, 297, Primitive::Triangles, kMesh1SurfaceBFormat, 4, 6)}),
        mesh_entry(MeshStatus::Ok, 1,
                   {mesh_surface(kHashMesh2V1, 281, Primitive::Triangles, kMesh2SurfaceFormat, 4, 6)}),
    };
    s.meshes[0].id = 1;
    s.meshes[1].id = 2;
    s.default_texture_filter = Filter::Linear;
    break;
  case 10:
    // new at /4: ONLY mesh 2's surface changes (new payload, version 2). No item, canvas or
    // texture changes at all -- "a mesh version change with no item change".
    s = state(9);
    s.seq = 10;
    s.frame = 10;
    s.meshes[1] = mesh_entry(
        MeshStatus::Ok, 2,
        {mesh_surface(kHashMesh2V2, 281, Primitive::Triangles, kMesh2SurfaceFormat, 4, 6)});
    s.meshes[1].id = 2;
    break;
  case 11:
    // new at /4: mesh 1 freed (item 8 still names it: a tombstone); mesh 3 created
    // "unsupported" (mesh-format) and named by item 9 (-> unsupported-mesh); item 10 names mesh
    // id 999, which the capture never saw (-> unknown-mesh).
    s = state(10);
    s.seq = 11;
    s.frame = 11;
    s.unsupported = kState11Unsupported;
    s.canvases = {root_canvas({1, 2, 3, 4, 5, 6, 7, 8, 9, 10})};
    s.items.push_back(item9_unsupported_mesh());
    s.items.push_back(item10_unknown_mesh());
    s.meshes[0] = mesh_entry(MeshStatus::Freed, 1);
    s.meshes[0].id = 1;
    {
      MeshEntry mesh3 = mesh_entry(MeshStatus::Unsupported, 1, {}, true, MeshReason::MeshFormat);
      mesh3.id = 3;
      s.meshes.push_back(mesh3);
    }
    break;
  case 12:
    // new at /5 (G55w): state 11 plus a builtin CIM shader ("add" blend) and a custom "source"
    // shader; three materials (1: the CIM's own params; 2: every supported Variant type; 3:
    // shader null); four new items (11-14) name them. The root canvas gains a non-white modulate.
    s = state(11);
    s.seq = 12;
    s.frame = 12;
    s.version = ProtocolVersion::V5;
    s.canvases = {root_canvas({1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14})};
    s.canvases[0].modulate = kCanvas12Modulate;
    s.items.push_back(item11_cim_material());
    s.items.push_back(item12_custom_material());
    s.items.push_back(item13_use_parent_material());
    s.items.push_back(item14_null_shader_material());
    s.shaders = {
        shader_entry(ShaderStatus::Ok, 1, kHashShader1, kShader1PayloadBytes, false,
                     ShaderReason::ShaderMode, true, builtin_cim(BlendMode::Add)),
        shader_entry(ShaderStatus::Ok, 1, kHashShader2V1, kShader2V1PayloadBytes),
    };
    s.shaders[0].id = 1;
    s.shaders[1].id = 2;
    s.materials = {
        material_entry(MaterialStatus::Ok, 1, true, 1, material1_params()),
        material_entry(MaterialStatus::Ok, 1, true, 2, material2_params_v1()),
        material_entry(MaterialStatus::Ok, 1, false, 0, {}),
    };
    s.materials[0].id = 1;
    s.materials[1].id = 2;
    s.materials[2].id = 3;
    break;
  case 13:
    // new at /5: ONE parameter change on material 2 (p_float 2.5 -> 9.5) -- the patch carries
    // exactly one materials[] entry.
    s = state(12);
    s.seq = 13;
    s.frame = 13;
    s.materials[1] = material_entry(MaterialStatus::Ok, 2, true, 2, material2_params_v2());
    s.materials[1].id = 2;
    break;
  case 14:
    // new at /5: ONE shader code change on shader 2 (new hash) -- the patch carries exactly one
    // shaders[] entry.
    s = state(13);
    s.seq = 14;
    s.frame = 14;
    s.shaders[1] = shader_entry(ShaderStatus::Ok, 2, kHashShader2V2, kShader2V2PayloadBytes);
    s.shaders[1].id = 2;
    break;
  case 15:
    // new at /5: a TIME-using shader (3, unsupported/shader-time) bound to a new material (4,
    // status "ok" per D6); item 15 names it (-> unsupported-material); item 16 names an unknown
    // material (-> unknown-material); material 5 is unsupported/param-type with no shader; item
    // 17 gets an unsupported-type instance parameter (-> param-type). Plus the session-level
    // sticky canvas-light entry.
    s = state(14);
    s.seq = 15;
    s.frame = 15;
    s.canvases = {root_canvas({1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17})};
    s.canvases[0].modulate = kCanvas12Modulate;
    s.items.push_back(item15_unsupported_material());
    s.items.push_back(item16_unknown_material());
    s.items.push_back(item17_instance_param_type());
    {
      ShaderEntry shader3 = shader_entry(ShaderStatus::Unsupported, 1, kHashShader3,
                                          kShader3PayloadBytes, true, ShaderReason::ShaderTime,
                                          false, BuiltinCanvasItemMaterial{},
                                          {ShaderUse::Time});
      shader3.id = 3;
      s.shaders.push_back(shader3);
    }
    {
      MaterialEntry material4 = material_entry(MaterialStatus::Ok, 1, true, 3, {});
      material4.id = 4;
      s.materials.push_back(material4);
      MaterialEntry material5 = material_entry(MaterialStatus::Unsupported, 1, false, 0, {}, true,
                                                MaterialReason::ParamType);
      material5.id = 5;
      s.materials.push_back(material5);
    }
    s.unsupported = kState15Unsupported;
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
