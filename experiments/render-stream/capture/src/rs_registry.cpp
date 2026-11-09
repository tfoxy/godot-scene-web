// The late-arm resource registry (rs_registry.h).
#include "rs_registry.h"

#include <algorithm>
#include <deque>
#include <mutex>
#include <unordered_map>
#include <utility>

#include "report.h"
#include "rs_rid_map.h"
#include "rs_texture_payload.h"

namespace grc {
namespace rs {

std::atomic<bool> g_registry_on{false};

namespace {

constexpr std::uint8_t kUpdated = 1, kReleased = 2, kEdited = 4, kFacts = 8,
                       kMipmaps = 16, kHasPath = 32;
struct Entry {
  RegistryKind kind = RegistryKind::Texture2d;
  std::uint8_t flags = 0;
  std::uint8_t format = 0;
  std::uint8_t reserved = 0;
  std::uint16_t width = 0;
  std::uint16_t height = 0;
};
static_assert(sizeof(Entry) == 8, "texture facts fit in the kind slot");
static_assert(sizeof(RidMap<Entry>::value_type) == 16, "the registry slot is one quarter line");

struct State {
  std::mutex mutex;  // leaf lock (rs_registry.h)
  bool configured = false;
  RegistryFault fault = RegistryFault::None;
  std::size_t cap = kRegistryDefaultCap;
  // The flat open-addressed map (rs_rid_map.h): one slot holds key and kind, so a create or a free
  // costs one multiply and usually one cache line, and no node allocation, where a
  // std::unordered_map costs far more per call in situ (a cold bucket array, a cold node, malloc/free).
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
  // LAR2: the multimesh payload, one slot per registered multimesh (likewise a subset of `map`'s
  // keys, created and erased with the kind entry).
  RidMap<RegistryMultimesh> multimesh;
  std::uint64_t multimesh_capacity = 0;
  std::uint64_t multimesh_sets = 0;
  // LAR3: the shader and material payloads (subsets of `map`'s keys, created and erased with the
  // kind entry). Their values hold engine references (RegistryValue), released outside the lock.
  RidMap<RegistryShader> shader;
  std::uint64_t shader_capacity = 0;
  std::uint64_t shader_sets = 0;
  RidMap<RegistryMaterial> material;
  std::uint64_t material_capacity = 0;
  std::uint64_t material_sets = 0;
  std::uint64_t material_params = 0;  // live recorded parameters, all materials
  // LS0: the interned parameter names. Immortal texts (a deque never moves its elements); `by_key`
  // is a small open-addressed table from a StringName's identity to its name (names are few and
  // hot, so it stays in cache), `by_text` serves the by-text entry point.
  struct NameEntry {
    std::string text;
    RegistryValue keepalive;  // the StringName copy that keeps `key` naming this text
    std::uintptr_t key = 0;
  };
  std::deque<NameEntry> names;
  std::unordered_map<std::string, NameEntry *> by_text;
  struct KeySlot {
    std::uintptr_t key = 0;
    const std::string *text = nullptr;
  };
  std::vector<KeySlot> by_key;
  std::size_t by_key_used = 0;
  // LAR5: the particles payload (a subset of `map`'s keys, created and erased with the kind entry).
  RidMap<RegistryParticles> particles;
  std::uint64_t particles_capacity = 0;
  std::uint64_t particles_sets = 0;
  std::uint64_t particles_elements = 0;  // live trail-pose floats and draw-pass RIDs, all emitters
  RegistryFamilyStats family[kRegistryFamilies];
  std::uint64_t entries = 0;
  std::uint64_t peak = 0;
  // Bumped (under the lock) by every mutation; registry_frame() compares it with the last row's
  // without taking the lock.
  std::atomic<std::uint64_t> generation{0};
  std::uint64_t row_generation = 0;
  std::vector<RegistryRow> timeline;
  std::uint64_t timeline_dropped = 0;
  RidMap<RegistryValue> paths;
  std::uint64_t path_capacity = 0;
  std::uint64_t path_sets = 0;
  std::uint64_t texture_facts = 0;
  std::uint64_t texture_released = 0;
};

State &state() {
  // Never destroyed: LAR3's payloads hold engine Strings and Variants, whose destructors must not
  // run from a static destructor after the engine (or this library) is gone.
  static State *s = new State();
  return *s;
}

// LAR3: engine values a mutation displaced, released once the registry's lock is dropped (declare
// one before the lock_guard, so it is destroyed after it).
struct Dropped {
  std::vector<RegistryValue> values;
  void shader(RegistryShader &&p) {
    if (p.code != nullptr) values.push_back(std::move(p.code));
  }
  void material(RegistryMaterial &&p) {
    for (RegistryParam &param : p.params) {
      if (param.value != nullptr) values.push_back(std::move(param.value));
    }
  }
};

// Called only for a slot whose path bit was set: other resource families never access paths.
void path_erase_locked(State &s, std::uint64_t rid, Dropped *dropped) {
  const auto it = s.paths.find(rid);
  if (it != s.paths.end()) {
    dropped->values.push_back(std::move(it->second));
    s.paths.erase(rid);
  }
}

RegistryTextureRecord texture_record_locked(State &s, std::uint64_t rid, const Entry &entry) {
  RegistryTextureRecord out;
  out.rid = rid;
  out.kind = entry.kind;
  if (entry.flags & kFacts) {
    out.facts = {entry.width, entry.height, entry.format, (entry.flags & kMipmaps) != 0, true};
  }
  out.released = (entry.flags & kReleased) != 0;
  out.edited = (entry.flags & kEdited) != 0;
  out.updated = (entry.flags & kUpdated) != 0;
  if (entry.flags & kHasPath) out.path = s.paths.find(rid)->second;
  return out;
}

std::size_t index(RegistryFamily family) { return static_cast<std::size_t>(family); }

// One slot of the flat map (key and kind, padded).
constexpr std::uint64_t kNodeBytes = sizeof(RidMap<Entry>::value_type);
// One slot of the CanvasTexture payload map (key and RegistryCanvasTexture).
constexpr std::uint64_t kCanvasNodeBytes = sizeof(RidMap<RegistryCanvasTexture>::value_type);
// One slot of the multimesh payload map (key and RegistryMultimesh).
constexpr std::uint64_t kMultimeshNodeBytes = sizeof(RidMap<RegistryMultimesh>::value_type);
// LAR3: one slot of the shader and material payload maps, and one recorded parameter (its name's
// heap bytes beyond the small-string buffer are not counted; the Variant itself is the engine's).
constexpr std::uint64_t kShaderNodeBytes = sizeof(RidMap<RegistryShader>::value_type);
constexpr std::uint64_t kMaterialNodeBytes = sizeof(RidMap<RegistryMaterial>::value_type);
constexpr std::uint64_t kParamBytes = sizeof(RegistryParam);
// LAR5: one slot of the particles payload map; a trail-pose float or draw-pass RID counts 8 B.
constexpr std::uint64_t kParticlesNodeBytes = sizeof(RidMap<RegistryParticles>::value_type);
constexpr std::uint64_t kParticlesElementBytes = 8;

std::uint64_t particles_elements(const RegistryParticles &p) {
  return p.poses.size() + p.passes.size();
}

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

// A multimesh create: a fresh payload (the engine's new multimesh: nothing allocated).
void multimesh_create_locked(State &s, std::uint64_t rid) {
  if (s.multimesh.find(rid) == s.multimesh.end()) {
    track_growth(s.multimesh.size(), &s.multimesh_capacity);
  }
  s.multimesh[rid] = RegistryMultimesh();
}

// LAR5: an emitter create: a fresh payload (GLES3's new emitter).
void particles_create_locked(State &s, std::uint64_t rid) {
  const auto it = s.particles.find(rid);
  if (it == s.particles.end()) {
    track_growth(s.particles.size(), &s.particles_capacity);
    s.particles[rid] = RegistryParticles();
    return;
  }
  s.particles_elements -= particles_elements(it->second);
  it->second = RegistryParticles();
}

// LAR3: a shader or material create: a fresh payload (a recycled value's old one is dropped).
void shader_create_locked(State &s, std::uint64_t rid, Dropped *dropped) {
  const auto it = s.shader.find(rid);
  if (it == s.shader.end()) {
    track_growth(s.shader.size(), &s.shader_capacity);
    s.shader[rid] = RegistryShader();
    return;
  }
  dropped->shader(std::move(it->second));
  it->second = RegistryShader();
}

void material_create_locked(State &s, std::uint64_t rid, Dropped *dropped) {
  const auto it = s.material.find(rid);
  if (it == s.material.end()) {
    track_growth(s.material.size(), &s.material_capacity);
    s.material[rid] = RegistryMaterial();
    return;
  }
  s.material_params -= it->second.params.size();
  dropped->material(std::move(it->second));
  it->second = RegistryMaterial();
}

// A create of `kind` on `rid` (fresh or recreated): the payload maps follow the kind entry.
void payload_create_locked(State &s, std::uint64_t rid, RegistryKind kind, Dropped *dropped) {
  if (kind == RegistryKind::CanvasTexture) {
    canvas_create_locked(s, rid);
  } else if (kind == RegistryKind::Multimesh) {
    multimesh_create_locked(s, rid);
  } else if (kind == RegistryKind::Shader) {
    shader_create_locked(s, rid, dropped);
  } else if (kind == RegistryKind::Material) {
    material_create_locked(s, rid, dropped);
  } else if (kind == RegistryKind::Particles) {
    particles_create_locked(s, rid);
  }
}

void payload_erase_locked(State &s, std::uint64_t rid, RegistryFamily family, Dropped *dropped) {
  if (family == RegistryFamily::CanvasTexture) {
    s.canvas.erase(rid);
  } else if (family == RegistryFamily::Multimesh) {
    s.multimesh.erase(rid);
  } else if (family == RegistryFamily::Shader) {
    const auto it = s.shader.find(rid);
    if (it != s.shader.end()) {
      dropped->shader(std::move(it->second));
      s.shader.erase(rid);
    }
  } else if (family == RegistryFamily::Material) {
    const auto it = s.material.find(rid);
    if (it != s.material.end()) {
      s.material_params -= it->second.params.size();
      dropped->material(std::move(it->second));
      s.material.erase(rid);
    }
  } else if (family == RegistryFamily::Particles) {
    const auto it = s.particles.find(rid);
    if (it != s.particles.end()) {
      s.particles_elements -= particles_elements(it->second);
      s.particles.erase(rid);
    }
  }
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
  case RegistryFault::SkipParams: return "registry-skip-params";
  case RegistryFault::DropBinding: return "registry-drop-binding";
  case RegistryFault::SkipParticles: return "registry-skip-particles";
  }
  return "?";
}

void registry_configure(bool adopt, RegistryFault fault, std::size_t cap) {
  State &s = state();
  RidMap<RegistryShader> old_shaders;      // released after the lock (RegistryValue)
  RidMap<RegistryMaterial> old_materials;
  RidMap<RegistryValue> old_paths;
  std::lock_guard<std::mutex> lock(s.mutex);
  std::swap(old_shaders, s.shader);
  std::swap(old_materials, s.material);
  std::swap(old_paths, s.paths);
  s.path_capacity = 0;
  s.path_sets = 0;
  s.texture_facts = 0;
  s.texture_released = 0;
  s.shader_capacity = 0;
  s.shader_sets = 0;
  s.material_capacity = 0;
  s.material_sets = 0;
  s.material_params = 0;
  s.configured = adopt;
  s.fault = adopt ? fault : RegistryFault::None;
  s.cap = cap;
  s.map.clear();
  s.capacity = 0;
  s.canvas.clear();
  s.canvas_capacity = 0;
  s.canvas_sets = 0;
  s.multimesh.clear();
  s.multimesh_capacity = 0;
  s.multimesh_sets = 0;
  s.particles.clear();
  s.particles_capacity = 0;
  s.particles_sets = 0;
  s.particles_elements = 0;
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

namespace {
bool create_locked(State &s, std::uint64_t rid, Entry entry, Dropped *dropped) {
  const RegistryKind kind = entry.kind;
  const RegistryFamily family = registry_family(kind);
  RegistryFamilyStats &f = s.family[index(family)];
  if (rid == 0) {
    ++f.null_creates;
    return false;
  }
  const auto it = s.map.find(rid);
  if (it != s.map.end()) {
    // A value already present: the last create wins (R5), counted against the old family.
    const RegistryFamily old = registry_family(it->second.kind);
    ++s.family[index(old)].recreated;
    remove_entry_locked(s, old);
    if (it->second.flags & kHasPath) path_erase_locked(s, rid, dropped);
    it->second = entry;
    ++f.creates;
    add_entry_locked(s, family);
    if (old != family) {
      payload_erase_locked(s, rid, old, dropped);
    }
    payload_create_locked(s, rid, kind, dropped);
    changed_locked(s);
    return true;
  }
  if (f.entries >= s.cap) {
    ++f.overflow;  // its later references fall to the residual path (design Q3)
    return false;
  }
  track_growth(s.map.size(), &s.capacity);
  s.map[rid] = entry;
  payload_create_locked(s, rid, kind, dropped);
  ++f.creates;
  add_entry_locked(s, family);
  changed_locked(s);
  return true;
}

}  // namespace

void registry_note_create(std::uint64_t rid, RegistryKind kind) {
  State &s = state();
  Dropped dropped;
  std::lock_guard<std::mutex> lock(s.mutex);
  const RegistryFamily family = registry_family(kind);
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
    if (it->second.flags & kHasPath) path_erase_locked(s, rid, &dropped);
    it->second = Entry{kind};
    ++f.creates;
    add_entry_locked(s, family);
    if (old != family) {
      payload_erase_locked(s, rid, old, &dropped);
    }
    payload_create_locked(s, rid, kind, &dropped);
    changed_locked(s);
    return;
  }
  if (f.entries >= s.cap) {
    ++f.overflow;  // its later references fall to the residual path (design Q3)
    return;
  }
  track_growth(s.map.size(), &s.capacity);
  s.map[rid] = Entry{kind};
  payload_create_locked(s, rid, kind, &dropped);
  ++f.creates;
  add_entry_locked(s, family);
  changed_locked(s);
}

void registry_note_texture_create(std::uint64_t rid, const RegistryTextureFacts &facts,
                                  bool released) {
  Entry entry;
  if (released) entry.flags |= kReleased;
  if (facts.known && facts.width >= 1 && facts.width <= 65535 &&
      facts.height >= 1 && facts.height <= 65535 && facts.format >= 0 &&
      facts.format < kImageFormatCount) {
    entry.flags |= kFacts;
    if (facts.mipmaps) entry.flags |= kMipmaps;
    entry.width = static_cast<std::uint16_t>(facts.width);
    entry.height = static_cast<std::uint16_t>(facts.height);
    entry.format = static_cast<std::uint8_t>(facts.format);
  }
  State &s = state();
  Dropped dropped;
  std::lock_guard<std::mutex> lock(s.mutex);
  if (create_locked(s, rid, entry, &dropped)) {
    if (entry.flags & kFacts) ++s.texture_facts;
    if (released) ++s.texture_released;
  }
}

void registry_note_texture_path(std::uint64_t rid, RegistryValue path) {
  State &s = state();
  Dropped dropped;
  std::lock_guard<std::mutex> lock(s.mutex);
  const auto it = s.map.find(rid);
  if (it == s.map.end() || registry_family(it->second.kind) != RegistryFamily::Texture) return;
  if (it->second.flags & kHasPath) {
    auto &held = s.paths.find(rid)->second;
    dropped.values.push_back(std::move(held));
    held = std::move(path);
  } else {
    track_growth(s.paths.size(), &s.path_capacity);
    s.paths[rid] = std::move(path);
    it->second.flags |= kHasPath;
  }
  ++s.path_sets;
}

bool registry_texture_set_released(std::uint64_t rid, bool released) {
  State &s = state();
  std::lock_guard<std::mutex> lock(s.mutex);
  const auto it = s.map.find(rid);
  if (it == s.map.end() || registry_family(it->second.kind) != RegistryFamily::Texture) return false;
  if (released) it->second.flags |= kReleased;
  else it->second.flags &= ~kReleased;
  return true;
}

bool registry_texture(std::uint64_t rid, RegistryTextureRecord *out) {
  State &s = state();
  RegistryTextureRecord record;
  {
    std::lock_guard<std::mutex> lock(s.mutex);
    const auto it = s.map.find(rid);
    if (it == s.map.end() || registry_family(it->second.kind) != RegistryFamily::Texture) return false;
    if (out != nullptr) record = texture_record_locked(s, rid, it->second);
  }
  if (out != nullptr) *out = std::move(record);
  return true;
}

void registry_textures(std::vector<RegistryTextureRecord> *out) {
  if (out == nullptr) return;
  State &s = state();
  std::vector<RegistryTextureRecord> records;
  {
    std::lock_guard<std::mutex> lock(s.mutex);
    records.reserve(s.family[index(RegistryFamily::Texture)].entries);
    s.map.for_each([&](const auto &slot) {
      if (registry_family(slot.second.kind) == RegistryFamily::Texture) {
        records.push_back(texture_record_locked(s, slot.first, slot.second));
      }
    });
  }
  out->swap(records);  // Previous output references are released outside the lock too.
}

void registry_note_free(std::uint64_t rid) {
  State &s = state();
  Dropped dropped;  // released after the lock
  std::lock_guard<std::mutex> lock(s.mutex);
  const auto it = s.map.find(rid);
  if (it == s.map.end()) {
    return;  // untracked (a canvas item, a viewport...), pre-load, overflowed or internal
  }
  const RegistryFamily family = registry_family(it->second.kind);
  ++s.family[index(family)].frees;
  if (s.fault != RegistryFault::KeepFreed) {
    if (it->second.flags & kHasPath) path_erase_locked(s, rid, &dropped);
    s.map.erase(rid);
    payload_erase_locked(s, rid, family, &dropped);
    remove_entry_locked(s, family);
  }
  changed_locked(s);
}

void registry_note_replace(std::uint64_t texture, std::uint64_t by_texture) {
  // The engine moves b's data into a and frees b inside the call. a takes b's kind,
  // creation facts, release and edit flags, with updated set and no path. An unregistered a
  // stays unregistered: it was never a recorded create.
  State &s = state();
  Dropped dropped;
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
    if (into->second.flags & kHasPath) path_erase_locked(s, texture, &dropped);
    into->second = it->second;
    into->second.flags = (it->second.flags & (kReleased | kEdited | kFacts | kMipmaps)) | kUpdated;
  }
  const RegistryFamily family = registry_family(it->second.kind);
  ++s.family[index(family)].replaced;
  if (it->second.flags & kHasPath) path_erase_locked(s, by_texture, &dropped);
  s.map.erase(by_texture);
  remove_entry_locked(s, family);
  changed_locked(s);
}

bool registry_lookup(std::uint64_t rid, RegistryKind *kind, bool *updated) {
  State &s = state();
  std::lock_guard<std::mutex> lock(s.mutex);
  const auto it = s.map.find(rid);
  if (it == s.map.end()) {
    return false;
  }
  if (kind != nullptr) {
    *kind = it->second.kind;
  }
  if (updated != nullptr) {
    *updated = (it->second.flags & kUpdated) != 0;
  }
  return true;
}

void registry_note_texture_update(std::uint64_t rid) {
  State &s = state();
  std::lock_guard<std::mutex> lock(s.mutex);
  const auto it = s.map.find(rid);
  if (it != s.map.end() && registry_family(it->second.kind) == RegistryFamily::Texture) {
    it->second.flags |= kUpdated | kEdited;  // a bit only (R5): no payload, no timeline row
  }
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

// --- LAR2: the multimesh payload ---------------------------------------------------------------

namespace {

// The registered multimesh `rid`'s payload, or null. Under the lock.
RegistryMultimesh *multimesh_locked(State &s, std::uint64_t rid) {
  const auto it = s.multimesh.find(rid);
  return it != s.multimesh.end() ? &it->second : nullptr;
}

}  // namespace

std::int32_t registry_multimesh_stride(std::int32_t format, bool colors, bool custom) {
  return (format == 1 ? 12 : 8) + (colors ? 4 : 0) + (custom ? 4 : 0);
}

void registry_note_multimesh_allocate(std::uint64_t rid, std::int32_t instances,
                                      std::int32_t format, bool colors, bool custom,
                                      bool indirect) {
  if (instances < 0 || (format != 0 && format != 1)) {
    return;  // the engine refuses both (MultiMesh and RS have two formats, no negative count)
  }
  State &s = state();
  std::lock_guard<std::mutex> lock(s.mutex);
  RegistryMultimesh *m = multimesh_locked(s, rid);
  if (m == nullptr) {
    return;
  }
  m->indirect = indirect;
  const bool same = m->allocated && m->instances == instances && m->format == format &&
                    m->colors == colors && m->custom == custom;
  if (!same) {
    m->instances = instances;
    m->format = format;
    m->colors = colors;
    m->custom = custom;
    m->visible = m->visible < instances ? m->visible : instances;
    m->edited = false;  // a new, zeroed buffer
  }
  m->allocated = true;
  ++s.multimesh_sets;
}

void registry_note_multimesh_mesh(std::uint64_t rid, std::uint64_t mesh) {
  State &s = state();
  std::lock_guard<std::mutex> lock(s.mutex);
  RegistryMultimesh *m = multimesh_locked(s, rid);
  if (m == nullptr) {
    return;
  }
  m->mesh = mesh;
  ++s.multimesh_sets;
}

void registry_note_multimesh_visible(std::uint64_t rid, std::int32_t visible) {
  State &s = state();
  std::lock_guard<std::mutex> lock(s.mutex);
  RegistryMultimesh *m = multimesh_locked(s, rid);
  if (m == nullptr || visible < -1 || visible > m->instances) {
    return;  // the engine refuses a count outside -1..instances
  }
  m->visible = visible;
  ++s.multimesh_sets;
}

void registry_note_multimesh_custom_aabb(std::uint64_t rid, const std::array<float, 6> &aabb) {
  State &s = state();
  std::lock_guard<std::mutex> lock(s.mutex);
  RegistryMultimesh *m = multimesh_locked(s, rid);
  if (m == nullptr) {
    return;
  }
  m->custom_aabb = aabb;
  ++s.multimesh_sets;
}

void registry_note_multimesh_buffer(std::uint64_t rid, std::size_t floats) {
  State &s = state();
  std::lock_guard<std::mutex> lock(s.mutex);
  RegistryMultimesh *m = multimesh_locked(s, rid);
  if (m == nullptr) {
    return;
  }
  const std::size_t expected =
      static_cast<std::size_t>(m->instances) *
      static_cast<std::size_t>(registry_multimesh_stride(m->format, m->colors, m->custom));
  if (floats == expected) {
    m->edited = false;
  }
  ++s.multimesh_sets;
}

void registry_note_multimesh_instance_edit(std::uint64_t rid) {
  State &s = state();
  std::lock_guard<std::mutex> lock(s.mutex);
  RegistryMultimesh *m = multimesh_locked(s, rid);
  if (m == nullptr) {
    return;
  }
  m->edited = true;
  ++s.multimesh_sets;
}

bool registry_multimesh(std::uint64_t rid, RegistryMultimesh *out) {
  State &s = state();
  std::lock_guard<std::mutex> lock(s.mutex);
  const RegistryMultimesh *m = multimesh_locked(s, rid);
  if (m == nullptr) {
    return false;
  }
  if (out != nullptr) {
    *out = *m;
  }
  return true;
}

// --- LAR3: the shader and material payloads ------------------------------------------------------

void registry_note_shader_code(std::uint64_t rid, RegistryValue code) {
  State &s = state();
  RegistryValue old;  // released after the lock
  std::lock_guard<std::mutex> lock(s.mutex);
  const auto it = s.shader.find(rid);
  if (it == s.shader.end()) {
    old = std::move(code);  // not a registered shader: nothing recorded
    return;
  }
  old = std::move(it->second.code);
  it->second.code = std::move(code);
  ++s.shader_sets;
}

void registry_note_shader_default_texture(std::uint64_t rid, const std::string &name,
                                          std::uint64_t texture, std::int32_t index) {
  State &s = state();
  std::lock_guard<std::mutex> lock(s.mutex);
  const auto it = s.shader.find(rid);
  if (it == s.shader.end()) {
    return;
  }
  std::vector<RegistryDefaultTexture> &defaults = it->second.defaults;
  auto d = defaults.begin();
  while (d != defaults.end() && !(d->name == name && d->index == index)) {
    ++d;
  }
  if (texture == 0) {
    if (d != defaults.end()) {
      defaults.erase(d);  // the engine erases a RID() default (material_storage.cpp)
    }
  } else if (d != defaults.end()) {
    d->texture = texture;
  } else {
    defaults.push_back(RegistryDefaultTexture{name, index, texture});
  }
  ++s.shader_sets;
}

void registry_note_material_shader(std::uint64_t rid, std::uint64_t shader) {
  State &s = state();
  std::lock_guard<std::mutex> lock(s.mutex);
  const auto it = s.material.find(rid);
  if (it == s.material.end() || s.fault == RegistryFault::DropBinding) {
    return;
  }
  it->second.shader = shader;
  ++s.material_sets;
}

namespace {

std::size_t key_slot(std::uintptr_t key, std::size_t mask) {
  return static_cast<std::size_t>((key * 0x9E3779B97F4A7C15ull) >> 24) & mask;
}

const std::string *find_key_locked(State &s, std::uintptr_t key) {
  if (key == 0 || s.by_key.empty()) {
    return nullptr;
  }
  const std::size_t mask = s.by_key.size() - 1;
  for (std::size_t i = key_slot(key, mask);; i = (i + 1) & mask) {
    const State::KeySlot &slot = s.by_key[i];
    if (slot.key == key) {
      return slot.text;
    }
    if (slot.key == 0) {
      return nullptr;
    }
  }
}

void insert_key_locked(State &s, std::uintptr_t key, const std::string *text) {
  if (key == 0) {
    return;
  }
  if ((s.by_key_used + 1) * 2 > s.by_key.size()) {
    std::vector<State::KeySlot> old;
    old.swap(s.by_key);
    s.by_key.assign(old.empty() ? 64 : old.size() * 2, State::KeySlot());
    s.by_key_used = 0;
    for (const State::KeySlot &slot : old) {
      if (slot.key != 0) {
        insert_key_locked(s, slot.key, slot.text);
      }
    }
  }
  const std::size_t mask = s.by_key.size() - 1;
  std::size_t i = key_slot(key, mask);
  while (s.by_key[i].key != 0 && s.by_key[i].key != key) {
    i = (i + 1) & mask;
  }
  if (s.by_key[i].key == 0) {
    ++s.by_key_used;
  }
  s.by_key[i] = State::KeySlot{key, text};
}

// The interned entry of `text` (made on first sight).
State::NameEntry *intern_locked(State &s, const std::string &text) {
  const auto it = s.by_text.find(text);
  if (it != s.by_text.end()) {
    return it->second;
  }
  s.names.push_back(State::NameEntry{text, nullptr, 0});
  State::NameEntry *entry = &s.names.back();
  s.by_text.emplace(text, entry);
  return entry;
}

// Stores (or erases, with a null `value`) `name` on a material; the caller holds the lock and
// releases `old` after it.
void param_store_locked(State &s, std::uint64_t rid, RegistryName name, RegistryValue &&value,
                        RegistryValue *old) {
  if (s.fault == RegistryFault::SkipParams) {
    *old = std::move(value);
    return;
  }
  const auto it = s.material.find(rid);
  if (it == s.material.end()) {
    *old = std::move(value);
    return;
  }
  std::vector<RegistryParam> &params = it->second.params;
  auto p = params.begin();
  while (p != params.end() && !p->name.same(name)) {
    ++p;
  }
  if (value == nullptr) {
    if (p != params.end()) {
      *old = std::move(p->value);
      params.erase(p);
      --s.material_params;
    }
  } else if (p != params.end()) {
    *old = std::move(p->value);
    p->value = std::move(value);
  } else {
    params.push_back(RegistryParam{name, std::move(value)});
    ++s.material_params;
  }
  ++s.material_sets;
}

}  // namespace

void registry_note_material_param(std::uint64_t rid, RegistryName name, RegistryValue value) {
  State &s = state();
  RegistryValue old;  // released after the lock
  std::lock_guard<std::mutex> lock(s.mutex);
  param_store_locked(s, rid, name, std::move(value), &old);
}

void registry_note_material_param(std::uint64_t rid, const std::string &name, RegistryValue value) {
  State &s = state();
  RegistryValue old;  // released after the lock
  std::lock_guard<std::mutex> lock(s.mutex);
  param_store_locked(s, rid, RegistryName(&intern_locked(s, name)->text), std::move(value), &old);
}

RegistryName registry_name_find(std::uintptr_t key) {
  State &s = state();
  std::lock_guard<std::mutex> lock(s.mutex);
  return RegistryName(find_key_locked(s, key));
}

RegistryName registry_name_intern(std::uintptr_t key, const std::string &text,
                                  RegistryValue keepalive) {
  State &s = state();
  RegistryName name;
  {
    std::lock_guard<std::mutex> lock(s.mutex);
    State::NameEntry *entry = intern_locked(s, text);
    // A key is cached only with its keepalive, and only for the first live identity of a text (the
    // engine interns, so a second one does not occur); otherwise the caller decodes each time.
    if (key != 0 && keepalive != nullptr && entry->keepalive == nullptr) {
      entry->keepalive = std::move(keepalive);
      entry->key = key;
      insert_key_locked(s, key, &entry->text);
    }
    name = RegistryName(&entry->text);
  }
  return name;  // a keepalive that was not stored is released here, after the lock
}

RegistryParamFast registry_note_param_fast(std::uint64_t rid, std::uintptr_t key,
                                           const void *variant, RegistryOverwrite overwrite,
                                           RegistryName *name) {
  State &s = state();
  std::lock_guard<std::mutex> lock(s.mutex);
  if (s.fault == RegistryFault::SkipParams) {
    return RegistryParamFast::Recorded;
  }
  const std::string *text = find_key_locked(s, key);
  if (text == nullptr) {
    return RegistryParamFast::NeedName;
  }
  const auto it = s.material.find(rid);
  if (it == s.material.end()) {
    return RegistryParamFast::Recorded;
  }
  *name = RegistryName(text);
  for (RegistryParam &p : it->second.params) {
    if (p.name.same(*name)) {
      // Only the registry holds it (a copy handed out under this lock shares the count), and the
      // hook says the old value can be destroyed here: store the new one over it.
      if (p.value.use_count() == 1 && overwrite(p.value.get(), variant)) {
        ++s.material_sets;
        return RegistryParamFast::Recorded;
      }
      break;
    }
  }
  return RegistryParamFast::NeedValue;
}

void registry_names_release() {
  State &s = state();
  std::vector<RegistryValue> released;  // destroyed after the lock
  {
    std::lock_guard<std::mutex> lock(s.mutex);
    for (State::NameEntry &e : s.names) {
      if (e.keepalive != nullptr) {
        released.push_back(std::move(e.keepalive));
      }
      e.key = 0;
    }
    s.by_key.clear();
    s.by_key_used = 0;
  }
}

bool registry_shader(std::uint64_t rid, RegistryShader *out) {
  State &s = state();
  std::lock_guard<std::mutex> lock(s.mutex);
  const auto it = s.shader.find(rid);
  if (it == s.shader.end()) {
    return false;
  }
  if (out != nullptr) {
    *out = it->second;  // the copy shares the engine values (reference counts, no engine call)
  }
  return true;
}

bool registry_material(std::uint64_t rid, RegistryMaterial *out) {
  State &s = state();
  std::lock_guard<std::mutex> lock(s.mutex);
  const auto it = s.material.find(rid);
  if (it == s.material.end()) {
    return false;
  }
  if (out != nullptr) {
    *out = it->second;
  }
  return true;
}

// --- LAR5: the particles payload ----------------------------------------------------------------

void registry_note_particles(std::uint64_t rid, RegistryParticlesOp op, std::int64_t i,
                             std::uint64_t ref, const float *f, std::size_t n) {
  State &s = state();
  std::lock_guard<std::mutex> lock(s.mutex);
  if (s.fault == RegistryFault::SkipParticles) {
    return;
  }
  const auto it = s.particles.find(rid);
  if (it == s.particles.end()) {
    return;  // not a registered emitter (pre-load, overflowed or freed)
  }
  RegistryParticles &p = it->second;
  const std::uint64_t before = particles_elements(p);
  switch (op) {
  case RegistryParticlesOp::Mode: p.mode_2d = i == 0; break;  // RS::PARTICLES_MODE_2D
  case RegistryParticlesOp::Emitting: p.emitting = i != 0; break;
  case RegistryParticlesOp::Amount: p.amount = static_cast<std::int32_t>(i); break;
  case RegistryParticlesOp::OneShot: p.one_shot = i != 0; break;
  case RegistryParticlesOp::Local: p.local = i != 0; break;
  case RegistryParticlesOp::FixedFps: p.fixed_fps = static_cast<std::int32_t>(i); break;
  case RegistryParticlesOp::Interpolate: p.interpolate = i != 0; break;
  case RegistryParticlesOp::FractionalDelta: p.fractional_delta = i != 0; break;
  case RegistryParticlesOp::TransformAlign: p.transform_align = static_cast<std::int32_t>(i); break;
  case RegistryParticlesOp::DrawOrder: p.draw_order = static_cast<std::int32_t>(i); break;
  case RegistryParticlesOp::Seed: p.seed = static_cast<std::uint32_t>(i); break;
  case RegistryParticlesOp::Floats:
    if (f != nullptr && i >= 0 && static_cast<std::size_t>(i) + n <= kRegistryParticleFloats) {
      std::copy(f, f + n, p.floats.begin() + i);
    }
    break;
  case RegistryParticlesOp::Trails:
    p.trails = i != 0;
    if (f != nullptr && n >= 1) {
      p.floats[7] = f[0];  // the trail length's slot (Mirror::particles_call SetTrails)
    }
    break;
  case RegistryParticlesOp::TrailBindPoses:
    if (f == nullptr) {
      p.poses.clear();
    } else {
      p.poses.assign(f, f + (n / 12) * 12);
    }
    break;
  case RegistryParticlesOp::ProcessMaterial: p.process_material = ref; break;
  case RegistryParticlesOp::Subemitter: p.subemitter = ref; break;
  case RegistryParticlesOp::DrawPasses:
    if (i >= 0) {
      p.passes.resize(static_cast<std::size_t>(i), 0);  // Vector::resize refuses a negative size
    }
    break;
  case RegistryParticlesOp::DrawPassMesh:
    if (i >= 0 && static_cast<std::size_t>(i) < p.passes.size()) {
      p.passes[static_cast<std::size_t>(i)] = ref;  // else ERR_FAIL_INDEX
    }
    break;
  }
  s.particles_elements = s.particles_elements - before + particles_elements(p);
  ++s.particles_sets;
}

bool registry_particles(std::uint64_t rid, RegistryParticles *out) {
  State &s = state();
  std::lock_guard<std::mutex> lock(s.mutex);
  const auto it = s.particles.find(rid);
  if (it == s.particles.end()) {
    return false;
  }
  if (out != nullptr) {
    *out = it->second;
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
  out.texture_facts = s.texture_facts;
  out.texture_released = s.texture_released;
  out.texture_paths = s.paths.size();
  out.texture_path_sets = s.path_sets;
  out.texture_path_bytes = s.path_capacity * sizeof(RidMap<RegistryValue>::value_type);
  out.entry_bytes = static_cast<std::uint64_t>(s.map.size()) * kNodeBytes +
                    static_cast<std::uint64_t>(s.canvas.size()) * kCanvasNodeBytes +
                    static_cast<std::uint64_t>(s.multimesh.size()) * kMultimeshNodeBytes +
                    static_cast<std::uint64_t>(s.shader.size()) * kShaderNodeBytes +
                    static_cast<std::uint64_t>(s.material.size()) * kMaterialNodeBytes +
                    s.material_params * kParamBytes +
                    static_cast<std::uint64_t>(s.particles.size()) * kParticlesNodeBytes +
                    s.particles_elements * kParticlesElementBytes +
                    s.paths.size() * sizeof(RidMap<RegistryValue>::value_type);
  out.shader_payloads = s.shader.size();
  out.shader_payload_sets = s.shader_sets;
  out.shader_payload_bytes = s.shader_capacity * kShaderNodeBytes;
  out.material_payloads = s.material.size();
  out.material_payload_sets = s.material_sets;
  out.material_params = s.material_params;
  out.material_payload_bytes = s.material_capacity * kMaterialNodeBytes + s.material_params * kParamBytes;
  out.canvas_payloads = s.canvas.size();
  out.canvas_payload_sets = s.canvas_sets;
  out.canvas_payload_bytes = s.canvas_capacity * kCanvasNodeBytes;
  out.multimesh_payloads = s.multimesh.size();
  out.multimesh_payload_sets = s.multimesh_sets;
  out.multimesh_payload_bytes = s.multimesh_capacity * kMultimeshNodeBytes;
  out.particles_payloads = s.particles.size();
  out.particles_payload_sets = s.particles_sets;
  out.particles_payload_bytes =
      s.particles_capacity * kParticlesNodeBytes + s.particles_elements * kParticlesElementBytes;
  // The slot arrays, empty slots included (at most half full, never shrinking: bounded by the
  // peak, not by the current entries).
  out.bytes_estimate = s.capacity * kNodeBytes + out.canvas_payload_bytes +
                       out.multimesh_payload_bytes + out.shader_payload_bytes +
                       out.material_payload_bytes + out.particles_payload_bytes + out.texture_path_bytes;
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
  json.key("texture_facts").unsigned_integer(stats.texture_facts);
  json.key("texture_released").unsigned_integer(stats.texture_released);
  json.key("texture_paths").unsigned_integer(stats.texture_paths);
  json.key("texture_path_sets").unsigned_integer(stats.texture_path_sets);
  json.key("texture_path_bytes").unsigned_integer(stats.texture_path_bytes);
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
                           : static_cast<RegistryFamily>(i) == RegistryFamily::Multimesh
                               ? stats.multimesh_payloads * kMultimeshNodeBytes
                           : static_cast<RegistryFamily>(i) == RegistryFamily::Shader
                               ? stats.shader_payloads * kShaderNodeBytes
                           : static_cast<RegistryFamily>(i) == RegistryFamily::Material
                               ? stats.material_payloads * kMaterialNodeBytes +
                                     stats.material_params * kParamBytes
                           : static_cast<RegistryFamily>(i) == RegistryFamily::Particles
                               ? stats.particles_payloads * kParticlesNodeBytes
                           : static_cast<RegistryFamily>(i) == RegistryFamily::Texture
                               ? stats.texture_paths * sizeof(RidMap<RegistryValue>::value_type)
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
  // LAR2: the multimesh payload (allocation, mesh, visible, custom AABB, edited per multimesh).
  json.key("multimesh").object_begin();
  json.key("entries").unsigned_integer(stats.multimesh_payloads);
  json.key("sets").unsigned_integer(stats.multimesh_payload_sets);
  json.key("node_bytes").unsigned_integer(kMultimeshNodeBytes);
  json.key("bytes_estimate").unsigned_integer(stats.multimesh_payload_bytes);
  json.object_end();
  // LAR3: the shader payload (code reference, default textures) and the material payload (shader
  // binding, parameters).
  json.key("shader").object_begin();
  json.key("entries").unsigned_integer(stats.shader_payloads);
  json.key("sets").unsigned_integer(stats.shader_payload_sets);
  json.key("node_bytes").unsigned_integer(kShaderNodeBytes);
  json.key("bytes_estimate").unsigned_integer(stats.shader_payload_bytes);
  json.object_end();
  json.key("material").object_begin();
  json.key("entries").unsigned_integer(stats.material_payloads);
  json.key("sets").unsigned_integer(stats.material_payload_sets);
  json.key("params").unsigned_integer(stats.material_params);
  json.key("node_bytes").unsigned_integer(kMaterialNodeBytes);
  json.key("param_bytes").unsigned_integer(kParamBytes);
  json.key("bytes_estimate").unsigned_integer(stats.material_payload_bytes);
  json.object_end();
  // LAR5: the particles payload (configuration, floats, poses, process material, draw passes).
  json.key("particles").object_begin();
  json.key("entries").unsigned_integer(stats.particles_payloads);
  json.key("sets").unsigned_integer(stats.particles_payload_sets);
  json.key("node_bytes").unsigned_integer(kParticlesNodeBytes);
  json.key("bytes_estimate").unsigned_integer(stats.particles_payload_bytes);
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
