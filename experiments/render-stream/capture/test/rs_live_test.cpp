// Unit tests for the live hub (src/rs_live.cpp; render-stream/2 since G2b2), protocol/gate1-design.md
// "Q4. Delivery model" and "G1c2": credit (one in flight; credit only on the declared stage and
// the in-flight seq; stale and foreign acks ignored), resync, message-too-large, hello timeout,
// protocol errors, the drop-message sabotage, finish (end record without credit), receiver
// close, the live log, coalescing under a stalled receiver with its pending-target bookkeeping
// and newest-state recovery, the ignore-credit and stale-coalesce sabotages (G1d), and the
// control-message parser against protocol/golden-2/control/
// (valid and invalid) plus extra malformed cases, and (G2b2) inline resource records per
// connection. Driven through a fake transport: no socket, no engine. The tap directory is under
// the build tree.

#include <dirent.h>

#include <algorithm>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <iterator>
#include <map>
#include <memory>
#include <mutex>
#include <sstream>
#include <string>
#include <vector>

#include "report.h"
#include "rs2_codec.h"
#include "rs2_diff.h"
#include "rs2_golden_states.h"
#include "rs2_snapshot.h"
#include "rs_http_coding.h"
#include "rs_live.h"
#include "rs_publish.h"
#include "rs_resource_store.h"

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
    R"({"type":"hello","protocol":"render-stream/2","receiver":"t","credit_stage":"submitted","inbound_buffer_bytes":16777216})";
const std::string kHelloApplied =
    R"({"type":"hello","protocol":"render-stream/2","receiver":"t","credit_stage":"applied","inbound_buffer_bytes":16777216})";

