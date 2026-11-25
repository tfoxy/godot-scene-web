#include "rs_audio_slab.h"
#include "rs_audio_cue.h"
#include <memory>
#include "rs_json_lite.h"
#include "report.h"
#include <atomic>
#include <bit>
#include <cstdio>
#include <cstdlib>
#include <new>
#include <limits>
#include <cmath>
#include <memory>

namespace { std::atomic<uint64_t> allocations{0}; bool counting = false; }
void *operator new(size_t n) { if (counting) ++allocations; if (void *p = std::malloc(n ? n : 1)) return p; throw std::bad_alloc(); }
void *operator new[](size_t n) { return ::operator new(n); }
[[gnu::noinline]] void operator delete(void *p) noexcept { std::free(p); }
[[gnu::noinline]] void operator delete[](void *p) noexcept { std::free(p); }
[[gnu::noinline]] void operator delete(void *p, size_t) noexcept { std::free(p); }
[[gnu::noinline]] void operator delete[](void *p, size_t) noexcept { std::free(p); }
namespace grc::audio {
struct AudioSlabTestAccess {
  static void worst(AudioSlab &slab) {
    slab.next_sample_ = UINT32_MAX;
    SampleState sample; sample.key = 1; sample.ready = true;
    slab.sample(sample, UINT64_MAX);
    slab.bus("count", 0, int(kAudioBuses), 0, false, UINT64_MAX);
    // Worst-case finite float32 spelling; all eight gains and voice floats use it.
    float longest = -std::numeric_limits<float>::min();
    for (float f : {-std::numeric_limits<float>::max(), -std::numeric_limits<float>::denorm_min(),
                    -1.2345678e-30f, -1.2345678e-10f, -123456.78f})
      if (float_r(f).size() > float_r(longest).size()) longest = f;
    // float_r emits at most nine significant digits, a sign, decimal point,
    // E, exponent sign and two exponent digits: fifteen bytes in total.
    for (uint32_t i = 0; i < 65536 && float_r(longest).size() < 15; ++i) {
      const float candidate = std::bit_cast<float>(0x81000001u + i * 7919u);
      if (float_r(candidate).size() > float_r(longest).size()) longest = candidate;
    }
    if (float_r(longest).size() != 15) std::abort();
    for (size_t i = 0; i < kAudioBuses; ++i) {
      slab.name(int(i), std::string(64, '"'));
      slab.buses_[i].volume_db = longest; slab.buses_[i].send = 31;
    }
    slab.next_voice_ = UINT32_MAX - kAudioVoices + 1;
    for (size_t i = 0; i < kAudioVoices; ++i) {
      VoiceState v; v.key = i + 1; v.bus = 31; v.offset_s = longest; v.pitch = longest;
      v.volumes.fill(longest); slab.start(v, 1, UINT64_MAX);
    }
  }
};
}
namespace {
using namespace grc::audio;
int passed = 0, failed = 0;
void check(bool ok, const char *name) { if (ok) ++passed; else { ++failed; std::fprintf(stderr, "FAIL: %s\n", name); } }
struct Sink : GodotSink {
  std::vector<std::string> events; int overflows = 0;
  void godot_text(const std::string &text) override { events.push_back(text); }
  void godot_overflow() override { ++overflows; }
};

using grc::rs::json_lite::JValue;
using grc::rs::json_lite::Reader;
constexpr const char *hash = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
bool event(const Sink &sink, size_t i, const char *type, uint64_t t) {
  JValue v;
  return i < sink.events.size() && Reader(sink.events[i]).parse(&v) &&
      v.get("type") && v.get("type")->text == type && v.get("t") && v.get("t")->text == std::to_string(t);
}
void regressions() {
  {
    auto slab = std::make_unique<AudioSlab>(); Sink output;
    slab->arm(); slab->attach(&output); slab->connected(true);
    slab->bus("count", 0, 2, 0, false, 1);
    SampleState s; s.key = 1; slab->sample(s, 2);
    VoiceState v; v.key = 2; v.bus = 1; slab->start(v, 1, 3);
    slab->bus("remove", 1, 0, 0, false, 4);
    slab->variant(1, hash, 44, 5);
    JValue start, snapshot;
    const bool parsed = output.events.size() == 4 && Reader(output.events[3]).parse(&start) &&
        Reader(slab->snapshot(6)).parse(&snapshot);
    check(event(output, 1, "bus", 4) && event(output, 3, "start", 3), "bus removal precedes deferred start");
    check(parsed && start.get("bus") && start.get("bus")->text == "-1" &&
        snapshot.get("godot")->get("voices")->items[0].get("bus")->text == start.get("bus")->text,
        "deferred start after bus removal matches live snapshot bus");
    bool in_range = parsed;
    if (parsed) {
      const auto count = snapshot.get("godot")->get("buses")->items.size();
      for (size_t i = 2; i < output.events.size(); ++i) {
        JValue message;
        in_range &= Reader(output.events[i]).parse(&message);
        if (const auto *bus = message.get("bus")) in_range &= std::stoi(bus->text) < int(count);
      }
    }
    check(in_range, "no deferred bus index reaches current bus count after removal");
  }
  {
    auto slab = std::make_unique<AudioSlab>(); Sink output;
    slab->arm(); slab->attach(&output); slab->connected(true);
    slab->bus("count", 0, 2, 0, false, 1);
    SampleState s; s.key = 1; slab->sample(s, 2);
    VoiceState v; v.key = 2; v.bus = 1; slab->start(v, 1, 3);
    std::array<int, 6> buses{1}; std::array<Volumes, 6> volumes{};
    slab->volumes(2, buses, volumes, 1, 4);
    // Retain the ended voice before the topology change so its whole history must move.
    slab->stop(2, 5);
    slab->bus("add", 0, 0, 0, false, 6);
    slab->variant(1, hash, 44, 7);
    JValue start, routes;
    check(output.events.size() == 6 && event(output, 1, "bus", 6) && event(output, 3, "start", 3) &&
        event(output, 4, "voice-volumes", 4) && event(output, 5, "stop", 5), "ended voice replays after bus insertion in original call order");
    check(output.events.size() > 3 && Reader(output.events[3]).parse(&start) && start.get("bus") &&
        start.get("bus")->text == "2", "ended deferred start follows bus insertion");
    check(output.events.size() > 4 && Reader(output.events[4]).parse(&routes) && routes.get("buses") &&
        routes.get("buses")->items.size() == 1 && routes.get("buses")->items[0].get("bus")->text == "2",
        "ended pending routes follow bus insertion");
  }
  {
    auto slab = std::make_unique<AudioSlab>(); Sink output;
    slab->arm(); slab->attach(&output); slab->connected(true);
    SampleState s; s.key = 1; VoiceState v; v.key = 2;
    const auto before = allocations.load(); counting = true;
    slab->sample(s, 1); slab->start(v, 1, 2);
    slab->pitch(2, 2, 3); slab->pause(2, true, 4); slab->volumes(2, {}, {}, 1, 5);
    slab->stop(2, 6); slab->drop(1, 7);
    counting = false;
    check(allocations == before && output.events.empty(), "pending history and ended retention allocate zero times before publication");
    slab->variant(1, hash, 44, 8);
    check(event(output, 5, "stop", 6) && output.events[5].find("\"reason\":\"stop\"") != std::string::npos,
        "pending explicit stop keeps its original reason");
  }
  {
    auto slab = std::make_unique<AudioSlab>(); Sink output;
    slab->arm(); slab->attach(&output);
    SampleState s; s.key = 1; slab->sample(s, 1);
    VoiceState v; v.key = 2; slab->start(v, 1, 2);
    slab->pitch(2, 2, 3); slab->pause(2, true, 4); slab->volumes(2, {}, {}, 1, 5);
    slab->connected(true, 100); slab->pitch(2, 3, 110); slab->pause(2, false, 120);
    slab->variant(1, hash, 44, 200);
    check(output.events.size() == 6 && event(output, 1, "start", 100) &&
        output.events[1].find("\"pitch\":2") != std::string::npos && event(output, 2, "pause", 100) &&
        event(output, 3, "voice-volumes", 100) && event(output, 4, "pitch", 110) && event(output, 5, "pause", 120),
        "pending dormant join restores baseline then preserves new connected updates");
  }
  for (bool connected : {false, true}) {
    auto slab = std::make_unique<AudioSlab>(); Sink output;
    slab->arm(); slab->attach(&output); slab->connected(connected);
    for (float value : {-INFINITY, std::numeric_limits<float>::quiet_NaN(), INFINITY}) {
      try {
        slab->bus("volume_db", 0, 0, value, false, 10);
        JValue snapshot;
        bool ok = Reader(slab->snapshot(11)).parse(&snapshot);
        const auto *godot = snapshot.get("godot");
        const auto *buses = godot ? godot->get("buses") : nullptr;
        const auto *volume = buses && !buses->items.empty() ? buses->items[0].get("volume_db") : nullptr;
        const double expected = value > 0 ? std::numeric_limits<float>::max() : std::numeric_limits<float>::lowest();
        ok = ok && volume && std::isfinite(std::stod(volume->text)) && float(std::stod(volume->text)) == expected;
        if (connected) {
          JValue message;
          ok = ok && Reader(output.events.back()).parse(&message) && message.get("value") &&
              std::isfinite(std::stod(message.get("value")->text)) && float(std::stod(message.get("value")->text)) == expected;
        }
        check(ok, connected ? "connected non-finite bus gain is finite JSON" : "dormant non-finite bus gain snapshots as finite JSON");
      } catch (const std::exception &e) {
        std::fprintf(stderr, "non-finite bus gain exception: %s\n", e.what());
        check(false, connected ? "connected non-finite bus gain must not throw" : "dormant non-finite bus gain must not throw");
      }
    }
  }
  for (bool unregister : {false, true}) {
    auto slab = std::make_unique<AudioSlab>(); Sink output;
    slab->arm(); slab->attach(&output); slab->connected(true);
    SampleState s; s.key = 1; slab->sample(s, 100);
    VoiceState v; v.key = 2; slab->start(v, 1, 200);
    if (unregister) slab->drop(1, 220);
    slab->stop(2, 250, "end");
    slab->variant(1, hash, 44, 300);
    check(output.events.size() == (unregister ? 4 : 3) && event(output, 0, "sample", 100) &&
        event(output, 1, "start", 200) && event(output, 2, "stop", 250), "short pending one-shot publishes sample/start/stop with original times");
    if (unregister) check(event(output, 3, "sample-drop", 250), "short pending unregistered one-shot drops after stop");
  }
  {
    auto slab = std::make_unique<AudioSlab>(); Sink output;
    slab->arm(); slab->attach(&output); slab->connected(true);
    SampleState s; s.key = 1; slab->sample(s, 100);
    VoiceState v; v.key = 2; slab->start(v, 1, 200);
    for (size_t i = 0; i < kAudioPendingUpdates + 2; ++i) slab->pitch(2, float(i + 1), 210 + i);
    slab->pause(2, true, 240); slab->volumes(2, {}, {}, 1, 250);
    slab->variant(1, hash, 44, 300);
    JValue start;
    check(slab->pending_updates_full == 1 && output.events.size() == 4 && Reader(output.events[1]).parse(&start) &&
        start.get("pitch")->text == std::to_string(kAudioPendingUpdates + 2), "update overflow counts once and collapses to current start state");
    check(event(output, 2, "pause", 300) && event(output, 3, "voice-volumes", 300), "collapsed history restores final pause and routes at publication time");
    check(slab->evidence().find("\"pending_updates_full\": 1") != std::string::npos, "update overflow appears in evidence");
  }
  {
    auto slab = std::make_unique<AudioSlab>(); Sink output;
    slab->arm(); slab->attach(&output); slab->connected(true);
    struct Supplier : VariantSupplier {
      unsigned releases = 0;
      void request(uint32_t, uint64_t) override {}
      void released(uint32_t) override { ++releases; }
    } supplier;
    slab->supplier(&supplier);
    SampleState s; s.key = 1; slab->sample(s, 1);
    VoiceState v; v.key = 2;
    for (size_t i = 0; i < kAudioPendingEnds + 1; ++i) {
      slab->start(v, 1, 10 + i); slab->stop(2, 20 + i, "end");
    }
    check(slab->pending_ends_full == 1 && slab->voices_full == 0, "ended record cap counts overflow independently and frees live slots");
    check(slab->evidence().find("\"pending_ends_full\": 1") != std::string::npos, "ended record overflow appears in evidence");
    // Even a full ended-record store leaves every live-voice slot available.
    for (size_t i = 0; i < kAudioVoices; ++i) { v.key = i + 10; slab->start(v, 1, 1000); }
    check(slab->voices_full == 0 && slab->voice(kAudioVoices + 9), "ended records never occupy live voice slots");
    for (size_t i = 0; i < kAudioVoices; ++i) slab->stop(i + 10, 1100);
    slab->drop(1, 1200);
    check(supplier.releases == 0 && slab->wanted(1), "ended records retain unregistered supplier asset");
    slab->metadata(1, 22050, 2, 0);
    slab->variant(1, hash, 44, 1300);
    size_t stops = 0; for (const auto &text : output.events) if (text.find("\"type\":\"stop\"") != std::string::npos) ++stops;
    check(stops == kAudioPendingEnds && output.events.size() == 2 * kAudioPendingEnds + 2 && supplier.releases == 1 && !slab->wanted(1),
        "full ended record store drains exactly once then drops and releases sample");
    check(output.events[0].find("\"channels\":2,\"rate\":22050") != std::string::npos &&
        event(output, output.events.size() - 1, "sample-drop", 20 + kAudioPendingEnds - 1), "ended-only asset retains worker metadata and deferred drop order");
  }
  {
    auto slab = std::make_unique<AudioSlab>(); Sink output;
    slab->arm(); slab->attach(&output); slab->connected(true);
    SampleState s; s.key = 1; slab->sample(s, 1);
    VoiceState v; v.key = 2; slab->start(v, 1, 2); slab->stop(2, 3); slab->drop(1, 4);
    slab->connected(false); slab->connected(true); slab->variant(1, hash, 44, 5);
    check(output.events.empty() && !slab->wanted(1), "disconnect clears ended records without announcing stale voices or drops");
    s.key = 3; slab->sample(s, 6); v.key = 4; slab->start(v, 3, 7); slab->pitch(4, 2, 8);
    slab->connected(false); slab->connected(true); slab->variant(2, hash, 44, 9);
    check(output.events.size() == 2 && event(output, 0, "sample", 6) && event(output, 1, "start", 7) &&
        output.events[1].find("\"pitch\":2") != std::string::npos, "reconnect collapses old live-voice history into current state");
  }
  for (bool unregister : {false, true}) for (bool end_before_hash : {false, true}) {
    auto slab = std::make_unique<AudioSlab>(); Sink output;
    slab->arm(); slab->attach(&output); slab->connected(true);
    SampleState s; s.key = 1; slab->sample(s, 100);
    VoiceState v; v.key = 2; v.pitch = 1; v.offset_s = .25; v.volumes.fill(.5);
    slab->start(v, 1, 200);
    slab->pitch(2, 2, 210); slab->pause(2, true, 220); slab->pause(2, false, 230);
    std::array<int, 6> buses{1}; std::array<Volumes, 6> volumes{}; volumes[0].fill(.75);
    slab->volumes(2, buses, volumes, 1, 240);
    if (unregister) slab->drop(1, 250);
    if (end_before_hash) slab->stop(2, 260, "end");
    check(slab->wanted(1), "pending voice or ended record retains sample for worker");
    slab->variant(1, hash, 44, 300);
    if (!end_before_hash) slab->stop(2, 310, "end");
    slab->stop(2, 320);
    check(output.events.size() == (unregister ? 8 : 7), "pending hash preserves exactly one start and stop and deferred drop");
    check(event(output, 0, "sample", 100) && event(output, 1, "start", 200), "sample precedes original start timestamp");
    JValue start;
    check(output.events.size() > 1 && Reader(output.events[1]).parse(&start) && start.get("pitch") &&
        start.get("pitch")->text == "1" && start.get("offset_s")->text == "0.25" &&
        start.get("volumes")->items[0].text == "0.5", "pending start retains its original members");
    check(event(output, 2, "pitch", 210) && event(output, 3, "pause", 220) &&
        event(output, 4, "pause", 230) && event(output, 5, "voice-volumes", 240), "pending updates replay in call order at original timestamps");
    JValue paused, resumed;
    check(output.events.size() > 4 && Reader(output.events[3]).parse(&paused) && paused.get("paused") && paused.get("paused")->b &&
        Reader(output.events[4]).parse(&resumed) && resumed.get("paused") && !resumed.get("paused")->b, "pending pause and resume both survive");
    check(event(output, 6, "stop", end_before_hash ? 260 : 310) && output.events[6].find("\"reason\":\"end\"") != std::string::npos,
        "ended voice replays exactly one stop with original reason and timestamp");
    if (unregister) check(event(output, 7, "sample-drop", end_before_hash ? 260 : 310) && !slab->wanted(1), "unregistered sample drops immediately after last stop");
  }
  {
    auto slab = std::make_unique<AudioSlab>(); Sink output;
    slab->arm(); slab->attach(&output); slab->connected(true);
    SampleState s; s.key = 1; slab->sample(s, 1); slab->drop(1, 2); slab->variant(1, hash, 44, 3);
    check(output.events.empty() && !slab->wanted(1), "unannounced registration without voices emits no sample-drop");
  }
  for (bool joined_while_dormant : {false, true}) {
    auto slab = std::make_unique<AudioSlab>(); Sink output;
    slab->arm(); slab->attach(&output); slab->connected(!joined_while_dormant);
    SampleState s; s.key = 1; s.ready = true; slab->sample(s, 1);
    VoiceState v; v.key = 2; slab->start(v, 1, 2); v.key = 3; slab->start(v, 1, 3);
    slab->drop(1, 4);
    check(output.events.size() == (joined_while_dormant ? 0 : 3), "sample-drop waits while unregistered sample has voices");
    check(slab->samples(5).size() == 1 && slab->snapshot(5).find("\"sample\":1") != std::string::npos,
        "client joining after unregister receives retained sample and voices");
    slab->connected(true); output.events.clear();
    slab->stop(2, 6); slab->stop(3, 7);
    check(output.events.size() == 3 && event(output, 0, "stop", 6) && event(output, 1, "stop", 7) && event(output, 2, "sample-drop", 7),
        "joining client gets one drop directly after last stop");
  }
}
}
int main() {
  regressions();
  AudioSlab slab; Sink sink; slab.arm(); slab.attach(&sink);
  SampleState s; s.key = 1; s.ready = true; s.hash.fill('a'); s.hash[64] = 0;
  VoiceState v; v.key = 1; v.volumes.fill(1);
  counting = true;
  for (size_t i = 0; i < kAudioSamples; ++i) { s.key = i + 1; slab.sample(s, 1); }
  s.key = kAudioSamples + 1; auto overflow_sample = slab.sample(s, 1);
  for (size_t i = 0; i < kAudioVoices; ++i) { v.key = i + 1; slab.start(v, 2, 1); }
  v.key = kAudioVoices + 1; auto overflow_voice = slab.start(v, 2, 1);
  slab.pause(1, true, 2); slab.pitch(1, 1.5, 2);
  slab.name(0, "Master"); slab.bus("volume_db", 0, 0, -6, false, 2);
  slab.volumes(1, {}, {}, 0, 2);
  slab.stop(1, 2); slab.drop(1, 2);
  counting = false;
  std::printf("dormant allocations: %llu\n", static_cast<unsigned long long>(allocations.load()));
  check(allocations == 0, "dormant sample/voice/bus operations allocate zero times");
  check(!overflow_sample && slab.samples_full == 1, "sample cap refuses id and counts overflow");
  check(!overflow_voice && slab.voices_full == 1, "voice cap refuses id and counts overflow");
  check(sink.events.empty(), "dormant hooks emit nothing");
  check(slab.sample(s, 3) == kAudioSamples + 1, "unregister frees sample slot, id is never reused");
  check(slab.start(v, kAudioSamples + 1, 3) == kAudioVoices + 1, "stop frees voice slot, id is never reused");
  slab.stop(v.key, 3); v.key += 1;
  check(slab.start(v, kAudioSamples + 2, 3) == 0 && slab.voices_full == 2, "uncaptured sample refuses voice");
  slab.connected(true);
  slab.pause(2, true, 4); slab.pitch(2, 2, 5); slab.stop(2, 6); slab.stop(2, 7);
  check(sink.events.size() == 3, "pause and pitch plus exactly one stop emitted");
  const auto snapshot = slab.snapshot(8);
  grc::rs::json_lite::JValue root;
  check(grc::rs::json_lite::Reader(snapshot).parse(&root), "snapshot is valid JSON");
  check(snapshot.find("\"pitch\":1.5") == std::string::npos, "stopped voice is absent from join snapshot");
  slab.bus("count", 0, 33, 0, false, 9);
  check(sink.overflows == 1 && std::string(slab.state()) == "unavailable:bus-limit", "33rd bus latches capture off and asks for resync");
  check(slab.snapshot(10).find("\"godot\":null") != std::string::npos, "reconnect has godot null");
  slab.bus("count", 0, 1, 0, false, 11);
  check(!slab.available() && sink.overflows == 1, "bus overflow cannot rearm or close-loop");
  for (const auto &name : {std::string(200, 'a'), std::string(200, '"'), std::string(200, '\b'), std::string(200, '\1')}) {
    grc::JsonWriter j; j.string(AudioSlab::diagnostic_name(name));
    check(j.take().size() <= kAudioNameBytes + 3, "diagnostic name respects JSON-escaped byte cap");
  }
  std::string utf8(127, 'a'); utf8 += "\xe2\x82\xac";
  check(AudioSlab::diagnostic_name(utf8) == std::string(127, 'a'), "truncate at UTF-8 code-point boundary");
  {
    AudioSlab retained; Sink output; retained.arm(); retained.attach(&output); retained.connected(true);
    struct Supplier : VariantSupplier {
      uint32_t id = 0; uint64_t key = 0;
      void request(uint32_t i, uint64_t k) override { id = i; key = k; }
    } supplier;
    retained.supplier(&supplier);
    SampleState pending; pending.key = 55;
    retained.sample(pending, 1);
    VoiceState live; live.key = 88; retained.start(live, pending.key, 2);
    check(output.events.empty() && supplier.id == 1 && supplier.key == 55, "supplier gates sample and start on original hash");
    retained.variant(supplier.id, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", 44, 3);
    check(output.events.size() == 2 && output.events[0].find("\"type\":\"sample\"") != std::string::npos &&
          output.events[1].find("\"type\":\"start\"") != std::string::npos, "hash completion publishes sample before start");
    std::array<int, 6> routes{0, 1, 2, 3, 4, 5}; std::array<Volumes, 6> gains{};
    for (size_t i = 0; i < gains.size(); ++i) gains[i].fill(float(i) / 10);
    retained.volumes(88, routes, gains, 6, 4);
    auto updates = retained.snapshot_updates(5);
    check(updates.size() == 1 && updates[0].find("\"bus\":5,\"v\":[0.5") != std::string::npos,
          "join snapshot replays all six voice routes");
    retained.drop(55, 6);
    check(retained.snapshot(7).find("\"voice\":1") != std::string::npos && retained.samples(7).size() == 1,
          "unregister preserves live voice and sample metadata on join");
    pending.key = 55; retained.sample(pending, 8);
    check(supplier.id == 2 && retained.samples(8).size() == 1, "reused engine pointer does not replace retained sample identity");
    retained.stop(88, 9);
    check(retained.samples(10).empty(), "last stop releases unregistered sample metadata");
    const auto evidence = retained.evidence();
    check(evidence.find("\"unsampled\": null") != std::string::npos && evidence.find("not-observable-at-seam") != std::string::npos,
          "unobservable streams reported explicitly as null");
  }
  AudioSlab worst; worst.arm(); AudioSlabTestAccess::worst(worst);
  // Encode both full source slabs together; samples are separate messages.
  auto cues = std::make_unique<CueIngress>();
  std::array<std::string, cue_group_slots> names;
  std::array<grc_audio_gain, cue_group_slots> gains;
  for (size_t i = 0; i < names.size(); ++i) {
    names[i] = std::to_string(100 + i) + std::string(cue_group_bytes - 3, 'g');
    gains[i] = {names[i].data(), names[i].size(), 0.000100000005f};
  }
  check(float_r(gains[0].gain).size() == 14, "FMOD maximum nonnegative float spelling is exercised");
  check(cues->groups(gains.data(), gains.size(), 1) == 1, "combined snapshot fills FMOD group slab");
  std::string lane_rows;
  for (unsigned i = 1; i <= 15; ++i) {
    if (i > 1) lane_rows += ',';
    lane_rows += "{\"id\":" + std::to_string(i) + ",\"name\":\"" + std::string(kAudioNameBytes, 'l') +
        "\",\"group\":\"" + names[0] + "\"}";
  }
  const auto fmod = fmod_snapshot(std::string(32, 'f'), cues->group_snapshot(), lane_rows);
  auto maximum = worst.snapshot(UINT64_MAX, fmod);
  maximum.pop_back(); maximum += ",\"s\":18446744073709551615}";
  // Charge all shared envelope bytes to Godot, keeping the split conservative.
  const auto godot_bytes = maximum.size() - fmod.size() + 4; // fmod:null
  std::printf("worst audio-state: %zu bytes (godot/envelope %zu, fmod %zu; %zu voices, %zu buses, %zu groups, 15 lanes)\n",
      maximum.size(), godot_bytes, fmod.size(), kAudioVoices, kAudioBuses, cue_group_slots);
  check(godot_bytes <= 48 * 1024, "Godot snapshot including envelope t/s fits 48 KiB");
  check(fmod.size() <= 12 * 1024, "FMOD snapshot fits 12 KiB at full groups and lanes");
  check(maximum.size() <= 60 * 1024, "combined full slabs including envelope t/s fit 60 KiB");
  check(grc::rs::json_lite::Reader(maximum).parse(&root), "combined worst-case snapshot parses");
  const auto *godot = root.get("godot"), *fmod_state = root.get("fmod");
  check(godot && godot->get("voices")->items.size() == kAudioVoices &&
      godot->get("buses")->items.size() == kAudioBuses &&
      fmod_state && fmod_state->get("groups")->fields.size() == cue_group_slots &&
      fmod_state->get("lanes")->items.size() == 15 && root.get("t") && root.get("s"),
      "one encoded snapshot contains both full source slabs and t/s");
  std::printf("rs_audio_slab: %d passed, %d failed\n", passed, failed);
  return failed ? 1 : 0;
}
