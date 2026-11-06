// LS1 `standby-slot-census` (live-swap-design.md D4): the standby table's set (rs_standby.cpp)
// against hooks.cpp itself, given as argv[1].
//
//   1. Every hook in hooks.cpp's kSpecs table whose body reaches the late-arm registry (a
//      registry_note_*, registry_create, registry_param or registry_particles call) or a shim
//      (`_shim().`), directly or through pt_tap, is in the standby set; texture_set_path and draw
//      are in it by rule (D5, the shader clock); no other hook is. A new tracked hook that is not
//      added to rs_standby.cpp, or a standby entry whose hook no longer tracks, fails here.
//   2. The set equals the list written below, so an edit to it is deliberate.
//   3. GRC_STANDBY_FAULT: full-table puts every hook in, drop-tracked leaves out only
//      canvas_texture_create, no-draw only draw; an unknown value refuses.

#include <algorithm>
#include <cstdio>
#include <fstream>
#include <map>
#include <regex>
#include <set>
#include <sstream>
#include <string>
#include <vector>

#include "rs_standby.h"

namespace {

int g_failures = 0;

void expect(bool ok, const std::string &what) {
  if (!ok) {
    std::fprintf(stderr, "FAIL: %s\n", what.c_str());
    ++g_failures;
  }
}

// The body of the top-level function `name` (from its definition line at column 0 to the next
// line that is exactly "}"), or empty.
std::string body_of(const std::vector<std::string> &lines, const std::string &name) {
  const std::regex def("^[A-Za-z][^;/]*\\b" + name + "\\(");
  for (size_t i = 0; i < lines.size(); ++i) {
    if (!std::regex_search(lines[i], def) || lines[i].find(';') != std::string::npos) {
      continue;
    }
    std::string body;
    for (size_t j = i; j < lines.size(); ++j) {
      body += lines[j] + "\n";
      if (lines[j] == "}") {
        return body;
      }
    }
  }
  return std::string();
}

bool tracks(const std::string &body) {
  static const std::regex tap(
      "registry_note_[a-z_]+\\(|registry_create\\(|registry_param\\(|registry_particles\\(|"
      "_shim\\(\\)\\.|\\bpt_tap\\(");
  std::istringstream in(body);
  std::string line;
  while (std::getline(in, line)) {
    const size_t comment = line.find("//");
    if (comment != std::string::npos) {
      line.resize(comment);
    }
    if (std::regex_search(line, tap)) {
      return true;
    }
  }
  return false;
}

void census(const char *path) {
  std::ifstream file(path);
  expect(file.good(), std::string("cannot read ") + path);
  std::vector<std::string> lines;
  std::string line;
  while (std::getline(file, line)) {
    lines.push_back(line);
  }
  // kSpecs entries: {kId, "method_name", as_ptr(&hook_fn)}, possibly over two lines.
  std::string all;
  for (const std::string &l : lines) {
    all += l + "\n";
  }
  const size_t start = all.find("const HookSpec kSpecs[] = {");
  const size_t end = all.find("\n};", start);
  expect(start != std::string::npos && end != std::string::npos, "kSpecs table found");
  if (start == std::string::npos || end == std::string::npos) {
    return;
  }
  const std::string table = all.substr(start, end - start);
  const std::regex entry("\\{k[A-Za-z0-9]+,\\s*\"([a-z0-9_]+)\",\\s*as_ptr\\(&(hook_[a-z0-9_]+)\\)\\}");
  std::map<std::string, std::string> specs;  // method name -> hook function
  for (std::sregex_iterator it(table.begin(), table.end(), entry), stop; it != stop; ++it) {
    specs[(*it)[1].str()] = (*it)[2].str();
  }
  expect(specs.size() >= 129, "kSpecs parsed (" + std::to_string(specs.size()) + " hooks)");

  std::set<std::string> want;
  for (const auto &spec : specs) {
    const std::string body = body_of(lines, spec.second);
    expect(!body.empty(), "body of " + spec.second + " found");
    const bool by_rule = spec.first == "texture_set_path" || spec.first == "draw";
    if (by_rule || tracks(body)) {
      want.insert(spec.first);
    }
  }
  const std::vector<std::string> &have = grc::rs::standby_hook_names();
  const std::set<std::string> have_set(have.begin(), have.end());
  for (const std::string &name : want) {
    expect(have_set.count(name) == 1, name + " reaches the registry or a shim but is not in the standby set");
  }
  for (const std::string &name : have) {
    expect(specs.count(name) == 1, name + " is in the standby set but is no hook of kSpecs");
    expect(want.count(name) == 1, name + " is in the standby set but its hook neither tracks nor is a rule slot");
  }
  std::printf("rs_standby: %zu hooks, %zu in standby (census of %s)\n", specs.size(), want.size(),
              path);
}

void expected_list() {
  const std::vector<std::string> expected = {
      "canvas_texture_create",
      "canvas_texture_set_channel",
      "canvas_texture_set_texture_filter",
      "canvas_texture_set_texture_repeat",
      "draw",
      "free",
      "material_create",
      "material_create_from_shader",
      "material_set_param",
      "material_set_shader",
      "mesh_create",
      "mesh_create_from_surfaces",
      "multimesh_allocate_data",
      "multimesh_create",
      "multimesh_instance_set_color",
      "multimesh_instance_set_custom_data",
      "multimesh_instance_set_transform",
      "multimesh_instance_set_transform_2d",
      "multimesh_set_buffer",
      "multimesh_set_buffer_interpolated",
      "multimesh_set_custom_aabb",
      "multimesh_set_mesh",
      "multimesh_set_visible_instances",
      "particles_create",
      "particles_request_process",
      "particles_request_process_time",
      "particles_restart",
      "particles_set_amount",
      "particles_set_amount_ratio",
      "particles_set_collision_base_size",
      "particles_set_custom_aabb",
      "particles_set_draw_order",
      "particles_set_draw_pass_mesh",
      "particles_set_draw_passes",
      "particles_set_emission_transform",
      "particles_set_emitter_velocity",
      "particles_set_emitting",
      "particles_set_explosiveness_ratio",
      "particles_set_fixed_fps",
      "particles_set_fractional_delta",
      "particles_set_interp_to_end",
      "particles_set_interpolate",
      "particles_set_lifetime",
      "particles_set_mode",
      "particles_set_one_shot",
      "particles_set_pre_process_time",
      "particles_set_process_material",
      "particles_set_randomness_ratio",
      "particles_set_seed",
      "particles_set_speed_scale",
      "particles_set_subemitter",
      "particles_set_trail_bind_poses",
      "particles_set_trails",
      "particles_set_transform_align",
      "particles_set_use_local_coordinates",
      "shader_create",
      "shader_create_from_code",
      "shader_set_code",
      "shader_set_default_texture_parameter",
      "texture_2d_create",
      "texture_2d_placeholder_create",
      "texture_2d_update",
      "texture_replace",
      "texture_set_path",
  };
  expect(grc::rs::standby_hook_names() == expected, "the standby set equals the expected list");
  expect(!grc::rs::standby_hook("canvas_item_add_rect"), "a draw command is hot");
  expect(!grc::rs::standby_hook("canvas_item_set_transform"), "an item setter is hot");
  expect(!grc::rs::standby_hook("canvas_item_set_material"), "set_material is hot (adoption only)");
}

void faults() {
  using grc::rs::StandbyFault;
  StandbyFault f = StandbyFault::None;
  std::string why;
  expect(grc::rs::parse_standby_fault(nullptr, &f, &why) && f == StandbyFault::None, "unset");
  expect(grc::rs::parse_standby_fault("", &f, &why) && f == StandbyFault::None, "empty");
  expect(grc::rs::parse_standby_fault("full-table", &f, &why) && f == StandbyFault::FullTable,
         "full-table");
  expect(grc::rs::parse_standby_fault("drop-tracked", &f, &why) && f == StandbyFault::DropTracked,
         "drop-tracked");
  expect(grc::rs::parse_standby_fault("no-draw", &f, &why) && f == StandbyFault::NoDraw, "no-draw");
  expect(!grc::rs::parse_standby_fault("bogus", &f, &why) && !why.empty(), "bogus refuses");
  expect(grc::rs::standby_hook_under("canvas_item_add_rect", StandbyFault::FullTable),
         "full-table installs a hot hook");
  expect(!grc::rs::standby_hook_under("canvas_texture_create", StandbyFault::DropTracked),
         "drop-tracked leaves canvas_texture_create out");
  expect(grc::rs::standby_hook_under("texture_2d_create", StandbyFault::DropTracked),
         "drop-tracked keeps the rest");
  expect(!grc::rs::standby_hook_under("draw", StandbyFault::NoDraw), "no-draw leaves draw out");
  expect(grc::rs::standby_hook_under("free", StandbyFault::NoDraw), "no-draw keeps the rest");
  expect(!grc::rs::standby_hook_under("canvas_item_add_rect", StandbyFault::None),
         "no fault: hot hooks stay out");
}

}  // namespace

int main(int argc, char **argv) {
  if (argc < 2) {
    std::fprintf(stderr, "usage: rs_standby_test <capture/src/hooks.cpp>\n");
    return 2;
  }
  census(argv[1]);
  expected_list();
  faults();
  if (g_failures != 0) {
    std::fprintf(stderr, "rs_standby: %d failure(s)\n", g_failures);
    return 1;
  }
  std::printf("rs_standby: ok\n");
  return 0;
}
