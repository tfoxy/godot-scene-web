// The late-arm resource registry: one entry per live
// RID the hooks saw created, so a later arm can tell what each referenced RID is without
// inferring it from a failed getter.
//
// LAR0 is the core: every tracked create records its kind, a free erases its entry, and the
// evidence (evidence/registry.json) reports entries, peak, creates, frees and overflow per family
// plus a change timeline. The resource families move onto it one row at a time: LAR1 adds the
// CanvasTexture payload (channels, filter, repeat; RegistryCanvasTexture), which rs_adopt.cpp
// adopts a registered CanvasTexture from, whatever the arm state was when it was recorded. LAR2
// adds the multimesh payload (allocation, mesh, visible count, custom AABB, the `edited` bit;
// RegistryMultimesh): the format RenderingServer has no getter for. LAR3 adds the shader payload
// (the code the server was given, default textures; RegistryShader) and the material payload (its
// shader binding and parameters; RegistryMaterial): the dummy renderer answers shader_get_code
// with "" and material_get_param with NIL, and the registry needs neither.
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

#include "rs_hold.h"

#include <array>
#include <atomic>
#include <cstddef>
#include <cstdint>
#include <memory>
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
//   registry-skip-params material_set_param records nothing (LAR3's sabotage: fails param-parity)
//   registry-drop-binding a material's shader binding is not recorded (LAR4's sabotage: fails
//                       pt-registry-real-shader)
//   registry-skip-particles the particles setters record nothing (LAR5's sabotage: an emitter is
//                       adopted with a fresh emitter's configuration; fails pt-late-lifecycle)
enum class RegistryFault : std::uint8_t {
  None,
  Off,
  KeepFreed,
  SkipParams,
  DropBinding,
  SkipParticles,
};
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
  std::uint64_t texture_facts = 0;      // recorded texture creates with known facts
  std::uint64_t texture_released = 0;   // recorded texture creates forwarded as placeholders
  std::uint64_t texture_paths = 0;      // live paths
  std::uint64_t texture_path_sets = 0;  // recorded path calls
  std::uint64_t texture_path_bytes = 0; // path slot array (in bytes_estimate)
  std::uint64_t entry_bytes = 0;  // the per-entry part of bytes_estimate
  // LAR1: the CanvasTexture payload map (its own flat map; part of bytes_estimate).
  std::uint64_t canvas_payloads = 0;      // live RegistryCanvasTexture entries
  std::uint64_t canvas_payload_sets = 0;  // set_channel/filter/repeat calls recorded
  std::uint64_t canvas_payload_bytes = 0; // its slot array (in bytes_estimate)
  // LAR2: the multimesh payload map (likewise its own flat map; part of bytes_estimate).
  std::uint64_t multimesh_payloads = 0;      // live RegistryMultimesh entries
  std::uint64_t multimesh_payload_sets = 0;  // allocate/mesh/visible/aabb/buffer/instance calls recorded
  std::uint64_t multimesh_payload_bytes = 0; // its slot array (in bytes_estimate)
  // LAR3: the shader and material payload maps (likewise their own flat maps; bytes_estimate counts
  // their slot arrays and the parameter vectors' elements, not the engine's own String and Variant
  // storage, which the registry only references).
  std::uint64_t shader_payloads = 0;        // live RegistryShader entries
  std::uint64_t shader_payload_sets = 0;    // code and default-texture calls recorded
  std::uint64_t shader_payload_bytes = 0;   // its slot array (in bytes_estimate)
  std::uint64_t material_payloads = 0;      // live RegistryMaterial entries
  std::uint64_t material_payload_sets = 0;  // shader and parameter calls recorded
  std::uint64_t material_params = 0;        // live recorded parameters, all materials
  std::uint64_t material_payload_bytes = 0; // its slot array plus the parameter elements
  // LAR5: the particles payload map (its own flat map; bytes_estimate counts its slot array and the
  // trail-pose and draw-pass vectors' elements).
  std::uint64_t particles_payloads = 0;      // live RegistryParticles entries
  std::uint64_t particles_payload_sets = 0;  // particles_set_* calls recorded
  std::uint64_t particles_payload_bytes = 0; // its slot array plus the vectors' elements
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

