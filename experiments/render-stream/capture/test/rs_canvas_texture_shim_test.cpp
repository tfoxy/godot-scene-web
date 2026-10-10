// The opt-in headless CanvasTexture shim (rs_canvas_texture_shim.h): GRC_HEADLESS_CANVAS_TEXTURE
// parsing, the headless-only arm decision, private RIDs (tag "GRCT", index >= 2^31) only when the
// engine returned RID(), pass-through when off or when the engine allocated, free bookkeeping and
// the evidence file's shape.
#include <cstdint>
#include <cstdio>
#include <set>
#include <string>

#include "rs_canvas_texture_shim.h"

namespace {

int g_failures = 0;

void expect(bool ok, const std::string &what) {
  if (!ok) {
    std::fprintf(stderr, "FAIL %s\n", what.c_str());
    ++g_failures;
  }
}

bool contains(const std::string &text, const std::string &needle) {
  return text.find(needle) != std::string::npos;
}

}  // namespace

int main() {
  using grc::rs::CanvasTextureShim;
  using grc::rs::CanvasTextureShimMode;

  // Parsing.
  {
    CanvasTextureShimMode mode = CanvasTextureShimMode::Synthesize;
    std::string error;
    expect(grc::rs::parse_canvas_texture_shim_mode(nullptr, &mode, &error) &&
               mode == CanvasTextureShimMode::Off,
           "unset parses as off");
    mode = CanvasTextureShimMode::Synthesize;
    expect(grc::rs::parse_canvas_texture_shim_mode("", &mode, &error) &&
               mode == CanvasTextureShimMode::Off,
           "empty parses as off");
    expect(grc::rs::parse_canvas_texture_shim_mode("off", &mode, &error) &&
               mode == CanvasTextureShimMode::Off,
           "off parses as off");
    expect(grc::rs::parse_canvas_texture_shim_mode("synthesize", &mode, &error) &&
               mode == CanvasTextureShimMode::Synthesize,
           "synthesize parses");
    for (const char *bad : {"1", "on", "Synthesize", "synthesize ", "synth"}) {
      error.clear();
      expect(!grc::rs::parse_canvas_texture_shim_mode(bad, &mode, &error) && !error.empty(),
             std::string("refuses ") + bad);
    }
  }

  // The arm decision: synthesize only on a headless display server.
  {
    std::string reason;
    expect(grc::rs::canvas_texture_shim_may_arm(CanvasTextureShimMode::Off, "x11", &reason),
           "off arms anywhere (nothing arms)");
    expect(grc::rs::canvas_texture_shim_may_arm(CanvasTextureShimMode::Synthesize, "headless",
                                                &reason),
           "synthesize arms on headless");
    for (const char *ds : {"x11", "wayland", "", "Headless", "windows"}) {
      reason.clear();
      expect(!grc::rs::canvas_texture_shim_may_arm(CanvasTextureShimMode::Synthesize, ds,
                                                   &reason) &&
                 reason == "canvas-texture-shim-not-headless",
             std::string("synthesize refuses display server \"") + ds + "\"");
    }
  }

  // Off: every result passes through, nothing is recorded.
  {
    CanvasTextureShim shim;
    shim.configure(CanvasTextureShimMode::Off, "headless");
    expect(!shim.armed(), "off is not armed");
    expect(shim.on_create(0, 5) == 0, "off keeps RID()");
    expect(shim.on_create(1234, 5) == 1234, "off keeps an engine RID");
    expect(shim.synthesized() == 0 && shim.engine_allocated() == 0, "off records nothing");
  }

  // Synthesize.
  {
    CanvasTextureShim shim;
    shim.configure(CanvasTextureShimMode::Synthesize, "headless");
    expect(shim.armed(), "synthesize is armed");
    std::set<std::uint64_t> seen;
    for (int i = 0; i < 5; ++i) {
      const std::uint64_t rid = shim.on_create(0, 10 + i);
      expect(rid != 0, "a private RID is not null");
      expect((rid & 0xFFFFFFFFull) >= 0x80000000ull, "the private index is at or above 2^31");
      expect((rid >> 32) == CanvasTextureShim::kTag, "the high word is the tag");
      expect(CanvasTextureShim::is_synthetic(rid), "is_synthetic recognises it");
      expect(seen.insert(rid).second, "private RIDs are unique");
    }
    expect(*seen.begin() == ((CanvasTextureShim::kTag << 32) | 0x80000000ull),
           "the first private index is exactly 2^31");
    // A real RID_Alloc RID (validator << 32 | small index) is never synthetic, even with the tag
    // as its validator.
    expect(!CanvasTextureShim::is_synthetic((CanvasTextureShim::kTag << 32) | 7),
           "a tag-validator RID with an engine index is not synthetic");
    expect(!CanvasTextureShim::is_synthetic(90194313218ull), "an engine RID is not synthetic");
    expect(!CanvasTextureShim::is_synthetic(0), "RID() is not synthetic");
    // A non-null engine result passes through and is counted.
    expect(shim.on_create(90194313218ull, 20) == 90194313218ull, "an engine RID passes through");
    expect(shim.engine_allocated() == 1, "engine_allocated counts it");
    expect(shim.synthesized() == 5 && shim.live() == 5, "five live private RIDs");
    // Frees.
    const std::uint64_t first = *seen.begin();
    shim.on_free(first, 30);
    shim.on_free(first, 31);  // a double free is counted, the first frame kept
    shim.on_free(90194313218ull, 30);  // engine RIDs are not the shim's business
    shim.on_free((CanvasTextureShim::kTag << 32) | 0xFFFFFF00ull, 30);  // tagged, never made
    expect(shim.live() == 4, "one freed");
    const std::string json = shim.evidence_json("armed", "");
    expect(contains(json, "\"schema\": \"render-stream-canvas-texture-shim/1\"") ||
               contains(json, "\"schema\":\"render-stream-canvas-texture-shim/1\""),
           "evidence schema");
    expect(contains(json, std::to_string(first)), "evidence lists the first RID");
    expect(contains(json, "\"foreign_frees\": 1") || contains(json, "\"foreign_frees\":1"),
           "a tagged RID the shim never made counts as foreign");
    expect(contains(json, "\"frees\": 2") || contains(json, "\"frees\":2"),
           "the double free is counted");
    // configure resets.
    shim.configure(CanvasTextureShimMode::Synthesize, "headless");
    expect(shim.synthesized() == 0 && shim.on_create(0, 1) == first, "configure resets the table");
  }

  if (g_failures != 0) {
    std::fprintf(stderr, "rs_canvas_texture_shim_test: %d failure(s)\n", g_failures);
    return 1;
  }
  std::printf("rs_canvas_texture_shim_test: ok\n");
  return 0;
}
