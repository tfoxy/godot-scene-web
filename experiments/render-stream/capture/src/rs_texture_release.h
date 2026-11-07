// HTR: the opt-in headless texture
// release, GRC_HEADLESS_TEXTURE_RELEASE=off|on.
//
// On a `headless` display server the dummy rasterizer keeps `p_image->duplicate()` of every
// texture for the RID's life (servers/rendering/dummy/storage/texture_storage.h:82-86). For a
// texture the capture has already copied and hashed (hooks.cpp hook_texture_2d_create), that copy
// is dead weight: nothing in the capture reads it again, because every read-back path
// (rs_adopt.cpp adopt_texture_locked_out) bails on `mirror().knows_texture(rid)`. With the switch
// on, the hook forwards one capture-owned 1x1 FORMAT_L8 Image instead of the game's (mechanism
// (a)): the dummy never allocates or keeps the full copy, and the wire is unchanged byte for byte
// (its content was captured from the original before the forward).
//
// The predicate, decided in the hook before the forward:
//   - the switch is active (on, and the display server is `headless`);
//   - the hook log is active, the stream runs, and the omit-op sabotage does not drop the call;
//   - the source format is a VRAM-compressed tier (Image::is_format_compressed: DXT1..ASTC_8x8_HDR);
//   - the copy is `ok`, with bytes or a worker job.
// Everything else (pre-arm textures, refusals, RGBA8, lossless .ctex, ImageTexture) keeps its
// dummy copy. A rendered host ignores the switch (`ignored`, reason `not-headless`): off is always
// safe, so unlike the HSD shims it does not refuse the capture. An invalid value refuses it
// (`headless-texture-release-invalid`).
//
// This file is the pure part (parsing, the decision, the tier, the counters); the engine calls
// (the placeholder Image, the forward) are hooks.cpp's.
#ifndef GRC_RS_TEXTURE_RELEASE_H
#define GRC_RS_TEXTURE_RELEASE_H

#include <atomic>
#include <cstdint>
#include <string>

namespace grc {
namespace rs {

enum class TextureReleaseMode { Off, On };

// GRC_HEADLESS_TEXTURE_RELEASE: unset, "", "off" or "0" is Off; "on" or "1" is On. Anything else
// is false with `why` naming the value.
bool parse_texture_release(const char *value, TextureReleaseMode *out, std::string *why);

// GRC_HEADLESS_TEXTURE_RELEASE_FAULT (the sabotage knob, not a GRC_SABOTAGE kind: the wire is not
// touched): unset or "" is None; "ignore-predicate" releases every tier texture the hook sees,
// inactive and refused ones included, so a pre-arm texture adoption later reads back is a 1x1.
enum class TextureReleaseFault { None, IgnorePredicate };
bool parse_texture_release_fault(const char *value, TextureReleaseFault *out, std::string *why);
const char *texture_release_fault_name(TextureReleaseFault fault);

// The arm decision: `active` (On on a headless host), `off`, or `ignored` (On elsewhere, reason
// `not-headless`).
struct TextureReleaseDecision {
  const char *state = "off";  // "active" | "off" | "ignored"
  const char *reason = "";    // "" | "not-headless"
};
TextureReleaseDecision resolve_texture_release(TextureReleaseMode mode,
                                               const std::string &display_server);

// Whether `format` (an Image::Format) is in the release tier: a VRAM-compressed format, as the
// product's HeadlessTextureImageEvictor's tier.
bool release_tier(std::int64_t format);

// Why a create was not released (None: it was).
enum class ReleaseSkip { None, Inactive, Omitted, Format, Refused };

struct ReleaseInputs {
  bool logging = false;    // resources().active()
  bool streaming = false;  // the stream runs
  bool omitted = false;    // the omit-op sabotage drops the call
  std::int64_t format = -1;  // the source Image::Format
  bool copy_ok = false;      // copy.status == "ok"
  bool has_content = false;  // bytes or a worker job
};

// The predicate (header comment). With IgnorePredicate only the tier is asked.
ReleaseSkip release_decision(const ReleaseInputs &in, TextureReleaseFault fault);

// Flags read by the hook with one load: kReleaseActive arms the predicate; kReleaseTimed (the
// variable is set, whatever its value) adds the hook and forward times to the counters, so an
// explicit `off` leg is timed like an `on` leg. Zero (the variable unset) is the default path.
constexpr std::uint32_t kReleaseActive = 1u;
constexpr std::uint32_t kReleaseTimed = 2u;
constexpr std::uint32_t kReleaseFaultIgnorePredicate = 4u;

namespace detail {
// What the hook reads on every create, in one cache line: a create that follows a multi-ms decode
// finds its caches cold, so each separate line the predicate touches is a miss.
struct alignas(64) ReleaseHot {
  std::atomic<std::uint32_t> flags{0};
  std::atomic<void *> placeholder{nullptr};  // the engine Image (hooks.cpp owns its reference)
};
extern ReleaseHot g_release_hot;
}  // namespace detail

// Set once on the main thread before the vptr store (entry.cpp); stats are reset.
void texture_release_configure(std::uint32_t flags);
inline std::uint32_t texture_release_flags() {
  return detail::g_release_hot.flags.load(std::memory_order_relaxed);
}
// The 1x1 placeholder Image object a released create forwards (nullptr: none).
inline void *texture_release_placeholder() {
  return detail::g_release_hot.placeholder.load(std::memory_order_acquire);
}
void texture_release_set_placeholder(void *object);

// Totals since configure, for result.json's `headless_texture_release`.
struct ReleaseStats {
  std::int64_t released = 0;
  std::int64_t released_bytes = 0;  // the source data_size the dummy no longer holds
  std::int64_t released_then_unheld = 0;  // released, but the mirror did not take the texture
  std::int64_t kept_adopted = 0;  // tier textures adoption read back (their dummy copy stays)
  std::int64_t kept_adopted_bytes = 0;
  std::int64_t skipped_inactive = 0;
  std::int64_t skipped_refused = 0;
  std::int64_t skipped_format = 0;
  std::int64_t skipped_omitted = 0;
  std::int64_t release_ns_total = 0;  // the predicate plus the swap, every decided create
  std::int64_t release_ns_max = 0;
  // kReleaseTimed: the hook's own time (the forward excluded) and the forward's, per create.
  std::int64_t timed_creates = 0;
  std::int64_t hook_ns_total = 0;
  std::int64_t hook_ns_max = 0;
  std::int64_t forward_ns_total = 0;
};

void note_release_decision(ReleaseSkip skip, std::int64_t data_bytes, std::int64_t release_ns,
                           bool unheld);
void note_kept_adopted(std::int64_t data_bytes);
void note_release_timing(std::int64_t hook_ns, std::int64_t forward_ns);
ReleaseStats texture_release_stats();

}  // namespace rs
}  // namespace grc

#endif  // GRC_RS_TEXTURE_RELEASE_H
