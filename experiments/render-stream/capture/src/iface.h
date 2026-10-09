// Bindings to the subset of the GDExtension C interface this library uses,
// plus the small method-bind helpers that let it ask the engine questions
// without ever calling an unidentified vtable slot.

#pragma once

#include <cstddef>
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

  // Used only by the root query (rs_root_query). Resolved by
  // iface_load but not part of `complete`: a host without them still runs the
  // gate -1 capture, and the root query reports `root-query-failed`.
  GDExtensionInterfaceRefGetObject ref_get_object = nullptr;
  GDExtensionInterfaceRefSetObject ref_set_object = nullptr;
  GDExtensionInterfaceClassdbGetClassTag classdb_get_class_tag = nullptr;
  GDExtensionInterfaceObjectCastTo object_cast_to = nullptr;
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

// --- read-only getters for the gate-0 root query ------------------------------
//
// Each one ptrcalls a bound, argument-less, read-only method and decodes the
// return slot the way core/variant/method_ptrcall.h encodes it. Each returns
// false (leaving `out` untouched) when the bind, the instance or an interface
// function it needs is missing.

// Object-pointer return (`PtrToArg<T *>::encode`, method_ptrcall.h:256-258).
bool call_object_getter(GDExtensionMethodBindPtr bind, void *instance, void **out);

// RID return: one uint64 (`PtrToArg<RID>`).
bool call_rid_getter(GDExtensionMethodBindPtr bind, void *instance, uint64_t *out);

// A plain value return (Transform2D, Rect2, Color): the engine assigns the
// value into the slot, so `size` bytes are written.
bool call_value_getter(GDExtensionMethodBindPtr bind, void *instance, void *out, size_t size);

// --- the one write: gate 1's GRC_ROOT_SIZE=enforce-min-size ------------------
//
// ptrcall of a bound method that takes one `Vector2i` (two int32, passed by
// pointer: `PtrToArg<const Vector2i &>::convert` reads the value the argument
// pointer points at) and returns nothing. Returns false when the bind, the
// instance or ptrcall is missing; it cannot report the callee's own failure,
// so callers read the effect back.
bool call_void_vector2i(GDExtensionMethodBindPtr bind, void *instance, int32_t x, int32_t y);

// A `Ref<T>` return. ptrcall assigns into a `Ref<RefCounted>` slot, which takes
// a reference (core/object/ref_counted.h:251-254). The holder passes a zeroed,
// pointer-sized slot, reads the object with ref_get_object, and drops the
// reference again with ref_set_object(slot, nullptr), which calls
// reference_ptr(nullptr) and so unrefs
// (core/extension/gdextension_interface.cpp:1436-1442).
class RefHolder {
 public:
  RefHolder() = default;
  ~RefHolder();
  RefHolder(const RefHolder &) = delete;
  RefHolder &operator=(const RefHolder &) = delete;

  // Calls `bind` on `instance` into the slot. Returns false when anything
  // needed is missing; object() is then nullptr.
  bool call(GDExtensionMethodBindPtr bind, void *instance);
  void *object() const;
  // Drops the reference now (also done by the destructor). Idempotent.
  void release();

 private:
  void *slot_ = nullptr;  // a Ref<RefCounted>: one pointer, zero = null
  bool filled_ = false;
};

// `object` when it is an instance of `class_name` (or a subclass), else
// nullptr, via classdb_get_class_tag + object_cast_to.
void *cast_to(void *object, const char *class_name);

}  // namespace grc
