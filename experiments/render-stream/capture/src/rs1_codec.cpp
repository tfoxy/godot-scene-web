#include "rs1_codec.h"

#include <algorithm>
#include <cstring>
#include <string>
#include <utility>

namespace grc {
namespace rs1 {

namespace {

// ----------------------------------------------------------------- bytes
//
// Record framing is unchanged from render-stream-0.md ("Record framing"); these helpers are the
// same as rs0_codec.cpp's.

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

std::vector<std::uint8_t> to_bytes(const std::string &s) {
  return std::vector<std::uint8_t>(s.begin(), s.end());
}

std::vector<std::uint8_t> assemble_record(const std::string &meta,
                                           const std::vector<std::vector<float>> &blocks) {
  std::string body;
  append_u32le(body, static_cast<std::uint32_t>(meta.size()));
  body += meta;
  append_u32le(body, static_cast<std::uint32_t>(blocks.size()));
  for (const auto &block : blocks) {
    std::string payload;
    payload.reserve(block.size() * 4);
    for (float value : block) {
      append_f32le(payload, value);
    }
    append_u32le(body, static_cast<std::uint32_t>(payload.size()));
    body += payload;
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
    std::string &out, const std::vector<std::pair<const char *, std::size_t>> &blocks) {
  out += "\"blocks\":[";
  for (std::size_t i = 0; i < blocks.size(); ++i) {
    if (i != 0) {
      out.push_back(',');
    }
    out += "{\"name\":";
    append_json_string(out, blocks[i].first);
    out += ",\"type\":\"f32\",\"count\":";
    append_json_int(out, blocks[i].second);
    out += "}";
  }
  out += "]";
}

}  // namespace

std::vector<std::uint8_t> magic() {
  return std::vector<std::uint8_t>(kMagic.begin(), kMagic.end());
}

std::vector<std::uint8_t> encode_session(const Session &session) {
  std::string m;
  m += "{\"type\":\"session\",\"protocol\":";
  append_json_string(m, kProtocol);
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

  m += ",\"features\":{\"ops\":";
  append_json_string_array(m, session.features.ops);
  m += ",\"item_state\":";
  append_json_string_array(m, session.features.item_state);
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
  append_blocks_descriptor(m, {{"clear_color", 4},
                                {"root_canvas_xform", 6},
                                {"host_visible_rect", 4},
                                {"host_final_xform", 6},
                                {"content_scale_factor", 1}});
  m += "}";

  const std::vector<std::vector<float>> blocks = {
      std::vector<float>(session.clear_color.begin(), session.clear_color.end()),
      std::vector<float>(session.root_canvas_xform.begin(), session.root_canvas_xform.end()),
      std::vector<float>(session.host_visible_rect.begin(), session.host_visible_rect.end()),
      std::vector<float>(session.host_final_xform.begin(), session.host_final_xform.end()),
      std::vector<float>{session.content_scale_factor},
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

  m += ",\"removed_canvases\":";
  append_json_id_array(m, transaction.removed_canvases);
  m += ",\"removed_items\":";
  append_json_id_array(m, transaction.removed_items);

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
        if (command.kind == CommandKind::AddRect) {
          m += "{\"op\":\"add_rect\",\"aa\":";
          append_json_bool(m, command.antialiased);
          m += ",\"f\":";
          append_json_int(m, cmd_f32.size());
          m += "}";
          cmd_f32.insert(cmd_f32.end(), command.rect.begin(), command.rect.end());
          cmd_f32.insert(cmd_f32.end(), command.color.begin(), command.color.end());
        } else {
          m += "{\"op\":\"unsupported\",\"name\":";
          append_json_string(m, command.name);
          m += "}";
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

  m += ",";
  append_blocks_descriptor(m, {{"item_f32", item_f32.size()},
                                {"canvas_f32", canvas_f32.size()},
                                {"cmd_f32", cmd_f32.size()}});
  m += "}";

  const std::vector<std::vector<float>> blocks = {item_f32, canvas_f32, cmd_f32};
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
  m += "}";
  m += ",";
  append_blocks_descriptor(m, {});
  m += "}";

  return assemble_record(m, {});
}

}  // namespace rs1
}  // namespace grc
