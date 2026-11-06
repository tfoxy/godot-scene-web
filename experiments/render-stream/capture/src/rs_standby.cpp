#include "rs_standby.h"

#include <algorithm>
#include <cstring>

namespace grc {
namespace rs {

namespace {

std::vector<std::string> make_names() {
  std::vector<std::string> names = {
      // The registry's creates (registry_create) and frees, and the shims' slots.
      "texture_2d_create",
      "texture_2d_placeholder_create",
      "canvas_texture_create",
      "mesh_create",
      "mesh_create_from_surfaces",
      "multimesh_create",
      "shader_create",
      "shader_create_from_code",
      "material_create",
      "material_create_from_shader",
      "particles_create",
      "free",
      // Texture state (LAR1, LAR6).
      "texture_2d_update",
      "texture_replace",
      "canvas_texture_set_channel",
      "canvas_texture_set_texture_filter",
      "canvas_texture_set_texture_repeat",
      // Shaders and materials (LAR3, LS0).
      "shader_set_code",
      "shader_set_default_texture_parameter",
      "material_set_shader",
      "material_set_param",
      // Multimeshes (LAR2).
      "multimesh_allocate_data",
      "multimesh_set_mesh",
      "multimesh_instance_set_transform",
      "multimesh_instance_set_transform_2d",
      "multimesh_instance_set_color",
      "multimesh_instance_set_custom_data",
      "multimesh_set_custom_aabb",
      "multimesh_set_buffer",
      "multimesh_set_buffer_interpolated",
      "multimesh_set_visible_instances",
      // Emitters (LAR4, LAR5): every setter that goes through pt_tap (the three events,
      // restart and both request_process calls, reach the registry and record nothing or one
      // float; they are rare, and the rule stays "a hook that reaches the registry").
      "particles_set_mode",
      "particles_set_emitting",
      "particles_set_amount",
      "particles_set_amount_ratio",
      "particles_set_lifetime",
      "particles_set_one_shot",
      "particles_set_pre_process_time",
      "particles_request_process_time",
      "particles_set_explosiveness_ratio",
      "particles_set_randomness_ratio",
      "particles_set_custom_aabb",
      "particles_set_speed_scale",
      "particles_set_use_local_coordinates",
      "particles_set_process_material",
      "particles_set_fixed_fps",
      "particles_set_interpolate",
      "particles_set_fractional_delta",
      "particles_set_collision_base_size",
      "particles_set_seed",
      "particles_set_transform_align",
      "particles_set_trails",
      "particles_set_trail_bind_poses",
      "particles_request_process",
      "particles_restart",
      "particles_set_subemitter",
      "particles_set_draw_order",
      "particles_set_draw_passes",
      "particles_set_draw_pass_mesh",
      "particles_set_emission_transform",
      "particles_set_emitter_velocity",
      "particles_set_interp_to_end",
      // D5: planned always, recorded from LS4.
      "texture_set_path",
      // D4: the shader clock on a rendered host.
      "draw",
  };
  std::sort(names.begin(), names.end());
  return names;
}

}  // namespace

const std::vector<std::string> &standby_hook_names() {
  static const std::vector<std::string> names = make_names();
  return names;
}

bool standby_hook(const std::string &name) {
  const std::vector<std::string> &names = standby_hook_names();
  return std::binary_search(names.begin(), names.end(), name);
}

bool parse_standby_fault(const char *value, StandbyFault *out, std::string *why) {
  *out = StandbyFault::None;
  if (value == nullptr || value[0] == '\0') {
    return true;
  }
  if (std::strcmp(value, "full-table") == 0) {
    *out = StandbyFault::FullTable;
  } else if (std::strcmp(value, "drop-tracked") == 0) {
    *out = StandbyFault::DropTracked;
  } else if (std::strcmp(value, "no-draw") == 0) {
    *out = StandbyFault::NoDraw;
  } else {
    *why = std::string("GRC_STANDBY_FAULT=") + value +
           " (expected full-table, drop-tracked or no-draw)";
    return false;
  }
  return true;
}

const char *standby_fault_name(StandbyFault fault) {
  switch (fault) {
    case StandbyFault::FullTable: return "full-table";
    case StandbyFault::DropTracked: return "drop-tracked";
    case StandbyFault::NoDraw: return "no-draw";
    case StandbyFault::None: break;
  }
  return "none";
}

bool standby_hook_under(const std::string &name, StandbyFault fault) {
  switch (fault) {
    case StandbyFault::FullTable: return true;
    case StandbyFault::DropTracked:
      return name != kStandbyDropTrackedHook && standby_hook(name);
    case StandbyFault::NoDraw: return name != "draw" && standby_hook(name);
    case StandbyFault::None: break;
  }
  return standby_hook(name);
}

}  // namespace rs
}  // namespace grc
