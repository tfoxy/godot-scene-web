#include "rs_capture_api.h"

#include "rs_platform.h"

#include <chrono>
#include <stdexcept>
#include <utility>

namespace grc::rs::capture {
const char *state_name(State state) {
  switch (state) {
    case State::Loading: return "loading";
    case State::Standby: return "standby";
    case State::Arming: return "arming";
    case State::Armed: return "armed";
    case State::Ended: return "ended";
    case State::Disarming: return "disarming";
    case State::Refused: return "refused";
  }
  return "refused";
}
int Api::refuse(int code, const char *reason) {
  std::lock_guard<std::mutex> lock(mu_);
  last_refusal_ = reason;
  return code;
}
std::string Api::last_refusal() const {
  std::lock_guard<std::mutex> lock(mu_);
  return last_refusal_;
}
int Api::arm(const Value::Object &options, const Validator &validate) {
  if (std::this_thread::get_id() != main_) return refuse(2, "not-main-thread");
  called_.store(true, std::memory_order_relaxed);
  if (state_ == State::Refused) return refuse(2, "capture-refused");
  if (state_ != State::Standby) return refuse(44, "busy");
  Settings settings;
  static const std::vector<std::string> keys = {
      "GRC_ROOT_SIZE", "GRC_TEXTURE_DELIVERY", "GRC_TEXTURE_PENDING", "GRC_LIVE_CODING",
      "GRC_LIVE_MAX_CONNECTIONS", "GRC_LIVE_AWAIT_HELLO_MS", "GRC_LIVE_AWAIT_HELLOS"};
  for (const auto &[key, value] : options) {
    bool known = false;
    for (const auto &allowed : keys) known |= key == allowed;
    if (!known) {
      detail_ = key.starts_with("GRC_") ? key + " is per load" : "unknown option";
      return refuse(31, "arm-config-invalid");
    }
    if (const auto *s = std::get_if<std::string>(&value.data)) settings[key] = *s;
    else if (const auto *i = std::get_if<std::int64_t>(&value.data)) settings[key] = std::to_string(*i);
    else {
      detail_ = key + " must be a String or int";
      return refuse(31, "arm-config-invalid");
    }
  }
  if (validate && !validate(settings, &detail_)) return refuse(31, "arm-config-invalid");
  settings_ = std::move(settings);
  pending_arm_ = true;
  state_ = State::Arming;
  return 0;
}
int Api::disarm(const Value::Object &options) {
  if (std::this_thread::get_id() != main_) return refuse(2, "not-main-thread");
  called_.store(true, std::memory_order_relaxed);
  if (state_ == State::Disarming) return refuse(44, "busy");
  if (state_ == State::Loading || state_ == State::Standby || state_ == State::Refused)
    return refuse(3, "not-armed");
  DisarmOptions parsed;
  for (const auto &[key, value] : options) {
    if (key == "reason") {
      const auto *s = std::get_if<std::string>(&value.data);
      if (!s || s->empty() || s->size() > 64) return refuse(31, "disarm-config-invalid");
      parsed.reason = *s;
    } else if (key == "linger_ms") {
      const auto *i = std::get_if<std::int64_t>(&value.data);
      if (!i || *i < 0 || *i > 10000) return refuse(31, "disarm-config-invalid");
      parsed.linger_ms = *i;
    } else return refuse(31, "disarm-config-invalid");
  }
  disarm_ = std::move(parsed);
  if (state_ == State::Arming) {
    pending_arm_ = false;
    settings_.clear();
    state_ = State::Standby;
    queue({"disarmed", {Value::Object{{"arm_index", 0}, {"reason", disarm_.reason},
                                    {"published", 0}, {"clients_served", 0}}}});
  } else {
    schedule_disarm(disarm_);
  }
  return 0;
}
Value::Object Api::state(std::uint64_t frame, Value::Object registry) const {
  if (std::this_thread::get_id() != main_) return {{"error", "not-main-thread"}};
  called_.store(true, std::memory_order_relaxed);
  Value::Object out{{"state", state_name(state_)}, {"arm_count", std::int64_t(arm_count_)},
                    {"can_arm", can_arm()}, {"clients", clients_}, {"last_reason", last_reason_},
                    {"last_refusal", last_refusal()}, {"frame", std::int64_t(frame)},
                    {"registry", std::move(registry)}};
  if (state_ == State::Armed || state_ == State::Ended || state_ == State::Disarming) {
    for (const char *key : {"listen", "token", "wt_cert_hash", "root_size", "stream_version"}) {
      const auto it = info_.find(key);
      if (it != info_.end()) out[key] = it->second;
    }
  }
  return out;
}
void Api::loaded(State state, std::string reason) {
  state_ = state;
  last_reason_ = std::move(reason);
}
Settings Api::arm_point() {
  pending_arm_ = false;
  ++arm_count_;
  clients_ = clients_served_ = 0;
  return std::move(settings_);
}
void Api::armed(Value::Object info, bool notify) {
  state_ = State::Armed;
  info_ = std::move(info);
  info_["arm_index"] = std::int64_t(arm_count_);
  if (notify) queue({"armed", {info_}});
}
void Api::arm_failed(std::string reason) {
  state_ = State::Standby;
  last_reason_ = reason;
  queue({"arm_failed", {std::move(reason)}});
}
void Api::stream_ended(std::string reason) {
  if (state_ != State::Armed) return;
  state_ = State::Ended;
  last_reason_ = reason;
  queue({"stream_ended", {std::move(reason)}});
}
void Api::schedule_disarm(DisarmOptions options) {
  disarm_ = std::move(options);
  pending_disarm_ = true;
  state_ = State::Disarming;
}
void Api::disarm_point() { pending_disarm_ = false; }
void Api::disarmed(std::uint64_t published) {
  state_ = State::Standby;
  last_reason_ = disarm_.reason;
  queue({"disarmed", {Value::Object{{"arm_index", std::int64_t(arm_count_)},
      {"reason", disarm_.reason}, {"published", std::int64_t(published)},
      {"clients_served", clients_served_}}}});
}
void Api::client_connected(std::int64_t connection, Value::Object info) {
  ++clients_;
  ++clients_served_;
  queue({"client_connected", {connection, std::move(info)}});
}
void Api::client_left(std::int64_t connection, std::string reason) {
  --clients_;
  queue({"client_left", {connection, std::move(reason)}});
}
void Api::queue(Signal signal) {
  std::lock_guard<std::mutex> lock(mu_);
  signals_.push_back(std::move(signal));
  any_.store(true, std::memory_order_relaxed);
}
std::vector<Signal> Api::take_signals() {
  if (!any()) return {};
  std::lock_guard<std::mutex> lock(mu_);
  std::vector<Signal> out;
  out.swap(signals_);
  any_.store(false, std::memory_order_relaxed);
  return out;
}
namespace {
std::uint64_t now_ns() {
  return std::chrono::duration_cast<std::chrono::nanoseconds>(
      std::chrono::steady_clock::now().time_since_epoch()).count();
}
}
TeardownThread::~TeardownThread() { join(); }
void TeardownThread::run(std::function<void()> fn, bool inline_on_main) {
  if (!done()) throw std::logic_error("teardown already running");
  join();
  ran = true;
  on_main = inline_on_main;
  start_ns = now_ns();
  done_.store(false, std::memory_order_relaxed);
  auto work = [this, fn = std::move(fn)] {
    fn();
    ms = double(now_ns() - start_ns) / 1e6;
    done_.store(true, std::memory_order_release);
  };
  if (inline_on_main) work();
  else {
    thread_ = std::thread([work = std::move(work)] {
      set_current_thread_name("grc-teardown");
      work();
    });
  }
}
void TeardownThread::join() { if (thread_.joinable()) thread_.join(); }
Value::Object teardown_join_info(const TeardownThread &thread, bool pending,
                                bool encoders_pending) {
  return {{"ran", thread.ran}, {"on_main", thread.on_main},
          {"ms", pending || encoders_pending ? 0.0 : thread.ms}};
}
}  // namespace grc::rs::capture
