// Engine-free synthetic host and ordered in-process product transport.
#ifndef GRC_RS_AUDIO_REFERENCE_H
#define GRC_RS_AUDIO_REFERENCE_H
#include "grc_audio_cue.h"
#include "grc_audio_link.h"
#include "rs_audio_wire.h"
#include <condition_variable>
#include <deque>
#include <mutex>
#include <thread>
namespace grc::audio {
class ReferenceLink {
 public:
  ReferenceLink();
  ~ReferenceLink();
  int cue();
  void disconnect();
 private:
  static int output(void *self, const std::uint8_t *msg, std::size_t len);
  bool send(const LinkMessage &msg);
  void take(const LinkMessage &want);
  // A real-time lane media clock; only a nonzero subscription mask arms it.
  void run();
  grc_audio_cue_v1 cue_{};
  std::array<std::uint8_t,16> id_{};
  std::mutex mu_;
  std::condition_variable cv_;
  std::deque<Bytes> incoming_;
  bool stopping_=false, ready_=false, failed_=false;
  std::thread worker_;
  std::uint32_t next_take_=1;
};
} // namespace grc::audio
#endif
