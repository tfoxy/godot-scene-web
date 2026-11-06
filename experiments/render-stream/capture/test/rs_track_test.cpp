// rs_track_test: TrackHub (rs_tracks.h), the host side of render-stream-track/1
// (protocol/tracks-design.md Q1.2-Q1.4, Q4, Q5; TRK1).
//
// TrackHub runs over a recording fake rs2::LiveTransport and a recording TrackReceiver; events are
// fed with explicit now_ns. Covers claims(); the hello grammar (every refusal is track-protocol
// 1002, unknown members ignored); every hello check in its order (utf8, grammar, grant,
// credential with the view token refused by name, receiver, format); one track-error per refusal
// whose reason is the close reason; track-ready's fields and source numbering; payload delivery
// (verbatim, in order, "" never delivered, UTF-8, size); rate, keepalive, idle and hello timeout;
// receiver close/send; bind/unbind; close_all; re-entrant receivers; one closed() per opened() in
// every path; json(); parse_kinds, utf8_valid and format_ok.
//
// TRK5: per-viewer capabilities (rs_track_caps.h): HMAC-SHA256 (RFC 4231), strict base64url,
// every golden vector of protocol/track-cap-vectors.json (shared with the TS reference minter,
// scripts/lib/track-cap.ts) through caps::verify and through the hub, the C++ minter reproducing
// the minted vectors, the hub's hmac mode (view token still refused by name, `missing`, counts
// under `track-unauthorized:<detail>`, `subject` in opened(), no key or capability in logs or
// json, an open track outliving its `exp`).
//
// The TRK1 and TRK5 sabotages are test-only: each must make its predicate fail; main() runs every
// predicate honest (must hold) and under its sabotage (must not), and fails when a sabotage goes
// unnoticed.
#include <cstdint>
#include <cstdio>
#include <fstream>
#include <functional>
#include <map>
#include <memory>
#include <string>
#include <tuple>
#include <sstream>
#include <vector>

#include "rs_json_lite.h"
#include "rs_track_caps.h"
#include "rs_tracks.h"

namespace tr = grc::rs::tracks;
namespace caps = grc::rs::tracks::caps;
using grc::live::Event;
using tr::Sabotage;
using tr::TrackConfig;
using tr::TrackHub;
using tr::TrackInfo;

namespace {

int g_failures = 0;
int g_checks = 0;

void check(bool ok, const std::string &what) {
  ++g_checks;
  if (!ok) {
    ++g_failures;
    std::fprintf(stderr, "FAIL: %s\n", what.c_str());
  }
}

constexpr std::uint64_t kMs = 1000ull * 1000ull;
constexpr std::uint64_t kS = 1000ull * kMs;

const std::string kCred(64, 'c');
const std::string kView(64, 'a');  // a distinct 64-hex view token

// ------------------------------------------------------------------- fakes

struct FakeTransport final : grc::rs2::LiveTransport {
  std::map<std::uint32_t, std::vector<std::string>> texts;
  std::map<std::uint32_t, std::vector<std::pair<std::uint16_t, std::string>>> closes;
  bool fail_send = false;
  bool send_binary(std::uint32_t, std::vector<std::uint8_t>) override { return false; }
  bool send_text(std::uint32_t conn, std::string message) override {
    if (fail_send) return false;
    texts[conn].push_back(std::move(message));
    return true;
  }
  void close(std::uint32_t conn, std::uint16_t code, std::string reason) override {
    closes[conn].emplace_back(code, std::move(reason));
  }
  std::uint64_t queued_bytes(std::uint32_t) const override { return 0; }
  std::uint64_t max_queued_bytes(std::uint32_t) const override { return 0; }
};

struct Recorder final : tr::TrackReceiver {
  std::vector<std::string> up = {"gsw-input/1"};
  std::vector<std::string> down;
  std::vector<TrackInfo> opens;
  std::map<std::uint32_t, std::vector<std::string>> messages;
  std::map<std::uint32_t, std::vector<std::pair<std::uint16_t, std::string>>> closes;
  std::function<void(const TrackInfo &)> on_opened;
  std::function<void(std::uint32_t, const std::string &)> on_message;
  std::function<void(std::uint32_t)> on_closed;

