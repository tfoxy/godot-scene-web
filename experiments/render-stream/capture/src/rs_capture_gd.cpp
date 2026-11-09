#include "rs_capture_gd.h"
#include "iface.h"
#include <cstring>
#include <memory>
#include <utility>

namespace grc::rs::capture {
namespace {
constexpr auto kDictionary = GDEXTENSION_VARIANT_TYPE_DICTIONARY;
constexpr auto kInt = GDEXTENSION_VARIANT_TYPE_INT;
constexpr auto kString = GDEXTENSION_VARIANT_TYPE_STRING;
constexpr auto kArray = GDEXTENSION_VARIANT_TYPE_ARRAY;
constexpr auto kBool = GDEXTENSION_VARIANT_TYPE_BOOL;
constexpr auto kFloat = GDEXTENSION_VARIANT_TYPE_FLOAT;
// Engine and Object method hashes from Godot 4.5.1's extension API dump.
constexpr std::int64_t kRegisterSingleton = 965313290LL;
constexpr std::int64_t kUnregisterSingleton = 3304788590LL;
constexpr std::int64_t kEmitSignal = 4047867050LL;
constexpr const char *kClass = "RenderStreamCapture";
struct alignas(8) Variant { std::uint8_t data[24]; };
struct Fns {
  GDExtensionInterfaceClassdbRegisterExtensionClass4 register_class;
  GDExtensionInterfaceClassdbRegisterExtensionClassMethod register_method;
  GDExtensionInterfaceClassdbRegisterExtensionClassSignal register_signal;
  GDExtensionInterfaceClassdbUnregisterExtensionClass unregister_class;
  GDExtensionInterfaceObjectSetInstance set_instance;
  GDExtensionInterfaceVariantGetType type;
  GDExtensionInterfaceVariantIterInit iter_init;
  GDExtensionInterfaceVariantIterNext iter_next;
  GDExtensionInterfaceVariantIterGet iter_get;
  GDExtensionInterfaceVariantGetKeyed get;
  GDExtensionInterfaceVariantSetKeyed set;
  GDExtensionInterfaceVariantConstruct construct;
  GDExtensionInterfaceVariantCall call;
  GDExtensionInterfaceStringNewWithUtf8CharsAndLen2 string_new;
  GDExtensionVariantFromTypeConstructorFunc from[GDEXTENSION_VARIANT_TYPE_VARIANT_MAX]{};
  GDExtensionTypeFromVariantConstructorFunc to[GDEXTENSION_VARIANT_TYPE_VARIANT_MAX]{};
  GDExtensionPtrDestructor destroy[GDEXTENSION_VARIANT_TYPE_VARIANT_MAX]{};
  GDExtensionMethodBindPtr reg = nullptr, unreg = nullptr, emit = nullptr;
} f;
Invoke g_invoke;
bool g_registered = false;
GDExtensionObjectPtr g_object = nullptr;
struct Var {
  Variant v;
  Var() { GDExtensionCallError e{}; f.construct(GDEXTENSION_VARIANT_TYPE_NIL, &v, nullptr, 0, &e); }
  ~Var() { g_iface.variant_destroy(&v); }
  Var(const Var &) = delete;
  Var &operator=(const Var &) = delete;
};
std::string read_string(GDExtensionConstVariantPtr v) {
  void *s = nullptr;
  f.to[kString](&s, const_cast<void *>(v));
  const auto n = g_iface.string_to_utf8_chars(&s, nullptr, 0);
  std::string out(static_cast<std::size_t>(n), '\0');
  if (n) g_iface.string_to_utf8_chars(&s, out.data(), n);
  f.destroy[kString](&s);
  return out;
}
void write(const Value &value, GDExtensionVariantPtr out) {
  // The caller supplies an empty Variant slot.
  if (auto p = std::get_if<std::int64_t>(&value.data)) f.from[kInt](out, const_cast<std::int64_t *>(p));
  else if (auto p = std::get_if<bool>(&value.data)) {
    GDExtensionBool b = *p; f.from[kBool](out, &b);
  } else if (auto p = std::get_if<double>(&value.data)) f.from[kFloat](out, const_cast<double *>(p));
  else if (auto p = std::get_if<std::string>(&value.data)) {
    void *s = nullptr; f.string_new(&s, p->data(), p->size());
    f.from[kString](out, &s); f.destroy[kString](&s);
  } else if (auto p = std::get_if<Value::Object>(&value.data)) {
    GDExtensionCallError e{}; f.construct(kDictionary, out, nullptr, 0, &e);
    for (const auto &[key, v] : *p) {
      Var k, val; write(key, &k.v); write(v, &val.v);
      GDExtensionBool valid = false; f.set(out, &k.v, &val.v, &valid);
    }
  } else if (auto p = std::get_if<Value::Array>(&value.data)) {
    GDExtensionCallError e{}; f.construct(kArray, out, nullptr, 0, &e);
    StringName append("append");
    for (const auto &v : *p) {
      Var val, ret; write(v, &val.v); const void *args[] = {&val.v};
      f.call(out, append.ptr(), args, 1, &ret.v, &e);
    }
  }
}
Value::Object options(GDExtensionConstVariantPtr v) {
  Value::Object out;
  Var it; GDExtensionBool valid = false;
  for (bool more = f.iter_init(v, &it.v, &valid); more && valid;
       more = f.iter_next(v, &it.v, &valid)) {
    Var key, val; f.iter_get(v, &it.v, &key.v, &valid);
    if (!valid) break;
    // A non-string key is invalid rather than silently ignored or coerced.
    if (f.type(&key.v) != kString) { out["<non-string-key>"] = {}; continue; }
    f.get(v, &key.v, &val.v, &valid);
    Value result;
    if (f.type(&val.v) == kString) result = read_string(&val.v);
    else if (f.type(&val.v) == kInt) {
      std::int64_t n = 0; f.to[kInt](&n, &val.v); result = n;
    }
    out[read_string(&key.v)] = std::move(result);
  }
  return out;
}
struct Method { const char *name; bool state; };
Method methods[] = {{"arm", false}, {"disarm", false}, {"state", true}};
void call(void *data, GDExtensionClassInstancePtr,
          const GDExtensionConstVariantPtr *args, GDExtensionInt argc,
          GDExtensionVariantPtr ret, GDExtensionCallError *error) {
  auto &m = *static_cast<Method *>(data);
  if (argc < 0 || argc > (m.state ? 0 : 1)) {
    error->error = GDEXTENSION_CALL_ERROR_TOO_MANY_ARGUMENTS; return;
  }
  if (argc && f.type(args[0]) != kDictionary) {
    error->error = GDEXTENSION_CALL_ERROR_INVALID_ARGUMENT;
    error->argument = 0; error->expected = kDictionary; return;
  }
  error->error = GDEXTENSION_CALL_OK;
  write(g_invoke(m.name, argc ? options(args[0]) : Value::Object{}), ret);
}
void ptrcall(void *data, GDExtensionClassInstancePtr,
             const GDExtensionConstTypePtr *args, GDExtensionTypePtr ret) {
  auto &m = *static_cast<Method *>(data);
  Var arg;
  if (!m.state) f.from[kDictionary](&arg.v, const_cast<void *>(args[0]));
  Value result = g_invoke(m.name, m.state ? Value::Object{} : options(&arg.v));
  if (m.state) {
    Var value; write(result, &value.v);
    // ptrcall returns into a constructed Dictionary.
    f.destroy[kDictionary](ret); f.to[kDictionary](ret, &value.v);
  } else *static_cast<std::int64_t *>(ret) = std::get<std::int64_t>(result.data);
}
GDExtensionObjectPtr create(void *, GDExtensionBool) {
  StringName parent("Object"), cls(kClass);
  auto object = g_iface.classdb_construct_object2(parent.ptr());
  f.set_instance(object, cls.ptr(), object);
  return object;
}
void free_instance(void *, GDExtensionClassInstancePtr) {}
struct Prop {
  StringName name, cls;
  void *hint = nullptr;
  GDExtensionPropertyInfo info{};
  Prop(GDExtensionVariantType type, const char *text) : name(text), cls("") {
    f.string_new(&hint, "", 0);
    info.type = type; info.name = const_cast<void *>(name.ptr());
    info.class_name = const_cast<void *>(cls.ptr()); info.hint_string = &hint; info.usage = 6;
  }
  ~Prop() { f.destroy[kString](&hint); }
};
template<class T> void resolve(const char *name, T *ptr, std::string *missing) {
  *ptr = reinterpret_cast<T>(g_iface.get_proc_address(name));
  if (!*ptr && missing->empty()) *missing = name;
}
}  // namespace
bool gd_capture_register(Invoke invoke, bool singleton, std::string *why) {
  if (g_registered) return true;
  if (!g_iface.get_proc_address || !g_iface.library ||
      !g_iface.variant_destroy || !g_iface.get_variant_from_type_constructor ||
      !g_iface.get_variant_to_type_constructor || !g_iface.variant_get_ptr_destructor ||
      !g_iface.classdb_construct_object2 || !g_iface.object_destroy ||
      !g_iface.object_method_bind_call || !g_iface.object_method_bind_ptrcall ||
      !g_iface.string_to_utf8_chars || !g_iface.string_name_new_with_latin1_chars ||
      !g_iface.global_get_singleton || !g_iface.classdb_get_method_bind) {
    *why = "capture-class-unavailable: incomplete interface";
    return false;
  }
  std::string missing;
  resolve("classdb_register_extension_class4", &f.register_class, &missing);
  resolve("classdb_register_extension_class_method", &f.register_method, &missing);
  resolve("classdb_register_extension_class_signal", &f.register_signal, &missing);
  resolve("classdb_unregister_extension_class", &f.unregister_class, &missing);
  resolve("object_set_instance", &f.set_instance, &missing);
  resolve("variant_get_type", &f.type, &missing);
  resolve("variant_iter_init", &f.iter_init, &missing);
  resolve("variant_iter_next", &f.iter_next, &missing);
  resolve("variant_iter_get", &f.iter_get, &missing);
  resolve("variant_get_keyed", &f.get, &missing);
  resolve("variant_set_keyed", &f.set, &missing);
  resolve("variant_construct", &f.construct, &missing);
  resolve("variant_call", &f.call, &missing);
  resolve("string_new_with_utf8_chars_and_len2", &f.string_new, &missing);
  if (!missing.empty()) { *why = "capture-class-unavailable: " + missing; return false; }
  for (auto t : {kInt, kBool, kFloat, kString, kDictionary, GDEXTENSION_VARIANT_TYPE_OBJECT,
                 GDEXTENSION_VARIANT_TYPE_STRING_NAME}) {
    f.from[t] = g_iface.get_variant_from_type_constructor(t);
    f.to[t] = g_iface.get_variant_to_type_constructor(t);
    if (!f.from[t] || !f.to[t]) { *why = "capture-class-unavailable: constructor"; return false; }
  }
  for (auto t : {kString, kDictionary}) {
    f.destroy[t] = g_iface.variant_get_ptr_destructor(t);
    if (!f.destroy[t]) { *why = "capture-class-unavailable: destructor"; return false; }
  }
  f.reg = method_bind("Engine", "register_singleton", kRegisterSingleton);
  f.unreg = method_bind("Engine", "unregister_singleton", kUnregisterSingleton);
  f.emit = method_bind("Object", "emit_signal", kEmitSignal);
  if (!f.reg || !f.unreg || !f.emit) { *why = "capture-class-unavailable: method bind"; return false; }
  g_invoke = std::move(invoke);
  StringName cls(kClass), parent("Object");
  GDExtensionClassCreationInfo4 ci{};
  ci.is_exposed = true; ci.create_instance_func = create; ci.free_instance_func = free_instance;
  f.register_class(g_iface.library, cls.ptr(), parent.ptr(), &ci);
  for (auto &m : methods) {
    StringName name(m.name); Prop result(m.state ? kDictionary : kInt, ""), arg(kDictionary, "options");
    GDExtensionClassMethodInfo mi{};
    mi.name = const_cast<void *>(name.ptr()); mi.method_userdata = &m;
    mi.call_func = call; mi.ptrcall_func = ptrcall; mi.method_flags = GDEXTENSION_METHOD_FLAGS_DEFAULT;
    mi.has_return_value = true; mi.return_value_info = &result.info;
    mi.return_value_metadata = m.state ? GDEXTENSION_METHOD_ARGUMENT_METADATA_NONE : GDEXTENSION_METHOD_ARGUMENT_METADATA_INT_IS_INT64;
    GDExtensionClassMethodArgumentMetadata meta = GDEXTENSION_METHOD_ARGUMENT_METADATA_NONE;
    Var default_arg; write(Value::Object{}, &default_arg.v);
    GDExtensionVariantPtr defaults[] = {&default_arg.v};
    if (!m.state) {
      mi.argument_count = 1; mi.arguments_info = &arg.info; mi.arguments_metadata = &meta;
      mi.default_argument_count = 1; mi.default_arguments = defaults;
    }
    f.register_method(g_iface.library, cls.ptr(), &mi);
  }
  for (const char *signal : {"armed", "disarmed", "arm_failed", "stream_ended", "client_connected", "client_left"}) {
    StringName name(signal);
    bool client = std::strncmp(signal, "client_", 7) == 0;
    bool reason = std::strcmp(signal, "arm_failed") == 0 || std::strcmp(signal, "stream_ended") == 0;
    Prop a(client ? kInt : reason ? kString : kDictionary, client ? "connection" : reason ? "reason" : "info");
    Prop b(std::strcmp(signal, "client_left") == 0 ? kString : kDictionary,
           std::strcmp(signal, "client_left") == 0 ? "reason" : "info");
    GDExtensionPropertyInfo props[] = {a.info, b.info};
    f.register_signal(g_iface.library, cls.ptr(), name.ptr(), props, client ? 2 : 1);
  }
  g_registered = true;
  if (singleton) {
    g_object = create(nullptr, false);
    const void *args[] = {cls.ptr(), &g_object};
    g_iface.object_method_bind_ptrcall(f.reg, singleton_object("Engine"), args, nullptr);
  }
  return true;
}
void gd_capture_emit(const Signal &signal) {
  if (g_root_finalized || !g_object) return;
  StringName name(signal.name.c_str()); Var vname, a, b, ret;
  f.from[GDEXTENSION_VARIANT_TYPE_STRING_NAME](&vname.v, const_cast<void *>(name.ptr()));
  const void *args[] = {&vname.v, &a.v, &b.v};
  if (!signal.args.empty()) write(signal.args[0], &a.v);
  if (signal.args.size() > 1) write(signal.args[1], &b.v);
  GDExtensionCallError e{};
  g_iface.object_method_bind_call(f.emit, g_object, args, signal.args.size() + 1, &ret.v, &e);
}
void gd_capture_unregister() {
  if (!g_registered) return;
  StringName cls(kClass);
  if (g_object) {
    const void *args[] = {cls.ptr()};
    g_iface.object_method_bind_ptrcall(f.unreg, singleton_object("Engine"), args, nullptr);
    g_iface.object_destroy(g_object); g_object = nullptr;
  }
  f.unregister_class(g_iface.library, cls.ptr()); g_registered = false; g_invoke = {};
}
}  // namespace grc::rs::capture
