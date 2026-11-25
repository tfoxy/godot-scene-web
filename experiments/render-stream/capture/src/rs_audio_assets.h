// Audio assets share the view resource route, credential and origin checks.
#pragma once
#include "rs_ws.h"
#include "rs_audio_wire.h"
#include "rs_sha256.h"
#include <map>
#include <mutex>
#include <functional>

namespace grc::audio {
struct OggPage { int64_t granule = 0; std::vector<Bytes> packets; };
// Empty means the stored page cannot be represented as one legal Ogg page.
Bytes remux_ogg(const std::vector<OggPage> &pages);
Bytes pcm16_wav(const std::vector<float> &interleaved, uint32_t rate, uint32_t channels);
struct Mp3Format { uint32_t rate = 0, channels = 0; };
Mp3Format mp3_format(const Bytes &bytes);
class Assets {
 public:
  using Payload = std::shared_ptr<const rs::PageBytes>;
  struct Body { Payload bytes; bool store = true; std::string codec; };
  std::string put(uint32_t id, Bytes bytes, const char *codec, bool store, uint64_t now);
  void release(uint32_t id, uint64_t now);
  void no_store(uint32_t id);
  Body get(std::string_view hash, uint64_t now);
  void sweep(uint64_t now);
 private:
  struct Entry { Body body; std::map<uint32_t, bool> owners; uint64_t expires = 0; };
  std::mutex mu_;
  std::map<std::string, Entry, std::less<>> entries_;
};
Assets &godot_assets();
class AudioResources final : public live::ResourceSource {
 public:
  explicit AudioResources(live::ResourceSource &view) : view_(view) {}
  Assets::Payload lookup(std::string_view hash) override;
  live::ResourceBody lookup_body(std::string_view hash, live::Coding accepted) override;
  bool lookup_coded_body(std::string_view hash, live::Coding coding, live::ResourceBody *out) override;
  bool no_store(std::string_view hash) override;
 private:
  live::ResourceSource &view_;
};
}  // namespace grc::audio
