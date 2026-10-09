#include "rs_texture_payload.h"

#include <algorithm>
#include <cstring>

namespace grc {
namespace rs {

namespace {

// core/io/image.h:75-114, in enum order.
constexpr const char *kFormatNames[kImageFormatCount] = {
    "L8",        "LA8",           "R8",          "RG8",           "RGB8",          "RGBA8",
    "RGBA4444",  "RGB565",        "RF",          "RGF",           "RGBF",          "RGBAF",
    "RH",        "RGH",           "RGBH",        "RGBAH",         "RGBE9995",      "DXT1",
    "DXT3",      "DXT5",          "RGTC_R",      "RGTC_RG",       "BPTC_RGBA",     "BPTC_RGBF",
    "BPTC_RGBFU", "ETC",          "ETC2_R11",    "ETC2_R11S",     "ETC2_RG11",     "ETC2_RG11S",
    "ETC2_RGB8", "ETC2_RGBA8",    "ETC2_RGB8A1", "ETC2_RA_AS_RG", "DXT5_RA_AS_RG", "ASTC_4x4",
    "ASTC_4x4_HDR", "ASTC_8x8",   "ASTC_8x8_HDR",
};

void put_u32le(std::vector<std::uint8_t> *out, std::uint32_t value) {
  for (int i = 0; i < 4; ++i) {
    out->push_back(static_cast<std::uint8_t>(value >> (8 * i)));
  }
}

}  // namespace

const char *image_format_name(std::int64_t format) {
  if (format < 0 || format >= kImageFormatCount) {
    return nullptr;
  }
  return kFormatNames[format];
}

std::int64_t image_format_from_name(const std::string &name) {
  for (std::int64_t i = 0; i < kImageFormatCount; ++i) {
    if (name == kFormatNames[i]) {
      return i;
    }
  }
  return -1;
}

int payload_pixel_size(std::int64_t format) {
  switch (format) {
    case 0:  // L8
    case 2:  // R8
      return 1;
    case 1:  // LA8
    case 3:  // RG8
      return 2;
    case 4:  // RGB8
      return 3;
    case 5:  // RGBA8
      return 4;
    default:
      return 0;
  }
}

std::int64_t expected_data_bytes(std::int64_t format, std::int64_t width, std::int64_t height,
                                 bool mipmaps) {
  const int pixel = payload_pixel_size(format);
  if (pixel == 0 || width < 1 || height < 1) {
    return -1;
  }
  std::int64_t total = 0;
  std::int64_t w = width;
  std::int64_t h = height;
  for (;;) {
    total += w * h * pixel;
    if (!mipmaps || (w == 1 && h == 1)) {
      break;
    }
    w = std::max<std::int64_t>(1, w >> 1);
    h = std::max<std::int64_t>(1, h >> 1);
  }
  return total;
}

std::string payload_meta(const char *format_name, std::int64_t width, std::int64_t height,
                         bool mipmaps, std::int64_t data_bytes) {
  std::string meta = "{\"type\":\"texture-2d\",\"format\":\"";
  meta += format_name != nullptr ? format_name : "";
  meta += "\",\"width\":" + std::to_string(width);
  meta += ",\"height\":" + std::to_string(height);
  meta += std::string(",\"mipmaps\":") + (mipmaps ? "true" : "false");
  meta += ",\"data_bytes\":" + std::to_string(data_bytes) + "}";
  return meta;
}

std::uint64_t payload_size(const std::string &meta, std::uint64_t data_bytes) {
  return sizeof(kPayloadMagic) + 4 + meta.size() + 4 + data_bytes;
}

void payload_header(const std::string &meta, std::uint64_t data_bytes,
                    std::vector<std::uint8_t> *out) {
  out->clear();
  out->reserve(static_cast<std::size_t>(payload_size(meta, data_bytes)));
  out->insert(out->end(), kPayloadMagic, kPayloadMagic + sizeof(kPayloadMagic));
  put_u32le(out, static_cast<std::uint32_t>(meta.size()));
  out->insert(out->end(), meta.begin(), meta.end());
  put_u32le(out, static_cast<std::uint32_t>(data_bytes));
}

std::vector<std::uint8_t> encode_payload(std::int64_t format, std::int64_t width,
                                         std::int64_t height, bool mipmaps,
                                         const std::uint8_t *data, std::size_t data_bytes) {
  const std::string meta = payload_meta(image_format_name(format), width, height, mipmaps,
                                        static_cast<std::int64_t>(data_bytes));
  std::vector<std::uint8_t> out;
  payload_header(meta, data_bytes, &out);
  if (data_bytes > 0) {
    out.insert(out.end(), data, data + data_bytes);
  }
  return out;
}

bool parse_format_policy(const char *value, FormatPolicy *out, std::string *error) {
  *out = FormatPolicy();
  std::string text =
      value != nullptr && *value != '\0' ? std::string(value) : std::string("L8,LA8,R8,RG8,RGB8,RGBA8");
  std::size_t start = 0;
  while (start <= text.size()) {
    const std::size_t comma = text.find(',', start);
    const std::string name =
        text.substr(start, comma == std::string::npos ? std::string::npos : comma - start);
    const std::int64_t format = image_format_from_name(name);
    if (format < 0 || payload_pixel_size(format) == 0) {
      *error = "GRC_RESOURCE_FORMATS: \"" + name +
               "\" is not one of L8, LA8, R8, RG8, RGB8, RGBA8 (the 8-bit uncompressed formats)";
      return false;
    }
    if (!out->permitted[format]) {
      out->permitted[format] = true;
      out->names.push_back(name);
    }
    if (comma == std::string::npos) {
      break;
    }
    start = comma + 1;
  }
  std::sort(out->names.begin(), out->names.end());
  return true;
}

bool parse_max_payload_bytes(const char *value, std::uint64_t *out, std::string *error) {
  if (value == nullptr || *value == '\0') {
    *out = kDefaultMaxPayloadBytes;
    return true;
  }
  const std::string text(value);
  if (text.size() > 15 || text.find_first_not_of("0123456789") != std::string::npos ||
      std::stoull(text) < 1) {
    *error = "GRC_RESOURCE_MAX_PAYLOAD_BYTES must be a decimal integer >= 1 (got \"" + text + "\")";
    return false;
  }
  *out = std::stoull(text);
  return true;
}

}  // namespace rs
}  // namespace grc
