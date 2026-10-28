// Unit tests for render-stream/2 diff (src/rs2_diff.cpp): make_full()/make_patch() derive byte-
// identical transactions to protocol/golden-2/{full,patch}.rs2 from the Snapshot states in
// rs2_golden_states.h (independent of rs2_codec_test.cpp, which builds the same bytes by hand),
// plus a seeded randomized round-trip that mutates both items AND textures (create, update,
// free, tombstone removal): resolve(make_patch(...)) reproduces make_full()'s state for 1000
// random mutation sequences on a test-local model.

#include <algorithm>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <limits>
#include <random>
#include <string>
#include <vector>

#include "rs2_codec.h"
#include "rs2_diff.h"
#include "rs2_golden_states.h"
#include "rs2_snapshot.h"

#ifndef GRC_GOLDEN2_DIR
#error "GRC_GOLDEN2_DIR must be defined by CMakeLists.txt"
#endif

namespace {

using namespace grc::rs2;  // NOLINT

int g_failures = 0;

void check(bool condition, const char *what) {
  if (!condition) {
    std::fprintf(stderr, "FAIL %s\n", what);
    ++g_failures;
  }
}

std::vector<std::uint8_t> read_file(const std::string &path) {
  std::FILE *file = std::fopen(path.c_str(), "rb");
  if (file == nullptr) {
    return {};
  }
  std::vector<std::uint8_t> data;
  unsigned char buf[4096];
  std::size_t n = 0;
  while ((n = std::fread(buf, 1, sizeof(buf), file)) > 0) {
    data.insert(data.end(), buf, buf + n);
  }
  std::fclose(file);
  return data;
}

void check_against_golden(const std::string &file, const std::vector<std::vector<std::uint8_t>> &records) {
  const std::string golden_path = std::string(GRC_GOLDEN2_DIR) + "/" + file;
  const std::vector<std::uint8_t> expected = read_file(golden_path);
  check(!expected.empty(), ("golden-2/" + file + " is readable").c_str());
  std::size_t offset = 0;
  for (std::size_t i = 0; i < records.size(); ++i) {
    const bool in_range = offset + records[i].size() <= expected.size();
    const bool matches = in_range && std::equal(records[i].begin(), records[i].end(),
                                                  expected.begin() + static_cast<long>(offset));
    check(matches, ("record " + std::to_string(i) + " matches golden-2/" + file).c_str());
    offset += records[i].size();
  }
  check(offset == expected.size(), ("encoded recording is exactly golden-2/" + file + "'s length").c_str());
}

// `records` is magic (index 0) followed by the session and transaction records. bytes_total sums
// all of it (magic included); max_record_bytes excludes magic (render-stream-0.md "End record").
End make_end(std::uint64_t full_count, std::uint64_t patch_count, std::uint64_t diff_ns_total,
             const std::vector<std::vector<std::uint8_t>> &records) {
  End end;
  end.transactions = full_count + patch_count;
  end.reason = EndReason::Shutdown;
  end.stats.encode_ns_total = 250000;
  end.stats.snapshot_ns_total = 40000;
  end.stats.diff_ns_total = diff_ns_total;
  end.stats.full_transactions = full_count;
  end.stats.patch_transactions = patch_count;
  std::uint64_t bytes_total = 0;
  std::uint64_t max_len = 0;
  for (std::size_t i = 0; i < records.size(); ++i) {
    bytes_total += records[i].size();
    if (i > 0) {
      max_len = std::max<std::uint64_t>(max_len, records[i].size());
    }
  }
  end.stats.bytes_total = bytes_total;
  end.stats.max_record_bytes = max_len;
  return end;
}

// -------------------------------------------------------------------------
// full.rs2 / patch.rs2, rebuilt through make_full() / make_patch().

void test_full_rs2_via_make_full() {
  const Session session = golden::golden_session(Encoding::Full, golden::kFullStreamId,
                                                   golden::kFullSessionId, Delivery::OutOfBand);
  std::vector<std::vector<std::uint8_t>> records;
  records.push_back(magic());
  records.push_back(encode_session(session));
  for (int n = 1; n <= 6; ++n) {
    const Snapshot snap = golden::state(n);
    const Transaction txn = make_full(snap);
    check(txn.encoding == Encoding::Full, "make_full() sets encoding Full");
    check(!txn.base_seq.has_value(), "make_full() leaves base_seq unset");
    check(txn.removed_canvases.empty() && txn.removed_items.empty() && txn.removed_textures.empty(),
          "make_full() has no removed_*");
    records.push_back(encode_transaction(txn));
  }
  End end = make_end(6, 0, 0, records);
  std::vector<std::vector<std::uint8_t>> all = records;
  all.push_back(encode_end(end));
  check_against_golden("full.rs2", all);
}

void test_patch_rs2_via_make_patch() {
  const Session session = golden::golden_session(Encoding::Patch, golden::kPatchStreamId,
                                                   golden::kPatchSessionId, Delivery::OutOfBand);
  std::vector<std::vector<std::uint8_t>> records;
  records.push_back(magic());
  records.push_back(encode_session(session));
  records.push_back(encode_transaction(make_full(golden::state(1))));

  for (int n = 2; n <= 5; ++n) {
    const Snapshot base = golden::state(n - 1);
    const Snapshot cur = golden::state(n);
    const Transaction patch = make_patch(base, cur);
    check(patch.encoding == Encoding::Patch, "make_patch() sets encoding Patch");
    check(patch.base_seq.has_value() && *patch.base_seq == base.seq,
          "make_patch() sets base_seq to the base's seq");
    records.push_back(encode_transaction(patch));
  }
  records.push_back(encode_transaction(make_full(golden::state(6))));  // resync: full again

  End end = make_end(2, 4, 12345, records);
  std::vector<std::vector<std::uint8_t>> all = records;
  all.push_back(encode_end(end));
  check_against_golden("patch.rs2", all);
}

// -------------------------------------------------------------------------
// resolve(): a patch chain resolves to the same states make_full() would encode.

bool snapshots_equal(const Snapshot &a, const Snapshot &b) {
  Transaction ta = make_full(a);
  Transaction tb = make_full(b);
  ta.seq = tb.seq = 0;
  ta.frame = tb.frame = 0;
  return encode_transaction(ta) == encode_transaction(tb);
}

void test_resolve_chain_equals_full_golden_states() {
  Snapshot base = golden::state(1);
  for (int n = 2; n <= 5; ++n) {
    const Snapshot cur = golden::state(n);
    const Transaction patch = make_patch(base, cur);
    const Snapshot resolved = resolve(base, patch);
    check(snapshots_equal(resolved, cur), "resolve(make_patch(base, cur)) == cur (golden states)");
    base = resolved;
  }
}

// -------------------------------------------------------------------------
// Seeded randomized round trip on a test-local model: random mutation sequences over BOTH items
// and textures (create, update, free, tombstone removal), resolve(patch chain) == every full
// state, for 1000 seeds.

struct RandomItem {
  std::uint32_t id;
  std::int32_t draw_index;
  std::uint64_t content_version;
  float ox, oy;
  float r, g, b;
  bool has_tex;
  std::uint32_t tex;  // may name a texture id that does not exist; the round-trip property does
                       // not depend on referential integrity, only on byte-exact resolve/diff.
};

struct RandomTexture {
  std::uint32_t id;
  std::uint64_t version;
  bool freed;  // status Freed when true; Ok otherwise
};

std::string hex_hash(std::uint32_t id, std::uint64_t version) {
  char buf[65];
  for (int i = 0; i < 64; ++i) {
    buf[i] = "0123456789abcdef"[(id * 2654435761u + static_cast<std::uint32_t>(version) * 40503u + i) % 16];
  }
  buf[64] = '\0';
  return std::string(buf);
}

TextureEntry to_texture_entry(const RandomTexture &rt) {
  TextureEntry t;
  t.id = rt.id;
  t.kind = TextureKind::Image;
  if (rt.freed) {
    t.status = TextureStatus::Freed;
    // hash/format/width/height/mipmaps/payload_bytes stay at their null/zero defaults.
  } else {
    t.status = TextureStatus::Ok;
    t.has_hash = true;
    t.hash = hex_hash(rt.id, rt.version);
    t.has_format = true;
    t.format = "RGBA8";
    t.width = 4;
    t.height = 4;
    t.payload_bytes = 64;
  }
  t.version = rt.version;
  return t;
}

Snapshot build_random_snapshot(std::uint64_t seq, const std::vector<RandomItem> &items,
                                const std::vector<RandomTexture> &textures) {
  Snapshot s;
  s.seq = seq;
  s.frame = seq;
  s.default_texture_filter = Filter::Nearest;
  s.default_texture_repeat = Repeat::Disabled;
  std::vector<std::uint32_t> top_level;
  CanvasState canvas = golden::root_canvas({});
  std::vector<ItemState> out;
  out.reserve(items.size());
  for (const RandomItem &ri : items) {
    ItemState it;
    it.id = ri.id;
    it.parent = ParentRef{ParentKind::Canvas, 1};
    it.draw_index = ri.draw_index;
    it.content_version = ri.content_version;
    it.xform = {1.0f, 0.0f, 0.0f, 1.0f, ri.ox, ri.oy};
    it.commands = {golden::add_texture_rect(ri.has_tex, ri.tex, false, false,
                                             {0.0f, 0.0f, 4.0f, 4.0f}, {ri.r, ri.g, ri.b, 1.0f})};
    out.push_back(it);
    top_level.push_back(ri.id);
  }
  std::sort(out.begin(), out.end(), [](const ItemState &a, const ItemState &b) { return a.id < b.id; });
  std::sort(top_level.begin(), top_level.end());
  canvas.items = top_level;
  s.canvases = {canvas};
  s.items = out;

  std::vector<TextureEntry> tex_out;
  tex_out.reserve(textures.size());
  for (const RandomTexture &rt : textures) {
    tex_out.push_back(to_texture_entry(rt));
  }
  std::sort(tex_out.begin(), tex_out.end(),
            [](const TextureEntry &a, const TextureEntry &b) { return a.id < b.id; });
  s.textures = tex_out;
  return s;
}

void test_randomized_patch_resolve_round_trip() {
  constexpr int kSeeds = 1000;
  for (int seed = 0; seed < kSeeds; ++seed) {
    std::mt19937 rng(static_cast<unsigned>(seed) + 1u);
    std::uniform_real_distribution<float> coord(0.0f, 100.0f);
    std::uniform_real_distribution<float> colour(0.0f, 1.0f);
    std::uniform_int_distribution<int> draw(0, 3);
    std::uniform_int_distribution<int> action(0, 4);

    std::uint32_t next_item_id = 2;
    std::uint32_t next_texture_id = 2;
    std::vector<RandomItem> items = {
        RandomItem{1, 0, 1, coord(rng), coord(rng), colour(rng), colour(rng), colour(rng), true, 1}};
    std::vector<RandomTexture> textures = {RandomTexture{1, 1, false}};

    Snapshot base = build_random_snapshot(1, items, textures);
    Transaction full0 = make_full(base);
    Snapshot resolved_full0 = resolve(base, full0);
    check(snapshots_equal(resolved_full0, base), "seed: resolve(full) == the snapshot it was made from");

    constexpr int kSteps = 8;
    for (int step = 0; step < kSteps; ++step) {
      const int which = action(rng);
      if (which == 0 || items.size() >= 5) {
        // Move/recolour an existing item, sometimes with a content bump.
        std::uniform_int_distribution<std::size_t> pick(0, items.size() - 1);
        RandomItem &target = items[pick(rng)];
        target.ox = coord(rng);
        target.oy = coord(rng);
        target.draw_index = draw(rng);
        if (std::uniform_int_distribution<int>(0, 1)(rng) == 1) {
          target.content_version += 1;
          target.r = colour(rng);
        }
      } else if (which == 1) {
        // New top-level item.
        RandomItem fresh{next_item_id++, draw(rng), 1, coord(rng), coord(rng), colour(rng),
                          colour(rng), colour(rng), true, 1};
        items.push_back(fresh);
      } else if (which == 2) {
        // New texture.
        RandomTexture fresh{next_texture_id++, 1, false};
        textures.push_back(fresh);
      } else if (which == 3 && !textures.empty()) {
        // Update an existing texture's version/hash.
        std::uniform_int_distribution<std::size_t> pick(0, textures.size() - 1);
        RandomTexture &target = textures[pick(rng)];
        if (!target.freed) {
          target.version += 1;
        }
      } else if (which == 4 && textures.size() > 1) {
        // Free one texture (version unchanged), or, if already freed, remove it (tombstone
        // cleared: nothing names it any more in this simplified model).
        std::uniform_int_distribution<std::size_t> pick(0, textures.size() - 1);
        std::size_t idx = pick(rng);
        if (!textures[idx].freed) {
          textures[idx].freed = true;
        } else {
          textures.erase(textures.begin() + static_cast<long>(idx));
        }
      }
      const Snapshot cur = build_random_snapshot(static_cast<std::uint64_t>(step + 2), items, textures);
      const Transaction patch = make_patch(base, cur);
      check(patch.encoding == Encoding::Patch, "seed: make_patch() produces a patch encoding");
      const Snapshot resolved = resolve(base, patch);
      check(snapshots_equal(resolved, cur),
            "seed: resolve(make_patch(base, cur)) == cur (randomized model, items+textures)");
      base = resolved;
    }
  }
}

}  // namespace

