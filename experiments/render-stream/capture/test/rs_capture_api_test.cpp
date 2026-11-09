#include "rs_capture_api.h"

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
  std::printf("rs_capture_api_test: %d checks, %d failures\n", checks, failures);
  return failures ? 1 : 0;
}
