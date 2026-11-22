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
// Canonicalize before claims or f32 packing; aliases never reach the wire.
bool canonicalize(std::string *name, const Pose &pose) {
  if (*name == "rotation_degrees") { *name="rotation"; return true; }
  if (*name != "global_position" && *name != "global_position:x" && *name != "global_position:y")
    return true;
  if (!pose.global_position_supported) return false;
  const auto &m=pose.parent_global;
  for(double n : m) if (!std::isfinite(n)) return false;
  if (m[0]*m[3]-m[1]*m[2] == 0) return false;
  if (*name != "global_position" && (m[1] != 0 || m[2] != 0)) return false;
  name->replace(0,15,"position");
  return true;
}
Value convert_endpoint(const Value &value, const std::string &alias, const Pose &pose) {
  if (alias == "rotation_degrees") {
    double n;
    if (!number(value,&n)) return value;
    return n * (std::acos(-1.0) / 180.0);
  }
  const auto &m=pose.parent_global;
  if (alias == "global_position") {
    const auto *v=std::get_if<Vector2>(&value.data);
    if (!v) return value;
    const double x=v->x-m[4], y=v->y-m[5], det=m[0]*m[3]-m[1]*m[2];
    return Vector2{(m[3]*x-m[2]*y)/det,(-m[1]*x+m[0]*y)/det};
  }
  if (alias == "global_position:x" || alias == "global_position:y") {
    double n;
    if (!number(value,&n)) return value;
    return alias.back() == 'x' ? (n-m[4])/m[0] : (n-m[5])/m[3];
  }
  return value;
}
int bits(std::uint16_t mask) {
  int n = 0;
  while (mask) { n += mask & 1; mask >>= 1; }
  return n;
}
Target target(const Event &e) { return {e.material != 0, e.material ? e.material : e.item}; }
Claims claims(const Event &e) {
  Claims out;
  for (const auto &s : e.steps) out[e.material ? s.param : ""] |= s.claims;
  return out;
}
int bits(const Claims &claims) {
  int n = 0;
  for (const auto &c : claims) n += bits(c.second);
  return n;
}
int replace(Claims &older, const Claims &newer) {
  int replaced = 0;
  for (const auto &c : newer) {
    const auto old = older.find(c.first);
    if (old == older.end()) continue;
    replaced += bits(old->second & c.second);
    old->second &= static_cast<std::uint16_t>(~c.second);
    if (!old->second) older.erase(old);
  }
  return replaced;
}
void intersect(Claims &held, const Claims &allowed) {
  for (auto it = held.begin(); it != held.end();) {
    const auto a = allowed.find(it->first);
    it->second &= a == allowed.end() ? 0 : a->second;
    if (!it->second) it = held.erase(it); else ++it;
  }
}
int material_arity(rs2::VariantType type) {
  switch (type) {
    case rs2::VariantType::Float: return 1;
    case rs2::VariantType::Vector2: return 2;
    case rs2::VariantType::Vector3: return 3;
    case rs2::VariantType::Vector4: case rs2::VariantType::Color: return 4;
    default: return 0;
  }
}
bool material_property(const std::string &path, std::string *param, char *component) {
  const std::string prefix = "shader_parameter/";
  if (path.compare(0,prefix.size(),prefix)) return false;
  const auto colon = path.find(':',prefix.size());
  *param = path.substr(prefix.size(),colon == std::string::npos ? colon : colon-prefix.size());
  const auto alpha = [](char c) { return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c == '_'; };
  if (param->empty() || !alpha((*param)[0])) return false;
  for (char c : *param) if (!alpha(c) && !(c >= '0' && c <= '9')) return false;
  *component = 0;
  if (colon != std::string::npos) {
    if (colon+2 != path.size() || std::string("xyzwrgba").find(path[colon+1]) == std::string::npos) return false;
    *component = path[colon+1];
  }
  return true;
}
bool material_finite(const rs2::Param &p) {
  const auto n = material_arity(p.type);
  if (!n || p.n != 1 || p.floats.size() != static_cast<std::size_t>(n)) return false;
  for (double f : p.floats) if (!std::isfinite(f) || std::abs(f) > std::numeric_limits<float>::max()) return false;
  return true;
}
bool material_endpoint(const Value &v, rs2::VariantType type, bool component, std::vector<float> *out) {
  std::vector<double> ns;
  if (component || type == rs2::VariantType::Float) {
    const auto *n = std::get_if<double>(&v.data); if (!n) return false; ns = {*n};
  } else if (type == rs2::VariantType::Vector2) {
    const auto *n = std::get_if<Vector2>(&v.data); if (!n) return false; ns = {n->x,n->y};
  } else if (type == rs2::VariantType::Vector3) {
    const auto *n = std::get_if<Vector3>(&v.data); if (!n) return false; ns = {n->x,n->y,n->z};
  } else if (type == rs2::VariantType::Vector4) {
    const auto *n = std::get_if<Vector4>(&v.data); if (!n) return false; ns = {n->x,n->y,n->z,n->w};
  } else if (type == rs2::VariantType::Color) {
    const auto *n = std::get_if<Color>(&v.data); if (!n) return false; ns = {n->r,n->g,n->b,n->a};
  } else return false;
  for (double n : ns) {
    if (!std::isfinite(n) || std::abs(n) > std::numeric_limits<float>::max()) return false;
    out->push_back(static_cast<float>(n));
  }
  return true;
}
void u32(std::vector<std::uint8_t> &out, std::uint32_t v) {
  for (int i = 0; i < 4; ++i) out.push_back(static_cast<std::uint8_t>(v >> (8*i)));
}
}  // namespace
void Host::grant(std::uint32_t connection, rs2::ProtocolVersion version) {
  if (!rs2::is_v17_or_later(version)) return;
  viewers_.try_emplace(connection).first->second.version = version;
}
void Host::leave(std::uint32_t connection) {
  viewers_.erase(connection);
  for (auto &p : publication_) if (p.eligible) p.eligible->erase(connection);
  if (!on()) { live_.clear(); publication_.clear(); }
  else release_unobserved_materials();
}
void Host::resync(std::uint32_t connection) {
  const auto it = viewers_.find(connection);
  if (it != viewers_.end()) {
    for (auto &p : publication_) if (p.eligible) p.eligible->erase(connection);
    const auto version = it->second.version;
    it->second = Viewer(); it->second.version = version;
    release_unobserved_materials();
  }
}
void Host::release_unobserved_materials() {
  for (auto it = live_.begin(); it != live_.end();) {
    const auto &event = it->second.event;
    const bool known = !event.material || std::any_of(viewers_.begin(),viewers_.end(),[&](const auto &v) {
      const auto material = v.second.known.find(target(event));
      if (material == v.second.known.end()) return false;
      const auto tween = material->second.find(event.id);
      return tween != material->second.end() && tween->second.order == event.order;
    });
    // A resync/leave discards that viewer's ownership, without replay or a synthetic cancel.
    if (!known) it = live_.erase(it); else ++it;
  }
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
void Host::filter_material_event() {
  for (const auto &v : viewers_) if (v.second.version != rs2::ProtocolVersion::V19) {
    const char *version = v.second.version == rs2::ProtocolVersion::V18 ? rs2::kProtocolV18 : rs2::kProtocolV17;
    add(stats_.material_events_filtered_by_version[version]);
  }
}
void Host::begin(const Value &value, std::uint64_t now_us, const Resolve &resolve,
                 const ResolveMaterial &materials) {
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
  if (live_.count(*id) || std::any_of(publication_.begin(),publication_.end(),
      [&](const Live &p) { return p.event.id == *id; })) { drop("begin","duplicate-id"); return; }
  Pose pose;
  Material material;
  bool is_material = false, unpublished = false;
  if (materials) {
    const bool allowed = std::any_of(viewers_.begin(),viewers_.end(),[](const auto &v) {
      return v.second.version == rs2::ProtocolVersion::V19;
    });
    const auto reason = materials(static_cast<std::uint64_t>(*obj),&material,allowed);
    if (reason != "node") {
      if (!reason.empty() && reason != "pending-material") {
        if (reason == "material-version") filter_material_event();
        drop("begin",reason); return;
      }
      is_material = true; unpublished = reason == "pending-material";
    }
  }
  if (!is_material) {
    const auto reason = resolve(static_cast<std::uint64_t>(*obj), &pose);
    if (!reason.empty() && reason != "pending-item") { drop("begin",reason); return; }
    unpublished = reason == "pending-item";
  }
  Live live;
  live.object = static_cast<std::uint64_t>(*obj);
  live.announced_us = now_us;
  live.implicit_start = implicit;
  auto &event = live.event;
  event.id = *id;
  if (is_material) {
    event.material = material.id; event.shader = material.shader; event.shader_version = material.shader_version;
  } else event.item = pose.item;
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
    Property p{-1,0};
    bool valid = false;
    if (is_material) {
      char component;
      if (!material_property(step.property,&step.param,&component)) { drop("step","unsupported-property"); continue; }
      const auto param = material.params.find(step.param);
      if (param == material.params.end() || param->second.type == rs2::VariantType::Nil) {
        drop("step","missing-material-param"); continue;
      }
      step.type = param->second.type;
      const int arity = material_arity(step.type);
      if (!arity || param->second.n != 1) { drop("step","material-param-type"); continue; }
      if (component) {
        const std::string suffixes = step.type == rs2::VariantType::Color ? "rgba" : std::string("xyzw").substr(0,arity);
        const auto c = suffixes.find(component);
        if (arity == 1 || c == std::string::npos) { drop("step","material-param-mismatch"); continue; }
        step.component = static_cast<int>(c);
      }
      p = {step.component < 0 ? 0 : step.component, step.component < 0 ? arity : 1};
      valid = material_finite(param->second) && material_endpoint(get(*s,"to"),step.type,component != 0,&step.to);
      if (s->count("from")) {
        step.from.emplace();
        valid = material_endpoint(get(*s,"from"),step.type,component != 0,&*step.from) && valid;
      }
    } else {
      const auto alias = step.property;
      if (!canonicalize(&step.property,pose)) { drop("step","unsupported-property"); continue; }
      p = property(step.property,pose.kind);
      if (!p.arity) { drop("step","unsupported-property"); continue; }
      valid = endpoint(convert_endpoint(get(*s,"to"),alias,pose), p.arity, &step.to);
      if (s->count("from")) {
        step.from.emplace();
        valid = endpoint(convert_endpoint(get(*s,"from"),alias,pose),p.arity,&*step.from) && valid;
      }
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
    duration = std::max(duration,step.start_us + step.duration_us);
    event.steps.push_back(std::move(step));
  }
  if (event.steps.empty()) { drop("begin","empty-steps"); return; }
  live.claims = claims(event);
  event.end_us = event.begin_us + duration;
  event.order = ++order_;
  if (unpublished) {
    // Retain the API timestamp and canonical endpoints; no ownership moves until publication.
    live.implicit_start = false;
    live.eligible.emplace();
    for (const auto &v : viewers_) if (!is_material || v.second.version == rs2::ProtocolVersion::V19)
      live.eligible->insert(v.first);
    publication_.push_back(std::move(live));
    return;
  }
  accept(std::move(live),now_us);
}
void Host::accept(Live live, std::uint64_t now_us) {
  auto &event = live.event;
  const bool is_material = event.material != 0;
  const bool implicit = live.implicit_start;
  for (auto it = live_.begin(); it != live_.end();) {
    auto &older = it->second;
    if (target(older.event) == target(event)) {
      add(stats_.claims_replaced,replace(older.claims,live.claims));
    }
    if (older.claims.empty() && older.event.material) {
      // Association can prune the replacement, so retire the old announcement
      // independently. take() suppresses its cancel if its begin is also pruned.
      const auto id = it->first;
      ++it;
      retire(id,now_us);
    } else if (older.claims.empty()) it = live_.erase(it); else ++it;
  }
  if (is_material) filter_material_event();
  for (auto &viewer : viewers_) {
    if (live.eligible && !live.eligible->count(viewer.first)) continue;
    if (is_material && viewer.second.version != rs2::ProtocolVersion::V19) continue;
    auto &v = viewer.second;
    Pending pending{event,live.announced_us,implicit,{}};
    const auto inherit = [&](const Generation &source, Claims transferred) {
      intersect(transferred,live.claims);
      for (const auto &claim : transferred) pending.taken_from[source][claim.first] |= claim.second;
    };
    // Preserve ancestors even if an intervening begin has already lost its Live
    // entry. This viewer has not received that begin's ownership transfer yet.
    if (is_material) for (const auto &p : v.pending) {
      if (!p.event.cancel && target(p.event) == target(event))
        for (const auto &source : p.taken_from) inherit(source.first,source.second);
    }
    auto &known = v.known[target(event)];
    for (auto &older : known) {
      if (is_material) inherit({older.first,older.second.order},older.second.claims);
      replace(older.second.claims,live.claims);
      if (older.second.claims.empty()) { older.second.end_us = now_us; older.second.retired = true; }
    }
    // Publication can resolve an earlier API call after later published-target calls.
    // Reinsert it in call order so wire begin precedence remains monotonic.
    auto next = v.pending.end();
    if (live.eligible) next = std::find_if(v.pending.begin(),v.pending.end(),[&](const Pending &p) {
      return !p.event.cancel && p.event.order > event.order;
    });
    v.pending.insert(next,std::move(pending));
    known[event.id] = {live.object,event.end_us,live.announced_us,event.order,live.claims,false};
  }
  add(stats_.begins_accepted); add(stats_.steps_accepted,event.steps.size());
  if (is_material) { add(stats_.material_begins_accepted); add(stats_.material_steps_accepted,event.steps.size()); }
  live_[event.id] = std::move(live);
}
void Host::retire(std::int64_t id, std::uint64_t now_us) {
  const auto it = live_.find(id);
  if (it == live_.end()) return;
  if (it->second.event.material) filter_material_event();
  for (auto &viewer : viewers_) {
    auto &v = viewer.second;
    auto item = v.known.find(target(it->second.event));
    if (item == v.known.end() || !item->second.count(id)) continue;
    Event event; event.cancel = true; event.id = id; event.order = it->second.event.order;
    // take() may be encoding a saved picture with future begins already queued.
    // Its authoritative cancel belongs before those future announcements.
    auto next = v.pending.end();
    if (!v.pending.empty() && v.pending.back().announced_us > now_us)
      next = std::find_if(v.pending.begin(),v.pending.end(),[&](const Pending &p) { return p.announced_us > now_us; });
    v.pending.insert(next,Pending{event,now_us,false,{}});
    item->second[id].end_us = now_us;
    item->second[id].retired = true;
  }
  live_.erase(it);
}
void Host::cancel(const Value &value, std::uint64_t now_us) {
  if (!on()) return;
  expire(now_us);
  const auto *id = std::get_if<std::int64_t>(&value.data);
  if (id) {
    const auto pending = std::find_if(publication_.begin(),publication_.end(),[&](const Live &p) { return p.event.id == *id; });
    if (pending != publication_.end()) { publication_.erase(pending); add(stats_.cancels_accepted); return; }
  }
  if (!id || !live_.count(*id)) { drop("cancel","unknown-cancel"); return; }
  retire(*id,now_us); add(stats_.cancels_accepted);
}
void Host::observe_materials(std::uint64_t t_us, const ResolveMaterial &materials) {
  if (!materials || !on()) return;
  expire(t_us);
  std::map<std::uint64_t,Material> current;
  std::set<std::uint64_t> missing;
  std::vector<std::int64_t> invalid;
  for (const auto &entry : live_) {
    const auto &live = entry.second;
    if (!live.event.material || !live.associated) continue;
    if (!current.count(live.object) && !missing.count(live.object)) {
      Material material;
      if (materials(live.object,&material,true).empty()) current.emplace(live.object,std::move(material));
      else missing.insert(live.object);
    }
    const auto m = current.find(live.object);
    bool valid = m != current.end() && m->second.id == live.event.material && m->second.supported &&
        m->second.shader == live.event.shader && m->second.shader_version == live.event.shader_version;
    if (valid) for (const auto &s : live.event.steps) {
      const auto held = live.claims.find(s.param);
      if (held == live.claims.end() || !(held->second & s.claims)) continue;
      const auto p = m->second.params.find(s.param);
      if (p == m->second.params.end() || p->second.type != s.type || !material_finite(p->second)) { valid = false; break; }
    }
    if (!valid) invalid.push_back(entry.first);
  }
  for (auto id : invalid) {
    add(stats_.material_tweens_retired); add(stats_.drops_by_reason["material-target-changed"]);
    retire(id,t_us);
  }
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
      auto item = viewer.second.known.find(target(event));
      if (item != viewer.second.known.end()) {
        auto known = item->second.find(event.id);
        if (known != item->second.end() && known->second.order == event.order) {
          if (event.steps.empty()) item->second.erase(known);
          else {
            intersect(known->second.claims,claims(event));
            if (!known->second.retired) known->second.end_us = event.end_us;
          }
        }
        if (item->second.empty()) viewer.second.known.erase(item);
      }
      // Keep a suppressed material begin's transfer history until this viewer's
      // take resolves it; node announcements have no such deferred claim moves.
      if (event.steps.empty() && !event.material) it = pending.erase(it);
      else { it->event = event; it->implicit_start = false; ++it; }
    }
  }
  for (auto it = live_.begin(); it != live_.end();) {
    auto &live = it->second;
    const auto found = finalized.find(live.event.order);
    if (!live.implicit_start || found == finalized.end()) { ++it; continue; }
    if (found->second.steps.empty()) { it = live_.erase(it); continue; }
    live.event = found->second;
    intersect(live.claims,claims(live.event));
    live.implicit_start = false;
    if (live.claims.empty()) it = live_.erase(it); else ++it;
  }
}
Frame Host::snapshot(std::uint64_t t_us, const Resolve &resolve, const ResolveMaterial &materials) {
  Frame frame; frame.t_us = t_us;
  if (!on()) return frame;
  auto publication = std::move(publication_);
  publication_.clear();
  for (auto &live : publication) {
    if (live.eligible && live.eligible->empty()) continue;
    std::string reason;
    if (live.event.material) {
      Material material;
      reason = materials ? materials(live.object,&material,true) : "unpublished-material";
      if (reason.empty() && material.id != live.event.material) reason = "target-gone";
      if (reason == "pending-material") reason = "unpublished-material";
    } else {
      Pose pose;
      reason = resolve(live.object,&pose);
      if (reason.empty()) live.event.item = pose.item;
      if (reason == "pending-item") reason = "unpublished-item";
    }
    if (reason == "unresolved-object") reason = "target-gone";
    if (!reason.empty()) { drop("begin",reason); continue; }
    // Eligibility is frozen at the API call; a late grant or resync gets no replay.
    accept(std::move(live),t_us);
  }
  announce_frame(t_us);
  observe_materials(t_us,materials);
  std::map<Target,std::uint64_t> objects;
  for (const auto &v : viewers_) for (const auto &item : v.second.known) {
    if (!item.second.empty()) objects[item.first] = item.second.begin()->second.object;
  }
  for (const auto &object : objects) {
    if (object.first.first) {
      if (materials) {
        Material m;
        materials(object.second,&m,true);
        if (m.id == object.first.second) frame.materials.emplace(m.id,std::move(m));
      }
      continue;
    }
    Pose pose;
    const auto reason = resolve(object.second, &pose);
    if (reason.empty() && pose.item == object.first.second) frame.poses.emplace(pose.item,pose);
    else {
      for (auto it = live_.begin(); it != live_.end();) {
        if (target(it->second.event) == object.first) {
          drop("begin","target-gone"); it = live_.erase(it);
        } else ++it;
      }
      for (auto &v : viewers_) {
        auto &pending = v.second.pending;
        pending.erase(std::remove_if(pending.begin(),pending.end(),[&](const Pending &p) {
          return !p.event.cancel && target(p.event) == object.first;
        }),pending.end());
        v.second.known.erase(object.first);
      }
    }
  }
  expire(t_us);
  return frame;
}
void Host::associate(Event &event, const Frame &frame, Viewer &viewer) {
  if (!event.material) return;
  const auto m = frame.materials.find(event.material);
  const auto old_size = event.steps.size();
  if (m == frame.materials.end()) {
    if (!event.steps.empty()) drop("begin","target-gone");
    event.steps.clear();
  } else {
    const bool compatible = m->second.supported && m->second.shader == event.shader &&
        m->second.shader_version == event.shader_version;
    event.steps.erase(std::remove_if(event.steps.begin(),event.steps.end(),[&](const Step &step) {
      const auto p = m->second.params.find(step.param);
      if (!compatible || p == m->second.params.end() || p->second.type != step.type || !material_finite(p->second)) {
        drop("step","material-baseline-changed"); return true;
      }
      return false;
    }),event.steps.end());
  }
  if (event.steps.size() != old_size) {
    event.end_us = event.begin_us;
    for (const auto &s : event.steps) event.end_us = std::max(event.end_us,event.begin_us+s.start_us+s.duration_us);
    // Rewrite pending copies globally: the same invalid step is counted only once.
    const auto held = claims(event);
    for (auto &v : viewers_) {
      for (auto &p : v.second.pending) if (!p.event.cancel && p.event.order == event.order) p.event = event;
      auto item = v.second.known.find(target(event));
      if (item == v.second.known.end()) continue;
      auto known = item->second.find(event.id);
      if (known != item->second.end() && known->second.order == event.order) {
        intersect(known->second.claims,held);
        known->second.end_us = std::min(known->second.end_us,event.end_us);
      }
    }
    auto live = live_.find(event.id);
    if (live != live_.end() && live->second.event.order == event.order) {
      live->second.event = event; intersect(live->second.claims,held);
      // take() retires empty owners after association, preserving delivered-viewer cancels.
    }
  }
  if (event.steps.empty()) viewer.suppressed.insert(event.order);
  else {
    auto live = live_.find(event.id);
    if (live != live_.end() && live->second.event.order == event.order) live->second.associated = true;
  }
}
Record Host::take(std::uint32_t connection, const Frame &frame) {
  Record record;
  const auto found = viewers_.find(connection);
  if (found == viewers_.end()) return record;
  auto &v = found->second;
  auto &pending = v.pending;
  // Association only rewrites pending copies. Retire after traversal because
  // retire() inserts cancels into these vectors.
  for (auto &p : pending) {
    if (p.announced_us > frame.t_us || p.implicit_start) break;
    if (!p.event.cancel) {
      Event event = p.event;
      associate(event,frame,v);
    }
  }
  std::vector<std::int64_t> pruned;
  for (const auto &live : live_) {
    if (live.second.event.material && live.second.claims.empty()) pruned.push_back(live.first);
  }
  for (auto id : pruned) {
    // An entirely unsent begin needs no cancel or additional retirement count.
    if (!live_.at(id).associated) { live_.erase(id); continue; }
    // Another viewer received this begin from an older picture. Retire after
    // association because ordinary cancels mutate pending vectors.
    add(stats_.material_tweens_retired); add(stats_.drops_by_reason["material-target-changed"]);
    retire(id,frame.t_us);
  }
  std::set<Generation> processed;
  while (true) {
    std::set<Generation> retirements;
    for (const auto &p : pending) {
      if (p.announced_us > frame.t_us || p.implicit_start) break;
      if (p.event.cancel || !p.event.material) continue;
      for (const auto &source : p.taken_from) {
        auto lost = source.second;
        // Any begin this viewer actually receives can carry the claim move,
        // including a successor of an unsent, cancelled replacement.
        for (const auto &next : pending) {
          if (next.announced_us > frame.t_us || next.implicit_start) break;
          if (!next.event.cancel && target(next.event) == target(p.event) &&
              next.event.order > source.first.second) replace(lost,claims(next.event));
        }
        if (!lost.empty() && !processed.count(source.first)) retirements.insert(source.first);
      }
    }
    if (retirements.empty()) break;
    for (const auto &older : retirements) {
      processed.insert(older);
      const auto live = live_.find(older.first);
      // Already retired generations have an ordinary cancel queued. Their valid
      // unsent begin can still carry a claim move before that cancel releases it.
      if (live == live_.end() || live->second.event.order != older.second) continue;
      // Suppress unsent generations on every viewer before queuing ordinary
      // cancels. Repeat the scan: suppression can invalidate another claim move.
      for (auto &viewer : viewers_) for (auto &p : viewer.second.pending) {
        if (!p.event.cancel && p.event.order == older.second) {
          p.event.steps.clear();
          viewer.second.suppressed.insert(older.second);
        }
      }
      add(stats_.material_tweens_retired); add(stats_.drops_by_reason["material-target-changed"]);
      retire(older.first,frame.t_us);
    }
  }
  auto it = pending.begin();
  while (it != pending.end() && it->announced_us <= frame.t_us && !it->implicit_start) {
    Event event = it->event;
    if (!event.cancel && event.steps.empty()) v.suppressed.insert(event.order);
    if (event.cancel) {
      if (!v.suppressed.erase(event.order)) record.events.push_back(std::move(event));
    } else if (!event.steps.empty()) record.events.push_back(std::move(event));
    ++it;
  }
  pending.erase(pending.begin(),it);
  for (auto item = v.known.begin(); item != v.known.end();) {
    if (!item->first.first) {
      const auto p = frame.poses.find(item->first.second);
      const bool eligible = std::any_of(record.events.begin(),record.events.end(),[&](const Event &e) {
        return !e.cancel && target(e) == item->first;
      }) || std::any_of(item->second.begin(),item->second.end(),[&](const auto &k) {
        return k.second.announced_us <= frame.t_us;
      });
      if (eligible && p != frame.poses.end()) record.poses.push_back(p->second);
    }
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
  // A suppressed order is needed only while its cancel is still queued.
  for (auto order = v.suppressed.begin(); order != v.suppressed.end();) {
    const bool queued = std::any_of(pending.begin(),pending.end(),[&](const Pending &p) { return p.event.order == *order; });
    if (!queued) order = v.suppressed.erase(order); else ++order;
  }
  return record;
}
void Host::sent(const Record &r) {
  if (r.empty()) return;
  add(stats_.records_sent); add(stats_.poses_sent,r.poses.size());
}
capture::Value::Object Host::state(bool material_fields) const {
  capture::Value::Object drops;
  for (const auto &p : stats_.drops_by_reason) drops[p.first] = static_cast<std::int64_t>(p.second);
  capture::Value::Object filtered;
  for (const auto &p : stats_.material_events_filtered_by_version) filtered[p.first] = static_cast<std::int64_t>(p.second);
  std::uint64_t material_live = 0, material_owned = 0;
  for (const auto &p : live_) if (p.second.event.material) { add(material_live); add(material_owned,bits(p.second.claims)); }
  std::uint64_t owned = 0;
  for (const auto &p : live_) add(owned,bits(p.second.claims));
  capture::Value::Object out = {{"begins_accepted",static_cast<std::int64_t>(stats_.begins_accepted)},
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
  if (material_fields) {
    out.emplace("material_begins_accepted",static_cast<std::int64_t>(stats_.material_begins_accepted));
    out.emplace("material_steps_accepted",static_cast<std::int64_t>(stats_.material_steps_accepted));
    out.emplace("material_tweens_retired",static_cast<std::int64_t>(stats_.material_tweens_retired));
    out.emplace("live_material_tweens",static_cast<std::int64_t>(material_live));
    out.emplace("owned_material_components",static_cast<std::int64_t>(material_owned));
    out.emplace("material_events_filtered_by_version",std::move(filtered));
  }
  return out;
}
std::vector<std::uint8_t> encode(const Record &record, std::uint64_t seq,
                                std::uint64_t frame, std::uint64_t t_us) {
  std::vector<float> floats;
  std::map<std::pair<std::size_t,std::size_t>,std::pair<std::size_t,std::size_t>> offsets;
  std::vector<std::size_t> poses;
  const auto endpoints = [&](bool material) {
    for (std::size_t e = 0; e < record.events.size(); ++e) {
      const auto &event = record.events[e];
      if (event.cancel || (event.material != 0) != material) continue;
      for (std::size_t i = 0; i < event.steps.size(); ++i) {
        const auto &step = event.steps[i];
        const auto from = floats.size();
        if (step.from) floats.insert(floats.end(),step.from->begin(),step.from->end());
        offsets[{e,i}] = {from,floats.size()};
        floats.insert(floats.end(),step.to.begin(),step.to.end());
      }
    }
  };
  endpoints(false);
  for (const auto &pose : record.poses) {
    poses.push_back(floats.size()); floats.insert(floats.end(),pose.f.begin(),pose.f.end());
  }
  endpoints(true);
  std::string m = "{\"type\":\"tween\",\"seq\":" + std::to_string(seq) +
    ",\"frame\":" + std::to_string(frame) + ",\"t_us\":" + std::to_string(t_us) + ",\"events\":[";
  bool first = true;
  for (std::size_t ei = 0; ei < record.events.size(); ++ei) {
    const auto &e = record.events[ei];
    if (!first) m += ',';
    first = false;
    m += e.cancel ? "{\"op\":\"cancel\",\"tween_id\":\"" : "{\"op\":\"begin\",\"tween_id\":\"";
    m += std::to_string(e.id) + '"';
    if (!e.cancel) {
      m += std::string(e.material ? ",\"material\":" : ",\"item\":") + std::to_string(e.material ? e.material : e.item) + ",\"order\":" + std::to_string(e.order) +
        ",\"begin_us\":" + std::to_string(e.begin_us) + ",\"end_us\":" + std::to_string(e.end_us) + ",\"steps\":[";
      bool step_first = true;
      for (std::size_t si = 0; si < e.steps.size(); ++si) {
        const auto &s = e.steps[si];
        const auto offset = offsets.at({ei,si});
        if (!step_first) m += ',';
        step_first = false;
        if (e.material) {
          m += "{\"param\":\"" + s.param + "\",\"type\":\"" + rs2::to_wire(s.type) + "\",\"component\":" +
              (s.component < 0 ? std::string("null") : std::to_string(s.component));
        } else m += "{\"property\":\"" + s.property + "\"";
        m += ",\"start_us\":" + std::to_string(s.start_us) +
          ",\"duration_us\":" + std::to_string(s.duration_us) + ",\"trans\":" + std::to_string(s.trans) +
          ",\"ease\":" + std::to_string(s.ease) + ",\"from\":";
        if (s.from) {
          m += std::to_string(offset.first);
        } else m += "null";
        m += ",\"to\":" + std::to_string(offset.second) + '}';
      }
      m += ']';
    }
    m += '}';
  }
  m += "],\"poses\":["; first = true;
  for (std::size_t pi = 0; pi < record.poses.size(); ++pi) {
    const auto &p = record.poses[pi];
    if (!first) m += ',';
    first = false;
    m += "{\"item\":" + std::to_string(p.item) + ",\"kind\":\"" +
      (p.kind == Kind::Node2D ? "node2d" : "control") + "\",\"f\":" + std::to_string(poses[pi]) + '}';
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
