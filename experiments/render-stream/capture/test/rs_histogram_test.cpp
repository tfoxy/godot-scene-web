// Unit tests for the fixed-size log-linear histogram (src/rs_histogram.h, gate6-design.md Q3d):
// bucket boundaries, the 6.25% relative-error bound, exact count/sum/min/max, percentile
// sanity, the top-bucket clamp for values beyond the covered range, and the JSON shape.

#include "rs_histogram.h"

#include <cmath>
#include <cstdio>
#include <string>

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

// The formula, computed independently (not reusing the implementation's integer arithmetic), to
// cross-check Histogram::bucket_index over a sweep of values.
int reference_bucket_index(std::uint64_t value) {
  using grc::Histogram;
  if (value <= 1) {
    return 0;
  }
  int octave = 0;
  while ((1ull << (octave + 1)) <= value && octave + 1 < Histogram::kOctaves) {
    ++octave;
  }
  if ((1ull << (octave + 1)) <= value) {
    return Histogram::kBucketCount - 1;  // beyond the covered range: the top bucket
  }
  const std::uint64_t base = 1ull << octave;
  const std::uint64_t remainder = value - base;
  int sub = static_cast<int>((remainder * static_cast<std::uint64_t>(Histogram::kSubBuckets)) /
                              base);
  if (sub >= Histogram::kSubBuckets) {
    sub = Histogram::kSubBuckets - 1;
  }
  return octave * Histogram::kSubBuckets + sub;
}

void test_bucket_index_boundaries() {
  using grc::Histogram;
  check(Histogram::bucket_index(0) == 0, "0 -> bucket 0");
  check(Histogram::bucket_index(1) == 0, "1 -> bucket 0");
  check(Histogram::bucket_index(2) == Histogram::kSubBuckets, "2 starts octave 1 (bucket 16)");
  check(Histogram::bucket_index(4) == 2 * Histogram::kSubBuckets, "4 starts octave 2");
  // Octave 4 is [16, 32), 16 sub-buckets each 1 wide: value v maps to sub v-16.
  for (int v = 16; v < 32; ++v) {
    const int want = 4 * Histogram::kSubBuckets + (v - 16);
    check(Histogram::bucket_index(static_cast<std::uint64_t>(v)) == want,
          "octave 4 value " + std::to_string(v) + " -> bucket " + std::to_string(want));
  }
  // Octave 10 is [1024, 2048), width 64 per sub-bucket.
  check(Histogram::bucket_index(1024) == 10 * Histogram::kSubBuckets, "1024 starts octave 10");
  check(Histogram::bucket_index(1087) == 10 * Histogram::kSubBuckets, "1087 = 1024 + 63 (last of sub 0)");
  check(Histogram::bucket_index(1088) == 10 * Histogram::kSubBuckets + 1, "1088 = 1024 + 64 (sub 1)");
  check(Histogram::bucket_index(2047) == 10 * Histogram::kSubBuckets + 15, "2047 is octave 10's last sub-bucket");

  // Cross-check against the independent reference over every small value and a log-spaced sweep
  // of larger ones, including well past the covered range (clamp behaviour).
  for (std::uint64_t v = 0; v < 5000; ++v) {
    check(Histogram::bucket_index(v) == reference_bucket_index(v),
          "bucket_index(" + std::to_string(v) + ") matches the reference formula");
  }
  for (int shift = 0; shift < 40; ++shift) {
    for (std::uint64_t delta = 0; delta < 3; ++delta) {
      const std::uint64_t v = (1ull << shift) + delta;
      check(Histogram::bucket_index(v) == reference_bucket_index(v),
            "bucket_index(2^" + std::to_string(shift) + "+" + std::to_string(delta) +
                ") matches the reference formula");
    }
  }
}

