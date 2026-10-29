// HC4b (host-cost-design.md D1 "Shape", "The diff, record planning, serving and budget"): a
// persistent, copy-on-write map from a string key to a value, kept sorted by key (byte order), as
// `std::map<std::string, V>` iterates.
//
// Entries live in chunks of at most kMaxChunk, each chunk an immutable, shared, sorted array of
// `shared_ptr<const value_type>`; a map is one shared root holding the sorted chunk pointers.
// Copying a map is one refcount bump. A write copies the root (when another map holds it) and the
// one chunk it touches (likewise), so a map and its copy share every chunk the write did not touch.
// A chunk that grows past kMaxChunk splits in two; a chunk that empties is dropped.
//
// It keeps the read interface of `std::map` the capture used (`find`, `count`, `at`, `begin`/`end`
// yielding entries with `first` and `second`, `size`, `empty`), so readers compile unchanged.
// `same()` is true when two maps hold the very same root (then they are equal without a
// comparison), and diff_shared_maps() walks two maps over their differing chunks only.
//
// Engine-free, header-only. Not thread-safe for writes; a published (copied) map is immutable.
#ifndef GRC_RS_SHARED_MAP_H
#define GRC_RS_SHARED_MAP_H

#include <algorithm>
#include <cstddef>
#include <cstdint>
#include <initializer_list>
#include <iterator>
#include <memory>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

namespace grc {
namespace rs {

// The weight a value adds to its map's weight() (the payload bytes, for a payload map). Zero
// unless specialized for the value type (before the map type is first used).
template <typename V>
struct SharedMapWeight {
  static std::uint64_t of(const V &) { return 0; }
};

template <typename V>
class SharedStrMap {
 public:
  struct value_type {
    std::string first;
    V second;
  };
  using EntryPtr = std::shared_ptr<const value_type>;
  static constexpr std::size_t kMaxChunk = 128;  // split into two halves beyond this
  struct Chunk {
    std::vector<EntryPtr> entries;  // ascending by key, never empty in a map
  };
  using ChunkPtr = std::shared_ptr<Chunk>;  // shared: never written while another root holds it
  struct Root {
    std::vector<ChunkPtr> chunks;  // ascending by their first key
    std::size_t size = 0;
    std::uint64_t weight = 0;
  };

  class const_iterator {
   public:
    using iterator_category = std::forward_iterator_tag;
    using value_type = typename SharedStrMap::value_type;
    using difference_type = std::ptrdiff_t;
    using pointer = const value_type *;
    using reference = const value_type &;
    const_iterator() = default;
    const_iterator(const Root *root, std::size_t c, std::size_t e) : root_(root), c_(c), e_(e) {}
    const value_type &operator*() const { return *root_->chunks[c_]->entries[e_]; }
    const value_type *operator->() const { return root_->chunks[c_]->entries[e_].get(); }
    const EntryPtr &ptr() const { return root_->chunks[c_]->entries[e_]; }
    const_iterator &operator++() {
      if (++e_ == root_->chunks[c_]->entries.size()) {
        ++c_;
        e_ = 0;
      }
      return *this;
    }
    const_iterator operator++(int) {
      const_iterator old = *this;
      ++*this;
      return old;
    }
    bool operator==(const const_iterator &o) const { return c_ == o.c_ && e_ == o.e_; }
    bool operator!=(const const_iterator &o) const { return !(*this == o); }

   private:
    const Root *root_ = nullptr;
    std::size_t c_ = 0;
    std::size_t e_ = 0;
  };
  using iterator = const_iterator;

  // A proxy for `map[key] = value` (tests): set() on assignment.
  class Slot {
   public:
    Slot(SharedStrMap *map, std::string key) : map_(map), key_(std::move(key)) {}
    Slot &operator=(V value) {
      map_->set(key_, std::move(value));
      return *this;
    }

   private:
    SharedStrMap *map_;
    std::string key_;
  };

  SharedStrMap() = default;
  SharedStrMap(std::initializer_list<std::pair<std::string, V>> values) {
    for (const auto &value : values) {
      set(value.first, value.second);
    }
  }

