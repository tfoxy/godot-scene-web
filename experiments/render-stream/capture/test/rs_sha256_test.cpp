// G2a: rs_sha256 against the FIPS 180-2 / 180-4 example vectors ("abc", the
// empty string, the 448-bit two-block message, one million 'a'), fed whole and
// in awkward pieces so the buffering across 64-byte blocks is exercised.
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

#include "rs_sha256.h"

namespace {

int g_failures = 0;

void expect_eq(const std::string &got, const std::string &want, const char *what) {
  if (got != want) {
    std::fprintf(stderr, "FAIL %s: got %s want %s\n", what, got.c_str(), want.c_str());
    ++g_failures;
  }
}

std::string chunked(const std::string &message, std::size_t piece) {
  grc::Sha256 hash;
  for (std::size_t at = 0; at < message.size(); at += piece) {
    const std::size_t n = message.size() - at < piece ? message.size() - at : piece;
    hash.update(message.data() + at, n);
  }
  return grc::sha256_hex(hash.finish());
}

}  // namespace

int main() {
  struct Vector {
    const char *name;
    std::string message;
    const char *digest;
  };
  const std::vector<Vector> vectors = {
      {"abc", "abc", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"},
      {"empty", "", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"},
      {"448-bit", "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq",
       "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1"},
      {"million-a", std::string(1000000, 'a'),
       "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0"},
  };
  for (const Vector &v : vectors) {
    expect_eq(grc::sha256_hex(v.message.data(), v.message.size()), v.digest, v.name);
    for (std::size_t piece : {1u, 3u, 55u, 56u, 63u, 64u, 65u, 1000u}) {
      const std::string what = std::string(v.name) + " in pieces of " + std::to_string(piece);
      if (v.message.size() > 100000 && piece < 55) {
        continue;  // the million-byte vector byte by byte is slow and adds nothing
      }
      expect_eq(chunked(v.message, piece), v.digest, what.c_str());
    }
  }
  if (g_failures != 0) {
    std::fprintf(stderr, "rs_sha256_test: %d failure(s)\n", g_failures);
    return 1;
  }
  std::printf("rs_sha256_test: ok\n");
  return 0;
}
