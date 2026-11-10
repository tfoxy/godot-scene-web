#include "pe_image.h"
#include "rs_platform.h"
#include <algorithm>
#include <cstdio>
#include <fstream>
#include <iterator>
#include <vector>

int main(int argc, char **argv) {
  if (argc != 2) return 2;
  std::ifstream file(argv[1], std::ios::binary);
  std::vector<uint8_t> data((std::istreambuf_iterator<char>(file)), {});
  grc::PeHeaders h;
  std::string error, hash;
  uint64_t bytes = 0, base = 0;
  if (!grc::pe_parse_headers(data.data(), data.size(), &h, &error) ||
      !grc::pe_image_sha256(argv[1], &hash, &bytes, &base, &error)) {
    std::fprintf(stderr, "%s\n", error.c_str()); return 1;
  }
  std::string id;
  if (!grc::pe_read_codeview_id(data.data(), data.size(), h, false, &id, &error)) {
    std::fprintf(stderr, "%s\n", error.c_str()); return 1;
  }
  std::vector<uint8_t> mapped(h.size_of_image);
  if (h.size_of_headers > data.size() || h.size_of_headers > mapped.size()) return 1;
  std::copy_n(data.begin(), h.size_of_headers, mapped.begin());
  for (const auto &s : h.sections) {
    const auto size = std::min(s.vsize, s.raw_size);
    if (uint64_t(s.va) + size > mapped.size() || uint64_t(s.raw_off) + size > data.size()) return 1;
    std::copy_n(data.begin() + s.raw_off, size, mapped.begin() + s.va);
  }
  if (id != grc::pe_codeview_id(mapped.data(), mapped.size(), h, true)) return 1;
  std::printf("{\"image_sha256\":\"%s\",\"image_hashed_bytes\":%llu,\"image_base\":\"0x%llx\","
    "\"codeview_id\":%s,\"time_date_stamp\":%u,\"size_of_image\":%u,\"dynamic_base\":%s,\"dll_characteristics\":%u}\n",
    hash.c_str(), static_cast<unsigned long long>(bytes), static_cast<unsigned long long>(base),
    id.empty() ? "null" : ("\"" + id + "\"").c_str(), h.time_date_stamp, h.size_of_image,
    h.dll_characteristics & 0x40 ? "true" : "false", h.dll_characteristics);
}
