// A fake GDExtension interface for engine-path unit tests of rs_adopt.cpp: just enough of the
// host for the read-backs to run against plain C++ objects, with every call counted.
//
// - StringNames and class tags are interned std::strings (the StringName's opaque word holds a
//   `const std::string *`); a method bind is the interned "Class.method" string, so every bind
//   the capture asks for exists (hashes are ignored) and resolve_binds succeeds.
// - object_method_bind_ptrcall counts each call by "Class.method", runs the test's override when
//   one is set, else a few generic getters over fake::Object's fields, else leaves `ret` untouched
//   (the caller's zeroed slot: a null Ref, a 0 RID, a NIL Variant). A call through a null bind is
//   counted separately: on a real engine it dereferences a null MethodBind.
// - Objects carry their class and ancestor names; object_cast_to answers from that set.
// - A Variant is 24 bytes: the type in the first word (all zero is NIL, as Godot's), the payload
//   in the second. Ref<T> slots are one pointer (ref_get_object / ref_set_object read and write
//   it). A packed array is Godot's two-word Vector: the CowData element pointer at offset 8, with
//   the element count 8 bytes before the data (abi.h cowdata_size).
#pragma once

#include <cstdint>
#include <cstring>
#include <deque>
#include <functional>
#include <map>
#include <set>
#include <string>
#include <vector>

#include "iface.h"

namespace fake {

struct Object {
  std::uint64_t id = 0;
  std::set<std::string> classes;  // the class and every ancestor (cast_to answers from this)
  std::uint64_t rid = 0;          // Resource.get_rid, CanvasItem.get_canvas_item
  std::uint64_t canvas = 0;       // CanvasItem.get_canvas
  Object *parent = nullptr;       // Node.get_parent
  std::vector<Object *> children;  // Node.get_child_count / get_child
};

// One ptrcall: the instance, the argument pointers and the return slot.
using Call = std::function<void(Object *self, const GDExtensionConstTypePtr *args, void *ret)>;

struct World {
  std::set<std::string> interned;  // StringNames, class tags and binds (stable addresses)
  std::deque<Object> objects;      // stable addresses
  std::map<std::uint64_t, Object *> by_id;
  std::map<std::string, Object *> singletons;
  std::map<std::string, Call> overrides;  // "Class.method" -> behaviour
  std::map<std::string, int> calls;       // "Class.method" -> ptrcall count
  int null_bind_calls = 0;
  std::deque<std::vector<std::uint64_t>> cow_storage;  // packed-array allocations
  std::uint64_t next_id = 1000;

