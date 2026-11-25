#include "take.hpp"
#include "rs_audio_wire.h"
#include "rs_sha256.h"
#include <algorithm>
#include "key.hpp"
#include <chrono>
#include <cmath>
#include <cstring>
#include <stdexcept>
#ifdef GRC_FMOD_TEST_CALLBACKS
extern "C" void grc_test_callback_phase(int);
#endif
namespace grc::fmod {
namespace {
constexpr unsigned rate = 48000, block = 1024, cap = rate * 10, ring_frames = block * 2;
void check(Result result) { if (result != ok) throw std::runtime_error("fmod-off"); }
void put(Bytes &out, std::uint32_t value, unsigned n) {
  while (n--) { out.push_back(value & 255); value >>= 8; }
}
Bytes wav(const Bytes &pcm) {
  Bytes out; out.reserve(pcm.size() + 44);
  auto tag = [&](const char *s) { out.insert(out.end(), s, s + 4); };
  tag("RIFF"); put(out, pcm.size() + 36, 4); tag("WAVE"); tag("fmt ");
  put(out, 16, 4); put(out, 1, 2); put(out, 2, 2); put(out, rate, 4);
  put(out, rate * 4, 4); put(out, 4, 2); put(out, 16, 2); tag("data");
  put(out, pcm.size(), 4); out.insert(out.end(), pcm.begin(), pcm.end()); return out;
}
}
bool allow_oneshot(bool value) {
#ifdef GRC_FMOD_TEST_ACCEPT_LOOP
  (void)value; return true;
#else
  return value;
#endif
}
Take validate_take(const std::vector<float> &samples, const std::array<double, 4> &energy, bool capped) {
  Take out;
  if (samples.empty() || energy[0] < 1e-9 || energy[1] < 1e-9 ||
      energy[2] > energy[1] * .001 || energy[3] > energy[1] * .001) {
    out.reason = "refused-bus"; return out;
  }
  out.frames = samples.size() / 2; out.capped = capped;
  out.pcm.reserve(samples.size() * 2);
  for (unsigned frame = 0; frame < out.frames; ++frame) {
    const float fade = capped && frame >= cap - rate / 20 ? (cap - frame) / float(rate / 20) : 1;
    for (unsigned channel = 0; channel < 2; ++channel) {
      const float value = samples[frame * 2 + channel] * fade;
      const auto sample = static_cast<std::int16_t>(std::nearbyint(std::clamp(value * 32767.f, -32768.f, 32767.f)));
      put(out.pcm, static_cast<std::uint16_t>(sample), 2);
    }
  }
  out.wav = wav(out.pcm);
  out.hash = grc::sha256_hex(out.wav.data(), out.wav.size());
  return out;
}
struct TakeSystem::Capture {
  // A distinct public callback per slot avoids reading any FMOD DSP_STATE field.
  // Two take systems have four captures each; no callback owns an allocation.
  static inline std::array<std::atomic<Capture *>, 8> slots{};
  std::array<float, ring_frames * 2> ring{};
  unsigned produced = 0, consumed = 0, frames = 0, slot = 0;
  double energy = 0;
  bool store = false, overflow = false;
  Dsp *dsp = nullptr;
  Group *group = nullptr;
  Bus *bus = nullptr;
  explicit Capture(bool keep) : store(keep) {
    for (; slot < slots.size(); ++slot) {
      Capture *expected = nullptr;
      if (slots[slot].compare_exchange_strong(expected, this)) return;
    }
    throw std::runtime_error("create");
  }
  ~Capture() { slots[slot].store(nullptr); }
  template<unsigned N> static Result GRC_NATIVE_CALL read(DspState *, float *input, float *output,
                                                         unsigned n, int channels, int *out_channels) {
#ifdef GRC_FMOD_TEST_CALLBACKS
    struct Phase { Phase(){grc_test_callback_phase(1);} ~Phase(){grc_test_callback_phase(0);} } phase;
#endif
    auto *capture = slots[N].load(std::memory_order_acquire);
    if (!capture || channels < 1 || channels > 32) return 1;
    *out_channels = channels;
    std::memcpy(output, input, std::size_t(n) * channels * sizeof(float));
    const unsigned count = std::min(n, cap - capture->frames);
    if (capture->store && count > ring_frames - (capture->produced - capture->consumed)) {
      capture->overflow = true; return 1;
    }
    for (unsigned i = 0; i < count; ++i) {
      const float left = input[i * channels], right = input[i * channels + (channels > 1 ? 1 : 0)];
      capture->energy += double(left) * left + double(right) * right;
      if (capture->store) {
        const auto at = (capture->produced + i) % ring_frames * 2;
        capture->ring[at] = left; capture->ring[at + 1] = right;
      }
    }
    if (capture->store) capture->produced += count;
    capture->frames += count;
    return ok;
  }
  DspRead callback() const {
    static constexpr std::array<DspRead, 8> callbacks{read<0>, read<1>, read<2>, read<3>, read<4>, read<5>, read<6>, read<7>};
    return callbacks[slot];
  }
  void reset() { produced = consumed = frames = 0; energy = 0; overflow = false; }
};
TakeSystem::TakeSystem(const RenderConfig &config) : samples_() {
  samples_.reserve(cap * 2);
  try {
    api_.bind(config.core_lib.c_str(), config.studio_lib.c_str());
    api_.bind_render();
    studio_ = api_.create();
    banks_ = std::make_unique<Banks>(config.source, config.pck_path, config.banks, config.wake, config.wake_self);
    if (!config.bankset.empty() && banks_->hash() != config.bankset) throw std::runtime_error("bank-load");
    check(api_.get_core(studio_, &core_));
    check(api_.set_output(core_, 4)); check(api_.set_format(core_, rate, 3, 0));
    check(api_.buffer_size(core_, block, 4));
    AdvancedSettings advanced{}; advanced.cbSize = sizeof(advanced);
    check(api_.get_advanced(core_, &advanced)); advanced.randomSeed = 37;
    check(api_.set_advanced(core_, &advanced));
    check(api_.initialize(studio_, 256, 4 | 16, 1 | 2, nullptr));
    banks_->load(api_, studio_);
    banks_->load_samples(api_, studio_);
    check(api_.update(studio_));
    Bus *master = nullptr;
    check(api_.get_bus(studio_, "bus:/master", &master)); check(api_.bus_volume(master, 1));
    attach(0, nullptr); attach(1, "bus:/master/sfx");
    attach(2, "bus:/master/music"); attach(3, "bus:/master/ambience");
  } catch (...) { cleanup(); throw; }
}
void TakeSystem::attach(unsigned index, const char *bus) {
  auto &capture = captures_[index]; capture = std::make_unique<Capture>(index == 0);
  if (bus) {
    check(api_.get_bus(studio_, bus, &capture->bus));
    check(api_.bus_volume(capture->bus, 1));
    check(api_.bus_lock(capture->bus));
    check(api_.update(studio_));
    check(api_.bus_group(capture->bus, &capture->group));
  } else check(api_.master_group(core_, &capture->group));
  DspDescription desc{};
  desc.pluginsdkversion = 110; std::memcpy(desc.name, "grc capture", 12);
  desc.version = 1; desc.numinputbuffers = desc.numoutputbuffers = 1; desc.read = capture->callback();
  check(api_.create_dsp(core_, &desc, &capture->dsp));
  check(api_.add_dsp(capture->group, bus ? -2 : -1, capture->dsp));
}
TakeSystem::~TakeSystem() { cleanup(); }
void TakeSystem::cleanup() noexcept {
  for (auto &capture : captures_) if (capture) {
    if (capture->dsp) { api_.remove_dsp(capture->group, capture->dsp); api_.release_dsp(capture->dsp); }
    if (capture->bus) api_.bus_unlock(capture->bus);
    capture.reset();
  }
  if (studio_) { api_.studio_release(studio_); studio_ = nullptr; }
  banks_.reset();
}
Take TakeSystem::render(const std::string &key) {
  const auto [path, parameters] = parse_key(key);
  if (!path.starts_with("event:/sfx/") || path.starts_with("event:/sfx/ambience/"))
    return {{}, {}, {}, "refused-not-oneshot"};
  Description *description = nullptr;
  if (api_.get_event(studio_, path.c_str(), &description) != ok) return {{}, {}, {}, "unknown-event"};
  int one_shot = 0; check(api_.is_oneshot(description, &one_shot));
  if (!allow_oneshot(one_shot)) return {{}, {}, {}, "refused-not-oneshot"};
  for (auto &capture : captures_) capture->reset();
  samples_.clear();
  Instance *instance = nullptr; check(api_.instance_create(description, &instance));
  struct Finish { Api &api; Instance *instance; ~Finish() { api.event_stop(instance, 1); api.event_release(instance); } } finish{api_, instance};
  for (const auto &[name, value] : parameters) check(api_.parameter(instance, name.c_str(), value, 0));
  const auto started = std::chrono::steady_clock::now();
  check(api_.event_start(instance));
  bool capped = false;
  std::uint64_t first_mix = 0;
  auto &master = *captures_[0];
  for (unsigned update = 0; update < cap / block + 4; ++update) {
    check(api_.update(studio_));
    if (banks_->failed()) throw std::runtime_error("bank-load");
    if (master.overflow) throw std::runtime_error("fmod-off");
    while (master.consumed < master.produced) {
      const auto at = master.consumed++ % ring_frames * 2;
      samples_.push_back(master.ring[at]); samples_.push_back(master.ring[at + 1]);
    }
    if (!first_mix && master.energy > 0)
      first_mix = std::chrono::duration_cast<std::chrono::microseconds>(std::chrono::steady_clock::now() - started).count();
    if (master.frames >= cap && !capped) { capped = true; check(api_.event_stop(instance, 1)); }
    int state = 0; check(api_.playback(instance, &state)); if (state == 2) break;
  }
  std::array<double, 4> energy{};
  for (unsigned i = 0; i < 4; ++i) energy[i] = captures_[i]->energy;
  auto result = validate_take(samples_, energy, capped); result.first_mix_us = first_mix; return result;
}
}
