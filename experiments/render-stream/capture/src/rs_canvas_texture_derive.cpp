#include "rs_canvas_texture_derive.h"
#include <array>
#include <cstring>
#include <string_view>

namespace grc::rs {
namespace {
using Range = CanvasTextureImageRange;
bool extent(std::uint64_t a, std::size_t n) { return a && n <= UINT64_MAX - a; }
bool image(CanvasTextureDeriveReader &r, std::uint64_t a, void *p, std::size_t n, Range range) {
  return extent(a, n) && r.image(a, p, n, range);
}
bool word(CanvasTextureDeriveReader &r, std::uint64_t a, std::uint64_t *v) {
  return a % 8 == 0 && image(r, a, v, 8, Range::readonly);
}
bool pattern(CanvasTextureDeriveReader &r, std::uint64_t a, std::string_view hex) {
  std::array<unsigned char, 192> bytes{};
  const auto n = hex.size() / 2;
  if (hex.size() % 2 || n > bytes.size() || !image(r, a, bytes.data(), n, Range::code)) return false;
  const auto digit = [](char c) { return c <= '9' ? c - '0' : c - 'a' + 10; };
  for (std::size_t i = 0; i < n; ++i)
    if (bytes[i] != (digit(hex[2*i]) << 4 | digit(hex[2*i+1]))) return false;
  return true;
}
// Complete instruction prefixes from the Godot 4.5.1 Linux/GCC release template. No addresses.
// The channel prefix includes all three stores; sampling prefixes include typed owner lookup,
// stride, validator comparison and the store. A compiler/layout change refuses the profile.
constexpr std::string_view rd_channel =
    "4883ec084885f60f84b10000004189d089f08b97cc00000039d60f839e00000031d248c1ee20f7b7c8000000488bbfb8"
    "00000089d2488d14d248c1e204480314c74889d08b928800000039f275624183f80174544183f80274364585c0750348"
    "8908488b5068660fefc00f1140380f1140480f1140584885d27425488b707031ff4883c408ffe2660f1f840000000000"
    "48894810ebcc662e0f1f8400000000004883c408c30f1f0048894808ebb4";
constexpr std::string_view rd_filter =
    "4883ec084889f14885f6745289d689c88b97cc00000039d1734431d248c1e920f7b7c8000000488bbfb800000089d248"
    "8d14d248c1e204480314c74889d08b928800000039ca750889702c4883c408c3";
constexpr std::string_view rd_repeat =
    "4883ec084889f14885f6745289d689c88b97cc00000039d1734431d248c1e920f7b7c8000000488bbfb800000089d248"
    "8d14d248c1e204480314c74889d08b928800000039ca75088970304883c408c3";
constexpr std::string_view gl_channel =
    "4883ec084885f6747b4189d089f08b979c00000039d6736c31d248c1ee20f7b798000000488bbf8800000089d248c1e2"
    "06480314c78b423839f0753c4183f80174264183f80274104585c0750348890a4883c408c30f1f0048894a104883c408"
    "c30f1f800000000048894a084883c408c3";
constexpr std::string_view gl_filter =
    "4883ec084885f6744b89d189f08b979c00000039d6733d31d248c1ee20f7b798000000488bbf8800000089d248c1e206"
    "480314c78b423839f0750d894a2c4883c408c3";
constexpr std::string_view gl_repeat =
    "4883ec084885f6744b89d189f08b979c00000039d6733d31d248c1ee20f7b798000000488bbf8800000089d248c1e206"
    "480314c78b423839f0750d894a304883c408c3";
}  // namespace

bool validate_canvas_texture_record(CanvasTextureDeriveReader &reader,
                                    const CanvasTextureRecord &record, std::string *why) {
  auto fail = [&](const char *reason) { *why = reason; return false; };
  std::uint64_t storage = 0, ignored = 0, vptr = 0;
  if (!word(reader, record.rd.vptr, &ignored) || !word(reader, record.gles3.vptr, &ignored) ||
      record.global % 8 || !image(reader, record.global, &storage, 8, Range::writable))
    return fail("record-outside-image");
  if (!storage || storage % 8 || !extent(storage, 8) || !reader.storage_vptr(storage, &vptr))
    return fail("storage-unreadable");
  if (vptr != record.rd.vptr && vptr != record.gles3.vptr)
    return fail("storage-vptr-mismatch");
  std::uint64_t top = 1, typeinfo = 0, name = 0;
  if (vptr < 16 || !word(reader, vptr - 16, &top) || top ||
      !word(reader, vptr - 8, &typeinfo) || typeinfo > UINT64_MAX - 8 ||
      !word(reader, typeinfo + 8, &name)) return fail("storage-rtti");
  constexpr char rd[] = "N10RendererRD14TextureStorageE";
  constexpr char gl[] = "N5GLES314TextureStorageE";
  std::array<char, sizeof(rd)> text{};
  const bool is_rd = vptr == record.rd.vptr;
  const auto bytes = is_rd ? sizeof(rd) : sizeof(gl);
  if (!image(reader, name, text.data(), bytes, Range::readonly) ||
      std::memcmp(text.data(), is_rd ? rd : gl, bytes)) return fail("storage-rtti");
  why->clear();
  return true;
}

bool derive_canvas_texture_record(CanvasTextureDeriveReader &reader, const std::string &platform,
                                  const std::string &version, std::uint64_t create_slot,
                                  CanvasTextureRecord *out, std::string *why) {
  *out = {};
  auto fail = [&](const char *s) { *why = s; return false; };
  if (platform != "linux-x86_64") return fail("platform-unrecorded");
  if (!version.starts_with("Godot Engine v4.5.1.") &&
      version.find("MegaDot v4.5.1.") == std::string::npos) return fail("derive-engine-version");
  std::uint64_t create = 0;
  if (!word(reader, create_slot, &create)) return fail("derive-create-slot");
  std::array<unsigned char, 29> code{};
  if (!image(reader, create, code.data(), code.size(), Range::code)) return fail("derive-create-code");
  constexpr unsigned char prologue[] = {0x41,0x57,0x41,0x56,0x41,0x55,0x41,0x54,
      0x55,0x53,0x48,0x89,0xfb,0x48,0x83,0xec,0x18,0x48,0x8b,0x3d};
  constexpr unsigned char dispatch[] = {0x48,0x8b,0x07,0xff,0x10};
  if (std::memcmp(code.data(), prologue, sizeof(prologue)) ||
      std::memcmp(code.data()+24, dispatch, sizeof(dispatch))) return fail("derive-create-pattern");
  std::int32_t disp = 0;
  std::memcpy(&disp, code.data()+20, 4);
  const auto next = create + 24;
  const auto magnitude = disp < 0 ? std::uint64_t(-std::int64_t(disp)) : std::uint64_t(disp);
  if ((disp < 0 && magnitude >= next) || (disp >= 0 && magnitude > UINT64_MAX-next))
    return fail("derive-global-overflow");
  const auto global = disp < 0 ? next-magnitude : next+magnitude;
  std::uint64_t storage = 0, vptr = 0;
  if (global % 8 || !image(reader, global, &storage, 8, Range::writable))
    return fail("derive-global-range");
  if (!storage || storage % 8 || !extent(storage, 8) || !reader.storage_vptr(storage, &vptr))
    return fail("derive-storage-unreadable");
  std::uint64_t top = 1, typeinfo = 0, name = 0;
  if (vptr < 16 || !word(reader, vptr-16, &top) || top ||
      !word(reader, vptr-8, &typeinfo) || typeinfo > UINT64_MAX-8 ||
      !word(reader, typeinfo+8, &name)) return fail("derive-storage-rtti");
  std::array<char, 32> rtti{};
  // Match fixed-length NUL-terminated names, without an unbounded C-string read.
  constexpr char rd_name[] = "N10RendererRD14TextureStorageE";
  constexpr char gl_name[] = "N5GLES314TextureStorageE";
  bool rd = false;
  if (image(reader, name, rtti.data(), sizeof(rd_name), Range::readonly) &&
      !std::memcmp(rtti.data(), rd_name, sizeof(rd_name))) rd = true;
  else if (!image(reader, name, rtti.data(), sizeof(gl_name), Range::readonly) ||
           std::memcmp(rtti.data(), gl_name, sizeof(gl_name))) return fail("derive-storage-type");
  if (vptr > UINT64_MAX-56) return fail("derive-storage-table");
  std::uint64_t channel = 0, filter = 0, repeat = 0;
  if (!word(reader, vptr+24, &channel) || !word(reader, vptr+40, &filter) ||
      !word(reader, vptr+48, &repeat)) return fail("derive-storage-table");
  if (!pattern(reader, channel, rd ? rd_channel : gl_channel) ||
      !pattern(reader, filter, rd ? rd_filter : gl_filter) ||
      !pattern(reader, repeat, rd ? rd_repeat : gl_repeat)) return fail("derive-layout-pattern");
  CanvasTextureRecord record;
  record.global = global;
  // Only the backend whose code and RTTI passed is allowed. The other vptr stays zero.
  if (rd) record.rd = {vptr,176,144,136,0,8,16,44,48};
  else record.gles3 = {vptr,128,64,56,0,8,16,44,48};
  *out = record;
  why->clear();
  return true;
}
}  // namespace grc::rs
