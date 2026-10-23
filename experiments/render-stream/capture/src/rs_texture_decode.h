// The host texture-decode seam (gate8-design.md D8, D9; G8w).
//
// G8w lands only the seam: the request/result types, the process-wide enable and the call site in
// hooks.cpp's texture copy, which asks the seam about a format outside GRC_RESOURCE_FORMATS when
// GRC_TEXTURE_DECODE=engine. The body declines everything; G8t fills it with the engine's own
// Image::decompress and the payload's source_format, so that increment changes this file pair
// rather than hooks.cpp. `GRC_TEXTURE_DECODE=off` (the default) never reaches it.
#ifndef GRC_RS_TEXTURE_DECODE_H
#define GRC_RS_TEXTURE_DECODE_H

#include <cstdint>
#include <vector>

namespace grc {
namespace rs {

struct DecodeRequest {
  std::int64_t format = -1;  // the source Image::Format
  std::int32_t width = 0;
  std::int32_t height = 0;
  bool mipmaps = false;
  const std::uint8_t *data = nullptr;
  std::int64_t data_size = 0;
};

struct DecodeResult {
  bool handled = false;  // false: the caller keeps its own refusal (unsupported-format)
  std::int64_t format = -1;  // the decoded payload's Image::Format
  std::int32_t width = 0;
  std::int32_t height = 0;
  bool mipmaps = false;
  std::vector<std::uint8_t> data;
};

// GRC_TEXTURE_DECODE=engine, set once at arm before any texture call is made.
void texture_decode_set_enabled(bool enabled);
bool texture_decode_enabled();

// Decodes `request` into a payload-ready image. G8w: always declines (`handled` false).
DecodeResult texture_decode(const DecodeRequest &request);

}  // namespace rs
}  // namespace grc

#endif  // GRC_RS_TEXTURE_DECODE_H
