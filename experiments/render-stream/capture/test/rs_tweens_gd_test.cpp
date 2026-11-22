// Exercise native Variant decoding through the registered capture API, without an engine.
#include "rs_capture_gd.h"
#include "abi.h"
#include "iface.h"
#include <cstdio>
#include <cstring>
#include <map>

namespace {
using Type = GDExtensionVariantType;
struct Variant {
  Type type = GDEXTENSION_VARIANT_TYPE_NIL;
  const void *value = nullptr;
  std::int64_t index = 0;
};
using Dict = std::map<std::string, Variant>;
using Array = std::vector<Variant>;
GDExtensionClassMethodInfo begin_method{};
bool vector3_bound = false, vector4_bound = false;
const char *name(const void *p) { return *static_cast<const char *const *>(p); }
void destroy(void *) {}
void construct(Type type, void *out, const void *const *, int32_t, GDExtensionCallError *error) {
  *static_cast<Variant *>(out) = {type};
  error->error = GDEXTENSION_CALL_OK;
}
template<Type T> void from(void *out, void *value) { *static_cast<Variant *>(out) = {T, value}; }
template<class T> void to(void *out, void *value) {
  *static_cast<T *>(out) = *static_cast<const T *>(static_cast<Variant *>(value)->value);
}
void to_handle(void *out, void *value) {
  *static_cast<const void **>(out) = static_cast<Variant *>(value)->value;
}
GDExtensionBool iter_init(const void *value, void *it, GDExtensionBool *valid) {
  *static_cast<Variant *>(it) = {};
  *valid = true;
  const auto &v = *static_cast<const Variant *>(value);
  return v.value && (v.type == GDEXTENSION_VARIANT_TYPE_DICTIONARY
    ? !static_cast<const Dict *>(v.value)->empty() : !static_cast<const Array *>(v.value)->empty());
}
GDExtensionBool iter_next(const void *value, void *it, GDExtensionBool *valid) {
  *valid = true;
  const auto &v = *static_cast<const Variant *>(value);
  const auto i = ++static_cast<Variant *>(it)->index;
  return static_cast<std::size_t>(i) < (v.type == GDEXTENSION_VARIANT_TYPE_DICTIONARY
    ? static_cast<const Dict *>(v.value)->size() : static_cast<const Array *>(v.value)->size());
}
void iter_get(const void *value, void *it, void *out, GDExtensionBool *valid) {
  *valid = true;
  const auto &v = *static_cast<const Variant *>(value);
  const auto i = static_cast<Variant *>(it)->index;
  if (v.type == GDEXTENSION_VARIANT_TYPE_ARRAY) {
    *static_cast<Variant *>(out) = static_cast<const Array *>(v.value)->at(i);
  } else {
    auto entry = static_cast<const Dict *>(v.value)->begin();
    std::advance(entry, i);
    *static_cast<Variant *>(out) = {GDEXTENSION_VARIANT_TYPE_STRING, entry->first.c_str()};
  }
}
GDExtensionInterfaceFunctionPtr proc(const char *symbol) {
#define BIND(symbol_name, fn) if (!std::strcmp(symbol, symbol_name)) return reinterpret_cast<GDExtensionInterfaceFunctionPtr>(+fn)
  BIND("classdb_register_extension_class4", [](void *, const void *, const void *, const GDExtensionClassCreationInfo4 *) {});
  BIND("classdb_register_extension_class_method", [](void *, const void *, const GDExtensionClassMethodInfo *m) {
    if (!std::strcmp(name(m->name), "tween_begin")) begin_method = *m;
  });
  BIND("classdb_register_extension_class_signal", [](void *, const void *, const void *, const GDExtensionPropertyInfo *, GDExtensionInt) {});
  BIND("classdb_unregister_extension_class", [](void *, const void *) {});
  BIND("object_set_instance", [](void *, const void *, void *) {});
  BIND("variant_get_type", [](const void *v) { return static_cast<const Variant *>(v)->type; });
  BIND("variant_iter_init", iter_init);
  BIND("variant_iter_next", iter_next);
  BIND("variant_iter_get", iter_get);
  BIND("variant_get_keyed", [](const void *v, const void *k, void *out, GDExtensionBool *valid) {
    *valid = true;
    const auto &dict = *static_cast<const Dict *>(static_cast<const Variant *>(v)->value);
    *static_cast<Variant *>(out) = dict.at(static_cast<const char *>(static_cast<const Variant *>(k)->value));
  });
  BIND("variant_set_keyed", [](void *, const void *, const void *, GDExtensionBool *) {});
  BIND("variant_construct", construct);
  BIND("variant_call", [](void *, const void *, const void *const *, GDExtensionInt, void *, GDExtensionCallError *) {});
  BIND("string_new_with_utf8_chars_and_len2", [](void *out, const char *text, GDExtensionInt n) -> GDExtensionInt {
    *static_cast<const char **>(out) = text; return n;
  });
#undef BIND
  return nullptr;
}
}

namespace grc {
Iface g_iface;
bool g_root_finalized = false;
StringName::StringName(const char *text) { opaque_ = const_cast<char *>(text); valid_ = true; }
StringName::~StringName() {}
GDExtensionMethodBindPtr method_bind(const char *, const char *, std::int64_t) { return &begin_method; }
void *singleton_object(const char *) { return &begin_method; }
}

