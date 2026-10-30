#include "rs_live.h"

#include <algorithm>
#include <atomic>
#include <cerrno>
#include <chrono>
#include <condition_variable>
#include <cstring>
#include <deque>
#include <mutex>
#include <set>
#include <thread>
#include <utility>

#include "report.h"
#include "rs13_predict.h"
#include "rs2_codec.h"
#include "rs2_diff.h"
#include "rs_publish.h"
#include "rs_records.h"
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
  // TAG1 (client-extensions-design.md §2.1): the one nested value of any control message, the
  // /13 hello's `item_meta`: an object whose values are arrays of strings.
  bool is_object = false;
  std::vector<std::pair<std::string, std::vector<std::string>>> object;
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
        } else if (c == '{' && key == "item_meta") {
          value.is_object = true;
          if (!string_lists(&value.object)) {
            return fail(error, "\"item_meta\" is not an object of arrays of strings");
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
  // TAG1: {"key": ["s", ...], ...} (duplicate keys refused; the caller checks the names).
  bool string_lists(std::vector<std::pair<std::string, std::vector<std::string>>> *out) {
    if (!expect('{')) {
      return false;
    }
    skip_ws();
    if (peek() == '}') {
      ++p_;
      return true;
    }
    for (;;) {
      skip_ws();
      std::string key;
      if (peek() != '"' || !string(&key)) {
        return false;
      }
      for (const auto &have : *out) {
        if (have.first == key) {
          return false;
        }
      }
      skip_ws();
      if (!expect(':')) {
        return false;
      }
      skip_ws();
      if (!expect('[')) {
        return false;
      }
      std::vector<std::string> list;
      skip_ws();
      if (peek() == ']') {
        ++p_;
      } else {
        for (;;) {
          skip_ws();
          std::string item;
          if (peek() != '"' || !string(&item)) {
            return false;
          }
          list.push_back(std::move(item));
          skip_ws();
          if (peek() == ',') {
            ++p_;
            continue;
          }
          if (!expect(']')) {
            return false;
          }
          break;
        }
      }
      out->emplace_back(std::move(key), std::move(list));
      skip_ws();
      if (peek() == ',') {
        ++p_;
        continue;
      }
      return expect('}');
    }
  }
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
  return version == ProtocolVersion::V13   ? kProtocolV13
         : version == ProtocolVersion::V12 ? kProtocolV12
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
  // TAG1 (client-extensions-design.md §2.1): a /13 hello may also carry `item_meta`; below /13
  // the key is unknown (a hello error), as every other key is.
  const bool optional_item_meta =
      message.type == ControlType::Hello && version == ProtocolVersion::V13;
  for (const auto &field : fields) {
    if (optional_live_coding && field.first == "live_coding") {
      continue;
    }
    if (optional_item_meta && field.first == "item_meta") {
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
        if (optional_item_meta && find("item_meta") != nullptr) {
          const Value *value = find("item_meta");
          if (!value->is_object) {
            return fail("\"item_meta\" must be an object (null is not \"not asked\": omit it)");
          }
          rs::item_meta::Request request;
          const char *names[3] = {"fields", "groups", "meta_keys"};
          std::vector<std::string> *lists[3] = {&request.fields, &request.groups,
                                                &request.meta_keys};
          if (value->object.size() != 3) {
            return fail("\"item_meta\" must have exactly fields, groups and meta_keys");
          }
          for (int k = 0; k < 3; ++k) {
            bool found = false;
            for (const auto &entry : value->object) {
              if (entry.first == names[k]) {
                *lists[k] = entry.second;
                found = true;
              }
            }
            if (!found) {
              return fail(std::string("\"item_meta\" has no \"") + names[k] + "\"");
            }
          }
          const std::string problem = rs::item_meta::request_problem(request);
          if (!problem.empty()) {
            return fail(problem);
          }
          message.has_item_meta = true;
          message.item_meta = std::move(request);
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

namespace {
Formation g_default_formation = Formation::Inline;
bool g_default_formation_wait = false;
}  // namespace

Formation default_formation() { return g_default_formation; }
bool default_formation_wait() { return g_default_formation_wait; }
void set_default_formation(Formation formation, bool wait) {
  g_default_formation = formation;
  g_default_formation_wait = wait;
}

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
  // W11t: the connection's live coding (negotiated at the hello, /11 only). The uncoded message
  // of the last transaction formed on it (the next patch's prefix) is `form->last_tx` (HC5).
  rs::live_coding::Coding coding = rs::live_coding::Coding::Off;
  // HC5: the connection's formation-side state (stable: the job runner holds a pointer), and the
  // job this frame callback is building for it (null outside on_frame_shared).
  std::unique_ptr<FormState> form;
  Job *job = nullptr;
  // TAG1: the grant this connection's item_meta records carry (null: not asked, or refused).
  std::shared_ptr<const rs::item_meta::Request> meta_grant;
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
  // W13p: at /13, the transaction's typed meta keys for the predictor (rs13::predict_meta()).
  std::shared_ptr<const rs13::PredictMeta> predict;
};

// HC5 (rs_live.h header, "Formation"): a connection's state on the formation side, touched only
// by whichever thread runs the jobs (the main thread creates it at open, and clears `tap` only
// after a sync, when no job is outstanding).
struct Hub::FormState {
  std::uint32_t id = 0;  // the transport connection id
  std::FILE *tap = nullptr;
  rs::live_coding::Coding coding = rs::live_coding::Coding::Off;
  // W11t: the uncoded message of the last transaction formed on this connection (sent or
  // dropped): the next patch's coding prefix.
  std::shared_ptr<const std::vector<std::uint8_t>> last_tx;
  // W13b (render-stream-13.md "As built (W13b)"): a /13 connection's predictor, H1 and H2 the
  // prediction states after the last two transactions formed on it (sent or dropped), in job
  // order, as the receiver accepts them. A full transaction resets it (rs13::Predictor::encode),
  // so a resync needs nothing more. Unused below /13.
  rs13::Predictor predictor;
  // W13f: the /13 message before last_tx and the last typed meta this connection built: the next
  // /13 coding writes into the one and predict_meta() into the other (their capacity kept: no
  // allocation, no zero fill) once nothing else holds them (the memo and W11t's coded memo let go
  // when their callback ends).
  std::shared_ptr<const std::vector<std::uint8_t>> spare_out;
  std::shared_ptr<const rs13::PredictMeta> spare_meta;
  // TAG1 (client-extensions-design.md §2.4): what this connection's receiver holds of its grant's
  // table: the rows stamped up to `meta_stamp` and the first `meta_strings` strings, and whether
  // a full record went out (sabotage skip-full skips every later one).
  std::uint64_t meta_stamp = 0;
  std::uint64_t meta_strings = 0;
  std::uint64_t meta_fulls = 0;
};

namespace {
// W13f: `spare` back as writable storage when its last holder is `spare` itself, else a fresh one.
template <class T>
std::shared_ptr<T> reuse_or_make(std::shared_ptr<const T> *spare) {
  std::shared_ptr<const T> held = std::move(*spare);
  if (held != nullptr && held.use_count() == 1) {
    // The other holders may have let go on the main thread: see their writes first.
    std::atomic_thread_fence(std::memory_order_acquire);
    return std::const_pointer_cast<T>(std::move(held));
  }
  return std::make_shared<T>();
}
}  // namespace

// HC5: what a job adds to its connection's summary (`s`) and end stats (`stats`): the fields a
// synchronous send_transaction() used to update while it formed and delivered.
struct Hub::Counters {
  std::uint64_t bytes_sent = 0;
  std::uint64_t max_message_sent = 0;
  std::uint64_t coded_messages = 0;
  std::uint64_t coded_prefixed = 0;
  std::uint64_t coded_shared = 0;
  std::uint64_t coded_input_bytes = 0;
  std::uint64_t coded_wire_bytes = 0;
  std::uint64_t coding_ns = 0;
  std::uint64_t shared_sends = 0;
  std::uint64_t resource_records = 0;
  std::uint64_t resource_bytes = 0;
  std::uint64_t record_bytes_total = 0;  // the records' message bytes (EndStats::bytes_total)
  std::uint64_t max_record_bytes = 0;
  std::uint64_t wrong_prefix_seq = 0;
  std::uint64_t predict_formed = 0;  // W13b
  std::uint64_t predict_shared = 0;
  std::uint64_t predict_plain_bytes = 0;
  std::uint64_t predict_bytes = 0;
  std::uint64_t predict_ns = 0;
  std::uint64_t predict_stale_seq = 0;
  std::uint64_t predict_states_reused = 0;  // W13f
  std::uint64_t predict_states_made = 0;
  std::uint64_t item_meta_full = 0;  // TAG1
  std::uint64_t item_meta_delta = 0;
  std::uint64_t item_meta_bytes = 0;
  std::uint64_t item_meta_rows = 0;
  std::uint64_t item_meta_shared = 0;
  std::vector<std::uint64_t> enqueue_us;  // Q3d enqueue_us samples, in send order
};

// HC5: one connection's formation for one frame callback. The main thread fills the inputs and
// the frame line's fields, the job runner fills `out`, the main thread completes it (complete()).
struct Hub::Job {
  Conn *conn = nullptr;       // read by complete() only (main thread)
  FormState *form = nullptr;  // the runner's per-connection state
  bool batch_end = false;     // the callback's last job: releases the memo, flushes the taps
  std::uint64_t frame = 0;
  std::uint64_t now_ns = 0;
  std::uint64_t max_message_bytes = 0;
  // A connection's first job: the magic + session message (encoded and size-checked already).
  std::shared_ptr<const std::vector<std::uint8_t>> session;
  // The transaction (every job but a batch end has one).
  bool has_tx = false;
  std::shared_ptr<const rs::Captured> target;
  bool v11 = false;
  // /11 without keep-carried: the runner plans the records before `target` from `record_base`
  // (W11b, HC4b plan_v11_records); otherwise `given` are the hashes the main thread chose (the
  // below-/11 CarriedIndex walk, keep-carried's planner) with their CarriedIndex ids.
  bool plan_v11 = false;
  bool lower = false;
  std::shared_ptr<const rs::Captured> record_base;
  std::vector<std::pair<std::string, std::uint32_t>> given;
  TxMeta meta;
  bool full = false;
  std::shared_ptr<const rs::Captured> tx_base;  // null for a full transaction
  // TAG1: the connection's grant (null: no records), and the identities the main thread resolved
  // since the last submitted job (the callback's first job carries them).
  std::shared_ptr<const rs::item_meta::Request> meta_grant;
  std::vector<std::shared_ptr<const rs::item_meta::Batch>> meta_batches;
  bool send = true;      // false: drop-message (formed, tapped, never sent)
  bool reorder = false;  // HC5 sabotage: the transaction goes out before its records
  // The frame line (log_frame), written when the job completes.
  bool frame_line = false;
  bool credit_before = false;
  bool drop = false;
  bool had_credit = false;
  std::uint64_t stale_from = 0;
  std::uint64_t snapshot_ns = 0;
  // Out (the runner).
  Counters out;
  std::vector<std::string> lines;  // live-log event lines, in the order formed
  bool planned = false;
  std::uint64_t inline_count = 0;
  bool error = false;  // message-too-large: the error text went out, nothing after it
  std::string error_detail;
  // The error's reason: message-too-large, or (W13b) `protocol` for a /13 coding that failed,
  // which encode_transaction's own output never does.
  std::string error_reason = "message-too-large";
  bool tx_formed = false;
  std::uint64_t tx_bytes = 0;
  std::uint64_t diff_ns = 0;
  std::uint64_t encode_ns = 0;
  std::unique_ptr<Memo> retired;  // batch end: the callback's memo, released on the main thread
  std::vector<std::FILE *> flush;  // batch end: the taps to flush
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

// W13b (render-stream-13.md "As built (W13b)"): a /13 transaction coded in this frame callback.
// Its predicted blocks are a function of the /12 transaction (SharedTx's key: base, target,
// version, frame, the perturb flags) and the predictor's history before it (H1, H2: the memo key
// gains T-2), and its meta's leading fields are re-stamped like SharedTx's. Another connection
// with the same transaction and an equal history (rs13::same_history: the same states, or equal
// ones) takes these bytes and `after` as its own predictor: lockstep viewers share the coding,
// and a viewer whose history differs (a resync, a fold, a late join) codes its own until its
// history is equal again.
struct Hub::PredictedTx {
  std::shared_ptr<const rs::Captured> base;  // null: a full transaction
  std::shared_ptr<const rs::Captured> target;
  TxMeta meta;  // the fields the coding was stamped with
  bool full = false;
  rs13::Predictor before;  // the history it was coded against (unused for a full)
  rs13::Predictor after;   // the history after it
  std::shared_ptr<const std::vector<std::uint8_t>> bytes;
};

// HC5: one frame callback's formation memo (P3-SP, W11b, W11t), the job runner's. It holds
// snapshots, so a batch end hands it back to the main thread to release.
struct Hub::Memo {
  std::vector<std::unique_ptr<SharedTx>> txs;
  std::map<std::uint32_t, std::shared_ptr<const std::vector<std::uint8_t>>> records;  // by id
  // W11b: the record list of each (base, target) pair and each /11 record's encode by hash.
  std::vector<std::unique_ptr<V11Records>> v11;
  std::map<std::string, std::shared_ptr<const std::vector<std::uint8_t>>> records_v11;
  // W11t: the callback's coded transactions, and each /11 record's plain-coded bytes by hash.
  std::vector<std::unique_ptr<CodedTx>> coded;
  std::map<std::string, std::shared_ptr<const std::vector<std::uint8_t>>> records_coded;
  // W13b: the callback's /13 codings.
  std::vector<std::unique_ptr<PredictedTx>> predicted;
  // TAG1 (client-extensions-design.md §2.4 "Order and sharing"): the callback's item_meta
  // records, keyed by (grant, form, what the receiver holds, target): lockstep viewers of one
  // grant share the raw and coded bytes.
  struct MetaRecord {
    const rs::item_meta::GrantTable *table = nullptr;
    bool full = false;
    std::uint64_t from = 0;
    std::uint64_t strings_have = 0;
    std::shared_ptr<const rs::Captured> target;
    rs::item_meta::Formed formed;
    std::shared_ptr<const std::vector<std::uint8_t>> coded;
  };
  std::vector<MetaRecord> item_meta;
};

// HC5: the encode thread. Jobs run strictly in submission order; take() waits until every job
// submitted so far has run and returns them in that order, for the main thread to complete.
class Hub::Former {
 public:
  explicit Former(Hub *hub) : hub_(hub) { thread_ = std::thread([this] { run(); }); }
  ~Former() {
    {
      std::lock_guard<std::mutex> lock(mutex_);
      stopping_ = true;
    }
    work_.notify_all();
    if (thread_.joinable()) {
      thread_.join();
    }
  }
  Former(const Former &) = delete;
  Former &operator=(const Former &) = delete;

  void submit(std::vector<std::unique_ptr<Job>> jobs) {
    {
      std::lock_guard<std::mutex> lock(mutex_);
      for (auto &job : jobs) {
        queue_.push_back(std::move(job));
      }
    }
    work_.notify_one();
  }
  bool idle() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return queue_.empty() && running_ == 0 && done_.empty();
  }
  std::vector<std::unique_ptr<Job>> take() {
    std::unique_lock<std::mutex> lock(mutex_);
    idle_.wait(lock, [&] { return queue_.empty() && running_ == 0; });
    std::vector<std::unique_ptr<Job>> out;
    std::swap(out, done_);
    return out;
  }

 private:
  void run() {
    std::unique_lock<std::mutex> lock(mutex_);
    for (;;) {
      work_.wait(lock, [&] { return stopping_ || !queue_.empty(); });
      if (queue_.empty()) {
        return;  // stopping, and everything queued has run
      }
      std::unique_ptr<Job> job = std::move(queue_.front());
      queue_.pop_front();
      ++running_;
      lock.unlock();
      hub_->run_job(*job);
      lock.lock();
      --running_;
      done_.push_back(std::move(job));
      if (queue_.empty() && running_ == 0) {
        idle_.notify_all();
      }
    }
  }

  Hub *hub_;
  mutable std::mutex mutex_;
  std::condition_variable work_;
  std::condition_variable idle_;
  std::deque<std::unique_ptr<Job>> queue_;
  std::vector<std::unique_ptr<Job>> done_;
  unsigned running_ = 0;
  bool stopping_ = false;
  std::thread thread_;
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
  for (const auto &r : memo_->v11) {
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
    memo_->v11.push_back(std::move(r));
    return *memo_->v11.back();
  }
  // HC4b: over the entries base and target do not share (rs_records.h).
  rs::RecordPlan plan = rs::plan_v11_records(base.get(), *target, policy);
  r->records = std::move(plan.records);
  r->inline_count = plan.inline_count;
  memo_->v11.push_back(std::move(r));
  return *memo_->v11.back();
}

std::shared_ptr<const std::vector<std::uint8_t>> Hub::coded_plain(
    std::uint64_t *coded_shared, std::uint64_t *coding_ns,
    const std::vector<std::uint8_t> &message, const std::string &memo_key) {
  // HC5: a non-empty memo_key reads the job runner's memo, so only a job passes one.
  if (!memo_key.empty()) {
    const auto found = memo_->records_coded.find(memo_key);
    if (found != memo_->records_coded.end()) {
      ++*coded_shared;
      return found->second;
    }
  }
  const std::uint64_t t0 = monotonic_ns();
  auto out = std::make_shared<std::vector<std::uint8_t>>();
  const bool ok = rs::live_coding::encode_plain(message.data(), message.size(), out.get());
  *coding_ns = saturating_add(*coding_ns, monotonic_ns() - t0);
  if (!ok) {
    return nullptr;
  }
  if (!memo_key.empty()) {
    memo_->records_coded[memo_key] = out;
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

std::shared_ptr<const std::vector<std::uint8_t>> Hub::form_coded_tx(
    Job &job, const std::shared_ptr<const std::vector<std::uint8_t>> &message) {
  using rs::live_coding::Coding;
  FormState &f = *job.form;
  Counters &o = job.out;
  const std::uint64_t seq = job.meta.seq;
  const std::uint64_t frame = job.frame;
  const std::uint64_t now_ns = job.now_ns;
  const std::shared_ptr<const std::vector<std::uint8_t>> base =
      f.coding == Coding::ZstdBase ? f.last_tx : nullptr;
  // The base this patch names: the last transaction formed on the connection (its seq).
  const std::uint64_t base_seq = base != nullptr ? job.meta.base_seq : 0;
  if (base != nullptr) {
    ++o.coded_prefixed;
  }
  const bool sabotage = base != nullptr && config_.coding_wrong_prefix_frame != 0 &&
                        !wrong_prefix_done_ && frame >= config_.coding_wrong_prefix_frame;
  if (!sabotage) {
    for (const auto &m : memo_->coded) {
      if (m->seq == seq && m->base_seq == base_seq && same_bytes(m->target, message) &&
          same_bytes(m->base, base)) {
        ++o.coded_shared;
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
      o.wrong_prefix_seq = seq;
      job.lines.push_back(Line()
                              .num("frame", frame)
                              .num("t_us", now_ns / 1000)
                              .str("event", "sabotage")
                              .str("kind", "coding-wrong-prefix")
                              .num("seq", seq)
                              .num("base_seq", base_seq)
                              .take());
    }
  }
  o.coding_ns = saturating_add(o.coding_ns, monotonic_ns() - t0);
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
    memo_->coded.push_back(std::move(m));
  }
  return out;
}

Hub::Hub(LiveTransport *transport, LiveConfig config, Session session_template)
    : transport_(transport),
      config_(std::move(config)),
      template_(std::move(session_template)),
      memo_(std::make_unique<Memo>()) {
  if (config_.formation == Formation::Thread) {
    former_ = std::make_unique<Former>(this);
  }
}

Hub::~Hub() {
  former_.reset();  // HC5: runs what is queued, then joins the encode thread
  batch_.clear();
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
    // HC5: only after a sync (no job of this connection outstanding), or at destruction.
    if (c.form != nullptr) {
      c.form->tap = nullptr;
    }
    std::fclose(c.tap);
    c.tap = nullptr;
  }
  if (c.log != nullptr) {
    std::fclose(c.log);
    c.log = nullptr;
  }
}

void Hub::release_closed(Conn &c) {
  if (c.meta_grant != nullptr) {
    ++item_meta_version_;  // TAG1: the union may shrink to nothing
  }
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
  sync();
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
      // W13b: render-stream.13 -> /13 (render-stream-13.md "As built (W13b)").
      c.version = event.subprotocol == kSubprotocolV13   ? ProtocolVersion::V13
                  : event.subprotocol == kSubprotocolV12 ? ProtocolVersion::V12
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
      c.form = std::make_unique<FormState>();
      c.form->id = c.id;
      c.form->tap = c.tap;
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
        if (message.has_item_meta) {
          // TAG1 (client-extensions-design.md §2.1): the operator's grant caps what is asked; an
          // empty grant is a refusal (the viewer's fulls then arrive with no record before them).
          c.s.has_item_meta = true;
          c.s.item_meta_request = message.item_meta;
          c.s.item_meta_grant = rs::item_meta::grant_for(config_.item_meta_grant, message.item_meta);
          if (!c.s.item_meta_grant.empty()) {
            c.meta_grant = std::make_shared<const rs::item_meta::Request>(c.s.item_meta_grant);
            ++item_meta_version_;
          }
          hello.str("item_meta", rs::item_meta::grant_json(message.item_meta))
              .str("item_meta_grant", c.meta_grant != nullptr
                                          ? rs::item_meta::grant_json(c.s.item_meta_grant)
                                          : std::string("refused"));
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

rs::item_meta::Request Hub::item_meta_union() const {
  rs::item_meta::Request out;
  std::uint32_t fields = 0;
  for (const auto &entry : conns_) {
    const Conn &c = *entry.second;
    if (c.state == State::Closed || c.meta_grant == nullptr) {
      continue;
    }
    fields |= c.meta_grant->field_bits();
    for (const auto *pair : {&c.meta_grant->groups, &c.meta_grant->meta_keys}) {
      std::vector<std::string> &into = pair == &c.meta_grant->groups ? out.groups : out.meta_keys;
      for (const std::string &name : *pair) {
        if (std::find(into.begin(), into.end(), name) == into.end()) {
          into.push_back(name);
        }
      }
    }
  }
  for (int i = 0; i < rs::item_meta::kFieldCount; ++i) {
    if ((fields & (1u << i)) != 0) {
      out.fields.push_back(rs::item_meta::kFieldNames[i]);
    }
  }
  return out;
}

bool Hub::has_connection_below_v11() const {
  for (const auto &entry : conns_) {
    const Conn &c = *entry.second;
    if (c.state != State::Closed && !is_v11_or_later(c.version)) {
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

Hub::Job &Hub::batch_job(Conn &c) {
  if (c.job == nullptr) {
    auto job = std::make_unique<Job>();
    job->conn = &c;
    job->form = c.form.get();
    batch_.push_back(std::move(job));
    c.job = batch_.back().get();
  }
  return *c.job;
}

void Hub::send_transaction(Conn &c, const std::shared_ptr<const rs::Captured> &target,
                           std::uint64_t frame, std::uint64_t now_ns, std::uint64_t epoch,
                           std::uint64_t snapshot_ns, bool first, std::uint64_t capture_ns,
                           std::uint64_t stale_from) {
  const rs::Captured &snapshot = *target;
  Job &job = batch_job(c);
  job.frame = frame;
  job.now_ns = now_ns;
  job.max_message_bytes = c.s.max_message_bytes;
  job.has_tx = true;
  job.target = target;
  job.snapshot_ns = snapshot_ns;
  job.stale_from = stale_from;
  job.reorder = config_.reorder_frame != 0 && frame >= config_.reorder_frame;
  // G2b2: the inline payloads this connection has not carried yet, one resource record per
  // message, ahead of the transaction that needs them (render-stream-2.md "Live transport");
  // since G5e every `ok` mesh's surfaces too, after the textures. P3-SP: the hashes are looked up
  // once per target and each record is encoded once per frame callback, whichever connection
  // sends it first.
  //
  // W11b (render-stream-11.md "Resource retention"): a /11 connection sends the hashes of
  // inline(T) not in inline(B), B the last snapshot it sent (rs2_diff.h records_before), in the
  // same table order, and marks nothing: its carried set is inline(B) by L2. keep-carried keeps
  // /10's set instead. HC5: the /11 plan is the job's (a function of (B, T) alone); the
  // below-/11 walk marks the CarriedIndex here, so it stays on the frame callback's thread.
  const bool v11 = is_v11_or_later(c.version);
  job.v11 = v11;
  if (v11) {
    const std::shared_ptr<const rs::Captured> record_base = c.has_base ? c.base : nullptr;
    if (c.keep_carried != nullptr) {
      const std::vector<PayloadName> kept = c.keep_carried->next(
          record_base != nullptr ? &record_base->state : nullptr, snapshot.state);
      for (const PayloadName &name : kept) {
        job.given.emplace_back(name.hash, CarriedIndex::kNoId);
      }
      c.carried_count = c.keep_carried->carried_count();
    } else {
      job.plan_v11 = true;
      job.lower = !is_v12_or_later(c.version);
      job.record_base = record_base;
    }
  } else {
    const TargetRefs &refs = target_refs(target);
    for (std::size_t i = 0; i < refs.refs.size(); ++i) {
      const std::uint32_t id = refs.ids[i];
      if (id == CarriedIndex::kNoId || carried_.carried(id, c.carried_slot)) {
        continue;  // too large, or carried (also: a hash payload_refs names twice, just now)
      }
      if (refs.refs[i].shader != nullptr && refs.refs[i].shader->has_ppm) {
        continue;  // PM5: a process-material shader is a payload only at /12 (lower_particles)
      }
      const auto payload = snapshot.payloads.find(*refs.refs[i].hash);
      if (payload == snapshot.payloads.end() || payload->second == nullptr) {
        continue;  // never happens: a Captured holds every payload its tables name
      }
      job.given.emplace_back(*refs.refs[i].hash, id);
      carried_.mark(id, c.carried_slot);
      ++c.carried_count;
    }
  }
  // /7 is byte-identical to /6 (render-stream-7.md) but faithful; /8 carries the new table fields
  // (render-stream-8.md): a /7-or-later connection's own version stamps its transactions.
  TxMeta &meta = job.meta;
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
  job.full = full;
  job.tx_base = full ? nullptr : c.base;
  const bool drop = !first && config_.drop_message_frame != 0 && !drop_done_ &&
                    frame >= config_.drop_message_frame;
  job.drop = drop;
  job.send = !drop;
  job.meta_grant = c.meta_grant;  // TAG1

  const std::uint64_t seq = meta.seq;
  const bool had_credit = c.credit;
  job.had_credit = had_credit;
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
}

std::shared_ptr<const std::vector<std::uint8_t>> Hub::form_predicted(
    Job &job, const std::shared_ptr<const std::vector<std::uint8_t>> &plain,
    const rs13::PredictMeta *predict) {
  FormState &f = *job.form;
  Counters &o = job.out;
  const TxMeta &meta = job.meta;
  const bool full = job.full;
  const std::uint64_t t0 = monotonic_ns();
  o.predict_plain_bytes += plain->size();
  auto take_spare_out = [](FormState &form) { return reuse_or_make(&form.spare_out); };
  // predict-stale: from its frame, the first patch whose stale coding differs from the honest one
  // (a patch with no predicted unit codes the same either way, and proves nothing).
  const bool stale = !full && config_.predict_stale_frame != 0 && !predict_stale_done_ &&
                     job.frame >= config_.predict_stale_frame;
  if (!stale) {
    for (const auto &p : memo_->predicted) {
      if (p->full == full && p->base == job.tx_base && p->target == job.target &&
          p->meta.version == meta.version && p->meta.frame == meta.frame &&
          p->meta.perturb_instance == meta.perturb_instance &&
          p->meta.perturb_seed == meta.perturb_seed &&
          (full || rs13::same_history(p->before, f.predictor))) {
        std::shared_ptr<std::vector<std::uint8_t>> out = take_spare_out(f);
        if (restamp(*p->bytes, p->meta, meta, full, out.get())) {
          f.predictor = p->after;
          ++o.predict_shared;
          o.predict_bytes += out->size();
          o.predict_ns = saturating_add(o.predict_ns, monotonic_ns() - t0);
          return out;
        }
      }
    }
  }
  const rs13::Predictor before = f.predictor;  // shares H1 and H2: no copy of their bytes
  const rs13::ReuseStats stats0 = f.predictor.reuse_stats();
  std::shared_ptr<std::vector<std::uint8_t>> out = take_spare_out(f);
  auto code = [&](rs13::Predictor &p, std::vector<std::uint8_t> *into) {
    return predict != nullptr ? p.encode(*predict, plain->data(), plain->size(), into)
                              : p.encode(*plain, into);
  };
  if (code(f.predictor, out.get()) != rs13::Status::Ok) {
    return nullptr;  // never for a transaction encode_transaction wrote
  }
  const rs13::ReuseStats stats1 = f.predictor.reuse_stats();
  o.predict_states_reused += stats1.reused - stats0.reused;
  o.predict_states_made += stats1.made - stats0.made;
  bool sabotaged = false;
  if (stale) {
    rs13::Predictor wrong_predictor = before;
    wrong_predictor.predict_stale = true;
    std::vector<std::uint8_t> wrong;
    if (code(wrong_predictor, &wrong) == rs13::Status::Ok && wrong != *out) {
      *out = std::move(wrong);  // the history still advanced honestly (f.predictor)
      sabotaged = true;
      predict_stale_done_ = true;
      o.predict_stale_seq = meta.seq;
      job.lines.push_back(Line()
                              .num("frame", job.frame)
                              .num("t_us", job.now_ns / 1000)
                              .str("event", "sabotage")
                              .str("kind", "predict-stale")
                              .num("seq", meta.seq)
                              .num("base_seq", meta.base_seq)
                              .take());
    }
  }
  if (!sabotaged) {
    auto p = std::make_unique<PredictedTx>();
    p->base = job.tx_base;
    p->target = job.target;
    p->meta = meta;
    p->full = full;
    p->before = before;
    p->after = f.predictor;
    p->bytes = out;
    memo_->predicted.push_back(std::move(p));
  }
  ++o.predict_formed;
  o.predict_bytes += out->size();
  o.predict_ns = saturating_add(o.predict_ns, monotonic_ns() - t0);
  return out;
}

bool Hub::form_deliver(Job &job, const std::vector<std::uint8_t> &message, bool send,
                       const std::vector<std::uint8_t> *wire) {
  FormState &f = *job.form;
  Counters &o = job.out;
  if (f.tap != nullptr) {
    // The tap holds the uncoded message (W11t), flushed at the callback's batch end.
    std::fwrite(message.data(), 1, message.size(), f.tap);
  }
  o.max_message_sent = std::max<std::uint64_t>(o.max_message_sent, message.size());
  if (!send) {
    return true;
  }
  const std::vector<std::uint8_t> &out = wire != nullptr ? *wire : message;
  if (wire != nullptr) {
    ++o.coded_messages;
    o.coded_input_bytes += message.size();
    o.coded_wire_bytes += wire->size();
  }
  o.bytes_sent += out.size();
  const std::uint64_t t0 = monotonic_ns();
  const bool ok = transport_->send_binary(f.id, out);
  o.enqueue_us.push_back((monotonic_ns() - t0) / 1000);  // Q3d enqueue_us (G6r)
  return ok;
}

void Hub::form_item_meta(Job &job, bool full,
                         std::shared_ptr<const std::vector<std::uint8_t>> *record,
                         std::shared_ptr<const std::vector<std::uint8_t>> *wire) {
  FormState &f = *job.form;
  Counters &o = job.out;
  std::unique_ptr<rs::item_meta::GrantTable> &slot =
      meta_tables_[rs::item_meta::grant_json(*job.meta_grant)];
  if (slot == nullptr) {
    slot = std::make_unique<rs::item_meta::GrantTable>();
    slot->grant = *job.meta_grant;
    slot->json = rs::item_meta::grant_json(slot->grant);
  }
  rs::item_meta::GrantTable &table = *slot;
  const rs2::Snapshot &target = job.target->state;
  const std::uint64_t to = target.frame;
  if (full) {
    // A full replaces the receiver's table: every row of the target, every string from 0.
    const bool skip = config_.item_meta_sabotage == "skip-full" && f.meta_fulls > 0;
    ++f.meta_fulls;
    f.meta_stamp = 0;
    f.meta_strings = 0;
    if (skip) {
      f.meta_stamp = to;  // sabotage skip-full: the receiver keeps its old table
      f.meta_strings = table.local.size();
      return;
    }
  }
  const std::uint64_t from = f.meta_stamp;
  Memo::MetaRecord *hit = nullptr;
  for (Memo::MetaRecord &m : memo_->item_meta) {
    if (m.table == &table && m.full == full && m.from == from &&
        m.strings_have == f.meta_strings && m.target == job.target) {
      hit = &m;
      break;
    }
  }
  if (hit == nullptr) {
    memo_->item_meta.emplace_back();
    hit = &memo_->item_meta.back();
    hit->table = &table;
    hit->full = full;
    hit->from = from;
    hit->strings_have = f.meta_strings;
    hit->target = job.target;
    const std::uint32_t offset = config_.item_meta_sabotage == "id-off-by-one" ? 1 : 0;
    if (!rs::item_meta::form(meta_store_, &table, full, from, to, f.meta_strings, target, offset,
                             &hit->formed)) {
      hit->formed.strings_after = f.meta_strings;  // an empty delta: nothing goes out
    }
    meta_store_.prune(target);
  } else if (hit->formed.bytes != nullptr) {
    ++o.item_meta_shared;
  }
  f.meta_stamp = std::max(f.meta_stamp, to);
  if (hit->formed.bytes == nullptr) {
    return;
  }
  f.meta_strings = hit->formed.strings_after;
  const std::vector<std::uint8_t> &bytes = *hit->formed.bytes;
  if (bytes.size() > job.max_message_bytes) {
    job.error = true;
    job.error_detail = "item_meta record is " + std::to_string(bytes.size()) +
                       " bytes, the cap is " + std::to_string(job.max_message_bytes);
    transport_->send_text(f.id, encode_error("message-too-large", job.error_detail));
    return;
  }
  *record = hit->formed.bytes;
  if (f.coding != rs::live_coding::Coding::Off) {
    // W11t: coded as a resource record is (one plain zstd frame), shared through the memo.
    if (hit->coded == nullptr) {
      hit->coded = coded_plain(&o.coded_shared, &o.coding_ns, bytes, "");
    } else {
      ++o.coded_shared;
    }
    *wire = hit->coded;
  }
  ++(full ? o.item_meta_full : o.item_meta_delta);
  o.item_meta_bytes += bytes.size();
  o.item_meta_rows += hit->formed.rows;
  o.record_bytes_total += bytes.size();
  o.max_record_bytes = std::max<std::uint64_t>(o.max_record_bytes, bytes.size());
}

void Hub::run_job(Job &job) {
  if (job.batch_end) {
    // P3-SP: the shared work lives for one callback; its snapshots are released by the main
    // thread (complete()), and the taps written this callback are flushed once.
    // W13f: /13's own state is released here, on the encode thread: the codings' histories
    // (which also lets each predictor's spare go back to it alone before its next coding), the
    // /13 messages and the typed metas. The snapshots stay for the main thread.
    for (const auto &p : memo_->predicted) {
      p->before.reset();
      p->after.reset();
      p->bytes = nullptr;
    }
    for (const auto &tx : memo_->txs) {
      tx->predict = nullptr;
    }
    job.retired = std::move(memo_);
    memo_ = std::make_unique<Memo>();
    for (std::FILE *tap : job.flush) {
      std::fflush(tap);
    }
    return;
  }
  for (const auto &batch : job.meta_batches) {
    meta_store_.apply(*batch);  // TAG1: this callback's identities, before its records
  }
  job.meta_batches.clear();
  FormState &f = *job.form;
  Counters &o = job.out;
  const bool coded = f.coding != rs::live_coding::Coding::Off;
  if (job.session != nullptr) {
    std::shared_ptr<const std::vector<std::uint8_t>> wire;
    if (coded) {
      wire = coded_plain(&o.coded_shared, &o.coding_ns, *job.session, "");  // W11t: coded too
    }
    form_deliver(job, *job.session, true, wire.get());
  }
  if (!job.has_tx) {
    return;
  }
  const rs::Captured &snapshot = *job.target;
  const std::uint64_t frame = job.frame;
  const std::uint64_t now_ns = job.now_ns;
  std::vector<std::pair<const std::string *, std::uint32_t>> to_send;  // (hash, CarriedIndex id)
  if (job.plan_v11) {
    const V11Records &records = v11_records(job.record_base, job.target, job.lower);
    for (const PayloadName &name : records.records) {
      to_send.emplace_back(&name.hash, CarriedIndex::kNoId);
    }
    job.planned = true;
    job.inline_count = records.inline_count;  // C after this transaction is inline(T) (L2)
  } else {
    for (const auto &given : job.given) {
      to_send.emplace_back(&given.first, given.second);
    }
  }
  // HC5 sabotage reorder: the records formed, but held until the transaction went out.
  struct Held {
    std::shared_ptr<const std::vector<std::uint8_t>> bytes;
    std::shared_ptr<const std::vector<std::uint8_t>> wire;
    const std::string *hash;
    std::uint64_t payload_size;
  };
  std::vector<Held> held;
  const auto deliver_record = [&](const Held &r) {
    form_deliver(job, *r.bytes, true, r.wire.get());
    ++o.resource_records;
    o.resource_bytes += r.payload_size;
    o.record_bytes_total += r.bytes->size();
    o.max_record_bytes = std::max<std::uint64_t>(o.max_record_bytes, r.bytes->size());
    job.lines.push_back(Line()
                            .num("frame", frame)
                            .num("t_us", now_ns / 1000)
                            .str("event", "resource")
                            .str("hash", *r.hash)
                            .num("bytes", r.payload_size)
                            .take());
  };
  for (const auto &send : to_send) {
    const std::string &hash = *send.first;
    const std::uint32_t id = send.second;
    const auto payload = snapshot.payloads.find(hash);
    if (payload == snapshot.payloads.end() || payload->second == nullptr) {
      continue;  // never happens: a Captured holds every payload its tables name
    }
    std::shared_ptr<const std::vector<std::uint8_t>> &record_bytes =
        job.v11 ? memo_->records_v11[hash] : memo_->records[id];
    if (record_bytes == nullptr) {
      ResourceRecord record;
      record.hash = hash;
      record.payload = *payload->second;
      record_bytes = std::make_shared<const std::vector<std::uint8_t>>(encode_resource(record));
    }
    if (record_bytes->size() > job.max_message_bytes) {
      job.error = true;
      job.error_detail = "resource " + hash + " is " + std::to_string(record_bytes->size()) +
                         " bytes, the cap is " + std::to_string(job.max_message_bytes);
      transport_->send_text(f.id, encode_error("message-too-large", job.error_detail));
      return;
    }
    Held r{record_bytes, nullptr, &hash, payload->second->size()};
    if (coded) {
      r.wire = coded_plain(&o.coded_shared, &o.coding_ns, *record_bytes, hash);
    }
    if (job.reorder) {
      held.push_back(std::move(r));
    } else {
      deliver_record(r);
    }
  }
  const TxMeta &meta = job.meta;
  const bool full = job.full;
  // TAG1 (client-extensions-design.md §2.4): the item_meta record goes after the resource records,
  // immediately before the transaction it describes.
  std::shared_ptr<const std::vector<std::uint8_t>> meta_record;
  std::shared_ptr<const std::vector<std::uint8_t>> meta_wire;
  if (job.meta_grant != nullptr && job.send) {
    form_item_meta(job, full, &meta_record, &meta_wire);
    if (job.error) {
      return;
    }
  }
  const bool meta_in_shared =
      meta_record != nullptr && config_.item_meta_sabotage == "in-shared";
  if (meta_record != nullptr && !meta_in_shared) {
    form_deliver(job, *meta_record, true, meta_wire.get());
  }
  // P3-SP: the same transaction already formed this callback (another connection in lockstep).
  SharedTx *shared = nullptr;
  for (const auto &tx : memo_->txs) {
    if (tx->full == full && tx->base == job.tx_base && tx->target == job.target &&
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
  std::shared_ptr<const rs13::PredictMeta> predict;
  if (shared != nullptr) {
    auto out = std::make_shared<std::vector<std::uint8_t>>();
    if (restamp(*shared->bytes, shared->meta, meta, full, out.get())) {
      encoded = std::move(out);
      predict = shared->predict;
      ++o.shared_sends;
    }
  }
  if (encoded == nullptr) {
    const Transaction transaction = full ? make_full(snapshot.state, meta)
                                         : make_patch(job.tx_base->state, snapshot.state, meta);
    t1 = monotonic_ns();
    encoded = std::make_shared<const std::vector<std::uint8_t>>(encode_transaction(transaction));
    if (meta.version == ProtocolVersion::V13) {
      std::shared_ptr<rs13::PredictMeta> typed = reuse_or_make(&f.spare_meta);  // W13f
      rs13::predict_meta(transaction, typed.get());
      f.spare_meta = typed;
      predict = std::move(typed);
    }
    if (shared == nullptr) {
      auto tx = std::make_unique<SharedTx>();
      tx->base = job.tx_base;
      tx->target = job.target;
      tx->meta = meta;
      tx->full = full;
      tx->bytes = encoded;
      tx->predict = predict;
      memo_->txs.push_back(std::move(tx));
    }
  }
  if (meta.version == ProtocolVersion::V13) {
    // W13b: the /12 transaction just formed (encode_transaction writes /12's form at V13) coded
    // against this connection's history; the coding prefix, the tap and the end stats are the
    // /13 message's.
    encoded = form_predicted(job, encoded, predict.get());
    if (encoded == nullptr) {
      job.error = true;
      job.error_detail = "transaction " + std::to_string(meta.seq) + " has no /13 coding";
      job.error_reason = "protocol";
      transport_->send_text(f.id, encode_error(job.error_reason, job.error_detail));
      return;
    }
  }
  const std::uint64_t t2 = monotonic_ns();
  const std::vector<std::uint8_t> &bytes = *encoded;
  if (bytes.size() > job.max_message_bytes) {
    job.error = true;
    job.error_detail = "transaction " + std::to_string(meta.seq) + " is " +
                       std::to_string(bytes.size()) + " bytes, the cap is " +
                       std::to_string(job.max_message_bytes);
    transport_->send_text(f.id, encode_error("message-too-large", job.error_detail));
    return;
  }
  std::shared_ptr<const std::vector<std::uint8_t>> wire;
  if (coded) {
    // W11t: coded against the last transaction formed here (its uncoded message), which is the
    // base this patch names; a full transaction has none.
    if (full) {
      f.last_tx = nullptr;
    }
    wire = form_coded_tx(job, encoded);
  }
  std::shared_ptr<const std::vector<std::uint8_t>> previous = std::move(f.last_tx);
  f.last_tx = encoded;
  if (meta.version == ProtocolVersion::V13) {
    f.spare_out = std::move(previous);  // W13f: the next /13 coding's buffer, once it is ours alone
  }
  if (meta_in_shared) {
    // Sabotage meta-in-shared: the record rides inside the transaction's message, so this
    // viewer's transaction bytes are no longer the ones its opted-out lockstep peers get.
    std::vector<std::uint8_t> joined = *meta_record;
    joined.insert(joined.end(), bytes.begin(), bytes.end());
    std::shared_ptr<const std::vector<std::uint8_t>> joined_wire;
    if (coded) {
      joined_wire = coded_plain(&o.coded_shared, &o.coding_ns, joined, "");
    }
    form_deliver(job, joined, job.send, joined_wire.get());
  } else if (!form_deliver(job, bytes, job.send, wire.get())) {
    job.lines.push_back(Line()
                            .num("frame", frame)
                            .num("t_us", now_ns / 1000)
                            .str("event", "error")
                            .str("reason", "send-failed")
                            .str("detail", "the transport refused seq " + std::to_string(meta.seq))
                            .take());
  }
  for (const Held &r : held) {
    deliver_record(r);  // reorder: after the transaction that names them
  }
  job.tx_formed = true;
  job.tx_bytes = bytes.size();
  job.diff_ns = full ? 0 : t1 - t0;
  job.encode_ns = (full ? t1 - t0 : 0) + (t2 - t1);
}

void Hub::complete(Job &job) {
  if (job.batch_end) {
    return;  // its memo (job.retired) is released with the job, on this thread
  }
  Conn &c = *job.conn;
  const Counters &o = job.out;
  const std::uint64_t frame_saved = frame_;
  frame_ = job.frame;  // the close line of an error names the job's frame, as a sync send did
  c.s.bytes_sent += o.bytes_sent;
  c.s.max_message_sent = std::max(c.s.max_message_sent, o.max_message_sent);
  c.s.coded_messages += o.coded_messages;
  c.s.coded_prefixed += o.coded_prefixed;
  c.s.coded_shared += o.coded_shared;
  c.s.coded_input_bytes += o.coded_input_bytes;
  c.s.coded_wire_bytes += o.coded_wire_bytes;
  c.s.coding_ns = saturating_add(c.s.coding_ns, o.coding_ns);
  c.s.shared_sends += o.shared_sends;
  c.s.resource_records += o.resource_records;
  c.s.resource_bytes += o.resource_bytes;
  if (o.wrong_prefix_seq != 0) {
    c.s.wrong_prefix_seq = o.wrong_prefix_seq;
  }
  c.s.predict_formed += o.predict_formed;
  c.s.predict_shared += o.predict_shared;
  c.s.predict_plain_bytes += o.predict_plain_bytes;
  c.s.predict_bytes += o.predict_bytes;
  c.s.predict_ns = saturating_add(c.s.predict_ns, o.predict_ns);
  c.s.item_meta_full += o.item_meta_full;  // TAG1
  c.s.item_meta_delta += o.item_meta_delta;
  c.s.item_meta_bytes += o.item_meta_bytes;
  c.s.item_meta_rows += o.item_meta_rows;
  c.s.item_meta_shared += o.item_meta_shared;
  if (o.predict_stale_seq != 0) {
    c.s.predict_stale_seq = o.predict_stale_seq;
  }
  c.s.predict_states_reused += o.predict_states_reused;
  c.s.predict_states_made += o.predict_states_made;
  c.stats.resource_records += o.resource_records;
  c.stats.resource_bytes += o.resource_bytes;
  c.stats.bytes_total += o.record_bytes_total;
  c.stats.max_record_bytes = std::max(c.stats.max_record_bytes, o.max_record_bytes);
  for (const std::uint64_t us : o.enqueue_us) {
    enqueue_hist_.add(us);
  }
  if (job.planned) {
    c.carried_count = job.inline_count;
  }
  for (const std::string &line : job.lines) {
    log_line(c, line);
  }
  if (job.error) {
    // message-too-large: the job sent the error text after what it had delivered and nothing
    // more; the send it was formed for never happened.
    if (job.has_tx) {
      if (job.drop) {
        --c.s.dropped;
      } else {
        --c.s.sent;
        if (!job.had_credit) {
          --c.s.sent_without_credit;
        }
      }
      if (job.stale_from != 0) {
        --c.s.stale_sent;
      }
    }
    c.s.error_sent = job.error_reason;
    log_line(c, Line()
                    .num("frame", job.frame)
                    .num("t_us", job.now_ns / 1000)
                    .str("event", "error")
                    .str("reason", job.error_reason)
                    .str("detail", job.error_detail)
                    .take());
    host_close(c, job.error_reason == "protocol" ? 1011 : 1009, job.error_reason);
    frame_ = frame_saved;
    return;
  }
  if (job.tx_formed) {
    ++c.s.transactions;
    if (job.full) {
      ++c.s.full;
      ++c.stats.full_transactions;
    } else {
      ++c.s.patch;
      ++c.stats.patch_transactions;
    }
    c.stats.bytes_total += job.tx_bytes;
    c.stats.max_record_bytes = std::max<std::uint64_t>(c.stats.max_record_bytes, job.tx_bytes);
    c.stats.encode_ns_total = saturating_add(c.stats.encode_ns_total, job.encode_ns);
    c.stats.diff_ns_total = saturating_add(c.stats.diff_ns_total, job.diff_ns);
    c.stats.snapshot_ns_total = saturating_add(c.stats.snapshot_ns_total, job.snapshot_ns);
    // Q3d encode_us / diff_us (G6r): the same costs, also sampled into the cross-connection
    // histograms perf.json reports distributions from.
    encode_hist_.add(job.encode_ns / 1000);
    if (!job.full) {
      diff_hist_.add(job.diff_ns / 1000);
    }
  }
  if (job.frame_line && c.state != State::Closed) {
    Line sent;
    sent.num("seq", job.meta.seq)
        .str("encoding", job.full ? "full" : "patch")
        .num("bytes", job.tx_bytes);
    if (job.drop) {
      sent.boolean("dropped", true);
    }
    if (job.stale_from != 0) {
      sent.num("stale_from", job.stale_from);
    }
    log_frame(c, job.frame, job.now_ns, job.credit_before, sent.take());
  }
  frame_ = frame_saved;
}

void Hub::submit_batch() {
  if (batch_.empty()) {
    return;
  }
  auto end = std::make_unique<Job>();
  end->batch_end = true;
  for (const auto &job : batch_) {
    job->conn->job = nullptr;
    if (job->form != nullptr && job->form->tap != nullptr) {
      end->flush.push_back(job->form->tap);
    }
  }
  if (!meta_batches_.empty()) {
    batch_.front()->meta_batches = std::move(meta_batches_);  // TAG1: before any record
    meta_batches_.clear();
  }
  batch_.push_back(std::move(end));
  std::vector<std::unique_ptr<Job>> jobs;
  std::swap(jobs, batch_);
  if (former_ == nullptr) {
    for (auto &job : jobs) {
      run_job(*job);
    }
    for (auto &job : jobs) {
      complete(*job);
    }
    return;
  }
  former_->submit(std::move(jobs));
  if (config_.formation_wait) {
    sync();
  }
}

void Hub::sync() {
  if (former_ == nullptr) {
    return;
  }
  std::vector<std::unique_ptr<Job>> done = former_->take();
  if (done.empty()) {
    return;
  }
  for (auto &job : done) {
    complete(*job);
  }
  done.clear();  // the memo's snapshots and the jobs' inputs are released here, on this thread
  for (auto &entry : conns_) {
    Conn &c = *entry.second;
    if (c.log != nullptr) {
      std::fflush(c.log);
    }
  }
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
  sync();  // HC5: the previous callback's jobs, completed before anything here reads a connection
  frame_ = frame;
  carried_.maintain();
  frame_targets_.clear();
  for (auto &entry : conns_) {
    Conn &c = *entry.second;
    if (c.state == State::Closed) {
      continue;
    }
    const bool credit_before = c.credit;
    if (c.state == State::AwaitHello) {
      if (c.hello_received) {
        if (snapshot == nullptr) {
          continue;  // the caller did not provide one; try at the next callback
        }
        if (snapshot->keyed_surfaces && !is_v11_or_later(c.version)) {
          // HC3: a snapshot taken before this connection opened (G8kw's hold-back publishes an
          // older one) left dynamic surfaces unhashed; every snapshot since is hashed for it.
          continue;
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
        // HC5: the session message is the first thing the connection's first job sends (coded
        // too, W11t), ahead of seq 1's records.
        c.form->coding = c.coding;
        batch_job(c).session = std::make_shared<const std::vector<std::uint8_t>>(std::move(message));
        c.stats.bytes_total += c.job->session->size();  // the magic counts (render-stream-0.md)
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
        send_transaction(c, snapshot, frame, now_ns, epoch, snapshot_ns, true, now_ns);
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
          send_transaction(c, stale, frame, now_ns, epoch, snapshot_ns, false, stale_capture_ns,
                           c.stale_frame);
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
            send_transaction(c, held, frame, now_ns, epoch, snapshot_ns, false, c.stale_held_ns,
                             c.stale_held_frame);
          } else {
            send_transaction(c, snapshot, frame, now_ns, epoch, snapshot_ns, false, now_ns);
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
    if (c.job != nullptr && c.job->has_tx) {
      // HC5: the frame line names the transaction's bytes; it is written when the job completes
      // (complete(): unless the job ended the connection with message-too-large).
      c.job->frame_line = true;
      c.job->credit_before = credit_before;
    } else {
      log_frame(c, frame, now_ns, credit_before, "null");
    }
  }
  frame_targets_.clear();  // P3-SP: the shared work holds snapshots; it lives for one callback
  submit_batch();
  // HC5: the live logs are flushed here (and at each sync), the taps by the jobs' batch end.
  for (auto &entry : conns_) {
    Conn &c = *entry.second;
    if (c.log != nullptr) {
      std::fflush(c.log);
    }
  }
}

void Hub::finish(EndReason reason, std::uint64_t frame, std::uint64_t now_ns) {
  if (finished_) {
    return;
  }
  sync();
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
        wire = coded_plain(&c.s.coded_shared, &c.s.coding_ns, bytes, "");
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
  sync();
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
  sync();
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
    if (s.version == 9 || s.version == 10 || s.version == 11 || s.version == 12 ||
        s.version == 13) {
      // render-stream-9.md "Hello": the /9 hello's delivery preferences, /9 to /11 connections
      // only (render-stream-10.md and -11.md: their hellos are /9's).
      json.field_or_null("texture_encodings", s.texture_encodings);
      json.field_or_null("gpu_formats", s.gpu_formats);
    }
    if (s.version == 11 || s.version == 12 || s.version == 13) {
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
    if (s.version == 13) {
      // W13b (render-stream-13.md "As built (W13b)"): the predicted blocks' coding.
      json.key("predict").object_begin();
      json.field("formed", static_cast<int64_t>(s.predict_formed));
      json.field("shared", static_cast<int64_t>(s.predict_shared));
      json.field("plain_bytes", static_cast<int64_t>(s.predict_plain_bytes));
      json.field("bytes", static_cast<int64_t>(s.predict_bytes));
      json.field("encode_us", static_cast<int64_t>(s.predict_ns / 1000));
      json.field("states_reused", static_cast<int64_t>(s.predict_states_reused));  // W13f
      json.field("states_made", static_cast<int64_t>(s.predict_states_made));
      if (s.predict_stale_seq != 0) {
        json.field("stale_seq", static_cast<int64_t>(s.predict_stale_seq));
      } else {
        json.field_null("stale_seq");
      }
      json.object_end();
    }
    if (s.has_item_meta) {
      // TAG1 (client-extensions-design.md "As built (TAG1)"): the hello's request, the grant
      // (null: refused) and the records this connection got.
      json.field("item_meta_request", rs::item_meta::grant_json(s.item_meta_request));
      if (s.item_meta_grant.empty()) {
        json.field_null("item_meta_grant");
      } else {
        json.field("item_meta_grant", rs::item_meta::grant_json(s.item_meta_grant));
      }
      json.key("item_meta").object_begin();
      json.field("full", static_cast<int64_t>(s.item_meta_full));
      json.field("delta", static_cast<int64_t>(s.item_meta_delta));
      json.field("bytes", static_cast<int64_t>(s.item_meta_bytes));
      json.field("rows", static_cast<int64_t>(s.item_meta_rows));
      json.field("shared", static_cast<int64_t>(s.item_meta_shared));
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