std::string ack(const std::string &stream_id, std::uint64_t seq, const char *stage) {
  return std::string(R"({"type":"ack","stream_id":")") + stream_id + R"(","seq":)" +
         std::to_string(seq) + R"(,"stage":")" + stage + R"(","t_us":1})";
}
std::string resync(const std::string &stream_id, std::uint64_t seq) {
  return std::string(R"({"type":"resync","stream_id":")") + stream_id + R"(","seq":)" +
         std::to_string(seq) + R"(,"reason":"test"})";
}

// The golden out-of-band session: no payload is ever inline, so the gate 1 delivery tests see
// exactly one message per record they form. test_inline_resources() uses an inline one.
Session make_template(Delivery delivery = Delivery::OutOfBand) {
  Session tmpl = golden::golden_session(Encoding::Full, std::string(), golden::kFullSessionId,
                                        delivery);
  tmpl.stream = StreamInfo();
  return tmpl;
}

Captured captured_state(int n) {
  Captured c;
  c.state = golden::state(n);
  return c;
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
  const std::string root = std::string(GRC_GOLDEN2_DIR) + "/control";
  const std::vector<std::string> valid = list_dir(root + "/valid");
  const std::vector<std::string> invalid = list_dir(root + "/invalid");
  check(valid.size() == 7, "7 valid control goldens (got " + std::to_string(valid.size()) + ")");
  check(invalid.size() == 8,
        "8 invalid control goldens, a render-stream/1 hello included (got " +
            std::to_string(invalid.size()) + ")");
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
              m.inbound_buffer_bytes == 16777216 && m.receiver == "gate2-selftest" &&
              m.protocol == "render-stream/2",
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
      {R"({"type":"hello","protocol":"render-stream/2","receiver":"x","credit_stage":"received","inbound_buffer_bytes":1})",
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
    const Captured snapshot = captured_state(state_n);
    const std::uint64_t t_ns = now_ns == 0 ? frame * 16000000ULL : now_ns;
    hub.on_frame(frame, t_ns, hub.wants_snapshot(frame, t_ns) ? &snapshot : nullptr, epoch, 1000);
  }
  std::string stream_id() const { return hub.summaries().at(0).stream_id; }
};

void test_hello_and_first_transaction() {
  Rig rig;
  rig.hub.on_event(opened(7), 0);
  check(!rig.hub.wants_snapshot(rig.frame + 1, (rig.frame + 1) * 16000000ULL),
        "no snapshot wanted before hello");
  check(!rig.hub.has_viewer(), "HC1: a connection awaiting its hello is no viewer");
  rig.step(1);
  rig.step(1);
  check(rig.transport.sent.empty(), "nothing is sent before the hello");
  rig.hub.on_event(text(7, kHelloSubmitted), rig.frame);
  check(rig.hub.wants_snapshot(rig.frame + 1, (rig.frame + 1) * 16000000ULL),
        "a received hello wants a snapshot");
  check(rig.hub.has_viewer(), "HC1: a connection that sent its hello is a viewer");
  rig.step(1);
  check(rig.hub.has_viewer(), "HC1: and stays one while streaming");
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

// G4e2 (render-stream-3.md "Live transport"): a V3 hub wants a render-stream/3 hello, refuses a
// /2 one, and opens every stream with the GRS3 magic; parse_control(V3) takes golden-3/control/.
void test_v3_hub_and_control() {
  const std::string root = std::string(GRC_GOLDEN3_DIR) + "/control";
  for (const std::string &path : list_dir(root + "/valid")) {
    ControlMessage m;
    std::string error;
    check(parse_control(read_file(path), &m, &error, ProtocolVersion::V3),
          "valid golden-3 control parses as V3: " + path + " " + error);
  }
  for (const std::string &path : list_dir(root + "/invalid")) {
    ControlMessage m;
    std::string error;
    check(!parse_control(read_file(path), &m, &error, ProtocolVersion::V3),
          "invalid golden-3 control refused as V3: " + path);
  }
  const std::string hello3 =
      R"({"type":"hello","protocol":"render-stream/3","receiver":"t","credit_stage":"submitted","inbound_buffer_bytes":16777216})";
  {
    ControlMessage m;
    check(!parse_control(hello3, &m, nullptr), "a /3 hello is refused by the V2 parser");
  }
  Session tmpl = make_template();
  tmpl.version = ProtocolVersion::V3;
  {
    FakeTransport transport;
    Hub hub(&transport, LiveConfig(), tmpl);
    hub.on_event(opened(1), 0);
    hub.on_event(text(1, kHelloSubmitted), 0);
    const std::vector<Sent> closes = transport.of(Sent::Close);
    check(closes.size() == 1 && closes[0].code == 1002, "a V3 hub closes a /2 hello with 1002");
  }
  {
    FakeTransport transport;
    Hub hub(&transport, LiveConfig(), tmpl);
    hub.on_event(opened(7), 0);
    hub.on_event(text(7, hello3), 0);
    const Captured snapshot = captured_state(1);
    hub.on_frame(1, 16000000ULL, hub.wants_snapshot(1, 16000000ULL) ? &snapshot : nullptr, 1,
                 1000);
    const std::vector<Sent> bin = transport.of(Sent::Binary);
    const std::vector<std::uint8_t> m = magic(ProtocolVersion::V3);
    check(bin.size() == 2 && bin[0].bytes.size() > 8 &&
              std::equal(m.begin(), m.end(), bin[0].bytes.begin()),
          "a V3 hub's session message starts with GRS3");
    check(bin.size() == 2 && has(meta_at(bin[0].bytes, 8), "\"protocol\":\"render-stream/3\""),
          "and its session says render-stream/3");
  }
}

// G5d (render-stream-4.md "Live transport"): a V4 hub wants a render-stream/4 hello, refuses a
// /3 one, and opens every stream with GRS4; parse_control(V4) takes golden-4/control/.
void test_v4_hub_and_control() {
  const std::string root = std::string(GRC_GOLDEN4_DIR) + "/control";
  for (const std::string &path : list_dir(root + "/valid")) {
    ControlMessage m;
    std::string error;
    check(parse_control(read_file(path), &m, &error, ProtocolVersion::V4),
          "valid golden-4 control parses as V4: " + path + " " + error);
  }
  for (const std::string &path : list_dir(root + "/invalid")) {
    ControlMessage m;
    std::string error;
    check(!parse_control(read_file(path), &m, &error, ProtocolVersion::V4),
          "invalid golden-4 control refused as V4: " + path);
  }
  const std::string hello3 =
      R"({"type":"hello","protocol":"render-stream/3","receiver":"t","credit_stage":"submitted","inbound_buffer_bytes":16777216})";
  const std::string hello4 =
      R"({"type":"hello","protocol":"render-stream/4","receiver":"t","credit_stage":"submitted","inbound_buffer_bytes":16777216})";
  {
    ControlMessage m;
    check(!parse_control(hello4, &m, nullptr, ProtocolVersion::V3),
          "a /4 hello is refused by the V3 parser");
  }
  Session tmpl = make_template();
  tmpl.version = ProtocolVersion::V4;
  {
    FakeTransport transport;
    Hub hub(&transport, LiveConfig(), tmpl);
    hub.on_event(opened(1), 0);
    hub.on_event(text(1, hello3), 0);
    const std::vector<Sent> closes = transport.of(Sent::Close);
    check(closes.size() == 1 && closes[0].code == 1002, "a V4 hub closes a /3 hello with 1002");
  }
  {
    FakeTransport transport;
    Hub hub(&transport, LiveConfig(), tmpl);
    hub.on_event(opened(7), 0);
    hub.on_event(text(7, hello4), 0);
    const Captured snapshot = captured_state(1);
    hub.on_frame(1, 16000000ULL, hub.wants_snapshot(1, 16000000ULL) ? &snapshot : nullptr, 1,
                 1000);
    const std::vector<Sent> bin = transport.of(Sent::Binary);
    const std::vector<std::uint8_t> m = magic(ProtocolVersion::V4);
    check(bin.size() == 2 && bin[0].bytes.size() > 8 &&
              std::equal(m.begin(), m.end(), bin[0].bytes.begin()),
          "a V4 hub's session message starts with GRS4");
    check(bin.size() == 2 && has(meta_at(bin[0].bytes, 8), "\"protocol\":\"render-stream/4\""),
          "and its session says render-stream/4");
  }
}

// G7w (render-stream-7.md "Hello", gate7-design.md Q2): parse_control(V7) takes golden-7/
// control/ and the hello's nine new keys (the Hub speaks /7 per connection since G7n:
// test_v6_and_v7_on_one_hub, test_v7_hello_token).
void test_v7_control_parser() {
  const std::string root = std::string(GRC_GOLDEN7_DIR) + "/control";
  const std::vector<std::string> valid = list_dir(root + "/valid");
  const std::vector<std::string> invalid = list_dir(root + "/invalid");
  check(valid.size() == 4, "4 valid golden-7 control vectors (got " +
                               std::to_string(valid.size()) + ")");
  check(invalid.size() == 6, "6 invalid golden-7 control vectors (got " +
                                 std::to_string(invalid.size()) + ")");
  for (const std::string &path : valid) {
    ControlMessage m;
    std::string error;
    check(parse_control(read_file(path), &m, &error, ProtocolVersion::V7),
          "valid golden-7 control parses as V7: " + path + " " + error);
  }
  for (const std::string &path : invalid) {
    ControlMessage m;
    std::string error;
    check(!parse_control(read_file(path), &m, &error, ProtocolVersion::V7),
          "invalid golden-7 control refused as V7: " + path);
    check(!error.empty(), "invalid golden-7 control has an error text: " + path);
  }
  {
    ControlMessage m;
    check(parse_control(read_file(root + "/valid/hello-native-w1-token.json"), &m, nullptr,
                         ProtocolVersion::V7) &&
              m.type == ControlType::Hello && m.protocol == "render-stream/7" &&
              m.receiver_kind == "native" && m.credit_window == 1 && m.has_token &&
              m.token == std::string(64, 'a') && m.has_manifest_sha256 &&
              m.presentation_backing_w == 640 && m.presentation_backing_h == 360 &&
              m.dpr_milli == 1000,
          "hello-native-w1-token fields");
    check(parse_control(read_file(root + "/valid/hello-web-export-w2-notoken.json"), &m, nullptr,
                         ProtocolVersion::V7) &&
              m.receiver_kind == "web-export" && m.credit_window == 2 && !m.has_token &&
              !m.has_manifest_sha256,
          "hello-web-export-w2-notoken fields: null token/manifest_sha256");
  }
  // A /7 hello is refused by the V6 parser, and a /6 hello is refused by the V7 parser (as every
  // earlier version pair: memory g4e1-rs3-version-switch-pattern).
  {
    ControlMessage m;
    check(!parse_control(read_file(root + "/valid/hello-native-w1-token.json"), &m, nullptr,
                          ProtocolVersion::V6),
          "a /7 hello is refused by the V6 parser");
    const std::string hello6 =
        R"({"type":"hello","protocol":"render-stream/6","receiver":"t","credit_stage":"submitted","inbound_buffer_bytes":16777216})";
    check(!parse_control(hello6, &m, nullptr, ProtocolVersion::V7),
          "a /6 hello is refused by the V7 parser");
  }
  // A hand-written minimal hello (every key, token/manifest_sha256 both null) parses -- the
  // null-literal path through the flat-object parser, exercised independently of the golden
  // vectors above.
  {
    ControlMessage m;
    std::string error;
    check(parse_control(
              R"({"type":"hello","protocol":"render-stream/7","receiver":"t","receiver_kind":"native","credit_stage":"submitted","credit_window":1,"inbound_buffer_bytes":1,"token":null,"manifest_sha256":null,"presentation_backing_w":1,"presentation_backing_h":1,"presentation_css_w":1,"presentation_css_h":1,"dpr_milli":1})",
              &m, &error, ProtocolVersion::V7),
          "a minimal /7 hello with null token/manifest_sha256 parses: " + error);
    check(!m.has_token && !m.has_manifest_sha256, "and both decode as absent");
  }
  // An invalid literal (bad null spelling) is refused, not silently accepted as some other type.
  {
    ControlMessage m;
    check(!parse_control(
              R"({"type":"hello","protocol":"render-stream/7","receiver":"t","receiver_kind":"native","credit_stage":"submitted","credit_window":1,"inbound_buffer_bytes":1,"token":nul,"manifest_sha256":null,"presentation_backing_w":1,"presentation_backing_h":1,"presentation_css_w":1,"presentation_css_h":1,"dpr_milli":1})",
              &m, nullptr, ProtocolVersion::V7),
          "a bad null spelling (\"nul\") is refused");
  }
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
             R"({"type":"hello","protocol":"render-stream/2","receiver":"t","credit_stage":"applied","inbound_buffer_bytes":64})"),
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
    Captured big = captured_state(1);
    for (std::uint32_t id = 100; id < 400; ++id) {
      ItemState item;
      item.id = id;
      item.parent.kind = ParentKind::None;
      big.state.items.push_back(item);
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
  std::remove((tap + "/stream-1.rs2").c_str());
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
  const std::string tap_bytes = read_file(tap + "/stream-1.rs2");
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


// The bytes of golden state `state_n` as transaction `seq` at `frame`, patched against golden
// state `base_n` sent as `base_seq` at `base_frame` (what the hub must have sent).
std::vector<std::uint8_t> expected_patch(int base_n, std::uint64_t base_seq,
                                         std::uint64_t base_frame, int state_n,
                                         std::uint64_t seq, std::uint64_t frame) {
  Snapshot base = golden::state(base_n);
  base.seq = base_seq;
  base.frame = base_frame;
  Snapshot cur = golden::state(state_n);
  cur.seq = seq;
  cur.frame = frame;
  return encode_transaction(make_patch(base, cur));
}

// G1d: a receiver that holds its credit (a stall). The host keeps taking frame callbacks; while
// the mirror is unchanged nothing is pending; once it moves, one target is pending (a flag, not
// a queue), `coalesced` counts every such callback and the pending target's age grows; when the
// credit returns the next transaction is the newest state, patched against the stalled seq.
void test_stall_coalescing() {
  const std::string tap = std::string(GRC_TEST_TMP_DIR) + "/stall";
  grc::make_directories(tap);
  std::remove((tap + "/stream-1.rs2").c_str());
  std::remove((tap + "/live-1.jsonl").c_str());
  LiveConfig config;
  config.tap_dir = tap;
  Rig rig(config);
  rig.hub.on_event(opened(1), 0);
  rig.hub.on_event(text(1, kHelloSubmitted), 0);
  rig.step(1);  // frame 1: session + seq 1 (state 1, epoch 1)
  const std::string sid = rig.stream_id();
  rig.step(1);  // frame 2: no credit, mirror unchanged
  rig.step(1);  // frame 3
  check(!rig.hub.wants_snapshot(rig.frame + 1, (rig.frame + 1) * 16000000ULL),
        "no snapshot wanted while stalled");
  ConnectionSummary s = rig.hub.summaries().at(0);
  check(s.coalesced == 0 && s.max_pending == 0, "an unchanged mirror coalesces nothing");
  rig.epoch = 2;
  rig.step(2);  // frame 4: the mirror moved -> pending since 4
  rig.epoch = 3;
  rig.step(3);  // frame 5
  rig.epoch = 4;
  rig.step(4);  // frame 6
  rig.step(4);  // frame 7: unchanged since frame 6, still differs from the sent epoch
  s = rig.hub.summaries().at(0);
  check(s.coalesced == 4,
        "four callbacks coalesced (frames 4-7), got " + std::to_string(s.coalesced));
  check(s.max_pending == 1 && s.pending_episodes == 1, "one pending target, one episode");
  check(s.max_pending_frames == 3, "pending target 3 frames old at frame 7 (got " +
                                       std::to_string(s.max_pending_frames) + ")");
  check(s.max_pending_age_us == 3 * 16000, "pending age 48 ms on the callback clock (got " +
                                               std::to_string(s.max_pending_age_us) + ")");
  check(rig.transport.of(Sent::Binary).size() == 2, "nothing is sent while stalled");
  rig.hub.on_event(text(1, ack(sid, 1, "submitted")), rig.frame);
  check(rig.hub.wants_snapshot(rig.frame + 1, (rig.frame + 1) * 16000000ULL),
        "the returned credit wants a snapshot");
  rig.step(4);  // frame 8: the newest state goes out
  std::vector<Sent> bin = rig.transport.of(Sent::Binary);
  check(bin.size() == 3, "one transaction after the credit");
  if (bin.size() == 3) {
    check(bin[2].bytes == expected_patch(1, 1, 1, 4, 2, 8),
          "seq 2 is the newest state (4) at frame 8, patched against the stalled seq 1");
  }
  s = rig.hub.summaries().at(0);
  check(s.max_pending_frames == 4 && s.max_pending_age_us == 4 * 16000,
        "the send closes the pending episode at 4 frames / 64 ms");
  check(s.max_in_flight == 1 && s.sent_without_credit == 0 && s.stale_sent == 0,
        "one in flight, nothing sent without credit, nothing stale");
  rig.step(4);  // frame 9: no credit, unchanged since the send
  check(rig.hub.summaries().at(0).coalesced == 4, "nothing pending right after the recovery");

  const std::vector<std::string> lines = read_lines(tap + "/live-1.jsonl");
  std::size_t pending_lines = 0;
  bool since_ok = true;
  for (const std::string &line : lines) {
    if (has(line, "\"pending\":true")) {
      ++pending_lines;
      since_ok = since_ok && has(line, "\"pending_since\":4,") && has(line, "\"sent\":null");
    } else if (has(line, "\"pending\":false")) {
      since_ok = since_ok && has(line, "\"pending_since\":null");
    }
  }
  check(pending_lines == 4,
        "four log lines with a pending target (got " + std::to_string(pending_lines) + ")");
  check(since_ok, "pending lines name the frame the target became pending; others null");
}

// G1d sabotage ignore-credit: from its frame on, a transaction goes out at every callback.
void test_ignore_credit() {
  LiveConfig config;
  config.ignore_credit_frame = 3;
  Rig rig(config);
  rig.hub.on_event(opened(1), 0);
  rig.hub.on_event(text(1, kHelloSubmitted), 0);
  rig.step(1);  // frame 1: seq 1
  rig.step(1);  // frame 2: no credit, before the sabotage frame
  check(rig.transport.of(Sent::Binary).size() == 2, "credit is honoured before the frame");
  check(rig.hub.wants_snapshot(3, 3 * 16000000ULL),
        "ignore-credit wants a snapshot without credit");
  rig.step(2);  // frame 3: seq 2 without credit
  rig.step(3);  // frame 4: seq 3 without credit
  const std::string sid = rig.stream_id();
  rig.hub.on_event(text(1, ack(sid, 1, "submitted")), rig.frame);  // settles seq 1, no credit
  rig.step(4);  // frame 5: seq 4
  check(rig.transport.of(Sent::Binary).size() == 5, "a send at every callback from frame 3");
  const ConnectionSummary s = rig.hub.summaries().at(0);
  check(s.sent_without_credit == 3,
        "three sends without credit (got " + std::to_string(s.sent_without_credit) + ")");
  check(s.max_in_flight == 3,
        "three in flight at once (got " + std::to_string(s.max_in_flight) + ")");
  check(s.acks_ignored == 1, "the ack for an earlier seq is not the credit");
}

// G1d sabotage stale-coalesce: the first missed target is kept and sent when credit returns,
// labelled with the current frame; the next transaction patches on to the newest state.
void test_stale_coalesce() {
  LiveConfig config;
  config.stale_coalesce_frame = 2;
  Rig rig(config);
  rig.hub.on_event(opened(1), 0);
  rig.hub.on_event(text(1, kHelloSubmitted), 0);
  rig.step(1);  // frame 1: seq 1 (state 1)
  const std::string sid = rig.stream_id();
  check(rig.hub.wants_snapshot(2, 2 * 16000000ULL),
        "stale-coalesce wants a snapshot to keep");
  rig.epoch = 2;
  rig.step(2);  // frame 2: missed target, state 2 kept
  rig.epoch = 3;
  rig.step(3);  // frame 3: missed again; the kept copy stays state 2
  check(!rig.hub.wants_snapshot(4, 4 * 16000000ULL), "one stale copy at most");
  rig.hub.on_event(text(1, ack(sid, 1, "submitted")), rig.frame);
  rig.step(4);  // frame 4: the stale copy goes out as seq 2
  rig.hub.on_event(text(1, ack(sid, 2, "submitted")), rig.frame);
  rig.step(4);  // frame 5: seq 3 patches from the stale state to the newest
  const std::vector<Sent> bin = rig.transport.of(Sent::Binary);
  check(bin.size() == 4, "session, seqs 1-3");
  if (bin.size() == 4) {
    check(bin[2].bytes == expected_patch(1, 1, 1, 2, 2, 4),
          "seq 2 carries frame 2's state, labelled frame 4");
    check(bin[3].bytes == expected_patch(2, 2, 4, 4, 3, 5),
          "seq 3 patches from the stale state to the newest");
  }
  const ConnectionSummary s = rig.hub.summaries().at(0);
  check(s.stale_sent == 1 && s.max_in_flight == 1, "one stale send, still one in flight");
}

// ----------------------------------------------------------------- rate control (G6r, Q3c)

constexpr std::uint64_t kHostPeriodNs = 16666666ULL;  // a 60 fps host, matching Rig::step's own

// Drives `frames` host callbacks at a fixed 60 fps clock on a fresh connection, acking every
// send immediately at the credit stage (so credit itself never limits pacing -- only the
// schedule does), and returns the connection's summary. `stall_from`/`stall_to` (host frame
// numbers, inclusive) withhold every ack in that window, to exercise ticks_credit_blocked.
// `send_frames`, when given, collects the host frame index of every actual send (seq >= 1, in
// order), for burst checks.
ConnectionSummary run_rate_schedule(std::uint64_t publish_period_ns, int frames,
                                    int stall_from = -1, int stall_to = -1,
                                    std::vector<int> *send_frames = nullptr) {
  LiveConfig config;
  config.publish_period_ns = publish_period_ns;
  Rig rig(config);
  rig.hub.on_event(opened(1), 0);
  rig.hub.on_event(text(1, kHelloSubmitted), 0);
  std::string sid;
  std::uint64_t acked_through = 0;
  for (int i = 1; i <= frames; ++i) {
    const std::uint64_t t_ns = static_cast<std::uint64_t>(i) * kHostPeriodNs;
    rig.step(1, t_ns);
    if (sid.empty()) {
      sid = rig.stream_id();
    }
    const std::uint64_t sent_count = rig.transport.of(Sent::Binary).size();
    const std::uint64_t latest_seq = sent_count == 0 ? 0 : sent_count - 1;
    const bool stalled = stall_from >= 0 && i >= stall_from && i <= stall_to;
    if (latest_seq > acked_through) {
      if (send_frames != nullptr) {
        send_frames->push_back(i);
      }
      if (!stalled) {
        rig.hub.on_event(text(1, ack(sid, latest_seq, "submitted"), t_ns), rig.frame);
        acked_through = latest_seq;
      }
    }
  }
  return rig.hub.summaries().at(0);
}

// GRC_PUBLISH_FPS=uncapped (publish_period_ns 0) reproduces today's behaviour exactly: a send at
// every callback that holds credit, independent of any schedule.
void test_rate_uncapped_unchanged() {
  const ConnectionSummary s = run_rate_schedule(0, 120);
  check(s.sent == 120, "uncapped sends every callback (got " + std::to_string(s.sent) + ")");
  check(s.ticks_due == 0 && s.ticks_sent == 0 && s.ticks_credit_blocked == 0 &&
            s.frames_rate_idle == 0,
        "the rate counters stay 0 under the default (uncapped)");
}

// 15/30/60 fps targets on a 60 fps host, every ack immediate: the published rate lands within a
// few percent of the target over a multi-second run (the only slack is integer rounding of the
// period and of the 60 fps host clock itself).
void test_rate_targets() {
  const struct {
    int target_fps;
    int frames;  // 10 s at 60 fps
  } kCases[] = {{15, 600}, {30, 600}, {60, 600}};
  for (const auto &tc : kCases) {
    const std::uint64_t period_ns = 1000000000ULL / static_cast<std::uint64_t>(tc.target_fps);
    std::vector<int> send_frames;
    const ConnectionSummary s = run_rate_schedule(period_ns, tc.frames, -1, -1, &send_frames);
    const double seconds = static_cast<double>(tc.frames) * static_cast<double>(kHostPeriodNs) /
                           1e9;
    const double achieved = static_cast<double>(s.sent) / seconds;
    check(achieved >= 0.9 * tc.target_fps && achieved <= 1.1 * tc.target_fps,
          "target " + std::to_string(tc.target_fps) + " fps achieved " +
              std::to_string(achieved) + " fps (sent " + std::to_string(s.sent) + " over " +
              std::to_string(seconds) + " s)");
    check(s.ticks_credit_blocked == 0, "every ack is immediate: nothing credit-blocked");
    check(s.ticks_due == s.ticks_sent, "every due tick sent (credit was always available)");
    // Never bursts: consecutive sends are never closer than half the target's host-frame
    // spacing (the schedule should space them at ~P apart, never fire twice back to back to
    // "catch up"). At 60 fps the target equals the host rate, so every frame is expected to
    // send; the no-burst property is only meaningful (and checked) below 60.
    const double host_frames_per_tick = 60.0 / tc.target_fps;
    if (tc.target_fps < 60) {
      check(s.frames_rate_idle > 0, "a target below the host's 60 fps leaves idle callbacks");
      int min_gap = 1 << 30;
      for (std::size_t i = 1; i < send_frames.size(); ++i) {
        min_gap = std::min(min_gap, send_frames[i] - send_frames[i - 1]);
      }
      check(send_frames.size() < 2 || min_gap >= static_cast<int>(host_frames_per_tick) - 1,
            "target " + std::to_string(tc.target_fps) +
                " fps: no two sends closer than ~1 period apart (min gap " +
                std::to_string(min_gap) + " host frames, expected ~" +
                std::to_string(host_frames_per_tick) + ")");
    }
  }
}

// A due tick without credit is counted (ticks_credit_blocked) and stays due, exactly as the
// existing coalescing/pending accounting already proves for the uncapped case; rate control
// just adds the counter. A long stall must not cause a burst once credit returns: at most one
// send happens on the callback credit returns, not one per tick missed during the stall.
void test_rate_credit_blocked_and_no_burst() {
  const std::uint64_t period_ns = 1000000000ULL / 30;  // 30 fps target, 60 fps host
  // Stall acks for host frames 10..40 inclusive (roughly half a second: well over 10 missed
  // 30 fps ticks), then resume acking immediately.
  std::vector<int> send_frames;
  const ConnectionSummary s = run_rate_schedule(period_ns, 120, 10, 40, &send_frames);
  check(s.ticks_credit_blocked > 5,
        "several ticks were due with no credit during the stall (got " +
            std::to_string(s.ticks_credit_blocked) + ")");
  check(s.ticks_sent <= s.ticks_due, "sent ticks never exceed due ticks (no catch-up burst)");
  check(s.max_in_flight == 1, "never more than one transaction in flight at once");
  // No burst after the stall: roughly 15 ticks (30 fps * ~0.5 s) were missed during it, so a
  // "catch up on every missed tick" implementation would send a run of ~15 transactions right
  // after recovery (one per missed tick). The schedule is phase-locked to the connection's own
  // t0 (Q3c), not reset to "now" on recovery, so this synthetic receiver's unrealistically
  // instant acks (every send re-credited before the very next host callback) can make the
  // schedule's fixed-phase grid briefly realign over a few close-together sends before
  // settling back to the normal ~1-per-2-frames cadence -- still far short of one send per
  // missed tick. A real receiver's non-zero credit latency (including the gate 1 fixture's
  // live-rate-30 leg) does not exercise this instant-ack corner.
  const std::size_t sends_soon_after = static_cast<std::size_t>(
      std::count_if(send_frames.begin(), send_frames.end(),
                    [](int f) { return f > 40 && f <= 50; }));
  check(sends_soon_after <= 10,
        "no catch-up burst: nowhere near one send per missed tick in the 10 frames right after "
        "the stall (got " +
            std::to_string(sends_soon_after) + ", vs ~15 missed ticks)");
}

// GRC_PUBLISH_FPS configures one target for the whole hub (D8), shared by every connection, but
// each connection's schedule state (t0, next_due, counters) is its own (Q3c "Per connection").
// This proves that independence: a second connection joining well after the first must reach
// the SAME target rate measured from ITS OWN first send, not be starved or accelerated by
// however far along the first connection's schedule already is (D13 "Gate 6 proves two at once").
void test_rate_two_connections() {
  LiveConfig config;
  config.publish_period_ns = 1000000000ULL / 60;  // both connections target 60 fps
  Rig rig(config);
  rig.hub.on_event(opened(1), 0);
  rig.hub.on_event(text(1, kHelloSubmitted), 0);
  std::string sid1;
  std::uint64_t acked1 = 0;
  const int kSecondHello = 40;  // connection 2 joins 40 host frames (~0.67 s) after connection 1
  std::string sid2;
  std::uint64_t acked2 = 0;
  for (int i = 1; i <= 300; ++i) {
    const std::uint64_t t_ns = static_cast<std::uint64_t>(i) * kHostPeriodNs;
    if (i == kSecondHello) {
      rig.hub.on_event(opened(2), t_ns);
      rig.hub.on_event(text(2, kHelloSubmitted, t_ns), t_ns);
    }
    rig.step(1, t_ns);
    if (sid1.empty()) {
      sid1 = rig.hub.summaries().at(0).stream_id;
    }
    if (i >= kSecondHello && sid2.empty() && rig.hub.summaries().size() > 1) {
      sid2 = rig.hub.summaries().at(1).stream_id;
    }
    // Ack up to each connection's current `sent` count immediately, so credit never limits
    // either one's pacing -- only each one's own schedule does.
    const auto &summaries = rig.hub.summaries();
    if (!sid1.empty() && summaries[0].sent > acked1) {
      rig.hub.on_event(text(1, ack(sid1, summaries[0].sent, "submitted"), t_ns), rig.frame);
      acked1 = summaries[0].sent;
    }
    if (summaries.size() > 1 && !sid2.empty() && summaries[1].sent > acked2) {
      rig.hub.on_event(text(2, ack(sid2, summaries[1].sent, "submitted"), t_ns), rig.frame);
      acked2 = summaries[1].sent;
    }
  }
  const ConnectionSummary s1 = rig.hub.summaries().at(0);
  const ConnectionSummary s2 = rig.hub.summaries().at(1);
  // Connection 1 ran the full 300 frames (5 s) at 60 fps target == the 60 fps host: every
  // callback should be due.
  const double seconds1 = 300.0 * static_cast<double>(kHostPeriodNs) / 1e9;
  const double rate1 = static_cast<double>(s1.sent) / seconds1;
  check(rate1 >= 0.9 * 60 && rate1 <= 1.1 * 60,
        "connection 1's 60 fps target achieved " + std::to_string(rate1) + " fps");
  // Connection 2 joined late but at the SAME 60 fps target (one LiveConfig per hub): its own
  // schedule starts at its own first send, not connection 1's, so it should ALSO reach ~60 fps
  // measured from when it actually started, not be starved or accelerated by connection 1.
  const double seconds2 = (300 - kSecondHello + 1) * static_cast<double>(kHostPeriodNs) / 1e9;
  const double rate2 = static_cast<double>(s2.sent) / seconds2;
  check(rate2 >= 0.85 * 60 && rate2 <= 1.15 * 60,
        "connection 2's independent schedule (joined late) achieved " + std::to_string(rate2) +
            " fps over its own " + std::to_string(seconds2) + " s");
  check(s1.ticks_credit_blocked == 0 && s2.ticks_credit_blocked == 0,
        "both connections' acks were immediate: nothing credit-blocked");
}

}  // namespace

// G2b2: an inline session ("Live before HTTP"). Every ok image hash a transaction's table names
// goes out once per connection as a resource record, one per message, right before that
// transaction; a resync keeps what was carried; the message cap applies to resource records.
Captured with_payloads(int n) {
  Captured c = captured_state(n);
  for (const TextureEntry &t : c.state.textures) {
    if (t.kind == TextureKind::Image && t.status == TextureStatus::Ok && t.has_hash) {
      // Any bytes: the hub packages them, it does not decode them.
      c.payloads[t.hash] = std::make_shared<grc::rs::PayloadBytes>(
          std::vector<std::uint8_t>(t.payload_bytes, static_cast<std::uint8_t>(t.id)));
    }
  }
  return c;
}

void test_inline_resources() {
  FakeTransport transport;
  Hub hub(&transport, LiveConfig(), make_template(Delivery::Inline));
  hub.on_event(opened(1), 0);
  hub.on_event(text(1, kHelloApplied), 0);
  std::uint64_t frame = 0;
  const auto step = [&](int n) {
    ++frame;
    const Captured c = with_payloads(n);
    hub.on_frame(frame, frame * 1000000ULL,
                 hub.wants_snapshot(frame, frame * 1000000ULL) ? &c : nullptr, frame, 0);
  };
  const auto kinds = [&transport]() {
    std::string out;
    for (const Sent &s : transport.of(Sent::Binary)) {
      const std::vector<std::string> metas = stream_metas(s.bytes.size() > 8 && s.bytes[0] == 'G'
                                                              ? s.bytes
                                                              : std::vector<std::uint8_t>());
      if (!metas.empty()) {
        out.push_back('s');
        continue;
      }
      const std::string meta = meta_at(s.bytes, 0);
      out.push_back(has(meta, "\"type\":\"resource\"") ? 'r' : 't');
    }
    return out;
  };
  step(1);
  // State 1 names A1 (ids 1 and 2 share it) and F: two distinct hashes, in id order.
  check(kinds() == "srrt", "session, A1 and F inline, then seq 1");
  const std::string sid = hub.summaries().at(0).stream_id;
  hub.on_event(text(1, ack(sid, 1, "applied")), frame);
  step(2);
  check(kinds() == "srrtt", "an unchanged table carries nothing new");
  hub.on_event(text(1, ack(sid, 2, "applied")), frame);
  step(3);
  check(kinds() == "srrttrt", "A2 arrives right before the transaction that first names it");
  hub.on_event(text(1, resync(sid, 3)), frame);
  step(4);
  // State 4 adds P (replaced placeholder) and N (A1 again): only P is new; the resync's full
  // transaction re-sends nothing already carried.
  check(kinds() == "srrttrtrt", "after a resync only never-carried hashes go out (P)");
  const ConnectionSummary s = hub.summaries().at(0);
  check(s.resource_records == 4, "summary resource_records 4");
  hub.finish(EndReason::Shutdown, frame, frame * 1000000ULL);
  const std::vector<Sent> bin = transport.of(Sent::Binary);
  const std::string end_meta = meta_at(bin.back().bytes, 0);
  check(has(end_meta, "\"resource_records\":4"), "the end record counts the resource records");
  std::vector<std::uint8_t> stream;
  for (const Sent &x : bin) {
    stream.insert(stream.end(), x.bytes.begin(), x.bytes.end());
  }
  std::uint64_t total = 0;
  for (std::size_t i = 0; i + 1 < bin.size(); ++i) {
    total += bin[i].bytes.size();
  }
  check(has(end_meta, "\"bytes_total\":" + std::to_string(total)),
        "bytes_total counts the magic, session, resource and transaction records");

  // A resource record above the message cap: message-too-large, close 1009.
  LiveConfig small;
  small.max_message_bytes = 1200;
  FakeTransport t2;
  Hub hub2(&t2, small, make_template(Delivery::Inline));
  hub2.on_event(opened(1), 0);
  hub2.on_event(text(1, kHelloApplied), 0);
  Captured big = with_payloads(1);
  big.payloads[golden::kHashA1] =
      std::make_shared<grc::rs::PayloadBytes>(std::vector<std::uint8_t>(4000, 1));
  hub2.on_frame(1, 1, &big, 1, 0);
  const std::vector<Sent> closes = t2.of(Sent::Close);
  check(closes.size() == 1 && closes[0].code == 1009 &&
            hub2.summaries().at(0).error_sent == "message-too-large",
        "an oversize resource record closes 1009 (message-too-large)");
}

// G6s (gate6-design.md Q7e "soak-inline"): `carried` is never pruned, even once a hash leaves the
// connection's base -- render-stream-2.md's resource-duplicate rule ("each hash at most once" per
// stream) makes a returning hash a correctness hazard, not a cache-efficiency question. Measured
// the hard way: an earlier draft pruned `carried` to the base and re-sent a returning hash, which
// broke the first real soak-inline run with resource-duplicate (MS's mesh surface recurs every 90
// frames under its sine-wave motion). A single texture id (1) cycles between two hashes with no
// second id keeping either one alive (unlike the golden states' "atwin", which is why
// test_inline_resources() above never exercises this: kHashA1 stays reachable through id 2 the
// whole time there).
void test_carried_bounded() {
  const std::string hash_a(64, 'a');
  const std::string hash_b(64, 'b');
  FakeTransport transport;
  Hub hub(&transport, LiveConfig(), make_template(Delivery::Inline));
  hub.on_event(opened(1), 0);
  hub.on_event(text(1, kHelloApplied), 0);
  std::uint64_t frame = 0;
  const auto step = [&](const std::string &hash) {
    ++frame;
    Captured c;
    c.state.canvases = {golden::root_canvas({})};
    c.state.textures = {golden::texture_a(1, hash)};
    c.payloads[hash] = std::make_shared<grc::rs::PayloadBytes>(std::vector<std::uint8_t>(16, 7));
    hub.on_frame(frame, frame * 1000000ULL,
                 hub.wants_snapshot(frame, frame * 1000000ULL) ? &c : nullptr, frame, 0);
  };
  const auto resource_records = [&transport]() {
    int count = 0;
    for (const Sent &s : transport.of(Sent::Binary)) {
      // A magic-prefixed message (the session) carries no record at offset 0 the way a plain
      // resource/transaction message does -- skip it, as kinds() in test_inline_resources() does.
      if (s.bytes.size() > 8 && s.bytes[0] == 'G') {
        continue;
      }
      if (has(meta_at(s.bytes, 0), "\"type\":\"resource\"")) {
        ++count;
      }
    }
    return count;
  };
  const auto ack_latest = [&]() {
    hub.on_event(text(1, ack(hub.summaries().at(0).stream_id, hub.summaries().at(0).sent,
                             "applied")),
                 frame);
  };
  step(hash_a);  // seq 1 names A: one resource record, then the transaction.
  check(resource_records() == 1, "A is carried once: " + std::to_string(resource_records()));
  ack_latest();
  step(hash_b);  // seq 2 names B only: A leaves the base (nothing else names it).
  check(resource_records() == 2, "B is newly carried: " + std::to_string(resource_records()));
  ack_latest();
  step(hash_a);  // seq 3 names A again, having left the base at seq 2: NOT re-carried (G6s).
  check(resource_records() == 2,
        "A, having left and returned, is not re-carried (resource-duplicate): " +
            std::to_string(resource_records()));
  ack_latest();
  step(hash_a);  // seq 4 still names A: still nothing new.
  check(resource_records() == 2, "an unchanged A carries nothing new: " + std::to_string(resource_records()));
}


// P3-SP (results/p3/p3-sp.md): shared publication. Every connection of a multi-connection hub gets
// exactly the bytes a hub serving that connection alone sends it -- transactions re-stamped from
// another connection's encode, inline records encoded once, the carried sets in one index -- and
// the sharing actually happens (shared_sends), including a full transaction after two resyncs.
struct SpConn {
  std::uint64_t open_frame;
  std::uint64_t ack_period;  // acks the latest seq every ack_period frames
  std::uint64_t resync_frame;  // 0: never
};

Captured sp_state(std::uint64_t frame) {
  Captured c = with_payloads(1 + static_cast<int>(frame % 4));
  // Two hex-hashed textures that cycle (a hash recurs: never re-carried) beside the golden ones.
  static const char *kHex[] = {"0123", "4567", "89ab", "cdef", "a5a5"};
  for (std::uint32_t k = 0; k < 2; ++k) {
    std::string hash;
    while (hash.size() < 64) {
      hash += kHex[(frame / (k + 1) + k) % 5];
    }
    TextureEntry t = golden::texture_a(frame / (k + 1) + 1, hash);
    t.id = 100 + k;
    c.state.textures.push_back(t);
    c.payloads[hash] = std::make_shared<grc::rs::PayloadBytes>(
        std::vector<std::uint8_t>(t.payload_bytes, static_cast<std::uint8_t>(k + 3)));
  }
  return c;
}

std::map<std::uint32_t, std::vector<std::vector<std::uint8_t>>> sp_run(
    const std::vector<SpConn> &conns, std::vector<ConnectionSummary> *summaries) {
  FakeTransport transport;
  Hub hub(&transport, LiveConfig(), make_template(Delivery::Inline));
  std::map<std::uint32_t, std::uint32_t> number;  // transport id -> connection number (open order)
  for (std::uint64_t frame = 1; frame <= 40; ++frame) {
    for (std::uint32_t i = 0; i < conns.size(); ++i) {
      if (conns[i].open_frame == frame) {
        hub.on_event(opened(i + 1), frame);
        hub.on_event(text(i + 1, kHelloApplied), frame);
        number[i + 1] = static_cast<std::uint32_t>(number.size() + 1);
      }
    }
    const std::vector<ConnectionSummary> now = hub.summaries();
    for (std::uint32_t i = 0; i < conns.size(); ++i) {
      if (number.count(i + 1) == 0 || frame <= conns[i].open_frame) {
        continue;
      }
      const ConnectionSummary &cs = now.at(number[i + 1] - 1);
      if (conns[i].resync_frame == frame && cs.sent > 0) {
        hub.on_event(text(i + 1, resync(cs.stream_id, cs.sent)), frame);
      } else if ((frame - conns[i].open_frame) % conns[i].ack_period == 0 && cs.sent > 0) {
        hub.on_event(text(i + 1, ack(cs.stream_id, cs.sent, "applied")), frame);
      }
    }
    const Captured c = sp_state(frame);
    hub.on_frame(frame, frame * 16000000ULL,
                 hub.wants_snapshot(frame, frame * 16000000ULL) ? &c : nullptr, frame, 0);
  }
  std::map<std::uint32_t, std::vector<std::vector<std::uint8_t>>> out;
  for (const Sent &x : transport.of(Sent::Binary)) {
    if (x.bytes.size() > 8 && x.bytes[0] == 'G') {
      continue;  // the magic + session message: its stream_id is fresh per connection
    }
    out[x.conn].push_back(x.bytes);
  }
  if (summaries != nullptr) {
    *summaries = hub.summaries();
  }
  return out;
}

void test_shared_publication_bytes() {
  const std::vector<SpConn> conns = {
      {1, 1, 0}, {1, 1, 0}, {3, 2, 0}, {3, 1, 17}, {1, 1, 17}};
  std::vector<ConnectionSummary> multi_summaries;
  const auto multi = sp_run(conns, &multi_summaries);
  std::uint64_t shared = 0;
  for (const ConnectionSummary &cs : multi_summaries) {
    shared += cs.shared_sends;
  }
  check(shared > 40, "lockstep connections share their transactions: " + std::to_string(shared));
  for (std::uint32_t i = 0; i < conns.size(); ++i) {
    std::vector<ConnectionSummary> solo_summaries;
    const auto solo = sp_run({conns[i]}, &solo_summaries);
    const auto &mine = multi.at(i + 1);
    const auto &alone = solo.at(1);
    bool same = mine.size() == alone.size();
    for (std::size_t k = 0; same && k < mine.size(); ++k) {
      same = mine[k] == alone[k];
    }
    check(same, "connection " + std::to_string(i + 1) + " gets the bytes it gets alone (" +
                    std::to_string(mine.size()) + " vs " + std::to_string(alone.size()) +
                    " messages)");
    check(solo_summaries.at(0).shared_sends == 0, "a lone connection shares nothing");
    check(solo_summaries.at(0).carried_size > 0 &&
              solo_summaries.at(0).carried_size == multi_summaries.at(
                  i < 2 ? i : (i == 4 ? 2 : i + 1)).carried_size,
          "carried_size per connection as alone");
  }
}

// P3-SP: the host-wide carried index -- exact per slot, a reused slot starts empty, and the
// table empties once no connection holds a slot.
void test_carried_index() {
  CarriedIndex index;
  const unsigned a = index.acquire();
  const unsigned b = index.acquire();
  check(a != b && a < CarriedIndex::kSlots && b < CarriedIndex::kSlots, "two slots");
  const std::uint32_t h1 = index.intern(golden::kHashA1);
  const std::uint32_t h2 = index.intern(golden::kHashA2);
  const std::uint32_t odd = index.intern("not-a-sha256");
  check(h1 != h2 && h1 != odd && index.intern(golden::kHashA1) == h1 &&
            index.intern("not-a-sha256") == odd,
        "ids are stable and distinct");
  index.mark(h1, a);
  index.mark(odd, b);
  check(index.carried(h1, a) && !index.carried(h1, b) && index.carried(odd, b) &&
            !index.carried(h2, a),
        "carried exactly per slot");
  for (int i = 0; i < 5000; ++i) {
    char buf[65];
    std::snprintf(buf, sizeof(buf), "%016x%048x", i * 2654435761u, i);
    const std::uint32_t id = index.intern(buf);
    index.mark(id, a);
  }
  check(index.carried(index.intern(golden::kHashA1), a) && index.entries() == 5003,
        "growth keeps every id and mark: " + std::to_string(index.entries()));
  index.release(a);
  for (unsigned i = 0; i < CarriedIndex::kSlots - 1; ++i) {
    const unsigned s = index.acquire();
    check(s != CarriedIndex::kNoSlot, "slots are reused once every one was used");
    if (s == a) {
      check(!index.carried(h1, s), "a reused slot starts with nothing carried");
    }
    if (i + 2 < CarriedIndex::kSlots) {
      index.release(s);
    }
  }
  check(index.carried(odd, b), "the open connection keeps its marks");
  index.maintain();
  check(index.entries() > 0, "the table stays while a slot is held");
}

// ----------------------------------------------------------------- G2c2: serving and pins

grc::rs::PayloadPtr grt1(std::uint8_t fill, std::size_t data_bytes) {
  // A minimal GRT1-shaped payload: magic, meta "{}", the data length, the data.
  std::vector<std::uint8_t> b = {'G', 'R', 'T', '1', '\r', '\n', 0x1a, '\n', 2, 0, 0, 0, '{', '}'};
  b.push_back(static_cast<std::uint8_t>(data_bytes & 0xff));
  b.push_back(static_cast<std::uint8_t>((data_bytes >> 8) & 0xff));
  b.push_back(0);
  b.push_back(0);
  b.insert(b.end(), data_bytes, fill);
  return std::make_shared<grc::rs::PayloadBytes>(std::move(b));
}

const std::string kH1(64, '1');
const std::string kH2(64, '2');
const std::string kH3(64, '3');

std::string ops(const std::vector<grc::rs::ServeEvent> &events) {
  std::string out;
  for (const grc::rs::ServeEvent &e : events) {
    out += std::string(e.op) + ":" + e.hash.substr(0, 1) + ":" + e.reason +
           (e.sabotage ? "!" : "") + " ";
  }
  return out;
}

// One frame callback the way entry.cpp drives it: pin what may be sent, let the hub send, then
// retire everything neither current nor a base.
struct ServeRig {
  FakeTransport transport;
  Hub hub;
  grc::rs::ServedResources served;
  std::uint64_t frame = 0;
  ServeRig() : hub(&transport, LiveConfig(), make_template()) {
    hub.on_event(opened(1), 0);
    hub.on_event(text(1, kHelloApplied), 0);
  }
  std::vector<grc::rs::ServeEvent> step(const grc::rs::PayloadMap &current) {
    ++frame;
    Captured c = captured_state(1);
    c.payloads = current;
    std::vector<grc::rs::ServeEvent> events;
    std::vector<const grc::rs::PayloadMap *> sendable = hub.held_payloads();
    sendable.insert(sendable.begin(), &c.payloads);
    served.pin(sendable, frame, &events);
    hub.on_frame(frame, frame * 1000000ULL,
                 hub.wants_snapshot(frame, frame * 1000000ULL) ? &c : nullptr, frame, 0);
    served.retire(c.payloads, hub.base_payloads(), frame, &events);
    return events;
  }
  void applied(std::uint64_t seq) {
    hub.on_event(text(1, ack(hub.summaries().at(0).stream_id, seq, "applied")), frame);
  }
};

// HC4b: the shared payload map (copy-on-write chunks, diff over differing chunks), and
// ServedResources' pin/retire/budget over map differences, against the full walk they replaced:
// the same events in the same order, the same retained set and byte totals, frame by frame.
void test_hc4b_shared_maps_and_serving() {
  std::uint32_t seed = 12345;
  const auto rnd = [&seed](std::uint32_t n) {
    seed = seed * 1103515245u + 12345u;
    return (seed >> 8) % n;
  };
  const auto key = [](std::uint32_t k) {
    char buf[65];
    std::snprintf(buf, sizeof(buf), "%064x", k * 2654435761u);
    return std::string(buf);
  };
  std::vector<grc::rs::PayloadPtr> bytes;
  for (std::uint32_t k = 0; k < 600; ++k) {
    bytes.push_back(grt1(static_cast<int>(k % 200) + 1, 16 + k % 40));
  }
  // The map against std::map, over random writes; copies share untouched chunks.
  grc::rs::PayloadMap map;
  std::map<std::string, grc::rs::PayloadPtr> want;
  std::vector<grc::rs::PayloadMap> history;
  for (int round = 0; round < 60; ++round) {
    const grc::rs::PayloadMap before = map;
    const std::map<std::string, grc::rs::PayloadPtr> want_before = want;
    const int writes = round == 0 ? 400 : static_cast<int>(rnd(20));
    for (int w = 0; w < writes; ++w) {
      const std::uint32_t k = rnd(600);
      if (rnd(3) == 0) {
        map.erase(key(k));
        want.erase(key(k));
      } else {
        map.emplace(key(k), bytes[k]);
        want.emplace(key(k), bytes[k]);
      }
    }
    bool same = map.size() == want.size();
    std::uint64_t weight = 0;
    auto w = want.begin();
    for (auto it = map.begin(); same && it != map.end(); ++it, ++w) {
      same = it->first == w->first && it->second == w->second;
      weight += w->second->size();
    }
    check(same && map.weight() == weight, "the shared map iterates as std::map, with its weight");
    std::vector<std::string> only_a;
    std::vector<std::string> only_b;
    grc::rs::diff_shared_maps(
        before, map, [&](const auto &e) { only_a.push_back(e.first); },
        [&](const auto &e) { only_b.push_back(e.first); }, [](const auto &, const auto &) {});
    std::vector<std::string> want_a;
    std::vector<std::string> want_b;
    for (const auto &e : want_before) {
      if (want.count(e.first) == 0) want_a.push_back(e.first);
    }
    for (const auto &e : want) {
      if (want_before.count(e.first) == 0) want_b.push_back(e.first);
    }
    check(only_a == want_a && only_b == want_b, "diff_shared_maps finds exactly the differences");
    history.push_back(map);
  }
  check(history[0].root()->chunks.size() >= 2, "the map spans several chunks");

  // Serving: an incremental ServedResources (shadow on) against the full-walk model.
  grc::rs::ServedResources served;
  served.set_shadow(true);
  std::map<std::string, grc::rs::PayloadPtr> model;
  bool events_same = true;
  bool beyond_same = true;
  bool union_same = true;
  for (std::size_t f = 1; f < history.size(); ++f) {
    const grc::rs::PayloadMap &current = history[f];
    std::vector<const grc::rs::PayloadMap *> bases;
    const std::size_t nb = rnd(3);
    for (std::size_t b = 0; b < nb; ++b) {
      bases.push_back(&history[f - 1 - rnd(static_cast<std::uint32_t>(std::min<std::size_t>(f, 4)))]);
    }
    const std::vector<const grc::rs::PayloadMap *> known = {&current, &history[f - 1]};
    // The budget before the pin, as the frame callback takes it.
    if (f > 1) {
      std::uint64_t want_beyond = 0;
      for (const auto &e : model) {
        if (current.count(e.first) == 0 && history[f - 1].count(e.first) == 0) {
          want_beyond += e.second->size();
        }
      }
      beyond_same = beyond_same && served.retained_bytes_beyond(known) == want_beyond;
    }
    union_same = union_same && grc::rs::payload_union_bytes(known) ==
                                   grc::rs::payload_union_bytes_full(known);
    std::vector<grc::rs::ServeEvent> events;
    std::vector<const grc::rs::PayloadMap *> sendable = bases;
    sendable.insert(sendable.begin(), &current);
    served.pin(sendable, f, &events);
    served.retire(current, bases, f, &events);
    std::vector<std::string> want_events;
    for (const grc::rs::PayloadMap *m : sendable) {
      for (const auto &e : *m) {
        if (model.emplace(e.first, e.second).second) want_events.push_back("pin " + e.first);
      }
    }
    for (auto it = model.begin(); it != model.end();) {
      bool keep = current.count(it->first) != 0;
      for (const grc::rs::PayloadMap *b : bases) keep = keep || b->count(it->first) != 0;
      if (keep) {
        ++it;
      } else {
        want_events.push_back("retire " + it->first);
        it = model.erase(it);
      }
    }
    std::vector<std::string> got_events;
    for (const grc::rs::ServeEvent &e : events) got_events.push_back(std::string(e.op) + " " + e.hash);
    events_same = events_same && got_events == want_events && served.retained() == model.size();
  }
  check(events_same, "incremental pin/retire make the full walk's events, in its order");
  check(beyond_same, "retained_bytes_beyond over the differences equals the full walk");
  check(union_same, "payload_union_bytes over the differences equals the full walk");
  check(served.shadow_failure().empty(), "the serving oracle agrees (" + served.shadow_failure() + ")");

  // serve-skip: a map never pinned answers 404.
  grc::rs::ServedResources skip;
  skip.set_serve_skip(true);
  std::vector<grc::rs::ServeEvent> events;
  skip.pin({&history[3]}, 1, &events);
  skip.retire(history[3], {}, 1, &events);
  check(skip.retained() == 0 && skip.lookup(history[3].begin()->first) == nullptr,
        "serve-skip pins nothing of a changed map");
}

// G8kz: coded bodies of the served set (render-stream-2.md "HTTP (live)").
void test_served_coded_bodies() {
  using grc::live::Coding;
  const grc::rs::PayloadPtr big = grt1(7, 20000);
  const grc::rs::PayloadPtr tiny = grt1(7, 16);
  auto mesh_bytes = std::vector<std::uint8_t>(big->begin(), big->end());
  mesh_bytes[3] = '2';  // not a GRT1 magic
  const grc::rs::PayloadPtr other = std::make_shared<grc::rs::PayloadBytes>(std::move(mesh_bytes));
  grc::rs::ServedResources served;
  grc::rs::PayloadMap map = {{kH1, big}, {kH2, tiny}, {kH3, other}};
  std::vector<grc::rs::ServeEvent> events;
  served.pin({&map}, 1, &events);

  check(served.lookup_coded(kH1, Coding::Identity) == nullptr, "identity is never a coded body");
  const auto zstd = served.lookup_coded(kH1, Coding::Zstd);
  check(zstd != nullptr && zstd->size() < big->size() / 10, "a GRT1 payload is coded and smaller");
  std::vector<std::uint8_t> decoded;
  check(zstd != nullptr && grc::rs::http_coding::zstd_decompress(zstd->data(), zstd->size(), &decoded) &&
            decoded == *big,
        "the zstd body decodes to the identity bytes");
  check(served.lookup_coded(kH1, Coding::Zstd) == zstd, "coded once, the same body is kept");
  const auto gzip = served.lookup_coded(kH1, Coding::Gzip);
  check(gzip != nullptr && grc::rs::http_coding::gzip_decompress(gzip->data(), gzip->size(), &decoded) &&
            decoded == *big,
        "the gzip body decodes to the identity bytes");
  check(served.lookup_coded(kH2, Coding::Zstd) == nullptr, "a short body is served as is");
  check(served.lookup_coded(kH3, Coding::Zstd) == nullptr, "a payload that is not GRT1 is served as is");
  check(served.lookup_coded(std::string(64, '9'), Coding::Zstd) == nullptr, "an unknown hash has no coded body");
  grc::rs::ServedResources::Totals t = served.totals();
  check(t.coded_made == 2 && t.coded_in_bytes == 2 * big->size(), "two coded bodies made, once each");

  // wrong-hash corrupts the served copy: the coded body is of the corrupted bytes.
  served.corrupt(kH1);
  const auto after = served.lookup_coded(kH1, Coding::Zstd);
  check(after != nullptr && after != zstd, "corrupt() drops the coded cache");
  check(after != nullptr && grc::rs::http_coding::zstd_decompress(after->data(), after->size(), &decoded) &&
            decoded == *served.lookup(kH1) && decoded != *big,
        "the coded body of a corrupted copy decodes to the corrupted bytes");

  // Retirement drops the coded bodies with the hash.
  grc::rs::PayloadMap only = {{kH3, other}};
  served.retire(only, {}, 2, &events);
  check(served.lookup(kH1) == nullptr && served.lookup_coded(kH1, Coding::Zstd) == nullptr,
        "a retired hash has no coded body");
}

void test_served_resources() {
  const grc::rs::PayloadPtr p1 = grt1(1, 16);
  const grc::rs::PayloadPtr p2 = grt1(2, 16);
  const grc::rs::PayloadPtr p3 = grt1(3, 32);
  {
    ServeRig rig;
    std::vector<grc::rs::ServeEvent> e = rig.step({{kH1, p1}, {kH3, p3}});
    check(ops(e) == "pin:1:current pin:3:current ", "frame 1 pins the current payloads: " + ops(e));
    check(rig.hub.summaries().at(0).sent == 1, "seq 1 sent at frame 1");
    check(rig.served.lookup(kH1) == p1, "a pinned hash is served with the mirror's own bytes");
    check(rig.served.lookup(kH2) == nullptr, "a hash never pinned answers 404");
    // No credit: the mirror moves on (H1 superseded by H2), the base (seq 1) still names H1.
    e = rig.step({{kH2, p2}, {kH3, p3}});
    check(ops(e) == "pin:2:current ", "frame 2 pins H2 and retires nothing: " + ops(e));
    check(rig.served.lookup(kH1) == p1, "H1 stays servable while connection 1's base names it");
    check(rig.served.retained() == 3 && rig.served.retained_bytes() == 2 * 34 + 50,
          "retained = current + base: 3 hashes");
    // Credit: seq 2 (H2, H3) goes out; H1 is named by nothing any more.
    rig.applied(1);
    e = rig.step({{kH2, p2}, {kH3, p3}});
    check(rig.hub.summaries().at(0).sent == 2, "seq 2 sent at frame 3");
    check(ops(e) == "retire:1:superseded ", "frame 3 retires H1: " + ops(e));
    check(rig.served.lookup(kH1) == nullptr, "a retired hash answers 404");
    const grc::rs::ServedResources::Totals t = rig.served.totals();
    check(t.pinned == 3 && t.retired == 1 && t.retained_max == 3, "totals pinned 3, retired 1");
    // GET attribution: the streaming connection counts it and logs it.
    check(rig.hub.on_http_get(kH2, 200, 34, 5000, rig.frame) == 1, "a GET is attributed to 1");
    check(rig.hub.on_http_get(kH1, 404, 0, 6000, rig.frame) == 1, "so is a 404");
    const ConnectionSummary s = rig.hub.summaries().at(0);
    check(s.http_gets == 2 && s.http_bytes == 34 && s.http_errors == 1,
          "summary http_gets 2, http_bytes 34, http_errors 1");
    // A closed connection pins nothing: its base no longer keeps H2 once the mirror drops it.
    rig.hub.on_event(closed(1, 1000), rig.frame);
    check(rig.hub.base_payloads().empty(), "a closed connection has no base pin");
    e = rig.step({{kH3, p3}});
    check(ops(e) == "retire:2:superseded ", "after the close H2 is retired: " + ops(e));
    check(rig.hub.on_http_get(kH3, 200, 50, 7000, rig.frame) == 0,
          "a GET with no connection streaming is attributed to none");
  }
  {
    // unpin from frame 2: the base no longer protects H1.
    ServeRig rig;
    rig.served.set_unpin_frame(2);
    rig.step({{kH1, p1}});
    const std::vector<grc::rs::ServeEvent> e = rig.step({{kH2, p2}});
    check(ops(e) == "pin:2:current retire:1:unpin ", "unpin retires a base-named hash: " + ops(e));
    check(rig.served.lookup(kH1) == nullptr && rig.served.totals().retired_unpinned == 1,
          "unpin: H1 answers 404 although seq 1 names it");
  }
  {
    // drop-resource from frame 2: the first hash first pinned at or after it answers 404.
    ServeRig rig;
    rig.served.set_drop_frame(2);
    rig.step({{kH1, p1}});
    const std::vector<grc::rs::ServeEvent> e = rig.step({{kH1, p1}, {kH2, p2}});
    check(ops(e) == "pin:2:current! ", "drop-resource marks H2's pin: " + ops(e));
    check(rig.served.lookup(kH2) == nullptr && rig.served.retained_hashes().count(kH2) == 1,
          "drop-resource: H2 is retained but answers 404");
    check(rig.served.lookup(kH1) == p1, "drop-resource: hashes pinned earlier are still served");
    rig.step({{kH1, p1}, {kH2, p2}, {kH3, p3}});
    check(rig.served.lookup(kH3) == p3 && rig.served.dropped_hash() == kH2,
          "drop-resource drops exactly one hash");
  }
  {
    // retain-superseded from frame 2 (G6s): nothing is ever retired again, so H1 (superseded by
    // H2 at frame 2, named by no base) stays servable instead of being retired, and the retained
    // set keeps growing as content keeps changing.
    ServeRig rig;
    rig.served.set_retain_superseded_frame(2);
    rig.step({{kH1, p1}});
    rig.applied(1);
    std::vector<grc::rs::ServeEvent> e = rig.step({{kH2, p2}});
    check(ops(e) == "pin:2:current ", "retain-superseded still pins the new hash: " + ops(e));
    check(rig.served.lookup(kH1) == p1,
          "retain-superseded: H1 answers even though nothing names it any more");
    check(rig.served.retained() == 2, "retained grows: H1 and H2 both still servable");
    rig.applied(2);
    e = rig.step({{kH3, p3}});
    check(ops(e) == "pin:3:current ", "retain-superseded pins a third hash: " + ops(e));
    check(rig.served.retained() == 3 && rig.served.lookup(kH1) == p1 && rig.served.lookup(kH2) == p2,
          "retain-superseded never retires: three hashes now servable at once");
  }
  {
    // wrong-hash: the corrupted hash is served with its first data byte flipped.
    ServeRig rig;
    rig.served.corrupt(kH1);
    rig.step({{kH1, p1}, {kH2, p2}});
    const grc::rs::PayloadPtr served = rig.served.lookup(kH1);
    check(served != nullptr && served->size() == p1->size() && (*served)[18] == (1 ^ 0xFF) &&
              (*served)[19] == 1 && (*p1)[18] == 1,
          "corrupt(): first data byte flipped, the mirror's bytes untouched");
    check(rig.served.lookup(kH2) == p2, "corrupt() touches one hash only");
  }
}

// ----------------------------------------------------------------- G7n: /6 and /7 per connection

const std::string kToken = std::string(64, 'c');

// A /7 hello (render-stream-7.md "Hello"); `token` is the JSON literal (a quoted string or null).
std::string hello7(const std::string &token, int window = 1, const char *kind = "gsw-canvas") {
  return std::string(R"({"type":"hello","protocol":"render-stream/7","receiver":"browser","receiver_kind":")") +
         kind + R"(","credit_stage":"submitted","credit_window":)" + std::to_string(window) +
         R"(,"inbound_buffer_bytes":16777216,"token":)" + token +
         R"(,"manifest_sha256":")" + std::string(64, 'e') +
         R"(","presentation_backing_w":640,"presentation_backing_h":360,"presentation_css_w":640,"presentation_css_h":360,"dpr_milli":1000})";
}
const std::string kHello6 =
    R"({"type":"hello","protocol":"render-stream/6","receiver":"native","credit_stage":"submitted","inbound_buffer_bytes":16777216})";