  std::vector<std::string> formats() const override { return up; }
  std::vector<std::string> down_formats() const override { return down; }
  void opened(const TrackInfo &info) override {
    opens.push_back(info);
    if (on_opened) on_opened(info);
  }
  void message(std::uint32_t source, const std::string &text) override {
    messages[source].push_back(text);
    if (on_message) on_message(source, text);
  }
  void closed(std::uint32_t source, std::uint16_t code, const std::string &reason) override {
    closes[source].emplace_back(code, reason);
    if (on_closed) on_closed(source);
  }
  std::size_t closed_count() const {
    std::size_t n = 0;
    for (const auto &e : closes) n += e.second.size();
    return n;
  }
  // T8: every opened source has exactly one closed(), and nothing else does.
  bool paired() const {
    for (const TrackInfo &i : opens) {
      const auto it = closes.find(i.source);
      if (it == closes.end() || it->second.size() != 1) return false;
    }
    for (const auto &e : closes) {
      bool known = false;
      for (const TrackInfo &i : opens) known = known || i.source == e.first;
      if (!known) return false;
    }
    return true;
  }
};

TrackConfig base_config(Sabotage sabotage = Sabotage::None) {
  TrackConfig c;
  c.kinds = {"input"};
  c.credentials["input"] = kCred;
  c.view_token = kView;
  c.sabotage = sabotage;
  return c;
}

struct H {
  FakeTransport t;
  Recorder r;
  std::vector<std::string> logs;
  std::unique_ptr<TrackHub> hub;
  explicit H(TrackConfig config = base_config(), bool bind = true) {
    hub = std::make_unique<TrackHub>(std::move(config), t, [this](const std::string &l) { logs.push_back(l); });
    if (bind) {
      std::string error;
      check(hub->bind("input", &r, &error), "fixture bind: " + error);
    }
  }
  void open(std::uint32_t conn, std::uint64_t now, const std::string &sp = tr::kTrackSubprotocolV1) {
    Event e;
    e.kind = Event::Opened;
    e.conn = conn;
    e.subprotocol = sp;
    e.carrier = "ws";
    e.origin = "http://127.0.0.1:1";
    hub->on_event(e, now);
  }
  void text(std::uint32_t conn, const std::string &t, std::uint64_t now) {
    Event e;
    e.kind = Event::Text;
    e.conn = conn;
    e.text = t;
    hub->on_event(e, now);
  }
  void peer_closed(std::uint32_t conn, std::uint16_t code, const std::string &reason, std::uint64_t now) {
    Event e;
    e.kind = Event::Closed;
    e.conn = conn;
    e.code = code;
    e.reason = reason;
    e.text = reason;
    hub->on_event(e, now);
  }
  // Open + hello; returns the source (0 when refused).
  std::uint32_t track(std::uint32_t conn, const std::string &hello, std::uint64_t now = 0) {
    const std::size_t before = r.opens.size();
    open(conn, now);
    text(conn, hello, now);
    return r.opens.size() > before ? r.opens.back().source : 0;
  }
  // The conn's last close as (code, reason), or (0, "").
  std::pair<std::uint16_t, std::string> last_close(std::uint32_t conn) {
    const auto &v = t.closes[conn];
    return v.empty() ? std::make_pair(std::uint16_t(0), std::string()) : v.back();
  }
};

std::string hello_raw(const std::string &kind_json, const std::string &formats_json,
                      const std::string &credential_json, const std::string &extra = "") {
  std::string out = "{\"type\":\"track-hello\",\"protocol\":\"render-stream-track/1\"";
  if (!kind_json.empty()) out += ",\"kind\":" + kind_json;
  if (!formats_json.empty()) out += ",\"formats\":" + formats_json;
  if (!credential_json.empty()) out += ",\"credential\":" + credential_json;
  out += extra + "}";
  return out;
}

std::string hello(const std::string &kind = "input", const std::string &credential = kCred,
                  const std::string &formats = "[\"gsw-input/1\"]", const std::string &extra = "") {
  return hello_raw("\"" + kind + "\"", formats, "\"" + credential + "\"", extra);
}

// A refused hello: exactly one text (track-error with this reason/detail), exactly one close with
// the same reason and code, and the receiver saw nothing.
bool refused(H &h, std::uint32_t conn, std::uint16_t code, const std::string &reason, const std::string &detail) {
  const auto &texts = h.t.texts[conn];
  const auto &closes = h.t.closes[conn];
  return texts.size() == 1 && texts[0] == TrackHub::error_json(reason, detail) && closes.size() == 1 &&
         closes[0].first == code && closes[0].second == reason && h.r.opens.empty() && h.r.closed_count() == 0;
}

std::string describe(H &h, std::uint32_t conn) {
  std::string out = "texts=[";
  for (const auto &t : h.t.texts[conn]) out += t + " | ";
  out += "] closes=[";
  for (const auto &c : h.t.closes[conn]) out += std::to_string(c.first) + ":" + c.second + " ";
  out += "] opens=" + std::to_string(h.r.opens.size());
  return out;
}

std::string ready_json(std::uint32_t source, const std::string &format, const std::string &down,
                       const TrackConfig &c = base_config()) {
  return "{\"type\":\"track-ready\",\"protocol\":\"render-stream-track/1\",\"source\":" + std::to_string(source) +
         ",\"kind\":\"input\",\"format\":\"" + format + "\",\"down_format\":" +
         (down.empty() ? std::string("null") : "\"" + down + "\"") +
         ",\"keepalive_ms\":" + std::to_string(c.keepalive_ms) +
         ",\"max_message_bytes\":" + std::to_string(c.max_message_bytes) +
         ",\"rate\":{\"messages_per_second\":" + std::to_string(c.rate_per_s) +
         ",\"burst\":" + std::to_string(c.burst) + "}}";
}

// The JSON writer pretty-prints; drop the layout whitespace (no value here holds a space or newline).
std::string compact(const std::string &json) {
  std::string out;
  for (const char ch : json) {
    if (ch != ' ' && ch != '\n' && ch != '\t' && ch != '\r') out.push_back(ch);
  }
  return out;
}

// ------------------------------------------------------------------- sabotage predicates

// T5: the view token never opens a track (refused by name, counted apart).
bool view_token_refused(Sabotage s) {
  H h(base_config(s));
  h.track(1, hello("input", kView));
  const TrackHub::KindStats *k = h.hub->kind_stats("input");
  return refused(h, 1, 1008, "track-unauthorized", "view-token") && k != nullptr &&
         k->refused.count("track-unauthorized:view-token") == 1 &&
         k->refused.at("track-unauthorized:view-token") == 1 && k->refused.count("track-unauthorized") == 0;
}

// T9: with rate 10/s burst 20, 20 quick texts pass and the 21st closes track-rate 1008.
bool rate_closes(Sabotage s) {
  TrackConfig c = base_config(s);
  c.rate_per_s = 10;
  c.burst = 20;
  H h(c);
  const std::uint32_t src = h.track(1, hello(), 0);
  if (src == 0) return false;
  for (int i = 0; i < 20; ++i) h.text(1, "m" + std::to_string(i), 1 * kMs);
  if (h.r.messages[src].size() != 20 || !h.t.closes[1].empty()) return false;
  h.text(1, "m20", 1 * kMs);
  return h.r.messages[src].size() == 20 && h.last_close(1) == std::make_pair(std::uint16_t(1008), std::string("track-rate")) &&
         h.t.texts[1].back() == TrackHub::error_json("track-rate", "") && h.r.closes[src].size() == 1 &&
         h.r.closes[src][0] == std::make_pair(std::uint16_t(1008), std::string("track-rate"));
}

// Check 2: an ungranted kind is refused track-kind-refused, before the credential is looked at.
bool grant_enforced(Sabotage s) {
  H h(base_config(s));
  Recorder other;
  std::string error;
  h.hub->bind("other", &other, &error);  // a receiver for it, so only the grant can refuse
  h.track(1, hello("other", std::string(64, 'f')));
  return refused(h, 1, 1008, "track-kind-refused", "") && other.opens.empty() &&
         h.hub->unattributed_refused().count("track-kind-refused") == 1;
}

// T8: a carrier Closed on an open track reports exactly one closed().
bool release_reported(Sabotage s) {
  H h(base_config(s));
  const std::uint32_t src = h.track(1, hello());
  if (src == 0) return false;
  h.peer_closed(1, 1006, "", 1 * kMs);
  return h.r.closes[src].size() == 1 && h.r.closes[src][0].first == 1006 &&
         h.r.closes[src][0].second == "peer-1006" && h.r.paired() && h.hub->open_tracks() == 0;
}

// TRK5 fixtures: a fixed key and wall clock.
const std::string kCapKey = std::string("\x00\x01\x02\x03\x04\x05\x06\x07\x08\x09\x0a\x0b\x0c\x0d\x0e\x0f"
                                        "\x10\x11\x12\x13\x14\x15\x16\x17\x18\x19\x1a\x1b\x1c\x1d\x1e\x1f",
                                        32);
constexpr std::int64_t kNow = 1767225600;

TrackConfig caps_config(Sabotage sabotage = Sabotage::None, std::int64_t *clock = nullptr) {
  TrackConfig c = base_config(sabotage);
  c.credentials.clear();
  c.caps = tr::CapsMode::Hmac;
  c.cap_key = kCapKey;
  if (clock != nullptr) {
    c.wall_clock_s = [clock] { return *clock; };
  } else {
    c.wall_clock_s = [] { return kNow; };
  }
  return c;
}

// TRK5: a capability expired past the skew is refused `expired`; one inside it opens.
bool cap_exp_enforced(Sabotage s) {
  H h(caps_config(s));
  h.track(1, hello("input", caps::mint(kCapKey, "input", "v", kNow - caps::kSkewS - 1, "e")));
  const bool expired = refused(h, 1, 1008, "track-unauthorized", "expired");
  const std::uint32_t src = h.track(2, hello("input", caps::mint(kCapKey, "input", "v", kNow - caps::kSkewS, "e")));
  return expired && src != 0;
}

// TRK5: a payload changed after signing is refused `bad-mac`.
bool cap_mac_enforced(Sabotage s) {
  H h(caps_config(s));
  const std::string good = caps::mint(kCapKey, "input", "viewer-1", kNow + 300, "m");
  const std::string forged_payload =
      caps::base64url_encode("{\"v\":1,\"kind\":\"input\",\"sub\":\"viewer-9\",\"exp\":" + std::to_string(kNow + 300) + "}");
  const std::string forged = std::string(caps::kPrefix) + forged_payload + good.substr(good.rfind('.'));
  h.track(1, hello("input", forged));
  return refused(h, 1, 1008, "track-unauthorized", "bad-mac");
}

void test_sabotages() {
  struct Case {
    Sabotage sabotage;
    bool (*pred)(Sabotage);
    const char *what;
  };
  const Case cases[] = {
      {Sabotage::ViewTokenAccepted, &view_token_refused, "view token refused"},
      {Sabotage::RateOff, &rate_closes, "rate closes track-rate"},
      {Sabotage::GrantIgnored, &grant_enforced, "grant enforced"},
      {Sabotage::NoRelease, &release_reported, "peer close reports closed()"},
      {Sabotage::CapExpIgnored, &cap_exp_enforced, "expired capability refused"},
      {Sabotage::CapMacIgnored, &cap_mac_enforced, "forged capability refused"},
  };
  for (const Case &c : cases) {
    check(c.pred(Sabotage::None), std::string("honest: ") + c.what);
    check(!c.pred(c.sabotage), std::string("sabotage ") + tr::sabotage_name(c.sabotage) + ": '" + c.what +
                                   "' must fail");
    // Every other sabotage leaves this predicate holding (each sabotage is narrow).
    for (const Case &o : cases) {
      if (o.sabotage == c.sabotage) continue;
      check(c.pred(o.sabotage), std::string("sabotage ") + tr::sabotage_name(o.sabotage) + " leaves '" + c.what +
                                    "' holding");
    }
  }
  Sabotage s = Sabotage::None;
  for (const char *name : {"track-view-token-accepted", "track-rate-off", "track-grant-ignored", "track-no-release",
                           "track-cap-mac-ignored", "track-cap-exp-ignored", "track-inject-no-release"}) {
    check(tr::parse_sabotage(name, &s) && std::string(tr::sabotage_name(s)) == name,
          std::string("parse_sabotage round trip ") + name);
  }
  check(!tr::parse_sabotage("track-nope", &s) && s == Sabotage::None, "parse_sabotage unknown -> None");
  check(tr::sabotage_needs_caps(Sabotage::CapMacIgnored) && tr::sabotage_needs_caps(Sabotage::CapExpIgnored) &&
            !tr::sabotage_needs_caps(Sabotage::NoRelease) && !tr::sabotage_needs_caps(Sabotage::None),
        "sabotage_needs_caps");
  // TRK6: the built-in injector's sabotage acts outside the hub; it only has to parse and name.
  check(tr::sabotage_needs_inject(Sabotage::InjectNoRelease) && !tr::sabotage_needs_inject(Sabotage::NoRelease) &&
            !tr::sabotage_needs_inject(Sabotage::CapMacIgnored) && !tr::sabotage_needs_inject(Sabotage::None) &&
            !tr::sabotage_needs_caps(Sabotage::InjectNoRelease),
        "sabotage_needs_inject");
}

// ------------------------------------------------------------------- the checks

void test_claims() {
  H h;
  Event e;
  e.kind = Event::Opened;
  e.conn = 1;
  e.subprotocol = tr::kTrackSubprotocolV1;
  check(h.hub->claims(e), "claims: track Opened");
  e.subprotocol = "render-stream.13";
  check(!h.hub->claims(e), "claims: view Opened not claimed");
  e.subprotocol = "";
  check(!h.hub->claims(e), "claims: empty subprotocol not claimed");
  e.kind = Event::Text;
  e.conn = 9;
  check(!h.hub->claims(e), "claims: Text on an unknown conn not claimed");
  e.kind = Event::Closed;
  check(!h.hub->claims(e), "claims: Closed on an unknown conn not claimed");
  h.open(9, 0);
  e.kind = Event::Text;
  check(h.hub->claims(e), "claims: Text on a claimed conn");
  e.kind = Event::Closed;
  check(h.hub->claims(e), "claims: Closed on a claimed conn");
  e.kind = Event::HttpGet;
  check(!h.hub->claims(e), "claims: HttpGet never claimed");
  // A refused connection stays claimed until the carrier's Closed.
  h.text(9, "nope", 0);
  e.kind = Event::Text;
  check(h.hub->claims(e), "claims: a refused conn stays claimed");
  h.peer_closed(9, 1002, "track-protocol", 0);
  check(!h.hub->claims(e), "claims: forgotten after Closed");
}

void test_hello_grammar() {
  {
    H h;
    const std::uint32_t src = h.track(1, hello());
    check(src == 1, "grammar: valid hello accepted");
    check(h.t.texts[1].size() == 1 && h.t.texts[1][0] == ready_json(1, "gsw-input/1", ""),
          "grammar: track-ready exact: " + describe(h, 1));
    check(h.t.closes[1].empty(), "grammar: accepted hello not closed");
  }
  struct Case {
    std::string text;
    std::string detail;
  };
  const std::string f = "[\"gsw-input/1\"]";
  const std::string k = "\"input\"";
  const std::string c = "\"" + kCred + "\"";
  std::string nine = "[";
  for (int i = 1; i <= 9; ++i) nine += std::string(i == 1 ? "" : ",") + "\"f/" + std::to_string(i) + "\"";
  nine += "]";
  const std::vector<Case> cases = {
      {"not json", "json"},
      {"{\"type\":\"track-hello\"", "json"},
      {"{\"type\":\"track-hello\"} x", "json"},
      {"", "json"},
      {"[1,2]", "not-object"},
      {"\"track-hello\"", "not-object"},
      {"{\"protocol\":\"render-stream-track/1\",\"kind\":\"input\",\"formats\":" + f + ",\"credential\":" + c + "}",
       "type"},
      {"{\"type\":\"track-ready\",\"protocol\":\"render-stream-track/1\",\"kind\":\"input\",\"formats\":" + f +
           ",\"credential\":" + c + "}",
       "type"},
      {"{\"type\":1,\"protocol\":\"render-stream-track/1\",\"kind\":\"input\",\"formats\":" + f +
           ",\"credential\":" + c + "}",
       "type"},
      {"{\"type\":\"track-hello\",\"protocol\":\"render-stream-track/2\",\"kind\":\"input\",\"formats\":" + f +
           ",\"credential\":" + c + "}",
       "protocol"},
      {"{\"type\":\"track-hello\",\"kind\":\"input\",\"formats\":" + f + ",\"credential\":" + c + "}", "protocol"},
      {hello_raw("", f, c), "kind"},
      {hello_raw("\"Input\"", f, c), "kind"},
      {hello_raw("\"1input\"", f, c), "kind"},
      {hello_raw("7", f, c), "kind"},
      {hello_raw("\"" + std::string(33, 'a') + "\"", f, c), "kind"},
      {hello_raw(k, "", c), "formats"},
      {hello_raw(k, "[]", c), "formats"},
      {hello_raw(k, nine, c), "formats"},
      {hello_raw(k, "[\"gsw-input/1\",\"gsw-input/1\"]", c), "formats"},
      {hello_raw(k, "[\"Gsw-input/1\"]", c), "formats"},
      {hello_raw(k, "[\"gsw-input/01\"]", c), "formats"},
      {hello_raw(k, "[1]", c), "formats"},
      {hello_raw(k, "\"gsw-input/1\"", c), "formats"},
      {hello_raw(k, f, c, ",\"down_formats\":[\"bad\"]"), "down-formats"},
      {hello_raw(k, f, c, ",\"down_formats\":\"x/1\""), "down-formats"},
      {hello_raw(k, f, c, ",\"down_formats\":" + nine), "down-formats"},
      {hello_raw(k, f, c, ",\"down_formats\":[\"x/1\",\"x/1\"]"), "down-formats"},
      {hello_raw(k, f, ""), "credential"},
      {hello_raw(k, f, "5"), "credential"},
      {hello_raw(k, f, "null"), "credential"},
      {hello_raw(k, f, c, ",\"client\":\"has space\""), "client"},
      {hello_raw(k, f, c, ",\"client\":5"), "client"},
      {hello_raw(k, f, c, ",\"client\":\"" + std::string(65, 'a') + "\""), "client"},
      {hello_raw(k, f, c, ",\"view\":\"x\""), "view"},
      {hello_raw(k, f, c, ",\"view\":{\"stream_id\":\"abc\",\"connection\":1}"), "view"},
      {hello_raw(k, f, c, ",\"view\":{\"stream_id\":\"" + std::string(32, 'a') + "\",\"connection\":0}"), "view"},
      {hello_raw(k, f, c, ",\"view\":{\"stream_id\":\"" + std::string(32, 'a') + "\",\"connection\":1.5}"), "view"},
      {hello_raw(k, f, c, ",\"view\":{\"stream_id\":\"" + std::string(32, 'A') + "\",\"connection\":1}"), "view"},
      {hello_raw(k, f, c, ",\"view\":{\"stream_id\":\"" + std::string(32, 'a') + "\"}"), "view"},
  };
  for (const Case &cs : cases) {
    H h;
    h.track(1, cs.text);
    check(refused(h, 1, 1002, "track-protocol", cs.detail),
          "grammar: '" + cs.text + "' -> track-protocol/" + cs.detail + ": " + describe(h, 1));
    check(h.hub->unattributed_refused().count("track-protocol") == 1, "grammar: counted unattributed");
  }
  {
    // Unknown members are ignored, at the top level and inside view; view null and a valid view
    // are accepted, and client/view reach the receiver.
    H h;
    const std::string view = "{\"stream_id\":\"" + std::string(32, 'b') + "\",\"connection\":2,\"extra\":[1]}";
    const std::uint32_t a =
        h.track(1, hello("input", kCred, f, ",\"future\":{\"a\":[1,{\"b\":null}]},\"client\":\"couch-web:1.0\","
                                            "\"view\":" + view + ",\"down_formats\":[]"));
    check(a == 1, "grammar: unknown members ignored: " + describe(h, 1));
    if (!h.r.opens.empty()) {
      const TrackInfo &i = h.r.opens[0];
      check(i.client == "couch-web:1.0" && i.view.has_value() && i.view->stream_id == std::string(32, 'b') &&
                i.view->connection == 2 && i.kind == "input" && i.format == "gsw-input/1" &&
                i.down_format.empty() && i.carrier == "ws" && i.origin == "http://127.0.0.1:1",
            "grammar: TrackInfo carries client, view, carrier and origin");
    }
    const std::uint32_t b = h.track(2, hello("input", kCred, f, ",\"view\":null"));
    check(b == 2 && !h.r.opens.back().view.has_value(), "grammar: view null accepted");
    // A text that looks like a hello after track-ready is a payload (Q1.3).
    h.text(1, hello(), 0);
    check(h.r.messages[a].size() == 1 && h.r.messages[a][0] == hello(), "grammar: a later hello is a payload");
  }
}

void test_check_order() {
  {
    // 1. UTF-8 before the grammar: invalid bytes that are also invalid JSON -> track-utf8.
    H h;
    h.track(1, "\xff not json");
    check(refused(h, 1, 1007, "track-utf8", ""), "order: utf8 before grammar: " + describe(h, 1));
    // ...and inside an otherwise valid hello string.
    h.track(2, hello("input", kCred, "[\"gsw-input/1\"]", ",\"client\":\"\xc0\xaf\""));
    check(h.t.texts[2].size() == 1 && h.t.texts[2][0] == TrackHub::error_json("track-utf8", "") &&
              h.last_close(2) == std::make_pair(std::uint16_t(1007), std::string("track-utf8")),
          "order: overlong byte in a string -> track-utf8");
  }
  {
    // 2. Grant before credential: an ungranted kind with a wrong credential is kind-refused.
    H h;
    h.track(1, hello("other", "wrong"));
    check(refused(h, 1, 1008, "track-kind-refused", ""), "order: ungranted + wrong credential -> kind-refused");
    // A reserved / unknown kind too.
    h.track(2, hello("audio", kCred));
    check(h.last_close(2).second == "track-kind-refused", "order: audio -> kind-refused");
    check(h.hub->unattributed_refused().at("track-kind-refused") == 2, "order: kind-refused counted unattributed");
    check(h.hub->kind_stats("other") == nullptr, "order: no stats for an ungranted kind");
  }
  {
    // 3. The view token by name; wrong; missing.
    H h;
    h.track(1, hello("input", kView));
    check(refused(h, 1, 1008, "track-unauthorized", "view-token"), "order: view token -> view-token");
    h.track(2, hello("input", std::string(64, 'd')));
    check(h.t.texts[2].size() == 1 && h.t.texts[2][0] == TrackHub::error_json("track-unauthorized", "wrong") &&
              h.last_close(2) == std::make_pair(std::uint16_t(1008), std::string("track-unauthorized")),
          "order: wrong credential -> detail wrong");
    h.track(3, hello("input", ""));
    check(h.t.texts[3].size() == 1 && h.t.texts[3][0] == TrackHub::error_json("track-unauthorized", "missing"),
          "order: empty credential -> detail missing");
    h.track(4, hello("input", kCred.substr(0, 63)));
    check(h.last_close(4).second == "track-unauthorized", "order: a prefix of the credential -> unauthorized");
    const TrackHub::KindStats *k = h.hub->kind_stats("input");
    check(k != nullptr && k->refused.at("track-unauthorized:view-token") == 1 &&
              k->refused.at("track-unauthorized") == 3,
          "order: view token counted apart");
    check(h.r.opens.empty() && h.r.closed_count() == 0, "order: refused hellos never reach the receiver");
  }
  {
    // A view token of "" (view auth none) never matches an empty credential as view-token.
    TrackConfig c = base_config();
    c.view_token.clear();
    H h(c);
    h.track(1, hello("input", ""));
    check(h.t.texts[1].size() == 1 && h.t.texts[1][0] == TrackHub::error_json("track-unauthorized", "missing"),
          "order: no view token -> empty credential is missing");
  }
  {
    // 4. Receiver after the credential.
    H h(base_config(), /*bind=*/false);
    h.track(1, hello("input", "wrong"));
    check(refused(h, 1, 1008, "track-unauthorized", "wrong"), "order: no receiver + wrong credential -> unauthorized");
    h.track(2, hello());
    check(h.t.texts[2].size() == 1 && h.t.texts[2][0] == TrackHub::error_json("track-no-receiver", "") &&
              h.last_close(2) == std::make_pair(std::uint16_t(1013), std::string("track-no-receiver")),
          "order: right credential, no receiver -> track-no-receiver 1013");
    check(h.hub->kind_stats("input")->refused.at("track-no-receiver") == 1, "order: no-receiver counted on the kind");
  }
  {
    // 5. Format.
    H h;
    h.track(1, hello("input", kCred, "[\"other/1\",\"x-acme-foo/2\"]"));
    check(refused(h, 1, 1008, "track-format-refused", ""), "order: no common format -> track-format-refused");
  }
  {
    // Texts after a refusal are dropped; claims hold until Closed; Closed reports nothing.
    H h;
    h.track(1, "garbage");
    h.text(1, hello(), 0);
    check(h.t.texts[1].size() == 1 && h.t.closes[1].size() == 1 && h.r.opens.empty(),
          "order: a text after the refusal is dropped");
    h.peer_closed(1, 1002, "track-protocol", 0);
    check(h.r.closed_count() == 0 && h.hub->open_tracks() == 0, "order: refused hello gets no closed()");
  }
}

void test_ready_and_sources() {
  H h;
  h.r.up = {"gsw-input/1", "x-acme-foo/2"};
  h.r.down = {"gsw-input-down/1", "x-acme-down/3"};
  const std::uint32_t a = h.track(1, hello("input", kCred, "[\"x-acme-foo/2\",\"gsw-input/1\"]"));
  check(a == 1 && h.t.texts[1].size() == 1 && h.t.texts[1][0] == ready_json(1, "x-acme-foo/2", ""),
        "ready: client preference wins, no down -> null: " + describe(h, 1));
  const std::uint32_t b =
      h.track(2, hello("input", kCred, "[\"nope/1\",\"gsw-input/1\"]",
                       ",\"down_formats\":[\"zzz/1\",\"x-acme-down/3\",\"gsw-input-down/1\"]"));
  check(b == 2 && h.t.texts[2][0] == ready_json(2, "gsw-input/1", "x-acme-down/3"),
        "ready: first common up and down format: " + describe(h, 2));
  check(!h.r.opens.empty() && h.r.opens.back().down_format == "x-acme-down/3", "ready: down format in info");
  const std::uint32_t c = h.track(3, hello("input", kCred, "[\"gsw-input/1\"]", ",\"down_formats\":[\"zzz/1\"]"));
  check(c == 3 && h.t.texts[3][0] == ready_json(3, "gsw-input/1", ""), "ready: no common down -> null, not refused");
  // A refused hello between does not consume a source; a closed track's source is not reused.
  h.track(4, "bad");
  h.peer_closed(1, 1000, "", 0);
  const std::uint32_t d = h.track(5, hello());
  check(d == 4, "ready: sources never reused (got " + std::to_string(d) + ")");
  {
    TrackConfig cfg = base_config();
    cfg.keepalive_ms = 250;
    cfg.max_message_bytes = 1024;
    cfg.rate_per_s = 60;
    cfg.burst = 120;
    H h2(cfg);
    h2.track(1, hello());
    check(h2.t.texts[1].size() == 1 && h2.t.texts[1][0] == ready_json(1, "gsw-input/1", "", cfg),
          "ready: keepalive_ms, max_message_bytes and rate from the config: " + describe(h2, 1));
  }
  check(h.hub->take_changed(), "ready: changed after opens");
  check(!h.hub->take_changed(), "ready: changed reset");
}

void test_payloads() {
  H h;
  const std::uint32_t s = h.track(1, hello());
  const std::vector<std::string> sent = {"a", "{\"x\":1}", "caf\xc3\xa9 \xf0\x9f\x98\x80", " spaces ",
                                         std::string(4096, 'z')};
  for (const std::string &p : sent) h.text(1, p, 1 * kMs);
  h.text(1, "", 2 * kMs);
  check(h.r.messages[s] == sent, "payloads: delivered verbatim and in order, \"\" not delivered");
  const TrackHub::KindStats *k = h.hub->kind_stats("input");
  std::uint64_t bytes = 0;
  for (const auto &p : sent) bytes += p.size();
  check(k->messages_in == sent.size() && k->bytes_in == bytes, "payloads: counted (keepalive excluded)");
  check(h.t.closes[1].empty(), "payloads: still open");
  // A second track's payloads stay apart.
  const std::uint32_t s2 = h.track(2, hello());
  h.text(2, "other", 3 * kMs);
  check(h.r.messages[s2] == std::vector<std::string>{"other"} && h.r.messages[s].size() == sent.size(),
        "payloads: per source");
  // Invalid UTF-8 closes track-utf8 1007 with closed().
  h.text(1, "ok\xed\xa0\x80", 4 * kMs);
  check(h.last_close(1) == std::make_pair(std::uint16_t(1007), std::string("track-utf8")) &&
            h.t.texts[1].back() == TrackHub::error_json("track-utf8", ""),
        "payloads: invalid utf8 -> track-utf8 1007: " + describe(h, 1));
  check(h.r.closes[s].size() == 1 && h.r.closes[s][0] == std::make_pair(std::uint16_t(1007), std::string("track-utf8")),
        "payloads: utf8 close reports closed()");
  check(h.r.messages[s].size() == sent.size(), "payloads: the bad text is not delivered");
  h.text(1, "late", 5 * kMs);
  check(h.r.messages[s].size() == sent.size(), "payloads: texts after the close are dropped");
  // Over max_message_bytes (a carrier with a larger cap): closed, never skipped.
  h.text(2, std::string(4097, 'y'), 6 * kMs);
  check(h.last_close(2) == std::make_pair(std::uint16_t(1009), std::string("message-too-large")) &&
            h.r.closes[s2].size() == 1,
        "payloads: over max_message_bytes -> 1009 with closed()");
  h.peer_closed(1, 1007, "track-utf8", 7 * kMs);
  h.peer_closed(2, 1009, "message-too-large", 7 * kMs);
  check(h.r.paired(), "payloads: one closed per opened");
  check(k->closes.at("track-utf8") == 1 && k->closes.at("message-too-large") == 1 && k->closed == 2,
        "payloads: close reasons counted");
}

void test_rate_refill() {
  TrackConfig c = base_config();
  c.rate_per_s = 10;
  c.burst = 20;
  H h(c);
  const std::uint32_t s = h.track(1, hello(), 0);
  for (int i = 0; i < 20; ++i) h.text(1, "a", 0);
  check(h.r.messages[s].size() == 20 && h.t.closes[1].empty(), "rate: burst of 20 passes");
  for (int i = 0; i < 10; ++i) h.text(1, "b", 1 * kS);  // one second refills 10
  check(h.r.messages[s].size() == 30 && h.t.closes[1].empty(), "rate: 10 more after 1 s refill");
  // Keepalives count against the bucket too (T9).
  h.text(1, "", 1 * kS);
  check(h.last_close(1) == std::make_pair(std::uint16_t(1008), std::string("track-rate")) &&
            h.r.closes[s].size() == 1,
        "rate: a keepalive past the bucket closes track-rate: " + describe(h, 1));
  // A long idle refill caps at burst.
  H h2(c);
  const std::uint32_t s2 = h2.track(1, hello(), 0);
  for (int i = 0; i < 21; ++i) h2.text(1, "x", 100 * kS);
  check(h2.r.messages[s2].size() == 20 && h2.last_close(1).second == "track-rate", "rate: refill caps at burst");
  check(h.r.paired() && h2.r.paired(), "rate: paired");
}

void test_keepalive_and_idle() {
  H h;  // keepalive 1000 ms
  const std::uint32_t s = h.track(1, hello(), 0);
  h.hub->tick(999 * kMs);
  check(h.t.texts[1].size() == 1, "keepalive: nothing before keepalive_ms");
  h.hub->tick(1000 * kMs);
  check(h.t.texts[1].size() == 2 && h.t.texts[1][1].empty(), "keepalive: \"\" at keepalive_ms");
  h.hub->tick(1500 * kMs);
  check(h.t.texts[1].size() == 2, "keepalive: not again before the next period");
  h.text(1, "", 2500 * kMs);  // the client's keepalive resets idle
  h.hub->tick(3000 * kMs);
  check(h.t.closes[1].empty(), "idle: a received keepalive defers idle");
  check(h.r.messages[s].empty(), "keepalive: client \"\" not delivered");
  h.hub->tick(5499 * kMs);
  check(h.t.closes[1].empty(), "idle: not before 3x keepalive_ms");
  h.hub->tick(5500 * kMs);
  check(h.last_close(1) == std::make_pair(std::uint16_t(1001), std::string("track-idle")) &&
            h.t.texts[1].back() == TrackHub::error_json("track-idle", ""),
        "idle: 3x keepalive_ms without receive -> track-idle 1001: " + describe(h, 1));
  check(h.r.closes[s].size() == 1 && h.r.closes[s][0].first == 1001 && h.r.closes[s][0].second == "track-idle",
        "idle: closed() reported");
  h.hub->tick(9000 * kMs);
  check(h.t.closes[1].size() == 1 && h.r.closes[s].size() == 1, "idle: no second close");
  // Exactly at 3x without anything since the hello.
  H h2;
  const std::uint32_t s2 = h2.track(1, hello(), 0);
  h2.hub->tick(3000 * kMs);
  check(h2.last_close(1).second == "track-idle" && h2.r.closes[s2].size() == 1, "idle: at exactly 3x keepalive");
  // Host keepalive tracks the last send: a down payload defers it.
  H h3;
  h3.r.down = {"d/1"};
  const std::uint32_t s3 = h3.track(1, hello("input", kCred, "[\"gsw-input/1\"]", ",\"down_formats\":[\"d/1\"]"), 0);
  h3.hub->tick(800 * kMs);
  check(h3.hub->send(s3, "down"), "keepalive: send ok");
  h3.hub->tick(1000 * kMs);
  check(h3.t.texts[1].size() == 2 && h3.t.texts[1][1] == "down", "keepalive: a send defers the host keepalive");
  h3.hub->tick(1800 * kMs);
  check(h3.t.texts[1].size() == 3 && h3.t.texts[1][2].empty(), "keepalive: due a period after the send");
}

void test_hello_timeout() {
  H h;  // hello timeout 5000 ms
  h.open(1, 0);
  h.hub->tick(4999 * kMs);
  check(h.t.texts[1].empty() && h.t.closes[1].empty(), "hello timeout: not before 5000 ms");
  h.hub->tick(5000 * kMs);
  check(refused(h, 1, 1002, "track-hello-timeout", ""), "hello timeout: -> track-hello-timeout 1002: " + describe(h, 1));
  check(h.hub->unattributed_refused().at("track-hello-timeout") == 1, "hello timeout: counted");
  h.text(1, hello(), 5001 * kMs);
  check(h.r.opens.empty() && h.t.texts[1].size() == 1, "hello timeout: a late hello is dropped");
  h.hub->tick(6000 * kMs);
  check(h.t.closes[1].size() == 1, "hello timeout: closed once");
  h.peer_closed(1, 1002, "track-hello-timeout", 6000 * kMs);
  check(h.r.closed_count() == 0, "hello timeout: no closed()");
}

void test_peer_close() {
  H h;
  const std::uint32_t s = h.track(1, hello());
  h.text(1, "x", 1 * kMs);
  h.peer_closed(1, 1000, "bye", 2 * kMs);
  check(h.r.closes[s].size() == 1 && h.r.closes[s][0] == std::make_pair(std::uint16_t(1000), std::string("bye")),
        "peer close: exactly one closed(code, reason)");
  check(h.t.closes[1].empty(), "peer close: the host does not close back");
  check(h.hub->open_tracks() == 0 && !h.hub->send(s, "x") && !h.hub->close(s, 1000), "peer close: source gone");
  h.peer_closed(1, 1000, "bye", 3 * kMs);
  check(h.r.closes[s].size() == 1, "peer close: a duplicate Closed is ignored");
  check(h.hub->kind_stats("input")->closes.at("peer-1000") == 1, "peer close: counted peer-<code>");
}

void test_receiver_close_and_send() {
  H h;
  h.r.down = {"d/1"};
  const std::uint32_t up_only = h.track(1, hello());
  const std::uint32_t both = h.track(2, hello("input", kCred, "[\"gsw-input/1\"]", ",\"down_formats\":[\"d/1\"]"));
  check(!h.hub->send(up_only, "x"), "send: refused without a down format");
  check(h.hub->send(both, "down \xc3\xa9"), "send: with a down format");
  check(h.t.texts[2].back() == "down \xc3\xa9", "send: verbatim on the wire");
  check(!h.hub->send(both, ""), "send: empty refused");
  check(h.hub->send(both, std::string(4096, 'q')), "send: max_message_bytes ok");
  check(!h.hub->send(both, std::string(4097, 'q')), "send: over max_message_bytes refused");
  check(!h.hub->send(both, "\xff"), "send: invalid utf8 refused");
  check(!h.hub->send(99, "x") && !h.hub->send(0, "x"), "send: unknown source refused");
  const TrackHub::KindStats *k = h.hub->kind_stats("input");
  check(k->messages_out == 2 && k->bytes_out == 4096 + 7, "send: counted");
  h.t.fail_send = true;
  check(!h.hub->send(both, "y") && k->faults.at("send-failed") == 1, "send: a transport failure is a fault");
  h.t.fail_send = false;

  check(!h.hub->close(up_only, 1001), "close: 1001 refused");
  check(!h.hub->close(up_only, 3999) && !h.hub->close(up_only, 5000) && !h.hub->close(up_only, 1011),
        "close: codes outside 1000/4000-4999 refused");
  check(h.t.closes[1].empty(), "close: refused codes do nothing");
  check(h.hub->close(up_only, 1000), "close: 1000");
  check(h.t.texts[1].back() == TrackHub::error_json("track-closed", "") &&
            h.last_close(1) == std::make_pair(std::uint16_t(1000), std::string("track-closed")),
        "close: track-error then close track-closed 1000");
  check(h.r.closes[up_only].size() == 1 &&
            h.r.closes[up_only][0] == std::make_pair(std::uint16_t(1000), std::string("track-closed")),
        "close: closed() reported");
  check(!h.hub->close(up_only, 1000), "close: a second close is false");
  check(h.hub->close(both, 4321) && h.last_close(2) == std::make_pair(std::uint16_t(4321), std::string("track-closed")),
        "close: 4xxx");
  check(!h.hub->send(both, "x"), "send: refused after close");
  h.peer_closed(1, 1000, "track-closed", 0);
  h.peer_closed(2, 4321, "track-closed", 0);
  check(h.r.paired(), "close: one closed per opened after the carrier's Closed");
}

void test_bind_unbind() {
  H h;
  std::string error;
  Recorder second;
  check(!h.hub->bind("input", &second, &error) && error == "track-kind-bound", "bind: kind-bound");
  check(h.hub->bind("input", &h.r, &error), "bind: the same receiver again is fine");
  Recorder empty;
  empty.up = {};
  check(!h.hub->bind("x", &empty, &error) && error == "track-formats-invalid", "bind: empty formats");
  Recorder nine;
  nine.up.clear();
  for (int i = 1; i <= 9; ++i) nine.up.push_back("f/" + std::to_string(i));
  check(!h.hub->bind("x", &nine, &error) && error == "track-formats-invalid", "bind: 9 formats");
  Recorder dup;
  dup.up = {"a/1", "a/1"};
  check(!h.hub->bind("x", &dup, &error) && error == "track-formats-invalid", "bind: duplicate formats");
  Recorder bad;
  bad.up = {"A/1"};
  check(!h.hub->bind("x", &bad, &error) && error == "track-formats-invalid", "bind: bad format grammar");
  Recorder bad_down;
  bad_down.down = {"nope"};
  check(!h.hub->bind("x", &bad_down, &error) && error == "track-formats-invalid", "bind: bad down format");
  Recorder ok;
  check(!h.hub->bind("Bad", &ok, &error) && error == "track-kind-invalid", "bind: bad kind");
  check(!h.hub->bind("", &ok, &error) && error == "track-kind-invalid", "bind: empty kind");
  check(!h.hub->bind("x", nullptr, &error) && error == "track-kind-invalid", "bind: null receiver");
  check(!h.hub->bound("x"), "bind: failures bind nothing");

  const std::uint32_t a = h.track(1, hello());
  const std::uint32_t b = h.track(2, hello());
  h.open(3, 0);  // a pending hello is untouched by unbind
  h.hub->unbind(&h.r);
  check(h.last_close(1) == std::make_pair(std::uint16_t(1013), std::string("track-receiver-gone")) &&
            h.last_close(2) == std::make_pair(std::uint16_t(1013), std::string("track-receiver-gone")) &&
            h.t.texts[1].back() == TrackHub::error_json("track-receiver-gone", ""),
        "unbind: open sources closed track-receiver-gone 1013");
  check(h.r.closes[a].size() == 1 && h.r.closes[b].size() == 1 && h.r.closes[a][0].second == "track-receiver-gone",
        "unbind: closed() reported to the receiver");
  check(h.t.closes[3].empty(), "unbind: a pending hello stays");
  check(!h.hub->bound("input"), "unbind: kind unbound");
  h.text(3, hello(), 0);
  check(h.last_close(3) == std::make_pair(std::uint16_t(1013), std::string("track-no-receiver")),
        "unbind: a later hello -> track-no-receiver");
  check(h.hub->bind("input", &second, &error), "unbind: another receiver may bind now");
  h.peer_closed(1, 1013, "", 0);
  h.peer_closed(2, 1013, "", 0);
  check(h.r.paired(), "unbind: paired");
}

void test_close_all() {
  H h;
  const std::uint32_t a = h.track(1, hello());
  h.open(2, 0);  // pending hello
  h.hub->close_all(1001, "stream-ended");
  check(h.t.texts[1].back() == TrackHub::error_json("stream-ended", "") &&
            h.last_close(1) == std::make_pair(std::uint16_t(1001), std::string("stream-ended")),
        "close_all: open track closed stream-ended 1001");
  check(h.r.closes[a].size() == 1 && h.r.closes[a][0] == std::make_pair(std::uint16_t(1001), std::string("stream-ended")),
        "close_all: closed() reported");
  check(h.t.texts[2].size() == 1 && h.t.texts[2][0] == TrackHub::error_json("stream-ended", "") &&
            h.last_close(2) == std::make_pair(std::uint16_t(1001), std::string("stream-ended")),
        "close_all: pending hello closed the same way");
  h.text(2, hello(), 1 * kMs);
  check(h.r.opens.size() == 1, "close_all: a pending conn's late hello is dropped");
  h.open(3, 2 * kMs);
  check(h.t.texts[3].size() == 1 && h.t.texts[3][0] == TrackHub::error_json("stream-ended", "") &&
            h.last_close(3) == std::make_pair(std::uint16_t(1001), std::string("stream-ended")),
        "close_all: a later Opened is closed at once: " + describe(h, 3));
  h.text(3, hello(), 2 * kMs);
  check(h.r.opens.size() == 1 && h.t.texts[3].size() == 1, "close_all: its hello is dropped");
  h.hub->close_all(1001, "stream-ended");
  check(h.t.closes[1].size() == 1 && h.r.closes[a].size() == 1, "close_all: idempotent");
  for (std::uint32_t c : {1u, 2u, 3u}) h.peer_closed(c, 1001, "stream-ended", 3 * kMs);
  check(h.r.paired() && h.r.closed_count() == 1, "close_all: exactly one closed() total");
}

void test_reentrant_receiver() {
  {
    // close() from inside opened(): one closed(), no crash, the later Closed adds nothing.
    H h;
    h.r.on_opened = [&h](const TrackInfo &i) { check(h.hub->close(i.source, 4000), "reentrant: close in opened"); };
    const std::uint32_t s = h.track(1, hello());
    check(s == 1 && h.r.closes[s].size() == 1 && h.r.closes[s][0].first == 4000, "reentrant: closed once from opened");
    check(h.t.texts[1].size() == 2 && h.t.texts[1][0] == ready_json(1, "gsw-input/1", ""),
          "reentrant: ready queued before the close");
    h.text(1, "late", 1 * kMs);
    h.peer_closed(1, 4000, "track-closed", 1 * kMs);
    check(h.r.messages[s].empty() && h.r.paired(), "reentrant: paired after close in opened");
  }
  {
    // send()+close() from inside message(): later texts dropped, one closed().
    H h;
    h.r.down = {"d/1"};
    h.r.on_message = [&h](std::uint32_t s, const std::string &t) {
      check(h.hub->send(s, "echo:" + t), "reentrant: send in message");
      if (t == "stop") check(h.hub->close(s, 1000), "reentrant: close in message");
    };
    // closed() itself may call back; both are refused, nothing double-reports.
    h.r.on_closed = [&h](std::uint32_t s) {
      check(!h.hub->send(s, "x") && !h.hub->close(s, 1000), "reentrant: send/close in closed() refused");
    };
    const std::uint32_t s = h.track(1, hello("input", kCred, "[\"gsw-input/1\"]", ",\"down_formats\":[\"d/1\"]"));
    h.text(1, "a", 1 * kMs);
    h.text(1, "stop", 1 * kMs);
    h.text(1, "after", 1 * kMs);
    check(h.r.messages[s] == std::vector<std::string>{"a", "stop"}, "reentrant: texts after close dropped");
    check(h.r.closes[s].size() == 1 && h.t.closes[1].size() == 1, "reentrant: one close, one closed()");
    h.hub->tick(10 * kS);
    h.hub->close_all(1001, "stream-ended");
    h.peer_closed(1, 1000, "", 10 * kS);
    check(h.r.paired(), "reentrant: paired");
  }
  {
    // unbind from inside message() on another receiver's behalf is still single-reported.
    H h;
    h.r.on_message = [&h](std::uint32_t, const std::string &) { h.hub->unbind(&h.r); };
    const std::uint32_t s = h.track(1, hello());
    h.text(1, "x", 1 * kMs);
    check(h.r.closes[s].size() == 1 && h.r.closes[s][0].second == "track-receiver-gone",
          "reentrant: unbind inside message closes once");
    h.peer_closed(1, 1013, "", 2 * kMs);
    check(h.r.paired(), "reentrant: unbind paired");
  }
}

void test_pairing_everywhere() {
  // One stress run over every ending: peer, utf8, rate, idle, receiver close, unbind, close_all.
  TrackConfig c = base_config();
  c.rate_per_s = 5;
  c.burst = 2;
  H h(c);
  std::vector<std::uint32_t> src;
  for (std::uint32_t conn = 1; conn <= 7; ++conn) src.push_back(h.track(conn, hello(), 0));
  h.peer_closed(1, 1006, "", 1 * kMs);           // network loss
  h.text(2, "\xc0\x80", 1 * kMs);                // utf8
  for (int i = 0; i < 3; ++i) h.text(3, "r", 1 * kMs);  // rate
  h.hub->close(src[3], 1000);                    // receiver close
  for (std::uint32_t conn : {5u, 6u, 7u}) h.text(conn, "", 2000 * kMs);
  h.text(7, "", 2900 * kMs);
  h.hub->tick(3000 * kMs);                       // idle: 4 never sent anything (already closed)
  h.text(5, "", 4000 * kMs);
  h.hub->tick(5000 * kMs);                       // 6 idles out at 2000+3000
  h.hub->unbind(&h.r);                           // 5 and 7 receiver-gone
  h.hub->close_all(1001, "stream-ended");
  for (std::uint32_t conn = 1; conn <= 7; ++conn) h.peer_closed(conn, 1000, "", 6000 * kMs);
  check(h.r.opens.size() == 7 && h.r.paired(), "pairing: one closed() per opened() across every ending");
  const auto reason = [&h](std::uint32_t s) { return h.r.closes[s].empty() ? std::string() : h.r.closes[s][0].second; };
  check(reason(src[0]) == "peer-1006" && reason(src[1]) == "track-utf8" && reason(src[2]) == "track-rate" &&
            reason(src[3]) == "track-closed" && reason(src[5]) == "track-idle" &&
            reason(src[4]) == "track-receiver-gone" && reason(src[6]) == "track-receiver-gone",
        "pairing: each ending's reason");
  const TrackHub::KindStats *k = h.hub->kind_stats("input");
  check(k->opened == 7 && k->closed == 7, "pairing: kind counts opened 7 closed 7");
}

void test_json() {
  H h;
  h.track(1, hello());
  h.track(2, hello("input", kView));
  h.track(3, "junk");
  h.text(1, "abc", 0);
  TrackHub::Extras extras;
  extras.max_tracks = 4;
  extras.admitted_max = 2;
  extras.carriers = {{"ws", true}, {"wt", false}, {"mine", std::nullopt}};
  const std::string j = compact(h.hub->json(extras));
  const auto has = [&j](const std::string &s) { return j.find(s) != std::string::npos; };
  check(has("\"schema\":\"render-stream-live-tracks/1\""), "json: schema: " + j);
  check(has("\"kinds\":[\"input\"]") && has("\"max_tracks\":4") && has("\"admitted_max\":2") &&
            has("\"keepalive_ms\":1000") && has("\"messages_per_second\":1000") && has("\"burst\":2000"),
        "json: config fields: " + j);
  check(has("\"name\":\"ws\",\"tracks\":true") && has("\"name\":\"wt\",\"tracks\":false") &&
            has("\"name\":\"mine\",\"tracks\":null"),
        "json: carriers: " + j);
  check(has("\"bound\":true") && has("\"formats\":[\"gsw-input/1\"]") && has("\"opened\":1") &&
            has("\"closed\":0") && has("\"messages_in\":1") && has("\"bytes_in\":3"),
        "json: kind counts: " + j);
  check(has("\"track-unauthorized:view-token\":1") && has("\"track-protocol\":1") && has("\"sabotage\":null"),
        "json: refusals and sabotage: " + j);
  check(j.find(kCred) == std::string::npos && j.find(kView) == std::string::npos, "json: no secret material");
  check(has("\"inject\":null"), "json: inject null by default: " + j);
  {
    TrackConfig injected = base_config(Sabotage::None);
    injected.inject_mode = "reference";
    injected.inject_addon_sha256 = std::string(64, 'a');
    H hi(injected);
    const std::string ji = compact(hi.hub->json(extras));
    check(ji.find("\"inject\":{\"mode\":\"reference\",\"addon_sha256\":\"" + std::string(64, 'a') + "\"}") !=
              std::string::npos,
          "json: inject object: " + ji);
  }
  H hs(base_config(Sabotage::RateOff));
  check(compact(hs.hub->json(extras)).find("\"sabotage\":\"track-rate-off\"") != std::string::npos, "json: sabotage named");
  for (const std::string &l : h.logs) {
    check(l.find(kCred) == std::string::npos && l.find(kView) == std::string::npos && l.find("abc") == std::string::npos,
          "logs: no credential, token or payload: " + l);
  }
}

void test_parse_kinds() {
  std::vector<std::string> kinds = {"stale"};
  std::string error;
  check(tr::parse_kinds(nullptr, &kinds, &error) && kinds.empty(), "kinds: unset -> ok, empty");
  kinds = {"stale"};
  check(tr::parse_kinds("", &kinds, &error) && kinds.empty(), "kinds: empty -> ok, empty");
  check(tr::parse_kinds("input", &kinds, &error) && kinds == std::vector<std::string>{"input"}, "kinds: input");
  check(tr::parse_kinds(" input ", &kinds, &error) && kinds == std::vector<std::string>{"input"}, "kinds: ' input '");
  struct Case {
    const char *text;
    const char *error;
  };
  const Case cases[] = {
      {"input,input", "tracks-invalid: duplicate kind input"},
      {"input,", "tracks-invalid: empty item in GRC_LIVE_TRACKS"},
      {",input", "tracks-invalid: empty item in GRC_LIVE_TRACKS"},
      {" ", "tracks-invalid: empty item in GRC_LIVE_TRACKS"},
      {"Input", "tracks-invalid: malformed kind in GRC_LIVE_TRACKS"},
      {"in put", "tracks-invalid: malformed kind in GRC_LIVE_TRACKS"},
      {"audio", "tracks-reserved: audio"},
      {"input,clipboard", "tracks-reserved: clipboard"},
      {"metadata", "tracks-reserved: metadata"},
      {"data", "tracks-reserved: data"},
      {"foo", "tracks-invalid: unknown kind foo"},
  };
  for (const Case &c : cases) {
    kinds = {"stale"};
    error.clear();
    check(!tr::parse_kinds(c.text, &kinds, &error) && error == c.error && kinds.empty(),
          std::string("kinds: '") + c.text + "' -> " + c.error + " (got " + error + ")");
  }
  check(tr::kind_reserved("audio") && !tr::kind_reserved("input"), "kind_reserved");
}

void test_utf8() {
  struct Case {
    std::string text;
    bool ok;
    const char *what;
  };
  const Case cases[] = {
      {"", true, "empty"},
      {"plain ascii", true, "ascii"},
      {"\xc3\xa9", true, "2-byte"},
      {"\xe2\x82\xac", true, "3-byte"},
      {"\xf0\x9f\x98\x80", true, "4-byte"},
      {"\xef\xbf\xbf", true, "U+FFFF"},
      {"\xf4\x8f\xbf\xbf", true, "U+10FFFF"},
      {"\xed\x9f\xbf", true, "U+D7FF"},
      {"\xee\x80\x80", true, "U+E000"},
      {"\xc0\xaf", false, "overlong 2-byte"},
      {"\xc1\xbf", false, "overlong 2-byte C1"},
      {"\xe0\x80\xaf", false, "overlong 3-byte"},
      {"\xf0\x80\x80\xaf", false, "overlong 4-byte"},
      {"\xed\xa0\x80", false, "high surrogate"},
      {"\xed\xbf\xbf", false, "low surrogate"},
      {"\xf4\x90\x80\x80", false, ">U+10FFFF"},
      {"\xf5\x80\x80\x80", false, "F5 lead"},
      {"\xf8\x88\x80\x80\x80", false, "5-byte lead"},
      {"\xe2\x82", false, "truncated 3-byte"},
      {"a\xf0\x9f\x98", false, "truncated 4-byte"},
      {"\xc3", false, "truncated 2-byte"},
      {"\x80", false, "lone continuation"},
      {"\xc3\x28", false, "bad continuation"},
      {std::string("a\0b", 3), true, "NUL is valid UTF-8"},
  };
  for (const Case &c : cases) check(tr::utf8_valid(c.text) == c.ok, std::string("utf8: ") + c.what);
}

void test_format_ok() {
  const std::string n48(48, 'a');
  const std::string n49(49, 'a');
  struct Case {
    std::string text;
    bool ok;
  };
  const Case cases[] = {
      {"gsw-input/1", true},  {"x-acme-foo/65535", true}, {"a/1", true},       {"a.b-c9/42", true},
      {n48 + "/1", true},     {n49 + "/1", false},        {"/1", false},       {"a/0", false},
      {"a/01", false},        {"a/65536", false},         {"a/100000", false}, {"A/1", false},
      {"1a/1", false},        {"a_b/1", false},           {"a/", false},       {"a", false},
      {"a/1/2", false},       {"a/1a", false},            {"a/-1", false},     {"", false},
  };
  for (const Case &c : cases) {
    check(tr::format_ok(c.text) == c.ok, "format_ok: '" + c.text + "' -> " + (c.ok ? "ok" : "refused"));
  }
}

}  // namespace

