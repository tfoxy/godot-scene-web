// Unit tests for the render-stream/2 publisher (src/rs_publish.cpp), protocol/gate1-design.md
// "G1b2" and Q4 "Frame callback" (file sinks), gate2-design.md "G2b2" and Q4 "File sinks".
//
// Drives Publisher against two MemoryRecordSinks with snapshots taken from a real rs::Mirror,
// and checks every record byte for byte against rs2_codec/rs2_diff applied to the same
// snapshots: both sinks start with the /2 magic and their own session; the full sink holds only
// full transactions; the patch sink holds seq 1 full and patches with base_seq = seq - 1 after
// it, and resolving that patch chain reproduces every full state; the freeze-frame,
// perturb-transform and patch-drop-item sabotages; per-sink end stats; the parse_sabotage()
// accept/refuse matrix; and (G2b2) the store directory (content-addressed files, index,
// wrong-hash), inline resource records per sink, resource-store-missing and stale-texture.
// Byte-level golden compatibility of the codec and the diff themselves is rs2_codec_test's and
// rs2_diff_test's job.

#include <algorithm>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <sstream>
#include <string>
#include <vector>

#include "report.h"
#include "rs2_codec.h"
#include "rs2_diff.h"
#include "rs2_golden_states.h"
#include "rs2_snapshot.h"
#include "rs_mirror.h"
#include "rs_publish.h"
#include "rs_resource_store.h"
#include "rs_sha256.h"
#include "rs_texture_payload.h"

namespace {

using namespace grc::rs2;  // NOLINT
using grc::rs::Captured;
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
  Session tmpl = golden::golden_session(Encoding::Full, std::string(), kSessionId,
                                        Delivery::OutOfBand);
  tmpl.stream = StreamInfo();
  return tmpl;
}

// The golden session's resource policy: out of band, 16 MiB payloads, the gate 2 formats.
ResourcePolicy golden_policy(std::uint64_t inline_max_bytes = 0) {
  ResourcePolicy policy;
  policy.permitted_formats = golden::kPermittedFormats;
  policy.max_payload_bytes = 16777216;
  policy.inline_max_bytes = inline_max_bytes;
  return policy;
}

Captured captured(Snapshot s) {
  Captured c;
  c.state = std::move(s);
  return c;
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
    Captured s = m.snapshot(0, static_cast<std::uint64_t>(frame));
    fed.push_back(s.state);
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
  Publisher publisher(&full, &patch, SabotageConfig(), golden_policy());
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
  check(magic_bytes.size() == 8 && magic_bytes[3] == 0x32, "the /2 magic GRS2");
  check(nth_write(full, 0) == magic_bytes && nth_write(patch, 0) == magic_bytes,
        "both sinks start with the /2 magic");

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
    check(publisher.last_published() == nullptr, "no last_published() before the first publish");
    const std::vector<Snapshot> fed_full = publish_script(&publisher);
    // The live adapter (G1c2) delivers the same published copy, kept even without a patch sink.
    const Captured *last = publisher.last_published();
    check(last != nullptr && last->state.seq == kFrames &&
              encode_transaction(make_full(last->state)) ==
                  encode_transaction(
                      make_full(stamped(fed_full.back(), kFrames, last->state.frame))),
          "last_published() is the last published copy, seq and frame stamped");
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

  // Frame 4 changed nothing: an empty patch (render-stream-2.md "Full and patch transactions").
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
    check(publisher.publish(captured(one_item(xs[f - 1])), f, 0), "freeze: publish");
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
    publisher.publish(captured(one_item(static_cast<float>(f) * 10.0f)), f, 0);
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
      {"perturb-glyph", "41", nullptr, true, SabotageKind::PerturbGlyph, 41, "perturb-glyph"},
      {"perturb-vertex", "21", nullptr, true, SabotageKind::PerturbVertex, 21, "perturb-vertex"},
      {"perturb-vertex", "21", "canvas_item_add_line", false, SabotageKind::None, 0,
       "perturb-vertex with an op"},
      {"perturb-glyph", "41", "canvas_item_add_rect", false, SabotageKind::None, 0,
       "perturb-glyph with an op"},
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
      {"drop-message", "5", nullptr, true, SabotageKind::DropMessage, 5, "drop-message @5 (live)"},
      {"ignore-credit", "480", nullptr, true, SabotageKind::IgnoreCredit, 480,
       "ignore-credit @480 (live)"},
      {"stale-coalesce", nullptr, nullptr, true, SabotageKind::StaleCoalesce, 21,
       "stale-coalesce @21 (live)"},
      {"ignore-credit", "5", "free", false, SabotageKind::None, 0, "op with ignore-credit"},
      {"stale-texture", "61", nullptr, true, SabotageKind::StaleTexture, 61, "stale-texture @61"},
      {"wrong-hash", "61", nullptr, true, SabotageKind::WrongHash, 61, "wrong-hash @61"},
      {"spurious-texture-update", "21", nullptr, true, SabotageKind::SpuriousTextureUpdate, 21,
       "spurious-texture-update @21"},
      {"wrong-hash", "61", "free", false, SabotageKind::None, 0, "op with wrong-hash"},
      {"drop-resource", "61", nullptr, true, SabotageKind::DropResource, 61,
       "drop-resource (G2c2)"},
      {"unpin", "361", nullptr, true, SabotageKind::Unpin, 361, "unpin (G2c2)"},
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
}

