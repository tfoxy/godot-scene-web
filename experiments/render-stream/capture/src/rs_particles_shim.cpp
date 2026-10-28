#include "rs_particles_shim.h"

namespace grc {
namespace rs {

bool parse_particles_shim_mode(const char *value, ParticlesShimMode *out, std::string *error) {
  const std::string v = value == nullptr ? std::string() : std::string(value);
  if (v.empty() || v == "off") {
    *out = ParticlesShimMode::Off;
    return true;
  }
  if (v == "synthesize") {
    *out = ParticlesShimMode::Synthesize;
    return true;
  }
  *error = "GRC_HEADLESS_PARTICLES must be off or synthesize, got '" + v + "'";
  return false;
}

bool particles_shim_may_arm(ParticlesShimMode mode, const std::string &display_server,
                            std::string *reason) {
  if (mode == ParticlesShimMode::Off || display_server == "headless") {
    return true;
  }
  *reason = "particles-shim-not-headless";
  return false;
}

bool parse_predraw_pump(const char *value, bool *out, std::string *error) {
  const std::string v = value == nullptr ? std::string() : std::string(value);
  if (v.empty() || v == "0") {
    *out = false;
    return true;
  }
  if (v == "1") {
    *out = true;
    return true;
  }
  *error = "GRC_PREDRAW_PUMP must be 0 or 1, got '" + v + "'";
  return false;
}

bool ParticlesShim::is_synthetic(std::uint64_t rid) {
  return (rid >> 32) == kTag && (rid & 0xffffffffull) >= kIndexBase;
}

void ParticlesShim::configure(ParticlesShimMode mode) {
  std::lock_guard<std::mutex> lock(mutex_);
  mode_ = mode;
  next_index_ = kIndexBase;
  synthesized_ = 0;
  engine_allocated_ = 0;
  freed_ = 0;
}

bool ParticlesShim::armed() const {
  std::lock_guard<std::mutex> lock(mutex_);
  return mode_ == ParticlesShimMode::Synthesize;
}

std::uint64_t ParticlesShim::on_create(std::uint64_t engine_rid) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (mode_ != ParticlesShimMode::Synthesize) {
    return engine_rid;
  }
  if (engine_rid != 0) {
    ++engine_allocated_;
    return engine_rid;
  }
  ++synthesized_;
  const std::uint64_t index = next_index_++;
  if (next_index_ > 0xffffffffull) {
    next_index_ = kIndexBase;  // 2^31 emitters later; never reached in practice
  }
  return (kTag << 32) | index;
}

void ParticlesShim::on_free(std::uint64_t rid) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (mode_ == ParticlesShimMode::Synthesize && is_synthetic(rid)) {
    ++freed_;
  }
}

std::uint64_t ParticlesShim::synthesized() const {
  std::lock_guard<std::mutex> lock(mutex_);
  return synthesized_;
}
std::uint64_t ParticlesShim::engine_allocated() const {
  std::lock_guard<std::mutex> lock(mutex_);
  return engine_allocated_;
}
std::uint64_t ParticlesShim::freed() const {
  std::lock_guard<std::mutex> lock(mutex_);
  return freed_;
}

ParticlesShim &particles_shim() {
  static ParticlesShim shim;
  return shim;
}

}  // namespace rs
}  // namespace grc
