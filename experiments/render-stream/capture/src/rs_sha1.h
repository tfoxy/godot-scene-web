// SHA-1 (FIPS 180-4), implemented locally because the capture library links
// nothing but libc/libstdc++/libpthread (CMakeLists.txt). RFC 6455's
// handshake needs SHA-1 once per connection over a ~60-byte input (the
// client's Sec-WebSocket-Key plus the protocol GUID); this is not a
// general-purpose or constant-time primitive and must never be reused for
// anything security-sensitive.
#ifndef GRC_RS_SHA1_H
#define GRC_RS_SHA1_H

#include <array>
#include <cstddef>
#include <cstdint>
#include <string>

namespace grc {

// The 20-byte digest, per FIPS 180-4. Vectors (RFC 6455 ssec 1.3 test
// coverage): sha1("") == da39a3ee5e6b4b0d3255bfef95601890afd80709,
// sha1("abc") == a9993e364706816aba3e25717850c26c9cd0d89d.
std::array<std::uint8_t, 20> sha1(const std::uint8_t *data, std::size_t len);
std::array<std::uint8_t, 20> sha1(const std::string &data);

}  // namespace grc

#endif  // GRC_RS_SHA1_H
