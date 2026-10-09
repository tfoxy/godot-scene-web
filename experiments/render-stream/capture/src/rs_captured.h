// One captured frame as the publishers see it (gate 2, G2b2): the mirror's render-stream/2
// snapshot plus the payload bytes of every `ok` image entry it names, keyed by content hash.
//
// The payloads are the GRT1 byte sequences the texture hooks copied at the call
// (rs_texture_payload.h, gate2-design.md D3), shared, never copied again: a snapshot keeps the
// versions it names alive for as long as anything holds it (a publisher's patch base, a live
// connection's base, a stale-coalesce copy). That is how payload pinning is implemented
// (gate2-design.md D7, Q3 "Texture mirror").
//
// Engine-free, header-only.
#ifndef GRC_RS_CAPTURED_H
#define GRC_RS_CAPTURED_H

#include <cstdint>
#include <map>
#include <memory>
#include <string>
#include <vector>

#include "rs2_snapshot.h"

namespace grc {
namespace rs {

using PayloadBytes = std::vector<std::uint8_t>;
using PayloadPtr = std::shared_ptr<const PayloadBytes>;
// Content hash (64 lowercase hex) -> the complete render-stream-texture/1 payload.
using PayloadMap = std::map<std::string, PayloadPtr>;

struct Captured {
  rs2::Snapshot state;
  // Exactly the hashes of the `ok` image entries in `state.textures`.
  PayloadMap payloads;
};

// The payload bytes a map holds, each distinct hash once.
inline std::uint64_t payload_map_bytes(const PayloadMap &map) {
  std::uint64_t total = 0;
  for (const auto &entry : map) {
    if (entry.second != nullptr) {
      total += entry.second->size();
    }
  }
  return total;
}

}  // namespace rs
}  // namespace grc

#endif  // GRC_RS_CAPTURED_H
