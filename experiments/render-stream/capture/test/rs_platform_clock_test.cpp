#include "rs_platform.h"

#include <cerrno>
#include <cstdio>
#include <ctime>

namespace {
bool fail_clock = false;
}

extern "C" int __wrap_clock_gettime(clockid_t clock, timespec *ts) {
  if (clock != CLOCK_REALTIME) {
    std::fprintf(stderr, "FAIL: expected CLOCK_REALTIME\n");
    return -1;
  }
  if (fail_clock) {
    errno = EINVAL;
    return -1;
  }
  ts->tv_sec = 123456789;
  ts->tv_nsec = 987654321;
  return 0;
}

int main() {
  if (grc::rs::wall_clock_s() != 123456789) {
    std::fprintf(stderr, "FAIL: wall clock must return tv_sec\n");
    return 1;
  }
  fail_clock = true;
  if (grc::rs::wall_clock_s() != 0) {
    std::fprintf(stderr, "FAIL: wall clock failure must preserve zero-initialized tv_sec\n");
    return 1;
  }
  std::puts("2/2 wall clock cases passed");
  return 0;
}
