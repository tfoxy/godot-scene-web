// Unit tests for render-stream/3 (src/rs2_codec.cpp's Session::version == V3 path, G4e1).
//
// render-stream/3 is implemented as a protocol-version switch inside the SAME rs2_codec/rs2_diff
// modules /2 uses (gate4-design.md G4e1: "Renaming files is not part of this contract"), so this
// file does not duplicate rs2_codec_test.cpp's framing checks -- it only proves the /3 delta:
// Session::version == V3 selects the GRS3 magic and the "render-stream/3" protocol string, and
// CommandKind::AddMsdfTextureRectRegion encodes correctly, by matching protocol/golden-3/
// {full,patch,inline}.rs3 byte for byte. Ground truth is rs2_golden_states.h's state(1..7), where
// state(7) is new at /3 (state(6) plus item 6's three msdf commands and texture 7, "the page").
//
// Builds Transactions BY HAND (bypassing rs2_diff::make_full()/make_patch(), as
// rs2_codec_test.cpp does for /2) for full.rs3 and inline.rs3, and through make_full()/
// make_patch() for patch.rs3 -- proving the version-parameterized diff engine (unchanged by
// G4e1) carries the new command kind without modification.

#include <algorithm>
#include <cstdint>
#include <cstdio>
#include <string>
#include <vector>

#include "rs2_codec.h"
#include "rs2_diff.h"
#include "rs2_golden_states.h"
#include "rs2_snapshot.h"

#ifndef GRC_GOLDEN3_DIR
#error "GRC_GOLDEN3_DIR must be defined by CMakeLists.txt"
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

Transaction full_txn(const Snapshot &snap) {
  Transaction t;
  t.seq = snap.seq;
  t.frame = snap.frame;
  t.encoding = Encoding::Full;
  t.failures = snap.failures;
  t.unsupported = snap.unsupported;
  t.default_texture_filter = snap.default_texture_filter;
  t.default_texture_repeat = snap.default_texture_repeat;
  t.canvases = snap.canvases;
  t.textures = snap.textures;
  for (const ItemState &it : snap.items) {
    t.items.push_back(entry(it, false));
  }
  return t;
}

