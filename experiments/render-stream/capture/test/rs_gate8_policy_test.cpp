// Unit tests for the gate 8 policy parsing, the D2 refusal, the live subprotocol offer and the two
// empty seams (src/rs_gate8_policy.*, rs_adopt.*, rs_texture_decode.*; G8w).

#include <cstdio>
#include <string>

#include "rs_adopt.h"
#include "rs_gate8_policy.h"
#include "rs_texture_decode.h"

namespace {

using grc::rs::Gate8Policy;
using grc::rs2::ProtocolVersion;

int g_failures = 0;

void check(bool condition, const char *what) {
  if (!condition) {
    std::fprintf(stderr, "FAIL %s\n", what);
    ++g_failures;
  }
}

bool parse(const char *version, const char *adopt, const char *decode, const char *formats,
           Gate8Policy *out, std::string *error) {
  return grc::rs::parse_gate8_policy(version, adopt, decode, formats, out, error);
}

void test_defaults() {
  Gate8Policy p;
  std::string error;
  check(parse(nullptr, nullptr, nullptr, nullptr, &p, &error), "unset variables parse");
  check(!p.any() && !p.speaks_v8() && p.file_version == ProtocolVersion::V6,
        "unset variables are the default: /6 files, no policy");
  check(parse("", "", "", "", &p, &error) && !p.any() && !p.stream_version_set,
        "empty variables are unset");
  check(parse("6", "off", "off", "L8,RGBA8", &p, &error) && !p.any() && p.stream_version_set,
        "explicit defaults are still no policy");
}

void test_values() {
  Gate8Policy p;
  std::string error;
  check(parse("8", nullptr, nullptr, nullptr, &p, &error) &&
            p.file_version == ProtocolVersion::V8 && !p.any() && p.speaks_v8(),
        "GRC_STREAM_VERSION=8 is a /8 file sink without a policy");
  check(parse(nullptr, "arm", nullptr, nullptr, &p, &error) && p.adopt && p.any(),
        "GRC_ADOPT=arm is a policy");
  check(parse(nullptr, nullptr, "engine", nullptr, &p, &error) && p.decode_engine && p.any(),
        "GRC_TEXTURE_DECODE=engine is a policy");
  check(parse(nullptr, nullptr, nullptr, "RGBA8,RGBAF", &p, &error) && p.float_formats && p.any(),
        "a float format in GRC_RESOURCE_FORMATS is a policy");
  check(!grc::rs::formats_name_float("RGBA8,RGBE9995,DXT1"), "non-float names are no policy");
  for (const char *name : {"RF", "RGF", "RGBF", "RGBAF", "RH", "RGH", "RGBH", "RGBAH"}) {
    check(grc::rs::formats_name_float(name), "each of the eight float formats is recognized");
  }
}

void test_invalid() {
  Gate8Policy p;
  std::string error;
  check(!parse("7", nullptr, nullptr, nullptr, &p, &error) &&
            error.find("GRC_STREAM_VERSION=7") != std::string::npos,
        "GRC_STREAM_VERSION=7 is invalid (a file sink is 6 or 8)");
  check(!parse("x", nullptr, nullptr, nullptr, &p, &error), "GRC_STREAM_VERSION=x is invalid");
  check(!parse(nullptr, "on", nullptr, nullptr, &p, &error) &&
            error.find("GRC_ADOPT=on") != std::string::npos,
        "GRC_ADOPT=on is invalid");
  check(!parse(nullptr, nullptr, "gpu", nullptr, &p, &error) &&
            error.find("GRC_TEXTURE_DECODE=gpu") != std::string::npos,
        "GRC_TEXTURE_DECODE=gpu is invalid");
  check(!p.any(), "a failed parse leaves the default policy");
}

void test_refusal() {
  Gate8Policy p;
  std::string error;
  parse(nullptr, "arm", "engine", "RGBA8,RGBAF", &p, &error);
  check(!grc::rs::gate8_policy_allows(p, true, &error) &&
            error.rfind("policy-needs-v8: ", 0) == 0 &&
            error.find("GRC_ADOPT=arm") != std::string::npos &&
            error.find("GRC_TEXTURE_DECODE=engine") != std::string::npos &&
            error.find("float format") != std::string::npos,
        "a policy with a /6 file sink refuses, naming every variable (policy-needs-v8)");
  check(grc::rs::gate8_policy_allows(p, false, &error), "a policy with no file sink is allowed");
  parse("8", "arm", nullptr, nullptr, &p, &error);
  check(grc::rs::gate8_policy_allows(p, true, &error), "a policy with a /8 file sink is allowed");
  parse(nullptr, nullptr, nullptr, nullptr, &p, &error);
  check(grc::rs::gate8_policy_allows(p, true, &error), "no policy and a /6 file sink is allowed");
  parse("6", "arm", nullptr, nullptr, &p, &error);
  check(!grc::rs::gate8_policy_allows(p, true, &error),
        "an explicit GRC_STREAM_VERSION=6 with a policy still refuses");
  Gate8Policy sabotage;
  sabotage.v8_sabotage = true;
  check(!grc::rs::gate8_policy_allows(sabotage, true, &error) &&
            error.find("GRC_SABOTAGE") != std::string::npos,
        "a /8-only sabotage kind needs a /8 file sink too");
  check(grc::rs::sabotage_needs_v8(grc::rs2::SabotageKind::PerturbDecode) &&
            grc::rs::sabotage_needs_v8(grc::rs2::SabotageKind::AdoptSkipParams) &&
            !grc::rs::sabotage_needs_v8(grc::rs2::SabotageKind::PerturbGlyph) &&
            !grc::rs::sabotage_needs_v8(grc::rs2::SabotageKind::None),
        "sabotage_needs_v8 names exactly the seven /8 kinds");
}

void test_subprotocols() {
  Gate8Policy p;
  std::string error;
  parse(nullptr, nullptr, nullptr, nullptr, &p, &error);
  auto offer = grc::rs::gate8_live_subprotocols(p);
  check(offer.size() == 3 && offer[0] == "render-stream.7" && offer[1] == "render-stream.6" &&
            offer[2] == "render-stream.8",
        "the default offer keeps /7 first and /6 second, with /8 last");
  parse("8", nullptr, nullptr, nullptr, &p, &error);
  offer = grc::rs::gate8_live_subprotocols(p);
  check(offer.size() == 3 && offer[0] == "render-stream.8" && offer[1] == "render-stream.7",
        "GRC_STREAM_VERSION=8 prefers /8");
  parse(nullptr, "arm", nullptr, nullptr, &p, &error);
  offer = grc::rs::gate8_live_subprotocols(p);
  check(offer.size() == 1 && offer[0] == "render-stream.8",
        "a gate 8 policy offers only render-stream.8");
}

void test_seams() {
  grc::rs::AdoptConfig config;
  config.arm_frame = 3;
  const grc::rs::AdoptStats stats = grc::rs::adopt_at_arm(config);
  check(stats.ran && stats.canvases == 0 && stats.layers == 0 && stats.items == 0 &&
            stats.residue == 0,
        "the empty adoption seam runs and adopts nothing");
  check(!grc::rs::texture_decode_enabled(), "texture decode is off by default");
  grc::rs::texture_decode_set_enabled(true);
  check(grc::rs::texture_decode_enabled(), "texture decode can be enabled");
  grc::rs::DecodeRequest request;
  request.format = 17;  // DXT1
  check(!grc::rs::texture_decode(request).handled, "the empty decode seam declines");
  grc::rs::texture_decode_set_enabled(false);
}

}  // namespace

int main() {
  test_defaults();
  test_values();
  test_invalid();
  test_refusal();
  test_subprotocols();
  test_seams();
  if (g_failures != 0) {
    std::fprintf(stderr, "%d failure(s)\n", g_failures);
    return 1;
  }
  std::printf("rs_gate8_policy_test: all checks passed\n");
  return 0;
}
