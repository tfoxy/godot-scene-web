#include "rs_http_coding.h"

#include <zlib.h>
#include <zstd.h>

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

}  // namespace http_coding
}  // namespace rs
}  // namespace grc
