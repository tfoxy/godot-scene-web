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
// "method":"OPTIONS". GRC_LIVE_CREDIT_WINDOW_MAX (1..2, default 2) caps the hello's window
// (G7q implements window 2, fork F1, opt-in). Listener sabotages (GRC_SABOTAGE, all need
// GRC_LIVE_LISTEN): no-cors (no Access-Control-* header at all), accept-any-origin (the
// allowlist is ignored), token-ignored (a wrong /7 hello token is not refused; needs
// GRC_LIVE_AUTH=token) and window-overrun (G7q: from GRC_SABOTAGE_FRAME on, default 1, every
// connection keeps publishing at each due tick past a full credit window, the third in flight
// at window 2 and every one after). They act on the listener only, never on a record, so the
// wire declares no sabotage for them (the session's `sabotage` stays null): evidence/live.json
// carries `listener_sabotage` instead.

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
#include "rs_adopt.h"
#include "rs_canvas_texture_shim.h"
#include "rs_gate8_policy.h"
#include "rs_texture_basis.h"
#include "rs_texture_delivery.h"
#include "rs_histogram.h"
#include "rs_live.h"
#include "rs_mirror.h"
#include "rs_publish.h"
#include "rs_resource_log.h"
#include "rs_resource_store.h"
#include "rs_root_query.h"
#include "rs_shader_clock.h"
#include "rs_texture_cache.h"
#include "rs_texture_decode.h"
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
  bool shader_clock_logged = false;  // P3-TM: the clock's unavailability is logged once
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
  // gate8-design.md D2: GRC_STREAM_VERSION, GRC_ADOPT, GRC_TEXTURE_DECODE and the float-format
  // request, read at arm; and what the adoption seam reported (G8w: nothing).
  rs::Gate8Policy gate8;
  rs::AdoptStats adopt_stats;
  // G8r: GRC_ADOPT_FAULT (lazy resource adoption's fault knob), read at arm.
  rs::AdoptFault adopt_fault = rs::AdoptFault::None;
  // G8kw (texture-delivery-design.md D11, Q7): GRC_TEXTURE_WORKERS and its knobs, read at arm,
  // and the publication hold-back that waits for the workers' hashes (unused when sync).
  rs::TextureWorkerConfig workers;
  rs::HoldBack holdback;
  bool workers_started = false;
  uint64_t texture_cache_max_bytes = 0;  // G8kc: GRC_TEXTURE_CACHE_MAX_BYTES (0: unbounded)
  // G8ku: the /9 basis-uastc encode pool (rs_texture_basis.h) and its knobs.
  bool basis = false;
  bool encoders_started = false;
  rs::BasisConfig basis_config;
  // G8a (D13): GRC_MIRROR_MAX_ITEMS / GRC_MIRROR_MAX_COMMANDS, read at arm.
  size_t max_items = rs2::kMaxLiveItems;
  size_t max_commands = rs2::kMaxCommandsPerItem;
  // P3-CAP: the file sinks' and the store's I/O thread (rs_file_writer.h); null under
  // GRC_FILE_WRITER=sync. Declared before the sinks and the store it serves, so it is destroyed
  // after them (their close() drains it).
  std::unique_ptr<rs::FileWriter> writer;
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
  // listener sabotage (no-cors | accept-any-origin | token-ignored | window-overrun; empty when
  // none).
  std::vector<std::string> allowed_origins;
  uint64_t credit_window_max = 2;
  std::string listener_sabotage;
  // G8kz: GRC_HTTP_ENCODING (default zstd): the codings the host offers on resource GETs.
  std::vector<live::Coding> http_codings;
  bool http_coding_on = false;
};

// G8kz (texture-delivery-design.md D2): GRC_HTTP_ENCODING = off | zstd | gzip, default zstd (the
// default is safe because the coding is negotiated per request: a client that sends no
// Accept-Encoding gets today's identity bytes).
bool parse_http_encoding(const char *text, std::vector<live::Coding> *out, std::string *error) {
  const std::string value = text != nullptr ? std::string(text) : std::string();
  out->clear();
  if (value.empty() || value == "zstd") {
    out->push_back(live::Coding::Zstd);
  } else if (value == "gzip") {
    out->push_back(live::Coding::Gzip);
  } else if (value != "off") {
    *error = "invalid GRC_HTTP_ENCODING=" + value + " (off, zstd or gzip)";
    return false;
  }
  return true;
}

