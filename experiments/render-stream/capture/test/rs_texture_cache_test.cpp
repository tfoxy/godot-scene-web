// Unit tests for the persisted host texture cache (src/rs_texture_cache.*; texture-delivery-design.md
// D7, D8; G8kc), with no engine: put/get across a reopen, verify-against-name, the delete of a
// corrupt file, the LRU byte budget (recency is the last use, a hit counts), hash sharing between
// keys, key validation, parallel gets, the config parser.

#include <atomic>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <string>
#include <thread>
#include <unistd.h>
#include <vector>

#include "rs_sha256.h"
#include "rs_texture_cache.h"

namespace {

using grc::rs::CacheConfig;
using grc::rs::CacheKey;
using grc::rs::CacheResult;
using grc::rs::TextureCache;
namespace fs = std::filesystem;

int g_failures = 0;
int g_checks = 0;

void check(bool ok, const char *what) {
  ++g_checks;
  if (!ok) {
    ++g_failures;
    std::printf("FAIL: %s\n", what);
  }
}

std::string hex_of(char fill) { return std::string(64, fill); }

std::vector<std::uint8_t> bytes_of(std::size_t n, std::uint8_t seed) {
  std::vector<std::uint8_t> v(n);
  for (std::size_t i = 0; i < n; ++i) v[i] = static_cast<std::uint8_t>(seed + i * 7);
  return v;
}

std::string hash_of(const std::vector<std::uint8_t> &v) {
  return grc::sha256_hex(v.data(), v.size());
}

CacheKey key_of(char source, const char *encoding = "decoded",
                const char *params = "engine-decompress/4.5.1") {
  return CacheKey{hex_of(source), encoding, params};
}

bool store(TextureCache &c, const CacheKey &k, const std::vector<std::uint8_t> &v,
           const char *ext = "grt") {
  return c.put(k, hash_of(v), v.data(), v.size(), ext);
}

void test_roundtrip_and_reopen(const std::string &dir) {
  TextureCache c;
  std::string err;
  check(c.open(CacheConfig{dir, 0}, &err), "open");
  const auto v = bytes_of(100, 1);
  check(store(c, key_of('a'), v), "put");
  std::vector<std::uint8_t> out;
  std::string h;
  check(c.get(key_of('a'), &out, &h) == CacheResult::Hit && out == v && h == hash_of(v), "hit");
  check(c.get(key_of('b'), &out, &h) == CacheResult::Miss, "miss on another source");
  check(c.get(key_of('a', "uastc", "basisu-1.60/uastc-l2/zstd6/linear"), &out, &h) ==
            CacheResult::Miss,
        "miss on another encoding and params");
  check(c.has(key_of('a')), "has");
  // The same bytes under a KTX2 key live in their own extension.
  const auto k2 = bytes_of(50, 9);
  check(store(c, key_of('a', "uastc", "basisu-1.60/uastc-l2/zstd6/linear"), k2, "ktx2"), "put ktx2");
  check(fs::exists(dir + "/sha256/" + hash_of(k2) + ".ktx2"), "ktx2 file named by its hash");
  c.close();

  TextureCache d;
  check(d.open(CacheConfig{dir, 0}, &err), "reopen");
  check(d.get(key_of('a'), &out, &h) == CacheResult::Hit && out == v, "hit after reopen");
  check(d.get(key_of('a', "uastc", "basisu-1.60/uastc-l2/zstd6/linear"), &out, &h) ==
                CacheResult::Hit &&
            out == k2,
        "ktx2 hit after reopen");
  const auto s = d.stats();
  check(s.entries == 2 && s.files == 2 && s.bytes == 150, "stats after reopen");
}

void test_corrupt(const std::string &dir) {
  TextureCache c;
  std::string err;
  check(c.open(CacheConfig{dir, 0}, &err), "open corrupt");
  const auto v = bytes_of(64, 3);
  check(store(c, key_of('c'), v), "put c");
  check(store(c, key_of('d'), v), "put d, the same bytes under another key");
  const std::string path = dir + "/sha256/" + hash_of(v) + ".grt";
  {
    std::fstream f(path, std::ios::in | std::ios::out | std::ios::binary);
    f.seekp(10);
    char x = 0x55;
    f.write(&x, 1);
  }
  std::vector<std::uint8_t> out;
  std::string h;
  check(c.get(key_of('c'), &out, &h) == CacheResult::Corrupt, "a flipped byte is Corrupt");
  check(!fs::exists(path), "the corrupt file is deleted");
  check(!c.has(key_of('c')) && !c.has(key_of('d')), "every row naming it is gone");
  check(c.get(key_of('d'), &out, &h) == CacheResult::Miss, "the sibling key misses now");
  check(c.stats().corrupt == 1, "corrupt counted");
  check(store(c, key_of('c'), v), "re-derived and stored again");
  check(c.get(key_of('c'), &out, &h) == CacheResult::Hit && out == v, "hit after repair");

  // A truncated file and a missing one.
  const auto w = bytes_of(80, 5);
  check(store(c, key_of('e'), w), "put e");
  fs::resize_file(dir + "/sha256/" + hash_of(w) + ".grt", 40);
  check(c.get(key_of('e'), &out, &h) == CacheResult::Corrupt, "a truncated file is Corrupt");
  check(store(c, key_of('e'), w), "put e again");
  fs::remove(dir + "/sha256/" + hash_of(w) + ".grt");
  check(c.get(key_of('e'), &out, &h) == CacheResult::Miss, "a missing file is a Miss");
  check(!c.has(key_of('e')), "and its row is dropped");

  // The index survives a reopen after all that.
  c.close();
  TextureCache d;
  check(d.open(CacheConfig{dir, 0}, &err), "reopen after corruption");
  check(d.get(key_of('c'), &out, &h) == CacheResult::Hit, "repaired entry persisted");
  check(!d.has(key_of('d')) && !d.has(key_of('e')), "deleted rows stay deleted");
}

void test_lru(const std::string &dir) {
  TextureCache c;
  std::string err;
  check(c.open(CacheConfig{dir, 250}, &err), "open lru");
  const auto a = bytes_of(100, 1), b = bytes_of(100, 2), cc = bytes_of(100, 3);
  check(store(c, key_of('a'), a), "put a");
  check(store(c, key_of('b'), b), "put b");
  std::vector<std::uint8_t> out;
  std::string h;
  check(c.get(key_of('a'), &out, &h) == CacheResult::Hit, "touch a: b is now the least recent");
  check(store(c, key_of('c'), cc), "put c: over budget");
  check(!c.has(key_of('b')), "b (least recently used) was evicted");
  check(c.has(key_of('a')) && c.has(key_of('c')), "a and c stay");
  check(!fs::exists(dir + "/sha256/" + hash_of(b) + ".grt"), "b's file is gone");
  check(c.stats().evicted == 1 && c.stats().bytes == 200, "evicted counted, bytes within budget");
  // Recency survives a reopen.
  c.close();
  TextureCache d;
  check(d.open(CacheConfig{dir, 250}, &err), "reopen lru");
  const auto e = bytes_of(100, 4);
  check(store(d, key_of('e'), e), "put e");
  check(!d.has(key_of('a')) && d.has(key_of('c')) && d.has(key_of('e')),
        "after a reopen a (older than c) goes first");
  // A single entry over budget stays (nothing else to evict).
  const auto big = bytes_of(400, 8);
  check(store(d, key_of('f'), big), "put an entry over the whole budget");
  check(d.has(key_of('f')), "it is kept");
  check(!d.has(key_of('c')) && !d.has(key_of('e')), "and everything else went");
}

void test_sharing_and_validation(const std::string &dir) {
  TextureCache c;
  std::string err;
  check(c.open(CacheConfig{dir, 150}, &err), "open sharing");
  const auto v = bytes_of(100, 1);
  check(store(c, key_of('a'), v) && store(c, key_of('b'), v), "two keys, one file");
  check(c.stats().files == 1 && c.stats().bytes == 100 && c.stats().entries == 2,
        "one file counted once");
  const auto w = bytes_of(100, 2);
  check(store(c, key_of('c'), w), "put w over budget");
  check(!c.has(key_of('a')) && !c.has(key_of('b')) && c.has(key_of('c')),
        "evicting a shared file drops every key on it");

  check(!c.put(CacheKey{"nothex", "decoded", "p"}, hash_of(v), v.data(), v.size(), "grt"),
        "bad source refused");
  check(!c.put(key_of('a', "bogus"), hash_of(v), v.data(), v.size(), "grt"), "bad encoding refused");
  check(!c.put(key_of('a', "decoded", "has space"), hash_of(v), v.data(), v.size(), "grt"),
        "bad params refused");
  check(!c.put(key_of('a'), "short", v.data(), v.size(), "grt"), "bad hash refused");
  check(!c.put(key_of('a'), hash_of(v), v.data(), v.size(), "../x"), "bad ext refused");
  // A hash that is a traversal can never become a path: hex64 only.
  check(!c.put(key_of('a'), std::string(64, '/'), v.data(), v.size(), "grt"), "slash hash refused");
}

void test_parallel(const std::string &dir) {
  TextureCache c;
  std::string err;
  check(c.open(CacheConfig{dir, 0}, &err), "open parallel");
  std::vector<std::vector<std::uint8_t>> vs;
  for (int i = 0; i < 8; ++i) {
    vs.push_back(bytes_of(2000 + i, static_cast<std::uint8_t>(i)));
    check(store(c, key_of(static_cast<char>('0' + i)), vs.back()), "put parallel");
  }
  std::atomic<int> bad{0};
  std::vector<std::thread> threads;
  for (int t = 0; t < 4; ++t) {
    threads.emplace_back([&]() {
      for (int round = 0; round < 50; ++round) {
        for (int i = 0; i < 8; ++i) {
          std::vector<std::uint8_t> out;
          std::string h;
          if (c.get(key_of(static_cast<char>('0' + i)), &out, &h) != CacheResult::Hit ||
              out != vs[static_cast<std::size_t>(i)]) {
            ++bad;
          }
        }
      }
    });
  }
  for (auto &t : threads) t.join();
  check(bad.load() == 0, "parallel gets all hit with the right bytes");
  check(c.stats().hits == 4 * 50 * 8, "hits counted");
}

void test_config() {
  CacheConfig cfg;
  std::string err;
  check(grc::rs::parse_cache_config(nullptr, nullptr, &cfg, &err) && cfg.dir.empty(), "unset");
  check(grc::rs::parse_cache_config("/x", "1048576", &cfg, &err) && cfg.max_bytes == 1048576,
        "dir and max");
  check(!grc::rs::parse_cache_config("/x", "12abc", &cfg, &err) &&
            err.find("GRC_TEXTURE_CACHE_MAX_BYTES") != std::string::npos,
        "bad max named");
  check(!grc::rs::parse_cache_config(nullptr, "10", &cfg, &err), "max without dir refused");
  check(grc::rs::parse_cache_config("", "", &cfg, &err) && cfg.dir.empty(), "empty is unset");
}

void test_compaction(const std::string &dir) {
  TextureCache c;
  std::string err;
  check(c.open(CacheConfig{dir, 0}, &err), "open compaction");
  const auto v = bytes_of(32, 1);
  check(store(c, key_of('a'), v), "put");
  std::vector<std::uint8_t> out;
  std::string h;
  for (int i = 0; i < 100; ++i) c.get(key_of('a'), &out, &h);  // 100 touch rows
  c.close();
  TextureCache d;
  check(d.open(CacheConfig{dir, 0}, &err), "reopen compacts");
  std::ifstream in(dir + "/index-v1.jsonl");
  int lines = 0;
  std::string line;
  while (std::getline(in, line)) ++lines;
  check(lines == 1, "the grown index was rewritten to one row per entry");
  check(d.get(key_of('a'), &out, &h) == CacheResult::Hit, "and still hits");
}

}  // namespace

int main() {
  const std::string root = fs::temp_directory_path().string() + "/rs_texture_cache_test." +
                           std::to_string(static_cast<long>(::getpid()));
  fs::remove_all(root);
  test_config();
  test_roundtrip_and_reopen(root + "/rt");
  test_corrupt(root + "/corrupt");
  test_lru(root + "/lru");
  test_sharing_and_validation(root + "/share");
  test_parallel(root + "/par");
  test_compaction(root + "/compact");
  fs::remove_all(root);
  std::printf("%d checks, %d failures\n", g_checks, g_failures);
  return g_failures == 0 ? 0 : 1;
}
