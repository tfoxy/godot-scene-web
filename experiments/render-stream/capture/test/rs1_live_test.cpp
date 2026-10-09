// Unit tests for the render-stream/1 live hub (src/rs1_live.cpp), protocol/gate1-design.md
// "Q4. Delivery model" and "G1c2": credit (one in flight; credit only on the declared stage and
// the in-flight seq; stale and foreign acks ignored), resync, message-too-large, hello timeout,
// protocol errors, the drop-message sabotage, finish (end record without credit), receiver
// close, the live log, and the control-message parser against protocol/golden-1/control/
// (valid and invalid) plus extra malformed cases. Driven through a fake transport: no socket, no
// engine. The tap directory is under the build tree.

#include <dirent.h>

#include <algorithm>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <sstream>
#include <string>
#include <vector>

#include "report.h"
#include "rs1_codec.h"
#include "rs1_golden_states.h"
#include "rs1_live.h"
#include "rs1_snapshot.h"

namespace {

using namespace grc::rs1;  // NOLINT

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

  std::vector<Sent> of(Sent::Kind kind) const {
    std::vector<Sent> out;
    for (const Sent &s : sent) {
      if (s.kind == kind) {
        out.push_back(s);
      }
    }
    return out;
  }
  std::vector<Sent> sent;
  std::uint64_t queued = 0;
};

// ----------------------------------------------------------------- record helpers

std::uint32_t u32le(const std::vector<std::uint8_t> &b, std::size_t at) {
  return static_cast<std::uint32_t>(b[at]) | (static_cast<std::uint32_t>(b[at + 1]) << 8) |
         (static_cast<std::uint32_t>(b[at + 2]) << 16) |
         (static_cast<std::uint32_t>(b[at + 3]) << 24);
}

// The meta JSON of the record starting at `at` (length prefix included).
std::string meta_at(const std::vector<std::uint8_t> &b, std::size_t at) {
  const std::uint32_t meta_len = u32le(b, at + 4);
  return std::string(b.begin() + static_cast<std::ptrdiff_t>(at + 8),
                     b.begin() + static_cast<std::ptrdiff_t>(at + 8 + meta_len));
}

// Splits a concatenated stream (magic first) into its record metas.
std::vector<std::string> stream_metas(const std::vector<std::uint8_t> &b) {
  std::vector<std::string> out;
  std::size_t at = 8;
  while (at + 4 <= b.size()) {
    const std::uint32_t len = u32le(b, at);
    out.push_back(meta_at(b, at));
    at += 4 + len;
  }
  return out;
}

bool has(const std::string &meta, const std::string &needle) {
  return meta.find(needle) != std::string::npos;
}

const std::string kHelloSubmitted =
    R"({"type":"hello","protocol":"render-stream/1","receiver":"t","credit_stage":"submitted","inbound_buffer_bytes":16777216})";
const std::string kHelloApplied =
    R"({"type":"hello","protocol":"render-stream/1","receiver":"t","credit_stage":"applied","inbound_buffer_bytes":16777216})";

