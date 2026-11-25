#define GRC_AUDIO_BUILD 1
#include "rs_audio_link.h"
#include "report.h"
#include "rs_json_lite.h"
#include "rs_platform.h"
#include "rs_sha256.h"
#if defined(__APPLE__)
#include <sys/sysctl.h>
#include <sys/time.h>
#elif defined(_WIN32)
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#endif
#include <algorithm>
#include <fstream>
#include <stdexcept>
namespace grc::audio {
namespace {
std::mutex endpoint_mu;
Link *endpoint = nullptr;
std::string quote(const std::string &s) { JsonWriter j; j.string(s); auto v = j.take(); v.pop_back(); return v; }
std::string event(const char *type, const std::string &members) {
  return "{\"type\":\"" + std::string(type) + "\",\"t\":" + std::to_string(now_us()) + members + "}";
}
std::string descriptor(const LinkLane &l) {
  return "{\"id\":" + std::to_string(l.id) + ",\"name\":" + quote(l.name) + ",\"group\":" + quote(l.group);
}
const char *reasons[] = {"refused-not-oneshot", "refused-bus", "unknown-event", "fmod-off", "link-down"};
}
std::string boot_clock_domain(std::string_view platform, std::uint64_t seconds) {
  constexpr char prefix[] = "grc-clock-boot-1";
  Sha256 hash; hash.update(prefix, sizeof(prefix));
  hash.update(platform.data(), platform.size());
  const std::uint8_t zero = 0; hash.update(&zero, 1);
  std::array<std::uint8_t, 8> encoded{};
  for (unsigned i = 0; i < encoded.size(); ++i) encoded[i] = (seconds >> (8 * i)) & 255;
  hash.update(encoded.data(), encoded.size());
  return sha256_hex(hash.finish()).substr(0, 32);
}
std::string clock_domain() {
  const std::string unavailable(32, '0');
#if defined(__linux__)
  std::ifstream input("/proc/sys/kernel/random/boot_id");
  std::string id; input >> id;
  id.erase(std::remove(id.begin(), id.end(), '-'), id.end());
  try { if (id.size() == 32) { unhex(id, 16); return id; } }
  catch (const std::invalid_argument &) {}
#elif defined(__APPLE__)
  timeval boot{}; std::size_t size = sizeof(boot);
  if (sysctlbyname("kern.boottime", &boot, &size, nullptr, 0) == 0 && size == sizeof(boot) && boot.tv_sec > 0)
    return boot_clock_domain("darwin", static_cast<std::uint64_t>(boot.tv_sec));
#elif defined(_WIN32)
  // SYSTEM_TIMEOFDAY_INFORMATION has a fixed kernel BootTime in 100 ns ticks
  // since 1601. Use its whole seconds directly, without a drifting wall clock.
  struct TimeOfDay {
    LARGE_INTEGER boot, current, zone_bias;
    ULONG zone_id, reserved;
    ULONGLONG boot_bias, sleep_bias;
  } info{};
  using Query = LONG (WINAPI *)(ULONG, void *, ULONG, ULONG *);
  const auto module = GetModuleHandleW(L"ntdll.dll");
  const auto query = module ? reinterpret_cast<Query>(GetProcAddress(module, "NtQuerySystemInformation")) : nullptr;
  if (query && query(3, &info, sizeof(info), nullptr) >= 0 && info.boot.QuadPart > 0)
    return boot_clock_domain("windows", static_cast<std::uint64_t>(info.boot.QuadPart) / 10000000);
#endif
  return unavailable;
}
Link::Link(Sender &sender) : sender_(sender), domain_(clock_domain()) {
  std::lock_guard lock(endpoint_mu); endpoint = this;
}
Link::~Link() { shutdown(); }
void Link::shutdown() {
  std::lock_guard global(endpoint_mu);
  if (endpoint != this) return;
  attach(nullptr); endpoint = nullptr;
}
int Link::attach(const grc_audio_link_v1 *link) {
  if (link && (link->abi_version != 1 || link->size < sizeof(grc_audio_link_v1) || !link->link_out)) return -1;
  std::lock_guard lock(mu_);
  down("link-down", true);
  if (!link) return 1;
  api_ = *link; state_ = "connecting"; reason_.clear();
  LinkMessage hello; hello.clock_domain = domain_; hello.bankset = std::string(32, '0');
  out_.push_back(encode_link(hello)); sender_.wake_source(); return 1;
}
bool Link::needs(const Connection &c, const std::string &id) const {
#if defined(GRC_AUDIO_LINK_TESTING)
  if (relay_to_all_) return true;
#endif
  return !c.have.count(id);
}
void Link::unavailable(const std::string &id, const Take &take, const std::string &reason) {
  for (const auto conn : take.recipients) {
    const auto c = conns_.find(conn);
    if (c != conns_.end() && needs(c->second, id))
      sender_.text(conn, event("take-unavailable", ",\"key_id\":" + quote(id) + ",\"reason\":" + quote(reason)), true);
  }
}
void Link::down(const std::string &reason, bool detach) {
  for (const auto &[id, take] : pending_) {
    unavailable(id, take, "link-down");
    Take waiting; waiting.recipients = take.waiting; unavailable(id, waiting, "link-down");
  }
  pending_.clear(); streams_.clear(); out_.clear(); sent_mask_ = 0;
  state_ = detach ? "detached" : "down"; reason_ = reason;
  if (detach) api_ = {};
  lane_states();
}
int Link::input(const std::uint8_t *msg, std::size_t len) {
  std::lock_guard lock(mu_);
  if (!api_.link_out) return 0;
  if (state_ == "down") return -1;
  try {
    if (!msg || !len) throw std::invalid_argument("audio-protocol");
    auto m = decode_link(Bytes(msg, msg + len));
    if (m.type == 0 && (m.clock_domain == std::string(32, '0') || domain_ == std::string(32, '0') || m.clock_domain != domain_)) { down("clock-domain"); return -1; }
    if (!receive(m)) { down("link-protocol"); return -1; }
    return 1;
  } catch (const std::invalid_argument &) { down("link-protocol"); return -1; }
}
bool Link::receive(const LinkMessage &m) {
  if (m.type == 0) {
    if (state_ != "connecting") return false;
    const auto old_bankset = bankset_;
    const auto old_lanes = lane_snapshot_locked();
    lanes_ = m.lanes;
    for (auto &lane : lanes_) {
      // Groups are identity keys; diagnostic lane names alone may be truncated.
      if (lane.group.size() > cue_group_bytes || std::any_of(lane.group.begin(), lane.group.end(), [](unsigned char c) {
        return c < 32 || c > 126 || c == '"' || c == '\\';
      })) return false;
      std::size_t end = 0;
      while (end < lane.name.size()) {
        auto next = end + 1;
        while (next < lane.name.size() && (static_cast<unsigned char>(lane.name[next]) & 0xc0) == 0x80) ++next;
        if (quote(lane.name.substr(0, next)).size() - 2 > 128) break;
        end = next;
      }
      lane.name.resize(end);
    }
    // Both ready and audio-state are immutable for an open connection. End the
    // old stream before publishing any traffic that uses new host metadata.
    if (old_bankset != m.bankset || old_lanes != lane_snapshot_locked()) resync(1001, "stream-ended");
    bankset_ = m.bankset;
    state_ = "up"; reason_.clear();
    lane_states(); update_mask(); return true;
  }
  if (state_ != "up" || m.type > 4) return false;
  if (m.type == 1) {
    auto b = decode_block(m.block); const auto &h = b.header;
    if (h.kind == 2) {
      const auto lane = std::find_if(lanes_.begin(), lanes_.end(), [&](const auto &l) { return l.id == h.lane; });
      if (lane == lanes_.end()) return false;
      for (const auto &[conn, c] : conns_) if (effective_mask(c) & (1u << h.lane)) sender_.block(conn, b);
      return true;
    }
    auto p = std::find_if(pending_.begin(), pending_.end(), [&](const auto &v) { return v.second.stream == h.stream; });
    if (p == pending_.end()) return true; // Late answer for an abandoned relay.
    auto &take = p->second;
    if (take.last || h.block != take.next_block || bool(h.flags & 1) != (h.block == 0) ||
        h.frames > take.frames - take.received) return false;
    take.received += h.frames; ++take.next_block;
    if (bool(h.flags & 2) != (take.received == take.frames)) return false;
    // Keep the last block until ready arrives, so the sender releases ready only
    // after that block has actually reached the carrier (control has priority).
    if (h.flags & 2) take.last = std::move(b);
    else for (auto conn : take.recipients) if (conns_.count(conn) && needs(conns_.at(conn), p->first)) {
      sender_.block(conn, b); ++relayed_blocks_; relayed_bytes_ += m.block.size();
    }
    return true;
  }
  auto p = pending_.find(m.key_id);
  if (p == pending_.end()) return true; // Late answer for an abandoned relay.
  auto &take = p->second;
  if (m.type == 2) {
    if (take.stream || streams_.count(m.stream)) return false;
    std::erase_if(take.recipients, [&](auto conn) { return !conns_.count(conn) || !needs(conns_.at(conn), m.key_id); });
    streams_.insert(m.stream); take.stream = m.stream; take.frames = m.frames;
    for (auto conn : take.recipients) if (conns_.count(conn) && needs(conns_.at(conn), m.key_id))
      sender_.text(conn, event("take-start", ",\"key_id\":" + quote(m.key_id) + ",\"stream\":" +
          std::to_string(m.stream) + ",\"frames\":" + std::to_string(m.frames) + ",\"bankset\":" + quote(bankset_)), true);
  } else if (m.type == 3) {
    if (take.stream != m.stream) return true; // Ready for an abandoned stream.
    if (!take.last) return false;
    const auto after = event("take-ready", ",\"key_id\":" + quote(m.key_id) + ",\"stream\":" +
        std::to_string(m.stream) + ",\"hash\":" + quote(m.wav_sha256));
    for (auto conn : take.recipients) if (conns_.count(conn) && needs(conns_.at(conn), m.key_id)) {
      sender_.block(conn, *take.last, after); ++relayed_blocks_; relayed_bytes_ += 48 + take.last->payload.size();
    }
    finished(p);
  } else {
    unavailable(m.key_id, take, reasons[m.reason]); finished(p);
  }
  return true;
}
void Link::want(const std::string &id, const Take &take) {
  LinkMessage m; m.type=5; m.key_id=id; m.key=take.key; m.t_us=take.t_us;
  out_.push_back(encode_link(m)); ++wants_; sender_.wake_source();
}
void Link::finished(std::map<std::string, Take>::iterator p) {
  Take next; next.key=std::move(p->second.key); next.t_us=p->second.t_us;
  for (auto conn : p->second.waiting)
    if (conns_.count(conn) && needs(conns_.at(conn), p->first)) next.recipients.insert(conn);
  if (next.recipients.empty()) { pending_.erase(p); return; }
  p->second=std::move(next); want(p->first,p->second);
}
void Link::drain() {
  std::lock_guard lock(mu_);
  while (!out_.empty() && api_.link_out && state_ != "down") {
    auto bytes = std::move(out_.front()); out_.pop_front();
    if (api_.link_out(api_.self, bytes.data(), bytes.size()) != 1) { down("link-down"); break; }
  }
}
std::string Link::advertise(std::uint32_t conn) {
  std::lock_guard lock(mu_);
  // Reserve before ready is queued, but do not publish to input traffic yet.
  if (conn) conns_.try_emplace(conn);
  return lane_snapshot_locked();
}
void Link::opened(std::uint32_t conn, const std::function<void(const std::string &, const std::string &)> &snapshot) {
  std::lock_guard lock(mu_);
  auto [c, inserted] = conns_.try_emplace(conn);
  (void)inserted;
  snapshot(bankset_, lane_snapshot_locked());
  c->second.published = true;
  for (auto &[id, take] : pending_) { (void)id; (take.stream ? take.waiting : take.recipients).insert(conn); }
}
void Link::prune() {
  for (auto p = pending_.begin(); p != pending_.end();) {
    if (!p->second.recipients.empty() || !p->second.waiting.empty()) { ++p; continue; }
    const auto id = p->first;
    // Only an unsent want can be cancelled. Keep dispatched entries until the
    // terminal reply, even with no recipients, so a later cue joins that want.
    const auto cancelled = std::erase_if(out_, [&](const Bytes &bytes) { const auto m = decode_link(bytes); return m.type == 5 && m.key_id == id; });
    if (!cancelled) { ++p; continue; }
    p = pending_.erase(p);
  }
}
void Link::resync(std::uint16_t code, const char *reason) {
  // A seat-wide resync includes every recipient and waiter. Sender rejects any
  // further enqueue immediately, before the carrier processes its close.
  for (const auto &[conn, c] : conns_) { (void)c; sender_.close(conn, code, reason, true); }
  conns_.clear(); pending_.clear(); out_.clear();
  update_mask();
}
void Link::removed(std::uint32_t conn) {
  std::lock_guard lock(mu_); conns_.erase(conn);
  for (auto &[id, take] : pending_) { (void)id; take.recipients.erase(conn); take.waiting.erase(conn); }
  prune(); update_mask();
}
void Link::have(std::uint32_t conn, const std::string &bankset, std::set<std::string> ids) {
  std::lock_guard lock(mu_);
  if (auto c = conns_.find(conn); c != conns_.end()) {
    c->second.have = bankset == bankset_ ? std::move(ids) : std::set<std::string>{};
    for (auto &[id, take] : pending_) {
      if (!needs(c->second, id)) { take.recipients.erase(conn); take.waiting.erase(conn); }
      else if (!take.stream) take.recipients.insert(conn);
      else if (!take.recipients.count(conn)) take.waiting.insert(conn);
    }
  }
  prune();
}
std::uint16_t Link::effective_mask(const Connection &c) const {
  std::uint16_t mask = 0;
  for (const auto &l : lanes_) if (!muted_.count(l.group)) mask |= c.lanes & (1u << l.id);
  return mask;
}
std::uint16_t Link::union_mask() const {
  std::uint16_t mask = 0;
  for (const auto &[conn, c] : conns_) { (void)conn; mask |= effective_mask(c); }
  return mask;
}
void Link::update_mask() {
  const auto mask = union_mask();
  if (state_ != "up" || mask == sent_mask_) return;
  LinkMessage m; m.type = 6; m.lane_mask = mask; out_.push_back(encode_link(m));
  sent_mask_ = mask; sender_.wake_source();
}
void Link::lane_states() {
  if (lanes_.empty()) return;
  for (const auto &[conn, c] : conns_) {
    if (!c.published) continue;
    std::string rows;
    for (const auto &l : lanes_) {
      if (!rows.empty()) rows += ',';
      rows += descriptor(l) + ",\"state\":\"" + (state_ != "up" ? "unavailable" : effective_mask(c) & (1u << l.id) ? "on" : "off") + "\"}";
    }
    sender_.text(conn, event("lanes", ",\"lanes\":[" + rows + "]"), true);
  }
}
bool Link::lanes(std::uint32_t conn, std::uint16_t mask) {
  std::lock_guard lock(mu_);
  std::uint16_t available = 0;
  for (const auto &l : lanes_) available |= 1u << l.id;
  if ((mask & ~available) || !conns_.count(conn)) return false;
  conns_[conn].lanes = mask; lane_states(); update_mask(); return true;
}
void Link::groups(const std::string &snapshot) {
  std::lock_guard lock(mu_); rs::json_lite::JValue v;
  if (!rs::json_lite::Reader(snapshot).parse(&v)) return;
  muted_.clear();
  for (const auto &[name, gain] : v.fields) {
    // The capture snapshot uses float_r; avoid platform floating parsers here.
    if (gain.text == "0" || gain.text == "-0") muted_.insert(name);
  }
  lane_states(); update_mask();
}
void Link::cue(const CueRecord &r) {
  if (r.kind != 1) return;
  std::lock_guard lock(mu_);
  const auto id = hex(Bytes(r.key_id.begin(), r.key_id.end()));
  Take take;
  for (const auto &[conn, c] : conns_) if (c.published && needs(c, id)) take.recipients.insert(conn);
  if (take.recipients.empty()) return;
  if (state_ != "up") { unavailable(id, take, "link-down"); return; }
  if (auto p = pending_.find(id); p != pending_.end()) {
    for (auto conn : take.recipients) {
      if (!p->second.stream) p->second.recipients.insert(conn);
      else if (!p->second.recipients.count(conn)) p->second.waiting.insert(conn);
    }
    return;
  }
  if (pending_.size() >= pending_relay_limit) { resync(1013, "audio-overflow"); return; }
  take.key.assign(r.key.data(), r.key_len); take.t_us=r.t_us;
  want(id, take); pending_.emplace(id, std::move(take));
}
std::string Link::bankset() const { std::lock_guard lock(mu_); return bankset_; }
std::string Link::lane_snapshot() const { std::lock_guard lock(mu_); return lane_snapshot_locked(); }
std::string Link::lane_snapshot_locked() const {
  std::string out;
  for (const auto &l : lanes_) { if (!out.empty()) out += ','; out += descriptor(l) + '}'; }
  return out;
}
void Link::evidence(JsonWriter &j) const {
  std::lock_guard lock(mu_);
  j.object_begin().field("state", state_).field("reason", reason_);
  if (state_ == "detached") j.field_null("clock_domain").field_null("bankset");
  else j.field("clock_domain", domain_).field("bankset", bankset_);
  j.key("pending").unsigned_integer(pending_.size());
  j.key("wants").unsigned_integer(wants_).key("relayed_blocks").unsigned_integer(relayed_blocks_);
  j.key("relayed_bytes").unsigned_integer(relayed_bytes_).object_end();
}
} // namespace grc::audio
extern "C" GRC_EXPORT int grc_audio_link_attach_v1(const grc_audio_link_v1 *link) {
  std::lock_guard lock(grc::audio::endpoint_mu);
  return grc::audio::endpoint ? grc::audio::endpoint->attach(link) : 0;
}
extern "C" GRC_EXPORT int grc_audio_link_in(const std::uint8_t *msg, std::size_t len) {
  std::lock_guard lock(grc::audio::endpoint_mu);
  return grc::audio::endpoint ? grc::audio::endpoint->input(msg, len) : 0;
}
