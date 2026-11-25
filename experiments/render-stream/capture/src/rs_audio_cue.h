#ifndef GRC_RS_AUDIO_CUE_H
#define GRC_RS_AUDIO_CUE_H
#include "grc_audio_cue.h"
#include <array>
#include <atomic>
#include <cstdint>
#include <mutex>
#include <string>
namespace grc::audio {
inline constexpr std::size_t cue_ring_slots = 1024, cue_group_slots = 64, cue_group_bytes = 64;
struct CueRecord {
  std::uint64_t t_us = 0, epoch = 0;
  std::array<std::uint8_t, 16> key_id{};
  std::uint32_t kind = 0; // 0: group update, 1..4: cue
  float pitch = 1, volume = 1;
  std::uint16_t key_len = 0, group_len = 0;
  bool snapshot = false;
  std::array<char, 512> key{};
  std::array<char, cue_group_bytes> group{};
};
// Single consumer; producers reserve a position before publishing its sequence.
// A delayed producer cannot be overtaken by the consumer or another producer.
class CueRing {
 public:
  CueRing();
  bool push(const CueRecord &record);
  bool pop(CueRecord &record);
  std::uint64_t high_water() const { return high_water_.load(std::memory_order_relaxed); }
 private:
  struct alignas(64) Slot { std::atomic<std::uint64_t> sequence{0}; CueRecord record; };
  static_assert(sizeof(Slot) == 640);
  std::array<Slot, cue_ring_slots> slots_;
  alignas(64) std::atomic<std::uint64_t> write_{0};
  alignas(64) std::atomic<std::uint64_t> read_{0};
  std::atomic<std::uint64_t> high_water_{0};
};
class CueIngress {
 public:
  using Wake = void (*)(void *);
  void bind(void *self, Wake wake);
  void unbind();
  void connections(bool open);
  int cue(std::uint32_t kind, const std::uint8_t *id, const char *key, std::size_t key_len,
      const char *group, std::size_t group_len, std::uint64_t t_us, float pitch, float volume);
  int groups(const grc_audio_gain *gains, std::size_t n, int snapshot);
  bool pop(CueRecord &record);
  bool overflow(); // consumes the overflow and disables producers atomically
  std::string group_snapshot() const;
  std::uint64_t high_water() const { return ring_.high_water(); }
  std::uint64_t groups_full() const { return groups_full_.load(std::memory_order_relaxed); }
  std::uint64_t groups_refused() const { return groups_refused_.load(std::memory_order_relaxed); }
 private:
  struct Group { std::array<char, cue_group_bytes> name{}; std::size_t len = 0; float gain = 1; };
  bool enqueue(CueRecord record); // mu_ held: lifecycle and wake callback are protected
  mutable std::mutex mu_;
  std::array<Group, cue_group_slots> groups_{};
  std::size_t group_count_ = 0;
  void *self_ = nullptr;
  Wake wake_ = nullptr;
  bool open_ = false;
  std::uint64_t epoch_ = 0;
  CueRing ring_;
  std::atomic<bool> overflow_{false};
  std::atomic<std::uint64_t> groups_full_{0}, groups_refused_{0};
};
// The storage is allocated on the first grant and retained until library unload:
// a producer that loaded the dormant gate before teardown must never see freed memory.
CueIngress &grant_cues();
bool cue_attached();
int cue_key_id(const char *key, std::size_t len, std::uint8_t *out);
std::string cue_text(const CueRecord &record);
std::string fmod_snapshot(const std::string &bankset, const std::string &groups,
                          const std::string &lanes);
} // namespace grc::audio
#endif
