// Credit window tests for the live hub (src/rs_live.cpp; gate7-design.md D4, Q2 "Credit with
// window w", fork F1, G7q).
//
// 1. Window-1 identity. Seeded scenarios drive the hub at credit window 1 through a modelled
//    receiver (acks at every stage with random delays and stalls, stale and foreign acks,
//    resyncs, inline and out-of-band payloads, rate control, two connections, /6 and /7, and the
//    drop-message, ignore-credit and stale-coalesce sabotages), and write a transcript of every
//    observable output: each message the transport was handed (record metas and body digests),
//    each close, the pins after every frame, the live logs and taps, and the live summary. Stream
//    ids are random and the end record carries wall-clock encode costs, so both are normalized;
//    nothing else is. The transcripts' sha256 are pinned in test/golden/live-window1-transcripts
//    .txt, recorded from the hub before G7q: window 1 is byte for byte what it was.
//    GRC_WRITE_TRANSCRIPTS=1 prints the current digests instead of comparing (to record them).
// 2. Window 2 (G7q): the grant, two in flight, the window's credit per seq, a resync of the
//    earlier seq discarding the later one, pins over every in-flight transaction, the receiver
//    applying both in one frame, and the window-overrun sabotage.
// Driven through a fake transport: no socket, no engine.

#include <algorithm>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <map>
#include <regex>
#include <set>
#include <sstream>
#include <string>
#include <vector>

#include "report.h"
#include "rs2_codec.h"
#include "rs2_diff.h"
#include "rs2_golden_states.h"
#include "rs2_snapshot.h"
#include "rs_live.h"
#include "rs_publish.h"
#include "rs_sha256.h"

namespace {

using namespace grc::rs2;  // NOLINT
using grc::rs::Captured;

int g_failures = 0;
int g_checks = 0;

void check(bool condition, const std::string &what) {
  ++g_checks;
  if (!condition) {
    std::fprintf(stderr, "FAIL %s\n", what.c_str());
    ++g_failures;
  }
}

// ----------------------------------------------------------------- fake transport

struct Sent {
  enum Kind { Binary, Text, Close } kind;
  std::uint32_t conn = 0;
  std::vector<std::uint8_t> bytes;
  std::string text;
  std::uint16_t code = 0;
};

class FakeTransport : public LiveTransport {
 public:
  bool send_binary(std::uint32_t conn, std::vector<std::uint8_t> message) override {
    sent.push_back(Sent{Sent::Binary, conn, std::move(message), "", 0});
    return true;
  }
  bool send_text(std::uint32_t conn, std::string message) override {
    sent.push_back(Sent{Sent::Text, conn, {}, std::move(message), 0});
    return true;
  }
  void close(std::uint32_t conn, std::uint16_t code, std::string reason) override {
    sent.push_back(Sent{Sent::Close, conn, {}, std::move(reason), code});
  }
  std::uint64_t queued_bytes(std::uint32_t) const override { return queued; }
  std::uint64_t max_queued_bytes(std::uint32_t) const override { return queued; }
  std::vector<Sent> sent;
  std::uint64_t queued = 0;
};

// ----------------------------------------------------------------- record helpers

std::uint32_t u32le(const std::vector<std::uint8_t> &b, std::size_t at) {
  return static_cast<std::uint32_t>(b[at]) | (static_cast<std::uint32_t>(b[at + 1]) << 8) |
         (static_cast<std::uint32_t>(b[at + 2]) << 16) |
         (static_cast<std::uint32_t>(b[at + 3]) << 24);
}

struct Record {
  std::string meta;
  std::string body_sha;
};

// Records from `at` to the end of `b` (each: u32 length, u32 meta length, meta, body).
std::vector<Record> records_from(const std::vector<std::uint8_t> &b, std::size_t at) {
  std::vector<Record> out;
  while (at + 8 <= b.size()) {
    const std::uint32_t len = u32le(b, at);
    const std::uint32_t meta_len = u32le(b, at + 4);
    if (at + 4 + len > b.size() || 4 + meta_len > len) {
      out.push_back(Record{"<truncated>", ""});
      break;
    }
    Record r;
    r.meta.assign(b.begin() + static_cast<std::ptrdiff_t>(at + 8),
                  b.begin() + static_cast<std::ptrdiff_t>(at + 8 + meta_len));
    r.body_sha = grc::sha256_hex(b.data() + at + 8 + meta_len, len - 4 - meta_len);
    out.push_back(r);
    at += 4 + len;
  }
  return out;
}

bool starts_with_magic(const std::vector<std::uint8_t> &b) {
  return b.size() >= 8 && b[0] == 'G' && b[1] == 'R' && b[2] == 'S';
}

std::vector<Record> message_records(const std::vector<std::uint8_t> &b) {
  return records_from(b, starts_with_magic(b) ? 8 : 0);
}

std::uint64_t meta_seq(const std::string &meta) {
  static const std::regex kSeq(R"("seq":(\d+))");
  std::smatch m;
  return std::regex_search(meta, m, kSeq) ? std::stoull(m[1].str()) : 0;
}

bool has(const std::string &text, const std::string &needle) {
  return text.find(needle) != std::string::npos;
}

std::string read_file(const std::string &path) {
  std::ifstream in(path, std::ios::binary);
  std::stringstream ss;
  ss << in.rdbuf();
  return ss.str();
}

LiveEvent opened(std::uint32_t conn, const std::string &subprotocol, std::uint64_t t_ns) {
  LiveEvent e;
  e.kind = LiveEvent::Opened;
  e.conn = conn;
  e.t_ns = t_ns;
  e.subprotocol = subprotocol;
  return e;
}
LiveEvent text(std::uint32_t conn, const std::string &message, std::uint64_t t_ns) {
  LiveEvent e;
  e.kind = LiveEvent::Text;
  e.conn = conn;
  e.text = message;
  e.t_ns = t_ns;
  return e;
}
LiveEvent closed(std::uint32_t conn, std::uint16_t code, std::uint64_t t_ns) {
  LiveEvent e;
  e.kind = LiveEvent::Closed;
  e.conn = conn;
  e.code = code;
  e.reason = "bye";
  e.t_ns = t_ns;
  return e;
}

std::string ack(const std::string &stream_id, std::uint64_t seq, const char *stage,
                std::uint64_t t_us) {
  return std::string(R"({"type":"ack","stream_id":")") + stream_id + R"(","seq":)" +
         std::to_string(seq) + R"(,"stage":")" + stage + R"(","t_us":)" + std::to_string(t_us) +
         "}";
}
std::string resync(const std::string &stream_id, std::uint64_t seq) {
  return std::string(R"({"type":"resync","stream_id":")") + stream_id + R"(","seq":)" +
         std::to_string(seq) + R"(,"reason":"test"})";
}

std::string hello(int version, const char *stage, int window) {
  if (version == 7) {
    return std::string(
               R"({"type":"hello","protocol":"render-stream/7","receiver":"model","receiver_kind":"gsw-canvas","credit_stage":")") +
           stage + R"(","credit_window":)" + std::to_string(window) +
           R"(,"inbound_buffer_bytes":16777216,"token":null,"manifest_sha256":null,"presentation_backing_w":640,"presentation_backing_h":360,"presentation_css_w":640,"presentation_css_h":360,"dpr_milli":1000})";
  }
  return std::string(R"({"type":"hello","protocol":"render-stream/)") + std::to_string(version) +
         R"(","receiver":"model","credit_stage":")" + stage +
         R"(","inbound_buffer_bytes":16777216})";
}

