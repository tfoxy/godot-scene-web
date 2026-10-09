#include "rs_live.h"

#include <algorithm>
#include <cerrno>
#include <chrono>
#include <cstring>
#include <set>
#include <utility>

#include "report.h"
#include "rs2_codec.h"
#include "rs2_diff.h"
#include "rs_publish.h"
#include "rs_ws.h"

namespace grc {
namespace rs2 {

namespace {

constexpr std::uint64_t kMaxInteger = 9007199254740991ULL;  // 2^53 - 1

std::uint64_t monotonic_ns() {
  return static_cast<std::uint64_t>(
      std::chrono::duration_cast<std::chrono::nanoseconds>(
          std::chrono::steady_clock::now().time_since_epoch())
          .count());
}

std::uint64_t saturating_add(std::uint64_t a, std::uint64_t b) {
  const std::uint64_t sum = a + b;
  return sum > kMaxInteger ? kMaxInteger : sum;
}

// ------------------------------------------------------------------ compact JSON lines

void append_escaped(std::string &out, const std::string &value) {
  out.push_back('"');
  for (const char ch : value) {
    const unsigned char c = static_cast<unsigned char>(ch);
    switch (c) {
      case '"':
        out += "\\\"";
        break;
      case '\\':
        out += "\\\\";
        break;
      case '\n':
        out += "\\n";
        break;
      case '\r':
        out += "\\r";
        break;
      case '\t':
        out += "\\t";
        break;
      default:
        if (c < 0x20 || c > 0x7E) {
          out.push_back('?');  // printable ASCII only, as the record meta (render-stream-0.md)
        } else {
          out.push_back(static_cast<char>(c));
        }
    }
  }
  out.push_back('"');
}

// A one-line JSON object builder: {"k":v,...}.
class Line {
 public:
  Line() { out_.push_back('{'); }
  Line &str(const char *key, const std::string &value) {
    sep(key);
    append_escaped(out_, value);
    return *this;
  }
  Line &num(const char *key, std::uint64_t value) {
    sep(key);
    out_ += std::to_string(value);
    return *this;
  }
  Line &snum(const char *key, std::int64_t value) {
    sep(key);
    out_ += std::to_string(value);
    return *this;
  }
  Line &boolean(const char *key, bool value) {
    sep(key);
    out_ += value ? "true" : "false";
    return *this;
  }
  Line &null(const char *key) {
    sep(key);
    out_ += "null";
    return *this;
  }
  Line &raw(const char *key, const std::string &json) {
    sep(key);
    out_ += json;
    return *this;
  }
  std::string take() {
    out_.push_back('}');
    return std::move(out_);
  }

 private:
  void sep(const char *key) {
    if (out_.size() > 1) {
      out_.push_back(',');
    }
    append_escaped(out_, key);
    out_.push_back(':');
  }
  std::string out_;
};

// ------------------------------------------------------------------ control-message parser

struct Value {
  bool is_string = false;
  std::string text;
  std::uint64_t number = 0;
};

class Parser {
 public:
  explicit Parser(const std::string &text) : s_(text) {}

  bool parse(std::vector<std::pair<std::string, Value>> *fields, std::string *error) {
    skip_ws();
    if (!expect('{')) {
      return fail(error, "not a JSON object");
    }
    skip_ws();
    if (peek() == '}') {
      ++p_;
    } else {
      for (;;) {
        skip_ws();
        std::string key;
        if (peek() != '"' || !string(&key)) {
          return fail(error, "expected a string key at byte " + std::to_string(p_));
        }
        skip_ws();
        if (!expect(':')) {
          return fail(error, "expected ':' after key \"" + key + "\"");
        }
        skip_ws();
        Value value;
        const char c = peek();
        if (c == '"') {
          value.is_string = true;
          if (!string(&value.text)) {
            return fail(error, "bad string value for \"" + key + "\"");
          }
        } else if (c >= '0' && c <= '9') {
          if (!integer(&value.number)) {
            return fail(error, "\"" + key + "\" is not a non-negative integer <= 2^53-1");
          }
        } else {
          return fail(error, "\"" + key +
                                 "\": only strings and non-negative integers are allowed (flat "
                                 "object)");
        }
        for (const auto &field : *fields) {
          if (field.first == key) {
            return fail(error, "duplicate key \"" + key + "\"");
          }
        }
        fields->emplace_back(std::move(key), std::move(value));
        skip_ws();
        if (peek() == ',') {
          ++p_;
          continue;
        }
        if (peek() == '}') {
          ++p_;
          break;
        }
        return fail(error, "expected ',' or '}' at byte " + std::to_string(p_));
      }
    }
    skip_ws();
    if (p_ != s_.size()) {
      return fail(error, "trailing bytes after the object");
    }
    return true;
  }