void check_against_golden(const std::string &file, const std::vector<std::vector<std::uint8_t>> &records) {
  const std::string golden_path = std::string(GRC_GOLDEN3_DIR) + "/" + file;
  const std::vector<std::uint8_t> expected = read_file(golden_path);
  check(!expected.empty(), ("golden-3/" + file + " is readable").c_str());

  std::size_t offset = 0;
  for (std::size_t i = 0; i < records.size(); ++i) {
    const bool in_range = offset + records[i].size() <= expected.size();
    const bool matches = in_range && std::equal(records[i].begin(), records[i].end(),
                                                  expected.begin() + static_cast<long>(offset));
    check(matches, ("record " + std::to_string(i) + " matches golden-3/" + file).c_str());
    offset += records[i].size();
  }
  check(offset == expected.size(), ("encoded recording is exactly golden-3/" + file + "'s length").c_str());
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

void test_matches_golden_full_rs3() {
  const Session session = golden::golden_session_v3(Encoding::Full, golden::kFullStreamId,
                                                      golden::kFullSessionId, Delivery::OutOfBand);
  std::vector<std::vector<std::uint8_t>> records;
  records.push_back(magic(ProtocolVersion::V3));
  records.push_back(encode_session(session));
  for (int n = 1; n <= 7; ++n) {
    records.push_back(encode_transaction(full_txn(golden::state(n))));
  }
  End end = make_end(7, 0, 0, 0, 0, records);
  std::vector<std::vector<std::uint8_t>> all = records;
  all.push_back(encode_end(end));
  check_against_golden("full.rs3", all);
}

// As rs2_codec_test.cpp's patch test, but seq 7 is also a hand-built patch (base_seq 6), proving
// the new command kind travels through a patch transaction's `items[]` too, not just a full one.
void test_matches_golden_patch_rs3() {
  const Session session = golden::golden_session_v3(Encoding::Patch, golden::kPatchStreamId,
                                                      golden::kPatchSessionId, Delivery::OutOfBand);
  std::vector<std::vector<std::uint8_t>> records;
  records.push_back(magic(ProtocolVersion::V3));
  records.push_back(encode_session(session));
  records.push_back(encode_transaction(full_txn(golden::state(1))));

  {
    Transaction t;
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
  records.push_back(encode_transaction(full_txn(golden::state(6))));  // resync: full again
  {
    // seq 7: item 6 and texture 7 both appear for the first time -- new, not a content_version
    // match against any base item, so commands are never null.
    Transaction t;
    t.seq = 7;
    t.frame = 7;
    t.encoding = Encoding::Patch;
    t.base_seq = 6;
    t.unsupported = golden::kState7Unsupported;
    t.default_texture_filter = Filter::Linear;
    t.default_texture_repeat = Repeat::Disabled;
    CanvasState canvas = golden::root_canvas({1, 2, 3, 4, 5, 6});
    t.canvases = {canvas};
    t.items = {entry(golden::item6_msdf(), false)};
    t.textures = {golden::texture_page()};
    records.push_back(encode_transaction(t));
  }

  End end = make_end(2, 5, 12345, 0, 0, records);
  std::vector<std::vector<std::uint8_t>> all = records;
  all.push_back(encode_end(end));
  check_against_golden("patch.rs3", all);
}

void test_matches_golden_inline_rs3() {
  const Session session = golden::golden_session_v3(Encoding::Full, std::string(32, '3'),
                                                      "22222222222222222222222222222222",
                                                      Delivery::Inline);
  const std::string dir = std::string(GRC_GOLDEN3_DIR) + "/payloads/";
  const std::vector<std::uint8_t> payload_a1 = read_file(dir + "a1.grt");
  const std::vector<std::uint8_t> payload_a2 = read_file(dir + "a2.grt");
  const std::vector<std::uint8_t> payload_f = read_file(dir + "f.grt");
  const std::vector<std::uint8_t> payload_p = read_file(dir + "p.grt");
  const std::vector<std::uint8_t> payload_page = read_file(dir + "page.grt");
  check(!payload_a1.empty() && !payload_a2.empty() && !payload_f.empty() && !payload_p.empty() &&
            !payload_page.empty(),
        "golden-3/payloads/*.grt are readable");

  std::vector<std::vector<std::uint8_t>> records;
  records.push_back(magic(ProtocolVersion::V3));
  records.push_back(encode_session(session));
  records.push_back(encode_resource(ResourceRecord{golden::kHashA1, payload_a1}));
  records.push_back(encode_resource(ResourceRecord{golden::kHashF, payload_f}));
  records.push_back(encode_transaction(full_txn(golden::state(1))));
  records.push_back(encode_transaction(full_txn(golden::state(2))));
  records.push_back(encode_resource(ResourceRecord{golden::kHashA2, payload_a2}));
  records.push_back(encode_transaction(full_txn(golden::state(3))));
  records.push_back(encode_resource(ResourceRecord{golden::kHashP, payload_p}));
  records.push_back(encode_transaction(full_txn(golden::state(4))));
  records.push_back(encode_transaction(full_txn(golden::state(5))));
  records.push_back(encode_transaction(full_txn(golden::state(6))));
  records.push_back(encode_resource(ResourceRecord{golden::kHashPage, payload_page}));
  records.push_back(encode_transaction(full_txn(golden::state(7))));

  const std::uint64_t resource_bytes = payload_a1.size() + payload_f.size() + payload_a2.size() +
                                        payload_p.size() + payload_page.size();
  End end = make_end(7, 0, 0, 5, resource_bytes, records);
  std::vector<std::vector<std::uint8_t>> all = records;
  all.push_back(encode_end(end));
  check_against_golden("inline.rs3", all);
}

// Proves the unchanged /2 diff engine (rs2_diff.cpp) carries CommandKind::AddMsdfTextureRectRegion
// without modification: make_full(state(7)) must equal the hand-built full transaction above.
void test_diff_make_full_matches_hand_built() {
  const Transaction hand = full_txn(golden::state(7));
  const Transaction derived = make_full(golden::state(7));
  check(encode_transaction(hand) == encode_transaction(derived),
        "make_full(state(7)) encodes identically to the hand-built seq-7 transaction");
}

// resolve(make_patch(state(6), state(7))) must reproduce state(7) itself, including item 6's
// three msdf commands and texture 7.
void test_diff_patch_round_trip() {
  const Snapshot base = golden::state(6);
  const Snapshot cur = golden::state(7);
  const Transaction patch = make_patch(base, cur);
  const Snapshot resolved = resolve(base, patch);
  check(encode_transaction(full_txn(resolved)) == encode_transaction(full_txn(cur)),
        "resolve(make_patch(state(6), state(7))) reproduces state(7)");
}

}  // namespace

int main() {
  test_matches_golden_full_rs3();
  test_matches_golden_patch_rs3();
  test_matches_golden_inline_rs3();
  test_diff_make_full_matches_hand_built();
  test_diff_patch_round_trip();
  if (g_failures != 0) {
    std::fprintf(stderr, "%d check(s) failed\n", g_failures);
    return 1;
  }
  std::fprintf(stdout, "rs3_codec: all checks passed\n");
  return 0;
}
