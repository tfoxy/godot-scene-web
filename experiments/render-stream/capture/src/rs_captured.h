// One captured frame as the publishers see it (gate 2, G2b2): the mirror's render-stream/2
// snapshot plus the payload bytes of every `ok` image entry it names, keyed by content hash --
// and, since G5e (render-stream/4), of every surface of every `ok` mesh entry: GRT1 and GRM1
// payloads share one content-addressed map, store, inline threshold and HTTP path.
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
// Content hash (64 lowercase hex) -> the complete render-stream-texture/1 or
// render-stream-mesh/1 payload.
using PayloadMap = std::map<std::string, PayloadPtr>;

struct Captured {
  rs2::Snapshot state;
  // Exactly the hashes of the `ok` image entries in `state.textures` and of the surfaces of the
  // `ok` entries in `state.meshes`.
  PayloadMap payloads;
};

// One payload a snapshot names (G5e): an `ok` image entry, or one surface of an `ok` mesh entry.
struct PayloadRef {
  const std::string *hash = nullptr;
  std::uint64_t payload_bytes = 0;
  const rs2::TextureEntry *texture = nullptr;  // set for a texture payload (GRT1)
  const rs2::MeshSurface *surface = nullptr;   // set for a mesh surface payload (GRM1)
};

// Every payload `state` names, in table order: the `ok` image textures by id, then each `ok`
// mesh's surfaces by mesh id and surface index (render-stream-2.md "Resource record": inline
// records go out in table order). A hash may repeat.
inline std::vector<PayloadRef> payload_refs(const rs2::Snapshot &state) {
  std::vector<PayloadRef> out;
  for (const rs2::TextureEntry &entry : state.textures) {
    if (entry.kind == rs2::TextureKind::Image && entry.status == rs2::TextureStatus::Ok &&
        entry.has_hash) {
      PayloadRef ref;
      ref.hash = &entry.hash;
      ref.payload_bytes = entry.payload_bytes;
      ref.texture = &entry;
      out.push_back(ref);
    }
  }
  for (const rs2::MeshEntry &mesh : state.meshes) {
    if (mesh.status != rs2::MeshStatus::Ok) {
      continue;
    }
    for (const rs2::MeshSurface &surface : mesh.surfaces) {
      PayloadRef ref;
      ref.hash = &surface.hash;
      ref.payload_bytes = surface.payload_bytes;
      ref.surface = &surface;
      out.push_back(ref);
    }
  }
  return out;
}

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
