// render-stream/13's predicted blocks (rs13_predict.h). Every function mirrors the one of the
// same name in protocol/golden-13/make_golden.py; read the two side by side.
#include "rs13_predict.h"

#include <cstdlib>
#include <cstring>
#include <string_view>
#include <utility>

#include "common/xxhash.h"
#include "rs2_codec.h"

namespace grc {
namespace rs13 {

namespace {

// --------------------------------------------------------------------------- a small JSON reader
//
// Python's json.loads() semantics for what the predictor reads: the whole meta must be valid JSON
// (else meta-json); only the keys below become values, every other value is validated and
// skipped without allocating.

struct JValue {
  enum class Kind : std::uint8_t { Null, Bool, Num, Str, Arr, Obj };
  Kind kind = Kind::Null;
  bool b = false;
  bool is_int = false;  // a JSON integer literal that fits int64
  std::int64_t i = 0;
  double d = 0.0;
  std::string s;
  std::vector<JValue> a;
  std::vector<std::pair<std::string, JValue>> o;

  // dict.get(): the last value of `key` (json.loads keeps the last duplicate), or null.
  const JValue *get(std::string_view key) const {
    if (kind != Kind::Obj) {
      return nullptr;
    }
    for (auto it = o.rbegin(); it != o.rend(); ++it) {
      if (it->first == key) {
        return &it->second;
      }
    }
    return nullptr;
  }
  bool is_null() const { return kind == Kind::Null; }
  // An integer as Python sees one (bool is an int there).
  bool as_int(std::int64_t *out) const {
    if (kind == Kind::Num && is_int) {
      *out = i;
      return true;
    }
    if (kind == Kind::Bool) {
      *out = b ? 1 : 0;
      return true;
    }
    return false;
  }
  // `value == n` for an int n, as Python compares (1.0 == 1).
  bool equals_int(std::int64_t n) const {
    std::int64_t v = 0;
    if (as_int(&v)) {
      return v == n;
    }
    return kind == Kind::Num && d == static_cast<double>(n);
  }
  bool truthy() const {
    switch (kind) {
    case Kind::Null: return false;
    case Kind::Bool: return b;
    case Kind::Num: return is_int ? i != 0 : d != 0.0;
    case Kind::Str: return !s.empty();
    case Kind::Arr: return !a.empty();
    case Kind::Obj: return !o.empty();
    }
    return false;
  }
};

const JValue kNull;
// `e.get(key)` where a missing key and a null value are the same (Python's `is None`).
const JValue &at(const JValue &obj, std::string_view key) {
  const JValue *v = obj.get(key);
  return v != nullptr ? *v : kNull;
}

class JsonReader {
 public:
  JsonReader(const char *p, std::size_t n) : p_(p), end_(p + n) {}

  bool ws() {
    while (p_ < end_ && (*p_ == ' ' || *p_ == '\t' || *p_ == '\n' || *p_ == '\r')) {
      ++p_;
    }
    return true;
  }
  bool at_end() {
    ws();
    return p_ == end_;
  }
  bool peek(char c) {
    ws();
    return p_ < end_ && *p_ == c;
  }
  bool eat(char c) {
    if (peek(c)) {
      ++p_;
      return true;
    }
    return false;
  }

  bool string(std::string *out) {
    if (!eat('"')) {
      return false;
    }
    while (p_ < end_) {
      const unsigned char c = static_cast<unsigned char>(*p_++);
      if (c == '"') {
        return true;
      }
      if (c < 0x20) {
        return false;
      }
      if (c != '\\') {
        if (out != nullptr) {
          out->push_back(static_cast<char>(c));
        }
        continue;
      }
      if (p_ >= end_) {
        return false;
      }
      const char e = *p_++;
      char lit = 0;
      switch (e) {
      case '"': lit = '"'; break;
      case '\\': lit = '\\'; break;
      case '/': lit = '/'; break;
      case 'b': lit = '\b'; break;
      case 'f': lit = '\f'; break;
      case 'n': lit = '\n'; break;
      case 'r': lit = '\r'; break;
      case 't': lit = '\t'; break;
      case 'u': {
        if (end_ - p_ < 4) {
          return false;
        }
        unsigned cp = 0;
        for (int k = 0; k < 4; ++k) {
          const char h = *p_++;
          cp <<= 4;
          if (h >= '0' && h <= '9') {
            cp |= static_cast<unsigned>(h - '0');
          } else if (h >= 'a' && h <= 'f') {
            cp |= static_cast<unsigned>(h - 'a' + 10);
          } else if (h >= 'A' && h <= 'F') {
            cp |= static_cast<unsigned>(h - 'A' + 10);
          } else {
            return false;
          }
        }
        if (out != nullptr) {  // UTF-8 (surrogates kept as their own code units: keys are ASCII)
          if (cp < 0x80) {
            out->push_back(static_cast<char>(cp));
          } else if (cp < 0x800) {
            out->push_back(static_cast<char>(0xC0 | (cp >> 6)));
            out->push_back(static_cast<char>(0x80 | (cp & 0x3F)));
          } else {
            out->push_back(static_cast<char>(0xE0 | (cp >> 12)));
            out->push_back(static_cast<char>(0x80 | ((cp >> 6) & 0x3F)));
            out->push_back(static_cast<char>(0x80 | (cp & 0x3F)));
          }
        }
        continue;
      }
      default: return false;
      }
      if (out != nullptr) {
        out->push_back(lit);
      }
    }
    return false;
  }

