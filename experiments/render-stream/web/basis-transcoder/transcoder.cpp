// GSW's KTX2 transcoder (G8kb, protocol/texture-delivery-design.md D14, D15, Q6 "GSW"): basisu
// 1.60's ktx2_transcoder from the vendored third_party/basis_universal (the revision the capture's
// encoder, the native receiver and the web export run), built by scripts/build-basis-transcoder.sh
// with the pinned emscripten 4.0.11 into a standalone wasm with no JS glue, which
// web/basis-transcoder/worker.ts runs in a Web Worker.
//
// One call transcodes every level of one KTX2 file to D14's target: Godot's own KTX2 loader rule
// (modules/ktx/texture_loader_ktx.cpp:255-319, through libktx's ktxTexture2_TranscodeBasis), so
// every receiver class on one GPU holds the same blocks:
//   4 components: astc -> ASTC_4x4, bptc -> BC7, s3tc -> BC3, etc2 -> ETC2_RGBA, else RGBA32
//   3 components: bptc -> BC7, astc -> ASTC_4x4 (G8kb2; Godot's rule has no astc here), s3tc -> BC1, etc2 -> ETC1, else RGBA32
//   2 / 1 components: rgtc -> BC5 / BC4, else RGBA32
//   an sRGB transfer function: RGBA32 (Godot's "TODO srgb native support")
// The component count is libktx's ktxTexture2_GetNumComponents for UASTC (the DFD's first channel
// id: RGBA 4, RGB 3, RRRG and RG 2, RRR 1); decode flags 0, as libktx passes them for Godot.
//
// The exported functions (all extern "C"):
//   bt_init()                         basisu_transcoder_init(), once
//   bt_alloc(n) / bt_free(p)          the input buffer the caller writes the KTX2 into
//   bt_transcode(p, n, families)      0 ok, < 0 a failure (bt_error_code names it); `families` is
//                                     a bit set of the context's gpu_formats: 1 s3tc, 2 bptc,
//                                     4 rgtc, 8 etc2, 16 astc
//   bt_out_ptr() / bt_out_len()       every level's output, level 0 first, tightly packed
//   bt_info(i)                        0 width, 1 height, 2 levels, 3 the target (basist's
//                                     transcoder_texture_format), 4 components, 5 level 0 bytes
//   bt_error_code()                   the last failure's stage (1 init, 2 shape, 3 start,
//                                     4 level, 5 alloc)

#include "transcoder/basisu_transcoder.h"

#include <cstdint>
#include <cstdlib>
#include <cstring>

namespace {

enum Family : uint32_t { S3TC = 1, BPTC = 2, RGTC = 4, ETC2 = 8, ASTC = 16 };

uint8_t *g_out = nullptr;
uint32_t g_out_len = 0;
uint32_t g_info[6] = {0, 0, 0, 0, 0, 0};
int g_error = 0;

uint32_t components(const basist::ktx2_transcoder &t) {
  switch (t.get_dfd_channel_id0()) {
  case basist::KTX2_DF_CHANNEL_UASTC_RGBA:
    return 4;
  case basist::KTX2_DF_CHANNEL_UASTC_RRRG:
  case basist::KTX2_DF_CHANNEL_UASTC_RG:
    return 2;
  case basist::KTX2_DF_CHANNEL_UASTC_RRR:
    return 1;
  default: // KTX2_DF_CHANNEL_UASTC_RGB (0)
    return 3;
  }
}

basist::transcoder_texture_format target(uint32_t comps, bool srgb, uint32_t f) {
  using F = basist::transcoder_texture_format;
  if (srgb)
    return F::cTFRGBA32;
  switch (comps) {
  case 1:
    return (f & RGTC) ? F::cTFBC4_R : F::cTFRGBA32;
  case 2:
    return (f & RGTC) ? F::cTFBC5_RG : F::cTFRGBA32;
  case 3:
    if (f & BPTC)
      return F::cTFBC7_RGBA;
    if (f & ASTC) // G8kb2: GSW departs from Godot's rule here; UASTC -> ASTC 4x4 is a near-lossless repack
      return F::cTFASTC_4x4_RGBA;
    if (f & S3TC)
      return F::cTFBC1_RGB;
    if (f & ETC2)
      return F::cTFETC1_RGB;
    return F::cTFRGBA32;
  default:
    if (f & ASTC)
      return F::cTFASTC_4x4_RGBA;
    if (f & BPTC)
      return F::cTFBC7_RGBA;
    if (f & S3TC)
      return F::cTFBC3_RGBA;
    if (f & ETC2)
      return F::cTFETC2_RGBA;
    return F::cTFRGBA32;
  }
}

// One level's output size: blocks (4x4) for a block format, pixels for RGBA32.
uint64_t level_bytes(basist::transcoder_texture_format fmt, uint32_t w, uint32_t h) {
  const uint64_t unit = basist::basis_get_bytes_per_block_or_pixel(fmt);
  if (basist::basis_transcoder_format_is_uncompressed(fmt))
    return unit * w * h;
  return unit * ((w + 3) / 4) * ((h + 3) / 4);
}

int fail(int code) {
  g_error = code;
  return -code;
}

} // namespace

