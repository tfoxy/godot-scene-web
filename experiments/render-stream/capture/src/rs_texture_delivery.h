// The texture-delivery seam (texture-delivery-design.md D1, D4, D5, D6; G8k9 landed the seam, the
// G8kp/G8ku/G8ke increments fill it).
//
// GRC_TEXTURE_DELIVERY=rgba|passthrough|basis-uastc|basis-etc1s (D1, default rgba) names the
// variants the host offers per texture. At /9 the session declares the mode and the encoder
// (`resources.texture_delivery`), and each ok image texture entry lists the variants the host has
// ready (`variants`, D5/D6). G8k9 lands only the wire and the plumbing: the mode is parsed and
// declared, the encoder is always null, and `texture_variants` offers nothing, so every /9 entry
// carries `variants: []` and its `decoded` payload alone (a correct /8 entry). Below /9 the codec
// never writes the key, so the seam changes no existing byte.
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
};

// The variants the host has ready for this entry, sorted by encoding (block, uastc, etc1s), at
// most one each. EMPTY in G8k9.
std::vector<rs2::TextureVariant> texture_variants(const VariantRequest &request);

}  // namespace rs
}  // namespace grc

#endif  // GRC_RS_TEXTURE_DELIVERY_H
