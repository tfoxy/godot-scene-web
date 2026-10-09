// GDExtension entry point and the arming decision.
//
// Nothing is written into the engine's memory until every check in
// `calib.h` has passed and `GRC_MODE=arm` was asked for. `validate` runs the
// identical checks and writes the identical evidence, but never touches the
// vptr.
//
// With GRC_STREAM_OUT set and the library armed, it also publishes the
// render-stream/0 recording (protocol/gate0-design.md "Publication"): the
// canvas mirror is enabled and the root viewport queried right after the vptr
// store, the session record is written at arm, one transaction per armed frame
// callback, and the end record exactly once at disarm or shutdown. Without
// GRC_STREAM_OUT the mirror stays off and the hooks behave as at gate -1.

#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <memory>
#include <string>
#include <vector>

#include "calib.h"
#include "hooks.h"
#include "iface.h"
#include "report.h"
#include "rs0_mirror.h"
#include "rs0_publish.h"
#include "rs0_root_query.h"
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

  // The hook plan of the arm decision (session capture.hooks_*).
  HookPlan plan;
};

// The render-stream/0 publication (gate 0). `status` is result.json
// `stream.status`: off | open | closed | refused | open-failed.
struct Stream {
  std::string path;  // GRC_STREAM_OUT; empty when unset
  std::string status = "off";
  std::string reason;  // empty -> null
  std::unique_ptr<rs0::FileRecordSink> sink;
  std::unique_ptr<rs0::Publisher> publisher;
};

Stream g_stream;

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
  // Additive (gate 0): the schema string is unchanged.
  json.key("stream").object_begin();
  json.field_or_null("path", g_stream.path);
  json.field("status", g_stream.status);
  json.field_or_null("reason", g_stream.reason);
  json.field("transactions",
             static_cast<int64_t>(g_stream.publisher != nullptr ? g_stream.publisher->transactions()
                                                                : 0));
  json.object_end();
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

uint64_t monotonic_ns() {
  return static_cast<uint64_t>(std::chrono::duration_cast<std::chrono::nanoseconds>(
                                   std::chrono::steady_clock::now().time_since_epoch())
                                   .count());
}

// At arm, right after the vptr store: validates the sabotage environment,
// opens the recording, enables the mirror, runs the root query and writes the
// session record. A refusal or an open failure leaves the mirror off and
// publishes nothing; arming itself is unaffected.
void stream_start() {
  if (g_stream.path.empty()) {
    return;
  }
  const char *sabotage_kind = std::getenv("GRC_SABOTAGE");
  const char *sabotage_frame = std::getenv("GRC_SABOTAGE_FRAME");
  // GRC_SABOTAGE_FRAME is read only when GRC_SABOTAGE is set.
  const rs0::ParseResult sabotage =
      rs0::parse_sabotage(sabotage_kind, sabotage_kind != nullptr ? sabotage_frame : nullptr);
  if (!sabotage.ok) {
    log_line(std::string("stream: refused sabotage=") +
             (sabotage_kind != nullptr ? sabotage_kind : "") +
             (sabotage_frame != nullptr ? std::string(" frame=") + sabotage_frame
                                        : std::string()) +
             " (" + sabotage.error + ")");
    g_stream.status = "refused";
    g_stream.reason = sabotage.error;
    return;
  }

  rs0::Session session;
  session.session_id = rs0::generate_session_id();
  session.engine.version_string = g_state.fp.version_string;
  session.engine.sha256 = g_state.fp.exe_sha256;
  session.engine.display_server = g_state.display_server;
  session.engine.rendering_driver = g_state.rendering_driver;
  session.engine.rendering_method = g_state.rendering_method;
  session.capture.calibrator_version =
      static_cast<uint32_t>(std::strtoul(g_state.calib.calibrator_version.c_str(), nullptr, 10));
  session.capture.hooks_planned = g_state.plan.planned;
  session.capture.hooks_omitted = g_state.plan.omitted;
  session.features = rs0::gate0_features();
  if (sabotage.config.kind != rs0::SabotageKind::None) {
    session.sabotage.kind = sabotage.config.kind;
    session.sabotage.frame = sabotage.config.frame;
  }

  g_stream.sink = std::make_unique<rs0::FileRecordSink>();
  if (!g_stream.sink->open(g_stream.path)) {
    log_line("stream: cannot open " + g_stream.path);
    g_stream.status = "open-failed";
    g_stream.reason = "cannot open the recording";
    g_stream.sink.reset();
    return;
  }

  rs0::mirror_enable(true);  // off -> on: a fresh mirror session
  const rs0::RootInfo root = rs0::root_query_run();
  rs0::root_query_apply(root);  // a failure becomes the sticky root-query-failed
  if (sabotage.config.kind == rs0::SabotageKind::OmitUpdate) {
    rs0::mirror_set_drop_frame(sabotage.config.frame);
  }
  session.viewport.canvas_cull_mask = root.canvas_cull_mask;
  session.viewport.root_canvas = rs0::kRootCanvasId;
  session.clear_color = root.clear_color;
  session.root_canvas_xform = root.canvas_xform;
  session.host_visible_rect = root.visible_rect;

  g_stream.publisher = std::make_unique<rs0::Publisher>(*g_stream.sink, sabotage.config);
  if (!g_stream.publisher->start(session)) {
    log_line("stream: cannot write the session record to " + g_stream.path);
    rs0::mirror_enable(false);
    g_stream.sink->close();
    g_stream.status = "open-failed";
    g_stream.reason = "session write failed";
    return;
  }
  g_stream.status = "open";
  log_line("stream: open " + g_stream.path + " session=" + session.session_id +
           " root_query=" + (root.ok ? std::string("ok") : "failed at " + root.failed_step) +
           " sabotage=" +
           (sabotage.config.kind == rs0::SabotageKind::None
                ? std::string("none")
                : std::string(rs0::to_wire(sabotage.config.kind)) + "@" +
                      std::to_string(sabotage.config.frame)));
}

