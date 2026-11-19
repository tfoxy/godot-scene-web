#include "rs_parse_double.h"

#include <clocale>
#include <cstdio>
#include <cstring>

int main() {
  int failures = 0;
  // Use the non-C locale when the runner provides one; parsing must remain C-locale.
  for (const char *locale : {"de_DE.UTF-8", "fr_FR.UTF-8", "de_DE.utf8"}) {
    if (std::setlocale(LC_NUMERIC, locale)) break;
  }
  struct Case { const char *token; double want; };
  for (const Case test : {Case{"0.0", 0}, {"-0.0", -0.0}, {"1.25", 1.25},
                         {"-2.5e+3", -2500}, {"1E-3", .001},
                         {"9223372036854775807", 9223372036854775807.0},
                         {"5e-324", 0x0.0000000000001p-1022},
                         {"1.7976931348623157e308", 0x1.fffffffffffffp+1023},
                         {"1e999", 17}, {"-1e-999", 17}}) {
    // The byte after the token is intentionally numeric: conversion must honor last.
    std::string bounded = std::string(test.token) + "9";
    double got = 17;
    grc::parse_json_double(bounded.data(), bounded.data() + std::strlen(test.token), got);
    if (std::memcmp(&got, &test.want, sizeof(got))) {
      std::fprintf(stderr, "FAIL parse_json_double %s: %.17g want %.17g\n", test.token, got, test.want);
      ++failures;
    }
  }
  std::setlocale(LC_NUMERIC, "C");
  std::printf("rs_parse_double: %d/10 passed\n", 10 - failures);
  return failures ? 1 : 0;
}