Session make_template(ProtocolVersion version, Delivery delivery) {
  Session tmpl = golden::golden_session(Encoding::Full, std::string(), golden::kFullSessionId,
                                        delivery);
  tmpl.stream = StreamInfo();
  tmpl.version = version;
  return tmpl;
}

// Golden state `n` (1..8) at `version`, with payload bytes for its ok image textures when
// `payloads` (any bytes: the hub packages them, it never decodes them).
Captured state_at(int n, ProtocolVersion version, bool payloads) {
  Captured c;
  c.state = golden::state(n);
  c.state.version = version;
  if (payloads) {
    for (const TextureEntry &t : c.state.textures) {
      if (t.kind == TextureKind::Image && t.status == TextureStatus::Ok && t.has_hash) {
        c.payloads[t.hash] = std::make_shared<grc::rs::PayloadBytes>(
            std::vector<std::uint8_t>(t.payload_bytes, static_cast<std::uint8_t>(t.id)));
      }
    }
  }
  return c;
}

// A tiny deterministic generator (the transcripts must not depend on the standard library's).
struct Lcg {
  std::uint64_t s;
  explicit Lcg(std::uint64_t seed) : s(seed * 6364136223846793005ULL + 1442695040888963407ULL) {}
  std::uint32_t next() {
    s = s * 6364136223846793005ULL + 1442695040888963407ULL;
    return static_cast<std::uint32_t>(s >> 33);
  }
  // 0 .. n-1
  std::uint32_t below(std::uint32_t n) { return n == 0 ? 0 : next() % n; }
  bool one_in(std::uint32_t n) { return below(n) == 0; }
};

constexpr std::uint64_t kHostPeriodNs = 16666667ULL;

// ----------------------------------------------------------------- the modelled receiver

struct ConnSpec {
  int version = 2;          // the hello's protocol version (7: a render-stream.7 connection)
  const char *stage = "submitted";
  int window = 1;           // /7 only: the hello's credit_window
  std::uint64_t open_frame = 1;
  std::uint64_t hello_frame = 2;  // 0: never sends a hello
  std::uint64_t close_frame = 0;  // the receiver closes at this frame (0: at the end)
};

struct Scenario {
  std::string name;
  std::uint64_t seed = 1;
  LiveConfig config;
  ProtocolVersion template_version = ProtocolVersion::V2;
  Delivery delivery = Delivery::OutOfBand;
  bool payloads = false;
  int frames = 240;
  std::vector<ConnSpec> conns;
  // Receiver timing: each received transaction is applied after 0..max_delay frames (a stall
  // window adds `stall_frames`), then submitted one frame later.
  std::uint32_t max_delay = 2;
  std::uint64_t stall_from = 0;
  std::uint64_t stall_frames = 0;
  // Per-received-transaction odds (1 in N; 0: never).
  std::uint32_t resync_odds = 0;
  std::uint32_t stale_odds = 0;
  std::uint32_t foreign_odds = 0;
  // The receiver applies every queued transaction at its apply frame and acks each (window 2).
  std::uint64_t queued_bytes_mod = 0;
};

