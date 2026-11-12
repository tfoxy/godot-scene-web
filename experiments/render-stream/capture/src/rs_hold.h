// Engine-free policy, accounting and evidence for references to current texture images.
#ifndef GRC_RS_HOLD_H
#define GRC_RS_HOLD_H

#include <array>
#include <atomic>
#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

#include "rs_texture_release.h"

namespace grc::rs {

constexpr std::int64_t kHoldTextureMaxBytes = 1572864;
constexpr std::uint64_t kHoldTotalMaxBytes = 16777216;
constexpr std::size_t kHoldPendingMaxEntries = 64;
constexpr std::uint64_t kHoldPendingMaxBytes = 4194304;
static_assert(kHoldPendingMaxBytes >= kHoldTextureMaxBytes);
constexpr std::uint64_t kHoldEvidenceEveryFrames = 300;
constexpr std::size_t kHoldRecordCap = 64;
constexpr std::size_t kHoldSkipRecordCap = 256;
constexpr std::size_t kHoldPendingRecordCap = 64;

enum class HoldSource : std::uint8_t { Update, Replace };
enum class HoldSkip : std::uint8_t {
  None, Unregistered, NotTexture2d, OffmainReplace, ReleasedSource, VramFormat, NoImage,
  SizeUnknown, ShapeMismatch, OverTextureCap, OverTotalCap, Count
};
enum class HoldDrop : std::uint8_t {
  Superseded, Unheld, Freed, Recreated, ReplacedAway, Fault, Count
};
enum class PendingDrop : std::uint8_t { Freed, Updated, Replaced, Recreated, Count };
enum class ByPending : std::uint8_t { None, Present, Evicted, Skipped, Unregistered };
const char *hold_source_name(HoldSource source);
const char *hold_skip_name(HoldSkip skip);
const char *hold_drop_name(HoldDrop drop);
const char *pending_drop_name(PendingDrop drop);
const char *by_pending_name(ByPending pending);

struct HoldSkipRecord {
  std::uint64_t seq = 0, rid = 0, frame = 0;
  std::int64_t width = -1, height = -1, format = -1, bytes = -1;
  HoldSource source = HoldSource::Update;
  HoldSkip reason = HoldSkip::None;
  std::int8_t thread = -1;
  bool has_by = false;
  std::uint64_t by_rid = 0;
  const char *by_kind = nullptr;
  std::int64_t by_width = -1, by_height = -1, by_format = -1;
  ByPending by_pending = ByPending::None;
  HoldSkip by_pending_reason = HoldSkip::None;
};
struct PendingRecord {
  std::uint64_t seq = 0, rid = 0, frame = 0;
  std::int64_t bytes = -1, width = -1, height = -1, format = -1;
  bool evicted = false;
  HoldSkip reason = HoldSkip::None;
};
struct HoldRings {
  std::vector<HoldSkipRecord> skips;
  std::uint64_t skips_dropped = 0;
  std::vector<PendingRecord> pending;
  std::uint64_t pending_dropped = 0;
};

// Appends use fixed storage; evidence readers copy the retained records oldest first.
template <typename Record, std::size_t Cap>
inline void hold_ring_push(std::array<Record, Cap> &ring, std::uint64_t &appended, Record record) {
  static_assert(Cap > 0);
  record.seq = appended + 1;
  ring[static_cast<std::size_t>(appended % Cap)] = record;
  ++appended;
}
template <typename Record, std::size_t Cap>
inline std::vector<Record> hold_ring_copy(const std::array<Record, Cap> &ring,
                                         std::uint64_t appended, std::uint64_t &dropped) {
  static_assert(Cap > 0);
  const auto kept = appended < Cap ? static_cast<std::size_t>(appended) : Cap;
  dropped = appended - kept;
  std::vector<Record> records;
  records.reserve(kept);
  for (std::size_t i = 0; i < kept; ++i)
    records.push_back(ring[static_cast<std::size_t>((dropped + i) % Cap)]);
  return records;
}

struct HoldRecord {
  std::uint64_t rid = 0, frame = 0, seq = 0;
  std::int64_t bytes = 0;
  HoldSource source = HoldSource::Update;
};
struct HoldSize { std::uint64_t entries = 0, bytes = 0; };
struct HoldStats {
  HoldSize live, peak;
  struct Taken { std::uint64_t total = 0, update = 0, replace = 0, bytes = 0; } taken;
  std::array<std::uint64_t, static_cast<std::size_t>(HoldSkip::Count)> skipped{};
  std::array<std::uint64_t, static_cast<std::size_t>(HoldDrop::Count)> dropped{};
  std::uint64_t dropped_bytes = 0, seq = 0;
  struct Pending {
    std::uint64_t taken = 0, taken_bytes = 0, moved = 0, moved_bytes = 0;
    std::array<std::uint64_t, static_cast<std::size_t>(PendingDrop::Count)> dropped{};
    std::uint64_t dropped_bytes = 0, evicted = 0, evicted_bytes = 0;
    std::array<std::uint64_t, static_cast<std::size_t>(HoldSkip::Count)> skipped{};
    HoldSize live, peak;
  } pending;
};

// Taking a hold never copies or decodes pixels. VRAM-tier images belong to the release path.
inline HoldSkip hold_image_decision(bool image, bool facts_ok, std::int64_t format,
                                    std::int64_t bytes) {
  if (!image) return HoldSkip::NoImage;
  if (!facts_ok || bytes <= 0) return HoldSkip::SizeUnknown;
  if (release_tier(format)) return HoldSkip::VramFormat;
  if (bytes > kHoldTextureMaxBytes) return HoldSkip::OverTextureCap;
  return HoldSkip::None;
}
inline bool hold_total_ok(std::uint64_t live, std::uint64_t old, std::uint64_t add) {
  return old <= live && add <= kHoldTotalMaxBytes && live - old <= kHoldTotalMaxBytes - add;
}
// After each oldest-first eviction, ask again until the incoming entry fits both bounds.
inline bool pending_evictions_needed(std::uint64_t live_entries, std::uint64_t live_bytes,
                                     std::uint64_t add) {
  return live_entries >= kHoldPendingMaxEntries || add > kHoldPendingMaxBytes ||
      live_bytes > kHoldPendingMaxBytes - add;
}
namespace detail { inline std::atomic<bool> g_hold_active{false}; }
inline bool hold_active() { return detail::g_hold_active.load(std::memory_order_relaxed); }
inline void hold_set_active(bool active) {
  detail::g_hold_active.store(active, std::memory_order_relaxed);
}

bool hold_balanced(const HoldStats &s);
bool pending_balanced(const HoldStats::Pending &s);
std::string hold_json(const HoldStats &s, const std::vector<HoldRecord> &records,
                      std::uint64_t held_dropped, bool final, std::uint64_t frame,
                      const std::string &state, const std::string &reason, const std::string &fault);
std::string hold_json(const HoldStats &s, const std::vector<HoldRecord> &records,
                      std::uint64_t held_dropped, bool final, std::uint64_t frame,
                      const std::string &state, const std::string &reason, const std::string &fault,
                      const HoldRings &rings);

}  // namespace grc::rs
#endif  // GRC_RS_HOLD_H
