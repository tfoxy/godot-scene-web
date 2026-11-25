#include "rs_audio_slab.h"
#include "report.h"
#include <algorithm>
#include <cstring>
#include <cmath>
#include <limits>

namespace grc::audio {
namespace {
std::string quoted(const std::string &text) { JsonWriter j; j.string(text); auto value = j.take(); if (!value.empty() && value.back() == '\n') value.pop_back(); return value; }
std::string floats(const Volumes &v) {
  std::string text = "[";
  for (size_t i = 0; i < v.size(); ++i) text += (i ? "," : "") + float_r(v[i]);
  return text + "]";
}
void name_copy(BusState &bus, std::string_view name) {
  size_t used = 0, escaped = 0;
  while (used < name.size()) {
    const auto c = static_cast<unsigned char>(name[used]);
    size_t n = c < 0x80 ? 1 : c < 0xe0 ? 2 : c < 0xf0 ? 3 : 4;
    if (used + n > name.size()) break;
    // Match JsonWriter's escaping, including the short JSON control escapes.
    size_t cost = c == '"' || c == '\\' || c == '\n' || c == '\r' || c == '\t'
        ? 2 : c < 32 ? 6 : n;
    if (escaped + cost > kAudioNameBytes) break;
    for (size_t j = 1; j < n; ++j)
      if ((static_cast<unsigned char>(name[used + j]) & 0xc0) != 0x80) return;
    std::memcpy(bus.name.data() + used, name.data() + used, n);
    used += n; escaped += cost;
  }
  bus.name[used] = 0;
}
}
AudioSlab &godot_slab() { static AudioSlab slab; return slab; }
void AudioSlab::arm() {
  auto guard = lock();
  if (std::string_view(state_) == "unavailable:bus-limit") return;
  available_ = true; state_ = "sample";
  name_copy(buses_[0], "Master");
}
void AudioSlab::refuse(const char *reason) {
  auto guard = lock(); available_ = false; state_ = reason;
}
void AudioSlab::connected(bool value, uint64_t t) {
  auto guard = lock();
  const bool was_connected = connected_.exchange(value, std::memory_order_relaxed);
  for (const auto &sample : samples_.values()) if (sample.key)
    samples_.find(sample.key)->announced = value && sample.ready;
  for (const auto &voice : voices_.values()) if (voice.key) {
    auto *v = voices_.find(voice.key);
    v->asset.announced = value && v->asset.ready;
    v->announced = value && v->asset.ready;
    if (!value || !was_connected) {
      v->update_count = 0;
      v->collapsed = false;
      // Dormant changes form the join baseline; subsequent connected calls retain history.
      v->initial = {v->bus, v->offset_s, v->pitch, v->volumes};
      if (value && !v->asset.ready) {
        if (t) {
          v->t = t;
          if (playback_position) v->initial.offset_s = float(playback_position(v->key, t));
        }
        if (v->paused) {
          VoiceUpdate u; u.kind = VoiceUpdate::Pause; u.paused = true; u.t = v->t;
          pending_update(*v, u);
        }
        if (v->routes_changed) {
          VoiceUpdate u; u.kind = VoiceUpdate::Routes; u.buses = v->route_buses;
          u.volumes = v->route_volumes; u.count = v->route_count; u.t = v->t;
          pending_update(*v, u);
        }
      }
    }
  }
  if (!value) for (const auto &ended : ended_.values()) if (ended.key) {
    const auto asset = ended.voice.asset; const auto t = ended.t;
    ended_.erase(ended.key);
    release_unused(asset, t);
  }
}
void AudioSlab::prepare_variants(unsigned codecs) {
  auto guard = lock();
  codecs_ &= codecs;
  if (!supplier_ || !available_ || !connected_.load(std::memory_order_relaxed)) return;
  const auto request = [&](const SampleState &s) {
    if (!s.ready) supplier_->request(s.id, s.key);
    else if (!s.wav_bytes && !(codecs_ & (std::string_view(s.codec) == "mp3" ? 2u : std::string_view(s.codec) == "ogg-vorbis" ? 4u : 1u)))
      supplier_->fallback(s.id, s.key);
  };
  for (const auto &s : samples_.values()) if (s.key) request(s);
  for (const auto &v : voices_.values()) if (v.key) request(v.asset);
  for (const auto &e : ended_.values()) if (e.key) request(e.voice.asset);
}
void AudioSlab::emit(const char *type, std::string members, uint64_t t) {
  if (sink_) sink_->godot_text("{\"type\":" + quoted(type) + ",\"t\":" + std::to_string(t) + members + "}");
}
std::string AudioSlab::sample_members(const SampleState &s) {
  static const char *modes[] = {"disabled", "forward", "pingpong", "backward"};
  return ",\"id\":" + std::to_string(s.id) + ",\"variants\":[{\"codec\":" + quoted(s.codec) + ",\"hash\":" +
      quoted(s.hash.data()) + ",\"bytes\":" + std::to_string(s.bytes) + "}" +
      (s.wav_bytes ? ",{\"codec\":\"wav\",\"hash\":" + quoted(s.wav_hash.data()) + ",\"bytes\":" + std::to_string(s.wav_bytes) + "}" : "") + "],\"channels\":" +
      std::to_string(s.channels) + ",\"rate\":" + std::to_string(s.rate) + ",\"length_ms\":" +
      std::to_string(s.length_s * 1000) + ",\"loop\":{\"mode\":" + quoted(modes[s.loop]) +
      ",\"begin\":" + std::to_string(s.begin) + ",\"end\":" + std::to_string(s.end) +
      "},\"store\":" + (s.store ? "true" : "false");
}
std::string AudioSlab::voice_members(const VoiceState &v, bool initial) {
  const VoiceStart start = initial ? v.initial : VoiceStart{v.bus, v.offset_s, v.pitch, v.volumes};
  return "\"voice\":" + std::to_string(v.id) + ",\"sample\":" + std::to_string(v.sample) +
      ",\"bus\":" + std::to_string(start.bus) + ",\"offset_s\":" + float_r(start.offset_s) +
      ",\"pitch\":" + float_r(start.pitch) + ",\"volumes\":" + floats(start.volumes);
}
void AudioSlab::emit_update(const VoiceState &v, const VoiceUpdate &u) {
  const auto voice = ",\"voice\":" + std::to_string(v.id);
  if (u.kind == VoiceUpdate::Pause) emit("pause", voice + ",\"paused\":" + (u.paused ? "true" : "false"), u.t);
  else if (u.kind == VoiceUpdate::Pitch) emit("pitch", voice + ",\"pitch\":" + float_r(u.pitch), u.t);
  else {
    std::string members = voice + ",\"buses\":[";
    for (size_t i = 0; i < u.count; ++i) members += std::string(i ? "," : "") +
        "{\"bus\":" + std::to_string(u.buses[i]) + ",\"v\":" + floats(u.volumes[i]) + "}";
    emit("voice-volumes", members + "]", u.t);
  }
}
void AudioSlab::pending_update(VoiceState &v, const VoiceUpdate &update) {
  if (v.collapsed) return;
  if (v.update_count == v.updates.size()) {
    v.collapsed = true; v.update_count = 0; ++pending_updates_full;
  } else v.updates[v.update_count++] = update;
}
void AudioSlab::announce(VoiceState &v, uint64_t t) {
  v.announced = true;
  emit("start", "," + voice_members(v, !v.collapsed), v.t);
  if (!v.collapsed) for (size_t i = 0; i < v.update_count; ++i) emit_update(v, v.updates[i]);
  else {
    if (v.paused) emit("pause", ",\"voice\":" + std::to_string(v.id) + ",\"paused\":true", t);
    if (v.routes_changed) emit("voice-volumes", route_members(v), t);
  }
  v.update_count = 0;
}
uint32_t AudioSlab::sample(SampleState value, uint64_t t) {
  auto guard = lock(); const bool send = connected_.load(std::memory_order_relaxed);
  if (!available_) return 0;
  if (auto *existing = samples_.find(value.key)) return existing->id;
  auto *slot = next_sample_ <= UINT32_MAX ? samples_.insert(value.key) : nullptr;
  if (!slot) { ++samples_full; return 0; }
  value.store = !value.loop && value.length_s * 1000 <= store_max_ms_;
  value.id = uint32_t(next_sample_++); value.t = t; value.announced = send && value.ready; *slot = value;
  if (send && value.ready) emit("sample", sample_members(value), t);
  else if (send && supplier_) supplier_->request(value.id, value.key);
  return value.id;
}
void AudioSlab::variant(uint32_t id, const char *hash, uint64_t bytes, uint64_t t, const char *codec) {
  auto guard = lock(); const bool send = connected_.load(std::memory_order_relaxed);
  if (!available_) return;
  SampleState *asset = nullptr;
  for (const auto &s : samples_.values()) if (s.key && s.id == id) { asset = samples_.find(s.key); break; }
  if (!asset) for (const auto &v : voices_.values()) if (v.key && v.sample == id) { asset = &voices_.find(v.key)->asset; break; }
  if (!asset) for (const auto &e : ended_.values()) if (e.key && e.voice.sample == id) { asset = &ended_.find(e.key)->voice.asset; break; }
  if (!asset) return;
  if (asset->ready) {
    if (std::string_view(codec) != "wav" || std::string_view(asset->codec) == "wav" || asset->wav_bytes) return;
    std::memcpy(asset->wav_hash.data(), hash, 64); asset->wav_hash[64] = 0; asset->wav_bytes = bytes;
    for (const auto &v : voices_.values()) if (v.key && v.sample == id) voices_.find(v.key)->asset = *asset;
    for (const auto &e : ended_.values()) if (e.key && e.voice.sample == id) ended_.find(e.key)->voice.asset = *asset;
    if (send) emit("sample-variant", ",\"id\":" + std::to_string(id) + ",\"codec\":\"wav\",\"hash\":" + quoted(hash) + ",\"bytes\":" + std::to_string(bytes), t);
    ++variants_ready_; return;
  }
  ++variants_ready_;
  std::memcpy(asset->hash.data(), hash, 64); asset->hash[64] = 0;
  asset->bytes = bytes; asset->codec = codec; asset->ready = true; asset->announced = send;
  const auto complete = *asset;
  if (send) emit("sample", sample_members(complete), complete.t);
  for (const auto &voice : voices_.values()) if (voice.key && voice.sample == id) {
    auto *v = voices_.find(voice.key); v->asset = complete;
    if (send && !v->announced) announce(*v, t);
  }
  if (supplier_ && !complete.wav_bytes && !(codecs_ & (std::string_view(codec) == "mp3" ? 2u : std::string_view(codec) == "ogg-vorbis" ? 4u : 1u))) supplier_->fallback(id, complete.key);
  uint64_t release_t = t;
  for (const auto &ended : ended_.values()) if (ended.key && ended.voice.sample == id) {
    auto *e = ended_.find(ended.key); e->voice.asset = complete;
    if (send) {
      announce(e->voice, t);
      emit("stop", ",\"voice\":" + std::to_string(e->voice.id) + ",\"reason\":" + quoted(e->natural_end ? "end" : "stop"), e->t);
    }
    release_t = e->t;
    ended_.erase(e->key);
  }
  release_unused(complete, release_t);
}
void AudioSlab::metadata(uint32_t id, uint32_t rate, uint32_t channels, double loop_begin) {
  auto guard = lock();
  for (const auto &s : samples_.values()) if (s.key && s.id == id) {
    auto *m = samples_.find(s.key); m->rate = rate; m->channels = channels; m->begin = loop_begin;
  }
  for (const auto &v : voices_.values()) if (v.key && v.sample == id) {
    auto &m = voices_.find(v.key)->asset; m.rate = rate; m.channels = channels; m.begin = loop_begin;
  }
  for (const auto &e : ended_.values()) if (e.key && e.voice.sample == id) {
    auto &m = ended_.find(e.key)->voice.asset; m.rate = rate; m.channels = channels; m.begin = loop_begin;
  }
}
bool AudioSlab::wanted(uint32_t id) const {
  for (const auto &s : samples_.values()) if (s.key && s.id == id) return true;
  for (const auto &v : voices_.values()) if (v.key && v.sample == id) return true;
  for (const auto &e : ended_.values()) if (e.key && e.voice.sample == id) return true;
  return false;
}
bool AudioSlab::storable(uint32_t id) const {
  for (const auto &s : samples_.values()) if (s.key && s.id == id) return s.store;
  for (const auto &v : voices_.values()) if (v.key && v.sample == id) return v.asset.store;
  for (const auto &e : ended_.values()) if (e.key && e.voice.sample == id) return e.voice.asset.store;
  return false;
}
void AudioSlab::release_unused(const SampleState &asset, uint64_t t) {
  if (wanted(asset.id)) return;
  if (available_ && connected_.load(std::memory_order_relaxed) && asset.unregistered && asset.announced)
    emit("sample-drop", ",\"id\":" + std::to_string(asset.id), t);
  if (supplier_) supplier_->released(asset.id);
}
void AudioSlab::restrict_sample(uint64_t key, uint64_t t) {
  auto guard = lock(); auto *s = samples_.find(key); if (!s || !s->store) return;
  s->store = false;
  for (const auto &v : voices_.values()) if (v.key && v.sample == s->id) voices_.find(v.key)->asset.store = false;
  for (const auto &e : ended_.values()) if (e.key && e.voice.sample == s->id) ended_.find(e.key)->voice.asset.store = false;
  if (supplier_) supplier_->no_store(s->id);
  if (connected_.load(std::memory_order_relaxed) && s->ready) emit("sample", sample_members(*s), t);
}
void AudioSlab::drop(uint64_t key, uint64_t t) {
  auto guard = lock();
  auto *s = samples_.find(key); if (!s) return;
  auto asset = *s; asset.unregistered = true; samples_.erase(key);
  for (const auto &v : voices_.values()) if (v.key && v.sample == asset.id)
    voices_.find(v.key)->asset.unregistered = true;
  for (const auto &e : ended_.values()) if (e.key && e.voice.sample == asset.id)
    ended_.find(e.key)->voice.asset.unregistered = true;
  release_unused(asset, t);
}
bool AudioSlab::registered(uint64_t key) { auto guard = lock(); return samples_.find(key); }
uint32_t AudioSlab::start(VoiceState value, uint64_t sample_key, uint64_t t) {
  auto guard = lock(); const bool send = connected_.load(std::memory_order_relaxed);
  if (!available_) return 0;
  auto *s = samples_.find(sample_key);
  if (auto *v = voices_.find(value.key)) return v->id;
  auto *slot = s && next_voice_ <= UINT32_MAX ? voices_.insert(value.key) : nullptr;
  if (!slot) { ++voices_full; return 0; }
  value.id = uint32_t(next_voice_++); value.sample = s->id; value.sample_key = sample_key; value.t = t; value.asset = *s;
  value.initial = {value.bus, value.offset_s, value.pitch, value.volumes};
  value.collapsed = !send;
  value.announced = send && s->ready; *slot = value;
  if (value.announced) emit("start", "," + voice_members(value), t);
  return value.id;
}
void AudioSlab::stop(uint64_t key, uint64_t t, const char *reason) {
  auto guard = lock(); const bool send = connected_.load(std::memory_order_relaxed);
  auto *v = voices_.find(key); if (!v) return;
  const auto asset = v->asset;
  if (send && available_) {
    if (v->announced) emit("stop", ",\"voice\":" + std::to_string(v->id) + ",\"reason\":" + quoted(reason), t);
    else if (auto *e = ended_.insert(v->id)) {
      e->voice = *v; e->t = t; e->natural_end = std::string_view(reason) == "end";
    } else ++pending_ends_full;
  }
  voices_.erase(key);
  release_unused(asset, t);
}
void AudioSlab::pause(uint64_t key, bool value, uint64_t t) {
  auto guard = lock(); const bool send = connected_.load(std::memory_order_relaxed);
  auto *v = voices_.find(key); if (!v) return; v->paused = value;
  if (send && available_) {
    VoiceUpdate u; u.kind = VoiceUpdate::Pause; u.paused = value; u.t = t;
    if (v->announced) emit_update(*v, u); else pending_update(*v, u);
  }
}
void AudioSlab::pitch(uint64_t key, float value, uint64_t t) {
  auto guard = lock(); const bool send = connected_.load(std::memory_order_relaxed);
  auto *v = voices_.find(key); if (!v) return; v->pitch = value;
  if (send && available_) {
    VoiceUpdate u; u.kind = VoiceUpdate::Pitch; u.pitch = value; u.t = t;
    if (v->announced) emit_update(*v, u); else pending_update(*v, u);
  }
}
std::string AudioSlab::route_members(const VoiceState &v) {
  std::string members = ",\"voice\":" + std::to_string(v.id) + ",\"buses\":[";
  for (size_t i = 0; i < v.route_count; ++i) members += std::string(i ? "," : "") +
      "{\"bus\":" + std::to_string(v.route_buses[i]) + ",\"v\":" + floats(v.route_volumes[i]) + "}";
  return members + "]";
}
void AudioSlab::volumes(uint64_t key, const std::array<int, 6> &buses,
    const std::array<Volumes, 6> &values, size_t count, uint64_t t) {
  auto guard = lock(); const bool send = connected_.load(std::memory_order_relaxed);
  auto *v = voices_.find(key); if (!v) return;
  if (count > v->route_buses.size()) return;
  v->route_buses = buses; v->route_volumes = values; v->route_count = count; v->routes_changed = true;
  if (send && available_) {
    VoiceUpdate u; u.kind = VoiceUpdate::Routes; u.buses = buses; u.volumes = values; u.count = count; u.t = t;
    if (v->announced) emit_update(*v, u); else pending_update(*v, u);
  }
}
void AudioSlab::name(int index, std::string_view value) {
  auto guard = lock(); if (index >= 0 && size_t(index) < bus_count_) name_copy(buses_[index], value);
}
void AudioSlab::bus(const char *op, int index, int value, float number, bool boolean, uint64_t t) {
  auto guard = lock(); const bool send = connected_.load(std::memory_order_relaxed);
  if (!available_) return;
  const std::string_view action(op);
  // JSON has no infinity or NaN; the lowest finite dB spelling gives exact silence.
  if (action == "volume_db" && !std::isfinite(number))
    number = number > 0 ? std::numeric_limits<float>::max() : std::numeric_limits<float>::lowest();
  if ((action == "count" && value > int(kAudioBuses)) || (action == "add" && bus_count_ == kAudioBuses)) {
    available_ = false; state_ = "unavailable:bus-limit";
    if (send && sink_) sink_->godot_overflow();
    return;
  }
  std::array<int, kAudioBuses> remap{};
  for (size_t i = 0; i < kAudioBuses; ++i) remap[i] = int(i);
  if (action == "count") {
    for (size_t i = size_t(std::max(1, value)); i < kAudioBuses; ++i) remap[i] = -1;
    const auto n = size_t(std::max(1, value));
    for (size_t i = bus_count_; i < n; ++i) buses_[i] = {};
    bus_count_ = n;
  } else if (action == "add") {
    const size_t at = index < 0 ? bus_count_ : size_t(index);
    if (at > bus_count_) return;
    std::move_backward(buses_.begin() + at, buses_.begin() + bus_count_, buses_.begin() + bus_count_ + 1);
    buses_[at] = {}; ++bus_count_;
    for (size_t i = at; i < kAudioBuses; ++i) remap[i] = int(i + 1);
  } else if (index >= 0 && size_t(index) < bus_count_) {
    auto &b = buses_[index];
    if (action == "remove") {
      remap[index] = -1;
      for (size_t i = size_t(index + 1); i < kAudioBuses; ++i) remap[i] = int(i - 1);
      std::move(buses_.begin() + index + 1, buses_.begin() + bus_count_, buses_.begin() + index); --bus_count_;
    } else if (action == "move") {
      const auto to = value < 0 ? int(bus_count_ - 1) : value > index ? value - 1 : value;
      if (to < 0 || size_t(to) >= bus_count_) return;
      remap[index] = to;
      if (to < index) for (int i = to; i < index; ++i) remap[i] = i + 1;
      else for (int i = index + 1; i <= to; ++i) remap[i] = i - 1;
      auto saved = b;
      if (to < index) std::move_backward(buses_.begin() + to, buses_.begin() + index, buses_.begin() + index + 1);
      else std::move(buses_.begin() + index + 1, buses_.begin() + to + 1, buses_.begin() + index);
      buses_[to] = saved;
    } else if (action == "send") b.send = value;
    else if (action == "volume_db") b.volume_db = number;
    else if (action == "solo") b.solo = boolean;
    else if (action == "mute") b.mute = boolean;
  }
  if (action == "count" || action == "add" || action == "remove" || action == "move") {
    for (size_t i = 0; i < bus_count_; ++i) {
      auto &dest = buses_[i].send;
      if (dest >= 0 && size_t(dest) < kAudioBuses) dest = remap[dest];
    }
    const auto remap_index = [&](int &bus) {
      if (bus >= 0 && size_t(bus) < kAudioBuses) bus = remap[bus];
    };
    const auto remap_voice = [&](VoiceState &v) {
      remap_index(v.bus);
      for (size_t j = 0; j < v.route_count; ++j) remap_index(v.route_buses[j]);
      // The bus op precedes hash-delayed starts and updates on the wire.
      remap_index(v.initial.bus);
      for (size_t i = 0; i < v.update_count; ++i) {
        auto &u = v.updates[i];
        if (u.kind == VoiceUpdate::Routes)
          for (size_t j = 0; j < u.count; ++j) remap_index(u.buses[j]);
      }
    };
    for (const auto &v : voices_.values()) if (v.key) remap_voice(*voices_.find(v.key));
    for (const auto &e : ended_.values()) if (e.key) remap_voice(ended_.find(e.key)->voice);
  }
  if (send) {
    std::string members = ",\"op\":" + quoted(op) + ",\"bus\":" + std::to_string(index);
    if (action == "count" || action == "move" || action == "send") members += ",\"value\":" + std::to_string(value);
    else if (action == "volume_db") members += ",\"value\":" + float_r(number);
    else if (action == "solo" || action == "mute") members += std::string(",\"value\":") + (boolean ? "true" : "false");
    emit("bus", members, t);
  }
}
std::string AudioSlab::snapshot(uint64_t t, std::string_view fmod) const {
  auto guard = lock();
  std::string text = "{\"type\":\"audio-state\",\"t\":" + std::to_string(t) + ",\"godot\":";
  if (!available_) text += "null";
  else {
    text += "{\"buses\":[";
    for (size_t i = 0; i < bus_count_; ++i) {
      const auto &b = buses_[i];
      text += std::string(i ? "," : "") + "{\"name\":" + quoted(b.name.data()) +
          ",\"volume_db\":" + float_r(b.volume_db) + ",\"send\":" + std::to_string(b.send) +
          ",\"solo\":" + (b.solo ? "true" : "false") + ",\"mute\":" + (b.mute ? "true" : "false") + "}";
    }
    text += "],\"voices\":[";
    bool comma = false;
    for (const auto &v : voices_.values()) if (v.key) {
      // The asset worker gates publication until a real variant is ready.
      if (!v.asset.ready) continue;
      text += std::string(comma ? "," : "") + "{" + voice_members(v) + ",\"position_s\":" +
          float_r(playback_position ? float(playback_position(v.key, t)) : v.offset_s) + ",\"paused\":" + (v.paused ? "true" : "false") + "}";
      comma = true;
    }
    text += "]}";
  }
  return text + ",\"fmod\":" + std::string(fmod) + "}";
}
std::vector<std::string> AudioSlab::samples(uint64_t t) const {
  auto guard = lock(); std::vector<std::string> result;
  for (const auto &s : samples_.values()) if (s.key && s.ready)
    result.push_back("{\"type\":\"sample\",\"t\":" + std::to_string(t) + sample_members(s) + "}");
  for (const auto &v : voices_.values()) if (v.key && v.asset.ready) {
    bool known = false;
    for (const auto &s : samples_.values()) if (s.key && s.id == v.sample) known = true;
    for (const auto &prior : voices_.values()) { if (&prior == &v) break; if (prior.key && prior.sample == v.sample) known = true; }
    if (!known) result.push_back("{\"type\":\"sample\",\"t\":" + std::to_string(t) + sample_members(v.asset) + "}");
  }
  return result;
}
std::vector<std::string> AudioSlab::snapshot_updates(uint64_t t) const {
  auto guard = lock(); std::vector<std::string> result;
  if (available_) for (const auto &v : voices_.values()) if (v.key && v.asset.ready && v.routes_changed)
    result.push_back("{\"type\":\"voice-volumes\",\"t\":" + std::to_string(t) + route_members(v) + "}");
  return result;
}
std::string AudioSlab::diagnostic_name(std::string_view text) { BusState b; name_copy(b, text); return b.name.data(); }
void AudioSlab::write_evidence(JsonWriter &j) const {
  auto guard = lock();
  j.object_begin().field("state", std::string(state_));
  j.field_null("unsampled").field("unsampled_reason", std::string("not-observable-at-seam"));
  uint64_t samples = 0, voices = 0;
  for (const auto &s : samples_.values()) if (s.key) ++samples;
  for (const auto &v : voices_.values()) if (v.key) ++voices;
  j.key("registered_samples").unsigned_integer(samples);
  j.key("live_voices").unsigned_integer(voices);
  j.key("variants_ready").unsigned_integer(variants_ready_);
  j.key("samples_full").unsigned_integer(samples_full);
  j.key("voices_full").unsigned_integer(voices_full);
  j.key("pending_ends_full").unsigned_integer(pending_ends_full);
  j.key("pending_updates_full").unsigned_integer(pending_updates_full).object_end();
}
std::string AudioSlab::evidence() const {
  JsonWriter j; write_evidence(j); return j.take();
}
}  // namespace grc::audio
