// rs_json_lite: a small strict JSON reader for client texts the capture must parse (TRK1's
// track-hello, TRK5's capability payloads and their golden vectors; protocol/tracks-design.md).
//
// Objects, arrays, strings, numbers, true/false/null, with a depth cap of 8. Strings are decoded
// (escapes, \u surrogate pairs; a lone surrogate is refused) into UTF-8. Numbers keep their source
// text, so a caller can demand an exact integer spelling. Object members keep their source order;
// get() returns the last duplicate, as JSON.parse does, and a caller that must refuse duplicates
// walks `fields` itself. Header-only and stateless apart from the value tree it builds.
#ifndef GRC_RS_JSON_LITE_H
#define GRC_RS_JSON_LITE_H

#include <cstddef>
#include <cstdint>
#include <cstring>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace grc {
namespace rs {
namespace json_lite {

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

}  // namespace json_lite
}  // namespace rs
}  // namespace grc

#endif  // GRC_RS_JSON_LITE_H