struct ModelConn {
  ConnSpec spec;
  std::uint32_t id = 0;
  std::string sid;
  std::size_t seen = 0;  // transport messages examined
  bool awaiting_full = false;
  bool closed = false;
  // frame -> control texts due at that frame
  std::multimap<std::uint64_t, std::string> due;
  std::uint64_t last_received = 0;
  std::uint64_t next_apply_frame = 0;  // applies stay in order
};

std::string scrub(std::string text, const std::vector<std::string> &sids) {
  for (std::size_t i = 0; i < sids.size(); ++i) {
    if (sids[i].empty()) {
      continue;
    }
    const std::string with = "SID" + std::to_string(i + 1);
    std::size_t at = 0;
    while ((at = text.find(sids[i], at)) != std::string::npos) {
      text.replace(at, sids[i].size(), with);
      at += with.size();
    }
  }
  // The end record's wall-clock encode costs, and every length they change (the end record's,
  // the connection's bytes_sent, the tap's size): their digit counts vary from run to run.
  static const std::regex kNs(R"("(encode|snapshot|diff)_ns_total":\d+)");
  static const std::regex kSentBytes(R"("bytes_sent": \d+)");
  static const std::regex kEndBytes(R"(("event":"end".*"bytes":)\d+)");
  text = std::regex_replace(text, kNs, "\"$1_ns_total\":0");
  text = std::regex_replace(text, kSentBytes, "\"bytes_sent\": X");
  return std::regex_replace(text, kEndBytes, "$1X");
}

std::string pins_line(const std::vector<const grc::rs::PayloadMap *> &maps) {
  std::set<std::string> hashes;
  for (const grc::rs::PayloadMap *m : maps) {
    for (const auto &entry : *m) {
      hashes.insert(entry.first.substr(0, 12));
    }
  }
  std::string out;
  for (const std::string &h : hashes) {
    out += (out.empty() ? "" : ",") + h;
  }
  return out;
}

struct Outcome {
  std::string transcript;
  std::vector<ConnectionSummary> summaries;
  FakeTransport transport;
};

