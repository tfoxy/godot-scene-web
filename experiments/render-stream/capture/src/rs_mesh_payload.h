// The canonical mesh surface payload, `render-stream-mesh/1` (GRM1;
// gate5-design.md Q4 "Mesh payload render-stream-mesh/1", D7 "Mesh format policy").
//
//   magic      8 bytes   47 52 4D 31 0D 0A 1A 0A   ("GRM1\r\n\x1a\n")
//   u32le      meta_len
//   meta       canonical JSON: {"type":"mesh-surface","primitive":<primitive>,"format":<int>,
//              "vertex_count":<int>,"index_count":<int>,"vertex_bytes":<int>,"attribute_bytes":<int>,
//              "skin_bytes":<int>,"index_bytes":<int>}
//   geometry   40 bytes: AABB (6 x f32le: position x, y, z, size x, y, z), uv_scale (4 x f32le)
//   data       vertex, attribute, skin, index bytes, concatenated, exactly as SurfaceData held them
//
// The content address is the lowercase hex SHA-256 of the whole payload (computed by the caller,
// as for GRT1: rs_sha256.h). `<primitive>` is one of "points", "lines", "line_strip", "triangles",
// "triangle_strip" (RS::PrimitiveType, servers/rendering_server.h:357-364).
//
// D7's format policy decides `ok` vs `unsupported` from the primitive and format bits alone (never
// from the buffer bytes): 2D positions (`ARRAY_FLAG_USE_2D_VERTICES`), optional `COLOR`, `TEX_UV`,
// `INDEX`, `BONES`+`WEIGHTS`; never `ARRAY_FLAG_COMPRESS_ATTRIBUTES`, `NORMAL`, `TANGENT`, `TEX_UV2`
// or a custom channel; never blend-shape data. Engine-free: every bit here is reproduced from
// servers/rendering_server.h, never read from a live engine.
#ifndef GRC_RS_MESH_PAYLOAD_H
#define GRC_RS_MESH_PAYLOAD_H

#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

#include "abi.h"

namespace grc {
namespace rs {

constexpr std::uint8_t kMeshPayloadMagic[8] = {0x47, 0x52, 0x4D, 0x31, 0x0D, 0x0A, 0x1A, 0x0A};

// servers/rendering_server.h:357-364, PRIMITIVE_MAX (5) excluded.
constexpr std::int32_t kMeshPrimitiveCount = 5;

// "points" | "lines" | "line_strip" | "triangles" | "triangle_strip", or nullptr outside
// [0, kMeshPrimitiveCount).
const char *mesh_primitive_name(std::int32_t primitive);

// RS::ArrayFormat / RS::ArrayFlags bits that matter to D7 (servers/rendering_server.h:276-352).
constexpr std::uint64_t kArrayFormatVertex = 1ull << 0;
constexpr std::uint64_t kArrayFormatNormal = 1ull << 1;
constexpr std::uint64_t kArrayFormatTangent = 1ull << 2;
constexpr std::uint64_t kArrayFormatColor = 1ull << 3;
constexpr std::uint64_t kArrayFormatTexUv = 1ull << 4;
constexpr std::uint64_t kArrayFormatTexUv2 = 1ull << 5;
constexpr std::uint64_t kArrayFormatCustom0 = 1ull << 6;
constexpr std::uint64_t kArrayFormatCustom1 = 1ull << 7;
constexpr std::uint64_t kArrayFormatCustom2 = 1ull << 8;
constexpr std::uint64_t kArrayFormatCustom3 = 1ull << 9;
constexpr std::uint64_t kArrayFormatBones = 1ull << 10;
constexpr std::uint64_t kArrayFormatWeights = 1ull << 11;
constexpr std::uint64_t kArrayFormatIndex = 1ull << 12;
constexpr std::uint64_t kArrayFlagUse2dVertices = 1ull << 25;
constexpr std::uint64_t kArrayFlagUseDynamicUpdate = 1ull << 26;
constexpr std::uint64_t kArrayFlagUse8BoneWeights = 1ull << 27;
constexpr std::uint64_t kArrayFlagUsesEmptyVertexArray = 1ull << 28;
constexpr std::uint64_t kArrayFlagCompressAttributes = 1ull << 29;

// What the hook read off a SurfaceData (abi.h), before any copy.
struct SurfaceFacts {
  std::int32_t primitive = -1;
  std::uint64_t format = 0;
  std::int64_t vertex_data_bytes = 0;
  std::int64_t attribute_data_bytes = 0;
  std::int64_t skin_data_bytes = 0;
  std::int64_t index_data_bytes = 0;
  std::uint32_t vertex_count = 0;
  std::uint32_t index_count = 0;
  std::int64_t blend_shape_data_bytes = 0;  // > 0 means the surface carries blend-shape data
};

struct SurfaceClassification {
  bool ok = false;
  std::string reason;  // "" when ok; "mesh-format" | "mesh-blend-shapes"
};

// D7, read from the primitive and format bits alone. `payload-too-large` is not decided here (it
// depends on GRC_RESOURCE_MAX_PAYLOAD_BYTES, a capture-wide policy: see copy_mesh_surface in
// hooks.cpp, which calls this first and only then checks the encoded size).
SurfaceClassification classify_surface(const SurfaceFacts &facts);

// The canonical meta JSON for the shape.
std::string payload_meta(std::int32_t primitive, std::uint64_t format, std::uint32_t vertex_count,
                         std::uint32_t index_count, std::int64_t vertex_bytes,
                         std::int64_t attribute_bytes, std::int64_t skin_bytes,
                         std::int64_t index_bytes);

// The full payload length for that meta and the four buffers' total size.
std::uint64_t mesh_payload_size(const std::string &meta, std::uint64_t data_bytes);

// Writes magic, meta length, meta, then the 40-byte geometry block (AABB, uv_scale) into `out`
// (cleared first), and reserves room for the four data buffers, which the caller appends in
// vertex, attribute, skin, index order.
void payload_header(const std::string &meta, const AABB &aabb, const Vector4 &uv_scale,
                    std::uint64_t data_bytes, std::vector<std::uint8_t> *out);

// The whole payload in one call (tests, and any caller that has every buffer's bytes already).
std::vector<std::uint8_t> encode_payload(std::int32_t primitive, std::uint64_t format,
                                         std::uint32_t vertex_count, std::uint32_t index_count,
                                         const AABB &aabb, const Vector4 &uv_scale,
                                         const std::uint8_t *vertex_data, std::size_t vertex_bytes,
                                         const std::uint8_t *attribute_data,
                                         std::size_t attribute_bytes, const std::uint8_t *skin_data,
                                         std::size_t skin_bytes, const std::uint8_t *index_data,
                                         std::size_t index_bytes);

}  // namespace rs
}  // namespace grc

#endif  // GRC_RS_MESH_PAYLOAD_H
