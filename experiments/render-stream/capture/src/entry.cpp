// GDExtension entry point and the arming decision.
//
// Nothing is written into the engine's memory until every check in
// `calib.h` has passed and `GRC_MODE=arm` was asked for. `validate` runs the
// identical checks and writes the identical evidence, but never touches the
// vptr.
//
// With GRC_STREAM_OUT and/or GRC_STREAM_PATCH_OUT set and the library armed,
// it also publishes render-stream/5 recordings (protocol/render-stream-5.md: /4 plus the shader
// and material tables, item material state, canvas modulate and GRP1 shader payloads since
// gate5_5-design.md "G55d"; /4 added the immediate geometry ops, add_set_transform,
// add_clip_ignore and meshes at gate5-design.md "G5d"/"G5e"; /3 the msdf command at
// gate4-design.md "G4e2"; protocol/gate1-design.md "G1b2", gate2-design.md "G2b2"). The shader
// source policy GRC_SHADER_POLICY (source | params | exclude, default source; gate5_5-design.md
// D4) is read at arm and declared in the session's `materials`: GRC_STREAM_OUT is
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
// act in the mirror, as do G4e2's perturb-glyph, G5d's perturb-vertex and G55d's
// perturb-shader, freeze-frame,
// perturb-transform and
// patch-drop-item in
// the publisher, drop-message (G1c2), ignore-credit and stale-coalesce (G1d)
// in the live hub; G2b2's stale-texture in the publisher, wrong-hash in the
// resource store and spurious-texture-update in the mirror at the frame
// callback.
//
// The root-size policy GRC_ROOT_SIZE (observe | enforce-min-size; G1a,
// gate1-design.md "Q1"; presentation:<W>x<H> since G6b, gate6-design.md Q3a) is applied at arm
// between the root query and the session record. What it saw and did goes on the wire -- the session's
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
//
// Unknown items (protocol/unknown-item-skip.md): GRC_UNKNOWN_ITEM is `strict` (default, also
// when unset or empty) or `skip`, read at arm with the other stream policies; any other value
// refuses to publish, as an invalid GRC_ROOT_SIZE does. `skip` is a diagnostic opt-in for hosts
// that arm late: the mirror withholds unknown canvas/item RIDs and the subtrees under them instead
// of failing every transaction with `pre-existing-object`, the session declares
// `unknown_item_policy: "skip"`, every transaction carries `unknown_items`, and result.json
// `stream.unknown_items` holds the final counters.
//
// Authorization (G2e, gate2-design.md D13): GRC_LIVE_AUTH is `none` (default) or `token`, read
// only with GRC_LIVE_LISTEN. `token` generates 32 random bytes as 64 lowercase hex, writes them
// to evidence/live-token (mode 0600, refused as resource-store-missing-equivalent
// `live-token-unwritable` without GRC_EVIDENCE_DIR), declares the session's
// `resources.auth: "bearer"`, and requires it on the WebSocket upgrade and on every resource GET
// (rs_ws.h ServerConfig::auth_token). A rejected upgrade is logged (never the token itself) as an
// AuthRejected event; a rejected GET is an ordinary HttpGet event with http_status 401, already
// covered by the existing hook-log path.
//
// render-stream/7 (G7n, gate7-design.md D2, D3, D4, Q2, Q3): the listener accepts both
// subprotocols, render-stream.7 preferred, and each connection speaks the one it chose
// (rs_live.h); file sinks stay on /6. On a /7 connection the token travels in the hello, never
// in an upgrade header (rs_ws.h hello_token_subprotocols; rs_live.h checks it).
// GRC_LIVE_ALLOWED_ORIGINS (a comma list of exact scheme://host:port origins, default empty;
// anything else refuses the listener as `origin-config-invalid`) is the Origin allowlist: a
// request carrying any other Origin gets 403 on every route, logged to stdout.log as
// `live: 403 origin <origin> ...` (an OriginRejected event), and an allowed origin's resource
// GETs and preflights speak CORS. A preflight is an http-get hook-log line with
// "method":"OPTIONS". GRC_LIVE_CREDIT_WINDOW_MAX (1..2, default 1) caps the hello's window; the
// host itself grants at most 1 until G7q. Listener sabotages (GRC_SABOTAGE, all need
// GRC_LIVE_LISTEN): no-cors (no Access-Control-* header at all), accept-any-origin (the
// allowlist is ignored) and token-ignored (a wrong /7 hello token is not refused; needs
// GRC_LIVE_AUTH=token). They act on the listener only, never on a record, so the wire declares
// no sabotage for them (the session's `sabotage` stays null): evidence/live.json carries
// `listener_sabotage` instead.

#include <sys/random.h>
#include <sys/stat.h>
#include <unistd.h>

#include <algorithm>
#include <cerrno>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <ctime>
#include <fstream>
#include <memory>
#include <string>
#include <thread>
#include <vector>

#include "calib.h"
#include "hooks.h"
#include "iface.h"
#include "report.h"
#include "rs_canvas_texture_shim.h"
#include "rs_histogram.h"
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

  // GRC_HEADLESS_CANVAS_TEXTURE as given (empty: unset), the parsed mode, and the shim's state:
  // "off" (not asked for), "armed", or "refused" with `ct_shim_reason`
  // (protocol/canvas-texture-headless.md "Experiment (a) result"; rs_canvas_texture_shim.h).
  std::string ct_shim_env;
  bool ct_shim_env_set = false;
  rs::CanvasTextureShimMode ct_shim_mode = rs::CanvasTextureShimMode::Off;
  std::string ct_shim_state = "off";
  std::string ct_shim_reason;
};

// The render-stream/2 file publication (G1b2, G2b2). `status` is result.json
// `stream.status`: off | open | closed | refused | open-failed.
struct Stream {
  std::string path;        // GRC_STREAM_OUT (full sink); empty when unset
  std::string patch_path;  // GRC_STREAM_PATCH_OUT (patch sink); empty when unset
  std::string status = "off";
  std::string reason;  // empty -> null
  // protocol/unknown-item-skip.md: GRC_UNKNOWN_ITEM, read at arm.
  rs2::UnknownItemPolicy unknown_item_policy = rs2::UnknownItemPolicy::Strict;
  // gate5_5-design.md D4: GRC_SHADER_POLICY, read at arm (source | params | exclude).
  rs2::ShaderPolicy shader_policy = rs2::ShaderPolicy::Source;
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
  // GRC_HOOK_LOG (G6r, Q3d), read at arm: with `off`, resources.jsonl's file is never opened (no
  // per-call lines reach disk) and the buffered lines are discarded every frame instead of
  // written, so a long run's buffer never grows unbounded. Counters, counters.json and the
  // mirror are unaffected either way: they do not read resources.jsonl.
  bool hook_log_on = true;
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
  // G7n (live.json): GRC_LIVE_ALLOWED_ORIGINS as parsed, GRC_LIVE_CREDIT_WINDOW_MAX, and the
  // listener sabotage (no-cors | accept-any-origin | token-ignored; empty when none).
  std::vector<std::string> allowed_origins;
  uint64_t credit_window_max = 1;
  std::string listener_sabotage;
};