LiveEvent opened_with(std::uint32_t conn, const std::string &subprotocol,
                      const std::string &origin = std::string()) {
  LiveEvent e = opened(conn);
  e.subprotocol = subprotocol;
  e.origin = origin;
  return e;
}

Session template_v6() {
  Session tmpl = make_template();
  tmpl.version = ProtocolVersion::V6;
  return tmpl;
}

Captured captured_v6() {
  Captured c = captured_state(1);
  c.state.version = ProtocolVersion::V6;
  return c;
}

void frame_once(Hub &hub, std::uint64_t frame) {
  const Captured snapshot = captured_v6();
  const std::uint64_t now = frame * 16000000ULL;
  hub.on_frame(frame, now, hub.wants_snapshot(frame, now) ? &snapshot : nullptr, 1, 1000);
}

std::vector<Sent> of_conn(const FakeTransport &t, Sent::Kind kind, std::uint32_t conn) {
  std::vector<Sent> out;
  for (const Sent &s : t.of(kind)) {
    if (s.conn == conn) {
      out.push_back(s);
    }
  }
  return out;
}

// gate7-design.md Q3 "Two subprotocols on one listener": a /6 and a /7 connection on one hub,
// served from one snapshot; each gets its own magic, protocol string and hello shape; a /7
// connection's publication declares the grant (asked 2 under a maximum of 2: 2, since G7q).
void test_v6_and_v7_on_one_hub() {
  FakeTransport transport;
  LiveConfig config;
  config.credit_window_max = 2;  // the env allows 2, so a hello asking 2 is granted 2 (G7q)
  Hub hub(&transport, config, template_v6());
  hub.on_event(opened_with(1, "render-stream.6"), 0);
  hub.on_event(opened_with(2, "render-stream.7", "http://127.0.0.1:5173"), 0);
  hub.on_event(text(1, kHello6), 0);
  hub.on_event(text(2, hello7("null", 2)), 0);
  frame_once(hub, 1);
  const std::vector<Sent> b6 = of_conn(transport, Sent::Binary, 1);
  const std::vector<Sent> b7 = of_conn(transport, Sent::Binary, 2);
  check(b6.size() == 2 && b7.size() == 2, "both connections got the session and seq 1");
  if (b6.size() == 2 && b7.size() == 2) {
    const std::vector<std::uint8_t> m6 = magic(ProtocolVersion::V6);
    const std::vector<std::uint8_t> m7 = magic(ProtocolVersion::V7);
    check(std::equal(m6.begin(), m6.end(), b6[0].bytes.begin()), "the /6 connection starts GRS6");
    check(std::equal(m7.begin(), m7.end(), b7[0].bytes.begin()), "the /7 connection starts GRS7");
    const std::string s6 = meta_at(b6[0].bytes, 8);
    const std::string s7 = meta_at(b7[0].bytes, 8);
    check(has(s6, "\"protocol\":\"render-stream/6\"") && !has(s6, "credit_window"),
          "the /6 session is /6's, with no credit_window: " + s6.substr(0, 60));
    check(has(s7, "\"protocol\":\"render-stream/7\"") &&
              has(s7, "\"publication\":{\"mode\":\"every-frame\",\"target_fps\":null,\"credit_window\":2}"),
          "the /7 session declares publication.credit_window 2 (asked 2, max 2, G7q)");
    check(b6[1].bytes == b7[1].bytes,
          "seq 1 is byte-identical on /6 and /7 (render-stream-7.md: records are /6's)");
  }
  const std::vector<ConnectionSummary> sums = hub.summaries();
  check(sums.size() == 2 && sums[0].version == 6 && sums[1].version == 7, "versions 6 and 7");
  if (sums.size() == 2) {
    check(!sums[0].has_hello7 && sums[0].receiver_kind.empty() && sums[0].credit_window == 1 &&
              sums[0].origin.empty() && !sums[0].token_checked,
          "the /6 summary has no /7 hello, window 1, no origin, token not checked");
    check(sums[1].has_hello7 && sums[1].receiver_kind == "gsw-canvas" &&
              sums[1].credit_window_requested == 2 && sums[1].credit_window == 2 &&
              sums[1].manifest_sha256 == std::string(64, 'e') &&
              sums[1].presentation_backing_w == 640 && sums[1].dpr_milli == 1000 &&
              sums[1].origin == "http://127.0.0.1:5173" && !sums[1].token_checked,
          "the /7 summary records the hello, the grant and the origin");
  }
  const std::string json = hub.summary_json();
  check(has(json, "\"version\": 7") && has(json, "\"receiver_kind\": \"gsw-canvas\"") &&
            has(json, "\"credit_window_requested\": 2") &&
            has(json, "\"origin\": \"http://127.0.0.1:5173\"") && has(json, "\"token_ok\": null") &&
            has(json, "\"preflights\": 0") && has(json, "\"presentation_css_w\": 640"),
        "live-summary.json carries the G7n per-connection fields");
  // Each connection still wants its own hello: the other version's is a protocol error.
  {
    FakeTransport t2;
    Hub h2(&t2, LiveConfig(), template_v6());
    h2.on_event(opened_with(1, "render-stream.7"), 0);
    h2.on_event(text(1, kHello6), 0);
    h2.on_event(opened_with(2, "render-stream.6"), 0);
    h2.on_event(text(2, hello7("null")), 0);
    const std::vector<Sent> closes = t2.of(Sent::Close);
    check(closes.size() == 2 && closes[0].code == 1002 && closes[1].code == 1002,
          "a /6 hello on a /7 connection and a /7 hello on a /6 connection close 1002");
    check(t2.of(Sent::Binary).empty(), "and nothing was streamed to either");
  }
  // A /7 hello asking for window 3 is a protocol error (parse_control's 1..2 range).
  {
    FakeTransport t3;
    Hub h3(&t3, LiveConfig(), template_v6());
    h3.on_event(opened_with(1, "render-stream.7"), 0);
    h3.on_event(text(1, hello7("null", 3)), 0);
    const std::vector<Sent> texts = t3.of(Sent::Text);
    check(texts.size() == 1 && has(texts[0].text, "\"reason\":\"protocol\"") &&
              t3.of(Sent::Close).size() == 1 && t3.of(Sent::Close)[0].code == 1002,
          "credit_window 3 -> error protocol, close 1002");
  }
}

