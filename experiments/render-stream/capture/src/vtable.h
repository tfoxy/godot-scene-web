// Shadow-vtable arm/disarm.
//
// Arming copies the live vtable (from two words before the address point, so
// that offset-to-top and the typeinfo pointer come along) into a heap table,
// replaces the slots named by the calibration record, and publishes the new
// address point with one aligned pointer-sized store into the singleton
// object's first word. No engine code, no engine data and no page protection is
// touched: the only write is that one word.

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
};

class ShadowVtable {
 public:
  // Builds the shadow table and publishes it. `slot_count` is the number of
  // virtual slots from the address point, as recorded by the calibration.
  bool arm(void *object, size_t slot_count, const std::vector<SlotReplacement> &replacements,
           std::string *error);

  // Restores the original address point if (and only if) the object still
  // carries ours. `was_shadow` reports what the object's vptr held on entry.
  bool disarm(bool *was_shadow, bool *restored);

  bool armed() const { return armed_; }
  const void *shadow_address_point() const { return shadow_point_; }
  const void *original_address_point() const { return original_point_; }

 private:
  void *object_ = nullptr;
  void **table_ = nullptr;          // allocation base (offset-to-top word)
  void **shadow_point_ = nullptr;   // table_ + 2
  void **original_point_ = nullptr; // the engine's own address point
  size_t slot_count_ = 0;
  bool armed_ = false;
};

}  // namespace grc