 private:
  char peek() const { return p_ < s_.size() ? s_[p_] : '\0'; }
  bool expect(char c) {
    if (peek() != c) {
      return false;
    }
    ++p_;
    return true;
  }
  void skip_ws() {
    while (p_ < s_.size() &&
           (s_[p_] == ' ' || s_[p_] == '\t' || s_[p_] == '\n' || s_[p_] == '\r')) {
      ++p_;
    }
  }
  static bool fail(std::string *error, const std::string &text) {
    if (error != nullptr) {
      *error = text;
    }
    return false;
  }
  bool string(std::string *out) {
    if (!expect('"')) {
      return false;
    }
    while (p_ < s_.size()) {
      const unsigned char c = static_cast<unsigned char>(s_[p_++]);
      if (c == '"') {
        return true;
      }
      if (c < 0x20) {
        return false;
      }
      if (c != '\\') {
        out->push_back(static_cast<char>(c));
        continue;
      }
      if (p_ >= s_.size()) {
        return false;
      }
      const char e = s_[p_++];
      switch (e) {
        case '"':
        case '\\':
        case '/':
          out->push_back(e);
          break;
        case 'b':
          out->push_back('\b');
          break;
        case 'f':
          out->push_back('\f');
          break;
        case 'n':
          out->push_back('\n');
          break;
        case 'r':
          out->push_back('\r');
          break;
        case 't':
          out->push_back('\t');
          break;
        case 'u': {
          if (p_ + 4 > s_.size()) {
            return false;
          }
          unsigned code = 0;
          for (int i = 0; i < 4; ++i) {
            const char h = s_[p_++];
            code <<= 4;
            if (h >= '0' && h <= '9') {
              code |= static_cast<unsigned>(h - '0');
            } else if (h >= 'a' && h <= 'f') {
              code |= static_cast<unsigned>(h - 'a' + 10);
            } else if (h >= 'A' && h <= 'F') {
              code |= static_cast<unsigned>(h - 'A' + 10);
            } else {
              return false;
            }
          }
          // Control messages are ASCII; anything else is kept as '?'.
          out->push_back(code < 0x80 ? static_cast<char>(code) : '?');
          break;
        }
        default:
          return false;
      }
    }
    return false;
  }
  bool integer(std::uint64_t *out) {
    const std::size_t start = p_;
    while (p_ < s_.size() && s_[p_] >= '0' && s_[p_] <= '9') {
      ++p_;
    }
    const std::size_t digits = p_ - start;
    if (digits == 0 || digits > 16 || (digits > 1 && s_[start] == '0')) {
      return false;
    }
    // A fraction or exponent makes it a float, which control messages never carry.
    if (peek() == '.' || peek() == 'e' || peek() == 'E') {
      return false;
    }
    std::uint64_t value = 0;
    for (std::size_t i = start; i < p_; ++i) {
      value = value * 10 + static_cast<std::uint64_t>(s_[i] - '0');
    }
    if (value > kMaxInteger) {
      return false;
    }
    *out = value;
    return true;
  }

