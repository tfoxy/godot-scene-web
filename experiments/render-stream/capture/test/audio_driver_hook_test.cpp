#include "audio_driver_probe.h"
#include "audio_driver_log.h"
#include "audio_driver_sample.h"
#include "iface.h"
#include "report.h"
#include "rs_audio_slab.h"
#include "rs_json_lite.h"
#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <iterator>

namespace {
int passed = 0, failed = 0, starts = 0;
std::string version, driver = "Dummy";
bool has_tree = true, fingerprint_ok = true;
void check(bool ok, const char *name) {
  if (ok) ++passed; else { ++failed; std::fprintf(stderr, "FAIL: %s\n", name); }
}
void tree_call(GDExtensionMethodBindPtr, GDExtensionObjectPtr,
               const GDExtensionConstTypePtr *, GDExtensionTypePtr result) {
  *static_cast<void **>(result) = has_tree ? reinterpret_cast<void *>(1) : nullptr;
}
}
// Only engine-facing operations are stubbed; initialize, ABI parsing and JSON writing are real.
namespace grc {
Iface g_iface;
void *singleton_object(const char *) { return reinterpret_cast<void *>(1); }
GDExtensionMethodBindPtr method_bind(const char *, const char *, int64_t) {
  return reinterpret_cast<void *>(1);
}
std::string singleton_string(const char *, const char *, const char *, int64_t) { return driver; }
bool collect_fingerprint(ProcessFingerprint *fp, std::string *error) {
  if (!fingerprint_ok) { *error = "test fingerprint unavailable"; return false; }
  fp->version_string = version; return true;
}
namespace audio {
void sample_bench_configure() {}
bool start_sample(const Probe &, const Abi &, std::string *) { ++starts; return true; }
bool start_log(const Probe &, const Abi &, const std::string &, std::string *) { ++starts; return true; }
void stop_sample() {}
void stop_log() {}
AudioSlab &godot_slab() { static AudioSlab slab; return slab; }
void AudioSlab::refuse(const char *reason) { available_ = false; state_ = reason; }
}
}
int main(int argc, char **argv) {
  if (argc != 2) return 2;
  const std::string dir = argv[1], abi = grc::path_join(dir, "invalid-abi.json");
  if (!grc::make_directories(dir) || !grc::write_file(abi, "{}")) return 2;
  for (const char *name : {"GRC_LIVE_AUDIO_GODOT", "GRC_LIVE_AUDIO_QUEUE_BYTES",
       "GRC_LIVE_AUDIO_LANE_LATE_MS", "GRC_LIVE_AUDIO_STALL_MS",
       "GRC_LIVE_AUDIO_STORE_MAX_MS", "GRC_LIVE_AUDIO_NO_STORE_BUSES"}) unsetenv(name);
  setenv("GRC_LIVE_TRACKS", "audio", 1);
  setenv("GRC_AUDIO_ABI_TABLE", abi.c_str(), 1);
  grc::g_iface.object_method_bind_ptrcall = tree_call;
  const auto run = [&](const char *engine, const char *mode, const char *path,
                       const std::string &reason, const char *slab) {
    version = engine;
    if (mode) setenv("GRC_AUDIO", mode, 1); else unsetenv("GRC_AUDIO");
    grc::audio::initialize(dir);
    std::ifstream f(grc::path_join(dir, "audio-probe.json"));
    std::string text((std::istreambuf_iterator<char>(f)), {});
    grc::rs::json_lite::JValue report;
    check(grc::rs::json_lite::Reader(text).parse(&report), "probe JSON parses");
    const auto field = [&](const char *key, const std::string &expected) {
      const auto *value = report.get(key);
      check(value && value->kind == grc::rs::json_lite::JValue::String && value->text == expected, key);
    };
    field("mode", mode ? mode : "sample");
    field("status", "refused");
    field("engine_version", fingerprint_ok && has_tree && driver == "Dummy" ? engine : "");
    field("engine_path", path);
    field("reason", reason);
    check(grc::audio::godot_slab().state() == std::string(slab), "typed slab refusal");
    check(starts == 0, "no hooks start after a refusal");
  };
  run("Godot Engine v4.5.1.stable.official", "sample", "official", "unsupported audio ABI fields", "unavailable:seam");
  run("MegaDot v4.5.1.m.14.mono.custom_build", "sample", "derived", "unsupported audio ABI fields", "unavailable:seam");
  run("MegaDot v4.5.1.m.12.mono.custom_build", nullptr, "derived", "unsupported audio ABI fields", "unavailable:seam");
  for (const char *engine : {"MegaDot v4.5.2.m.1.mono.custom_build", "Godot Engine v4.5.1.stable.custom_build", ""})
    run(engine, "sample", "", std::string("unsupported engine version: ") + engine, "unavailable:engine-unverified");
  driver = "PulseAudio";
  run("MegaDot v4.5.1.m.14.mono.custom_build", "sample", "", "active audio driver is not Dummy: PulseAudio", "unavailable:not-dummy");
  driver = "Dummy"; fingerprint_ok = false;
  run("MegaDot v4.5.1.m.14.mono.custom_build", "sample", "", "test fingerprint unavailable", "unavailable:seam");
  fingerprint_ok = true; has_tree = false;
  run("MegaDot v4.5.1.m.14.mono.custom_build", "sample", "", "no-stop-entry", "unavailable:no-stop-entry");
  std::printf("audio_driver_hook: %d passed, %d failed\n", passed, failed);
  return failed ? 1 : 0;
}
