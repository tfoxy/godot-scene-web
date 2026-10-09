// Bindings to the subset of the GDExtension C interface this library uses,
// plus the small method-bind helpers that let it ask the engine questions
// without ever calling an unidentified vtable slot.

#pragma once

#include <cstdint>
#include <string>

#include "gdextension_interface.h"

namespace grc {

class StringName;

struct Iface {
  GDExtensionClassLibraryPtr library = nullptr;
  GDExtensionInterfaceGetGodotVersion2 get_godot_version2 = nullptr;
  GDExtensionInterfaceGlobalGetSingleton global_get_singleton = nullptr;
  GDExtensionInterfaceClassdbGetMethodBind classdb_get_method_bind = nullptr;
  GDExtensionInterfaceObjectMethodBindPtrcall object_method_bind_ptrcall = nullptr;
  GDExtensionInterfaceStringNameNewWithLatin1Chars string_name_new_with_latin1_chars = nullptr;
  GDExtensionInterfaceStringNewWithUtf8Chars string_new_with_utf8_chars = nullptr;
  GDExtensionInterfaceStringToUtf8Chars string_to_utf8_chars = nullptr;
  GDExtensionInterfaceVariantGetPtrDestructor variant_get_ptr_destructor = nullptr;
  GDExtensionInterfaceRegisterMainLoopCallbacks register_main_loop_callbacks = nullptr;

  // True when every pointer above resolved.
  bool complete = false;
  // Name of the first interface function that failed to resolve, if any.
  std::string missing;
};

extern Iface g_iface;

// Resolves the interface functions. Returns false (and fills `g_iface.missing`)
// if the host does not provide one of them.
bool iface_load(GDExtensionInterfaceGetProcAddress get_proc_address,
                GDExtensionClassLibraryPtr library);

// Scoped StringName, destroyed through the engine's own destructor.
class StringName {
 public:
  explicit StringName(const char *latin1);
  ~StringName();
  StringName(const StringName &) = delete;
  StringName &operator=(const StringName &) = delete;

  GDExtensionConstStringNamePtr ptr() const { return &opaque_; }

 private:
  mutable void *opaque_ = nullptr;
  bool valid_ = false;
};

// Looks up a ClassDB method bind. Returns nullptr when the engine does not have
// that method at that hash; callers treat that as a refusal, never a crash.
GDExtensionMethodBindPtr method_bind(const char *class_name, const char *method_name,
                                     int64_t hash);

// `int64_t`-returning ptrcall on a bound method with no arguments. Godot's
// ptrcall encodes every integer and enum return as int64_t.
bool call_int_getter(GDExtensionMethodBindPtr bind, void *instance, int64_t *out);

// String-returning ptrcall on a bound method with no arguments. The engine
// assigns into an already-constructed String, so one is constructed here first
// and destroyed afterwards.
bool call_string_getter(GDExtensionMethodBindPtr bind, void *instance, std::string *out);

// Convenience: look up `class_name::method_name` and call it as a string getter
// on `instance`. Returns an empty string when anything is unavailable.
std::string singleton_string(const char *singleton, const char *class_name,
                             const char *method_name, int64_t hash);

// The engine singleton object, or nullptr when it is not registered yet.
void *singleton_object(const char *name);

}  // namespace grc
