#include "rs_platform.h"

#include <cstdio>
#include <cstdlib>
#include <cstring>

#if defined(_WIN32)
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#endif

namespace {
void set_value(const char *value) {
#if defined(_WIN32)
  const wchar_t *wide = nullptr;
  if (value) wide = std::strcmp(value, "first") == 0 ? L"first" : (*value ? L"café-日本" : L"");
  if (!::SetEnvironmentVariableW(L"GRC_RS_ENV_TEST", wide)) {
    std::fprintf(stderr, "FAIL SetEnvironmentVariableW: %lu\n", ::GetLastError());
    std::exit(1);
  }
#else
  if (value) ::setenv("GRC_RS_ENV_TEST", value, 1);
  else ::unsetenv("GRC_RS_ENV_TEST");
#endif
}
}

int main() {
  int checks = 0, failures = 0;
  auto check = [&](bool ok, const char *what) {
    ++checks;
    if (!ok) { ++failures; std::fprintf(stderr, "FAIL %s\n", what); }
  };
  set_value(nullptr);
  check(grc::rs::env("GRC_RS_ENV_TEST") == nullptr, "unset");
  set_value("first");
  const char *first = grc::rs::env("GRC_RS_ENV_TEST");
  check(first && std::strcmp(first, "first") == 0, "set");
  set_value("café-日本");
  const char *changed = grc::rs::env("GRC_RS_ENV_TEST");
  check(changed && std::strcmp(changed, "café-日本") == 0, "changed UTF-8 value");
  check(first && std::strcmp(first, "first") == 0, "earlier pointer readable");
  check(changed == grc::rs::env("GRC_RS_ENV_TEST"), "unchanged value reuses storage");
#if defined(_WIN32)
  set_value("");
  ::SetLastError(ERROR_ENVVAR_NOT_FOUND);
  const char *empty = grc::rs::env("GRC_RS_ENV_TEST");
  check(empty && *empty == '\0', "set but empty");
  check(empty == grc::rs::env("GRC_RS_ENV_TEST"), "empty value reuses storage");
#endif
  set_value(nullptr);
  check(grc::rs::env("GRC_RS_ENV_TEST") == nullptr, "removed");
  check(changed && std::strcmp(changed, "café-日本") == 0, "removed pointer readable");
  std::printf("rs_env_test: %d checks, %d failures\n", checks, failures);
  return failures ? 1 : 0;
}
