// GDExtension entry point and the arming decision.
//
// Nothing is written into the engine's memory until every check in
// `calib.h` has passed and `GRC_MODE=arm` was asked for. `validate` runs the
// identical checks and writes the identical evidence, but never touches the
// vptr.
//
// With GRC_STREAM_OUT and/or GRC_STREAM_PATCH_OUT set and the library armed,
// it also publishes render-stream/2 recordings (protocol/render-stream-2.md;
// protocol/gate1-design.md "G1b2", gate2-design.md "G2b2"): GRC_STREAM_OUT is
// the `full`-encoding file sink, GRC_STREAM_PATCH_OUT the `patch`-encoding
// one; either or both.
// The canvas mirror is enabled and the root viewport queried right after the
// vptr store, a session record is written to each sink at arm (same
// session_id, one stream_id per sink), then one transaction per sink per
// armed frame callback from ONE mirror snapshot, and each sink's end record
// exactly once at disarm or shutdown. With neither set the mirror stays off
// and the hooks behave as at gate -1.
//
// Sabotage (GRC_SABOTAGE / GRC_SABOTAGE_FRAME / GRC_SABOTAGE_OP, validated by
// rs2::parse_sabotage; a refusal publishes nothing): omit-update and omit-op
// act in the mirror, freeze-frame, perturb-transform and patch-drop-item in
// the publisher, drop-message (G1c2), ignore-credit and stale-coalesce (G1d)
// in the live hub; G2b2's stale-texture in the publisher, wrong-hash in the
// resource store and spurious-texture-update in the mirror at the frame
// callback.
//
// The root-size policy GRC_ROOT_SIZE (observe | enforce-min-size; G1a,
// gate1-design.md "Q1") is applied at arm between the root query and the
// session record. What it saw and did goes on the wire -- the session's
// `viewport` object and blocks, read after the policy; the session-level
// `degenerate-host-size` entry whenever host_size_status != match; the sticky
// failure `root-size-enforce-failed` when enforce-min-size could not make it
// match -- and, as at G1a, to evidence/root.json
// (render-stream-root-geometry/1).
//
// Live delivery (G1c2, gate1-design.md Q3, Q4, "G1c2"): GRC_LIVE_LISTEN
// (127.0.0.1:<port> or [::1]:<port>; port 0 = ephemeral) also enables the
// mirror and the root query, with or without file sinks, and starts the rs_ws
// server (own I/O thread) at arm; evidence/live.json says what the listener
// became (render-stream-live/1). Each frame callback drains the server's
// events into the live hub (rs_live.h) and, when a connection can take a
// transaction, hands it the same published copy the file sinks got. Nothing
// on the main thread waits on a socket. GRC_LIVE_TAP_DIR,
// GRC_LIVE_MAX_MESSAGE_BYTES and GRC_LIVE_HELLO_TIMEOUT_MS configure the hub;
// the live sabotages (drop-message, ignore-credit, stale-coalesce) need
// GRC_LIVE_LISTEN. At shutdown or disarm every
// streaming connection gets its end record; the host then lingers up to 1.5 s
// for the receivers to close after reading it (a Godot client loses messages
// that arrive together with a close frame), closes the rest with 1000, stops
// the server with a 2-second flush budget and writes
// evidence/live-summary.json. At shutdown the linger blocks (the game is
// quitting); after a disarm it runs across the following frame callbacks, so
// the simulation never waits on a socket.
//
// Textures (G2a, gate2-design.md D3, Q3): whenever a stream is enabled,
// texture_2d_create and texture_2d_update copy the Image bytes into a GRT1
// payload and hash it on the calling thread before forwarding, and every
// texture-related call is written to evidence/resources.jsonl
// (render-stream-resource-log/1, rs_resource_log.h), drained at each frame
// callback. GRC_RESOURCE_FORMATS (default L8,LA8,R8,RG8,RGB8,RGBA8) and
// GRC_RESOURCE_MAX_PAYLOAD_BYTES (default 64 MiB) are read at arm; an invalid
// value, or an engine without the Image binds and image_ptr
// (image-access-unavailable), refuses to publish.
//
// Resources (G2b2, gate2-design.md Q3, Q4 "File sinks", render-stream-2.md):
// the mirror keeps every texture's payload, and each published snapshot names
// the versions it needs. GRC_RESOURCE_INLINE_MAX_BYTES (default 0) is the
// largest payload a file sink carries in band as a `resource` record; every
// larger `ok` payload goes to the content-addressed store directory
// GRC_RESOURCE_STORE_DIR (absolute), required whenever a file sink is open and
// delivery is not inline (refused as resource-store-missing). A store write
// failure ends the stream (resource-store-failed), as does more retained
// payload than GRC_RESOURCE_BUDGET_BYTES (default 512 MiB;
// resource-budget-exceeded): both land in result.json `stream.reason`.
//
// Live resources (G2c2, gate2-design.md D6, D7, Q4 "Live: server, store and
// pins"): every live connection declares the configured policy with fetch
// http (`/resources/sha256/`); GRC_RESOURCE_INLINE_MAX_BYTES above 1 MiB is
// refused with GRC_LIVE_LISTEN. The server's ResourceSource is a
// ServedResources (rs_resource_store.h): at each frame callback the published
// snapshot's payloads (and any stale-coalesce copy) are pinned before the hub
// sends, and after the sends everything that is neither in that snapshot nor
// in a connection's base (its last sent transaction) is retired; pins,
// retirements and every GET the server answered go to the hook log
// (`pin`, `retire`, `http-get`), and the retained bytes count against the
// budget. Sabotages unpin and drop-resource (both need GRC_LIVE_LISTEN) act
// there, and wrong-hash serves the store's corrupted copy.

#include <algorithm>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <memory>
#include <string>
#include <thread>
#include <vector>

#include "calib.h"
#include "hooks.h"
#include "iface.h"
#include "report.h"
#include "rs_live.h"
#include "rs_mirror.h"
#include "rs_publish.h"
#include "rs_resource_log.h"
#include "rs_resource_store.h"
#include "rs_root_query.h"
#include "rs_texture_payload.h"
#include "rs_ws.h"
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

