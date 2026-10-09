// The pass-through recording hooks.
//
// Every hook records what it saw and then calls the function pointer that
// occupied the slot, with the identical arguments. The hooks are plain
// functions whose first parameter is the `this` pointer, which is exactly the
// Itanium ABI of the member functions they stand in for.
//
// Hooks come in two tiers. The eight gate -1 hooks are REQUIRED: a record that
// does not name one of them is refused. Every hook added after gate -1 is
// OPTIONAL: a record that does not name it (one written by an older
// calibrator) still loads, the hook is simply not installed, and the omission
// is recorded in calibration-check.json (`hook_plan`) and counters.json
// (`hooks_omitted`, with that hook's count written as null).

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

struct HookPlan {
  std::vector<SlotReplacement> replacements;
  std::vector<std::string> planned;  // hooks the record names, in install order
  std::vector<std::string> omitted;  // optional hooks the record does not name
  std::string missing_required;      // first required hook the record lacks, or empty
};

// Matches every hook against the record. Returns false (with `missing_required`
// set) when the record does not name a required hook; optional hooks it does
// not name land in `omitted` and are not installed. Also remembers the
// omissions for hooks_counters_json().
bool hooks_plan(const Calibration &calib, HookPlan *plan);

// One-line description of a plan, for the calibration-check entry.
std::string hooks_plan_detail(const HookPlan &plan);

// The 1-based main-loop iteration now in progress, matching a fixture's own
// frame counter (the frame callback runs after process and draw). Captures
// carry it so an expected call can be placed in time.
void hooks_set_frame(uint64_t frame);

// Serialised counters and captured values.
std::string hooks_counters_json(uint64_t frames_total, uint64_t frames_armed);

// Total number of intercepted calls across all hooks.
uint64_t hooks_total_calls();

}  // namespace grc
