// The headless CanvasTexture shim (protocol/canvas-texture-headless.md, option (a), "Experiment
// (a) result"). GRC_HEADLESS_CANVAS_TEXTURE=synthesize, or unset/`auto` on a headless host at
// render-stream/12+ (HSD, headless_defaults_apply below). `off` or empty, or `auto` below /12, keeps
// the G2d typed refusal (canvas-texture-headless) and leaves this module inert.
//
// A headless host runs the dummy rasterizer, whose canvas_texture_allocate() returns RID()
// (servers/rendering/dummy/storage/texture_storage.h:54), so every CanvasTexture shares the null
// RID. Armed, the shim replaces that RID() result of the canvas_texture_create hook with a private
// RID, so the engine, the mirror and the hook log all name each CanvasTexture by its own identity.
//
// This is the one deliberate exception to the pass-through tap (the engine receives a value the
// server did not return), so it is fenced:
//   - It arms only when the display server is `headless` (the arm-time decision in entry.cpp
//     refuses the whole capture otherwise: a real renderer would dereference the private RID).
//   - It synthesizes only when the engine returned RID(); a non-null engine result passes through
//     untouched and is counted (`engine_allocated`), so a dummy that starts allocating degrades to
//     plain pass-through instead of a collision.
//   - Private RIDs are `kTag << 32 | (2^31 + n)`. An RID_Alloc RID is `validator << 32 | index`
//     and owns() rejects any index at or past max_alloc (core/templates/rid_owner.h:167-170,
//     :317-323), which is far below 2^31 (owners cap their element count), so no engine owner can
//     ever own or mint one. The dummy storage ignores every canvas_texture_* call whatever the RID
//     (texture_storage.h:54-62), a draw stores it unvalidated (renderer_canvas_cull.cpp:1619), and
//     free() of an unknown RID falls through every owner silently (dummy/storage/utilities.cpp:
//     53-73), so the frees are forwarded unchanged.
// Engine-free, so a ctest drives it.
#ifndef GRC_RS_CANVAS_TEXTURE_SHIM_H
#define GRC_RS_CANVAS_TEXTURE_SHIM_H

#include <cstdint>
#include <mutex>
#include <string>
#include <vector>

namespace grc {
namespace rs {

enum class CanvasTextureShimMode { Off, Synthesize };

// GRC_HEADLESS_CANVAS_TEXTURE: unset (nullptr), "" or "off" -> Off; "synthesize" -> Synthesize;
// anything else is invalid (returns false, `*error` set).
bool parse_canvas_texture_shim_mode(const char *value, CanvasTextureShimMode *out,
                                    std::string *error);

// HSD (render-stream-12.md "Headless defaults (HSD)"): the default of the three headless
// compensations -- this shim, the particles RID shim and the pre-draw pump -- when their variable
// is unset or `auto`. They default ON exactly for a `headless` display server whose stream is
// render-stream/12 or later (GRC_STREAM_VERSION, a plain decimal); everything else (a rendered
// host, an older stream, an unparsable version) defaults off, so a rendered host's wire and every
// pre-/12 headless recording are unchanged. A headless seat without them streams no
// CanvasTexture draw (every spine), no GPU-particles emitter, no CPUParticles2D buffer and no
// AnimatedTexture frame: a dummy renderer allocates none of those identities and never emits
// frame_pre_draw.
bool headless_defaults_apply(const std::string &display_server, const char *stream_version);

// The effective value of one of those variables: `value` itself when it is set to anything but
// "auto"; otherwise `on_value` when `defaults_on`, else `off_value`. (An explicitly empty value
// stays empty, which each parser reads as off, as before HSD.)
std::string resolve_headless_default(const char *value, bool defaults_on, const char *on_value,
                                     const char *off_value);

// The arm-time decision: may the shim arm on a host whose DisplayServer.get_name() is
// `display_server`? Off always "may" (nothing arms). Synthesize needs exactly "headless";
// otherwise false with `*reason` = "canvas-texture-shim-not-headless".
bool canvas_texture_shim_may_arm(CanvasTextureShimMode mode, const std::string &display_server,
                                 std::string *reason);

class CanvasTextureShim {
 public:
  // The high word of every private RID ("GRCT") and the first private index (2^31).
  static constexpr std::uint64_t kTag = 0x47524354ull;
  static constexpr std::uint64_t kIndexBase = 0x80000000ull;

  // A private RID's index (low word) is at or above 2^31 and its high word is kTag.
  static bool is_synthetic(std::uint64_t rid);

  // Arms (Synthesize) or disarms (Off) the shim; resets every table. `display_server` is
  // recorded for the evidence file.
  void configure(CanvasTextureShimMode mode, const std::string &display_server);
  bool armed() const;

  // After the hooked canvas_texture_create forwarded: the RID the engine must receive. Off, or a
  // non-null engine result: `engine_rid` unchanged. Armed and RID(): a fresh private RID.
  std::uint64_t on_create(std::uint64_t engine_rid, std::uint64_t frame);
  // The hooked free(), before it forwards: records the free of a private RID (no-op otherwise).
  void on_free(std::uint64_t rid, std::uint64_t frame);

  // evidence/canvas-texture-shim.json (render-stream-canvas-texture-shim/1).
  std::string evidence_json(const std::string &state, const std::string &reason) const;

  std::uint64_t synthesized() const;
  std::uint64_t engine_allocated() const;
  // Live private RIDs (created and not yet freed).
  std::uint64_t live() const;

 private:
  struct Entry {
    std::uint64_t rid = 0;
    std::uint64_t created_frame = 0;
    std::uint64_t freed_frame = 0;  // 0: still live
    std::uint64_t frees = 0;
  };
  mutable std::mutex mutex_;
  CanvasTextureShimMode mode_ = CanvasTextureShimMode::Off;
  std::string display_server_;
  std::uint64_t next_index_ = kIndexBase;
  std::uint64_t engine_allocated_ = 0;
  std::uint64_t foreign_frees_ = 0;  // frees naming a tagged RID this shim never made
  std::vector<Entry> entries_;
};

// The process-wide shim the hooks consult.
CanvasTextureShim &canvas_texture_shim();

}  // namespace rs
}  // namespace grc

#endif  // GRC_RS_CANVAS_TEXTURE_SHIM_H
