// render-stream/13's predicted blocks (rs13_predict.h). Every function mirrors the one of the
// same name in protocol/golden-13/make_golden.py; read the two side by side.
#include "rs13_predict.h"

#include <algorithm>
#include <charconv>
#include <cstdio>

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
      // W13b: from_chars (no allocation, no locale); the same values as strtod/strtoll.
      out->kind = JValue::Kind::Num;
      out->is_int = false;
      if (integer && p_ - start <= 18) {  // fits int64 without overflow checks
        out->is_int = true;
        std::from_chars(start, p_, out->i);
        out->d = out->i == 0 && *start == '-' ? -0.0 : static_cast<double>(out->i);
      } else {
        std::from_chars(start, p_, out->d);
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

  // W13b: skips one value without validating it -- for the writer, whose input is the meta
  // encode_transaction just wrote (canonical JSON). Strings by memchr; containers by depth.
  bool skip_trusted() {
    ws();
    if (p_ >= end_) {
      return false;
    }
    const char c = *p_;
    if (c == '"') {
      return skip_string_trusted();
    }
    if (c == '{' || c == '[') {
      int depth = 0;
      while (p_ < end_) {
        const char ch = *p_;
        if (ch == '"') {
          if (!skip_string_trusted()) {
            return false;
          }
          continue;
        }
        if (ch == '{' || ch == '[') {
          ++depth;
        } else if ((ch == '}' || ch == ']') && --depth == 0) {
          ++p_;
          return true;
        }
        ++p_;
      }
      return false;
    }
    while (p_ < end_ && *p_ != ',' && *p_ != '}' && *p_ != ']' && *p_ != ' ' && *p_ != '\n' &&
           *p_ != '\t' && *p_ != '\r') {
      ++p_;
    }
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
  bool skip_string_trusted() {
    const char *const start = ++p_;  // past the opening quote
    for (;;) {
      const void *q = std::memchr(p_, '"', static_cast<std::size_t>(end_ - p_));
      if (q == nullptr) {
        return false;
      }
      const char *quote = static_cast<const char *>(q);
      std::size_t backslashes = 0;
      for (const char *b = quote; b > start && b[-1] == '\\'; --b) {
        ++backslashes;
      }
      p_ = quote + 1;
      if (backslashes % 2 == 0) {
        return true;
      }
    }
  }

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

// `trusted` (the writer): the keys the predictor does not read are skipped unvalidated.
MetaParse parse_meta(const std::uint8_t *data, std::size_t size, Meta *meta, bool trusted) {
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
      if (target == nullptr && trusted ? !r.skip_trusted() : !r.value(target)) {
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

// W13p: the JSON meta as the typed PredictMeta (the reader, and encode() of a bare record).
MetaNum num_of(const JValue &v) {
  MetaNum n;
  switch (v.kind) {
  case JValue::Kind::Null: break;
  case JValue::Kind::Bool:
    n.kind = MetaNum::Kind::Int;
    n.i = v.b ? 1 : 0;
    break;
  case JValue::Kind::Num:
    if (v.is_int) {
      n.kind = MetaNum::Kind::Int;
      n.i = v.i;
    } else {
      n.kind = MetaNum::Kind::Float;
      n.d = v.d;
    }
    break;
  default: n.kind = MetaNum::Kind::Other; break;
  }
  return n;
}

MetaList list_of(const JValue &v) {
  return v.kind == JValue::Kind::Arr    ? MetaList::Array
         : v.kind == JValue::Kind::Null ? MetaList::Missing
                                        : MetaList::Other;
}

bool is_ok(const JValue &status) {
  return status.kind == JValue::Kind::Str && status.s == "ok";
}

void to_typed(const Meta &meta, PredictMeta *out) {
  out->clear();
  out->transaction = meta.has_type && meta.type == "transaction";
  out->full = meta.full;
  out->meshes_list = list_of(meta.meshes);
  for (const JValue &e : meta.meshes.a) {
    MetaMesh m;
    m.object = e.kind == JValue::Kind::Obj;
    if (m.object) {
      m.id = num_of(at(e, "id"));
      m.status_ok = is_ok(at(e, "status"));
      m.f = num_of(at(e, "f"));
      m.u8 = num_of(at(e, "u8"));
      const JValue &surfaces = at(e, "surfaces");
      m.surfaces_array = surfaces.kind == JValue::Kind::Arr;
      m.first_surface = out->surfaces.size();
      for (const JValue &s : surfaces.a) {
        MetaSurface ms;
        ms.object = s.kind == JValue::Kind::Obj;
        ms.hash_null = at(s, "hash").is_null();
        if (ms.object) {
          const JValue &prim = at(s, "primitive");
          ms.primitive_string = prim.kind == JValue::Kind::Str;
          ms.primitive = ms.primitive_string ? prim.s : std::string();
          ms.payload_bytes = num_of(at(s, "payload_bytes"));
          ms.format = num_of(at(s, "format"));
          ms.vertex_count = num_of(at(s, "vertex_count"));
          ms.index_count = num_of(at(s, "index_count"));
        } else {
          ms.primitive_string = false;
        }
        out->surfaces.push_back(std::move(ms));
      }
      m.surface_count = out->surfaces.size() - m.first_surface;
    } else {
      m.surfaces_array = false;
      m.first_surface = out->surfaces.size();
    }
    out->meshes.push_back(m);
  }
  if (meta.removed_meshes.kind == JValue::Kind::Arr) {
    for (const JValue &v : meta.removed_meshes.a) {
      out->removed_meshes.push_back(num_of(v));
    }
  }
  out->multimeshes_list = list_of(meta.multimeshes);
  for (const JValue &e : meta.multimeshes.a) {
    MetaMultimesh m;
    m.object = e.kind == JValue::Kind::Obj;
    if (m.object) {
      m.id = num_of(at(e, "id"));
      m.status_ok = is_ok(at(e, "status"));
      m.colors = at(e, "colors").truthy();
      m.custom = at(e, "custom").truthy();
      m.aabb_f = num_of(at(e, "aabb_f"));
      m.buffer_f = num_of(at(e, "buffer_f"));
      m.instances = num_of(at(e, "instances"));
    }
    out->multimeshes.push_back(m);
  }
  if (meta.removed_multimeshes.kind == JValue::Kind::Arr) {
    for (const JValue &v : meta.removed_multimeshes.a) {
      out->removed_multimeshes.push_back(num_of(v));
    }
  }
  if (meta.blocks.kind == JValue::Kind::Arr) {
    for (const JValue &b : meta.blocks.a) {
      const JValue &name = at(b, "name");
      BlockName n = BlockName::Other;
      if (name.kind == JValue::Kind::Str) {
        n = name.s == "mesh_u8"    ? BlockName::MeshU8
            : name.s == "mesh_f32" ? BlockName::MeshF32
            : name.s == "mm_f32"   ? BlockName::MmF32
                                   : BlockName::Other;
      }
      out->blocks.push_back(n);
    }
  }
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

// make_golden.py's residual for one word at `off` of a unit of order Order (0 raw, 1 first, 2
// second): `base`/`prev` are H1's and H2's bytes of the same unit (unused below their order).
#if defined(__GNUC__)
#define GRC_RS13_INLINE inline __attribute__((always_inline))
#else
#define GRC_RS13_INLINE inline
#endif

template <int Order>
GRC_RS13_INLINE std::uint32_t residual(std::uint32_t v, const std::uint8_t *base, const std::uint8_t *prev,
                       std::size_t off) {
  if constexpr (Order == 0) {
    return v;
  } else {
    const std::uint32_t b = ordered(word_at(base + off));
    const std::uint32_t pred = Order == 1 ? b : 2u * b - ordered(word_at(prev + off));
    return zz32(ordered(v) - pred);
  }
}
template <int Order>
GRC_RS13_INLINE std::uint32_t unresidual(std::uint32_t r, const std::uint8_t *base, const std::uint8_t *prev,
                         std::size_t off) {
  if constexpr (Order == 0) {
    return r;
  } else {
    const std::uint32_t b = ordered(word_at(base + off));
    const std::uint32_t pred = Order == 1 ? b : 2u * b - ordered(word_at(prev + off));
    return unordered(unzz32(r) + pred);
  }
}

// make_golden.py unpredict_words(), in place over n bytes (a multiple of 4).
void unpredict_words(std::uint8_t *buf, std::size_t n, const std::uint8_t *base,
                     const std::uint8_t *prev) {
  if (base == nullptr) {
    return;
  }
  if (prev == nullptr) {
    for (std::size_t k = 0; k + 4 <= n; k += 4) {
      set_word(buf + k, unresidual<1>(word_at(buf + k), base, prev, k));
    }
  } else {
    for (std::size_t k = 0; k + 4 <= n; k += 4) {
      set_word(buf + k, unresidual<2>(word_at(buf + k), base, prev, k));
    }
  }
}

// make_golden.py predict_words() over n bytes of `in`, written transposed: word w (counted from
// the block's first word) into the block's planes `out` + j * nw + w.
template <int Order>
void predict_words_t(const std::uint8_t *in, std::size_t n, const std::uint8_t *base,
                     const std::uint8_t *prev, std::uint8_t *out, std::size_t nw, std::size_t w) {
  for (std::size_t k = 0; k + 4 <= n; k += 4, ++w) {
    const std::uint32_t r = residual<Order>(word_at(in + k), base, prev, k);
    out[w] = static_cast<std::uint8_t>(r);
    out[nw + w] = static_cast<std::uint8_t>(r >> 8);
    out[2 * nw + w] = static_cast<std::uint8_t>(r >> 16);
    out[3 * nw + w] = static_cast<std::uint8_t>(r >> 24);
  }
}

// Byte-plane transpose of n words: byte j of word k goes to j * n + k.
void transpose4(const std::uint8_t *in, std::size_t size, std::uint8_t *out) {
  const std::size_t n = size / 4;
  std::uint8_t *o0 = out, *o1 = out + n, *o2 = out + 2 * n, *o3 = out + 3 * n;
  for (std::size_t k = 0; k < n; ++k) {
    o0[k] = in[4 * k];
    o1[k] = in[4 * k + 1];
    o2[k] = in[4 * k + 2];
    o3[k] = in[4 * k + 3];
  }
}
void untranspose4(const std::uint8_t *in, std::size_t size, std::uint8_t *out) {
  const std::size_t n = size / 4;
  const std::uint8_t *i0 = in, *i1 = in + n, *i2 = in + 2 * n, *i3 = in + 3 * n;
  for (std::size_t k = 0; k < n; ++k) {
    out[4 * k] = i0[k];
    out[4 * k + 1] = i1[k];
    out[4 * k + 2] = i2[k];
    out[4 * k + 3] = i3[k];
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

bool body_parts(const MetaSurface &s, SurfaceShape *shape, BodyParts *out) {
  std::int64_t n = 0, fmt = 0, ic = 0;
  if (!s.object || !s.vertex_count.as_int(&n) || !s.format.as_int(&fmt) ||
      !s.index_count.as_int(&ic) || n < 0 || ic < 0 || n > (1 << 28) || ic > (1 << 28)) {
    return false;
  }
  if (!s.primitive_string) {
    return false;
  }
  shape->primitive = s.primitive;
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

// Visits one surface body in stream order (make_golden.py split_body()): `word(i, off)` for each
// word of the word streams (0 geometry, 1 positions, 3 UVs, de-interleaved from the attribute
// section) and `run(i, off, len)` for each byte run of the byte streams (2 colours, 4 skin, 5
// indices), `off` the byte offset in the body.
template <class Word, class Run>
void for_each_part(const BodyParts &bp, Word &&word, Run &&run) {
  for (std::size_t k = 0; k < 10; ++k) {
    word(std::size_t{0}, 4 * k);
  }
  const std::size_t n = static_cast<std::size_t>(bp.n);
  for (std::size_t k = 0; k < 2 * n; ++k) {
    word(std::size_t{1}, 40 + 4 * k);
  }
  const std::size_t col = static_cast<std::size_t>(bp.col);
  const std::size_t uv = static_cast<std::size_t>(bp.uv);
  const std::size_t stride = col + uv;
  const std::size_t attr = 40 + 8 * n;
  if (col != 0) {
    for (std::size_t v = 0; v < n; ++v) {
      run(std::size_t{2}, attr + v * stride, col);
    }
  }
  if (uv != 0) {
    for (std::size_t v = 0; v < n; ++v) {
      word(std::size_t{3}, attr + v * stride + col);
      word(std::size_t{3}, attr + v * stride + col + 4);
    }
  }
  const std::size_t tail = attr + n * stride;
  if (bp.size[4] != 0) {
    run(std::size_t{4}, tail, bp.size[4]);
  }
  if (bp.size[5] != 0) {
    run(std::size_t{5}, tail + bp.size[4], bp.size[5]);
  }
}

constexpr bool is_word_stream(std::size_t i) { return i == 0 || i == 1 || i == 3; }

// --------------------------------------------------------------------------- layouts

struct SurfaceLayout {
  BodyParts parts;
  SurfaceShape shape;
  std::size_t offset = 0;
};
struct EntryLayout {
  std::int64_t id = 0;
  std::size_t first = 0;  // into the surface layouts
  std::size_t count = 0;
};
struct U8Layout {
  std::vector<EntryLayout> entries;
  std::vector<SurfaceLayout> surfaces;
  std::size_t used = 0;  // surface layouts in use (the vector keeps its strings' storage)
  std::array<std::size_t, 6> totals{};
};

// make_golden.py u8_layout(): the carried bodies, or false when mesh_u8's offset rule fails.
bool u8_layout(const PredictMeta &meta, std::size_t u8_len, U8Layout *out) {
  out->entries.clear();
  out->used = 0;
  out->totals = {};
  if (meta.meshes_list == MetaList::Other) {
    return false;
  }
  std::int64_t run = 0;
  for (const MetaMesh &e : meta.meshes) {
    if (!e.object) {
      return false;
    }
    if (e.u8.is_null()) {
      continue;
    }
    if (!e.u8.equals_int(run)) {
      return false;
    }
    EntryLayout entry;
    if (!e.id.as_int(&entry.id) || !e.surfaces_array) {
      return false;
    }
    entry.first = out->used;
    for (std::size_t k = 0; k < e.surface_count; ++k) {
      const MetaSurface &s = meta.surfaces[e.first_surface + k];
      if (out->used == out->surfaces.size()) {
        out->surfaces.emplace_back();
      }
      SurfaceLayout &sl = out->surfaces[out->used];
      if (!body_parts(s, &sl.shape, &sl.parts) ||
          !s.payload_bytes.equals_int(static_cast<std::int64_t>(sl.parts.total))) {
        return false;
      }
      ++out->used;
      sl.offset = static_cast<std::size_t>(run);
      run += static_cast<std::int64_t>(sl.parts.total);
      for (std::size_t i = 0; i < 6; ++i) {
        out->totals[i] += sl.parts.size[i];
      }
    }
    entry.count = out->used - entry.first;
    out->entries.push_back(entry);
  }
  return run == static_cast<std::int64_t>(u8_len);
}

// make_golden.py f32_layout(): (mesh id, float offset) of the AABB units.
bool f32_layout(const PredictMeta &meta, std::size_t n_floats,
                std::vector<std::pair<std::int64_t, std::size_t>> *out) {
  out->clear();
  if (meta.meshes_list == MetaList::Other) {
    return false;
  }
  std::int64_t run = 0;
  for (const MetaMesh &e : meta.meshes) {
    if (!e.object) {
      return false;
    }
    if (e.f.is_null()) {
      continue;
    }
    std::int64_t id = 0;
    if (!e.f.equals_int(run) || !e.id.as_int(&id)) {
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

std::int64_t mm_stride(const MetaMultimesh &e) {
  return 8 + 4 * (e.colors ? 1 : 0) + 4 * (e.custom ? 1 : 0);
}

// make_golden.py mm_layout(): the buffer units.
bool mm_layout(const PredictMeta &meta, std::size_t n_floats, std::vector<MmLayout> *out) {
  out->clear();
  if (meta.multimeshes_list == MetaList::Other) {
    return false;
  }
  std::int64_t run = 0;
  for (const MetaMultimesh &e : meta.multimeshes) {
    if (!e.object) {
      return false;
    }
    if (!e.aabb_f.is_null()) {
      if (!e.aabb_f.equals_int(run)) {
        return false;
      }
      run += 6;
    }
    if (!e.buffer_f.is_null()) {
      MmLayout l;
      if (!e.buffer_f.equals_int(run) || !e.id.as_int(&l.id) ||
          !e.instances.as_int(&l.instances) || l.instances < 0 || l.instances > (1 << 26)) {
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

bool is_dynamic(const PredictMeta &meta, const MetaMesh &e) {
  if (!e.status_ok || !e.surfaces_array || e.surface_count == 0) {
    return false;
  }
  for (std::size_t k = 0; k < e.surface_count; ++k) {
    if (!meta.surfaces[e.first_surface + k].hash_null) {
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

Named named_blocks(const PredictMeta &meta, std::size_t block_count) {
  Named out;
  for (std::size_t k = 0; k < meta.blocks.size() && k < block_count; ++k) {
    const int idx = static_cast<int>(k);
    switch (meta.blocks[k]) {
    case BlockName::MeshU8: out.u8 = idx; break;
    case BlockName::MeshF32: out.f32 = idx; break;
    case BlockName::MmF32: out.mm = idx; break;
    case BlockName::Other: break;
    }
  }
  return out;
}

BlockName name_at(const PredictMeta &meta, std::size_t k) {
  return k < meta.blocks.size() ? meta.blocks[k] : BlockName::Other;
}

Span block_or_empty(const std::vector<Span> &blocks, int idx) {
  return idx < 0 ? Span{} : blocks[static_cast<std::size_t>(idx)];
}

bool same_shape(const MeshBodies &b, const U8Layout &l, const EntryLayout &e) {
  if (b.shape.size() != e.count) {
    return false;
  }
  for (std::size_t k = 0; k < e.count; ++k) {
    if (b.shape[k] != l.surfaces[e.first + k].shape) {
      return false;
    }
  }
  return true;
}

// make_golden.py _body_refs() / _aabb_refs() / _mm_refs(): (base, prev) or nullptr.
std::pair<const MeshBodies *, const MeshBodies *> body_refs(const PredictState &h1,
                                                            const PredictState &h2,
                                                            const U8Layout &l,
                                                            const EntryLayout &e) {
  const auto b = h1.body.find(e.id);
  if (b == h1.body.end() || !same_shape(b->second, l, e)) {
    return {nullptr, nullptr};
  }
  const auto p = h2.body.find(e.id);
  if (p == h2.body.end() || !same_shape(p->second, l, e)) {
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

// One surface of mesh_u8, either way, straight between the body (`body`: read when predicting,
// written when un-predicting) and the six streams (`streams`, the coded block: stream i starts at
// base[i]; a word stream of nw[i] words is byte-plane transposed). `cur` is each stream's running
// position (words for a word stream, bytes for a byte stream).
template <int Order, bool Inverse>
void code_surface(const BodyParts &bp, const std::uint8_t *in_body, std::uint8_t *out_body,
                  const std::uint8_t *in_streams, std::uint8_t *out_streams,
                  const std::uint8_t *base, const std::uint8_t *prev,
                  const std::array<std::size_t, 6> &start, const std::array<std::size_t, 6> &nw,
                  std::array<std::size_t, 6> &cur) {
  for_each_part(
      bp,
      [&](std::size_t i, std::size_t off) {
        const std::size_t w = cur[i]++;
        const std::size_t n = nw[i];
        if constexpr (Inverse) {
          const std::uint8_t *q = in_streams + start[i] + w;
          const std::uint32_t r = static_cast<std::uint32_t>(q[0]) |
                                  (static_cast<std::uint32_t>(q[n]) << 8) |
                                  (static_cast<std::uint32_t>(q[2 * n]) << 16) |
                                  (static_cast<std::uint32_t>(q[3 * n]) << 24);
          set_word(out_body + off, unresidual<Order>(r, base, prev, off));
        } else {
          const std::uint32_t r = residual<Order>(word_at(in_body + off), base, prev, off);
          std::uint8_t *q = out_streams + start[i] + w;
          q[0] = static_cast<std::uint8_t>(r);
          q[n] = static_cast<std::uint8_t>(r >> 8);
          q[2 * n] = static_cast<std::uint8_t>(r >> 16);
          q[3 * n] = static_cast<std::uint8_t>(r >> 24);
        }
      },
      [&](std::size_t i, std::size_t off, std::size_t len) {
        const std::size_t at_ = start[i] + cur[i];
        cur[i] += len;
        const std::uint8_t *src = Inverse ? in_streams + at_ : in_body + off;
        std::uint8_t *dst = Inverse ? out_body + off : out_streams + at_;
        if constexpr (Order == 0) {
          std::memcpy(dst, src, len);
        } else {
          const std::uint8_t *b = base + off;
          for (std::size_t t = 0; t < len; ++t) {
            dst[t] = static_cast<std::uint8_t>(src[t] ^ b[t]);
          }
        }
      });
}

template <bool Inverse>
void code_surface_any(int order, const BodyParts &bp, const std::uint8_t *in_body,
                      std::uint8_t *out_body, const std::uint8_t *in_streams,
                      std::uint8_t *out_streams, const std::uint8_t *base,
                      const std::uint8_t *prev, const std::array<std::size_t, 6> &start,
                      const std::array<std::size_t, 6> &nw, std::array<std::size_t, 6> &cur) {
  switch (order) {
  case 0:
    code_surface<0, Inverse>(bp, in_body, out_body, in_streams, out_streams, base, prev, start,
                             nw, cur);
    break;
  case 1:
    code_surface<1, Inverse>(bp, in_body, out_body, in_streams, out_streams, base, prev, start,
                             nw, cur);
    break;
  default:
    code_surface<2, Inverse>(bp, in_body, out_body, in_streams, out_streams, base, prev, start,
                             nw, cur);
    break;
  }
}

// make_golden.py code_blocks() for mesh_u8: `in` (u8_len bytes) to `out` (the same length), the
// /12 bodies to the coded streams or back.
template <bool Inverse>
void code_u8(const U8Layout &layout, const std::uint8_t *in, std::uint8_t *out,
             const PredictState &h1, const PredictState &h2, std::vector<Unit> *trace) {
  std::array<std::size_t, 6> start{}, nw{}, cur{};
  std::size_t acc = 0;
  for (std::size_t i = 0; i < 6; ++i) {
    start[i] = acc;
    nw[i] = layout.totals[i] / 4;
    acc += layout.totals[i];
  }
  for (const EntryLayout &e : layout.entries) {
    const auto refs = body_refs(h1, h2, layout, e);
    const int order = order_of(refs.first, refs.second);
    for (std::size_t k = 0; k < e.count; ++k) {
      const SurfaceLayout &s = layout.surfaces[e.first + k];
      const std::uint8_t *base = refs.first != nullptr ? refs.first->surfaces[k]->data() : nullptr;
      const std::uint8_t *prev =
          refs.second != nullptr ? refs.second->surfaces[k]->data() : nullptr;
      if constexpr (Inverse) {
        code_surface_any<true>(order, s.parts, nullptr, out + s.offset, in, nullptr, base, prev,
                               start, nw, cur);
      } else {
        code_surface_any<false>(order, s.parts, in + s.offset, nullptr, nullptr, out, base, prev,
                                start, nw, cur);
      }
    }
    if (trace != nullptr && e.count != 0) {
      trace->push_back(Unit{UnitBlock::MeshU8, e.id, order});
    }
  }
}

// mesh_f32 / mm_f32 predicted: the raw words transposed, then each unit's residual words.
void predict_unit_t(const std::uint8_t *in, std::size_t bytes, const std::uint8_t *base,
                    const std::uint8_t *prev, std::uint8_t *out, std::size_t nw, std::size_t w) {
  if (base == nullptr) {
    return;  // raw: already transposed
  }
  if (prev == nullptr) {
    predict_words_t<1>(in, bytes, base, prev, out, nw, w);
  } else {
    predict_words_t<2>(in, bytes, base, prev, out, nw, w);
  }
}

// make_golden.py check_hex() over the /12 blocks: mesh_f32 || mesh_u8 || mm_f32.
std::uint64_t check_of(XXH64_state_t *state, const Span &mf, const Span &u8, const Span &mm) {
  XXH64_reset(state, 0);
  for (const Span *s : {&mf, &u8, &mm}) {
    if (s->n != 0) {
      XXH64_update(state, s->p, s->n);
    }
  }
  return static_cast<std::uint64_t>(XXH64_digest(state));
}

// W13p: byte vectors of a dropped state no one else holds, reused for the next state's units.
using BytesPool = std::vector<std::shared_ptr<std::vector<std::uint8_t>>>;
constexpr std::size_t kPoolMax = 8192;

SharedBytes take_bytes(BytesPool *pool, const std::uint8_t *p, std::size_t n) {
  if (!pool->empty()) {
    std::shared_ptr<std::vector<std::uint8_t>> v = std::move(pool->back());
    pool->pop_back();
    v->assign(p, p + n);
    return v;
  }
  return std::make_shared<const std::vector<std::uint8_t>>(p, p + n);
}

void give_bytes(BytesPool *pool, SharedBytes *bytes) {
  if (*bytes != nullptr && bytes->use_count() == 1 && pool->size() < kPoolMax) {
    pool->push_back(std::const_pointer_cast<std::vector<std::uint8_t>>(std::move(*bytes)));
  }
}

// make_golden.py advance(): R(T) from `r` (R(T-1), or empty for a full) and T's /12 blocks.
// `layout` is mesh_u8's (nullptr when its offset rule failed or the block is absent).
void advance(PredictState *r, const PredictMeta &meta, const U8Layout *layout, const Span &u8,
             const Span &mf, const Span &mm, BytesPool *pool) {
  // The layout's entries are the meshes entries with a non-null `u8`, in order; json.loads keeps
  // the last of duplicate ids (bodies[e.id] = ...), so look for a later one only when ids repeat.
  bool ascending = true;
  if (layout != nullptr) {
    for (std::size_t k = 1; k < layout->entries.size(); ++k) {
      ascending = ascending && layout->entries[k - 1].id < layout->entries[k].id;
    }
  }
  std::size_t cursor = 0;
  for (const MetaMesh &e : meta.meshes) {
    const EntryLayout *carried = nullptr;
    if (layout != nullptr && e.object && !e.u8.is_null()) {
      carried = &layout->entries[cursor++];
      if (!ascending) {
        for (std::size_t k = layout->entries.size(); k-- > 0;) {
          if (layout->entries[k].id == carried->id) {
            carried = &layout->entries[k];
            break;
          }
        }
      }
    }
    std::int64_t mid = 0;
    if (!e.object || !e.id.as_int(&mid)) {
      continue;
    }
    if (is_dynamic(meta, e)) {
      if (!e.u8.is_null()) {
        if (carried != nullptr) {
          MeshBodies &mb = r->body[mid];  // reuses the node's vectors (R(T-1)'s copy)
          mb.shape.resize(carried->count);
          mb.surfaces.resize(carried->count);
          for (std::size_t k = 0; k < carried->count; ++k) {
            const SurfaceLayout &s = layout->surfaces[carried->first + k];
            mb.shape[k] = s.shape;
            mb.surfaces[k] = take_bytes(pool, u8.p + s.offset, s.parts.total);
          }
        } else {
          r->body.erase(mid);
        }
      }
    } else {
      r->body.erase(mid);
    }
    std::int64_t f = 0;
    if (e.f.as_int(&f) && f >= 0 && static_cast<std::size_t>(4 * f + 24) <= mf.n) {
      std::array<std::uint8_t, 24> a{};
      std::memcpy(a.data(), mf.p + 4 * f, 24);
      r->aabb[mid] = a;
    } else {
      r->aabb.erase(mid);
    }
  }
  for (const MetaNum &v : meta.removed_meshes) {
    std::int64_t mid = 0;
    if (v.as_int(&mid)) {
      r->body.erase(mid);
      r->aabb.erase(mid);
    }
  }
  for (const MetaMultimesh &e : meta.multimeshes) {
    std::int64_t mmid = 0;
    if (!e.object || !e.id.as_int(&mmid)) {
      continue;
    }
    if (!e.status_ok) {
      r->mm.erase(mmid);
      continue;
    }
    if (e.buffer_f.is_null()) {
      continue;
    }
    std::int64_t o = 0, instances = 0;
    const std::int64_t stride = mm_stride(e);
    if (e.buffer_f.as_int(&o) && e.instances.as_int(&instances) && o >= 0 && instances >= 0 &&
        static_cast<std::size_t>(4 * o + 4 * instances * stride) <= mm.n) {
      MultimeshBuffer b;
      b.instances = instances;
      b.stride = stride;
      b.bytes = take_bytes(pool, mm.p + 4 * o,
                           static_cast<std::size_t>(4 * instances * stride));
      r->mm[mmid] = std::move(b);
    } else {
      r->mm.erase(mmid);
    }
  }
  for (const MetaNum &v : meta.removed_multimeshes) {
    std::int64_t mmid = 0;
    if (v.as_int(&mmid)) {
      r->mm.erase(mmid);
    }
  }
}

Span span_of(const std::vector<std::uint8_t> &v) { return Span{v.data(), v.size()}; }

bool verify_meta_flag = false;

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


// --------------------------------------------------------------------------- PredictMeta

void PredictMeta::clear() {
  transaction = false;
  full = false;
  meshes_list = MetaList::Missing;
  multimeshes_list = MetaList::Missing;
  meshes.clear();
  surfaces.clear();
  removed_meshes.clear();
  multimeshes.clear();
  removed_multimeshes.clear();
  blocks.clear();
}

bool PredictMeta::operator==(const PredictMeta &o) const {
  return transaction == o.transaction && full == o.full && meshes_list == o.meshes_list &&
         multimeshes_list == o.multimeshes_list && meshes == o.meshes && surfaces == o.surfaces &&
         removed_meshes == o.removed_meshes && multimeshes == o.multimeshes &&
         removed_multimeshes == o.removed_multimeshes && blocks == o.blocks;
}

void predict_meta(const rs2::Transaction &t, PredictMeta *out) {
  out->clear();
  out->transaction = true;
  out->full = t.encoding == rs2::Encoding::Full;
  // encode_transaction() at /11 and later: `meshes` and `removed_meshes` always; mesh_f32 and
  // mesh_u8 running offsets over the entries (append_mesh_entry()).
  out->meshes_list = MetaList::Array;
  std::int64_t f_run = 0;
  std::int64_t u8_run = 0;
  for (const rs2::MeshEntry &mesh : t.meshes) {
    MetaMesh m;
    m.status_ok = mesh.status == rs2::MeshStatus::Ok;
    m.id = MetaNum::of(static_cast<std::int64_t>(mesh.id));
    const bool dynamic = mesh.dynamic && m.status_ok;
    const bool held =
        std::binary_search(t.mesh_bodies_held.begin(), t.mesh_bodies_held.end(), mesh.id);
    if (mesh.has_aabb) {
      m.f = MetaNum::of(f_run);
      f_run += static_cast<std::int64_t>(mesh.custom_aabb.size());
    }
    if (dynamic && !held) {
      m.u8 = MetaNum::of(u8_run);
      for (const rs2::MeshSurface &s : mesh.surfaces) {
        if (s.body != nullptr) {
          u8_run += static_cast<std::int64_t>(s.body->size());
        }
      }
    }
    m.first_surface = out->surfaces.size();
    m.surface_count = mesh.surfaces.size();
    for (const rs2::MeshSurface &s : mesh.surfaces) {
      MetaSurface ms;
      ms.hash_null = dynamic;
      ms.primitive = rs2::to_wire(s.primitive);
      ms.payload_bytes = MetaNum::of(static_cast<std::int64_t>(
          dynamic && s.body != nullptr ? s.body->size() : s.payload_bytes));
      ms.format = MetaNum::of(s.format);
      ms.vertex_count = MetaNum::of(s.vertex_count);
      ms.index_count = MetaNum::of(s.index_count);
      out->surfaces.push_back(std::move(ms));
    }
    out->meshes.push_back(m);
  }
  for (std::uint32_t id : t.removed_meshes) {
    out->removed_meshes.push_back(MetaNum::of(id));
  }
  // `multimeshes` and `removed_multimeshes` only when non-empty; mm_f32 runs over the entries:
  // the custom AABB unless freed, then the buffer when it travels.
  if (!t.multimeshes.empty()) {
    out->multimeshes_list = MetaList::Array;
    std::int64_t run = 0;
    for (const rs2::MultimeshEntry &mm : t.multimeshes) {
      MetaMultimesh m;
      m.status_ok = mm.status == rs2::MultimeshStatus::Ok;
      m.id = MetaNum::of(static_cast<std::int64_t>(mm.id));
      m.colors = mm.colors;
      m.custom = mm.custom;
      m.instances = MetaNum::of(static_cast<std::int64_t>(mm.instances));
      if (mm.status != rs2::MultimeshStatus::Freed) {
        m.aabb_f = MetaNum::of(run);
        run += static_cast<std::int64_t>(mm.custom_aabb.size());
      }
      const bool held = m.status_ok && std::binary_search(t.multimesh_buffers_held.begin(),
                                                          t.multimesh_buffers_held.end(), mm.id);
      if (m.status_ok && !held) {
        m.buffer_f = MetaNum::of(run);
        if (mm.buffer != nullptr) {
          run += static_cast<std::int64_t>(mm.buffer->size());
        }
      }
      out->multimeshes.push_back(m);
    }
  }
  for (std::uint32_t id : t.removed_multimeshes) {
    out->removed_multimeshes.push_back(MetaNum::of(id));
  }
  // The /11 and /12 descriptors: item_f32, canvas_f32, cmd_f32, cmd_i32, mesh_f32, param_f64,
  // backbuffer_f32, mesh_u8, mm_f32 (then pt_f32 when present, a name the predictor ignores).
  out->blocks.assign(9, BlockName::Other);
  out->blocks[4] = BlockName::MeshF32;
  out->blocks[7] = BlockName::MeshU8;
  out->blocks[8] = BlockName::MmF32;
}

void set_verify_meta(bool on) { verify_meta_flag = on; }

// --------------------------------------------------------------------------- the predictor

struct Predictor::Scratch {
  Scratch() : xxh(XXH64_createState()) {}
  ~Scratch() { XXH64_freeState(xxh); }
  Scratch(const Scratch &) = delete;
  Scratch &operator=(const Scratch &) = delete;

  XXH64_state_t *xxh;
  std::vector<Span> blocks;
  PredictMeta meta;    // the reader's (and a bare record's) typed meta
  PredictMeta verify;  // set_verify_meta(): the JSON's
  U8Layout u8;
  bool u8_ok = false;
  std::vector<std::pair<std::int64_t, std::size_t>> f32;
  std::vector<MmLayout> mm;
  std::vector<std::uint8_t> dec_u8, dec_f32, dec_mm;  // the reader's reconstructed blocks
  std::vector<Span> rebuilt;
  BytesPool pool;
};

std::shared_ptr<const PredictState> Predictor::empty_state() {
  static const std::shared_ptr<const PredictState> kEmpty = std::make_shared<PredictState>();
  return kEmpty;
}

Predictor::Predictor() = default;
Predictor::~Predictor() = default;
Predictor::Predictor(const Predictor &other)
    : predict_stale(other.predict_stale), no_reset(other.no_reset), h1_(other.h1_),
      h2_(other.h2_) {}
Predictor &Predictor::operator=(const Predictor &other) {
  predict_stale = other.predict_stale;
  no_reset = other.no_reset;
  h1_ = other.h1_;
  h2_ = other.h2_;
  return *this;
}
Predictor::Predictor(Predictor &&other) noexcept = default;
Predictor &Predictor::operator=(Predictor &&other) noexcept = default;

Predictor::Scratch &Predictor::scratch() {
  if (scratch_ == nullptr) {
    scratch_ = std::make_unique<Scratch>();
  }
  return *scratch_;
}

void Predictor::reset() {
  h1_ = empty_state();
  h2_ = empty_state();
}

// W13p: R(T)'s storage, R(T-1)'s contents (nothing for a full). The state that drops out of the
// history (H2) is reused when this predictor is its only holder: its map nodes take R(T-1)'s
// copy, and its bytes no one else shares go to the pool for the units T carries.
std::shared_ptr<PredictState> Predictor::next_state(bool full) {
  const PredictState *empty = empty_state().get();
  if (h2_.get() != empty && h2_.use_count() == 1) {
    std::shared_ptr<PredictState> next = std::const_pointer_cast<PredictState>(std::move(h2_));
    h2_ = empty_state();
    BytesPool &pool = scratch().pool;
    for (auto &[id, mb] : next->body) {
      for (SharedBytes &b : mb.surfaces) {
        give_bytes(&pool, &b);
      }
    }
    for (auto &[id, buf] : next->mm) {
      give_bytes(&pool, &buf.bytes);
    }
    if (full) {
      next->body.clear();
      next->aabb.clear();
      next->mm.clear();
    } else {
      *next = *h1_;
    }
    return next;
  }
  return std::make_shared<PredictState>(full ? PredictState() : *h1_);
}

namespace {

// Parses a record's meta JSON into the typed meta, with the record's own status.
Status typed_meta(const Span &meta_span, bool trusted, PredictMeta *out) {
  Meta meta;
  const MetaParse parsed = parse_meta(meta_span.p, meta_span.n, &meta, trusted);
  if (parsed == MetaParse::Json) {
    return Status::MetaJson;
  }
  if (parsed == MetaParse::NotObject) {
    return Status::MetaSchema;
  }
  to_typed(meta, out);
  return out->transaction ? Status::Ok : Status::NotTransaction;
}

}  // namespace

Status record_meta(const std::uint8_t *record, std::size_t size, PredictMeta *out) {
  Span meta_span;
  std::vector<Span> blocks;
  if (!parse_record(record, size, &meta_span, &blocks)) {
    return Status::Framing;
  }
  return typed_meta(meta_span, false, out);
}

Status Predictor::encode(const std::uint8_t *record12, std::size_t size,
                         std::vector<std::uint8_t> *out, std::vector<Unit> *trace) {
  Scratch &sc = scratch();
  Span meta_span;
  if (!parse_record(record12, size, &meta_span, &sc.blocks)) {
    return Status::Framing;
  }
  const Status st = typed_meta(meta_span, true, &sc.meta);
  if (st != Status::Ok) {
    return st;
  }
  return encode_typed(sc.meta, record12, size, out, trace);
}

Status Predictor::encode(const PredictMeta &meta, const std::uint8_t *record12, std::size_t size,
                         std::vector<std::uint8_t> *out, std::vector<Unit> *trace) {
  Scratch &sc = scratch();
  Span meta_span;
  if (!parse_record(record12, size, &meta_span, &sc.blocks)) {
    return Status::Framing;
  }
  if (verify_meta_flag) {
    const Status st = typed_meta(meta_span, false, &sc.verify);
    if (st != Status::Ok || !(sc.verify == meta)) {
      std::fprintf(stderr, "rs13: predict_meta() disagrees with the record's meta JSON\n");
      std::abort();
    }
  }
  if (!meta.transaction) {
    return Status::NotTransaction;
  }
  return encode_typed(meta, record12, size, out, trace);
}

Status Predictor::encode(const rs2::Transaction &transaction,
                         const std::vector<std::uint8_t> &record12, std::vector<std::uint8_t> *out,
                         std::vector<Unit> *trace) {
  Scratch &sc = scratch();
  predict_meta(transaction, &sc.meta);
  PredictMeta meta = std::move(sc.meta);  // encode() reuses sc.meta for nothing else
  const Status st = encode(meta, record12.data(), record12.size(), out, trace);
  sc.meta = std::move(meta);
  return st;
}

// The writer: sc.blocks holds the record's blocks (parse_record()).
Status Predictor::encode_typed(const PredictMeta &meta, const std::uint8_t *record,
                               std::size_t /*size*/, std::vector<std::uint8_t> *out,
                               std::vector<Unit> *trace) {
  Scratch &sc = *scratch_;
  const std::string_view meta_text(reinterpret_cast<const char *>(record + 8), u32_at(record + 4));
  const std::size_t mark = meta_text.rfind(kBlocksMark);
  if (mark == std::string_view::npos) {
    return Status::MetaSchema;
  }
  // History::refs(): a full predicts nothing; predict-stale predicts every patch from H2, first
  // order.
  const bool full = meta.full;
  const PredictState &empty = *empty_state();
  const PredictState *h1 = h1_.get();
  const PredictState *h2 = h2_.get();
  if (full) {
    h1 = &empty;
    h2 = &empty;
  } else if (predict_stale) {
    h1 = h2_.get();
    h2 = &empty;
  }
  const std::vector<Span> &blocks = sc.blocks;
  const Named named = named_blocks(meta, blocks.size());
  const Span u8 = block_or_empty(blocks, named.u8);
  const Span mf = block_or_empty(blocks, named.f32);
  const Span mm = block_or_empty(blocks, named.mm);
  sc.u8_ok = named.u8 >= 0 && u8_layout(meta, u8.n, &sc.u8);
  const bool has_u8 = sc.u8_ok;
  const bool has_f32 = named.f32 >= 0 && mf.n % 4 == 0 && f32_layout(meta, mf.n / 4, &sc.f32);
  const bool has_mm = named.mm >= 0 && mm.n % 4 == 0 && mm_layout(meta, mm.n / 4, &sc.mm);
  const std::uint64_t hash = check_of(sc.xxh, mf, u8, mm);

  // The /13 record: the meta with `predict_check` before `,"blocks":[`, every block in place;
  // each descriptor named like a coded block carries the coded bytes (_rebuild_blocks()).
  auto coded_len = [&](std::size_t k) -> std::size_t {
    const BlockName n = name_at(meta, k);
    if (n == BlockName::MeshU8 && has_u8) {
      return u8.n;
    }
    if (n == BlockName::MeshF32 && has_f32) {
      return mf.n;
    }
    if (n == BlockName::MmF32 && has_mm) {
      return mm.n;
    }
    return blocks[k].n;
  };
  const std::size_t meta_len = meta_text.size() + kCheckKey.size() + 17;
  std::size_t body = 4 + meta_len + 4;
  for (std::size_t k = 0; k < blocks.size(); ++k) {
    body += 4 + coded_len(k);
  }
  out->resize(4 + body);
  std::uint8_t *w = out->data();
  auto put = [&](std::uint32_t v) {
    set_word(w, v);
    w += 4;
  };
  auto put_bytes = [&](const void *p, std::size_t n) {
    if (n != 0) {
      std::memcpy(w, p, n);
      w += n;
    }
  };
  put(static_cast<std::uint32_t>(body));
  put(static_cast<std::uint32_t>(meta_len));
  put_bytes(meta_text.data(), mark);
  put_bytes(kCheckKey.data(), kCheckKey.size());
  const std::string hex = check_hex(hash);
  put_bytes(hex.data(), 16);
  *w++ = '"';
  put_bytes(meta_text.data() + mark, meta_text.size() - mark);
  put(static_cast<std::uint32_t>(blocks.size()));
  std::uint8_t *coded_u8 = nullptr, *coded_f32 = nullptr, *coded_mm = nullptr;
  std::vector<std::pair<std::uint8_t *, BlockName>> copies;  // duplicate names: copy after
  for (std::size_t k = 0; k < blocks.size(); ++k) {
    const std::size_t n = coded_len(k);
    put(static_cast<std::uint32_t>(n));
    const BlockName name = name_at(meta, k);
    const int idx = static_cast<int>(k);
    if (name == BlockName::MeshU8 && has_u8) {
      if (idx == named.u8) {
        coded_u8 = w;
      } else {
        copies.emplace_back(w, name);
      }
    } else if (name == BlockName::MeshF32 && has_f32) {
      if (idx == named.f32) {
        coded_f32 = w;
      } else {
        copies.emplace_back(w, name);
      }
    } else if (name == BlockName::MmF32 && has_mm) {
      if (idx == named.mm) {
        coded_mm = w;
      } else {
        copies.emplace_back(w, name);
      }
    } else {
      put_bytes(blocks[k].p, n);
      continue;
    }
    w += n;
  }

  std::vector<Unit> units;
  std::vector<Unit> *tr = trace != nullptr ? &units : nullptr;
  if (has_u8) {
    code_u8<false>(sc.u8, u8.p, coded_u8, *h1, *h2, tr);
  }
  if (has_f32) {
    transpose4(mf.p, mf.n, coded_f32);
    for (const auto &[mid, off] : sc.f32) {
      const auto refs = aabb_refs(*h1, *h2, mid);
      predict_unit_t(mf.p + 4 * off, 24, refs.first, refs.second, coded_f32, mf.n / 4, off);
      if (tr != nullptr) {
        tr->push_back(Unit{UnitBlock::MeshF32, mid, order_of(refs.first, refs.second)});
      }
    }
  }
  if (has_mm) {
    transpose4(mm.p, mm.n, coded_mm);
    for (const MmLayout &l : sc.mm) {
      const auto refs = mm_refs(*h1, *h2, l);
      predict_unit_t(mm.p + 4 * l.offset, static_cast<std::size_t>(4 * l.instances * l.stride),
                     refs.first, refs.second, coded_mm, mm.n / 4, l.offset);
      if (tr != nullptr) {
        tr->push_back(Unit{UnitBlock::MmF32, l.id, order_of(refs.first, refs.second)});
      }
    }
  }
  for (const auto &[dst, name] : copies) {
    const std::uint8_t *src = name == BlockName::MeshU8    ? coded_u8
                              : name == BlockName::MeshF32 ? coded_f32
                                                           : coded_mm;
    const std::size_t n = name == BlockName::MeshU8 ? u8.n : name == BlockName::MeshF32 ? mf.n : mm.n;
    if (n != 0) {
      std::memcpy(dst, src, n);
    }
  }

  // History::accept() from the /12 blocks.
  std::shared_ptr<PredictState> next = next_state(full);
  advance(next.get(), meta, sc.u8_ok ? &sc.u8 : nullptr, u8, mf, mm, &sc.pool);
  h2_ = full ? empty_state() : h1_;
  h1_ = std::move(next);
  if (trace != nullptr) {
    *trace = std::move(units);
  }
  return Status::Ok;
}

Status Predictor::decode(const std::uint8_t *record13, std::size_t size,
                         std::vector<std::uint8_t> *out, std::vector<Unit> *trace) {
  Scratch &sc = scratch();
  Span meta_span;
  if (!parse_record(record13, size, &meta_span, &sc.blocks)) {
    return Status::Framing;
  }
  const Status st = typed_meta(meta_span, false, &sc.meta);
  if (st != Status::Ok) {
    return st;
  }
  return decode_typed(sc.meta, record13, size, out, trace);
}

// The reader: sc.blocks holds the record's blocks (parse_record()).
Status Predictor::decode_typed(const PredictMeta &meta, const std::uint8_t *record,
                               std::size_t /*size*/, std::vector<std::uint8_t> *out,
                               std::vector<Unit> *trace) {
  Scratch &sc = *scratch_;
  const std::string_view meta_text(reinterpret_cast<const char *>(record + 8), u32_at(record + 4));
  std::string plain;
  std::string check;
  if (!without_check(meta_text, &plain, &check)) {
    return Status::MetaSchema;
  }
  for (char c : check) {
    if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) {
      return Status::MetaSchema;
    }
  }
  // History::refs(): a full predicts nothing (unless no-predict-reset).
  const bool full = meta.full && !no_reset;
  const PredictState &empty = *empty_state();
  const PredictState *h1 = full ? &empty : h1_.get();
  const PredictState *h2 = full ? &empty : h2_.get();
  const std::vector<Span> &blocks = sc.blocks;
  const Named named = named_blocks(meta, blocks.size());
  const Span u8 = block_or_empty(blocks, named.u8);
  const Span mf = block_or_empty(blocks, named.f32);
  const Span mm = block_or_empty(blocks, named.mm);
  sc.u8_ok = named.u8 >= 0 && u8_layout(meta, u8.n, &sc.u8);
  const bool has_u8 = sc.u8_ok;
  const bool has_f32 = named.f32 >= 0 && mf.n % 4 == 0 && f32_layout(meta, mf.n / 4, &sc.f32);
  const bool has_mm = named.mm >= 0 && mm.n % 4 == 0 && mm_layout(meta, mm.n / 4, &sc.mm);
  std::vector<Unit> units;
  std::vector<Unit> *tr = trace != nullptr ? &units : nullptr;
  if (has_u8) {
    sc.dec_u8.resize(u8.n);
    code_u8<true>(sc.u8, u8.p, sc.dec_u8.data(), *h1, *h2, tr);
  }
  if (has_f32) {
    sc.dec_f32.resize(mf.n);
    untranspose4(mf.p, mf.n, sc.dec_f32.data());
    for (const auto &[mid, off] : sc.f32) {
      const auto refs = aabb_refs(*h1, *h2, mid);
      unpredict_words(sc.dec_f32.data() + 4 * off, 24, refs.first, refs.second);
      if (tr != nullptr) {
        tr->push_back(Unit{UnitBlock::MeshF32, mid, order_of(refs.first, refs.second)});
      }
    }
  }
  if (has_mm) {
    sc.dec_mm.resize(mm.n);
    untranspose4(mm.p, mm.n, sc.dec_mm.data());
    for (const MmLayout &l : sc.mm) {
      const auto refs = mm_refs(*h1, *h2, l);
      unpredict_words(sc.dec_mm.data() + 4 * l.offset,
                      static_cast<std::size_t>(4 * l.instances * l.stride), refs.first,
                      refs.second);
      if (tr != nullptr) {
        tr->push_back(Unit{UnitBlock::MmF32, l.id, order_of(refs.first, refs.second)});
      }
    }
  }
  const Span u8_12 = has_u8 ? span_of(sc.dec_u8) : u8;
  const Span mf_12 = has_f32 ? span_of(sc.dec_f32) : mf;
  const Span mm_12 = has_mm ? span_of(sc.dec_mm) : mm;
  if (check_hex(check_of(sc.xxh, mf_12, u8_12, mm_12)) != check) {
    return Status::PredictCheck;
  }
  // _rebuild_blocks(): every descriptor named like a coded block carries the decoded bytes.
  sc.rebuilt = blocks;
  for (std::size_t k = 0; k < sc.rebuilt.size() && k < meta.blocks.size(); ++k) {
    const BlockName n = meta.blocks[k];
    if (n == BlockName::MeshU8 && has_u8) {
      sc.rebuilt[k] = u8_12;
    } else if (n == BlockName::MeshF32 && has_f32) {
      sc.rebuilt[k] = mf_12;
    } else if (n == BlockName::MmF32 && has_mm) {
      sc.rebuilt[k] = mm_12;
    }
  }
  std::vector<std::uint8_t> record_out;
  make_record(plain, sc.rebuilt, &record_out);

  // History::accept() from the /12 blocks.
  std::shared_ptr<PredictState> next = next_state(full);
  advance(next.get(), meta, sc.u8_ok ? &sc.u8 : nullptr, u8_12, mf_12, mm_12, &sc.pool);
  h2_ = full ? empty_state() : h1_;
  h1_ = std::move(next);

  *out = std::move(record_out);
  if (trace != nullptr) {
    *trace = std::move(units);
  }
  return Status::Ok;
}

namespace {

bool same_bytes(const SharedBytes &a, const SharedBytes &b) {
  return a == b || (a != nullptr && b != nullptr && *a == *b);
}

}  // namespace

bool same_state(const PredictState &a, const PredictState &b) {
  if (&a == &b) {
    return true;
  }
  if (a.body.size() != b.body.size() || a.aabb != b.aabb || a.mm.size() != b.mm.size()) {
    return false;
  }
  for (auto x = a.body.begin(), y = b.body.begin(); x != a.body.end(); ++x, ++y) {
    if (x->first != y->first || x->second.shape != y->second.shape ||
        x->second.surfaces.size() != y->second.surfaces.size()) {
      return false;
    }
    for (std::size_t i = 0; i < x->second.surfaces.size(); ++i) {
      if (!same_bytes(x->second.surfaces[i], y->second.surfaces[i])) {
        return false;
      }
    }
  }
  for (auto x = a.mm.begin(), y = b.mm.begin(); x != a.mm.end(); ++x, ++y) {
    if (x->first != y->first || x->second.instances != y->second.instances ||
        x->second.stride != y->second.stride || !same_bytes(x->second.bytes, y->second.bytes)) {
      return false;
    }
  }
  return true;
}

bool same_history(const Predictor &a, const Predictor &b) {
  return same_state(a.h1(), b.h1()) && same_state(a.h2(), b.h2());
}

std::vector<std::uint8_t> encode_transaction(const rs2::Transaction &transaction,
                                             Predictor *predictor) {
  const std::vector<std::uint8_t> plain = rs2::encode_transaction(transaction);
  std::vector<std::uint8_t> out;
  if (predictor->encode(transaction, plain, &out) != Status::Ok) {
    return plain;  // unreachable for an encoder-written transaction
  }
  return out;
}

}  // namespace rs13
}  // namespace grc
