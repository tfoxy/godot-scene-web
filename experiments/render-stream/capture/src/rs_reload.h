// Engine-free rules and evidence for texture reload and headless texture restoration.
#ifndef GRC_RS_RELOAD_H
#define GRC_RS_RELOAD_H

#include <cstddef>
#include <cstdint>
#include <optional>
#include <map>
#include <string>
#include <vector>

#include "rs_registry.h"

namespace grc {
namespace rs {

struct Shape {
  std::int64_t width = 0, height = 0, format = -1;
  bool mipmaps = false;
};

enum class ReloadRefusal {
  UnsafeEdited, NoPath, Mismatch, Failed, EvictedUnverifiable, EvictedMidArm
};
const char *reload_refusal_name(ReloadRefusal refusal);
enum class ReloadCause { Released, Evicted, Residual };
const char *reload_cause_name(ReloadCause cause);

bool reload_path_valid(const std::string &utf8);
bool evicted_signature(const Shape &dummy, const RegistryTextureFacts &record);
bool reload_verify(const Shape &loaded, const Shape &expected, bool check_mipmaps,
                   bool check_format = true);

// Offsets borrow the caller's GRT1 buffer; no engine reference or pixel copy is retained.
struct Grt1View {
  Shape shape;
  std::uint64_t data_bytes = 0;
  std::size_t data_offset = 0, data_length = 0;
};
// Validates framing and metadata, including both data lengths. Clears *out on failure.
bool parse_grt1(const std::uint8_t *p, std::size_t n, Grt1View *out);
// The block-delivery data size by Image::Format, or -1 for an unknown format/invalid size.
std::int64_t vram_data_bytes(int format, int w, int h, bool mipmaps);

struct ReloadScanned {
  std::uint64_t registered_vram = 0, census_compressed = 0;
};
struct ReloadCandidates {
  std::uint64_t released = 0, evicted = 0, residual = 0;
  std::map<std::string, std::uint64_t> residual_formats;
  std::uint64_t total() const { return released + evicted + residual; }
};
struct ReloadRefused {
  std::uint64_t reload_unsafe = 0, released_no_path = 0, reload_mismatch = 0;
  std::uint64_t reload_failed = 0, evicted_unverifiable = 0, evicted_mid_arm = 0;
  std::uint64_t total() const {
    return reload_unsafe + released_no_path + reload_mismatch + reload_failed +
           evicted_unverifiable + evicted_mid_arm;
  }
};
struct ReloadStats {
  bool final = false, sources_balanced = false;
  std::uint64_t arm_index = 0, frame = 0;
  std::string fault = "none", skipped;
  ReloadScanned scanned;
  ReloadCandidates candidates;
  std::uint64_t reloaded = 0, verify_skipped = 0, adopted_from_reload = 0;
  std::uint64_t dropped_unreferenced = 0, dropped_freed = 0, held_bytes = 0;
  ReloadRefused refused;
  std::uint64_t temp_outlived = 0, scope_anomalies = 0, reload_us = 0, census_us = 0;
};
struct ReloadEntry {
  std::uint64_t rid = 0;
  ReloadCause cause = ReloadCause::Released;
  // A code denotes a refused outcome; otherwise the outcome is reloaded.
  std::optional<ReloadRefusal> code;
  std::string why, path;
  Shape record;
  std::optional<Shape> loaded;
  bool adopted = false;
};
constexpr std::size_t kReloadEntryCap = 4096;
// Counts are complete; only entries are capped. Empty optional texts are written as null.
std::string reload_json(const ReloadStats &stats, const std::vector<ReloadEntry> &entries,
                         std::size_t dropped_entries);

struct HtrRestoreStats {
  std::uint64_t candidates = 0, restored = 0, unavailable = 0, mismatch = 0;
  std::uint64_t not_placeholder = 0, skipped_fault = 0, skipped_shutdown = 0;
  std::string skipped;
};
std::string htr_restore_json(const HtrRestoreStats &stats);

}  // namespace rs
}  // namespace grc

#endif  // GRC_RS_RELOAD_H
