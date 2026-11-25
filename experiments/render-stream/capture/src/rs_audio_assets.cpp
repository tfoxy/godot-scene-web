#include "rs_audio_assets.h"
#include "rs_audio_sender.h"
#include <algorithm>
#include <cmath>
#include <chrono>
namespace grc::audio {
namespace {
uint64_t asset_now() { return uint64_t(std::chrono::duration_cast<std::chrono::microseconds>(std::chrono::steady_clock::now().time_since_epoch()).count()); }
void number(Bytes &out, uint64_t value, unsigned n) {
  for (unsigned i = 0; i < n; ++i) out.push_back(uint8_t(value >> (8 * i)));
}
void tag(Bytes &out, const char *value) { out.insert(out.end(), value, value + 4); }
}
Bytes remux_ogg(const std::vector<OggPage> &pages) {
  if (pages.empty()) return {};
  Bytes result;
  for (size_t i = 0; i < pages.size(); ++i) {
    const auto &page = pages[i]; Bytes laces, body;
    for (const auto &packet : page.packets) {
      size_t n = packet.size();
      while (n >= 255) { laces.push_back(255); n -= 255; }
      laces.push_back(uint8_t(n));
      body.insert(body.end(), packet.begin(), packet.end());
    }
    if (laces.empty() || laces.size() > 255) return {};
    Bytes out; tag(out, "OggS"); out.push_back(0);
    out.push_back(uint8_t((i == 0 ? 2 : 0) | (i + 1 == pages.size() ? 4 : 0)));
    number(out, uint64_t(page.granule), 8); number(out, 1, 4); number(out, i, 4);
    number(out, 0, 4); out.push_back(uint8_t(laces.size()));
    out.insert(out.end(), laces.begin(), laces.end()); out.insert(out.end(), body.begin(), body.end());
    uint32_t crc = 0;
    for (auto byte : out) {
      crc ^= uint32_t(byte) << 24;
      for (unsigned b = 0; b < 8; ++b) crc = (crc << 1) ^ ((crc & 0x80000000u) ? 0x04c11db7u : 0);
    }
    for (unsigned b = 0; b < 4; ++b) out[22 + b] = uint8_t(crc >> (b * 8));
    result.insert(result.end(), out.begin(), out.end());
  }
  return result;
}
Bytes pcm16_wav(const std::vector<float> &pcm, uint32_t rate, uint32_t channels) {
  if (!rate || (channels != 1 && channels != 2) || pcm.size() % channels || pcm.size() > (UINT32_MAX - 36) / 2) return {};
  Bytes out; out.reserve(44 + pcm.size() * 2);
  tag(out, "RIFF"); number(out, 36 + pcm.size() * 2, 4); tag(out, "WAVE"); tag(out, "fmt ");
  number(out, 16, 4); number(out, 1, 2); number(out, channels, 2); number(out, rate, 4);
  number(out, rate * channels * 2, 4); number(out, channels * 2, 2); number(out, 16, 2);
  tag(out, "data"); number(out, pcm.size() * 2, 4);
  for (auto f : pcm) {
    if (!std::isfinite(f)) f = 0;
    const auto sample = int16_t(std::clamp(std::lround(double(f) * 32768), -32768l, 32767l));
    number(out, uint16_t(sample), 2);
  }
  return out;
}
Mp3Format mp3_format(const Bytes &bytes) {
  size_t begin = 0;
  if (bytes.size() >= 3 && bytes[0] == 'I' && bytes[1] == 'D' && bytes[2] == '3') {
    if (bytes.size() < 10) return {};
    size_t size = 0;
    for (size_t i = 6; i < 10; ++i) {
      if (bytes[i] & 0x80) return {};  // ID3v2 lengths are syncsafe (seven bits per byte).
      size = (size << 7) | bytes[i];
    }
    begin = 10 + size + ((bytes[5] & 0x10) ? 10 : 0);
    if (begin > bytes.size()) return {};
  }
  for (size_t i = begin; i + 4 <= bytes.size(); ++i) {
    auto a = bytes[i], b = bytes[i + 1], c = bytes[i + 2];
    unsigned version = (b >> 3) & 3, index = (c >> 2) & 3;
    if (a != 255 || (b & 0xe0) != 0xe0 || version == 1 || ((b >> 1) & 3) != 1 || index == 3 || !(c >> 4) || (c >> 4) == 15) continue;
    constexpr unsigned rates[] = {44100, 48000, 32000};
    return {rates[index] / (version == 3 ? 1u : version == 2 ? 2u : 4u), (bytes[i + 3] >> 6) == 3 ? 1u : 2u};
  }
  return {};
}
Assets &godot_assets() { static Assets assets; return assets; }
std::string Assets::put(uint32_t id, Bytes bytes, const char *codec, bool store, uint64_t now) {
  const auto hash = sha256_hex(bytes.data(), bytes.size());
  std::lock_guard lock(mu_);
  auto &e = entries_[hash];
  if (!e.body.bytes) e.body = {std::make_shared<const Bytes>(std::move(bytes)), store, codec};
  e.body.store &= store; e.owners[id] = true; e.expires = now + 30000000;
  return hash;
}
void Assets::release(uint32_t id, uint64_t now) {
  std::lock_guard lock(mu_);
  for (auto &[hash, e] : entries_) {
    (void)hash;
    if (e.owners.erase(id) && e.owners.empty()) e.expires = now + 30000000;
  }
}
void Assets::no_store(uint32_t id) {
  std::lock_guard lock(mu_);
  for (auto &[hash, e] : entries_) { (void)hash; if (e.owners.count(id)) e.body.store = false; }
}
Assets::Body Assets::get(std::string_view hash, uint64_t now) {
  std::lock_guard lock(mu_);
  auto at = entries_.find(hash);
  if (at == entries_.end()) return {};
  if (at->second.owners.empty() && now >= at->second.expires) { entries_.erase(at); return {}; }
  return at->second.body;
}
void Assets::sweep(uint64_t now) {
  std::lock_guard lock(mu_);
  for (auto i = entries_.begin(); i != entries_.end();) {
    if (i->second.owners.empty() && now >= i->second.expires) i = entries_.erase(i); else ++i;
  }
}
std::shared_ptr<const Bytes> AudioResources::lookup(std::string_view hash) {
  auto asset = godot_assets().get(hash, asset_now()); return asset.bytes ? asset.bytes : view_.lookup(hash);
}
live::ResourceBody AudioResources::lookup_body(std::string_view hash, live::Coding accepted) {
  auto asset = godot_assets().get(hash, asset_now());
  if (!asset.bytes) return view_.lookup_body(hash, accepted);
  return {asset.bytes, live::Coding::Identity, asset.bytes->size(), nullptr};
}
bool AudioResources::lookup_coded_body(std::string_view hash, live::Coding coding, live::ResourceBody *out) {
  auto asset = godot_assets().get(hash, asset_now());
  if (!asset.bytes) return view_.lookup_coded_body(hash, coding, out);
  out->identity_bytes = asset.bytes->size();
  if (coding == live::Coding::Identity) out->bytes = asset.bytes;
  return true;
}
bool AudioResources::no_store(std::string_view hash) {
  auto asset = godot_assets().get(hash, asset_now()); return asset.bytes ? !asset.store : view_.no_store(hash);
}
}  // namespace grc::audio
