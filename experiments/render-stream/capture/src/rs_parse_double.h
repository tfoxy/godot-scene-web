#ifndef GRC_RS_PARSE_DOUBLE_H
#define GRC_RS_PARSE_DOUBLE_H

#include <cerrno>
#include <cmath>
#include <cstdlib>
#include <locale.h>
#include <string>
#if defined(__APPLE__)
#include <xlocale.h>
#endif

namespace grc {
// The caller has already checked JSON number syntax. Bound the C-locale conversion to that
// token; leave the destination unchanged on range errors, as floating from_chars does.
inline void parse_json_double(const char *first, const char *last, double &value) {
  static locale_t locale = newlocale(LC_NUMERIC_MASK, "C", nullptr);
  if (!locale) {
    std::abort();
  }
  const std::string token(first, last);
  char *end = nullptr;
  errno = 0;
  const double parsed = strtod_l(token.c_str(), &end, locale);
  if (end == token.c_str() + token.size() && end != token.c_str() &&
      std::isfinite(parsed) && !(errno == ERANGE && parsed == 0)) {
    value = parsed;
  }
}
}  // namespace grc
#endif
