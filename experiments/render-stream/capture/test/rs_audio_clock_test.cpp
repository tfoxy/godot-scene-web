#include "rs_audio_clock.h"
#include <cstdio>
using namespace grc::audio;
int main() {
  int passed = 0, failed = 0;
  auto check = [&](bool ok, const char *s) { if (ok) ++passed; else { ++failed; std::fprintf(stderr,"FAIL: %s\n", s); } };
  VoiceClock c;
  check(!c.any(), "empty clock fast path");
  c.start(1, 1, .25, 1.5, false, 1000000, nullptr);
  check(!c.due(1499999) && c.due(1500000), "remaining frames/rate/pitch deadline");
  check(std::abs(c.position(1, 1100000) - .4) < 1e-10, "position advances at pitch");
  c.pause(1, true, 1100000);
  check(!c.due(9999999) && c.position(1, 2000000) == .4, "pause freezes position and deadline");
  c.pause(1, false, 2000000); c.pitch(1, 2, 2100000);
  check(std::abs(c.position(1, 2100000) - .55) < 1e-10 && c.due(2325000), "pitch integrates preceding segment");
  check(c.remove(1).key == 1 && !c.any() && !c.remove(1).key, "remove exactly once");
  for (size_t i = 1; i <= kAudioVoices; ++i) c.start(i, double(kAudioVoices - i + 1), 0, 1, false, 0, nullptr);
  check(!c.start(999, 1, 0, 1, false, 0, nullptr), "fixed voice maximum");
  bool sorted = true;
  for (size_t i = kAudioVoices; i; --i) { sorted &= c.top_key() == i; c.remove(i); }
  check(sorted && !c.any(), "heap drains earliest deadlines across full slab");
  c.start(1, .01, 0, 1, true, 0, nullptr);
  check(!c.due(UINT64_MAX), "loop has no completion deadline");
  c.start(2, 1, 0, 1, false, 0, nullptr); c.pitch(1, 4, 1000);
  check(c.top_key() == 2, "loop updates preserve finite top");
  std::printf("rs_audio_clock: %d passed, %d failed\n",passed,failed); return failed ? 1 : 0;
}
