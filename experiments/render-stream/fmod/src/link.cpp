#include "link.hpp"
#include "clock.hpp"
#include "key.hpp"
#include <algorithm>
#include <limits>
#include <stdexcept>
namespace grc::fmod {
using grc::audio::LinkMessage;
Link::Link(std::string domain, std::string bankset, std::vector<grc::audio::LinkLane> lanes, Send send, Request request, Log log)
  : domain_(std::move(domain)), bankset_(std::move(bankset)), lanes_(std::move(lanes)), send_(std::move(send)), request_(std::move(request)), log_(std::move(log)) {}
void Link::send(std::uint32_t seat, const LinkMessage &message) { send_(seat, grc::audio::encode_link(message)); }
void Link::unavailable(std::uint32_t seat, const std::string &key, std::uint8_t reason) {
  LinkMessage m; m.type = 4; m.key_id = key; m.reason = reason; send(seat, m);
}
void Link::open(std::uint32_t seat) {
  seats_.insert_or_assign(seat, Seat{++generation_, false, false, 0, {}});
  LinkMessage m; m.clock_domain = domain_; m.bankset = bankset_; m.lanes = lanes_; send(seat, m);
}
void Link::close(std::uint32_t seat) { seats_.erase(seat); }
void Link::input(std::uint32_t seat, const Bytes &bytes) {
  auto it = seats_.find(seat); if (it == seats_.end()) return;
  auto &state = it->second;
  try {
    auto message = grc::audio::decode_link(bytes);
    if (message.type == 0) {
      if (state.up || state.failed || domain_ == std::string(32, '0') || message.clock_domain != domain_ ||
          message.bankset != std::string(32, '0') || !message.lanes.empty()) throw std::runtime_error("clock-domain");
      state.up = true;
    } else if (message.type == 5) {
      if (!on_ || !state.up || state.failed) { unavailable(seat, message.key_id, on_ ? 4 : 3); return; }
      state.pending.push_back(message.key_id);
      try {
        parse_key(message.key);
        if (grc::audio::key_id(message.key) != message.key_id) throw std::runtime_error("link-protocol");
      } catch (const std::exception &) { throw std::runtime_error("link-protocol"); }
      request_(seat, state.generation, message);
    } else if (message.type == 6) {
      if (!state.up || state.failed || !on_) return;
      std::uint16_t allowed = 0; for (const auto &lane : lanes_) allowed |= 1u << lane.id;
      if (message.lane_mask & ~allowed) throw std::runtime_error("link-protocol");
      state.mask = message.lane_mask;
    } else throw std::runtime_error("link-protocol");
  } catch (const std::exception &error) {
    if (!state.failed && log_) log_(seat, error.what());
    state.up = false; state.failed = true; state.mask = 0; ++state.generation;
    for (const auto &key : state.pending) unavailable(seat, key, 4);
    state.pending.clear();
  }
}
void Link::take(std::uint32_t seat, std::uint64_t generation, const LinkMessage &want, SharedTake take) {
  const auto it = seats_.find(seat);
  if (it == seats_.end() || it->second.generation != generation || !it->second.up || it->second.failed) return;
  auto &pending = it->second.pending;
  const auto found = std::find(pending.begin(), pending.end(), want.key_id);
  if (found == pending.end()) return;
  pending.erase(found);
  if (!on_) { unavailable(seat, want.key_id, 3); return; }
  if (!take || !take->reason.empty()) {
    const auto reason = take ? take->reason : "fmod-off";
    std::uint8_t code = reason == "refused-not-oneshot" ? 0 : reason == "refused-bus" ? 1 : reason == "unknown-event" ? 2 : 3;
    unavailable(seat, want.key_id, code); return;
  }
  if (stream_ == std::numeric_limits<std::uint32_t>::max()) throw std::runtime_error("fmod-off");
  const auto stream = ++stream_;
  LinkMessage m; m.type = 2; m.key_id = want.key_id; m.stream = stream; m.frames = take->frames; send(seat, m);
  for (std::uint32_t offset = 0, block = 0; offset < take->frames; ++block) {
    const auto count = std::min(2048u, take->frames - offset);
    const auto begin = take->wav.begin() + 44 + offset * 4;
    Bytes pcm(begin, begin + count * 4);
    grc::audio::BlockHeader h; h.stream = stream; h.block = block; h.frames = count;
    h.flags = (offset == 0 ? 1 : 0) | (offset + count == take->frames ? 2 : 0);
    h.made_us = now_us(); h.due_us = want.t_us + std::uint64_t(offset) * 1000000 / 48000;
    m = {}; m.type = 1; m.block = grc::audio::encode_block(h, pcm); send(seat, m); offset += count;
  }
  m = {}; m.type = 3; m.key_id = want.key_id; m.stream = stream; m.wav_sha256 = take->hash; send(seat, m);
}
void Link::lane(const grc::audio::BlockHeader &header, const Bytes &pcm) {
  if (!on_) return;
  LinkMessage m; m.type = 1; m.block = grc::audio::encode_block(header, pcm);
  for (const auto &[seat, state] : seats_)
    if (state.up && !state.failed && (state.mask & (1u << header.lane))) send(seat, m);
}
std::uint16_t Link::mask() const {
  std::uint16_t mask = 0;
  if (on_) for (const auto &[seat, state] : seats_) if (state.up && !state.failed) mask |= state.mask;
  return mask;
}
void Link::disable() {
  on_ = false;
  for (auto &[seat, state] : seats_) {
    state.mask = 0;
    for (const auto &key : state.pending) unavailable(seat, key, 3);
    state.pending.clear();
  }
}
}