void test_generate_id() {
  const std::string a = generate_id();
  const std::string b = generate_id();
  check(is_hex32(a) && is_hex32(b), "generate_id() is 32 lowercase hex");
  check(a != b, "two generate_id() calls differ");
}

void test_gate2_features() {
  const Features f = gate2_features();
  check(f.ops == golden::kFeatureOps, "gate2_features().ops");
  check(f.item_state == golden::kFeatureItemState, "gate2_features().item_state");
  // golden::kFeatureResources stays golden-2's frozen {"texture_2d", "texture_2d_placeholder"}
  // (protocol/golden-2/make_golden.py: "canvas_texture is added from G2d on, not here"), so the
  // live production list is checked against its own up-to-date literal instead.
  const std::vector<std::string> expected_resources = {"canvas_texture", "texture_2d",
                                                        "texture_2d_placeholder"};
  check(f.resources == expected_resources, "gate2_features().resources");
  // golden::kFeatureObservedUnsupported stays golden-2's frozen pre-G5a list (its bytes are
  // committed); gate5-design.md D2's calibrator 7 adds four more typed refusals to the live
  // production list, checked against its own up-to-date literal, as `resources` above.
  const std::vector<std::string> expected_observed_unsupported = {
      "canvas_item_add_animation_slice",
      "canvas_item_add_circle",
      "canvas_item_add_clip_ignore",
      "canvas_item_add_lcd_texture_rect_region",
      "canvas_item_add_line",
      "canvas_item_add_mesh",
      "canvas_item_add_msdf_texture_rect_region",
      "canvas_item_add_multiline",
      "canvas_item_add_multimesh",
      "canvas_item_add_nine_patch",
      "canvas_item_add_particles",
      "canvas_item_add_polygon",
      "canvas_item_add_polyline",
      "canvas_item_add_primitive",
      "canvas_item_add_set_transform",
      "canvas_item_add_triangle_array",
      "canvas_item_attach_skeleton",
      "canvas_item_set_material"};
  check(f.observed_unsupported_ops == expected_observed_unsupported,
        "gate2_features().observed_unsupported_ops");
  check(f.unobserved == golden::kFeatureUnobserved, "gate2_features().unobserved");
  check(f.publication == "snapshot-or-patch", "gate2_features().publication");
  check(f.unsupported_resources.empty(), "gate2_features(): a rendered host refuses nothing");
  // protocol/canvas-texture-headless.md: a headless host refuses canvas_texture, typed.
  const Features h = gate2_features(true);
  check(h.resources == golden::kFeatureResources,
        "gate2_features(headless).resources: texture_2d and texture_2d_placeholder only");
  check(h.unsupported_resources.size() == 1 &&
            h.unsupported_resources[0].resource == "canvas_texture" &&
            h.unsupported_resources[0].reason == "canvas-texture-headless",
        "gate2_features(headless).unsupported_resources: canvas_texture, canvas-texture-headless");
  for (const auto *list :
       {&f.ops, &f.item_state, &f.resources, &f.observed_unsupported_ops, &f.unobserved}) {
    check(std::is_sorted(list->begin(), list->end()), "gate2_features() arrays sorted");
  }
}

