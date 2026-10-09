// SHA-256 (FIPS 180-4), dependency-free (gate2-design.md G2a).
//
// Texture payloads are content-addressed by the lowercase hex SHA-256 of their
// canonical `render-stream-texture/1` bytes (render-stream-2.md "Texture
// payload"). The capture hashes each payload on the thread that called the
// RenderingServer, right after copying it, so this is plain, allocation-free
// and reentrant: one Sha256 object per hash, no shared state.
#ifndef GRC_RS_SHA256_H
#define GRC_RS_SHA256_H

#include <array>
#include <cstddef>
#include <cstdint>
#include <string>

namespace grc {

class Sha256 {
 public:
  Sha256();
  void update(const void *data, std::size_t size);
  // Finishes the hash. The object must not be updated afterwards.
  std::array<std::uint8_t, 32> finish();

 private:
  void block(const std::uint8_t *chunk);

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
