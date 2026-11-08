#include "rs_setting.h"

#include <cstdlib>
#include <stdexcept>
#include <utility>

namespace grc::rs {
namespace {
Settings overrides;
bool installed = false;
}
const char *setting(const char *name) {
  const auto it = overrides.find(name);
  return it == overrides.end() ? std::getenv(name) : it->second.c_str();
}
void settings_install(Settings settings) {
  if (installed) throw std::logic_error("settings already installed");
  overrides = std::move(settings);
  installed = true;
}
}  // namespace grc::rs
