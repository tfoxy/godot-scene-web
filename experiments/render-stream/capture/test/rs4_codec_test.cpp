// Unit tests for render-stream/4 (src/rs2_codec.cpp's Session::version == V4 path, G5w).
//
// render-stream/4 is implemented as a protocol-version switch inside the SAME rs2_codec/rs2_diff
// modules /2 and /3 use (render-stream-4.md, following gate4-design.md G4e1's precedent), so this
// file does not duplicate rs2_codec_test.cpp's/rs3_codec_test.cpp's framing checks -- it only
// proves the /4 delta: Session::version == V4 selects the GRS4 magic and the "render-stream/4"
// protocol string, the eleven new CommandKind values encode correctly, the mesh table
// (meshes/removed_meshes/mesh_f32) encodes correctly, and cmd_i32 carries add_triangle_array's
// indices -- by matching protocol/golden-4/{full,patch,inline}.rs4 byte for byte. Ground truth is
// rs2_golden_states.h's state(1..11), where state(8)..state(11) are new at /4 (G5w, "As built":
// gate5-design.md's Q4 predicted three new states; this implementation uses four, splitting the
// mesh version-change proof from the freed/unsupported/unknown-mesh content so neither is ever
// conflated with the other in one transaction).
//
// Builds Transactions BY HAND (bypassing rs2_diff::make_full()/make_patch(), as rs2_codec_test.cpp
// and rs3_codec_test.cpp do) for full.rs4 and inline.rs4, and through make_full()/make_patch() for
// the first six states of patch.rs4 (unchanged from rs3_codec_test.cpp's own hand-built shape) --
// proving the version-parameterized diff engine carries meshes without surprises for the NEW
// states too, in test_diff_make_full_matches_hand_built()/test_diff_patch_round_trip() below.

#include <algorithm>
#include <cstdint>
#include <cstdio>
#include <string>
#include <vector>

#include "rs2_codec.h"
#include "rs2_diff.h"
#include "rs2_golden_states.h"
#include "rs2_snapshot.h"

#ifndef GRC_GOLDEN4_DIR
#error "GRC_GOLDEN4_DIR must be defined by CMakeLists.txt"
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

// A full /4 transaction, hand-built from a Snapshot without going through rs2_diff::make_full().
Transaction full_txn4(const Snapshot &snap) {
  Transaction t;
  t.version = ProtocolVersion::V4;
  t.seq = snap.seq;
  t.frame = snap.frame;
  t.encoding = Encoding::Full;
  t.failures = snap.failures;
  t.unsupported = snap.unsupported;
  t.default_texture_filter = snap.default_texture_filter;
  t.default_texture_repeat = snap.default_texture_repeat;
  t.canvases = snap.canvases;
  t.textures = snap.textures;
  t.meshes = snap.meshes;
  for (const ItemState &it : snap.items) {
    t.items.push_back(entry(it, false));
  }
  return t;
}