std::string ack(const std::string &stream_id, std::uint64_t seq, const char *stage) {
  return std::string(R"({"type":"ack","stream_id":")") + stream_id + R"(","seq":)" +
         std::to_string(seq) + R"(,"stage":")" + stage + R"(","t_us":1})";
}
std::string resync(const std::string &stream_id, std::uint64_t seq) {
  return std::string(R"({"type":"resync","stream_id":")") + stream_id + R"(","seq":)" +
         std::to_string(seq) + R"(,"reason":"test"})";
}

Session make_template() {
  Session tmpl = golden::golden_session(Encoding::Full, std::string(), golden::kFullSessionId);
  tmpl.stream = StreamInfo();
  return tmpl;
}

LiveEvent opened(std::uint32_t conn, std::uint64_t t_ns = 1000) {
  LiveEvent e;
  e.kind = LiveEvent::Opened;
  e.conn = conn;
  e.t_ns = t_ns;
  return e;
}
LiveEvent text(std::uint32_t conn, const std::string &message, std::uint64_t t_ns = 2000) {
  LiveEvent e;
  e.kind = LiveEvent::Text;
  e.conn = conn;
  e.text = message;
  e.t_ns = t_ns;
  return e;
}
LiveEvent closed(std::uint32_t conn, std::uint16_t code) {
  LiveEvent e;
  e.kind = LiveEvent::Closed;
  e.conn = conn;
  e.code = code;
  e.reason = "bye";
  return e;
}

std::string read_file(const std::string &path) {
  std::ifstream in(path, std::ios::binary);
  std::stringstream ss;
  ss << in.rdbuf();
  return ss.str();
}

std::vector<std::string> read_lines(const std::string &path) {
  std::vector<std::string> out;
  std::ifstream in(path);
  std::string line;
  while (std::getline(in, line)) {
    if (!line.empty()) {
      out.push_back(line);
    }
  }
  return out;
}

std::vector<std::uint8_t> concat_binary(const FakeTransport &t) {
  std::vector<std::uint8_t> out;
  for (const Sent &s : t.of(Sent::Binary)) {
    out.insert(out.end(), s.bytes.begin(), s.bytes.end());
  }
  return out;
}

// ----------------------------------------------------------------- control parser

std::vector<std::string> list_dir(const std::string &dir) {
  std::vector<std::string> out;
  DIR *d = opendir(dir.c_str());
  if (d == nullptr) {
    return out;
  }
  while (dirent *e = readdir(d)) {
    const std::string name = e->d_name;
    if (name.size() > 5 && name.substr(name.size() - 5) == ".json") {
      out.push_back(dir + "/" + name);
    }
  }
  closedir(d);
  std::sort(out.begin(), out.end());
  return out;
}

void test_control_parser() {
  const std::string root = std::string(GRC_GOLDEN1_DIR) + "/control";
  const std::vector<std::string> valid = list_dir(root + "/valid");
  const std::vector<std::string> invalid = list_dir(root + "/invalid");
  check(valid.size() == 7, "7 valid control goldens (got " + std::to_string(valid.size()) + ")");
  check(invalid.size() == 7,
        "7 invalid control goldens (got " + std::to_string(invalid.size()) + ")");
  for (const std::string &path : valid) {
    ControlMessage m;
    std::string error;
    check(parse_control(read_file(path), &m, &error), "valid golden parses: " + path + " " + error);
  }
  for (const std::string &path : invalid) {
    ControlMessage m;
    std::string error;
    check(!parse_control(read_file(path), &m, &error), "invalid golden refused: " + path);
    check(!error.empty(), "invalid golden has an error text: " + path);
  }
  {
    ControlMessage m;
    check(parse_control(read_file(root + "/valid/hello-submitted.json"), &m, nullptr) &&
              m.type == ControlType::Hello && m.credit_stage == AckStage::Submitted &&
              m.inbound_buffer_bytes == 16777216 && m.receiver == "gate1-selftest" &&
              m.protocol == "render-stream/1",
          "hello-submitted fields");
    check(parse_control(read_file(root + "/valid/ack-applied.json"), &m, nullptr) &&
              m.type == ControlType::Ack && m.stage == AckStage::Applied && m.seq == 1 &&
              m.t_us == 2500 && m.stream_id == "0123456789abcdef0123456789abcdef",
          "ack-applied fields");
    check(parse_control(read_file(root + "/valid/resync.json"), &m, nullptr) &&
              m.type == ControlType::Resync && m.seq == 6 && m.reason == "unapplied-stale",
          "resync fields");
    check(parse_control(read_file(root + "/valid/error-message-too-large.json"), &m, nullptr) &&
              m.type == ControlType::Error && m.reason == "message-too-large",
          "error fields");
  }
  // Key order is free.
  {
    ControlMessage m;
    check(parse_control(
              R"({"t_us":5,"stage":"submitted","seq":3,"stream_id":"0123456789abcdef0123456789abcdef","type":"ack"})",
              &m, nullptr) &&
              m.seq == 3 && m.stage == AckStage::Submitted,
          "keys in any order");
  }
  const std::string sid = "0123456789abcdef0123456789abcdef";
  const std::vector<std::pair<std::string, std::string>> bad = {
      {"[]", "array"},
      {"", "empty"},
      {"{\"type\":\"ack\"", "unterminated"},
      {R"({"type":"ack","stream_id":")" + sid + R"(","seq":1,"stage":"received","t_us":1} x)",
       "trailing bytes"},
      {R"({"type":"ack","stream_id":")" + sid + R"(","seq":1,"stage":"received","t_us":-1})",
       "negative integer"},
      {R"({"type":"ack","stream_id":")" + sid + R"(","seq":1,"stage":"received","t_us":1e3})",
       "exponent"},
      {R"({"type":"ack","stream_id":")" + sid + R"(","seq":01,"stage":"received","t_us":1})",
       "leading zero"},
      {R"({"type":"ack","stream_id":")" + sid + R"(","seq":0,"stage":"received","t_us":1})",
       "seq 0"},
      {R"({"type":"ack","stream_id":")" + sid + R"(","seq":1,"stage":"received","t_us":1,"x":1})",
       "unknown key"},
      {R"({"type":"ack","stream_id":")" + sid +
           R"(","seq":1,"seq":2,"stage":"received","t_us":1})",
       "duplicate key"},
      {R"({"type":"ack","stream_id":"0123456789ABCDEF0123456789ABCDEF","seq":1,"stage":"received","t_us":1})",
       "uppercase stream id"},
      {R"({"type":"ack","stream_id":")" + sid + R"(","seq":"1","stage":"received","t_us":1})",
       "string seq"},
      {R"({"type":"ack","stream_id":")" + sid + R"(","seq":1,"stage":{"a":1},"t_us":1})",
       "nested object"},
      {R"({"type":"ack","stream_id":")" + sid + R"(","seq":1,"stage":true,"t_us":1})", "boolean"},
      {R"({"type":"ack","stream_id":")" + sid + R"(","seq":1,"stage":null,"t_us":1})", "null"},
      {R"({"type":"hello","protocol":"render-stream/1","receiver":"x","credit_stage":"received","inbound_buffer_bytes":1})",
       "credit stage received"},
      {R"({"type":"ack","stream_id":")" + sid + R"(","seq":1,"stage":"received","t_us":9007199254740992})",
       "above 2^53-1"},
  };
  for (const auto &entry : bad) {
    ControlMessage m;
    std::string error;
    check(!parse_control(entry.first, &m, &error), "refused: " + entry.second);
  }
  {
    const std::string e = encode_error("message-too-large", "seq 4 is \"big\"");
    check(e == R"({"type":"error","reason":"message-too-large","detail":"seq 4 is \"big\""})",
          "encode_error is compact, keys in order: " + e);
    ControlMessage m;
    check(parse_control(e, &m, nullptr) && m.type == ControlType::Error &&
              m.detail == "seq 4 is \"big\"",
          "encode_error round-trips");
  }
}

