// Playback/media clock for capture-owned voices; no game-state polling.
#pragma once
#include "rs_audio_slab.h"
#include <cmath>
#include <algorithm>
#include <limits>

namespace grc::audio {
struct ClockVoice {
  uint64_t key = 0, anchor = 0;
  double position = 0, length = 0, pitch = 1, deadline = 0;
  bool paused = false, loop = false;
  size_t heap_index = 0;
  void *retained = nullptr;
};
class VoiceClock {
 public:
  // Mutations and position reads use the source slab lock. The frame predicate
  // reads only the atomic count and mirrored heap top; an empty clock reads no time.
  bool any() const { return size_.load(std::memory_order_relaxed) != 0; }
  bool due(uint64_t t) const { return top_deadline_.load(std::memory_order_relaxed) <= double(t); }
  ClockVoice *find(uint64_t key) { return voices_.find(key); }
  bool start(uint64_t key, double length, double offset, double pitch, bool loop,
             uint64_t t, void *retained) {
    if (voices_.find(key)) return false;
    auto *v = voices_.insert(key); if (!v) return false;
    v->anchor = t; v->length = length; v->position = offset; v->pitch = pitch;
    v->loop = loop; v->retained = retained;
    const auto n = size_.load(std::memory_order_relaxed);
    v->heap_index = n; heap_[n] = v; size_.store(n + 1, std::memory_order_relaxed);
    deadline(*v); repair(v->heap_index); return true;
  }
  double position(uint64_t key, uint64_t t) const {
    const auto *v = voices_.find(key); if (!v) return 0;
    return v->position + (v->paused ? 0 : double(t - v->anchor) * v->pitch / 1e6);
  }
  void pause(uint64_t key, bool value, uint64_t t) {
    if (auto *v = find(key)) { integrate(*v, t); v->paused = value; deadline(*v); repair(v->heap_index); }
  }
  void pitch(uint64_t key, double value, uint64_t t) {
    if (auto *v = find(key)) { integrate(*v, t); v->pitch = value; deadline(*v); repair(v->heap_index); }
  }
  ClockVoice remove(uint64_t key) {
    auto *v = find(key); if (!v) return {};
    const auto result = *v; const auto n = size_.load(std::memory_order_relaxed) - 1;
    const auto at = v->heap_index;
    if (at != n) { heap_[at] = heap_[n]; heap_[at]->heap_index = at; }
    heap_[n] = nullptr; size_.store(n, std::memory_order_relaxed); voices_.erase(key);
    if (at < n) repair(at);
    else publish_top();
    return result;
  }
  uint64_t top_key() const { return heap_[0]->key; }
 private:
  void integrate(ClockVoice &v, uint64_t t) { v.position = position(v.key, t); v.anchor = t; }
  static void deadline(ClockVoice &v) {
    v.deadline = v.paused || v.loop || v.pitch <= 0 ? std::numeric_limits<double>::infinity()
        : double(v.anchor) + std::max(0.0, v.length - v.position) * 1e6 / v.pitch;
  }
  void swap(size_t a, size_t b) {
    std::swap(heap_[a], heap_[b]); heap_[a]->heap_index = a; heap_[b]->heap_index = b;
  }
  void repair(size_t i) {
    while (i && heap_[i]->deadline < heap_[(i - 1) / 2]->deadline) { swap(i, (i - 1) / 2); i = (i - 1) / 2; }
    const auto n = size_.load(std::memory_order_relaxed);
    for (;;) {
      size_t best = i, left = 2 * i + 1, right = left + 1;
      if (left < n && heap_[left]->deadline < heap_[best]->deadline) best = left;
      if (right < n && heap_[right]->deadline < heap_[best]->deadline) best = right;
      if (best == i) break;
      swap(i, best); i = best;
    }
    publish_top();
  }
  void publish_top() {
    top_deadline_.store(size_.load(std::memory_order_relaxed) ? heap_[0]->deadline :
        std::numeric_limits<double>::infinity(), std::memory_order_relaxed);
  }
  std::atomic<size_t> size_{0};
  // A mirror of the heap top permits the frame check while hooks hold the slab lock.
  std::atomic<double> top_deadline_{std::numeric_limits<double>::infinity()};
  AudioSlots<ClockVoice, kAudioVoices> voices_;
  std::array<ClockVoice *, kAudioVoices> heap_{};
};
}
