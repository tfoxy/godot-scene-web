// Godot 4.5.1 internal C++ ABI, reproduced (not vendored) for the capture seam.
//
// The hooks installed in the RenderingServer vtable are called by the engine
// with Godot's own argument types, so these declarations must be
// layout-compatible with the engine's. Every one of them is a plain POD of the
// same size and alignment as the engine type; nothing here owns, copies, frees
// or reference-counts anything.
//
// Sources (../godot-4.5.1-stable, commit f62fdbde15035c5576dad93e586201f4d41ef0cb):
//   core/templates/rid.h        class RID { uint64_t _id; }
//   core/math/vector2.h         struct Vector2 { real_t x, y; }   (real_t = float)
//   core/math/rect2.h           struct Rect2 { Vector2 position, size; }
//   core/math/color.h           struct Color { float r, g, b, a; }
//   core/math/transform_2d.h    struct Transform2D { Vector2 columns[3]; }
//   core/templates/vector.h     class Vector<T> { CowData<T> _cowdata; }
//   core/templates/cowdata.h    class CowData<T> { T *_ptr; }
//   core/object/ref_counted.h   class Ref<T> { T *reference; }
//   servers/rendering_server.h  struct RenderingServer::SurfaceData (leading members only)

#pragma once

#include <cstddef>
#include <cstdint>

namespace grc {

struct RID {
  uint64_t id;
};
static_assert(sizeof(RID) == 8, "RID must be a single 64-bit id");

struct Vector2 {
  float x;
  float y;
};
using Point2 = Vector2;

struct Rect2 {
  Vector2 position;
  Vector2 size;
};

struct Color {
  float r;
  float g;
  float b;
  float a;
};

struct Transform2D {
  Vector2 columns[3];
};

static_assert(sizeof(Vector2) == 8, "single-precision Vector2");
static_assert(sizeof(Rect2) == 16, "single-precision Rect2");
static_assert(sizeof(Color) == 16, "Color is four floats");
static_assert(sizeof(Transform2D) == 24, "single-precision Transform2D");

// CowData<T>'s allocation carries an inline header in front of the elements:
//
//   ┌────────────────────┬─────────────┬──────────...
//   │ SafeNumeric<USize> │ USize       │ T[]
//   │ reference count    │ element size│ data
//   └────────────────────┴─────────────┴──────────...
//   ↑ ptr - 16             ↑ ptr - 8     ↑ ptr
//
// With USize = uint64_t and alignof(max_align_t) == 16 on x86-64, the constants
// in cowdata.h evaluate to REF_COUNT_OFFSET 0, SIZE_OFFSET 8, DATA_OFFSET 16.
constexpr std::ptrdiff_t kCowDataOffset = 16;
constexpr std::ptrdiff_t kCowSizeOffset = 8;
constexpr std::ptrdiff_t kCowRefCountOffset = 0;

// Element count of a CowData allocation whose element pointer is `data`.
// A null pointer means an empty vector (Godot's Vector<T>::size() does the same).
inline int64_t cowdata_size(const void *data) {
  if (data == nullptr) {
    return 0;
  }
  const auto *header = static_cast<const uint8_t *>(data) - kCowDataOffset;
  uint64_t size = 0;
  __builtin_memcpy(&size, header + kCowSizeOffset, sizeof(size));
  return static_cast<int64_t>(size);
}

// Reference count of a CowData allocation. Read for diagnostics only.
inline uint64_t cowdata_refcount(const void *data) {
  if (data == nullptr) {
    return 0;
  }
  const auto *header = static_cast<const uint8_t *>(data) - kCowDataOffset;
  uint64_t count = 0;
  __builtin_memcpy(&count, header + kCowRefCountOffset, sizeof(count));
  return count;
}

// Layout-compatible stand-in for Godot's Vector<T>. Note that Godot's Vector is
// TWO words, not one: it leads with an empty `VectorWriteProxy<T> write` member
// (the `vector.write[i]` accessor, vector.h:65), which takes one byte plus
// seven of padding, so the CowData element pointer sits at offset 8. Getting
// this wrong reads the wrong word out of every Vector argument.
template <typename T>
struct Vector {
  uintptr_t write_proxy;  // VectorWriteProxy<T>, empty, padded to 8 bytes
  const T *data;          // CowData<T>::_ptr

