#include "rs_http_coding.h"

#include <zlib.h>
// ZSTD_d_stableOutBuffer (experimental in 1.5.7; this is the vendored static copy, never a shared
// library whose ABI could move under it).
#define ZSTD_STATIC_LINKING_ONLY
#include <zstd.h>

#include <algorithm>
#include <mutex>
#include <system_error>
#include <thread>

namespace grc {
namespace rs {
namespace http_coding {

bool zstd_compress(const std::uint8_t *data, std::size_t size, std::vector<std::uint8_t> *out) {
  out->clear();
  out->resize(ZSTD_compressBound(size));
  const std::size_t n = ZSTD_compress(out->data(), out->size(), data, size, kZstdLevel);
  if (ZSTD_isError(n)) {
    out->clear();
    return false;
  }
  out->resize(n);
  return true;
}

bool zstd_decompress(const std::uint8_t *data, std::size_t size, std::vector<std::uint8_t> *out) {
  out->clear();
  const unsigned long long known = ZSTD_getFrameContentSize(data, size);
  if (known == ZSTD_CONTENTSIZE_ERROR || known == ZSTD_CONTENTSIZE_UNKNOWN) {
    return false;  // the host always writes the content size
  }
  out->resize(static_cast<std::size_t>(known));
  const std::size_t n = ZSTD_decompress(out->data(), out->size(), data, size);
  if (ZSTD_isError(n) || n != out->size()) {
    out->clear();
    return false;
  }
  return true;
}

bool gzip_compress(const std::uint8_t *data, std::size_t size, std::vector<std::uint8_t> *out) {
  out->clear();
  z_stream z = {};
  // windowBits 15 + 16: a gzip wrapper. memLevel 8 is zlib's default.
  if (deflateInit2(&z, kGzipLevel, Z_DEFLATED, 15 + 16, 8, Z_DEFAULT_STRATEGY) != Z_OK) {
    return false;
  }
  out->resize(deflateBound(&z, static_cast<uLong>(size)) + 32);
  z.next_in = const_cast<Bytef *>(data);
  z.avail_in = static_cast<uInt>(size);
  z.next_out = out->data();
  z.avail_out = static_cast<uInt>(out->size());
  const int rc = deflate(&z, Z_FINISH);
  const std::size_t produced = out->size() - z.avail_out;
  deflateEnd(&z);
  if (rc != Z_STREAM_END) {
    out->clear();
    return false;
  }
  out->resize(produced);
  return true;
}

bool gzip_decompress(const std::uint8_t *data, std::size_t size, std::vector<std::uint8_t> *out) {
  out->clear();
  z_stream z = {};
  if (inflateInit2(&z, 15 + 16) != Z_OK) {
    return false;
  }
  z.next_in = const_cast<Bytef *>(data);
  z.avail_in = static_cast<uInt>(size);
  std::vector<std::uint8_t> chunk(1u << 16);
  int rc = Z_OK;
  while (rc == Z_OK) {
    z.next_out = chunk.data();
    z.avail_out = static_cast<uInt>(chunk.size());
    rc = inflate(&z, Z_NO_FLUSH);
    out->insert(out->end(), chunk.begin(), chunk.end() - z.avail_out);
  }
  inflateEnd(&z);
  if (rc != Z_STREAM_END) {
    out->clear();
    return false;
  }
  return true;
}

bool zstd_decompress_progressive(const std::uint8_t *data, std::size_t size, std::uint8_t *out,
                                 std::size_t out_size, const std::function<bool(std::size_t)> &progress) {
  const unsigned long long known = ZSTD_getFrameContentSize(data, size);
  if (known == ZSTD_CONTENTSIZE_ERROR || known == ZSTD_CONTENTSIZE_UNKNOWN || known != out_size) {
    return false;
  }
  ZSTD_DCtx *ctx = ZSTD_createDCtx();
  if (ctx == nullptr) return false;
  // The output buffer never moves between steps, so zstd decodes straight into it instead of
  // through its own window buffer and a copy.
  ZSTD_DCtx_setParameter(ctx, ZSTD_d_stableOutBuffer, 1);
  // Input in small steps, so each step's output (about the ratio times this) reaches the reader soon.
  constexpr std::size_t kStep = 16u << 10;
  ZSTD_inBuffer in = {data, 0, 0};
  ZSTD_outBuffer o = {out, out_size, 0};
  bool ok = true;
  std::size_t rc = 1;
  while (rc != 0) {
    in.size = std::min(size, in.pos + kStep);
    const std::size_t before_in = in.pos, before_out = o.pos;
    rc = ZSTD_decompressStream(ctx, &o, &in);
    if (ZSTD_isError(rc) || (in.pos == before_in && o.pos == before_out && in.size == size)) {
      ok = false;  // an error, or no progress with all input given (truncated)
      break;
    }
    if (o.pos != before_out && !progress(o.pos)) {
      ok = false;
      break;
    }
  }
  ZSTD_freeDCtx(ctx);
  return ok && o.pos == out_size && in.pos == size;
}

bool gzip_parallel(const std::uint8_t *data, std::size_t size, const GzipParallel &config,
                   const std::function<void(std::vector<std::uint8_t> &&)> &emit,
                   const std::atomic<bool> *cancel) {
  constexpr std::size_t kHeader = 10, kTrailer = 8, kWindow = 32768;
  // zlib takes 32-bit lengths. A block under a window primes the next with what precedes it.
  const std::size_t block = std::clamp<std::size_t>(config.block_bytes, 1, std::size_t{64} << 20);
  const std::size_t blocks = size == 0 ? 1 : (size + block - 1) / block;
  const int level = std::clamp(config.level, 1, 9);
  struct Done {
    std::vector<std::uint8_t> bytes;  // the block's chunk: header (first) + deflate + room for the trailer (last)
    uLong crc = 0;
    std::size_t len = 0;
    bool ready = false;
  };
  std::vector<Done> done(blocks);
  std::atomic<std::size_t> next{0};
  std::atomic<bool> failed{false};
  std::mutex release_mutex;
  std::size_t released = 0;     // under release_mutex
  uLong crc = crc32(0, Z_NULL, 0);  // of every released block, under release_mutex

  // Files block `i` and emits every block now ready in order (the last with the member's trailer).
  const auto release = [&](std::size_t i, Done &&d) {
    std::lock_guard<std::mutex> lock(release_mutex);
    done[i] = std::move(d);
    done[i].ready = true;
    while (released < blocks && done[released].ready && !failed.load(std::memory_order_acquire)) {
      Done &r = done[released];
      crc = crc32_combine(crc, r.crc, static_cast<z_off_t>(r.len));
      if (released + 1 == blocks) {
        std::uint8_t *t = r.bytes.data() + r.bytes.size() - kTrailer;
        const std::uint64_t isize = static_cast<std::uint64_t>(size);
        for (int k = 0; k < 4; ++k) {
          t[k] = static_cast<std::uint8_t>((crc >> (8 * k)) & 0xff);
          t[4 + k] = static_cast<std::uint8_t>((isize >> (8 * k)) & 0xff);
        }
      }
      emit(std::move(r.bytes));
      r.bytes = std::vector<std::uint8_t>();
      ++released;
    }
  };

  const auto work = [&] {
    z_stream z = {};
    bool init = false;
    std::vector<std::uint8_t> scratch;
    for (;;) {
      if (failed.load(std::memory_order_acquire)) break;
      if (cancel != nullptr && cancel->load(std::memory_order_acquire)) {
        failed.store(true, std::memory_order_release);
        break;
      }
      const std::size_t i = next.fetch_add(1, std::memory_order_relaxed);
      if (i >= blocks) break;
      const std::size_t off = i * block;
      const std::size_t len = std::min(block, size - std::min(size, off));
      if (config.ready && !config.ready(off + len)) {
        failed.store(true, std::memory_order_release);
        break;
      }
      // Raw deflate (no zlib or gzip wrapper of its own): the member's header and trailer are ours.
      const int rc0 = init ? deflateReset(&z) : deflateInit2(&z, level, Z_DEFLATED, -15, 8, Z_DEFAULT_STRATEGY);
      init = init || rc0 == Z_OK;
      if (rc0 != Z_OK ||
          (off > 0 && deflateSetDictionary(&z, data + off - std::min(kWindow, off),
                                           static_cast<uInt>(std::min(kWindow, off))) != Z_OK)) {
        failed.store(true, std::memory_order_release);
        break;
      }
      const bool first = i == 0, last = i + 1 == blocks;
      const std::size_t head = first ? kHeader : 0, tail = last ? kTrailer : 0;
      // deflateBound covers a finished stream; a sync flush adds its empty stored block (5 bytes)
      // and the bits pending before it.
      const std::size_t room = deflateBound(&z, static_cast<uLong>(len)) + 16;
      if (scratch.size() < room) scratch.resize(room);
      z.next_in = const_cast<Bytef *>(data + off);
      z.avail_in = static_cast<uInt>(len);
      z.next_out = scratch.data();
      z.avail_out = static_cast<uInt>(room);
      const int rc = deflate(&z, last ? Z_FINISH : Z_SYNC_FLUSH);
      const bool ok = last ? rc == Z_STREAM_END : rc == Z_OK && z.avail_in == 0 && z.avail_out > 0;
      if (!ok) {
        failed.store(true, std::memory_order_release);
        break;
      }
      const std::size_t produced = room - z.avail_out;
      Done d;
      d.bytes.resize(head + produced + tail);  // exact: a chunk never holds the bound's slack
      if (first) {
        // ID1 ID2, CM deflate, no flags, MTIME 0, XFL (4: fastest, 2: best), OS unknown.
        const std::uint8_t header[kHeader] = {0x1f, 0x8b, 8, 0, 0, 0, 0, 0,
                                              static_cast<std::uint8_t>(level == 1 ? 4 : level == 9 ? 2 : 0),
                                              0xff};
        std::copy(header, header + kHeader, d.bytes.begin());
      }
      std::copy(scratch.begin(), scratch.begin() + static_cast<std::ptrdiff_t>(produced),
                d.bytes.begin() + static_cast<std::ptrdiff_t>(head));
      d.crc = crc32(0, data + off, static_cast<uInt>(len));
      d.len = len;
      release(i, std::move(d));
    }
    if (init) deflateEnd(&z);
  };

  std::vector<std::thread> helpers;
  const std::size_t want = std::min<std::size_t>(blocks, static_cast<std::size_t>(std::max(1, config.threads)));
  for (std::size_t t = 1; t < want; ++t) {
    try {
      helpers.emplace_back(work);
    } catch (const std::system_error &) {
      break;  // fewer threads: the blocks still all get done
    }
  }
  work();
  for (std::thread &t : helpers) t.join();
  std::lock_guard<std::mutex> lock(release_mutex);
  return !failed.load(std::memory_order_acquire) && released == blocks;
}

}  // namespace http_coding
}  // namespace rs
}  // namespace grc