// LAR1+: the recorded kind of a live RID (false: not registered). LAR6: `updated` (optional) is
// the texture family's "content changed since creation" bit (always false for other families).
bool registry_lookup(std::uint64_t rid, RegistryKind *kind, bool *updated = nullptr);
// The texture_2d_update hook sets a registered texture's `updated` and `edited` bits.
// texture_replace(a, b) sets updated and inherits edited from b; a re-create clears both.
void registry_note_texture_update(std::uint64_t rid);

// LAR1 (design R2): a CanvasTexture's payload -- the state RenderingServer has no getter for
// (memory rs-canvastexture-no-rid-getter): its three channels, filter and repeat, and which of
// them a setter named. A fresh CanvasTexture is all DEFAULT (0) and unset, as the engine's
// CanvasTextureStorage creates one. Recorded for a registered CanvasTexture only (one whose create
// the hooks saw); a setter on any other RID records nothing, so an entry is never a partial view
// of a pre-load CanvasTexture. Last writer wins (R5); the free erases it with the kind entry.
struct RegistryCanvasTexture {
  std::uint64_t diffuse = 0;
  std::uint64_t normal = 0;
  std::uint64_t specular = 0;
  std::int32_t filter = 0;  // RS::CanvasItemTextureFilter, DEFAULT until set
  std::int32_t repeat = 0;  // RS::CanvasItemTextureRepeat, DEFAULT until set
  bool diffuse_set = false;
  bool normal_set = false;
  bool specular_set = false;
  bool filter_set = false;
  bool repeat_set = false;
};

// The canvas_texture_set_* hooks (only when registry_on()). `channel` is
// RS::CanvasTextureChannel (0 diffuse, 1 normal, 2 specular; any other value records nothing).
void registry_note_canvas_channel(std::uint64_t rid, std::int32_t channel, std::uint64_t texture);
void registry_note_canvas_filter(std::uint64_t rid, std::int32_t filter);
void registry_note_canvas_repeat(std::uint64_t rid, std::int32_t repeat);

// The recorded CanvasTexture of a live RID (false: `rid` is not a registered CanvasTexture).
bool registry_canvas_texture(std::uint64_t rid, RegistryCanvasTexture *out);

// LAR2 (design R2, R5): a multimesh's payload -- its allocation (RenderingServer has a getter for
// the instance count, which the dummy renderer answers 0, and none for the transform format, the
// colors, the custom data or indirect), its mesh, visible count and custom AABB (the dummy answers
// RID(), 0 and AABB() for those), and `edited`: an instance setter ran since the last allocation
// or valid buffer set (design O3: on the dummy, whose instance setters are no-ops, the buffer
// getter is then stale). The buffer itself is payload-sized and stays a getter at adoption.
// A fresh multimesh is what the engine creates: 0 instances, 2d, no colors or custom, visible -1,
// a zero AABB. Recorded for a registered multimesh only, as RegistryCanvasTexture is.
struct RegistryMultimesh {
  std::int32_t instances = 0;
  std::int32_t format = 0;  // RS::MultimeshTransformFormat (0 2d, 1 3d)
  bool colors = false;
  bool custom = false;
  bool indirect = false;
  bool allocated = false;  // multimesh_allocate_data was recorded at least once
  bool edited = false;
  std::int32_t visible = -1;
  std::uint64_t mesh = 0;
  std::array<float, 6> custom_aabb = {0.0f, 0.0f, 0.0f, 0.0f, 0.0f, 0.0f};
};

// Floats per instance in the engine's buffer layout ((3d ? 12 : 8) + 4 x colors + 4 x custom).
std::int32_t registry_multimesh_stride(std::int32_t format, bool colors, bool custom);

