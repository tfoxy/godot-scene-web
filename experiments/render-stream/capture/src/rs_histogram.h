// A fixed-size log-linear histogram for non-negative integer samples (microsecond latencies and
// similar; gate6-design.md Q3d "Instrumentation and the evidence switch"): "log-linear
// histograms (16 sub-buckets per octave, at most 6.25% relative error, 400 fixed counters each,
// so nothing grows)".
//
// An octave k covers the value range [2^k, 2^(k+1)); its 16 sub-buckets are equal-width
// (2^k / 16), so a value's bucket identifies it to within 1/16 = 6.25% of its own magnitude (the
// worst case is the smallest value in a sub-bucket, one step above the sub-bucket's own lower
// edge). 25 octaves (k = 0..24) x 16 sub-buckets = 400 fixed counters, covering samples up to
// 2^25 - 1 (about 33.5 million, e.g. ~33.5 s of microseconds) before the top sub-bucket becomes a
// catch-all for anything larger. Storage is fixed at compile time: nothing grows at runtime, so a
// long-running capture or receiver can hold one of these per stage without an unbounded cost.
//
// Besides the buckets, exact count/sum/min/max ride alongside, so the exact total and mean are
// always available even though an individual sample is only known to within its bucket's bound.
// Values 0 and 1 both land in bucket 0 (octave 0's first sub-bucket); the exact fields still
// report a true 0 precisely.
#ifndef GRC_RS_HISTOGRAM_H
#define GRC_RS_HISTOGRAM_H

#include <cstdint>
#include <string>

#include "report.h"

namespace grc {

class Histogram {
 public:
  static constexpr int kOctaves = 25;
  static constexpr int kSubBuckets = 16;
  static constexpr int kBucketCount = kOctaves * kSubBuckets;  // 400

  // Adds one sample (a non-negative integer, e.g. microseconds).
  void add(std::uint64_t value);

  std::uint64_t count() const { return count_; }
  std::uint64_t sum() const { return sum_; }
  std::uint64_t min() const { return count_ == 0 ? 0 : min_; }
  std::uint64_t max() const { return max_; }
  // 0.0 when empty.
  double mean() const;

  // The bucket a value falls in (exposed for tests): 0 for value 0 or 1; otherwise
  // octave = floor(log2(value)) (clamped to kOctaves - 1), sub = floor(16 * (value/2^octave - 1))
  // (clamped to kSubBuckets - 1), combined index = octave * kSubBuckets + sub.
  static int bucket_index(std::uint64_t value);
  // The smallest value that could have produced a count in bucket `i` (its lower edge).
  static std::uint64_t bucket_lower_bound(int i);

  std::uint64_t bucket_count(int i) const { return buckets_[i]; }

  // Nearest-rank percentile (0..100] from the bucket distribution alone (an approximation bounded
  // by the 6.25% relative error above); 0 when empty. p <= 0 returns the lowest non-empty
  // bucket's lower bound; p >= 100 the highest.
  std::uint64_t percentile(double p) const;

  // render-stream-capture-perf/1's histogram object (Q3d), key order as given:
  // {"count","sum","min","max","mean","buckets":[[lower_bound,count],...]}, buckets in index
  // order, empty buckets omitted. Writes directly into the caller's object (entry.cpp composes
  // several of these into one perf.json).
  void write_json(JsonWriter *json) const;
  // A standalone rendering of write_json(), for tests.
  std::string to_json() const;

 private:
  std::uint64_t buckets_[kBucketCount] = {};
  std::uint64_t count_ = 0;
  std::uint64_t sum_ = 0;
  std::uint64_t min_ = UINT64_MAX;
  std::uint64_t max_ = 0;
};

}  // namespace grc

#endif  // GRC_RS_HISTOGRAM_H
