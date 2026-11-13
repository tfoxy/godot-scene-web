#include "rs_platform.h"
#include "rs_evict.h"

#include <algorithm>

#include "report.h"
#include "rs_texture_release.h"

namespace grc::rs {
namespace {
constexpr const char *kSkipNames[] = {
    "none", "unregistered", "not_texture2d", "already_released", "format", "edited", "no_path",
    "armed_unheld", "no_image", "already_shrunk", "mismatch", "below_min", "freed_during", "shrink_failed"};
}

bool evict_path_is_ctex(const std::string &utf8) {
  return utf8.size() >= 5 && utf8.compare(utf8.size() - 5, 5, ".ctex") == 0;
}
const char *evict_skip_name(EvictSkip skip) { return kSkipNames[static_cast<std::size_t>(skip)]; }
EvictSkip evict_record_decision(const EvictRecordInput &in) {
  if (!in.registered) return EvictSkip::Unregistered;
  if (!in.texture2d) return EvictSkip::NotTexture2d;
  if (in.released) return EvictSkip::AlreadyReleased;
  if (!in.facts_known || !release_tier(in.format)) return EvictSkip::Format;
  if (in.edited) return EvictSkip::Edited;
  if (!in.path_valid) return EvictSkip::NoPath;
  if (in.streaming && !in.mirror_known) return EvictSkip::ArmedUnheld;
  return EvictSkip::None;
}
EvictSkip evict_image_decision(const EvictImageInput &in) {
  if (!in.image) return EvictSkip::NoImage;
  if (in.width == 1 && in.height == 1 && in.format == 0 && !in.mipmaps)
    return EvictSkip::AlreadyShrunk;
  if (in.width != in.rec_width || in.height != in.rec_height || in.format != in.rec_format ||
      in.mipmaps != in.rec_mipmaps) return EvictSkip::Mismatch;
  if (in.data_bytes < kEvictMinBytes) return EvictSkip::BelowMin;
  return EvictSkip::None;
}

bool EvictQueue::note(std::uint64_t rid, std::uint64_t frame) {
  std::lock_guard<std::mutex> lock(mutex_);
  ++noted_;
  if (queue_.size() >= kEvictQueueCap) { ++dropped_; return false; }
  queue_.push_back({rid, frame});
  ++queued_;
  detail::g_evict_pending.store(static_cast<std::uint32_t>(queue_.size()), std::memory_order_relaxed);
  return true;
}
std::size_t EvictQueue::take(std::size_t max, std::vector<EvictEntry> *out) {
  out->clear();
  std::lock_guard<std::mutex> lock(mutex_);
  const auto n = std::min(max, queue_.size());
  for (std::size_t i = 0; i < n; ++i) { out->push_back(queue_.front()); queue_.pop_front(); }
  detail::g_evict_pending.store(static_cast<std::uint32_t>(queue_.size()), std::memory_order_relaxed);
  return n;
}
void EvictQueue::park(const EvictEntry &e) {
  std::lock_guard<std::mutex> lock(mutex_);
  parked_.push_back(e);
}
std::size_t EvictQueue::unpark_all() {
  std::lock_guard<std::mutex> lock(mutex_);
  const auto n = parked_.size();
  for (const auto &e : parked_) queue_.push_back(e);
  parked_.clear();
  requeued_ += n;
  detail::g_evict_pending.store(static_cast<std::uint32_t>(queue_.size()), std::memory_order_relaxed);
  return n;
}
void EvictQueue::reset() {
  std::lock_guard<std::mutex> lock(mutex_);
  queue_.clear(); parked_.clear();
  noted_ = queued_ = dropped_ = requeued_ = 0;
  detail::g_evict_pending.store(0, std::memory_order_relaxed);
}
EvictQueue::Counts EvictQueue::counts() const {
  std::lock_guard<std::mutex> lock(mutex_);
  return {noted_, queued_, dropped_, requeued_, queue_.size(), parked_.size()};
}
EvictQueue &evict_queue() { static EvictQueue queue; return queue; }
EvictStats &evict_stats() { static EvictStats stats; return stats; }
void evict_configure(bool active, bool rss_test, const std::string &state, const std::string &reason) {
  evict_queue().reset();
  auto &s = evict_stats();
  s = EvictStats{};
  s.configured = true; s.state = state; s.reason = reason; s.rss_test = rss_test;
  texture_release_set_evict(active);
}
bool evict_balanced(const EvictStats &s) {
  std::uint64_t skipped = 0;
  for (std::size_t i = 1; i < 14; ++i) skipped += s.skipped[i];
  return s.examined == s.released + skipped &&
         s.queue.queued + s.queue.requeued == s.examined + s.queue.pending &&
         s.skipped[static_cast<std::size_t>(EvictSkip::ArmedUnheld)] == s.queue.requeued + s.queue.parked &&
         s.queue.noted == s.queue.queued + s.queue.queue_dropped;
}
void evict_fields(JsonWriter *json, const EvictStats &s) {
  auto &j = *json;
  j.field("state", s.state).field_or_null("reason", s.reason);
  j.field("min_bytes", kEvictMinBytes);
  const auto u = [&j](const char *key, std::uint64_t v) { j.key(key).unsigned_integer(v); };
  u("per_frame", kEvictDrainPerFrame);
  u("noted", s.queue.noted); u("queued", s.queue.queued); u("queue_dropped", s.queue.queue_dropped);
  u("requeued", s.queue.requeued); u("pending", s.queue.pending); u("parked", s.queue.parked);
  u("examined", s.examined); u("released", s.released); u("released_bytes", s.released_bytes);
  u("released_armed", s.released_armed);
  j.key("skipped").object_begin();
  for (std::size_t i = 1; i < 14; ++i) u(kSkipNames[i], s.skipped[i]);
  j.object_end();
  u("drains", s.drains); u("drain_us_total", s.drain_us_total); u("drain_us_max", s.drain_us_max);
  u("lifetime_frames_max", s.lifetime_frames_max);
  j.field("evict_balanced", evict_balanced(s));
  u("releases_dropped", s.releases_dropped +
      (s.releases.size() > kEvictReleaseRecordCap ? s.releases.size() - kEvictReleaseRecordCap : 0));
}
std::string evict_json(const EvictStats &s, bool final, std::uint64_t frame,
                       std::int64_t rss_bytes, AnonReading anon) {
  JsonWriter j;
  j.object_begin().field("schema", std::string("render-stream-evict/1")).field("final", final);
  j.key("frame").unsigned_integer(frame);
  evict_fields(&j, s);
  j.key("releases").array_begin();
  const auto n = std::min(s.releases.size(), kEvictReleaseRecordCap);
  for (std::size_t i = 0; i < n; ++i) {
    const auto &r = s.releases[i];
    j.object_begin().key("rid").unsigned_integer(r.rid);
    j.key("frame").unsigned_integer(r.frame);
    j.key("queued_frame").unsigned_integer(r.queued_frame);
    j.field("format", r.format).field("width", r.width).field("height", r.height);
    j.field("mipmaps", r.mipmaps).field("data_bytes", r.data_bytes).field("armed", r.armed);
    j.field("path", r.path).object_end();
  }
  j.array_end().key("rss_test");
  if (!s.rss_test) j.null();
  else {
    j.object_begin().key("batches").unsigned_integer(s.rss_batches);
    j.key("measured_bytes").unsigned_integer(s.rss_measured_bytes);
    j.key("freed_bytes").unsigned_integer(s.rss_freed_bytes);
    j.object_end();
  }
  j.field("rss_bytes", rss_bytes).field(anon.name, anon.bytes).object_end();
  return j.take();
}
}  // namespace grc::rs