// Runs one scenario; returns its transcript (and keeps the hub's summaries for extra checks).
void run_scenario(const Scenario &sc, Outcome *out) {
  LiveConfig config = sc.config;
  config.tap_dir = std::string(GRC_TEST_TMP_DIR) + "/window/" + sc.name;
  std::remove((config.tap_dir + "/live-1.jsonl").c_str());
  std::remove((config.tap_dir + "/live-2.jsonl").c_str());
  std::remove((config.tap_dir + "/stream-1.rs2").c_str());
  std::remove((config.tap_dir + "/stream-2.rs2").c_str());
  FakeTransport &transport = out->transport;
  Hub hub(&transport, config, make_template(sc.template_version, sc.delivery));
  Lcg rng(sc.seed);
  std::vector<ModelConn> conns;
  for (std::size_t i = 0; i < sc.conns.size(); ++i) {
    ModelConn m;
    m.spec = sc.conns[i];
    m.id = static_cast<std::uint32_t>(10 + i);
    conns.push_back(m);
  }
  std::vector<std::string> sids(conns.size());
  std::ostringstream tr;
  std::size_t sent_seen = 0;
  const auto drain_sent = [&]() {
    for (; sent_seen < transport.sent.size(); ++sent_seen) {
      const Sent &s = transport.sent[sent_seen];
      if (s.kind == Sent::Binary) {
        const std::vector<Record> records = message_records(s.bytes);
        const bool end = records.size() == 1 && has(records[0].meta, "\"type\":\"end\"");
        tr << "B " << s.conn << " " << (end ? std::string("X") : std::to_string(s.bytes.size()));
        for (const Record &r : records) {
          tr << " | " << scrub(r.meta, sids) << " " << r.body_sha.substr(0, 16);
        }
        tr << "\n";
      } else if (s.kind == Sent::Text) {
        tr << "T " << s.conn << " " << scrub(s.text, sids) << "\n";
      } else {
        tr << "C " << s.conn << " " << s.code << " " << s.text << "\n";
      }
    }
  };
  int state_n = 1;
  std::uint64_t epoch = 1;
  for (std::uint64_t frame = 1; frame <= static_cast<std::uint64_t>(sc.frames); ++frame) {
    const std::uint64_t now = frame * kHostPeriodNs;
    if (sc.queued_bytes_mod != 0) {
      transport.queued = rng.below(static_cast<std::uint32_t>(sc.queued_bytes_mod));
    }
    for (ModelConn &m : conns) {
      if (m.closed) {
        continue;
      }
      if (frame == m.spec.open_frame) {
        hub.on_event(opened(m.id, m.spec.version == 7 ? kSubprotocolV7 : "", now - 1000), frame);
        for (const ConnectionSummary &s : hub.summaries()) {
          if (s.connection == static_cast<std::uint32_t>(&m - conns.data() + 1)) {
            m.sid = s.stream_id;
          }
        }
        sids[static_cast<std::size_t>(&m - conns.data())] = m.sid;
      }
      if (m.spec.hello_frame != 0 && frame == m.spec.hello_frame) {
        hub.on_event(text(m.id, hello(m.spec.version, m.spec.stage, m.spec.window), now - 900),
                     frame);
      }
      const auto range = m.due.equal_range(frame);
      std::uint64_t t = now - 800;
      for (auto it = range.first; it != range.second; ++it) {
        hub.on_event(text(m.id, it->second, t), frame);
        t += 10;
      }
      m.due.erase(frame);
      if (m.spec.close_frame != 0 && frame == m.spec.close_frame) {
        hub.on_event(closed(m.id, 1000, now - 500), frame);
        m.closed = true;
      }
    }
    // The mirror moves on most frames.
    if (!rng.one_in(4)) {
      state_n = 1 + static_cast<int>(rng.below(8));
      ++epoch;
    }
    const Captured snapshot = state_at(state_n, sc.template_version, sc.payloads);
    const bool wants = hub.wants_snapshot(frame, now);
    hub.on_frame(frame, now, wants ? &snapshot : nullptr, epoch, 1000);
    tr << "F " << frame << " wants " << (wants ? 1 : 0) << " base " << pins_line(hub.base_payloads())
       << " held " << pins_line(hub.held_payloads()) << "\n";
    drain_sent();
    // The receivers read what was sent to them this frame.
    for (ModelConn &m : conns) {
      for (; m.seen < transport.sent.size(); ++m.seen) {
        const Sent &s = transport.sent[m.seen];
        if (s.conn != m.id || s.kind != Sent::Binary || m.closed) {
          continue;
        }
        for (const Record &r : message_records(s.bytes)) {
          if (!has(r.meta, "\"type\":\"transaction\"")) {
            continue;
          }
          const std::uint64_t seq = meta_seq(r.meta);
          const bool full = has(r.meta, "\"encoding\":\"full\"");
          const std::uint64_t t_us = now / 1000;
          m.due.emplace(frame + 1, ack(m.sid, seq, "received", t_us));
          if (m.awaiting_full && !full) {
            continue;  // ignored until a full transaction (render-stream-1.md)
          }
          m.awaiting_full = false;
          if (sc.resync_odds != 0 && rng.one_in(sc.resync_odds)) {
            m.due.emplace(frame + 1, resync(m.sid, seq));
            m.awaiting_full = true;
            continue;
          }
          std::uint64_t delay = rng.below(sc.max_delay + 1);
          if (sc.stall_frames != 0 && frame >= sc.stall_from &&
              frame < sc.stall_from + sc.stall_frames) {
            delay += sc.stall_frames;
          }
          std::uint64_t apply = std::max(frame + 1 + delay, m.next_apply_frame);
          m.next_apply_frame = apply;
          m.due.emplace(apply, ack(m.sid, seq, "applied", t_us + 1));
          m.due.emplace(apply + 1, ack(m.sid, seq, "submitted", t_us + 2));
          if (sc.stale_odds != 0 && seq > 1 && rng.one_in(sc.stale_odds)) {
            m.due.emplace(apply + 2, ack(m.sid, seq - 1, m.spec.stage, t_us + 3));
          }
          if (sc.foreign_odds != 0 && rng.one_in(sc.foreign_odds)) {
            m.due.emplace(apply + 1,
                          ack(std::string(32, 'f'), seq, m.spec.stage, t_us + 4));
          }
          m.last_received = seq;
        }
      }
    }
  }
  const std::uint64_t end_frame = static_cast<std::uint64_t>(sc.frames) + 1;
  hub.finish(EndReason::Shutdown, end_frame, end_frame * kHostPeriodNs);
  drain_sent();
  for (ModelConn &m : conns) {
    if (!m.closed) {
      hub.on_event(closed(m.id, 1000, end_frame * kHostPeriodNs + 1000), end_frame);
    }
  }
  hub.close_open(end_frame);
  drain_sent();
  tr << "S " << scrub(hub.summary_json(), sids) << "\n";
  out->summaries = hub.summaries();
  for (std::size_t i = 1; i <= conns.size(); ++i) {
    const std::string n = std::to_string(i);
    tr << "L " << n << "\n" << scrub(read_file(config.tap_dir + "/live-" + n + ".jsonl"), sids);
    const std::string tap = read_file(config.tap_dir + "/stream-" + n + ".rs2");
    const std::vector<std::uint8_t> tap_bytes(tap.begin(), tap.end());
    tr << "R " << n << "\n";
    for (const Record &r : message_records(tap_bytes)) {
      tr << scrub(r.meta, sids) << " " << r.body_sha.substr(0, 16) << "\n";
    }
  }
  out->transcript = tr.str();
}

