#include "rs_sha256.h"

#include <cstring>

#if defined(__x86_64__)
#include <cpuid.h>
#include <immintrin.h>
#endif

namespace grc {

namespace {

constexpr std::uint32_t kInit[8] = {0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
                                    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19};

alignas(16) constexpr std::uint32_t kK[64] = {
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
};

inline std::uint32_t rotr(std::uint32_t x, int n) { return (x >> n) | (x << (32 - n)); }

// The portable path: FIPS 180-4 section 6.2.2 as written (the G2a code, unchanged). It is the
// reference every other path is tested against. Out of line as G2a's member function was: inlined
// into the block loop GCC 13 schedules it ~6% slower (325 vs 347 MB/s on 16 MiB).
__attribute__((noinline)) void block_portable(std::uint32_t *state, const std::uint8_t *chunk) {
  std::uint32_t w[64];
  for (int i = 0; i < 16; ++i) {
    w[i] = (static_cast<std::uint32_t>(chunk[4 * i]) << 24) |
           (static_cast<std::uint32_t>(chunk[4 * i + 1]) << 16) |
           (static_cast<std::uint32_t>(chunk[4 * i + 2]) << 8) |
           static_cast<std::uint32_t>(chunk[4 * i + 3]);
  }
  for (int i = 16; i < 64; ++i) {
    const std::uint32_t s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >> 3);
    const std::uint32_t s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >> 10);
    w[i] = w[i - 16] + s0 + w[i - 7] + s1;
  }
  std::uint32_t a = state[0], b = state[1], c = state[2], d = state[3];
  std::uint32_t e = state[4], f = state[5], g = state[6], h = state[7];
  for (int i = 0; i < 64; ++i) {
    const std::uint32_t s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
    const std::uint32_t ch = (e & f) ^ (~e & g);
    const std::uint32_t t1 = h + s1 + ch + kK[i] + w[i];
    const std::uint32_t s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
    const std::uint32_t maj = (a & b) ^ (a & c) ^ (b & c);
    const std::uint32_t t2 = s0 + maj;
    h = g;
    g = f;
    f = e;
    e = d + t1;
    d = c;
    c = b;
    b = a;
    a = t1 + t2;
  }
  state[0] += a;
  state[1] += b;
  state[2] += c;
  state[3] += d;
  state[4] += e;
  state[5] += f;
  state[6] += g;
  state[7] += h;
}

void blocks_portable(std::uint32_t state[8], const std::uint8_t *chunk, std::size_t blocks) {
  for (; blocks > 0; --blocks, chunk += 64) {
    block_portable(state, chunk);
  }
}

#if defined(__x86_64__)