  bool number(JValue *out) {
    ws();
    const char *start = p_;
    if (p_ < end_ && *p_ == '-') {
      ++p_;
    }
    if (p_ >= end_ || *p_ < '0' || *p_ > '9') {
      return false;
    }
    if (*p_ == '0') {
      ++p_;
    } else {
      while (p_ < end_ && *p_ >= '0' && *p_ <= '9') {
        ++p_;
      }
    }
    bool integer = true;
    if (p_ < end_ && *p_ == '.') {
      integer = false;
      ++p_;
      if (p_ >= end_ || *p_ < '0' || *p_ > '9') {
        return false;
      }
      while (p_ < end_ && *p_ >= '0' && *p_ <= '9') {
        ++p_;
      }
    }
    if (p_ < end_ && (*p_ == 'e' || *p_ == 'E')) {
      integer = false;
      ++p_;
      if (p_ < end_ && (*p_ == '+' || *p_ == '-')) {
        ++p_;
      }
      if (p_ >= end_ || *p_ < '0' || *p_ > '9') {
        return false;
      }
      while (p_ < end_ && *p_ >= '0' && *p_ <= '9') {
        ++p_;
      }
    }
    if (out != nullptr) {
      const std::string text(start, p_);
      out->kind = JValue::Kind::Num;
      out->d = std::strtod(text.c_str(), nullptr);
      out->is_int = false;
      if (integer && text.size() <= 18) {  // fits int64 without overflow checks
        out->is_int = true;
        out->i = std::strtoll(text.c_str(), nullptr, 10);
      }
    }
    return true;
  }

  bool literal(const char *word) {
    const std::size_t n = std::strlen(word);
    if (static_cast<std::size_t>(end_ - p_) < n || std::memcmp(p_, word, n) != 0) {
      return false;
    }
    p_ += n;
    return true;
  }

  // One value into `out` (nullptr: validate and skip).
  bool value(JValue *out, int depth = 0) {
    if (depth > 512) {
      return false;
    }
    ws();
    if (p_ >= end_) {
      return false;
    }
    const char c = *p_;
    if (c == '{') {
      ++p_;
      if (out != nullptr) {
        out->kind = JValue::Kind::Obj;
      }
      if (eat('}')) {
        return true;
      }
      for (;;) {
        std::string key;
        if (!string(out != nullptr ? &key : nullptr) || !eat(':')) {
          return false;
        }
        if (out != nullptr) {
          out->o.emplace_back(std::move(key), JValue());
          if (!value(&out->o.back().second, depth + 1)) {
            return false;
          }
        } else if (!value(nullptr, depth + 1)) {
          return false;
        }
        if (eat(',')) {
          continue;
        }
        return eat('}');
      }
    }
    if (c == '[') {
      ++p_;
      if (out != nullptr) {
        out->kind = JValue::Kind::Arr;
      }
      if (eat(']')) {
        return true;
      }
      for (;;) {
        if (out != nullptr) {
          out->a.emplace_back();
          if (!value(&out->a.back(), depth + 1)) {
            return false;
          }
        } else if (!value(nullptr, depth + 1)) {
          return false;
        }
        if (eat(',')) {
          continue;
        }
        return eat(']');
      }
    }
    if (c == '"') {
      if (out != nullptr) {
        out->kind = JValue::Kind::Str;
        return string(&out->s);
      }
      return string(nullptr);
    }
    if (c == 't' || c == 'f') {
      const bool v = c == 't';
      if (!literal(v ? "true" : "false")) {
        return false;
      }
      if (out != nullptr) {
        out->kind = JValue::Kind::Bool;
        out->b = v;
      }
      return true;
    }
    if (c == 'n') {
      if (!literal("null")) {
        return false;
      }
      if (out != nullptr) {
        out->kind = JValue::Kind::Null;
      }
      return true;
    }
    return number(out);
  }

