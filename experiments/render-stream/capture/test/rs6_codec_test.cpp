// Unit tests for render-stream/6 (src/rs2_codec.cpp's Session::version == V6 path, G6w).
//
// render-stream/6 is implemented as a protocol-version switch inside the SAME rs2_codec/rs2_diff
// modules /2-/5 use (render-stream-6.md, following gate4-design.md G4e1's precedent and
// gate6-design.md D1), so this file does not duplicate rs2_codec_test.cpp's/rs3_codec_test.cpp's/
// rs4_codec_test.cpp's/rs5_codec_test.cpp's framing checks -- it only proves the /6 delta:
// Session::version == V6 selects the GRS6 magic and the "render-stream/6" protocol string, the
// new viewport keys (presentation_size, font_oversampling, snap_2d), the new top-level
// "publication" key and the new canvas keys (layer, sublayer) encode correctly -- by matching
// protocol/golden-6/{full,patch,inline}.rs6 byte for byte. Ground truth is rs2_golden_states.h's
// state(1..19), where state(16)..state(19) are new at /6 (G6w).
//
// Builds Transactions BY HAND (bypassing rs2_diff::make_full()/make_patch(), as rs2_codec_test.cpp,
// rs3_codec_test.cpp, rs4_codec_test.cpp and rs5_codec_test.cpp do) for full.rs6 and inline.rs6,
// and through make_full()/make_patch() for the first fifteen states of patch.rs6 (unchanged in
// shape from rs5_codec_test.cpp's own, just re-encoded under V6) -- proving the version-
// parameterized diff engine carries canvas layer/sublayer without surprises for the NEW states
// too, in test_diff_make_full_matches_hand_built()/test_diff_patch_round_trip() below.

#include <algorithm>
#include <cstdint>
#include <cstdio>
#include <string>
#include <vector>

#include "rs2_codec.h"
#include "rs2_diff.h"
#include "rs2_golden_states.h"
#include "rs2_snapshot.h"

#ifndef GRC_GOLDEN6_DIR
#error "GRC_GOLDEN6_DIR must be defined by CMakeLists.txt"
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

ItemEntry entry(const ItemState &state, bool commands_null) {
  ItemEntry e;
  e.state = state;
  e.commands_null = commands_null;
  return e;
}

// gate5-design.md "As built (G5d)" point 6, carried forward unchanged by every later golden (G55w,
// now G6w): golden-4 state 8's add_triangle_array (item 7, triangle_count 3 over 6 indices) is one
// the real engine refuses -- harmless to the codecs, but no later golden may carry the same defect
// forward. golden-4 itself, and rs4_codec_test.cpp's/rs5_codec_test.cpp's byte-for-byte match
// against it, are UNCHANGED: this file-local fix-up patches only the copy golden-6 uses, lowering
// item 7's triangle_count from 3 to 1 (still "only the first triangle draws", now validly).
Snapshot state6(int n) {
  Snapshot s = golden::state(n);
  if (n >= 8) {
    s.items.mutate_each([&](ItemState &item) {
      if (item.id == 7) {
        std::vector<Command> commands = item.commands.vector();
        for (Command &command : commands) {
          if (command.kind == CommandKind::AddTriangleArray) {
            command.triangle_count = 1;
          }
        }
        item.commands = std::move(commands);
      }
    });
  }
  return s;
}

ItemState item7_immediate_ops_v6() {
  ItemState item = golden::item7_immediate_ops();
  std::vector<Command> commands = item.commands.vector();
  for (Command &command : commands) {
    if (command.kind == CommandKind::AddTriangleArray) {
      command.triangle_count = 1;
    }
  }
  item.commands = std::move(commands);
  return item;
}

// A full /6 transaction, hand-built from a Snapshot without going through rs2_diff::make_full().
Transaction full_txn6(const Snapshot &snap) {
  Transaction t;
  t.version = ProtocolVersion::V6;
  t.seq = snap.seq;
  t.frame = snap.frame;
  t.encoding = Encoding::Full;
  t.failures = snap.failures;
  t.unsupported = snap.unsupported;
  t.default_texture_filter = snap.default_texture_filter;
  t.default_texture_repeat = snap.default_texture_repeat;
  t.canvases = snap.canvases.vector();
  t.textures = snap.textures;
  t.meshes = snap.meshes;
  t.shaders = snap.shaders;
  t.materials = snap.materials;
  for (const ItemState &it : snap.items) {
    t.items.push_back(entry(it, false));
  }
  return t;
}

