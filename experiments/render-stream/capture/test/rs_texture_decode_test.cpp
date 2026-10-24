// Unit tests for the host-decode seam (src/rs_texture_decode.*; gate8-design.md D8, Q3; G8t),
// against a fake backend: the engine's Image::decompress runs only inside Godot (run-gate8.sh).

#include <cstdint>
#include <cstdio>
#include <memory>
#include <vector>

#include "rs_texture_decode.h"

namespace {

using grc::rs::DecodedImage;
using grc::rs::DecodeRequest;
using grc::rs::DecodeResult;

int g_failures = 0;

void check(bool condition, const char *what) {
  if (!condition) {
    std::fprintf(stderr, "FAIL %s\n", what);
    ++g_failures;
  }
}

// What the fake backend returns: an RGBA8 4x4 image of 0x40 bytes, unless told otherwise.
std::int64_t g_fake_format = 5;
std::int32_t g_fake_width = 4;
bool g_fake_ok = true;
int g_backend_calls = 0;

bool fake_backend(void *image, DecodedImage *out) {
  (void)image;
  ++g_backend_calls;
  if (!g_fake_ok) {
    return false;
  }
  auto bytes = std::make_shared<std::vector<std::uint8_t>>(64, 0x40);
  out->format = g_fake_format;
  out->width = g_fake_width;
  out->height = 4;
  out->mipmaps = false;
  out->data = bytes->data();
  out->data_size = static_cast<std::int64_t>(bytes->size());
  out->hold = bytes;
  return true;
}

DecodeRequest request(std::int64_t format) {
  DecodeRequest r;
  r.format = format;
  r.width = 4;
  r.height = 4;
  r.frame = 10;
  return r;
}

void test_table() {
  using grc::rs::decode_target_format;
  // bcdec
  check(decode_target_format(17) == 5, "DXT1 -> RGBA8");
  check(decode_target_format(18) == 5, "DXT3 -> RGBA8");
  check(decode_target_format(19) == 5, "DXT5 -> RGBA8");
  check(decode_target_format(20) == 2, "RGTC_R -> R8");
  check(decode_target_format(21) == 3, "RGTC_RG -> RG8");
  check(decode_target_format(22) == 5, "BPTC_RGBA -> RGBA8");
  // etcpak and astcenc
  for (const std::int64_t f : {25, 26, 28, 30, 31, 35, 37}) {
    check(decode_target_format(f) == 5, "ETC/ETC2/ASTC LDR -> RGBA8");
  }
  // G8f: the HDR formats decode to half floats (BC6H -> RGBH, ASTC HDR -> RGBAH)
  check(decode_target_format(23) == 14, "BPTC_RGBF -> RGBH");
  check(decode_target_format(24) == 14, "BPTC_RGBFU -> RGBH");
  check(decode_target_format(36) == 15, "ASTC_4x4_HDR -> RGBAH");
  check(decode_target_format(38) == 15, "ASTC_8x8_HDR -> RGBAH");
  // declined: swizzles, formats etcpak cannot decode, uncompressed (floats included)
  for (const std::int64_t f : {33, 34, 27, 29, 32, 0, 5, 6, 7, 8, 11, 15, 16, -1, 39}) {
    check(decode_target_format(f) == -1, "declined source format");
  }
}

void test_decode() {
  grc::rs::texture_decode_set_backend(&fake_backend);
  g_backend_calls = 0;
  check(!grc::rs::texture_decode(request(17)).handled && g_backend_calls == 0,
        "disabled: declines without calling the backend");
  grc::rs::texture_decode_set_enabled(true);
  check(!grc::rs::texture_decode(request(6)).handled && g_backend_calls == 0,
        "RGBA4444 is not block-compressed: declined by the table");
  check(!grc::rs::texture_decode(request(32)).handled && g_backend_calls == 0,
        "ETC2_RGB8A1 (no etcpak decoder) is declined by the table");
  const DecodeResult ok = grc::rs::texture_decode(request(19));
  check(ok.handled && ok.format == 5 && ok.width == 4 && ok.height == 4 && ok.data_size == 64 &&
            ok.data != nullptr && ok.data[0] == 0x40 && ok.hold != nullptr && ok.decode_ns >= 0 &&
            !ok.perturbed,
        "DXT5 decodes to the backend's RGBA8 bytes");
  g_fake_format = 19;  // the engine left the image compressed (a missing or failed decoder)
  const DecodeResult same = grc::rs::texture_decode(request(19));
  check(!same.handled && same.decode_ns >= 0, "a decode that kept the source format is refused");
  g_fake_format = 2;
  check(!grc::rs::texture_decode(request(19)).handled, "a decode to another format is refused");
  g_fake_format = 5;
  g_fake_width = 8;
  check(!grc::rs::texture_decode(request(19)).handled, "a decode of another shape is refused");
  g_fake_width = 4;
  g_fake_ok = false;
  check(!grc::rs::texture_decode(request(19)).handled, "a failed backend is refused");
  g_fake_ok = true;
  g_fake_format = 2;
  check(grc::rs::texture_decode(request(20)).handled, "RGTC_R decodes to R8");
  g_fake_format = 5;

  // perturb-decode: texel 0's first byte inverted from the sabotage frame on.
  grc::rs::texture_decode_set_perturb(11);
  const DecodeResult before = grc::rs::texture_decode(request(19));
  check(before.handled && !before.perturbed && before.data[0] == 0x40,
        "perturb-decode leaves frames before its frame alone");
  DecodeRequest late = request(19);
  late.frame = 11;
  const DecodeResult after = grc::rs::texture_decode(late);
  check(after.handled && after.perturbed && after.data[0] == 0xbf && after.data[1] == 0x40,
        "perturb-decode inverts texel 0's first byte from its frame on");
  grc::rs::texture_decode_set_perturb(0);

  const grc::rs::DecodeStats stats = grc::rs::texture_decode_stats();
  check(stats.decoded == 4 && stats.declined == 6 && stats.decoded_bytes == 4 * 64 &&
            stats.decode_ns_max <= stats.decode_ns_total,
        "the totals count every decoded and declined request");
  grc::rs::texture_decode_set_enabled(true);
  check(grc::rs::texture_decode_stats().decoded == 0, "enabling (arm) resets the totals");
  grc::rs::texture_decode_set_enabled(false);
  grc::rs::texture_decode_set_backend(nullptr);
}

}  // namespace

int main() {
  test_table();
  test_decode();
  if (g_failures != 0) {
    std::fprintf(stderr, "%d failure(s)\n", g_failures);
    return 1;
  }
  std::printf("rs_texture_decode_test: ok\n");
  return 0;
}
