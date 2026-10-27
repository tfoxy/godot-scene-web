#pragma once

// P3-TM (protocol/render-stream-10.md "Shader time"): the host's canvas shader time, as Godot
// 4.5.1's GLES3 rasterizer keeps it (drivers/gles3/rasterizer_gles3.cpp:97-107): every draw adds
// its `frame_step` (`RenderingServer::draw(.., frame_step)`) and wraps at
// `rendering/limits/time/time_rollover_secs`, in double. The rasterizer's total is not readable
// through RenderingServer, so the capture keeps the same sum.
//
// P3-CK: the source is the hooked `RenderingServer::draw` itself (hooks.cpp `hook_draw`, /10 only),
// so the clock adds exactly what GLES3 adds. The main loop passes `scaled_step = process_step *
// time_scale` taken BEFORE the physics clamp (main.cpp:4693-4694, :4710-4713): after an iteration
// longer than `max_physics_steps_per_frame` physics steps (a stall), the tree's process delta is
// clamped and the draw's step is not, so a sum of the tree's deltas (P3-TM's source) falls behind
// GLES3 by the stall's excess, for good. A script's `RenderingServer.force_draw(.., step)` reaches
// the hook too.
//
// The frame callback (after each iteration's draw, main.cpp:4839) still ticks: a host that has never
// drawn (headless: no draw path) adds the tree's delta (Node.get_process_delta_time) every
// iteration, the time a rendered host drawing each iteration would have, as P3-TM did. Without the
// draw hook (a record without the `draw` slot, or GRC_SHADER_CLOCK_FAULT=tree-delta) the tick is
// P3-TM's whole clock: an iteration that drew (Engine.get_frames_drawn() moved) adds the tree's
// delta, which equals the draw's step unless the iteration was clamped.
//
// Exact when the extension's first frame callback is the host's first iteration (the extension
// is loaded at startup); an extension loaded later starts from 0 and logs the frames it missed.

#include <cstdint>
#include <string>

namespace grc {
namespace rs {

struct ShaderClock {
  double total = 0.0;
  double rollover = 3600.0;   // the project setting's default
  std::int64_t last_drawn = -1;
  std::int64_t start_drawn = -1;  // Engine.get_frames_drawn() at the first tick
  std::uint64_t ticks = 0;
  std::uint64_t advanced = 0;
  bool available = true;      // false once a bind was missing (then total stays 0)
  std::string unavailable;    // the first missing bind
  bool draw_hooked = false;   // P3-CK: RenderingServer::draw is planned (hooks_plan)
  bool tree_delta_fault = false;  // GRC_SHADER_CLOCK_FAULT=tree-delta: ignore the draw hook
  std::uint64_t draws = 0;    // hooked draws seen (counted even under the fault)
};

// The process-wide clock.
ShaderClock &shader_clock();

// One frame callback (every iteration, armed or not). Returns false when the clock is unavailable.
bool shader_clock_tick();

// P3-CK: whether hooks_plan planned the draw hook (set before arming).
void shader_clock_set_draw_hooked(bool hooked);

// P3-CK: one hooked main-thread RenderingServer::draw with its frame_step.
void shader_clock_draw(double frame_step);

// "draw-hook" when the hooked draws are the clock's source, else "frame-callback".
const char *shader_clock_source();

}  // namespace rs
}  // namespace grc
