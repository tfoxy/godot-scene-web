// Unit tests for the render-stream/1 publisher (src/rs1_publish.cpp), protocol/gate1-design.md
// "G1b2" and Q4 "Frame callback" (file sinks).
//
// Drives Publisher against two MemoryRecordSinks (no disk I/O) with snapshots taken from a real
// rs::Mirror, and checks every record byte for byte against rs1_codec/rs1_diff applied to the
// same snapshots: both sinks start with the /1 magic and their own session; the full sink holds
// only full transactions; the patch sink holds seq 1 full and patches with base_seq = seq - 1
// after it, and resolving that patch chain reproduces every full state; the freeze-frame,
// perturb-transform and patch-drop-item sabotages; per-sink end stats; and the
// parse_sabotage() accept/refuse matrix. Byte-level golden compatibility of the codec and the
// diff themselves is rs1_codec_test's and rs1_diff_test's job.

#include <algorithm>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

#include "rs1_codec.h"
#include "rs1_diff.h"
#include "rs1_golden_states.h"
#include "rs1_publish.h"
#include "rs1_snapshot.h"
#include "rs_mirror.h"

namespace {

using namespace grc::rs1;  // NOLINT
using grc::rs::Mirror;

int g_failures = 0;
int g_checks = 0;

void check(bool condition, const std::string &what) {
  ++g_checks;
  if (!condition) {
    std::fprintf(stderr, "FAIL %s\n", what.c_str());
    ++g_failures;
  }
}

constexpr std::uint64_t kRootViewport = 0x1000;
constexpr std::uint64_t kRootCanvas = 0x2000;
constexpr Rect4 kRect = {0, 0, 32, 16};
constexpr Color4 kRed = {1, 0, 0, 1};
constexpr Color4 kGreen = {0, 1, 0, 1};
constexpr Color4 kBlue = {0, 0, 1, 1};

const std::string kSessionId = "0123456789abcdef0123456789abcdef";

Session make_template() {
  // The golden session with an empty stream: the publisher fills `stream` per sink.
  Session tmpl = golden::golden_session(Encoding::Full, std::string(), kSessionId);
  tmpl.stream = StreamInfo();
  return tmpl;
}

std::vector<std::uint8_t> nth_write(const MemoryRecordSink &sink, std::size_t n) {
  std::size_t offset = 0;
  for (std::size_t i = 0; i < n && i < sink.writes.size(); ++i) {
    offset += sink.writes[i];
  }
  if (n >= sink.writes.size()) {
    return {};
  }
  return std::vector<std::uint8_t>(sink.bytes.begin() + static_cast<std::ptrdiff_t>(offset),
                                   sink.bytes.begin() +
                                       static_cast<std::ptrdiff_t>(offset + sink.writes[n]));
}

bool contains(const std::vector<std::uint8_t> &bytes, const std::string &text) {
  return std::search(bytes.begin(), bytes.end(), text.begin(), text.end()) != bytes.end();
}

bool is_hex32(const std::string &id) {
  return id.size() == 32 && std::all_of(id.begin(), id.end(), [](char c) {
           return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f');
         });
}

// Two states are the same exactly when their full transactions encode identically.
bool same_state(const Snapshot &a, const Snapshot &b) {
  Snapshot x = a;
  Snapshot y = b;
  x.seq = y.seq = 1;
  x.frame = y.frame = 1;
  return encode_transaction(make_full(x)) == encode_transaction(make_full(y));
}

Snapshot stamped(Snapshot s, std::uint64_t seq, std::uint64_t frame) {
  s.seq = seq;
  s.frame = frame;
  return s;
}

// A scripted scene driven through the mirror, one mutation set per frame:
//   1  A (100), B (101) on canvas 1 with one rect each, raised to indices 0, 1
//   2  A moves (transform only)
//   3  B freed, C (102) created on canvas 1 with a rect at index 2, A recoloured
//   4  nothing
//   5  C re-parented under A; D (103) created under A with a rect: C and D tie at index 0
//   6  D's draw index set to 1 (tie resolved), A's modulate changed
void drive_frame(Mirror *m, int frame) {
  const std::uint64_t f = static_cast<std::uint64_t>(frame);
  switch (frame) {
  case 1:
    m->canvas_item_create(100, f);
    m->canvas_item_create(101, f);
    m->set_parent(100, kRootCanvas, f);
    m->set_parent(101, kRootCanvas, f);
    m->add_rect(100, kRect, kRed, false, f);
    m->add_rect(101, kRect, kGreen, false, f);
    m->set_draw_index(100, 0, f);
    m->set_draw_index(101, 1, f);
    break;
  case 2:
    m->set_transform(100, {1, 0, 0, 1, 40, 20}, f);
    break;
  case 3:
    m->free_rid(101, f);
    m->canvas_item_create(102, f);
    m->set_parent(102, kRootCanvas, f);
    m->set_draw_index(102, 2, f);
    m->add_rect(102, kRect, kBlue, false, f);
    m->clear(100, f);
    m->add_rect(100, kRect, kBlue, true, f);
    break;
  case 4:
    break;
  case 5:
    m->set_parent(102, 100, f);
    m->set_draw_index(102, 0, f);
    m->canvas_item_create(103, f);
    m->set_parent(103, 100, f);
    m->add_rect(103, kRect, kRed, false, f);
    break;
  case 6:
    m->set_draw_index(103, 1, f);
    m->set_modulate(100, {0.5f, 0.5f, 0.5f, 1}, f);
    break;
  default:
    break;
  }
}

constexpr int kFrames = 6;

// Publishes kFrames frames of the scripted scene and returns the snapshots it fed (unstamped).
std::vector<Snapshot> publish_script(Publisher *publisher, std::uint64_t snapshot_ns = 0) {
  Mirror m;
  m.reset();
  m.set_root(kRootViewport, kRootCanvas, kIdentityXform);
  std::vector<Snapshot> fed;
  for (int frame = 1; frame <= kFrames; ++frame) {
    drive_frame(&m, frame);
    Snapshot s = m.snapshot(0, static_cast<std::uint64_t>(frame));
    fed.push_back(s);
    check(publisher->publish(s, static_cast<std::uint64_t>(frame), snapshot_ns),
          "publish frame " + std::to_string(frame));
  }
  return fed;
}

// ------------------------------------------------------------------------------------------ start

void test_start_two_sinks() {
  MemoryRecordSink full;
  MemoryRecordSink patch;
  full.open("memory://full");
  patch.open("memory://patch");
  Publisher publisher(&full, &patch);
  const Session tmpl = make_template();
  check(publisher.start(tmpl), "start() with two sinks");

  const Session &fs = publisher.session(Encoding::Full);
  const Session &ps = publisher.session(Encoding::Patch);
  check(fs.session_id == kSessionId && ps.session_id == kSessionId,
        "both sinks carry the template's session_id");
  check(is_hex32(fs.stream.stream_id) && is_hex32(ps.stream.stream_id),
        "each stream_id is 32 lowercase hex");
  check(fs.stream.stream_id != ps.stream.stream_id, "each sink has its own stream_id");
  check(fs.stream.encoding == Encoding::Full && ps.stream.encoding == Encoding::Patch,
        "encodings full / patch");
  check(fs.stream.transport == Transport::File && ps.stream.transport == Transport::File &&
            !fs.stream.has_connection && !ps.stream.has_connection,
        "transport file, connection null");

  const std::vector<std::uint8_t> magic_bytes = magic();
  check(magic_bytes.size() == 8 && magic_bytes[3] == 0x31, "the /1 magic GRS1");
  check(nth_write(full, 0) == magic_bytes && nth_write(patch, 0) == magic_bytes,
        "both sinks start with the /1 magic");

  Session expected_full = tmpl;
  expected_full.stream.stream_id = fs.stream.stream_id;
  expected_full.stream.encoding = Encoding::Full;
  Session expected_patch = tmpl;
  expected_patch.stream.stream_id = ps.stream.stream_id;
  expected_patch.stream.encoding = Encoding::Patch;
  check(nth_write(full, 1) == encode_session(expected_full),
        "the full sink's session record is the template with its own stream");
  check(nth_write(patch, 1) == encode_session(expected_patch),
        "the patch sink's session record is the template with its own stream");
  check(contains(nth_write(full, 1), "\"encoding\":\"full\"") &&
            contains(nth_write(patch, 1), "\"encoding\":\"patch\""),
        "the session records say encoding full / patch");
  check(full.flush_count == 1 && patch.flush_count == 1, "one flush per sink at start");
}

void test_sink_presence() {
  {
    Publisher publisher(nullptr, nullptr);
    check(!publisher.start(make_template()), "start() with no sink fails");
  }
  {
    MemoryRecordSink full;
    full.open("memory://full-only");
    Publisher publisher(&full, nullptr);
    check(publisher.start(make_template()), "full sink only");
    publish_script(&publisher);
    check(publisher.finish(EndReason::Shutdown), "finish full only");
    check(publisher.has_sink(Encoding::Full) && !publisher.has_sink(Encoding::Patch),
          "has_sink full only");
    check(publisher.transactions(Encoding::Full) == kFrames, "full-only transactions");
    check(full.writes.size() == 2 + kFrames + 1, "magic, session, transactions, end");
  }
  {
    MemoryRecordSink patch;
    patch.open("memory://patch-only");
    Publisher publisher(nullptr, &patch);
    check(publisher.start(make_template()), "patch sink only");
    const std::vector<Snapshot> fed = publish_script(&publisher);
    check(publisher.finish(EndReason::Disarm), "finish patch only");
    check(publisher.transactions(Encoding::Patch) == kFrames &&
              publisher.stats(Encoding::Patch).full_transactions == 1 &&
              publisher.stats(Encoding::Patch).patch_transactions == kFrames - 1,
          "a patch-only publisher still diffs (it keeps its own base)");
    check(nth_write(patch, 3) ==
              encode_transaction(make_patch(stamped(fed[0], 1, 1), stamped(fed[1], 2, 2))),
          "patch-only seq 2 is the patch from seq 1");
  }
}

// ----------------------------------------------------------------------------- full / patch chain

void test_full_and_patch_chain() {
  MemoryRecordSink full;
  MemoryRecordSink patch;
  full.open("memory://full");
  patch.open("memory://patch");
  Publisher publisher(&full, &patch);
  publisher.start(make_template());
  const std::vector<Snapshot> fed = publish_script(&publisher, 7);

  check(publisher.transactions(Encoding::Full) == kFrames &&
            publisher.transactions(Encoding::Patch) == kFrames,
        "both sinks advance together");

  Snapshot resolved;
  for (int i = 0; i < kFrames; ++i) {
    const std::uint64_t seq = static_cast<std::uint64_t>(i + 1);
    const Snapshot expected = stamped(fed[static_cast<std::size_t>(i)], seq, seq);
    const std::vector<std::uint8_t> full_bytes = nth_write(full, 2 + static_cast<std::size_t>(i));
    const std::vector<std::uint8_t> patch_bytes =
        nth_write(patch, 2 + static_cast<std::size_t>(i));
    const std::string at = " (seq " + std::to_string(seq) + ")";

    check(full_bytes == encode_transaction(make_full(expected)),
          "the full sink writes make_full(snapshot) every frame" + at);
    check(contains(full_bytes, "\"encoding\":\"full\",\"base_seq\":null"),
          "every full-sink transaction is full" + at);

    Transaction txn;
    if (i == 0) {
      txn = make_full(expected);
      check(contains(patch_bytes, "\"encoding\":\"full\",\"base_seq\":null"),
            "the patch sink's first transaction is full");
    } else {
      const Snapshot base = stamped(fed[static_cast<std::size_t>(i - 1)], seq - 1, seq - 1);
      txn = make_patch(base, expected);
      check(txn.base_seq.has_value() && *txn.base_seq == seq - 1, "base_seq = seq - 1" + at);
      check(contains(patch_bytes, "\"encoding\":\"patch\",\"base_seq\":" + std::to_string(seq - 1)),
            "the patch record says encoding patch, base_seq seq - 1" + at);
    }
    check(patch_bytes == encode_transaction(txn),
          "the patch sink writes make_full first, then make_patch(previous, snapshot)" + at);
    resolved = resolve(resolved, txn);
    check(same_state(resolved, expected),
          "resolving the patch chain equals the published full snapshot" + at);
  }

  // Frame 4 changed nothing: an empty patch (render-stream-1.md "Patch transactions").
  const Transaction unchanged = make_patch(stamped(fed[2], 3, 3), stamped(fed[3], 4, 4));
  check(unchanged.items.empty() && unchanged.canvases.empty() && unchanged.removed_items.empty() &&
            unchanged.removed_canvases.empty(),
        "an unchanged frame is an empty patch");
  check(nth_write(patch, 2 + 3) == encode_transaction(unchanged), "and that is what was written");
  // Frame 2 moved A only: one item entry, commands null.
  const Transaction moved = make_patch(stamped(fed[0], 1, 1), stamped(fed[1], 2, 2));
  check(moved.items.size() == 1 && moved.items[0].commands_null, "a transform-only patch");
  // Frame 5's tie is in the mirror's unsupported list and so on both sinks.
  check(contains(nth_write(full, 2 + 4), "\"reason\":\"draw-index-tie\"") &&
            contains(nth_write(patch, 2 + 4), "\"reason\":\"draw-index-tie\""),
        "the mirror's draw-index-tie entry reaches both sinks");
  check(!contains(nth_write(patch, 2 + 5), "draw-index-tie"), "and is gone once resolved");

  check(publisher.finish(EndReason::Shutdown), "finish()");
  check(full.was_closed && patch.was_closed, "finish() closes both sinks");
  check(publisher.finish(EndReason::Shutdown) && full.writes.size() == 2 + kFrames + 1,
        "a second finish() writes nothing");
}

// ----------------------------------------------------------------------------- stats

void check_stats(const MemoryRecordSink &sink, const Publisher &publisher, Encoding encoding,
                 std::uint64_t snapshot_ns_each) {
  const std::string name = encoding == Encoding::Full ? "full" : "patch";
  const EndStats &stats = publisher.stats(encoding);
  const std::size_t n = sink.writes.size();
  check(n == 2 + kFrames + 1, name + ": magic, session, one record per frame, end");
  check(stats.bytes_total == sink.bytes.size() - sink.writes[n - 1],
        name + ": bytes_total is every byte written minus the end record (magic included)");
  std::uint64_t max_record = 0;
  for (std::size_t i = 1; i + 1 < n; ++i) {
    max_record = std::max<std::uint64_t>(max_record, sink.writes[i]);
  }
  check(stats.max_record_bytes == max_record,
        name + ": max_record_bytes over the session and transaction records");
  check(stats.snapshot_ns_total == snapshot_ns_each * kFrames,
        name + ": snapshot_ns_total sums the shared copy time");
  check(stats.full_transactions + stats.patch_transactions == publisher.transactions(encoding),
        name + ": full + patch == transactions");
  check(sink.flush_count == 1 + kFrames + 1, name + ": one flush per record write");

  End end;
  end.transactions = publisher.transactions(encoding);
  end.reason = EndReason::Disarm;
  end.stats = stats;
  check(nth_write(sink, n - 1) == encode_end(end), name + ": the end record carries those stats");
}

void test_per_sink_stats() {
  MemoryRecordSink full;
  MemoryRecordSink patch;
  full.open("memory://full");
  patch.open("memory://patch");
  Publisher publisher(&full, &patch);
  publisher.start(make_template());
  publish_script(&publisher, 1000);
  publisher.finish(EndReason::Disarm);

  check_stats(full, publisher, Encoding::Full, 1000);
  check_stats(patch, publisher, Encoding::Patch, 1000);
  const EndStats &fs = publisher.stats(Encoding::Full);
  const EndStats &ps = publisher.stats(Encoding::Patch);
  check(fs.full_transactions == kFrames && fs.patch_transactions == 0,
        "full sink: every transaction full");
  check(ps.full_transactions == 1 && ps.patch_transactions == kFrames - 1,
        "patch sink: one full, then patches");
  check(fs.diff_ns_total == 0, "full sink: diff_ns_total 0");
  check(ps.diff_ns_total > 0, "patch sink: diff_ns_total measures make_patch");
  check(ps.bytes_total < fs.bytes_total, "the patch recording is smaller");
}

// ----------------------------------------------------------------------------- sabotage

// One top-level item with one rect whose origin.x is `x` (rs0_codec_test's publisher fixture).
Snapshot one_item(float x) {
  Snapshot s;
  CanvasState root;
  root.id = kRootCanvasId;
  root.origin = Origin::RootQuery;
  root.role = CanvasRole::Root;
  root.attached = true;
  root.items = {1};
  ItemState it;
  it.id = 1;
  it.parent = {ParentKind::Canvas, kRootCanvasId};
  it.xform = {1, 0, 0, 1, x, 0};
  Command c;
  c.rect = kRect;
  c.color = kRed;
  it.commands = {c};
  it.content_version = 1;
  s.canvases = {root};
  s.items = {it};
  return s;
}

void test_freeze_frame() {
  MemoryRecordSink full;
  MemoryRecordSink patch;
  full.open("memory://full");
  patch.open("memory://patch");
  SabotageConfig sabotage;
  sabotage.kind = SabotageKind::FreezeFrame;
  sabotage.frame = 3;
  Publisher publisher(&full, &patch, sabotage);
  publisher.start(make_template());
  const float xs[] = {10.0f, 20.0f, 30.0f, 40.0f};
  for (std::uint64_t f = 1; f <= 4; ++f) {
    check(publisher.publish(one_item(xs[f - 1]), f, 0), "freeze: publish");
  }
  // Frames 3 and 4 republish frame 2's content with a fresh seq/frame, on both sinks.
  for (std::uint64_t f = 1; f <= 4; ++f) {
    const Snapshot expected = stamped(one_item(f >= 3 ? xs[1] : xs[f - 1]), f, f);
    check(nth_write(full, 1 + f) == encode_transaction(make_full(expected)),
          "freeze: full sink frame " + std::to_string(f));
    if (f >= 2) {
      const Snapshot base = stamped(one_item(f - 1 >= 3 ? xs[1] : xs[f - 2]), f - 1, f - 1);
      check(nth_write(patch, 1 + f) == encode_transaction(make_patch(base, expected)),
            "freeze: patch sink frame " + std::to_string(f));
    }
  }
  check(make_patch(stamped(one_item(xs[1]), 3, 3), stamped(one_item(xs[1]), 4, 4)).items.empty(),
        "freeze: frozen frames are empty patches");
}

void test_perturb_transform() {
  MemoryRecordSink full;
  MemoryRecordSink patch;
  full.open("memory://full");
  patch.open("memory://patch");
  SabotageConfig sabotage;
  sabotage.kind = SabotageKind::PerturbTransform;
  sabotage.frame = 3;
  Publisher publisher(&full, &patch, sabotage);
  publisher.start(make_template());
  for (std::uint64_t f = 1; f <= 3; ++f) {
    publisher.publish(one_item(static_cast<float>(f) * 10.0f), f, 0);
  }
  Snapshot perturbed = stamped(one_item(30.0f), 3, 3);
  perturbed.items[0].xform[4] += 1.0f;  // origin.x, from frame 3 on
  check(nth_write(full, 2) == encode_transaction(make_full(stamped(one_item(10.0f), 1, 1))) &&
            nth_write(full, 3) == encode_transaction(make_full(stamped(one_item(20.0f), 2, 2))),
        "perturb: frames before F unperturbed");
  check(nth_write(full, 4) == encode_transaction(make_full(perturbed)),
        "perturb: frame F origin.x shifted by +1.0 (full sink)");
  check(nth_write(patch, 4) ==
            encode_transaction(make_patch(stamped(one_item(20.0f), 2, 2), perturbed)),
        "perturb: the patch sink publishes the same perturbed copy");
}

void test_patch_drop_item() {
  constexpr std::uint64_t kDropFrame = 5;  // C re-parented and D created: several entries
  MemoryRecordSink full;
  MemoryRecordSink patch;
  full.open("memory://full");
  patch.open("memory://patch");
  SabotageConfig sabotage;
  sabotage.kind = SabotageKind::PatchDropItem;
  sabotage.frame = kDropFrame;
  Publisher publisher(&full, &patch, sabotage);
  publisher.start(make_template());
  const std::vector<Snapshot> fed = publish_script(&publisher);

  for (int i = 0; i < kFrames; ++i) {
    const std::uint64_t seq = static_cast<std::uint64_t>(i + 1);
    const Snapshot expected = stamped(fed[static_cast<std::size_t>(i)], seq, seq);
    const std::string at = " (frame " + std::to_string(seq) + ")";
    check(nth_write(full, 1 + seq) == encode_transaction(make_full(expected)),
          "patch-drop-item: the full sink is untouched" + at);
    Transaction txn = i == 0 ? make_full(expected)
                             : make_patch(stamped(fed[static_cast<std::size_t>(i - 1)], seq - 1,
                                                  seq - 1),
                                          expected);
    if (seq == kDropFrame) {
      check(txn.items.size() >= 2, "the drop frame's patch has several item entries");
      std::uint32_t highest = 0;
      for (const ItemEntry &e : txn.items) {
        highest = std::max(highest, e.state.id);
      }
      check(txn.items.back().state.id == highest, "the last entry is the highest id");
      check(highest == 4, "D (id 4) is the highest-id entry");
      txn.items.pop_back();
      check(nth_write(patch, 1 + seq) == encode_transaction(txn),
            "patch-drop-item: exactly the highest-id entry is left out at that frame");
    } else {
      check(nth_write(patch, 1 + seq) == encode_transaction(txn),
            "patch-drop-item: every other frame is the true patch" + at);
    }
  }
  // Frame 6 changes D (draw index), so the true diff carries D again; frame 6's patch is
  // against the true frame-5 snapshot, not the sabotaged transaction.
  const Transaction after = make_patch(stamped(fed[4], 5, 5), stamped(fed[5], 6, 6));
  bool has_d = false;
  for (const ItemEntry &e : after.items) {
    has_d = has_d || e.state.id == 4;
  }
  check(has_d, "the next patch is diffed against the true published snapshot");

  // A drop frame whose patch has no item entries drops nothing.
  MemoryRecordSink p2;
  p2.open("memory://patch-empty-drop");
  SabotageConfig empty_drop;
  empty_drop.kind = SabotageKind::PatchDropItem;
  empty_drop.frame = 4;  // frame 4 changes nothing
  Publisher publisher2(nullptr, &p2, empty_drop);
  publisher2.start(make_template());
  const std::vector<Snapshot> fed2 = publish_script(&publisher2);
  check(nth_write(p2, 1 + 4) ==
            encode_transaction(make_patch(stamped(fed2[2], 3, 3), stamped(fed2[3], 4, 4))),
        "patch-drop-item on an empty patch writes the empty patch");
}

// ----------------------------------------------------------------------------- parsing etc.

void test_parse_sabotage() {
  struct Case {
    const char *kind;
    const char *frame;
    const char *op;
    bool ok;
    SabotageKind expect;
    std::uint64_t expect_frame;
    const char *what;
  };
  const Case cases[] = {
      {nullptr, nullptr, nullptr, true, SabotageKind::None, 21, "unset kind: none"},
      {nullptr, "abc", "free", true, SabotageKind::None, 21, "unset kind ignores frame and op"},
      {"freeze-frame", nullptr, nullptr, true, SabotageKind::FreezeFrame, 21, "freeze-frame @21"},
      {"freeze-frame", "5", nullptr, true, SabotageKind::FreezeFrame, 5, "freeze-frame @5"},
      {"omit-update", "1", nullptr, true, SabotageKind::OmitUpdate, 1, "omit-update"},
      {"perturb-transform", "100", nullptr, true, SabotageKind::PerturbTransform, 100,
       "perturb-transform"},
      {"patch-drop-item", "51", nullptr, true, SabotageKind::PatchDropItem, 51, "patch-drop-item"},
      {"patch-drop-item", "51", "", true, SabotageKind::PatchDropItem, 51,
       "an empty op is no op"},
      {"omit-op", "81", "free", true, SabotageKind::OmitOp, 81, "omit-op free"},
      {"omit-op", nullptr, "canvas_item_set_visible", true, SabotageKind::OmitOp, 21,
       "omit-op canvas_item_set_visible @21"},
      {"omit-op", "81", nullptr, false, SabotageKind::None, 0, "omit-op without an op"},
      {"omit-op", "81", "", false, SabotageKind::None, 0, "omit-op with an empty op"},
      {"omit-op", "81", "Free", false, SabotageKind::None, 0, "omit-op op with uppercase"},
      {"omit-op", "81", "canvas-item", false, SabotageKind::None, 0, "omit-op op with '-'"},
      {"omit-op", "81", "free ", false, SabotageKind::None, 0, "omit-op op with a space"},
      {"freeze-frame", "5", "free", false, SabotageKind::None, 0, "op with freeze-frame"},
      {"omit-update", "5", "free", false, SabotageKind::None, 0, "op with omit-update"},
      {"patch-drop-item", "5", "free", false, SabotageKind::None, 0, "op with patch-drop-item"},
      {"drop-message", "5", nullptr, false, SabotageKind::None, 0, "drop-message is live-only"},
      {"ignore-credit", nullptr, nullptr, false, SabotageKind::None, 0, "ignore-credit"},
      {"stale-coalesce", nullptr, nullptr, false, SabotageKind::None, 0, "stale-coalesce"},
      {"not-a-real-kind", nullptr, nullptr, false, SabotageKind::None, 0, "unknown kind"},
      {"", nullptr, nullptr, false, SabotageKind::None, 0, "empty kind"},
      {"freeze-frame", "0", nullptr, false, SabotageKind::None, 0, "frame 0"},
      {"freeze-frame", "-3", nullptr, false, SabotageKind::None, 0, "negative frame"},
      {"freeze-frame", "+3", nullptr, false, SabotageKind::None, 0, "frame with '+'"},
      {"freeze-frame", "abc", nullptr, false, SabotageKind::None, 0, "non-numeric frame"},
      {"freeze-frame", "", nullptr, false, SabotageKind::None, 0, "empty frame"},
      {"freeze-frame", "3.5", nullptr, false, SabotageKind::None, 0, "fractional frame"},
      {"omit-op", "x", "free", false, SabotageKind::None, 0, "omit-op with a bad frame"},
  };
  for (const Case &c : cases) {
    const ParseResult r = parse_sabotage(c.kind, c.frame, c.op);
    const std::string what = std::string("parse_sabotage: ") + c.what;
    check(r.ok == c.ok, what + (c.ok ? " accepted" : " refused"));
    if (c.ok && r.ok) {
      check(r.config.kind == c.expect && r.config.frame == c.expect_frame, what + " (values)");
      const bool omit_op = c.expect == SabotageKind::OmitOp;
      check(omit_op ? r.config.op == c.op : r.config.op.empty(), what + " (op)");
    }
    if (!c.ok) {
      check(!r.error.empty(), what + " (error text)");
    }
  }
  check(parse_sabotage("stale-coalesce", nullptr, nullptr).error ==
            "live sabotage: no live adapter yet (G1c2)",
        "the live kinds name the missing live adapter");
}

void test_generate_id() {
  const std::string a = generate_id();
  const std::string b = generate_id();
  check(is_hex32(a) && is_hex32(b), "generate_id() is 32 lowercase hex");
  check(a != b, "two generate_id() calls differ");
}

void test_gate1_features() {
  const Features f = gate1_features();
  check(f.ops == std::vector<std::string>{"add_rect"}, "gate1_features().ops");
  check(f.item_state == golden::kFeatureItemState, "gate1_features().item_state");
  check(f.observed_unsupported_ops == golden::kFeatureObservedUnsupported,
        "gate1_features().observed_unsupported_ops");
  check(f.unobserved == golden::kFeatureUnobserved, "gate1_features().unobserved");
  check(f.publication == "snapshot-or-patch", "gate1_features().publication");
  for (const auto *list : {&f.ops, &f.item_state, &f.observed_unsupported_ops, &f.unobserved}) {
    check(std::is_sorted(list->begin(), list->end()), "gate1_features() arrays sorted");
  }
}

}  // namespace

int main() {
  test_start_two_sinks();
  test_sink_presence();
  test_full_and_patch_chain();
  test_per_sink_stats();
  test_freeze_frame();
  test_perturb_transform();
  test_patch_drop_item();
  test_parse_sabotage();
  test_generate_id();
  test_gate1_features();
  if (g_failures != 0) {
    std::fprintf(stderr, "rs1_publish_test: %d of %d checks failed\n", g_failures, g_checks);
    return 1;
  }
  std::printf("rs1_publish_test: all %d checks passed\n", g_checks);
  return 0;
}
