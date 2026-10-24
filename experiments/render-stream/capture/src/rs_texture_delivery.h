// The texture-delivery seam (texture-delivery-design.md D1, D4, D5, D6; G8k9 landed the seam, the
// G8kp/G8ku/G8ke increments fill it).
//
// GRC_TEXTURE_DELIVERY=rgba|passthrough|basis-uastc|basis-etc1s (D1, default rgba) names the
// variants the host offers per texture. At /9 the session declares the mode and the encoder
// (`resources.texture_delivery`), and each ok image texture entry lists the variants the host has
// ready (`variants`, D5/D6). G8k9 landed the wire and the plumbing (the mode parsed and declared,
// the encoder null, no variant). G8kp fills `passthrough`: a block-compressed source that the host
// decodes (G8t) also keeps its hooked bytes as a `block` variant, a GRT1 payload in the source's
// own block format (render-stream-9.md "Texture payload"), hashed where the decoded payload is
// (the calling thread, or G8kw's worker). The Basis modes stay refused at /9
// (`delivery_mode_implemented`) until G8ku/G8ke. Below /9 nothing here runs: the hooks build a
// block payload only when `texture_delivery_block_enabled()` (a /9 stream under a mode offering
// `block`), and the codec never writes the key, so the seam changes no existing byte.
//
// Pure C++17, no engine types: unit-testable without a Godot process (rs_gate8_policy_test).
#ifndef GRC_RS_TEXTURE_DELIVERY_H
#define GRC_RS_TEXTURE_DELIVERY_H

#include <cstdint>
#include <string>
#include <vector>

#include "rs2_snapshot.h"

namespace grc {
namespace rs {

struct DeliveryPolicy {
  std::string mode = "rgba";  // rgba | passthrough | basis-uastc | basis-etc1s (D1)
  bool set = false;           // GRC_TEXTURE_DELIVERY was present and non-empty
};

// Parses GRC_TEXTURE_DELIVERY (may be null). On a bad value returns false with *error naming the
// variable and its accepted values, and leaves *out default.
bool parse_delivery_policy(const char *mode, DeliveryPolicy *out, std::string *error);

// The policy a stream runs under (set once at stream start; default rgba).
void texture_delivery_set_policy(const DeliveryPolicy &policy);
DeliveryPolicy texture_delivery_policy();

// Whether this build can honour the mode at /9: rgba and passthrough; the Basis modes are refused
// typed (`texture-delivery-unimplemented: ...`) until their encoder lands (G8ku, G8ke).
bool delivery_mode_implemented(const DeliveryPolicy &policy, std::string *error);

// Whether the mode offers a `block` variant (D1: passthrough and basis-uastc).
bool mode_offers_block(const std::string &mode);

// Set once at arm by the main thread (a /9 stream whose mode offers `block`), read by the texture
// hooks on any thread (loader threads, G8kw's workers): only then is a block payload built.
void texture_delivery_set_block(bool enabled);
bool texture_delivery_block_enabled();

// The gpu_formats family a block format belongs to (texture-delivery-design.md Q3, D3; Godot's
// feature names): "s3tc" for DXT1/DXT3/DXT5, "bptc" for BPTC_RGBA, "rgtc" for RGTC_R/RGTC_RG,
// "etc2" for ETC and the unswizzled ETC2 family, "astc" for ASTC_4x4/ASTC_8x8. nullptr for every
// other format, including the ones render-stream-9.md never offers as a variant (the
// `*_RA_AS_RG` swizzles, BPTC_RGBF/RGBFU and the ASTC HDR formats).
const char *block_format_family(const std::string &format);

// Godot's data size for a block format's shape (render-stream-9.md "Texture payload",
// `Image::get_image_data_size`): per level, ceil(w/block)*block * ceil(h/block)*block bytes,
// shifted right by the format's shift; -1 for a format block_format_family() refuses or a
// non-positive size.
std::int64_t block_data_bytes(const std::string &format, std::int64_t width, std::int64_t height,
                              bool mipmaps);

// The block variant a texture hook built (empty hash: none).
struct BlockVariant {
  std::string hash;           // SHA-256 of the whole GRT1 payload
  std::string format;         // the source block format's name
  std::uint64_t payload_bytes = 0;
};

// Totals since arm, for result.json's `stream.gate8.delivery_stats` (Q3 "Fallbacks, all typed
// and counted"): block payloads built, their bytes, and block-format sources that got none
// (a family refused, or a size that is not Godot's for the shape).
struct DeliveryStats {
  std::int64_t block_built = 0;
  std::int64_t block_bytes = 0;
  std::int64_t block_declined = 0;
};
void texture_delivery_note_block(bool built, std::uint64_t payload_bytes);
DeliveryStats texture_delivery_stats();

// The session's `resources.texture_delivery` (mode and encoder) for the policy. The encoder is
// null until a Basis encoder exists (G8ku). entry.cpp keeps it in the ResourcePolicy, so the file
// sinks' sessions (Publisher::start) and the live template both declare it.
rs2::TextureDeliveryDeclaration declare_texture_delivery(const DeliveryPolicy &policy);

// What the seam is asked about one ok image texture entry.
struct VariantRequest {
  std::uint32_t id = 0;
  std::string hash;    // the `decoded` payload's hash
  std::string format;  // the `decoded` payload's format name
  std::int32_t width = 0;
  std::int32_t height = 0;
  bool mipmaps = false;
  std::uint64_t version = 1;  // the entry's content version (D6)
  BlockVariant block;         // G8kp: the hooked bytes as a block GRT1 (empty hash: none)
};

// The variants the host has ready for this entry, sorted by encoding (block, uastc, etc1s), at
// most one each: under a mode offering `block`, the request's block variant when it has one
// (G8kp). Never a variant whose hash is the entry's own (render-stream-9.md invariant 4).
std::vector<rs2::TextureVariant> texture_variants(const VariantRequest &request);

}  // namespace rs
}  // namespace grc

#endif  // GRC_RS_TEXTURE_DELIVERY_H
