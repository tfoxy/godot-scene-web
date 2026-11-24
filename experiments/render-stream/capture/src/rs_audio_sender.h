// Audio queues own payloads until carrier hand-off. The worker never calls a legacy carrier.
#ifndef GRC_RS_AUDIO_SENDER_H
#define GRC_RS_AUDIO_SENDER_H
#include "rs_audio_config.h"
#include "rs_audio_wire.h"
#include "rs_live.h"
#include <array>
#include <condition_variable>
#include <deque>
#include <map>
#include <mutex>
#include <thread>
namespace grc::audio {
std::uint64_t now_us();
// Additive seam; ordinary view transports need not implement it.
class MediaTransport {
 public:
  virtual ~MediaTransport() = default;
  virtual bool media_threaded(std::uint32_t conn) const = 0;
  virtual bool send_media(std::uint32_t conn, std::uint8_t cls, std::uint32_t group,
                          std::uint32_t flags, std::uint64_t deadline_us, Bytes message) = 0;
};
class Sender {
 public:
  struct Close { std::uint32_t conn; std::uint16_t code; std::string reason; };
  struct Stats {
    std::array<std::uint64_t, 3> sent{}, dropped{};
    std::uint64_t gaps = 0, stalls = 0, max_lateness_us = 0, backpressured_lane_drops = 0;
    std::uint64_t payload_messages = 0, payload_bytes = 0;
    std::map<std::string, std::uint64_t> texts;
  };
  struct Evidence { Stats stats; std::string carrier; bool threaded = false, closed = false; };
  // Automatic worker in production; deterministic pump() and supplied capture times in tests.
  Sender(Config config, rs2::LiveTransport &transport, bool automatic = true);
  ~Sender();
  void add(std::uint32_t conn, std::string carrier = {});
  void remove(std::uint32_t conn);
  bool text(std::uint32_t conn, std::string text, bool stamp = false,
            std::uint64_t at_us = 0);
  bool block(std::uint32_t conn, Block block, std::string after = {}, std::uint64_t at_us = 0);
  void close(std::uint32_t conn, std::uint16_t code, std::string reason);
  void shutdown();
  void frame();
  void pump(bool threaded, std::uint64_t at_us);
  std::vector<Close> take_closes();
  Stats stats(std::uint32_t conn) const;
  std::map<std::uint32_t, Evidence> evidence() const;
 private:
  struct Message {
    std::string text, after;
    Block block;
    bool binary = false, stamp = false;
    std::uint64_t enqueued_us = 0;
    std::uint16_t close_code = 0;
  };
  struct Connection {
    bool threaded = false, closing = false;
    std::string carrier;
    std::array<std::deque<Message>, 3> queues;
    std::uint16_t gaps = 0;
    Stats stats;
  };
  void run();
  Config config_;
  rs2::LiveTransport &transport_;
  MediaTransport *media_;
  bool automatic_, stopping_ = false;
  mutable std::mutex mu_;
  std::condition_variable cv_;
  std::map<std::uint32_t, Connection> conns_;
  std::vector<Close> closes_;
  std::map<std::uint32_t, Evidence> retired_;
  std::thread thread_;
};
}  // namespace grc::audio
#endif
