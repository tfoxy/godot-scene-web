// HC6 (host-cost-design.md D5 "Hook overhead per RenderingServer call", item 5): a flat map from a
// RenderingServer RID (any 64-bit value) to a small value, for the mirror's per-call lookups.
//
// std::unordered_map costs a hooked call two dependent cache misses (the bucket array, then the
// node) and a 64-bit division; on the capture-scale fixture its find was half of what
// canvas_item_set_transform and canvas_item_set_material cost the host. This table keeps the key
// and the value in one slot of an open-addressed array (linear probing, Fibonacci hashing, a
// power-of-two capacity at most half full, backward-shift deletion: no tombstones), so a lookup is
// one multiply and, usually, one cache line.
//
// The interface is the subset of std::unordered_map the mirror uses -- find/end, count,
// operator[], erase by key or by iterator, clear, size -- with `it->first` / `it->second`, so the
// lookups read as before. It is never iterated: there is no begin(). An iterator (a pointer to
// the slot) is valid until the next insertion or erasure, as with a rehashing unordered_map.
// Not synchronised; the mirror holds its mutex around every use.
#pragma once

#include <cstddef>
#include <cstdint>
#include <utility>
#include <vector>

namespace grc::rs {

template <typename V>
class RidMap {
 public:
  using value_type = std::pair<std::uint64_t, V>;
  using iterator = value_type *;
  using const_iterator = const value_type *;

  iterator end() { return nullptr; }
  const_iterator end() const { return nullptr; }
  std::size_t size() const { return size_ + (has_zero_ ? 1 : 0); }
  bool empty() const { return size() == 0; }

  iterator find(std::uint64_t key) { return const_cast<iterator>(std::as_const(*this).find(key)); }
  const_iterator find(std::uint64_t key) const {
    if (key == 0) {
      return has_zero_ ? &zero_ : nullptr;
    }
    if (slots_.empty()) {
      return nullptr;
    }
    for (std::size_t i = home(key);; i = (i + 1) & mask_) {
      const value_type &slot = slots_[i];
      if (slot.first == key) {
        return &slot;
      }
      if (slot.first == 0) {
        return nullptr;
      }
    }
  }
  std::size_t count(std::uint64_t key) const { return find(key) != nullptr ? 1 : 0; }

  // Inserts a value-initialised V when `key` is absent.
  V &operator[](std::uint64_t key) {
    if (key == 0) {
      if (!has_zero_) {
        has_zero_ = true;
        zero_.second = V();
      }
      return zero_.second;
    }
    if ((size_ + 1) * 2 > slots_.size()) {
      grow();
    }
    std::size_t i = home(key);
    for (;; i = (i + 1) & mask_) {
      if (slots_[i].first == key) {
        return slots_[i].second;
      }
      if (slots_[i].first == 0) {
        break;
      }
    }
    slots_[i].first = key;
    slots_[i].second = V();
    ++size_;
    return slots_[i].second;
  }

  std::size_t erase(std::uint64_t key) {
    if (key == 0) {
      const bool had = has_zero_;
      has_zero_ = false;
      zero_.second = V();
      return had ? 1 : 0;
    }
    if (slots_.empty()) {
      return 0;
    }
    std::size_t i = home(key);
    for (;; i = (i + 1) & mask_) {
      if (slots_[i].first == key) {
        break;
      }
      if (slots_[i].first == 0) {
        return 0;
      }
    }
    // Backward-shift deletion: move each later member of the probe run whose home does not lie
    // cyclically in (i, j] into the hole, so every key stays reachable from its home.
    std::size_t j = i;
    for (;;) {
      j = (j + 1) & mask_;
      if (slots_[j].first == 0) {
        break;
      }
      const std::size_t h = home(slots_[j].first);
      const bool stays = i <= j ? (i < h && h <= j) : (i < h || h <= j);
      if (!stays) {
        slots_[i] = std::move(slots_[j]);
        i = j;
      }
    }
    slots_[i].first = 0;
    slots_[i].second = V();
    --size_;
    return 1;
  }
  void erase(iterator it) {
    if (it != nullptr) {
      erase(it->first);
    }
  }

  void clear() {
    slots_.clear();
    mask_ = 0;
    shift_ = 64;
    size_ = 0;
    has_zero_ = false;
    zero_.second = V();
  }

 private:
  std::size_t home(std::uint64_t key) const {
    return static_cast<std::size_t>((key * 0x9E3779B97F4A7C15ull) >> shift_);
  }
  void grow() {
    const std::size_t capacity = slots_.empty() ? 64 : slots_.size() * 2;
    std::vector<value_type> old;
    old.swap(slots_);
    slots_.assign(capacity, value_type(0, V()));
    mask_ = capacity - 1;
    unsigned bits = 0;
    while ((std::size_t{1} << bits) < capacity) {
      ++bits;
    }
    shift_ = 64 - bits;
    for (value_type &slot : old) {
      if (slot.first == 0) {
        continue;
      }
      std::size_t i = home(slot.first);
      while (slots_[i].first != 0) {
        i = (i + 1) & mask_;
      }
      slots_[i] = std::move(slot);
    }
  }

  std::vector<value_type> slots_;  // key 0 marks an empty slot
  std::size_t mask_ = 0;
  unsigned shift_ = 64;
  std::size_t size_ = 0;  // occupied slots (the zero key aside)
  bool has_zero_ = false;
  value_type zero_{0, V()};
};

}  // namespace grc::rs
