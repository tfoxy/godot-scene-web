#include "rs_sha1.h"

#include <cstring>
#include <vector>

namespace grc {

namespace {

std::uint32_t rotl32(std::uint32_t value, int bits) {
  return (value << bits) | (value >> (32 - bits));
}

}  // namespace

std::array<std::uint8_t, 20> sha1(const std::uint8_t *data, std::size_t len) {
  std::uint32_t h0 = 0x67452301;
  std::uint32_t h1 = 0xEFCDAB89;
  std::uint32_t h2 = 0x98BADCFE;
  std::uint32_t h3 = 0x10325476;
  std::uint32_t h4 = 0xC3D2E1F0;

  // Padding: one 0x80 byte, zeros, then the 64-bit bit-length, big-endian,
  // so the padded length is a multiple of 64 bytes.
  const std::uint64_t bit_len = static_cast<std::uint64_t>(len) * 8;
  std::size_t padded_len = len + 1;
  while (padded_len % 64 != 56) ++padded_len;
  padded_len += 8;

  std::vector<std::uint8_t> msg(padded_len, 0);
  std::memcpy(msg.data(), data, len);
  msg[len] = 0x80;
  for (int i = 0; i < 8; ++i) {
    msg[padded_len - 1 - i] = static_cast<std::uint8_t>((bit_len >> (8 * i)) & 0xFF);
  }

  for (std::size_t block = 0; block < padded_len; block += 64) {
    std::uint32_t w[80];
    for (int i = 0; i < 16; ++i) {
      const std::uint8_t *b = &msg[block + static_cast<std::size_t>(i) * 4];
      w[i] = (static_cast<std::uint32_t>(b[0]) << 24) | (static_cast<std::uint32_t>(b[1]) << 16) |
             (static_cast<std::uint32_t>(b[2]) << 8) | static_cast<std::uint32_t>(b[3]);
    }
    for (int i = 16; i < 80; ++i) {
      w[i] = rotl32(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
    }

    std::uint32_t a = h0, b = h1, c = h2, d = h3, e = h4;
    for (int i = 0; i < 80; ++i) {
      std::uint32_t f;
      std::uint32_t k;
      if (i < 20) {
        f = (b & c) | ((~b) & d);
        k = 0x5A827999;
      } else if (i < 40) {
        f = b ^ c ^ d;
        k = 0x6ED9EBA1;
      } else if (i < 60) {
        f = (b & c) | (b & d) | (c & d);
        k = 0x8F1BBCDC;
      } else {
        f = b ^ c ^ d;
        k = 0xCA62C1D6;
      }
      const std::uint32_t temp = rotl32(a, 5) + f + e + k + w[i];
      e = d;
      d = c;
      c = rotl32(b, 30);
      b = a;
      a = temp;
    }

    h0 += a;
    h1 += b;
    h2 += c;
    h3 += d;
    h4 += e;
  }

  std::array<std::uint8_t, 20> digest{};
  std::uint32_t words[5] = {h0, h1, h2, h3, h4};
  for (int i = 0; i < 5; ++i) {
    digest[static_cast<std::size_t>(i) * 4 + 0] = static_cast<std::uint8_t>((words[i] >> 24) & 0xFF);
    digest[static_cast<std::size_t>(i) * 4 + 1] = static_cast<std::uint8_t>((words[i] >> 16) & 0xFF);
    digest[static_cast<std::size_t>(i) * 4 + 2] = static_cast<std::uint8_t>((words[i] >> 8) & 0xFF);
    digest[static_cast<std::size_t>(i) * 4 + 3] = static_cast<std::uint8_t>(words[i] & 0xFF);
  }
  return digest;
}

std::array<std::uint8_t, 20> sha1(const std::string &data) {
  return sha1(reinterpret_cast<const std::uint8_t *>(data.data()), data.size());
}

}  // namespace grc