// -------------------------------------------------------------------------
// P3-CAP: make_patch's sorted id indexes keep std::map's semantics on any table order (the last
// entry of a repeated id wins; removed_* ascending; changed entries in the current table's order),
// and a MaterialEntry's shared parameters compare, copy and diverge like a vector.

ItemState plain_item(std::uint32_t id, float x) {
  ItemState item;
  item.id = id;
  item.parent.kind = ParentKind::Canvas;
  item.parent.id = 1;
  item.xform[4] = x;
  return item;
}

void test_make_patch_table_order() {
  Snapshot base;
  base.version = ProtocolVersion::V8;
  base.seq = 1;
  base.items = {plain_item(9, 0), plain_item(3, 0), plain_item(7, 1), plain_item(5, 0),
                plain_item(7, 2)};  // id 7 twice: the second one is the base's
  Snapshot cur = base;
  cur.seq = 2;
  cur.items = {plain_item(7, 2), plain_item(4, 0), plain_item(3, 1)};
  const Transaction t = make_patch(base, cur);
  check(t.removed_items == std::vector<std::uint32_t>({5, 9}), "removed_items ascending: 5, 9");
  check(t.items.size() == 2 && t.items[0].state.id == 4 && t.items[1].state.id == 3,
        "changed entries in the current table's order (4 new, 3 moved); 7 equals the last base 7");
  check(t.items[1].commands_null, "an existing item at the same content_version: commands null");
  check(!t.items[0].commands_null, "a new item carries its commands");

  Snapshot unsorted_textures = base;
  TextureEntry a;
  a.id = 4;
  TextureEntry b;
  b.id = 2;
  unsorted_textures.textures = {a, b};
  Snapshot next = unsorted_textures;
  next.seq = 2;
  next.textures = {b};
  check(make_patch(unsorted_textures, next).removed_textures ==
            std::vector<std::uint32_t>({4}),
        "a texture leaves whatever the base table's order");
}