// G8w (gate8-design.md D2, render-stream-8.md "Live transport"): render-stream.8 makes a connection
// /8 -- the GRS8 magic, the /8 session (adoption, resources.decode) and /7's hello shape under the
// protocol string render-stream/8. A /6 connection on a /8-templated hub still speaks /6, and each
// version's hello is a protocol error on the other's connection.
void test_v8_connection() {
  Session tmpl = template_v6();
  tmpl.version = ProtocolVersion::V8;
  tmpl.adoption.present = true;
  tmpl.adoption.frame = 7;
  tmpl.resources.decode = TextureDecode::Engine;
  FakeTransport transport;
  LiveConfig config;
  config.credit_window_max = 2;
  Hub hub(&transport, config, tmpl);
  hub.on_event(opened_with(1, "render-stream.6"), 0);
  hub.on_event(opened_with(2, "render-stream.8", "http://127.0.0.1:5173"), 0);
  hub.on_event(opened_with(3, "render-stream.7"), 0);
  const auto hello8 = [](const std::string &token, int window) {
    std::string text = hello7(token, window);
    const std::string from = "render-stream/7";
    text.replace(text.find(from), from.size(), "render-stream/8");
    return text;
  };
  hub.on_event(text(1, kHello6), 0);
  hub.on_event(text(2, hello8("null", 2)), 0);
  hub.on_event(text(3, hello7("null", 1)), 0);
  Captured snapshot = captured_v6();
  hub.on_frame(1, 16000000ULL, hub.wants_snapshot(1, 16000000ULL) ? &snapshot : nullptr, 1, 1000);
  const std::vector<Sent> b6 = of_conn(transport, Sent::Binary, 1);
  const std::vector<Sent> b8 = of_conn(transport, Sent::Binary, 2);
  const std::vector<Sent> b7 = of_conn(transport, Sent::Binary, 3);
  check(b6.size() == 2 && b8.size() == 2 && b7.size() == 2, "all three versions got session + seq 1");
  if (b6.size() == 2 && b8.size() == 2 && b7.size() == 2) {
    const std::vector<std::uint8_t> m8 = magic(ProtocolVersion::V8);
    check(std::equal(m8.begin(), m8.end(), b8[0].bytes.begin()), "the /8 connection starts GRS8");
    const std::string s6 = meta_at(b6[0].bytes, 8);
    const std::string s7 = meta_at(b7[0].bytes, 8);
    const std::string s8 = meta_at(b8[0].bytes, 8);
    check(has(s8, "\"protocol\":\"render-stream/8\"") &&
              has(s8, "\"adoption\":{\"mode\":\"arm\",\"frame\":7}") &&
              has(s8, "\"decode\":\"engine\"") &&
              has(s8, "\"credit_window\":2"),
          "the /8 session declares adoption, decode and the granted window: " + s8.substr(0, 60));
    check(has(s6, "\"protocol\":\"render-stream/6\"") && !has(s6, "adoption") && !has(s6, "decode"),
          "a /6 connection on a /8 template still speaks /6, with no /8 key");
    check(has(s7, "\"protocol\":\"render-stream/7\"") && !has(s7, "adoption") && !has(s7, "decode"),
          "a /7 connection on a /8 template still speaks /7, with no /8 key");
    check(b8[1].bytes.size() > 8 && has(meta_at(b8[1].bytes, 0), "\"type\":\"transaction\""),
          "the /8 connection's seq 1 is a transaction");
  }
  const std::vector<ConnectionSummary> sums = hub.summaries();
  check(sums.size() == 3 && sums[0].version == 6 && sums[1].version == 8 && sums[2].version == 7,
        "versions 6, 8 and 7");
  if (sums.size() == 3) {
    check(sums[1].has_hello7 && sums[1].credit_window == 2 && sums[1].receiver_kind == "gsw-canvas",
          "a /8 summary records /7's hello fields");
  }
  {
    FakeTransport t2;
    Hub h2(&t2, LiveConfig(), tmpl);
    h2.on_event(opened_with(1, "render-stream.8"), 0);
    h2.on_event(text(1, hello7("null")), 0);
    const std::vector<Sent> closes = t2.of(Sent::Close);
    check(closes.size() == 1 && closes[0].code == 1002 && t2.of(Sent::Binary).empty(),
          "a /7 hello on a /8 connection closes 1002 with nothing streamed");
  }
  {
    // A /8 hello is refused by the V7 parser, as a /7 hello is by the V8 parser.
    ControlMessage m;
    std::string h8 = hello7("null");
    const std::string from = "render-stream/7";
    h8.replace(h8.find(from), from.size(), "render-stream/8");
    check(parse_control(h8, &m, nullptr, ProtocolVersion::V8) &&
              m.protocol == "render-stream/8" && m.receiver_kind == "gsw-canvas",
          "parse_control(V8) accepts a /8 hello");
    check(!parse_control(h8, &m, nullptr, ProtocolVersion::V7), "parse_control(V7) refuses a /8 hello");
    check(!parse_control(hello7("null"), &m, nullptr, ProtocolVersion::V8),
          "parse_control(V8) refuses a /7 hello");
  }
}

