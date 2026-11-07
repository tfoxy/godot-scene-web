// One captured frame as the publishers see it (gate 2, G2b2): the mirror's render-stream/2
// snapshot plus the payload bytes of every `ok` image entry it names, keyed by content hash --
// and, since G5e (render-stream/4), of every surface of every `ok` mesh entry, and since G55d
// (render-stream/5) the GRP1 code payload of every `ok` shader with `source: "payload"`: GRT1,
// GRM1 and GRP1 payloads share one content-addressed map, store, inline threshold and HTTP
// path.
//
// The payloads are the GRT1 byte sequences the texture hooks copied at the call
// (rs_texture_payload.h), shared, never copied again: a snapshot keeps the
// versions it names alive for as long as anything holds it (a publisher's patch base, a live
// connection's base, a stale-coalesce copy). That is how payload pinning is implemented
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
#include "rs_shared_map.h"

namespace grc {
namespace rs {

// the coding a payload body is held in. A GRT1 texture body
// is coded once where it is built (the texture worker, or the hook under GRC_TEXTURE_WORKERS=sync)
// with the host's HTTP coding (GRC_HTTP_ENCODING, zstd by default) when that makes it smaller, and
// the mirror, the served set and every snapshot then share only that coded body. The content hash
// and every wire size stay the identity payload's (rs_payload_rest.h).
enum class RestCoding : std::uint8_t { Identity, Zstd, Gzip };  // live::Coding's values

// One payload body: the bytes as held (identity, or coded), plus the facts of the coding.
// Everything that only moves the pointer or weighs it sees a vector; anything that reads the
// identity content goes through rs::identity_of() (rs_payload_rest.h).
class PayloadBytes : public std::vector<std::uint8_t> {
 public:
  using std::vector<std::uint8_t>::vector;
  PayloadBytes() = default;
  explicit PayloadBytes(std::vector<std::uint8_t> &&bytes)
      : std::vector<std::uint8_t>(std::move(bytes)) {}

  RestCoding rest = RestCoding::Identity;
  // Coded: the identity payload's size. Identity: unused (size() is it).
  std::uint64_t identity_bytes = 0;
  // Set once the at-rest coding was tried on this body (an identity body with it set did not
  // shrink, or is not a GRT1 payload); the served-at-rest census counts an untried texture body.
  mutable bool rest_tried = false;
  // The at-rest-keep-identity sabotage (GRC_AT_REST_FAULT=keep-identity) only: the identity body
  // kept beside the coded one, the defect the TDR review found (Review record item 10).
  std::shared_ptr<const std::vector<std::uint8_t>> kept_identity;