  Object &make(std::set<std::string> classes, std::uint64_t rid = 0) {
    objects.emplace_back();
    Object &o = objects.back();
    o.id = next_id++;
    o.classes = std::move(classes);
    o.rid = rid;
    by_id[o.id] = &o;
    return o;
  }
  void adopt_child(Object &parent, Object &child) {
    parent.children.push_back(&child);
    child.parent = &parent;
  }
  int count(const std::string &key) const {
    const auto it = calls.find(key);
    return it == calls.end() ? 0 : it->second;
  }
  // Between tests: the objects stay (ids are never reused, so a stale node map entry stays
  // stale), the behaviour and the counts go.
  void reset_calls() {
    overrides.clear();
    calls.clear();
    null_bind_calls = 0;
    singletons.clear();
  }
};

inline World &world() {
  static World w;
  return w;
}

inline const std::string &intern(const char *text) { return *world().interned.insert(text).first; }

inline const std::string &name_of(GDExtensionConstStringNamePtr p) {
  return **static_cast<const std::string *const *>(p);
}

// Writes `count` floats as a PackedFloat32Array into a Vector-shaped return slot.
inline void put_packed_floats(void *ret, const std::vector<float> &values) {
  std::vector<std::uint64_t> storage(2 + (values.size() + 1) / 2 + 1, 0);
  storage[0] = 1;              // reference count
  storage[1] = values.size();  // element count (cowdata_size)
  if (!values.empty()) std::memcpy(&storage[2], values.data(), values.size() * sizeof(float));
  world().cow_storage.push_back(std::move(storage));
  const void *data = &world().cow_storage.back()[2];
  std::memcpy(static_cast<unsigned char *>(ret) + 8, &data, sizeof(data));
}

inline void put_object(void *ret, Object *o) { std::memcpy(ret, &o, sizeof(o)); }
inline void put_int(void *ret, std::int64_t v) { std::memcpy(ret, &v, sizeof(v)); }
inline std::uint64_t arg_u64(const GDExtensionConstTypePtr *args, int i) {
  std::uint64_t v = 0;
  std::memcpy(&v, args[i], sizeof(v));
  return v;
}

// --- the interface functions -------------------------------------------------------------

namespace detail {

inline void string_name_new(GDExtensionUninitializedStringNamePtr dest, const char *text,
                            GDExtensionBool) {
  const std::string *p = &intern(text);
  std::memcpy(dest, &p, sizeof(p));
}

inline GDExtensionMethodBindPtr method_bind(GDExtensionConstStringNamePtr cls,
                                            GDExtensionConstStringNamePtr method, GDExtensionInt) {
  const std::string key = name_of(cls) + "." + name_of(method);
  return const_cast<std::string *>(&intern(key.c_str()));
}

inline void ptrcall(GDExtensionMethodBindPtr bind, GDExtensionObjectPtr instance,
                    const GDExtensionConstTypePtr *args, GDExtensionTypePtr ret) {
  World &w = world();
  if (bind == nullptr) {
    ++w.null_bind_calls;
    return;
  }
  const std::string &key = *static_cast<const std::string *>(bind);
  ++w.calls[key];
  Object *self = static_cast<Object *>(instance);
  const auto it = w.overrides.find(key);
  if (it != w.overrides.end()) {
    it->second(self, args, ret);
    return;
  }
  if (self == nullptr || ret == nullptr) return;
  if (key == "Object.get_instance_id") {
    put_int(ret, static_cast<std::int64_t>(self->id));
  } else if (key == "Resource.get_rid" || key == "CanvasItem.get_canvas_item") {
    std::memcpy(ret, &self->rid, sizeof(self->rid));
  } else if (key == "CanvasItem.get_canvas") {
    std::memcpy(ret, &self->canvas, sizeof(self->canvas));
  } else if (key == "Node.get_child_count") {
    put_int(ret, static_cast<std::int64_t>(self->children.size()));
  } else if (key == "Node.get_child") {
    const std::int64_t i = static_cast<std::int64_t>(arg_u64(args, 0));
    put_object(ret, i >= 0 && i < static_cast<std::int64_t>(self->children.size())
                        ? self->children[static_cast<std::size_t>(i)]
                        : nullptr);
  } else if (key == "Node.get_parent") {
    put_object(ret, self->parent);
  }
}

inline void *class_tag(GDExtensionConstStringNamePtr cls) {
  return const_cast<std::string *>(&intern(name_of(cls).c_str()));
}

inline GDExtensionObjectPtr cast_to(GDExtensionConstObjectPtr object, void *tag) {
  const Object *o = static_cast<const Object *>(object);
  if (o == nullptr || tag == nullptr) return nullptr;
  return o->classes.count(*static_cast<const std::string *>(tag)) != 0 ? const_cast<Object *>(o)
                                                                      : nullptr;
}

inline GDExtensionObjectPtr ref_get(GDExtensionConstRefPtr ref) {
  void *o = nullptr;
  std::memcpy(&o, ref, sizeof(o));
  return o;
}
inline void ref_set(GDExtensionRefPtr ref, GDExtensionObjectPtr object) {
  std::memcpy(ref, &object, sizeof(object));
}

inline GDExtensionObjectPtr singleton(GDExtensionConstStringNamePtr name) {
  const auto it = world().singletons.find(name_of(name));
  return it == world().singletons.end() ? nullptr : it->second;
}

inline GDExtensionObjectPtr instance_from_id(GDObjectInstanceID id) {
  const auto it = world().by_id.find(id);
  return it == world().by_id.end() ? nullptr : it->second;
}

inline GDExtensionVariantType variant_type(GDExtensionConstVariantPtr v) {
  std::uint32_t t = 0;
  std::memcpy(&t, v, sizeof(t));
  return static_cast<GDExtensionVariantType>(t);
}
inline void variant_destroy(GDExtensionVariantPtr) {}

template <typename T>
void to_type(GDExtensionUninitializedTypePtr out, GDExtensionVariantPtr v) {
  std::memcpy(out, static_cast<unsigned char *>(v) + 8, sizeof(T));
}
template <typename T, GDExtensionVariantType kType>
void from_type(GDExtensionUninitializedVariantPtr v, GDExtensionTypePtr in) {
  unsigned char *d = static_cast<unsigned char *>(v);
  std::memset(d, 0, 24);
  const std::uint32_t t = kType;
  std::memcpy(d, &t, sizeof(t));
  std::memcpy(d + 8, in, sizeof(T));
}

inline GDExtensionTypeFromVariantConstructorFunc to_type_ctor(GDExtensionVariantType type) {
  switch (type) {
    case GDEXTENSION_VARIANT_TYPE_OBJECT: return &to_type<void *>;
    case GDEXTENSION_VARIANT_TYPE_INT: return &to_type<std::int64_t>;
    case GDEXTENSION_VARIANT_TYPE_BOOL: return &to_type<std::uint8_t>;
    case GDEXTENSION_VARIANT_TYPE_FLOAT: return &to_type<double>;
    case GDEXTENSION_VARIANT_TYPE_RID: return &to_type<std::uint64_t>;
    default: return nullptr;
  }
}
inline GDExtensionVariantFromTypeConstructorFunc from_type_ctor(GDExtensionVariantType type) {
  switch (type) {
    case GDEXTENSION_VARIANT_TYPE_OBJECT: return &from_type<void *, GDEXTENSION_VARIANT_TYPE_OBJECT>;
    case GDEXTENSION_VARIANT_TYPE_INT: return &from_type<std::int64_t, GDEXTENSION_VARIANT_TYPE_INT>;
    case GDEXTENSION_VARIANT_TYPE_BOOL: return &from_type<std::uint8_t, GDEXTENSION_VARIANT_TYPE_BOOL>;
    case GDEXTENSION_VARIANT_TYPE_FLOAT: return &from_type<double, GDEXTENSION_VARIANT_TYPE_FLOAT>;
    default: return nullptr;
  }
}

// Builtins are zero-constructed by their holders already; destruction is a no-op (the fake's
// allocations live in World).
inline GDExtensionPtrConstructor ptr_constructor(GDExtensionVariantType, int32_t) { return nullptr; }
inline GDExtensionPtrDestructor ptr_destructor(GDExtensionVariantType) { return nullptr; }
inline GDExtensionPtrBuiltInMethod builtin_method(GDExtensionVariantType,
                                                  GDExtensionConstStringNamePtr, GDExtensionInt) {
  return nullptr;
}
inline GDExtensionVariantPtr array_index(GDExtensionConstTypePtr, GDExtensionInt) { return nullptr; }
inline void string_new(GDExtensionUninitializedStringPtr dest, const char *) {
  std::memset(dest, 0, 8);
}
inline GDExtensionInt string_to_utf8(GDExtensionConstStringPtr, char *, GDExtensionInt) { return 0; }
inline GDExtensionObjectPtr construct_object(GDExtensionConstStringNamePtr) { return nullptr; }
inline void object_destroy(GDExtensionObjectPtr) {}
inline void callable_create(GDExtensionUninitializedTypePtr, GDExtensionCallableCustomInfo2 *) {}
inline void godot_version(GDExtensionGodotVersion2 *) {}
inline const uint8_t *image_ptr(GDExtensionObjectPtr) { return nullptr; }

}  // namespace detail

// Installs the fake into grc::g_iface (process-wide, as the real one is).
inline void install() {
  grc::Iface &f = grc::g_iface;
  f = grc::Iface();
  f.get_godot_version2 = &detail::godot_version;
  f.global_get_singleton = &detail::singleton;
  f.classdb_get_method_bind = &detail::method_bind;
  f.object_method_bind_ptrcall = &detail::ptrcall;
  f.string_name_new_with_latin1_chars = &detail::string_name_new;
  f.string_new_with_utf8_chars = &detail::string_new;
  f.string_to_utf8_chars = &detail::string_to_utf8;
  f.variant_get_ptr_destructor = &detail::ptr_destructor;
  f.variant_get_type = &detail::variant_type;
  f.get_variant_to_type_constructor = &detail::to_type_ctor;
  f.variant_get_ptr_constructor = &detail::ptr_constructor;
  f.ref_get_object = &detail::ref_get;
  f.ref_set_object = &detail::ref_set;
  f.classdb_get_class_tag = &detail::class_tag;
  f.object_cast_to = &detail::cast_to;
  f.image_ptr = &detail::image_ptr;
  f.get_variant_from_type_constructor = &detail::from_type_ctor;
  f.variant_destroy = &detail::variant_destroy;
  f.variant_get_ptr_builtin_method = &detail::builtin_method;
  f.array_operator_index_const = &detail::array_index;
  f.classdb_construct_object2 = &detail::construct_object;
  f.object_destroy = &detail::object_destroy;
  f.callable_custom_create2 = &detail::callable_create;
  f.object_get_instance_from_id = &detail::instance_from_id;
  f.complete = true;
}

}  // namespace fake
