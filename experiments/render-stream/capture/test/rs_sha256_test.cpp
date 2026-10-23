// G2a: rs_sha256 against the FIPS 180-2 / 180-4 example vectors ("abc", the
// empty string, the 448-bit two-block message, one million 'a'), fed whole and
// in awkward pieces so the buffering across 64-byte blocks is exercised.
//
// G8sha: every vector runs on each path the CPU has, forced (Sha256(Sha256Path)), and on the
// default one; then the accelerated path must equal the portable one bit for bit on every length
// from 0 to 10,000 (random bytes, whole and in random pieces) and on a 16 MiB payload, the size of
// a 2048x2048 RGBA8 GRT1 texture. A CPU without SHA-NI says so and still checks the fallback.
#include <cstdint>
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

std::string whole(grc::Sha256 hash, const void *data, std::size_t size) {
  hash.update(data, size);
  return grc::sha256_hex(hash.finish());
}

std::string chunked(grc::Sha256 hash, const std::string &message, std::size_t piece) {
  for (std::size_t at = 0; at < message.size(); at += piece) {
    const std::size_t n = message.size() - at < piece ? message.size() - at : piece;
    hash.update(message.data() + at, n);
  }
  return grc::sha256_hex(hash.finish());
}

// xorshift32: deterministic bytes and piece sizes, no <random> distribution differences.
struct Rng {
  std::uint32_t x = 0x2545f491u;
  std::uint32_t next() {
    x ^= x << 13;
    x ^= x >> 17;
    x ^= x << 5;
    return x;
  }
};

std::string random_pieces(grc::Sha256 hash, const std::vector<std::uint8_t> &data, Rng *rng) {
  std::size_t at = 0;
  while (at < data.size()) {
    std::size_t n = rng->next() % 200;
    if (n > data.size() - at) {
      n = data.size() - at;
    }
    hash.update(data.data() + at, n);
    at += n;
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

  const bool sha_ni = grc::sha256_path_available(grc::Sha256Path::sha_ni);
  std::vector<grc::Sha256Path> paths = {grc::Sha256Path::portable};
  if (sha_ni) {
    paths.push_back(grc::Sha256Path::sha_ni);
  }
  const grc::Sha256Path def = grc::sha256_default_path();
  std::printf("rs_sha256_test: sha-ni %s, default path %s\n",
              sha_ni ? "available" : "NOT available (fallback only)", grc::sha256_path_name(def));
  // Dispatch: the default is the fastest available path, and never an unavailable one.
  if (def != (sha_ni ? grc::Sha256Path::sha_ni : grc::Sha256Path::portable)) {
    std::fprintf(stderr, "FAIL default path %s with sha-ni %s\n", grc::sha256_path_name(def),
                 sha_ni ? "available" : "unavailable");
    ++g_failures;
  }
  if (!grc::sha256_path_available(grc::Sha256Path::portable)) {
    std::fprintf(stderr, "FAIL portable reported unavailable\n");
    ++g_failures;
  }

  // The NIST vectors, through the one-shot helper (default path) and through each forced path,
  // whole and in pieces.
  for (const Vector &v : vectors) {
    expect_eq(grc::sha256_hex(v.message.data(), v.message.size()), v.digest, v.name);
    for (grc::Sha256Path path : paths) {
      const std::string base = std::string(v.name) + " [" + grc::sha256_path_name(path) + "]";
      expect_eq(whole(grc::Sha256(path), v.message.data(), v.message.size()), v.digest,
                base.c_str());
      for (std::size_t piece : {1u, 3u, 55u, 56u, 63u, 64u, 65u, 1000u}) {
        const std::string what = base + " in pieces of " + std::to_string(piece);
        if (v.message.size() > 100000 && piece < 55) {
          continue;  // the million-byte vector byte by byte is slow and adds nothing
        }
        expect_eq(chunked(grc::Sha256(path), v.message, piece), v.digest, what.c_str());
      }
    }
  }

  // Accelerated == portable on every length 0..10000 and on 16 MiB.
  Rng rng;
  const std::size_t big = 16u << 20;
  std::vector<std::uint8_t> data(big);
  for (auto &b : data) {
    b = static_cast<std::uint8_t>(rng.next());
  }
  int compared = 0;
  for (std::size_t len = 0; len <= 10000; ++len) {
    const std::string want = whole(grc::Sha256(grc::Sha256Path::portable), data.data(), len);
    expect_eq(grc::sha256_hex(data.data(), len), want,
              ("default, length " + std::to_string(len)).c_str());
    for (grc::Sha256Path path : paths) {
      if (path == grc::Sha256Path::portable) {
        continue;
      }
      const std::string name = grc::sha256_path_name(path);
      expect_eq(whole(grc::Sha256(path), data.data(), len), want,
                (name + ", length " + std::to_string(len)).c_str());
      if (len % 97 == 0) {
        const std::vector<std::uint8_t> slice(data.begin(), data.begin() + len);
        expect_eq(random_pieces(grc::Sha256(path), slice, &rng), want,
                  (name + " in random pieces, length " + std::to_string(len)).c_str());
      }
      ++compared;
    }
  }
  const std::string want_big = whole(grc::Sha256(grc::Sha256Path::portable), data.data(), big);
  // Pinned from coreutils sha256sum over the same xorshift32 bytes: an oracle outside this file.
  expect_eq(want_big, "d74f3ad976180d84e1e13d5b0db7bc8a2083d783c5802ab58fc0c145ba976c71",
            "portable, 16 MiB, against sha256sum");
  expect_eq(grc::sha256_hex(data.data(), big), want_big, "default, 16 MiB");
  for (grc::Sha256Path path : paths) {
    expect_eq(whole(grc::Sha256(path), data.data(), big), want_big,
              (std::string(grc::sha256_path_name(path)) + ", 16 MiB").c_str());
  }
  std::printf("rs_sha256_test: %d accelerated-vs-portable lengths compared, 16 MiB %s\n", compared,
              want_big.c_str());

  if (g_failures != 0) {
    std::fprintf(stderr, "rs_sha256_test: %d failure(s)\n", g_failures);
    return 1;
  }
  std::printf("rs_sha256_test: ok\n");
  return 0;
}