// ------------------------------------------------------------------- TRK5 capabilities

std::string hex_of(const std::array<std::uint8_t, 32> &d) {
  return caps::key_to_hex(std::string_view(reinterpret_cast<const char *>(d.data()), d.size()));
}

void test_cap_primitives() {
  // RFC 4231 cases 1, 2 and 6 (a key longer than the block is hashed first).
  check(hex_of(caps::hmac_sha256(std::string(20, '\x0b'), "Hi There")) ==
            "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7",
        "hmac: RFC 4231 case 1");
  check(hex_of(caps::hmac_sha256("Jefe", "what do ya want for nothing?")) ==
            "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843",
        "hmac: RFC 4231 case 2");
  check(hex_of(caps::hmac_sha256(std::string(131, '\xaa'), "Test Using Larger Than Block-Size Key - Hash Key First")) ==
            "60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54",
        "hmac: RFC 4231 case 6");
  // base64url: RFC 4648 section 10's vectors without padding, round trip, strictness.
  const std::pair<const char *, const char *> b64[] = {
      {"", ""}, {"f", "Zg"}, {"fo", "Zm8"}, {"foo", "Zm9v"}, {"foob", "Zm9vYg"}, {"fooba", "Zm9vYmE"}, {"foobar", "Zm9vYmFy"}};
  for (const auto &[plain, enc] : b64) {
    std::string back;
    check(caps::base64url_encode(plain) == enc && caps::base64url_decode(enc, &back) && back == plain,
          std::string("base64url: ") + plain);
  }
  std::string all;
  for (int i = 0; i < 256; ++i) all.push_back(static_cast<char>(i));
  std::string back;
  const std::string all_enc = caps::base64url_encode(all);
  check(all_enc.find_first_of("+/=") == std::string::npos && caps::base64url_decode(all_enc, &back) && back == all,
        "base64url: every byte round trips, url alphabet only");
  for (const char *bad : {"Zg==", "Zm9v+", "Zm9v/", "Z", "Zm9vY", "Zh", "Zm9", "Zm9vYmF=", "Zm 9v"}) {
    check(!caps::base64url_decode(bad, &back), std::string("base64url: refuses ") + bad);
  }
  check(caps::base64url_decode("Zm8", &back) && !caps::base64url_decode("Zm9", &back), "base64url: canonical last char only");
  std::string key;
  check(caps::key_from_hex(caps::key_to_hex(kCapKey), &key) && key == kCapKey, "key hex round trip");
  check(!caps::key_from_hex(std::string(64, 'A'), &key) && !caps::key_from_hex(std::string(62, 'a'), &key),
        "key hex: 64 lowercase only");
  const std::string k1 = caps::generate_key();
  const std::string k2 = caps::generate_key();
  check(k1.size() == 32 && k2.size() == 32 && k1 != k2, "generate_key: 32 random bytes");
  check(caps::mint(kCapKey, "Input", "v", 1, "") .empty() && caps::mint(kCapKey, "input", "", 1, "").empty() &&
            caps::mint(kCapKey, "input", "v", 0, "").empty() && caps::mint(kCapKey, "input", "v", 1, "a b").empty(),
        "mint: refuses arguments outside the grammar");
}

