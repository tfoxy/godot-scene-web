// Exercise the real host and mirror with engine identity/watch calls replaced by test doubles.
#include <cstdio>
#include <unordered_map>
#include <unordered_set>

#include "rs_item_meta_host.h"
#include "rs_mirror.h"

namespace {
using namespace grc::rs;
using namespace grc::rs::item_meta;
std::unordered_map<std::uint64_t, Identity> identities;
std::unordered_set<std::uint64_t> entered;
std::unordered_set<std::uint64_t> detached;
std::unordered_set<std::uint64_t> watches;
std::vector<std::uint64_t> changed;
int failures = 0;
int checks = 0;
void expect(bool ok, const char *what) {
  ++checks;
  if (!ok) {
    ++failures;
    std::printf("FAIL host: %s\n", what);
  }
}
Identity identity() {
  Identity i;
  i.node = true;
  for (int n = 0; n < 4; ++n) {
    i.has[n] = true;
    i.field[n] = "field" + std::to_string(n);
  }
  i.node_id = 123;
  i.instance_id = 123;
  i.mouse_filter = 0;
  i.in_group = {true};
  i.meta = {{true, "PoolHitbox"}};
  return i;
}
Request request() {
  Request r;
  r.fields = {"class", "script", "scene", "path", "instance_id", "mouse_filter"};
  r.groups = {"pool"};
  r.meta_keys = {"rs_pick"};
  return r;
}
void setup(Mirror &m, Host &h) {
  identities.clear();
  entered.clear();
  detached.clear();
  watches.clear();
  changed.clear();
  m.set_root(1, 2, grc::rs2::kIdentityXform);
  m.canvas_item_create(100, 1);
  m.set_parent(100, 2, 1);
  m.snapshot(1, 1);
  h.configure(1000000, false);
  Host::V2Options options;
  options.sweep = 0;
  h.configure_v2(options);
  h.set_union(request(), 1);
}
}  // namespace

// Engine-facing calls only. The production host and mirror remain unchanged in this test.
namespace grc::rs {
bool node_map_acquire_tag(std::string *) { return true; }
void node_map_release_tag() { entered.clear(); }
void tag_set_query(const IdentityQuery &, bool) {}
void tag_prune_map() {}
void tag_take_entered(std::unordered_set<std::uint64_t> *out) {
  out->clear();
  out->swap(entered);
}
bool item_identity(std::uint64_t rid, Identity *out, bool reentry) {
  if (reentry && detached.count(rid) != 0) return false;
  auto it = identities.find(rid);
  if (it == identities.end()) return false;
  *out = it->second;
  return true;
}
bool filter_watch(std::uint64_t id, std::uint64_t) { return watches.insert(id).second; }
void filter_forget(std::uint64_t id) { watches.erase(id); }
void filter_take_changed(std::vector<std::uint64_t> *out) { out->swap(changed); changed.clear(); }
bool filter_read(std::uint64_t id, bool, bool, std::int32_t *value, bool *has_point) {
  for (const auto &row : identities) {
    if (row.second.node_id == id) {
      *value = row.second.mouse_filter;
      *has_point = false;
      return true;
    }
  }
  return false;
}
std::size_t filter_unwatch_all(bool) { auto n = watches.size(); watches.clear(); return n; }
std::size_t filter_watch_count() { return watches.size(); }
}  // namespace grc::rs