  const std::string &s_;
  std::size_t p_ = 0;
};

bool is_lower_hex(const std::string &text, std::size_t length) {
  return text.size() == length && std::all_of(text.begin(), text.end(), [](char c) {
           return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f');
         });
}

bool stage_from(const std::string &text, AckStage *out) {
  if (text == "received") {
    *out = AckStage::Received;
  } else if (text == "applied") {
    *out = AckStage::Applied;
  } else if (text == "submitted") {
    *out = AckStage::Submitted;
  } else {
    return false;
  }
  return true;
}

std::size_t stage_index(AckStage stage) { return static_cast<std::size_t>(stage); }

}  // namespace

const char *to_wire(AckStage stage) {
  switch (stage) {
    case AckStage::Received:
      return "received";
    case AckStage::Applied:
      return "applied";
    case AckStage::Submitted:
      return "submitted";
  }
  return "received";
}

bool parse_control(const std::string &text, ControlMessage *out, std::string *error) {
  std::vector<std::pair<std::string, Value>> fields;
  Parser parser(text);
  if (!parser.parse(&fields, error)) {
    return false;
  }
  const auto fail = [error](const std::string &detail) {
    if (error != nullptr) {
      *error = detail;
    }
    return false;
  };
  const auto find = [&fields](const char *key) -> const Value * {
    for (const auto &field : fields) {
      if (field.first == key) {
        return &field.second;
      }
    }
    return nullptr;
  };
  const Value *type = find("type");
  if (type == nullptr || !type->is_string) {
    return fail("missing string \"type\"");
  }
  std::vector<std::string> keys;
  ControlMessage message;
  if (type->text == "hello") {
    message.type = ControlType::Hello;
    keys = {"type", "protocol", "receiver", "credit_stage", "inbound_buffer_bytes"};
  } else if (type->text == "ack") {
    message.type = ControlType::Ack;
    keys = {"type", "stream_id", "seq", "stage", "t_us"};
  } else if (type->text == "resync") {
    message.type = ControlType::Resync;
    keys = {"type", "stream_id", "seq", "reason"};
  } else if (type->text == "error") {
    message.type = ControlType::Error;
    keys = {"type", "reason", "detail"};
  } else {
    return fail("unknown type \"" + type->text + "\"");
  }
  for (const auto &field : fields) {
    if (std::find(keys.begin(), keys.end(), field.first) == keys.end()) {
      return fail("unknown key \"" + field.first + "\" for type " + type->text);
    }
  }
  for (const std::string &key : keys) {
    if (find(key.c_str()) == nullptr) {
      return fail("missing key \"" + key + "\" for type " + type->text);
    }
  }
  const auto str = [&](const char *key, std::string *dst) {
    const Value *value = find(key);
    if (!value->is_string) {
      return fail(std::string("\"") + key + "\" must be a string");
    }
    *dst = value->text;
    return true;
  };
  const auto num = [&](const char *key, std::uint64_t *dst) {
    const Value *value = find(key);
    if (value->is_string) {
      return fail(std::string("\"") + key + "\" must be an integer");
    }
    *dst = value->number;
    return true;
  };
  switch (message.type) {
    case ControlType::Hello: {
      std::string stage;
      if (!str("protocol", &message.protocol) || !str("receiver", &message.receiver) ||
          !str("credit_stage", &stage) ||
          !num("inbound_buffer_bytes", &message.inbound_buffer_bytes)) {
        return false;
      }
      if (stage == "submitted") {
        message.credit_stage = AckStage::Submitted;
      } else if (stage == "applied") {
        message.credit_stage = AckStage::Applied;
      } else {
        return fail("credit_stage \"" + stage + "\" is not submitted or applied");
      }
      // render-stream-2.md "Golden vectors": a hello for another version is invalid.
      if (message.protocol != kProtocol) {
        return fail("hello.protocol \"" + message.protocol + "\" is not " + kProtocol);
      }
      break;
    }
    case ControlType::Ack: {
      std::string stage;
      if (!str("stream_id", &message.stream_id) || !num("seq", &message.seq) ||
          !str("stage", &stage) || !num("t_us", &message.t_us)) {
        return false;
      }
      if (!stage_from(stage, &message.stage)) {
        return fail("stage \"" + stage + "\" is not received, applied or submitted");
      }
      break;
    }
    case ControlType::Resync:
      if (!str("stream_id", &message.stream_id) || !num("seq", &message.seq) ||
          !str("reason", &message.reason)) {
        return false;
      }
      break;
    case ControlType::Error:
      if (!str("reason", &message.reason) || !str("detail", &message.detail)) {
        return false;
      }
      break;
  }
  if ((message.type == ControlType::Ack || message.type == ControlType::Resync)) {
    if (!is_lower_hex(message.stream_id, 32)) {
      return fail("stream_id is not 32 lowercase hex");
    }
    if (message.seq < 1) {
      return fail("seq must be >= 1");
    }
  }
  *out = std::move(message);
  return true;
}

std::string encode_error(const std::string &reason, const std::string &detail) {
  return Line().str("type", "error").str("reason", reason).str("detail", detail).take();
}

// ----------------------------------------------------------------- transport adapter

bool ServerTransport::send_binary(std::uint32_t conn, std::vector<std::uint8_t> message) {
  return server_->send_binary(conn, std::move(message));
}
bool ServerTransport::send_text(std::uint32_t conn, std::string message) {
  return server_->send_text(conn, std::move(message));
}
void ServerTransport::close(std::uint32_t conn, std::uint16_t code, std::string reason) {
  server_->close(conn, code, std::move(reason));
}
std::uint64_t ServerTransport::queued_bytes(std::uint32_t conn) const {
  return server_->stats(conn).queued_bytes;
}
std::uint64_t ServerTransport::max_queued_bytes(std::uint32_t conn) const {
  return server_->stats(conn).max_queued_bytes;
}

LiveEvent to_live_event(const live::Event &event) {
  LiveEvent out;
  switch (event.kind) {
    case live::Event::Opened:
      out.kind = LiveEvent::Opened;
      break;
    case live::Event::Text:
      out.kind = LiveEvent::Text;
      break;
    case live::Event::Closed:
      out.kind = LiveEvent::Closed;
      break;
    case live::Event::HttpGet:
      // Resource GETs are not session events: entry.cpp's live_drain() hands them to
      // Hub::on_http_get() and never forwards one here; this case exists only so the switch
      // stays exhaustive under -Wswitch.
      break;
  }
  out.conn = event.conn;
  out.text = event.text;
  out.code = event.code;
  out.reason = event.reason;
  out.t_ns = event.t_ns;
  return out;
}

LatencyStats latency_stats(std::vector<std::uint64_t> samples) {
  LatencyStats out;
  if (samples.empty()) {
    return out;
  }
  std::sort(samples.begin(), samples.end());
  const std::size_t n = samples.size();
  out.count = n;
  out.min = samples.front();
  out.max = samples.back();
  out.median = samples[(n - 1) / 2];
  // Nearest rank: the smallest sample with at least 95 % of the samples at or below it.
  std::size_t rank = (95 * n + 99) / 100;
  rank = std::max<std::size_t>(rank, 1);
  out.p95 = samples[rank - 1];
  return out;
}

// ----------------------------------------------------------------- hub

struct Hub::Conn {
  std::uint32_t id = 0;
  ConnectionSummary s;
  State state = State::AwaitHello;
  std::uint64_t opened_ns = 0;
  bool hello_received = false;
  AckStage credit_stage = AckStage::Submitted;
  Session session;
  std::uint64_t next_seq = 1;
  std::optional<std::uint64_t> in_flight;
  std::set<std::uint64_t> uncredited;  // sent seqs whose credit has not returned
  bool credit = false;
  Snapshot base;
  bool has_base = false;
  rs::PayloadMap base_payloads;  // G2c2: the payloads `base` names (the pin, D7)
  bool resync = false;
  std::uint64_t epoch_sent = 0;
  bool pending = false;
  std::uint64_t pending_since_frame = 0;  // the callback that made the current target pending
  std::uint64_t pending_since_ns = 0;
  std::optional<rs::Captured> stale;  // stale-coalesce: the first missed target since the last send
  std::set<std::string> carried;  // G2b2: payload hashes this connection already carried inline
  std::uint64_t stale_frame = 0;
  EndStats stats;
  struct Sent {
    std::uint64_t ns = 0;
    std::uint64_t frame = 0;
    unsigned acked = 0;  // bit per stage already timed
  };
  std::map<std::uint64_t, Sent> sent_at;
  std::vector<std::uint64_t> latency[3];
  std::vector<std::uint64_t> credit_rtt;
  std::vector<std::uint64_t> credit_frames;
  std::FILE *tap = nullptr;
  std::FILE *log = nullptr;
};

Hub::Hub(LiveTransport *transport, LiveConfig config, Session session_template)
    : transport_(transport), config_(std::move(config)), template_(std::move(session_template)) {}

Hub::~Hub() {
  for (auto &entry : conns_) {
    close_files(*entry.second);
  }
}

Hub::Conn *Hub::find(std::uint32_t conn_id) {
  const auto it = conns_.find(conn_id);
  return it == conns_.end() ? nullptr : it->second.get();
}

void Hub::log_line(Conn &c, const std::string &line) {
  if (c.log == nullptr) {
    return;
  }
  std::fwrite(line.data(), 1, line.size(), c.log);
  std::fputc('\n', c.log);
  std::fflush(c.log);
}

void Hub::close_files(Conn &c) {
  if (c.tap != nullptr) {
    std::fclose(c.tap);
    c.tap = nullptr;
  }
  if (c.log != nullptr) {
    std::fclose(c.log);
    c.log = nullptr;
  }
}

void Hub::host_close(Conn &c, std::uint16_t code, const std::string &reason) {
  if (c.state == State::Closed) {
    return;
  }
  transport_->close(c.id, code, reason);
  c.state = State::Closed;
  c.s.close_code = code;
  c.s.closed_by = "host";
  c.s.close_reason = reason;
  log_line(c, Line()
                  .num("frame", frame_)
                  .num("t_us", monotonic_ns() / 1000)
                  .str("event", "close")
                  .num("code", code)
                  .str("reason", reason)
                  .str("closed_by", "host")
                  .take());
  close_files(c);
}

void Hub::protocol_error(Conn &c, const std::string &detail, std::uint64_t frame,
                         std::uint64_t t_ns) {
  transport_->send_text(c.id, encode_error("protocol", detail));
  c.s.error_sent = "protocol";
  log_line(c, Line()
                  .num("frame", frame)
                  .num("t_us", t_ns / 1000)
                  .str("event", "error")
                  .str("reason", "protocol")
                  .str("detail", detail)
                  .take());
  host_close(c, 1002, "protocol");
}

void Hub::on_event(const LiveEvent &event, std::uint64_t frame) {
  frame_ = frame;
  if (finished_ && event.kind == LiveEvent::Opened) {
    // A connection that arrives after finish is closed at once and not tracked. Text and Closed
    // events still count during the linger: late acks feed timing (nothing is sent any more).
    transport_->close(event.conn, 1000, finish_reason_);
    return;
  }
  switch (event.kind) {
    case LiveEvent::Opened: {
      auto conn = std::make_unique<Conn>();
      Conn &c = *conn;
      c.id = event.conn;
      c.s.connection = next_connection_++;
      c.s.stream_id = generate_id();
      c.opened_ns = event.t_ns;
      if (!config_.tap_dir.empty() && make_directories(config_.tap_dir)) {
        const std::string n = std::to_string(c.s.connection);
        c.tap = std::fopen(path_join(config_.tap_dir, "stream-" + n + ".rs2").c_str(), "wb");
        c.log = std::fopen(path_join(config_.tap_dir, "live-" + n + ".jsonl").c_str(), "wb");
      }
      conns_[event.conn] = std::move(conn);
      log_line(c, Line()
                      .num("frame", frame)
                      .num("t_us", event.t_ns / 1000)
                      .str("event", "open")
                      .num("connection", c.s.connection)
                      .str("stream_id", c.s.stream_id)
                      .take());
      return;
    }
    case LiveEvent::Text: {
      Conn *c = find(event.conn);
      if (c == nullptr || c->state == State::Closed) {
        return;
      }
      handle_text(*c, event, frame);
      return;
    }
    case LiveEvent::Closed: {
      Conn *c = find(event.conn);
      if (c == nullptr || c->state == State::Closed) {
        return;  // already closed by the host (host_close logged it)
      }
      c->state = State::Closed;
      c->s.close_code = event.code;
      c->s.closed_by = "receiver";
      c->s.close_reason = event.reason;
      log_line(*c, Line()
                       .num("frame", frame)
                       .num("t_us", event.t_ns / 1000)
                       .str("event", "close")
                       .num("code", event.code)
                       .str("reason", event.reason)
                       .str("closed_by", "receiver")
                       .take());
      close_files(*c);
      return;
    }
  }
}

void Hub::handle_text(Conn &c, const LiveEvent &event, std::uint64_t frame) {
  ControlMessage message;
  std::string error;
  if (!parse_control(event.text, &message, &error)) {
    protocol_error(c, "bad control message: " + error, frame, event.t_ns);
    return;
  }
  switch (message.type) {
    case ControlType::Error:
      protocol_error(c, "a receiver sent an error message", frame, event.t_ns);
      return;
    case ControlType::Hello: {
      if (c.hello_received) {
        protocol_error(c, "second hello", frame, event.t_ns);
        return;
      }
      if (message.protocol != kProtocol) {
        protocol_error(c, "hello.protocol \"" + message.protocol + "\" is not " + kProtocol,
                       frame, event.t_ns);
        return;
      }
      c.hello_received = true;
      c.credit = true;  // the hello is the credit for the session and seq 1
      c.credit_stage = message.credit_stage;
      c.s.receiver = message.receiver;
      c.s.credit_stage = to_wire(message.credit_stage);
      c.s.inbound_buffer_bytes = message.inbound_buffer_bytes;
      c.s.max_message_bytes = std::min(message.inbound_buffer_bytes, config_.max_message_bytes);
      log_line(c, Line()
                      .num("frame", frame)
                      .num("t_us", event.t_ns / 1000)
                      .str("event", "hello")
                      .str("receiver", message.receiver)
                      .str("credit_stage", c.s.credit_stage)
                      .num("inbound_buffer_bytes", message.inbound_buffer_bytes)
                      .num("max_message_bytes", c.s.max_message_bytes)
                      .take());
      return;
    }
    case ControlType::Ack:
    case ControlType::Resync: {
      const bool is_ack = message.type == ControlType::Ack;
      if (c.state != State::Streaming) {
        protocol_error(c, std::string(is_ack ? "ack" : "resync") + " before the stream started",
                       frame, event.t_ns);
        return;
      }
      if (message.seq >= c.next_seq) {
        protocol_error(c,
                       std::string(is_ack ? "ack" : "resync") + " for seq " +
                           std::to_string(message.seq) + ", never formed (next seq " +
                           std::to_string(c.next_seq) + ")",
                       frame, event.t_ns);
        return;
      }
      std::string ignored;
      bool credited = false;
      const auto sent = c.sent_at.find(message.seq);
      if (message.stream_id != c.s.stream_id) {
        ignored = "stream-id";
      } else {
        const bool credit_message =
            !is_ack || message.stage == c.credit_stage;  // a resync always answers the credit
        if (is_ack) {
          ++c.s.acks[stage_index(message.stage)];
          if (sent != c.sent_at.end()) {
            const unsigned bit = 1u << stage_index(message.stage);
            if ((sent->second.acked & bit) == 0) {
              sent->second.acked |= bit;
              c.latency[stage_index(message.stage)].push_back(
                  (event.t_ns - std::min(event.t_ns, sent->second.ns)) / 1000);
            }
          }
        }
        if (credit_message) {
          // Any credit-stage answer settles its own seq, so `uncredited` (max_in_flight) counts
          // the seqs still outstanding even when ignore-credit put several in flight; only the
          // in-flight seq returns the credit.
          c.uncredited.erase(message.seq);
          if (c.in_flight.has_value() && *c.in_flight == message.seq) {
            credited = true;
            c.credit = true;
            c.in_flight.reset();
            ++c.s.credits;
            if (!is_ack) {
              c.resync = true;
              ++c.s.resyncs;
            }
            if (sent != c.sent_at.end()) {
              c.credit_rtt.push_back((event.t_ns - std::min(event.t_ns, sent->second.ns)) / 1000);
              c.credit_frames.push_back(frame - std::min(frame, sent->second.frame));
            }
          } else {
            ignored = "stale";
          }
        }
      }
      if (!ignored.empty()) {
        ++c.s.acks_ignored;
      }
      Line line;
      line.num("frame", frame)
          .num("t_us", event.t_ns / 1000)
          .str("event", is_ack ? "ack" : "resync")
          .num("seq", message.seq)
          .str("stream_id", message.stream_id);
      if (is_ack) {
        line.str("stage", to_wire(message.stage)).num("receiver_t_us", message.t_us);
      } else {
        line.str("reason", message.reason);
      }
      line.boolean("credited", credited);
      if (ignored.empty()) {
        line.null("ignored");
      } else {
        line.str("ignored", ignored);
      }
      log_line(c, line.take());
      return;
    }
  }
}

bool Hub::wants_snapshot(std::uint64_t frame) const {
  const bool ignore_credit =
      config_.ignore_credit_frame != 0 && frame >= config_.ignore_credit_frame;
  const bool stale_coalesce =
      config_.stale_coalesce_frame != 0 && frame >= config_.stale_coalesce_frame;
  for (const auto &entry : conns_) {
    const Conn &c = *entry.second;
    if ((c.state == State::AwaitHello && c.hello_received) ||
        (c.state == State::Streaming &&
         (c.credit || ignore_credit || (stale_coalesce && !c.stale.has_value())))) {
      return true;
    }
  }
  return false;
}

void Hub::note_pending_age(Conn &c, std::uint64_t frame, std::uint64_t now_ns) {
  c.s.max_pending_frames =
      std::max(c.s.max_pending_frames, frame - std::min(frame, c.pending_since_frame));
  c.s.max_pending_age_us = std::max(
      c.s.max_pending_age_us, (now_ns - std::min(now_ns, c.pending_since_ns)) / 1000);
}

bool Hub::deliver(Conn &c, const std::vector<std::uint8_t> &message, bool send) {
  if (c.tap != nullptr) {
    std::fwrite(message.data(), 1, message.size(), c.tap);
    std::fflush(c.tap);
  }
  c.s.max_message_sent = std::max<std::uint64_t>(c.s.max_message_sent, message.size());
  if (!send) {
    return true;
  }
  c.s.bytes_sent += message.size();
  return transport_->send_binary(c.id, message);
}

std::string Hub::send_transaction(Conn &c, const rs::Captured &snapshot, std::uint64_t frame,
                                  std::uint64_t now_ns, std::uint64_t epoch,
                                  std::uint64_t snapshot_ns, bool first,
                                  std::uint64_t stale_from) {
  // G2b2: the inline payloads this connection has not carried yet, one resource record per
  // message, ahead of the transaction that needs them (render-stream-2.md "Live transport").
  for (const TextureEntry &entry : snapshot.state.textures) {
    if (entry.kind != TextureKind::Image || entry.status != TextureStatus::Ok || !entry.has_hash ||
        entry.payload_bytes > template_.resources.inline_max_bytes ||
        c.carried.count(entry.hash) != 0) {
      continue;
    }
    const auto payload = snapshot.payloads.find(entry.hash);
    if (payload == snapshot.payloads.end() || payload->second == nullptr) {
      continue;  // never happens: a Captured holds every ok image's payload
    }
    ResourceRecord record;
    record.hash = entry.hash;
    record.payload = *payload->second;
    const std::vector<std::uint8_t> bytes = encode_resource(record);
    if (bytes.size() > c.s.max_message_bytes) {
      const std::string detail = "resource " + entry.hash + " is " +
                                 std::to_string(bytes.size()) + " bytes, the cap is " +
                                 std::to_string(c.s.max_message_bytes);
      transport_->send_text(c.id, encode_error("message-too-large", detail));
      c.s.error_sent = "message-too-large";
      log_line(c, Line()
                      .num("frame", frame)
                      .num("t_us", now_ns / 1000)
                      .str("event", "error")
                      .str("reason", "message-too-large")
                      .str("detail", detail)
                      .take());
      host_close(c, 1009, "message-too-large");
      return "null";
    }
    deliver(c, bytes, true);
    c.carried.insert(entry.hash);
    ++c.s.resource_records;
    c.s.resource_bytes += record.payload.size();
    ++c.stats.resource_records;
    c.stats.resource_bytes += record.payload.size();
    c.stats.bytes_total += bytes.size();
    c.stats.max_record_bytes = std::max<std::uint64_t>(c.stats.max_record_bytes, bytes.size());
    log_line(c, Line()
                    .num("frame", frame)
                    .num("t_us", now_ns / 1000)
                    .str("event", "resource")
                    .str("hash", entry.hash)
                    .num("bytes", record.payload.size())
                    .take());
  }
  Snapshot cur = snapshot.state;
  cur.seq = c.next_seq;
  cur.frame = frame;
  const bool full = !c.has_base || c.resync;
  const std::uint64_t t0 = monotonic_ns();
  Transaction transaction = full ? make_full(cur) : make_patch(c.base, cur);
  const std::uint64_t t1 = monotonic_ns();
  const std::vector<std::uint8_t> bytes = encode_transaction(transaction);
  const std::uint64_t t2 = monotonic_ns();
  if (bytes.size() > c.s.max_message_bytes) {
    const std::string detail = "transaction " + std::to_string(cur.seq) + " is " +
                               std::to_string(bytes.size()) + " bytes, the cap is " +
                               std::to_string(c.s.max_message_bytes);
    transport_->send_text(c.id, encode_error("message-too-large", detail));
    c.s.error_sent = "message-too-large";
    log_line(c, Line()
                    .num("frame", frame)
                    .num("t_us", now_ns / 1000)
                    .str("event", "error")
                    .str("reason", "message-too-large")
                    .str("detail", detail)
                    .take());
    host_close(c, 1009, "message-too-large");
    return "null";
  }
  const bool drop = !first && config_.drop_message_frame != 0 && !drop_done_ &&
                    frame >= config_.drop_message_frame;
  if (!deliver(c, bytes, !drop)) {
    log_line(c, Line()
                    .num("frame", frame)
                    .num("t_us", now_ns / 1000)
                    .str("event", "error")
                    .str("reason", "send-failed")
                    .str("detail", "the transport refused seq " + std::to_string(cur.seq))
                    .take());
  }
  ++c.s.transactions;
  if (full) {
    ++c.s.full;
    ++c.stats.full_transactions;
  } else {
    ++c.s.patch;
    ++c.stats.patch_transactions;
  }
  c.stats.bytes_total += bytes.size();
  c.stats.max_record_bytes = std::max<std::uint64_t>(c.stats.max_record_bytes, bytes.size());
  c.stats.encode_ns_total =
      saturating_add(c.stats.encode_ns_total, (full ? t1 - t0 : 0) + (t2 - t1));
  c.stats.diff_ns_total = saturating_add(c.stats.diff_ns_total, full ? 0 : t1 - t0);
  c.stats.snapshot_ns_total = saturating_add(c.stats.snapshot_ns_total, snapshot_ns);

  const std::uint64_t seq = cur.seq;
  const bool had_credit = c.credit;
  c.base = std::move(cur);
  c.has_base = true;
  c.base_payloads = snapshot.payloads;
  c.resync = false;
  ++c.next_seq;
  c.epoch_sent = epoch;
  if (c.pending) {
    note_pending_age(c, frame, now_ns);  // the pending target is replaced by this send
  }
  c.pending = false;
  if (stale_from != 0) {
    ++c.s.stale_sent;
  }
  if (drop) {
    // drop-message: formed, logged and tapped, never sent; the credit is restored at once.
    drop_done_ = true;
    ++c.s.dropped;
    c.credit = true;
  } else {
    ++c.s.sent;
    if (!had_credit) {
      ++c.s.sent_without_credit;  // ignore-credit
    }
    c.credit = false;
    c.in_flight = seq;
    c.uncredited.insert(seq);
    c.sent_at[seq] = Conn::Sent{now_ns, frame, 0};
    c.s.max_in_flight = std::max<std::uint64_t>(c.s.max_in_flight, c.uncredited.size());
  }
  Line sent;
  sent.num("seq", seq).str("encoding", full ? "full" : "patch").num("bytes", bytes.size());
  if (drop) {
    sent.boolean("dropped", true);
  }
  if (stale_from != 0) {
    sent.num("stale_from", stale_from);
  }
  return sent.take();
}

void Hub::log_frame(Conn &c, std::uint64_t frame, std::uint64_t now_ns, bool credit_before,
                    const std::string &sent_json) {
  const std::uint64_t queued = transport_->queued_bytes(c.id);
  c.s.max_queued_bytes =
      std::max({c.s.max_queued_bytes, queued, transport_->max_queued_bytes(c.id)});
  Line line;
  line.num("frame", frame)
      .num("t_us", now_ns / 1000)
      .str("state", c.state == State::AwaitHello ? "await-hello"
                    : c.state == State::Streaming ? "streaming"
                                                  : "closed")
      .boolean("credit", credit_before);
  if (c.in_flight.has_value()) {
    line.num("in_flight", *c.in_flight);
  } else {
    line.null("in_flight");
  }
  line.boolean("pending", c.pending);
  if (c.pending) {
    line.num("pending_since", c.pending_since_frame);
  } else {
    line.null("pending_since");
  }
  line.num("coalesced", c.s.coalesced)
      .num("queued_bytes", queued)
      .raw("sent", sent_json);
  log_line(c, line.take());
}

void Hub::on_frame(std::uint64_t frame, std::uint64_t now_ns, const rs::Captured *snapshot,
                   std::uint64_t epoch, std::uint64_t snapshot_ns) {
  if (finished_) {
    return;
  }
  frame_ = frame;
  for (auto &entry : conns_) {
    Conn &c = *entry.second;
    if (c.state == State::Closed) {
      continue;
    }
    const bool credit_before = c.credit;
    std::string sent_json = "null";
    if (c.state == State::AwaitHello) {
      if (c.hello_received) {
        if (snapshot == nullptr) {
          continue;  // the caller did not provide one; try at the next callback
        }
        c.session = template_;
        c.session.stream.stream_id = c.s.stream_id;
        c.session.stream.has_connection = true;
        c.session.stream.connection = c.s.connection;
        c.session.stream.transport = Transport::Websocket;
        c.session.stream.encoding = Encoding::Patch;
        const std::uint64_t t0 = monotonic_ns();
        const std::vector<std::uint8_t> session_bytes = encode_session(c.session);
        const std::uint64_t t1 = monotonic_ns();
        std::vector<std::uint8_t> message = magic();
        message.insert(message.end(), session_bytes.begin(), session_bytes.end());
        if (message.size() > c.s.max_message_bytes) {
          const std::string detail = "the session message is " + std::to_string(message.size()) +
                                     " bytes, the cap is " +
                                     std::to_string(c.s.max_message_bytes);
          transport_->send_text(c.id, encode_error("message-too-large", detail));
          c.s.error_sent = "message-too-large";
          host_close(c, 1009, "message-too-large");
          continue;
        }
        deliver(c, message, true);
        c.stats.bytes_total += message.size();  // the magic counts (render-stream-0.md)
        c.stats.max_record_bytes =
            std::max<std::uint64_t>(c.stats.max_record_bytes, session_bytes.size());
        c.stats.encode_ns_total = saturating_add(c.stats.encode_ns_total, t1 - t0);
        c.state = State::Streaming;
        ++c.s.frames_offered;
        sent_json = send_transaction(c, *snapshot, frame, now_ns, epoch, snapshot_ns, true);
      } else if (now_ns > c.opened_ns &&
                 (now_ns - c.opened_ns) / 1000000 > config_.hello_timeout_ms) {
        const std::string detail =
            "no hello within " + std::to_string(config_.hello_timeout_ms) + " ms";
        transport_->send_text(c.id, encode_error("hello-timeout", detail));
        c.s.error_sent = "hello-timeout";
        log_line(c, Line()
                        .num("frame", frame)
                        .num("t_us", now_ns / 1000)
                        .str("event", "error")
                        .str("reason", "hello-timeout")
                        .str("detail", detail)
                        .take());
        host_close(c, 1002, "hello-timeout");
        continue;
      }
    } else if (c.state == State::Streaming) {
      ++c.s.frames_offered;
      const bool ignore_credit =
          config_.ignore_credit_frame != 0 && frame >= config_.ignore_credit_frame;
      if (c.credit && c.stale.has_value()) {
        // stale-coalesce: the first missed target goes out instead of the newest state.
        const rs::Captured stale = std::move(*c.stale);
        c.stale.reset();
        sent_json = send_transaction(c, stale, frame, now_ns, epoch, snapshot_ns, false,
                                     c.stale_frame);
      } else if (c.credit || ignore_credit) {
        if (snapshot == nullptr) {
          continue;
        }
        sent_json = send_transaction(c, *snapshot, frame, now_ns, epoch, snapshot_ns, false);
      } else if (epoch != c.epoch_sent) {
        // No credit and the mirror moved since the last send: the one pending target (the
        // mirror itself) is replaced by this callback's state; nothing is serialized.
        if (!c.pending) {
          c.pending_since_frame = frame;
          c.pending_since_ns = now_ns;
          ++c.s.pending_episodes;
        }
        c.pending = true;
        c.s.max_pending = 1;
        ++c.s.coalesced;
        note_pending_age(c, frame, now_ns);
        if (config_.stale_coalesce_frame != 0 && frame >= config_.stale_coalesce_frame &&
            !c.stale.has_value() && snapshot != nullptr) {
          c.stale = *snapshot;
          c.stale_frame = frame;
        }
      }
    }
    if (c.state == State::Closed) {
      continue;  // closed by an error above (logged there)
    }
    log_frame(c, frame, now_ns, credit_before, sent_json);
  }
}

void Hub::finish(EndReason reason, std::uint64_t frame, std::uint64_t now_ns) {
  if (finished_) {
    return;
  }
  frame_ = frame;
  for (auto &entry : conns_) {
    Conn &c = *entry.second;
    if (c.state == State::Closed) {
      continue;
    }
    if (c.state == State::Streaming) {
      End end;
      end.transactions = c.s.transactions;
      end.reason = reason;
      end.stats = c.stats;
      const std::vector<std::uint8_t> bytes = encode_end(end);
      deliver(c, bytes, true);
      c.s.end_sent = true;
      log_line(c, Line()
                      .num("frame", frame)
                      .num("t_us", now_ns / 1000)
                      .str("event", "end")
                      .str("reason", to_wire(reason))
                      .num("transactions", end.transactions)
                      .num("bytes", bytes.size())
                      .take());
    }
    c.s.max_queued_bytes = std::max(c.s.max_queued_bytes, transport_->max_queued_bytes(c.id));
    if (c.state == State::AwaitHello) {
      host_close(c, 1000, to_wire(reason));  // nothing to read: close at once
    }
  }
  finished_ = true;
  finish_reason_ = to_wire(reason);
}

std::size_t Hub::open_connections() const {
  std::size_t open = 0;
  for (const auto &entry : conns_) {
    if (entry.second->state != State::Closed) {
      ++open;
    }
  }
  return open;
}

void Hub::close_open(std::uint64_t frame) {
  frame_ = frame;
  for (auto &entry : conns_) {
    Conn &c = *entry.second;
    if (c.state != State::Closed) {
      c.s.max_queued_bytes = std::max(c.s.max_queued_bytes, transport_->max_queued_bytes(c.id));
      host_close(c, 1000, finish_reason_.empty() ? std::string("shutdown") : finish_reason_);
    }
  }
}

std::vector<ConnectionSummary> Hub::summaries() const {
  std::vector<ConnectionSummary> out;
  for (const auto &entry : conns_) {
    const Conn &c = *entry.second;
    ConnectionSummary s = c.s;
    for (std::size_t i = 0; i < 3; ++i) {
      s.ack_latency_us[i] = latency_stats(c.latency[i]);
    }
    s.credit_rtt_us = latency_stats(c.credit_rtt);
    s.credit_rtt_frames = latency_stats(c.credit_frames);
    out.push_back(std::move(s));
  }
  std::sort(out.begin(), out.end(), [](const ConnectionSummary &a, const ConnectionSummary &b) {
    return a.connection < b.connection;
  });
  return out;
}

namespace {

void write_latency(JsonWriter *json, const std::string &name, const LatencyStats &stats) {
  json->key(name);
  if (stats.count == 0) {
    json->null();
    return;
  }
  json->object_begin();
  json->field("count", static_cast<int64_t>(stats.count));
  json->field("min", static_cast<int64_t>(stats.min));
  json->field("median", static_cast<int64_t>(stats.median));
  json->field("p95", static_cast<int64_t>(stats.p95));
  json->field("max", static_cast<int64_t>(stats.max));
  json->object_end();
}

}  // namespace

std::vector<const rs::PayloadMap *> Hub::base_payloads() const {
  std::vector<const rs::PayloadMap *> out;
  for (const auto &entry : conns_) {
    const Conn &c = *entry.second;
    if (c.state != State::Closed && c.has_base) {
      out.push_back(&c.base_payloads);
    }
  }
  return out;
}

std::vector<const rs::PayloadMap *> Hub::held_payloads() const {
  std::vector<const rs::PayloadMap *> out;
  for (const auto &entry : conns_) {
    const Conn &c = *entry.second;
    if (c.state != State::Closed && c.stale.has_value()) {
      out.push_back(&c.stale->payloads);
    }
  }
  return out;
}

std::uint32_t Hub::on_http_get(const std::string &hash, std::uint16_t status, std::uint64_t bytes,
                               std::uint64_t t_ns, std::uint64_t frame) {
  // One receiver at a time (max_clients 1): the newest connection that is not closed.
  Conn *streaming = nullptr;
  for (auto &entry : conns_) {
    Conn &c = *entry.second;
    if (c.state != State::Closed &&
        (streaming == nullptr || c.s.connection > streaming->s.connection)) {
      streaming = &c;
    }
  }
  if (streaming == nullptr) {
    return 0;
  }
  Conn &c = *streaming;
  ++c.s.http_gets;
  if (status == 200) {
    c.s.http_bytes += bytes;
  } else {
    ++c.s.http_errors;
  }
  log_line(c, Line()
                  .num("frame", frame)
                  .num("t_us", t_ns / 1000)
                  .str("event", "http-get")
                  .str("hash", hash)
                  .num("status", status)
                  .num("bytes", bytes)
                  .take());
  return c.s.connection;
}

std::string Hub::summary_json(const ServingSummary *resources) const {
  JsonWriter json;
  json.object_begin();
  json.field("schema", std::string("render-stream-live-summary/1"));
  json.key("connections").array_begin();
  for (const ConnectionSummary &s : summaries()) {
    json.object_begin();
    json.field("connection", static_cast<int64_t>(s.connection));
    json.field_or_null("stream_id", s.stream_id);
    json.field_or_null("receiver", s.receiver);
    json.field_or_null("credit_stage", s.credit_stage);
    json.field("inbound_buffer_bytes", static_cast<int64_t>(s.inbound_buffer_bytes));
    json.field("max_message_bytes", static_cast<int64_t>(s.max_message_bytes));
    json.field("frames_offered", static_cast<int64_t>(s.frames_offered));
    json.field("transactions", static_cast<int64_t>(s.transactions));
    json.field("sent", static_cast<int64_t>(s.sent));
    json.field("dropped", static_cast<int64_t>(s.dropped));
    json.field("full", static_cast<int64_t>(s.full));
    json.field("patch", static_cast<int64_t>(s.patch));
    json.field("coalesced", static_cast<int64_t>(s.coalesced));
    json.field("max_pending", static_cast<int64_t>(s.max_pending));
    json.field("pending_episodes", static_cast<int64_t>(s.pending_episodes));
    json.field("max_pending_frames", static_cast<int64_t>(s.max_pending_frames));
    json.field("max_pending_age_us", static_cast<int64_t>(s.max_pending_age_us));
    json.field("sent_without_credit", static_cast<int64_t>(s.sent_without_credit));
    json.field("stale_sent", static_cast<int64_t>(s.stale_sent));
    json.field("max_in_flight", static_cast<int64_t>(s.max_in_flight));
    json.field("max_queued_bytes", static_cast<int64_t>(s.max_queued_bytes));
    json.field("max_message_sent", static_cast<int64_t>(s.max_message_sent));
    json.field("bytes_sent", static_cast<int64_t>(s.bytes_sent));
    json.field("resource_records", static_cast<int64_t>(s.resource_records));
    json.field("resource_bytes", static_cast<int64_t>(s.resource_bytes));
    json.field("http_gets", static_cast<int64_t>(s.http_gets));
    json.field("http_bytes", static_cast<int64_t>(s.http_bytes));
    json.field("http_errors", static_cast<int64_t>(s.http_errors));
    json.field("resyncs", static_cast<int64_t>(s.resyncs));
    json.field("credits", static_cast<int64_t>(s.credits));
    json.key("acks").object_begin();
    json.field("received", static_cast<int64_t>(s.acks[0]));
    json.field("applied", static_cast<int64_t>(s.acks[1]));
    json.field("submitted", static_cast<int64_t>(s.acks[2]));
    json.object_end();
    json.field("acks_ignored", static_cast<int64_t>(s.acks_ignored));
    json.field("end_sent", s.end_sent);
    if (s.close_code < 0) {
      json.field_null("close_code");
    } else {
      json.field("close_code", static_cast<int64_t>(s.close_code));
    }
    json.field_or_null("closed_by", s.closed_by);
    json.field_or_null("close_reason", s.close_reason);
    json.field_or_null("error_sent", s.error_sent);
    json.key("ack_latency_us").object_begin();
    write_latency(&json, "received", s.ack_latency_us[0]);
    write_latency(&json, "applied", s.ack_latency_us[1]);
    write_latency(&json, "submitted", s.ack_latency_us[2]);
    json.object_end();
    write_latency(&json, "credit_rtt_us", s.credit_rtt_us);
    write_latency(&json, "credit_rtt_frames", s.credit_rtt_frames);
    json.object_end();
  }
  json.array_end();
  if (resources != nullptr) {
    json.key("resources").object_begin();
    json.field("http_gets", static_cast<int64_t>(resources->http_gets));
    json.field("http_bytes", static_cast<int64_t>(resources->http_bytes));
    json.field("http_errors", static_cast<int64_t>(resources->http_errors));
    json.field("pinned", static_cast<int64_t>(resources->pinned));
    json.field("retired", static_cast<int64_t>(resources->retired));
    json.field("retired_unpinned", static_cast<int64_t>(resources->retired_unpinned));
    json.field("retained_max", static_cast<int64_t>(resources->retained_max));
    json.field("retained_bytes_max", static_cast<int64_t>(resources->retained_bytes_max));
    json.field("retained_end", static_cast<int64_t>(resources->retained_end));
    json.field("retained_bytes_end", static_cast<int64_t>(resources->retained_bytes_end));
    json.field("budget_bytes", static_cast<int64_t>(resources->budget_bytes));
    json.field_or_null("dropped_hash", resources->dropped_hash);
    json.field_or_null("corrupted_hash", resources->corrupted_hash);
    json.object_end();
  }
  json.object_end();
  return json.take();
}

}  // namespace rs2
}  // namespace grc
