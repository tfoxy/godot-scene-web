// The pass-through recording hooks.
//
// Every hook records what it saw and then calls the function pointer that
// occupied the slot, with the identical arguments. The hooks are plain
// functions whose first parameter is the `this` pointer, which is exactly the
// Itanium ABI of the member functions they stand in for.
//
// Hooks come in two tiers. The eight gate -1 hooks are REQUIRED: a record that
// does not name one of them is refused. Every hook added after gate -1 is
// OPTIONAL: a record that does not name it (one written by an older
// calibrator) still loads, the hook is simply not installed, and the omission
// is recorded in calibration-check.json (`hook_plan`) and counters.json
// (`hooks_omitted`, with that hook's count written as null).

#pragma once

#include <cstdint>
#include <string>
#include <vector>

#include "calib.h"
#include "rs2_snapshot.h"
#include "rs_adopt.h"
#include "rs_texture_payload.h"
#include "rs_texture_worker.h"
#include "vtable.h"

namespace grc {

// Resolves the ClassDB method binds the hooks use to describe an Image. Safe to
// call more than once; a failure disables image details rather than capture.
void hooks_init_image_binds();

// True when Image.get_width/get_height/get_format/get_data_size all resolved.
bool hooks_image_details_available();

// Gate 2 (G2a): true when, beyond those, Image.has_mipmaps and the image_ptr
// interface function resolved, so texture_2d_create/_update can copy payload
// bytes at the hook (gate2-design.md D3). A stream refuses at arm without it.
bool hooks_image_payload_available();

// Records the calling thread as the main thread: the texture hook log marks
// every other caller "other" (loader threads). Called at SCENE initialisation.
void hooks_set_main_thread();

// GRC_RESOURCE_FORMATS / GRC_RESOURCE_MAX_PAYLOAD_BYTES, set at arm before the
// texture hook log starts.
void hooks_set_resource_policy(const rs::FormatPolicy &formats, uint64_t max_payload_bytes);

// G8kw (rs_texture_worker.h): GRC_TEXTURE_WORKERS, set at arm before the texture hook log starts.
// The pool itself is started and stopped by entry.cpp; a copy goes to it only while it runs.
void hooks_set_texture_workers(const rs::TextureWorkerConfig &config);

struct HookPlan {
  std::vector<SlotReplacement> replacements;
  std::vector<std::string> planned;  // hooks the record names, in install order
  std::vector<std::string> omitted;  // optional hooks the record does not name
  std::string missing_required;      // first required hook the record lacks, or empty
};

// Matches every hook against the record. Returns false (with `missing_required`
// set) when the record does not name a required hook; optional hooks it does
// not name land in `omitted` and are not installed. Also remembers the
// omissions for hooks_counters_json().
bool hooks_plan(const Calibration &calib, HookPlan *plan);

// One-line description of a plan, for the calibration-check entry.
std::string hooks_plan_detail(const HookPlan &plan);

// The 1-based main-loop iteration now in progress, matching a fixture's own
// frame counter (the frame callback runs after process and draw). Captures
// carry it so an expected call can be placed in time.
void hooks_set_frame(uint64_t frame);

// PM1 (render-stream-11.md "As built (PM1)" rule 8): the last hooks_plan() planned all twelve
// multimesh hooks (GRC_STREAM_VERSION=11 and a record naming every slot), so the session declares
// add_multimesh and the mirror's multimesh table is on.
bool hooks_multimesh_planned();

// PM5 (render-stream-12.md "Session record"): the last hooks_plan() planned all 33 particles hooks
// (GRC_STREAM_VERSION=12 and a record naming every slot), so the session declares add_particles
// and the mirror's particles table is on.
bool hooks_particles_planned();

// P3-TM (render-stream-10.md "Shader time"): set before arming when the session is /10. The
// shader hooks then classify `TIME` as a use, not the `shader-time` reason.
void hooks_set_shader_time_carried(bool carried);

// G8r (gate8-design.md D6, D7; rs_adopt.h): registers a texture that existed before arm in the
// mirror and the hook log, through the hooks' own copy path (G8t's decode, G8kw's worker), as a
// texture_2d_create of `image_object` (an Image the caller keeps alive for the call) with origin
// `adopted`. False, registering nothing, when the RID is already known or nothing is streaming.
// `decoded` (optional) reports a host-decoded payload.
bool hooks_adopt_texture(uint64_t rid, void *image_object, rs2::AdoptedContent content,
                         const char *source, bool *decoded);
// G8r: the same for a mesh read back through mesh_get_surface (its custom AABB, position xyz and
// size xyz); the hook's retained-buffer cache takes its surfaces, so a later region update
// re-hashes them as for any mesh.
bool hooks_adopt_mesh(uint64_t rid, const std::vector<rs::AdoptSurface> &surfaces,
                      const float custom_aabb[6]);

// G8m (gate8-design.md D4, D11, D12, Q5; rs_adopt.h): pre-arm shaders and materials.
// hooks_internal_begin/end bracket the capture's own temporary objects on this thread (D4's
// reentrancy flag): shader_create_from_code writes the code it receives into `code_out` and the
// RID into `rid_out` instead of the mirror and the hook log; shader_set_code and free pass
// straight through. The hooks_adopt_* calls register what rs_adopt.cpp read back, through the
// hooks' own copy and decode paths, in the mirror and the hook log, with origin `adopted`; each
// is a no-op when nothing is streaming. hooks_adopt_shader / _material return false, registering
// nothing, for a RID the mirror already knows.
void hooks_internal_begin(std::string *code_out, uint64_t *rid_out);
void hooks_internal_end();
bool hooks_adopt_shader(uint64_t rid, const std::string &code);
bool hooks_adopt_shader_refused(uint64_t rid, rs2::ShaderReason reason);
void hooks_adopt_default_texture(uint64_t shader, const std::string &name, uint64_t texture,
                                 int32_t index);
bool hooks_adopt_material(uint64_t material, uint64_t shader,
                          const std::vector<rs::AdoptParam> &params);
// The references a frame-boundary resolution completes: the item's material and the material's
// shader, set again now that the mirror knows them (canvas_item_set_material /
// material_set_shader as the hooks would have declared them).
void hooks_adopt_item_material(uint64_t item, uint64_t material);
void hooks_adopt_material_shader(uint64_t material, uint64_t shader);
void hooks_adopt_instance_param(uint64_t item, const std::string &name, const void *variant);

// Serialised counters and captured values.
std::string hooks_counters_json(uint64_t frames_total, uint64_t frames_armed);

// G8kc: evidence/texture-cache.json, each hooked texture's path, D7 source key and cache outcome
// (written only under GRC_TEXTURE_CACHE_DIR).
std::string hooks_texture_cache_json();
// Forgets the previous stream's notes and paths (called when the cache is opened for a stream).
void hooks_reset_texture_cache_notes();

// Total number of intercepted calls across all hooks.
uint64_t hooks_total_calls();

}  // namespace grc
