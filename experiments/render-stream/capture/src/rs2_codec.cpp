#include "rs2_codec.h"

#include <algorithm>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <tuple>
#include <utility>

namespace grc {
namespace rs2 {

namespace {

// ----------------------------------------------------------------- bytes
//
// Record framing is unchanged from render-stream-0.md ("Record framing") except for the new u8
// block type (render-stream-2.md "Record framing: the u8 block type"); these helpers extend
// rs1_codec.cpp's.

void append_u32le(std::string &out, std::uint32_t value) {
  out.push_back(static_cast<char>(value & 0xFF));
  out.push_back(static_cast<char>((value >> 8) & 0xFF));
  out.push_back(static_cast<char>((value >> 16) & 0xFF));
  out.push_back(static_cast<char>((value >> 24) & 0xFF));
}

void append_f32le(std::string &out, float value) {
  std::uint32_t bits = 0;
  std::memcpy(&bits, &value, sizeof(bits));
  append_u32le(out, bits);
}

// render-stream-4.md "Block type i32": little-endian two's-complement, same four-byte width as
// f32/u32; the sign is just how the bytes are later interpreted.
void append_i32le(std::string &out, std::int32_t value) {
  append_u32le(out, static_cast<std::uint32_t>(value));
}

void append_u64le(std::string &out, std::uint64_t value) {
  for (int i = 0; i < 8; ++i) {
    out.push_back(static_cast<char>((value >> (8 * i)) & 0xFF));
  }
}

// render-stream-5.md "Block type f64": little-endian IEEE 754 binary64, 8 bytes per value.
void append_f64le(std::string &out, double value) {
  std::uint64_t bits = 0;
  std::memcpy(&bits, &value, sizeof(bits));
  append_u64le(out, bits);
}

std::vector<std::uint8_t> to_bytes(const std::string &s) {
  return std::vector<std::uint8_t>(s.begin(), s.end());
}

// One block's payload, tagged by type (render-stream-2.md "Record framing: the u8 block type";
// render-stream-4.md "Block type i32"; render-stream-5.md "Block type f64").
enum class BlockKind { F32, U8, I32, F64 };

struct BlockPayload {
  BlockKind kind = BlockKind::F32;
  std::vector<float> floats;          // F32
  std::vector<std::uint8_t> bytes;    // U8
  std::vector<std::int32_t> ints;     // I32
  std::vector<double> doubles;        // F64
};

BlockPayload f32_payload(std::vector<float> values) {
  BlockPayload p;
  p.kind = BlockKind::F32;
  p.floats = std::move(values);
  return p;
}

BlockPayload u8_payload(std::vector<std::uint8_t> values) {
  BlockPayload p;
  p.kind = BlockKind::U8;
  p.bytes = std::move(values);
  return p;
}

BlockPayload i32_payload(std::vector<std::int32_t> values) {
  BlockPayload p;
  p.kind = BlockKind::I32;
  p.ints = std::move(values);
  return p;
}

BlockPayload f64_payload(std::vector<double> values) {
  BlockPayload p;
  p.kind = BlockKind::F64;
  p.doubles = std::move(values);
  return p;
}

std::vector<std::uint8_t> assemble_record(const std::string &meta,
                                           const std::vector<BlockPayload> &blocks) {
  std::string body;
  append_u32le(body, static_cast<std::uint32_t>(meta.size()));
  body += meta;
  append_u32le(body, static_cast<std::uint32_t>(blocks.size()));
  for (const BlockPayload &block : blocks) {
    if (block.kind == BlockKind::U8) {
      append_u32le(body, static_cast<std::uint32_t>(block.bytes.size()));
      body.append(reinterpret_cast<const char *>(block.bytes.data()), block.bytes.size());
    } else if (block.kind == BlockKind::I32) {
      std::string payload;
      payload.reserve(block.ints.size() * 4);
      for (std::int32_t value : block.ints) {
        append_i32le(payload, value);
      }
      append_u32le(body, static_cast<std::uint32_t>(payload.size()));
      body += payload;
    } else if (block.kind == BlockKind::F64) {
      std::string payload;
      payload.reserve(block.doubles.size() * 8);
      for (double value : block.doubles) {
        append_f64le(payload, value);
      }
      append_u32le(body, static_cast<std::uint32_t>(payload.size()));
      body += payload;
    } else {
      std::string payload;
      payload.reserve(block.floats.size() * 4);
      for (float value : block.floats) {
        append_f32le(payload, value);
      }
      append_u32le(body, static_cast<std::uint32_t>(payload.size()));
      body += payload;
    }
  }
  std::string record;
  record.reserve(4 + body.size());
  append_u32le(record, static_cast<std::uint32_t>(body.size()));
  record += body;
  return to_bytes(record);
}

// ------------------------------------------------------------- canonical JSON

void append_json_string(std::string &out, const std::string &value) {
  out.push_back('"');
  for (unsigned char c : value) {
    if (c == '"') {
      out += "\\\"";
    } else if (c == '\\') {
      out += "\\\\";
    } else if (c >= 0x20 && c <= 0x7E) {
      out.push_back(static_cast<char>(c));
    } else {
      out.push_back('?');
    }
  }
  out.push_back('"');
}

void append_json_optional_string(std::string &out, bool present, const std::string &value) {
  if (present) {
    append_json_string(out, value);
  } else {
    out += "null";
  }
}

template <typename T>
void append_json_int(std::string &out, T value) {
  out += std::to_string(value);
}

void append_json_bool(std::string &out, bool value) { out += value ? "true" : "false"; }

// render-stream-6.md "As built": the ONLY JSON-embedded float this wire carries
// (`viewport.font_oversampling`) -- every other float lives in a block (render-stream-0.md
// "Floats never appear in JSON"). Canonical form is the shortest fixed-point decimal (never
// scientific notation) that round-trips to the exact float64 widening of `value`, matching
// JavaScript's own `Number::toString` for this magnitude range (no trailing ".0" on a whole
// number) -- the TypeScript decoder's generic meta-noncanonical check re-serialises with
// `JSON.stringify`, so this encoder must already produce what that would. Python's
// `make_golden.py` implements the identical search (`_json_float()`).
void append_json_float(std::string &out, float value) {
  const double widened = static_cast<double>(value);
  char buf[64];
  for (int precision = 0; precision <= 17; ++precision) {
    std::snprintf(buf, sizeof(buf), "%.*f", precision, widened);
    if (std::strtod(buf, nullptr) == widened) {
      break;
    }
  }
  std::string s(buf);
  if (s.find('.') != std::string::npos) {
    std::size_t last_nonzero = s.find_last_not_of('0');
    if (s[last_nonzero] == '.') {
      --last_nonzero;
    }
    s.erase(last_nonzero + 1);
  }
  out += s;
}

void append_json_string_array(std::string &out, const std::vector<std::string> &values) {
  out.push_back('[');
  for (std::size_t i = 0; i < values.size(); ++i) {
    if (i != 0) {
      out.push_back(',');
    }
    append_json_string(out, values[i]);
  }
  out.push_back(']');
}

void append_json_id_array(std::string &out, const std::vector<std::uint32_t> &values) {
  out.push_back('[');
  for (std::size_t i = 0; i < values.size(); ++i) {
    if (i != 0) {
      out.push_back(',');
    }
    append_json_int(out, values[i]);
  }
  out.push_back(']');
}

std::vector<std::string> sorted_copy(const std::vector<std::string> &values) {
  std::vector<std::string> copy = values;
  std::sort(copy.begin(), copy.end());
  return copy;
}

void append_blocks_descriptor(
    std::string &out, const std::vector<std::tuple<const char *, const char *, std::size_t>> &blocks) {
  out += "\"blocks\":[";
  for (std::size_t i = 0; i < blocks.size(); ++i) {
    if (i != 0) {
      out.push_back(',');
    }
    out += "{\"name\":";
    append_json_string(out, std::get<0>(blocks[i]));
    out += ",\"type\":\"";
    out += std::get<1>(blocks[i]);
    out += "\",\"count\":";
    append_json_int(out, std::get<2>(blocks[i]));
    out += "}";
  }
  out += "]";
}

// render-stream-8.md "Resource tables": adopted_content is null for a created entry.
void append_json_adopted_content(std::string &out, AdoptedContent v) {
  switch (v) {
  case AdoptedContent::None: out += "null"; return;
  case AdoptedContent::Current: out += "\"current\""; return;
  case AdoptedContent::Creation: out += "\"creation\""; return;
  }
  out += "null";
}

void append_canvas_texture(std::string &out, const TextureEntry &t) {
  out += ",\"canvas\":";
  if (!t.has_canvas) {
    out += "null";
    return;
  }
  out += "{\"diffuse\":";
  if (t.canvas.has_diffuse) {
    append_json_int(out, t.canvas.diffuse);
  } else {
    out += "null";
  }
  out += ",\"filter\":";
  append_json_string(out, to_wire(t.canvas.filter));
  out += ",\"repeat\":";
  append_json_string(out, to_wire(t.canvas.repeat));
  out += "}";
}

// render-stream-4.md "Mesh table": appends one mesh entry's JSON, pushing its custom AABB (when
// present) onto `mesh_f32` and recording the resulting offset as "f" -- the same running-offset
// pattern cmd_f32/"f" uses for commands, except here the stride is fixed (0 or 6 floats) rather
// than kind-dependent.
void append_mesh_entry(std::string &out, const MeshEntry &mesh, std::vector<float> &mesh_f32,
                       bool v8) {
  out += "{\"id\":";
  append_json_int(out, mesh.id);
  if (v8) {
    // render-stream-8.md "Resource tables": origin may be "adopted"; adopted_content follows it.
    out += ",\"origin\":";
    append_json_string(out, to_wire(mesh.origin));
    out += ",\"adopted_content\":";
    append_json_adopted_content(out, mesh.adopted_content);
  } else {
    out += ",\"origin\":\"created\"";
  }
  out += ",\"status\":";
  append_json_string(out, to_wire(mesh.status));
  out += ",\"reason\":";
  if (mesh.has_reason) {
    append_json_string(out, to_wire(mesh.reason));
  } else {
    out += "null";
  }
  out += ",\"version\":";
  append_json_int(out, mesh.version);
  out += ",\"f\":";
  if (mesh.has_aabb) {
    append_json_int(out, mesh_f32.size());
    mesh_f32.insert(mesh_f32.end(), mesh.custom_aabb.begin(), mesh.custom_aabb.end());
  } else {
    out += "null";
  }
  out += ",\"surfaces\":[";
  for (std::size_t i = 0; i < mesh.surfaces.size(); ++i) {
    if (i != 0) {
      out += ",";
    }
    const MeshSurface &s = mesh.surfaces[i];
    out += "{\"hash\":";
    append_json_string(out, s.hash);
    out += ",\"payload_bytes\":";
    append_json_int(out, s.payload_bytes);
    out += ",\"primitive\":";
    append_json_string(out, to_wire(s.primitive));
    out += ",\"format\":";
    append_json_int(out, s.format);
    out += ",\"vertex_count\":";
    append_json_int(out, s.vertex_count);
    out += ",\"index_count\":";
    append_json_int(out, s.index_count);
    out += "}";
  }
  out += "]}";
}

void append_texture_entry(std::string &out, const TextureEntry &t, bool v8) {
  out += "{\"id\":";
  append_json_int(out, t.id);
  if (v8) {
    out += ",\"origin\":";
    append_json_string(out, to_wire(t.origin));
    out += ",\"adopted_content\":";
    append_json_adopted_content(out, t.adopted_content);
  } else {
    out += ",\"origin\":\"created\"";
  }
  out += ",\"kind\":";
  append_json_string(out, to_wire(t.kind));
  out += ",\"status\":";
  append_json_string(out, to_wire(t.status));
  out += ",\"reason\":";
  if (t.has_reason) {
    append_json_string(out, to_wire(t.reason));
  } else {
    out += "null";
  }
  out += ",\"version\":";
  append_json_int(out, t.version);
  out += ",\"hash\":";
  append_json_optional_string(out, t.has_hash, t.hash);
  out += ",\"format\":";
  append_json_optional_string(out, t.has_format, t.format);
  if (v8) {
    // render-stream-8.md "Resource tables": source_format, right after format.
    out += ",\"source_format\":";
    append_json_optional_string(out, t.has_source_format, t.source_format);
  }
  out += ",\"width\":";
  append_json_int(out, t.width);
  out += ",\"height\":";
  append_json_int(out, t.height);
  out += ",\"mipmaps\":";
  append_json_bool(out, t.mipmaps);
  out += ",\"payload_bytes\":";
  append_json_int(out, t.payload_bytes);
  append_canvas_texture(out, t);
  out += "}";
}

// render-stream-5.md "Material table": appends one <param> object, pushing its floats onto
// `param_f64` and recording the resulting offset as "f" -- the same running-offset pattern
// cmd_f32/mesh_f32 use, but over param_f64 and across BOTH materials (table order) and items
// (item order), since "f" is one running offset shared by the whole transaction
// (gate5_5-design.md D8 "param-offset").
void append_param_entry(std::string &out, const Param &p, std::vector<double> &param_f64) {
  out += "{\"name\":";
  append_json_string(out, p.name);
  out += ",\"type\":";
  append_json_string(out, to_wire(p.type));
  out += ",\"n\":";
  append_json_int(out, p.n);
  out += ",\"tex\":";
  if (p.has_tex) {
    append_json_int(out, p.tex);
  } else {
    out += "null";
  }
  out += ",\"f\":";
  append_json_int(out, param_f64.size());
  out += "}";
  param_f64.insert(param_f64.end(), p.floats.begin(), p.floats.end());
}

// render-stream-5.md "Shader table".
void append_shader_entry(std::string &out, const ShaderEntry &s, bool v8) {
  out += "{\"id\":";
  append_json_int(out, s.id);
  if (v8) {
    out += ",\"origin\":";
    append_json_string(out, to_wire(s.origin));
  } else {
    out += ",\"origin\":\"created\"";
  }
  out += ",\"status\":";
  append_json_string(out, to_wire(s.status));
  out += ",\"reason\":";
  if (s.has_reason) {
    append_json_string(out, to_wire(s.reason));
  } else {
    out += "null";
  }
  out += ",\"version\":";
  append_json_int(out, s.version);
  out += ",\"mode\":";
  if (s.has_mode) {
    append_json_string(out, to_wire(s.mode));
  } else {
    out += "null";
  }
  out += ",\"source\":";
  if (s.has_source) {
    append_json_string(out, to_wire(s.source));
  } else {
    out += "null";
  }
  out += ",\"hash\":";
  append_json_optional_string(out, s.has_hash, s.hash);
  out += ",\"payload_bytes\":";
  append_json_int(out, s.payload_bytes);
  out += ",\"builtin\":";
  if (s.has_builtin) {
    out += "{\"kind\":\"canvas_item_material\",\"blend_mode\":";
    append_json_string(out, to_wire(s.builtin.blend_mode));
    out += ",\"light_mode\":";
    append_json_string(out, to_wire(s.builtin.light_mode));
    out += ",\"particles_animation\":";
    append_json_bool(out, s.builtin.particles_animation);
    out += "}";
  } else {
    out += "null";
  }
  out += ",\"uses\":[";
  for (std::size_t i = 0; i < s.uses.size(); ++i) {
    if (i != 0) {
      out += ",";
    }
    append_json_string(out, to_wire(s.uses[i]));
  }
  out += "]";
  out += ",\"default_textures\":[";
  for (std::size_t i = 0; i < s.default_textures.size(); ++i) {
    if (i != 0) {
      out += ",";
    }
    const DefaultTextureRef &d = s.default_textures[i];
    out += "{\"name\":";
    append_json_string(out, d.name);
    out += ",\"index\":";
    append_json_int(out, d.index);
    out += ",\"tex\":";
    append_json_int(out, d.tex);
    out += "}";
  }
  out += "]}";
}

// render-stream-5.md "Material table".
void append_material_entry(std::string &out, const MaterialEntry &m, std::vector<double> &param_f64,
                           bool v8) {
  out += "{\"id\":";
  append_json_int(out, m.id);
  if (v8) {
    out += ",\"origin\":";
    append_json_string(out, to_wire(m.origin));
  } else {
    out += ",\"origin\":\"created\"";
  }
  out += ",\"status\":";
  append_json_string(out, to_wire(m.status));
  out += ",\"reason\":";
  if (m.has_reason) {
    append_json_string(out, to_wire(m.reason));
  } else {
    out += "null";
  }
  out += ",\"version\":";
  append_json_int(out, m.version);
  out += ",\"shader\":";
  if (m.has_shader) {
    append_json_int(out, m.shader);
  } else {
    out += "null";
  }
  out += ",\"params\":[";
  for (std::size_t i = 0; i < m.params.size(); ++i) {
    if (i != 0) {
      out += ",";
    }
    append_param_entry(out, m.params[i], param_f64);
  }
  out += "]}";
}

}  // namespace

std::vector<std::uint8_t> magic() {
  return std::vector<std::uint8_t>(kMagic.begin(), kMagic.end());
}

std::vector<std::uint8_t> magic(ProtocolVersion version) {
  if (version == ProtocolVersion::V8) {
    return std::vector<std::uint8_t>(kMagicV8.begin(), kMagicV8.end());
  }
  if (version == ProtocolVersion::V7) {
    return std::vector<std::uint8_t>(kMagicV7.begin(), kMagicV7.end());
  }
  if (version == ProtocolVersion::V6) {
    return std::vector<std::uint8_t>(kMagicV6.begin(), kMagicV6.end());
  }
  if (version == ProtocolVersion::V5) {
    return std::vector<std::uint8_t>(kMagicV5.begin(), kMagicV5.end());
  }
  if (version == ProtocolVersion::V4) {
    return std::vector<std::uint8_t>(kMagicV4.begin(), kMagicV4.end());
  }
  return version == ProtocolVersion::V3
             ? std::vector<std::uint8_t>(kMagicV3.begin(), kMagicV3.end())
             : std::vector<std::uint8_t>(kMagic.begin(), kMagic.end());
}

std::vector<std::uint8_t> encode_session(const Session &session) {
  std::string m;
  m += "{\"type\":\"session\",\"protocol\":";
  const char *protocol =
      session.version == ProtocolVersion::V8
          ? kProtocolV8
          : session.version == ProtocolVersion::V7
          ? kProtocolV7
          : (session.version == ProtocolVersion::V6
                 ? kProtocolV6
                 : (session.version == ProtocolVersion::V5
                        ? kProtocolV5
                        : (session.version == ProtocolVersion::V4
                               ? kProtocolV4
                               : (session.version == ProtocolVersion::V3 ? kProtocolV3
                                                                          : kProtocol))));
  append_json_string(m, protocol);
  m += ",\"session_id\":";
  append_json_string(m, session.session_id);

  m += ",\"stream\":{\"stream_id\":";
  append_json_string(m, session.stream.stream_id);
  m += ",\"connection\":";
  if (session.stream.has_connection) {
    append_json_int(m, session.stream.connection);
  } else {
    m += "null";
  }
  m += ",\"transport\":";
  append_json_string(m, to_wire(session.stream.transport));
  m += ",\"encoding\":";
  append_json_string(m, to_wire(session.stream.encoding));
  m += "}";

  m += ",\"engine\":{\"version_string\":";
  append_json_string(m, session.engine.version_string);
  m += ",\"sha256\":";
  append_json_string(m, session.engine.sha256);
  m += ",\"display_server\":";
  append_json_string(m, session.engine.display_server);
  m += ",\"rendering_driver\":";
  append_json_string(m, session.engine.rendering_driver);
  m += ",\"rendering_method\":";
  append_json_string(m, session.engine.rendering_method);
  m += "}";

  m += ",\"capture\":{\"calibrator_version\":";
  append_json_int(m, session.capture.calibrator_version);
  m += ",\"hooks_planned\":";
  append_json_string_array(m, sorted_copy(session.capture.hooks_planned));
  m += ",\"hooks_omitted\":";
  append_json_string_array(m, sorted_copy(session.capture.hooks_omitted));
  m += "}";

  const bool is_v8 = session.version == ProtocolVersion::V8;
  // is_v7 means "V7 or later": /8 is /7 plus render-stream-8.md's list, so it keeps the
  // publication credit_window.
  const bool is_v7 = is_v8 || session.version == ProtocolVersion::V7;
  // is_v6 means "V6 or later": /7 is a delta on /6 that keeps everything /6 added (presentation
  // stretch declarations, the top-level publication key, canvas layer/sublayer) unless
  // render-stream-7.md says otherwise.
  const bool is_v6 = is_v7 || session.version == ProtocolVersion::V6;
  // is_v5 means "V5 or later": /6 is a delta on /5 that keeps everything /5 added (shader/
  // material tables, canvas modulate, item material state) unless render-stream-6.md says
  // otherwise.
  const bool is_v5 = is_v6 || session.version == ProtocolVersion::V5;
  const bool is_v4_or_later = is_v5 || session.version == ProtocolVersion::V4;

  m += ",\"viewport\":{\"canvas_cull_mask\":";
  append_json_int(m, session.viewport.canvas_cull_mask);
  m += ",\"root_canvas\":";
  append_json_int(m, session.viewport.root_canvas);
  m += ",\"logical_size\":[";
  append_json_int(m, session.viewport.logical_size[0]);
  m += ",";
  append_json_int(m, session.viewport.logical_size[1]);
  m += "],\"stretch\":{\"mode\":";
  append_json_string(m, to_wire(session.viewport.stretch.mode));
  m += ",\"aspect\":";
  append_json_string(m, to_wire(session.viewport.stretch.aspect));
  m += ",\"scale_mode\":";
  append_json_string(m, to_wire(session.viewport.stretch.scale_mode));
  m += "}";
  m += ",\"stretch_applied_by\":\"receiver\"";
  m += ",\"root_size_policy\":";
  append_json_string(m, to_wire(session.viewport.root_size_policy));
  if (is_v6) {
    // render-stream-6.md "Session": presentation_size, right after root_size_policy and before
    // host_size_status.
    m += ",\"presentation_size\":[";
    append_json_int(m, session.viewport.presentation_size[0]);
    m += ",";
    append_json_int(m, session.viewport.presentation_size[1]);
    m += "]";
  }
  m += ",\"host_size_status\":";
  append_json_string(m, to_wire(session.viewport.host_size_status));
  m += ",\"host_window_size\":[";
  append_json_int(m, session.viewport.host_window_size[0]);
  m += ",";
  append_json_int(m, session.viewport.host_window_size[1]);
  m += "]";
  if (is_v6) {
    // render-stream-6.md "Session": font_oversampling and snap_2d, after host_window_size.
    m += ",\"font_oversampling\":";
    append_json_float(m, session.viewport.font_oversampling);
    m += ",\"snap_2d\":{\"transforms\":";
    append_json_bool(m, session.viewport.snap_2d.transforms);
    m += ",\"vertices\":";
    append_json_bool(m, session.viewport.snap_2d.vertices);
    m += "}";
  }
  m += "}";

  m += ",\"resources\":{\"hash\":\"sha256\",";
  if (is_v5) {
    // render-stream-5.md "Session": "payloads" gains "render-stream-shader/1", sorted ascending:
    // render-stream-mesh/1, render-stream-shader/1, render-stream-texture/1.
    m += "\"payloads\":";
    append_json_string_array(m, {kMeshPayloadSchema, kShaderPayloadSchema, kPayloadSchema});
  } else if (is_v4_or_later) {
    // render-stream-4.md "Resources": "payload" (one schema string) becomes "payloads" (a sorted
    // array): the mesh and texture payload formats share one resource policy.
    m += "\"payloads\":";
    append_json_string_array(m, {kMeshPayloadSchema, kPayloadSchema});
  } else {
    m += "\"payload\":";
    append_json_string(m, kPayloadSchema);
  }
  m += ",\"delivery\":";
  append_json_string(m, to_wire(session.resources.delivery));
  m += ",\"inline_max_bytes\":";
  append_json_int(m, session.resources.inline_max_bytes);
  m += ",\"max_payload_bytes\":";
  append_json_int(m, session.resources.max_payload_bytes);
  m += ",\"permitted_formats\":";
  append_json_string_array(m, sorted_copy(session.resources.permitted_formats));
  m += ",\"fetch\":";
  append_json_string(m, to_wire(session.resources.fetch));
  m += ",\"http_path\":";
  append_json_optional_string(m, session.resources.has_http_path, session.resources.http_path);
  m += ",\"auth\":";
  append_json_string(m, to_wire(session.resources.auth));
  if (is_v8) {
    // render-stream-8.md "Session": decode, after auth (the end of the resources object).
    m += ",\"decode\":";
    append_json_string(m, to_wire(session.resources.decode));
  }
  m += "}";

  if (is_v5) {
    // render-stream-5.md "Session": a new "materials" key, right after "resources".
    m += ",\"materials\":{\"shader_policy\":";
    append_json_string(m, to_wire(session.materials.shader_policy));
    m += "}";
  }

  m += ",\"features\":{\"ops\":";
  append_json_string_array(m, session.features.ops);
  m += ",\"item_state\":";
  append_json_string_array(m, session.features.item_state);
  if (is_v5) {
    // render-stream-5.md "Session": a new "canvas_state" key, right after "item_state".
    m += ",\"canvas_state\":";
    append_json_string_array(m, session.features.canvas_state);
  }
  m += ",\"resources\":";
  append_json_string_array(m, session.features.resources);
  m += ",\"unsupported_resources\":[";
  for (std::size_t i = 0; i < session.features.unsupported_resources.size(); ++i) {
    const UnsupportedResource &u = session.features.unsupported_resources[i];
    m += i == 0 ? "{\"resource\":" : ",{\"resource\":";
    append_json_string(m, u.resource);
    m += ",\"reason\":";
    append_json_string(m, u.reason);
    m += "}";
  }
  m += "]";
  m += ",\"observed_unsupported_ops\":";
  append_json_string_array(m, session.features.observed_unsupported_ops);
  m += ",\"unobserved\":";
  append_json_string_array(m, session.features.unobserved);
  m += ",\"publication\":";
  append_json_string(m, session.features.publication);
  m += "}";

  if (is_v6) {
    // render-stream-6.md "Session": a new top-level "publication" key, right after "features"
    // (gate6-design.md D8) -- distinct from features.publication above.
    m += ",\"publication\":{\"mode\":";
    append_json_string(m, to_wire(session.publication.mode));
    m += ",\"target_fps\":";
    if (session.publication.has_target_fps) {
      append_json_int(m, session.publication.target_fps);
    } else {
      m += "null";
    }
    if (is_v7) {
      // render-stream-7.md "Session": publication gains credit_window, right after target_fps.
      m += ",\"credit_window\":";
      append_json_int(m, session.publication.credit_window);
    }
    m += "}";
  }

  m += ",\"sabotage\":";
  if (session.sabotage.kind == SabotageKind::None) {
    m += "null";
  } else {
    m += "{\"kind\":";
    append_json_string(m, to_wire(session.sabotage.kind));
    m += ",\"frame\":";
    append_json_int(m, session.sabotage.frame);
    m += ",\"op\":";
    if (session.sabotage.has_op) {
      append_json_string(m, session.sabotage.op);
    } else {
      m += "null";
    }
    m += "}";
  }
  // protocol/unknown-item-skip.md "Session": present only in a skip session, only at /4 and /5;
  // a strict session encodes exactly as before the policy existed.
  if (session.unknown_item_policy == UnknownItemPolicy::Skip && is_v4_or_later) {
    m += ",\"unknown_item_policy\":\"skip\"";
  }
  if (is_v8) {
    // render-stream-8.md "Session": adoption, always present at /8, right after
    // unknown_item_policy (or after sabotage when that key is absent).
    m += ",\"adoption\":";
    if (session.adoption.present) {
      m += "{\"mode\":\"arm\",\"frame\":";
      append_json_int(m, session.adoption.frame);
      m += "}";
    } else {
      m += "null";
    }
  }
  m += ",";
  append_blocks_descriptor(m, {{"clear_color", "f32", 4},
                                {"root_canvas_xform", "f32", 6},
                                {"host_visible_rect", "f32", 4},
                                {"host_final_xform", "f32", 6},
                                {"content_scale_factor", "f32", 1}});
  m += "}";

  const std::vector<BlockPayload> blocks = {
      f32_payload(std::vector<float>(session.clear_color.begin(), session.clear_color.end())),
      f32_payload(std::vector<float>(session.root_canvas_xform.begin(), session.root_canvas_xform.end())),
      f32_payload(std::vector<float>(session.host_visible_rect.begin(), session.host_visible_rect.end())),
      f32_payload(std::vector<float>(session.host_final_xform.begin(), session.host_final_xform.end())),
      f32_payload(std::vector<float>{session.content_scale_factor}),
  };
  return assemble_record(m, blocks);
}

std::vector<std::uint8_t> encode_transaction(const Transaction &transaction) {
  // render-stream-7.md: transactions are byte-identical to /6 (gate7-design.md D2), so is_v6
  // (meaning "V6 or later") is only needed for the unknown_items version gate below and the
  // canvas layer/sublayer keys /6 added.
  const bool v8 = transaction.version == ProtocolVersion::V8;
  const bool is_v6 = transaction.version == ProtocolVersion::V6 ||
                      transaction.version == ProtocolVersion::V7 || v8;
  std::string m;
  m += "{\"type\":\"transaction\",\"seq\":";
  append_json_int(m, transaction.seq);
  m += ",\"frame\":";
  append_json_int(m, transaction.frame);
  m += ",\"encoding\":";
  append_json_string(m, to_wire(transaction.encoding));
  m += ",\"base_seq\":";
  if (transaction.base_seq.has_value()) {
    append_json_int(m, *transaction.base_seq);
  } else {
    m += "null";
  }
  m += ",\"status\":";
  append_json_string(m, to_wire(transaction.status()));

  m += ",\"failures\":[";
  for (std::size_t i = 0; i < transaction.failures.size(); ++i) {
    if (i != 0) {
      m += ",";
    }
    const Failure &failure = transaction.failures[i];
    m += "{\"reason\":";
    append_json_string(m, to_wire(failure.reason));
    m += ",\"detail\":";
    append_json_string(m, failure.detail);
    m += "}";
  }
  m += "]";

  m += ",\"unsupported\":[";
  for (std::size_t i = 0; i < transaction.unsupported.size(); ++i) {
    if (i != 0) {
      m += ",";
    }
    const UnsupportedRef &unsupported = transaction.unsupported[i];
    m += "{\"op\":";
    append_json_string(m, unsupported.op);
    m += ",\"item\":";
    if (unsupported.has_item) {
      append_json_int(m, unsupported.item);
    } else {
      m += "null";
    }
    m += ",\"reason\":";
    append_json_string(m, to_wire(unsupported.reason));
    m += "}";
  }
  m += "]";

  // protocol/unknown-item-skip.md "Transaction": in a session that declares
  // `unknown_item_policy: "skip"` (and only then, at /4, /5 and /6), every transaction carries
  // what it left out, right after `unsupported`. Complete in full and patch transactions alike.
  if (transaction.unknown_items.present && (transaction.version == ProtocolVersion::V4 ||
                                            transaction.version == ProtocolVersion::V5 ||
                                            is_v6)) {
    const UnknownItems &unknown = transaction.unknown_items;
    m += ",\"unknown_items\":{\"unknown_rids\":";
    append_json_int(m, unknown.unknown_rids);
    m += ",\"withheld_items\":";
    append_json_int(m, unknown.withheld_items);
    m += ",\"withheld_commands\":";
    append_json_int(m, unknown.withheld_commands);
    m += ",\"unknown_calls\":";
    append_json_int(m, unknown.unknown_calls);
    m += "}";
  }

  m += ",\"default_texture_filter\":";
  append_json_string(m, to_wire(transaction.default_texture_filter));
  m += ",\"default_texture_repeat\":";
  append_json_string(m, to_wire(transaction.default_texture_repeat));

  // is_v5 means "V5 or later" (see rs2_diff.cpp's make_patch() comment).
  const bool is_v5 = is_v6 || transaction.version == ProtocolVersion::V5;
  const bool is_v4 = is_v5 || transaction.version == ProtocolVersion::V4;

  m += ",\"removed_canvases\":";
  append_json_id_array(m, transaction.removed_canvases);
  m += ",\"removed_items\":";
  append_json_id_array(m, transaction.removed_items);
  m += ",\"removed_textures\":";
  append_json_id_array(m, transaction.removed_textures);
  if (is_v4) {
    m += ",\"removed_meshes\":";
    append_json_id_array(m, transaction.removed_meshes);
  }
  if (is_v5) {
    // render-stream-5.md "Shader table"/"Material table": removed_shaders/removed_materials
    // follow removed_meshes, mirroring the mesh table's own position after removed_textures.
    m += ",\"removed_shaders\":";
    append_json_id_array(m, transaction.removed_shaders);
    m += ",\"removed_materials\":";
    append_json_id_array(m, transaction.removed_materials);
  }

  std::vector<float> canvas_f32;
  m += ",\"canvases\":[";
  for (std::size_t i = 0; i < transaction.canvases.size(); ++i) {
    if (i != 0) {
      m += ",";
    }
    const CanvasState &canvas = transaction.canvases[i];
    m += "{\"id\":";
    append_json_int(m, canvas.id);
    m += ",\"origin\":";
    append_json_string(m, to_wire(canvas.origin));
    m += ",\"role\":";
    if (canvas.role == CanvasRole::Root) {
      append_json_string(m, "root");
    } else {
      m += "null";
    }
    m += ",\"attached\":";
    append_json_bool(m, canvas.attached);
    if (is_v6) {
      // render-stream-6.md "Canvas": layer/sublayer, right after attached and before items.
      m += ",\"layer\":";
      append_json_int(m, canvas.layer);
      m += ",\"sublayer\":";
      append_json_int(m, canvas.sublayer);
    }
    m += ",\"items\":";
    append_json_id_array(m, canvas.items);
    m += "}";
    canvas_f32.insert(canvas_f32.end(), canvas.xform.begin(), canvas.xform.end());
    if (is_v5) {
      // render-stream-5.md "Canvas": canvas_f32 grows from 6 to 10 floats per canvas (xform 6,
      // modulate 4).
      canvas_f32.insert(canvas_f32.end(), canvas.modulate.begin(), canvas.modulate.end());
    }
  }
  m += "]";

  std::vector<float> item_f32;
  std::vector<float> cmd_f32;
  std::vector<std::int32_t> cmd_i32;  // new at /4: add_triangle_array's indices
  // render-stream-5.md "Material table" (D8 "param-offset"): "f" is a running offset into
  // param_f64 over MATERIALS IN TABLE ORDER FIRST, then items in item order -- so `materials_json`
  // is built (and claims its floats) before the items loop below, even though "materials" is the
  // LAST key in the transaction's JSON (after "shaders"). `m` only gains the pieces built so far
  // (through "canvases"); every later piece is assembled into its own buffer and spliced into `m`
  // in true JSON key order once all of them (and their floats) are known.
  std::vector<double> param_f64;
  std::string materials_json;
  if (is_v5) {
    materials_json += ",\"materials\":[";
    for (std::size_t i = 0; i < transaction.materials.size(); ++i) {
      if (i != 0) {
        materials_json += ",";
      }
      append_material_entry(materials_json, transaction.materials[i], param_f64, v8);
    }
    materials_json += "]";
  }
  std::string items_json;
  items_json += ",\"items\":[";
  for (std::size_t i = 0; i < transaction.items.size(); ++i) {
    if (i != 0) {
      items_json += ",";
    }
    const ItemEntry &entry = transaction.items[i];
    const ItemState &item = entry.state;
    items_json += "{\"id\":";
    append_json_int(items_json, item.id);
    items_json += ",\"origin\":";
    append_json_string(items_json, to_wire(item.origin));
    items_json += ",\"parent\":";
    if (item.parent.kind == ParentKind::None) {
      items_json += "null";
    } else {
      items_json += "{\"kind\":";
      append_json_string(items_json, to_wire(item.parent.kind));
      items_json += ",\"id\":";
      append_json_int(items_json, item.parent.id);
      items_json += "}";
    }
    items_json += ",\"children\":";
    append_json_id_array(items_json, item.children);
    items_json += ",\"visible\":";
    append_json_bool(items_json, item.visible);
    items_json += ",\"draw_index\":";
    append_json_int(items_json, item.draw_index);
    items_json += ",\"z_index\":";
    append_json_int(items_json, item.z_index);
    items_json += ",\"z_relative\":";
    append_json_bool(items_json, item.z_relative);
    items_json += ",\"behind\":";
    append_json_bool(items_json, item.behind);
    items_json += ",\"clip\":";
    append_json_bool(items_json, item.clip);
    items_json += ",\"custom_rect\":";
    append_json_bool(items_json, item.custom_rect);
    items_json += ",\"visibility_layer\":";
    append_json_int(items_json, item.visibility_layer);
    items_json += ",\"texture_filter\":";
    append_json_string(items_json, to_wire(item.texture_filter));
    items_json += ",\"texture_repeat\":";
    append_json_string(items_json, to_wire(item.texture_repeat));
    if (is_v5) {
      // render-stream-5.md "Item": material, use_parent_material, instance_params -- in that
      // order, before content_version. instance_params' floats continue the SAME param_f64 the
      // material table above already claimed (gate5_5-design.md D8 "param-offset": materials in
      // table order, then items in item order).
      items_json += ",\"material\":";
      if (item.has_material) {
        append_json_int(items_json, item.material);
      } else {
        items_json += "null";
      }
      items_json += ",\"use_parent_material\":";
      append_json_bool(items_json, item.use_parent_material);
      items_json += ",\"instance_params\":[";
      for (std::size_t p = 0; p < item.instance_params.size(); ++p) {
        if (p != 0) {
          items_json += ",";
        }
        append_param_entry(items_json, item.instance_params[p], param_f64);
      }
      items_json += "]";
    }
    items_json += ",\"content_version\":";
    append_json_int(items_json, item.content_version);

    items_json += ",\"commands\":";
    if (entry.commands_null) {
      items_json += "null";
    } else {
      items_json += "[";
      for (std::size_t c = 0; c < item.commands.size(); ++c) {
        if (c != 0) {
          items_json += ",";
        }
        const Command &command = item.commands[c];
        switch (command.kind) {
        case CommandKind::AddRect:
          items_json += "{\"op\":\"add_rect\",\"aa\":";
          append_json_bool(items_json, command.antialiased);
          items_json += ",\"f\":";
          append_json_int(items_json, cmd_f32.size());
          items_json += "}";
          cmd_f32.insert(cmd_f32.end(), command.rect.begin(), command.rect.end());
          cmd_f32.insert(cmd_f32.end(), command.color.begin(), command.color.end());
          break;
        case CommandKind::AddTextureRect:
          items_json += "{\"op\":\"add_texture_rect\",\"tex\":";
          if (command.has_tex) {
            append_json_int(items_json, command.tex);
          } else {
            items_json += "null";
          }
          items_json += ",\"tile\":";
          append_json_bool(items_json, command.tile);
          items_json += ",\"transpose\":";
          append_json_bool(items_json, command.transpose);
          items_json += ",\"f\":";
          append_json_int(items_json, cmd_f32.size());
          items_json += "}";
          cmd_f32.insert(cmd_f32.end(), command.rect.begin(), command.rect.end());
          cmd_f32.insert(cmd_f32.end(), command.modulate.begin(), command.modulate.end());
          break;
        case CommandKind::AddTextureRectRegion:
          items_json += "{\"op\":\"add_texture_rect_region\",\"tex\":";
          if (command.has_tex) {
            append_json_int(items_json, command.tex);
          } else {
            items_json += "null";
          }
          items_json += ",\"transpose\":";
          append_json_bool(items_json, command.transpose);
          items_json += ",\"clip_uv\":";
          append_json_bool(items_json, command.clip_uv);
          items_json += ",\"f\":";
          append_json_int(items_json, cmd_f32.size());
          items_json += "}";
          cmd_f32.insert(cmd_f32.end(), command.rect.begin(), command.rect.end());
          cmd_f32.insert(cmd_f32.end(), command.src.begin(), command.src.end());
          cmd_f32.insert(cmd_f32.end(), command.modulate.begin(), command.modulate.end());
          break;
        case CommandKind::AddMsdfTextureRectRegion:
          // render-stream-3.md "Command": 14 floats (rect 4, src 4, modulate 4, px_range, scale).
          items_json += "{\"op\":\"add_msdf_texture_rect_region\",\"tex\":";
          if (command.has_tex) {
            append_json_int(items_json, command.tex);
          } else {
            items_json += "null";
          }
          items_json += ",\"outline\":";
          append_json_int(items_json, command.msdf_outline);
          items_json += ",\"f\":";
          append_json_int(items_json, cmd_f32.size());
          items_json += "}";
          cmd_f32.insert(cmd_f32.end(), command.rect.begin(), command.rect.end());
          cmd_f32.insert(cmd_f32.end(), command.src.begin(), command.src.end());
          cmd_f32.insert(cmd_f32.end(), command.modulate.begin(), command.modulate.end());
          cmd_f32.push_back(command.msdf_px_range);
          cmd_f32.push_back(command.msdf_scale);
          break;
        case CommandKind::AddLine:
          // render-stream-4.md "Command": 9 floats (from 2, to 2, colour 4, width 1).
          items_json += "{\"op\":\"add_line\",\"aa\":";
          append_json_bool(items_json, command.antialiased);
          items_json += ",\"f\":";
          append_json_int(items_json, cmd_f32.size());
          items_json += "}";
          cmd_f32.insert(cmd_f32.end(), command.line_from.begin(), command.line_from.end());
          cmd_f32.insert(cmd_f32.end(), command.line_to.begin(), command.line_to.end());
          cmd_f32.insert(cmd_f32.end(), command.color.begin(), command.color.end());
          cmd_f32.push_back(command.width);
          break;
        case CommandKind::AddPolyline:
        case CommandKind::AddMultiline:
          // render-stream-4.md "Command": width 1, points 2n, colours 4 x colors.size().
          items_json += command.kind == CommandKind::AddPolyline ? "{\"op\":\"add_polyline\",\"aa\":"
                                                          : "{\"op\":\"add_multiline\",\"aa\":";
          append_json_bool(items_json, command.antialiased);
          items_json += ",\"n\":";
          append_json_int(items_json, command.points.size());
          items_json += ",\"colors\":";
          append_json_int(items_json, command.colors.size());
          items_json += ",\"f\":";
          append_json_int(items_json, cmd_f32.size());
          items_json += "}";
          cmd_f32.push_back(command.width);
          for (const Point2 &p : command.points) {
            cmd_f32.insert(cmd_f32.end(), p.begin(), p.end());
          }
          for (const Color4 &c : command.colors) {
            cmd_f32.insert(cmd_f32.end(), c.begin(), c.end());
          }
          break;
        case CommandKind::AddCircle:
          // render-stream-4.md "Command": 7 floats (position 2, radius 1, colour 4).
          items_json += "{\"op\":\"add_circle\",\"aa\":";
          append_json_bool(items_json, command.antialiased);
          items_json += ",\"f\":";
          append_json_int(items_json, cmd_f32.size());
          items_json += "}";
          cmd_f32.insert(cmd_f32.end(), command.circle_position.begin(), command.circle_position.end());
          cmd_f32.push_back(command.circle_radius);
          cmd_f32.insert(cmd_f32.end(), command.color.begin(), command.color.end());
          break;
        case CommandKind::AddPrimitive:
        case CommandKind::AddPolygon:
          // render-stream-4.md "Command": points 2n, colours 4 x colors.size(), uvs 2 x uvs.size().
          items_json += command.kind == CommandKind::AddPrimitive ? "{\"op\":\"add_primitive\",\"tex\":"
                                                            : "{\"op\":\"add_polygon\",\"tex\":";
          if (command.has_tex) {
            append_json_int(items_json, command.tex);
          } else {
            items_json += "null";
          }
          items_json += ",\"n\":";
          append_json_int(items_json, command.points.size());
          items_json += ",\"colors\":";
          append_json_int(items_json, command.colors.size());
          items_json += ",\"uvs\":";
          append_json_int(items_json, command.uvs.size());
          items_json += ",\"f\":";
          append_json_int(items_json, cmd_f32.size());
          items_json += "}";
          for (const Point2 &p : command.points) {
            cmd_f32.insert(cmd_f32.end(), p.begin(), p.end());
          }
          for (const Color4 &c : command.colors) {
            cmd_f32.insert(cmd_f32.end(), c.begin(), c.end());
          }
          for (const Point2 &uv : command.uvs) {
            cmd_f32.insert(cmd_f32.end(), uv.begin(), uv.end());
          }
          break;
        case CommandKind::AddTriangleArray:
          // render-stream-4.md "Command": cmd_f32 as add_primitive; indices (int32) in cmd_i32.
          items_json += "{\"op\":\"add_triangle_array\",\"tex\":";
          if (command.has_tex) {
            append_json_int(items_json, command.tex);
          } else {
            items_json += "null";
          }
          items_json += ",\"n\":";
          append_json_int(items_json, command.points.size());
          items_json += ",\"colors\":";
          append_json_int(items_json, command.colors.size());
          items_json += ",\"uvs\":";
          append_json_int(items_json, command.uvs.size());
          items_json += ",\"indices\":";
          append_json_int(items_json, command.indices.size());
          items_json += ",\"count\":";
          append_json_int(items_json, command.triangle_count);
          items_json += ",\"i\":";
          append_json_int(items_json, cmd_i32.size());
          items_json += ",\"f\":";
          append_json_int(items_json, cmd_f32.size());
          items_json += "}";
          for (const Point2 &p : command.points) {
            cmd_f32.insert(cmd_f32.end(), p.begin(), p.end());
          }
          for (const Color4 &c : command.colors) {
            cmd_f32.insert(cmd_f32.end(), c.begin(), c.end());
          }
          for (const Point2 &uv : command.uvs) {
            cmd_f32.insert(cmd_f32.end(), uv.begin(), uv.end());
          }
          cmd_i32.insert(cmd_i32.end(), command.indices.begin(), command.indices.end());
          break;
        case CommandKind::AddNinePatch:
          // render-stream-4.md "Command": rect 4, source 4, margin tl 2, margin br 2, modulate 4.
          items_json += "{\"op\":\"add_nine_patch\",\"tex\":";
          if (command.has_tex) {
            append_json_int(items_json, command.tex);
          } else {
            items_json += "null";
          }
          items_json += ",\"x_axis\":";
          append_json_string(items_json, to_wire(command.x_axis));
          items_json += ",\"y_axis\":";
          append_json_string(items_json, to_wire(command.y_axis));
          items_json += ",\"draw_center\":";
          append_json_bool(items_json, command.draw_center);
          items_json += ",\"f\":";
          append_json_int(items_json, cmd_f32.size());
          items_json += "}";
          cmd_f32.insert(cmd_f32.end(), command.rect.begin(), command.rect.end());
          cmd_f32.insert(cmd_f32.end(), command.src.begin(), command.src.end());
          cmd_f32.insert(cmd_f32.end(), command.np_margin_tl.begin(), command.np_margin_tl.end());
          cmd_f32.insert(cmd_f32.end(), command.np_margin_br.begin(), command.np_margin_br.end());
          cmd_f32.insert(cmd_f32.end(), command.modulate.begin(), command.modulate.end());
          break;
        case CommandKind::AddMesh:
          // render-stream-4.md "Command": transform 6, modulate 4.
          items_json += "{\"op\":\"add_mesh\",\"mesh\":";
          append_json_int(items_json, command.mesh);
          items_json += ",\"tex\":";
          if (command.has_tex) {
            append_json_int(items_json, command.tex);
          } else {
            items_json += "null";
          }
          items_json += ",\"f\":";
          append_json_int(items_json, cmd_f32.size());
          items_json += "}";
          cmd_f32.insert(cmd_f32.end(), command.transform.begin(), command.transform.end());
          cmd_f32.insert(cmd_f32.end(), command.modulate.begin(), command.modulate.end());
          break;
        case CommandKind::AddSetTransform:
          // render-stream-4.md "Command": transform 6 (x.x, x.y, y.x, y.y, origin.x, origin.y).
          items_json += "{\"op\":\"add_set_transform\",\"f\":";
          append_json_int(items_json, cmd_f32.size());
          items_json += "}";
          cmd_f32.insert(cmd_f32.end(), command.transform.begin(), command.transform.end());
          break;
        case CommandKind::AddClipIgnore:
          // render-stream-4.md "Command": no floats, no "f" key.
          items_json += "{\"op\":\"add_clip_ignore\",\"ignore\":";
          append_json_bool(items_json, command.clip_ignore);
          items_json += "}";
          break;
        case CommandKind::Unsupported:
          items_json += "{\"op\":\"unsupported\",\"name\":";
          append_json_string(items_json, command.name);
          items_json += ",\"reason\":";
          append_json_string(items_json, to_wire(command.unsupported_reason));
          items_json += "}";
          break;
        }
      }
      items_json += "]";
    }
    items_json += "}";

    item_f32.insert(item_f32.end(), item.xform.begin(), item.xform.end());
    item_f32.insert(item_f32.end(), item.modulate.begin(), item.modulate.end());
    item_f32.insert(item_f32.end(), item.self_modulate.begin(), item.self_modulate.end());
    item_f32.insert(item_f32.end(), item.custom_rect_rect.begin(), item.custom_rect_rect.end());
  }
  items_json += "]";
  m += items_json;

  m += ",\"textures\":[";
  for (std::size_t i = 0; i < transaction.textures.size(); ++i) {
    if (i != 0) {
      m += ",";
    }
    append_texture_entry(m, transaction.textures[i], v8);
  }
  m += "]";

  std::vector<float> mesh_f32;
  if (is_v4) {
    m += ",\"meshes\":[";
    for (std::size_t i = 0; i < transaction.meshes.size(); ++i) {
      if (i != 0) {
        m += ",";
      }
      append_mesh_entry(m, transaction.meshes[i], mesh_f32, v8);
    }
    m += "]";
  }

  if (is_v5) {
    // render-stream-5.md "Shader table"/"Material table": shaders then materials, after meshes.
    m += ",\"shaders\":[";
    for (std::size_t i = 0; i < transaction.shaders.size(); ++i) {
      if (i != 0) {
        m += ",";
      }
      append_shader_entry(m, transaction.shaders[i], v8);
    }
    m += "]";
    m += materials_json;
  }

  m += ",";
  if (is_v5) {
    append_blocks_descriptor(m, {{"item_f32", "f32", item_f32.size()},
                                  {"canvas_f32", "f32", canvas_f32.size()},
                                  {"cmd_f32", "f32", cmd_f32.size()},
                                  {"cmd_i32", "i32", cmd_i32.size()},
                                  {"mesh_f32", "f32", mesh_f32.size()},
                                  {"param_f64", "f64", param_f64.size()}});
  } else if (is_v4) {
    append_blocks_descriptor(m, {{"item_f32", "f32", item_f32.size()},
                                  {"canvas_f32", "f32", canvas_f32.size()},
                                  {"cmd_f32", "f32", cmd_f32.size()},
                                  {"cmd_i32", "i32", cmd_i32.size()},
                                  {"mesh_f32", "f32", mesh_f32.size()}});
  } else {
    append_blocks_descriptor(m, {{"item_f32", "f32", item_f32.size()},
                                  {"canvas_f32", "f32", canvas_f32.size()},
                                  {"cmd_f32", "f32", cmd_f32.size()}});
  }
  m += "}";

  std::vector<BlockPayload> blocks = {f32_payload(item_f32), f32_payload(canvas_f32),
                                       f32_payload(cmd_f32)};
  if (is_v4) {
    blocks.push_back(i32_payload(cmd_i32));
    blocks.push_back(f32_payload(mesh_f32));
  }
  if (is_v5) {
    blocks.push_back(f64_payload(param_f64));
  }
  return assemble_record(m, blocks);
}

std::vector<std::uint8_t> encode_end(const End &end) {
  std::string m;
  m += "{\"type\":\"end\",\"transactions\":";
  append_json_int(m, end.transactions);
  m += ",\"reason\":";
  append_json_string(m, to_wire(end.reason));
  m += ",\"stats\":{\"bytes_total\":";
  append_json_int(m, end.stats.bytes_total);
  m += ",\"encode_ns_total\":";
  append_json_int(m, end.stats.encode_ns_total);
  m += ",\"snapshot_ns_total\":";
  append_json_int(m, end.stats.snapshot_ns_total);
  m += ",\"diff_ns_total\":";
  append_json_int(m, end.stats.diff_ns_total);
  m += ",\"max_record_bytes\":";
  append_json_int(m, end.stats.max_record_bytes);
  m += ",\"full_transactions\":";
  append_json_int(m, end.stats.full_transactions);
  m += ",\"patch_transactions\":";
  append_json_int(m, end.stats.patch_transactions);
  m += ",\"resource_records\":";
  append_json_int(m, end.stats.resource_records);
  m += ",\"resource_bytes\":";
  append_json_int(m, end.stats.resource_bytes);
  m += "}";
  m += ",";
  append_blocks_descriptor(m, {});
  m += "}";

  return assemble_record(m, {});
}

std::vector<std::uint8_t> encode_resource(const ResourceRecord &record) {
  std::string m;
  m += "{\"type\":\"resource\",\"hash\":";
  append_json_string(m, record.hash);
  m += ",\"bytes\":";
  append_json_int(m, record.payload.size());
  m += ",";
  append_blocks_descriptor(m, {{"payload", "u8", record.payload.size()}});
  m += "}";

  const std::vector<BlockPayload> blocks = {u8_payload(record.payload)};
  return assemble_record(m, blocks);
}

}  // namespace rs2
}  // namespace grc
