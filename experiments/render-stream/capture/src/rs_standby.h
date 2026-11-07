// The standby table's slots.
//
// A capture in standby (`GRC_MODE=standby`, and every arm's frames before it) publishes a sparse
// shadow table: only the hooks that must see a call while nothing streams are installed, and every
// other ("hot") slot dispatches straight to the engine, so a standby seat runs none of the hot
// hooks' code. The standby set is, by RenderingServer method name:
//
//   - the late-arm registry's tracked slots: every hook that records into the registry (creates,
//     frees, the setters), so an arm finds every live resource;
//   - the shims' slots (canvas_texture_create, particles_create and free), so a RID the shims hand
//     out is the one the engine later names;
//   - texture_set_path (D5: the reload path, recorded from LS4), planned always;
//   - draw: on a rendered host the shader clock advances only through the hooked draw
//     (rs_shader_clock.cpp), so without it TIME would freeze in standby.
//
// rs_standby_test (`standby-slot-census`) checks this list against hooks.cpp: a hook whose body
// reaches the registry or a shim is in the set, and nothing else but texture_set_path and draw.

#pragma once

#include <string>
#include <vector>

namespace grc {
namespace rs {

// True when the hook of RenderingServer method `name` is installed in the standby table.
bool standby_hook(const std::string &name);

// The whole set, sorted by name.
const std::vector<std::string> &standby_hook_names();

// GRC_STANDBY_FAULT (test only; never on the wire): the sabotages of LS1's checks.
//   full-table    the standby table is the armed table (fails `standby-hot-zero`)
//   drop-tracked  canvas_texture_create is left out of the standby table (fails
//                 `registry-live-bound` against the fixture's own create count)
//   no-draw       draw is left out of the standby table (fails the rendered clock leg)
enum class StandbyFault { None, FullTable, DropTracked, NoDraw };

// Parses the variable's value (null or empty: None). False, with `why`, for any other value.
bool parse_standby_fault(const char *value, StandbyFault *out, std::string *why);
const char *standby_fault_name(StandbyFault fault);

// The slot DropTracked leaves out.
inline constexpr const char *kStandbyDropTrackedHook = "canvas_texture_create";

// Whether the hook of method `name` goes in the standby table under `fault`.
bool standby_hook_under(const std::string &name, StandbyFault fault);

}  // namespace rs
}  // namespace grc
