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
  struct Event {
    std::string path;
    std::map<std::string, float> parameters;
    std::map<std::string, std::string> labels;
    // Assignments preceding labels that have not yet been checked by FMOD.
    std::map<std::string, std::vector<Observation>> label_fallbacks;
    bool playing = false, paused = false;
  };
  explicit LaneState(std::vector<std::string> banks = {}) : banks_(banks.begin(), banks.end()) {}
  bool apply(const Observation &);
  std::uint64_t bank_loads = 0, bank_unloads = 0, bank_unknown = 0;
  std::uint64_t label_malformed = 0, parameter_unknown = 0;
  const std::map<std::uint64_t, Event> &events() const { return events_; }
  const std::map<std::string, float> &globals() const { return globals_; }
  const std::map<std::string, std::string> &global_labels() const { return global_labels_; }
 private:
  friend class LaneSystem;
  std::vector<Observation> take_parameters(std::uint64_t instance, bool global);
  void label_result(const Observation &, bool accepted);
  std::map<std::uint64_t, Event> events_;
  std::map<std::string, float> globals_;
  std::map<std::string, std::string> global_labels_;
  std::map<std::string, std::vector<Observation>> global_label_fallbacks_;
  std::set<std::string> banks_;
};
class LaneSystem {
 public:
  LaneSystem(const RenderConfig &, const std::vector<LaneConfig> &, LaneState &);
  ~LaneSystem();
  void observe(const Observation &);
  void render(std::uint16_t mask, std::uint32_t epoch, std::uint32_t index, std::uint64_t due,
              const std::function<void(const grc::audio::BlockHeader &, const Bytes &)> &);
 private:
  struct Capture;
  Api api_;
  LaneState &state_;
  std::unique_ptr<Banks> banks_;
  Studio *studio_ = nullptr;
  Core *core_ = nullptr;
  std::vector<std::unique_ptr<Capture>> captures_;
  std::map<std::uint64_t, Instance *> events_;
  void cleanup() noexcept;
};
}
#endif