// G8k9 (render-stream-9.md "Live transport", "Hello"): /9 is /8's live transport plus the hello keys
// texture_encodings and gpu_formats. golden-9/control/ holds the vectors; the same files are parsed
// independently by self-test-rs2.ts. A /9 connection gets the GRS9 magic and a /9 session; /6, /7
// and /8 connections on a /9 template still speak their own version.
void test_v9_connection() {
  const std::string root = std::string(GRC_GOLDEN9_DIR) + "/control";
  const std::vector<std::string> valid = list_dir(root + "/valid");
  const std::vector<std::string> invalid = list_dir(root + "/invalid");
  check(valid.size() == 4, "4 valid golden-9 control vectors (got " + std::to_string(valid.size()) + ")");
  check(invalid.size() == 10,
        "10 invalid golden-9 control vectors (got " + std::to_string(invalid.size()) + ")");
  for (const std::string &path : valid) {
    ControlMessage m;
    std::string error;
    check(parse_control(read_file(path), &m, &error, ProtocolVersion::V9),
          "valid golden-9 control parses as V9: " + path + " " + error);
  }
  for (const std::string &path : invalid) {
    ControlMessage m;
    std::string error;
    check(!parse_control(read_file(path), &m, &error, ProtocolVersion::V9),
          "invalid golden-9 control refused as V9: " + path);
    check(!error.empty(), "invalid golden-9 control has an error text: " + path);
  }
  ControlMessage m;
  check(parse_control(read_file(root + "/valid/hello-native-block.json"), &m, nullptr,
                       ProtocolVersion::V9) &&
            m.protocol == "render-stream/9" && m.texture_encodings == "block,decoded" &&
            m.gpu_formats == "s3tc,bptc,rgtc" && m.receiver_kind == "native",
        "hello-native-block fields");
  check(!parse_control(read_file(root + "/valid/hello-native-block.json"), &m, nullptr,
                        ProtocolVersion::V8),
        "a /9 hello is refused by the V8 parser");
  check(!parse_control(hello7("null"), &m, nullptr, ProtocolVersion::V9),
        "a /7 hello is refused by the V9 parser");

  Session tmpl = template_v6();
  tmpl.version = ProtocolVersion::V9;
  tmpl.adoption.present = true;
  tmpl.adoption.frame = 7;
  tmpl.resources.decode = TextureDecode::Engine;
  tmpl.resources.texture_delivery.mode = "passthrough";
  FakeTransport transport;
  LiveConfig config;
  config.credit_window_max = 2;
  Hub hub(&transport, config, tmpl);
  hub.on_event(opened_with(1, "render-stream.6"), 0);
  hub.on_event(opened_with(2, "render-stream.9", "http://127.0.0.1:5173"), 0);
  hub.on_event(opened_with(3, "render-stream.8"), 0);
  hub.on_event(text(1, kHello6), 0);
  hub.on_event(text(2, read_file(root + "/valid/hello-native-block.json")), 0);
  const auto hello8 = [] {
    std::string t = hello7("null", 1);
    const std::string from = "render-stream/7";
    t.replace(t.find(from), from.size(), "render-stream/8");
    return t;
  };
  hub.on_event(text(3, hello8()), 0);
  Captured snapshot = captured_v6();
  hub.on_frame(1, 16000000ULL, hub.wants_snapshot(1, 16000000ULL) ? &snapshot : nullptr, 1, 1000);
  const std::vector<Sent> b6 = of_conn(transport, Sent::Binary, 1);
  const std::vector<Sent> b9 = of_conn(transport, Sent::Binary, 2);
  const std::vector<Sent> b8 = of_conn(transport, Sent::Binary, 3);
  check(b6.size() == 2 && b9.size() == 2 && b8.size() == 2, "all three versions got session + seq 1");
  if (b6.size() == 2 && b9.size() == 2 && b8.size() == 2) {
    const std::vector<std::uint8_t> m9 = magic(ProtocolVersion::V9);
    check(std::equal(m9.begin(), m9.end(), b9[0].bytes.begin()), "the /9 connection starts GRS9");
    const std::string s9 = meta_at(b9[0].bytes, 8);
    const std::string s8 = meta_at(b8[0].bytes, 8);
    check(has(s9, "\"protocol\":\"render-stream/9\"") &&
              has(s9, "\"texture_delivery\":{\"mode\":\"passthrough\",\"encoder\":null}") &&
              has(s9, "\"adoption\":{\"mode\":\"arm\",\"frame\":7}"),
          "the /9 session declares texture_delivery: " + s9.substr(0, 60));
    check(has(s8, "\"protocol\":\"render-stream/8\"") && !has(s8, "texture_delivery"),
          "a /8 connection on a /9 template still speaks /8, with no /9 key");
    check(!has(meta_at(b6[0].bytes, 8), "texture_delivery"), "a /6 connection has no /9 key");
    check(has(meta_at(b9[1].bytes, 0), "\"variants\":[]"),
          "a /9 texture entry carries an empty variants list");
  }
  const std::vector<ConnectionSummary> sums = hub.summaries();
  check(sums.size() == 3 && sums[0].version == 6 && sums[1].version == 9 && sums[2].version == 8,
        "versions 6, 9 and 8");
  if (sums.size() == 3) {
    check(sums[1].texture_encodings == "block,decoded" && sums[1].gpu_formats == "s3tc,bptc,rgtc",
          "a /9 summary records the hello's delivery preferences");
    check(sums[2].texture_encodings.empty(), "a /8 summary records none");
  }
  {
    FakeTransport t2;
    Hub h2(&t2, LiveConfig(), tmpl);
    h2.on_event(opened_with(1, "render-stream.9"), 0);
    h2.on_event(text(1, hello8()), 0);
    const std::vector<Sent> closes = t2.of(Sent::Close);
    check(closes.size() == 1 && closes[0].code == 1002 && t2.of(Sent::Binary).empty(),
          "a /8 hello on a /9 connection closes 1002 with nothing streamed");
  }
}

// CG1 (render-stream-10.md "Live transport"): /10 is /9's live transport and hello under
// "render-stream/10". golden-10/control/ holds the vectors (a /10 hello; a /9 hello, which a /10
// connection refuses). A /10 connection gets the GRSA magic, a /10 session whose unobserved list
// lacks the two hooked setters, and items carrying canvas_group / copy_to_backbuffer; a /9
// connection on the same /10 host gets its own session (both setters unobserved, no item key).
void test_v10_connection() {
  const std::string root = std::string(GRC_GOLDEN10_DIR) + "/control";
  const std::vector<std::string> valid = list_dir(root + "/valid");
  const std::vector<std::string> invalid = list_dir(root + "/invalid");
  check(!valid.empty() && !invalid.empty(), "golden-10 control vectors exist");
  for (const std::string &path : valid) {
    ControlMessage m;
    std::string error;
    check(parse_control(read_file(path), &m, &error, ProtocolVersion::V10),
          "valid golden-10 control parses as V10: " + path + " " + error);
    check(!parse_control(read_file(path), &m, &error, ProtocolVersion::V9),
          "a golden-10 hello is refused by the V9 parser: " + path);
  }
  for (const std::string &path : invalid) {
    ControlMessage m;
    std::string error;
    check(!parse_control(read_file(path), &m, &error, ProtocolVersion::V10),
          "invalid golden-10 control refused as V10: " + path);
  }
  const std::string hello10 = read_file(root + "/valid/hello-native-block.json");
  ControlMessage m;
  check(parse_control(hello10, &m, nullptr, ProtocolVersion::V10) &&
            m.protocol == "render-stream/10" && !m.texture_encodings.empty(),
        "the /10 hello carries /9's keys under render-stream/10");
  const std::string hello9 = read_file(std::string(GRC_GOLDEN9_DIR) +
                                       "/control/valid/hello-native-block.json");
  check(!parse_control(hello9, &m, nullptr, ProtocolVersion::V10),
        "a /9 hello is refused by the V10 parser");

  Session tmpl = template_v6();
  tmpl.version = ProtocolVersion::V10;
  tmpl.features = gate2_features(false, ProtocolVersion::V6);
  tmpl.capture.hooks_planned.push_back("canvas_item_set_canvas_group_mode");
  tmpl.capture.hooks_planned.push_back("canvas_item_set_copy_to_backbuffer");
  observe_planned_backbuffer_setters(&tmpl.features, tmpl.capture.hooks_planned);
  const auto listed = [](const Session &s, const char *name) {
    return std::find(s.features.unobserved.begin(), s.features.unobserved.end(), name) !=
           s.features.unobserved.end();
  };
  check(!listed(tmpl, "canvas_item_set_canvas_group_mode") &&
            !listed(tmpl, "canvas_item_set_copy_to_backbuffer") &&
            std::is_sorted(tmpl.features.unobserved.begin(), tmpl.features.unobserved.end()),
        "a /10 template planning both hooks declares neither setter unobserved");
  FakeTransport transport;
  LiveConfig config;
  Hub hub(&transport, config, tmpl);
  hub.on_event(opened_with(1, "render-stream.10"), 0);
  hub.on_event(opened_with(2, "render-stream.9"), 0);
  hub.on_event(text(1, hello10), 0);
  hub.on_event(text(2, hello9), 0);
  Captured snapshot = captured_v6();
  check(!snapshot.state.items.empty(), "the captured state has an item");
  if (!snapshot.state.items.empty()) {
    snapshot.state.items.mut(0).canvas_group.mode = CanvasGroupMode::ClipOnly;
    snapshot.state.items.mut(0).canvas_group.clear_margin = 5.0f;
    snapshot.state.items.mut(0).copy_to_backbuffer = true;
  }
  hub.on_frame(1, 16000000ULL, hub.wants_snapshot(1, 16000000ULL) ? &snapshot : nullptr, 1, 1000);
  const std::vector<Sent> b10 = of_conn(transport, Sent::Binary, 1);
  const std::vector<Sent> b9 = of_conn(transport, Sent::Binary, 2);
  check(b10.size() == 2 && b9.size() == 2, "both versions got session + seq 1");
  if (b10.size() == 2 && b9.size() == 2) {
    const std::vector<std::uint8_t> m10 = magic(ProtocolVersion::V10);
    check(std::equal(m10.begin(), m10.end(), b10[0].bytes.begin()),
          "the /10 connection starts GRSA");
    const std::vector<std::uint8_t> m9 = magic(ProtocolVersion::V9);
    check(std::equal(m9.begin(), m9.end(), b9[0].bytes.begin()), "the /9 connection starts GRS9");
    const std::string s10 = meta_at(b10[0].bytes, 8);
    const std::string s9 = meta_at(b9[0].bytes, 8);
    check(has(s10, "\"protocol\":\"render-stream/10\"") && has(s10, "\"texture_delivery\":"),
          "the /10 session: render-stream/10, /9's keys");
    check(has(s9, "\"protocol\":\"render-stream/9\"") &&
              has(s9, "\"unobserved\":[\"canvas_item_set_canvas_group_mode\",") &&
              has(s9, "\"canvas_item_set_copy_to_backbuffer\""),
          "a /9 connection on a /10 host still declares both setters unobserved");
    const std::size_t unobserved10 = s10.find("\"unobserved\":");
    check(unobserved10 != std::string::npos &&
              s10.find("canvas_item_set_canvas_group_mode", unobserved10) == std::string::npos &&
              s10.find("canvas_item_set_copy_to_backbuffer", unobserved10) == std::string::npos,
          "the /10 session's unobserved list names neither setter");
    const std::string t10 = meta_at(b10[1].bytes, 0);
    const std::string t9 = meta_at(b9[1].bytes, 0);
    check(has(t10, "\"canvas_group\":{\"mode\":\"clip_only\",\"fit_empty\":false,"
                   "\"blur_mipmaps\":false,\"f\":0},\"copy_to_backbuffer\":{\"f\":2}") &&
              has(t10, "\"name\":\"backbuffer_f32\",\"type\":\"f32\",\"count\":6}"),
          "a /10 transaction carries the item's back-buffer state");
    check(!has(t9, "canvas_group") && !has(t9, "backbuffer"),
          "a /9 transaction on the same host carries none of it");
  }
  const std::vector<ConnectionSummary> sums = hub.summaries();
  check(sums.size() == 2 && sums[0].version == 10 && sums[1].version == 9, "versions 10 and 9");
  if (sums.size() == 2) {
    check(!sums[0].texture_encodings.empty(), "a /10 summary records the hello's preferences");
  }
  {
    FakeTransport t2;
    Hub h2(&t2, LiveConfig(), tmpl);
    h2.on_event(opened_with(1, "render-stream.10"), 0);
    h2.on_event(text(1, hello9), 0);
    const std::vector<Sent> closes = t2.of(Sent::Close);
    check(closes.size() == 1 && closes[0].code == 1002 && t2.of(Sent::Binary).empty(),
          "a /9 hello on a /10 connection closes 1002 with nothing streamed");
  }
  {
    FakeTransport t3;
    Hub h3(&t3, LiveConfig(), tmpl);
    h3.on_event(opened_with(1, "render-stream.9"), 0);
    h3.on_event(text(1, hello10), 0);
    const std::vector<Sent> closes = t3.of(Sent::Close);
    check(closes.size() == 1 && closes[0].code == 1002 && t3.of(Sent::Binary).empty(),
          "a /10 hello on a /9 connection closes 1002 with nothing streamed");
  }
}

// gate7-design.md D3, Q2 "Host behaviour on the hello": on a bearer session a /7 hello whose
// token is null or wrong is `error` unauthorized + close 1008 "unauthorized", with nothing sent
// before or after; the right token streams. token-ignored lets the wrong one through but still
// records token_ok false. A /6 connection on a bearer session passed the upgrade check.
void test_v7_hello_token() {
  for (const char *token : {"null", "\"ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff\""}) {
    FakeTransport transport;
    LiveConfig config;
    config.auth_token = kToken;
    Hub hub(&transport, config, template_v6());
    hub.on_event(opened_with(4, "render-stream.7"), 0);
    frame_once(hub, 1);
    check(transport.sent.empty(), "a bearer /7 connection is sent nothing before its hello");
    hub.on_event(text(4, hello7(token)), 0);
    frame_once(hub, 2);
    frame_once(hub, 3);
    const std::vector<Sent> texts = transport.of(Sent::Text);
    const std::vector<Sent> closes = transport.of(Sent::Close);
    check(texts.size() == 1 && has(texts[0].text, "\"type\":\"error\"") &&
              has(texts[0].text, "\"reason\":\"unauthorized\""),
          std::string("token ") + token + " -> one error unauthorized");
    check(closes.size() == 1 && closes[0].code == 1008 && closes[0].text == "unauthorized",
          std::string("token ") + token + " -> close 1008 with reason unauthorized");
    check(transport.of(Sent::Binary).empty(), "nothing binary is ever sent after a refusal");
    const ConnectionSummary s = hub.summaries().at(0);
    check(s.token_checked && !s.token_ok && s.error_sent == "unauthorized" && s.close_code == 1008,
          "the summary records token_ok false, error unauthorized, close 1008");
    check(has(hub.summary_json(), "\"token_ok\": false"), "live-summary.json token_ok false");
    check(!has(hub.summary_json(), kToken), "the token never reaches the summary");
  }
  {
    FakeTransport transport;
    LiveConfig config;
    config.auth_token = kToken;
    config.tap_dir = std::string(GRC_TEST_TMP_DIR) + "/g7n-token";
    Hub hub(&transport, config, template_v6());
    hub.on_event(opened_with(4, "render-stream.7"), 0);
    hub.on_event(text(4, hello7("\"" + kToken + "\"")), 0);
    frame_once(hub, 1);
    check(transport.of(Sent::Binary).size() == 2 && transport.of(Sent::Close).empty(),
          "the right token streams the session and seq 1");
    check(hub.summaries().at(0).token_checked && hub.summaries().at(0).token_ok, "token_ok true");
    hub.finish(EndReason::Shutdown, 2, 32000000ULL);
    hub.close_open(2);
    const std::string log = read_file(config.tap_dir + "/live-1.jsonl");
    check(has(log, "\"token_ok\":true") && has(log, "\"receiver_kind\":\"gsw-canvas\"") &&
              has(log, "\"credit_window_granted\":1") && !has(log, kToken),
          "the hello line records every key but the token, plus token_ok");
  }
  {
    FakeTransport transport;
    LiveConfig config;
    config.auth_token = kToken;
    config.token_ignored = true;
    Hub hub(&transport, config, template_v6());
    hub.on_event(opened_with(4, "render-stream.7"), 0);
    hub.on_event(text(4, hello7("null")), 0);
    frame_once(hub, 1);
    check(transport.of(Sent::Binary).size() == 2 && transport.of(Sent::Close).empty(),
          "token-ignored: a null token streams anyway");
    check(hub.summaries().at(0).token_checked && !hub.summaries().at(0).token_ok,
          "token-ignored still records token_ok false");
  }
  {
    FakeTransport transport;
    LiveConfig config;
    config.auth_token = kToken;
    Hub hub(&transport, config, template_v6());
    hub.on_event(opened_with(4, "render-stream.6"), 0);
    hub.on_event(text(4, kHello6), 0);
    frame_once(hub, 1);
    check(transport.of(Sent::Binary).size() == 2, "a /6 connection on a bearer session streams");
    check(hub.summaries().at(0).token_checked && hub.summaries().at(0).token_ok,
          "a /6 connection's token_ok is the upgrade check it passed");
  }
  {
    // No session auth: a /7 token is not checked at all (token_ok null), whatever it holds.
    FakeTransport transport;
    Hub hub(&transport, LiveConfig(), template_v6());
    hub.on_event(opened_with(4, "render-stream.7"), 0);
    hub.on_event(text(4, hello7("\"" + std::string(64, '1') + "\"")), 0);
    frame_once(hub, 1);
    check(transport.of(Sent::Binary).size() == 2 && !hub.summaries().at(0).token_checked,
          "no session auth: the /7 token is not checked");
  }
}

