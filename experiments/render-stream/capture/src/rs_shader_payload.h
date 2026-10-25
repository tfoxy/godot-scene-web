// The canonical shader source payload, `render-stream-shader/1` (GRP1; gate5_5-design.md Q4
// "Shader payload render-stream-shader/1"), the D11 token scan that types a shader's refused
// dependencies, and the D7 `CanvasItemMaterial` template recognizer.
//
//   magic   8 bytes   47 52 50 31 0D 0A 1A 0A   ("GRP1\r\n\x1a\n")
//   u32le   meta_len
//   meta    canonical JSON: {"type":"shader-code","code_bytes":<int>}
//   data    the code, UTF-8, exactly the String the RenderingServer received
//
// The content address is the lowercase hex SHA-256 of the whole payload (computed by the caller,
// as for GRT1 and GRM1: rs_sha256.h). Engine-free: the token scan and the template comparison
// work over the already-decoded `std::string` (rs_variant.h's `decode_string`), never a live
// shader compiler and never engine memory.
#ifndef GRC_RS_SHADER_PAYLOAD_H
#define GRC_RS_SHADER_PAYLOAD_H

#include <cstdint>
#include <string>
#include <vector>

namespace grc {
namespace rs {

constexpr std::uint8_t kShaderPayloadMagic[8] = {0x47, 0x52, 0x50, 0x31, 0x0D, 0x0A, 0x1A, 0x0A};

// D11: the typed shader dependencies a token scan found, and the first reason in precedence
// order (TIME, SDF, global uniform, mode), if any.
struct ShaderScan {
  // A fixed subset of {"global_uniform","instance_uniform","light","screen_texture","sdf","time"},
  // in that order -- every category the scan matched, for information (Q3a); never a reason by
  // itself.
  std::vector<std::string> uses;
  // The first `shader_type <id>;`'s id, or "" when the scan found none.
  std::string mode;
  // "" (supported) | "shader-time" | "shader-sdf" | "shader-global-uniform" | "shader-mode"
  // (D11; P3-ST: screen texture is supported and appears in `uses` only).
  std::string reason;
};

// D11's token scan: skips `//` and `/* */` comments, reads identifiers `[A-Za-z_][A-Za-z0-9_]*`,
// ignores an identifier right after `.`. Never calls a shader compiler and never engine memory;
// a difference against the reference oracle's actual behaviour (G55c) is a finding, not a bug
// here. P3-TM: `time_carried` (a render-stream/10 session, which carries the host's shader time)
// keeps `TIME` out of the reasons; it stays in `uses`.
ShaderScan scan_shader_code(const std::string &code, bool time_carried = false);

// D7: `CanvasItemMaterial`'s generated code, recognized by exact text comparison against the 36
// templates (6 blend modes x 3 light modes x particles on/off, Q1e) once the version comment
// line is matched by pattern. A modified engine whose template differs simply yields an
// unrecognized `source` shader (`recognized` false).
struct CanvasItemMaterialBuiltin {
  bool recognized = false;
  std::string blend_mode;  // "mix" | "add" | "sub" | "mul" | "premul_alpha" | "disabled"
  std::string light_mode;  // "normal" | "unshaded" | "light_only"
  bool particles_animation = false;
};
CanvasItemMaterialBuiltin recognize_canvas_item_material(const std::string &code);

// G8m (gate8-design.md D12): the code `CanvasItemMaterial::_update_shader` generates for a mode,
// rebuilt from the mode (never from the engine's process-wide cache). `version_text` is the
// comment's GODOT_VERSION_NAME " " GODOT_VERSION_FULL_CONFIG (e.g. "Godot Engine 4.5.1.stable");
// `blend_mode` and `light_mode` are the engine's enum values (BlendMode 0..5: mix, add, sub, mul,
// premul_alpha, disabled; LightMode 0..2: normal, unshaded, light_only). Empty for a value out of
// range.
std::string canvas_item_material_code(const std::string &version_text, int blend_mode,
                                      int light_mode, bool particles_animation);

// G8m: that comment's version text from the engine's GDExtension version (`full_name` is
// GODOT_VERSION_FULL_NAME, "<name> v<full config>.<build>"; `build` GODOT_VERSION_BUILD). Empty
// when `full_name` does not have that shape.
std::string canvas_item_material_version_text(const std::string &full_name,
                                              const std::string &build);

// The canonical meta JSON for a code of `code_bytes` length.
std::string payload_meta(std::uint64_t code_bytes);

// The full payload length for that meta and the code's byte length.
std::uint64_t shader_payload_size(const std::string &meta, std::uint64_t code_bytes);

// Writes magic, meta length and meta into `out` (cleared first); the caller appends the code
// bytes.
void payload_header(const std::string &meta, std::vector<std::uint8_t> *out);

// The whole payload in one call (tests, and any caller that already has the code as one string).
std::vector<std::uint8_t> encode_payload(const std::string &code);

}  // namespace rs
}  // namespace grc

#endif  // GRC_RS_SHADER_PAYLOAD_H
