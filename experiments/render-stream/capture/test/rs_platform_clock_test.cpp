#include "rs_platform.h"

#include <cerrno>
#include <cstdio>
#include <ctime>

#if defined(_WIN32)
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>

#include <chrono>

namespace {
bool thread_cpu_100ns(std::uint64_t *out) {
  FILETIME creation{}, exit{}, kernel{}, user{};
  if (!::GetThreadTimes(::GetCurrentThread(), &creation, &exit, &kernel, &user)) return false;
  *out = (static_cast<std::uint64_t>(kernel.dwHighDateTime) << 32 | kernel.dwLowDateTime) +
         (static_cast<std::uint64_t>(user.dwHighDateTime) << 32 | user.dwLowDateTime);
  return true;
}
}

int main() {
  int checks = 0, failures = 0;
  const auto check = [&](bool ok, const char *name, std::int64_t a = 0, std::int64_t b = 0) {
    ++checks;
    if (!ok) {
      ++failures;
      std::fprintf(stderr, "FAIL WLS clock %s: observed=%lld/%lld\n", name,
                   static_cast<long long>(a), static_cast<long long>(b));
    }
  };
  grc::rs::ThreadCpuClock thread;
  check(!grc::rs::tsc_info(), "calibration is lazy");
  check(thread.elapsed_us() == -1, "elapsed before mark", thread.elapsed_us());
  check(!grc::rs::tsc_info(), "unarmed elapsed does not calibrate");
  const auto mark = thread.mark();
  check(mark >= 0, "mark before arm", mark);
  check(thread.elapsed_us() == -1, "elapsed before arm", thread.elapsed_us());
  std::uint64_t start = 0, now = 0;
  const bool readable = thread_cpu_100ns(&start);
  check(readable, "GetThreadTimes");
  const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(5);
  bool spun = false;
  if (readable) {
    do {
      if (!thread_cpu_100ns(&now)) break;
      if (now - start >= 50000) { spun = true; break; }
    } while (std::chrono::steady_clock::now() < deadline);
  }
  check(spun, "five ms independent CPU spin", now - start);
  const auto delta = thread.ns_since(mark);
  check(delta >= 1000000, "unarmed CPU delta", delta);
  check(thread.elapsed_us() == -1, "mark does not arm", thread.elapsed_us());
  check(thread.arm(), "first arm");
  const auto freeze = std::chrono::steady_clock::now() + std::chrono::seconds(1);
  while (std::chrono::steady_clock::now() < freeze) {}
  const auto info = grc::rs::tsc_info();
  check(info && info->hz > 0, "frozen rate", info ? info->hz : -1);
  check(thread.elapsed_us() >= 1000, "armed elapsed", thread.elapsed_us());
  check(thread.arm(), "second arm");
  grc::rs::ThreadCpuClock second;
  check(second.arm(), "another clock arm");
  const auto after = grc::rs::tsc_info();
  check(info && after && info->hz == after->hz, "process-wide rate survives arms",
        info ? info->hz : -1, after ? after->hz : -1);
  check(thread.ns_since(-1) == -1, "invalid mark");
  std::printf("rs_platform_clock_test: %d checks, %d failures\n", checks, failures);
  return failures ? 1 : 0;
}
#else
namespace {
bool fail_clock = false;
clockid_t expected_clock = CLOCK_REALTIME;
timespec clock_value{123456789, 987654321};
int clock_reads = 0;
}

extern "C" int __wrap_clock_gettime(clockid_t clock, timespec *ts) {
  ++clock_reads;
  if (clock != expected_clock) {
    std::fprintf(stderr, "FAIL: unexpected clock id\n");
    return -1;
  }
  if (fail_clock) {
    errno = EINVAL;
    return -1;
  }
  *ts = clock_value;
  return 0;
}

int main() {
  int checks = 0, failures = 0;
  auto check = [&](bool ok, const char *what) {
    ++checks;
    if (!ok) {
      ++failures;
      std::fprintf(stderr, "FAIL: %s\n", what);
    }
  };
  check(grc::rs::wall_clock_s() == 123456789, "wall clock must return tv_sec");
  fail_clock = true;
  check(grc::rs::wall_clock_s() == 0, "wall clock failure must preserve zero-initialized tv_sec");
  fail_clock = false;
  expected_clock = CLOCK_THREAD_CPUTIME_ID;
  grc::rs::ThreadCpuClock thread;
  check(thread.elapsed_us() == -1, "unarmed thread CPU clock must return -1");
  const auto mark = thread.mark();
  check(mark == 123456789987654000LL, "mark truncates POSIX microseconds before conversion");
  clock_value.tv_nsec = 987655001;
  check(thread.ns_since(mark) == 1000, "mark delta truncates each reading");
  check(thread.ns_since(-1) == -1, "invalid mark remains unavailable");
  clock_value.tv_nsec = 987654321;
  const int before_arm = clock_reads;
  check(thread.arm(), "thread CPU clock must arm");
  check(clock_reads == before_arm + 1, "arm must take one clock sample");
  check(thread.now_ns() == 123456789987654321LL, "thread CPU clock must preserve ns");
  check(thread.now_us() == 123456789987654LL, "thread CPU clock must preserve truncated us");
  check(thread.elapsed_us() == 0, "elapsed must start at zero");
  clock_value.tv_nsec = 987655001;
  check(thread.elapsed_us() == 1, "elapsed must subtract individually truncated microseconds");
  clock_value = {123456790, 123};
  check(thread.elapsed_us() == 12346, "elapsed must preserve the perf.json second-boundary delta");
  fail_clock = true;
  check(thread.mark() == -1, "mark read failure remains unavailable");
  check(thread.ns_since(mark) == -1, "delta read failure remains unavailable");
  check(thread.now_ns() == -1, "thread CPU ns sample failure must return -1");
  check(thread.now_us() == -1, "thread CPU us sample failure must return -1");
  check(thread.elapsed_us() == -1, "elapsed sample failure must return -1");
  check(!thread.arm(), "arm must fail when its clock sample fails");
  fail_clock = false;
  check(thread.elapsed_us() == -1, "failed arm must invalidate the previous baseline");
  check(thread.arm(), "thread CPU clock must rearm");
  check(thread.elapsed_us() == 0, "successful rearm must reset the baseline");
  std::printf("rs_platform_clock_test: %d checks, %d failures\n", checks, failures);
  return failures ? 1 : 0;
}
#endif