// The render-stream/2 file publication (G1b2, G2b2). `status` is result.json
// `stream.status`: off | open | closed | refused | open-failed.
struct Stream {
  std::string path;        // GRC_STREAM_OUT (full sink); empty when unset
  std::string patch_path;  // GRC_STREAM_PATCH_OUT (patch sink); empty when unset
  std::string status = "off";
  std::string reason;  // empty -> null
  std::unique_ptr<rs2::FileRecordSink> full_sink;
  std::unique_ptr<rs2::FileRecordSink> patch_sink;
  std::unique_ptr<rs2::Publisher> publisher;
  // Gate 2 (G2b2): the resource policy, the store directory (GRC_RESOURCE_STORE_DIR; null when
  // every payload travels inline), the budget and the spurious-texture-update frame (0: off).
  rs2::ResourcePolicy policy;
  std::string store_dir;
  std::unique_ptr<rs::ResourceStore> store;
  uint64_t budget_bytes = 512ull << 20;
  uint64_t retained_bytes_max = 0;
  uint64_t spurious_frame = 0;
  // Gate 2 (G2a): evidence/resources.jsonl, the texture hook log
  // (rs_resource_log.h), written whenever a stream is enabled.
  std::FILE *resources_file = nullptr;
  std::string resources_path;
};

Stream g_stream;

// The live adapter (G1c2). `status` is evidence/live.json and result.json
// `live.status`: off | listening | refused | failed, then closed.
struct Live {
  std::string listen;  // GRC_LIVE_LISTEN as given; empty when unset
  std::string status = "off";
  std::string address;
  int64_t port = -1;
  std::string reason;
  // G2c2: what the server serves over HTTP. Declared before `server`, which holds a pointer to
  // it, so it outlives the server.
  std::unique_ptr<rs::ServedResources> served;
  rs2::ServingSummary serving;  // every GET the server answered, for the summary
  std::unique_ptr<live::Server> server;
  std::unique_ptr<rs2::ServerTransport> transport;
  std::unique_ptr<rs2::Hub> hub;
  // After the end records went out: wait (bounded) for the receivers to close first
  // (rs2::Hub::finish).
  bool ending = false;
  bool stopped = false;
  uint64_t linger_deadline_ns = 0;
};

// How long the host waits for receivers to close after their end record (rs_live.h, finish).
constexpr uint64_t kLiveLingerNs = 1500ull * 1000ull * 1000ull;

// G2c2 (gate2-design.md Q4): the largest inline threshold a live host accepts.
constexpr uint64_t kLiveInlineMaxBytes = 1048576;

bool is_lower_hex64(const std::string &text) {
  if (text.size() != 64) {
    return false;
  }
  for (const char c : text) {
    if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) {
      return false;
    }
  }
  return true;
}

Live g_live;

// GRC_ROOT_SIZE, read at arm (gate1-design.md Q1 "Policy").
using rs2::RootSizePolicy;

bool parse_root_size_policy(const char *value, RootSizePolicy *out) {
  if (value == nullptr || std::strcmp(value, "") == 0 || std::strcmp(value, "observe") == 0) {
    *out = RootSizePolicy::Observe;
    return true;
  }
  if (std::strcmp(value, "enforce-min-size") == 0) {
    *out = RootSizePolicy::EnforceMinSize;
    return true;
  }
  return false;
}

// Transactions written per sink (both sinks advance together).
int64_t stream_transactions() {
  if (g_stream.publisher == nullptr) {
    return 0;
  }
  const bool full = g_stream.publisher->has_sink(rs2::Encoding::Full);
  const rs2::Encoding encoding = full ? rs2::Encoding::Full : rs2::Encoding::Patch;
  return static_cast<int64_t>(g_stream.publisher->transactions(encoding));
}

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
  json.field_or_null("patch_path", g_stream.patch_path);
  json.field("status", g_stream.status);
  json.field_or_null("reason", g_stream.reason);
  json.field("transactions", stream_transactions());
  json.object_end();
  // Additive (G1c2).
  json.key("live").object_begin();
  json.field("status", g_live.status);
  json.field_or_null("listen", g_live.listen);
  json.field_or_null("address", g_live.address);
  json.field("port", g_live.port);
  json.field_or_null("reason", g_live.reason);
  json.field("connections",
             static_cast<int64_t>(g_live.hub != nullptr ? g_live.hub->connections() : 0));
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

void write_xform(JsonWriter *json, const std::string &name, const rs2::Xform &xform) {
  json->key(name).array_begin();
  for (float value : xform) {
    json->float32(value);
  }
  json->array_end();
}

void write_geometry(JsonWriter *json, const std::string &name, const rs::RootInfo &info) {
  json->key(name).object_begin();
  json->key("window_size").array_begin();
  json->integer(info.window_size[0]).integer(info.window_size[1]);
  json->array_end();
  json->key("visible_rect").array_begin();
  for (float value : info.visible_rect) {
    json->float32(value);
  }
  json->array_end();
  write_xform(json, "canvas_transform", info.canvas_xform);
  write_xform(json, "final_transform", info.final_transform);
  json->object_end();
}

// evidence/root.json (render-stream-root-geometry/1, gate1-design.md G1a).
std::string root_geometry_json(RootSizePolicy policy, const rs::RootInfo &before,
                               const rs::RootInfo &after, rs2::HostSizeStatus status,
                               bool enforce_called, bool enforce_ok,
                               const std::string &enforce_detail) {
  JsonWriter json;
  json.object_begin();
  json.field("schema", std::string("render-stream-root-geometry/1"));
  json.field("policy", std::string(rs2::to_wire(policy)));
  json.key("logical_size").array_begin();
  json.integer(after.logical_size[0]).integer(after.logical_size[1]);
  json.array_end();
  json.key("stretch").object_begin();
  json.field("mode", std::string(rs::content_scale_mode_name(after.content_scale_mode)));
  json.field("aspect", std::string(rs::content_scale_aspect_name(after.content_scale_aspect)));
  json.field("scale_mode",
             std::string(rs::content_scale_stretch_name(after.content_scale_stretch)));
  json.object_end();
  json.key("content_scale_factor").float32(static_cast<float>(after.content_scale_factor));
  write_geometry(&json, "before", before);
  write_geometry(&json, "after", after);
  json.field("host_size_status", std::string(rs2::to_wire(status)));
  json.key("enforce").object_begin();
  json.field("called", enforce_called);
  json.field("ok", enforce_ok);
  json.field_or_null("detail", enforce_detail);
  json.object_end();
  json.field_or_null("root_query_failed_step", after.ok ? std::string() : after.failed_step);
  // Additive (G2a, gate2-design.md Q1d): the root's default canvas-item texture
  // filter and repeat as read at arm, as Viewport scene enums (-1: unread).
  json.key("texture_defaults").object_begin();
  json.field("filter", before.default_texture_filter);
  json.field("repeat", before.default_texture_repeat);
  json.object_end();
  json.object_end();
  return json.take();
}

// --- the texture hook log (G2a) ----------------------------------------------