// ----------------------------------------------------------------- hub

struct Rig {
  FakeTransport transport;
  Hub hub;
  std::uint64_t frame = 0;
  std::uint64_t epoch = 1;
  explicit Rig(LiveConfig config = LiveConfig())
      : hub(&transport, std::move(config), make_template()) {}
  // One frame callback with golden state `state_n`.
  void step(int state_n, std::uint64_t now_ns = 0) {
    ++frame;
    const Snapshot snapshot = golden::state(state_n);
    hub.on_frame(frame, now_ns == 0 ? frame * 16000000ULL : now_ns,
                 hub.wants_snapshot() ? &snapshot : nullptr, epoch, 1000);
  }
  std::string stream_id() const { return hub.summaries().at(0).stream_id; }
};

void test_hello_and_first_transaction() {
  Rig rig;
  rig.hub.on_event(opened(7), 0);
  check(!rig.hub.wants_snapshot(), "no snapshot wanted before hello");
  rig.step(1);
  rig.step(1);
  check(rig.transport.sent.empty(), "nothing is sent before the hello");
  rig.hub.on_event(text(7, kHelloSubmitted), rig.frame);
  check(rig.hub.wants_snapshot(), "a received hello wants a snapshot");
  rig.step(1);
  const std::vector<Sent> bin = rig.transport.of(Sent::Binary);
  check(bin.size() == 2, "hello -> two binary messages (session, seq 1)");
  if (bin.size() == 2) {
    const std::vector<std::uint8_t> m = magic();
    check(std::equal(m.begin(), m.end(), bin[0].bytes.begin()), "message 1 starts with the magic");
    const std::string session = meta_at(bin[0].bytes, 8);
    check(u32le(bin[0].bytes, 8) + 12 == bin[0].bytes.size(),
          "message 1 is exactly the magic and one record");
    check(has(session, "\"type\":\"session\"") && has(session, "\"transport\":\"websocket\"") &&
              has(session, "\"connection\":1") && has(session, "\"encoding\":\"patch\"") &&
              has(session, "\"stream_id\":\"" + rig.stream_id() + "\""),
          "session: websocket, connection 1, patch encoding, the connection's stream_id");
    const std::string t1 = meta_at(bin[1].bytes, 0);
    check(u32le(bin[1].bytes, 0) + 4 == bin[1].bytes.size(), "message 2 is exactly one record");
    check(has(t1, "\"seq\":1,") && has(t1, "\"encoding\":\"full\"") &&
              has(t1, "\"base_seq\":null") && has(t1, "\"frame\":3,"),
          "seq 1 is full, labelled with the host frame: " + t1.substr(0, 120));
  }
  // No credit: further frames send nothing.
  rig.epoch = 2;
  rig.step(2);
  rig.step(2);
  check(rig.transport.of(Sent::Binary).size() == 2, "no second transaction without credit");
  const ConnectionSummary s = rig.hub.summaries().at(0);
  check(s.coalesced == 2, "two coalesced callbacks after the epoch changed (got " +
                              std::to_string(s.coalesced) + ")");
  rig.step(2);
  check(rig.hub.summaries().at(0).coalesced == 3, "coalesced counts every callback while pending");
  rig.epoch = 2;
}

