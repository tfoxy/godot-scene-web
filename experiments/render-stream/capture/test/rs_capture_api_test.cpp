#include "rs_capture_api.h"
#include "rs_hook_admission.h"

#include <atomic>
#include <cstdio>
#include <thread>

using namespace grc::rs::capture;
namespace {
int checks = 0, failures = 0;
void check(bool ok, const char *what) {
  ++checks;
  if (!ok) { ++failures; std::fprintf(stderr, "FAIL %s\n", what); }
}
void refusal(Api &api, bool arm, int code, const char *reason, Value::Object options = {}) {
  const State before = api.phase();
  const std::string last = api.last_reason();
  check((arm ? api.arm(options) : api.disarm(options)) == code, "refusal code");
  check(api.last_refusal() == reason, "refusal reason");
  check(api.phase() == before && api.last_reason() == last, "refusal preserves state and reason");
  check(!api.any(), "refusal emits nothing");
}
void test_env_disarm() {
  Api api;
  api.loaded(State::Armed);
  api.schedule_disarm({"frame", 1500});
  check(!api.called(), "environment disarm is not an API call");
  check(api.phase() == State::Disarming && api.disarm_pending() &&
      api.pending_disarm().reason == "frame" && api.pending_disarm().linger_ms == 1500,
      "environment disarm uses the same pending request");
  api.disarm_point();
  api.disarmed(3);
  check(!api.called() && api.phase() == State::Standby && !api.disarm_pending(),
      "environment completion preserves absent API evidence");
}
void test_refusals() {
  for (State state : {State::Loading, State::Arming, State::Armed, State::Ended, State::Disarming}) {
    Api api;
    api.loaded(state, "preserved");
    refusal(api, true, 44, "busy", {{"bad", true}});
  }
  for (State state : {State::Standby, State::Loading, State::Refused}) {
    Api api;
    api.loaded(state, "preserved");
    refusal(api, false, 3, "not-armed", {{"bad", true}});
  }
  Api refused;
  refused.loaded(State::Refused, "load failure");
  refusal(refused, true, 2, "capture-refused", {{"bad", true}});
  Api busy;
  busy.loaded(State::Disarming);
  refusal(busy, false, 44, "busy", {{"bad", true}});
  Api api;
  api.loaded(State::Standby);
  for (const auto &options : std::vector<Value::Object>{
      {{"GRC_STREAM_VERSION", "9"}}, {{"unknown", "1"}},
      {{"GRC_LIVE_MAX_CONNECTIONS", Value::Array{2}}}, {{"GRC_ROOT_SIZE", true}}})
    refusal(api, true, 31, "arm-config-invalid", options);
  bool validated = false;
  check(api.arm({{"GRC_ROOT_SIZE", "banana"}}, [&](const auto &, auto *detail) {
    validated = true; *detail = "invalid root size"; return false;
  }) == 31 && validated && !api.any() && api.can_arm(), "value validator refusal");
  for (State state : {State::Arming, State::Armed, State::Ended}) {
    Api disarm;
    disarm.loaded(state);
    for (const auto &options : std::vector<Value::Object>{
        {{"reason", ""}}, {{"reason", std::string(65, 'x')}}, {{"reason", 2}},
        {{"linger_ms", -1}}, {{"linger_ms", 10001}}, {{"linger_ms", "1"}},
        {{"linger_ms", true}}, {{"foo", 1}}})
      refusal(disarm, false, 31, "disarm-config-invalid", options);
  }
  for (State state : {State::Loading, State::Standby, State::Refused, State::Disarming}) {
    Api threaded;
    threaded.loaded(state, "preserved");
    std::thread worker([&] {
      refusal(threaded, true, 2, "not-main-thread", {{"bad", true}});
      refusal(threaded, false, 2, "not-main-thread", {{"bad", true}});
      auto snapshot = threaded.state();
      check(snapshot.size() == 1 && std::get<std::string>(snapshot.at("error").data) ==
          "not-main-thread", "off-main snapshot");
    });
    worker.join();
  }
}
void test_lifecycle() {
  Api api;
  check(!api.called() && !api.can_arm() && api.phase() == State::Loading, "initial loading");
  api.loaded(State::Standby);
  check(api.arm({{"GRC_LIVE_MAX_CONNECTIONS", 2}, {"GRC_ROOT_SIZE", ""}}) == 0 &&
      api.arm_pending() && api.phase() == State::Arming && !api.any(), "arm schedules only");
  check(api.disarm() == 0 && !api.arm_pending() && api.can_arm() && api.arm_count() == 0,
      "cancel preserves first arm");
  auto signals = api.take_signals();
  check(signals.size() == 1 && signals[0].name == "disarmed" &&
      std::get<std::int64_t>(std::get<Value::Object>(signals[0].args[0].data).at("arm_index").data) == 0,
      "cancel payload arm index zero");
  check(!api.any() && api.take_signals().empty(), "drain clears relaxed flag");
  // Environment deferral has no API pending arm to cancel.
  api.loaded(State::Arming);
  check(api.disarm() == 0 && api.can_arm(), "environment deferral cancel");
  api.take_signals();
  check(api.arm({{"GRC_LIVE_MAX_CONNECTIONS", 2}, {"GRC_ROOT_SIZE", ""}}) == 0, "arm accepted");
  auto settings = api.arm_point();
  check(settings.at("GRC_LIVE_MAX_CONNECTIONS") == "2" && settings.at("GRC_ROOT_SIZE").empty() &&
      api.arm_count() == 1 && !api.arm_pending(), "arm point normalizes settings and consumes arm");
  api.armed({{"listen", "127.0.0.1:1234"}, {"token", ""}, {"wt_cert_hash", ""},
      {"root_size", "640x360"}, {"stream_version", 8}});
  check(api.phase() == State::Armed && api.any(), "armed queues signal");
  api.client_connected(1, {{"carrier", "ws"}});
  api.client_connected(2, {{"carrier", "gd"}});
  api.client_left(2, "hello-timeout");
  auto snapshot = api.state(42, {{"texture", Value::Object{{"entries", 1}}}});
  check(std::get<std::int64_t>(snapshot.at("clients").data) == 1 &&
      std::get<std::int64_t>(snapshot.at("frame").data) == 42 && snapshot.contains("registry") &&
      std::get<std::string>(snapshot.at("root_size").data) == "640x360", "active snapshot");
  api.stream_ended("budget");
  api.stream_ended("duplicate");
  check(api.phase() == State::Ended && api.last_reason() == "budget", "ended deduped");
  signals = api.take_signals();
  check(signals.size() == 5 && signals.front().name == "armed" &&
      signals.back().name == "stream_ended", "six signal vocabulary, queued FIFO");
  check(api.disarm({{"reason", "fixture"}, {"linger_ms", 0}}) == 0 && api.disarm_pending() &&
      api.phase() == State::Disarming && api.pending_disarm().linger_ms == 0, "disarm schedules");
  refusal(api, true, 44, "busy");
  refusal(api, false, 44, "busy");
  api.disarm_point();
  check(!api.disarm_pending(), "disarm point consumes request");
  api.client_left(1, "fixture");
  api.disarmed(7);
  signals = api.take_signals();
  const auto &info = std::get<Value::Object>(signals.back().args[0].data);
  check(signals.size() == 2 && signals.back().name == "disarmed" &&
      std::get<std::int64_t>(info.at("published").data) == 7 &&
      std::get<std::int64_t>(info.at("clients_served").data) == 2 &&
      std::get<std::string>(info.at("reason").data) == "fixture", "disarmed payload");
  check(api.phase() == State::Standby && api.can_arm() && !api.state().contains("listen"),
      "disarmed standby can rearm, hides session");
  refusal(api, false, 3, "not-armed");
  check(api.arm({{"GRC_ROOT_SIZE", std::string("observe")}}) == 0 && api.phase() == State::Arming &&
      api.arm_pending(), "re-arm schedules");
  {
    const auto second = api.arm_point();
    api.armed({{"listen", std::string("127.0.0.1:2")}});
    signals = api.take_signals();
    const auto &again = std::get<Value::Object>(signals.back().args[0].data);
    check(second.at("GRC_ROOT_SIZE") == "observe" && api.arm_count() == 2 &&
        std::get<std::int64_t>(again.at("arm_index").data) == 2 &&
        api.state().contains("listen"), "re-arm counts its index");
  }
  Api failed;
  failed.loaded(State::Standby);
  failed.arm();
  failed.arm_point();
  failed.arm_failed("listen-bind");
  signals = failed.take_signals();
  check(failed.phase() == State::Standby && failed.can_arm() && failed.last_reason() == "listen-bind" &&
      signals.size() == 1 && signals[0].name == "arm_failed", "arm failure standby");
  refusal(failed, false, 3, "not-armed");
  check(failed.arm() == 0 && failed.phase() == State::Arming, "arm after a failed arm schedules");
  Api silent;
  silent.loaded(State::Standby);
  silent.arm();
  silent.arm_point();
  silent.armed({{"root_size", "640x360"}}, false);
  check(silent.phase() == State::Armed && !silent.any() &&
      std::get<std::string>(silent.state().at("root_size").data) == "640x360",
      "suppressed armed notification still installs active state and session info");
  Api defaults;
  defaults.loaded(State::Armed);
  check(defaults.disarm() == 0 && defaults.pending_disarm().reason == "disarm" &&
      defaults.pending_disarm().linger_ms == 1500, "disarm defaults");
  Api boundaries;
  boundaries.loaded(State::Armed);
  check(boundaries.disarm({{"reason", std::string(64, 'x')}, {"linger_ms", 10000}}) == 0,
      "disarm inclusive bounds");
}
void test_attachment() {
  Api api;
  api.loaded(State::Standby);
  int stops = 0, starts = 0;
  auto stop = [&] {
    ++stops;
    check(api.attachment() == Attachment::Detaching && !api.can_arm(), "detaching admission closed");
    check(api.arm() == 3 && api.last_refusal() == "capture-detached", "arm during detach refused");
    check(api.attach() == 44 && api.detach() == 44, "reentrant transitions busy");
    return true;
  };
  auto start = [&] {
    ++starts;
    check(api.attachment() == Attachment::Attaching && !api.can_arm(), "attaching admission closed");
    return true;
  };
  check(api.attach({}, start) == 0 && starts == 0, "attached idempotence");
  check(api.detach({}, stop) == 0 && stops == 1 && api.attachment() == Attachment::Detached,
      "detach completes synchronously");
  check(!api.can_arm() && api.arm() == 3 && api.last_refusal() == "capture-detached",
      "arm while detached refused");
  check(std::get<std::string>(api.state().at("attachment_state").data) == "detached" &&
      api.phase() == State::Standby, "attachment and stream state separate");
  check(api.detach({}, stop) == 0 && stops == 1, "detached idempotence");
  check(api.attach({{"bad", 1}}, start) == 31 && starts == 0, "attach rejects options");
  check(api.attach({}, start) == 0 && starts == 1 && api.can_arm(), "attach completes synchronously");
  check(api.detach({{"bad", 1}}, stop) == 31 && stops == 1, "detach rejects options");
  api.arm(); api.arm_point(); api.armed({}); api.take_signals();
  check(api.detach({}, stop) == 44 && api.last_refusal() == "detach-while-armed" && stops == 1,
      "detach while armed refuses without teardown");
  api.stream_ended("budget");
  check(api.detach({}, stop) == 44, "ended stream still needs disarm");
  api.disarm();
  check(api.detach({}, stop) == 44, "pending teardown busy");
  api.disarm_point(); api.disarmed(0); api.take_signals();
  check(api.detach({}, stop) == 0 && api.attach({}, start) == 0 && starts == 2 && stops == 2,
      "second full lifecycle");
  std::thread offmain([&] {
    check(api.detach() == 2 && api.last_refusal() == "not-main-thread", "off-main detach");
    check(api.attach() == 2 && api.last_refusal() == "not-main-thread", "off-main attach");
  });
  offmain.join();
  check(api.detach({}, [] { return false; }) == 2 && api.attachment() == Attachment::Refused &&
      !api.can_arm(), "failed teardown cannot report detached");
  check(api.detach() == 0, "refused detach can retry cleanup");
  check(api.attach({}, [] { return false; }) == 2 && api.attachment() == Attachment::Refused,
      "failed rebuild cannot report attached");
}
void test_attachment_admission() {
  grc::HookAdmission admission;
  std::atomic<bool> entered{false}, release{false};
  std::thread standby([&] {
    grc::HookAdmission::Reader reader(admission);
    check(bool(reader), "standby reader admitted");
    entered.store(true, std::memory_order_release);
    while (!release.load(std::memory_order_acquire)) std::this_thread::yield();
  });
  while (!entered.load(std::memory_order_acquire)) std::this_thread::yield();
  admission.close();
  check(!admission.drained(), "detach waits for standby reader");
  {
    grc::HookAdmission::Reader delayed(admission);
    check(!delayed, "cached thunk cannot enter closed attachment");
  }
  release.store(true, std::memory_order_release);
  standby.join();
  check(admission.drained(), "all admitted standby work drained");
  admission.close();
  check(admission.drained(), "shutdown while detached is idempotent");
  admission.open();
  { grc::HookAdmission::Reader reattached(admission); check(bool(reattached), "fresh admission"); }
  admission.close();
  check(admission.drained(), "shutdown after reattach drains");
}
void test_attachment_shutdown() {
  {
    Api api;
    api.loaded(State::Standby);
    int cleanups = 0;
    const auto cleanup = [&] { ++cleanups; return true; };
    check(api.detach({}, cleanup) == 0, "shutdown detached setup");
    check(api.shutdown(cleanup) && api.shutdown(cleanup) && cleanups == 1,
        "shutdown while detached does not release twice");
    check(api.attachment() == Attachment::Detached && !api.can_arm(), "shutdown stays detached");
    check(api.attach({}, cleanup) == 2 && cleanups == 1 &&
        api.last_refusal() == "capture-shutdown", "shutdown cannot reattach");
    check(api.arm() == 2 && api.disarm() == 2 && api.detach() == 2,
        "shutdown refuses stream and attachment calls");
  }
  {
    Api api;
    api.loaded(State::Standby);
    grc::HookAdmission admission;
    TeardownThread worker;
    std::atomic<bool> release{false}, joined{false};
    worker.run([&] {
      while (!release.load(std::memory_order_acquire)) std::this_thread::yield();
      joined.store(true, std::memory_order_release);
    });
    int cleanups = 0;
    check(api.detach({}, [&] {
      ++cleanups;
      admission.close();
      check(api.shutdown([&] { ++cleanups; return true; }), "shutdown during detach");
      check(api.attachment() == Attachment::Detaching && !api.can_arm(),
          "shutdown leaves in-progress cleanup owned by detach");
      check(api.attach() == 2 && api.arm() == 2, "shutdown cannot interrupt teardown");
      release.store(true, std::memory_order_release);
      worker.join();
      return admission.drained() && joined.load(std::memory_order_acquire);
    }) == 0, "detaching shutdown joins worker before detached");
    check(api.attachment() == Attachment::Detached && cleanups == 1 &&
        api.shutdown([&] { ++cleanups; return true; }) && cleanups == 1,
        "shutdown and deinitialize after detaching remain idempotent");
  }
  {
    Api api;
    api.loaded(State::Standby);
    api.arm(); api.arm_point(); api.armed({});
    int cleanups = 0;
    check(api.shutdown([&] {
      ++cleanups;
      check(api.attachment() == Attachment::Detaching && !api.can_arm(),
          "armed shutdown closes attachment admission");
      return true;
    }) && cleanups == 1 && api.attachment() == Attachment::Detached,
        "engine shutdown can clean an armed capture");
    bool offmain = true;
    std::thread thread([&] { offmain = api.shutdown({}); });
    thread.join();
    check(!offmain, "off-main shutdown refused");
  }
}
void test_teardown() {
  {
    TeardownThread thread;
    thread.ms = 17.0;  // timing retained from the previous pool phase
    for (const auto &[pool_pending, encoders_pending] :
         {std::pair{true, false}, std::pair{false, true}, std::pair{false, false}}) {
      const auto snapshot = teardown_join_info(thread, pool_pending, encoders_pending);
      check(std::get<double>(snapshot.at("ms").data) ==
                (pool_pending || encoders_pending ? 0.0 : 17.0),
            "pending pool or encoder phase hides unjoined worker timing");
    }
  }
  const auto main = std::this_thread::get_id();
  for (bool inline_on_main : {false, true}) {
    TeardownThread teardown;
    std::atomic<bool> entered{false}, release{inline_on_main};
    std::thread::id caller;
    teardown.run([&] {
      caller = std::this_thread::get_id();
      entered.store(true, std::memory_order_release);
      while (!release.load(std::memory_order_acquire)) std::this_thread::yield();
    }, inline_on_main);
    while (!entered.load(std::memory_order_acquire)) std::this_thread::yield();
    if (!inline_on_main) check(!teardown.done(), "join job stays pending until released");
    release.store(true, std::memory_order_release);
    while (!teardown.done()) std::this_thread::yield();
    teardown.join();
    check(teardown.ran && teardown.on_main == inline_on_main &&
        (caller == main) == inline_on_main && teardown.start_ns > 0 && teardown.ms >= 0,
        "inline and threaded teardown completion and timing");
    teardown.join();
  }
  bool joined = false;
  { TeardownThread teardown; teardown.run([&] { joined = true; }); }
  check(joined, "destruction joins worker");
  {
    // One instance serves every teardown of a process.
    TeardownThread teardown;
    int runs = 0;
    for (int i = 0; i < 3; ++i) {
      teardown.run([&] { ++runs; });
      while (!teardown.done()) std::this_thread::yield();
      teardown.join();
    }
    check(runs == 3 && teardown.ran, "teardown thread reruns after join");
  }
}
}
int main() {
  test_env_disarm();
  test_refusals();
  test_lifecycle();
  test_teardown();
  test_attachment();
  test_attachment_admission();
  test_attachment_shutdown();
  std::printf("rs_capture_api_test: %d checks, %d failures\n", checks, failures);
  return failures ? 1 : 0;
}