// The SHA-NI path (Intel's "New Instructions Supporting the Secure Hash Algorithm", the same
// shape as the Linux kernel's sha256_ni_asm.S): the state lives as ABEF/CDGH in two registers,
// sha256rnds2 does two rounds per call, sha256msg1/msg2 the message schedule. Compiled for SHA and
// SSE4.1 only inside this function, so the rest of the library keeps the baseline x86-64 ISA and
// this is only ever called after sha_ni_supported() said yes.
__attribute__((target("sha,sse4.1"))) void blocks_sha_ni(std::uint32_t state[8],
                                                          const std::uint8_t *data,
                                                          std::size_t blocks) {
  // Big-endian message words: reverse the bytes in each 32-bit lane.
  const __m128i kBswap = _mm_set_epi64x(0x0c0d0e0f08090a0bULL, 0x0405060700010203ULL);
  __m128i tmp = _mm_loadu_si128(reinterpret_cast<const __m128i *>(&state[0]));   // DCBA
  __m128i state1 = _mm_loadu_si128(reinterpret_cast<const __m128i *>(&state[4]));  // HGFE
  tmp = _mm_shuffle_epi32(tmp, 0xB1);                     // CDAB
  state1 = _mm_shuffle_epi32(state1, 0x1B);               // EFGH
  __m128i state0 = _mm_alignr_epi8(tmp, state1, 8);       // ABEF
  state1 = _mm_blend_epi16(state1, tmp, 0xF0);            // CDGH

  for (; blocks > 0; --blocks, data += 64) {
    const __m128i abef_save = state0;
    const __m128i cdgh_save = state1;
    __m128i w[16];
    for (int i = 0; i < 4; ++i) {
      w[i] = _mm_shuffle_epi8(
          _mm_loadu_si128(reinterpret_cast<const __m128i *>(data + 16 * i)), kBswap);
    }
    // W[4j..4j+3] = sigma1-completed (W[t-16] + sigma0(W[t-15]) + W[t-7]): msg1 adds the
    // sigma0 terms, the alignr picks W[t-7], msg2 adds sigma1(W[t-2]) lane by lane.
#pragma GCC unroll 12
    for (int j = 4; j < 16; ++j) {
      const __m128i t = _mm_add_epi32(_mm_sha256msg1_epu32(w[j - 4], w[j - 3]),
                                      _mm_alignr_epi8(w[j - 1], w[j - 2], 4));
      w[j] = _mm_sha256msg2_epu32(t, w[j - 1]);
    }
#pragma GCC unroll 16
    for (int j = 0; j < 16; ++j) {
      __m128i msg =
          _mm_add_epi32(w[j], _mm_load_si128(reinterpret_cast<const __m128i *>(&kK[4 * j])));
      state1 = _mm_sha256rnds2_epu32(state1, state0, msg);
      msg = _mm_shuffle_epi32(msg, 0x0E);
      state0 = _mm_sha256rnds2_epu32(state0, state1, msg);
    }
    state0 = _mm_add_epi32(state0, abef_save);
    state1 = _mm_add_epi32(state1, cdgh_save);
  }

  tmp = _mm_shuffle_epi32(state0, 0x1B);        // FEBA
  state1 = _mm_shuffle_epi32(state1, 0xB1);     // DCHG
  state0 = _mm_blend_epi16(tmp, state1, 0xF0);  // DCBA
  state1 = _mm_alignr_epi8(state1, tmp, 8);     // HGFE
  _mm_storeu_si128(reinterpret_cast<__m128i *>(&state[0]), state0);
  _mm_storeu_si128(reinterpret_cast<__m128i *>(&state[4]), state1);
}

// CPUID: leaf 7 EBX bit 29 (SHA), leaf 1 ECX bits 9 (SSSE3, pshufb/palignr) and 19 (SSE4.1,
// pblendw). XMM state needs no OS opt-in on x86-64, so no XGETBV check.
bool sha_ni_supported() {
  unsigned eax = 0, ebx = 0, ecx = 0, edx = 0;
  if (__get_cpuid(1, &eax, &ebx, &ecx, &edx) == 0) {
    return false;
  }
  const bool ssse3 = (ecx & (1u << 9)) != 0;
  const bool sse41 = (ecx & (1u << 19)) != 0;
  if (__get_cpuid_count(7, 0, &eax, &ebx, &ecx, &edx) == 0) {
    return false;
  }
  const bool sha = (ebx & (1u << 29)) != 0;
  return ssse3 && sse41 && sha;
}

#endif  // __x86_64__

// The one place a new path (ARMv8 SHA2 crypto extensions: vsha256hq_u32/vsha256su0q_u32, detected
// with getauxval(AT_HWCAP) & HWCAP_SHA2) would be detected and preferred.
Sha256Path detect_default_path() {
#if defined(__x86_64__)
  if (sha_ni_supported()) {
    return Sha256Path::sha_ni;
  }
#endif
  return Sha256Path::portable;
}

Sha256::BlocksFn blocks_for(Sha256Path path) {
#if defined(__x86_64__)
  if (path == Sha256Path::sha_ni && sha256_path_available(Sha256Path::sha_ni)) {
    return blocks_sha_ni;
  }
#endif
  (void)path;
  return blocks_portable;
}

