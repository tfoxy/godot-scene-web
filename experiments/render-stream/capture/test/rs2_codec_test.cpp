// Unit tests for the render-stream/2 codec (src/rs2_codec.cpp).
//
// Builds Session/Transaction/ResourceRecord/End structs BY HAND (bypassing src/rs2_diff.cpp
// entirely) from the same ground truth as rs2_golden_states.h, and requires encode_session() +
// encode_transaction() (x6) [+ encode_resource() for inline.rs2] + encode_end() to be byte-
// identical to protocol/golden-2/{full,patch,inline}.rs2, read at test time from
// GRC_GOLDEN2_DIR. This exercises the wire layer independently of rs2_diff_test.cpp, which
// derives the same bytes through make_full()/make_patch() instead.

#include <algorithm>
#include <cstdint>
#include <cstdio>
#include <string>
#include <vector>

#include "rs2_codec.h"
#include "rs2_golden_states.h"
#include "rs2_snapshot.h"

#ifndef GRC_GOLDEN2_DIR
#error "GRC_GOLDEN2_DIR must be defined by CMakeLists.txt"
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

// A full transaction, hand-built from a Snapshot without going through rs2_diff::make_full().
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
  const std::string golden_path = std::string(GRC_GOLDEN2_DIR) + "/" + file;
  const std::vector<std::uint8_t> expected = read_file(golden_path);
  check(!expected.empty(), ("golden-2/" + file + " is readable").c_str());

  std::size_t offset = 0;
  for (std::size_t i = 0; i < records.size(); ++i) {
    const bool in_range = offset + records[i].size() <= expected.size();
    const bool matches = in_range && std::equal(records[i].begin(), records[i].end(),
                                                  expected.begin() + static_cast<long>(offset));
    check(matches, ("record " + std::to_string(i) + " matches golden-2/" + file).c_str());
    offset += records[i].size();
  }
  check(offset == expected.size(), ("encoded recording is exactly golden-2/" + file + "'s length").c_str());
}

// `records` is magic (index 0) followed by the session and transaction/resource records, exactly
// as passed to check_against_golden(). bytes_total sums all of it (magic included); max_record_
// bytes excludes magic, since it has no record framing (render-stream-0.md "End record").
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

void test_matches_golden_full_rs2() {
  const Session session = golden::golden_session(Encoding::Full, golden::kFullStreamId,
                                                   golden::kFullSessionId, Delivery::OutOfBand);
  std::vector<std::vector<std::uint8_t>> records;
  records.push_back(magic());
  records.push_back(encode_session(session));
  for (int n = 1; n <= 6; ++n) {
    records.push_back(encode_transaction(full_txn(golden::state(n))));
  }
  End end = make_end(6, 0, 0, 0, 0, records);
  std::vector<std::vector<std::uint8_t>> all = records;
  all.push_back(encode_end(end));
  check_against_golden("full.rs2", all);
}

void test_matches_golden_patch_rs2() {
  const Session session = golden::golden_session(Encoding::Patch, golden::kPatchStreamId,
                                                   golden::kPatchSessionId, Delivery::OutOfBand);
  std::vector<std::vector<std::uint8_t>> records;
  records.push_back(magic());
  records.push_back(encode_session(session));
  records.push_back(encode_transaction(full_txn(golden::state(1))));

  // seq 2: transform-only move of item 1.
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
  // seq 3: texture 1 (A) updates to version 2 / HASH_A2.
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
  // seq 4: P replaced, F freed, N created, default filter -> linear.
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
  // seq 5: item 4 stops naming F; F's tombstone leaves the table.
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
  // seq 6: unchanged, resent full (as after a resync).
  records.push_back(encode_transaction(full_txn(golden::state(6))));

  End end = make_end(2, 4, 12345, 0, 0, records);
  std::vector<std::vector<std::uint8_t>> all = records;
  all.push_back(encode_end(end));
  check_against_golden("patch.rs2", all);
}

void test_matches_golden_inline_rs2() {
  const Session session = golden::golden_session(Encoding::Full, std::string(32, '3'),
                                                   "22222222222222222222222222222222", Delivery::Inline);
  const std::vector<std::uint8_t> payload_a1 = read_file(std::string(GRC_GOLDEN2_DIR) + "/payloads/a1.grt");
  const std::vector<std::uint8_t> payload_a2 = read_file(std::string(GRC_GOLDEN2_DIR) + "/payloads/a2.grt");
  const std::vector<std::uint8_t> payload_f = read_file(std::string(GRC_GOLDEN2_DIR) + "/payloads/f.grt");
  const std::vector<std::uint8_t> payload_p = read_file(std::string(GRC_GOLDEN2_DIR) + "/payloads/p.grt");
  check(!payload_a1.empty() && !payload_a2.empty() && !payload_f.empty() && !payload_p.empty(),
        "golden-2/payloads/*.grt are readable");

  std::vector<std::vector<std::uint8_t>> records;
  records.push_back(magic());
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

  const std::uint64_t resource_bytes =
      payload_a1.size() + payload_f.size() + payload_a2.size() + payload_p.size();
  End end = make_end(6, 0, 0, 4, resource_bytes, records);
  std::vector<std::vector<std::uint8_t>> all = records;
  all.push_back(encode_end(end));
  check_against_golden("inline.rs2", all);
}

}  // namespace

int main() {
  test_matches_golden_full_rs2();
  test_matches_golden_patch_rs2();
  test_matches_golden_inline_rs2();
  if (g_failures != 0) {
    std::fprintf(stderr, "%d check(s) failed\n", g_failures);
    return 1;
  }
  std::fprintf(stdout, "rs2_codec: all checks passed\n");
  return 0;
}
