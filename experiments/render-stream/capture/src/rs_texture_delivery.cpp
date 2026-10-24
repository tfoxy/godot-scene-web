#include "rs_texture_delivery.h"

#include <atomic>
#include <mutex>

namespace grc {
namespace rs {

namespace {
std::mutex g_policy_mutex;
DeliveryPolicy g_policy;
std::atomic<bool> g_block_enabled{false};
std::mutex g_stats_mutex;
DeliveryStats g_stats;

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
  if (policy.mode == "rgba" || policy.mode == "passthrough") {
    return true;
  }
  *error = "texture-delivery-unimplemented: GRC_TEXTURE_DELIVERY=" + policy.mode +
           " is not implemented yet (texture-delivery-design.md: " +
           (policy.mode == "basis-uastc" ? "G8ku" : "G8ke") + "); use rgba or passthrough";
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
  declaration.has_encoder = false;  // no encoder until G8ku
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
  return out;
}

}  // namespace rs
}  // namespace grc
