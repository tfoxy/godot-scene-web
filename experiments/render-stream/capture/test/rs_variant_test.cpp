// Unit test for src/rs_variant.cpp's D8 decode (gate5_5-design.md D8, Q2 "Decoding").
//
// No ctest here runs inside a live Godot process, so this test never calls the real
// GDExtension interface: it builds its own fake implementation of the handful of interface
// functions rs_variant.cpp uses (`variant_get_type`, `get_variant_to_type_constructor`,
// `variant_get_ptr_constructor`, `variant_get_ptr_destructor`, `string_to_utf8_chars`) and
// installs them into `iface.h`'s global `g_iface`, then feeds `decode_variant`/`decode_string_
// name`/`decode_string` its own test-chosen "Variant"/"StringName"/"String" representations
// (never Godot's real ones: the decoder only ever calls through the provided function
// pointers, so it cannot tell the difference). Every supported Variant type round-trips
// through this fake exactly as it would through the real engine's.

#include <cstdint>
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

#include "abi.h"
#include "gdextension_interface.h"
#include "iface.h"
#include "rs_variant.h"

namespace {

int g_failures = 0;

void check(bool condition, const char *what) {
  if (!condition) {
    std::fprintf(stderr, "FAIL %s\n", what);
    ++g_failures;
  }
}

void check_near(double actual, double expected, const char *what) {
  check(actual == expected, what);
}

// --- a fake Variant: a type tag plus raw bytes shaped like the concrete type the real engine's
// matching constructor would write. Large enough for the biggest scalar (Projection, 64 bytes).
struct FakeVariant {
  GDExtensionVariantType type = GDEXTENSION_VARIANT_TYPE_NIL;
  alignas(16) unsigned char raw[64] = {};
};

template <typename T>
FakeVariant make_scalar(GDExtensionVariantType type, const T &value) {
  static_assert(sizeof(T) <= sizeof(FakeVariant{}.raw), "value fits the fake variant's buffer");
  FakeVariant v;
  v.type = type;
  std::memcpy(v.raw, &value, sizeof(T));
  return v;
}

// A CowData-style allocation ([refcount(8)][size(8)][elements...]), exactly as abi_decode.cpp's
// FakeCowData builds one: what backs a fake packed array's `grc::Vector<T>`.
template <typename T>
struct FakeCowData {
  std::vector<uint8_t> storage;
  const T *elements = nullptr;