extern "C" {

__attribute__((export_name("bt_init"))) void bt_init() { basist::basisu_transcoder_init(); }

__attribute__((export_name("bt_alloc"))) void *bt_alloc(uint32_t n) { return std::malloc(n ? n : 1); }

__attribute__((export_name("bt_free"))) void bt_free(void *p) { std::free(p); }

__attribute__((export_name("bt_out_ptr"))) uint8_t *bt_out_ptr() { return g_out; }

__attribute__((export_name("bt_out_len"))) uint32_t bt_out_len() { return g_out_len; }

__attribute__((export_name("bt_info"))) uint32_t bt_info(uint32_t i) { return i < 6 ? g_info[i] : 0; }

__attribute__((export_name("bt_error_code"))) int bt_error_code() { return g_error; }

__attribute__((export_name("bt_transcode"))) int bt_transcode(const uint8_t *data, uint32_t len,
                                                             uint32_t families) {
  g_error = 0;
  std::free(g_out);
  g_out = nullptr;
  g_out_len = 0;
  std::memset(g_info, 0, sizeof(g_info));
  basist::ktx2_transcoder t;
  if (!t.init(data, len))
    return fail(1);
  // render-stream/9's KTX2 profile (D13): one 2D UASTC LDR image, no layers, one face.
  if (!t.is_uastc() || t.get_faces() != 1 || t.get_layers() > 1 || t.get_levels() < 1)
    return fail(2);
  if (!t.start_transcoding())
    return fail(3);
  const uint32_t comps = components(t);
  const bool srgb = t.get_dfd_transfer_func() == basist::KTX2_KHR_DF_TRANSFER_SRGB;
  const basist::transcoder_texture_format fmt = target(comps, srgb, families);
  const uint32_t levels = t.get_levels();
  uint64_t total = 0;
  for (uint32_t l = 0; l < levels; l++) {
    const uint32_t w = t.get_width() >> l ? t.get_width() >> l : 1;
    const uint32_t h = t.get_height() >> l ? t.get_height() >> l : 1;
    total += level_bytes(fmt, w, h);
  }
  if (total == 0 || total > 0x7fffffffu)
    return fail(5);
  g_out = static_cast<uint8_t *>(std::malloc(total));
  if (!g_out)
    return fail(5);
  const uint32_t unit = basist::basis_get_bytes_per_block_or_pixel(fmt);
  uint64_t at = 0;
  for (uint32_t l = 0; l < levels; l++) {
    const uint32_t w = t.get_width() >> l ? t.get_width() >> l : 1;
    const uint32_t h = t.get_height() >> l ? t.get_height() >> l : 1;
    const uint64_t n = level_bytes(fmt, w, h);
    if (!t.transcode_image_level(l, 0, 0, g_out + at, static_cast<uint32_t>(n / unit), fmt, 0))
      return fail(4);
    at += n;
  }
  g_out_len = static_cast<uint32_t>(total);
  g_info[0] = t.get_width();
  g_info[1] = t.get_height();
  g_info[2] = levels;
  g_info[3] = static_cast<uint32_t>(fmt);
  g_info[4] = comps;
  g_info[5] = static_cast<uint32_t>(level_bytes(fmt, t.get_width(), t.get_height()));
  return 0;
}

} // extern "C"
