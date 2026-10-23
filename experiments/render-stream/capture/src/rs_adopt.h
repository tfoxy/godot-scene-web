// The arm-time late-join adoption seam (gate8-design.md D3-D7, D13; G8w).
//
// G8w lands only the seam: the type, the call site in entry.cpp's stream_start (between the root
// query and the root-size policy, D4's order) and the session's `adoption` declaration. The body
// is empty and adopts nothing; G8a fills it (the tree walk, the node map, the queued redraws) and
// G8r/G8m extend it (resources, materials), so those increments change this file pair rather than
// the shared capture files. `GRC_ADOPT=off` (the default) never calls it.
#ifndef GRC_RS_ADOPT_H
#define GRC_RS_ADOPT_H

#include <cstdint>
#include <string>

namespace grc {
namespace rs {

// What the adoption walk found and did, for `result.json` (gate8-design.md Q2 "adopt-account").
struct AdoptStats {
  bool ran = false;
  std::uint32_t canvases = 0;
  std::uint32_t layers = 0;
  std::uint32_t items = 0;
  std::uint32_t residue = 0;  // RS-only items with no node: typed and counted, never adopted
};

struct AdoptConfig {
  // The capture host's frame counter at arm, dated into the session's `adoption.frame` (>= 1).
  std::uint64_t arm_frame = 1;
};

// Called once at arm on the main thread, when GRC_ADOPT=arm. Returns the counts. G8w: adopts
// nothing and returns zeros with `ran` true.
AdoptStats adopt_at_arm(const AdoptConfig &config);

}  // namespace rs
}  // namespace grc

#endif  // GRC_RS_ADOPT_H
