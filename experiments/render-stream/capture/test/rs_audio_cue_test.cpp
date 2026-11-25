#include "rs_audio_hub.h"
#include "rs_json_lite.h"
#include <atomic>
#include <barrier>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <limits>
#include <new>
namespace a = grc::audio;
namespace j = grc::rs::json_lite;
thread_local bool count_allocations = false;
std::atomic<unsigned> allocations{0};
[[gnu::noinline]] void *operator new(std::size_t size) {
  if (count_allocations) allocations.fetch_add(1, std::memory_order_relaxed);
  if (void *p = std::malloc(size ? size : 1)) return p;
  throw std::bad_alloc();
}
void *operator new[](std::size_t size) { return ::operator new(size); }
[[gnu::noinline]] void operator delete(void *p) noexcept { std::free(p); }
[[gnu::noinline]] void operator delete[](void *p) noexcept { std::free(p); }
[[gnu::noinline]] void operator delete(void *p, std::size_t) noexcept { std::free(p); }
[[gnu::noinline]] void operator delete[](void *p, std::size_t) noexcept { std::free(p); }
unsigned checks = 0, failures = 0;
void check(bool ok, const char *name) {
  ++checks; if (!ok) { ++failures; std::fprintf(stderr, "FAIL: %s\n", name); }
}
struct Fake : grc::rs2::LiveTransport, a::MediaTransport {
  struct Text { std::uint32_t conn; std::string text; std::thread::id thread; };
  std::mutex mu;
  std::vector<Text> texts;
  bool threaded = false;
  std::uint64_t queued = 0;
  bool send_binary(std::uint32_t, a::Bytes) override { return true; }
  bool send_text(std::uint32_t conn, std::string text) override {
    std::lock_guard lock(mu); texts.push_back({conn, std::move(text), std::this_thread::get_id()}); return true;
  }
  void close(std::uint32_t, std::uint16_t, std::string) override {}
  std::uint64_t queued_bytes(std::uint32_t) const override { return queued; }
  std::uint64_t max_queued_bytes(std::uint32_t) const override { return 0; }
  bool media_threaded(std::uint32_t) const override { return threaded; }
  bool send_media(std::uint32_t conn, std::uint8_t, std::uint32_t,
      std::uint32_t, std::uint64_t, a::Bytes bytes) override {
    return send_text(conn, std::string(bytes.begin(), bytes.end()));
  }
};
int main() {
  count_allocations = true; void *probe = ::operator new(16); count_allocations = false;
  ::operator delete(probe);
  check(allocations.exchange(0) == 1, "allocation counter detects producer-thread allocation");
  grc_audio_cue_v1 api{};
  check(grc_audio_cue_get_v1(nullptr) == -1, "null ABI output refused");
  check(grc_audio_cue_get_v1(&api) == 1 && api.abi_version == 1 && api.size == sizeof(api) &&
      api.active && api.now_us && api.cue && api.groups && api.key_id, "complete v1 ABI table");
  check(api.active() == 0 && api.cue(0, nullptr, nullptr, 9999, nullptr, 9999, 0, 0, 0) == 0,
      "ungranted/dormant returns before reading producer input");
  const std::string key = "event:/test/cue|value=1";
  std::uint8_t id[16];
  check(api.key_id(key.data(), key.size(), id) == 1 &&
      a::hex(a::Bytes(id, id + 16)) == a::key_id(key), "key helper agrees with wire codec");
  check(api.now_us() > 0 && api.now_us() <= a::now_us(), "capture monotonic clock");
  {
    // Exercise the actual MPSC algorithm with no ingress mutex and a full wrap.
    auto ring = std::make_unique<a::CueRing>();
    for (unsigned round = 0; round < 3; ++round) {
      std::array<std::thread, 8> threads;
      std::atomic<unsigned> refused{0};
      std::barrier start(8);
      for (unsigned p = 0; p < threads.size(); ++p) threads[p] = std::thread([&, p] {
        start.arrive_and_wait(); count_allocations = true;
        for (unsigned n = 0; n < 128; ++n) {
          a::CueRecord r; r.kind = p; r.t_us = n;
          if (!ring->push(r)) ++refused;
        }
        count_allocations = false;
      });
      for (auto &t : threads) t.join();
      check(refused == 0, "all 1024 concurrent ring reservations accepted");
      a::CueRecord r;
      check(!ring->push(r), "1025th slot refused without corrupting FIFO");
      std::array<unsigned, 8> next{}; unsigned count = 0; bool ordered = true;
      while (ring->pop(r)) { ++count; ordered &= r.t_us == next[r.kind]++; }
      check(count == 1024 && ordered, "ring FIFO per producer across wraps");
    }
    check(ring->high_water() == 1024, "ring high-water reaches exact capacity");
    std::array<std::thread, 4> producers;
    std::barrier start(5);
    for (unsigned p = 0; p < producers.size(); ++p) producers[p] = std::thread([&, p] {
      start.arrive_and_wait(); count_allocations = true;
      for (unsigned n = 0; n < 2048; ++n) {
        a::CueRecord r; r.kind = p; r.t_us = n;
        while (!ring->push(r)) std::this_thread::yield();
      }
      count_allocations = false;
    });
    start.arrive_and_wait();
    std::array<unsigned, 4> next{}; unsigned count = 0; bool ordered = true;
    while (count < 8192) {
      a::CueRecord r;
      if (ring->pop(r)) { ++count; ordered &= r.t_us == next[r.kind]++; }
      else std::this_thread::yield();
    }
    for (auto &p : producers) p.join();
    check(ordered && count == 8192, "simultaneous producer/consumer FIFO through ring reuse");
  }
  {
    auto ingress = std::make_unique<a::CueIngress>();
    ingress->connections(true);
    for (unsigned n = 0; n < 1024; ++n)
      api.cue(1, id, key.data(), key.size(), "SFX", 3, n, 1, 1);
    check(api.cue(1, id, key.data(), key.size(), "SFX", 3, 1024, 1, 1) == -1 &&
        ingress->overflow() && api.active() == 0 && !ingress->overflow(),
        "consuming overflow atomically disables producers and clears the notification");
    ingress->connections(false);
  }
  {
    Fake t; a::Hub h({}, t, false, false, false);
    const grc_audio_gain muted{"SFX", 3, 0};
    check(api.groups(&muted, 1, 1) == 1 && api.active() == 0, "dormant group gains retained");
    check(api.cue(99, nullptr, nullptr, 9999, nullptr, 9999, 0, 0, 0) == 0, "dormancy ignores invalid values");
    h.sender().add(1); h.opened(1); h.sender().frame();
    check(api.active() == 1, "open connection activates producer");
    check(t.texts.size() == 1 && t.texts[0].text.find("\"groups\":{\"SFX\":0}") != std::string::npos,
        "audio-state includes dormant group snapshot");
    check(api.cue(1, id, key.data(), key.size(), "SFX", 3, 123, 1, 1) == 0, "zero group gain suppresses cue");
    const grc_audio_gain gain{"SFX", 3, 0.5f};
    check(api.groups(&gain, 1, 0) == 1, "incremental group gain");
    auto bad = a::Bytes(id, id + 16); bad[0] ^= 1;
    count_allocations = true;
    const int mismatch = api.cue(1, bad.data(), key.data(), key.size(), "SFX", 3, 123, 1, 1);
    const int too_long = api.cue(1, id, key.data(), 513, "SFX", 3, 123, 1, 1);
    const int invalid_utf8 = api.cue(1, id, "\xc0\xaf", 2, "SFX", 3, 123, 1, 1);
    const int invalid_kind = api.cue(5, id, key.data(), key.size(), "SFX", 3, 123, 1, 1);
    const int invalid_pitch = api.cue(1, id, key.data(), key.size(), "SFX", 3, 123, std::numeric_limits<float>::infinity(), 1);
    const int invalid_group = api.cue(1, id, key.data(), key.size(), "bad\"", 4, 123, 1, 1);
    count_allocations = false;
    check(mismatch == -1 && too_long == -1 && invalid_utf8 == -1 && invalid_kind == -1 &&
        invalid_pitch == -1 && invalid_group == -1, "refuse mismatched, oversized and invalid cues allocation-free");
    for (unsigned kind = 1; kind <= 4; ++kind)
      check(api.cue(kind, id, key.data(), key.size(), "SFX", 3, 123 + kind, 1.25f, 0.75f) == 1, "all cue kinds accepted");
    std::uint8_t empty[16];
    check(api.key_id(nullptr, 0, empty) == 1 && api.cue(4, empty, nullptr, 0, "SFX", 3, 128, 1, 1) == 1,
        "loop-stop-all supports empty key with matching digest");
    h.drain_cues(); h.sender().frame();
    unsigned cues = 0; bool fields = true;
    for (const auto &text : t.texts) {
      j::JValue v; fields &= j::Reader(text.text).parse(&v);
      if (v.get("type")->text == "cue") {
        ++cues; fields &= v.get("s") && v.get("t") && v.get("key_id") && v.get("group") && v.get("pitch") && v.get("volume");
      }
    }
    check(cues == 5 && fields, "cue fields and event/carrier timestamps");
    h.removed(1); check(api.active() == 0, "last connection makes cue dormant");
  }
  {
    Fake t; a::Hub h({}, t, false, false, false);
    api.groups(nullptr, 0, 1);
    for (unsigned conn : {1, 2}) { h.sender().add(conn); h.opened(conn); }
    h.sender().frame(); t.texts.clear();
    std::array<std::thread, 8> threads; std::barrier start(8);
    std::atomic<unsigned> refused{0};
    for (unsigned p = 0; p < threads.size(); ++p) threads[p] = std::thread([&, p] {
      start.arrive_and_wait(); count_allocations = true;
      for (unsigned n = 0; n < 100; ++n)
        if (api.cue(1, id, key.data(), key.size(), "SFX", 3, 10000 + p * 1000 + n, 1, 1) != 1) ++refused;
      count_allocations = false;
    });
    for (auto &thread : threads) thread.join();
    h.drain_cues(); h.sender().frame();
    std::array<std::array<unsigned, 8>, 2> next{}; bool ordered = true; unsigned cue_count = 0;
    for (const auto &text : t.texts) {
      j::JValue v; if (!j::Reader(text.text).parse(&v) || !v.get("t")) { ordered = false; continue; }
      if (v.get("type")->text != "cue") continue;
      ++cue_count;
      const auto stamp = std::stoull(v.get("t")->text) - 10000;
      const auto producer = stamp / 1000, seq = stamp % 1000;
      ordered &= producer < 8 && seq == next[text.conn - 1][producer]++;
    }
    check(refused == 0 && cue_count == 1600 && ordered, "800 concurrent ABI cues reach both connections in producer FIFO");
    for (unsigned n = 0; n < 1024; ++n)
      if (api.cue(1, id, key.data(), key.size(), "SFX", 3, 20000 + n, 1, 1) != 1) ++refused;
    check(refused == 0 && api.cue(1, id, key.data(), key.size(), "SFX", 3, 30000, 1, 1) == -1,
        "overflow explicitly refuses cue");
    h.drain_cues(); h.sender().frame();
    const auto closes = h.sender().take_closes();
    check(closes.size() == 2 && closes[0].code == 1013 && closes[1].code == 1013 &&
        closes[0].reason == "audio-overflow" && closes[1].reason == "audio-overflow", "overflow resyncs every audio connection");
    check(api.active() == 0, "overflow turns producer dormant until reconnect");
    h.removed(1);
    check(api.active() == 0, "removing one overflowed connection cannot reactivate the other");
    h.removed(2);
    h.sender().add(3); h.opened(3);
    check(api.cue(1, id, key.data(), key.size(), "SFX", 3, 31000, 1, 1) == 1, "reconnect accepts fresh cues");
    h.drain_cues(); h.sender().frame();
    check(h.sender().take_closes().empty(), "overflow does not recur on reconnect");
  }
  {
    Fake t; a::Hub h({}, t, false, false, false);
    std::array<std::string, 64> names;
    std::array<grc_audio_gain, 64> gains;
    for (unsigned i = 0; i < names.size(); ++i) {
      names[i] = std::to_string(100 + i) + std::string(61, 'g');
      gains[i] = {names[i].data(), names[i].size(), 0.000100000005f};
    }
    check(a::float_r(gains[0].gain).size() == 14, "longest nonnegative float spelling is exercised");
    check(api.groups(gains.data(), gains.size(), 1) == 1, "full group slab fits");
    const grc_audio_gain extra{"extra", 5, 1};
    check(api.groups(&extra, 1, 0) == 0, "65th group omitted without a close");
    const grc_audio_gain invalid{"bad\\", 4, 1};
    check(api.groups(&invalid, 1, 0) == -1, "invalid group gain name refused");
    for (const auto &name : {std::string(65, 'a'), std::string("bad\""), std::string("bad\\"),
             std::string("bad\n"), std::string("bad\x7f"), std::string("bad\xc3\xa9")}) {
      const grc_audio_gain bad_gain{name.data(), name.size(), 1};
      check(api.groups(&bad_gain, 1, 0) == -1, "groups refuses oversized/non-printable/escaped names");
    }
    std::string lane_rows;
    for (unsigned i = 1; i <= 15; ++i) {
      if (i > 1) lane_rows += ',';
      lane_rows += "{\"id\":" + std::to_string(i) + ",\"name\":\"" + std::string(128, 'l') +
          "\",\"group\":\"" + names[0] + "\"}";
    }
    const auto fmod = a::fmod_snapshot(std::string(32, 'f'), a::grant_cues().group_snapshot(), lane_rows);
    check(fmod.size() <= 12 * 1024, "worst FMOD snapshot <=12 KiB: 64 groups, 15 lanes, maximum names/floats");
    const auto state = "{\"type\":\"audio-state\",\"t\":18446744073709551615,\"s\":18446744073709551615,\"godot\":null,\"fmod\":" + fmod + "}";
    j::JValue v;
    check(j::Reader(state).parse(&v) && state.size() <= 60 * 1024, "worst FMOD snapshot encodes with envelope/t/s");
    std::printf("worst_fmod_bytes=%zu audio_state_bytes=%zu\n", fmod.size(), state.size());
    h.sender().add(1); h.opened(1); h.sender().frame();
    bool refused_names = true;
    count_allocations = true;
    for (const auto &bad_name : {std::string_view("bad\""), std::string_view("bad\\"),
             std::string_view("bad\n"), std::string_view("bad\x7f"), std::string_view("bad\xc3\xa9")})
      refused_names &= api.cue(1, id, key.data(), key.size(), bad_name.data(), bad_name.size(), 1, 1, 1) == -1;
    const int max_name = api.cue(1, id, key.data(), key.size(), names[0].data(), names[0].size(), 1, 1, 1);
    const int unknown_group = api.cue(1, id, key.data(), key.size(), extra.group, extra.group_len, 1, 1, 1);
    count_allocations = false;
    check(refused_names && max_name == 1, "cue enforces printable ASCII group names and accepts 64 bytes");
    check(unknown_group == 1, "omitted group uses unity gain with a full slab");
    j::JValue evidence;
    check(h.sender().take_closes().empty() && j::Reader(h.json()).parse(&evidence) &&
        evidence.get("cue")->get("groups_full")->text == "1" &&
        evidence.get("cue")->get("groups_refused")->text != "0", "group overflow/refusals counted and connection retained");
    check(api.groups(nullptr, 0, 1) == 1 && a::grant_cues().group_snapshot() == "{}", "empty snapshot replaces entire slab");
  }
  {
    Fake t; a::Config config; a::Sender sender(config, t, false);
    sender.add(1); t.queued = config.queue_bytes;
    sender.text(1, "old control", false, 1);
    sender.close(1, 1013, "audio-overflow", true);
    sender.pump(false, a::now_us() + config.stall_ms * 1000ull + 1);
    const auto closes = sender.take_closes();
    check(closes.size() == 1 && closes[0].code == 1013 && closes[0].reason == "audio-overflow" && t.texts.empty(),
        "overflow resync supersedes expired controls even on a full carrier");
  }
  {
    Fake t; t.threaded = true;
    a::Hub h({}, t); api.groups(nullptr, 0, 1); h.sender().add(1); h.opened(1);
    check(api.cue(1, id, key.data(), key.size(), "SFX", 3, 1234, 1, 1) == 1, "automatic worker cue accepted");
    // shutdown joins rs-audio and drains accepted producer work without a frame callback.
    h.shutdown();
    bool cue = false, worker = true;
    for (const auto &text : t.texts) { cue |= text.text.find("\"type\":\"cue\"") != std::string::npos; worker &= text.thread != std::this_thread::get_id(); }
    check(cue && worker, "rs-audio drains cue ring and sends without the main/frame thread");
  }
  check(allocations == 0, "zero allocations on concurrent ring/ABI producers and refusal paths");
  std::printf("rs_audio_cue: %u passed, %u failed, allocations=%u\n", checks - failures, failures, allocations.load());
  return failures ? 1 : 0;
}
