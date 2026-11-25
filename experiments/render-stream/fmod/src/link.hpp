#ifndef GRC_FMOD_LINK_HPP
#define GRC_FMOD_LINK_HPP
#include "cache.hpp"
#include "rs_audio_wire.h"
#include <map>
namespace grc::fmod {
// Owned exclusively by the module thread. Products only move whole messages.
class Link {
 public:
  using Log = std::function<void(std::uint32_t, const std::string &)>;
  using Send = std::function<void(std::uint32_t, const Bytes &)>;
  using Request = std::function<void(std::uint32_t, std::uint64_t, const grc::audio::LinkMessage &)>;
  Link(std::string domain, std::string bankset, std::vector<grc::audio::LinkLane>, Send, Request, Log = {});
  void open(std::uint32_t seat);
  void close(std::uint32_t seat);
  void input(std::uint32_t seat, const Bytes &);
  void take(std::uint32_t seat, std::uint64_t generation, const grc::audio::LinkMessage &, SharedTake);
  void lane(const grc::audio::BlockHeader &, const Bytes &);
  std::uint16_t mask() const;
  void disable();
 private:
  struct Seat { std::uint64_t generation; bool up = false, failed = false; std::uint16_t mask = 0; std::vector<std::string> pending; };
  std::string domain_, bankset_;
  std::vector<grc::audio::LinkLane> lanes_;
  Send send_;
  Request request_;
  Log log_;
  std::map<std::uint32_t, Seat> seats_;
  std::uint64_t generation_ = 0;
  std::uint32_t stream_ = 0;
  bool on_ = true;
  void send(std::uint32_t, const grc::audio::LinkMessage &);
  void unavailable(std::uint32_t, const std::string &, std::uint8_t);
};
}
#endif
