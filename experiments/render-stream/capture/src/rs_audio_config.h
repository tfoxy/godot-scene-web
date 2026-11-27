// Audio arm configuration, shared by the capture and the engine-free host.
#ifndef GRC_RS_AUDIO_CONFIG_H
#define GRC_RS_AUDIO_CONFIG_H
#include <algorithm>
#include <cstdlib>
#include <string>
#include <string_view>
#include <vector>
#include "rs_platform.h"
namespace grc::audio {
struct Config {
  bool godot_sample = true;
  unsigned queue_bytes = 32768;
  unsigned lane_late_ms = 60;
  unsigned stall_ms = 3000;
  unsigned store_max_ms = 10000;
  std::vector<std::string> no_store_buses;
};
inline bool configure(bool granted, Config *out, std::string *error) {
  *out = Config{};
  // Read through rs::env so a value the host process sets after start is seen on Windows too.
  if (!granted) {
    if (rs::env_any_with_prefix("GRC_LIVE_AUDIO_")) { *error = "audio-not-granted"; return false; }
    return true;
  }
  const auto fail = [&](const char *reason) { *error = reason; return false; };
  if (const char *v = rs::env("GRC_LIVE_AUDIO_GODOT")) {
    if (std::string_view(v) != "sample" && std::string_view(v) != "off") return fail("audio-godot-invalid");
    out->godot_sample = std::string_view(v) == "sample";
  }
  const auto number = [&](const char *name, unsigned lo, unsigned hi, unsigned *dest, const char *reason) {
    const char *v = rs::env(name);
    if (!v) return true;
    if (!*v) return fail(reason);
    unsigned n = 0;
    for (; *v; ++v) {
      if (*v < '0' || *v > '9' || n > hi / 10) return fail(reason);
      n = n * 10 + unsigned(*v - '0');
      if (n > hi) return fail(reason);
    }
    if (n < lo) return fail(reason);
    *dest = n; return true;
  };
  if (!number("GRC_LIVE_AUDIO_QUEUE_BYTES", 4096, 1048576, &out->queue_bytes, "audio-queue-bytes-invalid") ||
      !number("GRC_LIVE_AUDIO_LANE_LATE_MS", 10, 1000, &out->lane_late_ms, "audio-lane-late-ms-invalid") ||
      !number("GRC_LIVE_AUDIO_STALL_MS", 500, 30000, &out->stall_ms, "audio-stall-ms-invalid") ||
      !number("GRC_LIVE_AUDIO_STORE_MAX_MS", 1000, 60000, &out->store_max_ms, "audio-store-max-ms-invalid")) return false;
  if (const char *v = rs::env("GRC_LIVE_AUDIO_NO_STORE_BUSES")) {
    std::string value(v);
    for (std::size_t start = 0; start < value.size();) {
      auto end = value.find(',', start);
      if (end == std::string::npos) end = value.size();
      const std::string bus = value.substr(start, end - start);
      if (bus.empty() || std::any_of(bus.begin(), bus.end(), [](unsigned char c) { return c < 32 || c == 127; }))
        return fail("audio-no-store-buses-invalid");
      out->no_store_buses.push_back(bus);
      if (end + 1 == value.size()) return fail("audio-no-store-buses-invalid");
      start = end + 1;
    }
  }
  return true;
}
}  // namespace grc::audio
#endif
