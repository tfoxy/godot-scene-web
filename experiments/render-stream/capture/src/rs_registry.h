// The late-arm resource registry (protocol/late-arm-registry-design.md, LAR0): one entry per live
// RID the hooks saw created, so a later arm can tell what each referenced RID is without
// inferring it from a failed getter.
//
// LAR0 is the core only: every tracked create records its kind, a free erases its entry, and the
// evidence (evidence/registry.json) reports entries, peak, creates, frees and overflow per family
// plus a change timeline. Nothing reads it yet: the resource families move onto it in LAR1-LAR5,
// so adoption is unchanged by this file.
//
// Rules (design R1, R3, R5, R6):
//   - Gating: registry_configure() runs once, before the vptr store, from GRC_ADOPT. With
//     GRC_ADOPT=off nothing is recorded: every hook pays one relaxed atomic load and a predictable
//     branch (registry_on()).
//   - Recording continues while armed; the registry describes every live tracked RID, so it is
//     never reset by an arm, a disarm or a stream begin.
//   - No eviction. A free erases its entry before the call is forwarded (so a recycled value starts
//     clean); texture_replace(a, b) erases b, which the engine frees inside the call. Size is
//     bounded by the engine's live resources. A per-family safety cap (default 1 Mi) stops that
//     family recording past it and counts `overflow`, so a failure is typed, not silent.
//   - One mutex, a leaf lock: never held across an engine, mirror or log call. Callers may hold
//     g_texture_order (lock order: g_texture_order, then the registry); the registry never takes
//     another lock.
//   - Accounting per family: `creates` counts recorded creates, `frees` counts free calls naming a
//     registered RID of the family, `replaced` the texture_replace sources erased, `recreated` a
//     create of a value already present (overwritten; never seen on Godot, whose RID values are not
//     reused). So, at every instant, entries == creates - frees - replaced - recreated, and
//     creates + overflow + null_creates == the family's create-hook calls. registry-live-bound
//     (run-gate8.sh g8a) judges both on every timeline row.
//
// Engine-free, so a ctest drives it (test/rs_registry_test.cpp).
#ifndef GRC_RS_REGISTRY_H
#define GRC_RS_REGISTRY_H

#include <atomic>
#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

namespace grc {
namespace rs {

// What a tracked create made. The hooked creates only (hooks.cpp): texture_2d_layered_create,
// texture_proxy_create and the 3D texture creates are not hooked, so they have no kind yet.
enum class RegistryKind : std::uint8_t {
  Texture2d,           // texture_2d_create
  TexturePlaceholder,  // texture_2d_placeholder_create
  CanvasTexture,       // canvas_texture_create (after the headless shim's private RID)
  Mesh,                // mesh_create, mesh_create_from_surfaces
  Multimesh,           // multimesh_create
  Shader,              // shader_create, shader_create_from_code
  Material,            // material_create, material_create_from_shader
  Particles,           // particles_create (after the headless shim's private RID)
};

// The evidence groups kinds into families (both texture kinds are `texture`).
enum class RegistryFamily : std::uint8_t {
  Texture,
  CanvasTexture,
  Mesh,
  Multimesh,
  Shader,
  Material,
  Particles,
};
constexpr std::size_t kRegistryFamilies = 7;

RegistryFamily registry_family(RegistryKind kind);
const char *registry_family_name(RegistryFamily family);
const char *registry_kind_name(RegistryKind kind);

// The registry's own fault knobs, parsed from GRC_ADOPT_FAULT (rs_adopt.h AdoptFault):
//   registry-off        record nothing (a deferred leg becomes a load-late one; LAR1+ sabotages)
//   registry-keep-freed the free hook keeps the entry (LAR0's sabotage: fails registry-live-bound)
enum class RegistryFault : std::uint8_t { None, Off, KeepFreed };
const char *registry_fault_name(RegistryFault fault);

constexpr std::size_t kRegistryDefaultCap = std::size_t{1} << 20;  // entries per family
constexpr std::size_t kRegistryTimelineCap = 1024;                 // timeline rows kept

struct RegistryFamilyStats {
  std::uint64_t entries = 0;
  std::uint64_t peak = 0;
  std::uint64_t creates = 0;
  std::uint64_t frees = 0;
  std::uint64_t replaced = 0;
  std::uint64_t recreated = 0;
  std::uint64_t null_creates = 0;  // the create returned RID() (nothing to record)
  std::uint64_t overflow = 0;      // creates not recorded: the family was at its cap
};

struct RegistryStats {
  bool configured = false;  // registry_configure() ran with GRC_ADOPT=arm
  bool enabled = false;     // recording (configured and not registry-off)
  RegistryFault fault = RegistryFault::None;
  std::size_t cap = kRegistryDefaultCap;
  RegistryFamilyStats family[kRegistryFamilies];
  std::uint64_t entries = 0;  // all families
  std::uint64_t peak = 0;     // all families, at once
  // An estimate (design R3): the flat map's slot array (at most half full; it never shrinks, so it
  // follows the peak).
  std::uint64_t bytes_estimate = 0;
  std::uint64_t entry_bytes = 0;  // the per-entry part of bytes_estimate
};

// One timeline row: the per-family counts after a frame in which the registry changed. `frame` is
// the hook frame label those calls carried (hooks_set_frame).
struct RegistryRow {
  std::uint64_t frame = 0;
  std::uint32_t entries[kRegistryFamilies] = {};
  std::uint32_t creates[kRegistryFamilies] = {};
  std::uint32_t frees[kRegistryFamilies] = {};  // frees + replaced + recreated
};

// The hot-path gate: one relaxed load. Set only by registry_configure().
extern std::atomic<bool> g_registry_on;
inline bool registry_on() { return g_registry_on.load(std::memory_order_relaxed); }

// Once, before the vptr store (entry.cpp attempt()). `adopt` is GRC_ADOPT=arm. Resets the
// registry (tests call it between cases).
void registry_configure(bool adopt, RegistryFault fault, std::size_t cap = kRegistryDefaultCap);

// The hooks (only when registry_on()). A null `rid` counts null_creates and records nothing.
void registry_note_create(std::uint64_t rid, RegistryKind kind);
void registry_note_free(std::uint64_t rid);
void registry_note_replace(std::uint64_t texture, std::uint64_t by_texture);

// LAR1+: the recorded kind of a live RID (false: not registered).
bool registry_lookup(std::uint64_t rid, RegistryKind *kind);

// The frame callback (entry.cpp on_frame): appends a timeline row when anything changed since the
// last row. Cheap when nothing did (one relaxed load).
void registry_frame(std::uint64_t frame);

RegistryStats registry_stats();
std::vector<RegistryRow> registry_timeline(std::uint64_t *dropped);

// evidence/registry.json (schema render-stream-registry/1), written beside counters.json.
std::string registry_json();

}  // namespace rs
}  // namespace grc

#endif
