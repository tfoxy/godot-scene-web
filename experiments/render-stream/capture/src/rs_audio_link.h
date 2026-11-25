#ifndef GRC_RS_AUDIO_LINK_H
#define GRC_RS_AUDIO_LINK_H
#include "grc_audio_link.h"
#include "report.h"
#include "rs_audio_cue.h"
#include "rs_audio_sender.h"
#include <deque>
#include <optional>
#include <set>
namespace grc::audio {
std::string clock_domain();
// Stable boot-instant encoding, also exercised on Linux for the native ports.
std::string boot_clock_domain(std::string_view platform, std::uint64_t seconds);
// Endpoint routing and callback lifetime share one mutex. Carrier calls remain
// sender-owned; only drain() invokes the product's non-reentrant callback.
class Link {
 public:
  explicit Link(Sender &sender);
  ~Link();
  void shutdown();
  int attach(const grc_audio_link_v1 *link);
  int input(const std::uint8_t *msg, std::size_t len);
  void drain();
  // Bound distinct cold keys independently of producer-ring drain frequency.
  static constexpr std::size_t pending_relay_limit = 1024;
  std::string advertise(std::uint32_t conn);
  void opened(std::uint32_t conn, const std::function<void(const std::string &, const std::string &)> &snapshot);
  void removed(std::uint32_t conn);
  void have(std::uint32_t conn, const std::string &bankset, std::set<std::string> ids);
  bool lanes(std::uint32_t conn, std::uint16_t mask);
  void groups(const std::string &snapshot);
  void cue(const CueRecord &record);
#if defined(GRC_AUDIO_LINK_TESTING)
  void test_relay_to_all() { std::lock_guard lock(mu_); relay_to_all_ = true; }
#endif
  std::string bankset() const;
  std::string lane_snapshot() const;
  void evidence(JsonWriter &j) const;
 private:
  struct Connection { std::set<std::string> have; std::uint16_t lanes = 0; bool published = false; };
  struct Take {
    std::set<std::uint32_t> recipients, waiting;
    std::string key;
    std::uint64_t t_us = 0;
    std::uint32_t stream = 0, frames = 0, received = 0, next_block = 0;
    std::optional<Block> last;
  };
  bool needs(const Connection &c, const std::string &id) const;
  void down(const std::string &reason, bool detach = false);
  void unavailable(const std::string &id, const Take &take, const std::string &reason);
  void want(const std::string &id, const Take &take);
  void finished(std::map<std::string, Take>::iterator take);
  void lane_states();
  std::string lane_snapshot_locked() const;
  void prune();
  void resync(std::uint16_t code, const char *reason);
  std::uint16_t union_mask() const;
  std::uint16_t effective_mask(const Connection &c) const;
  void update_mask();
  bool receive(const LinkMessage &m);
  Sender &sender_;
  mutable std::mutex mu_;
  grc_audio_link_v1 api_{};
  std::string state_ = "detached", reason_, domain_, bankset_ = std::string(32, '0');
  std::vector<LinkLane> lanes_;
  std::set<std::string> muted_;
  std::map<std::uint32_t, Connection> conns_;
  std::map<std::string, Take> pending_;
  std::set<std::uint32_t> streams_;
  std::deque<Bytes> out_;
#if defined(GRC_AUDIO_LINK_TESTING)
  bool relay_to_all_ = false;
#endif
  std::uint16_t sent_mask_ = 0;
  std::uint64_t wants_ = 0, relayed_blocks_ = 0, relayed_bytes_ = 0;
};
} // namespace grc::audio
#endif
