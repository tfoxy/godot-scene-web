// Unit tests for the gate 8 policy parsing, the D2 refusal, the live subprotocol offer and the
// decode seam (src/rs_gate8_policy.*, rs_texture_decode.*; G8w; the adoption seam is rs_adopt_test).

#include <cstdio>
#include <string>

#include "rs_gate8_policy.h"
#include "rs_texture_delivery.h"
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

void test_v9_policy() {
  Gate8Policy p;
  std::string error;
  check(parse("9", nullptr, nullptr, nullptr, &p, &error) &&
            p.file_version == ProtocolVersion::V9 && !p.any() && p.speaks_v8() && p.speaks_v9(),
        "GRC_STREAM_VERSION=9 is a /9 file sink without a policy (G8k9)");
  check(!parse("7", nullptr, nullptr, nullptr, &p, &error) && error.find("6, 8 or 9") != std::string::npos,
        "GRC_STREAM_VERSION=7 is still invalid");
  check(parse("8", nullptr, nullptr, nullptr, &p, &error) && !p.speaks_v9(), "/8 does not speak /9");
  Gate8Policy policy;
  parse("9", "arm", nullptr, nullptr, &policy, &error);
  check(grc::rs::gate8_policy_allows(policy, true, &error), "a gate 8 policy is allowed on a /9 file sink");
  auto offer = grc::rs::gate8_live_subprotocols(policy);
  check(offer.size() == 2 && offer[0] == "render-stream.9" && offer[1] == "render-stream.8",
        "GRC_STREAM_VERSION=9 under a gate 8 policy offers .9 then .8");
  parse("9", nullptr, nullptr, nullptr, &policy, &error);
  offer = grc::rs::gate8_live_subprotocols(policy);
  check(offer.size() == 4 && offer[0] == "render-stream.9" && offer[1] == "render-stream.8" &&
            offer[2] == "render-stream.7" && offer[3] == "render-stream.6",
        "GRC_STREAM_VERSION=9 offers .9, .8, .7, .6");
  // .9 is never offered otherwise (G8k9).
  for (const char *version : {static_cast<const char *>(nullptr), "6", "8"}) {
    for (const char *adopt : {static_cast<const char *>(nullptr), "arm"}) {
      Gate8Policy other;
      parse(version, adopt, nullptr, nullptr, &other, &error);
      for (const std::string &name : grc::rs::gate8_live_subprotocols(other)) {
        check(name != "render-stream.9", "render-stream.9 is offered only under GRC_STREAM_VERSION=9");
      }
    }
  }
}

