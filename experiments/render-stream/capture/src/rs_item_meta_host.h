// The main thread's
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

#include "rs_adopt.h"
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
  std::uint64_t reentry_queued = 0;
  std::uint64_t reentry_same = 0;
  std::uint64_t reentry_rows = 0;
  std::uint64_t reentry_max_batch = 0;
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
  // the mouse_filter watch, sweep and re-stamps.
  bool v2_ever = false;            // mouse_filter was asked at some point
  std::uint64_t watches = 0;       // property_list_changed connections made
  std::uint64_t watch_ns = 0;      // in filter_watch (the connects)
  std::uint64_t watched_max = 0;   // the most Controls watched at once
  std::uint64_t changed = 0;       // queued RIDs drained (one per Control per frame)
  std::uint64_t changed_ns = 0;
  std::uint64_t sweep_frames = 0;  // passes that swept
  std::uint64_t sweep_reads = 0;
  std::uint64_t sweep_ns = 0;
  std::uint64_t sweep_max_ns = 0;
  std::vector<std::uint32_t> sweep_frame_ns;  // per sweeping pass (the first 65536), for p50/p95
  std::uint64_t restamps = 0;           // rows re-stamped (a changed filter)
  std::uint64_t restamps_signal = 0;    // ... found through property_list_changed
  std::uint64_t restamps_sweep = 0;     // ... found by the sweep
  std::uint64_t restamp_skipped = 0;    // sabotage restamp-skip: changes found, not re-stamped
  std::uint64_t gone = 0;               // watched Controls found freed
  std::uint64_t unwatched = 0;          // connections undone when the union dropped
  std::uint64_t unwatch_calls = 0;
  std::uint64_t unwatch_ns = 0;
  std::uint64_t watched_after_off = 0;  // watches left once off (0 unless something leaked)
};

class Host {
 public:
  void configure(std::uint64_t budget_us, bool before_ready) {
    budget_ns_ = budget_us * 1000;
    before_ready_ = before_ready;
  }
  // ID3: GRC_ITEM_META_SWEEP (Controls re-read a frame; 0: no sweep) and the v2 sabotages.
  struct V2Options {
    std::uint64_t sweep = 64;
    bool restamp_skip = false;      // a queued change is drained but never re-stamped
    bool raw_filter = false;        // get_mouse_filter instead of ..._with_override
    bool instance_of_root = false;  // the instance root's ObjectID
    bool leak_connections = false;  // no disconnect when the union drops
  };
  void configure_v2(const V2Options &options) { v2_options_ = options; }
  // The union of what the granted viewers ask (empty: off). Turning on acquires the node map and
  // resolves every live item again; a grown union does too, so every entry answers it.
  void set_union(const Request &want, std::uint64_t frame);
  bool on() const { return on_; }
  // ID3 (ID-D9): undoes the mouse_filter watch (every connection, the queue, the sweep) and keeps
  // the rest of the union; set_union(empty) does it too. Idempotent.
  void v2_off() {
    if (v2_filter_ || !watched_.empty() || filter_watch_count() != 0) {
      filter_off();
    }
  }
  // GRC_ITEM_META_LOG (a test knob): one JSON line per entry made, {"id","rid","stamp","node",
  // "copy"} -- the capture's own RID-to-id map, which the meta-oracle check joins the fixture's
  // RID-keyed dump through. Flushed at each pass that made entries.
  void set_log(std::FILE *log) { log_ = log; }
  // LS3: at a disarm, after set_union(empty): back to a host that never served, keeping only the
  // per-load configuration (budget, before_ready, the v2 options and the log). The interned
  // strings, groups, meta names, ids and stats go: the next arm's hub starts empty, so its
  // viewers must be sent every string again.
  void release() {
    set_union(Request(), 0);
    Host fresh;
    fresh.budget_ns_ = budget_ns_;
    fresh.before_ready_ = before_ready_;
    fresh.v2_options_ = v2_options_;
    fresh.log_ = log_;
    *this = std::move(fresh);
  }
  // LS3: what the host still holds (the disarm's accounting): watched Controls, queued changes,
  // pending work and per-RID entries.
  std::size_t held() const {
    return watched_.size() + changed_.size() + work_.size() + by_rid_.size();
  }
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
    bool reentry = false;
  };
  std::int32_t intern(const std::string &raw, Batch *batch);
  // ID3: the watched Controls, in sweep order (swap-removed when freed), indexed by RID.
  struct Watched {
    std::uint64_t rid;
    std::uint64_t instance_id;
    bool has_point;
  };
  void watch(std::uint64_t rid, std::uint64_t instance_id, std::int32_t filter);
  void unwatch_slot(std::size_t slot);
  void filter_pass(const Mirror &mirror, std::uint64_t frame, Batch *batch);
  bool restamp(const Mirror &mirror, std::uint64_t rid, std::int32_t value, std::uint64_t frame,
               Batch *batch);
  void filter_off();

  bool on_ = false;
  bool before_ready_ = false;
  std::uint64_t budget_ns_ = 2000000;
  Request union_;
  std::uint32_t watermark_ = 0;
  std::deque<Work> work_;
  std::unordered_set<std::uint64_t> entered_;
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
  V2Options v2_options_;
  bool v2_filter_ = false;  // the union has mouse_filter: watch, sweep and re-stamp
  std::vector<Watched> watched_;
  std::unordered_map<std::uint64_t, std::size_t> watched_slot_;  // RID -> watched_ index
  std::size_t cursor_ = 0;
  std::vector<std::uint64_t> changed_;
};

}  // namespace item_meta
}  // namespace rs
}  // namespace grc

#endif  // GRC_RS_ITEM_META_HOST_H