// The window-1 scenarios. Each is pinned by its transcript's sha256 (test/golden/
// live-window1-transcripts.txt); none may ever change.
std::vector<Scenario> window1_scenarios() {
  std::vector<Scenario> out;
  {
    Scenario s;
    s.name = "submitted-uncapped";
    s.seed = 11;
    s.conns = {ConnSpec{}};
    s.stale_odds = 9;
    s.foreign_odds = 13;
    s.queued_bytes_mod = 4096;
    out.push_back(s);
  }
  {
    Scenario s;
    s.name = "applied-rate30-stall";
    s.seed = 12;
    s.config.publish_period_ns = 1000000000ULL / 30;
    s.config.publish_target_fps = 30;
    ConnSpec c;
    c.stage = "applied";
    s.conns = {c};
    s.max_delay = 3;
    s.stall_from = 80;
    s.stall_frames = 40;
    out.push_back(s);
  }
  {
    Scenario s;
    s.name = "rate60-resync";
    s.seed = 13;
    s.config.publish_period_ns = 1000000000ULL / 60;
    s.config.publish_target_fps = 60;
    s.conns = {ConnSpec{}};
    s.resync_odds = 17;
    s.stale_odds = 7;
    out.push_back(s);
  }
  {
    Scenario s;
    s.name = "inline-payloads";
    s.seed = 14;
    s.delivery = Delivery::Inline;
    s.payloads = true;
    s.conns = {ConnSpec{}};
    s.resync_odds = 31;
    out.push_back(s);
  }
  {
    Scenario s;
    s.name = "http-pins-two-connections";
    s.seed = 15;
    s.payloads = true;
    ConnSpec a;
    ConnSpec b;
    b.stage = "applied";
    b.open_frame = 20;
    b.hello_frame = 23;
    b.close_frame = 170;
    s.conns = {a, b};
    s.max_delay = 4;
    out.push_back(s);
  }
  {
    Scenario s;
    s.name = "drop-message";
    s.seed = 16;
    s.config.drop_message_frame = 60;
    s.conns = {ConnSpec{}};
    out.push_back(s);
  }
  {
    Scenario s;
    s.name = "ignore-credit";
    s.seed = 17;
    s.config.ignore_credit_frame = 70;
    s.conns = {ConnSpec{}};
    s.max_delay = 5;
    s.queued_bytes_mod = 70000;
    out.push_back(s);
  }
  {
    Scenario s;
    s.name = "stale-coalesce";
    s.seed = 18;
    s.config.stale_coalesce_frame = 50;
    s.payloads = true;
    s.conns = {ConnSpec{}};
    s.stall_from = 100;
    s.stall_frames = 30;
    out.push_back(s);
  }
  {
    // /6 and /7 on one hub, each at window 1: the /7 one asks for 2 under the default
    // GRC_LIVE_CREDIT_WINDOW_MAX=1 (granted 1), and a second /7 asks for 1.
    Scenario s;
    s.name = "v6-v7-window1";
    s.seed = 19;
    s.template_version = ProtocolVersion::V6;
    s.config.publish_period_ns = 1000000000ULL / 60;
    s.config.publish_target_fps = 60;
    ConnSpec six;
    six.version = 6;
    ConnSpec seven;
    seven.version = 7;
    seven.window = 2;
    seven.open_frame = 5;
    seven.hello_frame = 6;
    s.conns = {six, seven};
    s.stale_odds = 11;
    s.resync_odds = 41;
    out.push_back(s);
  }
  {
    Scenario s;
    s.name = "v7-max2-asks1";
    s.seed = 20;
    s.template_version = ProtocolVersion::V6;
    s.config.credit_window_max = 2;
    s.payloads = true;
    ConnSpec seven;
    seven.version = 7;
    seven.window = 1;
    s.conns = {seven};
    s.max_delay = 3;
    s.resync_odds = 23;
    out.push_back(s);
  }
  return out;
}

void test_window1_transcripts() {
  const bool write = std::getenv("GRC_WRITE_TRANSCRIPTS") != nullptr;
  std::map<std::string, std::string> pinned;
  {
    std::istringstream in(read_file(GRC_WINDOW1_TRANSCRIPTS));
    std::string line;
    while (std::getline(in, line)) {
      if (line.empty() || line[0] == '#') {
        continue;
      }
      std::istringstream fields(line);
      std::string name;
      std::string sha;
      fields >> name >> sha;
      pinned[name] = sha;
    }
  }
  for (const Scenario &sc : window1_scenarios()) {
    Outcome o;
    run_scenario(sc, &o);
    const std::string sha = grc::sha256_hex(o.transcript.data(), o.transcript.size());
    std::size_t lines = static_cast<std::size_t>(
        std::count(o.transcript.begin(), o.transcript.end(), '\n'));
    const std::string path = std::string(GRC_TEST_TMP_DIR) + "/window/" + sc.name + ".txt";
    std::ofstream(path, std::ios::binary) << o.transcript;
    if (write) {
      std::printf("%s %s %zu\n", sc.name.c_str(), sha.c_str(), lines);
      continue;
    }
    check(pinned.count(sc.name) != 0 && pinned[sc.name] == sha,
          "window-1 transcript " + sc.name + " is unchanged (sha256 " + sha + ", " +
              std::to_string(lines) + " lines; pinned " +
              (pinned.count(sc.name) != 0 ? pinned[sc.name] : std::string("none")) +
              "; transcript at " + path + ")");
    for (const ConnectionSummary &s : o.summaries) {
      check(s.credit_window == 1 && s.max_in_flight <= 1 + (sc.name == "ignore-credit" ? 1000 : 0),
            sc.name + ": connection " + std::to_string(s.connection) + " ran at window 1");
    }
  }
}


// ----------------------------------------------------------------- window 2 (G7q)

