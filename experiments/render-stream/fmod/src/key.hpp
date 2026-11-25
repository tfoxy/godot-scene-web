#ifndef GRC_FMOD_KEY_HPP
#define GRC_FMOD_KEY_HPP
#include "rs_audio_wire.h"
#include <charconv>
#include <stdexcept>
namespace grc::fmod {
struct ParsedKey {
  std::string path;
  std::vector<std::pair<std::string, float>> parameters;
};
// Both the seat boundary and renderer require the exact wire canonical spelling.
inline ParsedKey parse_key(const std::string &key) {
  const auto bar = key.find('|');
  const auto path = key.substr(0, bar);
  std::vector<std::pair<std::string, float>> parameters;
  if (bar != std::string::npos) {
    for (auto pos = bar + 1; pos < key.size();) {
      const auto end = key.find(',', pos), equal = key.find('=', pos);
      const auto stop = end == std::string::npos ? key.size() : end;
      if (equal == std::string::npos || equal >= stop) throw std::runtime_error("audio-protocol");
      float value = 0;
      const auto parsed = std::from_chars(key.data() + equal + 1, key.data() + stop, value);
      if (parsed.ec != std::errc{} || parsed.ptr != key.data() + stop) throw std::runtime_error("audio-protocol");
      parameters.emplace_back(key.substr(pos, equal - pos), value); pos = stop + 1;
    }
  }
  if (grc::audio::canonical_key(path, parameters) != key) throw std::runtime_error("audio-protocol");
  return {path, std::move(parameters)};
}
}
#endif
