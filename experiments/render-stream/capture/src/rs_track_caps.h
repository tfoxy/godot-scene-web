// rs_track_caps: per-viewer track capabilities.
//
// With GRC_LIVE_TRACK_CAPS=hmac the capture writes one 32-byte key (evidence/live-track-cap-key,
// 64 lowercase hex, mode 0600) instead of the shared per-kind credential, and a consumer's server
// mints one capability per viewer:
//
//   cap1.<payload>.<mac>
//   payload = base64url(JSON {"v":1,"kind":"input","sub":"viewer-1","exp":1767225900,"nonce":"n1"})
//   mac     = base64url(HMAC-SHA256(key, "cap1." + payload))
//
// base64url is RFC 4648 section 5 without padding, and only its canonical spelling decodes (the
// unused low bits of the last character are zero). The MAC is checked first, in constant time,
// over the text as sent; nothing unauthenticated is parsed. The payload is then strict: exactly
// the members v (the integer 1), kind ([a-z][a-z0-9-]{0,31}), sub ([A-Za-z0-9._:@-]{1,64}), exp
// (a decimal integer of seconds since the Unix epoch, 1..2^53-1, no sign, fraction or exponent)
// and an optional nonce ([A-Za-z0-9_-]{0,32}); no other member and no duplicate. A restricting
// claim a later version adds must bump `v`, so no host ever ignores one.
//
// Clock rule: with `now` the host's wall clock in whole seconds, a capability opens a track while
// now <= exp + kSkewS, and is refused `exp-too-far` when exp > now + kMaxLifetimeS + kSkewS (a
// minter that wrote milliseconds, or a lifetime over a day). Skew only ever extends a capability,
// by at most kSkewS. A track opened before `exp` lives on until it closes.
//
// Reference minter and the shared golden vectors: scripts/lib/track-cap.ts,
// protocol/track-cap-vectors.json (rs_track_test and self-test-track-caps.ts both check them).
#ifndef GRC_RS_TRACK_CAPS_H
#define GRC_RS_TRACK_CAPS_H

#include <array>
#include <cstddef>
#include <cstdint>
#include <string>
#include <string_view>

namespace grc {
namespace rs {
namespace tracks {
namespace caps {

inline constexpr const char *kPrefix = "cap1.";
inline constexpr std::int64_t kSkewS = 30;
inline constexpr std::int64_t kMaxLifetimeS = 86400;
inline constexpr std::size_t kKeyBytes = 32;

// HMAC-SHA256 (RFC 2104 over FIPS 180-4).
std::array<std::uint8_t, 32> hmac_sha256(std::string_view key, std::string_view message);

// RFC 4648 section 5, no padding.
std::string base64url_encode(std::string_view bytes);
// Strict: only the base64url alphabet, no padding, a length that is not 1 mod 4, and the
// canonical last character. False otherwise.
bool base64url_decode(std::string_view text, std::string *bytes);

// The key file's text (64 lowercase hex) to its 32 bytes, and back.
bool key_from_hex(std::string_view hex, std::string *key);
std::string key_to_hex(std::string_view key);
// 32 getrandom bytes; "" when the system has no entropy to give.
std::string generate_key();

// cap1.<base64url(payload_json)>.<mac>: signs any payload text (the golden vectors sign malformed
// ones on purpose).
std::string sign(std::string_view key, std::string_view payload_json);
// The canonical capability: {"v":1,"kind":..,"sub":..,"exp":..[,"nonce":..]} in that order, the
// nonce omitted when empty. "" when an argument is outside its grammar.
std::string mint(std::string_view key, std::string_view kind, std::string_view sub, std::int64_t exp,
                 std::string_view nonce);

// Test-only sabotages (TrackConfig::sabotage track-cap-mac-ignored / track-cap-exp-ignored).
struct Ignore {
  bool mac = false;
  bool exp = false;
};

struct Verdict {
  bool ok = false;
  // On refusal, hello check 3's `track-unauthorized` detail: `malformed` (not cap1.<b64>.<b64>),
  // `bad-mac`, `cap-invalid` (an authentic payload outside the grammar: a minter bug),
  // `wrong-kind`, `expired` or `exp-too-far`. Never secret material.
  std::string detail;
  std::string subject;  // `sub`, when ok
  std::int64_t exp = 0;
};

// Checks a non-empty credential against `key` for a hello of `kind` at wall-clock `now_s`.
Verdict verify(std::string_view key, std::string_view credential, std::string_view kind, std::int64_t now_s,
               Ignore ignore = Ignore());

}  // namespace caps
}  // namespace tracks
}  // namespace rs
}  // namespace grc

#endif  // GRC_RS_TRACK_CAPS_H
