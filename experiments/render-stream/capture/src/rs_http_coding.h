// HTTP content codings for resource GETs (G8kz; texture-delivery-design.md D2, Q5;
// render-stream-2.md "HTTP (live)"): zstd (level 3) and gzip (level 6) over the vendored zstd 1.5.7
// and zlib 1.3.1 (capture/vendor/PROVENANCE.md). Engine-free and thread-safe (no shared state).
// The decoders exist for the tests and the sabotage checks; the host only compresses.
#ifndef GRC_RS_HTTP_CODING_H
#define GRC_RS_HTTP_CODING_H

#include <cstddef>
#include <cstdint>
#include <vector>

namespace grc {
namespace rs {
namespace http_coding {

constexpr int kZstdLevel = 3;
constexpr int kGzipLevel = 6;

// Each returns false (and leaves *out empty) on failure. gzip is RFC 1952 (header + deflate +
// CRC32), what browsers and Godot's COMPRESSION_GZIP read.
bool zstd_compress(const std::uint8_t *data, std::size_t size, std::vector<std::uint8_t> *out);
bool gzip_compress(const std::uint8_t *data, std::size_t size, std::vector<std::uint8_t> *out);
bool zstd_decompress(const std::uint8_t *data, std::size_t size, std::vector<std::uint8_t> *out);
bool gzip_decompress(const std::uint8_t *data, std::size_t size, std::vector<std::uint8_t> *out);

}  // namespace http_coding
}  // namespace rs
}  // namespace grc

#endif  // GRC_RS_HTTP_CODING_H
