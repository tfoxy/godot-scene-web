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
  grc::rs::ThreadCpuClock thread;
  if (thread.elapsed_us() != -1 || !thread.arm()) {
    std::fprintf(stderr, "FAIL: thread CPU clock must be unavailable before a successful arm\n");
    return 1;
  }
  const auto immediate = thread.elapsed_us();
  if (immediate < -1) {
    std::fprintf(stderr, "FAIL: immediate elapsed sample must be -1 or nonnegative\n");
    return 1;
  }
  std::uint64_t start = 0, now = 0;
  if (!thread_cpu_100ns(&start)) {
    std::fprintf(stderr, "FAIL: cannot read thread CPU time for spin\n");
    return 1;
  }
  // Use an independent CPU counter so descheduling cannot finish the spin early.
  const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(5);
  do {
    if (!thread_cpu_100ns(&now) || std::chrono::steady_clock::now() >= deadline) {
      std::fprintf(stderr, "FAIL: thread CPU spin did not complete\n");
      return 1;
    }
  } while (now - start < 50000);  // At least 5 ms of CPU, at the counter's resolution.
  if (thread.elapsed_us() < 1000) {
    std::fprintf(stderr, "FAIL: elapsed thread CPU time must be calibrated after CPU spin\n");
    return 1;
  }
  std::puts("4/4 clock cases passed");
  return 0;
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