// G4e2 (render-stream-3.md "File layout", "Features"): a V3 template starts every sink with the
// GRS3 magic and a "render-stream/3" session; the V3 feature lists move the msdf op from
// observed_unsupported_ops into ops.
void test_start_v3() {
  MemoryRecordSink full;
  MemoryRecordSink patch;
  full.open("memory://full");
  patch.open("memory://patch");
  Publisher publisher(&full, &patch, SabotageConfig(), golden_policy());
  Session tmpl = make_template();
  tmpl.version = ProtocolVersion::V3;
  tmpl.features = gate2_features(true, ProtocolVersion::V3);
  check(publisher.start(tmpl), "start() with a V3 template");
  const std::vector<std::uint8_t> magic3 = magic(ProtocolVersion::V3);
  check(magic3.size() == 8 && magic3[3] == 0x33, "the /3 magic GRS3");
  check(nth_write(full, 0) == magic3 && nth_write(patch, 0) == magic3,
        "both sinks start with the /3 magic");
  check(contains(nth_write(full, 1), "\"protocol\":\"render-stream/3\"") &&
            contains(nth_write(patch, 1), "\"protocol\":\"render-stream/3\""),
        "both session records say render-stream/3");
  check(contains(nth_write(full, 1), "\"add_msdf_texture_rect_region\""),
        "the session's ops name the msdf command");
}

// G5d (render-stream-4.md "File layout", "Features"): a V4 template starts every sink with GRS4
// and a "render-stream/4" session (resources.payloads, the fifteen ops); a mirror snapshot with
// /4 commands publishes as a five-block transaction whose cmd_i32 holds the triangle indices.
void test_start_v4() {
  MemoryRecordSink full;
  MemoryRecordSink patch;
  full.open("memory://full");
  patch.open("memory://patch");
  Publisher publisher(&full, &patch, SabotageConfig(), golden_policy());
  Session tmpl = make_template();
  tmpl.version = ProtocolVersion::V4;
  tmpl.features = gate2_features(true, ProtocolVersion::V4);
  check(publisher.start(tmpl), "start() with a V4 template");
  const std::vector<std::uint8_t> magic4 = magic(ProtocolVersion::V4);
  check(magic4.size() == 8 && magic4[3] == 0x34, "the /4 magic GRS4");
  check(nth_write(full, 0) == magic4 && nth_write(patch, 0) == magic4,
        "both sinks start with the /4 magic");
  check(contains(nth_write(full, 1), "\"protocol\":\"render-stream/4\"") &&
            contains(nth_write(full, 1), "\"payloads\":[\"render-stream-mesh/1\""),
        "the session says render-stream/4 with resources.payloads");
  Mirror m;
  m.reset();
  m.set_root(0x1000, 0x2000, kIdentityXform);
  m.canvas_item_create(100, 1);
  m.set_parent(100, 0x2000, 1);
  m.add_set_transform(100, {2, 0, 0, 2, 4, 0}, 1);
  m.add_triangle_array(100, {0, 1, 2}, {{0, 0}, {8, 0}, {0, 8}}, {{1, 0, 0, 1}}, {}, false, 0, -1,
                       1);
  m.add_clip_ignore(100, true, 1);
  check(publisher.publish(m.snapshot(0, 1), 1, 0), "a /4 snapshot publishes");
  const std::vector<std::uint8_t> txn = nth_write(full, 2);
  check(contains(txn, "\"op\":\"add_set_transform\"") &&
            contains(txn, "\"op\":\"add_triangle_array\"") &&
            contains(txn, "\"op\":\"add_clip_ignore\",\"ignore\":true") &&
            contains(txn, "\"cmd_i32\"") && contains(txn, "\"meshes\":[]"),
        "the transaction carries the /4 commands, cmd_i32 and an empty mesh table");
}