void test_credit_stages() {
  Rig rig;
  rig.hub.on_event(opened(1), 0);
  rig.hub.on_event(text(1, kHelloSubmitted), 0);
  rig.step(1);  // session + seq 1
  const std::string sid = rig.stream_id();
  rig.hub.on_event(text(1, ack(sid, 1, "received")), rig.frame);
  rig.hub.on_event(text(1, ack(sid, 1, "applied")), rig.frame);
  rig.step(2);
  check(rig.transport.of(Sent::Binary).size() == 2,
        "received/applied acks do not return credit under submitted");
  rig.hub.on_event(text(1, ack(std::string(32, 'f'), 1, "submitted")), rig.frame);
  rig.step(2);
  check(rig.transport.of(Sent::Binary).size() == 2, "a foreign stream_id never returns credit");
  rig.hub.on_event(text(1, ack(sid, 1, "submitted")), rig.frame);
  rig.step(2);
  std::vector<Sent> bin = rig.transport.of(Sent::Binary);
  check(bin.size() == 3, "the submitted ack for the in-flight seq returns credit");
  if (bin.size() == 3) {
    const std::string t2 = meta_at(bin[2].bytes, 0);
    check(has(t2, "\"seq\":2,") && has(t2, "\"encoding\":\"patch\"") &&
              has(t2, "\"base_seq\":1,"),
          "seq 2 is a patch on seq 1: " + t2.substr(0, 120));
  }
  // A stale credit-stage ack (seq 1 again) is ignored: seq 2 is in flight.
  rig.hub.on_event(text(1, ack(sid, 1, "submitted")), rig.frame);
  rig.step(3);
  check(rig.transport.of(Sent::Binary).size() == 3, "a stale ack never returns credit");
  ConnectionSummary s = rig.hub.summaries().at(0);
  check(s.acks_ignored == 2, "the foreign and the stale ack are counted as ignored (got " +
                                 std::to_string(s.acks_ignored) + ")");
  check(s.max_in_flight == 1, "max_in_flight == 1");
  check(s.acks[0] == 1 && s.acks[1] == 1 && s.acks[2] == 2, "acks per stage counted");
  check(s.ack_latency_us[2].count == 1, "one submitted latency sample (first ack per seq only)");
  // An ack for a seq never formed is a protocol error.
  rig.hub.on_event(text(1, ack(sid, 9, "submitted")), rig.frame);
  const std::vector<Sent> closes = rig.transport.of(Sent::Close);
  check(closes.size() == 1 && closes[0].code == 1002, "ack for an unformed seq closes 1002");
  const std::vector<Sent> texts = rig.transport.of(Sent::Text);
  check(texts.size() == 1 && has(texts[0].text, "\"reason\":\"protocol\""),
        "... after an error message with reason protocol");
  rig.step(3);
  check(rig.transport.of(Sent::Binary).size() == 3, "nothing is sent after the close");

  // credit_stage applied: the applied ack returns credit.
  Rig applied;
  applied.hub.on_event(opened(2), 0);
  applied.hub.on_event(text(2, kHelloApplied), 0);
  applied.step(1);
  applied.hub.on_event(text(2, ack(applied.stream_id(), 1, "received")), applied.frame);
  applied.step(1);
  check(applied.transport.of(Sent::Binary).size() == 2, "received does not credit under applied");
  applied.hub.on_event(text(2, ack(applied.stream_id(), 1, "applied")), applied.frame);
  applied.step(1);
  bin = applied.transport.of(Sent::Binary);
  check(bin.size() == 3, "applied credits under applied");
  if (bin.size() == 3) {
    const std::string t2 = meta_at(bin[2].bytes, 0);
    check(has(t2, "\"items\":[]") && has(t2, "\"removed_items\":[]"),
          "an unchanged state is an empty patch");
  }
}