// G7n: the GRC_SABOTAGE kinds that act on the listener only (see the header comment).
bool is_listener_sabotage(const char *kind) {
  if (kind == nullptr) {
    return false;
  }
  const std::string text(kind);
  return text == "no-cors" || text == "accept-any-origin" || text == "token-ignored";
}

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

// Perf instrumentation (gate6-design.md Q3d, G6r): evidence/perf.json
// (render-stream-capture-perf/1, written at disarm and shutdown) and evidence/perf-timeline.jsonl
// (one line per second). Scoped to what capture/src/rs_live.cpp and entry.cpp can measure without
// touching any other file (store_write_us, texture/mesh/shader copy_us and hash_us, param_decode_us
// and the I/O thread's own CPU time would need rs_resource_store.cpp, rs_texture_payload.cpp,
// rs_mesh_payload.cpp, rs_shader_payload.cpp, rs_variant.cpp or rs_ws.cpp, all out of scope for
// this increment; they are declared, not silently missing, in perf.json's `unavailable_stages`).
struct Perf {
  uint64_t arm_ns = 0;
  uint64_t last_frame_ns = 0;  // for frame_interval_us; 0 before the first armed frame
  Histogram frame_interval_us;
  Histogram frame_callback_us;
  Histogram snapshot_us;
  struct timespec main_thread_cpu_start {};
  bool main_thread_cpu_start_ok = false;
  std::FILE *timeline_file = nullptr;
  std::string timeline_path;
  int64_t timeline_last_second = -1;  // the last whole second a timeline line was written for
};

Perf g_perf;

// Main-thread CPU time so far (CLOCK_THREAD_CPUTIME_ID), in microseconds; -1 when unavailable.
// Correct only when called from the main thread, as every entry point here is (the gdextension
// frame/arm/disarm callbacks).
int64_t main_thread_cpu_us() {
  struct timespec ts {};
  if (clock_gettime(CLOCK_THREAD_CPUTIME_ID, &ts) != 0) {
    return -1;
  }
  return static_cast<int64_t>(ts.tv_sec) * 1000000 + ts.tv_nsec / 1000;
}

// The process's resident set size in bytes, from /proc/self/statm (field 2, in pages) through
// plain file reads (D9: process RSS, never an engine memory counter). 0 when unreadable.
uint64_t read_rss_bytes() {
  std::ifstream in("/proc/self/statm");
  if (!in) {
    return 0;
  }
  uint64_t pages = 0, resident_pages = 0;
  in >> pages >> resident_pages;
  if (!in) {
    return 0;
  }
  const long page_size = sysconf(_SC_PAGESIZE);
  return page_size > 0 ? resident_pages * static_cast<uint64_t>(page_size) : 0;
}

// GRC_ROOT_SIZE, read at arm (gate1-design.md Q1 "Policy").
using rs2::RootSizePolicy;

// GRC_SHADER_POLICY, read at arm (gate5_5-design.md D4): unset or empty is `source`.
bool parse_shader_policy(const char *value, rs2::ShaderPolicy *out) {
  if (value == nullptr || std::strcmp(value, "") == 0 || std::strcmp(value, "source") == 0) {
    *out = rs2::ShaderPolicy::Source;
    return true;
  }
  if (std::strcmp(value, "params") == 0) {
    *out = rs2::ShaderPolicy::Params;
    return true;
  }
  if (std::strcmp(value, "exclude") == 0) {
    *out = rs2::ShaderPolicy::Exclude;
    return true;
  }
  return false;
}

// GRC_UNKNOWN_ITEM, read at arm (protocol/unknown-item-skip.md).
bool parse_unknown_item_policy(const char *value, rs2::UnknownItemPolicy *out) {
  if (value == nullptr || std::strcmp(value, "") == 0 || std::strcmp(value, "strict") == 0) {
    *out = rs2::UnknownItemPolicy::Strict;
    return true;
  }
  if (std::strcmp(value, "skip") == 0) {
    *out = rs2::UnknownItemPolicy::Skip;
    return true;
  }
  return false;
}

