// Capture-owned audio receiver. State outlives connections; ids are seat assigned and monotonic.
#ifndef GRC_RS_AUDIO_HUB_H
#define GRC_RS_AUDIO_HUB_H
#include "rs_audio_sender.h"
#include "rs_audio_cue.h"
#include "rs_audio_link.h"
#include <set>
namespace grc::audio {
class Hub {
 public:
  Hub(Config config, rs2::LiveTransport &transport, bool synthetic_demo = false, bool source_armed = false, bool automatic = true);
  ~Hub();
  static Bytes synthetic_wav();
  Sender &sender() { return sender_; }
  std::string ready(std::uint32_t conn = 0);
  void opened(std::uint32_t conn);
  void removed(std::uint32_t conn);
  bool message(std::uint32_t conn, const std::string &text);
  // Event producers enqueue without touching the carrier. No engine API is called here.
  std::uint32_t sample(std::string members);
  void sample_drop(std::uint32_t sample);
  std::uint32_t start(std::uint32_t sample);
  void stop(std::uint32_t voice);
  void shutdown();
  // Count only successful resource lookups; no asset contents or cue keys enter evidence.
  void asset_served(const std::string &hash, const std::string &codec, std::uint64_t bytes);
  std::string json() const;
  void synthetic_cue();
  // Sender worker callback; deterministic tests may drain with automatic=false.
  void drain_cues();
#if defined(GRC_AUDIO_LINK_TESTING)
  std::function<void()> test_before_snapshot;
  void test_relay_to_all() { link_.test_relay_to_all(); }
#endif
  bool cue_source() const { return cue_attached(); }
 private:
  struct Connection { std::set<std::string> have; std::string have_bank; bool have_reset = false; std::uint16_t lanes = 0; };
  static std::string event(std::string type, std::string members, std::uint64_t at_us = 0);
  void broadcast(const std::string &text);
  void demo(std::uint32_t conn);
  void media_clock();
  CueIngress &cues_;
  Sender sender_;
  Link link_;
  bool demo_, source_armed_, godot_sample_, stopping_ = false;
  mutable std::mutex mu_;
  std::condition_variable cv_;
  std::map<std::uint32_t, Connection> conns_;
  std::map<std::uint32_t, std::string> samples_, voices_;
  std::uint64_t next_sample_ = 1, next_voice_ = 1, next_take_ = 1;
  std::uint32_t lane_epoch_ = 0, lane_block_ = 0;
  std::thread clock_;
  struct AssetStats { std::uint64_t hits = 0, bytes = 0; };
  std::map<std::pair<std::string, std::string>, AssetStats> assets_;
};
}  // namespace grc::audio
#endif
