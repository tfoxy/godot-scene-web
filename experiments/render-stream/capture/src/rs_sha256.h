// SHA-256 (FIPS 180-4), dependency-free (gate2-design.md G2a).
//
// Texture payloads are content-addressed by the lowercase hex SHA-256 of their
// canonical `render-stream-texture/1` bytes (render-stream-2.md "Texture
// payload"). The capture hashes each payload on the thread that called the
// RenderingServer, right after copying it, so this is plain, allocation-free
// and reentrant: one Sha256 object per hash, no shared state.
//
// G8sha: the compression function has two paths with bit-identical output. `portable` is the
// original plain C++ (~345 MB/s); `sha_ni` uses the x86 SHA extensions (sha256rnds2/msg1/msg2,
// ~2 GB/s on Zen 3). A default-constructed Sha256 uses sha256_default_path(): sha_ni when CPUID
// says the CPU has SHA, SSSE3 and SSE4.1, else portable, decided once per process, never failing.
// The capture is x86-64 only (CMakeLists.txt); an ARMv8 crypto-extension path would be a third
// Sha256Path value selected in rs_sha256.cpp's detect_default_path(), behind the same API.
#ifndef GRC_RS_SHA256_H
#define GRC_RS_SHA256_H

#include <array>
#include <cstddef>
#include <cstdint>
#include <string>

namespace grc {

enum class Sha256Path : std::uint8_t {
  portable,
  sha_ni,
};

// Whether this CPU can run `path` (portable: always).
bool sha256_path_available(Sha256Path path);
// The path a default-constructed Sha256 uses (detected once, then cached).
Sha256Path sha256_default_path();
// "portable" or "sha-ni".
const char *sha256_path_name(Sha256Path path);

class Sha256 {
 public:
  Sha256();
  // Forces a path (the tests and the bench). An unavailable path falls back to portable, so a
  // forced hash never faults; callers that must know check sha256_path_available() first.
  explicit Sha256(Sha256Path path);
  void update(const void *data, std::size_t size);
  // Finishes the hash. The object must not be updated afterwards.
  std::array<std::uint8_t, 32> finish();

  // Compresses `blocks` consecutive 64-byte blocks at `data` into `state`.
  using BlocksFn = void (*)(std::uint32_t state[8], const std::uint8_t *data, std::size_t blocks);

 private:
  BlocksFn blocks_;
  std::uint32_t state_[8];
  std::uint8_t buffer_[64];
  std::size_t buffered_ = 0;
  std::uint64_t total_bytes_ = 0;
};

// Lowercase hex of a digest.
std::string sha256_hex(const std::array<std::uint8_t, 32> &digest);

// One-shot lowercase hex SHA-256 of `size` bytes at `data`.
std::string sha256_hex(const void *data, std::size_t size);

}  // namespace grc

#endif  // GRC_RS_SHA256_H
