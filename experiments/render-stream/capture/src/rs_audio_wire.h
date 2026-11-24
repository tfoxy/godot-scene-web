// Pure render-stream-audio/1 codecs; no capture, engine or carrier dependencies.
#ifndef GRC_RS_AUDIO_WIRE_H
#define GRC_RS_AUDIO_WIRE_H
#include <cstdint>
#include <string>
#include <string_view>
#include <utility>
#include <vector>
namespace grc::audio {
using Bytes = std::vector<std::uint8_t>;
// Invalid wire values throw std::invalid_argument("audio-protocol"). Decoders
// consume exactly one complete message. Stream ordering/uniqueness is the caller's job.
std::string hex(const Bytes &bytes);
Bytes unhex(std::string_view value, std::size_t size = static_cast<std::size_t>(-1));
std::string float_r(float value);
std::string canonical_key(std::string_view path,
    std::vector<std::pair<std::string, float>> params = {});
std::string key_id(std::string_view canonical);
struct BlockHeader {
  std::uint8_t kind = 1, flags = 0, lane = 0, codec = 0, channels = 2;
  std::uint32_t stream = 1, block = 0, rate = 48000;
  std::uint16_t frames = 1;
  std::uint64_t made_us = 0, due_us = 0, sent_us = 0;
  bool operator==(const BlockHeader &) const = default;
};
struct BlockContext {
  std::uint16_t lane_mask = 0xfffe;
  std::uint16_t lane_block_frames = 512;
};
struct Block { BlockHeader header; Bytes payload; };
Block decode_block(const Bytes &, BlockContext = {});
Bytes encode_block(const BlockHeader &, const Bytes &, BlockContext = {});
struct LinkLane {
  std::uint8_t id = 0;
  std::string name, group;
  bool operator==(const LinkLane &) const = default;
};
// Only fields belonging to type are encoded; ignored fields decode to defaults.
struct LinkMessage {
  std::uint8_t type = 0, reason = 0;
  std::uint16_t version = 1, lane_mask = 0;
  std::string clock_domain, bankset, key_id, wav_sha256, key;
  std::vector<LinkLane> lanes;
  Bytes block;
  std::uint32_t stream = 0, frames = 0;
  std::uint64_t t_us = 0;
  bool operator==(const LinkMessage &) const = default;
};
LinkMessage decode_link(const Bytes &);
Bytes encode_link(const LinkMessage &);
struct MediaPrefix {
  std::uint8_t kind = 2, lane = 0;
  std::string key_id;
  bool operator==(const MediaPrefix &) const = default;
};
MediaPrefix decode_prefix(const Bytes &);
Bytes encode_prefix(const MediaPrefix &);
}  // namespace grc::audio
#endif
