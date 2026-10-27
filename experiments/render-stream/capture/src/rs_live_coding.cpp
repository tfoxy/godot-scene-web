#include "rs_live_coding.h"

#include <zstd.h>

#include <cstring>
#include <memory>

namespace grc {
namespace rs {
namespace live_coding {

namespace {

struct CCtxFree {
  void operator()(ZSTD_CCtx *c) const { ZSTD_freeCCtx(c); }
};
struct DCtxFree {
  void operator()(ZSTD_DCtx *d) const { ZSTD_freeDCtx(d); }
};

ZSTD_CCtx *cctx() {
  thread_local std::unique_ptr<ZSTD_CCtx, CCtxFree> ctx(ZSTD_createCCtx());
  return ctx.get();
}

ZSTD_DCtx *dctx() {
  thread_local std::unique_ptr<ZSTD_DCtx, DCtxFree> ctx(ZSTD_createDCtx());
  return ctx.get();
}

void put_u32(std::vector<std::uint8_t> *out, std::uint32_t v) {
  for (int i = 0; i < 4; ++i) out->push_back(static_cast<std::uint8_t>(v >> (8 * i)));
}

void put_u64(std::vector<std::uint8_t> *out, std::uint64_t v) {
  for (int i = 0; i < 8; ++i) out->push_back(static_cast<std::uint8_t>(v >> (8 * i)));
}

std::uint32_t get_u32(const std::uint8_t *p) {
  return static_cast<std::uint32_t>(p[0]) | (static_cast<std::uint32_t>(p[1]) << 8) |
         (static_cast<std::uint32_t>(p[2]) << 16) | (static_cast<std::uint32_t>(p[3]) << 24);
}

std::uint64_t get_u64(const std::uint8_t *p) {
  return static_cast<std::uint64_t>(get_u32(p)) | (static_cast<std::uint64_t>(get_u32(p + 4)) << 32);
}

// Appends one frame of data to *out (base: the raw prefix, or null).
bool compress_frame(const std::uint8_t *data, std::size_t size, const std::uint8_t *base,
                    std::size_t base_size, std::vector<std::uint8_t> *out) {
  ZSTD_CCtx *c = cctx();
  if (c == nullptr) return false;
  ZSTD_CCtx_reset(c, ZSTD_reset_session_and_parameters);
  if (ZSTD_isError(ZSTD_CCtx_setParameter(c, ZSTD_c_compressionLevel, kLevel)) ||
      ZSTD_isError(ZSTD_CCtx_setParameter(c, ZSTD_c_checksumFlag, 1)) ||
      ZSTD_isError(ZSTD_CCtx_setParameter(c, ZSTD_c_contentSizeFlag, 1))) {
    return false;
  }
  if (base != nullptr && ZSTD_isError(ZSTD_CCtx_refPrefix(c, base, base_size))) {
    return false;
  }
  const std::size_t at = out->size();
  out->resize(at + ZSTD_compressBound(size));
  const std::size_t n = ZSTD_compress2(c, out->data() + at, out->size() - at, data, size);
  if (ZSTD_isError(n)) return false;
  out->resize(at + n);
  return true;
}

}  // namespace

const char *to_token(Coding coding) {
  switch (coding) {
    case Coding::Zstd:
      return "zstd";
    case Coding::ZstdBase:
      return "zstd-base";
    case Coding::Off:
      break;
  }
  return "off";
}

bool parse_env(const char *text, Coding *out, std::string *error) {
  const std::string v = text != nullptr ? std::string(text) : std::string();
  if (v.empty() || v == "zstd-base") {
    *out = Coding::ZstdBase;
  } else if (v == "zstd") {
    *out = Coding::Zstd;
  } else if (v == "off") {
    *out = Coding::Off;
  } else {
    *error = "invalid GRC_LIVE_CODING=" + v + " (zstd-base, zstd or off)";
    return false;
  }
  return true;
}

bool valid_offer(const std::string &offer) {
  if (offer.empty() || offer.size() > 96) return false;
  bool token_start = true;
  for (char ch : offer) {
    if (ch == ',') {
      if (token_start) return false;
      token_start = true;
    } else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9') || ch == '-') {
      token_start = false;
    } else {
      return false;
    }
  }
  return !token_start;
}

Coding negotiate(Coding host, const std::string &offer) {
  bool base = false;
  bool plain = false;
  std::size_t start = 0;
  while (start <= offer.size()) {
    std::size_t end = offer.find(',', start);
    if (end == std::string::npos) end = offer.size();
    const std::string token = offer.substr(start, end - start);
    base = base || token == "zstd-base";
    plain = plain || token == "zstd";
    start = end + 1;
  }
  if (host == Coding::ZstdBase && base) return Coding::ZstdBase;
  if ((host == Coding::ZstdBase || host == Coding::Zstd) && plain) return Coding::Zstd;
  return Coding::Off;
}

bool encode_plain(const std::uint8_t *data, std::size_t size, std::vector<std::uint8_t> *out) {
  out->clear();
  if (!compress_frame(data, size, nullptr, 0, out)) {
    out->clear();
    return false;
  }
  return true;
}

bool encode_transaction(const std::uint8_t *data, std::size_t size, std::uint64_t seq,
                        const std::uint8_t *base, std::size_t base_size, std::uint64_t base_seq,
                        std::vector<std::uint8_t> *out) {
  out->clear();
  out->reserve(kEnvelopeBytes + size / 4 + 64);
  put_u32(out, kEnvelopeMagic);
  put_u32(out, 16);
  put_u64(out, seq);
  put_u64(out, base_seq);
  if (!compress_frame(data, size, base, base_size, out)) {
    out->clear();
    return false;
  }
  return true;
}

bool decode(const std::uint8_t *msg, std::size_t size, const std::vector<std::uint8_t> *base,
            std::vector<std::uint8_t> *out, std::uint64_t *seq, std::uint64_t *base_seq,
            std::string *error) {
  out->clear();
  *seq = 0;
  *base_seq = 0;
  if (size < 4) {
    *error = "a coded message is at least 4 bytes";
    return false;
  }
  const std::uint8_t *frame = msg;
  std::size_t frame_size = size;
  if (get_u32(msg) == kEnvelopeMagic) {
    if (size < kEnvelopeBytes || get_u32(msg + 4) != 16) {
      *error = "the transaction envelope is not a 16-byte skippable frame";
      return false;
    }
    *seq = get_u64(msg + 8);
    *base_seq = get_u64(msg + 16);
    frame = msg + kEnvelopeBytes;
    frame_size = size - kEnvelopeBytes;
  }
  if (frame_size < 4 || get_u32(frame) != kZstdMagic) {
    *error = "no zstd frame where one is expected";
    return false;
  }
  if (*base_seq != 0 && (base == nullptr)) {
    *error = "base " + std::to_string(*base_seq) + " is not available";
    return false;
  }
  const unsigned long long known = ZSTD_getFrameContentSize(frame, frame_size);
  if (known == ZSTD_CONTENTSIZE_ERROR || known == ZSTD_CONTENTSIZE_UNKNOWN || known == 0) {
    *error = "the zstd frame declares no content size";
    return false;
  }
  if (ZSTD_findFrameCompressedSize(frame, frame_size) != frame_size) {
    *error = "a coded message is exactly one zstd frame";
    return false;
  }
  ZSTD_DCtx *d = dctx();
  ZSTD_DCtx_reset(d, ZSTD_reset_session_and_parameters);
  if (*base_seq != 0 && ZSTD_isError(ZSTD_DCtx_refPrefix(d, base->data(), base->size()))) {
    *error = "refPrefix failed";
    return false;
  }
  out->resize(static_cast<std::size_t>(known));
  const std::size_t n = ZSTD_decompressDCtx(d, out->data(), out->size(), frame, frame_size);
  if (ZSTD_isError(n) || n != out->size()) {
    *error = std::string("zstd: ") + (ZSTD_isError(n) ? ZSTD_getErrorName(n) : "short output");
    out->clear();
    return false;
  }
  return true;
}

}  // namespace live_coding
}  // namespace rs
}  // namespace grc
