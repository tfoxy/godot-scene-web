#include "rs_shader_clock.h"

#include <cmath>

#include "abi.h"
#include "iface.h"
#include "rs_variant.h"

namespace grc {
namespace rs {

namespace {

// Method hashes from `godot --dump-extension-api` of Godot 4.5.1 (as rs_root_query.cpp).
constexpr int64_t kEngineGetMainLoop = 1016888095LL;        // Engine.get_main_loop() -> MainLoop
constexpr int64_t kSceneTreeGetRoot = 1757182445LL;         // SceneTree.get_root() -> Window
constexpr int64_t kEngineGetFramesDrawn = 2455072627LL;     // Engine.get_frames_drawn() -> int
constexpr int64_t kNodeGetProcessDeltaTime = 1740695150LL;  // Node.get_process_delta_time() -> float
constexpr int64_t kProjectSettingsGetSettingWithOverride = 2760726917LL;  // (StringName) -> Variant

ShaderClock g_clock;
bool g_resolved = false;
GDExtensionMethodBindPtr g_frames_drawn = nullptr;
GDExtensionMethodBindPtr g_main_loop = nullptr;
GDExtensionMethodBindPtr g_root = nullptr;
GDExtensionMethodBindPtr g_delta = nullptr;
void *g_engine = nullptr;
void *g_root_node = nullptr;

void unavailable(const char *what) {
  if (g_clock.available) {
    g_clock.available = false;
    g_clock.unavailable = what;
  }
}

// `rendering/limits/time/time_rollover_secs`, read once (GLES3 caches it too).
void read_rollover() {
  void *settings = singleton_object("ProjectSettings");
  GDExtensionMethodBindPtr bind = method_bind("ProjectSettings", "get_setting_with_override",
                                              kProjectSettingsGetSettingWithOverride);
  if (settings == nullptr || bind == nullptr || g_iface.object_method_bind_ptrcall == nullptr ||
      g_iface.variant_destroy == nullptr) {
    return;  // the default stays
  }
  StringName name("rendering/limits/time/time_rollover_secs");
  alignas(8) unsigned char ret[24] = {};  // a NIL Variant
  const GDExtensionConstTypePtr args[1] = {name.ptr()};
  g_iface.object_method_bind_ptrcall(bind, settings, args, ret);
  const DecodedParam value = decode_variant(ret);
  if (value.status == "ok" && (value.type == "float" || value.type == "int") && !value.f.empty() &&
      value.f[0] > 0.0) {
    g_clock.rollover = value.f[0];
  }
  g_iface.variant_destroy(ret);
}

bool resolve() {
  if (g_resolved) {
    return g_clock.available;
  }
  g_resolved = true;
  g_engine = singleton_object("Engine");
  g_frames_drawn = method_bind("Engine", "get_frames_drawn", kEngineGetFramesDrawn);
  g_main_loop = method_bind("Engine", "get_main_loop", kEngineGetMainLoop);
  g_root = method_bind("SceneTree", "get_root", kSceneTreeGetRoot);
  g_delta = method_bind("Node", "get_process_delta_time", kNodeGetProcessDeltaTime);
  if (g_engine == nullptr) {
    unavailable("Engine");
  } else if (g_frames_drawn == nullptr) {
    unavailable("Engine.get_frames_drawn");
  } else if (g_main_loop == nullptr) {
    unavailable("Engine.get_main_loop");
  } else if (g_root == nullptr) {
    unavailable("SceneTree.get_root");
  } else if (g_delta == nullptr) {
    unavailable("Node.get_process_delta_time");
  }
  read_rollover();
  return g_clock.available;
}

}  // namespace

ShaderClock &shader_clock() { return g_clock; }

bool shader_clock_tick() {
  if (!resolve()) {
    return false;
  }
  if (g_root_node == nullptr) {
    void *loop = nullptr;
    if (!call_object_getter(g_main_loop, g_engine, &loop) || loop == nullptr) {
      return true;  // no main loop yet: nothing processed, nothing drawn
    }
    if (!call_object_getter(g_root, loop, &g_root_node) || g_root_node == nullptr) {
      g_root_node = nullptr;
      return true;
    }
  }
  int64_t drawn = 0;
  double delta = 0.0;
  if (!call_int_getter(g_frames_drawn, g_engine, &drawn) ||
      !call_value_getter(g_delta, g_root_node, &delta, sizeof(delta))) {
    unavailable("a clock getter failed");
    return false;
  }
  ++g_clock.ticks;
  if (g_clock.start_drawn < 0) {
    g_clock.start_drawn = drawn;
  }
  // A drawn iteration advances, as RasterizerGLES3::begin_frame does; a host that has never drawn
  // advances every iteration.
  if (drawn == 0 || drawn != g_clock.last_drawn) {
    g_clock.total = std::fmod(g_clock.total + delta, g_clock.rollover);
    ++g_clock.advanced;
  }
  g_clock.last_drawn = drawn;
  return true;
}

}  // namespace rs
}  // namespace grc