void test_shared_material_params() {
  Param gain;
  gain.name = "gain";
  gain.type = VariantType::Float;
  gain.floats = {0.5};
  MaterialEntry m;
  m.id = 1;
  m.has_shader = true;
  m.shader = 1;
  m.params = std::vector<Param>{gain};
  MaterialEntry copy = m;
  check(copy.params.shares(m.params), "copying an entry shares its parameters");
  Param more = gain;
  more.name = "more";
  copy.params.push_back(more);
  check(m.params.size() == 1 && copy.params.size() == 2 && !copy.params.shares(m.params),
        "a push_back on a shared copy leaves the other holder untouched");
  Snapshot base;
  base.version = ProtocolVersion::V8;
  base.seq = 1;
  base.materials = {m};
  Snapshot cur = base;
  cur.seq = 2;
  check(make_patch(base, cur).materials.empty(), "a material sharing its parameters: no entry");
  cur.materials[0].params = std::vector<Param>{gain};
  check(!cur.materials[0].params.shares(m.params) && make_patch(base, cur).materials.empty(),
        "equal parameters in different storage compare equal element by element: no entry");
  cur.materials[0] = copy;
  check(make_patch(base, cur).materials.size() == 1, "the diverged copy is a patch entry");
  cur.materials[0].params = std::vector<Param>{more};
  const Transaction t = make_patch(base, cur);
  check(t.materials.size() == 1 && t.materials[0].params.size() == 1 &&
            t.materials[0].params[0].name == "more",
        "a changed parameter puts the material in the patch");
  const SharedVector<Param> none;
  check(none.empty() && none.begin() == none.end() && none.vector().empty(),
        "an empty SharedVector iterates nothing");
}