void check_against_golden(const std::string &file, const std::vector<std::vector<std::uint8_t>> &records) {
  const std::string golden_path = std::string(GRC_GOLDEN4_DIR) + "/" + file;
  const std::vector<std::uint8_t> expected = read_file(golden_path);
  check(!expected.empty(), ("golden-4/" + file + " is readable").c_str());

  std::size_t offset = 0;
  for (std::size_t i = 0; i < records.size(); ++i) {
    const bool in_range = offset + records[i].size() <= expected.size();
    const bool matches = in_range && std::equal(records[i].begin(), records[i].end(),
                                                  expected.begin() + static_cast<long>(offset));
    check(matches, ("record " + std::to_string(i) + " matches golden-4/" + file).c_str());
    offset += records[i].size();
  }
  check(offset == expected.size(), ("encoded recording is exactly golden-4/" + file + "'s length").c_str());
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

void test_matches_golden_full_rs4() {
  const Session session = golden::golden_session_v4(Encoding::Full, golden::kFullStreamId,
                                                      golden::kFullSessionId, Delivery::OutOfBand);
  std::vector<std::vector<std::uint8_t>> records;
  records.push_back(magic(ProtocolVersion::V4));
  records.push_back(encode_session(session));
  for (int n = 1; n <= 11; ++n) {
    records.push_back(encode_transaction(full_txn4(golden::state(n))));
  }
  End end = make_end(11, 0, 0, 0, 0, records);
  std::vector<std::vector<std::uint8_t>> all = records;
  all.push_back(encode_end(end));
  check_against_golden("full.rs4", all);
}

// As rs3_codec_test.cpp's patch test for seq2-7 (unchanged states, just re-encoded under V4), plus
// four new hand-built patches for seq8-11 (item 7's immediate ops; meshes 1/2 created with item
// 8; mesh 2's version-only change; mesh 1 freed + mesh 3 unsupported + items 9/10).
void test_matches_golden_patch_rs4() {
  const Session session = golden::golden_session_v4(Encoding::Patch, golden::kPatchStreamId,
                                                      golden::kPatchSessionId, Delivery::OutOfBand);
  std::vector<std::vector<std::uint8_t>> records;
  records.push_back(magic(ProtocolVersion::V4));
  records.push_back(encode_session(session));
  records.push_back(encode_transaction(full_txn4(golden::state(1))));

  {
    Transaction t;
    t.version = ProtocolVersion::V4;
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
    t.version = ProtocolVersion::V4;
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
    t.version = ProtocolVersion::V4;
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
    t.version = ProtocolVersion::V4;
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
  records.push_back(encode_transaction(full_txn4(golden::state(6))));  // resync: full again
  {
    // seq 7: item 6 and texture 7 both appear for the first time (unchanged from rs3's seq 7).
    Transaction t;
    t.version = ProtocolVersion::V4;
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
    // seq 8: item 7 appears, drawing one of every new immediate op. No texture/mesh change.
    Transaction t;
    t.version = ProtocolVersion::V4;
    t.seq = 8;
    t.frame = 8;
    t.encoding = Encoding::Patch;
    t.base_seq = 7;
    t.unsupported = golden::kState7Unsupported;
    t.default_texture_filter = Filter::Linear;
    t.default_texture_repeat = Repeat::Disabled;
    t.canvases = {golden::root_canvas({1, 2, 3, 4, 5, 6, 7})};
    t.items = {entry(golden::item7_immediate_ops(), false)};
    records.push_back(encode_transaction(t));
  }
  {
    // seq 9: meshes 1 (two surfaces) and 2 (one surface) are created; item 8 draws mesh 1.
    Transaction t;
    t.version = ProtocolVersion::V4;
    t.seq = 9;
    t.frame = 9;
    t.encoding = Encoding::Patch;
    t.base_seq = 8;
    t.unsupported = golden::kState7Unsupported;
    t.default_texture_filter = Filter::Linear;
    t.default_texture_repeat = Repeat::Disabled;
    t.canvases = {golden::root_canvas({1, 2, 3, 4, 5, 6, 7, 8})};
    t.items = {entry(golden::item8_mesh(), false)};
    const Snapshot nine = golden::state(9);
    t.meshes = nine.meshes;  // both new: new-or-differ vs. base (state 8, no meshes) keeps both
    records.push_back(encode_transaction(t));
  }
  {
    // seq 10: ONLY mesh 2's surface changes (new payload, version 2). No item/canvas/texture
    // entries at all -- render-stream-4.md "a mesh version change with no item change".
    Transaction t;
    t.version = ProtocolVersion::V4;
    t.seq = 10;
    t.frame = 10;
    t.encoding = Encoding::Patch;
    t.base_seq = 9;
    t.unsupported = golden::kState7Unsupported;
    t.default_texture_filter = Filter::Linear;
    t.default_texture_repeat = Repeat::Disabled;
    const Snapshot ten = golden::state(10);
    t.meshes = {ten.meshes[1]};  // mesh 2 only; mesh 1 unchanged from seq 9
    records.push_back(encode_transaction(t));
  }
  {
    // seq 11: mesh 1 freed (item 8 still names it, unchanged); mesh 3 created unsupported
    // (mesh-format) and named by item 9; item 10 names mesh id 999 (never seen).
    Transaction t;
    t.version = ProtocolVersion::V4;
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
    const Snapshot eleven = golden::state(11);
    t.meshes = {eleven.meshes[0], eleven.meshes[2]};  // mesh 1 (now freed), mesh 3 (new); mesh 2 unchanged
    records.push_back(encode_transaction(t));
  }

  End end = make_end(2, 9, 12345, 0, 0, records);
  std::vector<std::vector<std::uint8_t>> all = records;
  all.push_back(encode_end(end));
  check_against_golden("patch.rs4", all);
}

void test_matches_golden_inline_rs4() {
  const Session session = golden::golden_session_v4(Encoding::Full, std::string(32, '3'),
                                                      "22222222222222222222222222222222",
                                                      Delivery::Inline);
  const std::string dir = std::string(GRC_GOLDEN4_DIR) + "/payloads/";
  const std::vector<std::uint8_t> payload_a1 = read_file(dir + "a1.grt");
  const std::vector<std::uint8_t> payload_a2 = read_file(dir + "a2.grt");
  const std::vector<std::uint8_t> payload_f = read_file(dir + "f.grt");
  const std::vector<std::uint8_t> payload_p = read_file(dir + "p.grt");
  const std::vector<std::uint8_t> payload_page = read_file(dir + "page.grt");
  const std::vector<std::uint8_t> payload_mesh1a = read_file(dir + "mesh1-a.grm");
  const std::vector<std::uint8_t> payload_mesh1b = read_file(dir + "mesh1-b.grm");
  const std::vector<std::uint8_t> payload_mesh2v1 = read_file(dir + "mesh2-v1.grm");
  const std::vector<std::uint8_t> payload_mesh2v2 = read_file(dir + "mesh2-v2.grm");
  check(!payload_a1.empty() && !payload_a2.empty() && !payload_f.empty() && !payload_p.empty() &&
            !payload_page.empty() && !payload_mesh1a.empty() && !payload_mesh1b.empty() &&
            !payload_mesh2v1.empty() && !payload_mesh2v2.empty(),
        "golden-4/payloads/* are readable");

  std::vector<std::vector<std::uint8_t>> records;
  records.push_back(magic(ProtocolVersion::V4));
  records.push_back(encode_session(session));
  records.push_back(encode_resource(ResourceRecord{golden::kHashA1, payload_a1}));
  records.push_back(encode_resource(ResourceRecord{golden::kHashF, payload_f}));
  records.push_back(encode_transaction(full_txn4(golden::state(1))));
  records.push_back(encode_transaction(full_txn4(golden::state(2))));
  records.push_back(encode_resource(ResourceRecord{golden::kHashA2, payload_a2}));
  records.push_back(encode_transaction(full_txn4(golden::state(3))));
  records.push_back(encode_resource(ResourceRecord{golden::kHashP, payload_p}));
  records.push_back(encode_transaction(full_txn4(golden::state(4))));
  records.push_back(encode_transaction(full_txn4(golden::state(5))));
  records.push_back(encode_transaction(full_txn4(golden::state(6))));
  records.push_back(encode_resource(ResourceRecord{golden::kHashPage, payload_page}));
  records.push_back(encode_transaction(full_txn4(golden::state(7))));
  records.push_back(encode_transaction(full_txn4(golden::state(8))));
  records.push_back(encode_resource(ResourceRecord{golden::kHashMesh1A, payload_mesh1a}));
  records.push_back(encode_resource(ResourceRecord{golden::kHashMesh1B, payload_mesh1b}));
  records.push_back(encode_resource(ResourceRecord{golden::kHashMesh2V1, payload_mesh2v1}));
  records.push_back(encode_transaction(full_txn4(golden::state(9))));
  records.push_back(encode_resource(ResourceRecord{golden::kHashMesh2V2, payload_mesh2v2}));
  records.push_back(encode_transaction(full_txn4(golden::state(10))));
  records.push_back(encode_transaction(full_txn4(golden::state(11))));

  const std::uint64_t resource_bytes = payload_a1.size() + payload_f.size() + payload_a2.size() +
                                        payload_p.size() + payload_page.size() +
                                        payload_mesh1a.size() + payload_mesh1b.size() +
                                        payload_mesh2v1.size() + payload_mesh2v2.size();
  End end = make_end(11, 0, 0, 9, resource_bytes, records);
  std::vector<std::vector<std::uint8_t>> all = records;
  all.push_back(encode_end(end));
  check_against_golden("inline.rs4", all);
}

// Proves the unchanged /2 diff engine (rs2_diff.cpp) carries the mesh table correctly for every
// new /4 state: make_full(state(n)) must equal the hand-built full transaction above, for n in
// 8..11 (n in 1..7 is already covered by rs3_codec_test.cpp's own version of this check, run
// against the unversioned Transaction -- this file only needs the new states).
void test_diff_make_full_matches_hand_built() {
  for (int n = 8; n <= 11; ++n) {
    const Transaction hand = full_txn4(golden::state(n));
    const Transaction derived = make_full(golden::state(n));
    check(encode_transaction(hand) == encode_transaction(derived),
          ("make_full(state(" + std::to_string(n) + ")) encodes identically to the hand-built "
           "transaction").c_str());
  }
}

// resolve(make_patch(state(n-1), state(n))) must reproduce state(n) itself, for every new /4
// state transition (8<-7, 9<-8, 10<-9, 11<-10), including the mesh-only change at 10<-9 and the
// freed/unsupported/unknown-mesh content at 11<-10.
void test_diff_patch_round_trip() {
  for (int n = 8; n <= 11; ++n) {
    const Snapshot base = golden::state(n - 1);
    const Snapshot cur = golden::state(n);
    const Transaction patch = make_patch(base, cur);
    check(patch.version == ProtocolVersion::V4,
          ("make_patch(state(" + std::to_string(n - 1) + "), state(" + std::to_string(n) +
           ")) carries version V4").c_str());
    const Snapshot resolved = resolve(base, patch);
    check(encode_transaction(full_txn4(resolved)) == encode_transaction(full_txn4(cur)),
          ("resolve(make_patch(state(" + std::to_string(n - 1) + "), state(" + std::to_string(n) +
           "))) reproduces state(" + std::to_string(n) + ")").c_str());
  }
}

}  // namespace

int main() {
  test_matches_golden_full_rs4();
  test_matches_golden_patch_rs4();
  test_matches_golden_inline_rs4();
  test_diff_make_full_matches_hand_built();
  test_diff_patch_round_trip();
  if (g_failures != 0) {
    std::fprintf(stderr, "%d check(s) failed\n", g_failures);
    return 1;
  }
  std::fprintf(stdout, "rs4_codec: all checks passed\n");
  return 0;
}
