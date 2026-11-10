// Engine-free rules and accounting for texture bodies prepared at the arm.
#ifndef GRC_RS_WARM_H
#define GRC_RS_WARM_H

#include <atomic>
#include <cstdint>
#include <memory>
#include <optional>
#include <string>
#include <vector>

#include "rs_captured.h"
#include "rs_texture_worker.h"

namespace grc::rs {

enum class WarmSource : std::uint8_t { Reload, Registry, Cache };
const char *warm_source_name(WarmSource source);
enum class WarmSkip : std::uint8_t { None, MirrorKnown, Refused, NotTexture2d, Released, Updated };
struct WarmClassInput {
  bool registered = false;
  bool texture2d = false;
  bool updated = false, released = false;
  bool has_reload_source = false;
  bool census_built = false, census_compressed = false;
  bool mirror_known = false, refused = false;
  bool reload_off = false;
};
WarmSkip warm_class(const WarmClassInput &in, WarmSource *out);
bool warm_eligible_at_reference(bool reload_source, bool pristine, bool compressed, bool census_at_warm);
bool warm_stale(bool updated_at_warm, bool registered_now, bool updated_now);

class WarmClaim {
 public:
  enum State : std::uint8_t { kQueued = 0, kRunning = 1, kCancelled = 2 };
  bool claim();
  bool cancel();
  State state() const;
 private:
  std::atomic<std::uint8_t> state_{kQueued};
};
struct WarmTaskBase {
  WarmClaim claim;
  // Claim before applying the fault delay, so duplicate closures return immediately.
  bool claim_and_delay(std::uint64_t delay_ms);
  virtual ~WarmTaskBase() = default;
  // Only the successful claimer may run the body or touch its source.
  virtual void run() = 0;
  // Only legal after cancel() returned true.
  virtual void drop_source() = 0;
};
struct WarmBody {
  PayloadCopy copy;
  PayloadPtr bytes;
  TextureJobPtr job;
  std::shared_ptr<WarmTaskBase> task;
  std::int64_t source_format = -1, source_data_bytes = -1;
  std::uint64_t coded_bytes() const;
};
struct WarmEntry {
  WarmSource source = WarmSource::Registry;
  bool updated_at_warm = false;
  WarmBody body;
};
struct WarmCounters {
  std::atomic<std::uint64_t> done{0}, cancelled{0}, mispredicts{0}, work_ns{0}, last_finish_ns{0};
  void reset();
  void note_done(std::uint64_t now_ns, std::uint64_t work_ns, bool mispredict);
  void note_cancel(std::uint64_t now_ns);
};
WarmCounters &warm_counters();
std::uint64_t warm_now_ns();

struct WarmScanned {
  std::uint64_t registered_2d = 0, mirror_known = 0, refused = 0, census_unregistered = 0;
};
struct WarmSkippedBy {
  std::uint64_t not_texture2d = 0, released = 0, updated = 0, evicted = 0, no_image = 0;
};
struct WarmLazyAtReference {
  std::uint64_t updated = 0, unregistered = 0;
};
struct WarmStats {
  bool final = false;
  std::uint64_t arm_index = 0, frame = 0;
  std::string fault = "none", skipped, workers = "sync";
  WarmScanned scanned;
  WarmSkippedBy skipped_by;
  std::uint64_t queued = 0, from_reload = 0, from_registry = 0, from_cache = 0;
  std::uint64_t jobs = 0, sync_coded = 0, not_ok = 0, from_reload_bytes = 0;
  std::uint64_t reload_sources_left = 0;
  bool census_at_warm = false;
  std::uint64_t completed = 0, cancelled_freed = 0, cancelled_disarm = 0, promoted = 0, mispredicts = 0;
  std::uint64_t served = 0, served_in_flight = 0, served_reload = 0;
  std::uint64_t discarded_stale = 0, discarded_freed = 0, discarded_superseded = 0;
  std::uint64_t dropped_unreferenced = 0, held_entries = 0;
  bool warm_balanced = false;
  std::uint64_t decode_at_reference = 0;
  std::vector<std::uint64_t> decode_at_reference_rids;
  WarmLazyAtReference lazy_at_reference;
  bool warm_complete = false;
  std::optional<double> arm_to_warm_complete_ms;
  double arm_to_warm_queued_ms = 0;
  std::uint64_t warm_cache_bytes = 0, warm_queue_us = 0, warm_work_us = 0, reload_us = 0, census_us = 0;
};
bool warm_balanced(const WarmStats &stats);
std::string warm_json(const WarmStats &stats);

}  // namespace grc::rs
#endif  // GRC_RS_WARM_H
