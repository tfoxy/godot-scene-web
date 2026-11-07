// Shadow-vtable tables, published by one pointer store.
//
// Building copies the live vtable (from two words before the address point, so that offset-to-top
// and the typeinfo pointer come along) into two heap tables and replaces slots in each: the armed
// table replaces every slot the calibration record names, the standby table only the ones marked
// `standby` (the registry's tracked slots, the shims' slots,
// texture_set_path and draw). Both share the same original function pointers. Publishing a table
// is one aligned pointer-sized release store into the singleton object's first word: arm, standby
// and restore are each that one store. No engine code, no engine data and no page protection is
// touched. Neither table is ever freed (another thread can be mid-dispatch through either).

#pragma once

#include <cstddef>
#include <string>
#include <vector>

namespace grc {

struct SlotReplacement {
  size_t index;
  void *hook;
  // Receives the original function pointer that occupied the slot.
  void **original_out;
  // LS1: the slot is also replaced in the standby table.
  bool standby = false;
};

class ShadowVtable {
 public:
  enum class Table { Engine, Standby, Armed };

  // LS1: builds both tables from the live vptr, once, and fills every `original_out`. Publishes
  // nothing. `slot_count` is the number of virtual slots from the address point, as recorded by the
  // calibration.
  bool build(void *object, size_t slot_count, const std::vector<SlotReplacement> &replacements,
             std::string *error);

  // One release store of `table`'s address point. False (nothing written) when the tables are not
  // built or the object's vptr is none of the engine's, the standby and the armed address points
  // (someone else re-patched it).
  bool publish(Table table);

  // Builds and publishes the armed table (the pre-LS1 one-call arm; tests).
  bool arm(void *object, size_t slot_count, const std::vector<SlotReplacement> &replacements,
           std::string *error);

  // Restores the engine's address point from any patched state (standby or armed) if, and only
  // if, the object still carries one of ours. `was_shadow` reports whether it did. The tables stay
  // built.
  bool disarm(bool *was_shadow, bool *restored);

  bool built() const { return standby_point_ != nullptr; }
  Table published() const { return published_; }
  bool armed() const { return published_ == Table::Armed; }
  size_t armed_slots() const { return armed_slots_; }
  size_t standby_slots() const { return standby_slots_; }
  const void *shadow_address_point() const { return armed_point_; }
  const void *standby_address_point() const { return standby_point_; }
  const void *original_address_point() const { return original_point_; }

 private:
  void *object_ = nullptr;
  void **standby_point_ = nullptr;   // standby table + 2
  void **armed_point_ = nullptr;     // armed table + 2
  void **original_point_ = nullptr;  // the engine's own address point
  size_t slot_count_ = 0;
  size_t armed_slots_ = 0;
  size_t standby_slots_ = 0;
  Table published_ = Table::Engine;
};

}  // namespace grc
