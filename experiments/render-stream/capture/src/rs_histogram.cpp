#include "rs_histogram.h"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <limits>

namespace grc {

namespace {

constexpr std::uint64_t kMaxSum = std::numeric_limits<std::uint64_t>::max();

std::uint64_t saturating_add(std::uint64_t a, std::uint64_t b) {
  return a > kMaxSum - b ? kMaxSum : a + b;
}

}  // namespace

int Histogram::bucket_index(std::uint64_t value) {
  if (value <= 1) {
    return 0;
  }
  // clzll is undefined for 0; value >= 2 here.
  const int octave_raw = 63 - __builtin_clzll(value);
  if (octave_raw >= kOctaves) {
    return kOctaves * kSubBuckets - 1;  // the top bucket is a catch-all for anything larger
  }
  const std::uint64_t base = 1ULL << octave_raw;
  const std::uint64_t remainder = value - base;  // 0 <= remainder < base, by definition of octave
  int sub = static_cast<int>((remainder * kSubBuckets) / base);
  sub = std::min(sub, kSubBuckets - 1);
  return octave_raw * kSubBuckets + sub;
}

std::uint64_t Histogram::bucket_lower_bound(int i) {
  const int octave = i / kSubBuckets;
  const int sub = i % kSubBuckets;
  const std::uint64_t base = 1ULL << octave;
  return base + (base * static_cast<std::uint64_t>(sub)) / kSubBuckets;
}

void Histogram::add(std::uint64_t value) {
  ++count_;
  sum_ = saturating_add(sum_, value);
  min_ = std::min(min_, value);
  max_ = std::max(max_, value);
  ++buckets_[bucket_index(value)];
}

double Histogram::mean() const {
  return count_ == 0 ? 0.0 : static_cast<double>(sum_) / static_cast<double>(count_);
}

std::uint64_t Histogram::percentile(double p) const {
  if (count_ == 0) {
    return 0;
  }
  const double wanted = (p / 100.0) * static_cast<double>(count_);
  std::uint64_t rank = static_cast<std::uint64_t>(std::ceil(wanted));
  rank = std::max<std::uint64_t>(rank, 1);
  rank = std::min<std::uint64_t>(rank, count_);
  std::uint64_t cumulative = 0;
  for (int i = 0; i < kBucketCount; ++i) {
    cumulative += buckets_[i];
    if (cumulative >= rank) {
      return bucket_lower_bound(i);
    }
  }
  return max_;  // unreachable while count_ matches the sum of buckets_
}

void Histogram::write_json(JsonWriter *json) const {
  json->object_begin();
  json->field("count", static_cast<int64_t>(count_));
  json->field("sum", static_cast<int64_t>(sum_));
  json->field("min", static_cast<int64_t>(min()));
  json->field("max", static_cast<int64_t>(max_));
  json->key("mean").float32(static_cast<float>(mean()));
  json->key("buckets").array_begin();
  for (int i = 0; i < kBucketCount; ++i) {
    if (buckets_[i] == 0) {
      continue;
    }
    json->array_begin();
    json->unsigned_integer(bucket_lower_bound(i));
    json->unsigned_integer(buckets_[i]);
    json->array_end();
  }
  json->array_end();
  json->object_end();
}

std::string Histogram::to_json() const {
  JsonWriter json;
  write_json(&json);
  return json.take();
}

}  // namespace grc
