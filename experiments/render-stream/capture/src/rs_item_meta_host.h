// TAG1 (protocol/client-extensions-design.md §2.2, §2.5, "As built (TAG1)"): the main thread's
// half of item identity. While a viewer asked (the union of the granted requests is non-empty)
// it holds the node map (rs_adopt.h node_map_acquire_tag) and, after each snapshot, resolves the
// items created since its watermark, within GRC_ITEM_META_BUDGET_US, into the host tables. Each
// pass's additions leave as one item_meta::Batch for the formation side. Off, it costs the frame
// callback one branch (entry.cpp) and nothing per item.
#ifndef GRC_RS_ITEM_META_HOST_H
#define GRC_RS_ITEM_META_HOST_H

#include <cstdint>
#include <cstdio>
#include <deque>
#include <memory>
#include <string>
#include <unordered_map>
#include <vector>

#include "rs_item_meta.h"

namespace grc {
namespace rs {

class Mirror;

namespace item_meta {

struct HostStats {
  bool ever_on = false;
  std::uint64_t turned_on = 0;
  std::uint64_t union_resets = 0;   // the union grew: every live item re-resolved
  std::uint64_t passes = 0;         // passes that had work
  std::uint64_t resolved = 0;       // entries made (node or not)
  std::uint64_t no_node = 0;        // of which `node: null` (120 frames without a node)
  std::uint64_t rekey_copies = 0;
  std::uint64_t unpublished_waits = 0;
  std::uint64_t node_waits = 0;
  std::uint64_t budget_stops = 0;
  std::uint64_t pending_max = 0;
  std::uint64_t resolve_ns = 0;     // in item_identity (the engine reads)
  std::uint64_t pass_ns = 0;        // whole passes
  std::uint64_t max_pass_ns = 0;
  std::uint64_t max_pass_items = 0;
  std::uint64_t strings = 0;
  struct Burst {
    std::uint64_t frame, items, ns;
  };
  std::vector<Burst> bursts;  // passes resolving >= 16 entries (the first 256)
};

class Host {
 public:
  void configure(std::uint64_t budget_us, bool before_ready) {
    budget_ns_ = budget_us * 1000;
    before_ready_ = before_ready;
  }
  // The union of what the granted viewers ask (empty: off). Turning on acquires the node map and
  // resolves every live item again; a grown union does too, so every entry answers it.
  void set_union(const Request &want, std::uint64_t frame);
  bool on() const { return on_; }
  // GRC_ITEM_META_LOG (a test knob): one JSON line per entry made, {"id","rid","stamp","node",
  // "copy"} -- the capture's own RID-to-id map, which the meta-oracle check joins the fixture's
  // RID-keyed dump through. Flushed at each pass that made entries.
  void set_log(std::FILE *log) { log_ = log; }
  // After the frame's snapshot: the new items' identities, within the budget. Null when the pass
  // added nothing.
  std::shared_ptr<const Batch> pass(const Mirror &mirror, std::uint64_t frame);
  const HostStats &stats() const { return stats_; }
  std::string stats_json() const;

 private:
  struct Work {
    std::uint32_t id;
    std::uint64_t first_frame;
    std::uint64_t next_frame;  // a node wait backs off: retried at +1, +2, +4, ... frames
  };
  std::int32_t intern(const std::string &raw, Batch *batch);

  bool on_ = false;
  bool before_ready_ = false;
  std::uint64_t budget_ns_ = 2000000;
  Request union_;
  std::uint32_t watermark_ = 0;
  std::deque<Work> work_;
  std::vector<std::string> strings_;
  std::unordered_map<std::string, std::int32_t> string_index_;
  std::vector<std::string> group_names_;
  std::vector<std::string> meta_names_;
  std::uint64_t groups_sent_ = 0;
  std::uint64_t meta_sent_ = 0;
  std::unordered_map<std::uint64_t, Entry> by_rid_;  // the last entry per RID (rekey copies)
  std::size_t by_rid_prune_at_ = 4096;
  HostStats stats_;
  std::FILE *log_ = nullptr;
};

}  // namespace item_meta
}  // namespace rs
}  // namespace grc

#endif  // GRC_RS_ITEM_META_HOST_H
