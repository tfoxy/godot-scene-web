#define GRC_AUDIO_BUILD 1
#include "rs_audio_cue.h"
#include "report.h"
#include "rs_audio_sender.h"
#include "rs_audio_wire.h"
#include "rs_platform.h"
#include <algorithm>
#include <cmath>
#include <cstring>
#include <memory>
namespace grc::audio {
namespace {
std::atomic<CueIngress *> active_ingress{nullptr}, installed{nullptr};
std::atomic<bool> attached{false};
bool group_valid(const char *name, std::size_t len) {
  if ((!name && len) || len > cue_group_bytes) return false;
  for (std::size_t i = 0; i < len; ++i)
    if (name[i] < 32 || name[i] > 126 || name[i] == '"' || name[i] == '\\') return false;
  return true;
}
bool key_valid(const char *key, std::size_t len) {
  if (!key || !len || len > 512) return false;
  // Validate UTF-8 without allocating. Canonical spelling belongs to the producer.
  for (std::size_t i = 0; i < len;) {
    unsigned c = static_cast<unsigned char>(key[i++]), cp = c, n = 0;
    if (c >= 0xc2 && c <= 0xdf) { cp = c & 31; n = 1; }
    else if (c >= 0xe0 && c <= 0xef) { cp = c & 15; n = 2; }
    else if (c >= 0xf0 && c <= 0xf4) { cp = c & 7; n = 3; }
    else if (c >= 0x80 || c == 0) return false;
    const auto width = n;
    if (i + n > len) return false;
    while (n--) { c = static_cast<unsigned char>(key[i++]); if ((c & 0xc0) != 0x80) return false; cp = (cp << 6) | (c & 63); }
    if ((width == 1 && cp < 0x80) || (width == 2 && cp < 0x800) ||
        (width == 3 && cp < 0x10000) || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return false;
  }
  return true;
}
int api_active() { return active_ingress.load(std::memory_order_relaxed) != nullptr; }
int api_cue(std::uint32_t kind, const std::uint8_t *id, const char *key, std::size_t key_len,
    const char *group, std::size_t group_len, std::uint64_t t, float pitch, float volume) {
  auto *ingress = active_ingress.load(std::memory_order_relaxed);
  return ingress ? ingress->cue(kind, id, key, key_len, group, group_len, t, pitch, volume) : 0;
}
int api_groups(const grc_audio_gain *gains, std::size_t n, int snapshot) {
  auto *ingress = installed.load(std::memory_order_acquire);
  return ingress ? ingress->groups(gains, n, snapshot) : 0;
}
std::string quoted(const char *text, std::size_t len) {
  JsonWriter j; j.string(std::string(text, len)); auto out = j.take(); out.pop_back(); return out;
}
}
CueRing::CueRing() {
  for (std::size_t i = 0; i < slots_.size(); ++i) slots_[i].sequence.store(i, std::memory_order_relaxed);
}
bool CueRing::push(const CueRecord &record) {
  auto pos = write_.load(std::memory_order_relaxed);
  Slot *slot;
  for (;;) {
    slot = &slots_[pos % cue_ring_slots];
    const auto seq = slot->sequence.load(std::memory_order_acquire);
    const auto diff = static_cast<std::int64_t>(seq - pos);
    if (diff < 0) return false;
    if (diff == 0 && write_.compare_exchange_weak(pos, pos + 1, std::memory_order_relaxed)) break;
    if (diff > 0) pos = write_.load(std::memory_order_relaxed);
  }
  const auto depth = std::min<std::uint64_t>(cue_ring_slots, pos + 1 - read_.load(std::memory_order_relaxed));
  auto high = high_water_.load(std::memory_order_relaxed);
  while (high < depth && !high_water_.compare_exchange_weak(high, depth, std::memory_order_relaxed)) {}
  slot->record = record;
  slot->sequence.store(pos + 1, std::memory_order_release);
  return true;
}
bool CueRing::pop(CueRecord &record) {
  const auto pos = read_.load(std::memory_order_relaxed);
  auto &slot = slots_[pos % cue_ring_slots];
  if (slot.sequence.load(std::memory_order_acquire) != pos + 1) return false;
  record = slot.record;
  slot.sequence.store(pos + cue_ring_slots, std::memory_order_release);
  read_.store(pos + 1, std::memory_order_relaxed);
  return true;
}
CueIngress &grant_cues() {
  static const auto ingress = std::make_unique<CueIngress>();
  installed.store(ingress.get(), std::memory_order_release);
  return *ingress;
}
bool cue_attached() { return attached.load(std::memory_order_relaxed); }
int cue_key_id(const char *key, std::size_t len, std::uint8_t *out) {
  if (!out || (len && !key_valid(key, len))) return -1;
  const auto digest = key_digest(std::string_view(key ? key : "", len)); std::memcpy(out, digest.data(), 16); return 1;
}
void CueIngress::bind(void *self, Wake wake) {
  std::lock_guard lock(mu_); self_ = self; wake_ = wake;
}
void CueIngress::unbind() {
  std::lock_guard lock(mu_);
  open_ = false; active_ingress.store(nullptr, std::memory_order_relaxed);
  self_ = nullptr; wake_ = nullptr;
}
void CueIngress::connections(bool open) {
  std::lock_guard lock(mu_);
  if (open && !open_) ++epoch_;
  open_ = open;
  active_ingress.store(open ? this : nullptr, std::memory_order_relaxed);
}
bool CueIngress::enqueue(CueRecord record) {
  record.epoch = epoch_;
  const bool ok = ring_.push(record);
  if (!ok) overflow_.store(true, std::memory_order_release);
  if (wake_) wake_(self_);
  return ok;
}
int CueIngress::cue(std::uint32_t kind, const std::uint8_t *id, const char *key, std::size_t key_len,
    const char *group, std::size_t group_len, std::uint64_t t, float pitch, float volume) {
  if (!group_valid(group, group_len)) { groups_refused_.fetch_add(1, std::memory_order_relaxed); return -1; }
  if (kind < 1 || kind > 4 || !std::isfinite(pitch) || pitch <= 0 || !std::isfinite(volume) || volume < 0) return -1;
  std::uint8_t digest[16];
  if ((!key_len && kind != 4) || cue_key_id(key, key_len, digest) != 1) return -1;
  if (!id || std::memcmp(id, digest, 16) != 0) return -1;
  CueRecord record; record.kind = kind; record.t_us = t; record.pitch = pitch; record.volume = volume;
  record.key_len = key_len; record.group_len = group_len;
  std::memcpy(record.key_id.data(), id, 16);
  if (key_len) std::memcpy(record.key.data(), key, key_len);
  if (group_len) std::memcpy(record.group.data(), group, group_len);
  std::lock_guard lock(mu_);
  if (!open_) return 0;
  for (std::size_t i = 0; i < group_count_; ++i) {
    const auto &g = groups_[i];
    if (g.len == group_len && (!group_len || std::memcmp(g.name.data(), group, group_len) == 0) && g.gain == 0) return 0;
  }
  return enqueue(record) ? 1 : -1;
}
int CueIngress::groups(const grc_audio_gain *gains, std::size_t n, int snapshot) {
  if ((!gains && n) || (snapshot != 0 && snapshot != 1)) return -1;
  for (std::size_t i = 0; i < n; ++i) {
    if (!group_valid(gains[i].group, gains[i].group_len)) {
      groups_refused_.fetch_add(1, std::memory_order_relaxed); return -1;
    }
    if (!std::isfinite(gains[i].gain) || gains[i].gain < 0) return -1;
  }
  std::lock_guard lock(mu_);
  bool full = false, queued = true;
  if (snapshot) {
    group_count_ = 0;
    if (open_) { CueRecord r; r.snapshot = true; r.t_us = now_us(); queued &= enqueue(r); }
  }
  for (std::size_t i = 0; i < n; ++i) {
    const auto &gain = gains[i];
    std::size_t index = 0;
    for (; index < group_count_; ++index)
      if (groups_[index].len == gain.group_len && (!gain.group_len || std::memcmp(groups_[index].name.data(), gain.group, gain.group_len) == 0)) break;
    if (index == cue_group_slots) { groups_full_.fetch_add(1, std::memory_order_relaxed); full = true; continue; }
    if (index == group_count_) ++group_count_;
    auto &g = groups_[index]; g.len = gain.group_len; g.gain = gain.gain;
    if (g.len) std::memcpy(g.name.data(), gain.group, g.len);
    if (open_) {
      CueRecord r; r.t_us = now_us(); r.group_len = g.len; r.group = g.name; r.volume = g.gain;
      // key_len distinguishes an empty-name gain from the empty replacement marker.
      r.key_len = 1; queued &= enqueue(r);
    }
  }
  return !queued ? -1 : full ? 0 : 1;
}
bool CueIngress::pop(CueRecord &record) {
  std::lock_guard lock(mu_);
  while (ring_.pop(record)) if (record.epoch == epoch_) return true;
  return false;
}
bool CueIngress::overflow() {
  std::lock_guard lock(mu_);
  if (!overflow_.exchange(false, std::memory_order_acq_rel)) return false;
  // No producer can set another overflow between consuming it and going dormant.
  open_ = false; active_ingress.store(nullptr, std::memory_order_relaxed);
  return true;
}
std::string CueIngress::group_snapshot() const {
  std::lock_guard lock(mu_); std::string out = "{";
  for (std::size_t i = 0; i < group_count_; ++i) {
    const auto &g = groups_[i]; if (i) out += ',';
    out += quoted(g.name.data(), g.len) + ":" + float_r(g.gain);
  }
  return out + "}";
}
std::string cue_text(const CueRecord &r) {
  const auto group = quoted(r.group.data(), r.group_len);
  const auto prefix = std::string("{\"type\":\"") + (r.kind ? "cue" : "groups") + "\",\"t\":" + std::to_string(r.t_us);
  if (!r.kind) return prefix + ",\"gains\":{" + (r.key_len ? group + ":" + float_r(r.volume) : "") +
      "},\"snapshot\":" + (r.snapshot ? "true" : "false") + "}";
  static const char *kinds[] = {"", "oneshot", "loop-start", "loop-stop", "loop-stop-all"};
  return prefix + ",\"key_id\":\"" + hex(Bytes(r.key_id.begin(), r.key_id.end())) +
      "\",\"key\":" + quoted(r.key.data(), r.key_len) + ",\"kind\":\"" + kinds[r.kind] +
      "\",\"group\":" + group + ",\"pitch\":" + float_r(r.pitch) + ",\"volume\":" + float_r(r.volume) + "}";
}
std::string fmod_snapshot(const std::string &bankset, const std::string &groups, const std::string &lanes) {
  return "{\"bankset\":\"" + bankset + "\",\"groups\":" + groups + ",\"lanes\":[" + lanes + "]}";
}
} // namespace grc::audio
extern "C" GRC_EXPORT int grc_audio_cue_get_v1(grc_audio_cue_v1 *out) {
  if (!out) return -1;
  using namespace grc::audio;
  attached.store(true, std::memory_order_relaxed);
  *out = {GRC_AUDIO_CUE_ABI_VERSION, sizeof(grc_audio_cue_v1), api_active, now_us, api_cue, api_groups, cue_key_id};
  return 1;
}