  std::size_t size() const { return root_ != nullptr ? root_->size : 0; }
  bool empty() const { return size() == 0; }
  // The sum of SharedMapWeight<V>::of() over every entry.
  std::uint64_t weight() const { return root_ != nullptr ? root_->weight : 0; }
  const_iterator begin() const { return const_iterator(root_.get(), 0, 0); }
  const_iterator end() const {
    return const_iterator(root_.get(), root_ != nullptr ? root_->chunks.size() : 0, 0);
  }
  const_iterator find(const std::string &key) const {
    std::size_t c = 0;
    std::size_t e = 0;
    return locate(key, &c, &e) ? const_iterator(root_.get(), c, e) : end();
  }
  const value_type *find_entry(const std::string &key) const {
    std::size_t c = 0;
    std::size_t e = 0;
    return locate(key, &c, &e) ? root_->chunks[c]->entries[e].get() : nullptr;
  }
  std::size_t count(const std::string &key) const { return find_entry(key) != nullptr ? 1 : 0; }
  const V &at(const std::string &key) const {
    const value_type *entry = find_entry(key);
    if (entry == nullptr) {
      throw std::out_of_range("SharedStrMap::at: no key " + key);
    }
    return entry->second;
  }
  // True when both hold the very same root (then they are equal without a comparison).
  bool same(const SharedStrMap &other) const { return root_ == other.root_; }
  const Root *root() const { return root_.get(); }

  // Writers: copy-on-write of the root and of the one chunk touched.
  std::pair<const_iterator, bool> emplace(const std::string &key, V value) {
    std::size_t c = 0;
    std::size_t e = 0;
    if (locate(key, &c, &e)) {
      return {const_iterator(root_.get(), c, e), false};
    }
    put(key, std::move(value), false);
    return {find(key), true};
  }
  template <typename It>
  void insert(It first, It last) {
    for (; first != last; ++first) {
      emplace(first->first, first->second);
    }
  }
  // Inserts or overwrites.
  void set(const std::string &key, V value) { put(key, std::move(value), true); }
  Slot operator[](const std::string &key) { return Slot(this, key); }
  bool erase(const std::string &key) {
    std::size_t c = 0;
    std::size_t e = 0;
    if (!locate(key, &c, &e)) {
      return false;
    }
    Root &root = own_root();
    const std::uint64_t w = SharedMapWeight<V>::of(root.chunks[c]->entries[e]->second);
    if (root.chunks[c]->entries.size() == 1) {
      root.chunks.erase(root.chunks.begin() + static_cast<std::ptrdiff_t>(c));
    } else {
      std::vector<EntryPtr> &entries = own_chunk(&root, c);
      entries.erase(entries.begin() + static_cast<std::ptrdiff_t>(e));
    }
    --root.size;
    root.weight -= std::min(root.weight, w);
    return true;
  }
  void clear() { root_.reset(); }