// Appends whatever the hooks logged since the last call to
// evidence/resources.jsonl. Main thread (frame callback, stream end).
void resources_drain() {
  const std::string lines = rs::resource_log().take_lines();
  if (lines.empty() || g_stream.resources_file == nullptr) {
    return;
  }
  if (std::fwrite(lines.data(), 1, lines.size(), g_stream.resources_file) != lines.size() ||
      std::fflush(g_stream.resources_file) != 0) {
    log_line("resources: write failed: " + g_stream.resources_path);
  }
}

// Starts the log for a stream that just opened: GRC_RESOURCE_* were validated
// by the caller; the root viewport RID marks root-viewport filter calls.
void resources_start(uint64_t root_viewport_rid) {
  if (g_state.evidence_ready) {
    g_stream.resources_path = path_join(g_state.evidence_dir, "resources.jsonl");
    g_stream.resources_file = std::fopen(g_stream.resources_path.c_str(), "w");
    if (g_stream.resources_file == nullptr) {
      log_line("resources: cannot open " + g_stream.resources_path);
    }
  }
  rs::resource_log().start(monotonic_ns(), root_viewport_rid);
}

void resources_finish() {
  rs::resource_log().stop();
  resources_drain();
  if (g_stream.resources_file != nullptr) {
    std::fclose(g_stream.resources_file);
    g_stream.resources_file = nullptr;
  }
}

std::string size_text(const int32_t size[2]) {
  return std::to_string(size[0]) + "x" + std::to_string(size[1]);
}

std::string rect_size_text(const rs2::Rect4 &rect) {
  char buffer[64];
  std::snprintf(buffer, sizeof(buffer), "%gx%g", static_cast<double>(rect[2]),
                static_cast<double>(rect[3]));
  return buffer;
}

// Closes and drops both file sinks (an open failure before the publisher exists).
void stream_drop_sinks() {
  if (g_stream.full_sink != nullptr) {
    g_stream.full_sink->close();
  }
  if (g_stream.patch_sink != nullptr) {
    g_stream.patch_sink->close();
  }
  g_stream.full_sink.reset();
  g_stream.patch_sink.reset();
}

// Opens one file sink; false (after logging) when the file cannot be created.
bool stream_open_sink(const std::string &path, std::unique_ptr<rs2::FileRecordSink> *out) {
  if (path.empty()) {
    return true;
  }
  *out = std::make_unique<rs2::FileRecordSink>();
  if (!(*out)->open(path)) {
    log_line("stream: cannot open " + path);
    return false;
  }
  return true;
}

std::string sabotage_text(const rs2::SabotageConfig &config) {
  if (config.kind == rs2::SabotageKind::None) {
    return "none";
  }
  std::string text = std::string(rs2::to_wire(config.kind)) + "@" + std::to_string(config.frame);
  if (config.kind == rs2::SabotageKind::OmitOp) {
    text += " op=" + config.op;
  }
  return text;
}

// GRC_LIVE_LISTEN: "127.0.0.1:<port>" or "[::1]:<port>" (gate1-design.md
// "G1c2"). Returns false with *reason "non-loopback" for any other host, or
// a description of the malformation.
bool parse_listen(const std::string &text, std::string *host, uint16_t *port, std::string *reason) {
  std::string h;
  std::string p;
  if (!text.empty() && text[0] == '[') {
    const std::size_t close = text.find(']');
    if (close == std::string::npos || close + 1 >= text.size() || text[close + 1] != ':') {
      *reason = "invalid GRC_LIVE_LISTEN=" + text + " (expected [::1]:<port>)";
      return false;
    }
    h = text.substr(1, close - 1);
    p = text.substr(close + 2);
  } else {
    const std::size_t colon = text.rfind(':');
    if (colon == std::string::npos) {
      *reason = "invalid GRC_LIVE_LISTEN=" + text + " (expected 127.0.0.1:<port>)";
      return false;
    }
    h = text.substr(0, colon);
    p = text.substr(colon + 1);
  }
  if (p.empty() || p.size() > 5 || p.find_first_not_of("0123456789") != std::string::npos ||
      std::stoul(p) > 65535) {
    *reason = "invalid GRC_LIVE_LISTEN port \"" + p + "\"";
    return false;
  }
  if (h != "127.0.0.1" && h != "::1") {
    *reason = "non-loopback";
    return false;
  }
  *host = h;
  *port = static_cast<uint16_t>(std::stoul(p));
  return true;
}

// A positive decimal environment value, or `fallback` when unset. False when
// set and malformed.
bool env_positive(const char *name, uint64_t fallback, uint64_t *out) {
  const char *value = std::getenv(name);
  if (value == nullptr || *value == '\0') {
    *out = fallback;
    return true;
  }
  const std::string text(value);
  if (text.size() > 15 || text.find_first_not_of("0123456789") != std::string::npos) {
    return false;
  }
  *out = std::stoull(text);
  return *out >= 1;
}

// A non-negative decimal environment value, or `fallback` when unset. False
// when set and malformed.
bool env_non_negative(const char *name, uint64_t fallback, uint64_t *out) {
  const char *value = std::getenv(name);
  if (value == nullptr || *value == '\0') {
    *out = fallback;
    return true;
  }
  const std::string text(value);
  if (text.size() > 15 || text.find_first_not_of("0123456789") != std::string::npos) {
    return false;
  }
  *out = std::stoull(text);
  return true;
}

std::string live_json() {
  JsonWriter json;
  json.object_begin();
  json.field("schema", std::string("render-stream-live/1"));
  json.field("status", g_live.status);
  json.field_or_null("address", g_live.address);
  if (g_live.port < 0) {
    json.field_null("port");
  } else {
    json.field("port", g_live.port);
  }
  json.field_or_null("reason", g_live.reason);
  json.object_end();
  return json.take();
}

void live_decided(const std::string &status, const std::string &reason) {
  g_live.status = status;
  g_live.reason = reason;
  emit("live.json", live_json());
  log_line("live: " + status + (g_live.address.empty() ? std::string() : " " + g_live.address) +
           (g_live.port >= 0 ? ":" + std::to_string(g_live.port) : std::string()) +
           (reason.empty() ? std::string() : " (" + reason + ")"));
}

