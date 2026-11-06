// rs_tracks: TrackHub (rs_tracks.h; protocol/tracks-design.md Q1-Q5, Q9; TRK1).
#include "rs_tracks.h"

#include <sys/random.h>
#include <sys/stat.h>
#include <fcntl.h>
#include <unistd.h>

#include <algorithm>
#include <cerrno>
#include <cstring>
#include <set>
#include <utility>

#include "report.h"

namespace grc {
namespace rs {
namespace tracks {

namespace {

constexpr std::uint64_t kNsPerMs = 1000ull * 1000ull;
constexpr std::uint64_t kNsPerS = 1000ull * kNsPerMs;

// ----------------------------------------------------------------------------- a strict JSON reader
//
// Just enough for track-hello: objects, arrays, strings, numbers, true/false/null, with a depth
// cap. Strings are decoded (escapes, \u surrogate pairs) into UTF-8. Numbers keep their source
// text, so a caller can demand an exact integer spelling.

struct JValue {
  enum Kind { Null, Bool, Number, String, Array, Object } kind = Null;
  bool b = false;
  std::string text;  // String: decoded; Number: as written
  std::vector<JValue> items;
  std::vector<std::pair<std::string, JValue>> fields;  // Object, in source order
  const JValue *get(const char *key) const {
    const JValue *found = nullptr;
    for (const auto &f : fields) {
      if (f.first == key) found = &f.second;  // the last duplicate wins, as JSON.parse
    }
    return found;
  }
};

class Reader {
 public:
  explicit Reader(std::string_view text) : s_(text) {}
  bool parse(JValue *out) {
    ws();
    if (!value(out, 0)) return false;
    ws();
    return i_ == s_.size();
  }

 private:
  void ws() {
    while (i_ < s_.size() && (s_[i_] == ' ' || s_[i_] == '\t' || s_[i_] == '\n' || s_[i_] == '\r')) ++i_;
  }
  bool lit(const char *word) {
    const std::size_t n = std::strlen(word);
    if (s_.compare(i_, n, word) != 0) return false;
    i_ += n;
    return true;
  }
  bool value(JValue *out, int depth) {
    if (depth > 8 || i_ >= s_.size()) return false;
    const char c = s_[i_];
    if (c == '{') return object(out, depth);
    if (c == '[') return array(out, depth);
    if (c == '"') {
      out->kind = JValue::String;
      return string(&out->text);
    }
    if (c == 't') {
      out->kind = JValue::Bool;
      out->b = true;
      return lit("true");
    }
    if (c == 'f') {
      out->kind = JValue::Bool;
      return lit("false");
    }
    if (c == 'n') {
      out->kind = JValue::Null;
      return lit("null");
    }
    return number(out);
  }
  bool object(JValue *out, int depth) {
    out->kind = JValue::Object;
    ++i_;
    ws();
    if (i_ < s_.size() && s_[i_] == '}') {
      ++i_;
      return true;
    }
    while (true) {
      ws();
      if (i_ >= s_.size() || s_[i_] != '"') return false;
      std::string key;
      if (!string(&key)) return false;
      ws();
      if (i_ >= s_.size() || s_[i_] != ':') return false;
      ++i_;
      ws();
      JValue v;
      if (!value(&v, depth + 1)) return false;
      out->fields.emplace_back(std::move(key), std::move(v));
      ws();
      if (i_ >= s_.size()) return false;
      if (s_[i_] == ',') {
        ++i_;
        continue;
      }
      if (s_[i_] == '}') {
        ++i_;
        return true;
      }
      return false;
    }
  }
  bool array(JValue *out, int depth) {
    out->kind = JValue::Array;
    ++i_;
    ws();
    if (i_ < s_.size() && s_[i_] == ']') {
      ++i_;
      return true;
    }
    while (true) {
      ws();
      JValue v;
      if (!value(&v, depth + 1)) return false;
      out->items.push_back(std::move(v));
      ws();
      if (i_ >= s_.size()) return false;
      if (s_[i_] == ',') {
        ++i_;
        continue;
      }
      if (s_[i_] == ']') {
        ++i_;
        return true;
      }
      return false;
    }
  }
  static void put_utf8(std::string *out, std::uint32_t cp) {
    if (cp < 0x80) {
      out->push_back(static_cast<char>(cp));
    } else if (cp < 0x800) {
      out->push_back(static_cast<char>(0xC0 | (cp >> 6)));
      out->push_back(static_cast<char>(0x80 | (cp & 0x3F)));
    } else if (cp < 0x10000) {
      out->push_back(static_cast<char>(0xE0 | (cp >> 12)));
      out->push_back(static_cast<char>(0x80 | ((cp >> 6) & 0x3F)));
      out->push_back(static_cast<char>(0x80 | (cp & 0x3F)));
    } else {
      out->push_back(static_cast<char>(0xF0 | (cp >> 18)));
      out->push_back(static_cast<char>(0x80 | ((cp >> 12) & 0x3F)));
      out->push_back(static_cast<char>(0x80 | ((cp >> 6) & 0x3F)));
      out->push_back(static_cast<char>(0x80 | (cp & 0x3F)));
    }
  }
  bool hex4(std::uint32_t *out) {
    if (i_ + 4 > s_.size()) return false;
    std::uint32_t v = 0;
    for (int k = 0; k < 4; ++k) {
      const char c = s_[i_++];
      v <<= 4;
      if (c >= '0' && c <= '9') {
        v |= static_cast<std::uint32_t>(c - '0');
      } else if (c >= 'a' && c <= 'f') {
        v |= static_cast<std::uint32_t>(c - 'a' + 10);
      } else if (c >= 'A' && c <= 'F') {
        v |= static_cast<std::uint32_t>(c - 'A' + 10);
      } else {
        return false;
      }
    }
    *out = v;
    return true;
  }
  bool string(std::string *out) {
    ++i_;  // the opening quote
    while (i_ < s_.size()) {
      const unsigned char c = static_cast<unsigned char>(s_[i_]);
      if (c == '"') {
        ++i_;
        return true;
      }
      if (c < 0x20) return false;
      if (c != '\\') {
        out->push_back(static_cast<char>(c));
        ++i_;
        continue;
      }
      if (++i_ >= s_.size()) return false;
      const char e = s_[i_++];
      switch (e) {
        case '"': out->push_back('"'); break;
        case '\\': out->push_back('\\'); break;
        case '/': out->push_back('/'); break;
        case 'b': out->push_back('\b'); break;
        case 'f': out->push_back('\f'); break;
        case 'n': out->push_back('\n'); break;
        case 'r': out->push_back('\r'); break;
        case 't': out->push_back('\t'); break;
        case 'u': {
          std::uint32_t cp = 0;
          if (!hex4(&cp)) return false;
          if (cp >= 0xD800 && cp <= 0xDBFF) {
            std::uint32_t lo = 0;
            if (i_ + 2 > s_.size() || s_[i_] != '\\' || s_[i_ + 1] != 'u') return false;
            i_ += 2;
            if (!hex4(&lo) || lo < 0xDC00 || lo > 0xDFFF) return false;
            cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00);
          } else if (cp >= 0xDC00 && cp <= 0xDFFF) {
            return false;  // a lone low surrogate
          }
          put_utf8(out, cp);
          break;
        }
        default:
          return false;
      }
    }
    return false;
  }
  bool number(JValue *out) {
    out->kind = JValue::Number;
    const std::size_t start = i_;
    if (i_ < s_.size() && s_[i_] == '-') ++i_;
    if (i_ >= s_.size()) return false;
    if (s_[i_] == '0') {
      ++i_;
    } else if (s_[i_] >= '1' && s_[i_] <= '9') {
      while (i_ < s_.size() && s_[i_] >= '0' && s_[i_] <= '9') ++i_;
    } else {
      return false;
    }
    if (i_ < s_.size() && s_[i_] == '.') {
      ++i_;
      const std::size_t d = i_;
      while (i_ < s_.size() && s_[i_] >= '0' && s_[i_] <= '9') ++i_;
      if (i_ == d) return false;
    }
    if (i_ < s_.size() && (s_[i_] == 'e' || s_[i_] == 'E')) {
      ++i_;
      if (i_ < s_.size() && (s_[i_] == '+' || s_[i_] == '-')) ++i_;
      const std::size_t d = i_;
      while (i_ < s_.size() && s_[i_] >= '0' && s_[i_] <= '9') ++i_;
      if (i_ == d) return false;
    }
    out->text.assign(s_.substr(start, i_ - start));
    return true;
  }