// The multimesh_* hooks (only when registry_on()), after the engine call. allocate_data follows
// GLES3 (mesh_storage.cpp _multimesh_allocate_data): an unchanged instances/format/colors/custom
// keeps the buffer (and `edited`); any other replaces it with a zeroed one (clears `edited`) and
// clamps `visible` to the instances; `indirect` is always taken. A buffer set clears `edited` only
// when its size is the allocation's (`floats` == instances x stride; the engine refuses any other).
void registry_note_multimesh_allocate(std::uint64_t rid, std::int32_t instances,
                                      std::int32_t format, bool colors, bool custom, bool indirect);
void registry_note_multimesh_mesh(std::uint64_t rid, std::uint64_t mesh);
void registry_note_multimesh_visible(std::uint64_t rid, std::int32_t visible);
void registry_note_multimesh_custom_aabb(std::uint64_t rid, const std::array<float, 6> &aabb);
void registry_note_multimesh_buffer(std::uint64_t rid, std::size_t floats);
void registry_note_multimesh_instance_edit(std::uint64_t rid);

// The recorded multimesh of a live RID (false: `rid` is not a registered multimesh).
bool registry_multimesh(std::uint64_t rid, RegistryMultimesh *out);

// LAR3 (design R2, R5): an engine value the hooks keep alive for the registry -- a copy of the
// String the server was given as a texture path or shader code, or a material parameter's Variant
// (a String copy is a reference-count increment; so is a Variant holding an array). Opaque here: the hooks
// make it (hooks.cpp registry_held_string/registry_held_variant) and rs_adopt.cpp reads it; get()
// is the engine object's address. The registry never destroys one under its lock (a Variant's
// destructor may free an Object, whose free re-enters the hooks): a displaced or erased value is
// moved out and released after the lock is dropped.
using RegistryValue = std::shared_ptr<const void>;

// Creation facts are known only when all Image getters succeeded, including the mipmap getter.
struct RegistryTextureFacts {
  std::int32_t width = 0, height = 0, format = -1;
  bool mipmaps = false;
  bool known = false;
};
struct RegistryTextureRecord {
  std::uint64_t rid = 0;
  RegistryKind kind = RegistryKind::Texture2d;
  RegistryTextureFacts facts;
  bool released = false, edited = false, updated = false, held = false;
  RegistryValue path;
};
void registry_note_texture_create(std::uint64_t rid, const RegistryTextureFacts &facts, bool released);
void registry_note_texture_path(std::uint64_t rid, RegistryValue path);
bool registry_texture_set_released(std::uint64_t rid, bool released);
bool registry_texture(std::uint64_t rid, RegistryTextureRecord *out);
// Copies every texture-family record in slot order under the lock. The caller owns the copied
// path references and releases them outside the lock. Replaces the vector's previous contents.
void registry_textures(std::vector<RegistryTextureRecord> *out);

// The latest image delivered by an update or replace on a headless host, whose dummy server
// keeps no current content. Images are references, never copies; side-map values are released
// outside the registry lock, as every RegistryValue is.
struct RegistryHoldInput {
  RegistryValue image;
  std::int64_t bytes = -1, width = -1, height = -1, format = -1;
  bool mipmaps = false;
  HoldSource source = HoldSource::Update;
  HoldSkip pre = HoldSkip::None;
  std::uint64_t frame = 0;
};
struct RegistryHoldRef {
  RegistryValue image;
  HoldRecord rec;
};
// Null inputs preserve the original kind/fact notes without taking a reference.
HoldSkip registry_note_texture_update(std::uint64_t rid, RegistryHoldInput *hold);
HoldSkip registry_note_replace(std::uint64_t texture, std::uint64_t by_texture,
                               RegistryHoldInput *hold);
// Off-main creates keep a bounded reference until a replace consumes it or its RID retires.
HoldSkip registry_note_pending(std::uint64_t rid, RegistryHoldInput *in);
bool registry_hold(std::uint64_t rid, RegistryHoldRef *out);
std::size_t registry_holds_drop_all(HoldDrop why);
void registry_holds_release();  // deinitialize: release without counting drops
HoldStats registry_hold_stats();
void registry_hold_records(std::vector<HoldRecord> *out, std::size_t cap);
std::uint64_t registry_hold_generation();