// gate7-design.md Q3 "Evidence": a preflight is counted in `preflights`, never `http_gets`.
void test_preflight_attribution() {
  FakeTransport transport;
  LiveConfig config;
  config.tap_dir = std::string(GRC_TEST_TMP_DIR) + "/g7n-preflight";
  Hub hub(&transport, config, template_v6());
  hub.on_event(opened_with(1, "render-stream.7", "http://127.0.0.1:5173"), 0);
  hub.on_event(text(1, hello7("null")), 0);
  frame_once(hub, 1);
  const std::string hash(64, 'a');
  check(hub.on_http_get(hash, 204, 0, 5000, 1, /*preflight=*/true) == 1, "attributed to conn 1");
  hub.on_http_get(hash, 200, 10, 6000, 1);
  const ConnectionSummary s = hub.summaries().at(0);
  check(s.preflights == 1 && s.http_gets == 1 && s.http_bytes == 10 && s.http_errors == 0,
        "one preflight and one GET, counted apart");
  hub.finish(EndReason::Shutdown, 2, 32000000ULL);
  hub.close_open(2);
  const std::string log = read_file(config.tap_dir + "/live-1.jsonl");
  check(has(log, "\"event\":\"preflight\"") && has(log, "\"event\":\"http-get\"") &&
            has(log, "\"version\":7") && has(log, "\"origin\":\"http://127.0.0.1:5173\""),
        "the live log has a preflight line, an http-get line and the open line's version/origin");
}

// W11a (render-stream-11.md "Resource retention", L2): at /11 the records a stream sends before a
// target T are a function of (B, T) alone -- inline(T) \ inline(B), in table order -- so the host
// keeps no per-connection carried set. Not wired into the hub yet (W11b); rs_carried stays for
// /6-/10. Two histories reaching the same B give the same records for T; a validator replaying
// either stream under /11's rules (resource-duplicate if h is in C, resource-missing unless
// required(S) is in C, then C <- C n names(S)) accepts it and ends every transaction with
// C = inline(S); and a hash that leaves and returns is re-carried at /11 but never under
// keep-carried (/10's lifelong set), whose stream then fails resource-missing.
void test_records_from_base_and_target() {
  const auto hash = [](char c) { return std::string(64, c); };
  // A state naming textures 1..3 (by hash, '-' for none), a static mesh and a dynamic one.
  const auto state = [&](std::uint64_t seq, const std::string &textures, char mesh) {
    Snapshot s;
    s.version = ProtocolVersion::V11;
    s.seq = seq;
    s.frame = seq;
    for (std::size_t i = 0; i < textures.size(); ++i) {
      if (textures[i] == '-') {
        continue;
      }
      TextureEntry t = golden::texture_a(seq, hash(textures[i]));
      t.id = static_cast<std::uint32_t>(i + 1);
      t.payload_bytes = textures[i] >= 'f' ? 1000 : 100;  // 'f' and above are out-of-band
      s.textures.push_back(t);
    }
    MeshEntry stat = golden::mesh_entry(
        MeshStatus::Ok, 1,
        {golden::mesh_surface(hash(mesh), 256, Primitive::Triangles, golden::kMesh1SurfaceAFormat,
                              3, 0)});
    stat.id = 1;
    MeshEntry dyn = golden::mesh_entry(
        MeshStatus::Ok, seq,
        {golden::mesh_surface("", 40, Primitive::Triangles, golden::kMesh1SurfaceAFormat, 3, 0)});
    dyn.id = 2;
    dyn.dynamic = true;
    dyn.content_serial = seq;
    dyn.surfaces[0].body = std::make_shared<const std::vector<std::uint8_t>>(40, std::uint8_t(seq));
    s.meshes = {stat, dyn};
    return s;
  };
  InlinePolicy policy;
  policy.inline_max_bytes = 300;
  const auto hashes = [](const std::vector<PayloadName> &names) {
    std::vector<std::string> out;
    for (const PayloadName &n : names) {
      out.push_back(n.hash);
    }
    return out;
  };
  // Replays one stream's records and transactions under /11's validator rules.
  const auto replay = [&](const std::vector<Snapshot> &states, bool keep_carried,
                          std::vector<std::string> *last_records) {
    RecordPlanner planner(ProtocolVersion::V11, policy, keep_carried);
    std::vector<std::string> carried;  // C, sorted
    bool ok = true;
    const Snapshot *prev = nullptr;
    for (const Snapshot &target : states) {
      const std::vector<std::string> records = hashes(planner.next(prev, target));
      for (const std::string &h : records) {
        if (std::binary_search(carried.begin(), carried.end(), h)) {
          ok = false;  // resource-duplicate
        }
        carried.insert(std::lower_bound(carried.begin(), carried.end(), h), h);
      }
      std::vector<std::string> names = hashes(payload_names(target));
      for (const PayloadName &n : payload_names(target)) {
        if (n.payload_bytes <= policy.inline_max_bytes &&
            !std::binary_search(carried.begin(), carried.end(), n.hash)) {
          ok = false;  // resource-missing
        }
      }
      std::sort(names.begin(), names.end());
      std::vector<std::string> pruned;
      std::set_intersection(carried.begin(), carried.end(), names.begin(), names.end(),
                            std::back_inserter(pruned));
      carried = pruned;
      if (!keep_carried) {
        std::vector<std::string> expect = hashes(inline_names(target, policy));
        std::sort(expect.begin(), expect.end());
        ok = ok && carried == expect;  // L2: C = inline(S) after every transaction
      }
      *last_records = records;
      prev = &target;
    }
    return ok;
  };

  const Snapshot b = state(3, "ab-", 'm');
  const Snapshot t = state(4, "acf", 'n');
  std::vector<std::string> r1;
  std::vector<std::string> r2;
  check(replay({state(1, "x--", 'm'), state(2, "xyz", 'p'), b, t}, false, &r1),
        "W11a: a /11 stream through x, y, z replays clean with C = inline(S)");
  check(replay({state(1, "--q", 'q'), b, t}, false, &r2),
        "W11a: a second history reaching the same B replays clean");
  check(r1 == r2 && r1 == hashes(records_before(&b, t, policy)),
        "W11a: the records before T depend on (B, T) alone");
  check(r1 == std::vector<std::string>{hash('c'), hash('n')},
        "W11a: inline(T) \\ inline(B) in table order (textures, then static mesh surfaces); the "
        "out-of-band f and the dynamic mesh carry nothing");

  // A hash that leaves and returns: a at seq 1, gone at 2, back at 3.
  const std::vector<Snapshot> leave = {state(1, "a--", 'm'), state(2, "-b-", 'm'),
                                       state(3, "ab-", 'm')};
  std::vector<std::string> back;
  check(replay(leave, false, &back) && back == std::vector<std::string>{hash('a')},
        "W11a: at /11 a returning hash is re-carried");
  std::vector<std::string> kept;
  check(!replay(leave, true, &kept) && kept.empty(),
        "W11a: under keep-carried it is not, and the /11 stream fails resource-missing");
  RecordPlanner v10(ProtocolVersion::V10, policy);
  v10.next(nullptr, leave[0]);
  v10.next(&leave[0], leave[1]);
  check(v10.next(&leave[1], leave[2]).empty(), "W11a: below /11 the planner keeps /10's set");
}

// W11b (render-stream-11.md "Resource retention", "Multiple viewers"): /11 connections on one
// hub. Each connection's records are inline(T) \ inline(B), so a recurring hash is re-carried,
// and a model receiver holding C (record: not in C, add; transaction: required(S) in C, records
// named by S, then C <- C n names(S)) accepts every connection's stream (L1). Lockstep connections
// still share their encodes, and each still gets the bytes it gets alone.
std::map<std::uint32_t, std::vector<std::vector<std::uint8_t>>> sp_run11(
    const std::vector<SpConn> &conns, bool keep_carried, std::vector<ConnectionSummary> *summaries) {
  FakeTransport transport;
  Session tmpl = make_template(Delivery::Inline);
  tmpl.version = ProtocolVersion::V11;
  LiveConfig config;
  config.keep_carried = keep_carried;
  Hub hub(&transport, config, tmpl);
  const std::string hello11 =
      read_file(std::string(GRC_GOLDEN11_DIR) + "/control/valid/hello-native-block.json");
  std::map<std::uint32_t, std::uint32_t> number;
  for (std::uint64_t frame = 1; frame <= 40; ++frame) {
    for (std::uint32_t i = 0; i < conns.size(); ++i) {
      if (conns[i].open_frame == frame) {
        hub.on_event(opened_with(i + 1, "render-stream.11"), frame);
        hub.on_event(text(i + 1, hello11), frame);
        number[i + 1] = static_cast<std::uint32_t>(number.size() + 1);
      }
    }
    const std::vector<ConnectionSummary> now = hub.summaries();
    for (std::uint32_t i = 0; i < conns.size(); ++i) {
      if (number.count(i + 1) == 0 || frame <= conns[i].open_frame) {
        continue;
      }
      const ConnectionSummary &cs = now.at(number[i + 1] - 1);
      if (conns[i].resync_frame == frame && cs.sent > 0) {
        hub.on_event(text(i + 1, resync(cs.stream_id, cs.sent)), frame);
      } else if ((frame - conns[i].open_frame) % conns[i].ack_period == 0 && cs.sent > 0) {
        hub.on_event(text(i + 1, ack(cs.stream_id, cs.sent, "submitted")), frame);
      }
    }
    Captured c = sp_state(frame);
    c.state.version = ProtocolVersion::V11;
    hub.on_frame(frame, frame * 16000000ULL,
                 hub.wants_snapshot(frame, frame * 16000000ULL) ? &c : nullptr, frame, 0);
  }
  std::map<std::uint32_t, std::vector<std::vector<std::uint8_t>>> out;
  for (const Sent &x : transport.of(Sent::Binary)) {
    if (x.bytes.size() > 8 && x.bytes[0] == 'G') {
      continue;
    }
    out[x.conn].push_back(x.bytes);
  }
  if (summaries != nullptr) {
    *summaries = hub.summaries();
  }
  return out;
}

std::string json_field(const std::string &meta, const std::string &key) {
  const std::string needle = "\"" + key + "\":";
  const std::size_t at = meta.find(needle);
  if (at == std::string::npos) {
    return std::string();
  }
  std::size_t b = at + needle.size();
  if (meta[b] == '"') {
    return meta.substr(b + 1, meta.find('"', b + 1) - b - 1);
  }
  std::size_t e = b;
  while (e < meta.size() && meta[e] != ',' && meta[e] != '}') {
    ++e;
  }
  return meta.substr(b, e - b);
}

// The model receiver over one connection's messages; `recarried` counts records of a hash the
// connection carried before (legal at /11 only after the hash left C).
bool model_accepts(const std::vector<std::vector<std::uint8_t>> &messages, std::uint64_t inline_max,
                   std::size_t *recarried, std::string *why) {
  std::set<std::string> carried;
  std::set<std::string> ever;
  std::set<std::string> since;
  *recarried = 0;
  for (const std::vector<std::uint8_t> &m : messages) {
    const std::string meta = meta_at(m, 0);
    if (has(meta, "\"type\":\"resource\"")) {
      const std::string hash = json_field(meta, "hash");
      if (carried.count(hash) != 0) {
        *why = "resource-duplicate " + hash.substr(0, 8);
        return false;
      }
      *recarried += ever.count(hash);
      carried.insert(hash);
      ever.insert(hash);
      since.insert(hash);
      continue;
    }
    const std::uint64_t frame = std::stoull(json_field(meta, "frame"));
    const Snapshot target = sp_state(frame).state;
    std::set<std::string> names;
    for (const PayloadName &n : payload_names(target)) {
      names.insert(n.hash);
      if (n.payload_bytes <= inline_max && carried.count(n.hash) == 0) {
        *why = "resource-missing " + n.hash.substr(0, 8) + " at frame " + std::to_string(frame);
        return false;
      }
    }
    for (const std::string &h : since) {
      if (names.count(h) == 0) {
        *why = "resource-unnamed " + h.substr(0, 8);
        return false;
      }
    }
    since.clear();
    std::set<std::string> pruned;
    for (const std::string &h : carried) {
      if (names.count(h) != 0) {
        pruned.insert(h);
      }
    }
    carried.swap(pruned);
  }
  return true;
}

void test_v11_connections() {
  const std::uint64_t inline_max = make_template(Delivery::Inline).resources.inline_max_bytes;
  const std::vector<SpConn> conns = {
      {1, 1, 0}, {1, 1, 0}, {3, 2, 0}, {3, 1, 17}, {1, 1, 17}};
  std::vector<ConnectionSummary> multi_summaries;
  const auto multi = sp_run11(conns, false, &multi_summaries);
  std::uint64_t shared = 0;
  for (const ConnectionSummary &cs : multi_summaries) {
    shared += cs.shared_sends;
    check(cs.version == 11, "every connection negotiated /11");
  }
  check(shared > 40, "W11b: lockstep /11 connections share their transactions: " +
                         std::to_string(shared));
  std::size_t recarried_total = 0;
  for (std::uint32_t i = 0; i < conns.size(); ++i) {
    std::size_t recarried = 0;
    std::string why;
    check(model_accepts(multi.at(i + 1), inline_max, &recarried, &why),
          "W11b: connection " + std::to_string(i + 1) + " passes the /11 carried-set rules " + why);
    recarried_total += recarried;
    std::vector<ConnectionSummary> solo_summaries;
    const auto solo = sp_run11({conns[i]}, false, &solo_summaries);
    check(multi.at(i + 1) == solo.at(1),
          "W11b: /11 connection " + std::to_string(i + 1) + " gets the bytes it gets alone");
  }
  check(recarried_total > 0, "W11b: a recurring hash is re-carried at /11 (" +
                                 std::to_string(recarried_total) + " records)");
  // keep-carried (the host sabotage): /10's lifelong set on a /11 connection -- no hash goes twice,
  // so the model receiver finds a returning hash missing.
  const auto kept = sp_run11({{1, 1, 0}}, true, nullptr);
  std::size_t recarried = 0;
  std::string why;
  check(!model_accepts(kept.at(1), inline_max, &recarried, &why) &&
            why.find("resource-missing") == 0 && recarried == 0,
        "W11b: keep-carried never re-carries, and the /11 receiver fails resource-missing (" + why +
            ")");
}

// W11t (render-stream-11.md "As built (W11t)"): base-prefix zstd on /11 connections. Every binary
// message of a connection whose hello offered `live_coding` (and whose host accepted) is coded:
// decoding them in order, each based transaction against the uncoded message its envelope names,
// gives exactly the messages an uncoded run sends; lockstep viewers share the coded bytes.
std::map<std::uint32_t, std::vector<std::vector<std::uint8_t>>> sp_run11_wire(
    const std::vector<SpConn> &conns, const LiveConfig &config, const std::string &hello,
    std::vector<ConnectionSummary> *summaries) {
  FakeTransport transport;
  Session tmpl = make_template(Delivery::Inline);
  tmpl.version = ProtocolVersion::V11;
  Hub hub(&transport, config, tmpl);
  std::map<std::uint32_t, std::uint32_t> number;
  for (std::uint64_t frame = 1; frame <= 40; ++frame) {
    for (std::uint32_t i = 0; i < conns.size(); ++i) {
      if (conns[i].open_frame == frame) {
        hub.on_event(opened_with(i + 1, "render-stream.11"), frame);
        hub.on_event(text(i + 1, hello), frame);
        number[i + 1] = static_cast<std::uint32_t>(number.size() + 1);
      }
    }
    const std::vector<ConnectionSummary> now = hub.summaries();
    for (std::uint32_t i = 0; i < conns.size(); ++i) {
      if (number.count(i + 1) == 0 || frame <= conns[i].open_frame) {
        continue;
      }
      const ConnectionSummary &cs = now.at(number[i + 1] - 1);
      if (conns[i].resync_frame == frame && cs.sent > 0) {
        hub.on_event(text(i + 1, resync(cs.stream_id, cs.transactions)), frame);
      } else if ((frame - conns[i].open_frame) % conns[i].ack_period == 0 && cs.sent > 0) {
        hub.on_event(text(i + 1, ack(cs.stream_id, cs.transactions, "submitted")), frame);
      }
    }
    Captured c = sp_state(frame);
    c.state.version = ProtocolVersion::V11;
    hub.on_frame(frame, frame * 16000000ULL,
                 hub.wants_snapshot(frame, frame * 16000000ULL) ? &c : nullptr, frame, 0);
  }
  std::map<std::uint32_t, std::vector<std::vector<std::uint8_t>>> out;
  for (const Sent &x : transport.of(Sent::Binary)) {
    out[x.conn].push_back(x.bytes);
  }
  if (summaries != nullptr) {
    // by connection index (the hub's are in open order)
    const std::vector<ConnectionSummary> all = hub.summaries();
    summaries->clear();
    for (std::uint32_t i = 0; i < conns.size(); ++i) {
      summaries->push_back(all.at(number.at(i + 1) - 1));
    }
  }
  return out;
}