// At arm, right after the vptr store: validates the sabotage environment,
// opens the recordings, enables the mirror, runs the root query and the
// root-size policy, and writes the session records. A refusal or an open
// failure leaves the mirror off and publishes nothing; arming itself is
// unaffected.
void stream_start() {
  const bool files = !g_stream.path.empty() || !g_stream.patch_path.empty();
  if (!files && g_live.listen.empty()) {
    return;
  }
  const char *sabotage_kind = std::getenv("GRC_SABOTAGE");
  const char *sabotage_frame = std::getenv("GRC_SABOTAGE_FRAME");
  const char *sabotage_op = std::getenv("GRC_SABOTAGE_OP");
  // GRC_SABOTAGE_FRAME and GRC_SABOTAGE_OP are read only when GRC_SABOTAGE is set.
  const rs2::ParseResult sabotage =
      rs2::parse_sabotage(sabotage_kind, sabotage_kind != nullptr ? sabotage_frame : nullptr,
                          sabotage_kind != nullptr ? sabotage_op : nullptr);
  const char *root_size = std::getenv("GRC_ROOT_SIZE");
  RootSizePolicy policy = RootSizePolicy::Observe;
  if (!parse_root_size_policy(root_size, &policy)) {
    const std::string error = std::string("invalid GRC_ROOT_SIZE=") + root_size +
                              " (expected observe or enforce-min-size)";
    log_line("stream: refused root size policy (" + error + ")");
    g_stream.status = "refused";
    g_stream.reason = error;
    if (!g_live.listen.empty()) {
      live_decided("refused", "stream refused: " + error);
    }
    return;
  }
  // Gate 2 (G2a): the resource policy and the payload copy capability
  // (gate2-design.md D3, Q3). A stream never runs with texture copies it cannot
  // make, so either failure refuses to publish, as an invalid GRC_ROOT_SIZE does.
  {
    rs::FormatPolicy formats;
    uint64_t max_payload_bytes = 0;
    uint64_t inline_max_bytes = 0;
    std::string error;
    if (!rs::parse_format_policy(std::getenv("GRC_RESOURCE_FORMATS"), &formats, &error) ||
        !rs::parse_max_payload_bytes(std::getenv("GRC_RESOURCE_MAX_PAYLOAD_BYTES"),
                                     &max_payload_bytes, &error)) {
      // error says which variable
    } else if (!hooks_image_payload_available()) {
      error = "image-access-unavailable";
    } else if (!env_non_negative("GRC_RESOURCE_INLINE_MAX_BYTES", 0, &inline_max_bytes)) {
      error = "invalid GRC_RESOURCE_INLINE_MAX_BYTES (a decimal integer >= 0)";
    } else if (!env_positive("GRC_RESOURCE_BUDGET_BYTES", 512ull << 20,
                             &g_stream.budget_bytes)) {
      error = "invalid GRC_RESOURCE_BUDGET_BYTES (a decimal integer >= 1)";
    } else {
      g_stream.store_dir = env_string("GRC_RESOURCE_STORE_DIR");
      const bool delivery_inline = inline_max_bytes >= max_payload_bytes;
      if (!g_stream.store_dir.empty() && g_stream.store_dir[0] != '/') {
        error = "GRC_RESOURCE_STORE_DIR must be absolute";
      } else if (files && !delivery_inline && g_stream.store_dir.empty()) {
        // gate2-design.md Q4 "File sinks": a recording whose payloads have nowhere to go.
        error = "resource-store-missing";
      }
    }
    g_stream.policy.permitted_formats = formats.names;
    g_stream.policy.max_payload_bytes = max_payload_bytes;
    g_stream.policy.inline_max_bytes = inline_max_bytes;
    if (!error.empty()) {
      log_line("stream: refused resource policy (" + error + ")");
      g_stream.status = "refused";
      g_stream.reason = error;
      if (!g_live.listen.empty()) {
        live_decided("refused", "stream refused: " + error);
      }
      return;
    }
    hooks_set_resource_policy(formats, max_payload_bytes);
  }
  if (!sabotage.ok && !g_live.listen.empty()) {
    live_decided("refused", "sabotage refused: " + sabotage.error);
  }
  // Live configuration, decided before anything is opened (gate1-design.md G1c2).
  std::string live_host;
  uint16_t live_port = 0;
  rs2::LiveConfig live_config;
  bool live_ok = sabotage.ok && !g_live.listen.empty();
  if (live_ok) {
    std::string why;
    const char *tap = std::getenv("GRC_LIVE_TAP_DIR");
    live_config.tap_dir = tap != nullptr ? std::string(tap) : std::string();
    if (!parse_listen(g_live.listen, &live_host, &live_port, &why)) {
      live_ok = false;
    } else if (!env_positive("GRC_LIVE_MAX_MESSAGE_BYTES", 16u << 20,
                             &live_config.max_message_bytes)) {
      live_ok = false;
      why = "invalid GRC_LIVE_MAX_MESSAGE_BYTES (a decimal integer >= 1)";
    } else if (!env_positive("GRC_LIVE_HELLO_TIMEOUT_MS", 5000, &live_config.hello_timeout_ms)) {
      live_ok = false;
      why = "invalid GRC_LIVE_HELLO_TIMEOUT_MS (a decimal integer >= 1)";
    } else if (!live_config.tap_dir.empty() && live_config.tap_dir[0] != '/') {
      live_ok = false;
      why = "GRC_LIVE_TAP_DIR must be absolute";
    } else if (g_stream.policy.inline_max_bytes > kLiveInlineMaxBytes) {
      // gate2-design.md Q4: inline records over live share the credit window with the
      // transaction, so the threshold is capped at 1 MiB; bigger payloads go over HTTP.
      live_ok = false;
      why = "GRC_RESOURCE_INLINE_MAX_BYTES above " + std::to_string(kLiveInlineMaxBytes) +
            " with GRC_LIVE_LISTEN (inline over live is capped at 1 MiB)";
    }
    if (!live_ok) {
      live_decided("refused", why);
    }
  }
  if (sabotage.ok && !files && !live_ok) {
    g_stream.status = "refused";
    g_stream.reason = "no file sink and no live listener (" + g_live.reason + ")";
    return;
  }
  if (sabotage.ok) {
    const rs2::SabotageKind kind = sabotage.config.kind;
    std::string why;
    const bool live_kind = kind == rs2::SabotageKind::DropMessage ||
                           kind == rs2::SabotageKind::IgnoreCredit ||
                           kind == rs2::SabotageKind::StaleCoalesce ||
                           kind == rs2::SabotageKind::DropResource ||
                           kind == rs2::SabotageKind::Unpin;
    if (live_kind && !live_ok) {
      why = std::string(rs2::to_wire(kind)) + " needs GRC_LIVE_LISTEN";
    } else if (!files && (kind == rs2::SabotageKind::FreezeFrame ||
                          kind == rs2::SabotageKind::PerturbTransform ||
                          kind == rs2::SabotageKind::PatchDropItem ||
                          kind == rs2::SabotageKind::StaleTexture)) {
      why = std::string(rs2::to_wire(kind)) + " acts on the file publication; set a file sink";
    } else if (kind == rs2::SabotageKind::WrongHash &&
               (!files || g_stream.store_dir.empty())) {
      why = "wrong-hash acts on the resource store; set a file sink and GRC_RESOURCE_STORE_DIR";
    }
    if (!why.empty()) {
      log_line("stream: refused sabotage (" + why + ")");
      g_stream.status = "refused";
      g_stream.reason = why;
      if (live_ok) {
        live_decided("refused", "sabotage refused: " + why);
      }
      return;
    }
    if (kind == rs2::SabotageKind::DropMessage) {
      live_config.drop_message_frame = sabotage.config.frame;
    } else if (kind == rs2::SabotageKind::IgnoreCredit) {
      live_config.ignore_credit_frame = sabotage.config.frame;
    } else if (kind == rs2::SabotageKind::StaleCoalesce) {
      live_config.stale_coalesce_frame = sabotage.config.frame;
    } else if (kind == rs2::SabotageKind::SpuriousTextureUpdate) {
      g_stream.spurious_frame = sabotage.config.frame;
    }
  }
  if (!sabotage.ok) {
    log_line(std::string("stream: refused sabotage=") +
             (sabotage_kind != nullptr ? sabotage_kind : "") +
             (sabotage_frame != nullptr ? std::string(" frame=") + sabotage_frame
                                        : std::string()) +
             (sabotage_op != nullptr ? std::string(" op=") + sabotage_op : std::string()) + " (" +
             sabotage.error + ")");
    g_stream.status = "refused";
    g_stream.reason = sabotage.error;
    return;
  }

  rs2::Session session;
  session.session_id = rs2::generate_id();
  session.engine.version_string = g_state.fp.version_string;
  session.engine.sha256 = g_state.fp.exe_sha256;
  session.engine.display_server = g_state.display_server;
  session.engine.rendering_driver = g_state.rendering_driver;
  session.engine.rendering_method = g_state.rendering_method;
  session.capture.calibrator_version =
      static_cast<uint32_t>(std::strtoul(g_state.calib.calibrator_version.c_str(), nullptr, 10));
  session.capture.hooks_planned = g_state.plan.planned;
  session.capture.hooks_omitted = g_state.plan.omitted;
  session.features = rs2::gate2_features();
  if (sabotage.config.kind != rs2::SabotageKind::None) {
    session.sabotage.kind = sabotage.config.kind;
    session.sabotage.frame = sabotage.config.frame;
    // render-stream-1.md "Session record": `op` is non-null exactly for omit-op.
    session.sabotage.has_op = sabotage.config.kind == rs2::SabotageKind::OmitOp;
    session.sabotage.op = session.sabotage.has_op ? sabotage.config.op : std::string();
  }

  if (!stream_open_sink(g_stream.path, &g_stream.full_sink) ||
      !stream_open_sink(g_stream.patch_path, &g_stream.patch_sink)) {
    g_stream.status = "open-failed";
    g_stream.reason = "cannot open the recording";
    stream_drop_sinks();
    return;
  }
  if (files && !g_stream.store_dir.empty()) {
    g_stream.store = std::make_unique<rs::ResourceStore>();
    std::string error;
    if (!g_stream.store->open(g_stream.store_dir, &error)) {
      log_line("stream: " + error);
      g_stream.store.reset();
      g_stream.status = "open-failed";
      g_stream.reason = "resource-store-failed: " + error;
      stream_drop_sinks();
      return;
    }
  }

  rs::mirror_enable(true);  // off -> on: a fresh mirror session
  const rs::RootInfo before = rs::root_query_run();
  // Binds the root RIDs before the policy runs, so any viewport call the
  // min-size write causes is attributed to the root. A failure becomes the
  // sticky root-query-failed.
  rs::root_query_apply(before);
  rs::RootInfo after = before;
  bool enforce_called = false;
  bool enforce_ok = true;
  std::string enforce_detail;
  if (policy == RootSizePolicy::EnforceMinSize) {
    enforce_called = true;
    if (!rs::root_enforce_min_size(before, &enforce_detail)) {
      enforce_ok = false;
    }
    // Read back what the write did; the declaration is always the after state.
    after = rs::root_query_run();
    rs::mirror_set_root(after.viewport_rid, after.canvas_rid, after.canvas_xform);
    if (!after.ok) {
      rs::mirror_fail_root_query(after.failed_step);
    }
  }
  const rs2::HostSizeStatus host_status = rs::host_size_status(after);
  if (policy == RootSizePolicy::EnforceMinSize && host_status != rs2::HostSizeStatus::Match) {
    enforce_ok = false;
    if (enforce_detail.empty()) {
      enforce_detail = std::string(rs2::to_wire(host_status)) + ": window " +
                       size_text(after.window_size) + ", visible " +
                       rect_size_text(after.visible_rect) + ", logical " +
                       size_text(after.logical_size);
    }
  }
  if (host_status != rs2::HostSizeStatus::Match) {
    // render-stream-1.md "Unsupported reasons": the session-level
    // degenerate-host-size entry is present exactly when status != match.
    rs::mirror_set_degenerate_host_size(true);
  }
  if (!enforce_ok) {
    // gate1-design.md Q1 "Policy": the operator asked for a guarantee the
    // library could not give.
    rs::mirror_fail_root_size_enforce(enforce_detail);
  }
  emit("root.json", root_geometry_json(policy, before, after, host_status, enforce_called,
                                       enforce_ok, enforce_detail));
  log_line(std::string("root size: policy=") + rs2::to_wire(policy) +
           " logical=" + size_text(after.logical_size) + " window " +
           size_text(before.window_size) + " -> " + size_text(after.window_size) + " visible " +
           rect_size_text(before.visible_rect) + " -> " + rect_size_text(after.visible_rect) +
           " status=" + rs2::to_wire(host_status) +
           (enforce_ok ? std::string() : " ENFORCE FAILED (" + enforce_detail + ")"));
  const rs::RootInfo &root = after;
  // G2b2 (gate2-design.md D9, Q1d): the root viewport's default texture filter and repeat, read
  // at arm as Viewport scene enums and mapped to the RenderingServer enums the setters use
  // (scene/main/viewport.cpp:3903-3925, :3934-3958). The hooks follow later changes.
  {
    static const rs2::Filter kFilters[] = {rs2::Filter::Nearest, rs2::Filter::Linear,
                                           rs2::Filter::LinearMipmaps,
                                           rs2::Filter::NearestMipmaps};
    static const rs2::Repeat kRepeats[] = {rs2::Repeat::Disabled, rs2::Repeat::Enabled,
                                           rs2::Repeat::Mirror};
    const int64_t filter = root.default_texture_filter >= 0 ? root.default_texture_filter
                                                             : before.default_texture_filter;
    const int64_t repeat = root.default_texture_repeat >= 0 ? root.default_texture_repeat
                                                             : before.default_texture_repeat;
    rs::mirror_instance().set_texture_defaults(
        filter >= 0 && filter < 4 ? kFilters[filter] : rs2::Filter::Default,
        repeat >= 0 && repeat < 3 ? kRepeats[repeat] : rs2::Repeat::Default);
  }
  if (sabotage.config.kind == rs2::SabotageKind::OmitUpdate) {
    rs::mirror_set_drop_frame(sabotage.config.frame);
  } else if (sabotage.config.kind == rs2::SabotageKind::OmitOp) {
    rs::mirror_set_omit_op(sabotage.config.op, sabotage.config.frame);
  }
  // render-stream-1.md "Session record": `viewport` and the blocks, all read
  // after the root-size policy.
  session.viewport.canvas_cull_mask = root.canvas_cull_mask;
  session.viewport.root_canvas = rs2::kRootCanvasId;
  session.viewport.logical_size = {root.logical_size[0], root.logical_size[1]};
  if (!rs::stretch_from_window(root, &session.viewport.stretch)) {
    log_line("root size: content scale enum out of range (mode=" +
             std::to_string(root.content_scale_mode) +
             " aspect=" + std::to_string(root.content_scale_aspect) +
             " stretch=" + std::to_string(root.content_scale_stretch) + ")");
  }
  session.viewport.root_size_policy = policy;
  session.viewport.host_size_status = host_status;
  session.viewport.host_window_size = {root.window_size[0], root.window_size[1]};
  session.clear_color = root.clear_color;
  session.root_canvas_xform = root.canvas_xform;
  session.host_visible_rect = root.visible_rect;
  session.host_final_xform = root.final_transform;
  session.content_scale_factor = static_cast<float>(root.content_scale_factor);

  if (files) {
    g_stream.publisher = std::make_unique<rs2::Publisher>(
        g_stream.full_sink.get(), g_stream.patch_sink.get(), sabotage.config, g_stream.policy,
        g_stream.store.get());
    g_stream.publisher->set_resource_events([](const char *op, const std::string &hash,
                                               uint64_t bytes, bool ok, uint64_t frame) {
      rs::TapContext ctx;
      ctx.frame = frame;
      ctx.t_ns = monotonic_ns();
      ctx.main_thread = true;
      rs::resource_log().resource_event(ctx, op, hash, bytes, ok ? "ok" : "failed");
    });
    if (!g_stream.publisher->start(session)) {
      log_line("stream: cannot write the session record");
      rs::mirror_enable(false);
      stream_drop_sinks();
      g_stream.publisher.reset();
      g_stream.status = "open-failed";
      g_stream.reason = "session write failed";
      if (live_ok) {
        live_decided("refused", "stream open failed");
      }
      return;
    }
  }
  if (live_ok) {
    live::ServerConfig server_config;
    server_config.host = live_host;
    server_config.port = live_port;
    server_config.max_clients = 1;  // D5: one receiver at a time (a second gets 503)
    server_config.subprotocol = "render-stream.2";  // render-stream-2.md "Live transport"
    g_live.address = live_host;
    g_live.server = std::make_unique<live::Server>();
    std::string error;
    // G2c2: the served payloads answer every resource GET on this listener.
    g_live.served = std::make_unique<rs::ServedResources>();
    if (sabotage.config.kind == rs2::SabotageKind::Unpin) {
      g_live.served->set_unpin_frame(sabotage.config.frame);
    } else if (sabotage.config.kind == rs2::SabotageKind::DropResource) {
      g_live.served->set_drop_frame(sabotage.config.frame);
    }
    g_live.serving.budget_bytes = g_stream.budget_bytes;
    if (!g_live.server->start(server_config, g_live.served.get(), &error)) {
      g_live.server.reset();
      live_decided(error == "non-loopback" ? "refused" : "failed", error);
      if (!files) {
        rs::mirror_enable(false);
        g_stream.status = "open-failed";
        g_stream.reason = "live listener failed: " + error;
        return;
      }
    } else {
      g_live.port = g_live.server->port();
      g_live.transport = std::make_unique<rs2::ServerTransport>(g_live.server.get());
      rs2::Session tmpl = session;
      tmpl.stream = rs2::StreamInfo();
      // G2c2: every live connection follows the configured policy; out-of-band payloads come
      // from GET /resources/sha256/<hash> on this listener.
      tmpl.resources = rs2::resources_info(g_stream.policy, rs2::Fetch::Http);
      g_live.hub = std::make_unique<rs2::Hub>(g_live.transport.get(), live_config, tmpl);
      live_decided("listening", std::string());
    }
  }
  g_stream.status = "open";
  resources_start(root.viewport_rid);
  const rs2::Publisher *publisher = g_stream.publisher.get();
  const auto stream_id = [publisher](rs2::Encoding encoding) {
    return publisher != nullptr && publisher->has_sink(encoding)
               ? publisher->session(encoding).stream.stream_id
               : std::string("-");
  };
  log_line("stream: open full=" + (g_stream.path.empty() ? std::string("<off>") : g_stream.path) +
           " full_stream=" + stream_id(rs2::Encoding::Full) +
           " patch=" + (g_stream.patch_path.empty() ? std::string("<off>") : g_stream.patch_path) +
           " patch_stream=" + stream_id(rs2::Encoding::Patch) + " session=" + session.session_id +
           " root_query=" + (root.ok ? std::string("ok") : "failed at " + root.failed_step) +
           " live=" +
           (g_live.hub != nullptr ? g_live.address + ":" + std::to_string(g_live.port)
                                  : std::string("<off>")) +
           " sabotage=" + sabotage_text(sabotage.config) + " resources=" +
           (g_stream.resources_file != nullptr ? g_stream.resources_path : std::string("<off>")));
}

