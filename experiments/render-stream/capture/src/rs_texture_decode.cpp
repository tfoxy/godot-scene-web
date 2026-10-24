#include "rs_texture_decode.h"

#include <atomic>
#include <chrono>
#include <mutex>
#include <vector>

#include "iface.h"

namespace grc {
namespace rs {

namespace {

// Image::Format values (core/io/image.h:75-114).
constexpr std::int64_t kR8 = 2;
constexpr std::int64_t kRG8 = 3;
constexpr std::int64_t kRGBA8 = 5;
constexpr std::int64_t kRGBH = 14;
constexpr std::int64_t kRGBAH = 15;
constexpr std::int64_t kDXT1 = 17;
constexpr std::int64_t kDXT3 = 18;
constexpr std::int64_t kDXT5 = 19;
constexpr std::int64_t kRGTC_R = 20;
constexpr std::int64_t kRGTC_RG = 21;
constexpr std::int64_t kBPTC_RGBA = 22;
constexpr std::int64_t kBPTC_RGBF = 23;
constexpr std::int64_t kBPTC_RGBFU = 24;
constexpr std::int64_t kETC = 25;
constexpr std::int64_t kETC2_R11 = 26;
constexpr std::int64_t kETC2_RG11 = 28;
constexpr std::int64_t kETC2_RGB8 = 30;
constexpr std::int64_t kETC2_RGBA8 = 31;
constexpr std::int64_t kASTC_4x4 = 35;
constexpr std::int64_t kASTC_4x4_HDR = 36;
constexpr std::int64_t kASTC_8x8 = 37;
constexpr std::int64_t kASTC_8x8_HDR = 38;

std::atomic<bool> g_enabled{false};
std::atomic<std::uint64_t> g_perturb_frame{0};

std::mutex g_stats_mutex;
DecodeStats g_stats;

// Engine method binds (hashes from Godot 4.5.1's extension_api.json), resolved on enable.
struct Binds {
  bool resolved = false;
  GDExtensionMethodBindPtr duplicate = nullptr;   // Resource.duplicate(bool) -> Resource
  GDExtensionMethodBindPtr decompress = nullptr;  // Image.decompress() -> Error
  GDExtensionMethodBindPtr get_width = nullptr;
  GDExtensionMethodBindPtr get_height = nullptr;
  GDExtensionMethodBindPtr get_format = nullptr;
  GDExtensionMethodBindPtr get_data_size = nullptr;
  GDExtensionMethodBindPtr has_mipmaps = nullptr;
};
Binds g_binds;
std::mutex g_binds_mutex;

void resolve_binds() {
  std::lock_guard<std::mutex> lock(g_binds_mutex);
  if (g_binds.resolved || g_iface.classdb_get_method_bind == nullptr) {
    return;
  }
  g_binds.resolved = true;
  g_binds.duplicate = method_bind("Resource", "duplicate", 482882304LL);
  g_binds.decompress = method_bind("Image", "decompress", 166280745LL);
  g_binds.get_width = method_bind("Image", "get_width", 3905245786LL);
  g_binds.get_height = method_bind("Image", "get_height", 3905245786LL);
  g_binds.get_format = method_bind("Image", "get_format", 3847873762LL);
  g_binds.get_data_size = method_bind("Image", "get_data_size", 3905245786LL);
  g_binds.has_mipmaps = method_bind("Image", "has_mipmaps", 36873697LL);
}

// A Ref<RefCounted> return slot (one pointer) the engine's ptrcall assigns into; dropping the
// last holder releases the reference through ref_set_object, as iface.h's RefHolder does.
struct RefSlot {
  void *slot = nullptr;
  ~RefSlot() {
    if (slot != nullptr && g_iface.ref_set_object != nullptr) {
      g_iface.ref_set_object(&slot, nullptr);
    }
  }
};

// The default backend: Resource.duplicate(false) (Image::_duplicate copies the internals, the
// data copy-on-write, core/io/image.cpp:4268-4273), then Image.decompress() on the copy
// (core/io/image.cpp:2677-2692), then the copy's shape and bytes.
bool engine_backend(void *image, DecodedImage *out) {
  const Binds &b = g_binds;
  if (image == nullptr || b.duplicate == nullptr || b.decompress == nullptr ||
      b.get_width == nullptr || b.get_height == nullptr || b.get_format == nullptr ||
      b.get_data_size == nullptr || b.has_mipmaps == nullptr ||
      g_iface.object_method_bind_ptrcall == nullptr || g_iface.ref_get_object == nullptr ||
      g_iface.ref_set_object == nullptr || g_iface.image_ptr == nullptr) {
    return false;
  }
  auto holder = std::make_shared<RefSlot>();
  const std::uint8_t deep = 0;  // GDExtensionBool
  const void *dup_args[] = {&deep};
  g_iface.object_method_bind_ptrcall(b.duplicate, image, dup_args, &holder->slot);
  void *copy = g_iface.ref_get_object(&holder->slot);
  if (copy == nullptr) {
    return false;
  }
  std::int64_t error = -1;
  g_iface.object_method_bind_ptrcall(b.decompress, copy, nullptr, &error);
  if (error != 0) {
    return false;
  }
  std::int64_t width = 0, height = 0, format = -1, size = 0, mip = 0;
  if (!call_int_getter(b.get_width, copy, &width) || !call_int_getter(b.get_height, copy, &height) ||
      !call_int_getter(b.get_format, copy, &format) ||
      !call_int_getter(b.get_data_size, copy, &size) || !call_int_getter(b.has_mipmaps, copy, &mip)) {
    return false;
  }
  const std::uint8_t *data = g_iface.image_ptr(copy);  // the copy's own, freshly decoded bytes
  if (data == nullptr || size <= 0) {
    return false;
  }
  out->format = format;
  out->width = static_cast<std::int32_t>(width);
  out->height = static_cast<std::int32_t>(height);
  out->mipmaps = (mip & 0xff) != 0;
  out->data = data;
  out->data_size = size;
  out->hold = std::move(holder);
  return true;
}

std::atomic<DecodeBackend> g_backend{&engine_backend};

std::uint64_t now_ns() {
  return static_cast<std::uint64_t>(std::chrono::duration_cast<std::chrono::nanoseconds>(
                                        std::chrono::steady_clock::now().time_since_epoch())
                                        .count());
}

void count(bool handled, std::int64_t decode_ns, std::int64_t bytes) {
  std::lock_guard<std::mutex> lock(g_stats_mutex);
  if (handled) {
    ++g_stats.decoded;
    g_stats.decoded_bytes += bytes;
  } else {
    ++g_stats.declined;
  }
  if (decode_ns > 0) {
    g_stats.decode_ns_total += decode_ns;
    if (decode_ns > g_stats.decode_ns_max) {
      g_stats.decode_ns_max = decode_ns;
    }
  }
}

}  // namespace

void texture_decode_set_enabled(bool enabled) {
  if (enabled) {
    resolve_binds();
  }
  {
    std::lock_guard<std::mutex> lock(g_stats_mutex);
    g_stats = DecodeStats();
  }
  g_enabled.store(enabled);
}

bool texture_decode_enabled() { return g_enabled.load(); }

std::int64_t decode_target_format(std::int64_t source) {
  switch (source) {
    // bcdec (modules/bcdec/image_decompress_bcdec.cpp:224-267)
    case kDXT1:
    case kDXT3:
    case kDXT5:
    case kBPTC_RGBA:
      return kRGBA8;
    case kRGTC_R:
      return kR8;
    case kRGTC_RG:
      return kRG8;
    // etcpak (modules/etcpak/image_decompress_etcpak.cpp:189-216): always RGBA8
    case kETC:
    case kETC2_R11:
    case kETC2_RG11:
    case kETC2_RGB8:
    case kETC2_RGBA8:
    // astcenc, LDR profiles (modules/astcenc/image_compress_astcenc.cpp:183-232)
    case kASTC_4x4:
    case kASTC_8x8:
      return kRGBA8;
    // G8f: the HDR formats decode to half floats, carried exact (D9): BC6H signed and unsigned to
    // RGBH (image_decompress_bcdec.cpp:248-256), ASTC HDR to RGBAH (image_compress_astcenc.cpp:232)
    case kBPTC_RGBF:
    case kBPTC_RGBFU:
      return kRGBH;
    case kASTC_4x4_HDR:
    case kASTC_8x8_HDR:
      return kRGBAH;
    default:
      // DXT5_RA_AS_RG and
      // ETC2_RA_AS_RG are swizzled further by GLES3 (D8 "Stays unsupported"); etcpak has no
      // decoder for ETC2_R11S, ETC2_RG11S or ETC2_RGB8A1; nothing else is block-compressed.
      return -1;
  }
}

void texture_decode_set_perturb(std::uint64_t from_frame) { g_perturb_frame.store(from_frame); }
bool texture_decode_perturb_active() { return g_perturb_frame.load() != 0; }

DecodeResult texture_decode(const DecodeRequest &request) {
  DecodeResult result;
  const std::int64_t target = decode_target_format(request.format);
  if (!g_enabled.load() || target < 0) {
    count(false, -1, 0);
    return result;
  }
  const std::uint64_t t0 = now_ns();
  DecodedImage decoded;
  const DecodeBackend backend = g_backend.load();
  const bool ok = backend != nullptr && backend(request.image, &decoded);
  const std::uint64_t t1 = now_ns();
  result.decode_ns = static_cast<std::int64_t>(t1 - t0);
  // The engine must have produced exactly the table's format at the source's shape.
  if (!ok || decoded.format != target || decoded.width != request.width ||
      decoded.height != request.height || decoded.mipmaps != request.mipmaps ||
      decoded.data == nullptr || decoded.data_size <= 0) {
    count(false, result.decode_ns, 0);
    return result;
  }
  const std::uint64_t perturb = g_perturb_frame.load();
  if (perturb != 0 && request.frame >= perturb) {
    auto flipped = std::make_shared<std::vector<std::uint8_t>>(
        decoded.data, decoded.data + decoded.data_size);
    // G8f: a float texel's first channel is flipped whole (4 bytes of an f32, 2 of a half), so
    // the change is a sign and exponent one, never a mantissa ripple a clamp could hide.
    const std::int64_t flip = decoded.format >= 8 && decoded.format <= 11
                                  ? 4
                                  : (decoded.format >= 12 && decoded.format <= 15 ? 2 : 1);
    for (std::int64_t i = 0; i < flip && i < decoded.data_size; ++i) {
      (*flipped)[i] = static_cast<std::uint8_t>((*flipped)[i] ^ 0xff);
    }
    decoded.data = flipped->data();
    decoded.hold = flipped;
    result.perturbed = true;
  }
  result.handled = true;
  result.format = decoded.format;
  result.width = decoded.width;
  result.height = decoded.height;
  result.mipmaps = decoded.mipmaps;
  result.data = decoded.data;
  result.data_size = decoded.data_size;
  result.hold = std::move(decoded.hold);
  count(true, result.decode_ns, result.data_size);
  return result;
}

DecodeStats texture_decode_stats() {
  std::lock_guard<std::mutex> lock(g_stats_mutex);
  return g_stats;
}

void texture_decode_set_backend(DecodeBackend backend) {
  g_backend.store(backend != nullptr ? backend : &engine_backend);
}

}  // namespace rs
}  // namespace grc