// One shader_set_default_texture_parameter (Shader::set_default_texture_parameter's server call).
struct RegistryDefaultTexture {
  std::string name;
  std::int32_t index = 0;
  std::uint64_t texture = 0;
};

// A shader's payload: the code the server was given (shader_create_from_code's or the last
// shader_set_code's String; the preprocessed code, the same string a born capture carries, so no
// #include is ever left to resolve) and its default textures, by (name, index) as the engine keys
// them (a RID() texture erases one). A fresh shader_create has no code (`code` null).
struct RegistryShader {
  RegistryValue code;
  std::vector<RegistryDefaultTexture> defaults;
};

// LS0: a material parameter's name, interned. Every name is one immortal std::string, so a parameter
// holds a pointer (8 B) instead of a string copy, and two names are equal when their pointers are.
class RegistryName {
 public:
  RegistryName() = default;
  explicit RegistryName(const std::string *text) : text_(text) {}
  explicit operator bool() const { return text_ != nullptr; }
  const std::string &str() const { return *text_; }
  bool same(RegistryName other) const { return text_ == other.text_; }
  bool operator==(const char *other) const { return text_ != nullptr && *text_ == other; }
  bool operator==(const std::string &other) const { return text_ != nullptr && *text_ == other; }

 private:
  const std::string *text_ = nullptr;
};

// One material_set_param, as the server keeps it (material_storage.cpp material_set_param): the
// last value per name; NIL and RID() erase it (the hooks pass a null value), an Object is refused
// (the hooks record nothing).
struct RegistryParam {
  RegistryName name;
  RegistryValue value;  // a Variant
};

// A material's payload: the shader material_create_from_shader or the last material_set_shader
// named (0: none), and its parameters in first-set order. next_pass and render_priority are not
// recorded: no hook taps them, and a canvas material uses neither.
struct RegistryMaterial {
  std::uint64_t shader = 0;
  std::vector<RegistryParam> params;
};

// The shader_* and material_* hooks (only when registry_on()), after the engine call.
void registry_note_shader_code(std::uint64_t rid, RegistryValue code);
void registry_note_shader_default_texture(std::uint64_t rid, const std::string &name,
                                          std::uint64_t texture, std::int32_t index);
void registry_note_material_shader(std::uint64_t rid, std::uint64_t shader);
// `value` null: the call erased the parameter (NIL or RID()). Nothing under registry-skip-params.
void registry_note_material_param(std::uint64_t rid, RegistryName name, RegistryValue value);
// By text: interns the name first (the ctests; the hooks use the key form below).
void registry_note_material_param(std::uint64_t rid, const std::string &name, RegistryValue value);

// LS0: the hooks' material_set_param path, a latest-value store with interned names (<= 0.3 us a
// call). A hook knows a parameter's name by the StringName's identity (the engine's interned data
// pointer, `key`, nonzero); the registry holds the first sighting's text and a keepalive (a copy of
// the StringName) so the key never names another string.
//   registry_name_find     the interned name of a key (empty: not seen yet).
//   registry_name_intern   interns `text` (and `key`, when nonzero), keeping `keepalive` alive until
//                          registry_names_release().
//   registry_note_param_fast  one lock: stores `variant` over the parameter's existing value when
//                          nothing else shares it and `overwrite` (hooks.cpp: the held Variant is
//                          one whose destructor cannot re-enter a hook) accepts it.
// Fast results: Recorded (stored, or nothing to record: the material is unknown or
// registry-skip-params), NeedValue (record `*name` with a new held value through
// registry_note_material_param), NeedName (the key is not interned yet).
enum class RegistryParamFast : std::uint8_t { Recorded, NeedValue, NeedName };
using RegistryOverwrite = bool (*)(const void *held, const void *variant);
RegistryName registry_name_find(std::uintptr_t key);
RegistryName registry_name_intern(std::uintptr_t key, const std::string &text,
                                  RegistryValue keepalive);
RegistryParamFast registry_note_param_fast(std::uint64_t rid, std::uintptr_t key,
                                           const void *variant, RegistryOverwrite overwrite,
                                           RegistryName *name);
