// Unit test for src/rs_shader_payload.cpp: the GRP1 payload encoder, the D11 token scan and the
// D7 CanvasItemMaterial template recognizer (gate5_5-design.md Q3a, Q4). Engine-free, as
// rs_mesh_payload_test.cpp is for GRM1.

#include <cstdint>
#include <cstdio>
#include <string>
#include <vector>

#include "rs_sha256.h"
#include "rs_shader_payload.h"

namespace {

int g_failures = 0;

void check(bool condition, const char *what) {
  if (!condition) {
    std::fprintf(stderr, "FAIL %s\n", what);
    ++g_failures;
  }
}

void test_payload_shape() {
  const std::string code = "shader_type canvas_item;\nvoid fragment() { COLOR = vec4(1.0); }\n";
  const std::vector<uint8_t> payload = grc::rs::encode_payload(code);

  // Magic.
  const uint8_t expected_magic[8] = {0x47, 0x52, 0x50, 0x31, 0x0D, 0x0A, 0x1A, 0x0A};
  bool magic_ok = payload.size() >= 8;
  for (int i = 0; magic_ok && i < 8; ++i) {
    magic_ok = payload[static_cast<size_t>(i)] == expected_magic[i];
  }
  check(magic_ok, "GRP1 magic bytes");

  const std::string meta = grc::rs::payload_meta(code.size());
  check(meta == "{\"type\":\"shader-code\",\"code_bytes\":" + std::to_string(code.size()) + "}",
       "canonical meta JSON");

  const uint32_t meta_len =
      static_cast<uint32_t>(payload[8]) | (static_cast<uint32_t>(payload[9]) << 8) |
      (static_cast<uint32_t>(payload[10]) << 16) | (static_cast<uint32_t>(payload[11]) << 24);
  check(meta_len == meta.size(), "meta_len field");

  const std::string meta_bytes(reinterpret_cast<const char *>(payload.data()) + 12, meta_len);
  check(meta_bytes == meta, "meta bytes");

  const std::string data_bytes(
      reinterpret_cast<const char *>(payload.data()) + 12 + static_cast<long>(meta_len),
      payload.size() - 12 - meta_len);
  check(data_bytes == code, "the code travels byte-exact, after the header");

  check(payload.size() == grc::rs::shader_payload_size(meta, code.size()),
       "shader_payload_size matches");

  // The content address is the whole payload's SHA-256 (as GRT1/GRM1).
  const std::string hash = grc::sha256_hex(payload.data(), payload.size());
  check(hash.size() == 64, "a lowercase hex SHA-256 digest");

  // An empty code still encodes (shader_create() alone has none yet; a payload with zero data
  // bytes is still well-formed).
  const std::vector<uint8_t> empty_payload = grc::rs::encode_payload("");
  check(empty_payload.size() == grc::rs::shader_payload_size(grc::rs::payload_meta(0), 0),
       "an empty code encodes to just the header");
}

void test_scan_plain() {
  const grc::rs::ShaderScan scan =
      grc::rs::scan_shader_code("shader_type canvas_item;\nuniform vec4 tint;\n"
                               "void fragment() { COLOR = tint; }\n");
  check(scan.mode == "canvas_item", "mode is the first shader_type's id");
  check(scan.uses.empty(), "a plain shader uses nothing D11 tracks");
  check(scan.reason.empty(), "a plain canvas_item shader is never refused");
}

void test_scan_time() {
  // The G55a check: "a TIME test string scans as shader-time".
  const grc::rs::ShaderScan scan = grc::rs::scan_shader_code(
      "shader_type canvas_item;\nvoid fragment() { COLOR = vec4(vec3(TIME), 1.0); }\n");
  check(scan.reason == "shader-time", "TIME scans as shader-time");
  bool has_time = false;
  for (const std::string &u : scan.uses) {
    has_time = has_time || u == "time";
  }
  check(has_time, "uses lists time");
}

void test_scan_screen_texture() {
  const grc::rs::ShaderScan scan = grc::rs::scan_shader_code(
      "shader_type canvas_item;\nuniform sampler2D screen : hint_screen_texture;\n"
      "void fragment() { COLOR = texture(screen, UV); }\n");
  // P3-ST (gate5_5-design.md D11 as amended): supported, listed in uses only.
  check(scan.reason.empty(), "hint_screen_texture alone is not a reason");
  check(scan.uses.size() == 1 && scan.uses[0] == "screen_texture", "uses lists screen_texture");
  const grc::rs::ShaderScan both = grc::rs::scan_shader_code(
      "shader_type canvas_item;\nuniform sampler2D screen : hint_screen_texture;\n"
      "void fragment() { COLOR = texture(screen, UV) * sin(TIME); }\n");
  check(both.reason == "shader-time", "TIME still refuses a screen-texture shader");
}

void test_scan_sdf() {
  const char *kSdfIdentifiers[] = {"texture_sdf", "texture_sdf_normal", "sdf_to_screen_uv",
                                   "screen_uv_to_sdf"};
  for (const char *ident : kSdfIdentifiers) {
    const std::string code = std::string("shader_type canvas_item;\nvoid fragment() { ") + ident +
                             "(vec2(0.0)); }\n";
    const grc::rs::ShaderScan scan = grc::rs::scan_shader_code(code);
    check(scan.reason == "shader-sdf", (std::string(ident) + " scans as shader-sdf").c_str());
  }
}

void test_scan_global_and_instance_uniform() {
  const grc::rs::ShaderScan global_scan = grc::rs::scan_shader_code(
      "shader_type canvas_item;\nglobal uniform vec4 g_tint;\nvoid fragment() {}\n");
  check(global_scan.reason == "shader-global-uniform", "global uniform scans as shader-global-uniform");
  bool has_global = false;
  for (const std::string &u : global_scan.uses) {
    has_global = has_global || u == "global_uniform";
  }
  check(has_global, "uses lists global_uniform");

  const grc::rs::ShaderScan instance_scan = grc::rs::scan_shader_code(
      "shader_type canvas_item;\ninstance uniform vec4 inst_color = vec4(1.0);\n"
      "void fragment() { COLOR = inst_color; }\n");
  check(instance_scan.reason.empty(), "instance uniform is informational only, never a refusal");
  bool has_instance = false;
  for (const std::string &u : instance_scan.uses) {
    has_instance = has_instance || u == "instance_uniform";
  }
  check(has_instance, "uses lists instance_uniform");
}

void test_scan_light_function() {
  const grc::rs::ShaderScan scan = grc::rs::scan_shader_code(
      "shader_type canvas_item;\nvoid light() { LIGHT = vec4(0.0); }\n");
  bool has_light = false;
  for (const std::string &u : scan.uses) {
    has_light = has_light || u == "light";
  }
  check(has_light, "uses lists light");
  check(scan.reason.empty(), "a light() function is never a refusal");
}

void test_scan_mode_other_than_canvas_item() {
  const grc::rs::ShaderScan scan =
      grc::rs::scan_shader_code("shader_type spatial;\nvoid fragment() {}\n");
  check(scan.mode == "spatial", "mode is read regardless of value");
  check(scan.reason == "shader-mode", "a non-canvas_item shader_type is shader-mode");
}

void test_scan_ignores_comments_and_dotted_access() {
  const grc::rs::ShaderScan commented = grc::rs::scan_shader_code(
      "// TIME hint_screen_texture\n/* global uniform */\nshader_type canvas_item;\n"
      "void fragment() {}\n");
  check(commented.uses.empty() && commented.reason.empty(),
       "identifiers inside // and /* */ comments are not scanned");

  // A dotted access ("foo.light") is a member/swizzle reference, not the light() function.
  const grc::rs::ShaderScan dotted = grc::rs::scan_shader_code(
      "shader_type canvas_item;\nvoid fragment() { COLOR = foo.light; }\n");
  check(dotted.uses.empty(), "an identifier right after '.' is ignored");
}

void test_scan_precedence() {
  // TIME and a screen-texture hint both present: TIME wins (D11's order).
  const grc::rs::ShaderScan scan = grc::rs::scan_shader_code(
      "shader_type canvas_item;\nuniform sampler2D screen : hint_screen_texture;\n"
      "void fragment() { COLOR = vec4(TIME); }\n");
  check(scan.reason == "shader-time", "TIME takes precedence over hint_screen_texture");
}

// Independently retypes `CanvasItemMaterial::_update_shader`'s generated code
// (canvas_item_material.cpp:80-137) for cross-checking recognize_canvas_item_material: a
// transcription error here is as likely to be caught as one in the implementation.
std::string expected_cim_code(const char *version_comment, const char *blend_token,
                              const char *light_suffix, bool particles) {
  std::string code = "// NOTE: Shader automatically converted from ";
  code += version_comment;
  code += "'s CanvasItemMaterial.\n\n";
  code += "shader_type canvas_item;\nrender_mode ";
  code += blend_token;
  code += light_suffix;
  code += ";\n";
  if (particles) {
    code += "uniform int particles_anim_h_frames;\n";
    code += "uniform int particles_anim_v_frames;\n";
    code += "uniform bool particles_anim_loop;\n\n";
    code += "void vertex() {\n";
    code += "\tfloat h_frames = float(particles_anim_h_frames);\n";
    code += "\tfloat v_frames = float(particles_anim_v_frames);\n";
    code += "\tVERTEX.xy /= vec2(h_frames, v_frames);\n";
    code += "\tfloat particle_total_frames = float(particles_anim_h_frames * particles_anim_v_frames);\n";
    code += "\tfloat particle_frame = floor(INSTANCE_CUSTOM.z * float(particle_total_frames));\n";
    code += "\tif (!particles_anim_loop) {\n";
    code += "\t\tparticle_frame = clamp(particle_frame, 0.0, particle_total_frames - 1.0);\n";
    code += "\t} else {\n";
    code += "\t\tparticle_frame = mod(particle_frame, particle_total_frames);\n";
    code += "\t}";
    code += "\tUV /= vec2(h_frames, v_frames);\n";
    code += "\tUV += vec2(mod(particle_frame, h_frames) / h_frames, "
            "floor((particle_frame + 0.5) / h_frames) / v_frames);\n";
    code += "}\n";
  }
  return code;
}

void check_cim_case(const char *blend_token, const char *blend_name, const char *light_suffix,
                    const char *light_name, bool particles) {
  const std::string code =
      expected_cim_code("Godot Engine v4.5.1.stable.official", blend_token, light_suffix, particles);
  const grc::rs::CanvasItemMaterialBuiltin builtin = grc::rs::recognize_canvas_item_material(code);
  const std::string label = std::string(blend_name) + "/" + light_name +
                            (particles ? "/particles" : "/no-particles");
  check(builtin.recognized, (label + ": recognized").c_str());
  check(builtin.blend_mode == blend_name, (label + ": blend_mode").c_str());
  check(builtin.light_mode == light_name, (label + ": light_mode").c_str());
  check(builtin.particles_animation == particles, (label + ": particles_animation").c_str());
}

void test_canvas_item_material_recognition() {
  check_cim_case("blend_mix", "mix", "", "normal", false);
  check_cim_case("blend_add", "add", ",unshaded", "unshaded", false);
  check_cim_case("blend_sub", "sub", ",light_only", "light_only", false);
  check_cim_case("blend_mul", "mul", "", "normal", true);
  check_cim_case("blend_premul_alpha", "premul_alpha", ",unshaded", "unshaded", true);
  check_cim_case("blend_disabled", "disabled", ",light_only", "light_only", true);

  // A different build string in the comment line still recognizes (Q1e: pattern match on the
  // comment, exact match on the rest).
  const std::string different_build =
      expected_cim_code("MegaDot v4.5.1.m.14.mono.custom_build", "blend_mix", "", false);
  check(grc::rs::recognize_canvas_item_material(different_build).recognized,
       "the version text itself is not part of the exact match");

  // A hand-written shader, even one that happens to declare canvas_item and a render_mode, is
  // not recognized (the comment line pattern must match first).
  const grc::rs::CanvasItemMaterialBuiltin not_cim = grc::rs::recognize_canvas_item_material(
      "shader_type canvas_item;\nrender_mode blend_mix;\nvoid fragment() {}\n");
  check(!not_cim.recognized, "a hand-written shader is never mistaken for a CanvasItemMaterial");

  // The template's body differing by even one byte (here, blend_add instead of blend_mix) is
  // unrecognized -- a modified engine's differing template must not false-positive (Q1e).
  std::string mismatched =
      expected_cim_code("Godot Engine v4.5.1.stable.official", "blend_mix", "", false);
  mismatched.back() = 'X';  // corrupt the trailing newline/semicolon region
  check(!grc::rs::recognize_canvas_item_material(mismatched).recognized,
       "a body that does not match any of the 36 templates exactly is unrecognized");
}

}  // namespace

int main() {
  test_payload_shape();
  test_scan_plain();
  test_scan_time();
  test_scan_screen_texture();
  test_scan_sdf();
  test_scan_global_and_instance_uniform();
  test_scan_light_function();
  test_scan_mode_other_than_canvas_item();
  test_scan_ignores_comments_and_dotted_access();
  test_scan_precedence();
  test_canvas_item_material_recognition();
  if (g_failures != 0) {
    std::fprintf(stderr, "%d check(s) failed\n", g_failures);
    return 1;
  }
  std::fprintf(stdout, "rs_shader_payload: all checks passed\n");
  return 0;
}