void check_against_golden(const std::string &file, const std::vector<std::vector<std::uint8_t>> &records) {
  const std::string golden_path = std::string(GRC_GOLDEN6_DIR) + "/" + file;
  const std::vector<std::uint8_t> expected = read_file(golden_path);
  check(!expected.empty(), ("golden-6/" + file + " is readable").c_str());

  std::size_t offset = 0;
  for (std::size_t i = 0; i < records.size(); ++i) {
    const bool in_range = offset + records[i].size() <= expected.size();
    const bool matches = in_range && std::equal(records[i].begin(), records[i].end(),
                                                  expected.begin() + static_cast<long>(offset));
    check(matches, ("record " + std::to_string(i) + " matches golden-6/" + file).c_str());
    offset += records[i].size();
  }
  check(offset == expected.size(), ("encoded recording is exactly golden-6/" + file + "'s length").c_str());
}

End make_end(std::uint64_t full_count, std::uint64_t patch_count, std::uint64_t diff_ns_total,
             std::uint64_t resource_records, std::uint64_t resource_bytes,
             const std::vector<std::vector<std::uint8_t>> &records) {
  End end;
  end.transactions = full_count + patch_count;
  end.reason = EndReason::Shutdown;
  end.stats.encode_ns_total = 250000;
  end.stats.snapshot_ns_total = 40000;
  end.stats.diff_ns_total = diff_ns_total;
  end.stats.full_transactions = full_count;
  end.stats.patch_transactions = patch_count;
  end.stats.resource_records = resource_records;
  end.stats.resource_bytes = resource_bytes;
  std::uint64_t bytes_total = 0;
  std::uint64_t max_len = 0;
  for (std::size_t i = 0; i < records.size(); ++i) {
    bytes_total += records[i].size();
    if (i > 0) {
      max_len = std::max<std::uint64_t>(max_len, records[i].size());
    }
  }
  end.stats.bytes_total = bytes_total;
  end.stats.max_record_bytes = max_len;
  return end;
}

void test_matches_golden_full_rs6() {
  const Session session = golden::golden_session_v6(Encoding::Full, golden::kFullStreamId,
                                                      golden::kFullSessionId, Delivery::OutOfBand);
  std::vector<std::vector<std::uint8_t>> records;
  records.push_back(magic(ProtocolVersion::V6));
  records.push_back(encode_session(session));
  for (int n = 1; n <= 19; ++n) {
    records.push_back(encode_transaction(full_txn6(state6(n))));
  }
  End end = make_end(19, 0, 0, 0, 0, records);
  std::vector<std::vector<std::uint8_t>> all = records;
  all.push_back(encode_end(end));
  check_against_golden("full.rs6", all);
}

