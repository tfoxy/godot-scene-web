#include "vtable.h"

#include <cstdint>
#include <cstdlib>
#include <cstring>

namespace grc {

namespace {

// One aligned pointer-sized store, with release ordering so that a thread that
// observes the new vptr also observes the fully built table behind it.
void publish_vptr(void *object, void **address_point) {
  auto *slot = static_cast<void **>(object);
  __atomic_store_n(slot, static_cast<void *>(address_point), __ATOMIC_RELEASE);
}

void **read_vptr(void *object) {
  auto *slot = static_cast<void **>(object);
  return static_cast<void **>(__atomic_load_n(slot, __ATOMIC_ACQUIRE));
}

}  // namespace

bool ShadowVtable::arm(void *object, size_t slot_count,
                       const std::vector<SlotReplacement> &replacements, std::string *error) {
  if (armed_) {
    *error = "already armed";
    return false;
  }
  if (object == nullptr || slot_count == 0 || slot_count > 4096) {
    *error = "bad object or slot count";
    return false;
  }
  void **live = read_vptr(object);
  if (live == nullptr) {
    *error = "object has a null vptr";
    return false;
  }
  for (const SlotReplacement &replacement : replacements) {
    if (replacement.index >= slot_count || replacement.hook == nullptr) {
      *error = "slot replacement out of range";
      return false;
    }
  }

  const size_t words = slot_count + 2;  // offset-to-top + typeinfo + slots
  void **table = static_cast<void **>(std::calloc(words, sizeof(void *)));
  if (table == nullptr) {
    *error = "out of memory";
    return false;
  }
  if ((reinterpret_cast<uintptr_t>(table) % sizeof(void *)) != 0) {
    std::free(table);
    *error = "shadow table is not pointer-aligned";
    return false;
  }
  std::memcpy(table, live - 2, words * sizeof(void *));

  void **point = table + 2;
  for (const SlotReplacement &replacement : replacements) {
    *replacement.original_out = point[replacement.index];
    point[replacement.index] = replacement.hook;
  }

  object_ = object;
  table_ = table;
  shadow_point_ = point;
  original_point_ = live;
  slot_count_ = slot_count;
  publish_vptr(object, point);
  armed_ = true;
  return true;
}

bool ShadowVtable::disarm(bool *was_shadow, bool *restored) {
  *was_shadow = false;
  *restored = false;
  if (!armed_) {
    return false;
  }
  void **live = read_vptr(object_);
  *was_shadow = (live == shadow_point_);
  if (*was_shadow) {
    publish_vptr(object_, original_point_);
    *restored = (read_vptr(object_) == original_point_);
  }
  armed_ = false;
  // The shadow table is deliberately never freed: another thread can be
  // mid-dispatch through it at this instant, and a one-table leak for the
  // remaining process lifetime is the safe trade.
  return *restored;
}

}  // namespace grc
