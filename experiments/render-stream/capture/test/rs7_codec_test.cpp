// Unit tests for render-stream/7 (src/rs2_codec.cpp's Session::version == V7 path, G7w).
//
// render-stream/7 is implemented as a protocol-version switch inside the SAME rs2_codec module
// /2-/6 use (render-stream-7.md, following gate4-design.md G4e1's precedent and
// gate7-design.md D2), so this file does not duplicate rs2_codec_test.cpp's/rs3../rs4../rs5../
// rs6_codec_test.cpp's framing checks. Unlike those, /7 changes NOTHING about the big
// full/patch/inline state factory (gate7-design.md D2: "Records, transactions, payloads and HTTP
// routes are byte-identical to /6"), so there is no full.rs7/patch.rs7/inline.rs7 to re-derive --
// this proves only the /7 delta: Session::version == V7 selects the GRS7 magic and the
// "render-stream/7" protocol string, and the session's top-level "publication" key gains
// "credit_window" -- by matching protocol/golden-7/{rate,window2}.rs7 byte for byte (mirroring
// golden-6's own "rate" leg, which no C++ test exercised either -- only the TypeScript/GDScript
// self-tests decode an independent leg, since this file's rs2_codec.cpp has no decoder).

#include <algorithm>
#include <cstdint>
#include <cstdio>
#include <string>
#include <vector>

#include "rs2_codec.h"
#include "rs2_snapshot.h"

#ifndef GRC_GOLDEN7_DIR
#error "GRC_GOLDEN7_DIR must be defined by CMakeLists.txt"
#endif