struct CapVector {
  std::string name, kind, credential, expect, subject;
};

bool load_cap_vectors(std::string *key, std::int64_t *now, std::vector<CapVector> *out) {
  std::ifstream in(GRC_TRACK_CAP_VECTORS, std::ios::binary);
  if (!in) return false;
  std::stringstream buf;
  buf << in.rdbuf();
  const std::string text = buf.str();
  grc::rs::json_lite::JValue root;
  grc::rs::json_lite::Reader reader(text);
  using JV = grc::rs::json_lite::JValue;
  if (!reader.parse(&root) || root.kind != JV::Object) return false;
  const JV *schema = root.get("schema");
  const JV *key_hex = root.get("key_hex");
  const JV *now_v = root.get("now");
  const JV *skew = root.get("skew_s");
  const JV *life = root.get("max_lifetime_s");
  const JV *vectors = root.get("vectors");
  if (schema == nullptr || schema->text != "render-stream-track-cap-vectors/1" || key_hex == nullptr ||
      !caps::key_from_hex(key_hex->text, key) || now_v == nullptr || now_v->kind != JV::Number || skew == nullptr ||
      skew->text != std::to_string(caps::kSkewS) || life == nullptr ||
      life->text != std::to_string(caps::kMaxLifetimeS) || vectors == nullptr || vectors->kind != JV::Array) {
    return false;
  }
  *now = std::stoll(now_v->text);
  for (const JV &v : vectors->items) {
    CapVector c;
    const JV *name = v.get("name");
    const JV *kind = v.get("kind");
    const JV *cred = v.get("credential");
    const JV *expect = v.get("expect");
    const JV *subject = v.get("subject");
    if (name == nullptr || kind == nullptr || cred == nullptr || expect == nullptr) return false;
    c.name = name->text;
    c.kind = kind->text;
    c.credential = cred->text;
    c.expect = expect->text;
    c.subject = subject != nullptr ? subject->text : std::string();
    out->push_back(std::move(c));
  }
  return !out->empty();
}