void test_gate2_features_v4() {
  const Features v3 = gate2_features(true, ProtocolVersion::V3);
  const Features v4 = gate2_features(true, ProtocolVersion::V4);
  const Features v4r = gate2_features(false, ProtocolVersion::V4);
  check(v4.ops.size() == 15 && std::is_sorted(v4.ops.begin(), v4.ops.end()) &&
            std::find(v4.ops.begin(), v4.ops.end(), "add_clip_ignore") != v4.ops.end() &&
            std::find(v4.ops.begin(), v4.ops.end(), "add_msdf_texture_rect_region") !=
                v4.ops.end(),
        "V4 ops: fifteen, sorted, /3's four included");
  const std::vector<std::string> observed = {
      "canvas_item_add_animation_slice", "canvas_item_add_lcd_texture_rect_region",
      "canvas_item_add_multimesh",       "canvas_item_add_particles",
      "canvas_item_attach_skeleton",     "canvas_item_set_material"};
  check(v4.observed_unsupported_ops == observed, "V4 observed_unsupported_ops: the six refused");
  check(v4.resources == std::vector<std::string>{"mesh", "texture_2d", "texture_2d_placeholder"} &&
            v4r.resources == std::vector<std::string>{"canvas_texture", "mesh", "texture_2d",
                                                      "texture_2d_placeholder"},
        "V4 resources gain mesh");
  check(v4.unobserved.size() == v3.unobserved.size() + 2 &&
            std::is_sorted(v4.unobserved.begin(), v4.unobserved.end()) &&
            v4.unobserved.back() == "viewport_set_snap_2d_vertices_to_pixel",
        "V4 unobserved gains the two snap settings, sorted");
  check(v4.item_state == v3.item_state, "V4 item_state is /3's");
}

void test_gate2_features_v3() {
  const Features v2 = gate2_features(true);
  const Features v3 = gate2_features(true, ProtocolVersion::V3);
  const std::vector<std::string> ops = {"add_msdf_texture_rect_region", "add_rect",
                                        "add_texture_rect", "add_texture_rect_region"};
  check(v3.ops == ops, "V3 ops: /2's three plus add_msdf_texture_rect_region, sorted");
  std::vector<std::string> observed = v2.observed_unsupported_ops;
  observed.erase(std::find(observed.begin(), observed.end(),
                           "canvas_item_add_msdf_texture_rect_region"));
  check(v3.observed_unsupported_ops == observed &&
            v3.observed_unsupported_ops.size() + 1 == v2.observed_unsupported_ops.size(),
        "V3 observed_unsupported_ops: /2's without the msdf method");
  check(v3.item_state == v2.item_state && v3.resources == v2.resources &&
            v3.unobserved == v2.unobserved &&
            v3.unsupported_resources.size() == v2.unsupported_resources.size(),
        "every other V3 list is /2's");
  for (const auto *list : {&v3.ops, &v3.observed_unsupported_ops}) {
    check(std::is_sorted(list->begin(), list->end()), "V3 arrays sorted");
  }
}

void test_resources_info() {
  const ResourcesInfo oob = resources_info(golden_policy(0), Fetch::Directory);
  check(oob.delivery == Delivery::OutOfBand && oob.fetch == Fetch::Directory &&
            !oob.has_http_path && oob.auth == Auth::None,
        "inline_max 0: out-of-band, directory");
  const ResourcesInfo mixed = resources_info(golden_policy(4096), Fetch::Directory);
  check(mixed.delivery == Delivery::Mixed && mixed.fetch == Fetch::Directory,
        "0 < inline_max < max_payload: mixed");
  const ResourcesInfo all_inline = resources_info(golden_policy(16777216), Fetch::Http);
  check(all_inline.delivery == Delivery::Inline && all_inline.fetch == Fetch::None &&
            !all_inline.has_http_path,
        "inline_max >= max_payload: inline, fetch none (no http path advertised)");
  const ResourcesInfo http = resources_info(golden_policy(0), Fetch::Http);
  check(http.fetch == Fetch::Http && http.has_http_path && http.http_path == "/resources/sha256/",
        "an out-of-band live stream advertises the http path");
  Session expected = golden::golden_session(Encoding::Full, std::string(32, '1'), kSessionId,
                                            Delivery::OutOfBand);
  Session built = expected;
  built.resources = oob;
  check(encode_session(built) == encode_session(expected),
        "the golden out-of-band session's resources object, byte for byte");
}

// ----------------------------------------------------------------------------- resources (G2b2)

grc::rs::PayloadCopy texture_copy(std::int64_t w, std::int64_t h, std::uint8_t value,
                                  grc::rs::PayloadPtr *bytes) {
  const std::vector<std::uint8_t> data(static_cast<std::size_t>(w * h * 4), value);
  grc::rs::PayloadCopy copy;
  copy.status = "ok";
  copy.format = 5;
  copy.width = w;
  copy.height = h;
  copy.mipmaps_known = true;
  copy.mipmaps = false;
  copy.data_bytes = static_cast<std::int64_t>(data.size());
  auto payload = std::make_shared<grc::rs::PayloadBytes>(
      grc::rs::encode_payload(5, w, h, false, data.data(), data.size()));
  copy.payload_bytes = static_cast<std::int64_t>(payload->size());
  copy.hash = grc::sha256_hex(payload->data(), payload->size());
  *bytes = payload;
  return copy;
}