// Unload: releases every keepalive (outside the lock) and forgets the keys; the interned texts stay.
void registry_names_release();

// The recorded shader or material of a live RID (false: not registered as one).
bool registry_shader(std::uint64_t rid, RegistryShader *out);
bool registry_material(std::uint64_t rid, RegistryMaterial *out);

// LAR5 (design R2, R4, R5): an emitter's payload -- every particles_set_* the mirror taps, the
// last writer winning, in the mirror's own form (Mirror::particles_call): the configuration, the
// 31 base floats in wire order, the trail bind poses (12 floats each), the process material, the
// subemitter and the draw passes. RenderingServer has no particles getter, so an adoption builds
// the entry from this alone (rs_adopt.cpp adopt_particles_ref); the simulation state (restarts,
// emits) is not recorded: an adopted emitter restarts, as PM7's did. A fresh emitter is GLES3's
// (particles_storage.h Particles), the values Mirror::particles_create starts an entry with: mode
// 3d, fixed fps 30, interpolate on, and kRegistryParticleDefaults. Recorded for a registered
// emitter only, as RegistryCanvasTexture is.
constexpr std::size_t kRegistryParticleFloats = 31;  // rs2::kParticlesBaseFloats
constexpr std::array<float, kRegistryParticleFloats> kRegistryParticleDefaults = {
    1.0f,  1.0f,  0.0f,  0.0f, 0.0f, 1.0f, 0.01f, 0.0f, 0.0f, 0.0f,        // 0-9
    -4.0f, -4.0f, -4.0f, 8.0f, 8.0f, 8.0f,                                // 10-15: custom AABB
    1.0f,  0.0f,  0.0f,  0.0f, 1.0f, 0.0f, 0.0f,  0.0f, 1.0f, 0.0f, 0.0f, 0.0f,  // 16-27
    0.0f,  0.0f,  0.0f};                                                  // 28-30
struct RegistryParticles {
  bool mode_2d = false;  // RS::PARTICLES_MODE_2D was set
  bool emitting = false;
  bool one_shot = false;
  bool interpolate = true;
  bool fractional_delta = false;
  bool local = false;
  bool trails = false;
  std::int32_t amount = 0;
  std::int32_t fixed_fps = 30;
  std::int32_t draw_order = 0;
  std::int32_t transform_align = 0;
  std::uint32_t seed = 0;
  std::array<float, kRegistryParticleFloats> floats = kRegistryParticleDefaults;
  std::vector<float> poses;              // 12 per trail bind pose, wire order
  std::uint64_t process_material = 0;    // 0: none
  std::uint64_t subemitter = 0;          // 0: none
  std::vector<std::uint64_t> passes;     // draw-pass mesh RIDs (0: an empty pass)
};

// What one particles setter records (hooks.cpp translates Mirror::ParticlesOp). `i` is the bool,
// int or enum argument (Mode: the RS enum; Floats: the first slot; DrawPassMesh: the pass), `ref`
// the RID argument, `f`/`n` the floats in wire order (Floats: the slots from `i`; Trails: the
// length; TrailBindPoses: 12 per pose). The engine's refusals are followed as the mirror follows
// them: a negative pass count and a pass index out of range record nothing.
enum class RegistryParticlesOp : std::uint8_t {
  Mode,
  Emitting,
  Amount,
  OneShot,
  Local,
  FixedFps,
  Interpolate,
  FractionalDelta,
  TransformAlign,
  DrawOrder,
  Seed,
  Floats,
  Trails,
  TrailBindPoses,
  ProcessMaterial,
  Subemitter,
  DrawPasses,
  DrawPassMesh,
};
// Only when registry_on(); nothing under registry-skip-particles.
void registry_note_particles(std::uint64_t rid, RegistryParticlesOp op, std::int64_t i,
                             std::uint64_t ref, const float *f, std::size_t n);

// The recorded emitter of a live RID (false: `rid` is not a registered emitter).
bool registry_particles(std::uint64_t rid, RegistryParticles *out);

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
