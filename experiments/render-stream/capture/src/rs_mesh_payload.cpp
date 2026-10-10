#include "rs_mesh_payload.h"

namespace grc {
namespace rs {

namespace {

constexpr const char *kPrimitiveNames[kMeshPrimitiveCount] = {
    "points", "lines", "line_strip", "triangles", "triangle_strip",
};

void put_u32le(std::vector<std::uint8_t> *out, std::uint32_t value) {
  for (int i = 0; i < 4; ++i) {
    out->push_back(static_cast<std::uint8_t>(value >> (8 * i)));
  }
}

void put_f32le(std::vector<std::uint8_t> *out, float value) {
  std::uint32_t bits = 0;
  __builtin_memcpy(&bits, &value, sizeof(bits));
  put_u32le(out, bits);
}

}  // namespace

const char *mesh_primitive_name(std::int32_t primitive) {
  if (primitive < 0 || primitive >= kMeshPrimitiveCount) {
    return nullptr;
  }
  return kPrimitiveNames[primitive];
}

SurfaceClassification classify_surface(const SurfaceFacts &facts) {
  SurfaceClassification result;
  // D16: blend-shape data is its own typed refusal, checked first (a surface can carry both a
  // disallowed format bit and blend-shape data; the contract names blend-shapes independently).
  if (facts.blend_shape_data_bytes > 0) {
    result.reason = "mesh-blend-shapes";
    return result;
  }
  if (mesh_primitive_name(facts.primitive) == nullptr) {
    result.reason = "mesh-format";
    return result;
  }
  if ((facts.format & kArrayFlagUse2dVertices) == 0) {
    // Not a 2D surface: 3D-vertex meshes in 2D are out of scope (D16).
    result.reason = "mesh-format";
    return result;
  }
  if ((facts.format & kArrayFlagCompressAttributes) != 0) {
    // Compressed attributes are never float32/RGBA8-unorm as D7 requires.
    result.reason = "mesh-format";
    return result;
  }
  constexpr std::uint64_t kDisallowed = kArrayFormatNormal | kArrayFormatTangent |
                                        kArrayFormatTexUv2 | kArrayFormatCustom0 |
                                        kArrayFormatCustom1 | kArrayFormatCustom2 |
                                        kArrayFormatCustom3;
  if ((facts.format & kDisallowed) != 0) {
    // D7 only models VERTEX, COLOR, TEX_UV, BONES+WEIGHTS and INDEX.
    result.reason = "mesh-format";
    return result;
  }
  result.ok = true;
  return result;
}

std::string payload_meta(std::int32_t primitive, std::uint64_t format, std::uint32_t vertex_count,
                         std::uint32_t index_count, std::int64_t vertex_bytes,
                         std::int64_t attribute_bytes, std::int64_t skin_bytes,
                         std::int64_t index_bytes) {
  const char *name = mesh_primitive_name(primitive);
  std::string meta = "{\"type\":\"mesh-surface\",\"primitive\":\"";
  meta += name != nullptr ? name : "";
  meta += "\",\"format\":" + std::to_string(format);
  meta += ",\"vertex_count\":" + std::to_string(vertex_count);
  meta += ",\"index_count\":" + std::to_string(index_count);
  meta += ",\"vertex_bytes\":" + std::to_string(vertex_bytes);
  meta += ",\"attribute_bytes\":" + std::to_string(attribute_bytes);
  meta += ",\"skin_bytes\":" + std::to_string(skin_bytes);
  meta += ",\"index_bytes\":" + std::to_string(index_bytes) + "}";
  return meta;
}

std::uint64_t mesh_payload_size(const std::string &meta, std::uint64_t data_bytes) {
  // magic + meta_len + meta + geometry (40 bytes: a 24-byte AABB, a 16-byte uv_scale) + data.
  return sizeof(kMeshPayloadMagic) + 4 + meta.size() + 40 + data_bytes;
}

void payload_header(const std::string &meta, const AABB &aabb, const Vector4 &uv_scale,
                    std::uint64_t data_bytes, std::vector<std::uint8_t> *out) {
  out->clear();
  out->reserve(static_cast<std::size_t>(mesh_payload_size(meta, data_bytes)));
  out->insert(out->end(), kMeshPayloadMagic, kMeshPayloadMagic + sizeof(kMeshPayloadMagic));
  put_u32le(out, static_cast<std::uint32_t>(meta.size()));
  out->insert(out->end(), meta.begin(), meta.end());
  put_f32le(out, aabb.position.x);
  put_f32le(out, aabb.position.y);
  put_f32le(out, aabb.position.z);
  put_f32le(out, aabb.size.x);
  put_f32le(out, aabb.size.y);
  put_f32le(out, aabb.size.z);
  put_f32le(out, uv_scale.x);
  put_f32le(out, uv_scale.y);
  put_f32le(out, uv_scale.z);
  put_f32le(out, uv_scale.w);
}

std::vector<std::uint8_t> encode_payload(std::int32_t primitive, std::uint64_t format,
                                         std::uint32_t vertex_count, std::uint32_t index_count,
                                         const AABB &aabb, const Vector4 &uv_scale,
                                         const std::uint8_t *vertex_data, std::size_t vertex_bytes,
                                         const std::uint8_t *attribute_data,
                                         std::size_t attribute_bytes, const std::uint8_t *skin_data,
                                         std::size_t skin_bytes, const std::uint8_t *index_data,
                                         std::size_t index_bytes) {
  const std::string meta =
      payload_meta(primitive, format, vertex_count, index_count,
                  static_cast<std::int64_t>(vertex_bytes), static_cast<std::int64_t>(attribute_bytes),
                  static_cast<std::int64_t>(skin_bytes), static_cast<std::int64_t>(index_bytes));
  std::vector<std::uint8_t> out;
  const std::uint64_t data_bytes = vertex_bytes + attribute_bytes + skin_bytes + index_bytes;
  payload_header(meta, aabb, uv_scale, data_bytes, &out);
  if (vertex_bytes > 0) {
    out.insert(out.end(), vertex_data, vertex_data + vertex_bytes);
  }
  if (attribute_bytes > 0) {
    out.insert(out.end(), attribute_data, attribute_data + attribute_bytes);
  }
  if (skin_bytes > 0) {
    out.insert(out.end(), skin_data, skin_data + skin_bytes);
  }
  if (index_bytes > 0) {
    out.insert(out.end(), index_data, index_data + index_bytes);
  }
  return out;
}

}  // namespace rs
}  // namespace grc