void test_resync() {
  Rig rig;
  rig.hub.on_event(opened(1), 0);
  rig.hub.on_event(text(1, kHelloSubmitted), 0);
  rig.step(1);
  const std::string sid = rig.stream_id();
  rig.hub.on_event(text(1, ack(sid, 1, "submitted")), rig.frame);
  rig.step(2);  // seq 2 patch
  rig.hub.on_event(text(1, resync(sid, 1)), rig.frame);  // stale resync: ignored
  rig.step(3);
  check(rig.transport.of(Sent::Binary).size() == 3, "a resync for a stale seq is ignored");
  rig.hub.on_event(text(1, resync(sid, 2)), rig.frame);
  rig.step(3);
  const std::vector<Sent> bin = rig.transport.of(Sent::Binary);
  check(bin.size() == 4, "a resync for the in-flight seq returns credit");
  if (bin.size() == 4) {
    const std::string t3 = meta_at(bin[3].bytes, 0);
    check(has(t3, "\"seq\":3,") && has(t3, "\"encoding\":\"full\"") &&
              has(t3, "\"base_seq\":null"),
          "the transaction after a resync is full: " + t3.substr(0, 120));
  }
  rig.hub.on_event(text(1, ack(sid, 3, "submitted")), rig.frame);
  rig.step(4);
  const std::vector<Sent> after = rig.transport.of(Sent::Binary);
  check(after.size() == 5 && has(meta_at(after[4].bytes, 0), "\"base_seq\":3,"),
        "patches resume against the full transaction");
  check(rig.hub.summaries().at(0).resyncs == 1, "resyncs == 1");
}

void test_message_too_large() {
  // The session message alone is over the receiver's inbound buffer.
  {
    Rig rig;
    rig.hub.on_event(opened(1), 0);
    rig.hub.on_event(
        text(1,
             R"({"type":"hello","protocol":"render-stream/1","receiver":"t","credit_stage":"applied","inbound_buffer_bytes":64})"),
        0);
    rig.step(1);
    check(rig.transport.of(Sent::Binary).empty(), "a too-large session message is never sent");
    const std::vector<Sent> texts = rig.transport.of(Sent::Text);
    check(texts.size() == 1 && has(texts[0].text, "\"reason\":\"message-too-large\""),
          "error message-too-large");
    const std::vector<Sent> closes = rig.transport.of(Sent::Close);
    check(closes.size() == 1 && closes[0].code == 1009, "close 1009");
  }
  // GRC_LIVE_MAX_MESSAGE_BYTES caps a transaction: the session fits, seq 1 does not.
  {
    Session tmpl = make_template();
    tmpl.stream.stream_id = std::string(32, '0');
    tmpl.stream.has_connection = true;
    tmpl.stream.connection = 1;
    tmpl.stream.transport = Transport::Websocket;
    tmpl.stream.encoding = Encoding::Patch;
    const std::size_t session_message = 8 + encode_session(tmpl).size();
    LiveConfig config;
    config.max_message_bytes = session_message;
    FakeTransport transport;
    Hub hub(&transport, config, make_template());
    hub.on_event(opened(1), 0);
    hub.on_event(text(1, kHelloApplied), 0);
    Snapshot big = golden::state(1);
    for (std::uint32_t id = 100; id < 400; ++id) {
      ItemState item;
      item.id = id;
      item.parent.kind = ParentKind::None;
      big.items.push_back(item);
    }
    hub.on_frame(1, 1, &big, 1, 0);
    check(transport.of(Sent::Binary).size() == 1, "the session fits under the cap and is sent");
    const std::vector<Sent> closes = transport.of(Sent::Close);
    check(closes.size() == 1 && closes[0].code == 1009, "the oversize seq 1 closes 1009");
    check(hub.summaries().at(0).error_sent == "message-too-large", "summary error_sent");
  }
}

