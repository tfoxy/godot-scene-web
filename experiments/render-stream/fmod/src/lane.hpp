#ifndef GRC_FMOD_LANE_HPP
#define GRC_FMOD_LANE_HPP
#include "take.hpp"
#include "rs_audio_wire.h"
#include <map>
#include <set>
namespace grc::fmod {
struct LaneConfig { grc::audio::LinkLane wire; std::string bus; };
std::vector<LaneConfig> parse_lanes(const std::string &, const std::function<void(const std::string &)> &invalid);
struct Observation { std::uint32_t op; std::uint64_t instance; std::string text; float value; };
// Retains the current live state, never PCM or a prior event timeline.
class LaneState {
 public:
  struct Event { std::string path; std::map<std::string, float> parameters; bool playing = false, paused = false; };
  explicit LaneState(std::vector<std::string> banks = {}) : banks_(banks.begin(), banks.end()) {}
  void apply(const Observation &);
  std::uint64_t bank_loads = 0, bank_unloads = 0, bank_unknown = 0;
  const std::map<std::uint64_t, Event> &events() const { return events_; }
  const std::map<std::string, float> &globals() const { return globals_; }
 private:
  std::map<std::uint64_t, Event> events_;
  std::map<std::string, float> globals_;
  std::set<std::string> banks_;
};
class LaneSystem {
 public:
  LaneSystem(const RenderConfig &, const std::vector<LaneConfig> &, const LaneState &);
  ~LaneSystem();
  void observe(const Observation &);
  void render(std::uint16_t mask, std::uint32_t epoch, std::uint32_t index, std::uint64_t due,
              const std::function<void(const grc::audio::BlockHeader &, const Bytes &)> &);
 private:
  struct Capture;
  Api api_;
  std::unique_ptr<Banks> banks_;
  Studio *studio_ = nullptr;
  Core *core_ = nullptr;
  std::vector<std::unique_ptr<Capture>> captures_;
  std::map<std::uint64_t, Instance *> events_;
  void cleanup() noexcept;
};
}
#endif
