#include "rs_audio_hub.h"
#include "report.h"
#include "rs_json_lite.h"
#include "rs_platform.h"
#include "rs_sha256.h"
#include <chrono>
#include <cmath>
#include <limits>
#include <sstream>
#include <locale>
namespace grc::audio {
namespace {
constexpr const char *bankset = "00000000000000000000000000000000";
constexpr const char *lane = "{\"id\":1,\"name\":\"synthetic\",\"group\":\"SFX\"}";
using rs::json_lite::JValue;
std::string json_quoted(const std::string &value) { grc::JsonWriter j; j.string(value); return j.take(); }
bool hex_id(const JValue *v) {
  if (!v || v->kind != JValue::String || v->text.size() != 32) return false;
  for (char c : v->text) if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) return false;
  return true;
}
}
Hub::Hub(Config config, rs2::LiveTransport &transport, bool synthetic_demo, bool source_armed, bool automatic)
    : cues_(grant_cues()), sender_(config, transport, automatic), link_(sender_), demo_(synthetic_demo), source_armed_(source_armed || synthetic_demo),
      godot_sample_(config.godot_sample) {
  sender_.source([this] { drain_cues(); });
  cues_.bind(&sender_, [](void *self) { static_cast<Sender *>(self)->wake_source(); });
  if (demo_) {
    const auto wav = synthetic_wav();
    sample(",\"variants\":[{\"codec\":\"wav\",\"hash\":\"" + sha256_hex(wav.data(), wav.size()) +
        "\",\"bytes\":" + std::to_string(wav.size()) + "}],\"channels\":2,\"rate\":48000,\"length_ms\":21.333333,"
        "\"loop\":{\"mode\":\"disabled\",\"begin\":0,\"end\":0},\"store\":true");
    clock_ = std::thread([this] { media_clock(); });
  }
}
Hub::~Hub() { shutdown(); }
void Hub::shutdown() {
  link_.shutdown();
  cues_.unbind();
  { std::lock_guard lock(mu_); stopping_ = true; }
  cv_.notify_all();
  if (clock_.joinable()) clock_.join();
  sender_.shutdown();
}
std::string Hub::event(std::string type, std::string members, std::uint64_t at_us) {
  return "{\"type\":" + json_quoted(type) + ",\"t\":" + std::to_string(at_us ? at_us : now_us()) + members + "}";
}
std::string Hub::ready(std::uint32_t conn) {
  std::lock_guard lock(mu_);
  return ",\"rate\":48000,\"lane_block_frames\":512,\"codec\":\"pcm16\",\"godot\":true,\"fmod\":" +
      std::string(demo_ || cue_attached() ? "true" : "false") + ",\"lanes\":[" + (demo_ ? lane : link_.advertise(conn)) + "]}";
}
void Hub::opened(std::uint32_t conn) {
  std::lock_guard lock(mu_);
  conns_[conn];
  link_.groups(cues_.group_snapshot());
  cues_.connections(true);
  std::string voices;
  for (const auto &[id, text] : voices_) {
    (void)id;
    if (!voices.empty()) voices += ',';
    voices += text.substr(0, text.size() - 1) + ",\"position_s\":0,\"paused\":false}";
  }
  link_.opened(conn, [&](const std::string &bank, const std::string &lanes) {
#if defined(GRC_AUDIO_LINK_TESTING)
    if (test_before_snapshot) test_before_snapshot();
#endif
    sender_.text(conn, event("audio-state", ",\"godot\":{\"buses\":[],\"voices\":[" + voices + "]},\"fmod\":" +
        (demo_ || cue_attached() ? fmod_snapshot(demo_ ? bankset : bank, cues_.group_snapshot(), demo_ ? lane : lanes) : "null")), true);
  });
  for (const auto &[id, text] : samples_) { (void)id; sender_.text(conn, text, true); }
  if (demo_) demo(conn);
}
void Hub::removed(std::uint32_t conn) {
  { std::lock_guard lock(mu_); conns_.erase(conn); link_.removed(conn); if (conns_.empty()) cues_.connections(false); }
  sender_.remove(conn); cv_.notify_all();
}
void Hub::broadcast(const std::string &text) {
  for (const auto &[conn, state] : conns_) { (void)state; sender_.text(conn, text, true); }
}
std::uint32_t Hub::sample(std::string members) {
  std::lock_guard lock(mu_);
  if (next_sample_ > std::numeric_limits<std::uint32_t>::max()) throw std::overflow_error("audio-overflow");
  const auto id = static_cast<std::uint32_t>(next_sample_++);
  auto text = event("sample", ",\"id\":" + std::to_string(id) + members);
  JValue registration;
  if (rs::json_lite::Reader(text).parse(&registration)) {
    const auto *variants = registration.get("variants");
    if (variants && variants->kind == JValue::Array) for (const auto &v : variants->items) {
      const auto *hash = v.get("hash"), *codec = v.get("codec");
      if (hash && codec && hash->kind == JValue::String && codec->kind == JValue::String)
        assets_[{hash->text, codec->text}];
    }
  }
  samples_[id] = text; broadcast(text); return id;
}
void Hub::sample_drop(std::uint32_t id) {
  std::lock_guard lock(mu_);
  if (samples_.erase(id)) broadcast(event("sample-drop", ",\"id\":" + std::to_string(id)));
}
std::uint32_t Hub::start(std::uint32_t sample_id) {
  std::lock_guard lock(mu_);
  if (!samples_.count(sample_id)) throw std::invalid_argument("audio-protocol");
  if (next_voice_ > std::numeric_limits<std::uint32_t>::max()) throw std::overflow_error("audio-overflow");
  const auto voice = static_cast<std::uint32_t>(next_voice_++);
  auto text = event("start", ",\"voice\":" + std::to_string(voice) + ",\"sample\":" + std::to_string(sample_id) +
      ",\"bus\":0,\"offset_s\":0,\"pitch\":1,\"volumes\":[1,1,1,1,1,1,1,1]");
  voices_[voice] = text; broadcast(text); return voice;
}
void Hub::stop(std::uint32_t voice) {
  std::lock_guard lock(mu_);
  if (voices_.erase(voice)) broadcast(event("stop", ",\"voice\":" + std::to_string(voice) + ",\"reason\":\"stop\""));
}
bool Hub::message(std::uint32_t conn, const std::string &text) {
  std::lock_guard lock(mu_);
  auto it = conns_.find(conn);
  if (it == conns_.end() || text.size() > 4096) return false;
  JValue root;
  if (!rs::json_lite::Reader(text).parse(&root) || root.kind != JValue::Object) return false;
  const auto *type = root.get("type");
  if (!type || type->kind != JValue::String) return false;
  auto &c = it->second;
  if (type->text == "clock") {
    auto *v = root.get("c");
    if (!v || v->kind != JValue::Number) return false;
    std::istringstream input(v->text); input.imbue(std::locale::classic());
    double value = 0; input >> value;
    if (!input || !std::isfinite(value) || value < 0) return false;
    sender_.text(conn, event("clock", ",\"c\":" + v->text + ",\"h\":" + std::to_string(now_us())), true);
    return true;
  }
  if (type->text == "have") {
    auto *bank = root.get("bankset"), *ids = root.get("key_ids"), *reset = root.get("reset");
    if (!hex_id(bank) || !ids || ids->kind != JValue::Array || ids->items.size() > 100 ||
        !reset || reset->kind != JValue::Bool || (!c.have_reset && !reset->b)) return false;
    auto have = reset->b || c.have_bank != bank->text ? std::set<std::string>{} : c.have;
    for (const auto &id : ids->items) { if (!hex_id(&id)) return false; have.insert(id.text); }
    if (have.size() > 4096) return false;
    c.have_reset = true; c.have_bank = bank->text;
    // A cache for a different bankset never suppresses a take from this source.
    c.have = bank->text == (demo_ ? bankset : link_.bankset()) ? std::move(have) : std::set<std::string>{};
    link_.have(conn, bank->text, c.have);
    return true;
  }
  if (type->text == "lanes") {
    auto *ids = root.get("ids");
    if (!ids || ids->kind != JValue::Array || ids->items.size() > 15) return false;
    std::uint16_t mask = 0;
    for (const auto &id : ids->items) {
      if (id.kind != JValue::Number || id.text.empty() || id.text.size() > 2 || id.text[0] == '0') return false;
      unsigned n = 0;
      for (char ch : id.text) { if (ch < '0' || ch > '9') return false; n = n * 10 + ch - '0'; }
      if (n < 1 || n > 15 || (mask & (1u << n)) || (demo_ && n != 1)) return false;
      mask |= 1u << n;
    }
    if (!demo_) return link_.lanes(conn, mask);
    c.lanes = mask;
    sender_.text(conn, event("lanes", ",\"lanes\":[" + (demo_ ? std::string("{\"id\":1,\"name\":\"synthetic\",\"group\":\"SFX\",\"state\":\"") + (mask ? "on" : "off") + "\"}" : "") + "]"), true);
    cv_.notify_all(); return true;
  }
  return false;
}
Bytes Hub::synthetic_wav() {
  Bytes wav;
  const auto str = [&](const char *s) { for (int i = 0; i < 4; ++i) wav.push_back(s[i]); };
  const auto n = [&](std::uint32_t value, unsigned size) {
    for (unsigned i = 0; i < size; ++i) wav.push_back((value >> (i * 8)) & 255);
  };
  str("RIFF"); n(36 + 4096, 4); str("WAVE"); str("fmt "); n(16, 4);
  n(1, 2); n(2, 2); n(48000, 4); n(192000, 4); n(4, 2); n(16, 2);
  str("data"); n(4096, 4); wav.resize(44 + 4096);
  return wav;
}
void Hub::demo(std::uint32_t conn) {
  if (next_voice_ > std::numeric_limits<std::uint32_t>::max()) throw std::overflow_error("audio-overflow");
  const auto voice = next_voice_++;
  const auto members = ",\"voice\":" + std::to_string(voice);
  sender_.text(conn, event("start", members + ",\"sample\":1,\"bus\":0,\"offset_s\":0,\"pitch\":1,\"volumes\":[1,1,1,1,1,1,1,1]"), true);
  sender_.text(conn, event("stop", members + ",\"reason\":\"stop\""), true);
  // The flag-driven source is engine-free. It exercises text and first/last PCM framing.
  const std::string key = "event:/synthetic";
  const std::string id = key_id(key);
  const auto cue_us = now_us();
  sender_.text(conn, event("cue", ",\"key_id\":\"" + id + "\",\"key\":" + json_quoted(key) +
      ",\"kind\":\"oneshot\",\"group\":\"SFX\",\"pitch\":1,\"volume\":1", cue_us), true);
  if (conns_[conn].have.count(id)) return;
  if (next_take_ > std::numeric_limits<std::uint32_t>::max()) throw std::overflow_error("audio-overflow");
  auto stream = static_cast<std::uint32_t>(next_take_++);
  sender_.text(conn, event("take-start", ",\"key_id\":\"" + id + "\",\"stream\":" + std::to_string(stream) +
      ",\"frames\":1024,\"bankset\":\"" + bankset + "\""), true);
  for (unsigned i = 0; i < 2; ++i) {
    Block b; b.header.stream = stream; b.header.block = i; b.header.flags = i ? 2 : 1;
    b.header.frames = 512; b.header.made_us = now_us(); b.header.due_us = cue_us + i * 512000000ull / 48000;
    b.payload.resize(2048);
    auto after = i ? event("take-ready", ",\"key_id\":\"" + id + "\",\"stream\":" + std::to_string(stream) +
        ",\"hash\":\"" + sha256_hex(synthetic_wav().data(), synthetic_wav().size()) + "\"") : "";
    sender_.block(conn, std::move(b), std::move(after));
  }
}
void Hub::synthetic_cue() {
  std::lock_guard lock(mu_);
  if (!demo_) return;
  const std::string key = "event:/synthetic";
  broadcast(event("cue", ",\"key_id\":\"" + key_id(key) + "\",\"key\":" + json_quoted(key) +
      ",\"kind\":\"oneshot\",\"group\":\"SFX\",\"pitch\":1,\"volume\":1"));
}
void Hub::asset_served(const std::string &hash, const std::string &codec, std::uint64_t bytes) {
  std::lock_guard lock(mu_);
  auto &s = assets_[{hash, codec}]; ++s.hits; s.bytes += bytes;
}
std::string Hub::json() const {
  std::lock_guard lock(mu_);
  const auto connections = sender_.evidence();
  grc::JsonWriter j;
  j.object_begin().field("schema", std::string("render-stream-live-audio/1"));
  j.key("godot").object_begin();
  j.field("state", std::string(source_armed_ ? "synthetic" : godot_sample_ ? "unavailable" : "off"));
  j.key("unsampled").unsigned_integer(0).object_end();
  j.key("cue").object_begin().field("attached", cue_attached());
  j.key("ring_high_water").unsigned_integer(cues_.high_water());
  j.key("groups_full").unsigned_integer(cues_.groups_full());
  j.key("groups_refused").unsigned_integer(cues_.groups_refused()).object_end();
  j.key("link"); link_.evidence(j);
  std::map<std::string, std::string> paths;
  for (const auto &[id, c] : connections) { (void)id; paths[c.carrier] = c.threaded ? "thread" : "frame"; }
  j.key("send_path").object_begin();
  for (const auto &[carrier, path] : paths) j.field(carrier, path);
  j.object_end().key("connections").array_begin();
  for (const auto &[id, c] : connections) {
    j.object_begin().key("connection").unsigned_integer(id);
    j.field("carrier", c.carrier).field("closed", c.closed);
    j.field("send_path", std::string(c.threaded ? "thread" : "frame"));
    j.key("messages").object_begin();
    for (const auto &[type, count] : c.stats.texts) j.key(type).unsigned_integer(count);
    j.object_end().key("classes").object_begin();
    for (unsigned cls = 0; cls < 3; ++cls) {
      j.key(cls == 0 ? "control" : cls == 1 ? "take" : "lane").object_begin();
      j.key("sent").unsigned_integer(c.stats.sent[cls]);
      j.key("dropped").unsigned_integer(c.stats.dropped[cls]).object_end();
    }
    j.object_end().key("blocks").object_begin();
    for (unsigned cls = 1; cls < 3; ++cls) {
      j.key(cls == 1 ? "take" : "lane").object_begin();
      j.key("sent").unsigned_integer(c.stats.sent[cls]);
      j.key("dropped").unsigned_integer(c.stats.dropped[cls]).object_end();
    }
    j.object_end().key("gaps").unsigned_integer(c.stats.gaps);
    j.key("backpressured_lane_drops").unsigned_integer(c.stats.backpressured_lane_drops);
    j.key("max_lateness_us").unsigned_integer(c.stats.max_lateness_us);
    j.key("stalls").unsigned_integer(c.stats.stalls).object_end();
  }
  j.array_end().key("assets").array_begin();
  for (const auto &[key, s] : assets_) {
    j.object_begin().field("hash", key.first).field("codec", key.second);
    j.key("hits").unsigned_integer(s.hits).key("bytes").unsigned_integer(s.bytes).object_end();
  }
  j.array_end().object_end();
  return j.take();
}
void Hub::drain_cues() {
  std::lock_guard lock(mu_);
  if (cues_.overflow()) {
    for (const auto &[conn, c] : conns_) {
      (void)c; sender_.close(conn, 1013, "audio-overflow", true);
    }
  }
  CueRecord record;
  for (std::size_t n = 0; n < cue_ring_slots && cues_.pop(record); ++n) {
    broadcast(cue_text(record));
    if (record.kind) link_.cue(record);
    else link_.groups(cues_.group_snapshot());
  }
  link_.drain();
}
void Hub::media_clock() {
  rs::set_current_thread_name("rs-audio-clock");
  std::unique_lock lock(mu_);
  const auto subscribed = [&] {
    for (const auto &[conn, c] : conns_) { (void)conn; if (c.lanes) return true; }
    return false;
  };
  while (!stopping_) {
    cv_.wait(lock, [&] { return stopping_ || subscribed(); });
    if (stopping_) break;
    if (lane_epoch_ == std::numeric_limits<std::uint32_t>::max()) break;
    ++lane_epoch_; lane_block_ = 0;
    const auto origin = now_us();
    while (!stopping_ && subscribed()) {
      const auto due = origin + std::uint64_t(lane_block_) * 512000000ull / 48000;
      cv_.wait_until(lock, std::chrono::steady_clock::time_point(std::chrono::microseconds(due)),
          [&] { return stopping_ || !subscribed(); });
      if (stopping_ || !subscribed()) break;
      Block b; b.header.kind = 2; b.header.lane = 1; b.header.stream = lane_epoch_;
      b.header.block = lane_block_++; b.header.frames = 512; b.header.made_us = now_us(); b.header.due_us = due;
      b.payload.resize(2048);
      for (const auto &[conn, c] : conns_) if (c.lanes & 2) sender_.block(conn, b);
    }
  }
}
}  // namespace grc::audio
