// G8kb2 oracle (texture-delivery-design.md "As built (G8kb2)"): basisu 1.60's own transcode of one
// KTX2 to ASTC 4x4, called directly (no GSW wrapper, no target rule), natively. Writes every
// level's blocks to <out>.astc and prints one JSON line with the ASTC decode's PSNR against (a) the
// same file's UASTC decode (cTFRGBA32) and (b) a source pixel file when given (raw RGBA8/RGB8).
//
//   basis-astc-oracle <in.ktx2> <out.astc> [<source.raw> <source_channels> <width> <height>]
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <vector>
#include "transcoder/basisu_transcoder.h"
#include "transcoder/basisu_astc_helpers.h"
using namespace basist;

static std::vector<uint8_t> slurp(const char *p) {
  std::vector<uint8_t> v;
  FILE *f = fopen(p, "rb");
  if (!f) return v;
  uint8_t buf[65536];
  size_t n;
  while ((n = fread(buf, 1, sizeof buf, f)) > 0) v.insert(v.end(), buf, buf + n);
  fclose(f);
  return v;
}

static std::vector<uint8_t> decode_astc(const std::vector<uint8_t> &blocks, uint32_t w, uint32_t h) {
  std::vector<uint8_t> out(size_t(w) * h * 4);
  const uint32_t bw = (w + 3) / 4, bh = (h + 3) / 4;
  for (uint32_t by = 0; by < bh; by++)
    for (uint32_t bx = 0; bx < bw; bx++) {
      astc_helpers::log_astc_block lb;
      uint8_t px[16 * 4];
      if (!astc_helpers::unpack_block(&blocks[(by * bw + bx) * 16], lb, 4, 4) ||
          !astc_helpers::decode_block(lb, px, 4, 4, astc_helpers::cDecodeModeLDR8)) {
        fprintf(stderr, "astc decode failed\n");
        exit(3);
      }
      for (uint32_t y = 0; y < 4 && by * 4 + y < h; y++)
        for (uint32_t x = 0; x < 4 && bx * 4 + x < w; x++)
          memcpy(&out[((by * 4 + y) * w + bx * 4 + x) * 4], &px[(y * 4 + x) * 4], 4);
    }
  return out;
}

static double psnr(const std::vector<uint8_t> &a, const uint8_t *src, uint32_t sch, uint32_t n) {
  double se = 0;
  const uint32_t ch = sch == 4 ? 4 : 3;
  for (uint32_t i = 0; i < n; i++)
    for (uint32_t c = 0; c < ch; c++) {
      double d = double(a[i * 4 + c]) - double(src[i * sch + c]);
      se += d * d;
    }
  const double mse = se / (double(n) * ch);
  return mse == 0 ? 99.0 : 10 * log10(255.0 * 255.0 / mse);
}

int main(int argc, char **argv) {
  if (argc < 3) return 2;
  basisu_transcoder_init();
  astc_helpers::init_tables(true);
  auto in = slurp(argv[1]);
  ktx2_transcoder t;
  if (!t.init(in.data(), uint32_t(in.size())) || !t.start_transcoding()) return 3;
  const uint32_t W = t.get_width(), H = t.get_height(), L = t.get_levels();
  FILE *fo = fopen(argv[2], "wb");
  std::vector<uint8_t> l0;
  for (uint32_t l = 0; l < L; l++) {
    const uint32_t w = std::max(1u, W >> l), h = std::max(1u, H >> l);
    const uint32_t nb = ((w + 3) / 4) * ((h + 3) / 4);
    std::vector<uint8_t> b(nb * 16);
    if (!t.transcode_image_level(l, 0, 0, b.data(), nb, transcoder_texture_format::cTFASTC_4x4_RGBA, 0)) return 4;
    fwrite(b.data(), 1, b.size(), fo);
    if (l == 0) l0 = b;
  }
  fclose(fo);
  std::vector<uint8_t> rgba(size_t(W) * H * 4);
  if (!t.transcode_image_level(0, 0, 0, rgba.data(), W * H, transcoder_texture_format::cTFRGBA32, 0)) return 5;
  auto dec = decode_astc(l0, W, H);
  printf("{\"width\":%u,\"height\":%u,\"levels\":%u,\"psnr_vs_uastc\":%.2f", W, H, L, psnr(dec, rgba.data(), 4, W * H));
  if (argc >= 7) {
    auto src = slurp(argv[3]);
    const uint32_t sch = atoi(argv[4]);
    if (src.size() >= size_t(W) * H * sch) {
      const uint8_t *p = src.data() + (src.size() - size_t(W) * H * sch);
      printf(",\"psnr_vs_source\":%.2f,\"uastc_psnr_vs_source\":%.2f", psnr(dec, p, sch, W * H), psnr(rgba, p, sch, W * H));
    }
  }
  printf("}\n");
  return 0;
}
