// The pass-through recording hooks.
//
// Every hook records what it saw and then calls the function pointer that
// occupied the slot, with the identical arguments. The hooks are plain
// functions whose first parameter is the `this` pointer, which is exactly the
// Itanium ABI of the member functions they stand in for.

#pragma once

#include <cstdint>
#include <string>
#include <vector>

#include "calib.h"
#include "vtable.h"

namespace grc {

// Resolves the ClassDB method binds the hooks use to describe an Image. Safe to
// call more than once; a failure disables image details rather than capture.
void hooks_init_image_binds();

// True when Image.get_width/get_height/get_format/get_data_size all resolved.
bool hooks_image_details_available();

// Builds the slot replacement list from the record. Returns false when the
// record does not name every hooked slot.
bool hooks_replacements(const Calibration &calib, std::vector<SlotReplacement> *out,
                        std::string *error);

// The 1-based main-loop iteration now in progress, matching a fixture's own
// frame counter (the frame callback runs after process and draw). Texture
// captures carry it so an expected atlas update can be placed in time.
void hooks_set_frame(uint64_t frame);

// Serialised counters and captured values.
std::string hooks_counters_json(uint64_t frames_total, uint64_t frames_armed);

// Total number of intercepted calls across all hooks.
uint64_t hooks_total_calls();

}  // namespace grc