// As rs5_codec_test.cpp's patch test for seq2-15 (unchanged states, just re-encoded under V6),
// plus four new hand-built patches for seq16-19: canvas 2 created with items 18-19; canvas 2's
// layer-only change; canvas 2 detached; canvas 2 reattached plus canvas 3 (a stacking tie) and
// the four new session-level entries.
void test_matches_golden_patch_rs6() {
  const Session session = golden::golden_session_v6(Encoding::Patch, golden::kPatchStreamId,
                                                      golden::kPatchSessionId, Delivery::OutOfBand);
  std::vector<std::vector<std::uint8_t>> records;
  records.push_back(magic(ProtocolVersion::V6));
  records.push_back(encode_session(session));
  records.push_back(encode_transaction(full_txn6(state6(1))));

  {
    Transaction t;
    t.version = ProtocolVersion::V6;
    t.seq = 2;
    t.frame = 2;
    t.encoding = Encoding::Patch;
    t.base_seq = 1;
    t.unsupported = golden::kBaseUnsupported;
    t.default_texture_filter = Filter::Nearest;
    t.default_texture_repeat = Repeat::Disabled;
    t.items = {entry(golden::item1_v2(), true)};
    records.push_back(encode_transaction(t));
  }
  {
    Transaction t;
    t.version = ProtocolVersion::V6;
    t.seq = 3;
    t.frame = 3;
    t.encoding = Encoding::Patch;
    t.base_seq = 2;
    t.unsupported = golden::kBaseUnsupported;
    t.default_texture_filter = Filter::Nearest;
    t.default_texture_repeat = Repeat::Disabled;
    t.textures = {golden::texture_a(2, golden::kHashA2)};
    records.push_back(encode_transaction(t));
  }
  {
    Transaction t;
    t.version = ProtocolVersion::V6;
    t.seq = 4;
    t.frame = 4;
    t.encoding = Encoding::Patch;
    t.base_seq = 3;
    t.unsupported = golden::kBaseUnsupported;
    t.default_texture_filter = Filter::Linear;
    t.default_texture_repeat = Repeat::Disabled;
    t.textures = {golden::texture_p_replaced(), golden::texture_f_freed(), golden::texture_n()};
    records.push_back(encode_transaction(t));
  }
  {
    Transaction t;
    t.version = ProtocolVersion::V6;
    t.seq = 5;
    t.frame = 5;
    t.encoding = Encoding::Patch;
    t.base_seq = 4;
    t.unsupported = golden::kBaseUnsupported;
    t.default_texture_filter = Filter::Linear;
    t.default_texture_repeat = Repeat::Disabled;
    t.removed_textures = {5};
    t.items = {entry(golden::item4_v2(), false)};
    records.push_back(encode_transaction(t));
  }
  records.push_back(encode_transaction(full_txn6(state6(6))));  // resync: full again
  {
    Transaction t;
    t.version = ProtocolVersion::V6;
    t.seq = 7;
    t.frame = 7;
    t.encoding = Encoding::Patch;
    t.base_seq = 6;
    t.unsupported = golden::kState7Unsupported;
    t.default_texture_filter = Filter::Linear;
    t.default_texture_repeat = Repeat::Disabled;
    t.canvases = {golden::root_canvas({1, 2, 3, 4, 5, 6})};
    t.items = {entry(golden::item6_msdf(), false)};
    t.textures = {golden::texture_page()};
    records.push_back(encode_transaction(t));
  }
  {
    Transaction t;
    t.version = ProtocolVersion::V6;
    t.seq = 8;
    t.frame = 8;
    t.encoding = Encoding::Patch;
    t.base_seq = 7;
    t.unsupported = golden::kState7Unsupported;
    t.default_texture_filter = Filter::Linear;
    t.default_texture_repeat = Repeat::Disabled;
    t.canvases = {golden::root_canvas({1, 2, 3, 4, 5, 6, 7})};
    t.items = {entry(item7_immediate_ops_v6(), false)};
    records.push_back(encode_transaction(t));
  }
  {
    Transaction t;
    t.version = ProtocolVersion::V6;
    t.seq = 9;
    t.frame = 9;
    t.encoding = Encoding::Patch;
    t.base_seq = 8;
    t.unsupported = golden::kState7Unsupported;
    t.default_texture_filter = Filter::Linear;
    t.default_texture_repeat = Repeat::Disabled;
    t.canvases = {golden::root_canvas({1, 2, 3, 4, 5, 6, 7, 8})};
    t.items = {entry(golden::item8_mesh(), false)};
    const Snapshot nine = state6(9);
    t.meshes = nine.meshes;
    records.push_back(encode_transaction(t));
  }
  {
    Transaction t;
    t.version = ProtocolVersion::V6;
    t.seq = 10;
    t.frame = 10;
    t.encoding = Encoding::Patch;
    t.base_seq = 9;
    t.unsupported = golden::kState7Unsupported;
    t.default_texture_filter = Filter::Linear;
    t.default_texture_repeat = Repeat::Disabled;
    const Snapshot ten = state6(10);
    t.meshes = {ten.meshes[1]};
    records.push_back(encode_transaction(t));
  }
  {
    Transaction t;
    t.version = ProtocolVersion::V6;
    t.seq = 11;
    t.frame = 11;
    t.encoding = Encoding::Patch;
    t.base_seq = 10;
    t.unsupported = golden::kState11Unsupported;
    t.default_texture_filter = Filter::Linear;
    t.default_texture_repeat = Repeat::Disabled;
    t.canvases = {golden::root_canvas({1, 2, 3, 4, 5, 6, 7, 8, 9, 10})};
    t.items = {entry(golden::item9_unsupported_mesh(), false),
               entry(golden::item10_unknown_mesh(), false)};
    const Snapshot eleven = state6(11);
    t.meshes = {eleven.meshes[0], eleven.meshes[2]};
    records.push_back(encode_transaction(t));
  }
  {
    // seq 12: canvas 1 (new items list + modulate), items 11-14, shaders 1-2, materials 1-3.
    Transaction t;
    t.version = ProtocolVersion::V6;
    t.seq = 12;
    t.frame = 12;
    t.encoding = Encoding::Patch;
    t.base_seq = 11;
    t.unsupported = golden::kState11Unsupported;
    t.default_texture_filter = Filter::Linear;
    t.default_texture_repeat = Repeat::Disabled;
    const Snapshot twelve = state6(12);
    t.canvases = twelve.canvases.vector();
    t.items = {entry(golden::item11_cim_material(), false),
               entry(golden::item12_custom_material(), false),
               entry(golden::item13_use_parent_material(), false),
               entry(golden::item14_null_shader_material(), false)};
    t.shaders = twelve.shaders;
    t.materials = twelve.materials;
    records.push_back(encode_transaction(t));
  }
  {
    // seq 13: ONLY material 2's parameter changes -- no item/canvas/texture/mesh/shader entries.
    Transaction t;
    t.version = ProtocolVersion::V6;
    t.seq = 13;
    t.frame = 13;
    t.encoding = Encoding::Patch;
    t.base_seq = 12;
    t.unsupported = golden::kState11Unsupported;
    t.default_texture_filter = Filter::Linear;
    t.default_texture_repeat = Repeat::Disabled;
    const Snapshot thirteen = state6(13);
    t.materials = {thirteen.materials[1]};
    records.push_back(encode_transaction(t));
  }
  {
    // seq 14: ONLY shader 2's code changes -- no item/canvas/texture/mesh/material entries.
    Transaction t;
    t.version = ProtocolVersion::V6;
    t.seq = 14;
    t.frame = 14;
    t.encoding = Encoding::Patch;
    t.base_seq = 13;
    t.unsupported = golden::kState11Unsupported;
    t.default_texture_filter = Filter::Linear;
    t.default_texture_repeat = Repeat::Disabled;
    const Snapshot fourteen = state6(14);
    t.shaders = {fourteen.shaders[1]};
    records.push_back(encode_transaction(t));
  }
  {
    // seq 15: canvas 1 (new items list), items 15-17, shader 3, materials 4-5, the canvas-light
    // session entry.
    Transaction t;
    t.version = ProtocolVersion::V6;
    t.seq = 15;
    t.frame = 15;
    t.encoding = Encoding::Patch;
    t.base_seq = 14;
    t.unsupported = golden::kState15Unsupported;
    t.default_texture_filter = Filter::Linear;
    t.default_texture_repeat = Repeat::Disabled;
    const Snapshot fifteen = state6(15);
    t.canvases = fifteen.canvases.vector();
    t.items = {entry(golden::item15_unsupported_material(), false),
               entry(golden::item16_unknown_material(), false),
               entry(golden::item17_instance_param_type(), false)};
    t.shaders = {fifteen.shaders[2]};
    t.materials = {fifteen.materials[3], fifteen.materials[4]};
    records.push_back(encode_transaction(t));
  }
  {
    // seq 16 (new at /6): canvas 2 created (layer 1/sublayer 0), items 18-19.
    Transaction t;
    t.version = ProtocolVersion::V6;
    t.seq = 16;
    t.frame = 16;
    t.encoding = Encoding::Patch;
    t.base_seq = 15;
    t.unsupported = golden::kState15Unsupported;
    t.default_texture_filter = Filter::Linear;
    t.default_texture_repeat = Repeat::Disabled;
    const Snapshot sixteen = state6(16);
    t.canvases = {sixteen.canvases[1]};
    t.items = {entry(golden::item18(), false), entry(golden::item19(), false)};
    records.push_back(encode_transaction(t));
  }
  {
    // seq 17 (new at /6): ONLY canvas 2's layer changes (1 -> -1).
    Transaction t;
    t.version = ProtocolVersion::V6;
    t.seq = 17;
    t.frame = 17;
    t.encoding = Encoding::Patch;
    t.base_seq = 16;
    t.unsupported = golden::kState15Unsupported;
    t.default_texture_filter = Filter::Linear;
    t.default_texture_repeat = Repeat::Disabled;
    const Snapshot seventeen = state6(17);
    t.canvases = {seventeen.canvases[1]};
    records.push_back(encode_transaction(t));
  }
  {
    // seq 18 (new at /6): canvas 2 is removed (attached: false); items 18-19 stay in the table.
    Transaction t;
    t.version = ProtocolVersion::V6;
    t.seq = 18;
    t.frame = 18;
    t.encoding = Encoding::Patch;
    t.base_seq = 17;
    t.unsupported = golden::kState15Unsupported;
    t.default_texture_filter = Filter::Linear;
    t.default_texture_repeat = Repeat::Disabled;
    const Snapshot eighteen = state6(18);
    t.canvases = {eighteen.canvases[1]};
    records.push_back(encode_transaction(t));
  }
  {
    // seq 19 (new at /6): canvas 2 reattached (layer 2), canvas 3 created at the same (layer,
    // sublayer) -- a canvas-stacking-tie -- and canvas-repeat/canvas-follow-viewport/
    // global-canvas-transform join the session.
    Transaction t;
    t.version = ProtocolVersion::V6;
    t.seq = 19;
    t.frame = 19;
    t.encoding = Encoding::Patch;
    t.base_seq = 18;
    t.unsupported = golden::kState19Unsupported;
    t.default_texture_filter = Filter::Linear;
    t.default_texture_repeat = Repeat::Disabled;
    const Snapshot nineteen = state6(19);
    t.canvases = {nineteen.canvases[1], nineteen.canvases[2]};
    records.push_back(encode_transaction(t));
  }

  End end = make_end(2, 17, 12345, 0, 0, records);
  std::vector<std::vector<std::uint8_t>> all = records;
  all.push_back(encode_end(end));
  check_against_golden("patch.rs6", all);
}

