#include "rs_shader_payload.h"

#include <cctype>

namespace grc {
namespace rs {

namespace {

void put_u32le(std::vector<std::uint8_t> *out, std::uint32_t value) {
  for (int i = 0; i < 4; ++i) {
    out->push_back(static_cast<std::uint8_t>(value >> (8 * i)));
  }
}

bool is_ident_start(char c) { return std::isalpha(static_cast<unsigned char>(c)) || c == '_'; }
bool is_ident_char(char c) { return std::isalnum(static_cast<unsigned char>(c)) || c == '_'; }

}  // namespace

ShaderScan scan_shader_code(const std::string &code) {
  bool time_used = false;
  bool screen_texture_used = false;
  bool sdf_used = false;
  bool global_uniform_used = false;
  bool instance_uniform_used = false;
  bool light_used = false;
  std::string mode;
  bool have_mode = false;

  // The previous identifier token, kept across whitespace only: it feeds the two-token
  // "global uniform" / "instance uniform" match and the "shader_type <id>" mode capture. Any
  // other character (not an identifier, not whitespace, not the start of a comment) breaks it.
  std::string pending;
  bool after_dot = false;

  const std::size_t n = code.size();
  std::size_t i = 0;
  while (i < n) {
    const char c = code[i];
    if (c == '/' && i + 1 < n && code[i + 1] == '/') {
      i += 2;
      while (i < n && code[i] != '\n') {
        ++i;
      }
      continue;
    }
    if (c == '/' && i + 1 < n && code[i + 1] == '*') {
      i += 2;
      while (i + 1 < n && !(code[i] == '*' && code[i + 1] == '/')) {
        ++i;
      }
      i = (i + 1 < n) ? i + 2 : n;
      continue;
    }
    if (is_ident_start(c)) {
      const std::size_t start = i;
      ++i;
      while (i < n && is_ident_char(code[i])) {
        ++i;
      }
      const std::string ident = code.substr(start, i - start);
      const bool ignored = after_dot;
      after_dot = false;
      if (!ignored) {
        if (ident == "TIME") {
          time_used = true;
        } else if (ident == "hint_screen_texture") {
          screen_texture_used = true;
        } else if (ident == "texture_sdf" || ident == "texture_sdf_normal" ||
                  ident == "sdf_to_screen_uv" || ident == "screen_uv_to_sdf") {
          sdf_used = true;
        } else if (ident == "light") {
          light_used = true;
        } else if (ident == "uniform" && pending == "global") {
          global_uniform_used = true;
        } else if (ident == "uniform" && pending == "instance") {
          instance_uniform_used = true;
        } else if (!have_mode && pending == "shader_type") {
          mode = ident;
          have_mode = true;
        }
        pending = ident;
      } else {
        pending.clear();
      }
      continue;
    }
    if (c == '.') {
      after_dot = true;
      pending.clear();
      ++i;
      continue;
    }
    if (!std::isspace(static_cast<unsigned char>(c))) {
      // Punctuation, operators, digits starting a number: breaks a pending two-token match, and
      // is never itself a dotted member access.
      after_dot = false;
      pending.clear();
    }
    ++i;
  }

  ShaderScan scan;
  if (global_uniform_used) {
    scan.uses.push_back("global_uniform");
  }
  if (instance_uniform_used) {
    scan.uses.push_back("instance_uniform");
  }
  if (light_used) {
    scan.uses.push_back("light");
  }
  if (screen_texture_used) {
    scan.uses.push_back("screen_texture");
  }
  if (sdf_used) {
    scan.uses.push_back("sdf");
  }
  if (time_used) {
    scan.uses.push_back("time");
  }
  scan.mode = mode;
  // D11's precedence order.
  if (time_used) {
    scan.reason = "shader-time";
  } else if (screen_texture_used) {
    scan.reason = "shader-screen-texture";
  } else if (sdf_used) {
    scan.reason = "shader-sdf";
  } else if (global_uniform_used) {
    scan.reason = "shader-global-uniform";
  } else if (have_mode && mode != "canvas_item") {
    scan.reason = "shader-mode";
  }
  return scan;
}

namespace {

// The particles block `CanvasItemMaterial::_update_shader` appends verbatim
// (canvas_item_material.cpp:118-137), tabs and the missing newline before "UV /=" included
// exactly as generated.
const char *const kParticlesBlock =
    "uniform int particles_anim_h_frames;\n"
    "uniform int particles_anim_v_frames;\n"
    "uniform bool particles_anim_loop;\n\n"
    "void vertex() {\n"
    "\tfloat h_frames = float(particles_anim_h_frames);\n"
    "\tfloat v_frames = float(particles_anim_v_frames);\n"
    "\tVERTEX.xy /= vec2(h_frames, v_frames);\n"
    "\tfloat particle_total_frames = float(particles_anim_h_frames * particles_anim_v_frames);\n"
    "\tfloat particle_frame = floor(INSTANCE_CUSTOM.z * float(particle_total_frames));\n"
    "\tif (!particles_anim_loop) {\n"
    "\t\tparticle_frame = clamp(particle_frame, 0.0, particle_total_frames - 1.0);\n"
    "\t} else {\n"
    "\t\tparticle_frame = mod(particle_frame, particle_total_frames);\n"
    "\t}"
    "\tUV /= vec2(h_frames, v_frames);\n"
    "\tUV += vec2(mod(particle_frame, h_frames) / h_frames, "
    "floor((particle_frame + 0.5) / h_frames) / v_frames);\n"
    "}\n";

struct BlendEntry {
  const char *token;  // the `render_mode` token
  const char *name;    // D7's wire name
};
constexpr BlendEntry kBlends[] = {
    {"blend_mix", "mix"},     {"blend_add", "add"},
    {"blend_sub", "sub"},     {"blend_mul", "mul"},
    {"blend_premul_alpha", "premul_alpha"}, {"blend_disabled", "disabled"},
};

struct LightEntry {
  const char *suffix;  // appended after the blend token, "" for normal
  const char *name;
};
constexpr LightEntry kLights[] = {
    {"", "normal"},
    {",unshaded", "unshaded"},
    {",light_only", "light_only"},
};

// `CanvasItemMaterial::_update_shader`'s body, everything after the version comment line
// (canvas_item_material.cpp:83-137).
std::string canvas_item_material_body(const char *blend_token, const char *light_suffix,
                                      bool particles) {
  std::string body = "shader_type canvas_item;\nrender_mode ";
  body += blend_token;
  body += light_suffix;
  body += ";\n";
  if (particles) {
    body += kParticlesBlock;
  }
  return body;
}

}  // namespace

CanvasItemMaterialBuiltin recognize_canvas_item_material(const std::string &code) {
  CanvasItemMaterialBuiltin out;
  static const std::string kPrefix = "// NOTE: Shader automatically converted from ";
  static const std::string kSuffix = "'s CanvasItemMaterial.\n\n";
  if (code.compare(0, kPrefix.size(), kPrefix) != 0) {
    return out;
  }
  const std::size_t suffix_pos = code.find(kSuffix, kPrefix.size());
  if (suffix_pos == std::string::npos) {
    return out;
  }
  // The version text between the two patterns (GODOT_VERSION_NAME " " GODOT_VERSION_FULL_CONFIG,
  // Q1e) must be one line: a build string containing the suffix text itself is not this comment.
  const std::string version_text = code.substr(kPrefix.size(), suffix_pos - kPrefix.size());
  if (version_text.find('\n') != std::string::npos) {
    return out;
  }
  const std::string body = code.substr(suffix_pos + kSuffix.size());
  for (const BlendEntry &blend : kBlends) {
    for (const LightEntry &light : kLights) {
      for (const bool particles : {false, true}) {
        if (body == canvas_item_material_body(blend.token, light.suffix, particles)) {
          out.recognized = true;
          out.blend_mode = blend.name;
          out.light_mode = light.name;
          out.particles_animation = particles;
          return out;
        }
      }
    }
  }
  return out;
}

std::string payload_meta(std::uint64_t code_bytes) {
  return "{\"type\":\"shader-code\",\"code_bytes\":" + std::to_string(code_bytes) + "}";
}

std::uint64_t shader_payload_size(const std::string &meta, std::uint64_t code_bytes) {
  return sizeof(kShaderPayloadMagic) + 4 + meta.size() + code_bytes;
}

void payload_header(const std::string &meta, std::vector<std::uint8_t> *out) {
  out->clear();
  out->reserve(static_cast<std::size_t>(shader_payload_size(meta, 0)));
  out->insert(out->end(), kShaderPayloadMagic, kShaderPayloadMagic + sizeof(kShaderPayloadMagic));
  put_u32le(out, static_cast<std::uint32_t>(meta.size()));
  out->insert(out->end(), meta.begin(), meta.end());
}

std::vector<std::uint8_t> encode_payload(const std::string &code) {
  const std::string meta = payload_meta(static_cast<std::uint64_t>(code.size()));
  std::vector<std::uint8_t> out;
  payload_header(meta, &out);
  out.insert(out.end(), code.begin(), code.end());
  return out;
}

}  // namespace rs
}  // namespace grc
