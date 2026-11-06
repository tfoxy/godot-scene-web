// rs_tracks: TrackHub, the host side of render-stream-track/1 (protocol/tracks-design.md Q1-Q5,
// Q9; TRK1).
//
// A track is an opt-in connection to the live listener that carries one opaque, separately
// versioned payload format (the first kind is `input`, carrying gsw-input/1) beside the frozen
// view connection (render-stream/13). Its subprotocol is `render-stream-track.1`; the carriers
// admit it from their own pool (rs_carrier_set.h, AdmissionPool::Track) and report it as an
// ordinary Opened event. entry.cpp's live_drain hands every event TrackHub::claims() to the hub
// here instead of the view Hub (rs_live.h), which would otherwise turn the unknown subprotocol
// into a view session (T7).
//
// Per connection: the client's first text is `track-hello` (grammar and check order in Q1.2);
// the host answers `track-ready` and reports opened(source) to the kind's receiver, or answers
// `track-error` and closes with the same reason. After `track-ready` every non-empty text is one
// payload, handed over verbatim and never parsed or logged (T14); "" is a keepalive both ways
// (T10). Over the per-connection token bucket the host closes `track-rate`, never drops (T9).
// Every opened() gets exactly one closed() (T8), whatever ends the track; a refused hello gets
// neither.
//
// Threading: main thread only, no locks. Receivers are called synchronously from on_event(),
// tick(), close(), unbind() and close_all(); a receiver may call send() and close() from inside a
// callback (the hub looks its connection up again after every callback).
#ifndef GRC_RS_TRACKS_H
#define GRC_RS_TRACKS_H

#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <functional>
#include <map>
#include <memory>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

#include "rs_live.h"
#include "rs_ws.h"

namespace grc {
namespace rs {
namespace tracks {

inline constexpr const char *kTrackSubprotocolV1 = "render-stream-track.1";
inline constexpr const char *kTrackProtocolV1 = "render-stream-track/1";

// The kinds `/1` serves (T4): `input`. Reserved names refuse the arm as `tracks-reserved`.
inline constexpr const char *kKindInput = "input";
bool kind_reserved(std::string_view kind);  // audio, clipboard, metadata, data

// Test-only sabotages (TRK1 "Sabotages", GRC_SABOTAGE=track-*): each must fail its
// self-test-tracks.ts predicate.
enum class Sabotage {
  None,
  ViewTokenAccepted,  // track-view-token-accepted: the view token opens a track
  RateOff,            // track-rate-off: the token bucket never closes
  GrantIgnored,       // track-grant-ignored: hello check 2 (kind granted) is skipped
  NoRelease,          // track-no-release: a carrier Closed on an open track reports no closed()
};
// "track-view-token-accepted" ... -> the sabotage; anything else -> None with false.
bool parse_sabotage(std::string_view text, Sabotage *out);
const char *sabotage_name(Sabotage sabotage);  // "" for None

// GRC_LIVE_TRACKS (Q8): a comma list of kinds. Fills *kinds and returns true; an unset or empty
// value is the pure path (true, *kinds empty). False with *error = "tracks-invalid: <detail>"
// (malformed list, empty item, duplicate, a name outside [a-z][a-z0-9-]{0,31}, unknown kind) or
// "tracks-reserved: <kind>".
bool parse_kinds(const char *text, std::vector<std::string> *kinds, std::string *error);

// Strict UTF-8 (RFC 3629): no overlong form, no surrogate, nothing above U+10FFFF. rs_ws checks
// none of this (its text frames are bytes), so a consumer of client texts validates them itself.
bool utf8_valid(std::string_view text);

// The format grammar (Q1.2): `<name>/<N>`, name [a-z][a-z0-9.-]{0,47}, N 1..65535 without a
// leading zero.
bool format_ok(std::string_view format);

// 32 getrandom bytes as 64 lowercase hex (the view token's generator, entry.cpp).
std::string generate_credential();

// Writes `text` to `path` created with mode 0600 (truncating, and fchmod'ing an existing file
// before any byte is written). False on any failure.
bool write_secret_file(const std::string &path, const std::string &text);

struct TrackConfig {
  std::vector<std::string> kinds;                  // GRC_LIVE_TRACKS, validated
  std::map<std::string, std::string> credentials;  // kind -> 64 lowercase hex
  std::string view_token;                          // refused by name; "" when view auth is none
  std::uint32_t keepalive_ms = 1000;
  std::uint32_t rate_per_s = 1000;
  std::uint32_t burst = 2000;
  std::uint64_t hello_timeout_ms = 5000;
  std::size_t max_message_bytes = 4096;
  std::string tap_dir;  // GRC_LIVE_TAP_DIR: track-<source>.jsonl (never a payload)
  Sabotage sabotage = Sabotage::None;
};

struct TrackView {
  std::string stream_id;  // 32 lowercase hex
  std::uint64_t connection = 0;
};

struct TrackInfo {
  std::uint32_t source = 0;
  std::string kind;
  std::string format;
  std::string down_format;  // "" when none was agreed
  std::string client;
  std::string carrier;
  std::string origin;
  std::string subject;  // TRK5 (capabilities); "" with the shared credential
  std::optional<TrackView> view;  // advisory, never checked (F4)
};

// RenderStreamTrack (TRK2), the built-in injector (TRK6) and tests implement it.
class TrackReceiver {
 public:
  virtual ~TrackReceiver() = default;
  virtual std::vector<std::string> formats() const = 0;       // up formats it parses, 1..8
  virtual std::vector<std::string> down_formats() const = 0;  // 0..8
  virtual void opened(const TrackInfo &info) = 0;
  virtual void message(std::uint32_t source, const std::string &text) = 0;
  virtual void closed(std::uint32_t source, std::uint16_t code, const std::string &reason) = 0;
};

// What live-tracks.json says about each carrier (Q9): true serves tracks, false does not, null
// (nullopt) for a consumer carrier the capture cannot judge.
struct CarrierTracks {
  std::string name;
  std::optional<bool> tracks;
};

class TrackHub {
 public:
  using Log = std::function<void(const std::string &line)>;

