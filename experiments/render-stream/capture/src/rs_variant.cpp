#include "rs_variant.h"

#include <cstring>
#include <type_traits>

#include "abi.h"
#include "gdextension_interface.h"
#include "iface.h"

namespace grc {
namespace rs {

namespace {

// STRING's registration order (core/variant/variant_construct.cpp:79-82): 0 no-args, 1 from
// String, 2 from StringName, 3 from NodePath.
constexpr int32_t kStringFromStringNameConstructor = 2;

// 2^53: the largest magnitude every integer up to is exact as a double (D8).
constexpr int64_t kMaxExactInt = 1LL << 53;

// Writes a Variant's value into a concrete, layout-compatible destination through
// `get_variant_to_type_constructor`. Returns false (destination untouched) when the interface is
// unavailable.
template <typename T>
bool construct_concrete(GDExtensionVariantType type, const void *variant_ptr, T *out) {
  if (g_iface.get_variant_to_type_constructor == nullptr || variant_ptr == nullptr) {
    return false;
  }
  const GDExtensionTypeFromVariantConstructorFunc ctor =
      g_iface.get_variant_to_type_constructor(type);
  if (ctor == nullptr) {
    return false;
  }
  // The engine only reads `variant_ptr` here; the non-const second parameter is the GDExtension
  // ABI's own (gdextension_interface.h:200), not a license to mutate the caller's Variant.
  ctor(out, const_cast<void *>(variant_ptr));
  return true;
}

// Destroys a value `construct_concrete` built, through the matching PtrDestructor. A no-op for a
// type whose destructor is itself trivial (every plain math type here); always called anyway, as
// `call_string_getter` (iface.cpp) does for a constructed String.
void destroy_concrete(GDExtensionVariantType type, void *value) {
  if (g_iface.variant_get_ptr_destructor == nullptr) {
    return;
  }
  const GDExtensionPtrDestructor dtor = g_iface.variant_get_ptr_destructor(type);
  if (dtor != nullptr) {
    dtor(value);
  }
}

// Appends one value's float64 components, in Godot's own member order (D8).
void push(std::vector<double> *f, double value) { f->push_back(value); }
void push(std::vector<double> *f, const Vector2 &v) {
  f->push_back(v.x);
  f->push_back(v.y);
}
void push(std::vector<double> *f, const Vector2i &v) {
  f->push_back(v.x);
  f->push_back(v.y);
}
void push(std::vector<double> *f, const Rect2 &v) {
  push(f, v.position);
  push(f, v.size);
}
void push(std::vector<double> *f, const Rect2i &v) {
  push(f, v.position);
  push(f, v.size);
}
void push(std::vector<double> *f, const Vector3 &v) {
  f->push_back(v.x);
  f->push_back(v.y);
  f->push_back(v.z);
}
void push(std::vector<double> *f, const Vector3i &v) {
  f->push_back(v.x);
  f->push_back(v.y);
  f->push_back(v.z);
}
// render-stream-0.md's Xform order: each column's x, then y, in column order.
void push(std::vector<double> *f, const Transform2D &v) {
  for (const Vector2 &column : v.columns) {
    push(f, column);
  }
}
void push(std::vector<double> *f, const Vector4 &v) {
  f->push_back(v.x);
  f->push_back(v.y);
  f->push_back(v.z);
  f->push_back(v.w);
}
void push(std::vector<double> *f, const Vector4i &v) {
  f->push_back(v.x);
  f->push_back(v.y);
  f->push_back(v.z);
  f->push_back(v.w);
}
void push(std::vector<double> *f, const Plane &v) {
  push(f, v.normal);
  f->push_back(v.d);
}
void push(std::vector<double> *f, const Quaternion &v) {
  f->push_back(v.x);
  f->push_back(v.y);
  f->push_back(v.z);
  f->push_back(v.w);
}
void push(std::vector<double> *f, const AABB &v) {
  push(f, v.position);
  push(f, v.size);
}
// Row-major (D4).
void push(std::vector<double> *f, const Basis &v) {
  for (const Vector3 &row : v.rows) {
    push(f, row);
  }
}
void push(std::vector<double> *f, const Transform3D &v) {
  for (float value : v.basis) {
    f->push_back(value);
  }
  push(f, v.origin);
}
// By column (D4).
void push(std::vector<double> *f, const Projection &v) {
  for (const Vector4 &column : v.columns) {
    push(f, column);
  }
}
void push(std::vector<double> *f, const Color &v) {
  f->push_back(v.r);
  f->push_back(v.g);
  f->push_back(v.b);
  f->push_back(v.a);
}

// A scalar (non-array, non-rid, non-nil) Variant type: constructs the concrete value, pushes its
// components, and fills in `type`/`n`.
template <typename T>
void decode_scalar(GDExtensionVariantType type, const void *variant_ptr, const char *type_name,
                   DecodedParam *out) {
  T value{};
  if (!construct_concrete(type, variant_ptr, &value)) {
    out->status = "unsupported";
    out->reason = "decode-unavailable";
    return;
  }
  out->type = type_name;
  out->n = 1;
  push(&out->f, value);
  destroy_concrete(type, &value);
}

// D8's eight supported packed numeric arrays: decoded through the same `grc::Vector<T>`
// stand-in every other engine Vector argument in this library uses (abi.h) -- PackedXArray is
// itself `typedef Vector<T> PackedXArray` (core/variant/variant.h:77-87), never its own class.
template <typename Elem>
void decode_packed(GDExtensionVariantType type, const void *variant_ptr, const char *type_name,
                   DecodedParam *out) {
  Vector<Elem> array{};
  if (!construct_concrete(type, variant_ptr, &array)) {
    out->status = "unsupported";
    out->reason = "decode-unavailable";
    return;
  }
  out->type = type_name;
  out->packed = true;
  out->n = array.size();
  const Elem *values = array.ptr();
  for (int64_t i = 0; i < out->n; ++i) {
    push(&out->f, values[i]);
  }
  if constexpr (std::is_same<Elem, int64_t>::value) {
    // D8: an int beyond +-2^53 is param-range, in a packed array as in a scalar.
    for (int64_t i = 0; i < out->n; ++i) {
      const int64_t v = static_cast<int64_t>(values[i]);
      if (v > kMaxExactInt || v < -kMaxExactInt) {
        out->status = "unsupported";
        out->reason = "param-range";
        out->f.clear();
        break;
      }
    }
  }
  destroy_concrete(type, &array);
}

// D8's catch-all: a Variant type this library does not model as a parameter at all (never
// hooked into `n`/`f`; diagnostic only).
const char *unsupported_type_name(GDExtensionVariantType type) {
  switch (type) {
    case GDEXTENSION_VARIANT_TYPE_STRING:
      return "string";
    case GDEXTENSION_VARIANT_TYPE_STRING_NAME:
      return "string_name";
    case GDEXTENSION_VARIANT_TYPE_NODE_PATH:
      return "node_path";
    case GDEXTENSION_VARIANT_TYPE_OBJECT:
      return "object";
    case GDEXTENSION_VARIANT_TYPE_CALLABLE:
      return "callable";
    case GDEXTENSION_VARIANT_TYPE_SIGNAL:
      return "signal";
    case GDEXTENSION_VARIANT_TYPE_DICTIONARY:
      return "dictionary";
    case GDEXTENSION_VARIANT_TYPE_ARRAY:
      return "array";
    case GDEXTENSION_VARIANT_TYPE_PACKED_BYTE_ARRAY:
      return "packed_byte_array";
    case GDEXTENSION_VARIANT_TYPE_PACKED_STRING_ARRAY:
      return "packed_string_array";
    default:
      return "unknown";
  }
}

// Length-then-fill UTF-8 read of a String the caller already owns (the pattern
// `call_string_getter`, iface.cpp, uses for a method bind's return). A generous cap guards
// against a garbage pointer without truncating any real shader source.
std::string utf8_from_raw_string(const void *string_ptr) {
  if (string_ptr == nullptr || g_iface.string_to_utf8_chars == nullptr) {
    return std::string();
  }
  const GDExtensionInt needed = g_iface.string_to_utf8_chars(string_ptr, nullptr, 0);
  constexpr GDExtensionInt kMaxChars = 64 * 1024 * 1024;
  if (needed <= 0 || needed > kMaxChars) {
    return std::string();
  }
  std::vector<char> buffer(static_cast<size_t>(needed) + 1, '\0');
  const GDExtensionInt written = g_iface.string_to_utf8_chars(string_ptr, buffer.data(), needed);
  if (written <= 0) {
    return std::string();
  }
  return std::string(buffer.data(), static_cast<size_t>(written));
}

// PM5: an Array's packed form (rs_variant.h `array_form`). The Array is read through
// array_operator_index_const and Array.size() (the builtin method rs_adopt.cpp uses); nothing in
// the caller's Variant is modified.
void decode_array_form(const void *variant_ptr, DecodedParam *out) {
  if (g_iface.array_operator_index_const == nullptr ||
      g_iface.variant_get_ptr_builtin_method == nullptr || g_iface.variant_get_type == nullptr) {
    return;
  }
  alignas(8) unsigned char array[16] = {};  // Array is one pointer (ArrayPrivate *)
  if (!construct_concrete(GDEXTENSION_VARIANT_TYPE_ARRAY, variant_ptr, &array)) {
    return;
  }
  static GDExtensionPtrBuiltInMethod size_fn = nullptr;
  if (size_fn == nullptr) {
    // StringName("size") through the String constructor is what rs_adopt does; here the
    // interface's string_name_new_with_latin1_chars keeps it self-contained.
    if (g_iface.string_name_new_with_latin1_chars != nullptr) {
      alignas(8) unsigned char name[8] = {};
      g_iface.string_name_new_with_latin1_chars(name, "size", 1);
      size_fn = g_iface.variant_get_ptr_builtin_method(GDEXTENSION_VARIANT_TYPE_ARRAY, name,
                                                       3173160232LL);
    }
  }
  std::int64_t n = 0;
  if (size_fn != nullptr) {
    size_fn(array, nullptr, &n, 0);
  }
  out->array_n = n;  // read only under array_form, and by the hooks' PM7 census
  enum Kind { kNone, kInt, kFloat, kV2, kV3, kV4, kColor, kMixed };
  Kind kind = kNone;
  std::vector<double> f;
  bool any_float = false;
  for (std::int64_t i = 0; i < n && kind != kMixed; ++i) {
    const void *element = g_iface.array_operator_index_const(array, i);
    if (element == nullptr) {
      kind = kMixed;
      break;
    }
    const GDExtensionVariantType t = g_iface.variant_get_type(element);
    {
      // PM7: the element types, for the hook's evidence census.
      const char *name = t == GDEXTENSION_VARIANT_TYPE_BOOL      ? "bool"
                         : t == GDEXTENSION_VARIANT_TYPE_INT     ? "int"
                         : t == GDEXTENSION_VARIANT_TYPE_FLOAT   ? "float"
                         : t == GDEXTENSION_VARIANT_TYPE_VECTOR2 ? "vector2"
                         : t == GDEXTENSION_VARIANT_TYPE_VECTOR3 ? "vector3"
                         : t == GDEXTENSION_VARIANT_TYPE_VECTOR4 ? "vector4"
                         : t == GDEXTENSION_VARIANT_TYPE_COLOR   ? "color"
                         : t == GDEXTENSION_VARIANT_TYPE_NIL     ? "nil"
                                                                 : unsupported_type_name(t);
      const std::string token = std::string(",") + name + ",";
      if ((std::string(",") + out->array_elements + ",").find(token) == std::string::npos) {
        out->array_elements += (out->array_elements.empty() ? "" : ",") + std::string(name);
      }
    }
    DecodedParam one = decode_variant(element);
    Kind k = kMixed;
    if (one.status == "ok" && !one.packed) {
      if (t == GDEXTENSION_VARIANT_TYPE_BOOL || t == GDEXTENSION_VARIANT_TYPE_INT) {
        k = kInt;
      } else if (t == GDEXTENSION_VARIANT_TYPE_FLOAT) {
        k = kInt;  // numeric; any float makes the whole array float64
        any_float = true;
      } else if (t == GDEXTENSION_VARIANT_TYPE_VECTOR2) {
        k = kV2;
      } else if (t == GDEXTENSION_VARIANT_TYPE_VECTOR3) {
        k = kV3;
      } else if (t == GDEXTENSION_VARIANT_TYPE_VECTOR4) {
        k = kV4;
      } else if (t == GDEXTENSION_VARIANT_TYPE_COLOR) {
        k = kColor;
      }
    }
    if (kind == kNone) {
      kind = k;
    } else if (kind != k) {
      kind = kMixed;
    }
    f.insert(f.end(), one.f.begin(), one.f.end());
  }
  destroy_concrete(GDEXTENSION_VARIANT_TYPE_ARRAY, &array);
  if (n <= 0 || kind == kNone || kind == kMixed) {
    return;
  }
  const char *type_name = nullptr;
  switch (kind) {
    case kInt:
      if (!any_float) {
        for (double v : f) {
          if (v > 2147483647.0 || v < -2147483648.0) {
            return;  // outside PackedInt32Array: stays param-type
          }
        }
      }
      type_name = any_float ? "float64" : "int32";
      break;
    case kV2: type_name = "vector2"; break;
    case kV3: type_name = "vector3"; break;
    case kV4: type_name = "vector4"; break;
    case kColor: type_name = "color"; break;
    default: return;
  }
  out->array_form = true;
  out->array_type = type_name;
  out->array_n = n;
  out->array_f = std::move(f);
}

}  // namespace

DecodedParam decode_variant(const void *variant_ptr) {
  DecodedParam out;
  if (variant_ptr == nullptr || g_iface.variant_get_type == nullptr) {
    out.type = "nil";
    out.n = 1;
    return out;
  }
  const GDExtensionVariantType type = g_iface.variant_get_type(variant_ptr);
  switch (type) {
    case GDEXTENSION_VARIANT_TYPE_NIL:
      out.type = "nil";
      out.n = 1;
      return out;
    case GDEXTENSION_VARIANT_TYPE_RID: {
      RID value{};
      if (!construct_concrete(type, variant_ptr, &value)) {
        out.status = "unsupported";
        out.reason = "decode-unavailable";
        return out;
      }
      out.type = "rid";
      out.n = 1;
      out.tex_rid = value.id;
      destroy_concrete(type, &value);
      return out;
    }
    case GDEXTENSION_VARIANT_TYPE_BOOL: {
      GDExtensionBool value = 0;
      if (!construct_concrete(type, variant_ptr, &value)) {
        out.status = "unsupported";
        out.reason = "decode-unavailable";
        return out;
      }
      out.type = "bool";
      out.n = 1;
      out.f.push_back(value != 0 ? 1.0 : 0.0);
      destroy_concrete(type, &value);
      return out;
    }
    case GDEXTENSION_VARIANT_TYPE_INT: {
      GDExtensionInt value = 0;
      if (!construct_concrete(type, variant_ptr, &value)) {
        out.status = "unsupported";
        out.reason = "decode-unavailable";
        return out;
      }
      destroy_concrete(type, &value);
      out.type = "int";
      if (value > kMaxExactInt || value < -kMaxExactInt) {
        out.status = "unsupported";
        out.reason = "param-range";
        out.n = 0;
        return out;
      }
      out.n = 1;
      out.f.push_back(static_cast<double>(value));
      return out;
    }
    case GDEXTENSION_VARIANT_TYPE_FLOAT:
      decode_scalar<double>(type, variant_ptr, "float", &out);
      return out;
    case GDEXTENSION_VARIANT_TYPE_VECTOR2:
      decode_scalar<Vector2>(type, variant_ptr, "vector2", &out);
      return out;
    case GDEXTENSION_VARIANT_TYPE_VECTOR2I:
      decode_scalar<Vector2i>(type, variant_ptr, "vector2i", &out);
      return out;
    case GDEXTENSION_VARIANT_TYPE_RECT2:
      decode_scalar<Rect2>(type, variant_ptr, "rect2", &out);
      return out;
    case GDEXTENSION_VARIANT_TYPE_RECT2I:
      decode_scalar<Rect2i>(type, variant_ptr, "rect2i", &out);
      return out;
    case GDEXTENSION_VARIANT_TYPE_VECTOR3:
      decode_scalar<Vector3>(type, variant_ptr, "vector3", &out);
      return out;
    case GDEXTENSION_VARIANT_TYPE_VECTOR3I:
      decode_scalar<Vector3i>(type, variant_ptr, "vector3i", &out);
      return out;
    case GDEXTENSION_VARIANT_TYPE_TRANSFORM2D:
      decode_scalar<Transform2D>(type, variant_ptr, "transform2d", &out);
      return out;
    case GDEXTENSION_VARIANT_TYPE_VECTOR4:
      decode_scalar<Vector4>(type, variant_ptr, "vector4", &out);
      return out;
    case GDEXTENSION_VARIANT_TYPE_VECTOR4I:
      decode_scalar<Vector4i>(type, variant_ptr, "vector4i", &out);
      return out;
    case GDEXTENSION_VARIANT_TYPE_PLANE:
      decode_scalar<Plane>(type, variant_ptr, "plane", &out);
      return out;
    case GDEXTENSION_VARIANT_TYPE_QUATERNION:
      decode_scalar<Quaternion>(type, variant_ptr, "quaternion", &out);
      return out;
    case GDEXTENSION_VARIANT_TYPE_AABB:
      decode_scalar<AABB>(type, variant_ptr, "aabb", &out);
      return out;
    case GDEXTENSION_VARIANT_TYPE_BASIS:
      decode_scalar<Basis>(type, variant_ptr, "basis", &out);
      return out;
    case GDEXTENSION_VARIANT_TYPE_TRANSFORM3D:
      decode_scalar<Transform3D>(type, variant_ptr, "transform3d", &out);
      return out;
    case GDEXTENSION_VARIANT_TYPE_PROJECTION:
      decode_scalar<Projection>(type, variant_ptr, "projection", &out);
      return out;
    case GDEXTENSION_VARIANT_TYPE_COLOR:
      decode_scalar<Color>(type, variant_ptr, "color", &out);
      return out;
    case GDEXTENSION_VARIANT_TYPE_PACKED_INT32_ARRAY:
      decode_packed<int32_t>(type, variant_ptr, "int32", &out);
      return out;
    case GDEXTENSION_VARIANT_TYPE_PACKED_INT64_ARRAY:
      decode_packed<int64_t>(type, variant_ptr, "int64", &out);
      return out;
    case GDEXTENSION_VARIANT_TYPE_PACKED_FLOAT32_ARRAY:
      decode_packed<float>(type, variant_ptr, "float32", &out);
      return out;
    case GDEXTENSION_VARIANT_TYPE_PACKED_FLOAT64_ARRAY:
      decode_packed<double>(type, variant_ptr, "float64", &out);
      return out;
    case GDEXTENSION_VARIANT_TYPE_PACKED_VECTOR2_ARRAY:
      decode_packed<Vector2>(type, variant_ptr, "vector2", &out);
      return out;
    case GDEXTENSION_VARIANT_TYPE_PACKED_VECTOR3_ARRAY:
      decode_packed<Vector3>(type, variant_ptr, "vector3", &out);
      return out;
    case GDEXTENSION_VARIANT_TYPE_PACKED_VECTOR4_ARRAY:
      decode_packed<Vector4>(type, variant_ptr, "vector4", &out);
      return out;
    case GDEXTENSION_VARIANT_TYPE_PACKED_COLOR_ARRAY:
      decode_packed<Color>(type, variant_ptr, "color", &out);
      return out;
    case GDEXTENSION_VARIANT_TYPE_ARRAY:
      out.type = "array";
      out.status = "unsupported";
      out.reason = "param-type";
      out.n = 0;
      decode_array_form(variant_ptr, &out);  // PM5: the packed form /12 carries
      return out;
    default:
      out.type = unsupported_type_name(type);
      out.status = "unsupported";
      out.reason = "param-type";
      out.n = 0;
      return out;
  }
}

std::string decode_string_name(const void *string_name_ptr) {
  if (string_name_ptr == nullptr || g_iface.variant_get_ptr_constructor == nullptr) {
    return std::string();
  }
  const GDExtensionPtrConstructor ctor = g_iface.variant_get_ptr_constructor(
      GDEXTENSION_VARIANT_TYPE_STRING, kStringFromStringNameConstructor);
  if (ctor == nullptr) {
    return std::string();
  }
  RawString raw;
  const GDExtensionConstTypePtr args[1] = {string_name_ptr};
  ctor(&raw, args);
  const std::string text = utf8_from_raw_string(&raw);
  destroy_concrete(GDEXTENSION_VARIANT_TYPE_STRING, &raw);
  return text;
}

std::string decode_string(const void *string_ptr) { return utf8_from_raw_string(string_ptr); }

}  // namespace rs
}  // namespace grc