// bucket_index must never decrease as the value increases (percentile() walks buckets in index
// order and relies on this to correspond to walking samples in increasing value order).
void test_bucket_index_monotonic() {
  using grc::Histogram;
  int previous = 0;
  for (std::uint64_t v = 0; v < 200000; ++v) {
    const int i = Histogram::bucket_index(v);
    check(i >= previous, "bucket_index is non-decreasing at v=" + std::to_string(v));
    previous = i;
  }
}

void test_top_bucket_clamp() {
  using grc::Histogram;
  const int top = Histogram::kBucketCount - 1;
  check(Histogram::bucket_index(1u << 25) == top, "2^25 clamps to the top bucket");
  check(Histogram::bucket_index(~0ull) == top, "the largest uint64 clamps to the top bucket");
  // Just inside the covered range (2^25 - 1) still falls in octave 24.
  check(Histogram::bucket_index((1ull << 25) - 1) == top,
        "2^25 - 1 is octave 24's last sub-bucket (also the top bucket)");
}

// Below octave 4 (values < 16), 16 equal-width integer sub-buckets cannot all be distinct (you
// cannot subdivide a run of 1/2/4/8 integers into 16 parts with integer edges): most of those
// low sub-buckets are simply unreachable by any value and read back as a smaller bucket's lower
// bound. That is harmless (they stay permanently empty; add() never routes a value there) but it
// means the strict-monotonic/round-trip properties below only hold, in general, for buckets a
// real value can land in. This test checks the property the contract actually promises: for
// EVERY representable value, the bucket it lands in has a lower bound within 6.25% of it.
void test_bucket_lower_bound_error_bound() {
  using grc::Histogram;
  const auto check_value = [](std::uint64_t v) {
    if (v == 0) {
      check(Histogram::bucket_index(v) == 0, "0 is in bucket 0 (its exact value is still exact"
                                              " via min(), not approximated by a bucket edge)");
      return;
    }
    const int i = Histogram::bucket_index(v);
    const std::uint64_t lo = Histogram::bucket_lower_bound(i);
    check(lo <= v, "bucket_lower_bound(" + std::to_string(i) + ") = " + std::to_string(lo) +
                       " <= its value " + std::to_string(v));
    const std::uint64_t covered = 1ull << Histogram::kOctaves;  // 2^25: the clamp's edge
    if (v >= covered) {
      return;  // the top bucket is a catch-all past here; no error bound applies
    }
    if (lo >= 1) {
      const double relative = static_cast<double>(v - lo) / static_cast<double>(lo);
      check(relative <= 1.0 / 16.0 + 1e-9,
            "value " + std::to_string(v) + " is within 6.25% of its bucket's lower bound " +
                std::to_string(lo) + " (got " + std::to_string(relative) + ")");
    }
  };
  for (std::uint64_t v = 0; v < 5000; ++v) {
    check_value(v);
  }
  // shift capped below kOctaves - 1 so every generated value stays inside the covered range.
  for (int shift = 4; shift < Histogram::kOctaves - 1; ++shift) {
    for (std::uint64_t delta = 0; delta < 50; ++delta) {
      check_value((1ull << shift) + delta * (1ull << shift) / 53);
    }
  }
  // Values at or past the covered range (2^25) land in the clamped top bucket; its lower bound
  // must still not exceed them (the error bound itself does not apply past the covered range).
  check(Histogram::bucket_lower_bound(Histogram::kBucketCount - 1) <= (1ull << 25),
        "the top bucket's lower bound is at or before the covered range's edge");
  check_value(1ull << 25);
  check_value(~0ull);

  // From octave 4 up (base >= 16 = kSubBuckets), every one of the 16 sub-buckets is reachable
  // and bucket_lower_bound is strictly increasing across them.
  for (int octave = 4; octave < Histogram::kOctaves; ++octave) {
    std::uint64_t previous = 0;
    for (int sub = 0; sub < Histogram::kSubBuckets; ++sub) {
      const int i = octave * Histogram::kSubBuckets + sub;
      const std::uint64_t lo = Histogram::bucket_lower_bound(i);
      check(sub == 0 || lo > previous,
            "octave " + std::to_string(octave) + " sub " + std::to_string(sub) +
                " lower bound strictly increases");
      check(Histogram::bucket_index(lo) == i,
            "octave " + std::to_string(octave) + " sub " + std::to_string(sub) +
                " lower bound round-trips to its own bucket");
      previous = lo;
    }
  }
}

