// Process identity collected independently of the engine interface.
#pragma once

#include <cstdint>
#include <cstddef>
#include "pe_image.h"
#include <string>
#include <utility>
#include <vector>

namespace grc {

enum class MainImageKind { code, readonly, writable };
struct MainImageRange {
  std::uint64_t begin, end;
  MainImageKind kind;
};

struct ProcessFingerprint {
  std::string platform = "linux-x86_64";
  std::string image_sha256;
  std::string codeview_id;
  uint32_t time_date_stamp = 0, size_of_image = 0;
  uint64_t image_base = 0;
  bool dynamic_base = false;
  std::string uuid;
  uint32_t cputype = 0, cpusubtype = 0;
  uint64_t slice_offset = 0, slice_size = 0;
  uint64_t bind_pure_virtual = 0;
  std::string exe_path;
  std::string exe_sha256;
  std::string build_id;  // empty when the running binary has no GNU build-id
  std::string version_string;
  bool pie = false;
  uint64_t load_bias = 0;
  int pid = 0;
  // Executable mappings of the main binary, as [begin, end) pairs.
  std::vector<std::pair<uint64_t, uint64_t>> exec_ranges;
  // Main binary mappings (raw proc lines on Linux, section summaries on Windows).
  std::vector<std::string> exe_maps;

  std::vector<MainImageRange> main_image_ranges;
  // PE sections use VirtualSize, including zero-filled BSS. No heap mapping is eligible.
  void set_pe_image_ranges(const PeHeaders &headers, std::uint64_t mapped_base) {
    main_image_ranges.clear();
    for (const auto &s : headers.sections) {
      if (!(s.characteristics & 0x40000000) || !s.vsize ||
          s.va > UINT64_MAX - mapped_base || s.vsize > UINT64_MAX - mapped_base - s.va ||
          s.va > headers.size_of_image || s.vsize > headers.size_of_image - s.va) continue;
      const auto kind = (s.characteristics & 0x20000000) ? MainImageKind::code :
                        (s.characteristics & 0x80000000) ? MainImageKind::writable :
                                                         MainImageKind::readonly;
      main_image_ranges.push_back({mapped_base + s.va, mapped_base + s.va + s.vsize, kind});
    }
  }
  bool main_image_contains(std::uint64_t address, std::size_t bytes, MainImageKind kind) const {
    if (!address || !bytes || bytes > UINT64_MAX - address) return false;
    for (const auto &r : main_image_ranges)
      if (r.kind == kind && address >= r.begin && address < r.end && bytes <= r.end - address)
        return true;
    return false;
  }

  bool in_exec_range(uint64_t address) const;
};

// Resets `out` and collects OS process facts. The caller supplies version_string
// through the engine interface after successful collection.
bool collect_engine_fingerprint(ProcessFingerprint *out, std::string *error);

#if defined(_WIN32)
// Main-thread PE metadata only; no calibrated address is dereferenced.
bool collect_engine_fingerprint_metadata(ProcessFingerprint *out, std::string *error);
#endif

// sha256 of a file's contents, lowercase hex. Empty string on failure.
std::string sha256_file(const std::string &path);

}  // namespace grc
