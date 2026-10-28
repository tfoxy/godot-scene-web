// D8 decode: a material parameter's or instance parameter's Variant value, and a parameter
// name's StringName, read through the GDExtension interface alone -- never assumed to be any
// particular C++ class, and never calling into the RenderingServer or taking an engine lock
// (gate5_5-design.md Q2 "Decoding", D8 "Parameter values on the wire").
//
// Each decode is read-only: the Variant/StringName/String argument is the engine's own, owned by
// the caller for the hook's duration, and nothing here holds a reference to it afterwards.
#ifndef GRC_RS_VARIANT_H
#define GRC_RS_VARIANT_H

#include <cstdint>
#include <string>
#include <vector>

namespace grc {
namespace rs {

// D8's wire type name, float64 components and array length for one decoded Variant value.
struct DecodedParam {
  // "nil" | "bool" | "int" | "float" | "vector2" | "vector2i" | "rect2" | "rect2i" | "vector3" |
  // "vector3i" | "transform2d" | "vector4" | "vector4i" | "plane" | "quaternion" | "aabb" |
  // "basis" | "transform3d" | "projection" | "color" | "rid" for a scalar Variant; for a packed
  // numeric array, the element type's own name ("int32" "int64" "float32" "float64" "vector2"
  // "vector3" "vector4" "color") with `n` the array length (D8's eight supported packed types).
  // For anything else, Variant::get_type_name's name lowercased with underscores
  // (e.g. "string", "object", "dictionary", "packed_byte_array") -- descriptive only; `status` is
  // "unsupported" whenever `type` is one of these.
  std::string type;
  // 1 for a scalar, the packed array's element count for a packed array. 0 only when `status` is
  // not "ok" and even `n` could not be determined.
  std::int64_t n = 0;
  // float64 components in Godot's own member order (D8): e.g. transform2d is the three Transform2D
  // columns in order (as render-stream-0.md's Xform), basis is row-major, projection is by column.
  // Empty for "nil" and "rid", and for any status other than "ok".
  std::vector<double> f;
  // Valid iff type == "rid" and status == "ok": the raw RID id (0 for RID(), itself a value, not
  // "absent" -- the caller maps this to the texture table).
  std::uint64_t tex_rid = 0;
  std::string status = "ok";  // "ok" | "unsupported"
  std::string reason;         // "" when ok; "param-type" | "param-range" | "decode-unavailable"
  // True for one of the eight packed numeric arrays (G55d): `type` alone is ambiguous there
  // ("vector2" names both a scalar Vector2 and a PackedVector2Array's element type).
  bool packed = false;
  // PM5 (render-stream-12.md, "param-type"): a plain Array (`type` "array") stays exactly what it
  // was above (unsupported, param-type) so every version below /12 is unchanged; when its elements
  // are all bool/int (in int32 range), all numeric with a float, or all Vector2/Vector3/Vector4/
  // Color, `array_form` is set and `array_type`/`array_n`/`array_f` give the packed array GLES3
  // converts it to for an array uniform (material_storage.cpp, Variant -> Packed*Array): "int32"
  // (bools as 1/0), "float64", "vector2", "vector3", "vector4" or "color". /12's mirror carries
  // that form; an empty or mixed Array has none.
  bool array_form = false;
  std::string array_type;
  std::int64_t array_n = 0;
  std::vector<double> array_f;
};

// Decodes a `const Variant *` the engine passed into a hook argument (D8, Q2). `variant_ptr` may
// be null (treated as NIL).
DecodedParam decode_variant(const void *variant_ptr);

// Converts a `const StringName *` to UTF-8 through the builtin String(StringName) constructor,
// constructor index 2 in STRING's registration order (Q2; core/variant/variant_construct.cpp:
// 79-82). Returns "" when `string_name_ptr` is null or decoding is unavailable.
std::string decode_string_name(const void *string_name_ptr);

// Converts a `const String *` the engine already owns (a shader's code or path hint) to UTF-8
// (Q2). Returns "" when `string_ptr` is null, the string is empty, or decoding is unavailable.
std::string decode_string(const void *string_ptr);

}  // namespace rs
}  // namespace grc

#endif  // GRC_RS_VARIANT_H