// G7n: the GRC_SABOTAGE kinds that act on the listener only (see the header comment).
bool is_listener_sabotage(const char *kind) {
  if (kind == nullptr) {
    return false;
  }
  const std::string text(kind);
  return text == "no-cors" || text == "accept-any-origin" || text == "token-ignored" ||
         text == "window-overrun" || text == "corrupt-coded-body";
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
  // Additive (G8w, gate8-design.md D2): present only when a /8 sink or a gate 8 policy is in play,
  // so every run without them keeps its result.json unchanged.
  if (g_stream.gate8.speaks_v8()) {
    json.key("gate8").object_begin();
    json.field("file_stream_version", static_cast<int64_t>(
                   g_stream.gate8.speaks_v10()
                       ? 10
                       : g_stream.gate8.speaks_v9()
                       ? 9
                       : (g_stream.gate8.file_version == rs2::ProtocolVersion::V8 ? 8 : 6)));
    if (g_stream.gate8.speaks_v9()) {
      json.field("texture_delivery", rs::texture_delivery_policy().mode);
      // G8kp (texture-delivery-design.md Q3 "Fallbacks, all typed and counted").
      const rs::DeliveryStats delivery = rs::texture_delivery_stats();
      json.key("delivery_stats").object_begin();
      json.field("block_built", delivery.block_built);
      json.field("block_bytes", delivery.block_bytes);
      json.field("block_declined", delivery.block_declined);
      if (g_stream.basis) {
        // G8ku: the lazy uastc variants (D6, D12) and their encode cost.
        const rs::BasisStats basis = rs::texture_delivery_basis_stats();
        json.field("uastc_level", static_cast<int64_t>(g_stream.basis_config.uastc_level));
        json.field("uastc_built", basis.uastc_built);
        json.field("uastc_bytes", basis.uastc_bytes);
        json.field("uastc_failed", basis.uastc_failed);
        json.field("uastc_stale", basis.uastc_stale);
        json.field("uastc_declined_updated", basis.declined_updated);
        json.field("uastc_declined_format", basis.declined_format);
        json.field("uastc_declined_small", basis.declined_small);
        json.field("encodes_submitted", basis.encodes_submitted);
        json.field("encodes_run", basis.encodes_run);
        json.field("cache_hits", basis.cache_hits);
        json.field("encode_workers", static_cast<int64_t>(g_stream.basis_config.encode_workers));
        json.field("encode_us_total", static_cast<int64_t>(basis.encode_ns_total / 1000));
        json.field("encode_us_max", static_cast<int64_t>(basis.encode_ns_max / 1000));
        json.field("encode_px_total", static_cast<int64_t>(basis.encode_px_total));
        json.field("fault", std::string(g_stream.basis_config.fault_perturb
                                           ? "perturb-ktx2"
                                           : g_stream.basis_config.fault_corrupt ? "corrupt-ktx2" : "none"));
      }
      json.object_end();
    }
    json.field("adopt", std::string(g_stream.gate8.adopt ? "arm" : "off"));
    json.field("texture_decode", std::string(g_stream.gate8.decode_engine ? "engine" : "off"));
    json.field("float_formats", g_stream.gate8.float_formats);
    json.key("adopt_stats").object_begin();
    json.field("ran", g_stream.adopt_stats.ran);
    json.field("canvases", static_cast<int64_t>(g_stream.adopt_stats.canvases));
    json.field("layers", static_cast<int64_t>(g_stream.adopt_stats.layers));
    json.field("items", static_cast<int64_t>(g_stream.adopt_stats.items));
    // G8a: the residue (RS-only canvas/item RIDs with no node) is only discovered when a later
    // call names one: under skip the mirror counts every distinct one; under strict the first
    // one is the sticky pre-existing-object failure, so the count is not known (null).
    if (!g_stream.gate8.adopt) {
      json.field("residue", static_cast<int64_t>(0));
    } else if (g_stream.unknown_item_policy == rs2::UnknownItemPolicy::Skip) {
      json.field("residue", static_cast<int64_t>(rs::mirror_stats().unknown_rids_named));
    } else {
      json.field_null("residue");
    }
    if (g_stream.gate8.adopt) {
      const rs::AdoptStats &a = g_stream.adopt_stats;
      json.field_or_null("error", a.error);
      json.field("hidden", static_cast<int64_t>(a.hidden));
      json.field("top_level", static_cast<int64_t>(a.top_level));
      json.field("redraws", static_cast<int64_t>(a.redraws));
      json.field("canvas_modulates", static_cast<int64_t>(a.canvas_modulates));
      json.field("lights", static_cast<int64_t>(a.lights));
      json.field("materials", static_cast<int64_t>(a.materials));
      if (g_stream.gate8.speaks_v10()) {
        // CG1 (render-stream-10.md "Capture"/"Adoption"): additive, /10 streams only.
        json.field("canvas_groups", static_cast<int64_t>(a.canvas_groups));
        json.field("backbuffer_copies", static_cast<int64_t>(a.backbuffer_copies));
      }
      json.field("non_root_viewports", static_cast<int64_t>(a.non_root_viewports));
      json.field("walk_ns", static_cast<int64_t>(a.walk_ns));
      json.field("apply_ns", static_cast<int64_t>(a.apply_ns));
      json.field("engine_ns", static_cast<int64_t>(a.engine_ns));
      json.field("total_ns", static_cast<int64_t>(a.total_ns));
      json.field("max_items", static_cast<int64_t>(g_stream.max_items));
      json.field("max_commands", static_cast<int64_t>(g_stream.max_commands));
      // G8r (D6, D7): lazy resource adoption's account.
      const rs::AdoptResourceStats r = rs::adopt_resource_stats();
      json.field("fault", std::string(rs::adopt_fault_name(g_stream.adopt_fault)));
      json.key("resources").object_begin();
      json.field("textures", static_cast<int64_t>(r.textures));
      json.field("textures_current", static_cast<int64_t>(r.textures_current));
      json.field("textures_creation", static_cast<int64_t>(r.textures_creation));
      json.field("atlas_pages", static_cast<int64_t>(r.atlas_pages));
      json.field("compressed", static_cast<int64_t>(r.compressed));
      json.field("from_update", static_cast<int64_t>(r.from_update));
      json.field("decoded", static_cast<int64_t>(r.decoded));
      json.field("textures_refused", static_cast<int64_t>(r.textures_refused));
      json.field("meshes", static_cast<int64_t>(r.meshes));
      json.field("mesh_surfaces", static_cast<int64_t>(r.mesh_surfaces));
      json.field("meshes_refused", static_cast<int64_t>(r.meshes_refused));
      json.field("fonts", static_cast<int64_t>(r.fonts));
      json.field("cached_compressed", static_cast<int64_t>(r.cached_compressed));
      json.field("cache_paths", static_cast<int64_t>(r.cache_paths));
      json.field("census_ns", static_cast<int64_t>(r.census_ns));
      json.field("lookup_ns", static_cast<int64_t>(r.lookup_ns));
      json.object_end();
      // G8m (D11, D12, Q5): material and shader adoption's account (`materials` above is G8a's
      // count of adopted items that draw with a material).
      const rs::AdoptMaterialStats ms = rs::adopt_material_stats();
      json.key("material_adoption").object_begin();
      json.field("materials", static_cast<int64_t>(ms.materials));
      json.field("shader_materials", static_cast<int64_t>(ms.shader_materials));
      json.field("canvas_item_materials", static_cast<int64_t>(ms.canvas_item_materials));
      json.field("at_arm", static_cast<int64_t>(ms.at_arm));
      json.field("materials_refused", static_cast<int64_t>(ms.materials_refused));
      json.field("shaders", static_cast<int64_t>(ms.shaders));
      json.field("shaders_builtin", static_cast<int64_t>(ms.shaders_builtin));
      json.field("shaders_include_refused", static_cast<int64_t>(ms.shaders_include_refused));
      json.field("shaders_lazy", static_cast<int64_t>(ms.shaders_lazy));
      json.field("shaders_refused", static_cast<int64_t>(ms.shaders_refused));
      json.field("params", static_cast<int64_t>(ms.params));
      json.field("default_textures", static_cast<int64_t>(ms.default_textures));
      json.field("instance_params", static_cast<int64_t>(ms.instance_params));
      json.field("resolve_passes", static_cast<int64_t>(ms.resolve_passes));
      json.field("nodes_added", static_cast<int64_t>(ms.nodes_added));
      json.field("node_map_connected", ms.node_map_connected);
      json.field("arm_ns", static_cast<int64_t>(ms.arm_ns));
      json.field("resolve_ns", static_cast<int64_t>(ms.resolve_ns));
      json.object_end();
    }
    json.object_end();
    // G8t (gate8-design.md Q3 `decode-cost`): the decode seam's totals since arm (per-texture
    // times are the hook log's `decode_ns`).
    const rs::DecodeStats decode = rs::texture_decode_stats();
    json.key("decode_stats").object_begin();
    json.field("decoded", decode.decoded);
    json.field("declined", decode.declined);
    json.field("decoded_bytes", decode.decoded_bytes);
    json.field("decode_ns_total", decode.decode_ns_total);
    json.field("decode_ns_max", decode.decode_ns_max);
    json.object_end();
    json.object_end();
  }
  // Additive (G8kw): present only under GRC_TEXTURE_WORKERS=<N>.
  if (g_stream.workers.async()) {
    const rs::TextureWorkerPool::Stats pool = rs::texture_worker_pool().stats();
    const rs::HoldBack::Stats &hold = g_stream.holdback.stats();
    json.key("texture_workers").object_begin();
    json.field("workers", static_cast<int64_t>(g_stream.workers.workers));
    json.field("min_bytes", static_cast<int64_t>(g_stream.workers.min_bytes));
    json.field("delay_ms", static_cast<int64_t>(g_stream.workers.delay_ms));
    json.field("fault", std::string(g_stream.workers.fault_publish_before_ready
                                        ? "publish-before-ready"
                                        : "none"));
    json.field("publish_pending", g_stream.workers.publish_pending);
    json.field("pending_published", static_cast<int64_t>(rs::mirror_instance().pending_published()));
    json.field("jobs", static_cast<int64_t>(pool.submitted));
    json.field("completed", static_cast<int64_t>(pool.completed));
    json.field("max_queued", static_cast<int64_t>(pool.max_queued));
    json.field("busy_ns", static_cast<int64_t>(pool.busy_ns));
    json.field("max_job_ns", static_cast<int64_t>(pool.max_job_ns));
    json.field("snapshots_offered", static_cast<int64_t>(hold.offered));
    json.field("held_callbacks", static_cast<int64_t>(hold.held_callbacks));
    json.field("published_late", static_cast<int64_t>(hold.published_late));
    json.field("coalesced", static_cast<int64_t>(hold.coalesced));
    json.field("evicted", static_cast<int64_t>(hold.evicted));
    json.field("max_lag_frames", static_cast<int64_t>(hold.max_lag_frames));
    json.field("max_held", static_cast<int64_t>(hold.max_held));
    json.object_end();
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
  // Additive (G8kc): present only under GRC_TEXTURE_CACHE_DIR, so every other run's result.json
  // is unchanged. derivations is what the cache did not have: the engine decodes this session ran.
  if (rs::texture_cache().enabled()) {
    const rs::CacheStats cache = rs::texture_cache().stats();
    const rs::DecodeStats decode = rs::texture_decode_stats();
    json.key("texture_cache").object_begin();
    json.field("max_bytes", static_cast<int64_t>(g_stream.texture_cache_max_bytes));
    json.field("hits", cache.hits);
    json.field("misses", cache.misses);
    json.field("corrupt", cache.corrupt);
    json.field("puts", cache.puts);
    json.field("evicted", cache.evicted);
    json.field("bytes_hit", cache.bytes_hit);
    json.field("bytes_put", cache.bytes_put);
    json.field("entries", cache.entries);
    json.field("files", cache.files);
    json.field("bytes", cache.bytes);
    json.field("derivations", decode.decoded);
    // G8ku: the UASTC encodes this session ran (a warm cache serves them: zero).
    json.field("encodes", rs::texture_delivery_basis_stats().encodes_run);
    json.object_end();
  }
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
              ",\"carried_size\":" + std::to_string(s.carried_size) +
              // P3-SP: transactions re-stamped from another connection's encode (shared
              // publication); 0 for a lone connection.
              ",\"shared_sends\":" + std::to_string(s.shared_sends) +
              // G7q: a window-2 connection's grant (credit capacity is w / RTT); absent at 1.
              (s.credit_window > 1 ? ",\"credit_window\":" + std::to_string(s.credit_window)
                                   : std::string()) +
              "}";
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
  json.field("http_encoding", g_live.serving.http_encoding);
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
  // G8w (gate8-design.md D2): GRC_STREAM_VERSION, GRC_ADOPT, GRC_TEXTURE_DECODE and a float format
  // in GRC_RESOURCE_FORMATS. A gate 8 policy needs /8, so a file sink that is not /8 refuses.
  {
    rs::Gate8Policy gate8;
    std::string error;
    const bool parsed = rs::parse_gate8_policy(
        std::getenv("GRC_STREAM_VERSION"), std::getenv("GRC_ADOPT"),
        std::getenv("GRC_TEXTURE_DECODE"), std::getenv("GRC_RESOURCE_FORMATS"), &gate8, &error);
    gate8.v8_sabotage = parsed && sabotage.ok && rs::sabotage_needs_v8(sabotage.config.kind);
    if (!parsed || !rs::gate8_policy_allows(gate8, files, &error)) {
      log_line("stream: refused gate 8 policy (" + error + ")");
      g_stream.status = "refused";
      g_stream.reason = error;
      if (!g_live.listen.empty()) {
        live_decided("refused", "stream refused: " + error);
      }
      return;
    }
    // G8r: GRC_ADOPT_FAULT needs GRC_ADOPT=arm (rs_adopt.h AdoptFault).
    rs::AdoptFault adopt_fault = rs::AdoptFault::None;
    if (!rs::parse_adopt_fault(std::getenv("GRC_ADOPT_FAULT"), gate8.adopt, &adopt_fault, &error)) {
      log_line("stream: refused adoption fault (" + error + ")");
      g_stream.status = "refused";
      g_stream.reason = error;
      if (!g_live.listen.empty()) {
        live_decided("refused", "stream refused: " + error);
      }
      return;
    }
    g_stream.adopt_fault = adopt_fault;
    // G8k9 (texture-delivery-design.md D1): GRC_TEXTURE_DELIVERY, declared by a /9 session only; at
    // every other version the decoded payload is all there is, so it changes nothing there.
    rs::DeliveryPolicy delivery;
    if (!rs::parse_delivery_policy(std::getenv("GRC_TEXTURE_DELIVERY"), &delivery, &error)) {
      log_line("stream: refused texture delivery policy (" + error + ")");
      g_stream.status = "refused";
      g_stream.reason = error;
      if (!g_live.listen.empty()) {
        live_decided("refused", "stream refused: " + error);
      }
      return;
    }
    // G8kp: a /9 stream declares the mode, so it must be one this build honours (the Basis modes
    // are refused typed until G8ku/G8ke). Below /9 the mode is ignored, as G8k9 left it.
    if (gate8.speaks_v9() && !rs::delivery_mode_implemented(delivery, &error)) {
      log_line("stream: refused texture delivery policy (" + error + ")");
      g_stream.status = "refused";
      g_stream.reason = error;
      if (!g_live.listen.empty()) {
        live_decided("refused", "stream refused: " + error);
      }
      return;
    }
    rs::texture_delivery_set_policy(delivery);
    g_stream.policy.texture_delivery = rs::declare_texture_delivery(delivery);
    // G8kp: the hooks keep a block-compressed source's own bytes (the `block` variant) only on a
    // /9 stream whose mode offers it.
    rs::texture_delivery_set_block(gate8.speaks_v9() && rs::mode_offers_block(delivery.mode));
    // G8ku: a /9 basis-uastc stream encodes lazily on its own pool (rs_texture_basis.h).
    g_stream.basis = gate8.speaks_v9() && delivery.mode == "basis-uastc";
    g_stream.basis_config = rs::BasisConfig();
    if (g_stream.basis &&
        !rs::parse_basis_config(std::getenv("GRC_TEXTURE_UASTC_LEVEL"),
                                std::getenv("GRC_TEXTURE_BASIS_MIN_PX"),
                                std::getenv("GRC_TEXTURE_ENCODE_WORKERS"),
                                std::getenv("GRC_TEXTURE_ENCODE_WAIT_FRAME"),
                                std::getenv("GRC_TEXTURE_ENCODE_FAULT"), &g_stream.basis_config,
                                &error, std::getenv("GRC_TEXTURE_ENCODE_DRAIN"))) {
      log_line("stream: refused texture delivery policy (" + error + ")");
      g_stream.status = "refused";
      g_stream.reason = error;
      if (!g_live.listen.empty()) {
        live_decided("refused", "stream refused: " + error);
      }
      return;
    }
    rs::texture_delivery_set_basis(g_stream.basis, g_stream.basis_config);
    g_stream.gate8 = gate8;
    g_stream.policy.decode = gate8.decode_engine ? rs2::TextureDecode::Engine : rs2::TextureDecode::Off;
    rs::texture_decode_set_enabled(gate8.decode_engine);
  }
  // G8kw (texture-delivery-design.md D11): GRC_TEXTURE_WORKERS, valid at every version (the
  // hold-back changes when a frame is published, never what a transaction says).
  {
    rs::TextureWorkerConfig workers;
    std::string error;
    bool workers_ok = rs::parse_texture_workers(
        std::getenv("GRC_TEXTURE_WORKERS"), std::getenv("GRC_TEXTURE_WORKER_MIN_BYTES"),
        std::getenv("GRC_TEXTURE_WORKER_DELAY_MS"), std::getenv("GRC_TEXTURE_WORKER_FAULT"), &workers,
        &error, std::getenv("GRC_TEXTURE_PENDING"));
    if (workers_ok && workers.publish_pending && !g_stream.gate8.speaks_v9()) {
      error = "GRC_TEXTURE_PENDING=publish needs render-stream/9 (delivery-pending is a /9 reason)";
      workers_ok = false;
    }
    if (!workers_ok) {
      log_line("stream: refused texture workers (" + error + ")");
      g_stream.status = "refused";
      g_stream.reason = error;
      if (!g_live.listen.empty()) {
        live_decided("refused", "stream refused: " + error);
      }
      return;
    }
    g_stream.workers = workers;
    g_stream.holdback = rs::HoldBack();
    hooks_set_texture_workers(rs::TextureWorkerConfig());  // sync until the pool runs
  }
  // G8kc (texture-delivery-design.md D8): GRC_TEXTURE_CACHE_DIR and GRC_TEXTURE_CACHE_MAX_BYTES,
  // valid at every version (the cache only stands in for a derivation, never changes a payload).
  // Unset, the cache is closed and nothing below it runs.
  {
    rs::CacheConfig cache;
    std::string error;
    if (!rs::parse_cache_config(std::getenv("GRC_TEXTURE_CACHE_DIR"),
                                std::getenv("GRC_TEXTURE_CACHE_MAX_BYTES"), &cache, &error) ||
        !rs::texture_cache().open(cache, &error)) {
      log_line("stream: refused texture cache (" + error + ")");
      g_stream.status = "refused";
      g_stream.reason = error;
      if (!g_live.listen.empty()) {
        live_decided("refused", "stream refused: " + error);
      }
      return;
    }
    g_stream.texture_cache_max_bytes = cache.max_bytes;
    hooks_reset_texture_cache_notes();
  }
  // G8a (gate8-design.md D13): the mirror's caps are configuration. No wire change: a cap that is
  // hit is the existing `mirror-capacity` failure. Defaults keep every other session unchanged.
  {
    uint64_t max_items = 0;
    uint64_t max_commands = 0;
    std::string error;
    if (!env_non_negative("GRC_MIRROR_MAX_ITEMS", rs2::kMaxLiveItems, &max_items) ||
        max_items < 1 || max_items > (1u << 20)) {
      error = "invalid GRC_MIRROR_MAX_ITEMS=" + env_string("GRC_MIRROR_MAX_ITEMS") +
              " (expected an integer 1..1048576)";
    } else if (!env_non_negative("GRC_MIRROR_MAX_COMMANDS", rs2::kMaxCommandsPerItem,
                                 &max_commands) ||
               max_commands < 1 || max_commands > (1u << 20)) {
      error = "invalid GRC_MIRROR_MAX_COMMANDS=" + env_string("GRC_MIRROR_MAX_COMMANDS") +
              " (expected an integer 1..1048576)";
    }
    if (!error.empty()) {
      log_line("stream: refused mirror caps (" + error + ")");
      g_stream.status = "refused";
      g_stream.reason = error;
      if (!g_live.listen.empty()) {
        live_decided("refused", "stream refused: " + error);
      }
      return;
    }
    g_stream.max_items = static_cast<size_t>(max_items);
    g_stream.max_commands = static_cast<size_t>(max_commands);
  }
  // G8a (gate8-design.md D4): adoption reads the scene tree, so it runs on the main thread only
  // (`adopt-thread`), and only when every method bind it needs exists at its 4.5.1 hash
  // (`adopt-unavailable`); both refuse before anything is published.
  if (g_stream.gate8.adopt) {
    std::string why;
    std::string detail;
    if (!rs::adopt_binds_ready(&detail)) {
      why = "adopt-unavailable: " + detail;
    } else if (!rs::adopt_on_main_thread(&detail)) {
      why = "adopt-thread: " + detail;
    }
    if (!why.empty()) {
      log_line("stream: refused adoption (" + why + ")");
      g_stream.status = "refused";
      g_stream.reason = why;
      if (!g_live.listen.empty()) {
        live_decided("refused", "stream refused: " + why);
      }
      return;
    }
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
    // P3-TM (render-stream-10.md "Shader time"): a /10 session carries the host's shader time, so
    // TIME is a use, not a reason, from the first hooked (or adopted) shader on.
    if (g_stream.gate8.speaks_v10()) {
      hooks_set_shader_time_carried(true);
      rs::mirror_instance().set_carry_shader_time(true);
      const rs::ShaderClock &clock = rs::shader_clock();
      log_line(std::string("shader-clock: carried; source=") + rs::shader_clock_source() +
               (clock.tree_delta_fault ? " (GRC_SHADER_CLOCK_FAULT=tree-delta)" : "") +
               " rollover=" + std::to_string(clock.rollover) +
               " start_frames_drawn=" + std::to_string(clock.start_drawn) + " ticks=" +
               std::to_string(clock.ticks) + " advanced=" + std::to_string(clock.advanced));
    }
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
    } else if (!env_positive("GRC_LIVE_CREDIT_WINDOW_MAX", 2, &live_config.credit_window_max) ||
               live_config.credit_window_max > 2) {
      live_ok = false;
      why = "invalid GRC_LIVE_CREDIT_WINDOW_MAX (1 or 2)";
    } else if (!parse_http_encoding(std::getenv("GRC_HTTP_ENCODING"), &g_live.http_codings,
                                    &why)) {
      live_ok = false;
    } else if (g_live.listener_sabotage == "corrupt-coded-body" && g_live.http_codings.empty()) {
      live_ok = false;
      why = "sabotage corrupt-coded-body needs GRC_HTTP_ENCODING=zstd or gzip";
    } else if (g_live.listener_sabotage == "token-ignored" && auth_mode != "token") {
      live_ok = false;
      why = "sabotage token-ignored needs GRC_LIVE_AUTH=token";
    } else if (g_live.listener_sabotage == "window-overrun" &&
               !env_positive("GRC_SABOTAGE_FRAME", 1, &live_config.window_overrun_frame)) {
      // G7q: the frame the overrun starts at (default 1, from the first send).
      live_ok = false;
      why = "sabotage window-overrun: invalid GRC_SABOTAGE_FRAME (a positive frame)";
    }
    g_live.credit_window_max = live_config.credit_window_max;
    g_live.serving.http_encoding =
        g_live.http_codings.empty() ? "off" : live::coding_token(g_live.http_codings[0]);
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
    } else if (kind == rs2::SabotageKind::PerturbDecode && !g_stream.gate8.decode_engine) {
      // G8t (gate8-design.md Q3 "Sabotages"): it perturbs host-decoded payloads only.
      why = "perturb-decode acts on host-decoded textures; set GRC_TEXTURE_DECODE=engine";    } else if (kind == rs2::SabotageKind::SizeBeforeAdopt &&
               (!g_stream.gate8.adopt || policy != RootSizePolicy::Presentation)) {
      // G8h (gate8-design.md Q4 "Sabotage"): it reorders the late presentation against adoption.
      why = "size-before-adopt orders the presentation size against adoption; set GRC_ADOPT=arm "
            "and GRC_ROOT_SIZE=presentation:<W>x<H>";
    } else if ((kind == rs2::SabotageKind::AdoptSkipState ||
                kind == rs2::SabotageKind::AdoptNoRedraw ||
                kind == rs2::SabotageKind::AdoptSkipLayers) &&
               !g_stream.gate8.adopt) {
      // G8a (gate8-design.md Q2 "Sabotages"): they act on the arm-time adoption walk.
      why = std::string(rs2::to_wire(kind)) + " acts on the adoption walk; set GRC_ADOPT=arm";
    } else if ((kind == rs2::SabotageKind::AdoptRawShaderCode ||
                kind == rs2::SabotageKind::AdoptSkipParams) &&
               !g_stream.gate8.adopt) {
      // G8m (gate8-design.md Q5 "Sabotages"): they act on adopted shaders and materials.
      why = std::string(rs2::to_wire(kind)) + " acts on adopted materials; set GRC_ADOPT=arm";
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
  // G8w (gate8-design.md D2): /8 only when a file sink asked for it (GRC_STREAM_VERSION=8) or a
  // gate 8 policy needs it; /6 otherwise, and every /2-/7 byte stays as it was.
  // G8k9: GRC_STREAM_VERSION=9 selects /9 (render-stream-9.md); the seam declares the delivery mode.
  // CG1: GRC_STREAM_VERSION=10 selects /10 (render-stream-10.md).
  session.version = g_stream.gate8.speaks_v10()  ? rs2::ProtocolVersion::V10
                    : g_stream.gate8.speaks_v9() ? rs2::ProtocolVersion::V9
                    : g_stream.gate8.speaks_v8() ? rs2::ProtocolVersion::V8
                                                 : rs2::ProtocolVersion::V6;
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
  // /7 and /8 change no feature list (render-stream-7.md, render-stream-8.md): ask for /6's.
  session.features = rs2::gate2_features(headless_host && !ct_synthesized, rs2::ProtocolVersion::V6);
  if (session.version == rs2::ProtocolVersion::V10) {
    // render-stream-10.md "Features": each back-buffer setter leaves unobserved when its hook is
    // planned (a record without the slot omits the hook and keeps the method unobserved).
    rs2::observe_planned_backbuffer_setters(&session.features, session.capture.hooks_planned);
  }
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
  // P3-CAP (results/p3/p3-cap.md): the file sinks' and the store's I/O leave the frame callback
  // for one writer thread, in submission order (the bytes on disk are unchanged).
  // GRC_FILE_WRITER=sync keeps it on the calling thread.
  if (files) {
    const std::string mode = env_string("GRC_FILE_WRITER");
    if (mode != "sync") {
      if (!mode.empty() && mode != "thread") {
        log_line("stream: ignoring GRC_FILE_WRITER=" + mode + " (thread | sync)");
      }
      g_stream.writer = std::make_unique<rs::FileWriter>();
      for (rs2::FileRecordSink *sink : {g_stream.full_sink.get(), g_stream.patch_sink.get()}) {
        if (sink != nullptr) {
          sink->set_writer(g_stream.writer.get());
        }
      }
      if (g_stream.store != nullptr) {
        g_stream.store->set_writer(g_stream.writer.get());
      }
    }
    log_line(std::string("stream: file_writer=") + (g_stream.writer != nullptr ? "thread" : "sync"));
  }

  // G8kw: the pool runs before the mirror sees any call, and until stream_finish() drained it.
  if (g_stream.workers.async()) {
    g_stream.workers_started =
        rs::texture_worker_pool().start(g_stream.workers.workers, g_stream.workers.delay_ms);
    hooks_set_texture_workers(g_stream.workers);
    rs::mirror_instance().set_publish_pending(g_stream.workers_started && g_stream.workers.publish_pending);
    log_line("stream: texture_workers=" + rs::texture_workers_name(g_stream.workers) +
             " min_bytes=" + std::to_string(g_stream.workers.min_bytes) +
             (g_stream.workers.delay_ms != 0
                  ? " delay_ms=" + std::to_string(g_stream.workers.delay_ms)
                  : std::string()) +
             (g_stream.workers.fault_publish_before_ready ? " fault=publish-before-ready"
                                                          : "") +
             (g_stream.workers_started ? "" : " (pool failed to start: copies stay synchronous)"));
  }
  // G8ku: the encode pool, and the mirror's way to it, before the mirror sees any call.
  if (g_stream.basis) {
    g_stream.encoders_started =
        rs::texture_encode_pool().start(g_stream.basis_config.encode_workers, 0);
    const int level = g_stream.basis_config.uastc_level;
    const bool perturb = g_stream.basis_config.fault_perturb;
    const bool corrupt = g_stream.basis_config.fault_corrupt;
    // G8kf: under GRC_TEXTURE_ENCODE_DRAIN the submit waits for room first (at most two jobs per
    // worker beside the mirror); it runs under the mirror's lock, which the encode workers never take.
    const std::size_t room =
        g_stream.basis_config.drain ? static_cast<std::size_t>(g_stream.basis_config.encode_workers) * 2 - 1
                                    : static_cast<std::size_t>(-1);
    rs::mirror_instance().set_basis_submit([level, perturb, corrupt, room](const rs::BasisJobPtr &job) {
      if (room != static_cast<std::size_t>(-1)) {
        rs::texture_encode_pool().wait_outstanding_at_most(room);
      }
      return rs::submit_basis_job(job, level, perturb, corrupt);
    });
    log_line("stream: basis-uastc encode_workers=" +
             std::to_string(g_stream.basis_config.encode_workers) + " uastc_level=" +
             std::to_string(level) + " min_px=" + std::to_string(g_stream.basis_config.min_px) +
             (g_stream.basis_config.wait_frame != 0
                  ? " wait_frame=" + std::to_string(g_stream.basis_config.wait_frame)
                  : std::string()) +
             (perturb ? " fault=perturb-ktx2" : "") + (corrupt ? " fault=corrupt-ktx2" : "") +
             (g_stream.encoders_started ? "" : " (encode pool failed to start: no uastc variant)"));
  }
  rs::mirror_enable(true);  // off -> on: a fresh mirror session
  // Before the root query, so every hook call the session sees is under the declared policy.
  rs::mirror_set_unknown_item_policy(g_stream.unknown_item_policy);
  rs::mirror_set_caps(g_stream.max_items, g_stream.max_commands);
  if (g_stream.unknown_item_policy == rs2::UnknownItemPolicy::Skip) {
    log_line("stream: unknown_item_policy=skip (unknown canvas/item RIDs are withheld, not failed)");
  }
  const rs::RootInfo before = rs::root_query_run();
  // Binds the root RIDs before the policy runs, so any viewport call the
  // min-size write causes is attributed to the root. A failure becomes the
  // sticky root-query-failed.
  rs::root_query_apply(before);
  // G8w (gate8-design.md D4): adoption runs here, after the root query and before the size policy,
  // because the policy's relayout reaches the hooks as ordinary calls on adopted items. The seam
  // is empty until G8a; the session still declares `adoption` so the wire is honest about intent.
  bool size_applied_early = false;
  if (g_stream.gate8.adopt) {
    // G8a: date every frame of an adopting session in the host's own main-loop iterations. A
    // library loaded at runtime (Q1a) would otherwise count from its load, so frame 1 would be the
    // iteration it armed in; Engine.get_process_frames() is the 0-based index of the iteration
    // running (it advances after the frame callback, main.cpp:4852), so the hooks stamp this
    // iteration's calls `process_frames + 1`, exactly as an extension loaded at startup does.
    const int64_t process_frames = rs::adopt_engine_process_frames();
    if (process_frames > 0 && static_cast<uint64_t>(process_frames) > g_state.frames_total) {
      g_state.frames_total = static_cast<uint64_t>(process_frames);
      hooks_set_frame(g_state.frames_total + 1);
    }
    rs::AdoptConfig adopt_config;
    adopt_config.arm_frame = g_state.frames_total + 1;  // the iteration the walk runs in
    // CG1: the back-buffer state is adopted exactly where its conditional hook is installed.
    const auto planned = [](const char *name) {
      return std::find(g_state.plan.planned.begin(), g_state.plan.planned.end(), name) !=
             g_state.plan.planned.end();
    };
    adopt_config.canvas_group = planned("canvas_item_set_canvas_group_mode");
    adopt_config.copy_to_backbuffer = planned("canvas_item_set_copy_to_backbuffer");
    switch (sabotage.config.kind) {
    case rs2::SabotageKind::AdoptSkipState: adopt_config.sabotage = rs::AdoptSabotage::SkipState; break;
    case rs2::SabotageKind::AdoptNoRedraw: adopt_config.sabotage = rs::AdoptSabotage::NoRedraw; break;
    case rs2::SabotageKind::AdoptSkipLayers: adopt_config.sabotage = rs::AdoptSabotage::SkipLayers; break;
    default: break;
    }
    // G8h (gate8-design.md Q4 "Sabotage"): size-before-adopt applies the presentation size ahead of
    // the walk, so the relayout, stretch and oversampling it causes name RIDs nothing has adopted.
    if (sabotage.config.kind == rs2::SabotageKind::SizeBeforeAdopt) {
      std::string early_detail;
      size_applied_early =
          rs::root_set_min_size(before, presentation_wh[0], presentation_wh[1], &early_detail);
      log_line("sabotage: size-before-adopt applied the presentation size before adoption");
    }
    // G8r (D6, D7): lazy resource adoption is on from the walk to the stream's end; the walk's
    // redraws (this iteration's flush) are the first hooked calls to name pre-arm resources.
    rs::adopt_resources_begin(g_stream.adopt_fault);
    // G8m (D11, D12): materials and shaders resolve after the hook log opens (below) and at every
    // frame boundary; the two Q5 sabotages act there.
    rs::adopt_materials_configure(
        sabotage.config.kind == rs2::SabotageKind::AdoptRawShaderCode
            ? rs::AdoptMaterialSabotage::RawShaderCode
            : sabotage.config.kind == rs2::SabotageKind::AdoptSkipParams
                  ? rs::AdoptMaterialSabotage::SkipParams
                  : rs::AdoptMaterialSabotage::None);
    g_stream.adopt_stats = rs::adopt_at_arm(adopt_config);
    session.adoption.present = true;
    session.adoption.frame = static_cast<int32_t>(adopt_config.arm_frame);
    const rs::AdoptStats &a = g_stream.adopt_stats;
    log_line("adopt: frame=" + std::to_string(adopt_config.arm_frame) + " items=" +
             std::to_string(a.items) + " layers=" + std::to_string(a.layers) + " hidden=" +
             std::to_string(a.hidden) + " top_level=" + std::to_string(a.top_level) +
             " redraws=" + std::to_string(a.redraws) + " non_root_viewports=" +
             std::to_string(a.non_root_viewports) + " total_us=" +
             std::to_string(a.total_ns / 1000) +
             (a.error.empty() ? std::string() : " error=" + a.error));
  }
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
    // size-before-adopt (G8h) already wrote it, ahead of the walk.
    const bool written =
        size_applied_early ? true
        : policy == RootSizePolicy::Presentation
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
  // G8t (gate8-design.md Q3): perturb-decode acts in the decode seam, before the hook hashes.
  rs::texture_decode_set_perturb(
      sabotage.config.kind == rs2::SabotageKind::PerturbDecode ? sabotage.config.frame : 0);
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
    // G8w (gate8-design.md D2): render-stream.8 is offered last by default (the default stays /7),
    // first under GRC_STREAM_VERSION=8, and alone under a gate 8 policy. A /8 upgrade carries the
    // token in the hello like /7's.
    server_config.subprotocols = rs::gate8_live_subprotocols(g_stream.gate8);
    server_config.hello_token_subprotocols = {rs2::kSubprotocolV7, rs2::kSubprotocolV8,
                                                   rs2::kSubprotocolV9, rs2::kSubprotocolV10};
    server_config.auth_token = live_auth_token;  // G2e: empty unless GRC_LIVE_AUTH=token.
    server_config.allowed_origins = g_live.allowed_origins;  // G7n
    server_config.enforce_origins = g_live.listener_sabotage != "accept-any-origin";
    server_config.cors_headers = g_live.listener_sabotage != "no-cors";
    server_config.codings = g_live.http_codings;  // G8kz
    server_config.corrupt_coded_body = g_live.listener_sabotage == "corrupt-coded-body";
    g_live.http_coding_on = !g_live.http_codings.empty();
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
  if (g_stream.gate8.adopt) {
    // G8m (gate8-design.md D11, Q5): every adopted item's material, shader and instance
    // parameters, through the hooks' own paths now that the hook log is open; still this
    // iteration, before the first transaction.
    rs::adopt_materials_at_arm();
    const rs::AdoptMaterialStats ms = rs::adopt_material_stats();
    log_line("adopt: materials=" + std::to_string(ms.materials) + " shaders=" +
             std::to_string(ms.shaders) + " include_refused=" +
             std::to_string(ms.shaders_include_refused) + " instance_params=" +
             std::to_string(ms.instance_params) + " refused=" +
             std::to_string(ms.materials_refused) + " node_map=" +
             (ms.node_map_connected ? "connected" : "unconnected") +
             " us=" + std::to_string(ms.arm_ns / 1000));
  }
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
        g_live.serving.http_coded_bytes += event.coded_bytes;
        if (event.coding == "zstd") ++g_live.serving.http_gets_zstd;
        if (event.coding == "gzip") ++g_live.serving.http_gets_gzip;
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
                                     event.bytes, nullptr, conn, event.http_status, false, nullptr,
                                     event.http_status == 200 && g_live.http_coding_on
                                         ? event.coding.c_str()
                                         : nullptr,
                                     event.coded_bytes);
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
    g_live.serving.coded_made = totals.coded_made;
    g_live.serving.coded_in_bytes = totals.coded_in_bytes;
    g_live.serving.coded_out_bytes = totals.coded_out_bytes;
    g_live.serving.coded_ns = totals.coded_ns;
    g_live.serving.dropped_hash = g_live.served->dropped_hash();
    g_live.serving.corrupted_hash =
        g_stream.store != nullptr ? g_stream.store->corrupted_hash() : std::string();
    log_line("live: resources http_gets=" + std::to_string(g_live.serving.http_gets) +
             " http_bytes=" + std::to_string(g_live.serving.http_bytes) +
             " http_coded_bytes=" + std::to_string(g_live.serving.http_coded_bytes) +
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
// G8kw: drains and stops the texture workers (no job may outlive the stream: each holds an engine
// Image), then publishes the newest held snapshot to the file sinks, so an async recording ends on
// the same state as a synchronous one. Runs before anything is closed. Every later texture call
// copies synchronously (the pool refuses work once stopping).
void workers_finish() {
  if (!g_stream.workers_started) {
    return;
  }
  rs::texture_worker_pool().stop();
  g_stream.workers_started = false;
  rs::mirror_instance().set_publish_pending(false);
  hooks_set_texture_workers(rs::TextureWorkerConfig());
  rs::HeldSnapshot last;
  std::string error;
  const bool have = g_stream.holdback.take_newest(&last, &error);
  if (!error.empty()) {
    log_line("stream: " + error);
    if (g_stream.reason.empty()) {
      g_stream.reason = error;
    }
    return;
  }
  if (have && g_stream.publisher != nullptr && g_stream.reason.empty()) {
    log_line("stream: publishing the held snapshot of frame " + std::to_string(last.frame) +
             " at stream end");
    if (!g_stream.publisher->publish(std::move(last.snapshot), last.frame, last.snapshot_ns)) {
      const std::string why = g_stream.publisher->error();
      g_stream.reason = why.empty() ? std::string("transaction write failed") : why;
    }
  }
}

// G8ku: a lazy encode nobody will publish is dropped at stream end (the pool discards what is
// queued and waits only for the encodes in flight); the mirror forgets its submitter.
void encoders_finish() {
  if (!g_stream.basis) {
    return;
  }
  if (g_stream.basis_config.drain && g_stream.encoders_started) {
    // G8kf: the prepare step's end. Start what the last callback did not, then wait for every
    // queued encode: each one stores its result in the persisted cache (D8).
    rs::mirror_instance().service_basis(false, false);
    rs::texture_encode_pool().drain();
    log_line("stream: drained the uastc encode pool at stream end");
  }
  rs::mirror_instance().set_basis_submit(nullptr);
  const std::size_t dropped = rs::texture_encode_pool().discard_queued();
  rs::texture_encode_pool().stop();
  for (const rs::BasisJobPtr &job : rs::mirror_instance().basis_jobs()) {
    job->abandon();
  }
  g_stream.encoders_started = false;
  if (dropped != 0) {
    log_line("stream: dropped " + std::to_string(dropped) + " queued uastc encodes at stream end");
  }
}

void stream_finish(rs2::EndReason reason) {
  if (g_stream.status != "open") {
    return;
  }
  workers_finish();
  encoders_finish();
  rs::mirror_enable(false);
  rs::adopt_resources_end();  // G8r
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
  if (g_stream.writer != nullptr) {
    std::string error;
    if (!g_stream.writer->drain(&error) && g_stream.reason.empty()) {
      g_stream.reason = error;  // a queued write failed after the last publication
    }
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

// GRT3 (results/grt.md "Part 3"; scripts/README.md "Fast frames"): GRC_LIVE_AWAIT_HELLO_MS=<ms>
// holds the host's whole timeline -- this frame callback, so the main loop, the fixture's frame
// counter and every capture frame stamp -- at the first armed publish until a receiver's hello has
// arrived, or for at most <ms>. Off (unset) by default, so a real-time host is byte for byte what
// it was; the fast-frame correctness legs set it so a receiver's start-up costs no host frames and
// a faster-than-real-time host cannot run its join window out before the receiver connects. Only
// the first hold of a run waits: a reconnect or a second receiver joins a running timeline.
struct LiveAwaitHello {
  bool checked = false;
  uint64_t timeout_ms = 0;
};
LiveAwaitHello g_live_await;

bool live_any_hello() {
  for (const rs2::ConnectionSummary &s : g_live.hub->summaries()) {
    if (!s.stream_id.empty()) {
      return true;
    }
  }
  return false;
}

void live_await_first_hello(uint64_t frame) {
  if (g_live_await.checked) {
    return;
  }
  g_live_await.checked = true;
  if (g_live.hub == nullptr || g_live.server == nullptr || g_live.stopped) {
    return;
  }
  if (!env_positive("GRC_LIVE_AWAIT_HELLO_MS", 0, &g_live_await.timeout_ms)) {
    log_line("live: await-hello: ignoring an invalid GRC_LIVE_AWAIT_HELLO_MS (a positive ms)");
    return;
  }
  if (g_live_await.timeout_ms == 0 || live_any_hello()) {
    return;
  }
  const uint64_t start_ns = monotonic_ns();
  const uint64_t deadline_ns = start_ns + g_live_await.timeout_ms * 1000000ull;
  bool hello = false;
  while (!hello && monotonic_ns() < deadline_ns) {
    std::this_thread::sleep_for(std::chrono::milliseconds(1));
    live_drain(frame);
    hello = live_any_hello();
  }
  log_line("live: await-hello: held frame " + std::to_string(frame) + " for " +
           std::to_string((monotonic_ns() - start_ns) / 1000000ull) + " ms, " +
           (hello ? std::string("a hello arrived") : std::string("timed out")));
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
  live_await_first_hello(frame);  // GRT3: off unless GRC_LIVE_AWAIT_HELLO_MS
  // G6r: one steady-clock read shared by the due-tick check below and, when a snapshot is taken,
  // by the hub's own on_frame() timing -- the quarter-period slack in tick_due() absorbs the few
  // nanoseconds this function otherwise takes before the snapshot would have been copied.
  const uint64_t now_ns = monotonic_ns();
  const bool live_wants = g_live.hub != nullptr && g_live.hub->wants_snapshot(frame, now_ns);
  // G8ku (D6): start the lazy encodes this frame's state admits and attach the finished ones,
  // before the epoch is read, so an attached variant is this callback's mutation. Under
  // GRC_TEXTURE_ENCODE_WAIT_FRAME finished encodes wait for that frame, which waits for them all.
  if (g_stream.basis) {
    const uint64_t wait_frame = g_stream.basis_config.wait_frame;
    const std::size_t attached = rs::mirror_instance().service_basis(
        wait_frame == 0 || frame >= wait_frame, wait_frame != 0 && frame == wait_frame);
    if (attached != 0 && wait_frame != 0 && frame == wait_frame) {
      log_line("stream: attached " + std::to_string(attached) + " uastc variants at frame " +
               std::to_string(frame));
    }
  }
  if (g_stream.workers_started && g_stream.workers.publish_pending) {
    rs::mirror_instance().service_pending();  // G8kf: a finished worker's texture returns as ok
  }
  // P3-TM: this iteration's shader time (a mirror change only while a TIME reader exists).
  rs::mirror_instance().set_shader_time(rs::shader_clock().total);
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
  uint64_t snapshot_ns = monotonic_ns() - t0;
  if (g_state.evidence_ready) {
    g_perf.snapshot_us.add(snapshot_ns / 1000);  // Q3d snapshot_us (G6r)
  }
  // G8kw (texture-delivery-design.md Q7): the publication hold-back. A snapshot naming a texture
  // whose worker has not delivered its hash is held; the newest ready one is published, stamped
  // with its own frame for the file sinks, and the live hub gets it as this callback's state.
  uint64_t publish_frame = frame;
  uint64_t publish_epoch = epoch;
  if (g_stream.workers_started) {
    rs::HeldSnapshot offered;
    offered.snapshot = std::move(snapshot);
    offered.frame = frame;
    offered.epoch = epoch;
    offered.snapshot_ns = snapshot_ns;
    rs::HeldSnapshot ready;
    bool publish = false;
    std::string error;
    if (!g_stream.holdback.offer(std::move(offered), frame,
                                 g_stream.workers.fault_publish_before_ready, &ready, &publish,
                                 &error)) {
      log_line("stream: " + error + " at frame " + std::to_string(frame));
      g_stream.reason = error;
      stream_finish(rs2::EndReason::Shutdown);
      return;
    }
    if (!publish) {
      if (g_live.hub != nullptr) {
        g_live.hub->on_frame(frame, monotonic_ns(), nullptr, epoch, 0);
      }
      return;
    }
    snapshot = std::move(ready.snapshot);
    publish_frame = ready.frame;
    publish_epoch = ready.epoch;
    snapshot_ns = ready.snapshot_ns;
  }
  // gate2-design.md Q3: the retained payloads -- the mirror's current ones, those the previous
  // publication still pins and (G2c2) those still servable over HTTP -- stay within
  // GRC_RESOURCE_BUDGET_BYTES.
  {
    // P3-CAP: the union's bytes without copying the maps into one (payload_union_bytes).
    std::vector<const rs::PayloadMap *> retained = {&snapshot.payloads};
    if (g_stream.publisher != nullptr && g_stream.publisher->last_published() != nullptr) {
      retained.push_back(&g_stream.publisher->last_published()->payloads);
    }
    uint64_t retained_bytes = rs::payload_union_bytes(retained);
    if (serving) {
      retained_bytes += g_live.served->retained_bytes_beyond(retained);
    }
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
    if (!g_stream.publisher->publish(std::move(snapshot), publish_frame, snapshot_ns)) {
      const std::string error = g_stream.publisher->error();
      log_line("stream: write failed at frame " + std::to_string(frame) +
               (error.empty() ? std::string() : " (" + error + ")"));
      g_stream.reason = error.empty() ? std::string("transaction write failed") : error;
      stream_finish(rs2::EndReason::Shutdown);
      return;
    }
    published = g_stream.publisher->last_published();
  } else {
    snapshot.state.frame = publish_frame;
  }
  if (g_live.hub != nullptr) {
    // P3-SP: the hub holds the published snapshot shared (every connection's base is this one
    // object, never a per-connection copy): moved in when there is no file sink, copied once when
    // the publisher keeps its own.
    std::shared_ptr<const rs::Captured> shared;
    if (live_wants) {
      if (g_stream.publisher == nullptr) {
        shared = std::make_shared<const rs::Captured>(std::move(snapshot));
      } else {
        shared = std::make_shared<const rs::Captured>(*published);
      }
      published = shared.get();
    }
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
    g_live.hub->on_frame_shared(frame, monotonic_ns(), shared, publish_epoch, snapshot_ns);
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
  if (rs::shader_clock().draw_hooked) {
    // P3-CK: what the hooked clock summed (render-stream-10.md "Shader time").
    const rs::ShaderClock &clock = rs::shader_clock();
    char total[64];
    std::snprintf(total, sizeof(total), "%.17g", clock.total);
    log_line(std::string("shader-clock: source=") + rs::shader_clock_source() +
             " draws=" + std::to_string(clock.draws) + " ticks=" + std::to_string(clock.ticks) +
             " advanced=" + std::to_string(clock.advanced) + " total=" + total);
  }
  emit("disarm.json", disarm_json());
  emit("counters.json", hooks_counters_json(g_state.frames_total, g_state.frames_armed));
  if (rs::texture_cache().enabled()) {
    emit("texture-cache.json", hooks_texture_cache_json());  // G8kc
  }
  emit_canvas_texture_shim();
  perf_finish();
  emit("result.json", result_json());
}

void on_startup() { attempt("startup"); }

void on_frame() {
  const uint64_t frame_start_ns = monotonic_ns();
  // P3-TM: the host's shader time follows every iteration from the first, armed or not.
  if (!rs::shader_clock_tick() && !g_state.shader_clock_logged) {
    g_state.shader_clock_logged = true;
    log_line("shader-clock: unavailable (" + rs::shader_clock().unavailable + ")");
  }
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
  if (g_state.armed && g_stream.gate8.adopt) {
    // G8m (gate8-design.md Q5): references to pre-arm materials and shaders a hooked call named
    // this iteration resolve now, dated this frame, before the transaction is formed.
    rs::adopt_materials_resolve();
  }
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
  rs::texture_worker_pool().stop();  // G8kw: also when the stream never opened after the pool ran
  live_linger(true);  // a linger still running after a disarm ends here
  do_disarm("shutdown");
  emit("counters.json", hooks_counters_json(g_state.frames_total, g_state.frames_armed));
  if (rs::texture_cache().enabled()) {
    emit("texture-cache.json", hooks_texture_cache_json());  // G8kc
  }
  emit_canvas_texture_shim();
  emit("result.json", result_json());
  log_line("shutdown: frames_total=" + std::to_string(g_state.frames_total) +
           " frames_armed=" + std::to_string(g_state.frames_armed) + " intercepted=" +
           std::to_string(hooks_total_calls()));
}

// GRT3 (results/grt.md "Part 3"): GRC_LOW_PROCESSOR_SLEEP_USEC=<usec> sets
// OS.low_processor_usage_mode_sleep_usec (the project default is 6900). A headless host cannot
// draw, so OS::add_frame_delay sleeps at least that long per frame whatever --max-fps says, which
// caps it near 145 fps; the fast-frame legs set 0 so `--max-fps N` alone paces the host. Unset,
// nothing is called.
void apply_low_processor_sleep() {
  const char *value = std::getenv("GRC_LOW_PROCESSOR_SLEEP_USEC");
  if (value == nullptr || *value == '\0') {
    return;
  }
  uint64_t usec = 0;
  if (!env_non_negative("GRC_LOW_PROCESSOR_SLEEP_USEC", 0, &usec) || usec > 1000000) {
    log_line("init: ignoring an invalid GRC_LOW_PROCESSOR_SLEEP_USEC (0..1000000)");
    return;
  }
  void *os = singleton_object("OS");
  // OS.set_low_processor_usage_mode_sleep_usec(int usec): void (extension_api.json hash).
  GDExtensionMethodBindPtr bind =
      method_bind("OS", "set_low_processor_usage_mode_sleep_usec", 1286410249);
  if (os == nullptr || bind == nullptr || g_iface.object_method_bind_ptrcall == nullptr) {
    log_line("init: GRC_LOW_PROCESSOR_SLEEP_USEC: OS.set_low_processor_usage_mode_sleep_usec "
             "unavailable");
    return;
  }
  const int64_t arg = static_cast<int64_t>(usec);  // ptrcall passes every int as int64
  const GDExtensionConstTypePtr args[1] = {&arg};
  g_iface.object_method_bind_ptrcall(bind, os, args, nullptr);
  log_line("init: low_processor_usage_mode_sleep_usec=" + std::to_string(usec));
}

void initialize(void * /*userdata*/, GDExtensionInitializationLevel level) {
  if (level != GDEXTENSION_INITIALIZATION_SCENE) {
    return;
  }
  apply_low_processor_sleep();
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
  rs::texture_worker_pool().stop();  // G8kw: no worker (or engine Image) outlives the extension
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
