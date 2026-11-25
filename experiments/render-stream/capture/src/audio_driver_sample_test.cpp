#include "audio_driver_sample_test.h"
#include "rs_audio_slab.h"
#include "rs_audio_assets.h"
#include "rs_json_lite.h"
#include "rs_audio_sender.h"
#include "rs_file.h"
#include "rs_sha256.h"
#include "iface.h"
#include <cstdio>
namespace grc::audio {
namespace {
class TestSource final : public VariantSupplier, public GodotSink {
 public:
  struct Variant { std::string hash; uint64_t bytes = 0; const char *codec = nullptr; };
  std::array<Variant, 3> variants;
  rs::File output;
  void request(uint32_t id, uint64_t key) override {
    std::string name;
    if (!call_string_getter(method_bind("Object", "get_class", 201670096), reinterpret_cast<void *>(key), &name)) return;
    size_t i = name == "AudioStreamMP3" ? 1 : name == "AudioStreamOggVorbis" ? 2 : 0;
    const auto &v = variants[i];
    if (!v.hash.empty()) godot_slab().variant(id, v.hash.c_str(), v.bytes, now_us(), v.codec);
  }
  void godot_text(const std::string &text) override {
    if (output) { std::fprintf(output.get(), "%s\n", text.c_str()); std::fflush(output.get()); }
    if (!rs::env("GRC_AUDIO_TEST_ASSETS")) return;
    rs::json_lite::JValue root;
    if (!rs::json_lite::Reader(text).parse(&root)) return;
    const auto save = [&](const auto &v) {
      const auto *hash = v.get("hash"); if (!hash) return;
      auto asset = godot_assets().get(hash->text, now_us()); if (!asset.bytes) return;
      rs::File file(rs::open_file((std::string(rs::env("GRC_EVIDENCE_DIR")) + "/" + hash->text).c_str(), "wb"));
      if (file) std::fwrite(asset.bytes->data(), 1, asset.bytes->size(), file.get());
    };
    if (auto *variants = root.get("variants")) for (const auto &v : variants->items) save(v);
    else save(root);
  }
  void godot_overflow() override { godot_text("{\"test-overflow\":true}"); }
};
TestSource test;
}
void sample_test_begin() {
  const char *directory = rs::env("GRC_AUDIO_TEST_VARIANT_DIR");
  const char *evidence = rs::env("GRC_EVIDENCE_DIR");
  if (!evidence || !*evidence) return;
  if (rs::env("GRC_AUDIO_TEST_ASSETS")) {
    test.output.reset(rs::open_file((std::string(evidence) + "/audio-messages.jsonl").c_str(), "wb"));
    auto &slab = godot_slab(); auto guard = slab.lock();
    slab.attach(&test); slab.connected(true); slab.prepare_variants(1);
    return;
  }
  if (!directory || !*directory) return;
  const char *files[] = {"tone.wav", "tone.mp3", "tone.ogg"};
  const char *codecs[] = {"wav", "mp3", "ogg-vorbis"};
  for (size_t i = 0; i < 3; ++i) {
    rs::File file(rs::open_file((std::string(directory) + "/" + files[i]).c_str(), "rb"));
    std::string bytes;
    if (!rs::file_read_all(file.get(), &bytes)) return;
    test.variants[i] = {sha256_hex(reinterpret_cast<const uint8_t *>(bytes.data()), bytes.size()), bytes.size(), codecs[i]};
  }
  test.output.reset(rs::open_file((std::string(evidence) + "/audio-messages.jsonl").c_str(), "wb"));
  if (!test.output) return;
  auto &source = godot_slab(); auto guard = source.lock();
  source.supplier(&test); source.attach(&test); source.connected(true);
}
void sample_test_end() {
  if (!test.output) return;
  auto &source = godot_slab(); auto guard = source.lock();
  source.connected(false); source.supplier(nullptr); source.attach(nullptr);
  test.output.reset();
}
}