// Drains the server's events into the hub (frame callback, main thread).
void live_drain(uint64_t frame) {
  if (g_live.hub == nullptr || g_live.server == nullptr || g_live.stopped) {
    return;
  }
  for (const live::Event &event : g_live.server->take_events()) {
    if (event.kind == live::Event::HttpGet) {
      // G2c2: one resource GET the server answered on its I/O thread, attributed to the
      // connection streaming at the time and logged (http-get) with the I/O thread's time.
      ++g_live.serving.http_gets;
      if (event.http_status == 200) {
        g_live.serving.http_bytes += event.bytes;
      } else {
        ++g_live.serving.http_errors;
      }
      const uint32_t conn =
          g_live.hub->on_http_get(event.hash, event.http_status, event.bytes, event.t_ns, frame);
      rs::TapContext ctx;
      ctx.frame = frame;
      ctx.t_ns = event.t_ns;
      ctx.main_thread = false;
      rs::resource_log().serve_event(ctx, "http-get", is_lower_hex64(event.hash) ? event.hash : "",
                                     event.bytes, nullptr, conn, event.http_status, false);
      continue;
    }
    g_live.hub->on_event(rs2::to_live_event(event), frame);
  }
}

// The end of the linger: close whatever is still open with 1000, stop the
// server with a 2-second flush budget, write evidence/live-summary.json.
void live_close_and_stop() {
  if (g_live.hub == nullptr || g_live.stopped) {
    return;
  }
  live_drain(g_state.frames_total);
  g_live.hub->close_open(g_state.frames_total);
  if (g_live.server != nullptr) {
    g_live.server->stop(2000);
  }
  g_live.stopped = true;
  g_live.ending = false;
  if (g_live.served != nullptr) {
    const rs::ServedResources::Totals totals = g_live.served->totals();
    g_live.serving.pinned = totals.pinned;
    g_live.serving.retired = totals.retired;
    g_live.serving.retired_unpinned = totals.retired_unpinned;
    g_live.serving.retained_max = totals.retained_max;
    g_live.serving.retained_bytes_max = totals.retained_bytes_max;
    g_live.serving.retained_end = g_live.served->retained();
    g_live.serving.retained_bytes_end = g_live.served->retained_bytes();
    g_live.serving.dropped_hash = g_live.served->dropped_hash();
    g_live.serving.corrupted_hash =
        g_stream.store != nullptr ? g_stream.store->corrupted_hash() : std::string();
    log_line("live: resources http_gets=" + std::to_string(g_live.serving.http_gets) +
             " http_bytes=" + std::to_string(g_live.serving.http_bytes) +
             " http_errors=" + std::to_string(g_live.serving.http_errors) +
             " pinned=" + std::to_string(totals.pinned) + " retired=" +
             std::to_string(totals.retired) + " (unpin " +
             std::to_string(totals.retired_unpinned) + ") retained_max=" +
             std::to_string(totals.retained_max) +
             " retained_bytes_max=" + std::to_string(totals.retained_bytes_max));
  }
  emit("live-summary.json",
       g_live.hub->summary_json(g_live.served != nullptr ? &g_live.serving : nullptr));
  for (const rs2::ConnectionSummary &s : g_live.hub->summaries()) {
    log_line("live: connection " + std::to_string(s.connection) + " stream " + s.stream_id +
             " offered=" + std::to_string(s.frames_offered) +
             " formed=" + std::to_string(s.transactions) + " sent=" + std::to_string(s.sent) +
             " dropped=" + std::to_string(s.dropped) + " coalesced=" +
             std::to_string(s.coalesced) + " acks=" + std::to_string(s.acks[0]) + "/" +
             std::to_string(s.acks[1]) + "/" + std::to_string(s.acks[2]) +
             " bytes_sent=" + std::to_string(s.bytes_sent) +
             " credit_rtt_us p50/p95=" + std::to_string(s.credit_rtt_us.median) + "/" +
             std::to_string(s.credit_rtt_us.p95) + " close=" + std::to_string(s.close_code) +
             " by " + s.closed_by);
  }
  g_live.status = "closed";
}