void test_matches_golden_inline_rs6() {
  const Session session = golden::golden_session_v6(Encoding::Full, std::string(32, '3'),
                                                      "22222222222222222222222222222222",
                                                      Delivery::Inline);
  const std::string dir = std::string(GRC_GOLDEN6_DIR) + "/payloads/";
  const std::vector<std::uint8_t> payload_a1 = read_file(dir + "a1.grt");
  const std::vector<std::uint8_t> payload_a2 = read_file(dir + "a2.grt");
  const std::vector<std::uint8_t> payload_f = read_file(dir + "f.grt");
  const std::vector<std::uint8_t> payload_p = read_file(dir + "p.grt");
  const std::vector<std::uint8_t> payload_page = read_file(dir + "page.grt");
  const std::vector<std::uint8_t> payload_mesh1a = read_file(dir + "mesh1-a.grm");
  const std::vector<std::uint8_t> payload_mesh1b = read_file(dir + "mesh1-b.grm");
  const std::vector<std::uint8_t> payload_mesh2v1 = read_file(dir + "mesh2-v1.grm");
  const std::vector<std::uint8_t> payload_mesh2v2 = read_file(dir + "mesh2-v2.grm");
  const std::vector<std::uint8_t> payload_shader1 = read_file(dir + "shader1-add.grp");
  const std::vector<std::uint8_t> payload_shader2v1 = read_file(dir + "shader2-tint-v1.grp");
  const std::vector<std::uint8_t> payload_shader2v2 = read_file(dir + "shader2-tint-v2.grp");
  const std::vector<std::uint8_t> payload_shader3 = read_file(dir + "shader3-time.grp");
  check(!payload_a1.empty() && !payload_a2.empty() && !payload_f.empty() && !payload_p.empty() &&
            !payload_page.empty() && !payload_mesh1a.empty() && !payload_mesh1b.empty() &&
            !payload_mesh2v1.empty() && !payload_mesh2v2.empty() && !payload_shader1.empty() &&
            !payload_shader2v1.empty() && !payload_shader2v2.empty() && !payload_shader3.empty(),
        "golden-6/payloads/* are readable");

  std::vector<std::vector<std::uint8_t>> records;
  records.push_back(magic(ProtocolVersion::V6));
  records.push_back(encode_session(session));
  records.push_back(encode_resource(ResourceRecord{golden::kHashA1, payload_a1}));
  records.push_back(encode_resource(ResourceRecord{golden::kHashF, payload_f}));
  records.push_back(encode_transaction(full_txn6(state6(1))));
  records.push_back(encode_transaction(full_txn6(state6(2))));
  records.push_back(encode_resource(ResourceRecord{golden::kHashA2, payload_a2}));
  records.push_back(encode_transaction(full_txn6(state6(3))));
  records.push_back(encode_resource(ResourceRecord{golden::kHashP, payload_p}));
  records.push_back(encode_transaction(full_txn6(state6(4))));
  records.push_back(encode_transaction(full_txn6(state6(5))));
  records.push_back(encode_transaction(full_txn6(state6(6))));
  records.push_back(encode_resource(ResourceRecord{golden::kHashPage, payload_page}));
  records.push_back(encode_transaction(full_txn6(state6(7))));
  records.push_back(encode_transaction(full_txn6(state6(8))));
  records.push_back(encode_resource(ResourceRecord{golden::kHashMesh1A, payload_mesh1a}));
  records.push_back(encode_resource(ResourceRecord{golden::kHashMesh1B, payload_mesh1b}));
  records.push_back(encode_resource(ResourceRecord{golden::kHashMesh2V1, payload_mesh2v1}));
  records.push_back(encode_transaction(full_txn6(state6(9))));
  records.push_back(encode_resource(ResourceRecord{golden::kHashMesh2V2, payload_mesh2v2}));
  records.push_back(encode_transaction(full_txn6(state6(10))));
  records.push_back(encode_transaction(full_txn6(state6(11))));
  records.push_back(encode_resource(ResourceRecord{golden::kHashShader1, payload_shader1}));
  records.push_back(encode_resource(ResourceRecord{golden::kHashShader2V1, payload_shader2v1}));
  records.push_back(encode_transaction(full_txn6(state6(12))));
  records.push_back(encode_transaction(full_txn6(state6(13))));
  records.push_back(encode_resource(ResourceRecord{golden::kHashShader2V2, payload_shader2v2}));
  records.push_back(encode_resource(ResourceRecord{golden::kHashShader3, payload_shader3}));
  records.push_back(encode_transaction(full_txn6(state6(14))));
  records.push_back(encode_transaction(full_txn6(state6(15))));
  // states 16-19 (new at /6): no new textures/meshes/shaders, so no new resource records.
  records.push_back(encode_transaction(full_txn6(state6(16))));
  records.push_back(encode_transaction(full_txn6(state6(17))));
  records.push_back(encode_transaction(full_txn6(state6(18))));
  records.push_back(encode_transaction(full_txn6(state6(19))));

  const std::uint64_t resource_bytes = payload_a1.size() + payload_f.size() + payload_a2.size() +
                                        payload_p.size() + payload_page.size() +
                                        payload_mesh1a.size() + payload_mesh1b.size() +
                                        payload_mesh2v1.size() + payload_mesh2v2.size() +
                                        payload_shader1.size() + payload_shader2v1.size() +
                                        payload_shader2v2.size() + payload_shader3.size();
  End end = make_end(19, 0, 0, 13, resource_bytes, records);
  std::vector<std::vector<std::uint8_t>> all = records;
  all.push_back(encode_end(end));
  check_against_golden("inline.rs6", all);
}

