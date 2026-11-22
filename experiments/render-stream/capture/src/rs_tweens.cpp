#include "rs_tweens.h"
#include "rs2_snapshot.h"
#include <algorithm>
#include <cmath>
#include <cstring>
#include <limits>
#include <set>

namespace grc::rs::tweens {
namespace {
constexpr auto kMax = rs2::kMaxJsonInteger;
void add(std::uint64_t &n, std::uint64_t by = 1) { n += std::min(by, kMax - n); }
const Value &get(const Value::Object &o, const char *key) {
  static const Value nil;
  const auto it = o.find(key);
  return it == o.end() ? nil : it->second;
}
bool keys(const Value::Object &o, std::initializer_list<const char *> allowed) {
  for (const auto &p : o) {
    bool found = false;
    for (const char *k : allowed) if (p.first == k) found = true;
    if (!found) return false;
  }
  return true;
}
bool number(const Value &v, double *out) {
  if (const auto *n = std::get_if<double>(&v.data)) *out = *n;
  else if (const auto *n = std::get_if<std::int64_t>(&v.data)) *out = static_cast<double>(*n);
  else return false;
  return std::isfinite(*out);
}
bool timing(const Value &v, std::uint64_t *out) {
  double n;
  if (!number(v, &n) || n < 0) return false;
  const long double us = std::floor(static_cast<long double>(n) * 1000 + 0.5L);
  if (us > kMax) return false;
  *out = static_cast<std::uint64_t>(us);
  return true;
}
int enumeration(const Value &v, const std::vector<std::string> &names, const char *prefix) {
  if (const auto *n = std::get_if<std::int64_t>(&v.data)) {
    return *n >= 0 && static_cast<std::uint64_t>(*n) < names.size() ? static_cast<int>(*n) : -1;
  }
  if (const auto *s = std::get_if<std::string>(&v.data)) {
    std::string norm;
    for (unsigned char c : *s) {
      if (c != '_') norm += c >= 'A' && c <= 'Z' ? static_cast<char>(c + ('a' - 'A')) : static_cast<char>(c);
    }
    if (norm.compare(0, std::strlen(prefix), prefix) == 0) norm.erase(0, std::strlen(prefix));
    const auto it = std::find(names.begin(), names.end(), norm);
    if (it != names.end()) return static_cast<int>(it - names.begin());
  }
  return -1;
}
struct Property { int first, arity; };
Property property(const std::string &name, Kind kind) {
  static const std::map<std::string, Property> all = {
    {"position",{0,2}}, {"position:x",{0,1}}, {"position:y",{1,1}},
    {"rotation",{2,1}}, {"scale",{3,2}}, {"scale:x",{3,1}}, {"scale:y",{4,1}},
    {"skew",{5,1}}, {"modulate",{8,4}}, {"modulate:r",{8,1}}, {"modulate:g",{9,1}},
    {"modulate:b",{10,1}}, {"modulate:a",{11,1}}, {"self_modulate",{12,4}},
    {"self_modulate:r",{12,1}}, {"self_modulate:g",{13,1}},
    {"self_modulate:b",{14,1}}, {"self_modulate:a",{15,1}}
  };
  const auto it = all.find(name);
  if (it == all.end() || (kind == Kind::Control && name == "skew")) return {-1,0};
  return it->second;
}
bool endpoint(const Value &v, int arity, std::vector<float> *out) {
  std::vector<double> ns;
  if (arity == 1) { double n; if (!number(v, &n)) return false; ns = {n}; }
  else if (arity == 2) {
    const auto *p = std::get_if<Vector2>(&v.data);
    if (!p) return false;
    ns = {p->x,p->y};
  } else {
    const auto *p = std::get_if<Color>(&v.data);
    if (!p) return false;
    ns = {p->r,p->g,p->b,p->a};
  }
  for (double n : ns) {
    if (!std::isfinite(n) || std::abs(n) > std::numeric_limits<float>::max()) return false;
    out->push_back(static_cast<float>(n));
  }
  return true;
}
int bits(std::uint16_t mask) {
  int n = 0;
  while (mask) { n += mask & 1; mask >>= 1; }
  return n;
}
void u32(std::vector<std::uint8_t> &out, std::uint32_t v) {
  for (int i = 0; i < 4; ++i) out.push_back(static_cast<std::uint8_t>(v >> (8*i)));
}
}  // namespace
void Host::grant(std::uint32_t connection) { viewers_.try_emplace(connection); }
void Host::leave(std::uint32_t connection) {
  viewers_.erase(connection);
  if (!on()) live_.clear();
}
void Host::resync(std::uint32_t connection) {
  const auto it = viewers_.find(connection);
  if (it != viewers_.end()) it->second = Viewer();
}
void Host::expire(std::uint64_t now_us) {
  for (auto it = live_.begin(); it != live_.end();) {
    if (!it->second.implicit_start && it->second.event.end_us <= now_us) it = live_.erase(it);
    else ++it;
  }
}
void Host::drop(const char *scope, const std::string &reason) {
  if (std::strcmp(scope,"begin") == 0) add(stats_.begins_dropped);
  else if (std::strcmp(scope,"step") == 0) add(stats_.steps_dropped);
  else add(stats_.cancels_dropped);
  add(stats_.drops_by_reason[reason]);
}
void Host::begin(const Value &value, std::uint64_t now_us, const Resolve &resolve) {
  if (!on()) return;
  expire(now_us);
  const auto *o = std::get_if<Value::Object>(&value.data);
  if (!o || !keys(*o,{"tween_id","object_id","started_usec","steps"})) {
    drop("begin","invalid-record"); return;
  }
  const auto *id = std::get_if<std::int64_t>(&get(*o,"tween_id").data);
  const auto *obj = std::get_if<std::int64_t>(&get(*o,"object_id").data);
  const auto *steps = std::get_if<Value::Array>(&get(*o,"steps").data);
  const bool implicit = o->count("started_usec") == 0;
  const auto *start = std::get_if<std::int64_t>(&get(*o,"started_usec").data);
  if (!id || !obj || !steps || *obj == 0 || now_us > kMax ||
      (!implicit && (!start || *start < 0 || static_cast<std::uint64_t>(*start) > now_us))) {
    drop("begin","invalid-record"); return;
  }
  if (live_.count(*id)) { drop("begin","duplicate-id"); return; }
  Pose pose;
  const auto reason = resolve(static_cast<std::uint64_t>(*obj), &pose);
  if (!reason.empty()) { drop("begin",reason); return; }
  Live live;
  live.object = static_cast<std::uint64_t>(*obj);
  live.implicit_start = implicit;
  auto &event = live.event;
  event.id = *id; event.item = pose.item;
  event.begin_us = implicit ? now_us : static_cast<std::uint64_t>(*start);
  std::uint64_t duration = 0;
  for (const auto &raw : *steps) {
    const auto *s = std::get_if<Value::Object>(&raw.data);
    if (!s || !keys(*s,{"property","from","to","start_ms","duration_ms","trans","ease"}) ||
        !std::holds_alternative<std::string>(get(*s,"property").data)) {
      drop("step","invalid-step"); continue;
    }
    Step step;
    step.property = std::get<std::string>(get(*s,"property").data);
    const auto p = property(step.property,pose.kind);
    if (!p.arity) { drop("step","unsupported-property"); continue; }
    bool valid = endpoint(get(*s,"to"), p.arity, &step.to);
    if (s->count("from")) {
      step.from.emplace();
      valid = endpoint(get(*s,"from"),p.arity,&*step.from) && valid;
    }
    if (!valid) { drop("step","invalid-value"); continue; }
    if (!timing(get(*s,"start_ms"),&step.start_us) ||
        !timing(get(*s,"duration_ms"),&step.duration_us) ||
        step.start_us > kMax - step.duration_us ||
        event.begin_us > kMax - step.start_us - step.duration_us) {
      drop("step","invalid-timing"); continue;
    }
    step.trans = enumeration(get(*s,"trans"),
      {"linear","sine","quint","quart","quad","expo","elastic","cubic","circ","bounce","back","spring"},"trans");
    step.ease = enumeration(get(*s,"ease"),{"in","out","inout","outin"},"ease");
    if (step.trans < 0 || step.ease < 0) { drop("step","invalid-easing"); continue; }
    step.claims = static_cast<std::uint16_t>(((1u << p.arity)-1) << p.first);
    live.claims |= step.claims;
    duration = std::max(duration,step.start_us + step.duration_us);
    event.steps.push_back(std::move(step));
  }
  if (event.steps.empty()) { drop("begin","empty-steps"); return; }
  event.end_us = event.begin_us + duration;
  event.order = ++order_;
  for (auto it = live_.begin(); it != live_.end();) {
    auto &older = it->second;
    if (older.event.item == event.item) {
      add(stats_.claims_replaced, bits(older.claims & live.claims));
      older.claims &= static_cast<std::uint16_t>(~live.claims);
    }
    if (!older.claims) it = live_.erase(it); else ++it;
  }
  for (auto &viewer : viewers_) {
    auto &known = viewer.second.known[event.item];
    for (auto &older : known) {
      older.second.claims &= static_cast<std::uint16_t>(~live.claims);
      if (!older.second.claims) { older.second.end_us = now_us; older.second.retired = true; }
    }
    viewer.second.pending.push_back({event,now_us,implicit});
    known[event.id] = {live.object,event.end_us,now_us,event.order,live.claims,false};
  }
  add(stats_.begins_accepted); add(stats_.steps_accepted,event.steps.size());
  live_[event.id] = std::move(live);
}
void Host::cancel(const Value &value, std::uint64_t now_us) {
  if (!on()) return;
  expire(now_us);
  const auto *id = std::get_if<std::int64_t>(&value.data);
  const auto it = id ? live_.find(*id) : live_.end();
  if (it == live_.end()) { drop("cancel","unknown-cancel"); return; }
  for (auto &viewer : viewers_) {
    auto &v = viewer.second;
    auto item = v.known.find(it->second.event.item);
    if (item == v.known.end() || !item->second.count(*id)) continue;
    Event event; event.cancel = true; event.id = *id;
    v.pending.push_back({event,now_us,false});
    item->second[*id].end_us = now_us;
    item->second[*id].retired = true;
  }
  live_.erase(it); add(stats_.cancels_accepted);
}
void Host::announce_frame(std::uint64_t t_us) {
  if (!on()) return;
  // Finalize once per announcement, independently of the number of granted viewers.
  std::map<std::uint64_t,Event> finalized;
  for (const auto &viewer : viewers_) for (const auto &pending : viewer.second.pending) {
    if (!pending.implicit_start || finalized.count(pending.event.order)) continue;
    Event event = pending.event;
    event.begin_us = t_us;
    event.end_us = t_us;
    event.steps.erase(std::remove_if(event.steps.begin(),event.steps.end(),[&](const Step &step) {
      if (t_us > kMax || step.start_us > kMax - step.duration_us ||
          t_us > kMax - step.start_us - step.duration_us) {
        drop("step","invalid-timing"); return true;
      }
      event.end_us = std::max(event.end_us,t_us + step.start_us + step.duration_us);
      return false;
    }),event.steps.end());
    if (event.steps.empty()) drop("begin","empty-steps");
    finalized.emplace(event.order,std::move(event));
  }
  for (auto &viewer : viewers_) {
    auto &pending = viewer.second.pending;
    for (auto it = pending.begin(); it != pending.end();) {
      const auto found = finalized.find(it->event.order);
      if (!it->implicit_start || found == finalized.end()) { ++it; continue; }
      const auto &event = found->second;
      auto item = viewer.second.known.find(event.item);
      if (item != viewer.second.known.end()) {
        auto known = item->second.find(event.id);
        if (known != item->second.end() && known->second.order == event.order) {
          if (event.steps.empty()) item->second.erase(known);
          else {
            std::uint16_t claims = 0;
            for (const auto &step : event.steps) claims |= step.claims;
            known->second.claims &= claims;
            if (!known->second.retired) known->second.end_us = event.end_us;
          }
        }
        if (item->second.empty()) viewer.second.known.erase(item);
      }
      if (event.steps.empty()) it = pending.erase(it);
      else { it->event = event; it->implicit_start = false; ++it; }
    }
  }
  for (auto it = live_.begin(); it != live_.end();) {
    auto &live = it->second;
    const auto found = finalized.find(live.event.order);
    if (!live.implicit_start || found == finalized.end()) { ++it; continue; }
    if (found->second.steps.empty()) { it = live_.erase(it); continue; }
    live.event = found->second;
    std::uint16_t claims = 0;
    for (const auto &step : live.event.steps) claims |= step.claims;
    live.claims &= claims;
    live.implicit_start = false;
    if (!live.claims) it = live_.erase(it); else ++it;
  }
}
Frame Host::snapshot(std::uint64_t t_us, const Resolve &resolve) {
  Frame frame; frame.t_us = t_us;
  if (!on()) return frame;
  announce_frame(t_us);
  std::map<std::uint32_t,std::uint64_t> objects;
  for (const auto &v : viewers_) for (const auto &item : v.second.known) {
    if (!item.second.empty()) objects[item.first] = item.second.begin()->second.object;
  }
  for (const auto &object : objects) {
    Pose pose;
    const auto reason = resolve(object.second, &pose);
    if (reason.empty() && pose.item == object.first) frame.poses.emplace(pose.item,pose);
    else {
      for (auto it = live_.begin(); it != live_.end();) {
        if (it->second.event.item == object.first) {
          drop("begin","target-gone"); it = live_.erase(it);
        } else ++it;
      }
      for (auto &v : viewers_) {
        auto &pending = v.second.pending;
        pending.erase(std::remove_if(pending.begin(),pending.end(),[&](const Pending &p) {
          return !p.event.cancel && p.event.item == object.first;
        }),pending.end());
        v.second.known.erase(object.first);
      }
    }
  }
  expire(t_us);
  return frame;
}
Record Host::take(std::uint32_t connection, const Frame &frame) {
  Record record;
  const auto found = viewers_.find(connection);
  if (found == viewers_.end()) return record;
  auto &v = found->second;
  auto &pending = v.pending;
  auto it = pending.begin();
  while (it != pending.end() && it->announced_us <= frame.t_us && !it->implicit_start) {
    record.events.push_back(it->event); ++it;
  }
  pending.erase(pending.begin(),it);
  for (auto item = v.known.begin(); item != v.known.end();) {
    const auto p = frame.poses.find(item->first);
    // Reusing an ID replaces its current Known entry, but a stale picture can still
    // publish the older begin. That begin needs the pose saved with that picture.
    const bool eligible = std::any_of(record.events.begin(),record.events.end(),[&](const Event &e) {
      return !e.cancel && e.item == item->first;
    }) || std::any_of(item->second.begin(),item->second.end(),[&](const auto &k) {
      return k.second.announced_us <= frame.t_us;
    });
    if (eligible && p != frame.poses.end()) record.poses.push_back(p->second);
    auto &known = item->second;
    for (auto k = known.begin(); k != known.end();) {
      const bool queued = std::any_of(pending.begin(),pending.end(),[&](const Pending &p) {
        return !p.event.cancel && p.event.order == k->second.order;
      });
      if (k->second.end_us <= frame.t_us && k->second.announced_us <= frame.t_us && !queued)
        k = known.erase(k);
      else ++k;
    }
    if (known.empty()) item = v.known.erase(item); else ++item;
  }
  return record;
}
void Host::sent(const Record &r) {
  if (r.empty()) return;
  add(stats_.records_sent); add(stats_.poses_sent,r.poses.size());
}
capture::Value::Object Host::state() const {
  capture::Value::Object drops;
  for (const auto &p : stats_.drops_by_reason) drops[p.first] = static_cast<std::int64_t>(p.second);
  std::uint64_t owned = 0;
  for (const auto &p : live_) add(owned,bits(p.second.claims));
  return {{"begins_accepted",static_cast<std::int64_t>(stats_.begins_accepted)},
    {"steps_accepted",static_cast<std::int64_t>(stats_.steps_accepted)},
    {"cancels_accepted",static_cast<std::int64_t>(stats_.cancels_accepted)},
    {"begins_dropped",static_cast<std::int64_t>(stats_.begins_dropped)},
    {"steps_dropped",static_cast<std::int64_t>(stats_.steps_dropped)},
    {"cancels_dropped",static_cast<std::int64_t>(stats_.cancels_dropped)},
    {"claims_replaced",static_cast<std::int64_t>(stats_.claims_replaced)},
    {"records_sent",static_cast<std::int64_t>(stats_.records_sent)},
    {"poses_sent",static_cast<std::int64_t>(stats_.poses_sent)},
    {"live_tweens",static_cast<std::int64_t>(live_.size())},
    {"owned_components",static_cast<std::int64_t>(owned)}, {"drops_by_reason",std::move(drops)}};
}
std::vector<std::uint8_t> encode(const Record &record, std::uint64_t seq,
                                std::uint64_t frame, std::uint64_t t_us) {
  std::vector<float> floats;
  std::string m = "{\"type\":\"tween\",\"seq\":" + std::to_string(seq) +
    ",\"frame\":" + std::to_string(frame) + ",\"t_us\":" + std::to_string(t_us) + ",\"events\":[";
  bool first = true;
  for (const auto &e : record.events) {
    if (!first) m += ',';
    first = false;
    m += e.cancel ? "{\"op\":\"cancel\",\"tween_id\":\"" : "{\"op\":\"begin\",\"tween_id\":\"";
    m += std::to_string(e.id) + '"';
    if (!e.cancel) {
      m += ",\"item\":" + std::to_string(e.item) + ",\"order\":" + std::to_string(e.order) +
        ",\"begin_us\":" + std::to_string(e.begin_us) + ",\"end_us\":" + std::to_string(e.end_us) + ",\"steps\":[";
      bool step_first = true;
      for (const auto &s : e.steps) {
        if (!step_first) m += ',';
        step_first = false;
        m += "{\"property\":\"" + s.property + "\",\"start_us\":" + std::to_string(s.start_us) +
          ",\"duration_us\":" + std::to_string(s.duration_us) + ",\"trans\":" + std::to_string(s.trans) +
          ",\"ease\":" + std::to_string(s.ease) + ",\"from\":";
        if (s.from) {
          m += std::to_string(floats.size());
          floats.insert(floats.end(),s.from->begin(),s.from->end());
        } else m += "null";
        m += ",\"to\":" + std::to_string(floats.size()) + '}';
        floats.insert(floats.end(),s.to.begin(),s.to.end());
      }
      m += ']';
    }
    m += '}';
  }
  m += "],\"poses\":["; first = true;
  for (const auto &p : record.poses) {
    if (!first) m += ',';
    first = false;
    m += "{\"item\":" + std::to_string(p.item) + ",\"kind\":\"" +
      (p.kind == Kind::Node2D ? "node2d" : "control") + "\",\"f\":" + std::to_string(floats.size()) + '}';
    floats.insert(floats.end(),p.f.begin(),p.f.end());
  }
  m += "],\"blocks\":[";
  if (!floats.empty()) m += "{\"name\":\"tween_f32\",\"type\":\"f32\",\"count\":" + std::to_string(floats.size()) + '}';
  m += "]}";
  std::vector<std::uint8_t> out;
  u32(out,static_cast<std::uint32_t>(4 + m.size() + 4 + (floats.empty() ? 0 : 4 + floats.size()*4)));
  u32(out,static_cast<std::uint32_t>(m.size())); out.insert(out.end(),m.begin(),m.end());
  u32(out,floats.empty() ? 0 : 1);
  if (!floats.empty()) {
    u32(out,static_cast<std::uint32_t>(floats.size()*4));
    for (float f : floats) { std::uint32_t v; std::memcpy(&v,&f,4); u32(out,v); }
  }
  return out;
}
}  // namespace grc::rs::tweens
