// rs_track_caps: per-viewer track capabilities (rs_track_caps.h).
#include "rs_track_caps.h"

#include <sys/random.h>

#include <cerrno>
#include <set>
#include <vector>

#include "rs_json_lite.h"
#include "rs_sha256.h"

namespace grc {
namespace rs {
namespace tracks {
namespace caps {

namespace {

constexpr std::int64_t kMaxExp = (std::int64_t(1) << 53) - 1;
const char *const kAlphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

int b64_value(char c) {
  if (c >= 'A' && c <= 'Z') return c - 'A';
  if (c >= 'a' && c <= 'z') return c - 'a' + 26;
  if (c >= '0' && c <= '9') return c - '0' + 52;
  if (c == '-') return 62;
  if (c == '_') return 63;
  return -1;
}

// Constant time in the content for equal lengths; the lengths themselves are public (a MAC is
// always 43 characters).
bool equal_ct(std::string_view a, std::string_view b) {
  if (a.size() != b.size()) return false;
  unsigned char diff = 0;
  for (std::size_t i = 0; i < a.size(); ++i) {
    diff |= static_cast<unsigned char>(a[i] ^ b[i]);
  }
  return diff == 0;
}

bool lower_alnum(char c) { return (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9'); }
bool alnum(char c) { return lower_alnum(c) || (c >= 'A' && c <= 'Z'); }

bool kind_ok(std::string_view s) {
  if (s.empty() || s.size() > 32 || s[0] < 'a' || s[0] > 'z') return false;
  for (const char c : s) {
    if (!lower_alnum(c) && c != '-') return false;
  }
  return true;
}

bool sub_ok(std::string_view s) {
  if (s.empty() || s.size() > 64) return false;
  for (const char c : s) {
    if (!alnum(c) && c != '.' && c != '_' && c != ':' && c != '@' && c != '-') return false;
  }
  return true;
}

bool nonce_ok(std::string_view s) {
  if (s.size() > 32) return false;
  for (const char c : s) {
    if (!alnum(c) && c != '_' && c != '-') return false;
  }
  return true;
}

// [1-9][0-9]* up to 2^53-1.
bool exp_from_text(std::string_view s, std::int64_t *out) {
  if (s.empty() || s.size() > 16 || s[0] < '1' || s[0] > '9') return false;
  std::int64_t v = 0;
  for (const char c : s) {
    if (c < '0' || c > '9') return false;
    v = v * 10 + (c - '0');
  }
  if (v > kMaxExp) return false;
  *out = v;
  return true;
}

Verdict refused(const char *detail) {
  Verdict v;
  v.detail = detail;
  return v;
}

}  // namespace

std::array<std::uint8_t, 32> hmac_sha256(std::string_view key, std::string_view message) {
  std::uint8_t block[64] = {};
  if (key.size() > sizeof(block)) {
    const std::array<std::uint8_t, 32> k = [&] {
      Sha256 h;
      h.update(key.data(), key.size());
      return h.finish();
    }();
    for (std::size_t i = 0; i < k.size(); ++i) block[i] = k[i];
  } else {
    for (std::size_t i = 0; i < key.size(); ++i) block[i] = static_cast<std::uint8_t>(key[i]);
  }
  std::uint8_t pad[64];
  for (std::size_t i = 0; i < sizeof(pad); ++i) pad[i] = block[i] ^ 0x36;
  Sha256 inner;
  inner.update(pad, sizeof(pad));
  inner.update(message.data(), message.size());
  const std::array<std::uint8_t, 32> inner_digest = inner.finish();
  for (std::size_t i = 0; i < sizeof(pad); ++i) pad[i] = block[i] ^ 0x5c;
  Sha256 outer;
  outer.update(pad, sizeof(pad));
  outer.update(inner_digest.data(), inner_digest.size());
  return outer.finish();
}

std::string base64url_encode(std::string_view bytes) {
  std::string out;
  out.reserve((bytes.size() * 4 + 2) / 3);
  std::size_t i = 0;
  for (; i + 3 <= bytes.size(); i += 3) {
    const std::uint32_t v = (std::uint32_t(std::uint8_t(bytes[i])) << 16) |
                            (std::uint32_t(std::uint8_t(bytes[i + 1])) << 8) | std::uint8_t(bytes[i + 2]);
    out.push_back(kAlphabet[(v >> 18) & 63]);
    out.push_back(kAlphabet[(v >> 12) & 63]);
    out.push_back(kAlphabet[(v >> 6) & 63]);
    out.push_back(kAlphabet[v & 63]);
  }
  const std::size_t rest = bytes.size() - i;
  if (rest == 1) {
    const std::uint32_t v = std::uint32_t(std::uint8_t(bytes[i])) << 16;
    out.push_back(kAlphabet[(v >> 18) & 63]);
    out.push_back(kAlphabet[(v >> 12) & 63]);
  } else if (rest == 2) {
    const std::uint32_t v = (std::uint32_t(std::uint8_t(bytes[i])) << 16) |
                            (std::uint32_t(std::uint8_t(bytes[i + 1])) << 8);
    out.push_back(kAlphabet[(v >> 18) & 63]);
    out.push_back(kAlphabet[(v >> 12) & 63]);
    out.push_back(kAlphabet[(v >> 6) & 63]);
  }
  return out;
}

bool base64url_decode(std::string_view text, std::string *bytes) {
  if (text.size() % 4 == 1) return false;
  std::string out;
  out.reserve(text.size() * 3 / 4);
  std::uint32_t acc = 0;
  int bits = 0;
  for (const char c : text) {
    const int v = b64_value(c);
    if (v < 0) return false;
    acc = (acc << 6) | static_cast<std::uint32_t>(v);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push_back(static_cast<char>((acc >> bits) & 0xFF));
    }
  }
  // The leftover 2 or 4 bits must be zero: one spelling per byte string.
  if (bits > 0 && (acc & ((1u << bits) - 1)) != 0) return false;
  *bytes = std::move(out);
  return true;
}

bool key_from_hex(std::string_view hex, std::string *key) {
  if (hex.size() != kKeyBytes * 2) return false;
  std::string out;
  out.reserve(kKeyBytes);
  for (std::size_t i = 0; i < hex.size(); i += 2) {
    int byte = 0;
    for (std::size_t k = 0; k < 2; ++k) {
      const char c = hex[i + k];
      int v = -1;
      if (c >= '0' && c <= '9') v = c - '0';
      if (c >= 'a' && c <= 'f') v = c - 'a' + 10;
      if (v < 0) return false;
      byte = byte * 16 + v;
    }
    out.push_back(static_cast<char>(byte));
  }
  *key = std::move(out);
  return true;
}

std::string key_to_hex(std::string_view key) {
  static const char *const hex = "0123456789abcdef";
  std::string out;
  out.reserve(key.size() * 2);
  for (const char ch : key) {
    const unsigned char b = static_cast<unsigned char>(ch);
    out.push_back(hex[b >> 4]);
    out.push_back(hex[b & 0xF]);
  }
  return out;
}

std::string generate_key() {
  std::string buf(kKeyBytes, '\0');
  std::size_t got = 0;
  while (got < buf.size()) {
    const ssize_t n = ::getrandom(&buf[got], buf.size() - got, 0);
    if (n < 0) {
      if (errno == EINTR) continue;
      return std::string();
    }
    got += static_cast<std::size_t>(n);
  }
  return buf;
}

std::string sign(std::string_view key, std::string_view payload_json) {
  const std::string signed_text = std::string(kPrefix) + base64url_encode(payload_json);
  const std::array<std::uint8_t, 32> mac = hmac_sha256(key, signed_text);
  return signed_text + "." +
         base64url_encode(std::string_view(reinterpret_cast<const char *>(mac.data()), mac.size()));
}

std::string mint(std::string_view key, std::string_view kind, std::string_view sub, std::int64_t exp,
                 std::string_view nonce) {
  if (!kind_ok(kind) || !sub_ok(sub) || exp < 1 || exp > kMaxExp || !nonce_ok(nonce)) return std::string();
  // No member needs escaping: every grammar above is printable ASCII without quote or backslash.
  std::string json = "{\"v\":1,\"kind\":\"" + std::string(kind) + "\",\"sub\":\"" + std::string(sub) +
                     "\",\"exp\":" + std::to_string(exp);
  if (!nonce.empty()) json += ",\"nonce\":\"" + std::string(nonce) + "\"";
  json += "}";
  return sign(key, json);
}

Verdict verify(std::string_view key, std::string_view credential, std::string_view kind, std::int64_t now_s,
               Ignore ignore) {
  // 1. Form: cap1.<payload>.<mac>, both base64url, the MAC exactly 32 bytes (43 characters).
  const std::string_view prefix(kPrefix);
  if (credential.substr(0, prefix.size()) != prefix) return refused("malformed");
  const std::string_view rest = credential.substr(prefix.size());
  const std::size_t dot = rest.find('.');
  if (dot == std::string_view::npos || dot == 0) return refused("malformed");
  const std::string_view payload_b64 = rest.substr(0, dot);
  const std::string_view mac_b64 = rest.substr(dot + 1);
  std::string mac_bytes;
  std::string payload;
  if (mac_b64.size() != 43 || !base64url_decode(mac_b64, &mac_bytes) || mac_bytes.size() != 32 ||
      !base64url_decode(payload_b64, &payload)) {
    return refused("malformed");
  }
  // 2. The MAC over the text as sent, before anything in it is believed.
  const std::array<std::uint8_t, 32> expected =
      hmac_sha256(key, credential.substr(0, prefix.size() + payload_b64.size()));
  const std::string expected_b64 =
      base64url_encode(std::string_view(reinterpret_cast<const char *>(expected.data()), expected.size()));
  if (!equal_ct(expected_b64, mac_b64) && !ignore.mac) return refused("bad-mac");
  // 3. The authentic payload's grammar: exactly v, kind, sub, exp and an optional nonce.
  json_lite::JValue root;
  json_lite::Reader reader(payload);
  if (!reader.parse(&root) || root.kind != json_lite::JValue::Object) return refused("cap-invalid");
  std::set<std::string> seen;
  for (const auto &f : root.fields) {
    if (!seen.insert(f.first).second) return refused("cap-invalid");
    if (f.first != "v" && f.first != "kind" && f.first != "sub" && f.first != "exp" && f.first != "nonce") {
      return refused("cap-invalid");
    }
  }
  const json_lite::JValue *v = root.get("v");
  const json_lite::JValue *cap_kind = root.get("kind");
  const json_lite::JValue *sub = root.get("sub");
  const json_lite::JValue *exp = root.get("exp");
  const json_lite::JValue *nonce = root.get("nonce");
  std::int64_t exp_s = 0;
  if (v == nullptr || v->kind != json_lite::JValue::Number || v->text != "1" || cap_kind == nullptr ||
      cap_kind->kind != json_lite::JValue::String || !kind_ok(cap_kind->text) || sub == nullptr ||
      sub->kind != json_lite::JValue::String || !sub_ok(sub->text) || exp == nullptr ||
      exp->kind != json_lite::JValue::Number || !exp_from_text(exp->text, &exp_s) ||
      (nonce != nullptr && (nonce->kind != json_lite::JValue::String || !nonce_ok(nonce->text)))) {
    return refused("cap-invalid");
  }
  // 4. Scope, then time.
  if (cap_kind->text != kind) return refused("wrong-kind");
  if (now_s > exp_s + kSkewS && !ignore.exp) return refused("expired");
  if (exp_s > now_s + kMaxLifetimeS + kSkewS) return refused("exp-too-far");
  Verdict ok;
  ok.ok = true;
  ok.subject = sub->text;
  ok.exp = exp_s;
  return ok;
}

}  // namespace caps
}  // namespace tracks
}  // namespace rs
}  // namespace grc