int main() {
  using namespace grc;
  using namespace grc::rs;
  int checks = 0, failures = 0;
  const auto check = [&](bool ok, const char *what) {
    ++checks;
    if (!ok) { ++failures; std::printf("FAIL tween bridge: %s\n", what); }
  };
  g_iface.library = &begin_method;
  g_iface.get_proc_address = proc;
  g_iface.variant_destroy = destroy;
  g_iface.get_variant_from_type_constructor = [](Type t) -> GDExtensionVariantFromTypeConstructorFunc {
    return t == GDEXTENSION_VARIANT_TYPE_DICTIONARY ? from<GDEXTENSION_VARIANT_TYPE_DICTIONARY> : from<GDEXTENSION_VARIANT_TYPE_NIL>;
  };
  g_iface.get_variant_to_type_constructor = [](Type t) -> GDExtensionTypeFromVariantConstructorFunc {
    if (t == GDEXTENSION_VARIANT_TYPE_VECTOR3) { vector3_bound = true; return to<grc::Vector3>; }
    if (t == GDEXTENSION_VARIANT_TYPE_VECTOR4) { vector4_bound = true; return to<grc::Vector4>; }
    if (t == GDEXTENSION_VARIANT_TYPE_INT) return to<std::int64_t>;
    return to_handle;
  };
  g_iface.variant_get_ptr_destructor = [](Type) { return destroy; };
  g_iface.classdb_construct_object2 = [](const void *) -> void * { return &begin_method; };
  g_iface.object_destroy = destroy;
  g_iface.object_method_bind_call = [](const void *, void *, const void *const *, GDExtensionInt, void *, GDExtensionCallError *) {};
  g_iface.object_method_bind_ptrcall = [](const void *, void *, const void *const *, void *) {};
  g_iface.string_to_utf8_chars = [](const void *s, char *out, GDExtensionInt n) -> GDExtensionInt {
    const auto text = name(s);
    if (out) std::memcpy(out, text, static_cast<std::size_t>(n));
    return static_cast<GDExtensionInt>(std::strlen(text));
  };
  g_iface.string_name_new_with_latin1_chars = [](void *, const char *, GDExtensionBool) {};
  g_iface.global_get_singleton = [](const void *) -> void * { return &begin_method; };
  g_iface.classdb_get_method_bind = [](const void *, const void *, GDExtensionInt) -> const void * { return &begin_method; };
  tweens::Value decoded;
  bool enabled = true;
  std::string why;
  check(capture::gd_capture_register({}, false, &why,
    [&](const std::string &method, const tweens::Value &v) { check(method == "tween_begin", "begin method dispatched"); decoded = v; },
    [&] { return enabled; }), "capture API registers");
  check(vector3_bound && vector4_bound, "Vector3 and Vector4 native conversions available to announced endpoints");
  // Keep the red regression diagnostic instead of calling a missing function pointer.
  if (vector3_bound && vector4_bound) {
    grc::Vector3 v3{1.25f, -2.5f, 3.75f};
    grc::Vector4 v4{-4.5f, 5.25f, -6.75f, 7.5f};
    const Dict step3{{"from", {GDEXTENSION_VARIANT_TYPE_VECTOR3, &v3}}, {"to", {GDEXTENSION_VARIANT_TYPE_VECTOR4, &v4}}};
    const Array steps{{GDEXTENSION_VARIANT_TYPE_DICTIONARY, &step3}};
    const Dict announcement{{"steps", {GDEXTENSION_VARIANT_TYPE_ARRAY, &steps}}};
    const Variant input{GDEXTENSION_VARIANT_TYPE_DICTIONARY, &announcement};
    const void *args[]{&input};
    Variant result;
    GDExtensionCallError error{};
    const auto endpoints = [&] {
      const auto &step = std::get<tweens::Value::Object>(std::get<tweens::Value::Array>(
        std::get<tweens::Value::Object>(decoded.data).at("steps").data).at(0).data);
      const auto a = std::get<tweens::Vector3>(step.at("from").data);
      const auto b = std::get<tweens::Vector4>(step.at("to").data);
      return a.x == v3.x && a.y == v3.y && a.z == v3.z && b.x == v4.x && b.y == v4.y && b.z == v4.z && b.w == v4.w;
    };
    begin_method.call_func(begin_method.method_userdata, nullptr, args, 1, &result, &error);
    check(error.error == GDEXTENSION_CALL_OK && endpoints(), "varcall preserves nested Vector3/Vector4 components");
    const void *native_args[]{&announcement};
    begin_method.ptrcall_func(begin_method.method_userdata, nullptr, native_args, nullptr);
    check(endpoints(), "ptrcall preserves nested Vector3/Vector4 components");
    enabled = false;
    decoded = {};
    begin_method.call_func(begin_method.method_userdata, nullptr, args, 1, &result, &error);
    check(std::holds_alternative<std::monostate>(decoded.data), "disabled tween bridge skips decoding and dispatch");
  }
  capture::gd_capture_unregister();
  std::printf("rs_tweens_gd: %d checks, %d failures\n", checks, failures);
  return failures ? 1 : 0;
}
