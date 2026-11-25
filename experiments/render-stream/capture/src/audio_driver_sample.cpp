#include "audio_driver_sample.h"
#include "audio_driver_assets.h"
#include "audio_driver_sample_test.h"
#include "iface.h"
#include "rs_audio_slab.h"
#include "rs_audio_sender.h"
#include "rs_audio_clock.h"
#include "rs_platform.h"
#include "rs_file.h"
#include "report.h"
#include <algorithm>
#if defined(__linux__) && defined(__x86_64__)
#include <unwind.h>
#endif
#include <chrono>
#include <cstdio>
#include "vtable.h"
#include <cstring>
#include <cmath>
#if defined(__linux__) && defined(__x86_64__)
namespace grc::audio {
namespace {
// Fingerprint-gated Godot 4.5.1 release ABI, checked on engine-created objects at arm.
constexpr size_t stream_member = 312, offset_member = 328, pitch_member = 332,
    volumes_member = 336, bus_member = 352;
ShadowVtable shadow;
void *original[38]{};
VoiceClock playback_clock;
constexpr unsigned frame_voices = 1, frame_probe = 2, frame_bench = 4;
std::atomic<unsigned> frame_work{0};
thread_local bool probing = false;
bool probe_waiting = false, stop_validated = false, sabotage_no_end = false;
uintptr_t native_stop_entry = 0, observed_entry = 0;
thread_local uint64_t ending_key = 0, last_started_key = 0;
void *probe_player = nullptr, *probe_ref = nullptr;
int probe_finished = 0;
alignas(8) unsigned char probe_callable[16]{};
bool probe_callable_made = false;
struct Trace { uintptr_t caller, region = 0; };
_Unwind_Reason_Code trace_stop(_Unwind_Context *context, void *data) {
  auto &t = *static_cast<Trace *>(data);
  if (_Unwind_GetIP(context) == t.caller) t.region = _Unwind_GetRegionStart(context);
  return _URC_NO_REASON;
}
GDExtensionMethodBindPtr length_bind, index_bind, name_bind;
void *server = nullptr, *driver_object = nullptr;
GDExtensionInterfaceStringOperatorIndexConst string_index = nullptr;
template<class T> T member(const void *p, ptrdiff_t offset = 0) {
  T result{}; std::memcpy(&result, static_cast<const char *>(p) + offset, sizeof(T)); return result;
}
void *object(const void *ref) { return member<void *>(ref); }
uint64_t key(const void *ref) { return reinterpret_cast<uint64_t>(object(ref)); }
void *stream(const void *ref) { return member<void *>(object(ref), stream_member); }
int bus_index(const void *name) {
  int64_t index = -1; const void *args[] = {name};
  g_iface.object_method_bind_ptrcall(index_bind, server, args, &index); return int(index);
}
void bus_name(int index) {
  if (index < 0 || index >= int(kAudioBuses)) return;
  void *raw = nullptr; int64_t bus = index; const void *args[] = {&bus};
  g_iface.object_method_bind_ptrcall(name_bind, server, args, &raw);
  char utf8[kAudioNameBytes + 4]{}; size_t used = 0;
  for (int64_t i = 0; used < kAudioNameBytes; ++i) {
    const char32_t *at = string_index(&raw, i); if (!at || !*at) break;
    uint32_t c = *at;
    if (c < 0x80) utf8[used++] = char(c);
    else if (c < 0x800) { utf8[used++] = char(0xc0 | (c >> 6)); utf8[used++] = char(0x80 | (c & 63)); }
    else if (c < 0x10000) {
      utf8[used++] = char(0xe0 | (c >> 12)); utf8[used++] = char(0x80 | ((c >> 6) & 63)); utf8[used++] = char(0x80 | (c & 63));
    } else {
      utf8[used++] = char(0xf0 | (c >> 18)); utf8[used++] = char(0x80 | ((c >> 12) & 63));
      utf8[used++] = char(0x80 | ((c >> 6) & 63)); utf8[used++] = char(0x80 | (c & 63));
    }
  }
  godot_slab().name(index, std::string_view(utf8, used));
  g_iface.variant_get_ptr_destructor(GDEXTENSION_VARIANT_TYPE_STRING)(&raw);
}
Volumes volumes_at(const void *vector) {
  auto *data = member<const float *>(vector, 8); Volumes result{};
  if (!data) return result;
  const auto size = member<uint64_t>(data, -8);
  if (size > 4) return result;
  for (size_t i = 0; i < size * 2; ++i) result[i] = data[i];
  return result;
}
bool registered(void *, const void *ref) { return !probing && godot_slab().registered(key(ref)); }
void registration(void *, const void *ref) {
  if (probing) return;
  const auto *obj = object(ref); SampleState sample;
  sample.key = reinterpret_cast<uint64_t>(stream(ref));
  sample.channels = member<int32_t>(obj, 336); sample.rate = member<int32_t>(obj, 340);
  sample.loop = member<int32_t>(obj, 344); sample.begin = member<int32_t>(obj, 348); sample.end = member<int32_t>(obj, 352);
  g_iface.object_method_bind_ptrcall(length_bind, stream(ref), nullptr, &sample.length_s);
  if (!std::isfinite(sample.length_s) || sample.length_s < 0 || sample.loop < 0 || sample.loop > 3) return;
  auto &slab = godot_slab(); auto guard = slab.lock();
  auto id = slab.sample(sample, now_us());
  sample_assets_registered(id, sample.key);
  if (id) slab.prepare_variants();
}
void unregistration(void *, const void *ref) { if (probing) return; godot_slab().drop(reinterpret_cast<uint64_t>(stream(ref)), now_us()); }
void start(void *, const void *ref) {
  if (probing) { g_iface.ref_set_object(&probe_ref, object(ref)); return; }
  const auto *obj = object(ref); VoiceState voice; voice.key = key(ref); last_started_key = voice.key;
  voice.offset_s = member<float>(obj, offset_member); voice.pitch = member<float>(obj, pitch_member);
  voice.volumes = volumes_at(static_cast<const char *>(obj) + volumes_member);
  voice.bus = bus_index(static_cast<const char *>(obj) + bus_member);
  auto &slab = godot_slab(); auto guard = slab.lock(); const auto t = now_us();
  if (sample_bus_restricted(static_cast<const char *>(obj) + bus_member))
    slab.restrict_sample(reinterpret_cast<uint64_t>(stream(ref)), t);
  if (slab.start(voice, reinterpret_cast<uint64_t>(stream(ref)), t)) {
    const auto *v = slab.voice(voice.key);
    void *retained = nullptr; g_iface.ref_set_object(&retained, object(ref));
    if (!playback_clock.start(voice.key, v->asset.length_s, voice.offset_s, voice.pitch, v->asset.loop != 0, t, retained))
      g_iface.ref_set_object(&retained, nullptr);
    else frame_work.fetch_or(frame_voices, std::memory_order_relaxed);
  }
}
__attribute__((noinline)) void stop(void *, const void *ref) {
  if (probing) {
    Trace t{uintptr_t(__builtin_return_address(0))}; _Unwind_Backtrace(trace_stop, &t);
    observed_entry = t.region; return;
  }
  if (key(ref) == ending_key) return;
  auto &slab = godot_slab(); auto guard = slab.lock();
  auto ended = playback_clock.remove(key(ref));
  if (!playback_clock.any()) frame_work.fetch_and(~frame_voices, std::memory_order_relaxed);
  slab.stop(key(ref), now_us());
  if (ended.retained) g_iface.ref_set_object(&ended.retained, nullptr);
}
void pause(void *, const void *ref, bool value) {
  if (probing) return;
  auto &slab = godot_slab(); auto guard = slab.lock(); const auto t = now_us();
  playback_clock.pause(key(ref), value, t); slab.pause(key(ref), value, t);
}
bool active(void *, const void *ref) {
  auto guard = godot_slab().lock();
  return probing ? probe_ref != nullptr : playback_clock.find(key(ref)) != nullptr;
}
double position(void *, const void *ref) {
  auto guard = godot_slab().lock(); return playback_clock.position(key(ref), now_us());
}
void pitch(void *, const void *ref, float value) {
  if (probing) return;
  auto &slab = godot_slab(); auto guard = slab.lock(); const auto t = now_us();
  playback_clock.pitch(key(ref), value, t); slab.pitch(key(ref), value, t);
}
void volumes(void *, const void *ref, const void *map) {
  if (probing) return;
  auto head = member<const char *>(map, 16); auto count = member<uint32_t>(map, 36);
  if (count > 6) return;
  std::array<int, 6> buses{}; std::array<Volumes, 6> values{};
  for (size_t i = 0; i < count; ++i) {
    if (!head) return;
    buses[i] = bus_index(head + 16); values[i] = volumes_at(head + 24); head = member<const char *>(head);
  }
  godot_slab().volumes(key(ref), buses, values, count, now_us());
}
void count(void *, int value) {
  godot_slab().bus("count", 0, value, 0, false, now_us());
  for (int i = 0; i < value && i < int(kAudioBuses); ++i) bus_name(i);
}
void add(void *, int index) { godot_slab().bus("add", index, 0, 0, false, now_us()); }
void remove(void *, int index) { godot_slab().bus("remove", index, 0, 0, false, now_us()); }
void move(void *, int index, int value) { godot_slab().bus("move", index, value, 0, false, now_us()); }
void send(void *, int index, const void *name) {
  bus_name(index); godot_slab().bus("send", index, bus_index(name), 0, false, now_us());
}
void volume(void *, int index, float value) { godot_slab().bus("volume_db", index, 0, value, false, now_us()); }
void solo(void *, int index, bool value) { godot_slab().bus("solo", index, 0, 0, value, now_us()); }
void mute(void *, int index, bool value) { godot_slab().bus("mute", index, 0, 0, value, now_us()); }
void ptr(const char *cls, const char *method, int64_t hash, void *obj,
         const void *const *args = nullptr, void *result = nullptr) {
  auto bind = method_bind(cls, method, hash);
  if (bind) g_iface.object_method_bind_ptrcall(bind, obj, args, result);
}
void native_end(void *ref) {
  auto table = static_cast<void *const *>(shadow.original_address_point());
  auto driver = driver_object;
  reinterpret_cast<void(*)(void *)>(table[7])(driver);
  reinterpret_cast<void(*)(void *, const void *)>(native_stop_entry)(server, ref);
  reinterpret_cast<void(*)(void *)>(table[8])(driver);
}
void probe_finished_call(void *, const GDExtensionConstVariantPtr *, GDExtensionInt,
                         GDExtensionVariantPtr result, GDExtensionCallError *error) {
  ++probe_finished;
  auto nil = reinterpret_cast<GDExtensionInterfaceVariantNewNil>(g_iface.get_proc_address("variant_new_nil"));
  nil(result); error->error = GDEXTENSION_CALL_OK;
}
void *make_probe_player(void *parent, void *wav_ref) {
    StringName player_class("AudioStreamPlayer");
    void *player = g_iface.classdb_construct_object2(player_class.ptr());
    int64_t sample_type = 2, internal = 0; bool readable = false; double db = -80;
    const void *stream_args[] = {&wav_ref}, *type_args[] = {&sample_type}, *db_args[] = {&db};
    ptr("AudioStreamPlayer", "set_stream", 2210767741, player, stream_args);
    ptr("AudioStreamPlayer", "set_playback_type", 725473817, player, type_args);
    ptr("AudioStreamPlayer", "set_volume_db", 373806689, player, db_args);
    const void *child_args[] = {&player, &readable, &internal};
    ptr("Node", "add_child", 3863233950, parent, child_args);
    return player;
}

bool begin_stop_probe() {
  if (!g_iface.callable_custom_create2 || !g_iface.ref_set_object) return false;
  void *engine = singleton_object("Engine"), *tree = nullptr, *parent = nullptr;
  ptr("Engine", "get_main_loop", 1016888095, engine, nullptr, &tree);
  // Extension loading can precede SceneTree creation. Refuse cleanly and restore
  // the driver; no engine method is called through a missing tree. Cues remain usable.
  if (!tree) return false;
  ptr("SceneTree", "get_current_scene", 3160264692, tree, nullptr, &parent);
  if (!parent) ptr("SceneTree", "get_root", 1757182445, tree, nullptr, &parent);
  if (!parent) return false;
  StringName wav_class("AudioStreamWAV");
  void *wav = g_iface.classdb_construct_object2(wav_class.ptr()), *wav_ref = nullptr;
  g_iface.ref_set_object(&wav_ref, wav);
  // Engine-owned PackedByteArray, one hundred milliseconds of silent PCM8.
  alignas(8) unsigned char data[16]{};
  auto ctor = g_iface.variant_get_ptr_constructor(GDEXTENSION_VARIANT_TYPE_PACKED_BYTE_ARRAY, 0);
  auto resize = g_iface.variant_get_ptr_builtin_method(GDEXTENSION_VARIANT_TYPE_PACKED_BYTE_ARRAY,
      StringName("resize").ptr(), 848867239);
  auto index = reinterpret_cast<GDExtensionInterfacePackedByteArrayOperatorIndex>(g_iface.get_proc_address("packed_byte_array_operator_index"));
  if (!wav || !ctor || !resize || !index) { g_iface.ref_set_object(&wav_ref, nullptr); return false; }
  ctor(data, nullptr); int64_t size = 4410, ignored = 0; const void *size_args[] = {&size};
  resize(data, size_args, &ignored, 1); std::memset(index(data, 0), 0, size_t(size));
  const void *data_args[] = {data}; ptr("AudioStreamWAV", "set_data", 2971499966, wav, data_args);
  g_iface.variant_get_ptr_destructor(GDEXTENSION_VARIANT_TYPE_PACKED_BYTE_ARRAY)(data);
  probing = true;
  double offset = 0; const void *play_args[] = {&offset};
  probe_player = make_probe_player(parent, wav_ref); ptr("AudioStreamPlayer", "play", 1958160172, probe_player, play_args);
  ptr("AudioStreamPlayer", "stop", 3218959716, probe_player);
  native_stop_entry = observed_entry; observed_entry = 0;
  void *second = make_probe_player(parent, wav_ref); ptr("AudioStreamPlayer", "play", 1958160172, second, play_args);
  g_iface.object_destroy(second);
  bool agrees = native_stop_entry && observed_entry == native_stop_entry;
  if (agrees) {
    GDExtensionCallableCustomInfo2 info{}; info.token = g_iface.library; info.call_func = probe_finished_call;
    g_iface.callable_custom_create2(probe_callable, &info); probe_callable_made = true;
    StringName signal("finished"); int64_t flags = 0, result = -1;
    const void *connect_args[] = {signal.ptr(), probe_callable, &flags};
    ptr("Object", "connect", 1518946055, probe_player, connect_args, &result);
    agrees = result == 0;
    ptr("AudioStreamPlayer", "play", 1958160172, probe_player, play_args);
    if (probe_ref) native_end(&probe_ref); else agrees = false;
    bool playing = true; ptr("AudioStreamPlayer", "is_playing", 36873697, probe_player, nullptr, &playing);
    agrees &= !playing;
  }
  g_iface.ref_set_object(&probe_ref, nullptr); g_iface.ref_set_object(&wav_ref, nullptr);
  probing = false; probe_waiting = agrees;
  if (agrees) frame_work.fetch_or(frame_probe, std::memory_order_relaxed);
  std::fprintf(stdout, "[grc-audio-stop] callers_agree=%d activity_cleared=%d\n", agrees, agrees);
  return agrees;
}
void finish_stop_probe() {
  stop_validated = probe_waiting && probe_finished == 1;
  frame_work.fetch_and(~frame_probe, std::memory_order_relaxed);
  if (!stop_validated) frame_work.fetch_and(~frame_voices, std::memory_order_relaxed);
  if (!stop_validated) godot_slab().refuse("unavailable:no-stop-entry");
  probing = true;
  if (probe_player) g_iface.object_destroy(probe_player);
  probe_player = nullptr;
  if (probe_callable_made && !rs::env("GRC_AUDIO_TEST_BENCH_VOICES")) g_iface.variant_get_ptr_destructor(GDEXTENSION_VARIANT_TYPE_CALLABLE)(probe_callable);
  probe_callable_made = rs::env("GRC_AUDIO_TEST_BENCH_VOICES") != nullptr; probe_waiting = false; probing = false;
  std::fprintf(stdout, "[grc-audio-stop] validated=%d finished=%d\n", stop_validated, probe_finished);
}

}
bool start_sample(const Probe &probe, const Abi &abi, std::string *error) {
  if (abi.slots.size() != 38 || !sample_preflight(error)) return false;
  if (member<uint64_t>(reinterpret_cast<void *>(probe.object)) != probe.vptr) { *error = "audio vptr changed"; return false; }
  driver_object = reinterpret_cast<void *>(probe.object);
  server = singleton_object("AudioServer");
  length_bind = method_bind("AudioStream", "get_length", 1740695150);
  index_bind = method_bind("AudioServer", "get_bus_index", 2458036349);
  name_bind = method_bind("AudioServer", "get_bus_name", 844755477);
  string_index = reinterpret_cast<GDExtensionInterfaceStringOperatorIndexConst>(g_iface.get_proc_address("string_operator_index_const"));
  if (!server || !length_bind || !index_bind || !name_bind || !string_index) { *error = "audio sample method binds unavailable"; return false; }
  void *hooks[] = {reinterpret_cast<void *>(registered), reinterpret_cast<void *>(registration),
    reinterpret_cast<void *>(unregistration), reinterpret_cast<void *>(start), reinterpret_cast<void *>(stop),
    reinterpret_cast<void *>(pause), reinterpret_cast<void *>(active), reinterpret_cast<void *>(position),
    reinterpret_cast<void *>(pitch), reinterpret_cast<void *>(volumes), reinterpret_cast<void *>(count),
    reinterpret_cast<void *>(remove), reinterpret_cast<void *>(add), reinterpret_cast<void *>(move),
    reinterpret_cast<void *>(send), reinterpret_cast<void *>(volume), reinterpret_cast<void *>(solo), reinterpret_cast<void *>(mute)};
  std::vector<SlotReplacement> replacements;
  for (size_t i = 0; i < 18; ++i) replacements.push_back({i + 18, hooks[i], &original[i + 18]});
  if (!shadow.arm(reinterpret_cast<void *>(probe.object), 38, replacements, error)) return false;
  godot_slab().arm();
  int64_t buses = 1;
  auto get_count = method_bind("AudioServer", "get_bus_count", 3905245786);
  if (get_count) g_iface.object_method_bind_ptrcall(get_count, server, nullptr, &buses);
  count(nullptr, int(buses));
  // Retain the bus layout already loaded before the extension armed.
  auto get_volume = method_bind("AudioServer", "get_bus_volume_db", 2339986948);
  auto get_send = method_bind("AudioServer", "get_bus_send", 659327637);
  auto get_solo = method_bind("AudioServer", "is_bus_solo", 1116898809);
  auto get_mute = method_bind("AudioServer", "is_bus_mute", 1116898809);
  if (!get_volume || !get_send || !get_solo || !get_mute) {
    stop_sample(); *error = "audio bus method binds unavailable"; return false;
  }
  for (int64_t i = 0; i < buses && i < int64_t(kAudioBuses); ++i) {
    const void *args[] = {&i}; double db = 0; bool soloed = false, muted = false; void *destination = nullptr;
    g_iface.object_method_bind_ptrcall(get_volume, server, args, &db);
    g_iface.object_method_bind_ptrcall(get_send, server, args, &destination);
    g_iface.object_method_bind_ptrcall(get_solo, server, args, &soloed);
    g_iface.object_method_bind_ptrcall(get_mute, server, args, &muted);
    godot_slab().bus("volume_db", int(i), 0, float(db), false, now_us());
    godot_slab().bus("send", int(i), i ? bus_index(&destination) : -1, 0, false, now_us());
    godot_slab().bus("solo", int(i), 0, 0, soloed, now_us());
    godot_slab().bus("mute", int(i), 0, 0, muted, now_us());
    g_iface.variant_get_ptr_destructor(GDEXTENSION_VARIANT_TYPE_STRING_NAME)(&destination);
  }
  if (!sample_default()) { stop_sample(); *error = "ProjectSettings.set_setting failed"; return false; }
  godot_slab().playback_position = [](uint64_t k, uint64_t t) { return playback_clock.position(k, t); };
  sabotage_no_end = rs::env("GRC_AUDIO_TEST_NO_END") && std::string_view(rs::env("GRC_AUDIO_TEST_NO_END")) == "audio-no-end";
  if (!begin_stop_probe()) { finish_stop_probe(); stop_sample(); *error = "no-stop-entry"; return false; }
  sample_assets_begin();
  sample_test_begin();
  return true;
}
void sample_frame_check(unsigned work) {
  if (work & frame_probe) finish_stop_probe();
  if (!(work & frame_voices) || !stop_validated || sabotage_no_end) return;
  const auto t = now_us();
  while (playback_clock.any() && playback_clock.due(t)) {
    ClockVoice ended;
    { auto guard = godot_slab().lock();
      if (!playback_clock.any() || !playback_clock.due(t)) break;
      ended = playback_clock.remove(playback_clock.top_key());
      if (!playback_clock.any()) frame_work.fetch_and(~frame_voices, std::memory_order_relaxed);
    }
    ending_key = ended.key;
    native_end(&ended.retained); // No capture lock is held across Godot's native stop path.
    ending_key = 0;
    godot_slab().stop(ended.key, t, "end");
    g_iface.ref_set_object(&ended.retained, nullptr);
  }
}
namespace {
struct ClockBench {
  bool started = false, validate = false;
  size_t frame = 0, voices = 0;
  static constexpr size_t warm = 100, frames = 10000;
  std::array<uint64_t, frames> checks{}, intervals{};
  std::array<uint64_t, kAudioVoices> ends{};
  uint64_t previous = 0;
  std::array<void *, kAudioVoices> players{};
  std::array<uint64_t, kAudioVoices> keys{};
  void *wav_ref = nullptr;
};
std::unique_ptr<ClockBench> clock_bench;
uint64_t bench_ns() {
  return uint64_t(std::chrono::duration_cast<std::chrono::nanoseconds>(
      std::chrono::steady_clock::now().time_since_epoch()).count());
}
void bench_setup() {
  const char *voices = rs::env("GRC_AUDIO_TEST_BENCH_VOICES");
  if (!voices || !*voices) return;
  clock_bench = std::make_unique<ClockBench>();
  auto &bench = *clock_bench;
  bench.validate = rs::env("GRC_AUDIO_TEST_BENCH_VALIDATE") != nullptr;
  frame_work.fetch_or(frame_bench, std::memory_order_relaxed);
  bench.voices = std::min(size_t(std::strtoul(voices, nullptr, 10)), kAudioVoices);
}
void bench_players() {
  auto &bench = *clock_bench;
  if (!bench.voices) return;
  void *tree = nullptr, *parent = nullptr;
  ptr("Engine", "get_main_loop", 1016888095, singleton_object("Engine"), nullptr, &tree);
  ptr("SceneTree", "get_current_scene", 3160264692, tree, nullptr, &parent);
  StringName wav_class("AudioStreamWAV");
  auto wav = g_iface.classdb_construct_object2(wav_class.ptr());
  g_iface.ref_set_object(&bench.wav_ref, wav);
  // A silent one-byte sample with a forward loop keeps each voice live indefinitely.
  alignas(8) unsigned char bytes[16]{};
  g_iface.variant_get_ptr_constructor(GDEXTENSION_VARIANT_TYPE_PACKED_BYTE_ARRAY, 0)(bytes, nullptr);
  int64_t one = 1, result = 0; const void *one_arg[] = {&one};
  auto resize = g_iface.variant_get_ptr_builtin_method(GDEXTENSION_VARIANT_TYPE_PACKED_BYTE_ARRAY, StringName("resize").ptr(), 848867239);
  resize(bytes, one_arg, &result, 1);
  auto index = reinterpret_cast<GDExtensionInterfacePackedByteArrayOperatorIndex>(g_iface.get_proc_address("packed_byte_array_operator_index"));
  *index(bytes, 0) = 0;
  const void *byte_args[] = {bytes}; ptr("AudioStreamWAV", "set_data", 2971499966, wav, byte_args);
  g_iface.variant_get_ptr_destructor(GDEXTENSION_VARIANT_TYPE_PACKED_BYTE_ARRAY)(bytes);
  ptr("AudioStreamWAV", "set_loop_mode", 2444882972, wav, one_arg);
  ptr("AudioStreamWAV", "set_loop_end", 1286410249, wav, one_arg);
  for (size_t i = 0; i < bench.voices; ++i) {
    auto player = make_probe_player(parent, bench.wav_ref); bench.players[i] = player;
    StringName signal("finished"); int64_t flags = 0, connected = -1;
    const void *args[] = {signal.ptr(), probe_callable, &flags};
    if (probe_callable_made) ptr("Object", "connect", 1518946055, player, args, &connected);
    double offset = 0; const void *play_args[] = {&offset};
    ptr("AudioStreamPlayer", "play", 1958160172, player, play_args);
    bench.keys[i] = last_started_key;
  }
}
void bench_write() {
  auto &bench = *clock_bench;
  const char *directory = rs::env("GRC_EVIDENCE_DIR"); if (!directory) return;
  JsonWriter j; j.object_begin().field("schema", std::string("audio-voice-clock-round/1"));
  j.key("voices").unsigned_integer(bench.voices).field("granted", stop_validated);
  j.field("validation_only", bench.validate);
  auto array = [&](const char *name, const auto &values, size_t n) {
    j.key(name).array_begin(); size_t i = 0;
    for (const auto value : values) { if (i++ == n) break; j.unsigned_integer(value); }
    j.array_end();
  };
  if (!bench.validate) {
    array("check_ns", bench.checks, bench.frames); array("frame_ns", bench.intervals, bench.frames);
    array("end_ns", bench.ends, stop_validated ? bench.voices : 0);
  }
  j.key("finished").integer(probe_finished - (stop_validated ? 1 : 0));
  j.object_end();
  rs::File output(rs::open_file((std::string(directory) + "/voice-clock-round.json").c_str(), "wb"));
  if (output) { auto text = j.take(); std::fwrite(text.data(), 1, text.size(), output.get()); }
}
}
void sample_bench_configure() { bench_setup(); }
void sample_frame() {
  // Empty playback: one relaxed load, no timer, heap, or test-state access.
  const auto work = frame_work.load(std::memory_order_relaxed);
  if (!work) return;
  if (!(work & frame_bench)) { sample_frame_check(work); return; }
  auto &bench = *clock_bench;
  if (!bench.started) { sample_frame_check(frame_work.load(std::memory_order_relaxed)); bench_players(); bench.started = true; }
  const auto frame_start = bench.validate ? 0 : bench_ns();
  frame_work.fetch_and(~frame_bench, std::memory_order_relaxed);
  const auto start = bench.validate ? 0 : bench_ns(); sample_frame(); const auto end = bench.validate ? 0 : bench_ns();
  frame_work.fetch_or(frame_bench, std::memory_order_relaxed);
  if (bench.frame >= bench.warm && bench.frame < bench.warm + bench.frames) {
    const auto i = bench.frame - bench.warm;
    bench.checks[i] = end - start; bench.intervals[i] = frame_start - bench.previous;
  }
  bench.previous = frame_start; ++bench.frame;
  if (bench.frame != (bench.validate ? 3 : bench.warm + bench.frames)) return;
  // Owned benchmark players only. Drive Godot's own internal process notification
  // immediately after its native stop to isolate CPU cost from the next-frame wait.
  const auto notify = method_bind("Object", "notification", 4023243586);
  for (size_t i = 0; stop_validated && i < bench.voices && playback_clock.any(); ++i) {
    auto ended = playback_clock.remove(bench.keys[i]); ending_key = ended.key;
    int64_t what = 25; bool reversed = false; const void *args[] = {&what, &reversed};
    const auto t = bench.validate ? 0 : bench_ns(); native_end(&ended.retained);
    g_iface.object_method_bind_ptrcall(notify, bench.players[i], args, nullptr);
    bench.ends[i] = bench.validate ? 0 : bench_ns() - t; ending_key = 0;
    godot_slab().stop(ended.key, now_us(), "end"); g_iface.ref_set_object(&ended.retained, nullptr);
  }
  bench_write();
  frame_work.fetch_and(~(frame_bench | frame_voices), std::memory_order_relaxed);
  for (auto &player : bench.players) if (player) { g_iface.object_destroy(player); player = nullptr; }
  g_iface.ref_set_object(&bench.wav_ref, nullptr);
}

void stop_sample() {
  sample_test_end();
  sample_assets_end();
  if (clock_bench) {
    for (auto &player : clock_bench->players) if (player && !g_root_finalized) g_iface.object_destroy(player);
    if (clock_bench->wav_ref) g_iface.ref_set_object(&clock_bench->wav_ref, nullptr);
    clock_bench.reset();
  }
  if (probe_callable_made && !probe_player) {
    g_iface.variant_get_ptr_destructor(GDEXTENSION_VARIANT_TYPE_CALLABLE)(probe_callable); probe_callable_made = false;
  }
  if (probe_player) finish_stop_probe();
  godot_slab().playback_position = nullptr;
  while (playback_clock.any()) {
    auto v = playback_clock.remove(playback_clock.top_key());
    g_iface.ref_set_object(&v.retained, nullptr);
  }
  frame_work.store(0, std::memory_order_relaxed);
  if (!shadow.built()) return;
  bool was = false, restored = false; shadow.disarm(&was, &restored);
}
}
#else
namespace grc::audio {
bool start_sample(const Probe &, const Abi &, std::string *error) { *error = "audio sample capture supports Linux x86-64 only"; return false; }
void stop_sample() {}
void sample_frame() {}
void sample_bench_configure() {}
}
#endif
