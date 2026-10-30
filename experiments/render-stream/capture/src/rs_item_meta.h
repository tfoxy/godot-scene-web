// TAG1 (protocol/client-extensions-design.md §2, "As built (TAG1)"): the opt-in item identity
// layer's pure half. No engine calls, no I/O, no global state: the hello key's request and the
// operator's grant, the formation-side store of resolved identities, and the `item_meta` record
// (render-stream/13 only) formed from it for one grant.
//
// The main thread resolves identities (rs_adopt.cpp item_identity, entry.cpp's pass) into host
// tables: interned strings, group names and meta-key names, and one Entry per item, stamped with
// the frame of the snapshot it was resolved after. It hands each frame's additions over as a
// Batch; whatever forms records (the live hub's encode thread, a file publisher's writer) applies
// the batches to its own Store, in order, and never touches ObjectDB.
#ifndef GRC_RS_ITEM_META_H
#define GRC_RS_ITEM_META_H

#include <algorithm>
#include <cstdint>
#include <map>
#include <memory>
#include <string>
#include <unordered_map>
#include <vector>

#include "rs2_snapshot.h"

namespace grc {
namespace rs {
namespace item_meta {

// GRC_ITEM_META's names (§2.1), as bits.
constexpr std::uint32_t kClass = 1;
constexpr std::uint32_t kScript = 2;
constexpr std::uint32_t kScene = 4;
constexpr std::uint32_t kPath = 8;
constexpr std::uint32_t kGroups = 16;
constexpr std::uint32_t kMeta = 32;
constexpr int kFieldCount = 4;  // class, script, scene, path: the row's field columns, in order
extern const char *const kFieldNames[kFieldCount];

constexpr std::size_t kMaxGroups = 31;
constexpr std::size_t kMaxMetaKeys = 8;
constexpr std::uint64_t kPendingFrames = 120;  // §2.2: unresolved this long -> `node: null`

// A hello's `item_meta` (and a grant: the same shape). `fields` in class, script, scene, path
// order.
struct Request {
  std::vector<std::string> fields;
  std::vector<std::string> groups;
  std::vector<std::string> meta_keys;
  bool operator==(const Request &o) const {
    return fields == o.fields && groups == o.groups && meta_keys == o.meta_keys;
  }
  bool empty() const { return fields.empty() && groups.empty() && meta_keys.empty(); }
  std::uint32_t field_bits() const;
};

// GRC_ITEM_META: a comma list over class, script, scene, path, groups, meta (empty: no grant).
// False (with `error`) on an unknown or repeated name.
bool parse_grant_env(const std::string &text, std::uint32_t *bits, std::string *error);
std::string grant_env_string(std::uint32_t bits);
// §2.1's hello rules: "" when valid, else what is wrong (the hello error's detail).
std::string request_problem(const Request &request);
// The intersection with the operator's grant: the fields both name; the groups and meta keys
// whole, when the grant has `groups` / `meta`. An empty result is a refusal (no records).
Request grant_for(std::uint32_t host_bits, const Request &request);
// The grant's canonical JSON object ({"fields":[...],"groups":[...],"meta_keys":[...]}): the
// record's `grant` and the formation tables' key.
std::string grant_json(const Request &grant);

// What the host resolved for one item. Strings and names are host-table indices; -1 is null.
struct Entry {
  std::uint32_t id = 0;
  std::uint64_t stamp = 0;  // the frame of the snapshot it was resolved after
  bool node = false;        // false: no node (TileMapLayer quadrants, viewport internals, ...)
  std::int32_t field[kFieldCount] = {-1, -1, -1, -1};
  std::vector<std::uint32_t> groups;  // host group-name indices the node is in, ascending
  std::vector<std::int32_t> meta;     // per host meta-key index: the value's string, or -1
};

// One frame's additions to the host tables, in resolution order.
struct Batch {
  std::uint64_t strings_from = 0;
  std::vector<std::string> strings;
  std::uint64_t groups_from = 0;
  std::vector<std::string> group_names;
  std::uint64_t meta_from = 0;
  std::vector<std::string> meta_names;
  std::vector<Entry> entries;
};

// The formation side's copy of the host tables.
class Store {
 public:
  void apply(const Batch &batch);
  const Entry *find(std::uint32_t id) const {
    const auto it = entries_.find(id);
    return it != entries_.end() ? &it->second : nullptr;
  }
  const std::vector<std::string> &strings() const { return strings_; }
  const std::vector<std::string> &group_names() const { return group_names_; }
  const std::vector<std::string> &meta_names() const { return meta_names_; }
  // Entries stamped in (from, to], in stamp order (each id once, at its current stamp).
  template <typename F>
  void each_stamped(std::uint64_t from, std::uint64_t to, F f) const {
    auto it = std::upper_bound(order_.begin(), order_.end(),
                               std::make_pair(from, ~std::uint32_t{0}));
    for (; it != order_.end() && it->first <= to; ++it) {
      const Entry *e = find(it->second);
      if (e != nullptr && e->stamp == it->first) {
        f(*e);
      }
    }
  }
  // Drops the entries of items `alive` no longer has, once the table has doubled since the last
  // prune (ids never come back, so a dropped row is never wanted again).
  void prune(const rs2::Snapshot &alive);
  std::size_t size() const { return entries_.size(); }

 private:
  std::vector<std::string> strings_;
  std::vector<std::string> group_names_;
  std::vector<std::string> meta_names_;
  std::unordered_map<std::uint32_t, Entry> entries_;
  std::vector<std::pair<std::uint64_t, std::uint32_t>> order_;  // (stamp, id), stamps ascending
  std::size_t prune_at_ = 4096;
};

// One grant's wire string table (§2.4 "Strings": one table per session; each connection of a
// grant uses this table's indices, so lockstep viewers of one grant form the same bytes, and a
// grant never receives a string only another grant's columns name).
struct GrantTable {
  Request grant;
  std::string json;                       // grant_json(grant)
  std::vector<std::uint32_t> local;       // grant index -> host string index
  std::unordered_map<std::uint32_t, std::uint32_t> of_host;  // host string index -> grant index
};

// The record bytes for one connection: `full` (every item of `target` with an entry stamped at
// most `to`; strings_from 0) or `delta` (the target's items stamped in (from, to]; strings_from
// `strings_have`, the connection's table length). False for a delta with no rows: nothing is
// sent, and the connection's table does not move. `strings_after` is the connection's table
// length after the record, `rows` the rows written.
struct Formed {
  std::shared_ptr<const std::vector<std::uint8_t>> bytes;
  std::uint64_t strings_after = 0;
  std::uint64_t rows = 0;
};
bool form(const Store &store, GrantTable *table, bool full, std::uint64_t from, std::uint64_t to,
          std::uint64_t strings_have, const rs2::Snapshot &target, std::uint32_t id_offset,
          Formed *out);

}  // namespace item_meta
}  // namespace rs
}  // namespace grc

#endif  // GRC_RS_ITEM_META_H