// One linger step: drain closes; stop once every receiver closed or the
// linger ran out. `blocking` waits here (shutdown); otherwise the next frame
// callback continues (disarm).
void live_linger(bool blocking) {
  if (!g_live.ending || g_live.stopped) {
    return;
  }
  for (;;) {
    live_drain(g_state.frames_total);
    if (g_live.hub->open_connections() == 0 || monotonic_ns() >= g_live.linger_deadline_ns) {
      live_close_and_stop();
      return;
    }
    if (!blocking) {
      return;
    }
    std::this_thread::sleep_for(std::chrono::milliseconds(5));
  }
}

// Ends live delivery: the end record to every streaming connection
// (rs2::Hub::finish), then the linger.
void live_finish(rs2::EndReason reason, bool blocking) {
  if (g_live.hub == nullptr || g_live.ending || g_live.stopped) {
    return;
  }
  live_drain(g_state.frames_total);
  g_live.hub->finish(reason, g_state.frames_total, monotonic_ns());
  g_live.ending = true;
  g_live.linger_deadline_ns = monotonic_ns() + kLiveLingerNs;
  live_linger(blocking);
}

// Writes each sink's end record and closes the recordings. Only the first call
// while the stream is open does anything, so disarm, shutdown and deinitialize
// can all call it.
void stream_finish(rs2::EndReason reason) {
  if (g_stream.status != "open") {
    return;
  }
  rs::mirror_enable(false);
  live_drain(g_state.frames_total);  // G2c2: GETs answered so far reach the hook log first
  resources_finish();
  live_finish(reason, reason == rs2::EndReason::Shutdown);
  if (g_stream.publisher == nullptr) {
    g_stream.status = "closed";
    return;
  }
  const bool ok = g_stream.publisher->finish(reason);
  g_stream.status = "closed";
  if (!ok && g_stream.reason.empty()) {
    g_stream.reason = "end record write failed";
  }
  if (g_stream.store != nullptr) {
    log_line("stream: store " + g_stream.store->dir() + " hashes=" +
             std::to_string(g_stream.store->hashes()) + " bytes=" +
             std::to_string(g_stream.store->bytes()) +
             (g_stream.store->corrupted_hash().empty()
                  ? std::string()
                  : " corrupted=" + g_stream.store->corrupted_hash()));
    g_stream.store->close();
  }
  log_line("stream: resources retained_bytes_max=" + std::to_string(g_stream.retained_bytes_max) +
           " budget=" + std::to_string(g_stream.budget_bytes));
  for (const rs2::Encoding encoding : {rs2::Encoding::Full, rs2::Encoding::Patch}) {
    if (!g_stream.publisher->has_sink(encoding)) {
      continue;
    }
    const rs2::EndStats &stats = g_stream.publisher->stats(encoding);
    log_line(std::string("stream: closed (") + rs2::to_wire(reason) +
             ") encoding=" + rs2::to_wire(encoding) + " path=" +
             (encoding == rs2::Encoding::Full ? g_stream.path : g_stream.patch_path) +
             " transactions=" + std::to_string(g_stream.publisher->transactions(encoding)) +
             " bytes_total=" + std::to_string(stats.bytes_total) +
             " max_record_bytes=" + std::to_string(stats.max_record_bytes) +
             " encode_ns_total=" + std::to_string(stats.encode_ns_total) +
             " snapshot_ns_total=" + std::to_string(stats.snapshot_ns_total) +
             " diff_ns_total=" + std::to_string(stats.diff_ns_total));
  }
}

