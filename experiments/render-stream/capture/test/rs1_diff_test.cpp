// Unit tests for render-stream/1 diff (src/rs1_diff.cpp): make_full()/make_patch() derive
// byte-identical transactions to protocol/golden-1/{full,patch}.rs1 from the Snapshot states in
// rs1_golden_states.h (independent of rs1_codec_test.cpp, which builds the same bytes by hand),
// plus a seeded randomized round-trip: resolve(make_patch(...)) reproduces make_full()'s state
// for 1000 random mutation sequences on a test-local model.

#include <algorithm>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <random>
#include <string>
#include <vector>

#include "rs1_codec.h"
#include "rs1_diff.h"
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

// -------------------------------------------------------------------------
// full.rs1 / patch.rs1, rebuilt through make_full() / make_patch().

void test_full_rs1_via_make_full() {
  const Session session =
      golden::golden_session(Encoding::Full, golden::kFullStreamId, golden::kFullSessionId);
  std::vector<std::vector<std::uint8_t>> records;
  records.push_back(magic());
  records.push_back(encode_session(session));
  std::vector<std::uint8_t> max_before_end = records[1];
  std::uint64_t max_len = records[1].size();
  for (int n = 1; n <= 6; ++n) {
    const Snapshot snap = golden::state(n);
    const Transaction txn = make_full(snap);
    check(txn.encoding == Encoding::Full, "make_full() sets encoding Full");
    check(!txn.base_seq.has_value(), "make_full() leaves base_seq unset");
    check(txn.removed_canvases.empty() && txn.removed_items.empty(),
          "make_full() has no removed_*");
    const std::vector<std::uint8_t> bytes = encode_transaction(txn);
    max_len = std::max<std::uint64_t>(max_len, bytes.size());
    records.push_back(bytes);
  }
  End end;
  end.transactions = 6;
  end.reason = EndReason::Shutdown;
  std::uint64_t bytes_total = magic().size();
  for (std::size_t i = 1; i < records.size(); ++i) {
    bytes_total += records[i].size();
  }
  end.stats.bytes_total = bytes_total;
  end.stats.encode_ns_total = 250000;
  end.stats.snapshot_ns_total = 40000;
  end.stats.diff_ns_total = 0;
  end.stats.max_record_bytes = max_len;
  end.stats.full_transactions = 6;
  end.stats.patch_transactions = 0;
  records.push_back(encode_end(end));

  const std::string golden_path = std::string(GRC_GOLDEN1_DIR) + "/full.rs1";
  const std::vector<std::uint8_t> expected = read_file(golden_path);
  check(!expected.empty(), "golden-1/full.rs1 is readable");

  std::size_t offset = 0;
  for (std::size_t i = 0; i < records.size(); ++i) {
    const bool in_range = offset + records[i].size() <= expected.size();
    const bool matches = in_range && std::equal(records[i].begin(), records[i].end(),
                                                  expected.begin() + static_cast<long>(offset));
    check(matches, "make_full(): record matches golden-1/full.rs1");
    offset += records[i].size();
  }
  check(offset == expected.size(), "make_full(): encoded recording is exactly full.rs1's length");
}

