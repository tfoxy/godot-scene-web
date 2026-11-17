#pragma once

#include "rs_platform.h"

#include <memory>

namespace grc::rs {

struct FileCloser {
  void operator()(std::FILE *file) const { std::fclose(file); }
};
using File = std::unique_ptr<std::FILE, FileCloser>;

// Like getline, return the last unterminated line and exclude the newline.
inline bool file_getline(std::FILE *file, std::string *line) {
  line->clear();
  if (!file) return false;
  int c;
  while ((c = std::fgetc(file)) != EOF) {
    if (c == '\n') return true;
    line->push_back(static_cast<char>(c));
  }
  return !line->empty();
}

template <typename Bytes>
bool file_read_all(std::FILE *file, Bytes *out) {
  if (!file) return false;
  char buffer[8192];
  std::size_t n;
  while ((n = std::fread(buffer, 1, sizeof(buffer), file)) != 0)
    out->insert(out->end(), buffer, buffer + n);
  return !std::ferror(file);
}

} // namespace grc::rs
