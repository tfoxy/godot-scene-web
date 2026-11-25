#include "lane.hpp"
#include "clock.hpp"
#include <algorithm>
#include <charconv>
#include <cmath>
#include <cstring>
#include <stdexcept>
#ifdef GRC_FMOD_TEST_CALLBACKS
extern "C" void grc_test_callback_phase(int);
#endif
namespace grc::fmod {
namespace {
void check(Result r) { if (r != ok) throw std::runtime_error("fmod-off"); }
std::string wire_name(const std::string &s) {
  std::size_t count = 0, end = 0;
  while (end < s.size()) {
    const auto c = static_cast<unsigned char>(s[end]);
    const unsigned n = c < 128 ? 1 : c < 224 ? 2 : c < 240 ? 3 : 4;
    const auto escaped = c < 32 ? 6 : c == '"' || c == '\\' ? 2 : n;
    if (count + escaped > 128 || end + n > s.size()) break;
    count += escaped; end += n;
  }
  return s.substr(0, end);
}
bool group_name(const std::string &s) {
  return !s.empty() && s.size() <= 64 && std::all_of(s.begin(), s.end(), [](unsigned char c) {
    return c >= 32 && c <= 126 && c != '"' && c != '\\';
  });
}
}
std::vector<LaneConfig> parse_lanes(const std::string &config, const std::function<void(const std::string &)> &invalid) {
  std::vector<LaneConfig> out; std::uint16_t mask = 0;
  for (std::size_t pos = 0; pos < config.size();) {
    const auto end = config.find(',', pos); auto entry = config.substr(pos, end == std::string::npos ? end : end - pos);
    pos = end == std::string::npos ? config.size() : end + 1;
    auto a = entry.find(':'), b = a == std::string::npos ? a : entry.find(':', a + 1);
    unsigned id = 0;
    const auto number = std::from_chars(entry.data(), entry.data() + (a == std::string::npos ? entry.size() : a), id);
    if (a == std::string::npos || b == std::string::npos || number.ec != std::errc{} || number.ptr != entry.data() + a ||
        id < 1 || id > 15 || (mask & (1u << id))) { invalid("lane-config"); continue; }
    auto name = entry.substr(a + 1, b - a - 1), bus = entry.substr(b + 1), group = name;
    if (auto c = bus.find(':', 4); c != std::string::npos) { group = bus.substr(c + 1); bus.resize(c); }
    if (name.empty() || !bus.starts_with("bus:/") || !group_name(group)) { invalid("lane-config"); continue; }
    auto diagnostic = wire_name(name);
    try {
      grc::audio::LinkMessage m; m.clock_domain = m.bankset = std::string(32, '0');
      m.lanes.push_back({static_cast<std::uint8_t>(id), diagnostic, group}); grc::audio::encode_link(m);
    } catch (...) { invalid("lane-config"); continue; }
    out.push_back({{static_cast<std::uint8_t>(id), diagnostic, group}, bus}); mask |= 1u << id;
  }
  return out;
}
void LaneState::apply(const Observation &op) {
  switch (op.op) {
    case 1: ++bank_loads; bank_unknown += !banks_.contains(op.text); break;
    case 2: ++bank_unloads; bank_unknown += !banks_.contains(op.text); break;
    case 3: events_[op.instance] = Event{op.text, {}, false, false}; break;
    case 4: if (auto i = events_.find(op.instance); i != events_.end()) i->second.playing = true; break;
    case 5: if (auto i = events_.find(op.instance); i != events_.end()) i->second.playing = false; break;
    case 6: events_.erase(op.instance); break;
    case 7: if (auto i = events_.find(op.instance); i != events_.end()) i->second.parameters[op.text] = op.value; break;
    case 8: globals_[op.text] = op.value; break;
    case 9: if (auto i = events_.find(op.instance); i != events_.end()) i->second.paused = op.value != 0; break;
    default: throw std::runtime_error("observe-protocol");
  }
}
struct LaneSystem::Capture {
  static inline std::array<std::atomic<Capture *>, 15> slots{};
  LaneConfig config;
  std::array<float, 1024> samples{};
  unsigned slot = 0, frames = 0;
  bool overflow = false;
  Bus *bus = nullptr; Group *group = nullptr; Dsp *dsp = nullptr;
  explicit Capture(LaneConfig lane) : config(std::move(lane)) {
    for (; slot < slots.size(); ++slot) { Capture *empty = nullptr; if (slots[slot].compare_exchange_strong(empty, this)) return; }
    throw std::runtime_error("create");
  }
  ~Capture() { slots[slot].store(nullptr); }
  template<unsigned N> static Result GRC_NATIVE_CALL read(DspState *, float *input, float *output, unsigned n, int channels, int *out_channels) {
#ifdef GRC_FMOD_TEST_CALLBACKS
    struct Phase { Phase(){grc_test_callback_phase(1);} ~Phase(){grc_test_callback_phase(0);} } phase;
#endif
    auto *capture = slots[N].load(std::memory_order_acquire);
    if (!capture || channels < 1 || channels > 32) return 1;
    *out_channels = channels; std::memcpy(output, input, std::size_t(n) * channels * sizeof(float));
    const unsigned count = std::min(n, 512 - capture->frames);
    if (count < n) capture->overflow = true;
    for (unsigned i = 0; i < count; ++i) {
      const auto at = (capture->frames + i) * 2;
      capture->samples[at] = input[i * channels]; capture->samples[at + 1] = input[i * channels + (channels > 1 ? 1 : 0)];
    }
    capture->frames += count; return ok;
  }
  DspRead callback() const {
    static constexpr std::array<DspRead, 15> functions{read<0>,read<1>,read<2>,read<3>,read<4>,read<5>,read<6>,read<7>,read<8>,read<9>,read<10>,read<11>,read<12>,read<13>,read<14>};
    return functions[slot];
  }
};
LaneSystem::LaneSystem(const RenderConfig &config, const std::vector<LaneConfig> &lanes, const LaneState &state) {
  try {
    api_.bind(config.core_lib.c_str(), config.studio_lib.c_str()); api_.bind_render(); api_.bind_lane();
    studio_ = api_.create();
    banks_ = std::make_unique<Banks>(config.source, config.pck_path, config.banks, config.wake, config.wake_self);
    if (!config.bankset.empty() && banks_->hash() != config.bankset) throw std::runtime_error("bank-load");
    check(api_.get_core(studio_, &core_)); check(api_.set_output(core_, 4)); check(api_.set_format(core_, 48000, 3, 0));
    check(api_.buffer_size(core_, 512, 4)); check(api_.initialize(studio_, 256, 4 | 16, 1 | 2, nullptr));
    banks_->load(api_, studio_); check(api_.update(studio_));
    Bus *master = nullptr; check(api_.get_bus(studio_, "bus:/master", &master)); check(api_.bus_volume(master, 1));
    for (const auto &lane : lanes) {
      captures_.push_back(std::make_unique<Capture>(lane)); auto &capture = *captures_.back();
      check(api_.get_bus(studio_, lane.bus.c_str(), &capture.bus)); check(api_.bus_volume(capture.bus, 1));
      check(api_.bus_lock(capture.bus)); check(api_.update(studio_)); check(api_.bus_group(capture.bus, &capture.group));
      DspDescription desc{}; desc.pluginsdkversion = 110; std::memcpy(desc.name, "grc live lane", 14);
      desc.version = 1; desc.numinputbuffers = desc.numoutputbuffers = 1; desc.read = capture.callback();
      check(api_.create_dsp(core_, &desc, &capture.dsp)); check(api_.add_dsp(capture.group, -2, capture.dsp));
    }
    for (const auto &[name, value] : state.globals()) observe({8, 0, name, value});
    for (const auto &[id, event] : state.events()) {
      observe({3, id, event.path, 0});
      for (const auto &[name, value] : event.parameters) observe({7, id, name, value});
      observe({9, id, "", event.paused ? 1.f : 0.f});
      if (event.playing) observe({4, id, "", 0});
    }
  } catch (...) { cleanup(); throw; }
}
LaneSystem::~LaneSystem() { cleanup(); }
void LaneSystem::cleanup() noexcept {
  for (const auto &[id, instance] : events_) { api_.event_stop(instance, 1); api_.event_release(instance); }
  events_.clear();
  for (auto &capture : captures_) {
    if (capture->dsp) { api_.remove_dsp(capture->group, capture->dsp); api_.release_dsp(capture->dsp); }
    if (capture->bus) api_.bus_unlock(capture->bus);
  }
  captures_.clear(); if (studio_) { api_.studio_release(studio_); studio_ = nullptr; } banks_.reset();
}
void LaneSystem::observe(const Observation &op) {
  auto it = events_.find(op.instance);
  if (op.op == 3) {
    if (it != events_.end()) { check(api_.event_stop(it->second, 1)); check(api_.event_release(it->second)); events_.erase(it); }
    Description *description = nullptr; check(api_.get_event(studio_, op.text.c_str(), &description));
    Instance *instance = nullptr; check(api_.instance_create(description, &instance)); events_[op.instance] = instance;
  } else if (op.op == 8) check(api_.global_parameter(studio_, op.text.c_str(), op.value, 0));
  else if (it != events_.end()) {
    switch (op.op) {
      case 4: check(api_.event_start(it->second)); break;
      case 5: check(api_.event_stop(it->second, op.value == 0 ? 0 : 1)); break;
      case 6: check(api_.event_release(it->second)); events_.erase(it); break;
      case 7: check(api_.parameter(it->second, op.text.c_str(), op.value, 0)); break;
      case 9: check(api_.event_paused(it->second, op.value != 0)); break;
    }
  }
}
void LaneSystem::render(std::uint16_t mask, std::uint32_t epoch, std::uint32_t index, std::uint64_t due,
                        const std::function<void(const grc::audio::BlockHeader &, const Bytes &)> &emit) {
  for (auto &capture : captures_) { capture->frames = 0; capture->overflow = false; capture->samples.fill(0); }
  check(api_.update(studio_)); if (banks_->failed()) throw std::runtime_error("bank-load");
  for (const auto &capture : captures_) if (mask & (1u << capture->config.wire.id)) {
    if (capture->overflow) throw std::runtime_error("fmod-off");
    Bytes pcm; pcm.reserve(2048); bool silent = true;
    for (float sample : capture->samples) {
      const auto value = static_cast<std::int16_t>(std::nearbyint(std::clamp(sample * 32767.f, -32768.f, 32767.f)));
      pcm.push_back(value & 255); pcm.push_back((static_cast<std::uint16_t>(value) >> 8) & 255); silent &= value == 0;
    }
    grc::audio::BlockHeader h; h.kind = 2; h.lane = capture->config.wire.id; h.stream = epoch;
    h.block = index; h.frames = 512; h.due_us = due; h.made_us = now_us();
    h.flags = (index == 0 ? 1 : 0) | (silent ? 4 : 0); if (silent) pcm.clear();
    emit(h, pcm);
  }
}
}
