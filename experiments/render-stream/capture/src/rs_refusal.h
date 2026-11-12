// Engine-free evidence for texture refusals and dependent recovery.
#ifndef GRC_RS_REFUSAL_H
#define GRC_RS_REFUSAL_H

#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

#include "rs_hold.h"

namespace grc::rs {

constexpr std::size_t kRefusalRecordCap = 64;
constexpr std::size_t kRefusalDependentsCap = 16;
constexpr std::size_t kRecoverIndexMaxEntries = 4096;
constexpr std::size_t kRecoverUnresolvedCap = 32;

struct RecoverInfo {
  std::uint32_t published_id = 0, materials = 0, params = 0;
  bool republish_skipped = false;
};
struct RefusalDependents {
  struct Material { std::uint32_t id = 0; std::vector<std::string> params; };
  struct Item { std::uint32_t id = 0; std::string op; };
  std::vector<Material> materials;
  std::vector<Item> items;
  std::uint64_t more = 0;
};
struct RecoverIndexReport {
  std::uint64_t entries = 0, peak = 0, dropped = 0, resolved_by_replace = 0, resolved_by_adopt = 0,
                materials = 0, params = 0, republish_skipped_fault = 0;
  struct Unresolved { std::uint64_t rid = 0; bool refused = false; RefusalDependents deps; };
  std::vector<Unresolved> unresolved;
  std::uint64_t unresolved_more = 0;
};
struct RefusalRecord {
  std::uint64_t rid = 0, frame = 0;
  std::string reason;
  bool registered = false;
  std::string kind;
  std::int64_t width = -1, height = -1, format = -1;
  bool mipmaps = false, facts_known = false, updated = false, released = false, edited = false, held = false;
  bool has_path = false;
  std::string path;
  bool offmain_seen = false;
  bool has_skip = false;
  HoldSkipRecord last_skip;
  bool recovered = false;
  std::string recovered_path;
  std::uint64_t recovered_frame = 0;
  RecoverInfo recover;
  RefusalDependents deps;
};
struct RefusalCounts {
  std::uint64_t refused = 0, refused_no_image = 0, recovered = 0,
                recovered_replace = 0, recovered_update = 0;
};

// Callers bound the records and dependent lists; serialization preserves the supplied evidence.
std::string refusals_json(const std::vector<RefusalRecord> &records, std::uint64_t records_dropped,
                          const RefusalCounts &counts, const RecoverIndexReport &index,
                          std::uint64_t arm, std::uint64_t frame);

}  // namespace grc::rs
#endif  // GRC_RS_REFUSAL_H