  TrackHub(TrackConfig config, rs2::LiveTransport &transport, Log log);
  ~TrackHub();
  TrackHub(const TrackHub &) = delete;
  TrackHub &operator=(const TrackHub &) = delete;

  // A track Opened (by subprotocol), or a Text/Closed on a connection this hub owns.
  bool claims(const live::Event &e) const;
  void on_event(const live::Event &e, std::uint64_t now_ns);
  // Hello timeout, idle close, host keepalive and the tap's per-second counts. Once per drain.
  void tick(std::uint64_t now_ns);

  // One receiver per kind (T12). False with *error: `track-formats-invalid` (formats empty, more
  // than 8, a duplicate, or outside the format grammar), `track-kind-invalid` or
  // `track-kind-bound` (another receiver holds the kind).
  bool bind(const std::string &kind, TrackReceiver *receiver, std::string *error);
  // Closes the receiver's open sources `track-receiver-gone` (1013), reporting closed() to it
  // first; the receiver must still be alive.
  void unbind(TrackReceiver *receiver);

  // A down payload (Q1.3): only on an open track with a down format, non-empty valid UTF-8.
  bool send(std::uint32_t source, std::string text);
  // The receiver ends a source: code 1000 or 4000-4999, reason `track-closed`. False otherwise.
  bool close(std::uint32_t source, std::uint16_t code);
  // Stream end (T13): every track and every pending hello closed `reason` with `code` now, every
  // open source reported closed(); later track connections are closed the same way on arrival.
  void close_all(std::uint16_t code, const std::string &reason);

  // True once since the last call when a track opened or closed (live-tracks.json is due).
  bool take_changed();
  std::size_t open_tracks() const;
  // Bound kinds' formats, for status and tests.
  bool bound(const std::string &kind) const { return receivers_.count(kind) != 0; }

  // Per granted kind (live-tracks.json `tracks.<kind>`), main thread only.
  struct KindStats {
    std::uint64_t opened = 0;
    std::uint64_t closed = 0;
    std::uint64_t messages_in = 0;
    std::uint64_t bytes_in = 0;
    std::uint64_t messages_out = 0;
    std::uint64_t bytes_out = 0;
    std::map<std::string, std::uint64_t> refused;  // reason (view token: `track-unauthorized:view-token`)
    std::map<std::string, std::uint64_t> closes;   // reason (a peer close: `peer-<code>`)
    std::map<std::string, std::uint64_t> faults;   // `send-failed`
  };
  // Null for a kind that is not granted.
  const KindStats *kind_stats(const std::string &kind) const;
  // Hellos refused before a granted kind was known (track-utf8, track-protocol,
  // track-kind-refused, track-hello-timeout), by reason.
  const std::map<std::string, std::uint64_t> &unattributed_refused() const { return refused_; }

  struct Extras {
    std::size_t max_tracks = 0;
    std::size_t admitted_max = 0;
    std::vector<CarrierTracks> carriers;
  };
  // evidence/live-tracks.json, schema render-stream-live-tracks/1.
  std::string json(const Extras &extras) const;

  // ready/error control messages, exposed for tests.
  static std::string error_json(const std::string &reason, const std::string &detail);

 private:
  struct Conn;
  Conn *find(std::uint32_t conn);
  Conn *find_source(std::uint32_t source);
  void on_hello(Conn &c, const std::string &text, std::uint64_t now_ns);
  void on_payload(Conn &c, const live::Event &e, std::uint64_t now_ns);
  // Sends track-error (when `notify`), closes the connection; for an open track, reports
  // closed() once. The connection stays claimed until the carrier's Closed.
  void host_close(std::uint32_t conn, std::uint16_t code, const std::string &reason,
                  const std::string &detail, bool notify);
  void refuse(Conn &c, std::uint16_t code, const std::string &reason, const std::string &detail);
  void report_closed(std::uint32_t conn, std::uint16_t code, const std::string &reason);
  void tap(Conn &c, const std::string &line);
  void tap_counts(Conn &c, bool force);
  KindStats *stats(const std::string &kind);
  void count_refused(const std::string &kind, const std::string &key);
  bool text_out(Conn &c, std::string text);
  void close_tap(Conn &c);

  TrackConfig config_;
  rs2::LiveTransport &transport_;
  Log log_;
  std::map<std::uint32_t, std::unique_ptr<Conn>> conns_;
  std::map<std::string, TrackReceiver *> receivers_;
  std::map<std::string, KindStats> kinds_;  // one per granted kind
  std::map<std::string, std::uint64_t> refused_;  // hellos refused before a granted kind was known
  std::uint32_t next_source_ = 1;
  std::uint64_t now_ns_ = 0;  // the latest on_event/tick time (send() has none of its own)
  bool ended_ = false;
  std::uint16_t end_code_ = 1001;
  std::string end_reason_;
  bool changed_ = false;
};

}  // namespace tracks
}  // namespace rs
}  // namespace grc

#endif  // GRC_RS_TRACKS_H
