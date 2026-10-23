#include "rs_adopt.h"

namespace grc {
namespace rs {

AdoptStats adopt_at_arm(const AdoptConfig &config) {
  (void)config;
  AdoptStats stats;
  stats.ran = true;  // the empty seam: G8a fills the walk (gate8-design.md D4, D5)
  return stats;
}

}  // namespace rs
}  // namespace grc
