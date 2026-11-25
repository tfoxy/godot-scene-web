#include "audio_driver_assets.h"
#include "iface.h"
#include "rs_audio_assets.h"
#include "rs_audio_slab.h"
#include "rs_audio_sender.h"
#include "rs_audio_config.h"
#include "rs_platform.h"
#include <condition_variable>
#include <deque>
#include <thread>
#include <set>
#include <cmath>
#include <cstring>

namespace grc::audio {
namespace {
// Builtins are constructed before ptrcall assigns into them, and destroyed by Godot.
struct Builtin {
  alignas(8) unsigned char data[24]{};
  GDExtensionVariantType type;
  explicit Builtin(GDExtensionVariantType t) : type(t) { g_iface.variant_get_ptr_constructor(t, 0)(data, nullptr); }
  ~Builtin() { g_iface.variant_get_ptr_destructor(type)(data); }
  int64_t size() {
    int64_t n = 0;
    auto method = g_iface.variant_get_ptr_builtin_method(type, StringName("size").ptr(), 3173160232);
    if (method) method(data, nullptr, &n, 0);
    return n;
  }
};
bool call(const char *cls, const char *method, int64_t hash, void *obj,
          const void *const *args, void *out) {
  auto bind = method_bind(cls, method, hash); if (!bind || !obj) return false;
  g_iface.object_method_bind_ptrcall(bind, obj, args, out); return true;
}
struct Ref {
  void *value = nullptr;
  ~Ref() { if (value) g_iface.ref_set_object(&value, nullptr); }
};
Bytes data_bytes(void *obj, const char *cls) {
  Builtin bytes(GDEXTENSION_VARIANT_TYPE_PACKED_BYTE_ARRAY);
  if (!call(cls, "get_data", 2362200018, obj, nullptr, bytes.data)) return {};
  const auto n = bytes.size();
  auto index = reinterpret_cast<GDExtensionInterfacePackedByteArrayOperatorIndexConst>(g_iface.get_proc_address("packed_byte_array_operator_index_const"));
  if (!index || n <= 0) return {};
  const auto *p = index(bytes.data, 0); return Bytes(p, p + n);
}
bool element(void *array, int64_t i, Builtin &out) {
  const auto *v = g_iface.array_operator_index_const(array, i);
  if (!v || g_iface.variant_get_type(v) != out.type) return false;
  // Variant-to-type assigns, just like ptrcall, into the constructed builtin.
  g_iface.get_variant_to_type_constructor(out.type)(out.data, const_cast<void *>(v)); return true;
}
Bytes ogg_bytes(void *obj, SampleState *metadata = nullptr) {
  Ref sequence;
  if (!call("AudioStreamOggVorbis", "get_packet_sequence", 2801636033, obj, nullptr, &sequence.value) || !sequence.value) return {};
  Builtin pages(GDEXTENSION_VARIANT_TYPE_ARRAY), granules(GDEXTENSION_VARIANT_TYPE_PACKED_INT64_ARRAY);
  if (!call("OggPacketSequence", "get_packet_data", 3995934104, sequence.value, nullptr, pages.data) ||
      !call("OggPacketSequence", "get_packet_granule_positions", 235988956, sequence.value, nullptr, granules.data)) return {};
  if (pages.size() != granules.size()) return {};
  auto integers = reinterpret_cast<GDExtensionInterfacePackedInt64ArrayOperatorIndexConst>(g_iface.get_proc_address("packed_int64_array_operator_index_const"));
  auto bytes = reinterpret_cast<GDExtensionInterfacePackedByteArrayOperatorIndexConst>(g_iface.get_proc_address("packed_byte_array_operator_index_const"));
  if (!integers || !bytes) return {};
  std::vector<OggPage> result;
  for (int64_t i = 0; i < pages.size(); ++i) {
    Builtin packets(GDEXTENSION_VARIANT_TYPE_ARRAY); if (!element(pages.data, i, packets)) return {};
    OggPage page; page.granule = *integers(granules.data, i);
    for (int64_t j = 0; j < packets.size(); ++j) {
      Builtin packet(GDEXTENSION_VARIANT_TYPE_PACKED_BYTE_ARRAY);
      if (!element(packets.data, j, packet)) return {};
      auto n = packet.size();
      if (n) { auto p = bytes(packet.data, 0); page.packets.emplace_back(p, p + n); }
      else page.packets.emplace_back();
    }
    result.push_back(std::move(page));
  }
  if (metadata && !result.empty() && !result.front().packets.empty()) {
    const auto &header = result.front().packets.front();
    if (header.size() >= 16 && header[0] == 1 && std::memcmp(header.data() + 1, "vorbis", 6) == 0) {
      metadata->channels = header[11]; metadata->rate = 0;
      for (unsigned b = 0; b < 4; ++b) metadata->rate |= uint32_t(header[12 + b]) << (8 * b);
    }
  }
  return remux_ogg(result);
}
Bytes decoded_wav(void *obj, const SampleState &s) {
  Ref copy; bool deep = false; const void *duplicate[] = {&deep};
  if (!call("Resource", "duplicate", 482882304, obj, duplicate, &copy.value) || !copy.value) return {};
  int64_t disabled = 0; bool no_loop = false;
  const void *mode[] = {&disabled}, *loop[] = {&no_loop};
  std::string cls; call_string_getter(method_bind("Object", "get_class", 201670096), copy.value, &cls);
  if (cls == "AudioStreamWAV") call("AudioStreamWAV", "set_loop_mode", 2444882972, copy.value, mode, nullptr);
  else call(cls.c_str(), "set_loop", 2586408642, copy.value, loop, nullptr);
  Ref playback;
  obj = copy.value;
  if (!call("AudioStream", "instantiate_playback", 210135309, obj, nullptr, &playback.value) || !playback.value) return {};
  double offset = 0, mix_rate = 0, speed = 1;
  void *server = singleton_object("AudioServer");
  call("AudioServer", "get_mix_rate", 1740695150, server, nullptr, &mix_rate);
  call("AudioServer", "get_playback_speed_scale", 1740695150, server, nullptr, &speed);
  if (mix_rate <= 0 || speed <= 0 || !s.rate || s.channels < 1 || s.channels > 2) return {};
  const void *start[] = {&offset};
  if (!call("AudioStreamPlayback", "start", 1958160172, playback.value, start, nullptr)) return {};
  // Undo Godot's output-rate resampling and global playback speed. The private
  // playback never enters AudioServer's active playback list or the sample seam.
  double scale = mix_rate / (double(s.rate) * speed);
  uint64_t remaining = uint64_t(std::llround(s.length_s * s.rate));
  if (remaining > (UINT32_MAX - 36) / (s.channels * 2)) return {};
  std::vector<float> pcm; pcm.reserve(size_t(remaining) * s.channels);
  auto index = reinterpret_cast<GDExtensionInterfacePackedVector2ArrayOperatorIndexConst>(g_iface.get_proc_address("packed_vector2_array_operator_index_const"));
  if (!index) return {};
  while (remaining) {
    int64_t count = int64_t(std::min(uint64_t(4096), remaining)); const void *args[] = {&scale, &count};
    Builtin frames(GDEXTENSION_VARIANT_TYPE_PACKED_VECTOR2_ARRAY);
    if (!call("AudioStreamPlayback", "mix_audio", 3341291446, playback.value, args, frames.data)) return {};
    const auto n = std::min(count, frames.size()); if (n <= 0) break;
    for (int64_t i = 0; i < n; ++i) {
      auto p = reinterpret_cast<const float *>(index(frames.data, i));
      pcm.push_back(p[0]); if (s.channels == 2) pcm.push_back(p[1]);
    }
    remaining -= uint64_t(n);
  }
  call("AudioStreamPlayback", "stop", 3218959716, playback.value, nullptr, nullptr);
  return pcm16_wav(pcm, s.rate, s.channels);
}
class Source final : public VariantSupplier {
 public:
  struct Held { uint64_t key = 0; void *ref = nullptr; };
  AudioSlots<Held, kAudioSamples * 2> held;
  struct Job { uint32_t id; void *ref; SampleState sample; bool wav; };
  std::mutex mu;
  std::condition_variable cv;
  std::deque<Job> jobs;
  std::set<std::pair<uint32_t, bool>> pending;
  std::thread worker;
  bool stopping = false;
  std::vector<void *> restricted_names;
  void request(uint32_t id, uint64_t key) override { enqueue(id, key, false); }
  void fallback(uint32_t id, uint64_t key) override { enqueue(id, key, true); }
  void enqueue(uint32_t id, uint64_t, bool wav) {
    // Called with the slab lock; a registered stream or a retained voice owns it.
    auto *h = held.find(id); if (!h) return;
    std::lock_guard guard(mu);
    if (stopping || !pending.insert({id, wav}).second) return;
    SampleState sample;
    if (const auto *s = godot_slab().sample_state(reinterpret_cast<uint64_t>(h->ref))) sample = *s;
    else {
      // A voice can outlive unregistration; its metadata is retained in the slab.
      sample = metadata[id];
    }
    void *ref = nullptr; g_iface.ref_set_object(&ref, h->ref);
    jobs.push_back({id, ref, sample, wav});
    if (!worker.joinable()) worker = std::thread([this] { run(); });
    cv.notify_one();
  }
  // Registration metadata is preallocated too: no heap work while dormant.
  struct Meta { uint64_t key = 0; SampleState value; };
  AudioSlots<Meta, kAudioSamples * 2> records;
  SampleState &metadata_at(uint32_t id) { return records.find(id)->value; }
  // Kept as a small adapter so the queue path reads one fixed record.
  struct Metadata { Source &source; SampleState &operator[](uint32_t id) { return source.metadata_at(id); } } metadata{*this};
  void registered(uint32_t id, uint64_t key) {
    if (!id) return;
    auto *h = held.insert(id); auto *m = records.insert(id);
    if (!h || !m) return;
    if (!h->ref) g_iface.ref_set_object(&h->ref, reinterpret_cast<void *>(key));
    m->value = *godot_slab().sample_state(key);
  }
  void released(uint32_t id) override {
    if (auto *h = held.find(id)) { g_iface.ref_set_object(&h->ref, nullptr); held.erase(id); records.erase(id); }
    godot_assets().release(id, now_us());
  }
  void no_store(uint32_t id) override { godot_assets().no_store(id); }
  void run() {
    rs::set_current_thread_name("rs-audio-asset");
    for (;;) {
      Job job;
      { std::unique_lock guard(mu); cv.wait(guard, [&] { return stopping || !jobs.empty(); });
        if (jobs.empty()) return;
        job = jobs.front(); jobs.pop_front(); }
      std::string cls; call_string_getter(method_bind("Object", "get_class", 201670096), job.ref, &cls);
      const char *codec = job.wav || cls == "AudioStreamWAV" ? "wav" : cls == "AudioStreamMP3" ? "mp3" : "ogg-vorbis";
      Bytes bytes;
      // AudioStreamWAV::generate_sample leaves channels at the mono default.
      // Use the stream's channel count before decoding and publishing metadata.
      if (cls == "AudioStreamWAV") {
        bool stereo = false;
        if (call("AudioStreamWAV", "is_stereo", 36873697, job.ref, nullptr, &stereo))
          job.sample.channels = stereo ? 2 : 1;
      }
      if (std::string_view(codec) == "mp3") bytes = data_bytes(job.ref, "AudioStreamMP3");
      else if (std::string_view(codec) == "ogg-vorbis") {
        bytes = ogg_bytes(job.ref, &job.sample);
        if (rs::env("GRC_AUDIO_TEST_OGG_REMUX_FAIL")) bytes.clear();
      }
      // Compressed AudioSample structs retain Godot defaults rather than the
      // source rate/channels. Read the codec header, not those defaults.
      Bytes original = cls == "AudioStreamMP3" ? (bytes.empty() ? data_bytes(job.ref, "AudioStreamMP3") : bytes) : Bytes{};
      if (cls == "AudioStreamMP3") {
        const auto format = mp3_format(original);
        if (format.rate) { job.sample.rate = format.rate; job.sample.channels = format.channels; }
      }
      if (job.wav && cls == "AudioStreamOggVorbis") ogg_bytes(job.ref, &job.sample);
      if (cls != "AudioStreamWAV") call(cls.c_str(), "get_loop_offset", 1740695150, job.ref, nullptr, &job.sample.begin);
      if (bytes.empty()) { codec = "wav"; bytes = decoded_wav(job.ref, job.sample); }
      // If remux failed, the first announced codec is WAV, hence native-frame units.
      if (!job.wav && cls != "AudioStreamWAV" && std::string_view(codec) == "wav")
        job.sample.begin = std::round(job.sample.begin * job.sample.rate);
      { auto guard = godot_slab().lock();
        if (!bytes.empty() && godot_slab().wanted(job.id)) {
          godot_slab().metadata(job.id, job.sample.rate, job.sample.channels, job.sample.begin);
          const auto size = bytes.size();
          auto hash = godot_assets().put(job.id, std::move(bytes), codec, godot_slab().storable(job.id), now_us());
          godot_slab().variant(job.id, hash.c_str(), size, now_us(), codec);
        }
      }
      g_iface.ref_set_object(&job.ref, nullptr);
      { std::lock_guard guard(mu); pending.erase({job.id, job.wav}); }
      godot_assets().sweep(now_us());
    }
  }
  ~Source() {
    { std::lock_guard guard(mu); stopping = true; } cv.notify_all();
    if (worker.joinable()) worker.join();
    for (const auto &h : held.values()) if (h.key && h.ref) { auto ref = h.ref; g_iface.ref_set_object(&ref, nullptr); }
    for (auto &name : restricted_names) g_iface.variant_get_ptr_destructor(GDEXTENSION_VARIANT_TYPE_STRING_NAME)(&name);
  }
};
std::unique_ptr<Source> source;
}
void sample_assets_begin() {
  source = std::make_unique<Source>();
  Config config; std::string error; if (!configure(true, &config, &error)) return;
  godot_slab().configure_store(config.store_max_ms);
  for (const auto &name : config.no_store_buses) {
    void *string = nullptr, *sn = nullptr;
    g_iface.string_new_with_utf8_chars(&string, name.c_str());
    const void *args[] = {&string};
    g_iface.variant_get_ptr_constructor(GDEXTENSION_VARIANT_TYPE_STRING_NAME, 2)(&sn, args);
    g_iface.variant_get_ptr_destructor(GDEXTENSION_VARIANT_TYPE_STRING)(&string);
    source->restricted_names.push_back(sn);
  }
  godot_slab().supplier(source.get());
}
void sample_assets_registered(uint32_t id, uint64_t stream) { if (source) source->registered(id, stream); }
bool sample_bus_restricted(const void *name) {
  if (!source) return false;
  void *value = nullptr; std::memcpy(&value, name, sizeof(value));
  for (auto stored : source->restricted_names) if (stored == value) return true;
  return false;
}
void sample_assets_end() {
  // Never join while holding the slab lock: completion takes it before publication.
  { auto guard = godot_slab().lock(); godot_slab().supplier(nullptr); }
  source.reset();
}
}  // namespace grc::audio
