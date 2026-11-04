// The late-arm resource registry (rs_registry.h; protocol/late-arm-registry-design.md LAR0).
#include "rs_registry.h"

#include <mutex>
#include <utility>

#include "report.h"
#include "rs_rid_map.h"

namespace grc {
namespace rs {

std::atomic<bool> g_registry_on{false};

namespace {

struct Entry {
  RegistryKind kind = RegistryKind::Texture2d;
};

struct State {
  std::mutex mutex;  // leaf lock (rs_registry.h)
  bool configured = false;
  RegistryFault fault = RegistryFault::None;
  std::size_t cap = kRegistryDefaultCap;
  // HC6's flat open-addressed map (rs_rid_map.h): one slot holds key and kind, so a create or a free
  // costs one multiply and usually one cache line, and no node allocation. LAR0 measured
  // std::unordered_map at ~250 ns a call in situ (a cold bucket array, a cold node, malloc/free).
  RidMap<Entry> map;
  // The map's slot count, followed with RidMap's own growth rule (it doubles from 64 when an
  // insertion would make it more than half full, and never shrinks), for bytes_estimate.
  std::uint64_t capacity = 0;
  // LAR1: the CanvasTexture payload, one slot per registered CanvasTexture (a subset of `map`'s
  // keys: created with the kind entry, erased with it). A separate map, so the kind map's slots
  // stay 16 B for every other family.
  RidMap<RegistryCanvasTexture> canvas;
  std::uint64_t canvas_capacity = 0;
  std::uint64_t canvas_sets = 0;
  RegistryFamilyStats family[kRegistryFamilies];
  std::uint64_t entries = 0;
  std::uint64_t peak = 0;
  // Bumped (under the lock) by every mutation; registry_frame() compares it with the last row's
  // without taking the lock.
  std::atomic<std::uint64_t> generation{0};
  std::uint64_t row_generation = 0;
  std::vector<RegistryRow> timeline;
  std::uint64_t timeline_dropped = 0;
};

State &state() {
  static State s;  // never destroyed before the hooks stop: function-local, process lifetime
  return s;
}

std::size_t index(RegistryFamily family) { return static_cast<std::size_t>(family); }

// One slot of the flat map (key and kind, padded).
constexpr std::uint64_t kNodeBytes = sizeof(RidMap<Entry>::value_type);
// One slot of the CanvasTexture payload map (key and RegistryCanvasTexture).
constexpr std::uint64_t kCanvasNodeBytes = sizeof(RidMap<RegistryCanvasTexture>::value_type);

// Follows RidMap's growth rule (it doubles from 64 when an insertion would make it more than half
// full, and never shrinks) for bytes_estimate. Call before inserting a new key into a map of `size`.
void track_growth(std::size_t size, std::uint64_t *capacity) {
  if ((size + 1) * 2 > *capacity) {
    *capacity = *capacity == 0 ? 64 : *capacity * 2;
  }
}

// A CanvasTexture create: a fresh payload (a recycled value drops the previous owner's channels).
void canvas_create_locked(State &s, std::uint64_t rid) {
  if (s.canvas.find(rid) == s.canvas.end()) {
    track_growth(s.canvas.size(), &s.canvas_capacity);
  }
  s.canvas[rid] = RegistryCanvasTexture();
}

void add_entry_locked(State &s, RegistryFamily family) {
  RegistryFamilyStats &f = s.family[index(family)];
  ++f.entries;
  if (f.entries > f.peak) {
    f.peak = f.entries;
  }
  ++s.entries;
  if (s.entries > s.peak) {
    s.peak = s.entries;
  }
}

void remove_entry_locked(State &s, RegistryFamily family) {
  --s.family[index(family)].entries;
  --s.entries;
}

void changed_locked(State &s) {
  s.generation.fetch_add(1, std::memory_order_relaxed);
}

std::uint32_t clamp32(std::uint64_t v) {
  return v > 0xffffffffull ? 0xffffffffu : static_cast<std::uint32_t>(v);
}

}  // namespace

RegistryFamily registry_family(RegistryKind kind) {
  switch (kind) {
  case RegistryKind::Texture2d:
  case RegistryKind::TexturePlaceholder: return RegistryFamily::Texture;
  case RegistryKind::CanvasTexture: return RegistryFamily::CanvasTexture;
  case RegistryKind::Mesh: return RegistryFamily::Mesh;
  case RegistryKind::Multimesh: return RegistryFamily::Multimesh;
  case RegistryKind::Shader: return RegistryFamily::Shader;
  case RegistryKind::Material: return RegistryFamily::Material;
  case RegistryKind::Particles: return RegistryFamily::Particles;
  }
  return RegistryFamily::Texture;
}

const char *registry_family_name(RegistryFamily family) {
  switch (family) {
  case RegistryFamily::Texture: return "texture";
  case RegistryFamily::CanvasTexture: return "canvas_texture";
  case RegistryFamily::Mesh: return "mesh";
  case RegistryFamily::Multimesh: return "multimesh";
  case RegistryFamily::Shader: return "shader";
  case RegistryFamily::Material: return "material";
  case RegistryFamily::Particles: return "particles";
  }
  return "?";
}

const char *registry_kind_name(RegistryKind kind) {
  switch (kind) {
  case RegistryKind::Texture2d: return "texture_2d";
  case RegistryKind::TexturePlaceholder: return "texture_placeholder";
  case RegistryKind::CanvasTexture: return "canvas_texture";
  case RegistryKind::Mesh: return "mesh";
  case RegistryKind::Multimesh: return "multimesh";
  case RegistryKind::Shader: return "shader";
  case RegistryKind::Material: return "material";
  case RegistryKind::Particles: return "particles";
  }
  return "?";
}

const char *registry_fault_name(RegistryFault fault) {
  switch (fault) {
  case RegistryFault::None: return "none";
  case RegistryFault::Off: return "registry-off";
  case RegistryFault::KeepFreed: return "registry-keep-freed";
  }
  return "?";
}

void registry_configure(bool adopt, RegistryFault fault, std::size_t cap) {
  State &s = state();
  std::lock_guard<std::mutex> lock(s.mutex);
  s.configured = adopt;
  s.fault = adopt ? fault : RegistryFault::None;
  s.cap = cap;
  s.map.clear();
  s.capacity = 0;
  s.canvas.clear();
  s.canvas_capacity = 0;
  s.canvas_sets = 0;
  for (RegistryFamilyStats &f : s.family) {
    f = RegistryFamilyStats();
  }
  s.entries = 0;
  s.peak = 0;
  s.generation.store(0, std::memory_order_relaxed);
  s.row_generation = 0;
  s.timeline.clear();
  s.timeline_dropped = 0;
  g_registry_on.store(adopt && s.fault != RegistryFault::Off, std::memory_order_relaxed);
}

void registry_note_create(std::uint64_t rid, RegistryKind kind) {
  State &s = state();
  const RegistryFamily family = registry_family(kind);
  std::lock_guard<std::mutex> lock(s.mutex);
  RegistryFamilyStats &f = s.family[index(family)];
  if (rid == 0) {
    ++f.null_creates;
    return;
  }
  const auto it = s.map.find(rid);
  if (it != s.map.end()) {
    // A value already present: the last create wins (R5), counted against the old family.
    const RegistryFamily old = registry_family(it->second.kind);
    ++s.family[index(old)].recreated;
    remove_entry_locked(s, old);
    it->second.kind = kind;
    ++f.creates;
    add_entry_locked(s, family);
    if (kind == RegistryKind::CanvasTexture) {
      canvas_create_locked(s, rid);
    } else if (old == RegistryFamily::CanvasTexture) {
      s.canvas.erase(rid);
    }
    changed_locked(s);
    return;
  }
  if (f.entries >= s.cap) {
    ++f.overflow;  // its later references fall to the residual path (design Q3)
    return;
  }
  track_growth(s.map.size(), &s.capacity);
  s.map[rid] = Entry{kind};
  if (kind == RegistryKind::CanvasTexture) {
    canvas_create_locked(s, rid);
  }
  ++f.creates;
  add_entry_locked(s, family);
  changed_locked(s);
}

void registry_note_free(std::uint64_t rid) {
  State &s = state();
  std::lock_guard<std::mutex> lock(s.mutex);
  const auto it = s.map.find(rid);
  if (it == s.map.end()) {
    return;  // untracked (a canvas item, a viewport...), pre-load, overflowed or internal
  }
  const RegistryFamily family = registry_family(it->second.kind);
  ++s.family[index(family)].frees;
  if (s.fault != RegistryFault::KeepFreed) {
    s.map.erase(rid);
    if (family == RegistryFamily::CanvasTexture) {
      s.canvas.erase(rid);
    }
    remove_entry_locked(s, family);
  }
  changed_locked(s);
}

void registry_note_replace(std::uint64_t texture, std::uint64_t by_texture) {
  // texture_replace(a, b): the engine moves b's data into a and frees b inside the call, with no
  // free of its own. a keeps its entry but takes b's kind (a placeholder replaced by a loaded
  // texture -- STS2's threaded loads do this 253 times in pm7-a12-1 -- is a 2D texture from then
  // on; LAR6 also gives it b's `updated` flag); b's entry goes. An unregistered a (pre-load) stays
  // unregistered: it was never a recorded create.
  State &s = state();
  std::lock_guard<std::mutex> lock(s.mutex);
  if (by_texture == texture) {
    return;
  }
  const auto it = s.map.find(by_texture);
  if (it == s.map.end()) {
    return;
  }
  const auto into = s.map.find(texture);
  if (into != s.map.end() && registry_family(into->second.kind) == RegistryFamily::Texture &&
      registry_family(it->second.kind) == RegistryFamily::Texture) {
    into->second.kind = it->second.kind;
  }
  const RegistryFamily family = registry_family(it->second.kind);
  ++s.family[index(family)].replaced;
  s.map.erase(by_texture);
  remove_entry_locked(s, family);
  changed_locked(s);
}

bool registry_lookup(std::uint64_t rid, RegistryKind *kind) {
  State &s = state();
  std::lock_guard<std::mutex> lock(s.mutex);
  const auto it = s.map.find(rid);
  if (it == s.map.end()) {
    return false;
  }
  if (kind != nullptr) {
    *kind = it->second.kind;
  }
  return true;
}

namespace {

// The registered CanvasTexture `rid`'s payload, or null (not a registered CanvasTexture: pre-load,
// overflowed, freed, or no CanvasTexture at all). Under the lock.
RegistryCanvasTexture *canvas_locked(State &s, std::uint64_t rid) {
  const auto it = s.canvas.find(rid);
  return it != s.canvas.end() ? &it->second : nullptr;
}

}  // namespace

void registry_note_canvas_channel(std::uint64_t rid, std::int32_t channel, std::uint64_t texture) {
  State &s = state();
  std::lock_guard<std::mutex> lock(s.mutex);
  RegistryCanvasTexture *c = canvas_locked(s, rid);
  if (c == nullptr) {
    return;
  }
  if (channel == 0) {  // RS::CANVAS_TEXTURE_CHANNEL_DIFFUSE
    c->diffuse = texture;
    c->diffuse_set = true;
  } else if (channel == 1) {  // RS::CANVAS_TEXTURE_CHANNEL_NORMAL
    c->normal = texture;
    c->normal_set = true;
  } else if (channel == 2) {  // RS::CANVAS_TEXTURE_CHANNEL_SPECULAR
    c->specular = texture;
    c->specular_set = true;
  } else {
    return;
  }
  ++s.canvas_sets;
}

void registry_note_canvas_filter(std::uint64_t rid, std::int32_t filter) {
  State &s = state();
  std::lock_guard<std::mutex> lock(s.mutex);
  RegistryCanvasTexture *c = canvas_locked(s, rid);
  if (c == nullptr) {
    return;
  }
  c->filter = filter;
  c->filter_set = true;
  ++s.canvas_sets;
}

void registry_note_canvas_repeat(std::uint64_t rid, std::int32_t repeat) {
  State &s = state();
  std::lock_guard<std::mutex> lock(s.mutex);
  RegistryCanvasTexture *c = canvas_locked(s, rid);
  if (c == nullptr) {
    return;
  }
  c->repeat = repeat;
  c->repeat_set = true;
  ++s.canvas_sets;
}

bool registry_canvas_texture(std::uint64_t rid, RegistryCanvasTexture *out) {
  State &s = state();
  std::lock_guard<std::mutex> lock(s.mutex);
  const RegistryCanvasTexture *c = canvas_locked(s, rid);
  if (c == nullptr) {
    return false;
  }
  if (out != nullptr) {
    *out = *c;
  }
  return true;
}

void registry_frame(std::uint64_t frame) {
  State &s = state();
  const std::uint64_t generation = s.generation.load(std::memory_order_relaxed);
  if (generation == s.row_generation) {
    return;
  }
  std::lock_guard<std::mutex> lock(s.mutex);
  s.row_generation = s.generation.load(std::memory_order_relaxed);
  if (s.timeline.size() >= kRegistryTimelineCap) {
    ++s.timeline_dropped;
    return;
  }
  RegistryRow row;
  row.frame = frame;
  for (std::size_t i = 0; i < kRegistryFamilies; ++i) {
    const RegistryFamilyStats &f = s.family[i];
    row.entries[i] = clamp32(f.entries);
    row.creates[i] = clamp32(f.creates);
    row.frees[i] = clamp32(f.frees + f.replaced + f.recreated);
  }
  s.timeline.push_back(row);
}

RegistryStats registry_stats() {
  State &s = state();
  std::lock_guard<std::mutex> lock(s.mutex);
  RegistryStats out;
  out.configured = s.configured;
  out.enabled = g_registry_on.load(std::memory_order_relaxed);
  out.fault = s.fault;
  out.cap = s.cap;
  for (std::size_t i = 0; i < kRegistryFamilies; ++i) {
    out.family[i] = s.family[i];
  }
  out.entries = s.entries;
  out.peak = s.peak;
  out.entry_bytes = static_cast<std::uint64_t>(s.map.size()) * kNodeBytes +
                    static_cast<std::uint64_t>(s.canvas.size()) * kCanvasNodeBytes;
  out.canvas_payloads = s.canvas.size();
  out.canvas_payload_sets = s.canvas_sets;
  out.canvas_payload_bytes = s.canvas_capacity * kCanvasNodeBytes;
  // The slot arrays, empty slots included (at most half full, never shrinking: bounded by the
  // peak, not by the current entries).
  out.bytes_estimate = s.capacity * kNodeBytes + out.canvas_payload_bytes;
  return out;
}

std::vector<RegistryRow> registry_timeline(std::uint64_t *dropped) {
  State &s = state();
  std::lock_guard<std::mutex> lock(s.mutex);
  if (dropped != nullptr) {
    *dropped = s.timeline_dropped;
  }
  return s.timeline;
}

std::string registry_json() {
  const RegistryStats stats = registry_stats();
  std::uint64_t dropped = 0;
  const std::vector<RegistryRow> rows = registry_timeline(&dropped);
  JsonWriter json;
  json.object_begin();
  json.field("schema", std::string("render-stream-registry/1"));
  json.field("configured", stats.configured);
  json.field("enabled", stats.enabled);
  json.field("fault", std::string(registry_fault_name(stats.fault)));
  json.key("cap").unsigned_integer(stats.cap);
  json.key("entries").unsigned_integer(stats.entries);
  json.key("peak").unsigned_integer(stats.peak);
  json.key("bytes_estimate").unsigned_integer(stats.bytes_estimate);
  json.key("entry_bytes").unsigned_integer(stats.entry_bytes);
  json.key("node_bytes").unsigned_integer(kNodeBytes);
  json.key("families").object_begin();
  for (std::size_t i = 0; i < kRegistryFamilies; ++i) {
    const RegistryFamilyStats &f = stats.family[i];
    json.key(registry_family_name(static_cast<RegistryFamily>(i))).object_begin();
    json.key("entries").unsigned_integer(f.entries);
    json.key("peak").unsigned_integer(f.peak);
    json.key("creates").unsigned_integer(f.creates);
    json.key("frees").unsigned_integer(f.frees);
    json.key("replaced").unsigned_integer(f.replaced);
    json.key("recreated").unsigned_integer(f.recreated);
    json.key("null_creates").unsigned_integer(f.null_creates);
    json.key("overflow").unsigned_integer(f.overflow);
    json.key("bytes_estimate")
        .unsigned_integer(f.entries * kNodeBytes +
                          (static_cast<RegistryFamily>(i) == RegistryFamily::CanvasTexture
                               ? stats.canvas_payloads * kCanvasNodeBytes
                               : 0));
    json.object_end();
  }
  json.object_end();
  // LAR1: the CanvasTexture payload (channels, filter, repeat per registered CanvasTexture).
  json.key("payloads").object_begin();
  json.key("canvas_texture").object_begin();
  json.key("entries").unsigned_integer(stats.canvas_payloads);
  json.key("sets").unsigned_integer(stats.canvas_payload_sets);
  json.key("node_bytes").unsigned_integer(kCanvasNodeBytes);
  json.key("bytes_estimate").unsigned_integer(stats.canvas_payload_bytes);
  json.object_end();
  json.object_end();
  // The change timeline: one row per frame callback after which the registry had changed. Columns
  // are per family in `family_order`; `frees` is frees + replaced + recreated.
  json.key("timeline").object_begin();
  json.key("family_order").array_begin();
  for (std::size_t i = 0; i < kRegistryFamilies; ++i) {
    json.string(registry_family_name(static_cast<RegistryFamily>(i)));
  }
  json.array_end();
  json.key("cap").unsigned_integer(kRegistryTimelineCap);
  json.key("dropped").unsigned_integer(dropped);
  json.key("rows").array_begin();
  for (const RegistryRow &row : rows) {
    json.object_begin();
    json.key("frame").unsigned_integer(row.frame);
    json.key("entries").array_begin();
    for (std::uint32_t v : row.entries) {
      json.unsigned_integer(v);
    }
    json.array_end();
    json.key("creates").array_begin();
    for (std::uint32_t v : row.creates) {
      json.unsigned_integer(v);
    }
    json.array_end();
    json.key("frees").array_begin();
    for (std::uint32_t v : row.frees) {
      json.unsigned_integer(v);
    }
    json.array_end();
    json.object_end();
  }
  json.array_end();
  json.object_end();
  json.object_end();
  return json.take();
}

}  // namespace rs
}  // namespace grc
