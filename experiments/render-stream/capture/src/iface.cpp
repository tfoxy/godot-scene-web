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
  // Optional (see iface.h): a miss is not recorded in `missing`.
  g_iface.ref_get_object =
      reinterpret_cast<GDExtensionInterfaceRefGetObject>(get_proc_address("ref_get_object"));
  g_iface.ref_set_object =
      reinterpret_cast<GDExtensionInterfaceRefSetObject>(get_proc_address("ref_set_object"));
  g_iface.classdb_get_class_tag = reinterpret_cast<GDExtensionInterfaceClassdbGetClassTag>(
      get_proc_address("classdb_get_class_tag"));
  g_iface.object_cast_to =
      reinterpret_cast<GDExtensionInterfaceObjectCastTo>(get_proc_address("object_cast_to"));
  g_iface.image_ptr =
      reinterpret_cast<GDExtensionInterfaceImagePtr>(get_proc_address("image_ptr"));
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

bool call_object_getter(GDExtensionMethodBindPtr bind, void *instance, void **out) {
  if (bind == nullptr || instance == nullptr || g_iface.object_method_bind_ptrcall == nullptr) {
    return false;
  }
  void *object = nullptr;
  g_iface.object_method_bind_ptrcall(bind, instance, nullptr, &object);
  *out = object;
  return true;
}

bool call_rid_getter(GDExtensionMethodBindPtr bind, void *instance, uint64_t *out) {
  return call_value_getter(bind, instance, out, sizeof(uint64_t));
}

bool call_value_getter(GDExtensionMethodBindPtr bind, void *instance, void *out, size_t size) {
  if (bind == nullptr || instance == nullptr || g_iface.object_method_bind_ptrcall == nullptr ||
      size > 64) {
    return false;
  }
  // Aligned scratch the size of the largest value read here, so a callee that
  // writes its full type never writes past the caller's object.
  alignas(16) unsigned char scratch[64] = {};
  g_iface.object_method_bind_ptrcall(bind, instance, nullptr, scratch);
  std::memcpy(out, scratch, size);
  return true;
}

bool call_void_vector2i(GDExtensionMethodBindPtr bind, void *instance, int32_t x, int32_t y) {
  if (bind == nullptr || instance == nullptr || g_iface.object_method_bind_ptrcall == nullptr) {
    return false;
  }
  // core/math/vector2i.h: struct Vector2i { int32_t x, y; } (8 bytes).
  alignas(8) int32_t value[2] = {x, y};
  const GDExtensionConstTypePtr args[1] = {value};
  // A void method writes nothing to r_ret; a scratch slot keeps that true even
  // if a future engine returned a value.
  alignas(16) unsigned char scratch[64] = {};
  g_iface.object_method_bind_ptrcall(bind, instance, args, scratch);
  return true;
}

RefHolder::~RefHolder() { release(); }

bool RefHolder::call(GDExtensionMethodBindPtr bind, void *instance) {
  release();
  if (bind == nullptr || instance == nullptr || g_iface.object_method_bind_ptrcall == nullptr ||
      g_iface.ref_get_object == nullptr || g_iface.ref_set_object == nullptr) {
    return false;
  }
  slot_ = nullptr;
  g_iface.object_method_bind_ptrcall(bind, instance, nullptr, &slot_);
  filled_ = true;
  return true;
}

void *RefHolder::object() const {
  if (!filled_ || g_iface.ref_get_object == nullptr) {
    return nullptr;
  }
  return g_iface.ref_get_object(&slot_);
}

void RefHolder::release() {
  if (filled_ && g_iface.ref_set_object != nullptr) {
    g_iface.ref_set_object(&slot_, nullptr);
  }
  filled_ = false;
  slot_ = nullptr;
}

void *cast_to(void *object, const char *class_name) {
  if (object == nullptr || g_iface.classdb_get_class_tag == nullptr ||
      g_iface.object_cast_to == nullptr) {
    return nullptr;
  }
  StringName name(class_name);
  void *tag = g_iface.classdb_get_class_tag(name.ptr());
  if (tag == nullptr) {
    return nullptr;
  }
  return g_iface.object_cast_to(object, tag);
}

}  // namespace grc
