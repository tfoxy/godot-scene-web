#include "rs_platform.h"
#include "rs_sha256.h"
#include "rs_texture_cache.h"

#include <cstdio>
#include <cstring>
#include <fstream>
#include <set>
#include <string>
#include <system_error>
#include <vector>

using namespace grc::rs;

namespace {
bool write(const std::string &path, const std::string &bytes) {
  auto *file = open_file(path, "wb");
  if (!file)
    return false;
  const bool ok = std::fwrite(bytes.data(), 1, bytes.size(), file) == bytes.size();
  return std::fclose(file) == 0 && ok;
}

bool read_equals(const std::string &path, const std::string &expected) {
  auto *file = open_file(path, "rb");
  if (!file)
    return false;
  std::string bytes;
  char buffer[256];
  std::size_t n;
  while ((n = std::fread(buffer, 1, sizeof(buffer), file)) != 0)
    bytes.append(buffer, n);
  const bool ok = !std::ferror(file) && bytes == expected;
  return std::fclose(file) == 0 && ok;
}

bool non_ascii(const std::string &root) {
  const auto dir = root + "/évidence-á/ñ";
  const auto path = dir + "/report.json";
  const std::string json = "{\"evidence\":\"é-á-ñ\"}\n";
  if (!make_directories(dir) || !is_directory(dir) || !write(path, json) ||
      !read_equals(path, json))
    return false;
  std::error_code ec;
  std::filesystem::directory_iterator it(fs_path(dir), ec), end;
  if (ec || it == end || it->path() != fs_path(path))
    return false;
  it.increment(ec);
  if (ec || it != end || !remove_file(path))
    return false;
  return !std::filesystem::exists(fs_path(path), ec) && !ec;
}

bool replace_twice(const std::string &root) {
  const auto temp = root + "/x.json.tmp";
  const auto path = root + "/x.json";
  const std::string first = "{\"version\":1}\n", second = "{\"version\":2}\n";
  return write(temp, first) && replace_file(temp, path) && read_equals(path, first) &&
         write(temp, second) && replace_file(temp, path) && read_equals(path, second);
}

bool cache_remove_after_read(const std::string &root) {
  // Verification must release the payload reader before deleting a corrupt file on Windows.
  const auto dir = root + "/cache-remove";
  const CacheKey key{std::string(64, 'a'), "decoded", "test"};
  const std::vector<std::uint8_t> bytes{1, 2, 3, 4};
  const auto hash = grc::sha256_hex(bytes.data(), bytes.size());
  const auto path = dir + "/sha256/" + hash + ".grt";
  TextureCache cache;
  std::string error, found;
  std::vector<std::uint8_t> out;
  if (!cache.open({dir, 0}, &error) ||
      !cache.put(key, hash, bytes.data(), bytes.size(), "grt") || !write(path, "bad!"))
    return false;
  std::error_code ec;
  if (cache.get(key, &out, &found) != CacheResult::Corrupt ||
      std::filesystem::exists(fs_path(path), ec) || ec ||
      !cache.put(key, hash, bytes.data(), bytes.size(), "grt") ||
      cache.get(key, &out, &found) != CacheResult::Hit || out != bytes)
    return false;
  cache.close();
  return cache.open({dir, 0}, &error) && cache.get(key, &out, &found) == CacheResult::Hit &&
         out == bytes;
}

bool cache_replace_after_read(const std::string &root) {
  // Reopening reads the index, then compacts it by replacing the file just read.
  const auto dir = root + "/cache-replace";
  const CacheKey key{std::string(64, 'b'), "decoded", "test"};
  const std::vector<std::uint8_t> bytes{5, 6, 7, 8};
  const auto hash = grc::sha256_hex(bytes.data(), bytes.size());
  TextureCache cache;
  std::string error, found;
  std::vector<std::uint8_t> out;
  if (!cache.open({dir, 0}, &error) ||
      !cache.put(key, hash, bytes.data(), bytes.size(), "grt"))
    return false;
  for (int i = 0; i < 20; ++i) {
    if (cache.get(key, &out, &found) != CacheResult::Hit)
      return false;
  }
  cache.close();
  if (!cache.open({dir, 0}, &error))
    return false;
  {
    std::ifstream in(fs_path(dir + "/index-v1.jsonl"));
    std::string line;
    if (!std::getline(in, line) || std::getline(in, line) || !in.eof())
      return false;
  }
  return cache.get(key, &out, &found) == CacheResult::Hit && out == bytes;
}
} // namespace

int main(int argc, char **argv) {
  std::set<std::string> expected, failed;
  if (argc != 1) {
    if (argc != 3 || std::strcmp(argv[1], "--expect-fail") != 0 ||
        (std::strcmp(argv[2], "non-ascii") != 0 && std::strcmp(argv[2], "replace-twice") != 0)) {
      std::fprintf(stderr, "usage: rs_platform_paths_test [--expect-fail non-ascii|replace-twice]\n");
      return 2;
    }
    expected.insert(argv[2]);
  }

  // Each invocation owns a directory, including concurrent manifest runs.
  const std::string root = std::string(GRC_TEST_TMP_DIR) + "-" + std::to_string(process_id());
  std::error_code ec;
  const bool created = std::filesystem::create_directory(fs_path(root), ec);
  if (!created || ec) {
    std::fprintf(stderr, "FAIL setup: cannot create %s: %s\n", root.c_str(), ec.message().c_str());
    return 1;
  }
  auto check = [&](bool ok, const char *name) {
    std::printf("%s %s\n", ok ? "ok  " : "FAIL", name);
    if (!ok)
      failed.insert(name);
  };
  check(non_ascii(root), "non-ascii");
  check(replace_twice(root), "replace-twice");
  check(cache_remove_after_read(root), "cache-remove-after-read");
  check(cache_replace_after_read(root), "cache-replace-after-read");
  std::filesystem::remove_all(fs_path(root), ec);
  if (ec) {
    std::fprintf(stderr, "FAIL cleanup: %s\n", ec.message().c_str());
    return 1;
  }
  std::printf("rs_platform_paths_test: %zu/4 ok; %zu expected failures\n", 4 - failed.size(),
              expected.size());
  if (failed != expected) {
    std::fprintf(stderr, "FAIL: observed failures do not match --expect-fail\n");
    return 1;
  }
  return 0;
}
