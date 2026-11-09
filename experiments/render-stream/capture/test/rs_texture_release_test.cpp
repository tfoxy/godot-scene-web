// HTR (rs_texture_release.h): GRC_HEADLESS_TEXTURE_RELEASE and its fault knob parse, the
// headless-only decision (ignored elsewhere, typed), the VRAM tier against 4.5.1's Image::Format,
// the predicate's order (spelled out and exhaustively), the hot line's mirror bits and their edge
// order, the counters, and the off path's cost (one relaxed load and a branch).
#include <chrono>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <string>
#include <thread>
#include <vector>

#include "rs_texture_release.h"

namespace {

int g_failures = 0;

void expect(bool ok, const std::string &what) {
  if (!ok) {
    std::fprintf(stderr, "FAIL %s\n", what.c_str());
    ++g_failures;
  }
}

// The predicate as the header comment states it, written independently of release_decision.
grc::rs::ReleaseSkip reference_decision(bool logging, bool streaming, bool omitted,
                                        std::int64_t format, bool copy_ok, bool has_content,
                                        bool ignore_predicate) {
  using grc::rs::ReleaseSkip;
  const bool tier = format >= 17 && format <= 38;  // DXT1 .. ASTC_8x8_HDR
  if (ignore_predicate) return tier ? ReleaseSkip::None : ReleaseSkip::Format;
  if (!(logging && streaming)) return ReleaseSkip::Inactive;
  if (omitted) return ReleaseSkip::Omitted;
  if (!tier) return ReleaseSkip::Format;
  if (!(copy_ok && has_content)) return ReleaseSkip::Refused;
  return ReleaseSkip::None;
}

// release_decision is constexpr (inline in the hook): it folds at compile time.
constexpr grc::rs::ReleaseInputs kReleasable{true, true, false, 19, true, true};
static_assert(grc::rs::release_decision(kReleasable, grc::rs::TextureReleaseFault::None) ==
              grc::rs::ReleaseSkip::None);
static_assert(!grc::rs::release_tier(16) && grc::rs::release_tier(17) &&
              grc::rs::release_tier(38) && !grc::rs::release_tier(39));

// The mirror bits share the line the hook already reads for the flags and the placeholder.
static_assert(sizeof(grc::rs::detail::ReleaseHot) == 64);
static_assert(offsetof(grc::rs::detail::ReleaseHot, mirror) < 64);

}  // namespace