void test_patch_rs1_via_make_patch() {
  const Session session =
      golden::golden_session(Encoding::Patch, golden::kPatchStreamId, golden::kPatchSessionId);
  std::vector<std::vector<std::uint8_t>> records;
  records.push_back(magic());
  records.push_back(encode_session(session));
  std::uint64_t max_len = records[1].size();

  const Snapshot s1 = golden::state(1);
  records.push_back(encode_transaction(make_full(s1)));
  max_len = std::max<std::uint64_t>(max_len, records.back().size());

  for (int n = 2; n <= 5; ++n) {
    const Snapshot base = golden::state(n - 1);
    const Snapshot cur = golden::state(n);
    const Transaction patch = make_patch(base, cur);
    check(patch.encoding == Encoding::Patch, "make_patch() sets encoding Patch");
    check(patch.base_seq.has_value() && *patch.base_seq == base.seq,
          "make_patch() sets base_seq to the base's seq");
    const std::vector<std::uint8_t> bytes = encode_transaction(patch);
    max_len = std::max<std::uint64_t>(max_len, bytes.size());
    records.push_back(bytes);
  }

  const Snapshot s6 = golden::state(6);
  records.push_back(encode_transaction(make_full(s6)));  // resync: full again
  max_len = std::max<std::uint64_t>(max_len, records.back().size());

  End end;
  end.transactions = 6;
  end.reason = EndReason::Shutdown;
  std::uint64_t bytes_total = magic().size();
  for (std::size_t i = 1; i < records.size(); ++i) {
    bytes_total += records[i].size();
  }
  end.stats.bytes_total = bytes_total;
  end.stats.encode_ns_total = 250000;
  end.stats.snapshot_ns_total = 40000;
  end.stats.diff_ns_total = 12345;
  end.stats.max_record_bytes = max_len;
  end.stats.full_transactions = 2;
  end.stats.patch_transactions = 4;
  records.push_back(encode_end(end));

  const std::string golden_path = std::string(GRC_GOLDEN1_DIR) + "/patch.rs1";
  const std::vector<std::uint8_t> expected = read_file(golden_path);
  check(!expected.empty(), "golden-1/patch.rs1 is readable");

  std::size_t offset = 0;
  for (std::size_t i = 0; i < records.size(); ++i) {
    const bool in_range = offset + records[i].size() <= expected.size();
    const bool matches = in_range && std::equal(records[i].begin(), records[i].end(),
                                                  expected.begin() + static_cast<long>(offset));
    check(matches, "make_patch(): record matches golden-1/patch.rs1");
    offset += records[i].size();
  }
  check(offset == expected.size(), "make_patch(): encoded recording is exactly patch.rs1's length");
}

// -------------------------------------------------------------------------
// resolve(): a patch chain resolves to the same states make_full() would encode.

bool snapshots_equal(const Snapshot &a, const Snapshot &b) {
  // Compare through the wire encoder: two Snapshots are "the same" exactly when a receiver could
  // not tell them apart, i.e. their full transactions encode identically (seq/frame excepted,
  // since resolve() always carries the transaction's own seq/frame, which is what we want here).
  Transaction ta = make_full(a);
  Transaction tb = make_full(b);
  ta.seq = tb.seq = 0;
  ta.frame = tb.frame = 0;
  return encode_transaction(ta) == encode_transaction(tb);
}

void test_resolve_chain_equals_full_golden_states() {
  Snapshot base = golden::state(1);
  for (int n = 2; n <= 5; ++n) {
    const Snapshot cur = golden::state(n);
    const Transaction patch = make_patch(base, cur);
    const Snapshot resolved = resolve(base, patch);
    check(snapshots_equal(resolved, cur), "resolve(make_patch(base, cur)) == cur (golden states)");
    base = resolved;
  }
}

// -------------------------------------------------------------------------
// Seeded randomized round trip on a test-local model: random mutation sequences, resolve(patch
// chain) == every full state, for 1000 seeds.

struct RandomItem {
  std::uint32_t id;
  ParentKind parent_kind;
  std::uint32_t parent_id;
  std::int32_t draw_index;
  std::uint64_t content_version;
  float ox, oy;  // origin only; everything else stays at RS defaults
  float r, g, b;  // command colour; rect is fixed size
};

