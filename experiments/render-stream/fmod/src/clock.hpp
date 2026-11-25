#ifndef GRC_FMOD_CLOCK_HPP
#define GRC_FMOD_CLOCK_HPP
#include "rs_audio_wire.h"
#include "rs_sha256.h"
#include <chrono>
#include <fstream>
#if defined(__APPLE__)
#include <sys/sysctl.h>
#include <sys/time.h>
#elif defined(_WIN32)
#include <windows.h>
#endif
namespace grc::fmod {
inline std::uint64_t now_us() {
  return std::chrono::duration_cast<std::chrono::microseconds>(
      std::chrono::steady_clock::now().time_since_epoch()).count();
}
inline std::string boot_domain(const char *platform, std::uint64_t seconds) {
  grc::Sha256 hash;
  static constexpr char prefix[] = "grc-clock-boot-1";
  hash.update(prefix, sizeof(prefix));
  hash.update(platform, std::char_traits<char>::length(platform) + 1);
  std::uint8_t time[8];
  for (unsigned i = 0; i < 8; ++i) time[i] = (seconds >> (i * 8)) & 255;
  hash.update(time, sizeof(time));
  return grc::sha256_hex(hash.finish()).substr(0, 32);
}
inline std::string uuid_domain(std::string uuid) {
  if (uuid.size() != 36 || uuid[8] != '-' || uuid[13] != '-' || uuid[18] != '-' || uuid[23] != '-')
    return std::string(32, '0');
  std::string out;
  for (unsigned i = 0; i < uuid.size(); ++i) {
    if (i == 8 || i == 13 || i == 18 || i == 23) continue;
    char c = uuid[i]; if (c >= 'A' && c <= 'F') c += 'a' - 'A';
    if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) return std::string(32, '0');
    out += c;
  }
  return out;
}
inline std::string clock_domain() {
#if defined(__linux__)
  std::ifstream input("/proc/sys/kernel/random/boot_id"); std::string uuid;
  if (std::getline(input, uuid)) return uuid_domain(uuid);
#elif defined(__APPLE__)
  timeval boot{}; std::size_t n = sizeof(boot);
  if (sysctlbyname("kern.boottime", &boot, &n, nullptr, 0) == 0 && n == sizeof(boot) && boot.tv_sec > 0)
    return boot_domain("darwin", boot.tv_sec);
#elif defined(_WIN32)
  struct TimeOfDay { LARGE_INTEGER boot, current, zone; ULONG zone_id, reserved; ULONGLONG boot_bias, sleep_bias; } time{};
  using Query = LONG (WINAPI *)(ULONG, void *, ULONG, ULONG *);
  auto library = GetModuleHandleW(L"ntdll.dll");
  auto query = library ? reinterpret_cast<Query>(GetProcAddress(library, "NtQuerySystemInformation")) : nullptr;
  ULONG got = 0;
  if (query && query(3, &time, sizeof(time), &got) >= 0 && got >= sizeof(time) && time.boot.QuadPart > 0)
    return boot_domain("windows", time.boot.QuadPart / 10000000);
#endif
  return std::string(32, '0');
}
}
#endif
