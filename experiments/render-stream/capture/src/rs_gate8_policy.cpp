#include "rs_gate8_policy.h"

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
    } else {
      *error = "invalid GRC_STREAM_VERSION=" + text + " (expected 6 or 8)";
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
  if (!files || !policy.any() || policy.file_version == rs2::ProtocolVersion::V8) {
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