  explicit FakeCowData(const std::vector<T> &values) {
    storage.resize(static_cast<size_t>(grc::kCowDataOffset) + values.size() * sizeof(T) + 16, 0);
    uint8_t *base = storage.data();
    const size_t misalignment = reinterpret_cast<uintptr_t>(base) % 16;
    uint8_t *aligned = base + ((16 - misalignment) % 16);
    const uint64_t size = values.size();
    std::memcpy(aligned + grc::kCowSizeOffset, &size, sizeof(size));
    if (!values.empty()) {
      std::memcpy(aligned + grc::kCowDataOffset, values.data(), values.size() * sizeof(T));
    }
    elements = reinterpret_cast<const T *>(aligned + grc::kCowDataOffset);
  }
};

template <typename T>
FakeVariant make_packed(GDExtensionVariantType type, const FakeCowData<T> &storage) {
  FakeVariant v;
  v.type = type;
  const grc::Vector<T> vec{0, storage.elements};
  static_assert(sizeof(vec) <= sizeof(v.raw), "a Vector<T> fits the fake variant's buffer");
  std::memcpy(v.raw, &vec, sizeof(vec));
  return v;
}

template <typename T>
void fake_memcpy_ctor(GDExtensionUninitializedTypePtr dest, GDExtensionVariantPtr src) {
  std::memcpy(dest, static_cast<const FakeVariant *>(src)->raw, sizeof(T));
}

GDExtensionVariantType fake_variant_get_type(GDExtensionConstVariantPtr p_self) {
  return static_cast<const FakeVariant *>(p_self)->type;
}

GDExtensionTypeFromVariantConstructorFunc fake_get_variant_to_type_constructor(
    GDExtensionVariantType type) {
  switch (type) {
    case GDEXTENSION_VARIANT_TYPE_BOOL:
      return &fake_memcpy_ctor<GDExtensionBool>;
    case GDEXTENSION_VARIANT_TYPE_INT:
      return &fake_memcpy_ctor<GDExtensionInt>;
    case GDEXTENSION_VARIANT_TYPE_FLOAT:
      return &fake_memcpy_ctor<double>;
    case GDEXTENSION_VARIANT_TYPE_VECTOR2:
      return &fake_memcpy_ctor<grc::Vector2>;
    case GDEXTENSION_VARIANT_TYPE_VECTOR2I:
      return &fake_memcpy_ctor<grc::Vector2i>;
    case GDEXTENSION_VARIANT_TYPE_RECT2:
      return &fake_memcpy_ctor<grc::Rect2>;
    case GDEXTENSION_VARIANT_TYPE_RECT2I:
      return &fake_memcpy_ctor<grc::Rect2i>;
    case GDEXTENSION_VARIANT_TYPE_VECTOR3:
      return &fake_memcpy_ctor<grc::Vector3>;
    case GDEXTENSION_VARIANT_TYPE_VECTOR3I:
      return &fake_memcpy_ctor<grc::Vector3i>;
    case GDEXTENSION_VARIANT_TYPE_TRANSFORM2D:
      return &fake_memcpy_ctor<grc::Transform2D>;
    case GDEXTENSION_VARIANT_TYPE_VECTOR4:
      return &fake_memcpy_ctor<grc::Vector4>;
    case GDEXTENSION_VARIANT_TYPE_VECTOR4I:
      return &fake_memcpy_ctor<grc::Vector4i>;
    case GDEXTENSION_VARIANT_TYPE_PLANE:
      return &fake_memcpy_ctor<grc::Plane>;
    case GDEXTENSION_VARIANT_TYPE_QUATERNION:
      return &fake_memcpy_ctor<grc::Quaternion>;
    case GDEXTENSION_VARIANT_TYPE_AABB:
      return &fake_memcpy_ctor<grc::AABB>;
    case GDEXTENSION_VARIANT_TYPE_BASIS:
      return &fake_memcpy_ctor<grc::Basis>;
    case GDEXTENSION_VARIANT_TYPE_TRANSFORM3D:
      return &fake_memcpy_ctor<grc::Transform3D>;
    case GDEXTENSION_VARIANT_TYPE_PROJECTION:
      return &fake_memcpy_ctor<grc::Projection>;
    case GDEXTENSION_VARIANT_TYPE_COLOR:
      return &fake_memcpy_ctor<grc::Color>;
    case GDEXTENSION_VARIANT_TYPE_RID:
      return &fake_memcpy_ctor<grc::RID>;
    case GDEXTENSION_VARIANT_TYPE_PACKED_INT32_ARRAY:
      return &fake_memcpy_ctor<grc::Vector<int32_t>>;
    case GDEXTENSION_VARIANT_TYPE_PACKED_INT64_ARRAY:
      return &fake_memcpy_ctor<grc::Vector<int64_t>>;
    case GDEXTENSION_VARIANT_TYPE_PACKED_FLOAT32_ARRAY:
      return &fake_memcpy_ctor<grc::Vector<float>>;
    case GDEXTENSION_VARIANT_TYPE_PACKED_FLOAT64_ARRAY:
      return &fake_memcpy_ctor<grc::Vector<double>>;
    case GDEXTENSION_VARIANT_TYPE_PACKED_VECTOR2_ARRAY:
      return &fake_memcpy_ctor<grc::Vector<grc::Vector2>>;
    case GDEXTENSION_VARIANT_TYPE_PACKED_VECTOR3_ARRAY:
      return &fake_memcpy_ctor<grc::Vector<grc::Vector3>>;
    case GDEXTENSION_VARIANT_TYPE_PACKED_VECTOR4_ARRAY:
      return &fake_memcpy_ctor<grc::Vector<grc::Vector4>>;
    case GDEXTENSION_VARIANT_TYPE_PACKED_COLOR_ARRAY:
      return &fake_memcpy_ctor<grc::Vector<grc::Color>>;
    default:
      return nullptr;
  }
}

void fake_noop_destructor(GDExtensionTypePtr) {}

GDExtensionPtrDestructor fake_variant_get_ptr_destructor(GDExtensionVariantType) {
  return &fake_noop_destructor;
}

// A fake StringName/String is just a pointer-sized slot holding a `const char *` -- the same
// single-pointer shape as the real engine's (abi.h's RawString), so `rs_variant.cpp`'s
// `RawString` destination is written and read identically either way.
void fake_string_from_string_name_ctor(GDExtensionUninitializedTypePtr dest,
                                       const GDExtensionConstTypePtr *args) {
  const char *const *name_slot = static_cast<const char *const *>(args[0]);
  *static_cast<const char **>(dest) = *name_slot;
}

GDExtensionPtrConstructor fake_variant_get_ptr_constructor(GDExtensionVariantType type,
                                                           int32_t ctor_index) {
  if (type == GDEXTENSION_VARIANT_TYPE_STRING && ctor_index == 2) {
    return &fake_string_from_string_name_ctor;
  }
  return nullptr;
}

GDExtensionInt fake_string_to_utf8_chars(GDExtensionConstStringPtr p_self, char *r_text,
                                         GDExtensionInt p_max_write_length) {
  const char *const *slot = static_cast<const char *const *>(p_self);
  const char *text = (*slot != nullptr) ? *slot : "";
  const auto length = static_cast<GDExtensionInt>(std::strlen(text));
  if (r_text == nullptr) {
    return length;
  }
  const GDExtensionInt to_copy = length < p_max_write_length ? length : p_max_write_length;
  std::memcpy(r_text, text, static_cast<size_t>(to_copy));
  return to_copy;
}

void install_fake_iface() {
  grc::g_iface = grc::Iface();
  grc::g_iface.variant_get_type = &fake_variant_get_type;
  grc::g_iface.get_variant_to_type_constructor = &fake_get_variant_to_type_constructor;
  grc::g_iface.variant_get_ptr_constructor = &fake_variant_get_ptr_constructor;
  grc::g_iface.variant_get_ptr_destructor = &fake_variant_get_ptr_destructor;
  grc::g_iface.string_to_utf8_chars = &fake_string_to_utf8_chars;
  grc::g_iface.complete = true;
}

// --- tests -------------------------------------------------------------------

void test_nil() {
  const grc::rs::DecodedParam decoded = grc::rs::decode_variant(nullptr);
  check(decoded.type == "nil", "null pointer decodes as nil");
  check(decoded.n == 1, "nil n is 1");
  check(decoded.f.empty(), "nil has no float components");
  check(decoded.status == "ok", "nil is ok");

  FakeVariant nil;
  nil.type = GDEXTENSION_VARIANT_TYPE_NIL;
  const grc::rs::DecodedParam decoded2 = grc::rs::decode_variant(&nil);
  check(decoded2.type == "nil", "an explicit NIL variant decodes as nil");
}

void test_bool() {
  FakeVariant v = make_scalar<GDExtensionBool>(GDEXTENSION_VARIANT_TYPE_BOOL, 1);
  const grc::rs::DecodedParam decoded = grc::rs::decode_variant(&v);
  check(decoded.type == "bool", "bool type name");
  check(decoded.n == 1, "bool n");
  check(decoded.f.size() == 1 && decoded.f[0] == 1.0, "bool true -> 1.0");
  check(decoded.status == "ok", "bool is ok");

  FakeVariant f = make_scalar<GDExtensionBool>(GDEXTENSION_VARIANT_TYPE_BOOL, 0);
  check(grc::rs::decode_variant(&f).f[0] == 0.0, "bool false -> 0.0");
}

void test_int() {
  FakeVariant v = make_scalar<GDExtensionInt>(GDEXTENSION_VARIANT_TYPE_INT, -42);
  const grc::rs::DecodedParam decoded = grc::rs::decode_variant(&v);
  check(decoded.type == "int", "int type name");
  check(decoded.n == 1, "int n");
  check_near(decoded.f[0], -42.0, "int value");
  check(decoded.status == "ok", "int in range is ok");

  // 2^53 is exact; 2^53 + 1 (an odd integer just past it) is the out-of-range case (D8).
  const int64_t max_exact = 1LL << 53;
  FakeVariant in_range = make_scalar<GDExtensionInt>(GDEXTENSION_VARIANT_TYPE_INT, max_exact);
  check(grc::rs::decode_variant(&in_range).status == "ok", "2^53 is still exact");
  FakeVariant too_big =
      make_scalar<GDExtensionInt>(GDEXTENSION_VARIANT_TYPE_INT, max_exact + 1);
  const grc::rs::DecodedParam big = grc::rs::decode_variant(&too_big);
  check(big.status == "unsupported" && big.reason == "param-range",
       "beyond 2^53 is param-range");
  FakeVariant too_small =
      make_scalar<GDExtensionInt>(GDEXTENSION_VARIANT_TYPE_INT, -max_exact - 1);
  check(grc::rs::decode_variant(&too_small).reason == "param-range",
       "beyond -2^53 is param-range too");
}

void test_float() {
  FakeVariant v = make_scalar<double>(GDEXTENSION_VARIANT_TYPE_FLOAT, 1.5);
  const grc::rs::DecodedParam decoded = grc::rs::decode_variant(&v);
  check(decoded.type == "float", "float type name");
  check_near(decoded.f[0], 1.5, "float value");
}

void test_vectors_and_matrices() {
  {
    const grc::Vector2 value{1.0f, -2.0f};
    FakeVariant v = make_scalar(GDEXTENSION_VARIANT_TYPE_VECTOR2, value);
    const grc::rs::DecodedParam d = grc::rs::decode_variant(&v);
    check(d.type == "vector2" && d.f.size() == 2 && d.f[0] == 1.0 && d.f[1] == -2.0,
         "vector2 round-trips x,y");
  }
  {
    const grc::Vector2i value{3, -4};
    FakeVariant v = make_scalar(GDEXTENSION_VARIANT_TYPE_VECTOR2I, value);
    const grc::rs::DecodedParam d = grc::rs::decode_variant(&v);
    check(d.type == "vector2i" && d.f.size() == 2 && d.f[0] == 3.0 && d.f[1] == -4.0,
         "vector2i round-trips x,y");
  }
  {
    const grc::Rect2 value{{1.0f, 2.0f}, {3.0f, 4.0f}};
    FakeVariant v = make_scalar(GDEXTENSION_VARIANT_TYPE_RECT2, value);
    const grc::rs::DecodedParam d = grc::rs::decode_variant(&v);
    check(d.type == "rect2" && d.f.size() == 4 && d.f[0] == 1.0 && d.f[3] == 4.0,
         "rect2 round-trips position,size");
  }
  {
    const grc::Rect2i value{{1, 2}, {3, 4}};
    FakeVariant v = make_scalar(GDEXTENSION_VARIANT_TYPE_RECT2I, value);
    const grc::rs::DecodedParam d = grc::rs::decode_variant(&v);
    check(d.type == "rect2i" && d.f.size() == 4 && d.f[2] == 3.0, "rect2i round-trips");
  }
  {
    const grc::Vector3 value{1.0f, 2.0f, 3.0f};
    FakeVariant v = make_scalar(GDEXTENSION_VARIANT_TYPE_VECTOR3, value);
    const grc::rs::DecodedParam d = grc::rs::decode_variant(&v);
    check(d.type == "vector3" && d.f.size() == 3 && d.f[2] == 3.0, "vector3 round-trips");
  }
  {
    const grc::Vector3i value{1, -2, 3};
    FakeVariant v = make_scalar(GDEXTENSION_VARIANT_TYPE_VECTOR3I, value);
    const grc::rs::DecodedParam d = grc::rs::decode_variant(&v);
    check(d.type == "vector3i" && d.f.size() == 3 && d.f[1] == -2.0, "vector3i round-trips");
  }
  {
    // Columns in order, x then y each (render-stream-0.md's Xform order, D8).
    const grc::Transform2D value{{{1.0f, 2.0f}, {3.0f, 4.0f}, {5.0f, 6.0f}}};
    FakeVariant v = make_scalar(GDEXTENSION_VARIANT_TYPE_TRANSFORM2D, value);
    const grc::rs::DecodedParam d = grc::rs::decode_variant(&v);
    check(d.type == "transform2d" && d.f.size() == 6, "transform2d component count");
    const double expect[6] = {1, 2, 3, 4, 5, 6};
    bool same = true;
    for (int i = 0; i < 6; ++i) {
      same = same && d.f[static_cast<size_t>(i)] == expect[i];
    }
    check(same, "transform2d columns in order");
  }
  {
    const grc::Vector4 value{1.0f, 2.0f, 3.0f, 4.0f};
    FakeVariant v = make_scalar(GDEXTENSION_VARIANT_TYPE_VECTOR4, value);
    const grc::rs::DecodedParam d = grc::rs::decode_variant(&v);
    check(d.type == "vector4" && d.f.size() == 4 && d.f[3] == 4.0, "vector4 round-trips");
  }
  {
    const grc::Vector4i value{1, 2, 3, -4};
    FakeVariant v = make_scalar(GDEXTENSION_VARIANT_TYPE_VECTOR4I, value);
    const grc::rs::DecodedParam d = grc::rs::decode_variant(&v);
    check(d.type == "vector4i" && d.f[3] == -4.0, "vector4i round-trips");
  }
  {
    const grc::Plane value{{1.0f, 0.0f, 0.0f}, 5.0f};
    FakeVariant v = make_scalar(GDEXTENSION_VARIANT_TYPE_PLANE, value);
    const grc::rs::DecodedParam d = grc::rs::decode_variant(&v);
    check(d.type == "plane" && d.f.size() == 4 && d.f[3] == 5.0, "plane: normal then d");
  }
  {
    const grc::Quaternion value{0.0f, 0.0f, 0.0f, 1.0f};
    FakeVariant v = make_scalar(GDEXTENSION_VARIANT_TYPE_QUATERNION, value);
    const grc::rs::DecodedParam d = grc::rs::decode_variant(&v);
    check(d.type == "quaternion" && d.f[3] == 1.0, "quaternion round-trips");
  }
  {
    const grc::AABB value{{1.0f, 2.0f, 3.0f}, {4.0f, 5.0f, 6.0f}};
    FakeVariant v = make_scalar(GDEXTENSION_VARIANT_TYPE_AABB, value);
    const grc::rs::DecodedParam d = grc::rs::decode_variant(&v);
    check(d.type == "aabb" && d.f.size() == 6 && d.f[5] == 6.0, "aabb round-trips");
  }
  {
    // Row-major (D4).
    const grc::Basis value{{{1, 2, 3}, {4, 5, 6}, {7, 8, 9}}};
    FakeVariant v = make_scalar(GDEXTENSION_VARIANT_TYPE_BASIS, value);
    const grc::rs::DecodedParam d = grc::rs::decode_variant(&v);
    check(d.type == "basis" && d.f.size() == 9, "basis component count");
    check(d.f[0] == 1.0 && d.f[8] == 9.0, "basis is row-major");
  }
  {
    grc::Transform3D value{};
    for (int i = 0; i < 9; ++i) {
      value.basis[i] = static_cast<float>(i + 1);
    }
    value.origin = {10.0f, 11.0f, 12.0f};
    FakeVariant v = make_scalar(GDEXTENSION_VARIANT_TYPE_TRANSFORM3D, value);
    const grc::rs::DecodedParam d = grc::rs::decode_variant(&v);
    check(d.type == "transform3d" && d.f.size() == 12, "transform3d component count");
    check(d.f[0] == 1.0 && d.f[8] == 9.0 && d.f[11] == 12.0, "transform3d basis then origin");
  }
  {
    // By column (D4).
    const grc::Projection value{{{1, 2, 3, 4}, {5, 6, 7, 8}, {9, 10, 11, 12}, {13, 14, 15, 16}}};
    FakeVariant v = make_scalar(GDEXTENSION_VARIANT_TYPE_PROJECTION, value);
    const grc::rs::DecodedParam d = grc::rs::decode_variant(&v);
    check(d.type == "projection" && d.f.size() == 16, "projection component count");
    check(d.f[0] == 1.0 && d.f[15] == 16.0, "projection is by column");
  }
  {
    const grc::Color value{0.25f, 0.5f, 0.75f, 1.0f};
    FakeVariant v = make_scalar(GDEXTENSION_VARIANT_TYPE_COLOR, value);
    const grc::rs::DecodedParam d = grc::rs::decode_variant(&v);
    check(d.type == "color" && d.f.size() == 4 && d.f[0] == 0.25, "color round-trips");
  }
}

void test_rid() {
  const grc::RID value{777};
  FakeVariant v = make_scalar(GDEXTENSION_VARIANT_TYPE_RID, value);
  const grc::rs::DecodedParam d = grc::rs::decode_variant(&v);
  check(d.type == "rid", "rid type name");
  check(d.n == 1, "rid n is 1");
  check(d.f.empty(), "rid carries no floats (D8)");
  check(d.tex_rid == 777, "rid carries the raw id");
}

void test_packed_arrays() {
  {
    const FakeCowData<int32_t> storage({1, -2, 3});
    FakeVariant v = make_packed(GDEXTENSION_VARIANT_TYPE_PACKED_INT32_ARRAY, storage);
    const grc::rs::DecodedParam d = grc::rs::decode_variant(&v);
    check(d.type == "int32" && d.n == 3, "packed int32 array shape");
    check(d.f.size() == 3 && d.f[1] == -2.0, "packed int32 array values");
  }
  {
    const FakeCowData<int64_t> storage({10, 20});
    FakeVariant v = make_packed(GDEXTENSION_VARIANT_TYPE_PACKED_INT64_ARRAY, storage);
    const grc::rs::DecodedParam d = grc::rs::decode_variant(&v);
    check(d.type == "int64" && d.n == 2 && d.f[1] == 20.0, "packed int64 array");
  }
  {
    const FakeCowData<float> storage({0.5f, 1.5f, 2.5f});
    FakeVariant v = make_packed(GDEXTENSION_VARIANT_TYPE_PACKED_FLOAT32_ARRAY, storage);
    const grc::rs::DecodedParam d = grc::rs::decode_variant(&v);
    check(d.type == "float32" && d.n == 3 && d.f[2] == 2.5, "packed float32 array");
  }
  {
    const FakeCowData<double> storage({1.25, 2.25});
    FakeVariant v = make_packed(GDEXTENSION_VARIANT_TYPE_PACKED_FLOAT64_ARRAY, storage);
    const grc::rs::DecodedParam d = grc::rs::decode_variant(&v);
    check(d.type == "float64" && d.n == 2 && d.f[0] == 1.25, "packed float64 array");
  }
  {
    const FakeCowData<grc::Vector2> storage({{1, 2}, {3, 4}});
    FakeVariant v = make_packed(GDEXTENSION_VARIANT_TYPE_PACKED_VECTOR2_ARRAY, storage);
    const grc::rs::DecodedParam d = grc::rs::decode_variant(&v);
    check(d.type == "vector2" && d.n == 2 && d.f.size() == 4 && d.f[3] == 4.0,
         "packed vector2 array (2 floats/element)");
  }
  {
    const FakeCowData<grc::Vector3> storage({{1, 2, 3}});
    FakeVariant v = make_packed(GDEXTENSION_VARIANT_TYPE_PACKED_VECTOR3_ARRAY, storage);
    const grc::rs::DecodedParam d = grc::rs::decode_variant(&v);
    check(d.type == "vector3" && d.n == 1 && d.f.size() == 3, "packed vector3 array");
  }
  {
    const FakeCowData<grc::Vector4> storage({{1, 2, 3, 4}});
    FakeVariant v = make_packed(GDEXTENSION_VARIANT_TYPE_PACKED_VECTOR4_ARRAY, storage);
    const grc::rs::DecodedParam d = grc::rs::decode_variant(&v);
    check(d.type == "vector4" && d.n == 1 && d.f.size() == 4, "packed vector4 array");
  }
  {
    const FakeCowData<grc::Color> storage({{1, 0, 0, 1}, {0, 1, 0, 1}});
    FakeVariant v = make_packed(GDEXTENSION_VARIANT_TYPE_PACKED_COLOR_ARRAY, storage);
    const grc::rs::DecodedParam d = grc::rs::decode_variant(&v);
    check(d.type == "color" && d.n == 2 && d.f.size() == 8, "packed color array (4 floats/element)");
  }
  {
    // An empty packed array: n 0, no floats, still "ok" (D8 does not refuse an empty array).
    const FakeCowData<float> storage({});
    FakeVariant v = make_packed(GDEXTENSION_VARIANT_TYPE_PACKED_FLOAT32_ARRAY, storage);
    const grc::rs::DecodedParam d = grc::rs::decode_variant(&v);
    check(d.status == "ok" && d.n == 0 && d.f.empty(), "an empty packed array is ok, n 0");
  }
}

void test_unsupported_types() {
  const struct {
    GDExtensionVariantType type;
    const char *name;
  } kCases[] = {
      {GDEXTENSION_VARIANT_TYPE_STRING, "string"},
      {GDEXTENSION_VARIANT_TYPE_STRING_NAME, "string_name"},
      {GDEXTENSION_VARIANT_TYPE_NODE_PATH, "node_path"},
      {GDEXTENSION_VARIANT_TYPE_OBJECT, "object"},
      {GDEXTENSION_VARIANT_TYPE_CALLABLE, "callable"},
      {GDEXTENSION_VARIANT_TYPE_SIGNAL, "signal"},
      {GDEXTENSION_VARIANT_TYPE_DICTIONARY, "dictionary"},
      {GDEXTENSION_VARIANT_TYPE_ARRAY, "array"},
      {GDEXTENSION_VARIANT_TYPE_PACKED_BYTE_ARRAY, "packed_byte_array"},
      {GDEXTENSION_VARIANT_TYPE_PACKED_STRING_ARRAY, "packed_string_array"},
  };
  for (const auto &c : kCases) {
    FakeVariant v;
    v.type = c.type;
    const grc::rs::DecodedParam d = grc::rs::decode_variant(&v);
    check(d.status == "unsupported" && d.reason == "param-type" && d.type == c.name,
         (std::string("D8's catch-all refuses ") + c.name).c_str());
  }
  // D6: an OBJECT value is the one the caller classifies "rejected", distinguishably, by type.
  FakeVariant object;
  object.type = GDEXTENSION_VARIANT_TYPE_OBJECT;
  check(grc::rs::decode_variant(&object).type == "object",
       "object is distinguishable from every other unsupported type");
}

void test_decode_unavailable() {
  // With no interface resolved, decode_variant degrades instead of crashing.
  const grc::Iface saved = grc::g_iface;
  grc::g_iface = grc::Iface();
  const grc::rs::DecodedParam null_type = grc::rs::decode_variant("not null, but unusable");
  check(null_type.type == "nil" && null_type.status == "ok",
       "no variant_get_type: treated as nil, not a crash");
  grc::g_iface = saved;

  grc::Iface partial = saved;
  partial.get_variant_to_type_constructor = nullptr;
  grc::g_iface = partial;
  FakeVariant v = make_scalar<double>(GDEXTENSION_VARIANT_TYPE_FLOAT, 2.0);
  const grc::rs::DecodedParam decoded = grc::rs::decode_variant(&v);
  check(decoded.status == "unsupported" && decoded.reason == "decode-unavailable",
       "no constructor table: decode-unavailable, not a crash");
  grc::g_iface = saved;
}

void test_decode_string_name_and_string() {
  const char *name = "tint";
  check(grc::rs::decode_string_name(&name) == "tint",
       "decode_string_name reads through String(StringName)");
  check(grc::rs::decode_string_name(nullptr).empty(), "a null StringName decodes empty");

  const char *code = "shader_type canvas_item;\nvoid fragment() { COLOR = vec4(1.0); }\n";
  check(grc::rs::decode_string(&code) == code, "decode_string reads the String verbatim");
  check(grc::rs::decode_string(nullptr).empty(), "a null String decodes empty");
}

}  // namespace

int main() {
  install_fake_iface();
  test_nil();
  test_bool();
  test_int();
  test_float();
  test_vectors_and_matrices();
  test_rid();
  test_packed_arrays();
  test_unsupported_types();
  test_decode_unavailable();
  test_decode_string_name_and_string();
  if (g_failures != 0) {
    std::fprintf(stderr, "%d check(s) failed\n", g_failures);
    return 1;
  }
  std::fprintf(stdout, "rs_variant: all checks passed\n");
  return 0;
}