void test_delivery_seam() {
  grc::rs::DeliveryPolicy d;
  std::string error;
  check(grc::rs::parse_delivery_policy(nullptr, &d, &error) && d.mode == "rgba" && !d.set,
        "GRC_TEXTURE_DELIVERY unset is rgba");
  check(grc::rs::parse_delivery_policy("", &d, &error) && d.mode == "rgba" && !d.set,
        "GRC_TEXTURE_DELIVERY empty is unset");
  for (const char *mode : {"rgba", "passthrough", "basis-uastc", "basis-etc1s"}) {
    check(grc::rs::parse_delivery_policy(mode, &d, &error) && d.mode == mode && d.set,
          "each delivery mode parses");
  }
  check(!grc::rs::parse_delivery_policy("zstd", &d, &error) &&
            error.find("invalid GRC_TEXTURE_DELIVERY=zstd") == 0 && d.mode == "rgba",
        "an invalid delivery mode is refused naming the variable");
  grc::rs::parse_delivery_policy("basis-uastc", &d, &error);
  const grc::rs2::TextureDeliveryDeclaration declared = grc::rs::declare_texture_delivery(d);
  check(declared.mode == "basis-uastc" && !declared.has_encoder,
        "the declaration carries the mode and, until an encoder exists, a null encoder");
  grc::rs::VariantRequest request;
  request.hash = std::string(64, 'a');
  check(grc::rs::texture_variants(request).empty(), "no block bytes, no variant");

  // G8kp: passthrough offers `block`, the Basis modes are refused typed at /9.
  std::string why;
  grc::rs::parse_delivery_policy("passthrough", &d, &error);
  check(grc::rs::delivery_mode_implemented(d, &why), "passthrough is implemented");
  grc::rs::parse_delivery_policy("rgba", &d, &error);
  check(grc::rs::delivery_mode_implemented(d, &why), "rgba is implemented");
  for (const char *mode : {"basis-uastc", "basis-etc1s"}) {
    grc::rs::parse_delivery_policy(mode, &d, &error);
    why.clear();
    check(!grc::rs::delivery_mode_implemented(d, &why) &&
              why.find("texture-delivery-unimplemented: GRC_TEXTURE_DELIVERY=") == 0,
          "a Basis mode is refused typed until its encoder lands");
  }
  check(grc::rs::mode_offers_block("passthrough") && grc::rs::mode_offers_block("basis-uastc") &&
            !grc::rs::mode_offers_block("rgba") && !grc::rs::mode_offers_block("basis-etc1s"),
        "D1: block in passthrough and basis-uastc only");
  check(std::string(grc::rs::block_format_family("DXT5")) == "s3tc" &&
            std::string(grc::rs::block_format_family("BPTC_RGBA")) == "bptc" &&
            std::string(grc::rs::block_format_family("RGTC_RG")) == "rgtc" &&
            std::string(grc::rs::block_format_family("ETC2_RGBA8")) == "etc2" &&
            std::string(grc::rs::block_format_family("ASTC_8x8")) == "astc" &&
            grc::rs::block_format_family("DXT5_RA_AS_RG") == nullptr &&
            grc::rs::block_format_family("BPTC_RGBFU") == nullptr &&
            grc::rs::block_format_family("RGBA8") == nullptr,
        "block families follow Godot's feature names");
  // render-stream-9.md "Texture payload": 64x64 DXT1 = 2048 B; DXT5 with mips 64..1 =
  // 4096+1024+256+64+16+16+16 = 5488; ASTC_8x8 10x10 = 2x2 blocks of 16 B = 64.
  check(grc::rs::block_data_bytes("DXT1", 64, 64, false) == 2048 &&
            grc::rs::block_data_bytes("DXT5", 64, 64, true) == 5488 &&
            grc::rs::block_data_bytes("ASTC_8x8", 10, 10, false) == 64 &&
            grc::rs::block_data_bytes("RGBA8", 4, 4, false) == -1,
        "block data sizes are Godot's");
  grc::rs::parse_delivery_policy("passthrough", &d, &error);
  grc::rs::texture_delivery_set_policy(d);
  request.block.hash = std::string(64, 'b');
  request.block.format = "DXT5";
  request.block.payload_bytes = 100;
  const std::vector<grc::rs2::TextureVariant> offered = grc::rs::texture_variants(request);
  check(offered.size() == 1 && offered[0].encoding == grc::rs2::VariantEncoding::Block &&
            offered[0].hash == request.block.hash && offered[0].has_format &&
            offered[0].format == "DXT5" && !offered[0].has_params &&
            offered[0].payload_bytes == 100,
        "passthrough offers the hooked bytes as one block variant");
  request.block.hash = request.hash;
  check(grc::rs::texture_variants(request).empty(), "never a variant repeating the base hash");
  request.block.hash = std::string(64, 'b');
  grc::rs::parse_delivery_policy("rgba", &d, &error);
  grc::rs::texture_delivery_set_policy(d);
  check(grc::rs::texture_variants(request).empty(), "rgba offers no variant");
  grc::rs::texture_delivery_set_policy(grc::rs::DeliveryPolicy());
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
  check(!grc::rs::texture_decode_enabled(), "texture decode is off by default");
  grc::rs::texture_decode_set_enabled(true);
  check(grc::rs::texture_decode_enabled(), "texture decode can be enabled");
  grc::rs::DecodeRequest request;
  request.format = 17;  // DXT1
  check(!grc::rs::texture_decode(request).handled, "with no engine the decode seam declines");
  grc::rs::texture_decode_set_enabled(false);
}

}  // namespace

int main() {
  test_defaults();
  test_values();
  test_invalid();
  test_refusal();
  test_v9_policy();
  test_delivery_seam();
  test_subprotocols();
  test_seams();
  if (g_failures != 0) {
    std::fprintf(stderr, "%d failure(s)\n", g_failures);
    return 1;
  }
  std::printf("rs_gate8_policy_test: all checks passed\n");
  return 0;
}