// A /7 hub with GRC_LIVE_CREDIT_WINDOW_MAX=2 and one connection asking for `window`.
struct W2Rig {
  FakeTransport transport;
  Hub hub;
  std::uint64_t frame = 0;
  std::uint64_t epoch = 1;
  bool payloads = false;
  std::string sid;
  explicit W2Rig(int window, LiveConfig config = LiveConfig(), const char *stage = "submitted")
      : hub(&transport, with_max2(std::move(config)),
            make_template(ProtocolVersion::V6, Delivery::OutOfBand)) {
    hub.on_event(opened(1, kSubprotocolV7, 0), 0);
    hub.on_event(text(1, hello(7, stage, window), 0), 0);
    sid = hub.summaries().at(0).stream_id;
  }
  static LiveConfig with_max2(LiveConfig config) {
    config.credit_window_max = 2;
    return config;
  }
  // One frame callback; the mirror moves to golden state `n` (a new epoch when it changes).
  void step(int n) {
    ++frame;
    ++epoch;
    const Captured snapshot = state_at(n, ProtocolVersion::V6, payloads);
    const std::uint64_t now = frame * kHostPeriodNs;
    hub.on_frame(frame, now, hub.wants_snapshot(frame, now) ? &snapshot : nullptr, epoch, 1000);
  }
  void send_ack(std::uint64_t seq, const char *stage = "submitted") {
    hub.on_event(text(1, ack(sid, seq, stage, frame), frame * kHostPeriodNs + 5), frame);
  }
  void send_resync(std::uint64_t seq) {
    hub.on_event(text(1, resync(sid, seq), frame * kHostPeriodNs + 5), frame);
  }
  // The transaction metas sent so far, in order.
  std::vector<std::string> transactions() const {
    std::vector<std::string> out;
    for (const Sent &s : transport.sent) {
      if (s.kind != Sent::Binary) {
        continue;
      }
      for (const Record &r : message_records(s.bytes)) {
        if (has(r.meta, "\"type\":\"transaction\"")) {
          out.push_back(r.meta);
        }
      }
    }
    return out;
  }
  ConnectionSummary summary() const { return hub.summaries().at(0); }
  std::vector<std::string> log() const {
    std::vector<std::string> out;
    std::istringstream in(read_file(std::string(GRC_TEST_TMP_DIR) + "/w2/live-1.jsonl"));
    std::string line;
    while (std::getline(in, line)) {
      out.push_back(line);
    }
    return out;
  }
};

LiveConfig tapped() {
  LiveConfig config;
  config.tap_dir = std::string(GRC_TEST_TMP_DIR) + "/w2";
  return config;
}

void test_window2_grant_and_two_in_flight() {
  W2Rig rig(2, tapped());
  rig.step(1);  // session + seq 1 (the hello's credit)
  {
    const std::vector<Sent> &sent = rig.transport.sent;
    check(!sent.empty() && has(message_records(sent[0].bytes)[0].meta,
                               "\"publication\":{\"mode\":\"every-frame\",\"target_fps\":null,"
                               "\"credit_window\":2}"),
          "w2: the session declares publication.credit_window 2 (asked 2, max 2)");
  }
  check(rig.summary().credit_window == 2, "w2: the summary records the grant 2");
  rig.step(2);  // seq 2 with seq 1 still in flight
  rig.step(3);  // window full: nothing
  std::vector<std::string> t = rig.transactions();
  check(t.size() == 2, "w2: two transactions in flight, a third waits (sent " +
                           std::to_string(t.size()) + ")");
  if (t.size() == 2) {
    check(has(t[0], "\"seq\":1,") && has(t[0], "\"encoding\":\"full\""), "w2: seq 1 is full");
    check(has(t[1], "\"seq\":2,") && has(t[1], "\"encoding\":\"patch\"") &&
              has(t[1], "\"base_seq\":1,"),
          "w2: seq 2 is a patch against seq 1, the last one sent: " + t[1].substr(0, 90));
  }
  check(rig.summary().coalesced == 1, "w2: the full window coalesced one callback");
  rig.send_ack(1, "applied");  // not the credit stage: timing only
  rig.step(4);
  check(rig.transactions().size() == 2, "w2: an ack at another stage frees no slot");
  rig.send_ack(1);
  rig.step(5);
  t = rig.transactions();
  check(t.size() == 3 && has(t[2], "\"seq\":3,") && has(t[2], "\"base_seq\":2,") &&
            has(t[2], "\"frame\":5,"),
        "w2: seq 1's credit lets seq 3 out, a patch against seq 2 with the newest state");
  rig.step(6);
  check(rig.transactions().size() == 3, "w2: seqs 2 and 3 fill the window again");
  // Out of order: seq 3's ack frees its own slot (acks are per seq).
  rig.send_ack(3);
  rig.step(7);
  check(rig.transactions().size() == 4, "w2: seq 3's ack frees a slot while seq 2 is out");
  rig.send_ack(2);
  rig.send_ack(4);
  rig.step(8);
  rig.step(9);
  const ConnectionSummary s = rig.summary();
  check(s.max_in_flight == 2 && s.sent_without_credit == 0,
        "w2: max_in_flight 2, nothing without credit (" + std::to_string(s.max_in_flight) + ")");
  // The live log: in_flight is the newest slot, in_flight_seqs every slot.
  rig.hub.finish(EndReason::Shutdown, rig.frame, rig.frame * kHostPeriodNs);
  rig.hub.on_event(closed(1, 1000, 0), rig.frame);
  bool saw_two = false;
  bool hello_grant = false;
  for (const std::string &line : rig.log()) {
    if (has(line, "\"in_flight\":2,") && has(line, "\"in_flight_seqs\":[1,2]")) {
      saw_two = true;
    }
    if (has(line, "\"event\":\"hello\"") && has(line, "\"credit_window_granted\":2")) {
      hello_grant = true;
    }
  }
  check(saw_two, "w2: a frame line lists both slots, in_flight_seqs [1,2]");
  check(hello_grant, "w2: the hello line records credit_window_granted 2");
}

