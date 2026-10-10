#include "rs2_codec.h"

#include <algorithm>
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

std::vector<std::uint8_t> to_bytes(const std::string &s) {
  return std::vector<std::uint8_t>(s.begin(), s.end());
}

// One block's payload, tagged by type (render-stream-2.md "Record framing: the u8 block type";
// render-stream-4.md "Block type i32").
enum class BlockKind { F32, U8, I32 };

struct BlockPayload {
  BlockKind kind = BlockKind::F32;
  std::vector<float> floats;          // F32
  std::vector<std::uint8_t> bytes;    // U8
  std::vector<std::int32_t> ints;     // I32
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
void append_mesh_entry(std::string &out, const MeshEntry &mesh, std::vector<float> &mesh_f32) {
  out += "{\"id\":";
  append_json_int(out, mesh.id);
  out += ",\"origin\":\"created\"";
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

void append_texture_entry(std::string &out, const TextureEntry &t) {
  out += "{\"id\":";
  append_json_int(out, t.id);
  out += ",\"origin\":\"created\"";
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

}  // namespace

std::vector<std::uint8_t> magic() {
  return std::vector<std::uint8_t>(kMagic.begin(), kMagic.end());
}

std::vector<std::uint8_t> magic(ProtocolVersion version) {
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
  const char *protocol = session.version == ProtocolVersion::V4
                              ? kProtocolV4
                              : (session.version == ProtocolVersion::V3 ? kProtocolV3 : kProtocol);
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
  m += ",\"host_size_status\":";
  append_json_string(m, to_wire(session.viewport.host_size_status));
  m += ",\"host_window_size\":[";
  append_json_int(m, session.viewport.host_window_size[0]);
  m += ",";
  append_json_int(m, session.viewport.host_window_size[1]);
  m += "]}";

  m += ",\"resources\":{\"hash\":\"sha256\",";
  if (session.version == ProtocolVersion::V4) {
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
  m += "}";

  m += ",\"features\":{\"ops\":";
  append_json_string_array(m, session.features.ops);
  m += ",\"item_state\":";
  append_json_string_array(m, session.features.item_state);
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

  m += ",\"default_texture_filter\":";
  append_json_string(m, to_wire(transaction.default_texture_filter));
  m += ",\"default_texture_repeat\":";
  append_json_string(m, to_wire(transaction.default_texture_repeat));

  const bool is_v4 = transaction.version == ProtocolVersion::V4;

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
    m += ",\"items\":";
    append_json_id_array(m, canvas.items);
    m += "}";
    canvas_f32.insert(canvas_f32.end(), canvas.xform.begin(), canvas.xform.end());
  }
  m += "]";

  std::vector<float> item_f32;
  std::vector<float> cmd_f32;
  std::vector<std::int32_t> cmd_i32;  // new at /4: add_triangle_array's indices
  m += ",\"items\":[";
  for (std::size_t i = 0; i < transaction.items.size(); ++i) {
    if (i != 0) {
      m += ",";
    }
    const ItemEntry &entry = transaction.items[i];
    const ItemState &item = entry.state;
    m += "{\"id\":";
    append_json_int(m, item.id);
    m += ",\"origin\":";
    append_json_string(m, to_wire(item.origin));
    m += ",\"parent\":";
    if (item.parent.kind == ParentKind::None) {
      m += "null";
    } else {
      m += "{\"kind\":";
      append_json_string(m, to_wire(item.parent.kind));
      m += ",\"id\":";
      append_json_int(m, item.parent.id);
      m += "}";
    }
    m += ",\"children\":";
    append_json_id_array(m, item.children);
    m += ",\"visible\":";
    append_json_bool(m, item.visible);
    m += ",\"draw_index\":";
    append_json_int(m, item.draw_index);
    m += ",\"z_index\":";
    append_json_int(m, item.z_index);
    m += ",\"z_relative\":";
    append_json_bool(m, item.z_relative);
    m += ",\"behind\":";
    append_json_bool(m, item.behind);
    m += ",\"clip\":";
    append_json_bool(m, item.clip);
    m += ",\"custom_rect\":";
    append_json_bool(m, item.custom_rect);
    m += ",\"visibility_layer\":";
    append_json_int(m, item.visibility_layer);
    m += ",\"texture_filter\":";
    append_json_string(m, to_wire(item.texture_filter));
    m += ",\"texture_repeat\":";
    append_json_string(m, to_wire(item.texture_repeat));
    m += ",\"content_version\":";
    append_json_int(m, item.content_version);

    m += ",\"commands\":";
    if (entry.commands_null) {
      m += "null";
    } else {
      m += "[";
      for (std::size_t c = 0; c < item.commands.size(); ++c) {
        if (c != 0) {
          m += ",";
        }
        const Command &command = item.commands[c];
        switch (command.kind) {
        case CommandKind::AddRect:
          m += "{\"op\":\"add_rect\",\"aa\":";
          append_json_bool(m, command.antialiased);
          m += ",\"f\":";
          append_json_int(m, cmd_f32.size());
          m += "}";
          cmd_f32.insert(cmd_f32.end(), command.rect.begin(), command.rect.end());
          cmd_f32.insert(cmd_f32.end(), command.color.begin(), command.color.end());
          break;
        case CommandKind::AddTextureRect:
          m += "{\"op\":\"add_texture_rect\",\"tex\":";
          if (command.has_tex) {
            append_json_int(m, command.tex);
          } else {
            m += "null";
          }
          m += ",\"tile\":";
          append_json_bool(m, command.tile);
          m += ",\"transpose\":";
          append_json_bool(m, command.transpose);
          m += ",\"f\":";
          append_json_int(m, cmd_f32.size());
          m += "}";
          cmd_f32.insert(cmd_f32.end(), command.rect.begin(), command.rect.end());
          cmd_f32.insert(cmd_f32.end(), command.modulate.begin(), command.modulate.end());
          break;
        case CommandKind::AddTextureRectRegion:
          m += "{\"op\":\"add_texture_rect_region\",\"tex\":";
          if (command.has_tex) {
            append_json_int(m, command.tex);
          } else {
            m += "null";
          }
          m += ",\"transpose\":";
          append_json_bool(m, command.transpose);
          m += ",\"clip_uv\":";
          append_json_bool(m, command.clip_uv);
          m += ",\"f\":";
          append_json_int(m, cmd_f32.size());
          m += "}";
          cmd_f32.insert(cmd_f32.end(), command.rect.begin(), command.rect.end());
          cmd_f32.insert(cmd_f32.end(), command.src.begin(), command.src.end());
          cmd_f32.insert(cmd_f32.end(), command.modulate.begin(), command.modulate.end());
          break;
        case CommandKind::AddMsdfTextureRectRegion:
          // render-stream-3.md "Command": 14 floats (rect 4, src 4, modulate 4, px_range, scale).
          m += "{\"op\":\"add_msdf_texture_rect_region\",\"tex\":";
          if (command.has_tex) {
            append_json_int(m, command.tex);
          } else {
            m += "null";
          }
          m += ",\"outline\":";
          append_json_int(m, command.msdf_outline);
          m += ",\"f\":";
          append_json_int(m, cmd_f32.size());
          m += "}";
          cmd_f32.insert(cmd_f32.end(), command.rect.begin(), command.rect.end());
          cmd_f32.insert(cmd_f32.end(), command.src.begin(), command.src.end());
          cmd_f32.insert(cmd_f32.end(), command.modulate.begin(), command.modulate.end());
          cmd_f32.push_back(command.msdf_px_range);
          cmd_f32.push_back(command.msdf_scale);
          break;
        case CommandKind::AddLine:
          // render-stream-4.md "Command": 9 floats (from 2, to 2, colour 4, width 1).
          m += "{\"op\":\"add_line\",\"aa\":";
          append_json_bool(m, command.antialiased);
          m += ",\"f\":";
          append_json_int(m, cmd_f32.size());
          m += "}";
          cmd_f32.insert(cmd_f32.end(), command.line_from.begin(), command.line_from.end());
          cmd_f32.insert(cmd_f32.end(), command.line_to.begin(), command.line_to.end());
          cmd_f32.insert(cmd_f32.end(), command.color.begin(), command.color.end());
          cmd_f32.push_back(command.width);
          break;
        case CommandKind::AddPolyline:
        case CommandKind::AddMultiline:
          // render-stream-4.md "Command": width 1, points 2n, colours 4 x colors.size().
          m += command.kind == CommandKind::AddPolyline ? "{\"op\":\"add_polyline\",\"aa\":"
                                                          : "{\"op\":\"add_multiline\",\"aa\":";
          append_json_bool(m, command.antialiased);
          m += ",\"n\":";
          append_json_int(m, command.points.size());
          m += ",\"colors\":";
          append_json_int(m, command.colors.size());
          m += ",\"f\":";
          append_json_int(m, cmd_f32.size());
          m += "}";
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
          m += "{\"op\":\"add_circle\",\"aa\":";
          append_json_bool(m, command.antialiased);
          m += ",\"f\":";
          append_json_int(m, cmd_f32.size());
          m += "}";
          cmd_f32.insert(cmd_f32.end(), command.circle_position.begin(), command.circle_position.end());
          cmd_f32.push_back(command.circle_radius);
          cmd_f32.insert(cmd_f32.end(), command.color.begin(), command.color.end());
          break;
        case CommandKind::AddPrimitive:
        case CommandKind::AddPolygon:
          // render-stream-4.md "Command": points 2n, colours 4 x colors.size(), uvs 2 x uvs.size().
          m += command.kind == CommandKind::AddPrimitive ? "{\"op\":\"add_primitive\",\"tex\":"
                                                            : "{\"op\":\"add_polygon\",\"tex\":";
          if (command.has_tex) {
            append_json_int(m, command.tex);
          } else {
            m += "null";
          }
          m += ",\"n\":";
          append_json_int(m, command.points.size());
          m += ",\"colors\":";
          append_json_int(m, command.colors.size());
          m += ",\"uvs\":";
          append_json_int(m, command.uvs.size());
          m += ",\"f\":";
          append_json_int(m, cmd_f32.size());
          m += "}";
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
          m += "{\"op\":\"add_triangle_array\",\"tex\":";
          if (command.has_tex) {
            append_json_int(m, command.tex);
          } else {
            m += "null";
          }
          m += ",\"n\":";
          append_json_int(m, command.points.size());
          m += ",\"colors\":";
          append_json_int(m, command.colors.size());
          m += ",\"uvs\":";
          append_json_int(m, command.uvs.size());
          m += ",\"indices\":";
          append_json_int(m, command.indices.size());
          m += ",\"count\":";
          append_json_int(m, command.triangle_count);
          m += ",\"i\":";
          append_json_int(m, cmd_i32.size());
          m += ",\"f\":";
          append_json_int(m, cmd_f32.size());
          m += "}";
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
          m += "{\"op\":\"add_nine_patch\",\"tex\":";
          if (command.has_tex) {
            append_json_int(m, command.tex);
          } else {
            m += "null";
          }
          m += ",\"x_axis\":";
          append_json_string(m, to_wire(command.x_axis));
          m += ",\"y_axis\":";
          append_json_string(m, to_wire(command.y_axis));
          m += ",\"draw_center\":";
          append_json_bool(m, command.draw_center);
          m += ",\"f\":";
          append_json_int(m, cmd_f32.size());
          m += "}";
          cmd_f32.insert(cmd_f32.end(), command.rect.begin(), command.rect.end());
          cmd_f32.insert(cmd_f32.end(), command.src.begin(), command.src.end());
          cmd_f32.insert(cmd_f32.end(), command.np_margin_tl.begin(), command.np_margin_tl.end());
          cmd_f32.insert(cmd_f32.end(), command.np_margin_br.begin(), command.np_margin_br.end());
          cmd_f32.insert(cmd_f32.end(), command.modulate.begin(), command.modulate.end());
          break;
        case CommandKind::AddMesh:
          // render-stream-4.md "Command": transform 6, modulate 4.
          m += "{\"op\":\"add_mesh\",\"mesh\":";
          append_json_int(m, command.mesh);
          m += ",\"tex\":";
          if (command.has_tex) {
            append_json_int(m, command.tex);
          } else {
            m += "null";
          }
          m += ",\"f\":";
          append_json_int(m, cmd_f32.size());
          m += "}";
          cmd_f32.insert(cmd_f32.end(), command.transform.begin(), command.transform.end());
          cmd_f32.insert(cmd_f32.end(), command.modulate.begin(), command.modulate.end());
          break;
        case CommandKind::AddSetTransform:
          // render-stream-4.md "Command": transform 6 (x.x, x.y, y.x, y.y, origin.x, origin.y).
          m += "{\"op\":\"add_set_transform\",\"f\":";
          append_json_int(m, cmd_f32.size());
          m += "}";
          cmd_f32.insert(cmd_f32.end(), command.transform.begin(), command.transform.end());
          break;
        case CommandKind::AddClipIgnore:
          // render-stream-4.md "Command": no floats, no "f" key.
          m += "{\"op\":\"add_clip_ignore\",\"ignore\":";
          append_json_bool(m, command.clip_ignore);
          m += "}";
          break;
        case CommandKind::Unsupported:
          m += "{\"op\":\"unsupported\",\"name\":";
          append_json_string(m, command.name);
          m += ",\"reason\":";
          append_json_string(m, to_wire(command.unsupported_reason));
          m += "}";
          break;
        }
      }
      m += "]";
    }
    m += "}";

    item_f32.insert(item_f32.end(), item.xform.begin(), item.xform.end());
    item_f32.insert(item_f32.end(), item.modulate.begin(), item.modulate.end());
    item_f32.insert(item_f32.end(), item.self_modulate.begin(), item.self_modulate.end());
    item_f32.insert(item_f32.end(), item.custom_rect_rect.begin(), item.custom_rect_rect.end());
  }
  m += "]";

  m += ",\"textures\":[";
  for (std::size_t i = 0; i < transaction.textures.size(); ++i) {
    if (i != 0) {
      m += ",";
    }
    append_texture_entry(m, transaction.textures[i]);
  }
  m += "]";

  std::vector<float> mesh_f32;
  if (is_v4) {
    m += ",\"meshes\":[";
    for (std::size_t i = 0; i < transaction.meshes.size(); ++i) {
      if (i != 0) {
        m += ",";
      }
      append_mesh_entry(m, transaction.meshes[i], mesh_f32);
    }
    m += "]";
  }

  m += ",";
  if (is_v4) {
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