// Proves the unchanged /2 diff engine (rs2_diff.cpp) carries canvas layer/sublayer correctly for
// every new /6 state: make_full(state(n)) must equal the hand-built full transaction above, for n
// in 16..19 (n in 1..15 is already covered by rs5_codec_test.cpp's own version of this check, run
// against the unversioned Transaction -- this file only needs the new states).
void test_diff_make_full_matches_hand_built() {
  for (int n = 16; n <= 19; ++n) {
    const Transaction hand = full_txn6(state6(n));
    const Transaction derived = make_full(state6(n));
    check(encode_transaction(hand) == encode_transaction(derived),
          ("make_full(state(" + std::to_string(n) + ")) encodes identically to the hand-built "
           "transaction").c_str());
  }
}

// resolve(make_patch(state(n-1), state(n))) must reproduce state(n) itself, for every new /6
// state transition (16<-15, 17<-16, 18<-17, 19<-18), including the layer-only and attached-only
// changes at 17<-16 and 18<-17.
void test_diff_patch_round_trip() {
  for (int n = 16; n <= 19; ++n) {
    const Snapshot base = state6(n - 1);
    const Snapshot cur = state6(n);
    const Transaction patch = make_patch(base, cur);
    check(patch.version == ProtocolVersion::V6,
          ("make_patch(state(" + std::to_string(n - 1) + "), state(" + std::to_string(n) +
           ")) carries version V6").c_str());
    const Snapshot resolved = resolve(base, patch);
    check(encode_transaction(full_txn6(resolved)) == encode_transaction(full_txn6(cur)),
          ("resolve(make_patch(state(" + std::to_string(n - 1) + "), state(" + std::to_string(n) +
           "))) reproduces state(" + std::to_string(n) + ")").c_str());
  }
}

}  // namespace

int main() {
  test_matches_golden_full_rs6();
  test_matches_golden_patch_rs6();
  test_matches_golden_inline_rs6();
  test_diff_make_full_matches_hand_built();
  test_diff_patch_round_trip();
  if (g_failures != 0) {
    std::fprintf(stderr, "%d check(s) failed\n", g_failures);
    return 1;
  }
  std::fprintf(stdout, "rs6_codec: all checks passed\n");
  return 0;
}