// A textured scene: frame 1 creates A (4x4, 10s) and a 2x2 B (20s) drawn by one item each; frame
// 2 moves the A drawer (transform only); frame 3 updates A to 30s; frame 4 creates C (8x8) and
// draws it; frame 5 changes nothing.
struct TextureScene {
  Mirror m;
  std::string hash_a0, hash_a1, hash_b, hash_c;
  std::uint64_t bytes_a0 = 0, bytes_b = 0;

  TextureScene() {
    m.reset();
    m.set_root(kRootViewport, kRootCanvas, kIdentityXform);
  }
  Captured frame(int f) {
    const std::uint64_t u = static_cast<std::uint64_t>(f);
    grc::rs::PayloadPtr bytes;
    if (f == 1) {
      auto a = texture_copy(4, 4, 10, &bytes);
      hash_a0 = a.hash;
      bytes_a0 = bytes->size();
      m.texture_2d_create(500, a, bytes, u);
      auto b = texture_copy(2, 2, 20, &bytes);
      hash_b = b.hash;
      bytes_b = bytes->size();
      m.texture_2d_create(501, b, bytes, u);
      m.canvas_item_create(100, u);
      m.set_parent(100, kRootCanvas, u);
      m.add_texture_rect(100, kRect, 500, false, kRed, false, u);
      m.canvas_item_create(101, u);
      m.set_parent(101, kRootCanvas, u);
      m.set_draw_index(101, 1, u);
      m.add_texture_rect(101, kRect, 501, false, kRed, false, u);
    } else if (f == 2) {
      m.set_transform(100, {1, 0, 0, 1, 8, 0}, u);
    } else if (f == 3) {
      auto a1 = texture_copy(4, 4, 30, &bytes);
      hash_a1 = a1.hash;
      m.texture_2d_update(500, a1, bytes, 0, u);
    } else if (f == 4) {
      auto c = texture_copy(8, 8, 40, &bytes);
      hash_c = c.hash;
      m.texture_2d_create(502, c, bytes, u);
      m.add_texture_rect(101, kRect, 502, false, kRed, false, u);
    }
    return m.snapshot(0, u);
  }
};

std::string tmp_dir(const std::string &name) {
  const std::string dir = std::string(GRC_TEST_TMP_DIR) + "/" + name;
  const int removed = std::system(("rm -rf '" + dir + "'").c_str());
  check(removed == 0, "clean " + dir);
  return dir;
}

std::vector<std::uint8_t> read_bytes(const std::string &path) {
  std::ifstream in(path, std::ios::binary);
  return std::vector<std::uint8_t>((std::istreambuf_iterator<char>(in)),
                                   std::istreambuf_iterator<char>());
}

std::string read_text(const std::string &path) {
  std::ifstream in(path);
  std::stringstream text;
  text << in.rdbuf();
  return text.str();
}

std::string sha_of(const std::vector<std::uint8_t> &bytes) {
  return grc::sha256_hex(bytes.data(), bytes.size());
}

// The record types of a sink's writes after magic and session: 'r' resource, 't' transaction.
std::string record_kinds(const MemoryRecordSink &sink) {
  std::string out;
  for (std::size_t i = 2; i < sink.writes.size(); ++i) {
    const std::vector<std::uint8_t> bytes = nth_write(sink, i);
    out.push_back(contains(bytes, "\"type\":\"resource\"")      ? 'r'
                  : contains(bytes, "\"type\":\"transaction\"") ? 't'
                                                                  : 'e');
  }
  return out;
}

