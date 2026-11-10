#pragma once

#include "rs_platform.h"

#include <atomic>
#include <filesystem>
#include <string>
#include <system_error>

namespace grc::test {

// Keep native temp paths in UTF-8, including Windows account names.
inline std::string path_utf8(const std::filesystem::path &path) {
  const auto bytes = path.generic_u8string();
  return std::string(reinterpret_cast<const char *>(bytes.data()), bytes.size());
}

// Reserve a fresh directory atomically; never delete another invocation's files.
inline std::string temp_directory(const std::string &prefix) {
  static std::atomic<unsigned> serial{0};
  const auto parent = std::filesystem::temp_directory_path();
  for (;;) {
    const auto path = parent / rs::fs_path(prefix + "-" + std::to_string(rs::process_id()) + "-" +
                                         std::to_string(serial.fetch_add(1)));
    std::error_code error;
    if (std::filesystem::create_directory(path, error))
      return path_utf8(path);
    if (error && error != std::errc::file_exists)
      throw std::filesystem::filesystem_error("create test temp directory", path, error);
  }
}

// Missing trees are already clean. Do not interpret paths as shell commands.
inline bool remove_tree(const std::string &path) {
  std::error_code error;
  std::filesystem::remove_all(rs::fs_path(path), error);
  return !error;
}

}  // namespace grc::test
