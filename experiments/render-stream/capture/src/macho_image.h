// Portable 64-bit little-endian Mach-O view. File offsets are relative to the selected slice.
#pragma once
#include <array>
#include <cstddef>
#include <cstdint>
#include <map>
#include <string>
#include <vector>

namespace grc {
constexpr uint32_t macho_arm64 = 0x0100000c, macho_x86_64 = 0x01000007;
struct MachoSection {
  std::string name;
  uint64_t addr = 0, size = 0, offset = 0;
  uint32_t flags = 0;
};
struct MachoSegment {
  std::string name;
  uint64_t addr = 0, size = 0, offset = 0, file_size = 0;
  uint32_t protection = 0, flags = 0;
};
struct MachoHeaders {
  uint32_t cputype = 0, cpusubtype = 0;
  uint64_t slice_offset = 0, slice_size = 0, image_base = 0;
  bool pie = false;
  std::string uuid;
  std::vector<MachoSegment> segments;
  std::vector<MachoSection> sections;
  std::array<uint32_t, 10> dyld_info{};
  uint32_t chained_offset = 0, chained_size = 0;
};
// A zero cputype is allowed only for a thin file. A mapped view contains just the
// thin header and load commands: segment file ranges are checked only for files.
bool macho_parse_headers(const uint8_t *data, size_t size, uint32_t cputype,
                         MachoHeaders *out, std::string *error, bool mapped = false);
struct MachoFixup {
  uint64_t value = 0;
  std::string symbol;  // nonempty for a dyld bind, whose runtime value is not in the file
  int64_t addend = 0;
};
bool macho_read_fixups(const uint8_t *slice, size_t size, const MachoHeaders &headers,
                       std::map<uint64_t, MachoFixup> *out, std::string *error);
// Hash only the selected slice. CPU, UUID, offset and size are returned from the file.
bool macho_file_identity(const std::string &path, uint32_t cputype,
                         MachoHeaders *out, std::string *sha256, std::string *error);
}  // namespace grc