 private:
  const char *p_;
  const char *end_;
};

// The meta keys the predictor reads, each a JValue (null when absent).
struct Meta {
  bool is_object = false;
  std::string type;
  bool has_type = false;
  bool full = false;  // "encoding" == "full"
  JValue meshes, removed_meshes, multimeshes, removed_multimeshes, blocks;
};

enum class MetaParse { Ok, Json, NotObject };

MetaParse parse_meta(const std::uint8_t *data, std::size_t size, Meta *meta) {
  JsonReader r(reinterpret_cast<const char *>(data), size);
  if (!r.peek('{')) {
    // Not an object: still meta-json unless it is some other valid JSON value.
    JsonReader v(reinterpret_cast<const char *>(data), size);
    return v.value(nullptr) && v.at_end() ? MetaParse::NotObject : MetaParse::Json;
  }
  r.eat('{');
  meta->is_object = true;
  if (!r.eat('}')) {
    for (;;) {
      std::string key;
      if (!r.string(&key) || !r.eat(':')) {
        return MetaParse::Json;
      }
      JValue *target = nullptr;
      JValue scratch;
      if (key == "meshes") {
        target = &meta->meshes;
      } else if (key == "removed_meshes") {
        target = &meta->removed_meshes;
      } else if (key == "multimeshes") {
        target = &meta->multimeshes;
      } else if (key == "removed_multimeshes") {
        target = &meta->removed_multimeshes;
      } else if (key == "blocks") {
        target = &meta->blocks;
      } else if (key == "type" || key == "encoding") {
        target = &scratch;
      }
      if (target != nullptr) {
        *target = JValue();
      }
      if (!r.value(target)) {
        return MetaParse::Json;
      }
      if (key == "type") {
        meta->has_type = scratch.kind == JValue::Kind::Str;
        meta->type = scratch.s;
      } else if (key == "encoding") {
        meta->full = scratch.kind == JValue::Kind::Str && scratch.s == "full";
      }
      if (r.eat(',')) {
        continue;
      }
      if (!r.eat('}')) {
        return MetaParse::Json;
      }
      break;
    }
  }
  return r.at_end() ? MetaParse::Ok : MetaParse::Json;
}

// --------------------------------------------------------------------------- record framing

struct Span {
  const std::uint8_t *p = nullptr;
  std::size_t n = 0;
};

std::uint32_t u32_at(const std::uint8_t *p) {
  return static_cast<std::uint32_t>(p[0]) | (static_cast<std::uint32_t>(p[1]) << 8) |
         (static_cast<std::uint32_t>(p[2]) << 16) | (static_cast<std::uint32_t>(p[3]) << 24);
}

void put_u32(std::vector<std::uint8_t> &out, std::uint32_t v) {
  out.push_back(static_cast<std::uint8_t>(v));
  out.push_back(static_cast<std::uint8_t>(v >> 8));
  out.push_back(static_cast<std::uint8_t>(v >> 16));
  out.push_back(static_cast<std::uint8_t>(v >> 24));
}

// make_golden.py parse_record(): (meta, blocks) of one record, length prefix included.
bool parse_record(const std::uint8_t *rec, std::size_t size, Span *meta, std::vector<Span> *blocks) {
  if (size < 12 || u32_at(rec) != size - 4) {
    return false;
  }
  const std::size_t meta_len = u32_at(rec + 4);
  if (meta_len > size - 12) {
    return false;
  }
  *meta = Span{rec + 8, meta_len};
  std::size_t p = 8 + meta_len;
  const std::uint32_t count = u32_at(rec + p);
  p += 4;
  blocks->clear();
  for (std::uint32_t k = 0; k < count; ++k) {
    if (size - p < 4) {
      return false;
    }
    const std::size_t n = u32_at(rec + p);
    p += 4;
    if (n > size - p) {
      return false;
    }
    blocks->push_back(Span{rec + p, n});
    p += n;
  }
  return p == size;
}

void make_record(const std::string &meta, const std::vector<Span> &blocks,
                 std::vector<std::uint8_t> *out) {
  std::size_t body = 4 + meta.size() + 4;
  for (const Span &b : blocks) {
    body += 4 + b.n;
  }
  out->clear();
  out->reserve(4 + body);
  put_u32(*out, static_cast<std::uint32_t>(body));
  put_u32(*out, static_cast<std::uint32_t>(meta.size()));
  out->insert(out->end(), meta.begin(), meta.end());
  put_u32(*out, static_cast<std::uint32_t>(blocks.size()));
  for (const Span &b : blocks) {
    put_u32(*out, static_cast<std::uint32_t>(b.n));
    out->insert(out->end(), b.p, b.p + b.n);
  }
}

constexpr std::string_view kBlocksMark = ",\"blocks\":[";
constexpr std::string_view kCheckKey = ",\"predict_check\":\"";

// make_golden.py with_check(): the key right before the last `,"blocks":[`.
bool with_check(std::string_view meta, const std::string &hex16, std::string *out) {
  const std::size_t i = meta.rfind(kBlocksMark);
  if (i == std::string_view::npos) {
    return false;
  }
  out->assign(meta.substr(0, i));
  *out += kCheckKey;
  *out += hex16;
  *out += '"';
  out->append(meta.substr(i));
  return true;
}

// make_golden.py without_check(): the plain meta and the check's 16 characters, or false when
// the key is not exactly where /13 puts it.
bool without_check(std::string_view meta, std::string *plain, std::string *check) {
  const std::size_t i = meta.rfind(kBlocksMark);
  if (i == std::string_view::npos || i < kCheckKey.size() + 17) {
    return false;
  }
  const std::size_t j = i - kCheckKey.size() - 17;
  if (meta.substr(j, kCheckKey.size()) != kCheckKey || meta[i - 1] != '"') {
    return false;
  }
  check->assign(meta.substr(j + kCheckKey.size(), 16));
  plain->assign(meta.substr(0, j));
  plain->append(meta.substr(i));
  return true;
}

// --------------------------------------------------------------------------- word arithmetic

std::uint32_t word_at(const std::uint8_t *p) { return u32_at(p); }
void set_word(std::uint8_t *p, std::uint32_t v) {
  p[0] = static_cast<std::uint8_t>(v);
  p[1] = static_cast<std::uint8_t>(v >> 8);
  p[2] = static_cast<std::uint8_t>(v >> 16);
  p[3] = static_cast<std::uint8_t>(v >> 24);
}

std::uint32_t ordered(std::uint32_t u) { return u < 0x80000000u ? u ^ 0x80000000u : ~u; }
std::uint32_t unordered(std::uint32_t o) { return o >= 0x80000000u ? o ^ 0x80000000u : ~o; }
std::uint32_t zz32(std::uint32_t d) {
  return (d << 1) ^ static_cast<std::uint32_t>(static_cast<std::int32_t>(d) >> 31);
}
std::uint32_t unzz32(std::uint32_t u) { return (u >> 1) ^ (0u - (u & 1u)); }

// make_golden.py predict_words() / unpredict_words(), in place over n bytes (a multiple of 4).
void code_words(std::uint8_t *buf, std::size_t n, const std::uint8_t *base,
                const std::uint8_t *prev, bool inverse) {
  if (base == nullptr) {
    return;  // raw: the word itself
  }
  for (std::size_t k = 0; k + 4 <= n; k += 4) {
    const std::uint32_t b = ordered(word_at(base + k));
    const std::uint32_t pred = prev == nullptr ? b : 2u * b - ordered(word_at(prev + k));
    const std::uint32_t v = word_at(buf + k);
    set_word(buf + k, inverse ? unordered(unzz32(v) + pred) : zz32(ordered(v) - pred));
  }
}

void xor_bytes(std::uint8_t *buf, std::size_t n, const std::uint8_t *base) {
  if (base == nullptr) {
    return;
  }
  for (std::size_t k = 0; k < n; ++k) {
    buf[k] ^= base[k];
  }
}

// Byte-plane transpose of n words: byte j of word k goes to j * n + k.
void transpose4(const std::uint8_t *in, std::size_t size, std::uint8_t *out) {
  const std::size_t n = size / 4;
  for (std::size_t k = 0; k < n; ++k) {
    for (std::size_t j = 0; j < 4; ++j) {
      out[j * n + k] = in[4 * k + j];
    }
  }
}
void untranspose4(const std::uint8_t *in, std::size_t size, std::uint8_t *out) {
  const std::size_t n = size / 4;
  for (std::size_t k = 0; k < n; ++k) {
    for (std::size_t j = 0; j < 4; ++j) {
      out[4 * k + j] = in[j * n + k];
    }
  }
}

// --------------------------------------------------------------------------- body partition

// make_golden.py body_parts(): byte sizes of [geometry, positions, colours, UVs, skin, indices],
// plus the vertex count and per-vertex colour / UV sizes for the de-interleave.
struct BodyParts {
  std::int64_t n = 0, col = 0, uv = 0;
  std::array<std::size_t, 6> size{};
  std::size_t total = 0;
};

bool body_parts(const JValue &s, SurfaceShape *shape, BodyParts *out) {
  std::int64_t n = 0, fmt = 0, ic = 0;
  if (!at(s, "vertex_count").as_int(&n) || !at(s, "format").as_int(&fmt) ||
      !at(s, "index_count").as_int(&ic) || n < 0 || ic < 0 || n > (1 << 28) || ic > (1 << 28)) {
    return false;
  }
  const JValue &prim = at(s, "primitive");
  if (prim.kind != JValue::Kind::Str) {
    return false;
  }
  shape->primitive = prim.s;
  shape->format = fmt;
  shape->vertex_count = n;
  shape->index_count = ic;
  out->n = n;
  out->col = (fmt & (1 << 3)) != 0 ? 4 : 0;
  out->uv = (fmt & (1 << 4)) != 0 ? 8 : 0;
  std::int64_t skin = 0;
  if ((fmt & (1 << 10)) != 0 && (fmt & (1 << 11)) != 0) {
    skin = n * ((fmt & (static_cast<std::int64_t>(1) << 27)) != 0 ? 32 : 16);
  }
  const std::int64_t idx = ic == 0 ? 0 : ic * (n <= 65536 ? 2 : 4);
  out->size = {40, static_cast<std::size_t>(8 * n), static_cast<std::size_t>(n * out->col),
               static_cast<std::size_t>(n * out->uv), static_cast<std::size_t>(skin),
               static_cast<std::size_t>(idx)};
  out->total = 0;
  for (std::size_t v : out->size) {
    out->total += v;
  }
  return true;
}

using Parts = std::array<std::vector<std::uint8_t>, 6>;

// make_golden.py split_body(): colour and UV de-interleaved from the attribute section.
Parts split_body(const std::uint8_t *body, const BodyParts &bp) {
  Parts out;
  std::size_t p = 0;
  out[0].assign(body, body + bp.size[0]);
  p += bp.size[0];
  out[1].assign(body + p, body + p + bp.size[1]);
  p += bp.size[1];
  const std::size_t col = static_cast<std::size_t>(bp.col);
  const std::size_t uv = static_cast<std::size_t>(bp.uv);
  const std::size_t stride = col + uv;
  out[2].reserve(bp.size[2]);
  out[3].reserve(bp.size[3]);
  for (std::int64_t k = 0; k < bp.n; ++k) {
    const std::uint8_t *v = body + p + static_cast<std::size_t>(k) * stride;
    out[2].insert(out[2].end(), v, v + col);
    out[3].insert(out[3].end(), v + col, v + stride);
  }
  p += stride * static_cast<std::size_t>(bp.n);
  out[4].assign(body + p, body + p + bp.size[4]);
  p += bp.size[4];
  out[5].assign(body + p, body + p + bp.size[5]);
  return out;
}

// make_golden.py join_body().
void join_body(const Parts &parts, const BodyParts &bp, std::vector<std::uint8_t> *out) {
  out->insert(out->end(), parts[0].begin(), parts[0].end());
  out->insert(out->end(), parts[1].begin(), parts[1].end());
  const std::size_t col = static_cast<std::size_t>(bp.col);
  const std::size_t uv = static_cast<std::size_t>(bp.uv);
  for (std::int64_t k = 0; k < bp.n; ++k) {
    const std::size_t kk = static_cast<std::size_t>(k);
    out->insert(out->end(), parts[2].begin() + kk * col, parts[2].begin() + (kk + 1) * col);
    out->insert(out->end(), parts[3].begin() + kk * uv, parts[3].begin() + (kk + 1) * uv);
  }
  out->insert(out->end(), parts[4].begin(), parts[4].end());
  out->insert(out->end(), parts[5].begin(), parts[5].end());
}

constexpr bool is_word_stream(std::size_t i) { return i == 0 || i == 1 || i == 3; }

// --------------------------------------------------------------------------- layouts

struct SurfaceLayout {
  BodyParts parts;
  std::size_t offset = 0;
};
struct EntryLayout {
  std::int64_t id = 0;
  std::vector<SurfaceShape> shape;
  std::vector<SurfaceLayout> surfaces;
};

bool array_or_missing(const JValue &v) {
  return v.kind == JValue::Kind::Arr || v.kind == JValue::Kind::Null;
}

// make_golden.py u8_layout(): the carried bodies, or false when mesh_u8's offset rule fails.
bool u8_layout(const Meta &meta, std::size_t u8_len, std::vector<EntryLayout> *out) {
  out->clear();
  if (!array_or_missing(meta.meshes)) {
    return false;
  }
  std::int64_t run = 0;
  for (const JValue &e : meta.meshes.a) {
    if (e.kind != JValue::Kind::Obj) {
      return false;
    }
    const JValue &u8 = at(e, "u8");
    if (u8.is_null()) {
      continue;
    }
    if (!u8.equals_int(run)) {
      return false;
    }
    EntryLayout entry;
    const JValue &surfaces = at(e, "surfaces");
    if (!at(e, "id").as_int(&entry.id) || surfaces.kind != JValue::Kind::Arr) {
      return false;
    }
    for (const JValue &s : surfaces.a) {
      SurfaceLayout sl;
      SurfaceShape shape;
      if (s.kind != JValue::Kind::Obj || !body_parts(s, &shape, &sl.parts) ||
          !at(s, "payload_bytes").equals_int(static_cast<std::int64_t>(sl.parts.total))) {
        return false;
      }
      sl.offset = static_cast<std::size_t>(run);
      run += static_cast<std::int64_t>(sl.parts.total);
      entry.shape.push_back(shape);
      entry.surfaces.push_back(sl);
    }
    out->push_back(std::move(entry));
  }
  return run == static_cast<std::int64_t>(u8_len);
}

// make_golden.py f32_layout(): (mesh id, float offset) of the AABB units.
bool f32_layout(const Meta &meta, std::size_t n_floats,
                std::vector<std::pair<std::int64_t, std::size_t>> *out) {
  out->clear();
  if (!array_or_missing(meta.meshes)) {
    return false;
  }
  std::int64_t run = 0;
  for (const JValue &e : meta.meshes.a) {
    if (e.kind != JValue::Kind::Obj) {
      return false;
    }
    const JValue &f = at(e, "f");
    if (f.is_null()) {
      continue;
    }
    std::int64_t id = 0;
    if (!f.equals_int(run) || !at(e, "id").as_int(&id)) {
      return false;
    }
    out->emplace_back(id, static_cast<std::size_t>(run));
    run += 6;
  }
  return run == static_cast<std::int64_t>(n_floats);
}

struct MmLayout {
  std::int64_t id = 0, instances = 0, stride = 0;
  std::size_t offset = 0;
};

std::int64_t mm_stride(const JValue &e) {
  return 8 + 4 * (at(e, "colors").truthy() ? 1 : 0) + 4 * (at(e, "custom").truthy() ? 1 : 0);
}

// make_golden.py mm_layout(): the buffer units.
bool mm_layout(const Meta &meta, std::size_t n_floats, std::vector<MmLayout> *out) {
  out->clear();
  if (!array_or_missing(meta.multimeshes)) {
    return false;
  }
  std::int64_t run = 0;
  for (const JValue &e : meta.multimeshes.a) {
    if (e.kind != JValue::Kind::Obj) {
      return false;
    }
    const JValue &aabb = at(e, "aabb_f");
    if (!aabb.is_null()) {
      if (!aabb.equals_int(run)) {
        return false;
      }
      run += 6;
    }
    const JValue &buf = at(e, "buffer_f");
    if (!buf.is_null()) {
      MmLayout l;
      if (!buf.equals_int(run) || !at(e, "id").as_int(&l.id) ||
          !at(e, "instances").as_int(&l.instances) || l.instances < 0 ||
          l.instances > (1 << 26)) {
        return false;
      }
      l.stride = mm_stride(e);
      l.offset = static_cast<std::size_t>(run);
      out->push_back(l);
      run += l.instances * l.stride;
    }
  }
  return run == static_cast<std::int64_t>(n_floats);
}

bool is_dynamic(const JValue &e) {
  const JValue &status = at(e, "status");
  const JValue &surfaces = at(e, "surfaces");
  if (status.kind != JValue::Kind::Str || status.s != "ok" || !surfaces.truthy() ||
      surfaces.kind != JValue::Kind::Arr) {
    return false;
  }
  for (const JValue &s : surfaces.a) {
    if (!at(s, "hash").is_null()) {
      return false;
    }
  }
  return true;
}

// --------------------------------------------------------------------------- history

struct Named {
  // Index (in the record's block list) of mesh_u8, mesh_f32 and mm_f32, -1 when absent.
  int u8 = -1, f32 = -1, mm = -1;
};

Named named_blocks(const Meta &meta, std::size_t block_count) {
  Named out;
  if (meta.blocks.kind != JValue::Kind::Arr) {
    return out;
  }
  for (std::size_t k = 0; k < meta.blocks.a.size() && k < block_count; ++k) {
    const JValue &name = at(meta.blocks.a[k], "name");
    if (name.kind != JValue::Kind::Str) {
      continue;
    }
    const int idx = static_cast<int>(k);
    if (name.s == "mesh_u8") {
      out.u8 = idx;
    } else if (name.s == "mesh_f32") {
      out.f32 = idx;
    } else if (name.s == "mm_f32") {
      out.mm = idx;
    }
  }
  return out;
}

Span block_or_empty(const std::vector<Span> &blocks, int idx) {
  return idx < 0 ? Span{} : blocks[static_cast<std::size_t>(idx)];
}

// make_golden.py advance(): R(T) from `r` (R(T-1), or empty for a full) and T's /12 blocks.
void advance(PredictState *r, const Meta &meta, const Span &u8, const Span &mf, const Span &mm) {
  std::map<std::int64_t, MeshBodies> bodies;
  std::vector<EntryLayout> layout;
  if (u8_layout(meta, u8.n, &layout)) {
    for (const EntryLayout &e : layout) {
      MeshBodies mb;
      mb.shape = e.shape;
      for (const SurfaceLayout &s : e.surfaces) {
        mb.surfaces.push_back(std::make_shared<const std::vector<std::uint8_t>>(
            u8.p + s.offset, u8.p + s.offset + s.parts.total));
      }
      bodies[e.id] = std::move(mb);
    }
  }
  if (meta.meshes.kind == JValue::Kind::Arr) {
    for (const JValue &e : meta.meshes.a) {
      std::int64_t mid = 0;
      if (e.kind != JValue::Kind::Obj || !at(e, "id").as_int(&mid)) {
        continue;
      }
      if (is_dynamic(e)) {
        if (!at(e, "u8").is_null()) {
          const auto it = bodies.find(mid);
          if (it != bodies.end()) {
            r->body[mid] = it->second;
          } else {
            r->body.erase(mid);
          }
        }
      } else {
        r->body.erase(mid);
      }
      std::int64_t f = 0;
      if (at(e, "f").as_int(&f) && f >= 0 && static_cast<std::size_t>(4 * f + 24) <= mf.n) {
        std::array<std::uint8_t, 24> a{};
        std::memcpy(a.data(), mf.p + 4 * f, 24);
        r->aabb[mid] = a;
      } else {
        r->aabb.erase(mid);
      }
    }
  }
  if (meta.removed_meshes.kind == JValue::Kind::Arr) {
    for (const JValue &v : meta.removed_meshes.a) {
      std::int64_t mid = 0;
      if (v.as_int(&mid)) {
        r->body.erase(mid);
        r->aabb.erase(mid);
      }
    }
  }
  if (meta.multimeshes.kind == JValue::Kind::Arr) {
    for (const JValue &e : meta.multimeshes.a) {
      std::int64_t mmid = 0;
      if (e.kind != JValue::Kind::Obj || !at(e, "id").as_int(&mmid)) {
        continue;
      }
      const JValue &status = at(e, "status");
      if (status.kind != JValue::Kind::Str || status.s != "ok") {
        r->mm.erase(mmid);
        continue;
      }
      const JValue &buf = at(e, "buffer_f");
      if (buf.is_null()) {
        continue;
      }
      std::int64_t o = 0, instances = 0;
      const std::int64_t stride = mm_stride(e);
      if (buf.as_int(&o) && at(e, "instances").as_int(&instances) && o >= 0 && instances >= 0 &&
          static_cast<std::size_t>(4 * o + 4 * instances * stride) <= mm.n) {
        MultimeshBuffer b;
        b.instances = instances;
        b.stride = stride;
        b.bytes = std::make_shared<const std::vector<std::uint8_t>>(
            mm.p + 4 * o, mm.p + 4 * o + 4 * instances * stride);
        r->mm[mmid] = std::move(b);
      } else {
        r->mm.erase(mmid);
      }
    }
  }
  if (meta.removed_multimeshes.kind == JValue::Kind::Arr) {
    for (const JValue &v : meta.removed_multimeshes.a) {
      std::int64_t mmid = 0;
      if (v.as_int(&mmid)) {
        r->mm.erase(mmid);
      }
    }
  }
}

// make_golden.py _body_refs() / _aabb_refs() / _mm_refs(): (base, prev) bytes or nullptr.
std::pair<const MeshBodies *, const MeshBodies *> body_refs(const PredictState &h1,
                                                            const PredictState &h2,
                                                            std::int64_t mid,
                                                            const std::vector<SurfaceShape> &shape) {
  const auto b = h1.body.find(mid);
  if (b == h1.body.end() || b->second.shape != shape) {
    return {nullptr, nullptr};
  }
  const auto p = h2.body.find(mid);
  if (p == h2.body.end() || p->second.shape != shape) {
    return {&b->second, nullptr};
  }
  return {&b->second, &p->second};
}

std::pair<const std::uint8_t *, const std::uint8_t *> aabb_refs(const PredictState &h1,
                                                                const PredictState &h2,
                                                                std::int64_t mid) {
  const auto b = h1.aabb.find(mid);
  if (b == h1.aabb.end()) {
    return {nullptr, nullptr};
  }
  const auto p = h2.aabb.find(mid);
  return {b->second.data(), p == h2.aabb.end() ? nullptr : p->second.data()};
}

std::pair<const std::uint8_t *, const std::uint8_t *> mm_refs(const PredictState &h1,
                                                              const PredictState &h2,
                                                              const MmLayout &l) {
  const auto b = h1.mm.find(l.id);
  if (b == h1.mm.end() || b->second.instances != l.instances || b->second.stride != l.stride) {
    return {nullptr, nullptr};
  }
  const auto p = h2.mm.find(l.id);
  if (p == h2.mm.end() || p->second.instances != l.instances || p->second.stride != l.stride) {
    return {b->second.bytes->data(), nullptr};
  }
  return {b->second.bytes->data(), p->second.bytes->data()};
}

int order_of(const void *base, const void *prev) {
  return base == nullptr ? 0 : prev == nullptr ? 1 : 2;
}

// make_golden.py code_blocks(): predict (/12 -> /13) or un-predict (/13 -> /12) the three
// blocks. A block whose layout fails, or that is absent, keeps its input bytes (out empty).
struct Coded {
  std::vector<std::uint8_t> u8, f32, mm;
  bool has_u8 = false, has_f32 = false, has_mm = false;
};

void code_blocks(const Meta &meta, const Span &u8, bool u8_present, const Span &mf,
                 bool mf_present, const Span &mm, bool mm_present, const PredictState &h1,
                 const PredictState &h2, bool inverse, Coded *out, std::vector<Unit> *trace) {
  // mesh_u8
  std::vector<EntryLayout> layout;
  if (u8_present && u8_layout(meta, u8.n, &layout)) {
    out->has_u8 = true;
    std::array<std::size_t, 6> totals{};
    for (const EntryLayout &e : layout) {
      for (const SurfaceLayout &s : e.surfaces) {
        for (std::size_t i = 0; i < 6; ++i) {
          totals[i] += s.parts.size[i];
        }
      }
    }
    if (!inverse) {
      Parts streams;
      for (std::size_t i = 0; i < 6; ++i) {
        streams[i].reserve(totals[i]);
      }
      for (const EntryLayout &e : layout) {
        const auto refs = body_refs(h1, h2, e.id, e.shape);
        for (std::size_t k = 0; k < e.surfaces.size(); ++k) {
          const SurfaceLayout &s = e.surfaces[k];
          Parts cur = split_body(u8.p + s.offset, s.parts);
          Parts bp, pp;
          if (refs.first != nullptr) {
            bp = split_body(refs.first->surfaces[k]->data(), s.parts);
          }
          if (refs.second != nullptr) {
            pp = split_body(refs.second->surfaces[k]->data(), s.parts);
          }
          for (std::size_t i = 0; i < 6; ++i) {
            const std::uint8_t *b = refs.first != nullptr ? bp[i].data() : nullptr;
            if (is_word_stream(i)) {
              code_words(cur[i].data(), cur[i].size(), b,
                         refs.second != nullptr ? pp[i].data() : nullptr, false);
            } else {
              xor_bytes(cur[i].data(), cur[i].size(), b);
            }
            streams[i].insert(streams[i].end(), cur[i].begin(), cur[i].end());
          }
        }
        if (trace != nullptr && !e.surfaces.empty()) {
          trace->push_back(Unit{UnitBlock::MeshU8, e.id, order_of(refs.first, refs.second)});
        }
      }
      out->u8.resize(u8.n);
      std::size_t p = 0;
      for (std::size_t i = 0; i < 6; ++i) {
        if (is_word_stream(i)) {
          transpose4(streams[i].data(), streams[i].size(), out->u8.data() + p);
        } else if (!streams[i].empty()) {
          std::memcpy(out->u8.data() + p, streams[i].data(), streams[i].size());
        }
        p += streams[i].size();
      }
    } else {
      Parts streams;
      std::size_t p = 0;
      for (std::size_t i = 0; i < 6; ++i) {
        streams[i].resize(totals[i]);
        if (is_word_stream(i)) {
          untranspose4(u8.p + p, totals[i], streams[i].data());
        } else if (totals[i] != 0) {
          std::memcpy(streams[i].data(), u8.p + p, totals[i]);
        }
        p += totals[i];
      }
      std::array<std::size_t, 6> at_{};
      out->u8.reserve(u8.n);
      for (const EntryLayout &e : layout) {
        const auto refs = body_refs(h1, h2, e.id, e.shape);
        for (std::size_t k = 0; k < e.surfaces.size(); ++k) {
          const SurfaceLayout &s = e.surfaces[k];
          Parts bp, pp, parts;
          if (refs.first != nullptr) {
            bp = split_body(refs.first->surfaces[k]->data(), s.parts);
          }
          if (refs.second != nullptr) {
            pp = split_body(refs.second->surfaces[k]->data(), s.parts);
          }
          for (std::size_t i = 0; i < 6; ++i) {
            const std::size_t n = s.parts.size[i];
            parts[i].assign(streams[i].begin() + static_cast<long>(at_[i]),
                            streams[i].begin() + static_cast<long>(at_[i] + n));
            at_[i] += n;
            const std::uint8_t *b = refs.first != nullptr ? bp[i].data() : nullptr;
            if (is_word_stream(i)) {
              code_words(parts[i].data(), n, b, refs.second != nullptr ? pp[i].data() : nullptr,
                         true);
            } else {
              xor_bytes(parts[i].data(), n, b);
            }
          }
          join_body(parts, s.parts, &out->u8);
        }
        if (trace != nullptr && !e.surfaces.empty()) {
          trace->push_back(Unit{UnitBlock::MeshU8, e.id, order_of(refs.first, refs.second)});
        }
      }
    }
  }
  // mesh_f32
  std::vector<std::pair<std::int64_t, std::size_t>> fl;
  if (mf_present && mf.n % 4 == 0 && f32_layout(meta, mf.n / 4, &fl)) {
    out->has_f32 = true;
    std::vector<std::uint8_t> buf(mf.n);
    if (inverse) {
      untranspose4(mf.p, mf.n, buf.data());
    } else if (mf.n != 0) {
      std::memcpy(buf.data(), mf.p, mf.n);
    }
    for (const auto &[mid, off] : fl) {
      const auto refs = aabb_refs(h1, h2, mid);
      code_words(buf.data() + 4 * off, 24, refs.first, refs.second, inverse);
      if (trace != nullptr) {
        trace->push_back(Unit{UnitBlock::MeshF32, mid, order_of(refs.first, refs.second)});
      }
    }
    if (inverse) {
      out->f32 = std::move(buf);
    } else {
      out->f32.resize(mf.n);
      transpose4(buf.data(), buf.size(), out->f32.data());
    }
  }
  // mm_f32
  std::vector<MmLayout> ml;
  if (mm_present && mm.n % 4 == 0 && mm_layout(meta, mm.n / 4, &ml)) {
    out->has_mm = true;
    std::vector<std::uint8_t> buf(mm.n);
    if (inverse) {
      untranspose4(mm.p, mm.n, buf.data());
    } else if (mm.n != 0) {
      std::memcpy(buf.data(), mm.p, mm.n);
    }
    for (const MmLayout &l : ml) {
      const auto refs = mm_refs(h1, h2, l);
      code_words(buf.data() + 4 * l.offset, static_cast<std::size_t>(4 * l.instances * l.stride),
                 refs.first, refs.second, inverse);
      if (trace != nullptr) {
        trace->push_back(Unit{UnitBlock::MmF32, l.id, order_of(refs.first, refs.second)});
      }
    }
    if (inverse) {
      out->mm = std::move(buf);
    } else {
      out->mm.resize(mm.n);
      transpose4(buf.data(), buf.size(), out->mm.data());
    }
  }
}

// make_golden.py check_hex() over the /12 blocks: mesh_f32 || mesh_u8 || mm_f32.
std::uint64_t check_of(const Span &mf, const Span &u8, const Span &mm) {
  std::vector<std::uint8_t> all;
  all.reserve(mf.n + u8.n + mm.n);
  all.insert(all.end(), mf.p, mf.p + mf.n);
  all.insert(all.end(), u8.p, u8.p + u8.n);
  all.insert(all.end(), mm.p, mm.p + mm.n);
  return xxh64(all.data(), all.size());
}

Span span_of(const std::vector<std::uint8_t> &v) { return Span{v.data(), v.size()}; }

}  // namespace

std::uint64_t xxh64(const std::uint8_t *data, std::size_t size) {
  return static_cast<std::uint64_t>(XXH64(data, size, 0));
}

std::string check_hex(std::uint64_t hash) {
  static const char kHex[] = "0123456789abcdef";
  std::string out(16, '0');
  for (int k = 15; k >= 0; --k) {
    out[static_cast<std::size_t>(k)] = kHex[hash & 0xF];
    hash >>= 4;
  }
  return out;
}

const char *to_wire(UnitBlock block) {
  switch (block) {
  case UnitBlock::MeshU8: return "mesh_u8";
  case UnitBlock::MeshF32: return "mesh_f32";
  case UnitBlock::MmF32: return "mm_f32";
  }
  return "mesh_u8";
}

const char *to_wire(Status status) {
  switch (status) {
  case Status::Ok: return "ok";
  case Status::NotTransaction: return "not-transaction";
  case Status::Framing: return "record-length";
  case Status::MetaJson: return "meta-json";
  case Status::MetaSchema: return "meta-schema";
  case Status::PredictCheck: return "predict-check";
  }
  return "ok";
}

std::shared_ptr<const PredictState> Predictor::empty_state() {
  static const std::shared_ptr<const PredictState> kEmpty = std::make_shared<PredictState>();
  return kEmpty;
}

void Predictor::reset() {
  h1_ = empty_state();
  h2_ = empty_state();
}

Status Predictor::encode(const std::uint8_t *record12, std::size_t size,
                         std::vector<std::uint8_t> *out, std::vector<Unit> *trace) {
  return code(record12, size, false, out, trace);
}

Status Predictor::decode(const std::uint8_t *record13, std::size_t size,
                         std::vector<std::uint8_t> *out, std::vector<Unit> *trace) {
  return code(record13, size, true, out, trace);
}

Status Predictor::code(const std::uint8_t *record, std::size_t size, bool inverse,
                       std::vector<std::uint8_t> *out, std::vector<Unit> *trace) {
  Span meta_span;
  std::vector<Span> blocks;
  if (!parse_record(record, size, &meta_span, &blocks)) {
    return Status::Framing;
  }
  Meta meta;
  const MetaParse parsed = parse_meta(meta_span.p, meta_span.n, &meta);
  if (parsed == MetaParse::Json) {
    return Status::MetaJson;
  }
  if (parsed == MetaParse::NotObject) {
    return Status::MetaSchema;
  }
  if (!meta.has_type || meta.type != "transaction") {
    return Status::NotTransaction;
  }
  const std::string_view meta_text(reinterpret_cast<const char *>(meta_span.p), meta_span.n);
  std::string plain;
  std::string check;
  if (inverse) {
    if (!without_check(meta_text, &plain, &check)) {
      return Status::MetaSchema;
    }
    for (char c : check) {
      if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) {
        return Status::MetaSchema;
      }
    }
  } else if (meta_text.rfind(kBlocksMark) == std::string_view::npos) {
    return Status::MetaSchema;
  }

