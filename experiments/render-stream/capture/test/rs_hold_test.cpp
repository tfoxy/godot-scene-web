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
  // Exhaust competing conditions to pin the decision's precedence.
  for (bool image : {false, true}) for (bool facts : {false, true})
    for (const auto format : {-1, 0, 16, 17, 38, 39})
      for (const auto bytes : {-1, 0, 1, 65535, 65536}) {
        HoldSkip want = HoldSkip::None;
        if (!image) want = HoldSkip::NoImage;
        else if (!facts || bytes <= 0) want = HoldSkip::SizeUnknown;
        else if (format >= 17 && format <= 38) want = HoldSkip::VramFormat;
        else if (bytes > 65535) want = HoldSkip::OverTextureCap;
        EXPECT(hold_image_decision(image, facts, format, bytes) == want);
      }
  EXPECT(hold_total_ok(4194304, 65535, 65535));
  EXPECT(!hold_total_ok(4194304, 65534, 65535));
  EXPECT(hold_total_ok(0, 0, 4194304));
  EXPECT(!hold_total_ok(0, 0, 4194305));
  EXPECT(!hold_total_ok(0, 1, 1));
  EXPECT(!hold_total_ok(0, 0, std::numeric_limits<std::uint64_t>::max()));
  EXPECT(!pending_evictions_needed(15, 262143, 1));
  EXPECT(pending_evictions_needed(16, 0, 1));
  EXPECT(pending_evictions_needed(0, 262144, 1));
  EXPECT(!pending_evictions_needed(0, 0, 262144));
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
    if (i == 13) bad.peak.bytes = 4194305;
    EXPECT(!hold_balanced(bad));
  }
  auto over = s;
  over.live.bytes = 4194305; over.taken.bytes = over.live.bytes + over.dropped_bytes;
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
    if (i == 13) { bad.live.entries = 17; bad.taken += 15; }
    if (i == 14) { bad.live.bytes = 262145; bad.taken_bytes += 262125; }
    if (i == 15) bad.peak.entries = 17;
    if (i == 16) bad.peak.bytes = 262145;
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
  EXPECT(field(field(v, "caps"), "texture_max_bytes").text == "65535");
  EXPECT(field(field(v, "caps"), "total_max_bytes").text == "4194304");
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
  EXPECT(field(field(p, "caps"), "entries").text == "16");
  EXPECT(field(field(p, "caps"), "bytes").text == "262144");
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
}  // namespace
int main() {
  policy(); balances(); evidence();
  std::printf("rs_hold_test: %d checks, %d failures\n", checks, failures);
  return failures ? 1 : 0;
}
