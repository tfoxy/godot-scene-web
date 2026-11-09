#include "rs_setting.h"
#include <cstdio>
#include <cstdlib>
#include <string>

int main() {
  int checks = 0, failures = 0;
  auto check = [&](bool ok, const char *what) {
    ++checks;
    if (!ok) { ++failures; std::fprintf(stderr, "FAIL %s\n", what); }
  };
  // Test setup only: the settings implementation never writes the process environment.
  setenv("GRC_RS_SETTING_TEST", "environment", 1);
  setenv("GRC_RS_SETTING_EMPTY", "environment", 1);
  unsetenv("GRC_RS_SETTING_ABSENT");
  check(std::string(grc::rs::setting("GRC_RS_SETTING_TEST")) == "environment", "environment fallback");
  check(grc::rs::setting("GRC_RS_SETTING_ABSENT") == nullptr, "missing stays missing");
  grc::rs::settings_install({{"GRC_RS_SETTING_TEST", "override"}, {"GRC_RS_SETTING_EMPTY", ""}});
  const char *stable = grc::rs::setting("GRC_RS_SETTING_TEST");
  check(std::string(stable) == "override", "map overrides environment");
  check(std::string(grc::rs::setting("GRC_RS_SETTING_EMPTY")).empty(), "empty suppresses environment");
  check(std::string(std::getenv("GRC_RS_SETTING_TEST")) == "environment", "environment unchanged");
  check(grc::rs::setting("GRC_RS_SETTING_ABSENT") == nullptr, "missing fallback after install");
  check(stable == grc::rs::setting("GRC_RS_SETTING_TEST"), "pointer stable");
  // A re-arm installs its own map: the previous arm's overrides are gone.
  grc::rs::settings_install({{"GRC_RS_SETTING_EMPTY", "second"}});
  check(std::string(grc::rs::setting("GRC_RS_SETTING_TEST")) == "environment", "re-arm drops old override");
  check(std::string(grc::rs::setting("GRC_RS_SETTING_EMPTY")) == "second", "re-arm installs its map");
  grc::rs::settings_install({});
  check(std::string(grc::rs::setting("GRC_RS_SETTING_EMPTY")) == "environment", "empty map restores env");
  std::printf("rs_setting_test: %d checks, %d failures\n", checks, failures);
  return failures ? 1 : 0;
}