// A model receiver's decoder: keeps every decoded transaction by its envelope seq. False with *why
// (rs-core's `coding`) on a missing base or a frame that fails; *differs counts based frames whose
// zstd decode succeeded but that the caller finds wrong.
bool model_decode(const std::vector<std::vector<std::uint8_t>> &wire,
                  std::vector<std::vector<std::uint8_t>> *out, std::string *why,
                  std::uint64_t *prefixed) {
  std::map<std::uint64_t, std::vector<std::uint8_t>> bases;
  *prefixed = 0;
  for (const std::vector<std::uint8_t> &m : wire) {
    std::uint64_t seq = 0;
    std::uint64_t base_seq = 0;
    if (m.size() >= 24 && u32le(m, 0) == grc::rs::live_coding::kEnvelopeMagic) {
      std::uint64_t b = 0;
      for (int k = 7; k >= 0; --k) b = (b << 8) | m[16 + static_cast<std::size_t>(k)];
      base_seq = b;
    }
    const auto found = bases.find(base_seq);
    if (base_seq != 0 && found == bases.end()) {
      *why = "base " + std::to_string(base_seq) + " missing";
      return false;
    }
    std::vector<std::uint8_t> decoded;
    std::string error;
    if (!grc::rs::live_coding::decode(m.data(), m.size(),
                                      base_seq != 0 ? &found->second : nullptr, &decoded, &seq,
                                      &base_seq, &error)) {
      *why = error;
      return false;
    }
    if (base_seq != 0) {
      ++*prefixed;
    }
    if (seq != 0) {
      bases[seq] = decoded;
    }
    out->push_back(std::move(decoded));
  }
  return true;
}

std::string with_live_coding(const std::string &hello, const std::string &offer) {
  const std::size_t brace = hello.find('{');
  return hello.substr(0, brace + 1) + "\"live_coding\":\"" + offer + "\"," +
         hello.substr(brace + 1);
}

void test_v11_live_coding() {
  using grc::rs::live_coding::Coding;
  const std::string hello11 =
      read_file(std::string(GRC_GOLDEN11_DIR) + "/control/valid/hello-native-block.json");
  const std::string offered = with_live_coding(hello11, "zstd-base,zstd");
  // The parser: optional at /11 only, with its grammar.
  {
    ControlMessage m;
    std::string error;
    check(parse_control(offered, &m, &error, ProtocolVersion::V11) && m.has_live_coding &&
              m.live_coding == "zstd-base,zstd",
          "W11t: a /11 hello may offer live_coding " + error);
    check(parse_control(hello11, &m, &error, ProtocolVersion::V11) && !m.has_live_coding,
          "W11t: live_coding is optional at /11");
    check(parse_control(read_file(std::string(GRC_GOLDEN11_DIR) +
                                  "/control/valid/hello-live-coding.json"),
                        &m, &error, ProtocolVersion::V11) &&
              m.live_coding == "zstd-base,zstd",
          "W11t: golden-11 control/valid/hello-live-coding.json parses " + error);
    check(!parse_control(read_file(std::string(GRC_GOLDEN11_DIR) +
                                   "/control/invalid/hello-live-coding-grammar.json"),
                         &m, &error, ProtocolVersion::V11),
          "W11t: golden-11 control/invalid/hello-live-coding-grammar.json is refused");
    check(!parse_control(with_live_coding(hello11, "Zstd"), &m, &error, ProtocolVersion::V11),
          "W11t: live_coding's grammar is [a-z0-9-] names");
    check(!parse_control(with_live_coding(hello11, ""), &m, &error, ProtocolVersion::V11),
          "W11t: an empty live_coding is refused");
    const std::string hello10 =
        read_file(std::string(GRC_GOLDEN10_DIR) + "/control/valid/hello-native-block.json");
    check(!parse_control(with_live_coding(hello10, "zstd"), &m, &error, ProtocolVersion::V10),
          "W11t: below /11 live_coding is an unknown key");
    check(grc::rs::live_coding::negotiate(Coding::ZstdBase, "zstd-base,zstd") == Coding::ZstdBase &&
              grc::rs::live_coding::negotiate(Coding::ZstdBase, "zstd") == Coding::Zstd &&
              grc::rs::live_coding::negotiate(Coding::Zstd, "zstd-base,zstd") == Coding::Zstd &&
              grc::rs::live_coding::negotiate(Coding::Zstd, "zstd-base") == Coding::Off &&
              grc::rs::live_coding::negotiate(Coding::Off, "zstd-base,zstd") == Coding::Off &&
              grc::rs::live_coding::negotiate(Coding::ZstdBase, "brotli,zstd-base") ==
                  Coding::ZstdBase,
          "W11t: negotiate");
  }
  const std::vector<SpConn> conns = {
      {1, 1, 0}, {1, 1, 0}, {3, 2, 0}, {3, 1, 17}, {1, 1, 17}};
  LiveConfig off_config;
  std::vector<ConnectionSummary> off_summaries;
  const auto plain = sp_run11_wire(conns, off_config, hello11, &off_summaries);
  LiveConfig config;
  config.live_coding = Coding::ZstdBase;
  std::vector<ConnectionSummary> summaries;
  const auto wire = sp_run11_wire(conns, config, offered, &summaries);
  std::uint64_t shared = 0;
  for (std::uint32_t i = 0; i < conns.size(); ++i) {
    const ConnectionSummary &cs = summaries.at(i);
    check(cs.live_coding == "zstd-base" && cs.has_live_coding,
          "W11t: connection " + std::to_string(i + 1) + " negotiated zstd-base");
    check(off_summaries.at(i).live_coding == "off", "W11t: no offer, no coding");
    std::vector<std::vector<std::uint8_t>> decoded;
    std::string why;
    std::uint64_t prefixed = 0;
    check(model_decode(wire.at(i + 1), &decoded, &why, &prefixed),
          "W11t: connection " + std::to_string(i + 1) + " decodes " + why);
    // The session messages differ only in their stream_id; every later message is equal.
    check(decoded.size() == plain.at(i + 1).size() && decoded[0][0] == 'G' &&
              std::equal(decoded.begin() + 1, decoded.end(), plain.at(i + 1).begin() + 1),
          "W11t: connection " + std::to_string(i + 1) +
              " decodes to exactly the messages an uncoded run sends");
    check(prefixed > 0 && prefixed == cs.coded_prefixed,
          "W11t: based transactions on connection " + std::to_string(i + 1) + ": " +
              std::to_string(prefixed));
    check(cs.coded_wire_bytes < cs.coded_input_bytes && cs.coded_messages == wire.at(i + 1).size(),
          "W11t: coded bytes " + std::to_string(cs.coded_wire_bytes) + " < " +
              std::to_string(cs.coded_input_bytes));
    shared += cs.coded_shared;
  }
  check(wire.at(1).size() == wire.at(2).size() &&
            std::equal(wire.at(1).begin() + 1, wire.at(1).end(), wire.at(2).begin() + 1),
        "W11t: lockstep viewers get byte-equal coded messages");
  check(shared > 40, "W11t: lockstep viewers share the coded bytes: " + std::to_string(shared));
  // A receiver that keeps no bases (offers zstd only): every frame is unprefixed.
  {
    std::vector<ConnectionSummary> z;
    const auto zw = sp_run11_wire({{1, 1, 0}}, config, with_live_coding(hello11, "zstd"), &z);
    std::vector<std::vector<std::uint8_t>> decoded;
    std::string why;
    std::uint64_t prefixed = 0;
    check(z.at(0).live_coding == "zstd" && model_decode(zw.at(1), &decoded, &why, &prefixed) &&
              prefixed == 0 && z.at(0).coded_prefixed == 0,
          "W11t: per-message zstd for a receiver that keeps no bases " + why);
  }
  // drop-message: the dropped transaction is the next one's base, which the receiver never got.
  {
    LiveConfig drop = config;
    drop.drop_message_frame = 12;
    const auto dw = sp_run11_wire({{1, 1, 0}}, drop, offered, nullptr);
    std::vector<std::vector<std::uint8_t>> decoded;
    std::string why;
    std::uint64_t prefixed = 0;
    check(!model_decode(dw.at(1), &decoded, &why, &prefixed) && why.find("missing") != std::string::npos,
          "W11t: a dropped base is a missing prefix (" + why + ")");
  }
  // coding-wrong-prefix: one based frame decodes wrongly (or not at all) against its true base.
  {
    LiveConfig wrong = config;
    wrong.coding_wrong_prefix_frame = 12;
    std::vector<ConnectionSummary> ws;
    const auto ww = sp_run11_wire({{1, 1, 0}}, wrong, offered, &ws);
    const auto honest = sp_run11_wire({{1, 1, 0}}, config, offered, nullptr);
    std::size_t bad = 0;
    std::map<std::uint64_t, std::vector<std::uint8_t>> bases;
    std::vector<std::vector<std::uint8_t>> ref;
    std::string why;
    std::uint64_t prefixed = 0;
    model_decode(honest.at(1), &ref, &why, &prefixed);
    for (std::size_t k = 1; k < ww.at(1).size() && k < ref.size(); ++k) {  // 0: the session
      if (ww.at(1)[k] == honest.at(1)[k]) {
        continue;
      }
      ++bad;
      // decode it against the true base (the honest stream's message of its base seq)
      const std::vector<std::uint8_t> &m = ww.at(1)[k];
      std::uint64_t base_seq = 0;
      for (int b = 7; b >= 0; --b) base_seq = (base_seq << 8) | m[16 + static_cast<std::size_t>(b)];
      const std::vector<std::uint8_t> *base = nullptr;
      for (const auto &r : ref) {
        if (r.size() > 8 && r[0] != 'G' && has(meta_at(r, 0), "\"type\":\"transaction\",\"seq\":" +
                                                                    std::to_string(base_seq) + ",")) {
          base = &r;
        }
      }
      std::vector<std::uint8_t> out;
      std::uint64_t s1 = 0;
      std::uint64_t s2 = 0;
      std::string error;
      check(base != nullptr && (!grc::rs::live_coding::decode(m.data(), m.size(), base, &out, &s1,
                                                              &s2, &error) ||
                                out != ref[k]),
            "W11t: the wrong-prefix frame does not decode to its transaction");
    }
    check(bad == 1 && ws.at(0).wrong_prefix_seq != 0,
          "W11t: coding-wrong-prefix codes exactly one message wrongly (seq " +
              std::to_string(ws.at(0).wrong_prefix_seq) + ")");
  }
}

// PM1 (render-stream-11.md "As built (PM1)" rules 3, 7 and 8): a multimesh's buffer_f is a
// function of (B, T): two /11 connections at different bases each get the floats exactly when the
// buffer serial moved between their own base and target; a repeated target (the stale-coalesce
// shape) carries no multimesh entry at all; a /10 connection of the same host sees /10's
// unsupported-op command, no table, and a session without add_multimesh.
std::uint64_t pm1_serial(std::uint64_t frame) { return 1 + (frame >= 3) + (frame >= 6) + (frame >= 9); }

std::shared_ptr<const Captured> pm1_state(std::uint64_t frame) {
  auto c = std::make_shared<Captured>(with_payloads(1));
  c->state.version = ProtocolVersion::V11;
  const std::uint64_t serial = pm1_serial(frame);
  MultimeshEntry mm;
  mm.id = 1;
  mm.version = 1 + serial;
  mm.instances = 1;
  mm.buffer = std::make_shared<const std::vector<float>>(
      std::vector<float>{1, 0, 0, static_cast<float>(serial), 0, 1, 0, 0});
  mm.buffer_serial = serial;
  c->state.multimeshes = {mm};
  c->state.multimesh_commands = true;
  Command add;
  add.kind = CommandKind::AddMultimesh;
  add.multimesh = 1;
  c->state.items.mut(0).commands.push_back(add);
  return c;
}

// A JSON integer (or null: -1) after `key` in `meta`, from `from`.
std::int64_t json_int_after(const std::string &meta, const std::string &key, std::size_t from = 0) {
  const std::size_t at = meta.find("\"" + key + "\":", from);
  if (at == std::string::npos) {
    return -2;  // absent
  }
  const std::size_t v = at + key.size() + 3;
  if (meta.compare(v, 4, "null") == 0) {
    return -1;
  }
  return std::strtoll(meta.c_str() + v, nullptr, 10);
}

// PM5 (render-stream-12.md "The command", "Opt-in and version policy"): a /12 host serves a /12
// connection the particles table, the emit list and add_particles, and a /11 connection of the
// same host /11's lowering: no particles key, add_particles as unsupported-op, and a session
// without add_particles.
std::shared_ptr<const Captured> pm5_state(std::uint64_t frame) {
  auto c = std::make_shared<Captured>(with_payloads(1));
  c->state.version = ProtocolVersion::V12;
  c->state.frame = frame;
  ParticlesEntry p;
  p.id = 1;
  p.version = frame;
  p.mode_2d = true;
  p.emitting = true;
  p.amount = 4;
  p.emits = frame;
  p.floats = std::make_shared<const std::vector<float>>(std::vector<float>(31, 1.0f));
  c->state.particles = {p};
  c->state.particles_commands = true;
  auto tail = std::make_shared<EmitTail>();
  for (std::uint64_t f = 1; f <= frame; ++f) {
    auto chunk = std::make_shared<EmitChunk>();
    chunk->frame = f;
    ParticleEmit e;
    e.particles = 1;
    e.flags = 1;
    chunk->emits.push_back(e);
    tail->push_back(chunk);
  }
  c->state.emit_tail = tail;
  Command add;
  add.kind = CommandKind::AddParticles;
  add.particles = 1;
  c->state.items.mut(0).commands.push_back(add);
  return c;
}

void test_pm5_v11_viewer_of_v12_host() {
  Session tmpl = make_template(Delivery::Inline);
  tmpl.version = ProtocolVersion::V12;
  observe_multimesh_features(&tmpl.features);
  observe_particles_features(&tmpl.features);
  FakeTransport transport;
  Hub hub(&transport, LiveConfig(), tmpl);
  const std::string hello12 =
      read_file(std::string(GRC_GOLDEN12_DIR) + "/control/valid/hello-native-block.json");
  const std::string hello11 =
      read_file(std::string(GRC_GOLDEN11_DIR) + "/control/valid/hello-native-block.json");
  hub.on_event(opened_with(1, "render-stream.12"), 0);
  hub.on_event(opened_with(2, "render-stream.11"), 0);
  hub.on_event(text(1, hello12), 0);
  hub.on_event(text(2, hello11), 0);
  for (std::uint64_t frame = 1; frame <= 6; ++frame) {
    const std::vector<ConnectionSummary> now = hub.summaries();
    for (std::uint32_t conn = 1; conn <= 2; ++conn) {
      const ConnectionSummary &cs = now.at(conn - 1);
      if (cs.sent > 0) {
        hub.on_event(text(conn, ack(cs.stream_id, cs.sent, "submitted")), frame);
      }
    }
    const std::uint64_t t = frame * 16000000ULL;
    hub.on_frame_shared(frame, t, hub.wants_snapshot(frame, t) ? pm5_state(frame) : nullptr,
                        frame, 0);
  }
  const std::vector<Sent> b12 = of_conn(transport, Sent::Binary, 1);
  check(b12.size() > 3, "PM5: the /12 connection streamed");
  const std::string s12 = b12.empty() ? std::string() : meta_at(b12[0].bytes, 8);
  check(s12.find("\"protocol\":\"render-stream/12\"") != std::string::npos &&
            s12.find("\"add_particles\"") != std::string::npos,
        "PM5: the /12 session declares add_particles");
  int with_emits = 0;
  int with_adds = 0;
  for (std::size_t i = 1; i < b12.size(); ++i) {
    const std::string meta = meta_at(b12[i].bytes, 0);
    if (meta.find("\"type\":\"transaction\"") == std::string::npos) {
      continue;
    }
    with_adds += meta.find("{\"op\":\"add_particles\",\"particles\":1,\"tex\":null}") !=
                         std::string::npos
                     ? 1
                     : 0;
    with_emits += meta.find("\"particle_emits\":[") != std::string::npos ? 1 : 0;
  }
  check(with_emits > 0, "PM5: /12 transactions carry the emit list");
  check(with_adds > 0, "PM5: /12 carries add_particles");
  const std::vector<Sent> b11 = of_conn(transport, Sent::Binary, 2);
  check(b11.size() > 3, "PM5: the /11 connection streamed");
  const std::string s11 = b11.empty() ? std::string() : meta_at(b11[0].bytes, 8);
  check(s11.find("\"protocol\":\"render-stream/11\"") != std::string::npos &&
            s11.find("\"add_particles\"") == std::string::npos &&
            s11.find("\"canvas_item_add_particles\"") != std::string::npos &&
            s11.find("\"add_multimesh\"") != std::string::npos,
        "PM5: a /11 connection's session declares /11's features");
  bool lowered = false;
  for (std::size_t i = 1; i < b11.size(); ++i) {
    const std::string meta = meta_at(b11[i].bytes, 0);
    check(meta.find("\"particles\":[") == std::string::npos &&
              meta.find("particle_emits") == std::string::npos &&
              meta.find("pt_f32") == std::string::npos &&
              meta.find("\"op\":\"add_particles\"") == std::string::npos,
          "PM5: no particles key, block or command below /12");
    lowered = lowered || meta.find("{\"op\":\"unsupported\",\"name\":\"canvas_item_add_particles\","
                                   "\"reason\":\"unsupported-op\"}") != std::string::npos;
  }
  check(lowered, "PM5: the /11 connection sees add_particles as /11's unsupported-op");
}

