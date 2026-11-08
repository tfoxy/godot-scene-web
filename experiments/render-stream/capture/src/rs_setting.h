#ifndef GRC_RS_SETTING_H
#define GRC_RS_SETTING_H

#include <map>
#include <string>

namespace grc::rs {
using Settings = std::map<std::string, std::string>;
// Main-thread only. An installed empty value suppresses the environment default.
const char *setting(const char *name);
// Install once, at the arm point before readers start. Pointers remain valid until unload.
void settings_install(Settings settings);
}  // namespace grc::rs
#endif