void test_cap_vectors() {
  std::string key;
  std::int64_t now = 0;
  std::vector<CapVector> vectors;
  check(load_cap_vectors(&key, &now, &vectors), std::string("vectors: load ") + GRC_TRACK_CAP_VECTORS);
  check(key == kCapKey && now == kNow, "vectors: key 0x00..0x1f, now 2026-01-01");
  int ok = 0;
  int refusals = 0;
  for (const CapVector &v : vectors) {
    const caps::Verdict d = caps::verify(key, v.credential, v.kind, now);
    const bool want_ok = v.expect == "ok";
    check(d.ok == want_ok && (want_ok ? d.subject == v.subject : d.detail == v.expect),
          "vector " + v.name + ": want " + v.expect + " got " + (d.ok ? "ok " + d.subject : d.detail));
    (want_ok ? ok : refusals) += 1;
    // The same answer through the hub (hello check 3), with both kinds granted and bound.
    TrackConfig c = caps_config();
    c.kinds = {"input", "data"};
    H hub(c, false);
    std::string error;
    check(hub.hub->bind(v.kind, &hub.r, &error), "vector " + v.name + ": bind " + error);
    const std::uint32_t src = hub.track(1, hello(v.kind, v.credential));
    if (want_ok) {
      check(src != 0 && hub.r.opens.size() == 1 && hub.r.opens[0].subject == v.subject,
            "vector " + v.name + " through the hub: opened with subject " + v.subject + ": " + describe(hub, 1));
    } else {
      check(refused(hub, 1, 1008, "track-unauthorized", v.expect),
            "vector " + v.name + " through the hub: " + describe(hub, 1));
    }
  }
  check(ok >= 5 && refusals >= 30, "vectors: " + std::to_string(ok) + " ok, " + std::to_string(refusals) + " refused");
  // The C++ minter writes the TS minter's bytes.
  const auto find = [&vectors](const std::string &name) {
    for (const CapVector &v : vectors) {
      if (v.name == name) return v.credential;
    }
    return std::string();
  };
  check(caps::mint(kCapKey, "input", "viewer-1", kNow + 300, "n1") == find("ok"), "mint == vector ok");
  check(caps::mint(kCapKey, "input", "alice@example.com", kNow + 60, "") == find("ok-no-nonce"),
        "mint == vector ok-no-nonce");
  check(caps::mint(kCapKey, "input", "v", kNow - 31, "s") == find("expired"), "mint == vector expired");
}

