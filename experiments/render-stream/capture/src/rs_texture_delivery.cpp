#include "rs_texture_delivery.h"

#include <mutex>

namespace grc {
namespace rs {

namespace {
std::mutex g_policy_mutex;
DeliveryPolicy g_policy;
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

rs2::TextureDeliveryDeclaration declare_texture_delivery(const DeliveryPolicy &policy) {
  rs2::TextureDeliveryDeclaration declaration;
  declaration.mode = policy.mode;
  declaration.has_encoder = false;  // no encoder until G8ku
  return declaration;
}

std::vector<rs2::TextureVariant> texture_variants(const VariantRequest &) {
  return {};  // the seam: G8kp offers `block`, G8ku `uastc`, G8ke `etc1s`
}

}  // namespace rs
}  // namespace grc
