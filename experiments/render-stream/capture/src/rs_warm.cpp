#include "rs_warm.h"

#include <algorithm>
#include <chrono>
#include <iomanip>
#include <locale>
#include <sstream>
#include <thread>

#include "report.h"

namespace grc::rs {
namespace {
void note_last(std::atomic<std::uint64_t> &last, std::uint64_t now) {
  auto old = last.load(std::memory_order_relaxed);
  while (old < now && !last.compare_exchange_weak(old, now, std::memory_order_relaxed)) {}
}
std::uint64_t size_of(const PayloadPtr &bytes) { return bytes ? bytes->size() : 0; }
std::string quoted(const std::string &text) {
  auto result = JsonWriter().string(text).take();
  result.pop_back();
  return result;
}
}  // namespace

const char *warm_source_name(WarmSource source) {
  switch (source) {
    case WarmSource::Reload: return "reload";
    case WarmSource::Registry: return "registry";
    case WarmSource::Cache: return "cache";
    case WarmSource::Hold: return "hold";
  }
  return "registry";
}
WarmSkip warm_class(const WarmClassInput &in, WarmSource *out) {
  if (in.mirror_known) return WarmSkip::MirrorKnown;
  if (in.refused) return WarmSkip::Refused;
  if (in.held) { *out = WarmSource::Hold; return WarmSkip::None; }
  if (in.has_reload_source) { *out = WarmSource::Reload; return WarmSkip::None; }
  if (!in.texture2d) return WarmSkip::NotTexture2d;
  if (in.released && !in.reload_off) return WarmSkip::Released;
  if (!in.updated) { *out = WarmSource::Registry; return WarmSkip::None; }
  if (in.census_built && in.census_compressed) { *out = WarmSource::Cache; return WarmSkip::None; }
  return WarmSkip::Updated;
}
bool warm_eligible_at_reference(bool reload_source, bool pristine, bool compressed, bool census_at_warm,
                                bool held) {
  return held || reload_source || pristine || (compressed && census_at_warm);
}
bool warm_stale(bool updated_at_warm, bool registered_now, bool updated_now) {
  return registered_now && updated_now && !updated_at_warm;
}
bool WarmClaim::claim() {
  std::uint8_t expected = kQueued;
  return state_.compare_exchange_strong(expected, kRunning, std::memory_order_acq_rel);
}
bool WarmClaim::cancel() {
  std::uint8_t expected = kQueued;
  return state_.compare_exchange_strong(expected, kCancelled, std::memory_order_acq_rel);
}
WarmClaim::State WarmClaim::state() const {
  return static_cast<State>(state_.load(std::memory_order_acquire));
}
bool WarmTaskBase::claim_and_delay(std::uint64_t delay_ms) {
  if (!claim.claim()) return false;
  if (delay_ms != 0) std::this_thread::sleep_for(std::chrono::milliseconds(delay_ms));
  return true;
}
std::uint64_t WarmBody::coded_bytes() const {
  if (job) {
    if (!job->done()) return 0;
    return size_of(job->bytes()) + size_of(job->actual().block_bytes);
  }
  return size_of(bytes) + size_of(copy.block_bytes);
}
void WarmCounters::reset() {
  done.store(0, std::memory_order_relaxed);
  cancelled.store(0, std::memory_order_relaxed);
  mispredicts.store(0, std::memory_order_relaxed);
  work_ns.store(0, std::memory_order_relaxed);
  last_finish_ns.store(0, std::memory_order_relaxed);
}
void WarmCounters::note_done(std::uint64_t now_ns, std::uint64_t elapsed_ns, bool mispredict) {
  work_ns.fetch_add(elapsed_ns, std::memory_order_relaxed);
  if (mispredict) mispredicts.fetch_add(1, std::memory_order_relaxed);
  note_last(last_finish_ns, now_ns);
  done.fetch_add(1, std::memory_order_release);
}
void WarmCounters::note_cancel(std::uint64_t now_ns) {
  note_last(last_finish_ns, now_ns);
  cancelled.fetch_add(1, std::memory_order_release);
}
WarmCounters &warm_counters() {
  static WarmCounters counters;
  return counters;
}
std::uint64_t warm_now_ns() {
  return static_cast<std::uint64_t>(std::chrono::duration_cast<std::chrono::nanoseconds>(
      std::chrono::steady_clock::now().time_since_epoch()).count());
}
bool warm_balanced(const WarmStats &s) {
  return (!s.final || s.held_entries == 0) &&
      s.queued == s.served + s.discarded_stale + s.discarded_freed + s.discarded_superseded +
          s.dropped_unreferenced + (s.final ? 0 : s.held_entries);
}
std::string warm_json(const WarmStats &s) {
  std::ostringstream j;
  j.imbue(std::locale::classic());
  j << std::boolalpha << std::fixed << std::setprecision(3);
  j << "{\"schema\":\"render-stream-warm/1\"";
  const auto field = [&](const char *key, const auto &value) { j << ',' << quoted(key) << ':' << value; };
  field("final", s.final);
  field("arm_index", s.arm_index);
  field("frame", s.frame);
  field("fault", quoted(s.fault));
  field("skipped", s.skipped.empty() ? "null" : quoted(s.skipped));
  field("workers", quoted(s.workers));
  field("held_at_arm", s.held_at_arm);
  field("held_bytes_at_arm", s.held_bytes_at_arm);
  field("hold_dropped_fault", s.hold_dropped_fault);
  j << ",\"scanned\":{\"registered_2d\":" << s.scanned.registered_2d;
  field("mirror_known", s.scanned.mirror_known);
  field("refused", s.scanned.refused);
  field("census_unregistered", s.scanned.census_unregistered);
  j << "},\"skipped_by\":{\"not_texture2d\":" << s.skipped_by.not_texture2d;
  field("released", s.skipped_by.released);
  field("updated", s.skipped_by.updated);
  field("evicted", s.skipped_by.evicted);
  field("no_image", s.skipped_by.no_image);
  j << '}';
  field("queued", s.queued);
  field("from_reload", s.from_reload);
  field("from_registry", s.from_registry);
  field("from_cache", s.from_cache);
  field("from_hold", s.from_hold);
  field("jobs", s.jobs);
  field("sync_coded", s.sync_coded);
  field("not_ok", s.not_ok);
  field("from_reload_bytes", s.from_reload_bytes);
  field("reload_sources_left", s.reload_sources_left);
  field("census_at_warm", s.census_at_warm);
  field("completed", s.completed);
  field("cancelled_freed", s.cancelled_freed);
  field("cancelled_disarm", s.cancelled_disarm);
  field("promoted", s.promoted);
  field("mispredicts", s.mispredicts);
  field("served", s.served);
  field("served_in_flight", s.served_in_flight);
  field("served_reload", s.served_reload);
  field("served_hold", s.served_hold);
  field("lazy_from_hold", s.lazy_from_hold);
  field("discarded_stale", s.discarded_stale);
  field("discarded_freed", s.discarded_freed);
  field("discarded_superseded", s.discarded_superseded);
  field("dropped_unreferenced", s.dropped_unreferenced);
  field("held_entries", s.held_entries);
  field("warm_balanced", s.warm_balanced);
  field("decode_at_reference", s.decode_at_reference);
  j << ",\"decode_at_reference_rids\":[";
  for (std::size_t i = 0; i < std::min<std::size_t>(32, s.decode_at_reference_rids.size()); ++i) {
    if (i) j << ',';
    j << quoted(std::to_string(s.decode_at_reference_rids[i]));
  }
  j << "],\"lazy_at_reference\":{\"updated\":" << s.lazy_at_reference.updated;
  field("unregistered", s.lazy_at_reference.unregistered);
  j << '}';
  j << ",\"textures\":{\"adopted\":" << s.textures.adopted;
  field("current", s.textures.current);
  field("creation", s.textures.creation);
  field("refused", s.textures.refused);
  field("refused_no_image", s.textures.refused_no_image);
  field("recovered", s.textures.recovered);
  j << '}';
  field("warm_complete", s.warm_complete);
  j << ",\"arm_to_warm_complete_ms\":";
  if (s.arm_to_warm_complete_ms) j << *s.arm_to_warm_complete_ms;
  else j << "null";
  field("arm_to_warm_queued_ms", s.arm_to_warm_queued_ms);
  field("warm_cache_bytes", s.warm_cache_bytes);
  field("warm_queue_us", s.warm_queue_us);
  field("warm_work_us", s.warm_work_us);
  field("reload_us", s.reload_us);
  field("census_us", s.census_us);
  j << "}\n";
  return j.str();
}
}  // namespace grc::rs
