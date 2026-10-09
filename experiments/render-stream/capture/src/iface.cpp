#include "iface.h"

#include <cstring>
#include <vector>

namespace grc {

Iface g_iface;

namespace {

template <typename T>
bool bind_one(GDExtensionInterfaceGetProcAddress get_proc_address, const char *name, T *slot) {
  *slot = reinterpret_cast<T>(get_proc_address(name));
  if (*slot == nullptr) {
    if (g_iface.missing.empty()) {
      g_iface.missing = name;
    }
    return false;
  }
  return true;
}

}  // namespace

bool iface_load(GDExtensionInterfaceGetProcAddress get_proc_address,
                GDExtensionClassLibraryPtr library) {
  g_iface = Iface();
  g_iface.library = library;
  bool ok = true;
  ok &= bind_one(get_proc_address, "get_godot_version2", &g_iface.get_godot_version2);
  ok &= bind_one(get_proc_address, "global_get_singleton", &g_iface.global_get_singleton);
  ok &= bind_one(get_proc_address, "classdb_get_method_bind", &g_iface.classdb_get_method_bind);
  ok &= bind_one(get_proc_address, "object_method_bind_ptrcall",
                 &g_iface.object_method_bind_ptrcall);
  ok &= bind_one(get_proc_address, "string_name_new_with_latin1_chars",
                 &g_iface.string_name_new_with_latin1_chars);
  ok &= bind_one(get_proc_address, "string_new_with_utf8_chars",
                 &g_iface.string_new_with_utf8_chars);
  ok &= bind_one(get_proc_address, "string_to_utf8_chars", &g_iface.string_to_utf8_chars);
  ok &= bind_one(get_proc_address, "variant_get_ptr_destructor",
                 &g_iface.variant_get_ptr_destructor);
  ok &= bind_one(get_proc_address, "register_main_loop_callbacks",
                 &g_iface.register_main_loop_callbacks);
  g_iface.complete = ok;
  return ok;
}

StringName::StringName(const char *latin1) {
  if (g_iface.string_name_new_with_latin1_chars == nullptr) {
    return;
  }
  g_iface.string_name_new_with_latin1_chars(&opaque_, latin1, /*p_is_static=*/false);
  valid_ = true;
}

StringName::~StringName() {
  if (!valid_ || g_iface.variant_get_ptr_destructor == nullptr) {
    return;
  }
  GDExtensionPtrDestructor destructor =
      g_iface.variant_get_ptr_destructor(GDEXTENSION_VARIANT_TYPE_STRING_NAME);
  if (destructor != nullptr) {
    destructor(&opaque_);
  }
}

GDExtensionMethodBindPtr method_bind(const char *class_name, const char *method_name,
                                     int64_t hash) {
  if (g_iface.classdb_get_method_bind == nullptr) {
    return nullptr;
  }
  StringName klass(class_name);
  StringName method(method_name);
  return g_iface.classdb_get_method_bind(klass.ptr(), method.ptr(),
                                         static_cast<GDExtensionInt>(hash));
}

bool call_int_getter(GDExtensionMethodBindPtr bind, void *instance, int64_t *out) {
  if (bind == nullptr || instance == nullptr || g_iface.object_method_bind_ptrcall == nullptr) {
    return false;
  }
  int64_t value = 0;
  g_iface.object_method_bind_ptrcall(bind, instance, nullptr, &value);
  *out = value;
  return true;
}

bool call_string_getter(GDExtensionMethodBindPtr bind, void *instance, std::string *out) {
  if (bind == nullptr || instance == nullptr || g_iface.object_method_bind_ptrcall == nullptr ||
      g_iface.string_new_with_utf8_chars == nullptr || g_iface.string_to_utf8_chars == nullptr ||
      g_iface.variant_get_ptr_destructor == nullptr) {
    return false;
  }
  // Godot's ptrcall return encoding assigns into an existing String, so one has
  // to be constructed before the call and destroyed after it.
  void *opaque = nullptr;
  g_iface.string_new_with_utf8_chars(&opaque, "");
  g_iface.object_method_bind_ptrcall(bind, instance, nullptr, &opaque);
  GDExtensionInt needed = g_iface.string_to_utf8_chars(&opaque, nullptr, 0);
  std::string text;
  if (needed > 0 && needed < (1 << 16)) {
    std::vector<char> buffer(static_cast<size_t>(needed) + 1, '\0');
    GDExtensionInt written = g_iface.string_to_utf8_chars(&opaque, buffer.data(), needed);
    if (written > 0) {
      text.assign(buffer.data(), static_cast<size_t>(written));
    }
  }
  GDExtensionPtrDestructor destructor =
      g_iface.variant_get_ptr_destructor(GDEXTENSION_VARIANT_TYPE_STRING);
  if (destructor != nullptr) {
    destructor(&opaque);
  }
  *out = text;
  return true;
}

void *singleton_object(const char *name) {
  if (g_iface.global_get_singleton == nullptr) {
    return nullptr;
  }
  StringName sn(name);
  return g_iface.global_get_singleton(sn.ptr());
}

std::string singleton_string(const char *singleton, const char *class_name,
                             const char *method_name, int64_t hash) {
  void *instance = singleton_object(singleton);
  if (instance == nullptr) {
    return std::string();
  }
  GDExtensionMethodBindPtr bind = method_bind(class_name, method_name, hash);
  if (bind == nullptr) {
    return std::string();
  }
  std::string text;
  if (!call_string_getter(bind, instance, &text)) {
    return std::string();
  }
  return text;
}

}  // namespace grc