 private:
  // The chunk that holds (or would hold) `key`: the last chunk whose first key <= key, or 0.
  std::size_t chunk_for(const std::string &key) const {
    const std::vector<ChunkPtr> &chunks = root_->chunks;
    const auto it = std::upper_bound(
        chunks.begin(), chunks.end(), key,
        [](const std::string &k, const ChunkPtr &chunk) { return k < chunk->entries.front()->first; });
    return it == chunks.begin() ? 0 : static_cast<std::size_t>(it - chunks.begin()) - 1;
  }
  bool locate(const std::string &key, std::size_t *c, std::size_t *e) const {
    if (root_ == nullptr || root_->chunks.empty()) {
      return false;
    }
    *c = chunk_for(key);
    const std::vector<EntryPtr> &entries = root_->chunks[*c]->entries;
    const auto it = std::lower_bound(
        entries.begin(), entries.end(), key,
        [](const EntryPtr &p, const std::string &k) { return p->first < k; });
    if (it == entries.end() || (*it)->first != key) {
      return false;
    }
    *e = static_cast<std::size_t>(it - entries.begin());
    return true;
  }
  Root &own_root() {
    if (root_ == nullptr) {
      root_ = std::make_shared<Root>();
    } else if (root_.use_count() > 1) {
      root_ = std::make_shared<Root>(*root_);
    }
    return *root_;
  }
  static std::vector<EntryPtr> &own_chunk(Root *root, std::size_t c) {
    ChunkPtr &chunk = root->chunks[c];
    if (chunk.use_count() > 1) {
      chunk = std::make_shared<Chunk>(*chunk);
    }
    return chunk->entries;
  }
  void put(const std::string &key, V value, bool overwrite) {
    Root &root = own_root();
    auto entry = std::make_shared<const value_type>(value_type{key, std::move(value)});
    const std::uint64_t w = SharedMapWeight<V>::of(entry->second);
    if (root.chunks.empty()) {
      auto chunk = std::make_shared<Chunk>();
      chunk->entries.push_back(std::move(entry));
      root.chunks.push_back(std::move(chunk));
      root.size = 1;
      root.weight = w;
      return;
    }
    const std::size_t c = chunk_for(key);
    const std::vector<EntryPtr> &held = root.chunks[c]->entries;
    const auto found = std::lower_bound(
        held.begin(), held.end(), key,
        [](const EntryPtr &p, const std::string &k) { return p->first < k; });
    const std::size_t at = static_cast<std::size_t>(found - held.begin());
    if (found != held.end() && (*found)->first == key) {
      if (!overwrite) {
        return;
      }
      const std::uint64_t old = SharedMapWeight<V>::of((*found)->second);
      std::vector<EntryPtr> &entries = own_chunk(&root, c);
      entries[at] = std::move(entry);
      root.weight = root.weight - std::min(root.weight, old) + w;
      return;
    }
    std::vector<EntryPtr> &entries = own_chunk(&root, c);
    entries.insert(entries.begin() + static_cast<std::ptrdiff_t>(at), std::move(entry));
    ++root.size;
    root.weight += w;
    if (entries.size() > kMaxChunk) {
      auto upper = std::make_shared<Chunk>();
      const std::size_t half = entries.size() / 2;
      upper->entries.assign(entries.begin() + static_cast<std::ptrdiff_t>(half), entries.end());
      entries.resize(half);
      root.chunks.insert(root.chunks.begin() + static_cast<std::ptrdiff_t>(c) + 1, std::move(upper));
    }
  }

  std::shared_ptr<Root> root_;  // null: empty
};

// Walks `a` and `b` in key order over their differing chunks: `only_a(entry)` for every key `a`
// holds and `b` does not, `only_b(entry)` for every key `b` holds and `a` does not, and
// `both(entry_a, entry_b)` for a key both hold in different entries. A chunk both maps hold is
// skipped whole, and two maps that share their root are not walked at all.
template <typename V, typename OnlyA, typename OnlyB, typename Both>
void diff_shared_maps(const SharedStrMap<V> &a, const SharedStrMap<V> &b, OnlyA only_a,
                      OnlyB only_b, Both both) {
  using Map = SharedStrMap<V>;
  const typename Map::Root *ra = a.root();
  const typename Map::Root *rb = b.root();
  if (ra == rb) {
    return;
  }
  const std::size_t na = ra != nullptr ? ra->chunks.size() : 0;
  const std::size_t nb = rb != nullptr ? rb->chunks.size() : 0;
  std::size_t ca = 0;
  std::size_t ea = 0;
  std::size_t cb = 0;
  std::size_t eb = 0;
  const auto step = [](const typename Map::Root *r, std::size_t *c, std::size_t *e) {
    if (++*e == r->chunks[*c]->entries.size()) {
      ++*c;
      *e = 0;
    }
  };
  while (ca < na || cb < nb) {
    if (ca < na && cb < nb && ea == 0 && eb == 0 && ra->chunks[ca] == rb->chunks[cb]) {
      ++ca;
      ++cb;
      continue;
    }
    const typename Map::EntryPtr *x = ca < na ? &ra->chunks[ca]->entries[ea] : nullptr;
    const typename Map::EntryPtr *y = cb < nb ? &rb->chunks[cb]->entries[eb] : nullptr;
    if (y == nullptr || (x != nullptr && (*x)->first < (*y)->first)) {
      only_a(**x);
      step(ra, &ca, &ea);
    } else if (x == nullptr || (*y)->first < (*x)->first) {
      only_b(**y);
      step(rb, &cb, &eb);
    } else {
      if (*x != *y) {
        both(**x, **y);
      }
      step(ra, &ca, &ea);
      step(rb, &cb, &eb);
    }
  }
}

}  // namespace rs
}  // namespace grc

#endif  // GRC_RS_SHARED_MAP_H
