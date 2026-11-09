#ifndef GRC_RS_SETTING_H
#define GRC_RS_SETTING_H

#include <map>
#include <string>

namespace grc::rs {
using Settings = std::map<std::string, std::string>;
// Main-thread only. An installed empty value suppresses the environment default.
const char *setting(const char *name);
// Install at each arm point, before readers start. It replaces the previous arm's map, so a
// pointer returned by setting() stays valid until the next install.
void settings_install(Settings settings);
}  // namespace grc::rs
#endif
