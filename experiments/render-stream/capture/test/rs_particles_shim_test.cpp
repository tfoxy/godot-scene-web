// PM5: the particles RID shim (rs_particles_shim.h) and GRC_PREDRAW_PUMP's parsing.
#include <cstdio>
#include <string>

#include "rs_particles_shim.h"

namespace {

int g_failures = 0;

void check(bool condition, const char *what) {
  if (!condition) {
    std::fprintf(stderr, "FAIL %s\n", what);
    ++g_failures;
  }
}

using grc::rs::ParticlesShim;
using grc::rs::ParticlesShimMode;

void test_parse() {
  ParticlesShimMode mode = ParticlesShimMode::Synthesize;
  std::string error;
  check(grc::rs::parse_particles_shim_mode(nullptr, &mode, &error) && mode == ParticlesShimMode::Off,
        "unset is off");
  check(grc::rs::parse_particles_shim_mode("off", &mode, &error) && mode == ParticlesShimMode::Off,
        "off");
  check(grc::rs::parse_particles_shim_mode("synthesize", &mode, &error) &&
            mode == ParticlesShimMode::Synthesize,
        "synthesize");
  check(!grc::rs::parse_particles_shim_mode("on", &mode, &error) && !error.empty(),
        "anything else is invalid");
  std::string reason;
  check(grc::rs::particles_shim_may_arm(ParticlesShimMode::Synthesize, "headless", &reason),
        "arms on headless");
  check(!grc::rs::particles_shim_may_arm(ParticlesShimMode::Synthesize, "x11", &reason) &&
            reason == "particles-shim-not-headless",
        "refuses a real display server");
  check(grc::rs::particles_shim_may_arm(ParticlesShimMode::Off, "x11", &reason), "off may");
  bool pump = true;
  check(grc::rs::parse_predraw_pump(nullptr, &pump, &error) && !pump, "pump unset is off");
  check(grc::rs::parse_predraw_pump("0", &pump, &error) && !pump, "pump 0");
  check(grc::rs::parse_predraw_pump("1", &pump, &error) && pump, "pump 1");
  check(!grc::rs::parse_predraw_pump("yes", &pump, &error), "pump: anything else is invalid");
}

void test_shim() {
  ParticlesShim shim;
  shim.configure(ParticlesShimMode::Off);
  check(shim.on_create(0) == 0 && shim.synthesized() == 0, "off passes RID() through");
  shim.configure(ParticlesShimMode::Synthesize);
  const std::uint64_t a = shim.on_create(0);
  const std::uint64_t b = shim.on_create(0);
  check(a != 0 && b != 0 && a != b, "armed: distinct private RIDs");
  check(ParticlesShim::is_synthetic(a) && (a >> 32) == ParticlesShim::kTag &&
            (a & 0xffffffffull) == ParticlesShim::kIndexBase,
        "kTag << 32 | 2^31 + n");
  check(shim.on_create(77) == 77 && shim.engine_allocated() == 1,
        "a non-null engine result passes through, counted");
  check(!ParticlesShim::is_synthetic(77) && !ParticlesShim::is_synthetic((0x47524354ull << 32) |
                                                                        0x80000000ull),
        "an engine RID and the canvas-texture shim's tag are not this shim's");
  shim.on_free(a);
  shim.on_free(77);
  check(shim.synthesized() == 2 && shim.freed() == 1, "frees of private RIDs are counted");
  shim.configure(ParticlesShimMode::Synthesize);
  check(shim.synthesized() == 0 && shim.on_create(0) == a, "configure resets the counter");
}

}  // namespace

int main() {
  test_parse();
  test_shim();
  if (g_failures != 0) {
    std::fprintf(stderr, "%d failure(s)\n", g_failures);
    return 1;
  }
  std::printf("rs_particles_shim_test: all checks passed\n");
  return 0;
}
