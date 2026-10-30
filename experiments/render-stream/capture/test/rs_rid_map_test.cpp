// HC6: unit tests for the mirror's flat RID map (src/rs_rid_map.h): every operation the mirror uses,
// against std::unordered_map over long random sequences (dense Godot-like RIDs, colliding keys,
// key 0), so backward-shift deletion and growth keep every key reachable.

#include "rs_rid_map.h"

#include <cstdint>
#include <cstdio>
#include <random>
#include <string>
#include <unordered_map>
#include <vector>

namespace {

int g_failures = 0;
int g_checks = 0;

void check(bool condition, const std::string &what) {
  ++g_checks;
  if (!condition) {
    std::fprintf(stderr, "FAIL %s\n", what.c_str());
    ++g_failures;
  }
}

using grc::rs::RidMap;

void test_basics() {
  RidMap<std::uint32_t> m;
  check(m.empty() && m.find(5) == m.end() && m.count(5) == 0 && m.erase(5) == 0, "empty map");
  m[5] = 7;
  check(m.size() == 1 && m.find(5) != m.end() && m.find(5)->first == 5 && m.find(5)->second == 7,
        "insert and find");
  m[5] = 9;
  check(m.size() == 1 && m.find(5)->second == 9, "assign keeps one entry");
  check(m[6] == 0 && m.size() == 2, "operator[] value-initialises");
  m[0] = 3;
  check(m.size() == 3 && m.count(0) == 1 && m.find(0)->second == 3 && m.find(0)->first == 0,
        "key 0 is a key");
  check(m.erase(std::uint64_t{0}) == 1 && m.count(0) == 0 && m.size() == 2, "erase key 0");
  auto it = m.find(5);
  m.erase(it);
  check(m.count(5) == 0 && m.size() == 1, "erase by iterator");
  m.clear();
  check(m.empty() && m.find(6) == m.end(), "clear");
  m[11] = 1;
  check(m.find(11)->second == 1, "insert after clear");
}

// Keys that share a home slot: probe runs that wrap the table's end and holes in their middle.
void test_collisions() {
  RidMap<std::uint32_t> m;
  m[1] = 1;  // capacity 64 now
  // Find keys with the same home (64 slots: the top 6 bits of key * golden).
  const auto home = [](std::uint64_t k) { return (k * 0x9E3779B97F4A7C15ull) >> 58; };
  for (std::uint64_t target : {0ull, 63ull}) {
    std::vector<std::uint64_t> same;
    for (std::uint64_t k = 2; same.size() < 6; ++k) {
      if (home(k) == target) {
        same.push_back(k);
      }
    }
    for (std::size_t i = 0; i < same.size(); ++i) {
      m[same[i]] = static_cast<std::uint32_t>(100 + i);
    }
    m.erase(same[1]);
    m.erase(same[3]);
    bool ok = true;
    for (std::size_t i = 0; i < same.size(); ++i) {
      const bool gone = i == 1 || i == 3;
      const auto f = m.find(same[i]);
      ok = ok && (gone ? f == m.end() : (f != m.end() && f->second == 100 + i));
    }
    check(ok, "colliding run at home " + std::to_string(target) + " survives erasures");
  }
}

void test_random(std::uint32_t seed, bool dense) {
  std::mt19937_64 rng(seed);
  RidMap<std::uint32_t> m;
  std::unordered_map<std::uint64_t, std::uint32_t> ref;
  // Godot RIDs: a validator in the high word, a slot index in the low one (dense); or anything.
  const auto key = [&]() -> std::uint64_t {
    if (dense) {
      return (std::uint64_t{rng() % 4} << 32) | (rng() % 6000);
    }
    return rng() % 7 == 0 ? 0 : rng();
  };
  std::vector<std::uint64_t> live;
  bool ok = true;
  for (int step = 0; step < 200000 && ok; ++step) {
    const unsigned op = rng() % 10;
    if (op < 5) {
      const std::uint64_t k = key();
      const auto v = static_cast<std::uint32_t>(rng());
      m[k] = v;
      ref[k] = v;
      live.push_back(k);
    } else if (op < 8) {
      std::uint64_t k = !live.empty() && (rng() & 1) ? live[rng() % live.size()] : key();
      ok = m.erase(k) == ref.erase(k);
    } else {
      std::uint64_t k = !live.empty() && (rng() & 1) ? live[rng() % live.size()] : key();
      const auto a = m.find(k);
      const auto b = ref.find(k);
      ok = (a == m.end()) == (b == ref.end()) && (a == m.end() || a->second == b->second);
    }
    ok = ok && m.size() == ref.size();
  }
  for (const auto &entry : ref) {
    const auto f = m.find(entry.first);
    ok = ok && f != m.end() && f->second == entry.second;
  }
  check(ok, std::string("random ops agree with unordered_map (") + (dense ? "dense" : "sparse") +
                " keys, seed " + std::to_string(seed) + ")");
}

}  // namespace

int main() {
  test_basics();
  test_collisions();
  for (std::uint32_t seed = 1; seed <= 4; ++seed) {
    test_random(seed, true);
    test_random(seed, false);
  }
  std::printf("rs_rid_map_test: %d/%d checks passed\n", g_checks - g_failures, g_checks);
  return g_failures == 0 ? 0 : 1;
}