  std::string_view s_;
  std::size_t i_ = 0;
};

bool lower_alnum(char c) { return (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9'); }
bool lower_hex(char c) { return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'); }

// [a-z][a-z0-9-]{0,31}
bool kind_ok(std::string_view kind) {
  if (kind.empty() || kind.size() > 32 || kind[0] < 'a' || kind[0] > 'z') return false;
  for (const char c : kind) {
    if (!lower_alnum(c) && c != '-') return false;
  }
  return true;
}

// [A-Za-z0-9._:-]{0,64}
bool client_ok(std::string_view client) {
  if (client.size() > 64) return false;
  for (const char c : client) {
    const bool ok = lower_alnum(c) || (c >= 'A' && c <= 'Z') || c == '.' || c == '_' || c == ':' ||
                    c == '-';
    if (!ok) return false;
  }
  return true;
}

bool hex32(std::string_view text) {
  if (text.size() != 32) return false;
  for (const char c : text) {
    if (!lower_hex(c)) return false;
  }
  return true;
}

// A positive integer spelled without sign, fraction, exponent or leading zero, up to 2^53.
bool positive_integer(const JValue &v, std::uint64_t *out) {
  if (v.kind != JValue::Number || v.text.empty() || v.text.size() > 16 || v.text[0] == '0') return false;
  std::uint64_t n = 0;
  for (const char c : v.text) {
    if (c < '0' || c > '9') return false;
    n = n * 10 + static_cast<std::uint64_t>(c - '0');
  }
  if (n == 0 || n > (1ull << 53)) return false;
  *out = n;
  return true;
}

// 1..8 (or 0..8 when `allow_empty`) distinct formats.
bool format_list(const JValue *v, bool allow_empty, std::vector<std::string> *out) {
  if (v == nullptr || v->kind != JValue::Array) return false;
  if (v->items.size() > 8 || (!allow_empty && v->items.empty())) return false;
  for (const JValue &item : v->items) {
    if (item.kind != JValue::String || !format_ok(item.text)) return false;
    if (std::find(out->begin(), out->end(), item.text) != out->end()) return false;
    out->push_back(item.text);
  }
  return true;
}

bool formats_valid(const std::vector<std::string> &formats, bool allow_empty) {
  if (formats.size() > 8 || (!allow_empty && formats.empty())) return false;
  std::set<std::string> seen;
  for (const std::string &f : formats) {
    if (!format_ok(f) || !seen.insert(f).second) return false;
  }
  return true;
}

// The parsed hello (Q1.2).
struct Hello {
  std::string kind;
  std::vector<std::string> formats;
  std::vector<std::string> down_formats;
  std::string credential;
  std::string client;
  std::optional<TrackView> view;
};

// False with *detail naming the first rule broken (a short [a-z0-9-] hint, never input bytes).
bool parse_hello(const std::string &text, Hello *out, std::string *detail) {
  JValue root;
  if (!Reader(text).parse(&root)) {
    *detail = "json";
    return false;
  }
  if (root.kind != JValue::Object) {
    *detail = "not-object";
    return false;
  }
  const JValue *type = root.get("type");
  if (type == nullptr || type->kind != JValue::String || type->text != "track-hello") {
    *detail = "type";
    return false;
  }
  const JValue *protocol = root.get("protocol");
  if (protocol == nullptr || protocol->kind != JValue::String || protocol->text != kTrackProtocolV1) {
    *detail = "protocol";
    return false;
  }
  const JValue *kind = root.get("kind");
  if (kind == nullptr || kind->kind != JValue::String || !kind_ok(kind->text)) {
    *detail = "kind";
    return false;
  }
  out->kind = kind->text;
  if (!format_list(root.get("formats"), false, &out->formats)) {
    *detail = "formats";
    return false;
  }
  const JValue *down = root.get("down_formats");
  if (down != nullptr && !format_list(down, true, &out->down_formats)) {
    *detail = "down-formats";
    return false;
  }
  // The credential is a string; its value is the authorization step's question (TRK5 adds a
  // capability form beside the 64-hex shared credential), capped at the message size anyway.
  const JValue *credential = root.get("credential");
  if (credential == nullptr || credential->kind != JValue::String) {
    *detail = "credential";
    return false;
  }
  out->credential = credential->text;
  const JValue *client = root.get("client");
  if (client != nullptr) {
    if (client->kind != JValue::String || !client_ok(client->text)) {
      *detail = "client";
      return false;
    }
    out->client = client->text;
  }
  const JValue *view = root.get("view");
  if (view != nullptr && view->kind != JValue::Null) {
    const JValue *stream_id = view->kind == JValue::Object ? view->get("stream_id") : nullptr;
    const JValue *connection = view->kind == JValue::Object ? view->get("connection") : nullptr;
    TrackView v;
    if (stream_id == nullptr || stream_id->kind != JValue::String || !hex32(stream_id->text) ||
        connection == nullptr || !positive_integer(*connection, &v.connection)) {
      *detail = "view";
      return false;
    }
    v.stream_id = stream_id->text;
    out->view = v;
  }
  return true;
}

void append_json_string(std::string *out, const std::string &value) {
  out->push_back('"');
  for (const char ch : value) {
    const unsigned char c = static_cast<unsigned char>(ch);
    if (c == '"' || c == '\\') {
      out->push_back('\\');
      out->push_back(static_cast<char>(c));
    } else if (c < 0x20) {
      static const char *const hex = "0123456789abcdef";
      out->append("\\u00");
      out->push_back(hex[c >> 4]);
      out->push_back(hex[c & 0xF]);
    } else {
      out->push_back(static_cast<char>(c));
    }
  }
  out->push_back('"');
}

std::string quoted(const std::string &value) {
  std::string out;
  append_json_string(&out, value);
  return out;
}

std::string quoted_list(const std::vector<std::string> &values) {
  std::string out = "[";
  for (std::size_t i = 0; i < values.size(); ++i) {
    if (i != 0) out.push_back(',');
    append_json_string(&out, values[i]);
  }
  out.push_back(']');
  return out;
}

// The first entry of `preferred` (the client's order) that `offered` (the receiver's) lists.
std::string negotiate(const std::vector<std::string> &preferred, const std::vector<std::string> &offered) {
  for (const std::string &p : preferred) {
    if (std::find(offered.begin(), offered.end(), p) != offered.end()) return p;
  }
  return std::string();
}

void write_counts(JsonWriter &json, const std::string &name, const std::map<std::string, std::uint64_t> &m) {
  json.key(name).object_begin();
  for (const auto &entry : m) json.key(entry.first).unsigned_integer(entry.second);
  json.object_end();
}

}  // namespace

// ----------------------------------------------------------------------------- free functions

bool kind_reserved(std::string_view kind) {
  return kind == "audio" || kind == "clipboard" || kind == "metadata" || kind == "data";
}

bool parse_sabotage(std::string_view text, Sabotage *out) {
  if (text == "track-view-token-accepted") {
    *out = Sabotage::ViewTokenAccepted;
  } else if (text == "track-rate-off") {
    *out = Sabotage::RateOff;
  } else if (text == "track-grant-ignored") {
    *out = Sabotage::GrantIgnored;
  } else if (text == "track-no-release") {
    *out = Sabotage::NoRelease;
  } else {
    *out = Sabotage::None;
    return false;
  }
  return true;
}

const char *sabotage_name(Sabotage sabotage) {
  switch (sabotage) {
    case Sabotage::ViewTokenAccepted: return "track-view-token-accepted";
    case Sabotage::RateOff: return "track-rate-off";
    case Sabotage::GrantIgnored: return "track-grant-ignored";
    case Sabotage::NoRelease: return "track-no-release";
    case Sabotage::None: break;
  }
  return "";
}

bool parse_kinds(const char *text, std::vector<std::string> *kinds, std::string *error) {
  kinds->clear();
  const std::string value = text != nullptr ? std::string(text) : std::string();
  if (value.empty()) return true;  // the pure path
  std::size_t start = 0;
  while (start <= value.size()) {
    std::size_t comma = value.find(',', start);
    if (comma == std::string::npos) comma = value.size();
    std::string item = value.substr(start, comma - start);
    // Spaces around an entry are ignored, as GRC_LIVE_ALLOWED_ORIGINS's.
    const std::size_t b = item.find_first_not_of(' ');
    const std::size_t e = item.find_last_not_of(' ');
    item = b == std::string::npos ? std::string() : item.substr(b, e - b + 1);
    if (item.empty()) {
      *error = "tracks-invalid: empty item in GRC_LIVE_TRACKS";
      kinds->clear();
      return false;
    }
    if (!kind_ok(item)) {
      *error = "tracks-invalid: malformed kind in GRC_LIVE_TRACKS";
      kinds->clear();
      return false;
    }
    if (std::find(kinds->begin(), kinds->end(), item) != kinds->end()) {
      *error = "tracks-invalid: duplicate kind " + item;
      kinds->clear();
      return false;
    }
    if (kind_reserved(item)) {
      *error = "tracks-reserved: " + item;
      kinds->clear();
      return false;
    }
    if (item != kKindInput) {
      *error = "tracks-invalid: unknown kind " + item;
      kinds->clear();
      return false;
    }
    kinds->push_back(item);
    start = comma + 1;
  }
  return true;
}

bool utf8_valid(std::string_view text) {
  const auto *p = reinterpret_cast<const unsigned char *>(text.data());
  const std::size_t n = text.size();
  std::size_t i = 0;
  while (i < n) {
    const unsigned char c = p[i];
    if (c < 0x80) {
      ++i;
      continue;
    }
    std::size_t len = 0;
    std::uint32_t cp = 0;
    std::uint32_t min = 0;
    if ((c & 0xE0) == 0xC0) {
      len = 2;
      cp = c & 0x1F;
      min = 0x80;
    } else if ((c & 0xF0) == 0xE0) {
      len = 3;
      cp = c & 0x0F;
      min = 0x800;
    } else if ((c & 0xF8) == 0xF0) {
      len = 4;
      cp = c & 0x07;
      min = 0x10000;
    } else {
      return false;
    }
    if (i + len > n) return false;
    for (std::size_t k = 1; k < len; ++k) {
      if ((p[i + k] & 0xC0) != 0x80) return false;
      cp = (cp << 6) | (p[i + k] & 0x3F);
    }
    if (cp < min || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) return false;
    i += len;
  }
  return true;
}

bool format_ok(std::string_view format) {
  const std::size_t slash = format.find('/');
  if (slash == std::string_view::npos || slash == 0 || slash > 48) return false;
  const std::string_view name = format.substr(0, slash);
  const std::string_view number = format.substr(slash + 1);
  if (name[0] < 'a' || name[0] > 'z') return false;
  for (const char c : name) {
    if (!lower_alnum(c) && c != '.' && c != '-') return false;
  }
  if (number.empty() || number.size() > 5 || number[0] == '0') return false;
  std::uint32_t n = 0;
  for (const char c : number) {
    if (c < '0' || c > '9') return false;
    n = n * 10 + static_cast<std::uint32_t>(c - '0');
  }
  return n >= 1 && n <= 65535;
}

std::string generate_credential() {
  unsigned char buf[32] = {};
  std::size_t got = 0;
  while (got < sizeof(buf)) {
    const ssize_t n = ::getrandom(buf + got, sizeof(buf) - got, 0);
    if (n < 0) {
      if (errno == EINTR) continue;
      return std::string();  // no entropy: the caller refuses rather than write a weak secret
    }
    got += static_cast<std::size_t>(n);
  }
  static const char *const hex = "0123456789abcdef";
  std::string out;
  out.reserve(64);
  for (const unsigned char b : buf) {
    out.push_back(hex[b >> 4]);
    out.push_back(hex[b & 0xF]);
  }
  return out;
}

bool write_secret_file(const std::string &path, const std::string &text) {
  const int fd = ::open(path.c_str(), O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC, 0600);
  if (fd < 0) return false;
  bool ok = ::fchmod(fd, 0600) == 0;
  std::size_t off = 0;
  while (ok && off < text.size()) {
    const ssize_t n = ::write(fd, text.data() + off, text.size() - off);
    if (n < 0) {
      if (errno == EINTR) continue;
      ok = false;
      break;
    }
    off += static_cast<std::size_t>(n);
  }
  ok = ::close(fd) == 0 && ok;
  return ok;
}

// ----------------------------------------------------------------------------- the hub

struct TrackHub::Conn {
  std::uint32_t conn = 0;
  std::string carrier;
  std::string origin;
  enum class Phase { Hello, Open, Closing } phase = Phase::Hello;
  std::uint64_t opened_ns = 0;
  std::uint64_t last_rx_ns = 0;
  std::uint64_t last_tx_ns = 0;
  double tokens = 0;
  std::uint64_t refill_ns = 0;
  TrackInfo info;  // source != 0 once accepted
  TrackReceiver *receiver = nullptr;
  std::uint64_t messages_in = 0;
  std::uint64_t bytes_in = 0;
  // The tap (GRC_LIVE_TAP_DIR): its hello line waits for the source or the refusal.
  std::FILE *tap = nullptr;
  std::string tap_hello;
  std::uint64_t tap_second_ns = 0;
  std::uint64_t tap_messages = 0;
  std::uint64_t tap_bytes = 0;
};

TrackHub::TrackHub(TrackConfig config, rs2::LiveTransport &transport, Log log)
    : config_(std::move(config)), transport_(transport), log_(std::move(log)) {
  for (const std::string &kind : config_.kinds) kinds_[kind];
  if (!config_.tap_dir.empty()) make_directories(config_.tap_dir);
}

TrackHub::~TrackHub() {
  for (auto &entry : conns_) close_tap(*entry.second);
}

TrackHub::Conn *TrackHub::find(std::uint32_t conn) {
  const auto it = conns_.find(conn);
  return it == conns_.end() ? nullptr : it->second.get();
}

TrackHub::Conn *TrackHub::find_source(std::uint32_t source) {
  if (source == 0) return nullptr;
  for (auto &entry : conns_) {
    Conn &c = *entry.second;
    if (c.phase == Conn::Phase::Open && c.info.source == source) return &c;
  }
  return nullptr;
}

bool TrackHub::claims(const live::Event &e) const {
  switch (e.kind) {
    case live::Event::Opened:
      return e.subprotocol == kTrackSubprotocolV1;
    case live::Event::Text:
    case live::Event::Closed:
      return conns_.count(e.conn) != 0;
    default:
      return false;
  }
}

TrackHub::KindStats *TrackHub::stats(const std::string &kind) {
  const auto it = kinds_.find(kind);
  return it == kinds_.end() ? nullptr : &it->second;
}

const TrackHub::KindStats *TrackHub::kind_stats(const std::string &kind) const {
  const auto it = kinds_.find(kind);
  return it == kinds_.end() ? nullptr : &it->second;
}

void TrackHub::count_refused(const std::string &kind, const std::string &key) {
  KindStats *s = stats(kind);
  if (s != nullptr) {
    ++s->refused[key];
  } else {
    ++refused_[key];
  }
}

bool TrackHub::text_out(Conn &c, std::string text) {
  c.last_tx_ns = now_ns_;
  const bool ok = transport_.send_text(c.conn, std::move(text));
  if (!ok) {
    KindStats *s = stats(c.info.kind);
    if (s != nullptr) ++s->faults["send-failed"];
  }
  return ok;
}

void TrackHub::tap(Conn &c, const std::string &line) {
  if (config_.tap_dir.empty()) return;
  if (c.tap == nullptr) {
    const std::string name = c.info.source != 0 ? "track-" + std::to_string(c.info.source) + ".jsonl"
                                                : "track-conn-" + std::to_string(c.conn) + ".jsonl";
    c.tap = std::fopen(path_join(config_.tap_dir, name).c_str(), "wb");
    if (c.tap == nullptr) return;
    if (!c.tap_hello.empty()) {
      std::fputs(c.tap_hello.c_str(), c.tap);
      std::fputc('\n', c.tap);
      c.tap_hello.clear();
    }
  }
  std::fputs(line.c_str(), c.tap);
  std::fputc('\n', c.tap);
  std::fflush(c.tap);
}

void TrackHub::tap_counts(Conn &c, bool force) {
  if (c.tap == nullptr) return;
  // Each elapsed second with traffic gets one line; `force` (a close) flushes a partial second.
  if (c.tap_messages == 0 && c.tap_bytes == 0) return;
  (void)force;
  tap(c, "{\"event\":\"counts\",\"t_ns\":" + std::to_string(c.tap_second_ns) +
             ",\"messages\":" + std::to_string(c.tap_messages) +
             ",\"bytes\":" + std::to_string(c.tap_bytes) + "}");
  c.tap_messages = 0;
  c.tap_bytes = 0;
}

void TrackHub::close_tap(Conn &c) {
  if (c.tap != nullptr) {
    std::fclose(c.tap);
    c.tap = nullptr;
  }
}

std::string TrackHub::error_json(const std::string &reason, const std::string &detail) {
  return "{\"type\":\"track-error\",\"reason\":" + quoted(reason) + ",\"detail\":" + quoted(detail) + "}";
}

void TrackHub::on_event(const live::Event &e, std::uint64_t now_ns) {
  now_ns_ = now_ns;
  switch (e.kind) {
    case live::Event::Opened: {
      auto c = std::make_unique<Conn>();
      c->conn = e.conn;
      c->carrier = e.carrier;
      c->origin = e.origin;
      c->opened_ns = now_ns;
      c->last_rx_ns = now_ns;
      c->last_tx_ns = now_ns;
      Conn &ref = *c;
      conns_[e.conn] = std::move(c);
      if (ended_) {
        // T13: after close_all, a late track connection is closed the same way at once.
        refuse(ref, end_code_, end_reason_, std::string());
      }
      return;
    }
    case live::Event::Text: {
      Conn *c = find(e.conn);
      if (c == nullptr) return;
      c->last_rx_ns = now_ns;
      if (c->phase == Conn::Phase::Hello) {
        on_hello(*c, e.text, now_ns);
      } else if (c->phase == Conn::Phase::Open) {
        on_payload(*c, e, now_ns);
      }
      // Closing: a refused or closing track's late texts are dropped (Q1.3).
      return;
    }
    case live::Event::Closed: {
      Conn *c = find(e.conn);
      if (c == nullptr) return;
      if (c->phase == Conn::Phase::Open) {
        // The peer (or the network) ended an open track: its one closed() (T8).
        const std::string key = "peer-" + std::to_string(e.code);
        KindStats *s = stats(c->info.kind);
        if (s != nullptr) ++s->closes[key];
        tap_counts(*c, true);
        tap(*c, "{\"event\":\"close\",\"by\":\"peer\",\"code\":" + std::to_string(e.code) +
                    ",\"reason\":" + quoted(e.reason) + ",\"messages\":" +
                    std::to_string(c->messages_in) + "}");
        log_("live: track close source=" + std::to_string(c->info.source) + " code=" +
             std::to_string(e.code) + " reason=" + (e.reason.empty() ? key : e.reason) +
             " messages=" + std::to_string(c->messages_in));
        c->phase = Conn::Phase::Closing;
        if (config_.sabotage != Sabotage::NoRelease) {
          report_closed(e.conn, e.code, e.reason.empty() ? key : e.reason);
        }
        changed_ = true;
      }
      Conn *again = find(e.conn);
      if (again != nullptr) close_tap(*again);
      conns_.erase(e.conn);
      return;
    }
    default:
      return;
  }
}

void TrackHub::on_hello(Conn &c, const std::string &text, std::uint64_t now_ns) {
  (void)now_ns;
  if (!utf8_valid(text)) {
    refuse(c, 1007, "track-utf8", std::string());
    return;
  }
  Hello hello;
  std::string detail;
  if (!parse_hello(text, &hello, &detail)) {
    refuse(c, 1002, "track-protocol", detail);
    return;
  }
  c.info.kind = hello.kind;
  c.info.client = hello.client;
  c.info.view = hello.view;
  c.info.carrier = c.carrier;
  c.info.origin = c.origin;
  if (!config_.tap_dir.empty()) {
    // The hello with its credential redacted (Q9): never secret material in a tap.
    std::string line = "{\"event\":\"hello\",\"kind\":" + quoted(hello.kind) +
                       ",\"formats\":" + quoted_list(hello.formats) +
                       ",\"down_formats\":" + quoted_list(hello.down_formats) +
                       ",\"credential\":\"<redacted>\",\"client\":" + quoted(hello.client) +
                       ",\"view\":" +
                       (hello.view ? "{\"stream_id\":" + quoted(hello.view->stream_id) +
                                         ",\"connection\":" + std::to_string(hello.view->connection) + "}"
                                   : std::string("null")) +
                       ",\"carrier\":" + quoted(c.carrier) + "}";
    c.tap_hello = std::move(line);
  }
  // 2. The grant (GRC_LIVE_TRACKS).
  const bool granted = std::find(config_.kinds.begin(), config_.kinds.end(), hello.kind) != config_.kinds.end();
  if (!granted && config_.sabotage != Sabotage::GrantIgnored) {
    refuse(c, 1008, "track-kind-refused", std::string());
    return;
  }
  // 3. The kind's credential, never the view token (T5).
  const bool view_token = !config_.view_token.empty() &&
                          live::constant_time_equals(hello.credential, config_.view_token);
  if (view_token && config_.sabotage != Sabotage::ViewTokenAccepted) {
    refuse(c, 1008, "track-unauthorized", "view-token");
    return;
  }
  if (!view_token) {
    const auto cred = config_.credentials.find(hello.kind);
    const bool ok = cred != config_.credentials.end() && !cred->second.empty() &&
                    live::constant_time_equals(hello.credential, cred->second);
    if (!ok) {
      refuse(c, 1008, "track-unauthorized", hello.credential.empty() ? "missing" : "wrong");
      return;
    }
  }
  // 4. A receiver for the kind.
  const auto bound = receivers_.find(hello.kind);
  if (bound == receivers_.end() || bound->second == nullptr) {
    refuse(c, 1013, "track-no-receiver", std::string());
    return;
  }
  TrackReceiver *receiver = bound->second;
  // 5. A common up format; the down format is optional.
  const std::string format = negotiate(hello.formats, receiver->formats());
  if (format.empty()) {
    refuse(c, 1008, "track-format-refused", std::string());
    return;
  }
  const std::string down_format = negotiate(hello.down_formats, receiver->down_formats());
  c.info.source = next_source_++;
  c.info.format = format;
  c.info.down_format = down_format;
  c.receiver = receiver;
  c.phase = Conn::Phase::Open;
  c.tokens = static_cast<double>(config_.burst);
  c.refill_ns = c.last_rx_ns;
  const std::string ready =
      "{\"type\":\"track-ready\",\"protocol\":\"" + std::string(kTrackProtocolV1) +
      "\",\"source\":" + std::to_string(c.info.source) + ",\"kind\":" + quoted(c.info.kind) +
      ",\"format\":" + quoted(format) +
      ",\"down_format\":" + (down_format.empty() ? std::string("null") : quoted(down_format)) +
      ",\"keepalive_ms\":" + std::to_string(config_.keepalive_ms) +
      ",\"max_message_bytes\":" + std::to_string(config_.max_message_bytes) +
      ",\"rate\":{\"messages_per_second\":" + std::to_string(config_.rate_per_s) +
      ",\"burst\":" + std::to_string(config_.burst) + "}}";
  text_out(c, ready);
  c.tap_second_ns = c.last_rx_ns;
  tap(c, "{\"event\":\"ready\",\"source\":" + std::to_string(c.info.source) + ",\"format\":" +
             quoted(format) + ",\"down_format\":" +
             (down_format.empty() ? std::string("null") : quoted(down_format)) + "}");
  KindStats *s = stats(c.info.kind);
  if (s != nullptr) ++s->opened;
  changed_ = true;
  log_("live: track open source=" + std::to_string(c.info.source) + " kind=" + c.info.kind +
       " format=" + format + " carrier=" + c.carrier + " origin=" + (c.origin.empty() ? "-" : c.origin));
  // Q4: opened() only after track-ready was queued.
  const TrackInfo info = c.info;
  receiver->opened(info);
}

void TrackHub::on_payload(Conn &c, const live::Event &e, std::uint64_t now_ns) {
  // T9: the token bucket over every client text, keepalives included. Over it: close, never drop.
  if (now_ns > c.refill_ns) {
    const double add = static_cast<double>(now_ns - c.refill_ns) * config_.rate_per_s / 1e9;
    c.tokens = std::min(static_cast<double>(config_.burst), c.tokens + add);
    c.refill_ns = now_ns;
  }
  if (c.tokens < 1.0 && config_.sabotage != Sabotage::RateOff) {
    host_close(c.conn, 1008, "track-rate", std::string(), true);
    return;
  }
  c.tokens -= 1.0;
  if (e.text.size() > config_.max_message_bytes) {
    // A consumer carrier with a larger cap than max_inbound_text: never skipped, closed (Q4).
    host_close(c.conn, 1009, "message-too-large", std::string(), true);
    return;
  }
  if (!utf8_valid(e.text)) {
    host_close(c.conn, 1007, "track-utf8", std::string(), true);
    return;
  }
  if (e.text.empty()) return;  // T10: a keepalive, never delivered
  ++c.messages_in;
  c.bytes_in += e.text.size();
  ++c.tap_messages;
  c.tap_bytes += e.text.size();
  KindStats *s = stats(c.info.kind);
  if (s != nullptr) {
    ++s->messages_in;
    s->bytes_in += e.text.size();
  }
  // T14: handed over verbatim, never parsed or logged.
  c.receiver->message(c.info.source, e.text);
}

void TrackHub::refuse(Conn &c, std::uint16_t code, const std::string &reason, const std::string &detail) {
  const std::string key = reason == "track-unauthorized" && detail == "view-token"
                              ? std::string("track-unauthorized:view-token")
                              : reason;
  count_refused(c.info.kind, key);
  log_("live: track refused reason=" + reason + " detail=" + (detail.empty() ? "-" : detail) +
       " carrier=" + c.carrier);
  if (!config_.tap_dir.empty()) {
    tap(c, "{\"event\":\"error\",\"reason\":" + quoted(reason) + ",\"detail\":" + quoted(detail) +
               ",\"code\":" + std::to_string(code) + "}");
  }
  c.phase = Conn::Phase::Closing;
  const std::uint32_t conn = c.conn;
  transport_.send_text(conn, error_json(reason, detail));
  transport_.close(conn, code, reason);
}

void TrackHub::report_closed(std::uint32_t conn, std::uint16_t code, const std::string &reason) {
  Conn *c = find(conn);
  if (c == nullptr || c->receiver == nullptr || c->info.source == 0) return;
  TrackReceiver *receiver = c->receiver;
  const std::uint32_t source = c->info.source;
  c->receiver = nullptr;  // exactly once
  KindStats *s = stats(c->info.kind);
  if (s != nullptr) ++s->closed;
  receiver->closed(source, code, reason);
}

void TrackHub::host_close(std::uint32_t conn, std::uint16_t code, const std::string &reason,
                          const std::string &detail, bool notify) {
  Conn *c = find(conn);
  if (c == nullptr || c->phase == Conn::Phase::Closing) return;
  const bool was_open = c->phase == Conn::Phase::Open;
  if (!was_open) {
    refuse(*c, code, reason, detail);
    return;
  }
  KindStats *s = stats(c->info.kind);
  if (s != nullptr) ++s->closes[reason];
  tap_counts(*c, true);
  tap(*c, "{\"event\":\"close\",\"by\":\"host\",\"code\":" + std::to_string(code) +
              ",\"reason\":" + quoted(reason) + ",\"messages\":" + std::to_string(c->messages_in) + "}");
  log_("live: track close source=" + std::to_string(c->info.source) + " code=" + std::to_string(code) +
       " reason=" + reason + " messages=" + std::to_string(c->messages_in));
  c->phase = Conn::Phase::Closing;
  if (notify) transport_.send_text(conn, error_json(reason, detail));
  transport_.close(conn, code, reason);
  changed_ = true;
  report_closed(conn, code, reason);
}

void TrackHub::tick(std::uint64_t now_ns) {
  now_ns_ = now_ns;
  const std::uint64_t keepalive_ns = static_cast<std::uint64_t>(config_.keepalive_ms) * kNsPerMs;
  const std::uint64_t hello_ns = config_.hello_timeout_ms * kNsPerMs;
  std::vector<std::uint32_t> ids;
  ids.reserve(conns_.size());
  for (const auto &entry : conns_) ids.push_back(entry.first);
  for (const std::uint32_t id : ids) {
    Conn *c = find(id);
    if (c == nullptr) continue;
    if (c->phase == Conn::Phase::Hello) {
      if (now_ns >= c->opened_ns + hello_ns) refuse(*c, 1002, "track-hello-timeout", std::string());
      continue;
    }
    if (c->phase != Conn::Phase::Open) continue;
    if (now_ns >= c->last_rx_ns + 3 * keepalive_ns) {
      host_close(id, 1001, "track-idle", std::string(), true);
      continue;
    }
    if (now_ns >= c->last_tx_ns + keepalive_ns) {
      text_out(*c, std::string());  // T10: the host's keepalive
    }
    if (now_ns >= c->tap_second_ns + kNsPerS) {
      tap_counts(*c, false);
      c->tap_second_ns = now_ns;
    }
  }
}

bool TrackHub::bind(const std::string &kind, TrackReceiver *receiver, std::string *error) {
  const auto fail = [error](const char *why) {
    if (error != nullptr) *error = why;
    return false;
  };
  if (receiver == nullptr || !kind_ok(kind)) return fail("track-kind-invalid");
  if (!formats_valid(receiver->formats(), false) || !formats_valid(receiver->down_formats(), true)) {
    return fail("track-formats-invalid");
  }
  const auto it = receivers_.find(kind);
  if (it != receivers_.end() && it->second != receiver) return fail("track-kind-bound");
  receivers_[kind] = receiver;
  return true;
}

void TrackHub::unbind(TrackReceiver *receiver) {
  std::vector<std::uint32_t> ids;
  for (const auto &entry : conns_) {
    if (entry.second->phase == Conn::Phase::Open && entry.second->receiver == receiver) {
      ids.push_back(entry.first);
    }
  }
  for (const std::uint32_t id : ids) host_close(id, 1013, "track-receiver-gone", std::string(), true);
  for (auto it = receivers_.begin(); it != receivers_.end();) {
    it = it->second == receiver ? receivers_.erase(it) : std::next(it);
  }
}

bool TrackHub::send(std::uint32_t source, std::string text) {
  Conn *c = find_source(source);
  if (c == nullptr || c->info.down_format.empty() || text.empty() ||
      text.size() > config_.max_message_bytes || !utf8_valid(text)) {
    return false;
  }
  const std::size_t bytes = text.size();
  if (!text_out(*c, std::move(text))) return false;
  KindStats *s = stats(c->info.kind);
  if (s != nullptr) {
    ++s->messages_out;
    s->bytes_out += bytes;
  }
  return true;
}

bool TrackHub::close(std::uint32_t source, std::uint16_t code) {
  if (code != 1000 && (code < 4000 || code > 4999)) return false;
  Conn *c = find_source(source);
  if (c == nullptr) return false;
  host_close(c->conn, code, "track-closed", std::string(), true);
  return true;
}

void TrackHub::close_all(std::uint16_t code, const std::string &reason) {
  ended_ = true;
  end_code_ = code;
  end_reason_ = reason;
  std::vector<std::uint32_t> ids;
  for (const auto &entry : conns_) ids.push_back(entry.first);
  for (const std::uint32_t id : ids) {
    Conn *c = find(id);
    if (c == nullptr || c->phase == Conn::Phase::Closing) continue;
    host_close(id, code, reason, std::string(), true);
  }
}

bool TrackHub::take_changed() {
  const bool was = changed_;
  changed_ = false;
  return was;
}

std::size_t TrackHub::open_tracks() const {
  std::size_t n = 0;
  for (const auto &entry : conns_) n += entry.second->phase == Conn::Phase::Open ? 1 : 0;
  return n;
}

std::string TrackHub::json(const Extras &extras) const {
  JsonWriter json;
  json.object_begin();
  json.field("schema", std::string("render-stream-live-tracks/1"));
  json.key("kinds").array_begin();
  for (const std::string &k : config_.kinds) json.string(k);
  json.array_end();
  json.key("max_tracks").unsigned_integer(extras.max_tracks);
  json.key("admitted_max").unsigned_integer(extras.admitted_max);
  json.key("keepalive_ms").unsigned_integer(config_.keepalive_ms);
  json.key("rate").object_begin();
  json.key("messages_per_second").unsigned_integer(config_.rate_per_s);
  json.key("burst").unsigned_integer(config_.burst);
  json.object_end();
  json.field_null("inject");  // TRK6
  json.field("caps", std::string("shared"));  // TRK5 adds "hmac"
  json.key("carriers").array_begin();
  for (const CarrierTracks &c : extras.carriers) {
    json.object_begin();
    json.field("name", c.name);
    if (c.tracks.has_value()) {
      json.field("tracks", *c.tracks);
    } else {
      json.field_null("tracks");
    }
    json.object_end();
  }
  json.array_end();
  json.key("tracks").object_begin();
  for (const auto &entry : kinds_) {
    const KindStats &s = entry.second;
    json.key(entry.first).object_begin();
    const auto bound = receivers_.find(entry.first);
    json.field("bound", bound != receivers_.end());
    json.key("formats").array_begin();
    if (bound != receivers_.end()) {
      for (const std::string &f : bound->second->formats()) json.string(f);
    }
    json.array_end();
    json.key("down_formats").array_begin();
    if (bound != receivers_.end()) {
      for (const std::string &f : bound->second->down_formats()) json.string(f);
    }
    json.array_end();
    json.key("opened").unsigned_integer(s.opened);
    json.key("closed").unsigned_integer(s.closed);
    json.key("messages_in").unsigned_integer(s.messages_in);
    json.key("bytes_in").unsigned_integer(s.bytes_in);
    json.key("messages_out").unsigned_integer(s.messages_out);
    json.key("bytes_out").unsigned_integer(s.bytes_out);
    write_counts(json, "refused", s.refused);
    write_counts(json, "closes", s.closes);
    write_counts(json, "faults", s.faults);
    json.object_end();
  }
  json.object_end();
  write_counts(json, "refused", refused_);
  json.field_or_null("sabotage", sabotage_name(config_.sabotage));
  json.object_end();
  return json.take();
}

}  // namespace tracks
}  // namespace rs
}  // namespace grc