void test_hello_timeout_and_protocol() {
  {
    LiveConfig config;
    config.hello_timeout_ms = 50;
    Rig rig(config);
    rig.hub.on_event(opened(1, 1000000), 0);
    rig.hub.on_frame(1, 1000000 + 40000000ULL, nullptr, 1, 0);
    check(rig.transport.sent.empty(), "no timeout at 40 ms");
    rig.hub.on_frame(2, 1000000 + 60000000ULL, nullptr, 1, 0);
    const std::vector<Sent> texts = rig.transport.of(Sent::Text);
    check(texts.size() == 1 && has(texts[0].text, "\"reason\":\"hello-timeout\""),
          "hello-timeout error at 60 ms");
    const std::vector<Sent> closes = rig.transport.of(Sent::Close);
    check(closes.size() == 1 && closes[0].code == 1002, "hello-timeout closes 1002");
  }
  const std::vector<std::pair<std::vector<std::string>, std::string>> cases = {
      {{"not json"}, "garbage"},
      {{kHelloSubmitted, kHelloSubmitted}, "second hello"},
      {{R"({"type":"error","reason":"x","detail":"y"})"}, "error from a receiver"},
      {{kHelloSubmitted, ack(std::string(32, '0'), 1, "received")}, "ack before streaming"},
      {{R"({"type":"hello","protocol":"render-stream/0","receiver":"t","credit_stage":"applied","inbound_buffer_bytes":100})"},
       "wrong protocol"},
  };
  for (const auto &entry : cases) {
    Rig rig;
    rig.hub.on_event(opened(1), 0);
    for (const std::string &message : entry.first) {
      rig.hub.on_event(text(1, message), 0);
    }
    const std::vector<Sent> closes = rig.transport.of(Sent::Close);
    check(closes.size() == 1 && closes[0].code == 1002, entry.second + " closes 1002");
    const std::vector<Sent> texts = rig.transport.of(Sent::Text);
    check(texts.size() == 1 && has(texts[0].text, "\"reason\":\"protocol\""),
          entry.second + " sends error protocol");
    rig.step(1);
    check(rig.transport.of(Sent::Binary).empty(), entry.second + ": nothing sent after");
  }
}