  int64_t size() const { return cowdata_size(data); }
  const T *ptr() const { return data; }
  bool empty() const { return size() == 0; }
};
static_assert(sizeof(Vector<Point2>) == 2 * sizeof(void *), "Vector<T> is two words");
static_assert(offsetof(Vector<Point2>, data) == 8, "the CowData pointer is at offset 8");

// Layout-compatible stand-in for Godot's Ref<T>: one pointer to the RefCounted,
// which (single inheritance, vptr at offset 0) is also the Object pointer the
// GDExtension method-bind API accepts. Never reference-counted here.
struct Ref {
  void *object;

  bool is_null() const { return object == nullptr; }
};
static_assert(sizeof(Ref) == sizeof(void *), "Ref<T> is one pointer");

//   core/math/vector3.h         struct Vector3 { real_t x, y, z; }  (inside a union with coord[3])
//   core/math/aabb.h            struct AABB { Vector3 position, size; }
struct Vector3 {
  float x;
  float y;
  float z;
};

struct AABB {
  Vector3 position;
  Vector3 size;
};
static_assert(sizeof(Vector3) == 12, "single-precision Vector3");
static_assert(sizeof(AABB) == 24, "single-precision AABB");

// Leading members of RenderingServer::SurfaceData (servers/rendering_server.h:366-394), which
// `mesh_add_surface` takes by const reference. Only this prefix is reproduced, and it is only ever
// READ through the engine's pointer: never construct, copy or size one of these, because the real
// struct continues past `aabb` (lods, bone_aabbs, mesh_to_skeleton_xform, blend_shape_data,
// uv_scale, material; 240 bytes in total).
//
// The struct has no preprocessor conditions, so the release define set does not change it. The
// offsets below were computed by hand (enum = 4 bytes, Vector<T> = two 8-aligned words, AABB = six
// floats with 4-byte alignment) and cross-checked by compiling `offsetof` probes against the
// pinned 4.5.1 header itself: primitive 0, format 8, vertex_data 16, attribute_data 32,
// skin_data 48, vertex_count 64, index_data 72, index_count 88, aabb 92, lods 120, sizeof 240.
struct SurfaceDataPrefix {
  int32_t primitive;  // RS::PrimitiveType, an unscoped enum: 4 bytes
  uint64_t format;    // RS::ArrayFormat bits
  Vector<uint8_t> vertex_data;
  Vector<uint8_t> attribute_data;
  Vector<uint8_t> skin_data;
  uint32_t vertex_count;
  Vector<uint8_t> index_data;
  uint32_t index_count;
  AABB aabb;
};
static_assert(offsetof(SurfaceDataPrefix, primitive) == 0, "SurfaceData::primitive");
static_assert(offsetof(SurfaceDataPrefix, format) == 8, "SurfaceData::format");
static_assert(offsetof(SurfaceDataPrefix, vertex_data) == 16, "SurfaceData::vertex_data");
static_assert(offsetof(SurfaceDataPrefix, attribute_data) == 32, "SurfaceData::attribute_data");
static_assert(offsetof(SurfaceDataPrefix, skin_data) == 48, "SurfaceData::skin_data");
static_assert(offsetof(SurfaceDataPrefix, vertex_count) == 64, "SurfaceData::vertex_count");
static_assert(offsetof(SurfaceDataPrefix, index_data) == 72, "SurfaceData::index_data");
static_assert(offsetof(SurfaceDataPrefix, index_count) == 88, "SurfaceData::index_count");
static_assert(offsetof(SurfaceDataPrefix, aabb) == 92, "SurfaceData::aabb");
// The prefix ends inside the real struct (the next member, `lods`, starts at 120).
static_assert(sizeof(SurfaceDataPrefix) <= 120, "the prefix must not read past SurfaceData::aabb");

}  // namespace grc
