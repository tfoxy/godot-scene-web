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
    if ((fields & (1u << i)) != 0) {
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
  if (work_.empty() && batch->group_names.empty() && batch->meta_names.empty()) {
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
        for (int i = 0; i < kFieldCount; ++i) {
          if (identity.has[i]) {
            entry.field[i] = intern(identity.field[i], batch.get());
          }
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
