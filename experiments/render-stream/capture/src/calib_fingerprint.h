// Process identity collected independently of the engine interface.
#pragma once

#include <cstdint>
#include <string>
#include <utility>
#include <vector>

namespace grc {

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
