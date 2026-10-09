// Unit tests for the render-stream/1 codec (src/rs1_codec.cpp).
//
// Builds Session/Transaction/End structs BY HAND (bypassing src/rs1_diff.cpp entirely) from the
// same ground truth as rs1_golden_states.h, and requires encode_session() + encode_transaction()
// (x6) + encode_end() to be byte-identical to protocol/golden-1/full.rs1 and patch.rs1, read at
// test time from GRC_GOLDEN1_DIR. This exercises the wire layer independently of
// rs1_diff_test.cpp, which derives the same bytes through make_full()/make_patch() instead.

#include <algorithm>
#include <cstdint>
#include <cstdio>
#include <string>
#include <vector>

#include "rs1_codec.h"
#include "rs1_golden_states.h"
#include "rs1_snapshot.h"

#ifndef GRC_GOLDEN1_DIR
#error "GRC_GOLDEN1_DIR must be defined by CMakeLists.txt"
#endif

namespace {

using namespace grc::rs1;  // NOLINT

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

// A full transaction, hand-built from a Snapshot without going through rs1_diff::make_full().
Transaction full_txn(const Snapshot &snap) {
  Transaction t;
  t.seq = snap.seq;
  t.frame = snap.frame;
  t.encoding = Encoding::Full;
  t.failures = snap.failures;
  t.unsupported = snap.unsupported;
  t.canvases = snap.canvases;
  for (const ItemState &it : snap.items) {
    t.items.push_back(entry(it, false));
  }
  return t;
}

void check_against_golden(const std::string &file, const Session &session,
                           const std::vector<Transaction> &txns, const End &end) {
  std::vector<std::vector<std::uint8_t>> records;
  records.push_back(magic());
  records.push_back(encode_session(session));
  for (const Transaction &t : txns) {
    records.push_back(encode_transaction(t));
  }
  records.push_back(encode_end(end));

  const std::string golden_path = std::string(GRC_GOLDEN1_DIR) + "/" + file;
  const std::vector<std::uint8_t> expected = read_file(golden_path);
  check(!expected.empty(), ("golden-1/" + file + " is readable").c_str());

  std::size_t offset = 0;
  for (std::size_t i = 0; i < records.size(); ++i) {
    const bool in_range = offset + records[i].size() <= expected.size();
    const bool matches = in_range && std::equal(records[i].begin(), records[i].end(),
                                                  expected.begin() + static_cast<long>(offset));
    check(matches, ("record " + std::to_string(i) + " matches golden-1/" + file).c_str());
    offset += records[i].size();
  }
  check(offset == expected.size(), ("encoded recording is exactly golden-1/" + file + "'s length").c_str());
}

void test_matches_golden_full_rs1() {
  const Session session =
      golden::golden_session(Encoding::Full, golden::kFullStreamId, golden::kFullSessionId);
  std::vector<Transaction> txns;
  for (int n = 1; n <= 6; ++n) {
    txns.push_back(full_txn(golden::state(n)));
  }
  End end;
  end.transactions = 6;
  end.reason = EndReason::Shutdown;
  end.stats.encode_ns_total = 250000;
  end.stats.snapshot_ns_total = 40000;
  end.stats.diff_ns_total = 0;
  end.stats.full_transactions = 6;
  end.stats.patch_transactions = 0;
  // bytes_total / max_record_bytes are measurements the codec doesn't compute; fill them from
  // the records we are about to re-encode inside check_against_golden() would be circular, so
  // compute them here the same way the publisher would (gate1-design.md Q4), from the same
  // encoder calls.
  std::vector<std::uint8_t> m = magic();
  std::vector<std::uint8_t> s = encode_session(session);
  std::uint64_t bytes_total = m.size() + s.size();
  std::uint64_t max_len = s.size();
  for (const Transaction &t : txns) {
    const std::vector<std::uint8_t> bytes = encode_transaction(t);
    bytes_total += bytes.size();
    max_len = std::max<std::uint64_t>(max_len, bytes.size());
  }
  end.stats.bytes_total = bytes_total;
  end.stats.max_record_bytes = max_len;

  check_against_golden("full.rs1", session, txns, end);
}

void test_matches_golden_patch_rs1() {
  const Session session =
      golden::golden_session(Encoding::Patch, golden::kPatchStreamId, golden::kPatchSessionId);

  std::vector<Transaction> txns;

  // seq 1: full.
  txns.push_back(full_txn(golden::state(1)));

  // seq 2: transform-only move of item 2. commands:null (content_version unchanged from base).
  {
    Transaction t;
    t.seq = 2;
    t.frame = 2;
    t.encoding = Encoding::Patch;
    t.base_seq = 1;
    t.unsupported = {golden::kUnsupportedItem2};
    t.items = {entry(golden::item2_v2(), true)};
    txns.push_back(t);
  }

  // seq 3: item 4 freed, item 5 created, item 2's draw_index changes (commands:null), item 1
  // recoloured (content_version bump, full commands). Canvas 1's items[] list changed too.
  {
    Transaction t;
    t.seq = 3;
    t.frame = 3;
    t.encoding = Encoding::Patch;
    t.base_seq = 2;
    t.removed_items = {4};
    t.canvases = {golden::root_canvas({1, 2, 5})};
    t.unsupported = {golden::kUnsupportedItem2};
    t.items = {entry(golden::item1_v2(), false), entry(golden::item2_v3(), true),
               entry(golden::item5_v1(), false)};
    txns.push_back(t);
  }

  // seq 4: unchanged -- every list empty (unsupported is still complete, never patched).
  {
    Transaction t;
    t.seq = 4;
    t.frame = 4;
    t.encoding = Encoding::Patch;
    t.base_seq = 3;
    t.unsupported = {golden::kUnsupportedItem2};
    txns.push_back(t);
  }

  // seq 5: item 5 reparented under item 1 (ties with item 3's draw_index). Both item 1 (children
  // changed) and item 5 (parent + draw_index changed) carry commands:null (content_version
  // unchanged for both). Canvas 1's items[] list changed. The draw-index-tie entry is declared.
  {
    Transaction t;
    t.seq = 5;
    t.frame = 5;
    t.encoding = Encoding::Patch;
    t.base_seq = 4;
    t.canvases = {golden::root_canvas({1, 2})};
    t.items = {entry(golden::item1_v3(), true), entry(golden::item5_v2(), true)};
    t.unsupported = {golden::kUnsupportedItem2, golden::kTieItem3};
    txns.push_back(t);
  }

  // seq 6: full again, as after a resync.
  txns.push_back(full_txn(golden::state(6)));

  End end;
  end.transactions = 6;
  end.reason = EndReason::Shutdown;
  end.stats.encode_ns_total = 250000;
  end.stats.snapshot_ns_total = 40000;
  end.stats.diff_ns_total = 12345;
  end.stats.full_transactions = 2;
  end.stats.patch_transactions = 4;
  std::vector<std::uint8_t> m = magic();
  std::vector<std::uint8_t> s = encode_session(session);
  std::uint64_t bytes_total = m.size() + s.size();
  std::uint64_t max_len = s.size();
  for (const Transaction &t : txns) {
    const std::vector<std::uint8_t> bytes = encode_transaction(t);
    bytes_total += bytes.size();
    max_len = std::max<std::uint64_t>(max_len, bytes.size());
  }
  end.stats.bytes_total = bytes_total;
  end.stats.max_record_bytes = max_len;

  check_against_golden("patch.rs1", session, txns, end);
}

}  // namespace

int main() {
  test_matches_golden_full_rs1();
  test_matches_golden_patch_rs1();
  if (g_failures != 0) {
    std::fprintf(stderr, "%d check(s) failed\n", g_failures);
    return 1;
  }
  std::fprintf(stdout, "rs1_codec: all checks passed\n");
  return 0;
}
