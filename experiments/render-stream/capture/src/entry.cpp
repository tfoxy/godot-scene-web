// GDExtension entry point and the arming decision.
//
// Nothing is written into the engine's memory until every check in
// `calib.h` has passed and `GRC_MODE=arm` was asked for. `validate` runs the
// identical checks and writes the identical evidence, but never touches the
// vptr.

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

#include "calib.h"
#include "hooks.h"
#include "iface.h"
#include "report.h"
#include "vtable.h"

namespace grc {

namespace {

struct State {
  // Configuration, read once at SCENE initialisation.
  std::string calibration_path;
  std::string evidence_dir;
  std::string mode = "validate";
  int64_t disarm_after_frames = -1;
  bool evidence_ready = false;

  Calibration calib;
  ProcessFingerprint fp;
  LiveVtableFacts facts;
  std::vector<CheckResult> checks;
  ShadowVtable shadow;

  bool decided = false;
  bool armed = false;
  bool vptr_written = false;
  bool disarmed = false;
  bool disarm_was_shadow = false;
  bool disarm_restored = false;
  int64_t disarm_frame = -1;
  std::string status = "error";
  std::string reason = "not-initialized";

  uint64_t frames_total = 0;
  uint64_t frames_armed = 0;

  std::string display_server;
  std::string rendering_driver;
  std::string rendering_method;
};

State g_state;

void log_line(const std::string &text) {
  std::fprintf(stdout, "[grc] %s\n", text.c_str());
  std::fflush(stdout);
}

std::string env_string(const char *name) {
  const char *value = std::getenv(name);
  return value != nullptr ? std::string(value) : std::string();
}

// Writes `text` to the evidence directory, or to stdout when there is none.
void emit(const std::string &name, const std::string &text) {
  if (g_state.evidence_ready) {
    const std::string path = path_join(g_state.evidence_dir, name);
    if (!write_file(path, text)) {
      log_line("could not write " + path);
    }
    return;
  }
  log_line("evidence " + name + " " + text);
}

std::string result_json() {
  JsonWriter json;
  json.object_begin();
  json.field("schema", std::string("render-stream-capture-result/1"));
  json.field("status", g_state.status);
  json.field_or_null("reason", g_state.reason);
  json.field("vptr_written", g_state.vptr_written);
  json.field("disarmed", g_state.disarmed);
  json.field_or_null("display_server", g_state.display_server);
  json.field_or_null("rendering_driver", g_state.rendering_driver);
  json.field_or_null("rendering_method", g_state.rendering_method);
  json.object_end();
  return json.take();
}

std::string fingerprint_json() {
  const ProcessFingerprint &fp = g_state.fp;
  JsonWriter json;
  json.object_begin();
  json.field("exe_path", fp.exe_path);
  json.field("version_string", fp.version_string);
  json.field("sha256", fp.exe_sha256);
  json.field_or_null("build_id", fp.build_id);
  json.field("pie", fp.pie);
  json.field_hex("load_bias", fp.load_bias);
  json.field_hex("live_vptr", g_state.facts.live_vptr);
  json.field_hex("expected_vptr", g_state.facts.expected_vptr);
  json.field_hex("singleton", reinterpret_cast<uint64_t>(g_state.facts.singleton));
  json.field_hex("abstract_address_point", g_state.facts.abstract_address_point);
  json.field_hex("pure_placeholder", g_state.facts.pure_placeholder);
  json.field("pid", static_cast<int64_t>(fp.pid));
  json.key("exe_maps").array_begin();
  for (const std::string &line : fp.exe_maps) {
    json.string(line);
  }
  json.array_end();
  json.object_end();
  return json.take();
}

std::string calibration_check_json() {
  JsonWriter json;
  json.object_begin();
  json.field("calibration_path", g_state.calibration_path);
  json.field("mode", g_state.mode);
  json.field("schema", g_state.calib.schema);
  json.field("object_prefix", g_state.calib.object_prefix);
  json.field("slot_count", g_state.calib.slot_count);
  json.field("anchors_total", g_state.calib.anchors_total);
  json.key("checks").array_begin();
  for (const CheckResult &check : g_state.checks) {
    json.object_begin();
    json.field("name", check.name);
    json.field("ok", check.ok);
    json.field("detail", check.detail);
    json.object_end();
  }
  json.array_end();
  json.object_end();
  return json.take();
}

std::string disarm_json() {
  JsonWriter json;
  json.object_begin();
  json.field("disarmed", g_state.disarmed);
  json.field("vptr_was_shadow", g_state.disarm_was_shadow);
  json.field("vptr_restored", g_state.disarm_restored);
  json.field("frame", g_state.disarm_frame);
  json.object_end();
  return json.take();
}

void collect_environment_description() {
  // Only read-only, well-identified ClassDB methods: never an unidentified slot.
  g_state.display_server = singleton_string("DisplayServer", "DisplayServer", "get_name",
                                            201670096LL);
  g_state.rendering_driver = singleton_string("RenderingServer", "RenderingServer",
                                              "get_current_rendering_driver_name", 201670096LL);
  g_state.rendering_method = singleton_string("RenderingServer", "RenderingServer",
                                              "get_current_rendering_method", 201670096LL);
}

void decide(const std::string &status, const std::string &reason) {
  g_state.status = status;
  g_state.reason = reason;
  g_state.decided = true;
  emit("calibration-check.json", calibration_check_json());
  emit("fingerprint.json", fingerprint_json());
  emit("result.json", result_json());
  log_line("decision: " + status + (reason.empty() ? "" : " (" + reason + ")") +
           " vptr_written=" + (g_state.vptr_written ? "true" : "false"));
}

void refuse(const std::string &reason) { decide("refused", reason); }

// Runs the full check pipeline, and arms when asked to. `phase` names the
// callback it runs from, for the log. Returns true once a decision was made.
bool attempt(const char *phase) {
  if (g_state.decided) {
    return true;
  }
  log_line(std::string("attempting at ") + phase + " in mode " + g_state.mode);

  if (!g_iface.complete) {
    refuse("interface-incomplete");
    return true;
  }
  if (g_state.calibration_path.empty()) {
    refuse("no-calibration");
    return true;
  }
  std::string error;
  if (!load_calibration(g_state.calibration_path, &g_state.calib, &error)) {
    log_line("calibration: " + error);
    // An absent or unreadable record and a malformed one are different
    // failures; both refuse.
    refuse(error.compare(0, 11, "cannot read") == 0 ? "no-calibration" : "invalid-calibration");
    return true;
  }
  if (!collect_fingerprint(&g_state.fp, &error)) {
    log_line("fingerprint: " + error);
    refuse("fingerprint-unavailable");
    return true;
  }
  collect_environment_description();

  if (!check_fingerprint(g_state.calib, g_state.fp, &g_state.checks)) {
    refuse("fingerprint-mismatch");
    return true;
  }
  if (singleton_object("RenderingServer") == nullptr) {
    // Startup-loaded extensions reach SCENE initialisation before the engine
    // singletons are registered. Not a failure yet: retry from the startup and
    // frame callbacks.
    log_line("RenderingServer singleton not registered yet; deferring");
    g_state.checks.clear();
    return false;
  }
  if (!check_slot_mask(g_state.calib, g_state.fp, &g_state.facts, &g_state.checks)) {
    refuse("slot-mask-mismatch");
    return true;
  }
  if (!check_behaviour(g_state.calib, g_state.facts, &g_state.checks)) {
    refuse("behaviour-mismatch");
    return true;
  }

  if (g_state.mode != "arm") {
    decide("validated", std::string());
    return true;
  }

  hooks_init_image_binds();
  if (!hooks_image_details_available()) {
    log_line("Image method binds unavailable: texture captures will omit details");
  }
  std::vector<SlotReplacement> replacements;
  if (!hooks_replacements(g_state.calib, &replacements, &error)) {
    log_line("hooks: " + error);
    refuse("slot-mask-mismatch");
    return true;
  }
  if (!g_state.shadow.arm(g_state.facts.singleton, static_cast<size_t>(g_state.calib.slot_count),
                          replacements, &error)) {
    log_line("arm: " + error);
    refuse("arm-failed");
    return true;
  }
  g_state.armed = true;
  g_state.vptr_written = true;
  if (g_state.evidence_ready) {
    touch_file(path_join(g_state.evidence_dir, "armed.marker"));
  }
  decide("armed", std::string());
  return true;
}

void do_disarm(const char *phase) {
  if (!g_state.armed) {
    return;
  }
  bool was_shadow = false;
  bool restored = false;
  g_state.shadow.disarm(&was_shadow, &restored);
  g_state.armed = false;
  g_state.disarmed = true;
  g_state.disarm_was_shadow = was_shadow;
  g_state.disarm_restored = restored;
  g_state.disarm_frame = static_cast<int64_t>(g_state.frames_total);
  log_line(std::string("disarmed from ") + phase + " callback at frame " +
           std::to_string(g_state.frames_total) + " was_shadow=" + (was_shadow ? "true" : "false") +
           " restored=" + (restored ? "true" : "false"));
  emit("disarm.json", disarm_json());
  emit("counters.json", hooks_counters_json(g_state.frames_total, g_state.frames_armed));
  emit("result.json", result_json());
}

void on_startup() { attempt("startup"); }

void on_frame() {
  ++g_state.frames_total;
  hooks_set_frame(g_state.frames_total + 1);
  if (!g_state.decided) {
    attempt("frame");
  }
  if (g_state.armed) {
    ++g_state.frames_armed;
    if (g_state.disarm_after_frames >= 0 &&
        static_cast<int64_t>(g_state.frames_armed) >= g_state.disarm_after_frames) {
      do_disarm("frame");
    }
  }
}

void on_shutdown() {
  do_disarm("shutdown");
  emit("counters.json", hooks_counters_json(g_state.frames_total, g_state.frames_armed));
  emit("result.json", result_json());
  log_line("shutdown: frames_total=" + std::to_string(g_state.frames_total) +
           " frames_armed=" + std::to_string(g_state.frames_armed) + " intercepted=" +
           std::to_string(hooks_total_calls()));
}

void initialize(void * /*userdata*/, GDExtensionInitializationLevel level) {
  if (level != GDEXTENSION_INITIALIZATION_SCENE) {
    return;
  }
  g_state.calibration_path = env_string("GRC_CALIBRATION");
  g_state.evidence_dir = env_string("GRC_EVIDENCE_DIR");
  const std::string mode = env_string("GRC_MODE");
  g_state.mode = mode.empty() ? std::string("validate") : mode;
  const std::string frames = env_string("GRC_DISARM_AFTER_FRAMES");
  g_state.disarm_after_frames = frames.empty() ? -1 : std::strtoll(frames.c_str(), nullptr, 10);
  if (!g_state.evidence_dir.empty()) {
    g_state.evidence_ready = make_directories(g_state.evidence_dir);
    if (!g_state.evidence_ready) {
      log_line("cannot create evidence directory " + g_state.evidence_dir);
    }
  }
  log_line("scene init: mode=" + g_state.mode + " calibration=" +
           (g_state.calibration_path.empty() ? "<unset>" : g_state.calibration_path) +
           " evidence=" + (g_state.evidence_dir.empty() ? "<stdout>" : g_state.evidence_dir) +
           " disarm_after_frames=" + std::to_string(g_state.disarm_after_frames));
  attempt("scene-init");
}

void deinitialize(void * /*userdata*/, GDExtensionInitializationLevel level) {
  if (level != GDEXTENSION_INITIALIZATION_SCENE) {
    return;
  }
  // The shutdown callback normally gets here first; this is the backstop for an
  // unload that happens without it.
  do_disarm("deinitialize");
}

}  // namespace

}  // namespace grc

extern "C" __attribute__((visibility("default"))) GDExtensionBool
grc_library_init(GDExtensionInterfaceGetProcAddress p_get_proc_address,
                 GDExtensionClassLibraryPtr p_library,
                 GDExtensionInitialization *r_initialization) {
  if (r_initialization == nullptr) {
    return 0;
  }
  r_initialization->minimum_initialization_level = GDEXTENSION_INITIALIZATION_SCENE;
  r_initialization->userdata = nullptr;
  r_initialization->initialize = grc::initialize;
  r_initialization->deinitialize = grc::deinitialize;

  if (!grc::iface_load(p_get_proc_address, p_library)) {
    grc::log_line("GDExtension interface incomplete: missing " + grc::g_iface.missing);
    return 1;  // loaded, but every later decision refuses
  }
  GDExtensionMainLoopCallbacks callbacks = {};
  callbacks.startup_func = grc::on_startup;
  callbacks.shutdown_func = grc::on_shutdown;
  callbacks.frame_func = grc::on_frame;
  grc::g_iface.register_main_loop_callbacks(p_library, &callbacks);
  return 1;
}
