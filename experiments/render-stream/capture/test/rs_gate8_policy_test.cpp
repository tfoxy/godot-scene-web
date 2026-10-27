// Unit tests for the gate 8 policy parsing, the D2 refusal, the live subprotocol offer and the
// decode seam (src/rs_gate8_policy.*, rs_texture_decode.*; G8w; the adoption seam is rs_adopt_test).

#include <cstdio>
#include <cstdint>
#include <string>
#include <vector>

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
  check(!parse("7", nullptr, nullptr, nullptr, &p, &error) && error.find("6, 8, 9, 10 or 11") != std::string::npos,
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

// CG1 (render-stream-10.md "Capture policy", "Live transport").
void test_v10_policy() {
  Gate8Policy p;
  std::string error;
  check(parse("10", nullptr, nullptr, nullptr, &p, &error) &&
            p.file_version == ProtocolVersion::V10 && !p.any() && p.speaks_v8() &&
            p.speaks_v9() && p.speaks_v10(),
        "GRC_STREAM_VERSION=10 is a /10 file sink without a policy, speaking /8 and /9's keys");
  check(parse("9", nullptr, nullptr, nullptr, &p, &error) && !p.speaks_v10(),
        "/9 does not speak /10");
  check(!parse("12", nullptr, nullptr, nullptr, &p, &error) &&
            error.find("6, 8, 9, 10 or 11") != std::string::npos,
        "GRC_STREAM_VERSION=12 is invalid");
  check(!parse("A", nullptr, nullptr, nullptr, &p, &error), "GRC_STREAM_VERSION=A is invalid");
  Gate8Policy policy;
  parse("10", "arm", nullptr, nullptr, &policy, &error);
  check(grc::rs::gate8_policy_allows(policy, true, &error),
        "a gate 8 policy is allowed on a /10 file sink");
  auto offer = grc::rs::gate8_live_subprotocols(policy);
  check(offer.size() == 3 && offer[0] == "render-stream.10" && offer[1] == "render-stream.9" &&
            offer[2] == "render-stream.8",
        "GRC_STREAM_VERSION=10 under a gate 8 policy offers .10, .9 then .8");
  parse("10", nullptr, nullptr, nullptr, &policy, &error);
  offer = grc::rs::gate8_live_subprotocols(policy);
  check(offer.size() == 5 && offer[0] == "render-stream.10" && offer[1] == "render-stream.9" &&
            offer[2] == "render-stream.8" && offer[3] == "render-stream.7" &&
            offer[4] == "render-stream.6",
        "GRC_STREAM_VERSION=10 offers .10, .9, .8, .7, .6");
  // .10 is never offered otherwise.
  for (const char *version : {static_cast<const char *>(nullptr), "6", "8", "9"}) {
    for (const char *adopt : {static_cast<const char *>(nullptr), "arm"}) {
      Gate8Policy other;
      parse(version, adopt, nullptr, nullptr, &other, &error);
      for (const std::string &name : grc::rs::gate8_live_subprotocols(other)) {
        check(name != "render-stream.10",
              "render-stream.10 is offered only under GRC_STREAM_VERSION=10");
      }
    }
  }
}

// W11b (render-stream-11.md "Opt-in and version policy", "Sabotage kinds").
void test_v11_policy() {
  Gate8Policy p;
  std::string error;
  check(parse("11", nullptr, nullptr, nullptr, &p, &error) &&
            p.file_version == ProtocolVersion::V11 && !p.any() && p.speaks_v8() &&
            p.speaks_v9() && p.speaks_v10() && p.speaks_v11(),
        "GRC_STREAM_VERSION=11 is a /11 file sink speaking /8 to /10's keys");
  check(parse("10", nullptr, nullptr, nullptr, &p, &error) && !p.speaks_v11(),
        "/10 does not speak /11");
  Gate8Policy policy;
  parse("11", "arm", nullptr, nullptr, &policy, &error);
  auto offer = grc::rs::gate8_live_subprotocols(policy);
  check(offer == std::vector<std::string>{"render-stream.11", "render-stream.10", "render-stream.9",
                                          "render-stream.8"},
        "GRC_STREAM_VERSION=11 under a gate 8 policy offers .11, .10, .9 then .8");
  parse("11", nullptr, nullptr, nullptr, &policy, &error);
  offer = grc::rs::gate8_live_subprotocols(policy);
  check(offer == std::vector<std::string>{"render-stream.11", "render-stream.10", "render-stream.9",
                                          "render-stream.8", "render-stream.7", "render-stream.6"},
        "GRC_STREAM_VERSION=11 offers .11, .10, .9, .8, .7, .6");
  for (const char *version : {static_cast<const char *>(nullptr), "6", "8", "9", "10"}) {
    for (const char *adopt : {static_cast<const char *>(nullptr), "arm"}) {
      Gate8Policy other;
      parse(version, adopt, nullptr, nullptr, &other, &error);
      for (const std::string &name : grc::rs::gate8_live_subprotocols(other)) {
        check(name != "render-stream.11",
              "render-stream.11 is offered only under GRC_STREAM_VERSION=11");
      }
    }
  }
  using grc::rs2::MeshDynamicMode;
  using grc::rs2::MeshDynamicPolicy;
  MeshDynamicPolicy m;
  check(grc::rs::parse_mesh_dynamic_policy(nullptr, nullptr, nullptr, &m, &error) &&
            m.mode == MeshDynamicMode::Auto && m.frames == 4 && m.max_bytes == 65536,
        "GRC_MESH_DYNAMIC* unset: auto, 4 frames, 65536 bytes");
  check(grc::rs::parse_mesh_dynamic_policy("off", "1", "0", &m, &error) &&
            m.mode == MeshDynamicMode::Off && m.frames == 1 && m.max_bytes == 0,
        "off, 1 frame, 0 bytes parse");
  check(grc::rs::parse_mesh_dynamic_policy("all", "60", "", &m, &error) &&
            m.mode == MeshDynamicMode::All && m.frames == 60 && m.max_bytes == 65536,
        "all and 60 frames parse; an empty max is unset");
  check(!grc::rs::parse_mesh_dynamic_policy("dynamic", nullptr, nullptr, &m, &error) &&
            error.find("invalid GRC_MESH_DYNAMIC=dynamic") == 0 && m.mode == MeshDynamicMode::Auto,
        "an unknown mode is refused naming the variable");
  for (const char *frames : {"0", "61", "-1", "4x", " 4"}) {
    check(!grc::rs::parse_mesh_dynamic_policy(nullptr, frames, nullptr, &m, &error) &&
              error.find("invalid GRC_MESH_DYNAMIC_FRAMES=") == 0,
          "a bad GRC_MESH_DYNAMIC_FRAMES is refused");
  }
  check(!grc::rs::parse_mesh_dynamic_policy(nullptr, nullptr, "-5", &m, &error) &&
            error.find("invalid GRC_MESH_DYNAMIC_MAX_BYTES=") == 0,
        "a negative max is refused");
  using grc::rs2::SabotageKind;
  check(grc::rs::sabotage_needs_v11(SabotageKind::CvChurn) &&
            grc::rs::sabotage_needs_v11(SabotageKind::StaleDynamic) &&
            grc::rs::sabotage_needs_v11(SabotageKind::KeepCarried) &&
            !grc::rs::sabotage_needs_v11(SabotageKind::PerturbVertex) &&
            !grc::rs::sabotage_needs_v8(SabotageKind::CvChurn),
        "cv-churn, stale-dynamic and keep-carried need /11 (and only they)");
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
  check(declared.mode == "basis-uastc" && declared.has_encoder && declared.encoder == "basisu-1.60",
        "basis-uastc declares the mode and the basisu encoder (G8ku)");
  grc::rs::parse_delivery_policy("basis-etc1s", &d, &error);
  check(!grc::rs::declare_texture_delivery(d).has_encoder,
        "basis-etc1s declares a null encoder until G8ke");
  grc::rs::VariantRequest request;
  request.hash = std::string(64, 'a');
  check(grc::rs::texture_variants(request).empty(), "no block bytes, no variant");

  // G8kp: passthrough offers `block`, the Basis modes are refused typed at /9.
  std::string why;
  grc::rs::parse_delivery_policy("passthrough", &d, &error);
  check(grc::rs::delivery_mode_implemented(d, &why), "passthrough is implemented");
  grc::rs::parse_delivery_policy("rgba", &d, &error);
  check(grc::rs::delivery_mode_implemented(d, &why), "rgba is implemented");
  grc::rs::parse_delivery_policy("basis-uastc", &d, &error);
  check(grc::rs::delivery_mode_implemented(d, &why), "basis-uastc is implemented (G8ku)");
  for (const char *mode : {"basis-etc1s"}) {
    grc::rs::parse_delivery_policy(mode, &d, &error);
    why.clear();
    check(!grc::rs::delivery_mode_implemented(d, &why) &&
              why.find("texture-delivery-unimplemented: GRC_TEXTURE_DELIVERY=") == 0,
          "basis-etc1s is refused typed until G8ke");
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

  // G8ku: basis-uastc lists block then uastc, the uastc one only once its encode is attached.
  grc::rs::parse_delivery_policy("basis-uastc", &d, &error);
  grc::rs::texture_delivery_set_policy(d);
  check(grc::rs::texture_variants(request).size() == 1, "basis-uastc before an encode: block only");
  request.uastc_hash = std::string(64, 'c');
  request.uastc_payload_bytes = 77;
  request.uastc_params = "basisu-1.60/uastc-l1/zstd6/linear";
  const std::vector<grc::rs2::TextureVariant> both = grc::rs::texture_variants(request);
  check(both.size() == 2 && both[0].encoding == grc::rs2::VariantEncoding::Block &&
            both[1].encoding == grc::rs2::VariantEncoding::Uastc && !both[1].has_format &&
            both[1].has_params && both[1].params == request.uastc_params &&
            both[1].payload_bytes == 77,
        "basis-uastc lists block, then the attached uastc variant");
  request.uastc_hash = request.hash;
  check(grc::rs::texture_variants(request).size() == 1, "never a uastc variant repeating the base hash");
  grc::rs::parse_delivery_policy("passthrough", &d, &error);
  grc::rs::texture_delivery_set_policy(d);
  request.uastc_hash = std::string(64, 'c');
  check(grc::rs::texture_variants(request).size() == 1, "passthrough never lists uastc");
  grc::rs::texture_delivery_set_policy(grc::rs::DeliveryPolicy());

  // G8ku: the Basis knobs and D12.
  grc::rs::BasisConfig b;
  check(grc::rs::parse_basis_config(nullptr, nullptr, nullptr, nullptr, nullptr, &b, &error) &&
            b.uastc_level == grc::rs::kDefaultUastcLevel && b.min_px == 16384 &&
            b.encode_workers == 2 && b.wait_frame == 0 && !b.fault_perturb,
        "Basis defaults: level 1, 128x128, 2 encode workers, no wait, no fault");
  check(grc::rs::parse_basis_config("2", "1", "4", "30", "perturb-ktx2", &b, &error) &&
            b.uastc_level == 2 && b.min_px == 1 && b.encode_workers == 4 && b.wait_frame == 30 &&
            b.fault_perturb,
        "Basis knobs parse");
  check(grc::rs::parse_basis_config(nullptr, nullptr, nullptr, nullptr, "corrupt-ktx2", &b, &error) &&
            b.fault_corrupt && !b.fault_perturb &&
            grc::rs::parse_basis_config(nullptr, nullptr, nullptr, nullptr, "perturb-ktx2", &b, &error) &&
            b.fault_perturb && !b.fault_corrupt,
        "corrupt-ktx2 and perturb-ktx2 are separate fault knobs");
  check(!grc::rs::parse_basis_config("5", nullptr, nullptr, nullptr, nullptr, &b, &error) &&
            error.find("invalid GRC_TEXTURE_UASTC_LEVEL=5") == 0,
        "a UASTC level above 4 is refused naming the variable");
  check(!grc::rs::parse_basis_config(nullptr, nullptr, "0", nullptr, nullptr, &b, &error) &&
            !grc::rs::parse_basis_config(nullptr, nullptr, "17", nullptr, nullptr, &b, &error) &&
            !grc::rs::parse_basis_config(nullptr, nullptr, nullptr, nullptr, "flip", &b, &error),
        "bad encode workers and an unknown fault are refused");
  check(!b.drain, "GRC_TEXTURE_ENCODE_DRAIN is off by default");
  check(grc::rs::parse_basis_config(nullptr, nullptr, nullptr, nullptr, nullptr, &b, &error, "1") &&
            b.drain &&
            grc::rs::parse_basis_config(nullptr, nullptr, nullptr, nullptr, nullptr, &b, &error, "0") &&
            !b.drain &&
            !grc::rs::parse_basis_config(nullptr, nullptr, nullptr, nullptr, nullptr, &b, &error, "yes") &&
            error.find("invalid GRC_TEXTURE_ENCODE_DRAIN=yes") == 0,
        "GRC_TEXTURE_ENCODE_DRAIN parses 0/1 and refuses anything else naming the variable");
  check(grc::rs::basis_decline_reason("RGBA8", 128, 128, false, 16384) == nullptr &&
            grc::rs::basis_decline_reason("RGB8", 256, 64, false, 16384) == nullptr &&
            std::string(grc::rs::basis_decline_reason("RGBA8", 128, 128, true, 16384)) == "updated" &&
            std::string(grc::rs::basis_decline_reason("LA8", 256, 256, false, 16384)) == "format" &&
            std::string(grc::rs::basis_decline_reason("RGBAF", 256, 256, false, 16384)) == "format" &&
            std::string(grc::rs::basis_decline_reason("RGBA8", 127, 128, false, 16384)) == "small",
        "D12: updated, format and size decide, in that order");
  // A 2x1 RGB8 GRT1 with mipmaps (levels 2x1, 1x1): RGB8 gains alpha 255.
  {
    std::vector<std::uint8_t> p = {0x47, 0x52, 0x54, 0x31, 0x0D, 0x0A, 0x1A, 0x0A, 2, 0, 0, 0, '{', '}', 9, 0, 0, 0,
                                   1, 2, 3, 4, 5, 6, 7, 8, 9};
    std::vector<std::vector<std::uint8_t>> levels;
    check(grc::rs::grt1_rgba8_levels(p, "RGB8", 2, 1, true, &levels) && levels.size() == 2 &&
              levels[0] == std::vector<std::uint8_t>({1, 2, 3, 255, 4, 5, 6, 255}) &&
              levels[1] == std::vector<std::uint8_t>({7, 8, 9, 255}),
          "a GRT1's levels become straight RGBA8");
    check(!grc::rs::grt1_rgba8_levels(p, "RGB8", 2, 1, false, &levels) && levels.empty(),
          "a payload longer than its shape is refused");
  }
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
  test_v10_policy();
  test_v11_policy();
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
