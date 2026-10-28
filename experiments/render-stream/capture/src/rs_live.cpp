#include "rs_live.h"

#include <algorithm>
#include <cerrno>
#include <chrono>
#include <cstring>
#include <deque>
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
  // render-stream-7.md "Hello": `token`/`manifest_sha256` may be JSON null -- the only control
  // message fields that ever are (every other type/key stays flat strings and non-negative
  // integers, per the class comment above).
  bool is_null = false;
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
        } else if (c == 'n') {
          // render-stream-7.md "Hello": `null` is legal only for `token`/`manifest_sha256`,
          // enforced below once the whole object is parsed and the field is known.
          if (s_.compare(p_, 4, "null") != 0) {
            return fail(error, "\"" + key + "\": invalid literal (flat object: strings, "
                                             "non-negative integers or null only)");
          }
          p_ += 4;
          value.is_null = true;
        } else {
          return fail(error, "\"" + key +
                                 "\": only strings, non-negative integers and null are allowed "
                                 "(flat object)");
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

// render-stream-9.md "Hello": ^[a-z0-9]+(,[a-z0-9]+)*$, at most 96 characters.
bool is_flat_list(const std::string &text) {
  if (text.empty() || text.size() > 96 || text.front() == ',' || text.back() == ',') {
    return false;
  }
  char prev = ',';
  for (char c : text) {
    const bool name = (c >= '0' && c <= '9') || (c >= 'a' && c <= 'z');
    if (!name && c != ',') {
      return false;
    }
    if (c == ',' && prev == ',') {
      return false;
    }
    prev = c;
  }
  return true;
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

// The hello `protocol` string of a version (render-stream-N.md "Live transport").
const char *protocol_string(ProtocolVersion version) {
  return version == ProtocolVersion::V12   ? kProtocolV12
         : version == ProtocolVersion::V11 ? kProtocolV11
         : version == ProtocolVersion::V10 ? kProtocolV10
         : version == ProtocolVersion::V9  ? kProtocolV9
         : version == ProtocolVersion::V8 ? kProtocolV8
         : version == ProtocolVersion::V7 ? kProtocolV7
         : version == ProtocolVersion::V6 ? kProtocolV6
         : version == ProtocolVersion::V5 ? kProtocolV5
         : version == ProtocolVersion::V4 ? kProtocolV4
         : version == ProtocolVersion::V3 ? kProtocolV3
                                          : kProtocol;
}

// render-stream-10.md "Features": below /10 both back-buffer setters stay in features.unobserved,
// even on a host whose /10 session dropped them because it hooks them. Sorted, as the list is.
void declare_backbuffer_unobserved(Features *features) {
  for (const char *name :
       {"canvas_item_set_canvas_group_mode", "canvas_item_set_copy_to_backbuffer"}) {
    std::vector<std::string> &list = features->unobserved;
    const auto it = std::lower_bound(list.begin(), list.end(), std::string(name));
    if (it == list.end() || *it != name) {
      list.insert(it, name);
    }
  }
}

std::uint32_t version_number(ProtocolVersion version) {
  return 2u + static_cast<std::uint32_t>(version);  // V2 is the enum's first value
}

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

bool parse_control(const std::string &text, ControlMessage *out, std::string *error,
                   ProtocolVersion version) {
  const char *const protocol = protocol_string(version);
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
    if (is_v7_or_later(version)) {
      // render-stream-7.md "Hello": /6's five keys plus receiver_kind, credit_window, token,
      // manifest_sha256 and five presentation integers (gate7-design.md Q2).
      keys = {"type",
              "protocol",
              "receiver",
              "receiver_kind",
              "credit_stage",
              "credit_window",
              "inbound_buffer_bytes",
              "token",
              "manifest_sha256",
              "presentation_backing_w",
              "presentation_backing_h",
              "presentation_css_w",
              "presentation_css_h",
              "dpr_milli"};
      if (is_v9_or_later(version)) {
        // render-stream-9.md "Hello": /8's keys plus texture_encodings and gpu_formats (and
        // render-stream-10.md: /10's hello is /9's under its own protocol string).
        keys.push_back("texture_encodings");
        keys.push_back("gpu_formats");
      }
    } else {
      keys = {"type", "protocol", "receiver", "credit_stage", "inbound_buffer_bytes"};
    }
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
  // W11t (render-stream-11.md "As built (W11t)"): a /11 hello may carry `live_coding`; the only
  // optional key of any control message.
  const bool optional_live_coding =
      message.type == ControlType::Hello && is_v11_or_later(version);
  for (const auto &field : fields) {
    if (optional_live_coding && field.first == "live_coding") {
      continue;
    }
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
    if (value->is_string || value->is_null) {
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
      if (is_v7_or_later(version)) {
        if (!str("receiver_kind", &message.receiver_kind)) {
          return false;
        }
        if (message.receiver_kind != "native" && message.receiver_kind != "web-export" &&
            message.receiver_kind != "gsw-canvas") {
          return fail("receiver_kind \"" + message.receiver_kind +
                       "\" is not native, web-export or gsw-canvas");
        }
        if (!num("credit_window", &message.credit_window)) {
          return false;
        }
        if (message.credit_window < 1 || message.credit_window > 2) {
          return fail("credit_window " + std::to_string(message.credit_window) +
                       " is not 1 or 2");
        }
        const Value *token_value = find("token");
        if (token_value->is_null) {
          message.has_token = false;
          message.token.clear();
        } else if (token_value->is_string && is_lower_hex(token_value->text, 64)) {
          message.has_token = true;
          message.token = token_value->text;
        } else {
          return fail("\"token\" must be 64 lowercase hex or null");
        }
        const Value *manifest_value = find("manifest_sha256");
        if (manifest_value->is_null) {
          message.has_manifest_sha256 = false;
          message.manifest_sha256.clear();
        } else if (manifest_value->is_string && is_lower_hex(manifest_value->text, 64)) {
          message.has_manifest_sha256 = true;
          message.manifest_sha256 = manifest_value->text;
        } else {
          return fail("\"manifest_sha256\" must be 64 lowercase hex or null");
        }
        if (!num("presentation_backing_w", &message.presentation_backing_w) ||
            !num("presentation_backing_h", &message.presentation_backing_h) ||
            !num("presentation_css_w", &message.presentation_css_w) ||
            !num("presentation_css_h", &message.presentation_css_h) ||
            !num("dpr_milli", &message.dpr_milli)) {
          return false;
        }
        if (is_v9_or_later(version)) {
          if (!str("texture_encodings", &message.texture_encodings) ||
              !str("gpu_formats", &message.gpu_formats)) {
            return false;
          }
          if (!is_flat_list(message.texture_encodings)) {
            return fail("\"texture_encodings\" is not a comma list of [a-z0-9] names, <= 96 chars");
          }
          if (!is_flat_list(message.gpu_formats)) {
            return fail("\"gpu_formats\" is not a comma list of [a-z0-9] names, <= 96 chars");
          }
        }
        if (optional_live_coding && find("live_coding") != nullptr) {
          if (!str("live_coding", &message.live_coding)) {
            return false;
          }
          if (!rs::live_coding::valid_offer(message.live_coding)) {
            return fail("\"live_coding\" is not a comma list of [a-z0-9-] names, <= 96 chars");
          }
          message.has_live_coding = true;
        }
      }
      // render-stream-2.md "Golden vectors": a hello for another version is invalid.
      if (message.protocol != protocol) {
        return fail("hello.protocol \"" + message.protocol + "\" is not " + protocol);
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
    case live::Event::AuthRejected:
      // G2e: a rejected WebSocket upgrade never reached a connection the hub is tracking (it
      // never got an Opened event either); entry.cpp's live_drain() logs it directly and never
      // forwards one here. This case exists only so the switch stays exhaustive under -Wswitch.
      break;
    case live::Event::OriginRejected:
      // G7n: the same as AuthRejected -- a 403 never reaches a tracked connection; live_drain()
      // logs it and never forwards one here.
      break;
  }
  out.conn = event.conn;
  out.subprotocol = event.subprotocol;
  out.origin = event.origin;
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
  // G7n: the protocol this connection speaks, from its subprotocol (the template's otherwise).
  ProtocolVersion version = ProtocolVersion::V2;
  State state = State::AwaitHello;
  std::uint64_t opened_ns = 0;
  bool hello_received = false;
  AckStage credit_stage = AckStage::Submitted;
  Session session;
  std::uint64_t next_seq = 1;
  // The credit window (G7q, gate7-design.md D4, Q2 "Credit with window w"): the sent seqs that
  // hold one of the connection's `window_slots` (its granted credit_window), oldest first. A send
  // takes a slot; its credit-stage ack, or a resync (which also frees every later slot), returns
  // it. `credit` is "a slot is free" (or the hello's credit for the session and seq 1). At window
  // 1 this is exactly the single in-flight seq it replaced: the window-1 transcripts pin it
  // (test/rs_live_window_test.cpp).
  std::deque<std::uint64_t> window;
  std::uint64_t window_slots = 1;
  std::set<std::uint64_t> uncredited;  // sent seqs whose credit has not returned
  bool credit = false;
  // Window >= 2 only: the snapshot of every in-window seq other than the last one sent (that one
  // is `base`), so every in-flight transaction's payloads stay pinned (D7, Q2).
  std::map<std::uint64_t, std::shared_ptr<const rs::Captured>> window_payloads;
  // The last snapshot sent (shared with every connection that sent it, P3-SP) and its seq here;
  // its payloads are the pin (G2c2, D7).
  std::shared_ptr<const rs::Captured> base;
  std::uint64_t base_seq = 0;
  bool has_base = false;
  bool resync = false;
  std::uint64_t epoch_sent = 0;
  bool pending = false;
  std::uint64_t pending_since_frame = 0;  // the callback that made the current target pending
  std::uint64_t pending_since_ns = 0;
  // stale-coalesce: the first missed target since the last send
  std::shared_ptr<const rs::Captured> stale;
  // G2b2: the payload hashes this connection already carried inline are the CarriedIndex entries
  // with this slot's bit (P3-SP); `carried_count` is their number.
  unsigned carried_slot = CarriedIndex::kNoSlot;
  std::uint64_t carried_count = 0;
  // W11b: a /11 connection's carried set is inline(base) (L2), never held; only the keep-carried
  // sabotage gives it a lifelong RecordPlanner. `carried_count` then reports |inline(base)|.
  std::unique_ptr<RecordPlanner> keep_carried;
  // W11t: the connection's live coding (negotiated at the hello, /11 only), and the uncoded
  // message of the last transaction formed on it (sent or dropped): the next patch's prefix.
  rs::live_coding::Coding coding = rs::live_coding::Coding::Off;
  std::shared_ptr<const std::vector<std::uint8_t>> last_tx;
  std::uint64_t stale_frame = 0;
  std::uint64_t stale_ns = 0;  // the frame callback's time when `stale` was captured (G6r Q3c)
  // G7q, stale-coalesce at window >= 2: the stale target just sent stays the target of every
  // send made while its seq still holds a window slot, so a receiver folding those sends into one
  // apply still draws it (the sabotage's sets stay window 1's). Never set at window 1, where
  // nothing is sent while a seq is in flight.
  std::shared_ptr<const rs::Captured> stale_held;
  std::uint64_t stale_held_seq = 0;
  std::uint64_t stale_held_frame = 0;
  std::uint64_t stale_held_ns = 0;
  // Rate control (G6r): the schedule starts at this connection's first send; `started` is false
  // until then, so that very first send (right after the hello) is never rate-gated.
  bool schedule_started = false;
  std::uint64_t t0_ns = 0;
  std::uint64_t next_due_ns = 0;
  EndStats stats;
  struct Sent {
    std::uint64_t ns = 0;
    std::uint64_t frame = 0;
    unsigned acked = 0;  // bit per stage already timed
    // G6r Q3c "Staleness": the frame callback's time the sent snapshot was captured at (equal to
    // `ns` except for a stale-coalesce send, which carries an earlier capture).
    std::uint64_t capture_ns = 0;
  };
  std::map<std::uint64_t, Sent> sent_at;
  std::vector<std::uint64_t> latency[3];
  std::vector<std::uint64_t> credit_rtt;
  std::vector<std::uint64_t> credit_frames;
  std::FILE *tap = nullptr;
  std::FILE *log = nullptr;
};

// P3-SP: a target's payload refs (payload_refs, table order) and, for each one at or under
// inline_max_bytes, its CarriedIndex id (kNoId above it) -- looked up once per target per frame.
struct Hub::TargetRefs {
  std::shared_ptr<const rs::Captured> target;
  std::vector<rs::PayloadRef> refs;
  std::vector<std::uint32_t> ids;
};

// W11b (render-stream-11.md "Multiple viewers"): the records a /11 connection sends before
// `target` when its last sent snapshot is `base` (null: the stream's first transaction), with
// |inline(target)| for the summary's carried size -- computed once per pair per frame callback.
struct Hub::V11Records {
  std::shared_ptr<const rs::Captured> base;
  std::shared_ptr<const rs::Captured> target;
  std::vector<PayloadName> records;
  std::uint64_t inline_count = 0;
  bool lowered = false;  // PM5: planned on the /11 view (lower_particles) of both states
};

// P3-SP: a transaction one connection formed and encoded in this frame callback. Another connection
// sending the same transaction (the same base snapshot, or none for a full one, the same target and
// version) re-stamps its meta's leading fields instead of forming and encoding it again.
struct Hub::SharedTx {
  std::shared_ptr<const rs::Captured> base;  // null: a full transaction
  std::shared_ptr<const rs::Captured> target;
  TxMeta meta;  // the fields the encode was stamped with
  bool full = false;
  std::shared_ptr<const std::vector<std::uint8_t>> bytes;
};

// W11t: a transaction coded in this frame callback. Its coded bytes are a function of the uncoded
// base and target messages (seq and base_seq included, which the envelope repeats), so another
// connection with byte-equal ones reuses them: lockstep viewers share the compressed bytes.
struct Hub::CodedTx {
  std::shared_ptr<const std::vector<std::uint8_t>> base;  // null: no prefix
  std::shared_ptr<const std::vector<std::uint8_t>> target;
  std::uint64_t seq = 0;
  std::uint64_t base_seq = 0;
  std::shared_ptr<const std::vector<std::uint8_t>> coded;
};

namespace {

// The meta's leading fields, exactly as encode_transaction writes them (rs2_codec.cpp), up to
// (not including) `,"status":`.
std::string tx_prefix(const TxMeta &meta, bool full) {
  std::string m = "{\"type\":\"transaction\",\"seq\":" + std::to_string(meta.seq) +
                  ",\"frame\":" + std::to_string(meta.frame) + ",\"encoding\":\"" +
                  to_wire(full ? Encoding::Full : Encoding::Patch) + "\",\"base_seq\":" +
                  (full ? std::string("null") : std::to_string(meta.base_seq));
  return m;
}

void put_u32le(std::vector<std::uint8_t> &out, std::size_t at, std::uint32_t v) {
  out[at] = static_cast<std::uint8_t>(v);
  out[at + 1] = static_cast<std::uint8_t>(v >> 8);
  out[at + 2] = static_cast<std::uint8_t>(v >> 16);
  out[at + 3] = static_cast<std::uint8_t>(v >> 24);
}

std::uint32_t get_u32le(const std::vector<std::uint8_t> &b, std::size_t at) {
  return static_cast<std::uint32_t>(b[at]) | (static_cast<std::uint32_t>(b[at + 1]) << 8) |
         (static_cast<std::uint32_t>(b[at + 2]) << 16) |
         (static_cast<std::uint32_t>(b[at + 3]) << 24);
}

// `shared`'s record (u32 body length, u32 meta length, meta, blocks) with its meta prefix replaced
// by `meta`'s. False when the record does not start with the prefix its own meta implies (the
// caller then forms and encodes the transaction itself, so the bytes are never wrong).
bool restamp(const std::vector<std::uint8_t> &src, const TxMeta &src_meta, const TxMeta &meta,
             bool full, std::vector<std::uint8_t> *out) {
  const std::string old_prefix = tx_prefix(src_meta, full);
  if (src.size() < 8 + old_prefix.size() ||
      std::memcmp(src.data() + 8, old_prefix.data(), old_prefix.size()) != 0) {
    return false;
  }
  static const char kStatus[] = ",\"status\":";
  if (src.size() < 8 + old_prefix.size() + sizeof(kStatus) - 1 ||
      std::memcmp(src.data() + 8 + old_prefix.size(), kStatus, sizeof(kStatus) - 1) != 0) {
    return false;
  }
  const std::string prefix = tx_prefix(meta, full);
  const std::uint32_t body = get_u32le(src, 0);
  const std::uint32_t meta_len = get_u32le(src, 4);
  if (static_cast<std::size_t>(body) + 4 != src.size() || meta_len < old_prefix.size()) {
    return false;
  }
  out->clear();
  out->reserve(src.size() + prefix.size() - old_prefix.size());
  out->resize(8);
  put_u32le(*out, 0, static_cast<std::uint32_t>(body - old_prefix.size() + prefix.size()));
  put_u32le(*out, 4, static_cast<std::uint32_t>(meta_len - old_prefix.size() + prefix.size()));
  out->insert(out->end(), prefix.begin(), prefix.end());
  out->insert(out->end(), src.begin() + 8 + static_cast<std::ptrdiff_t>(old_prefix.size()),
              src.end());
  return true;
}

}  // namespace

const Hub::TargetRefs &Hub::target_refs(const std::shared_ptr<const rs::Captured> &target) {
  for (const auto &t : frame_targets_) {
    if (t->target == target) {
      return *t;
    }
  }
  auto t = std::make_unique<TargetRefs>();
  t->target = target;
  t->refs = rs::payload_refs(target->state);
  t->ids.reserve(t->refs.size());
  for (const rs::PayloadRef &ref : t->refs) {
    t->ids.push_back(ref.payload_bytes > template_.resources.inline_max_bytes
                         ? CarriedIndex::kNoId
                         : carried_.intern(*ref.hash));
  }
  frame_targets_.push_back(std::move(t));
  return *frame_targets_.back();
}

const Hub::V11Records &Hub::v11_records(const std::shared_ptr<const rs::Captured> &base,
                                        const std::shared_ptr<const rs::Captured> &target,
                                        bool lower) {
  lower = lower && (target->state.particles_commands ||
                    (base != nullptr && base->state.particles_commands));
  for (const auto &r : frame_v11_) {
    if (r->base == base && r->target == target && r->lowered == lower) {
      return *r;
    }
  }
  InlinePolicy policy;
  policy.inline_max_bytes = template_.resources.inline_max_bytes;
  auto r = std::make_unique<V11Records>();
  r->base = base;
  r->target = target;
  r->lowered = lower;
  if (lower) {
    // PM5: a /11 connection of a /12 host names what its own transactions name (a
    // process-material shader that is `ok` only at /12 is no payload of its).
    const Snapshot t = lower_particles(target->state);
    const Snapshot b = base != nullptr ? lower_particles(base->state) : Snapshot();
    r->records = records_before(base != nullptr ? &b : nullptr, t, policy);
    r->inline_count = inline_names(t, policy).size();
    frame_v11_.push_back(std::move(r));
    return *frame_v11_.back();
  }
  r->records = records_before(base != nullptr ? &base->state : nullptr, target->state, policy);
  r->inline_count = inline_names(target->state, policy).size();
  frame_v11_.push_back(std::move(r));
  return *frame_v11_.back();
}

void Hub::clear_frame_memo() {
  frame_targets_.clear();
  frame_txs_.clear();
  frame_records_.clear();
  frame_v11_.clear();
  frame_records_v11_.clear();
  frame_coded_.clear();
  frame_records_coded_.clear();
}

std::shared_ptr<const std::vector<std::uint8_t>> Hub::coded_plain(
    Conn &c, const std::vector<std::uint8_t> &message, const std::string &memo_key) {
  if (!memo_key.empty()) {
    const auto found = frame_records_coded_.find(memo_key);
    if (found != frame_records_coded_.end()) {
      ++c.s.coded_shared;
      return found->second;
    }
  }
  const std::uint64_t t0 = monotonic_ns();
  auto out = std::make_shared<std::vector<std::uint8_t>>();
  const bool ok = rs::live_coding::encode_plain(message.data(), message.size(), out.get());
  c.s.coding_ns = saturating_add(c.s.coding_ns, monotonic_ns() - t0);
  if (!ok) {
    return nullptr;
  }
  if (!memo_key.empty()) {
    frame_records_coded_[memo_key] = out;
  }
  return out;
}

namespace {

bool same_bytes(const std::shared_ptr<const std::vector<std::uint8_t>> &a,
                const std::shared_ptr<const std::vector<std::uint8_t>> &b) {
  if (a == b) {
    return true;
  }
  if (a == nullptr || b == nullptr || a->size() != b->size()) {
    return false;
  }
  return std::memcmp(a->data(), b->data(), a->size()) == 0;
}

}  // namespace

std::shared_ptr<const std::vector<std::uint8_t>> Hub::coded_tx(
    Conn &c, const std::shared_ptr<const std::vector<std::uint8_t>> &message, std::uint64_t seq,
    std::uint64_t frame, std::uint64_t now_ns) {
  using rs::live_coding::Coding;
  const std::shared_ptr<const std::vector<std::uint8_t>> base =
      c.coding == Coding::ZstdBase ? c.last_tx : nullptr;
  const std::uint64_t base_seq = base != nullptr ? c.base_seq : 0;
  if (base != nullptr) {
    ++c.s.coded_prefixed;
  }
  const bool sabotage = base != nullptr && config_.coding_wrong_prefix_frame != 0 &&
                        !wrong_prefix_done_ && frame >= config_.coding_wrong_prefix_frame;
  if (!sabotage) {
    for (const auto &m : frame_coded_) {
      if (m->seq == seq && m->base_seq == base_seq && same_bytes(m->target, message) &&
          same_bytes(m->base, base)) {
        ++c.s.coded_shared;
        return m->coded;
      }
    }
  }
  const std::uint64_t t0 = monotonic_ns();
  auto out = std::make_shared<std::vector<std::uint8_t>>();
  bool ok = rs::live_coding::encode_transaction(
      message->data(), message->size(), seq, base != nullptr ? base->data() : nullptr,
      base != nullptr ? base->size() : 0, base_seq, out.get());
  if (ok && sabotage) {
    // coding-wrong-prefix: the base plus one byte shifts every match into the prefix. Kept only
    // when it really decodes differently against the true base (else the next one is tried).
    std::vector<std::uint8_t> wrong(*base);
    wrong.push_back(0);
    auto bad = std::make_shared<std::vector<std::uint8_t>>();
    std::vector<std::uint8_t> decoded;
    std::uint64_t got_seq = 0;
    std::uint64_t got_base = 0;
    std::string error;
    if (rs::live_coding::encode_transaction(message->data(), message->size(), seq, wrong.data(),
                                            wrong.size(), base_seq, bad.get()) &&
        (!rs::live_coding::decode(bad->data(), bad->size(), base.get(), &decoded, &got_seq,
                                  &got_base, &error) ||
         decoded != *message)) {
      out = bad;
      wrong_prefix_done_ = true;
      c.s.wrong_prefix_seq = seq;
      log_line(c, Line()
                      .num("frame", frame)
                      .num("t_us", now_ns / 1000)
                      .str("event", "sabotage")
                      .str("kind", "coding-wrong-prefix")
                      .num("seq", seq)
                      .num("base_seq", base_seq)
                      .take());
    }
  }
  c.s.coding_ns = saturating_add(c.s.coding_ns, monotonic_ns() - t0);
  if (!ok) {
    return nullptr;
  }
  if (!sabotage) {
    auto m = std::make_unique<CodedTx>();
    m->base = base;
    m->target = message;
    m->seq = seq;
    m->base_seq = base_seq;
    m->coded = out;
    frame_coded_.push_back(std::move(m));
  }
  return out;
}

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
  // P3-SP: flushed once per frame callback (flush_taps), not per line.
}

void Hub::flush_taps() {
  for (auto &entry : conns_) {
    Conn &c = *entry.second;
    if (c.tap != nullptr) {
      std::fflush(c.tap);
    }
    if (c.log != nullptr) {
      std::fflush(c.log);
    }
  }
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

void Hub::release_closed(Conn &c) {
  // P3-SP: a closed connection pins nothing and carries nothing any more.
  carried_.release(c.carried_slot);
  c.carried_slot = CarriedIndex::kNoSlot;
  c.keep_carried.reset();
  c.base.reset();
  c.window_payloads.clear();
  c.stale.reset();
  c.stale_held.reset();
}

void Hub::host_close(Conn &c, std::uint16_t code, const std::string &reason) {
  if (c.state == State::Closed) {
    return;
  }
  transport_->close(c.id, code, reason);
  c.state = State::Closed;
  release_closed(c);
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
  error_close(c, "protocol", detail, 1002, frame, t_ns);
}

void Hub::error_close(Conn &c, const std::string &reason, const std::string &detail,
                      std::uint16_t code, std::uint64_t frame, std::uint64_t t_ns) {
  transport_->send_text(c.id, encode_error(reason, detail));
  c.s.error_sent = reason;
  log_line(c, Line()
                  .num("frame", frame)
                  .num("t_us", t_ns / 1000)
                  .str("event", "error")
                  .str("reason", reason)
                  .str("detail", detail)
                  .take());
  // The close reason repeats the error's reason: a Godot client may never read a text message
  // that arrives together with the close frame (memory godot-websocketpeer-drops-msgs-with-close).
  host_close(c, code, reason);
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
      // G7n: the subprotocol decides the connection's version (render-stream.7 -> /7).
      // G8w: render-stream.8 -> /8 (render-stream-8.md "Live transport").
      // G8k9: render-stream.9 -> /9 (render-stream-9.md "Live transport").
      // CG1: render-stream.10 -> /10 (render-stream-10.md "Live transport").
      // W11b: render-stream.11 -> /11 (render-stream-11.md "Live transport").
      // PM5: render-stream.12 -> /12 (render-stream-12.md).
      c.version = event.subprotocol == kSubprotocolV12   ? ProtocolVersion::V12
                  : event.subprotocol == kSubprotocolV11 ? ProtocolVersion::V11
                  : event.subprotocol == kSubprotocolV10 ? ProtocolVersion::V10
                  : event.subprotocol == kSubprotocolV9  ? ProtocolVersion::V9
                  : event.subprotocol == kSubprotocolV8 ? ProtocolVersion::V8
                  : event.subprotocol == kSubprotocolV7 ? ProtocolVersion::V7
                  : is_v8_or_later(template_.version) ? ProtocolVersion::V6
                                                      : template_.version;
      c.s.version = version_number(c.version);
      c.s.origin = event.origin;
      if (!config_.auth_token.empty() && !is_v7_or_later(c.version)) {
        // Below /7 the token is the upgrade's bearer header, checked by the transport before the
        // connection ever opened (rs_ws.h); an open connection passed it.
        c.s.token_checked = true;
        c.s.token_ok = true;
      }
      if (!config_.tap_dir.empty() && make_directories(config_.tap_dir)) {
        const std::string n = std::to_string(c.s.connection);
        c.tap = std::fopen(path_join(config_.tap_dir, "stream-" + n + ".rs2").c_str(), "wb");
        c.log = std::fopen(path_join(config_.tap_dir, "live-" + n + ".jsonl").c_str(), "wb");
        // P3-SP: the stream copy is one frame's messages per flush (flush_taps), so a buffer
        // that holds them keeps it to about one write per frame.
        if (c.tap != nullptr) {
          std::setvbuf(c.tap, nullptr, _IOFBF, 1u << 20);
        }
      }
      conns_[event.conn] = std::move(conn);
      Line open;
      open.num("frame", frame)
          .num("t_us", event.t_ns / 1000)
          .str("event", "open")
          .num("connection", c.s.connection)
          .str("stream_id", c.s.stream_id)
          .num("version", c.s.version);
      if (event.origin.empty()) {
        open.null("origin");
      } else {
        open.str("origin", event.origin);
      }
      log_line(c, open.take());
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
      release_closed(*c);
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
  if (!parse_control(event.text, &message, &error, c.version)) {
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
      const char *const protocol = protocol_string(c.version);
      if (message.protocol != protocol) {
        protocol_error(c, "hello.protocol \"" + message.protocol + "\" is not " + protocol,
                       frame, event.t_ns);
        return;
      }
      c.credit_stage = message.credit_stage;
      c.s.receiver = message.receiver;
      c.s.credit_stage = to_wire(message.credit_stage);
      c.s.inbound_buffer_bytes = message.inbound_buffer_bytes;
      c.s.max_message_bytes = std::min(message.inbound_buffer_bytes, config_.max_message_bytes);
      Line hello;
      hello.num("frame", frame)
          .num("t_us", event.t_ns / 1000)
          .str("event", "hello")
          .str("receiver", message.receiver)
          .str("credit_stage", c.s.credit_stage)
          .num("inbound_buffer_bytes", message.inbound_buffer_bytes)
          .num("max_message_bytes", c.s.max_message_bytes);
      bool refuse = false;
      if (is_v7_or_later(c.version)) {
        // render-stream-7.md "Hello" (gate7-design.md Q2, Q3): record every key but `token`.
        c.s.has_hello7 = true;
        c.s.receiver_kind = message.receiver_kind;
        c.s.credit_window_requested = message.credit_window;
        c.s.credit_window =
            std::min({message.credit_window, config_.credit_window_max, kHostCreditWindow});
        c.window_slots = c.s.credit_window;
        c.s.manifest_sha256 = message.has_manifest_sha256 ? message.manifest_sha256 : "";
        c.s.presentation_backing_w = message.presentation_backing_w;
        c.s.presentation_backing_h = message.presentation_backing_h;
        c.s.presentation_css_w = message.presentation_css_w;
        c.s.presentation_css_h = message.presentation_css_h;
        c.s.dpr_milli = message.dpr_milli;
        c.s.texture_encodings = message.texture_encodings;
        c.s.gpu_formats = message.gpu_formats;
        if (!config_.auth_token.empty()) {
          // D3: compared in constant time, as the G2e upgrade check is.
          c.s.token_checked = true;
          c.s.token_ok =
              message.has_token && live::constant_time_equals(message.token, config_.auth_token);
          refuse = !c.s.token_ok && !config_.token_ignored;
        }
        hello.str("protocol", message.protocol)
            .str("receiver_kind", message.receiver_kind)
            .num("credit_window", message.credit_window)
            .num("credit_window_granted", c.s.credit_window);
        if (message.has_manifest_sha256) {
          hello.str("manifest_sha256", message.manifest_sha256);
        } else {
          hello.null("manifest_sha256");
        }
        hello.num("presentation_backing_w", message.presentation_backing_w)
            .num("presentation_backing_h", message.presentation_backing_h)
            .num("presentation_css_w", message.presentation_css_w)
            .num("presentation_css_h", message.presentation_css_h)
            .num("dpr_milli", message.dpr_milli);
        if (is_v9_or_later(c.version)) {
          hello.str("texture_encodings", message.texture_encodings)
              .str("gpu_formats", message.gpu_formats);
        }
        if (c.s.token_checked) {
          hello.boolean("token_ok", c.s.token_ok);
        } else {
          hello.null("token_ok");
        }
        if (is_v11_or_later(c.version)) {
          // W11t: the receiver offers, the host chooses (rs_live_coding.h negotiate).
          c.s.has_live_coding = message.has_live_coding;
          c.s.live_coding_offer = message.live_coding;
          c.coding = message.has_live_coding
                         ? rs::live_coding::negotiate(config_.live_coding, message.live_coding)
                         : rs::live_coding::Coding::Off;
          c.s.live_coding = rs::live_coding::to_token(c.coding);
          if (message.has_live_coding) {
            hello.str("live_coding", message.live_coding);
          } else {
            hello.null("live_coding");
          }
          hello.str("live_coding_chosen", c.s.live_coding);
        }
      }
      log_line(c, hello.take());
      if (refuse) {
        // D3: nothing was sent before the hello, and nothing is sent after the refusal.
        error_close(c, "unauthorized",
                    message.has_token ? "the hello's token is wrong" : "the hello has no token",
                    1008, frame, event.t_ns);
        return;
      }
      c.hello_received = true;
      c.credit = true;  // the hello is the credit for the session and seq 1
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
      std::vector<std::uint64_t> discarded;  // G7q: the later slots a resync freed
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
              // Q3d staleness_us[applied|submitted] (G6r): the host-clock age of what the
              // receiver just applied or submitted, from when its snapshot was captured (not
              // merely when it was sent -- a stale-coalesce send's capture can be far earlier).
              if (message.stage == AckStage::Applied || message.stage == AckStage::Submitted) {
                staleness_hist_[stage_index(message.stage)].add(
                    (event.t_ns - std::min(event.t_ns, sent->second.capture_ns)) / 1000);
              }
            }
          }
        }
        if (credit_message) {
          // Any credit-stage answer settles its own seq, so `uncredited` (max_in_flight) counts
          // the seqs still outstanding even when ignore-credit put several in flight; only a seq
          // holding a window slot returns credit (G7q: one slot per seq, window w).
          c.uncredited.erase(message.seq);
          const auto slot = std::find(c.window.begin(), c.window.end(), message.seq);
          if (slot != c.window.end()) {
            credited = true;
            if (is_ack) {
              c.window.erase(slot);
            } else {
              // G7q (render-stream-7.md "Credit with window w"): a resync for any in-flight seq
              // makes the next send full, and the receiver ignores every later in-flight patch
              // until then, so their slots return with it (never at window 1: nothing is later).
              for (auto later = slot + 1; later != c.window.end(); ++later) {
                c.uncredited.erase(*later);
                c.window_payloads.erase(*later);
                discarded.push_back(*later);
              }
              c.window.erase(slot, c.window.end());
            }
            c.window_payloads.erase(message.seq);
            c.credit = c.window.size() < c.window_slots;
            ++c.s.credits;
            if (!is_ack) {
              c.resync = true;
              ++c.s.resyncs;
            }
            if (sent != c.sent_at.end()) {
              const std::uint64_t rtt_us =
                  (event.t_ns - std::min(event.t_ns, sent->second.ns)) / 1000;
              c.credit_rtt.push_back(rtt_us);
              c.credit_frames.push_back(frame - std::min(frame, sent->second.frame));
              // Q3d credit_rtt_us[stage] (G6r): keyed by this connection's own credit stage (a
              // resync answers the credit too, with no ack `stage` of its own to key by).
              credit_rtt_hist_[stage_index(c.credit_stage)].add(rtt_us);
            }
          } else {
            ignored = "stale";
          }
        }
        // P3-SP: a seq every stage has answered is never timed again; its entry goes (the map
        // grew by one entry per transaction for the connection's life).
        if (sent != c.sent_at.end() && sent->second.acked == 7u) {
          c.sent_at.erase(sent);
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
      if (!discarded.empty()) {
        std::string list;
        for (const std::uint64_t seq : discarded) {
          list += (list.empty() ? "" : ",") + std::to_string(seq);
        }
        line.raw("discarded", "[" + list + "]");
      }
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

bool Hub::wants_snapshot(std::uint64_t frame, std::uint64_t now_ns) const {
  const bool ignore_credit =
      config_.ignore_credit_frame != 0 && frame >= config_.ignore_credit_frame;
  const bool stale_coalesce =
      config_.stale_coalesce_frame != 0 && frame >= config_.stale_coalesce_frame;
  const bool overrun =
      config_.window_overrun_frame != 0 && frame >= config_.window_overrun_frame;
  for (const auto &entry : conns_) {
    const Conn &c = *entry.second;
    if (c.state == State::AwaitHello && c.hello_received) {
      return true;
    }
    if (c.state != State::Streaming) {
      continue;
    }
    // G6r: under rate control, credit alone is not enough -- a tick must also be due. The
    // stale-coalesce clause is unaffected by pacing: it needs a snapshot to keep as the pending
    // target the moment one is missing, independent of whether a send would currently be due.
    if ((c.credit || ignore_credit || overrun) && (ignore_credit || tick_due(c, now_ns))) {
      return true;
    }
    if (stale_coalesce && c.stale == nullptr) {
      return true;
    }
  }
  return false;
}

bool Hub::has_viewer() const {
  for (const auto &entry : conns_) {
    const Conn &c = *entry.second;
    if (c.state == State::Streaming || (c.state == State::AwaitHello && c.hello_received)) {
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

bool Hub::deliver(Conn &c, const std::vector<std::uint8_t> &message, bool send,
                  const std::vector<std::uint8_t> *wire) {
  if (c.tap != nullptr) {
    // P3-SP: flushed once per frame callback (flush_taps), not per message. W11t: the tap holds
    // the uncoded message, so it stays a valid stream on a coded connection.
    std::fwrite(message.data(), 1, message.size(), c.tap);
  }
  c.s.max_message_sent = std::max<std::uint64_t>(c.s.max_message_sent, message.size());
  if (!send) {
    return true;
  }
  const std::vector<std::uint8_t> &out = wire != nullptr ? *wire : message;
  if (wire != nullptr) {
    ++c.s.coded_messages;
    c.s.coded_input_bytes += message.size();
    c.s.coded_wire_bytes += wire->size();
  }
  c.s.bytes_sent += out.size();
  const std::uint64_t t0 = monotonic_ns();
  const bool ok = transport_->send_binary(c.id, out);
  enqueue_hist_.add((monotonic_ns() - t0) / 1000);  // Q3d enqueue_us (G6r)
  return ok;
}

bool Hub::tick_due(const Conn &c, std::uint64_t now_ns) const {
  if (config_.publish_period_ns == 0 || !c.schedule_started) {
    return true;
  }
  return now_ns + config_.publish_period_ns / 4 >= c.next_due_ns;
}

void Hub::advance_schedule(Conn &c, std::uint64_t now_ns) {
  if (config_.publish_period_ns == 0) {
    return;
  }
  if (!c.schedule_started) {
    c.schedule_started = true;
    c.t0_ns = now_ns;
    c.next_due_ns = now_ns + config_.publish_period_ns;
    return;
  }
  // The next due tick is the first multiple-of-P step strictly after `now`, anchored at the old
  // next_due_ns (itself always t0 + k*P for some integer k) rather than recomputed from scratch
  // against raw `now`. Anchoring at next_due_ns (not `now`) matters when a send fires slightly
  // *early*, inside tick_due()'s slack window: `now` can then be a hair before next_due_ns, and
  // a naive "t0 + (floor((now - t0)/P) + 1)*P" recomputation floors back down to the tick just
  // serviced instead of advancing past it, double-firing on the very next callback. Anchoring at
  // next_due_ns sidesteps that: when `now` is still before it (the early/on-time case), one
  // period is simply added; when `now` is at or past it (credit blocked for a while, the late
  // case), the step jumps straight to the first tick after `now`, skipping every missed one in
  // between -- "never burst" (Q3c).
  std::uint64_t steps = 1;
  if (now_ns >= c.next_due_ns) {
    steps = (now_ns - c.next_due_ns) / config_.publish_period_ns + 1;
  }
  c.next_due_ns += steps * config_.publish_period_ns;
}

std::string Hub::send_transaction(Conn &c, const std::shared_ptr<const rs::Captured> &target,
                                  std::uint64_t frame, std::uint64_t now_ns, std::uint64_t epoch,
                                  std::uint64_t snapshot_ns, bool first, std::uint64_t capture_ns,
                                  std::uint64_t stale_from) {
  const rs::Captured &snapshot = *target;
  // G2b2: the inline payloads this connection has not carried yet, one resource record per
  // message, ahead of the transaction that needs them (render-stream-2.md "Live transport");
  // since G5e every `ok` mesh's surfaces too, after the textures. P3-SP: the hashes are looked up
  // once per target and each record is encoded once per frame callback, whichever connection
  // sends it first.
  //
  // W11b (render-stream-11.md "Resource retention"): a /11 connection sends the hashes of
  // inline(T) not in inline(B), B the last snapshot it sent (rs2_diff.h records_before), in the
  // same table order, and marks nothing: its carried set is inline(B) by L2. keep-carried keeps
  // /10's set instead.
  const bool v11 = is_v11_or_later(c.version);
  std::vector<std::pair<const std::string *, std::uint32_t>> to_send;  // (hash, CarriedIndex id)
  std::vector<PayloadName> kept;  // keep-carried's records (to_send points into it)
  if (v11) {
    const std::shared_ptr<const rs::Captured> record_base = c.has_base ? c.base : nullptr;
    if (c.keep_carried != nullptr) {
      kept = c.keep_carried->next(record_base != nullptr ? &record_base->state : nullptr,
                                  snapshot.state);
      for (const PayloadName &name : kept) {
        to_send.emplace_back(&name.hash, CarriedIndex::kNoId);
      }
      c.carried_count = c.keep_carried->carried_count();
    } else {
      const V11Records &records =
          v11_records(record_base, target, !is_v12_or_later(c.version));
      for (const PayloadName &name : records.records) {
        to_send.emplace_back(&name.hash, CarriedIndex::kNoId);
      }
      c.carried_count = records.inline_count;  // C after this transaction is inline(T) (L2)
    }
  } else {
    const TargetRefs &refs = target_refs(target);
    for (std::size_t i = 0; i < refs.refs.size(); ++i) {
      const std::uint32_t id = refs.ids[i];
      if (id == CarriedIndex::kNoId || carried_.carried(id, c.carried_slot)) {
        continue;
      }
      if (refs.refs[i].shader != nullptr && refs.refs[i].shader->has_ppm) {
        continue;  // PM5: a process-material shader is a payload only at /12 (lower_particles)
      }
      to_send.emplace_back(refs.refs[i].hash, id);
    }
  }
  for (const auto &send : to_send) {
    const std::string &hash = *send.first;
    const std::uint32_t id = send.second;
    if (!v11 && carried_.carried(id, c.carried_slot)) {
      continue;  // a hash payload_refs names twice: carried by its first occurrence just now
    }
    const auto payload = snapshot.payloads.find(hash);
    if (payload == snapshot.payloads.end() || payload->second == nullptr) {
      continue;  // never happens: a Captured holds every payload its tables name
    }
    std::shared_ptr<const std::vector<std::uint8_t>> &record_bytes =
        v11 ? frame_records_v11_[hash] : frame_records_[id];
    if (record_bytes == nullptr) {
      ResourceRecord record;
      record.hash = hash;
      record.payload = *payload->second;
      record_bytes = std::make_shared<const std::vector<std::uint8_t>>(encode_resource(record));
    }
    const std::vector<std::uint8_t> &bytes = *record_bytes;
    const std::uint64_t payload_size = payload->second->size();
    if (bytes.size() > c.s.max_message_bytes) {
      const std::string detail = "resource " + hash + " is " +
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
    std::shared_ptr<const std::vector<std::uint8_t>> wire;
    if (c.coding != rs::live_coding::Coding::Off) {
      wire = coded_plain(c, bytes, hash);
    }
    deliver(c, bytes, true, wire.get());
    if (!v11) {
      carried_.mark(id, c.carried_slot);
      ++c.carried_count;
    }
    ++c.s.resource_records;
    c.s.resource_bytes += payload_size;
    ++c.stats.resource_records;
    c.stats.resource_bytes += payload_size;
    c.stats.bytes_total += bytes.size();
    c.stats.max_record_bytes = std::max<std::uint64_t>(c.stats.max_record_bytes, bytes.size());
    log_line(c, Line()
                    .num("frame", frame)
                    .num("t_us", now_ns / 1000)
                    .str("event", "resource")
                    .str("hash", hash)
                    .num("bytes", payload_size)
                    .take());
  }
  // /7 is byte-identical to /6 (render-stream-7.md) but faithful; /8 carries the new table fields
  // (render-stream-8.md): a /7-or-later connection's own version stamps its transactions.
  TxMeta meta;
  meta.version = is_v7_or_later(c.version) ? c.version : snapshot.state.version;
  meta.seq = c.next_seq;
  meta.frame = frame;
  meta.base_seq = c.base_seq;
  // PM1 sabotage perturb-instance: a function of the frame, so lockstep viewers still share.
  meta.perturb_instance = v11 && config_.perturb_instance_frame != 0 &&
                          frame >= config_.perturb_instance_frame;
  // PM5 sabotage perturb-seed, likewise (a /12 connection only).
  meta.perturb_seed = is_v12_or_later(c.version) && config_.perturb_seed_frame != 0 &&
                      frame >= config_.perturb_seed_frame;
  const bool full = !c.has_base || c.resync;
  const std::shared_ptr<const rs::Captured> base = full ? nullptr : c.base;
  // P3-SP: the same transaction already formed this callback (another connection in lockstep).
  SharedTx *shared = nullptr;
  for (const auto &tx : frame_txs_) {
    if (tx->full == full && tx->base == base && tx->target == target &&
        tx->meta.version == meta.version && tx->meta.frame == meta.frame &&
        tx->meta.perturb_instance == meta.perturb_instance &&
        tx->meta.perturb_seed == meta.perturb_seed) {
      shared = tx.get();
      break;
    }
  }
  const std::uint64_t t0 = monotonic_ns();
  std::uint64_t t1 = t0;
  std::shared_ptr<const std::vector<std::uint8_t>> encoded;
  if (shared != nullptr) {
    auto out = std::make_shared<std::vector<std::uint8_t>>();
    if (restamp(*shared->bytes, shared->meta, meta, full, out.get())) {
      encoded = std::move(out);
      ++c.s.shared_sends;
    }
  }
  if (encoded == nullptr) {
    const Transaction transaction =
        full ? make_full(snapshot.state, meta) : make_patch(base->state, snapshot.state, meta);
    t1 = monotonic_ns();
    encoded = std::make_shared<const std::vector<std::uint8_t>>(encode_transaction(transaction));
    if (shared == nullptr) {
      auto tx = std::make_unique<SharedTx>();
      tx->base = base;
      tx->target = target;
      tx->meta = meta;
      tx->full = full;
      tx->bytes = encoded;
      frame_txs_.push_back(std::move(tx));
    }
  }
  const std::uint64_t t2 = monotonic_ns();
  const std::vector<std::uint8_t> &bytes = *encoded;
  if (bytes.size() > c.s.max_message_bytes) {
    const std::string detail = "transaction " + std::to_string(meta.seq) + " is " +
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
  std::shared_ptr<const std::vector<std::uint8_t>> wire;
  if (c.coding != rs::live_coding::Coding::Off) {
    // W11t: coded against the last transaction formed here (its uncoded message), which is the
    // base this patch names; a full transaction has none.
    if (full) {
      c.last_tx = nullptr;
    }
    wire = coded_tx(c, encoded, meta.seq, frame, now_ns);
  }
  c.last_tx = encoded;
  if (!deliver(c, bytes, !drop, wire.get())) {
    log_line(c, Line()
                    .num("frame", frame)
                    .num("t_us", now_ns / 1000)
                    .str("event", "error")
                    .str("reason", "send-failed")
                    .str("detail", "the transport refused seq " + std::to_string(meta.seq))
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
  // Q3d encode_us / diff_us (G6r): the same costs just accumulated above, also sampled into the
  // cross-connection histograms perf.json reports distributions from.
  encode_hist_.add(((full ? t1 - t0 : 0) + (t2 - t1)) / 1000);
  if (!full) {
    diff_hist_.add((t1 - t0) / 1000);
  }

  const std::uint64_t seq = meta.seq;
  const bool had_credit = c.credit;
  if (c.window_slots > 1 && c.has_base &&
      std::find(c.window.begin(), c.window.end(), c.base_seq) != c.window.end()) {
    // G7q: the last sent is still in flight, so its payloads stay pinned past this send.
    c.window_payloads[c.base_seq] = std::move(c.base);
  }
  c.base = target;
  c.base_seq = seq;
  c.has_base = true;
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
    // One window slot per send. A send without a free slot (the ignore-credit and window-overrun
    // sabotages) takes the newest slot from the oldest seq, whose late ack is then stale.
    c.window.push_back(seq);
    while (c.window.size() > c.window_slots) {
      c.window_payloads.erase(c.window.front());
      c.window.pop_front();
    }
    c.credit = c.window.size() < c.window_slots;
    c.uncredited.insert(seq);
    c.sent_at[seq] = Conn::Sent{now_ns, frame, 0, capture_ns};
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
  if (!c.window.empty()) {
    line.num("in_flight", c.window.back());
  } else {
    line.null("in_flight");
  }
  if (c.window_slots > 1) {
    // G7q: every seq holding a slot, oldest first (window >= 2 connections only).
    std::string list;
    for (const std::uint64_t seq : c.window) {
      list += (list.empty() ? "" : ",") + std::to_string(seq);
    }
    line.raw("in_flight_seqs", "[" + list + "]");
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
  on_frame_shared(frame, now_ns,
                  snapshot == nullptr ? nullptr : std::make_shared<const rs::Captured>(*snapshot),
                  epoch, snapshot_ns);
}

void Hub::on_frame_shared(std::uint64_t frame, std::uint64_t now_ns,
                          std::shared_ptr<const rs::Captured> snapshot, std::uint64_t epoch,
                          std::uint64_t snapshot_ns) {
  if (finished_) {
    return;
  }
  frame_ = frame;
  carried_.maintain();
  clear_frame_memo();
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
        // G7n: the connection's own version (render-stream.7 -> /7: the GRS7 magic, the /7
        // protocol string and publication.credit_window, the grant).
        c.session.version = c.version;
        if (is_v10_or_later(template_.version) && !is_v10_or_later(c.version)) {
          // render-stream-10.md "Live transport": a /9-or-older connection on a /10 (or /11) host
          // gets its own version's session, which still declares both back-buffer setters
          // unobserved.
          declare_backbuffer_unobserved(&c.session.features);
        }
        if (is_v12_or_later(template_.version) && !is_v12_or_later(c.version)) {
          // PM5: below /12 the session of a /12 host declares canvas_item_add_particles unsupported, as before
          // PM5 (make_full/make_patch lower its transactions: rs2_diff.h lower_particles).
          unobserve_particles_features(&c.session.features);
        }
        if (!is_v11_or_later(c.version)) {
          // PM1 rule 8: below /11 the session declares canvas_item_add_multimesh unsupported, as
          // before PM1 (make_full/make_patch lower its transactions: rs2_diff.h lower_multimesh).
          unobserve_multimesh_features(&c.session.features);
        }
        c.session.publication.credit_window = static_cast<std::int32_t>(c.s.credit_window);
        c.session.stream.stream_id = c.s.stream_id;
        c.session.stream.has_connection = true;
        c.session.stream.connection = c.s.connection;
        c.session.stream.transport = Transport::Websocket;
        c.session.stream.encoding = Encoding::Patch;
        // render-stream-6.md "Publication" (G6b, gate6-design.md D8): a live connection declares
        // GRC_PUBLISH_FPS; uncapped is every-frame/null, as every file sink.
        if (config_.publish_period_ns == 0) {
          c.session.publication.mode = PublicationMode::EveryFrame;
          c.session.publication.has_target_fps = false;
          c.session.publication.target_fps = 0;
        } else {
          c.session.publication.mode = PublicationMode::Rate;
          c.session.publication.has_target_fps = true;
          c.session.publication.target_fps = static_cast<std::int32_t>(config_.publish_target_fps);
        }
        const std::uint64_t t0 = monotonic_ns();
        const std::vector<std::uint8_t> session_bytes = encode_session(c.session);
        const std::uint64_t t1 = monotonic_ns();
        std::vector<std::uint8_t> message = magic(c.session.version);
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
        std::shared_ptr<const std::vector<std::uint8_t>> wire;
        if (c.coding != rs::live_coding::Coding::Off) {
          wire = coded_plain(c, message, "");  // W11t: the first message is coded too
        }
        deliver(c, message, true, wire.get());
        c.stats.bytes_total += message.size();  // the magic counts (render-stream-0.md)
        c.stats.max_record_bytes =
            std::max<std::uint64_t>(c.stats.max_record_bytes, session_bytes.size());
        c.stats.encode_ns_total = saturating_add(c.stats.encode_ns_total, t1 - t0);
        c.state = State::Streaming;
        if (!is_v11_or_later(c.version)) {
          c.carried_slot = carried_.acquire();  // a fresh connection has carried nothing
        } else if (config_.keep_carried) {
          // W11b sabotage keep-carried: /10's lifelong set on a /11 connection.
          InlinePolicy policy;
          policy.inline_max_bytes = template_.resources.inline_max_bytes;
          c.keep_carried = std::make_unique<RecordPlanner>(c.version, policy, true);
        }
        ++c.s.frames_offered;
        sent_json = send_transaction(c, snapshot, frame, now_ns, epoch, snapshot_ns, true, now_ns);
        // G6r: this very first send starts the connection's rate schedule (its tick 0); it is
        // never itself rate-gated (there is nothing to compare "due" against until now).
        advance_schedule(c, now_ns);
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
      const bool rate_limited = config_.publish_period_ns != 0;
      // G7q window-overrun: past a full window, still paced (unlike ignore-credit).
      const bool overrun =
          config_.window_overrun_frame != 0 && frame >= config_.window_overrun_frame;
      // G6r Q3c: ignore-credit's whole point is a send at every callback, credit or not, so it
      // bypasses pacing too, not only credit. Under the default GRC_PUBLISH_FPS=uncapped,
      // tick_due() is always true, so `due` adds nothing and every ticks_*/frames_rate_idle
      // counter below stays 0 (each is gated on `rate_limited`).
      const bool due = ignore_credit || tick_due(c, now_ns);
      if (c.credit && c.stale != nullptr) {
        // stale-coalesce: the first missed target goes out instead of the newest state.
        if (due) {
          if (rate_limited) {
            ++c.s.ticks_due;
          }
          const std::shared_ptr<const rs::Captured> stale = std::move(c.stale);
          const std::uint64_t stale_capture_ns = c.stale_ns;
          c.stale.reset();
          const std::uint64_t sent_before = c.s.sent;
          sent_json = send_transaction(c, stale, frame, now_ns, epoch, snapshot_ns, false,
                                       stale_capture_ns, c.stale_frame);
          advance_schedule(c, now_ns);
          if (rate_limited && c.s.sent > sent_before) {
            ++c.s.ticks_sent;
          }
          if (c.window_slots > 1 && c.s.sent > sent_before && !c.window.empty()) {
            c.stale_held = stale;
            c.stale_held_seq = c.window.back();
            c.stale_held_frame = c.stale_frame;
            c.stale_held_ns = stale_capture_ns;
          }
        } else {
          ++c.s.frames_rate_idle;
        }
      } else if (c.credit || ignore_credit || overrun) {
        if (due) {
          if (rate_limited) {
            ++c.s.ticks_due;
          }
          if (snapshot == nullptr) {
            continue;
          }
          if (c.stale_held != nullptr &&
              std::find(c.window.begin(), c.window.end(), c.stale_held_seq) == c.window.end()) {
            c.stale_held.reset();  // its seq was credited (or resynced): drawn on its own
          }
          const std::uint64_t sent_before = c.s.sent;
          if (c.stale_held != nullptr) {
            // G7q stale-coalesce at window >= 2: repeat the stale target while it is in flight.
            const std::shared_ptr<const rs::Captured> held = c.stale_held;
            sent_json = send_transaction(c, held, frame, now_ns, epoch, snapshot_ns, false,
                                         c.stale_held_ns, c.stale_held_frame);
          } else {
            sent_json = send_transaction(c, snapshot, frame, now_ns, epoch, snapshot_ns, false,
                                         now_ns);
          }
          advance_schedule(c, now_ns);
          if (rate_limited && c.s.sent > sent_before) {
            ++c.s.ticks_sent;
          }
        } else {
          ++c.s.frames_rate_idle;
        }
      } else {
        // No credit (and not ignore-credit): a due tick with no credit is counted independently
        // of whether the mirror actually changed since the last send (Q3c: "callbacks where a
        // tick was due without credit").
        if (rate_limited && due) {
          ++c.s.ticks_due;
          ++c.s.ticks_credit_blocked;
        }
        if (epoch != c.epoch_sent) {
          // The mirror moved since the last send: the one pending target (the mirror itself) is
          // replaced by this callback's state; nothing is serialized.
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
              c.stale == nullptr && snapshot != nullptr) {
            c.stale = snapshot;
            c.stale_ns = now_ns;
            c.stale_frame = frame;
          }
        }
      }
    }
    if (c.state == State::Closed) {
      continue;  // closed by an error above (logged there)
    }
    log_frame(c, frame, now_ns, credit_before, sent_json);
  }
  clear_frame_memo();  // P3-SP: the shared work holds snapshots; it lives for one callback
  flush_taps();
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
      std::shared_ptr<const std::vector<std::uint8_t>> wire;
      if (c.coding != rs::live_coding::Coding::Off) {
        wire = coded_plain(c, bytes, "");
      }
      deliver(c, bytes, true, wire.get());
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
  flush_taps();
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
    s.carried_size = c.carried_count;
    for (std::size_t i = 0; i < 3; ++i) {
      s.ack_latency_us[i] = latency_stats(c.latency[i]);
    }
    s.credit_rtt_us = latency_stats(c.credit_rtt);
    s.credit_rtt_frames = latency_stats(c.credit_frames);
    s.credit_rtt_count = c.credit_rtt.size();
    for (const std::uint64_t v : c.credit_rtt) s.credit_rtt_sum_us += v;
    for (const std::uint64_t v : c.credit_frames) s.credit_rtt_frames_sum += v;
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

namespace {

// P3-SP: connections in lockstep share one snapshot, so its payload map is listed once.
void push_unique(std::vector<const rs::PayloadMap *> *out, const rs::PayloadMap *map) {
  if (std::find(out->begin(), out->end(), map) == out->end()) {
    out->push_back(map);
  }
}

}  // namespace

std::vector<const rs::PayloadMap *> Hub::base_payloads() const {
  std::vector<const rs::PayloadMap *> out;
  for (const auto &entry : conns_) {
    const Conn &c = *entry.second;
    if (c.state != State::Closed && c.has_base && c.base != nullptr) {
      push_unique(&out, &c.base->payloads);
      // G7q: every other in-flight transaction's payloads (window >= 2; none at window 1).
      for (const auto &held : c.window_payloads) {
        push_unique(&out, &held.second->payloads);
      }
    }
  }
  return out;
}

std::vector<const rs::PayloadMap *> Hub::held_payloads() const {
  std::vector<const rs::PayloadMap *> out;
  for (const auto &entry : conns_) {
    const Conn &c = *entry.second;
    if (c.state != State::Closed && c.stale != nullptr) {
      push_unique(&out, &c.stale->payloads);
    }
  }
  return out;
}

std::uint32_t Hub::on_http_get(const std::string &hash, std::uint16_t status, std::uint64_t bytes,
                               std::uint64_t t_ns, std::uint64_t frame, bool preflight) {
  // With one receiver, the GET is its own (max_clients 1, today's default). With more than one
  // open connection (GRC_LIVE_MAX_CONNECTIONS > 1, G6r/D13), which receiver asked for it is
  // ambiguous, so it is counted at the host level only (the caller's ServingSummary) and no
  // connection's summary or live log gains a line for it.
  Conn *streaming = nullptr;
  std::size_t open = 0;
  for (auto &entry : conns_) {
    Conn &c = *entry.second;
    if (c.state != State::Closed) {
      ++open;
      if (streaming == nullptr || c.s.connection > streaming->s.connection) {
        streaming = &c;
      }
    }
  }
  if (streaming == nullptr || open > 1) {
    return 0;
  }
  Conn &c = *streaming;
  if (preflight) {
    ++c.s.preflights;
  } else {
    ++c.s.http_gets;
    if (status == 200) {
      c.s.http_bytes += bytes;
    } else {
      ++c.s.http_errors;
    }
  }
  log_line(c, Line()
                  .num("frame", frame)
                  .num("t_us", t_ns / 1000)
                  .str("event", preflight ? "preflight" : "http-get")
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
    // G7n (gate7-design.md Q3 "Evidence"): the connection's version and its /7 hello.
    json.field("version", static_cast<int64_t>(s.version));
    json.field_or_null("receiver_kind", s.receiver_kind);
    json.field("credit_window", static_cast<int64_t>(s.credit_window));
    if (s.has_hello7) {
      json.field("credit_window_requested", static_cast<int64_t>(s.credit_window_requested));
    } else {
      json.field_null("credit_window_requested");
    }
    json.field_or_null("manifest_sha256", s.manifest_sha256);
    const char *const presentation_keys[] = {"presentation_backing_w", "presentation_backing_h",
                                             "presentation_css_w", "presentation_css_h",
                                             "dpr_milli"};
    const std::uint64_t presentation_values[] = {s.presentation_backing_w,
                                                 s.presentation_backing_h, s.presentation_css_w,
                                                 s.presentation_css_h, s.dpr_milli};
    for (std::size_t i = 0; i < 5; ++i) {
      if (s.has_hello7) {
        json.field(presentation_keys[i], static_cast<int64_t>(presentation_values[i]));
      } else {
        json.field_null(presentation_keys[i]);
      }
    }
    json.field_or_null("origin", s.origin);
    if (s.version == 9 || s.version == 10 || s.version == 11 || s.version == 12) {
      // render-stream-9.md "Hello": the /9 hello's delivery preferences, /9 to /11 connections
      // only (render-stream-10.md and -11.md: their hellos are /9's).
      json.field_or_null("texture_encodings", s.texture_encodings);
      json.field_or_null("gpu_formats", s.gpu_formats);
    }
    if (s.version == 11 || s.version == 12) {
      // W11t: the live coding (render-stream-11.md "As built (W11t)").
      json.key("live_coding").object_begin();
      if (s.has_live_coding) {
        json.field("offered", s.live_coding_offer);
      } else {
        json.field_null("offered");
      }
      json.field("coding", s.live_coding);
      json.field("messages", static_cast<int64_t>(s.coded_messages));
      json.field("prefixed", static_cast<int64_t>(s.coded_prefixed));
      json.field("shared", static_cast<int64_t>(s.coded_shared));
      json.field("input_bytes", static_cast<int64_t>(s.coded_input_bytes));
      json.field("wire_bytes", static_cast<int64_t>(s.coded_wire_bytes));
      json.field("encode_us", static_cast<int64_t>(s.coding_ns / 1000));
      if (s.wrong_prefix_seq != 0) {
        json.field("wrong_prefix_seq", static_cast<int64_t>(s.wrong_prefix_seq));
      } else {
        json.field_null("wrong_prefix_seq");
      }
      json.object_end();
    }
    if (s.token_checked) {
      json.field("token_ok", s.token_ok);
    } else {
      json.field_null("token_ok");
    }
    json.field("preflights", static_cast<int64_t>(s.preflights));
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
    json.field("ticks_due", static_cast<int64_t>(s.ticks_due));
    json.field("ticks_sent", static_cast<int64_t>(s.ticks_sent));
    json.field("ticks_credit_blocked", static_cast<int64_t>(s.ticks_credit_blocked));
    json.field("frames_rate_idle", static_cast<int64_t>(s.frames_rate_idle));
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
  // G6r (D8): the host's rate configuration, in evidence form -- the same value every /6
  // connection's session declares as `publication` since G6b; GRC_PUBLISH_FPS=uncapped (the
  // default) is "every-frame"/null, matching a file sink's declared publication exactly.
  json.key("publication").object_begin();
  json.field("mode", config_.publish_period_ns == 0 ? std::string("every-frame")
                                                     : std::string("rate"));
  if (config_.publish_period_ns == 0) {
    json.field_null("target_fps");
  } else {
    json.field("target_fps", static_cast<int64_t>(config_.publish_target_fps));
  }
  json.object_end();
  if (resources != nullptr) {
    json.key("resources").object_begin();
    json.field("http_gets", static_cast<int64_t>(resources->http_gets));
    json.field("http_bytes", static_cast<int64_t>(resources->http_bytes));
    json.field("http_coded_bytes", static_cast<int64_t>(resources->http_coded_bytes));
    json.field("http_encoding", resources->http_encoding);
    json.field("http_gets_zstd", static_cast<int64_t>(resources->http_gets_zstd));
    json.field("http_gets_gzip", static_cast<int64_t>(resources->http_gets_gzip));
    json.field("coded_made", static_cast<int64_t>(resources->coded_made));
    json.field("coded_in_bytes", static_cast<int64_t>(resources->coded_in_bytes));
    json.field("coded_out_bytes", static_cast<int64_t>(resources->coded_out_bytes));
    json.field("coded_ns", static_cast<int64_t>(resources->coded_ns));
    json.field("http_errors", static_cast<int64_t>(resources->http_errors));
    json.field("preflights", static_cast<int64_t>(resources->preflights));
    json.field("origin_rejected", static_cast<int64_t>(resources->origin_rejected));
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