// `presentation` receives W x H for presentation:<W>x<H> (decimal, 1..16384 each; G6b,
// gate6-design.md Q3a) and is left untouched otherwise.
bool parse_root_size_policy(const char *value, RootSizePolicy *out, int32_t presentation[2]) {
  if (value == nullptr || std::strcmp(value, "") == 0 || std::strcmp(value, "observe") == 0) {
    *out = RootSizePolicy::Observe;
    return true;
  }
  if (std::strcmp(value, "enforce-min-size") == 0) {
    *out = RootSizePolicy::EnforceMinSize;
    return true;
  }
  static const char kPrefix[] = "presentation:";
  if (std::strncmp(value, kPrefix, sizeof(kPrefix) - 1) == 0) {
    const char *p = value + sizeof(kPrefix) - 1;
    int64_t dims[2] = {0, 0};
    for (int i = 0; i < 2; ++i) {
      const char *start = p;
      while (*p >= '0' && *p <= '9') {
        dims[i] = dims[i] * 10 + (*p - '0');
        if (dims[i] > 16384) {
          return false;
        }
        ++p;
      }
      if (p == start || dims[i] < 1) {
        return false;
      }
      if (i == 0) {
        if (*p != 'x') {
          return false;
        }
        ++p;
      }
    }
    if (*p != '\0') {
      return false;
    }
    *out = RootSizePolicy::Presentation;
    presentation[0] = static_cast<int32_t>(dims[0]);
    presentation[1] = static_cast<int32_t>(dims[1]);
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

// G2e (gate2-design.md D13, "Environment"): 32 random bytes as 64 lowercase hex characters, via
// getrandom() -- independent of rs2::generate_id()'s 16-byte session/stream ids, which are not
// secrets and need no particular length.
std::string generate_live_token() {
  unsigned char buf[32] = {};
  std::size_t got = 0;
  while (got < sizeof(buf)) {
    const ssize_t n = ::getrandom(buf + got, sizeof(buf) - got, 0);
    if (n < 0) {
      if (errno == EINTR) {
        continue;
      }
      break;  // leaves the remaining bytes zero rather than looping forever
    }
    got += static_cast<std::size_t>(n);
  }
  static const char *const hex = "0123456789abcdef";
  std::string out;
  out.reserve(sizeof(buf) * 2);
  for (unsigned char b : buf) {
    out.push_back(hex[(b >> 4) & 0xF]);
    out.push_back(hex[b & 0xF]);
  }
  return out;
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
  // Additive (protocol/unknown-item-skip.md): the policy, and under skip the mirror's counters.
  const bool skip = g_stream.unknown_item_policy == rs2::UnknownItemPolicy::Skip;
  json.field("unknown_item_policy", std::string(skip ? "skip" : "strict"));
  if (skip) {
    const rs::MirrorStats stats = rs::mirror_stats();
    json.key("unknown_items").object_begin();
    json.field("unknown_calls", static_cast<int64_t>(stats.unknown_calls));
    json.field("unknown_rids_named", static_cast<int64_t>(stats.unknown_rids_named));
    json.field("unknown_rids", static_cast<int64_t>(stats.unknown_rids));
    json.field("withheld_items", static_cast<int64_t>(stats.withheld_items));
    json.field("rekeyed_items", static_cast<int64_t>(stats.rekeyed_items));
    json.object_end();
  } else {
    json.field_null("unknown_items");
  }
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
  // Additive (the headless CanvasTexture shim): present only when GRC_HEADLESS_CANVAS_TEXTURE is
  // set, so every run without the opt-in keeps its result.json unchanged.
  if (g_state.ct_shim_env_set) {
    json.key("canvas_texture_shim").object_begin();
    json.field("env", g_state.ct_shim_env);
    json.field("state", g_state.ct_shim_state);
    json.field_or_null("reason", g_state.ct_shim_reason);
    json.field("synthesized", static_cast<int64_t>(rs::canvas_texture_shim().synthesized()));
    json.object_end();
  }
  json.object_end();
  return json.take();
}

// evidence/canvas-texture-shim.json, written with the arm decision and with counters.json, only
// when the opt-in is set.
void emit_canvas_texture_shim() {
  if (g_state.ct_shim_env_set) {
    emit("canvas-texture-shim.json",
         rs::canvas_texture_shim().evidence_json(g_state.ct_shim_state, g_state.ct_shim_reason));
  }
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

// --- perf instrumentation (gate6-design.md Q3d, G6r) --------------------------

// At arm: starts the clocks perf.json's deltas and perf-timeline.jsonl's seconds are measured
// against.
void perf_arm() {
  g_perf.arm_ns = monotonic_ns();
  g_perf.last_frame_ns = 0;
  g_perf.timeline_last_second = -1;
  g_perf.main_thread_cpu_start_ok =
      clock_gettime(CLOCK_THREAD_CPUTIME_ID, &g_perf.main_thread_cpu_start) == 0;
}

// Writes one evidence/perf-timeline.jsonl line the first time this is called in a new whole
// second since arm (so at most one line per second, however often the frame callback runs).
void perf_timeline_tick(uint64_t now_ns) {
  if (!g_state.evidence_ready || g_perf.arm_ns == 0 || now_ns < g_perf.arm_ns) {
    return;
  }
  const int64_t second = static_cast<int64_t>((now_ns - g_perf.arm_ns) / 1000000000ull);
  if (second <= g_perf.timeline_last_second) {
    return;
  }
  g_perf.timeline_last_second = second;
  if (g_perf.timeline_file == nullptr) {
    g_perf.timeline_path = path_join(g_state.evidence_dir, "perf-timeline.jsonl");
    g_perf.timeline_file = std::fopen(g_perf.timeline_path.c_str(), "w");
    if (g_perf.timeline_file == nullptr) {
      log_line("perf: cannot open " + g_perf.timeline_path);
      return;
    }
  }
  // A compact one-line-per-record JSON builder: JsonWriter pretty-prints across several lines,
  // which would break the jsonl contract (one JSON object per line), so this stays a plain
  // string build, as rs_live.cpp's own per-connection log lines do.
  //
  // G6s (gate6-design.md Q7e "residency-bounded"): mirror_stats()'s live table sizes and the
  // served resources' current (not max) retained count/bytes, so a soak's checker can compare a
  // window's first third against its last third -- the hook log is off for a soak (GRC_HOOK_LOG),
  // so this 1 Hz tick is the only host-side time series available for a long-running leg.
  const rs::MirrorStats mirror_stats_now = rs::mirror_stats();
  const std::uint64_t served_retained = g_live.served != nullptr ? g_live.served->retained() : 0;
  const std::uint64_t served_retained_bytes =
      g_live.served != nullptr ? g_live.served->retained_bytes() : 0;
  std::string line = "{\"t_us\":" + std::to_string(now_ns / 1000) +
                     ",\"frame\":" + std::to_string(g_state.frames_total) +
                     ",\"rss_bytes\":" + std::to_string(read_rss_bytes()) +
                     ",\"mirror_items\":" + std::to_string(mirror_stats_now.live_items) +
                     ",\"mirror_textures\":" + std::to_string(mirror_stats_now.live_textures) +
                     ",\"mirror_meshes\":" + std::to_string(mirror_stats_now.live_meshes) +
                     ",\"mirror_materials\":" + std::to_string(mirror_stats_now.live_materials) +
                     ",\"host_retained\":" + std::to_string(served_retained) +
                     ",\"host_retained_bytes\":" + std::to_string(served_retained_bytes) +
                     ",\"connections\":[";
  if (g_live.hub != nullptr) {
    bool first = true;
    for (const rs2::ConnectionSummary &s : g_live.hub->summaries()) {
      if (!first) {
        line += ",";
      }
      first = false;
      line += "{\"connection\":" + std::to_string(s.connection) +
              ",\"sent\":" + std::to_string(s.sent) +
              ",\"credits\":" + std::to_string(s.credits) +
              ",\"coalesced\":" + std::to_string(s.coalesced) +
              ",\"ticks_credit_blocked\":" + std::to_string(s.ticks_credit_blocked) +
              ",\"max_pending_age_us\":" + std::to_string(s.max_pending_age_us) +
              ",\"bytes_sent\":" + std::to_string(s.bytes_sent) +
              // G6c: the ack counts per stage (host clock), so Q7d's received/applied/submitted
              // rates come from the measured window, the queue high-water marks so far, and the
              // credit round trip's running totals (a window's mean RTT, in us and host frames).
              ",\"acks\":[" + std::to_string(s.acks[0]) + "," + std::to_string(s.acks[1]) + "," +
              std::to_string(s.acks[2]) + "]" +
              ",\"max_in_flight\":" + std::to_string(s.max_in_flight) +
              ",\"max_queued_bytes\":" + std::to_string(s.max_queued_bytes) +
              ",\"credit_rtt_count\":" + std::to_string(s.credit_rtt_count) +
              ",\"credit_rtt_sum_us\":" + std::to_string(s.credit_rtt_sum_us) +
              ",\"credit_rtt_frames_sum\":" + std::to_string(s.credit_rtt_frames_sum) +
              // G6s (Q7e "soak-inline"): this connection's carried-hash set size, read fresh
              // each tick (Hub::summaries()). It only ever grows (render-stream-2.md's
              // resource-duplicate rule means a carried hash is never forgotten), so the check
              // here is on its growth rate, not on it staying flat.
              ",\"carried_size\":" + std::to_string(s.carried_size) + "}";
    }
  }
  line += "]}";
  std::fwrite(line.data(), 1, line.size(), g_perf.timeline_file);
  std::fputc('\n', g_perf.timeline_file);
  std::fflush(g_perf.timeline_file);
}

// render-stream-capture-perf/1 (Q3d), written at disarm and shutdown.
std::string perf_json() {
  JsonWriter json;
  json.object_begin();
  json.field("schema", std::string("render-stream-capture-perf/1"));
  json.key("histograms").object_begin();
  json.key("frame_interval_us");
  g_perf.frame_interval_us.write_json(&json);
  json.key("frame_callback_us");
  g_perf.frame_callback_us.write_json(&json);
  json.key("snapshot_us");
  g_perf.snapshot_us.write_json(&json);
  // Always present, even with no live connection (an empty histogram, not a missing key): these
  // are Hub-owned costs with nothing to report when there is no Hub, which is itself informative
  // (count 0), not the same as "this stage was never wired" (unavailable_stages, below).
  const Histogram kEmpty;
  json.key("diff_us");
  (g_live.hub != nullptr ? g_live.hub->diff_histogram() : kEmpty).write_json(&json);
  json.key("encode_us");
  (g_live.hub != nullptr ? g_live.hub->encode_histogram() : kEmpty).write_json(&json);
  json.key("enqueue_us");
  (g_live.hub != nullptr ? g_live.hub->enqueue_histogram() : kEmpty).write_json(&json);
  json.key("credit_rtt_us").object_begin();
  json.key("applied");
  (g_live.hub != nullptr ? g_live.hub->credit_rtt_histogram(rs2::AckStage::Applied) : kEmpty)
      .write_json(&json);
  json.key("submitted");
  (g_live.hub != nullptr ? g_live.hub->credit_rtt_histogram(rs2::AckStage::Submitted) : kEmpty)
      .write_json(&json);
  json.object_end();
  json.key("staleness_us").object_begin();
  json.key("applied");
  (g_live.hub != nullptr ? g_live.hub->staleness_histogram(rs2::AckStage::Applied) : kEmpty)
      .write_json(&json);
  json.key("submitted");
  (g_live.hub != nullptr ? g_live.hub->staleness_histogram(rs2::AckStage::Submitted) : kEmpty)
      .write_json(&json);
  json.object_end();
  json.object_end();  // histograms
  // D9 "declared, never guessed": every Q3d stage this increment did not wire (it would need
  // rs_resource_store.cpp, rs_texture_payload.cpp, rs_mesh_payload.cpp, rs_shader_payload.cpp,
  // rs_variant.cpp or rs_ws.cpp -- none in G6r's file list) is named here with why, rather than
  // silently missing from `histograms`.
  json.key("unavailable_stages").array_begin();
  static const struct {
    const char *stage;
    const char *needs;
  } kUnavailable[] = {
      {"store_write_us", "rs_resource_store.cpp"},
      {"texture_copy_us", "rs_texture_payload.cpp"},
      {"texture_hash_us", "rs_texture_payload.cpp"},
      {"mesh_copy_us", "rs_mesh_payload.cpp"},
      {"mesh_hash_us", "rs_mesh_payload.cpp"},
      {"shader_copy_us", "rs_shader_payload.cpp"},
      {"shader_hash_us", "rs_shader_payload.cpp"},
      {"param_decode_us", "rs_variant.cpp"},
      {"http_serve_us", "rs_ws.cpp (I/O thread)"},
  };
  for (const auto &u : kUnavailable) {
    json.object_begin();
    json.field("stage", std::string(u.stage));
    json.field("reason",
               std::string("not wired by G6r: needs ") + u.needs + ", out of its file list");
    json.object_end();
  }
  json.array_end();
  json.key("cpu").object_begin();
  const int64_t main_us = main_thread_cpu_us();
  if (g_perf.main_thread_cpu_start_ok && main_us >= 0) {
    const int64_t start_us = static_cast<int64_t>(g_perf.main_thread_cpu_start.tv_sec) * 1000000 +
                             g_perf.main_thread_cpu_start.tv_nsec / 1000;
    json.field("main_thread_us", main_us - start_us);
  } else {
    json.field_null("main_thread_us");
  }
  // The I/O thread's own CPU time would need a handle rs_ws.h does not expose; out of scope.
  json.field_null("io_thread_us");
  json.object_end();
  json.key("connections").array_begin();
  if (g_live.hub != nullptr) {
    for (const rs2::ConnectionSummary &s : g_live.hub->summaries()) {
      json.object_begin();
      json.field("connection", static_cast<int64_t>(s.connection));
      json.field("ticks_due", static_cast<int64_t>(s.ticks_due));
      json.field("ticks_sent", static_cast<int64_t>(s.ticks_sent));
      json.field("ticks_credit_blocked", static_cast<int64_t>(s.ticks_credit_blocked));
      json.field("frames_rate_idle", static_cast<int64_t>(s.frames_rate_idle));
      json.object_end();
    }
  }
  json.array_end();
  json.object_end();
  return json.take();
}

void perf_finish() {
  if (g_state.evidence_ready) {
    emit("perf.json", perf_json());
  }
  if (g_perf.timeline_file != nullptr) {
    std::fclose(g_perf.timeline_file);
    g_perf.timeline_file = nullptr;
  }
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
//
// Always drains (take_lines()), even when the file is not open (GRC_HOOK_LOG=off, or it failed
// to open): the hooks keep buffering lines into ResourceLog regardless (counters.json and the
// mirror read from the hooks directly, not from this file, Q3d), so leaving them undrained would
// grow that buffer without bound over a long run.
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
  // GRC_HOOK_LOG=off (Q3d, G6r): the file is never opened, so resources.jsonl gets no per-call
  // lines; resources_drain() above still drains (and discards) the hooks' own buffer every
  // frame. The hooks themselves still run (payload copies, the mirror update, counters.json) --
  // only this file's content is skipped.
  if (g_state.evidence_ready && g_stream.hook_log_on) {
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

// GRC_PUBLISH_FPS (D8, Q3c, G6r): "uncapped" (default, every frame callback that holds credit)
// or a decimal integer 1..240 fps, read at arm. Live connections only -- a Publisher file sink
// is never rate-limited by this.
bool parse_publish_fps(const char *value, uint64_t *period_ns, uint64_t *target_fps) {
  if (value == nullptr || *value == '\0' || std::string(value) == "uncapped") {
    *period_ns = 0;
    *target_fps = 0;
    return true;
  }
  const std::string text(value);
  if (text.size() > 3 || text.find_first_not_of("0123456789") != std::string::npos) {
    return false;
  }
  const uint64_t fps = std::stoull(text);
  if (fps < 1 || fps > 240) {
    return false;
  }
  *target_fps = fps;
  *period_ns = 1000000000ull / fps;
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
  // G7n (gate7-design.md Q3).
  json.key("allowed_origins").array_begin();
  for (const std::string &origin : g_live.allowed_origins) {
    json.string(origin);
  }
  json.array_end();
  json.field("credit_window_max", static_cast<int64_t>(g_live.credit_window_max));
  json.field_or_null("listener_sabotage", g_live.listener_sabotage);
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
  // G7n: a listener sabotage never reaches the stream's sabotage parser (nor the wire).
  if (is_listener_sabotage(sabotage_kind)) {
    g_live.listener_sabotage = sabotage_kind;
    sabotage_kind = nullptr;
  }
  // GRC_SABOTAGE_FRAME and GRC_SABOTAGE_OP are read only when GRC_SABOTAGE is set.
  const rs2::ParseResult sabotage =
      rs2::parse_sabotage(sabotage_kind, sabotage_kind != nullptr ? sabotage_frame : nullptr,
                          sabotage_kind != nullptr ? sabotage_op : nullptr);
  const char *root_size = std::getenv("GRC_ROOT_SIZE");
  RootSizePolicy policy = RootSizePolicy::Observe;
  int32_t presentation_wh[2] = {0, 0};
  if (!parse_root_size_policy(root_size, &policy, presentation_wh)) {
    const std::string error = std::string("invalid GRC_ROOT_SIZE=") + root_size +
                              " (expected observe, enforce-min-size or presentation:<W>x<H>)";
    log_line("stream: refused root size policy (" + error + ")");
    g_stream.status = "refused";
    g_stream.reason = error;
    if (!g_live.listen.empty()) {
      live_decided("refused", "stream refused: " + error);
    }
    return;
  }
  const char *shader_policy = std::getenv("GRC_SHADER_POLICY");
  if (!parse_shader_policy(shader_policy, &g_stream.shader_policy)) {
    const std::string error = std::string("invalid GRC_SHADER_POLICY=") + shader_policy +
                              " (expected source, params or exclude)";
    log_line("stream: refused shader policy (" + error + ")");
    g_stream.shader_policy = rs2::ShaderPolicy::Source;
    g_stream.status = "refused";
    g_stream.reason = error;
    if (!g_live.listen.empty()) {
      live_decided("refused", "stream refused: " + error);
    }
    return;
  }
  const char *unknown_item = std::getenv("GRC_UNKNOWN_ITEM");
  if (!parse_unknown_item_policy(unknown_item, &g_stream.unknown_item_policy)) {
    const std::string error = std::string("invalid GRC_UNKNOWN_ITEM=") + unknown_item +
                              " (expected strict or skip)";
    log_line("stream: refused unknown item policy (" + error + ")");
    g_stream.unknown_item_policy = rs2::UnknownItemPolicy::Strict;
    g_stream.status = "refused";
    g_stream.reason = error;
    if (!g_live.listen.empty()) {
      live_decided("refused", "stream refused: " + error);
    }
    return;
  }
  // GRC_HOOK_LOG (Q3d, G6r): on|off, default on.
  const std::string hook_log = env_string("GRC_HOOK_LOG");
  if (!hook_log.empty() && hook_log != "on" && hook_log != "off") {
    const std::string error = "invalid GRC_HOOK_LOG=" + hook_log + " (expected on or off)";
    log_line("stream: refused hook log mode (" + error + ")");
    g_stream.status = "refused";
    g_stream.reason = error;
    if (!g_live.listen.empty()) {
      live_decided("refused", "stream refused: " + error);
    }
    return;
  }
  g_stream.hook_log_on = hook_log != "off";
  // G6b (gate6-design.md D4, Q3a): presentation:<W>x<H> under stretch `disabled` with W x H other
  // than the logical size would change layout, so the stream refuses to publish
  // (root-size-invalid) before anything is opened. One read-only root query decides it.
  if (policy == RootSizePolicy::Presentation) {
    const rs::RootInfo probe = rs::root_query_run();
    if (probe.content_scale_mode == 0 && (presentation_wh[0] != probe.logical_size[0] ||
                                          presentation_wh[1] != probe.logical_size[1])) {
      const std::string error =
          "root-size-invalid: GRC_ROOT_SIZE=" + std::string(root_size) +
          " under stretch disabled differs from the logical size " +
          std::to_string(probe.logical_size[0]) + "x" + std::to_string(probe.logical_size[1]);
      log_line("stream: refused root size policy (" + error + ")");
      g_stream.status = "refused";
      g_stream.reason = error;
      if (!g_live.listen.empty()) {
        live_decided("refused", "stream refused: " + error);
      }
      return;
    }
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
  // GRC_LIVE_MAX_CONNECTIONS (D13, G6r): the WebSocket admission limit (ServerConfig::
  // max_clients below); the Hub itself already tracks every connection independently.
  uint64_t live_max_connections = 1;
  // G2e: empty/None unless GRC_LIVE_AUTH=token successfully generates and writes one below.
  std::string live_auth_token;
  rs2::Auth live_auth = rs2::Auth::None;
  bool live_ok = sabotage.ok && !g_live.listen.empty();
  if (live_ok) {
    std::string why;
    const char *tap = std::getenv("GRC_LIVE_TAP_DIR");
    live_config.tap_dir = tap != nullptr ? std::string(tap) : std::string();
    const std::string auth_mode = env_string("GRC_LIVE_AUTH");
    if (!parse_listen(g_live.listen, &live_host, &live_port, &why)) {
      live_ok = false;
    } else if (!env_positive("GRC_LIVE_MAX_MESSAGE_BYTES", 16u << 20,
                             &live_config.max_message_bytes)) {
      live_ok = false;
      why = "invalid GRC_LIVE_MAX_MESSAGE_BYTES (a decimal integer >= 1)";
    } else if (!env_positive("GRC_LIVE_HELLO_TIMEOUT_MS", 5000, &live_config.hello_timeout_ms)) {
      live_ok = false;
      why = "invalid GRC_LIVE_HELLO_TIMEOUT_MS (a decimal integer >= 1)";
    } else if (!parse_publish_fps(std::getenv("GRC_PUBLISH_FPS"), &live_config.publish_period_ns,
                                  &live_config.publish_target_fps)) {
      live_ok = false;
      why = "invalid GRC_PUBLISH_FPS (uncapped, or a decimal integer 1..240)";
    } else if (!env_positive("GRC_LIVE_MAX_CONNECTIONS", 1, &live_max_connections) ||
               live_max_connections > 4) {
      live_ok = false;
      why = "invalid GRC_LIVE_MAX_CONNECTIONS (a decimal integer 1..4)";
    } else if (!live_config.tap_dir.empty() && live_config.tap_dir[0] != '/') {
      live_ok = false;
      why = "GRC_LIVE_TAP_DIR must be absolute";
    } else if (g_stream.policy.inline_max_bytes > kLiveInlineMaxBytes) {
      // gate2-design.md Q4: inline records over live share the credit window with the
      // transaction, so the threshold is capped at 1 MiB; bigger payloads go over HTTP.
      live_ok = false;
      why = "GRC_RESOURCE_INLINE_MAX_BYTES above " + std::to_string(kLiveInlineMaxBytes) +
            " with GRC_LIVE_LISTEN (inline over live is capped at 1 MiB)";
    } else if (!auth_mode.empty() && auth_mode != "none" && auth_mode != "token") {
      live_ok = false;
      why = "GRC_LIVE_AUTH must be none or token (got " + auth_mode + ")";
    } else if (!live::parse_allowed_origins(env_string("GRC_LIVE_ALLOWED_ORIGINS"),
                                            &g_live.allowed_origins, &why)) {
      // G7n (gate7-design.md Q3): an allowlist entry that is not an exact origin refuses.
      live_ok = false;
      why = "origin-config-invalid: GRC_LIVE_ALLOWED_ORIGINS " + why;
    } else if (!env_positive("GRC_LIVE_CREDIT_WINDOW_MAX", 1, &live_config.credit_window_max) ||
               live_config.credit_window_max > 2) {
      live_ok = false;
      why = "invalid GRC_LIVE_CREDIT_WINDOW_MAX (1 or 2)";
    } else if (g_live.listener_sabotage == "token-ignored" && auth_mode != "token") {
      live_ok = false;
      why = "sabotage token-ignored needs GRC_LIVE_AUTH=token";
    }
    g_live.credit_window_max = live_config.credit_window_max;
    // G2e: generated only once every other live setting is known good, so a usage error never
    // burns a token or writes evidence/live-token for a listener that will not actually start.
    if (live_ok && auth_mode == "token") {
      if (!g_state.evidence_ready) {
        live_ok = false;
        why = "GRC_LIVE_AUTH=token needs GRC_EVIDENCE_DIR (the token is written to evidence/live-token)";
      } else {
        live_auth_token = generate_live_token();
        const std::string token_path = path_join(g_state.evidence_dir, "live-token");
        if (!write_file(token_path, live_auth_token)) {
          live_ok = false;
          why = "cannot write " + token_path;
          live_auth_token.clear();
        } else {
          ::chmod(token_path.c_str(), 0600);
          live_auth = rs2::Auth::Bearer;
          live_config.auth_token = live_auth_token;  // G7n: checked against a /7 hello's token
          live_config.token_ignored = g_live.listener_sabotage == "token-ignored";
        }
      }
    }
    if (!live_ok) {
      live_decided("refused", why);
    }
  }
  if (sabotage.ok && !g_live.listener_sabotage.empty() && !live_ok) {
    // G7n: a listener sabotage with no listener to act on refuses to publish, as a live
    // sabotage without GRC_LIVE_LISTEN does.
    const std::string why =
        g_live.listen.empty()
            ? g_live.listener_sabotage + " needs GRC_LIVE_LISTEN"
            : g_live.listener_sabotage + " needs the live listener, which refused (" +
                  g_live.reason + ")";
    log_line("stream: refused sabotage (" + why + ")");
    g_stream.status = "refused";
    g_stream.reason = why;
    return;
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
                           kind == rs2::SabotageKind::Unpin ||
                           kind == rs2::SabotageKind::RetainSuperseded;
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
  // G6b (gate6-design.md D1, render-stream-6.md): the capture speaks render-stream/6 (/5 from
  // G55d, /4 from G5d, /3 from G4e2). The mirror stamps its snapshots V6 to match.
  session.version = rs2::ProtocolVersion::V6;
  session.materials.shader_policy = g_stream.shader_policy;
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
  // protocol/canvas-texture-headless.md: a headless host (RasterizerDummy,
  // servers/display_server_headless.h:51) declares canvas_texture unsupported -- unless the opt-in
  // shim gives every CanvasTexture created while armed its own identity ("Experiment (a)
  // result"), in which case it declares canvas_texture supported like a rendered host. The
  // mirror's RID() refusal below stays on either way: RID() in a texture draw is still ambiguous
  // on a headless host (a CanvasTexture created before arming, or no texture).
  const bool headless_host = g_state.display_server == "headless";
  const bool ct_synthesized = rs::canvas_texture_shim().armed();
  session.features = rs2::gate2_features(headless_host && !ct_synthesized, session.version);
  if (sabotage.config.kind != rs2::SabotageKind::None) {
    session.sabotage.kind = sabotage.config.kind;
    session.sabotage.frame = sabotage.config.frame;
    // render-stream-1.md "Session record": `op` is non-null exactly for omit-op.
    session.sabotage.has_op = sabotage.config.kind == rs2::SabotageKind::OmitOp;
    session.sabotage.op = session.sabotage.has_op ? sabotage.config.op : std::string();
  }
  session.unknown_item_policy = g_stream.unknown_item_policy;

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
  // Before the root query, so every hook call the session sees is under the declared policy.
  rs::mirror_set_unknown_item_policy(g_stream.unknown_item_policy);
  if (g_stream.unknown_item_policy == rs2::UnknownItemPolicy::Skip) {
    log_line("stream: unknown_item_policy=skip (unknown canvas/item RIDs are withheld, not failed)");
  }
  const rs::RootInfo before = rs::root_query_run();
  // Binds the root RIDs before the policy runs, so any viewport call the
  // min-size write causes is attributed to the root. A failure becomes the
  // sticky root-query-failed.
  rs::root_query_apply(before);
  rs::RootInfo after = before;
  bool enforce_called = false;
  bool enforce_ok = true;
  std::string enforce_detail;
  // render-stream-6.md "Viewport": the declared presentation size -- the policy's W x H under
  // presentation:, the logical size otherwise (gate6-design.md Q3a).
  int32_t presentation_size[2] = {before.logical_size[0], before.logical_size[1]};
  if (policy == RootSizePolicy::Presentation) {
    presentation_size[0] = presentation_wh[0];
    presentation_size[1] = presentation_wh[1];
  }
  if (policy == RootSizePolicy::EnforceMinSize || policy == RootSizePolicy::Presentation) {
    enforce_called = true;
    const bool written =
        policy == RootSizePolicy::Presentation
            ? rs::root_set_min_size(before, presentation_wh[0], presentation_wh[1],
                                    &enforce_detail)
            : rs::root_enforce_min_size(before, &enforce_detail);
    if (!written) {
      enforce_ok = false;
    }
    // Read back what the write did; the declaration is always the after state.
    after = rs::root_query_run();
    rs::mirror_set_root(after.viewport_rid, after.canvas_rid, after.canvas_xform);
    if (!after.ok) {
      rs::mirror_fail_root_query(after.failed_step);
    }
  }
  if (policy != RootSizePolicy::Presentation) {
    presentation_size[0] = after.logical_size[0];
    presentation_size[1] = after.logical_size[1];
  }
  const rs2::HostSizeStatus host_status = rs::host_size_status(after, presentation_size);
  if (policy != RootSizePolicy::Observe && host_status != rs2::HostSizeStatus::Match) {
    enforce_ok = false;
    if (enforce_detail.empty()) {
      enforce_detail = std::string(rs2::to_wire(host_status)) + ": window " +
                       size_text(after.window_size) + ", visible " +
                       rect_size_text(after.visible_rect) + ", logical " +
                       size_text(after.logical_size) + ", presentation " +
                       size_text(presentation_size);
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
  rs::mirror_set_canvas_texture_headless(headless_host);
  if (sabotage.config.kind == rs2::SabotageKind::OmitUpdate) {
    rs::mirror_set_drop_frame(sabotage.config.frame);
  } else if (sabotage.config.kind == rs2::SabotageKind::OmitOp) {
    rs::mirror_set_omit_op(sabotage.config.op, sabotage.config.frame);
  } else if (sabotage.config.kind == rs2::SabotageKind::PerturbGlyph) {
    rs::mirror_set_perturb_glyph(sabotage.config.frame);
  } else if (sabotage.config.kind == rs2::SabotageKind::PerturbVertex) {
    rs::mirror_set_perturb_vertex(sabotage.config.frame);
  } else if (sabotage.config.kind == rs2::SabotageKind::PerturbShader) {
    rs::mirror_set_perturb_shader(sabotage.config.frame);
  }
  // G55d (gate5_5-design.md D4): the declared shader-source policy.
  rs::mirror_set_shader_policy(g_stream.shader_policy);
  if (g_stream.shader_policy != rs2::ShaderPolicy::Source) {
    log_line(std::string("stream: shader_policy=") + rs2::to_wire(g_stream.shader_policy));
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
  session.viewport.presentation_size = {presentation_size[0], presentation_size[1]};
  session.viewport.host_size_status = host_status;
  session.viewport.host_window_size = {root.window_size[0], root.window_size[1]};
  // G6b (Q3a, D17): the oversampling and snap settings the host evaluates with, read after the
  // policy. A failed read leaves a non-positive oversampling, which the root query already failed
  // on; the wire must stay positive, so fall back to 1 then.
  session.viewport.font_oversampling = root.font_oversampling > 0.0f ? root.font_oversampling : 1.0f;
  session.viewport.snap_2d.transforms = root.snap_2d_transforms;
  session.viewport.snap_2d.vertices = root.snap_2d_vertices;
  rs::mirror_instance().set_snap_2d(root.snap_2d_transforms, root.snap_2d_vertices);
  // Q3b: viewport_set_global_canvas_transform is compared with the arm-time stretch x global
  // transform, the session's host_final_xform.
  rs::mirror_instance().set_global_canvas_reference(root.final_transform);
  log_line("viewport: presentation=" + size_text(presentation_size) + " oversampling=" +
           std::to_string(root.font_oversampling) + " snap_2d=" +
           (root.snap_2d_transforms ? "T" : "-") + (root.snap_2d_vertices ? "V" : "-") +
           " stretch_transform=[" + std::to_string(root.stretch_transform[0]) + "," +
           std::to_string(root.stretch_transform[3]) + "]");
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
    // D5 default 1 (one receiver at a time, a second gets 503); GRC_LIVE_MAX_CONNECTIONS (D13,
    // G6r) raises it up to 4.
    server_config.max_clients = static_cast<std::size_t>(live_max_connections);
    // G7n (gate7-design.md D2, Q3): /7 preferred when both are offered; the /7 token travels in
    // the hello (rs_live.h), so its upgrade is not bearer-checked.
    server_config.subprotocols = {rs2::kSubprotocolV7, "render-stream.6"};
    server_config.hello_token_subprotocols = {rs2::kSubprotocolV7};
    server_config.auth_token = live_auth_token;  // G2e: empty unless GRC_LIVE_AUTH=token.
    server_config.allowed_origins = g_live.allowed_origins;  // G7n
    server_config.enforce_origins = g_live.listener_sabotage != "accept-any-origin";
    server_config.cors_headers = g_live.listener_sabotage != "no-cors";
    g_live.address = live_host;
    g_live.server = std::make_unique<live::Server>();
    std::string error;
    // G2c2: the served payloads answer every resource GET on this listener.
    g_live.served = std::make_unique<rs::ServedResources>();
    if (sabotage.config.kind == rs2::SabotageKind::Unpin) {
      g_live.served->set_unpin_frame(sabotage.config.frame);
    } else if (sabotage.config.kind == rs2::SabotageKind::DropResource) {
      g_live.served->set_drop_frame(sabotage.config.frame);
    } else if (sabotage.config.kind == rs2::SabotageKind::RetainSuperseded) {
      g_live.served->set_retain_superseded_frame(sabotage.config.frame);
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
      tmpl.resources.auth = live_auth;  // G2e: "bearer" exactly when GRC_LIVE_AUTH=token.
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
           " auth=" + (live_auth == rs2::Auth::Bearer ? std::string("bearer") : std::string("none")) +
           " origins=" + std::to_string(g_live.allowed_origins.size()) +
           (g_live.listener_sabotage.empty() ? std::string()
                                             : " listener_sabotage=" + g_live.listener_sabotage) +
           " sabotage=" + sabotage_text(sabotage.config) + " resources=" +
           (g_stream.resources_file != nullptr ? g_stream.resources_path : std::string("<off>")));
}

// Drains the server's events into the hub (frame callback, main thread).
void live_drain(uint64_t frame) {
  if (g_live.hub == nullptr || g_live.server == nullptr || g_live.stopped) {
    return;
  }
  for (const live::Event &event : g_live.server->take_events()) {
    if (event.kind == live::Event::HttpGet && event.method == "OPTIONS") {
      // G7n: a CORS preflight the server answered (204), counted per host (and, with one
      // connection open, per connection) apart from GETs, and logged as an http-get hook-log line
      // with method OPTIONS.
      ++g_live.serving.preflights;
      const uint32_t conn = g_live.hub->on_http_get(event.hash, event.http_status, 0, event.t_ns,
                                                    frame, /*preflight=*/true);
      rs::TapContext ctx;
      ctx.frame = frame;
      ctx.t_ns = event.t_ns;
      ctx.main_thread = false;
      rs::resource_log().serve_event(ctx, "http-get", is_lower_hex64(event.hash) ? event.hash : "",
                                     0, nullptr, conn, event.http_status, false, "OPTIONS");
      continue;
    }
    if (event.kind == live::Event::OriginRejected) {
      // G7n: a 403 for a foreign Origin, on any route. Like AuthRejected, it never reached a
      // connection the hub tracks; the log line is the host-side evidence.
      ++g_live.serving.origin_rejected;
      log_line("live: 403 origin " + event.origin + " " + event.method + " " + event.route);
      continue;
    }
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
    if (event.kind == live::Event::AuthRejected) {
      // G2e: a WebSocket upgrade refused for a missing or wrong bearer token. The connection
      // never reached Opened, so the hub has nothing to track; log the 401 itself (never the
      // token, which this event does not even carry) so a sabotage leg has host-side evidence
      // that the server actually answered 401, not merely that the receiver failed to connect.
      log_line("live: 401 unauthorized upgrade (missing or wrong bearer token)");
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
  // G6r: one steady-clock read shared by the due-tick check below and, when a snapshot is taken,
  // by the hub's own on_frame() timing -- the quarter-period slack in tick_due() absorbs the few
  // nanoseconds this function otherwise takes before the snapshot would have been copied.
  const uint64_t now_ns = monotonic_ns();
  const bool live_wants = g_live.hub != nullptr && g_live.hub->wants_snapshot(frame, now_ns);
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
  if (g_state.evidence_ready) {
    g_perf.snapshot_us.add(snapshot_ns / 1000);  // Q3d snapshot_us (G6r)
  }
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

  // The headless CanvasTexture shim (opt-in; protocol/canvas-texture-headless.md "Experiment (a)
  // result"). It hands the engine RIDs the server never returned, which only the dummy rasterizer
  // of a `headless` display server ignores, so an opt-in on any other host refuses the whole
  // capture -- typed, before anything is hooked -- rather than arming without it. Decided in both
  // modes, so validate predicts arm.
  if (g_state.ct_shim_env_set) {
    std::string why;
    bool ok = rs::parse_canvas_texture_shim_mode(g_state.ct_shim_env.c_str(),
                                                 &g_state.ct_shim_mode, &why);
    if (!ok) {
      log_line("canvas texture shim: " + why);
      why = "canvas-texture-shim-invalid";
    } else {
      ok = rs::canvas_texture_shim_may_arm(g_state.ct_shim_mode, g_state.display_server, &why);
    }
    g_state.checks.push_back(
        {"canvas_texture_shim", ok,
         "GRC_HEADLESS_CANVAS_TEXTURE=" + g_state.ct_shim_env + " display_server=" +
             g_state.display_server + (ok ? std::string() : " -> " + why)});
    if (!ok) {
      g_state.ct_shim_state = "refused";
      g_state.ct_shim_reason = why;
      rs::canvas_texture_shim().configure(rs::CanvasTextureShimMode::Off, g_state.display_server);
      emit_canvas_texture_shim();
      refuse(why);
      return true;
    }
  }

  if (g_state.mode != "arm") {
    decide("validated", std::string());
    return true;
  }

  hooks_init_image_binds();
  if (!hooks_image_details_available()) {
    log_line("Image method binds unavailable: texture captures will omit details");
  }
  // Configured before the vptr store, so the first hooked canvas_texture_create already sees it.
  rs::canvas_texture_shim().configure(g_state.ct_shim_mode, g_state.display_server);
  if (g_state.ct_shim_mode == rs::CanvasTextureShimMode::Synthesize) {
    g_state.ct_shim_state = "armed";
    log_line("canvas texture shim: synthesize armed (display server " + g_state.display_server +
             ")");
  }
  if (!g_state.shadow.arm(g_state.facts.singleton, static_cast<size_t>(g_state.calib.slot_count),
                          plan.replacements, &error)) {
    log_line("arm: " + error);
    if (g_state.ct_shim_state == "armed") {
      rs::canvas_texture_shim().configure(rs::CanvasTextureShimMode::Off, g_state.display_server);
      g_state.ct_shim_state = "refused";
      g_state.ct_shim_reason = "arm-failed";
    }
    refuse("arm-failed");
    return true;
  }
  g_state.armed = true;
  g_state.vptr_written = true;
  perf_arm();
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
  emit_canvas_texture_shim();
  perf_finish();
  emit("result.json", result_json());
}

void on_startup() { attempt("startup"); }

void on_frame() {
  const uint64_t frame_start_ns = monotonic_ns();
  // Q3d frame_interval_us (G6r): measured only while armed, from one armed callback to the
  // next -- the unarmed/validate-mode callbacks before arming are not part of any measured arm
  // (D11's `unarmed` arm is "no extension at all", so this code does not even run for it).
  if (g_state.armed && g_state.evidence_ready) {
    if (g_perf.last_frame_ns != 0) {
      g_perf.frame_interval_us.add((frame_start_ns - g_perf.last_frame_ns) / 1000);
    }
    g_perf.last_frame_ns = frame_start_ns;
  }
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
  if (armed_at_start && g_state.evidence_ready) {
    const uint64_t now_ns = monotonic_ns();
    g_perf.frame_callback_us.add((now_ns - frame_start_ns) / 1000);  // Q3d frame_callback_us
    perf_timeline_tick(now_ns);
  }
}

void on_shutdown() {
  stream_finish(rs2::EndReason::Shutdown);
  live_linger(true);  // a linger still running after a disarm ends here
  do_disarm("shutdown");
  emit("counters.json", hooks_counters_json(g_state.frames_total, g_state.frames_armed));
  emit_canvas_texture_shim();
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
  g_state.ct_shim_env_set = std::getenv("GRC_HEADLESS_CANVAS_TEXTURE") != nullptr;
  g_state.ct_shim_env = env_string("GRC_HEADLESS_CANVAS_TEXTURE");
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
