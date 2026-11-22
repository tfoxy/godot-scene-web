// Announced client tweens (render-stream/17). Engine-free validation and per-viewer delivery.
#pragma once
#include <array>
#include <cstdint>
#include <functional>
#include <map>
#include <optional>
#include <set>
#include <string>
#include <vector>
#include "rs_capture_api.h"
#include "rs2_snapshot.h"

namespace grc::rs::tweens {
// Preserve Godot's Variant types: an Array is not a Vector2 or Color endpoint.
struct Vector2 { double x, y; };
struct Vector3 { double x, y, z; };
struct Vector4 { double x, y, z, w; };
struct Color { double r, g, b, a; };
struct Value {
  using Object = std::map<std::string, Value>;
  using Array = std::vector<Value>;
  using Data = std::variant<std::monostate, bool, std::int64_t, double, std::string,
                            Vector2, Vector3, Vector4, Color, Object, Array>;
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
  // Host-only announce-time context; never serialized in a pose or record.
  std::array<double, 6> parent_global = {1,0,0,1,0,0};
  bool global_position_supported = true;
  std::array<float, 16> f = {0,0,0,1,1,0,0,0,1,1,1,1,1,1,1,1};
};
// Empty reason means published; "pending-item" supplies API context for a tracked unpublished item.
using Resolve = std::function<std::string(std::uint64_t, Pose *)>;
// Copied from the mirror on the Godot main thread. No engine objects cross into encoding.
struct Material {
  std::uint32_t id = 0, shader = 0;
  std::uint64_t shader_version = 0;
  bool published = true;
  bool supported = false;
  std::map<std::string, rs2::Param> params;
};
// Classify CanvasItems as "node"; "pending-material" supplies a tracked unpublished material.
// Check the material-version gate before looking up params.
using ResolveMaterial = std::function<std::string(std::uint64_t, Material *, bool)>;
using Claims = std::map<std::string, std::uint16_t>;
using Target = std::pair<bool, std::uint32_t>;  // material vs item, then stream id
struct Step {
  std::string property;
  std::string param;
  rs2::VariantType type = rs2::VariantType::Nil;
  int component = -1;
  std::uint64_t start_us = 0, duration_us = 0;
  int trans = 0, ease = 0;
  std::optional<std::vector<float>> from;
  std::vector<float> to;
  std::uint16_t claims = 0;
};
struct Event {
  bool cancel = false;
  std::int64_t id = 0;
  std::uint32_t item = 0, material = 0;
  std::uint32_t shader = 0;
  std::uint64_t shader_version = 0;
  std::uint64_t order = 0, begin_us = 0, end_us = 0;
  std::vector<Step> steps;
};
struct Frame {
  std::uint64_t t_us = 0;
  std::map<std::uint32_t, Pose> poses;
  std::map<std::uint32_t, Material> materials;
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
  std::uint64_t material_begins_accepted = 0, material_steps_accepted = 0, material_tweens_retired = 0;
  std::map<std::string, std::uint64_t> material_events_filtered_by_version;
  std::map<std::string, std::uint64_t> drops_by_reason;
};
class Host {
 public:
  // Called only after a successful hello grant. Reset on resync, erase on disconnect.
  void grant(std::uint32_t connection, rs2::ProtocolVersion version = rs2::ProtocolVersion::V17);
  void leave(std::uint32_t connection);
  void resync(std::uint32_t connection);
  void reset() { *this = Host(); }
  bool on() const { return !viewers_.empty(); }
  void begin(const Value &value, std::uint64_t now_us, const Resolve &resolve,
             const ResolveMaterial &materials = {});
  void cancel(const Value &id, std::uint64_t now_us);
  // Observe live material claims even on frames omitted by credit/rate coalescing.
  void observe_materials(std::uint64_t t_us, const ResolveMaterial &materials);
  // Mark the announcing frame even when credit/rate gating skips the ordinary snapshot.
  void announce_frame(std::uint64_t t_us);
  // Main-thread snapshot: finalizes omitted start times and reads current components once.
  Frame snapshot(std::uint64_t t_us, const Resolve &resolve,
             const ResolveMaterial &materials = {});
  // Called only when a transaction using this snapshot is actually selected for sending.
  Record take(std::uint32_t connection, const Frame &frame);
  void sent(const Record &record);
  const Stats &stats() const { return stats_; }
  capture::Value::Object state(bool material_fields = true) const;
 private:
  using Generation = std::pair<std::int64_t, std::uint64_t>;
  using Transfers = std::map<Generation, Claims>;
  struct Live {
    Event event;
    std::optional<std::set<std::uint32_t>> eligible;
    std::uint64_t object = 0, announced_us = 0;
    Claims claims;
    bool associated = false;
    bool implicit_start = false;
  };
  struct Pending {
    Event event;
    std::uint64_t announced_us;
    bool implicit_start;
    // Per-viewer claim moves still awaiting a delivered begin, including ancestors
    // of replacements that were cancelled or superseded before association.
    Transfers taken_from;
  };
  struct Known {
    std::uint64_t object, end_us, announced_us, order;
    Claims claims;
    bool retired = false;
  };
  struct Viewer {
    rs2::ProtocolVersion version = rs2::ProtocolVersion::V17;
    std::vector<Pending> pending;
    std::map<Target, std::map<std::int64_t, Known>> known;
    std::set<std::uint64_t> suppressed;
  };
  void accept(Live live, std::uint64_t now_us);
  void expire(std::uint64_t now_us);
  void release_unobserved_materials();
  void filter_material_event();
  void retire(std::int64_t id, std::uint64_t now_us);
  void associate(Event &event, const Frame &frame, Viewer &viewer);
  void drop(const char *scope, const std::string &reason);
  Stats stats_;
  std::uint64_t order_ = 0;
  // API-validated creation-frame begins, resolved once at the next main-thread snapshot.
  std::vector<Live> publication_;
  std::map<std::int64_t, Live> live_;
  std::map<std::uint32_t, Viewer> viewers_;
};
std::vector<std::uint8_t> encode(const Record &record, std::uint64_t seq,
                                std::uint64_t frame, std::uint64_t t_us);
}  // namespace grc::rs::tweens
