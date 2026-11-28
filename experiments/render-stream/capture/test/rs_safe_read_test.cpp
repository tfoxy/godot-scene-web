#include "rs_platform.h"
#include <cstdio>
#include <cstring>
#if defined(_WIN32)
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#endif
int main() {
  int passed = 0;
  const char input[] = "fault tolerant";
  char output[sizeof(input)] = {};
  if (!grc::rs::safe_read_self(reinterpret_cast<std::uint64_t>(input), output, sizeof(output)) ||
      std::memcmp(input, output, sizeof(input))) return 1;
  ++passed;
  if (grc::rs::safe_read_self(1, output, sizeof(output))) return 1;
  ++passed;
#if defined(_WIN32)
  SYSTEM_INFO info{};
  GetSystemInfo(&info);
  const auto page = info.dwPageSize;
  auto *p = static_cast<unsigned char *>(VirtualAlloc(nullptr, page * 2,
                                                     MEM_RESERVE | MEM_COMMIT, PAGE_READWRITE));
  if (!p) return 1;
  const auto address = reinterpret_cast<std::uint64_t>(p);
  if (!grc::rs::safe_read_self(address, output, sizeof(output))) return 1;
  ++passed;
  if (!VirtualFree(p + page, page, MEM_DECOMMIT) ||
      grc::rs::safe_read_self(address + page, output, sizeof(output)) ||
      grc::rs::safe_read_self(address + page - 2, output, sizeof(output))) return 1;
  passed += 2;
  DWORD old = 0;
  if (!VirtualProtect(p, page, PAGE_NOACCESS, &old) ||
      grc::rs::safe_read_self(address, output, sizeof(output))) return 1;
  ++passed;
  if (!VirtualProtect(p, page, PAGE_READWRITE | PAGE_GUARD, &old) ||
      grc::rs::safe_read_self(address, output, sizeof(output))) return 1;
  ++passed;
  if (!VirtualFree(p, 0, MEM_RELEASE)) return 1;
#endif
  std::printf("%d passed, 0 failed\n", passed);
}
