// Announced client tweens (render-stream/17). Engine-free validation and per-viewer delivery.
#pragma once
#include <array>
#include <cstdint>
#include <functional>
#include <map>
#include <optional>
#include <string>
#include <vector>
#include "rs_capture_api.h"

namespace grc::rs::tweens {
// Preserve Godot's Variant types: an Array is not a Vector2 or Color endpoint.
struct Vector2 { double x, y; };
struct Color { double r, g, b, a; };
struct Value {
  using Object = std::map<std::string, Value>;
  using Array = std::vector<Value>;
  using Data = std::variant<std::monostate, bool, std::int64_t, double, std::string,
                            Vector2, Color, Object, Array>;
  Data data;
  Value() = default;
  Value(int v) : data(std::int64_t(v)) {}
  template<class T> Value(T v) : data(std::move(v)) {}
  Value(const char *v) : data(std::string(v)) {}
};
enum class Kind { Node2D, Control };
struct Pose {
  std::uint32_t item = 0;
  Kind kind = Kind::Node2D;
  std::array<float, 16> f = {0,0,0,1,1,0,0,0,1,1,1,1,1,1,1,1};
};
// Empty reason means success. The production resolver checks the mirror's published item id.
using Resolve = std::function<std::string(std::uint64_t, Pose *)>;
struct Step {
  std::string property;
  std::uint64_t start_us = 0, duration_us = 0;
  int trans = 0, ease = 0;
  std::optional<std::vector<float>> from;
  std::vector<float> to;
  std::uint16_t claims = 0;
};
struct Event {
  bool cancel = false;
  std::int64_t id = 0;
  std::uint32_t item = 0;
  std::uint64_t order = 0, begin_us = 0, end_us = 0;
  std::vector<Step> steps;
};
struct Frame {
  std::uint64_t t_us = 0;
  std::map<std::uint32_t, Pose> poses;
};
struct Record {
  std::vector<Event> events;
  std::vector<Pose> poses;
  bool empty() const { return events.empty() && poses.empty(); }
};
struct Stats {
  std::uint64_t begins_accepted = 0, steps_accepted = 0, cancels_accepted = 0;
  std::uint64_t begins_dropped = 0, steps_dropped = 0, cancels_dropped = 0;
  std::uint64_t claims_replaced = 0, records_sent = 0, poses_sent = 0;
  std::map<std::string, std::uint64_t> drops_by_reason;
};
class Host {
 public:
  // Called only after a successful hello grant. Reset on resync, erase on disconnect.
  void grant(std::uint32_t connection);
  void leave(std::uint32_t connection);
  void resync(std::uint32_t connection);
  void reset() { *this = Host(); }
  bool on() const { return !viewers_.empty(); }
  void begin(const Value &value, std::uint64_t now_us, const Resolve &resolve);
  void cancel(const Value &id, std::uint64_t now_us);
  // Mark the announcing frame even when credit/rate gating skips the ordinary snapshot.
  void announce_frame(std::uint64_t t_us);
  // Main-thread snapshot: finalizes omitted start times and reads current components once.
  Frame snapshot(std::uint64_t t_us, const Resolve &resolve);
  // Called only when a transaction using this snapshot is actually selected for sending.
  Record take(std::uint32_t connection, const Frame &frame);
  void sent(const Record &record);
  const Stats &stats() const { return stats_; }
  capture::Value::Object state() const;
 private:
  struct Live {
    Event event;
    std::uint64_t object = 0;
    std::uint16_t claims = 0;
    bool implicit_start = false;
  };
  struct Pending { Event event; std::uint64_t announced_us; bool implicit_start; };
  struct Known {
    std::uint64_t object, end_us, announced_us, order;
    std::uint16_t claims;
    bool retired = false;
  };
  struct Viewer {
    std::vector<Pending> pending;
    std::map<std::uint32_t, std::map<std::int64_t, Known>> known;
  };
  void expire(std::uint64_t now_us);
  void drop(const char *scope, const std::string &reason);
  Stats stats_;
  std::uint64_t order_ = 0;
  std::map<std::int64_t, Live> live_;
  std::map<std::uint32_t, Viewer> viewers_;
};
std::vector<std::uint8_t> encode(const Record &record, std::uint64_t seq,
                                std::uint64_t frame, std::uint64_t t_us);
}  // namespace grc::rs::tweens
