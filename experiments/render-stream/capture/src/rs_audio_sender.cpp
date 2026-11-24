#include "rs_audio_sender.h"
#include "rs_platform.h"
#include <algorithm>
#include <chrono>
namespace grc::audio {
std::uint64_t now_us() {
  return std::chrono::duration_cast<std::chrono::microseconds>(
      std::chrono::steady_clock::now().time_since_epoch()).count();
}
Sender::Sender(Config config, rs2::LiveTransport &transport, bool automatic)
    : config_(std::move(config)), transport_(transport),
      media_(dynamic_cast<MediaTransport *>(&transport)), automatic_(automatic) {}
Sender::~Sender() { shutdown(); }
void Sender::shutdown() {
  { std::lock_guard lock(mu_); stopping_ = true; }
  cv_.notify_all();
  if (thread_.joinable()) thread_.join();
  // A full carrier must not hide an explicit close when the sender is being joined.
  std::lock_guard lock(mu_);
  for (auto &[conn, c] : conns_) {
    for (const auto &m : c.queues[0]) if (m.close_code) {
      closes_.push_back({conn, m.close_code, m.text});
      for (auto &q : c.queues) q.clear();
      break;
    }
  }
}
void Sender::add(std::uint32_t conn, std::string carrier) {
  std::lock_guard lock(mu_);
  auto &c = conns_[conn];
  c.carrier = std::move(carrier);
  c.threaded = media_ && media_->media_threaded(conn);
  if (automatic_ && c.threaded && !thread_.joinable()) thread_ = std::thread([this] { run(); });
}
void Sender::remove(std::uint32_t conn) {
  std::lock_guard lock(mu_);
  auto it = conns_.find(conn);
  if (it == conns_.end()) return;
  const auto &c = it->second;
  retired_[conn] = {c.stats, c.carrier, c.threaded, true};
  conns_.erase(it);
}
bool Sender::text(std::uint32_t conn, std::string text, bool stamp, std::uint64_t at_us) {
  {
    std::lock_guard lock(mu_);
    auto it = conns_.find(conn);
    if (it == conns_.end() || it->second.closing) return false;
    Message m; m.text = std::move(text); m.stamp = stamp;
    m.enqueued_us = at_us ? at_us : now_us();
    it->second.queues[0].push_back(std::move(m));
  }
  cv_.notify_all();
  return true;
}
bool Sender::block(std::uint32_t conn, Block block, std::string after, std::uint64_t at_us) {
  // Reuse the wire validator before taking ownership of a producer's block.
  encode_block(block.header, block.payload);
  {
    std::lock_guard lock(mu_);
    auto it = conns_.find(conn);
    if (it == conns_.end() || it->second.closing) return false;
    Message m; m.block = std::move(block); m.binary = true; m.after = std::move(after);
    m.enqueued_us = at_us ? at_us : now_us();
    const auto cls = m.block.header.kind == 1 ? 1 : 2;
    it->second.queues[cls].push_back(std::move(m));
  }
  cv_.notify_all();
  return true;
}
void Sender::close(std::uint32_t conn, std::uint16_t code, std::string reason) {
  {
    std::lock_guard lock(mu_);
    auto it = conns_.find(conn);
    if (it == conns_.end() || it->second.closing) return;
    auto &c = it->second;
    c.closing = true;
    c.queues[1].clear(); c.queues[2].clear();
    Message m; m.close_code = code; m.text = std::move(reason); m.enqueued_us = now_us();
    c.queues[0].push_back(std::move(m));
  }
  cv_.notify_all();
}
void Sender::frame() { pump(false, 0); }
void Sender::pump(bool threaded, std::uint64_t supplied_us) {
  std::lock_guard lock(mu_);
  const auto finish = [&](std::uint32_t conn, Connection &c, std::uint16_t code, const std::string &reason) {
    closes_.push_back({conn, code, reason}); c.closing = true;
    for (auto &q : c.queues) q.clear();
  };
  for (;;) {
    const auto at_us = supplied_us ? supplied_us : now_us();
    auto selected = conns_.end();
    unsigned cls = 3;
    for (auto it = conns_.begin(); it != conns_.end(); ++it) {
      auto &[conn, c] = *it;
      if (c.threaded != threaded) continue;
      bool stalled = false;
      for (unsigned priority = 0; priority < 2; ++priority) {
        const auto &q = c.queues[priority];
        if (!q.empty() && at_us > q.front().enqueued_us + config_.stall_ms * 1000ull) stalled = true;
      }
      if (stalled) { ++c.stats.stalls; finish(conn, c, 1001, "audio-stalled"); continue; }
      auto &lanes = c.queues[2];
      for (auto m = lanes.begin(); m != lanes.end();) {
        if (at_us > m->block.header.due_us + config_.lane_late_ms * 1000ull) {
          c.gaps |= 1u << m->block.header.lane;
          if (transport_.queued_bytes(conn) >= config_.queue_bytes) ++c.stats.backpressured_lane_drops;
          ++c.stats.dropped[2]; m = lanes.erase(m);
        } else ++m;
      }
      unsigned priority = 0;
      while (priority < 3 && c.queues[priority].empty()) ++priority;
      if (priority == 3) continue;
      const auto &m = c.queues[priority].front();
      if (m.close_code) { finish(conn, c, m.close_code, m.text); continue; }
      if (priority < cls && transport_.queued_bytes(conn) < config_.queue_bytes) {
        selected = it; cls = priority;
      }
    }
    if (selected == conns_.end()) break;
    auto &[conn, c] = *selected;
    auto &q = c.queues[cls];
    auto &m = q.front();
    Bytes bytes;
    std::uint32_t group = 0, flags = 1;
    std::uint64_t deadline = 0, lateness_us = 0;
    bool gap = false;
    if (m.binary) {
      auto h = m.block.header;
      h.sent_us = at_us;
      if (cls == 2) {
        if (c.gaps & (1u << h.lane)) { h.flags |= 8; gap = true; }
        deadline = h.due_us + config_.lane_late_ms * 1000ull;
      }
      bytes = encode_block(h, m.block.payload);
      group = cls == 1 ? h.stream : h.lane;
      flags = (h.flags & 2) ? 2 : 0;
      lateness_us = at_us > h.due_us ? at_us - h.due_us : 0;
    } else {
      std::string text = m.text;
      if (text.starts_with("{\"type\":\"track-ready\"")) {
        const std::string clock_key = "\"clock_us\":";
        const auto at = text.find(clock_key);
        if (at != std::string::npos) {
          const auto first = at + clock_key.size();
          const auto last = text.find(',', first);
          text.replace(first, last - first, std::to_string(at_us));
        }
      }
      if (m.stamp) {
        text.pop_back(); text += ",\"s\":" + std::to_string(at_us) + "}";
      }
      bytes.assign(text.begin(), text.end());

    }
    const auto bytes_size = bytes.size();
    bool ok;
    if (threaded) ok = media_->send_media(conn, cls == 1 ? 2 : cls == 2 ? 3 : 0,
        group, flags, deadline, std::move(bytes));
    else if (m.binary) ok = transport_.send_binary(conn, std::move(bytes));
    else ok = transport_.send_text(conn, std::string(bytes.begin(), bytes.end()));
    if (!ok) { ++c.stats.stalls; finish(conn, c, 1001, "audio-stalled"); continue; }
    if (gap) { c.gaps &= ~(1u << m.block.header.lane); ++c.stats.gaps; }
    c.stats.max_lateness_us = std::max(c.stats.max_lateness_us, lateness_us);
    ++c.stats.sent[cls];
    if (m.binary) {
      ++c.stats.payload_messages; c.stats.payload_bytes += bytes_size;
    } else {
      const auto type_end = m.text.find('"', 9);
      if (m.text.starts_with("{\"type\":\"") && type_end != std::string::npos) {
        const auto type = m.text.substr(9, type_end - 9);
        ++c.stats.texts[type];
        if (type != "track-ready" && type != "track-error") {
          ++c.stats.payload_messages; c.stats.payload_bytes += bytes_size;
        }
      }
    }
    std::string after = std::move(m.after);
    q.pop_front();
    // Completion is made eligible only after the last take block was handed off.
    if (!after.empty()) {
      Message done; done.text = std::move(after); done.stamp = true; done.enqueued_us = at_us;
      c.queues[0].push_back(std::move(done));
    }
  }
}
std::vector<Sender::Close> Sender::take_closes() {
  std::lock_guard lock(mu_); std::vector<Close> out; out.swap(closes_); return out;
}
Sender::Stats Sender::stats(std::uint32_t conn) const {
  std::lock_guard lock(mu_); auto it = conns_.find(conn); return it == conns_.end() ? Stats{} : it->second.stats;
}
std::map<std::uint32_t, Sender::Evidence> Sender::evidence() const {
  std::lock_guard lock(mu_);
  auto out = retired_;
  for (const auto &[id, c] : conns_) out[id] = {c.stats, c.carrier, c.threaded, c.closing};
  return out;
}
void Sender::run() {
  rs::set_current_thread_name("rs-audio");
  std::unique_lock lock(mu_);
  for (;;) {
    bool pending = false;
    for (const auto &[id, c] : conns_) {
      (void)id;
      if (c.threaded) for (const auto &q : c.queues) pending |= !q.empty();
    }
    if (stopping_) { lock.unlock(); pump(true, 0); return; }
    if (pending) cv_.wait_for(lock, std::chrono::milliseconds(1));
    else cv_.wait(lock);
    lock.unlock(); pump(true, 0); lock.lock();
    if (stopping_) break;
  }
}
}  // namespace grc::audio
