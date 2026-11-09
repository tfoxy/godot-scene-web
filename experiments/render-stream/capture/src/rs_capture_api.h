#ifndef GRC_RS_CAPTURE_API_H
#define GRC_RS_CAPTURE_API_H

#include <atomic>
#include <cstdint>
#include <functional>
#include <map>
#include <mutex>
#include <string>
#include <thread>
#include <variant>
#include <vector>

#include "rs_setting.h"

namespace grc::rs::capture {
// Owned, engine-free values for method arguments, state dictionaries and queued signals.
struct Value {
  using Object = std::map<std::string, Value>;
  using Array = std::vector<Value>;
  using Data = std::variant<std::monostate, bool, std::int64_t, double, std::string, Object, Array>;
  Data data;
  Value() = default;
  Value(bool v) : data(v) {}
  Value(int v) : data(std::int64_t(v)) {}
  Value(std::int64_t v) : data(v) {}
  Value(double v) : data(v) {}
  Value(const char *v) : data(std::string(v)) {}
  Value(std::string v) : data(std::move(v)) {}
  Value(Object v) : data(std::move(v)) {}
  Value(Array v) : data(std::move(v)) {}
};
enum class State { Loading, Standby, Arming, Armed, Ended, Disarming, Refused };
const char *state_name(State state);
struct Signal {
  std::string name;
  Value::Array args;
};
struct DisarmOptions {
  std::string reason = "disarm";
  std::int64_t linger_ms = 1500;
};

// All state transitions are main-thread only. Off-main methods touch only last_refusal, under
// the leaf mutex. Validation of setting values belongs to entry.cpp's existing policy parsers.
class Api {
 public:
  using Validator = std::function<bool(const Settings &, std::string *)>;
  explicit Api(std::thread::id main = std::this_thread::get_id()) : main_(main) {}
  int arm(const Value::Object &options = {}, const Validator &validate = {});
  int disarm(const Value::Object &options = {});
  Value::Object state(std::uint64_t frame = 0, Value::Object registry = {}) const;
  std::string last_refusal() const;
  bool called() const { return called_.load(std::memory_order_relaxed); }
  bool can_arm() const { return state_ == State::Standby; }
  State phase() const { return state_; }
  std::uint64_t arm_count() const { return arm_count_; }
  const std::string &last_reason() const { return last_reason_; }
  const std::string &detail() const { return detail_; }
  const DisarmOptions &pending_disarm() const { return disarm_; }
  bool arm_pending() const { return pending_arm_; }
  bool disarm_pending() const { return pending_disarm_; }
  void loaded(State state, std::string reason = {});
  // Consumes the scheduled arm at the frame boundary; cancellation does not consume an arm.
  Settings arm_point();
  void armed(Value::Object info, bool notify = true);
  void arm_failed(std::string reason);
  void stream_ended(std::string reason);
  // Internal env scheduling does not count as an API invocation.
  void schedule_disarm(DisarmOptions options);
  void disarm_point();
  void disarmed(std::uint64_t published);
  void client_connected(std::int64_t connection, Value::Object info);
  void client_left(std::int64_t connection, std::string reason);
  void queue(Signal signal);
  // Empty standby costs one relaxed load. Never emit while holding the leaf lock.
  bool any() const { return any_.load(std::memory_order_relaxed); }
  std::vector<Signal> take_signals();

 private:
  int refuse(int code, const char *reason);
  const std::thread::id main_;
  mutable std::mutex mu_;
  std::string last_refusal_;
  mutable std::atomic<bool> called_{false};
  std::atomic<bool> any_{false};
  std::vector<Signal> signals_;
  State state_ = State::Loading;
  std::uint64_t arm_count_ = 0;
  std::int64_t clients_ = 0;
  std::int64_t clients_served_ = 0;
  std::string last_reason_;
  std::string detail_;
  Value::Object info_;
  Settings settings_;
  DisarmOptions disarm_;
  bool pending_arm_ = false;
  bool pending_disarm_ = false;
};

// The worker function performs pure joins only. Read timing after join(); poll done with acquire.
// One instance serves every teardown of a process: run() after join() starts the next one.
class TeardownThread {
 public:
  ~TeardownThread();
  void run(std::function<void()> fn, bool inline_on_main = false);
  bool done() const { return done_.load(std::memory_order_acquire); }
  void join();
  bool ran = false;
  bool on_main = false;
  std::uint64_t start_ns = 0;
  double ms = 0;
 private:
  std::thread thread_;
  std::atomic<bool> done_{true};
};
// The pool thread is reused by encoders; neither pending phase may expose worker-owned timing.
Value::Object teardown_join_info(const TeardownThread &thread, bool pending,
                                bool encoders_pending = false);
}  // namespace grc::rs::capture
#endif
