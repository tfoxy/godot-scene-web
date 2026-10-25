// P3-SP (results/p3/p3-sp.md): every live connection's carried-hash set (rs_live.h, G2b2), held
// once for the whole host instead of once per connection.
//
// render-stream-2.md's resource rules make each set exact and lifelong: a connection carries a
// hash at most once (resource-duplicate), and every hash at or under inline_max_bytes must have
// been carried before a transaction names it (resource-missing). So nothing here may forget a hash
// a connection still streams with, and nothing may report a hash carried that was not (G6s,
// gate6-design.md: pruning to the base broke the first soak-inline run). What this changes is the
// cost of holding them, not what they hold:
//   - one entry per distinct hash for the whole host, not one std::string node per connection:
//     the hash's first 128 bits (an SHA-256 prefix; any other string goes to an exact side map)
//     and a bit per connection slot: 20 bytes, about 40 with the index and the vectors' slack, for
//     every connection together, against ~150 per connection before;
//   - a connection is a slot (a bit), so asking "carried on c?" is one probe and one AND, and the
//     lookup is shared by every connection sending the same snapshot (ids are stable);
//   - a closed connection's slot is retired; its bits are cleared before the slot is reused, and
//     the table is emptied (maintain(), between frames) once no connection holds a slot, so the
//     memory comes back when the viewers leave.
// Not thread-safe: the hub's thread only.

#ifndef GRC_RS_CARRIED_H
#define GRC_RS_CARRIED_H

#include <cstddef>
#include <cstdint>
#include <string>
#include <unordered_map>
#include <vector>

namespace grc {
namespace rs2 {

class CarriedIndex {
 public:
  static constexpr unsigned kSlots = 32;
  static constexpr unsigned kNoSlot = kSlots;
  static constexpr std::uint32_t kNoId = 0xffffffffu;

  // A free slot (bit) for a new connection, clearing retired slots' bits first when every slot
  // has been used; kNoSlot only if kSlots connections hold one at once.
  unsigned acquire() {
    if ((used_ | retired_) == kAll) {
      clear_retired();
    }
    for (unsigned s = 0; s < kSlots; ++s) {
      const std::uint32_t bit = 1u << s;
      if (((used_ | retired_) & bit) == 0) {
        used_ |= bit;
        return s;
      }
    }
    return kNoSlot;
  }

  // The connection holding `slot` closed. Its bits stay set until the slot is reused (lazy).
  void release(unsigned slot) {
    if (slot >= kSlots) {
      return;
    }
    const std::uint32_t bit = 1u << slot;
    used_ &= ~bit;
    retired_ |= bit;
  }

  // Between frames (no id is held across this call): once no slot is held, every entry goes.
  void maintain() {
    if (used_ == 0 && !keys_.empty()) {
      clear();
    }
  }

  // The stable id of `hash`, interned (carried on no slot) when it was not yet.
  std::uint32_t intern(const std::string &hash) {
    Key key;
    if (!parse(hash, &key)) {
      const auto it = odd_.find(hash);
      if (it != odd_.end()) {
        return it->second;
      }
      const std::uint32_t id = push(Key{0, 0});
      odd_.emplace(hash, id);
      return id;
    }
    if ((keys_.size() + 1) * 2 > index_.size()) {
      grow();
    }
    const std::size_t mask = index_.size() - 1;
    for (std::size_t i = static_cast<std::size_t>(key.a) & mask;; i = (i + 1) & mask) {
      const std::uint32_t slot = index_[i];
      if (slot == 0) {
        const std::uint32_t id = push(key);
        index_[i] = id + 1;
        return id;
      }
      const Key &k = keys_[slot - 1];
      if (k.a == key.a && k.b == key.b) {
        return slot - 1;
      }
    }
  }

  bool carried(std::uint32_t id, unsigned slot) const {
    return slot < kSlots && id < masks_.size() && (masks_[id] & (1u << slot)) != 0;
  }
  void mark(std::uint32_t id, unsigned slot) {
    if (slot < kSlots && id < masks_.size()) {
      masks_[id] |= 1u << slot;
    }
  }

  std::size_t entries() const { return keys_.size(); }
  // What the table holds, in bytes (entries, masks, index, side map), for the live summary.
  std::uint64_t bytes() const {
    return keys_.capacity() * sizeof(Key) + masks_.capacity() * sizeof(std::uint32_t) +
           index_.capacity() * sizeof(std::uint32_t) + odd_.size() * 96;
  }

  void clear() {
    keys_.clear();
    keys_.shrink_to_fit();
    masks_.clear();
    masks_.shrink_to_fit();
    index_.clear();
    index_.shrink_to_fit();
    odd_.clear();
    retired_ = 0;
  }

 private:
  static constexpr std::uint32_t kAll = 0xffffffffu;
  struct Key {
    std::uint64_t a = 0;
    std::uint64_t b = 0;
  };

  static int hex(char c) {
    if (c >= '0' && c <= '9') {
      return c - '0';
    }
    if (c >= 'a' && c <= 'f') {
      return c - 'a' + 10;
    }
    return -1;
  }
  // A 64-character lowercase hex SHA-256: its first 128 bits.
  static bool parse(const std::string &hash, Key *out) {
    if (hash.size() != 64) {
      return false;
    }
    std::uint64_t words[2] = {0, 0};
    for (std::size_t i = 0; i < 64; ++i) {
      const int v = hex(hash[i]);
      if (v < 0) {
        return false;
      }
      if (i < 32) {
        words[i / 16] = (words[i / 16] << 4) | static_cast<std::uint64_t>(v);
      }
    }
    // The first word indexes the table: mix it, so test hashes such as "1111..." spread too.
    std::uint64_t a = words[0];
    a ^= a >> 33;
    a *= 0xff51afd7ed558ccdULL;
    a ^= a >> 33;
    out->a = a;
    out->b = words[1];
    return true;
  }

  std::uint32_t push(const Key &key) {
    keys_.push_back(key);
    masks_.push_back(0);
    return static_cast<std::uint32_t>(keys_.size() - 1);
  }

  void grow() {
    std::vector<std::uint32_t> next(index_.empty() ? 1024 : index_.size() * 2, 0);
    const std::size_t mask = next.size() - 1;
    for (const std::uint32_t slot : index_) {
      if (slot == 0) {
        continue;
      }
      std::size_t i = static_cast<std::size_t>(keys_[slot - 1].a) & mask;
      while (next[i] != 0) {
        i = (i + 1) & mask;
      }
      next[i] = slot;
    }
    index_.swap(next);
  }

  void clear_retired() {
    const std::uint32_t keep = ~retired_;
    for (std::uint32_t &m : masks_) {
      m &= keep;
    }
    retired_ = 0;
  }

  std::vector<Key> keys_;
  std::vector<std::uint32_t> masks_;  // by id: bit s set = carried on slot s
  std::vector<std::uint32_t> index_;  // open addressing: id + 1, 0 empty
  std::unordered_map<std::string, std::uint32_t> odd_;  // any hash that is not 64 hex digits
  std::uint32_t used_ = 0;
  std::uint32_t retired_ = 0;
};

}  // namespace rs2
}  // namespace grc

#endif  // GRC_RS_CARRIED_H
