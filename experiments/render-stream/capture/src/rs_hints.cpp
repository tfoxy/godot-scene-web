#include "rs_hints.h"

#include <algorithm>
#include <cstring>
#include <random>

#include "rs2_codec.h"

namespace grc {
namespace rs {
namespace hints {

bool parse_sabotage(const char *value, Sabotage *out, std::string *why) {
  *out = Sabotage::None;
  if (value == nullptr || value[0] == '\0') {
    return true;
  }
  if (std::strcmp(value, "hint-unknown-hash") == 0) {
    *out = Sabotage::UnknownHash;
  } else if (std::strcmp(value, "hint-early-unhint") == 0) {
    *out = Sabotage::EarlyUnhint;
  } else if (std::strcmp(value, "hint-edited-path") == 0) {
    *out = Sabotage::EditedPath;
  } else {
    *why = std::string("GRC_HINT_SABOTAGE=") + value +
           " (expected hint-unknown-hash, hint-early-unhint or hint-edited-path)";
    return false;
  }
  return true;
}

const char *sabotage_name(Sabotage sabotage) {
  switch (sabotage) {
    case Sabotage::UnknownHash: return "hint-unknown-hash";
    case Sabotage::EarlyUnhint: return "hint-early-unhint";
    case Sabotage::EditedPath: return "hint-edited-path";
    case Sabotage::None: break;
  }
  return "none";
}

std::uint64_t at_rest_bytes(const Entry &entry, const SiblingBytes &sibling) {
  const auto one = [&sibling](const PayloadPtr &body) -> std::uint64_t {
    if (body == nullptr) {
      return 0;
    }
    return body->held_bytes() + (sibling ? sibling(body) : 0);
  };
  std::uint64_t total = one(entry.body);
  for (const auto &variant : entry.variant_bodies) {
    total += one(variant.second);
  }
  return total;
}

namespace {

std::string random_hash() {
  static const char kDigits[] = "0123456789abcdef";
  std::random_device device;
  std::mt19937_64 rng((static_cast<std::uint64_t>(device()) << 32) ^ device());
  std::string out(64, '0');
  for (char &c : out) {
    c = kDigits[rng() & 0xf];
  }
  return out;
}

std::shared_ptr<Entry> make_entry(Source source, std::uint64_t priority) {
  auto entry = std::make_shared<Entry>();
  entry->hint = std::move(source.hint);
  entry->hint.priority = priority;
  entry->rid = source.rid;
  entry->body = std::move(source.body);
  entry->variant_bodies = std::move(source.variant_bodies);
  entry->record = std::make_shared<const std::vector<std::uint8_t>>(
      rs2::encode_resource_hint(entry->hint));
  return entry;
}

}  // namespace

bool Table::add(Source source, Sabotage sabotage) {
  if (source.hint.hash.empty() || by_hash_.count(source.hint.hash) != 0) {
    return false;
  }
  // A removed entry of the same hash may still be referenced; the new one shares its hash, so
  // collect() lets the removed one go once nothing needs it apart.
  const bool first = next_priority_ == 0;
  Source fake;
  if (sabotage == Sabotage::UnknownHash && first) {
    // hint-unknown-hash: one hint of a hash nothing holds, shaped as the first real one.
    fake.hint = source.hint;
    fake.hint.hash = random_hash();
    fake.hint.variants.clear();
    fake.hint.has_path = false;
    fake.hint.path.clear();
  }
  std::shared_ptr<Entry> entry = make_entry(std::move(source), next_priority_++);
  by_hash_[entry->hint.hash] = entry;
  order_.push_back(entry);
  if (!fake.hint.hash.empty()) {
    std::shared_ptr<Entry> unknown = make_entry(std::move(fake), next_priority_++);
    by_hash_[unknown->hint.hash] = unknown;
    order_.push_back(unknown);
  }
  return true;
}

bool Table::remove(const std::string &hash) {
  const auto it = by_hash_.find(hash);
  if (it == by_hash_.end()) {
    return false;
  }
  it->second->removed = true;
  it->second->admitted = false;
  removed_[hash] = it->second;
  by_hash_.erase(it);
  return true;
}

void Table::clear() {
  for (auto &entry : by_hash_) {
    entry.second->removed = true;
    entry.second->admitted = false;
    removed_[entry.first] = entry.second;
  }
  by_hash_.clear();
  admitted_bytes_ = 0;
}

void Table::set_in_state(const std::function<bool(const std::string &)> &in_state) {
  for (auto &entry : by_hash_) {
    entry.second->in_state = in_state(entry.first);
  }
}

std::uint64_t Table::walk(const SiblingBytes &sibling) {
  std::uint64_t dropped = 0;
  std::uint64_t total = 0;
  bool full = false;
  for (const std::shared_ptr<Entry> &entry : order_) {
    if (entry->removed) {
      continue;
    }
    if (entry->in_state) {
      entry->admitted = true;
      continue;
    }
    const std::uint64_t bytes = at_rest_bytes(*entry, sibling);
    const bool fits = !full && total + bytes <= budget_;
    if (fits) {
      total += bytes;
      entry->admitted = true;
      continue;
    }
    full = true;  // a strict priority prefix: nothing after the first misfit is admitted
    if (entry->admitted) {
      ++dropped;
    }
    entry->admitted = false;
  }
  admitted_bytes_ = total;
  return dropped;
}

void Table::collect(const std::function<bool(const std::string &)> &referenced) {
  for (auto it = removed_.begin(); it != removed_.end();) {
    const bool shadowed = by_hash_.count(it->first) != 0;
    if (shadowed || !referenced(it->first)) {
      it = removed_.erase(it);
    } else {
      ++it;
    }
  }
  // order_ keeps live entries and the removed ones still held.
  order_.erase(std::remove_if(order_.begin(), order_.end(),
                              [this](const std::shared_ptr<Entry> &entry) {
                                if (!entry->removed) {
                                  return false;
                                }
                                const auto it = removed_.find(entry->hint.hash);
                                return it == removed_.end() || it->second != entry;
                              }),
               order_.end());
}

std::vector<const Entry *> Table::live() const {
  std::vector<const Entry *> out;
  out.reserve(by_hash_.size());
  for (const std::shared_ptr<Entry> &entry : order_) {
    if (!entry->removed) {
      out.push_back(entry.get());
    }
  }
  return out;
}

const Entry *Table::find(const std::string &hash) const {
  const auto it = by_hash_.find(hash);
  return it == by_hash_.end() ? nullptr : it->second.get();
}

const Entry *Table::held(const std::string &hash) const {
  const Entry *live = find(hash);
  if (live != nullptr) {
    return live;
  }
  const auto it = removed_.find(hash);
  return it == removed_.end() ? nullptr : it->second.get();
}

void diff(const Table &table, Sent *sent, std::uint64_t frame, Sabotage sabotage, std::size_t max,
          Diff *out) {
  *out = Diff();
  // Unhints: a sent hash whose entry left the table or the budget (or, under hint-early-unhint,
  // any hint sent at an earlier callback).
  for (auto it = sent->hinted.begin(); it != sent->hinted.end();) {
    const Entry *entry = table.find(it->first);
    if (it->second.spent) {
      // Forget a spent hash once its entry is gone, so a later entry of it may be hinted again.
      it = entry == nullptr ? sent->hinted.erase(it) : std::next(it);
      continue;
    }
    const bool gone = entry == nullptr || !entry->admitted;
    const bool early = !gone && sabotage == Sabotage::EarlyUnhint && it->second.frame < frame;
    if (!gone && !early) {
      ++it;
      continue;
    }
    if (out->records.size() >= max) {
      return;
    }
    out->records.push_back(
        std::make_shared<const std::vector<std::uint8_t>>(rs2::encode_resource_unhint(it->first)));
    out->unhinted.push_back(it->first);
    if (early) {
      it->second.spent = true;
      ++it;
    } else {
      it = sent->hinted.erase(it);
    }
  }
  for (const Entry *entry : table.live()) {
    if (out->records.size() >= max) {
      return;
    }
    // An entry the captured state already names reaches the sink through its transactions.
    if (!entry->admitted || entry->in_state || sent->hinted.count(entry->hint.hash) != 0) {
      continue;
    }
    out->records.push_back(entry->record);
    out->hinted.push_back(entry);
    sent->hinted[entry->hint.hash] = Sent::Hinted{frame, false};
  }
}

void pinned(const Table &table, const std::vector<const Sent *> &sinks,
            std::map<std::string, PayloadPtr> *out) {
  out->clear();
  const auto add = [out](const Entry &entry) {
    if (entry.body == nullptr) {
      return;
    }
    (*out)[entry.hint.hash] = entry.body;
    for (const auto &variant : entry.variant_bodies) {
      if (variant.second != nullptr) {
        (*out)[variant.first] = variant.second;
      }
    }
  };
  for (const Entry *entry : table.live()) {
    if (entry->admitted) {
      add(*entry);
    }
  }
  for (const Sent *sink : sinks) {
    if (sink == nullptr) {
      continue;
    }
    for (const auto &hinted : sink->hinted) {
      if (hinted.second.spent || out->count(hinted.first) != 0) {
        continue;
      }
      const Entry *entry = table.held(hinted.first);
      if (entry != nullptr) {
        add(*entry);
      }
    }
  }
}

}  // namespace hints
}  // namespace rs
}  // namespace grc
