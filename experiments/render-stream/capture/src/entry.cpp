// GDExtension entry point and the arming decision.
//
// Nothing is written into the engine's memory until every check in
// `calib.h` has passed and `GRC_MODE=arm` was asked for. `validate` runs the
// identical checks and writes the identical evidence, but never touches the
// vptr.
//
// With GRC_STREAM_OUT and/or GRC_STREAM_PATCH_OUT set and the library armed,
// it also publishes render-stream/5 recordings (protocol/render-stream-5.md: /4 plus the shader
// and material tables, item material state, canvas modulate and GRP1 shader payloads; /4 added the
// immediate geometry ops, add_set_transform, add_clip_ignore and meshes; /3 the msdf command).
// The shader source policy GRC_SHADER_POLICY (source | params | exclude, default source) is read
// at arm and declared in the session's `materials`: GRC_STREAM_OUT is
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
// The root-size policy GRC_ROOT_SIZE (observe | enforce-min-size;
// presentation:<W>x<H>) is applied at arm
// between the root query and the session record. What it saw and did goes on the wire -- the session's
// `viewport` object and blocks, read after the policy; the session-level
// `degenerate-host-size` entry whenever host_size_status != match; the sticky
// failure `root-size-enforce-failed` when enforce-min-size could not make it
// match -- and, as at G1a, to evidence/root.json
// (render-stream-root-geometry/1).
//
// Live delivery: GRC_LIVE_LISTEN
// (127.0.0.1:<port> or [::1]:<port>; port 0 = ephemeral; with GRC_LIVE_EXPOSE=lan, CAR2,
// Also 0.0.0.0, :: or a host IP, which then requires GRC_LIVE_AUTH=token
// and a non-empty GRC_LIVE_ALLOWED_ORIGINS: expose-invalid, lan-needs-token, lan-needs-origins;
// the exposure is recorded in evidence/live-carriers.json, never in live.json) also enables the
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
// Carriers: the hub's transport is a CarrierSet
// (rs_carrier_set.h) whose `ws` carrier (index 0) is that rs_ws server, so connection ids, logs
// and taps are unchanged. GRC_LIVE_CARRIERS (comma list, default `ws`) names the carriers to
// start (`carriers-invalid` for a malformed list, `carrier-unregistered` for a name neither
// built in nor registered). GRC_LIVE_MAX_CONNECTIONS is a total across carriers (D6).
// evidence/live-carriers.json (render-stream-live-carriers/1) records each carrier at listen, rewrites
// atomically on every connection open or close (CAR8), and again at stop. The per-connection
// `carrier` is a field of each `open` line in the live log, live.jsonl (rs_live.cpp).
//
// Tracks: GRC_LIVE_TRACKS (a comma list of kinds; `/1` builds
// `input`) opens render-stream-track.1 connections on the same listener, admitted from their own
// pool (GRC_LIVE_MAX_TRACKS, 1..16, default 4), each authorized by its kind's credential in
// evidence/live-track-<kind>-token (mode 0600, never the view token). live_drain hands every
// track connection to rs::tracks::TrackHub (rs_tracks.h) before the view Hub sees it; the hub
// never parses a payload. GRC_LIVE_TRACK_RATE (1..10000/s, burst twice it) and
// GRC_LIVE_TRACK_KEEPALIVE_MS (250..30000) tune it; a bad setting refuses live as a whole
// (tracks-invalid, tracks-reserved, tracks-need-evidence-dir, track-*-invalid,
// track-token-write-failed). evidence/live-tracks.json (render-stream-live-tracks/1) is written
// at listen, after any frame that opened or closed a track, and at stop. Unset: nothing changes
// (T3) -- no track subprotocol, no config key, no token file, no live-tracks.json. Sabotages
// (GRC_SABOTAGE, need GRC_LIVE_TRACKS): track-view-token-accepted, track-rate-off,
// track-grant-ignored, track-no-release. TRK2: a script receives a kind through the
// RenderStreamTrack class (rs_tracks_gd.h), whose registry may be bound before the arm and whose
// signals are delivered at the end of each frame callback; with nothing bound every track is
// refused track-no-receiver.
//
// WebTransport: `wt` in GRC_LIVE_CARRIERS loads the net
// module (rs_net_module.h: GRC_LIVE_NET_MODULE, else librender_stream_net.so beside this .so;
// `net-module-missing` / `net-module-abi` when it cannot) and starts carrier `wt` (index 1,
// render-stream-wt/1) on GRC_LIVE_WT_LISTEN (UDP <host>:<port>, same syntax and exposure rule as
// GRC_LIVE_LISTEN, `wt-listen-invalid` when malformed; default GRC_LIVE_LISTEN's host and port).
// GRC_LIVE_WT_CERT=self (default: a generated ECDSA P-256 certificate, 14 days, its SHA-256 in
// evidence/live-cert-sha256) or tls (GRC_LIVE_TLS_CERT/GRC_LIVE_TLS_KEY, PEM paths, both or
// neither; `tls-config-invalid` otherwise). Without `wt` or a pair nothing new is loaded.
//
// wss: GRC_LIVE_TLS_CERT/GRC_LIVE_TLS_KEY also load the net
// module (with or without `wt`) and turn `ws` into ws+wss on its one port: a connection whose
// first byte is a TLS handshake record runs through the module's TLS session (the upgrade and
// every resource GET then are wss/https); plaintext is served only to loopback peers and refused
// from any other (`tls-required`: 403, closed). A pair the module refuses is `tls-config-invalid`.
// evidence/live-carriers.json records `ws` as tls `consumer` with the leaf's cert_sha256.
// GRC_LIVE_LAN_PLAINTEXT=allow (D12, needs GRC_LIVE_EXPOSE=lan; any other non-empty value, or
// `allow` without lan, is `lan-plaintext-invalid`) serves plaintext from LAN peers too, for a
// consumer's plain-http LAN pages beside its https ones; live-carriers.json records `ws`'s
// `lan_plaintext`. Without a pair it changes nothing (nothing is sniffed).
//
// Textures: whenever a stream is enabled,
// texture_2d_create and texture_2d_update copy the Image bytes into a GRT1
// payload and hash it on the calling thread before forwarding, and every
// texture-related call is written to evidence/resources.jsonl
// (render-stream-resource-log/1, rs_resource_log.h), drained at each frame
// callback. GRC_RESOURCE_FORMATS (default L8,LA8,R8,RG8,RGB8,RGBA8) and
// GRC_RESOURCE_MAX_PAYLOAD_BYTES (default 64 MiB) are read at arm; an invalid
// value, or an engine without the Image binds and image_ptr
// (image-access-unavailable), refuses to publish.
//
// Resources (render-stream-2.md):
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
// Live resources:
// every live connection declares the configured policy with fetch
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
// Unknown items: GRC_UNKNOWN_ITEM is `strict` (default, also
// when unset or empty) or `skip`, read at arm with the other stream policies; any other value
// refuses to publish, as an invalid GRC_ROOT_SIZE does. `skip` is a diagnostic opt-in for hosts
// that arm late: the mirror withholds unknown canvas/item RIDs and the subtrees under them instead
// of failing every transaction with `pre-existing-object`, the session declares
// `unknown_item_policy: "skip"`, every transaction carries `unknown_items`, and result.json
// `stream.unknown_items` holds the final counters.
//
// Authorization: GRC_LIVE_AUTH is `none` (default) or `token`, read
// only with GRC_LIVE_LISTEN. `token` generates 32 random bytes as 64 lowercase hex, writes them
// to evidence/live-token (mode 0600, refused as resource-store-missing-equivalent
// `live-token-unwritable` without GRC_EVIDENCE_DIR), declares the session's
// `resources.auth: "bearer"`, and requires it on the WebSocket upgrade and on every resource GET
// (rs_ws.h ServerConfig::auth_token). A rejected upgrade is logged (never the token itself) as an
// AuthRejected event; a rejected GET is an ordinary HttpGet event with http_status 401, already
// covered by the existing hook-log path.
//
// render-stream/7: the listener accepts both
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
// at window 2 and every one after), and coding-wrong-prefix (W11t: needs GRC_STREAM_VERSION=11
// and GRC_LIVE_CODING=zstd-base; from GRC_SABOTAGE_FRAME on, default 1, the first based /11
// transaction is coded against its base plus one byte, render-stream-11.md "As built (W11t)"),
// and predict-stale (W13b: needs GRC_STREAM_VERSION=13; from GRC_SABOTAGE_FRAME on, default 1,
// the first /13 patch is predicted from H2 as if it were H1, render-stream-13.md "Sabotages"),
// and zr-overrun / zr-short-run (W13r: the same, but that patch carries the writer sabotage's
// zero-run tokens instead, render-stream-13.md "As built (W13r)").
// GRC_LIVE_CODING (W11t) = zstd-base (default) | zstd | off: the coding a /11 hello that offers
// `live_coding` gets; nothing below /11 is coded. They act on the listener only, never on a record, so the
// wire declares no sabotage for them (the session's `sabotage` stays null): evidence/live.json
// carries `listener_sabotage` instead.

#include <sys/random.h>
#include <sys/stat.h>
#include <unistd.h>
#include <dirent.h>
#include <sstream>
#include <malloc.h>

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
#include <utility>
#include <unordered_set>
#include <vector>

#include "calib.h"
#include "hooks.h"
#include "iface.h"
#include "report.h"
#include "rs_adopt.h"
#include "rs_canvas_texture_shim.h"
#include "rs_particles_shim.h"
#include "rs_registry.h"
#include "rs_gate8_policy.h"
#include "rs_texture_basis.h"
#include "rs_texture_delivery.h"
#include "rs_histogram.h"
#include "rs_carrier_ext.h"
#include "rs_carrier_gd.h"
#include "rs_capture_gd.h"
#include "rs_carrier_set.h"
#include "rs_net_module.h"
#include "rs_expose.h"
#include "rs_live.h"
#include "rs2_diff.h"
#include "rs_mirror.h"
#include "rs_payload_rest.h"
#include "rs_publish.h"
#include "rs_resource_log.h"
#include "rs_resource_store.h"
#include "rs_root_query.h"
#include "rs_shader_clock.h"
#include "rs_standby.h"
#include "rs_setting.h"
#include "rs_texture_cache.h"
#include "rs_texture_decode.h"
#include "rs_texture_payload.h"
#include "rs_texture_release.h"
#include "rs_item_meta_host.h"
#include "rs_track_caps.h"
#include "rs_tracks.h"
#include "rs_tracks_gd.h"
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
  // LATE-SPINE: GRC_ARM_DEFER_FRAMES=N defers the arm (snapshot/adoption/publish) until the
  // capture has seen N frame callbacks, while the hooks stay installed from extension load. This
  // lets a capture armed late still observe pre-arm resource creation (canvas_texture_create /
  // set_channel, ...), which the adoption path then resolves. 0 (default): arm at load.
  uint64_t defer_arm_frames = 0;
  // LS0: the deferred arm's wait is logged once, not once a frame (an fprintf, an fflush and a
  // write a frame, about 15 us on a standby seat).
  bool defer_logged = false;
  // LS0: GRC_VALIDATION_LOG, read once at SCENE initialisation. A value that is neither `on` nor
  // `off` refuses at the first attempt, before the vtable is patched.
  std::string validation_log_error;
  bool evidence_ready = false;
  // GRC_MODE=standby published the standby table and waits (until
  // LS2's arm()); every arm passes through standby first. GRC_STANDBY_FAULT is the test-only
  // sabotage of the standby table (rs_standby.h).
  bool standby = false;
  bool api_pending_arm = false;
  rs::StandbyFault standby_fault = rs::StandbyFault::None;

  Calibration calib;
  ProcessFingerprint fp;
  LiveVtableFacts facts;
  std::vector<CheckResult> checks;
  ShadowVtable shadow;

  bool decided = false;
  bool shader_clock_logged = false;  // P3-TM: the clock's unavailability is logged once
  bool armed = false;
  bool vptr_written = false;
  // LATE-SPINE: the vtable is patched (hooks installed) before the arm, so resource creation is
  // observed during a deferred arm's pre-arm frames; the arm itself (adoption/snapshot/publish)
  // is what GRC_ARM_DEFER_FRAMES defers.
  bool hooks_patched = false;
  // LS0: the vtable was restored at shutdown or deinitialize although the capture never armed.
  std::string unarmed_restore_phase;
  bool unarmed_restore_restored = false;
  // LS3: a disarm that published the standby table restores the engine's at shutdown.
  std::string standby_restore_phase;
  std::string disarm_table;
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
  // (rs_canvas_texture_shim.h).
  // HSD: unset or `auto` takes the headless default (rs::headless_defaults_apply), and the
  // resolved value lands here; `ct_shim_env_set` is then "reported" (asked for, or defaulted on),
  // `headless_defaults` whether the defaults applied to this host and stream.
  std::string ct_shim_env;
  bool ct_shim_env_set = false;
  bool ct_shim_defaulted = false;
  bool headless_defaults = false;
  rs::CanvasTextureShimMode ct_shim_mode = rs::CanvasTextureShimMode::Off;
  std::string ct_shim_state = "off";
  std::string ct_shim_reason;

  // HTR (rs_texture_release.h): GRC_HEADLESS_TEXTURE_RELEASE as given (`htr_env_set`: the variable
  // is set, so result.json and evidence/headless-texture-release.json report it), the decision
  // ("off", "active", "ignored" with `htr_reason`, or "refused" for an invalid value) and the
  // GRC_HEADLESS_TEXTURE_RELEASE_FAULT knob.
  std::string htr_env;
  bool htr_env_set = false;
  rs::TextureReleaseMode htr_mode = rs::TextureReleaseMode::Off;
  rs::TextureReleaseFault htr_fault = rs::TextureReleaseFault::None;
  std::string htr_state = "off";
  std::string htr_reason;

  // PM5 (render-stream-12.md "Headless shims (opt-in)"): GRC_HEADLESS_PARTICLES and
  // GRC_PREDRAW_PUMP as given, parsed, and the pump's counters.
  std::string pt_shim_env;
  std::string pump_env;
  rs::ParticlesShimMode pt_shim_mode = rs::ParticlesShimMode::Off;
  bool pump = false;
  bool pump_connected = false;
  uint64_t pump_fired = 0;
  uint64_t pump_skipped = 0;
};

// The render-stream/2 file publication (G1b2, G2b2). `status` is result.json
// `stream.status`: off | open | closed | refused | open-failed.
struct Stream {
  uint64_t arm_t0_ns = 0;
  std::string path;        // GRC_STREAM_OUT (full sink); empty when unset
  std::string patch_path;  // GRC_STREAM_PATCH_OUT (patch sink); empty when unset
  std::string status = "off";
  std::string reason;  // empty -> null
  // GRC_UNKNOWN_ITEM, read at arm.
  rs2::UnknownItemPolicy unknown_item_policy = rs2::UnknownItemPolicy::Strict;
  // GRC_SHADER_POLICY, read at arm (source | params | exclude).
  rs2::ShaderPolicy shader_policy = rs2::ShaderPolicy::Source;
  // GRC_STREAM_VERSION, GRC_ADOPT, GRC_TEXTURE_DECODE and the float-format
  // request, read at arm; and what the adoption seam reported (G8w: nothing).
  rs::Gate8Policy gate8;
  // W11b (render-stream-11.md): GRC_MESH_DYNAMIC*, read at arm; used at /11 only.
  rs2::MeshDynamicPolicy mesh_dynamic;
  rs::AdoptStats adopt_stats;
  // G8r: GRC_ADOPT_FAULT (lazy resource adoption's fault knob), read at arm.
  rs::AdoptFault adopt_fault = rs::AdoptFault::None;
  // GRC_TEXTURE_WORKERS and its knobs, read at arm,
  // and the publication hold-back that waits for the workers' hashes (unused when sync).
  rs::TextureWorkerConfig workers;
  rs::RestConfig rest;  // TDR: the at-rest coding (rs_payload_rest.h)
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
  // GRC_FREEZE_PARTICLES, read at arm. Empty/unset/off/0 = off (the
  // pure stream, byte-identical to today); on/1 marks the seat particle-frozen. It changes nothing
  // on the wire: it is recorded in host evidence (result.json) and gates the two FRZ-P sabotages.
  bool freeze_particles = false;
};

Stream g_stream;

// How long the host waits for receivers to close after their end record (rs_live.h, finish).
constexpr uint64_t kLiveLingerNs = 1500ull * 1000ull * 1000ull;

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
  // wss on `ws`, from the net module, when GRC_LIVE_TLS_CERT/KEY are
  // set. Declared before `carriers`, whose `ws` server holds a pointer to it.
  std::unique_ptr<live::NetTlsContext> tls;
  bool lan_plaintext = false;  // D12: GRC_LIVE_LAN_PLAINTEXT=allow (plaintext from LAN peers too)
  rs2::ServingSummary serving;  // every GET the server answered, for the summary
  // CAR1: the hub's transport; carrier `ws` (index 0) is the rs_ws server, `ws` points at it.
  std::unique_ptr<live::CarrierSet> carriers;
  live::WsCarrier *ws = nullptr;
  // CAR3: carrier `wt` (index 1) when GRC_LIVE_CARRIERS lists it, from the net module.
  bool wt_enabled = false;
  // CAR6: `ws` runs only when GRC_LIVE_CARRIERS lists it (the default list is `ws`).
  bool ws_enabled = true;
  // CAR6 (rs_carrier_ext.h): the consumer carriers registered before the arm, handed over when the
  // registry closed at the arm; the listed ones are moved into the set, the rest destroyed.
  std::vector<live::RegisteredCarrier> registered;
  const grc_net_module_table_v1 *net_module = nullptr;
  std::string wt_listen;  // GRC_LIVE_WT_LISTEN as given ("" = GRC_LIVE_LISTEN's host and port)
  std::string wt_cert = "self";
  std::string tls_cert;
  std::string tls_key;
  std::unique_ptr<rs2::Hub> hub;
  // the track grant and its hub, built only when GRC_LIVE_TRACKS
  // grants a kind (null otherwise: live_drain's one extra null test). Declared after `carriers`,
  // whose set it sends through, so it is destroyed first.
  rs::tracks::TrackConfig track_config;
  uint64_t max_tracks = 0;
  std::unique_ptr<rs::tracks::TrackHub> tracks;
  // After the end records went out: wait (bounded) for the receivers to close first
  // (rs2::Hub::finish).
  bool ending = false;
  bool stopped = false;
  uint64_t linger_ns = kLiveLingerNs;
  bool close_async = false;
  bool closing = false;
  uint64_t linger_deadline_ns = 0;
  // G7n (live.json): GRC_LIVE_ALLOWED_ORIGINS as parsed, GRC_LIVE_CREDIT_WINDOW_MAX, and the
  // listener sabotage (no-cors | accept-any-origin | token-ignored | window-overrun; empty when
  // none).
  std::vector<std::string> allowed_origins;
  // GRC_LIVE_EXPOSE. Recorded in live-carriers.json only.
  live::Expose expose = live::Expose::Loopback;
  uint64_t credit_window_max = 2;
  std::string listener_sabotage;
  std::string live_coding = "zstd-base";  // W11t: GRC_LIVE_CODING (what /11 hellos may get)
  // G8kz: GRC_HTTP_ENCODING (default zstd): the codings the host offers on resource GETs.
  std::vector<live::Coding> http_codings;
  bool http_coding_on = false;
};

// Item identity: GRC_ITEM_META's grant (0:
// nobody gets identities), the file sinks' request (GRC_ITEM_META_FILE*: off unless set), the
// hub's union counter last seen, and the main thread's identity host. The frame callback tests
// `grant` (one branch when off), then `on` (no viewer and no file asked: nothing per item).
struct ItemMetaState {
  bool configured = false;
  bool config_ok = true;
  std::string config_error;
  uint32_t grant = 0;
  uint64_t budget_us = 2000;
  uint64_t sweep = 64;  // ID3: GRC_ITEM_META_SWEEP
  std::string sabotage;
  rs::item_meta::Request file;  // the file sinks' grant (empty: no records in recordings)
  uint64_t hub_version = ~uint64_t{0};
  bool on = false;
  rs::item_meta::Host host;
};
ItemMetaState g_meta;

// LS3 (live-swap-design.md Q3): the per-load facts a re-arm needs, the test-only knobs, and what a
// GRC_REARM_FAULT sabotage keeps alive on purpose. Arm 1 writes where a capture always did; arm
// k >= 2 writes its evidence under GRC_EVIDENCE_DIR/arm-<k>/ and its recordings (and resource
// store) as <path>.arm-<k>, so a re-arm never overwrites what an earlier arm wrote.
struct Rearm {
  std::string evidence_root;
  std::string stream_out;
  std::string patch_out;
  uint64_t arm_index = 0;  // the arm in progress, or the last one (1-based)
  std::string fault;       // GRC_REARM_FAULT
  bool trim = false;       // GRC_TEST_TRIM_AT_DISARM=1: malloc_trim(0) before `disarmed`
  // The root Window's min_size: the value before this arm's write, and the write itself.
  uint64_t window_id = 0;
  bool min_recorded = false;
  bool min_written = false;
  int32_t min_before[2] = {0, 0};
  int32_t min_set[2] = {0, 0};
  std::string min_restore = "none";  // none | restored | changed | unreadable | skipped
  // Kept alive by a sabotage (never in a product run); released at shutdown.
  std::vector<std::unique_ptr<rs::ServedResources>> kept_served;
  std::vector<std::unique_ptr<live::NetTlsContext>> kept_tls;
  std::vector<std::unique_ptr<live::CarrierSet>> kept_carriers;
  std::vector<std::unique_ptr<rs2::Hub>> kept_hubs;
  // The last release's accounting (evidence/arm-<k>/teardown.json and swap-cycle.jsonl).
  std::string accounting;
};
Rearm g_rearm;

bool rearm_fault(const char *kind) { return g_rearm.fault == kind; }

// GRC_SWAP_CYCLE=<armed>:<idle>:<n>[:control] (test only, D2): n cycles of an arm, <armed> armed
// frames, a disarm and <idle> idle frames, driven through the same RenderStreamCapture calls a
// consumer makes. A standby capture starts with an idle phase (phase 0, the pure-standby baseline).
// `control` never arms but samples at the same frames, for a paired standby-only run.
struct SwapCycle {
  bool on = false;
  bool control = false;
  uint64_t armed = 0;
  uint64_t idle = 0;
  uint64_t cycles = 0;
  uint64_t done = 0;           // disarms completed
  uint64_t phase_frame = 0;    // frames_total when the current phase began
  bool idle_phase = true;
  bool requested = false;      // an arm or disarm was asked for and has not landed yet
  int64_t phase_cpu_ns = 0;    // the main thread's CPU at the phase start
  uint64_t phase_callback_ns = 0;
  uint64_t phase_callbacks = 0;
};
SwapCycle g_swap;

std::vector<std::string> comma_names(const std::string &text) {
  std::vector<std::string> out;
  std::size_t start = 0;
  while (!text.empty() && start <= text.size()) {
    std::size_t comma = text.find(',', start);
    if (comma == std::string::npos) {
      comma = text.size();
    }
    out.push_back(text.substr(start, comma - start));
    start = comma + 1;
  }
  return out;
}


// GRC_HTTP_ENCODING = off | zstd | gzip, default zstd (the
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
         text == "window-overrun" || text == "corrupt-coded-body" ||
         text == "coding-wrong-prefix" || text == "predict-stale" || text == "zr-overrun" ||
         text == "zr-short-run" || text == "track-view-token-accepted" || text == "track-rate-off" ||
         text == "track-grant-ignored" || text == "track-no-release" ||
         text == "track-inject-no-release";
}

// W13b/W13r: the listener sabotages that code one /13 patch wrongly.
bool is_predict_sabotage(const std::string &kind) {
  return kind == "predict-stale" || kind == "zr-overrun" || kind == "zr-short-run";
}

// the largest inline threshold a live host accepts.
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

// Perf instrumentation: evidence/perf.json
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
  // GRC_PERF_TIMELINE_MAX_BYTES: 0 (unset) = unbounded, the gate default. Otherwise the timeline
  // rotates: perf-timeline.jsonl holds at most max/2 bytes, and when it fills it becomes
  // perf-timeline.jsonl.1 (replacing the previous one), so the pair stays near max (a file overshoots its half by at most one line).
  uint64_t timeline_max_bytes = 0;
  uint64_t timeline_bytes = 0;
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

// GRC_ROOT_SIZE, read at arm.
using rs2::RootSizePolicy;

// GRC_SHADER_POLICY, read at arm: unset or empty is `source`.
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

// GRC_UNKNOWN_ITEM, read at arm.
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

// GRC_FREEZE_PARTICLES, read at arm. off/0/empty (default) = off;
// on/1 = the seat is particle-frozen. Any other value refuses.
bool parse_freeze_particles(const char *value, bool *out) {
  if (value == nullptr || std::strcmp(value, "") == 0 || std::strcmp(value, "off") == 0 ||
      std::strcmp(value, "0") == 0) {
    *out = false;
    return true;
  }
  if (std::strcmp(value, "on") == 0 || std::strcmp(value, "1") == 0) {
    *out = true;
    return true;
  }
  return false;
}

// `presentation` receives W x H for presentation:<W>x<H> (decimal, 1..16384 each)
// and is left untouched otherwise.
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

// 32 random bytes as 64 lowercase hex characters, via
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

// LS3: a load-lifetime evidence file (result.json, counters.json, capture-api.json, ...), always
// at GRC_EVIDENCE_DIR itself; emit() writes into the current arm's directory.
void emit_load(const std::string &name, const std::string &text) {
  if (g_state.evidence_ready) {
    const std::string path = path_join(g_rearm.evidence_root, name);
    if (!write_file(path, text)) {
      log_line("could not write " + path);
    }
    return;
  }
  log_line("evidence " + name + " " + text);
}

// LAR0: evidence/registry.json, beside counters.json, when GRC_ADOPT=arm configured the registry
// (registry-off included: it reports `enabled: false`). GRC_ADOPT=off, or no evidence directory,
// writes nothing (its timeline is no stdout line).
void emit_registry() {
  if (g_state.evidence_ready && rs::registry_stats().configured) {
    emit_load("registry.json", rs::registry_json());
  }
}

// HTR: the `headless_texture_release` object (result.json and its evidence file).
void htr_fields(JsonWriter *json) {
  const rs::ReleaseStats st = rs::texture_release_stats();
  json->object_begin();
  json->field("env", g_state.htr_env);
  json->field("state", g_state.htr_state);
  json->field_or_null("reason", g_state.htr_reason);
  json->field("display_server", g_state.display_server);
  json->field("fault", std::string(rs::texture_release_fault_name(g_state.htr_fault)));
  json->field("released", st.released);
  json->field("released_bytes", st.released_bytes);
  json->field("released_then_unheld", st.released_then_unheld);
  json->field("kept_adopted", st.kept_adopted);
  json->field("kept_adopted_bytes", st.kept_adopted_bytes);
  json->key("skipped").object_begin();
  json->field("inactive", st.skipped_inactive);
  json->field("refused", st.skipped_refused);
  json->field("format", st.skipped_format);
  json->field("omitted", st.skipped_omitted);
  json->object_end();
  json->field("release_ns_total", st.release_ns_total);
  json->field("release_ns_max", st.release_ns_max);
  // Every create while the variable is set (off included): the hook's own time, the forward out.
  json->key("timed").object_begin();
  json->field("creates", st.timed_creates);
  json->field("hook_ns_total", st.hook_ns_total);
  json->field("hook_ns_max", st.hook_ns_max);
  json->field("forward_ns_total", st.forward_ns_total);
  json->object_end();
  json->object_end();
}

