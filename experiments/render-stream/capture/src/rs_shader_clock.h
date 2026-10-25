#pragma once

// P3-TM (protocol/render-stream-10.md "Shader time"): the host's canvas shader time, as Godot
// 4.5.1's GLES3 rasterizer keeps it (drivers/gles3/rasterizer_gles3.cpp:97-107): every draw adds
// the main loop's scaled step (`RenderingServer::draw(.., scaled_step)`, main.cpp:4825-4829) and
// wraps at `rendering/limits/time/time_rollover_secs`, in double. The rasterizer's total is not
// readable through RenderingServer, so the capture keeps the same sum from the extension's frame
// callback, which runs after each iteration's draw (main.cpp:4839): an iteration that drew
// (Engine.get_frames_drawn() moved) adds the step the tree processed (Node.get_process_delta_time,
// the same `process_step * time_scale` double). A host that has never drawn (headless: no draw
// path) adds every iteration, the time a rendered host drawing each iteration would have.
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
};

// The process-wide clock.
ShaderClock &shader_clock();

// One frame callback (every iteration, armed or not). Returns false when the clock is unavailable.
bool shader_clock_tick();

}  // namespace rs
}  // namespace grc
