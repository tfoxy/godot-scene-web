#include "rs_canvas_texture_resolver.h"

#include <algorithm>
#include <cstring>
#include <limits>

#include "report.h"

namespace grc::rs {
namespace {
bool add(std::uint64_t a, std::uint64_t b, std::uint64_t *out) {
  if (b > UINT64_MAX - a) return false;
  *out = a + b;
  return true;
}
template <class T>
bool word(CanvasTextureReader &r, std::uint64_t base, std::uint64_t offset, T *out) {
  std::uint64_t address = 0;
  return add(base, offset, &address) && address != 0 &&
         sizeof(T) <= UINT64_MAX - address && r.copy(address, out, sizeof(T));
}
}  // namespace

bool CanvasTextureRecord::parse(
    const std::vector<std::pair<std::string, std::int64_t>> &fields, std::uint64_t bias,
    CanvasTextureRecord *out, std::string *why) {
  *out = {};
  std::map<std::string, std::uint64_t> values;
  for (const auto &[key, value] : fields) {
    if (value < 0 || !values.emplace(key, value).second) { *why = "invalid-record"; return false; }
  }
  auto take = [&](const std::string &key, std::uint64_t *v) {
    const auto i = values.find(key);
    if (i == values.end()) return false;
    *v = i->second;
    values.erase(i);
    return true;
  };
  std::uint64_t version = 0;
  bool ok = take("version", &version) && version == 1 && take("global", &out->global) &&
            out->global != 0 && out->global % 8 == 0 && add(out->global, bias, &out->global);
  for (auto [prefix, l] : {std::pair{"rd_", &out->rd}, std::pair{"gles3_", &out->gles3}}) {
    for (auto [name, field] : {std::pair{"vptr", &l->vptr}, {"owner", &l->owner},
                             {"stride", &l->stride}, {"validator", &l->validator},
                             {"diffuse", &l->diffuse}, {"normal", &l->normal},
                             {"specular", &l->specular}, {"filter", &l->filter},
                             {"repeat", &l->repeat}}) {
      ok = take(std::string(prefix) + name, field) && ok;
    }
    // This reader supports the 64-bit little-endian RID_Alloc prefix only. The engine's mutex
    // follows it and is never accessed. Sizes and channel positions remain record facts.
    ok = ok && l->vptr != 0 && l->vptr % 8 == 0 && add(l->vptr, bias, &l->vptr) &&
         l->owner >= 8 && l->owner <= 65536 && l->owner % 8 == 0 &&
         l->stride >= 16 && l->stride <= 65536 && l->stride % 8 == 0 &&
         l->validator >= 24 && l->validator < l->stride &&
         l->stride - l->validator >= 4 && l->validator % 4 == 0;
    std::vector<std::pair<std::uint64_t, std::uint64_t>> ranges;
    for (auto [offset, bytes] : {std::pair{l->diffuse, 8ULL}, {l->normal, 8ULL},
                               {l->specular, 8ULL}, {l->filter, 4ULL}, {l->repeat, 4ULL}}) {
      ok = ok && offset % bytes == 0 && offset < l->validator && bytes <= l->validator - offset;
      for (const auto &[start, size] : ranges)
        ok = ok && (offset >= start + size || start >= offset + bytes);
      ranges.emplace_back(offset, bytes);
    }
  }
  ok = ok && out->rd.vptr != out->gles3.vptr && values.empty();
  if (!ok) { *out = {}; *why = "invalid-record"; }
  return ok;
}

void CanvasTextureResolver::attach(bool enabled, const CanvasTextureRecord *record,
                                   const std::string &reason) {
  detach();
  enabled_ = enabled;
  if (!enabled) { reason_ = "flag-off"; return; }
  reason_ = permanent_failure_.empty() ? reason : permanent_failure_;
  if (record) record_ = *record;
  else if (reason_.empty()) reason_ = "no-record";
}

void CanvasTextureResolver::detach() {
  cache_.clear(); unresolved_.clear();
  record_ = {};
  enabled_ = false; checked_ = false;
  reason_ = "detached";
  resolved_ = selfchecks_ = selfcheck_samples_ = total_ns_ = max_ns_ = 0;
  arm_total_ns_ = arm_max_ns_ = 0;
}

void CanvasTextureResolver::arm_begin() {
  // Bindings may change while disarmed without entering the lean registry. Keep the validated
  // attachment/self-check state, but retry both successes and refusals on the next first use.
  cache_.clear();
  arm_total_ns_ = arm_max_ns_ = 0;
}

void CanvasTextureResolver::forget(std::uint64_t rid) {
  if (!ready()) return;
  const auto i = cache_.find(rid);
  // A pending wrapper can change before adoption. Refusals remain cached for this arm.
  if (i != cache_.end() && i->second.ok) cache_.erase(i);
}

bool CanvasTextureResolver::read(CanvasTextureReader &reader, std::uint64_t rid,
                                 CanvasTextureChannels *out, std::string *why, bool require_2d) {
  auto fail = [&](const char *s) { *why = s; return false; };
  const std::uint32_t index = rid, generation = rid >> 32;
  if (rid == 0 || generation == 0 || (generation & 0x80000000U)) return fail("invalid-rid");
  std::uint64_t storage = 0, vptr = 0;
  if (!word(reader, record_.global, 0, &storage) || !storage ||
      !word(reader, storage, 0, &vptr)) return fail("storage-unreadable");
  const CanvasTextureLayout *l = record_.rd.vptr && vptr == record_.rd.vptr ? &record_.rd :
                                 record_.gles3.vptr && vptr == record_.gles3.vptr ? &record_.gles3 : nullptr;
  if (!l) return fail("backend-mismatch");
  // Sentinel comparisons validate the owner layout on both backends. Resolved channels may
  // enter readback only when RD can prove their type; GLES3 has no public type getter.
  if (require_2d && l == &record_.gles3) return fail("gles-untyped");
  std::uint64_t owner = 0, chunks = 0;
  std::uint32_t elements = 0, maximum = 0, limit = 0;
  if (!add(storage, l->owner, &owner) || !word(reader, owner, 8, &chunks) ||
      !word(reader, owner, 24, &elements) || !word(reader, owner, 28, &maximum) ||
      !word(reader, owner, 36, &limit)) return fail("owner-unreadable");
  if (!chunks || !elements || elements > 65536 || !limit || limit > (1U << 20) ||
      maximum % elements != 0 || std::uint64_t(maximum) > std::uint64_t(elements) * limit ||
      index >= maximum || index / elements >= limit) return fail("owner-bounds");
  std::uint64_t chunk = 0, entry = 0;
  const std::uint64_t offset = std::uint64_t(index % elements) * l->stride;
  if (!word(reader, chunks, std::uint64_t(index / elements) * 8, &chunk) || !chunk ||
      !add(chunk, offset, &entry)) return fail("chunk-unreadable");
  std::uint32_t validator = 0;
  if (!word(reader, entry, l->validator, &validator)) return fail("validator-unreadable");
  if (validator != generation) return fail("rid-owner-mismatch");
  CanvasTextureChannels c;
  if (!word(reader, entry, l->diffuse, &c.diffuse) || !word(reader, entry, l->normal, &c.normal) ||
      !word(reader, entry, l->specular, &c.specular) || !word(reader, entry, l->filter, &c.filter) ||
      !word(reader, entry, l->repeat, &c.repeat)) return fail("channels-unreadable");
  if (!word(reader, entry, l->validator, &validator) || validator != generation)
    return fail("rid-changed");
  if (c.filter < 0 || c.filter > 6 || c.repeat < 0 || c.repeat > 3) return fail("invalid-sampling");
  if (!c.diffuse || c.diffuse == rid || !reader.live_texture(c.diffuse)) return fail("invalid-diffuse");
  if ((c.normal && (c.normal == rid || !reader.live_texture(c.normal))) ||
      (c.specular && (c.specular == rid || !reader.live_texture(c.specular))))
    return fail("invalid-channel");
  if (require_2d) {
    for (const auto channel : {c.diffuse, c.normal, c.specular}) {
      if (!channel) continue;
      const auto type = reader.texture_type(channel);
      if (type < 0 || type >= 7) return fail("type-unknown");
      if (type != 1) return fail("not-2d");  // RenderingDevice::TEXTURE_TYPE_2D.
    }
  }
  *out = c;
  return true;
}

bool CanvasTextureResolver::selfcheck(
    CanvasTextureReader &reader,
    const std::vector<std::pair<std::uint64_t, CanvasTextureChannels>> &known) {
  if (!enabled_ || checked_ || !reason_.empty()) return false;
  checked_ = true;
  ++selfchecks_;
  if (known.empty()) reason_ = "selfcheck-no-samples";
  for (const auto &[rid, expected] : known) {
    CanvasTextureChannels actual;
    std::string why;
    if (!read(reader, rid, &actual, &why, false) || actual != expected) {
      reason_ = "selfcheck-" + (why.empty() ? std::string("mismatch") : why);
      break;
    }
    ++selfcheck_samples_;
  }
  if (!reason_.empty()) permanent_failure_ = reason_;
  return ready();
}

bool CanvasTextureResolver::cached(std::uint64_t rid, CanvasTextureChannels *out, bool *ok) const {
  const auto i = cache_.find(rid);
  if (i == cache_.end()) return false;
  *out = i->second.channels; *ok = i->second.ok;
  return true;
}

bool CanvasTextureResolver::resolve(CanvasTextureReader &reader, std::uint64_t rid,
                                    CanvasTextureChannels *out) {
  bool ok = false;
  if (cached(rid, out, &ok)) return ok;
  std::string why = reason_;
  CanvasTextureChannels c;
  ok = ready() && read(reader, rid, &c, &why, true);
  if (ok) ++resolved_;
  else ++unresolved_["canvas-texture-unresolved:" + (why.empty() ? "selfcheck-not-run" : why)];
  cache_[rid] = {c, ok};
  *out = c;
  return ok;
}

void CanvasTextureResolver::elapsed(std::uint64_t ns) {
  total_ns_ += ns;
  max_ns_ = std::max(max_ns_, ns);
  arm_total_ns_ += ns;
  arm_max_ns_ = std::max(arm_max_ns_, ns);
}

std::string CanvasTextureResolver::json() const {
  JsonWriter j;
  j.object_begin();
  j.field("enabled", enabled_).field("ready", ready()).field("reason", reason_);
  j.field("canvas_textures_resolved", static_cast<std::int64_t>(resolved_));
  j.key("canvas_textures_unresolved").object_begin();
  for (const auto &[reason, count] : unresolved_) j.field(reason, static_cast<std::int64_t>(count));
  j.object_end();
  j.key("resolver_selfcheck").object_begin();
  j.field("runs", static_cast<std::int64_t>(selfchecks_));
  j.field("samples", static_cast<std::int64_t>(selfcheck_samples_));
  j.field("passed", ready()).object_end();
  j.key("resolve_total_us").float64(double(total_ns_) / 1000);
  j.key("resolve_max_us").float64(double(max_ns_) / 1000);
  j.key("arm_resolve_total_us").float64(double(arm_total_ns_) / 1000);
  j.key("arm_resolve_max_us").float64(double(arm_max_ns_) / 1000);
  j.field("cache_entries", static_cast<std::int64_t>(cache_.size()));
  return j.object_end().take();
}
}  // namespace grc::rs