void test_drop_message_finish_and_log() {
  const std::string tap = std::string(GRC_TEST_TMP_DIR) + "/drop";
  std::remove((tap + "/stream-1.rs1").c_str());
  std::remove((tap + "/live-1.jsonl").c_str());
  LiveConfig config;
  config.tap_dir = tap;
  config.drop_message_frame = 4;
  Rig rig(config);
  rig.hub.on_event(opened(1), 0);
  rig.hub.on_event(text(1, kHelloSubmitted), 0);
  rig.step(1);  // frame 1: session + seq 1
  const std::string sid = rig.stream_id();
  rig.hub.on_event(text(1, ack(sid, 1, "submitted")), rig.frame);
  rig.step(2);  // frame 2: seq 2
  rig.step(2);  // frame 3: no credit
  rig.hub.on_event(text(1, ack(sid, 2, "submitted")), rig.frame);
  rig.step(3);  // frame 4: seq 3 formed and dropped; credit restored
  rig.step(4);  // frame 5: seq 4 sent (base_seq 3)
  std::vector<Sent> bin = rig.transport.of(Sent::Binary);
  check(bin.size() == 4, "seq 3 is not sent (4 binary messages: session, 1, 2, 4), got " +
                             std::to_string(bin.size()));
  if (bin.size() == 4) {
    const std::string t4 = meta_at(bin[3].bytes, 0);
    check(has(t4, "\"seq\":4,") && has(t4, "\"base_seq\":3,"),
          "the next transaction reaches the receiver with a gap: " + t4.substr(0, 100));
  }
  rig.step(4);  // frame 6: no credit (seq 4 in flight)
  rig.hub.finish(EndReason::Shutdown, rig.frame, 0);
  bin = rig.transport.of(Sent::Binary);
  check(bin.size() == 5, "finish sends the end record without credit");
  check(rig.transport.of(Sent::Close).empty(),
        "finish does not close behind the end record (a Godot client would lose it)");
  check(rig.hub.open_connections() == 1, "the connection stays open for the linger");
  rig.hub.on_event(text(1, ack(sid, 4, "submitted")), rig.frame);
  rig.step(5);
  check(rig.transport.of(Sent::Binary).size() == 5, "nothing is formed after finish");
  check(rig.hub.summaries().at(0).acks[2] == 3, "a late ack during the linger is still counted");
  rig.hub.close_open(rig.frame);
  const std::vector<Sent> closes = rig.transport.of(Sent::Close);
  check(closes.size() == 1 && closes[0].code == 1000 && closes[0].text == "shutdown",
        "close_open() closes 1000 \"shutdown\" at the end of the linger");
  const ConnectionSummary s = rig.hub.summaries().at(0);
  check(s.transactions == 4 && s.sent == 3 && s.dropped == 1, "4 formed, 3 sent, 1 dropped");
  check(s.end_sent && s.closed_by == "host" && s.close_code == 1000, "summary close fields");

  // The tap holds every formed message, the dropped seq 3 included, and is self-consistent:
  // the end record's bytes_total counts magic + session + four transactions.
  const std::string tap_bytes = read_file(tap + "/stream-1.rs1");
  const std::vector<std::uint8_t> tapped(tap_bytes.begin(), tap_bytes.end());
  const std::vector<std::string> metas = stream_metas(tapped);
  check(metas.size() == 6, "tap: session, seqs 1-4, end (got " + std::to_string(metas.size()) +
                               ")");
  if (metas.size() == 6) {
    check(has(metas[3], "\"seq\":3,"), "the tap holds the dropped seq 3");
    const std::uint64_t end_record = [&]() {
      std::size_t at = 8;
      std::size_t last = 8;
      while (at + 4 <= tapped.size()) {
        last = at;
        at += 4 + u32le(tapped, at);
      }
      return tapped.size() - last;
    }();
    check(has(metas[5], "\"bytes_total\":" + std::to_string(tapped.size() - end_record)),
          "end bytes_total equals the tap's bytes before the end record");
    check(has(metas[5], "\"transactions\":4"), "end transactions == 4");
  }
  // The received stream (what was sent) lacks seq 3: the gap.
  const std::vector<std::string> received = stream_metas(concat_binary(rig.transport));
  check(received.size() == 5 && !has(received[3], "\"seq\":3,"), "the sent stream skips seq 3");

  // Live log: one frame line per callback, every sent line held credit, the dropped one is marked.
  const std::vector<std::string> lines = read_lines(tap + "/live-1.jsonl");
  std::size_t frame_lines = 0;
  std::size_t sent_lines = 0;
  bool credit_ok = true;
  bool dropped_marked = false;
  for (const std::string &line : lines) {
    if (has(line, "\"event\":")) {
      continue;
    }
    ++frame_lines;
    if (!has(line, "\"sent\":null")) {
      ++sent_lines;
      credit_ok = credit_ok && has(line, "\"credit\":true");
      dropped_marked = dropped_marked || has(line, "\"dropped\":true");
    }
  }
  check(frame_lines == 6, "six frame lines (got " + std::to_string(frame_lines) + ")");
  check(sent_lines == 4, "four sent lines (got " + std::to_string(sent_lines) + ")");
  check(credit_ok, "every sent line was logged with credit true");
  check(dropped_marked, "the dropped transaction is marked in the log");
  const std::size_t acks = static_cast<std::size_t>(std::count_if(
      lines.begin(), lines.end(), [](const std::string &l) { return has(l, "\"event\":\"ack\""); }));
  check(acks == 3, "three ack event lines (two before finish, one during the linger)");
  check(std::any_of(lines.begin(), lines.end(),
                    [](const std::string &l) {
                      return has(l, "\"event\":\"close\"") && has(l, "\"closed_by\":\"host\"");
                    }),
        "a close event line, closed by the host");
}

