#include "macho_image.h"
#include "rs_json_lite.h"
#include "rs_sha256.h"

#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <iterator>

int main(int argc, char **argv) {
  if (argc != 3) return 2;
  std::ifstream file(argv[1], std::ios::binary);
  std::vector<uint8_t> bytes((std::istreambuf_iterator<char>(file)), {});
  const uint32_t cpu = std::strtoul(argv[2], nullptr, 0);
  grc::MachoHeaders h, streamed;
  std::map<uint64_t, grc::MachoFixup> fixups;
  std::string error, sha;
  if (!grc::macho_parse_headers(bytes.data(), bytes.size(), cpu, &h, &error) ||
      !grc::macho_read_fixups(bytes.data() + h.slice_offset, h.slice_size, h, &fixups, &error) ||
      !grc::macho_file_identity(argv[1], cpu, &streamed, &sha, &error)) {
    std::fprintf(stderr, "%s\n", error.c_str()); return 1;
  }
  if (h.uuid != streamed.uuid || h.cputype != streamed.cputype || h.cpusubtype != streamed.cpusubtype ||
      h.slice_offset != streamed.slice_offset || h.slice_size != streamed.slice_size ||
      sha != grc::sha256_hex(bytes.data() + h.slice_offset, h.slice_size)) return 1;
  std::printf("{\"uuid\":\"%s\",\"cputype\":%u,\"cpusubtype\":%u,\"slice_offset\":%llu,"
              "\"slice_size\":%llu,\"sha256\":\"%s\",\"fixups\":[", h.uuid.c_str(), h.cputype, h.cpusubtype,
              static_cast<unsigned long long>(h.slice_offset), static_cast<unsigned long long>(h.slice_size), sha.c_str());
  bool first = true;
  for (const auto &[addr, fixup] : fixups) {
    std::printf("%s[%llu,%llu,\"%s\",%lld]", first ? "" : ",", static_cast<unsigned long long>(addr),
                static_cast<unsigned long long>(fixup.value), fixup.symbol.c_str(), static_cast<long long>(fixup.addend));
    first = false;
  }
  std::puts("]}");
}
