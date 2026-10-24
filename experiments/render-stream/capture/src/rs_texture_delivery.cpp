#include "rs_texture_delivery.h"

#include <algorithm>
#include <atomic>
#include <cstdlib>
#include <mutex>

namespace grc {
namespace rs {

namespace {
std::mutex g_policy_mutex;
DeliveryPolicy g_policy;
std::atomic<bool> g_block_enabled{false};
std::mutex g_stats_mutex;
DeliveryStats g_stats;
std::atomic<bool> g_basis_enabled{false};
BasisConfig g_basis_config;  // under g_policy_mutex
BasisStats g_basis_stats;    // under g_stats_mutex

// A decimal integer in [lo, hi]; false on anything else.
bool parse_int(const char *text, std::int64_t lo, std::int64_t hi, std::int64_t *out) {
  if (text == nullptr || *text == '\0') {
    return false;
  }
  std::int64_t v = 0;
  for (const char *c = text; *c != '\0'; ++c) {
    if (*c < '0' || *c > '9' || v > hi) {
      return false;
    }
    v = v * 10 + (*c - '0');
  }
  if (v < lo || v > hi) {
    return false;
  }
  *out = v;
  return true;
}

// render-stream-9.md "Texture payload": block edge, right shift, family.
struct BlockFormat {
  const char *name;
  int block;
  int shift;
  const char *family;
};
constexpr BlockFormat kBlockFormats[] = {
    {"DXT1", 4, 1, "s3tc"},       {"DXT3", 4, 0, "s3tc"},        {"DXT5", 4, 0, "s3tc"},
    {"RGTC_R", 4, 1, "rgtc"},     {"RGTC_RG", 4, 0, "rgtc"},     {"BPTC_RGBA", 4, 0, "bptc"},
    {"ETC", 4, 1, "etc2"},        {"ETC2_R11", 4, 1, "etc2"},    {"ETC2_R11S", 4, 1, "etc2"},
    {"ETC2_RG11", 4, 0, "etc2"},  {"ETC2_RG11S", 4, 0, "etc2"},  {"ETC2_RGB8", 4, 1, "etc2"},
    {"ETC2_RGBA8", 4, 0, "etc2"}, {"ETC2_RGB8A1", 4, 1, "etc2"}, {"ASTC_4x4", 4, 0, "astc"},
    {"ASTC_8x8", 8, 2, "astc"},
};

const BlockFormat *find_block(const std::string &format) {
  for (const BlockFormat &f : kBlockFormats) {
    if (format == f.name) {
      return &f;
    }
  }
  return nullptr;
}
}  // namespace

bool parse_delivery_policy(const char *mode, DeliveryPolicy *out, std::string *error) {
  *out = DeliveryPolicy();
  if (mode == nullptr || *mode == '\0') {
    return true;
  }
  const std::string text(mode);
  if (text != "rgba" && text != "passthrough" && text != "basis-uastc" && text != "basis-etc1s") {
    *error = "invalid GRC_TEXTURE_DELIVERY=" + text +
             " (expected rgba, passthrough, basis-uastc or basis-etc1s)";
    return false;
  }
  out->mode = text;
  out->set = true;
  return true;
}

void texture_delivery_set_policy(const DeliveryPolicy &policy) {
  std::lock_guard<std::mutex> lock(g_policy_mutex);
  g_policy = policy;
}

DeliveryPolicy texture_delivery_policy() {
  std::lock_guard<std::mutex> lock(g_policy_mutex);
  return g_policy;
}

bool delivery_mode_implemented(const DeliveryPolicy &policy, std::string *error) {
  if (policy.mode == "rgba" || policy.mode == "passthrough" || policy.mode == "basis-uastc") {
    return true;
  }
  *error = "texture-delivery-unimplemented: GRC_TEXTURE_DELIVERY=" + policy.mode +
           " is not implemented yet (texture-delivery-design.md: G8ke); use rgba, passthrough or "
           "basis-uastc";
  return false;
}

bool mode_offers_block(const std::string &mode) {
  return mode == "passthrough" || mode == "basis-uastc";
}

void texture_delivery_set_block(bool enabled) {
  g_block_enabled.store(enabled, std::memory_order_release);
  std::lock_guard<std::mutex> lock(g_stats_mutex);
  g_stats = DeliveryStats();
}

bool texture_delivery_block_enabled() { return g_block_enabled.load(std::memory_order_acquire); }

const char *block_format_family(const std::string &format) {
  const BlockFormat *f = find_block(format);
  return f != nullptr ? f->family : nullptr;
}

std::int64_t block_data_bytes(const std::string &format, std::int64_t width, std::int64_t height,
                              bool mipmaps) {
  const BlockFormat *f = find_block(format);
  if (f == nullptr || width <= 0 || height <= 0) {
    return -1;
  }
  std::int64_t total = 0;
  std::int64_t w = width;
  std::int64_t h = height;
  while (true) {
    const std::int64_t bw = (w + f->block - 1) / f->block * f->block;
    const std::int64_t bh = (h + f->block - 1) / f->block * f->block;
    total += (bw * bh) >> f->shift;
    if (!mipmaps || (w == 1 && h == 1)) {
      break;
    }
    w = w > 1 ? w >> 1 : 1;
    h = h > 1 ? h >> 1 : 1;
  }
  return total;
}

void texture_delivery_note_block(bool built, std::uint64_t payload_bytes) {
  std::lock_guard<std::mutex> lock(g_stats_mutex);
  if (built) {
    ++g_stats.block_built;
    g_stats.block_bytes += static_cast<std::int64_t>(payload_bytes);
  } else {
    ++g_stats.block_declined;
  }
}

DeliveryStats texture_delivery_stats() {
  std::lock_guard<std::mutex> lock(g_stats_mutex);
  return g_stats;
}

rs2::TextureDeliveryDeclaration declare_texture_delivery(const DeliveryPolicy &policy) {
  rs2::TextureDeliveryDeclaration declaration;
  declaration.mode = policy.mode;
  declaration.has_encoder = policy.mode == "basis-uastc";  // G8ku; etc1s is G8ke's
  if (declaration.has_encoder) {
    declaration.encoder = kBasisEncoderName;
  }
  return declaration;
}

std::vector<rs2::TextureVariant> texture_variants(const VariantRequest &request) {
  std::vector<rs2::TextureVariant> out;
  // G8kp: `block` (the hooked bytes); G8ku adds `uastc`, G8ke `etc1s`.
  if (!request.block.hash.empty() && request.block.hash != request.hash &&
      request.block.payload_bytes > 0 && mode_offers_block(texture_delivery_policy().mode) &&
      block_format_family(request.block.format) != nullptr) {
    rs2::TextureVariant block;
    block.encoding = rs2::VariantEncoding::Block;
    block.hash = request.block.hash;
    block.payload_bytes = request.block.payload_bytes;
    block.has_format = true;
    block.format = request.block.format;
    out.push_back(std::move(block));
  }
  // G8ku: `uastc`, once its lazy encode finished (D6), under basis-uastc only.
  if (!request.uastc_hash.empty() && request.uastc_hash != request.hash &&
      request.uastc_hash != request.block.hash && request.uastc_payload_bytes > 0 &&
      !request.uastc_params.empty() && texture_delivery_policy().mode == "basis-uastc") {
    rs2::TextureVariant uastc;
    uastc.encoding = rs2::VariantEncoding::Uastc;
    uastc.hash = request.uastc_hash;
    uastc.payload_bytes = request.uastc_payload_bytes;
    uastc.has_format = false;
    uastc.has_params = true;
    uastc.params = request.uastc_params;
    out.push_back(std::move(uastc));
  }
  return out;
}

bool parse_basis_config(const char *level, const char *min_px, const char *workers,
                        const char *wait_frame, const char *fault, BasisConfig *out,
                        std::string *error, const char *drain) {
  *out = BasisConfig();
  out->uastc_level = kDefaultUastcLevel;
  std::int64_t v = 0;
  if (level != nullptr && *level != '\0') {
    if (!parse_int(level, 0, 4, &v)) {
      *error = std::string("invalid GRC_TEXTURE_UASTC_LEVEL=") + level + " (expected 0..4)";
      return false;
    }
    out->uastc_level = static_cast<int>(v);
  }
  if (min_px != nullptr && *min_px != '\0') {
    if (!parse_int(min_px, 1, 1LL << 40, &v)) {
      *error = std::string("invalid GRC_TEXTURE_BASIS_MIN_PX=") + min_px +
               " (expected a texel count >= 1)";
      return false;
    }
    out->min_px = v;
  }
  if (workers != nullptr && *workers != '\0') {
    if (!parse_int(workers, 1, 16, &v)) {
      *error = std::string("invalid GRC_TEXTURE_ENCODE_WORKERS=") + workers + " (expected 1..16)";
      return false;
    }
    out->encode_workers = static_cast<int>(v);
  }
  if (wait_frame != nullptr && *wait_frame != '\0') {
    if (!parse_int(wait_frame, 0, 1LL << 40, &v)) {
      *error = std::string("invalid GRC_TEXTURE_ENCODE_WAIT_FRAME=") + wait_frame +
               " (expected a frame number)";
      return false;
    }
    out->wait_frame = static_cast<std::uint64_t>(v);
  }
  if (fault != nullptr && *fault != '\0') {
    if (std::string(fault) != "perturb-ktx2" && std::string(fault) != "corrupt-ktx2") {
      *error = std::string("invalid GRC_TEXTURE_ENCODE_FAULT=") + fault +
               " (expected perturb-ktx2 or corrupt-ktx2)";
      return false;
    }
    out->fault_perturb = std::string(fault) == "perturb-ktx2";
    out->fault_corrupt = std::string(fault) == "corrupt-ktx2";
  }
  if (drain != nullptr && *drain != '\0') {
    if (std::string(drain) != "0" && std::string(drain) != "1") {
      *error = std::string("invalid GRC_TEXTURE_ENCODE_DRAIN=") + drain + " (expected 0 or 1)";
      return false;
    }
    out->drain = std::string(drain) == "1";
  }
  return true;
}

void texture_delivery_set_basis(bool enabled, const BasisConfig &config) {
  {
    std::lock_guard<std::mutex> lock(g_policy_mutex);
    g_basis_config = config;
  }
  g_basis_enabled.store(enabled, std::memory_order_release);
  std::lock_guard<std::mutex> lock(g_stats_mutex);
  g_basis_stats = BasisStats();
}

bool texture_delivery_basis_enabled() { return g_basis_enabled.load(std::memory_order_acquire); }

BasisConfig texture_delivery_basis_config() {
  std::lock_guard<std::mutex> lock(g_policy_mutex);
  return g_basis_config;
}

const char *basis_decline_reason(const std::string &format, std::int64_t width,
                                 std::int64_t height, bool updated, std::int64_t min_px) {
  if (updated) {
    return "updated";
  }
  if (format != "RGBA8" && format != "RGB8") {
    return "format";
  }
  if (width <= 0 || height <= 0 || width * height < min_px) {
    return "small";
  }
  return nullptr;
}

bool grt1_rgba8_levels(const std::vector<std::uint8_t> &grt1, const std::string &format,
                       std::int64_t width, std::int64_t height, bool mipmaps,
                       std::vector<std::vector<std::uint8_t>> *levels) {
  levels->clear();
  const int bpp = format == "RGBA8" ? 4 : (format == "RGB8" ? 3 : 0);
  if (bpp == 0 || width <= 0 || height <= 0 || grt1.size() < 16) {
    return false;
  }
  static const std::uint8_t kMagic[8] = {0x47, 0x52, 0x54, 0x31, 0x0D, 0x0A, 0x1A, 0x0A};
  if (!std::equal(kMagic, kMagic + 8, grt1.begin())) {
    return false;
  }
  auto u32 = [&grt1](std::size_t at) {
    return static_cast<std::uint32_t>(grt1[at]) | (static_cast<std::uint32_t>(grt1[at + 1]) << 8) |
           (static_cast<std::uint32_t>(grt1[at + 2]) << 16) |
           (static_cast<std::uint32_t>(grt1[at + 3]) << 24);
  };
  const std::size_t meta_len = u32(8);
  if (12 + meta_len + 4 > grt1.size()) {
    return false;
  }
  const std::size_t data_len = u32(12 + meta_len);
  std::size_t at = 12 + meta_len + 4;
  if (at + data_len != grt1.size()) {
    return false;
  }
  std::int64_t w = width;
  std::int64_t h = height;
  while (true) {
    const std::size_t n = static_cast<std::size_t>(w * h);
    if (at + n * static_cast<std::size_t>(bpp) > grt1.size()) {
      levels->clear();
      return false;
    }
    std::vector<std::uint8_t> rgba(n * 4);
    const std::uint8_t *src = grt1.data() + at;
    for (std::size_t px = 0; px < n; ++px) {
      rgba[px * 4 + 0] = src[px * bpp + 0];
      rgba[px * 4 + 1] = src[px * bpp + 1];
      rgba[px * 4 + 2] = src[px * bpp + 2];
      rgba[px * 4 + 3] = bpp == 4 ? src[px * bpp + 3] : 255;
    }
    levels->push_back(std::move(rgba));
    at += n * static_cast<std::size_t>(bpp);
    if (!mipmaps || (w == 1 && h == 1)) {
      break;
    }
    w = std::max<std::int64_t>(1, w >> 1);
    h = std::max<std::int64_t>(1, h >> 1);
  }
  if (at != grt1.size()) {
    levels->clear();
    return false;
  }
  return true;
}

void texture_delivery_note_basis_decline(const char *reason) {
  std::lock_guard<std::mutex> lock(g_stats_mutex);
  const std::string r(reason);
  if (r == "updated") {
    ++g_basis_stats.declined_updated;
  } else if (r == "format") {
    ++g_basis_stats.declined_format;
  } else {
    ++g_basis_stats.declined_small;
  }
}

void texture_delivery_note_encode_run() {
  std::lock_guard<std::mutex> lock(g_stats_mutex);
  ++g_basis_stats.encodes_run;
}

void texture_delivery_note_basis_submit() {
  std::lock_guard<std::mutex> lock(g_stats_mutex);
  ++g_basis_stats.encodes_submitted;
}

void texture_delivery_note_basis_result(bool attached, bool stale, const BasisJob &job) {
  std::lock_guard<std::mutex> lock(g_stats_mutex);
  const BasisJob::Outcome &o = job.outcome();
  if (o.error == "abandoned") {
    return;
  }
  if (o.cache == "hit") {
    ++g_basis_stats.cache_hits;
  } else if (o.encode_ns != 0) {
    g_basis_stats.encode_ns_total += o.encode_ns;
    g_basis_stats.encode_ns_max = std::max(g_basis_stats.encode_ns_max, o.encode_ns);
    g_basis_stats.encode_px_total += static_cast<std::uint64_t>(job.width() * job.height());
  }
  if (stale) {
    ++g_basis_stats.uastc_stale;
  } else if (attached) {
    ++g_basis_stats.uastc_built;
    g_basis_stats.uastc_bytes += o.ktx2 != nullptr ? static_cast<std::int64_t>(o.ktx2->size()) : 0;
  } else {
    ++g_basis_stats.uastc_failed;
  }
}

BasisStats texture_delivery_basis_stats() {
  std::lock_guard<std::mutex> lock(g_stats_mutex);
  return g_basis_stats;
}

}  // namespace rs
}  // namespace grc