  // History::refs(): a full predicts nothing (unless no-predict-reset at the reader);
  // predict-stale (writer) predicts every patch from H2, first order.
  const bool full = meta.full && !(inverse && no_reset);
  const PredictState &empty = *empty_state();
  const PredictState *h1 = h1_.get();
  const PredictState *h2 = h2_.get();
  if (full) {
    h1 = &empty;
    h2 = &empty;
  } else if (!inverse && predict_stale) {
    h1 = h2_.get();
    h2 = &empty;
  }

  const Named named = named_blocks(meta, blocks.size());
  const Span u8 = block_or_empty(blocks, named.u8);
  const Span mf = block_or_empty(blocks, named.f32);
  const Span mm = block_or_empty(blocks, named.mm);
  Coded coded;
  std::vector<Unit> units;
  code_blocks(meta, u8, named.u8 >= 0, mf, named.f32 >= 0, mm, named.mm >= 0, *h1, *h2, inverse,
              &coded, trace != nullptr ? &units : nullptr);
  // The /12 blocks: the input (writer) or the reconstruction (reader).
  const Span u8_12 = inverse && coded.has_u8 ? span_of(coded.u8) : u8;
  const Span mf_12 = inverse && coded.has_f32 ? span_of(coded.f32) : mf;
  const Span mm_12 = inverse && coded.has_mm ? span_of(coded.mm) : mm;
  const std::uint64_t hash = check_of(mf_12, u8_12, mm_12);
  std::string meta_out;
  if (inverse) {
    if (check_hex(hash) != check) {
      return Status::PredictCheck;
    }
    meta_out = std::move(plain);
  } else {
    with_check(meta_text, check_hex(hash), &meta_out);
  }

