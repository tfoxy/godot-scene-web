// The host texture-decode seam (gate8-design.md D8, Q3; G8w landed the seam, G8t fills it).
//
// Under GRC_TEXTURE_DECODE=engine, hooks.cpp's texture copy asks this seam about any image whose
// format is outside GRC_RESOURCE_FORMATS. A block-compressed format the engine's own
// `Image::decompress` turns into RGBA8, R8 or RG8 (the D8 table, `decode_target_format`) is
// decoded here, on the calling thread, on a duplicate of the hooked Image (`Resource.duplicate`,
// which shares the bytes copy-on-write, then `Image.decompress`): the engine's image is never
// touched. Everything else declines and the caller keeps its `unsupported-format` refusal:
// BC6H and ASTC HDR (they decode to half floats, G8f's), the swizzled `*_RA_AS_RG` formats (GLES3
// converts them further), the ETC2 formats etcpak does not decode (R11S, RG11S, RGB8A1), and every
// format that is not block-compressed. A decode whose result is not the table's format is refused
// too, so an engine whose decoder is missing or failed (bcdec/etcpak/astcenc ERR_FAIL leaves the
// image as it was) can never publish a payload under the wrong name.
//
// GRC_TEXTURE_DECODE=off (the default) never reaches the seam, so no other gate changes.
#ifndef GRC_RS_TEXTURE_DECODE_H
#define GRC_RS_TEXTURE_DECODE_H

#include <cstdint>
#include <memory>

namespace grc {
namespace rs {

struct DecodeRequest {
  std::int64_t format = -1;  // the source Image::Format
  std::int32_t width = 0;
  std::int32_t height = 0;
  bool mipmaps = false;
  void *image = nullptr;      // the hooked Image (GDExtensionObjectPtr); never mutated
  std::uint64_t frame = 0;    // the capture's frame, for the perturb-decode sabotage
};

struct DecodeResult {
  bool handled = false;  // false: the caller keeps its own refusal (unsupported-format)
  std::int64_t format = -1;  // the decoded payload's Image::Format
  std::int32_t width = 0;
  std::int32_t height = 0;
  bool mipmaps = false;
  const std::uint8_t *data = nullptr;  // the decoded bytes, valid while `hold` lives
  std::int64_t data_size = 0;
  std::shared_ptr<void> hold;  // keeps the decoded duplicate alive (released on reset)
  std::int64_t decode_ns = -1;  // duplicate + decompress, on the calling thread; -1 if not tried
  bool perturbed = false;       // perturb-decode flipped texel 0 (gate8-design.md Q3 "Sabotages")
};

// What a backend made of one request: the decoded image's shape and bytes, kept alive by `hold`.
struct DecodedImage {
  std::int64_t format = -1;
  std::int32_t width = 0;
  std::int32_t height = 0;
  bool mipmaps = false;
  const std::uint8_t *data = nullptr;
  std::int64_t data_size = 0;
  std::shared_ptr<void> hold;
};

// Duplicates and decompresses `image`; false when any engine call is unavailable or failed.
using DecodeBackend = bool (*)(void *image, DecodedImage *out);

// GRC_TEXTURE_DECODE=engine, set once at arm (main thread) before any texture call is made.
// Enabling resolves the engine method binds the default backend needs.
void texture_decode_set_enabled(bool enabled);
bool texture_decode_enabled();

// The payload format `Image::decompress` produces from `source` for a format this seam decodes,
// or -1 when the seam declines it (the D8 table above).
std::int64_t decode_target_format(std::int64_t source);

// The perturb-decode sabotage: from `from_frame` on (0 disables it), texel 0's first byte of every
// decoded payload is inverted after the decode and before the caller hashes it (on a private copy
// of the decoded bytes: the engine's buffers are only ever read).
void texture_decode_set_perturb(std::uint64_t from_frame);
// Whether the sabotage is configured (G8kc: the persisted cache is bypassed while it is, so a warm
// cache can never hide it).
bool texture_decode_perturb_active();

// Decodes `request` into a payload-ready image (see the header comment).
DecodeResult texture_decode(const DecodeRequest &request);

// Totals since arm, for result.json's `stream.gate8.decode` (gate8-design.md Q3 `decode-cost`).
struct DecodeStats {
  std::int64_t decoded = 0;   // handled requests
  std::int64_t declined = 0;  // requests the table or the result check refused
  std::int64_t decode_ns_total = 0;
  std::int64_t decode_ns_max = 0;
  std::int64_t decoded_bytes = 0;  // decoded data bytes, summed
};
DecodeStats texture_decode_stats();

// Test seam: replaces the engine backend (nullptr restores it).
void texture_decode_set_backend(DecodeBackend backend);

}  // namespace rs
}  // namespace grc

#endif  // GRC_RS_TEXTURE_DECODE_H
