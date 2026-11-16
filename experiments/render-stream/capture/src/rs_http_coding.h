// HTTP content codings for resource GETs
// (render-stream-2.md "HTTP (live)"): zstd (level 3) and gzip (level 6) over the vendored zstd 1.5.7
// and zlib 1.3.1 (capture/vendor/PROVENANCE.md). Engine-free and thread-safe (no shared state).
// The decoders exist for the tests and the sabotage checks; the host only compresses.
#ifndef GRC_RS_HTTP_CODING_H
#define GRC_RS_HTTP_CODING_H

#include <atomic>
#include <cstddef>
#include <cstdint>
#include <functional>
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

// One RFC 1952 gzip member made in parallel, pigz-style: `data` is cut into blocks of
// `block_bytes`, each deflated on its own (raw deflate primed with the 32 KiB before it, so the
// split costs almost no ratio) and ended byte-aligned with a sync flush, the last one with the
// final block. The blocks are spliced behind one header, and the trailer's CRC-32 is the blocks'
// CRCs combined (crc32_combine). Any gzip reader decodes the result as one stream.
struct GzipParallel {
  int level = 1;
  std::size_t block_bytes = std::size_t{1} << 20;
  int threads = 4;  // the calling thread plus threads-1 joined before return (capped at the blocks)
  // Unset: `data` is whole. Set: called before a block is read with the end of the bytes it reads
  // (its dictionary comes before it); it returns once data[0, end) is written, or false when it
  // never will be (the encode then fails). Lets the encode follow a source still being inflated.
  std::function<bool(std::size_t end)> ready;
};
// `emit` gets the member's bytes in order, one chunk per block (the header rides on the first,
// the trailer on the last), as soon as that block and every one before it are done: called on the
// thread that finished it, never two at once. False when deflate failed or `cancel` was seen set
// before a block started; the chunks emitted until then are not a whole member.
// zstd_decompress into a caller's buffer of exactly the frame's content size, in steps: after
// each step `progress(written)` is told how many leading bytes are final, and returning false
// stops the inflate (false). Lets a reader start on the front while the rest is inflated.
bool zstd_decompress_progressive(const std::uint8_t *data, std::size_t size, std::uint8_t *out,
                                 std::size_t out_size, const std::function<bool(std::size_t)> &progress);

bool gzip_parallel(const std::uint8_t *data, std::size_t size, const GzipParallel &config,
                   const std::function<void(std::vector<std::uint8_t> &&)> &emit,
                   const std::atomic<bool> *cancel = nullptr);

}  // namespace http_coding
}  // namespace rs
}  // namespace grc

#endif  // GRC_RS_HTTP_CODING_H