void test_window2_resync_earlier_seq() {
  W2Rig rig(2, tapped());
  rig.step(1);
  rig.send_ack(1);
  rig.step(2);  // seq 2
  rig.step(3);  // seq 3: seqs 2 and 3 in flight
  check(rig.transactions().size() == 3, "w2 resync: seqs 2 and 3 in flight");
  rig.send_resync(2);  // the earlier seq
  rig.step(4);
  std::vector<std::string> t = rig.transactions();
  check(t.size() == 4 && has(t[3], "\"seq\":4,") && has(t[3], "\"encoding\":\"full\""),
        "w2 resync: a resync of the earlier seq makes the next send full");
  rig.step(5);
  t = rig.transactions();
  check(t.size() == 5 && has(t[4], "\"base_seq\":4,"),
        "w2 resync: seq 3's slot came back with the resync (seq 5 goes out beside seq 4)");
  rig.send_ack(3);  // the discarded seq's late ack
  rig.step(6);
  check(rig.transactions().size() == 5, "w2 resync: the discarded seq's late ack frees nothing");
  const ConnectionSummary s = rig.summary();
  check(s.resyncs == 1 && s.acks_ignored == 1 && s.max_in_flight == 2,
        "w2 resync: one resync, the late ack ignored, max_in_flight 2 (resyncs " +
            std::to_string(s.resyncs) + ", ignored " + std::to_string(s.acks_ignored) + ")");
  rig.hub.finish(EndReason::Shutdown, rig.frame, rig.frame * kHostPeriodNs);
  rig.hub.on_event(closed(1, 1000, 0), rig.frame);
  bool discarded = false;
  bool stale = false;
  for (const std::string &line : rig.log()) {
    discarded = discarded || (has(line, "\"event\":\"resync\"") && has(line, "\"seq\":2,") &&
                              has(line, "\"credited\":true") && has(line, "\"discarded\":[3]"));
    stale = stale || (has(line, "\"event\":\"ack\"") && has(line, "\"seq\":3,") &&
                      has(line, "\"ignored\":\"stale\""));
  }
  check(discarded, "w2 resync: the resync line credits seq 2 and lists discarded [3]");
  check(stale, "w2 resync: seq 3's late ack is logged stale");
}

void test_window2_pins_every_in_flight() {
  W2Rig rig(2);
  rig.payloads = true;
  // States with different ok image payloads: the pins are the union over the two in flight.
  const auto hashes = [](int n) {
    std::set<std::string> out;
    for (const auto &entry : state_at(n, ProtocolVersion::V6, true).payloads) {
      out.insert(entry.first);
    }
    return out;
  };
  int a = 0;
  int b = 0;
  for (int i = 1; i <= 8 && b == 0; ++i) {
    for (int j = 1; j <= 8; ++j) {
      const std::set<std::string> hi = hashes(i);
      const std::set<std::string> hj = hashes(j);
      if (!hi.empty() && !hj.empty() && hi != hj) {
        bool disjoint_part = false;
        for (const std::string &h : hi) {
          disjoint_part = disjoint_part || hj.count(h) == 0;
        }
        if (disjoint_part) {
          a = i;
          b = j;
          break;
        }
      }
    }
  }
  check(a != 0 && b != 0, "w2 pins: two golden states with different payloads");
  if (a == 0 || b == 0) {
    return;
  }
  const auto pinned = [&rig]() {
    std::set<std::string> out;
    for (const grc::rs::PayloadMap *m : rig.hub.base_payloads()) {
      for (const auto &entry : *m) {
        out.insert(entry.first);
      }
    }
    return out;
  };
  rig.step(a);  // seq 1: state a
  rig.step(b);  // seq 2: state b, seq 1 still in flight
  std::set<std::string> both = hashes(a);
  const std::set<std::string> hb = hashes(b);
  both.insert(hb.begin(), hb.end());
  check(pinned() == both, "w2 pins: both in-flight transactions' payloads are pinned");
  rig.send_ack(1);
  rig.step(b);  // the mirror did not change state, but a new epoch: seq 3 (state b)
  check(pinned() == hb, "w2 pins: seq 1's payloads unpin once its credit returned");
}

void test_window_overrun_sabotage() {
  {
    LiveConfig config;
    config.window_overrun_frame = 3;
    W2Rig rig(2, config);
    for (int i = 0; i < 10; ++i) {
      rig.step(1 + i % 4);
    }
    const ConnectionSummary s = rig.summary();
    check(rig.transactions().size() == 10 && s.max_in_flight == 10 &&
              s.sent_without_credit == 8,
          "window-overrun: from frame 3 every callback sends past the full window (sent " +
              std::to_string(rig.transactions().size()) + ", max_in_flight " +
              std::to_string(s.max_in_flight) + ", without credit " +
              std::to_string(s.sent_without_credit) + ")");
  }
  {
    // Still paced: at 30 fps on a 60 fps host, one send every other callback.
    LiveConfig config;
    config.window_overrun_frame = 1;
    config.publish_period_ns = 1000000000ULL / 30;
    config.publish_target_fps = 30;
    W2Rig rig(2, config);
    for (int i = 0; i < 20; ++i) {
      rig.step(1 + i % 4);
    }
    const std::size_t sent = rig.transactions().size();
    check(sent >= 9 && sent <= 11 && rig.summary().max_in_flight == sent,
          "window-overrun: paced at 30 fps (sent " + std::to_string(sent) + " in 20 callbacks)");
  }
  {
    // Without the sabotage the same callbacks hold the window.
    W2Rig rig(2);
    for (int i = 0; i < 10; ++i) {
      rig.step(1 + i % 4);
    }
    check(rig.transactions().size() == 2 && rig.summary().max_in_flight == 2,
          "window-overrun: the honest host keeps two in flight");
  }
}