void test_pm1_multimesh_buffer_f() {
  Session tmpl = make_template(Delivery::Inline);
  tmpl.version = ProtocolVersion::V11;
  observe_multimesh_features(&tmpl.features);
  FakeTransport transport;
  Hub hub(&transport, LiveConfig(), tmpl);
  const std::string hello11 =
      read_file(std::string(GRC_GOLDEN11_DIR) + "/control/valid/hello-native-block.json");
  const std::string hello10 =
      read_file(std::string(GRC_GOLDEN10_DIR) + "/control/valid/hello-native-block.json");
  hub.on_event(opened_with(1, "render-stream.11"), 0);
  hub.on_event(opened_with(2, "render-stream.11"), 0);
  hub.on_event(opened_with(3, "render-stream.10"), 0);
  hub.on_event(text(1, hello11), 0);
  hub.on_event(text(2, hello11), 0);
  hub.on_event(text(3, hello10), 0);
  std::shared_ptr<const Captured> state;
  for (std::uint64_t frame = 1; frame <= 14; ++frame) {
    const std::vector<ConnectionSummary> now = hub.summaries();
    for (std::uint32_t conn = 1; conn <= 3; ++conn) {
      const ConnectionSummary &cs = now.at(conn - 1);
      const std::uint64_t period = conn == 2 ? 3 : 1;
      if (cs.sent > 0 && frame % period == 0) {
        hub.on_event(text(conn, ack(cs.stream_id, cs.sent, "submitted")), frame);
      }
    }
    if (frame != 7) {
      state = pm1_state(frame);  // frame 7 re-offers frame 6's target: a repeated target
    }
    const std::uint64_t t = frame * 16000000ULL;
    hub.on_frame_shared(frame, t, hub.wants_snapshot(frame, t) ? state : nullptr, frame, 0);
  }
  for (std::uint32_t conn = 1; conn <= 2; ++conn) {
    const std::vector<Sent> bin = of_conn(transport, Sent::Binary, conn);
    check(bin.size() > 3 && meta_at(bin[0].bytes, 8).find("\"add_multimesh\"") != std::string::npos,
          "PM1: the /11 session declares add_multimesh");
    std::map<std::int64_t, std::int64_t> frame_of;  // seq -> frame
    int with_floats = 0;
    int held = 0;
    for (std::size_t i = 1; i < bin.size(); ++i) {
      const std::string meta = meta_at(bin[i].bytes, 0);
      if (meta.find("\"type\":\"transaction\"") == std::string::npos) {
        continue;
      }
      const std::int64_t seq = json_int_after(meta, "seq");
      const std::int64_t frame = json_int_after(meta, "frame");
      const std::int64_t base = json_int_after(meta, "base_seq");
      frame_of[seq] = frame;
      // The target's content frame (frame 7 carried frame 6's state).
      const auto content = [](std::int64_t f) { return f == 7 ? 6 : f; };
      const std::size_t mms = meta.find("\"multimeshes\":[");
      const std::int64_t buffer_f = mms == std::string::npos ? -2 : json_int_after(meta, "buffer_f", mms);
      if (base < 0) {
        check(buffer_f >= 0, "PM1: a full transaction writes the buffer (conn " +
                                 std::to_string(conn) + " seq " + std::to_string(seq) + ")");
        continue;
      }
      const std::uint64_t sb = pm1_serial(static_cast<std::uint64_t>(content(frame_of[base])));
      const std::uint64_t st = pm1_serial(static_cast<std::uint64_t>(content(frame)));
      const bool moved = sb != st;
      check(moved ? buffer_f >= 0 : buffer_f == -2,
            "PM1: conn " + std::to_string(conn) + " seq " + std::to_string(seq) + " (base " +
                std::to_string(base) + "): buffer_f " + std::to_string(buffer_f) +
                (moved ? ", the serial moved" : ", the serial held"));
      if (moved) {
        ++with_floats;
      } else {
        ++held;
      }
      if (frame == 7 && frame_of[base] == 6) {
        check(mms == std::string::npos, "PM1: a repeated target carries no multimesh entry");
      }
    }
    check(with_floats > 0 && held > 0, "PM1: conn " + std::to_string(conn) +
                                           " saw both a moved and a held serial");
  }
  const std::vector<Sent> b10 = of_conn(transport, Sent::Binary, 3);
  check(b10.size() > 3, "PM1: the /10 connection streamed");
  const std::string s10 = b10.empty() ? std::string() : meta_at(b10[0].bytes, 8);
  check(s10.find("\"add_multimesh\"") == std::string::npos &&
            s10.find("\"multimesh\"") == std::string::npos &&
            s10.find("\"canvas_item_add_multimesh\"") != std::string::npos,
        "PM1: a /10 connection's session declares no multimesh (rule 8 undone)");
  bool lowered = false;
  for (std::size_t i = 1; i < b10.size(); ++i) {
    const std::string meta = meta_at(b10[i].bytes, 0);
    check(meta.find("\"multimeshes\"") == std::string::npos &&
              meta.find("\"add_multimesh\"") == std::string::npos,
          "PM1: no multimesh table or command below /11");
    lowered = lowered || meta.find("{\"op\":\"unsupported\",\"name\":\"canvas_item_add_multimesh\","
                                   "\"reason\":\"unsupported-op\"}") != std::string::npos;
  }
  check(lowered, "PM1: /10 sees the unsupported-op command");
}

// ----------------------------------------------------------------- HC5: the formation thread

// A FakeTransport the encode thread may call while the test thread reads it (between syncs).
class LockedTransport : public FakeTransport {
 public:
  bool send_binary(std::uint32_t conn, std::vector<std::uint8_t> message) override {
    std::lock_guard<std::mutex> lock(mutex);
    return FakeTransport::send_binary(conn, std::move(message));
  }
  bool send_text(std::uint32_t conn, std::string message) override {
    std::lock_guard<std::mutex> lock(mutex);
    return FakeTransport::send_text(conn, std::move(message));
  }
  void close(std::uint32_t conn, std::uint16_t code, std::string reason) override {
    std::lock_guard<std::mutex> lock(mutex);
    FakeTransport::close(conn, code, std::move(reason));
  }
  std::uint64_t queued_bytes(std::uint32_t conn) const override {
    std::lock_guard<std::mutex> lock(mutex);
    return FakeTransport::queued_bytes(conn);
  }
  mutable std::mutex mutex;
};

struct Hc5Run {
  std::map<std::uint32_t, std::vector<std::vector<std::uint8_t>>> binary;  // by connection id
  std::vector<Sent> sent;  // every transport call, in order
  std::vector<ConnectionSummary> summaries;
  std::map<std::string, std::string> files;  // tap dir file -> contents (stream ids masked)
};

// A mixed hub at /11 with inline records: two lockstep zstd-base viewers (sharing transactions,
// records and coded bytes), an uncoded /11 viewer acking every other frame with a resync, and a
// /6 viewer (the main thread's CarriedIndex walk), over 40 callbacks plus finish.
Hc5Run hc5_run(Formation formation, bool wait, const std::string &tap_dir,
               std::uint64_t reorder_frame = 0) {
  LockedTransport transport;
  Session tmpl = make_template(Delivery::Inline);
  tmpl.version = ProtocolVersion::V11;
  LiveConfig config;
  config.formation = formation;
  config.formation_wait = wait;
  config.tap_dir = tap_dir;
  config.reorder_frame = reorder_frame;
  config.live_coding = grc::rs::live_coding::Coding::ZstdBase;
  Hub hub(&transport, config, tmpl);
  const std::string hello11 =
      read_file(std::string(GRC_GOLDEN11_DIR) + "/control/valid/hello-native-block.json");
  const std::string coded = with_live_coding(hello11, "zstd-base,zstd");
  struct C {
    const char *sub;
    std::string hello;
    std::uint64_t open_frame;
    std::uint64_t ack_period;
    std::uint64_t resync_frame;
  };
  const std::vector<C> conns = {{"render-stream.11", coded, 1, 1, 0},
                                {"render-stream.11", coded, 1, 1, 0},
                                {"render-stream.11", hello11, 2, 2, 17},
                                {"render-stream.6", kHello6, 3, 1, 0}};
  for (std::uint64_t frame = 1; frame <= 40; ++frame) {
    for (std::uint32_t i = 0; i < conns.size(); ++i) {
      if (conns[i].open_frame == frame) {
        hub.on_event(opened_with(i + 1, conns[i].sub), frame);
        hub.on_event(text(i + 1, conns[i].hello), frame);
      }
    }
    hub.sync();  // the acks below read what the previous callback's jobs sent
    const std::vector<ConnectionSummary> now = hub.summaries();
    for (std::uint32_t i = 0; i < conns.size(); ++i) {
      if (frame <= conns[i].open_frame) {
        continue;
      }
      const ConnectionSummary &cs = now.at(i);
      if (conns[i].resync_frame == frame && cs.sent > 0) {
        hub.on_event(text(i + 1, resync(cs.stream_id, cs.transactions)), frame);
      } else if ((frame - conns[i].open_frame) % conns[i].ack_period == 0 && cs.sent > 0) {
        hub.on_event(text(i + 1, ack(cs.stream_id, cs.transactions, "submitted")), frame);
      }
    }
    Captured c = sp_state(frame);
    c.state.version = ProtocolVersion::V11;
    hub.on_frame(frame, frame * 16000000ULL,
                 hub.wants_snapshot(frame, frame * 16000000ULL) ? &c : nullptr, frame, 0);
  }
  hub.finish(EndReason::Shutdown, 41, 41 * 16000000ULL);
  hub.close_open(41);
  Hc5Run out;
  out.summaries = hub.summaries();
  {
    std::lock_guard<std::mutex> lock(transport.mutex);
    out.sent = transport.sent;
  }
  for (const Sent &x : out.sent) {
    if (x.kind == Sent::Binary) {
      // The first message (magic + session) holds the connection's fresh stream id (coded, its
      // size too): it is compared as a placeholder.
      std::vector<std::vector<std::uint8_t>> &mine = out.binary[x.conn];
      mine.push_back(mine.empty() ? std::vector<std::uint8_t>{0} : x.bytes);
    }
  }
  for (auto &entry : out.binary) {
    entry.second.pop_back();  // the end record (finish): its stats hold timings
  }
  if (!tap_dir.empty()) {
    std::vector<std::string> names;
    if (DIR *d = opendir(tap_dir.c_str())) {
      while (dirent *e = readdir(d)) {
        const std::string name = e->d_name;
        if (name != "." && name != "..") {
          names.push_back(name);
        }
      }
      closedir(d);
    }
    for (const std::string &name : names) {
      if (name.rfind("live-", 0) != 0 && name.rfind("stream-", 0) != 0) {
        continue;
      }
      std::string body = read_file(grc::path_join(tap_dir, name));
      for (const ConnectionSummary &cs : out.summaries) {
        for (std::size_t at = body.find(cs.stream_id); at != std::string::npos;
             at = body.find(cs.stream_id, at)) {
          body.replace(at, cs.stream_id.size(), std::string(cs.stream_id.size(), '#'));
        }
      }
      // The end record's stats hold timings (encode_ns_total): the tap is compared up to it.
      if (name.rfind("stream-", 0) == 0) {
        const std::size_t end = body.rfind("{\"type\":\"end\"");
        out.files[name] = end == std::string::npos || end < 8 ? body : body.substr(0, end - 8);
        continue;
      }
      // A host close line's t_us is the clock's, not the callback's; an end line's bytes count the
      // end record's timing stats.
      std::string kept;
      std::size_t from = 0;
      while (from < body.size()) {
        std::size_t nl = body.find('\n', from);
        if (nl == std::string::npos) {
          nl = body.size();
        }
        const std::string line = body.substr(from, nl - from);
        kept += has(line, "\"event\":\"close\"") ? "close"
                : has(line, "\"event\":\"end\"") ? "end"
                                                    : line;
        kept += "\n";
        from = nl + 1;
      }
      out.files[name] = kept;
    }
  }
  return out;
}

std::uint64_t sum_of(const std::vector<ConnectionSummary> &all,
                     std::uint64_t ConnectionSummary::*field) {
  std::uint64_t n = 0;
  for (const ConnectionSummary &cs : all) {
    n += cs.*field;
  }
  return n;
}

void test_hc5_formation_thread() {
  const std::string root = std::string(GRC_TEST_TMP_DIR) + "/hc5";
  grc::make_directories(root + "/inline");
  grc::make_directories(root + "/thread");
  grc::make_directories(root + "/reorder");
  const Hc5Run inline_run = hc5_run(Formation::Inline, false, root + "/inline");
  const Hc5Run thread_run = hc5_run(Formation::Thread, false, root + "/thread");
  // Order: every connection's messages, session included, are the inline hub's, byte for byte.
  check(inline_run.binary.size() == 4 && inline_run.binary == thread_run.binary,
        "HC5: the encode thread sends every connection the inline hub's messages, in its order");
  for (const auto &entry : inline_run.binary) {
    const auto other = thread_run.binary.find(entry.first);
    check(other != thread_run.binary.end() && other->second.size() == entry.second.size(),
          "HC5: connection " + std::to_string(entry.first) + " got " +
              std::to_string(entry.second.size()) + " messages inline");
  }
  // Every transport call, texts and closes included, per connection in the same order.
  for (std::uint32_t conn = 1; conn <= 4; ++conn) {
    std::vector<std::string> a;
    std::vector<std::string> b;
    for (const Sent &x : inline_run.sent) {
      if (x.conn == conn) {
        a.push_back(std::to_string(x.kind) + ":" + std::to_string(x.bytes.size()) + x.text);
      }
    }
    for (const Sent &x : thread_run.sent) {
      if (x.conn == conn) {
        b.push_back(std::to_string(x.kind) + ":" + std::to_string(x.bytes.size()) + x.text);
      }
    }
    // The first and last binary messages (the session's fresh stream id; the end record's timing
    // stats) may differ in size.
    for (std::vector<std::string> *calls : {&a, &b}) {
      const std::string binary = std::to_string(Sent::Binary) + ":";
      for (std::size_t k = calls->size(); k-- > 0;) {
        if ((*calls)[k].rfind(binary, 0) == 0) {
          calls->erase(calls->begin() + static_cast<std::ptrdiff_t>(k));
          break;
        }
      }
      for (std::size_t k = 0; k < calls->size(); ++k) {
        if ((*calls)[k].rfind(binary, 0) == 0) {
          calls->erase(calls->begin() + static_cast<std::ptrdiff_t>(k));
          break;
        }
      }
    }
    check(!a.empty() && a == b, "HC5: connection " + std::to_string(conn) +
                                    "'s transport calls are the inline hub's");
  }
  // The taps and the live logs (stream ids masked, host close lines' clock aside) are equal.
  check(inline_run.files.size() == 8 && inline_run.files == thread_run.files,
        "HC5: taps and live logs equal the inline hub's (" +
            std::to_string(inline_run.files.size()) + " files)");
  for (const auto &entry : inline_run.files) {
    const auto other = thread_run.files.find(entry.first);
    if (other == thread_run.files.end() || other->second != entry.second) {
      check(false, "HC5: " + entry.first + " differs");
    }
  }
  // Sharing (P3-SP, W11b, W11t) holds on the encode thread: the lockstep pair shares.
  const auto &a = inline_run.summaries;
  const auto &b = thread_run.summaries;
  check(sum_of(a, &ConnectionSummary::shared_sends) > 30 &&
            sum_of(a, &ConnectionSummary::shared_sends) ==
                sum_of(b, &ConnectionSummary::shared_sends) &&
            sum_of(a, &ConnectionSummary::coded_shared) > 30 &&
            sum_of(a, &ConnectionSummary::coded_shared) ==
                sum_of(b, &ConnectionSummary::coded_shared),
        "HC5: lockstep connections share transactions and coded bytes on the encode thread (" +
            std::to_string(sum_of(b, &ConnectionSummary::shared_sends)) + " shared sends, " +
            std::to_string(sum_of(b, &ConnectionSummary::coded_shared)) + " coded shares)");
  bool same = a.size() == b.size();
  for (std::size_t i = 0; same && i < a.size(); ++i) {
    same = a[i].sent == b[i].sent && a[i].transactions == b[i].transactions &&
           a[i].full == b[i].full && a[i].patch == b[i].patch &&
           a[i].resource_records == b[i].resource_records &&
           a[i].resource_bytes == b[i].resource_bytes && a[i].carried_size == b[i].carried_size &&
           a[i].coded_messages == b[i].coded_messages &&
           a[i].max_message_sent == b[i].max_message_sent && a[i].resyncs == b[i].resyncs &&
           a[i].end_sent == b[i].end_sent && a[i].credits == b[i].credits;
  }
  check(same && a.size() == 4, "HC5: every connection's summary counters equal the inline hub's");
  check(a.at(0).resource_records > 0 && a.at(3).resource_records > 0 && a.at(2).resyncs == 1,
        "HC5: the run exercises /11 and /6 records and a resync");
  // reorder (HC5 sabotage): the transaction leaves before its records, which a receiver refuses
  // as resource-missing (the model receiver here; rs-core in run-hc1.sh's sabotage-reorder legs).
  const Hc5Run reordered = hc5_run(Formation::Thread, false, root + "/reorder", 1);
  std::vector<std::vector<std::uint8_t>> plain;  // connection 3: /11, uncoded
  for (const std::vector<std::uint8_t> &m : reordered.binary.at(3)) {
    if (m.size() == 1) {
      continue;  // the magic + session message (zeroed)
    }
    std::string meta = meta_at(m, 0);
    if (has(meta, "\"type\":\"end\"")) {
      continue;
    }
    plain.push_back(m);
  }
  std::size_t recarried = 0;
  std::string why;
  check(!model_accepts(plain, make_template(Delivery::Inline).resources.inline_max_bytes, &recarried, &why) &&
            why.rfind("resource-missing", 0) == 0,
        "HC5 sabotage reorder: the receiver model refuses the stream with resource-missing: " +
            why);
  std::vector<std::vector<std::uint8_t>> honest;
  for (const std::vector<std::uint8_t> &m : thread_run.binary.at(3)) {
    if (m.size() == 1 || has(meta_at(m, 0), "\"type\":\"end\"")) {
      continue;
    }
    honest.push_back(m);
  }
  why.clear();
  check(model_accepts(honest, make_template(Delivery::Inline).resources.inline_max_bytes, &recarried, &why),
        "HC5: the honest encode thread's /11 stream passes the receiver model " + why);
}

int main(int argc, char **argv) {
  // HC5: `--formation=thread` runs every hub here through the encode thread (each frame callback
  // waiting for its own jobs, so the fake transport is read as before): the same checks hold.
  for (int i = 1; i < argc; ++i) {
    if (std::string(argv[i]) == "--formation=thread") {
      grc::rs2::set_default_formation(grc::rs2::Formation::Thread, true);
    }
  }
  test_pm1_multimesh_buffer_f();
  test_pm5_v11_viewer_of_v12_host();
  grc::make_directories(std::string(GRC_TEST_TMP_DIR) + "/drop");
  test_v6_and_v7_on_one_hub();
  test_v8_connection();
  test_v9_connection();
  test_v10_connection();
  test_v7_hello_token();
  test_preflight_attribution();
  test_control_parser();
  test_v3_hub_and_control();
  test_v4_hub_and_control();
  test_v7_control_parser();
  test_hello_and_first_transaction();
  test_credit_stages();
  test_resync();
  test_message_too_large();
  test_hello_timeout_and_protocol();
  test_drop_message_finish_and_log();
  test_receiver_close();
  test_latency_stats();
  test_stall_coalescing();
  test_ignore_credit();
  test_stale_coalesce();
  test_inline_resources();
  test_carried_bounded();
  test_shared_publication_bytes();
  test_carried_index();
  test_served_resources();
  test_served_coded_bodies();
  test_hc4b_shared_maps_and_serving();
  test_rate_uncapped_unchanged();
  test_rate_targets();
  test_rate_credit_blocked_and_no_burst();
  test_rate_two_connections();
  test_records_from_base_and_target();
  test_v11_connections();
  test_v11_live_coding();
  test_hc5_formation_thread();
  std::printf("rs_live_test: %d checks, %d failures\n", g_checks, g_failures);
  return g_failures == 0 ? 0 : 1;
}