Sha256::BlocksFn default_blocks() {
  static const Sha256::BlocksFn fn = blocks_for(sha256_default_path());
  return fn;
}

}  // namespace

bool sha256_path_available(Sha256Path path) {
  switch (path) {
    case Sha256Path::portable:
      return true;
    case Sha256Path::sha_ni: {
#if defined(__x86_64__)
      static const bool supported = sha_ni_supported();
      return supported;
#else
      return false;
#endif
    }
  }
  return false;
}

Sha256Path sha256_default_path() {
  static const Sha256Path path = detect_default_path();
  return path;
}

const char *sha256_path_name(Sha256Path path) {
  switch (path) {
    case Sha256Path::portable:
      return "portable";
    case Sha256Path::sha_ni:
      return "sha-ni";
  }
  return "unknown";
}

Sha256::Sha256() : blocks_(default_blocks()), buffer_{} {
  std::memcpy(state_, kInit, sizeof state_);
}

Sha256::Sha256(Sha256Path path) : blocks_(blocks_for(path)), buffer_{} {
  std::memcpy(state_, kInit, sizeof state_);
}

void Sha256::update(const void *data, std::size_t size) {
  const auto *bytes = static_cast<const std::uint8_t *>(data);
  total_bytes_ += size;
  if (buffered_ > 0) {
    const std::size_t take = size < 64 - buffered_ ? size : 64 - buffered_;
    std::memcpy(buffer_ + buffered_, bytes, take);
    buffered_ += take;
    bytes += take;
    size -= take;
    if (buffered_ == 64) {
      blocks_(state_, buffer_, 1);
      buffered_ = 0;
    }
  }
  if (size >= 64) {
    const std::size_t whole = size / 64;
    blocks_(state_, bytes, whole);
    bytes += whole * 64;
    size -= whole * 64;
  }
  if (size > 0) {
    std::memcpy(buffer_, bytes, size);
    buffered_ = size;
  }
}

std::array<std::uint8_t, 32> Sha256::finish() {
  // FIPS 180-4 5.1.1: 0x80, zeros to 56 mod 64, the bit length big-endian.
  const std::uint64_t bits = total_bytes_ * 8;
  buffer_[buffered_++] = 0x80;
  if (buffered_ > 56) {
    std::memset(buffer_ + buffered_, 0, 64 - buffered_);
    blocks_(state_, buffer_, 1);
    buffered_ = 0;
  }
  std::memset(buffer_ + buffered_, 0, 56 - buffered_);
  for (int i = 0; i < 8; ++i) {
    buffer_[56 + i] = static_cast<std::uint8_t>(bits >> (56 - 8 * i));
  }
  blocks_(state_, buffer_, 1);
  buffered_ = 0;
  std::array<std::uint8_t, 32> digest{};
  for (int i = 0; i < 8; ++i) {
    digest[4 * i] = static_cast<std::uint8_t>(state_[i] >> 24);
    digest[4 * i + 1] = static_cast<std::uint8_t>(state_[i] >> 16);
    digest[4 * i + 2] = static_cast<std::uint8_t>(state_[i] >> 8);
    digest[4 * i + 3] = static_cast<std::uint8_t>(state_[i]);
  }
  return digest;
}

std::string sha256_hex(const std::array<std::uint8_t, 32> &digest) {
  static const char kDigits[] = "0123456789abcdef";
  std::string out;
  out.reserve(64);
  for (std::uint8_t byte : digest) {
    out.push_back(kDigits[byte >> 4]);
    out.push_back(kDigits[byte & 0xf]);
  }
  return out;
}

std::string sha256_hex(const void *data, std::size_t size) {
  Sha256 hash;
  hash.update(data, size);
  return sha256_hex(hash.finish());
}

}  // namespace grc
