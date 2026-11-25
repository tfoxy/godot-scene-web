#include "rs_audio_wire.h"
#include "rs_sha256.h"
#include <algorithm>
#include <cerrno>
#include <cstdlib>
#include <iomanip>
#include <locale>
#include <locale.h>
#include <sstream>
#include <cmath>
#include <stdexcept>
#if defined(__APPLE__)
#include <xlocale.h>
#endif

namespace grc::audio {
namespace {
void check(bool ok) { if (!ok) throw std::invalid_argument("audio-protocol"); }
bool roundtrips(const std::string &token, float value) {
#if defined(_WIN32)
  static _locale_t locale = _create_locale(LC_NUMERIC, "C");
#else
  static locale_t locale = newlocale(LC_NUMERIC_MASK, "C", nullptr);
#endif
  if (!locale) std::abort();
  char *end = nullptr;
  errno = 0;
  // Parse at float precision to avoid double rounding. A nonzero finite subnormal
  // is valid even when the libc conversion reports ERANGE (iostreams reject it).
#if defined(_WIN32)
  const float parsed = _strtof_l(token.c_str(), &end, locale);
#else
  const float parsed = strtof_l(token.c_str(), &end, locale);
#endif
  return end == token.c_str() + token.size() && end != token.c_str() &&
      (errno == 0 || errno == ERANGE) && std::isfinite(parsed) && parsed != 0 && parsed == value;
}
bool whitespace(std::uint32_t c) {
  return (c >= 9 && c <= 13) || c == 32 || c == 0x85 || c == 0xa0 || c == 0x1680 ||
      (c >= 0x2000 && c <= 0x200a) || c == 0x2028 || c == 0x2029 || c == 0x202f || c == 0x205f || c == 0x3000;
}
// Validate UTF-8 without locale-dependent character predicates.
bool only_space(std::string_view s) {
  bool all = true;
  for (std::size_t i = 0; i < s.size();) {
    const auto c = static_cast<std::uint8_t>(s[i++]);
    std::uint32_t cp = c;
    int n = 0;
    if (c >= 0xc2 && c <= 0xdf) { cp = c & 31; n = 1; }
    else if (c >= 0xe0 && c <= 0xef) { cp = c & 15; n = 2; }
    else if (c >= 0xf0 && c <= 0xf4) { cp = c & 7; n = 3; }
    else check(c < 0x80);
    const int width = n;
    check(i + n <= s.size());
    while (n--) { auto b = static_cast<std::uint8_t>(s[i++]); check((b & 0xc0) == 0x80); cp = (cp << 6) | (b & 63); }
    check((width != 1 || cp >= 0x80) && (width != 2 || cp >= 0x800) &&
        (width != 3 || cp >= 0x10000) && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff));
    all = all && whitespace(cp);
  }
  return all;
}
struct Writer {
  Bytes b;
  void number(std::uint64_t v, unsigned n) { for (unsigned i = 0; i < n; ++i, v >>= 8) b.push_back(v & 255); }
  void bytes(const Bytes &v) { b.insert(b.end(), v.begin(), v.end()); }
  void str(std::string_view s, unsigned width) {
    only_space(s); check(s.size() <= (width == 1 ? 255u : 65535u));
    number(s.size(), width); b.insert(b.end(), s.begin(), s.end());
  }
};
struct Reader {
  const Bytes &b; std::size_t p = 0;
  Bytes take(std::size_t n) { check(n <= b.size() - p); Bytes v(b.begin() + p, b.begin() + p + n); p += n; return v; }
  std::uint64_t number(unsigned n) {
    check(n <= b.size() - p); std::uint64_t v = 0;
    for (unsigned i = 0; i < n; ++i) v |= std::uint64_t(b[p++]) << (i * 8);
    return v;
  }
  std::string str(unsigned width) { auto v = take(number(width)); std::string s(v.begin(), v.end()); only_space(s); return s; }
  void end() { check(p == b.size()); }
};
}
std::string hex(const Bytes &b) {
  constexpr char digits[] = "0123456789abcdef";
  std::string out; out.reserve(b.size() * 2);
  for (auto v : b) { out += digits[v >> 4]; out += digits[v & 15]; }
  return out;
}
Bytes unhex(std::string_view s, std::size_t size) {
  check(s.size() % 2 == 0 && (size == static_cast<std::size_t>(-1) || s.size() == size * 2));
  auto digit = [](char c) -> unsigned { if (c >= '0' && c <= '9') return c - '0'; check(c >= 'a' && c <= 'f'); return c - 'a' + 10; };
  Bytes b; for (std::size_t i = 0; i < s.size(); i += 2) b.push_back((digit(s[i]) << 4) | digit(s[i+1])); return b;
}
std::string float_r(float value) {
  check(std::isfinite(value));
  if (value == 0) return std::signbit(value) ? "-0" : "0";
  std::string raw;
  bool found = false;
  for (int precision = 0; precision < 9 && !found; ++precision) {
    std::ostringstream output;
    output.imbue(std::locale::classic());
    output << std::scientific << std::setprecision(precision) << std::fabs(value);
    const auto rounded = output.str();
    const auto exponent_at = rounded.find('e');
    const int exponent = std::stoi(rounded.substr(exponent_at + 1)) - precision;
    std::string coefficient = rounded.substr(0, exponent_at);
    coefficient.erase(std::remove(coefficient.begin(), coefficient.end(), '.'), coefficient.end());
    // At powers of two the round-trip interval is asymmetric. The nearest rounded
    // decimal can be outside it while its adjacent decimal of the same width is inside.
    for (int adjustment : {0, 1, -1}) {
      const auto number = std::stoll(coefficient) + adjustment;
      if (number <= 0) continue;
      const auto digits = std::to_string(number);
      const auto candidate = digits + "e" + std::to_string(exponent);
      if (roundtrips(candidate, std::fabs(value))) {
        raw = digits.substr(0, 1) + "." + digits.substr(1) + "e" +
            std::to_string(exponent + static_cast<int>(digits.size()) - 1);
        found = true;
        break;
      }
    }
  }
  check(found);
  const auto e = raw.find('e');
  const int k = std::stoi(raw.substr(e + 1));
  std::string digits = raw.substr(0, e);
  digits.erase(std::remove(digits.begin(), digits.end(), '.'), digits.end());
  while (digits.size() > 1 && digits.back() == '0') digits.pop_back();
  std::string out = std::signbit(value) ? "-" : "";
  if (k >= 9 || k <= -5) {
    out += digits[0]; if (digits.size() > 1) out += "." + digits.substr(1);
    out += k < 0 ? "E-" : "E+";
    auto exponent = std::to_string(std::abs(k)); if (exponent.size() < 2) out += '0';
    return out + exponent;
  }
  const int point = k + 1;
  if (point <= 0) return out + "0." + std::string(-point, '0') + digits;
  if (static_cast<std::size_t>(point) >= digits.size()) return out + digits + std::string(point - digits.size(), '0');
  return out + digits.substr(0, point) + "." + digits.substr(point);
}
std::string canonical_key(std::string_view path, std::vector<std::pair<std::string, float>> params) {
  check(!path.empty() && !only_space(path) && path.find('|') == std::string_view::npos);
  std::sort(params.begin(), params.end(), [](const auto &a, const auto &b) { return a.first < b.first; });
  std::string key(path), previous;
  for (std::size_t i = 0; i < params.size(); ++i) {
    const auto &[name, value] = params[i]; check(!name.empty() && (i == 0 || name != previous));
    for (unsigned char c : name) check(c >= 32 && c <= 126 && c != '=' && c != ',' && c != '|');
    key += i == 0 ? '|' : ','; key += name + "=" + float_r(value); previous = name;
  }
  check(key.size() <= 512); return key;
}
std::string key_id(std::string_view key) {
  check(!key.empty() && key.size() <= 512); only_space(key);
  const auto digest = key_digest(key);
  return hex(Bytes(digest.begin(), digest.end()));
}
std::array<std::uint8_t, 16> key_digest(std::string_view key) {
  grc::Sha256 hash; const std::uint8_t schema = 1;
  hash.update(&schema, 1); hash.update(key.data(), key.size());
  const auto full = hash.finish();
  std::array<std::uint8_t, 16> digest;
  std::copy_n(full.begin(), digest.size(), digest.begin());
  return digest;
}
Block decode_block(const Bytes &b, BlockContext context) {
  check(b.size() >= 48); Reader r{b};
  check(r.number(2) == 0x4147 && r.number(1) == 1);
  Block out; auto &h = out.header;
  h.kind = r.number(1); h.flags = r.number(1); h.lane = r.number(1); h.codec = r.number(1); h.channels = r.number(1);
  h.stream = r.number(4); h.block = r.number(4); h.rate = r.number(4); h.frames = r.number(2);
  check(r.number(2) == 0); h.made_us = r.number(8); h.due_us = r.number(8); h.sent_us = r.number(8);
  check((h.kind == 1 || h.kind == 2) && (h.flags & ~15) == 0 && h.codec == 0 && h.channels == 2 && h.rate == 48000);
  if (h.kind == 1) check(h.lane == 0 && h.stream != 0 && h.frames >= 1 && h.frames <= 2048);
  else check(h.lane >= 1 && h.lane <= 15 && (context.lane_mask & (1u << h.lane)) && h.frames == context.lane_block_frames);
  const auto payload = h.flags & 4 ? 0u : h.frames * 4u;
  out.payload = r.take(payload); r.end(); return out;
}
Bytes encode_block(const BlockHeader &h, const Bytes &payload, BlockContext context) {
  Writer w; w.number(0x4147, 2); w.number(1, 1);
  for (auto v : {h.kind, h.flags, h.lane, h.codec, h.channels}) w.number(v, 1);
  w.number(h.stream, 4); w.number(h.block, 4); w.number(h.rate, 4); w.number(h.frames, 2); w.number(0, 2);
  w.number(h.made_us, 8); w.number(h.due_us, 8); w.number(h.sent_us, 8); w.bytes(payload);
  decode_block(w.b, context); return w.b;
}
LinkMessage decode_link(const Bytes &b) {
  Reader r{b}; LinkMessage m; m.type = r.number(1);
  switch (m.type) {
    case 0: {
      m.version = r.number(2); check(m.version == 1);
      m.clock_domain = hex(r.take(16)); m.bankset = hex(r.take(16));
      const auto n = r.number(1); check(n <= 15); std::uint16_t ids = 0;
      for (unsigned i = 0; i < n; ++i) {
        LinkLane l; l.id = r.number(1); check(l.id >= 1 && l.id <= 15 && !(ids & (1u << l.id)));
        ids |= 1u << l.id; l.name = r.str(1); l.group = r.str(1); m.lanes.push_back(std::move(l));
      } break;
    }
    case 1: m.block = r.take(b.size() - 1); check(decode_block(m.block).header.sent_us == 0); break;
    case 2: m.key_id = hex(r.take(16)); m.stream = r.number(4); m.frames = r.number(4); check(m.stream != 0 && m.frames > 0); break;
    case 3: m.key_id = hex(r.take(16)); m.stream = r.number(4); check(m.stream != 0); m.wav_sha256 = hex(r.take(32)); break;
    case 4: m.key_id = hex(r.take(16)); m.reason = r.number(1); check(m.reason <= 4); break;
    case 5: m.key_id = hex(r.take(16)); m.t_us = r.number(8); m.key = r.str(2); check(!m.key.empty() && m.key.size() <= 512); break;
    case 6: m.lane_mask = r.number(2); check((m.lane_mask & 1) == 0); break;
    default: check(false);
  }
  r.end(); return m;
}
Bytes encode_link(const LinkMessage &m) {
  Writer w; w.number(m.type, 1);
  switch (m.type) {
    case 0:
      w.number(m.version, 2); w.bytes(unhex(m.clock_domain, 16)); w.bytes(unhex(m.bankset, 16)); check(m.lanes.size() <= 15); w.number(m.lanes.size(), 1);
      for (const auto &l : m.lanes) { w.number(l.id, 1); w.str(l.name, 1); w.str(l.group, 1); } break;
    case 1: w.bytes(m.block); break;
    case 2: w.bytes(unhex(m.key_id, 16)); w.number(m.stream, 4); w.number(m.frames, 4); break;
    case 3: w.bytes(unhex(m.key_id, 16)); w.number(m.stream, 4); w.bytes(unhex(m.wav_sha256, 32)); break;
    case 4: w.bytes(unhex(m.key_id, 16)); w.number(m.reason, 1); break;
    case 5: w.bytes(unhex(m.key_id, 16)); w.number(m.t_us, 8); w.str(m.key, 2); break;
    case 6: w.number(m.lane_mask, 2); break;
    default: check(false);
  }
  decode_link(w.b); return w.b;
}
MediaPrefix decode_prefix(const Bytes &b) {
  check(!b.empty()); MediaPrefix p; p.kind = b[0];
  if (p.kind == 2) { check(b.size() == 17); p.key_id = hex(Bytes(b.begin() + 1, b.end())); }
  else { check(p.kind == 3 && b.size() == 2 && b[1] >= 1 && b[1] <= 15); p.lane = b[1]; }
  return p;
}
Bytes encode_prefix(const MediaPrefix &p) {
  Writer w; w.number(p.kind, 1);
  if (p.kind == 2) w.bytes(unhex(p.key_id, 16)); else w.number(p.lane, 1);
  decode_prefix(w.b); return w.b;
}
}  // namespace grc::audio
