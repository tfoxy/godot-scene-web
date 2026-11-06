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

// A copy of the live table (offset-to-top, typeinfo, then the slots); its address point is +2.
void **copy_table(void **live, size_t words, std::string *error) {
  void **table = static_cast<void **>(std::calloc(words, sizeof(void *)));
  if (table == nullptr) {
    *error = "out of memory";
    return nullptr;
  }
  if ((reinterpret_cast<uintptr_t>(table) % sizeof(void *)) != 0) {
    std::free(table);
    *error = "shadow table is not pointer-aligned";
    return nullptr;
  }
  std::memcpy(table, live - 2, words * sizeof(void *));
  return table;
}

}  // namespace

bool ShadowVtable::build(void *object, size_t slot_count,
                         const std::vector<SlotReplacement> &replacements, std::string *error) {
  if (built()) {
    *error = "already built";
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
  void **armed = copy_table(live, words, error);
  if (armed == nullptr) {
    return false;
  }
  void **standby = copy_table(live, words, error);
  if (standby == nullptr) {
    std::free(armed);
    return false;
  }

  void **armed_point = armed + 2;
  void **standby_point = standby + 2;
  size_t standby_slots = 0;
  for (const SlotReplacement &replacement : replacements) {
    // Both tables were copied from the same live table, so the original is the same in each.
    *replacement.original_out = live[replacement.index];
    armed_point[replacement.index] = replacement.hook;
    if (replacement.standby) {
      standby_point[replacement.index] = replacement.hook;
      ++standby_slots;
    }
  }

  object_ = object;
  armed_point_ = armed_point;
  standby_point_ = standby_point;
  original_point_ = live;
  slot_count_ = slot_count;
  armed_slots_ = replacements.size();
  standby_slots_ = standby_slots;
  published_ = Table::Engine;
  return true;
}

bool ShadowVtable::publish(Table table) {
  if (!built()) {
    return false;
  }
  void **live = read_vptr(object_);
  if (live != original_point_ && live != standby_point_ && live != armed_point_) {
    return false;
  }
  void **point = table == Table::Armed     ? armed_point_
                 : table == Table::Standby ? standby_point_
                                           : original_point_;
  publish_vptr(object_, point);
  published_ = table;
  return true;
}

bool ShadowVtable::arm(void *object, size_t slot_count,
                       const std::vector<SlotReplacement> &replacements, std::string *error) {
  if (published_ == Table::Armed) {
    *error = "already armed";
    return false;
  }
  if (!built() && !build(object, slot_count, replacements, error)) {
    return false;
  }
  if (!publish(Table::Armed)) {
    *error = "the object's vptr is not ours to replace";
    return false;
  }
  return true;
}

bool ShadowVtable::disarm(bool *was_shadow, bool *restored) {
  *was_shadow = false;
  *restored = false;
  if (!built() || published_ == Table::Engine) {
    return false;
  }
  void **live = read_vptr(object_);
  *was_shadow = (live == armed_point_ || live == standby_point_);
  if (*was_shadow) {
    publish_vptr(object_, original_point_);
    *restored = (read_vptr(object_) == original_point_);
  }
  published_ = Table::Engine;
  // Neither table is ever freed: another thread can be mid-dispatch through one at this instant,
  // and a two-table leak (about 4 KB each) for the remaining process lifetime is the safe trade.
  return *restored;
}

}  // namespace grc