// G7q stale-coalesce at window 2: a send made while the stale send still holds its slot repeats
// the stale target (so a receiver folding the two still draws it); after its credit, the newest.
void test_window2_stale_coalesce_held() {
  LiveConfig config = tapped();
  config.stale_coalesce_frame = 1;
  W2Rig rig(2, config);
  rig.step(1);  // seq 1 (the hello's credit)
  rig.step(2);  // seq 2, a free slot
  rig.step(3);  // window full: frame 3's snapshot is kept as the first missed target
  rig.step(4);
  rig.send_ack(1);
  rig.step(1);  // frame 5: seq 3 carries frame 3's snapshot
  rig.send_ack(2);
  rig.step(2);  // frame 6: seq 4, with seq 3 in flight, repeats it
  rig.send_ack(3);
  rig.step(3);  // frame 7: seq 3 credited, seq 5 is the newest state
  const auto sent_line = [&](int seq) {
    for (const std::string &l : rig.log()) {
      if (has(l, "\"sent\":{\"seq\":" + std::to_string(seq) + ",")) {
        return l;
      }
    }
    return std::string();
  };
  const std::string s3 = sent_line(3);
  const std::string s4 = sent_line(4);
  const std::string s5 = sent_line(5);
  check(has(s3, "\"stale_from\":3") && has(s3, "\"frame\":5,"),
        "w2 stale-coalesce: seq 3 at frame 5 carries frame 3's snapshot: " + s3.substr(0, 120));
  check(has(s4, "\"stale_from\":3") && has(s4, "\"frame\":6,"),
        "w2 stale-coalesce: seq 4, sent while seq 3 is in flight, repeats it: " +
            s4.substr(0, 120));
  check(!s5.empty() && !has(s5, "stale_from") && has(s5, "\"frame\":7,"),
        "w2 stale-coalesce: after seq 3's credit, seq 5 is the newest state: " +
            s5.substr(0, 120));
  check(rig.summary().stale_sent == 2, "w2 stale-coalesce: two stale sends (stale_sent " +
                                           std::to_string(rig.summary().stale_sent) + ")");
}

// Seeded window-2 runs of the modelled receiver: never more than two in flight, every patch
// against the previous one sent, and no protocol error.
void test_window2_model() {
  for (std::uint64_t seed = 31; seed < 37; ++seed) {
    Scenario s;
    s.name = "w2-model-" + std::to_string(seed);
    s.seed = seed;
    s.template_version = ProtocolVersion::V6;
    s.config.credit_window_max = 2;
    if (seed % 2 == 0) {
      s.config.publish_period_ns = 1000000000ULL / 60;
      s.config.publish_target_fps = 60;
    }
    s.payloads = seed % 3 == 0;
    ConnSpec c;
    c.version = 7;
    c.window = 2;
    c.stage = seed % 3 == 1 ? "applied" : "submitted";
    s.conns = {c};
    s.max_delay = 1 + static_cast<std::uint32_t>(seed % 4);
    s.resync_odds = 19;
    s.stale_odds = 13;
    s.stall_from = 120;
    s.stall_frames = 20;
    Outcome o;
    run_scenario(s, &o);
    const ConnectionSummary sum = o.summaries.at(0);
    check(sum.credit_window == 2 && sum.max_in_flight <= 2 && sum.max_in_flight == 2 &&
              sum.error_sent.empty() && sum.sent_without_credit == 0,
          s.name + ": window 2 held (max_in_flight " + std::to_string(sum.max_in_flight) +
              ", error " + sum.error_sent + ")");
    std::uint64_t previous = 0;
    bool chained = true;
    for (const Sent &m : o.transport.sent) {
      if (m.kind != Sent::Binary) {
        continue;
      }
      for (const Record &r : message_records(m.bytes)) {
        if (!has(r.meta, "\"type\":\"transaction\"")) {
          continue;
        }
        const std::uint64_t seq = meta_seq(r.meta);
        if (has(r.meta, "\"encoding\":\"patch\"")) {
          chained = chained && has(r.meta, "\"base_seq\":" + std::to_string(previous) + ",");
        }
        previous = seq;
      }
    }
    check(chained, s.name + ": every patch is against the previous transaction sent");
  }
}

}  // namespace

int main() {
  grc::make_directories(std::string(GRC_TEST_TMP_DIR) + "/window");
  grc::make_directories(std::string(GRC_TEST_TMP_DIR) + "/w2");
  test_window1_transcripts();
  test_window2_grant_and_two_in_flight();
  test_window2_resync_earlier_seq();
  test_window2_pins_every_in_flight();
  test_window_overrun_sabotage();
  test_window2_model();
  test_window2_stale_coalesce_held();
  std::printf("rs_live_window_test: %d checks, %d failures\n", g_checks, g_failures);
  return g_failures == 0 ? 0 : 1;
}