Snapshot build_random_snapshot(std::uint64_t seq, const std::vector<RandomItem> &items) {
  Snapshot s;
  s.seq = seq;
  s.frame = seq;
  std::vector<std::uint32_t> top_level;
  CanvasState canvas = golden::root_canvas({});
  std::vector<ItemState> out;
  out.reserve(items.size());
  for (const RandomItem &ri : items) {
    ItemState it;
    it.id = ri.id;
    it.parent.kind = ri.parent_kind;
    it.parent.id = ri.parent_id;
    it.draw_index = ri.draw_index;
    it.content_version = ri.content_version;
    it.xform = {1.0f, 0.0f, 0.0f, 1.0f, ri.ox, ri.oy};
    it.commands = {golden::rect({0.0f, 0.0f, 4.0f, 4.0f}, {ri.r, ri.g, ri.b, 1.0f})};
    out.push_back(it);
    if (ri.parent_kind == ParentKind::Canvas) {
      top_level.push_back(ri.id);
    }
  }
  // children lists, derived from parent links (append order = ascending id, good enough for a
  // round-trip test that never inspects draw order).
  for (ItemState &it : out) {
    if (it.parent.kind == ParentKind::Item) {
      for (ItemState &parent : out) {
        if (parent.id == it.parent.id) {
          parent.children.push_back(it.id);
        }
      }
    }
  }
  std::sort(out.begin(), out.end(), [](const ItemState &a, const ItemState &b) { return a.id < b.id; });
  std::sort(top_level.begin(), top_level.end());
  canvas.items = top_level;
  s.canvases = {canvas};
  s.items = out;
  return s;
}

void test_randomized_patch_resolve_round_trip() {
  constexpr int kSeeds = 1000;
  int next_id = 2;  // id 1 always exists (top-level, never freed, to keep the model simple)
  for (int seed = 0; seed < kSeeds; ++seed) {
    std::mt19937 rng(static_cast<unsigned>(seed) + 1u);
    std::uniform_real_distribution<float> coord(0.0f, 100.0f);
    std::uniform_real_distribution<float> colour(0.0f, 1.0f);
    std::uniform_int_distribution<int> draw(0, 3);
    std::uniform_int_distribution<int> coin(0, 1);

    next_id = 2;
    std::vector<RandomItem> items;
    items.push_back(RandomItem{1, ParentKind::Canvas, 1, 0, 1, coord(rng), coord(rng), colour(rng), colour(rng), colour(rng)});

    Snapshot base = build_random_snapshot(1, items);
    Transaction full0 = make_full(base);
    Snapshot resolved_full0 = resolve(base, full0);
    check(snapshots_equal(resolved_full0, base), "seed: resolve(full) == the snapshot it was made from");

    constexpr int kSteps = 6;
    for (int step = 0; step < kSteps; ++step) {
      // Mutate: move an existing item, or (if few exist) add a new top-level item.
      const int action = coin(rng);
      if (action == 0 || items.size() >= 5) {
        std::uniform_int_distribution<std::size_t> pick(0, items.size() - 1);
        RandomItem &target = items[pick(rng)];
        target.ox = coord(rng);
        target.oy = coord(rng);
        target.draw_index = draw(rng);
        if (coin(rng) == 1) {
          target.content_version += 1;  // sometimes a content change too
          target.r = colour(rng);
        }
      } else {
        RandomItem fresh{static_cast<std::uint32_t>(next_id++), ParentKind::Canvas, 1,
                          draw(rng), 1, coord(rng), coord(rng), colour(rng), colour(rng), colour(rng)};
        items.push_back(fresh);
      }
      const Snapshot cur = build_random_snapshot(static_cast<std::uint64_t>(step + 2), items);
      const Transaction patch = make_patch(base, cur);
      check(patch.encoding == Encoding::Patch, "seed: make_patch() produces a patch encoding");
      const Snapshot resolved = resolve(base, patch);
      check(snapshots_equal(resolved, cur),
            "seed: resolve(make_patch(base, cur)) == cur (randomized model)");
      base = resolved;
    }
  }
}

}  // namespace

int main() {
  test_full_rs1_via_make_full();
  test_patch_rs1_via_make_patch();
  test_resolve_chain_equals_full_golden_states();
  test_randomized_patch_resolve_round_trip();
  if (g_failures != 0) {
    std::fprintf(stderr, "%d check(s) failed\n", g_failures);
    return 1;
  }
  std::fprintf(stdout, "rs1_diff: all checks passed\n");
  return 0;
}
