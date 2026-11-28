#include "fake_godot_iface.h"
#include "calib.h"
#include "calib_live.h"
#include "rs_identity_event.h"
#include "vtable.h"
#include "rs_capture_api.h"

#include <condition_variable>
#include <deque>
#include <future>
#include <map>

namespace {
int checks = 0, failures = 0;
void check(bool ok, const char *name) {
  ++checks;
  if (!ok) { ++failures; std::printf("FAIL %s\n", name); }
}
std::mutex queue_mutex;
std::condition_variable queued;
std::deque<GDExtensionCallableCustomInfo2> events;
GDExtensionCallableCustomInfo2 info;
void noop(void *) {}
GDExtensionPtrDestructor destructor(GDExtensionVariantType) { return noop; }
void create(GDExtensionUninitializedTypePtr out, GDExtensionCallableCustomInfo2 *value) {
  info = *value;
  std::memset(out, 0, 16);
}
void from_callable(GDExtensionUninitializedVariantPtr out, GDExtensionTypePtr) {
  std::memset(out, 0, 24);
}
GDExtensionVariantFromTypeConstructorFunc from_type(GDExtensionVariantType) { return from_callable; }
void call(GDExtensionVariantPtr, GDExtensionConstStringNamePtr name,
          const GDExtensionConstVariantPtr *, GDExtensionInt, GDExtensionUninitializedVariantPtr out,
          GDExtensionCallError *error) {
  check(fake::name_of(name) == "call_deferred", "worker uses Callable.call_deferred");
  std::memset(out, 0, 24);
  error->error = GDEXTENSION_CALL_OK;
  { std::lock_guard<std::mutex> lock(queue_mutex); events.push_back(info); }
  queued.notify_one();
}
GDExtensionInterfaceFunctionPtr proc(const char *name) {
  return std::strcmp(name, "variant_call") == 0 ?
      reinterpret_cast<GDExtensionInterfaceFunctionPtr>(call) : nullptr;
}
GDExtensionObjectPtr object_new(GDExtensionConstStringNamePtr) {
  return &fake::world().make({"Object"});
}
void object_destroy(GDExtensionObjectPtr p) {
  fake::world().by_id.erase(static_cast<fake::Object *>(p)->id);
}
void install() {
  fake::install();
  grc::g_iface.get_proc_address = proc;
  grc::g_iface.classdb_construct_object2 = object_new;
  grc::g_iface.object_destroy = object_destroy;
  grc::g_iface.object_get_instance_id = [](GDExtensionConstObjectPtr p) -> GDObjectInstanceID {
    return static_cast<const fake::Object *>(p)->id;
  };
  grc::g_iface.callable_custom_create2 = create;
  grc::g_iface.variant_get_ptr_destructor = destructor;
  grc::g_iface.get_variant_from_type_constructor = from_type;
  grc::g_iface.variant_destroy = noop;
}
void flush() {
  GDExtensionCallableCustomInfo2 event;
  {
    std::unique_lock<std::mutex> lock(queue_mutex);
    if (!queued.wait_for(lock, std::chrono::seconds(10), [] { return !events.empty(); })) {
      check(false, "completion event queued"); return;
    }
    event = events.front(); events.pop_front();
  }
  GDExtensionCallError error{};
  if (fake::world().by_id.contains(event.object_id))
    event.call_func(event.callable_userdata, nullptr, 0, nullptr, &error);
  check(error.error == GDEXTENSION_CALL_OK, "completion callback returns OK");
}
bool fake_pe_hash(const std::string &path, std::string *hex, uint64_t *bytes,
                  uint64_t *base, std::string *, std::string *whole) {
  if (path != "derived" && path != "record") return false;
  // Refuse an unexpected request: record mode must never read the file overlay.
  if ((whole != nullptr) != (path == "derived")) return false;
  *hex = "matched"; *bytes = 1024; *base = 0x140000000;
  if (whole) *whole = std::string(64, 'a');
  return true;
}
void test_digest(const std::string &hex, bool ok, const char *expected, bool requests = false,
                 uint64_t mapped_base = 0x140000000, uint64_t loaded_base = 0x140000000,
                 bool derived = false) {
  install();
  grc::IdentityDigest digest;
  grc::IdentityEvent event;
  std::promise<void> release;
  auto ready = release.get_future();
  std::promise<void> entered;
  auto started = entered.get_future();
  const auto main = std::this_thread::get_id();
  std::thread::id provider_thread;
#if defined(_WIN32)
  int provider_priority = THREAD_PRIORITY_ERROR_RETURN;
#endif
  bool decided = false;
  grc::rs::capture::Api api;
  api.wait_for_identity(true);
  grc::ShadowVtable shadow;
  void *table[3] = {nullptr, nullptr, reinterpret_cast<void *>(noop)};
  void **object = table + 2;
  void *original = nullptr;
  std::string reason;
  grc::ProcessFingerprint fp;
  fp.platform = "windows-x86_64"; fp.version_string = "fixture";
  fp.image_base = mapped_base; fp.load_bias = loaded_base - mapped_base;
  fp.dynamic_base = true;
  grc::Calibration calibration;
  calibration.platform = fp.platform; calibration.version_string = fp.version_string;
  calibration.image_sha256 = "matched";
  calibration.image_base = 0x140000000; calibration.dynamic_base = true;
  check(event.prepare(digest, [&] {
    grc::ImageDigestResult result;
    if (!digest.result(&result)) return;
    decided = true;
    std::string error;
    if (!grc::resolve_windows_image_digest(&fp, result, &error)) {
      reason = "fingerprint-unavailable";
      api.loaded(grc::rs::capture::State::Refused, reason); api.identity_complete(false, reason);
      return;
    }
    check(fp.exe_sha256 == (derived ? std::string(64, 'a') : std::string()),
          "whole-file digest is resolved before derived checks; record mode leaves it empty");
    std::vector<grc::CheckResult> results;
    if (!grc::check_fingerprint(calibration, fp, &results)) reason = "fingerprint-mismatch";
    else {
      check(fp.image_base == calibration.image_base &&
            fp.load_bias == loaded_base - calibration.image_base,
            "async image base and load bias match synchronous file-based identity");
      check(results[3].name == "aslr_and_bias" && results[3].ok,
            "resolved preferred base passes ASLR fingerprint check");
      check(shadow.build(&object, 1, {{0, reinterpret_cast<void *>(noop), &original, true}},
                         &error), "matched identity builds standby hooks");
      check(shadow.publish(grc::ShadowVtable::Table::Standby), "matched identity publishes standby");
    }
    check(results.size() == 5, "all Windows fingerprint fields remain checked");
    check(result.ns > 0, "worker wall time collected");
    api.loaded(reason.empty() ? grc::rs::capture::State::Standby : grc::rs::capture::State::Refused, reason);
    api.identity_complete(reason.empty(), reason);
  }), "completion Callable prepared");
  check(digest.start(fp.platform, "detached", [&] {
#if defined(_WIN32)
    provider_priority = GetThreadPriority(GetCurrentThread());
#endif
    provider_thread = std::this_thread::get_id(); entered.set_value(); ready.wait();
    auto result = grc::compute_windows_image_digest(
        derived ? "derived" : "record", derived, fake_pe_hash);
    result.ok = result.ok && ok; result.hex = hex;
    result.image_base = calibration.image_base; return result;
  }, [&] { event.post(); }), "Windows starts one digest worker");
  started.wait();
  grc::ImageDigestResult result;
  check(!digest.result(&result) && fp.exe_sha256.empty() && !decided && !shadow.built() &&
        object == table + 2, "pending has no decision or hooks");
  check(provider_thread != main, "image provider runs off main");
#if defined(_WIN32)
  check(provider_priority == THREAD_PRIORITY_BELOW_NORMAL, "image provider runs below normal Windows priority");
#endif
  check(!digest.start(fp.platform, "detached", {}, {}), "digest is once per process");
  if (requests) {
    check(api.attach() == 0 && api.arm() == 0 && !api.arm_pending(),
          "couch attach and arm return success while worker is blocked");
    check(api.requests_queued_on_identity() == 2, "couch requests both counted");
  }
  release.set_value();
  flush();
  check(decided && reason == expected && (shadow.published() == grc::ShadowVtable::Table::Standby) == reason.empty(), "event decides identity and gates publication");
  if (requests && reason.empty()) {
    check(api.attachment() == grc::rs::capture::Attachment::Attached && api.arm_pending(),
          "deferred event publishes standby before completing queued attach");
    api.arm_point();
    check(shadow.publish(grc::ShadowVtable::Table::Armed), "queued arm publishes only after identity");
    api.armed({});
    auto signals = api.take_signals();
    check(api.phase() == grc::rs::capture::State::Armed && signals.size() == 1 &&
          signals[0].name == "armed", "queued arm emits normal armed signal");
  } else if (requests) {
    auto signals = api.take_signals();
    const auto state = api.state();
    const auto &counts = std::get<grc::rs::capture::Value::Object>(state.at("identity_failures").data);
    check(api.attachment() == grc::rs::capture::Attachment::Refused && !api.arm_pending() &&
          signals.size() == 1 && signals[0].name == "arm_failed" &&
          std::get<std::string>(signals[0].args[0].data) == reason &&
          std::get<std::int64_t>(counts.at(reason).data) == 1,
          "digest event fails both queued requests with a counted normal signal");
  }
  if (!requests && reason.empty()) {
    check(api.attachment() == grc::rs::capture::Attachment::Detached && !api.arm_pending(),
          "completion without attach keeps the capture detached");
    check(shadow.publish(grc::ShadowVtable::Table::Lean),
          "unrequested completion releases initial standby publication");
  }
  digest.shutdown(); event.clear();
  if (shadow.built()) { bool was_shadow = false, restored = false; shadow.disarm(&was_shadow, &restored); }
}
class Memory final : public grc::CalibMemoryReader {
 public:
  std::map<uint64_t, uint64_t> words;
  uint64_t bias = 0;
  Memory() {
    // Distinct RTTI, names, two primary tables, four slots plus sentinels.
    text(0x1100, "15RenderingServer"); text(0x1140, "22RenderingServerDefault");
    words[0x1200] = 0x9000; words[0x1208] = 0x1100;
    words[0x1240] = 0x9000; words[0x1248] = 0x1140; words[0x1250] = 0x1200;
    words[0x1300] = 0; words[0x1308] = 0x1200;
    words[0x1400] = 0; words[0x1408] = 0x1240;
    for (size_t i = 0; i < 4; ++i) {
      words[0x1310 + i * 8] = i == 2 ? 0 : 0x9000 + i * 16;
      words[0x1410 + i * 8] = 0x9000 + i * 16;
    }
    words[0x1330] = words[0x1430] = 0xdeadbeef;
  }
  void text(uint64_t addr, const std::string &s) {
    for (size_t i = 0; i <= s.size(); ++i) {
      auto &w = words[(addr + i) & ~uint64_t(7)];
      const unsigned shift = 8 * ((addr + i) & 7);
      w = (w & ~(uint64_t(255) << shift)) | (uint64_t(i == s.size() ? 0 : s[i]) << shift);
    }
  }
  grc::CalibWord read_u64(uint64_t address) const override {
    auto it = words.find(address);
    if (it == words.end()) return {};
    return {grc::CalibWord::value, it->second};
  }
  bool is_exec(uint64_t address) const override { return address >= 0x9000 && address < 0xa000; }
  std::vector<std::pair<uint64_t, uint64_t>> readonly_ranges() const override { return {{0x1000, 0x1500}}; }
  uint64_t load_bias() const override { return bias; }
};
grc::AbiTable table() {
  grc::AbiTable t;
  t.new_virtuals = {{"anchor_a", false}, {"hook", true}, {"anchor_b", false}};
  t.wanted_slots = {{"hook", 1}};
  return t;
}
bool same_checks(const std::vector<grc::CheckResult> &a, const std::vector<grc::CheckResult> &b) {
  if (a.size() != b.size()) return false;
  for (size_t i = 0; i < a.size(); ++i)
    if (a[i].name != b[i].name || a[i].ok != b[i].ok || a[i].detail != b[i].detail) return false;
  return true;
}
void test_worker_scan(int failure_phase) {
  install();
  Memory memory;
  auto abi = table();
  if (failure_phase == 1) memory.words[0x1408] = 0;
  if (failure_phase == 2) { memory.words[0x1480] = 0; memory.words[0x1488] = 0x1200; }
  if (failure_phase == 3) memory.words[0x1420] = 0;
  if (failure_phase == 4) abi.wanted_slots = {{"hook", 0}};
  grc::ProcessFingerprint fp;
  fp.platform = "linux-x86_64"; fp.version_string = "fixture release";
  fp.exe_sha256 = std::string(64, 'a'); fp.exe_path = "/fixture/godot";
  grc::Calibration identity;
  std::vector<grc::CheckResult> identity_checks;
  std::string error;
  check(grc::derive_live_identity(fp, true, &identity, &identity_checks, &error),
        "identity construction is engine-call free");
  auto expected = identity;
  auto expected_checks = identity_checks;
  std::string expected_error;
  const bool expected_ok = grc::derive_calibration(memory, 0x1410, abi, &expected,
                                                  &expected_checks, &expected_error);
  grc::IdentityDigest digest;
  grc::IdentityEvent event;
  std::promise<void> entered, release;
  auto started = entered.get_future(); auto ready = release.get_future();
  bool decided = false;
  std::string reason;
  const auto main = std::this_thread::get_id();
  check(event.prepare(digest, [&] {
    grc::ImageDigestResult result;
    if (!digest.result(&result)) return;
    decided = true;
    const auto &scan = result.scan;
    reason = scan.ok ? "" : "derive-failed";
    check(std::this_thread::get_id() == main && scan.attempted && scan.ok == expected_ok,
          "main consumes completed worker scan result");
    check(same_checks(scan.checks, expected_checks) && scan.error == expected_error,
          "worker and synchronous scan have identical checks, order and refusal detail");
    check(grc::serialize_derived_calibration(scan.calib, abi) ==
          grc::serialize_derived_calibration(expected, abi),
          "worker and synchronous scan serialize byte-identical records");
    check(scan.times.typeinfo_ns > 0 && (scan.times.abstract_ns > 0) == (failure_phase != 1),
          "worker scan retains reached phase timings");
  }), "scan completion event prepared");
  check(digest.start("windows-x86_64", "detached", [&] {
    const bool off_main = std::this_thread::get_id() != main;
    if (!off_main) throw std::runtime_error("image scan ran on main");
    entered.set_value(); ready.wait();
    grc::ImageDigestResult result;
    grc::StoppableCalibReader reader(memory, digest.stop_flag());
    grc::derive_live_scan(reader, 0x1410, abi, identity, &result.scan);
    result.scan.checks.insert(result.scan.checks.begin(), identity_checks.begin(), identity_checks.end());
    return result;
  }, [&] { event.post(); }), "scan starts on identity worker");
  started.wait();
  grc::ImageDigestResult pending;
  check(!digest.result(&pending) && !decided, "pending scan makes no decision");
  release.set_value(); flush();
  check(decided && reason == (failure_phase == 0 ? "" : "derive-failed"),
        "worker failure refuses derive-failed without fallback");
  digest.shutdown(); event.clear();
}

class BlockingScanReader final : public grc::CalibMemoryReader {
 public:
  mutable std::promise<void> entered;
  std::shared_future<void> release;
  mutable size_t reads = 0;
  Memory memory;
  grc::CalibWord read_u64(uint64_t addr) const override {
    if (addr == 0x1000) { entered.set_value(); release.wait(); }
    ++reads;
    return memory.read_u64(addr);
  }
  bool is_exec(uint64_t addr) const override { return memory.is_exec(addr); }
  std::vector<std::pair<uint64_t, uint64_t>> readonly_ranges() const override {
    // An unbounded-looking range proves cancellation ends the loop, rather than
    // continuing to read unmapped words to its end after the latch.
    return {{0x1000, UINT64_MAX - 7}};
  }
  uint64_t load_bias() const override { return 0; }
};
void test_shutdown_scan() {
  grc::IdentityDigest digest;
  BlockingScanReader memory;
  std::promise<void> release;
  memory.release = release.get_future().share();
  auto entered = memory.entered.get_future();
  int posts = 0;
  grc::LiveDeriveScan completed;
  check(digest.start("windows-x86_64", "detached", [&] {
    grc::ImageDigestResult result;
    grc::StoppableCalibReader reader(memory, digest.stop_flag());
    grc::derive_live_scan(reader, 0x1410, table(), {}, &result.scan);
    completed = result.scan;
    return result;
  }, [&] { ++posts; }), "shutdown scan starts");
  check(entered.wait_for(std::chrono::seconds(10)) == std::future_status::ready,
        "shutdown scan reaches abstract range traversal");
  // The test-only callback releases the blocked read after the real shutdown store.
  // Main still joins the provider through shutdown, with no polling or atomic wait.
  digest.after_stop_for_test = [&] {
    check(digest.stopped(), "shutdown latches cancellation before releasing the scan read");
    release.set_value();
  };
  digest.shutdown();
  digest.after_stop_for_test = {};
  grc::ImageDigestResult result;
  check(completed.attempted && !completed.ok && posts == 0 && !digest.result(&result),
        "shutdown joins active scan, discards result and posts nothing");
  check(memory.reads < 100 && digest.stopped(), "shutdown interrupts scan without traversing remaining ranges");
  grc::StoppableCalibReader stopped(memory, digest.stop_flag());
  check(stopped.read_u64(0x1410).kind == grc::CalibWord::unmapped,
        "stopped reader returns unmapped without a memory read");
}
void test_shutdown() {
  install();
  grc::IdentityDigest digest;
  grc::IdentityEvent event;
  int callbacks = 0;
  check(event.prepare(digest, [&] { ++callbacks; }), "shutdown event prepared");
  std::promise<void> release, entered;
  auto ready = release.get_future(); auto started = entered.get_future();
  bool exited = false;
  digest.start("windows-x86_64", "detached", [&] {
    entered.set_value(); ready.wait(); exited = true; return grc::ImageDigestResult{};
  }, [&] { event.post(); });
  started.wait();
  auto late = info;
  // Release from another thread: main must wait for the running provider only at shutdown.
  std::thread unblock([&] { release.set_value(); });
  digest.shutdown(); unblock.join();
  check(exited && digest.stopped(), "shutdown joins pending provider and latches");
  late.call_func(late.callable_userdata, nullptr, 0, nullptr, nullptr);
  check(callbacks == 0, "late event after shutdown is inert");
  digest.shutdown(); event.clear();
  { std::lock_guard<std::mutex> lock(queue_mutex); events.clear(); }
}
void test_deinit_queued() {
  install();
  grc::IdentityDigest digest;
  grc::IdentityEvent event;
  int callbacks = 0;
  check(event.prepare(digest, [&] { ++callbacks; }), "deinit event prepared");
  digest.start("windows-x86_64", "detached", [] { return grc::ImageDigestResult{}; }, [&] { event.post(); });
  {
    std::unique_lock<std::mutex> lock(queue_mutex);
    check(queued.wait_for(lock, std::chrono::seconds(10), [] { return !events.empty(); }),
          "event queued before defensive deinit");
  }
  digest.shutdown();
  const auto owner_id = info.object_id;
  event.clear();
  check(!fake::world().by_id.contains(owner_id), "deinit destroys Callable owner before module unload");
  flush();
  check(callbacks == 0, "MessageQueue skips event whose owner was destroyed");
}
void test_sync() {
  for (const auto *mode : {"arm", "standby", "validate"}) {
    grc::IdentityDigest startup;
    bool called = false;
    check(!startup.start("windows-x86_64", mode, [&] { called = true; return grc::ImageDigestResult{}; },
                         [&] { called = true; }) && !called, "non-detached Windows load stays synchronous");
  }
  grc::IdentityDigest digest;
  bool called = false;
  check(!digest.start("linux-x86_64", "detached", [&] { called = true; return grc::ImageDigestResult{}; },
                      [&] { called = true; }) && !called, "Linux never starts async provider or event");
#if defined(_WIN32)
  fake::install();
  grc::ProcessFingerprint fp; std::string error;
  check(grc::collect_fingerprint(&fp, &error, false) && !fp.image_sha256.empty(),
        "Windows startup collection returns the full image digest synchronously");
#elif defined(__linux__)
  // Exercise the real collector with the async request set: Linux still returns a full hash.
  fake::install();
  grc::ProcessFingerprint fp; std::string error;
  check(grc::collect_fingerprint(&fp, &error, true) && !fp.exe_sha256.empty() &&
      fp.platform == "linux-x86_64", "Linux collection stays synchronous");
#endif
}
}
int main() {
  test_digest("matched", true, "");
  test_digest("mismatch", true, "fingerprint-mismatch");
  test_digest("", false, "fingerprint-unavailable");
  test_digest("matched", true, "", true);
  test_digest("mismatch", true, "fingerprint-mismatch", true);
  test_digest("", false, "fingerprint-unavailable", true);
  test_digest("matched", true, "", true, 0x7ff600000000, 0x7ff600000000);
  test_digest("matched", true, "", true, 0x140000000, 0x7ff600000000);
  test_digest("matched", true, "fingerprint-unavailable", true, 0x150000000, 0x7ff600000000);
  test_digest("matched", true, "", true, 0x140000000, 0x140000000, true);
  test_digest("matched", true, "", false, 0x7ff600000000, 0x7ff600000000, true);
  for (int phase = 0; phase < 5; ++phase) test_worker_scan(phase);
  test_shutdown_scan();
  test_shutdown(); test_deinit_queued(); test_sync();
  std::printf("rs_identity_test: %d checks, %d failures\n", checks, failures);
  return failures ? 1 : 0;
}