int main() {
  using namespace grc::rs;

  // Parsing.
  {
    TextureReleaseMode mode = TextureReleaseMode::On;
    std::string why;
    expect(parse_texture_release(nullptr, &mode, &why) && mode == TextureReleaseMode::Off,
           "unset is off");
    for (const char *off : {"", "off", "0"}) {
      mode = TextureReleaseMode::On;
      expect(parse_texture_release(off, &mode, &why) && mode == TextureReleaseMode::Off,
             std::string("'") + off + "' is off");
    }
    for (const char *on : {"on", "1"}) {
      mode = TextureReleaseMode::Off;
      expect(parse_texture_release(on, &mode, &why) && mode == TextureReleaseMode::On,
             std::string(on) + " is on");
    }
    for (const char *bad : {"maybe", "ON", "true", "2", " on"}) {
      why.clear();
      expect(!parse_texture_release(bad, &mode, &why) && why.find(bad) != std::string::npos,
             std::string("'") + bad + "' is invalid, named");
    }
    TextureReleaseFault fault = TextureReleaseFault::IgnorePredicate;
    expect(parse_texture_release_fault(nullptr, &fault, &why) && fault == TextureReleaseFault::None,
           "fault unset is none");
    expect(parse_texture_release_fault("ignore-predicate", &fault, &why) &&
               fault == TextureReleaseFault::IgnorePredicate,
           "ignore-predicate parses");
    expect(!parse_texture_release_fault("release-everything", &fault, &why), "unknown fault");
    expect(std::string(texture_release_fault_name(TextureReleaseFault::IgnorePredicate)) ==
               "ignore-predicate",
           "fault name");
  }

  // The decision: active only on a headless host; ignored (typed) elsewhere; off stays off.
  {
    TextureReleaseDecision d = resolve_texture_release(TextureReleaseMode::On, "headless");
    expect(std::string(d.state) == "active" && std::string(d.reason).empty(), "on + headless");
    d = resolve_texture_release(TextureReleaseMode::On, "X11");
    expect(std::string(d.state) == "ignored" && std::string(d.reason) == "not-headless",
           "on + X11 is ignored, not-headless");
    d = resolve_texture_release(TextureReleaseMode::On, "Wayland");
    expect(std::string(d.state) == "ignored", "on + Wayland is ignored");
    d = resolve_texture_release(TextureReleaseMode::Off, "headless");
    expect(std::string(d.state) == "off" && std::string(d.reason).empty(), "off + headless");
  }

  // The tier: Image::is_format_compressed (FORMAT_DXT1 = 17 .. FORMAT_ASTC_8x8_HDR = 38).
  {
    expect(!release_tier(-1), "unread format");
    expect(!release_tier(0), "L8");
    expect(!release_tier(5), "RGBA8");
    expect(!release_tier(16), "RGBE9995");
    expect(release_tier(17), "DXT1");
    expect(release_tier(19), "DXT5");
    expect(release_tier(22), "BPTC_RGBA");
    expect(release_tier(25), "ETC");
    expect(release_tier(35), "ASTC_4x4");
    expect(release_tier(38), "ASTC_8x8_HDR");
    expect(!release_tier(39), "FORMAT_MAX");
  }

  // The predicate, in order: inactive, omitted, format, refused.
  {
    ReleaseInputs ok;
    ok.logging = true;
    ok.streaming = true;
    ok.format = 19;
    ok.copy_ok = true;
    ok.has_content = true;
    const TextureReleaseFault none = TextureReleaseFault::None;
    expect(release_decision(ok, none) == ReleaseSkip::None, "an ok DXT5 copy is released");
    ReleaseInputs in = ok;
    in.logging = false;
    expect(release_decision(in, none) == ReleaseSkip::Inactive, "no hook log: inactive");
    in = ok;
    in.streaming = false;
    expect(release_decision(in, none) == ReleaseSkip::Inactive, "no stream: inactive");
    in = ok;
    in.omitted = true;
    expect(release_decision(in, none) == ReleaseSkip::Omitted, "omit-op: omitted");
    in = ok;
    in.format = 5;
    expect(release_decision(in, none) == ReleaseSkip::Format, "RGBA8: format");
    in = ok;
    in.copy_ok = false;
    expect(release_decision(in, none) == ReleaseSkip::Refused, "refused copy");
    in = ok;
    in.has_content = false;
    expect(release_decision(in, none) == ReleaseSkip::Refused, "ok without content");
    in = ok;
    in.copy_ok = false;
    in.format = 5;
    expect(release_decision(in, none) == ReleaseSkip::Format, "format is asked before refusal");
    // The fault knob asks only the tier.
    const TextureReleaseFault ignore = TextureReleaseFault::IgnorePredicate;
    in = ReleaseInputs();
    in.format = 19;
    expect(release_decision(in, ignore) == ReleaseSkip::None, "fault: inactive DXT5 released");
    in.format = 5;
    expect(release_decision(in, ignore) == ReleaseSkip::Format, "fault: RGBA8 still kept");
  }

  // The predicate, exhaustively: every input combination over the tier's edges, both faults.
  {
    const std::int64_t formats[] = {-1, 0, 5, 16, 17, 19, 25, 38, 39, 40};
    int cases = 0;
    for (int bits = 0; bits < 32; ++bits) {
      for (const std::int64_t format : formats) {
        for (const bool ignore : {false, true}) {
          ReleaseInputs in;
          in.logging = (bits & 1) != 0;
          in.streaming = (bits & 2) != 0;
          in.omitted = (bits & 4) != 0;
          in.copy_ok = (bits & 8) != 0;
          in.has_content = (bits & 16) != 0;
          in.format = format;
          const ReleaseSkip got = release_decision(
              in, ignore ? TextureReleaseFault::IgnorePredicate : TextureReleaseFault::None);
          const ReleaseSkip want = reference_decision(in.logging, in.streaming, in.omitted, format,
                                                      in.copy_ok, in.has_content, ignore);
          expect(got == want, "predicate matrix bits=" + std::to_string(bits) +
                                  " format=" + std::to_string(format) +
                                  " ignore=" + std::to_string(ignore));
          ++cases;
        }
      }
    }
    expect(cases == 640, "predicate matrix covers every case");
  }

  // The mirror bits: set and cleared one at a time, untouched by configure.
  {
    expect(texture_release_mirror_bits() == 0, "mirror bits start clear");
    texture_release_set_mirror_bit(kMirrorOmitArmed, true);
    texture_release_set_mirror_bit(kMirrorStreaming, true);
    expect(texture_release_mirror_bits() == (kMirrorStreaming | kMirrorOmitArmed), "both set");
    texture_release_configure(kReleaseActive);
    expect(texture_release_mirror_bits() == (kMirrorStreaming | kMirrorOmitArmed),
           "configure keeps the mirror bits");
    texture_release_set_mirror_bit(kMirrorStreaming, false);
    expect(texture_release_mirror_bits() == kMirrorOmitArmed, "streaming cleared alone");
    texture_release_set_mirror_bit(kMirrorOmitArmed, false);
    expect(texture_release_mirror_bits() == 0, "omit cleared alone");
    texture_release_configure(0);
  }

  // The stream edge order: enabling sets kMirrorStreaming after the flip, disabling clears it
  // before, so the bit is clear whenever the flip runs, and the omit bit is not touched.
  {
    std::vector<std::uint32_t> at_flip;
    const auto flip = [&at_flip] { at_flip.push_back(texture_release_mirror_bits()); };
    texture_release_mirror_edge(true, flip);
    expect(texture_release_mirror_bits() == kMirrorStreaming, "enable: set after the flip");
    texture_release_set_mirror_bit(kMirrorOmitArmed, true);
    texture_release_mirror_edge(false, flip);
    expect(texture_release_mirror_bits() == kMirrorOmitArmed, "disable: cleared, omit kept");
    texture_release_set_mirror_bit(kMirrorOmitArmed, false);
    texture_release_mirror_edge(true, flip);
    texture_release_mirror_edge(true, flip);  // already enabled: the bit stays set
    expect(texture_release_mirror_bits() == kMirrorStreaming, "re-enable keeps the bit");
    texture_release_mirror_edge(false, flip);
    expect(at_flip.size() == 5, "every edge flips once");
    expect(at_flip.size() == 5 && at_flip[0] == 0 && at_flip[1] == kMirrorOmitArmed &&
               at_flip[2] == 0 && at_flip[3] == kMirrorStreaming && at_flip[4] == 0,
           "kMirrorStreaming is clear at every flip but a re-enable's");
    expect(texture_release_mirror_bits() == 0, "edges leave the bits clear");
  }

  // Counters: reset by configure, summed across threads.
  {
    texture_release_configure(kReleaseActive | kReleaseTimed);
    expect(texture_release_flags() == (kReleaseActive | kReleaseTimed), "flags stored");
    note_release_decision(ReleaseSkip::None, 4096, 120, false);
    note_release_decision(ReleaseSkip::None, 1024, 300, true);
    note_release_decision(ReleaseSkip::Inactive, 999, 10, false);
    note_release_decision(ReleaseSkip::Refused, 999, 10, false);
    note_release_decision(ReleaseSkip::Format, 999, 10, false);
    note_release_decision(ReleaseSkip::Omitted, 999, -1, false);
    note_kept_adopted(16384);
    note_release_timing(5000, 700);
    note_release_timing(9000, 300);
    ReleaseStats s = texture_release_stats();
    expect(s.released == 2 && s.released_bytes == 5120, "released + bytes");
    expect(s.released_then_unheld == 1, "unheld");
    expect(s.skipped_inactive == 1 && s.skipped_refused == 1 && s.skipped_format == 1 &&
               s.skipped_omitted == 1,
           "skips");
    expect(s.kept_adopted == 1 && s.kept_adopted_bytes == 16384, "kept adopted");
    expect(s.release_ns_total == 450 && s.release_ns_max == 300, "release ns");
    expect(s.timed_creates == 2 && s.hook_ns_total == 14000 && s.hook_ns_max == 9000 &&
               s.forward_ns_total == 1000,
           "timed");
    std::vector<std::thread> threads;
    for (int t = 0; t < 4; ++t) {
      threads.emplace_back([] {
        for (int i = 0; i < 1000; ++i) note_release_decision(ReleaseSkip::None, 1, 1, false);
      });
    }
    for (std::thread &t : threads) t.join();
    s = texture_release_stats();
    expect(s.released == 4002 && s.released_bytes == 9120, "threaded sums");
    texture_release_configure(0);
    s = texture_release_stats();
    expect(texture_release_flags() == 0 && s.released == 0 && s.kept_adopted == 0 &&
               s.timed_creates == 0,
           "configure resets");
  }

  // A loader call denied admission cannot see a later arm through the inline hot line.
  texture_release_set_mirror_bit(kMirrorStreaming, true);
  std::thread uncounted([] {
    expect(texture_release_admitted_bits(texture_release_mirror_bits(), true) == 0,
           "uncounted reader ignores an armed hot line");
  });
  uncounted.join();
  expect((texture_release_admitted_bits(texture_release_mirror_bits(), false) &
          kMirrorStreaming) != 0, "counted reader retains the hot line");
  texture_release_set_mirror_bit(kMirrorStreaming, false);

  // The off path's added cost: the hook's flag load and branch, per create (informative; the
  // result doc reports it). A volatile sink keeps the loop from folding.
  {
    texture_release_configure(0);
    constexpr int kIters = 20000000;
    volatile std::uint32_t sink = 0;
    const auto t0 = std::chrono::steady_clock::now();
    for (int i = 0; i < kIters; ++i) {
      const std::uint32_t f = texture_release_flags();
      if ((f & kReleaseActive) != 0) sink = sink + 1;
    }
    const auto t1 = std::chrono::steady_clock::now();
    const double ns =
        std::chrono::duration<double, std::nano>(t1 - t0).count() / static_cast<double>(kIters);
    std::printf("off-path flag check: %.3f ns per create (%d iterations)\n", ns, kIters);
    expect(sink == 0, "off path never takes the branch");
    expect(ns < 50.0, "off-path flag check well under 1 us");
  }

  if (g_failures != 0) {
    std::fprintf(stderr, "rs_texture_release: %d failure(s)\n", g_failures);
    return 1;
  }
  std::printf("rs_texture_release: ok\n");
  return 0;
}
