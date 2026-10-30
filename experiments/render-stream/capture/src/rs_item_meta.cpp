#include "rs_item_meta.h"

#include <algorithm>
#include <cstring>

namespace grc {
namespace rs {
namespace item_meta {

const char *const kFieldNames[kFieldCount] = {"class", "script", "scene", "path"};

namespace {

void append_u32le(std::vector<std::uint8_t> *out, std::uint32_t v) {
  for (int i = 0; i < 4; ++i) {
    out->push_back(static_cast<std::uint8_t>(v >> (8 * i)));
  }
}

// render-stream-0.md canonical strings, as rs2_codec's append_json_string: printable ASCII kept,
// '"' and '\\' escaped, any other byte '?'. The host interns strings already in this form.
void append_string(std::string *out, const std::string &value) {
  out->push_back('"');
  for (unsigned char c : value) {
    if (c == '"') {
      *out += "\\\"";
    } else if (c == '\\') {
      *out += "\\\\";
    } else if (c >= 0x20 && c <= 0x7E) {
      out->push_back(static_cast<char>(c));
    } else {
      out->push_back('?');
    }
  }
  out->push_back('"');
}

void append_list(std::string *out, const std::vector<std::string> &values) {
  out->push_back('[');
  for (std::size_t i = 0; i < values.size(); ++i) {
    if (i != 0) {
      out->push_back(',');
    }
    append_string(out, values[i]);
  }
  out->push_back(']');
}

bool printable_name(const std::string &name) {
  if (name.empty() || name.size() > 64) {
    return false;
  }
  for (unsigned char c : name) {
    if (c < 0x20 || c > 0x7E) {
      return false;
    }
  }
  return true;
}

std::string names_problem(const char *key, const std::vector<std::string> &names,
                          std::size_t max) {
  if (names.size() > max) {
    return std::string("item_meta.") + key + " has more than " + std::to_string(max) + " names";
  }
  for (std::size_t i = 0; i < names.size(); ++i) {
    if (!printable_name(names[i])) {
      return std::string("item_meta.") + key + " names must be printable ASCII, 1 to 64 bytes";
    }
    for (std::size_t j = 0; j < i; ++j) {
      if (names[j] == names[i]) {
        return std::string("item_meta.") + key + " repeats \"" + names[i] + "\"";
      }
    }
  }
  return std::string();
}

int field_index(const std::string &name) {
  for (int i = 0; i < kFieldCount; ++i) {
    if (name == kFieldNames[i]) {
      return i;
    }
  }
  return -1;
}

std::uint32_t local_string(const Store &store, GrantTable *table, std::int32_t host) {
  const auto found = table->of_host.find(static_cast<std::uint32_t>(host));
  if (found != table->of_host.end()) {
    return found->second;
  }
  (void)store;
  const std::uint32_t index = static_cast<std::uint32_t>(table->local.size());
  table->local.push_back(static_cast<std::uint32_t>(host));
  table->of_host.emplace(static_cast<std::uint32_t>(host), index);
  return index;
}

}  // namespace

std::uint32_t Request::field_bits() const {
  std::uint32_t bits = 0;
  for (const std::string &f : fields) {
    const int i = field_index(f);
    if (i >= 0) {
      bits |= 1u << i;
    }
  }
  return bits;
}

bool parse_grant_env(const std::string &text, std::uint32_t *bits, std::string *error) {
  *bits = 0;
  if (text.empty()) {
    return true;
  }
  std::size_t start = 0;
  while (start <= text.size()) {
    std::size_t comma = text.find(',', start);
    if (comma == std::string::npos) {
      comma = text.size();
    }
    const std::string name = text.substr(start, comma - start);
    std::uint32_t bit = 0;
    if (name == "groups") {
      bit = kGroups;
    } else if (name == "meta") {
      bit = kMeta;
    } else if (field_index(name) >= 0) {
      bit = 1u << field_index(name);
    }
    if (bit == 0 || (*bits & bit) != 0) {
      *error = "GRC_ITEM_META: \"" + name +
               "\" is not class, script, scene, path, groups or meta (or repeats)";
      *bits = 0;
      return false;
    }
    *bits |= bit;
    start = comma + 1;
  }
  return true;
}

std::string grant_env_string(std::uint32_t bits) {
  std::string out;
  const char *names[6] = {"class", "script", "scene", "path", "groups", "meta"};
  for (int i = 0; i < 6; ++i) {
    if ((bits & (1u << i)) != 0) {
      out += out.empty() ? "" : ",";
      out += names[i];
    }
  }
  return out;
}

std::string request_problem(const Request &request) {
  int last = -1;
  for (const std::string &f : request.fields) {
    const int i = field_index(f);
    if (i < 0) {
      return "item_meta.fields: \"" + f + "\" is not class, script, scene or path";
    }
    if (i <= last) {
      return "item_meta.fields must be in class, script, scene, path order, without duplicates";
    }
    last = i;
  }
  std::string problem = names_problem("groups", request.groups, kMaxGroups);
  if (problem.empty()) {
    problem = names_problem("meta_keys", request.meta_keys, kMaxMetaKeys);
  }
  if (problem.empty() && request.empty()) {
    problem = "item_meta asks for nothing (fields, groups and meta_keys are all empty)";
  }
  return problem;
}

Request grant_for(std::uint32_t host_bits, const Request &request) {
  Request grant;
  for (const std::string &f : request.fields) {
    if ((host_bits & (1u << field_index(f))) != 0) {
      grant.fields.push_back(f);
    }
  }
  if ((host_bits & kGroups) != 0) {
    grant.groups = request.groups;
  }
  if ((host_bits & kMeta) != 0) {
    grant.meta_keys = request.meta_keys;
  }
  return grant;
}

std::string grant_json(const Request &grant) {
  std::string out = "{\"fields\":";
  append_list(&out, grant.fields);
  out += ",\"groups\":";
  append_list(&out, grant.groups);
  out += ",\"meta_keys\":";
  append_list(&out, grant.meta_keys);
  out += "}";
  return out;
}

void Store::apply(const Batch &batch) {
  // Batches arrive in order; a table only grows, so a batch's `*_from` equals the table's length.
  if (batch.strings_from == strings_.size()) {
    strings_.insert(strings_.end(), batch.strings.begin(), batch.strings.end());
  }
  if (batch.groups_from == group_names_.size()) {
    group_names_.insert(group_names_.end(), batch.group_names.begin(), batch.group_names.end());
  }
  if (batch.meta_from == meta_names_.size()) {
    meta_names_.insert(meta_names_.end(), batch.meta_names.begin(), batch.meta_names.end());
  }
  for (const Entry &e : batch.entries) {
    entries_[e.id] = e;
    order_.emplace_back(e.stamp, e.id);
  }
}

void Store::prune(const rs2::Snapshot &alive) {
  if (entries_.size() < prune_at_) {
    return;
  }
  for (auto it = entries_.begin(); it != entries_.end();) {
    it = alive.items.find(it->first) == nullptr ? entries_.erase(it) : std::next(it);
  }
  order_.erase(std::remove_if(order_.begin(), order_.end(),
                              [this](const std::pair<std::uint64_t, std::uint32_t> &o) {
                                const Entry *e = find(o.second);
                                return e == nullptr || e->stamp != o.first;
                              }),
               order_.end());
  prune_at_ = std::max<std::size_t>(4096, entries_.size() * 2);
}

bool form(const Store &store, GrantTable *table, bool full, std::uint64_t from, std::uint64_t to,
          std::uint64_t strings_have, const rs2::Snapshot &target, std::uint32_t id_offset,
          Formed *out) {
  const Request &grant = table->grant;
  int fields[kFieldCount];
  int nfields = 0;
  for (const std::string &f : grant.fields) {
    fields[nfields++] = field_index(f);
  }
  // The grant's groups and meta keys as host-table indices (-1: no item resolved has it yet).
  std::vector<std::int64_t> group_host(grant.groups.size(), -1);
  for (std::size_t i = 0; i < grant.groups.size(); ++i) {
    for (std::size_t h = 0; h < store.group_names().size(); ++h) {
      if (store.group_names()[h] == grant.groups[i]) {
        group_host[i] = static_cast<std::int64_t>(h);
        break;
      }
    }
  }
  std::vector<std::int64_t> meta_host(grant.meta_keys.size(), -1);
  for (std::size_t i = 0; i < grant.meta_keys.size(); ++i) {
    for (std::size_t h = 0; h < store.meta_names().size(); ++h) {
      if (store.meta_names()[h] == grant.meta_keys[i]) {
        meta_host[i] = static_cast<std::int64_t>(h);
        break;
      }
    }
  }
  std::vector<const Entry *> rows;
  if (full) {
    for (const rs2::ItemState &item : target.items) {
      const Entry *e = store.find(item.id);
      if (e != nullptr && e->stamp <= to) {
        rows.push_back(e);
      }
    }
  } else {
    store.each_stamped(from, to, [&](const Entry &e) {
      if (target.items.find(e.id) != nullptr) {
        rows.push_back(&e);
      }
    });
    if (rows.empty()) {
      return false;
    }
    std::sort(rows.begin(), rows.end(),
              [](const Entry *a, const Entry *b) { return a->id < b->id; });
  }
  std::string items = "[";
  for (std::size_t r = 0; r < rows.size(); ++r) {
    const Entry &e = *rows[r];
    items += r == 0 ? "[" : ",[";
    items += std::to_string(e.id + id_offset);
    if (e.node) {
      for (int k = 0; k < nfields; ++k) {
        const std::int32_t s = e.field[fields[k]];
        items += ",";
        items += s < 0 ? "null" : std::to_string(local_string(store, table, s));
      }
      if (!grant.groups.empty()) {
        std::uint32_t mask = 0;
        for (std::size_t i = 0; i < group_host.size(); ++i) {
          if (group_host[i] >= 0 &&
              std::binary_search(e.groups.begin(), e.groups.end(),
                                 static_cast<std::uint32_t>(group_host[i]))) {
            mask |= 1u << i;
          }
        }
        items += ",";
        items += std::to_string(mask);
      }
      for (std::size_t i = 0; i < meta_host.size(); ++i) {
        const std::int64_t h = meta_host[i];
        const std::int32_t s =
            h >= 0 && static_cast<std::size_t>(h) < e.meta.size() ? e.meta[h] : -1;
        items += ",";
        items += s < 0 ? "null" : std::to_string(local_string(store, table, s));
      }
    }
    items += "]";
  }
  items += "]";
  const std::uint64_t strings_from = full ? 0 : strings_have;
  std::string m = "{\"type\":\"item_meta\",\"form\":";
  m += full ? "\"full\"" : "\"delta\"";
  m += ",\"grant\":";
  m += full ? table->json : std::string("null");
  m += ",\"strings_from\":";
  m += std::to_string(strings_from);
  m += ",\"strings\":[";
  for (std::size_t i = strings_from; i < table->local.size(); ++i) {
    if (i != strings_from) {
      m += ",";
    }
    append_string(&m, store.strings()[table->local[i]]);
  }
  m += "],\"items\":";
  m += items;
  m += ",\"blocks\":[]}";
  auto bytes = std::make_shared<std::vector<std::uint8_t>>();
  bytes->reserve(m.size() + 12);
  append_u32le(bytes.get(), static_cast<std::uint32_t>(m.size() + 8));
  append_u32le(bytes.get(), static_cast<std::uint32_t>(m.size()));
  bytes->insert(bytes->end(), m.begin(), m.end());
  append_u32le(bytes.get(), 0);
  out->bytes = std::move(bytes);
  out->strings_after = table->local.size();
  out->rows = rows.size();
  return true;
}

}  // namespace item_meta
}  // namespace rs
}  // namespace grc
