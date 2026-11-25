#include "rs_audio_assets.h"
#include "rs_audio_slab.h"
#include <cstdio>
#include <cstring>
#include <chrono>
using namespace grc::audio;
namespace {
int passed = 0, failed = 0;
void check(bool ok, const char *name) { if (ok) ++passed; else { ++failed; std::printf("FAIL: %s\n", name); } }
struct Sink : GodotSink {
  std::vector<std::string> messages;
  void godot_text(const std::string &s) override { messages.push_back(s); }
  void godot_overflow() override {}
};
struct Supplier : VariantSupplier {
  Assets assets;
  std::vector<uint32_t> releases;
  void request(uint32_t, uint64_t) override {}
  void released(uint32_t id) override { releases.push_back(id); assets.release(id, 100); }
  void no_store(uint32_t id) override { assets.no_store(id); }
};
struct View : grc::live::ResourceSource {
  using Payload = Assets::Payload;
  Payload lookup(std::string_view) override { return body; }
  Payload body = std::make_shared<const grc::rs::PageBytes>(grc::rs::PageBytes{1, 2, 3});
};
}
int main() {
  const Bytes frame{0xff, 0xf3, 0x80, 0x00};  // MPEG-2 Layer III, 22050 Hz, stereo.
  auto format = mp3_format(frame);
  check(format.rate == 22050 && format.channels == 2, "untagged MP3 native rate and channels");
  // ID3v2.3 PRIV frame, 128-byte payload containing a valid but unrelated MP3 sync.
  Bytes tagged{'I', 'D', '3', 3, 0, 0, 0, 0, 1, 10,
               'P', 'R', 'I', 'V', 0, 0, 0, 128, 0, 0, 0xff, 0xfb, 0x90, 0xc0};
  tagged.resize(10 + 138);
  tagged.insert(tagged.end(), frame.begin(), frame.end());
  format = mp3_format(tagged);
  check(format.rate == 22050 && format.channels == 2, "ID3 PRIV false sync cannot override MP3 native format");
  Bytes footer{'I', 'D', '3', 4, 0, 0x10, 0, 0, 0, 0,
               '3', 'D', 'I', 4, 0, 0, 0xff, 0xfb, 0x90, 0xc0};
  footer.insert(footer.end(), frame.begin(), frame.end());
  format = mp3_format(footer);
  check(format.rate == 22050 && format.channels == 2, "ID3 footer is skipped before MP3 scan");
  tagged.resize(24);
  check(mp3_format(tagged).rate == 0, "truncated ID3 tag does not expose false sync");
  auto pcm = pcm16_wav({-1, 0, 1, .5f}, 22050, 2);
  check(pcm.size() == 52 && std::memcmp(pcm.data(), "RIFF", 4) == 0, "PCM16 RIFF size");
  check(pcm[22] == 2 && pcm[24] == 0x22 && pcm[25] == 0x56, "native stereo rate");
  check(pcm[44] == 0 && pcm[45] == 128 && pcm[48] == 255 && pcm[49] == 127, "PCM16 saturates at endpoints");
  check(pcm16_wav({}, 0, 1).empty() && pcm16_wav({1}, 44100, 2).empty(), "invalid PCM refused");
  auto ogg = remux_ogg({{0, {Bytes(255, 1)}}, {123456789, {{2, 3}}}});
  check(ogg.size() == 27 + 2 + 255 + 27 + 1 + 2, "Ogg packet multiple-of-255 gets terminator");
  check(ogg[5] == 2 && ogg[26] == 2 && ogg[27] == 255 && ogg[28] == 0, "Ogg BOS and packet lacing");
  size_t second = 284;
  check(ogg[second + 5] == 4 && ogg[second + 6] == 21 && ogg[second + 7] == 205, "Ogg EOS and stored granule");
  check(ogg == remux_ogg({{0, {Bytes(255, 1)}}, {123456789, {{2, 3}}}}), "fixed Ogg serial and deterministic CRC");
  uint32_t crc = 0;
  for (size_t i = 0; i < second; ++i) {
    crc ^= uint32_t(i >= 22 && i < 26 ? 0 : ogg[i]) << 24;
    for (int b = 0; b < 8; ++b) crc = (crc << 1) ^ ((crc & 0x80000000u) ? 0x04c11db7u : 0);
  }
  uint32_t stored = 0; for (unsigned b = 0; b < 4; ++b) stored |= uint32_t(ogg[22 + b]) << (8 * b);
  check(crc == stored, "Ogg page CRC verified independently");
  check(remux_ogg({{0, {Bytes(255 * 255, 0)}}}).empty(), "oversized stored page requests WAV fallback");
  Assets assets;
  auto hash = assets.put(1, pcm, "wav", true, 100);
  check(hash == grc::sha256_hex(pcm.data(), pcm.size()), "asset identity is SHA-256 of served bytes");
  check(assets.get(hash, 100).store, "short one-shot is immutable");
  assets.no_store(1); check(!assets.get(hash, 101).store, "bus restriction changes HTTP class before start");
  assets.put(2, pcm, "wav", true, 102); assets.release(1, 103);
  check(assets.get(hash, 50000000).bytes != nullptr, "another registration or voice pins shared hash");
  assets.release(2, 50000000);
  check(assets.get(hash, 79999999).bytes != nullptr, "retired asset retained for 30 seconds");
  check(!assets.get(hash, 80000000).bytes, "retired asset expires at 30 seconds");
  AudioSlab slab; slab.arm(); Sink sink; slab.attach(&sink); slab.connected(true);
  SampleState sample; sample.key = 1; sample.ready = true; sample.length_s = 11;
  slab.sample(sample, 1);
  check(sink.messages.back().find("\"store\":false") != std::string::npos, "samples longer than 10000 ms must be no-store");
  sample.key = 2; sample.length_s = 1; sample.loop = 3; slab.sample(sample, 1);
  check(sink.messages.back().find("\"store\":false") != std::string::npos, "any loop mode is no-store");
  sample.key = 3; sample.loop = 0; slab.configure_store(1000); sample.length_s = 1.001; slab.sample(sample, 1);
  check(sink.messages.back().find("\"store\":false") != std::string::npos, "configured duration limit applies");
  sample.key = 4; sample.length_s = 1; slab.sample(sample, 2);
  slab.restrict_sample(4, 3); VoiceState voice; voice.key = 1; slab.start(voice, 4, 3);
  check(sink.messages[sink.messages.size() - 2].find("\"store\":false") != std::string::npos && sink.messages.back().find("\"type\":\"start\"") != std::string::npos, "bus policy re-announces sample before start");
  slab.drop(4, 4);
  check(slab.wanted(4) && !slab.storable(4), "unregistered voice retains no-store class");
  slab.stop(1, 5); check(!slab.wanted(4), "last voice releases unregistered asset");
  // A sample slot can disappear while multiple voices still use the same bytes.
  // Publication, snapshots and the resource owner must survive until the last stop.
  Supplier supplier;
  AudioSlab retained; retained.arm(); retained.supplier(&supplier);
  sample = {}; sample.key = 10; sample.length_s = 1;
  const auto id = retained.sample(sample, 1);
  auto retained_hash = supplier.assets.put(id, pcm, "wav", true, 1);
  voice = {}; voice.key = 10; retained.start(voice, 10, 2);
  voice.key = 11; retained.start(voice, 10, 3);
  retained.drop(10, 4);
  check(supplier.releases.empty() && retained.wanted(id), "unregister with two voices keeps resource owner");
  retained.variant(id, retained_hash.c_str(), pcm.size(), 5);
  check(retained.samples(6).size() == 1, "late worker completion publishes unregistered in-use sample once");
  check(retained.snapshot(6).find("\"sample\":" + std::to_string(id)) != std::string::npos,
        "mid-scene snapshot retains voice after unregister");
  retained.stop(10, 7);
  check(supplier.releases.empty() && supplier.assets.get(retained_hash, 50000000).bytes,
        "first voice end does not release shared asset");
  retained.stop(11, 8);
  retained.stop(11, 9);
  check(supplier.releases == std::vector<uint32_t>{id}, "last voice releases asset once");
  check(supplier.assets.get(retained_hash, 30000099).bytes != nullptr,
        "last voice stop begins full 30-second grace");
  supplier.assets.sweep(30000100);
  check(!supplier.assets.get(retained_hash, 30000100).bytes, "sweep expires released voice asset");
  retained.variant(id, retained_hash.c_str(), pcm.size(), 10);
  check(retained.samples(10).empty(), "completion after last owner cannot resurrect a dropped sample");
  sample.ready = true; sample.key = 11;
  auto registered_id = retained.sample(sample, 11);
  supplier.assets.put(registered_id, pcm, "wav", true, 11);
  voice.key = 12; retained.start(voice, 11, 12); retained.stop(12, 13);
  check(supplier.releases.size() == 1 && supplier.assets.get(retained_hash, 50000000).bytes,
        "registered sample remains served after all voices stop");
  retained.drop(11, 14);
  check(supplier.releases.size() == 2, "unregister without voices releases resource owner");
  sample.key = 12; sample.length_s = 10; slab.configure_store(10000); slab.sample(sample, 15);
  check(slab.storable(slab.sample_state(12)->id), "duration equal to maximum is storable");
  // The composed source serves audio hashes even without any view resources.
  View view; AudioResources resources(view);
  const auto now = uint64_t(std::chrono::duration_cast<std::chrono::microseconds>(
      std::chrono::steady_clock::now().time_since_epoch()).count());
  auto audio_hash = godot_assets().put(999, pcm, "wav", false, now);
  check(resources.lookup(audio_hash) != view.body && resources.no_store(audio_hash),
        "audio-only resource lookup retains no-store policy");
  const auto body = resources.lookup_body(audio_hash, grc::live::Coding::Gzip);
  const auto stored_bytes = godot_assets().get(audio_hash, now).bytes;
  check(resources.lookup(audio_hash) == stored_bytes && body.bytes == stored_bytes,
        "audio resource lookups share stored page-backed bytes without copying");
  check(body.bytes && *body.bytes == pcm && body.coding == grc::live::Coding::Identity && body.identity_bytes == pcm.size(),
        "audio asset serves original bytes despite accepted HTTP coding");
  grc::live::ResourceBody coded;
  check(resources.lookup_coded_body(audio_hash, grc::live::Coding::Gzip, &coded) && !coded.bytes && coded.identity_bytes == pcm.size(),
        "carrier coding probe falls back to audio identity bytes");
  check(resources.lookup_coded_body(audio_hash, grc::live::Coding::Identity, &coded) && coded.bytes == stored_bytes,
        "identity carrier lookup shares stored page-backed bytes without copying");
  check(resources.lookup("view") == view.body && !resources.no_store("view"),
        "view resource lookup and caching still delegated");
  godot_assets().release(999, now);
  std::printf("rs_audio_assets: %d passed, %d failed\n", passed, failed); return failed ? 1 : 0;
}
