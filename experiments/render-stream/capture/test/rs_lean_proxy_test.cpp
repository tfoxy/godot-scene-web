// Exercise the actual lean vtable thunks without starting a Godot host or capture stream.
#include <cstdint>
#include <cstdlib>
#include <cstdio>

#include "hooks.h"
#include "rs_registry.h"
#include "rs_standby.h"

namespace {
struct Rid { std::uint64_t id; };
int failures = 0, checks = 0, creates = 0, updates = 0, sizes = 0, replaces = 0, frees = 0;
void expect(bool ok, const char *what) {
  ++checks;
  if (!ok) { ++failures; std::fprintf(stderr, "FAIL %s\n", what); }
}
Rid create(void *, Rid) { ++creates; return {101}; }
void update(void *, Rid, Rid) { ++updates; }
void size(void *, Rid, int, int) { ++sizes; }
void replace(void *, Rid, Rid) { ++replaces; }
void free_rid(void *, Rid) { ++frees; }

void test_late_version_plans() {
  using namespace grc;
  // Supply both complete families, including the two hooks that bypass standby. Unrelated
  // required hooks are intentionally absent: this only inspects the resulting replacements.
  Calibration calib;
  for (const auto &name : rs::standby_hook_names()) {
    if (name.find("multimesh_") == 0 || name.find("particles_") == 0) {
      calib.slots.emplace_back(name, static_cast<int64_t>(calib.slots.size()));
    }
  }
  for (const char *name : {"multimesh_set_physics_interpolated", "particles_emit"}) {
    calib.slots.emplace_back(name, static_cast<int64_t>(calib.slots.size()));
  }
  for (const char *version : {"17", "18"}) {
#ifdef _WIN32
    _putenv_s("GRC_STREAM_VERSION", version);
#else
    setenv("GRC_STREAM_VERSION", version, 1);
#endif
    HookPlan plan;
    hooks_plan(calib, &plan);
    expect(hooks_multimesh_planned() && hooks_particles_planned(),
           "late stream version plans both complete hook families");
    expect(plan.replacements.size() == 45, "all 12 multimesh and 33 particle hooks planned");
    for (const auto &slot : calib.slots) {
      const SlotReplacement *replacement = nullptr;
      for (const auto &candidate : plan.replacements) {
        if (candidate.index == static_cast<size_t>(slot.second)) replacement = &candidate;
      }
      const std::string label = std::string("/") + version + " " + slot.first;
      expect(replacement && replacement->hook, (label + " has an armed hook").c_str());
      expect(replacement && replacement->standby == rs::standby_hook(slot.first),
             (label + " keeps its standby plan").c_str());
      // Lean keeps descriptors, while payload/instance mutations stay with the engine.
      const bool lean = slot.first == "multimesh_create" ||
                        slot.first == "multimesh_allocate_data" ||
                        slot.first == "multimesh_set_mesh" ||
                        (slot.first.find("particles_") == 0 &&
                         slot.first != "particles_emit" && slot.first != "particles_restart" &&
                         slot.first != "particles_request_process" &&
                         slot.first != "particles_request_process_time");
      expect(replacement && (replacement->lean_hook != nullptr) == lean,
             (label + " keeps its lean descriptor plan").c_str());
    }
  }
}
}  // namespace