  bool coded() const { return rest != RestCoding::Identity; }
  // The identity payload's size: the hash's bytes, every wire `payload_bytes`.
  std::uint64_t identity_size() const { return coded() ? identity_bytes : size(); }
  // The bytes this body holds in memory (the budget's and retained_bytes' unit).
  std::uint64_t held_bytes() const {
    return size() + (kept_identity != nullptr ? kept_identity->size() : 0);
  }
};
using PayloadPtr = std::shared_ptr<const PayloadBytes>;
// Content hash (64 lowercase hex) -> the complete render-stream-texture/1 or
// render-stream-mesh/1 payload. a persistent, copy-on-write map
// (rs_shared_map.h), so a snapshot whose payloads did not move shares the previous one's map, and
// the serving and budget code walks two maps over their differing chunks only. Its weight() is
// payload_map_bytes().
template <>
struct SharedMapWeight<PayloadPtr> {
  static std::uint64_t of(const PayloadPtr &payload) {
    return payload != nullptr ? payload->held_bytes() : 0;  // TDR: the bytes held, coded or not
  }
};
using PayloadMap = SharedStrMap<PayloadPtr>;

// how many
// entries of a state name a payload hash, by the rule of rs2_diff.h payload_names() -- `main` as
// an `ok` image's hash, a static `ok` mesh's surface or an `ok` payload-source shader's code,
// `variant` as an `ok` image's texture variant -- and its payload_bytes. A hash no entry names has
// no entry. records_before() asks it whether a hash is named by an entry two states share.
struct NameCount {
  std::uint32_t main = 0;
  std::uint32_t variant = 0;
  std::uint64_t payload_bytes = 0;
};
using NameIndex = SharedStrMap<NameCount>;

// The names one table entry adds to payload_names() (rs2_diff.cpp collect_names: the same rule,
// entry by entry): add(hash, payload_bytes, variant) for each, empty hashes skipped.
template <typename Add>
void texture_entry_names(const rs2::TextureEntry &t, Add add) {
  if (t.kind != rs2::TextureKind::Image || t.status != rs2::TextureStatus::Ok) {
    return;
  }
  if (t.has_hash && !t.hash.empty()) {
    add(t.hash, t.payload_bytes, false);
  }
  for (const rs2::TextureVariant &v : t.variants) {
    if (!v.hash.empty()) {
      add(v.hash, v.payload_bytes, true);
    }
  }
}
template <typename Add>
void mesh_entry_names(const rs2::MeshEntry &m, Add add) {
  // A dynamic mesh (W11b: `ok`, flagged, with a surface) names nothing.
  if (m.status != rs2::MeshStatus::Ok || (m.dynamic && !m.surfaces.empty())) {
    return;
  }
  for (const rs2::MeshSurface &surface : m.surfaces) {
    if (!surface.hash.empty()) {
      add(surface.hash, surface.payload_bytes, false);
    }
  }
}
template <typename Add>
void shader_entry_names(const rs2::ShaderEntry &sh, Add add) {
  if (sh.status == rs2::ShaderStatus::Ok && sh.has_source &&
      sh.source == rs2::ShaderSource::Payload && sh.has_hash && !sh.hash.empty()) {
    add(sh.hash, sh.payload_bytes, false);
  }
}

class TextureJob;  // rs_texture_worker.h

// one `ok` image entry of `state.textures` whose hash and
// payload a texture worker has not delivered yet. Its entry carries an empty hash until
// resolve_captured() (rs_texture_worker.h) fills it.
struct PendingTexture {
  std::size_t index = 0;  // into state.textures
  std::shared_ptr<TextureJob> job;
};

struct Captured {
  rs2::Snapshot state;
  // Exactly the hashes payload_refs(state) names: the `ok` image entries in `state.textures`,
  // the surfaces of the `ok` entries in `state.meshes` and the `ok` payload-source shaders in
  // `state.shaders` -- except the entries listed in `pending` (G8kw), which are not ready yet.
  PayloadMap payloads;
  // Empty unless GRC_TEXTURE_WORKERS=<N> left a texture's content to a worker (G8kw).
  std::vector<PendingTexture> pending;
  // some dynamic mesh surface of `state` carries a payload key, not
  // its SHA-256 (rs2::MeshSurface::hash_is_key): only a /11-or-later connection may be sent it.
  bool keyed_surfaces = false;
  // HC4b: the mirror's name index of `state` (NameIndex), valid only while `names_valid` (a
  // snapshot the mirror built; anything that rewrites the tables or resolves a pending texture
  // clears it, and records_before() then walks the tables). `inline_count` and
  // `inline_count_variants` are |inline(state)| without and with texture variants under an inline
  // threshold of `names_inline_max` bytes.
  NameIndex names;
  bool names_valid = false;
  std::uint64_t names_inline_max = 0;
  std::uint64_t inline_count = 0;
  std::uint64_t inline_count_variants = 0;
};

// One payload a snapshot names (G5e): an `ok` image entry, or one surface of an `ok` mesh entry.
struct PayloadRef {
  const std::string *hash = nullptr;
  std::uint64_t payload_bytes = 0;
  const rs2::TextureEntry *texture = nullptr;  // set for a texture payload (GRT1)
  const rs2::MeshSurface *surface = nullptr;   // set for a mesh surface payload (GRM1)
  const rs2::ShaderEntry *shader = nullptr;    // set for a shader code payload (GRP1, G55d)
};

// Every payload `state` names, in table order: the `ok` image textures by id, then each `ok`
// mesh's surfaces by mesh id and surface index, then (G55d, render-stream-5.md) each `ok` shader
// whose code travels as a payload (`source: "payload"`; never a `withheld` one, D4) by shader id
// (render-stream-2.md "Resource record": inline records go out in table order). A hash may
// repeat.
//
// W11b (render-stream-11.md "Mesh entry"): with `skip_dynamic` (a /11 stream) the surfaces of a
// dynamic `ok` mesh are left out -- they travel in the transaction's `mesh_u8`, so they take no
// resource record, store file or HTTP route. Every older stream names them as payloads, as the
// snapshot still holds their GRM1 payload and hash for a /10 connection on a /11 host.
inline std::vector<PayloadRef> payload_refs(const rs2::Snapshot &state, bool skip_dynamic = false) {
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
    if (mesh.status != rs2::MeshStatus::Ok ||
        (skip_dynamic && mesh.dynamic && !mesh.surfaces.empty())) {
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
  for (const rs2::ShaderEntry &shader : state.shaders) {
    if (shader.status != rs2::ShaderStatus::Ok || !shader.has_source ||
        shader.source != rs2::ShaderSource::Payload || !shader.has_hash) {
      continue;
    }
    PayloadRef ref;
    ref.hash = &shader.hash;
    ref.payload_bytes = shader.payload_bytes;
    ref.shader = &shader;
    out.push_back(ref);
  }
  return out;
}

// The payload bytes a map holds, each distinct hash once (HC4b: kept by the map).
inline std::uint64_t payload_map_bytes(const PayloadMap &map) { return map.weight(); }

// P3-CAP: payload_map_bytes() of the union of `maps` (each distinct hash once, the first map
// holding it supplies its bytes), without building the union. HC4b: the first map's bytes are
// kept by the map, and each later one adds only the hashes it holds beyond the first (its
// differences from it) that no earlier map holds.
inline std::uint64_t payload_union_bytes(const std::vector<const PayloadMap *> &maps) {
  std::uint64_t total = 0;
  const PayloadMap *first = nullptr;
  for (std::size_t i = 0; i < maps.size(); ++i) {
    if (maps[i] == nullptr) {
      continue;
    }
    if (first == nullptr) {
      first = maps[i];
      total += first->weight();
      continue;
    }
    bool repeat = false;
    for (std::size_t j = 0; j < i && !repeat; ++j) {
      repeat = maps[j] != nullptr && maps[j]->same(*maps[i]);
    }
    if (repeat) {
      continue;
    }
    diff_shared_maps(
        *first, *maps[i], [](const PayloadMap::value_type &) {},
        [&](const PayloadMap::value_type &entry) {
          bool earlier = false;
          for (std::size_t j = 0; j < i && !earlier; ++j) {
            earlier = maps[j] != nullptr && maps[j] != first && maps[j]->count(entry.first) != 0;
          }
          if (!earlier && entry.second != nullptr) {
            total += entry.second->held_bytes();
          }
        },
        [](const PayloadMap::value_type &, const PayloadMap::value_type &) {});
  }
  return total;
}

// payload_union_bytes() by the full walk (P3-CAP's), for the HC4b shadow oracle.
inline std::uint64_t payload_union_bytes_full(const std::vector<const PayloadMap *> &maps) {
  std::uint64_t total = 0;
  for (std::size_t i = 0; i < maps.size(); ++i) {
    if (maps[i] == nullptr) {
      continue;
    }
    for (const auto &entry : *maps[i]) {
      bool earlier = false;
      for (std::size_t j = 0; j < i && !earlier; ++j) {
        earlier = maps[j] != nullptr && maps[j]->count(entry.first) != 0;
      }
      if (!earlier && entry.second != nullptr) {
        total += entry.second->held_bytes();
      }
    }
  }
  return total;
}

}  // namespace rs
}  // namespace grc

#endif  // GRC_RS_CAPTURED_H
