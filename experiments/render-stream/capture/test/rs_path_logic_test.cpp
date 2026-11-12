#include "report.h"
#include "rs_platform.h"

#include <cstdio>
#include <string>

namespace {
#if defined(_WIN32)
constexpr bool windows = true;
#else
constexpr bool windows = false;
#endif
}  // namespace

int main() {
  unsigned checks = 0, failures = 0;
  auto check = [&](bool ok, const char *operation, const char *path) {
    ++checks;
    if (!ok) {
      ++failures;
      std::fprintf(stderr, "FAIL %s: [%s]\n", operation, path);
    }
  };

  // Every row runs on both operating systems, including all Windows path forms.
  const struct {
    const char *path;
    bool absolute;
  } absolute_cases[] = {
      {"", false},
      {"/a", !windows},
      {"a", false},
      {"C:\\a", windows},
      {"c:/a", windows},
      {"\\\\srv\\share\\a", windows},
      {"//srv/share", true},
      {"C:a", false},
      {"\\a", false},
      {"a\\b", false},
      {"C:\\", windows},
      {"c:/", windows},
      {"C:", false},
      {"1:/a", false},
      {":/a", false},
  };
  for (const auto &c : absolute_cases)
    check(grc::rs::is_absolute_path(c.path) == c.absolute, "is_absolute_path", c.path);

  const struct {
    const char *path;
    const char *parent;
  } parent_cases[] = {
      {"", ""},
      {"a", ""},
      {"/a", ""},
      {"/a/b", "/a"},
      {"/a/", "/a"},
      {"C:\\a\\b", windows ? "C:\\a" : ""},
      {"C:\\a/b", "C:\\a"},
      {"C:/a\\b", windows ? "C:/a" : "C:"},
      {"\\\\srv\\share\\a", windows ? "\\\\srv\\share" : ""},
      {"C:\\a\\", windows ? "C:\\a" : ""},
  };
  for (const auto &c : parent_cases)
    check(grc::rs::parent_path(c.path) == c.parent, "parent_path", c.path);

  const struct {
    const char *dir;
    const char *joined;
  } join_cases[] = {
      {"", "b"},
      {"/a", "/a/b"},
      {"/a/", "/a/b"},
      {"C:\\a\\", windows ? "C:\\a\\b" : "C:\\a\\/b"},
      {"c:/a/", "c:/a/b"},
      {"\\\\srv\\share\\", windows ? "\\\\srv\\share\\b" : "\\\\srv\\share\\/b"},
  };
  for (const auto &c : join_cases)
    check(grc::path_join(c.dir, "b") == c.joined, "path_join", c.dir);

  std::printf("rs_path_logic_test: %u/%u passed (%s)\n", checks - failures, checks,
              windows ? "Windows" : "POSIX");
  return failures == 0 ? 0 : 1;
}