int main() {
  using namespace grc;
  using namespace grc::rs;
  test_late_version_plans();
#ifdef _WIN32
  _putenv_s("GRC_STREAM_VERSION", "16");
#else
  setenv("GRC_STREAM_VERSION", "16", 1);
#endif
  Calibration calib;
  calib.slots = {{"texture_proxy_create", 1}, {"texture_proxy_update", 2},
                 {"texture_set_size_override", 3}, {"texture_replace", 4}, {"free", 5}};
  hooks_set_viewports(true, false);
  HookPlan plan;
  // This deliberately partial calibration only plans these descriptor slots; required unrelated slots
  // are absent. No shadow table is installed and no unrelated original is ever called.
  hooks_plan(calib, &plan);
  void *create_thunk = nullptr, *update_thunk = nullptr;
  void *size_thunk = nullptr, *replace_thunk = nullptr, *free_thunk = nullptr;
  for (const auto &slot : plan.replacements) {
    if (slot.index == 1) {
      create_thunk = slot.lean_hook;
      *slot.original_out = reinterpret_cast<void *>(&create);
    } else if (slot.index == 2) {
      update_thunk = slot.lean_hook;
      *slot.original_out = reinterpret_cast<void *>(&update);
    } else if (slot.index == 3) {
      size_thunk = slot.lean_hook;
      *slot.original_out = reinterpret_cast<void *>(&size);
    } else if (slot.index == 4) {
      replace_thunk = slot.lean_hook;
      *slot.original_out = reinterpret_cast<void *>(&replace);
    } else if (slot.index == 5) {
      free_thunk = slot.lean_hook;
      *slot.original_out = reinterpret_cast<void *>(&free_rid);
    }
  }
  expect(create_thunk && update_thunk, "proxy create/update have lean thunks");
  expect(size_thunk && replace_thunk && free_thunk, "size override/replace/free have lean thunks");
  if (!create_thunk || !update_thunk || !size_thunk || !replace_thunk || !free_thunk) return 1;
  registry_configure(true, RegistryFault::None);
  registry_set_viewports(true);
  mirror_enable(false);
  hooks_attachment_close();
  const auto proxy = reinterpret_cast<Rid (*)(void *, Rid)>(create_thunk)(nullptr, {201});
  reinterpret_cast<void (*)(void *, Rid, Rid)>(update_thunk)(nullptr, proxy, {202});
  RegistryProxy p;
  expect(creates == 1 && updates == 1, "each lean thunk forwards once");
  expect(registry_proxy(proxy.id, &p) && p.base == 202, "lean update records latest base");
  for (int cycle = 0; cycle < 3; ++cycle) {
    registry_configure(true, RegistryFault::None, kRegistryDefaultCap, true);
    expect(registry_viewports(), "lean configure keeps viewport tracking enabled");
    expect(registry_proxy(proxy.id, &p) && p.base == std::uint64_t(202 + cycle),
           "lean configure preserves proxy identity and descriptor");
    reinterpret_cast<void (*)(void *, Rid, Rid)>(update_thunk)(nullptr, proxy, {std::uint64_t(203 + cycle)});
    expect(registry_proxy(proxy.id, &p) && p.base == std::uint64_t(203 + cycle),
           "lean updates still work after configure");
    expect(!mirror_enabled(), "lean proxy calls do not start a mirror");
  }
  registry_note_proxy_create(102, 0, 301);
  registry_configure(true, RegistryFault::None, kRegistryDefaultCap, true);
  expect(registry_proxy(102, &p) && p.base == 0 && p.viewport == 301,
         "lean configure preserves an existing viewport association");
  reinterpret_cast<void (*)(void *, Rid, int, int)>(size_thunk)(nullptr, {401}, 13, 11);
  std::uint32_t width = 0, height = 0;
  expect(registry_texture_size_override(401, &width, &height) && width == 13 && height == 11 &&
             !registry_lookup(401, nullptr), "lean size thunk records without a texture entry");
  reinterpret_cast<void (*)(void *, Rid, Rid)>(replace_thunk)(nullptr, {402}, {401});
  expect(registry_texture_size_override(402, &width, &height) && width == 13 && height == 11 &&
             !registry_texture_size_override(401, &width, &height), "lean replace thunk moves logical size");
  reinterpret_cast<void (*)(void *, Rid, Rid)>(replace_thunk)(nullptr, {402}, {403});
  expect(!registry_texture_size_override(402, &width, &height), "lean replace thunk clears logical size");
  reinterpret_cast<void (*)(void *, Rid, int, int)>(size_thunk)(nullptr, {402}, 17, 19);
  reinterpret_cast<void (*)(void *, Rid)>(free_thunk)(nullptr, {402});
  expect(!registry_texture_size_override(402, &width, &height), "lean free thunk drops logical size");
  expect(sizes == 2 && replaces == 2 && frees == 1 && !mirror_enabled(),
         "lean descriptor thunks forward once without starting a mirror");
  registry_note_free(proxy.id);
  registry_note_free(102);
  expect(registry_stats().entries == 0, "free retires retained proxies");
  registry_configure(false, RegistryFault::None);
  std::printf("rs_lean_proxy_test: %d checks, %d failures\n", checks, failures);
  return failures ? 1 : 0;
}
