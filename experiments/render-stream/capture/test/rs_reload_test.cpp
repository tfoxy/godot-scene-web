#include "rs_reload.h"

#include <cstdio>
#include <limits>
#include <string>
#include <vector>

#include "rs_json_lite.h"
#include "rs_texture_payload.h"

namespace {
int checks = 0, failures = 0;
void expect(bool ok, int line) {
  ++checks;
  if (!ok) {
    std::fprintf(stderr, "FAIL rs_reload_test.cpp:%d\n", line);
    ++failures;
  }
}
#define EXPECT(ok) expect((ok), __LINE__)

using namespace grc::rs;
using json_lite::JValue;
JValue json(const std::string &text) {
  JValue value;
  EXPECT(json_lite::Reader(text).parse(&value));
  return value;
}
const JValue &field(const JValue &value, const char *name) {
  static const JValue missing;
  const auto *found = value.get(name);
  EXPECT(found != nullptr);
  return found ? *found : missing;
}
std::vector<std::uint8_t> body(const std::string &meta,
                               std::vector<std::uint8_t> data = {1, 2, 3, 4}) {
  std::vector<std::uint8_t> out;
  payload_header(meta, data.size(), &out);
  out.insert(out.end(), data.begin(), data.end());
  return out;
}
void rules() {
  EXPECT(!reload_path_valid(""));
  EXPECT(!reload_path_valid("res://scene.tscn::Texture_1"));
  EXPECT(!reload_path_valid("::"));
  for (const char *p : {"res://a.png", "user://a.ctex", "/tmp/a.ctex", "relative.ctex"})
    EXPECT(reload_path_valid(p));
  const Shape placeholder{1, 1, 0, false};
  RegistryTextureFacts record{64, 32, 17, false, true};
  EXPECT(evicted_signature(placeholder, record));
  for (const Shape other : {Shape{2, 1, 0, false}, Shape{1, 2, 0, false},
                            Shape{1, 1, 1, false}, Shape{1, 1, 0, true}})
    EXPECT(!evicted_signature(other, record));
  record.known = false;
  EXPECT(!evicted_signature(placeholder, record));
  record = {1, 1, 0, false, true};
  EXPECT(!evicted_signature(placeholder, record));
  record.mipmaps = true;
  EXPECT(evicted_signature(placeholder, record));
  record = {1, 1, 17, false, true};
  EXPECT(evicted_signature(placeholder, record));
  const Shape expected{64, 32, 17, true};
  EXPECT(reload_verify(expected, expected, true));
  EXPECT(reload_verify({64, 32, 5, false}, expected, false, false));
  EXPECT(!reload_verify({63, 32, 5, false}, expected, false, false));
  EXPECT(!reload_verify({64, 31, 5, false}, expected, false, false));
  EXPECT(reload_verify({64, 32, 17, false}, expected, false));
  EXPECT(!reload_verify({64, 32, 17, false}, expected, true));
  for (const Shape other : {Shape{63, 32, 17, true}, Shape{64, 31, 17, true},
                            Shape{64, 32, 19, true}}) {
    EXPECT(!reload_verify(other, expected, true));
    EXPECT(!reload_verify(other, expected, false));
  }
  const ReloadRefusal codes[] = {ReloadRefusal::UnsafeEdited, ReloadRefusal::NoPath,
      ReloadRefusal::Mismatch, ReloadRefusal::Failed, ReloadRefusal::EvictedUnverifiable,
      ReloadRefusal::EvictedMidArm};
  const char *names[] = {"reload-unsafe", "released-no-path", "reload-mismatch", "reload-failed",
                         "evicted-unverifiable", "evicted-mid-arm"};
  for (int i = 0; i < 6; ++i) EXPECT(std::string(reload_refusal_name(codes[i])) == names[i]);
  EXPECT(std::string(reload_cause_name(ReloadCause::Released)) == "released");
  EXPECT(std::string(reload_cause_name(ReloadCause::Evicted)) == "evicted");
  EXPECT(std::string(reload_cause_name(ReloadCause::Residual)) == "residual");
  EXPECT(vram_data_bytes(17, 64, 64, false) == 2048);
  EXPECT(vram_data_bytes(19, 64, 64, false) == 4096);
  EXPECT(vram_data_bytes(17, 1, 1, false) == 8);
  EXPECT(vram_data_bytes(17, 5, 3, true) == 32);
  EXPECT(vram_data_bytes(37, 9, 9, false) == 64);
  EXPECT(vram_data_bytes(35, 4, 4, true) == 48);
  for (int format : {-1, 0, 23, 24, 33, 34, 36, 38, 39})
    EXPECT(vram_data_bytes(format, 64, 64, false) == -1);
  EXPECT(vram_data_bytes(17, 0, 64, false) == -1);
  EXPECT(vram_data_bytes(17, 64, -1, true) == -1);
}
void payloads() {
  const std::vector<std::uint8_t> data{9, 8, 7, 6};
  auto bytes = encode_payload(0, 2, 2, false, data.data(), data.size());
  Grt1View view;
  EXPECT(parse_grt1(bytes.data(), bytes.size(), &view));
  EXPECT(view.shape.width == 2 && view.shape.height == 2 && view.shape.format == 0);
  EXPECT(!view.shape.mipmaps && view.data_bytes == 4 && view.data_length == 4);
  EXPECT(view.data_offset + view.data_length == bytes.size());
  EXPECT(std::vector<std::uint8_t>(bytes.begin() + view.data_offset, bytes.end()) == data);
  EXPECT(!parse_grt1(nullptr, bytes.size(), &view));
  EXPECT(!parse_grt1(bytes.data(), bytes.size(), nullptr));
  for (std::size_t n = 0; n < bytes.size(); ++n) EXPECT(!parse_grt1(bytes.data(), n, &view));
  for (std::size_t i = 0; i < 8; ++i) {
    auto bad = bytes;
    bad[i] ^= 1;
    EXPECT(!parse_grt1(bad.data(), bad.size(), &view));
  }
  auto bad = bytes;
  for (int i = 8; i < 12; ++i) bad[i] = 255;
  EXPECT(!parse_grt1(bad.data(), bad.size(), &view));
  bad = bytes;
  bad.push_back(0);
  EXPECT(!parse_grt1(bad.data(), bad.size(), &view));
  EXPECT(parse_grt1(bytes.data(), bytes.size(), &view));
  bad = bytes;
  bad[view.data_offset - 4] = 3;
  EXPECT(!parse_grt1(bad.data(), bad.size(), &view));
  const auto meta = payload_meta("L8", 2, 2, false, 4);
  for (const auto &replacement : std::vector<std::pair<std::string, std::string>>{
      {"texture-2d", "mesh"}, {"L8", "unknown"}, {"\"width\":2", "\"width\":0"},
      {"\"height\":2", "\"height\":-1"}, {"\"width\":2", "\"width\":2.5"},
      {"\"height\":2", "\"height\":9223372036854775808"},
      {"\"width\":2", "\"width\":\"2\""}, {"false", "0"},
      {"\"data_bytes\":4", "\"data_bytes\":3"},
      {"\"data_bytes\":4", "\"data_bytes\":-1"},
      {"\"data_bytes\":4", "\"data_bytes\":4e0"},
      {"\"format\":\"L8\",", ""},
      {"\"width\":2", "\"width\":2,\"width\":2"}}) {
    std::string changed = meta;
    const auto at = changed.find(replacement.first);
    EXPECT(at != std::string::npos);
    changed.replace(at, replacement.first.size(), replacement.second);
    const auto malformed = body(changed);
    view.data_length = 999;
    EXPECT(!parse_grt1(malformed.data(), malformed.size(), &view));
    EXPECT(view.data_length == 0);
  }
  for (const char *invalid : {"{}", "[]", "null", "{", "{\"width\":2,}"}) {
    const auto malformed = body(invalid);
    EXPECT(!parse_grt1(malformed.data(), malformed.size(), &view));
  }
  for (int format = 0; format < kImageFormatCount; ++format) {
    const auto encoded = encode_payload(format, 8, 4, true, data.data(), data.size());
    EXPECT(parse_grt1(encoded.data(), encoded.size(), &view));
    EXPECT(view.shape.format == format && view.shape.mipmaps);
  }
}
void evidence() {
  ReloadStats s;
  auto empty = json(reload_json(s, {}, 0));
  EXPECT(field(empty, "schema").text == "render-stream-reload/1");
  EXPECT(!field(empty, "final").b);
  EXPECT(field(empty, "skipped").kind == JValue::Null);
  EXPECT(field(empty, "entries").items.empty());
  EXPECT(field(field(empty, "candidates"), "residual_formats").fields.empty());
  EXPECT(!empty.get("sources_balanced"));
  s.final = true;
  s.sources_balanced = true;
  s.arm_index = 2;
  s.frame = 43;
  s.fault = "reload-skip-verify";
  s.skipped = "fault-reload-off";
  s.scanned = {13, 20};
  s.candidates = {6, 7, 1, {{"DXT1", 1}}};
  s.reloaded = 13;
  s.verify_skipped = 3;
  s.adopted_from_reload = 11;
  s.dropped_unreferenced = 1;
  s.dropped_freed = 1;
  s.held_bytes = 123456;
  s.refused = {1, 2, 3, 4, 5, 6};
  s.temp_outlived = 7;
  s.scope_anomalies = 8;
  s.reload_us = 9;
  s.census_us = 10;
  ReloadEntry success;
  success.rid = std::numeric_limits<std::uint64_t>::max();
  success.cause = ReloadCause::Evicted;
  success.path = "res://quote\"\\\n.ctex";
  success.record = {64, 32, 17, true};
  success.loaded = success.record;
  success.adopted = true;
  ReloadEntry refused;
  refused.cause = ReloadCause::Residual;
  refused.code = ReloadRefusal::Mismatch;
  refused.why = "shape";
  auto doc = json(reload_json(s, {success, refused}, 5));
  EXPECT(field(doc, "final").b);
  EXPECT(field(doc, "sources_balanced").b);
  for (const auto &v : std::vector<std::pair<const char *, const char *>>{
      {"arm_index", "2"}, {"frame", "43"}, {"reloaded", "13"}, {"verify_skipped", "3"},
      {"adopted_from_reload", "11"}, {"dropped_unreferenced", "1"}, {"dropped_freed", "1"}, {"held_bytes", "123456"},
      {"released_no_path", "2"}, {"temp_outlived", "7"}, {"scope_anomalies", "8"},
      {"reload_us", "9"}, {"census_us", "10"}, {"entries_dropped", "5"}})
    EXPECT(field(doc, v.first).text == v.second);
  EXPECT(field(doc, "fault").text == s.fault && field(doc, "skipped").text == s.skipped);
  EXPECT(field(field(doc, "scanned"), "registered_vram").text == "13");
  EXPECT(field(field(doc, "scanned"), "census_compressed").text == "20");
  const auto &c = field(doc, "candidates");
  EXPECT(field(c, "released").text == "6" && field(c, "evicted").text == "7");
  EXPECT(field(c, "residual").text == "1" && field(c, "total").text == "14");
  const auto &r = field(doc, "refused");
  int i = 1;
  for (const char *key : {"reload_unsafe", "released_no_path", "reload_mismatch", "reload_failed",
                          "evicted_unverifiable", "evicted_mid_arm"})
    EXPECT(field(r, key).text == std::to_string(i++));
  EXPECT(field(r, "total").text == "21");
  EXPECT(field(field(field(doc, "candidates"), "residual_formats"), "DXT1").text == "1");
  const auto &entries = field(doc, "entries").items;
  EXPECT(entries.size() == 2);
  if (entries.size() == 2) {
    EXPECT(field(entries[0], "rid").kind == JValue::String);
    EXPECT(field(entries[0], "rid").text == "18446744073709551615");
    EXPECT(field(entries[0], "cause").text == "evicted");
    EXPECT(field(entries[0], "outcome").text == "reloaded");
    EXPECT(field(entries[0], "path").text == success.path);
    EXPECT(field(entries[0], "code").kind == JValue::Null);
    EXPECT(field(entries[0], "why").kind == JValue::Null);
    EXPECT(field(entries[0], "adopted").b);
    for (const char *key : {"record", "loaded"}) {
      const auto &shape = field(entries[0], key);
      EXPECT(field(shape, "format").text == "DXT1");
      EXPECT(field(shape, "width").text == "64" && field(shape, "height").text == "32");
      EXPECT(field(shape, "mipmaps").b);
    }
    EXPECT(field(entries[1], "cause").text == "residual");
    EXPECT(field(entries[1], "outcome").text == "refused");
    EXPECT(field(entries[1], "code").text == "reload-mismatch");
    EXPECT(field(entries[1], "why").text == "shape");
    EXPECT(field(entries[1], "path").kind == JValue::Null);
    EXPECT(field(entries[1], "loaded").kind == JValue::Null);
    EXPECT(!field(entries[1], "adopted").b);
  }
  s.sources_balanced = false;
  EXPECT(!field(json(reload_json(s, {}, 0)), "sources_balanced").b);
  doc = json(reload_json(s, std::vector<ReloadEntry>(4098), 5));
  EXPECT(field(doc, "entries").items.size() == 4096);
  EXPECT(field(doc, "entries_dropped").text == "7");
  const auto restore = json(htr_restore_json({1, 2, 3, 4, 5, 6, 7, "not-dummy-host"}));
  i = 1;
  for (const char *key : {"candidates", "restored", "unavailable", "mismatch", "not_placeholder",
                          "skipped_fault", "skipped_shutdown"})
    EXPECT(field(restore, key).text == std::to_string(i++));
  EXPECT(field(restore, "skipped").text == "not-dummy-host");
  EXPECT(field(json(htr_restore_json({})), "skipped").kind == JValue::Null);
}
}  // namespace

int main() {
  rules();
  payloads();
  evidence();
  std::printf("rs_reload_test: %d checks, %d failures\n", checks, failures);
  return failures ? 1 : 0;
}