// Writes the end record and closes the recording. Only the first call while
// the stream is open does anything, so disarm, shutdown and deinitialize can
// all call it.
void stream_finish(rs0::EndReason reason) {
  if (g_stream.status != "open") {
    return;
  }
  rs0::mirror_enable(false);
  const bool ok = g_stream.publisher->finish(reason);
  g_stream.status = "closed";
  if (!ok && g_stream.reason.empty()) {
    g_stream.reason = "end record write failed";
  }
  const rs0::EndStats &stats = g_stream.publisher->stats();
  log_line(std::string("stream: closed (") + rs0::to_wire(reason) +
           ") transactions=" + std::to_string(g_stream.publisher->transactions()) +
           " bytes_total=" + std::to_string(stats.bytes_total) +
           " max_record_bytes=" + std::to_string(stats.max_record_bytes) +
           " encode_ns_total=" + std::to_string(stats.encode_ns_total) +
           " snapshot_ns_total=" + std::to_string(stats.snapshot_ns_total));
}

// One transaction for the frame callback at the end of iteration `frame`.
// The snapshot is copied under the mirror lock (timed) and encoded outside it.
void stream_publish(uint64_t frame) {
  if (g_stream.status != "open") {
    return;
  }
  const uint64_t t0 = monotonic_ns();
  rs0::Snapshot snapshot = rs0::mirror_snapshot(0, frame);
  const uint64_t snapshot_ns = monotonic_ns() - t0;
  if (!g_stream.publisher->publish_transaction(std::move(snapshot), frame, snapshot_ns)) {
    log_line("stream: write failed at frame " + std::to_string(frame));
    g_stream.reason = "transaction write failed";
    stream_finish(rs0::EndReason::Shutdown);
  }
}

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

  // Which hooks the record allows. A required (gate -1) hook the record does
  // not name refuses in both modes, so validate predicts arm; an optional hook
  // it does not name (a record from an older calibrator) is left out and
  // reported, not refused. Pure bookkeeping: nothing is called or written.
  HookPlan &plan = g_state.plan;
  const bool plan_ok = hooks_plan(g_state.calib, &plan);
  g_state.checks.push_back({"hook_plan", plan_ok, hooks_plan_detail(plan)});
  if (!plan.omitted.empty()) {
    log_line("hooks: " + hooks_plan_detail(plan));
  }
  if (!plan_ok) {
    refuse("slot-mask-mismatch");
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
  if (!g_state.shadow.arm(g_state.facts.singleton, static_cast<size_t>(g_state.calib.slot_count),
                          plan.replacements, &error)) {
    log_line("arm: " + error);
    refuse("arm-failed");
    return true;
  }
  g_state.armed = true;
  g_state.vptr_written = true;
  stream_start();
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
  // Only a library armed before this callback publishes for this frame: one
  // armed by the deferred attempt below saw none of the frame's calls.
  const bool armed_at_start = g_state.armed;
  if (!g_state.decided) {
    attempt("frame");
  }
  if (armed_at_start) {
    stream_publish(g_state.frames_total);
  }
  if (g_state.armed) {
    ++g_state.frames_armed;
    if (g_state.disarm_after_frames >= 0 &&
        static_cast<int64_t>(g_state.frames_armed) >= g_state.disarm_after_frames) {
      stream_finish(rs0::EndReason::Disarm);
      do_disarm("frame");
    }
  }
}

void on_shutdown() {
  stream_finish(rs0::EndReason::Shutdown);
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
  g_stream.path = env_string("GRC_STREAM_OUT");
  if (!g_state.evidence_dir.empty()) {
    g_state.evidence_ready = make_directories(g_state.evidence_dir);
    if (!g_state.evidence_ready) {
      log_line("cannot create evidence directory " + g_state.evidence_dir);
    }
  }
  log_line("scene init: mode=" + g_state.mode + " calibration=" +
           (g_state.calibration_path.empty() ? "<unset>" : g_state.calibration_path) +
           " evidence=" + (g_state.evidence_dir.empty() ? "<stdout>" : g_state.evidence_dir) +
           " disarm_after_frames=" + std::to_string(g_state.disarm_after_frames) +
           " stream=" + (g_stream.path.empty() ? std::string("<off>") : g_stream.path));
  attempt("scene-init");
}

void deinitialize(void * /*userdata*/, GDExtensionInitializationLevel level) {
  if (level != GDEXTENSION_INITIALIZATION_SCENE) {
    return;
  }
  // The shutdown callback normally gets here first; this is the backstop for an
  // unload that happens without it.
  stream_finish(rs0::EndReason::Shutdown);
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
