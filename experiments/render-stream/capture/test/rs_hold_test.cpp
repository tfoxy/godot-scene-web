#include "rs_hold.h"
#include "rs_json_lite.h"

#include <cstdio>
#include <limits>

namespace {
using namespace grc::rs;
using json_lite::JValue;
int checks = 0, failures = 0;
void expect(bool ok, int line) {
  ++checks;
  if (!ok) { std::fprintf(stderr, "FAIL rs_hold_test.cpp:%d\n", line); ++failures; }
}
#define EXPECT(ok) expect((ok), __LINE__)
const JValue &field(const JValue &v, const char *key) {
  static const JValue missing;
  const auto *p = v.get(key);
  EXPECT(p != nullptr);
  return p ? *p : missing;
}
void policy() {
  EXPECT(kHoldTextureMaxBytes == 1572864);
  EXPECT(kHoldTotalMaxBytes == 16777216);
  EXPECT(kHoldPendingMaxEntries == 64);
  EXPECT(kHoldPendingMaxBytes == 4194304);
  // Exhaust competing conditions to pin the decision's precedence.
  for (bool image : {false, true}) for (bool facts : {false, true})
    for (const auto format : {-1, 0, 16, 17, 38, 39})
      for (const auto bytes : {-1, 0, 1, 1572864, 1572865}) {
        HoldSkip want = HoldSkip::None;
        if (!image) want = HoldSkip::NoImage;
        else if (!facts || bytes <= 0) want = HoldSkip::SizeUnknown;
        else if (format >= 17 && format <= 38) want = HoldSkip::VramFormat;
        else if (bytes > 1572864) want = HoldSkip::OverTextureCap;
        EXPECT(hold_image_decision(image, facts, format, bytes) == want);
      }
  EXPECT(hold_total_ok(16777216, 1572864, 1572864));
  EXPECT(!hold_total_ok(16777216, 1572863, 1572864));
  EXPECT(hold_total_ok(0, 0, 16777216));
  EXPECT(!hold_total_ok(0, 0, 16777217));
  EXPECT(!hold_total_ok(0, 1, 1));
  EXPECT(!hold_total_ok(0, 0, std::numeric_limits<std::uint64_t>::max()));
  EXPECT(!pending_evictions_needed(63, 4194303, 1));
  EXPECT(pending_evictions_needed(64, 0, 1));
  EXPECT(pending_evictions_needed(0, 4194304, 1));
  EXPECT(!pending_evictions_needed(0, 0, 4194304));
  EXPECT(pending_evictions_needed(0, 0, std::numeric_limits<std::uint64_t>::max()));
  hold_set_active(false); EXPECT(!hold_active());
  hold_set_active(true); EXPECT(hold_active());
  hold_set_active(false); EXPECT(!hold_active());
}
HoldStats honest() {
  HoldStats s;
  s.live = {2, 20}; s.peak = {8, 80};
  s.taken = {8, 3, 5, 80}; s.dropped.fill(1); s.dropped_bytes = 60;
  auto &p = s.pending;
  p.live = {2, 20}; p.peak = {8, 80}; p.taken = 8; p.taken_bytes = 80;
  p.moved = 1; p.moved_bytes = 10; p.dropped.fill(1); p.dropped_bytes = 40;
  p.evicted = 1; p.evicted_bytes = 10;
  return s;
}
void balances() {
  EXPECT(hold_balanced(HoldStats{})); EXPECT(pending_balanced(HoldStats{}.pending));
  const auto s = honest();
  EXPECT(hold_balanced(s)); EXPECT(pending_balanced(s.pending));
  for (int i = 0; i < 14; ++i) {
    auto bad = s;
    if (i == 0) ++bad.taken.total;
    if (i == 1) ++bad.taken.update;
    if (i == 2) ++bad.taken.replace;
    if (i == 3) ++bad.taken.bytes;
    if (i == 4) ++bad.live.entries;
    if (i == 5) ++bad.live.bytes;
    if (i == 6) ++bad.dropped_bytes;
    if (i >= 7 && i < 13) ++bad.dropped[static_cast<std::size_t>(i - 7)];
    if (i == 13) bad.peak.bytes = 16777217;
    EXPECT(!hold_balanced(bad));
  }
  auto over = s;
  over.live.bytes = 16777217; over.taken.bytes = over.live.bytes + over.dropped_bytes;
  EXPECT(!hold_balanced(over));
  for (int i = 0; i < 17; ++i) {
    auto bad = s.pending;
    if (i == 0) ++bad.taken;
    if (i == 1) ++bad.taken_bytes;
    if (i == 2) ++bad.moved;
    if (i == 3) ++bad.moved_bytes;
    if (i == 4) ++bad.evicted;
    if (i == 5) ++bad.evicted_bytes;
    if (i == 6) ++bad.live.entries;
    if (i == 7) ++bad.live.bytes;
    if (i == 8) ++bad.dropped_bytes;
    if (i >= 9 && i < 13) ++bad.dropped[static_cast<std::size_t>(i - 9)];
    if (i == 13) { bad.live.entries = 65; bad.taken += 63; }
    if (i == 14) { bad.live.bytes = 4194305; bad.taken_bytes += 4194285; }
    if (i == 15) bad.peak.entries = 65;
    if (i == 16) bad.peak.bytes = 4194305;
    EXPECT(!pending_balanced(bad));
  }
}
void evidence() {
  auto s = honest();
  const char *skips[] = {"none", "unregistered", "not_texture2d", "offmain_replace", "released_source",
      "vram_format", "no_image", "size_unknown", "shape_mismatch", "over_texture_cap", "over_total_cap"};
  const char *drops[] = {"superseded", "unheld", "freed", "recreated", "replaced_away", "fault"};
  const char *pending_drops[] = {"freed", "updated", "replaced", "recreated"};
  for (std::size_t i = 0; i < s.skipped.size(); ++i) {
    EXPECT(std::string(hold_skip_name(static_cast<HoldSkip>(i))) == skips[i]);
    s.skipped[i] = 100 + i; s.pending.skipped[i] = 200 + i;
  }
  for (std::size_t i = 0; i < s.dropped.size(); ++i)
    EXPECT(std::string(hold_drop_name(static_cast<HoldDrop>(i))) == drops[i]);
  for (std::size_t i = 0; i < s.pending.dropped.size(); ++i)
    EXPECT(std::string(pending_drop_name(static_cast<PendingDrop>(i))) == pending_drops[i]);
  EXPECT(std::string(hold_source_name(HoldSource::Update)) == "update");
  EXPECT(std::string(hold_source_name(HoldSource::Replace)) == "replace");
  std::vector<HoldRecord> records;
  for (std::uint64_t i = 0; i < 67; ++i) records.push_back({i + 1, 10, i + 100, 32,
      i % 2 ? HoldSource::Replace : HoldSource::Update});
  JValue v;
  EXPECT(json_lite::Reader(hold_json(s, records, 7, true, 99, "active", "", "none")).parse(&v));
  EXPECT(field(v, "schema").text == "render-stream-hold/1");
  EXPECT(field(v, "final").b); EXPECT(field(v, "frame").text == "99");
  EXPECT(field(v, "state").text == "active"); EXPECT(field(v, "reason").kind == JValue::Null);
  EXPECT(field(v, "fault").text == "none");
  EXPECT(field(v, "skip_records").items.empty());
  EXPECT(field(v, "skip_records_dropped").text == "0");
  EXPECT(field(v, "pending_records").items.empty());
  EXPECT(field(v, "pending_records_dropped").text == "0");
  EXPECT(field(field(v, "caps"), "texture_max_bytes").text == "1572864");
  EXPECT(field(field(v, "caps"), "total_max_bytes").text == "16777216");
  EXPECT(field(field(v, "live"), "entries").text == "2");
  EXPECT(field(field(v, "live"), "bytes").text == "20");
  EXPECT(field(field(v, "peak"), "entries").text == "8");
  EXPECT(field(field(v, "peak"), "bytes").text == "80");
  const auto &t = field(v, "taken");
  EXPECT(field(t, "total").text == "8"); EXPECT(field(t, "update").text == "3");
  EXPECT(field(t, "replace").text == "5"); EXPECT(field(t, "bytes").text == "80");
  for (std::size_t i = 1; i < s.skipped.size(); ++i)
    EXPECT(field(field(v, "skipped"), skips[i]).text == std::to_string(100 + i));
  EXPECT(field(v, "skipped").fields.size() == 10);
  for (const char *key : drops) EXPECT(field(field(v, "dropped"), key).text == "1");
  EXPECT(field(v, "dropped_bytes").text == "60"); EXPECT(field(v, "hold_balanced").b);
  EXPECT(field(v, "held_dropped").text == "10");
  const auto &held = field(v, "held").items;
  EXPECT(held.size() == 64);
  for (std::size_t i = 0; i < held.size(); ++i) {
    EXPECT(field(held[i], "rid").text == std::to_string(i + 1));
    EXPECT(field(held[i], "frame").text == "10");
    EXPECT(field(held[i], "seq").text == std::to_string(i + 100));
    EXPECT(field(held[i], "bytes").text == "32");
    EXPECT(field(held[i], "source").text == (i % 2 ? "replace" : "update"));
  }
  const auto &p = field(v, "pending");
  EXPECT(field(field(p, "caps"), "entries").text == "64");
  EXPECT(field(field(p, "caps"), "bytes").text == "4194304");
  for (const char *key : {"taken", "taken_bytes", "moved", "moved_bytes", "dropped_bytes", "evicted", "evicted_bytes"})
    EXPECT(p.get(key) != nullptr);
  EXPECT(field(p, "taken").text == "8"); EXPECT(field(p, "taken_bytes").text == "80");
  EXPECT(field(p, "moved").text == "1"); EXPECT(field(p, "moved_bytes").text == "10");
  EXPECT(field(p, "dropped_bytes").text == "40");
  EXPECT(field(p, "evicted").text == "1"); EXPECT(field(p, "evicted_bytes").text == "10");
  for (const char *key : pending_drops) EXPECT(field(field(p, "dropped"), key).text == "1");
  for (const auto i : {1, 2, 5, 6, 7, 9})
    EXPECT(field(field(p, "skipped"), skips[i]).text == std::to_string(200 + i));
  EXPECT(field(p, "skipped").fields.size() == 6);
  EXPECT(field(field(p, "live"), "entries").text == "2");
  EXPECT(field(field(p, "live"), "bytes").text == "20");
  EXPECT(field(field(p, "peak"), "entries").text == "8");
  EXPECT(field(field(p, "peak"), "bytes").text == "80");
  EXPECT(field(p, "pending_balanced").b);
  EXPECT(json_lite::Reader(hold_json({}, {}, 0, false, 0, "ignored", "quote\"\\\n", "hold-off")).parse(&v));
  EXPECT(!field(v, "final").b); EXPECT(field(v, "reason").text == "quote\"\\\n");
  EXPECT(field(v, "fault").text == "hold-off"); EXPECT(field(v, "held").items.empty());
  EXPECT(field(v, "held_dropped").text == "0");
}
void ring_evidence() {
  HoldRings rings;
  HoldSkipRecord skip;
  skip.seq = 7; skip.rid = 101; skip.frame = 42;
  skip.width = 64; skip.height = 32; skip.format = 11; skip.bytes = 32768;
  skip.source = HoldSource::Replace; skip.reason = HoldSkip::OverTextureCap;
  skip.thread = 0; skip.has_by = true; skip.by_rid = 102; skip.by_kind = "texture_2d";
  skip.by_width = 64; skip.by_height = 32; skip.by_format = 11;
  const char *pending_names[] = {"none", "present", "evicted", "skipped", "unregistered"};
  for (std::size_t i = 0; i < 5; ++i) {
    skip.by_pending = static_cast<ByPending>(i);
    EXPECT(std::string(by_pending_name(skip.by_pending)) == pending_names[i]);
    skip.by_pending_reason = HoldSkip::OverTextureCap;
    rings.skips.push_back(skip);
  }
  rings.skips.push_back(HoldSkipRecord{});
  skip.thread = 1; skip.by_kind = nullptr;
  rings.skips.push_back(skip);
  PendingRecord pending;
  pending.seq = 8; pending.rid = 103; pending.frame = 41;
  pending.bytes = 16384; pending.evicted = true;
  rings.pending.push_back(pending);
  pending.seq = 9; pending.rid = 104; pending.frame = 43;
  pending.evicted = false; pending.reason = HoldSkip::OverTextureCap;
  pending.width = 32; pending.height = 16; pending.format = 11;
  rings.pending.push_back(pending);
  JValue v;
  EXPECT(json_lite::Reader(hold_json({}, {}, 0, true, 44, "active", "", "none", rings)).parse(&v));
  const auto &skips = field(v, "skip_records").items;
  EXPECT(skips.size() == 7);
  for (std::size_t i = 0; i < 5; ++i) {
    const auto &r = skips[i];
    EXPECT(field(r, "seq").text == "7"); EXPECT(field(r, "rid").text == "101");
    EXPECT(field(r, "frame").text == "42"); EXPECT(field(r, "source").text == "replace");
    EXPECT(field(r, "reason").text == "over_texture_cap"); EXPECT(field(r, "thread").text == "main");
    EXPECT(field(r, "width").text == "64"); EXPECT(field(r, "height").text == "32");
    EXPECT(field(r, "format").text == "11"); EXPECT(field(r, "bytes").text == "32768");
    const auto &by = field(r, "by");
    EXPECT(field(by, "rid").text == "102"); EXPECT(field(by, "kind").text == "texture_2d");
    EXPECT(field(by, "width").text == "64"); EXPECT(field(by, "height").text == "32");
    EXPECT(field(by, "format").text == "11");
    EXPECT(field(by, "pending").text == (i == 3 ? "skipped:over_texture_cap" : pending_names[i]));
  }
  EXPECT(field(skips[5], "by").kind == JValue::Null);
  EXPECT(field(skips[5], "thread").kind == JValue::Null);
  EXPECT(field(skips[5], "source").text == "update");
  EXPECT(field(skips[5], "width").text == "-1");
  EXPECT(field(skips[5], "height").text == "-1");
  EXPECT(field(skips[5], "format").text == "-1");
  EXPECT(field(skips[5], "bytes").text == "-1");
  EXPECT(field(skips[6], "thread").text == "offmain");
  EXPECT(field(field(skips[6], "by"), "kind").kind == JValue::Null);
  const auto &events = field(v, "pending_records").items;
  EXPECT(events.size() == 2);
  for (std::size_t i = 0; i < events.size(); ++i) {
    EXPECT(field(events[i], "seq").text == std::to_string(8 + i));
    EXPECT(field(events[i], "rid").text == std::to_string(103 + i));
    EXPECT(field(events[i], "frame").text == (i == 0 ? "41" : "43"));
    EXPECT(field(events[i], "bytes").text == "16384");
    EXPECT(field(events[i], "width").text == (i == 0 ? "-1" : "32"));
    EXPECT(field(events[i], "height").text == (i == 0 ? "-1" : "16"));
    EXPECT(field(events[i], "format").text == (i == 0 ? "-1" : "11"));
    EXPECT(field(events[i], "event").text == (i == 0 ? "evicted" : "skipped"));
  }
  EXPECT(field(events[0], "reason").kind == JValue::Null);
  EXPECT(field(events[1], "reason").text == "over_texture_cap");
}
template <typename Record, std::size_t Cap>
void ring_boundary(std::size_t appended) {
  std::array<Record, Cap> ring{};
  std::uint64_t count = 0, dropped = 999;
  for (std::size_t i = 0; i < appended; ++i) {
    Record r; r.rid = 1000 + i; r.frame = 2000 + i;
    hold_ring_push(ring, count, r);
  }
  const auto records = hold_ring_copy(ring, count, dropped);
  EXPECT(count == appended);
  EXPECT(records.size() == (appended < Cap ? appended : Cap));
  EXPECT(dropped == (appended > Cap ? appended - Cap : 0));
  for (std::size_t i = 0; i < records.size(); ++i) {
    EXPECT(records[i].seq == dropped + i + 1);
    EXPECT(records[i].rid == 1000 + dropped + i);
    EXPECT(records[i].frame == 2000 + dropped + i);
  }
}
void ring_overflow() {
  for (const auto count : {0, 1, 255, 256, 257, 300, 600})
    ring_boundary<HoldSkipRecord, kHoldSkipRecordCap>(count);
  for (const auto count : {0, 1, 63, 64, 65, 70, 140})
    ring_boundary<PendingRecord, kHoldPendingRecordCap>(count);
  std::array<HoldSkipRecord, kHoldSkipRecordCap> skips{};
  std::array<PendingRecord, kHoldPendingRecordCap> pending{};
  std::uint64_t skip_count = 0, pending_count = 0;
  for (std::uint64_t i = 1; i <= 300; ++i) {
    HoldSkipRecord r; r.rid = i;
    hold_ring_push(skips, skip_count, r);
  }
  for (std::uint64_t i = 1; i <= 70; ++i) {
    PendingRecord r; r.rid = i;
    hold_ring_push(pending, pending_count, r);
  }
  HoldRings rings;
  rings.skips = hold_ring_copy(skips, skip_count, rings.skips_dropped);
  rings.pending = hold_ring_copy(pending, pending_count, rings.pending_dropped);
  JValue v;
  EXPECT(json_lite::Reader(hold_json({}, {}, 0, true, 0, "active", "", "none", rings)).parse(&v));
  EXPECT(field(v, "skip_records_dropped").text == "44");
  EXPECT(field(v, "pending_records_dropped").text == "6");
  const auto &s = field(v, "skip_records").items;
  const auto &p = field(v, "pending_records").items;
  EXPECT(s.size() == 256); EXPECT(p.size() == 64);
  for (std::size_t i = 0; i < s.size(); ++i) {
    EXPECT(field(s[i], "seq").text == std::to_string(45 + i));
    EXPECT(field(s[i], "rid").text == std::to_string(45 + i));
  }
  for (std::size_t i = 0; i < p.size(); ++i) {
    EXPECT(field(p[i], "seq").text == std::to_string(7 + i));
    EXPECT(field(p[i], "rid").text == std::to_string(7 + i));
  }
}
}  // namespace
int main() {
  policy(); balances(); evidence(); ring_evidence(); ring_overflow();
  std::printf("rs_hold_test: %d checks, %d failures\n", checks, failures);
  return failures ? 1 : 0;
}