void test_exact_aggregates() {
  grc::Histogram h;
  check(h.count() == 0 && h.sum() == 0 && h.min() == 0 && h.max() == 0 && h.mean() == 0.0,
        "an empty histogram reports zero everywhere");
  const std::uint64_t values[] = {5, 1, 1000, 0, 42};
  std::uint64_t sum = 0, mn = UINT64_MAX, mx = 0;
  for (std::uint64_t v : values) {
    h.add(v);
    sum += v;
    mn = std::min(mn, v);
    mx = std::max(mx, v);
  }
  check(h.count() == 5, "count is exact");
  check(h.sum() == sum, "sum is exact");
  check(h.min() == mn, "min is exact (0 included)");
  check(h.max() == mx, "max is exact");
  check(std::fabs(h.mean() - static_cast<double>(sum) / 5.0) < 1e-9, "mean is exact");
}

void test_percentile_sanity() {
  grc::Histogram h;
  for (std::uint64_t v = 1; v <= 100; ++v) {
    h.add(v);
  }
  const std::uint64_t p50 = h.percentile(50);
  const std::uint64_t p99 = h.percentile(99);
  const std::uint64_t p100 = h.percentile(100);
  // Bucket boundaries mean these are approximate, but order and rough magnitude must hold.
  check(p50 >= 40 && p50 <= 60, "p50 of 1..100 lands near the middle (got " +
                                     std::to_string(p50) + ")");
  check(p99 >= p50, "p99 >= p50");
  check(p100 >= p99, "p100 >= p99");
  check(p100 <= 100, "p100 never exceeds the true max's bucket");
  grc::Histogram empty;
  check(empty.percentile(50) == 0, "percentile on an empty histogram is 0");
}

void test_json_shape() {
  grc::Histogram h;
  h.add(10);
  h.add(10);
  h.add(2000);
  const std::string json = h.to_json();
  check(json.find("\"count\": 3") != std::string::npos, "count in the JSON");
  check(json.find("\"sum\": 2020") != std::string::npos, "sum in the JSON");
  check(json.find("\"min\": 10") != std::string::npos, "min in the JSON");
  check(json.find("\"max\": 2000") != std::string::npos, "max in the JSON");
  check(json.find("\"buckets\"") != std::string::npos, "a buckets array in the JSON");
  // Only two distinct buckets were touched (10 and 2000 fall in different octaves).
  const std::size_t first = json.find('[', json.find("\"buckets\""));
  check(first != std::string::npos, "buckets array opens");
  int bracket_pairs = 0;
  for (std::size_t i = 0; i < json.size(); ++i) {
    if (json[i] == '[') ++bracket_pairs;
  }
  // One for the outer array, one per non-empty bucket (2 touched values in 2 different buckets).
  check(bracket_pairs == 3, "exactly 3 '[' (outer buckets array + 2 non-empty bucket pairs), got " +
                                std::to_string(bracket_pairs));

  grc::Histogram empty;
  const std::string empty_json = empty.to_json();
  check(empty_json.find("\"buckets\": []") != std::string::npos ||
            empty_json.find("\"buckets\": [\n") == std::string::npos,
        "an empty histogram's buckets array has no entries");
}

}  // namespace

int main() {
  test_bucket_index_boundaries();
  test_bucket_index_monotonic();
  test_top_bucket_clamp();
  test_bucket_lower_bound_error_bound();
  test_exact_aggregates();
  test_percentile_sanity();
  test_json_shape();
  std::printf("rs_histogram_test: %d checks, %d failures\n", g_checks, g_failures);
  return g_failures == 0 ? 0 : 1;
}
