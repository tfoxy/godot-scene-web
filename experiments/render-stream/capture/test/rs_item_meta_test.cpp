// item_meta (render-stream-14.md): v2's pure
// half -- the v2 field names (a hello error below /14), the grant bits, the inline instance_id and
// int mouse_filter columns, and a re-stamped row replacing the held one in the next delta. TAG1's
// /13 rows are pinned byte for byte beside them.
#include <cstdio>
#include <string>
#include <vector>

#include "rs2_snapshot.h"
#include "rs_item_meta.h"

namespace {

int g_failures = 0;

void check(bool condition, const std::string &what) {
  if (!condition) {
    std::printf("FAIL %s\n", what.c_str());
    ++g_failures;
  } else {
    std::printf("ok   %s\n", what.c_str());
  }
}

using namespace grc::rs::item_meta;

std::string body(const Formed &f) {
  const std::vector<std::uint8_t> &b = *f.bytes;
  return std::string(b.begin() + 8, b.end() - 4);
}

grc::rs2::Snapshot target(std::initializer_list<std::uint32_t> ids) {
  grc::rs2::Snapshot s;
  for (std::uint32_t id : ids) {
    grc::rs2::ItemState item;
    item.id = id;
    s.items.set(item);
  }
  return s;
}

Entry node(std::uint32_t id, std::uint64_t stamp, std::int32_t cls, std::uint64_t instance,
           std::int32_t filter) {
  Entry e;
  e.id = id;
  e.stamp = stamp;
  e.node = true;
  e.field[0] = cls;
  e.instance_id = instance;
  e.mouse_filter = filter;
  return e;
}

}  // namespace

int item_meta_host_tests();

int main() {
  g_failures += item_meta_host_tests();
  // Names and grants.
  Request v2;
  v2.fields = {"class", "instance_id", "mouse_filter"};
  check(request_problem(v2, true).empty(), "the v2 names are fields at /14");
  check(!request_problem(v2, false).empty() &&
            request_problem(v2, false).find("is not class, script, scene or path") !=
                std::string::npos,
        "the v2 names are unknown fields below /14 (a hello error)");
  Request order;
  order.fields = {"mouse_filter", "instance_id"};
  check(!request_problem(order, true).empty(), "the v2 names keep their order");
  std::uint32_t bits = 0;
  std::string error;
  check(parse_grant_env("class,instance_id,mouse_filter,groups", &bits, &error) &&
            bits == (kClass | kInstanceId | kMouseFilter | kGroups),
        "GRC_ITEM_META accepts instance_id and mouse_filter");
  check(grant_env_string(bits) == "class,groups,instance_id,mouse_filter",
        "grant_env_string names the v2 bits");
  check(!parse_grant_env("mouse_filter,mouse_filter", &bits, &error), "a repeated v2 name refuses");
  check(v2.field_bits() == (kClass | kInstanceId | kMouseFilter), "field_bits maps the v2 names");
  check((grant_for(kClass | kMouseFilter, v2).fields == std::vector<std::string>{"class", "mouse_filter"}),
        "the grant intersects the v2 names");
  check(grant_json(grant_for(kClass | kMouseFilter, v2)) ==
            "{\"fields\":[\"class\",\"mouse_filter\"],\"groups\":[],\"meta_keys\":[]}",
        "the grant's JSON lists the v2 names");

  // Rows: a full with both columns, a non-Control (null filter) and a no-node item.
  Store store;
  Batch b1;
  b1.strings = {"Control", "Node2D"};
  b1.entries.push_back(node(1, 5, 0, 24578314207ull, 0));
  b1.entries.push_back(node(2, 5, 1, 24578314208ull, -1));
  Entry none;
  none.id = 3;
  none.stamp = 5;
  b1.entries.push_back(none);
  b1.entries.push_back(node(4, 5, 0, 18446744073709551615ull, 1 + kHasPointBit));
  store.apply(b1);
  GrantTable table;
  table.grant = v2;
  table.json = grant_json(v2);
  const grc::rs2::Snapshot t = target({1, 2, 3, 4});
  Formed full;
  check(form(store, &table, true, 0, 5, 0, t, 0, &full), "a v2 full forms");
  check(body(full) ==
            "{\"type\":\"item_meta\",\"form\":\"full\",\"grant\":{\"fields\":[\"class\",\"instance_id\","
            "\"mouse_filter\"],\"groups\":[],\"meta_keys\":[]},\"strings_from\":0,\"strings\":["
            "\"Control\",\"Node2D\"],\"items\":[[1,0,\"24578314207\",0],[2,1,\"24578314208\",null],[3],"
            "[4,0,\"18446744073709551615\",5]],\"blocks\":[]}",
        "the full's rows: inline instance ids, int filters, null for a non-Control, [id] for no node");

  // A /13 grant over the same store writes TAG1's rows exactly.
  GrantTable t13;
  t13.grant.fields = {"class"};
  t13.json = grant_json(t13.grant);
  Formed full13;
  form(store, &t13, true, 0, 5, 0, t, 0, &full13);
  check(body(full13) ==
            "{\"type\":\"item_meta\",\"form\":\"full\",\"grant\":{\"fields\":[\"class\"],\"groups\":[],"
            "\"meta_keys\":[]},\"strings_from\":0,\"strings\":[\"Control\",\"Node2D\"],\"items\":[[1,0],"
            "[2,1],[3],[4,0]],\"blocks\":[]}",
        "a grant without the v2 names forms TAG1's /13 rows");

  // A re-stamp: the whole row again at its new stamp; the next delta carries only it.
  Formed none_delta;
  check(!form(store, &table, false, 5, 6, full.strings_after, t, 0, &none_delta),
        "a warm frame forms no delta");
  Batch b2;
  b2.strings_from = 2;
  b2.entries.push_back(node(1, 7, 0, 24578314207ull, 2));
  store.apply(b2);
  Formed delta;
  check(form(store, &table, false, 6, 7, full.strings_after, t, 0, &delta), "a re-stamp forms a delta");
  check(body(delta) ==
            "{\"type\":\"item_meta\",\"form\":\"delta\",\"grant\":null,\"strings_from\":2,\"strings\":[],"
            "\"items\":[[1,0,\"24578314207\",2]],\"blocks\":[]}",
        "the delta carries the re-stamped row whole, and no strings");
  Formed later;
  check(form(store, &table, true, 0, 7, 0, t, 0, &later) &&
            body(later).find("[1,0,\"24578314207\",2]") != std::string::npos &&
            body(later).find("[1,0,\"24578314207\",0]") == std::string::npos,
        "a later full carries the current filter only");
  Formed old;
  check(!form(store, &table, false, 5, 6, 2, t, 0, &old), "the old stamp is no longer listed");
  std::printf("%d failure(s)\n", g_failures);
  return g_failures == 0 ? 0 : 1;
}
