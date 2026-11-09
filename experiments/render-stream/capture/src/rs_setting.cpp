#include "rs_setting.h"

#include <cstdlib>
#include <utility>

namespace grc::rs {
namespace {
Settings overrides;
}
const char *setting(const char *name) {
  const auto it = overrides.find(name);
  return it == overrides.end() ? std::getenv(name) : it->second.c_str();
}
void settings_install(Settings settings) { overrides = std::move(settings); }
}  // namespace grc::rs