// HC2 (host-cost-design.md D1): item command lists are shared between snapshots, diverge copy-on-
// write, and compare bit for bit (command_lists_equal_bits) for /11's identical re-record rule.
void test_shared_command_lists() {
  Command rect;
  rect.kind = CommandKind::AddRect;
  rect.rect = {1, 2, 3, 4};
  rect.color = {1, 0, 0, 1};
  ItemState item;
  item.id = 1;
  item.content_version = 7;
  item.commands = std::vector<Command>{rect};
  ItemState copy = item;
  check(copy.commands.shares(item.commands), "copying an item shares its command list");
  copy.commands.push_back(rect);
  check(item.commands.size() == 1 && copy.commands.size() == 2 &&
            !copy.commands.shares(item.commands),
        "appending to a shared list leaves the other holder untouched");
  ItemState again = item;
  again.commands.clear_for_rerecord();
  again.commands.push_back(rect);
  check(item.commands.size() == 1 && again.commands.size() == 1 &&
            !again.commands.shares(item.commands) &&
            command_lists_equal_bits(again.commands.vector(), item.commands.vector()),
        "a re-record of a shared list builds its own list, equal bit for bit");
  ItemState sole;
  sole.commands = std::vector<Command>{rect, rect};
  const Command *storage = &sole.commands[0];
  sole.commands.clear_for_rerecord();
  sole.commands.push_back(rect);
  check(sole.commands.size() == 1 && &sole.commands[0] == storage,
        "a sole holder's re-record reuses its storage");
  SharedVector<Command> spare = std::vector<Command>{rect, rect, rect};
  const Command *spare_storage = &spare[0];
  ItemState held = item;  // shares item's list
  held.commands.clear_for_rerecord(&spare);
  held.commands.push_back(rect);
  check(&held.commands[0] == spare_storage && spare.empty() && item.commands.size() == 1,
        "a shared list's re-record takes the unshared spare's storage, leaving the other holder");
  SharedVector<Command> shared_spare = item.commands;
  ItemState held2 = item;
  held2.commands.clear_for_rerecord(&shared_spare);
  check(held2.commands.empty() && shared_spare.shares(item.commands) && item.commands.size() == 1,
        "a spare someone else holds is not taken");

  // command_lists_equal_bits: every field, floats by pattern.
  const std::vector<Command> one{rect};
  Command moved = rect;
  moved.rect[3] = 4.5f;
  check(!command_lists_equal_bits(one, {moved}), "one float differs: unequal");
  Command neg = rect;
  neg.color[1] = -0.0f;
  check(!command_lists_equal_bits(one, {neg}), "-0 and +0 differ");
  Command nan_a = rect;
  nan_a.width = std::numeric_limits<float>::quiet_NaN();
  Command nan_b = nan_a;
  check(command_lists_equal_bits({nan_a}, {nan_b}), "equal NaN patterns are equal");
  Command other_kind_field = rect;
  other_kind_field.circle_radius = 3.0f;  // not encoded for add_rect: stricter, never looser
  check(!command_lists_equal_bits(one, {other_kind_field}), "every field takes part");
  Command poly;
  poly.kind = CommandKind::AddPolyline;
  poly.points = {{0, 0}, {1, 1}};
  Command poly2 = poly;
  poly2.points[1][1] = 2.0f;
  check(command_lists_equal_bits({poly}, {poly}) && !command_lists_equal_bits({poly}, {poly2}),
        "point vectors compare element by element");
  Command named;
  named.kind = CommandKind::Unsupported;
  named.name = "canvas_item_add_line";
  Command named2 = named;
  named2.name = "canvas_item_add_circle";
  check(!command_lists_equal_bits({named}, {named2}), "names compare");
  check(!command_lists_equal_bits(one, {rect, rect}) && command_lists_equal_bits({}, {}),
        "lengths compare");

  // The diff never reads commands when content_version matches; resolve shares the base's list.
  Snapshot base;
  base.version = ProtocolVersion::V8;
  base.seq = 1;
  base.items = {item};
  Snapshot cur = base;
  cur.seq = 2;
  check(make_patch(base, cur).items.empty(), "an item sharing its commands: no entry");
  cur.items[0].xform[4] = 9.0f;
  const Transaction t = make_patch(base, cur);
  check(t.items.size() == 1 && t.items[0].commands_null, "a moved item: commands null");
  const Snapshot resolved = resolve(base, t);
  check(resolved.items.size() == 1 && resolved.items[0].commands.shares(base.items[0].commands),
        "resolving commands null shares the base's list");
  cur.items[0].content_version = 8;
  cur.items[0].commands = std::vector<Command>{moved};
  const Transaction t2 = make_patch(base, cur);
  check(t2.items.size() == 1 && !t2.items[0].commands_null &&
            t2.items[0].state.commands.size() == 1 && t2.items[0].state.commands[0].rect[3] == 4.5f,
        "a new list under a new content_version is carried");
}

int main() {
  test_make_patch_table_order();
  test_shared_command_lists();
  test_shared_material_params();
  test_full_rs2_via_make_full();
  test_patch_rs2_via_make_patch();
  test_resolve_chain_equals_full_golden_states();
  test_randomized_patch_resolve_round_trip();
  if (g_failures != 0) {
    std::fprintf(stderr, "%d check(s) failed\n", g_failures);
    return 1;
  }
  std::fprintf(stdout, "rs2_diff: all checks passed\n");
  return 0;
}
