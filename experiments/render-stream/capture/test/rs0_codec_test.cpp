// Unit tests for the render-stream/0 codec (src/rs0_codec.cpp) and publisher
// (src/rs0_publish.cpp).
//
// The codec test rebuilds protocol/golden/minimal.bin's session and two
// transactions from Session/Snapshot structs by hand (mirroring
// protocol/golden/make_golden.py) and requires encode_session() +
// encode_transaction() + encode_transaction() + encode_end() to be
// byte-identical to the committed golden file, read at test time from
// GRC_GOLDEN_DIR (a CMake compile definition). The publisher tests drive
// Publisher against a MemoryRecordSink (no disk I/O) to show contiguous
// seq assignment, correct stats, and the freeze-frame / perturb-transform
// sabotages taking effect from their configured frame onward.

#include <algorithm>
#include <cstdint>
#include <cstdio>
#include <string>
#include <vector>

#include "rs0_codec.h"
#include "rs0_publish.h"
#include "rs0_snapshot.h"

#ifndef GRC_GOLDEN_DIR
#error "GRC_GOLDEN_DIR must be defined by CMakeLists.txt"
#endif

namespace {

using namespace grc::rs0;  // NOLINT

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

// -------------------------------------------------------------------------
// golden/minimal.bin, rebuilt from structs (protocol/golden/make_golden.py
// is the reference; see protocol/golden/minimal.decoded.json for the
// expected values this transcribes).

const std::vector<std::string> kHooksPlanned = {
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

const std::vector<std::string> kFeatureItemState = {
    "children",  "clip",           "custom_rect", "draw_index", "modulate",
    "parent",    "self_modulate",  "transform",    "visibility_layer",
    "visible",   "z_index"};

const std::vector<std::string> kFeatureObservedUnsupported = {
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

const std::vector<std::string> kFeatureUnobserved = {
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
    "viewport_set_canvas_cull_mask"};

Session make_golden_session() {
  Session session;
  session.session_id = "0123456789abcdef0123456789abcdef";
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
  session.features.ops = {"add_rect"};
  session.features.item_state = kFeatureItemState;
  session.features.observed_unsupported_ops = kFeatureObservedUnsupported;
  session.features.unobserved = kFeatureUnobserved;
  session.features.publication = "complete-snapshot-per-frame";
  session.sabotage.kind = SabotageKind::None;
  session.clear_color = {0.25f, 0.25f, 0.5f, 1.0f};
  session.root_canvas_xform = kIdentityXform;
  session.host_visible_rect = {0.0f, 0.0f, 640.0f, 360.0f};
  return session;
}

ItemState make_item1(std::vector<std::uint32_t> children) {
  ItemState item;
  item.id = 1;
  item.origin = Origin::Created;
  item.parent = ParentRef{ParentKind::Canvas, 1};
  item.children = std::move(children);
  item.xform = {1.0f, 0.0f, 0.0f, 1.0f, 100.0f, 50.0f};
  item.visibility_layer = 1;
  item.content_version = 1;
  Command add_rect;
  add_rect.kind = CommandKind::AddRect;
  add_rect.antialiased = false;
  add_rect.rect = {0.0f, 0.0f, 64.0f, 48.0f};
  add_rect.color = {1.0f, 0.5f, 0.25f, 1.0f};
  item.commands = {add_rect};
  return item;
}

ItemState make_item2() {
  ItemState item;
  item.id = 2;
  item.origin = Origin::Created;
  item.parent = ParentRef{ParentKind::Item, 1};
  item.xform = {1.0f, 0.0f, 0.0f, 1.0f, 8.0f, 8.0f};
  item.modulate = {1.0f, 1.0f, 1.0f, 0.5f};
  item.self_modulate = {0.75f, 1.0f, 1.0f, 1.0f};
  item.draw_index = 1;
  item.z_index = -1;
  item.clip = true;
  item.custom_rect = true;
  item.custom_rect_rect = {0.0f, 0.0f, 32.0f, 32.0f};
  item.visibility_layer = 1;
  item.content_version = 2;
  Command add_rect;
  add_rect.kind = CommandKind::AddRect;
  add_rect.antialiased = true;
  add_rect.rect = {2.0f, 2.0f, 16.0f, 16.0f};
  add_rect.color = {0.0f, 0.5f, 1.0f, 1.0f};
  Command unsupported;
  unsupported.kind = CommandKind::Unsupported;
  unsupported.name = "canvas_item_add_circle";
  item.commands = {add_rect, unsupported};
  return item;
}

ItemState make_item3() {
  ItemState item;
  item.id = 3;
  item.origin = Origin::Created;
  item.parent = ParentRef{ParentKind::Canvas, 1};
  item.xform = {0.0f, 1.0f, -1.0f, 0.0f, 200.0f, 120.0f};
  item.draw_index = 1;
  item.visibility_layer = 1;
  item.content_version = 1;
  Command add_rect;
  add_rect.kind = CommandKind::AddRect;
  add_rect.antialiased = false;
  add_rect.rect = {0.0f, 0.0f, 40.0f, 40.0f};
  add_rect.color = {0.25f, 0.75f, 0.0f, 1.0f};
  item.commands = {add_rect};
  return item;
}

CanvasState make_root_canvas(std::vector<std::uint32_t> items) {
  CanvasState canvas;
  canvas.id = 1;
  canvas.origin = Origin::RootQuery;
  canvas.role = CanvasRole::Root;
  canvas.attached = true;
  canvas.xform = kIdentityXform;
  canvas.items = std::move(items);
  return canvas;
}

Snapshot make_golden_t1() {
  Snapshot snap;
  snap.seq = 1;
  snap.frame = 1;
  UnsupportedRef unsupported;
  unsupported.op = "canvas_item_add_circle";
  unsupported.has_item = true;
  unsupported.item = 2;
  unsupported.reason = UnsupportedReason::UnsupportedOp;
  snap.unsupported = {unsupported};
  snap.canvases = {make_root_canvas({1})};
  snap.items = {make_item1({2}), make_item2()};
  return snap;
}

Snapshot make_golden_t2() {
  Snapshot snap;
  snap.seq = 2;
  snap.frame = 2;
  snap.canvases = {make_root_canvas({1, 3})};
  snap.items = {make_item1({}), make_item3()};
  return snap;
}

void test_matches_golden_minimal_bin() {
  const Session session = make_golden_session();
  const Snapshot t1 = make_golden_t1();
  const Snapshot t2 = make_golden_t2();
  End end;
  end.transactions = 2;
  end.reason = EndReason::Shutdown;
  end.stats.bytes_total = 5119;
  end.stats.encode_ns_total = 250000;
  end.stats.snapshot_ns_total = 40000;
  end.stats.max_record_bytes = 2873;

  const std::vector<std::uint8_t> magic_bytes = magic();
  const std::vector<std::uint8_t> session_bytes = encode_session(session);
  const std::vector<std::uint8_t> t1_bytes = encode_transaction(t1);
  const std::vector<std::uint8_t> t2_bytes = encode_transaction(t2);
  const std::vector<std::uint8_t> end_bytes = encode_end(end);

  const std::string golden_path = std::string(GRC_GOLDEN_DIR) + "/minimal.bin";
  const std::vector<std::uint8_t> expected = read_file(golden_path);
  check(!expected.empty(), "golden/minimal.bin is readable");

  std::size_t offset = 0;
  auto check_slice = [&](const std::vector<std::uint8_t> &actual, const char *what) {
    const bool in_range = offset + actual.size() <= expected.size();
    const bool matches =
        in_range && std::equal(actual.begin(), actual.end(), expected.begin() + static_cast<long>(offset));
    check(matches, what);
    offset += actual.size();
  };
  check_slice(magic_bytes, "magic() matches golden/minimal.bin bytes 0..8");
  check_slice(session_bytes, "encode_session() matches the golden session record");
  check_slice(t1_bytes, "encode_transaction(seq 1) matches the golden transaction record");
  check_slice(t2_bytes, "encode_transaction(seq 2) matches the golden transaction record");
  check_slice(end_bytes, "encode_end() matches the golden end record");
  check(offset == expected.size(), "the encoded recording is exactly as long as golden/minimal.bin");
}

// -------------------------------------------------------------------------
// publisher: contiguous seqs, stats, sabotage.

std::vector<std::uint8_t> nth_write(const MemoryRecordSink &sink, std::size_t index) {
  std::size_t offset = 0;
  for (std::size_t i = 0; i < index; ++i) {
    offset += sink.writes[i];
  }
  return std::vector<std::uint8_t>(sink.bytes.begin() + static_cast<long>(offset),
                                    sink.bytes.begin() + static_cast<long>(offset + sink.writes[index]));
}

Session make_minimal_session() {
  Session session;
  session.session_id = std::string(32, '0');
  session.engine.version_string = "test";
  session.engine.sha256 = std::string(64, '0');
  session.engine.display_server = "headless";
  session.engine.rendering_driver = "opengl3";
  session.engine.rendering_method = "gl_compatibility";
  session.capture.calibrator_version = 3;
  session.features.ops = {"add_rect"};
  return session;
}

Snapshot make_one_item_snapshot(float origin_x) {
  Snapshot snap;
  ItemState item;
  item.id = 1;
  item.origin = Origin::Created;
  item.parent = ParentRef{ParentKind::Canvas, 1};
  item.xform = {1.0f, 0.0f, 0.0f, 1.0f, origin_x, 0.0f};
  item.content_version = 1;
  Command add_rect;
  add_rect.kind = CommandKind::AddRect;
  add_rect.rect = {0.0f, 0.0f, 10.0f, 10.0f};
  add_rect.color = {1.0f, 1.0f, 1.0f, 1.0f};
  item.commands = {add_rect};
  snap.items = {item};
  snap.canvases = {make_root_canvas({1})};
  return snap;
}

void test_parse_sabotage() {
  {
    const ParseResult r = parse_sabotage(nullptr, nullptr);
    check(r.ok && r.config.kind == SabotageKind::None, "unset GRC_SABOTAGE is ok, kind None");
  }
  {
    const ParseResult r = parse_sabotage("freeze-frame", nullptr);
    check(r.ok && r.config.kind == SabotageKind::FreezeFrame && r.config.frame == 21,
          "freeze-frame with no frame defaults to 21");
  }
  {
    const ParseResult r = parse_sabotage("freeze-frame", "5");
    check(r.ok && r.config.frame == 5, "freeze-frame takes an explicit frame");
  }
  {
    const ParseResult r = parse_sabotage("omit-update", "1");
    check(r.ok && r.config.kind == SabotageKind::OmitUpdate, "omit-update parses ok");
  }
  {
    const ParseResult r = parse_sabotage("perturb-transform", "100");
    check(r.ok && r.config.kind == SabotageKind::PerturbTransform && r.config.frame == 100,
          "perturb-transform parses ok");
  }
  {
    const ParseResult r = parse_sabotage("not-a-real-kind", nullptr);
    check(!r.ok, "an unknown GRC_SABOTAGE kind is refused");
  }
  {
    const ParseResult r = parse_sabotage("freeze-frame", "0");
    check(!r.ok, "GRC_SABOTAGE_FRAME 0 is refused (must be >= 1)");
  }
  {
    const ParseResult r = parse_sabotage("freeze-frame", "-3");
    check(!r.ok, "a negative GRC_SABOTAGE_FRAME is refused");
  }
  {
    const ParseResult r = parse_sabotage("freeze-frame", "abc");
    check(!r.ok, "a non-numeric GRC_SABOTAGE_FRAME is refused");
  }
  {
    const ParseResult r = parse_sabotage("freeze-frame", "");
    check(!r.ok, "an empty GRC_SABOTAGE_FRAME is refused");
  }
  {
    const ParseResult r = parse_sabotage("freeze-frame", "3.5");
    check(!r.ok, "a fractional GRC_SABOTAGE_FRAME is refused");
  }
}

void test_generate_session_id() {
  const std::string id1 = generate_session_id();
  const std::string id2 = generate_session_id();
  check(id1.size() == 32, "generate_session_id() is 32 characters");
  bool all_hex = !id1.empty();
  for (char c : id1) {
    all_hex = all_hex && ((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'));
  }
  check(all_hex, "generate_session_id() is lowercase hex");
  check(id1 != id2, "two generate_session_id() calls differ");
}

void test_publisher_contiguous_seqs_and_stats() {
  const Session session = make_golden_session();
  const Snapshot t1 = make_golden_t1();
  const Snapshot t2 = make_golden_t2();

  MemoryRecordSink sink;
  sink.open("memory://contiguous-seqs-and-stats");
  Publisher publisher(sink);
  check(publisher.start(session), "start() succeeds against a memory sink");
  check(sink.flush_count == 1, "start() flushes exactly once, after magic + session");
  check(publisher.publish_transaction(t1, 1, 1000), "publish_transaction seq 1 succeeds");
  check(publisher.publish_transaction(t2, 2, 2000), "publish_transaction seq 2 succeeds");
  check(publisher.transactions() == 2, "two transactions were published");
  check(publisher.finish(EndReason::Shutdown), "finish() succeeds");
  check(sink.was_closed, "finish() closes the sink");
  check(sink.flush_count == 4, "one flush for start, one per transaction, one for finish");

  const std::vector<std::uint8_t> magic_bytes = magic();
  const std::vector<std::uint8_t> session_bytes = encode_session(session);
  Snapshot expected_t1 = t1;
  expected_t1.seq = 1;
  expected_t1.frame = 1;
  Snapshot expected_t2 = t2;
  expected_t2.seq = 2;
  expected_t2.frame = 2;
  const std::vector<std::uint8_t> t1_bytes = encode_transaction(expected_t1);
  const std::vector<std::uint8_t> t2_bytes = encode_transaction(expected_t2);

  check(nth_write(sink, 0) == magic_bytes, "write 0 is the magic");
  check(nth_write(sink, 1) == session_bytes, "write 1 is the session record");
  check(nth_write(sink, 2) == t1_bytes, "write 2 is transaction seq 1, byte-identical to encode_transaction");
  check(nth_write(sink, 3) == t2_bytes, "write 3 is transaction seq 2, byte-identical to encode_transaction");

  const std::uint64_t expected_bytes_total =
      magic_bytes.size() + session_bytes.size() + t1_bytes.size() + t2_bytes.size();
  const std::uint64_t expected_max =
      std::max({session_bytes.size(), t1_bytes.size(), t2_bytes.size()});
  check(publisher.stats().bytes_total == expected_bytes_total,
        "bytes_total is magic + session + every transaction, excluding the end record");
  check(publisher.stats().max_record_bytes == expected_max,
        "max_record_bytes is the largest session/transaction record");
  check(publisher.stats().snapshot_ns_total == 3000,
        "snapshot_ns_total sums exactly the caller-supplied per-transaction costs");
}

void test_publisher_freeze_frame() {
  MemoryRecordSink sink;
  sink.open("memory://freeze-frame");
  SabotageConfig sabotage;
  sabotage.kind = SabotageKind::FreezeFrame;
  sabotage.frame = 3;
  Publisher publisher(sink, sabotage);
  publisher.start(make_minimal_session());

  const Snapshot frame1 = make_one_item_snapshot(10.0f);
  const Snapshot frame2 = make_one_item_snapshot(20.0f);  // the last transaction before frame 3
  const Snapshot frame3 = make_one_item_snapshot(30.0f);  // must be replaced by frame2's content
  const Snapshot frame4 = make_one_item_snapshot(40.0f);  // still replaced by frame2's content

  check(publisher.publish_transaction(frame1, 1, 0), "freeze: publish frame 1");
  check(publisher.publish_transaction(frame2, 2, 0), "freeze: publish frame 2 (still before F)");
  check(publisher.publish_transaction(frame3, 3, 0), "freeze: publish frame 3 (F reached)");
  check(publisher.publish_transaction(frame4, 4, 0), "freeze: publish frame 4 (still sabotaged)");
  publisher.finish(EndReason::Shutdown);

  Snapshot expected_frame2 = frame2;
  expected_frame2.seq = 2;
  expected_frame2.frame = 2;
  Snapshot expected_frame3 = frame2;  // frozen: frame 2's content, fresh seq/frame
  expected_frame3.seq = 3;
  expected_frame3.frame = 3;
  Snapshot expected_frame4 = frame2;  // frozen again: still frame 2's content
  expected_frame4.seq = 4;
  expected_frame4.frame = 4;

  check(nth_write(sink, 3) == encode_transaction(expected_frame2),
        "freeze: frame 2 publishes its own content (before F)");
  check(nth_write(sink, 4) == encode_transaction(expected_frame3),
        "freeze: frame 3 republishes frame 2's content with a fresh seq/frame");
  check(nth_write(sink, 5) == encode_transaction(expected_frame4),
        "freeze: frame 4 republishes the same frozen content again");
}

void test_publisher_perturb_transform() {
  MemoryRecordSink sink;
  sink.open("memory://perturb-transform");
  SabotageConfig sabotage;
  sabotage.kind = SabotageKind::PerturbTransform;
  sabotage.frame = 3;
  Publisher publisher(sink, sabotage);
  publisher.start(make_minimal_session());

  const Snapshot frame1 = make_one_item_snapshot(10.0f);
  const Snapshot frame2 = make_one_item_snapshot(20.0f);
  const Snapshot frame3 = make_one_item_snapshot(30.0f);

  check(publisher.publish_transaction(frame1, 1, 0), "perturb: publish frame 1 (before F)");
  check(publisher.publish_transaction(frame2, 2, 0), "perturb: publish frame 2 (before F)");
  check(publisher.publish_transaction(frame3, 3, 0), "perturb: publish frame 3 (F reached)");
  publisher.finish(EndReason::Shutdown);

  Snapshot expected_frame1 = frame1;
  expected_frame1.seq = 1;
  expected_frame1.frame = 1;
  Snapshot expected_frame2 = frame2;
  expected_frame2.seq = 2;
  expected_frame2.frame = 2;
  Snapshot expected_frame3 = frame3;
  expected_frame3.items[0].xform[4] += 1.0f;  // origin.x, perturbed from frame 3 on
  expected_frame3.seq = 3;
  expected_frame3.frame = 3;

  check(nth_write(sink, 2) == encode_transaction(expected_frame1), "perturb: frame 1 unperturbed");
  check(nth_write(sink, 3) == encode_transaction(expected_frame2), "perturb: frame 2 unperturbed");
  check(nth_write(sink, 4) == encode_transaction(expected_frame3),
        "perturb: frame 3 origin.x shifted by +1.0 once F is reached");
}

}  // namespace

// The production session's features (entry.cpp) are exactly the golden ones.
void test_gate0_features() {
  const Features features = gate0_features();
  check(features.ops == std::vector<std::string>{"add_rect"}, "gate0_features().ops");
  check(features.item_state == kFeatureItemState, "gate0_features().item_state");
  check(features.observed_unsupported_ops == kFeatureObservedUnsupported,
        "gate0_features().observed_unsupported_ops");
  check(features.unobserved == kFeatureUnobserved, "gate0_features().unobserved");
  check(features.publication == "complete-snapshot-per-frame", "gate0_features().publication");
}

int main() {
  test_matches_golden_minimal_bin();
  test_gate0_features();
  test_parse_sabotage();
  test_generate_session_id();
  test_publisher_contiguous_seqs_and_stats();
  test_publisher_freeze_frame();
  test_publisher_perturb_transform();
  if (g_failures != 0) {
    std::fprintf(stderr, "%d check(s) failed\n", g_failures);
    return 1;
  }
  std::fprintf(stdout, "rs0_codec: all checks passed\n");
  return 0;
}
