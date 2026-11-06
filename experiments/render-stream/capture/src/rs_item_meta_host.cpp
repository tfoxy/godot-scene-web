#include "rs_item_meta_host.h"

#include <algorithm>
#include <chrono>

#include "rs_adopt.h"
#include "rs_mirror.h"

namespace grc {
namespace rs {
namespace item_meta {

namespace {

std::uint64_t now_ns() {
  return static_cast<std::uint64_t>(std::chrono::duration_cast<std::chrono::nanoseconds>(
                                        std::chrono::steady_clock::now().time_since_epoch())
                                        .count());
}

// Every string the record carries is printable ASCII (render-stream-0.md); the host interns the
// canonical form, so two strings never share one wire spelling at two indices.
std::string canonical(const std::string &raw) {
  std::string out = raw;
  for (char &c : out) {
    const unsigned char u = static_cast<unsigned char>(c);
    if (u < 0x20 || u > 0x7E) {
      c = '?';
    }
  }
  return out;
}

void merge_names(std::vector<std::string> *into, const std::vector<std::string> &names,
                 bool *grew) {
  for (const std::string &n : names) {
    bool found = false;
    for (const std::string &have : *into) {
      found = found || have == n;
    }
    if (!found) {
      into->push_back(n);
      *grew = true;
    }
  }
}

}  // namespace

std::int32_t Host::intern(const std::string &raw, Batch *batch) {
  std::string text = canonical(raw);
  const auto found = string_index_.find(text);
  if (found != string_index_.end()) {
    return found->second;
  }
  const std::int32_t index = static_cast<std::int32_t>(strings_.size());
  if (batch->strings.empty()) {
    batch->strings_from = strings_.size();
  }
  batch->strings.push_back(text);
  string_index_.emplace(text, index);
  strings_.push_back(std::move(text));
  return index;
}

void Host::set_union(const Request &want, std::uint64_t frame) {
  (void)frame;
  if (want.empty()) {
    if (on_) {
      filter_off();  // ID3 (ID-D9): before the map goes; nothing of it survives the union
      node_map_release_tag();
      on_ = false;
      work_.clear();
      watermark_ = 0;
      by_rid_.clear();
    }
    union_ = Request();
    return;
  }
  // The union only grows while on (a viewer leaving keeps what the others ask resolved).
  bool grew = !on_;
  std::uint32_t fields = union_.field_bits() | want.field_bits();
  if (fields != union_.field_bits()) {
    grew = true;
  }
  Request next;
  for (int i = 0; i < kFieldCount; ++i) {
    if ((fields & field_bit(i)) != 0) {
      next.fields.push_back(kFieldNames[i]);
    }
  }
  next.groups = group_names_;
  merge_names(&next.groups, want.groups, &grew);
  next.meta_keys = meta_names_;
  merge_names(&next.meta_keys, want.meta_keys, &grew);
  if (!grew) {
    return;
  }
  if (!on_) {
    std::string error;
    if (!node_map_acquire_tag(&error)) {
      return;  // binds missing: stays off (every granted connection then gets empty rows)
    }
    on_ = true;
    stats_.ever_on = true;
    ++stats_.turned_on;
  } else {
    ++stats_.union_resets;
  }
  union_ = next;
  group_names_ = next.groups;  // only appends: host group indices stay stable
  meta_names_ = next.meta_keys;
  IdentityQuery query;
  query.fields = fields;
  query.instance_of_root = v2_options_.instance_of_root;
  query.raw_filter = v2_options_.raw_filter;
  // ID3: the watch starts with the union's mouse_filter. The union only grows while on, so it ends
  // only when the union drops to nothing (filter_off).
  v2_filter_ = (fields & kMouseFilter) != 0;
  stats_.v2_ever = stats_.v2_ever || v2_filter_;
  query.groups = group_names_;
  query.meta_keys = meta_names_;
  tag_set_query(query, before_ready_);
  // §2.6 "Late join": every live item is resolved again, budgeted like a burst.
  watermark_ = 0;
  work_.clear();
  by_rid_.clear();
}

std::shared_ptr<const Batch> Host::pass(const Mirror &mirror, std::uint64_t frame) {
  auto batch = std::make_shared<Batch>();
  batch->strings_from = strings_.size();
  if (group_names_.size() > groups_sent_) {
    batch->groups_from = groups_sent_;
    batch->group_names.assign(group_names_.begin() + static_cast<std::ptrdiff_t>(groups_sent_),
                              group_names_.end());
    groups_sent_ = group_names_.size();
  } else {
    batch->groups_from = groups_sent_;
  }
  if (meta_names_.size() > meta_sent_) {
    batch->meta_from = meta_sent_;
    batch->meta_names.assign(meta_names_.begin() + static_cast<std::ptrdiff_t>(meta_sent_),
                             meta_names_.end());
    meta_sent_ = meta_names_.size();
  } else {
    batch->meta_from = meta_sent_;
  }
  // 1. New ids: dense and never reused, so the ids above the watermark are the items created
  // since the last pass (and, after a rekey, the subtree's fresh ids).
  const std::uint32_t next = mirror.next_item_id();
  while (watermark_ + 1 < next) {
    ++watermark_;
    work_.push_back({watermark_, frame, frame});
  }
  if (v2_filter_) {
    filter_pass(mirror, frame, batch.get());  // ID3: re-stamps before the new items' rows
  }
  if (work_.empty() && batch->group_names.empty() && batch->meta_names.empty() &&
      batch->entries.empty()) {
    return nullptr;
  }
  const std::uint64_t t0 = now_ns();
  std::uint64_t items = 0;  // identity reads (the budget's unit of progress)
  std::uint64_t made = 0;   // entries made
  std::vector<Work> retry;
  while (!work_.empty()) {
    if (items > 0 && now_ns() - t0 >= budget_ns_) {
      ++stats_.budget_stops;  // 3. the rest waits for the next frame
      break;
    }
    Work w = work_.front();
    work_.pop_front();
    if (w.next_frame > frame) {
      retry.push_back(w);  // backing off a node wait
      continue;
    }
    std::uint64_t rid = 0;
    bool published = false;
    if (!mirror.item_info(w.id, &rid, &published)) {
      continue;  // freed (or re-keyed away) before it was resolved: no row is ever needed
    }
    if (!published) {
      ++stats_.unpublished_waits;  // withheld: its row waits for the snapshot that carries it
      retry.push_back(w);
      continue;
    }
    Entry entry;
    entry.id = w.id;
    entry.stamp = frame;
    const auto old = by_rid_.find(rid);
    if (old != by_rid_.end() && old->second.id != w.id) {
      // 4. A rekey (GRC_UNKNOWN_ITEM=skip) gave the item a fresh id: its row is copied.
      entry = old->second;
      entry.id = w.id;
      entry.stamp = frame;
      ++stats_.rekey_copies;
    } else {
      Identity identity;
      const std::uint64_t r0 = now_ns();
      const bool found = item_identity(rid, &identity);
      stats_.resolve_ns += now_ns() - r0;
      ++items;
      if (!found) {
        if (frame - w.first_frame < kPendingFrames) {
          // 2. not in the tree yet: retried, backing off (+1, +2, +4, ... frames), until 120
          // frames after its creation.
          ++stats_.node_waits;
          const std::uint64_t waited = frame - w.first_frame;
          w.next_frame = std::min(w.first_frame + kPendingFrames,
                                  frame + std::max<std::uint64_t>(1, waited));
          retry.push_back(w);
          continue;
        }
        ++stats_.no_node;  // §2.2: `node: null`
      } else {
        entry.node = true;
        for (int i = 0; i < kStringFields; ++i) {
          if (identity.has[i]) {
            entry.field[i] = intern(identity.field[i], batch.get());
          }
        }
        entry.instance_id = identity.instance_id;
        entry.mouse_filter = identity.mouse_filter;
        if (v2_filter_ && identity.mouse_filter >= 0) {
          watch(rid, identity.node_id, identity.mouse_filter);
        }
        for (std::size_t g = 0; g < identity.in_group.size(); ++g) {
          if (identity.in_group[g]) {
            entry.groups.push_back(static_cast<std::uint32_t>(g));
          }
        }
        entry.meta.assign(identity.meta.size(), -1);
        for (std::size_t k = 0; k < identity.meta.size(); ++k) {
          if (identity.meta[k].first) {
            entry.meta[k] = intern(identity.meta[k].second, batch.get());
          }
        }
      }
    }
    ++stats_.resolved;
    ++made;
    if (log_ != nullptr) {
      std::fprintf(log_, "{\"id\":%u,\"rid\":\"%llu\",\"stamp\":%llu,\"node\":%s,\"copy\":%s}\n",
                   static_cast<unsigned>(entry.id), static_cast<unsigned long long>(rid),
                   static_cast<unsigned long long>(frame), entry.node ? "true" : "false",
                   old != by_rid_.end() && old->second.id != w.id ? "true" : "false");
    }
    by_rid_[rid] = entry;
    batch->entries.push_back(std::move(entry));
  }
  for (auto it = retry.rbegin(); it != retry.rend(); ++it) {
    work_.push_front(*it);  // the retries first next frame, in id order
  }
  stats_.pending_max = std::max<std::uint64_t>(stats_.pending_max, work_.size());
  if (by_rid_.size() >= by_rid_prune_at_) {
    for (auto it = by_rid_.begin(); it != by_rid_.end();) {
      std::uint64_t rid = 0;
      bool published = false;
      it = mirror.item_info(it->second.id, &rid, &published) ? std::next(it) : by_rid_.erase(it);
    }
    by_rid_prune_at_ = std::max<std::size_t>(4096, by_rid_.size() * 2);
    tag_prune_map();
  }
  if (log_ != nullptr && made > 0) {
    std::fflush(log_);
  }
  const std::uint64_t ns = now_ns() - t0;
  if (!batch->entries.empty() || items > 0) {
    ++stats_.passes;
    stats_.pass_ns += ns;
    stats_.max_pass_ns = std::max(stats_.max_pass_ns, ns);
    stats_.max_pass_items = std::max<std::uint64_t>(stats_.max_pass_items, made);
    if (made >= 16 && stats_.bursts.size() < 256) {
      stats_.bursts.push_back({frame, made, ns});
    }
  }
  stats_.strings = strings_.size();
  if (batch->entries.empty() && batch->strings.empty() && batch->group_names.empty() &&
      batch->meta_names.empty()) {
    return nullptr;
  }
  return batch;
}

void Host::watch(std::uint64_t rid, std::uint64_t instance_id, std::int32_t filter) {
  if (watched_slot_.find(rid) != watched_slot_.end()) {
    return;  // a union reset re-resolved it: still watched
  }
  const std::uint64_t t0 = now_ns();
  const bool connected = filter_watch(instance_id, rid);
  stats_.watch_ns += now_ns() - t0;
  stats_.watches += connected ? 1 : 0;
  watched_slot_.emplace(rid, watched_.size());
  watched_.push_back({rid, instance_id, (filter & kHasPointBit) != 0});
  stats_.watched_max = std::max<std::uint64_t>(stats_.watched_max, watched_.size());
}

void Host::unwatch_slot(std::size_t slot) {
  filter_forget(watched_[slot].instance_id);
  watched_slot_.erase(watched_[slot].rid);
  if (slot + 1 != watched_.size()) {
    watched_[slot] = watched_.back();
    watched_slot_[watched_[slot].rid] = slot;
  }
  watched_.pop_back();
  ++stats_.gone;
}

bool Host::restamp(const Mirror &mirror, std::uint64_t rid, std::int32_t value,
                   std::uint64_t frame, Batch *batch) {
  const auto it = by_rid_.find(rid);
  if (it == by_rid_.end() || it->second.mouse_filter == value) {
    return false;  // unchanged, or not resolved yet (its first row carries the current value)
  }
  std::uint64_t now_rid = 0;
  bool published = false;
  if (!mirror.item_info(it->second.id, &now_rid, &published) || now_rid != rid) {
    return false;
  }
  if (v2_options_.restamp_skip) {
    ++stats_.restamp_skipped;
    return false;
  }
  // ID-D5: the whole row again, stamped at the frame it was re-read; it replaces the old one.
  Entry entry = it->second;
  entry.mouse_filter = value;
  entry.stamp = frame;
  it->second = entry;
  if (log_ != nullptr) {
    std::fprintf(log_,
                 "{\"id\":%u,\"rid\":\"%llu\",\"stamp\":%llu,\"node\":true,\"copy\":false,"
                 "\"restamp\":%d}\n",
                 static_cast<unsigned>(entry.id), static_cast<unsigned long long>(rid),
                 static_cast<unsigned long long>(frame), static_cast<int>(value));
  }
  batch->entries.push_back(std::move(entry));
  ++stats_.restamps;
  return true;
}

// ID-D4: the Controls whose property_list_changed fired, then GRC_ITEM_META_SWEEP Controls round
// robin (mouse_behavior_recursive emits nothing).
void Host::filter_pass(const Mirror &mirror, std::uint64_t frame, Batch *batch) {
  const bool raw = v2_options_.raw_filter;
  const std::uint64_t t0 = now_ns();
  filter_take_changed(&changed_);
  for (const std::uint64_t rid : changed_) {
    const auto slot = watched_slot_.find(rid);
    if (slot == watched_slot_.end()) {
      continue;
    }
    Watched &w = watched_[slot->second];
    std::int32_t value = -1;
    if (!filter_read(w.instance_id, true, raw, &value, &w.has_point)) {
      unwatch_slot(slot->second);
      continue;
    }
    stats_.restamps_signal += restamp(mirror, rid, value, frame, batch) ? 1 : 0;
  }
  stats_.changed += changed_.size();
  const std::uint64_t t1 = now_ns();
  if (!changed_.empty()) {
    stats_.changed_ns += t1 - t0;
  }
  const std::size_t n = std::min<std::size_t>(v2_options_.sweep, watched_.size());
  if (n == 0) {
    return;
  }
  std::size_t read = 0;
  while (read < n && !watched_.empty()) {
    if (cursor_ >= watched_.size()) {
      cursor_ = 0;
    }
    Watched &w = watched_[cursor_];
    std::int32_t value = -1;
    ++read;
    if (!filter_read(w.instance_id, false, raw, &value, &w.has_point)) {
      unwatch_slot(cursor_);  // the back moved into this slot: read it next
      continue;
    }
    stats_.restamps_sweep += restamp(mirror, w.rid, value, frame, batch) ? 1 : 0;
    ++cursor_;
  }
  const std::uint64_t ns = now_ns() - t1;
  ++stats_.sweep_frames;
  stats_.sweep_reads += read;
  stats_.sweep_ns += ns;
  stats_.sweep_max_ns = std::max(stats_.sweep_max_ns, ns);
  if (stats_.sweep_frame_ns.size() < 65536) {
    stats_.sweep_frame_ns.push_back(static_cast<std::uint32_t>(std::min<std::uint64_t>(ns, ~0u)));
  }
}

// ID-D9: the union dropped to nothing (live_close_and_stop, or the last asker left): every
// connection undone, the queue, the sweep and its cursor cleared.
void Host::filter_off() {
  const std::uint64_t t0 = now_ns();
  stats_.unwatched += filter_unwatch_all(v2_options_.leak_connections);
  stats_.unwatch_ns += now_ns() - t0;
  ++stats_.unwatch_calls;
  stats_.watched_after_off = filter_watch_count();
  watched_.clear();
  watched_slot_.clear();
  changed_.clear();
  cursor_ = 0;
  v2_filter_ = false;
}

std::string Host::stats_json() const {
  const HostStats &s = stats_;
  std::string out = "{\n";
  const auto num = [&out](const char *key, std::uint64_t v, bool last = false) {
    out += "  \"";
    out += key;
    out += "\": ";
    out += std::to_string(v);
    out += last ? "\n" : ",\n";
  };
  num("turned_on", s.turned_on);
  num("union_resets", s.union_resets);
  num("passes", s.passes);
  num("resolved", s.resolved);
  num("no_node", s.no_node);
  num("rekey_copies", s.rekey_copies);
  num("unpublished_waits", s.unpublished_waits);
  num("node_waits", s.node_waits);
  num("budget_stops", s.budget_stops);
  num("budget_ns", budget_ns_);
  num("pending_max", s.pending_max);
  num("resolve_ns", s.resolve_ns);
  num("pass_ns", s.pass_ns);
  num("max_pass_ns", s.max_pass_ns);
  num("max_pass_items", s.max_pass_items);
  num("strings", s.strings);
  if (s.v2_ever) {
    // ID3: the mouse_filter watch's cost (results/p3/id3.md).
    std::vector<std::uint32_t> sorted = s.sweep_frame_ns;
    std::sort(sorted.begin(), sorted.end());
    const auto pct = [&sorted](double q) -> std::uint64_t {
      return sorted.empty() ? 0 : sorted[static_cast<std::size_t>(q * (sorted.size() - 1))];
    };
    num("v2_sweep_per_frame", v2_options_.sweep);
    num("v2_watches", s.watches);
    num("v2_watch_ns", s.watch_ns);
    num("v2_watched_max", s.watched_max);
    num("v2_changed", s.changed);
    num("v2_changed_ns", s.changed_ns);
    num("v2_sweep_frames", s.sweep_frames);
    num("v2_sweep_reads", s.sweep_reads);
    num("v2_sweep_ns", s.sweep_ns);
    num("v2_sweep_max_ns", s.sweep_max_ns);
    num("v2_sweep_p50_ns", pct(0.5));
    num("v2_sweep_p95_ns", pct(0.95));
    num("v2_restamps", s.restamps);
    num("v2_restamps_signal", s.restamps_signal);
    num("v2_restamps_sweep", s.restamps_sweep);
    num("v2_restamp_skipped", s.restamp_skipped);
    num("v2_gone", s.gone);
    num("v2_unwatched", s.unwatched);
    num("v2_unwatch_calls", s.unwatch_calls);
    num("v2_unwatch_ns", s.unwatch_ns);
    num("v2_watched_after_off", s.watched_after_off);
  }
  out += "  \"bursts\": [";
  for (std::size_t i = 0; i < s.bursts.size(); ++i) {
    out += i == 0 ? "" : ", ";
    out += "{\"frame\": " + std::to_string(s.bursts[i].frame) +
           ", \"items\": " + std::to_string(s.bursts[i].items) +
           ", \"ns\": " + std::to_string(s.bursts[i].ns) + "}";
  }
  out += "]\n}\n";
  return out;
}

}  // namespace item_meta
}  // namespace rs
}  // namespace grc
