#include "rs_hold.h"

#include <algorithm>
#include <numeric>

#include "report.h"

namespace grc::rs {
namespace {
constexpr const char *kSourceNames[] = {"update", "replace"};
constexpr const char *kSkipNames[] = {
    "none", "unregistered", "not_texture2d", "offmain_replace", "released_source", "vram_format",
    "no_image", "size_unknown", "shape_mismatch", "over_texture_cap", "over_total_cap"};
constexpr const char *kDropNames[] = {"superseded", "unheld", "freed", "recreated", "replaced_away", "fault"};
constexpr const char *kPendingDropNames[] = {"freed", "updated", "replaced", "recreated"};
constexpr HoldSkip kPendingSkips[] = {HoldSkip::Unregistered, HoldSkip::NotTexture2d,
    HoldSkip::VramFormat, HoldSkip::NoImage, HoldSkip::SizeUnknown, HoldSkip::OverTextureCap};
}
const char *hold_source_name(HoldSource source) { return kSourceNames[static_cast<std::size_t>(source)]; }
const char *hold_skip_name(HoldSkip skip) { return kSkipNames[static_cast<std::size_t>(skip)]; }
const char *hold_drop_name(HoldDrop drop) { return kDropNames[static_cast<std::size_t>(drop)]; }
const char *pending_drop_name(PendingDrop drop) { return kPendingDropNames[static_cast<std::size_t>(drop)]; }

bool hold_balanced(const HoldStats &s) {
  const auto dropped = std::accumulate(s.dropped.begin(), s.dropped.end(), std::uint64_t{0});
  return s.taken.total == s.live.entries + dropped &&
      s.taken.bytes == s.live.bytes + s.dropped_bytes &&
      s.taken.total == s.taken.update + s.taken.replace &&
      s.live.bytes <= kHoldTotalMaxBytes && s.peak.bytes <= kHoldTotalMaxBytes;
}
bool pending_balanced(const HoldStats::Pending &s) {
  const auto dropped = std::accumulate(s.dropped.begin(), s.dropped.end(), std::uint64_t{0});
  return s.taken == s.live.entries + s.moved + dropped + s.evicted &&
      s.taken_bytes == s.live.bytes + s.moved_bytes + s.dropped_bytes + s.evicted_bytes &&
      s.live.entries <= kHoldPendingMaxEntries && s.live.bytes <= kHoldPendingMaxBytes &&
      s.peak.entries <= kHoldPendingMaxEntries && s.peak.bytes <= kHoldPendingMaxBytes;
}
std::string hold_json(const HoldStats &s, const std::vector<HoldRecord> &records,
                      std::uint64_t held_dropped, bool final, std::uint64_t frame,
                      const std::string &state, const std::string &reason, const std::string &fault) {
  JsonWriter j;
  const auto u = [&j](const char *key, std::uint64_t v) { j.key(key).unsigned_integer(v); };
  const auto size = [&j, &u](const char *key, const HoldSize &v) {
    j.key(key).object_begin(); u("entries", v.entries); u("bytes", v.bytes); j.object_end();
  };
  j.object_begin().field("schema", std::string("render-stream-hold/1")).field("final", final);
  u("frame", frame);
  j.field("state", state).field_or_null("reason", reason).field("fault", fault);
  j.key("caps").object_begin();
  u("texture_max_bytes", kHoldTextureMaxBytes); u("total_max_bytes", kHoldTotalMaxBytes);
  j.object_end();
  size("live", s.live); size("peak", s.peak);
  j.key("taken").object_begin();
  u("total", s.taken.total); u("update", s.taken.update); u("replace", s.taken.replace);
  u("bytes", s.taken.bytes); j.object_end();
  j.key("skipped").object_begin();
  for (std::size_t i = 1; i < s.skipped.size(); ++i) u(kSkipNames[i], s.skipped[i]);
  j.object_end().key("dropped").object_begin();
  for (std::size_t i = 0; i < s.dropped.size(); ++i) u(kDropNames[i], s.dropped[i]);
  j.object_end(); u("dropped_bytes", s.dropped_bytes);
  j.field("hold_balanced", hold_balanced(s));
  j.key("held").array_begin();
  const auto n = std::min(records.size(), kHoldRecordCap);
  for (std::size_t i = 0; i < n; ++i) {
    const auto &r = records[i];
    j.object_begin(); u("rid", r.rid); j.field("bytes", r.bytes);
    j.field("source", std::string(hold_source_name(r.source)));
    u("frame", r.frame); u("seq", r.seq); j.object_end();
  }
  j.array_end(); u("held_dropped", held_dropped + records.size() - n);
  const auto &p = s.pending;
  j.key("pending").object_begin().key("caps").object_begin();
  u("entries", kHoldPendingMaxEntries); u("bytes", kHoldPendingMaxBytes); j.object_end();
  u("taken", p.taken); u("taken_bytes", p.taken_bytes);
  u("moved", p.moved); u("moved_bytes", p.moved_bytes);
  j.key("dropped").object_begin();
  for (std::size_t i = 0; i < p.dropped.size(); ++i) u(kPendingDropNames[i], p.dropped[i]);
  j.object_end(); u("dropped_bytes", p.dropped_bytes);
  u("evicted", p.evicted); u("evicted_bytes", p.evicted_bytes);
  j.key("skipped").object_begin();
  for (const auto skip : kPendingSkips) u(hold_skip_name(skip), p.skipped[static_cast<std::size_t>(skip)]);
  j.object_end(); size("live", p.live); size("peak", p.peak);
  j.field("pending_balanced", pending_balanced(p)).object_end().object_end();
  return j.take();
}
}  // namespace grc::rs
