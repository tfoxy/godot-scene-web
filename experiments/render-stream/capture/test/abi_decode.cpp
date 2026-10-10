// Unit test for the CowData inline-header decode in src/abi.h.
//
// The hooks read `Vector<T>` arguments straight out of engine memory, so the
// header offsets must be right. This test builds a buffer with the documented
// layout and checks that the decode finds the element count and elements, with
// no engine involved.

#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <vector>

#include "abi.h"

namespace {

int g_failures = 0;

void check(bool condition, const char *what) {
  if (!condition) {
    std::fprintf(stderr, "FAIL %s\n", what);
    ++g_failures;
  }
}

// Builds a CowData-style allocation: [refcount(8)][size(8)][elements...], and
// returns the element pointer, which is what Godot's Vector<T> stores.
template <typename T>
struct FakeCowData {
  std::vector<uint8_t> storage;
  const T *elements = nullptr;

  FakeCowData(uint64_t refcount, const std::vector<T> &values) {
    storage.resize(static_cast<size_t>(grc::kCowDataOffset) + values.size() * sizeof(T) + 16, 0);
    uint8_t *base = storage.data();
    // Keep the element pointer 16-byte aligned, like the engine's allocator.
    const size_t misalignment = reinterpret_cast<uintptr_t>(base) % 16;
    uint8_t *aligned = base + ((16 - misalignment) % 16);
    const uint64_t size = values.size();
    std::memcpy(aligned + grc::kCowRefCountOffset, &refcount, sizeof(refcount));
    std::memcpy(aligned + grc::kCowSizeOffset, &size, sizeof(size));
    if (!values.empty()) {
      std::memcpy(aligned + grc::kCowDataOffset, values.data(), values.size() * sizeof(T));
    }
    elements = reinterpret_cast<const T *>(aligned + grc::kCowDataOffset);
  }
};

void test_offsets() {
  check(grc::kCowRefCountOffset == 0, "REF_COUNT_OFFSET is 0");
  check(grc::kCowSizeOffset == 8, "SIZE_OFFSET is 8");
  check(grc::kCowDataOffset == 16, "DATA_OFFSET is 16");
}

void test_empty() {
  grc::Vector<grc::Point2> empty = {0, nullptr};
  check(empty.size() == 0, "a null element pointer decodes as an empty vector");
  check(empty.empty(), "empty() on a null element pointer");
  check(grc::cowdata_size(nullptr) == 0, "cowdata_size(nullptr)");
  check(grc::cowdata_refcount(nullptr) == 0, "cowdata_refcount(nullptr)");
}

void test_points() {
  const std::vector<grc::Point2> values = {{1.5f, -2.25f}, {0.0f, 1024.0f}, {3.125f, 4.0f}};
  FakeCowData<grc::Point2> fake(7, values);
  grc::Vector<grc::Point2> vector = {0, fake.elements};
  check(vector.size() == 3, "point vector size");
  check(grc::cowdata_refcount(fake.elements) == 7, "point vector refcount");
  check(vector.ptr() == fake.elements, "point vector element pointer");
  bool same = true;
  for (size_t i = 0; i < values.size(); ++i) {
    same = same && vector.ptr()[i].x == values[i].x && vector.ptr()[i].y == values[i].y;
  }
  check(same, "point vector elements round-trip bit-exactly");
}

void test_colors() {
  const std::vector<grc::Color> values = {{0.125f, 0.5f, 0.75f, 1.0f}, {1.0f, 0.0f, 0.0f, 0.25f}};
  FakeCowData<grc::Color> fake(1, values);
  grc::Vector<grc::Color> vector = {0, fake.elements};
  check(vector.size() == 2, "color vector size");
  check(vector.ptr()[1].a == 0.25f, "color vector element");
}

void test_large_size() {
  // A size that needs more than 32 bits must survive the decode.
  std::vector<uint8_t> storage(64, 0);
  const uint64_t size = 0x1'0000'0001ull;
  std::memcpy(storage.data() + grc::kCowSizeOffset, &size, sizeof(size));
  const void *elements = storage.data() + grc::kCowDataOffset;
  check(grc::cowdata_size(elements) == static_cast<int64_t>(size), "64-bit element count");
}

void test_layout() {
  check(sizeof(grc::RID) == 8, "RID size");
  check(sizeof(grc::Vector<grc::Point2>) == 2 * sizeof(void *), "Vector<T> is two words");
  check(offsetof(grc::Vector<grc::Point2>, data) == 8, "the CowData pointer is at offset 8");
  check(sizeof(grc::Ref) == sizeof(void *), "Ref<T> is one pointer");
  check(sizeof(grc::Rect2) == 16, "Rect2 size");
  check(sizeof(grc::Color) == 16, "Color size");
  check(sizeof(grc::Transform2D) == 24, "Transform2D size");
}

// RenderingServer::SurfaceData is read in place through the engine's pointer.
// Build a 240-byte block with the members where the 4.5.1 header puts them
// (offsets computed by hand and cross-checked with offsetof against the pinned
// header, see abi.h) and decode it through SurfaceDataPrefix.
void test_surface_data() {
  check(offsetof(grc::SurfaceDataPrefix, primitive) == 0, "SurfaceData::primitive at 0");
  check(offsetof(grc::SurfaceDataPrefix, format) == 8, "SurfaceData::format at 8");
  check(offsetof(grc::SurfaceDataPrefix, vertex_data) == 16, "SurfaceData::vertex_data at 16");
  check(offsetof(grc::SurfaceDataPrefix, attribute_data) == 32,
        "SurfaceData::attribute_data at 32");
  check(offsetof(grc::SurfaceDataPrefix, skin_data) == 48, "SurfaceData::skin_data at 48");
  check(offsetof(grc::SurfaceDataPrefix, vertex_count) == 64, "SurfaceData::vertex_count at 64");
  check(offsetof(grc::SurfaceDataPrefix, index_data) == 72, "SurfaceData::index_data at 72");
  check(offsetof(grc::SurfaceDataPrefix, index_count) == 88, "SurfaceData::index_count at 88");
  check(offsetof(grc::SurfaceDataPrefix, aabb) == 92, "SurfaceData::aabb at 92");
  check(sizeof(grc::AABB) == 24, "AABB size");
  check(offsetof(grc::SurfaceDataPrefix, lods) == 120, "SurfaceData::lods at 120");
  check(offsetof(grc::SurfaceDataPrefix, bone_aabbs) == 136, "SurfaceData::bone_aabbs at 136");
  check(offsetof(grc::SurfaceDataPrefix, mesh_to_skeleton_xform) == 152,
        "SurfaceData::mesh_to_skeleton_xform at 152");
  check(offsetof(grc::SurfaceDataPrefix, blend_shape_data) == 200,
        "SurfaceData::blend_shape_data at 200");
  check(offsetof(grc::SurfaceDataPrefix, uv_scale) == 216, "SurfaceData::uv_scale at 216");
  check(offsetof(grc::SurfaceDataPrefix, material) == 232, "SurfaceData::material at 232");
  check(sizeof(grc::SurfaceDataPrefix) == 240, "SurfaceData is 240 bytes");
  check(sizeof(grc::Transform3D) == 48, "Transform3D size");
  check(sizeof(grc::Vector4) == 16, "Vector4 size");

  FakeCowData<uint8_t> vertices(1, std::vector<uint8_t>(24, 0xab));
  FakeCowData<uint8_t> attributes(1, std::vector<uint8_t>(12, 0xcd));
  FakeCowData<uint8_t> indices(1, std::vector<uint8_t>(6, 0x01));
  FakeCowData<uint8_t> blend_shapes(1, std::vector<uint8_t>(4, 0xef));

  alignas(16) uint8_t block[240] = {};
  const int32_t primitive = 3;  // PRIMITIVE_TRIANGLES
  const uint64_t format = 0x0000000800002011ull;
  const uint32_t vertex_count = 3;
  const uint32_t index_count = 3;
  const float aabb[6] = {1.5f, -2.25f, 0.0f, 10.125f, 20.5f, 0.0f};
  const void *vertex_ptr = vertices.elements;
  const void *attribute_ptr = attributes.elements;
  const void *index_ptr = indices.elements;
  std::memcpy(block + 0, &primitive, sizeof(primitive));
  std::memcpy(block + 8, &format, sizeof(format));
  // Each Vector<uint8_t> is the write-proxy word, then the CowData pointer.
  std::memcpy(block + 16 + 8, &vertex_ptr, sizeof(void *));
  std::memcpy(block + 32 + 8, &attribute_ptr, sizeof(void *));
  // skin_data stays empty: a null CowData pointer.
  std::memcpy(block + 64, &vertex_count, sizeof(vertex_count));
  std::memcpy(block + 72 + 8, &index_ptr, sizeof(void *));
  std::memcpy(block + 88, &index_count, sizeof(index_count));
  std::memcpy(block + 92, aabb, sizeof(aabb));
  // lods (120) and bone_aabbs (136) stay empty: both null CowData pointers.
  // mesh_to_skeleton_xform (152, 48 bytes) is left zeroed; not decoded by anything.
  const void *blend_shape_ptr = blend_shapes.elements;
  std::memcpy(block + 200 + 8, &blend_shape_ptr, sizeof(void *));
  const float uv_scale[4] = {1.0f, 2.5f, -3.0f, 0.5f};
  std::memcpy(block + 216, uv_scale, sizeof(uv_scale));
  const uint64_t material_id = 0x1234;
  std::memcpy(block + 232, &material_id, sizeof(material_id));

  const auto *surface = reinterpret_cast<const grc::SurfaceDataPrefix *>(block);
  check(surface->primitive == 3, "decoded primitive");
  check(surface->format == format, "decoded format");
  check(surface->vertex_data.size() == 24, "decoded vertex_data size");
  check(surface->attribute_data.size() == 12, "decoded attribute_data size");
  check(surface->skin_data.size() == 0, "decoded empty skin_data");
  check(surface->vertex_count == 3, "decoded vertex_count");
  check(surface->index_data.size() == 6, "decoded index_data size");
  check(surface->index_count == 3, "decoded index_count");
  check(surface->aabb.position.y == -2.25f && surface->aabb.size.x == 10.125f, "decoded aabb");
  check(surface->lods.size() == 0, "decoded empty lods");
  check(surface->bone_aabbs.size() == 0, "decoded empty bone_aabbs");
  check(surface->blend_shape_data.size() == 4, "decoded blend_shape_data size");
  check(surface->uv_scale.x == 1.0f && surface->uv_scale.z == -3.0f, "decoded uv_scale");
  check(surface->material.id == 0x1234, "decoded material RID");
}

}  // namespace

int main() {
  test_offsets();
  test_empty();
  test_points();
  test_colors();
  test_large_size();
  test_layout();
  test_surface_data();
  if (g_failures != 0) {
    std::fprintf(stderr, "%d check(s) failed\n", g_failures);
    return 1;
  }
  std::fprintf(stdout, "abi_decode: all checks passed\n");
  return 0;
}