void test_store_directory() {
  const std::string dir = tmp_dir("store");
  grc::rs::ResourceStore store;
  std::string error;
  check(store.open(dir, &error), "store opens: " + error);
  MemoryRecordSink full;
  MemoryRecordSink patch;
  full.open("memory://full");
  patch.open("memory://patch");
  Publisher publisher(&full, &patch, SabotageConfig(), golden_policy(0), &store);
  std::vector<std::string> events;
  publisher.set_resource_events([&events](const char *op, const std::string &hash,
                                          std::uint64_t, bool ok, std::uint64_t frame) {
    events.push_back(std::string(op) + ":" + hash.substr(0, 8) + ":" + (ok ? "ok" : "failed") +
                     "@" + std::to_string(frame));
  });
  check(publisher.start(make_template()), "start with a store");
  TextureScene scene;
  for (int f = 1; f <= 5; ++f) {
    check(publisher.publish(scene.frame(f), static_cast<std::uint64_t>(f), 0),
          "publish with a store, frame " + std::to_string(f));
  }
  publisher.finish(EndReason::Shutdown);
  check(record_kinds(full) == "ttttte" && record_kinds(patch) == "ttttte",
        "out of band: no resource record in either sink");
  check(publisher.stats(Encoding::Full).resource_records == 0, "resource_records 0");
  check(store.hashes() == 4, "the store holds every ok hash ever published (A0, B, A1, C)");
  for (const std::string &hash : {scene.hash_a0, scene.hash_b, scene.hash_a1, scene.hash_c}) {
    const std::vector<std::uint8_t> file = read_bytes(dir + "/sha256/" + hash + ".grt");
    check(!file.empty() && sha_of(file) == hash, "store file " + hash.substr(0, 8) +
                                                     " hashes to its name");
  }
  const std::string index = read_text(dir + "/index.jsonl");
  check(index.find("{\"hash\":\"" + scene.hash_a0 + "\",\"bytes\":" +
                   std::to_string(scene.bytes_a0) +
                   ",\"format\":\"RGBA8\",\"width\":4,\"height\":4,\"mipmaps\":false,"
                   "\"first_frame\":1}") != std::string::npos,
        "index.jsonl names hash, bytes, shape and first frame");
  check(index.find("\"first_frame\":3}") != std::string::npos &&
            index.find("\"first_frame\":4}") != std::string::npos,
        "later hashes are stored at their first publication");
  check(events.size() == 4 && events[0] == "store:" + scene.hash_a0.substr(0, 8) + ":ok@1",
        "one store event per stored hash");
}

void test_inline_records() {
  MemoryRecordSink full;
  MemoryRecordSink patch;
  full.open("memory://full");
  patch.open("memory://patch");
  // A threshold between B's payload and A's: mixed delivery, so B and nothing else goes inline,
  // and the larger payloads need a store.
  TextureScene probe;
  probe.frame(1);
  const std::uint64_t threshold = probe.bytes_b;
  check(probe.bytes_b < probe.bytes_a0, "B's payload is the smaller one");
  const std::string dir = tmp_dir("inline-store");
  grc::rs::ResourceStore store;
  std::string error;
  store.open(dir, &error);
  Publisher publisher(&full, &patch, SabotageConfig(), golden_policy(threshold), &store);
  publisher.start(make_template());
  check(publisher.session(Encoding::Full).resources.delivery == Delivery::Mixed,
        "a mixed session");
  TextureScene scene;
  for (int f = 1; f <= 5; ++f) {
    publisher.publish(scene.frame(f), static_cast<std::uint64_t>(f), 0);
  }
  publisher.finish(EndReason::Shutdown);
  check(record_kinds(full) == "rttttte" && record_kinds(patch) == "rttttte",
        "each sink carries B inline once, before the first transaction naming it");
  check(publisher.stats(Encoding::Full).resource_records == 1 &&
            publisher.stats(Encoding::Full).resource_bytes == probe.bytes_b &&
            publisher.stats(Encoding::Patch).resource_records == 1,
        "per-sink resource_records/resource_bytes");
  check(store.hashes() == 4, "the store still holds every hash (mixed: the store is complete)");

  // Every payload inline: no store needed, A1 and C arrive before their first transaction.
  MemoryRecordSink f2;
  f2.open("memory://inline");
  Publisher all_inline(&f2, nullptr, SabotageConfig(), golden_policy(16777216), nullptr);
  all_inline.start(make_template());
  TextureScene scene2;
  for (int f = 1; f <= 5; ++f) {
    check(all_inline.publish(scene2.frame(f), static_cast<std::uint64_t>(f), 0),
          "inline publish without a store");
  }
  all_inline.finish(EndReason::Shutdown);
  check(record_kinds(f2) == "rrttrtrtte", "A0, B; seq 1, 2; A1; seq 3; C; seq 4, 5; end");
  const EndStats &stats = all_inline.stats(Encoding::Full);
  check(stats.bytes_total == f2.bytes.size() - f2.writes.back() &&
            stats.resource_records == 4,
        "bytes_total counts resource records; resource_records 4");
  std::uint64_t max_record = 0;
  for (std::size_t i = 1; i + 1 < f2.writes.size(); ++i) {
    max_record = std::max<std::uint64_t>(max_record, f2.writes[i]);
  }
  check(stats.max_record_bytes == max_record, "max_record_bytes includes resource records");
  check(all_inline.session(Encoding::Full).resources.fetch == Fetch::None, "inline: fetch none");

  // Out of band with no store: resource-store-missing at the first publish.
  MemoryRecordSink f3;
  f3.open("memory://missing");
  Publisher missing(&f3, nullptr, SabotageConfig(), golden_policy(0), nullptr);
  missing.start(make_template());
  TextureScene scene3;
  check(!missing.publish(scene3.frame(1), 1, 0) &&
            missing.error().rfind("resource-store-missing", 0) == 0,
        "an out-of-band payload with no store is resource-store-missing");
}

