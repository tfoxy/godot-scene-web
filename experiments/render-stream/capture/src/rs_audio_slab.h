// Fixed storage for the Godot sample source. Engine identities never enter the wire.
#pragma once
#include "rs_audio_wire.h"
#include <array>
#include <atomic>
#include <cstdint>
#include <mutex>
#include <string_view>

namespace grc { class JsonWriter; }
namespace grc::audio {
inline constexpr size_t kAudioVoices = 128, kAudioSamples = 2048, kAudioBuses = 32;
inline constexpr size_t kAudioNameBytes = 128;
inline constexpr size_t kAudioPendingEnds = kAudioVoices, kAudioPendingUpdates = 16;
using Volumes = std::array<float, 8>;
struct SampleState {
  uint64_t key = 0, t = 0;
  uint32_t id = 0, rate = 44100, channels = 1;
  double length_s = 0;
  int loop = 0;
  double begin = 0, end = 0;
  std::array<char, 65> hash{};
  uint64_t bytes = 0;
  bool ready = false, store = true, announced = false, unregistered = false;
  std::array<char, 65> wav_hash{};
  uint64_t wav_bytes = 0;
  const char *codec = "wav";
};
// Connected-only history while the original asset hash is pending. All storage is inline.
struct VoiceStart {
  int bus = 0;
  float offset_s = 0, pitch = 1;
  Volumes volumes{};
};
struct VoiceUpdate {
  enum Kind { Pause, Pitch, Routes } kind = Pause;
  uint64_t t = 0;
  float pitch = 1;
  bool paused = false;
  std::array<int, 6> buses{};
  std::array<Volumes, 6> volumes{};
  size_t count = 0;
};
struct VoiceState {
  uint64_t key = 0, t = 0, sample_key = 0;
  uint32_t id = 0, sample = 0;
  int bus = 0;
  float offset_s = 0, pitch = 1;
  Volumes volumes{};
  bool paused = false, announced = false;
  SampleState asset;  // Retained independently of registration until this voice stops.
  std::array<int, 6> route_buses{};
  std::array<Volumes, 6> route_volumes{};
  size_t route_count = 0;
  bool routes_changed = false;
  VoiceStart initial;
  std::array<VoiceUpdate, kAudioPendingUpdates> updates{};
  size_t update_count = 0;
  bool collapsed = false;
};
struct EndedVoice {
  uint64_t key = 0, t = 0;
  VoiceState voice;
  bool natural_end = false;
};
struct BusState {
  // UTF-8, bounded by its escaped representation, excluding enclosing quotes.
  std::array<char, kAudioNameBytes + 1> name{};
  float volume_db = 0;
  int send = -1;
  bool solo = false, mute = false;
};
// All nodes and hash buckets live inline. No allocation or tombstone growth on churn.
template<class T, size_t N> class AudioSlots {
 public:
  AudioSlots() {
    heads_.fill(-1);
    for (size_t i = 0; i < N; ++i) next_[i] = int(i + 1);
    next_[N - 1] = -1;
  }
  const T *find(uint64_t key) const {
    for (int i = heads_[bucket(key)]; i != -1; i = next_[i])
      if (values_[i].key == key) return &values_[i];
    return nullptr;
  }
  T *find(uint64_t key) { return const_cast<T *>(static_cast<const AudioSlots &>(*this).find(key)); }
  T *insert(uint64_t key) {
    if (auto *v = find(key)) return v;
    if (!key || free_ == -1) return nullptr;
    int i = free_; free_ = next_[i];
    const auto b = bucket(key);
    next_[i] = heads_[b]; heads_[b] = i;
    values_[i] = {}; values_[i].key = key;
    return &values_[i];
  }
  bool erase(uint64_t key) {
    auto *link = &heads_[bucket(key)];
    while (*link != -1) {
      int i = *link;
      if (values_[i].key == key) {
        *link = next_[i]; values_[i] = {}; next_[i] = free_; free_ = i; return true;
      }
      link = &next_[i];
    }
    return false;
  }
  const auto &values() const { return values_; }
 private:
  static size_t bucket(uint64_t key) {
    key ^= key >> 33; key *= 0xff51afd7ed558ccdULL; key ^= key >> 33;
    return size_t(key) & (N * 2 - 1);
  }
  std::array<T, N> values_{};
  std::array<int, N> next_{};
  std::array<int, N * 2> heads_{};
  int free_ = 0;
};
class GodotSink {
 public:
  virtual ~GodotSink() = default;
  virtual void godot_text(const std::string &) = 0;
  virtual void godot_overflow() = 0;
};
class VariantSupplier {
 public:
  virtual ~VariantSupplier() = default;
  // Completion calls AudioSlab::variant(id, ...). No request while dormant.
  virtual void request(uint32_t id, uint64_t stream_key) = 0;
  virtual void fallback(uint32_t id, uint64_t stream_key) { request(id, stream_key); }
  virtual void released(uint32_t) {}
  virtual void no_store(uint32_t) {}
};
class AudioSlab {
 public:
  // Lock order: slab, then sink. Snapshot and connection changes use the same order.
  std::unique_lock<std::recursive_mutex> lock() const { return std::unique_lock(mu_); }
  const VoiceState *voice(uint64_t key) const { return voices_.find(key); }
  void arm();
  void refuse(const char *reason);
  bool available() const { return available_; }
  const char *state() const { return state_; }
  void attach(GodotSink *sink) { sink_ = sink; }
  void connected(bool value, uint64_t t = 0);
  void supplier(VariantSupplier *value) { supplier_ = value; }
  void prepare_variants(unsigned codecs = 7);
  void metadata(uint32_t id, uint32_t rate, uint32_t channels, double loop_begin);
  bool wanted(uint32_t id) const;
  bool storable(uint32_t id) const;
  void configure_store(unsigned maximum_ms) { store_max_ms_ = maximum_ms; }
  void restrict_sample(uint64_t key, uint64_t t);
  const SampleState *sample_state(uint64_t key) const { return samples_.find(key); }
  uint32_t sample(SampleState value, uint64_t t);
  void drop(uint64_t key, uint64_t t);
  void variant(uint32_t id, const char *hash, uint64_t bytes, uint64_t t, const char *codec = "wav");
  bool registered(uint64_t key);
  uint32_t start(VoiceState value, uint64_t sample_key, uint64_t t);
  void stop(uint64_t key, uint64_t t, const char *reason = "stop");
  using Position = double (*)(uint64_t key, uint64_t t);
  Position playback_position = nullptr;
  void pause(uint64_t key, bool paused, uint64_t t);
  void pitch(uint64_t key, float pitch, uint64_t t);
  void volumes(uint64_t key, const std::array<int, 6> &buses,
               const std::array<Volumes, 6> &values, size_t count, uint64_t t);
  void bus(const char *op, int index, int value, float number, bool boolean, uint64_t t);
  void name(int index, std::string_view utf8);
  std::string snapshot(uint64_t t, std::string_view fmod = "null") const;
  std::vector<std::string> samples(uint64_t t) const;
  std::vector<std::string> snapshot_updates(uint64_t t) const;
  std::string evidence() const;
  void write_evidence(JsonWriter &) const;
  static std::string diagnostic_name(std::string_view utf8);
  uint64_t samples_full = 0, voices_full = 0, pending_ends_full = 0, pending_updates_full = 0;
 private:
  friend struct AudioSlabTestAccess;
  void emit(const char *type, std::string members, uint64_t t);
  void release_unused(const SampleState &, uint64_t t);
  void pending_update(VoiceState &, const VoiceUpdate &);
  void announce(VoiceState &, uint64_t t);
  void emit_update(const VoiceState &, const VoiceUpdate &);
  unsigned codecs_ = 7, store_max_ms_ = 10000;
  uint64_t variants_ready_ = 0;
  static std::string sample_members(const SampleState &);
  static std::string voice_members(const VoiceState &, bool initial = false);
  static std::string route_members(const VoiceState &);
  mutable std::recursive_mutex mu_;
  std::atomic<bool> connected_{false};
  GodotSink *sink_ = nullptr;
  VariantSupplier *supplier_ = nullptr;
  bool available_ = false;
  const char *state_ = "off";
  uint64_t next_sample_ = 1, next_voice_ = 1;
  AudioSlots<SampleState, kAudioSamples> samples_;
  AudioSlots<VoiceState, kAudioVoices> voices_;
  AudioSlots<EndedVoice, kAudioPendingEnds> ended_;
  std::array<BusState, kAudioBuses> buses_{};
  size_t bus_count_ = 1;
};
AudioSlab &godot_slab();
}  // namespace grc::audio