  // _rebuild_blocks(): every descriptor named like a coded block carries the coded bytes.
  std::vector<Span> rebuilt = blocks;
  for (std::size_t k = 0; k < rebuilt.size() && meta.blocks.kind == JValue::Kind::Arr &&
                          k < meta.blocks.a.size();
       ++k) {
    const JValue &name = at(meta.blocks.a[k], "name");
    if (name.kind != JValue::Kind::Str) {
      continue;
    }
    if (name.s == "mesh_u8" && coded.has_u8) {
      rebuilt[k] = span_of(coded.u8);
    } else if (name.s == "mesh_f32" && coded.has_f32) {
      rebuilt[k] = span_of(coded.f32);
    } else if (name.s == "mm_f32" && coded.has_mm) {
      rebuilt[k] = span_of(coded.mm);
    }
  }
  std::vector<std::uint8_t> record_out;
  make_record(meta_out, rebuilt, &record_out);

  // History::accept() from the /12 blocks.
  auto next = std::make_shared<PredictState>(full ? PredictState() : *h1_);
  advance(next.get(), meta, u8_12, mf_12, mm_12);
  h2_ = full ? empty_state() : h1_;
  h1_ = std::move(next);

  *out = std::move(record_out);
  if (trace != nullptr) {
    *trace = std::move(units);
  }
  return Status::Ok;
}

std::vector<std::uint8_t> encode_transaction(const rs2::Transaction &transaction,
                                             Predictor *predictor) {
  const std::vector<std::uint8_t> plain = rs2::encode_transaction(transaction);
  std::vector<std::uint8_t> out;
  if (predictor->encode(plain, &out) != Status::Ok) {
    return plain;  // unreachable for an encoder-written transaction
  }
  return out;
}

}  // namespace rs13
}  // namespace grc