void test_wrong_hash() {
  const std::string dir = tmp_dir("wrong-hash");
  grc::rs::ResourceStore store;
  std::string error;
  store.open(dir, &error);
  MemoryRecordSink full;
  full.open("memory://full");
  SabotageConfig sabotage;
  sabotage.kind = SabotageKind::WrongHash;
  sabotage.frame = 3;
  Publisher publisher(&full, nullptr, sabotage, golden_policy(0), &store);
  publisher.start(make_template());
  TextureScene scene;
  for (int f = 1; f <= 5; ++f) {
    publisher.publish(scene.frame(f), static_cast<std::uint64_t>(f), 0);
  }
  check(store.corrupted_hash() == scene.hash_a1,
        "wrong-hash corrupts the first hash first stored at or after the frame (A1)");
  const std::vector<std::uint8_t> a1 = read_bytes(dir + "/sha256/" + scene.hash_a1 + ".grt");
  const std::vector<std::uint8_t> c = read_bytes(dir + "/sha256/" + scene.hash_c + ".grt");
  check(!a1.empty() && sha_of(a1) != scene.hash_a1, "the corrupted file no longer hashes to its name");
  check(sha_of(c) == scene.hash_c, "later hashes are stored intact");
  const std::size_t offset = grc::rs::ResourceStore::first_data_offset(a1);
  check(offset > 12 && a1[offset] == static_cast<std::uint8_t>(30 ^ 0xFF) &&
            a1[offset + 1] == 30,
        "exactly the first data byte is flipped");
}

void test_stale_texture() {
  MemoryRecordSink full;
  full.open("memory://full");
  const std::string dir = tmp_dir("stale");
  grc::rs::ResourceStore store;
  std::string error;
  store.open(dir, &error);
  SabotageConfig sabotage;
  sabotage.kind = SabotageKind::StaleTexture;
  sabotage.frame = 3;
  Publisher publisher(&full, nullptr, sabotage, golden_policy(0), &store);
  publisher.start(make_template());
  TextureScene scene;
  std::vector<Captured> fed;
  for (int f = 1; f <= 5; ++f) {
    fed.push_back(scene.frame(f));
    publisher.publish(fed.back(), static_cast<std::uint64_t>(f), 0);
  }
  check(publisher.stale_texture_id() == 1, "stale-texture froze texture 1 (A, updated at frame 3)");
  const Captured *last = publisher.last_published();
  const TextureEntry &a = last->state.textures[0];
  check(a.id == 1 && a.version == 1 && a.hash == scene.hash_a0 &&
            last->payloads.count(scene.hash_a0) == 1 && last->payloads.count(scene.hash_a1) == 0,
        "the published copy keeps A's pre-change version, hash and payload");
  check(fed.back().state.textures[0].version == 2, "while the mirror itself moved on");
  check(!store.has(scene.hash_a1), "the stale version's successor is never stored");
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
  test_gate2_features();
  test_gate2_features_v3();
  test_start_v3();
  test_gate2_features_v4();
  test_start_v4();
  test_resources_info();
  test_store_directory();
  test_inline_records();
  test_wrong_hash();
  test_stale_texture();
  if (g_failures != 0) {
    std::fprintf(stderr, "rs_publish_test: %d of %d checks failed\n", g_failures, g_checks);
    return 1;
  }
  std::printf("rs_publish_test: all %d checks passed\n", g_checks);
  return 0;
}