// One snapshot for the frame callback at the end of iteration `frame`, shared
// by both sinks. It is copied under the mirror lock (timed) and diffed and
// encoded outside it.
//
// Live (G1c2): the server's events are drained into the hub first, so credit
// that arrived since the last callback is usable now; the hub then gets the
// same published copy when a connection can take a transaction (one snapshot
// copy per frame either way). Without file sinks the snapshot is taken only
// when the hub wants one.
void stream_publish(uint64_t frame) {
  if (g_stream.status != "open") {
    return;
  }
  if (g_stream.spurious_frame != 0 && frame == g_stream.spurious_frame) {
    // spurious-texture-update (gate2-design.md G2b2): a version bump with identical bytes, and
    // its own hook-log line marked "sabotage":true, so the log and the stream still agree.
    const uint64_t rid = rs::mirror_instance().spurious_texture_update(frame);
    if (rid != 0) {
      rs::TapContext ctx;
      ctx.frame = frame;
      ctx.t_ns = monotonic_ns();
      ctx.main_thread = true;
      rs::resource_log().spurious_update(ctx, rid);
    }
    log_line("stream: spurious-texture-update at frame " + std::to_string(frame) + " rid=" +
             std::to_string(rid));
  }
  resources_drain();
  live_drain(frame);
  const bool live_wants = g_live.hub != nullptr && g_live.hub->wants_snapshot(frame);
  const uint64_t epoch = rs::mirror_epoch();
  // G2c2: with a live server the snapshot is taken at every callback, so the served set always
  // holds the current state's payloads (D7), even when no connection takes a transaction.
  const bool serving = g_live.hub != nullptr && g_live.served != nullptr && !g_live.stopped;
  if (g_stream.publisher == nullptr && !live_wants && !serving) {
    if (g_live.hub != nullptr) {
      g_live.hub->on_frame(frame, monotonic_ns(), nullptr, epoch, 0);
    }
    return;
  }
  const uint64_t t0 = monotonic_ns();
  rs::Captured snapshot = rs::mirror_snapshot(0, frame);
  const uint64_t snapshot_ns = monotonic_ns() - t0;
  // gate2-design.md Q3: the retained payloads -- the mirror's current ones, those the previous
  // publication still pins and (G2c2) those still servable over HTTP -- stay within
  // GRC_RESOURCE_BUDGET_BYTES.
  {
    rs::PayloadMap retained = snapshot.payloads;
    if (g_stream.publisher != nullptr && g_stream.publisher->last_published() != nullptr) {
      const rs::PayloadMap &pinned = g_stream.publisher->last_published()->payloads;
      retained.insert(pinned.begin(), pinned.end());
    }
    if (serving) {
      const rs::PayloadMap served = g_live.served->retained_payloads();
      retained.insert(served.begin(), served.end());
    }
    const uint64_t retained_bytes = rs::payload_map_bytes(retained);
    g_stream.retained_bytes_max = std::max(g_stream.retained_bytes_max, retained_bytes);
    if (retained_bytes > g_stream.budget_bytes) {
      log_line("stream: resource-budget-exceeded at frame " + std::to_string(frame) + ": " +
               std::to_string(retained_bytes) + " > " + std::to_string(g_stream.budget_bytes));
      g_stream.reason = "resource-budget-exceeded: " + std::to_string(retained_bytes) +
                        " bytes retained, the budget is " + std::to_string(g_stream.budget_bytes);
      stream_finish(rs2::EndReason::Shutdown);
      return;
    }
  }
  const rs::Captured *published = &snapshot;
  if (g_stream.publisher != nullptr) {
    if (!g_stream.publisher->publish(std::move(snapshot), frame, snapshot_ns)) {
      const std::string error = g_stream.publisher->error();
      log_line("stream: write failed at frame " + std::to_string(frame) +
               (error.empty() ? std::string() : " (" + error + ")"));
      g_stream.reason = error.empty() ? std::string("transaction write failed") : error;
      stream_finish(rs2::EndReason::Shutdown);
      return;
    }
    published = g_stream.publisher->last_published();
  } else {
    snapshot.state.frame = frame;
  }
  if (g_live.hub != nullptr) {
    std::vector<rs::ServeEvent> events;
    if (serving) {
      // wrong-hash (G2b2/G2c2): the store corrupted its copy at this publish; serve the same.
      if (g_stream.store != nullptr && !g_stream.store->corrupted_hash().empty()) {
        g_live.served->corrupt(g_stream.store->corrupted_hash());
      }
      // Phase 1: everything the hub may send now is servable before it goes out.
      std::vector<const rs::PayloadMap *> sendable = g_live.hub->held_payloads();
      sendable.insert(sendable.begin(), &published->payloads);
      g_live.served->pin(sendable, frame, &events);
    }
    g_live.hub->on_frame(frame, monotonic_ns(), live_wants ? published : nullptr, epoch,
                         snapshot_ns);
    if (serving) {
      // Phase 2: retained := current ∪ every connection's base; the rest is retired.
      g_live.served->retire(published->payloads, g_live.hub->base_payloads(), frame, &events);
      rs::TapContext ctx;
      ctx.frame = frame;
      ctx.t_ns = monotonic_ns();
      ctx.main_thread = true;
      for (const rs::ServeEvent &e : events) {
        rs::resource_log().serve_event(ctx, e.op, e.hash, e.bytes, e.reason, 0, -1, e.sabotage);
      }
    }
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
  live_linger(false);  // after a disarm: the receivers' closes, then the server stop
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
      stream_finish(rs2::EndReason::Disarm);
      do_disarm("frame");
    }
  }
}

void on_shutdown() {
  stream_finish(rs2::EndReason::Shutdown);
  live_linger(true);  // a linger still running after a disarm ends here
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
  g_stream.patch_path = env_string("GRC_STREAM_PATCH_OUT");
  g_live.listen = env_string("GRC_LIVE_LISTEN");
  hooks_set_main_thread();
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
           " stream=" + (g_stream.path.empty() ? std::string("<off>") : g_stream.path) +
           " live=" + (g_live.listen.empty() ? std::string("<off>") : g_live.listen));
  attempt("scene-init");
}

void deinitialize(void * /*userdata*/, GDExtensionInitializationLevel level) {
  if (level != GDEXTENSION_INITIALIZATION_SCENE) {
    return;
  }
  // The shutdown callback normally gets here first; this is the backstop for an
  // unload that happens without it.
  stream_finish(rs2::EndReason::Shutdown);
  live_linger(true);
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
