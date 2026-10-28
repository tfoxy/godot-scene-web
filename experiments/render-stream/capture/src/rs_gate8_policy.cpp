#include "rs_gate8_policy.h"

#include <cstdint>
#include <cstring>

#include "rs_live.h"

namespace grc {
namespace rs {

namespace {

bool is_float_format_name(const std::string &name) {
  static const char *const kNames[] = {"RF", "RGF", "RGBF", "RGBAF", "RH", "RGH", "RGBH", "RGBAH"};
  for (const char *candidate : kNames) {
    if (name == candidate) {
      return true;
    }
  }
  return false;
}

}  // namespace

bool sabotage_needs_v8(rs2::SabotageKind kind) {
  switch (kind) {
    case rs2::SabotageKind::AdoptSkipState:
    case rs2::SabotageKind::AdoptNoRedraw:
    case rs2::SabotageKind::AdoptSkipLayers:
    case rs2::SabotageKind::PerturbDecode:
    case rs2::SabotageKind::SizeBeforeAdopt:
    case rs2::SabotageKind::AdoptRawShaderCode:
    case rs2::SabotageKind::AdoptSkipParams:
      return true;
    default:
      return false;
  }
}

bool sabotage_needs_v11(rs2::SabotageKind kind) {
  return kind == rs2::SabotageKind::CvChurn || kind == rs2::SabotageKind::StaleDynamic ||
         kind == rs2::SabotageKind::KeepCarried || kind == rs2::SabotageKind::PerturbInstance ||
         kind == rs2::SabotageKind::StaleBuffer;
}

bool parse_mesh_dynamic_policy(const char *mode, const char *frames, const char *max_bytes,
                               rs2::MeshDynamicPolicy *out, std::string *error) {
  *out = rs2::MeshDynamicPolicy();
  rs2::MeshDynamicPolicy parsed;
  const auto present = [](const char *value) { return value != nullptr && *value != '\0'; };
  // A plain decimal integer (no sign, no spaces), within [lo, hi].
  const auto integer = [](const char *text, std::uint64_t lo, std::uint64_t hi, std::uint64_t *v) {
    std::uint64_t n = 0;
    std::size_t digits = 0;
    for (const char *p = text; *p != '\0'; ++p) {
      if (*p < '0' || *p > '9' || digits >= 19) {
        return false;
      }
      n = n * 10 + static_cast<std::uint64_t>(*p - '0');
      ++digits;
    }
    if (digits == 0 || n < lo || n > hi) {
      return false;
    }
    *v = n;
    return true;
  };
  if (present(mode)) {
    const std::string text(mode);
    if (text == "auto") {
      parsed.mode = rs2::MeshDynamicMode::Auto;
    } else if (text == "off") {
      parsed.mode = rs2::MeshDynamicMode::Off;
    } else if (text == "all") {
      parsed.mode = rs2::MeshDynamicMode::All;
    } else {
      *error = "invalid GRC_MESH_DYNAMIC=" + text + " (expected auto, off or all)";
      return false;
    }
  }
  std::uint64_t v = 0;
  if (present(frames)) {
    if (!integer(frames, 1, 60, &v)) {
      *error = std::string("invalid GRC_MESH_DYNAMIC_FRAMES=") + frames + " (expected 1..60)";
      return false;
    }
    parsed.frames = static_cast<std::int32_t>(v);
  }
  if (present(max_bytes)) {
    // JSON's exact integers (canonical JSON, render-stream-0.md): at most 2^53 - 1.
    if (!integer(max_bytes, 0, (std::uint64_t{1} << 53) - 1, &v)) {
      *error = std::string("invalid GRC_MESH_DYNAMIC_MAX_BYTES=") + max_bytes +
               " (expected an integer >= 0)";
      return false;
    }
    parsed.max_bytes = v;
  }
  *out = parsed;
  return true;
}

bool formats_name_float(const char *resource_formats) {
  if (resource_formats == nullptr) {
    return false;
  }
  const std::string text(resource_formats);
  std::size_t start = 0;
  while (start <= text.size()) {
    const std::size_t comma = text.find(',', start);
    const std::string name =
        text.substr(start, comma == std::string::npos ? std::string::npos : comma - start);
    if (is_float_format_name(name)) {
      return true;
    }
    if (comma == std::string::npos) {
      break;
    }
    start = comma + 1;
  }
  return false;
}

bool parse_gate8_policy(const char *stream_version, const char *adopt, const char *texture_decode,
                        const char *resource_formats, Gate8Policy *out, std::string *error) {
  *out = Gate8Policy();
  Gate8Policy parsed;
  const auto present = [](const char *value) { return value != nullptr && *value != '\0'; };
  if (present(stream_version)) {
    const std::string text(stream_version);
    if (text == "6") {
      parsed.file_version = rs2::ProtocolVersion::V6;
    } else if (text == "8") {
      parsed.file_version = rs2::ProtocolVersion::V8;
    } else if (text == "9") {
      parsed.file_version = rs2::ProtocolVersion::V9;
    } else if (text == "10") {
      parsed.file_version = rs2::ProtocolVersion::V10;
    } else if (text == "11") {
      parsed.file_version = rs2::ProtocolVersion::V11;
    } else {
      *error = "invalid GRC_STREAM_VERSION=" + text + " (expected 6, 8, 9, 10 or 11)";
      return false;
    }
    parsed.stream_version_set = true;
  }
  if (present(adopt)) {
    const std::string text(adopt);
    if (text == "arm") {
      parsed.adopt = true;
    } else if (text != "off") {
      *error = "invalid GRC_ADOPT=" + text + " (expected off or arm)";
      return false;
    }
  }
  if (present(texture_decode)) {
    const std::string text(texture_decode);
    if (text == "engine") {
      parsed.decode_engine = true;
    } else if (text != "off") {
      *error = "invalid GRC_TEXTURE_DECODE=" + text + " (expected off or engine)";
      return false;
    }
  }
  parsed.float_formats = formats_name_float(resource_formats);
  *out = parsed;
  return true;
}

bool gate8_policy_allows(const Gate8Policy &policy, bool files, std::string *error) {
  if (!files || !policy.any() || rs2::is_v8_or_later(policy.file_version)) {
    return true;
  }
  std::string which;
  const auto add = [&which](const char *name) {
    which += which.empty() ? "" : ", ";
    which += name;
  };
  if (policy.adopt) {
    add("GRC_ADOPT=arm");
  }
  if (policy.decode_engine) {
    add("GRC_TEXTURE_DECODE=engine");
  }
  if (policy.float_formats) {
    add("a float format in GRC_RESOURCE_FORMATS");
  }
  if (policy.v8_sabotage) {
    add("a render-stream/8 GRC_SABOTAGE kind");
  }
  *error = "policy-needs-v8: " + which +
           " needs a render-stream/8 file sink (set GRC_STREAM_VERSION=8)";
  return false;
}

std::vector<std::string> gate8_live_subprotocols(const Gate8Policy &policy) {
  if (policy.file_version == rs2::ProtocolVersion::V11) {
    // render-stream-11.md "Opt-in and version policy": .11 first, then /10's list.
    if (policy.any()) {
      return {rs2::kSubprotocolV11, rs2::kSubprotocolV10, rs2::kSubprotocolV9,
              rs2::kSubprotocolV8};
    }
    return {rs2::kSubprotocolV11, rs2::kSubprotocolV10, rs2::kSubprotocolV9, rs2::kSubprotocolV8,
            rs2::kSubprotocolV7,  "render-stream.6"};
  }
  if (policy.file_version == rs2::ProtocolVersion::V10) {
    // render-stream-10.md "Live transport".
    if (policy.any()) {
      return {rs2::kSubprotocolV10, rs2::kSubprotocolV9, rs2::kSubprotocolV8};
    }
    return {rs2::kSubprotocolV10, rs2::kSubprotocolV9, rs2::kSubprotocolV8, rs2::kSubprotocolV7,
            "render-stream.6"};
  }
  if (policy.file_version == rs2::ProtocolVersion::V9) {
    if (policy.any()) {
      return {rs2::kSubprotocolV9, rs2::kSubprotocolV8};
    }
    return {rs2::kSubprotocolV9, rs2::kSubprotocolV8, rs2::kSubprotocolV7, "render-stream.6"};
  }
  if (policy.any()) {
    return {rs2::kSubprotocolV8};
  }
  if (policy.file_version == rs2::ProtocolVersion::V8) {
    return {rs2::kSubprotocolV8, rs2::kSubprotocolV7, "render-stream.6"};
  }
  return {rs2::kSubprotocolV7, "render-stream.6", rs2::kSubprotocolV8};
}

}  // namespace rs
}  // namespace grc