int item_meta_host_tests() {
  {
    Mirror m;
    Host h;
    setup(m, h);
    identities[100] = identity();
    auto b = h.pass(m, 1);
    expect(b && b->entries.size() == 1, "initial row resolves");
    entered.insert(100);
    entered.insert(100);
    b = h.pass(m, 2);
    expect(!b && h.stats().reentry_same == 1 && h.stats().reentry_queued == 1 &&
               h.stats().reentry_max_batch == 1, "equal re-entry is deduplicated and emits nothing");
    for (int column = 0; column < 8; ++column) {
      auto &i = identities[100];
      if (column < 4) i.field[column] += "changed";
      else if (column == 4) ++i.instance_id;
      else if (column == 5) i.mouse_filter = 1;
      else if (column == 6) i.in_group[0] = false;
      else i.meta[0].second += "changed";
      entered.insert(100);
      b = h.pass(m, 3 + column);
      expect(b && b->entries.size() == 1 && b->entries[0].id == 1 &&
                 b->entries[0].stamp == static_cast<std::uint64_t>(3 + column),
             "each changed identity column emits one row for the same id");
      entered.insert(100);
      expect(!h.pass(m, 20 + column), "replacement is held: subsequent equal read emits nothing");
    }
    const auto no_node = h.stats().no_node;
    detached.insert(100);
    identities[100].field[3] = "detached";
    entered.insert(100);
    expect(!h.pass(m, 38) && h.stats().no_node == no_node,
           "a live node detached again is dropped without a null-node row");
    detached.clear();
    expect(!h.pass(m, 39), "a detached re-entry is never retried");
    identities.erase(100);
    entered.insert(100);
    expect(!h.pass(m, 40) && h.stats().no_node == no_node,
           "node gone again drops the re-entry without no_node");
    identities[100] = identity();
    expect(!h.pass(m, 200), "a gone re-entry is never retried");
    expect(h.stats().reentry_rows == 8, "only changed rows count as reentry_rows");
    h.set_union(Request(), 201);
  }
  {
    Mirror m;
    Host h;
    setup(m, h);
    identities[100] = identity();
    auto b = h.pass(m, 1);
    Store store;
    if (b) store.apply(*b);
    grc::rs2::Snapshot target;
    grc::rs2::ItemState item;
    item.id = 1;
    target.items.set(item);
    GrantTable table;
    table.grant = request();
    table.json = grant_json(table.grant);
    Formed full;
    expect(form(store, &table, true, 0, 1, 0, target, 0, &full),
           "resolved row forms the initial full before a simultaneous update");

    identities[100].mouse_filter = 2;
    identities[100].meta[0].second = "ReenteredHitbox";
    changed.push_back(100);
    entered.insert(100);
    b = h.pass(m, 2);
    expect(b && b->entries.size() == 1 && b->entries[0].id == 1 &&
               b->entries[0].stamp == 2 && b->entries[0].mouse_filter == 2 &&
               b->entries[0].meta.size() == 1 && b->entries[0].meta[0] >= 0 &&
               b->strings[static_cast<std::size_t>(b->entries[0].meta[0]) - b->strings_from] ==
                   "ReenteredHitbox",
           "same-pass restamp and re-entry emit one row with the new filter and meta");
    expect(h.stats().restamps_signal == 1 && h.stats().reentry_rows == 1,
           "simultaneous update exercises both the filter signal and changed re-entry");
    if (b) store.apply(*b);
    Formed delta;
    const bool formed = form(store, &table, false, 1, 2, full.strings_after, target, 0, &delta);
    expect(formed && delta.rows == 1 &&
               std::string(delta.bytes->begin() + 8, delta.bytes->end() - 4)
                       .find("\"items\":[[1,") != std::string::npos,
           "Store and delta formation retain exactly one row for the updated id");
    h.set_union(Request(), 3);
  }
  {
    Mirror m;
    Host h;
    setup(m, h);
    auto b = h.pass(m, 1);
    expect(b && b->entries.empty(), "first resolution waits while outside the tree");
    b = h.pass(m, 1 + kPendingFrames);
    expect(b && b->entries.size() == 1 && !b->entries[0].node && h.stats().no_node == 1,
           "120-frame first resolution still produces node:false");
    identities[100] = identity();
    entered.insert(100);
    b = h.pass(m, 150);
    expect(b && b->entries.size() == 1 && b->entries[0].node &&
               b->entries[0].instance_id == 123 && b->entries[0].mouse_filter == 0 &&
               b->entries[0].groups == std::vector<std::uint32_t>{0} &&
               b->entries[0].meta.size() == 1 && b->entries[0].meta[0] >= 0 &&
               b->entries[0].field[3] >= 0,
           "node:false becomes node:true with fields, groups and meta");
    expect(h.stats().watches == 1 && watches.count(123) == 1,
           "newly known Control starts its mouse_filter watch");
    identities[100].mouse_filter = 2;
    changed.push_back(100);
    b = h.pass(m, 151);
    expect(b && b->entries.size() == 1 && b->entries[0].mouse_filter == 2 &&
               h.stats().restamps_signal == 1, "new watch covers subsequent filter changes");
    h.set_union(Request(), 152);
  }
  {
    Mirror m;
    Host h;
    setup(m, h);
    identities[100] = identity();
    h.pass(m, 1);
    m.canvas_item_create(101, 2);
    m.set_parent(101, 2, 2);
    identities[101] = identity();
    m.snapshot(2, 2);
    h.pass(m, 2);
    identities[100].meta[0].second = "updated";
    identities[101].meta[0].second = "updated";
    entered.insert(100);
    entered.insert(101);
    h.configure(0, false);  // deterministic: one identity read per pass
    auto b = h.pass(m, 3);
    expect(b && b->entries.size() == 1 && h.stats().budget_stops == 1 &&
               h.stats().reentry_max_batch == 2, "re-entry reads consume the frame budget");
    const auto first = b ? b->entries[0].id : 0;
    b = h.pass(m, 4);
    expect(b && b->entries.size() == 1 && b->entries[0].id != first &&
               h.stats().reentry_rows == 2, "budget remainder resumes on the following pass");
    h.set_union(Request(), 5);
  }
  std::printf("host: %d checks, %d failure(s)\n", checks, failures);
  return failures;
}