void test_receiver_close() {
  Rig rig;
  rig.hub.on_event(opened(3), 0);
  rig.hub.on_event(text(3, kHelloSubmitted), 0);
  rig.step(1);
  rig.hub.on_event(closed(3, 1000), rig.frame);
  rig.hub.on_event(text(3, ack(rig.stream_id(), 1, "submitted")), rig.frame);
  rig.step(2);
  rig.hub.finish(EndReason::Shutdown, rig.frame, 0);
  check(rig.transport.of(Sent::Binary).size() == 2, "nothing after the receiver closed");
  check(rig.transport.of(Sent::Close).empty(), "the host does not close a closed connection");
  const ConnectionSummary s = rig.hub.summaries().at(0);
  check(s.closed_by == "receiver" && s.close_code == 1000 && !s.end_sent,
        "summary: closed by the receiver, 1000, no end");

  // A connection opened after finish is closed at once and not tracked.
  rig.hub.on_event(opened(4), rig.frame);
  const std::vector<ConnectionSummary> all = rig.hub.summaries();
  check(all.size() == 1, "a connection opened after finish is not tracked");
  const std::vector<Sent> late = rig.transport.of(Sent::Close);
  check(late.size() == 1 && late[0].conn == 4, "... and is closed at once");

  // The linger's normal end: the receiver closes after reading its end record.
  Rig linger;
  linger.hub.on_event(opened(5), 0);
  linger.hub.on_event(text(5, kHelloApplied), 0);
  linger.step(1);
  linger.hub.finish(EndReason::Disarm, linger.frame, 0);
  check(linger.hub.open_connections() == 1, "open during the linger");
  linger.hub.on_event(closed(5, 1000), linger.frame);
  check(linger.hub.open_connections() == 0, "closed by the receiver after its end record");
  linger.hub.close_open(linger.frame);
  check(linger.transport.of(Sent::Close).empty(), "close_open() leaves closed connections alone");
  const ConnectionSummary ls = linger.hub.summaries().at(0);
  check(ls.end_sent && ls.closed_by == "receiver" && ls.close_code == 1000,
        "summary: end sent, then closed by the receiver with 1000");
  const std::vector<std::string> received = stream_metas(concat_binary(linger.transport));
  check(!received.empty() && has(received.back(), "\"reason\":\"disarm\""),
        "the end record says disarm");

  // A connection still awaiting its hello is closed at finish (nothing to read).
  Rig waiting;
  waiting.hub.on_event(opened(6), 0);
  waiting.hub.finish(EndReason::Shutdown, 1, 0);
  const std::vector<Sent> wclose = waiting.transport.of(Sent::Close);
  check(wclose.size() == 1 && wclose[0].code == 1000 && waiting.hub.open_connections() == 0,
        "an await-hello connection closes 1000 at finish");
  Rig two;
  two.hub.on_event(opened(1), 0);
  two.hub.on_event(closed(1, 1006), 0);
  two.hub.on_event(opened(2), 0);
  const std::vector<ConnectionSummary> both = two.hub.summaries();
  check(both.size() == 2 && both[1].connection == 2 && both[0].stream_id != both[1].stream_id,
        "reconnect: connection 2, fresh stream_id");
}

void test_latency_stats() {
  std::vector<std::uint64_t> v;
  for (std::uint64_t i = 20; i >= 1; --i) {
    v.push_back(i);
  }
  const LatencyStats s = latency_stats(v);
  check(s.count == 20 && s.min == 1 && s.max == 20 && s.median == 10 && s.p95 == 19,
        "latency stats over 1..20: median 10, p95 19");
  check(latency_stats({}).count == 0, "empty stats");
  check(latency_stats({7}).p95 == 7 && latency_stats({7}).median == 7, "one sample");
}

}  // namespace

int main() {
  grc::make_directories(std::string(GRC_TEST_TMP_DIR) + "/drop");
  test_control_parser();
  test_hello_and_first_transaction();
  test_credit_stages();
  test_resync();
  test_message_too_large();
  test_hello_timeout_and_protocol();
  test_drop_message_finish_and_log();
  test_receiver_close();
  test_latency_stats();
  std::printf("rs1_live_test: %d checks, %d failures\n", g_checks, g_failures);
  return g_failures == 0 ? 0 : 1;
}