namespace {

using namespace grc::rs2;  // NOLINT

int g_failures = 0;

void check(bool condition, const char *what) {
  if (!condition) {
    std::fprintf(stderr, "FAIL %s\n", what);
    ++g_failures;
  }
}

std::vector<std::uint8_t> read_file(const std::string &path) {
  std::FILE *file = std::fopen(path.c_str(), "rb");
  if (file == nullptr) {
    return {};
  }
  std::vector<std::uint8_t> data;
  unsigned char buf[4096];
  std::size_t n = 0;
  while ((n = std::fread(buf, 1, sizeof(buf), file)) > 0) {
    data.insert(data.end(), buf, buf + n);
  }
  std::fclose(file);
  return data;
}

void check_against_golden(const std::string &file,
                           const std::vector<std::vector<std::uint8_t>> &records) {
  const std::string golden_path = std::string(GRC_GOLDEN7_DIR) + "/" + file;
  const std::vector<std::uint8_t> expected = read_file(golden_path);
  check(!expected.empty(), ("golden-7/" + file + " is readable").c_str());

  std::size_t offset = 0;
  for (std::size_t i = 0; i < records.size(); ++i) {
    const bool in_range = offset + records[i].size() <= expected.size();
    const bool matches = in_range && std::equal(records[i].begin(), records[i].end(),
                                                  expected.begin() + static_cast<long>(offset));
    check(matches, ("record " + std::to_string(i) + " matches golden-7/" + file).c_str());
    offset += records[i].size();
  }
  check(offset == expected.size(),
        ("encoded recording is exactly golden-7/" + file + "'s length").c_str());
}

// protocol/golden-7/make_golden.py's `state`: one root canvas (id 1, items [1]) with one item
// (id 1, parented to the canvas) drawing one add_rect -- golden-6's own "rate" scene, reused
// unchanged (gate7-design.md D2: records/transactions are byte-identical to /6).
ItemState scene_item() {
  ItemState it;
  it.id = 1;
  it.origin = Origin::Created;
  it.parent = ParentRef{ParentKind::Canvas, 1};
  it.xform = kIdentityXform;
  it.content_version = 1;
  Command rect;
  rect.kind = CommandKind::AddRect;
  rect.antialiased = false;
  rect.rect = Rect4{0.0f, 0.0f, 16.0f, 16.0f};
  rect.color = kWhite;
  it.commands = {rect};
  return it;
}

CanvasState scene_canvas() {
  CanvasState c;
  c.id = 1;
  c.origin = Origin::RootQuery;
  c.role = CanvasRole::Root;
  c.attached = true;
  c.xform = kIdentityXform;
  c.items = {1};
  return c;
}

ItemEntry full_entry(const ItemState &state) {
  ItemEntry e;
  e.state = state;
  e.commands_null = false;
  return e;
}

// Session::capture/features/viewport match golden-6's own golden_session_v6() exactly
// (gate7-design.md D2: /7 changes only the magic/protocol/hello/publication.credit_window/two
// error reasons/CORS -- nothing in those blocks). Hand-built here rather than pulled from
// rs2_golden_states.h (which has no V7 helper), matching field for field what that header's
// golden_session_v6() produces, since this test does not link rs2_golden_states.h's full
// nineteen-state factory.
Session rate_session_template(const std::string &id32, Transport transport,
                               std::int32_t credit_window, Encoding stream_encoding) {
  Session session;
  session.version = ProtocolVersion::V7;
  session.session_id = id32;
  session.stream.stream_id = id32;
  session.stream.has_connection = false;
  session.stream.transport = transport;
  session.stream.encoding = stream_encoding;
  session.engine.version_string = "Godot Engine v4.5.1.stable.official";
  session.engine.sha256 = "54cc228405e5be61934192e3bc5461c91dcb4a3275578b29a869557a4322e79c";
  session.engine.display_server = "headless";
  session.engine.rendering_driver = "opengl3";
  session.engine.rendering_method = "gl_compatibility";
  session.capture.calibrator_version = 8;
  session.capture.hooks_planned = {
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
  session.viewport.canvas_cull_mask = 4294967295u;
  session.viewport.root_canvas = 1;
  session.viewport.logical_size = {640, 360};
  session.viewport.stretch.mode = StretchMode::Disabled;
  session.viewport.stretch.aspect = StretchAspect::Ignore;
  session.viewport.stretch.scale_mode = ScaleMode::Fractional;
  session.viewport.root_size_policy = RootSizePolicy::Observe;
  session.viewport.presentation_size = session.viewport.logical_size;
  session.viewport.host_size_status = HostSizeStatus::Match;
  session.viewport.host_window_size = {640, 360};
  session.viewport.font_oversampling = 1.0f;
  session.resources.delivery = Delivery::OutOfBand;
  session.resources.permitted_formats = {"L8", "LA8", "R8", "RG8", "RGB8", "RGBA8"};
  session.resources.max_payload_bytes = 16777216;
  session.resources.inline_max_bytes = 0;
  session.resources.fetch = Fetch::Directory;
  session.resources.has_http_path = false;
  session.resources.auth = Auth::None;
  session.materials.shader_policy = ShaderPolicy::Source;
  session.features.ops = {
      "add_circle",         "add_clip_ignore",      "add_line",
      "add_mesh",            "add_msdf_texture_rect_region", "add_multiline",
      "add_nine_patch",      "add_polygon",          "add_polyline",
      "add_primitive",       "add_rect",             "add_set_transform",
      "add_texture_rect",    "add_texture_rect_region", "add_triangle_array"};
  session.features.item_state = {
      "behind",        "children",      "clip",     "custom_rect", "draw_index",
      "instance_params", "material",    "modulate", "parent",      "self_modulate",
      "texture_filter", "texture_repeat", "transform", "use_parent_material",
      "visibility_layer", "visible",     "z_index",  "z_relative"};
  session.features.canvas_state = {"layer", "modulate", "transform"};
  session.features.resources = {"material", "mesh", "shader", "texture_2d",
                                 "texture_2d_placeholder"};
  session.features.observed_unsupported_ops = {
      "canvas_item_add_animation_slice", "canvas_item_add_lcd_texture_rect_region",
      "canvas_item_add_multimesh", "canvas_item_add_particles", "canvas_item_attach_skeleton",
      "canvas_light_attach_to_canvas", "canvas_set_item_mirroring", "canvas_set_item_repeat",
      "canvas_set_parent"};
  session.features.unobserved = {
      "canvas_item_set_canvas_group_mode", "canvas_item_set_copy_to_backbuffer",
      "canvas_item_set_light_mask", "canvas_item_set_sort_children_by_y",
      "canvas_item_set_visibility_notifier", "canvas_set_disable_scale",
      "canvas_texture_set_shading_parameters", "global_shader_parameter_add",
      "global_shader_parameter_remove", "global_shader_parameter_set",
      "global_shader_parameter_set_override", "material_set_next_pass",
      "material_set_render_priority", "shader_set_path_hint", "texture_set_size_override",
      "viewport_set_canvas_cull_mask", "viewport_set_snap_2d_transforms_to_pixel",
      "viewport_set_snap_2d_vertices_to_pixel"};
  session.features.publication = "snapshot-or-patch";
  // render-stream-7.md "Session": publication {"mode":"rate","target_fps":30,"credit_window":N}
  // (gate7-design.md D2/D4), matching golden-6's own rate.rs6 mode/target_fps exactly.
  session.publication.mode = PublicationMode::Rate;
  session.publication.has_target_fps = true;
  session.publication.target_fps = 30;
  session.publication.credit_window = credit_window;
  session.sabotage.kind = SabotageKind::None;
  session.clear_color = {0.25f, 0.25f, 0.5f, 1.0f};
  session.root_canvas_xform = kIdentityXform;
  session.host_visible_rect = {0.0f, 0.0f, 640.0f, 360.0f};
  session.host_final_xform = kIdentityXform;
  session.content_scale_factor = 1.0f;
  return session;
}

Transaction full_rate_transaction(ProtocolVersion version) {
  Transaction t;
  t.version = version;
  t.seq = 1;
  t.frame = 1;
  t.encoding = Encoding::Full;
  t.canvases = {scene_canvas()};
  t.items = {full_entry(scene_item())};
  return t;
}

// An empty-diff patch (nothing changed since `base_seq`) -- the simplest legitimate patch,
// matching protocol/golden-7/make_golden.py's empty_patch_bytes().
Transaction empty_patch(ProtocolVersion version, std::uint64_t seq, std::uint64_t base_seq) {
  Transaction t;
  t.version = version;
  t.seq = seq;
  t.frame = seq;
  t.encoding = Encoding::Patch;
  t.base_seq = base_seq;
  return t;
}

void test_magic_v7() {
  const std::vector<std::uint8_t> m = magic(ProtocolVersion::V7);
  const std::vector<std::uint8_t> expected = {0x47, 0x52, 0x53, 0x37, 0x0D, 0x0A, 0x1A, 0x0A};
  check(m == expected, "magic(V7) is \"GRS7\\r\\n\\x1a\\n\"");
}

void test_matches_golden_rate_rs7() {
  const std::string id32(32, '7');
  const Session session = rate_session_template(id32, Transport::Websocket, 1, Encoding::Full);
  std::vector<std::vector<std::uint8_t>> records;
  records.push_back(magic(ProtocolVersion::V7));
  records.push_back(encode_session(session));
  records.push_back(encode_transaction(full_rate_transaction(ProtocolVersion::V7)));

  End end;
  end.transactions = 1;
  end.reason = EndReason::Shutdown;
  end.stats.encode_ns_total = 250000;
  end.stats.snapshot_ns_total = 40000;
  end.stats.diff_ns_total = 0;
  end.stats.full_transactions = 1;
  end.stats.patch_transactions = 0;
  std::uint64_t bytes_total = 0;
  std::uint64_t max_len = 0;
  for (std::size_t i = 0; i < records.size(); ++i) {
    bytes_total += records[i].size();
    if (i > 0) max_len = std::max<std::uint64_t>(max_len, records[i].size());
  }
  end.stats.bytes_total = bytes_total;
  end.stats.max_record_bytes = max_len;

  std::vector<std::vector<std::uint8_t>> all = records;
  all.push_back(encode_end(end));
  check_against_golden("rate.rs7", all);
}

void test_matches_golden_window2_rs7() {
  const std::string id32(32, '8');
  const Session session = rate_session_template(id32, Transport::Websocket, 2, Encoding::Patch);
  std::vector<std::vector<std::uint8_t>> records;
  records.push_back(magic(ProtocolVersion::V7));
  records.push_back(encode_session(session));
  records.push_back(encode_transaction(full_rate_transaction(ProtocolVersion::V7)));
  records.push_back(encode_transaction(empty_patch(ProtocolVersion::V7, 2, 1)));
  records.push_back(encode_transaction(empty_patch(ProtocolVersion::V7, 3, 2)));

  End end;
  end.transactions = 3;
  end.reason = EndReason::Shutdown;
  end.stats.encode_ns_total = 250000;
  end.stats.snapshot_ns_total = 40000;
  end.stats.diff_ns_total = 0;
  end.stats.full_transactions = 1;
  end.stats.patch_transactions = 2;
  std::uint64_t bytes_total = 0;
  std::uint64_t max_len = 0;
  for (std::size_t i = 0; i < records.size(); ++i) {
    bytes_total += records[i].size();
    if (i > 0) max_len = std::max<std::uint64_t>(max_len, records[i].size());
  }
  end.stats.bytes_total = bytes_total;
  end.stats.max_record_bytes = max_len;

  std::vector<std::vector<std::uint8_t>> all = records;
  all.push_back(encode_end(end));
  check_against_golden("window2.rs7", all);
}

}  // namespace

int main() {
  test_magic_v7();
  test_matches_golden_rate_rs7();
  test_matches_golden_window2_rs7();
  if (g_failures > 0) {
    std::fprintf(stderr, "rs7_codec_test: %d failure(s)\n", g_failures);
    return 1;
  }
  std::printf("rs7_codec_test: ok\n");
  return 0;
}
