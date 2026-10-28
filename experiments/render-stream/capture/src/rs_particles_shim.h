// PM5 (render-stream-12.md "Headless shims (opt-in)"): the particles RID shim and the pre-draw
// pump's option parsing. Both are OPT-IN and engine-free here (a ctest drives them):
//
//   GRC_HEADLESS_PARTICLES  unset, "" or "off" -> off; "synthesize" -> the particles RID shim.
//   GRC_PREDRAW_PUMP        unset, "" or "0" -> off; "1" -> the pre-draw pump (entry.cpp).
//
// Any other value is invalid and refuses the stream.
//
// The particles RID shim follows rs_canvas_texture_shim.h's fence exactly: a headless host's dummy
// particles_allocate() returns RID() (servers/rendering/dummy/storage/particles_storage.h), so every
// emitter shares the null RID. Armed (only on a `headless` display server; the capture refuses to
// arm otherwise), the particles_create hook replaces a RID() result with a private RID
// `kTag << 32 | (2^31 + n)` with its own tag ("GRCP"), which no RID_Alloc owner can own or mint
// (an owner's index is far below 2^31). A non-null engine result passes through, counted
// (`engine_allocated`). The dummy ignores every particles_* call whatever the RID, a canvas
// command stores it unvalidated, and free() of an unknown RID falls through every owner silently,
// so frees are forwarded unchanged.
#ifndef GRC_RS_PARTICLES_SHIM_H
#define GRC_RS_PARTICLES_SHIM_H

#include <cstdint>
#include <mutex>
#include <string>

namespace grc {
namespace rs {

enum class ParticlesShimMode { Off, Synthesize };

bool parse_particles_shim_mode(const char *value, ParticlesShimMode *out, std::string *error);
// Off always may; Synthesize needs exactly "headless" (`*reason` =
// "particles-shim-not-headless" otherwise).
bool particles_shim_may_arm(ParticlesShimMode mode, const std::string &display_server,
                            std::string *reason);
// GRC_PREDRAW_PUMP: unset/""/"0" -> false, "1" -> true; anything else invalid.
bool parse_predraw_pump(const char *value, bool *out, std::string *error);

class ParticlesShim {
 public:
  static constexpr std::uint64_t kTag = 0x47524350ull;  // "GRCP"
  static constexpr std::uint64_t kIndexBase = 0x80000000ull;
  static bool is_synthetic(std::uint64_t rid);

  void configure(ParticlesShimMode mode);
  bool armed() const;
  // After the hooked particles_create forwarded: the RID the engine must receive.
  std::uint64_t on_create(std::uint64_t engine_rid);
  // The hooked free(), before it forwards: counts the free of a private RID (no-op otherwise).
  void on_free(std::uint64_t rid);

  std::uint64_t synthesized() const;
  std::uint64_t engine_allocated() const;
  std::uint64_t freed() const;

 private:
  mutable std::mutex mutex_;
  ParticlesShimMode mode_ = ParticlesShimMode::Off;
  std::uint64_t next_index_ = kIndexBase;
  std::uint64_t synthesized_ = 0;
  std::uint64_t engine_allocated_ = 0;
  std::uint64_t freed_ = 0;
};

ParticlesShim &particles_shim();

}  // namespace rs
}  // namespace grc

#endif  // GRC_RS_PARTICLES_SHIM_H