void emit_headless_texture_release();

std::string result_json() {
  JsonWriter json;
  json.object_begin();
  json.field("schema", std::string("render-stream-capture-result/1"));
  json.field("status", g_state.status);
  json.field_or_null("reason", g_state.reason);
  json.field("vptr_written", g_state.vptr_written);
  json.field("disarmed", g_state.disarmed);
  json.field_or_null("unarmed_restore", g_state.unarmed_restore_phase);  // LS0
  json.field_or_null("standby_restore", g_state.standby_restore_phase);  // LS3
  if (g_state.shadow.built()) {
    // the two tables and which one the singleton carries now.
    const ShadowVtable::Table t = g_state.shadow.published();
    json.key("vtable").object_begin();
    json.field("published", std::string(t == ShadowVtable::Table::Armed     ? "armed"
                                        : t == ShadowVtable::Table::Standby ? "standby"
                                                                            : "engine"));
    json.field("armed_slots", static_cast<int64_t>(g_state.shadow.armed_slots()));
    json.field("standby_slots", static_cast<int64_t>(g_state.shadow.standby_slots()));
    json.field("standby_fault", std::string(rs::standby_fault_name(g_state.standby_fault)));
    json.key("standby_hooks").array_begin();
    for (size_t i = 0; i < g_state.plan.replacements.size(); ++i) {
      if (g_state.plan.replacements[i].standby) {
        json.string(g_state.plan.planned[i]);
      }
    }
    json.array_end();
    json.object_end();
  }
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
  // Additive: the policy, and under skip the mirror's counters.
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
  // Additive: present only when a /8 sink or a gate 8 policy is in play,
  // so every run without them keeps its result.json unchanged.
  if (g_stream.gate8.speaks_v8()) {
    json.key("gate8").object_begin();
    json.field("file_stream_version", static_cast<int64_t>(
                   g_stream.gate8.speaks_v14()   ? 14
                   : g_stream.gate8.speaks_v13() ? 13
                   : g_stream.gate8.speaks_v12() ? 12
                   : g_stream.gate8.speaks_v11() ? 11
                   : g_stream.gate8.speaks_v10()
                       ? 10
                       : g_stream.gate8.speaks_v9()
                       ? 9
                       : (g_stream.gate8.file_version == rs2::ProtocolVersion::V8 ? 8 : 6)));
    if (g_stream.gate8.speaks_v10()) {
      // LAR7: where the carried shader clock began (rs_shader_clock.h). Evidence only: the wire
      // carries the clock's total per transaction and nothing about its origin.
      const rs::ShaderClock &clock = rs::shader_clock();
      json.key("shader_clock").object_begin();
      json.field("source", std::string(rs::shader_clock_source()));
      json.field("origin", std::string(rs::shader_clock_origin()));
      json.field("first_tick_process_frames", clock.start_process_frames);
      json.field("first_tick_frames_drawn", clock.start_drawn);
      json.field("draws_missed", rs::shader_clock_draws_missed());
      json.field("ticks", static_cast<int64_t>(clock.ticks));
      json.field("draws", static_cast<int64_t>(clock.draws));
      json.object_end();
    }
    if (g_stream.gate8.speaks_v11()) {
      // W11b (render-stream-11.md "Capture policy"): additive, /11 streams only.
      const rs::MirrorStats ms = rs::mirror_stats();
      json.key("mesh_dynamic").object_begin();
      json.field("mode", std::string(rs2::to_wire(g_stream.mesh_dynamic.mode)));
      json.field("frames", static_cast<int64_t>(g_stream.mesh_dynamic.frames));
      json.field("max_bytes", static_cast<int64_t>(g_stream.mesh_dynamic.max_bytes));
      json.field("meshes_dynamic", static_cast<int64_t>(ms.meshes_dynamic));
      json.field("promotions", static_cast<int64_t>(ms.mesh_promotions));
      json.field("content_changes", static_cast<int64_t>(ms.mesh_content_changes));
      json.object_end();
      // content_version digests made and identical re-records kept.
      json.key("content_version").object_begin();
      json.field("digests", static_cast<int64_t>(ms.cv_digests));
      json.field("rerecords_kept", static_cast<int64_t>(ms.cv_rerecords_kept));
      json.object_end();
      if (rs::mirror_instance().multimesh_options().enabled) {
        // PM1 (render-stream-11.md "As built (PM1)"): additive, /11 with the multimesh hooks only.
        json.key("multimesh").object_begin();
        json.field("live", static_cast<int64_t>(ms.live_multimeshes));
        json.field("unknown", static_cast<int64_t>(ms.multimesh_unknown));
        json.field("rejected", static_cast<int64_t>(ms.multimesh_rejected));
        json.field("unchanged", static_cast<int64_t>(ms.multimesh_unchanged));
        json.object_end();
      }
      if (rs::mirror_instance().particles_options().enabled) {
        // PM5 (render-stream-12.md "Hook log and counters"): additive, /12 with the hooks only.
        const rs::PpmStats ppm = rs::adopt_particles_stats();
        json.key("particles").object_begin();
        json.field("live", static_cast<int64_t>(ms.live_particles));
        json.field("unknown", static_cast<int64_t>(ms.particles_unknown));
        json.field("builtin_resolved", static_cast<int64_t>(ppm.builtin_resolved));
        json.field("builtin_unresolved", static_cast<int64_t>(ppm.builtin_unresolved));
        json.field("unknown_shader_keyed", static_cast<int64_t>(ppm.unknown_shader_keyed));
        // LAR4: the process-material queue (rs_mirror.h take_ppm_candidates).
        json.field("unknown_shader_registered", static_cast<int64_t>(ppm.unknown_shader_registered));
        json.field("ppm_drains", static_cast<int64_t>(ppm.drains));
        json.field("ppm_scans", static_cast<int64_t>(rs::mirror_instance().ppm_scans()));
        json.field("unknown_material_keyed", static_cast<int64_t>(ppm.unknown_material_keyed));
        json.field("pump_fired", static_cast<int64_t>(g_state.pump_fired));
        json.field("pump_skipped", static_cast<int64_t>(g_state.pump_skipped));
        json.field("shim_synthesized", static_cast<int64_t>(rs::particles_shim().synthesized()));
        json.field("shim_engine_allocated",
                   static_cast<int64_t>(rs::particles_shim().engine_allocated()));
        // additive, written only under GRC_FREEZE_PARTICLES=on, so a
        // live leg reads the grant from host evidence (the wire carries nothing about it).
        if (g_stream.freeze_particles) {
          json.field("frozen", true);
        }
        if (g_stream.gate8.adopt) {
          // PM7 (render-stream-12.md "As built (PM7)"): pre-arm emitters, under GRC_ADOPT=arm.
          const rs::EmitterAdoptStats e = rs::adopt_emitter_stats();
          json.key("adoption").object_begin();
          json.field("emitters", static_cast<int64_t>(e.emitters));
          json.field("refused", static_cast<int64_t>(e.refused));
          // LAR5 (F1): an emitter the registry does not hold (older than the hooks).
          json.field("refused_preload_particles",
                     static_cast<int64_t>(e.refused_preload_particles));
          json.field("meshes", static_cast<int64_t>(e.meshes));
          json.field("ppm_materials", static_cast<int64_t>(e.ppm_materials));
          json.field("ppm_registry", static_cast<int64_t>(e.ppm_registry));
          json.field("ppm_shaders", static_cast<int64_t>(e.ppm_shaders));
          json.field("ppm_params", static_cast<int64_t>(e.ppm_params));
          json.field("ppm_refused", static_cast<int64_t>(e.ppm_refused));
          json.field("ppm_refused_no_shader", static_cast<int64_t>(e.ppm_refused_no_shader));
          json.field("ppm_builtin", static_cast<int64_t>(e.ppm_builtin));
          json.field("ppm_refused_material", static_cast<int64_t>(e.ppm_refused_material));
          json.field("other_materials", static_cast<int64_t>(e.other_materials));
          json.field("subemitters", static_cast<int64_t>(e.subemitters));
          json.field("adopt_ns", static_cast<int64_t>(e.adopt_ns));
          json.object_end();
        }
        json.object_end();
      }
    }
    if (g_stream.gate8.speaks_v9()) {
      json.field("texture_delivery", rs::texture_delivery_policy().mode);
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
      if (std::find(g_state.plan.planned.begin(), g_state.plan.planned.end(),
                    "canvas_item_set_use_identity_transform") != g_state.plan.planned.end()) {
        // UIT (render-stream-11.md "As built (UIT)"): additive, where the hook is planned only.
        json.field("identity_transforms", static_cast<int64_t>(a.identity_transforms));
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
      // LAR6 (resolve-queue-only): the mirror scans the frame drains made (material refs + ppm).
      json.field("resolve_scans", static_cast<int64_t>(rs::adopt_resolve_scans()));
      json.key("resources").object_begin();
      json.field("textures", static_cast<int64_t>(r.textures));
      json.field("textures_reload", static_cast<int64_t>(r.textures_reload));
      json.field("textures_current", static_cast<int64_t>(r.textures_current));
      json.field("textures_creation", static_cast<int64_t>(r.textures_creation));
      json.field("textures_canvas", static_cast<int64_t>(r.textures_canvas));
      json.field("canvas_registry", static_cast<int64_t>(r.canvas_registry));
      json.field("canvas_residual", static_cast<int64_t>(r.canvas_residual));
      json.field("atlas_pages", static_cast<int64_t>(r.atlas_pages));
      json.field("compressed", static_cast<int64_t>(r.compressed));
      json.field("from_update", static_cast<int64_t>(r.from_update));
      json.field("decoded", static_cast<int64_t>(r.decoded));
      json.field("textures_registry", static_cast<int64_t>(r.textures_registry));  // LAR6
      json.field("textures_refused", static_cast<int64_t>(r.textures_refused));
      json.field("refused_no_image", static_cast<int64_t>(r.refused_no_image));
      json.field("refused_canvas_empty", static_cast<int64_t>(r.refused_canvas_empty));
      json.field("meshes", static_cast<int64_t>(r.meshes));
      json.field("mesh_surfaces", static_cast<int64_t>(r.mesh_surfaces));
      json.field("meshes_refused", static_cast<int64_t>(r.meshes_refused));
      json.field("multimeshes", static_cast<int64_t>(r.multimeshes));
      json.field("multimeshes_refused", static_cast<int64_t>(r.multimeshes_refused));
      json.field("refused_preload_multimesh", static_cast<int64_t>(r.refused_preload_multimesh));
      json.field("refused_mm_edited_dummy", static_cast<int64_t>(r.refused_mm_edited_dummy));
      json.field("refused_mm_buffer", static_cast<int64_t>(r.refused_mm_buffer));
      // LAR6: the off-main queue and the one refused map.
      json.field("offmain_queued", static_cast<int64_t>(r.offmain_queued));
      json.field("offmain_drained", static_cast<int64_t>(r.offmain_drained));
      json.field("offmain_adopted", static_cast<int64_t>(r.offmain_adopted));
      json.field("offmain_dropped", static_cast<int64_t>(r.offmain_dropped));
      json.field("refused_live", static_cast<int64_t>(r.refused_live));
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
      json.field("materials_registry", static_cast<int64_t>(ms.materials_registry));  // LAR3
      json.field("shader_materials", static_cast<int64_t>(ms.shader_materials));
      json.field("canvas_item_materials", static_cast<int64_t>(ms.canvas_item_materials));
      json.field("at_arm", static_cast<int64_t>(ms.at_arm));
      json.field("materials_refused", static_cast<int64_t>(ms.materials_refused));
      json.field("shaders", static_cast<int64_t>(ms.shaders));
      json.field("shaders_registry", static_cast<int64_t>(ms.shaders_registry));  // LAR3
      json.field("shaders_builtin", static_cast<int64_t>(ms.shaders_builtin));
      json.field("shaders_include_refused", static_cast<int64_t>(ms.shaders_include_refused));
      json.field("shaders_lazy", static_cast<int64_t>(ms.shaders_lazy));
      json.field("shaders_refused", static_cast<int64_t>(ms.shaders_refused));
      json.field("params", static_cast<int64_t>(ms.params));
      json.field("default_textures", static_cast<int64_t>(ms.default_textures));
      json.field("instance_params", static_cast<int64_t>(ms.instance_params));
      json.field("resolve_passes", static_cast<int64_t>(ms.resolve_passes));
      json.field("pending_refs", static_cast<int64_t>(ms.pending_refs));  // LAR3
      json.field("nodes_added", static_cast<int64_t>(ms.nodes_added));
      json.field("items_adopted", static_cast<int64_t>(ms.items_adopted));
      json.field("node_map_connected", ms.node_map_connected);
      json.field("arm_ns", static_cast<int64_t>(ms.arm_ns));
      json.field("resolve_ns", static_cast<int64_t>(ms.resolve_ns));
      json.object_end();
    }
    json.object_end();
    // The decode seam's totals since arm (per-texture
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
    // HSD: true when the variable was unset (or `auto`) and the headless default armed it
    json.field("default", g_state.ct_shim_defaulted);
    json.field("state", g_state.ct_shim_state);
    json.field_or_null("reason", g_state.ct_shim_reason);
    json.field("synthesized", static_cast<int64_t>(rs::canvas_texture_shim().synthesized()));
    json.object_end();
  }
  // Additive (HTR): present only when GRC_HEADLESS_TEXTURE_RELEASE is set.
  if (g_state.htr_env_set) {
    json.key("headless_texture_release");
    htr_fields(&json);
  }
  json.object_end();
  return json.take();
}

// evidence/headless-texture-release.json (HTR): written with the arm decision, so the product can
// assert the state before any texture streams, and again with counters.json; only when
// GRC_HEADLESS_TEXTURE_RELEASE is set.
void emit_headless_texture_release() {
  if (g_state.htr_env_set) {
    JsonWriter json;
    htr_fields(&json);
    emit_load("headless-texture-release.json", json.take());
  }
}

// evidence/canvas-texture-shim.json, written with the arm decision and with counters.json, only
// when the opt-in is set.
void emit_canvas_texture_shim() {
  if (g_state.ct_shim_env_set) {
    emit_load("canvas-texture-shim.json",
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
  // LS3: the table the disarm published (standby while the registry records, so a re-arm adopts
  // what it saw; the engine's otherwise).
  json.field("table", g_state.disarm_table);
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

namespace cap = rs::capture;
std::unique_ptr<cap::Api> g_api;
std::thread::id g_api_main;
std::string g_api_fault;
struct ApiArmInfo {
  std::string session_id, token, root_size;
  int stream_version = 0;
  uint64_t frame = 0;
  double ms = 0;
  uint64_t published = 0;
} g_api_arm;
// LS3: the disarm's steps, advanced once a frame callback (api_teardown_advance).
enum class TeardownStep { Idle, Workers, Encoders, Finish, Sinks, Linger, Release };
struct ApiTeardown {
  // The threads only join (or drain a queue they own): the texture pool, then the encode pool, on
  // `pool`; the file sinks' end records, the store's index and the writer on `sinks`; ws/wt on
  // `carriers`. The hub, consumer carriers, signals and gd queues stay on the main thread.
  cap::TeardownThread pool, sinks, carriers;
  TeardownStep step = TeardownStep::Idle;
  bool active = false;
  bool pool_pending = false;
  bool encoders_pending = false;
  std::size_t encoders_dropped = 0;
  bool sinks_pending = false;
  bool carrier_pending = false;
  bool evidence_done = false;
  uint64_t inflight_wait_start_ns = 0, inflight_wait_frames = 0;
  int inflight_max = 0;
  bool inflight_wait_timeout = false;
  uint64_t first_frame = 0, last_frame = 0, callbacks = 0, max_callback_us = 0;
  struct Callback { uint64_t frame, us; std::string phase; };
  std::vector<Callback> top;
  std::string callback_phase;
} g_api_teardown;
void api_evidence();
void live_close_async_begin();

cap::Value::Object api_arm_info() {
  const auto &a = g_stream.adopt_stats;
  std::string cert;
  if (g_live.carriers && g_live.carriers->started(live::kCarrierWt)) {
    cert = g_live.carriers->carrier(live::kCarrierWt)->info().cert_sha256;
  }
  return {{"arm_index", std::int64_t(g_api->arm_count())}, {"session_id", g_api_arm.session_id},
      {"listen", g_live.port > 0 ? g_live.address + ":" + std::to_string(g_live.port) : ""},
      {"token", g_api_arm.token}, {"wt_cert_hash", cert}, {"root_size", g_api_arm.root_size},
      {"stream_version", g_api_arm.stream_version}, {"arm_ms", g_api_arm.ms},
      {"arm_frame", std::int64_t(g_api_arm.frame)},
      {"adopted", cap::Value::Object{{"canvases", std::int64_t(a.canvases)},
          {"layers", std::int64_t(a.layers)}, {"items", std::int64_t(a.items)},
          {"materials", std::int64_t(a.materials)}, {"lights", std::int64_t(a.lights)}}}};
}

void decide(const std::string &status, const std::string &reason) {
  if (g_api) {
    if (status == "standby") g_api->loaded(cap::State::Standby, reason);
    else if (status == "refused") g_api->loaded(cap::State::Refused, reason);
    else if (status == "armed") g_api->loaded(cap::State::Armed, reason);
  }
  g_state.status = status;
  g_state.reason = reason;
  g_state.decided = true;
  emit_load("calibration-check.json", calibration_check_json());
  emit_load("fingerprint.json", fingerprint_json());
  emit_load("result.json", result_json());
  log_line("decision: " + status + (reason.empty() ? "" : " (" + reason + ")") +
           " vptr_written=" + (g_state.vptr_written ? "true" : "false"));
}

void refuse(const std::string &reason) { decide("refused", reason); }

uint64_t monotonic_ns() {
  return static_cast<uint64_t>(std::chrono::duration_cast<std::chrono::nanoseconds>(
                                   std::chrono::steady_clock::now().time_since_epoch())
                                   .count());
}

// --- perf instrumentation --------------------------

// At arm: starts the clocks perf.json's deltas and perf-timeline.jsonl's seconds are measured
// against.
void perf_arm() {
  g_perf.arm_ns = monotonic_ns();
  g_perf.last_frame_ns = 0;
  g_perf.timeline_last_second = -1;
  g_perf.main_thread_cpu_start_ok =
      clock_gettime(CLOCK_THREAD_CPUTIME_ID, &g_perf.main_thread_cpu_start) == 0;
}

bool env_non_negative(const char *name, uint64_t fallback, uint64_t *out);  // defined below

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
    g_perf.timeline_bytes = 0;
    if (!env_non_negative("GRC_PERF_TIMELINE_MAX_BYTES", 0, &g_perf.timeline_max_bytes)) {
      g_perf.timeline_max_bytes = 0;  // malformed: stay unbounded rather than fail a stream
    }
  }
  if (g_perf.timeline_max_bytes > 0 && g_perf.timeline_bytes >= g_perf.timeline_max_bytes / 2) {
    std::fclose(g_perf.timeline_file);
    std::rename(g_perf.timeline_path.c_str(), (g_perf.timeline_path + ".1").c_str());
    g_perf.timeline_file = std::fopen(g_perf.timeline_path.c_str(), "w");
    g_perf.timeline_bytes = 0;
    if (g_perf.timeline_file == nullptr) {
      log_line("perf: cannot reopen " + g_perf.timeline_path);
      return;
    }
  }
  // A compact one-line-per-record JSON builder: JsonWriter pretty-prints across several lines,
  // which would break the jsonl contract (one JSON object per line), so this stays a plain
  // string build, as rs_live.cpp's own per-connection log lines do.
  //
  // mirror_stats()'s live table sizes and the
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
  g_perf.timeline_bytes += line.size() + 1;
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

// evidence/root.json (render-stream-root-geometry/1).
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
  // Additive: the root's default canvas-item texture
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
// to open). Since HC1 the log formats no line while no file is open, so that drain is empty; it
// stays as the one place the buffer is emptied (counters.json and the mirror read from the hooks
// directly, not from this file, Q3d).
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
  // HC1: no open file means nobody reads the lines (resources_drain() discards them): the log
  // keeps its registries but formats nothing.
  rs::resource_log().start(monotonic_ns(), root_viewport_rid, g_stream.resources_file != nullptr);
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

// GRC_LIVE_LISTEN: "127.0.0.1:<port>" or "[::1]:<port>"; with
// GRC_LIVE_EXPOSE=lan also "0.0.0.0", "::" or a host IP literal.
// Returns false with *reason "non-loopback" for any other host, or a description of the
// malformation. The rule itself is rs_expose.cpp's, shared with rs_live_host.
bool parse_listen(const std::string &text, live::Expose expose, const char *var, std::string *host,
                  uint16_t *port, std::string *reason) {
  return live::parse_listen_address(text, expose, var, host, port, reason);
}

// A positive decimal environment value, or `fallback` when unset. False when
// set and malformed.
bool env_positive(const char *name, uint64_t fallback, uint64_t *out) {
  const char *value = rs::setting(name);
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

// GRC_ITEM_META (the grant), GRC_ITEM_META_BUDGET_US (default 2000 per frame),
// GRC_ITEM_META_SABOTAGE (in-shared | skip-full | id-off-by-one: formation; before-ready:
// resolution) and the file sinks' request GRC_ITEM_META_FILE (fields, comma list),
// GRC_ITEM_META_FILE_GROUPS and GRC_ITEM_META_FILE_KEYS (names, comma lists). Read once, at arm.
void item_meta_configure() {
  if (g_meta.configured) {
    return;
  }
  g_meta.configured = true;
  std::string why;
  const std::string sabotage = env_string("GRC_ITEM_META_SABOTAGE");
  if (!rs::item_meta::parse_grant_env(env_string("GRC_ITEM_META"), &g_meta.grant, &why)) {
    g_meta.config_ok = false;
  } else if (!env_positive("GRC_ITEM_META_BUDGET_US", 2000, &g_meta.budget_us)) {
    g_meta.config_ok = false;
    why = "GRC_ITEM_META_BUDGET_US is not a positive number of microseconds";
  } else if (!env_non_negative("GRC_ITEM_META_SWEEP", 64, &g_meta.sweep)) {
    // Controls whose mouse_filter is re-read a frame.
    g_meta.config_ok = false;
    why = "GRC_ITEM_META_SWEEP is not a non-negative number of Controls";
  } else if (!sabotage.empty() && sabotage != "in-shared" && sabotage != "skip-full" &&
             sabotage != "id-off-by-one" && sabotage != "before-ready" &&
             sabotage != "restamp-skip" && sabotage != "raw-filter" &&
             sabotage != "instance-of-root" && sabotage != "leak-connections" &&
             sabotage != "v2-at-13" && sabotage != "no-reentry") {
    g_meta.config_ok = false;
    why = "GRC_ITEM_META_SABOTAGE \"" + sabotage +
          "\" is not in-shared, skip-full, id-off-by-one, before-ready, restamp-skip, raw-filter, "
          "instance-of-root, leak-connections, v2-at-13 or no-reentry";
  }
  rs::item_meta::Request file;
  file.fields = comma_names(env_string("GRC_ITEM_META_FILE"));
  file.groups = comma_names(env_string("GRC_ITEM_META_FILE_GROUPS"));
  file.meta_keys = comma_names(env_string("GRC_ITEM_META_FILE_KEYS"));
  if (g_meta.config_ok && !file.empty()) {
    // ID3: a /14 file sink may record the v2 fields (render-stream-14.md); a /13 one may not.
    const std::string problem = rs::item_meta::request_problem(file, g_stream.gate8.speaks_v14());
    if (!problem.empty()) {
      g_meta.config_ok = false;
      why = "GRC_ITEM_META_FILE: " + problem;
    } else {
      g_meta.file = rs::item_meta::grant_for(g_meta.grant, file);
    }
  }
  if (!g_meta.config_ok) {
    g_meta.config_error = why;
    g_meta.grant = 0;
    g_meta.file = rs::item_meta::Request();
    log_line("item_meta: refused (" + why + ")");
    return;
  }
  g_meta.sabotage = sabotage;
  rs::tag_set_no_reentry(sabotage == "no-reentry");
  g_meta.host.configure(g_meta.budget_us, sabotage == "before-ready");
  rs::item_meta::Host::V2Options v2;
  v2.sweep = g_meta.sweep;
  v2.restamp_skip = sabotage == "restamp-skip";
  v2.raw_filter = sabotage == "raw-filter";
  v2.instance_of_root = sabotage == "instance-of-root";
  v2.leak_connections = sabotage == "leak-connections";
  g_meta.host.configure_v2(v2);
  const std::string log_path = env_string("GRC_ITEM_META_LOG");
  if (g_meta.grant != 0 && !log_path.empty()) {
    std::FILE *log = std::fopen(log_path.c_str(), "w");  // closed at exit (a test knob)
    if (log == nullptr) {
      log_line("item_meta: cannot open GRC_ITEM_META_LOG " + log_path);
    }
    g_meta.host.set_log(log);
  }
  if (g_meta.grant != 0) {
    log_line("item_meta: grant " + rs::item_meta::grant_env_string(g_meta.grant) +
             " budget_us " + std::to_string(g_meta.budget_us) +
             ((g_meta.grant & rs::item_meta::kMouseFilter) != 0
                  ? " sweep " + std::to_string(g_meta.sweep)
                  : std::string()) +
             (g_meta.file.empty() ? std::string()
                                  : " file " + rs::item_meta::grant_json(g_meta.file)) +
             (sabotage.empty() ? std::string() : " (sabotage " + sabotage + ")"));
  }
}

// A non-negative decimal environment value, or `fallback` when unset. False
// when set and malformed.
bool env_non_negative(const char *name, uint64_t fallback, uint64_t *out) {
  const char *value = rs::setting(name);
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
  json.key("allowed_origins").array_begin();
  for (const std::string &origin : g_live.allowed_origins) {
    json.string(origin);
  }
  json.array_end();
  json.field("credit_window_max", static_cast<int64_t>(g_live.credit_window_max));
  json.field_or_null("listener_sabotage", g_live.listener_sabotage);
  json.field("live_coding", g_live.live_coding);  // W11t: GRC_LIVE_CODING as parsed
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

// GRC_LIVE_CARRIERS, default `ws`; `wt` loads
// the net module and reads GRC_LIVE_WT_LISTEN, GRC_LIVE_WT_CERT and GRC_LIVE_TLS_CERT/KEY (and,
// for ws, GRC_LIVE_LAN_PLAINTEXT); any other name must be a consumer carrier registered before
// the arm (g_live.registered), else it is `carrier-unregistered`; *why is the refusal. `ws` starts
// only when listed (CAR6).
bool live_carriers_ok(std::string *why) {
  std::vector<std::string> names;
  if (!live::parse_carrier_list(std::getenv("GRC_LIVE_CARRIERS"), &names, why)) {
    return false;
  }
  g_live.wt_enabled = false;
  g_live.ws_enabled = false;
  for (const std::string &name : names) {
    if (name == "ws") {
      g_live.ws_enabled = true;
      continue;
    }
    if (name == "wt") {
      g_live.wt_enabled = true;
      continue;
    }
    // CAR6: a consumer carrier registered before the arm (rs_carrier_ext.h).
    bool registered = false;
    for (const live::RegisteredCarrier &r : g_live.registered) registered |= r.name == name;
    if (registered) {
      continue;
    }
    *why = "carrier-unregistered: GRC_LIVE_CARRIERS lists " + name +
           ", which is neither built in nor registered before the capture armed";
    return false;
  }
  // D11: the consumer's pair, both or neither. It makes `ws` serve wss too (CAR4, D12) and, with
  // GRC_LIVE_WT_CERT=tls, is `wt`'s certificate.
  g_live.tls_cert = env_string("GRC_LIVE_TLS_CERT");
  g_live.tls_key = env_string("GRC_LIVE_TLS_KEY");
  if (g_live.tls_cert.empty() != g_live.tls_key.empty()) {
    *why = "tls-config-invalid: GRC_LIVE_TLS_CERT and GRC_LIVE_TLS_KEY go together";
    return false;
  }
  // D12: whether `ws` also serves plaintext to LAN peers beside wss (rs_expose.h).
  if (!live::parse_lan_plaintext(std::getenv("GRC_LIVE_LAN_PLAINTEXT"), g_live.expose,
                                 &g_live.lan_plaintext, why)) {
    return false;
  }
  const std::string wt_cert = env_string("GRC_LIVE_WT_CERT");
  g_live.wt_cert = wt_cert.empty() ? "self" : wt_cert;
  if (g_live.wt_cert != "self" && g_live.wt_cert != "tls") {
    *why = "tls-config-invalid: GRC_LIVE_WT_CERT must be self or tls (got " + wt_cert + ")";
    return false;
  }
  if (g_live.wt_cert == "tls" && g_live.tls_cert.empty()) {
    *why = "tls-config-invalid: GRC_LIVE_WT_CERT=tls needs GRC_LIVE_TLS_CERT and GRC_LIVE_TLS_KEY";
    return false;
  }
  if (!g_live.tls_cert.empty()) {
    // D8, D12: a pair loads the net module even without `wt`; its TLS session serves wss on ws.
    const grc_net_tls_table_v1 *tls = live::load_net_tls(std::getenv("GRC_LIVE_NET_MODULE"), why);
    if (tls == nullptr) {
      return false;
    }
    g_live.tls = live::NetTlsContext::create(tls, g_live.tls_cert, g_live.tls_key, why);
    if (g_live.tls == nullptr) {
      return false;
    }
  }
  if (!g_live.wt_enabled) {
    return true;
  }
  // D9: same syntax and loopback rule as GRC_LIVE_LISTEN.
  g_live.wt_listen = env_string("GRC_LIVE_WT_LISTEN");
  if (!g_live.wt_listen.empty()) {
    std::string host;
    uint16_t port = 0;
    std::string reason;
    if (!parse_listen(g_live.wt_listen, g_live.expose, "GRC_LIVE_WT_LISTEN", &host, &port, &reason)) {
      *why = reason == "non-loopback"
                 ? std::string("non-loopback")
                 : "wt-listen-invalid: GRC_LIVE_WT_LISTEN=" + g_live.wt_listen + " (" + reason + ")";
      return false;
    }
  }
  // D8: loaded only now that `wt` is listed; never unloaded.
  g_live.net_module = live::load_net_module(std::getenv("GRC_LIVE_NET_MODULE"), why);
  return g_live.net_module != nullptr;
}

// evidence/live-carriers.json, beside live.json, whose shape it
// leaves alone. Written at listen (or a failed start) and again at stop; never to the log.
void emit_live_carriers() {
  if (g_state.evidence_ready && g_live.carriers != nullptr) {
    emit("live-carriers.json", g_live.carriers->carriers_json());
  }
}

// CAR8: the same file, rewritten atomically (temp file, then rename) so a reader never sees a
// torn document. live_drain calls it from the frame callback after any connection open or close,
// so a seat that dies keeps the counts as of its last connection change.
void refresh_live_carriers() {
  if (!g_state.evidence_ready || g_live.carriers == nullptr) return;
  const std::string path = path_join(g_state.evidence_dir, "live-carriers.json");
  const std::string tmp = path + ".tmp";
  if (!write_file(tmp, g_live.carriers->carriers_json()) || std::rename(tmp.c_str(), path.c_str()) != 0) {
    log_line("could not refresh " + path);
  }
}

// evidence/live-tracks.json, only with tracks on; written at listen,
// atomically after any frame that opened or closed a track, and at stop.
void refresh_live_tracks() {
  if (!g_state.evidence_ready || g_live.tracks == nullptr || g_live.carriers == nullptr) return;
  rs::tracks::TrackHub::Extras extras;
  extras.max_tracks = static_cast<std::size_t>(g_live.max_tracks);
  extras.admitted_max = g_live.carriers->admitted_tracks_max();
  for (unsigned i = 0; i < 256; ++i) {
    const auto index = static_cast<std::uint8_t>(i);
    live::Carrier *c = g_live.carriers->carrier(index);
    if (c == nullptr) continue;
    rs::tracks::CarrierTracks ct;
    ct.name = c->name();
    // ws serves tracks; wt when started and its module sets GRC_NET_FEATURE_TRACKS (TRK3);
    // a consumer carrier cannot be judged.
    if (index == live::kCarrierWs) {
      ct.tracks = g_live.carriers->started(index);
    } else if (index == live::kCarrierWt) {
      ct.tracks = g_live.carriers->started(index) && live::net_module_serves_tracks(g_live.net_module);
    }
    extras.carriers.push_back(std::move(ct));
  }
  const std::string path = path_join(g_state.evidence_dir, "live-tracks.json");
  const std::string tmp = path + ".tmp";
  if (!write_file(tmp, g_live.tracks->json(extras)) || std::rename(tmp.c_str(), path.c_str()) != 0) {
    log_line("could not refresh " + path);
  }
}

// GRC_LIVE_TRACKS and its knobs into g_live.track_config. True with
// tracks off (the pure path) or a valid grant; false with *why the typed refusal.
bool tracks_configure(std::string *why) {
  g_live.track_config = rs::tracks::TrackConfig();
  g_live.max_tracks = 0;
  if (!rs::tracks::parse_kinds(std::getenv("GRC_LIVE_TRACKS"), &g_live.track_config.kinds, why)) {
    return false;
  }
  const bool on = !g_live.track_config.kinds.empty();
  rs::tracks::Sabotage sabotage = rs::tracks::Sabotage::None;
  const bool track_sabotage = rs::tracks::parse_sabotage(g_live.listener_sabotage, &sabotage);
  const std::string inject = env_string("GRC_LIVE_TRACK_INPUT_INJECT");
  const bool input_granted = [] {
    for (const std::string &k : g_live.track_config.kinds) {
      if (k == rs::tracks::kKindInput) return true;
    }
    return false;
  }();
  if (!on) {
    if (track_sabotage) {
      *why = "sabotage " + g_live.listener_sabotage + " needs GRC_LIVE_TRACKS";
      return false;
    }
    // TRK6: a built-in injector asked for with no grant refuses rather than serving without it.
    if (!inject.empty() || !env_string("GRC_LIVE_TRACK_INPUT_CONFIG").empty()) {
      *why = "track-inject-invalid: GRC_LIVE_TRACK_INPUT_INJECT / GRC_LIVE_TRACK_INPUT_CONFIG need "
             "input in GRC_LIVE_TRACKS";
      return false;
    }
    return true;
  }
  const auto ranged = [why](const char *name, uint64_t def, uint64_t lo, uint64_t hi, uint64_t *out,
                            const char *reason) {
    if (!env_positive(name, def, out) || *out < lo || *out > hi) {
      *why = std::string(reason) + ": " + name + " (a decimal integer " + std::to_string(lo) + ".." +
             std::to_string(hi) + ")";
      return false;
    }
    return true;
  };
  uint64_t rate = 0;
  uint64_t keepalive = 0;
  if (!ranged("GRC_LIVE_MAX_TRACKS", 4, 1, 16, &g_live.max_tracks, "track-max-invalid") ||
      !ranged("GRC_LIVE_TRACK_RATE", 1000, 1, 10000, &rate, "track-rate-invalid") ||
      !ranged("GRC_LIVE_TRACK_KEEPALIVE_MS", 1000, 250, 30000, &keepalive, "track-keepalive-invalid")) {
    return false;
  }
  // TRK6 (Q6, Q8): GRC_LIVE_TRACK_INPUT_INJECT=reference makes the capture the `input` receiver.
  // The embedded injector is compiled and configured here, so a bad config refuses live whole.
  const std::string inject_config = env_string("GRC_LIVE_TRACK_INPUT_CONFIG");
  if (!inject.empty() && inject != "reference") {
    *why = "track-inject-invalid: GRC_LIVE_TRACK_INPUT_INJECT=" + inject + " (reference, or unset)";
    return false;
  }
  if (!inject.empty() && !input_granted) {
    *why = "track-inject-invalid: GRC_LIVE_TRACK_INPUT_INJECT=reference needs input in GRC_LIVE_TRACKS";
    return false;
  }
  if (inject.empty() && !inject_config.empty()) {
    *why = "track-inject-config-invalid: GRC_LIVE_TRACK_INPUT_CONFIG needs "
           "GRC_LIVE_TRACK_INPUT_INJECT=reference";
    return false;
  }
  if (inject.empty() && rs::tracks::sabotage_needs_inject(sabotage)) {
    *why = "sabotage " + g_live.listener_sabotage + " needs GRC_LIVE_TRACK_INPUT_INJECT=reference";
    return false;
  }
  // TRK5 (Q2, rs_track_caps.h): per-viewer HMAC capabilities instead of the shared credential.
  const std::string caps = env_string("GRC_LIVE_TRACK_CAPS");
  if (!caps.empty() && caps != "hmac") {
    *why = "track-caps-invalid: GRC_LIVE_TRACK_CAPS=" + caps;
    return false;
  }
  if (rs::tracks::sabotage_needs_caps(sabotage) && caps != "hmac") {
    *why = "sabotage " + g_live.listener_sabotage + " needs GRC_LIVE_TRACK_CAPS=hmac";
    return false;
  }
  if (!g_state.evidence_ready) {
    *why = "tracks-need-evidence-dir";
    return false;
  }
  if (!inject.empty()) {
    if (!live::gd_tracks_builtin_prepare(inject_config, sabotage == rs::tracks::Sabotage::InjectNoRelease,
                                         why)) {
      return false;
    }
    g_live.track_config.inject_mode = inject;
    g_live.track_config.inject_addon_sha256 = live::gd_tracks_builtin_addon_sha256();
  }
  g_live.track_config.rate_per_s = static_cast<uint32_t>(rate);
  g_live.track_config.burst = static_cast<uint32_t>(rate * 2);
  g_live.track_config.keepalive_ms = static_cast<uint32_t>(keepalive);
  g_live.track_config.sabotage = sabotage;
  g_live.track_config.caps = caps == "hmac" ? rs::tracks::CapsMode::Hmac : rs::tracks::CapsMode::Shared;
  return true;
}

// one credential per granted kind, after every live and track
// setting passed and after the view token, never equal to it, mode 0600. TRK5: with
// GRC_LIVE_TRACK_CAPS=hmac one key, evidence/live-track-cap-key (64 lowercase hex, never equal to
// the view token), instead. The other mode's files are removed, so a consumer that finds a file
// finds the mode this run serves.
bool tracks_write_credentials(const std::string &view_token, std::string *why) {
  const std::string key_path = path_join(g_state.evidence_dir, "live-track-cap-key");
  if (g_live.track_config.caps == rs::tracks::CapsMode::Hmac) {
    std::string key;
    for (int attempt = 0; attempt < 4 && (key.empty() || rs::tracks::caps::key_to_hex(key) == view_token);
         ++attempt) {
      key = rs::tracks::caps::generate_key();
    }
    if (key.empty() || rs::tracks::caps::key_to_hex(key) == view_token ||
        !rs::tracks::write_secret_file(key_path, rs::tracks::caps::key_to_hex(key))) {
      *why = "track-token-write-failed: " + key_path;
      return false;
    }
    for (const std::string &kind : g_live.track_config.kinds) {
      ::unlink(path_join(g_state.evidence_dir, "live-track-" + kind + "-token").c_str());
    }
    g_live.track_config.cap_key = key;
    g_live.track_config.view_token = view_token;
    return true;
  }
  ::unlink(key_path.c_str());
  for (const std::string &kind : g_live.track_config.kinds) {
    std::string credential;
    for (int attempt = 0; attempt < 4 && (credential.empty() || credential == view_token); ++attempt) {
      credential = rs::tracks::generate_credential();
    }
    const std::string path = path_join(g_state.evidence_dir, "live-track-" + kind + "-token");
    if (credential.empty() || credential == view_token ||
        !rs::tracks::write_secret_file(path, credential)) {
      *why = "track-token-write-failed: " + path;
      return false;
    }
    g_live.track_config.credentials[kind] = credential;
  }
  g_live.track_config.view_token = view_token;
  return true;
}

// HC4a test knob: GRC_HC_SHADOW=1, read at stream start (the shadow oracle).
bool g_hc_shadow = false;
// HC4b: the first budget or serving shadow-oracle difference (GRC_HC_SHADOW=1).
std::string g_hc_shadow_budget;

// At arm, right after the vptr store: validates the sabotage environment,
// opens the recordings, enables the mirror, runs the root query and the
// root-size policy, and writes the session records. A refusal or an open
// failure leaves the mirror off and publishes nothing; arming itself is
// unaffected.
// CAR6 (rs_carrier_ext.h): destroys every registered consumer carrier the set did not take.
void ext_carriers_drop_unstarted() {
  for (live::RegisteredCarrier &r : g_live.registered) {
    log_line("live: carrier " + r.name + " (index " + std::to_string(r.index) +
             ") registered but not started (GRC_LIVE_CARRIERS does not list it, or live is off)");
    r.vtable.destroy(r.vtable.self);
  }
  g_live.registered.clear();
}

// LS3: the root Window's min_size before this arm writes it (GRC_ROOT_SIZE=enforce-min-size or
// presentation:), and the value it writes, so the disarm can put it back.
void rearm_record_min_size(void *window, const int32_t set[2]) {
  if (g_root_finalized) return;
  g_rearm.window_id = window != nullptr && g_iface.object_get_instance_id != nullptr
                          ? g_iface.object_get_instance_id(window) : 0;
  g_rearm.min_recorded = rs::root_get_min_size(window, g_rearm.min_before);
  g_rearm.min_written = true;
  g_rearm.min_set[0] = set[0];
  g_rearm.min_set[1] = set[1];
}

void stream_start() {
  g_stream.arm_t0_ns = monotonic_ns();
  // registration closes at the arm, whatever the
  // stream and live do next; a later grc_carrier_register returns -1 (`carrier-late`). Whatever
  // the set does not take is destroyed when this returns.
  g_live.registered = live::carrier_registry().close();
  struct DropUnstarted {
    ~DropUnstarted() { ext_carriers_drop_unstarted(); }
  } drop_unstarted;
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
  const char *root_size = rs::setting("GRC_ROOT_SIZE");
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
  // GRC_STREAM_VERSION, GRC_ADOPT, GRC_TEXTURE_DECODE and a float format
  // in GRC_RESOURCE_FORMATS. A gate 8 policy needs /8, so a file sink that is not /8 refuses.
  {
    rs::Gate8Policy gate8;
    std::string error;
    const bool parsed = rs::parse_gate8_policy(
        std::getenv("GRC_STREAM_VERSION"), std::getenv("GRC_ADOPT"),
        std::getenv("GRC_TEXTURE_DECODE"), std::getenv("GRC_RESOURCE_FORMATS"), &gate8, &error);
    gate8.v8_sabotage = parsed && sabotage.ok && rs::sabotage_needs_v8(sabotage.config.kind);
    gate8.apply_decode_default();  // TDE (F3): after every field that makes the stream speak /8
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
    // GRC_FREEZE_PARTICLES marks the seat particle-frozen. Read at arm;
    // off (the default) changes nothing, on is recorded in host evidence and gates the FRZ-P
    // sabotages. It never alters the wire (a frozen emitter still sends its config + events).
    if (!parse_freeze_particles(std::getenv("GRC_FREEZE_PARTICLES"), &g_stream.freeze_particles)) {
      const std::string error = std::string("invalid GRC_FREEZE_PARTICLES=") +
                                std::getenv("GRC_FREEZE_PARTICLES") + " (expected off or on)";
      log_line("stream: refused particle freeze (" + error + ")");
      g_stream.status = "refused";
      g_stream.reason = error;
      if (!g_live.listen.empty()) {
        live_decided("refused", "stream refused: " + error);
      }
      return;
    }
    // W11b (render-stream-11.md "Opt-in and version policy"): the dynamic-mesh classification
    // policy, declared by a /11 session only and ignored below it (so never refused there).
    rs2::MeshDynamicPolicy mesh_dynamic;
    if (gate8.speaks_v11() &&
        !rs::parse_mesh_dynamic_policy(std::getenv("GRC_MESH_DYNAMIC"),
                                       std::getenv("GRC_MESH_DYNAMIC_FRAMES"),
                                       std::getenv("GRC_MESH_DYNAMIC_MAX_BYTES"), &mesh_dynamic,
                                       &error)) {
      log_line("stream: refused mesh dynamic policy (" + error + ")");
      g_stream.status = "refused";
      g_stream.reason = error;
      if (!g_live.listen.empty()) {
        live_decided("refused", "stream refused: " + error);
      }
      return;
    }
    g_stream.mesh_dynamic = mesh_dynamic;
    // GRC_TEXTURE_DELIVERY, declared by a /9 session only; at
    // every other version the decoded payload is all there is, so it changes nothing there.
    rs::DeliveryPolicy delivery;
    if (!rs::parse_delivery_policy(rs::setting("GRC_TEXTURE_DELIVERY"), &delivery, &error)) {
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
  // GRC_TEXTURE_WORKERS, valid at every version (the
  // hold-back changes when a frame is published, never what a transaction says).
  {
    rs::TextureWorkerConfig workers;
    std::string error;
    bool workers_ok = rs::parse_texture_workers(
        std::getenv("GRC_TEXTURE_WORKERS"), std::getenv("GRC_TEXTURE_WORKER_MIN_BYTES"),
        std::getenv("GRC_TEXTURE_WORKER_DELAY_MS"), std::getenv("GRC_TEXTURE_WORKER_FAULT"), &workers,
        &error, rs::setting("GRC_TEXTURE_PENDING"));
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
  // GRT1 texture bodies are coded at rest with the host's HTTP
  // coding, GRC_HTTP_ENCODING (zstd by default, gzip, or off: nothing coded), where each is built
  // (rs_payload_rest.h). GRC_AT_REST_FAULT=keep-identity is served-at-rest's sabotage. Set here,
  // before any hook (or adoption) builds a body; never while no stream is armed.
  {
    std::vector<live::Coding> codings;
    std::string error;
    rs::RestConfig rest;
    bool rest_ok = parse_http_encoding(std::getenv("GRC_HTTP_ENCODING"), &codings, &error) &&
                   rs::parse_rest_fault(std::getenv("GRC_AT_REST_FAULT"), &rest.keep_identity,
                                        &error);
    if (rest_ok && rest.keep_identity && codings.empty()) {
      error = "GRC_AT_REST_FAULT=keep-identity needs GRC_HTTP_ENCODING=zstd or gzip";
      rest_ok = false;
    }
    if (!rest_ok) {
      log_line("stream: refused at-rest coding (" + error + ")");
      g_stream.status = "refused";
      g_stream.reason = error;
      if (!g_live.listen.empty()) {
        live_decided("refused", "stream refused: " + error);
      }
      return;
    }
    rest.coding = codings.empty() ? rs::RestCoding::Identity
                                  : static_cast<rs::RestCoding>(codings.front());
    rs::reset_rest_stats();
    rs::set_rest_main_thread();
    rs::set_rest_config(rest);
    g_stream.rest = rest;
    log_line(std::string("stream: at_rest=") + rs::rest_coding_token(rest.coding) +
             (rest.keep_identity ? " fault=keep-identity" : ""));
  }
  // GRC_TEXTURE_CACHE_DIR and GRC_TEXTURE_CACHE_MAX_BYTES,
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
  // the mirror's caps are configuration. No wire change: a cap that is
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
  // adoption reads the scene tree, so it runs on the main thread only
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
  // presentation:<W>x<H> under stretch `disabled` with W x H other
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
  // The resource policy and the payload copy capability.
  // A stream never runs with texture copies it cannot
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
      if (!g_stream.store_dir.empty() && g_rearm.arm_index >= 2) {
        g_stream.store_dir += ".arm-" + std::to_string(g_rearm.arm_index);  // LS3
      }
      const bool delivery_inline = inline_max_bytes >= max_payload_bytes;
      if (!g_stream.store_dir.empty() && g_stream.store_dir[0] != '/') {
        error = "GRC_RESOURCE_STORE_DIR must be absolute";
      } else if (files && !delivery_inline && g_stream.store_dir.empty()) {
        // A recording whose payloads have nowhere to go.
        error = "resource-store-missing";
      }
    }
    if (error.empty() && g_stream.gate8.speaks_v12() &&
        env_string("GRC_RESOURCE_FORMATS").empty()) {
      // PM5 (render-stream-12.md "Curve textures"): /12's default policy also permits the four
      // float formats for textures at most 4 rows high; nothing changes below /12, and an
      // explicit GRC_RESOURCE_FORMATS is honoured as written.
      rs::enable_short_float_formats(&formats);
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
  // Live configuration, decided before anything is opened.
  std::string live_host;
  uint16_t live_port = 0;
  rs2::LiveConfig live_config;
  // GRC_LIVE_MAX_CONNECTIONS (D13, G6r): the admission limit, since CAR1 a total across every
  // carrier (the CarrierSet's counter); the Hub itself already tracks every
  // connection independently.
  uint64_t live_max_connections = 1;
  // G2e: empty/None unless GRC_LIVE_AUTH=token successfully generates and writes one below.
  std::string live_auth_token;
  rs2::Auth live_auth = rs2::Auth::None;
  bool live_ok = sabotage.ok && !g_live.listen.empty();
  if (g_live.listen.empty() && !env_string("GRC_LIVE_TRACKS").empty()) {
    log_line("live: GRC_LIVE_TRACKS ignored (no GRC_LIVE_LISTEN)");  // TRK1 (Q8), like every GRC_LIVE_*
  }
  if (live_ok) {
    std::string why;
    const char *tap = std::getenv("GRC_LIVE_TAP_DIR");
    live_config.tap_dir = tap != nullptr ? std::string(tap) : std::string();
    if (!live_config.tap_dir.empty() && g_rearm.arm_index >= 2) {
      live_config.tap_dir = path_join(live_config.tap_dir,
                                      "arm-" + std::to_string(g_rearm.arm_index));
    }
    const std::string auth_mode = env_string("GRC_LIVE_AUTH");
    if (!live::parse_expose(std::getenv("GRC_LIVE_EXPOSE"), &g_live.expose, &why)) {
      // expose-invalid.
      live_ok = false;
    } else if (!parse_listen(g_live.listen, g_live.expose, "GRC_LIVE_LISTEN", &live_host, &live_port,
                             &why)) {
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
      // Inline records over live share the credit window with the
      // transaction, so the threshold is capped at 1 MiB; bigger payloads go over HTTP.
      live_ok = false;
      why = "GRC_RESOURCE_INLINE_MAX_BYTES above " + std::to_string(kLiveInlineMaxBytes) +
            " with GRC_LIVE_LISTEN (inline over live is capped at 1 MiB)";
    } else if (!auth_mode.empty() && auth_mode != "none" && auth_mode != "token") {
      live_ok = false;
      why = "GRC_LIVE_AUTH must be none or token (got " + auth_mode + ")";
    } else if (!live::parse_allowed_origins(env_string("GRC_LIVE_ALLOWED_ORIGINS"),
                                            &g_live.allowed_origins, &why)) {
      // an allowlist entry that is not an exact origin refuses.
      live_ok = false;
      why = "origin-config-invalid: GRC_LIVE_ALLOWED_ORIGINS " + why;
    } else if (!live::check_expose(g_live.expose, auth_mode == "token", g_live.allowed_origins.size(),
                                   &why)) {
      // CAR2: lan-needs-token, lan-needs-origins.
      live_ok = false;
    } else if (!live_carriers_ok(&why)) {
      // only `ws` is built in; `wt` loads from the net module and registered carriers from the registry.
      live_ok = false;
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
    } else if (!rs::live_coding::parse_env(rs::setting("GRC_LIVE_CODING"),
                                           &live_config.live_coding, &why)) {
      // W11t (render-stream-11.md "As built (W11t)"): the /11 live coding, default zstd-base.
      live_ok = false;
    } else if (g_live.listener_sabotage == "coding-wrong-prefix" &&
               (live_config.live_coding != rs::live_coding::Coding::ZstdBase ||
                !g_stream.gate8.speaks_v11())) {
      live_ok = false;
      why = "sabotage coding-wrong-prefix needs GRC_STREAM_VERSION=11 and GRC_LIVE_CODING=zstd-base";
    } else if (g_live.listener_sabotage == "coding-wrong-prefix" &&
               !env_positive("GRC_SABOTAGE_FRAME", 1, &live_config.coding_wrong_prefix_frame)) {
      live_ok = false;
      why = "sabotage coding-wrong-prefix: invalid GRC_SABOTAGE_FRAME (a positive frame)";
    } else if (is_predict_sabotage(g_live.listener_sabotage) && !g_stream.gate8.speaks_v13()) {
      live_ok = false;
      why = "sabotage " + g_live.listener_sabotage + " needs GRC_STREAM_VERSION=13";
    } else if (is_predict_sabotage(g_live.listener_sabotage) &&
               !env_positive("GRC_SABOTAGE_FRAME", 1, &live_config.predict_stale_frame)) {
      live_ok = false;
      why = "sabotage " + g_live.listener_sabotage +
            ": invalid GRC_SABOTAGE_FRAME (a positive frame)";
    } else if ((item_meta_configure(), !g_meta.config_ok)) {
      // the operator's grant, empty by default.
      live_ok = false;
      why = g_meta.config_error;
    } else if (!tracks_configure(&why)) {
      // the track checks, after every other live check.
      live_ok = false;
    }
    live_config.item_meta_grant = g_meta.grant;
    live_config.predict_zr = g_live.listener_sabotage == "zr-overrun"     ? rs13::ZrSabotage::Overrun
                             : g_live.listener_sabotage == "zr-short-run" ? rs13::ZrSabotage::ShortRun
                                                                          : rs13::ZrSabotage::None;
    live_config.item_meta_sabotage = g_meta.sabotage;
    // the hub's formation jobs run on one encode thread; the test
    // knob GRC_HC_FORMATION=inline runs them on the frame callback's thread instead (the wire is
    // byte-identical either way). GRC_HC_SABOTAGE=reorder: every job sends its transaction before
    // its resource records (receivers refuse the stream with resource-missing).
    {
      const char *formation = std::getenv("GRC_HC_FORMATION");
      live_config.formation = formation != nullptr && std::string(formation) == "inline"
                                  ? rs2::Formation::Inline
                                  : rs2::Formation::Thread;
      live_config.formation_wait = false;
      const char *hc = std::getenv("GRC_HC_SABOTAGE");
      live_config.reorder_frame = hc != nullptr && std::string(hc) == "reorder" ? 1 : 0;
      log_line(std::string("live: formation ") +
               (live_config.formation == rs2::Formation::Thread ? "thread" : "inline") +
               (live_config.reorder_frame != 0 ? " (sabotage reorder)" : ""));
    }
    g_live.credit_window_max = live_config.credit_window_max;
    g_live.live_coding = rs::live_coding::to_token(live_config.live_coding);
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
    if (live_ok && !g_live.track_config.kinds.empty() &&
        !tracks_write_credentials(live_auth_token, &why)) {
      live_ok = false;
    }
    if (!live_ok) {
      g_live.track_config = rs::tracks::TrackConfig();
      live::gd_tracks_builtin_discard();  // TRK6: a prepared injector with no stream to serve
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
    } else if (rs::sabotage_needs_v12(kind) && !g_stream.gate8.speaks_v12()) {
      // PM5 (render-stream-12.md "Sabotages"): declared by a /12 session only.
      why = std::string(rs2::to_wire(kind)) + " acts on render-stream/12; set GRC_STREAM_VERSION=12";
    } else if ((kind == rs2::SabotageKind::FreezeDropEvents ||
                kind == rs2::SabotageKind::FreezeSendPositions) &&
               !g_stream.freeze_particles) {
      // they act on a particle-frozen seat only.
      why = std::string(rs2::to_wire(kind)) +
            " acts on a particle-frozen seat; set GRC_FREEZE_PARTICLES=on";
    } else if (rs::sabotage_needs_v11(kind) && !g_stream.gate8.speaks_v11()) {
      // W11b (render-stream-11.md "Sabotage kinds"): declared by a /11 session only.
      why = std::string(rs2::to_wire(kind)) + " acts on render-stream/11; set GRC_STREAM_VERSION=11";
    } else if (kind == rs2::SabotageKind::PerturbDecode && !g_stream.gate8.decode_engine) {
      // it perturbs host-decoded payloads only.
      why = "perturb-decode acts on host-decoded textures; set GRC_TEXTURE_DECODE=engine";    } else if (kind == rs2::SabotageKind::SizeBeforeAdopt &&
               (!g_stream.gate8.adopt || policy != RootSizePolicy::Presentation)) {
      // it reorders the late presentation against adoption.
      why = "size-before-adopt orders the presentation size against adoption; set GRC_ADOPT=arm "
            "and GRC_ROOT_SIZE=presentation:<W>x<H>";
    } else if ((kind == rs2::SabotageKind::AdoptSkipState ||
                kind == rs2::SabotageKind::AdoptNoRedraw ||
                kind == rs2::SabotageKind::AdoptSkipLayers) &&
               !g_stream.gate8.adopt) {
      // they act on the arm-time adoption walk.
      why = std::string(rs2::to_wire(kind)) + " acts on the adoption walk; set GRC_ADOPT=arm";
    } else if ((kind == rs2::SabotageKind::AdoptRawShaderCode ||
                kind == rs2::SabotageKind::AdoptSkipParams) &&
               !g_stream.gate8.adopt) {
      // they act on adopted shaders and materials.
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
    } else if (kind == rs2::SabotageKind::KeepCarried) {
      live_config.keep_carried = true;  // W11b: the publisher reads its own sabotage config
    } else if (kind == rs2::SabotageKind::PerturbInstance) {
      live_config.perturb_instance_frame = sabotage.config.frame;  // PM1 (the publisher's own too)
    } else if (kind == rs2::SabotageKind::PerturbSeed) {
      live_config.perturb_seed_frame = sabotage.config.frame;  // PM5 (the publisher's own too)
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
  // The capture speaks render-stream/6 (render-stream-6.md). The mirror stamps its snapshots V6 to match.
  // /8 only when a file sink asked for it (GRC_STREAM_VERSION=8) or a
  // gate 8 policy needs it; /6 otherwise, and every /2-/7 byte stays as it was.
  // G8k9: GRC_STREAM_VERSION=9 selects /9 (render-stream-9.md); the seam declares the delivery mode.
  // CG1: GRC_STREAM_VERSION=10 selects /10 (render-stream-10.md).
  // W11b: GRC_STREAM_VERSION=11 selects /11 (render-stream-11.md).
  // PM5: GRC_STREAM_VERSION=12 selects /12 (render-stream-12.md).
  // W13b: GRC_STREAM_VERSION=13 selects /13 (render-stream-13.md "As built (W13b)"): /12's
  // snapshots, each sink and connection predicting its own blocks.
  // ID3: GRC_STREAM_VERSION=14 selects /14 (render-stream-14.md): /13 plus item_meta v2.
  session.version = g_stream.gate8.speaks_v14()   ? rs2::ProtocolVersion::V14
                    : g_stream.gate8.speaks_v13() ? rs2::ProtocolVersion::V13
                    : g_stream.gate8.speaks_v12() ? rs2::ProtocolVersion::V12
                    : g_stream.gate8.speaks_v11() ? rs2::ProtocolVersion::V11
                    : g_stream.gate8.speaks_v10() ? rs2::ProtocolVersion::V10
                    : g_stream.gate8.speaks_v9() ? rs2::ProtocolVersion::V9
                    : g_stream.gate8.speaks_v8() ? rs2::ProtocolVersion::V8
                                                 : rs2::ProtocolVersion::V6;
  session.materials.shader_policy = g_stream.shader_policy;
  session.session_id = rs2::generate_id();
  g_api_arm.session_id = session.session_id;
  g_api_arm.token = live_auth_token;
  g_api_arm.stream_version = 2 + static_cast<int>(session.version);
  session.engine.version_string = g_state.fp.version_string;
  session.engine.sha256 = g_state.fp.exe_sha256;
  session.engine.display_server = g_state.display_server;
  session.engine.rendering_driver = g_state.rendering_driver;
  session.engine.rendering_method = g_state.rendering_method;
  session.capture.calibrator_version =
      static_cast<uint32_t>(std::strtoul(g_state.calib.calibrator_version.c_str(), nullptr, 10));
  session.capture.hooks_planned = g_state.plan.planned;
  session.capture.hooks_omitted = g_state.plan.omitted;
  // A headless host (RasterizerDummy,
  // servers/display_server_headless.h:51) declares canvas_texture unsupported -- unless the opt-in
  // shim gives every CanvasTexture created while armed its own identity,
  // in which case it declares canvas_texture supported like a rendered host. The
  // mirror's RID() refusal below stays on either way: RID() in a texture draw is still ambiguous
  // on a headless host (a CanvasTexture created before arming, or no texture).
  const bool headless_host = g_state.display_server == "headless";
  const bool ct_synthesized = rs::canvas_texture_shim().armed();
  // /7 and /8 change no feature list (render-stream-7.md, render-stream-8.md): ask for /6's.
  session.features = rs2::gate2_features(headless_host && !ct_synthesized, rs2::ProtocolVersion::V6);
  session.resources.mesh_dynamic = g_stream.mesh_dynamic;  // W11b: encoded at /11 only
  if (rs2::is_v10_or_later(session.version)) {
    // render-stream-10.md "Features": each back-buffer setter leaves unobserved when its hook is
    // planned (a record without the slot omits the hook and keeps the method unobserved).
    rs2::observe_planned_backbuffer_setters(&session.features, session.capture.hooks_planned);
  }
  if (rs2::is_v11_or_later(session.version) && hooks_multimesh_planned()) {
    // render-stream-11.md "As built (PM1)" rule 8: add_multimesh, the multimesh resource, and
    // canvas_item_add_multimesh no longer an observed unsupported op.
    rs2::observe_multimesh_features(&session.features);
  }
  if (rs2::is_v12_or_later(session.version) && hooks_particles_planned()) {
    // render-stream-12.md "Session record": add_particles, the particles resource, and
    // canvas_item_add_particles no longer an observed unsupported op.
    rs2::observe_particles_features(&session.features);
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
  // the file sinks' and the store's I/O leave the frame callback
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
  // adoption runs here, after the root query and before the size policy,
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
    adopt_config.identity_transform = planned("canvas_item_set_use_identity_transform");
    switch (sabotage.config.kind) {
    case rs2::SabotageKind::AdoptSkipState: adopt_config.sabotage = rs::AdoptSabotage::SkipState; break;
    case rs2::SabotageKind::AdoptNoRedraw: adopt_config.sabotage = rs::AdoptSabotage::NoRedraw; break;
    case rs2::SabotageKind::AdoptSkipLayers: adopt_config.sabotage = rs::AdoptSabotage::SkipLayers; break;
    default: break;
    }
    // size-before-adopt applies the presentation size ahead of
    // the walk, so the relayout, stretch and oversampling it causes name RIDs nothing has adopted.
    if (sabotage.config.kind == rs2::SabotageKind::SizeBeforeAdopt) {
      rearm_record_min_size(before.window, presentation_wh);
      std::string early_detail;
      size_applied_early =
          rs::root_set_min_size(before, presentation_wh[0], presentation_wh[1], &early_detail);
      log_line("sabotage: size-before-adopt applied the presentation size before adoption");
    }
    // G8r (D6, D7): lazy resource adoption is on from the walk to the stream's end; the walk's
    // redraws (this iteration's flush) are the first hooked calls to name pre-arm resources.
    // LAR2: a headless display server runs the dummy RenderingServer (multimesh rules, O3).
    rs::adopt_resources_begin(g_stream.adopt_fault, g_state.display_server == "headless");
    // G8m (D11, D12): materials and shaders resolve after the hook log opens (below) and at every
    // frame boundary; the two Q5 sabotages act there.
    rs::adopt_materials_configure(
        sabotage.config.kind == rs2::SabotageKind::AdoptRawShaderCode
            ? rs::AdoptMaterialSabotage::RawShaderCode
            : sabotage.config.kind == rs2::SabotageKind::AdoptSkipParams
                  ? rs::AdoptMaterialSabotage::SkipParams
                  : rs::AdoptMaterialSabotage::None);
    const auto reload = rs::adopt_reload_at_arm();
    emit("reload.json", rs::adopt_reload_json(g_rearm.arm_index, adopt_config.arm_frame));
    log_line("reload: candidates=" + std::to_string(reload.candidates.total()) +
             " (released " + std::to_string(reload.candidates.released) + ", evicted " +
             std::to_string(reload.candidates.evicted) + ", residual " +
             std::to_string(reload.candidates.residual) + ") reloaded=" +
             std::to_string(reload.reloaded) + " refused=" + std::to_string(reload.refused.total()) +
             " released_no_path=" + std::to_string(reload.refused.released_no_path) +
             " us=" + std::to_string(reload.reload_us));
    const auto warm = rs::adopt_warm_at_arm(g_stream.arm_t0_ns, rs::texture_workers_name(g_stream.workers));
    emit("warm.json", rs::adopt_warm_json(g_rearm.arm_index, adopt_config.arm_frame));
    log_line("warm: queued=" + std::to_string(warm.queued) + " (reload " +
             std::to_string(warm.from_reload) + ", registry " + std::to_string(warm.from_registry) +
             ", cache " + std::to_string(warm.from_cache) + ") jobs=" + std::to_string(warm.jobs) +
             " sync=" + std::to_string(warm.sync_coded) + " skipped=" +
             (warm.skipped.empty() ? "-" : warm.skipped) + " us=" + std::to_string(warm.warm_queue_us));
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
  // presentation:, the logical size otherwise.
  int32_t presentation_size[2] = {before.logical_size[0], before.logical_size[1]};
  if (policy == RootSizePolicy::Presentation) {
    presentation_size[0] = presentation_wh[0];
    presentation_size[1] = presentation_wh[1];
  }
  if (policy == RootSizePolicy::EnforceMinSize || policy == RootSizePolicy::Presentation) {
    enforce_called = true;
    if (!size_applied_early) {
      const int32_t set[2] = {policy == RootSizePolicy::Presentation ? presentation_wh[0]
                                                                     : before.logical_size[0],
                              policy == RootSizePolicy::Presentation ? presentation_wh[1]
                                                                     : before.logical_size[1]};
      rearm_record_min_size(before.window, set);
    }
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
    // The operator asked for a guarantee the
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
  // the root viewport's default texture filter and repeat, read
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
  {
    // W11b (render-stream-11.md "Capture policy", WB "Stable content_version"): the mirror's /11
    // behaviours, off below /11 (every older snapshot is unchanged).
    rs::Mirror::V11Options v11;
    v11.enabled = g_stream.gate8.speaks_v11();
    v11.mesh_dynamic = g_stream.mesh_dynamic;
    v11.cv_churn = sabotage.config.kind == rs2::SabotageKind::CvChurn;
    v11.stale_dynamic_frame =
        sabotage.config.kind == rs2::SabotageKind::StaleDynamic ? sabotage.config.frame : 0;
    // HC2 test knob (never declared on the wire): GRC_HC_SABOTAGE=rerecord-stale.
    const char *hc_sabotage = std::getenv("GRC_HC_SABOTAGE");
    v11.rerecord_stale = hc_sabotage != nullptr && std::string(hc_sabotage) == "rerecord-stale";
    rs::mirror_instance().set_v11(v11);
    // HC4a test knobs (never declared on the wire): the shadow oracle, GRC_HC_SHADOW=1 (every
    // snapshot also built by the full walk and compared, the stream ended at the first
    // difference), and the sabotages
    // GRC_HC_SABOTAGE=hc-skip-dirty / hc-stale-derived.
    const char *hc_shadow = std::getenv("GRC_HC_SHADOW");
    g_hc_shadow = hc_shadow != nullptr && std::string(hc_shadow) == "1";
    g_hc_shadow_budget.clear();
    const rs2::ProtocolVersion shadow_version =
        g_stream.gate8.speaks_v13()   ? rs2::ProtocolVersion::V13
        : g_stream.gate8.speaks_v12() ? rs2::ProtocolVersion::V12
        : g_stream.gate8.speaks_v11() ? rs2::ProtocolVersion::V11
        : g_stream.gate8.speaks_v10() ? rs2::ProtocolVersion::V10
        : g_stream.gate8.speaks_v9()  ? rs2::ProtocolVersion::V9
        : g_stream.gate8.file_version == rs2::ProtocolVersion::V8 ? rs2::ProtocolVersion::V8
                                                                   : rs2::ProtocolVersion::V6;
    rs::mirror_instance().set_hc_shadow(g_hc_shadow, shadow_version);
    const std::string hc_sabotage_name = hc_sabotage != nullptr ? hc_sabotage : "";
    rs::mirror_instance().set_hc_sabotage(hc_sabotage_name == "hc-skip-dirty",
                                          hc_sabotage_name == "hc-stale-derived");
    // HC4b: hc-skip-dirty-texture, and the inline threshold the snapshots' name index counts at.
    rs::mirror_instance().set_hc_sabotage_texture(hc_sabotage_name == "hc-skip-dirty-texture");
    rs::mirror_instance().set_inline_max(g_stream.policy.inline_max_bytes);
    if (g_hc_shadow || hc_sabotage_name.rfind("hc-", 0) == 0) {
      log_line("stream: hc4a shadow=" + std::string(g_hc_shadow ? "on" : "off") +
               (hc_sabotage_name.empty() ? std::string() : " sabotage=" + hc_sabotage_name));
    }
    // PM1 (render-stream-11.md "As built (PM1)"): the multimesh table, exactly when the session
    // declares it (rule 8). Off below /11 and without the twelve hooks: no snapshot changes.
    rs::Mirror::MultimeshOptions mm;
    mm.enabled = g_stream.gate8.speaks_v11() && hooks_multimesh_planned();
    mm.max_payload_bytes = g_stream.policy.max_payload_bytes;
    mm.stale_buffer_frame =
        sabotage.config.kind == rs2::SabotageKind::StaleBuffer ? sabotage.config.frame : 0;
    mm.state_notes = mm.enabled;
    rs::mirror_set_multimesh(mm);
    // PM5 (render-stream-12.md): the particles table and emit log, exactly when the session
    // declares add_particles; off below /12 and without the 33 hooks. /12 also carries a plain
    // Array material parameter's packed form (the process materials' param-type cause).
    rs::Mirror::ParticlesOptions pt;
    pt.enabled = g_stream.gate8.speaks_v12() && hooks_particles_planned();
    pt.state_notes = pt.enabled;
    pt.drop_restart_frame =
        sabotage.config.kind == rs2::SabotageKind::DropRestart ? sabotage.config.frame : 0;
    pt.drop_events_frame =
        sabotage.config.kind == rs2::SabotageKind::FreezeDropEvents ? sabotage.config.frame : 0;
    pt.send_positions_frame =
        sabotage.config.kind == rs2::SabotageKind::FreezeSendPositions ? sabotage.config.frame : 0;
    pt.param_arrays = g_stream.gate8.speaks_v12();
    rs::mirror_set_particles(pt);
  }
  // perturb-decode acts in the decode seam, before the hook hashes.
  rs::texture_decode_set_perturb(
      sabotage.config.kind == rs2::SabotageKind::PerturbDecode ? sabotage.config.frame : 0);
  // the declared shader-source policy.
  rs::mirror_set_shader_policy(g_stream.shader_policy);
  if (g_stream.shader_policy != rs2::ShaderPolicy::Source) {
    log_line(std::string("stream: shader_policy=") + rs2::to_wire(g_stream.shader_policy));
  }
  // render-stream-1.md "Session record": `viewport` and the blocks, all read
  // after the root-size policy.
  session.viewport.canvas_cull_mask = root.canvas_cull_mask;
  session.viewport.root_canvas = rs2::kRootCanvasId;
  session.viewport.logical_size = {root.logical_size[0], root.logical_size[1]};
  g_api_arm.root_size = std::to_string(presentation_size[0]) + "x" +
                        std::to_string(presentation_size[1]);
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
    item_meta_configure();
    if (!g_meta.file.empty() && g_stream.gate8.speaks_v13()) {
      g_stream.publisher->set_item_meta(g_meta.file);  // TAG1: GRC_ITEM_META_FILE (a /13 sink)
    }
    g_stream.publisher->set_resource_events([](const char *op, const std::string &hash,
                                               uint64_t bytes, bool ok, uint64_t frame) {
      rs::TapContext ctx;
      ctx.frame = frame;
      ctx.t_ns = monotonic_ns();
      ctx.main_thread = true;
      rs::resource_log().resource_event(ctx, op, hash, bytes, ok ? "ok" : "failed");
    });
    // with the P3-CAP writer, the lanes' records and
    // transactions are formed on it too (GRC_HC_FORMATION=inline keeps them here).
    const char *formation = std::getenv("GRC_HC_FORMATION");
    if (g_stream.writer != nullptr &&
        !(formation != nullptr && std::string(formation) == "inline")) {
      g_stream.publisher->set_former(g_stream.writer.get());
    }
    log_line(std::string("stream: lane formation ") +
             (g_stream.writer != nullptr &&
                      !(formation != nullptr && std::string(formation) == "inline")
                  ? "writer"
                  : "inline"));
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
    server_config.tls = g_live.tls.get();  // CAR4 (D12): wss beside ws when a pair is set
    server_config.lan_plaintext = g_live.lan_plaintext;  // D12: plain ws for LAN pages too
    // /7 preferred when both are offered; the /7 token travels in
    // the hello (rs_live.h), so its upgrade is not bearer-checked.
    // render-stream.8 is offered last by default (the default stays /7),
    // first under GRC_STREAM_VERSION=8, and alone under a gate 8 policy. A /8 upgrade carries the
    // token in the hello like /7's.
    server_config.subprotocols = rs::gate8_live_subprotocols(g_stream.gate8);
    // ID3 (render-stream-14.md "Who speaks /14"): render-stream.14 is listed first only when the
    // grant names a v2 field and the listener speaks /13; otherwise the list is unchanged.
    item_meta_configure();
    if ((g_meta.grant & rs::item_meta::kV2Fields) != 0 &&
        std::find(server_config.subprotocols.begin(), server_config.subprotocols.end(),
                  rs2::kSubprotocolV13) != server_config.subprotocols.end() &&
        std::find(server_config.subprotocols.begin(), server_config.subprotocols.end(),
                  rs2::kSubprotocolV14) == server_config.subprotocols.end()) {
      server_config.subprotocols.insert(server_config.subprotocols.begin(),
                                        rs2::kSubprotocolV14);
    }
    server_config.hello_token_subprotocols = {rs2::kSubprotocolV7, rs2::kSubprotocolV8,
                                                   rs2::kSubprotocolV9, rs2::kSubprotocolV10,
                                                   rs2::kSubprotocolV11, rs2::kSubprotocolV12,
                                                   rs2::kSubprotocolV13, rs2::kSubprotocolV14};
    {
      // ID3: the list itself, for the pure-path check (identical without a v2 grant).
      std::string names;
      for (const std::string &name : server_config.subprotocols) {
        names += (names.empty() ? "" : ",") + name;
      }
      log_line("live: subprotocols " + names);
    }
    server_config.auth_token = live_auth_token;  // G2e: empty unless GRC_LIVE_AUTH=token.
    server_config.allowed_origins = g_live.allowed_origins;  // G7n
    server_config.allow_non_loopback = g_live.expose == live::Expose::Lan;  // CAR2 (checked above)
    server_config.enforce_origins = g_live.listener_sabotage != "accept-any-origin";
    server_config.cors_headers = g_live.listener_sabotage != "no-cors";
    server_config.codings = g_live.http_codings;  // G8kz
    server_config.corrupt_coded_body = g_live.listener_sabotage == "corrupt-coded-body";
    const bool tracks_on = !g_live.track_config.kinds.empty();
    if (tracks_on) {
      // matched after every view subprotocol, admitted from the
      // track pool. Off: neither member is touched (T3).
      server_config.track_subprotocols = {rs::tracks::kTrackSubprotocolV1};
      server_config.max_tracks = static_cast<std::size_t>(g_live.max_tracks);
    }
    g_live.http_coding_on = !g_live.http_codings.empty();
    g_live.address = live_host;
    std::string error;
    // G2c2: the served payloads answer every resource GET on this listener.
    g_live.served = std::make_unique<rs::ServedResources>();
    // HC4b: the serve-skip sabotage and the serving half of the shadow oracle.
    {
      const char *hc = std::getenv("GRC_HC_SABOTAGE");
      g_live.served->set_serve_skip(hc != nullptr && std::string(hc) == "serve-skip");
      const char *shadow = std::getenv("GRC_HC_SHADOW");
      g_live.served->set_shadow(shadow != nullptr && std::string(shadow) == "1");
    }
    if (sabotage.config.kind == rs2::SabotageKind::Unpin) {
      g_live.served->set_unpin_frame(sabotage.config.frame);
    } else if (sabotage.config.kind == rs2::SabotageKind::DropResource) {
      g_live.served->set_drop_frame(sabotage.config.frame);
    } else if (sabotage.config.kind == rs2::SabotageKind::RetainSuperseded) {
      g_live.served->set_retain_superseded_frame(sabotage.config.frame);
    }
    g_live.serving.budget_bytes = g_stream.budget_bytes;
    // the set owns the server as carrier `ws`, index 0; the
    // admission limit becomes the set's total (D6). The 2-second flush budget is the stop's.
    {
      live::CarrierServices services;
      services.auth_token = live_auth_token;
      services.allowed_origins = g_live.allowed_origins;
      services.enforce_origins = server_config.enforce_origins;
      services.resources = g_live.served.get();
      services.log = [](int, const std::string &line) { log_line(line); };
      // grc_carrier_host_v1.config (grc_carrier.h): what a C ABI carrier may read.
      {
        auto join = [](const std::vector<std::string> &v) {
          std::string out;
          for (const std::string &x : v) out += (out.empty() ? "" : ",") + x;
          return out;
        };
        auto hostport = [](const std::string &host, uint16_t port) {
          return (host.find(':') != std::string::npos ? "[" + host + "]" : host) + ":" +
                 std::to_string(port);
        };
        std::map<std::string, std::string> &c = services.config;
        c["listen"] = g_live.listen;
        c["expose"] = g_live.expose == live::Expose::Lan ? "lan" : "loopback";
        c["path"] = server_config.path;
        c["subprotocols"] = join(server_config.subprotocols);
        c["hello_token_subprotocols"] = join(server_config.hello_token_subprotocols);
        c["max_inbound_text"] = std::to_string(server_config.max_inbound_text);
        c["max_queued_bytes"] = std::to_string(server_config.max_queued_bytes);
        // D9: GRC_LIVE_LISTEN's host and port number unless GRC_LIVE_WT_LISTEN says otherwise
        // (port 0 stays 0: wt binds its own ephemeral UDP port).
        c["wt_listen"] = g_live.wt_listen.empty() ? hostport(live_host, live_port) : g_live.wt_listen;
        c["wt_cert"] = g_live.wt_cert;
        if (!g_live.tls_cert.empty()) {
          c["tls_cert"] = g_live.tls_cert;
          c["tls_key"] = g_live.tls_key;
        }
        if (g_state.evidence_ready) c["evidence_dir"] = g_state.evidence_dir;
        if (tracks_on) c["track_subprotocols"] = join(server_config.track_subprotocols);  // TRK1
      }
      g_live.carriers = std::make_unique<live::CarrierSet>(
          static_cast<std::size_t>(live_max_connections), std::move(services),
          tracks_on ? static_cast<std::size_t>(g_live.max_tracks) : 0);
      bool added = false;
      if (g_live.ws_enabled) {
        auto ws = std::make_unique<live::WsCarrier>(server_config, g_live.served.get(), 2000);
        g_live.ws = ws.get();
        if (g_live.carriers->add(live::kCarrierWs, std::move(ws), &error)) {
          added = true;
        } else {
          g_live.ws = nullptr;
        }
      }
      // carrier `wt`, index 1, from the net module. A
      // failure to make it is recorded like a failed start; the others still serve.
      if (g_live.wt_enabled) {
        std::string wt_error;
        std::unique_ptr<live::NetWtCarrier> wt = live::NetWtCarrier::create(g_live.net_module, &wt_error);
        if (wt == nullptr || !g_live.carriers->add(live::kCarrierWt, std::move(wt), &wt_error)) {
          log_line("live: wt not added (" + wt_error + ")");
        } else {
          added = true;
        }
      }
      // every listed consumer carrier at its registered index
      // (2..255, registration order). Unlisted ones are destroyed when stream_start returns.
      {
        std::vector<std::string> listed;
        std::string ignored;
        live::parse_carrier_list(std::getenv("GRC_LIVE_CARRIERS"), &listed, &ignored);
        for (auto it = g_live.registered.begin(); it != g_live.registered.end();) {
          if (std::find(listed.begin(), listed.end(), it->name) == listed.end()) {
            ++it;
            continue;
          }
          std::string ext_error;
          const grc_carrier_v1 vtable = it->vtable;
          const std::string name = it->name;
          const std::uint8_t index = it->index;
          it = g_live.registered.erase(it);  // the AbiCarrier owns it from here
          std::unique_ptr<live::AbiCarrier> ext = live::AbiCarrier::adopt(&vtable, &ext_error);
          if (ext == nullptr) {
            log_line("live: carrier " + name + " not added (" + ext_error + ")");
            vtable.destroy(vtable.self);  // registered, so destroy is non-null
            continue;
          }
          if (!g_live.carriers->add(index, std::move(ext), &ext_error)) {
            log_line("live: carrier " + name + " not added (" + ext_error + ")");  // destroyed
            continue;
          }
          added = true;
        }
      }
      if (!added && error.empty()) error = "no carrier could be added";
      if (!added) g_live.ws = nullptr;
    }
    if (g_live.carriers == nullptr || !g_live.carriers->start(&error)) {
      emit_live_carriers();
      g_live.carriers.reset();
      g_live.ws = nullptr;
      live_decided(error == "non-loopback" ? "refused" : "failed", error);
      if (!files) {
        rs::mirror_enable(false);
        g_stream.status = "open-failed";
        g_stream.reason = "live listener failed: " + error;
        return;
      }
    } else {
      // live.json's address and port stay the `ws` listener's (D13), null without `ws` (CAR6).
      if (g_live.ws != nullptr && g_live.carriers->started(live::kCarrierWs)) {
        g_live.port = g_live.ws->port();
      } else {
        g_live.address.clear();
      }
      rs2::Session tmpl = session;
      tmpl.stream = rs2::StreamInfo();
      // G2c2: every live connection follows the configured policy; out-of-band payloads come
      // from GET /resources/sha256/<hash> on this listener.
      tmpl.resources = rs2::resources_info(g_stream.policy, rs2::Fetch::Http);
      tmpl.resources.auth = live_auth;  // G2e: "bearer" exactly when GRC_LIVE_AUTH=token.
      tmpl.resources.mesh_dynamic = g_stream.mesh_dynamic;  // W11b: encoded at /11 only
      g_live.hub = std::make_unique<rs2::Hub>(g_live.carriers.get(), live_config, tmpl);
      g_live.hub->set_observer([](const rs2::ConnEvent &e) {
        if (e.kind == rs2::ConnEvent::Connected) {
          g_api->client_connected(e.connection, {{"carrier", e.carrier},
              {"version", std::int64_t(e.version)}, {"origin", e.origin}});
        } else {
          g_api->client_left(e.connection, e.reason);
        }
      });
      if (tracks_on) {
        // TRK1: the view Hub's hello timeout and the carrier's text cap apply to tracks too.
        rs::tracks::TrackConfig tc = g_live.track_config;
        tc.hello_timeout_ms = live_config.hello_timeout_ms;
        tc.max_message_bytes = server_config.max_inbound_text;
        tc.tap_dir = live_config.tap_dir;
        g_live.tracks = std::make_unique<rs::tracks::TrackHub>(
            std::move(tc), *g_live.carriers, [](const std::string &line) { log_line(line); });
        std::string kinds;
        for (const std::string &k : g_live.track_config.kinds) kinds += (kinds.empty() ? "" : ",") + k;
        log_line("live: tracks kinds=" + kinds + " max_tracks=" + std::to_string(g_live.max_tracks) +
                 " rate=" + std::to_string(g_live.track_config.rate_per_s) +
                 " keepalive_ms=" + std::to_string(g_live.track_config.keepalive_ms) +
                 (g_live.track_config.caps == rs::tracks::CapsMode::Hmac ? " caps=hmac" : " caps=shared") +
                 (g_live.track_config.sabotage != rs::tracks::Sabotage::None
                      ? std::string(" sabotage=") + rs::tracks::sabotage_name(g_live.track_config.sabotage)
                      : std::string()));
      }
      live_decided("listening", std::string());
      emit_live_carriers();
      refresh_live_tracks();
      // TRK6: the built-in injector holds `input` before any script receiver can attach.
      if (!g_live.track_config.inject_mode.empty()) {
        std::string inject_why;
        if (!live::gd_tracks_builtin_bind(g_live.tracks.get(), &inject_why)) {
          log_line("live: built-in input injection could not bind: " + inject_why);
        } else {
          log_line("live: built-in input injection mode=reference addon_sha256=" +
                   g_live.track_config.inject_addon_sha256);
        }
      }
      // TRK2 (rs_tracks_gd.h): RenderStreamTrack receivers bound before the arm join the hub now
      // (null with tracks off: they report `not-granted`).
      live::gd_tracks_attach(g_live.tracks.get());
    }
  }
  g_stream.status = "open";
  resources_start(root.viewport_rid);
  if (g_stream.gate8.adopt) {
    // every adopted item's material, shader and instance
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
  if (g_live.hub == nullptr || g_live.carriers == nullptr || g_live.stopped || g_live.closing) {
    return;
  }
  g_live.hub->sync();  // HC5: the previous callback's formation jobs, completed first
  bool connections_changed = false;
  for (const live::Event &event : g_live.carriers->take_events()) {
    if (event.kind == live::Event::Opened || event.kind == live::Event::Closed) connections_changed = true;
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
    // a track connection never reaches the view Hub, which would
    // map its unknown subprotocol to a view version and send it a session.
    if (g_live.tracks != nullptr && g_live.tracks->claims(event)) {
      g_live.tracks->on_event(event, monotonic_ns());
      continue;
    }
    g_live.hub->on_event(rs2::to_live_event(event), frame);
  }
  if (connections_changed) refresh_live_carriers();
  if (g_live.tracks != nullptr) {
    g_live.tracks->tick(monotonic_ns());  // hello timeout, idle, the host's keepalives
    if (g_live.tracks->take_changed()) refresh_live_tracks();
  }
}

// Close the remaining connections before stopping the carriers. Runs on main.
void live_close_begin() {
  live_drain(g_state.frames_total);
  g_live.hub->close_open(g_state.frames_total);
  if (g_live.tracks != nullptr) {
    // TRK1 (Q5): a track that opened during the linger ends before the carriers stop.
    g_live.tracks->close_all(1001, "stream-ended");
  }
}

// Write the final carrier and connection evidence after all carrier stops have completed.
void live_close_finish() {
  if (g_live.carriers != nullptr) {
    emit_live_carriers();
  }
  refresh_live_tracks();
  live::gd_tracks_detach();  // TRK2: the hub is never called again; queued closes still flush
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
    // TDR: the bodies are coded where they were built (evidence/at-rest.json); the serving side
    // only inflates, for a GET or carrier request that does not take the stored coding.
    const rs::RestStats rest = rs::rest_stats();
    const rs::RestStats::Inflate &get = rest.inflate[static_cast<std::size_t>(rs::InflateSite::Get)];
    g_live.serving.at_rest = rs::rest_coding_token(g_stream.rest.coding);
    g_live.serving.identity_inflates = get.count;
    g_live.serving.identity_inflate_bytes = get.identity_bytes;
    g_live.serving.identity_inflate_ns = get.ns;
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
  if (g_meta.host.stats().ever_on) {
    emit("item-meta.json", g_meta.host.stats_json());  // TAG1: the host's resolution cost
  }
  g_meta.host.set_union(rs::item_meta::Request(), 0);
  g_meta.on = false;
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

// Blocking teardown retains the carrier index order and the original evidence order.
void live_close_and_stop() {
  if (g_live.hub == nullptr || g_live.stopped) {
    return;
  }
  live_close_begin();
  if (g_live.carriers != nullptr) {
    g_live.carriers->stop();  // ws: the 2-second flush budget
  }
  live_close_finish();
}

// One linger step: drain closes; stop once every receiver closed or the
// linger ran out. `blocking` waits here (shutdown); otherwise the next frame
// callback continues (disarm).
void live_linger(bool blocking) {
  if (!g_live.ending || g_live.stopped || g_live.closing) {
    return;
  }
  for (;;) {
    // CAR6: script carriers get the end records (and the hub's closes) while the linger waits,
    // with no frame callback in between when blocking.
    live::gd_carriers_flush();
    live::gd_tracks_flush();  // TRK2: and track receivers their closed signals
    live_drain(g_state.frames_total);
    if (g_live.hub->open_connections() == 0 || monotonic_ns() >= g_live.linger_deadline_ns) {
      if (g_live.close_async) live_close_async_begin();
      else live_close_and_stop();
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
  if (g_live.tracks != nullptr) {
    // TRK1 (T13): tracks end with live, at once, and never hold the linger open.
    g_live.tracks->close_all(1001, "stream-ended");
    refresh_live_tracks();
  }
  g_live.hub->finish(reason, g_state.frames_total, monotonic_ns());
  g_live.ending = true;
  g_live.linger_deadline_ns = monotonic_ns() + g_live.linger_ns;
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
  rs::adopt_warm_cancel();
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
// LS3: in three steps, so a disarm waits for the encodes on its teardown thread: the main thread
// starts what the last callback did not (drain) or drops the queue, the wait joins the pool, and
// the main thread then abandons what is left.
std::size_t encoders_finish_begin() {
  if (g_stream.basis_config.drain && g_stream.encoders_started) {
    // G8kf: the prepare step's end. Start what the last callback did not, then wait for every
    // queued encode: each one stores its result in the persisted cache (D8).
    rs::mirror_instance().service_basis(false, false);
    return 0;
  }
  rs::mirror_instance().set_basis_submit(nullptr);
  return rs::texture_encode_pool().discard_queued();
}

void encoders_finish_wait() {
  if (g_stream.basis_config.drain && g_stream.encoders_started) {
    rs::texture_encode_pool().drain();
  }
  rs::texture_encode_pool().stop();
}

void encoders_finish_end(std::size_t dropped) {
  if (g_stream.basis_config.drain && g_stream.encoders_started) {
    log_line("stream: drained the uastc encode pool at stream end");
    rs::mirror_instance().set_basis_submit(nullptr);
    dropped = rs::texture_encode_pool().discard_queued();
  }
  for (const rs::BasisJobPtr &job : rs::mirror_instance().basis_jobs()) {
    job->abandon();
  }
  g_stream.encoders_started = false;
  if (dropped != 0) {
    log_line("stream: dropped " + std::to_string(dropped) + " queued uastc encodes at stream end");
  }
}

// G8ku: a lazy encode nobody will publish is dropped at stream end (the pool discards what is
// queued and waits only for the encodes in flight); the mirror forgets its submitter.
void encoders_finish() {
  if (!g_stream.basis) {
    return;
  }
  const std::size_t dropped = encoders_finish_begin();
  encoders_finish_wait();
  encoders_finish_end(dropped);
}

// TDR (served-at-rest): evidence/at-rest.json at stream end, with an
// evidence directory only. The coding and its counters (rs_payload_rest.h), and a census of what
// the mirror and the served set hold: each distinct GRT1 body once, identity bytes held for coded
// (or never tried) bodies, held and identity bytes.
void census_fields(JsonWriter *json, const rs::RestCensus &c) {
  json->object_begin();
  json->field("bodies", static_cast<int64_t>(c.bodies));
  json->field("coded", static_cast<int64_t>(c.coded));
  json->field("not_smaller", static_cast<int64_t>(c.not_smaller));
  json->field("untried", static_cast<int64_t>(c.untried));
  json->field("identity_bytes_held", static_cast<int64_t>(c.identity_bytes_held));
  json->field("held_bytes", static_cast<int64_t>(c.held_bytes));
  json->field("identity_bytes", static_cast<int64_t>(c.identity_bytes));
  json->field("capacity_slack_bytes", static_cast<int64_t>(c.capacity_slack_bytes));
  json->object_end();
}

void emit_at_rest() {
  if (!g_state.evidence_ready) {
    return;
  }
  const rs::RestStats st = rs::rest_stats();
  JsonWriter json;
  json.object_begin();
  json.field("coding", std::string(rs::rest_coding_token(g_stream.rest.coding)));
  json.field("fault", std::string(g_stream.rest.keep_identity ? "keep-identity" : ""));
  json.field("texture_workers", rs::texture_workers_name(g_stream.workers));
  json.field("worker_min_bytes", static_cast<int64_t>(g_stream.workers.min_bytes));
  json.field("coded", static_cast<int64_t>(st.coded));
  json.field("not_smaller", static_cast<int64_t>(st.not_smaller));
  json.field("in_bytes", static_cast<int64_t>(st.in_bytes));
  json.field("out_bytes", static_cast<int64_t>(st.out_bytes));
  json.field("code_ns", static_cast<int64_t>(st.code_ns));
  json.field("code_main_thread", static_cast<int64_t>(st.code_main_thread));
  json.key("inflate").object_begin();
  for (std::size_t i = 0; i < static_cast<std::size_t>(rs::InflateSite::kCount); ++i) {
    const rs::RestStats::Inflate &in = st.inflate[i];
    json.key(rs::inflate_site_name(static_cast<rs::InflateSite>(i))).object_begin();
    json.field("count", static_cast<int64_t>(in.count));
    json.field("coded_bytes", static_cast<int64_t>(in.coded_bytes));
    json.field("identity_bytes", static_cast<int64_t>(in.identity_bytes));
    json.field("ns", static_cast<int64_t>(in.ns));
    json.object_end();
  }
  json.object_end();
  json.field("inflate_failed", static_cast<int64_t>(st.inflate_failed));
  std::unordered_set<const void *> seen_mirror;
  rs::RestCensus mirror;
  rs::mirror_instance().at_rest_census(&mirror, &seen_mirror);
  json.key("mirror");
  census_fields(&json, mirror);
  if (g_live.served != nullptr) {
    std::unordered_set<const void *> seen_served;
    rs::RestCensus served;
    g_live.served->census(&served, &seen_served);
    json.key("served");
    census_fields(&json, served);
    // Mirror and served set together, each body once: a body both hold is held once (shared).
    rs::RestCensus both = mirror;
    g_live.served->census(&both, &seen_mirror);
    json.key("both");
    census_fields(&json, both);
    json.field("served_retained_bytes", static_cast<int64_t>(g_live.served->retained_bytes()));
  } else {
    json.key("served").null();
    json.key("both").null();
    json.key("served_retained_bytes").null();
  }
  json.object_end();
  emit("at-rest.json", json.take());
}

// The main-thread half of a stream's end: the workers and encoders (when the caller has not run
// them yet), the at-rest census, the mirror, adoption, the hook log, item meta's watch and the
// live end records. False when no stream was open. Logs the store before the sinks close it.
bool stream_finish_main(rs2::EndReason reason) {
  if (g_stream.status != "open") {
    return false;
  }
  workers_finish();
  encoders_finish();
  emit_at_rest();  // TDR: before anything below lets a body go
  if (rs::adopt_resources_active()) {
    rs::adopt_warm_finish();
    emit("warm.json", rs::adopt_warm_json(g_rearm.arm_index, g_state.frames_total));
  }
  rs::mirror_enable(false);
  if (rs::adopt_resources_active()) {
    rs::adopt_reload_finish();
    emit("reload.json", rs::adopt_reload_json(g_rearm.arm_index, g_state.frames_total));
  }
  rs::adopt_resources_end();  // G8r
  live_drain(g_state.frames_total);  // G2c2: GETs answered so far reach the hook log first
  resources_finish();
  // the disarm undoes every property_list_changed
  // connection and clears the change queue and the sweep (no frame forms a record after this);
  // live_close_and_stop then clears the rest of the union with g_meta, as TAG1 does.
  g_meta.host.v2_off();
  live_finish(reason, reason == rs2::EndReason::Shutdown);
  if (g_stream.publisher == nullptr) {
    g_stream.status = "closed";
    return true;
  }
  if (g_stream.store != nullptr) {
    log_line("stream: store " + g_stream.store->dir() + " hashes=" +
             std::to_string(g_stream.store->hashes()) + " bytes=" +
             std::to_string(g_stream.store->bytes()) +
             (g_stream.store->corrupted_hash().empty()
                  ? std::string()
                  : " corrupted=" + g_stream.store->corrupted_hash()));
  }
  return true;
}

// LS3: the file sinks' end: both end records, the store's index, then the writer drained and its
// thread joined. It touches only the publisher, the sinks, the store and their writer, which
// nothing else uses once the stream is closing, so a disarm runs it on the teardown thread.
struct SinksEnd {
  bool ok = true;
  bool writer_ok = true;
  std::string writer_error;
};
SinksEnd g_sinks_end;

void stream_sinks_end(rs2::EndReason reason) {
  g_sinks_end = SinksEnd();
  g_sinks_end.ok = g_stream.publisher->finish(reason);
  if (g_stream.store != nullptr) {
    g_stream.store->close();
  }
  if (g_stream.writer != nullptr) {
    g_sinks_end.writer_ok = g_stream.writer->drain(&g_sinks_end.writer_error);
    g_stream.writer->stop();
  }
}

void stream_finish_after_sinks(rs2::EndReason reason) {
  g_stream.status = "closed";
  if (!g_sinks_end.ok && g_stream.reason.empty()) {
    g_stream.reason = "end record write failed";
  }
  if (!g_sinks_end.writer_ok && g_stream.reason.empty()) {
    g_stream.reason = g_sinks_end.writer_error;  // a queued write failed after the last publication
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

// The whole end on the calling thread (shutdown, unload, a self-ended stream, a failed arm).
// Only the first call while the stream is open does anything.
void stream_finish(rs2::EndReason reason) {
  if (!stream_finish_main(reason) || g_stream.publisher == nullptr) {
    return;
  }
  stream_sinks_end(reason);
  stream_finish_after_sinks(reason);
}

// GRC_LIVE_AWAIT_HELLO_MS=<ms>
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

// TAG1: GRC_LIVE_AWAIT_HELLOS=N (default 1, a test knob beside GRC_LIVE_AWAIT_HELLO_MS) holds
// the frame until N connections said hello, so viewers started together share their first frame
// (and so number their transactions alike).
uint64_t g_live_await_hellos = 1;

bool live_any_hello() {
  uint64_t hellos = 0;
  for (const rs2::ConnectionSummary &s : g_live.hub->summaries()) {
    if (!s.stream_id.empty()) {
      ++hellos;
    }
  }
  return hellos >= g_live_await_hellos;
}

void live_await_first_hello(uint64_t frame) {
  if (g_live_await.checked) {
    return;
  }
  g_live_await.checked = true;
  if (g_live.hub == nullptr || g_live.carriers == nullptr || g_live.stopped) {
    return;
  }
  if (!env_positive("GRC_LIVE_AWAIT_HELLO_MS", 0, &g_live_await.timeout_ms)) {
    log_line("live: await-hello: ignoring an invalid GRC_LIVE_AWAIT_HELLO_MS (a positive ms)");
    return;
  }
  if (!env_positive("GRC_LIVE_AWAIT_HELLOS", 1, &g_live_await_hellos)) {
    g_live_await_hellos = 1;
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

// GRC_LIVE_HOLD_WINDOWS=
// [<step>:]<from>-<to>,... (the receiver's RS_RECEIVER_SHOT_WINDOWS format, a test knob beside
// GRC_LIVE_AWAIT_HELLO_MS) holds the host's whole timeline at each window's last frame `to` until
// every streaming connection has applied (or submitted) a transaction from inside the window.
// Sends happen only in the frame callback, so the hold has two phases: before this frame's publish,
// until each lagging connection has a free credit slot; after it, until each one's newest
// applied or submitted ack names a frame >= `from`. A receiver that kept up acked one before `to`,
// so for it the hold is a no-op; a slow one can no longer fold past a window, nor see the host run
// through one with no transaction in it. A `<q>-<q>` window marks the timeline's last frame q
// (the fixture's quit) and holds it until every receiver applied q itself. GRC_LIVE_HOLD_MS caps each phase (default 10000); a cap that runs out
// logs "timed out" and the host goes on as it would have. Off (unset) by default, so a real-time
// host is byte for byte what it was.
// GRC_LIVE_HOLD_RECOVERY_FRAMES=<n> (a stall leg's knob beside it) holds, after the publish, a
// callback whose send ended a pending episode of at least n frames (a receiver stall's recovery)
// until every receiver applied it: a stall leaves both credit slots of window 2 free at once, so
// without it the next frame's send can arrive before the recovery is applied and fold it away,
// and the post-stall shot shows that later send instead (a stale-coalesce sabotage then looks
// one frame stale, or not stale at all).
struct LiveHold {
  bool checked = false;
  std::vector<std::pair<uint64_t, uint64_t>> windows;  // (from, to)
  uint64_t recovery_frames = 0;
  uint64_t cap_ms = 10000;
};
LiveHold g_live_hold;

void live_hold_config() {
  if (g_live_hold.checked) {
    return;
  }
  g_live_hold.checked = true;
  if (!env_positive("GRC_LIVE_HOLD_RECOVERY_FRAMES", 0, &g_live_hold.recovery_frames)) {
    log_line("live: hold: ignoring an invalid GRC_LIVE_HOLD_RECOVERY_FRAMES (a positive count)");
    g_live_hold.recovery_frames = 0;
  }
  if (!env_positive("GRC_LIVE_HOLD_MS", 10000, &g_live_hold.cap_ms)) {
    log_line("live: hold: ignoring an invalid GRC_LIVE_HOLD_MS (a positive ms)");
    g_live_hold.cap_ms = 10000;
  }
  if (g_live_hold.recovery_frames != 0) {
    log_line("live: hold: recoveries after " + std::to_string(g_live_hold.recovery_frames) +
             " pending frames, cap " + std::to_string(g_live_hold.cap_ms) + " ms");
  }
  const char *raw = std::getenv("GRC_LIVE_HOLD_WINDOWS");
  if (raw == nullptr || *raw == '\0') {
    return;
  }
  std::string spec(raw);
  std::size_t at = 0;
  while (at <= spec.size()) {
    std::size_t comma = spec.find(',', at);
    if (comma == std::string::npos) {
      comma = spec.size();
    }
    std::string item = spec.substr(at, comma - at);
    const std::size_t colon = item.find(':');
    if (colon != std::string::npos) {
      item = item.substr(colon + 1);
    }
    const std::size_t dash = item.find('-');
    char *end_from = nullptr;
    char *end_to = nullptr;
    const std::string from_text = dash == std::string::npos ? "" : item.substr(0, dash);
    const std::string to_text = dash == std::string::npos ? "" : item.substr(dash + 1);
    const unsigned long long from = std::strtoull(from_text.c_str(), &end_from, 10);
    const unsigned long long to = std::strtoull(to_text.c_str(), &end_to, 10);
    if (from_text.empty() || to_text.empty() || *end_from != '\0' || *end_to != '\0' || from > to) {
      log_line("live: hold: ignoring GRC_LIVE_HOLD_WINDOWS (want [<step>:]<from>-<to>,...): " +
               spec);
      g_live_hold.windows.clear();
      return;
    }
    g_live_hold.windows.emplace_back(from, to);
    at = comma + 1;
  }
  log_line("live: hold: " + std::to_string(g_live_hold.windows.size()) + " windows, cap " +
           std::to_string(g_live_hold.cap_ms) + " ms");
}

bool live_hold_on() {
  live_hold_config();
  return g_live.hub != nullptr && g_live.carriers != nullptr && !g_live.stopped && !g_live.ending;
}

// The latest `from` of the windows whose last frame is `frame` (a quit window `q-q` beside a shot
// window ending at q wins: q itself must be applied), or 0 when none ends there.
uint64_t live_hold_from(uint64_t frame) {
  if (!live_hold_on()) {
    return 0;
  }
  uint64_t from = 0;
  for (const auto &w : g_live_hold.windows) {
    if (w.second == frame) {
      from = std::max<uint64_t>(from, std::max<uint64_t>(w.first, 1));
    }
  }
  return from;
}

// After the publish of `frame`: the frame every receiver must have applied before the timeline
// goes on -- the window's `from` when `frame` ends one, `frame` itself when this callback sent a
// stall's recovery (GRC_LIVE_HOLD_RECOVERY_FRAMES) -- or 0 for no hold.
uint64_t live_hold_after_publish(uint64_t frame) {
  if (!live_hold_on()) {
    return 0;
  }
  if (g_live_hold.recovery_frames != 0 &&
      g_live.hub->backlog_sent_frames() >= g_live_hold.recovery_frames) {
    return frame;
  }
  return live_hold_from(frame);
}

// One phase of the hold at `frame`: drains until no lagging connection is blocked on credit
// (`credit`), or none lags at all, or the cap runs out. Logs only a phase that actually waited.
// `drain_frame` stamps what arrives meanwhile: `frame` before the publish (as the callback's own
// drain does), `frame + 1` after it -- without the hold those events would have been drained at
// the next callback, so a GET for a payload this callback's send named stays after that send
// (gets-advertised) -- except at a single-frame (quit) window, after which only live_finish's
// drain at `frame` follows.
void live_hold_phase(uint64_t frame, uint64_t from, bool credit, uint64_t drain_frame) {
  const auto done = [&]() {
    const rs2::Hub::HoldView v = g_live.hub->hold_view(from);
    return credit ? v.blocked == 0 : v.lagging == 0;
  };
  if (done()) {
    return;
  }
  const uint64_t start_ns = monotonic_ns();
  const uint64_t deadline_ns = start_ns + g_live_hold.cap_ms * 1000000ull;
  bool ok = false;
  while (!(ok = done()) && !g_live.stopped && monotonic_ns() < deadline_ns) {
    std::this_thread::sleep_for(std::chrono::milliseconds(1));
    live_drain(drain_frame);
  }
  log_line("live: hold: held frame " + std::to_string(frame) + " (window from " +
           std::to_string(from) + ") " + std::to_string((monotonic_ns() - start_ns) / 1000000ull) +
           " ms " + (credit ? "for credit" : "for an apply") + ", " +
           (ok ? std::string("released") : std::string("timed out")));
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
// PM1 (render-stream-11.md "As built (PM1)" rule 12): the mirror's notes of the multimeshes whose
// version moved, as the hook log's `state` lines (each stamped with the frame of the snapshot that
// took it). Taken at every publication so they never accumulate; written only with the log open.
void multimesh_states_log() {
  if (!rs::mirror_instance().multimesh_options().state_notes) {
    return;
  }
  const std::vector<rs::Mirror::MultimeshStateNote> notes =
      rs::mirror_instance().take_multimesh_states();
  if (notes.empty() || !rs::resource_log().active()) {
    return;
  }
  rs::TapContext ctx;
  ctx.t_ns = monotonic_ns();
  ctx.main_thread = true;
  for (const rs::Mirror::MultimeshStateNote &note : notes) {
    const rs2::MultimeshEntry &e = note.entry;
    rs::MultimeshState state;
    state.frame = note.frame;
    state.rid = note.rid;
    state.id = e.id;
    state.version = e.version;
    state.instances = e.instances;
    state.format = rs2::to_wire(e.format);
    state.colors = e.colors;
    state.custom = e.custom;
    state.visible = e.visible;
    state.mesh = e.has_mesh ? e.mesh : 0;
    state.status = rs2::to_wire(e.status);
    state.reason = e.status == rs2::MultimeshStatus::Unsupported && e.has_reason
                       ? rs2::to_wire(e.reason)
                       : nullptr;
    state.buffer = note.shadow.get();
    rs::resource_log().multimesh_state(ctx, state);
  }
}

// HC1 test knob (see stream_publish): GRC_HC_SABOTAGE=pin-late, read at the first publish.
bool g_hc_pin_late = false;
unsigned g_hc_pin_late_frames = 0;
// HC3 test knob (never declared on the wire): GRC_HC_SABOTAGE=dyn-hash-unread -- a viewer below /11
// does not count as a reader of dynamic mesh hashes (run-hc1.sh's late-join-v8-on-v11 catches it).
bool g_hc_dyn_hash_unread = false;

// PM5 (render-stream-12.md "Hook log and counters"): the particles `state` lines, likewise.
std::string particles_state_json(const rs2::ParticlesEntry &e) {
  rs::MultimeshArgs a;
  const bool freed = e.status == rs2::ParticlesStatus::Freed;
  a.str("status", rs2::to_wire(e.status))
      .str("reason", e.status == rs2::ParticlesStatus::Unsupported && e.has_reason
                         ? rs2::to_wire(e.reason)
                         : nullptr)
      .i64("version", static_cast<int64_t>(e.version))
      .str("mode", e.mode_2d ? "2d" : "3d")
      .boolean("emitting", e.emitting)
      .i64("amount", e.amount)
      .boolean("one_shot", e.one_shot)
      .i64("fixed_fps", e.fixed_fps)
      .boolean("interpolate", e.interpolate)
      .boolean("fractional_delta", e.fractional_delta)
      .boolean("local", e.local)
      .str("draw_order", rs2::particles_draw_order_wire(e.draw_order))
      .str("transform_align", rs2::particles_transform_align_wire(e.transform_align))
      .boolean("trails", e.trails)
      .i64("trail_poses", e.trail_poses)
      .i64("seed", e.seed)
      .i64("restarts", static_cast<int64_t>(e.restarts))
      .i64("emits", static_cast<int64_t>(e.emits))
      .i64("process_requests", static_cast<int64_t>(e.process_requests))
      .id("process_material", freed ? 0 : e.process_material);
  std::string passes = "[";
  for (std::size_t k = 0; !freed && k < e.draw_passes.size(); ++k) {
    passes += k == 0 ? "" : ",";
    passes += e.draw_passes[k] == 0 ? "null" : std::to_string(e.draw_passes[k]);
  }
  passes += "]";
  a.raw("draw_passes", passes).id("subemitter", freed ? 0 : e.subemitter);
  if (freed || e.floats == nullptr) {
    a.raw("floats", "null");
  } else {
    a.floats("floats", e.floats->data(), e.floats->size());
  }
  return a.text().substr(1);  // without the leading comma
}

void particles_states_log() {
  if (!rs::mirror_instance().particles_options().state_notes) {
    return;
  }
  const std::vector<rs::Mirror::ParticlesStateNote> notes =
      rs::mirror_instance().take_particles_states();
  if (notes.empty() || !rs::resource_log().active()) {
    return;
  }
  rs::TapContext ctx;
  ctx.t_ns = monotonic_ns();
  ctx.main_thread = true;
  for (const rs::Mirror::ParticlesStateNote &note : notes) {
    rs::resource_log().particles_state(ctx, note.frame, note.rid, note.entry.id,
                                       particles_state_json(note.entry));
  }
}

// after the snapshot (so a new item's `published` says
// whether this snapshot carries it), the union the granted viewers ask, then the items created
// since the watermark, within the budget, handed to the hub's formation side.
void item_meta_frame(uint64_t frame) {
  const uint64_t version = g_live.hub != nullptr ? g_live.hub->item_meta_version() : 0;
  if (version != g_meta.hub_version) {
    g_meta.hub_version = version;
    rs::item_meta::Request want =
        g_live.hub != nullptr ? g_live.hub->item_meta_union() : rs::item_meta::Request();
    const bool file = g_stream.publisher != nullptr && g_stream.publisher->item_meta_on();
    if (file) {
      // The file sinks' request joins the viewers' union.
      const std::uint32_t fields = want.field_bits() | g_meta.file.field_bits();
      want.fields.clear();
      for (int i = 0; i < rs::item_meta::kFieldCount; ++i) {
        if ((fields & rs::item_meta::field_bit(i)) != 0) {
          want.fields.push_back(rs::item_meta::kFieldNames[i]);
        }
      }
      for (const std::string &g : g_meta.file.groups) {
        if (std::find(want.groups.begin(), want.groups.end(), g) == want.groups.end()) {
          want.groups.push_back(g);
        }
      }
      for (const std::string &k : g_meta.file.meta_keys) {
        if (std::find(want.meta_keys.begin(), want.meta_keys.end(), k) == want.meta_keys.end()) {
          want.meta_keys.push_back(k);
        }
      }
    }
    g_meta.host.set_union(want, frame);
    g_meta.on = g_meta.host.on();
  }
  if (!g_meta.on) {
    return;
  }
  std::shared_ptr<const rs::item_meta::Batch> batch = g_meta.host.pass(rs::mirror_instance(), frame);
  if (batch == nullptr) {
    return;
  }
  if (g_live.hub != nullptr) {
    g_live.hub->item_meta_batch(batch);
  }
  if (g_stream.publisher != nullptr && g_stream.publisher->item_meta_on()) {
    g_stream.publisher->item_meta_batch(batch);
  }
}

void stream_publish(uint64_t frame) {
  if (g_stream.status != "open") {
    return;
  }
  ++g_api_arm.published;
  static const bool hc_knob = [] {
    const char *v = std::getenv("GRC_HC_SABOTAGE");
    g_hc_pin_late = v != nullptr && std::string(v) == "pin-late";
    g_hc_dyn_hash_unread = v != nullptr && std::string(v) == "dyn-hash-unread";
    return true;
  }();
  (void)hc_knob;
  if (g_stream.spurious_frame != 0 && frame == g_stream.spurious_frame) {
    // spurious-texture-update: a version bump with identical bytes, and
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
  if (const uint64_t hold_from = live_hold_from(frame)) {  // LF1: off unless GRC_LIVE_HOLD_WINDOWS
    live_hold_phase(frame, hold_from, true, frame);
  }
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
  // With a live server the served set holds the current state's payloads, pinned
  // before a transaction naming them goes out. only while somebody
  // reads the stream. A listener with no connection that has sent a hello takes no snapshot of
  // its own (a file sink's still runs), and the first hello's callback is a viewer callback, so
  // its snapshot is pinned before that connection's first transaction is sent, exactly as when
  // every callback snapshotted. Payloads an earlier viewer left in the served set stay servable
  // (in-flight GETs of a viewer that just dropped) until the next viewer's retire() replaces them.
  const bool serving = g_live.hub != nullptr && g_live.served != nullptr && !g_live.stopped &&
                       g_live.hub->has_viewer();
  if (g_stream.publisher == nullptr && !live_wants && !serving) {
    multimesh_states_log();
    particles_states_log();  // PM1: a free's last state, even without a snapshot
    if (g_live.hub != nullptr) {
      g_live.hub->on_frame(frame, monotonic_ns(), nullptr, epoch, 0);
    }
    return;
  }
  // a /11 snapshot hashes its dynamic mesh surfaces only for a
  // reader of those hashes -- the hook log (its serve events name payloads) or a viewer below /11.
  rs::mirror_set_dynamic_hash_readers(
      rs::resource_log().wants_lines() ||
      (g_live.hub != nullptr && !g_hc_dyn_hash_unread && g_live.hub->has_connection_below_v11()));
  const uint64_t t0 = monotonic_ns();
  rs::Captured snapshot = rs::mirror_snapshot(0, frame);
  uint64_t snapshot_ns = monotonic_ns() - t0;
  if (g_meta.grant != 0) {
    item_meta_frame(frame);  // TAG1: off, one branch; on, the frame's new items
  }
  if (g_hc_shadow) {
    // HC4a: the shadow oracle found the persistent tables and the full walk apart (HC4b: or the
    // budget's or serving's walks over the payload maps' differences, at an earlier callback).
    std::string mismatch = rs::mirror_instance().hc_shadow_failure();
    if (mismatch.empty() && !g_hc_shadow_budget.empty()) {
      mismatch = g_hc_shadow_budget;
    }
    if (!mismatch.empty()) {
      log_line("stream: hc-shadow-mismatch at frame " + std::to_string(frame) + ": " + mismatch);
      g_stream.reason = "hc-shadow-mismatch: " + mismatch;
      stream_finish(rs2::EndReason::Shutdown);
      return;
    }
  }
  multimesh_states_log();
  particles_states_log();  // PM1 rule 12: this frame's `state` lines
  if (g_state.evidence_ready) {
    g_perf.snapshot_us.add(snapshot_ns / 1000);  // Q3d snapshot_us (G6r)
  }
  // the publication hold-back. A snapshot naming a texture
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
  // The retained payloads -- the mirror's current ones, those the previous
  // publication still pins and (G2c2) those still servable over HTTP -- stay within
  // GRC_RESOURCE_BUDGET_BYTES.
  {
    // P3-CAP: the union's bytes without copying the maps into one (payload_union_bytes).
    std::vector<const rs::PayloadMap *> retained = {&snapshot.payloads};
    if (g_stream.publisher != nullptr && g_stream.publisher->last_published() != nullptr) {
      retained.push_back(&g_stream.publisher->last_published()->payloads);
    }
    uint64_t retained_bytes = rs::payload_union_bytes(retained);
    if (g_hc_shadow && g_hc_shadow_budget.empty() &&
        retained_bytes != rs::payload_union_bytes_full(retained)) {
      // HC4b: the union over the maps' differences disagrees with the full walk's.
      g_hc_shadow_budget = "budget: the retained union's bytes (" + std::to_string(retained_bytes) +
                           ") differ from the full walk's (" +
                           std::to_string(rs::payload_union_bytes_full(retained)) + ")";
    }
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
        shared = g_stream.publisher->last_published_shared();  // HC5: no copy
      }
      published = shared.get();
    }
    std::vector<rs::ServeEvent> events;
    // SERVED-MAP: a serve event is only a hook-log line, and building one spells its key back out.
    // With the log off (GRC_HOOK_LOG=off, HC1) nothing would read the events, so none is built.
    std::vector<rs::ServeEvent> *const serve_events =
        rs::resource_log().wants_lines() ? &events : nullptr;
    // HC1 sabotage `pin-late` (env GRC_HC_SABOTAGE, a test knob, never declared on the wire): the
    // first hello's snapshot is not pinned before the send -- no pin, no retire for the first 30
    // callbacks with a viewer -- so the first transaction names payloads that answer 404.
    const bool pin_late = serving && g_hc_pin_late && g_hc_pin_late_frames++ < 30;
    if (serving && !pin_late) {
      // wrong-hash (G2b2/G2c2): the store corrupted its copy at this publish; serve the same.
      if (g_stream.store != nullptr && !g_stream.store->corrupted_hash().empty()) {
        g_live.served->corrupt(g_stream.store->corrupted_hash());
      }
      // Phase 1: everything the hub may send now is servable before it goes out.
      std::vector<const rs::PayloadMap *> sendable = g_live.hub->held_payloads();
      sendable.insert(sendable.begin(), &published->payloads);
      g_live.served->pin(sendable, frame, serve_events);
    }
    g_live.hub->on_frame_shared(frame, monotonic_ns(), shared, publish_epoch, snapshot_ns);
    if (serving && !pin_late) {
      // Phase 2: retained := current ∪ every connection's base; the rest is retired.
      g_live.served->retire(published->payloads, g_live.hub->base_payloads(), frame, serve_events);
      if (g_hc_shadow && g_hc_shadow_budget.empty()) {
        g_hc_shadow_budget = g_live.served->shadow_failure();  // HC4b: serving's own oracle
      }
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

void do_disarm(const char *phase);
void arm_release();
void swap_cycle_armed();

std::string api_arm_failure() {
  if (g_live.status == "failed") return "listen-bind";
  if (g_live.status == "listening" && !g_live.listen.empty() &&
      (g_live.carriers == nullptr || !g_live.carriers->started(live::kCarrierWs) ||
       g_live.port == 0)) return "listen-bind";
  if (g_live.status == "refused") return "listen-refused";
  if (g_stream.status == "off") return "no-sink";
  if (g_stream.status == "open-failed") return "stream-open-failed";
  return "stream-refused";
}

bool inflight_ready(bool blocking);
void api_arm_rollback(const std::string &reason) {
  live::gd_tracks_builtin_discard_pending();
  const bool opened = g_stream.status == "open";
  stream_finish(rs2::EndReason::Disarm);
  if (!opened) {
    // Startup can begin resource work before a sink opens; stream_finish only closes open streams.
    workers_finish();
    encoders_finish();
    if (rs::adopt_resources_active()) {
      rs::adopt_warm_finish();
      emit("warm.json", rs::adopt_warm_json(g_rearm.arm_index, g_state.frames_total));
      rs::adopt_reload_finish();
      emit("reload.json", rs::adopt_reload_json(g_rearm.arm_index, g_state.frames_total));
      rs::adopt_resources_end();
    }
    rs::mirror_enable(false);
  }
  // LS3: a failed arm is torn down as a disarm is (Q3), on the main thread: a carrier that did
  // start is stopped here (an error path, never the swap's), then everything is released.
  g_live.close_async = false;
  live_linger(true);
  if (g_live.hub == nullptr && g_live.carriers != nullptr) {
    g_live.carriers->stop();  // started carriers with no hub (the arm failed before it)
  }
  do_disarm("api");
  inflight_ready(true);
  arm_release();
  g_state.evidence_dir = g_rearm.evidence_root;
  g_state.standby = true;
  decide("standby", "arm-failed: " + reason);
  g_api->arm_failed(reason);
  if (g_swap.on) {
    log_line("swap-cycle: the arm failed (" + reason + "); the cycle stops");
    g_swap.on = false;
  }
}

// LS3: every arm starts from the state a capture that never armed has, but for the per-load
// fields: the stream and live structs are rebuilt for a re-arm, each arm k >= 2 gets its own
// evidence directory and recordings, and the one-shot flags of the frame path are cleared.
bool arm_prepare() {
  const uint64_t k = g_rearm.arm_index;
  g_state.evidence_dir = g_rearm.evidence_root;
  if (k >= 2) {
    Stream stream;
    g_stream = std::move(stream);
    Live live;
    live.listen = g_live.listen;
    live.net_module = g_live.net_module;  // loaded once, never unloaded (D8)
    g_live = std::move(live);
    if (g_state.evidence_ready) {
      g_state.evidence_dir = path_join(g_rearm.evidence_root, "arm-" + std::to_string(k));
      if (!make_directories(g_state.evidence_dir)) {
        log_line("cannot create evidence directory " + g_state.evidence_dir);
        return false;
      }
    }
    g_perf.frame_interval_us = Histogram();
    g_perf.frame_callback_us = Histogram();
    g_perf.snapshot_us = Histogram();
  }
  const std::string suffix = k >= 2 ? ".arm-" + std::to_string(k) : std::string();
  g_stream.path = g_rearm.stream_out.empty() ? std::string() : g_rearm.stream_out + suffix;
  g_stream.patch_path = g_rearm.patch_out.empty() ? std::string() : g_rearm.patch_out + suffix;
  g_state.frames_armed = 0;
  g_state.disarmed = false;
  g_state.disarm_frame = -1;
  g_api_arm.published = 0;
  g_live_await = LiveAwaitHello();
  g_live_await_hellos = 1;
  g_live_hold = LiveHold();
  g_meta.hub_version = ~uint64_t{0};
  g_hc_pin_late_frames = 0;
  g_rearm.window_id = 0;
  g_rearm.min_recorded = false;
  g_rearm.min_written = false;
  g_rearm.min_restore = "none";
  // PM5: the predraw pump follows the arm (the callable is made once, the connection per arm).
  if (g_state.pump && !g_state.pump_connected) {
    std::string why;
    g_state.pump_connected = rs::predraw_pump_connect(&why);
    log_line(g_state.pump_connected ? std::string("predraw pump: connected")
                                    : "predraw pump: " + why);
  }
  return true;
}

// Environment arms remain inline; API arms arrive at the same frame boundary as deferred arms.
void arm_now(const char *source) {
  const bool api = std::string(source) == "api";
  const uint64_t start_ns = monotonic_ns();
  g_api_arm.frame = g_state.frames_total;
  if (!api) g_api->arm_point();
  if (!g_state.shadow.publish(ShadowVtable::Table::Armed)) {
    log_line("arm: the singleton's vptr is not ours to replace");
    if (api) api_arm_rollback("vtable-replaced");
    else refuse("arm-failed");
    return;
  }
  g_state.armed = true;
  g_rearm.arm_index = g_api->arm_count();
  if (!arm_prepare()) {
    api_arm_rollback("evidence-dir");
    return;
  }
  perf_arm();
  stream_start();
  // API clients need a usable ws descriptor even when another carrier started successfully.
  const bool api_listener_ready = !api ||
      (g_live.carriers != nullptr && g_live.carriers->started(live::kCarrierWs) &&
       g_live.port > 0);
  const bool ok = g_stream.status == "open" &&
                  (g_live.listen.empty() || (g_live.status == "listening" && api_listener_ready));
  if (api && !ok) {
    api_arm_rollback(api_arm_failure());
    return;
  }
  if (g_state.evidence_ready) {
    touch_file(path_join(g_state.evidence_dir, "armed.marker"));
  }
  decide("armed", std::string());
  g_api_arm.ms = double(monotonic_ns() - start_ns) / 1e6;
  g_api->armed(api_arm_info(), !api || g_api_fault != "api-early-armed");
  if (!ok) g_api->stream_ended(api_arm_failure());
  if (g_swap.on) swap_cycle_armed();
}

void api_arm_point() {
  g_state.api_pending_arm = false;
  g_state.standby = false;
  rs::settings_install(g_api->arm_point());
  arm_now("api");
}

// Runs the full check pipeline, and arms when asked to. `phase` names the
// callback it runs from, for the log. Returns true once a decision was made.
bool attempt(const char *phase) {
  if (g_state.decided) {
    return true;
  }
  // LS0: a deferred arm's retries (hooks patched, defer frame not reached) log nothing; the first
  // attempt, the deferral and the arm itself are each one line.
  const bool deferred_retry = g_state.hooks_patched && g_state.defer_arm_frames != 0 &&
                              g_state.frames_total < g_state.defer_arm_frames;
  if (!deferred_retry) {
    log_line(std::string("attempting at ") + phase + " in mode " + g_state.mode);
  }
  if (!g_state.validation_log_error.empty()) {
    refuse("invalid-validation-log");
    return true;
  }

  // LATE-SPINE: the checks run once, before the vtable is patched; a deferred arm's later
  // attempts re-run the slot-mask/behaviour checks on the now-patched vtable and would refuse.
  if (!g_state.hooks_patched) {
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

  // HSD (render-stream-12.md "Headless defaults (HSD)"): GRC_HEADLESS_CANVAS_TEXTURE,
  // GRC_HEADLESS_PARTICLES and GRC_PREDRAW_PUMP unset (or `auto`) default on for a headless host at
  // /12+ and off otherwise; an explicit value is taken as given. Resolved here, where the display
  // server is known, so validate predicts arm.
  {
    const char *ct = std::getenv("GRC_HEADLESS_CANVAS_TEXTURE");
    const char *pt = std::getenv("GRC_HEADLESS_PARTICLES");
    const char *pump = std::getenv("GRC_PREDRAW_PUMP");
    const bool on =
        rs::headless_defaults_apply(g_state.display_server, std::getenv("GRC_STREAM_VERSION"));
    g_state.headless_defaults = on;
    g_state.ct_shim_defaulted = on && (ct == nullptr || std::strcmp(ct, "auto") == 0);
    g_state.ct_shim_env = rs::resolve_headless_default(ct, on, "synthesize", "");
    g_state.ct_shim_env_set = ct != nullptr || on;
    g_state.pt_shim_env = rs::resolve_headless_default(pt, on, "synthesize", "");
    g_state.pump_env = rs::resolve_headless_default(pump, on, "1", "");
    if (on) {
      log_line("headless defaults (/12+ on a headless host): GRC_HEADLESS_CANVAS_TEXTURE=" +
               g_state.ct_shim_env + " GRC_HEADLESS_PARTICLES=" + g_state.pt_shim_env +
               " GRC_PREDRAW_PUMP=" + g_state.pump_env);
    }
  }

  // The headless CanvasTexture shim (the default on a headless host at /12+). It hands the engine RIDs the server never returned, which only the dummy rasterizer
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

  // PM5 (render-stream-12.md "Headless shims (opt-in)"): the particles RID shim and the pre-draw
  // pump, both off by default and armed only on a `headless` display server; an invalid value, or
  // either asked for on another display server, refuses the capture like the canvas-texture shim.
  {
    std::string why;
    bool ok = rs::parse_particles_shim_mode(g_state.pt_shim_env.c_str(), &g_state.pt_shim_mode,
                                            &why) &&
              rs::parse_predraw_pump(g_state.pump_env.c_str(), &g_state.pump, &why);
    if (!ok) {
      log_line("particles shims: " + why);
      why = "particles-shim-invalid";
    } else {
      ok = rs::particles_shim_may_arm(g_state.pt_shim_mode, g_state.display_server, &why);
      if (ok && g_state.pump && g_state.display_server != "headless") {
        ok = false;
        why = "predraw-pump-not-headless";
      }
    }
    if (!g_state.pt_shim_env.empty() || !g_state.pump_env.empty()) {
      g_state.checks.push_back({"particles_shims", ok,
                                "GRC_HEADLESS_PARTICLES=" + g_state.pt_shim_env +
                                    " GRC_PREDRAW_PUMP=" + g_state.pump_env + " display_server=" +
                                    g_state.display_server + (ok ? std::string() : " -> " + why)});
    }
    if (!ok) {
      rs::particles_shim().configure(rs::ParticlesShimMode::Off);
      refuse(why);
      return true;
    }
  }

  // HTR (rs_texture_release.h): GRC_HEADLESS_TEXTURE_RELEASE. Unlike the shims above, `on` on a
  // rendered host is ignored, typed and logged, not refused: off is always safe there. Only an
  // invalid value (or fault knob) refuses the capture. Decided in both modes, so validate predicts
  // arm.
  {
    const char *htr = std::getenv("GRC_HEADLESS_TEXTURE_RELEASE");
    const char *fault = std::getenv("GRC_HEADLESS_TEXTURE_RELEASE_FAULT");
    g_state.htr_env_set = htr != nullptr;
    g_state.htr_env = htr != nullptr ? htr : "";
    std::string why;
    const bool ok = rs::parse_texture_release(htr, &g_state.htr_mode, &why) &&
                    rs::parse_texture_release_fault(fault, &g_state.htr_fault, &why);
    if (!ok) {
      log_line("headless texture release: " + why);
      g_state.htr_env_set = true;  // reported, so the refusal is visible in result.json
      g_state.htr_state = "refused";
      g_state.htr_reason = "headless-texture-release-invalid";
      g_state.checks.push_back({"headless_texture_release", false,
                                "GRC_HEADLESS_TEXTURE_RELEASE=" + g_state.htr_env + " -> " +
                                    g_state.htr_reason});
      emit_headless_texture_release();
      refuse(g_state.htr_reason);
      return true;
    }
    const rs::TextureReleaseDecision d =
        rs::resolve_texture_release(g_state.htr_mode, g_state.display_server);
    g_state.htr_state = d.state;
    g_state.htr_reason = d.reason;
    if (g_state.htr_env_set) {
      g_state.checks.push_back({"headless_texture_release", true,
                                "GRC_HEADLESS_TEXTURE_RELEASE=" + g_state.htr_env +
                                    " display_server=" + g_state.display_server + " -> " +
                                    g_state.htr_state});
      log_line("headless texture release: " + g_state.htr_state +
               (g_state.htr_reason.empty()
                    ? std::string()
                    : " (" + g_state.htr_reason + ", display_server=" + g_state.display_server +
                          ")") +
               (g_state.htr_fault != rs::TextureReleaseFault::None
                    ? std::string(" fault=") + rs::texture_release_fault_name(g_state.htr_fault)
                    : std::string()));
    }
  }

  g_api_fault = env_string("GRC_API_FAULT");
  if (!g_api_fault.empty() && g_api_fault != "api-early-armed" &&
      g_api_fault != "disarm-joins-on-main") {
    refuse("api-fault-invalid");
    return true;
  }
  // LS1: GRC_STANDBY_FAULT, parsed in every mode so validate predicts arm and standby.
  {
    std::string why;
    if (!rs::parse_standby_fault(std::getenv("GRC_STANDBY_FAULT"), &g_state.standby_fault, &why)) {
      log_line("standby: " + why);
      refuse("standby-fault-invalid");
      return true;
    }
  }

  if (g_state.mode != "arm" && g_state.mode != "standby") {
    decide("validated", std::string());
    return true;
  }
  }  // !g_state.hooks_patched: the checks run once

  // One-time setup, run with the vptr store only: with GRC_ARM_DEFER_FRAMES the attempt returns
  // false each deferred frame and is re-called, and none of this is idempotent -- the shims'
  // configure() resets their RID tables (two CanvasTextures made in different deferred frames
  // would share a private RID) and a second predraw_pump_connect fails (the engine then logs an
  // error every frame).
  if (!g_state.hooks_patched) {
    hooks_init_image_binds();
    // HTR: the placeholder is made here, on the main thread before the vptr store (not at the
    // stream start: a create the hooks see before the arm must already find it under the fault
    // knob), and the hook's flags are set once.
    if (g_state.htr_state == "active") {
      std::string why;
      if (!hooks_release_placeholder_create(&why)) {
        log_line("headless texture release: " + why + " -> ignored");
        g_state.htr_state = "ignored";
        g_state.htr_reason = "placeholder-unavailable";
      }
    }
    rs::texture_release_configure(
        (g_state.htr_state == "active" ? rs::kReleaseActive : 0u) |
        (g_state.htr_env_set ? rs::kReleaseTimed : 0u) |
        (g_state.htr_state == "active" &&
                 g_state.htr_fault == rs::TextureReleaseFault::IgnorePredicate
             ? rs::kReleaseFaultIgnorePredicate
             : 0u));
    emit_headless_texture_release();
    // PM5: configured before the vptr store, so the first hooked particles_create already sees it.
    rs::particles_shim().configure(g_state.pt_shim_mode);
    if (g_state.pt_shim_mode == rs::ParticlesShimMode::Synthesize) {
      log_line("particles shim: synthesize armed (display server " + g_state.display_server + ")");
    }
    // PM5's predraw pump is connected at each arm (arm_prepare), LS3.
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
    // the registry records from the vptr store on, so it
    // is configured here from GRC_ADOPT (and its two GRC_ADOPT_FAULT knobs), before the first
    // hooked create. The stream setup parses and validates both again at the arm; an invalid
    // value refuses the stream there, so here it only leaves the registry off.
    {
      const char *adopt_env = std::getenv("GRC_ADOPT");
      // GRC_MODE=standby implies GRC_ADOPT=arm (an arm from standby
      // adopts what the registry recorded); an explicit value is taken as given.
      const bool adopt = adopt_env != nullptr ? std::string(adopt_env) == "arm"
                                              : g_state.mode == "standby";
      rs::AdoptFault fault = rs::AdoptFault::None;
      std::string fault_error;
      rs::RegistryFault registry_fault = rs::RegistryFault::None;
      if (rs::parse_adopt_fault(std::getenv("GRC_ADOPT_FAULT"), adopt, &fault, &fault_error)) {
        if (fault == rs::AdoptFault::RegistryOff) {
          registry_fault = rs::RegistryFault::Off;
        } else if (fault == rs::AdoptFault::RegistryKeepFreed) {
          registry_fault = rs::RegistryFault::KeepFreed;
        } else if (fault == rs::AdoptFault::RegistrySkipParams) {
          registry_fault = rs::RegistryFault::SkipParams;  // LAR3
        } else if (fault == rs::AdoptFault::RegistryDropBinding) {
          registry_fault = rs::RegistryFault::DropBinding;  // LAR4
        } else if (fault == rs::AdoptFault::RegistrySkipParticles) {
          registry_fault = rs::RegistryFault::SkipParticles;  // LAR5
        }
      }
      rs::registry_configure(adopt, registry_fault);
      if (adopt) {
        log_line(std::string("registry: ") + (rs::registry_on() ? "recording" : "off") +
                 " (fault " + rs::registry_fault_name(registry_fault) + ")");
      }
    }
    // both tables are built once, here; the standby table is
    // published first, whatever the mode, and an arm is one more store to the armed table.
    // GRC_STANDBY_FAULT edits only the standby table's membership.
    for (size_t i = 0; i < g_state.plan.replacements.size(); ++i) {
      g_state.plan.replacements[i].standby =
          rs::standby_hook_under(g_state.plan.planned[i], g_state.standby_fault);
    }
    std::string arm_error;
    const bool built =
        g_state.shadow.build(g_state.facts.singleton, static_cast<size_t>(g_state.calib.slot_count),
                             g_state.plan.replacements, &arm_error);
    if (built && !g_state.shadow.publish(ShadowVtable::Table::Standby)) {
      arm_error = "the singleton's vptr is not the engine's";
    }
    if (!built || g_state.shadow.published() != ShadowVtable::Table::Standby) {
      log_line("arm: " + arm_error);
      if (g_state.ct_shim_state == "armed") {
        rs::canvas_texture_shim().configure(rs::CanvasTextureShimMode::Off, g_state.display_server);
        g_state.ct_shim_state = "refused";
        g_state.ct_shim_reason = "arm-failed";
      }
      rs::particles_shim().configure(rs::ParticlesShimMode::Off);
      rs::registry_configure(false, rs::RegistryFault::None);
      if (g_state.pump_connected) {
        rs::predraw_pump_disconnect();
        g_state.pump_connected = false;
      }
      refuse("arm-failed");
      return true;
    }
    g_state.hooks_patched = true;
    g_state.vptr_written = true;
    log_line("vtable: standby table published (" + std::to_string(g_state.shadow.standby_slots()) +
             " of " + std::to_string(g_state.shadow.armed_slots()) + " planned slots" +
             (g_state.standby_fault != rs::StandbyFault::None
                  ? std::string(", fault ") + rs::standby_fault_name(g_state.standby_fault)
                  : std::string()) +
             ")");
  }
  if (g_state.mode == "standby") {
    // LS1: loaded, the standby table published, nothing streaming; LS2's arm() leaves this state.
    g_state.standby = true;
    decide("standby", std::string());
    return true;
  }
  // LATE-SPINE: the vtable is patched (the hooks observe resource creation) but the arm itself
  // (adoption/snapshot/publish) is deferred; the frame callback retries and completes it once the
  // defer frame passes.
  if (g_state.defer_arm_frames != 0 && g_state.frames_total < g_state.defer_arm_frames) {
    if (g_api) g_api->loaded(cap::State::Arming);
    if (!g_state.defer_logged) {
      g_state.defer_logged = true;
      log_line("arm deferred until frame " + std::to_string(g_state.defer_arm_frames) +
               " (hooks patched, retries are silent)");
    }
    return false;
  }
  arm_now(phase);
  return true;
}

// LS0: a capture that patched the vtable and never armed (a deferred arm that never came, a
// standby seat) restores it at shutdown and at deinitialize too. do_disarm returns early when not
// armed, so before this the hooks outlived the library's teardown; on a signal-driven exit that
// turned SIGABRT into SIGSEGV.
void restore_unarmed(const char *phase) {
  // LS3: a disarm that published the standby table is restored here too (standby_restore).
  if (g_state.armed || !g_state.vptr_written ||
      g_state.shadow.published() == ShadowVtable::Table::Engine ||
      (!g_state.disarmed && !g_state.unarmed_restore_phase.empty())) {
    return;
  }
  bool was_shadow = false;
  bool restored = false;
  g_state.shadow.disarm(&was_shadow, &restored);
  if (g_state.pump_connected) {
    rs::predraw_pump_disconnect();
    g_state.pump_connected = false;
  }
  if (g_state.disarmed) {
    g_state.standby_restore_phase = phase;
    log_line(std::string("standby restore from ") + phase + " restored=" +
             (restored ? "true" : "false"));
    return;
  }
  g_state.unarmed_restore_phase = phase;
  g_state.unarmed_restore_restored = restored;
  log_line(std::string("unarmed restore from ") + phase + " was_shadow=" +
           (was_shadow ? "true" : "false") + " restored=" + (restored ? "true" : "false"));
}

bool disarm_hooks(const char *phase) {
  if (!g_state.armed) {
    restore_unarmed(phase);
    return false;
  }
  bool was_shadow = false;
  bool restored = false;
  // LS3 (Q3): a disarm while the registry records publishes the standby table, so the registry
  // stays fed for the next arm; shutdown and unload, and a capture without the registry (nothing
  // a re-arm could adopt), restore the engine's.
  const std::string p = phase;
  if (rs::registry_on() && p != "shutdown" && p != "deinitialize" &&
      g_state.shadow.publish(ShadowVtable::Table::Standby)) {
    was_shadow = true;
    g_state.disarm_table = "standby";
  } else {
    g_state.shadow.disarm(&was_shadow, &restored);
    g_state.disarm_table = restored ? "engine" : "none";
  }
  g_state.armed = false;
  if (g_state.pump_connected) {
    rs::predraw_pump_disconnect();  // PM5
    g_state.pump_connected = false;
  }
  g_state.disarmed = true;
  g_state.disarm_was_shadow = was_shadow;
  g_state.disarm_restored = restored;
  g_state.disarm_frame = static_cast<int64_t>(g_state.frames_total);
  log_line(std::string("disarmed from ") + phase + " callback at frame " +
           std::to_string(g_state.frames_total) + " was_shadow=" + (was_shadow ? "true" : "false") +
           " restored=" + (restored ? "true" : "false"));
  return true;
}

void disarm_evidence() {
  if (rs::shader_clock().draw_hooked) {
    // P3-CK: what the hooked clock summed (render-stream-10.md "Shader time").
    const rs::ShaderClock &clock = rs::shader_clock();
    char total[64];
    std::snprintf(total, sizeof(total), "%.17g", clock.total);
    log_line(std::string("shader-clock: source=") + rs::shader_clock_source() +
             " draws=" + std::to_string(clock.draws) + " ticks=" + std::to_string(clock.ticks) +
             " advanced=" + std::to_string(clock.advanced) + " total=" + total +
             " origin=" + rs::shader_clock_origin() +
             " first_tick_process_frames=" + std::to_string(clock.start_process_frames) +
             " first_tick_frames_drawn=" + std::to_string(clock.start_drawn) +
             " draws_missed=" + std::to_string(rs::shader_clock_draws_missed()));
  }
  emit("disarm.json", disarm_json());
  emit_load("counters.json", hooks_counters_json(g_state.frames_total, g_state.frames_armed));
  emit_registry();
  if (rs::texture_cache().enabled()) {
    emit("texture-cache.json", hooks_texture_cache_json());  // G8kc
  }
  emit_canvas_texture_shim();
  emit_headless_texture_release();
  perf_finish();
  emit_load("result.json", result_json());
}

void do_disarm(const char *phase) {
  if (disarm_hooks(phase)) {
    disarm_evidence();
  }
}

// Only the built-in carrier joins leave main. Consumer stops may emit script signals.
void live_close_async_begin() {
  live_close_begin();
  if (g_live.carriers != nullptr) g_live.carriers->stop_consumers();
  g_live.closing = true;
  g_api_teardown.callback_phase = "carrier-stop";
  g_api_teardown.carrier_pending = true;
  g_api_teardown.carriers.run([] {
    if (g_live.carriers != nullptr) g_live.carriers->stop_builtin();
  }, g_api_fault == "disarm-joins-on-main");
}

// --- LS3: the capture's own threads and sockets, and the disarm's accounting -------------------

// Threads named by the capture (rs-ws-io, grc-net-wt, grc-tex, grc-enc, grc-writer, grc-former,
// grc-teardown), counted by name, and the process total.
void thread_census(JsonWriter *json) {
  std::map<std::string, int64_t> named;
  int64_t total = 0;
  if (DIR *dir = opendir("/proc/self/task")) {
    while (const dirent *e = readdir(dir)) {
      if (e->d_name[0] == '.') continue;
      ++total;
      std::FILE *f = std::fopen(("/proc/self/task/" + std::string(e->d_name) + "/comm").c_str(), "r");
      if (f == nullptr) continue;
      char comm[64] = {0};
      if (std::fgets(comm, sizeof(comm), f) != nullptr) {
        std::string name(comm);
        while (!name.empty() && (name.back() == '\n' || name.back() == ' ')) name.pop_back();
        if (name.rfind("grc-", 0) == 0 || name.rfind("rs-ws", 0) == 0) ++named[name];
      }
      std::fclose(f);
    }
    closedir(dir);
  }
  int64_t own = 0;
  json->key("capture_threads").object_begin();
  for (const auto &[name, n] : named) {
    json->field(name, n);
    own += n;
  }
  json->object_end();
  json->field("capture_thread_count", own);
  json->field("threads_total", total);
}

// The inodes of this process's inet sockets (TCP and UDP, v4 and v6; /proc/self/net/*).
std::unordered_set<std::string> inet_socket_inodes() {
  std::unordered_set<std::string> out;
  for (const char *table : {"tcp", "tcp6", "udp", "udp6"}) {
    std::FILE *f = std::fopen((std::string("/proc/self/net/") + table).c_str(), "r");
    if (f == nullptr) continue;
    char line[512];
    bool header = true;
    while (std::fgets(line, sizeof(line), f) != nullptr) {
      if (header) {
        header = false;
        continue;
      }
      // sl local rem st tx:rx tr:when retrnsmt uid timeout inode ...: the 10th field.
      std::istringstream fields(line);
      std::string field;
      for (int k = 0; k < 10 && (fields >> field); ++k) {
      }
      if (!field.empty()) out.insert(field);
    }
    std::fclose(f);
  }
  return out;
}

// Open fds, sockets, and inet sockets: the capture's listeners and connections. The engine holds
// a few Unix sockets of its own (their count varies run to run); a headless fixture opens no inet
// socket, so `inet_sockets` is the capture's.
void fd_census(JsonWriter *json) {
  const std::unordered_set<std::string> inet = inet_socket_inodes();
  int64_t fds = 0;
  int64_t sockets = 0;
  int64_t inet_sockets = 0;
  if (DIR *dir = opendir("/proc/self/fd")) {
    while (const dirent *e = readdir(dir)) {
      if (e->d_name[0] == '.') continue;
      ++fds;
      char target[128] = {0};
      const std::string link = "/proc/self/fd/" + std::string(e->d_name);
      const ssize_t n = readlink(link.c_str(), target, sizeof(target) - 1);
      const std::string t = n > 0 ? std::string(target, static_cast<std::size_t>(n)) : std::string();
      if (t.rfind("socket:[", 0) == 0) {
        ++sockets;
        if (inet.count(t.substr(8, t.size() - 9)) != 0) ++inet_sockets;
      }
    }
    closedir(dir);
  }
  json->field("fds_total", fds);
  json->field("sockets", sockets);
  json->field("inet_sockets", inet_sockets);
}

// What the capture still holds per arm (swap-accounting): every count is 0 after an honest
// disarm but `canvases` (a fresh mirror's root canvas).
void accounting_fields(JsonWriter *json) {
  const rs::MirrorStats m = rs::mirror_stats();
  json->key("mirror").object_begin();
  json->field("items", static_cast<int64_t>(m.live_items));
  json->field("canvases", static_cast<int64_t>(m.live_canvases));
  json->field("textures", static_cast<int64_t>(m.live_textures));
  json->field("meshes", static_cast<int64_t>(m.live_meshes));
  json->field("texture_payload_bytes", static_cast<int64_t>(m.texture_payload_bytes));
  json->field("mesh_payload_bytes", static_cast<int64_t>(m.mesh_payload_bytes));
  {
    std::unordered_set<const void *> seen;
    rs::RestCensus held;
    rs::mirror_instance().at_rest_census(&held, &seen);
    json->field("held_bytes", static_cast<int64_t>(held.held_bytes));
  }
  json->object_end();
  int64_t served_bytes = 0;
  int64_t served_sets = g_live.served != nullptr ? 1 : 0;
  if (g_live.served != nullptr) served_bytes += static_cast<int64_t>(g_live.served->retained_bytes());
  for (const auto &kept : g_rearm.kept_served) {
    served_bytes += static_cast<int64_t>(kept->retained_bytes());
    ++served_sets;
  }
  json->field("served_sets", served_sets);
  json->field("served_bytes", served_bytes);
  json->field("warm_cache_bytes", static_cast<int64_t>(rs::adopt_warm_cache_bytes()));
  json->field("warm_entries", static_cast<int64_t>(rs::adopt_warm_entries_held()));
  json->field("texture_workers_running", rs::texture_worker_pool().running());
  json->field("encode_workers_running", rs::texture_encode_pool().running());
  json->field("hubs", static_cast<int64_t>((g_live.hub != nullptr ? 1 : 0) + g_rearm.kept_hubs.size()));
  json->field("carrier_sets",
              static_cast<int64_t>((g_live.carriers != nullptr ? 1 : 0) + g_rearm.kept_carriers.size()));
  json->field("track_hub", g_live.tracks != nullptr);
  json->field("writer_joined", g_stream.writer == nullptr);
  json->field("publisher", g_stream.publisher != nullptr);
  json->field("resource_log_held", static_cast<int64_t>(rs::resource_log().held()));
  json->field("mesh_buffers", static_cast<int64_t>(hooks_mesh_buffers_held()));
  json->field("reload_sources_held", static_cast<int64_t>(rs::adopt_reload_sources_held()));
  json->field("adopt_held", static_cast<int64_t>(rs::adopt_held()));
  json->key("item_meta").object_begin();
  json->field("host_held", static_cast<int64_t>(g_meta.host.held()));
  json->field("filter_watches", static_cast<int64_t>(rs::filter_watch_count()));
  json->field("calls_while_off", static_cast<int64_t>(rs::filter_calls_while_off()));
  json->object_end();
  json->field("rss_bytes", static_cast<int64_t>(read_rss_bytes()));
  // RssAnon (the heap: what a leak holds) apart from RssFile (mapped code and data pages the arm
  // touched, the extension's and the net module's included) and RssShmem.
  if (std::FILE *f = std::fopen("/proc/self/status", "r")) {
    char line[256];
    while (std::fgets(line, sizeof(line), f) != nullptr) {
      for (const auto &[key, name] : {std::pair<const char *, const char *>{"RssAnon:", "rss_anon_bytes"},
                                      {"RssFile:", "rss_file_bytes"},
                                      {"RssShmem:", "rss_shmem_bytes"}}) {
        if (std::strncmp(line, key, std::strlen(key)) == 0) {
          json->field(name, static_cast<int64_t>(std::strtoll(line + std::strlen(key), nullptr, 10)) * 1024);
        }
      }
    }
    std::fclose(f);
  }
  thread_census(json);
  fd_census(json);
  // Test-only allocator evidence: separate live allocations from free arena pages and mmap.
  if (env_string("GRC_TEST_MEMORY_ACCOUNTING") == "1") {
    const auto heap = mallinfo2();
    json->key("malloc").object_begin();
    json->field("uordblks", static_cast<int64_t>(heap.uordblks));
    json->field("fordblks", static_cast<int64_t>(heap.fordblks));
    json->field("hblkhd", static_cast<int64_t>(heap.hblkhd));
    json->field("arena", static_cast<int64_t>(heap.arena));
    json->field("keepcost", static_cast<int64_t>(heap.keepcost));
    json->object_end();
    const auto registry = rs::registry_stats();
    json->key("registry").object_begin();
    json->field("entries", static_cast<int64_t>(registry.entries));
    json->field("bytes_estimate", static_cast<int64_t>(registry.bytes_estimate));
    json->field("entry_bytes", static_cast<int64_t>(registry.entry_bytes));
    json->field("material_params", static_cast<int64_t>(registry.material_params));
    json->field("material_payload_bytes", static_cast<int64_t>(registry.material_payload_bytes));
    json->object_end();
    json->field("store", g_stream.store != nullptr);
    json->field("net_module", g_live.net_module != nullptr);
  }
}

// Q3's root min_size: put back what was there before the arm, if what the arm wrote is still set.
void rearm_restore_min_size() {
  if (!g_rearm.min_written) return;
  void *window = !g_root_finalized && g_rearm.window_id != 0 &&
                         g_iface.object_get_instance_from_id != nullptr
                     ? g_iface.object_get_instance_from_id(g_rearm.window_id) : nullptr;
  if (window == nullptr) {
    g_rearm.min_restore = "root-gone";
    return;
  }
  if (rearm_fault("skip-root-restore")) {
    g_rearm.min_restore = "skipped";
    return;
  }
  int32_t now[2] = {0, 0};
  if (!g_rearm.min_recorded || !rs::root_get_min_size(window, now)) {
    g_rearm.min_restore = "unreadable";
  } else if (now[0] != g_rearm.min_set[0] || now[1] != g_rearm.min_set[1]) {
    g_rearm.min_restore = "changed";  // somebody else set it since: theirs stays
  } else {
    g_rearm.min_restore = rs::root_write_min_size(window, g_rearm.min_before[0],
                                                  g_rearm.min_before[1])
                              ? "restored"
                              : "unreadable";
  }
}

bool inflight_ready(bool blocking) {
  if (rearm_fault("skip-inflight-wait")) return true;
  auto &t = g_api_teardown;
  for (;;) {
    // Pairs prior seq_cst arm-flag clears with OffmainGuard's increment and flag reads.
    const int count = hooks_offmain_inflight();
    t.inflight_max = std::max(t.inflight_max, count);
    if (count == 0) return true;
    if (t.inflight_wait_start_ns == 0) t.inflight_wait_start_ns = monotonic_ns();
    if (!t.inflight_wait_timeout && monotonic_ns() - t.inflight_wait_start_ns > 5000000000ULL) {
      t.inflight_wait_timeout = true;
      log_line("teardown: off-main in-flight wait exceeded 5 s; release still waits");
    }
    if (!blocking) { ++t.inflight_wait_frames; return false; }
    std::this_thread::sleep_for(std::chrono::milliseconds(1));
  }
}

// LS3 (Q3 "Reset at disarm"): after the end records, the linger and every join, frees what the
// arm built, so the capture holds what one that never armed would. Main thread.
void arm_release() {
  auto test_reader_release = hooks_test_arm_release();
  const uint64_t t0 = monotonic_ns();
  // Live: every carrier has stopped and the hub has finished (live_close_finish, which detached
  // the track receivers) by now.
  g_live.tracks.reset();
  if (rearm_fault("keep-hub") && g_live.hub != nullptr) {
    g_rearm.kept_hubs.push_back(std::move(g_live.hub));
  }
  g_live.hub.reset();  // joins the Former thread
  g_live.ws = nullptr;
  if (rearm_fault("keep-listener") && g_live.carriers != nullptr) {
    g_rearm.kept_carriers.push_back(std::move(g_live.carriers));
    if (g_live.tls != nullptr) g_rearm.kept_tls.push_back(std::move(g_live.tls));
  }
  g_live.carriers.reset();  // closes the listen sockets and wake pipes; destroys v1 carriers
  g_live.tls.reset();
  if (rearm_fault("keep-served") && g_live.served != nullptr) {
    g_rearm.kept_served.push_back(std::move(g_live.served));
  }
  g_live.served.reset();
  live::carrier_registry().reopen();
  // The stream: the sinks' end already joined the writer.
  g_stream.publisher.reset();
  g_stream.full_sink.reset();
  g_stream.patch_sink.reset();
  g_stream.store.reset();
  g_stream.writer.reset();
  g_stream.holdback = rs::HoldBack();
  const auto htr_restore = rs::adopt_htr_restore(g_stream.adopt_fault, g_root_finalized);
  // Every off-main mirror write still in flight lands before the mirror goes.
  if (!rearm_fault("skip-mirror-reset")) {
    rs::mirror_release();
  }
  const std::size_t log_freed = rs::resource_log().release();
  const std::size_t mesh_freed = hooks_release_arm();
  const std::size_t adopt_freed = rs::adopt_release();
  g_meta.host.release();
  g_meta.on = false;
  rs::texture_cache().close();
  rs::settings_install({});
  rearm_restore_min_size();
  if (g_rearm.trim) {
    malloc_trim(0);  // GRC_TEST_TRIM_AT_DISARM (test only): RSS then reads what is held
  }
  JsonWriter json;
  json.object_begin();
  json.field("schema", std::string("render-stream-teardown/1"));
  json.field("arm_index", static_cast<int64_t>(g_rearm.arm_index));
  json.field("frame", static_cast<int64_t>(g_state.frames_total));
  json.field("fault", g_rearm.fault);
  json.field("root_finalized", g_root_finalized);
  json.field("inflight_wait_frames", static_cast<int64_t>(g_api_teardown.inflight_wait_frames));
  json.field("inflight_max", static_cast<int64_t>(g_api_teardown.inflight_max));
  json.field("inflight_wait_timeout", g_api_teardown.inflight_wait_timeout);
  if (env_string("GRC_TEST_INFLIGHT_SITE") == "admission") {
    json.field("uncounted_arm_accesses", static_cast<int64_t>(hooks_test_uncounted_accesses()));
    json.field("held_free_registered", hooks_test_freed_registered());
  }
  json.field("release_us", static_cast<int64_t>((monotonic_ns() - t0) / 1000));
  json.key("freed").object_begin();
  json.field("resource_log", static_cast<int64_t>(log_freed));
  json.field("mesh_buffers", static_cast<int64_t>(mesh_freed));
  json.field("adopt", static_cast<int64_t>(adopt_freed));
  json.object_end();
  json.key("root_min_size").object_begin();
  json.field("written", g_rearm.min_written);
  json.key("before").array_begin();
  json.integer(g_rearm.min_before[0]);
  json.integer(g_rearm.min_before[1]);
  json.array_end();
  json.key("set").array_begin();
  json.integer(g_rearm.min_set[0]);
  json.integer(g_rearm.min_set[1]);
  json.array_end();
  json.field("restore", g_rearm.min_restore);
  json.object_end();
  json.key("htr_restore").object_begin();
  json.field("candidates", static_cast<int64_t>(htr_restore.candidates));
  json.field("restored", static_cast<int64_t>(htr_restore.restored));
  json.field("unavailable", static_cast<int64_t>(htr_restore.unavailable));
  json.field("mismatch", static_cast<int64_t>(htr_restore.mismatch));
  json.field("not_placeholder", static_cast<int64_t>(htr_restore.not_placeholder));
  json.field("skipped_fault", static_cast<int64_t>(htr_restore.skipped_fault));
  json.field("skipped_shutdown", static_cast<int64_t>(htr_restore.skipped_shutdown));
  json.field_or_null("skipped", htr_restore.skipped);
  json.object_end();
  accounting_fields(&json);
  json.object_end();
  g_rearm.accounting = json.take();
  emit("teardown.json", g_rearm.accounting);
  log_line("teardown: arm " + std::to_string(g_rearm.arm_index) + " released in " +
           std::to_string((monotonic_ns() - t0) / 1000) + " us (resource log " +
           std::to_string(log_freed) + ", mesh buffers " + std::to_string(mesh_freed) +
           ", adoption " + std::to_string(adopt_freed) + "; root min_size " +
           g_rearm.min_restore + ")");
}

void api_disarm_post() {
  g_api_teardown.active = false;
  g_api_teardown.last_frame = g_state.frames_total;
  g_live.close_async = false;
  g_state.standby = true;
  g_api->disarmed(g_api_arm.published);
  api_evidence();
  g_state.evidence_dir = g_rearm.evidence_root;  // standby's evidence is the load's
  if (g_swap.on) {
    ++g_swap.done;
    g_swap.requested = false;
    g_swap.idle_phase = true;
    g_swap.phase_frame = g_state.frames_total;
    g_swap.phase_cpu_ns = main_thread_cpu_us() * 1000;
    g_swap.phase_callback_ns = 0;
    g_swap.phase_callbacks = 0;
  }
}

bool teardown_ready(cap::TeardownThread &thread, bool blocking) {
  if (!thread.done() && !blocking) return false;
  thread.join();
  return true;
}

// LS3: the disarm, one step at a time (D1): the texture pool, the encode pool, the stream's end on
// main, the file sinks, the evidence, the linger and the carriers, then the release and
// `disarmed`. Each join runs on a teardown thread and is polled once a frame callback;
// `blocking` (shutdown, unload) runs them inline instead.
void api_teardown_advance(bool blocking) {
  ApiTeardown &t = g_api_teardown;
  const bool inline_joins = blocking || g_api_fault == "disarm-joins-on-main";
  for (;;) {
    switch (t.step) {
    case TeardownStep::Idle:
      return;
    case TeardownStep::Workers:
      if (!t.pool_pending && g_stream.workers_started) {
        t.callback_phase = "pool-wait";
        t.pool_pending = true;
        rs::adopt_warm_cancel();
        t.pool.run([] { rs::texture_worker_pool().stop(); }, inline_joins);
      }
      if (t.pool_pending) {
        if (!teardown_ready(t.pool, blocking)) return;
        t.pool_pending = false;
        workers_finish();  // the held snapshot, published now that every job is done
      }
      t.step = TeardownStep::Encoders;
      continue;
    case TeardownStep::Encoders:
      if (!t.encoders_pending && g_stream.basis && g_stream.status == "open") {
        t.callback_phase = "encode-wait";
        t.encoders_dropped = encoders_finish_begin();
        t.encoders_pending = true;
        t.pool.run([] { encoders_finish_wait(); }, inline_joins);
      }
      if (t.encoders_pending) {
        if (!teardown_ready(t.pool, blocking)) return;
        t.encoders_pending = false;
        encoders_finish_end(t.encoders_dropped);  // stream_finish_main's own call is then a no-op
      }
      t.step = TeardownStep::Finish;
      continue;
    case TeardownStep::Finish:
      t.callback_phase = "stream-finish";
      if (stream_finish_main(rs2::EndReason::Disarm) && g_stream.publisher != nullptr) {
        g_stream.status = "closing";
        t.sinks_pending = true;
        t.sinks.run([] { stream_sinks_end(rs2::EndReason::Disarm); }, inline_joins);
      }
      t.step = TeardownStep::Sinks;
      continue;
    case TeardownStep::Sinks:
      if (t.sinks_pending) {
        t.callback_phase = "sinks-wait";
        if (!teardown_ready(t.sinks, blocking)) return;
        t.sinks_pending = false;
        stream_finish_after_sinks(rs2::EndReason::Disarm);
      }
      disarm_evidence();
      t.evidence_done = true;
      t.step = TeardownStep::Linger;
      continue;
    case TeardownStep::Linger:
      if (t.carrier_pending) {
        if (!teardown_ready(t.carriers, blocking)) return;
        t.carrier_pending = false;
        t.callback_phase = "close-finish";
        live_close_finish();
      }
      if (g_live.hub != nullptr && !g_live.stopped) {
        if (!g_live.ending && !g_live.closing) {
          live_finish(rs2::EndReason::Disarm, false);  // a stream that ended by itself: the linger
        }
        if (!blocking) return;  // on_frame's live_linger advances it, then the carriers' join
        g_live.close_async = false;
        live_linger(true);
        continue;
      }
      t.step = TeardownStep::Release;
      continue;
    case TeardownStep::Release:
      t.callback_phase = "inflight-wait";
      if (!inflight_ready(blocking)) return;
      t.callback_phase = "release";
      arm_release();
      t.step = TeardownStep::Idle;
      api_disarm_post();
      return;
    }
  }
}

// P0 runs at the frame boundary: the armed table goes first, then the steps above.
void api_disarm_point(const char *phase) {
  g_api->disarm_point();
  ApiTeardown &t = g_api_teardown;
  t.active = true;
  t.first_frame = g_state.frames_total;
  t.last_frame = 0;
  t.callbacks = 0;
  t.max_callback_us = 0;
  t.top.clear();
  t.evidence_done = false;
  t.inflight_wait_start_ns = 0;
  t.inflight_wait_frames = 0;
  t.inflight_max = hooks_offmain_inflight();
  t.inflight_wait_timeout = false;
  t.callback_phase = "disarm";
  g_live.close_async = true;
  g_live.linger_ns = uint64_t(g_api->pending_disarm().linger_ms) * 1000000;
  disarm_hooks(phase);
  t.step = TeardownStep::Workers;
  api_teardown_advance(false);
}

void api_disarm_poll() {
  if (!g_api_teardown.active) return;
  api_teardown_advance(false);
}

// Shutdown/unload cannot leave a worker owning extension code or an engine Image.
void api_teardown_finish_blocking() {
  g_live.close_async = false;
  if (!g_api_teardown.active) return;
  api_teardown_advance(true);
}

// LS3 (D2): GRC_SWAP_CYCLE's driver and its per-phase samples (evidence/swap-cycle.jsonl, one line
// at the end of every phase: the swap-cycle-* checks' input).
void swap_cycle_sample(const char *phase) {
  const uint64_t frames = g_state.frames_total - g_swap.phase_frame;
  JsonWriter json;
  json.object_begin();
  json.field("cycle", static_cast<int64_t>(g_swap.done));
  json.field("phase", std::string(phase));
  json.field("control", g_swap.control);
  json.field("arm_index", static_cast<int64_t>(g_rearm.arm_index));
  json.field("start_frame", static_cast<int64_t>(g_swap.phase_frame));
  json.field("end_frame", static_cast<int64_t>(g_state.frames_total));
  json.field("process_frame", static_cast<int64_t>(rs::adopt_engine_process_frames()));
  json.field("frames", static_cast<int64_t>(frames));
  const int64_t cpu_ns = main_thread_cpu_us() * 1000 - g_swap.phase_cpu_ns;
  // Nanoseconds a frame, integers (the checkers divide): the main thread's CPU over the phase and
  // the capture's own frame callbacks.
  json.field("main_cpu_ns_per_frame", frames != 0 ? cpu_ns / static_cast<int64_t>(frames) : 0);
  json.field("callback_ns_per_frame",
             g_swap.phase_callbacks != 0
                 ? static_cast<int64_t>(g_swap.phase_callback_ns / g_swap.phase_callbacks)
                 : int64_t{0});
  json.field("t_ns", static_cast<int64_t>(monotonic_ns()));
  accounting_fields(&json);
  json.object_end();
  if (g_state.evidence_ready) {
    if (env_string("GRC_TEST_MEMORY_ACCOUNTING") == "1") {
      const std::string prefix = path_join(g_rearm.evidence_root,
          "memory-" + std::to_string(g_swap.done) + "-" + phase);
      std::ifstream maps("/proc/self/smaps");
      std::ofstream dump(prefix + ".smaps");
      dump << maps.rdbuf();
      if (std::FILE *f = std::fopen((prefix + ".malloc.xml").c_str(), "w")) {
        malloc_info(0, f);
        std::fclose(f);
      }
    }
    const std::string path = path_join(g_rearm.evidence_root, "swap-cycle.jsonl");
    if (std::FILE *f = std::fopen(path.c_str(), "a")) {
      // One line: the writer's newlines and their indentation dropped (no string holds a newline).
      std::string line;
      bool indent = false;
      for (const char c : json.take()) {
        if (c == '\n') {
          indent = true;
        } else if (!(indent && c == ' ')) {
          indent = false;
          line += c;
        }
      }
      line += '\n';
      std::fwrite(line.data(), 1, line.size(), f);
      std::fclose(f);
    }
  }
}

void swap_cycle_phase(bool idle) {
  g_swap.idle_phase = idle;
  g_swap.phase_frame = g_state.frames_total;
  g_swap.phase_cpu_ns = main_thread_cpu_us() * 1000;
  g_swap.phase_callback_ns = 0;
  g_swap.phase_callbacks = 0;
}

void swap_cycle_armed() {
  g_swap.requested = false;
  swap_cycle_phase(false);
}

cap::Value api_invoke(const std::string &method, const cap::Value::Object &options);

// End of every frame callback while GRC_SWAP_CYCLE runs (standby included).
void swap_cycle_frame(uint64_t frame_start_ns) {
  if (g_state.frames_total == g_swap.phase_frame) {
    // The callback the phase began in (an arm, or a disarm's release) is not the phase's: its
    // CPU and callback windows open at its end.
    g_swap.phase_cpu_ns = main_thread_cpu_us() * 1000;
    g_swap.phase_callback_ns = 0;
    g_swap.phase_callbacks = 0;
    return;
  }
  g_swap.phase_callback_ns += monotonic_ns() - frame_start_ns;
  ++g_swap.phase_callbacks;
  if (g_swap.requested) return;
  const uint64_t in_phase = g_state.frames_total - g_swap.phase_frame;
  if (g_swap.idle_phase) {
    if (in_phase < g_swap.idle) return;
    swap_cycle_sample("idle");
    if (g_swap.done >= g_swap.cycles) {
      g_swap.on = false;  // every cycle ran; the capture stays in standby
      log_line("swap-cycle: " + std::to_string(g_swap.done) + " cycles done at frame " +
               std::to_string(g_state.frames_total));
      return;
    }
    if (g_swap.control) {
      swap_cycle_phase(false);
      return;
    }
    // Test driver only: a leg with no viewer after arm 1 can override that arm's hello wait.
    cap::Value::Object options;
    const char *hello_ms = std::getenv("GRC_SWAP_CYCLE_REARM_AWAIT_HELLO_MS");
    if (hello_ms != nullptr) options.emplace("GRC_LIVE_AWAIT_HELLO_MS", std::string(hello_ms));
    const cap::Value code = api_invoke("arm", options);
    if (std::get<std::int64_t>(code.data) == 0) {
      g_swap.requested = true;
    } else {
      log_line("swap-cycle: arm refused (" + g_api->last_refusal() + "); the cycle stops");
      g_swap.on = false;
    }
    return;
  }
  if (in_phase < g_swap.armed) return;
  swap_cycle_sample("armed");
  if (g_swap.control) {
    ++g_swap.done;
    swap_cycle_phase(true);
    return;
  }
  const cap::Value code =
      api_invoke("disarm", {{"reason", std::string("swap-cycle")}, {"linger_ms", std::int64_t(0)}});
  if (std::get<std::int64_t>(code.data) == 0) {
    g_swap.requested = true;
  } else {
    log_line("swap-cycle: disarm refused (" + g_api->last_refusal() + "); the cycle stops");
    g_swap.on = false;
  }
}

// GRC_SWAP_CYCLE=<armed>:<idle>:<n>[:control], read once at SCENE initialisation.
void swap_cycle_configure() {
  const std::string spec = env_string("GRC_SWAP_CYCLE");
  if (spec.empty()) return;
  uint64_t v[3] = {0, 0, 0};
  std::size_t at = 0;
  bool ok = true;
  for (int i = 0; i < 3 && ok; ++i) {
    const std::size_t end = spec.find(':', at);
    const std::string part = spec.substr(at, end == std::string::npos ? std::string::npos : end - at);
    ok = !part.empty() && part.size() <= 9 &&
         std::all_of(part.begin(), part.end(), [](char c) { return c >= '0' && c <= '9'; });
    if (ok) v[i] = std::strtoull(part.c_str(), nullptr, 10);
    at = end == std::string::npos ? spec.size() + 1 : end + 1;
  }
  const std::string rest = at <= spec.size() ? spec.substr(at) : std::string();
  ok = ok && v[0] > 0 && v[2] > 0 && (rest.empty() || rest == "control");
  if (!ok) {
    log_line("init: ignoring an invalid GRC_SWAP_CYCLE=" + spec +
             " (expected <armed>:<idle>:<n>[:control], armed and n >= 1)");
    return;
  }
  g_swap.on = true;
  g_swap.armed = v[0];
  g_swap.idle = v[1];
  g_swap.cycles = v[2];
  g_swap.control = rest == "control";
  g_swap.phase_cpu_ns = main_thread_cpu_us() * 1000;
  // A born capture starts armed (its first arm is the env's); a standby one starts idle.
  g_swap.idle_phase = g_state.mode != "arm" || g_swap.control;
  log_line("init: swap-cycle armed=" + std::to_string(v[0]) + " idle=" + std::to_string(v[1]) +
           " cycles=" + std::to_string(v[2]) + (g_swap.control ? " control" : ""));
}

void api_callback_record(uint64_t start_ns) {
  if (g_api_teardown.first_frame == 0 ||
      (g_api_teardown.last_frame != 0 && g_state.frames_total > g_api_teardown.last_frame)) return;
  const uint64_t us = (monotonic_ns() - start_ns) / 1000;
  ++g_api_teardown.callbacks;
  g_api_teardown.max_callback_us = std::max(g_api_teardown.max_callback_us, us);
  g_api_teardown.top.push_back({g_state.frames_total, us, g_api_teardown.callback_phase});
  std::stable_sort(g_api_teardown.top.begin(), g_api_teardown.top.end(),
                   [](const auto &a, const auto &b) { return a.us > b.us; });
  if (g_api_teardown.top.size() > 8) g_api_teardown.top.resize(8);
}

// Validate only the per-arm values here. The existing stream parsers still own policy.
bool api_validate(const rs::Settings &settings, std::string *detail) {
  for (const auto &[key, value] : settings) {
    bool ok = true;
    if (key == "GRC_ROOT_SIZE") {
      RootSizePolicy policy; int32_t wh[2]{};
      ok = parse_root_size_policy(value.c_str(), &policy, wh);
    } else if (key == "GRC_TEXTURE_DELIVERY") {
      rs::DeliveryPolicy policy;
      ok = rs::parse_delivery_policy(value.c_str(), &policy, detail);
    } else if (key == "GRC_TEXTURE_PENDING") {
      ok = value.empty() || value == "hold" || value == "publish";
    } else if (key == "GRC_LIVE_CODING") {
      rs::live_coding::Coding coding;
      ok = rs::live_coding::parse_env(value.c_str(), &coding, detail);
    } else if (!value.empty()) {
      ok = value.size() <= 15 && std::all_of(value.begin(), value.end(),
                                            [](char c) { return c >= '0' && c <= '9'; });
      if (ok) {
        const auto n = std::strtoull(value.c_str(), nullptr, 10);
        ok = n > 0 && (key != "GRC_LIVE_MAX_CONNECTIONS" || n <= 4);
      }
    }
    if (!ok) { *detail = "invalid " + key; return false; }
  }
  return true;
}

cap::Value::Object api_state() {
  if (std::this_thread::get_id() != g_api_main) return g_api->state();
  const auto stats = rs::registry_stats();
  cap::Value::Object registry;
  for (std::size_t i = 0; i < rs::kRegistryFamilies; ++i) {
    registry[rs::registry_family_name(static_cast<rs::RegistryFamily>(i))] =
        cap::Value::Object{{"entries", std::int64_t(stats.family[i].entries)}};
  }
  return g_api->state(g_state.frames_total, std::move(registry));
}
void api_json_value(JsonWriter &j, const cap::Value &v) {
  if (auto p = std::get_if<std::string>(&v.data)) j.string(*p);
  else if (auto p = std::get_if<std::int64_t>(&v.data)) j.integer(*p);
  else if (auto p = std::get_if<bool>(&v.data)) j.boolean(*p);
  else if (auto p = std::get_if<double>(&v.data)) j.float32(static_cast<float>(*p));
  else if (auto p = std::get_if<cap::Value::Object>(&v.data)) {
    j.object_begin();
    for (const auto &[key, value] : *p) { j.key(key); api_json_value(j, value); }
    j.object_end();
  } else if (auto p = std::get_if<cap::Value::Array>(&v.data)) {
    j.array_begin(); for (const auto &value : *p) api_json_value(j, value); j.array_end();
  } else j.null();
}
void api_evidence() {
  if (!g_api || !g_api->called()) return;
  JsonWriter j;
  auto snapshot = api_state();
  snapshot["arm_frame"] = std::int64_t(g_api_arm.frame);
  snapshot["published"] = std::int64_t(g_api_arm.published);
  snapshot["texture_workers_running"] = rs::texture_worker_pool().running();
  snapshot["track_inject_prepared"] = !g_live.track_config.inject_mode.empty();
  snapshot["track_inject_pending"] = live::gd_tracks_builtin_pending();
  snapshot["max_callback_us"] = std::int64_t(g_api_teardown.max_callback_us);
  snapshot["callbacks"] = std::int64_t(g_api_teardown.callbacks);
  snapshot["pool_join"] = cap::teardown_join_info(g_api_teardown.pool,
      g_api_teardown.pool_pending, g_api_teardown.encoders_pending);
  snapshot["carrier_join"] = cap::teardown_join_info(g_api_teardown.carriers,
      g_api_teardown.carrier_pending);
  snapshot["sinks_join"] = cap::teardown_join_info(g_api_teardown.sinks,
      g_api_teardown.sinks_pending);
  cap::Value::Array top;
  for (const auto &c : g_api_teardown.top) top.emplace_back(cap::Value::Object{
      {"frame", std::int64_t(c.frame)}, {"us", std::int64_t(c.us)}, {"phase", c.phase}});
  snapshot["top_callbacks"] = std::move(top);
  api_json_value(j, snapshot);
  emit_load("capture-api.json", j.take());
}
cap::Value api_invoke(const std::string &method, const cap::Value::Object &options) {
  cap::Value result;
  if (method == "state") result = api_state();
  else if (method == "arm") result = g_api->arm(options, api_validate);
  else result = g_api->disarm(options);
  if (std::this_thread::get_id() == g_api_main) {
    g_state.api_pending_arm = g_api->arm_pending();
    const bool accepted = method != "state" && std::get<std::int64_t>(result.data) == 0;
    if (accepted && method == "arm" && g_api_fault == "api-early-armed") {
      cap::gd_capture_emit({"armed", {api_arm_info()}});
    }
    if (accepted && method == "disarm" && g_api->phase() == cap::State::Standby &&
        !g_state.decided) {
      g_state.standby = true;
      decide("standby", std::string());
    }
    api_evidence();
  }
  return result;
}
void api_flush() {
  if (!g_api->any()) return;
  for (const auto &signal : g_api->take_signals()) cap::gd_capture_emit(signal);
  api_evidence();
}

void on_startup() { attempt("startup"); }

void on_frame() {
  const uint64_t frame_start_ns = monotonic_ns();
  // P3-TM: the host's shader time follows every iteration from the first, armed or not.
  if (!rs::shader_clock_tick() && !g_state.shader_clock_logged) {
    g_state.shader_clock_logged = true;
    log_line("shader-clock: unavailable (" + rs::shader_clock().unavailable + ")");
  }
  // frame_interval_us: measured only while armed, from one armed callback to the
  // next -- the unarmed/validate-mode callbacks before arming are not part of any measured arm
  // (the `unarmed` arm is "no extension at all", so this code does not even run for it).
  if (g_state.armed && g_state.evidence_ready) {
    if (g_perf.last_frame_ns != 0) {
      g_perf.frame_interval_us.add((frame_start_ns - g_perf.last_frame_ns) / 1000);
    }
    g_perf.last_frame_ns = frame_start_ns;
  }
  ++g_state.frames_total;
  // LAR0: a registry timeline row for the calls this iteration carried (label frames_total, set
  // by the previous callback's hooks_set_frame), when any changed it. Off: one relaxed load.
  if (rs::registry_on()) {
    rs::registry_frame(g_state.frames_total);
  }
  if (g_state.standby && !g_state.api_pending_arm) {
    // a standby callback runs the shader clock, the registry's row
    // and the carriers' flush (one relaxed load with none registered), nothing else: no attempt, no
    // linger, no live or track work (no hub exists to feed a track receiver before an arm).
    hooks_set_frame(g_state.frames_total + 1);
    live::gd_carriers_flush();
    api_flush();
    if (g_swap.on) swap_cycle_frame(frame_start_ns);
    return;
  }
  g_api_teardown.callback_phase = g_api_teardown.pool_pending ? "pool-wait" :
      g_api_teardown.carrier_pending ? "carrier-wait" : "linger";
  live_linger(false);  // after a disarm: the receivers' closes, then the server stop
  if (g_state.armed && g_stream.gate8.adopt) {
    // the queues this iteration's hooked calls filled drain
    // now, dated this frame, before the transaction is formed: off-main references, then G8m's
    // material and shader references, then PM5's process-material keying.
    rs::adopt_frame_drain();
    if (rs::adopt_warm_poll()) {
      emit("warm.json", rs::adopt_warm_json(g_rearm.arm_index, g_state.frames_total));
      const auto warm = rs::adopt_warm_stats();
      log_line("warm: complete ms=" + std::to_string(*warm.arm_to_warm_complete_ms) +
               " cache_bytes=" + std::to_string(warm.warm_cache_bytes) +
               " completed=" + std::to_string(warm.completed) + " promoted=" + std::to_string(warm.promoted));
    }
  }
  if (g_state.armed && g_state.pump_connected) {
    // PM5 (GRC_PREDRAW_PUMP=1): before the snapshot, frame_pre_draw when the engine did not emit
    // it this iteration; the listeners' calls are stamped with this frame.
    if (rs::predraw_pump_frame()) {
      ++g_state.pump_fired;
    } else {
      ++g_state.pump_skipped;
    }
  }
  hooks_set_frame(g_state.frames_total + 1);
  // Only a library armed before this callback publishes for this frame: one
  // armed by the deferred attempt below saw none of the frame's calls.
  const bool armed_at_start = g_state.armed;
  if (!g_state.decided) {
    attempt("frame");
  } else if (g_state.api_pending_arm) {
    api_arm_point();
  }
  if (armed_at_start) {
    stream_publish(g_state.frames_total);
    if (g_stream.status == "closed" && g_api->phase() == cap::State::Armed) {
      g_api->stream_ended(g_stream.reason);
    }
    const uint64_t frame = g_state.frames_total;
    if (const uint64_t hold_from = live_hold_after_publish(frame)) {  // LF1: the window's apply
      const bool quit_window = live_hold_from(frame) == frame;  // a `q-q` window: the last frame
      live_hold_phase(frame, hold_from, false, quit_window ? frame : frame + 1);
    }
  }
  if (g_state.armed) {
    ++g_state.frames_armed;
    if (g_state.disarm_after_frames >= 0 &&
        static_cast<int64_t>(g_state.frames_armed) >= g_state.disarm_after_frames) {
      if (!g_api->disarm_pending()) g_api->schedule_disarm({"frame", 1500});
      api_disarm_point("frame");
    }
  }
  if (g_api->disarm_pending()) api_disarm_point("api");
  api_disarm_poll();
  if (armed_at_start && g_state.evidence_ready) {
    const uint64_t now_ns = monotonic_ns();
    g_perf.frame_callback_us.add((now_ns - frame_start_ns) / 1000);  // Q3d frame_callback_us
    perf_timeline_tick(now_ns);
  }
  api_callback_record(frame_start_ns);
  // CAR6 (rs_carrier_gd.h): the hub's calls to script carriers this iteration, delivered as
  // signals now, outside every hub call. One relaxed load when no RenderStreamCarrier registered.
  live::gd_carriers_flush();
  // TRK2 (rs_tracks_gd.h): the track hub's calls to RenderStreamTrack receivers, the same way. An
  // input receiver's parse_input_event() here is applied at the next iteration's flush, before
  // its process step. One relaxed load when no receiver was ever bound.
  live::gd_tracks_flush();
  api_flush();
  if (g_swap.on) swap_cycle_frame(frame_start_ns);
}

// LS3: what a GRC_REARM_FAULT sabotage kept alive goes at shutdown, hubs first (their Former
// threads), then the carrier sets that served them.
void rearm_kept_release() {
  g_rearm.kept_hubs.clear();
  g_rearm.kept_carriers.clear();
  g_rearm.kept_tls.clear();
  g_rearm.kept_served.clear();
}

void on_shutdown() {
  g_root_finalized = true;  // SceneTree::finalize deletes root before shutdown_func runs.
  log_line("shutdown: root-finalized");
  api_teardown_finish_blocking();
  stream_finish(rs2::EndReason::Shutdown);
  rs::adopt_warm_cancel();
  rs::texture_worker_pool().stop();  // G8kw: also when the stream never opened after the pool ran
  live_linger(true);  // a linger still running after a disarm ends here
  do_disarm("shutdown");
  emit_load("counters.json", hooks_counters_json(g_state.frames_total, g_state.frames_armed));
  emit_registry();
  if (rs::texture_cache().enabled()) {
    emit("texture-cache.json", hooks_texture_cache_json());  // G8kc
  }
  emit_canvas_texture_shim();
  emit_headless_texture_release();
  emit_load("result.json", result_json());
  rearm_kept_release();
  log_line("shutdown: frames_total=" + std::to_string(g_state.frames_total) +
           " frames_armed=" + std::to_string(g_state.frames_armed) + " intercepted=" +
           std::to_string(hooks_total_calls()));
}

// GRC_LOW_PROCESSOR_SLEEP_USEC=<usec> sets
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
  g_api_main = std::this_thread::get_id();
  g_api = std::make_unique<cap::Api>(g_api_main);
  apply_low_processor_sleep();
  g_state.calibration_path = env_string("GRC_CALIBRATION");
  g_state.evidence_dir = env_string("GRC_EVIDENCE_DIR");
  const std::string mode = env_string("GRC_MODE");
  g_state.mode = mode.empty() ? std::string("validate") : mode;
  const std::string frames = env_string("GRC_DISARM_AFTER_FRAMES");
  g_state.disarm_after_frames = frames.empty() ? -1 : std::strtoll(frames.c_str(), nullptr, 10);
  const std::string arm_frames = env_string("GRC_ARM_DEFER_FRAMES");  // LATE-SPINE
  g_state.defer_arm_frames = arm_frames.empty() ? 0 : static_cast<std::uint64_t>(
                                                          std::strtoull(arm_frames.c_str(), nullptr, 10));
  g_stream.path = env_string("GRC_STREAM_OUT");
  g_stream.patch_path = env_string("GRC_STREAM_PATCH_OUT");
  g_live.listen = env_string("GRC_LIVE_LISTEN");
  // LS3: the per-load paths each arm derives its own from, and the re-arm test knobs.
  g_rearm.evidence_root = g_state.evidence_dir;
  g_rearm.stream_out = g_stream.path;
  g_rearm.patch_out = g_stream.patch_path;
  g_rearm.fault = env_string("GRC_REARM_FAULT");
  if (!g_rearm.fault.empty()) {
    static const char *kFaults[] = {"keep-served", "keep-listener", "keep-hub", "skip-mirror-reset",
                                    "skip-inflight-wait", "skip-root-restore", "standby-view-off"};
    if (std::none_of(std::begin(kFaults), std::end(kFaults),
                     [](const char *k) { return g_rearm.fault == k; })) {
      log_line("init: ignoring an unknown GRC_REARM_FAULT=" + g_rearm.fault);
      g_rearm.fault.clear();
    } else {
      log_line("init: sabotage GRC_REARM_FAULT=" + g_rearm.fault);
    }
  }
  g_rearm.trim = env_string("GRC_TEST_TRIM_AT_DISARM") == "1";
  {
    uint64_t delay = 0;
    if (env_non_negative("GRC_TEST_INFLIGHT_DELAY_MS", 0, &delay) && delay > 0 && delay <= 10000) {
      hooks_set_test_inflight_delay_ms(static_cast<uint32_t>(delay),
          env_string("GRC_TEST_INFLIGHT_SITE") == "materialize",
          env_string("GRC_TEST_INFLIGHT_SITE") == "admission");
      log_line("init: test inflight delay " + std::to_string(delay) + " ms (off-main texture creates)");
    }
  }
  swap_cycle_configure();
  // GRC_VALIDATION_LOG=on|off, per load, default off. The
  // validation logs (hooks.cpp log_entry and its callers' pre-copies, the direct g_mutex sites and
  // read_image) feed counters.json `captured` and cost about 80 us a frame on capture-scale;
  // validation runners set `on` and assert counters.json `validation_log`.
  {
    const std::string validation_log = env_string("GRC_VALIDATION_LOG");
    if (validation_log.empty() || validation_log == "off") {
      hooks_set_validation_log(false);
    } else if (validation_log == "on") {
      hooks_set_validation_log(true);
    } else {
      g_state.validation_log_error =
          "invalid GRC_VALIDATION_LOG=" + validation_log + " (expected on or off)";
      log_line("init: " + g_state.validation_log_error);
    }
    // Test-only sabotage (validation-log-ignored): the knob is read and reported, the logs still run.
    if (env_string("GRC_VALIDATION_LOG_SABOTAGE") == "ignored") {
      hooks_set_validation_log(true);
      log_line("init: sabotage validation-log-ignored (the logs run whatever the knob says)");
    }
  }
  hooks_set_main_thread();
  // CAR6: consumer carriers (rs_carrier_ext.h) and the RenderStreamCarrier class (rs_carrier_gd.h)
  // for engine-language consumers; neither changes anything until a consumer uses it.
  live::carrier_registry().set_log([](const std::string &line) { log_line(line); });
  {
    std::string why;
    if (!live::gd_carrier_class_register(&why)) {
      log_line("carrier class: " + why);
    }
    if (!cap::gd_capture_register(api_invoke, g_state.mode == "standby" || g_state.mode == "arm", &why)) {
      log_line("capture class: " + why);
    }
    // RenderStreamTrack, a script receiver of one track kind.
    if (!live::gd_track_class_register(&why)) {
      log_line("track class: " + why);
    }
  }
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
           " arm_defer_frames=" + std::to_string(g_state.defer_arm_frames) +
           " stream=" + (g_stream.path.empty() ? std::string("<off>") : g_stream.path) +
           " live=" + (g_live.listen.empty() ? std::string("<off>") : g_live.listen));
  attempt("scene-init");
}

void deinitialize(void * /*userdata*/, GDExtensionInitializationLevel level) {
  if (level != GDEXTENSION_INITIALIZATION_SCENE) {
    return;
  }
  api_teardown_finish_blocking();
  // The shutdown callback normally gets here first; this is the backstop for an
  // unload that happens without it.
  stream_finish(rs2::EndReason::Shutdown);
  rs::adopt_warm_cancel();
  rs::texture_worker_pool().stop();  // G8kw: no worker (or engine Image) outlives the extension
  live_linger(true);
  do_disarm("deinitialize");
  rearm_kept_release();
  rs::registry_names_release();  // LS0: the parameter names' StringName keepalives go before the engine does
  hooks_release_placeholder_drop();  // HTR
  // CAR6: a capture that never armed still owns its registrations; each gets its one destroy().
  for (live::RegisteredCarrier &r : live::carrier_registry().close()) {
    r.vtable.destroy(r.vtable.self);
  }
  api_evidence();
  cap::gd_capture_unregister();
  live::gd_carrier_class_unregister();
  live::gd_track_class_unregister();
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
