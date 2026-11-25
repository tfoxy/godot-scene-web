#include "rs_audio_hub.h"
#include "rs_json_lite.h"
#include <atomic>
#include <cstdio>
#include <cstdlib>
#include <set>
namespace a = grc::audio;
namespace j = grc::rs::json_lite;
int checks = 0, failures = 0;
void check(bool ok, const char *name) {
  ++checks; if (!ok) { ++failures; std::fprintf(stderr, "FAIL: %s\n", name); }
}
struct Fake : grc::rs2::LiveTransport, a::MediaTransport {
  std::uint64_t queued = 0;
  bool threaded = false;
  bool reject = false;
  std::vector<std::string> texts;
  std::vector<std::uint32_t> text_conns;
  std::vector<a::Bytes> blocks;
  std::vector<unsigned> classes;
  std::vector<std::thread::id> threads;
  bool send_binary(std::uint32_t, a::Bytes v) override { if (reject) return false; blocks.push_back(std::move(v)); classes.push_back(2); return true; }
  bool send_text(std::uint32_t conn, std::string v) override {
    // Test-only sabotage: losing a stop control must break the voice-pairing oracle.
    if (!(std::getenv("AUDIO_DROP_CUES") && v.find("\"stop\"") != std::string::npos)) { texts.push_back(std::move(v)); text_conns.push_back(conn); }
    classes.push_back(0); return true;
  }
  void close(std::uint32_t, std::uint16_t, std::string) override {}
  std::uint64_t queued_bytes(std::uint32_t) const override { return queued; }
  std::uint64_t max_queued_bytes(std::uint32_t) const override { return queued; }
  bool media_threaded(std::uint32_t) const override { return threaded; }
  bool send_media(std::uint32_t conn, std::uint8_t cls, std::uint32_t group,
      std::uint32_t flags, std::uint64_t deadline, a::Bytes v) override {
    check((cls == 0 && group == 0 && (flags & 1)) || (cls == 2 && group > 0) ||
        (cls == 3 && group >= 1 && group <= 15 && deadline > 0), "media metadata");
    threads.push_back(std::this_thread::get_id());
    if (flags & 1) return send_text(conn, std::string(v.begin(), v.end()));
    return send_binary(conn, std::move(v));
  }
};
a::Block block(bool lane = false, std::uint64_t due = 1000000) {
  a::Block b; b.header.kind = lane ? 2 : 1; b.header.lane = lane ? 1 : 0;
  b.header.frames = 512; b.header.due_us = due; b.header.made_us = due; b.payload.resize(2048); return b;
}
bool paired(const std::vector<std::string> &texts) {
  std::set<std::string> live; unsigned starts = 0, stops = 0;
  for (const auto &text : texts) {
    j::JValue v; if (!j::Reader(text).parse(&v)) return false;
    auto *type = v.get("type"); if (!type) continue;
    if (type->text == "start") { ++starts; if (!live.insert(v.get("voice")->text).second) return false; }
    if (type->text == "stop") { ++stops; if (!live.erase(v.get("voice")->text)) return false; }
  }
  return starts == 2 && stops == 2 && live.empty();
}
int main() {
  a::Config cfg;
  for (bool threaded : {false, true}) {
    Fake t; t.threaded = threaded;
    a::Sender s(cfg, t, false); s.add(1); t.queued = cfg.queue_bytes;
    s.text(1, "{\"type\":\"track-ready\",\"audio\":{\"clock_us\":1000000,\"rate\":48000}}", false, 1000000);
    s.pump(threaded, 1200000);
    check(t.texts.empty(), "full carrier defers track-ready on both send paths");
    t.queued = 0; s.pump(threaded, 1500000);
    check(t.texts.size() == 1 && t.texts[0].find("\"clock_us\":1500000") != std::string::npos,
        "deferred track-ready uses hand-off clock on both send paths");
  }
  {
    Fake t; a::Sender s(cfg, t, false); s.add(1);
    s.block(1, block(true), {}, 1000000); s.block(1, block(), {}, 1000000);
    s.text(1, "{\"type\":\"cue\",\"t\":1000000}", true, 1000000);
    s.pump(false, 1000001);
    check(t.classes == std::vector<unsigned>({0,2,2}), "control before take before lane");
    check(a::decode_block(t.blocks[0]).header.kind == 1 && a::decode_block(t.blocks[1]).header.kind == 2, "take before lane");
    check(t.texts[0].find("\"s\":1000001") != std::string::npos, "event hand-off timestamp");
    check(a::decode_block(t.blocks[0]).header.sent_us == 1000001, "block hand-off timestamp");
    check(t.threads.empty(), "legacy frame fallback");
    check(s.stats(1).payload_messages == 3, "track counters include text and PCM hand-offs");
  }
  {
    Fake t; a::Sender s(cfg, t, false); s.add(1); t.queued = cfg.queue_bytes;
    s.block(1, block(true), {}, 1000000); s.text(1, "cue", false, 1000000);
    s.pump(false, 1060001);
    check(t.classes.empty(), "hand-off cap holds control and lane");
    check(s.stats(1).dropped[2] == 1 && s.stats(1).backpressured_lane_drops == 1, "lane expires while carrier full");
    auto fresh = block(true, 1060001); fresh.header.block = 1;
    s.block(1, fresh, {}, 1060001); t.queued = cfg.queue_bytes - 1;
    s.pump(false, 1060002);
    check(t.texts.size() == 1 && t.blocks.size() == 1, "control retained and fresh lane delivered");
    check((a::decode_block(t.blocks[0]).header.flags & 8) != 0, "next lane block carries gap");
    s.block(1, block(true, 1060002), {}, 1060002); s.pump(false, 1060003);
    check((a::decode_block(t.blocks[1]).header.flags & 8) == 0, "gap consumed exactly once");
    check(s.stats(1).gaps == 1, "gap counted");
  }
  {
    Fake t; a::Sender s(cfg, t, false); s.add(1); s.add(2);
    s.block(1, block(true), {}, 1000000); s.text(2, "cue", false, 1000000);
    s.pump(false, 1000001);
    check(t.classes == std::vector<unsigned>({0,2}), "control priority spans connections");
  }
  {
    Fake t; a::Sender s(cfg, t, false); s.add(1, "ws");
    t.queued = cfg.queue_bytes;
    s.block(1, block(true), {}, 1000000); s.pump(false, 1060001);
    t.queued = 0; t.reject = true;
    s.block(1, block(true, 1060001), {}, 1060001); s.pump(false, 1060002);
    auto closes = s.take_closes();
    check(closes.size() == 1 && closes[0].reason == "audio-stalled", "carrier rejection closes audio-stalled");
    const auto stats = s.stats(1);
    check(stats.stalls == 1 && stats.sent[2] == 0 && stats.gaps == 0 && stats.max_lateness_us == 0,
        "evidence counts stalls but not rejected block hand-offs");
    s.remove(1);
    const auto e = s.evidence();
    check(e.size() == 1 && e.at(1).closed && e.at(1).carrier == "ws" && !e.at(1).threaded &&
        e.at(1).stats.dropped[2] == 1 && e.at(1).stats.backpressured_lane_drops == 1 && e.at(1).stats.stalls == 1, "closed connection evidence retains final counters");
  }
  {
    Fake t; a::Sender s(cfg, t, false); s.add(1); t.queued = cfg.queue_bytes;
    s.text(1, "cue"); s.close(1, 1001, "stream-ended"); s.shutdown();
    const auto closes = s.take_closes();
    check(closes.size() == 1 && closes[0].reason == "stream-ended", "shutdown preserves explicit close behind a full carrier");
  }
  for (bool take : {false, true}) {
    Fake t; a::Sender s(cfg, t, false); s.add(1); t.queued = cfg.queue_bytes;
    if (take) s.block(1, block(), {}, 1000000); else s.text(1, "cue", false, 1000000);
    s.pump(false, 4000000); check(s.take_closes().empty(), "stall boundary does not close early");
    s.pump(false, 4000001); auto closes = s.take_closes();
    check(closes.size() == 1 && closes[0].code == 1001 && closes[0].reason == "audio-stalled", "control/take stall closes");
    check(s.stats(1).stalls == 1 && s.stats(1).dropped[take ? 1 : 0] == 0, "reliable class never silently dropped");
  }
  {
    Fake t; a::Sender s(cfg, t, false); s.add(1);
    auto b = block(); b.header.flags = 3;
    s.block(1, b, "{\"type\":\"take-ready\",\"t\":1000000}", 1000000);
    s.text(1, "take-start", false, 1000000); s.pump(false, 1000001);
    check(t.classes == std::vector<unsigned>({0,2,0}), "take-ready cannot overtake last block");
  }
  {
    Fake t; a::Hub h(cfg, t); h.sender().add(1); h.opened(1);
    const auto first = h.sample(",\"variants\":[],\"channels\":2,\"rate\":48000,\"length_ms\":1,\"loop\":{\"mode\":\"disabled\",\"begin\":0,\"end\":0},\"store\":true");
    const auto v1 = h.start(first); h.stop(v1); h.stop(v1); h.sample_drop(first);
    const auto second = h.sample(",\"variants\":[]"); const auto v2 = h.start(second); h.stop(v2);
    h.sender().frame();
    check(first == 1 && second == 2 && v1 == 1 && v2 == 2, "seat sample and voice ids from one, never reused");
    check(paired(t.texts), "audio-drop-cues: every voice start has exactly one stop");
    check(h.message(1, "{\"type\":\"clock\",\"c\":12.5}"), "clock grammar");
    check(!h.message(1, "{\"type\":\"clock\",\"c\":1e999}"), "nonfinite clock refused");
    check(h.message(1, "{\"type\":\"lanes\",\"ids\":[]}"), "unsubscribe all lanes");
    check(!h.message(1, "{\"type\":\"lanes\",\"ids\":[1]}"), "unannounced lane refused");
    check(!h.message(1, "{\"type\":\"stop\",\"voice\":1}"), "client voice state forbidden");
    check(!h.message(1, "{\"type\":\"have\",\"bankset\":\"00000000000000000000000000000000\",\"key_ids\":[],\"reset\":false}"), "first have must reset");
    for (unsigned batch = 0; batch < 42; ++batch) {
      std::string ids;
      for (unsigned i = 0; i < 100; ++i) {
        char id[40]; std::snprintf(id, sizeof(id), "\"%032x\"", batch * 100 + i);
        if (i) ids += ',';
        ids += id;
      }
      bool ok = h.message(1, "{\"type\":\"have\",\"bankset\":\"00000000000000000000000000000000\",\"key_ids\":[" + ids + "],\"reset\":" + (batch == 0 ? "true" : "false") + "}");
      check(ok == (batch < 40), "have capped at 4096 across messages");
      if (batch == 39) {
        std::string last;
        for (unsigned i = 4000; i < 4096; ++i) {
          char id[40]; std::snprintf(id, sizeof(id), "\"%032x\"", i);
          if (!last.empty()) last += ',';
          last += id;
        }
        check(h.message(1, "{\"type\":\"have\",\"bankset\":\"00000000000000000000000000000000\",\"key_ids\":[" + last + "],\"reset\":false}"), "exactly 4096 have ids accepted");
        check(!h.message(1, "{\"type\":\"have\",\"bankset\":\"00000000000000000000000000000000\",\"key_ids\":[\"00000000000000000000000000001000\"],\"reset\":false}"), "4097th have id refused");
      }
    }
    h.sender().frame();
    check(t.texts.back().find("\"clock\"") != std::string::npos || t.texts.back().find("\"lanes\"") != std::string::npos, "clock/lanes replies");
  }
  {
    Fake t; t.threaded = true;
    a::Sender s(cfg, t); s.add(1); s.text(1, "cue"); s.shutdown();
    check(t.texts.size() == 1 && t.threads.size() == 1 && t.threads[0] != std::this_thread::get_id(), "audio sends owned by worker thread");
  }
  {
    Fake t; a::Hub h(cfg, t, true); h.sender().add(1, "legacy"); h.opened(1); h.sender().frame();
    h.removed(1);
    const auto wav = a::Hub::synthetic_wav();
    h.asset_served("asset-hash", "wav", wav.size());
    const auto text = h.json();
    j::JValue e;
    check(j::Reader(text).parse(&e) && e.get("schema") && e.get("schema")->text == "render-stream-live-audio/1",
        "audio evidence schema is valid JSON");
    const auto *conns = e.get("connections");
    check(conns && conns->items.size() == 1 && conns->items[0].get("closed")->b &&
        conns->items[0].get("send_path")->text == "frame", "legacy carrier reports frame send path after removal");
    check(e.get("godot")->get("state")->text == "synthetic" && !e.get("cue")->get("attached")->b &&
        e.get("link")->get("state")->text == "detached", "source evidence distinguishes synthetic from unattached real seams");
    check(e.get("assets")->items.size() == 2, "registered zero-hit assets and served codecs are retained");
    check(text.find("event:/") == std::string::npos && text.find("key_id") == std::string::npos,
        "audio evidence does not disclose cue keys");
  }
  {
    auto &source = a::godot_slab(); source.arm();
    a::SampleState sample; sample.key = 123; sample.ready = true;
    source.sample(sample, 1);
    a::VoiceState voice; voice.key = 456; source.start(voice, sample.key, 2);
    source.volumes(voice.key, {0, 1, 2, 3, 4, 5}, {}, 6, 3);
    source.drop(sample.key, 4);
    Fake t; auto config = cfg; config.godot_sample = true;
    a::Hub h(config, t); h.sender().add(1); h.opened(1); h.sender().frame();
    check(t.texts.size() == 3 && t.texts[0].find("\"voice\":1") != std::string::npos &&
          t.texts[1].find("\"type\":\"sample\"") != std::string::npos &&
          t.texts[2].find("\"bus\":5") != std::string::npos, "Hub joins restore retained sample and every route");
    h.sender().add(2); h.opened(2); h.sender().frame();
    const auto before_stop = t.texts.size();
    source.stop(voice.key, 5); h.sender().frame();
    for (unsigned conn : {1u, 2u}) {
      std::vector<std::string> types;
      for (size_t i = before_stop; i < t.texts.size(); ++i) if (t.text_conns[i] == conn) {
        j::JValue message;
        if (j::Reader(t.texts[i]).parse(&message) && message.get("type")) types.push_back(message.get("type")->text);
      }
      check(types == std::vector<std::string>({"stop", "sample-drop"}), "every client joining after unregister gets stop followed by deferred sample-drop");
    }
    source.bus("count", 0, 33, 0, false, 6); h.sender().frame();
    const auto closed = h.sender().take_closes();
    check(closed.size() == 2 && closed[0].reason == "audio-overflow" && closed[1].reason == "audio-overflow",
          "bus overflow resync closes every open audio connection");
    h.removed(1); h.removed(2); const auto before = t.texts.size();
    h.sender().add(3); h.opened(3); h.sender().frame();
    check(t.texts.size() > before && t.texts[before].find("\"godot\":null") != std::string::npos, "reconnect after bus overflow contains null Godot source");
  }
  std::printf("rs_audio_test: %d checks, %d failures\n", checks, failures);
  return failures ? 1 : 0;
}
