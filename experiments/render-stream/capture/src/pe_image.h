// Portable PE32+ identity reader. Addresses use the preferred ImageBase.
#pragma once
#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

namespace grc {
struct PeSection {
  std::string name;
  uint32_t va, vsize, raw_off, raw_size, characteristics;
};
struct PeHeaders {
  uint64_t image_base = 0;
  uint32_t time_date_stamp = 0, size_of_image = 0, size_of_headers = 0;
  uint16_t dll_characteristics = 0;
  uint32_t debug_rva = 0, debug_size = 0;
  std::vector<PeSection> sections;
};
bool pe_parse_headers(const uint8_t *p, size_t n, PeHeaders *out, std::string *error);
// Empty for absent or invalid CodeView data. GUID bytes retain file order.
std::string pe_codeview_id(const uint8_t *image, size_t n, const PeHeaders &h, bool mapped);
// Checked form distinguishes absent debug data from malformed or conflicting entries.
bool pe_read_codeview_id(const uint8_t *image, size_t n, const PeHeaders &h, bool mapped,
                         std::string *id, std::string *error);
bool pe_image_sha256(const std::string &utf8_path, std::string *hex, uint64_t *bytes,
                     uint64_t *preferred_image_base, std::string *error);
}  // namespace grc