void test_cap_hub() {
  std::int64_t clock = kNow;
  TrackConfig c = caps_config(Sabotage::None, &clock);
  c.tap_dir.clear();
  H h(c);
  const std::string cap = caps::mint(kCapKey, "input", "viewer-1", kNow + 10, "n");
  // The view token is still refused by name before any capability parsing; empty is `missing`;
  // a shared 64-hex credential is `malformed`.
  h.track(1, hello("input", kView));
  check(refused(h, 1, 1008, "track-unauthorized", "view-token"), "caps: view token by name: " + describe(h, 1));
  h.track(2, hello("input", ""));
  check(h.last_close(2) == std::make_pair(std::uint16_t(1008), std::string("track-unauthorized")) &&
            h.t.texts[2].back() == TrackHub::error_json("track-unauthorized", "missing"),
        "caps: empty credential is missing");
  h.track(3, hello("input", kCred));
  check(h.t.texts[3].back() == TrackHub::error_json("track-unauthorized", "malformed"), "caps: shared credential malformed");
  // Accepted: subject in opened(); the track lives on past exp.
  const std::uint32_t src = h.track(4, hello("input", cap));
  check(src != 0 && h.r.opens.back().subject == "viewer-1", "caps: opened with subject");
  clock = kNow + 3600;
  h.text(4, "late payload", 1 * kMs);
  check(h.r.messages[src].size() == 1 && h.t.closes[4].empty(), "caps: an open track outlives its exp");
  h.track(5, hello("input", cap), 2 * kMs);
  check(h.t.texts[5].back() == TrackHub::error_json("track-unauthorized", "expired"), "caps: the same capability later: expired");
  const TrackHub::KindStats *k = h.hub->kind_stats("input");
  check(k != nullptr && k->refused.count("track-unauthorized:view-token") == 1 &&
            k->refused.count("track-unauthorized:missing") == 1 && k->refused.count("track-unauthorized:malformed") == 1 &&
            k->refused.count("track-unauthorized:expired") == 1 && k->refused.count("track-unauthorized") == 0,
        "caps: refusals counted by detail");
  TrackHub::Extras extras;
  const std::string j = compact(h.hub->json(extras));
  check(j.find("\"caps\":\"hmac\"") != std::string::npos, "caps: json caps hmac: " + j);
  const std::string key_hex = caps::key_to_hex(kCapKey);
  const std::string mac = cap.substr(cap.rfind('.') + 1);
  check(j.find(key_hex) == std::string::npos && j.find(mac) == std::string::npos, "caps: json holds no key or capability");
  bool subject_logged = false;
  for (const std::string &l : h.logs) {
    check(l.find(key_hex) == std::string::npos && l.find(mac) == std::string::npos && l.find("cap1.") == std::string::npos,
          "caps: logs hold no key or capability: " + l);
    subject_logged = subject_logged || l.find("subject=viewer-1") != std::string::npos;
  }
  check(subject_logged, "caps: the open line names the subject");
  // Shared mode: subject "", json caps shared, refusals keep TRK1's keys.
  H shared;
  shared.track(1, hello());
  check(shared.r.opens.size() == 1 && shared.r.opens[0].subject.empty(), "shared: subject empty");
  check(compact(shared.hub->json(extras)).find("\"caps\":\"shared\"") != std::string::npos, "shared: json caps shared");
  // A capability presented to a shared-credential host is just wrong.
  shared.track(2, hello("input", cap));
  check(shared.t.texts[2].back() == TrackHub::error_json("track-unauthorized", "wrong"), "shared: a capability is wrong");
}

int main() {
  test_claims();
  test_hello_grammar();
  test_check_order();
  test_ready_and_sources();
  test_payloads();
  test_rate_refill();
  test_keepalive_and_idle();
  test_hello_timeout();
  test_peer_close();
  test_receiver_close_and_send();
  test_bind_unbind();
  test_close_all();
  test_reentrant_receiver();
  test_pairing_everywhere();
  test_json();
  test_parse_kinds();
  test_utf8();
  test_format_ok();
  test_cap_primitives();
  test_cap_vectors();
  test_cap_hub();
  test_sabotages();
  std::printf("rs_track_test: %d checks, %d failures\n", g_checks, g_failures);
  return g_failures == 0 ? 0 : 1;
}
