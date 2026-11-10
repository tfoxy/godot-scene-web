// Engine-free predicates, queue and evidence for frame-boundary dummy texture release.
#ifndef GRC_RS_EVICT_H
#define GRC_RS_EVICT_H

#include <atomic>
#include <cstddef>
#include <cstdint>
#include <deque>
#include <mutex>
#include <string>
#include <vector>

namespace grc {
class JsonWriter;
namespace rs {

constexpr std::size_t kEvictDrainPerFrame = 32;
constexpr std::size_t kEvictQueueCap = 65536;
constexpr std::int64_t kEvictMinBytes = 4096;
constexpr std::size_t kEvictReleaseRecordCap = 64;
constexpr std::uint64_t kEvictEvidenceEveryFrames = 300;

bool evict_path_is_ctex(const std::string &utf8);
enum class EvictSkip : std::uint8_t {
  None, Unregistered, NotTexture2d, AlreadyReleased, Format, Edited, NoPath, ArmedUnheld,
  NoImage, AlreadyShrunk, Mismatch, BelowMin, FreedDuring, ShrinkFailed
};
const char *evict_skip_name(EvictSkip skip);
struct EvictRecordInput {
  bool registered = false, texture2d = false, released = false, facts_known = false;
  std::int64_t format = -1;
  bool edited = false, path_valid = false, streaming = false, mirror_known = false;
};
EvictSkip evict_record_decision(const EvictRecordInput &in);
struct EvictImageInput {
  bool image = false;
  std::int64_t width = -1, height = -1, format = -1;
  bool mipmaps = false;
  std::int64_t data_bytes = -1;
  std::int64_t rec_width = 0, rec_height = 0, rec_format = -1;
  bool rec_mipmaps = false;
};
EvictSkip evict_image_decision(const EvictImageInput &in);
struct EvictEntry { std::uint64_t rid = 0, frame = 0; };

namespace detail { inline std::atomic<std::uint32_t> g_evict_pending{0}; }
// Parked entries do not wake the drain. This is the entire idle frame check.
inline bool evict_pending() { return detail::g_evict_pending.load(std::memory_order_relaxed) != 0; }

// The mutex is a leaf lock: no engine or other capture call runs while it is held.
// Hooks may note from any thread; taking, parking and unparking belong to main.
class EvictQueue {
 public:
  bool note(std::uint64_t rid, std::uint64_t frame);
  std::size_t take(std::size_t max, std::vector<EvictEntry> *out);
  void park(const EvictEntry &e);
  std::size_t unpark_all();
  void reset();
  struct Counts { std::uint64_t noted, queued, queue_dropped, requeued, pending, parked; };
  Counts counts() const;
 private:
  mutable std::mutex mutex_;
  std::deque<EvictEntry> queue_, parked_;
  std::uint64_t noted_ = 0, queued_ = 0, dropped_ = 0, requeued_ = 0;
};
EvictQueue &evict_queue();
struct EvictRelease {
  std::uint64_t rid = 0, frame = 0, queued_frame = 0;
  std::int64_t format = -1, width = 0, height = 0, data_bytes = 0;
  bool mipmaps = false, armed = false;
  std::string path;
};
struct EvictStats {
  bool configured = false;
  std::string state = "off", reason;
  EvictQueue::Counts queue{};
  std::uint64_t examined = 0, released = 0, released_bytes = 0, released_armed = 0;
  std::uint64_t skipped[14] = {};
  std::uint64_t drains = 0, drain_us_total = 0, drain_us_max = 0, lifetime_frames_max = 0;
  std::vector<EvictRelease> releases;
  std::uint64_t releases_dropped = 0;
  bool rss_test = false;
  std::uint64_t rss_batches = 0, rss_measured_bytes = 0, rss_freed_bytes = 0;
};
EvictStats &evict_stats();
void evict_configure(bool active, bool rss_test, const std::string &state, const std::string &reason);
bool evict_balanced(const EvictStats &s);
void evict_fields(JsonWriter *json, const EvictStats &s);
std::string evict_json(const EvictStats &s, bool final, std::uint64_t frame,
                       std::int64_t rss_bytes, std::int64_t rss_anon_bytes);
std::int64_t evict_read_rss_anon();

}  // namespace rs
}  // namespace grc
#endif  // GRC_RS_EVICT_H
