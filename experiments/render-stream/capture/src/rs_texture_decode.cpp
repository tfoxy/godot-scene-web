#include "rs_texture_decode.h"

#include <atomic>

namespace grc {
namespace rs {

namespace {
std::atomic<bool> g_enabled{false};
}  // namespace

void texture_decode_set_enabled(bool enabled) { g_enabled.store(enabled); }

bool texture_decode_enabled() { return g_enabled.load(); }

DecodeResult texture_decode(const DecodeRequest &request) {
  (void)request;
  return DecodeResult();  // the empty seam: G8t fills it (gate8-design.md D8)
}

}  // namespace rs
}  // namespace grc
