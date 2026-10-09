// The canonical texture payload, `render-stream-texture/1` (GRT1;
// render-stream-2.md "Texture payload", gate2-design.md D2, D3, Q3 "Copy").
//
//   magic      8 bytes   47 52 54 31 0D 0A 1A 0A   ("GRT1\r\n\x1a\n")
//   u32le      meta_len
//   meta       canonical JSON: {"type":"texture-2d","format":<name>,"width":<int>,
//              "height":<int>,"mipmaps":<bool>,"data_bytes":<int>}
//   u32le      data_len  (== data_bytes)
//   data       the Image's bytes exactly (Image::ptr(), Image::get_data_size())
//
// The content address is the lowercase hex SHA-256 of the whole payload. Only
// the 8-bit uncompressed formats have a payload at gate 2; everything here is
// engine-free so the ctest can pin the bytes.
#ifndef GRC_RS_TEXTURE_PAYLOAD_H
#define GRC_RS_TEXTURE_PAYLOAD_H

#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

namespace grc {
namespace rs {

constexpr std::uint8_t kPayloadMagic[8] = {0x47, 0x52, 0x54, 0x31, 0x0D, 0x0A, 0x1A, 0x0A};

// Number of Image::Format values in 4.5.1 (core/io/image.h:75-114).
constexpr std::int64_t kImageFormatCount = 39;

// Godot's Image::Format identifier without FORMAT_ ("L8", "RGBA8", ...), or
// nullptr outside the enum.
const char *image_format_name(std::int64_t format);

// The enum value of a format name, or -1.
std::int64_t image_format_from_name(const std::string &name);

// Bytes per pixel of the formats a payload may carry (L8 1, LA8 2, R8 1, RG8 2,
// RGB8 3, RGBA8 4); 0 for every other format.
int payload_pixel_size(std::int64_t format);

// Godot's data size for the shape (core/io/image.cpp:1700-1745): pixel size
// times the sum of w*h over the mip chain, which halves each dimension with a
// floor of 1 until both reach 1, or level 0 alone without mipmaps. -1 for a
// format payload_pixel_size() does not know, or a non-positive size.
std::int64_t expected_data_bytes(std::int64_t format, std::int64_t width, std::int64_t height,
                                 bool mipmaps);

// The canonical meta JSON for the shape.
std::string payload_meta(const char *format_name, std::int64_t width, std::int64_t height,
                         bool mipmaps, std::int64_t data_bytes);

// The full payload length for that meta and data size.
std::uint64_t payload_size(const std::string &meta, std::uint64_t data_bytes);

// Writes magic, meta length, meta and data length into `out` (cleared first)
// and reserves room for the data, which the caller appends.
void payload_header(const std::string &meta, std::uint64_t data_bytes,
                    std::vector<std::uint8_t> *out);

// The whole payload in one call (tests, and any caller that has the bytes).
std::vector<std::uint8_t> encode_payload(std::int64_t format, std::int64_t width,
                                         std::int64_t height, bool mipmaps,
                                         const std::uint8_t *data, std::size_t data_bytes);

// GRC_RESOURCE_FORMATS: a comma-separated list of format names, each one a
// format payload_pixel_size() knows. Unset or empty means the gate 2 default,
// L8,LA8,R8,RG8,RGB8,RGBA8. `permitted` is indexed by Image::Format; `names`
// is sorted ascending by byte value (the session's `permitted_formats`).
struct FormatPolicy {
  bool permitted[kImageFormatCount] = {};
  std::vector<std::string> names;
};
bool parse_format_policy(const char *value, FormatPolicy *out, std::string *error);

// GRC_RESOURCE_MAX_PAYLOAD_BYTES: a decimal integer >= 1; unset means
// kDefaultMaxPayloadBytes.
constexpr std::uint64_t kDefaultMaxPayloadBytes = 64ull << 20;
bool parse_max_payload_bytes(const char *value, std::uint64_t *out, std::string *error);

}  // namespace rs
}  // namespace grc

#endif  // GRC_RS_TEXTURE_PAYLOAD_H
